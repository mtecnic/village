/*
 * VOXELPOLIS — City Statistics ('stats') and Population ('population') panels.
 * stats: chart cards from S.history (monthly samples) with 1y / 5y / All ranges, current values and
 *        12-month deltas. Charts redraw only when history grows or the range changes.
 * population: residents/jobs/workers/unemployment, wellbeing bars, happiness histogram, wealth and
 *        density breakdowns, buildings by zone & level, RCI demand with factor breakdown
 *        (VC.sim.demandFactors). Building aggregates are recomputed at most twice per second.
 */
const P = VC.panels, U = P.util, h = VC.h, M = VC.M;

/* ================================================================== */
/* CITY STATISTICS                                                      */
/* ================================================================== */
const pctFmt = (v) => Math.round(v * 100) + '%';
const LABELS = { powerSupply: 'Power supply', powerDemand: 'Power demand', power: 'Power', waterSupply: 'Water supply', waterDemand: 'Water demand', water: 'Water' };
/** Chart definitions. series[].keys: candidate S.history keys (first with data wins). */
const CHARTS = [
  { key: 'pop', title: 'Population', icon: '👥', series: [{ keys: ['pop'], color: '#39d98a' }], fmt: (v) => VC.fmt.short(v), cur: (S) => [U.int(S.stats.pop), ''] },
  { key: 'money', title: 'Treasury', icon: '🏦', series: [{ keys: ['money'], color: '#b388ff' }], fmt: U.moneyAxis, cur: (S) => [U.money(S.money), S.money < 0 ? 'bad' : ''] },
  { key: 'happy', title: 'Happiness & approval', icon: '😊', min: 0, max: 1, fmt: pctFmt, series: [{ keys: ['happiness'], color: '#ffd166', label: 'Happiness' }, { keys: ['approval'], color: '#5ad1ff', label: 'Approval', fill: false }], cur: (S) => { const v = U.n01(S.stats.happiness); return [U.pct(v), v < 0.4 ? 'bad' : v < 0.55 ? 'warn' : 'good']; } },
  { key: 'fin', title: 'Income vs expenses', icon: '💵', fmt: U.moneyAxis, series: [{ keys: ['income'], color: '#3ddc84', label: 'Income', fill: false }, { keys: ['expenses'], color: '#ff5a6a', label: 'Expenses', fill: false, abs: true }], cur: (S) => { const st = S.stats; let n = U.num(st.net, U.num(st.income) - Math.abs(U.num(st.expenses))); if (!st.income && !st.expenses && U.histLen('income')) n = U.num(+U.hist('income', 1)[0]) - Math.abs(U.num(+U.hist('expenses', 1)[0])); return [U.smoney(n) + '/mo', n < 0 ? 'bad' : n > 0 ? 'good' : '']; } },
  { key: 'rci', title: 'RCI demand', icon: '🏗️', min: -1, max: 1, sub: 'Growth pressure, −100 … +100', fmt: (v) => U.sint(v * 100), series: [{ keys: ['demandR'], color: U.ZHEX.R, label: 'Residential', fill: false }, { keys: ['demandC'], color: U.ZHEX.C, label: 'Commercial', fill: false }, { keys: ['demandI'], color: U.ZHEX.I, label: 'Industrial', fill: false }], cur: (S) => { const d = S.demand || {}; const f = (v) => U.sint(U.num(v) * 100); return ['R' + f(d.R) + ' C' + f(d.C) + ' I' + f(d.I), '']; } },
  { key: 'labor', title: 'Residents vs jobs', icon: '💼', fmt: (v) => VC.fmt.short(v), series: [{ keys: ['pop'], color: '#39d98a', label: 'Residents', fill: false }, { keys: ['jobs'], color: '#4cc9f0', label: 'Jobs', fill: false }], cur: (S) => [U.int(S.stats.jobs) + ' jobs', ''] },
  { key: 'unemp', title: 'Unemployment', icon: '📉', auto: true, lower: true, series: [{ keys: ['unemployment'], color: '#ff9f43' }], cur: (S) => { const v = U.n01(S.stats.unemployment); return [U.pct(v, 1), v > 0.12 ? 'bad' : v > 0.07 ? 'warn' : 'good']; } },
  { key: 'env', title: 'Crime, pollution & traffic', icon: '🚨', auto: true, lower: true, series: [{ keys: ['crime'], color: '#ff5a6a', label: 'Crime', fill: false }, { keys: ['pollution'], color: '#c9a27a', label: 'Pollution', fill: false }, { keys: ['traffic'], color: '#f4a261', label: 'Traffic', fill: false }], cur: (S) => { const v = U.n01(S.stats.crime); return ['🦹 ' + U.pct(v), v > 0.4 ? 'bad' : v > 0.2 ? 'warn' : 'good']; } },
  { key: 'util', title: 'Power & water', icon: '⚡', auto: true, series: [{ keys: ['powerSupply', 'power'], color: '#ffd166' }, { keys: ['powerDemand'], color: '#ff9f43', fill: false }, { keys: ['waterSupply', 'water'], color: '#4cc9f0' }, { keys: ['waterDemand'], color: '#2d7dd2', fill: false }], cur: (S) => { const st = S.stats; const pu = st.powerSupply > 0 ? st.powerDemand / st.powerSupply : 0, wu = st.waterSupply > 0 ? st.waterDemand / st.waterSupply : 0; return ['⚡' + U.pct(pu) + ' 💧' + U.pct(wu), pu > 1 || wu > 1 ? 'bad' : pu > 0.9 || wu > 0.9 ? 'warn' : '']; } },
  { key: 'tour', title: 'Tourism', icon: '📸', fmt: (v) => VC.fmt.short(v), series: [{ keys: ['tourism'], color: '#f15bb5' }], cur: (S) => [U.int(S.stats.tourism) + ' pts', ''] },
];
let statRange = 60;

