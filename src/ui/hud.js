/*
 * VOXELPOLIS — HUD core (VC.hud).
 *   TOP BAR     city name + milestone progress, date / weather / clock, speed controls, funds (animated,
 *               monthly net), population (+trend), approval face (neutral '—' until the first residents),
 *               RCI demand meter, power/water load pills, mute / fullscreen / pause-menu buttons. Rich live
 *               tooltips on every segment. Compacts (c1..c4) while overflowing; re-measured every 5 s so a
 *               transient overflow does not keep it compact.
 *   DOCK        right-side manager buttons (VC.panels.list, or a built-in fallback list) + overlays,
 *               photo mode, settings, help. Active-window highlight, unread-advisor badge, auto-compacts.
 *   READOUT     bottom-right FPS (VC.settings.showFps) + hovered tile info.
 *   VISIBILITY  show()/hide() (game vs title screen), toggleUI(visible?) (H), photoMode(on?) (UI off +
 *               cinematic camera + screenshot button), floating money deltas over the funds display.
 *   HOTKEYS     fallback handling ONLY when VC.input has no KEYMAP (the foundation input); the real
 *               input module handles keys centrally and emits 'toolGroup'.
 * Sub-parts (hud_*.js) register with VC.hud.register({name, order, init(root), reset(S), update(dt, rdt),
 * onShow(), onHide()}). Public API: show, hide, toggleUI, photoMode, openSettings, openHelp, isVisible,
 * panel(key), openPalette(group), closePalette(), openOverlayPicker(anchor, side), startTutorial().
 */
const h = VC.h, M = VC.M;

const LOGO_SVG = '<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="vpl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9f6ff"/><stop offset="1" stop-color="#7fdcff"/></linearGradient></defs><path d="M16 2.5 29 10 16 17.5 3 10Z" fill="url(#vpl)"/><path d="M3 10l13 7.5V31L3 23.5Z" fill="#36a6e8"/><path d="M29 10 16 17.5V31l13-7.5Z" fill="#8f6bff"/><path d="M16 17.5V31" stroke="rgba(255,255,255,.35)" stroke-width=".8"/></svg>';
const SPEED_SVG = [
  '<svg viewBox="0 0 16 16"><rect x="3.5" y="3" width="3.2" height="10" rx="1"/><rect x="9.3" y="3" width="3.2" height="10" rx="1"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M5 3.3v9.4c0 .6.6.9 1.1.6l7-4.7c.4-.3.4-.9 0-1.2l-7-4.7C5.6 2.4 5 2.7 5 3.3z"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M1.6 3.6v8.8c0 .5.5.7.9.4L8 8.4c.3-.2.3-.6 0-.8L2.5 3.2c-.4-.3-.9-.1-.9.4zM8 3.6v8.8c0 .5.5.7.9.4l5.5-4.4c.3-.2.3-.6 0-.8L8.9 3.2c-.4-.3-.9-.1-.9.4z"/></svg>',
  '<svg viewBox="0 0 16 16"><path d="M.4 4.3v7.4c0 .4.4.6.7.3l4.2-3.7c.2-.2.2-.5 0-.6L1.1 4c-.3-.3-.7-.1-.7.3zM5.6 4.3v7.4c0 .4.4.6.7.3l4.2-3.7c.2-.2.2-.5 0-.6L6.3 4c-.3-.3-.7-.1-.7.3zM10.8 4.3v7.4c0 .4.4.6.7.3l4.2-3.7c.2-.2.2-.5 0-.6L11.5 4c-.3-.3-.7-.1-.7.3z"/></svg>',
];
const SPEED_TIPS = ['<b>Pause</b> <kbd>Space</kbd>', '<b>Normal speed</b> — 1 day / second', '<b>Fast</b> — 3 days / second', '<b>Ultra</b> — 8 days / second'];
const SND_SVG = ['<svg viewBox="0 0 16 16"><path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor"/><path d="M10.4 5.6a3.4 3.4 0 0 1 0 4.8M12.3 3.8a6 6 0 0 1 0 8.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>', '<svg viewBox="0 0 16 16"><path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor"/><path d="M10.5 6l4 4M14.5 6l-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'];
const FS_SVG = '<svg viewBox="0 0 16 16"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MENU_SVG = '<svg viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';

/** Built-in manager list (used while VC.panels.list is empty). hotkey = KeyboardEvent.code. */
const PANEL_FALLBACK = [
  { key: 'budget', name: 'Budget & Taxes', icon: '💰', hotkey: 'KeyM' },
  { key: 'policies', name: 'Policies', icon: '📜', hotkey: 'KeyP' },
  { key: 'stats', name: 'City Statistics', icon: '📈', hotkey: 'KeyG' },
  { key: 'population', name: 'Population & Demand', icon: '👥', hotkey: 'KeyU' },
  { key: 'services', name: 'City Services', icon: '🚓', hotkey: 'KeyV' },
  { key: 'utilities', name: 'Power & Water', icon: '⚡', hotkey: 'KeyY' },
  { key: 'advisors', name: 'Advisors', icon: '🧑‍💼', hotkey: 'KeyN' },
  { key: 'milestones', name: 'Milestones', icon: '🏆', hotkey: 'KeyJ' },
  { key: 'disasters', name: 'Disasters', icon: '🌪️', hotkey: 'KeyX' },
  { key: 'save', name: 'Save & Load', icon: '💾', hotkey: 'KeyK' },
];
const SEASONS = [
  { name: 'Winter', icon: '❄️' }, { name: 'Winter', icon: '❄️' }, { name: 'Spring', icon: '🌸' }, { name: 'Spring', icon: '🌸' }, { name: 'Spring', icon: '🌸' },
  { name: 'Summer', icon: '🌻' }, { name: 'Summer', icon: '🌻' }, { name: 'Summer', icon: '🌻' }, { name: 'Autumn', icon: '🍂' }, { name: 'Autumn', icon: '🍂' },
  { name: 'Autumn', icon: '🍂' }, { name: 'Winter', icon: '❄️' },
];
const WEATHER_NAMES = { clear: 'Clear skies', cloudy: 'Cloudy', overcast: 'Overcast', rain: 'Rain', storm: 'Thunderstorm', snow: 'Snowfall', fog: 'Fog', windy: 'Windy' };

const T = {}; // top bar element refs
const D = { btns: new Map(), sig: '' }; // dock
const cache = new Map(); // el -> last text (avoid redundant DOM writes)
let tAcc = 0, slowAcc = 0, infoAcc = 0, fpsAcc = 0, layoutAcc = 0;
let popRing = [];
let netCache = { t: -1, net: 0, fc: null };
let moneyAcc = 0, moneyT = 0;
let mouseOnCanvas = false, lastTile = null;

