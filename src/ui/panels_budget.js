/*
 * VOXELPOLIS — Budget & Taxes panel ('budget', the flagship manager window).
 * Tabs: Overview (net, treasury, 12-month projection, income/expense breakdown, actuals vs forecast),
 * Taxes (R/C/I sliders + 9 advanced wealth sliders, revenue + mood readouts), Departments (funding
 * sliders, cost, effectiveness, presets), Loans (offers + outstanding), History (charts with range).
 * All numbers come from VC.econ (forecast/deptUpkeep/effectiveness/taxEffect/loanOptions) with
 * fallbacks to S.ledger / catalog upkeep so the window stays meaningful before econ is present.
 *
 * WHAT-IF PREVIEW (Taxes + Departments tabs): grabbing a tax or funding slider (pointer or keyboard)
 * snapshots the city (forecast net, tax effects, funding, power/water supply); while it moves — the
 * settings apply live, as before — a glass card pinned to the bottom of the tab compares now vs.
 * that snapshot: monthly net change as a FIRST-MONTH ESTIMATE (the forecast at today's residents,
 * corrected by how many residents a tax hike / service cut drives away — or a cut / boost draws in —
 * within a month: reaction(), calibrated on branched saves of a stable town; every tax dollar
 * follows the residents, since shops and factories lose their workers and customers too),
 * R/C/I demand arrows (VC.econ.taxEffect deltas), citizens' mood
 * and approval, service effectiveness (VC.econ.effectivenessAt, strikes included), the likely knock-on
 * effects per department (crime, fires, traffic, brownouts…) and strike / diminishing-returns
 * warnings. It lingers ~2.5 s after release; grabbing the same slider again keeps the snapshot.
 * The Presets buttons show the same card for the whole budget. Departments also show the city
 * wage level (forecast().wageMul) and per-row cost breakdown tooltips; the Overview's income and
 * expense rows explain the state grant, wages and policies in tooltips.
 * MAYOR'S DESK COMMITMENTS: recurring deals agreed on the Mayor's Desk are forecast lines ('deskDeal',
 * "Mayor's Desk commitments") and, while any run, the Overview lists them (deal, $/month, months left)
 * from VC.econ.deskCommitments().
 */
const P = VC.panels, U = P.util, h = VC.h, M = VC.M;
const ZK = ['R', 'C', 'I'];
const ZNAME = { R: 'Residential', C: 'Commercial', I: 'Industrial' };
const ZICON = { R: '🏠', C: '🏬', I: '🏭' };

/* ---------------- data helpers ---------------- */
let fcCache = null, fcAt = 0;
/** Normalized forecast {income:{cat:+$}, expenses:{cat:+$}, totalIncome, totalExpenses, net, src}. Cached ~100 ms. */
function forecast() {
  const now = performance.now();
  if (fcCache && now - fcAt < 100 && fcCache.S === VC.state) return fcCache;
  const S = VC.state;
  const f = U.api('econ', 'forecast', [], null);
  const out = { income: {}, expenses: {}, totalIncome: 0, totalExpenses: 0, net: 0, src: 'forecast', S };
  let any = false;
  if (f && typeof f === 'object') {
    for (const k in f.income || {}) {
      const v = Math.abs(U.num(f.income[k]));
      if (!v) continue;
      out.income[k] = v;
      out.totalIncome += v;
      any = true;
    }
    for (const k in f.expenses || {}) {
      const v = Math.abs(U.num(f.expenses[k]));
      if (!v) continue;
      out.expenses[k] = v;
      out.totalExpenses += v;
      any = true;
    }
  }
  if (!any) {
    // econ not available yet: last month's actual ledger is the best predictor
    out.src = 'ledger';
    const L = (S.ledger && S.ledger.last) || {};
    for (const k in L) {
      const v = U.num(L[k]);
      if (v > 0) {
        out.income[k] = v;
        out.totalIncome += v;
      } else if (v < 0) {
        out.expenses[k] = -v;
        out.totalExpenses -= v;
      }
    }
  }
  out.net = out.totalIncome - out.totalExpenses;
  // extra detail from the real econ (per-wealth tax revenue and tax base) passes straight through
  if (any && f.taxDetail) out.taxDetail = f.taxDetail;
  if (any && f.taxBase) out.taxBase = f.taxBase;
  fcCache = out;
  fcAt = now;
  return out;
}
function ledgerSums(L) {
  let inc = 0, exp = 0;
  for (const k in L || {}) {
    const v = U.num(L[k]);
    if (v > 0) inc += v;
    else exp -= v;
  }
  return { inc, exp, net: inc - exp };
}
function taxAvg(z) {
  const t = VC.state.tax && VC.state.tax[z];
  if (!t) return 9;
  return (U.num(t[0], 9) + U.num(t[1], 9) + U.num(t[2], 9)) / 3;
}
function taxGet(z, w) {
  const v = U.api('econ', 'getTax', [z, w], null);
  if (typeof v === 'number') return v;
  const t = VC.state.tax && VC.state.tax[z];
  return t ? U.num(t[w], 9) : 9;
}
/** Same curve as VC.econ.taxEffect: +0.35 at 0 %, 0 at 9 %, −0.8 at 20 % (positive = citizens like it). */
function taxCurve(avg) {
  return avg <= 9 ? 0.35 * ((9 - avg) / 9) : -0.8 * Math.pow((avg - 9) / 11, 1.25);
}
/** Mood hint from VC.econ.taxEffect(zone) (demand/happiness effect, positive = good). */
function taxMood(z) {
  const avg = taxAvg(z);
  let e = U.api('econ', 'taxEffect', [z], null);
  // no econ (or a stub that always answers 0): use the documented curve
  if (typeof e !== 'number' || !isFinite(e) || (e === 0 && Math.abs(avg - 9) > 0.5)) e = taxCurve(avg);
  if (e > 0.12) return ['😄 Citizens are happy', 'good'];
  if (e > -0.12) return ['🙂 Acceptable', 'info'];
  if (e > -0.45) return ['😠 Grumbling', 'warn'];
  return ['🔥 Revolt!', 'bad'];
}
function deptCost(key) {
  const S = VC.state;
  let v = U.api('econ', 'deptUpkeep', [key], null);
  if (typeof v !== 'number' || !isFinite(v)) v = 0;
  if (v === 0) {
    // stub fallback: catalog upkeep (roads: per-tile upkeep) × funding × difficulty
    const f = S.budget[key] != null ? S.budget[key] : 1;
    const mul = U.safe(() => VC.money.costMul(), 1);
    let base = U.deptStats().up[key] || 0;
    if (key === 'roads') {
      const rc = U.roadCounts();
      base = 0;
      for (let t = 1; t <= 3; t++) base += rc[t] * ((VC.ROADS[t] && VC.ROADS[t].upkeep) || 0);
    }
    v = base * f * mul;
  }
  return Math.abs(v);
}
function effectiveness(key) {
  const S = VC.state;
  const f = S.budget[key] != null ? S.budget[key] : 1;
  return U.num(U.api('econ', 'effectiveness', [key], f), f);
}
const fundOf = (key) => {
  const S = VC.state;
  return S.budget && S.budget[key] != null ? S.budget[key] : 1;
};
/** Effectiveness at a funding level (VC.econ curve) incl. the strike penalty if the dept is out. */
function effAt(key, f) {
  let e = U.api('econ', 'effectivenessAt', [f], null);
  if (typeof e !== 'number' || !isFinite(e)) e = f <= 1 ? Math.pow(Math.max(0, f), 0.8) : 1 + 0.4 * (1 - Math.exp(-(f - 1) * 3));
  if (U.api('econ', 'onStrike', [key], false)) e *= U.num(VC.econ && VC.econ.STRIKE_MUL, 0.7);
  return e;
}
/** Demand / happiness effect of a zone's taxes (VC.econ.taxEffect, else the documented curve). */
function taxEff(z) {
  const avg = taxAvg(z);
  let e = U.api('econ', 'taxEffect', [z], null);
  if (typeof e !== 'number' || !isFinite(e) || (e === 0 && Math.abs(avg - 9) > 0.5)) e = taxCurve(avg);
  return e;
}
const fmtRate = (r) => (Math.round(U.num(r) * 10) / 10).toString().replace(/\.0$/, '') + '%';
/** ▲ / ▲▲ / ▲▲▲ (▼ for negative) by magnitude thresholds; '–' when negligible. */
function arrows(d, t1, t2, t3) {
  const a = Math.abs(d);
  if (!(a >= t1)) return '–';
  return (d > 0 ? '▲' : '▼').repeat(a < t2 ? 1 : a < t3 ? 2 : 3);
}
const toneOf = (good) => (good > 0 ? 'good' : good < 0 ? 'bad' : 'muted');
const span = (cls, text) => `<span class="${cls}">${text}</span>`;
/** Utilities output multiplier for an effectiveness level (same curve as the sim's plant output). */
const utilMul = (e) => M.clamp(0.15 + 0.85 * e, 0.15, 1.1);
/** Departments that pay city wages (VC.econ.WAGE_DEPTS; utilities and roads do not). */
const WAGE = (VC.econ && VC.econ.WAGE_DEPTS) || { police: 1, fire: 1, health: 1, education: 1, transit: 1, parks: 1, waste: 1 };
/** What funding changes do to the city, per department (dir: +1 = the metric rises with funding). */
const DEPT_FX = {
  police: [{ icon: '🦹', label: 'Crime', dir: -1 }],
  fire: [{ icon: '🔥', label: 'Fire risk', dir: -1 }],
  health: [{ icon: '🩺', label: 'Health', dir: 1 }],
  education: [{ icon: '🎓', label: 'Education', dir: 1 }],
  transit: [{ icon: '🚗', label: 'Traffic', dir: -1 }],
  parks: [{ icon: '🌳', label: 'Park appeal', dir: 1 }, { icon: '📸', label: 'Tourism', dir: 1 }],
  utilities: [],
  waste: [{ icon: '🗑️', label: 'Garbage', dir: -1 }],
  roads: [{ icon: '🚗', label: 'Road capacity', dir: 1 }, { icon: '🕳️', label: 'Potholes', dir: -1 }],
};
/** VC.econ.forecast() as-is (cached by econ), or {} without econ. */
const forecastRaw = () => U.api('econ', 'forecast', [], null) || {};
/** Ledger-category explanations for the Overview breakdown rows. */
function catTip(cat) {
  if (cat === 'grant') return '<b>State grant</b><br>Young towns get monthly help from the state. It peaks around 1,500 residents and fades out by ~8,000 — grow your tax base before it ends.';
  if (cat === 'policy') return '<b>Policies</b><br>Monthly cost of every active policy at its current level. Adjust levels in the Policies window.';
  if (cat === 'income') return "<b>Venues</b><br>Ticket and casino income. Rises with happiness and the venues' department funding.";
  if (cat === 'tourism') return '<b>Tourism</b><br>Visitors drawn by landmarks, parks and the Tourism Campaign.';
  if (cat === 'loanPayment') return '<b>Loan payments</b><br>Interest + principal of every outstanding loan.';
  if (cat === 'deskDeal') {
    const deals = U.api('econ', 'deskCommitments', [], []) || [];
    const rows = deals.map((d) => `${U.esc(d.label)}: <b>${U.smoney(d.amount)}/mo</b> · ${d.left} mo left`).join('<br>');
    return "<b>Mayor’s Desk commitments</b><br>Recurring deals you agreed to on the Mayor’s Desk." + (rows ? '<br>' + rows : '');
  }
  if (cat.startsWith('upkeep:') && WAGE[cat.slice(7)]) {
    const w = U.num(forecastRaw().wageMul, 1);
    return w > 1.005 ? `<b>Includes city wages ×${w.toFixed(2)}</b><br>Service staff earn more as the city grows.` : null;
  }
  return null;
}