function chartCard(def, width) {
  const cur = h('span', { class: 'pn-cc-cur' });
  const delta = h('span', { class: 'pn-cc-delta' });
  let autoPct = false; // 'auto' charts show percentages when all samples are 0..1 fractions
  const yFormat = (v) => (def.auto ? (autoPct ? pctFmt(v) : VC.fmt.short(v)) : def.fmt(v));
  const chart = U.chartHover(VC.ui.chart({ width, height: 118, series: [], yFormat, min: def.min, max: def.max }));
  // tooltip values: full precision in the chart's own unit
  const tipFmt = (v) => (def.auto ? (autoPct ? U.pct(v, 1) : U.int(v)) : def.key === 'rci' ? U.sint(v * 100) : def.min === 0 && def.max === 1 ? U.pct(v, 1) : def.fmt === U.moneyAxis ? U.smoney(v) : U.int(v));
  const el = h('div', { class: 'pn-cc' }, h('div', { class: 'pn-cc-head' }, h('span', { class: 'pn-cc-title' }, h('span', { class: 'pn-ic' }, def.icon), def.title), cur), delta, chart);
  let lastSig = '', lastR = -1;
  el.upd = (S, force) => {
    const c = def.cur(S);
    U.txt(cur, c[0]);
    U.tone(cur, c[1]);
    const sig = U.histSig(def.series[0].keys[0]) + '/' + U.histLen(def.series[0].keys[1] || '');
    if (!force && sig === lastSig && lastR === statRange) return;
    lastSig = sig;
    lastR = statRange;
    const series = [];
    let auto01 = true;
    for (const sd of def.series) {
      const key = sd.keys.find((k) => U.histLen(k) > 0);
      if (!key) continue;
      let data = U.hist(key, statRange).map((v) => U.num(+v));
      if (sd.abs) data = data.map(Math.abs);
      for (const v of data) if (v > 1.5 || v < -0.01) auto01 = false;
      series.push({ data, color: sd.color, label: def.series.length > 1 ? sd.label || LABELS[key] || key : null, fill: sd.fill });
    }
    autoPct = auto01;
    el.hasData = series.length > 0;
    chart.update(series);
    chart.setHover(series.map((x) => Object.assign({}, x, { label: x.label || def.title })), tipFmt);
    // 12-month delta of the first series
    const d0 = series[0] && series[0].data;
    if (def.sub) {
      U.txt(delta, def.sub);
      U.tone(delta, 'muted');
    } else if (d0 && d0.length >= 2) {
      const a = d0[Math.max(0, d0.length - 13)], b = d0[d0.length - 1];
      const span = Math.min(12, d0.length - 1);
      let txt, good;
      if (def.min != null || (def.auto && auto01)) {
        const dv = (b - a) * 100;
        txt = (dv >= 0 ? '▲ ' : '▼ ') + Math.abs(dv).toFixed(1) + ' pts';
        good = def.lower ? dv <= 0 : dv >= 0;
      } else if (Math.abs(a) < 1e-9) {
        // from zero a percentage is meaningless (the old code printed "▲ 0.0%"): show the absolute change
        const dv = b - a;
        const fmtAbs = def.fmt === U.moneyAxis ? U.smoney : (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + (def.auto && auto01 ? U.pct(Math.abs(v), 1) : U.int(Math.abs(v)));
        txt = Math.abs(dv) < 1e-9 ? '▬ no change' : (dv > 0 ? '▲ ' : '▼ ') + fmtAbs(dv) + ' from zero';
        good = def.lower ? dv <= 0 : dv >= 0;
      } else {
        const dv = (b - a) / Math.abs(a);
        txt = (dv >= 0 ? '▲ ' : '▼ ') + Math.abs(dv * 100).toFixed(1) + '%';
        good = def.lower ? dv <= 0 : dv >= 0;
      }
      U.txt(delta, txt + ' over ' + span + ' month' + (span === 1 ? '' : 's'));
      U.tone(delta, Math.abs(b - a) < 1e-9 ? 'muted' : good ? 'good' : 'bad');
    } else {
      U.txt(delta, 'collecting data…');
      U.tone(delta, 'muted');
    }
  };
  return el;
}

P.defs.stats = {
  title: 'City Statistics',
  icon: '📈',
  width: 720,
  place: 'center',
  build(p) {
    const seg = U.seg([{ value: 12, label: '1 year' }, { value: 60, label: '5 years' }, { value: 0, label: 'All time' }], statRange, (v) => {
      statRange = v;
      upd(true);
    });
    const months = h('span', { class: 'pn-muted-note' });
    p.body.appendChild(h('div', { class: 'pn-toolbar' }, h('span', { class: 'pn-toolbar-label' }, 'Range'), seg, h('span', { class: 'pn-grow' }), months));
    const grid = h('div', { class: 'pn-cc-grid' });
    const cards = CHARTS.map((d) => chartCard(d, 314));
    grid.append(...cards);
    const empty = U.empty('📊', 'Not enough data yet', 'City statistics are sampled once a month. Let the simulation run for a couple of months and the charts will fill in.');
    p.body.append(empty, grid);
    function upd(force) {
      const S = VC.state;
      const n = Math.max(U.histLen('pop'), U.histLen('money'));
      U.txt(months, n ? '📅 ' + n + ' month' + (n === 1 ? '' : 's') + ' of records' : '');
      U.show(empty, n < 2);
      U.show(grid, n >= 2);
      if (n < 2) return; // a single sample makes flat, meaningless charts
      for (const c of cards) {
        c.upd(S, force);
        U.show(c, c.hasData); // hide charts whose metric this city does not record
      }
    }
    return upd;
  },
};

/* ================================================================== */
/* POPULATION                                                           */
/* ================================================================== */
let aggC = null, aggAt = 0;
/** Aggregates over growable buildings (cached 0.5 s). */
function agg() {
  const S = VC.state, now = performance.now();
  if (aggC && aggC.S === S && now - aggAt < 500) return aggC;
  const mk = () => ({ n: 0, pop: 0 });
  const a = {
    S,
    zone: { 1: { lv: [0, 0, 0, 0], pop: 0, cap: 0, ab: 0 }, 2: { lv: [0, 0, 0, 0], pop: 0, cap: 0, ab: 0 }, 3: { lv: [0, 0, 0, 0], pop: 0, cap: 0, ab: 0 } },
    wealthR: [mk(), mk(), mk()],
    wealthB: [mk(), mk(), mk()],
    den: { 1: mk(), 2: mk(), 3: mk() },
    hist: new Float64Array(10),
    histW: 0,
    homes: 0,
  };
  for (const b of S.buildings.values()) {
    if (b.key !== 'grow') continue;
    const z = a.zone[b.zt];
    if (!z) continue;
    const pop = U.num(b.pop);
    z.lv[M.clamp(b.level | 0, 1, 3)]++;
    z.lv[0]++;
    z.pop += pop;
    z.cap += U.num(b.cap);
    if (b.abandoned) z.ab++;
    const w = M.clamp(b.wealth | 0, 0, 2);
    const dn = a.den[M.clamp(b.den | 0, 1, 3)];
    dn.n++;
    dn.pop += pop;
    if (b.zt === 1) {
      a.homes++;
      a.wealthR[w].n++;
      a.wealthR[w].pop += pop;
      const wgt = Math.max(1, pop);
      a.hist[Math.min(9, Math.floor(M.sat(U.num(b.happy, 0.5)) * 10))] += wgt;
      a.histW += wgt;
    } else {
      a.wealthB[w].n++;
      a.wealthB[w].pop += pop;
    }
  }
  aggC = a;
  aggAt = now;
  return a;
}

function popOverview(c) {
  const kRes = U.kpi('Residents', { icon: '👥' });
  const kJobs = U.kpi('Jobs', { icon: '💼', tip: 'Commercial + industrial jobs' });
  const kWork = U.kpi('Workers', { icon: '👷', tip: 'Residents of working age (the labour force)' });
  const kUn = U.kpi('Jobless', { icon: '📉', tip: 'Unemployment rate' });
  c.appendChild(h('div', { class: 'pn-kpis cols4' }, kRes, kJobs, kWork, kUn));
  const labor = h('div', { class: 'pn-banner' });
  c.appendChild(labor);
  const mEdu = U.meter('Education', { icon: '🎓', color: U.rampGood });
  const mHea = U.meter('Health', { icon: '🩺', color: U.rampGood });
  const mHap = U.meter('Happiness', { icon: '😊', color: U.rampGood });
  const mApp = U.meter('Mayor approval', { icon: '🗳️', color: U.rampGood });
  c.appendChild(U.sec('Wellbeing', h('div', { class: 'pn-grid2' }, mEdu, mHea, mHap, mApp)));
  const bars = [];
  const histo = h('div', { class: 'pn-histo' });
  for (let i = 0; i < 10; i++) {
    const v = h('span', { class: 'pn-histo-v' });
    const b = h('div', { class: 'pn-histo-bar' }, v, h('i', { style: { background: U.rampGood((i + 0.5) / 10) } }));
    bars.push(b);
    histo.appendChild(b);
  }
  const histCap = h('div', { class: 'pn-histo-cap' }, h('span', null, '😡 Miserable'), h('span', null, 'Content'), h('span', null, 'Ecstatic 😄'));
  const histNote = h('div', { class: 'note' });
  c.appendChild(U.sec('Happiness distribution', histo, histCap, histNote));
  return () => {
    const S = VC.state, st = S.stats, a = agg();
    const pop = U.num(st.pop), jobs = U.num(st.jobs), workers = U.num(st.workers);
    kRes.set(U.int(pop), 'peak ' + U.short(S.peakPop));
    kJobs.set(U.int(jobs), 'C ' + U.short(st.jobsC) + ' · I ' + U.short(st.jobsI));
    kWork.set(U.int(workers), pop > 0 ? U.pct(workers / pop) + ' of residents' : '—');
    const un = U.n01(st.unemployment);
    // one source of truth for the KPI and the note: the sim's labour force (st.workers = working-age residents)
    const avail = Math.max(0, workers || pop * 0.5);
    const short = pop > 0 && jobs > avail * 1.15, idle = pop > 0 && jobs < avail * 0.85;
    if (!pop) kUn.set('—', 'no residents yet', '');
    else kUn.set(U.pct(un, 1), un > 0.12 ? 'jobs needed!' : short ? 'labor shortage' : 'healthy', un > 0.12 ? 'bad' : un > 0.07 ? 'warn' : 'good');
    let msg, tone;
    if (!pop) { msg = '🏗️ Zone residential areas to attract your first citizens.'; tone = 'info'; }
    else if (short) { msg = `💼 ${U.int(jobs - avail)} more jobs than workers — zone more housing (commuters fill some of the gap).`; tone = 'warn'; }
    else if (idle) { msg = `🏭 About ${U.int(avail - jobs)} residents are looking for work — zone commercial or industry.`; tone = 'warn'; }
    else { msg = '⚖️ Jobs and workers are well balanced.'; tone = 'good'; }
    U.txt(labor, msg);
    U.tone(labor, tone);
    const e = U.n01(st.education), hl = U.n01(st.health), hp = U.n01(st.happiness), ap = U.n01(st.approval);
    mEdu.set(e);
    mHea.set(hl);
    mHap.set(hp);
    mApp.set(ap);
    let mx = 0;
    for (let i = 0; i < 10; i++) mx = Math.max(mx, a.hist[i]);
    for (let i = 0; i < 10; i++) {
      const f = mx > 0 ? a.hist[i] / mx : 0;
      U.css(bars[i].lastChild, 'height', 'calc((100% - 15px) * ' + Math.max(f, a.hist[i] > 0 ? 0.04 : 0).toFixed(3) + ')');
      U.txt(bars[i].firstChild, a.histW > 0 && a.hist[i] > 0 ? Math.round((a.hist[i] / a.histW) * 100) + '%' : '');
      U.attr(bars[i], 'data-tip', `Happiness ${i * 10}–${i * 10 + 10}%: <b>${a.histW > 0 ? U.pct(a.hist[i] / a.histW) : '0%'}</b> of residents`);
    }
    U.txt(histNote, a.homes ? `Share of residents by how happy their building is (${U.int(a.homes)} residential buildings).` : 'No residential buildings yet.');
  };
}

function popHouseholds(c) {
  const wcards = [];
  const wgrid = h('div', { class: 'pn-wealth' });
  const WCOL = ['#8fd3ff', '#ffd166', '#b388ff'];
  for (let w = 0; w < 3; w++) {
    const n = h('div', { class: 'pn-wealth-n' });
    const sub = h('div', { class: 'pn-wealth-sub' });
    const biz = h('div', { class: 'pn-wealth-biz' });
    const m = U.meter('Share of residents', { small: true, color: WCOL[w] });
    const el = h('div', { class: 'pn-wealth-card w' + w }, h('div', { class: 'pn-wealth-top' }, h('span', { class: 'pn-wealth-sym', style: { color: WCOL[w] } }, U.wealth(w)), h('span', null, U.WEALTH[w])), n, sub, m, biz);
    wcards.push({ n, sub, m, biz });
    wgrid.appendChild(el);
  }
  c.appendChild(U.sec('Wealth', wgrid));
  const drows = [];
  const dbox = h('div', { class: 'pn-density' });
  for (let d = 1; d <= 3; d++) {
    const m = U.meter(VC.DENSITY[d] + ' density', { icon: ['🏡', '🏢', '🏙️'][d - 1], color: ['#80ed99', '#4cc9f0', '#c77dff'][d - 1] });
    drows.push(m);
    dbox.appendChild(m);
  }
  c.appendChild(U.sec('Density (share of occupants)', dbox));
  const cells = {};
  const td = (k) => (cells[k] = h('td', { class: 'num' }));
  const tbl = h('table', { class: 'pn-table' },
    h('thead', null, h('tr', null, h('th', null, 'Zone'), h('th', { class: 'num' }, '★'), h('th', { class: 'num' }, '★★'), h('th', { class: 'num' }, '★★★'), h('th', { class: 'num' }, 'Abandoned'), h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, 'Occupants'))),
    h('tbody', null, [1, 2, 3].map((z) => h('tr', null, h('td', null, h('span', { class: 'pn-zdot', style: { background: VC.ZONES[z].color } }), VC.ZONES[z].icon + ' ' + VC.ZONES[z].name), td(z + 'l1'), td(z + 'l2'), td(z + 'l3'), td(z + 'ab'), td(z + 'n'), td(z + 'pop'))))
  );
  c.appendChild(U.sec('Buildings by zone & level', tbl, h('div', { class: 'note' }, 'Occupants are residents for residential buildings and workers for commercial / industrial ones.')));
  return () => {
    const a = agg();
    const rpop = a.wealthR[0].pop + a.wealthR[1].pop + a.wealthR[2].pop;
    for (let w = 0; w < 3; w++) {
      const r = a.wealthR[w], b = a.wealthB[w], wc = wcards[w];
      U.txt(wc.n, U.int(r.pop));
      U.txt(wc.sub, 'residents in ' + U.int(r.n) + ' home' + (r.n === 1 ? '' : 's'));
      wc.m.set(rpop > 0 ? r.pop / rpop : 0);
      U.txt(wc.biz, '🏬 ' + U.int(b.n) + ' firms · ' + U.short(b.pop) + ' jobs');
      U.attr(wc.biz, 'data-tip', `${U.int(b.n)} ${U.WEALTH[w].toLowerCase()} businesses employing ${U.int(b.pop)} workers`);
    }
    const dpop = a.den[1].pop + a.den[2].pop + a.den[3].pop;
    for (let d = 1; d <= 3; d++) drows[d - 1].set(dpop > 0 ? a.den[d].pop / dpop : 0, U.int(a.den[d].pop) + ' in ' + U.int(a.den[d].n) + ' bldg · ' + (dpop > 0 ? U.pct(a.den[d].pop / dpop) : '0%'));
    for (const z of [1, 2, 3]) {
      const s = a.zone[z];
      U.txt(cells[z + 'l1'], U.int(s.lv[1]));
      U.txt(cells[z + 'l2'], U.int(s.lv[2]));
      U.txt(cells[z + 'l3'], U.int(s.lv[3]));
      U.txt(cells[z + 'ab'], U.int(s.ab));
      U.tone(cells[z + 'ab'], s.ab ? 'bad' : '');
      U.txt(cells[z + 'n'], U.int(s.lv[0]));
      U.txt(cells[z + 'pop'], U.int(s.pop));
    }
  };
}

