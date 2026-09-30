/*
 * VOXELPOLIS — menus (VC.menu).
 *   TITLE SCREEN  show(): starts a live demo city (sandbox, cinematic camera, golden hour) behind a glass
 *                 menu: extruded voxel-letter logo (canvas-drawn cubes, floating wave), tagline, Continue
 *                 (latest save), New City (menu_newcity.js), Load City (save list + import), Settings,
 *                 How to Play, Credits, rotating tips. The demo state is flagged S.demo = true.
 *   PAUSE MENU    pause(): Resume, Save City, Settings, How to Play, Main Menu (confirm). Pauses the sim
 *                 and restores the previous speed on resume().
 *   TRANSITIONS   fade(fn, text): full-screen fade with a spinning voxel cube while fn() runs.
 *   KEYBOARD      while the title screen or pause menu is up, game hotkeys are blocked (capture phase);
 *                 Esc closes the top window, then backs out of sub-panels / resumes.
 * API: active, show(), hide(), pause(), resume(), isPaused(), startGame(opts), loadGame(slot), fade(fn, text),
 *      saves() -> Promise<[normalised save info]>
 */
const h = VC.h;
const MN = { built: false, sub: null, demoCenter: null, tipIdx: 0, tipTimer: 0, logoW: 0 };
const PZ = { open: false, prev: 1, el: null, t: 0 };

/* ---------------- 5x7 voxel font ---------------- */
const FONT = {
  V: ['#...#', '#...#', '#...#', '#...#', '.#.#.', '.#.#.', '..#..'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
};
function hexMix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
  const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
  const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
  return `rgb(${r},${g},${bl})`;
}
/**
 * Draws one letter as extruded cubes (oblique projection toward the upper right).
 * Draw order bottom->top, left->right guarantees correct overlap without a depth buffer.
 */
function letterCanvas(ch, s) {
  const rows = FONT[ch];
  const R = rows.length, Cn = rows[0].length;
  const d = Math.max(3, Math.round(s * 0.5));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Cn * s + d + 2, H = R * s + d + 2;
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = W + 'px';
  cv.style.height = H + 'px';
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const front = ctx.createLinearGradient(0, d, 0, d + R * s);
  front.addColorStop(0, '#ffffff');
  front.addColorStop(0.3, '#c9f4ff');
  front.addColorStop(0.62, '#5ad1ff');
  front.addColorStop(1, '#8a63ff');
  const poly = (pts, fill) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  const on = (r, c) => r >= 0 && r < R && c >= 0 && c < Cn && rows[r][c] === '#';
  for (let r = R - 1; r >= 0; r--) {
    const t = r / (R - 1);
    const topCol = hexMix('#ffffff', '#b4e6ff', t);
    const sideCol = hexMix('#2c86cf', '#40289a', t);
    for (let c = 0; c < Cn; c++) {
      if (!on(r, c)) continue;
      const x = 1 + c * s, y = 1 + d + r * s;
      if (!on(r - 1, c)) poly([[x, y], [x + d, y - d], [x + s + d, y - d], [x + s, y]], topCol);
      if (!on(r, c + 1)) poly([[x + s, y], [x + s + d, y - d], [x + s + d, y + s - d], [x + s, y + s]], sideCol);
      ctx.fillStyle = front;
      ctx.fillRect(x, y, s, s);
      // bevel: light top/left, dark bottom/right
      const bw = Math.max(1, s * 0.1);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(x, y, s, bw);
      ctx.fillRect(x, y, bw, s);
      ctx.fillStyle = 'rgba(10,20,60,0.22)';
      ctx.fillRect(x, y + s - bw, s, bw);
      ctx.fillRect(x + s - bw, y, bw, s);
    }
  }
  return cv;
}
function buildLogo() {
  const box = MN.logo;
  if (!box) return;
  const w = Math.min(window.innerWidth * 0.5, 860);
  const s = VC.M.clamp(Math.floor(w / 62), 7, 15);
  if (s === MN.logoW && box.children.length) return;
  MN.logoW = s;
  box.innerHTML = '';
  box.style.gap = Math.round(s * 0.72) + 'px';
  'VOXELPOLIS'.split('').forEach((ch, i) => {
    const cv = letterCanvas(ch, s);
    cv.className = 'vpm-letter';
    cv.style.animationDelay = `${0.08 * i}s, ${0.9 + i * 0.16}s, ${2.2 + i * 0.09}s`;
    box.appendChild(cv);
  });
}

