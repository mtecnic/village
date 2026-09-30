/*
 * VOXELPOLIS — Advisors ('advisors') and Milestones ('milestones') panels.
 * advisors: portrait cards for VC.ADVISORS with live advice (VC.advisors.advice) and unread badges;
 *   clicking a portrait filters the inbox. Inbox from VC.advisors.messages(): unread bold, severity
 *   colour, date, click to expand + markRead, "mark all read".
 * milestones: current rank badge + progress to the next population milestone, the full milestone
 *   ladder with rewards and everything each one unlocks (derived from catalog/roads/zoning/policy
 *   unlock values), and the achievements grid (VC.advisors.achievements()).
 */
const P = VC.panels, U = P.util, h = VC.h, M = VC.M;

/* ================================================================== */
/* ADVISORS                                                             */
/* ================================================================== */
let advFilter = null; // advisor key filter for the inbox
const SEV = { info: 'ℹ️', good: '✅', warn: '⚠️', bad: '⛔' };

function messages() {
  const m = U.api('advisors', 'messages', [], null) || (VC.advisors && VC.advisors.inbox) || [];
  return Array.isArray(m) ? m : [];
}
function markRead(m) {
  if (!m || m.read) return;
  U.api('advisors', 'markRead', [m.id]);
  m.read = true; // the message object is shared; keep the UI consistent even if markRead is a no-op
}

P.defs.advisors = {
  title: 'City Advisors',
  icon: '🧑‍💼',
  width: 660,
  place: 'center',
  build(p) {
    const grid = h('div', { class: 'pn-advc-grid' });
    const cards = {};
    for (const k in VC.ADVISORS) {
      const a = VC.ADVISORS[k];
      const text = h('div', { class: 'pn-advc-text' });
      const badge = h('span', { class: 'pn-advc-badge' });
      const el = h('div', { class: 'pn-advc', role: 'button', onclick: () => {
        advFilter = advFilter === k ? null : k;
        VC.bus.emit('sfx', { name: 'click' });
        upd(true);
      } }, h('div', { class: 'pn-advc-por' }, h('span', { class: 'pn-advc-emoji' }, a.icon), badge), h('div', { class: 'pn-advc-name' }, a.name), h('div', { class: 'pn-advc-role' }, a.role), text);
      el.style.setProperty('--c', a.color || '#5ad1ff');
      grid.appendChild(el);
      cards[k] = { el, text, badge };
    }
    p.body.appendChild(U.sec('Your cabinet', grid));

    const filt = h('span', { class: 'pn-inbox-filter' });
    const clear = VC.ui.button('Show all', () => {
      advFilter = null;
      upd(true);
    }, { cls: 'small' });
    const markAll = VC.ui.button('Mark all read', () => {
      for (const m of messages()) markRead(m);
      upd(true);
    }, { icon: '✔️', cls: 'small' });
    const count = h('span', { class: 'pn-inbox-count' });
    const list = h('div', { class: 'pn-inbox' });
    const empty = U.empty('📭', 'Inbox empty', 'Your advisors will write to you when something needs your attention.');
    p.body.appendChild(h('div', { class: 'pn-sec' }, h('div', { class: 'pn-toolbar pn-inbox-bar' }, h('span', { class: 'pn-sec-title pn-inline' }, 'Inbox'), count, filt, clear, h('span', { class: 'pn-grow' }), markAll), list, empty));

    const msgEl = (m) => {
      const a = VC.ADVISORS[m.advisor] || { icon: '📨', name: 'City Hall', color: '#5ad1ff' };
      const title = h('div', { class: 'pn-msg-title' });
      const date = h('span', { class: 'pn-msg-date' });
      const text = h('div', { class: 'pn-msg-text' });
      const el = h('div', { class: 'pn-msg', onclick: () => {
        el.classList.toggle('open');
        markRead(el._m);
        upd(true);
      } }, h('div', { class: 'pn-msg-por' }, a.icon), h('div', { class: 'pn-msg-body' }, h('div', { class: 'pn-msg-top' }, title, date), h('div', { class: 'pn-msg-from' }, a.name + ' · ' + (a.role || '')), text));
      el.style.setProperty('--c', a.color || '#5ad1ff');
      el.set = (mm) => {
        el._m = mm;
        U.txt(title, (SEV[mm.severity] || '') + ' ' + (mm.title || 'Message'));
        U.txt(date, mm.day != null ? VC.fmt.fullDate(mm.day) : '');
        U.txt(text, mm.text || '');
        U.cls(el, 'unread', !mm.read);
        U.cls(el, 'sev-' + (mm.severity || 'info'), true);
      };
      return el;
    };

    function upd() {
      const all = messages();
      const unread = {};
      let nUnread = 0;
      for (const m of all)
        if (!m.read) {
          unread[m.advisor] = (unread[m.advisor] || 0) + 1;
          nUnread++;
        }
      for (const k in cards) {
        const c = cards[k];
        const adv = String(U.api('advisors', 'advice', [k], '') || '');
        U.txt(c.text, adv || 'Nothing to report — keep up the good work.');
        U.cls(c.text, 'quiet', !adv);
        U.attr(c.el, 'data-tip', adv ? `<b>${VC.ADVISORS[k].name}</b><br>${adv.replace(/</g, '&lt;')}` : null);
        U.txt(c.badge, unread[k] ? String(unread[k]) : '');
        U.show(c.badge, !!unread[k]);
        U.cls(c.el, 'sel', advFilter === k);
        U.cls(c.el, 'dim', !!advFilter && advFilter !== k);
      }
      let shown = advFilter ? all.filter((m) => m.advisor === advFilter) : all;
      shown = shown.slice(-80).reverse(); // newest first
      U.keyed(list, shown, (m, i) => (m.id != null ? m.id : 'i' + i), msgEl, (el, m) => el.set(m));
      U.show(empty, !shown.length);
      U.txt(count, nUnread ? nUnread + ' unread' : 'all read');
      U.tone(count, nUnread ? 'info' : 'muted');
      U.txt(filt, advFilter ? '· ' + VC.ADVISORS[advFilter].icon + ' ' + VC.ADVISORS[advFilter].name : '');
      U.show(clear, !!advFilter);
      markAll.disabled = !nUnread;
    }
    return upd;
  },
};

