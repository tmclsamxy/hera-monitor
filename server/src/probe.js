import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';

/** 通用 HTTP 请求，返回 { status, body, headers } */
export function request(url, { method = 'GET', headers = {}, body = null, timeout = 10000, maxRedirect = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error('URL 格式不正确'));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error(`不支持的协议 ${u.protocol}`));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method,
      headers: {
        'User-Agent': 'Hera-Monitor/1.0',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout,
      agent: false,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => {
        if (chunks.reduce((a, b) => a + b.length, 0) < 262144) chunks.push(c);
      });
      res.on('end', () => {
        const status = res.statusCode || 0;
        if (maxRedirect > 0 && status >= 300 && status < 400 && res.headers.location) {
          let next;
          try {
            next = new URL(res.headers.location, u).toString();
          } catch {
            next = null;
          }
          if (next) {
            request(next, {
              method, headers, body, timeout, maxRedirect: maxRedirect - 1,
            }).then(resolve, reject);
            return;
          }
        }
        resolve({ status, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`请求超时（${timeout}ms）`));
    });
    req.on('error', (e) => reject(e));
    if (payload) req.write(payload);
    req.end();
  });
}

/** HTTP 可用性探测（含延迟、状态码、关键字校验） */
export async function httpProbe({
  target, method = 'GET', timeout = 10, expectCode = 0, keyword = '',
}) {
  const started = Date.now();
  try {
    const res = await request(target, { method, timeout: timeout * 1000 });
    const ms = Date.now() - started;
    let ok = res.status >= 200 && res.status < 400;
    let message = `HTTP ${res.status}`;
    if (expectCode) {
      ok = res.status === expectCode;
      message = `HTTP ${res.status}（期望 ${expectCode}）`;
    }
    if (ok && keyword) {
      if (!res.body.includes(keyword)) {
        ok = false;
        message = `响应内容未包含关键字「${keyword}」`;
      }
    }
    return { ok, ms, code: res.status, message };
  } catch (e) {
    return {
      ok: false, ms: Date.now() - started, code: 0, message: e.message || '请求失败',
    };
  }
}

/** TCP 端口探测 */
export function tcpProbe({ target, timeout = 10 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const idx = String(target).lastIndexOf(':');
    if (idx <= 0) {
      resolve({
        ok: false, ms: 0, code: 0, message: 'TCP 目标格式应为 host:port',
      });
      return;
    }
    const host = target.slice(0, idx).trim();
    const port = Number(target.slice(idx + 1));
    if (!port) {
      resolve({
        ok: false, ms: 0, code: 0, message: '端口号无效',
      });
      return;
    }
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout * 1000);
    socket.on('connect', () => done({
      ok: true, ms: Date.now() - started, code: 0, message: `端口 ${port} 可连接`,
    }));
    socket.on('timeout', () => done({
      ok: false, ms: Date.now() - started, code: 0, message: `连接超时（${timeout}s）`,
    }));
    socket.on('error', (e) => done({
      ok: false, ms: Date.now() - started, code: 0, message: e.message || '连接失败',
    }));
  });
}

export function probe(monitor) {
  if (monitor.type === 'tcp') {
    return tcpProbe({ target: monitor.target, timeout: monitor.timeout });
  }
  return httpProbe({
    target: monitor.target,
    method: monitor.method,
    timeout: monitor.timeout,
    expectCode: monitor.expectCode,
    keyword: monitor.keyword,
  });
}
