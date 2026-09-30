/*
 * VOXELPOLIS — UI framework: draggable windows, widgets, toasts, tooltips, modals.
 * All game UI is HTML/CSS layered over the canvas inside #ui.
 *
 * WINDOWS
 *   VC.ui.window(id, { title, icon, width, height, x, y, closable=true, onClose, cls }) -> Win
 *     Win = { id, el, body, setTitle(t), close(), show(), hide(), focus(), toggle(), isOpen() }
 *     Calling again with an existing id returns the same Win (shown + focused).
 *   VC.ui.toggleWindow(id, factory)  — closes if open, else factory() creates/fills it
 *   VC.ui.isOpen(id), VC.ui.closeWindow(id), VC.ui.closeAll()
 *
 * WIDGETS (all return DOM elements; mutators are attached as methods)
 *   button(label, onClick, {icon, cls, tip, disabled})
 *   slider({label, min, max, step, value, format, onInput, onChange, tip, color}) -> el.setValue(v), el.getValue()
 *   toggle({label, value, onChange, tip, desc}) -> el.setValue(b)
 *   select({label, options:[{value,label}], value, onChange}) -> el.setValue(v)
 *   tabs([{key, label, icon, render(container)}], {active, onChange}) -> el.select(key), el.refresh()
 *   bar({label, value, color, text, tip}) -> el.set(value, text)
 *   stat(label, value, {icon, tip, cls}) -> el.set(value)
 *   chart({width, height, series:[{data, color, label, fill}], yFormat, min, max}) -> el.update(series)
 *   section(title, ...children), row(...children), note(text)
 * FEEDBACK
 *   toast(text, {type: 'info'|'good'|'warn'|'bad', icon, duration})
 *   modal(title, content, [{label, cls, onClick}]) -> close fn
 *   confirm(text, onYes, {yes, no})
 * TOOLTIPS: any element with data-tip="..." (HTML allowed) shows a tooltip on hover.
 * Bus: listens to 'toast' {text, type, icon}.
 */
const h = VC.h;
const wins = new Map();
let zTop = 100;

