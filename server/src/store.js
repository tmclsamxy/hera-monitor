import fs from 'node:fs';
import path from 'node:path';
import {
  METRICS_DIR, UPTIME_DIR, DATA_DIR, config, saveConfig,
} from './config.js';
import {
  now, ensureDir, readJSON, writeJSON, appendJSONL, readJSONL, pruneJSONL, clean, round, clamp,
} from './util.js';

const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
const MONITORS_FILE = path.join(DATA_DIR, 'monitors.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');

const MAX_EVENTS_MEM = 300;

export const state = {
  servers: new Map(),
  monitors: new Map(),
  events: [],
  lastSave: 0,
  dirty: false,
};

const metricFile = (id) => path.join(METRICS_DIR, `${id}.jsonl`);
const uptimeFile = (id) => path.join(UPTIME_DIR, `${id}.jsonl`);

/* ------------------------------------------------------------------ 事件 */

export function logEvent(type, message, meta = {}) {
  const ev = {
    t: now(), type, message, meta,
  };
  state.events.unshift(ev);
  if (state.events.length > MAX_EVENTS_MEM) state.events.length = MAX_EVENTS_MEM;
  appendJSONL(EVENTS_FILE, ev);
  return ev;
}

export function listEvents(limit = 100) {
  return state.events.slice(0, limit);
}

/* --------------------------------------------------------------- 服务器 */

/**
 * 持久化字段。
 * 除了用户可编辑的属性，还包括「最后一次上报的快照」——
 * 这样服务重启后面板能立刻显示上次已知状态，而不用等下一个上报周期。
 */
const PERSIST_FIELDS = [
  'id', 'name', 'group', 'tags', 'note', 'price', 'expireAt', 'region',
  'hidden', 'createdAt', 'sortWeight',
  'host', 'disks', 'net', 'lastSeen', 'latest', 'agentVersion', 'ip',
  'totalRx', 'totalTx', 'netSpeed', 'bootTime',
];

function serializeServers() {
  return [...state.servers.values()].map((s) => {
    const o = {};
    for (const k of PERSIST_FIELDS) o[k] = s[k];
    return o;
  });
}

export function saveServers(force = false) {
  const t = now();
  if (!force && t - state.lastSave < 8000) {
    state.dirty = true;
    return;
  }
  state.dirty = false;
  state.lastSave = t;
  writeJSON(SERVERS_FILE, serializeServers());
}

export function loadServers() {
  const arr = readJSON(SERVERS_FILE, []) || [];
  const offlineMs = (config().settings.offlineThreshold || 120) * 1000;
  const t0 = now();
  for (const item of arr) {
    if (!item?.id) continue;
    const lastSeen = Number(item.lastSeen) || 0;
    state.servers.set(item.id, {
      id: item.id,
      name: clean(item.name, 64) || item.id.slice(0, 8),
      group: clean(item.group, 32) || '默认',
      tags: Array.isArray(item.tags) ? item.tags.map((x) => clean(x, 24)).slice(0, 8) : [],
      note: clean(item.note, 500),
      price: Number(item.price) || 0,
      expireAt: clean(item.expireAt, 32),
      region: clean(item.region, 16),
      hidden: !!item.hidden,
      sortWeight: Number(item.sortWeight) || 0,
      createdAt: item.createdAt || now(),
      /* 从上次快照恢复 */
      host: item.host && typeof item.host === 'object' ? item.host : null,
      disks: Array.isArray(item.disks) ? item.disks : [],
      net: Array.isArray(item.net) ? item.net : [],
      latest: item.latest && typeof item.latest === 'object' ? item.latest : null,
      lastSeen,
      online: lastSeen > 0 && t0 - lastSeen < offlineMs,
      agentVersion: clean(item.agentVersion, 24),
      ip: clean(item.ip, 64),
      totalRx: Number(item.totalRx) || 0,
      totalTx: Number(item.totalTx) || 0,
      netSpeed: item.netSpeed || { rx: 0, tx: 0 },
      bootTime: Number(item.bootTime) || 0,
      offlineNotified: false,
      alertState: {},
    });
  }
}

export function getServer(id) {
  return state.servers.get(id);
}