/* ---------------- What-if preview ---------------- */
const LINGER = 2500; // ms the card stays after a slider is released
/**
 * First-month population reaction (fractions of residents), calibrated by branching one save of a
 * stable ~4k town and running a month per change: R tax 9 -> 13/17/20 % lost 7/15/21 % of residents
 * (C/I tax changes: none within the month), police / utilities at 25 % about 13 %, fire 3 %, roads 3 %,
 * education 2 %; tax cuts and better funding draw people in more slowly.
 */
const REACT = {
  taxDown: 0.28, // per unit of worse residential tax effect (VC.econ.taxEffect)
  taxUp: 0.3, // per unit of better tax effect (only where homes have room — kept modest)
  svc: { police: 0.19, fire: 0.05, education: 0.03, parks: 0.01 }, // per unit of lost effectiveness
  up: 0.5, // gains from better funding count half (people move in slower than they leave)
  roads: 0.1, // per unit of road effectiveness below 60 % (potholes)
  power: 0.9, water: 0.7, // per share of demand left unserved
};
/** Estimated change in residents (fraction, first month) between the snapshot b and the current settings. */
function reaction(b) {
  let d = 0;
  const dt = taxEff('R') - b.tax.R;
  d += dt < 0 ? REACT.taxDown * dt : REACT.taxUp * dt;
  for (const k in REACT.svc) {
    if (b.eff[k] == null) continue;
    const de = effAt(k, fundOf(k)) - b.eff[k];
    d += REACT.svc[k] * de * (de > 0 ? REACT.up : 1);
  }
  if (b.eff.roads != null) {
    const pot = (e) => Math.max(0, 0.6 - e);
    const dp = pot(effAt('roads', fundOf('roads'))) - pot(b.eff.roads);
    d -= REACT.roads * dp * (dp < 0 ? REACT.up : 1);
  }
  if (b.eff.utilities != null) {
    const r = utilMul(effAt('utilities', fundOf('utilities'))) / Math.max(0.01, utilMul(b.eff.utilities));
    for (const [s, k] of [[b.power, REACT.power], [b.water, REACT.water]]) {
      if (!s || !(s.demand > 0)) continue;
      const short = (sup) => Math.max(0, 1 - sup / s.demand);
      const du = short(s.supply * r) - short(s.supply);
      d -= k * du * (du < 0 ? REACT.up : 1);
    }
  }
  return M.clamp(d, -0.6, 0.25);
}
/** {est (first-month net), move ($ the reaction adds / costs), pop (fraction)} for the current settings vs b. */
function firstMonth(b, net) {
  const f = forecastRaw(), inc = f.income || {};
  const taxes = U.num(inc['tax:R']) + U.num(inc['tax:C']) + U.num(inc['tax:I']);
  const pop = reaction(b);
  const move = Math.round(taxes * pop);
  return { est: net + move, move, pop };
}
/** "~15 % of residents" */
const popPct = (p) => '~' + Math.max(1, Math.round(Math.abs(p) * 100)) + '% ' + (p < 0 ? 'of residents' : 'more residents');
/** Mood label for a tax effect value (positive = citizens like it). */
function moodOf(e) {
  if (e > 0.12) return ['😄 happy', 'good'];
  if (e > -0.12) return ['🙂 fine', 'info'];
  if (e > -0.45) return ['😠 grumbling', 'warn'];
  return ['🔥 revolt', 'bad'];
}
function snapshot() {
  const f = forecastRaw();
  const s = { net: typeof f.net === 'number' ? f.net : forecast().net, tax: {}, rate: {}, rateW: {}, fund: {}, eff: {}, power: null, water: null };
  for (const z of ZK) {
    s.tax[z] = taxEff(z);
    s.rate[z] = taxAvg(z);
    s.rateW[z] = [taxGet(z, 0), taxGet(z, 1), taxGet(z, 2)];
  }
  for (const d of VC.DEPARTMENTS) {
    s.fund[d.key] = fundOf(d.key);
    s.eff[d.key] = effAt(d.key, s.fund[d.key]);
  }
  const pi = U.api('sim', 'powerInfo', [], null), wi = U.api('sim', 'waterInfo', [], null);
  if (pi && pi.demand > 0) s.power = { supply: U.num(pi.supply), demand: U.num(pi.demand) };
  if (wi && wi.demand > 0) s.water = { supply: U.num(wi.supply), demand: U.num(wi.demand) };
  return s;
}
/**
 * The what-if card of a tab. o.inline: an always-visible, fixed-height panel in the tab's flow at
 * the current position (idle it shows the live readout; while a slider moves, the comparison) —
 * used where the tab is short. Otherwise a floating card inside the window, shown only while
 * comparing, on the half of the window away from the grabbed slider so it never hides it.
 * API: wi.hook(sliderEl, kind, key) (kind 'tax': key 'R' or 'R:1' for a wealth bracket; kind
 * 'dept': key = department), wi.begin(kind, key, el?) / wi.release() around button actions
 * (kind 'all' = every department), wi.update() from the tab updater.
 */