function safe(fn, what) {
  try { return fn(); } catch (e) { console.error('[hud] ' + what, e); VC.errors && VC.errors.length < 50 && VC.errors.push('hud ' + what + ': ' + (e && e.message)); }
}
function setText(el, s) {
  if (cache.get(el) === s) return;
  cache.set(el, s);
  el.textContent = s;
}
function setCls(el, cls, on) {
  if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
}
const menuActive = () => !!(VC.menu && VC.menu.active);
const isDemo = (S) => !!(S && S.demo);
const keyLabel = (code) => (code ? String(code).replace(/^Key|^Digit/, '') : '');

const hud = (VC.hud = {
  parts: [],
  root: null,
  visible: false,
  uiHidden: false,
  photo: false,

  register(part) {
    hud.parts.push(part);
    hud.parts.sort((a, b) => (a.order || 0) - (b.order || 0));
  },

  init() {
    const ui = VC.ui;
    hud.root = h('div', { class: 'hud off' });
    ui.root.insertBefore(hud.root, ui.layer);
    buildTop();
    buildDock();
    buildReadout();
    buildPhotoHint();
    // slots: tutorial card top-left; advisor / disaster notes top-right (beside the dock)
    hud.slots = { tutorial: h('div', { class: 'hl-tut' }), notes: h('div', { class: 'hl-notes' }) };
    hud.root.appendChild(h('div', { class: 'hud-left' }, hud.slots.tutorial));
    hud.root.appendChild(h('div', { class: 'hud-right' }, hud.slots.notes));
    for (const p of hud.parts) if (p.init) safe(() => p.init(hud.root), p.name + '.init');

    const bus = VC.bus;
    const onStart = (S) => { if (S && !isDemo(S) && !menuActive()) hud.show(); };
    bus.on('newGame', onStart);
    bus.on('started', onStart);
    bus.on('speed', refreshSpeed);
    bus.on('windowOpened', refreshDockActive);
    // a window opened while the interface is hidden (H / photo mode, e.g. by a hotkey) brings the UI back
    // instead of sitting there invisibly
    bus.on('windowOpened', () => { if (hud.uiHidden) revealUI(); });
    bus.on('windowClosed', refreshDockActive);
    // low quality: drop backdrop blur (the most expensive UI effect over a live canvas)
    const applyLite = () => VC.ui.root.classList.toggle('lite', !!VC.settings && VC.settings.quality === 'low');
    applyLite();
    bus.on('settings', () => { applyLite(); layoutDock(); refreshReadoutVis(); refreshMute(); });
    bus.on('day', () => {
      const S = VC.state;
      if (!S) return;
      popRing.push(S.stats.pop || 0);
      if (popRing.length > 31) popRing.shift();
    });
    bus.on('money', (m) => {
      if (!hud.visible || !m || !isFinite(m.amount)) return;
      moneyAcc += m.amount;
    });
    bus.on('month', () => { netCache.t = -1; });
    window.addEventListener('resize', layoutDock);
    window.addEventListener('keydown', onKeyCapture, true);
    window.addEventListener('keydown', onKeyFallback);
    window.addEventListener('pointermove', (e) => {
      mouseOnCanvas = e.target === VC.gfx.canvas;
      if (hud.photo) pokePhotoHint();
    }, { passive: true });
    document.addEventListener('fullscreenchange', () => setCls(T.fs, 'on', !!document.fullscreenElement));
  },

  reset(S) {
    popRing = [];
    netCache = { t: -1, net: 0, fc: null };
    moneyAcc = 0;
    cache.clear();
    if (T.money) T.money.jump(S.money);
    if (T.pop) T.pop.jump((S.stats && S.stats.pop) || 0);
    ensureDock();
    for (const p of hud.parts) if (p.reset) safe(() => p.reset(S), p.name + '.reset');
    refreshTop(true);
    refreshSpeed();
  },

  update(dt, rdt) {
    const S = VC.state;
    if (!S || !hud.root) return;
    const parts = hud.parts;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p.update || !(hud.visible || p.always) || p._dead > 20) continue;
      try { p.update(dt, rdt); } catch (e) {
        // log the first failure, give up on a part that keeps throwing
        if (!p._dead) { console.error('[hud] ' + p.name + '.update', e); VC.errors.push('hud ' + p.name + '.update: ' + (e && e.message)); }
        p._dead = (p._dead || 0) + 1;
      }
    }
    if (!hud.visible) return;
    tAcc += rdt;
    if (tAcc >= 0.2) { tAcc = 0; safe(refreshTop, 'refreshTop'); }
    slowAcc += rdt;
    if (slowAcc >= 1) {
      slowAcc = 0;
      safe(refreshDockBadges, 'badges');
      layoutAcc += 1;
      // numbers grew: compact further now; every 5 s re-measure from scratch so compaction is not sticky
      if (T.bar.scrollWidth > T.bar.clientWidth + 1 || layoutAcc >= 5) { layoutAcc = 0; layoutTop(); }
    }
    fpsAcc += rdt;
    if (fpsAcc >= 0.5) { fpsAcc = 0; refreshFps(); }
    infoAcc += rdt;
    if (infoAcc >= 0.12) { infoAcc = 0; safe(refreshTileInfo, 'tileInfo'); }
    // aggregated floating money deltas (+$ / −$ over the funds display)
    moneyT += rdt;
    if (moneyT >= 0.35) {
      moneyT = 0;
      if (Math.abs(moneyAcc) >= 1) floatMoney(moneyAcc);
      moneyAcc = 0;
    }
  },

  /* ---------------- visibility ---------------- */
  show() {
    if (!hud.root) return;
    hud.visible = true;
    ensureDock();
    hud.root.classList.remove('off');
    layoutDock();
    refreshTop(true);
    refreshSpeed();
    refreshReadoutVis();
    for (const p of hud.parts) if (p.onShow) safe(() => p.onShow(), p.name + '.onShow');
  },
  hide() {
    if (!hud.root) return;
    hud.visible = false;
    hud.root.classList.add('off');
    if (hud.uiHidden) hud.toggleUI(true);
    VC.ui.closePopovers && VC.ui.closePopovers();
    for (const p of hud.parts) if (p.onHide) safe(() => p.onHide(), p.name + '.onHide');
  },
  isVisible: () => hud.visible && !hud.uiHidden,
  /** Leaves hidden-UI / photo mode (no-op when the UI is showing). */
  revealUI: () => revealUI(),
  /** Hides / shows ALL interface (windows included). visible: true/false, or omit to toggle. */
  toggleUI(visible) {
    const ui = VC.ui;
    const show = visible != null ? !!visible : hud.uiHidden;
    if (!show && !hud.visible) return; // nothing to hide on the title screen
    hud.uiHidden = !show;
    ui.root.classList.toggle('ui-hidden', hud.uiHidden);
    if (hud.uiHidden) {
      ui.closePopovers && ui.closePopovers();
      ui.hideTip && ui.hideTip();
      T.photoHint.classList.add('show');
      pokePhotoHint();
    } else {
      T.photoHint.classList.remove('show');
      if (hud.photo) { hud.photo = false; if (VC.camera) VC.camera.cinematic = false; }
    }
  },
  /** Photo mode: UI hidden + slow cinematic orbit + a screenshot button. */
  photoMode(on) {
    on = on == null ? !hud.photo : !!on;
    if (on) {
      if (!hud.visible) return;
      hud.toggleUI(false);
      hud.photo = true;
      if (VC.camera) VC.camera.cinematic = true;
      T.photoHint.classList.add('photo');
      VC.bus.emit('sfx', { name: 'click' });
    } else {
      hud.photo = false;
      T.photoHint.classList.remove('photo');
      if (VC.camera) VC.camera.cinematic = false;
      hud.toggleUI(true);
    }
  },
  /** Opens / toggles a manager panel (falls back to a toast while the panels module is a stub). */
  panel(key) {
    const P = VC.panels;
    VC.bus.emit('panelRequest', key);
    if (P && P.toggle && P.list && P.list.length) P.toggle(key);
    else if (P && P.open && P.list && P.list.length) P.open(key);
    else {
      const e = PANEL_FALLBACK.find((x) => x.key === key);
      VC.ui.toast(`${e ? e.icon + ' <b>' + escapeHtml(e.name) + '</b>' : escapeHtml(key)} is not available yet.`, { type: 'info' });
    }
  },
  openPanel(key) {
    const P = VC.panels;
    if (P && P.open && P.list && P.list.length) { VC.bus.emit('panelRequest', key); P.open(key); }
    else hud.panel(key);
  },
  /** Forces an immediate top-bar refresh (e.g. after renaming the city). */
  refresh() {
    netCache.t = -1;
    cache.clear();
    refreshTop(true);
  },
  /** Shakes the funds display red (e.g. not enough money). */
  flashFunds() {
    if (T.moneySeg) VC.ui.flash(T.moneySeg, 'shake-bad');
  },
  // placeholders, replaced by hud_settings.js / hud_tools.js / hud_map.js / hud_tutorial.js
  openSettings() {},
  openHelp() {},
  openPalette() {},
  closePalette() {},
  openOverlayPicker() {},
  startTutorial() {},
  /** Current dock / manager list: [{key, name, icon, hotkey}] */
  panelList() {
    const L = VC.panels && VC.panels.list;
    const list = L && L.length ? L.filter((p) => p && p.key && p.key !== 'inspector' && p.key !== 'loans' && !p.hidden) : PANEL_FALLBACK;
    return list;
  },
});

