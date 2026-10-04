import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import {
  config, loadConfig, saveConfig, verifyPassword, setPassword, rotateAgentKey,
  PUBLIC_DIR, DATA_DIR, SERVER_ROOT,
} from './config.js';
import {
  state, loadAll, overview, queryMetrics, listServers, getServer, updateServer, deleteServer,
  ingestReport, listMonitors, saveMonitors, deleteMonitor, queryProbes, logEvent, listEvents,
  markOffline, pruneOldData, saveServers, reorderServers,
} from './store.js';
import {
  CHANNEL_TYPES, RULE_TYPES, addChannel, updateChannel, removeChannel,
  addRule, updateRule, removeRule, testChannel, evaluateServerSample, evaluateOffline, resetAlertState,
} from './alert.js';
import { startMonitors, runMonitorNow } from './monitors.js';
import {
  now, randHex, clean, safeEqual, hmac,
} from './util.js';

const VERSION = '1.0.0';
const PORT = Number(process.env.HERA_PORT || process.env.PORT || 8080) || 8080;
// 默认监听所有网卡。容器里必须绑 0.0.0.0（或 ::），
// 否则 Docker 的端口映射无法把外部流量转发进来。
const HOST = process.env.HERA_HOST || '0.0.0.0';

loadConfig();
loadAll();

/* ------------------------------------------------------------------ HTTP */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const raw = (fwd ? String(fwd).split(',')[0] : req.socket.remoteAddress) || '';
  return raw.replace(/^::ffff:/, '');
}

/* --------------------------------------------------------------- 鉴权 */

function signToken() {
  const cfg = config();
  const exp = now() + (cfg.sessionDays || 7) * 86400_000;
  const payload = Buffer.from(JSON.stringify({ exp, n: randHex(4) })).toString('base64url');
  return `${payload}.${hmac(payload, cfg.secret)}`;
}

function verifyToken(tok) {
  if (!tok || typeof tok !== 'string') return false;
  const idx = tok.lastIndexOf('.');
  if (idx <= 0) return false;
  const payload = tok.slice(0, idx);
  const sig = tok.slice(idx + 1);
  if (!safeEqual(sig, hmac(payload, config().secret))) return false;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return o.exp > now();
  } catch {
    return false;
  }
}

// 登录限流：只统计失败次数，成功后立即清零。
// 这样正常用户反复登录不会被误伤，暴力破解仍会被挡住。
const MAX_LOGIN_FAILURES = 8;
const LOGIN_WINDOW_MS = 5 * 60_000;
const loginFailures = new Map();

function loginBlocked(ip) {
  const t = now();
  const arr = (loginFailures.get(ip) || []).filter((x) => t - x < LOGIN_WINDOW_MS);
  loginFailures.set(ip, arr);
  if (loginFailures.size > 5000) loginFailures.clear();
  return arr.length >= MAX_LOGIN_FAILURES;
}

function noteLoginFailure(ip) {
  const arr = loginFailures.get(ip) || [];
  arr.push(now());
  loginFailures.set(ip, arr);
}

/* ------------------------------------------------------------ SSE 推送 */

const clients = new Set();
let broadcastTimer = null;

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
}

function pushTo(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* 连接已断开 */ }
}

function broadcastOverview() {
  if (!clients.size) return;
  const payload = overview();
  for (const res of clients) pushTo(res, 'overview', payload);
}

function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastOverview();
  }, 400);
}

/* ------------------------------------------------------------- 工具函数 */

const RANGES = {
  '5m': 5 * 60_000,
  '1h': 3600_000,
  '6h': 6 * 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 86400_000,
};

function publicConfig() {
  const cfg = config();
  return {
    site: cfg.site,
    settings: cfg.settings,
    agentKey: cfg.agentKey,
    channels: cfg.alerts.channels,
    rules: cfg.alerts.rules,
    cooldown: cfg.alerts.cooldown,
    version: VERSION,
  };
}

