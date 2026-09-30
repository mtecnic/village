/*
 * VOXELPOLIS — first-city tutorial: a friendly hint card (top-left) with 9 steps that auto-advance by
 * watching the game state: road → residential → commercial + industrial → power → water → growth →
 * budget → services & parks → garbage. "Show me" opens the right palette (the card to pick pulses) or panel,
 * and the matching toolbar button pulses. Skipping or finishing sets VC.settings.tutorial = false.
 * CHECKS THAT MEAN IT: the power step passes only when a plant is wired to the zones (its footprint touches a
 *   conductor and that network reaches zoned land — VC.actions.gridLink / gridReach, the sim's conduction
 *   rules); the water step only when a source is beside a road (pipes) and powered (or still being built).
 *   Otherwise the card shows WHY in a reason line with a "Show" button that flies to the plant / pump.
 *   The growth step shows the dominant blocker (paused, no road reach, no power, no water, no demand) once
 *   nothing has grown for ~20 game days, with a button that flies to an example lot.
 * CHECKLISTS: each row names its hotkey and is clickable (opens that row's palette, the card pulses);
 *   "Show me" opens the palette of the first missing row. Moving from a panel step (Budget) to a build step
 *   closes that panel when "Show me" is used (palettes also sit above windows, see hud_tools.js).
 * RESUME: progress lives in S.tut {step, budget, done} (plain JSON, saved with the city). Loading a city that
 *   was saved mid-tutorial (bus 'loaded', or VC.menu's Continue) resumes it at the right step while
 *   VC.settings.tutorial is still on.
 * API (on VC.hud): startTutorial(force?), stopTutorial(), resumeTutorial(), tutorialStep() -> index | -1
 */
const h = VC.h;
const TUT = { on: false, step: 0, acc: 0, flags: {}, card: null, advancing: false, whyKey: '', grow: { n: -1, day: 0 }, pulsed: null };

/* ---------------- state probes (cheap, run at 2 Hz for the current step only) ---------------- */
function anyRoad() {
  const r = VC.state.road;
  for (let i = 0; i < r.length; i++) if (r[i]) return true;
  return false;
}
function zoneCount(t) {
  const z = VC.state.zone;
  let n = 0;
  for (let i = 0; i < z.length; i++) if (z[i] >> 2 === t) n++;
  return n;
}
function countBld(pred) {
  let n = 0;
  for (const b of VC.state.buildings.values()) {
    const d = VC.BLD[b.key];
    if (d && pred(d)) n++;
  }
  return n;
}
function growCount() {
  let n = 0;
  for (const b of VC.state.buildings.values()) if (b.key === 'grow' && !b.abandoned) n++;
  return n;
}
const cover = (k) => (d) => !!(d.cover && d.cover[k]);
const anyZone = () => zoneCount(1) + zoneCount(2) + zoneCount(3) > 0;

/**
 * Producers of one kind ('power' | 'water') and how they are wired, cached per world / network version:
 * {n, list: [{b, def, link, reach}], linked, live} — linked: touches a conductor that carries the utility;
 * live: power — its network reaches zoned land or consumers; water — piped and powered (or being built).
 */
const wireCache = { power: { key: '', v: null }, water: { key: '', v: null } };
function wiring(kind) {
  const S = VC.state, A = VC.actions;
  const key = S.ver.bld + ':' + S.ver.flags + ':' + S.ver.terrain + ':' + S.buildings.size;
  const c = wireCache[kind];
  if (c.key === key && c.v) return c.v;
  const o = { n: 0, list: [], linked: 0, live: 0 };
  let zones = null; // any zoned land at all? (computed once, only if needed)
  for (const b of S.buildings.values()) {
    const def = VC.BLD[b.key];
    if (!def || !(def[kind] > 0)) continue;
    o.n++;
    const link = A && A.gridLink ? A.gridLink(b.x, b.z, b.w, b.d, b.id) : { power: 'road', water: 'road' };
    const e = { b, def, link, reach: null, linked: false, live: false };
    o.list.push(e);
    if (kind === 'power') {
      e.linked = !!link.power;
      if (e.linked && o.live) e.live = true; // one live plant is enough for the step: skip the flood fill
      else if (e.linked && A && A.gridReach) {
        e.reach = A.gridReach(b.x, b.z, b.w, b.d, 0, b.id);
        if (e.reach.zoned + e.reach.consumers > 0) e.live = true;
        else {
          if (zones === null) zones = anyZone();
          e.live = !zones;
        }
      } else e.live = e.linked && !(A && A.gridReach);
    } else {
      e.linked = !!link.water;
      e.live = e.linked && (b.built < 1 || !!b.powered);
    }
    if (e.linked) o.linked++;
    if (e.live) o.live++;
  }
  c.key = key;
  c.v = o;
  return o;
}
/** Camera to a building + a pulsing marker. */
function flyTo(b) {
  if (!b || !VC.camera || !VC.camera.focus) return;
  VC.camera.focus(b.x + b.w / 2, b.z + b.d / 2, 26);
  if (VC.tools && VC.tools.ping) VC.tools.ping(b.x, b.z, b.w, b.d);
}
function flyToProblem(kind) {
  const ex = VC.hud.findProblem ? VC.hud.findProblem(kind, 0) : null;
  if (!ex || !VC.camera || !VC.camera.focus) return;
  VC.camera.focus(ex.x + ex.w / 2, ex.z + ex.d / 2, 30);
  if (VC.tools && VC.tools.ping) VC.tools.ping(ex.x, ex.z, ex.w, ex.d);
}

