import { listMonitors, recordProbe } from './store.js';
import { probe } from './probe.js';
import { evaluateMonitor } from './alert.js';

const nextRun = new Map();
const running = new Set();
let timer = null;

async function runOne(m) {
  if (running.has(m.id)) return;
  running.add(m.id);
  try {
    const result = await probe(m);
    recordProbe(m, result);
    await evaluateMonitor(m);
  } catch (e) {
    recordProbe(m, {
      ok: false, ms: 0, code: 0, message: e.message || '探测异常',
    });
  } finally {
    running.delete(m.id);
  }
}

function tick() {
  const t = Date.now();
  for (const m of listMonitors()) {
    if (!m.enabled) {
      nextRun.delete(m.id);
      continue;
    }
    const due = nextRun.get(m.id);
    if (due === undefined) {
      nextRun.set(m.id, t + m.interval * 1000);
      runOne(m);
      continue;
    }
    if (t >= due) {
      nextRun.set(m.id, t + m.interval * 1000);
      runOne(m);
    }
  }
}

export function startMonitors() {
  if (timer) return;
  timer = setInterval(tick, 1000);
  timer.unref?.();
  tick();
}

export function stopMonitors() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function runMonitorNow(id) {
  const m = listMonitors().find((x) => x.id === id);
  if (!m) return Promise.resolve(false);
  nextRun.set(m.id, Date.now() + m.interval * 1000);
  return runOne(m).then(() => true);
}
