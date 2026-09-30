/*
 * VOXELPOLIS — manager panels core (VC.panels).
 *
 * Registry, open/toggle/inspect, live refresh loop, per-session window placement memory and the
 * shared widget helpers (VC.panels.util) used by the panel files ui/panels_*.js.
 *
 * PUBLIC API
 *   VC.panels.list                 [{key, name, icon, hotkey}] — the 10 manager windows (HUD buttons, hotkeys)
 *   VC.panels.open(key, {tab})     opens/focuses a panel. Extra keys: 'loans' (budget → Loans tab),
 *                                  'inspector' (re-opens the last inspected target)
 *   VC.panels.toggle(key)          closes if open, else opens
 *   VC.panels.close(key), isOpen(key), refresh(key?) (immediate live update; no key = all, throttled)
 *   VC.panels.inspect(building | {x, z} | null)   opens the inspector (null closes it); sets/clears
 *                                  VC.tools.selectedId; VC.panels.inspected() -> current target
 *   VC.panels.onSelectHook         optional fn(sel) -> true to consume the next bus 'select' (used by
 *                                  the Disasters "pick on map" mode before the inspector sees it)
 *   VC.panels.util                 shared widget helpers (kpi, meter, diverge, pill, seg, slider, spark,
 *                                  keyed lists, chartHover, formatting) for panel files
 * Window ids are the panel keys themselves ('budget', 'inspector', …) so bus 'windowOpened' /
 * 'windowClosed' payloads can be compared to VC.panels.list keys directly.
 * Bus in: select, bldRemove, policyChanged, budgetChanged, loanChanged, overlay, advisor, milestone,
 * achievement, disaster, month, money (refresh), windowClosed. Bus out: sfx {name:'open'|'click'|'policy'}, toast.
 * Hotkeys belong to input.js; a guarded fallback here only fires if nobody else handled the key.
 * Positions are kept in screen px and work with either UI scaling model (CSS zoom or `scale`).
 *
 * PANEL DEFINITIONS (registered at load time by ui/panels_*.js, which load after this file):
 *   VC.panels.defs[key] = { title, icon, width, place: 'left'|'center'|'right', build(p) -> updater }
 *   p = { key, def, win, body, opts, tabs, tabUpd } — build() fills p.body once and returns
 *   updater(force) which runs ~4x per second while the window is open. Updaters change values IN
 *   PLACE (text, bar widths, slider positions) and never rebuild DOM, so a slider being dragged is
 *   never interrupted. Tabbed panels use util.tabs(p, [...]); each tab render(c, p) returns its own updater.
 */
const h = VC.h, M = VC.M;

/* ------------------------------------------------------------------ */
/* Shared helpers — VC.panels.util (U)                                 */
/* ------------------------------------------------------------------ */
const U = {};
U.h = h;
/** Runs fn, returning fb when it throws or yields null/undefined. */
U.safe = (fn, fb) => {
  try {
    const v = fn();
    return v == null ? fb : v;
  } catch (e) {
    return fb;
  }
};
/** Calls VC[mod][fn](...args) if it exists, else returns fb. */
U.api = (mod, fn, args, fb) => {
  const m = VC[mod];
  if (!m || typeof m[fn] !== 'function') return fb;
  return U.safe(() => m[fn].apply(m, args || []), fb);
};
U.num = (v, fb = 0) => (typeof v === 'number' && isFinite(v) ? v : fb);
/** Normalizes a stat that may be 0..1, 0..100 or 0..255 into 0..1. */
U.n01 = (v) => {
  v = U.num(v, 0);
  if (v <= 1.5) return M.sat(v);
  if (v <= 100) return v / 100;
  return M.sat(v / 255);
};
/* Change-checked DOM writes (avoid layout thrash in 4 Hz refreshes). */
U.txt = (el, s) => {
  s = s == null ? '' : String(s);
  if (el._t !== s) {
    el._t = s;
    el.textContent = s;
  }
};
U.html = (el, s) => {
  if (el._h !== s) {
    el._h = s;
    el.innerHTML = s;
  }
};
U.css = (el, prop, v) => {
  const k = '_c_' + prop;
  if (el[k] !== v) {
    el[k] = v;
    el.style[prop] = v;
  }
};
U.attr = (el, name, v) => {
  const k = '_a_' + name;
  if (el[k] !== v) {
    el[k] = v;
    if (v == null) el.removeAttribute(name);
    else el.setAttribute(name, v);
  }
};
/** Sets a tone class t-good / t-warn / t-bad / t-info / t-muted (one at a time). */
U.tone = (el, t) => {
  t = t || '';
  if (el._tone === t) return;
  if (el._tone) el.classList.remove('t-' + el._tone);
  if (t) el.classList.add('t-' + t);
  el._tone = t;
};
U.cls = (el, name, on) => {
  on = !!on;
  const k = '_k_' + name;
  if (el[k] !== on) {
    el[k] = on;
    el.classList.toggle(name, on);
  }
};
U.show = (el, on) => U.css(el, 'display', on ? '' : 'none');