function makeWhatIf(c, o = {}) {
  const inline = !!o.inline;
  const title = h('span', { class: 'pn-wi-title' });
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const l = h('span', { class: 'pn-wi-l' });
    const v = h('span', { class: 'pn-wi-v' });
    const el = h('div', { class: 'pn-wi-row' }, l, v);
    el.set = (label, html) => {
      // inline cards keep their height (the sliders below must not move while one is dragged)
      if (inline) U.css(el, 'visibility', label ? '' : 'hidden');
      else U.show(el, !!label);
      if (!label) return;
      U.txt(l, label);
      U.html(v, html);
    };
    rows.push(el);
  }
  // the net row explains itself: the forecast vs the first-month estimate while comparing
  rows[0].setAttribute('data-tip', 'Monthly net');
  rows[0]._tip = () => (st && st.tip ? st.tip : '<b>Monthly net</b><br>Forecast for next month at the current settings.');
  const card = h('div', { class: 'pn-wi ' + (inline ? 'inline' : 'float'), role: 'status' }, h('div', { class: 'pn-wi-head' }, h('span', { class: 'pn-wi-badge' }, '🔮 What if'), title), ...rows);
  if (inline) c.appendChild(card);
  let st = null; // {kind, key, base, live, until}

  /** Floating card: attach to the window and pick the half away from the grabbed element. */
  function place(el) {
    const win = c.closest('.win');
    if (!win) return;
    if (card.parentNode !== win) {
      for (const old of win.querySelectorAll('.pn-wi.float')) if (old !== card) old.remove();
      win.appendChild(card);
    }
    const wr = win.getBoundingClientRect();
    const sc = win.offsetWidth > 0 ? wr.width / win.offsetWidth : 1;
    let top = false;
    if (el) {
      const r = el.getBoundingClientRect();
      top = (r.top + r.bottom) / 2 > wr.top + wr.height * 0.52;
    }
    if (top) {
      const head = win.querySelector('.tabs-head') || win.querySelector('.win-head');
      const hb = head ? head.getBoundingClientRect().bottom : wr.top + 90 * sc;
      U.css(card, 'top', Math.round((hb - wr.top) / sc + 8) + 'px');
      U.css(card, 'bottom', 'auto');
    } else {
      U.css(card, 'top', 'auto');
      U.css(card, 'bottom', '12px');
    }
    U.cls(card, 'at-top', top);
  }

  function taxRows(b) {
    const parts = st.key.split(':');
    const z = parts[0], w = parts.length > 1 ? +parts[1] : -1;
    const from = w >= 0 ? b.rateW[z][w] : b.rate[z], to = w >= 0 ? taxGet(z, w) : taxAvg(z);
    U.txt(title, `${ZICON[z]} ${ZNAME[z]} tax${w >= 0 ? ' · ' + ['low', 'middle', 'high'][w] + ' wealth' : ''}  ${fmtRate(from)} → ${fmtRate(to)}`);
    // demand: each zone's tax effect feeds its demand (and happiness) directly
    let dem = '', sum = 0;
    for (const zz of ZK) {
      const d = taxEff(zz) - b.tax[zz];
      sum += d;
      dem += span('pn-wi-z z' + zz, zz) + span('pn-wi-ar t-' + toneOf(Math.abs(d) >= 0.01 ? d : 0), arrows(d, 0.01, 0.06, 0.15));
    }
    rows[1].set('Demand', dem);
    const m0 = moodOf(b.tax[z]), m1 = moodOf(taxEff(z));
    const who = z === 'R' ? 'Residents' : 'Businesses';
    rows[2].set('Mood', `${who} ` + (m0[0] === m1[0] ? span('t-' + m1[1], m1[0]) : `${m0[0]} → ${span('t-' + m1[1], m1[0])}`) + ' · approval ' + span('pn-wi-ar t-' + toneOf(Math.abs(sum) >= 0.01 ? sum : 0), arrows(sum / 3, 0.004, 0.04, 0.1)));
    const hi = to > 12, lo = to < 5;
    const fm = st.fm;
    const moves = fm && Math.abs(fm.pop) >= 0.01;
    let warn = '';
    if (moves && fm.pop < 0) warn = span('t-warn', `${popPct(fm.pop)} leave within a month (in the net)`);
    else if (moves) warn = span('t-good', `${popPct(fm.pop)} if homes have room (in the net)`);
    else if (hi) warn = span('t-warn', 'Above 12% growth stalls and citizens start moving out.');
    else if (lo) warn = span('t-info', 'Very low taxes attract growth but thin the coffers.');
    rows[3].set(warn ? 'Heads-up' : '', warn);
  }
  /** Inline idle readout: the city as it stands (what the next drag will be compared with). */
  function idleRows() {
    U.txt(title, 'Drag a slider to preview its effect');
    const f = forecastRaw();
    const net = typeof f.net === 'number' ? f.net : forecast().net;
    rows[0].set('Monthly net', `<b>${U.smoney(net)}</b>/mo <small>forecast</small>`);
    let dem = '';
    for (const zz of ZK) {
      const e = taxEff(zz);
      dem += span('pn-wi-z z' + zz, zz) + span('pn-wi-ar t-' + toneOf(Math.abs(e) >= 0.01 ? e : 0), arrows(e, 0.01, 0.06, 0.15));
    }
    rows[1].set('Tax pull', dem + ' <small>vs. a neutral 9%</small>');
    const S = VC.state;
    const ap = S.stats && typeof S.stats.approval === 'number' ? Math.round(S.stats.approval * 100) + '%' : '—';
    const avg = (taxEff('R') + taxEff('C') + taxEff('I')) / 3, m = moodOf(avg);
    rows[2].set('Mood', `Taxpayers ${span('t-' + m[1], m[0])} · approval <b>${ap}</b>`);
    rows[3].set(wi.warnHigh ? 'Heads-up' : 'Tip', wi.warnHigh ? span('t-warn', '⚠️ Rates above 12% noticeably slow growth and hurt happiness.') : span('t-muted', 'Around 9% is neutral; every point above 12% slows growth noticeably.'));
  }
  function deptRows(b) {
    const all = st.kind === 'all';
    const list = all ? VC.DEPARTMENTS.map((d) => d.key) : [st.key];
    const key = all ? null : st.key;
    let e0 = 0, e1 = 0, f0 = 0, f1 = 0;
    for (const k of list) {
      e0 += b.eff[k];
      e1 += effAt(k, fundOf(k));
      f0 += b.fund[k];
      f1 += fundOf(k);
    }
    const n = list.length || 1;
    e0 /= n; e1 /= n; f0 /= n; f1 /= n;
    const de = e1 - e0;
    if (all) U.txt(title, `🏛️ All departments  ${Math.round(f0 * 100)}% → ${Math.round(f1 * 100)}%`);
    else {
      const d = VC.DEPARTMENTS.find((x) => x.key === key) || { icon: '🏛️', name: key };
      U.txt(title, `${d.icon} ${d.name} funding  ${Math.round(f0 * 100)}% → ${Math.round(f1 * 100)}%`);
    }
    const tn = 'pn-wi-ar t-' + toneOf(Math.abs(de) >= 0.005 ? de : 0);
    rows[1].set('Service', `${Math.round(e0 * 100)}% → <b>${Math.round(e1 * 100)}%</b> effective ` + span(tn, arrows(de, 0.005, 0.08, 0.2)));
    // knock-on effects
    const fx = [];
    if (all) fx.push('city services ' + span(tn, de > 0.004 ? 'improve' : de < -0.004 ? 'weaken' : 'unchanged'));
    else for (const x of DEPT_FX[key] || []) fx.push(`${x.icon} ${x.label} ` + span(tn, arrows(de * x.dir, 0.005, 0.08, 0.2)));
    let supply = '';
    if (all || key === 'utilities') {
      // plant output follows utilities funding: predict supply from the snapshot
      const r = utilMul(effAt('utilities', fundOf('utilities'))) / Math.max(0.01, utilMul(b.eff.utilities));
      const parts = [];
      for (const [nm, s, u, ic] of [['power', b.power, 'MW', '⚡'], ['water', b.water, 'kL', '💧']]) {
        if (!s) continue;
        const now = s.supply * r;
        const short = now < s.demand;
        parts.push(`${ic} ${U.short(Math.round(s.supply))} → ` + span(short ? 't-bad' : 't-good', U.short(Math.round(now)) + ' ' + u) + ` <small>(need ${U.short(Math.round(s.demand))})</small>`);
        if (short && !supply && !(s.supply < s.demand)) supply = span('t-bad', `⚠️ ${nm === 'power' ? 'Brownouts' : 'Dry taps'} — supply would drop below demand.`);
      }
      if (parts.length) fx.push(parts.join(' · '));
      else if (key === 'utilities') fx.push('⚡💧 plant output ' + span(tn, '×' + r.toFixed(2)));
    }
    if (all || WAGE[key]) fx.push('😊 approval ' + span(tn, arrows(de, 0.01, 0.1, 0.25)));
    // residents reacting within the first month (already counted in the monthly net above)
    const fm = st.fm;
    if (fm && Math.abs(fm.pop) >= 0.01) fx.unshift('👥 ' + span(fm.pop < 0 ? 't-bad' : 't-good', popPct(fm.pop) + (fm.pop < 0 ? ' move away' : '')));
    rows[2].set('Likely', fx.join(' · '));
    // warnings
    let warn = supply;
    if (!warn) {
      const lowF = list.some((k) => fundOf(k) < 0.5);
      const sm = U.num(VC.econ && VC.econ.STRIKE_MONTHS, 3);
      if (lowF) warn = span('t-bad', `📢 Below 50% for ${sm} months and workers go on strike.`);
      else if (f1 > 1.1) warn = span('t-info', 'Diminishing returns above 110% — each extra dollar buys less service.');
      else if (key === 'roads' && e1 < 0.6) warn = span('t-warn', '🕳️ Potholes below 60% effectiveness cost happiness.');
    }
    rows[3].set(warn ? 'Heads-up' : '', warn);
  }

  const wi = {
    begin(kind, key, el) {
      if (!(st && st.kind === kind && st.key === key && (st.live || performance.now() < st.until))) st = { kind, key, base: snapshot(), live: true, until: 0 };
      st.live = true;
      if (!inline) place(el);
      wi.update();
    },
    release() {
      if (!st || !st.live) return;
      st.live = false;
      st.until = performance.now() + LINGER;
      setTimeout(() => wi.update(), LINGER + 40);
    },
    hook(sl, kind, key) {
      const inp = sl.input;
      inp.addEventListener('pointerdown', () => {
        wi.begin(kind, key, inp);
        window.addEventListener('pointerup', () => wi.release(), { once: true });
        window.addEventListener('pointercancel', () => wi.release(), { once: true });
      });
      inp.addEventListener('keydown', (e) => {
        if (/^(Arrow|Page|Home|End)/.test(e.key)) wi.begin(kind, key, inp);
      });
      inp.addEventListener('change', () => wi.release());
    },
    update() {
      if (!c.isConnected) {
        // the tab was switched away: a floating card lives on the window, take it down
        st = null;
        if (!inline) card.remove();
        return;
      }
      if (st && !st.live && performance.now() > st.until) st = null;
      U.cls(card, 'on', !!st);
      if (!st) {
        if (inline) idleRows();
        return;
      }
      const b = st.base;
      const f = forecastRaw();
      const net = typeof f.net === 'number' ? f.net : forecast().net;
      // first-month estimate: today's residents' forecast + the residents who leave / arrive meanwhile
      st.fm = firstMonth(b, net);
      const est = st.fm.est, dn = est - b.net;
      const tipNet = `<b>First-month estimate</b><br>Forecast at today's residents: <b>${U.smoney(net)}</b>/mo<br>` + (Math.abs(st.fm.move) >= 1 ? `Residents ${st.fm.pop < 0 ? 'moving away' : 'moving in'} (${popPct(st.fm.pop)}): <b>${U.smoney(st.fm.move)}</b>/mo<br>` : '') + '<small>A rough guide: later months drift further as demand, growth and abandonment follow.</small>';
      rows[0].set('Monthly net', `${U.smoney(b.net)} → <b>${U.smoney(est)}</b> ` + span('pn-wi-d t-' + (dn > 0.5 ? 'good' : dn < -0.5 ? 'bad' : 'muted'), (dn > 0.5 ? '▲ ' : dn < -0.5 ? '▼ ' : '') + U.smoney(dn) + '/mo') + ' <small>first-month est.</small>');
      st.tip = tipNet;
      if (st.kind === 'tax') taxRows(b);
      else deptRows(b);
    },
  };
  return wi;
}

