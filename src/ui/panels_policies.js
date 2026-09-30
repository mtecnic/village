/*
 * VOXELPOLIS — Policies panel ('policies'): responsive card grid of VC.POLICIES, filterable by
 * category tabs (def.cat, else classified by the strongest effect).
 *
 * POLICY LEVELS (VC.econ contract): a policy has a level 0..1 (0 = off). Each card shows icon, name,
 * state, description, effect chips scaled live to the level, an INTENSITY SLIDER (0-100 %, step 5,
 * labelled with def.unit, e.g. "Patrol hours") and the monthly cost at that level vs. at 100 %.
 * Binary policies (def.levels === false) only get the on/off toggle. Slider cards also keep a
 * toggle: on = the level last used for that policy in this city (100 % the first time; forgotten on New City /
 * load: bus 'started' + panel reset), off = repeal.
 *
 * DRAG = PREVIEW, RELEASE = COMMIT: while a slider moves, chips, cost and the header totals preview
 * the new level locally; on release VC.econ.setPolicy(key, level) is called once. One change -> one
 * toast here (level tweaks within a few seconds update the same toast in place) + the audio
 * module's 'policyChanged' sound. Refusals: locked -> a toast here; unaffordable -> VC.money's
 * single 'noMoney' HUD toast; the slider snaps back to the real level.
 *
 * HEADER: active count, total monthly policy cost (live while dragging, share of income),
 * unlocked count, the combined effect of all policies + temporary modifiers on the city (chips),
 * and the temporary effects themselves (VC.econ.tempMods(): Mayor's Desk decisions, goal rewards)
 * with the days they have left.
 */
const P = VC.panels, U = P.util, h = VC.h, M = VC.M;

const CATS = [
  { key: 'all', label: 'All', icon: '📜' },
  { key: 'active', label: 'Active', icon: '✅' },
  { key: 'safety', label: 'Safety', icon: '🚨' },
  { key: 'health', label: 'Health & Education', icon: '🩺' },
  { key: 'env', label: 'Environment', icon: '🌿' },
  { key: 'economy', label: 'Economy', icon: '💼' },
  { key: 'society', label: 'Society', icon: '🎭' },
];
const CAT_KEYS = { safety: 1, health: 1, env: 1, economy: 1, society: 1 };
/** Category for a policy: def.cat, else classified by its strongest effect. */
function catOf(p) {
  if (CAT_KEYS[p.cat]) return p.cat;
  const e = p.effects || {};
  let best = null, bv = -1;
  for (const k in e) if (Math.abs(e[k]) > bv) { bv = Math.abs(e[k]); best = k; }
  if (best === 'crime' || best === 'fire') return 'safety';
  if (best === 'health' || best === 'education') return 'health';
  if (/pollution|garbage|powerUse|waterUse|noise/.test(best || '')) return 'env';
  if (/demand|tax|tourism|landValue|growth/.test(best || '')) return 'economy';
  return 'society';
}

/* ---------------- levels & costs (VC.econ first, safe fallbacks) ---------------- */
const hasLevels = (p) => p.levels !== false;
/** Stored level of a policy 0..1 (true from very old states = 1). */
function levelOf(p) {
  const v = U.api('econ', 'policyLevel', [p.key], null);
  if (typeof v === 'number' && isFinite(v)) return M.clamp(v, 0, 1);
  const s = VC.state && VC.state.policies ? VC.state.policies[p.key] : 0;
  return s === true ? 1 : M.clamp(+s || 0, 0, 1);
}
const isOn = (p) => levelOf(p) > 0;
const unlocked = (p) => U.safe(() => VC.world.isUnlocked(p.key), true);
/** Monthly cost at 100 %: VC.econ.policyCost when it is meaningful, else the catalog formula. */
function fullCost(p) {
  const S = VC.state;
  const pop = U.num(S.stats && S.stats.pop);
  const calc = (p.cost || 0) + (p.costPerCap || 0) * pop;
  const v = U.api('econ', 'policyCost', [p.key, 1], null);
  if (typeof v !== 'number' || !isFinite(v) || (v === 0 && calc > 0)) return calc;
  return v;
}
const costAt = (p, l) => Math.round(fullCost(p) * l);