/* Formatting */
U.money = (n) => VC.fmt.money(U.num(n));
/** Signed money with a real minus sign: +$1,200 / −$350. */
U.smoney = (n) => {
  n = U.num(n);
  const r = Math.round(n);
  return (r > 0 ? '+' : r < 0 ? '−' : '') + VC.fmt.money(Math.abs(n));
};
U.pct = (f, d = 0) => (U.num(f) * 100).toFixed(d) + '%';
U.spct = (f, d = 0) => {
  const v = U.num(f) * 100;
  const s = Math.abs(v).toFixed(d);
  return (+s === 0 ? '±' : v > 0 ? '+' : '−') + s + '%';
};
U.int = (n) => VC.fmt.num(U.num(n));
/** Chart axis money format: -$1.2k rather than $-1.2k. */
U.moneyAxis = (v) => (v < 0 ? '-$' : '$') + VC.fmt.short(Math.abs(v));
U.short = (n) => VC.fmt.short(U.num(n));
/** Loan/interest rate given as fraction (0.05) or percent (5). */
U.rate = (r) => {
  r = U.num(r);
  return (r < 0.5 ? r * 100 : r).toFixed(1).replace(/\.0$/, '') + '%';
};
U.stars = (n, max = 3) => '★'.repeat(M.clamp(n | 0, 0, max)) + '☆'.repeat(max - M.clamp(n | 0, 0, max));
U.wealth = (w) => '$'.repeat(M.clamp((w | 0) + 1, 1, 3));
U.WEALTH = ['Low wealth', 'Middle wealth', 'High wealth'];

/* Color ramps (CSS strings) */
U.rampGood = (f) => `hsl(${Math.round(M.sat(f) * 128)}, 78%, 55%)`;
U.rampBad = (f) => `hsl(${Math.round((1 - M.sat(f)) * 128)}, 78%, 55%)`;
U.rampValue = (f) => `hsl(${Math.round(215 - M.sat(f) * 170)}, ${Math.round(60 + M.sat(f) * 30)}%, ${Math.round(52 + M.sat(f) * 8)}%)`;
U.ZCOL = { R: 'var(--R)', C: 'var(--C)', I: 'var(--I)' };
U.ZHEX = { R: '#39d98a', C: '#3fa7ff', I: '#ffc83d' };

/* Ledger categories → [icon, label] */
const CATS = {
  'tax:R': ['🏠', 'Residential taxes'],
  'tax:C': ['🏬', 'Commercial taxes'],
  'tax:I': ['🏭', 'Industrial taxes'],
  tourism: ['📸', 'Tourism'],
  income: ['🎰', 'Venue income'],
  reward: ['🏆', 'Milestone rewards'],
  loan: ['🏦', 'Loans received'],
  roadUpkeep: ['🛣️', 'Road maintenance'],
  policy: ['📜', 'Policies'],
  loanPayment: ['🏦', 'Loan payments'],
  construction: ['🏗️', 'Construction'],
  roads: ['🛣️', 'Road building'],
  zoning: ['🏘️', 'Zoning'],
  demolish: ['🚜', 'Demolition'],
  terraform: ['⛰️', 'Terraforming'],
  trees: ['🌲', 'Tree planting'],
  pline: ['🔌', 'Power lines'],
  misc: ['📦', 'Other'],
};
/** Display order of categories (unknown ones sort after, alphabetically). */
const CAT_ORDER = ['tax:R', 'tax:C', 'tax:I', 'tourism', 'income', 'reward', 'loan'];
for (const d of VC.DEPARTMENTS) CAT_ORDER.push('upkeep:' + d.key);
CAT_ORDER.push('roadUpkeep', 'policy', 'loanPayment', 'construction', 'roads', 'zoning', 'pline', 'demolish', 'terraform', 'trees', 'misc');
U.catInfo = (cat) => {
  // prefer the economy module's own labels (VC.econ.category) so all windows agree
  const e = VC.econ && typeof VC.econ.category === 'function' ? U.safe(() => VC.econ.category(cat), null) : null;
  if (e && e.name && e.name !== cat) return [e.icon || (CATS[cat] ? CATS[cat][0] : '•'), e.name];
  if (CATS[cat]) return CATS[cat];
  if (cat.startsWith('upkeep:')) {
    const d = VC.DEPARTMENTS.find((x) => x.key === cat.slice(7));
    return d ? [d.icon, d.name] : ['🔧', cat.slice(7) + ' upkeep'];
  }
  return ['•', cat.charAt(0).toUpperCase() + cat.slice(1).replace(/[_:]/g, ' ')];
};
U.catRank = (cat) => {
  const i = CAT_ORDER.indexOf(cat);
  return i < 0 ? 1000 : i;
};