/* ---------------- Overview ---------------- */
function tabOverview(c) {
  const kNet = U.kpi('Monthly net', { icon: '📊', tip: 'Forecast of next month: all recurring income minus all recurring expenses.', cls: 'big' });
  const kBal = U.kpi('Treasury', { icon: '🏦', tip: 'Cash on hand right now.' });
  const kProj = U.kpi('In 12 months', { icon: '🔮', tip: 'Projected treasury if the current monthly net holds for a year.' });
  const spark = U.spark(150, 34);
  kProj.appendChild(spark);
  c.appendChild(h('div', { class: 'pn-kpis cols3' }, kNet, kBal, kProj));

  const incBox = h('div', { class: 'pn-brk-list' });
  const expBox = h('div', { class: 'pn-brk-list' });
  const incTot = h('span', { class: 'pn-brk-total t-good' });
  const expTot = h('span', { class: 'pn-brk-total t-bad' });
  const incEmpty = h('div', { class: 'pn-brk-empty' }, 'No income yet');
  const expEmpty = h('div', { class: 'pn-brk-empty' }, 'No expenses yet');
  const srcNote = h('div', { class: 'note' });
  c.appendChild(
    U.sec('Monthly breakdown', h('div', { class: 'pn-brk' },
      h('div', { class: 'pn-brk-col inc' }, h('div', { class: 'pn-brk-head' }, h('span', null, '💵 Income'), incTot), incBox, incEmpty),
      h('div', { class: 'pn-brk-col exp' }, h('div', { class: 'pn-brk-head' }, h('span', null, '🧾 Expenses'), expTot), expBox, expEmpty)
    ), srcNote)
  );

  // Mayor's Desk commitments (recurring deals; billed with the monthly budget, so already in the net above)
  const dealBody = h('tbody');
  const dealSec = U.sec('📨 Mayor’s Desk commitments',
    h('table', { class: 'pn-table' },
      h('thead', null, h('tr', null, h('th', null, 'Deal'), h('th', { class: 'num' }, 'Per month'), h('th', { class: 'num' }, 'Months left'))),
      dealBody),
    h('div', { class: 'note' }, 'Recurring payments agreed on the Mayor’s Desk — included in the monthly net and the breakdown above.'));
  c.appendChild(dealSec);

  // actuals vs forecast table
  const cells = {};
  const mk = (r, col) => (cells[r + col] = h('td', { class: 'num' }, '—'));
  const tbl = h('table', { class: 'pn-table' },
    h('thead', null, h('tr', null, h('th', null, ''), h('th', { class: 'num' }, 'This month'), h('th', { class: 'num' }, 'Last month'), h('th', { class: 'num' }, 'Forecast'))),
    h('tbody', null, ['Income', 'Expenses', 'Net'].map((r) => h('tr', { class: r === 'Net' ? 'total' : '' }, h('td', null, r), mk(r, 'm'), mk(r, 'l'), mk(r, 'f'))))
  );
  c.appendChild(U.sec('Actuals vs forecast', tbl, h('div', { class: 'note' }, '“This month” is the running total so far and includes one-off spending (construction, zoning, demolition).')));

  function row(isInc) {
    const icon = h('span', { class: 'pn-brk-icon' });
    const lab = h('span', { class: 'pn-brk-label' });
    const amt = h('span', { class: 'pn-brk-amt' });
    const fill = h('i');
    const el = h('div', { class: 'pn-brk-row' }, h('div', { class: 'pn-brk-top' }, icon, lab, amt), h('div', { class: 'pn-brk-bar ' + (isInc ? 'inc' : 'exp') }, fill));
    el.set = (cat, v, tot) => {
      const ci = U.catInfo(cat);
      U.txt(icon, ci[0]);
      U.txt(lab, cat === 'grant' && /^grant$/i.test(ci[1]) ? 'State grant (young towns)' : ci[1]);
      U.attr(el, 'data-tip', catTip(cat));
      U.txt(amt, U.money(v));
      U.css(fill, 'width', (tot > 0 ? (v / tot) * 100 : 0).toFixed(1) + '%');
    };
    return el;
  }
  const byRank = (o) => Object.keys(o).sort((a, b) => U.catRank(a) - U.catRank(b) || (a < b ? -1 : 1));

  return () => {
    const S = VC.state;
    const f = forecast();
    const flat = Math.abs(f.net) < 0.5;
    let netSub = flat ? 'Balanced' : f.net > 0 ? 'Surplus 👍' : 'Deficit — cut costs';
    if (f.net < 0 && !S.sandbox) {
      const run = U.api('econ', 'runway', [], null);
      const r = typeof run === 'number' ? run : S.money > 0 ? S.money / -f.net : 0;
      if (isFinite(r)) netSub = r < 1 ? 'Out of money!' : 'Runway ' + Math.floor(r) + ' month' + (Math.floor(r) === 1 ? '' : 's');
    }
    kNet.set(U.smoney(f.net) + ' /mo', netSub, f.net > 0 ? 'good' : f.net < 0 ? 'bad' : '');
    kBal.set(U.money(S.money), S.sandbox ? 'Sandbox: unlimited funds' : S.money < 0 ? 'In debt!' : S.loans && S.loans.length ? S.loans.length + ' loan' + (S.loans.length > 1 ? 's' : '') + ' outstanding' : 'No debt', S.money < 0 ? 'bad' : '');
    const proj = S.money + f.net * 12;
    kProj.set(U.money(proj), U.smoney(f.net * 12) + ' over the year', proj < 0 ? 'bad' : flat ? '' : proj > S.money ? 'good' : 'warn');
    // sparkline: last 12 months of treasury + 12-month projection
    const past = U.hist('money', 12).map(Number).filter(isFinite);
    past.push(S.money);
    const data = past.slice();
    for (let i = 1; i <= 12; i++) data.push(S.money + f.net * i);
    spark.draw(data, { split: past.length - 1, color: '#5ad1ff', projColor: f.net >= 0 ? '#3ddc84' : '#ff5a6a' });

    const inc = byRank(f.income), exp = byRank(f.expenses);
    U.keyed(incBox, inc, (k) => k, () => row(true), (el, k) => el.set(k, f.income[k], f.totalIncome));
    U.keyed(expBox, exp, (k) => k, () => row(false), (el, k) => el.set(k, f.expenses[k], f.totalExpenses));
    U.show(incEmpty, !inc.length);
    U.show(expEmpty, !exp.length);
    U.txt(incTot, U.money(f.totalIncome));
    U.txt(expTot, U.money(f.totalExpenses));
    const deals = U.api('econ', 'deskCommitments', [], []) || [];
    U.show(dealSec, deals.length > 0);
    U.keyed(dealBody, deals, (d) => d.id, () => h('tr', null, h('td'), h('td', { class: 'num' }), h('td', { class: 'num' })), (tr, d) => {
      U.txt(tr.children[0], d.label);
      U.txt(tr.children[1], U.smoney(d.amount) + '/mo');
      U.tone(tr.children[1], d.amount > 0 ? 'good' : 'bad');
      U.txt(tr.children[2], String(d.left));
    });
    U.txt(srcNote, !inc.length && !exp.length ? 'Nothing on the books yet — zone land and build services to get the economy going.' : f.src === 'forecast' ? 'Forecast for next month at current rates, funding and policies.' : 'Based on last month’s books (no forecast available yet).');

    const cm = ledgerSums(S.ledger && S.ledger.month), cl = ledgerSums(S.ledger && S.ledger.last);
    const set = (r, col, v, signed) => {
      const td = cells[r + col];
      U.txt(td, signed ? U.smoney(v) : U.money(v));
      U.tone(td, signed ? (v > 0.5 ? 'good' : v < -0.5 ? 'bad' : '') : '');
    };
    set('Income', 'm', cm.inc);
    set('Expenses', 'm', cm.exp);
    set('Net', 'm', cm.net, true);
    set('Income', 'l', cl.inc);
    set('Expenses', 'l', cl.exp);
    set('Net', 'l', cl.net, true);
    set('Income', 'f', f.totalIncome);
    set('Expenses', 'f', f.totalExpenses);
    set('Net', 'f', f.net, true);
  };
}

