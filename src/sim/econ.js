/*
 * VOXELPOLIS — economy: taxes, department budgets, policies, loans, monthly finances, history.
 *
 * MONTHLY CYCLE (bus 'month'; the sim emits it after its own monthly work):
 *   1. compute(): taxes per zone & wealth, tourism, special income (casino, stadium), upkeep per
 *      department (x funding x difficulty upkeep multiplier x city wage level), road upkeep, policy
 *      costs, loan payments.
 *   2. book everything through VC.money (upkeep is forced, so money may go negative). Sandbox only
 *      records the ledger and leaves the treasury alone.
 *   3. roll S.ledger.month -> S.ledger.last, set S.stats.income/expenses/net (operating cash flow),
 *      push S.history samples (capped), bankruptcy + low-funding (strike) bookkeeping.
 *
 * DAY-WEIGHTED BILLING (anti-exploit): every sim 'day' the current tax rates, tax modifiers
 * (S.mods.taxR/C/I from policies and temporary modifiers, as the multiplier 1 + mod), department
 * funding levels and active policies are accumulated in S.econ.acc {days, tax, taxMul, fund, pol}.
 * The month bills the AVERAGE tax rate, tax multiplier and funding, and each policy (and a
 * policy-gated venue's income) pro rata to the days it was active — so raising taxes (or dropping a
 * tax break) only on the last day, or cutting funding just before the tick, gains nothing, and a
 * 30-day tax holiday discounts exactly 30 days of taxes whenever it starts. forecast() shows the
 * current settings (a full month at these rates).
 *
 * MAYOR'S DESK COMMITMENTS: recurring payments agreed on the Mayor's Desk (S.desk.recurring
 * [{id, label, amount (+ income / − cost), left (months)}], sim/desk.js) are part of the operating
 * budget: compute() lists them as income.deskDeal / expenses.deskDeal (forecast, budget window,
 * top-bar /mo), monthly() books them (ledger category 'deskDeal') and counts down `left`
 * (VC.econ.billsDesk tells the desk module not to book them itself). deskCommitments() -> the
 * active list for the UI.
 *
 * WAGES: service departments (police, fire, health, education, transit, parks, waste) pay city
 * wages that rise with population (wageMul: 1 at 4k residents, ~1.85 at 25k, ~2.45 at 100k), while
 * service buildings serve a limited number of residents (def.capacity) — big cities need
 * proportionally more of them. Utilities and roads are not affected.
 *
 * AGING: a catalog building older than AGE_FREE (5) years costs AGE_RATE (2%) more upkeep per extra
 * year, up to +AGE_MAX (30%) — the running costs of a mature city keep late-game money meaningful.
 * upkeepOf(building) includes it; ageMul(b) -> the multiplier.
 *
 * BANKRUPTCY: 6 months below -$10k -> one emergency loan (counts toward MAX_LOANS, capped at twice
 * the credit limit). Bankrupt again while it is outstanding -> STATE TAKEOVER (harsher each time, see
 * takeover()): taxes raised to at least 12% (+2 per repeat, max 16), department funding capped at 80%
 * (-10 points per repeat, min 50%), paid and tax-cutting policies repealed, all debt + the deficit restructured into
 * one 10% state loan (the treasury returns to about +$10k), and 12+ months of STATE ADMINISTRATION
 * during which those floors / caps are enforced (setTax / setFunding clamp with a toast, paid or
 * tax-cutting policies and new loans are refused) — receivership() -> {since, until, tax, funding, n} | null. Bus 'econ'
 * {type:'takeover', count, tax, funding, restructured, until} / {type:'receiverEnd', early}.
 *
 * LOANS: a voluntary loan pays a 1% origination fee (ledger 'loanPayment'); paying one off costs the
 * principal plus the interest accrued since its last instalment (at least one month before the
 * first) — payoffCost(i) -> {principal, interest, total}. loanOptions() entries carry `fee`.
 *
 * forecast() evaluates the same model live for the budget window (per-building sums are cached
 * per sim day / building version, the final numbers per frame + settings change), so dragging a
 * slider costs microseconds.
 *
 * POLICY LEVELS: S.policies[key] is a NUMBER level in (0, 1] (absent = off; old saves stored true,
 * migrated to 1 in reset()). VC.POLICY defs with `levels: false` are binary (level 0 or 1); all
 * others are sliders. Effects (computeMods) and the monthly cost (policyCost) scale linearly with
 * the level; billing accumulates the level per day, so a month at 50% is billed half. Readers
 * use isPolicyOn(key) (level > 0), policyLevel(key) (0..1) and setPolicy(key, level|bool). Plain
 * truthiness (`if (S.policies.gambling)`) still works because a level > 0 is truthy.
 * Bus 'policyChanged' {key, level, prev}; the payload's toString() returns the key so listeners
 * written for the old string payload (VC.POLICY[ev], 'pol_' + ev) keep working.
 *
 * TEMPORARY MODIFIERS: S.tempMods = [{id, source, label, icon?, mods:{modKey: additive}, until: day,
 * since}] — Mayor's Desk decisions, goal rewards, …  computeMods() adds every active entry
 * (day < until) on top of the policy modifiers and prunes expired ones; a daily check recomputes
 * S.mods (+ 'budgetChanged') the day one runs out. API: addTempMod({id?, source, label, icon?, mods,
 * until | days}) -> entry | null (same id replaces), removeTempMod(id) -> bool, tempMods() -> active list.
 *
 * Persistent bookkeeping is kept in S.econ (plain JSON, saved with the state).
 * Extra API: upkeepOf(key|building) (actual $/month of one building), wageMul(), taxBilled(),
 * policyEffects(key, level?) -> {modKey: value at that level}, policyCost(key, level?),
 * deskCommitments(). forecast() also carries deskDeals [{id, label, amount, left}].
 */
const M = VC.M, C = VC.C;

/* ---------------- tuning ---------------- */
// $ per month per resident (R) or filled job (C, I) at a 100% tax rate, before the wealth multiplier.
const TAX_K = { R: 5.5, C: 7.0, I: 6.5 };
const WEALTH_MUL = [0.75, 1.0, 1.3];
const TOURISM_K = 6; // $ per tourism point per month
// city wage level for service departments: 1 + WAGE_MAX * (1 - exp(-(pop - WAGE_POP0) / WAGE_SCALE))
const WAGE_MAX = 1.6, WAGE_POP0 = 4000, WAGE_SCALE = 25000;
// AGING: a catalog building's upkeep rises AGE_RATE per year once it is AGE_FREE years old, up to
// +AGE_MAX (old plants, stations and landmarks need renovations) — the running costs of a mature city
const AGE_FREE = 5, AGE_RATE = 0.02, AGE_MAX = 0.3;
const YEAR_DAYS = C.DAYS_PER_MONTH * 12;
/** Upkeep multiplier for a building's age (days). */
function ageMulOf(age) {
  const y = (+age || 0) / YEAR_DAYS - AGE_FREE;
  return y > 0 ? 1 + Math.min(AGE_MAX, y * AGE_RATE) : 1;
}
// state grant for young towns: GRANT_MAX * (pop / GRANT_POP) * exp(1 - pop / GRANT_POP) — peaks at
// GRANT_POP residents, fades out by ~8k (x difficulty grantMul). Bridges the gap between the
// first round of services and the tax base that pays for them.
const GRANT_MAX = 450, GRANT_POP = 1500;
const WAGE_DEPTS = { police: 1, fire: 1, health: 1, education: 1, transit: 1, parks: 1, waste: 1 };
const TAKEOVER_TAX = 12; // % minimum tax rate imposed by a state takeover (+2 per further takeover, max 16)
const TAKEOVER_TAX_MAX = 16;
const TAKEOVER_FUNDING = 0.8; // department funding cap during a takeover (-0.1 per further takeover, min 0.5)
const TAKEOVER_FUNDING_MIN = 0.5;
const RECEIVER_MONTHS = 12; // state administration lasts 12 months per takeover (max 36) or until healthy
const RESTRUCTURE_RATE = 0.1, RESTRUCTURE_CUSHION = 10000; // debt restructuring on a takeover
const LOAN_FEE = 0.01; // origination fee of a voluntary loan (booked as a loan payment)
const HISTORY_CAP = 600;
const HISTORY_KEYS = [
  'pop', 'money', 'happiness', 'income', 'expenses', 'net', 'demandR', 'demandC', 'demandI',
  'crime', 'pollution', 'traffic', 'powerSupply', 'powerDemand', 'waterSupply', 'waterDemand',
  'jobs', 'unemployment', 'tourism', 'approval',
];
const ZONES = ['R', 'C', 'I'];
// Loan tiers: amount, population needed, term in months.
const LOAN_TIERS = [
  { amount: 10000, pop: 0, months: 60 },
  { amount: 25000, pop: 500, months: 60 },
  { amount: 50000, pop: 2500, months: 120 },
  { amount: 100000, pop: 10000, months: 120 },
  { amount: 250000, pop: 40000, months: 120 },
];
const MAX_LOANS = 5;
const BANKRUPT_LIMIT = -10000; // treasury below this for BANKRUPT_MONTHS -> emergency loan
const BANKRUPT_MONTHS = 6;
const STRIKE_FUNDING = 0.5; // funding below this for STRIKE_MONTHS -> department strikes
const STRIKE_MONTHS = 3;
const STRIKE_MUL = 0.7; // effectiveness multiplier while on strike
const TEMP_MAX = 32; // cap on simultaneous temporary modifiers (oldest dropped)

