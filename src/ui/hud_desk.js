/*
 * VOXELPOLIS — HUD: Mayor's Desk card (the display side of VC.desk). A decision card slides into the shared
 * left column (.gl-col, under the goals card; below the windows layer): the presenting advisor's portrait,
 * name and role, time left to decide, the story, 2-3 choice buttons each with a line of effect chips (green
 * good, red bad, gold money, violet gamble; how long it lasts on the right) and a countdown bar. Not a modal:
 * the game keeps running. The countdown follows VC.desk.timeLeft(): game days, or — when fast-forwarding
 * makes the real-time minimum the later deadline — real seconds ("⏳ 42 s").
 *   FOLDED  "–" folds the card into a "📨 1" badge in the goals card header (or, while the goals card is
 *           hidden, a slim "Decision waiting" pill); click it to reopen. The countdown keeps running.
 *   OUTCOME choosing shows the outcome text in the card ("Got it" / auto-close after 14 s, paused on hover).
 *   NOTIFICATIONS  bus 'deskEvent' -> the card + sfx 'advisor' (one sound). An unanswered decision that
 *   expires (bus 'deskResolved' auto) -> ONE toast with the outcome (sfx 'notify'). A choice -> 'click'.
 *   Nothing in the title-screen demo. Toasts keep off the open card (VC.ui.toastAvoid).
 * While the card is open the column carries .desk-open (+ a 'deskstate' DOM event) and the goals list folds
 * away. Registers as a VC.hud part (order 46).
 *
 * COLUMN LAYOUT (VC.deskHud.layout(), also used by ui/hud_goals.js): the shared left column sits under the
 * top bar — or under the tutorial card while that shows (set synchronously when a card appears, so it never
 * slides in underneath it) — and its max-height stops above whatever HUD block lies below it in its lane:
 * the minimap (+ legend), the toolbar, the ticker, advisor cards and the dock when they reach that far
 * (measured with getBoundingClientRect, re-checked 5x a second, on show / state changes and on resize).
 * The CHOICES ARE ALWAYS VISIBLE: the card's story (title + text) shrinks and scrolls, the header and the
 * choices never do; when the lane above the minimap is too short for that (short viewport, overlay legend,
 * large UI scale), the column moves into the lane beside the minimap while the decision is open (it never
 * covers the minimap). Only on a viewport too small for either does the whole card scroll, with a sticky
 * "↓ 3 choices" chip. A goals list peeked at meanwhile gets only the room the decision leaves.
 */