/* ---------------- saves ---------------- */
/** Normalises whatever VC.save.list() returns into {slot, name, pop, time, day, money, thumb, auto}. */
function saveInfo(s) {
  if (s == null) return null;
  if (typeof s !== 'object') return { slot: s, name: String(s), pop: null, time: 0 };
  const slot = s.slot != null ? s.slot : s.key != null ? s.key : s.id != null ? s.id : s.name;
  const t = s.time != null ? s.time : s.savedAt != null ? s.savedAt : s.date != null ? s.date : s.ts != null ? s.ts : s.timestamp;
  let ms = typeof t === 'number' ? t : t ? Date.parse(t) : 0;
  if (!isFinite(ms)) ms = 0;
  const pop = s.pop != null ? s.pop : s.population != null ? s.population : s.stats && s.stats.pop != null ? s.stats.pop : null;
  return {
    slot,
    name: s.name || s.city || s.cityName || String(slot),
    pop,
    time: ms,
    day: s.day != null ? s.day : s.gameDay != null ? s.gameDay : null,
    money: s.money,
    thumb: s.thumb || s.thumbnail || s.image || null,
    auto: !!(s.auto || s.autosave || /auto/i.test(String(slot))),
    milestone: s.milestone,
  };
}
function saves() {
  let r;
  try { r = VC.save && VC.save.list ? VC.save.list() : []; } catch (e) { r = []; }
  return Promise.resolve(r).then((list) => (Array.isArray(list) ? list.map(saveInfo).filter((x) => x && x.slot != null) : [])).catch(() => []);
}
function ago(ms) {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
  return new Date(ms).toLocaleDateString();
}

/* ---------------- title screen ---------------- */
const TIPS_FALLBACK = ['Zones only grow within a few tiles of a road.', 'Tall R C I bars mean citizens want more of that zone.'];
function build() {
  if (MN.built) return;
  MN.built = true;
  MN.logo = h('div', { class: 'vpm-logo', 'aria-label': 'VOXELPOLIS' });
  MN.btns = h('div', { class: 'vpm-btns' });
  MN.side = h('div', { class: 'vpm-side' });
  MN.tip = h('div', { class: 'vpm-tip' });
  MN.main = h('div', { class: 'vpm-main' }, MN.logo, h('div', { class: 'vpm-tag' }, 'Build the city of your dreams, one voxel at a time'), MN.btns);
  MN.el = h('div', { class: 'vp-menu' },
    h('div', { class: 'vpm-shade' }),
    h('div', { class: 'vpm-grain' }),
    MN.main,
    MN.side,
    MN.tip,
    h('div', { class: 'vpm-foot' }, h('span', null, 'v' + VC.VERSION), h('span', null, '100% procedural · one HTML file · zero cubes harmed')));
  const ui = VC.ui;
  ui.root.insertBefore(MN.el, ui.layer);
  window.addEventListener('resize', () => { if (menu.active) buildLogo(); });
}
function menuBtn(icon, label, sub, onClick, cls) {
  return h('button', { class: 'vpm-btn ' + (cls || ''), onclick: () => { VC.bus.emit('sfx', { name: 'click' }); onClick(); } },
    h('span', { class: 'vpm-bi' }, icon),
    h('span', { class: 'vpm-bt' }, h('b', null, label), sub ? h('small', null, sub) : null),
    h('span', { class: 'vpm-arrow' }, '›'));
}
function renderButtons(list) {
  const latest = list && list.length ? list.slice().sort((a, b) => (b.time || 0) - (a.time || 0))[0] : null;
  MN.btns.innerHTML = '';
  const add = (b, i) => { b.style.animationDelay = 0.35 + i * 0.06 + 's'; MN.btns.appendChild(b); };
  let i = 0;
  if (latest) {
    const sub = [VC.hud.escapeHtml ? latest.name : latest.name, latest.pop != null ? VC.fmt.short(latest.pop) + ' citizens' : null, ago(latest.time)].filter(Boolean).join(' · ');
    add(menuBtn('▶️', 'Continue', sub, () => loadGame(latest.slot), 'primary'), i++);
  }
  add(menuBtn('🏗️', 'New City', 'Found a brand-new metropolis', () => menu.newCity && menu.newCity(), latest ? '' : 'primary'), i++);
  add(menuBtn('📂', 'Load City', list && list.length ? `${list.length} saved ${list.length === 1 ? 'city' : 'cities'}` : 'Open a saved city or file', openLoad), i++);
  add(menuBtn('⚙️', 'Settings', 'Graphics, audio, controls', () => VC.hud.openSettings('graphics')), i++);
  add(menuBtn('❓', 'How to Play', 'Controls and a quick guide', () => VC.hud.openHelp('guide')), i++);
  add(menuBtn('🎬', 'Credits', 'The people (and cubes) behind it', openCredits), i++);
}
function rotateTip() {
  const tips = (VC.hud && VC.hud.TIPS) || TIPS_FALLBACK;
  const t = tips[MN.tipIdx++ % tips.length];
  MN.tip.classList.remove('in');
  void MN.tip.offsetWidth;
  MN.tip.innerHTML = '';
  MN.tip.append(h('span', { class: 'vpm-tip-k' }, '💡 Tip'), h('span', null, t));
  MN.tip.classList.add('in');
}