/** Ledger categories that make up the operating budget (shown as monthly income / expenses). */
const OPER_IN = ['tax:R', 'tax:C', 'tax:I', 'tourism', 'income', 'grant', 'deskDeal'];
const OPER_OUT_PREFIX = 'upkeep:';
const OPER_OUT = ['roadUpkeep', 'policy', 'loanPayment', 'deskDeal'];
/** Display names for ledger categories (budget window, charts). */
const CATEGORIES = {
  'tax:R': { name: 'Residential taxes', icon: '🏠' },
  'tax:C': { name: 'Commercial taxes', icon: '🏬' },
  'tax:I': { name: 'Industrial taxes', icon: '🏭' },
  tourism: { name: 'Tourism', icon: '📸' },
  grant: { name: 'State grant (young towns)', icon: '🏛️' },
  refund: { name: 'Undo refunds', icon: '↩️' },
  income: { name: 'Venues (casino, stadium)', icon: '🎟️' },
  reward: { name: 'Milestone rewards', icon: '🏆' },
  goal: { name: 'Goal rewards', icon: '🎯' },
  relief: { name: 'Disaster relief', icon: '🆘' },
  desk: { name: 'Mayor’s Desk', icon: '📨' },
  deskDeal: { name: 'Mayor’s Desk commitments', icon: '📨' },
  loan: { name: 'Loans received', icon: '🏦' },
  roadUpkeep: { name: 'Road maintenance', icon: '🛣️' },
  policy: { name: 'Policies', icon: '📜' },
  loanPayment: { name: 'Loan payments', icon: '💳' },
  loanPayoff: { name: 'Loan payoff', icon: '🏦' },
  construction: { name: 'Construction', icon: '🏗️' },
  roads: { name: 'Road building', icon: '🚧' },
  zoning: { name: 'Zoning', icon: '🗺️' },
  demolish: { name: 'Demolition', icon: '🚜' },
  terraform: { name: 'Terraforming', icon: '⛰️' },
  trees: { name: 'Tree planting', icon: '🌲' },
  pline: { name: 'Power lines', icon: '🔌' },
};
for (const d of VC.DEPARTMENTS) CATEGORIES['upkeep:' + d.key] = { name: d.name, icon: d.icon };

/* ---------------- cached per-building sums ---------------- */
const agg = {
  S: null, ver: -1, day: -1, time: 0,
  base: { R: [0, 0, 0], C: [0, 0, 0], I: [0, 0, 0] }, // Σ residents / filled jobs by wealth
  cap: { R: 0, C: 0, I: 0 },
  upkeep: {}, // dept -> Σ def.upkeep at 100% funding (before cost multiplier)
  count: {}, // dept -> number of catalog buildings
  special: [], // catalog buildings with def.income
  tourism: 0, // Σ def.tourism of built catalog buildings (not needing a policy)
  tourismReq: [], // [{policy, pts}] tourism of venues that only open with a policy (casino)
  roads: [0, 0, 0, 0], // road tiles per VC.ROAD type
  roadsDirty: true,
};
let rev = 0; // bumped on any tax/funding/policy/loan change (invalidates the forecast cache)
let fcCache = null, fcKey = '';

function S_() { return VC.state; }
/** User-facing toast (silent in the title-screen demo city). */
function toast(text, type, icon) {
  const S = S_();
  if (S && S.demo) return;
  VC.bus.emit('toast', { text, type, icon });
}
function funding(dept) {
  const S = S_();
  const f = S && S.budget ? S.budget[dept] : 1;
  return f == null ? 1 : f;
}
/** Difficulty multiplier for recurring costs (upkeep, road maintenance, policies). */
function costMul(S) {
  // Sandbox has costMul 0 but we still want a meaningful ledger / forecast.
  if (S.sandbox) return 1;
  const d = VC.DIFFICULTY[S.difficulty];
  if (d && typeof d.upkeepMul === 'number') return d.upkeepMul;
  return VC.money.costMul();
}
function population(S) {
  if (S.stats.pop > 0) return S.stats.pop;
  // before the sim's first census: count residents directly (scan is cached per day / change)
  const b = scan(S).base.R;
  return b[0] + b[1] + b[2];
}
/** City wage level for service departments (1 in small towns, rising toward 1 + WAGE_MAX). */
function wageMul(S) {
  const p = Math.max(0, population(S) - WAGE_POP0);
  return 1 + WAGE_MAX * (1 - Math.exp(-p / WAGE_SCALE));
}
/** Monthly state grant for young towns ($, see GRANT_MAX). */
function grantOf(S) {
  if (S.sandbox) return 0;
  const p = Math.max(0, population(S)) / GRANT_POP;
  if (!(p > 0)) return 0;
  const d = VC.DIFFICULTY[S.difficulty];
  const mul = d && typeof d.grantMul === 'number' ? d.grantMul : 1;
  const g = GRANT_MAX * mul * p * Math.exp(1 - p);
  return g >= 5 ? g : 0;
}

/* ---------------- policy levels ---------------- */
/** Stored policy value -> level 0..1 (true from old saves = 1; junk = 0). */
function lvlOf(v) {
  if (v === true) return 1;
  const n = +v;
  return n > 0 ? (n < 1 ? n : 1) : 0;
}
/** Requested level (bool / number) -> stored level for a policy def: 1 % steps, binary defs 0 or 1. */
function normLevel(def, v) {
  const n = v === true ? 1 : typeof v === 'number' ? v : +v || 0;
  if (!(n > 0)) return 0;
  if (def && def.levels === false) return 1;
  return Math.round(Math.min(1, n) * 100) / 100;
}
function levelOf(S, key) {
  return S && S.policies ? lvlOf(S.policies[key]) : 0;
}
/** Monthly $ of a policy at 100 % (flat + per capita, × difficulty), unrounded. */
function fullCost(S, key) {
  const def = VC.POLICY[key];
  if (!def) return 0;
  return ((def.cost || 0) + (def.costPerCap || 0) * population(S)) * costMul(S);
}
/** One 'policyChanged' per change: {key, level, prev}; toString() -> key for legacy listeners. */
function emitPolicy(key, level, prev) {
  const ev = { key, level, prev };
  Object.defineProperty(ev, 'toString', { value: () => key });
  VC.bus.emit('policyChanged', ev);
}