export function listServers({ includeHidden = true } = {}) {
  return [...state.servers.values()]
    .filter((s) => includeHidden || !s.hidden)
    .sort((a, b) => (b.sortWeight - a.sortWeight) || a.name.localeCompare(b.name));
}

export function updateServer(id, patch) {
  const s = state.servers.get(id);
  if (!s) return null;
  if (patch.name !== undefined) s.name = clean(patch.name, 64) || s.name;
  if (patch.group !== undefined) s.group = clean(patch.group, 32) || '默认';
  if (patch.note !== undefined) s.note = clean(patch.note, 500);
  if (patch.region !== undefined) s.region = clean(patch.region, 16);
  if (patch.expireAt !== undefined) s.expireAt = clean(patch.expireAt, 32);
  if (patch.price !== undefined) s.price = Number(patch.price) || 0;
  if (patch.hidden !== undefined) s.hidden = !!patch.hidden;
  if (patch.sortWeight !== undefined) s.sortWeight = Number(patch.sortWeight) || 0;
  if (Array.isArray(patch.tags)) s.tags = patch.tags.map((x) => clean(x, 24)).filter(Boolean).slice(0, 8);
  saveServers(true);
  return s;
}

/**
 * 按给定顺序重排服务器（手动排序）。
 *
 * 权重从「现有最大值 + 步长」开始依次递减，这样：
 * - 传入的这批机器顺序就是最终展示顺序；
 * - 未参与排序的机器（隐藏的、别的分组的）权重不变，
 *   因而始终排在手动排过序的机器之后，不会被顶到前面去。
 *
 * @param {string[]} ids 服务器 id，按期望的展示顺序排列
 * @returns {number} 实际更新的台数
 */
export function reorderServers(ids) {
  const list = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : [];
  if (!list.length) return 0;

  let max = 0;
  for (const s of state.servers.values()) {
    if (s.sortWeight > max) max = s.sortWeight;
  }

  const step = 100;
  let updated = 0;
  list.forEach((id, i) => {
    const s = state.servers.get(id);
    if (!s) return;
    s.sortWeight = max + step * (list.length - i);
    updated += 1;
  });

  if (updated) saveServers(true);
  return updated;
}

export function deleteServer(id) {
  const s = state.servers.get(id);
  if (!s) return false;
  state.servers.delete(id);
  saveServers(true);
  try { fs.unlinkSync(metricFile(id)); } catch { /* ignore */ }
  return true;
}

/* --------------------------------------------------- 指标写入 / 速度换算 */

function netSpeed(server, rx, tx) {
  const t = now();
  const prev = server.__netPrev;
  let rxs = 0;
  let txs = 0;
  if (prev) {
    const dt = (t - prev.t) / 1000;
    if (dt > 0.5 && rx >= prev.rx && tx >= prev.tx) {
      rxs = Math.max(0, (rx - prev.rx) / dt);
      txs = Math.max(0, (tx - prev.tx) / dt);
    }
  }
  // 累计总流量（跨重启以最大值为基准，避免回绕放大）
  if (prev && rx >= prev.rx) server.totalRx += rx - prev.rx;
  if (prev && tx >= prev.tx) server.totalTx += tx - prev.tx;
  server.__netPrev = { rx, tx, t };
  return { rxs: Math.round(rxs), txs: Math.round(txs) };
}

/**
 * 接收 agent 上报并落库。
 * @returns {{id:string,created:boolean}}
 */