/* ---------------- demo city ---------------- */
const DEMO_MAPS = ['river', 'coast', 'lakes', 'plains', 'river', 'coast'];
function startDemo() {
  const r = VC.M.rng((Math.random() * 1e9) >>> 0);
  let S = null;
  try {
    S = VC.newGame({ seed: (r() * 4294967295) >>> 0, size: 96, mapType: r.pick(DEMO_MAPS), difficulty: 'sandbox', name: 'Demo', disasters: false });
    S.demo = true;
    S.disastersEnabled = false;
    const res = VC.debug && VC.debug.sampleCity ? VC.debug.sampleCity({ grow: true, blocks: 5, seed: (r() * 1e6) | 0 }) : null;
    MN.demoCenter = res ? [res.cx + res.span / 2, res.cz + res.span / 2, res.span] : [S.W / 2, S.H / 2, 32];
  } catch (e) {
    console.error('[menu] demo city failed', e);
    MN.demoCenter = S ? [S.W / 2, S.H / 2, 32] : null;
  }
  if (!S) return;
  S.time.tod = 0.72;
  S.time.speed = 1;
  const cam = VC.camera, g = cam.goal, c = MN.demoCenter;
  cam.cinematic = true;
  g.dist = c[2] * 1.3;
  g.pitch = 0.5;
  g.yaw = r() * Math.PI * 2;
  placeDemoCam();
  cam.snap();
}
/** Keeps the demo city in the right part of the screen (the menu column sits on the left). */
function placeDemoCam() {
  const c = MN.demoCenter, g = VC.camera.goal;
  if (!c) return;
  const wide = window.innerWidth > 900 && !MN.sub;
  const off = wide ? g.dist * 0.3 : 0;
  g.tx = c[0] - Math.cos(g.yaw) * off;
  g.tz = c[1] + Math.sin(g.yaw) * off;
}