/* ---------------- Taxes ---------------- */
let advOpen = false;
function tabTaxes(c) {
  c.appendChild(h('div', { class: 'note lead' }, 'Taxes are collected monthly from residents and businesses. Low taxes attract growth; high taxes fill the coffers but slow demand and anger citizens. Drag a slider to preview the effect.'));
  const zones = {};
  const hooks = []; // [slider, what-if key]
  const grid = h('div', { class: 'pn-tax-grid' });
  for (const z of ZK) {
    const big = h('div', { class: 'pn-tax-rate' });
    const sl = U.slider({ min: 0, max: 20, step: 1, value: Math.round(taxAvg(z)), color: U.ZHEX[z], format: (v) => v + '%', tip: `Sets all three wealth brackets of <b>${ZNAME[z]}</b> tax at once.`, onInput: (v) => {
      U.api('econ', 'setTax', [z, null, v]);
      P.refresh();
    } });
    hooks.push([sl, z]);
    const revV = h('b');
    const rev = h('div', { class: 'pn-tax-rev', 'data-tip': 'Estimated monthly tax revenue from this zone.' }, '💵 ', revV, h('span', null, ' /mo'));
    rev.set = (t) => U.txt(revV, t);
    const mood = h('div', { class: 'pn-tax-mood' });
    const card = h('div', { class: 'pn-tax-card z' + z }, h('div', { class: 'pn-tax-head' }, h('span', { class: 'pn-tax-icon' }, ZICON[z]), h('span', { class: 'pn-tax-name' }, ZNAME[z]), big), sl, h('div', { class: 'pn-tax-scale' }, h('span', null, '0%'), h('span', null, '10%'), h('span', null, '20%')), rev, mood);
    grid.appendChild(card);
    zones[z] = { big, sl, rev, mood, adv: [] };
  }
  c.appendChild(grid);
  const wi = makeWhatIf(c, { inline: true });

  // advanced: 3 zones × 3 wealth levels
  const advBody = h('div', { class: 'pn-adv-grid' });
  const advBtn = h('button', { class: 'pn-expander', onclick: () => {
    advOpen = !advOpen;
    VC.bus.emit('sfx', { name: 'click' });
    sync();
  } });
  const sync = () => {
    U.cls(advBtn, 'open', advOpen);
    U.txt(advBtn, (advOpen ? '▾' : '▸') + '  Advanced — tax by wealth bracket');
    U.show(advBody, advOpen);
  };
  for (const z of ZK) {
    const col = h('div', { class: 'pn-adv-col' }, h('div', { class: 'pn-adv-title' }, ZICON[z] + ' ' + ZNAME[z]));
    for (let w = 0; w < 3; w++) {
      const sl = U.slider({ label: U.wealth(w) + '  ' + ['Low', 'Middle', 'High'][w], min: 0, max: 20, step: 1, value: Math.round(taxGet(z, w)), color: U.ZHEX[z], format: (v) => v + '%', tip: `${U.WEALTH[w]} ${ZNAME[z].toLowerCase()} tax`, onInput: (v) => {
        U.api('econ', 'setTax', [z, w, v]);
        P.refresh();
      } });
      hooks.push([sl, z + ':' + w]);
      const det = h('div', { class: 'pn-adv-det' });
      col.append(sl, det);
      sl.det = det;
      zones[z].adv.push(sl);
    }
    advBody.appendChild(col);
  }
  c.appendChild(h('div', { class: 'pn-adv' }, advBtn, advBody));
  sync();
  for (const [sl, key] of hooks) wi.hook(sl, 'tax', key);

  return () => {
    const f = forecast();
    let hi = false;
    for (const z of ZK) {
      const o = zones[z];
      const avg = taxAvg(z);
      o.sl.sync(Math.round(avg));
      U.txt(o.big, (Math.round(avg * 10) / 10).toString().replace(/\.0$/, '') + '%');
      U.tone(o.big, avg > 12 ? 'bad' : avg > 10 ? 'warn' : '');
      const r = f.income['tax:' + z];
      o.rev.set(r != null ? U.money(r) : '—');
      const mood = taxMood(z);
      U.txt(o.mood, mood[0]);
      U.tone(o.mood, mood[1]);
      const td = f.taxDetail && f.taxDetail[z], tb = f.taxBase && f.taxBase[z];
      for (let w = 0; w < 3; w++) {
        const v = taxGet(z, w);
        o.adv[w].sync(Math.round(v));
        if (v > 12) hi = true;
        const det = o.adv[w].det;
        U.show(det, !!td);
        if (td) U.txt(det, '≈ ' + U.money(td[w]) + '/mo' + (tb ? ' · ' + U.short(tb[w]) + (z === 'R' ? ' residents' : ' jobs') : ''));
      }
      if (avg > 12) hi = true;
    }
    wi.warnHigh = hi; // the idle what-if readout carries the 'above 12%' warning (no banner to shift the sliders)
    wi.update();
  };
}