/* Modifier keys (VC.MODS / policy effects) → display. good: +1 when an increase is good for the city. */
U.MODS = {
  crime: { icon: '🦹', label: 'Crime', good: -1 },
  fire: { icon: '🔥', label: 'Fire risk', good: -1 },
  pollution: { icon: '🌫️', label: 'Pollution', good: -1 },
  health: { icon: '🩺', label: 'Health', good: 1 },
  education: { icon: '🎓', label: 'Education', good: 1 },
  landValue: { icon: '💎', label: 'Land value', good: 1 },
  happiness: { icon: '😊', label: 'Happiness', good: 1 },
  traffic: { icon: '🚗', label: 'Traffic', good: -1 },
  powerUse: { icon: '⚡', label: 'Power use', good: -1 },
  waterUse: { icon: '💧', label: 'Water use', good: -1 },
  garbage: { icon: '🗑️', label: 'Garbage', good: -1 },
  demandR: { icon: '🏠', label: 'R demand', good: 1 },
  demandC: { icon: '🏬', label: 'C demand', good: 1 },
  demandI: { icon: '🏭', label: 'I demand', good: 1 },
  taxR: { icon: '💰', label: 'R tax income', good: 1 },
  taxC: { icon: '💰', label: 'C tax income', good: 1 },
  taxI: { icon: '💰', label: 'I tax income', good: 1 },
  tourism: { icon: '📸', label: 'Tourism', good: 1 },
  noise: { icon: '🔊', label: 'Noise', good: -1 },
  growth: { icon: '🌱', label: 'Growth', good: 1 },
};
/** Effect chip element for modifier key k with additive value v (fraction). */
U.effectChip = (k, v) => {
  const m = U.MODS[k] || { icon: '•', label: k, good: 1 };
  const good = v * m.good > 0;
  return h('span', { class: 'pn-chip ' + (good ? 't-good' : 't-bad'), 'data-tip': `<b>${m.label}</b> ${U.spct(v)} — ${good ? 'good' : 'bad'} for the city` }, m.icon + ' ' + m.label + ' ' + U.spct(v));
};

/* ------------------------------------------------------------------ */
/* Widgets                                                              */
/* ------------------------------------------------------------------ */
/** Big-number tile. el.set(value, sub, tone) */
U.kpi = (label, o = {}) => {
  const val = h('div', { class: 'pn-kpi-val' }, '—');
  const sub = h('div', { class: 'pn-kpi-sub' });
  const el = h('div', { class: 'pn-kpi ' + (o.cls || ''), 'data-tip': o.tip }, h('div', { class: 'pn-kpi-label' }, o.icon ? h('span', { class: 'pn-kpi-icon' }, o.icon) : null, label), val, sub);
  el.set = (v, s, tone) => {
    U.txt(val, v);
    if (s !== undefined) U.txt(sub, s);
    U.tone(val, tone);
  };
  el.sub = sub;
  el.val = val;
  return el;
};
/**
 * Labelled progress meter. o: {icon, tip, color (css | fn(frac)), mark (0..1 tick), cls, small}
 * el.set(frac, text, color?)
 */