/* ================================================================== */
/* MILESTONES                                                           */
/* ================================================================== */
/** Everything that unlocks inside milestone i's population range. */
function unlocksFor(i) {
  const MS = VC.MILESTONES;
  const lo = MS[i].pop, hi = i + 1 < MS.length ? MS[i + 1].pop : Infinity;
  const inR = (u) => (u || 0) >= lo && (u || 0) < hi;
  const out = [];
  for (const k in VC.ROADS) {
    const r = VC.ROADS[k];
    if (inR(r.unlock)) out.push({ icon: r.icon, name: r.name, kind: 'Road', unlock: r.unlock || 0 });
  }
  for (const d of [1, 2, 3]) if (inR(VC.DENSITY_UNLOCK[d])) out.push({ icon: ['🏡', '🏢', '🏙️'][d - 1], name: VC.DENSITY[d] + ' density zoning', kind: 'Zoning', unlock: VC.DENSITY_UNLOCK[d] });
  for (const b of VC.CATALOG) if (inR(b.unlock)) out.push({ icon: b.icon, name: b.name, kind: 'Building', unlock: b.unlock || 0 });
  for (const p of VC.POLICIES) if (inR(p.unlock)) out.push({ icon: p.icon, name: p.name, kind: 'Policy', unlock: p.unlock || 0 });
  out.sort((a, b) => a.unlock - b.unlock);
  return out;
}
const RANK_ICONS = ['🛖', '🏘️', '🏡', '🏙️', '🌆', '🌃', '🏙️', '🌐', '🚀', '🪐'];

function msLadder(c) {
  const MS = VC.MILESTONES;
  const rows = [];
  const box = h('div', { class: 'pn-ms-list' });
  MS.forEach((m, i) => {
    const st = h('div', { class: 'pn-ms-dot' });
    const un = unlocksFor(i);
    const chips = h('div', { class: 'pn-ms-unl' }, un.map((u) => h('span', { class: 'pn-ms-chip', 'data-tip': `<b>${u.name}</b><br>${u.kind} · unlocks at ${U.int(u.unlock)} residents` }, u.icon)));
    const el = h('div', { class: 'pn-ms' }, st,
      h('div', { class: 'pn-ms-main' },
        h('div', { class: 'pn-ms-top' }, h('span', { class: 'pn-ms-icon' }, RANK_ICONS[i] || '🏆'), h('span', { class: 'pn-ms-name' }, m.name), h('span', { class: 'pn-ms-pop' }, i ? U.int(m.pop) + ' residents' : 'Start'), h('span', { class: 'pn-grow' }), m.reward ? h('span', { class: 'pn-ms-reward' }, '+' + U.money(m.reward)) : null),
        un.length ? chips : h('div', { class: 'pn-ms-none' }, 'Bragging rights.'))
    );
    box.appendChild(el);
    rows.push({ el, st });
  });
  c.appendChild(box);
  return () => {
    const cur = U.milestoneIndex();
    rows.forEach((r, i) => {
      U.cls(r.el, 'done', i <= cur);
      U.cls(r.el, 'next', i === cur + 1);
      U.cls(r.el, 'future', i > cur + 1);
      U.txt(r.st, i <= cur ? '✓' : i === cur + 1 ? '🎯' : '🔒');
    });
  };
}

