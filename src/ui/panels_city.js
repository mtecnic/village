/*
 * VOXELPOLIS — City Services ('services') and Utilities ('utilities') panels.
 * services: per VC.SERVICES coverage of residents (VC.sim.serviceStats, fallback: S.maps sampled at
 *   residential buildings), building count, funding, overlay toggle and advice; crime/fire/emergency list.
 * utilities: power and water supply vs demand (VC.sim.powerInfo / waterInfo, fallback S.stats + catalog),
 *   producers grouped by type with share bars and focus buttons, garbage coverage, contextual tips.
 *   Every producer is listed at what it ACTUALLY delivers: ones the sim reports nothing for show 0 with a tag
 *   ("building…", "no power" for pumps / towers, "not connected" when nothing conducts into the footprint),
 *   and the notes count zoned lots the grid does not reach (VC.sim.issues, sampled every 2 s).
 */
const P = VC.panels, U = P.util, h = VC.h, M = VC.M;

/* ---------------- shared scans (cached) ---------------- */
let scanC = null, scanAt = 0;
/**
 * One pass over buildings (≤ 2 Hz): resident-weighted fallback coverage per service map,
 * catalog building counts per service, burning / abandoned / unserved lists.
 */
function scan() {
  const S = VC.state, now = performance.now();
  if (scanC && scanC.S === S && now - scanAt < 500) return scanC;
  const r = { S, cov: {}, bld: {}, fires: [], abandoned: 0, noPower: 0, noWater: 0, grow: 0, resPop: 0 };
  for (const sv of VC.SERVICES) {
    r.cov[sv.key] = 0;
    r.bld[sv.key] = 0;
  }
  for (const b of S.buildings.values()) {
    if (b.fire > 0) r.fires.push(b);
    if (b.abandoned) r.abandoned++;
    const def = VC.BLD[b.key];
    if (def && def.cover) for (const k in def.cover) if (r.bld[k] != null) r.bld[k]++;
    if (b.key !== 'grow' || !(b.built >= 1)) continue;
    r.grow++;
    if (!b.powered) r.noPower++;
    if (!b.watered) r.noWater++;
    if (b.zt !== 1) continue;
    const pop = Math.max(1, U.num(b.pop));
    const i = Math.min(S.H - 1, b.z + (b.d >> 1)) * S.W + Math.min(S.W - 1, b.x + (b.w >> 1));
    r.resPop += pop;
    for (const sv of VC.SERVICES) {
      const m = S.maps[sv.key];
      if (m && m[i] > 96) r.cov[sv.key] += pop; // same threshold as VC.sim.serviceStats
    }
  }
  for (const k in r.cov) r.cov[k] = r.resPop > 0 ? r.cov[k] / r.resPop : 0;
  scanC = r;
  scanAt = now;
  return r;
}
/** Service stats {coverage, buildings, funding} for key — econ/sim first, scan fallback. */
function svc(key, sst, sc) {
  const s = (sst && sst[key]) || {};
  const sv = VC.SERVICES.find((x) => x.key === key);
  const fund = VC.state.budget[sv ? sv.dept : key];
  return {
    coverage: M.sat(typeof s.coverage === 'number' ? s.coverage : sc.cov[key] || 0),
    buildings: typeof s.buildings === 'number' ? s.buildings : sc.bld[key] || 0,
    funding: typeof s.funding === 'number' ? s.funding : fund != null ? fund : 1,
    eff: typeof s.effectiveness === 'number' ? s.effectiveness : null,
  };
}
/** Cheapest unlocked catalog building providing a service (for advice). */
function bestFor(key) {
  let best = null;
  for (const d of VC.CATALOG) {
    if (!d.cover || !d.cover[key]) continue;
    if (!U.safe(() => VC.world.isUnlocked(d.key), true)) continue;
    if (!best || d.cost < best.cost) best = d;
  }
  return best;
}