/** Levels being dragged (not committed yet): key -> 0..1. */
const preview = Object.create(null);
/** Last non-zero level per policy this session (the toggle re-enacts at it). */
const lastLevel = Object.create(null);
/** Level shown on the card: the drag preview, else the real level. */
const shownLevel = (p) => (preview[p.key] != null ? preview[p.key] : levelOf(p));
const pctOf = (l) => Math.round(l * 100);
function levelWord(l) {
  if (!(l > 0)) return 'Off';
  if (l < 0.3) return 'Light';
  if (l < 0.55) return 'Moderate';
  if (l < 0.8) return 'Strong';
  if (l < 1) return 'Very strong';
  return 'Full';
}

/* ---------------- effect chips (updated in place) ---------------- */
/** Signed percent; one decimal for small non-integral values (+0.3 %, −4.5 %). */
const fpct = (v) => U.spct(v, Math.abs(v) < 0.095 && Math.abs(Math.round(v * 1000)) % 10 ? 1 : 0);
function chip(k) {
  const m = U.MODS[k] || { icon: '•', label: k, good: 1 };
  const el = h('span', { class: 'pn-chip' });
  el.set = (v) => {
    const good = v * m.good > 0;
    U.txt(el, m.icon + ' ' + m.label + ' ' + fpct(v));
    U.tone(el, Math.abs(v) < 0.0005 ? 'muted' : good ? 'good' : 'bad');
    U.attr(el, 'data-tip', `<b>${m.label}</b> ${fpct(v)} — ${good ? 'good' : 'bad'} for the city`);
  };
  return el;
}

/* ---------------- commits & feedback ---------------- */
let lastToast = null; // {key, el, t}: level tweaks of the same policy update one toast in place
function feedback(p, prev, now) {
  const name = `<b>${U.esc(p.name)}</b>`;
  const lv = hasLevels(p) && now > 0 && now < 1 ? ` at <b>${pctOf(now)}%</b>` : '';
  let text, type;
  if (!(prev > 0)) { text = `${name} enacted${lv}.`; type = 'good'; }
  else if (!(now > 0)) { text = `${name} repealed.`; type = 'info'; }
  else { text = `${name} set to <b>${pctOf(now)}%</b> <small>(was ${pctOf(prev)}%)</small>`; type = 'info'; }
  const t = performance.now();
  const L = lastToast;
  if (L && L.key === p.key && t - L.t < 2600 && L.el.isConnected && !L.el.classList.contains('out') && prev > 0 && now > 0) {
    const txt = L.el.querySelector('.toast-text');
    if (txt && VC.ui.sanitize) {
      txt.textContent = '';
      txt.appendChild(VC.ui.sanitize(text));
      if (VC.ui.flash) VC.ui.flash(L.el, 'pn-toast-bump');
      L.t = t;
      return;
    }
  }
  const el = VC.ui.toast(text, { type, icon: p.icon });
  lastToast = el ? { key: p.key, el, t } : null;
}
/** Applies a level through VC.econ (one call per user action) and reports the outcome. */
function commit(p, level) {
  const prev = levelOf(p);
  level = hasLevels(p) ? Math.round(M.clamp(+level || 0, 0, 1) * 100) / 100 : level > 0 ? 1 : 0;
  delete preview[p.key];
  if (Math.abs(level - prev) < 0.005) {
    P.refresh('policies');
    return;
  }
  if (!VC.econ || !VC.econ.setPolicy) {
    VC.ui.toast('Policies are unavailable right now.', { type: 'bad', icon: '📜', sfx: 'error' });
    P.refresh('policies');
    return;
  }
  if (level > prev && !unlocked(p)) {
    VC.ui.toast(`<b>${U.esc(p.name)}</b> unlocks at ${U.int(p.unlock)} residents.`, { type: 'warn', icon: '🔒', sfx: 'error' });
    P.refresh('policies');
    return;
  }
  // econ explains its own refusals (locked toast / VC.money 'noMoney'); the card snaps back on refresh
  const ok = U.safe(() => VC.econ.setPolicy(p.key, hasLevels(p) ? level : level > 0), false);
  if (ok !== false) {
    const now = levelOf(p);
    if (now > 0) lastLevel[p.key] = now;
    else if (prev > 0) lastLevel[p.key] = prev;
    if (Math.abs(now - prev) >= 0.005) feedback(p, prev, now);
  }
  P.refresh('policies');
}