/* ================================================================== */
/* TOP BAR                                                             */
/* ================================================================== */
function seg(cls, kids, o = {}) {
  const el = h('div', { class: 'tb-seg ' + cls + (o.click ? ' click' : ''), 'data-tip': o.tip ? '1' : null, onclick: o.click ? () => { VC.bus.emit('sfx', { name: 'click' }); o.click(); } : null }, kids);
  if (o.tip) el._tip = o.tip;
  return el;
}
function buildTop() {
  const ui = VC.ui;
  // city
  T.name = h('span', { class: 'tb-name' });
  T.rename = h('button', { class: 'tb-rename', 'data-tip': 'Rename city', onclick: (e) => { e.stopPropagation(); renameCity(); } }, '✏️');
  T.ms = h('span', { class: 'tb-ms' });
  T.msFill = h('i');
  T.city = seg('tb-city', [h('div', { class: 'tb-logo', html: LOGO_SVG }), h('div', { class: 'tb-col' }, h('div', { class: 'tb-namerow' }, T.name, T.rename), h('div', { class: 'tb-sub' }, T.ms, h('div', { class: 'tb-msbar' }, T.msFill)))], { click: () => hud.panel('milestones'), tip: cityTip });
  // date / weather / clock
  T.wx = h('span', { class: 'tb-wx' });
  T.date = h('div', { class: 'tb-main tb-date-main' });
  T.dsub = h('div', { class: 'tb-sub' });
  T.dateSeg = seg('tb-date', [T.wx, h('div', { class: 'tb-col' }, T.date, T.dsub)], { tip: dateTip });
  // speed
  T.speed = [];
  const sp = h('div', { class: 'tb-speed' });
  for (let i = 0; i < 4; i++) {
    const b = h('button', { class: 'sp-btn sp' + i, 'data-tip': SPEED_TIPS[i], 'aria-label': ['Pause', 'Normal speed', 'Fast', 'Ultra fast'][i], html: SPEED_SVG[i], onclick: () => { VC.bus.emit('sfx', { name: 'click' }); VC.setSpeed(i); } });
    T.speed.push(b);
    sp.appendChild(b);
  }
  // funds
  T.money = ui.counter({ format: VC.fmt.money, cls: 'tb-main tb-money-val' });
  T.net = h('div', { class: 'tb-sub tb-net' });
  T.moneySeg = seg('tb-money', [h('span', { class: 'tb-icon' }, '💰'), h('div', { class: 'tb-col' }, T.money, T.net)], { click: () => hud.panel('budget'), tip: moneyTip });
  T.floats = h('div', { class: 'tb-floats' });
  T.moneySeg.appendChild(T.floats);
  // population
  T.pop = ui.counter({ format: VC.fmt.num, cls: 'tb-main' });
  T.popSub = h('div', { class: 'tb-sub' });
  T.popSeg = seg('tb-pop', [h('span', { class: 'tb-icon' }, '👥'), h('div', { class: 'tb-col' }, T.pop, T.popSub)], { click: () => hud.panel('population'), tip: popTip });
  // approval
  T.face = h('span', { class: 'tb-face' }, '🙂');
  T.happy = h('div', { class: 'tb-main' });
  T.happyFill = h('i');
  T.happySeg = seg('tb-happy', [T.face, h('div', { class: 'tb-col' }, T.happy, h('div', { class: 'tb-hbar' }, T.happyFill))], { click: () => hud.panel('stats'), tip: happyTip });
  // RCI
  T.rci = {};
  const rciKids = ['R', 'C', 'I'].map((k) => {
    const fill = h('i', { class: 'rci-fill' });
    T.rci[k] = fill;
    return h('div', { class: 'rci-col rci-' + k }, h('div', { class: 'rci-track' }, fill), h('span', { class: 'rci-lbl' }, k));
  });
  T.rciSeg = seg('tb-rci', rciKids, { click: () => hud.panel('population'), tip: rciTip });
  // utilities
  T.pw = utilPill('⚡', 'power');
  T.wt = utilPill('💧', 'water');
  T.utilSeg = h('div', { class: 'tb-util' }, T.pw.el, T.wt.el);
  // system
  T.mute = h('button', { class: 'tb-sys-btn tb-mute', 'aria-label': 'Mute sound', 'data-tip': '1', onclick: toggleMute });
  T.mute._tip = () => (VC.settings && VC.settings.muted ? '<b>Sound is muted</b><br>Click to turn it back on' : '<b>Mute all sound</b><br>Volumes: ⚙️ Settings → Audio');
  refreshMute();
  T.fs = h('button', { class: 'tb-sys-btn tb-fs', 'aria-label': 'Fullscreen', 'data-tip': '<b>Fullscreen</b> <kbd>F11</kbd>', html: FS_SVG, onclick: toggleFullscreen });
  T.menuBtn = h('button', { class: 'tb-sys-btn', 'aria-label': 'Game menu', 'data-tip': '<b>Game menu</b> <kbd>Esc</kbd>', html: MENU_SVG, onclick: () => { VC.bus.emit('sfx', { name: 'click' }); VC.menu && VC.menu.pause && VC.menu.pause(); } });

  const sep = () => h('div', { class: 'tb-sep' });
  T.bar = h('div', { class: 'hud-top pe' },
    T.city, sep(), T.dateSeg, sp,
    h('div', { class: 'tb-flex' }),
    T.moneySeg, sep(), T.popSeg, sep(), T.happySeg, sep(), T.rciSeg, sep(), T.utilSeg,
    h('div', { class: 'tb-flex' }),
    h('div', { class: 'tb-sys' }, T.mute, T.fs, T.menuBtn));
  hud.root.appendChild(h('div', { class: 'hud-topwrap' }, T.bar));
}
function utilPill(icon, kind) {
  const val = h('span', { class: 'up-val' });
  const fill = h('i');
  const el = h('div', { class: 'tb-pill up-' + kind, 'data-tip': '1', onclick: () => { VC.bus.emit('sfx', { name: 'click' }); hud.panel('utilities'); } }, h('span', { class: 'up-icon' }, icon), h('div', { class: 'up-col' }, val, h('div', { class: 'up-bar' }, fill)));
  el._tip = () => utilTip(kind);
  return { el, val, fill };
}