const h = VC.h;
const DK = { col: null, card: null, badge: null, v: null, state: 'none', acc: 0, lay: 0, outT: 0, hover: false, choices: [], daysEl: null, pillDays: null, badgeDays: null, timer: null, out: null, body: null, story: null, full: null, chWrap: null, more: null, gFixed: 0, peekBest: Infinity, peekVar: undefined };
const esc = (s) => (VC.ui && VC.ui.esc ? VC.ui.esc(s) : String(s == null ? '' : s));
const demo = () => !!(VC.state && VC.state.demo) || !!(VC.menu && VC.menu.active);
const OUT_MS = 14000;

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
function build(v) {
  const card = h('div', { class: 'dk-card pe' });
  card.style.setProperty('--ac', (v.advisor && v.advisor.color) || '#ffd166');
  card.addEventListener('pointerenter', () => (DK.hover = true));
  card.addEventListener('pointerleave', () => (DK.hover = false));
  const reopen = () => { VC.bus.emit('sfx', { name: 'click' }); setState('open'); };
  DK.pillDays = h('span', { class: 'dk-pill-d' });
  const pill = h('button', { class: 'dk-pill', 'data-tip': 'A decision is waiting on your desk', onclick: reopen },
    h('span', { class: 'dk-pill-ico' }, '📨', h('b', { class: 'dk-pill-n' }, '1')),
    h('span', { class: 'dk-pill-t' }, h('small', null, 'Decision waiting'), h('span', null, v.title)),
    DK.pillDays);
  // the folded badge docks into the goals card header when that card is showing
  DK.badgeDays = h('span', { class: 'dk-badge-d' });
  DK.badge = h('button', { class: 'dk-badge', 'data-tip': esc(v.title) + '<br><small>A decision is waiting on your desk</small>', 'aria-label': 'Open the decision on your desk', onclick: (e) => { e.stopPropagation(); reopen(); } },
    '📨', h('b', null, '1'), DK.badgeDays);
  DK.daysEl = h('span', { class: 'dk-days', 'data-tip': 'Time left to decide — after that the matter settles itself.<br><small>You always get at least a minute of real time, even at top speed.</small>' });
  const a = v.advisor || {};
  // header: portrait | "Mayor's Desk · days left" over the presenter | fold
  const head = h('div', { class: 'dk-head' },
    h('div', { class: 'dk-portrait' }, h('span', null, a.icon || '💼')),
    h('div', { class: 'dk-whot' },
      h('span', { class: 'dk-tag' }, '📨 Mayor’s Desk', DK.daysEl),
      h('span', { class: 'dk-by' }, h('b', { class: 'dk-name' }, a.name || 'City Hall'), a.role ? h('span', { class: 'dk-role' }, a.role) : null)),
    h('button', { class: 'win-btn dk-min', 'data-tip': 'Decide later', 'aria-label': 'Decide later', onclick: () => { VC.bus.emit('sfx', { name: 'click' }); setState('min'); } }, h('i')));
  const title = h('div', { class: 'dk-title' }, h('span', { class: 'dk-ticon' }, v.icon || '📨'), h('span', null, v.title));
  const text = h('div', { class: 'dk-text' }, v.text);
  DK.choices = v.choices.map((c) => {
    const b = h('button', { class: 'dk-choice' + (c.ignore ? ' ig' : ''), onclick: () => choose(c.i) },
      h('span', { class: 'dk-crow' }, h('span', { class: 'dk-clabel' }, c.label), c.dur ? h('span', { class: 'dk-dur', 'data-tip': 'How long the effects last' }, '⏳ ' + c.dur) : null),
      h('span', { class: 'dk-chips' }, c.chips.map((x) => h('span', { class: 'dk-fx ' + (x.c || 'neu') }, x.t))));
    b._cost = c.cost || 0;
    return b;
  });
  DK.out = h('div', { class: 'dk-out' });
  DK.timer = h('i');
  // the column is height-capped: the STORY (title + text) shrinks and scrolls, the choices never do (see
  // goals.css); only when even the story's minimum does not fit does the whole card (.dk-full) scroll, with a
  // sticky "↓ 3 choices" chip while choices are out of view
  DK.story = h('div', { class: 'dk-story' }, title, text);
  DK.chWrap = h('div', { class: 'dk-choices' }, DK.choices);
  DK.body = h('div', { class: 'dk-body' }, DK.story, DK.chWrap, DK.out);
  const n = DK.choices.length;
  DK.more = h('button', { class: 'dk-more', 'aria-label': 'Scroll to the choices', onclick: () => { const f = DK.full; if (f) f.scrollTo({ top: f.scrollHeight, behavior: 'smooth' }); } }, '↓ ' + n + ' choice' + (n === 1 ? '' : 's'));
  DK.full = h('div', { class: 'dk-full' }, head, DK.body, DK.more);
  DK.story.addEventListener('scroll', moreHint, { passive: true });
  DK.full.addEventListener('scroll', moreHint, { passive: true });
  card.append(pill, DK.full, h('div', { class: 'dk-timer' }, DK.timer));
  return card;
}
/**
 * Fades the bottom of the story while more of it is scrolled out of view; shows the sticky "↓ N choices" chip
 * while the card itself is cut above its last choice (tiny viewports only).
 */
