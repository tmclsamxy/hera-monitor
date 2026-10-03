import crypto from 'node:crypto';
import { config, saveConfig } from './config.js';
import { request } from './probe.js';
import { now, randHex, clean, round } from './util.js';
import { logEvent } from './store.js';

/* ------------------------------------------------------------ 条件状态机 */

/**
 * 持续时长判定：条件成立满 duration 秒才触发，避免抖动误报。
 * @returns {boolean} 本次是否应当触发
 */
const states = new Map();

function shouldFire(key, active, durationSec, cooldownSec) {
  const t = now();
  let st = states.get(key);
  if (!st) {
    st = { since: t, firedAt: 0, active: false };
    states.set(key, st);
  }
  if (!active) {
    st.since = t;
    st.active = false;
    return false;
  }
  if (!st.active) {
    st.active = true;
    // 首次进入激活态，等待持续时长
  }
  if (t - st.since < durationSec * 1000) return false;
  if (t - st.firedAt < cooldownSec * 1000) return false;
  st.firedAt = t;
  return true;
}

export function resetAlertState() {
  states.clear();
}

/* --------------------------------------------------------------- 发送器 */

function dingtalkSign(secret) {
  const ts = Date.now();
  const sign = crypto
    .createHmac('sha256', secret)
    .update(`${ts}\n${secret}`)
    .digest('base64');
  return `&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
}

const SENDERS = {
  async webhook(cfg, title, text) {
    await request(cfg.url, {
      method: 'POST',
      body: { title, text, source: 'hera-monitor', time: new Date().toISOString() },
      headers: cfg.headers ? JSON.parse(cfg.headers) : {},
      timeout: 10000,
    });
  },
  async telegram(cfg, title, text) {
    await request(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      body: { chat_id: cfg.chatId, text: `${title}\n\n${text}`, disable_web_page_preview: true },
      timeout: 10000,
    });
  },
  async dingtalk(cfg, title, text) {
    let url = cfg.webhook;
    if (cfg.secret) url += dingtalkSign(cfg.secret);
    await request(url, {
      method: 'POST',
      body: { msgtype: 'markdown', markdown: { title, text: `#### ${title}\n\n${text.replace(/\n/g, '\n\n')}` } },
      timeout: 10000,
    });
  },
  async feishu(cfg, title, text) {
    await request(cfg.webhook, {
      method: 'POST',
      body: { msg_type: 'text', content: { text: `${title}\n${text}` } },
      timeout: 10000,
    });
  },
  async bark(cfg, title, text) {
    const base = (cfg.url || 'https://api.day.app').replace(/\/+$/, '');
    await request(`${base}/${cfg.key}`, {
      method: 'POST',
      body: { title, body: text, group: 'Hera Monitor' },
      timeout: 10000,
    });
  },
  async serverchan(cfg, title, text) {
    await request(`https://sctapi.ftqq.com/${cfg.key}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(text)}`,
      timeout: 10000,
    });
  },
  async gotify(cfg, title, text) {
    const base = (cfg.url || '').replace(/\/+$/, '');
    await request(`${base}/message?token=${encodeURIComponent(cfg.token)}`, {
      method: 'POST',
      body: { title, message: text, priority: 5 },
      timeout: 10000,
    });
  },
};

export const CHANNEL_TYPES = [
  { type: 'webhook', label: '自定义 Webhook', fields: [{ k: 'url', label: 'URL', required: true }, { k: 'headers', label: '额外请求头(JSON，可选)' }] },
  { type: 'telegram', label: 'Telegram', fields: [{ k: 'token', label: 'Bot Token', required: true }, { k: 'chatId', label: 'Chat ID', required: true }] },
  { type: 'dingtalk', label: '钉钉机器人', fields: [{ k: 'webhook', label: 'Webhook 地址', required: true }, { k: 'secret', label: '加签密钥（可选）' }] },
  { type: 'feishu', label: '飞书机器人', fields: [{ k: 'webhook', label: 'Webhook 地址', required: true }] },
  { type: 'bark', label: 'Bark (iOS)', fields: [{ k: 'url', label: '服务地址（默认 https://api.day.app）' }, { k: 'key', label: '推送 Key', required: true }] },
  { type: 'serverchan', label: 'Server 酱', fields: [{ k: 'key', label: 'SendKey', required: true }] },
  { type: 'gotify', label: 'Gotify', fields: [{ k: 'url', label: '服务地址', required: true }, { k: 'token', label: '应用 Token', required: true }] },
];