/* ---------------- Departments ---------------- */
/** Live tooltip: how a department's monthly cost is made up. */
function costTip(d) {
  const S = VC.state;
  const f = forecastRaw();
  const k = d.key;
  const w = WAGE[k] ? U.num(f.wageMul, 1) : 1;
  const um = U.num(f.upkeepMul, 1);
  let base = U.deptStats().up[k] || 0;
  if (k === 'roads') {
    const rc = U.roadCounts();
    for (let t = 1; t <= 3; t++) base += rc[t] * ((VC.ROADS[t] && VC.ROADS[t].upkeep) || 0);
  }
  const g = [`<span>Base upkeep</span><b>${U.money(base)}</b>`, `<span>× funding</span><b>${Math.round(fundOf(k) * 100)}%</b>`];
  if (w > 1.005) g.push(`<span>× city wages</span><b>×${w.toFixed(2)}</b>`);
  if (Math.abs(um - 1) > 0.005 && !S.sandbox) g.push(`<span>× difficulty</span><b>×${um.toFixed(2)}</b>`);
  g.push(`<span>= per month</span><b>${U.money(deptCost(k))}</b>`);
  return `<div class="tt-head"><span class="tt-icon">${d.icon}</span>${U.esc(d.name)} upkeep</div><div class="tt-grid">${g.join('')}</div>`;
}
function tabDepartments(c) {
  let wi = null;
  const setAll = (f) => {
    if (wi) wi.begin('all', 'all');
    for (const d of VC.DEPARTMENTS) U.api('econ', 'setFunding', [d.key, f]);
    VC.ui.toast(`All departments funded at <b>${Math.round(f * 100)}%</b>`, { type: 'info', icon: '🏛️' });
    if (wi) wi.release();
    P.refresh();
  };
  const total = h('span', { class: 'pn-dept-total' });
  const wage = h('span', { class: 'pn-pill pn-wage', 'data-tip': 'City wages' });
  wage._tip = () => {
    const w = U.num(forecastRaw().wageMul, 1);
    return `<b>👷 City wages ×${w.toFixed(2)}</b><br>Police, fire, health, education, transit, parks and sanitation staff earn more as the city grows (×1 up to ~4,000 residents, ~×1.8 at 25k, ~×2.3 at 100k). Power &amp; water and roads are not affected.<br><small>Each service building also serves a limited number of residents, so big cities need more of them.</small>`;
  };
  c.appendChild(h('div', { class: 'pn-toolbar' },
    h('span', { class: 'pn-toolbar-label' }, 'Presets'),
    VC.ui.button('Austerity', () => setAll(0.8), { icon: '💰', cls: 'small', tip: 'Fund every department at <b>80%</b>. Saves money, services suffer.' }),
    VC.ui.button('Balanced', () => setAll(1), { icon: '⚖️', cls: 'small', tip: 'Fund every department at <b>100%</b>.' }),
    VC.ui.button('Generous', () => setAll(1.2), { icon: '💎', cls: 'small', tip: 'Fund every department at <b>120%</b>. Better services with diminishing returns.' }),
    h('span', { class: 'pn-grow' }),
    wage,
    total
  ));
  const rows = [];
  const list = h('div', { class: 'pn-dept-list' });
  for (const d of VC.DEPARTMENTS) {
    const count = h('div', { class: 'pn-dept-count' });
    const cost = h('div', { class: 'pn-dept-cost' });
    const warn = h('div', { class: 'pn-dept-warn' });
    const sl = U.slider({ label: 'Funding', min: 0, max: 150, step: 5, value: Math.round(((VC.state.budget[d.key] != null ? VC.state.budget[d.key] : 1) * 100) / 5) * 5, format: (v) => v + '%', color: (v) => (v < 50 ? '#ff5a6a' : v < 80 ? '#ffc83d' : v > 110 ? '#b388ff' : '#5ad1ff'), onInput: (v) => {
      U.api('econ', 'setFunding', [d.key, v / 100]);
      P.refresh();
    } });
    U.attr(cost, 'data-tip', d.name);
    cost._tip = () => costTip(d);
    const effFill = h('i');
    const effTxt = h('span', { class: 'pn-dept-eff' });
    const eff = h('div', { class: 'pn-dept-effbar', 'data-tip': 'Service effectiveness at the current funding level (diminishing returns above 100%).' }, effFill);
    const el = h('div', { class: 'pn-dept' },
      h('div', { class: 'pn-dept-id' }, h('span', { class: 'pn-dept-icon' }, d.icon), h('div', { class: 'pn-dept-idt' }, h('div', { class: 'pn-dept-name' }, d.name), count)),
      h('div', { class: 'pn-dept-mid' }, sl, eff),
      h('div', { class: 'pn-dept-right' }, cost, effTxt, warn)
    );
    list.appendChild(el);
    rows.push({ d, el, count, cost, warn, sl, effFill, effTxt });
  }
  c.appendChild(list);
  wi = makeWhatIf(c);
  for (const r of rows) wi.hook(r.sl, 'dept', r.d.key);
  return () => {
    const S = VC.state;
    const st = U.deptStats();
    wi.update();
    const wm = U.num(forecastRaw().wageMul, 1);
    U.txt(wage, '👷 City wages ×' + wm.toFixed(2));
    U.show(wage, wm > 1.005);
    U.tone(wage, wm >= 1.6 ? 'warn' : 'info');
    let sum = 0;
    for (const r of rows) {
      const k = r.d.key;
      const f = S.budget[k] != null ? S.budget[k] : 1;
      r.sl.sync(Math.round((f * 100) / 5) * 5);
      if (k === 'roads') {
        const rc = U.roadCounts();
        const n = rc[1] + rc[2] + rc[3];
        U.txt(r.count, U.int(n) + ' road tile' + (n === 1 ? '' : 's'));
      } else {
        const n = U.num(U.api('econ', 'deptCount', [k], null), st.n[k] || 0);
        U.txt(r.count, n ? n + ' building' + (n === 1 ? '' : 's') : 'No buildings');
      }
      const cost = deptCost(k);
      sum += cost;
      U.txt(r.cost, U.money(cost) + '/mo');
      const e = effectiveness(k);
      U.css(r.effFill, 'width', (M.sat(e / 1.3) * 100).toFixed(1) + '%');
      U.css(r.effFill, 'background', U.rampGood(e));
      U.txt(r.effTxt, '⚙️ ' + Math.round(e * 100) + '% effective');
      U.tone(r.effTxt, e < 0.5 ? 'bad' : e < 0.8 ? 'warn' : '');
      // strikes: econ tracks consecutive months below 50 % funding (strike after STRIKE_MONTHS)
      const strike = !!U.api('econ', 'onStrike', [k], false);
      const lowM = U.num(U.api('econ', 'lowFundingMonths', [k], 0));
      const sm = U.num(VC.econ && VC.econ.STRIKE_MONTHS, 3);
      U.txt(r.warn, strike ? '📢 ON STRIKE!' : lowM > 0 && f < 0.5 ? '⚠️ Strike in ' + Math.max(1, sm - lowM) + ' mo' : '⚠️ Strike risk!');
      U.show(r.warn, strike || f < 0.5);
      U.show(r.effTxt, !strike && f >= 0.5);
      U.cls(r.el, 'low', strike || f < 0.5);
      U.cls(r.el, 'high', f > 1.1);
    }
    U.txt(total, 'Total ' + U.money(sum) + ' /mo');
  };
}