U.meter = (label, o = {}) => {
  const fill = h('i', { class: 'pn-meter-fill' });
  const val = h('span', { class: 'pn-meter-val' });
  const lab = h('span', { class: 'pn-meter-label' }, o.icon ? h('span', { class: 'pn-ic' }, o.icon) : null, label);
  const mark = o.mark != null ? h('b', { class: 'pn-meter-mark', style: { left: o.mark * 100 + '%' } }) : null;
  const el = h('div', { class: 'pn-meter ' + (o.small ? 'small ' : '') + (o.cls || ''), 'data-tip': o.tip }, h('div', { class: 'pn-meter-head' }, lab, val), h('div', { class: 'pn-meter-track' }, fill, mark));
  el.set = (f, text, color) => {
    f = M.sat(U.num(f));
    U.css(fill, 'width', (f * 100).toFixed(1) + '%');
    U.txt(val, text != null ? text : Math.round(f * 100) + '%');
    const c = color || (typeof o.color === 'function' ? o.color(f) : o.color);
    if (c) U.css(fill, 'background', c);
  };
  el.label = lab;
  el.valEl = val;
  el.set(0, '');
  return el;
};
/** Horizontal diverging bar for values in -1..1 (factor breakdowns). el.set(v, text) */
U.diverge = (label, o = {}) => {
  const fill = h('i', { class: 'pn-div-fill' });
  const val = h('span', { class: 'pn-div-val' });
  const lab = h('span', { class: 'pn-div-label' }, label);
  const el = h('div', { class: 'pn-div', 'data-tip': o.tip }, lab, h('div', { class: 'pn-div-track' }, h('b'), fill), val);
  el.set = (v, text) => {
    v = M.clamp(U.num(v), -1, 1);
    U.css(fill, 'left', (v < 0 ? 50 + v * 50 : 50).toFixed(1) + '%');
    U.css(fill, 'width', (Math.abs(v) * 50).toFixed(1) + '%');
    U.tone(fill, v >= 0 ? 'good' : 'bad');
    U.txt(val, text != null ? text : (v > 0.005 ? '+' : v < -0.005 ? '−' : '') + Math.round(Math.abs(v) * 100));
    U.tone(val, v > 0.02 ? 'good' : v < -0.02 ? 'bad' : '');
  };
  el.setLabel = (t) => U.txt(lab, t);
  el.set(0);
  return el;
};
/** Small status pill. el.set(text, tone) */
U.pill = (text, tone, tip) => {
  const el = h('span', { class: 'pn-pill', 'data-tip': tip }, text);
  U.tone(el, tone);
  el.set = (t, tn) => {
    U.txt(el, t);
    U.tone(el, tn);
  };
  return el;
};
/** Segmented control. options [{value, label, tip}] */
U.seg = (options, value, onChange, cls) => {
  const el = h('div', { class: 'pn-seg ' + (cls || '') });
  for (const op of options)
    el.appendChild(
      h('button', { class: 'pn-seg-btn', 'data-v': String(op.value), 'data-tip': op.tip, onclick: () => {
        VC.bus.emit('sfx', { name: 'click' });
        el.set(op.value);
        onChange && onChange(op.value);
      } }, op.label)
    );
  el.set = (v) => {
    for (const b of el.children) U.cls(b, 'on', b.dataset.v === String(v));
  };
  el.set(value);
  return el;
};
/** VC.ui.slider + drag tracking: el.sync(v) moves the knob only while the user is not dragging it. */
U.slider = (o) => {
  const el = VC.ui.slider(o);
  const inp = el.input;
  const up = () => {
    el._drag = false;
  };
  inp.addEventListener('pointerdown', () => {
    el._drag = true;
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  });
  el.sync = (v) => {
    if (el._drag || !isFinite(v)) return;
    if (Math.abs(+inp.value - v) > 1e-6) el.setValue(v);
  };
  return el;
};
/** Empty-state block. */
U.empty = (icon, title, text) => h('div', { class: 'pn-empty' }, h('div', { class: 'pn-empty-icon' }, icon), h('div', { class: 'pn-empty-title' }, title), text ? h('div', { class: 'pn-empty-text' }, text) : null);
U.sec = (title, ...kids) => h('div', { class: 'pn-sec' }, title ? h('div', { class: 'pn-sec-title' }, title) : null, ...kids);
U.card = (cls, ...kids) => h('div', { class: 'pn-card ' + (cls || '') }, ...kids);
/** Two-column label/value line. el.set(value, tone) */
U.line = (label, o = {}) => {
  const v = h('span', { class: 'pn-line-val' }, o.value != null ? o.value : '');
  const el = h('div', { class: 'pn-line', 'data-tip': o.tip }, h('span', { class: 'pn-line-label' }, o.icon ? h('span', { class: 'pn-ic' }, o.icon) : null, label), v);
  el.set = (t, tone) => {
    U.txt(v, t);
    U.tone(v, tone);
  };
  return el;
};
/** Mini line chart (canvas). el.draw(data, {split, color, min, max}) — data after `split` drawn dashed (projection). */
U.spark = (w, hgt) => {
  const dpr = 2;
  const cv = h('canvas', { class: 'pn-spark', width: w * dpr, height: hgt * dpr, style: { width: w + 'px', height: hgt + 'px' } });
  cv.draw = (data, o = {}) => {
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    if (!data || data.length < 2) return;
    let lo = Infinity, hi = -Infinity;
    for (const v of data) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (o.zero) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    if (hi - lo < 1e-9) {
      hi += 1;
      lo -= 1;
    }
    const pad = 6;
    const X = (i) => pad + (i / (data.length - 1)) * (W - pad * 2);
    const Y = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2);
    const split = o.split != null ? o.split : data.length - 1;
    const col = o.color || '#5ad1ff';
    if (lo < 0 && hi > 0) {
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.lineWidth = 2;
      g.setLineDash([4, 6]);
      g.beginPath();
      g.moveTo(0, Y(0));
      g.lineTo(W, Y(0));
      g.stroke();
      g.setLineDash([]);
    }
    // area under the historic part
    g.beginPath();
    for (let i = 0; i <= split; i++) (i ? g.lineTo(X(i), Y(data[i])) : g.moveTo(X(i), Y(data[i])));
    g.lineTo(X(split), H);
    g.lineTo(X(0), H);
    g.closePath();
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, col + '55');
    grd.addColorStop(1, col + '00');
    g.fillStyle = grd;
    g.fill();
    g.lineWidth = 4;
    g.lineJoin = g.lineCap = 'round';
    g.strokeStyle = col;
    g.beginPath();
    for (let i = 0; i <= split; i++) (i ? g.lineTo(X(i), Y(data[i])) : g.moveTo(X(i), Y(data[i])));
    g.stroke();
    if (split < data.length - 1) {
      g.setLineDash([8, 8]);
      g.strokeStyle = o.projColor || col;
      g.beginPath();
      g.moveTo(X(split), Y(data[split]));
      for (let i = split + 1; i < data.length; i++) g.lineTo(X(i), Y(data[i]));
      g.stroke();
      g.setLineDash([]);
      const lx = X(data.length - 1), ly = Y(data[data.length - 1]);
      g.fillStyle = o.projColor || col;
      g.beginPath();
      g.arc(lx, ly, 6, 0, M.PI2);
      g.fill();
    }
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(X(split), Y(data[split]), 5, 0, M.PI2);
    g.fill();
  };
  return cv;
};
/**
 * Keyed list reconciliation: keeps one element per item key inside `box` (a container used only
 * for this list), creating/removing/reordering as needed, and calls update(el, item) on each.
 */