/** 向所有命中的渠道并发推送；失败只记录不抛出 */
export async function dispatch(channelIds, title, text, meta = {}) {
  const cfg = config();
  const channels = (cfg.alerts.channels || []).filter(
    (c) => c.enabled !== false && (!channelIds?.length || channelIds.includes(c.id)),
  );
  const results = await Promise.allSettled(channels.map(async (c) => {
    const sender = SENDERS[c.type];
    if (!sender) throw new Error(`未知渠道类型 ${c.type}`);
    await sender(c.config || {}, title, text);
    return c.name;
  }));
  logEvent('alert', title, { ...meta, text });
  for (const [i, r] of results.entries()) {
    if (r.status === 'rejected') {
      logEvent('alert-error', `渠道「${channels[i].name}」推送失败：${r.reason?.message || r.reason}`, {
        channelId: channels[i].id,
      });
    }
  }
  return results;
}

/* --------------------------------------------------------------- 规则评估 */

const RULE_TYPES = [
  { type: 'offline', label: '服务器离线', thresholdLabel: '' },
  { type: 'cpu', label: 'CPU 使用率', unit: '%', default: 90 },
  { type: 'mem', label: '内存使用率', unit: '%', default: 90 },
  { type: 'disk', label: '硬盘使用率', unit: '%', default: 85 },
  { type: 'load', label: '系统负载(1分钟)', unit: '', default: 4 },
  { type: 'monitor', label: '站点监控失败', thresholdLabel: '' },
];

export { RULE_TYPES };

function passesFilter(rule, serverId) {
  if (!rule.serverIds?.length) return true;
  return rule.serverIds.includes(serverId);
}

function fmtTime(t = now()) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function fire(rule, targetLabel, value, threshold, unit, extra = '') {
  if (!rule.channels?.length) return;
  const title = `【Hera 告警】${rule.name || RULE_TYPES.find((r) => r.type === rule.type)?.label || rule.type}`;
  const lines = [
    `目标：${targetLabel}`,
    threshold != null ? `当前值：${value}${unit || ''}（阈值 ${threshold}${unit || ''}）` : `状态：${value}`,
    extra ? `详情：${extra}` : '',
    `时间：${fmtTime()}`,
  ].filter(Boolean);
  await dispatch(rule.channels, title, lines.join('\n'), {
    ruleId: rule.id, ruleType: rule.type, target: targetLabel,
  });
}

export async function evaluateServerSample(server, sample) {
  const cfg = config();
  const cd = cfg.alerts.cooldown || 600;
  const checks = [
    ['cpu', sample.cpu, '%'],
    ['mem', sample.mem, '%'],
    ['disk', sample.diskPct, '%'],
    ['load', sample.load, ''],
  ];
  for (const [type, value, unit] of checks) {
    for (const rule of cfg.alerts.rules || []) {
      if (!rule.enabled || rule.type !== type) continue;
      if (!passesFilter(rule, server.id)) continue;
      const threshold = Number(rule.threshold ?? RULE_TYPES.find((r) => r.type === type)?.default ?? 90);
      const active = Number(value) >= threshold;
      const key = `${rule.id}|${server.id}`;
      if (shouldFire(key, active, Number(rule.duration) || 0, cd)) {
        // eslint-disable-next-line no-await-in-loop
        await fire(rule, server.name, round(Number(value), 1), threshold, unit);
      }
    }
  }
}

export async function evaluateOffline(server) {
  const cfg = config();
  const cd = cfg.alerts.cooldown || 600;
  const rule = (cfg.alerts.rules || []).find((r) => r.enabled && r.type === 'offline' && passesFilter(r, server.id));
  if (!rule) return;
  if (shouldFire(`${rule.id}|${server.id}`, true, 0, cd)) {
    await fire(rule, server.name, '离线', null, '', `最后上报 ${fmtTime(server.lastSeen)}`);
    server.offlineNotified = true;
  }
}