export function ingestReport(report, ip) {
  const host = report.host || {};
  const id = clean(host.id, 64) || clean(host.hostname, 64) || 'unknown';
  let created = false;
  let s = state.servers.get(id);

  if (!s) {
    created = true;
    s = {
      id,
      name: clean(host.hostname, 64) || id.slice(0, 12),
      group: '默认',
      tags: [],
      note: '',
      price: 0,
      expireAt: '',
      region: clean(host.region || host.country, 8) || '',
      hidden: false,
      sortWeight: 0,
      createdAt: now(),
      online: false,
      lastSeen: 0,
      latest: null,
      host: null,
      disks: [],
      net: [],
      netSpeed: { rx: 0, tx: 0 },
      totalRx: 0,
      totalTx: 0,
      agentVersion: '',
      ip: '',
      offlineNotified: false,
      alertState: {},
    };
    state.servers.set(id, s);
  }

  const rx = Number(report.netTotal?.rx) || 0;
  const tx = Number(report.netTotal?.tx) || 0;
  const spd = netSpeed(s, rx, tx);

  const disks = (Array.isArray(report.disks) ? report.disks : []).slice(0, 24).map((d) => ({
    fs: clean(d.fs, 128),
    mount: clean(d.mount, 128),
    total: Number(d.total) || 0,
    used: Number(d.used) || 0,
    pct: round(Number(d.pct) || 0, 1),
  }));

  const nets = (Array.isArray(report.net) ? report.net : []).slice(0, 16).map((n) => ({
    iface: clean(n.iface, 32),
    rx: Number(n.rx) || 0,
    tx: Number(n.tx) || 0,
  }));

  const memTotal = Number(report.mem?.total) || 0;
  const memUsed = Number(report.mem?.used) || 0;
  const diskUsed = disks.reduce((a, d) => a + d.used, 0);
  const diskTotal = disks.reduce((a, d) => a + d.total, 0);
  const diskPct = diskTotal > 0 ? round((diskUsed / diskTotal) * 100, 1) : 0;

  s.host = {
    hostname: clean(host.hostname, 64),
    os: clean(host.os, 96),
    platform: clean(host.platform, 32),
    arch: clean(host.arch, 24),
    kernel: clean(host.kernel, 96),
    cpuModel: clean(host.cpuModel, 128),
    cpuCores: Number(host.cpuCores) || 0,
    virt: clean(host.virt, 32),
  };
  s.agentVersion = clean(report.agent?.version, 24);
  s.ip = clean(ip, 64);
  s.bootTime = Number(report.bootTime) || 0;
  s.disks = disks;
  s.net = nets;
  s.netSpeed = { rx: spd.rxs, tx: spd.txs };
  s.lastSeen = now();
  s.online = true;
  s.offlineNotified = false;

  const sample = {
    t: now(),
    cpu: round(Number(report.cpu?.usage) || 0, 1),
    mem: memTotal ? round((memUsed / memTotal) * 100, 1) : 0,
    memUsed,
    swap: Number(report.swap?.total) ? round((Number(report.swap.used) / Number(report.swap.total)) * 100, 1) : 0,
    load: round(Number(report.load?.l1) || 0, 2),
    load5: round(Number(report.load?.l5) || 0, 2),
    load15: round(Number(report.load?.l15) || 0, 2),
    rx,
    tx,
    rxs: spd.rxs,
    txs: spd.txs,
    diskUsed,
    diskTotal,
    procs: Number(report.procs) || 0,
    tcp: Number(report.tcp) || 0,
    uptime: Number(report.uptime) || 0,
  };

  s.latest = {
    ...sample,
    memTotal,
    memAvailable: Number(report.mem?.available) || 0,
    swapTotal: Number(report.swap?.total) || 0,
    swapUsed: Number(report.swap?.used) || 0,
    diskPct,
    bootTime: Number(report.bootTime) || 0,
    netTotal: { rx, tx },
    cpuUser: round(Number(report.cpu?.user) || 0, 1),
    cpuSystem: round(Number(report.cpu?.system) || 0, 1),
    cpuIowait: round(Number(report.cpu?.iowait) || 0, 1),
    cpuSteal: round(Number(report.cpu?.steal) || 0, 1),
  };

  appendJSONL(metricFile(id), sample);
  saveServers();
  if (created) logEvent('agent', `新服务器接入：${s.name}`, { id, ip });
  return { id, created };
}

/* --------------------------------------------------- 指标查询（降采样） */

/**
 * 查询时序指标并降采样到目标点数。
 */
