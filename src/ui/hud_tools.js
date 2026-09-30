/*
 * VOXELPOLIS — HUD toolbar (bottom centre) + tool palettes.
 *   Select/inspect button + one button per VC.TOOL_GROUPS entry (hotkey badges). Clicking a group opens a
 *   palette flyout above it with tool cards from VC.tools.list(group) — or fallback descriptors built from
 *   the data catalog while the tools module returns nothing — each with icon, name, cost, footprint, lock
 *   overlay and a rich tooltip (upkeep, outputs, jobs, coverage, pollution, land value…). Zoning uses a
 *   R/C/I x density matrix. Current tool is highlighted (bus 'tool'); bus 'toolGroup' {key} opens a
 *   palette (keyboard); an "active tool" chip shows hints + cancel while building (it fades out while a drag
 *   is in progress so the cursor label never lands on it).
 *   ZONE DEMAND: every zone card and row carries a demand arrow (▲▲ / ▲ / – / ▼ from S.demand, refreshed with
 *   the palette's 1 s timer) and the card tooltip lists the strongest demand factors (VC.sim.demandFactors).
 *   LAYERING: while a palette is open the toolbar wrap is raised above the windows layer (.pal-open), so a
 *   palette opened over the Budget / Policies window is never hidden behind it.
 * API (on VC.hud): openPalette(group, {highlight: toolKey}?), closePalette(), paletteOpen() -> group|null,
 *   toolList(group), describeTool(t), toolGroupOf(key), toolTipHtml(t)
 */
const h = VC.h;
const TB = { groups: new Map(), pal: null, palGroup: null, palSig: '', keyGroup: new Map() };
let palTimer = 0;