/* ================================================================== */
/* SERVICES                                                             */
/* ================================================================== */
P.defs.services = {
  title: 'City Services',
  icon: '🚓',
  width: 560,
  place: 'left',
  build(p) {
    const kCrime = U.kpi('Crime', { icon: '🦹', tip: 'Average crime level across the city' });
    const kFire = U.kpi('Fires', { icon: '🔥', tip: 'Buildings currently burning' });
    const kHealth = U.kpi('Health', { icon: '🩺' });
    const kEdu = U.kpi('Education', { icon: '🎓' });
    p.body.appendChild(h('div', { class: 'pn-kpis cols4' }, kCrime, kFire, kHealth, kEdu));
    const rows = [];
    const list = h('div', { class: 'pn-svc-list' });
    for (const sv of VC.SERVICES) {
      const meter = U.meter('Residents covered', { color: U.rampGood, mark: 0.8, tip: 'Share of residents living within reach of this service. The tick marks 80%, a good target.' });
      const sub = h('div', { class: 'pn-svc-sub' });
      const advice = h('div', { class: 'pn-svc-advice' });
      const ov = VC.OVERLAYS.find((o) => o.key === sv.key) ? U.overlayBtn(sv.key, 'Show') : null;
      const el = h('div', { class: 'pn-svc' },
        h('div', { class: 'pn-svc-icon' }, sv.icon),
        h('div', { class: 'pn-svc-main' }, h('div', { class: 'pn-svc-head' }, h('span', { class: 'pn-svc-name' }, sv.name), sub, h('span', { class: 'pn-grow' }), ov), meter, advice)
      );
      list.appendChild(el);
      rows.push({ sv, el, meter, sub, advice, ov });
    }
    p.body.appendChild(U.sec('Coverage', list));
    const emBox = h('div', { class: 'pn-em-list' });
    const emNone = h('div', { class: 'pn-em-none' }, '✅ No emergencies. All quiet.');
    const abLine = U.line('Abandoned buildings', { icon: '🏚️' });
    p.body.appendChild(U.sec('Emergencies', emBox, emNone, abLine));

    const fireRow = () => {
      const name = h('span', { class: 'pn-em-name' });
      const bar = h('i');
      const el = h('div', { class: 'pn-em' }, h('span', { class: 'pn-em-ic' }, '🔥'), name, h('div', { class: 'pn-em-bar' }, bar), VC.ui.button('', () => U.focus(el._b), { icon: '📍', cls: 'small', tip: 'Focus camera' }));
      el.set = (b) => {
        el._b = b;
        U.txt(name, U.safe(() => VC.sim.buildingName(b), 'Building'));
        U.css(bar, 'width', (M.sat(b.fire) * 100).toFixed(0) + '%');
      };
      return el;
    };
    return () => {
      const S = VC.state, st = S.stats;
      const sc = scan();
      const sst = U.api('sim', 'serviceStats', [], null) || {};
      const crime = U.n01(st.crime);
      kCrime.set(U.pct(crime), crime > 0.4 ? 'crime wave!' : crime > 0.2 ? 'elevated' : 'low', crime > 0.4 ? 'bad' : crime > 0.2 ? 'warn' : 'good');
      kFire.set(String(sc.fires.length), sc.fires.length ? 'burning now' : 'none', sc.fires.length ? 'bad' : 'good');
      const he = U.n01(st.health), ed = U.n01(st.education);
      kHealth.set(U.pct(he), 'city avg', he < 0.4 ? 'bad' : he < 0.6 ? 'warn' : 'good');
      kEdu.set(U.pct(ed), 'city avg', ed < 0.4 ? 'bad' : ed < 0.6 ? 'warn' : 'good');
      for (const r of rows) {
        const s = svc(r.sv.key, sst, sc);
        r.meter.set(s.coverage);
        U.txt(r.sub, `${s.buildings} bldg · ${Math.round(s.funding * 100)}% funded` + (s.eff != null && Math.abs(s.eff - s.funding) > 0.02 ? ` · ${Math.round(s.eff * 100)}% effective` : ''));
        U.tone(r.sub, s.funding < 0.5 ? 'bad' : s.funding < 0.8 ? 'warn' : '');
        let msg, tone;
        const best = bestFor(r.sv.key);
        if (!sc.resPop && !s.buildings) { msg = 'Waiting for residents.'; tone = 'muted'; }
        else if (!s.buildings) { msg = best ? `No coverage yet — build a ${best.icon} ${best.name}.` : 'No coverage yet.'; tone = 'bad'; }
        else if (s.coverage < 0.35) { msg = `Most residents are unserved. ${best ? 'Add a ' + best.icon + ' ' + best.name + ' near dense areas.' : ''}`; tone = 'bad'; }
        else if (s.coverage < 0.65) { msg = 'Coverage is patchy — fill the gaps shown on the overlay.'; tone = 'warn'; }
        else if (s.coverage < 0.85) { msg = 'Good coverage.'; tone = 'good'; }
        else { msg = 'Excellent coverage.'; tone = 'good'; }
        if (s.funding < 0.5 && s.buildings) { msg = '⚠️ Severely underfunded — strikes likely! ' + msg; tone = 'bad'; }
        else if (s.funding < 0.8 && s.buildings) msg = 'Underfunded: reduced effectiveness. ' + msg;
        U.txt(r.advice, msg);
        U.tone(r.advice, tone);
        U.cls(r.el, 'bad', tone === 'bad');
        if (r.ov) r.ov.sync();
      }
      const fires = sc.fires.slice(0, 6);
      U.keyed(emBox, fires, (b) => b.id, fireRow, (el, b) => el.set(b));
      U.show(emNone, !fires.length);
      abLine.set(U.int(sc.abandoned), sc.abandoned ? 'warn' : '');
    };
  },
};