/* ---------------- card ---------------- */
function makeCard(p) {
  const lv = hasLevels(p);
  const costEl = h('span', { class: 'pn-pol-cost' });
  const perEl = h('span', { class: 'pn-pol-per' });
  const lock = h('span', { class: 'pn-pol-lock' }, '🔒 ' + U.short(p.unlock) + ' pop');
  const chips = h('div', { class: 'pn-chips' });
  const chipEls = [];
  for (const k in p.effects || {}) {
    const c = chip(k);
    c._k = k;
    chipEls.push(c);
    chips.appendChild(c);
  }
  const enables = VC.CATALOG.filter((b) => b.requiresPolicy === p.key);
  let card, sl = null, lvVal = null;
  const sw = VC.ui.toggle({ label: '', value: isOn(p), tip: lv ? 'Enact / repeal (the slider sets the intensity)' : 'Enact / repeal', onChange: (v) => commit(p, v ? lastLevel[p.key] || 1 : 0) });
  sw.classList.add('pn-pol-sw');
  let lvBox = null;
  if (lv) {
    lvVal = h('span', { class: 'pn-pol-lvval' });
    sl = U.slider({
      min: 0, max: 100, step: 5, value: pctOf(levelOf(p)), ticks: [25, 50, 75],
      format: (v) => v + '%',
      tip: `How hard the city pushes this policy. Effects and cost scale with the level; 0% repeals it.`,
      onInput: (v) => {
        preview[p.key] = v / 100;
        P.refresh('policies');
      },
      onChange: (v) => commit(p, v / 100),
    });
    sl.classList.add('pn-pol-slider');
    // a drag that ends without a 'change' (released on its start value, or outside the slider)
    // must still drop the preview: settle on the next tick after any pointer release
    const settle = () => setTimeout(() => {
      if (preview[p.key] != null && !sl._drag) commit(p, preview[p.key]);
    }, 0);
    sl.input.addEventListener('pointerdown', () => {
      window.addEventListener('pointerup', settle, { once: true });
      window.addEventListener('pointercancel', settle, { once: true });
    });
    lvBox = h('div', { class: 'pn-pol-lv' },
      h('div', { class: 'pn-pol-lvhead' }, h('span', { class: 'pn-pol-unit' }, '🎚️ ' + (p.unit || 'Intensity')), lvVal),
      sl);
  }
  card = h('div', { class: 'pn-pol' + (lv ? '' : ' binary') },
    h('div', { class: 'pn-pol-top' }, h('div', { class: 'pn-pol-icon' }, p.icon || '📜'), h('div', { class: 'pn-pol-title' }, h('div', { class: 'pn-pol-name' }, p.name), h('div', { class: 'pn-pol-state' }))),
    h('div', { class: 'pn-pol-desc' }, p.desc || ''),
    chips,
    lvBox,
    enables.length ? h('div', { class: 'pn-pol-enables' }, 'Enables: ', enables.map((b) => b.icon + ' ' + b.name).join(', ')) : null,
    h('div', { class: 'pn-pol-foot' }, h('div', { class: 'pn-pol-costs' }, costEl, perEl), h('span', { class: 'pn-grow' }), lock, sw)
  );
  card.sw = sw;
  card.stateEl = card.querySelector('.pn-pol-state');
  card.set = () => {
    const real = levelOf(p), on = real > 0, un = unlocked(p);
    const dragging = preview[p.key] != null;
    const shown = shownLevel(p);
    U.cls(card, 'drag', dragging);
    // what the chips / cost describe: the shown level, or (while off) the level it would enact at
    const fx = shown > 0 ? shown : lastLevel[p.key] || 1;
    U.cls(card, 'on', on || shown > 0);
    U.cls(card, 'locked', !un);
    U.cls(card, 'off-preview', !(shown > 0));
    sw.setValue(dragging ? shown > 0 : on);
    sw.input.disabled = !un && !on; // a locked policy that is somehow active can still be repealed
    U.show(sw, un || on);
    U.show(lock, !un);
    for (const c of chipEls) c.set(p.effects[c._k] * fx);
    const full = fullCost(p);
    if (lv) {
      sl.sync(pctOf(shown)); // (keyboard steps: 'input' before 'change' — keep the previewed value)
      sl.input.disabled = !un && !on;
      U.txt(lvVal, shown > 0 ? pctOf(shown) + '%' : 'Off');
      U.tone(lvVal, shown > 0 ? (dragging ? 'info' : 'good') : 'muted');
      const c = Math.round(full * fx);
      U.txt(costEl, full > 0 ? U.money(c) + '/mo' : 'Free');
      U.txt(perEl, full > 0 ? (fx < 1 ? `at ${pctOf(fx)}% · ${U.money(full)} at full` : p.costPerCap ? '$' + p.costPerCap + ' per resident' : 'flat fee') : 'no running cost');
      U.attr(perEl, 'data-tip', p.costPerCap ? `Cost scales with population ($${p.costPerCap} per resident at 100%) and with the policy level.` : full > 0 ? 'Flat monthly fee, scaled by the policy level.' : null);
    } else {
      U.txt(costEl, full > 0 ? U.money(full) + '/mo' : 'Free');
      U.txt(perEl, p.costPerCap ? '$' + p.costPerCap + ' per resident' : p.cost ? 'flat fee' : 'no running cost');
    }
    U.tone(costEl, !(shown > 0) ? 'muted' : '');
    U.txt(card.stateEl, !un && !on ? 'Locked' : shown > 0 ? (dragging ? 'Preview' : 'Active') + (lv ? ' · ' + levelWord(shown) : '') : 'Inactive');
    U.tone(card.stateEl, !un && !on ? 'muted' : shown > 0 ? (dragging ? 'info' : 'good') : '');
    U.attr(card, 'data-tip', un || on ? null : `<b>🔒 Locked</b><br>Reach a population of <b>${U.int(p.unlock)}</b> to unlock this policy.`);
  };
  return card;
}

