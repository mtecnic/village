/*
 * VOXELPOLIS — Policies panel ('policies'): responsive card grid of VC.POLICIES, filterable by
 * category tabs. Each card shows icon, name, description, effect chips (green = good for the city),
 * monthly cost (VC.econ.policyCost, or cost + costPerCap × population), what it enables, a toggle
 * (VC.econ.setPolicy) and a locked state until the unlock population is reached.
 */
const P = VC.panels, U = P.util, h = VC.h;

const CATS = [
  { key: 'all', label: 'All', icon: '📜' },
  { key: 'active', label: 'Active', icon: '✅' },
  { key: 'safety', label: 'Safety', icon: '🚨' },
  { key: 'health', label: 'Health & Education', icon: '🩺' },
  { key: 'env', label: 'Environment', icon: '🌿' },
  { key: 'economy', label: 'Economy', icon: '💼' },
  { key: 'society', label: 'Society', icon: '🎭' },
];
const CAT_OF = {
  smoke_detectors: 'safety', neighborhood_watch: 'safety', curfew: 'safety',
  free_clinics: 'health', tutoring: 'health',
  recycling_law: 'env', clean_air: 'env', green_energy: 'env', water_saving: 'env', bike_lanes: 'env',
  tourism_promo: 'economy', pro_business: 'economy', gambling: 'economy', rent_control: 'economy',
  nightlife: 'society', free_transit: 'society', four_day_week: 'society', pets: 'society', ubi: 'society',
};
/** Category for a policy; unknown keys are classified by their strongest effect. */
function catOf(p) {
  if (CAT_OF[p.key]) return CAT_OF[p.key];
  const e = p.effects || {};
  let best = null, bv = -1;
  for (const k in e) if (Math.abs(e[k]) > bv) { bv = Math.abs(e[k]); best = k; }
  if (best === 'crime' || best === 'fire') return 'safety';
  if (best === 'health' || best === 'education') return 'health';
  if (/pollution|garbage|powerUse|waterUse|noise/.test(best || '')) return 'env';
  if (/demand|tax|tourism|landValue|growth/.test(best || '')) return 'economy';
  return 'society';
}
/** Monthly cost: VC.econ.policyCost when it is meaningful, else the catalog formula. */
function cost(p) {
  const S = VC.state;
  const pop = U.num(S.stats && S.stats.pop);
  const calc = (p.cost || 0) + (p.costPerCap || 0) * pop;
  const v = U.api('econ', 'policyCost', [p.key], null);
  if (typeof v !== 'number' || !isFinite(v) || (v === 0 && calc > 0)) return calc;
  return v;
}
const unlocked = (p) => U.safe(() => VC.world.isUnlocked(p.key), true);
const isOn = (p) => !!(VC.state.policies && VC.state.policies[p.key]);

function setPolicy(p, on, card) {
  if (!VC.econ || !VC.econ.setPolicy) {
    VC.bus.emit('toast', { text: 'Policies are unavailable right now.', type: 'bad', icon: '📜' });
    card.sw.setValue(isOn(p));
    return;
  }
  if (on && !unlocked(p)) {
    card.sw.setValue(false);
    VC.bus.emit('toast', { text: `<b>${p.name}</b> unlocks at ${U.int(p.unlock)} residents.`, type: 'warn', icon: '🔒' });
    return;
  }
  const ok = U.safe(() => VC.econ.setPolicy(p.key, on), false);
  if (ok === false) {
    // VC.econ explains refusals itself (locked / can't afford) — just snap the switch back
    card.sw.setValue(isOn(p));
  } else {
    VC.bus.emit('toast', { text: on ? `<b>${p.name}</b> enacted.` : `<b>${p.name}</b> repealed.`, type: on ? 'good' : 'info', icon: p.icon });
    VC.bus.emit('sfx', { name: on ? 'policy' : 'click' });
  }
  P.refresh();
}

