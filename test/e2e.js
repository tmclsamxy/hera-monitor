/* ============================================================
 * Hera Monitor 端到端冒烟测试
 *
 * 请勿对着生产实例运行——脚本末尾会删除所有服务器与监控项。
 * 推荐用 test/run.sh 启动一个临时实例来跑。
 *
 * 直接运行：
 *   HERA_TEST_BASE=http://127.0.0.1:8080 HERA_TEST_DATA=./data node test/e2e.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const BASE = (process.env.HERA_TEST_BASE || 'http://127.0.0.1:18099').replace(/\/+$/, '');
const DATA = process.env.HERA_TEST_DATA || path.resolve(__dirname, '..', 'data');
const pwFile = path.join(DATA, 'initial-password.txt');
const cfgFile = path.join(DATA, 'config.json');
const PORT = Number(new URL(BASE).port || 80);

let token = '';
let pass = 0; let fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass += 1; console.log(`  ✅ ${n}${extra ? ' — ' + extra : ''}`); } else { fail += 1; console.log(`  ❌ ${n}${extra ? ' — ' + extra : ''}`); } };

async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, text: await res.text() };
  return { status: res.status, data: await res.json() };
}

function report(hostname, id, cpu, memUsedPct, rx, tx) {
  const mem = 4096 * 1024 * 1024;
  return {
    v: 1,
    agent: { version: '1.0.0', interval: 30 },
    host: {
      id, hostname, os: 'Ubuntu 22.04.4 LTS', platform: 'linux', arch: 'x86_64',
      kernel: '5.15.0-105-generic', cpuModel: 'AMD EPYC 7B13 64-Core Processor',
      cpuCores: 4, virt: 'kvm', region: 'HK',
    },
    ts: Date.now(), uptime: 864000, bootTime: Math.floor(Date.now() / 1000) - 864000,
    procs: 128, tcp: 42,
    cpu: { usage: cpu, user: cpu * 0.6, system: cpu * 0.3, iowait: 1.2, steal: 0.1 },
    mem: { total: mem, used: mem * (memUsedPct / 100), available: mem * (1 - memUsedPct / 100) },
    swap: { total: 2 * 1024 ** 3, used: 0 },
    load: { l1: cpu / 25, l5: cpu / 30, l15: cpu / 40 },
    disks: [
      { fs: '/dev/vda1', mount: '/', total: 40 * 1024, used: 24 * 1024, pct: 61 },
      { fs: '/dev/vdb1', mount: '/data', total: 200 * 1024, used: 180 * 1024, pct: 90 },
    ],
    net: [{ iface: 'eth0', rx, tx }],
    netTotal: { rx, tx },
  };
}

(async () => {
  console.log(`\n测试目标：${BASE}  数据目录：${DATA}`);
  console.log('\n=== 1. 健康检查与静态资源 ===');
  let r = await api('/api/health');
  ok('GET /api/health', r.data?.ok === true, `v${r.data?.version}`);

  r = await api('/', { raw: true });
  ok('GET / 返回面板 HTML', r.status === 200 && r.text.includes('Hera Monitor'));
  r = await api('/app.js', { raw: true });
  ok('GET /app.js', r.status === 200 && r.text.length > 1000);
  r = await api('/style.css', { raw: true });
  ok('GET /style.css', r.status === 200 && r.text.includes('--accent'));
  r = await api('/install-agent.sh', { raw: true });
  ok('GET /install-agent.sh', r.status === 200 && r.text.startsWith('#!/usr/bin/env bash'));
  r = await api('/agent/hera-agent.sh', { raw: true });
  ok('GET /agent/hera-agent.sh', r.status === 200 && r.text.includes('AGENT_VERSION'));

  console.log('\n=== 2. 鉴权 ===');
  r = await api('/api/bootstrap');
  ok('未登录访问受保护接口返回 401', r.status === 401);
  const pwd = fs.readFileSync(pwFile, 'utf8').trim();
  r = await api('/api/login', { method: 'POST', body: { password: 'wrong-password' } });
  ok('错误密码被拒绝', r.status === 401);
  r = await api('/api/login', { method: 'POST', body: { password: pwd } });
  ok('正确密码登录成功', r.status === 200 && !!r.data.token);
  token = r.data.token;

  console.log('\n=== 3. Agent 接入 ===');
  const key = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).agentKey;
  const bad = await fetch(BASE + '/api/agent/report', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Key': 'wrong' },
    body: JSON.stringify(report('bad', 'bad', 1, 1, 0, 0)),
  });
  ok('错误 Agent 密钥被拒绝', bad.status === 401);

  const ids = ['aaaa1111aaaa1111aaaa1111aaaa1111', 'bbbb2222bbbb2222bbbb2222bbbb2222'];
  const names = ['hk-web-01', 'jp-db-01'];
  let rx0 = 0;
  for (let round = 0; round < 6; round += 1) {
    for (let i = 0; i < ids.length; i += 1) {
      rx0 += 1024 * 512;
      const res = await fetch(BASE + '/api/agent/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Key': key },
        body: JSON.stringify(report(names[i], ids[i], 10 + round * 6 + i * 12, 40 + round * 4, rx0, rx0 / 3)),
      });
      if (round === 0 && i === 0) {
        const d = await res.json();
        ok('Agent 首次上报自动注册', d.ok === true && d.created === true, `id=${d.id.slice(0, 8)}…`);
      }
    }
    await new Promise((s) => setTimeout(s, 650));
  }
  ok('连续上报 6 轮完成', true);

  console.log('\n=== 4. 数据读取 ===');
  r = await api('/api/bootstrap');
  const servers = r.data.overview.servers;
  ok('面板出现 2 台服务器', servers.length === 2, servers.map((s) => s.name).join(', '));
  const s0 = servers.find((s) => s.name === 'hk-web-01');
  ok('在线状态正确', s0?.online === true);
  ok('CPU 数据已入库', s0?.sample?.cpu > 0, `${s0?.sample?.cpu}%`);
  ok('网速换算生效', s0?.sample?.rxs > 0, `${(s0?.sample?.rxs / 1024).toFixed(1)} KB/s`);
  ok('磁盘信息完整', s0?.disks?.length === 2);
  ok('主机信息完整', s0?.host?.os === 'Ubuntu 22.04.4 LTS' && s0?.host?.cpuCores === 4);
  ok('地区标签识别', s0?.region === 'HK', s0?.region);

  r = await api(`/api/metrics?id=${s0.id}&range=1h&points=100`);
  ok('指标时序查询', r.data.data.points.length >= 1 && r.data.data.count >= 6, `${r.data.data.count} 条原始采样 → ${r.data.data.points.length} 个降采样点`);
  ok('峰值统计', r.data.data.peak.cpu > 0, `峰值 ${r.data.data.peak.cpu}%`);
  ok('区间流量统计', r.data.data.total.rx > 0, `${(r.data.data.total.rx / 1048576).toFixed(1)} MB`);

  console.log('\n=== 5. 服务器编辑 / 删除 ===');
  r = await api(`/api/servers/${s0.id}`, { method: 'POST', body: { name: '香港-Web-01', group: '生产', tags: ['高防', 'nginx'], note: '测试备注' } });
  ok('修改服务器属性', r.data.ok === true);
  r = await api('/api/bootstrap');
  const s0b = r.data.overview.servers.find((s) => s.id === s0.id);
  ok('修改已生效', s0b.name === '香港-Web-01' && s0b.group === '生产' && s0b.tags.length === 2);

  console.log('\n=== 6. 站点监控 ===');
  r = await api('/api/monitors', { method: 'POST', body: { name: '面板自身', type: 'http', target: `${BASE}/api/health`, interval: 10, timeout: 5 } });
  ok('新增 HTTP 监控', r.data.ok === true);
  r = await api('/api/monitors', { method: 'POST', body: { name: '无效目标', type: 'http', target: 'not-a-url' } });
  ok('非法目标被拒绝', r.status === 400, r.data.error);
  r = await api('/api/monitors', { method: 'POST', body: { name: '本地端口探测', type: 'tcp', target: `127.0.0.1:${PORT}`, interval: 10 } });
  ok('新增 TCP 监控', r.data.ok === true);

  await new Promise((s) => setTimeout(s, 4000));
  r = await api('/api/bootstrap');
  const mons = r.data.overview.monitors;
  const selfMon = mons.find((m) => m.name === '面板自身');
  const tcpMon = mons.find((m) => m.name === '本地端口探测');
  ok('HTTP 探测成功', selfMon?.ok === true, `${selfMon?.ms}ms / HTTP ${selfMon?.code}`);
  ok('TCP 探测成功', tcpMon?.ok === true, `${tcpMon?.ms}ms`);
  ok('可用率统计', selfMon?.uptime24 >= 0, `${selfMon?.uptime24}%`);
  ok('探测历史已记录', selfMon?.history?.length > 0);

  r = await api('/api/monitors', { method: 'POST', body: { name: '坏地址', type: 'http', target: `${BASE}/api/does-not-exist-404`, interval: 10 } });
  await new Promise((s) => setTimeout(s, 3000));
  r = await api('/api/bootstrap');
  const badMon = r.data.overview.monitors.find((m) => m.name === '坏地址');
  ok('404 被判定为异常', badMon?.ok === false, badMon?.message);

  console.log('\n=== 7. 告警 ===');
  r = await api('/api/channels', { method: 'POST', body: { type: 'webhook', name: '本地回声', config: { url: `${BASE}/api/health` } } });
  ok('新增 webhook 渠道', r.data.ok === true);
  const chId = r.data.channel.id;
  r = await api(`/api/channels/${chId}/test`, { method: 'POST' });
  ok('渠道测试推送成功', r.data.ok === true);
  r = await api(`/api/channels/${chId}`, { method: 'POST', body: { name: '本地回声2', enabled: false } });
  ok('修改渠道', r.data.ok === true);

  r = await api('/api/rules', { method: 'POST', body: { name: 'CPU 过高', type: 'cpu', threshold: 90, duration: 0, channels: [chId] } });
  ok('新增告警规则', r.data.ok === true);
  r = await api('/api/rules', { method: 'POST', body: { name: '错误类型', type: 'nope', channels: [] } });
  ok('非法规则类型被拒绝', r.status === 400);

  // 触发一次 CPU 告警（阈值 5%）
  await api('/api/channels', { method: 'POST', body: { type: 'webhook', name: '回声3', config: { url: `${BASE}/api/health` } } });
  r = await api('/api/bootstrap');
  const ch3 = r.data.config.channels.find((c) => c.name === '回声3');
  await api('/api/rules', { method: 'POST', body: { name: '低阈值CPU', type: 'cpu', threshold: 5, duration: 0, channels: [ch3.id] } });
  await api(`/api/rules`, { method: 'POST', body: {} }).catch(() => {});
  await fetch(BASE + '/api/agent/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': key },
    body: JSON.stringify(report('hk-web-01', ids[0], 99, 95, rx0 + 999999, rx0 / 3)),
  });
  await new Promise((s) => setTimeout(s, 800));
  r = await api('/api/events?limit=200');
  const alertEv = r.data.events.filter((e) => e.type === 'alert');
  ok('阈值告警已触发并记录事件', alertEv.length > 0, alertEv[0]?.message);
  const alertErr = r.data.events.filter((e) => e.type === 'alert-error');
  ok('推送无异常', alertErr.length === 0, alertErr[0]?.message);

  console.log('\n=== 8. 设置与安全 ===');
  r = await api('/api/settings', { method: 'POST', body: { title: '我的监控面板', interval: 20, offlineThreshold: 90, retentionDays: 14, repo: 'tmclsamxy/hera-monitor' } });
  ok('保存面板设置', r.data.ok === true && r.data.settings.interval === 20);
  r = await api('/api/bootstrap');
  ok('安装命令含 GitHub 仓库链接', r.data.install.command.includes('raw.githubusercontent.com/tmclsamxy/hera-monitor'), r.data.install.command.slice(0, 80) + '…');
  r = await api('/api/settings', { method: 'POST', body: { repo: '', publicUrl: '' } });

  r = await api('/api/password', { method: 'POST', body: { oldPassword: 'bad', newPassword: 'newpass123' } });
  ok('错误旧密码被拒绝', r.status === 400);
  r = await api('/api/password', { method: 'POST', body: { oldPassword: pwd, newPassword: '123' } });
  ok('过短新密码被拒绝', r.status === 400);
  r = await api('/api/password', { method: 'POST', body: { oldPassword: pwd, newPassword: 'hera123456' } });
  ok('修改密码成功', r.data.ok === true);
  r = await api('/api/login', { method: 'POST', body: { password: 'hera123456' } });
  ok('新密码可登录', r.status === 200);
  await api('/api/password', { method: 'POST', body: { oldPassword: 'hera123456', newPassword: pwd } });

  r = await api('/api/key/rotate', { method: 'POST' });
  const newKey = r.data.agentKey;
  ok('密钥轮换', newKey && newKey !== key);
  const rejected = await fetch(BASE + '/api/agent/report', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Key': key },
    body: JSON.stringify(report('x', 'x', 1, 1, 0, 0)),
  });
  ok('旧密钥失效', rejected.status === 401);
  const accepted = await fetch(BASE + '/api/agent/report', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Key': newKey },
    body: JSON.stringify(report('hk-web-01', ids[0], 20, 50, rx0 + 2000, rx0 / 3)),
  });
  ok('新密钥可用', accepted.status === 200);

  console.log('\n=== 9. SSE 实时推送 ===');
  const ctrl = new AbortController();
  const sseRes = await fetch(`${BASE}/api/stream?token=${token}`, { signal: ctrl.signal });
  ok('SSE 连接建立', sseRes.status === 200 && (sseRes.headers.get('content-type') || '').includes('text/event-stream'));
  const reader = sseRes.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 6000 && !buf.includes('event: overview')) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  ctrl.abort();
  ok('收到 overview 推送', buf.includes('event: overview'));
  try {
    const json = JSON.parse(buf.split('event: overview\ndata: ')[1].split('\n\n')[0]);
    ok('推送内容含服务器指标', json.servers.length === 2 && json.stats.total === 2);
  } catch (e) { ok('推送内容可解析', false, e.message); }

  console.log('\n=== 10. 异常与边界 ===');
  r = await api('/api/metrics?id=not-exist', {});
  ok('查询不存在的服务器返回 404', r.status === 404);
  r = await api('/api/servers/not-exist', { method: 'POST', body: { name: 'x' } });
  ok('修改不存在的服务器返回 404', r.status === 404);
  r = await api('/api/nope');
  ok('未知接口返回 404', r.status === 404);
  r = await api('/../../etc/passwd', { raw: true });
  ok('路径穿越被拦截', r.status !== 200 || !r.text.includes('root:'), `status=${r.status}`);

  // —— 回归测试：任何异常请求都必须给出响应，绝不能挂死 ——
  // 历史问题：handle() 是 async 但没有全局 try/catch，配合只记日志不退出进程的
  // uncaughtException 处理器，异常会让 socket 永远挂着 ——
  // 表现就是「lsof 看进程正常监听，但页面死活打不开」。
  const httpMod = require('node:http');
  const rawReq = (name, path, { method = 'GET', headers = {} } = {}) => new Promise((resolve) => {
    const started = Date.now();
    const req = httpMod.request({
      host: '127.0.0.1', port: PORT, path, method, headers,
    }, (res) => {
      res.resume();
      res.on('end', () => {
        ok(name, true, `HTTP ${res.statusCode} / ${Date.now() - started}ms`);
        resolve();
      });
    });
    req.setTimeout(5000, () => {
      ok(name, false, '请求挂死（5 秒无任何响应）');
      req.destroy();
      resolve();
    });
    req.on('error', (e) => {
      ok(name, true, `连接级错误但未挂死：${e.code || e.message}`);
      resolve();
    });
    req.end();
  });

  await rawReq('畸形百分号编码 /% 不挂死', '/%');
  await rawReq('截断的 UTF-8 编码不挂死', '/%E0%A4%A');
  await rawReq('超长路径不挂死', `/${'a'.repeat(4000)}`);
  await rawReq('非法 Host 头不挂死', '/api/health', { headers: { Host: 'a b c' } });
  await rawReq('不存在的方法不挂死', '/api/health', { method: 'PATCH' });
  await rawReq('超长 URL 不挂死', `/${'x'.repeat(8000)}?${'y'.repeat(8000)}`);

  // 健康检查要暴露真实监听地址，用于排查容器端口映射问题
  r = await api('/api/health');
  ok('/api/health 暴露监听地址', typeof r.data.listen?.address === 'string' && r.data.listen.address.length > 0,
    `${r.data.listen?.address}:${r.data.listen?.port}`);
  ok('/api/health 暴露数据目录', typeof r.data.dataDir === 'string' && r.data.dataDir.length > 0, r.data.dataDir);
  ok('自检端口与实际监听一致', Number(r.data.listen?.port) === PORT, `自检=${r.data.listen?.port} 实际=${PORT}`);

  r = await api('/api/bootstrap');
  ok('默认分组与排序正常', r.data.overview.servers.length > 0);

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  测试完成：通过 ${pass} 项，失败 ${fail} 项`);
  console.log('═'.repeat(50));

  // 清理：删除测试产生的服务器/监控
  for (const s of (r.data.overview.servers || [])) {
    await api(`/api/servers/${s.id}`, { method: 'DELETE' });
  }
  for (const m of (r.data.overview.monitors || [])) {
    await api(`/api/monitors/${m.id}`, { method: 'DELETE' });
  }
  process.exit(fail ? 1 : 0);
})();