/* ---------------- "why not yet?" lines: {text, good?, act?: {label, fn}} or null ---------------- */
function powerWhy() {
  const w = wiring('power');
  if (!w.n) return null;
  if (!w.linked) {
    const e = w.list[0];
    return { text: `Your ${e.def.name} isn't touching a road or power line, so its power can't go anywhere. Build a street or a power line up to it.`, act: { label: '📍 Show', fn: () => flyTo(e.b) } };
  }
  if (!w.live) {
    const e = w.list.find((x) => x.linked) || w.list[0];
    return { text: `Your ${e.def.name} is wired up, but that road doesn't reach your zones. Join the roads — or run a power line across.`, act: { label: '📍 Show', fn: () => flyTo(e.b) } };
  }
  return null;
}
function waterWhy() {
  const w = wiring('water');
  if (!w.n) return null;
  if (!w.linked) {
    const e = w.list[0];
    return { text: `Your ${e.def.name} isn't beside a road — water flows through the pipes under roads.`, act: { label: '📍 Show', fn: () => flyTo(e.b) } };
  }
  if (!w.live) {
    const e = w.list.find((x) => x.linked) || w.list[0];
    return { text: `Your ${e.def.name} has no power — pumps and towers run on electricity. Connect it to your powered roads.`, act: { label: '📍 Show', fn: () => flyTo(e.b) } };
  }
  return null;
}
/** Growth step: the dominant blocker once nothing has grown for a while (or at once when paused). */
function growWhy() {
  const S = VC.state;
  if (S.time.speed === 0) return { text: 'The game is paused. Press <kbd>Space</kbd> or ▶ in the top bar to let time run.' };
  const n = growCount();
  if (n !== TUT.grow.n) { TUT.grow.n = n; TUT.grow.day = S.time.day; }
  if (S.time.day - TUT.grow.day < 20) return null;
  let is = null;
  try { is = VC.sim && VC.sim.issues ? VC.sim.issues() : null; } catch (e) { is = null; }
  if (!is) return null;
  if (!is.zonedEmpty) return { text: 'Every zoned lot is built. Zone more land along your roads!' };
  const C = VC.C, num = VC.fmt.num, zs = VC.actions && VC.actions.zoneSupply;
  const noPow = zs ? zs(0).blocked : is.zonedNoPower, noWat = zs ? zs(1).blocked : is.zonedNoWater;
  const top = [['access', is.zonedNoAccess], ['power', noPow], ['water', noWat]].sort((a, b) => b[1] - a[1])[0];
  if (top[1] > 0) {
    if (top[0] === 'access') return { text: `${num(top[1])} zoned tiles are more than ${C.ROAD_ACCESS} tiles from a street, so they can't grow. Build a street closer or dezone them.`, act: { label: '📍 Show', fn: () => flyToProblem('access') } };
    if (top[0] === 'power') return { text: `${num(top[1])} zoned lots have no power. Power flows along roads, power lines and buildings — connect these streets to your plant.`, act: { label: '📍 Show', fn: () => { flyToProblem('power'); VC.gfx.setOverlay && VC.gfx.setOverlay('power'); } } };
    return { text: `${num(top[1])} medium / high density lots need water. Put a pump or tower beside a powered road.`, act: { label: '📍 Show', fn: () => { flyToProblem('water'); VC.gfx.setOverlay && VC.gfx.setOverlay('water'); } } };
  }
  return { text: 'Lots are ready but developers are waiting for demand. Zone a mix of homes, shops and industry — the RCI bars in the top bar show what people want.' };
}