const ui = (VC.ui = {
  root: null,
  init() {
    ui.root = document.getElementById('ui');
    ui.layer = h('div', { class: 'ui-windows' });
    ui.toasts = h('div', { class: 'ui-toasts' });
    ui.tip = h('div', { class: 'ui-tooltip' });
    ui.root.append(ui.layer, ui.toasts, ui.tip);
    VC.bus.on('toast', (t) => ui.toast(t.text, t));
    initTooltips();
    applyScale();
    VC.bus.on('settings', applyScale);
    window.addEventListener('resize', () => wins.forEach((w) => clampWin(w)));
  },

  /* ---------------- windows ---------------- */
  window(id, o = {}) {
    let w = wins.get(id);
    if (w) {
      if (o.title) w.setTitle(o.title, o.icon);
      w.show();
      return w;
    }
    const titleEl = h('div', { class: 'win-title' });
    const closeBtn = o.closable === false ? null : h('button', { class: 'win-close', title: 'Close (Esc)', onclick: () => w.close() }, '×');
    const head = h('div', { class: 'win-head' }, titleEl, closeBtn);
    const body = h('div', { class: 'win-body' });
    const el = h('div', { class: 'win ' + (o.cls || ''), 'data-win': id }, head, body);
    if (o.width) el.style.width = typeof o.width === 'number' ? o.width + 'px' : o.width;
    if (o.height) el.style.height = typeof o.height === 'number' ? o.height + 'px' : o.height;
    ui.layer.appendChild(el);
    w = {
      id, el, body, head, opts: o,
      setTitle(t, icon) {
        titleEl.innerHTML = '';
        if (icon) titleEl.appendChild(h('span', { class: 'win-icon' }, icon));
        titleEl.appendChild(h('span', null, t));
      },
      close() {
        if (!wins.has(id)) return;
        el.classList.add('closing');
        wins.delete(id);
        setTimeout(() => el.remove(), 160);
        if (o.onClose) o.onClose();
        VC.bus.emit('windowClosed', id);
      },
      show() {
        el.style.display = '';
        w.focus();
      },
      hide() {
        el.style.display = 'none';
      },
      focus() {
        el.style.zIndex = ++zTop;
      },
      toggle() {
        wins.has(id) ? w.close() : w.show();
      },
      isOpen: () => wins.has(id),
    };
    w.setTitle(o.title || id, o.icon);
    wins.set(id, w);
    // position
    const n = wins.size;
    const vw = window.innerWidth, vh = window.innerHeight;
    const r = el.getBoundingClientRect();
    const x = o.x != null ? o.x : Math.max(10, Math.min(vw - r.width - 10, vw / 2 - r.width / 2 + ((n * 28) % 160) - 80));
    const y = o.y != null ? o.y : Math.max(64, Math.min(vh - r.height - 10, 90 + ((n * 24) % 140)));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.addEventListener('pointerdown', () => w.focus());
    makeDraggable(el, head);
    w.focus();
    VC.bus.emit('windowOpened', id);
    return w;
  },
  toggleWindow(id, factory) {
    const w = wins.get(id);
    if (w) { w.close(); return null; }
    return factory();
  },
  isOpen: (id) => wins.has(id),
  getWindow: (id) => wins.get(id) || null,
  closeWindow(id) {
    const w = wins.get(id);
    if (w) w.close();
  },
  closeAll() {
    for (const w of [...wins.values()]) w.close();
  },
  /** Closes the top-most window. Returns true if one was closed. */
  closeTop() {
    let top = null;
    for (const w of wins.values()) if (!top || +w.el.style.zIndex > +top.el.style.zIndex) top = w;
    if (top && top.opts.closable !== false) { top.close(); return true; }
    return false;
  },

  /* ---------------- widgets ---------------- */
  button(label, onClick, o = {}) {
    const b = h('button', { class: 'btn ' + (o.cls || ''), 'data-tip': o.tip, disabled: !!o.disabled, onclick: (e) => { VC.bus.emit('sfx', { name: 'click' }); onClick && onClick(e); } }, o.icon ? h('span', { class: 'btn-icon' }, o.icon) : null, label ? h('span', null, label) : null);
    return b;
  },
  slider(o) {
    const fmt = o.format || ((v) => String(v));
    const val = h('span', { class: 'sl-val' }, fmt(o.value));
    const input = h('input', { type: 'range', min: o.min, max: o.max, step: o.step || 1 });
    input.value = o.value;
    const setFill = () => {
      const p = ((+input.value - o.min) / (o.max - o.min)) * 100;
      input.style.setProperty('--fill', p + '%');
      if (o.color) input.style.setProperty('--accent', typeof o.color === 'function' ? o.color(+input.value) : o.color);
    };
    input.addEventListener('input', () => { val.textContent = fmt(+input.value); setFill(); o.onInput && o.onInput(+input.value); });
    input.addEventListener('change', () => { o.onChange && o.onChange(+input.value); });
    setFill();
    const el = h('div', { class: 'slider', 'data-tip': o.tip }, h('div', { class: 'sl-head' }, h('span', { class: 'sl-label' }, o.icon ? o.icon + ' ' : '', o.label || ''), val), input);
    el.setValue = (v) => { input.value = v; val.textContent = fmt(+v); setFill(); };
    el.getValue = () => +input.value;
    el.input = input;
    return el;
  },
  toggle(o) {
    const input = h('input', { type: 'checkbox' });
    input.checked = !!o.value;
    input.addEventListener('change', () => { VC.bus.emit('sfx', { name: 'click' }); o.onChange && o.onChange(input.checked); });
    const el = h('label', { class: 'toggle', 'data-tip': o.tip }, input, h('span', { class: 'tg-track' }, h('span', { class: 'tg-knob' })), h('span', { class: 'tg-text' }, h('span', { class: 'tg-label' }, o.label || ''), o.desc ? h('span', { class: 'tg-desc' }, o.desc) : null));
    el.setValue = (v) => (input.checked = !!v);
    el.input = input;
    return el;
  },
  select(o) {
    const s = h('select', { onchange: () => o.onChange && o.onChange(s.value) }, o.options.map((op) => h('option', { value: op.value }, op.label)));
    s.value = o.value;
    const el = h('label', { class: 'select' }, o.label ? h('span', { class: 'sel-label' }, o.label) : null, s);
    el.setValue = (v) => (s.value = v);
    el.input = s;
    return el;
  },
  tabs(list, o = {}) {
    const head = h('div', { class: 'tabs-head' });
    const body = h('div', { class: 'tabs-body' });
    const el = h('div', { class: 'tabs' }, head, body);
    let cur = null;
    el.select = (key) => {
      const t = list.find((x) => x.key === key) || list[0];
      cur = t.key;
      for (const b of head.children) b.classList.toggle('active', b.dataset.key === cur);
      body.innerHTML = '';
      t.render(body);
      o.onChange && o.onChange(cur);
    };
    el.refresh = () => el.select(cur);
    el.current = () => cur;
    for (const t of list) head.appendChild(h('button', { class: 'tab', 'data-key': t.key, 'data-tip': t.tip, onclick: () => { VC.bus.emit('sfx', { name: 'click' }); el.select(t.key); } }, t.icon ? h('span', { class: 'tab-icon' }, t.icon) : null, t.label));
    el.select(o.active || list[0].key);
    return el;
  },
  bar(o) {
    const fill = h('div', { class: 'bar-fill' });
    const txt = h('span', { class: 'bar-text' });
    const el = h('div', { class: 'bar-row', 'data-tip': o.tip }, o.label ? h('span', { class: 'bar-label' }, o.label) : null, h('div', { class: 'bar' }, fill), txt);
    el.set = (v, t) => {
      fill.style.width = Math.round(VC.M.clamp(v, 0, 1) * 100) + '%';
      fill.style.background = typeof o.color === 'function' ? o.color(v) : o.color || '';
      txt.textContent = t != null ? t : Math.round(v * 100) + '%';
    };
    el.set(o.value || 0, o.text);
    return el;
  },
  stat(label, value, o = {}) {
    const v = h('span', { class: 'stat-val' }, value);
    const el = h('div', { class: 'stat ' + (o.cls || ''), 'data-tip': o.tip }, h('span', { class: 'stat-label' }, o.icon ? h('span', { class: 'stat-icon' }, o.icon) : null, label), v);
    el.set = (t, cls) => { v.textContent = t; if (cls != null) v.className = 'stat-val ' + cls; };
    return el;
  },
  chart(o) {
    const W = o.width || 360, H = o.height || 140;
    const cv = h('canvas', { class: 'chart', width: W * 2, height: H * 2, style: { width: W + 'px', height: H + 'px' } });
    const el = h('div', { class: 'chart-wrap' }, cv);
    const legend = h('div', { class: 'chart-legend' });
    el.appendChild(legend);
    el.update = (series) => drawChart(cv, series || o.series || [], o, legend);
    el.update(o.series);
    return el;
  },
  section(title, ...kids) {
    return h('div', { class: 'section' }, title ? h('div', { class: 'section-title' }, title) : null, ...kids);
  },
  row(...kids) {
    return h('div', { class: 'row' }, ...kids);
  },
  note(text) {
    return h('div', { class: 'note' }, text);
  },

  /* ---------------- feedback ---------------- */
  toast(text, o = {}) {
    const type = o.type || 'info';
    const icon = o.icon || { info: 'ℹ️', good: '✅', warn: '⚠️', bad: '⛔', error: '⛔' }[type] || '';
    const el = h('div', { class: 'toast toast-' + type }, h('span', { class: 'toast-icon' }, icon), h('span', { class: 'toast-text', html: text }));
    ui.toasts.appendChild(el);
    while (ui.toasts.children.length > 5) ui.toasts.firstChild.remove();
    const dur = o.duration || 3800;
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, dur);
    el.addEventListener('click', () => el.remove());
    return el;
  },
  modal(title, content, buttons = [{ label: 'OK' }]) {
    const back = h('div', { class: 'modal-back' });
    const close = () => { back.classList.add('out'); setTimeout(() => back.remove(), 200); };
    const box = h('div', { class: 'modal' }, h('div', { class: 'modal-title' }, title), h('div', { class: 'modal-body' }, content), h('div', { class: 'modal-btns' }, buttons.map((b) => ui.button(b.label, () => { close(); b.onClick && b.onClick(); }, { cls: b.cls }))));
    back.appendChild(box);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    ui.root.appendChild(back);
    return close;
  },
  confirm(text, onYes, o = {}) {
    return ui.modal(o.title || 'Are you sure?', h('div', { html: text }), [{ label: o.no || 'Cancel' }, { label: o.yes || 'Yes', cls: 'primary', onClick: onYes }]);
  },
});