function renderCat(cat) {
  return (c) => {
    const grid = h('div', { class: 'pn-pol-grid' });
    const empty = U.empty(cat === 'active' ? '🗂️' : '📭', cat === 'active' ? 'No active policies' : 'Nothing here', cat === 'active' ? 'Enact policies from the other tabs to shape your city.' : '');
    c.append(grid, empty);
    // the Active tab keeps a card that is being dragged down to 0 % until it is released
    const want = () => VC.POLICIES.filter((p) => (cat === 'all' ? true : cat === 'active' ? isOn(p) || preview[p.key] != null : catOf(p) === cat));
    return () => {
      const list = want();
      // unlocked first, keep catalog order otherwise
      const order = list.filter(unlocked).concat(list.filter((p) => !unlocked(p)));
      U.keyed(grid, order, (p) => p.key, makeCard, (cd) => cd.set());
      U.show(empty, !order.length);
    };
  };
}

/* ---------------- header: combined effect + temporary modifiers ---------------- */
/** Combined modifiers at the shown (preview) levels + active temporary modifiers, clamped like econ. */
function combinedMods(temps) {
  const m = {};
  for (const p of VC.POLICIES) {
    const l = shownLevel(p);
    if (!(l > 0)) continue;
    for (const k in p.effects || {}) m[k] = (m[k] || 0) + p.effects[k] * l;
  }
  for (const t of temps) for (const k in t.mods || {}) m[k] = (m[k] || 0) + (+t.mods[k] || 0);
  for (const k in m) m[k] = M.clamp(m[k], -0.95, 2);
  return m;
}
function tempPill() {
  const el = h('span', { class: 'pn-pill pn-temp' });
  el.set = (t, day) => {
    const left = Math.max(0, Math.ceil((U.num(t.until, day) - day)));
    const fx = [];
    for (const k in t.mods || {}) {
      const m = U.MODS[k] || { icon: '•', label: k, good: 1 };
      fx.push(m.icon + ' ' + U.spct(+t.mods[k] || 0));
    }
    U.txt(el, (t.icon || '⏳') + ' ' + (t.label || t.source || 'Temporary effect') + ' · ' + fx.join(' ') + (isFinite(t.until) ? ' · ' + left + 'd' : ''));
    let pos = 0, neg = 0;
    for (const k in t.mods || {}) {
      const g = (+t.mods[k] || 0) * ((U.MODS[k] && U.MODS[k].good) || 1);
      if (g > 0) pos++;
      else if (g < 0) neg++;
    }
    U.tone(el, pos && !neg ? 'good' : neg && !pos ? 'bad' : 'info'); // mixed blessings read neutral
    const lines = Object.keys(t.mods || {}).map((k) => `${(U.MODS[k] || { label: k }).label} ${U.spct(+t.mods[k] || 0)}`).join('<br>');
    U.attr(el, 'data-tip', `<b>${U.esc(t.label || 'Temporary effect')}</b>${t.source ? ' <small>(' + U.esc(t.source) + ')</small>' : ''}<br>${lines}` + (isFinite(t.until) ? `<br><small>Ends in ${left} day${left === 1 ? '' : 's'}</small>` : ''));
  };
  return el;
}