const STEPS = [
  { key: 'road', icon: '🛣️', title: 'Lay your first road', text: 'Open <b>Roads</b> <kbd>1</kbd>, pick a <b>Street</b> and drag across the land. Buildings only grow near streets.', group: 'roads', hl: 'road_street', check: anyRoad },
  { key: 'homes', icon: '🏠', title: 'Zone some homes', text: 'Open <b>Zoning</b> <kbd>2</kbd>, choose <b style="color:var(--R)">Low Residential</b> and drag along your road, <b>up to 3 tiles deep</b>. Red, hatched tiles are too far from the street and would never grow.', group: 'zones', hl: 'zone_r1', check: () => zoneCount(1) > 0 },
  { key: 'jobs', icon: '🏬', title: 'Add shops and jobs', text: 'Your citizens need work. Zone some <b style="color:var(--C)">Commercial</b> and <b style="color:var(--I)">Industrial</b> land along a road — keep factories a little away from homes.', group: 'zones',
    list: [{ label: 'Commercial zone', key: '2', group: 'zones', hl: 'zone_c1', check: () => zoneCount(2) > 0 }, { label: 'Industrial zone', key: '2', group: 'zones', hl: 'zone_i1', check: () => zoneCount(3) > 0 }] },
  { key: 'power', icon: '⚡', title: 'Power up', text: 'Build a power plant <kbd>3</kbd> <b>touching a road that leads to your zones</b>. Power flows along roads, power lines and buildings — <b>not</b> across empty zones. Look for <b style="color:var(--good)">Connected to grid ✔</b> by the cursor. Wind turbines are cheap and clean.', group: 'power', hl: 'bld:wind_turbine',
    check: () => wiring('power').live > 0, why: powerWhy },
  { key: 'water', icon: '💧', title: 'Turn on the taps', text: 'Place a <b>water pump</b> by a river or lake, or a <b>water tower</b> anywhere <kbd>4</kbd> — beside a road, where the pipes run. Both need power. Low density grows without water; medium and high density need it.', group: 'water', hl: 'bld:water_tower',
    check: () => wiring('water').live > 0, why: waterWhy },
  { key: 'grow', icon: '🏗️', title: 'Watch your city grow', text: 'Let time run — press <kbd>]</kbd> or click ⏩ in the top bar to speed up. Low density needs a street and power; medium and high density also need water. Buildings appear where there is demand. When something blocks growth, the <b>“Why no growth?”</b> chip in the top bar names it — click it to see where.', check: () => growCount() > 5, progress: () => Math.min(1, growCount() / 6), why: growWhy },
  { key: 'budget', icon: '💰', title: 'Check the budget', text: 'Click your <b>funds</b> in the top bar or press <kbd>M</kbd>. Taxes pay for everything, and every building costs monthly <b>upkeep</b> — keep the ▲ balance under your funds green!', panel: 'budget', check: () => !!TUT.flags.budget },
  { key: 'services', icon: '🚓', title: 'Keep citizens safe & happy', text: 'Every city needs services. Each one costs monthly upkeep, so add them as the town grows and watch the ▲/▼ under your funds. Click a row to find it:',
    list: [
      { label: '🚓 Police station', key: '5', group: 'safety', hl: 'bld:police_station', check: () => countBld(cover('police')) > 0 },
      { label: '🚒 Fire station', key: '5', group: 'safety', hl: 'bld:fire_station', check: () => countBld(cover('fire')) > 0 },
      { label: '🏫 School', key: '6', group: 'education', hl: 'bld:school', check: () => countBld(cover('edu')) > 0 },
      { label: '🌳 Park', key: '7', group: 'parks', hl: 'bld:small_park', check: () => countBld(cover('park')) > 0 },
    ] },
  { key: 'garbage', icon: '♻️', title: 'Take out the trash', text: 'Homes make garbage from day one — without pickup it piles up and people get grumpy. Build a <b>Landfill</b> <kbd>9</kbd> a little away from homes (it smells!).', group: 'waste', hl: 'bld:landfill', check: () => countBld(cover('garbage')) > 0 },
];
function stepDone(s) {
  try {
    if (s.list) return s.list.every((x) => x.check());
    return s.check();
  } catch (e) { return false; }
}
/** First unfinished checklist row (or null). */
function firstMissing(s) {
  if (!s || !s.list) return null;
  for (const x of s.list) {
    let ok = false;
    try { ok = x.check(); } catch (e) { ok = false; }
    if (!ok) return x;
  }
  return null;
}
/** Group / highlighted card a step points at right now. */
function targetOf(s) {
  const m = firstMissing(s);
  if (m) return { group: m.group, hl: m.hl };
  return s.group ? { group: s.group, hl: s.hl } : null;
}