U.keyed = (box, items, keyFn, create, update) => {
  const map = box._km || (box._km = new Map());
  const seen = new Set();
  let prev = null, i = 0;
  for (const it of items) {
    const k = keyFn(it, i++);
    if (seen.has(k)) continue;
    seen.add(k);
    let el = map.get(k);
    if (!el) {
      el = create(it);
      map.set(k, el);
    }
    if (update) update(el, it);
    const want = prev ? prev.nextSibling : box.firstChild;
    if (want !== el) box.insertBefore(el, want);
    prev = el;
  }
  for (const [k, el] of map)
    if (!seen.has(k)) {
      el.remove();
      map.delete(k);
    }
  return map.size;
};
/** Last n samples of S.history[key] (n = 0 → all). Accepts typed arrays. */
U.hist = (key, n) => {
  const S = VC.state;
  const a = S && S.history && S.history[key];
  if (!a || !a.length) return [];
  const arr = Array.isArray(a) ? a : Array.from(a);
  return n ? arr.slice(-n) : arr;
};
/** Redraw signature for history charts: sample count + current month (arrays stop growing once capped). */
U.histSig = (key) => U.histLen(key) + ':' + (VC.state ? Math.floor(VC.state.time.day / VC.C.DAYS_PER_MONTH) : 0);
U.histLen = (key) => {
  const S = VC.state;
  const a = S && S.history && S.history[key];
  return a && a.length ? a.length : 0;
};
/** Moves the camera to a building / tile. */
U.focus = (b, dist) => {
  if (!VC.camera || !VC.camera.focus || !b) return;
  if (b.w) VC.camera.focus(b.x + b.w / 2, b.z + b.d / 2, dist || Math.max(18, Math.min(VC.camera.goal ? VC.camera.goal.dist : 30, 34)));
  else VC.camera.focus(b.x + 0.5, b.z + 0.5, dist);
};
/** Toggle button for a map overlay; call el.sync() in the updater to reflect VC.gfx.overlay. */
U.overlayBtn = (key, label) => {
  const ov = VC.OVERLAYS.find((o) => o.key === key);
  const b = VC.ui.button(label || 'Overlay', () => {
    if (!VC.gfx || !VC.gfx.setOverlay) return;
    VC.gfx.setOverlay(VC.gfx.overlay === key ? 'none' : key);
    b.sync();
  }, { icon: '👁️', cls: 'small pn-ovbtn', tip: ov ? `Toggle the <b>${ov.name}</b> map overlay` : 'Toggle overlay' });
  b.sync = () => U.cls(b, 'on', VC.gfx && VC.gfx.overlay === key);
  b.sync();
  return b;
};
/**
 * Hover readout for a VC.ui.chart element: a vertical guide line plus a tooltip listing every series'
 * value at the hovered sample. Call chartEl.setHover(series, fmt) after each chart.update(series).
 * Matches the framework chart padding (70 / 12 px on the 2x canvas).
 */
U.chartHover = (chartEl) => {
  const cv = chartEl.querySelector('canvas');
  if (!cv) return chartEl;
  chartEl.classList.add('pn-hov');
  const guide = h('i', { class: 'pn-guide' });
  chartEl.appendChild(guide);
  let series = [], fmt = (v) => VC.fmt.short(v), idx = -1;
  const n = () => series.reduce((m, s) => Math.max(m, s.data.length), 0);
  const html = () => {
    const N = n();
    if (idx < 0 || idx >= N) return '';
    const S = VC.state;
    const month = S ? Math.floor(S.time.day / VC.C.DAYS_PER_MONTH) - (N - 1 - idx) : 0;
    let out = `<b>${S ? VC.fmt.date(Math.max(0, month) * VC.C.DAYS_PER_MONTH) : ''}</b>`;
    for (const s of series) {
      const v = s.data[idx - (N - s.data.length)];
      if (v == null) continue;
      out += `<br><span style="color:${s.color}">●</span> ${s.label || 'Value'}: <b>${fmt(v)}</b>`;
    }
    return out;
  };
  cv.addEventListener('pointermove', (e) => {
    const N = n();
    const r = cv.getBoundingClientRect();
    if (N < 2 || !r.width) return;
    const t = M.sat((((e.clientX - r.left) / r.width) * cv.width - 70) / (cv.width - 82));
    idx = Math.round(t * (N - 1));
    const sx = cv.offsetWidth / cv.width, sy = cv.offsetHeight / cv.height;
    guide.style.left = cv.offsetLeft + (70 + (idx / (N - 1)) * (cv.width - 82)) * sx + 'px';
    guide.style.top = cv.offsetTop + 12 * sy + 'px';
    guide.style.height = (cv.height - 34) * sy + 'px';
    guide.style.display = 'block';
    const t2 = html();
    cv.dataset.tip = t2; // shown on enter by the basic framework
    const tip = VC.ui && VC.ui.tip; // keep a visible tooltip in sync while moving
    if (tip && tip.classList && tip.classList.contains('show')) tip.innerHTML = t2;
  });
  cv.addEventListener('pointerleave', () => {
    idx = -1;
    guide.style.display = 'none';
  });
  cv._tip = html; // richer frameworks re-evaluate this while the tooltip is visible
  chartEl.setHover = (s, f) => {
    series = s || [];
    if (f) fmt = f;
  };
  return chartEl;
};
/** Promise-safe call: resolves fn() (sync or async); cb(ok, value, error). */
U.async = (fn, cb) => {
  let r;
  try {
    r = fn();
  } catch (e) {
    cb(false, null, e);
    return;
  }
  Promise.resolve(r).then(
    (v) => cb(v !== false, v, null),
    (e) => cb(false, null, e)
  );
};
/**
 * Per-department catalog building stats — cached on S.ver.bld:
 * { n: {dept: count}, up: {dept: base upkeep $/month at 100% funding}, jobs: {dept: jobs} }
 */