function makeDraggable(el, handle) {
  let sx, sy, ox, oy, drag = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    drag = true;
    sx = e.clientX; sy = e.clientY;
    ox = el.offsetLeft; oy = el.offsetTop;
    handle.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    el.style.left = ox + e.clientX - sx + 'px';
    el.style.top = oy + e.clientY - sy + 'px';
  });
  const end = () => {
    if (!drag) return;
    drag = false;
    el.classList.remove('dragging');
    clampWin({ el });
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
function clampWin(w) {
  const el = w.el;
  const r = el.getBoundingClientRect();
  const x = VC.M.clamp(el.offsetLeft, -r.width + 80, window.innerWidth - 80);
  const y = VC.M.clamp(el.offsetTop, 0, window.innerHeight - 40);
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}
function applyScale() {
  const s = (VC.settings && VC.settings.uiScale) || 1;
  document.documentElement.style.setProperty('--ui-scale', s);
}

function initTooltips() {
  let cur = null;
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t === cur) return;
    cur = t;
    if (!t || !t.dataset.tip) { ui.tip.classList.remove('show'); return; }
    ui.tip.innerHTML = t.dataset.tip;
    ui.tip.classList.add('show');
  });
  document.addEventListener('pointermove', (e) => {
    if (!cur) return;
    const r = ui.tip.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY + 18;
    if (x + r.width > window.innerWidth - 6) x = e.clientX - r.width - 10;
    if (y + r.height > window.innerHeight - 6) y = e.clientY - r.height - 12;
    ui.tip.style.transform = `translate(${x}px, ${y}px)`;
  });
  document.addEventListener('pointerdown', () => { ui.tip.classList.remove('show'); cur = null; });
}

