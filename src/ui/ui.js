/*
 * VOXELPOLIS — UI framework: draggable windows, widgets, toasts, tooltips, modals, popovers.
 * All game UI is HTML/CSS layered over the canvas inside #ui (owned by the HUD module).
 *
 * WINDOWS
 *   VC.ui.window(id, { title, icon, width, height, x, y, closable=true, minimizable=true, onClose, cls }) -> Win
 *     Win = { id, el, body, head, setTitle(t, icon), close(), show(), hide(), focus(), toggle(), isOpen(),
 *             minimize(on?), isMinimized() }
 *     Calling again with an existing id returns the same Win (shown + focused). The last position of
 *     each window id is remembered for the session; new windows are centred once their content is in.
 *     Double-click the title bar (or the – button) to minimize.
 *   VC.ui.toggleWindow(id, factory)  — closes if open, else factory() creates/fills it
 *   VC.ui.isOpen(id), VC.ui.getWindow(id), VC.ui.closeWindow(id), VC.ui.closeAll(), VC.ui.closeTop(),
 *   VC.ui.openWindows() -> [id]
 *
 * WIDGETS (all return DOM elements; mutators are attached as methods)
 *   button(label, onClick, {icon, cls, tip, disabled})
 *   slider({label, icon, min, max, step, value, format, onInput, onChange, tip, color, ticks:[values]})
 *       -> el.setValue(v), el.getValue()           (color may be a fn(value) -> css color)
 *   toggle({label, value, onChange, tip, desc}) -> el.setValue(b)
 *   select({label, options:[{value,label}], value, onChange}) -> el.setValue(v)
 *   segmented({label, options:[{value,label,icon,tip}], value, onChange, cls}) -> el.setValue(v), el.getValue()
 *   tabs([{key, label, icon, tip, render(container)}], {active, onChange}) -> el.select(key), el.refresh(), el.current()
 *   bar({label, value, color, text, tip}) -> el.set(value, text)
 *   stat(label, value, {icon, tip, cls}) -> el.set(value, cls)
 *   chart({width, height, series:[{data, color, label, fill}], yFormat, min, max}) -> el.update(series)
 *   sparkline({data, width, height, color, fill=true, min, max}) -> el.update(data)
 *   counter({value, format, duration, cls}) -> <span> whose number tweens smoothly on el.set(v)
 *   cards(items:[{value, icon, title, sub, desc, tip, disabled, badge, cls}], {value, columns, onSelect, render(item, card)})
 *       -> el.select(value), el.getValue(), el.cards (Map value -> card element)
 *   input({value, placeholder, maxLength, onInput, onEnter, cls, type}) -> <input class="input">
 *   kbd(label), badge(text, cls), section(title, ...children), row(...children), note(text)
 * FEEDBACK
 *   toast(html, {type: 'info'|'good'|'warn'|'bad', icon, duration, cls, onClick})
 *   modal(title, content, [{label, cls, onClick}], {cls}) -> close fn          (Esc closes the top modal)
 *   confirm(text, onYes, {title, yes, no, danger})
 *   prompt(title, value, onOk(value), {text, placeholder, maxLength, ok})
 *   popover(anchorEl, content, {id, title, side:'top'|'bottom'|'left'|'right', cls, onClose}) -> {el, close()}
 *       one popover per id; closes on outside pointerdown or Esc.  VC.ui.closePopovers()
 * TOOLTIPS: any element with data-tip="..." (HTML allowed) shows a tooltip on hover. For live content
 *   also set el._tip = () => html; it is re-evaluated while the tooltip is visible.
 *   Rich tooltip classes (base.css): .tt-head .tt-icon .tt-desc .tt-grid (label/value pairs) .tt-foot .tt-lock
 * HELPERS: VC.ui.scale() current UI scale, VC.ui.signed(n) '+1,234', VC.ui.signedMoney(n) '+$1,234',
 *   VC.ui.flash(el, cls) (restart a CSS animation class), VC.ui.svg(tag, attrs, ...kids).
 * UI scale: blocks use the CSS `scale: var(--ui-scale)` property (never `zoom`) so all layout math is in
 *   screen px. Position scaled floating elements with left/top or the `translate` property, not `transform`.
 * Bus: listens to 'toast' {text, type, icon, duration} (suppressed while the title-screen demo city runs).
 */