let deptCache = null, deptVer = -1, deptState = null;
U.deptStats = () => {
  const S = VC.state;
  if (!S) return { n: {}, up: {}, jobs: {} };
  if (deptCache && deptVer === S.ver.bld && deptState === S) return deptCache;
  const c = { n: {}, up: {}, jobs: {} };
  for (const b of S.buildings.values()) {
    const def = VC.BLD[b.key];
    if (!def || !def.dept) continue;
    c.n[def.dept] = (c.n[def.dept] || 0) + 1;
    c.up[def.dept] = (c.up[def.dept] || 0) + (def.upkeep || 0);
    c.jobs[def.dept] = (c.jobs[def.dept] || 0) + (def.jobs || 0);
  }
  deptCache = c;
  deptVer = S.ver.bld;
  deptState = S;
  return c;
};
/** Number of road tiles by type — cached on S.ver.terrain. */
let roadCache = null, roadVer = -1, roadState = null;
U.roadCounts = () => {
  const S = VC.state;
  if (!S) return [0, 0, 0, 0];
  if (roadCache && roadVer === S.ver.terrain && roadState === S) return roadCache;
  const c = [0, 0, 0, 0];
  const r = S.road;
  for (let i = 0; i < r.length; i++) if (r[i]) c[r[i] & 3]++;
  roadCache = c;
  roadVer = S.ver.terrain;
  roadState = S;
  return c;
};
/** Current milestone index from peak population (or S.milestone if higher). */
U.milestoneIndex = () => {
  const S = VC.state;
  if (!S) return 0;
  let i = 0;
  for (let k = 0; k < VC.MILESTONES.length; k++) if (S.peakPop >= VC.MILESTONES[k].pop) i = k;
  return Math.max(i, Math.min(VC.MILESTONES.length - 1, S.milestone | 0));
};
/** Tabs bound to a panel: remembers the active tab per panel and routes the tab updater. */
U.tabs = (p, list) => {
  const t = VC.ui.tabs(
    list.map((x) => ({
      key: x.key,
      label: x.label,
      icon: x.icon,
      tip: x.tip,
      render(c) {
        p.tabUpd = null;
        // replay the fade-in on every tab switch (the body element is reused)
        c.classList.remove('pn-tabbody');
        void c.offsetWidth;
        c.classList.add('pn-tabbody');
        const r = x.render(c, p);
        p.tabUpd = typeof r === 'function' ? r : null;
        if (p.tabUpd) runUpd(p, p.tabUpd, true);
      },
    })),
    { active: tabMem[p.key] || (p.opts && p.opts.tab), onChange: (k) => (tabMem[p.key] = k) }
  );
  t.classList.add('pn-tabs');
  p.tabs = t;
  return t;
};

/* ------------------------------------------------------------------ */
/* Registry & window management                                         */
/* ------------------------------------------------------------------ */
const LIST = [
  { key: 'budget', name: 'Budget & Taxes', icon: '💰', hotkey: 'KeyM' },
  { key: 'policies', name: 'Policies', icon: '📜', hotkey: 'KeyP' },
  { key: 'stats', name: 'City Statistics', icon: '📈', hotkey: 'KeyG' },
  { key: 'population', name: 'Population', icon: '👥', hotkey: 'KeyU' },
  { key: 'services', name: 'City Services', icon: '🚓', hotkey: 'KeyV' },
  { key: 'utilities', name: 'Utilities', icon: '⚡', hotkey: 'KeyY' },
  { key: 'advisors', name: 'Advisors', icon: '🧑‍💼', hotkey: 'KeyN' },
  { key: 'milestones', name: 'Milestones', icon: '🏆', hotkey: 'KeyJ' },
  { key: 'disasters', name: 'Disasters', icon: '🌪️', hotkey: 'KeyX' },
  { key: 'save', name: 'Save & Load', icon: '💾', hotkey: 'KeyK' },
];
const defs = {};
const openP = new Map(); // key -> p
const posMem = {}; // key -> {x, y} (CSS px, session only)
const tabMem = {}; // key -> active tab
let acc = 0, dirtyAt = -1, clock = 0;
let inspTarget = null; // last inspected target (building or {x,z})
let lastCall = { key: null, t: -1 }; // last open/toggle call (hotkey de-duplication)

function uiScale() {
  return (VC.settings && +VC.settings.uiScale) || 1;
}
/**
 * CSS zoom applied to a window element (1 when the UI framework scales with the `scale` property,
 * where left/top are plain screen px; with `zoom`, left/top are multiplied by the zoom).
 */