function moreHint() {
  const st = DK.story, f = DK.full;
  if (st) st.classList.toggle('more', st.scrollHeight - st.clientHeight - st.scrollTop > 4);
  if (!f || !DK.chWrap) return;
  let cut = false;
  if (DK.state === 'open' && f.scrollHeight - f.clientHeight > 2) {
    const last = DK.choices[DK.choices.length - 1];
    cut = !!last && last.getBoundingClientRect().bottom > f.getBoundingClientRect().bottom + 1;
  }
  if (f.classList.contains('cut') !== cut) f.classList.toggle('cut', cut);
}
/** state: 'open' (full card) | 'min' (folded: header badge or pill) | 'done' (outcome) | 'none'. */
function setState(st) {
  DK.state = st;
  if (DK.card) {
    DK.card.classList.toggle('min', st === 'min');
    DK.card.classList.toggle('done', st === 'done');
  }
  deskClass(st === 'open' || st === 'done');
  dock();
  refresh();
  layoutCol();
  if (VC.ui && VC.ui.layoutToasts) VC.ui.layoutToasts();
}
/** .desk-open on the shared column (+ a DOM event so the goals card folds / unfolds right away). */
function deskClass(on) {
  if (!DK.col || DK.col.classList.contains('desk-open') === on) return;
  DK.col.classList.toggle('desk-open', on);
  try { DK.col.dispatchEvent(new CustomEvent('deskstate')); } catch (e) { /* old browsers: the 2 Hz poll catches up */ }
}
/** Folded: badge in the visible goals header, else the pill card. */
function dock() {
  if (!DK.card || !DK.badge) return;
  const head = DK.state === 'min' && DK.col ? DK.col.querySelector('.gl-card:not(.hide) .gl-head') : null;
  if (head) {
    if (DK.badge.parentNode !== head) {
      const chev = head.querySelector('.gl-chev');
      head.insertBefore(DK.badge, chev || null);
      VC.ui && VC.ui.flash && VC.ui.flash(DK.badge, 'dk-badge-in');
    }
  } else if (DK.badge.parentNode) DK.badge.remove();
  hasDesk();
  DK.card.classList.toggle('docked', !!head);
}
/** .has-desk on the goals header while the badge sits in it (goals.css shortens the label beside a Claim chip). */
function hasDesk() {
  const head = DK.col && DK.col.querySelector('.gl-head');
  if (!head) return;
  const on = !!(DK.badge && DK.badge.parentNode === head);
  if (head.classList.contains('has-desk') !== on) head.classList.toggle('has-desk', on);
}
function show(v, sound, state) {
  if (!v) return;
  DK.col = ensureCol();
  if (!DK.col) return;
  close(true);
  DK.v = v;
  DK.card = build(v);
  DK.col.appendChild(DK.card);
  layoutCol(); // before the first paint: never slide in under the tutorial card
  setState(state || 'open');
  if (sound) VC.bus.emit('sfx', { name: 'advisor' });
}
function close(instant) {
  const c = DK.card;
  if (DK.badge) DK.badge.remove();
  DK.card = null;
  DK.badge = null;
  hasDesk();
  DK.v = null;
  DK.choices = [];
  DK.story = DK.full = DK.chWrap = DK.more = null;
  DK.hover = false;
  deskClass(false);
  DK.state = 'none';
  if (!c) return;
  if (instant) c.remove();
  else {
    c.classList.add('out');
    setTimeout(() => c.remove(), 380);
  }
}
function choose(i) {
  if (!VC.desk || !DK.v || DK.state !== 'open') return;
  const r = VC.desk.choose(i);
  if (!r || !r.ok) {
    // unaffordable: VC.desk emitted 'noMoney' (its own toast + sound); just shake the button
    const b = DK.choices[i];
    if (b && VC.ui && VC.ui.flash) VC.ui.flash(b, 'shake-bad');
    return;
  }
  VC.bus.emit('sfx', { name: 'click' });
}
/** Outcome view after a manual choice. */
function showOutcome(label, outcome) {
  if (!DK.card || !DK.out) return;
  DK.out.textContent = '';
  DK.out.append(
    h('div', { class: 'dk-out-label' }, h('span', { class: 'dk-out-ok' }, '✓'), h('span', null, label || 'Decision made')),
    h('div', { class: 'dk-out-text' }, outcome || ''),
    h('div', { class: 'dk-out-row' }, h('button', { class: 'btn small primary', onclick: () => { VC.bus.emit('sfx', { name: 'click' }); close(false); } }, 'Got it')));
  DK.outT = performance.now();
  setState('done');
}
function onResolved(e) {
  if (!e) return;
  const same = DK.v && e.event && DK.v.seq === e.event.seq;
  if (e.auto) {
    if (same) close(false);
    if (!demo() && VC.hud.visible && e.event) {
      VC.ui.toast(`📨 <b>${esc(e.event.title)}</b> — no decision in time.<br><small>${esc(e.outcome || '')}</small>`, { type: 'info', icon: '⏳', duration: 7500, sfx: 'notify' });
    }
    return;
  }
  if (same) showOutcome(e.label, e.outcome);
}

