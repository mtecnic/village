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
 * DAY-WEIGHTED BILLING (anti-exploit): every sim 'day' the current tax rates, department funding
 * levels and active policies are accumulated in S.econ.acc {days, tax, fund, pol}. The month bills
 * the AVERAGE tax rate and funding, and each policy (and a policy-gated venue's income) pro rata to
 * the days it was active — so raising taxes only on the last day, or cutting funding just before
 * the tick, gains nothing. forecast() shows the current settings (a full month at these rates).
 *
 * WAGES: service departments (police, fire, health, education, transit, parks, waste) pay city
 * wages that rise with population (wageMul: 1 at 4k residents, ~1.8 at 25k, ~2.3 at 100k), while
 * service buildings serve a limited number of residents (def.capacity) — big cities need
 * proportionally more of them. Utilities and roads are not affected.
 *
 * BANKRUPTCY: 6 months below -$10k -> one emergency loan (counts toward MAX_LOANS, capped at twice
 * the credit limit). Bankrupt again while it is outstanding -> STATE TAKEOVER: taxes raised to at
 * least 12%, department funding capped at 80%, paid policies repealed; bus 'econ' {type:'takeover'}.
 *
 * forecast() evaluates the same model live for the budget window (per-building sums are cached
 * per sim day / building version, the final numbers per frame + settings change), so dragging a
 * slider costs microseconds.
 *
 * Persistent bookkeeping is kept in S.econ (plain JSON, saved with the state).
 * Extra API: upkeepOf(key|building) (actual $/month of one building), wageMul(), taxBilled().
 */
const M = VC.M, C = VC.C;

/* ---------------- tuning ---------------- */
// $ per month per resident (R) or filled job (C, I) at a 100% tax rate, before the wealth multiplier.
const TAX_K = { R: 5.5, C: 7.0, I: 6.5 };
const WEALTH_MUL = [0.75, 1.0, 1.3];
const TOURISM_K = 6; // $ per tourism point per month
// city wage level for service departments: 1 + WAGE_MAX * (1 - exp(-(pop - WAGE_POP0) / WAGE_SCALE))
const WAGE_MAX = 1.35, WAGE_POP0 = 4000, WAGE_SCALE = 25000;
// state grant for young towns: GRANT_MAX * (pop / GRANT_POP) * exp(1 - pop / GRANT_POP) — peaks at
// GRANT_POP residents, fades out by ~8k (x difficulty grantMul). Bridges the gap between the
// first round of services and the tax base that pays for them.
const GRANT_MAX = 450, GRANT_POP = 1500;
const WAGE_DEPTS = { police: 1, fire: 1, health: 1, education: 1, transit: 1, parks: 1, waste: 1 };
const TAKEOVER_TAX = 12; // % minimum tax rate imposed by a state takeover
const TAKEOVER_FUNDING = 0.8; // department funding cap during a takeover
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

/** Ledger categories that make up the operating budget (shown as monthly income / expenses). */
const OPER_IN = ['tax:R', 'tax:C', 'tax:I', 'tourism', 'income', 'grant'];
const OPER_OUT_PREFIX = 'upkeep:';
const OPER_OUT = ['roadUpkeep', 'policy', 'loanPayment'];
/** Display names for ledger categories (budget window, charts). */
const CATEGORIES = {
  'tax:R': { name: 'Residential taxes', icon: '🏠' },
  'tax:C': { name: 'Commercial taxes', icon: '🏬' },
  'tax:I': { name: 'Industrial taxes', icon: '🏭' },
  tourism: { name: 'Tourism', icon: '📸' },
  grant: { name: 'State grant (young towns)', icon: '🏛️' },
  income: { name: 'Venues (casino, stadium)', icon: '🎟️' },
  reward: { name: 'Milestone rewards', icon: '🏆' },
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
  const b = agg.S === S ? agg.base.R : null;
  return b ? b[0] + b[1] + b[2] : 0;
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
    agg.upkeep[dept] = (agg.upkeep[dept] || 0) + (def.upkeep || 0);
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
  for (const t of a.tourismReq) if (S.policies[t.policy]) pts += t.pts;
  return pts * Math.max(0, 1 + (S.mods.tourism || 0));
}

/** Fresh day-weighted accumulators (see header). */
function newAcc() {
  const fund = {};
  for (const d of VC.DEPARTMENTS) fund[d.key] = 0;
  return { days: 0, tax: { R: [0, 0, 0], C: [0, 0, 0], I: [0, 0, 0] }, fund, pol: {} };
}
/** Adds today's tax rates, funding levels and active policies (bus 'day'). */
function accumulate() {
  const S = S_();
  if (!S || !S.tax || !S.budget) return;
  const e = ensureEcon(S);
  const a = e.acc && e.acc.tax && e.acc.fund && e.acc.pol ? e.acc : (e.acc = newAcc());
  a.days++;
  for (const z of ZONES) {
    const t = S.tax[z], at = a.tax[z] || (a.tax[z] = [0, 0, 0]);
    if (t) for (let w = 0; w < 3; w++) at[w] += +t[w] || 0;
  }
  for (const d of VC.DEPARTMENTS) a.fund[d.key] = (a.fund[d.key] || 0) + funding(d.key);
  for (const k in S.policies) if (S.policies[k]) a.pol[k] = (a.pol[k] || 0) + 1;
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
  const polShare = (k) => (acc ? Math.min(1, (acc.pol[k] || 0) / acc.days) : S.policies[k] ? 1 : 0);
  const income = {}, expenses = {};
  const taxDetail = { R: [0, 0, 0], C: [0, 0, 0], I: [0, 0, 0] };
  const taxRates = { R: [0, 0, 0], C: [0, 0, 0], I: [0, 0, 0] };
  for (const z of ZONES) {
    const base = a.base[z];
    const k = TAX_K[z] * Math.max(0, 1 + (mods['tax' + z] || 0));
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
    const v = VC.econ.policyCost(k) * share;
    policies[k] = Math.round(v);
    pc += v;
  }
  expenses.policy = Math.round(pc);
  let lp = 0;
  for (const l of S.loans) lp += loanDue(l).pay;
  expenses.loanPayment = Math.round(lp);

  let ti = 0, te = 0;
  for (const k in income) ti += income[k];
  for (const k in expenses) te += expenses[k];
  return {
    income, expenses, totalIncome: ti, totalExpenses: te, net: ti - te,
    taxDetail, taxRates, dept, policies, venues,
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
    day: S.time.day,
  }, extra || {});
  S.loans.push(l);
  S.econ.loansTaken = (S.econ.loansTaken || 0) + 1;
  S.econ.hadLoan = true;
  VC.money.earn(amount, 'loan');
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
    l.paidInterest = (l.paidInterest || 0) + due.interest;
    if (l.months <= 0 || l.remaining < 0.5) done.push(l);
  }
  book(S, 'loanPayment', -paid);
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
  for (const k of OPER_IN) inc += L[k] > 0 ? L[k] : 0;
  for (const k in L) if ((k.startsWith(OPER_OUT_PREFIX) || OPER_OUT.indexOf(k) >= 0) && L[k] < 0) exp -= L[k];
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
      if (!advisorsOn()) toast(`<b>${d.name}</b> workers are on strike over budget cuts!`, 'bad', '🪧');
      VC.bus.emit('econ', { type: 'strike', dept: d.key, name: d.name });
      rev++;
    } else if (was >= STRIKE_MONTHS && !e.lowFund[d.key]) {
      toast(`<b>${d.name}</b> strike is over — funding restored.`, 'good', d.icon);
      rev++;
    }
  }

  sampleHistory(S);
  bankruptcyCheck(S, e);
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
 * Second bankruptcy while an emergency loan is still open (or no loan slot left): the state
 * takes over the budget. Taxes go up to TAKEOVER_TAX, funding is capped, paid policies end.
 * The city keeps running; the mayor can undo the measures once the books are healthy.
 */