function zoomOf(el) {
  const z = parseFloat(getComputedStyle(el).zoom);
  return z > 0 && Math.abs(z - 1) > 1e-3 ? z : 1;
}
/** Moves a window so its visual top-left corner lands on screen px (x, y). */
function applyPos(el, x, y) {
  const z = zoomOf(el);
  el.style.left = Math.round(x / z) + 'px';
  el.style.top = Math.round(y / z) + 'px';
}
/** Visual top-left of a window in screen px (inverse of applyPos). */
function readPos(el) {
  const z = zoomOf(el);
  return { x: (parseFloat(el.style.left) || 0) * z, y: (parseFloat(el.style.top) || 0) * z };
}
/**
 * Default window position in screen px. Tries the panel's preferred spot, then the other standard
 * spots and "beside an open window", taking the first that does not overlap an open panel;
 * otherwise cascades from the preferred spot. Keeps clear of the HUD top bar and right-hand dock.
 */
function placement(key, def) {
  const s = uiScale();
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min((def.width || 480) * s, vw - 8); // visual width
  const top = Math.round(66 * s + 12);
  const hgt = Math.max(200, vh - top - 110);
  const rects = [];
  for (const p of openP.values()) {
    if (p.key === key || !VC.ui.isOpen(p.key) || p.win.el.style.display === 'none') continue;
    const r = p.win.el.getBoundingClientRect();
    rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  const L = 14, Cx = (vw - w) / 2, R = vw - w - 14 - 58 * s; // right: leave room for the dock
  const xs = def.place === 'right' ? [R, L, Cx] : def.place === 'center' ? [Cx, L, R] : [L, Cx, R];
  for (const r of rects) xs.push(r.x + r.w + 10, r.x - w - 10);
  const free = (x) => !rects.some((r) => x < r.x + r.w && x + w > r.x && top < r.y + r.h && top + hgt > r.y);
  for (const x of xs) if (x >= 4 && x + w <= vw - 4 && free(x)) return { x, y: top };
  // no free spot: cascade from the preferred position
  let x = xs[0], y = top;
  for (let n = 0; n < 6; n++) {
    if (!rects.some((r) => Math.abs(r.x - x) < 12 && Math.abs(r.y - y) < 12)) break;
    x += 28;
    y += 26;
  }
  return { x: Math.max(4, Math.min(x, vw - w - 4)), y: Math.max(4, Math.min(y, vh - 120)) };
}
/** Creates the window for a panel at its remembered or default position (screen px). */
function makeWin(key, def, title, icon) {
  const pos = posMem[key] || placement(key, def);
  const win = VC.ui.window(key, { title, icon, width: def.width || 480, x: 0, y: 0, cls: 'pn-win pn-' + key });
  // keep the whole window on screen (a remembered spot may come from another UI scale / window size)
  const wv = Math.min((def.width || 480) * uiScale(), window.innerWidth - 8);
  applyPos(win.el, M.clamp(pos.x, 4, Math.max(4, window.innerWidth - wv - 4)), M.clamp(pos.y, 4, Math.max(4, window.innerHeight - 80)));
  return win;
}

function runUpd(p, fn, force) {
  try {
    fn(force);
  } catch (e) {
    if ((p.errs = (p.errs || 0) + 1) <= 2) console.warn('[panels] ' + p.key + ' update failed:', e);
  }
}
function refreshPanel(p, force) {
  if (!VC.state) return;
  if (!VC.ui.isOpen(p.key)) {
    openP.delete(p.key);
    return;
  }
  if (p.win.el.style.display === 'none') return;
  if (p.upd) runUpd(p, p.upd, force);
  if (p.tabUpd) runUpd(p, p.tabUpd, force);
}

function build(p) {
  p.body.innerHTML = '';
  p.upd = p.tabUpd = p.tabs = null;
  p.errs = 0;
  if (!VC.state) {
    p.body.appendChild(U.empty('🏙️', 'No city loaded', 'Start or load a city first.'));
    return;
  }
  try {
    const r = p.def.build(p);
    p.upd = typeof r === 'function' ? r : null;
  } catch (e) {
    console.warn('[panels] build failed: ' + p.key, e);
    p.body.appendChild(U.empty('🛠️', 'This panel hit a snag', String((e && e.message) || e)));
  }
  refreshPanel(p, true);
}

function onClosed(key) {
  const p = openP.get(key);
  if (p) {
    posMem[key] = readPos(p.win.el);
    if (p.def.onClose) U.safe(() => p.def.onClose(p));
    openP.delete(key);
  }
}

const P = (VC.panels = {
  list: LIST,
  defs,
  util: U,

  init() {
    VC.bus.on('select', (sel) => {
      if (P.onSelectHook && P.onSelectHook(sel)) return; // e.g. disaster target picking consumed it
      if (!sel) P.inspect(null);
      else P.inspect(sel.building || { x: sel.x, z: sel.z });
    });
    VC.bus.on('bldRemove', (b) => {
      const t = inspTarget;
      if (!t || t.id == null || t.id !== b.id) return;
      // growables that upgrade are replaced in place: follow the successor, otherwise close
      const reason = b.removed;
      setTimeout(() => {
        if (inspTarget !== t) return;
        const nb = (reason === 'upgrade' || reason === 'replace') && VC.world.buildingAt(b.x, b.z);
        if (nb) P.inspect(nb);
        else P.inspect(null);
      }, 0);
    });
    const soon = () => P.refresh();
    for (const ev of ['policyChanged', 'budgetChanged', 'loanChanged', 'overlay', 'advisor', 'milestone', 'achievement', 'disaster', 'month', 'money'])
      VC.bus.on(ev, soon);
    VC.bus.on('windowClosed', (id) => {
      onClosed(id);
      if (id !== 'inspector') return;
      // closing the inspector clears the tool selection highlight
      inspTarget = null;
      if (VC.tools && VC.tools.selectedId) VC.tools.selectedId = 0;
    });
    for (const k in defs) if (defs[k].init) U.safe(() => defs[k].init());
    window.addEventListener('keydown', onHotkey);
  },

  reset(S) {
    inspTarget = null;
    if (VC.ui && VC.ui.closeWindow) VC.ui.closeWindow('inspector');
    for (const k in defs) if (defs[k].reset) U.safe(() => defs[k].reset(S));
    // rebuild open panels against the new state
    for (const p of openP.values()) if (VC.ui.isOpen(p.key)) build(p);
  },

  update(dt, rdt) {
    if (!openP.size || !VC.state) return;
    clock += rdt;
    acc += rdt;
    // regular 4 Hz refresh; bus-triggered refreshes are throttled to ~15 Hz (slider drags)
    const due = acc >= 0.25 || (dirtyAt >= 0 && acc >= 0.066);
    if (!due) return;
    acc = 0;
    dirtyAt = -1;
    for (const p of [...openP.values()]) refreshPanel(p, false);
  },

  /** Requests an immediate live update of one (or every) open panel. */
  refresh(key) {
    if (key) {
      const p = openP.get(key);
      if (p) refreshPanel(p, true);
      return;
    }
    if (dirtyAt < 0) dirtyAt = clock;
  },

  isOpen: (key) => openP.has(key) && !!(VC.ui && VC.ui.isOpen(key)),

  open(key, o = {}) {
    lastCall = { key: key === 'loans' ? 'budget' : key, t: performance.now() };
    if (key === 'loans') return P.open('budget', Object.assign({}, o, { tab: 'loans' }));
    if (key === 'inspector') return inspTarget ? P.inspect(inspTarget) : null;
    const def = defs[key];
    if (!def || !VC.ui || !VC.ui.window) return null;
    let p = openP.get(key);
    if (p && VC.ui.isOpen(key)) {
      p.win.show();
      if (o.tab && p.tabs) p.tabs.select(o.tab);
      return p.win;
    }
    const info = LIST.find((l) => l.key === key) || {};
    if (o.tab) tabMem[key] = o.tab;
    const win = makeWin(key, def, def.title || info.name || key, def.icon || info.icon);
    p = { key, def, win, body: win.body, opts: o };
    openP.set(key, p);
    build(p);
    VC.bus.emit('sfx', { name: 'open' });
    return win;
  },

  toggle(key) {
    if (key === 'loans') key = 'budget';
    lastCall = { key, t: performance.now() };
    if (P.isOpen(key)) {
      P.close(key);
      return null;
    }
    return P.open(key);
  },

  close(key) {
    if (VC.ui && VC.ui.closeWindow) VC.ui.closeWindow(key);
  },

  /** Opens the inspector for a building or tile {x,z}; null closes it. */
  inspect(target) {
    if (!target || !VC.state) {
      inspTarget = null;
      P.close('inspector');
      return null;
    }
    if (target.id != null && !VC.state.buildings.has(target.id)) return null;
    const def = defs.inspector;
    if (!def) return null;
    inspTarget = target;
    if (VC.tools) VC.tools.selectedId = target.id != null ? target.id : 0;
    let p = openP.get('inspector');
    if (!p || !VC.ui.isOpen('inspector')) {
      const win = makeWin('inspector', def, 'Inspector', '🔍');
      p = { key: 'inspector', def, win, body: win.body, opts: {} };
      openP.set('inspector', p);
    } else p.win.show();
    p.target = target;
    build(p);
    return p.win;
  },
  /** Currently inspected building/tile (or null). */
  inspected: () => inspTarget,
});

/**
 * Hotkey fallback. input.js owns the hotkeys (docs §8); this only acts when nobody else opened or
 * toggled the same panel while the event was being dispatched, so it can never double-toggle.
 */
function onHotkey(e) {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const tg = e.target;
  if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT' || tg.isContentEditable)) return;
  const it = LIST.find((l) => l.hotkey === e.code);
  if (!it) return;
  // same guards as the HUD: not over modals, the title menu or its demo city
  if ((VC.ui && VC.ui.modalCount && VC.ui.modalCount()) || document.querySelector('.modal-back')) return;
  if ((VC.menu && VC.menu.active) || (VC.state && VC.state.demo)) return;
  const t0 = e.timeStamp;
  setTimeout(() => {
    if (lastCall.key === it.key && lastCall.t >= t0) return;
    if (!VC.state || !VC.running) return;
    P.toggle(it.key);
  }, 0);
}
