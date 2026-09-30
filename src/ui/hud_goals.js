/*
 * VOXELPOLIS — HUD: Mayor's Goals card. Lives top-left under the top bar, where the tutorial card sits
 * (hidden while the tutorial runs), in a shared left column (.gl-col, also holding the Mayor's Desk card of
 * ui/hud_desk.js). The column stacks BELOW the windows layer (z 15 < 20): windows always cover it, never
 * the other way round.
 *   ITEMS     icon, title, why, live progress bar + text, reward, "Show me" (VC.goals.focusOf: camera,
 *             overlay, panel, palette, tool), "↻" swap on hover. Completed goals glow gold with a Claim button.
 *   HEADER    click to collapse / expand (remembered per browser); collapsed it shows mini progress bars and
 *             a "🎁 Claim" chip. While a desk decision is open the list folds away (the header peeks it).
 *   CELEBRATE bus 'goalDone' -> ONE toast (VC.ui.toast, sfx 'achievement') + VC.fx.confetti at the camera
 *             target. Claiming plays 'cash' and floats the reward over the item. Nothing in the demo.
 * Polls VC.goals.list() at 2 Hz (in-place DOM updates, no rebuild unless the set of goals changed).
 * Registers as a VC.hud part (order 45).
 */
const h = VC.h;
const GL = { col: null, card: null, list: null, count: null, chip: null, mini: null, items: new Map(), sig: '', acc: 0, collapsed: false, peek: false, vis: false };
const LS_KEY = 'voxelpolis.goalsCollapsed';
const esc = (s) => (VC.ui && VC.ui.esc ? VC.ui.esc(s) : String(s == null ? '' : s));
const tutorialOn = () => !!(VC.hud && VC.hud.tutorialStep && VC.hud.tutorialStep() >= 0);
const rewardLong = (g) => (g.reward && (g.reward.long || g.reward.text)) || '';
const demo = () => !!(VC.state && VC.state.demo) || !!(VC.menu && VC.menu.active);

/** The shared left column (created by whichever of hud_goals / hud_desk needs it first). */
function ensureCol() {
  const root = VC.hud && VC.hud.root;
  if (!root) return null;
  let col = root.querySelector('.gl-col');
  if (!col) {
    col = h('div', { class: 'gl-col' });
    root.appendChild(col);
  }
  return col;
}

