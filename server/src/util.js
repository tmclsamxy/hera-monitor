import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const now = () => Date.now();

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写：先写临时文件再 rename，避免断电/并发导致文件损坏 */
export function writeJSON(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function appendJSONL(file, obj) {
  try {
    fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
  } catch { /* 磁盘满等极端情况不阻断主流程 */ }
}

export function readJSONL(file, { since = 0, until = 0, limit = 0 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (since && o.t < since) continue;
    if (until && o.t > until) continue;
    out.push(o);
  }
  return limit > 0 && out.length > limit ? out.slice(-limit) : out;
}

/** 裁剪时序文件，保留 t >= before 的行 */
export function pruneJSONL(file, before) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const kept = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      if (JSON.parse(line).t >= before) kept.push(line);
    } catch { /* 丢弃损坏行 */ }
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '');
  fs.renameSync(tmp, file);
  return kept.length;
}

export function randHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

export function hmac(str, secret) {
  return crypto.createHmac('sha256', secret).update(str).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function round(n, digits = 1) {
  const p = 10 ** digits;
  return Math.round((Number(n) || 0) * p) / p;
}

const str = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);

/** 清理用户输入的字符串，防止超长/控制字符 */
export function clean(v, max = 200) {
  return str(v, max).trim();
}

export function toBool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

export function bytesToHuman(b) {
  const n = Number(b) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fileSizeSafe(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function mkdirpFor(file) {
  ensureDir(path.dirname(file));
}