export function queryMetrics(id, { rangeMs = 3600_000, points = 240 } = {}) {
  const until = now();
  const since = until - rangeMs;
  const rows = readJSONL(metricFile(id), { since, until });
  const keys = ['cpu', 'mem', 'rxs', 'txs', 'load', 'diskUsed', 'diskTotal'];
  if (!rows.length) {
    return {
      points: [], count: 0, peak: { cpu: 0, mem: 0, rxs: 0, txs: 0 }, total: { rx: 0, tx: 0 },
    };
  }

  const bucketMs = Math.max(1000, Math.ceil(rangeMs / points));
  const buckets = new Map();
  for (const r of rows) {
    const b = Math.floor(r.t / bucketMs) * bucketMs;
    let acc = buckets.get(b);
    if (!acc) {
      acc = { t: b, n: 0 };
      for (const k of keys) acc[k] = 0;
      buckets.set(b, acc);
    }
    acc.n += 1;
    for (const k of keys) acc[k] += Number(r[k]) || 0;
    acc.rx = r.rx;
    acc.tx = r.tx;
  }

  const out = [...buckets.values()]
    .sort((a, b) => a.t - b.t)
    .map((a) => {
      const o = { t: a.t };
      for (const k of keys) o[k] = round(a[k] / a.n, k === 'rxs' || k === 'txs' ? 0 : 1);
      return o;
    });

  const peak = { cpu: 0, mem: 0, rxs: 0, txs: 0, load: 0 };
  for (const r of rows) {
    for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], Number(r[k]) || 0);
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  const rxDelta = Math.max(0, (last.rx || 0) - (first.rx || 0));
  const txDelta = Math.max(0, (last.tx || 0) - (first.tx || 0));

  return {
    points: out,
    count: rows.length,
    bucketMs,
    peak,
    total: { rx: rxDelta, tx: txDelta },
  };
}

/* ------------------------------------------------------------- 站点监控 */

export function loadMonitors() {
  const arr = readJSON(MONITORS_FILE, []) || [];
  for (const m of arr) {
    if (!m?.id) continue;
    state.monitors.set(m.id, {
      id: m.id,
      name: clean(m.name, 64) || m.target,
      type: m.type === 'tcp' ? 'tcp' : m.type === 'ping' ? 'ping' : 'http',
      target: clean(m.target, 300),
      method: clean(m.method, 8) || 'GET',
      interval: clamp(Number(m.interval) || 60, 10, 3600),
      timeout: clamp(Number(m.timeout) || 10, 1, 60),
      expectCode: Number(m.expectCode) || 0,
      keyword: clean(m.keyword, 100),
      enabled: m.enabled !== false,
      createdAt: m.createdAt || now(),
      /* 运行时 */
      ok: null,
      ms: 0,
      code: 0,
      message: '',
      lastCheck: 0,
      lastChange: 0,
      uptime24: null,
      history: [],
    });
  }
}

export function saveMonitors() {
  writeJSON(MONITORS_FILE, [...state.monitors.values()].map((m) => ({
    id: m.id, name: m.name, type: m.type, target: m.target, method: m.method,
    interval: m.interval, timeout: m.timeout, expectCode: m.expectCode,
    keyword: m.keyword, enabled: m.enabled, createdAt: m.createdAt,
  })));
}

