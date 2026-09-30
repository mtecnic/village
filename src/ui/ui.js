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
 *   counter({value, format, duration, cls}) -> <span> whose number tweens on el.set(v); el.jump(v) sets instantly
 *   cards(items:[{value, icon, title, sub, desc, tip, disabled, badge, cls}], {value, columns, onSelect, render(item, card)})
 *       -> el.select(value), el.getValue(), el.cards (Map value -> card element)
 *   input({value, placeholder, maxLength, onInput, onEnter, cls, type}) -> <input class="input">
 *   kbd(label), badge(text, cls), section(title, ...children), row(...children), note(text)
 * FEEDBACK
 *   toast(html, {type: 'info'|'good'|'warn'|'bad', icon, duration, cls, onClick, sfx})
 *       html is sanitised (b/i/em/small/br/kbd/span… only, no attributes but class/style) as a safety net;
 *       emitters must still escape user text with VC.ui.esc. sfx: optional sound name to play with it
 *       (UI code toasts directly; only bus 'toast' also makes audio play a generic sound).
 *       Toasts live in a lane that avoids window title bars and the milestone banner (see layoutToasts).
 *   modal(title, content, [{label, cls, onClick}], {cls}) -> close fn          (Esc closes the top modal)
 *   confirm(text, onYes, {title, yes, no, danger})      text is sanitised HTML (escape user strings!)
 *   prompt(title, value, onOk(value), {text, placeholder, maxLength, ok})
 *   popover(anchorEl, content, {id, title, side:'top'|'bottom'|'left'|'right', cls, onClose}) -> {el, close()}
 *       one popover per id; closes on outside pointerdown or Esc.  VC.ui.closePopovers()
 * TOOLTIPS: any element with data-tip="..." (HTML allowed) shows a tooltip on hover. For live content
 *   also set el._tip = () => html; it is re-evaluated while the tooltip is visible.
 *   Rich tooltip classes (base.css): .tt-head .tt-icon .tt-desc .tt-grid (label/value pairs) .tt-foot .tt-lock
 * HELPERS: VC.ui.scale() current UI scale, VC.ui.signed(n) '+1,234', VC.ui.signedMoney(n) '+$1,234',
 *   VC.ui.flash(el, cls) (restart a CSS animation class), VC.ui.svg(tag, attrs, ...kids),
 *   VC.ui.esc(s) HTML-escapes any user / imported text (city, building, save names…) before it goes into
 *   innerHTML, data-tip, toast or confirm text; VC.ui.sanitize(html) -> DocumentFragment;
 *   VC.ui.isTextEntry(el) true for fields that take typing (hotkeys must stay off), false for sliders,
 *   checkboxes and buttons; VC.ui.layoutToasts(); VC.ui.toastAvoid (array of fn() -> rect|null).
 * Z-ORDER (all inside #ui, bounded): juice popups 0 < HUD chrome 0-5 < title menu 10 < windows layer 20 (its
 *   own stacking context; window z-indices are local and renormalised) < the tool bar while a palette is open 22
 *   (base.css, :has) < tutorial / advisor cards 25-26 < toasts 30 <
 *   milestone banner 35 < pause menu 40 (windows opened from it: 45) < popovers 50 < modals 60 <
 *   photo hint 70 < fade 80 < tooltip 100.
 * FOCUS: sliders, checkboxes, selects and buttons are blurred after a pointer interaction so game
 *   hotkeys keep working (text inputs keep focus).
 * UI scale: blocks use the CSS `scale: var(--ui-scale)` property (never `zoom`) so all layout math is in
 *   screen px. Position scaled floating elements with left/top or the `translate` property, not `transform`.
 * Bus: listens to 'toast' {text, type, icon, duration} (suppressed while the title-screen demo city runs).
 * EMOJI / LABELS: at init a canvas probe checks for a colour-emoji font; without one <html> gets class
 *   'no-emoji' (URL ?emoji=0 / ?emoji=1 forces it; a canvas that does not read back — privacy modes — counts
 *   as "has emoji"). A MutationObserver on #ui (batched per frame) makes every ICON-ONLY control (button,
 *   [role=button], .tab, .card, .seg-btn with no letters or digits in its text: emoji or symbols such as ×)
 *   accessible: it gets an aria-label (from aria-label / title / data-tip; 'Close' for a bare ×) and a title
 *   when it has no tooltip, and its emoji glyph element gets class 'ui-emo' + data-abbr (a short caption,
 *   e.g. 'Budget', 'Stats'), which base.css shows instead of the glyph under .no-emoji. In controls that
 *   also have a text label the emoji element gets 'ui-emo-deco' (hidden under .no-emoji: no tofu boxes next
 *   to the words). VC.ui.hasEmoji, VC.ui.abbr(label), VC.ui.labelIcons(root) (run the pass now).
 */