function takeover(S, e) {
  e.takeovers = (e.takeovers || 0) + 1;
  e.takeoverDay = S.time.day;
  for (const z of ZONES) {
    const t = S.tax[z];
    if (t) for (let w = 0; w < 3; w++) t[w] = Math.max(t[w], TAKEOVER_TAX);
  }
  for (const d of VC.DEPARTMENTS) if (funding(d.key) > TAKEOVER_FUNDING) S.budget[d.key] = TAKEOVER_FUNDING;
  const repealed = [];
  for (const k of Object.keys(S.policies)) {
    if (S.policies[k] && VC.econ.policyCost(k) > 0) { delete S.policies[k]; repealed.push(k); }
  }
  VC.econ.computeMods();
  rev++;
  notify(S, {
    key: 'takeover', severity: 'bad', panel: 'budget',
    title: 'State takeover!',
    text: `Bankrupt again with the emergency loan still open — the state has taken over our budget: taxes raised to at least ${TAKEOVER_TAX}%, department funding capped at ${Math.round(TAKEOVER_FUNDING * 100)}%` + (repealed.length ? ', and paid policies repealed.' : '.') + ' Cut costs and get back in the black, Mayor.',
  }, `Bankrupt again! The state took over the budget: taxes ≥ ${TAKEOVER_TAX}%, funding ≤ ${Math.round(TAKEOVER_FUNDING * 100)}%.`);
  VC.bus.emit('econ', { type: 'takeover', repealed, tax: TAKEOVER_TAX, funding: TAKEOVER_FUNDING, count: e.takeovers });
  VC.bus.emit('budgetChanged'); // (no 'policyChanged': it would add a second sound to this one event)
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */
VC.econ = {
  TAX_K, WEALTH_MUL, TOURISM_K, CATEGORIES, HISTORY_KEYS, LOAN_TIERS,
  WEALTH_NAMES: ['Low', 'Mid', 'High'],
  STRIKE_FUNDING, STRIKE_MONTHS,

  init() {
    VC.bus.on('month', () => {
      try { monthly(); } catch (err) { console.error('[econ] monthly failed', err); VC.errors && VC.errors.push('econ: ' + err.message); }
    });
    VC.bus.on('day', () => {
      try { accumulate(); } catch (err) { console.error('[econ] day failed', err); }
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
    // drop policies that no longer exist (old saves), then rebuild modifiers
    for (const k in S.policies) if (!VC.POLICY[k] || !S.policies[k]) delete S.policies[k];
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
   * Demand / happiness effect of taxes: +0.35 at 0%, 0 at 9%, -0.8 at 20% (steeper the higher).
   * Uses the effective rate (policy tax modifiers). wealth null = average of the three levels.
   */
  taxEffect(zone, wealth) {
    const S = S_();
    if (!S || !S.tax[zone]) return 0;
    let r = VC.econ.getTax(zone, wealth == null ? null : wealth);
    r *= Math.max(0, 1 + ((S.mods && S.mods['tax' + zone]) || 0));
    if (r <= 9) return 0.35 * ((9 - r) / 9);
    return M.clamp(-0.8 * Math.pow((r - 9) / 11, 1.25), -1, 0);
  },

  /* ---------------- budget ---------------- */
  /** Department funding 0..1.5 (1 = 100%). dept null = every department. */
  setFunding(dept, f) {
    const S = S_();
    if (!S) return;
    f = Math.round(M.clamp(+f || 0, 0, 1.5) * 100) / 100;
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
  /** Enables/disables a policy. Returns true on success (or if already in that state). */
  setPolicy(key, on) {
    const S = S_();
    const def = VC.POLICY[key];
    if (!S || !def) return false;
    on = !!on;
    if (!!S.policies[key] === on) return true;
    if (on) {
      if (!VC.world.isUnlocked(key)) {
        toast(`${def.name} unlocks at ${VC.fmt.num(def.unlock)} citizens.`, 'warn', '🔒');
        return false;
      }
      const cost = VC.econ.policyCost(key);
      if (!S.sandbox && cost > 0 && !VC.money.canAfford(cost)) {
        // need at least one month's cost in the bank. VC.money.spend owns the one 'noMoney'
        // notification: it fails here (unaffordable, not forced) and charges nothing.
        VC.money.spend(cost, 'policy');
        return false;
      }
      S.policies[key] = true;
    } else delete S.policies[key];
    VC.econ.computeMods();
    rev++;
    VC.bus.emit('policyChanged', key);
    return true;
  },
  isPolicyOn(key) {
    const S = S_();
    return !!(S && S.policies[key]);
  },
  /** Monthly $ cost of a policy at the current population (flat + per capita, × difficulty). */
  policyCost(key) {
    const S = S_();
    const def = VC.POLICY[key];
    if (!S || !def) return 0;
    return Math.round(((def.cost || 0) + (def.costPerCap || 0) * population(S)) * costMul(S));
  },
  /** Recomputes S.mods from active policies (additive, clamped). */
  computeMods() {
    const S = S_();
    if (!S) return;
    const m = S.mods || (S.mods = {});
    for (const k of VC.MODS) m[k] = 0;
    for (const k in S.policies) {
      const def = VC.POLICY[k];
      if (!def || !S.policies[k]) continue;
      for (const e in def.effects) m[e] = (m[e] || 0) + def.effects[e];
    }
    for (const k in m) m[k] = Math.round(M.clamp(m[k], -0.95, 2) * 1000) / 1000;
    return m;
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
      else if (S.loans.length >= MAX_LOANS) reason = `At most ${MAX_LOANS} loans at once`;
      else if (!S.sandbox && d + t.amount > lim) reason = `Exceeds credit limit (${VC.fmt.money(lim)})`;
      return { amount: t.amount, rate, months: t.months, monthly, total: monthly * t.months, available: !reason, reason };
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
    return addLoan(S, opt.amount, opt.rate, opt.months);
  },
  /** Pays off loan i (index into S.loans) in full if affordable. */
  repayLoan(i) {
    const S = S_();
    const l = S && S.loans[i];
    if (!l) return false;
    const cost = Math.ceil(l.remaining);
    if (!VC.money.spend(cost, 'loanPayoff')) return false; // capital, not operating cost
    S.loans.splice(i, 1);
    if (!S.loans.length) S.econ.debtFreeDay = S.time.day;
    rev++;
    VC.bus.emit('loanChanged', null);
    VC.bus.emit('sfx', { name: 'cash' });
    return true;
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
    const key = keyOrB && typeof keyOrB === 'object' ? keyOrB.key : keyOrB;
    const def = VC.BLD[key];
    if (!S || !def || !def.upkeep) return 0;
    const dept = def.dept || 'parks';
    return Math.round(def.upkeep * funding(dept) * costMul(S) * (WAGE_DEPTS[dept] ? wageMul(S) : 1));
  },
  /** Tax rates (%) actually billed last month (day-weighted averages): {taxRates:{R:[..]…}, days}. */
  taxBilled() {
    const S = S_();
    return (S && S.econ && S.econ.lastBilled) || null;
  },
};