/* ---------------- live refresh (2 Hz) ---------------- */
function refresh() {
  const S = VC.state;
  if (!DK.card || !DK.v || !S) return;
  moreHint();
  if (DK.state === 'done') {
    if (!DK.hover && performance.now() - DK.outT > OUT_MS) close(false);
    return;
  }
  // game days, or real seconds when fast-forwarding makes the real-time minimum the later deadline
  const tl = VC.desk && VC.desk.timeLeft ? VC.desk.timeLeft() : null;
  const left = tl ? tl.days : Math.max(0, DK.v.expires - S.time.day);
  let t, short, frac, urgent;
  if (tl && tl.bySec) {
    const sec = Math.ceil(tl.sec);
    t = ' · ⏳ ' + sec + ' s';
    short = sec + 's';
    frac = tl.frac;
    urgent = sec <= 10;
  } else {
    t = ' · ⏳ ' + (left === 1 ? '1 day' : left + ' days');
    short = left + 'd';
    frac = tl ? tl.frac : left / (DK.v.decideDays || 60);
    urgent = left <= 10;
  }
  if (DK.daysEl.textContent !== t) DK.daysEl.textContent = t;
  if (DK.pillDays.textContent !== short) { DK.pillDays.textContent = short; DK.badgeDays.textContent = short; }
  DK.timer.style.width = Math.round(frac * 1000) / 10 + '%';
  DK.card.classList.toggle('urgent', urgent);
  if (DK.badge) DK.badge.classList.toggle('urgent', urgent);
  for (const b of DK.choices) {
    const ok = !b._cost || S.sandbox || S.money >= b._cost;
    if (b.disabled === ok) {
      b.disabled = !ok;
      b.title = ok ? '' : 'Not enough money';
    }
  }
}
/* ---------------- column layout (see header) ---------------- */
// COL_FLOOR: the smallest max-height (CSS px) — a card header — even when a block sits right under the top;
// STORY_MIN: the desk story's min-height (goals.css .dk-story); PEEK_MIN: room wanted for a peeked goals list
const COL_TOP = 70, COL_W = 324, COL_GAP = 8, COL_FLOOR = 44, STORY_MIN = 52, PEEK_MIN = 110;
const LANE_BLOCKS = ['.hud-bl', '.hud-toolbar', '.hl-notes', '.hud-dock'];
// size changes of the blocks around the column (minimap legend, tutorial card, …) re-layout it before the
// next paint; the 5 Hz poll covers moves without a size change
let colRO = null;
const colSeen = new WeakSet();
function watch(el) {
  if (!el || colSeen.has(el)) return;
  if (!colRO) {
    if (typeof ResizeObserver !== 'function') return;
    colRO = new ResizeObserver(() => layoutCol());
  }
  colSeen.add(el);
  colRO.observe(el);
}
/** Visible element's screen rect (null when missing / hidden / zero-sized). */
function rectOf(el) {
  if (!el || !el.offsetParent && getComputedStyle(el).position !== 'fixed') return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}
/**
 * Room of the lane [x0, x1) (screen px) below top0: under the tutorial card while a desk card shows and the
 * tutorial card overlaps the lane; down to the first HUD block that starts below the top and shares the lane
 * (minimap + legend, toolbar, advisor cards, dock), and above the ticker. -> {x0, top, h}
 */