/* ---------------- descriptors ---------------- */
function costMul() {
  try { return VC.state && VC.money ? VC.money.costMul() : 1; } catch (e) { return 1; }
}
function unlocked(key) {
  try { return !VC.state || VC.world.isUnlocked(key); } catch (e) { return true; }
}
function kindOf(key) {
  if (!key) return 'select';
  if (key.startsWith('bld:')) return 'bld';
  if (key.startsWith('road_')) return 'road';
  if (key.startsWith('zone_') || key === 'dezone') return 'zone';
  if (key.startsWith('terrain_')) return 'terrain';
  return key; // trees, pline, bulldoze, select
}
/** Fallback tool descriptors from data defs (used while VC.tools.list returns []). */
function fallbackList(group) {
  const C = VC.C, mul = costMul(), out = [];
  const add = (o) => out.push(Object.assign({ group, locked: false, unlock: 0 }, o));
  if (group === 'roads') {
    for (const t of [1, 2, 3]) {
      const r = VC.ROADS[t];
      add({ key: 'road_' + r.key, name: r.name, icon: r.icon, cost: r.cost * mul, costUnit: '/tile', desc: r.desc, unlock: r.unlock, locked: !unlocked(r.key), road: r });
    }
    return out;
  }
  if (group === 'zones') {
    for (const z of VC.ZONE_TOOLS) add({ key: z.key, name: z.name, icon: z.icon, cost: z.cost * mul, costUnit: '/tile', unlock: z.unlock, locked: !unlocked(z.key), desc: zoneDesc(z.type, z.den) });
    add({ key: 'dezone', name: 'Dezone', icon: '🧽', cost: 0, desc: 'Removes zoning. Buildings on dezoned land are eventually abandoned.' });
    return out;
  }
  if (group === 'terrain') {
    add({ key: 'terrain_raise', name: 'Raise Land', icon: '⛰️', cost: C.TERRAFORM_COST * mul, costUnit: '/level', desc: 'Click or hold to raise the ground under the brush.' });
    add({ key: 'terrain_lower', name: 'Lower Land', icon: '🕳️', cost: C.TERRAFORM_COST * mul, costUnit: '/level', desc: 'Click or hold to dig down. Dig below sea level to make water.' });
    add({ key: 'terrain_level', name: 'Level Land', icon: '📏', cost: C.TERRAFORM_COST * mul, costUnit: '/level', desc: 'Flattens the ground to the height of the first tile you click.' });
    return out;
  }
  if (group === 'bulldoze') {
    add({ key: 'bulldoze', name: 'Bulldozer', icon: '🚜', cost: 0, desc: 'Demolish buildings, roads, power lines and trees. Drag to clear an area.' });
    return out;
  }
  if (group === 'power') add({ key: 'pline', name: 'Power Line', icon: '🔌', cost: C.PLINE_COST * mul, costUnit: '/tile', desc: 'Carries electricity across gaps between buildings and zones.' });
  for (const d of VC.CATALOG) if (d.group === group) add({ key: 'bld:' + d.key, name: d.name, icon: d.icon, cost: d.cost * mul, desc: d.desc, unlock: d.unlock || 0, locked: !unlocked(d.key) });
  if (group === 'parks') add({ key: 'trees', name: 'Plant Trees', icon: '🌲', cost: C.TREE_COST * mul, costUnit: '/tree', desc: 'Trees raise land value and soak up pollution. Drag to plant a forest.' });
  return out;
}
function zoneDesc(t, d) {
  const z = VC.ZONES[t];
  const what = { 1: 'homes', 2: 'shops and offices', 3: 'factories and warehouses' }[t];
  const den = { 1: 'Small, low-rise', 2: 'Mid-rise', 3: 'Dense high-rise' }[d];
  // same rule as the sim (growReason): low density needs a street + power; medium / high also need water
  return `${den} ${what}. Needs a street within ${VC.C.ROAD_ACCESS} tiles and power${d >= 2 ? ', plus water' : ''} to grow.` + (z && d === 3 && t === 1 ? ' Towers!' : '');
}
/** Policy active? (numeric levels; VC.econ.isPolicyOn when present, else a truthy / > 0 S.policies value). */
function policyOn(key) {
  try {
    if (VC.actions && VC.actions.policyOn) return VC.actions.policyOn(key);
    if (VC.econ && VC.econ.isPolicyOn) return !!VC.econ.isPolicyOn(key);
  } catch (e) { /* fall through */ }
  const v = VC.state && VC.state.policies ? VC.state.policies[key] : 0;
  return v === true || v > 0;
}
/* ---------------- zone demand ---------------- */
const ZKEY = { 1: 'R', 2: 'C', 3: 'I' };
/** Demand arrow for a zone type: {t: '▲▲'|'▲'|'–'|'▼', cls, word, v (-1..1)}. */
function demandArrow(zt) {
  const S = VC.state;
  const v = S && S.demand ? VC.M.clamp(+S.demand[ZKEY[zt]] || 0, -1, 1) : 0;
  if (v > 0.5) return { t: '▲▲', cls: 'up2', word: 'Strong demand', v };
  if (v > 0.12) return { t: '▲', cls: 'up', word: 'Some demand', v };
  if (v < -0.12) return { t: '▼', cls: 'down', word: 'Oversupplied', v };
  return { t: '–', cls: 'flat', word: 'Little demand', v };
}
/** Strongest demand factors of a zone type: [{label, value}] (up to n, by magnitude). */
function topFactors(zt, n) {
  let f = null;
  try { f = VC.sim && VC.sim.demandFactors ? VC.sim.demandFactors() : null; } catch (e) { f = null; }
  const list = f && Array.isArray(f[ZKEY[zt]]) ? f[ZKEY[zt]].slice() : [];
  return list.filter((x) => x && Math.abs(+x.value || 0) > 0.01).sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, n);
}
/** Refreshes the demand arrows of an open zones palette in place. */
function refreshDemand() {
  if (!TB.pal) return;
  for (const el of TB.pal.querySelectorAll('[data-dem]')) {
    const a = demandArrow(+el.dataset.dem);
    if (el._t !== a.t) { el._t = a.t; el.textContent = a.t; }
    if (el._c !== a.cls) { if (el._c) el.classList.remove(el._c); el.classList.add(a.cls); el._c = a.cls; }
  }
}
/** Tool list for a group: VC.tools.list(group) if it returns anything, else fallback descriptors. */
function toolList(group) {
  let list = [];
  try { list = (VC.tools && VC.tools.list && VC.tools.list(group)) || []; } catch (e) { list = []; }
  if (!list.length) list = fallbackList(group);
  const out = list.map(describeTool);
  for (const t of out) TB.keyGroup.set(t.key, group);
  return out;
}
/** Normalises a descriptor and attaches the catalog def for 'bld:' keys. */
function describeTool(t) {
  const d = t.key && t.key.startsWith('bld:') ? VC.BLD[t.key.slice(4)] : null;
  const o = Object.assign({}, t);
  o.kind = kindOf(o.key);
  o.def = d || o.def || null;
  if (d) {
    o.name = o.name || d.name;
    o.icon = o.icon || d.icon;
    o.desc = o.desc || d.desc;
    if (o.cost == null) o.cost = d.cost * costMul();
    if (o.unlock == null) o.unlock = d.unlock || 0;
    if (d.unique && VC.state) {
      try { o.built = VC.world.count(d.key) > 0; } catch (e) { o.built = false; }
    }
    if (d.requiresPolicy && VC.state && !policyOn(d.requiresPolicy)) o.needsPolicy = d.requiresPolicy;
  }
  if (o.kind === 'road' && !o.road) o.road = Object.values(VC.ROADS).find((r) => 'road_' + r.key === o.key) || null;
  if (o.kind === 'zone') {
    const m = /^zone_([rci])([123])$/.exec(o.key);
    if (m) { o.zt = { r: 1, c: 2, i: 3 }[m[1]]; o.den = +m[2]; }
  }
  if (!o.costUnit) o.costUnit = { road: '/tile', zone: '/tile', terrain: '/level', trees: '/tree', pline: '/tile' }[o.kind] || '';
  o.icon = o.icon || '🔧';
  o.name = o.name || o.key;
  return o;
}
function toolGroupOf(key) {
  if (!key || key === 'select') return null;
  if (TB.keyGroup.has(key)) return TB.keyGroup.get(key);
  const k = kindOf(key);
  if (k === 'bld') { const d = VC.BLD[key.slice(4)]; return d ? d.group : null; }
  return { road: 'roads', zone: 'zones', terrain: 'terrain', pline: 'power', trees: 'parks', bulldoze: 'bulldoze' }[k] || null;
}
function costText(t) {
  if (VC.state && VC.state.sandbox) return 'Free';
  if (!t.cost) return 'Free';
  return VC.fmt.money(t.cost) + (t.costUnit || '');
}
function levelWord(v) {
  return v >= 160 ? 'High' : v >= 80 ? 'Medium' : 'Low';
}
const VARIABLE_POWER = { wind_turbine: 'wind', solar_farm: 'sun' };
const SERVICE_ICON = { police: '🚓', fire: '🚒', health: '🏥', edu: '🎓', park: '🌳', transit: '🚌', garbage: '♻️' };
const SERVICE_NAME = { police: 'Police', fire: 'Fire', health: 'Health', edu: 'Education', park: 'Leisure', transit: 'Transit', garbage: 'Garbage' };
function toolTipHtml(t) {
  const esc = VC.ui.esc, fmt = VC.fmt, mul = costMul();
  const d = t.def;
  const row = (l, v, cls) => `<span>${l}</span><b${cls ? ` class="${cls}"` : ''}>${v}</b>`;
  let s = `<div class="tt-head"><span class="tt-icon">${t.icon}</span>${esc(t.name)}</div>`;
  if (t.desc) s += `<div class="tt-desc">${esc(t.desc)}</div>`;
  s += '<div class="tt-grid">' + row('💵 Cost', costText(t));
  if (d) {
    s += row('📐 Size', `${d.size[0]}×${d.size[1]} tiles`);
    if (d.upkeep) s += row('🔧 Upkeep', fmt.money(d.upkeep * (mul || 1)) + '/mo', 'warn');
    // wind and sun vary: the catalog output is the best case
    if (d.power) s += row('⚡ Power', (VARIABLE_POWER[d.key] ? 'up to ' : '+') + fmt.num(d.power) + ' MW' + (VARIABLE_POWER[d.key] ? ' (' + VARIABLE_POWER[d.key] + ')' : ''), 'good');
    if (d.water) s += row('💧 Water', '+' + fmt.num(d.water) + ' kL', 'good');
    if (d.jobs) s += row('👷 Jobs', fmt.num(d.jobs));
    if (d.housing) s += row('🏠 Residents', fmt.num(d.housing), 'good');
    if (d.cover) for (const k in d.cover) s += row(`${SERVICE_ICON[k] || '📡'} ${SERVICE_NAME[k] || k} radius`, d.cover[k] + ' tiles', 'good');
    if (d.pollution) s += row('🌫️ Pollution', levelWord(d.pollution), 'bad');
    if (d.noise) s += row('🔊 Noise', levelWord(d.noise), 'warn');
    if (d.lv) s += row('💎 Land value', (d.lv > 0 ? '+' : '') + d.lv, d.lv > 0 ? 'good' : 'bad');
    if (d.happy) s += row('😊 Happiness', '+' + (d.happy * 100).toFixed(1) + '%', 'good');
    if (d.tourism) s += row('📸 Tourism', '+' + d.tourism, 'good');
    if (d.income) s += row('💰 Income', '+' + fmt.money(d.income) + '/mo', 'good');
  } else if (t.road) {
    s += row('🔧 Upkeep', '$' + t.road.upkeep + '/tile/mo', 'warn');
    s += row('🚗 Capacity', fmt.num(t.road.capacity) + ' cars');
    s += row('💨 Speed', '×' + t.road.speed);
    if (!t.road.access) s += row('🏘️ Zone access', 'No', 'bad');
  } else if (t.kind === 'zone' && t.zt) {
    const g = VC.GROW[VC.ZONES[t.zt].key][t.den];
    if (g) s += row(t.zt === 1 ? '🏠 Residents/tile' : '👷 Jobs/tile', g.cap[0] + '–' + g.cap[2]);
    if (VC.state) {
      const a = demandArrow(t.zt);
      s += row('📊 Demand', `${a.t} ${a.word} (${a.v >= 0 ? '+' : '−'}${Math.round(Math.abs(a.v) * 100)})`, a.v > 0.12 ? 'good' : a.v < -0.12 ? 'bad' : '');
    }
  }
  s += '</div>';
  if (t.kind === 'zone' && t.zt && VC.state) {
    const f = topFactors(t.zt, 2);
    if (f.length) s += '<div class="tt-foot">' + f.map((x) => `${x.value >= 0 ? '▲' : '▼'} ${esc(x.label)}`).join(' · ') + '</div>';
  }
  if (d && d.needsWater) s += '<div class="tt-foot">🌊 Must be placed next to water.</div>';
  if (d && d.unique) s += `<div class="tt-foot">⭐ Unique — one per city.${t.built ? ' <b>Already built.</b>' : ''}</div>`;
  if (t.needsPolicy) { const p = VC.POLICY[t.needsPolicy]; s += `<div class="tt-lock">📜 Requires the “${esc(p ? p.name : t.needsPolicy)}” policy</div>`; }
  if (t.locked) s += `<div class="tt-lock">🔒 Unlocks at ${fmt.num(t.unlock || 0)} population</div>`;
  return s;
}

