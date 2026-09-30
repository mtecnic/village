/*
 * VOXELPOLIS — Inspector ('inspector'), opened by VC.panels.inspect(building | {x, z}) or bus 'select'.
 * Building view: identity header, status pills, construction / occupancy / happiness (+ factor
 * breakdown from VC.sim.buildingInfo), info lines, problems, facility stats for catalog buildings
 * (upkeep, funding, coverage, output, jobs, emissions), local tile values, Focus / Bulldoze / overlay.
 * Tile view: terrain, zone, road, network flags, local values and service coverage from S.maps.
 * Everything refreshes live in place; the window closes when the building is removed (panels.js).
 */
const P = VC.panels, U = P.util, h = VC.h, M = VC.M;
const TERR_NAMES = ['Grass', 'Sand', 'Dirt', 'Rock', 'Snow', 'Meadow'];
const TERR_ICONS = ['🌿', '🏖️', '🟫', '🪨', '❄️', '🌼'];
const ZKEY = { 1: 'R', 2: 'C', 3: 'I' };
const LOCAL = [
  { key: 'landValue', label: 'Land value', icon: '💎', ramp: U.rampValue },
  { key: 'pollution', label: 'Pollution', icon: '🌫️', ramp: U.rampBad },
  { key: 'crime', label: 'Crime', icon: '🦹', ramp: U.rampBad },
  { key: 'noise', label: 'Noise', icon: '🔊', ramp: U.rampBad },
  { key: 'traffic', label: 'Traffic', icon: '🚗', ramp: U.rampBad },
];
const level3 = (v) => (v < 40 ? 'Low' : v < 110 ? 'Moderate' : v < 180 ? 'High' : 'Extreme');

/** Tile-value meters (S.maps) around tile i. Returns {el, set(i)} */
function localBlock(list) {
  const ms = list.map((d) => ({ d, m: U.meter(d.label, { icon: d.icon, small: true, color: d.ramp }) }));
  const el = h('div', { class: 'pn-grid2 pn-insp-local' }, ms.map((x) => x.m));
  el.set = (i) => {
    const S = VC.state;
    for (const x of ms) {
      const map = S.maps[x.d.key];
      const v = map ? map[i] : 0;
      x.m.set(v / 255, map ? Math.round((v / 255) * 100) + '%' : '—');
    }
  };
  return el;
}
function head(icon, color, title, subNodes) {
  const ic = h('div', { class: 'pn-insp-icon' }, icon);
  ic.style.setProperty('--c', color || '#5ad1ff');
  const t = h('div', { class: 'pn-insp-name' }, title);
  const sub = h('div', { class: 'pn-insp-sub' }, subNodes);
  const el = h('div', { class: 'pn-insp-head' }, ic, h('div', { class: 'pn-insp-titles' }, t, sub));
  el.style.setProperty('--c', color || '#5ad1ff');
  el.icon = ic;
  el.titleEl = t;
  el.subEl = sub;
  return el;
}
/** Occupancy capacity of a growable when the sim has not set b.cap yet. */
function growCap(b) {
  if (b.cap > 0) return b.cap;
  const g = VC.GROW[ZKEY[b.zt]];
  const lv = g && g[M.clamp(b.den | 0, 1, 3)];
  return lv ? (lv.cap[M.clamp(b.level | 0, 1, 3) - 1] || 0) * b.w * b.d : 0;
}