/* ---------------- temporary modifiers ---------------- */
function tempList(S) {
  if (!Array.isArray(S.tempMods)) S.tempMods = [];
  return S.tempMods;
}
/** An entry is active until its `until` day (no finite `until` = until removed). */
const tempActive = (t, day) => !!(t && t.mods && typeof t.mods === 'object' && !(day >= t.until));
/** Drops expired / malformed entries in place. Returns true when something was removed. */
function pruneTemp(S) {
  const a = tempList(S), day = S.time.day;
  let j = 0;
  for (let i = 0; i < a.length; i++) if (tempActive(a[i], day)) a[j++] = a[i];
  const removed = j < a.length;
  a.length = j;
  return removed;
}

/** Rescans buildings (at most once per sim day / building change / half second). */
function scan(S, force) {
  const now = performance.now();
  if (!force && agg.S === S && agg.ver === S.ver.bld && agg.day === S.time.day && now - agg.time < 500 && !agg.roadsDirty) return agg;
  agg.S = S; agg.ver = S.ver.bld; agg.day = S.time.day; agg.time = now;
  for (const z of ZONES) { const a = agg.base[z]; a[0] = a[1] = a[2] = 0; agg.cap[z] = 0; }
  for (const d of VC.DEPARTMENTS) { agg.upkeep[d.key] = 0; agg.count[d.key] = 0; }
  agg.special.length = 0;
  agg.tourism = 0;
  agg.tourismReq.length = 0;
  for (const b of S.buildings.values()) {
    if (b.key === 'grow') {
      if (b.abandoned || !(b.built >= 1)) continue;
      const z = VC.ZONES[b.zt];
      if (!z) continue;
      const w = M.clamp(b.wealth | 0, 0, 2);
      agg.base[z.key][w] += b.pop || 0;
      agg.cap[z.key] += b.cap || 0;
      continue;
    }
    const def = VC.BLD[b.key];
    if (!def) continue; // rubble & other non-catalog props
    const dept = def.dept || 'parks';
    agg.upkeep[dept] = (agg.upkeep[dept] || 0) + (def.upkeep || 0) * ageMulOf(b.age);
    agg.count[dept] = (agg.count[dept] || 0) + 1;
    if (def.housing && b.pop) agg.base.R[2] += b.pop; // arcology residents pay high-wealth taxes
    if (b.built >= 1) {
      if (def.income) agg.special.push(b);
      if (def.tourism) {
        if (def.requiresPolicy) agg.tourismReq.push({ policy: def.requiresPolicy, pts: def.tourism });
        else agg.tourism += def.tourism;
      }
    }
  }
  if (agg.roadsDirty) {
    const r = agg.roads, road = S.road;
    r[0] = r[1] = r[2] = r[3] = 0;
    for (let i = 0; i < road.length; i++) if (road[i]) r[road[i]]++;
    agg.roadsDirty = false;
  }
  return agg;
}

/** Tourism points: the sim's figure when available, else Σ landmark tourism × policy modifier. */
function tourismPoints(S, a) {
  if (S.stats.tourism > 0) return S.stats.tourism;
  let pts = a.tourism;
  for (const t of a.tourismReq) pts += t.pts * levelOf(S, t.policy);
  return pts * Math.max(0, 1 + (S.mods.tourism || 0));
}

/** Fresh day-weighted accumulators (see header). */
function newAcc() {
  const fund = {};
  for (const d of VC.DEPARTMENTS) fund[d.key] = 0;
  return { days: 0, tax: { R: [0, 0, 0], C: [0, 0, 0], I: [0, 0, 0] }, taxMul: { R: 0, C: 0, I: 0 }, fund, pol: {} };
}
/** Tax multiplier of a zone from the tax modifiers (policies, desk / goal temp modifiers): 1 + mod, ≥ 0. */
function taxMulNow(S, z) {
  return Math.max(0, 1 + ((S.mods && S.mods['tax' + z]) || 0));
}
/** Active Mayor's Desk commitments (recurring payments with months left). */
function deskDeals(S) {
  const R = S.desk && Array.isArray(S.desk.recurring) ? S.desk.recurring : null;
  if (!R) return [];
  return R.filter((r) => r && r.left > 0 && isFinite(+r.amount) && +r.amount !== 0);
}
/** Adds today's tax rates, funding levels and active policies (bus 'day'). */
function accumulate() {
  const S = S_();
  if (!S || !S.tax || !S.budget) return;
  const e = ensureEcon(S);
  const a = e.acc && e.acc.tax && e.acc.fund && e.acc.pol ? e.acc : (e.acc = newAcc());
  if (!a.taxMul) {
    // month in progress from an older save: assume today's modifiers for the days already counted
    a.taxMul = {};
    for (const z of ZONES) a.taxMul[z] = taxMulNow(S, z) * a.days;
  }
  a.days++;
  for (const z of ZONES) {
    const t = S.tax[z], at = a.tax[z] || (a.tax[z] = [0, 0, 0]);
    if (t) for (let w = 0; w < 3; w++) at[w] += +t[w] || 0;
    a.taxMul[z] = (a.taxMul[z] || 0) + taxMulNow(S, z);
  }
  for (const d of VC.DEPARTMENTS) a.fund[d.key] = (a.fund[d.key] || 0) + funding(d.key);
  // level-days: a month at 60 % bills 60 % of the policy's cost
  for (const k in S.policies) {
    const l = lvlOf(S.policies[k]);
    if (l > 0) a.pol[k] = (a.pol[k] || 0) + l;
  }
}
/** Daily: a temporary modifier ran out -> rebuild S.mods once. */
function tempTick() {
  const S = S_();
  if (!S || !S.tempMods || !S.tempMods.length) return;
  if (!pruneTemp(S)) return;
  VC.econ.computeMods();
  rev++;
  VC.bus.emit('budgetChanged');
}

/**
 * Full monthly model. Returns {income:{cat}, expenses:{cat}, totals, detail}. Values are $ (positive).
 * billing = true: use this month's day-weighted averages (tax rates, funding, policy days) — the
 * figures actually booked by monthly(). Otherwise the current settings (forecast).
 */