const h = VC.h;
const SVGNS = 'http://www.w3.org/2000/svg';
const wins = new Map();
const lastPos = new Map();
const modals = [];
const popovers = new Map();
const anims = new Set();
let zTop = 100;

function sfx(name) {
  VC.bus.emit('sfx', { name: name || 'click' });
}

const ui = (VC.ui = {
  root: null,
  init() {
    ui.root = document.getElementById('ui');
    ui.layer = h('div', { class: 'ui-windows' });
    ui.toasts = h('div', { class: 'ui-toasts' });
    ui.tip = h('div', { class: 'ui-tooltip' });
    ui.root.append(ui.layer, ui.toasts, ui.tip);
    VC.bus.on('toast', (t) => {
      if (!t || !t.text) return;
      if (VC.state && VC.state.demo && t.type !== 'error') return; // no game chatter over the title screen
      ui.toast(t.text, t);
    });
    initTooltips();
    window.addEventListener('keydown', onKeyCapture, true);
    applyScale();
    VC.bus.on('settings', applyScale);
    window.addEventListener('resize', () => wins.forEach((w) => clampWin(w)));
  },
  scale() {
    const s = +((VC.settings && VC.settings.uiScale) || 1);
    return VC.M.clamp(s || 1, 0.5, 2);
  },

  /* ---------------- windows ---------------- */
  window(id, o = {}) {
    let w = wins.get(id);
    if (w) {
      if (o.title) w.setTitle(o.title, o.icon);
      if (w.isMinimized()) w.minimize(false);
      w.show();
      return w;
    }
    const titleEl = h('div', { class: 'win-title' });
    const minBtn = o.minimizable === false ? null : h('button', { class: 'win-btn win-min', title: 'Minimize', onclick: () => w.minimize() }, h('i'));
    const closeBtn = o.closable === false ? null : h('button', { class: 'win-btn win-close', title: 'Close (Esc)', onclick: () => { sfx(); w.close(); } }, '×');
    const head = h('div', { class: 'win-head' }, titleEl, minBtn, closeBtn);
    const body = h('div', { class: 'win-body' });
    const el = h('div', { class: 'win ' + (o.cls || ''), 'data-win': id }, head, body);
    if (o.width) el.style.width = typeof o.width === 'number' ? o.width + 'px' : o.width;
    if (o.height) el.style.height = typeof o.height === 'number' ? o.height + 'px' : o.height;
    ui.layer.appendChild(el);
    let minimized = false;
    w = {
      id, el, body, head, opts: o, moved: false,
      setTitle(t, icon) {
        titleEl.innerHTML = '';
        if (icon) titleEl.appendChild(h('span', { class: 'win-icon' }, icon));
        titleEl.appendChild(h('span', { class: 'win-title-text' }, t));
      },
      close() {
        if (!wins.has(id)) return;
        if (w.moved) lastPos.set(id, { x: el.offsetLeft, y: el.offsetTop });
        if (w._ro) w._ro.disconnect();
        el.classList.add('closing');
        wins.delete(id);
        setTimeout(() => el.remove(), 160);
        if (o.onClose) {
          try { o.onClose(); } catch (e) { console.error('[ui] onClose', e); }
        }
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
      minimize(on) {
        minimized = on == null ? !minimized : !!on;
        el.classList.toggle('min', minimized);
        if (!minimized) clampWin(w);
      },
      isMinimized: () => minimized,
    };
    w.setTitle(o.title || id, o.icon);
    wins.set(id, w);
    // position: explicit > remembered > centred with a small stagger
    const lp = lastPos.get(id);
    const place = () => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const r = el.getBoundingClientRect();
      const n = wins.size;
      const x = o.x != null ? o.x : lp ? lp.x : vw / 2 - r.width / 2 + ((n * 28) % 160) - 80;
      const y = o.y != null ? o.y : lp ? lp.y : Math.min(vh - r.height - 12, 84 + ((n * 24) % 120));
      el.style.left = Math.round(x) + 'px';
      el.style.top = Math.round(Math.max(64, y)) + 'px';
      clampWin(w);
    };
    place();
    // content is usually added right after creation (and may change later): re-centre while the user
    // has not moved the window, otherwise just keep it on screen
    const refit = () => {
      if (wins.get(id) !== w) return;
      if (!w.moved && !lp && o.x == null) place();
      else clampWin(w);
    };
    if (window.ResizeObserver) {
      w._ro = new ResizeObserver(refit);
      w._ro.observe(el);
    } else requestAnimationFrame(refit);
    el.addEventListener('pointerdown', () => w.focus());
    head.addEventListener('dblclick', (e) => { if (!e.target.closest('button') && o.minimizable !== false) w.minimize(); });
    makeDraggable(w, head);
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
  openWindows: () => [...wins.keys()],
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
    for (const w of wins.values()) if (w.el.style.display !== 'none' && (!top || +w.el.style.zIndex > +top.el.style.zIndex)) top = w;
    if (top && top.opts.closable !== false) { top.close(); return true; }
    return false;
  },

  /* ---------------- widgets ---------------- */
  button(label, onClick, o = {}) {
    return h('button', { class: 'btn ' + (o.cls || ''), 'data-tip': o.tip, disabled: !!o.disabled, onclick: (e) => { sfx(); onClick && onClick(e); } }, o.icon ? h('span', { class: 'btn-icon' }, o.icon) : null, label ? h('span', { class: 'btn-label' }, label) : null);
  },
  slider(o) {
    const fmt = o.format || ((v) => String(v));
    const val = h('span', { class: 'sl-val' }, fmt(o.value));
    const input = h('input', { type: 'range', min: o.min, max: o.max, step: o.step || 1 });
    input.value = o.value;
    const setFill = () => {
      const p = ((+input.value - o.min) / (o.max - o.min)) * 100;
      input.style.setProperty('--fill', p + '%');
      if (o.color) {
        const c = typeof o.color === 'function' ? o.color(+input.value) : o.color;
        input.style.setProperty('--accent', c);
        val.style.color = typeof o.color === 'function' ? c : '';
      }
    };
    input.addEventListener('input', () => { val.textContent = fmt(+input.value); setFill(); o.onInput && o.onInput(+input.value); });
    input.addEventListener('change', () => { o.onChange && o.onChange(+input.value); });
    setFill();
    let ticks = null;
    if (o.ticks && o.ticks.length) {
      ticks = h('div', { class: 'sl-ticks' }, o.ticks.map((t) => h('i', { style: { left: ((t - o.min) / (o.max - o.min)) * 100 + '%' } })));
    }
    const el = h('div', { class: 'slider', 'data-tip': o.tip }, h('div', { class: 'sl-head' }, h('span', { class: 'sl-label' }, o.icon ? h('span', { class: 'sl-icon' }, o.icon) : null, o.label || ''), val), h('div', { class: 'sl-track' }, input, ticks));
    el.setValue = (v) => { input.value = v; val.textContent = fmt(+v); setFill(); };
    el.getValue = () => +input.value;
    el.input = input;
    return el;
  },
  toggle(o) {
    const input = h('input', { type: 'checkbox' });
    input.checked = !!o.value;
    input.addEventListener('change', () => { sfx(); o.onChange && o.onChange(input.checked); });
    const el = h('label', { class: 'toggle', 'data-tip': o.tip }, input, h('span', { class: 'tg-track' }, h('span', { class: 'tg-knob' })), h('span', { class: 'tg-text' }, h('span', { class: 'tg-label' }, o.label || ''), o.desc ? h('span', { class: 'tg-desc' }, o.desc) : null));
    el.setValue = (v) => (input.checked = !!v);
    el.input = input;
    return el;
  },
  select(o) {
    const s = h('select', { onchange: () => { sfx(); o.onChange && o.onChange(s.value); } }, o.options.map((op) => h('option', { value: op.value }, op.label)));
    s.value = o.value;
    const el = h('label', { class: 'select' }, o.label ? h('span', { class: 'sel-label' }, o.label) : null, s);
    el.setValue = (v) => (s.value = v);
    el.input = s;
    return el;
  },
  segmented(o) {
    let cur = o.value;
    const seg = h('div', { class: 'seg ' + (o.cls || '') });
    const btns = o.options.map((op) =>
      h('button', { class: 'seg-btn', 'data-tip': op.tip, onclick: () => { sfx(); el.setValue(op.value); o.onChange && o.onChange(op.value); } }, op.icon ? h('span', { class: 'seg-icon' }, op.icon) : null, op.label != null ? h('span', { class: 'seg-label' }, op.label) : null)
    );
    seg.append(...btns);
    const el = o.label ? h('div', { class: 'seg-row' }, h('span', { class: 'sel-label' }, o.label), seg) : seg;
    el.setValue = (v) => {
      cur = v;
      btns.forEach((b, i) => b.classList.toggle('active', o.options[i].value === v));
    };
    el.getValue = () => cur;
    el.setValue(cur);
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
      body.classList.remove('tab-in');
      void body.offsetWidth; // restart the fade-in
      body.classList.add('tab-in');
      t.render(body);
      o.onChange && o.onChange(cur);
    };
    el.refresh = () => el.select(cur);
    el.current = () => cur;
    for (const t of list) head.appendChild(h('button', { class: 'tab', 'data-key': t.key, 'data-tip': t.tip, onclick: () => { sfx(); el.select(t.key); } }, t.icon ? h('span', { class: 'tab-icon' }, t.icon) : null, t.label));
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
  sparkline(o = {}) {
    const W = o.width || 90, H = o.height || 26;
    const col = o.color || 'var(--accent)';
    const area = ui.svg('path', { class: 'spark-area', fill: col });
    const line = ui.svg('path', { class: 'spark-line', stroke: col });
    const dot = ui.svg('circle', { class: 'spark-dot', r: 2.2, fill: col });
    const svg = ui.svg('svg', { class: 'spark', width: W, height: H, viewBox: `0 0 ${W} ${H}` }, o.fill === false ? null : area, line, dot);
    svg.update = (data) => {
      data = data || [];
      if (data.length < 2) { line.setAttribute('d', ''); area.setAttribute('d', ''); dot.setAttribute('r', 0); return; }
      let lo = o.min != null ? o.min : Infinity, hi = o.max != null ? o.max : -Infinity;
      if (o.min == null || o.max == null) for (const v of data) { if (o.min == null && v < lo) lo = v; if (o.max == null && v > hi) hi = v; }
      if (hi - lo < 1e-9) { hi = lo + 1; lo -= 1; }
      const n = data.length;
      let d = '';
      let x = 0, y = 0;
      for (let i = 0; i < n; i++) {
        x = 1 + (i / (n - 1)) * (W - 4);
        y = 2 + (1 - (data[i] - lo) / (hi - lo)) * (H - 4);
        d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      }
      line.setAttribute('d', d);
      area.setAttribute('d', d + `L${x.toFixed(1)} ${H}L1 ${H}Z`);
      dot.setAttribute('cx', x.toFixed(1));
      dot.setAttribute('cy', y.toFixed(1));
      dot.setAttribute('r', 2.2);
    };
    svg.update(o.data);
    return svg;
  },
  counter(o = {}) {
    const fmt = o.format || VC.fmt.num;
    const dur = o.duration || 650;
    const el = h('span', { class: 'counter ' + (o.cls || '') });
    let cur = +o.value || 0, from = cur, target = cur, t0 = 0, last = '';
    const show = (v) => { const s = fmt(v); if (s !== last) { last = s; el.textContent = s; } };
    show(cur);
    el.set = (v) => {
      v = +v || 0;
      if (v === target) return;
      if (!el.isConnected || Math.abs(v - cur) < 1e-6) { cur = from = target = v; show(v); return; }
      from = cur; target = v; t0 = performance.now();
      el._step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        cur = from + (target - from) * e;
        show(k >= 1 ? target : cur);
        return k < 1;
      };
      animate(el);
    };
    el.value = () => target;
    return el;
  },
  cards(items, o = {}) {
    const el = h('div', { class: 'cards ' + (o.cls || '') });
    if (o.columns) el.style.gridTemplateColumns = `repeat(${o.columns}, minmax(0, 1fr))`;
    el.cards = new Map();
    let cur = o.value;
    for (const it of items) {
      const card = h('button', { class: 'card ' + (it.cls || ''), 'data-tip': it.tip, disabled: !!it.disabled, onclick: () => { if (it.disabled) return; sfx(); el.select(it.value); o.onSelect && o.onSelect(it.value, it); } },
        it.badge ? h('span', { class: 'card-badge' }, it.badge) : null,
        it.icon ? h('span', { class: 'card-icon' }, it.icon) : null,
        it.title ? h('span', { class: 'card-title' }, it.title) : null,
        it.sub ? h('span', { class: 'card-sub' }, it.sub) : null,
        it.desc ? h('span', { class: 'card-desc' }, it.desc) : null);
      if (o.render) o.render(it, card);
      el.cards.set(it.value, card);
      el.appendChild(card);
    }
    el.select = (v) => {
      cur = v;
      for (const [k, c] of el.cards) c.classList.toggle('active', k === v);
    };
    el.getValue = () => cur;
    el.select(cur);
    return el;
  },
  input(o = {}) {
    const el = h('input', { class: 'input ' + (o.cls || ''), type: o.type || 'text', placeholder: o.placeholder || '', maxlength: o.maxLength || 60, spellcheck: 'false', autocomplete: 'off' });
    el.value = o.value != null ? o.value : '';
    if (o.onInput) el.addEventListener('input', () => o.onInput(el.value));
    el.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing never triggers game hotkeys
      if (e.key === 'Enter' && o.onEnter) o.onEnter(el.value);
      if (e.key === 'Escape') el.blur();
    });
    return el;
  },
  kbd(label) {
    return h('kbd', { class: 'kbd' }, label);
  },
  badge(text, cls) {
    return h('span', { class: 'badge ' + (cls || '') }, text);
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
    const el = h('div', { class: 'toast toast-' + type + ' ' + (o.cls || '') }, h('span', { class: 'toast-icon' }, icon), h('span', { class: 'toast-text', html: text }));
    ui.toasts.appendChild(el);
    while (ui.toasts.children.length > 5) ui.toasts.firstChild.remove();
    const dur = o.duration || 3800;
    const out = () => { if (el.classList.contains('out')) return; el.classList.add('out'); setTimeout(() => el.remove(), 380); };
    setTimeout(out, dur);
    el.addEventListener('click', () => { if (o.onClick) o.onClick(); out(); });
    return el;
  },
  modal(title, content, buttons = [{ label: 'OK' }], o = {}) {
    const back = h('div', { class: 'modal-back' });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      const i = modals.indexOf(close);
      if (i >= 0) modals.splice(i, 1);
      back.classList.add('out');
      setTimeout(() => back.remove(), 200);
    };
    const btns = buttons.map((b) => ui.button(b.label, () => { close(); b.onClick && b.onClick(); }, { cls: b.cls, icon: b.icon }));
    const box = h('div', { class: 'modal ' + (o.cls || '') }, title ? h('div', { class: 'modal-title' }, title) : null, h('div', { class: 'modal-body' }, content), btns.length ? h('div', { class: 'modal-btns' }, btns) : null);
    back.appendChild(box);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    ui.root.appendChild(back);
    modals.push(close);
    const prim = btns.find((b) => b.classList.contains('primary'));
    if (prim) setTimeout(() => { if (!box.querySelector('input:focus')) prim.focus({ preventScroll: true }); }, 30);
    return close;
  },
  confirm(text, onYes, o = {}) {
    return ui.modal(o.title || 'Are you sure?', h('div', { html: text }), [{ label: o.no || 'Cancel' }, { label: o.yes || 'Yes', cls: o.danger ? 'danger' : 'primary', onClick: onYes }]);
  },
  prompt(title, value, onOk, o = {}) {
    let done = false;
    const ok = () => { if (done) return; done = true; const v = input.value.trim(); if (v) onOk(v); };
    const input = ui.input({ value, placeholder: o.placeholder, maxLength: o.maxLength || 40, onEnter: () => { close(); ok(); } });
    const close = ui.modal(title, h('div', { class: 'prompt' }, o.text ? h('div', { class: 'note' }, o.text) : null, input), [{ label: 'Cancel' }, { label: o.ok || 'OK', cls: 'primary', onClick: ok }]);
    setTimeout(() => { input.focus(); input.select(); }, 40);
    return close;
  },
  popover(anchor, content, o = {}) {
    const id = o.id || 'pop';
    const prev = popovers.get(id);
    if (prev) prev.close();
    const el = h('div', { class: 'popover pe ' + (o.cls || '') }, o.title ? h('div', { class: 'pop-title' }, o.title) : null, content);
    ui.root.appendChild(el);
    const onDown = (e) => {
      if (el.contains(e.target) || (anchor && anchor.contains && anchor.contains(e.target))) return;
      p.close();
    };
    const p = {
      el,
      close() {
        if (popovers.get(id) !== p) return;
        popovers.delete(id);
        document.removeEventListener('pointerdown', onDown, true);
        el.classList.add('out');
        setTimeout(() => el.remove(), 150);
        o.onClose && o.onClose();
      },
      place() { placeNear(el, anchor, o.side || 'top'); },
    };
    popovers.set(id, p);
    p.place();
    setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
    return p;
  },
  closePopovers() {
    for (const p of [...popovers.values()]) p.close();
  },
  isPopoverOpen: (id) => (id ? popovers.has(id) : popovers.size > 0),

  /* ---------------- helpers ---------------- */
  signed(n) {
    n = Math.round(n);
    return (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toLocaleString('en-US');
  },
  signedMoney(n) {
    const a = Math.abs(n);
    const s = a >= 1e4 ? '$' + VC.fmt.short(a) : '$' + Math.round(a).toLocaleString('en-US');
    return (n > 0.5 ? '+' : n < -0.5 ? '−' : '±') + s;
  },
  flash(el, cls = 'flash') {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  },
  svg(tag, attrs, ...kids) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    for (const c of kids) if (c) e.appendChild(c);
    return e;
  },
  /** Number of open modals (used by menus / hotkeys to stay out of the way). */
  modalCount: () => modals.length,
});