function baseUrlOf(req) {
  const cfg = config();
  if (cfg.settings.publicUrl) return String(cfg.settings.publicUrl).replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function installCommand(req) {
  const cfg = config();
  const base = baseUrlOf(req);
  let script = `${base}/install-agent.sh`;
  if (cfg.settings.repo) {
    script = `https://raw.githubusercontent.com/${cfg.settings.repo}/main/agent/install.sh`;
  }
  return `curl -fsSL ${script} | bash -s -- --server ${base} --key ${cfg.agentKey}`;
}

/* ------------------------------------------------------------------ 路由 */

const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const rx = new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  })}$`);
  routes.push({
    method, rx, keys, handler, auth: opts.auth !== false, raw: !!opts.raw,
  });
};

/* --- 公开接口 --- */

route('GET', '/api/health', async (ctx) => {
  const addr = server.address();
  sendJSON(ctx.res, 200, {
    ok: true,
    version: VERSION,
    uptime: Math.round(process.uptime()),
    servers: state.servers.size,
    monitors: state.monitors.size,
    time: now(),
    // 自检信息：容器里排查「端口映射不通」时最有用
    listen: addr && typeof addr === 'object'
      ? { address: addr.address, port: addr.port, family: addr.family }
      : { address: HOST, port: PORT },
    dataDir: DATA_DIR,
  });
}, { auth: false });

route('POST', '/api/login', async (ctx) => {
  const ip = clientIp(ctx.req);
  if (loginBlocked(ip)) {
    sendJSON(ctx.res, 429, { ok: false, error: '密码错误次数过多，请 5 分钟后再试' });
    return;
  }
  const { password } = ctx.body || {};
  if (!verifyPassword(password)) {
    noteLoginFailure(ip);
    logEvent('login-fail', `登录失败（${ip}）`);
    sendJSON(ctx.res, 401, { ok: false, error: '密码错误' });
    return;
  }
  loginFailures.delete(ip);
  logEvent('login', `登录成功（${ip}）`);
  sendJSON(ctx.res, 200, { ok: true, token: signToken() });
}, { auth: false });

route('POST', '/api/agent/report', async (ctx) => {
  const cfg = config();
  const key = ctx.req.headers['x-agent-key'];
  if (!key || !safeEqual(key, cfg.agentKey)) {
    sendJSON(ctx.res, 401, { ok: false, error: 'invalid agent key' });
    return;
  }
  const report = ctx.body;
  if (!report || typeof report !== 'object' || !report.host) {
    sendJSON(ctx.res, 400, { ok: false, error: 'bad payload' });
    return;
  }
  let result;
  try {
    result = ingestReport(report, clientIp(ctx.req));
  } catch (e) {
    sendJSON(ctx.res, 400, { ok: false, error: e.message });
    return;
  }
  const server = getServer(result.id);
  sendJSON(ctx.res, 200, {
    ok: true,
    id: result.id,
    created: result.created,
    interval: cfg.settings.interval,
    serverTime: now(),
  });
  if (server?.latest) {
    evaluateServerSample(server, server.latest).catch(() => {});
  }
  scheduleBroadcast();
}, { auth: false });

route('GET', '/install-agent.sh', async (ctx) => {
  const file = path.join(SERVER_ROOT, '..', 'agent', 'install.sh');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    ctx.res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    ctx.res.end('install.sh not bundled');
    return;
  }
  ctx.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  ctx.res.end(text);
}, { auth: false, raw: true });

route('GET', '/agent/hera-agent.sh', async (ctx) => {
  const file = path.join(SERVER_ROOT, '..', 'agent', 'hera-agent.sh');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    ctx.res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    ctx.res.end('agent not bundled');
    return;
  }
  ctx.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  ctx.res.end(text);
}, { auth: false, raw: true });

/* --- 需要鉴权 --- */

route('GET', '/api/bootstrap', async (ctx) => {
  const cfg = config();
  sendJSON(ctx.res, 200, {
    ok: true,
    config: publicConfig(),
    overview: overview(),
    channelTypes: CHANNEL_TYPES,
    ruleTypes: RULE_TYPES,
    install: {
      command: installCommand(ctx.req),
      baseUrl: baseUrlOf(ctx.req),
      repo: cfg.settings.repo || '',
    },
    serverUrl: baseUrlOf(ctx.req),
  });
});

route('GET', '/api/stream', async (ctx) => {
  const res = ctx.res;
  sseHeaders(res);
  clients.add(res);
  pushTo(res, 'overview', overview());
  const hb = setInterval(() => pushTo(res, 'ping', { t: now() }), 20000);
  hb.unref?.();
  ctx.req.on('close', () => {
    clearInterval(hb);
    clients.delete(res);
  });
}, { raw: true });

route('GET', '/api/metrics', async (ctx) => {
  const id = ctx.query.get('id');
  if (!id || !getServer(id)) {
    sendJSON(ctx.res, 404, { ok: false, error: '服务器不存在' });
    return;
  }
  const rangeMs = RANGES[ctx.query.get('range')] || 3600_000;
  const points = Math.min(1000, Math.max(30, Number(ctx.query.get('points')) || 240));
  const data = queryMetrics(id, { rangeMs, points });
  const s = getServer(id);
  sendJSON(ctx.res, 200, {
    ok: true,
    id,
    range: ctx.query.get('range') || '1h',
    data,
    detail: {
      host: s.host,
      ip: s.ip,
      group: s.group,
      tags: s.tags,
      note: s.note,
      region: s.region,
      price: s.price,
      expireAt: s.expireAt,
      createdAt: s.createdAt,
      agentVersion: s.agentVersion,
      disks: s.disks,
      net: s.net,
      netTotal: s.latest?.netTotal || { rx: 0, tx: 0 },
      totalRx: s.totalRx,
      totalTx: s.totalTx,
      memTotal: s.latest?.memTotal || 0,
      swapTotal: s.latest?.swapTotal || 0,
      swapUsed: s.latest?.swapUsed || 0,
      cpuUser: s.latest?.cpuUser || 0,
      cpuSystem: s.latest?.cpuSystem || 0,
      cpuIowait: s.latest?.cpuIowait || 0,
      cpuSteal: s.latest?.cpuSteal || 0,
      bootTime: s.latest?.bootTime || 0,
      procs: s.latest?.procs || 0,
      tcp: s.latest?.tcp || 0,
      latest: s.latest,
    },
  });
});

route('GET', '/api/events', async (ctx) => {
  sendJSON(ctx.res, 200, { ok: true, events: listEvents(Number(ctx.query.get('limit')) || 100) });
});

// 注意：必须注册在 /api/servers/:id 之前，否则会被 :id 抢先匹配走
route('POST', '/api/servers/order', async (ctx) => {
  const ids = ctx.body?.ids;
  if (!Array.isArray(ids)) {
    sendJSON(ctx.res, 400, { ok: false, error: '缺少 ids 数组' });
    return;
  }
  const updated = reorderServers(ids);
  logEvent('server-order', `调整了 ${updated} 台服务器的显示顺序`);
  sendJSON(ctx.res, 200, { ok: true, updated });
  scheduleBroadcast();
});

route('POST', '/api/servers/:id', async (ctx) => {
  const s = updateServer(ctx.params.id, ctx.body || {});
  if (!s) {
    sendJSON(ctx.res, 404, { ok: false, error: '服务器不存在' });
    return;
  }
  sendJSON(ctx.res, 200, { ok: true });
  scheduleBroadcast();
});

route('DELETE', '/api/servers/:id', async (ctx) => {
  const ok = deleteServer(ctx.params.id);
  sendJSON(ctx.res, ok ? 200 : 404, { ok });
  scheduleBroadcast();
});

route('GET', '/api/monitors', async (ctx) => {
  sendJSON(ctx.res, 200, { ok: true, monitors: listMonitors() });
});

route('POST', '/api/monitors', async (ctx) => {
  const b = ctx.body || {};
  const type = ['http', 'tcp'].includes(b.type) ? b.type : 'http';
  const target = clean(b.target, 300);
  if (!target) {
    sendJSON(ctx.res, 400, { ok: false, error: '目标地址不能为空' });
    return;
  }
  if (type === 'http' && !/^https?:\/\//i.test(target)) {
    sendJSON(ctx.res, 400, { ok: false, error: 'HTTP 监控目标需以 http:// 或 https:// 开头' });
    return;
  }
  if (type === 'tcp' && !/^[^:\s]+:\d{1,5}$/.test(target)) {
    sendJSON(ctx.res, 400, { ok: false, error: 'TCP 监控目标格式为 host:port' });
    return;
  }
  const id = `mt_${randHex(5)}`;
  state.monitors.set(id, {
    id,
    name: clean(b.name, 64) || target,
    type,
    target,
    method: clean(b.method, 8) || 'GET',
    interval: Math.min(3600, Math.max(10, Number(b.interval) || 60)),
    timeout: Math.min(60, Math.max(1, Number(b.timeout) || 10)),
    expectCode: Number(b.expectCode) || 0,
    keyword: clean(b.keyword, 100),
    enabled: true,
    createdAt: now(),
    ok: null,
    ms: 0,
    code: 0,
    message: '',
    lastCheck: 0,
    lastChange: 0,
    uptime24: null,
    history: [],
  });
  saveMonitors();
  logEvent('monitor', `新增站点监控：${clean(b.name, 40) || target}`);
  sendJSON(ctx.res, 200, { ok: true, id });
  scheduleBroadcast();
});

route('POST', '/api/monitors/:id', async (ctx) => {
  const m = state.monitors.get(ctx.params.id);
  if (!m) {
    sendJSON(ctx.res, 404, { ok: false, error: '监控项不存在' });
    return;
  }
  const b = ctx.body || {};
  if (b.name !== undefined) m.name = clean(b.name, 64) || m.name;
  if (b.target !== undefined) m.target = clean(b.target, 300) || m.target;
  if (b.enabled !== undefined) m.enabled = !!b.enabled;
  if (b.interval !== undefined) m.interval = Math.min(3600, Math.max(10, Number(b.interval) || 60));
  if (b.timeout !== undefined) m.timeout = Math.min(60, Math.max(1, Number(b.timeout) || 10));
  if (b.expectCode !== undefined) m.expectCode = Number(b.expectCode) || 0;
  if (b.keyword !== undefined) m.keyword = clean(b.keyword, 100);
  saveMonitors();
  sendJSON(ctx.res, 200, { ok: true });
  scheduleBroadcast();
});

route('POST', '/api/monitors/:id/check', async (ctx) => {
  const ok = await runMonitorNow(ctx.params.id);
  sendJSON(ctx.res, ok ? 200 : 404, { ok });
});

route('DELETE', '/api/monitors/:id', async (ctx) => {
  const ok = deleteMonitor(ctx.params.id);
  sendJSON(ctx.res, ok ? 200 : 404, { ok });
  scheduleBroadcast();
});

route('GET', '/api/monitors/:id/history', async (ctx) => {
  const rangeMs = RANGES[ctx.query.get('range')] || 86400_000;
  sendJSON(ctx.res, 200, { ok: true, rows: queryProbes(ctx.params.id, rangeMs) });
});

route('POST', '/api/channels', async (ctx) => {
  try {
    const ch = addChannel(ctx.body || {});
    sendJSON(ctx.res, 200, { ok: true, channel: ch });
    scheduleBroadcast();
  } catch (e) {
    sendJSON(ctx.res, 400, { ok: false, error: e.message });
  }
});

route('POST', '/api/channels/:id', async (ctx) => {
  const ch = updateChannel(ctx.params.id, ctx.body || {});
  sendJSON(ctx.res, ch ? 200 : 404, { ok: !!ch });
});

route('POST', '/api/channels/:id/test', async (ctx) => {
  try {
    await testChannel(ctx.params.id);
    sendJSON(ctx.res, 200, { ok: true });
  } catch (e) {
    sendJSON(ctx.res, 400, { ok: false, error: e.message || '推送失败' });
  }
});

route('DELETE', '/api/channels/:id', async (ctx) => {
  sendJSON(ctx.res, 200, { ok: removeChannel(ctx.params.id) });
});

route('POST', '/api/rules', async (ctx) => {
  try {
    const r = addRule(ctx.body || {});
    sendJSON(ctx.res, 200, { ok: true, rule: r });
  } catch (e) {
    sendJSON(ctx.res, 400, { ok: false, error: e.message });
  }
});

route('POST', '/api/rules/:id', async (ctx) => {
  const r = updateRule(ctx.params.id, ctx.body || {});
  sendJSON(ctx.res, r ? 200 : 404, { ok: !!r });
});

route('DELETE', '/api/rules/:id', async (ctx) => {
  sendJSON(ctx.res, 200, { ok: removeRule(ctx.params.id) });
});

route('POST', '/api/settings', async (ctx) => {
  const cfg = config();
  const b = ctx.body || {};
  const s = cfg.settings;
  if (b.interval !== undefined) s.interval = Math.min(600, Math.max(5, Number(b.interval) || 30));
  if (b.retentionDays !== undefined) s.retentionDays = Math.min(365, Math.max(1, Number(b.retentionDays) || 7));
  if (b.offlineThreshold !== undefined) s.offlineThreshold = Math.min(3600, Math.max(30, Number(b.offlineThreshold) || 120));
  if (b.publicUrl !== undefined) s.publicUrl = clean(b.publicUrl, 200);
  if (b.repo !== undefined) s.repo = clean(b.repo, 120);
  if (b.title !== undefined) cfg.site.title = clean(b.title, 60) || 'Hera Monitor';
  saveConfig();
  sendJSON(ctx.res, 200, { ok: true, settings: s, site: cfg.site });
  scheduleBroadcast();
});

route('POST', '/api/password', async (ctx) => {
  const { oldPassword, newPassword } = ctx.body || {};
  if (!verifyPassword(oldPassword)) {
    sendJSON(ctx.res, 400, { ok: false, error: '当前密码不正确' });
    return;
  }
  if (!newPassword || String(newPassword).length < 6) {
    sendJSON(ctx.res, 400, { ok: false, error: '新密码至少 6 位' });
    return;
  }
  setPassword(newPassword);
  resetAlertState();
  logEvent('password', '管理员密码已修改');
  sendJSON(ctx.res, 200, { ok: true });
});

route('POST', '/api/key/rotate', async (ctx) => {
  const key = rotateAgentKey();
  logEvent('key', 'Agent 密钥已重置');
  sendJSON(ctx.res, 200, { ok: true, agentKey: key, install: installCommand(ctx.req) });
});

/* ------------------------------------------------------------ 静态资源 */

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    // 畸形百分号编码（如 /%）会抛异常，必须就地拦掉
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 回退
      const idx = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(idx, (e2, buf) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const noCache = ['.html', '.js', '.css'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400',
      'Content-Length': st.size,
    });
    // 文件在读取过程中被删除时，'error' 事件不处理会直接冒泡成未捕获异常
    const stream = fs.createReadStream(full);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end();
    });
    stream.pipe(res);
  });
}

/* ---------------------------------------------------------------- 主循环 */

/**
 * 最外层兜底。
 *
 * 这里是本项目最关键的错误处理：如果请求处理过程中抛出任何未预料的异常，
 * 而进程又装了 uncaughtException 处理器（不会退出），那么 socket 会一直挂着
 * 不返回 —— 表现就是「lsof 看进程在正常监听，但页面死活打不开」。
 * 容器健康检查、端口扫描器、畸形 URL 都很容易触发这类异常。
 * 因此无论发生什么，都必须给客户端一个响应。
 */
async function handle(req, res) {
  try {
    await routeRequest(req, res);
  } catch (e) {
    console.error(`[request-error] ${req.method} ${req.url} ->`, e);
    try {
      if (!res.headersSent) {
        sendJSON(res, 500, { ok: false, error: `服务器内部错误：${e.message}` });
      } else {
        res.end();
      }
    } catch { /* 连接已断开，忽略 */ }
  }
}

async function routeRequest(req, res) {
  // 只用于解析 pathname / query，因此不依赖 Host 头 ——
  // 畸形 Host（空值、带空格、被伪造）不应影响正常路由，更不该让请求挂死。
  let url;
  try {
    url = new URL(req.url, 'http://hera.local');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  const pathname = url.pathname;

  if (pathname.startsWith('/api/') || pathname.startsWith('/install-agent.sh') || pathname.startsWith('/agent/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Key',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      });
      res.end();
      return;
    }

    let body = null;
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        const raw = await readBody(req, pathname === '/api/agent/report' ? 256 * 1024 : 1024 * 512);
        body = raw ? JSON.parse(raw) : {};
      } catch (e) {
        sendJSON(res, 400, { ok: false, error: `请求体解析失败：${e.message}` });
        return;
      }
    }

    const query = url.searchParams;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.rx.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

      if (r.auth) {
        const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || query.get('token');
        if (!verifyToken(token)) {
          sendJSON(res, 401, { ok: false, error: '未登录或登录已过期' });
          return;
        }
      }
      try {
        await r.handler({
          req, res, params, query, body, url,
        });
      } catch (e) {
        if (!res.headersSent) sendJSON(res, 500, { ok: false, error: e.message });
        else res.end();
      }
      return;
    }
    sendJSON(res, 404, { ok: false, error: '接口不存在' });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }
  serveStatic(req, res, pathname);
}

const server = http.createServer(handle);
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

// 畸形请求（非法 Host、超长 header、非 HTTP 协议探测）不应该让进程静默挂住
server.on('clientError', (err, socket) => {
  if (!socket.writable || err.code === 'ECONNRESET' || !err.rawPacket) {
    socket.destroy();
    return;
  }
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});

/** 启动自检：把「进程活着但访问不到」这类问题在启动日志里就说清楚 */
function startupReport() {
  const addr = server.address();
  const boundAddr = addr && typeof addr === 'object' ? addr.address : HOST;
  const boundPort = addr && typeof addr === 'object' ? addr.port : PORT;
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(boundAddr);

  const problems = [];
  if (loopback) {
    problems.push(`只监听了回环地址 ${boundAddr}。容器中这会导致 Docker 端口映射无法转发流量，请把 HERA_HOST 设为 0.0.0.0`);
  }
  let dataWritable = true;
  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
  } catch {
    dataWritable = false;
    problems.push(`数据目录 ${DATA_DIR} 不可写，配置与指标无法保存`);
  }
  const assets = ['index.html', 'app.js', 'style.css'];
  const missing = assets.filter((f) => !fs.existsSync(path.join(PUBLIC_DIR, f)));
  if (missing.length) {
    problems.push(`面板静态资源缺失：${missing.join(', ')}（目录 ${PUBLIC_DIR}）`);
  }

  const cfg = config();
  const line = '─'.repeat(62);
  console.log(`\n${line}`);
  console.log(`  Hera Monitor  v${VERSION}`);
  console.log(line);
  console.log(`  监听地址   ${boundAddr}:${boundPort}${loopback ? '   ⚠️ 仅本机可访问' : '   ✓ 所有网卡'}`);
  console.log(`  数据目录   ${DATA_DIR}${dataWritable ? '   ✓ 可写' : '   ✗ 不可写'}`);
  console.log(`  面板资源   ${PUBLIC_DIR}   ${missing.length ? '✗ 缺失' : '✓ 就绪'}`);
  console.log(`  访问地址   http://<服务器IP>:${boundPort}`);

  if (cfg.__initialPassword) {
    console.log(`\n  ⚠️  首次启动，管理员初始密码：${cfg.__initialPassword}`);
    console.log(`     （已写入 ${path.join(DATA_DIR, 'initial-password.txt')}，请登录后立即修改）`);
  }

  console.log(`\n  接入 Agent：`);
  console.log(`  curl -fsSL http://<服务器IP>:${boundPort}/install-agent.sh | sudo bash -s -- --server http://<服务器IP>:${boundPort} --key ${cfg.agentKey}`);

  if (problems.length) {
    console.log(`\n  ${'!'.repeat(58)}`);
    for (const p of problems) console.log(`  [警告] ${p}`);
    console.log(`  ${'!'.repeat(58)}`);
  }

  console.log(`\n  打不开面板？按顺序排查：`);
  console.log(`    1. 云服务器安全组 / 本机防火墙是否放行了 ${boundPort} 端口`);
  console.log(`    2. docker compose ps          查看容器状态是否 healthy`);
  console.log(`    3. 容器内自测                  docker compose exec hera-monitor node -e "fetch('http://127.0.0.1:${boundPort}/api/health').then(r=>r.text()).then(console.log)"`);
  console.log(`    4. 看服务端日志                docker compose logs -f hera-monitor`);
  console.log(`${line}\n`);
  loadConfig(); // 清理掉 __initialPassword 的内存引用
}