function compute(S, force, billing) {
  const a = scan(S, force);
  const mods = S.mods || {};
  const cm = costMul(S);
  const wage = wageMul(S);
  const acc = billing && S.econ && S.econ.acc && S.econ.acc.days > 0 ? S.econ.acc : null;
  const fundOf = (d) => (acc && acc.fund[d] != null ? acc.fund[d] / acc.days : funding(d));
  // average policy level over the billed days (billing) or the current level (forecast)
  const polShare = (k) => (acc ? Math.min(1, (acc.pol[k] || 0) / acc.days) : levelOf(S, k));
  const income = {}, expenses = {};
  const taxDetail = { R: [0, 0, 0], C: [0, 0, 0], I: [0, 0, 0] };
  const taxRates = { R: [0, 0, 0], C: [0, 0, 0], I: [0, 0, 0] };
  for (const z of ZONES) {
    const base = a.base[z];
    // tax modifiers: day-weighted average when billing (older saves without taxMul: today's value)
    const mul = acc && acc.taxMul && acc.taxMul[z] != null ? acc.taxMul[z] / acc.days : Math.max(0, 1 + (mods['tax' + z] || 0));
    const k = TAX_K[z] * mul;
    let sum = 0;
    for (let w = 0; w < 3; w++) {
      const rate = acc && acc.tax[z] ? acc.tax[z][w] / acc.days : S.tax[z][w];
      taxRates[z][w] = Math.round(rate * 100) / 100;
      const v = base[w] * (rate / 100) * WEALTH_MUL[w] * k;
      taxDetail[z][w] = Math.round(v);
      sum += v;
    }
    income['tax:' + z] = Math.round(sum);
  }
  income.tourism = Math.round(tourismPoints(S, a) * TOURISM_K);
  income.grant = Math.round(grantOf(S));
  const happy = M.clamp(S.stats.happiness == null ? 0.6 : S.stats.happiness, 0, 1);
  let special = 0;
  const venues = [];
  for (const b of a.special) {
    const def = VC.BLD[b.key];
    const share = def.requiresPolicy ? polShare(def.requiresPolicy) : 1;
    const open = share > 0;
    const v = open ? def.income * share * (0.75 + 0.5 * happy) * Math.min(1.1, VC.econ.effectiveness(def.dept)) : 0;
    venues.push({ key: b.key, id: b.id, income: Math.round(v), open });
    special += v;
  }
  income.income = Math.round(special);
  // Mayor's Desk commitments (a lottery pays, a union raise costs) — booked monthly like the rest
  let dIn = 0, dOut = 0;
  const deals = [];
  for (const r of deskDeals(S)) {
    const v = Math.round(+r.amount);
    if (v > 0) dIn += v;
    else dOut -= v;
    deals.push({ id: r.id, label: r.label || 'Mayor’s Desk deal', amount: v, left: r.left | 0 });
  }
  if (dIn) income.deskDeal = dIn;

  const dept = {};
  for (const d of VC.DEPARTMENTS) {
    if (d.key === 'roads') continue;
    const v = Math.round((a.upkeep[d.key] || 0) * fundOf(d.key) * cm * (WAGE_DEPTS[d.key] ? wage : 1));
    expenses['upkeep:' + d.key] = v;
    dept[d.key] = v;
  }
  let ru = 0;
  for (let t = 1; t <= 3; t++) ru += a.roads[t] * (VC.ROADS[t] ? VC.ROADS[t].upkeep : 0);
  expenses.roadUpkeep = Math.round((ru + (a.upkeep.roads || 0)) * fundOf('roads') * cm);
  dept.roads = expenses.roadUpkeep;

  const policies = {};
  let pc = 0;
  const polKeys = new Set(Object.keys(S.policies));
  if (acc) for (const k in acc.pol) polKeys.add(k);
  for (const k of polKeys) {
    const share = polShare(k);
    if (!(share > 0) || !VC.POLICY[k]) continue;
    const v = fullCost(S, k) * share; // same rounding as policyCost(key, level)
    policies[k] = Math.round(v);
    pc += v;
  }
  expenses.policy = Math.round(pc);
  let lp = 0;
  for (const l of S.loans) lp += loanDue(l).pay;
  expenses.loanPayment = Math.round(lp);
  if (dOut) expenses.deskDeal = dOut;

  let ti = 0, te = 0;
  for (const k in income) ti += income[k];
  for (const k in expenses) te += expenses[k];
  return {
    income, expenses, totalIncome: ti, totalExpenses: te, net: ti - te,
    taxDetail, taxRates, dept, policies, venues, deskDeals: deals,
    taxBase: { R: a.base.R.slice(), C: a.base.C.slice(), I: a.base.I.slice() },
    roadTiles: a.roads.slice(),
    tourismPoints: Math.round(tourismPoints(S, a)),
    wageMul: Math.round(wage * 100) / 100, upkeepMul: cm, billedDays: acc ? acc.days : 0,
  };
}

/* ---------------- loans ---------------- */
function amortized(amount, rate, months) {
  const r = rate / 12;
  return r > 0 ? (amount * r) / (1 - Math.pow(1 + r, -months)) : amount / months;
}
/** This month's payment for a loan: {pay, interest, principal}. */
function loanDue(l) {
  const interest = l.remaining * (l.rate / 12);
  let pay = Math.min(l.monthly, l.remaining + interest);
  if (l.months <= 1) pay = l.remaining + interest; // final instalment settles rounding
  return { pay, interest, principal: pay - interest };
}
function debt(S) {
  let d = 0;
  for (const l of S.loans) d += l.remaining;
  return d;
}
/**
 * What paying loan l off today costs: the principal plus the interest accrued since its last
 * instalment (pro rata by days) — at least one month's interest while it has not paid one yet.
 */
function payoffOf(S, l) {
  const since = Math.max(0, S.time.day - (isFinite(l.billedDay) ? l.billedDay : l.day || 0));
  const unbilled = !(l.months < l.term);
  const months = Math.max(unbilled ? 1 : 0, since / C.DAYS_PER_MONTH);
  const interest = Math.ceil(l.remaining * (l.rate / 12) * Math.min(1, months));
  const principal = Math.ceil(l.remaining);
  return { principal, interest, total: principal + interest };
}
function creditLimit(S) {
  return 30000 + Math.max(S.peakPop || 0, population(S)) * 6;
}
function riskPremium(S) {
  const e = S.econ || {};
  const inc = Math.max(1000, S.stats.income || 0) * 12;
  let r = M.clamp((debt(S) / inc) * 0.02, 0, 0.02);
  if (S.money < 0) r += 0.01;
  r += Math.min(0.02, (e.bankruptcies || 0) * 0.01);
  return r;
}
function addLoan(S, amount, rate, months, extra) {
  const l = Object.assign({
    id: (S.econ.loanSeq = (S.econ.loanSeq || 0) + 1),
    amount, remaining: amount, rate, months, term: months,
    monthly: Math.round(amortized(amount, rate, months) * 100) / 100,
    day: S.time.day, billedDay: S.time.day,
  }, extra || {});
  S.loans.push(l);
  S.econ.loansTaken = (S.econ.loansTaken || 0) + 1;
  S.econ.hadLoan = true;
  VC.money.earn(amount, 'loan');
  // a voluntary loan costs a 1% origination fee (an operating cost): taking one and paying it back
  // before the first instalment is never free
  if (!l.emergency && !S.sandbox) {
    const fee = Math.round(amount * LOAN_FEE);
    if (fee > 0) { VC.money.spend(fee, 'loanPayment', true); l.fee = fee; }
  }
  rev++;
  VC.bus.emit('loanChanged', l);
  if (!l.emergency && !S.demo) VC.bus.emit('sfx', { name: 'cash' }); // emergency loans: the advisor card is the one cue
  return l;
}

/* ---------------- monthly processing ---------------- */
function book(S, cat, amount) {
  amount = Math.round(amount);
  if (!amount) return;
  if (S.sandbox) {
    // Sandbox: record the ledger only, the treasury is infinite.
    const L = S.ledger.month;
    L[cat] = (L[cat] || 0) + amount;
    return;
  }
  if (amount > 0) VC.money.earn(amount, cat);
  else VC.money.spend(-amount, cat, true);
}

function ensureEcon(S) {
  const e = S.econ || (S.econ = {});
  if (!e.lowFund) e.lowFund = {};
  for (const d of VC.DEPARTMENTS) if (e.lowFund[d.key] == null) e.lowFund[d.key] = 0;
  if (e.bankruptMonths == null) e.bankruptMonths = 0;
  if (e.balancedMonths == null) e.balancedMonths = 0;
  if (e.bankruptcies == null) e.bankruptcies = 0;
  if (e.maxMoney == null) e.maxMoney = S.money;
  if (e.months == null) e.months = 0;
  if (e.loansTaken == null) e.loansTaken = 0;
  if (!S.ledger) S.ledger = { month: {}, last: {} };
  if (!S.ledger.month) S.ledger.month = {};
  if (!S.ledger.last) S.ledger.last = {};
  if (!S.history) S.history = {};
  if (!S.loans) S.loans = [];
  return e;
}

