/* ============================================================
   Hera Monitor - 前端面板
   零依赖：原生 JS + Canvas 手绘图表，不依赖任何 CDN
   ============================================================ */
(() => {
  'use strict';

  /* ---------------------------------------------------------- 基础工具 */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const TOKEN_KEY = 'hera_token';

  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function fmtBytes(n, digits = 1) {
    n = Number(n) || 0;
    if (n < 1024) return `${Math.round(n)} B`;
    const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let i = -1;
    do { n /= 1024; i += 1; } while (n >= 1024 && i < u.length - 1);
    return `${n >= 100 ? Math.round(n) : n.toFixed(digits)} ${u[i]}`;
  }

  const fmtSpeed = (n) => `${fmtBytes(n)}/s`;

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    if (m > 0) return `${m} 分钟`;
    return `${sec} 秒`;
  }

  function timeAgo(ts) {
    if (!ts) return '从未';
    const diff = Date.now() - ts;
    if (diff < 0) return '刚刚';
    const s = Math.floor(diff / 1000);
    if (s < 10) return '刚刚';
    if (s < 60) return `${s} 秒前`;
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
  }

  function fmtTime(ts, withSec = false) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    const base = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    return withSec ? `${base}:${p(d.getSeconds())}` : base;
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  const usageClass = (pct) => (pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '');
  const usageTagClass = (pct) => (pct >= 90 ? 'red' : pct >= 75 ? 'amber' : 'green');

  const pctText = (v) => `${(Number(v) || 0).toFixed(1)}%`;

  /* ---------------------------------------------------------- 状态 */

  const S = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    boot: null,
    overview: null,
    route: 'overview',
    detail: null,
    range: '1h',
    charts: [],
    lastDetailFetch: 0,
    search: '',
    group: '',
    sort: 'name',
    filter: 'all',
  };

  /* ---------------------------------------------------------- API */

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* 空响应 */ }
    if (res.status === 401) {
      logout(true);
      throw new Error(data.error || '登录已过期');
    }
    if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  /* ---------------------------------------------------------- 提示 */

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('#toastRoot').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 260);
    }, 2600);
  }

  function confirmBox(msg) {
    return window.confirm(msg);
  }

  /* ---------------------------------------------------------- 模态框 */

  function openModal({
    title, body, footer = '', wide = false, onMount,
  }) {
    closeModal();
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="icon-btn" data-close>
            <svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>`;
    mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
    $$('[data-close]', mask).forEach((b) => b.addEventListener('click', closeModal));
    document.addEventListener('keydown', escClose);
    $('#modalRoot').appendChild(mask);
    if (onMount) onMount(mask);
    return mask;
  }

  function escClose(e) { if (e.key === 'Escape') closeModal(); }

  function closeModal() {
    $$('.modal-mask').forEach((m) => m.remove());
    document.removeEventListener('keydown', escClose);
  }

  function bindCopy(root) {
    $$('[data-copy]', root).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const text = btn.getAttribute('data-copy');
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        toast('已复制到剪贴板', 'ok');
      });
    });
  }

  /* ---------------------------------------------------------- 图表 */

  const CSSVAR = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function niceMax(v) {
    if (v <= 0) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = 10 ** exp;
    const n = v / base;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * base;
  }

  class LineChart {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.height = opts.height || 150;
      this.unit = opts.unit || '';
      this.fixedMax = opts.fixedMax || 0;
      this.series = opts.series || [];
      this.formatValue = opts.formatValue || ((v) => `${v}${this.unit}`);
      this.hover = null;
      canvas.style.height = `${this.height}px`;
      this._bind();
      this._ro = new ResizeObserver(() => this.draw());
      this._ro.observe(canvas);
    }

    setData(series) {
      this.series = series;
      this.draw();
    }

    _bind() {
      const c = this.canvas;
      c.addEventListener('mousemove', (e) => {
        const r = c.getBoundingClientRect();
        this.hover = { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY };
        this.draw();
      });
      c.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
    }

    draw() {
      const { canvas, ctx } = this;
      const w = canvas.clientWidth || canvas.parentElement.clientWidth;
      if (!w) return;
      const dpr = window.devicePixelRatio || 1;
      const h = this.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const padL = 46; const padR = 12; const padT = 12; const padB = 22;
      const iw = w - padL - padR;
      const ih = h - padT - padB;

      const gridColor = CSSVAR('--grid') || '#eee';
      const mutedColor = CSSVAR('--muted') || '#888';
      const textColor = CSSVAR('--text') || '#333';

      const pts = this.series.flatMap((s) => s.values || []);
      const hasData = pts.length > 1;

      if (!hasData) {
        ctx.fillStyle = mutedColor;
        ctx.font = '12px ' + (CSSVAR('--font') || 'sans-serif');
        ctx.textAlign = 'center';
        ctx.fillText('暂无数据', w / 2, h / 2);
        return;
      }

      const tMin = Math.min(...pts.map((p) => p[0]));
      const tMax = Math.max(...pts.map((p) => p[0]));
      let vMax = this.fixedMax;
      if (!vMax) {
        const raw = Math.max(...pts.map((p) => p[1]), 0);
        vMax = niceMax(raw * 1.25);
      }
      const tSpan = Math.max(1, tMax - tMin);

      const X = (t) => padL + ((t - tMin) / tSpan) * iw;
      const Y = (v) => padT + ih - (Math.min(v, vMax) / vMax) * ih;

      // 网格 + Y 轴刻度
      ctx.font = '10.5px ' + (CSSVAR('--font') || 'sans-serif');
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i += 1) {
        const y = padT + (ih * i) / 4;
        ctx.strokeStyle = gridColor;
        ctx.beginPath();
        ctx.moveTo(padL, y + .5);
        ctx.lineTo(w - padR, y + .5);
        ctx.stroke();
        const val = vMax - (vMax * i) / 4;
        ctx.fillStyle = mutedColor;
        ctx.fillText(this._fmtAxis(val), padL - 7, y);
      }

      // X 轴时间
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = mutedColor;
      const ticks = w < 420 ? 3 : 5;
      for (let i = 0; i < ticks; i += 1) {
        const t = tMin + (tSpan * i) / (ticks - 1 || 1);
        const x = X(t);
        const d = new Date(t);
        const label = tSpan < 3 * 3600e3
          ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
          : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}h`;
        ctx.fillText(label, Math.min(Math.max(x, padL + 16), w - padR - 20), padT + ih + 6);
      }

      // 曲线
      for (const s of this.series) {
        const vals = (s.values || []).filter((p) => p && Number.isFinite(p[1]));
        if (vals.length < 2) continue;
        if (s.fill) {
          const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
          grad.addColorStop(0, this._alpha(s.color, .28));
          grad.addColorStop(1, this._alpha(s.color, 0));
          ctx.beginPath();
          ctx.moveTo(X(vals[0][0]), padT + ih);
          for (const p of vals) ctx.lineTo(X(p[0]), Y(p[1]));
          ctx.lineTo(X(vals[vals.length - 1][0]), padT + ih);
          ctx.closePath();
          ctx.fillStyle = grad;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.lineWidth = 1.8;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = s.color;
        vals.forEach((p, i) => {
          const x = X(p[0]);
          const y = Y(p[1]);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      // 悬停
      if (this.hover && this.hover.x >= padL && this.hover.x <= w - padR) {
        const t = tMin + ((this.hover.x - padL) / iw) * tSpan;
        let nearest = null;
        let best = Infinity;
        for (const s of this.series) {
          for (const p of (s.values || [])) {
            const d = Math.abs(p[0] - t);
            if (d < best) { best = d; nearest = p[0]; }
          }
        }
        if (nearest != null) {
          const x = X(nearest);
          ctx.strokeStyle = this._alpha(textColor, .28);
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(x, padT);
          ctx.lineTo(x, padT + ih);
          ctx.stroke();
          ctx.setLineDash([]);
          const rows = [];
          for (const s of this.series) {
            const p = (s.values || []).find((q) => q[0] === nearest);
            if (!p) continue;
            ctx.fillStyle = s.color;
            ctx.beginPath();
            ctx.arc(x, Y(p[1]), 3.2, 0, Math.PI * 2);
            ctx.fill();
            rows.push(`<span style="color:${s.color}">●</span> ${esc(s.name)} <b>${esc(this.formatValue(p[1]))}</b>`);
          }
          rows.push(`<span style="color:${mutedColor}">${esc(fmtTime(nearest, true))}</span>`);
          this._tooltip(rows.join('<br>'));
        }
      } else {
        this._hideTooltip();
      }
    }

    _fmtAxis(v) {
      if (this.unit === 'B/s') return fmtBytes(v, 0).replace(' ', '');
      if (v >= 10000) return `${Math.round(v / 1000)}k`;
      if (v >= 100) return String(Math.round(v));
      return v.toFixed(v < 10 ? 1 : 0);
    }

    _alpha(hex, a) {
      let c = String(hex).trim();
      if (c.startsWith('var(')) c = CSSVAR(c.slice(4, -1).trim()) || '#888888';
      if (!c.startsWith('#')) return c;
      if (c.length === 4) c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
      const r = parseInt(c.slice(1, 3), 16);
      const g = parseInt(c.slice(3, 5), 16);
      const b = parseInt(c.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${a})`;
    }

    _tooltip(html) {
      const parent = this.canvas.parentElement;
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      let tip = parent.querySelector('.chart-tip');
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'chart-tip';
        Object.assign(tip.style, {
          position: 'absolute', pointerEvents: 'none', background: 'var(--panel-2)',
          border: '1px solid var(--border)', borderRadius: '8px', padding: '7px 10px',
          fontSize: '11.5px', lineHeight: '1.65', whiteSpace: 'nowrap', zIndex: 10,
          boxShadow: 'var(--shadow)', color: 'var(--text)',
        });
        parent.appendChild(tip);
      }
      tip.innerHTML = html;
      tip.style.display = 'block';
      const pw = parent.clientWidth;
      const tw = tip.offsetWidth;
      let left = this.hover.x + 14;
      if (left + tw > pw - 6) left = this.hover.x - tw - 14;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${Math.max(4, this.hover.y - 10)}px`;
    }

    _hideTooltip() {
      const tip = this.canvas.parentElement.querySelector('.chart-tip');
      if (tip) tip.style.display = 'none';
    }

    destroy() { this._ro?.disconnect(); }
  }

  function destroyCharts() {
    S.charts.forEach((c) => c.destroy());
    S.charts = [];
  }

  /* ---------------------------------------------------------- 登录 */

  function showLogin() {
    $('#loginView').classList.remove('hidden');
    $('#appView').classList.add('hidden');
    closeSSE();
  }

  function showApp() {
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
  }

  function logout(silent) {
    S.token = '';
    localStorage.removeItem(TOKEN_KEY);
    closeSSE();
    showLogin();
    if (!silent) toast('已退出登录');
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginBtn');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#loginPassword').value }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '登录失败');
      S.token = data.token;
      localStorage.setItem(TOKEN_KEY, data.token);
      $('#loginPassword').value = '';
      await boot();
    } catch (err) {
      toast(err.message, 'err');
      $('#loginHint').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '登 录';
    }
  });

  /* ---------------------------------------------------------- SSE */

  let es = null;
  let esTimer = null;

  function closeSSE() {
    if (es) { es.close(); es = null; }
    if (esTimer) { clearTimeout(esTimer); esTimer = null; }
    setLive(false, '未连接');
  }

  function setLive(on, text) {
    const dot = $('#liveDot');
    dot.classList.toggle('on', !!on);
    dot.classList.toggle('off', !on);
    $('#liveText').textContent = text;
  }

  function initSSE() {
    closeSSE();
    es = new EventSource(`/api/stream?token=${encodeURIComponent(S.token)}`);
    es.addEventListener('open', () => setLive(true, '实时连接'));
    es.addEventListener('overview', (e) => {
      try {
        S.overview = JSON.parse(e.data);
        setLive(true, '实时连接');
        onOverview();
      } catch { /* 忽略坏包 */ }
    });
    es.addEventListener('error', () => {
      setLive(false, '重连中…');
      if (es && es.readyState === EventSource.CLOSED) {
        closeSSE();
        esTimer = setTimeout(initSSE, 4000);
      }
    });
  }

  /* ---------------------------------------------------------- 路由 */

  const ROUTES = {
    overview: { title: '概览', render: renderOverview },
    detail: { title: '服务器详情', render: renderDetail },
    monitors: { title: '站点监控', render: renderMonitors },
    alerts: { title: '告警', render: renderAlerts },
    settings: { title: '设置', render: renderSettings },
  };

  function navigate() {
    const hash = location.hash.replace(/^#\/?/, '') || 'overview';
    const [name, id] = hash.split('/');
    const route = ROUTES[name] ? name : 'overview';
    S.route = route;
    if (route === 'detail') S.detail = id;
    destroyCharts();
    $$('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
    $('#pageTitle').textContent = route === 'detail'
      ? (S.overview?.servers.find((s) => s.id === S.detail)?.name || '服务器详情')
      : ROUTES[route].title;
    $('#sidebar').classList.remove('open');
    const view = $('#view');
    view.innerHTML = '';
    ROUTES[route].render(view);
    window.scrollTo({ top: 0 });
  }

  window.addEventListener('hashchange', navigate);

  /* ---------------------------------------------------------- 概览 */

  function filteredServers() {
    let list = [...(S.overview?.servers || [])];
    if (S.search) {
      const q = S.search.toLowerCase();
      list = list.filter((s) => `${s.name} ${s.host?.hostname || ''} ${s.host?.os || ''} ${s.ip} ${(s.tags || []).join(' ')}`
        .toLowerCase().includes(q));
    }
    if (S.group) list = list.filter((s) => s.group === S.group);
    if (S.filter === 'online') list = list.filter((s) => s.online);
    if (S.filter === 'offline') list = list.filter((s) => !s.online);
    if (S.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    if (S.sort === 'cpu') list.sort((a, b) => (b.sample?.cpu || 0) - (a.sample?.cpu || 0));
    if (S.sort === 'mem') list.sort((a, b) => (b.sample?.mem || 0) - (a.sample?.mem || 0));
    if (S.sort === 'disk') list.sort((a, b) => (b.sample?.diskPct || 0) - (a.sample?.diskPct || 0));
    if (S.sort === 'offline') list.sort((a, b) => Number(a.online) - Number(b.online));
    return list;
  }

  function metricBar(key, label, pct, extra = '') {
    const v = Number(pct) || 0;
    return `
      <div class="metric"${extra ? ` title="${esc(extra)}"` : ''}>
        <div class="m-top">
          <span class="m-key">${esc(label)}</span>
          <span class="m-val">${esc(pctText(v))}</span>
        </div>
        <div class="bar"><i class="${usageClass(v)}" style="width:${Math.min(100, v).toFixed(1)}%"></i></div>
      </div>`;
  }

  function serverCard(s) {
    const sm = s.sample;
    const os = s.host?.os || '未知系统';
    const tags = [
      s.region ? `<span class="tag accent">${esc(s.region)}</span>` : '',
      ...(s.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`),
      s.group && s.group !== '默认' ? `<span class="tag">${esc(s.group)}</span>` : '',
    ].filter(Boolean).join('');

    if (!sm) {
      return `
        <div class="server-card offline" data-id="${esc(s.id)}">
          <div class="sc-head">
            <span class="status-dot off"></span>
            <span class="sc-name">${esc(s.name)}</span>
          </div>
          <div class="sc-os">${esc(os)}</div>
          <div class="muted small" style="padding:14px 0">尚未收到该服务器的上报数据</div>
        </div>`;
    }

    const loadPct = s.host?.cpuCores ? (sm.load / s.host.cpuCores) * 100 : Math.min(100, sm.load * 25);

    return `
      <div class="server-card ${s.online ? '' : 'offline'}" data-id="${esc(s.id)}">
        <div class="sc-head">
          <span class="status-dot ${s.online ? 'on' : 'off'}"></span>
          <span class="sc-name" title="${esc(s.name)}">${esc(s.name)}</span>
          <span class="grow"></span>
          ${tags}
        </div>
        <div class="sc-os" title="${esc(os)} ${esc(s.host?.arch || '')}">
          ${esc(os)} · ${esc(s.host?.arch || '')} · ${s.host?.cpuCores || '?'} 核
        </div>
        <div class="sc-metrics">
          ${metricBar('cpu', 'CPU', sm.cpu, `已用 ${pctText(sm.cpu)}`)}
          ${metricBar('mem', '内存', sm.mem, s.memTotal ? `${fmtBytes(s.memUsed || (sm.mem / 100) * s.memTotal)} / ${fmtBytes(s.memTotal)}` : '')}
          ${metricBar('disk', '硬盘', sm.diskPct, s.diskTotal ? `${fmtBytes((sm.diskPct / 100) * s.diskTotal)} / ${fmtBytes(s.diskTotal)}` : '')}
          ${metricBar('load', '负载', loadPct, `1 分钟负载 ${sm.load.toFixed(2)}${s.host?.cpuCores ? ` / ${s.host.cpuCores} 核` : ''}`)}
        </div>
        <div class="sc-foot">
          <span class="net down"><span class="arw">↓</span>${esc(fmtSpeed(sm.rxs))}</span>
          <span class="net up"><span class="arw">↑</span>${esc(fmtSpeed(sm.txs))}</span>
          <span class="grow"></span>
          <span title="已运行 ${esc(fmtDuration(sm.uptime))}">
            ${s.online ? `运行 ${esc(fmtDuration(sm.uptime))}` : `失联 ${esc(timeAgo(s.lastSeen))}`}
          </span>
        </div>
        <div class="sc-menu">
          <button class="icon-btn" data-edit="${esc(s.id)}" title="编辑">
            <svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>
          </button>
        </div>
      </div>`;
  }

  function overviewSkeleton() {
    return `<div class="server-grid">${Array.from({ length: 6 }).map(() => `
      <div class="server-card skeleton">
        <div class="skeleton-block" style="height:15px;width:45%;margin-bottom:10px"></div>
        <div class="skeleton-block" style="height:11px;width:65%;margin-bottom:16px"></div>
        <div class="skeleton-block" style="height:34px;margin-bottom:12px"></div>
        <div class="skeleton-block" style="height:11px;width:80%"></div>
      </div>`).join('')}</div>`;
  }

  function renderOverview(view) {
    const ov = S.overview;
    if (!ov) {
      view.innerHTML = overviewSkeleton();
      return;
    }
    const st = ov.stats;
    const groups = [...new Set(ov.servers.map((s) => s.group).filter(Boolean))].sort();

    view.innerHTML = `
      <div class="stat-row">
        <div class="stat"><div class="k">服务器总数</div><div class="v">${st.total}</div></div>
        <div class="stat"><div class="k">在线</div><div class="v" style="color:var(--green)">${st.online}</div></div>
        <div class="stat"><div class="k">离线</div><div class="v" style="color:${st.offline ? 'var(--red)' : 'var(--muted)'}">${st.offline}</div></div>
        <div class="stat"><div class="k">站点监控</div><div class="v">${st.monitors}<small>项</small></div></div>
        <div class="stat"><div class="k">异常监控</div><div class="v" style="color:${st.monitorsDown ? 'var(--red)' : 'var(--muted)'}">${st.monitorsDown}</div></div>
      </div>

      <div class="toolbar">
        <input class="search" id="ovSearch" placeholder="搜索名称 / IP / 系统 / 标签" value="${esc(S.search)}">
        <select id="ovGroup">
          <option value="">全部分组</option>
          ${groups.map((g) => `<option value="${esc(g)}" ${S.group === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}
        </select>
        <select id="ovFilter">
          ${[['all', '全部状态'], ['online', '仅在线'], ['offline', '仅离线']].map(([v, l]) => `<option value="${v}" ${S.filter === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select id="ovSort">
          ${[['name', '按名称'], ['cpu', '按 CPU'], ['mem', '按内存'], ['disk', '按硬盘'], ['offline', '离线优先']].map(([v, l]) => `<option value="${v}" ${S.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <span class="grow"></span>
        <button class="btn btn-primary btn-sm" id="addServerBtn">+ 接入新服务器</button>
      </div>

      ${ov.servers.length === 0 ? `
        <div class="empty">
          <h3>还没有服务器接入</h3>
          <p>在目标服务器上执行下面这一行命令即可完成安装并自动接入：</p>
          <div style="max-width:760px;margin:0 auto;text-align:left">
            <div class="code-block">${esc(S.boot?.install?.command || '')}
              <button class="btn btn-sm copy-btn" data-copy="${esc(S.boot?.install?.command || '')}">复制</button>
            </div>
          </div>
        </div>` : '<div id="serverGrid" class="server-grid"></div>'}
    `;

    const draw = () => {
      const grid = $('#serverGrid', view);
      if (!grid) return;
      const list = filteredServers();
      grid.innerHTML = list.length
        ? list.map(serverCard).join('')
        : '<div class="empty" style="grid-column:1/-1"><h3>没有匹配的服务器</h3><p>换个搜索条件试试</p></div>';
    };
    draw();

    const search = $('#ovSearch', view);
    search.addEventListener('input', () => { S.search = search.value; draw(); });
    $('#ovGroup', view).addEventListener('change', (e) => { S.group = e.target.value; draw(); });
    $('#ovFilter', view).addEventListener('change', (e) => { S.filter = e.target.value; draw(); });
    $('#ovSort', view).addEventListener('change', (e) => { S.sort = e.target.value; draw(); });
    $('#addServerBtn', view).addEventListener('click', showInstallModal);

    view.addEventListener('click', (e) => {
      const editBtn = e.target.closest('[data-edit]');
      if (editBtn) {
        e.stopPropagation();
        editServer(editBtn.dataset.edit);
        return;
      }
      const card = e.target.closest('.server-card');
      if (card && card.dataset.id) location.hash = `#/detail/${card.dataset.id}`;
    });

    bindCopy(view);
  }

  /* ------------------------------------------------- 接入新服务器弹窗 */

  function showInstallModal() {
    const cmd = S.boot?.install?.command || '';
    const key = S.boot?.config?.agentKey || '';
    openModal({
      title: '接入新服务器',
      wide: true,
      body: `
        <p class="muted small" style="margin:0 0 14px;line-height:1.7">
          在目标服务器上以 <b>root</b> 身份执行以下命令，Agent 会自动安装为系统服务并立即开始上报。
          支持任何主流的 Linux 发行版（Debian/Ubuntu/CentOS/RHEL/Alpine/Arch…）。
        </p>
        <div class="code-block" style="margin-bottom:16px">${esc(cmd)}
          <button class="btn btn-sm copy-btn" data-copy="${esc(cmd)}">复制</button>
        </div>
        <div class="field">
          <span>Agent 密钥</span>
          <div class="code-block" style="padding-right:14px">${esc(key)}</div>
        </div>
        <div class="info-grid" style="margin-top:14px">
          <div class="info-item"><span class="k">上报间隔</span><span class="v">${esc(S.boot?.config?.settings?.interval || 30)} 秒</span></div>
          <div class="info-item"><span class="k">面板地址</span><span class="v">${esc(S.boot?.install?.baseUrl || '')}</span></div>
          <div class="info-item"><span class="k">卸载命令</span><span class="v">--uninstall</span></div>
        </div>
        <p class="muted small" style="margin:16px 0 0;line-height:1.7">
          自定义名称 / 地区：在命令末尾追加 <code>--name 我的服务器 --region HK</code><br>
          卸载：把命令里的参数换成 <code>--uninstall</code> 重新执行一次即可
        </p>`,
      footer: '<button class="btn" data-close>关闭</button>',
      onMount: (m) => bindCopy(m),
    });
  }

  function editServer(id) {
    const s = S.overview?.servers.find((x) => x.id === id);
    if (!s) return;
    const groups = [...new Set(S.overview.servers.map((x) => x.group).filter(Boolean))];
    openModal({
      title: '编辑服务器',
      body: `
        <div class="form-row">
          <label class="field"><span>显示名称</span><input id="edName" value="${esc(s.name)}"></label>
          <label class="field"><span>分组</span>
            <input id="edGroup" value="${esc(s.group)}" list="groupList">
            <datalist id="groupList">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
          </label>
          <label class="field"><span>地区标签</span><input id="edRegion" value="${esc(s.region || '')}" placeholder="如 CN / HK / JP"></label>
          <label class="field"><span>标签（逗号分隔）</span><input id="edTags" value="${esc((s.tags || []).join(','))}" placeholder="生产,高防"></label>
          <label class="field"><span>价格（元/月）</span><input id="edPrice" type="number" step="0.01" value="${esc(s.price || '')}"></label>
          <label class="field"><span>到期日</span><input id="edExpire" type="date" value="${esc(s.expireAt || '')}"></label>
        </div>
        <label class="field" style="margin-bottom:0"><span>备注</span><textarea id="edNote" rows="2">${esc(s.note || '')}</textarea></label>`,
      footer: `
        <button class="btn btn-danger" id="edDelete">删除服务器</button>
        <span class="grow"></span>
        <button class="btn" data-close>取消</button>
        <button class="btn btn-primary" id="edSave">保存</button>`,
      onMount: (m) => {
        $('#edSave', m).addEventListener('click', async () => {
          try {
            await api(`/api/servers/${id}`, {
              method: 'POST',
              body: {
                name: $('#edName', m).value,
                group: $('#edGroup', m).value,
                region: $('#edRegion', m).value,
                tags: $('#edTags', m).value.split(',').map((x) => x.trim()).filter(Boolean),
                price: $('#edPrice', m).value,
                expireAt: $('#edExpire', m).value,
                note: $('#edNote', m).value,
              },
            });
            toast('已保存', 'ok');
            closeModal();
            refreshBoot();
          } catch (e) { toast(e.message, 'err'); }
        });
        $('#edDelete', m).addEventListener('click', async () => {
          if (!confirmBox(`确定要删除「${s.name}」吗？该服务器的历史数据也会一并删除。`)) return;
          try {
            await api(`/api/servers/${id}`, { method: 'DELETE' });
            toast('已删除', 'ok');
            closeModal();
            if (S.route === 'detail') location.hash = '#/overview';
            refreshBoot();
          } catch (e) { toast(e.message, 'err'); }
        });
      },
    });
  }

  /* ---------------------------------------------------------- 详情 */

  const RANGE_LABELS = [['5m', '5 分钟'], ['1h', '1 小时'], ['6h', '6 小时'], ['24h', '24 小时'], ['7d', '7 天']];

  function renderDetail(view) {
    const s = S.overview?.servers.find((x) => x.id === S.detail);
    if (!s) {
      view.innerHTML = '<div class="empty"><h3>服务器不存在</h3><p>它可能已被删除</p><a class="btn" href="#/overview">返回概览</a></div>';
      return;
    }
    const host = s.host || {};
    const sm = s.sample || {};
    view.innerHTML = `
      <div class="detail-head">
        <div class="grow">
          <h3>
            <span class="status-dot ${s.online ? 'on' : 'off'}" style="vertical-align:middle"></span>
            ${esc(s.name)}
            <span class="tag ${s.online ? 'green' : 'red'}" style="margin-left:6px">${s.online ? '在线' : '离线'}</span>
            ${s.region ? `<span class="tag accent">${esc(s.region)}</span>` : ''}
            ${(s.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
          </h3>
          <div class="detail-meta">
            <span>${esc(host.os || '—')} · ${esc(host.arch || '')}</span>
            <span>内核 ${esc(host.kernel || '—')}</span>
            <span>IP ${esc(s.ip || '—')}</span>
            <span>分组 ${esc(s.group || '默认')}</span>
            <span>最后上报 ${esc(timeAgo(s.lastSeen))}</span>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <div class="range-tabs" id="rangeTabs">
            ${RANGE_LABELS.map(([v, l]) => `<button data-range="${v}" class="${S.range === v ? 'active' : ''}">${l}</button>`).join('')}
          </div>
          <button class="btn btn-sm" id="backBtn">返回</button>
        </div>
      </div>

      <div class="chart-grid" id="charts">
        <div class="chart-box">
          <div class="cb-head"><span class="cb-title">CPU 使用率</span><span class="cb-now" id="nowCpu"></span></div>
          <canvas id="chartCpu"></canvas>
        </div>
        <div class="chart-box">
          <div class="cb-head"><span class="cb-title">内存使用率</span><span class="cb-now" id="nowMem"></span></div>
          <canvas id="chartMem"></canvas>
        </div>
        <div class="chart-box">
          <div class="cb-head"><span class="cb-title">网络速率</span><span class="cb-now" id="nowNet"></span></div>
          <canvas id="chartNet"></canvas>
        </div>
        <div class="chart-box">
          <div class="cb-head"><span class="cb-title">系统负载（1 分钟）</span><span class="cb-now" id="nowLoad"></span></div>
          <canvas id="chartLoad"></canvas>
        </div>
        <div class="chart-box">
          <div class="cb-head"><span class="cb-title">硬盘使用率</span><span class="cb-now" id="nowDisk"></span></div>
          <canvas id="chartDisk"></canvas>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:14px;margin-top:14px">
        <div class="card">
          <div class="card-head"><h3>主机信息</h3></div>
          <div class="card-body" id="hostInfo"></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>磁盘分区</h3></div>
          <div class="card-body tbl-wrap" id="diskTable"></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>网卡</h3></div>
          <div class="card-body tbl-wrap" id="netTable"></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>流量与备注</h3></div>
          <div class="card-body" id="trafficInfo"></div>
        </div>
      </div>`;

    $('#backBtn', view).addEventListener('click', () => { location.hash = '#/overview'; });
    $$('#rangeTabs button', view).forEach((b) => b.addEventListener('click', () => {
      S.range = b.dataset.range;
      $$('#rangeTabs button', view).forEach((x) => x.classList.toggle('active', x === b));
      fetchMetrics();
    }));

    updateDetailPanels(s);
    initDetailCharts();
    fetchMetrics();
  }

  const COLOR = { cpu: '#4f8cff', mem: '#22c55e', netIn: '#06b6d4', netOut: '#a855f7', load: '#f59e0b', disk: '#ef4444' };

  function initDetailCharts() {
    destroyCharts();
    S.charts = [
      new LineChart($('#chartCpu'), {
        height: 160, unit: '%', fixedMax: 100,
        series: [{ name: 'CPU', color: COLOR.cpu, fill: true, values: [] }],
      }),
      new LineChart($('#chartMem'), {
        height: 160, unit: '%', fixedMax: 100,
        series: [{ name: '内存', color: COLOR.mem, fill: true, values: [] }],
      }),
      new LineChart($('#chartNet'), {
        height: 160, unit: 'B/s', formatValue: fmtSpeed,
        series: [
          { name: '下行', color: COLOR.netIn, fill: true, values: [] },
          { name: '上行', color: COLOR.netOut, values: [] },
        ],
      }),
      new LineChart($('#chartLoad'), {
        height: 160, unit: '',
        series: [{ name: '负载', color: COLOR.load, fill: true, values: [] }],
      }),
      new LineChart($('#chartDisk'), {
        height: 160, unit: '%', fixedMax: 100,
        series: [{ name: '硬盘', color: COLOR.disk, fill: true, values: [] }],
      }),
    ];
  }

  async function fetchMetrics() {
    if (!S.detail || !S.charts.length) return;
    try {
      const res = await api(`/api/metrics?id=${encodeURIComponent(S.detail)}&range=${S.range}&points=240`);
      const pts = res.data.points || [];
      S.lastDetailFetch = Date.now();
      const mk = (key) => pts.map((p) => [p.t, Number(p[key]) || 0]);
      S.charts[0].setData([{ name: 'CPU', color: COLOR.cpu, fill: true, values: mk('cpu') }]);
      S.charts[1].setData([{ name: '内存', color: COLOR.mem, fill: true, values: mk('mem') }]);
      S.charts[2].setData([
        { name: '下行', color: COLOR.netIn, fill: true, values: mk('rxs') },
        { name: '上行', color: COLOR.netOut, values: mk('txs') },
      ]);
      S.charts[3].setData([{ name: '负载', color: COLOR.load, fill: true, values: mk('load') }]);
      S.charts[4].setData([{
        name: '硬盘',
        color: COLOR.disk,
        fill: true,
        values: pts.map((p) => [p.t, p.diskTotal ? (p.diskUsed / p.diskTotal) * 100 : 0]),
      }]);

      const cur = (k) => (pts.length ? Number(pts[pts.length - 1][k]) || 0 : 0);
      $('#nowCpu').textContent = `${cur('cpu').toFixed(1)}%`;
      $('#nowMem').textContent = `${cur('mem').toFixed(1)}%`;
      $('#nowNet').textContent = `↓ ${fmtSpeed(cur('rxs'))}  ↑ ${fmtSpeed(cur('txs'))}`;
      $('#nowLoad').textContent = cur('load').toFixed(2);
      const last = pts[pts.length - 1];
      $('#nowDisk').textContent = last?.diskTotal ? `${((last.diskUsed / last.diskTotal) * 100).toFixed(1)}%` : '—';
      $('#nowDisk').title = `区间流量：↓ ${fmtBytes(res.data.total.rx)} ↑ ${fmtBytes(res.data.total.tx)}`;
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function updateDetailPanels(s) {
    const host = s.host || {};
    const sm = s.sample || {};
    const up = host.cpuCores ? `${host.cpuCores} 核` : '—';
    $('#hostInfo').innerHTML = [
      ['主机名', host.hostname || '—'],
      ['操作系统', host.os || '—'],
      ['架构 / 内核', `${host.arch || '—'} / ${host.kernel || '—'}`],
      ['CPU 型号', host.cpuModel || '—'],
      ['CPU 核心', up],
      ['虚拟化', host.virt || '—'],
      ['运行时长', fmtDuration(sm.uptime)],
      ['进程数', sm.procs ?? '—'],
      ['TCP 连接', sm.tcp ?? '—'],
      ['Agent 版本', s.agentVersion || '—'],
      ['接入时间', fmtDate(s.createdAt)],
      ['到期日', s.expireAt || '—'],
    ].map(([k, v]) => `<div class="info-item"><span class="k">${esc(k)}</span><span class="v" title="${esc(v)}">${esc(v)}</span></div>`).join('');

    $('#diskTable').innerHTML = (s.disks || []).length
      ? `<table class="tbl"><thead><tr><th>挂载点</th><th>设备</th><th>已用 / 总量</th><th style="width:120px">使用率</th></tr></thead><tbody>
          ${s.disks.map((d) => `<tr>
            <td>${esc(d.mount)}</td>
            <td class="muted">${esc(d.fs)}</td>
            <td class="nowrap">${fmtBytes(d.used)} / ${fmtBytes(d.total)}</td>
            <td><div class="bar" style="margin-bottom:4px"><i class="${usageClass(d.pct)}" style="width:${Math.min(100, d.pct)}%"></i></div>
              <span class="small muted">${d.pct.toFixed(1)}%</span></td>
          </tr>`).join('')}
        </tbody></table>`
      : '<p class="muted small" style="margin:0">暂无磁盘信息</p>';

    $('#netTable').innerHTML = (s.net || []).length
      ? `<table class="tbl"><thead><tr><th>网卡</th><th>累计接收</th><th>累计发送</th></tr></thead><tbody>
          ${s.net.map((n) => `<tr><td>${esc(n.iface)}</td><td class="nowrap">${fmtBytes(n.rx)}</td><td class="nowrap">${fmtBytes(n.tx)}</td></tr>`).join('')}
        </tbody></table>`
      : '<p class="muted small" style="margin:0">暂无网卡信息</p>';

    $('#trafficInfo').innerHTML = `
      <div class="info-item"><span class="k">当前下行</span><span class="v">${esc(fmtSpeed(sm.rxs))}</span></div>
      <div class="info-item"><span class="k">当前上行</span><span class="v">${esc(fmtSpeed(sm.txs))}</span></div>
      <div class="info-item"><span class="k">面板累计接收</span><span class="v">${esc(fmtBytes(s.totalRx))}</span></div>
      <div class="info-item"><span class="k">面板累计发送</span><span class="v">${esc(fmtBytes(s.totalTx))}</span></div>
      <div class="info-item"><span class="k">月价格</span><span class="v">${s.price ? `¥ ${esc(s.price)}` : '—'}</span></div>
      <div class="info-item" style="border-bottom:0"><span class="k">备注</span><span class="v">${esc(s.note || '—')}</span></div>`;
  }

  /* ------------------------------------------------------ 站点监控 */

  function monitorItem(m) {
    const spark = (m.history || []).slice(-60)
      .map((h) => `<i class="${h.ok ? '' : 'bad'}" style="height:${h.ok ? 8 + Math.min(14, (1 - Math.min(1, h.ms / 2000)) * 14) : 22}px"></i>`)
      .join('');
    const status = m.ok === null ? '<span class="tag">等待检测</span>'
      : m.ok ? '<span class="tag green">正常</span>' : '<span class="tag red">异常</span>';
    return `
      <div class="monitor-item" data-id="${esc(m.id)}">
        <span class="status-dot ${m.ok === null ? 'idle' : m.ok ? 'on' : 'off'}"></span>
        <div class="mi-main">
          <div class="mi-name">${esc(m.name)} ${status}
            <span class="tag">${esc(String(m.type).toUpperCase())}</span>
            ${m.enabled ? '' : '<span class="tag amber">已暂停</span>'}
          </div>
          <div class="mi-target">${esc(m.target)}</div>
        </div>
        <div class="spark" title="最近 60 次探测">${spark}</div>
        <div class="mi-stat">
          <div>延迟 <b>${m.ms ? `${m.ms} ms` : '—'}</b></div>
          <div class="muted">24h 可用率 ${m.uptime24 == null ? '—' : `${m.uptime24}%`}</div>
        </div>
        <div class="mi-stat muted small" style="min-width:96px;text-align:right">
          ${esc(m.lastCheck ? timeAgo(m.lastCheck) : '从未检测')}
          ${m.message && !m.ok ? `<div style="color:var(--red)">${esc(m.message.slice(0, 40))}</div>` : ''}
        </div>
        <div style="display:flex;gap:4px">
          <button class="btn btn-sm" data-check="${esc(m.id)}">检测</button>
          <button class="btn btn-sm" data-toggle="${esc(m.id)}">${m.enabled ? '暂停' : '启用'}</button>
          <button class="btn btn-sm btn-danger" data-del="${esc(m.id)}">删除</button>
        </div>
      </div>`;
  }

  function renderMonitors(view) {
    const list = S.overview?.monitors || [];
    view.innerHTML = `
      <div class="toolbar">
        <span class="muted small">共 ${list.length} 项，正常 ${list.filter((m) => m.ok).length} 项</span>
        <span class="grow"></span>
        <button class="btn btn-primary btn-sm" id="addMonitorBtn">+ 添加监控</button>
      </div>
      ${list.length ? `<div class="monitor-list" id="monitorList">${list.map(monitorItem).join('')}</div>`
    : '<div class="empty"><h3>还没有站点监控</h3><p>添加 HTTP / TCP 监控，及时发现站点或端口异常</p><button class="btn btn-primary" id="addMonitorBtn2">+ 添加监控</button></div>'}`;

    const addBtn = $('#addMonitorBtn', view) || $('#addMonitorBtn2', view);
    addBtn?.addEventListener('click', showAddMonitor);

    view.addEventListener('click', async (e) => {
      const check = e.target.closest('[data-check]');
      const toggle = e.target.closest('[data-toggle]');
      const del = e.target.closest('[data-del]');
      if (check) {
        check.disabled = true;
        try {
          await api(`/api/monitors/${check.dataset.check}/check`, { method: 'POST' });
          toast('检测完成', 'ok');
        } catch (err) { toast(err.message, 'err'); } finally { check.disabled = false; }
        return;
      }
      if (toggle) {
        const m = list.find((x) => x.id === toggle.dataset.toggle);
        await api(`/api/monitors/${m.id}`, { method: 'POST', body: { enabled: !m.enabled } });
        return;
      }
      if (del && confirmBox('确定删除该监控项吗？')) {
        await api(`/api/monitors/${del.dataset.del}`, { method: 'DELETE' });
        toast('已删除', 'ok');
      }
    });
  }

  function showAddMonitor() {
    openModal({
      title: '添加站点监控',
      body: `
        <label class="field"><span>名称</span><input id="mtName" placeholder="例如：官网首页"></label>
        <div class="form-row">
          <label class="field"><span>类型</span>
            <select id="mtType">
              <option value="http">HTTP / HTTPS</option>
              <option value="tcp">TCP 端口</option>
            </select>
          </label>
          <label class="field"><span>检测间隔（秒）</span><input id="mtInterval" type="number" value="60" min="10"></label>
        </div>
        <label class="field"><span>目标 <span class="req">*</span></span>
          <input id="mtTarget" placeholder="https://example.com  或  1.2.3.4:443">
        </label>
        <div class="form-row">
          <label class="field"><span>超时（秒）</span><input id="mtTimeout" type="number" value="10" min="1"></label>
          <label class="field"><span>期望状态码（可选）</span><input id="mtExpect" type="number" placeholder="200"></label>
        </div>
        <label class="field" style="margin-bottom:0"><span>响应内容关键字（可选）</span>
          <input id="mtKeyword" placeholder="例如：登录">
        </label>`,
      footer: '<button class="btn" data-close>取消</button><button class="btn btn-primary" id="mtSave">添加</button>',
      onMount: (m) => {
        $('#mtType', m).addEventListener('change', (e) => {
          $('#mtTarget', m).placeholder = e.target.value === 'tcp'
            ? '1.2.3.4:3306'
            : 'https://example.com';
        });
        $('#mtSave', m).addEventListener('click', async () => {
          try {
            await api('/api/monitors', {
              method: 'POST',
              body: {
                name: $('#mtName', m).value,
                type: $('#mtType', m).value,
                target: $('#mtTarget', m).value,
                interval: $('#mtInterval', m).value,
                timeout: $('#mtTimeout', m).value,
                expectCode: $('#mtExpect', m).value,
                keyword: $('#mtKeyword', m).value,
              },
            });
            toast('已添加', 'ok');
            closeModal();
          } catch (e) { toast(e.message, 'err'); }
        });
      },
    });
  }

  /* ---------------------------------------------------------- 告警 */

  function renderAlerts(view) {
    const cfg = S.boot?.config;
    const channels = cfg?.channels || [];
    const rules = cfg?.rules || [];
    const types = S.boot?.channelTypes || [];
    const ruleTypes = S.boot?.ruleTypes || [];
    const events = S.overview?.events || [];

    view.innerHTML = `
      <div class="alert-grid">
        <div class="card">
          <div class="card-head"><h3>通知渠道</h3><span class="grow"></span>
            <button class="btn btn-sm btn-primary" id="addChannelBtn">+ 添加</button></div>
          <div class="card-body" id="channelBox">
            ${channels.length ? channels.map((c) => {
    const t = types.find((x) => x.type === c.type);
    return `
              <div class="ch-item">
                <span class="status-dot ${c.enabled === false ? 'idle' : 'on'}"></span>
                <div>
                  <div class="ci-name">${esc(c.name)}</div>
                  <div class="ci-type">${esc(t?.label || c.type)}</div>
                </div>
                <div class="ci-actions">
                  <button class="btn btn-sm" data-test="${esc(c.id)}">测试</button>
                  <button class="btn btn-sm btn-danger" data-delch="${esc(c.id)}">删除</button>
                </div>
              </div>`;
  }).join('') : '<p class="muted small" style="margin:0">还没有配置通知渠道，告警将无法送达</p>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>告警规则</h3><span class="grow"></span>
            <button class="btn btn-sm btn-primary" id="addRuleBtn">+ 添加</button></div>
          <div class="card-body" id="ruleBox">
            ${rules.length ? rules.map((r) => {
    const t = ruleTypes.find((x) => x.type === r.type);
    const chs = (r.channels || []).map((id) => channels.find((c) => c.id === id)?.name).filter(Boolean);
    const desc = [];
    if (t?.unit && r.threshold) desc.push(`阈值 ≥ ${r.threshold}${t.unit}`);
    if (r.duration) desc.push(`持续 ${r.duration}s`);
    desc.push(`通知：${chs.length ? chs.join('、') : '未选择渠道'}`);
    if (r.serverIds?.length) desc.push(`仅限 ${r.serverIds.length} 台服务器`);
    return `
              <div class="rule-item">
                <div class="ri-head">
                  <span class="status-dot ${r.enabled ? 'on' : 'idle'}"></span>
                  <span class="ri-name">${esc(r.name || t?.label || r.type)}</span>
                  <span class="tag">${esc(t?.label || r.type)}</span>
                  <span class="grow"></span>
                  <button class="btn btn-sm btn-danger" data-delrule="${esc(r.id)}">删除</button>
                </div>
                <div class="ri-desc">${esc(desc.join(' · '))}</div>
              </div>`;
  }).join('') : '<p class="muted small" style="margin:0">还没有告警规则</p>'}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head"><h3>事件日志</h3><span class="grow"></span>
          <button class="btn btn-sm" id="refreshEvents">刷新</button></div>
        <div class="card-body event-list" id="eventList">
          ${events.length ? events.map(eventItem).join('') : '<p class="muted small" style="margin:0">暂无事件</p>'}
        </div>
      </div>`;

    $('#addChannelBtn', view).addEventListener('click', showAddChannel);
    $('#addRuleBtn', view).addEventListener('click', showAddRule);
    $('#refreshEvents', view).addEventListener('click', async () => {
      const r = await api('/api/events?limit=100');
      S.overview.events = r.events;
      $('#eventList', view).innerHTML = r.events.length
        ? r.events.map(eventItem).join('') : '<p class="muted small" style="margin:0">暂无事件</p>';
    });

    view.addEventListener('click', async (e) => {
      const test = e.target.closest('[data-test]');
      const delch = e.target.closest('[data-delch]');
      const delrule = e.target.closest('[data-delrule]');
      if (test) {
        test.disabled = true;
        try {
          await api(`/api/channels/${test.dataset.test}/test`, { method: 'POST' });
          toast('测试消息已发送，请查看接收端', 'ok');
        } catch (err) { toast(`推送失败：${err.message}`, 'err'); } finally { test.disabled = false; }
        return;
      }
      if (delch && confirmBox('确定删除该通知渠道吗？')) {
        await api(`/api/channels/${delch.dataset.delch}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        refreshBoot();
        return;
      }
      if (delrule && confirmBox('确定删除该告警规则吗？')) {
        await api(`/api/rules/${delrule.dataset.delrule}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        refreshBoot();
      }
    });
  }

  const EVENT_TAG = {
    offline: ['red', '离线'], agent: ['green', '接入'], monitor: ['amber', '监控'],
    alert: ['red', '告警'], 'alert-error': ['red', '推送失败'], login: ['', '登录'],
    'login-fail': ['red', '登录失败'], system: ['', '系统'], key: ['amber', '密钥'], password: ['amber', '密码'],
  };

  function eventItem(ev) {
    const [cls, label] = EVENT_TAG[ev.type] || ['', ev.type];
    return `<div class="event-item">
      <span class="ev-time">${esc(fmtTime(ev.t, true))}</span>
      <span class="ev-type"><span class="tag ${cls}">${esc(label)}</span></span>
      <span class="ev-msg">${esc(ev.message)}</span>
    </div>`;
  }

  function showAddChannel() {
    const types = S.boot?.channelTypes || [];
    openModal({
      title: '添加通知渠道',
      body: `
        <div class="form-row">
          <label class="field"><span>名称</span><input id="chName" placeholder="例如：运维群"></label>
          <label class="field"><span>类型</span>
            <select id="chType">${types.map((t) => `<option value="${esc(t.type)}">${esc(t.label)}</option>`).join('')}</select>
          </label>
        </div>
        <div id="chFields"></div>`,
      footer: '<button class="btn" data-close>取消</button><button class="btn btn-primary" id="chSave">添加并发送测试</button>',
      onMount: (m) => {
        const renderFields = () => {
          const t = types.find((x) => x.type === $('#chType', m).value);
          const box = $('#chFields', m);
          box.innerHTML = (t?.fields || []).map((f) => `
            <label class="field"><span>${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</span>
              <input data-k="${esc(f.k)}" placeholder="${esc(f.label)}">
            </label>`).join('');
        };
        $('#chType', m).addEventListener('change', renderFields);
        renderFields();
        $('#chSave', m).addEventListener('click', async () => {
          const cfg = {};
          $$('[data-k]', m).forEach((i) => { if (i.value.trim()) cfg[i.dataset.k] = i.value.trim(); });
          try {
            const res = await api('/api/channels', {
              method: 'POST',
              body: { type: $('#chType', m).value, name: $('#chName', m).value, config: cfg },
            });
            try {
              await api(`/api/channels/${res.channel.id}/test`, { method: 'POST' });
              toast('渠道已添加，测试消息已发送', 'ok');
            } catch (err) {
              toast(`渠道已添加，但测试失败：${err.message}`, 'err');
            }
            closeModal();
            refreshBoot();
          } catch (e) { toast(e.message, 'err'); }
        });
      },
    });
  }

  function showAddRule() {
    const ruleTypes = S.boot?.ruleTypes || [];
    const channels = S.boot?.config?.channels || [];
    const servers = S.overview?.servers || [];
    openModal({
      title: '添加告警规则',
      wide: true,
      body: `
        <div class="form-row">
          <label class="field"><span>规则名称</span><input id="rlName" placeholder="例如：CPU 过高"></label>
          <label class="field"><span>规则类型</span>
            <select id="rlType">${ruleTypes.map((t) => `<option value="${esc(t.type)}" data-unit="${esc(t.unit || '')}" data-def="${esc(t.default ?? '')}">${esc(t.label)}</option>`).join('')}</select>
          </label>
        </div>
        <div class="form-row">
          <label class="field"><span>阈值</span><input id="rlThreshold" type="number" step="any"></label>
          <label class="field"><span>持续时长（秒，0 表示立即）</span><input id="rlDuration" type="number" value="0" min="0"></label>
        </div>
        <div class="field">
          <span>通知渠道 <span class="req">*</span>${channels.length ? '' : '（请先到「通知渠道」添加）'}</span>
          <div class="check-list" id="rlChannels">
            ${channels.map((c) => `<label><input type="checkbox" value="${esc(c.id)}">${esc(c.name)}</label>`).join('') || '<span class="muted small">暂无渠道</span>'}
          </div>
        </div>
        <div class="field" style="margin-bottom:0">
          <span>生效服务器（不选表示全部）</span>
          <div class="check-list" id="rlServers">
            ${servers.map((s) => `<label><input type="checkbox" value="${esc(s.id)}">${esc(s.name)}</label>`).join('') || '<span class="muted small">暂无服务器</span>'}
          </div>
        </div>`,
      footer: '<button class="btn" data-close>取消</button><button class="btn btn-primary" id="rlSave">添加</button>',
      onMount: (m) => {
        const sync = () => {
          const opt = $('#rlType', m).selectedOptions[0];
          $('#rlThreshold', m).value = opt?.dataset.def || '';
          $('#rlThreshold', m).placeholder = opt?.dataset.unit ? `单位 ${opt.dataset.unit}` : '该类型无需阈值';
          $('#rlThreshold', m).disabled = !opt?.dataset.def;
          $('#rlName', m).placeholder = `例如：${opt?.textContent || ''}告警`;
        };
        $('#rlType', m).addEventListener('change', sync);
        sync();
        $$('#rlChannels label, #rlServers label', m).forEach((l) => {
          l.querySelector('input').addEventListener('change', (e) => l.classList.toggle('on', e.target.checked));
        });
        $('#rlSave', m).addEventListener('click', async () => {
          const channelsSel = $$('#rlChannels input:checked', m).map((i) => i.value);
          const serversSel = $$('#rlServers input:checked', m).map((i) => i.value);
          if (!channelsSel.length) { toast('请至少选择一个通知渠道', 'err'); return; }
          try {
            await api('/api/rules', {
              method: 'POST',
              body: {
                name: $('#rlName', m).value,
                type: $('#rlType', m).value,
                threshold: $('#rlThreshold', m).value,
                duration: $('#rlDuration', m).value,
                channels: channelsSel,
                serverIds: serversSel,
              },
            });
            toast('已添加', 'ok');
            closeModal();
            refreshBoot();
          } catch (e) { toast(e.message, 'err'); }
        });
      },
    });
  }

  /* ---------------------------------------------------------- 设置 */

  function renderSettings(view) {
    const cfg = S.boot?.config;
    const st = cfg?.settings || {};
    const cmd = S.boot?.install?.command || '';

    view.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-head"><h3>接入服务器</h3></div>
        <div class="card-body">
          <p class="muted small" style="margin:0 0 12px;line-height:1.7">
            在目标服务器上以 root 执行下面这一行命令，Agent 会自动安装并注册为系统服务，约 3 秒后即可在本面板看到。
          </p>
          <div class="code-block" style="margin-bottom:14px">${esc(cmd)}
            <button class="btn btn-sm copy-btn" data-copy="${esc(cmd)}">复制</button>
          </div>
          <div class="info-grid">
            <div class="info-item"><span class="k">Agent 密钥</span><span class="v mono">${esc(cfg?.agentKey || '')}</span></div>
            <div class="info-item"><span class="k">面板地址</span><span class="v">${esc(S.boot?.install?.baseUrl || '')}</span></div>
          </div>
          <div style="margin-top:14px;display:flex;gap:8px">
            <button class="btn btn-sm" id="copyKeyBtn">复制密钥</button>
            <button class="btn btn-sm btn-danger" id="rotateKeyBtn">重置密钥</button>
          </div>
          <p class="muted small" style="margin:12px 0 0;line-height:1.7">
            重置密钥后，<b>所有已安装的 Agent 都会失效</b>，需要用新密钥重新安装。
          </p>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-head"><h3>面板设置</h3></div>
        <div class="card-body">
          <div class="form-row">
            <label class="field"><span>面板标题</span><input id="stTitle" value="${esc(S.boot?.config?.site?.title || '')}"></label>
            <label class="field"><span>Agent 上报间隔（秒）</span><input id="stInterval" type="number" min="5" max="600" value="${esc(st.interval)}"></label>
            <label class="field"><span>离线判定阈值（秒）</span><input id="stOffline" type="number" min="30" value="${esc(st.offlineThreshold)}"></label>
            <label class="field"><span>数据保留天数</span><input id="stRetention" type="number" min="1" value="${esc(st.retentionDays)}"></label>
            <label class="field"><span>GitHub 仓库（可选）</span><input id="stRepo" placeholder="用户名/hera-monitor" value="${esc(st.repo || '')}"></label>
            <label class="field"><span>面板公网地址（可选）</span><input id="stPublicUrl" placeholder="https://monitor.example.com" value="${esc(st.publicUrl || '')}"></label>
          </div>
          <button class="btn btn-primary btn-sm" id="stSave">保存设置</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>安全</h3></div>
        <div class="card-body">
          <div class="form-row">
            <label class="field"><span>当前密码</span><input id="pwOld" type="password" autocomplete="current-password"></label>
            <label class="field"><span>新密码（至少 6 位）</span><input id="pwNew" type="password" autocomplete="new-password"></label>
          </div>
          <button class="btn btn-primary btn-sm" id="pwSave">修改密码</button>
          <p class="muted small" style="margin:12px 0 0;line-height:1.7">
            Hera Monitor v${esc(cfg?.version || '')} · 首次部署的初始密码见服务端终端输出或 <code>data/initial-password.txt</code>
          </p>
        </div>
      </div>`;

    bindCopy(view);
    $('#copyKeyBtn', view).addEventListener('click', async () => {
      await navigator.clipboard.writeText(cfg?.agentKey || '');
      toast('密钥已复制', 'ok');
    });
    $('#rotateKeyBtn', view).addEventListener('click', async () => {
      if (!confirmBox('重置后所有已安装的 Agent 都会失效，确定继续吗？')) return;
      const r = await api('/api/key/rotate', { method: 'POST' });
      S.boot.config.agentKey = r.agentKey;
      S.boot.install.command = r.install;
      toast('密钥已重置', 'ok');
      refreshBoot();
    });
    $('#stSave', view).addEventListener('click', async () => {
      try {
        await api('/api/settings', {
          method: 'POST',
          body: {
            title: $('#stTitle', view).value,
            interval: $('#stInterval', view).value,
            offlineThreshold: $('#stOffline', view).value,
            retentionDays: $('#stRetention', view).value,
            repo: $('#stRepo', view).value,
            publicUrl: $('#stPublicUrl', view).value,
          },
        });
        toast('设置已保存', 'ok');
        refreshBoot();
      } catch (e) { toast(e.message, 'err'); }
    });
    $('#pwSave', view).addEventListener('click', async () => {
      try {
        await api('/api/password', {
          method: 'POST',
          body: { oldPassword: $('#pwOld', view).value, newPassword: $('#pwNew', view).value },
        });
        toast('密码已修改', 'ok');
        $('#pwOld', view).value = '';
        $('#pwNew', view).value = '';
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  /* ---------------------------------------------------------- 数据刷新 */

  let refreshTimer = null;
  let bootPromise = null;

  function onOverview() {
    if (S.route === 'overview' && S.overview) {
      // 保留筛选条件，只重绘列表
      const view = $('#view');
      const grid = $('#serverGrid', view);
      const st = S.overview.stats;
      if (grid && document.activeElement !== $('#ovSearch', view)) {
        const list = filteredServers();
        grid.innerHTML = list.length
          ? list.map(serverCard).join('')
          : '<div class="empty" style="grid-column:1/-1"><h3>没有匹配的服务器</h3><p>换个搜索条件试试</p></div>';
        const row = $('.stat-row', view);
        if (row) {
          const vals = row.querySelectorAll('.v');
          if (vals.length >= 5) {
            vals[0].textContent = st.total;
            vals[1].textContent = st.online;
            vals[2].textContent = st.offline;
            vals[3].innerHTML = `${st.monitors}<small>项</small>`;
            vals[4].textContent = st.monitorsDown;
          }
        }
      }
    } else if (S.route === 'monitors') {
      const box = $('#monitorList');
      const list = S.overview.monitors || [];
      if (box) box.innerHTML = list.map(monitorItem).join('');
    } else if (S.route === 'detail') {
      const s = S.overview.servers.find((x) => x.id === S.detail);
      if (s) {
        updateDetailPanels(s);
        $('#pageTitle').textContent = s.name;
      }
      if (Date.now() - S.lastDetailFetch > 28000) fetchMetrics();
    }
  }

  async function refreshBoot() {
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
      try {
        const data = await api('/api/bootstrap');
        S.boot = data;
        S.overview = data.overview;
        document.title = `${data.config.site.title || 'Hera Monitor'}`;
        navigate();
      } catch (e) {
        if (S.token) toast(e.message, 'err');
      } finally {
        bootPromise = null;
      }
    })();
    return bootPromise;
  }

  async function boot() {
    showApp();
    await refreshBoot();
    if (!location.search.includes('nosse')) initSSE();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (document.hidden) return;
      if (S.route !== 'detail') return;
      if (Date.now() - S.lastDetailFetch > 28000) fetchMetrics();
    }, 10000);
  }

  /* ---------------------------------------------------------- 交互绑定 */

  $('#logoutBtn').addEventListener('click', () => logout());
  $('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('hera_theme', next);
    setTimeout(() => S.charts.forEach((c) => c.draw()), 30);
  });

  const savedTheme = localStorage.getItem('hera_theme');
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

  /* ---------------------------------------------------------- 启动 */

  if (S.token) {
    boot();
  } else {
    showLogin();
  }
})();