/* ================================================================== */
/* UTILITIES                                                            */
/* ================================================================== */
/** Nothing that carries this utility touches the building's footprint (VC.actions.gridLink). */
function isolated(b, kind) {
  const A = VC.actions;
  if (!A || !A.gridLink) return false;
  const l = A.gridLink(b.x, b.z, b.w, b.d, b.id);
  return kind === 'power' ? !l.power : !l.water;
}
/** "2 no power · 1 building…" for a producer group ('' when all run). */
function tagText(g) {
  const parts = [];
  for (const t in g.tags) parts.push((g.list.length > 1 ? g.tags[t] + ' ' : '') + t);
  return parts.join(' · ');
}
/** Normalized network info: {supply, demand, groups:[{key, def, list:[b], output, tags}]} */
function netInfo(kind) {
  const S = VC.state;
  const info = U.api('sim', kind === 'power' ? 'powerInfo' : 'waterInfo', [], null) || {};
  // prefer the sim's live numbers; fall back to the monthly stats when it reports nothing
  let supply = U.num(info.supply), demand = U.num(info.demand);
  if (!supply) supply = U.num(kind === 'power' ? S.stats.powerSupply : S.stats.waterSupply);
  if (!demand) demand = U.num(kind === 'power' ? S.stats.powerDemand : S.stats.waterDemand);
  const live = kind === 'power' ? info.plants : info.sources;
  const items = [];
  const seen = new Set();
  const simKnows = Array.isArray(live);
  // (a plant nothing conducts into still "produces" for its own one-building network: say so)
  if (simKnows) for (const it of live) if (it && it.b) { items.push(isolated(it.b, kind) ? { b: it.b, output: it.output, tag: 'not connected' } : it); seen.add(it.b.id); }
  // every other producer: what it really delivers (0 when unbuilt / unpowered / cut off), with the reason
  for (const b of S.buildings.values()) {
    if (seen.has(b.id)) continue;
    const d = VC.BLD[b.key];
    const out = d && (kind === 'power' ? d.power : d.water);
    if (!(out > 0)) continue;
    let tag = '', output = 0;
    if (b.built < 1) tag = 'building…';
    else if (isolated(b, kind)) tag = 'not connected';
    else if (kind === 'water' && b.powered === false) tag = 'no power';
    else if (!simKnows) output = out; // no sim numbers at all: nominal output
    items.push({ b, output, tag });
  }
  const unserved = kind === 'power' ? info.unpowered : info.unwatered;
  const groups = new Map();
  for (const it of items) {
    if (!it || !it.b) continue;
    let g = groups.get(it.b.key);
    if (!g) groups.set(it.b.key, (g = { key: it.b.key, def: VC.BLD[it.b.key] || { name: it.b.key, icon: '🏭' }, list: [], output: 0, tags: {} }));
    g.list.push(it.b);
    g.output += U.num(it.output);
    if (it.tag) g.tags[it.tag] = (g.tags[it.tag] || 0) + 1;
  }
  const gl = [...groups.values()].sort((a, b) => b.output - a.output);
  return { supply, demand, groups: gl, unserved: typeof unserved === 'number' ? unserved : null, networks: U.num(info.networks), shortage: !!info.shortage };
}

