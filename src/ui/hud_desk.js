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
 * The desk card's body and the goals list scroll inside it instead of running into those blocks.
 */
const h = VC.h;
const DK = { col: null, card: null, badge: null, v: null, state: 'none', acc: 0, lay: 0, outT: 0, hover: false, choices: [], daysEl: null, pillDays: null, badgeDays: null, timer: null, out: null, body: null };
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
  // the body scrolls when the viewport is too short for the whole story (the column is height-capped)
  DK.body = h('div', { class: 'dk-body' }, title, text, h('div', { class: 'dk-choices' }, DK.choices), DK.out);
  DK.body.addEventListener('scroll', moreHint, { passive: true });
  card.append(pill, h('div', { class: 'dk-full' }, head, DK.body), h('div', { class: 'dk-timer' }, DK.timer));
  return card;
}
/** Fades the bottom of the card body while more choices are scrolled out of view. */
function moreHint() {
  const b = DK.body;
  if (b) b.classList.toggle('more', b.scrollHeight - b.clientHeight - b.scrollTop > 4);
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
  DK.card.classList.toggle('docked', !!head);
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
  DK.v = null;
  DK.choices = [];
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
const COL_TOP = 70, COL_W = 324, COL_GAP = 8, COL_MIN = 96;
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
 * Places the shared left column: top under the top bar (or the tutorial card while it shows), max-height
 * down to the first HUD block below it that shares its lane (minimap + legend, toolbar, ticker, advisor
 * cards, dock). Sets --gl-avail (CSS px) for the goals list's peek cap.
 */
function layoutCol() {
  const col = DK.col || ensureCol();
  const root = VC.hud && VC.hud.root;
  if (!col || !root || !VC.hud.visible) return;
  DK.col = col;
  const s = (VC.ui && VC.ui.scale && VC.ui.scale()) || 1;
  const vh = window.innerHeight;
  let top = COL_TOP;
  const bar = root.querySelector('.hud-top');
  watch(bar);
  watch(root.querySelector('.hl-tut'));
  if (bar && bar.offsetHeight) top = Math.max(top, Math.round(8 + bar.offsetHeight * s + COL_GAP));
  // the tutorial card (z above the column) only shares the spot with a desk card: goals hide meanwhile
  const tut = DK.card ? rectOf(root.querySelector('.tut-card:not(.out)')) : null;
  if (tut) top = Math.max(top, Math.round(tut.bottom + COL_GAP));
  const x0 = 10, x1 = 10 + COL_W * s;
  let bottom = vh - COL_GAP;
  const tick = root.querySelector('.hud-ticker');
  if (tick && !tick.classList.contains('hidden') && tick.offsetHeight) bottom = Math.min(bottom, vh - tick.offsetHeight - COL_GAP);
  for (const sel of ['.hud-bl', '.hud-toolbar', '.hl-notes', '.hud-dock']) {
    for (const el of root.querySelectorAll(sel)) {
      watch(el);
      const r = rectOf(el);
      // blocks in the column's lane that start below its top (a block beside the top would leave no room)
      if (!r || r.right <= x0 || r.left >= x1 || r.top < top + COL_MIN * s) continue;
      bottom = Math.min(bottom, Math.floor(r.top - COL_GAP));
    }
  }
  const avail = Math.max(COL_MIN, (bottom - top) / s);
  const t = top + 'px', mh = Math.floor(avail) + 'px';
  if (col.style.top !== t) col.style.top = t;
  if (col.style.maxHeight !== mh) {
    col.style.maxHeight = mh;
    col.style.setProperty('--gl-avail', mh);
  }
}

/** Shared with ui/hud_goals.js. */
VC.deskHud = { layout: layoutCol };

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
