import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, ensureDir, randHex, sha256, safeEqual } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.resolve(SERVER_ROOT, 'public');
export const DATA_DIR = process.env.HERA_DATA_DIR
  ? path.resolve(process.env.HERA_DATA_DIR)
  : path.resolve(SERVER_ROOT, '..', 'data');
export const METRICS_DIR = path.join(DATA_DIR, 'metrics');
export const UPTIME_DIR = path.join(DATA_DIR, 'uptime');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  version: 1,
  secret: null,
  agentKey: null,
  passwordSalt: null,
  passwordHash: null,
  sessionDays: 7,
  site: { title: 'Hera Monitor', theme: 'dark' },
  settings: {
    interval: 30,
    retentionDays: 7,
    offlineThreshold: 120,
    publicOverview: false,
  },
  alerts: {
    cooldown: 600,
    channels: [],
    rules: [],
  },
};

let cache = null;

function bootstrapSecrets(cfg) {
  let changed = false;
  if (!cfg.secret) {
    cfg.secret = randHex(32);
    changed = true;
  }
  if (!cfg.agentKey) {
    cfg.agentKey = randHex(20);
    changed = true;
  }
  if (!cfg.passwordHash || !cfg.passwordSalt) {
    // 首次启动生成随机密码，写入 data/initial-password.txt 并打印到日志，
    // 避免默认弱口令被扫到
    const pwd = randHex(6).slice(0, 10);
    cfg.passwordSalt = randHex(8);
    cfg.passwordHash = sha256(cfg.passwordSalt + pwd);
    try {
      fs.writeFileSync(path.join(DATA_DIR, 'initial-password.txt'), `${pwd}\n`);
    } catch { /* ignore */ }
    cfg.__initialPassword = pwd;
    changed = true;
  }
  return changed;
}

export function loadConfig() {
  ensureDir(DATA_DIR);
  ensureDir(METRICS_DIR);
  ensureDir(UPTIME_DIR);
  const raw = readJSON(CONFIG_FILE, null) || {};
  cache = {
    ...DEFAULTS,
    ...raw,
    site: { ...DEFAULTS.site, ...(raw.site || {}) },
    settings: { ...DEFAULTS.settings, ...(raw.settings || {}) },
    alerts: { ...DEFAULTS.alerts, ...(raw.alerts || {}) },
  };
  if (bootstrapSecrets(cache)) saveConfig();
  // 部署脚本可通过环境变量注入仓库地址，用于生成 Agent 一键安装命令
  if (process.env.HERA_REPO && !cache.settings.repo) {
    cache.settings.repo = String(process.env.HERA_REPO);
    saveConfig();
  }
  if (process.env.HERA_PUBLIC_URL && !cache.settings.publicUrl) {
    cache.settings.publicUrl = String(process.env.HERA_PUBLIC_URL);
    saveConfig();
  }
  return cache;
}

export function config() {
  return cache || loadConfig();
}

export function saveConfig() {
  if (!cache) return;
  const out = { ...cache };
  delete out.__initialPassword;
  writeJSON(CONFIG_FILE, out);
}

export function verifyPassword(password) {
  const cfg = config();
  if (!password) return false;
  return safeEqual(sha256(cfg.passwordSalt + String(password)), cfg.passwordHash);
}

export function setPassword(password) {
  const cfg = config();
  cfg.passwordSalt = randHex(8);
  cfg.passwordHash = sha256(cfg.passwordSalt + String(password));
  saveConfig();
}

export function rotateAgentKey() {
  const cfg = config();
  cfg.agentKey = randHex(20);
  saveConfig();
  return cfg.agentKey;
}