/* ---------------- tweening (counters) ---------------- */
let animRaf = 0;
function animate(el) {
  anims.add(el);
  if (!animRaf) animRaf = requestAnimationFrame(animTick);
}
function animTick(now) {
  animRaf = 0;
  for (const el of anims) {
    let more = false;
    try { more = el._step(now); } catch (e) { more = false; }
    if (!more) anims.delete(el);
  }
  if (anims.size) animRaf = requestAnimationFrame(animTick);
}

/* ---------------- keyboard: Esc closes modals / popovers first ---------------- */
function onKeyCapture(e) {
  if (e.key !== 'Escape' && e.code !== 'Escape') return;
  if (modals.length) {
    modals[modals.length - 1]();
    e.stopPropagation();
    e.preventDefault();
    return;
  }
  if (popovers.size) {
    ui.closePopovers();
    e.stopPropagation();
    e.preventDefault();
  }
}

/* ---------------- dragging / clamping ---------------- */
function makeDraggable(w, handle) {
  const el = w.el;
  let sx, sy, ox, oy, drag = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    drag = true;
    sx = e.clientX; sy = e.clientY;
    ox = el.offsetLeft; oy = el.offsetTop;
    handle.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    w.moved = true;
    el.style.left = ox + e.clientX - sx + 'px';
    el.style.top = oy + e.clientY - sy + 'px';
  });
  const end = () => {
    if (!drag) return;
    drag = false;
    el.classList.remove('dragging');
    clampWin(w);
    lastPos.set(w.id, { x: el.offsetLeft, y: el.offsetTop });
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
/** Keeps a window reachable: title bar on screen, whole window on screen when it fits. */
function clampWin(w) {
  const el = w.el;
  if (el.style.display === 'none') return;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const x = VC.M.clamp(el.offsetLeft, Math.min(10, -r.width + 90), Math.max(10, vw - Math.min(r.width, 90) - 10));
  let yMax = vh - 44;
  if (r.height <= vh - 16) yMax = Math.min(yMax, vh - r.height - 8);
  const y = VC.M.clamp(el.offsetTop, 0, Math.max(0, yMax));
  if (Math.round(x) !== el.offsetLeft) el.style.left = Math.round(x) + 'px';
  if (Math.round(y) !== el.offsetTop) el.style.top = Math.round(y) + 'px';
}
/** Places a fixed element next to an anchor (visual rects), clamped to the viewport. */
function placeNear(el, anchor, side) {
  const r = el.getBoundingClientRect();
  const a = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight / 2, bottom: innerHeight / 2, width: 0, height: 0 };
  const gap = 10;
  let x, y;
  if (side === 'left' || side === 'right') {
    x = side === 'left' ? a.left - r.width - gap : a.right + gap;
    y = a.top + a.height / 2 - r.height / 2;
  } else {
    x = a.left + a.width / 2 - r.width / 2;
    y = side === 'bottom' ? a.bottom + gap : a.top - r.height - gap;
  }
  x = VC.M.clamp(x, 8, Math.max(8, innerWidth - r.width - 8));
  y = VC.M.clamp(y, 8, Math.max(8, innerHeight - r.height - 8));
  el.style.left = Math.round(x) + 'px';
  el.style.top = Math.round(y) + 'px';
  el.dataset.side = side;
}
function applyScale() {
  document.documentElement.style.setProperty('--ui-scale', ui.scale());
  wins.forEach((w) => clampWin(w));
}