/* ---------------- building ---------------- */
function buildBuilding(p, b) {
  const S = VC.state;
  const def = VC.BLD[b.key] || null;
  const grow = b.key === 'grow';
  const rubble = b.key === 'rubble';
  const zone = grow ? VC.ZONES[b.zt] : null;
  const icon = rubble ? '🧱' : grow ? (zone ? zone.icon : '🏠') : def ? def.icon : '🏢';
  const color = rubble ? '#8d8d8d' : grow ? (zone ? zone.color : '#5ad1ff') : '#b388ff';
  const subTxt = h('span');
  const stars = h('span', { class: 'pn-insp-stars' });
  const wealth = h('span', { class: 'pn-insp-wealth' });
  const hd = head(icon, color, '', [subTxt, grow ? stars : null, grow ? wealth : null]);
  p.body.appendChild(hd);

  // status pills
  const pills = {
    build: U.pill('', 'warn'), aband: U.pill('🏚️ Abandoned', 'bad'), fire: U.pill('🔥 On fire!', 'bad'),
    power: U.pill('', ''), water: U.pill('', ''), unique: U.pill('⭐ Landmark', 'info'),
  };
  if (!rubble) p.body.appendChild(h('div', { class: 'pn-pills' }, Object.values(pills)));

  const upd = [];
  // occupancy
  const isR = grow ? b.zt === 1 : def && def.housing > 0;
  const occ = U.meter(isR ? 'Residents' : 'Workers', { icon: isR ? '👪' : '👷', color: grow ? zone && zone.color : '#5ad1ff' });
  // happiness + factors
  const hap = U.meter('Happiness', { icon: '😊', color: U.rampGood });
  const facBox = h('div', { class: 'pn-insp-factors' });
  const wellSec = U.sec('Occupants', occ, hap, facBox);
  if (!rubble) p.body.appendChild(wellSec);
  // info lines & problems (buildingInfo)
  const probBox = h('div', { class: 'pn-insp-problems' });
  const lineBox = h('div', { class: 'pn-insp-lines' });
  const infoSec = U.sec('Details', lineBox);
  p.body.append(probBox, infoSec);

  // facility section for catalog buildings
  let fac = null;
  if (def) {
    fac = {};
    const box = h('div', { class: 'pn-insp-lines' });
    const L = (k, label, icon, tip) => (fac[k] = U.line(label, { icon, tip }));
    box.appendChild(L('upkeep', 'Upkeep', '💸', 'Monthly running cost at the current department funding'));
    box.appendChild(L('fund', 'Department funding', '🏛️'));
    if (def.cover) for (const k in def.cover) {
      const sv = VC.SERVICES.find((s) => s.key === k);
      box.appendChild(U.line((sv ? sv.name : k) + ' radius', { icon: sv ? sv.icon : '📡', value: def.cover[k] + ' tiles' }));
    }
    if (def.power) box.appendChild(L('power', 'Power output', '⚡'));
    if (def.water) box.appendChild(L('water', 'Water output', '💧'));
    if (def.housing) box.appendChild(U.line('Housing capacity', { icon: '🏘️', value: U.int(def.housing) }));
    if (def.income) box.appendChild(U.line('Income', { icon: '💰', value: '+' + U.money(def.income) + '/mo' }));
    if (def.tourism) box.appendChild(U.line('Tourism', { icon: '📸', value: '+' + def.tourism }));
    if (def.happy) box.appendChild(U.line('City happiness', { icon: '😊', value: '+' + (def.happy * 100).toFixed(1) + '%' }));
    if (def.lv) box.appendChild(U.line('Land value effect', { icon: '💎', value: (def.lv > 0 ? '+' : '') + def.lv + ' · r' + (def.lvR || 0) }));
    if (def.pollution) box.appendChild(U.line('Air pollution', { icon: '🏭', value: level3(def.pollution) + ' · r' + (def.pollR || 0) }));
    if (def.noise) box.appendChild(U.line('Noise', { icon: '🔊', value: level3(def.noise) + ' · r' + (def.noiseR || 0) }));
    if (fac.fund) fac.fund.set('');
    p.body.appendChild(U.sec('Facility', box));
    if (def.desc) p.body.appendChild(h('div', { class: 'pn-insp-desc' }, '“' + def.desc + '”'));
  }
  if (rubble) p.body.appendChild(h('div', { class: 'pn-insp-desc' }, 'The remains of a destroyed building. Bulldoze it to free the lot, or wait for crews to clear it.'));

  // local tile values
  const loc = localBlock(LOCAL);
  if (!rubble) p.body.appendChild(U.sec('Neighbourhood', loc));

  // actions
  const ovKey = def ? (def.cover ? Object.keys(def.cover)[0] : def.power ? 'power' : def.water ? 'water' : null) : grow ? 'happiness' : null;
  const ov = ovKey && VC.OVERLAYS.find((o) => o.key === ovKey) ? U.overlayBtn(ovKey, 'Overlay') : null;
  const bull = VC.ui.button('Bulldoze', () => {
    const name = U.safe(() => VC.sim.buildingName(b), 'this building');
    VC.ui.confirm(`Demolish <b>${name}</b>?${def && def.cost ? `<br>Demolition costs about <b>${U.money(def.cost * (VC.C.DEMOLISH_COST || 0.1) * U.safe(() => VC.money.costMul(), 1))}</b>.` : ''}`, () => {
      const r = U.api('actions', 'bulldoze', [b.x, b.z, b.x + b.w - 1, b.z + b.d - 1], null);
      if (!r || r.ok === false) VC.bus.emit('toast', { text: 'Could not bulldoze' + (r && r.reason ? ': ' + r.reason : '.'), type: 'bad', icon: '🚜' });
    }, { title: '🚜 Bulldoze', yes: 'Bulldoze' });
  }, { icon: '🚜', cls: 'small danger' });
  p.body.appendChild(h('div', { class: 'pn-insp-actions' }, VC.ui.button('Focus', () => U.focus(b), { icon: '📍', cls: 'small' }), ov, h('span', { class: 'pn-grow' }), bull));

  const ci = Math.min(S.H - 1, b.z + (b.d >> 1)) * S.W + Math.min(S.W - 1, b.x + (b.w >> 1));
  const factorEl = (f) => U.diverge(f.label, { tip: f.label });
  const lineEl = (l) => U.line(l.label, { icon: l.icon });
  const probEl = () => h('div', { class: 'pn-insp-prob' });

  return () => {
    if (!VC.state.buildings.has(b.id)) return;
    const info = U.api('sim', 'buildingInfo', [b], null) || {};
    const name = info.name || U.safe(() => VC.sim.buildingName(b), null) || (def ? def.name : rubble ? 'Rubble' : 'Building');
    U.txt(hd.titleEl, name);
    if (grow) {
      U.txt(subTxt, info.subtitle || `${VC.DENSITY[b.den] || ''} density ${zone ? zone.name.toLowerCase() : ''} · `);
      U.txt(stars, info.subtitle ? '' : U.stars(b.level));
      U.txt(wealth, info.subtitle ? '' : ' ' + U.wealth(b.wealth));
      U.attr(wealth, 'data-tip', U.WEALTH[M.clamp(b.wealth | 0, 0, 2)]);
    } else if (rubble) U.txt(subTxt, 'Debris');
    else {
      const g = VC.TOOL_GROUPS.find((x) => x.key === def.group);
      const d = VC.DEPARTMENTS.find((x) => x.key === def.dept);
      U.txt(subTxt, info.subtitle || [g && g.name, d && d.name].filter(Boolean).join(' · '));
    }
    // pills
    const building = b.built < 1;
    pills.build.set('🚧 Under construction · ' + Math.round(M.sat(b.built) * 100) + '%', 'warn');
    U.show(pills.build, building);
    U.show(pills.aband, !!b.abandoned);
    U.show(pills.fire, b.fire > 0);
    pills.power.set(b.powered ? '⚡ Powered' : '⚡ No power', b.powered ? 'good' : 'bad');
    pills.water.set(b.watered ? '💧 Water' : '💧 No water', b.watered ? 'good' : 'bad');
    U.show(pills.power, !building);
    U.show(pills.water, !building);
    U.show(pills.unique, !!(def && def.unique));
    // occupancy
    const cap = grow ? growCap(b) : def ? def.housing || def.jobs || b.cap || 0 : 0;
    occ.set(cap > 0 ? U.num(b.pop) / cap : 0, U.int(b.pop) + ' / ' + U.int(cap));
    U.show(occ, cap > 0);
    hap.set(U.num(b.happy, 0.5), U.pct(U.num(b.happy, 0.5)));
    U.show(hap, grow || !!(def && def.housing));
    const factors = Array.isArray(info.factors) ? info.factors.filter((f) => f && f.label) : [];
    U.keyed(facBox, factors, (f) => f.label, factorEl, (el, f) => el.set(U.num(f.value)));
    U.show(wellSec, cap > 0 || factors.length);
    // lines & problems
    const lines = Array.isArray(info.lines) ? info.lines.filter((l) => l && l.label) : [];
    const extra = [{ label: 'Age', icon: '🕰️', value: b.age >= 360 ? (b.age / 360).toFixed(1) + ' years' : b.age >= 30 ? Math.floor(b.age / 30) + ' months' : Math.floor(U.num(b.age)) + ' days' }, { label: 'Footprint', icon: '📐', value: b.w + ' × ' + b.d + ' tiles' }];
    const all = lines.concat(extra.filter((e) => !lines.some((l) => l.label === e.label)));
    U.keyed(lineBox, all, (l) => l.label, lineEl, (el, l) => el.set(l.value != null ? String(l.value) : '', l.cls === 'good' ? 'good' : l.cls === 'bad' ? 'bad' : l.cls === 'warn' ? 'warn' : ''));
    const probs = Array.isArray(info.problems) ? info.problems.filter(Boolean).map(String) : [];
    if (!b.powered && !building && !rubble && !probs.some((x) => /power/i.test(x))) probs.push('No electricity');
    if (!b.watered && !building && !rubble && !probs.some((x) => /water/i.test(x))) probs.push('No water service');
    if (b.abandoned && !probs.some((x) => /abandon/i.test(x))) probs.push('Abandoned — fix its problems or bulldoze it');
    U.keyed(probBox, probs, (x) => x, probEl, (el, x) => U.txt(el, '⚠️ ' + x));
    U.show(probBox, probs.length);
    // facility
    if (fac) {
      const f = S.budget[def.dept] != null ? S.budget[def.dept] : 1;
      fac.upkeep.set(U.money((def.upkeep || 0) * f * U.safe(() => VC.money.costMul(), 1)) + '/mo');
      fac.fund.set(Math.round(f * 100) + '%', f < 0.5 ? 'bad' : f < 0.8 ? 'warn' : '');
      if (fac.power || fac.water) {
        const key = fac.power ? 'powerInfo' : 'waterInfo';
        const inf = U.api('sim', key, [], null) || {};
        const arr = (fac.power ? inf.plants : inf.sources) || [];
        const it = Array.isArray(arr) ? arr.find((x) => x && x.b && x.b.id === b.id) : null;
        const out = it ? U.num(it.output) : building ? 0 : fac.power ? def.power : def.water;
        (fac.power || fac.water).set(U.int(out) + (fac.power ? ' MW' : ' kL') + (it || building ? '' : ' (nominal)'));
      }
    }
    loc.set(ci);
    if (ov) ov.sync();
  };
}