/* ---------------- load list ---------------- */
function closeSub() {
  if (!MN.sub) return;
  MN.sub = null;
  const p = MN.side.firstChild;
  MN.el.classList.remove('has-sub');
  if (p) { p.classList.add('out'); setTimeout(() => p.remove(), 220); }
}
function openSub(name, panel) {
  MN.side.innerHTML = '';
  MN.sub = name;
  MN.side.appendChild(panel);
  MN.el.classList.add('has-sub');
}
function openLoad() {
  const list = h('div', { class: 'sv-list' }, h('div', { class: 'sv-empty' }, 'Loading…'));
  const importBtn = VC.ui.button('Import from file…', () => {
    try {
      const r = VC.save && VC.save.importFile && VC.save.importFile();
      if (r && r.then) r.then(null, (e) => VC.ui.toast('Import failed: ' + ((e && e.message) || e), { type: 'bad' }));
    } catch (e) { VC.ui.toast('Import failed.', { type: 'bad' }); }
  }, { icon: '📥' });
  const panel = h('div', { class: 'vpm-panel' },
    h('div', { class: 'vpm-ph' }, h('span', null, '📂'), h('b', null, 'Load City'), h('button', { class: 'win-btn', title: 'Back (Esc)', onclick: closeSub }, '×')),
    list,
    h('div', { class: 'vpm-pf' }, importBtn, h('span', { class: 'note' }, '.json / .vxp city files')));
  openSub('load', panel);
  saves().then((arr) => {
    list.innerHTML = '';
    if (!arr.length) { list.appendChild(h('div', { class: 'sv-empty' }, h('div', { class: 'sv-empty-i' }, '🏙️'), 'No saved cities yet.', h('br'), 'Found a new one — it will appear here.')); return; }
    arr.sort((a, b) => (b.time || 0) - (a.time || 0));
    arr.forEach((s, i) => {
      const thumb = s.thumb ? h('img', { src: s.thumb, alt: '' }) : h('span', null, '🏙️');
      const meta = [s.pop != null ? '👥 ' + VC.fmt.num(s.pop) : null, s.day != null ? '📅 ' + VC.fmt.date(s.day) : null, ago(s.time)].filter(Boolean).join(' · ');
      const row = h('div', { class: 'sv-row', style: { animationDelay: i * 0.04 + 's' }, onclick: () => loadGame(s.slot) },
        h('div', { class: 'sv-thumb' }, thumb),
        h('div', { class: 'sv-info' }, h('b', null, s.name, s.auto ? h('span', { class: 'badge' }, 'auto') : null), h('small', null, meta)),
        h('button', { class: 'btn small primary', onclick: (e) => { e.stopPropagation(); loadGame(s.slot); } }, 'Load'),
        h('button', { class: 'btn small ghost sv-del', 'data-tip': 'Delete', onclick: (e) => {
          e.stopPropagation();
          VC.ui.confirm(`Delete <b>${VC.hud.escapeHtml(s.name)}</b>? This cannot be undone.`, () => {
            Promise.resolve(VC.save && VC.save.remove && VC.save.remove(s.slot)).then(() => { row.classList.add('out'); setTimeout(() => { openLoad(); refreshButtons(); }, 200); });
          }, { yes: 'Delete', danger: true, title: 'Delete saved city?' });
        } }, '🗑️'));
      list.appendChild(row);
    });
  });
}

/* ---------------- credits ---------------- */
function openCredits() {
  const line = (k, v) => h('div', { class: 'cr-line' }, h('span', null, k), h('b', null, v));
  const body = h('div', { class: 'credits' },
    h('div', { class: 'cr-logo' }, 'VOXELPOLIS'),
    h('div', { class: 'cr-sub' }, 'A voxel city builder in a single HTML file'),
    line('Engine', 'Raw WebGL2 · greedy-meshed voxels · HDR'),
    line('World', 'Procedural terrain, rivers, coasts & islands'),
    line('Simulation', 'Zoning, traffic, services & economy'),
    line('Sound', 'Synthesized live with WebAudio'),
    line('Interface', 'Hand-made HTML & CSS — zero images'),
    line('Built by', '14 specialist engineers & many cubes'),
    h('div', { class: 'cr-fun' },
      h('p', null, '🦖 Cubezilla appears courtesy of the Department of Disaster Management.'),
      h('p', null, '🧱 No voxels were harmed in the making of this game. Several were bulldozed.'),
      h('p', null, '🏙️ Special thanks to you, Mayor.')));
  VC.ui.modal('🎬 Credits', body, [{ label: 'Close', cls: 'primary' }], { cls: 'credits-modal' });
}

/* ---------------- transitions ---------------- */
function fade(fn, text) {
  const el = h('div', { class: 'vp-fade' }, h('div', { class: 'vf-inner' }, h('div', { class: 'vf-cube' }, [1, 2, 3, 4, 5, 6].map((i) => h('i', { class: 'f' + i }))), h('div', { class: 'vf-text' }, text || 'Loading…')));
  VC.ui.root.appendChild(el);
  VC.bus.emit('sfx', { name: 'whoosh' });
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    try { fn && fn(); } catch (e) { console.error('[menu] transition', e); VC.errors && VC.errors.push('menu: ' + e.message); }
    // give the new world a couple of frames to render before revealing it
    setTimeout(() => { el.classList.remove('in'); el.classList.add('out'); setTimeout(() => el.remove(), 800); }, 260);
  }, 420);
}