function monthly() {
  const S = S_();
  if (!S) return;
  const e = ensureEcon(S);
  const f = compute(S, true, true);
  e.lastBilled = { taxRates: f.taxRates, days: f.billedDays };
  e.acc = newAcc();

  // income first so a month's taxes can cover its bills
  for (const k in f.income) book(S, k, f.income[k]);
  for (const k in f.expenses) if (k !== 'loanPayment') book(S, k, -f.expenses[k]);

  // loans: pay instalments, retire finished ones
  let paid = 0;
  const done = [];
  for (const l of S.loans) {
    const due = loanDue(l);
    paid += due.pay;
    l.remaining = Math.max(0, l.remaining - due.principal);
    l.months--;
    l.billedDay = S.time.day;
    l.paidInterest = (l.paidInterest || 0) + due.interest;
    if (l.months <= 0 || l.remaining < 0.5) done.push(l);
  }
  book(S, 'loanPayment', -paid);
  // Mayor's Desk commitments were booked with the income / expenses above: count them down
  if (S.desk && Array.isArray(S.desk.recurring) && S.desk.recurring.length) {
    for (const r of S.desk.recurring) if (r && r.left > 0) r.left--;
    S.desk.recurring = S.desk.recurring.filter((r) => r && r.left > 0);
  }
  if (done.length) {
    S.loans = S.loans.filter((l) => done.indexOf(l) < 0);
    if (!S.demo) {
      const sum = done.reduce((s, l) => s + l.amount, 0);
      toast(done.length > 1 ? `${done.length} loans (<b>${VC.fmt.money(sum)}</b>) paid off!` : `Loan of <b>${VC.fmt.money(sum)}</b> paid off!`, 'good', '🏦');
    }
    if (!S.loans.length) e.debtFreeDay = S.time.day;
    rev++;
    VC.bus.emit('loanChanged', null);
  }

  // roll the ledger
  const L = S.ledger.month;
  S.ledger.last = L;
  S.ledger.month = {};
  let inc = 0, exp = 0;
  for (const k of OPER_IN) if (k !== 'deskDeal') inc += L[k] > 0 ? L[k] : 0;
  for (const k in L) if (k !== 'deskDeal' && (k.startsWith(OPER_OUT_PREFIX) || OPER_OUT.indexOf(k) >= 0) && L[k] < 0) exp -= L[k];
  // desk commitments: the ledger nets a lottery against a raise, the stats keep both sides
  inc += f.income.deskDeal || 0;
  exp += f.expenses.deskDeal || 0;
  S.stats.income = inc;
  S.stats.expenses = exp;
  S.stats.net = inc - exp;
  S.stats.taxIncome = (L['tax:R'] || 0) + (L['tax:C'] || 0) + (L['tax:I'] || 0);
  S.stats.tourismIncome = L.tourism || 0;

  // bookkeeping for advisors / achievements
  e.months++;
  e.balancedMonths = S.stats.net >= 0 && (inc > 0 || exp > 0) ? e.balancedMonths + 1 : 0;
  e.maxMoney = Math.max(e.maxMoney || 0, S.money);
  e.maxTourismIncome = Math.max(e.maxTourismIncome || 0, S.stats.tourismIncome);
  for (const d of VC.DEPARTMENTS) {
    const was = e.lowFund[d.key] || 0;
    e.lowFund[d.key] = funding(d.key) < STRIKE_FUNDING ? was + 1 : 0;
    if (e.lowFund[d.key] === STRIKE_MONTHS) {
      // the advisors post the strike card (rule strike_<dept>); toast only when they are missing
      if (!advisorsOn()) toast(`<b>${d.name}</b> workers are on strike over budget cuts!`, 'bad', '📢');
      VC.bus.emit('econ', { type: 'strike', dept: d.key, name: d.name });
      rev++;
    } else if (was >= STRIKE_MONTHS && !e.lowFund[d.key]) {
      toast(`<b>${d.name}</b> strike is over — funding restored.`, 'good', d.icon);
      rev++;
    }
  }

  sampleHistory(S);
  bankruptcyCheck(S, e);
  receiverCheck(S, e);
  VC.bus.emit('budgetChanged');
}

function sampleHistory(S) {
  const st = S.stats, H = S.history;
  const v = {
    pop: st.pop, money: S.money, happiness: st.happiness, income: st.income, expenses: st.expenses, net: st.net,
    demandR: S.demand.R, demandC: S.demand.C, demandI: S.demand.I,
    crime: st.crime, pollution: st.pollution, traffic: st.traffic,
    powerSupply: st.powerSupply, powerDemand: st.powerDemand, waterSupply: st.waterSupply, waterDemand: st.waterDemand,
    jobs: st.jobs, unemployment: st.unemployment, tourism: st.tourism, approval: st.approval,
  };
  for (const k of HISTORY_KEYS) {
    const a = H[k] || (H[k] = []);
    const x = +v[k];
    a.push(isFinite(x) ? Math.round(x * 1000) / 1000 : 0);
    if (a.length > HISTORY_CAP) a.splice(0, a.length - HISTORY_CAP);
  }
}

const advisorsOn = () => !!(VC.advisors && VC.advisors.post);
/** One user-facing message: an advisor card when advisors exist, else a toast. */
function notify(S, card, toastText) {
  if (S.demo) return;
  if (advisorsOn()) {
    try { VC.advisors.post('finance', card); return; } catch (err) { /* fall back to a toast */ }
  }
  toast(toastText, 'bad', '🏦');
}

function bankruptcyCheck(S, e) {
  if (S.sandbox) { e.bankruptMonths = 0; return; }
  e.bankruptMonths = S.money < BANKRUPT_LIMIT ? e.bankruptMonths + 1 : 0;
  const hasEmergency = S.loans.some((l) => l.emergency);
  if (e.emergency && S.money >= 25000) {
    e.emergency = false;
    e.recovered = S.time.day; // "comeback kid"
  }
  if (e.bankruptMonths < BANKRUPT_MONTHS) return;
  e.bankruptMonths = 0;
  e.bankruptcies++;
  if (hasEmergency || S.loans.length >= MAX_LOANS) {
    takeover(S, e);
    return;
  }
  // Emergency bail-out: enough to get back to +$15k, at the worst rate, no credit check —
  // but never more than twice the credit limit, and only one at a time.
  const want = Math.max(25000, Math.ceil((15000 - S.money) / 5000) * 5000);
  const amount = Math.min(want, Math.max(25000, Math.floor((2 * creditLimit(S)) / 5000) * 5000));
  addLoan(S, amount, 0.08, 120, { emergency: true });
  e.emergency = true;
  notify(S, {
    key: 'emergency_loan', severity: 'bad', panel: 'loans',
    title: 'Emergency loan!',
    text: `We've been deep in the red for half a year, so the bank bailed us out with ${VC.fmt.money(amount)} at 8%. Mayor, I'm begging you: raise taxes or cut spending — if we go bankrupt again while this loan is open, the state takes over our budget.`,
  }, `Bankrupt! The Bank of Blocks forced an <b>emergency loan of ${VC.fmt.money(amount)}</b> at 8%.`);
  VC.bus.emit('econ', { type: 'emergencyLoan', amount });
}

/**
 * Second bankruptcy while an emergency loan is still open (or no loan slot left): the state takes
 * over the budget, harder each time (the n-th takeover):
 *  - taxes raised to at least TAKEOVER_TAX + 2 (n - 1) % (max 16), department funding capped at
 *    TAKEOVER_FUNDING - 0.1 (n - 1) (min 50%), paid policies repealed;
 *  - DEBT RESTRUCTURING: every loan plus the deficit (+ a $10k cushion) become one state loan at 10%
 *    over 10 years, so the treasury is back in the black (money never sinks without limit);
 *  - STATE ADMINISTRATION for 12 months per takeover (max 36): the floors / caps stay locked
 *    (setTax / setFunding clamp, paid policies and new loans are refused) until it ends — early once
 *    the city holds $25k and has balanced its budget 6 months running.
 */