const NAME_MAX = 32; // same limit as the New City dialog
function renameCity() {
  const S = VC.state;
  if (!S) return;
  VC.ui.prompt('✏️ Rename your city', S.name, (v) => {
    // plain text only: markup characters are dropped (the name also appears in other modules' messages)
    const name = String(v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    if (!name) return;
    S.name = name;
    cache.delete(T.name);
    refreshTop(true);
    layoutTop();
    VC.bus.emit('cityRenamed', S.name);
    VC.ui.toast(`Welcome to <b>${escapeHtml(S.name)}</b>!`, { type: 'good', icon: '🏙️', sfx: 'success' });
  }, { placeholder: 'City name', maxLength: NAME_MAX, ok: 'Rename' });
}
/** HTML-escape (shared implementation: VC.ui.esc). Kept as VC.hud.escapeHtml for existing callers. */
function escapeHtml(s) {
  return VC.ui && VC.ui.esc ? VC.ui.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
VC.hud.escapeHtml = escapeHtml;

function toggleMute() {
  VC.bus.emit('sfx', { name: 'click' });
  if (!VC.settings) return;
  VC.settings.muted = !VC.settings.muted;
  VC.saveSettings();
  refreshMute();
}
function refreshMute() {
  if (!T.mute) return;
  const m = !!(VC.settings && VC.settings.muted);
  if (T.mute._m === m) return;
  T.mute._m = m;
  T.mute.innerHTML = SND_SVG[m ? 1 : 0];
  setCls(T.mute, 'on', m);
  T.mute.setAttribute('aria-label', m ? 'Unmute sound' : 'Mute sound');
}

function toggleFullscreen() {
  VC.bus.emit('sfx', { name: 'click' });
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  } catch (e) { /* not allowed */ }
}

/** Milestone index to display: S.milestone, unless the advisors module is not tracking it. */
function milestoneIndex(S) {
  let calc = 0;
  for (let i = 0; i < VC.MILESTONES.length; i++) if ((S.peakPop || 0) >= VC.MILESTONES[i].pop) calc = i;
  const idx = S.milestone | 0;
  return Math.min(VC.MILESTONES.length - 1, calc > idx + 1 ? calc : idx);
}
VC.hud.milestoneIndex = milestoneIndex;
function todOf(S) {
  const e = VC.gfx && VC.gfx.env;
  return e && e.tod != null ? e.tod : S.time.tod;
}
function isNight(tod) {
  return tod < 0.23 || tod > 0.8;
}
function weatherIcon(S) {
  const w = S.weather || {};
  const night = isNight(todOf(S));
  switch (w.type) {
    case 'rain': return '🌧️';
    case 'storm': return '⛈️';
    case 'snow': return '🌨️';
    case 'fog': return '🌫️';
    case 'windy': return '💨';
    case 'cloudy': case 'overcast': return night ? '☁️' : '⛅';
    default: {
      const t = todOf(S);
      if (t > 0.72 && t < 0.8) return '🌇';
      if (t > 0.22 && t < 0.28) return '🌅';
      return night ? '🌙' : (w.cloud || 0) > 0.55 ? '⛅' : '☀️';
    }
  }
}
/** Day-phase glyph for the clock: sunrise, day, sunset, night. */
function todIcon(S) {
  const t = todOf(S);
  return t > 0.2 && t < 0.3 ? '🌅' : t >= 0.3 && t <= 0.7 ? '☀️' : t > 0.7 && t < 0.8 ? '🌇' : '🌙';
}
function clock(S) {
  const t = todOf(S);
  const mins = Math.floor((t * 24 * 60) / 10) * 10;
  return String(Math.floor(mins / 60) % 24).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
}
function faceOf(v) {
  return v >= 0.8 ? '😄' : v >= 0.65 ? '🙂' : v >= 0.5 ? '😐' : v >= 0.35 ? '🙁' : '😡';
}
function approvalOf(S) {
  const st = S.stats || {};
  const v = st.approval != null ? st.approval : st.happiness;
  return v == null || !isFinite(v) ? 0.6 : M.sat(v);
}
function monthlyNet(S) {
  const now = performance.now();
  if (netCache.t >= 0 && now - netCache.t < 2000) return netCache.net;
  let net = (S.stats && S.stats.net) || 0, fc = null;
  try {
    fc = VC.econ && VC.econ.forecast ? VC.econ.forecast() : null;
    if (fc && (fc.totalIncome || fc.totalExpenses) && isFinite(fc.net)) net = fc.net;
  } catch (e) { fc = null; }
  netCache = { t: now, net, fc };
  return net;
}
function popTrend(S) {
  const pop = (S.stats && S.stats.pop) || 0;
  if (popRing.length >= 5) return ((pop - popRing[0]) * 30) / popRing.length;
  const hp = S.history && S.history.pop;
  if (hp && hp.length >= 2) return hp[hp.length - 1] - hp[hp.length - 2];
  return 0;
}

function refreshTop(force) {
  const S = VC.state;
  if (!S || !T.bar) return;
  const st = S.stats || {};
  // city
  setText(T.name, S.name || 'Voxelpolis');
  const mi = milestoneIndex(S);
  const ms = VC.MILESTONES[mi] || VC.MILESTONES[0], next = VC.MILESTONES[mi + 1];
  setText(T.ms, ms.name);
  const prog = next ? M.sat(((S.peakPop || 0) - ms.pop) / (next.pop - ms.pop)) : 1;
  T.msFill.style.width = (prog * 100).toFixed(1) + '%';
  // date
  setText(T.date, VC.fmt.fullDate(S.time.day));
  const month = Math.floor(S.time.day / VC.C.DAYS_PER_MONTH) % 12;
  const season = SEASONS[month];
  setText(T.dsub, season.icon + ' ' + season.name + ' · ' + todIcon(S) + ' ' + clock(S));
  setText(T.wx, weatherIcon(S));
  const mp = ((S.time.day % VC.C.DAYS_PER_MONTH) + 1) / VC.C.DAYS_PER_MONTH;
  if (T.wx._mp !== mp) { T.wx._mp = mp; T.wx.style.setProperty('--mp', mp.toFixed(3)); }
  setCls(T.dateSeg, 'paused', S.time.speed === 0);
  // funds
  T.money.set(S.money);
  setCls(T.moneySeg, 'neg', S.money < 0);
  const net = monthlyNet(S);
  setText(T.net, (net >= 0 ? '▲ ' : '▼ ') + VC.ui.signedMoney(net) + '/mo');
  setCls(T.net, 'good', net > 0.5);
  setCls(T.net, 'bad', net < -0.5);
  // population
  T.pop.set(st.pop || 0);
  const tr = popTrend(S);
  setText(T.popSub, Math.abs(tr) < 0.5 ? '▬ steady' : (tr > 0 ? '▲ ' : '▼ ') + VC.ui.signed(tr) + '/mo');
  setCls(T.popSub, 'good', tr >= 0.5);
  setCls(T.popSub, 'bad', tr <= -0.5);
  // approval (nobody to ask yet in an empty city: neutral face, no number)
  if (!(st.pop > 0)) {
    setText(T.face, '😐');
    setText(T.happy, '—');
    T.happyFill.style.width = '0%';
  } else {
    const ap = approvalOf(S);
    setText(T.face, faceOf(ap));
    setText(T.happy, Math.round(ap * 100) + '%');
    T.happyFill.style.width = (ap * 100).toFixed(0) + '%';
    T.happyFill.style.background = ap >= 0.65 ? 'var(--good)' : ap >= 0.45 ? 'var(--warn)' : 'var(--bad)';
  }
  // RCI
  const dm = S.demand || {};
  for (const k of ['R', 'C', 'I']) {
    const v = M.clamp(+dm[k] || 0, -1, 1);
    const f = T.rci[k];
    const s = (Math.abs(v) < 0.02 ? 0.02 : Math.abs(v)).toFixed(3);
    const tf = `scaleY(${v < 0 ? -s : s})`;
    if (f._tf !== tf) { f._tf = tf; f.style.transform = tf; }
    setCls(f, 'neg', v < 0);
  }
  // utilities
  utilUpdate(T.pw, st.powerSupply || 0, st.powerDemand || 0);
  utilUpdate(T.wt, st.waterSupply || 0, st.waterDemand || 0);
}
/** Load pill: demand as a share of supply (100% = fully used; red above). */
function utilUpdate(p, sup, dem) {
  let state = 'ok', txt, w = 0;
  if (sup <= 0 && dem <= 0) { state = 'idle'; txt = '—'; }
  else if (sup <= 0) { state = 'bad'; txt = 'NONE'; w = 100; }
  else {
    const r = dem / sup;
    txt = r >= 9.995 ? '>999%' : Math.round(r * 100) + '%';
    if (dem > sup) state = 'bad';
    else if (r > 0.88) state = 'warn';
    w = Math.min(100, r * 100);
  }
  const ws = w.toFixed(0) + '%';
  if (p.fill._w !== ws) { p.fill._w = ws; p.fill.style.width = ws; }
  setText(p.val, txt);
  for (const s of ['ok', 'warn', 'bad', 'idle']) setCls(p.el, s, s === state);
}
function refreshSpeed() {
  const S = VC.state;
  const sp = S ? S.time.speed : 1;
  T.speed.forEach((b, i) => setCls(b, 'active', i === sp));
  if (S && T.dateSeg) setCls(T.dateSeg, 'paused', sp === 0);
}

/* ---------------- floating money deltas ---------------- */
function floatMoney(amount) {
  if (!T.floats || hud.uiHidden) return;
  if (VC.state && VC.state.sandbox) return;
  const el = h('span', { class: 'tb-float ' + (amount >= 0 ? 'good' : 'bad') }, VC.ui.signedMoney(amount));
  T.floats.appendChild(el);
  while (T.floats.children.length > 4) T.floats.firstChild.remove();
  setTimeout(() => el.remove(), 1600);
}

/* ---------------- live tooltips ---------------- */
function cityTip() {
  const S = VC.state;
  if (!S) return '';
  const mi = milestoneIndex(S);
  const ms = VC.MILESTONES[mi], next = VC.MILESTONES[mi + 1];
  let s = `<div class="tt-head"><span class="tt-icon">🏙️</span>${escapeHtml(S.name)}</div><div class="tt-desc">${ms.name} · founded ${VC.fmt.date(90)}</div><div class="tt-grid">`;
  s += `<span>Peak population</span><b>${VC.fmt.num(S.peakPop || 0)}</b>`;
  if (next) s += `<span>Next: ${next.name}</span><b>${VC.fmt.num(next.pop)}</b><span>Reward</span><b class="good">${VC.fmt.money(next.reward)}</b>`;
  const md = VC.MAP_TYPES.find((m) => m.key === S.mapType);
  s += `<span>Map</span><b>${md ? md.icon + ' ' + md.name : S.mapType} · ${S.W}²</b>`;
  const df = VC.DIFFICULTY[S.difficulty];
  if (df) s += `<span>Difficulty</span><b>${df.name}</b>`;
  return s + '</div><div class="tt-foot">Click for milestones · ✏️ to rename</div>';
}
function dateTip() {
  const S = VC.state;
  if (!S) return '';
  const w = S.weather || {};
  const month = Math.floor(S.time.day / VC.C.DAYS_PER_MONTH) % 12;
  const season = SEASONS[month];
  let s = `<div class="tt-head"><span class="tt-icon">${weatherIcon(S)}</span>${VC.fmt.fullDate(S.time.day)}</div><div class="tt-grid">`;
  s += `<span>Month</span><b>day ${(S.time.day % VC.C.DAYS_PER_MONTH) + 1} of ${VC.C.DAYS_PER_MONTH}</b>`;
  s += `<span>Season</span><b>${season.icon} ${season.name}</b>`;
  s += `<span>Weather</span><b>${WEATHER_NAMES[w.type] || w.type || 'Clear'}</b>`;
  s += `<span>Time</span><b>${clock(S)}</b>`;
  if (w.wind != null) s += `<span>Wind</span><b>${Math.round(w.wind * 60)} km/h</b>`;
  s += `<span>Speed</span><b>${['Paused', 'Normal', 'Fast', 'Ultra'][S.time.speed] || ''}</b>`;
  return s + '</div>';
}
function moneyTip() {
  const S = VC.state;
  if (!S) return '';
  monthlyNet(S);
  const fc = netCache.fc;
  let s = `<div class="tt-head"><span class="tt-icon">💰</span>Treasury ${VC.fmt.money(S.money)}</div>`;
  if (S.sandbox) return s + '<div class="tt-desc">Sandbox mode — money is unlimited.</div>';
  s += '<div class="tt-grid">';
  if (fc && (fc.totalIncome || fc.totalExpenses)) {
    s += `<span>Monthly income</span><b class="good">${VC.ui.signedMoney(fc.totalIncome)}</b><span>Monthly expenses</span><b class="bad">${VC.ui.signedMoney(-Math.abs(fc.totalExpenses))}</b>`;
    s += `<span>Net forecast</span><b class="${fc.net >= 0 ? 'good' : 'bad'}">${VC.ui.signedMoney(fc.net)}</b>`;
  } else {
    const st = S.stats || {};
    s += `<span>Last month income</span><b class="good">${VC.ui.signedMoney(st.income || 0)}</b><span>Last month expenses</span><b class="bad">${VC.ui.signedMoney(-Math.abs(st.expenses || 0))}</b><span>Net</span><b>${VC.ui.signedMoney(st.net || 0)}</b>`;
  }
  if (S.loans && S.loans.length) s += `<span>Loans</span><b class="warn">${S.loans.length} · ${VC.fmt.money(S.loans.reduce((a, l) => a + (l.remaining || 0), 0))}</b>`;
  return s + '</div><div class="tt-foot">Click to open the budget <kbd>M</kbd></div>';
}
function popTip() {
  const S = VC.state;
  if (!S) return '';
  const st = S.stats || {};
  let s = `<div class="tt-head"><span class="tt-icon">👥</span>${VC.fmt.num(st.pop || 0)} citizens</div><div class="tt-grid">`;
  s += `<span>Peak population</span><b>${VC.fmt.num(S.peakPop || 0)}</b>`;
  s += `<span>Jobs</span><b>${VC.fmt.num(st.jobs || 0)}</b>`;
  s += `<span>Workers</span><b>${VC.fmt.num(st.workers || 0)}</b>`;
  const un = st.unemployment || 0;
  s += `<span>Unemployment</span><b class="${un > 0.12 ? 'bad' : un > 0.06 ? 'warn' : 'good'}">${VC.fmt.pct(un, 1)}</b>`;
  s += `<span>Buildings</span><b>${VC.fmt.num(st.buildings || (S.buildings ? S.buildings.size : 0))}</b>`;
  if (st.abandoned) s += `<span>Abandoned</span><b class="bad">${VC.fmt.num(st.abandoned)}</b>`;
  if (st.tourism) s += `<span>Tourists</span><b>${VC.fmt.num(st.tourism)}</b>`;
  return s + '</div><div class="tt-foot">Click for population details <kbd>U</kbd></div>';
}
function pctRow(label, v, bad) {
  if (v == null || !isFinite(v)) return '';
  const cls = bad ? (v > 0.5 ? 'bad' : v > 0.25 ? 'warn' : 'good') : v > 0.65 ? 'good' : v > 0.4 ? 'warn' : 'bad';
  return `<span>${label}</span><b class="${cls}">${Math.round(v * 100)}%</b>`;
}
function happyTip() {
  const S = VC.state;
  if (!S) return '';
  const st = S.stats || {};
  if (!(st.pop > 0)) return '<div class="tt-head"><span class="tt-icon">😐</span>Mayor approval</div><div class="tt-desc">No citizens yet — zone some homes and they will tell you what they think.</div>';
  const ap = approvalOf(S);
  let s = `<div class="tt-head"><span class="tt-icon">${faceOf(ap)}</span>Mayor approval ${Math.round(ap * 100)}%</div><div class="tt-grid">`;
  s += pctRow('Happiness', st.happiness) + pctRow('Health', st.health) + pctRow('Education', st.education) + pctRow('Crime', st.crime, true) + pctRow('Pollution', st.pollution, true) + pctRow('Traffic', st.traffic, true);
  return s + '</div><div class="tt-foot">Click for city statistics <kbd>G</kbd></div>';
}
function rciTip() {
  const S = VC.state;
  if (!S) return '';
  const dm = S.demand || {};
  let f = null;
  try { f = VC.sim && VC.sim.demandFactors ? VC.sim.demandFactors() : null; } catch (e) { f = null; }
  let s = '<div class="tt-head"><span class="tt-icon">📊</span>Zone demand</div>';
  for (const k of ['R', 'C', 'I']) {
    const z = VC.ZONES[VC.ZT[k]];
    const v = +dm[k] || 0;
    s += `<div class="tt-rci"><span style="color:${z.color}">${z.icon} ${z.name}</span><b class="${v >= 0 ? 'good' : 'bad'}">${v >= 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}</b></div>`;
    const list = f && f[k] ? f[k].slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 3) : [];
    for (const x of list) s += `<div class="tt-factor"><span>${escapeHtml(x.label)}</span><b class="${x.value >= 0 ? 'good' : 'bad'}">${x.value >= 0 ? '▲' : '▼'}</b></div>`;
  }
  return s + '<div class="tt-foot">Bars above the line mean citizens want more of that zone.</div>';
}
function utilTip(kind) {
  const S = VC.state;
  if (!S) return '';
  const st = S.stats || {};
  const sup = kind === 'power' ? st.powerSupply || 0 : st.waterSupply || 0;
  const dem = kind === 'power' ? st.powerDemand || 0 : st.waterDemand || 0;
  const unit = kind === 'power' ? 'MW' : 'kL';
  let info = null;
  try { info = kind === 'power' ? VC.sim.powerInfo() : VC.sim.waterInfo(); } catch (e) { info = null; }
  const n = info ? (kind === 'power' ? info.plants : info.sources) : null;
  let s = `<div class="tt-head"><span class="tt-icon">${kind === 'power' ? '⚡' : '💧'}</span>${kind === 'power' ? 'Electricity' : 'Water'}</div><div class="tt-grid">`;
  s += `<span>Production</span><b>${VC.fmt.num(sup)} ${unit}</b><span>Consumption</span><b>${VC.fmt.num(dem)} ${unit}</b>`;
  if (sup > 0) s += `<span>Load</span><b class="${dem > sup ? 'bad' : dem > sup * 0.88 ? 'warn' : 'good'}">${Math.round((dem / sup) * 100)}% of capacity</b>`;
  s += `<span>Balance</span><b class="${sup >= dem ? 'good' : 'bad'}">${VC.ui.signed(sup - dem)} ${unit}</b>`;
  if (n) s += `<span>${kind === 'power' ? 'Power plants' : 'Water sources'}</span><b>${n.length}</b>`;
  s += '</div>';
  if (dem > sup) s += `<div class="tt-lock">Shortage! Build more ${kind === 'power' ? 'power plants' : 'pumps or towers'}.</div>`;
  return s + '<div class="tt-foot">Click for utilities <kbd>Y</kbd></div>';
}