/* ---------------- toolbar ---------------- */
const SELECT_SVG = '<svg viewBox="0 0 20 20"><path d="M4.2 2.6 15.4 10l-5 .9 2.9 5.6-2.2 1.1-2.9-5.6-3.6 3.5z" fill="currentColor" stroke="rgba(0,0,0,.35)" stroke-width=".6" stroke-linejoin="round"/></svg>';
function buildToolbar(root) {
  const ui = VC.ui;
  TB.bar = h('div', { class: 'hud-toolbar pe' });
  TB.select = h('button', { class: 'tb-tool tb-select', 'aria-label': 'Select and inspect', 'data-tip': '<b>Select & inspect</b> <kbd>Esc</kbd><br><span style="color:var(--text3)">Click buildings to see their details.</span>', html: SELECT_SVG, onclick: () => { VC.bus.emit('sfx', { name: 'click' }); closePalette(); selectTool('select'); } });
  TB.bar.appendChild(TB.select);
  TB.bar.appendChild(h('div', { class: 'tbt-sep' }));
  for (const g of VC.TOOL_GROUPS) {
    const b = h('button', { class: 'tb-tool tb-g-' + g.key, 'aria-label': g.name, 'data-tip': `<b>${g.name}</b> <kbd>${g.hotkey}</kbd>`, onclick: () => { VC.bus.emit('sfx', { name: 'click' }); groupClick(g.key); } }, h('span', { class: 'tbt-icon' }, g.icon), h('span', { class: 'tbt-key' }, g.hotkey));
    TB.groups.set(g.key, b);
    if (g.key === 'bulldoze') TB.bar.appendChild(h('div', { class: 'tbt-sep' }));
    TB.bar.appendChild(b);
  }
  TB.chip = h('div', { class: 'tool-chip pe' });
  TB.wrap = h('div', { class: 'hud-toolwrap' }, h('div', { class: 'tb-anchor' }, TB.chip, TB.bar));
  root.appendChild(TB.wrap);
  // outside click closes the palette (clicks on the toolbar are handled by the buttons)
  document.addEventListener('pointerdown', (e) => {
    if (!TB.pal || !TB.palGroup) return;
    if (TB.pal.contains(e.target) || TB.bar.contains(e.target)) return;
    closePalette();
  }, true);
  // Esc closes an open palette before anything else handles the key
  window.addEventListener('keydown', (e) => {
    if ((e.code === 'Escape' || e.key === 'Escape') && TB.palGroup) {
      closePalette();
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);
}
function groupClick(key) {
  if (key === 'bulldoze') {
    closePalette();
    const list = toolList('bulldoze');
    const k = (list[0] && list[0].key) || 'bulldoze';
    selectTool(VC.tools && VC.tools.current === k ? 'select' : k);
    return;
  }
  if (TB.palGroup === key) closePalette();
  else openPalette(key);
}
function selectTool(key) {
  if (!VC.tools || !VC.tools.select) return;
  try { VC.tools.select(key); } catch (e) { console.error('[hud] tools.select', e); }
  refreshToolHighlight();
}

/* ---------------- palette ---------------- */
/** Opens a group's palette. opts.highlight: a tool key whose card pulses (tutorial "Show me"). */
function openPalette(group, opts) {
  if (!VC.hud.visible || !TB.bar) return;
  const g = VC.TOOL_GROUPS.find((x) => x.key === group);
  if (!g) return;
  if (group === 'bulldoze') { groupClick('bulldoze'); return; }
  VC.ui.closePopovers && VC.ui.closePopovers();
  const wasOpen = !!TB.palGroup;
  if (TB.pal) TB.pal.remove();
  TB.palGroup = group;
  TB.hl = (opts && opts.highlight) || null;
  const list = toolList(group);
  TB.palSig = sigOf(list);
  TB.pal = renderPalette(g, list);
  if (wasOpen) TB.pal.classList.add('instant');
  TB.bar.parentNode.appendChild(TB.pal);
  TB.wrap.classList.add('pal-open'); // above the windows layer while open
  positionPalette();
  refreshDemand();
  for (const [k, b] of TB.groups) b.classList.toggle('open', k === group);
  refreshChip();
  clearInterval(palTimer);
  palTimer = setInterval(refreshPalette, 1000);
}
function closePalette() {
  if (!TB.palGroup) return;
  TB.palGroup = null;
  TB.hl = null;
  clearInterval(palTimer);
  const p = TB.pal;
  TB.pal = null;
  if (p) {
    p.classList.add('out');
    setTimeout(() => {
      p.remove();
      if (!TB.palGroup && TB.wrap) TB.wrap.classList.remove('pal-open');
    }, 160);
  } else if (TB.wrap) TB.wrap.classList.remove('pal-open');
  for (const b of TB.groups.values()) b.classList.remove('open');
  refreshChip();
}
function sigOf(list) {
  return list.map((t) => t.key + (t.locked ? 'L' : '') + (t.built ? 'B' : '') + (t.needsPolicy ? 'P' : '') + Math.round(t.cost || 0)).join(',');
}
/** Re-renders the open palette when unlocks / costs / uniques change. */
function refreshPalette() {
  if (!TB.palGroup) return;
  refreshDemand();
  const list = toolList(TB.palGroup);
  const sig = sigOf(list);
  if (sig === TB.palSig) return;
  const g = VC.TOOL_GROUPS.find((x) => x.key === TB.palGroup);
  TB.palSig = sig;
  const old = TB.pal;
  TB.pal = renderPalette(g, list);
  TB.pal.classList.add('instant');
  old.replaceWith(TB.pal);
  positionPalette();
  refreshDemand();
}
/** Tool card. disp = optional {icon (string|Node), name} display overrides. */
function toolCard(t, cls, disp) {
  const cur = VC.tools && VC.tools.current;
  const blocked = t.locked || t.needsPolicy || t.built;
  const card = h('button', { class: 'tcard ' + (cls || '') + (t.key === cur ? ' active' : '') + (blocked ? ' blocked' : '') + (t.locked ? ' locked' : ''), 'data-key': t.key, 'data-tip': '1', onclick: () => pickTool(t, card) });
  card._tip = () => toolTipHtml(t);
  card.appendChild(h('span', { class: 'tc-icon' }, disp && disp.icon != null ? disp.icon : t.icon));
  card.appendChild(h('span', { class: 'tc-name' }, (disp && disp.name) || t.name));
  const meta = h('span', { class: 'tc-meta' }, h('span', { class: 'tc-cost' }, costText(t)));
  if (t.def) meta.appendChild(h('span', { class: 'tc-size' }, t.def.size[0] + '×' + t.def.size[1]));
  card.appendChild(meta);
  if (t.locked) card.appendChild(h('span', { class: 'tc-lock' }, '🔒 ' + VC.fmt.num(t.unlock || 0) + ' pop'));
  else if (t.needsPolicy) card.appendChild(h('span', { class: 'tc-lock' }, '📜 Policy'));
  else if (t.built) card.appendChild(h('span', { class: 'tc-badge' }, '✔ Built'));
  if (t.def && t.def.unique && !t.built && !t.locked) card.appendChild(h('span', { class: 'tc-star', 'data-tip': 'Unique' }, '⭐'));
  if (t.kind === 'zone' && t.zt && !t.locked) card.appendChild(h('span', { class: 'tc-dem', 'data-dem': String(t.zt) }));
  if (TB.hl && t.key === TB.hl) card.classList.add('hl');
  return card;
}
function pickTool(t, card) {
  if (t.locked || t.needsPolicy || t.built) {
    VC.ui.flash(card, 'shake');
    VC.bus.emit('sfx', { name: 'error' });
    const esc = VC.ui.esc, nm = esc(t.name);
    const msg = t.locked ? `🔒 <b>${nm}</b> unlocks at <b>${VC.fmt.num(t.unlock || 0)}</b> population.` : t.needsPolicy ? `📜 <b>${nm}</b> requires the “${esc((VC.POLICY[t.needsPolicy] || {}).name || t.needsPolicy)}” policy.` : `⭐ <b>${nm}</b> is unique and already built.`;
    VC.ui.toast(msg, { type: 'warn', icon: '🔒' });
    return;
  }
  VC.bus.emit('sfx', { name: 'click' });
  selectTool(t.key);
  closePalette();
}
function renderPalette(g, list) {
  const head = h('div', { class: 'pal-head' }, h('span', { class: 'pal-icon' }, g.icon), h('span', { class: 'pal-title' }, g.name), h('span', { class: 'pal-count' }, list.length + (list.length === 1 ? ' tool' : ' tools')), h('button', { class: 'win-btn pal-close', title: 'Close (Esc)', onclick: closePalette }, '×'));
  let body;
  const zones = list.filter((t) => t.kind === 'zone' && t.zt);
  if (g.key === 'zones' && zones.length === 9) {
    // R/C/I x density matrix (+ dezone and any extra zone tools in a side column)
    body = h('div', { class: 'pal-zones' });
    const rest = list.filter((t) => !(t.kind === 'zone' && t.zt));
    for (const zt of [1, 2, 3]) {
      const z = VC.ZONES[zt];
      body.appendChild(h('span', { class: 'pz-rowh', style: { color: z.color } }, h('b', null, z.icon), z.name, h('i', { class: 'pz-dem', 'data-dem': String(zt) })));
      for (const d of [1, 2, 3]) {
        const t = zones.find((x) => x.zt === zt && x.den === d);
        const bars = h('span', { class: 'zden d' + d }, h('i'), h('i'), h('i'));
        const c = toolCard(t, 'zc', { icon: bars, name: VC.DENSITY[d] });
        c.style.setProperty('--zc', z.color);
        body.appendChild(c);
      }
    }
    if (rest.length) body.appendChild(h('div', { class: 'pz-side' }, rest.map((t) => toolCard(t, 'zc-extra'))));
  } else {
    // balanced rows: 7 tools -> 4 + 3 rather than 6 + 1
    const rows = Math.ceil(list.length / 6), cols = Math.max(1, Math.ceil(list.length / rows));
    body = h('div', { class: 'pal-grid', style: { maxWidth: cols * 108 + (cols - 1) * 7 + 'px' } }, list.map((t) => toolCard(t)));
  }
  const pal = h('div', { class: 'hud-palette pe palette-' + g.key }, head, body, h('i', { class: 'pal-notch' }));
  pal.setAttribute('aria-label', g.name); // attribute text: no HTML escaping
  return pal;
}
/** Centres the palette over its group button, clamped to the viewport (toolbar-local coordinates). */
function positionPalette() {
  const pal = TB.pal, b = TB.groups.get(TB.palGroup);
  if (!pal || !b) return;
  const anchor = TB.bar.parentNode;
  const s = VC.ui.scale(), W = window.innerWidth;
  const ar = anchor.getBoundingClientRect();
  const bc = b.offsetLeft + TB.bar.offsetLeft + b.offsetWidth / 2;
  const w = pal.offsetWidth;
  // keep clear of the minimap (left) and the dock (right) when there is room, else use the full width
  const bl = VC.hud.root.querySelector('.hud-bl'), dock = VC.hud.root.querySelector('.hud-dock');
  let lo = bl ? 10 + bl.offsetWidth * s + 8 : 10;
  let hi = dock ? W - 10 - dock.offsetWidth * s - 8 : W - 10;
  if (hi - lo < w * s) { lo = 10; hi = W - 10; }
  const minX = (lo - ar.left) / s, maxX = (hi - ar.left) / s - w;
  const x = VC.M.clamp(bc - w / 2, minX, Math.max(minX, maxX));
  pal.style.left = Math.round(x) + 'px';
  const notch = pal.querySelector('.pal-notch');
  if (notch) notch.style.left = Math.round(VC.M.clamp(bc - x, 18, w - 18)) + 'px';
}

/**
 * Keeps the toolbar clear of the minimap: centred on screen when there is room, otherwise centred in the
 * free space between minimap and dock, and as a last resort compacted (smaller buttons).
 */
function layoutToolbar() {
  const wrap = TB.wrap;
  if (!wrap || !VC.hud.visible) return;
  const bl = VC.hud.root.querySelector('.hud-bl');
  if (!bl) return;
  // layout math (offset sizes x scale) instead of rects: rects include the slide-in transforms
  const s = VC.ui.scale(), W = window.innerWidth;
  const blRight = 10 + bl.offsetWidth * s + 8;
  const padR = 64 * s;
  const leftOf = (padL) => padL + (W - padL - (padL ? padR : 0)) / 2 - (TB.bar.offsetWidth * s) / 2;
  TB.bar.classList.remove('compact');
  let padL = 0;
  if (leftOf(0) < blRight) {
    padL = blRight;
    if (leftOf(padL) < blRight) TB.bar.classList.add('compact');
  }
  wrap.style.paddingLeft = padL ? Math.round(padL) + 'px' : '';
  wrap.style.paddingRight = padL ? Math.round(padR) + 'px' : '';
}

/* ---------------- highlight + active tool chip ---------------- */
function refreshToolHighlight() {
  const cur = (VC.tools && VC.tools.current) || 'select';
  const grp = toolGroupOf(cur);
  TB.select.classList.toggle('current', cur === 'select');
  for (const [k, b] of TB.groups) b.classList.toggle('current', k === grp);
  if (TB.pal) for (const c of TB.pal.querySelectorAll('.tcard')) c.classList.toggle('active', c.dataset.key === cur);
  refreshChip();
}
const CHIP_HINTS = {
  road: 'Click & drag to build',
  zone: 'Drag a rectangle to paint zones',
  bld: '<kbd>R</kbd> rotate · click to place',
  terrain: 'Click or hold to sculpt',
  trees: 'Drag to plant trees',
  pline: 'Drag to lay power lines',
  bulldoze: 'Click or drag to demolish',
};
function refreshChip() {
  const chip = TB.chip;
  if (!chip) return;
  const cur = (VC.tools && VC.tools.current) || 'select';
  if (cur === 'select' || TB.palGroup) { chip.classList.remove('show'); return; }
  if (chip.dataset.key === cur && chip.classList.contains('show')) return;
  chip.dataset.key = cur;
  const grp = toolGroupOf(cur);
  let t = null;
  if (grp) t = toolList(grp).find((x) => x.key === cur);
  t = t || describeTool({ key: cur, name: cur });
  const hint = CHIP_HINTS[t.kind] || '';
  chip.innerHTML = '';
  chip.append(
    h('span', { class: 'tch-icon' }, t.icon),
    h('span', { class: 'tch-text' }, h('b', null, t.name), h('span', { class: 'tch-sub', html: (t.cost ? costText(t) + ' · ' : '') + hint + ' · <kbd>Esc</kbd> done' })),
    h('button', { class: 'win-btn tch-x', title: 'Stop using this tool', onclick: () => { VC.bus.emit('sfx', { name: 'click' }); selectTool('select'); } }, '×')
  );
  chip.classList.toggle('danger', t.kind === 'bulldoze');
  chip.classList.remove('show');
  void chip.offsetWidth;
  chip.classList.add('show');
}

VC.hud.register({
  name: 'toolbar',
  order: 10,
  init(root) {
    buildToolbar(root);
    VC.bus.on('tool', refreshToolHighlight);
    VC.bus.on('toolGroup', (e) => {
      if (!e || !e.key || !VC.hud.visible || (VC.menu && VC.menu.active)) return;
      if (VC.hud.uiHidden && VC.hud.revealUI) VC.hud.revealUI(); // never open a palette invisibly
      if (TB.palGroup === e.key) closePalette();
      else openPalette(e.key);
    });
    VC.bus.on('settings', () => { layoutToolbar(); if (TB.palGroup) positionPalette(); });
    window.addEventListener('resize', () => { layoutToolbar(); if (TB.palGroup) positionPalette(); });
  },
  reset() {
    TB.keyGroup.clear();
    closePalette();
    refreshToolHighlight();
  },
  update() {
    // the active-tool chip steps aside while a drag is in progress (the cost label follows the cursor there)
    const d = !!(VC.tools && VC.tools.drag);
    if (d !== TB.dragging && TB.chip) {
      TB.dragging = d;
      TB.chip.classList.toggle('dragging', d);
    }
  },
  onShow() {
    refreshToolHighlight();
    layoutToolbar();
  },
  onHide: closePalette,
});

Object.assign(VC.hud, {
  openPalette,
  closePalette,
  paletteOpen: () => TB.palGroup,
  toolList,
  describeTool,
  toolGroupOf,
  toolTipHtml,
});