/* ---------------- game start / load ---------------- */
/** Leaves the title screen. instant: no fade (used under the full-screen transition). */
function enterGame(instant) {
  menu.active = false;
  closeSub();
  MN.el.classList.toggle('now', !!instant);
  MN.el.classList.remove('show');
  clearInterval(MN.tipTimer);
  VC.camera.cinematic = false;
}
/** Starts a real game (used by the new-city dialog). opts as VC.newGame. */
function startGame(opts) {
  fade(() => {
    enterGame(true);
    VC.ui.closeAll();
    const S = VC.newGame(opts);
    if (VC.tools && VC.tools.select) VC.tools.select('select');
    VC.gfx.setOverlay('none');
    VC.hud.show();
    const esc = VC.hud.escapeHtml;
    VC.ui.toast(`<b>Welcome to ${esc(S.name)}, Mayor!</b><br>Start by building a road.`, { type: 'good', icon: '🏙️', duration: 6000 });
    if (VC.settings.tutorial) setTimeout(() => VC.hud.startTutorial(), 900);
  }, `Founding ${VC.hud.escapeHtml ? VC.hud.escapeHtml(opts.name || 'your city') : 'your city'}…`);
}
function loadGame(slot) {
  fade(() => {
    enterGame(true);
    VC.ui.closeAll();
    let r;
    try { r = VC.save && VC.save.load ? VC.save.load(slot) : false; } catch (e) { console.error('[menu] load', e); r = false; }
    // success = a real (non-demo) state is now running, whatever load() returned
    Promise.resolve(r).catch(() => false).then(() => {
      if (!VC.state || VC.state.demo) {
        // stay on (or return to) the title screen
        menu.active = true;
        MN.el.classList.remove('now');
        MN.el.classList.add('show');
        VC.camera.cinematic = true;
        VC.hud.hide();
        VC.ui.toast('That city could not be loaded.', { type: 'bad', icon: '📂' });
        refreshButtons();
      }
    });
  }, 'Loading city…');
}
function refreshButtons() {
  renderButtons([]);
  saves().then(renderButtons);
}

/* ---------------- pause menu ---------------- */
function buildPause() {
  const ui = VC.ui;
  PZ.city = h('div', { class: 'vpp-city' });
  PZ.stats = h('div', { class: 'vpp-stats' });
  const btn = (icon, label, fn, cls) => h('button', { class: 'vpp-btn ' + (cls || ''), onclick: () => { VC.bus.emit('sfx', { name: 'click' }); fn(); } }, h('span', { class: 'vpp-bi' }, icon), h('span', null, label));
  PZ.el = h('div', { class: 'vp-pause pe' },
    h('div', { class: 'vpp-card' },
      h('div', { class: 'vpp-head' }, h('span', { class: 'vpp-icon' }, h('i'), h('i')), h('b', null, 'Game paused')),
      PZ.city, PZ.stats,
      h('div', { class: 'vpp-btns' },
        btn('▶️', 'Resume', resume, 'primary'),
        btn('💾', 'Save City', () => { VC.hud.openPanel('save'); }),
        btn('⚙️', 'Settings', () => VC.hud.openSettings('graphics')),
        btn('❓', 'How to Play', () => VC.hud.openHelp('guide')),
        btn('🏠', 'Main Menu', () => ui.confirm('Return to the main menu?<br><span style="color:var(--text3)">Unsaved progress will be lost.</span>', () => { closePause(); menu.show(); }, { yes: 'Main Menu', title: 'Leave this city?', danger: true }), 'danger'))));
  PZ.el.addEventListener('pointerdown', (e) => { if (e.target === PZ.el) resume(); });
  ui.root.insertBefore(PZ.el, ui.layer);
}
function pause() {
  const S = VC.state;
  if (!S || menu.active || PZ.open || S.demo) return;
  if (!PZ.el) buildPause();
  PZ.open = true;
  PZ.t = performance.now(); // the key event that opened the menu must not also close it
  PZ.prev = S.time.speed;
  VC.setSpeed(0);
  VC.ui.closePopovers && VC.ui.closePopovers();
  VC.hud.closePalette && VC.hud.closePalette();
  const st = S.stats || {};
  const mi = VC.hud.milestoneIndex ? VC.hud.milestoneIndex(S) : Math.max(0, Math.min(VC.MILESTONES.length - 1, S.milestone | 0));
  PZ.city.textContent = `${S.name} · ${VC.MILESTONES[mi].name} · ${VC.fmt.fullDate(S.time.day)}`;
  PZ.stats.innerHTML = '';
  PZ.stats.append(
    h('span', null, '👥 ', h('b', null, VC.fmt.num(st.pop || 0))),
    h('span', null, '💰 ', h('b', null, S.sandbox ? '∞' : VC.fmt.money(S.money))),
    h('span', null, '😊 ', h('b', null, Math.round(((st.approval != null ? st.approval : st.happiness) || 0) * 100) + '%')));
  PZ.el.classList.remove('out');
  PZ.el.classList.add('show');
}
function closePause() {
  if (!PZ.open) return;
  PZ.open = false;
  PZ.el.classList.remove('show');
}
function resume() {
  if (!PZ.open) return;
  closePause();
  VC.setSpeed(PZ.prev == null ? 1 : PZ.prev);
}