/* ================================================================== */
/* MANAGER DOCK                                                        */
/* ================================================================== */
function buildDock() {
  D.el = h('div', { class: 'hud-dock pe' });
  D.wrap = h('div', { class: 'hud-dockwrap' }, D.el);
  hud.root.appendChild(D.wrap);
}
function dockButton(key, icon, name, hotkey, onClick, cls) {
  const badge = h('span', { class: 'dock-badge' });
  const label = h('span', { class: 'dock-label' }, name, hotkey ? h('kbd', { class: 'kbd' }, hotkey) : null);
  const b = h('button', { class: 'dock-btn ' + (cls || ''), 'data-key': key, 'aria-label': name, onclick: () => { VC.bus.emit('sfx', { name: 'click' }); onClick(b); } }, h('span', { class: 'dock-icon' }, icon), badge, label);
  b.badge = badge;
  return b;
}
/** (Re)builds the dock when the panel list changes (VC.panels may populate its list after hud.init). */
function ensureDock() {
  if (!D.el) return;
  const list = hud.panelList();
  const sig = list.map((p) => p.key + p.icon).join('|');
  if (sig === D.sig) return;
  D.sig = sig;
  D.el.innerHTML = '';
  D.btns.clear();
  for (const p of list) {
    const b = dockButton(p.key, p.icon || '📋', p.name || p.key, keyLabel(p.hotkey), () => hud.panel(p.key));
    D.btns.set(p.key, b);
    D.el.appendChild(b);
  }
  D.el.appendChild(h('div', { class: 'dock-sep' }));
  D.overlay = dockButton('_overlay', '🗺️', 'Map overlays', 'O', (b) => hud.openOverlayPicker(b, 'left'), 'tool');
  D.photo = dockButton('_photo', '📷', 'Photo mode', 'H', () => hud.photoMode(true), 'tool');
  D.settings = dockButton('_settings', '⚙️', 'Settings', null, () => hud.openSettings(), 'tool');
  D.help = dockButton('_help', '❓', 'How to play', 'F1', () => hud.openHelp(), 'tool');
  D.el.append(D.overlay, D.photo, D.settings, D.help);
  refreshDockActive();
  layoutDock();
}
function refreshDockActive() {
  const ui = VC.ui;
  if (!ui || !D.el) return;
  const open = ui.openWindows ? ui.openWindows() : [];
  const isOpen = (key) => open.some((id) => id === key || id === 'panel:' + key || id === 'panel-' + key || id === 'panel_' + key);
  for (const [key, b] of D.btns) setCls(b, 'active', isOpen(key));
  if (D.settings) setCls(D.settings, 'active', isOpen('settings'));
  if (D.help) setCls(D.help, 'active', isOpen('help'));
  if (D.overlay) setCls(D.overlay, 'active', VC.gfx && VC.gfx.overlay && VC.gfx.overlay !== 'none');
}
VC.hud.refreshDock = refreshDockActive;
function refreshDockBadges() {
  const b = D.btns.get('advisors');
  if (b) {
    const inbox = (VC.advisors && VC.advisors.inbox) || [];
    let n = 0, bad = false;
    for (const m of inbox) if (m && !m.read) { n++; if (m.severity === 'bad') bad = true; }
    setText(b.badge, n ? (n > 9 ? '9+' : String(n)) : '');
    setCls(b.badge, 'show', n > 0);
    setCls(b.badge, 'bad', bad);
  }
  refreshDockActive();
}
/** Top bar: progressively hides secondary details (c1..c4) until everything fits the width. */
function layoutTop() {
  const bar = T.bar;
  if (!bar || !hud.visible) return;
  bar.classList.remove('c1', 'c2', 'c3', 'c4');
  for (let lv = 1; lv <= 4 && bar.scrollWidth > bar.clientWidth + 1; lv++) bar.classList.add('c' + lv);
}
/** Fits the dock between the top bar and the ticker: normal -> compact -> two columns. */
function layoutDock() {
  layoutTop();
  if (!D.el) return;
  const s = VC.ui.scale();
  const avail = window.innerHeight - 66 - 40;
  D.el.classList.remove('compact', 'two');
  const need = (hh) => hh * s <= avail;
  if (need(D.el.offsetHeight)) return;
  D.el.classList.add('compact');
  if (need(D.el.offsetHeight)) return;
  D.el.classList.remove('compact');
  D.el.classList.add('two');
}