/* ---------------- Loans ---------------- */
function tabLoans(c) {
  const sum = h('div', { class: 'pn-kpis cols3' });
  const kDebt = U.kpi('Total debt', { icon: '🏦' });
  const kPay = U.kpi('Monthly payments', { icon: '📆' });
  const kCash = U.kpi('Credit left', { icon: '💳', tip: 'Remaining credit limit — it grows with your peak population.' });
  sum.append(kDebt, kPay, kCash);
  c.appendChild(sum);
  const offers = h('div', { class: 'pn-loan-offers' });
  const offersEmpty = U.empty('🏦', 'No credit available', 'The bank has nothing to offer right now. Grow your city to improve its credit rating.');
  c.appendChild(U.sec('Available credit', offers, offersEmpty));
  const outs = h('div', { class: 'pn-loan-list' });
  const outsEmpty = U.empty('🕊️', 'Debt free', 'You have no outstanding loans.');
  c.appendChild(U.sec('Outstanding loans', outs, outsEmpty));

  const offerCard = () => {
    const amt = h('div', { class: 'pn-loan-amt' });
    const terms = h('div', { class: 'pn-loan-terms' });
    const pay = h('div', { class: 'pn-loan-pay' });
    const btn = VC.ui.button('Borrow', () => {
      const o = el._o;
      if (o.available === false) return;
      VC.ui.confirm(`Borrow <b>${U.money(o.amount)}</b> at <b>${U.rate(o.rate)}</b> for ${o.months} months?<br>You will pay <b>${U.money(o.monthly)}</b> every month (${U.money(o.total || o.monthly * o.months)} in total).`, () => {
        const ok = U.api('econ', 'takeLoan', [o.amount, o.months], false);
        // a real econ explains refusals itself (toast) and plays the cash sound; only speak up when nobody else will
        if (ok === false) {
          if (!('available' in o)) VC.ui.toast('The bank declined the loan.', { type: 'bad', icon: '🏦', sfx: 'error' });
        } else {
          VC.ui.toast(`Loan of <b>${U.money(o.amount)}</b> received.`, { type: 'good', icon: '🏦' });
        }
        P.refresh();
      }, { title: '🏦 Take a loan', yes: 'Borrow' });
    }, { icon: '🤝', cls: 'small primary' });
    const why = h('div', { class: 'pn-loan-why' });
    const el = h('div', { class: 'pn-loan-offer' }, amt, terms, pay, why, btn);
    el.set = (o) => {
      el._o = o;
      U.txt(amt, U.money(o.amount));
      U.txt(terms, `${U.rate(o.rate)} APR · ${o.months >= 24 && o.months % 12 === 0 ? o.months / 12 + ' years' : o.months + ' months'}`);
      U.txt(pay, U.money(o.monthly) + '/mo' + (o.total ? ' · ' + U.money(o.total) + ' total' : ''));
      const na = o.available === false;
      U.cls(el, 'na', na);
      btn.disabled = na;
      U.txt(why, na ? '🔒 ' + (o.reason || 'Unavailable') : '');
      U.show(why, na);
    };
    return el;
  };
  const loanRow = () => {
    const title = h('div', { class: 'pn-loan-title' });
    const meta = h('div', { class: 'pn-loan-meta' });
    const bar = U.meter('Repaid', { small: true, color: '#3ddc84' });
    const btn = VC.ui.button('Repay', () => {
      const l = el._l;
      VC.ui.confirm(`Pay off the remaining <b>${U.money(l.remaining)}</b> of this loan now?`, () => {
        // loans can be paid off or added while the dialog is open: find THIS loan's index now
        const loans = (VC.state && VC.state.loans) || [];
        const i = loans.indexOf(l);
        if (i < 0) {
          VC.ui.toast('That loan is already paid off.', { type: 'info', icon: '🏦' });
          P.refresh();
          return;
        }
        const ok = U.api('econ', 'repayLoan', [i], false);
        // not enough money: VC.money.spend already raised 'noMoney' (one HUD toast); nothing to add here
        if (ok !== false) VC.ui.toast('Loan repaid. The bank thanks you!', { type: 'good', icon: '🏦' });
        else if (VC.money && VC.money.canAfford && VC.money.canAfford(Math.ceil(U.num(l.remaining)))) VC.ui.toast('The bank could not process this repayment.', { type: 'bad', icon: '🏦', sfx: 'error' });
        P.refresh();
      }, { title: '🏦 Repay loan', yes: 'Repay' });
    }, { icon: '💸', cls: 'small good' });
    const emerg = U.pill('Emergency', 'bad', 'Forced bail-out loan after months of bankruptcy');
    const el = h('div', { class: 'pn-loan-row' }, h('div', { class: 'pn-loan-ic' }, '🏦'), h('div', { class: 'pn-loan-info' }, h('div', { class: 'pn-loan-trow' }, title, emerg), meta, bar), btn);
    el.btn = btn;
    el.set = (l, i) => {
      el._l = l;
      el._i = i;
      const amount = U.num(l.amount), rem = U.num(l.remaining, amount);
      U.txt(title, U.money(rem) + ' remaining');
      U.txt(meta, `${U.money(l.monthly)}/mo · ${U.rate(l.rate)} · ${l.months != null ? l.months + (l.term ? ' of ' + l.term : '') + ' months left · ' : ''}borrowed ${U.money(amount)}`);
      U.show(emerg, !!l.emergency);
      bar.set(amount > 0 ? 1 - rem / amount : 0, amount > 0 ? Math.round((1 - rem / amount) * 100) + '%' : '');
      btn.disabled = !VC.money.canAfford(rem);
      U.txt(btn.lastChild, 'Repay ' + U.short(rem));
    };
    return el;
  };
  return () => {
    const S = VC.state;
    const loans = S.loans || [];
    let debt = 0, pay = 0;
    for (const l of loans) {
      debt += U.num(l.remaining, U.num(l.amount));
      pay += U.num(l.monthly);
    }
    kDebt.set(U.money(debt), loans.length + ' loan' + (loans.length === 1 ? '' : 's'), debt > 0 ? 'warn' : 'good');
    kPay.set(U.money(pay) + ' /mo', pay > 0 ? 'Deducted automatically' : '—');
    const lim = U.api('econ', 'creditLimit', [], null);
    if (typeof lim === 'number') kCash.set(U.money(Math.max(0, lim - debt)), 'of ' + U.money(lim) + ' limit', lim - debt <= 0 ? 'warn' : '');
    else kCash.set(U.money(S.money), 'treasury', S.money < 0 ? 'bad' : '');
    const opts = U.api('econ', 'loanOptions', [], []) || [];
    U.keyed(offers, opts, (o, i) => i + ':' + o.amount + ':' + o.months, offerCard, (el, o) => el.set(o));
    U.show(offers, opts.length);
    U.show(offersEmpty, !opts.length);
    U.keyed(outs, loans.map((l, i) => ({ l, i })), (x) => (x.l.id != null ? 'id' + x.l.id : x.i + ':' + x.l.amount), loanRow, (el, x) => el.set(x.l, x.i));
    U.show(outs, loans.length);
    U.show(outsEmpty, !loans.length);
  };
}