/* ---------------- card ---------------- */
function build() {
  GL.col = ensureCol();
  if (!GL.col) return;
  GL.count = h('span', { class: 'gl-count' });
  GL.chip = h('span', { class: 'gl-claimchip' }, '🎁 Claim');
  GL.list = h('div', { class: 'gl-list' });
  GL.mini = h('div', { class: 'gl-mini' });
  // a div (not a button): the folded desk badge (hud_desk.js) docks in here as its own button
  const head = h('div', { class: 'gl-head', role: 'button', tabindex: '0', 'aria-label': 'Show or hide goals', onclick: toggle, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
    h('span', { class: 'gl-badge' }, h('span', { class: 'gl-target' }, '🎯'), 'Mayor’s Goals'), GL.count, GL.chip, h('span', { class: 'gl-chev', 'data-tip': 'Show / hide goals' }, '▾'));
  GL.card = h('div', { class: 'gl-card pe hide' }, head, GL.mini, GL.list);
  GL.col.appendChild(GL.card);
  // the desk card opening / closing folds the list right away (hud_desk dispatches this on the column)
  GL.col.addEventListener('deskstate', applyCompact);
}
function saveCollapsed() {
  try { localStorage.setItem(LS_KEY, GL.collapsed ? '1' : '0'); } catch (e) { /* private mode / blocked storage */ }
}
function toggle() {
  VC.bus.emit('sfx', { name: 'click' });
  if (deskOpen()) {
    // a decision is open (list folded for it): the click peeks at the goals / folds them again
    if (GL.card.classList.contains('compact')) {
      GL.peek = true;
      if (GL.collapsed) { GL.collapsed = false; saveCollapsed(); }
    } else GL.peek = false;
  } else {
    GL.collapsed = !GL.collapsed;
    saveCollapsed();
  }
  applyCompact();
}
const deskOpen = () => !!(GL.col && GL.col.classList.contains('desk-open'));
function applyCompact() {
  if (!GL.card) return;
  if (!deskOpen()) GL.peek = false;
  const compact = GL.collapsed || (deskOpen() && !GL.peek);
  GL.card.classList.toggle('compact', compact);
}

/* ---------------- items ---------------- */
function makeItem(g) {
  const bar = h('i');
  const ptext = h('span', { class: 'gl-ptext' });
  const act = h('div', { class: 'gl-act' });
  const el = h('div', { class: 'gl-item cat-' + (g.cat || 'grow') + ' new' },
    h('div', { class: 'gl-ico' }, g.icon || '🎯'),
    h('div', { class: 'gl-main' },
      h('div', { class: 'gl-title' }, g.title || ''),
      h('div', { class: 'gl-desc', 'data-tip': esc(g.desc || '') }, g.desc || ''),
      h('div', { class: 'gl-prow' }, h('div', { class: 'gl-bar' }, bar), ptext),
      h('div', { class: 'gl-row' }, h('span', { class: 'gl-reward', 'data-tip': '<b>Reward</b><br>' + esc(rewardLong(g)) }, (g.reward && g.reward.text) || ''), act)),
    h('button', { class: 'gl-swap', 'data-tip': 'Swap for a different goal', 'aria-label': 'Swap goal', onclick: (e) => { e.stopPropagation(); swapGoal(g.id, el); } }, '↻'));
  setTimeout(() => el.classList.remove('new'), 700);
  const it = { el, bar, ptext, act, g, done: null, pv: -1, tv: null, mini: h('i', null, h('b')) };
  setActions(it);
  return it;
}
function setActions(it) {
  const done = !!it.g.done;
  if (it.done === done) return;
  it.done = done;
  it.act.textContent = '';
  it.el.classList.toggle('done', done);
  if (done) it.act.appendChild(h('button', { class: 'btn small gl-claim', onclick: (e) => { e.stopPropagation(); claimGoal(it); } }, '🎁 Claim'));
  else it.act.appendChild(h('button', { class: 'btn small ghost gl-show', 'data-tip': 'Show me where / how', onclick: (e) => { e.stopPropagation(); showMe(it.g.id); } }, '👉 Show me'));
}
/** Rebuilds the item set only when goals were added / removed / reordered. */
function syncItems(goals) {
  let sig = '';
  for (let i = 0; i < goals.length; i++) sig += goals[i].id + ',';
  if (sig !== GL.sig) {
    GL.sig = sig;
    const keep = new Set();
    for (const g of goals) {
      keep.add(g.id);
      let it = GL.items.get(g.id);
      if (!it) { it = makeItem(g); GL.items.set(g.id, it); }
      it.g = g;
      GL.list.appendChild(it.el); // (re)order
      GL.mini.appendChild(it.mini);
    }
    for (const [id, it] of GL.items) {
      if (keep.has(id)) continue;
      GL.items.delete(id);
      it.mini.remove();
      if (it.el.classList.contains('out')) continue;
      it.el.classList.add('out');
      setTimeout(() => it.el.remove(), 360);
    }
  }
  let claimable = 0;
  for (const g of goals) {
    const it = GL.items.get(g.id);
    if (!it) continue;
    it.g = g;
    setActions(it);
    if (g.done) claimable++;
    const p = Math.round((g.progress || 0) * 1000) / 10;
    if (p !== it.pv) {
      it.pv = p;
      it.bar.style.width = p + '%';
      it.mini.firstChild.style.width = p + '%';
      it.mini.classList.toggle('done', !!g.done);
    }
    const t = g.done ? 'Complete!' : g.text || '';
    if (t !== it.tv) { it.tv = t; it.ptext.textContent = t; }
  }
  const n = goals.length;
  const txt = claimable ? '' : `${n} active`;
  if (GL.count.textContent !== txt) GL.count.textContent = txt;
  GL.chip.classList.toggle('show', claimable > 0);
}
function refresh() {
  if (!GL.card) return;
  const G = VC.goals;
  const goals = G && G.list ? G.list() : [];
  const vis = !!VC.state && !demo() && !tutorialOn() && goals.length > 0;
  if (vis !== GL.vis) {
    GL.vis = vis;
    GL.card.classList.toggle('hide', !vis);
  }
  applyCompact();
  if (vis) syncItems(goals);
}

/* ---------------- actions ---------------- */
function showMe(id) {
  const f = VC.goals && VC.goals.focusOf ? VC.goals.focusOf(id) : null;
  VC.bus.emit('sfx', { name: 'click' });
  if (!f) return;
  try {
    if (f.overlay && VC.gfx && VC.gfx.setOverlay) VC.gfx.setOverlay(f.overlay);
    if (isFinite(f.x) && isFinite(f.z) && VC.camera && VC.camera.focus) VC.camera.focus(f.x, f.z, f.dist || Math.min((VC.camera.goal && VC.camera.goal.dist) || 30, 30));
    if (f.panel && VC.hud.openPanel) VC.hud.openPanel(f.panel);
    if (f.group && VC.hud.openPalette) VC.hud.openPalette(f.group);
    if (f.tool && VC.tools && VC.tools.select && (!VC.tools.isTool || VC.tools.isTool(f.tool))) VC.tools.select(f.tool);
  } catch (e) { console.error('[goals] show me', e); }
}
function claimGoal(it) {
  const g = it.g;
  if (!VC.goals || !VC.goals.claim(g.id)) return;
  VC.bus.emit('sfx', { name: 'cash' });
  // the reward floats up out of the item while it slides away
  const r = it.el.getBoundingClientRect(), cr = GL.col.getBoundingClientRect();
  const s = (VC.ui && VC.ui.scale && VC.ui.scale()) || 1;
  const fl = h('div', { class: 'gl-float' }, (g.reward && g.reward.text) || '🎁');
  fl.style.left = Math.round((r.left - cr.left) / s + 44) + 'px';
  fl.style.top = Math.round((r.top - cr.top) / s + 8) + 'px';
  GL.col.appendChild(fl);
  setTimeout(() => fl.remove(), 1500);
  refresh();
}
function swapGoal(id, el) {
  VC.bus.emit('sfx', { name: 'click' });
  if (VC.goals && VC.goals.swap && VC.goals.swap(id)) refresh();
  else if (VC.ui && VC.ui.flash) VC.ui.flash(el, 'shake-bad');
}
function celebrate(g) {
  if (!g || demo() || !VC.hud.visible) return;
  const reward = rewardLong(g) ? `<br><small>Claim your reward: ${esc(rewardLong(g))}</small>` : '';
  VC.ui.toast(`<b>Goal complete!</b> ${esc(g.title)}${reward}`, {
    type: 'good', icon: '🎯', duration: 6500, sfx: 'achievement',
    onClick: () => { if (GL.collapsed) toggle(); },
  });
  try {
    const cam = VC.camera;
    if (VC.fx && VC.fx.confetti && cam && isFinite(cam.tx)) VC.fx.confetti(cam.tx, cam.tz, 140);
  } catch (e) { /* fx optional */ }
  refresh();
}

if (VC.hud && VC.hud.register) {
  VC.hud.register({
    name: 'goals',
    order: 45,
    init() {
      try { GL.collapsed = localStorage.getItem(LS_KEY) === '1'; } catch (e) { GL.collapsed = false; }
      build();
      VC.bus.on('goalsChanged', () => { if (VC.hud.visible) refresh(); });
      VC.bus.on('goalDone', (e) => celebrate(e && e.goal));
      // toasts pick a lane that keeps off the goals card when they can
      if (VC.ui && VC.ui.toastAvoid) VC.ui.toastAvoid.push(() => (GL.vis && GL.card && VC.hud.visible ? GL.card.getBoundingClientRect() : null));
    },
    reset() {
      for (const it of GL.items.values()) { it.el.remove(); it.mini.remove(); }
      GL.items.clear();
      GL.sig = '';
      GL.vis = false;
      GL.peek = false;
      if (GL.card) GL.card.classList.add('hide');
      GL.acc = 0.4;
    },
    update(dt, rdt) {
      GL.acc += rdt;
      if (GL.acc < 0.5) return;
      GL.acc = 0;
      refresh();
    },
    onHide() { GL.vis = false; if (GL.card) GL.card.classList.add('hide'); },
  });
}