function makeCard(p) {
  const costEl = h('span', { class: 'pn-pol-cost' });
  const lock = h('span', { class: 'pn-pol-lock' }, '🔒 ' + U.short(p.unlock) + ' pop');
  const chips = h('div', { class: 'pn-chips' });
  for (const k in p.effects || {}) chips.appendChild(U.effectChip(k, p.effects[k]));
  const enables = VC.CATALOG.filter((b) => b.requiresPolicy === p.key);
  let card;
  const sw = VC.ui.toggle({ label: '', value: isOn(p), tip: 'Enact / repeal', onChange: (v) => setPolicy(p, v, card) });
  sw.classList.add('pn-pol-sw');
  card = h('div', { class: 'pn-pol' },
    h('div', { class: 'pn-pol-top' }, h('div', { class: 'pn-pol-icon' }, p.icon || '📜'), h('div', { class: 'pn-pol-title' }, h('div', { class: 'pn-pol-name' }, p.name), h('div', { class: 'pn-pol-state' }))),
    h('div', { class: 'pn-pol-desc' }, p.desc || ''),
    chips,
    enables.length ? h('div', { class: 'pn-pol-enables' }, 'Enables: ', enables.map((b) => b.icon + ' ' + b.name).join(', ')) : null,
    h('div', { class: 'pn-pol-foot' }, h('div', { class: 'pn-pol-costs' }, costEl, p.costPerCap ? h('span', { class: 'pn-pol-per', 'data-tip': 'Cost scales with population' }, '$' + p.costPerCap + ' per resident') : h('span', { class: 'pn-pol-per' }, p.cost ? 'flat fee' : 'no running cost')), h('span', { class: 'pn-grow' }), lock, sw)
  );
  card.sw = sw;
  card.stateEl = card.querySelector('.pn-pol-state');
  card.set = () => {
    const on = isOn(p), un = unlocked(p);
    U.cls(card, 'on', on);
    U.cls(card, 'locked', !un);
    if (!sw._drag) sw.setValue(on);
    sw.input.disabled = !un && !on; // a locked policy that is somehow active can still be repealed
    const c = cost(p);
    U.txt(costEl, c > 0 ? U.money(c) + '/mo' : 'Free');
    U.show(lock, !un);
    U.show(sw, un || on);
    U.txt(card.stateEl, !un ? 'Locked' : on ? 'Active' : 'Inactive');
    U.tone(card.stateEl, !un ? 'muted' : on ? 'good' : '');
    U.attr(card, 'data-tip', un ? null : `<b>🔒 Locked</b><br>Reach a population of <b>${U.int(p.unlock)}</b> to unlock this policy.`);
  };
  return card;
}

function renderCat(cat) {
  return (c) => {
    const grid = h('div', { class: 'pn-pol-grid' });
    const empty = U.empty(cat === 'active' ? '🗂️' : '📭', cat === 'active' ? 'No active policies' : 'Nothing here', cat === 'active' ? 'Enact policies from the other tabs to shape your city.' : '');
    c.append(grid, empty);
    const want = () => VC.POLICIES.filter((p) => (cat === 'all' ? true : cat === 'active' ? isOn(p) : catOf(p) === cat));
    return () => {
      const list = want();
      // unlocked first, keep catalog order otherwise
      const order = list.filter(unlocked).concat(list.filter((p) => !unlocked(p)));
      U.keyed(grid, order, (p) => p.key, makeCard, (cd) => cd.set());
      U.show(empty, !order.length);
    };
  };
}

P.defs.policies = {
  title: 'Policies & Ordinances',
  icon: '📜',
  width: 700,
  place: 'center',
  build(p) {
    const kAct = U.kpi('Active', { icon: '✅' });
    const kCost = U.kpi('Monthly cost', { icon: '💸', tip: 'Total monthly cost of all active policies at the current population.' });
    const kUn = U.kpi('Unlocked', { icon: '🔓', tip: 'Policies unlock as your population grows.' });
    p.body.appendChild(h('div', { class: 'pn-kpis cols3 pn-pol-sum' }, kAct, kCost, kUn));
    p.body.appendChild(U.tabs(p, CATS.map((ct) => ({ key: ct.key, label: ct.label, tip: ct.icon + ' ' + ct.label, render: renderCat(ct.key) }))));
    return () => {
      let n = 0, sum = 0, un = 0;
      for (const pol of VC.POLICIES) {
        if (isOn(pol)) {
          n++;
          sum += cost(pol);
        }
        if (unlocked(pol)) un++;
      }
      kAct.set(n + ' / ' + VC.POLICIES.length, n ? 'policies in force' : 'none enacted yet');
      const inc = U.num(VC.state.stats.income);
      kCost.set(U.money(sum) + '/mo', sum > 0 ? (inc > 0 ? Math.round((sum / inc) * 100) + '% of monthly income' : 'recurring expense') : 'nothing to pay', sum > 0 ? 'warn' : '');
      kUn.set(un + ' / ' + VC.POLICIES.length, un < VC.POLICIES.length ? 'grow to unlock more' : 'all unlocked');
    };
  },
};