/* ---------------- History ---------------- */
let histRange = 12;
function tabHistory(c) {
  const seg = U.seg([{ value: 12, label: '1 year' }, { value: 60, label: '5 years' }, { value: 0, label: 'All time' }], histRange, (v) => {
    histRange = v;
    draw(true);
  });
  c.appendChild(h('div', { class: 'pn-toolbar' }, h('span', { class: 'pn-toolbar-label' }, 'Range'), seg));
  const W = 540;
  const ch1 = U.chartHover(VC.ui.chart({ width: W, height: 170, series: [], yFormat: U.moneyAxis }));
  const ch2 = U.chartHover(VC.ui.chart({ width: W, height: 110, series: [], yFormat: U.moneyAxis }));
  const box = h('div', null, U.sec('Income vs expenses (monthly)', ch1), U.sec('Treasury', ch2));
  const empty = U.empty('📉', 'Not enough history yet', 'Charts fill in as months pass. Check back after a couple of months.');
  c.append(box, empty);
  let lastSig = '';
  function draw(force) {
    const n = Math.max(U.histLen('income'), U.histLen('money'));
    const sig = U.histSig('income') + '/' + U.histSig('money');
    if (!force && sig === lastSig) return;
    lastSig = sig;
    U.show(box, n >= 2);
    U.show(empty, n < 2);
    if (n < 2) return;
    const inc = U.hist('income', histRange), exp = U.hist('expenses', histRange).map(Math.abs);
    let net = U.hist('net', histRange);
    if (net.length !== inc.length) net = inc.map((v, i) => v - (exp[i] || 0));
    const s1 = [
      { data: inc, color: '#3ddc84', label: 'Income', fill: false },
      { data: exp, color: '#ff5a6a', label: 'Expenses', fill: false },
      { data: net, color: '#5ad1ff', label: 'Net' },
    ];
    const s2 = [{ data: U.hist('money', histRange), color: '#b388ff', label: 'Treasury' }];
    ch1.update(s1);
    ch2.update(s2);
    ch1.setHover(s1, U.money);
    ch2.setHover(s2, U.money);
  }
  return (force) => draw(force);
}

P.defs.budget = {
  title: 'Budget & Taxes',
  icon: '💰',
  width: 580,
  place: 'left',
  build(p) {
    p.body.appendChild(
      U.tabs(p, [
        { key: 'overview', label: 'Overview', icon: '📊', render: tabOverview },
        { key: 'taxes', label: 'Taxes', icon: '🏷️', render: tabTaxes },
        { key: 'departments', label: 'Departments', icon: '🏛️', render: tabDepartments },
        { key: 'loans', label: 'Loans', icon: '🏦', render: tabLoans },
        { key: 'history', label: 'History', icon: '📈', render: tabHistory },
      ])
    );
  },
};