function takeover(S, e) {
  const n = (e.takeovers = (e.takeovers || 0) + 1);
  e.takeoverDay = S.time.day;
  const tax = Math.min(TAKEOVER_TAX_MAX, TAKEOVER_TAX + 2 * (n - 1));
  const fund = Math.max(TAKEOVER_FUNDING_MIN, Math.round((TAKEOVER_FUNDING - 0.1 * (n - 1)) * 100) / 100);
  for (const z of ZONES) {
    const t = S.tax[z];
    if (t) for (let w = 0; w < 3; w++) t[w] = Math.max(t[w], tax);
  }
  for (const d of VC.DEPARTMENTS) if (funding(d.key) > fund) S.budget[d.key] = fund;
  const repealed = [];
  for (const k of Object.keys(S.policies)) {
    if (levelOf(S, k) > 0 && (fullCost(S, k) > 0 || cutsTaxes(k))) { delete S.policies[k]; repealed.push(k); }
  }
  // debt restructuring: consolidate every loan + the deficit into one state loan
  let restructured = 0;
  if (S.money < 0) {
    const old = debt(S);
    restructured = Math.ceil((old - S.money + RESTRUCTURE_CUSHION) / 5000) * 5000;
    S.loans = [];
    addLoan(S, restructured, RESTRUCTURE_RATE, 120, { emergency: true, restructure: true });
    if (old > 0) VC.money.spend(Math.ceil(old), 'loanPayoff', true);
    e.emergency = true;
  }
  const months = Math.min(3, n) * RECEIVER_MONTHS;
  e.receiver = { since: S.time.day, until: S.time.day + months * C.DAYS_PER_MONTH, tax, funding: fund, n };
  VC.econ.computeMods();
  rev++;
  const until = dateOf(e.receiver.until);
  notify(S, {
    key: 'takeover', severity: 'bad', panel: 'budget',
    title: n > 1 ? `State takeover #${n}!` : 'State takeover!',
    text: `Bankrupt again with the emergency loan still open — the state has taken over our budget until ${until}: taxes at least ${tax}%, department funding at most ${Math.round(fund * 100)}%` +
      (repealed.length ? ', costly policies and tax breaks repealed' : '') +
      (restructured ? `, and all our debt rolled into one ${VC.fmt.money(restructured)} state loan at ${Math.round(RESTRUCTURE_RATE * 100)}%` : '') +
      '. Balance the books for six months (with $25k in the bank) and they hand it back' + (n > 1 ? ' — every takeover is harsher than the last.' : '.'),
  }, `Bankrupt again! State administration until ${until}: taxes ≥ ${tax}%, funding ≤ ${Math.round(fund * 100)}%.`);
  VC.bus.emit('econ', { type: 'takeover', repealed, tax, funding: fund, count: n, restructured, until: e.receiver.until });
  VC.bus.emit('budgetChanged'); // (no 'policyChanged': it would add a second sound to this one event)
}
/** True for a policy that lowers a tax (e.g. Business Tax Breaks): it would undercut the takeover's tax floor. */
function cutsTaxes(key) {
  const fx = (VC.POLICY[key] && VC.POLICY[key].effects) || {};
  return fx.taxR < 0 || fx.taxC < 0 || fx.taxI < 0;
}
/** Active state administration {since, until, tax, funding, n} or null. */
function receiver(S) {
  const r = S && !S.sandbox && S.econ && S.econ.receiver;
  return r && S.time.day < r.until ? r : null;
}
/** Monthly: the state hands the budget back when its time is up, or early once the city is healthy. */
function receiverCheck(S, e) {
  const r = e.receiver;
  if (!r) return;
  const healthy = S.money >= 25000 && e.balancedMonths >= 6;
  if (S.time.day < r.until && !healthy) return;
  e.receiver = null;
  rev++;
  if (!S.demo) toast('The state administrator hands the budget back. Taxes, funding and policies are yours again, Mayor.', 'good', '🏛️');
  VC.bus.emit('econ', { type: 'receiverEnd', early: healthy && S.time.day < r.until });
}
/** "Mar 2031" for a day index. */
function dateOf(day) {
  const m = Math.floor(day / C.DAYS_PER_MONTH) % 12;
  const y = C.START_YEAR + Math.floor(day / (C.DAYS_PER_MONTH * 12));
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m] + ' ' + y;
}
let lastRefusal = -1e9;
/** One toast (at most every 4 s real time) when the state administrator overrides a setting. */
function refuse(S, text) {
  const t = performance.now();
  if (S.demo || t - lastRefusal < 4000) return;
  lastRefusal = t;
  toast(text + ` <small>(state administration until ${dateOf(S.econ.receiver.until)})</small>`, 'warn', '🏛️');
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */
VC.econ = {
  TAX_K, WEALTH_MUL, TOURISM_K, CATEGORIES, HISTORY_KEYS, LOAN_TIERS,
  WEALTH_NAMES: ['Low', 'Mid', 'High'],
  STRIKE_FUNDING, STRIKE_MONTHS, STRIKE_MUL,
  WAGE_DEPTS, // departments that pay city wages (wageMul)
  billsDesk: true, // monthly() books S.desk.recurring (ledger 'deskDeal'); sim/desk.js leaves them alone

  init() {
    VC.bus.on('month', () => {
      try { monthly(); } catch (err) { console.error('[econ] monthly failed', err); VC.errors && VC.errors.push('econ: ' + err.message); }
    });
    VC.bus.on('day', () => {
      try { accumulate(); tempTick(); } catch (err) { console.error('[econ] day failed', err); }
    });
    VC.bus.on('roadChange', () => { agg.roadsDirty = true; });
    VC.bus.on('policyChanged', () => { rev++; });
  },

  reset(S) {
    agg.S = null;
    agg.roadsDirty = true;
    fcCache = null;
    rev++;
    const e = ensureEcon(S);
    if (!e.acc || !e.acc.tax || !e.acc.fund || !e.acc.pol || !(e.acc.days >= 0)) e.acc = newAcc();
    for (const d of VC.DEPARTMENTS) if (S.budget[d.key] == null) S.budget[d.key] = 1;
    for (const z of ZONES) if (!S.tax[z]) S.tax[z] = [9, 9, 9];
    // policies: drop ones that no longer exist, migrate old boolean saves (true -> level 1),
    // normalize levels (binary policies 0/1); then temp modifiers; then rebuild S.mods
    if (!S.policies || typeof S.policies !== 'object' || Array.isArray(S.policies)) S.policies = {};
    for (const k of Object.keys(S.policies)) {
      const def = VC.POLICY[k];
      const l = def ? normLevel(def, lvlOf(S.policies[k])) : 0;
      if (l > 0) S.policies[k] = l;
      else delete S.policies[k];
    }
    const tm = tempList(S);
    for (let i = tm.length - 1; i >= 0; i--) {
      const t = tm[i];
      if (!t || typeof t !== 'object' || !t.mods || typeof t.mods !== 'object') tm.splice(i, 1);
      else if (t.id == null) t.id = 'tm' + (e.tempSeq = (e.tempSeq || 0) + 1);
    }
    VC.econ.computeMods();
    if (!S.history.pop || !S.history.pop.length) sampleHistory(S); // first point so charts aren't empty
  },

  update() {},

  /* ---------------- taxes ---------------- */
  /** Sets a tax rate (0..20 %). wealth null = all three wealth levels; zone null = every zone. */
  setTax(zone, wealth, pct) {
    const S = S_();
    if (!S) return;
    pct = Math.round(M.clamp(+pct || 0, 0, 20) * 10) / 10;
    const r = receiver(S);
    if (r && pct < r.tax) { pct = r.tax; refuse(S, `The state administrator keeps taxes at <b>${r.tax}%</b> or more.`); }
    for (const z of zone == null ? ZONES : [zone]) {
      const t = S.tax[z];
      if (!t) continue;
      if (wealth == null) t.fill(pct);
      else t[M.clamp(wealth | 0, 0, 2)] = pct;
    }
    rev++;
    VC.bus.emit('budgetChanged');
  },
  /** Tax rate in %. wealth null = average of the three levels. */
  getTax(zone, wealth = 1) {
    const S = S_();
    const t = S && S.tax[zone];
    if (!t) return 0;
    if (wealth == null) return (t[0] + t[1] + t[2]) / 3;
    return t[M.clamp(wealth | 0, 0, 2)];
  },
  /**
   * Demand / happiness effect of taxes: +0.35 at 0%, 0 at 9%, -0.14 at 12%, -0.4 at 15%, -1 at 20%
   * (gentle for a small raise, steep beyond ~13%).
   * Uses the effective rate (policy tax modifiers). wealth null = average of the three levels.
   */
  taxEffect(zone, wealth) {
    const S = S_();
    if (!S || !S.tax[zone]) return 0;
    let r = VC.econ.getTax(zone, wealth == null ? null : wealth);
    r *= Math.max(0, 1 + ((S.mods && S.mods['tax' + zone]) || 0));
    if (r <= 9) return 0.35 * ((9 - r) / 9);
    return M.clamp(-Math.pow((r - 9) / 11, 1.5), -1, 0);
  },

  /* ---------------- budget ---------------- */
  /** Department funding 0..1.5 (1 = 100%). dept null = every department. */
  setFunding(dept, f) {
    const S = S_();
    if (!S) return;
    f = Math.round(M.clamp(+f || 0, 0, 1.5) * 100) / 100;
    const r = receiver(S);
    if (r && f > r.funding) { f = r.funding; refuse(S, `The state administrator caps department funding at <b>${Math.round(r.funding * 100)}%</b>.`); }
    for (const d of dept == null ? VC.DEPARTMENTS.map((x) => x.key) : [dept]) S.budget[d] = f;
    rev++;
    VC.bus.emit('budgetChanged');
  },
  getFunding: funding,
  /** Service effectiveness for a funding level: f^0.8 below 100%, diminishing returns above (max ~1.31). */
  effectivenessAt(f) {
    if (!(f > 0)) return 0;
    if (f <= 1) return Math.pow(f, 0.8);
    return 1 + 0.4 * (1 - Math.exp(-(f - 1) * 3));
  },
  /** Current effectiveness of a department (0..~1.3), including strike penalties. */
  effectiveness(dept) {
    const S = S_();
    if (!S) return 1;
    let e = VC.econ.effectivenessAt(funding(dept));
    const lf = S.econ && S.econ.lowFund;
    if (lf && lf[dept] >= STRIKE_MONTHS) e *= STRIKE_MUL;
    return e;
  },
  /** Months in a row a department has been funded below 50% (strike at 3). */
  lowFundingMonths(dept) {
    const S = S_();
    return (S && S.econ && S.econ.lowFund && S.econ.lowFund[dept]) || 0;
  },
  onStrike(dept) {
    return VC.econ.lowFundingMonths(dept) >= STRIKE_MONTHS;
  },
  /** Monthly upkeep of a department at its current funding ('roads' = road maintenance). */
  deptUpkeep(dept) {
    const f = VC.econ.forecast();
    return dept === 'roads' ? f.expenses.roadUpkeep || 0 : f.expenses['upkeep:' + dept] || 0;
  },
  /** Number of catalog buildings in a department. */
  deptCount(dept) {
    const S = S_();
    if (!S) return 0;
    return scan(S).count[dept] || 0;
  },

  /* ---------------- policies ---------------- */
  /**
   * Sets a policy's level: true / 1 = full, false / 0 = repeal, a number in (0,1) = partial (binary
   * `levels:false` policies round any level > 0 up to 1). Raising the level needs the policy
   * unlocked and one month's cost at the new level in the bank (VC.money.spend raises the single
   * 'noMoney' notification); lowering / repealing always works. Returns true on success (or when
   * already at that level). Emits 'policyChanged' {key, level, prev} once per actual change.
   */
  setPolicy(key, level) {
    const S = S_();
    const def = VC.POLICY[key];
    if (!S || !def) return false;
    const want = normLevel(def, level);
    const cur = levelOf(S, key);
    if (want === cur) {
      if (want > 0 && S.policies[key] !== want) S.policies[key] = want; // legacy `true` -> number, silently
      return true;
    }
    if (want > cur) {
      if (!VC.world.isUnlocked(key)) {
        toast(`${def.name} unlocks at ${VC.fmt.num(def.unlock)} citizens.`, 'warn', '🔒');
        return false;
      }
      if (receiver(S) && (fullCost(S, key) > 0 || cutsTaxes(key))) {
        refuse(S, `The state administrator approves no paid policies or tax breaks.`);
        return false;
      }
      const cost = Math.round(fullCost(S, key) * want);
      if (!S.sandbox && cost > 0 && !VC.money.canAfford(cost)) {
        // need at least one month's cost (at the new level) in the bank. VC.money.spend owns the
        // one 'noMoney' notification: it fails here (unaffordable, not forced) and charges nothing.
        VC.money.spend(cost, 'policy');
        return false;
      }
    }
    if (want > 0) S.policies[key] = want;
    else delete S.policies[key];
    VC.econ.computeMods();
    rev++;
    emitPolicy(key, want, cur);
    return true;
  },
  /** True when the policy is active at any level. */
  isPolicyOn(key) {
    return levelOf(S_(), key) > 0;
  },
  /** Current level of a policy, 0 (off) .. 1 (full). */
  policyLevel(key) {
    return levelOf(S_(), key);
  },
  /** True for policies with an intensity slider (false for binary `levels:false` ones). */
  policyHasLevels(key) {
    const def = VC.POLICY[key];
    return !!def && def.levels !== false;
  },
  /**
   * Monthly $ cost of a policy at the current population (flat + per capita, × difficulty) at
   * `level` (0..1). level omitted: the policy's current level, or 100 % when it is off.
   */
  policyCost(key, level) {
    const S = S_();
    const def = VC.POLICY[key];
    if (!S || !def) return 0;
    const l = level == null ? levelOf(S, key) || 1 : normLevel(def, level);
    return Math.round(fullCost(S, key) * l);
  },
  /** Modifier effects of a policy at `level` (omitted: current level, or 100 % when off): {modKey: value}. */
  policyEffects(key, level) {
    const S = S_();
    const def = VC.POLICY[key];
    const out = {};
    if (!def) return out;
    const l = level == null ? levelOf(S, key) || 1 : normLevel(def, level);
    for (const e in def.effects || {}) out[e] = Math.round(def.effects[e] * l * 1000) / 1000;
    return out;
  },
  /** Recomputes S.mods: Σ policy effects × level + Σ active temporary modifiers (additive, clamped). */
  computeMods() {
    const S = S_();
    if (!S) return;
    const m = S.mods || (S.mods = {});
    for (const k in m) m[k] = 0; // also clears keys only an expired temp modifier used
    for (const k of VC.MODS) m[k] = 0;
    for (const k in S.policies) {
      const def = VC.POLICY[k];
      const l = lvlOf(S.policies[k]);
      if (!def || !(l > 0)) continue;
      for (const e in def.effects) m[e] = (m[e] || 0) + def.effects[e] * l;
    }
    if (S.time) pruneTemp(S);
    for (const t of tempList(S)) {
      for (const e in t.mods) {
        const v = +t.mods[e];
        if (isFinite(v)) m[e] = (m[e] || 0) + v;
      }
    }
    for (const k in m) m[k] = Math.round(M.clamp(m[k], -0.95, 2) * 1000) / 1000;
    return m;
  },

  /* ---------------- temporary modifiers ---------------- */
  /**
   * Adds (or replaces, same id) a temporary modifier: {id?, source, label, icon?, mods:{modKey: v},
   * until (day index) | days}. Returns the stored entry, or null when it has no effect / is already over.
   */
  addTempMod(entry) {
    const S = S_();
    if (!S || !entry || typeof entry !== 'object') return null;
    const e = ensureEcon(S);
    const mods = {};
    let any = false;
    for (const k in entry.mods || {}) {
      const v = +entry.mods[k];
      if (isFinite(v) && v !== 0) { mods[k] = Math.round(v * 1000) / 1000; any = true; }
    }
    const day = S.time.day;
    let until = +entry.until;
    if (!isFinite(until)) until = +entry.days > 0 ? day + Math.round(+entry.days) : NaN;
    if (!any || !(until > day)) return null;
    const t = {
      id: entry.id != null ? String(entry.id) : 'tm' + (e.tempSeq = (e.tempSeq || 0) + 1),
      source: String(entry.source || ''), label: String(entry.label || ''),
      mods, until: Math.round(until), since: day,
    };
    if (entry.icon) t.icon = String(entry.icon);
    const a = tempList(S);
    const i = a.findIndex((x) => x && x.id === t.id);
    if (i >= 0) a[i] = t;
    else a.push(t);
    if (a.length > TEMP_MAX) a.splice(0, a.length - TEMP_MAX);
    VC.econ.computeMods();
    rev++;
    VC.bus.emit('budgetChanged');
    return t;
  },
  /** Removes a temporary modifier by id. Returns true when one was removed. */
  removeTempMod(id) {
    const S = S_();
    if (!S || !Array.isArray(S.tempMods)) return false;
    const a = S.tempMods;
    const i = a.findIndex((x) => x && x.id === String(id));
    if (i < 0) return false;
    a.splice(i, 1);
    VC.econ.computeMods();
    rev++;
    VC.bus.emit('budgetChanged');
    return true;
  },
  /** Active temporary modifiers (a new array; entries are the stored objects — do not mutate). */
  tempMods() {
    const S = S_();
    if (!S || !Array.isArray(S.tempMods)) return [];
    const day = S.time.day;
    return S.tempMods.filter((t) => tempActive(t, day));
  },

  /* ---------------- loans ---------------- */
  /** Loan offers for the current city: [{amount, rate, months, monthly, total, available, reason}]. */
  loanOptions() {
    const S = S_();
    if (!S) return [];
    const pop = Math.max(S.peakPop || 0, population(S));
    const d = debt(S), lim = creditLimit(S), risk = riskPremium(S);
    return LOAN_TIERS.map((t) => {
      const rate = Math.round(M.clamp((t.months > 60 ? 0.045 : 0.035) + risk, 0.03, 0.08) * 400) / 400;
      const monthly = Math.round(amortized(t.amount, rate, t.months));
      let reason = '';
      if (!S.sandbox && pop < t.pop) reason = `Requires ${VC.fmt.num(t.pop)} citizens`;
      else if (receiver(S)) reason = 'The state administrator signs no new loans';
      else if (S.loans.length >= MAX_LOANS) reason = `At most ${MAX_LOANS} loans at once`;
      else if (!S.sandbox && d + t.amount > lim) reason = `Exceeds credit limit (${VC.fmt.money(lim)})`;
      const fee = S.sandbox ? 0 : Math.round(t.amount * LOAN_FEE);
      return { amount: t.amount, rate, months: t.months, monthly, total: monthly * t.months, fee, available: !reason, reason };
    });
  },
  /** Takes a loan (amount from loanOptions, or an option object). Returns the loan or false. */
  takeLoan(amount, months) {
    const S = S_();
    if (!S) return false;
    if (amount && typeof amount === 'object') { months = amount.months; amount = amount.amount; }
    const opt = VC.econ.loanOptions().find((o) => o.amount === amount && (!months || o.months === months));
    if (!opt) return false;
    if (!opt.available) {
      toast('Loan denied: ' + opt.reason + '.', 'warn', '🏦');
      return false;
    }
    // (opt.fee: the 1% origination fee is booked by addLoan)
    return addLoan(S, opt.amount, opt.rate, opt.months);
  },
  /** Pays off loan i (index into S.loans) in full if affordable. */
  repayLoan(i) {
    const S = S_();
    const l = S && S.loans[i];
    if (!l) return false;
    const p = payoffOf(S, l);
    if (!S.sandbox && !VC.money.canAfford(p.total)) { VC.money.spend(p.total, 'loanPayoff'); return false; } // the one 'noMoney'
    VC.money.spend(p.principal, 'loanPayoff', true); // capital, not operating cost
    if (p.interest > 0) VC.money.spend(p.interest, 'loanPayment', true); // accrued interest: operating cost
    l.paidInterest = (l.paidInterest || 0) + p.interest;
    S.loans.splice(i, 1);
    if (!S.loans.length) S.econ.debtFreeDay = S.time.day;
    rev++;
    VC.bus.emit('loanChanged', null);
    VC.bus.emit('sfx', { name: 'cash' });
    return true;
  },
  /** What repaying loan i today costs: {principal, interest (accrued, >= 1 month before the first instalment), total}. */
  payoffCost(i) {
    const S = S_();
    const l = S && S.loans[i];
    return l ? payoffOf(S, l) : null;
  },
  /** State administration after a takeover: {since, until (day), tax (min %), funding (max), n} or null. */
  receivership() {
    const r = receiver(S_());
    return r ? Object.assign({}, r) : null;
  },
  /** Total outstanding principal. */
  debt() {
    const S = S_();
    return S ? debt(S) : 0;
  },
  creditLimit() {
    const S = S_();
    return S ? creditLimit(S) : 0;
  },

  /* ---------------- forecast ---------------- */
  /**
   * Live estimate of next month: {income:{cat:$}, expenses:{cat:$}, totalIncome, totalExpenses, net,
   * taxDetail {R:[low,mid,high $]…}, taxBase, dept {dept:$}, policies {key:$}, venues, roadTiles, tourismPoints}.
   * Cached per frame and per settings change — call freely.
   */
  forecast() {
    const S = S_();
    if (!S) return { income: {}, expenses: {}, totalIncome: 0, totalExpenses: 0, net: 0, taxDetail: {}, dept: {}, policies: {} };
    const key = (VC.gfx && VC.gfx.frameCount) + ':' + rev + ':' + S.ver.bld + ':' + S.time.day + ':' + S.loans.length;
    if (fcCache && fcKey === key && agg.S === S) return fcCache;
    fcKey = key;
    fcCache = compute(S, false);
    return fcCache;
  },
  /** Months until the treasury runs dry at the forecast rate (Infinity if profitable). */
  runway() {
    const S = S_();
    if (!S) return Infinity;
    const n = VC.econ.forecast().net;
    if (n >= 0) return Infinity;
    return Math.max(0, S.money / -n);
  },
  /** Active Mayor's Desk commitments: [{id, label, amount ($/month, + income / − cost), left (months)}]. */
  deskCommitments() {
    const S = S_();
    return S ? deskDeals(S).map((r) => ({ id: r.id, label: r.label || 'Mayor’s Desk deal', amount: Math.round(+r.amount), left: r.left | 0 })) : [];
  },
  /** Display name/icon for a ledger category. */
  category(cat) {
    return CATEGORIES[cat] || { name: cat, icon: '•' };
  },
  /** Current city wage level for service departments (1 = small town). */
  wageMul() {
    const S = S_();
    return S ? wageMul(S) : 1;
  },
  /**
   * Actual monthly upkeep ($) of ONE building (catalog key or building) at the current funding,
   * difficulty and city wage level — what the budget really pays for it. Tooltips should show this
   * instead of def.upkeep.
   */
  upkeepOf(keyOrB) {
    const S = S_();
    const b = keyOrB && typeof keyOrB === 'object' ? keyOrB : null;
    const key = b ? b.key : keyOrB;
    const def = VC.BLD[key];
    if (!S || !def || !def.upkeep) return 0;
    const dept = def.dept || 'parks';
    return Math.round(def.upkeep * (b ? ageMulOf(b.age) : 1) * funding(dept) * costMul(S) * (WAGE_DEPTS[dept] ? wageMul(S) : 1));
  },
  /** Upkeep multiplier from a building's age (1 while young, up to 1 + AGE_MAX): see AGING in the header. */
  ageMul(b) {
    return ageMulOf(b && typeof b === 'object' ? b.age : b);
  },
  /** Tax rates (%) actually billed last month (day-weighted averages): {taxRates:{R:[..]…}, days}. */
  taxBilled() {
    const S = S_();
    return (S && S.econ && S.econ.lastBilled) || null;
  },
};