function lane(root, x0, x1, top0) {
  const vh = window.innerHeight;
  let top = top0;
  // the tutorial card (z above the column) only shares the spot with a desk card: goals hide meanwhile
  const tut = DK.card ? rectOf(root.querySelector('.tut-card:not(.out)')) : null;
  if (tut && tut.right > x0 && tut.left < x1) top = Math.max(top, Math.round(tut.bottom + COL_GAP));
  let bottom = vh - COL_GAP;
  const tick = root.querySelector('.hud-ticker');
  if (tick && !tick.classList.contains('hidden') && tick.offsetHeight) bottom = Math.min(bottom, vh - tick.offsetHeight - COL_GAP);
  for (const sel of LANE_BLOCKS) {
    for (const el of root.querySelectorAll(sel)) {
      watch(el);
      const r = rectOf(el);
      // every block in the lane that starts below the column top caps it (one beside the top bar does not)
      if (!r || r.right <= x0 || r.left >= x1 || r.top <= top) continue;
      bottom = Math.min(bottom, Math.floor(r.top - COL_GAP));
    }
  }
  return { x0, top, h: bottom - top };
}
/** CSS px the open desk card needs with its story at the minimum (header, choices / outcome in full). */
function deskNeed() {
  const c = DK.card, f = DK.full, st = DK.story;
  if (!c || !f || !st) return 0;
  const cut = Math.max(0, f.scrollHeight - f.clientHeight); // (the whole card scrolls: add what is cut off)
  const chip = f.classList.contains('cut') && DK.more ? DK.more.offsetHeight + 2 : 0;
  return c.offsetHeight + cut - chip - st.clientHeight + Math.min(st.scrollHeight, STORY_MIN);
}
/**
 * Places the shared left column: top under the top bar (or the tutorial card while it shows), max-height
 * down to the first HUD block below it that shares its lane (minimap + legend, toolbar, ticker, advisor
 * cards, dock). While a decision is open and that lane is too short for its choices (short viewports, the
 * overlay legend, a large UI scale), the column moves into the lane beside the minimap when that one has
 * more room — it never covers the minimap. Sets --gl-avail (CSS px, the goals list's 40 % peek cap) and
 * --gl-peek (room a peeked goals list may take without pushing the decision's choices out).
 */
function layoutCol() {
  const col = DK.col || ensureCol();
  const root = VC.hud && VC.hud.root;
  if (!col || !root || !VC.hud.visible) return;
  DK.col = col;
  const s = (VC.ui && VC.ui.scale && VC.ui.scale()) || 1;
  let top0 = COL_TOP;
  const bar = root.querySelector('.hud-top');
  watch(bar);
  watch(root.querySelector('.hl-tut'));
  if (bar && bar.offsetHeight) top0 = Math.max(top0, Math.round(8 + bar.offsetHeight * s + COL_GAP));
  const w = Math.ceil(COL_W * s);
  const N = lane(root, 10, 10 + w, top0);
  const fits = (Ln, cssPx) => !!Ln && cssPx * s <= Ln.h;
  // the lane beside the minimap — or, while the tutorial card sits above that lane, beside the tutorial
  // card, whichever is taller (only measured when the usual lane is too short)
  let B;
  const beside = () => {
    if (B !== undefined) return B;
    B = null;
    const bl = rectOf(root.querySelector('.hud-bl'));
    if (!bl) return B;
    const xs = [Math.round(bl.right + COL_GAP)];
    const tut = rectOf(root.querySelector('.tut-card:not(.out)'));
    if (tut && tut.right + COL_GAP > xs[0]) xs.push(Math.round(tut.right + COL_GAP));
    for (const x0 of xs) {
      if (x0 + w > window.innerWidth - 8) continue;
      const Ln = lane(root, x0, x0 + w, top0);
      if (!B || Ln.h > B.h) B = Ln;
    }
    return B;
  };
  let L = N, peek = '', yieldGoals = false;
  if (DK.card && (DK.state === 'open' || DK.state === 'done')) {
    // the goals card above the decision: header (+ mini bars) always, a peeked list only if there is room.
    // (Its folded height is remembered while it yields, so the choice below cannot flip back and forth.)
    const gl = col.querySelector('.gl-card:not(.hide)');
    let peeking = false;
    if (!gl) DK.gFixed = 0;
    else if (gl.offsetHeight) {
      const list = gl.querySelector('.gl-list');
      peeking = gl.classList.contains('peek');
      DK.gFixed = gl.offsetHeight - (list && list.offsetHeight ? list.offsetHeight + 7 : 0) + COL_GAP;
    }
    const desk = deskNeed(), gFixed = DK.gFixed || 0;
    // Where the decision's choices fit, in order: the usual lane with the goals header above them -> (a goals
    // list being peeked at: beside the minimap with the goals) -> the usual lane, the goals card stepping aside
    // until the decision is made or folded -> beside the minimap with / without the goals card -> the larger
    // lane (the card then scrolls as a whole). The goals card's height is remembered while it steps aside,
    // so this cannot flip back and forth.
    let pick = null;
    if (peeking) pick = fits(N, desk + gFixed + PEEK_MIN) ? N : fits(beside(), desk + gFixed + PEEK_MIN) ? beside() : null;
    if (!pick && fits(N, desk + gFixed)) pick = N;
    if (!pick && peeking && fits(beside(), desk + gFixed)) pick = beside();
    if (!pick && gFixed && fits(N, desk)) { pick = N; yieldGoals = true; }
    if (!pick && fits(beside(), desk + gFixed)) pick = beside();
    if (!pick && gFixed && fits(beside(), desk)) { pick = beside(); yieldGoals = true; }
    if (!pick) { pick = beside() && beside().h > N.h ? beside() : N; yieldGoals = !!gFixed; }
    L = pick;
    const need = desk + (yieldGoals ? 0 : gFixed);
    peek = Math.max(0, Math.floor(L.h / s - need - 7)) + 'px';
    // the most room a peeked goals list could get in either lane (hud_goals folds the decision instead of
    // peeking into a sliver: VC.deskHud.peekRoom)
    const room = (Ln) => (Ln ? Math.floor(Ln.h / s - desk - gFixed - 7) : -1);
    DK.peekBest = gFixed ? Math.max(room(N), room(beside())) : -1;
  } else {
    DK.peekBest = Infinity;
    // not even a card header fits above the minimap (tiny viewport, big UI scale, overlay legend): the goals
    // card / decision pill go beside it rather than over it
    if (!fits(N, COL_FLOOR) && fits(beside(), COL_FLOOR)) L = beside();
  }
  if (col.classList.contains('gl-yield') !== yieldGoals) col.classList.toggle('gl-yield', yieldGoals);
  const avail = Math.max(COL_FLOOR, L.h / s);
  const x = L.x0 + 'px', t = L.top + 'px', mh = Math.floor(avail) + 'px';
  if (col.style.left !== x) col.style.left = x;
  if (col.style.top !== t) col.style.top = t;
  if (col.style.maxHeight !== mh) {
    col.style.maxHeight = mh;
    col.style.setProperty('--gl-avail', mh);
  }
  if (peek !== DK.peekVar) {
    DK.peekVar = peek;
    if (peek) col.style.setProperty('--gl-peek', peek);
    else col.style.removeProperty('--gl-peek');
  }
  moreHint();
}