/* ================================================================== */
/* READOUT (FPS + tile info)                                           */
/* ================================================================== */
function buildReadout() {
  T.fps = h('div', { class: 'ro-fps' });
  T.tile = h('div', { class: 'ro-tile' });
  T.readout = h('div', { class: 'hud-readout' }, T.tile, T.fps);
  hud.root.appendChild(T.readout);
  refreshReadoutVis();
}
function refreshReadoutVis() {
  if (!T.fps) return;
  T.fps.style.display = VC.settings && VC.settings.showFps ? '' : 'none';
  refreshFps();
}
function refreshFps() {
  if (!T.fps || !(VC.settings && VC.settings.showFps)) return;
  const g = VC.gfx;
  const fps = Math.round(g.fps || 0);
  setText(T.fps, `${fps} FPS · ${(g.frameMs || 0).toFixed(1)} ms · ${g.rw}×${g.rh}`);
  setCls(T.fps, 'bad', fps < 25);
  setCls(T.fps, 'warn', fps >= 25 && fps < 45);
}
const TERR_NAMES = ['Grass', 'Sand', 'Dirt', 'Rock', 'Snow', 'Meadow'];
function refreshTileInfo() {
  const S = VC.state;
  if (!S || !T.tile) return;
  let t = VC.tools && VC.tools.hover;
  if (!t && mouseOnCanvas && VC.input && VC.input.mouse && VC.camera && VC.camera.pickGround) {
    const r = VC.gfx.canvas.getBoundingClientRect();
    const hit = VC.camera.pickGround(VC.input.mouse.x - r.left, VC.input.mouse.y - r.top);
    t = hit && !hit.offMap ? hit : null;
  }
  if (!t || !mouseOnCanvas || t.x < 0 || t.z < 0 || t.x >= S.W || t.z >= S.H) {
    if (lastTile !== null) { lastTile = null; setCls(T.tile, 'show', false); }
    return;
  }
  const i = t.z * S.W + t.x;
  const key = i + ':' + S.ver.terrain + ':' + S.ver.bld + ':' + S.ver.maps;
  if (key === lastTile) return;
  lastTile = key;
  const parts = [`<span class="ro-xy">${t.x}, ${t.z}</span>`];
  const b = S.bld[i] ? S.buildings.get(S.bld[i]) : null;
  if (b) {
    let nm = '';
    try { nm = VC.sim && VC.sim.buildingName ? VC.sim.buildingName(b) : ''; } catch (e) { nm = ''; }
    parts.push('🏢 ' + escapeHtml(nm || (VC.BLD[b.key] || {}).name || b.key));
  } else if (S.road[i]) parts.push((VC.ROADS[S.road[i]] || {}).icon + ' ' + (VC.ROADS[S.road[i]] || {}).name);
  else if (S.height[i] < VC.C.SEA) parts.push('🌊 Water');
  else parts.push((S.trees[i] ? '🌲 ' : '🟩 ') + (TERR_NAMES[S.terr[i]] || 'Land'));
  if (S.zone[i]) {
    const z = VC.ZONES[VC.ztype(S.zone[i])];
    if (z) parts.push(`<span style="color:${z.color}">${z.key}${VC.zden(S.zone[i])}</span>`);
  }
  parts.push('⛰ ' + S.height[i]);
  const lv = S.maps && S.maps.landValue;
  if (lv && lv[i]) parts.push('💎 ' + Math.round((lv[i] / 255) * 100) + '%');
  T.tile.innerHTML = parts.join('<i></i>');
  setCls(T.tile, 'show', true);
}