function drawChart(cv, series, o, legend) {
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 70, r: 12, t: 12, b: 22 };
  let lo = o.min != null ? o.min : Infinity, hi = o.max != null ? o.max : -Infinity;
  let n = 0;
  for (const s of series) {
    n = Math.max(n, s.data.length);
    if (o.min == null) for (const v of s.data) lo = Math.min(lo, v);
    if (o.max == null) for (const v of s.data) hi = Math.max(hi, v);
  }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  if (hi - lo < 1e-9) { hi = lo + 1; }
  const span = hi - lo;
  lo -= span * 0.05 * (o.min == null ? 1 : 0);
  hi += span * 0.08 * (o.max == null ? 1 : 0);
  const X = (i) => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - ((v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 2;
  const yf = o.yFormat || ((v) => VC.fmt.short(v));
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillText(yf(v), 6, y + 7);
  }
  if (lo < 0 && hi > 0) { ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.moveTo(pad.l, Y(0)); ctx.lineTo(W - pad.r, Y(0)); ctx.stroke(); }
  for (const s of series) {
    if (!s.data.length) continue;
    ctx.beginPath();
    s.data.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.strokeStyle = s.color || '#5ad1ff';
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.stroke();
    if (s.fill !== false) {
      ctx.lineTo(X(s.data.length - 1), Y(Math.max(lo, 0)));
      ctx.lineTo(X(0), Y(Math.max(lo, 0)));
      ctx.closePath();
      const g = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
      g.addColorStop(0, (s.color || '#5ad1ff') + '55');
      g.addColorStop(1, (s.color || '#5ad1ff') + '00');
      ctx.fillStyle = g;
      ctx.fill();
    }
  }
  if (legend) {
    legend.innerHTML = '';
    for (const s of series) if (s.label) legend.appendChild(h('span', { class: 'lg' }, h('i', { style: { background: s.color } }), s.label));
  }
}