/* ---------------- keyboard ---------------- */
function onKey(e) {
  if (!menu.active && !PZ.open) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if (VC.ui.modalCount && VC.ui.modalCount()) return;
  if (e.code === 'Escape') {
    if (PZ.open && performance.now() - PZ.t < 120) { e.stopImmediatePropagation(); return; }
    if (VC.ui.closeTop()) { /* closed a window */ }
    else if (menu.active && menu.dialogOpen && menu.dialogOpen()) menu.closeDialog();
    else if (menu.active && MN.sub) closeSub();
    else if (PZ.open) resume();
    e.preventDefault();
  }
  if (e.code === 'F11' || e.code === 'F12' || e.ctrlKey || e.metaKey) return; // browser keys pass through
  e.stopImmediatePropagation(); // no game hotkeys behind menus
}

const menu = (VC.menu = {
  active: false,
  init() {
    build();
    window.addEventListener('keydown', onKey, true);
    // a real game started while the title screen is up (e.g. file import) -> leave the menu
    VC.bus.on('started', (S) => {
      if (!menu.active || !S || S.demo || MN.startingDemo) return;
      enterGame();
      VC.hud.show();
    });
  },
  reset() {
    closePause();
  },
  update(dt, rdt) {
    if (!menu.active) return;
    const S = VC.state;
    if (S && S.demo) {
      if (S.time.speed === 0) S.time.speed = 1;
      placeDemoCam();
    }
  },
  show() {
    build();
    closePause();
    VC.ui.closeAll();
    VC.ui.closePopovers && VC.ui.closePopovers();
    menu.active = true;
    VC.hud.hide();
    if (VC.tools && VC.tools.select && VC.state) { try { VC.tools.select('select'); } catch (e) { /* stub */ } }
    if (VC.gfx && VC.gfx.setOverlay) VC.gfx.setOverlay('none');
    MN.startingDemo = true;
    try { startDemo(); } finally { MN.startingDemo = false; }
    MN.el.classList.remove('show', 'now');
    void MN.el.offsetWidth; // restart entrance animations
    MN.el.classList.add('show');
    MN.logoW = 0;
    buildLogo();
    refreshButtons();
    rotateTip();
    clearInterval(MN.tipTimer);
    MN.tipTimer = setInterval(rotateTip, 9000);
  },
  hide() {
    if (!menu.active) return;
    enterGame();
    if (menu.closeDialog) menu.closeDialog(true);
  },
  pause,
  resume,
  isPaused: () => PZ.open,
  startGame,
  loadGame,
  fade,
  saves,
  /** Re-reads the save list (Continue button / counts). */
  refresh: refreshButtons,
  openLoad,
  openCredits,
  _root: () => MN.el,
});