function revealUI() {
  if (!hud.uiHidden) return;
  if (hud.photo) hud.photoMode(false);
  else hud.toggleUI(true);
}

/* ================================================================== */
/* PHOTO MODE HINT                                                     */
/* ================================================================== */
let photoTimer = 0;
function buildPhotoHint() {
  const shot = h('button', { class: 'btn small primary', onclick: savePicture }, '📸 Save picture');
  const exit = h('button', { class: 'btn small', onclick: () => (hud.photo ? hud.photoMode(false) : hud.toggleUI(true)) }, 'Show UI');
  T.photoHint = h('div', { class: 'photo-hint pe' }, h('span', { class: 'ph-text' }, 'Interface hidden — press ', h('kbd', { class: 'kbd' }, 'H'), ' or ', h('kbd', { class: 'kbd' }, 'Esc'), ' to return'), shot, exit);
  VC.ui.root.appendChild(T.photoHint);
}
function pokePhotoHint() {
  if (!T.photoHint) return;
  T.photoHint.classList.remove('idle');
  clearTimeout(photoTimer);
  photoTimer = setTimeout(() => T.photoHint.classList.add('idle'), 2600);
}
function savePicture() {
  const g = VC.gfx;
  if (!g || !g.capture) return;
  T.photoHint.classList.add('flashing');
  g.capture(Math.max(g.W, 1920), 'image/png').then((url) => {
    T.photoHint.classList.remove('flashing');
    if (!url) { VC.ui.toast('Could not capture the picture.', { type: 'bad' }); return; }
    const a = h('a', { href: url, download: ((VC.state && VC.state.name) || 'Voxelpolis').replace(/[^\w\- ]+/g, '') + ' ' + new Date().toISOString().slice(0, 10) + '.png' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    const flash = h('div', { class: 'shutter' });
    VC.ui.root.appendChild(flash);
    setTimeout(() => flash.remove(), 700);
    VC.bus.emit('sfx', { name: 'camera' });
  });
}

/* ================================================================== */
/* KEYBOARD                                                            */
/* ================================================================== */
/** Typing in a text field (sliders, checkboxes and buttons do not block hotkeys). */
const isTyping = (e) => {
  const t = e.target;
  return !!t && ((VC.ui.isTextEntry && VC.ui.isTextEntry(t)) || t.tagName === 'SELECT');
};
/** Capture phase: Esc/H leave hidden-UI / photo mode before anything else sees the key. */
function onKeyCapture(e) {
  if (isTyping(e) || !hud.uiHidden) return;
  if (e.code === 'Escape' || (e.code === 'KeyH' && !e.ctrlKey && !e.metaKey)) {
    if (hud.photo) hud.photoMode(false);
    else hud.toggleUI(true);
    e.stopImmediatePropagation();
    e.preventDefault();
  }
}
/** Hotkeys for the foundation input module (no KEYMAP). The real input module handles these itself. */
function onKeyFallback(e) {
  if (VC.input && VC.input.KEYMAP) return;
  if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (!hud.visible || menuActive() || (VC.ui.modalCount && VC.ui.modalCount())) return;
  const c = e.code;
  const groups = VC.TOOL_GROUPS;
  const g = groups.find((x) => x.hotkey && (c === 'Digit' + x.hotkey || c === 'Key' + x.hotkey));
  if (g) { VC.bus.emit('toolGroup', { key: g.key }); e.preventDefault(); return; }
  const p = hud.panelList().find((x) => x.hotkey === c);
  if (p) { hud.panel(p.key); e.preventDefault(); return; }
  switch (c) {
    case 'Escape':
      if (VC.tools && VC.tools.current && VC.tools.current !== 'select') VC.tools.select('select');
      else if (!VC.ui.closeTop()) VC.menu && VC.menu.pause && VC.menu.pause();
      break;
    case 'Space': VC.togglePause(); e.preventDefault(); break;
    case 'KeyH': hud.toggleUI(); break;
    case 'F1': hud.openHelp(); e.preventDefault(); break;
    case 'KeyO': {
      const o = VC.OVERLAYS, i = o.findIndex((x) => x.key === VC.gfx.overlay);
      VC.gfx.setOverlay(o[(i + 1) % o.length].key);
      break;
    }
    case 'KeyC': if (VC.camera) VC.camera.cinematic = !VC.camera.cinematic; break;
    case 'BracketLeft': case 'Comma': VC.setSpeed(VC.speed() - 1); break;
    case 'BracketRight': case 'Period': VC.setSpeed(VC.speed() + 1); break;
    default: break;
  }
}