export function listMonitors() {
  return [...state.monitors.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function recordProbe(monitor, result) {
  const prevOk = monitor.ok;
  monitor.ok = result.ok;
  monitor.ms = result.ms;
  monitor.code = result.code || 0;
  monitor.message = clean(result.message, 200);
  monitor.lastCheck = now();
  if (prevOk !== result.ok) {
    monitor.lastChange = monitor.lastCheck;
    logEvent('monitor', `${monitor.name} ${result.ok ? '恢复正常' : '探测失败'}`, {
      id: monitor.id, message: monitor.message,
    });
  }
  monitor.history.push({ t: monitor.lastCheck, ok: result.ok ? 1 : 0, ms: result.ms });
  if (monitor.history.length > 120) monitor.history.splice(0, monitor.history.length - 120);
  appendJSONL(uptimeFile(monitor.id), {
    t: monitor.lastCheck, ok: result.ok ? 1 : 0, ms: result.ms, code: monitor.code,
  });

  const since = now() - 86400_000;
  const rows = readJSONL(uptimeFile(monitor.id), { since, limit: 5000 });
  if (rows.length) {
    monitor.uptime24 = round((rows.filter((r) => r.ok).length / rows.length) * 100, 2);
  }
}

export function queryProbes(id, rangeMs = 86400_000) {
  return readJSONL(uptimeFile(id), { since: now() - rangeMs, limit: 5000 });
}

export function deleteMonitor(id) {
  if (!state.monitors.delete(id)) return false;
  saveMonitors();
  try { fs.unlinkSync(uptimeFile(id)); } catch { /* ignore */ }
  return true;
}

/* --------------------------------------------------------- 定时维护任务 */

/** @returns {Array} 本次新变为离线的服务器列表 */
export function markOffline() {
  const threshold = (config().settings.offlineThreshold || 120) * 1000;
  const t = now();
  const newlyOffline = [];
  for (const s of state.servers.values()) {
    if (s.online && s.lastSeen && t - s.lastSeen > threshold) {
      s.online = false;
      logEvent('offline', `${s.name} 离线（超过 ${Math.round(threshold / 1000)}s 未上报）`, { id: s.id });
      newlyOffline.push(s);
    }
  }
  return newlyOffline;
}

export function pruneOldData() {
  const days = config().settings.retentionDays || 7;
  const before = now() - days * 86400_000;
  ensureDir(METRICS_DIR);
  for (const f of fs.readdirSync(METRICS_DIR)) {
    if (f.endsWith('.jsonl')) pruneJSONL(path.join(METRICS_DIR, f), before);
  }
  for (const f of fs.readdirSync(UPTIME_DIR)) {
    if (f.endsWith('.jsonl')) pruneJSONL(path.join(UPTIME_DIR, f), before);
  }
  pruneJSONL(EVENTS_FILE, before);
}

export function loadAll() {
  ensureDir(DATA_DIR);
  ensureDir(METRICS_DIR);
  ensureDir(UPTIME_DIR);
  loadServers();
  loadMonitors();
  state.events = readJSONL(EVENTS_FILE, { limit: MAX_EVENTS_MEM }).reverse();
}

export function overview({ includeHidden = false } = {}) {
  const servers = listServers({ includeHidden });
  const online = servers.filter((s) => s.online).length;
  return {
    t: now(),
    stats: {
      total: servers.length,
      online,
      offline: servers.length - online,
      monitors: state.monitors.size,
      monitorsDown: [...state.monitors.values()].filter((m) => m.enabled && m.ok === false).length,
    },
    servers: servers.map((s) => ({
      id: s.id,
      name: s.name,
      group: s.group,
      tags: s.tags,
      region: s.region,
      hidden: s.hidden,
      online: s.online,
      lastSeen: s.lastSeen,
      ip: s.ip,
      host: s.host,
      disks: s.disks,
      net: s.net,
      netSpeed: s.netSpeed,
      totalRx: s.totalRx,
      totalTx: s.totalTx,
      uptime: s.latest?.uptime || 0,
      memTotal: s.latest?.memTotal || 0,
      swapTotal: s.latest?.swapTotal || 0,
      swapUsed: s.latest?.swapUsed || 0,
      diskTotal: s.latest?.diskTotal || 0,
      note: s.note,
      price: s.price,
      expireAt: s.expireAt,
      createdAt: s.createdAt,
      agentVersion: s.agentVersion,
      sample: s.latest
        ? {
          cpu: s.latest.cpu, mem: s.latest.mem, memUsed: s.latest.memUsed,
          swap: s.latest.swap, load: s.latest.load, load5: s.latest.load5, load15: s.latest.load15,
          rxs: s.latest.rxs, txs: s.latest.txs, diskPct: s.latest.diskPct,
          procs: s.latest.procs, tcp: s.latest.tcp, uptime: s.latest.uptime,
        }
        : null,
    })),
    monitors: listMonitors().map((m) => ({
      id: m.id, name: m.name, type: m.type, target: m.target, enabled: m.enabled,
      ok: m.ok, ms: m.ms, code: m.code, message: m.message,
      lastCheck: m.lastCheck, uptime24: m.uptime24, history: m.history.slice(-60),
    })),
    events: state.events.slice(0, 40),
  };
}