function msAchievements(c) {
  const sum = h('div', { class: 'pn-ach-sum' });
  const bar = U.meter('Unlocked', { color: 'linear-gradient(90deg, #b388ff, #5ad1ff)' });
  const grid = h('div', { class: 'pn-ach-grid' });
  const empty = U.empty('🎖️', 'No achievements yet', 'Achievements will appear here as you play.');
  c.append(sum, bar, grid, empty);
  const achEl = (a) => {
    const el = h('div', { class: 'pn-ach' }, h('div', { class: 'pn-ach-icon' }, a.icon || '🏅'), h('div', { class: 'pn-ach-name' }, a.name || a.key), h('div', { class: 'pn-ach-desc' }, a.desc || ''));
    el.set = (x) => {
      U.cls(el, 'done', !!x.done);
      U.attr(el, 'data-tip', `<b>${x.name || x.key}</b><br>${x.desc || ''}<br>${x.done ? '✅ Unlocked' : '🔒 Not yet unlocked'}`);
    };
    return el;
  };
  return () => {
    const list = U.api('advisors', 'achievements', [], []) || [];
    const done = list.filter((a) => a.done).length;
    U.txt(sum, list.length ? `${done} of ${list.length} achievements unlocked` : '');
    bar.set(list.length ? done / list.length : 0, list.length ? U.pct(done / list.length) : '');
    U.show(bar, list.length);
    // unlocked first, then the rest in definition order
    const order = list.filter((a) => a.done).concat(list.filter((a) => !a.done));
    U.keyed(grid, order, (a, i) => a.key || 'a' + i, achEl, (el, a) => el.set(a));
    U.show(empty, !list.length);
  };
}

P.defs.milestones = {
  title: 'Milestones & Achievements',
  icon: '🏆',
  width: 580,
  place: 'left',
  build(p) {
    const MS = VC.MILESTONES;
    const badge = h('div', { class: 'pn-rank-badge' });
    const name = h('div', { class: 'pn-rank-name' });
    const sub = h('div', { class: 'pn-rank-sub' });
    const prog = U.meter('Progress to next milestone', { cls: 'big', color: 'linear-gradient(90deg, #ffd166, #ff9f43)' });
    const next = h('div', { class: 'pn-rank-next' });
    p.body.appendChild(h('div', { class: 'pn-rank' }, badge, h('div', { class: 'pn-rank-info' }, name, sub, prog, next)));
    p.body.appendChild(
      U.tabs(p, [
        { key: 'ladder', label: 'Milestones', icon: '🏆', render: msLadder },
        { key: 'achievements', label: 'Achievements', icon: '🎖️', render: msAchievements },
      ])
    );
    return () => {
      const S = VC.state;
      const i = U.milestoneIndex();
      const m = MS[i], n = MS[i + 1];
      U.txt(badge, RANK_ICONS[i] || '🏆');
      U.txt(name, m.name);
      U.txt(sub, `Rank ${i + 1} of ${MS.length} · peak population ${U.int(S.peakPop)}`);
      if (n) {
        const f = M.sat((S.peakPop - m.pop) / Math.max(1, n.pop - m.pop));
        prog.set(f, U.int(S.peakPop) + ' / ' + U.int(n.pop));
        U.txt(next, `Next: ${RANK_ICONS[i + 1] || '🏆'} ${n.name} — ${U.int(Math.max(0, n.pop - S.peakPop))} more residents · reward ${U.money(n.reward)}`);
      } else {
        prog.set(1, 'MAX');
        U.txt(next, '🌟 You have reached the highest rank. Legendary!');
      }
    };
  },
};