/** A new city / a loaded save: no slider level (or drag preview) carries over from the previous city. */
function forgetLevels() {
  for (const k in lastLevel) delete lastLevel[k];
  for (const k in preview) delete preview[k];
}

P.defs.policies = {
  title: 'Policies & Ordinances',
  icon: '📜',
  width: 720,
  place: 'center',
  init() {
    VC.bus.on('started', forgetLevels);
  },
  reset: forgetLevels,
  build(p) {
    const kAct = U.kpi('Active', { icon: '✅' });
    const kCost = U.kpi('Monthly cost', { icon: '💸', tip: 'Total monthly cost of all active policies at their current levels and population. Updates live while you drag a slider.' });
    const kUn = U.kpi('Unlocked', { icon: '🔓', tip: 'Policies unlock as your population grows.' });
    p.body.appendChild(h('div', { class: 'pn-kpis cols3 pn-pol-sum' }, kAct, kCost, kUn));
    // combined effect of everything in force (+ temporary effects)
    const netChips = h('div', { class: 'pn-chips' });
    const netNone = h('span', { class: 'pn-pol-netnone' }, 'No policy effects in force yet — enact a policy below.');
    const temps = h('div', { class: 'pn-pol-temps' });
    const tempRow = h('div', { class: 'pn-pol-temprow' }, h('span', { class: 'pn-pol-netlabel', 'data-tip': "Short-lived effects from Mayor's Desk decisions, goal rewards and events. They wear off on their own." }, '⏳ Temporary'), temps);
    const net = h('div', { class: 'pn-pol-net' },
      h('div', { class: 'pn-pol-netrow' }, h('span', { class: 'pn-pol-netlabel', 'data-tip': 'The combined effect of all active policies (and temporary effects) on your city. Effects of the same kind add up.' }, 'Σ Net effect'), netChips, netNone),
      tempRow);
    p.body.appendChild(net);
    p.body.appendChild(U.tabs(p, CATS.map((ct) => ({ key: ct.key, label: ct.label, tip: ct.icon + ' ' + ct.label, render: renderCat(ct.key) }))));
    return () => {
      let n = 0, sum = 0, un = 0, drag = false;
      for (const pol of VC.POLICIES) {
        const l = shownLevel(pol);
        if (l > 0) {
          n++;
          sum += costAt(pol, l);
        }
        if (preview[pol.key] != null) drag = true;
        if (unlocked(pol)) un++;
      }
      kAct.set(n + ' / ' + VC.POLICIES.length, n ? 'policies in force' : 'none enacted yet');
      const inc = U.num(VC.state.stats.income);
      kCost.set(U.money(sum) + '/mo', drag ? 'preview while dragging' : sum > 0 ? (inc > 0 ? Math.round((sum / inc) * 100) + '% of monthly income' : 'recurring expense') : 'nothing to pay', drag ? 'info' : sum > 0 ? 'warn' : '');
      kUn.set(un + ' / ' + VC.POLICIES.length, un < VC.POLICIES.length ? 'grow to unlock more' : 'all unlocked');
      // combined effect chips, strongest first
      const tm = U.api('econ', 'tempMods', [], []) || [];
      const m = combinedMods(tm);
      const keys = Object.keys(m).filter((k) => Math.abs(m[k]) >= 0.0005).sort((a, b) => Math.abs(m[b]) - Math.abs(m[a]));
      U.keyed(netChips, keys, (k) => k, chip, (c, k) => c.set(m[k]));
      U.show(netChips, keys.length);
      U.show(netNone, !keys.length);
      U.cls(net, 'drag', drag);
      const day = VC.state.time.day;
      U.keyed(temps, tm, (t, i) => (t.id != null ? 't' + t.id : 'i' + i), tempPill, (el, t) => el.set(t, day));
      U.show(tempRow, tm.length);
      // live count badge on the "Active" tab
      const at = p.tabs && p.tabs.querySelector('.tab[data-key="active"]');
      if (at) {
        if (!at._badge) at.appendChild((at._badge = h('span', { class: 'pn-tab-badge' })));
        U.txt(at._badge, String(n));
        U.show(at._badge, n > 0);
      }
    };
  },
};