function netSection(kind) {
  const isP = kind === 'power';
  const unit = isP ? ' MW' : ' kL';
  const pill = U.pill('', '');
  const big = U.meter(isP ? 'Demand vs supply' : 'Demand vs supply', { cls: 'big', tip: isP ? 'Electricity demand as a share of generating capacity' : 'Water demand as a share of pumping capacity' });
  const ov = U.overlayBtn(kind, 'Grid');
  const list = h('div', { class: 'pn-net-list' });
  const none = U.empty(isP ? '🔌' : '🚱', isP ? 'No power plants' : 'No water facilities', isP ? 'Build a power plant from the ⚡ Power toolbar.' : 'Build a water pump next to a lake or river from the 💧 Water toolbar.');
  const card = h('div', { class: 'pn-net ' + kind }, h('div', { class: 'pn-net-head' }, h('span', { class: 'pn-net-icon' }, isP ? '⚡' : '💧'), h('span', { class: 'pn-net-title' }, isP ? 'Electricity' : 'Water'), pill, h('span', { class: 'pn-grow' }), ov), big, list, none);
  const cycle = {};
  const row = () => {
    const ic = h('span', { class: 'pn-net-ric' });
    const nm = h('span', { class: 'pn-net-rname' });
    const tag = U.pill('', 'bad');
    const out = h('span', { class: 'pn-net-rout' });
    const fill = h('i');
    const btn = VC.ui.button('', () => {
      const g = el._g;
      if (!g || !g.list.length) return;
      const k = (cycle[g.key] = ((cycle[g.key] || 0) + 1) % g.list.length);
      U.focus(g.list[k]);
    }, { icon: '📍', cls: 'small', tip: 'Focus camera (click again for the next one)' });
    const el = h('div', { class: 'pn-net-row' }, ic, h('div', { class: 'pn-net-rmid' }, h('div', { class: 'pn-net-rtop' }, nm, tag, h('span', { class: 'pn-grow' }), out), h('div', { class: 'pn-net-rbar' }, fill)), btn);
    el.set = (g, total) => {
      el._g = g;
      U.txt(ic, g.def.icon || '🏭');
      U.txt(nm, g.def.name + (g.list.length > 1 ? ' ×' + g.list.length : ''));
      const tt = tagText(g);
      tag.set(tt, /building/.test(tt) && !/power|connected/.test(tt) ? 'muted' : 'bad');
      U.show(tag, !!tt);
      U.txt(out, U.int(g.output) + unit);
      U.css(fill, 'width', (total > 0 ? (g.output / total) * 100 : 0).toFixed(1) + '%');
    };
    return el;
  };
  card.upd = () => {
    const n = netInfo(kind);
    const use = n.supply > 0 ? n.demand / n.supply : n.demand > 0 ? 2 : 0;
    const diff = n.supply - n.demand;
    big.set(Math.min(1, use), U.int(n.demand) + ' / ' + U.int(n.supply) + unit, use > 1 ? '#ff5a6a' : use > 0.9 ? '#ffc83d' : isP ? '#ffd166' : '#4cc9f0');
    if (!n.supply && !n.demand) pill.set('Idle', 'muted');
    else if (!n.supply) pill.set(isP ? 'No power plants' : 'No water supply', 'bad');
    else if (diff >= 0) pill.set('Surplus +' + U.int(diff) + unit, use > 0.9 ? 'warn' : 'good');
    else pill.set('Shortage −' + U.int(Math.max(1, -diff)) + unit, 'bad');
    U.cls(card, 'short', diff < 0);
    let tot = 0;
    for (const g of n.groups) tot += g.output;
    U.keyed(list, n.groups, (g) => g.key, row, (el, g) => el.set(g, tot));
    U.show(none, !n.groups.length);
    ov.sync();
    return { n, use, diff };
  };
  return card;
}