export async function evaluateMonitor(monitor) {
  const cfg = config();
  const cd = cfg.alerts.cooldown || 600;
  const rule = (cfg.alerts.rules || []).find((r) => r.enabled && r.type === 'monitor');
  if (!rule) return;
  const active = monitor.ok === false;
  if (shouldFire(`${rule.id}|${monitor.id}`, active, 0, cd)) {
    await fire(rule, `${monitor.name} (${monitor.target})`, '不可用', null, '', monitor.message);
  }
}

export function addChannel({ type, name, config: c }) {
  const cfg = config();
  const known = CHANNEL_TYPES.find((t) => t.type === type);
  if (!known) throw new Error('未知的通知渠道类型');
  const channel = {
    id: `ch_${randHex(5)}`,
    type,
    name: clean(name, 40) || known.label,
    enabled: true,
    config: c && typeof c === 'object' ? c : {},
  };
  for (const f of known.fields) {
    if (f.required && !channel.config[f.k]) throw new Error(`${f.label} 不能为空`);
  }
  cfg.alerts.channels.push(channel);
  saveConfig();
  return channel;
}

export function updateChannel(id, patch) {
  const cfg = config();
  const ch = cfg.alerts.channels.find((c) => c.id === id);
  if (!ch) return null;
  if (patch.name !== undefined) ch.name = clean(patch.name, 40) || ch.name;
  if (patch.enabled !== undefined) ch.enabled = !!patch.enabled;
  if (patch.config && typeof patch.config === 'object') ch.config = { ...ch.config, ...patch.config };
  saveConfig();
  return ch;
}

export function removeChannel(id) {
  const cfg = config();
  const i = cfg.alerts.channels.findIndex((c) => c.id === id);
  if (i < 0) return false;
  cfg.alerts.channels.splice(i, 1);
  for (const r of cfg.alerts.rules) {
    r.channels = (r.channels || []).filter((x) => x !== id);
  }
  saveConfig();
  return true;
}

export function addRule(input) {
  const cfg = config();
  const type = RULE_TYPES.find((t) => t.type === input.type);
  if (!type) throw new Error('未知的告警规则类型');
  const rule = {
    id: `rl_${randHex(5)}`,
    name: clean(input.name, 40) || type.label,
    type: input.type,
    enabled: input.enabled !== false,
    threshold: input.threshold === '' || input.threshold == null
      ? (type.default ?? 0)
      : Number(input.threshold) || 0,
    duration: Math.max(0, Number(input.duration) || 0),
    serverIds: Array.isArray(input.serverIds) ? input.serverIds.filter(Boolean) : [],
    channels: Array.isArray(input.channels) ? input.channels.filter(Boolean) : [],
  };
  cfg.alerts.rules.push(rule);
  saveConfig();
  return rule;
}

export function updateRule(id, patch) {
  const cfg = config();
  const r = cfg.alerts.rules.find((x) => x.id === id);
  if (!r) return null;
  if (patch.name !== undefined) r.name = clean(patch.name, 40) || r.name;
  if (patch.enabled !== undefined) r.enabled = !!patch.enabled;
  if (patch.threshold !== undefined) r.threshold = Number(patch.threshold) || 0;
  if (patch.duration !== undefined) r.duration = Math.max(0, Number(patch.duration) || 0);
  if (Array.isArray(patch.serverIds)) r.serverIds = patch.serverIds.filter(Boolean);
  if (Array.isArray(patch.channels)) r.channels = patch.channels.filter(Boolean);
  saveConfig();
  return r;
}

export function removeRule(id) {
  const cfg = config();
  const i = cfg.alerts.rules.findIndex((r) => r.id === id);
  if (i < 0) return false;
  cfg.alerts.rules.splice(i, 1);
  saveConfig();
  return true;
}

export async function testChannel(id) {
  const cfg = config();
  const ch = cfg.alerts.channels.find((c) => c.id === id);
  if (!ch) throw new Error('渠道不存在');
  const sender = SENDERS[ch.type];
  if (!sender) throw new Error('该类型暂不支持测试');
  await sender(ch.config || {}, '【Hera 监控】测试消息', `这是一条来自 Hera Monitor 的测试通知。\n时间：${fmtTime()}`);
  return true;
}