const h = VC.h;
const SVGNS = 'http://www.w3.org/2000/svg';
const wins = new Map();
const lastPos = new Map();
const modals = [];
const popovers = new Map();
const anims = new Set();
let zTop = 0; // window z-indices are local to the .ui-windows layer (see renormZ)
const Z_MAX = 400; // renormalise window z-indices past this

function sfx(name) {
  VC.bus.emit('sfx', { name: name || 'click' });
}

/* ---------------- escaping / sanitising ---------------- */
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML-escapes any value (null/undefined -> ''). Use for every user / imported string put into HTML. */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}
const SAFE_TAGS = new Set(['B', 'I', 'EM', 'STRONG', 'SMALL', 'BR', 'KBD', 'SPAN', 'DIV', 'U', 'S', 'SUB', 'SUP', 'P', 'UL', 'OL', 'LI', 'CODE', 'MARK', 'HR']);
/**
 * Parses html into an inert template and keeps only simple formatting tags with class/style attributes.
 * Anything else (img, script, a, svg, event handlers…) is shown as literal text. Returns a DocumentFragment.
 */
function sanitize(html) {
  const t = document.createElement('template');
  t.innerHTML = String(html == null ? '' : html);
  const walk = (node) => {
    for (const c of Array.from(node.childNodes)) {
      if (c.nodeType === 1) {
        if (!SAFE_TAGS.has(c.tagName)) {
          c.replaceWith(document.createTextNode(c.outerHTML));
          continue;
        }
        for (const a of Array.from(c.attributes)) {
          const n = a.name.toLowerCase();
          if ((n !== 'class' && n !== 'style') || /url\s*\(|expression\s*\(|javascript:/i.test(a.value)) c.removeAttribute(a.name);
        }
        walk(c);
      } else if (c.nodeType !== 3) c.remove();
    }
  };
  walk(t.content);
  return t.content;
}
const NON_TEXT_INPUT = /^(range|checkbox|radio|button|submit|reset|color|file|image)$/i;
/** True when el takes typed text (text fields, textareas, contenteditable). Sliders/checkboxes do not. */
function isTextEntry(el) {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !NON_TEXT_INPUT.test(el.type || 'text');
  return false;
}
/** Controls that must not keep keyboard focus after a pointer interaction (would swallow hotkeys). */
function isStickyControl(el) {
  if (!el || !el.tagName) return false;
  if (el.tagName === 'BUTTON' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && NON_TEXT_INPUT.test(el.type || 'text');
}

const ui = (VC.ui = {
  root: null,
  /** Extra rects toasts must not cover: functions returning a DOMRect-like {left,top,right,bottom} or null. */
  toastAvoid: [],
  init() {
    ui.root = document.getElementById('ui');
    ui.layer = h('div', { class: 'ui-windows' });
    ui.toasts = h('div', { class: 'ui-toasts lane-br' });
    ui.tip = h('div', { class: 'ui-tooltip' });
    ui.root.append(ui.layer, ui.toasts, ui.tip);
    VC.bus.on('toast', (t) => {
      if (!t || !t.text) return;
      if (VC.state && VC.state.demo && t.type !== 'error') return; // no game chatter over the title screen
      ui.toast(t.text, Object.assign({}, t, { sfx: null })); // audio already reacts to bus 'toast'
    });
    initTooltips();
    window.addEventListener('keydown', onKeyCapture, true);
    initFocusRelease();
    applyScale();
    VC.bus.on('settings', applyScale);
    window.addEventListener('resize', onResize);
    VC.bus.on('windowOpened', () => { layoutToasts(); requestAnimationFrame(layoutToasts); }); // again once content is in
    VC.bus.on('windowClosed', () => layoutToasts());
    initIconLabels();
  },
  esc,
  sanitize,
  isTextEntry,
  /** Effective UI scale: the user's setting x an automatic boost for very tall viewports (4K at DPR 1). */
  scale() {
    const s = VC.M.clamp(+((VC.settings && VC.settings.uiScale) || 1) || 1, 0.5, 2);
    const auto = VC.M.clamp(window.innerHeight / 1250, 1, 1.8);
    return Math.round(s * auto * 100) / 100;
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
    const closeBtn = o.closable === false ? null : h('button', { class: 'win-btn win-close', title: 'Close (Esc)', onclick: () => w.close() }, '×'); // audio voices 'windowClosed'
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
        const was = el.style.display === 'none';
        el.style.display = '';
        if (was) clampWin(w);
        w.focus();
      },
      hide() {
        el.style.display = 'none';
      },
      /** Brings the window to the front (no-op when it already is; z stays bounded, see renormZ). */
      focus() {
        if (w._z === zTop && zTop > 0) return;
        if (zTop >= Z_MAX) renormZ();
        w._z = ++zTop;
        el.style.zIndex = w._z;
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
      noteAnchor(w);
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
  /** Closes the top-most visible window. Returns true if one was closed. */
  closeTop() {
    const top = ui.topWindow();
    if (top && top.opts.closable !== false) { top.close(); return true; }
    return false;
  },
  /** Top-most visible window (or null). */
  topWindow() {
    let top = null;
    for (const w of wins.values()) if (w.el.style.display !== 'none' && (!top || (w._z || 0) > (top._z || 0))) top = w;
    return top;
  },
  /** Visible (not hidden) window ids. */
  visibleWindows: () => [...wins.values()].filter((w) => w.el.style.display !== 'none').map((w) => w.id),
  /**
   * Moves a window to screen px (x, y), clamped on screen. Used by the panels module for its own placement
   * so right-anchored windows keep following the right edge on resize.
   */
  placeWindow(id, x, y) {
    const w = wins.get(id);
    if (!w) return;
    w.el.style.left = Math.round(x) + 'px';
    w.el.style.top = Math.round(y) + 'px';
    clampWin(w);
    noteAnchor(w);
    layoutToasts();
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
        // private custom property: writing --accent itself could create a self-reference cycle
        // (color 'var(--accent)' -> `--accent: var(--accent)`), which invalidates the whole track
        const c = (typeof o.color === 'function' ? o.color(+input.value) : o.color) || '';
        if (c) input.style.setProperty('--sl-accent', c);
        else input.style.removeProperty('--sl-accent');
        val.style.color = typeof o.color === 'function' && c ? c : '';
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
    /** Sets the value immediately (no tween), e.g. when a new city is loaded. */
    el.jump = (v) => {
      cur = from = target = +v || 0;
      anims.delete(el);
      show(cur);
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
  /** Text field. onEscape(): called on Esc (e.g. close the dialog); without it Esc just leaves the field. */
  input(o = {}) {
    const el = h('input', { class: 'input ' + (o.cls || ''), type: o.type || 'text', placeholder: o.placeholder || '', maxlength: o.maxLength || 60, spellcheck: 'false', autocomplete: 'off' });
    el.value = o.value != null ? o.value : '';
    if (o.onInput) el.addEventListener('input', () => o.onInput(el.value));
    el.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing never triggers game hotkeys
      if (e.key === 'Enter' && o.onEnter) o.onEnter(el.value);
      if (e.key === 'Escape') {
        e.preventDefault();
        el.blur();
        if (o.onEscape) o.onEscape();
      }
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
    const txt = h('span', { class: 'toast-text' });
    txt.appendChild(sanitize(text));
    const el = h('div', { class: 'toast toast-' + type + ' ' + (o.cls || '') }, h('span', { class: 'toast-icon' }, icon), txt);
    ui.toasts.appendChild(el);
    // at most 4 on screen: drop the oldest (ignoring ones already fading out)
    const live = Array.from(ui.toasts.children).filter((c) => !c.classList.contains('out'));
    for (let i = 0; i < live.length - 4; i++) live[i].remove();
    const dur = o.duration || 3800;
    const out = () => {
      if (el.classList.contains('out')) return;
      el.classList.add('out');
      setTimeout(() => { el.remove(); layoutToasts(); }, 380);
    };
    setTimeout(out, dur);
    el.addEventListener('click', () => { if (o.onClick) o.onClick(); out(); });
    if (o.sfx) sfx(o.sfx);
    layoutToasts();
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
    const body = h('div');
    body.appendChild(sanitize(text));
    return ui.modal(o.title || 'Are you sure?', body, [{ label: o.no || 'Cancel' }, { label: o.yes || 'Yes', cls: o.danger ? 'danger' : 'primary', onClick: onYes }]);
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
  /** Re-picks the toast lane (call when something toasts must avoid appears or moves). */
  layoutToasts: () => layoutToasts(),
  /** True when a colour-emoji font is available (canvas probe; see the header). */
  hasEmoji: true,
  /** Short text caption for an icon-only control labelled `label` ('City Statistics' -> 'Stats'). */
  abbr: (label) => abbr(label),
  /** Labels the icon-only controls under root now (normally automatic). */
  labelIcons: (root) => labelPass(root || ui.root),
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
    e.stopImmediatePropagation();
    e.preventDefault();
    return;
  }
  if (popovers.size) {
    ui.closePopovers();
    e.stopImmediatePropagation();
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
    noteAnchor(w);
    lastPos.set(w.id, { x: el.offsetLeft, y: el.offsetTop });
    layoutToasts();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
/** Reassigns window z-indices 1..n in their current stacking order (keeps them small and bounded). */
function renormZ() {
  const list = [...wins.values()].sort((a, b) => (a._z || 0) - (b._z || 0));
  zTop = 0;
  for (const w of list) {
    w._z = ++zTop;
    w.el.style.zIndex = w._z;
  }
}
/**
 * Keeps a window on screen: entirely when it fits (it always should: .win max-width/height follow the
 * viewport), otherwise at least its title bar with the close button.
 */
function clampWin(w) {
  const el = w.el;
  if (el.style.display === 'none') return;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight, m = 8;
  const x = r.width <= vw - 2 * m ? VC.M.clamp(el.offsetLeft, m, vw - r.width - m) : Math.min(m, Math.max(vw - r.width - m, el.offsetLeft));
  let yMax = vh - 44;
  if (r.height <= vh - 2 * m) yMax = Math.min(yMax, vh - r.height - m);
  const y = VC.M.clamp(el.offsetTop, 0, Math.max(0, yMax));
  if (Math.round(x) !== el.offsetLeft) el.style.left = Math.round(x) + 'px';
  if (Math.round(y) !== el.offsetTop) el.style.top = Math.round(y) + 'px';
}
/** Windows sitting near the right edge stay anchored to it when the viewport or UI scale changes. */
function noteAnchor(w) {
  const el = w.el;
  if (el.style.display === 'none') return;
  const vw = window.innerWidth;
  const width = el.offsetWidth * ui.scale();
  const dr = vw - (el.offsetLeft + width);
  w.dockRight = dr >= 0 && dr < 100 && el.offsetLeft + width / 2 > vw / 2 ? dr : null;
}
function onResize() {
  applyScale();
  requestAnimationFrame(layoutToasts);
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
  const s = ui.scale();
  document.documentElement.style.setProperty('--ui-scale', s);
  const vw = window.innerWidth;
  wins.forEach((w) => {
    if (w.dockRight != null && w.el.style.display !== 'none') w.el.style.left = Math.round(vw - w.el.offsetWidth * s - w.dockRight) + 'px';
    clampWin(w);
  });
}

/* ---------------- toast lane ---------------- */
/**
 * Toasts never cover window title bars (close / minimise buttons) or the milestone banner (ui.toastAvoid).
 * Lanes in order of preference: bottom-right above the tile readout (clear of the top-anchored windows and
 * cards), top-centre under the top bar, bottom-left above the minimap. The first lane (in that order) whose
 * toasts touch no title bar / avoid rect wins; otherwise the least-overlapping one. Window bodies do not
 * count (toasts are short-lived and sit above them), so the lane does not hop around for small overlaps.
 */
const LANES = ['lane-br', 'lane-tc', 'lane-bl'];
let laneBusy = false;
function layoutToasts() {
  const box = ui.toasts;
  if (!box || laneBusy) return;
  const items = Array.from(box.children).filter((c) => !c.classList.contains('out'));
  if (!items.length) return;
  laneBusy = true;
  try {
    const avoid = [];
    for (const w of wins.values()) {
      if (w.el.style.display === 'none' || w.el.classList.contains('closing')) continue;
      avoid.push(w.head.getBoundingClientRect());
    }
    for (const fn of ui.toastAvoid) {
      let r = null;
      try { r = fn(); } catch (e) { r = null; }
      if (r) avoid.push(r);
    }
    const cur = LANES.find((l) => box.classList.contains(l)) || LANES[0];
    const score = () => {
      let s = 0;
      for (const t of items) {
        const b = t.getBoundingClientRect();
        for (const a of avoid) {
          const ix = Math.min(b.right, a.right) - Math.max(b.left, a.left);
          const iy = Math.min(b.bottom, a.bottom) - Math.max(b.top, a.top);
          if (ix > 6 && iy > 6) s += ix * iy; // a few px of shadow / rounded corner do not count
        }
      }
      return s;
    };
    let best = cur, bestScore = Infinity;
    for (const lane of LANES) {
      if (!box.classList.contains(lane)) { box.classList.remove(...LANES); box.classList.add(lane); }
      const sc = score();
      if (sc < bestScore) { best = lane; bestScore = sc; }
      if (sc === 0) break; // first free lane in preference order
    }
    if (!box.classList.contains(best)) { box.classList.remove(...LANES); box.classList.add(best); }
  } finally {
    laneBusy = false;
  }
}

/* ---------------- focus release ---------------- */
/**
 * After a pointer interaction with a slider, checkbox, select or button, drop its keyboard focus so game
 * hotkeys (Space, Esc, M, 1-0…) keep working. Keyboard users who tab to a control keep focus; text inputs
 * are never blurred.
 */
function initFocusRelease() {
  const release = () => {
    const a = document.activeElement;
    if (a && a !== document.body && isStickyControl(a) && ui.root.contains(a)) a.blur();
  };
  document.addEventListener('pointerup', (e) => {
    const a = document.activeElement;
    // only the control that was just used (a native <select> keeps focus while its dropdown is open)
    if (!a || a.tagName === 'SELECT' || !isStickyControl(a)) return;
    if (a.type === 'range' || (e.target && a.contains(e.target))) setTimeout(release, 0);
  }, true);
  document.addEventListener('change', (e) => {
    const t = e.target;
    // selects: the dropdown is closed once 'change' fires; checkboxes / radios toggle on click
    if (t && (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(t.type)))) setTimeout(release, 0);
  }, true);
}

/* ---------------- emoji support / icon-only control labels ---------------- */
/**
 * Colour-emoji probe: draws a house on a small canvas; no coloured pixel = no colour emoji font (Linux without
 * Noto Color Emoji, old Windows / macOS) -> the glyphs would be tofu or monochrome boxes.
 */
function probeEmoji() {
  const q = VC.params ? VC.params.get('emoji') : null;
  if (q === '0' || q === '1') return q === '1';
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 24;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return true;
    // readback sanity check: canvas privacy protections return blank / noisy pixels -> no verdict
    g.fillStyle = '#f00';
    g.fillRect(0, 0, 4, 4);
    const t = g.getImageData(1, 1, 1, 1).data;
    if (!(t[0] > 200 && t[1] < 60 && t[2] < 60)) return true;
    g.clearRect(0, 0, 24, 24);
    g.textBaseline = 'top';
    g.font = '18px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';
    g.fillText('\u{1F3E0}', 2, 2); // 🏠 (Emoji 1.0)
    const d = g.getImageData(0, 0, 24, 24).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 80 && Math.abs(d[i] - d[i + 1]) + Math.abs(d[i + 1] - d[i + 2]) > 60) return true;
    }
    return false;
  } catch (e) {
    return true; // unknown: keep the icons
  }
}
let EMO_RE = null;
try { EMO_RE = new RegExp('\\p{Extended_Pictographic}', 'u'); } catch (e) { EMO_RE = null; }
const EMO_STRIP = /[\s\uFE0E\uFE0F\u200D\u20E3]|\uD83C[\uDFFB-\uDFFF]/g;
/** True when text consists of emoji only (variation selectors, ZWJ and skin tones allowed). */
function emojiOnly(t) {
  if (!t || !EMO_RE) return false;
  const s = t.replace(EMO_STRIP, '');
  if (!s) return false;
  for (const ch of s) if (!EMO_RE.test(ch)) return false;
  return true;
}
const ABBR = {
  statistics: 'Stats', policies: 'Policy', advisors: 'Advice', milestones: 'Ranks', disasters: 'Hazard',
  education: 'Edu', transportation: 'Transit', landmarks: 'Sights', bulldozer: 'Doze', bulldoze: 'Doze', demolish: 'Doze',
  terraform: 'Terra', terrain: 'Terra', residential: 'Res', commercial: 'Com', industrial: 'Ind', utilities: 'Util',
  overlays: 'Maps', overlay: 'Maps', settings: 'Setup', screenshot: 'Photo', achievements: 'Awards', emergency: 'Emerg',
  recreation: 'Parks', services: 'Serv.', inspect: 'Info', select: 'Info', notifications: 'News', minimize: 'Min',
  how: 'Help', help: 'Help', population: 'Pop.', transport: 'Transit', sanitation: 'Waste', budget: 'Budget',
  pause: 'Pause', play: 'Play', fast: 'Fast', faster: 'Fast', ultra: 'Ultra', fullscreen: 'Full', mute: 'Sound',
  sound: 'Sound', audio: 'Sound', menu: 'Menu', advisor: 'Advice', inbox: 'Inbox', close: 'Close', dismiss: 'Close',
};
const STOP_WORDS = new Set(['city', 'the', 'and', 'of', 'a', 'an', 'my', 'to', 'new', 'open', 'show', 'toggle', 'your']);
function abbr(label) {
  const words = String(label || '').replace(/<[^>]*>/g, ' ').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const w = words.find((x) => !STOP_WORDS.has(x.toLowerCase())) || words[0] || '';
  const a = ABBR[w.toLowerCase()];
  if (a) return a;
  return w.length <= 6 ? w : w.slice(0, 5) + '.';
}
/** Plain-text label of a control: aria-label, title, else the first <b> (or all text) of its data-tip. */
function labelOf(el) {
  let l = el.getAttribute('aria-label') || el.getAttribute('title') || '';
  if (!l) {
    const tip = el.getAttribute('data-tip') || '';
    if (tip && tip !== '1') {
      const m = /<b>([^<]+)<\/b>/i.exec(tip);
      l = (m ? m[1] : tip.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    }
  }
  if (l.length > 70) l = l.slice(0, 68) + '…';
  if (l.indexOf('&') < 0) return l;
  const t = document.createElement('textarea'); // decode entities (&amp; …) without parsing HTML
  t.innerHTML = l;
  return t.value;
}
const ICON_CTRL = 'button, [role="button"], .tab, .card, .seg-btn';
let TEXT_RE = /[A-Za-z0-9\u00C0-\u024F\u0370-\u04FF]/;
try { TEXT_RE = new RegExp('[\\p{L}\\p{N}]', 'u'); } catch (e) { /* old engines: Latin / Greek / Cyrillic */ }
/** Default names for symbol-only controls without any label. */
const SYMBOL_NAMES = { '×': 'Close', '✕': 'Close', '✖': 'Close', '−': 'Minimize', '–': 'Minimize', '+': 'Expand', '?': 'Help' };
/** Labels one control: accessible name for icon-only controls, captions / decoration marks for emoji glyphs. */
function labelControl(el) {
  if (!el.isConnected) return;
  // the glyph carriers: leaf elements (or bare text nodes) whose text is emoji only
  const glyphs = [];
  let other = '';
  const walk = (n) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        const t = c.nodeValue;
        if (!t.trim()) continue;
        if (emojiOnly(t)) glyphs.push(c);
        else other += t;
      } else if (c.nodeType === 1) {
        const tag = c.tagName, cl = c.classList;
        if (tag === 'KBD' || tag === 'svg' || tag === 'SVG' || cl.contains('kbd') || cl.contains('tbt-key') || cl.contains('dock-label') || cl.contains('card-badge') || /badge/.test(c.className)) continue;
        if (!c.firstElementChild && emojiOnly(c.textContent)) glyphs.push(c);
        else walk(c);
      }
    }
  };
  walk(el);
  if (TEXT_RE.test(other)) {
    // a labelled control: its emoji are decoration (hidden without an emoji font)
    for (const g of glyphs) if (g.nodeType === 1 && !g.classList.contains('ui-emo-deco') && !g.classList.contains('ui-emo')) g.classList.add('ui-emo-deco');
    return;
  }
  let label = labelOf(el);
  if (!label && !glyphs.length) label = SYMBOL_NAMES[other.trim()] || '';
  if (!label) return;
  if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', label);
  if (!el.getAttribute('title') && !el.hasAttribute('data-tip') && !el._tip) el.setAttribute('title', label);
  if (ui.hasEmoji || !glyphs.length) return;
  const cap = abbr(label);
  for (let g of glyphs) {
    if (g.nodeType === 3) {
      const span = document.createElement('span');
      g.parentNode.insertBefore(span, g);
      span.appendChild(g);
      g = span;
    }
    if (g.dataset.abbr !== cap) g.dataset.abbr = cap;
    if (!g.classList.contains('ui-emo')) g.classList.add('ui-emo');
  }
}
function labelPass(root) {
  if (!root || root.nodeType !== 1) return;
  if (root.matches && root.matches(ICON_CTRL)) labelControl(root);
  const list = root.querySelectorAll(ICON_CTRL);
  for (let i = 0; i < list.length; i++) labelControl(list[i]);
}
function initIconLabels() {
  ui.hasEmoji = probeEmoji();
  document.documentElement.classList.toggle('no-emoji', !ui.hasEmoji);
  if (!window.MutationObserver) return;
  const pending = new Set();
  let raf = 0;
  const flush = () => {
    raf = 0;
    for (const el of pending) {
      try { labelPass(el); } catch (e) { /* never break the UI over a label */ }
    }
    pending.clear();
  };
  const mo = new MutationObserver((recs) => {
    for (let r = 0; r < recs.length; r++) {
      const added = recs[r].addedNodes;
      for (let i = 0; i < added.length; i++) {
        const n = added[i];
        if (n.nodeType === 1) pending.add(n);
        else if (!ui.hasEmoji && n.nodeType === 3 && n.parentElement && !n.parentElement.classList.contains('ui-emo')) {
          // a control whose glyph text was replaced (e.g. a toggle icon) needs its caption again
          const c = n.parentElement.closest && n.parentElement.closest(ICON_CTRL);
          if (c) pending.add(c);
        }
      }
    }
    if (pending.size && !raf) raf = requestAnimationFrame(flush);
  });
  mo.observe(ui.root, { childList: true, subtree: true });
  pending.add(ui.root);
  raf = requestAnimationFrame(flush);
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
  // headroom below the data, but never below zero for non-negative data (no "-360 people" labels)
  if (o.min == null) lo = lo >= 0 ? Math.max(0, lo - span * 0.05) : lo - span * 0.05;
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