/* ---------------- tile ---------------- */
function buildTile(p, t) {
  const S = VC.state, W = VC.world;
  const x = M.clamp(t.x | 0, 0, S.W - 1), z = M.clamp(t.z | 0, 0, S.H - 1);
  const i = z * S.W + x;
  const lvl = S.height[i];
  const water = lvl < VC.C.SEA;
  const road = S.road[i];
  const zc = S.zone[i];
  const zt = VC.ztype(zc), zone = VC.ZONES[zt];
  const terr = S.terr[i];
  let icon = TERR_ICONS[terr] || '🟩', color = '#80ed99', title = TERR_NAMES[terr] || 'Land';
  if (water) { icon = '🌊'; color = '#4cc9f0'; title = 'Water'; }
  else if (road) { icon = VC.ROADS[road] ? VC.ROADS[road].icon : '🛣️'; color = '#a9b3c7'; title = VC.ROADS[road] ? VC.ROADS[road].name : 'Road'; }
  else if (zone) { icon = zone.icon; color = zone.color; title = VC.DENSITY[VC.zden(zc)] + ' density ' + zone.name.toLowerCase() + ' zone'; }
  else if (S.trees[i]) { icon = '🌲'; color = '#57cc99'; title = 'Woodland'; }
  const hd = head(icon, color, title, ['Tile ' + x + ', ' + z]);
  p.body.appendChild(hd);
  const pills = { power: U.pill('', ''), water: U.pill('', ''), access: U.pill('', '') };
  if (!water) p.body.appendChild(h('div', { class: 'pn-pills' }, Object.values(pills)));
  const lines = h('div', { class: 'pn-insp-lines' });
  const L = (label, icon, value) => lines.appendChild(U.line(label, { icon, value }));
  L('Terrain', TERR_ICONS[terr] || '🟩', water ? 'Water' : TERR_NAMES[terr] || '—');
  L('Elevation', '⛰️', water ? (VC.C.SEA - lvl) * 2 + ' m deep' : (lvl - VC.C.SEA) * 2 + ' m above sea level');
  if (!water) {
    L('Zoning', zone ? zone.icon : '🚫', zone ? VC.DENSITY[VC.zden(zc)] + ' ' + zone.name : 'Unzoned');
    if (road) L('Road', '🛣️', VC.ROADS[road] ? VC.ROADS[road].name : 'Road');
    L('Trees', '🌳', S.trees[i] ? ['', 'Sparse', 'Wooded', 'Dense forest'][Math.min(3, S.trees[i])] : 'None');
    if (S.pline[i]) L('Power line', '🔌', 'Yes');
  }
  p.body.appendChild(U.sec('Tile', lines));
  const loc = localBlock(LOCAL);
  p.body.appendChild(U.sec('Local conditions', loc));
  const cov = localBlock(VC.SERVICES.map((s) => ({ key: s.key, label: s.name, icon: s.icon, ramp: U.rampGood })));
  p.body.appendChild(U.sec('Service coverage', cov));
  p.body.appendChild(h('div', { class: 'pn-insp-actions' }, VC.ui.button('Focus', () => U.focus({ x, z }), { icon: '📍', cls: 'small' }), U.overlayBtn('landValue', 'Land value')));
  return () => {
    const fl = S.flags[i], F = VC.F;
    pills.power.set(fl & F.POWER ? '⚡ Powered' : fl & F.POWERNET ? '⚡ Grid (no supply)' : '⚡ No power', fl & F.POWER ? 'good' : fl & F.POWERNET ? 'warn' : 'muted');
    pills.water.set(fl & F.WATER ? '💧 Water' : '💧 No water', fl & F.WATER ? 'good' : 'muted');
    pills.access.set(fl & F.ACCESS || road ? '🛣️ Road access' : '🛣️ No road access', fl & F.ACCESS || road ? 'good' : 'warn');
    loc.set(i);
    cov.set(i);
    const b = W.buildingAt(x, z);
    if (b && b !== t) P.inspect(b); // something got built here: follow it
  };
}

P.defs.inspector = {
  title: 'Inspector',
  icon: '🔍',
  width: 380,
  place: 'right',
  build(p) {
    const t = p.target;
    if (!t) return null;
    if (t.id != null) return buildBuilding(p, t);
    return buildTile(p, t);
  },
};