/**
 * Shared with ui/hud_goals.js: layout(); peekRoom() -> CSS px a peeked goals list could get beside an open
 * decision (Infinity without one); fold() -> folds an open decision into its header badge ("Decide later").
 */
VC.deskHud = {
  layout: layoutCol,
  peekRoom: () => (DK.card && (DK.state === 'open' || DK.state === 'done') ? (DK.peekBest == null ? Infinity : DK.peekBest) : Infinity),
  fold() {
    if (!DK.card || DK.state !== 'open') return false;
    setState('min');
    return true;
  },
};

if (VC.hud && VC.hud.register) {
  VC.hud.register({
    name: 'desk',
    order: 46,
    init() {
      DK.col = ensureCol();
      VC.bus.on('deskEvent', (e) => {
        if (!e || !e.event || demo()) return;
        show(e.event, VC.hud.visible, 'open');
      });
      VC.bus.on('deskResolved', onResolved);
      // the goals card appearing / disappearing moves the folded badge
      VC.bus.on('goalsChanged', () => { if (DK.state === 'min') setTimeout(dock, 0); });
      if (VC.ui && VC.ui.toastAvoid) {
        VC.ui.toastAvoid.push(() => (DK.card && (DK.state === 'open' || DK.state === 'done') && VC.hud.visible ? DK.card.getBoundingClientRect() : null));
      }
      window.addEventListener('resize', () => { DK.lay = 1; });
      VC.bus.on('settings', () => { DK.lay = 1; }); // UI scale, ticker on/off
    },
    reset() {
      close(true);
      DK.acc = 0.4;
      const v = VC.desk && VC.desk.pending ? VC.desk.pending() : null;
      if (v && !demo()) show(v, false, 'open');
    },
    update(dt, rdt) {
      // layout 5x a second (the tutorial card, minimap legend or ticker can change under the column)
      DK.lay += rdt;
      if (DK.lay >= 0.2) { DK.lay = 0; layoutCol(); }
      DK.acc += rdt;
      if (DK.acc < 0.5) return;
      DK.acc = 0;
      refresh();
      if (DK.state === 'min') dock();
    },
  });
}