P.defs.utilities = {
  title: 'Utilities',
  icon: '⚡',
  width: 520,
  place: 'left',
  build(p) {
    const pw = netSection('power');
    const wt = netSection('water');
    p.body.append(pw, wt);
    const garb = U.meter('Garbage pickup coverage', { icon: '🗑️', color: U.rampGood, mark: 0.8 });
    const gsub = h('div', { class: 'pn-net-gsub' });
    const gov = U.overlayBtn('garbage', 'Show');
    p.body.appendChild(h('div', { class: 'pn-net garbage' }, h('div', { class: 'pn-net-head' }, h('span', { class: 'pn-net-icon' }, '♻️'), h('span', { class: 'pn-net-title' }, 'Sanitation'), gsub, h('span', { class: 'pn-grow' }), gov), garb));
    const tips = h('div', { class: 'pn-tips' });
    p.body.appendChild(U.sec('Engineer’s notes', tips));
    const tipEl = (t) => h('div', { class: 'pn-tip' }, t.text);
    let iss = null, issAt = -1e9;
    return () => {
      const a = pw.upd(), b = wt.upd();
      // blocked zoned lots (one tile scan; sampled every 2 s, not at the panel's 4 Hz)
      if (performance.now() - issAt > 2000) {
        issAt = performance.now();
        const zs = VC.actions && VC.actions.zoneSupply;
        // lots the grid cannot reach at all (inner lots that get power once the street side is built don't count)
        iss = zs ? { zonedNoPower: zs(0).blocked, zonedNoWater: zs(1).blocked } : U.api('sim', 'issues', [], null);
      }
      const sc = scan();
      const sst = U.api('sim', 'serviceStats', [], null) || {};
      const g = svc('garbage', sst, sc);
      garb.set(g.coverage);
      const lf = U.deptStats().n.waste || 0;
      U.txt(gsub, lf + ' facilit' + (lf === 1 ? 'y' : 'ies'));
      gov.sync();
      const T = [];
      if (a.diff < 0) T.push({ k: 'p1', text: `⚡ Blackouts! Demand exceeds supply by ${U.int(-a.diff)} MW — build another power plant.`, tone: 'bad' });
      else if (a.use > 0.9) T.push({ k: 'p2', text: '⚡ The grid is running above 90% — plan your next power plant soon.', tone: 'warn' });
      if (b.diff < 0) T.push({ k: 'w1', text: `💧 Water shortage of ${U.int(-b.diff)} kL — add pumps or a treatment plant.`, tone: 'bad' });
      else if (b.use > 0.9) T.push({ k: 'w2', text: '💧 Water capacity is nearly exhausted.', tone: 'warn' });
      const noP = a.n.unserved != null ? a.n.unserved : sc.noPower, noW = b.n.unserved != null ? b.n.unserved : sc.noWater;
      if (noP) T.push({ k: 'p3', text: `🔌 ${U.int(noP)} building${noP === 1 ? ' has' : 's have'} no electricity. ${a.diff < 0 ? 'Add generating capacity.' : 'Connect them to the grid with power lines.'}`, tone: 'warn' });
      if (noW) T.push({ k: 'w3', text: `🚱 ${U.int(noW)} building${noW === 1 ? ' lacks' : 's lack'} water service. ${b.diff < 0 ? 'Add pumping capacity.' : 'Water flows along roads from pumps and towers.'}`, tone: 'warn' });
      if (iss && iss.zonedNoPower >= 3 && a.diff >= 0) T.push({ k: 'p5', text: `🔌 ${U.int(iss.zonedNoPower)} zoned lots aren't reached by the grid, so nothing grows there. Power flows along roads, power lines and buildings — not through empty zones.`, tone: 'warn' });
      if (iss && iss.zonedNoWater >= 3 && b.diff >= 0) T.push({ k: 'w5', text: `🚱 ${U.int(iss.zonedNoWater)} medium / high density lots have no water yet — run a road from a powered pump or tower.`, tone: 'warn' });
      for (const g of a.n.groups.concat(b.n.groups)) {
        if (!g.tags['not connected']) continue;
        T.push({ k: 'iso' + g.key, text: `🧩 ${g.def.icon || ''} ${g.def.name}${g.tags['not connected'] > 1 ? ' ×' + g.tags['not connected'] : ''} isn't connected: nothing touching it carries ${g.def.power ? 'power (roads, power lines, buildings)' : 'water (roads, buildings)'}.`, tone: 'bad' });
      }
      if (b.n.groups.some((g) => g.tags['no power'])) T.push({ k: 'w6', text: '🚰 Some pumps / towers have no electricity and pump nothing. Connect them to the powered grid.', tone: 'bad' });
      if (a.n.networks > 1) T.push({ k: 'p4', text: `🧩 Your power grid is split into ${a.n.networks} separate networks. Link them so surplus power can flow where it is needed.`, tone: 'info' });
      if (sc.resPop && g.coverage < 0.5) T.push({ k: 'g1', text: '🗑️ Garbage is piling up — build a landfill or incinerator near your neighbourhoods.', tone: 'warn' });
      if (a.n.groups.some((x) => x.key === 'coal_plant')) T.push({ k: 'c1', text: '🏭 Coal plants pollute heavily. Switch to cleaner energy once it unlocks.', tone: 'info' });
      if (!T.length) T.push({ k: 'ok', text: '✅ All utilities are running smoothly.', tone: 'good' });
      U.keyed(tips, T, (t) => t.k, tipEl, (el, t) => {
        U.txt(el, t.text);
        U.tone(el, t.tone);
      });
    };
  },
};
