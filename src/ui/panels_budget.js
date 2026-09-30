/*
 * VOXELPOLIS — Budget & Taxes panel ('budget', the flagship manager window).
 * Tabs: Overview (net, treasury, 12-month projection, income/expense breakdown, actuals vs forecast),
 * Taxes (R/C/I sliders + 9 advanced wealth sliders, revenue + mood readouts), Departments (funding
 * sliders, cost, effectiveness, presets), Loans (offers + outstanding), History (charts with range).
 * All numbers come from VC.econ (forecast/deptUpkeep/effectiveness/taxEffect/loanOptions) with
 * fallbacks to S.ledger / catalog upkeep so the window stays meaningful before econ is present.
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
      U.txt(lab, ci[1]);
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
  c.appendChild(h('div', { class: 'note lead' }, 'Taxes are collected monthly from residents and businesses. Low taxes attract growth; high taxes fill the coffers but slow demand and anger citizens.'));
  const zones = {};
  const grid = h('div', { class: 'pn-tax-grid' });
  for (const z of ZK) {
    const big = h('div', { class: 'pn-tax-rate' });
    const sl = U.slider({ min: 0, max: 20, step: 1, value: Math.round(taxAvg(z)), color: U.ZHEX[z], format: (v) => v + '%', tip: `Sets all three wealth brackets of <b>${ZNAME[z]}</b> tax at once.`, onInput: (v) => {
      U.api('econ', 'setTax', [z, null, v]);
      P.refresh();
    } });
    const revV = h('b');
    const rev = h('div', { class: 'pn-tax-rev', 'data-tip': 'Estimated monthly tax revenue from this zone.' }, '💵 ', revV, h('span', null, ' /mo'));
    rev.set = (t) => U.txt(revV, t);
    const mood = h('div', { class: 'pn-tax-mood' });
    const card = h('div', { class: 'pn-tax-card z' + z }, h('div', { class: 'pn-tax-head' }, h('span', { class: 'pn-tax-icon' }, ZICON[z]), h('span', { class: 'pn-tax-name' }, ZNAME[z]), big), sl, h('div', { class: 'pn-tax-scale' }, h('span', null, '0%'), h('span', null, '10%'), h('span', null, '20%')), rev, mood);
    grid.appendChild(card);
    zones[z] = { big, sl, rev, mood, adv: [] };
  }
  c.appendChild(grid);
  const warn = h('div', { class: 'pn-banner t-warn' }, '⚠️ Rates above 12% noticeably slow growth and hurt happiness.');
  c.appendChild(warn);

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
      const det = h('div', { class: 'pn-adv-det' });
      col.append(sl, det);
      sl.det = det;
      zones[z].adv.push(sl);
    }
    advBody.appendChild(col);
  }
  c.appendChild(h('div', { class: 'pn-adv' }, advBtn, advBody));
  sync();

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
    U.show(warn, hi);
  };
}

/* ---------------- Departments ---------------- */
function tabDepartments(c) {
  const setAll = (f) => {
    for (const d of VC.DEPARTMENTS) U.api('econ', 'setFunding', [d.key, f]);
    VC.bus.emit('toast', { text: `All departments funded at <b>${Math.round(f * 100)}%</b>`, type: 'info', icon: '🏛️' });
    P.refresh();
  };
  const total = h('span', { class: 'pn-dept-total' });
  c.appendChild(h('div', { class: 'pn-toolbar' },
    h('span', { class: 'pn-toolbar-label' }, 'Presets'),
    VC.ui.button('Austerity', () => setAll(0.8), { icon: '🪙', cls: 'small', tip: 'Fund every department at <b>80%</b>. Saves money, services suffer.' }),
    VC.ui.button('Balanced', () => setAll(1), { icon: '⚖️', cls: 'small', tip: 'Fund every department at <b>100%</b>.' }),
    VC.ui.button('Generous', () => setAll(1.2), { icon: '💎', cls: 'small', tip: 'Fund every department at <b>120%</b>. Better services with diminishing returns.' }),
    h('span', { class: 'pn-grow' }),
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
  return () => {
    const S = VC.state;
    const st = U.deptStats();
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
      U.txt(r.warn, strike ? '🪧 ON STRIKE!' : lowM > 0 && f < 0.5 ? '⚠️ Strike in ' + Math.max(1, sm - lowM) + ' mo' : '⚠️ Strike risk!');
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
        // a real econ explains refusals itself (toast); only speak up when nobody else will
        if (ok === false) {
          if (!('available' in o)) VC.bus.emit('toast', { text: 'The bank declined the loan.', type: 'bad', icon: '🏦' });
        } else {
          VC.bus.emit('toast', { text: `Loan of <b>${U.money(o.amount)}</b> received.`, type: 'good', icon: '🏦' });
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
      const i = el._i, l = el._l;
      VC.ui.confirm(`Pay off the remaining <b>${U.money(l.remaining)}</b> of this loan now?`, () => {
        const ok = U.api('econ', 'repayLoan', [i], false);
        if (ok === false) VC.bus.emit('toast', { text: 'Not enough money to repay this loan.', type: 'bad', icon: '🏦' });
        else VC.bus.emit('toast', { text: 'Loan repaid. The bank thanks you!', type: 'good', icon: '🏦' });
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