/* ---------------- card ---------------- */
function render() {
  const slot = VC.hud.slots && VC.hud.slots.tutorial;
  if (!slot) return;
  if (!TUT.on) { if (TUT.card) { TUT.card.classList.add('out'); const c = TUT.card; setTimeout(() => c.remove(), 300); TUT.card = null; } pulse(null); return; }
  const s = STEPS[TUT.step];
  const card = h('div', { class: 'tut-card pe' });
  const dots = h('div', { class: 'tut-dots' }, STEPS.map((_, i) => h('i', { class: i < TUT.step ? 'done' : i === TUT.step ? 'cur' : '' })));
  const actions = h('div', { class: 'tut-actions' });
  if (s.group || s.panel || s.list) actions.appendChild(h('button', { class: 'btn small primary', onclick: () => showMe(s) }, '👉 Show me'));
  actions.appendChild(h('button', { class: 'btn small ghost', 'data-tip': 'Skip this step', onclick: () => advance(true) }, 'Next ›'));
  const body = h('div', { class: 'tut-text' }, h('div', { class: 'tut-title' }, s.title), h('div', { class: 'tut-desc', html: s.text }));
  if (s.list) {
    const ul = h('div', { class: 'tut-list' });
    s.list.forEach((x) => {
      const row = h('div', { class: 'tut-li' + (x.group ? ' go' : ''), 'data-i': x.label, onclick: x.group ? () => { VC.bus.emit('sfx', { name: 'click' }); openFor(x); } : null },
        h('span', { class: 'tut-check' }), x.label, x.key ? h('span', { class: 'tut-key' }, h('kbd', null, x.key)) : null);
      ul.appendChild(row);
    });
    body.appendChild(ul);
  }
  if (s.progress) body.appendChild(h('div', { class: 'tut-prog' }, h('i')));
  TUT.why = h('div', { class: 'tut-why', style: { display: 'none' } });
  TUT.whyKey = '';
  body.appendChild(TUT.why);
  card.append(
    h('div', { class: 'tut-head' }, h('span', { class: 'tut-badge' }, '🎓 Tutorial'), h('span', { class: 'tut-step' }, `Step ${TUT.step + 1} of ${STEPS.length}`), h('button', { class: 'tut-skip', onclick: skip }, 'Skip tutorial')),
    h('div', { class: 'tut-body' }, h('div', { class: 'tut-icon' }, s.icon), body),
    h('div', { class: 'tut-foot' }, dots, actions)
  );
  if (TUT.card) TUT.card.replaceWith(card);
  else slot.appendChild(card);
  TUT.card = card;
  TUT.pulsed = undefined;
  refreshChecks();
}
function refreshChecks() {
  const s = STEPS[TUT.step];
  if (!TUT.card || !s) return;
  if (s.list) for (const el of TUT.card.querySelectorAll('.tut-li')) {
    const x = s.list.find((l) => l.label === el.dataset.i);
    let ok = false;
    try { ok = x && x.check(); } catch (e) { ok = false; }
    el.classList.toggle('done', !!ok);
  }
  if (s.progress) {
    const bar = TUT.card.querySelector('.tut-prog i');
    if (bar) { let p = 0; try { p = s.progress(); } catch (e) { p = 0; } bar.style.width = Math.round(p * 100) + '%'; }
  }
  // toolbar pulse follows the first missing row
  const t = targetOf(s);
  const g = t ? t.group : null;
  if (g !== TUT.pulsed) { TUT.pulsed = g; pulse(g); }
  // live reason line
  let w = null;
  if (s.why) { try { w = s.why(); } catch (e) { w = null; } }
  const key = w ? w.text + (w.act ? '|' + w.act.label : '') : '';
  if (key === TUT.whyKey) return;
  TUT.whyKey = key;
  const el = TUT.why;
  if (!el) return;
  el.innerHTML = '';
  if (!w) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.classList.toggle('good', !!w.good);
  el.append(h('span', null, w.good ? '✔' : '⚠'), h('span', { class: 'tut-why-text', html: w.text }));
  if (w.act) el.appendChild(h('button', { class: 'btn small', onclick: () => { VC.bus.emit('sfx', { name: 'click' }); w.act.fn(); } }, w.act.label));
}
/** Pulses the toolbar button of a group (or nothing). */
function pulse(group) {
  const root = VC.hud.root;
  if (!root) return;
  for (const b of root.querySelectorAll('.tb-tool.tut-pulse')) b.classList.remove('tut-pulse');
  if (!group) return;
  const b = root.querySelector('.tb-g-' + group);
  if (b) b.classList.add('tut-pulse');
}
function openFor(t) {
  if (!t || !t.group) return;
  VC.hud.openPalette(t.group, t.hl ? { highlight: t.hl } : undefined);
}
function showMe(s) {
  VC.bus.emit('sfx', { name: 'click' });
  if (s.panel) { TUT.flags[s.panel] = TUT.flags[s.panel] || false; VC.hud.openPanel(s.panel); return; }
  // coming from a panel step (the Budget): make room for the palette
  const prev = STEPS[TUT.step - 1];
  if (prev && prev.panel && VC.panels && VC.panels.isOpen && VC.panels.close) {
    try { if (VC.panels.isOpen(prev.panel)) VC.panels.close(prev.panel); } catch (e) { /* optional */ }
  }
  openFor(targetOf(s));
}
function advance(manual) {
  if (!TUT.on || TUT.advancing) return;
  if (manual) { next(); return; }
  TUT.advancing = true;
  if (TUT.card) TUT.card.classList.add('complete');
  VC.bus.emit('sfx', { name: 'success' });
  setTimeout(() => { TUT.advancing = false; next(); }, 1100);
}
function next() {
  if (!TUT.on) return;
  TUT.step++;
  while (TUT.step < STEPS.length && stepDone(STEPS[TUT.step])) TUT.step++;
  if (TUT.step >= STEPS.length) finish();
  else { remember(); render(); }
}
/** Writes the progress into the city (saved with it; see RESUME). */
function remember(done) {
  const S = VC.state;
  if (!S || S.demo) return;
  S.tut = done ? { done: true } : { step: TUT.step, budget: !!TUT.flags.budget };
}
function finish() {
  TUT.on = false;
  remember(true);
  VC.settings.tutorial = false;
  VC.saveSettings();
  render();
  VC.ui.toast('<b>Tutorial complete!</b><br>You’re ready to build the city of your dreams, Mayor. 🎉', { type: 'good', icon: '🎓', duration: 6500 });
}
function skip() {
  VC.bus.emit('sfx', { name: 'click' });
  stopTutorial();
  remember(true);
  VC.settings.tutorial = false;
  VC.saveSettings();
  VC.ui.toast('Tutorial skipped. You can restart it any time from ⚙️ Settings → Gameplay.', { type: 'info', icon: '🎓' });
}
function startTutorial(force) {
  const S = VC.state;
  if (!S || S.demo) return;
  if (!force && !(VC.settings && VC.settings.tutorial)) return;
  TUT.on = true;
  TUT.flags = {};
  TUT.step = 0;
  TUT.advancing = false;
  TUT.grow = { n: -1, day: S.time.day };
  // resuming a city saved mid-tutorial: start at its step (earlier steps count as done)
  const saved = S.tut;
  if (!force && saved && !saved.done && Number.isInteger(saved.step)) {
    TUT.step = Math.max(0, Math.min(STEPS.length - 1, saved.step));
    TUT.flags.budget = !!saved.budget;
  }
  while (TUT.step < STEPS.length && stepDone(STEPS[TUT.step])) TUT.step++;
  if (TUT.step >= STEPS.length) { TUT.on = false; remember(true); return; }
  remember();
  render();
}
/** Resumes the tutorial of a loaded city that was saved mid-tutorial (no-op otherwise / when running). */
function resumeTutorial() {
  const S = VC.state;
  if (TUT.on || !S || S.demo || !(VC.settings && VC.settings.tutorial)) return;
  if (!S.tut || S.tut.done) return;
  startTutorial(false);
}
function stopTutorial() {
  TUT.on = false;
  render();
}

VC.hud.register({
  name: 'tutorial',
  order: 40,
  init() {
    const markPanel = (id) => {
      if (typeof id !== 'string') return;
      for (const k of ['budget']) if (id === k || id.indexOf(k) >= 0) { TUT.flags[k] = true; if (TUT.on) remember(); }
    };
    VC.bus.on('windowOpened', markPanel);
    VC.bus.on('panelRequest', markPanel);
    VC.bus.on('loaded', () => setTimeout(resumeTutorial, 900));
  },
  reset() {
    stopTutorial();
    wireCache.power.key = wireCache.water.key = '';
  },
  update(dt, rdt) {
    if (!TUT.on || TUT.advancing || !VC.state) return;
    TUT.acc += rdt;
    if (TUT.acc < 0.5) return;
    TUT.acc = 0;
    refreshChecks();
    if (stepDone(STEPS[TUT.step])) advance(false);
  },
  onHide() { if (TUT.on) stopTutorial(); },
});

Object.assign(VC.hud, { startTutorial, stopTutorial, resumeTutorial, tutorialStep: () => (TUT.on ? TUT.step : -1) });
