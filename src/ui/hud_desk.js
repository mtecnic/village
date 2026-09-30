/*
 * VOXELPOLIS — HUD: Mayor's Desk card (the display side of VC.desk). A decision card slides into the shared
 * left column (.gl-col, under the goals card; below the windows layer): the presenting advisor's portrait,
 * name and role, days left to decide, the story, 2-3 choice buttons each with a line of effect chips (green
 * good, red bad, gold money, violet gamble; how long it lasts on the right) and a countdown bar. Not a modal:
 * the game keeps running.
 *   FOLDED  "–" folds the card into a "📨 1" badge in the goals card header (or, while the goals card is
 *           hidden, a slim "Decision waiting" pill); click it to reopen. The countdown keeps running.
 *   OUTCOME choosing shows the outcome text in the card ("Got it" / auto-close after 14 s, paused on hover).
 *   NOTIFICATIONS  bus 'deskEvent' -> the card + sfx 'advisor' (one sound). An unanswered decision that
 *   expires (bus 'deskResolved' auto) -> ONE toast with the outcome (sfx 'notify'). A choice -> 'click'.
 *   Nothing in the title-screen demo. Toasts keep off the open card (VC.ui.toastAvoid).
 * While the card is open the column carries .desk-open (+ a 'deskstate' DOM event) and the goals list folds
 * away. Registers as a VC.hud part (order 46).
 */
const h = VC.h;
const DK = { col: null, card: null, badge: null, v: null, state: 'none', acc: 0, outT: 0, hover: false, choices: [], daysEl: null, pillDays: null, badgeDays: null, timer: null, out: null };
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
  DK.daysEl = h('span', { class: 'dk-days', 'data-tip': 'Days left to decide — after that the matter settles itself' });
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
  card.append(pill, h('div', { class: 'dk-full' }, head, h('div', { class: 'dk-body' }, title, text, h('div', { class: 'dk-choices' }, DK.choices), DK.out)), h('div', { class: 'dk-timer' }, DK.timer));
  return card;
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
  if (DK.state === 'done') {
    if (!DK.hover && performance.now() - DK.outT > OUT_MS) close(false);
    return;
  }
  const left = Math.max(0, DK.v.expires - S.time.day);
  const t = ' · ⏳ ' + (left === 1 ? '1 day' : left + ' days');
  if (DK.daysEl.textContent !== t) DK.daysEl.textContent = t;
  const short = left + 'd';
  if (DK.pillDays.textContent !== short) { DK.pillDays.textContent = short; DK.badgeDays.textContent = short; }
  DK.timer.style.width = Math.round((left / (DK.v.decideDays || 60)) * 1000) / 10 + '%';
  const urgent = left <= 10;
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
/** Keeps the column under the tutorial card when a decision shows up while the tutorial runs. */
function layoutCol() {
  if (!DK.col) return;
  const tut = DK.card && VC.hud.root ? VC.hud.root.querySelector('.tut-card:not(.out)') : null;
  const top = tut ? Math.round(tut.getBoundingClientRect().bottom + 8) + 'px' : '';
  if (DK.col.style.top !== top) DK.col.style.top = top;
}

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
    },
    reset() {
      close(true);
      DK.acc = 0.4;
      const v = VC.desk && VC.desk.pending ? VC.desk.pending() : null;
      if (v && !demo()) show(v, false, 'open');
    },
    update(dt, rdt) {
      DK.acc += rdt;
      if (DK.acc < 0.5) return;
      DK.acc = 0;
      refresh();
      if (DK.state === 'min') dock();
      layoutCol();
    },
  });
}