server.on('error', (e) => {
  const line = '─'.repeat(62);
  console.error(`\n${line}`);
  if (e.code === 'EADDRINUSE') {
    console.error(`  [致命] 端口 ${PORT} 已被占用，无法启动。`);
    console.error('  查看占用：ss -lntp | grep ' + PORT);
  } else if (e.code === 'EACCES') {
    console.error(`  [致命] 没有权限绑定端口 ${PORT}（1024 以下端口需要 root）。`);
  } else if (e.code === 'EADDRNOTAVAIL') {
    console.error(`  [致命] 监听地址 ${HOST} 在本机不存在。容器里请使用 HERA_HOST=0.0.0.0`);
  } else {
    console.error(`  [致命] 服务启动失败：${e.message}`);
  }
  console.error(`${line}\n`);
  process.exit(1);
});

server.listen(PORT, HOST, startupReport);

/* ------------------------------------------------------------ 定时任务 */

const offlineTimer = setInterval(async () => {
  const newly = markOffline();
  for (const s of newly) {
    // eslint-disable-next-line no-await-in-loop
    await evaluateOffline(s).catch(() => {});
  }
  scheduleBroadcast();
}, 15000);

const flushTimer = setInterval(() => {
  if (state.dirty) saveServers(true);
}, 30000);

const pruneTimer = setInterval(() => {
  try {
    pruneOldData();
    logEvent('system', '历史数据清理完成');
  } catch (e) {
    logEvent('system', `历史数据清理失败：${e.message}`);
  }
}, 6 * 3600_000);

const broadcastTimer2 = setInterval(broadcastOverview, 3000);
broadcastTimer2.unref?.();

startMonitors();

process.on('SIGINT', () => {
  clearInterval(offlineTimer);
  clearInterval(flushTimer);
  clearInterval(pruneTimer);
  clearInterval(broadcastTimer2);
  saveServers(true);
  saveConfig();
  console.log('\n已保存数据，Hera Monitor 退出。');
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e);
  try { logEvent('system', `未捕获异常：${e.message}`); } catch { /* ignore */ }
});

// 未处理的 Promise 拒绝同样要留痕，否则会变成「进程活着但请求不响应」的隐形故障
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[unhandledRejection]', reason);
  try { logEvent('system', `未处理的 Promise 拒绝：${msg}`); } catch { /* ignore */ }
});