/* ---------------- tooltips ---------------- */
function initTooltips() {
  let cur = null, timer = 0, live = 0, mx = 0, my = 0;
  const tip = ui.tip;
  const hide = () => {
    tip.classList.remove('show');
    cur = null;
    clearTimeout(timer);
    clearInterval(live);
    live = 0;
  };
  const place = () => {
    const r = tip.getBoundingClientRect();
    let x = mx + 14, y = my + 18;
    if (x + r.width > innerWidth - 6) x = mx - r.width - 10;
    if (y + r.height > innerHeight - 6) y = my - r.height - 12;
    tip.style.translate = `${Math.round(Math.max(4, x))}px ${Math.round(Math.max(4, y))}px`;
  };
  const content = (t) => {
    try { return t._tip ? t._tip() : t.dataset.tip; } catch (e) { return ''; }
  };
  const showFor = (t) => {
    const html = content(t);
    if (!html) { tip.classList.remove('show'); return; }
    tip.innerHTML = html;
    tip.classList.add('show');
    place();
    clearInterval(live);
    live = setInterval(() => {
      if (!cur || !cur.isConnected) { hide(); return; }
      if (cur._tip) { tip.innerHTML = content(cur); place(); }
    }, 400);
  };
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t === cur) return;
    const wasShown = tip.classList.contains('show');
    cur = t;
    clearTimeout(timer);
    if (!t || (!t.dataset.tip && !t._tip)) { hide(); return; }
    // short delay before the first tooltip; instant when moving between tipped elements
    if (wasShown) showFor(t);
    else timer = setTimeout(() => { if (cur === t) showFor(t); }, 140);
  });
  document.addEventListener('pointermove', (e) => {
    mx = e.clientX; my = e.clientY;
    if (cur && tip.classList.contains('show')) place();
  });
  document.addEventListener('pointerdown', hide);
  document.addEventListener('pointerleave', hide);
  ui.hideTip = hide;
  /** Re-evaluates the tooltip if `el` is currently hovered (for data-tip changes). */
  ui.refreshTip = (el) => { if (el && cur === el && tip.classList.contains('show')) showFor(el); };
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