function popDemand(c) {
  c.appendChild(h('div', { class: 'note lead' }, 'Demand shows how much each zone type wants to grow. Positive demand means new buildings will appear in zoned land; negative demand means buildings may empty out.'));
  const cols = {};
  const grid = h('div', { class: 'pn-rci' });
  for (const z of ['R', 'C', 'I']) {
    const fill = h('i');
    const val = h('div', { class: 'pn-rci-val' });
    const gauge = h('div', { class: 'pn-rci-gauge' }, h('b'), fill);
    const list = h('div', { class: 'pn-rci-factors' });
    const none = h('div', { class: 'pn-rci-none' }, 'No factor data yet');
    const zn = VC.ZONES[{ R: 1, C: 2, I: 3 }[z]];
    grid.appendChild(h('div', { class: 'pn-rci-col z' + z }, h('div', { class: 'pn-rci-head' }, zn.icon + ' ' + zn.name), h('div', { class: 'pn-rci-top' }, gauge, val), list, none));
    cols[z] = { fill, val, list, none };
  }
  c.appendChild(grid);
  return () => {
    const S = VC.state;
    const f = U.api('sim', 'demandFactors', [], null) || {};
    let mx = 0.05;
    for (const z of ['R', 'C', 'I']) for (const x of f[z] || []) mx = Math.max(mx, Math.abs(U.num(x.value)));
    for (const z of ['R', 'C', 'I']) {
      const o = cols[z];
      const v = M.clamp(U.num(S.demand && S.demand[z]), -1, 1);
      U.css(o.fill, 'bottom', (v >= 0 ? 50 : 50 + v * 50).toFixed(1) + '%');
      U.css(o.fill, 'height', (Math.abs(v) * 50).toFixed(1) + '%');
      U.css(o.fill, 'background', v >= 0 ? U.ZHEX[z] : '#ff5a6a');
      U.txt(o.val, U.sint(v * 100));
      U.tone(o.val, v > 0.1 ? 'good' : v < -0.1 ? 'bad' : '');
      const fl = (f[z] || []).filter((x) => x && x.label);
      U.keyed(o.list, fl, (x) => x.label, (x) => U.diverge(x.label, { tip: U.esc(x.label) }), (el, x) => el.set(U.num(x.value) / mx, U.sint(U.num(x.value) * 100)));
      U.show(o.none, !fl.length);
    }
  };
}

P.defs.population = {
  title: 'Population & Demand',
  icon: '👥',
  width: 600,
  place: 'left',
  build(p) {
    p.body.appendChild(
      U.tabs(p, [
        { key: 'overview', label: 'Overview', icon: '👥', render: popOverview },
        { key: 'households', label: 'Households', icon: '🏘️', render: popHouseholds },
        { key: 'demand', label: 'RCI Demand', icon: '📊', render: popDemand },
      ])
    );
  },
};
