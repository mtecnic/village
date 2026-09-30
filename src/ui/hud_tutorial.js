/*
 * VOXELPOLIS — first-city tutorial: a friendly hint card (top-left) with 8 steps that auto-advance by
 * watching the game state: road → residential → commercial + industrial → power → water → growth →
 * budget → services & parks. "Show me" opens the right palette / panel and the matching toolbar button
 * pulses. Skipping or finishing sets VC.settings.tutorial = false.
 * API (on VC.hud): startTutorial(force?), stopTutorial(), tutorialStep() -> index | -1
 */
const h = VC.h;
const TUT = { on: false, step: 0, acc: 0, flags: {}, card: null, advancing: false };

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

const STEPS = [
  { icon: '🛣️', title: 'Lay your first road', text: 'Open <b>Roads</b> <kbd>1</kbd>, pick a street and drag across the land. Buildings only grow near roads.', group: 'roads', check: anyRoad },
  { icon: '🏠', title: 'Zone some homes', text: 'Open <b>Zoning</b> <kbd>2</kbd>, choose <b style="color:var(--R)">Low Residential</b> and drag a rectangle along your road.', group: 'zones', check: () => zoneCount(1) > 0 },
  { icon: '🏬', title: 'Add shops and jobs', text: 'Your citizens need work. Zone some <b style="color:var(--C)">Commercial</b> and <b style="color:var(--I)">Industrial</b> land — keep factories a little away from homes.', group: 'zones',
    list: [{ label: 'Commercial zone', check: () => zoneCount(2) > 0 }, { label: 'Industrial zone', check: () => zoneCount(3) > 0 }] },
  { icon: '⚡', title: 'Power up', text: 'Build a power plant <kbd>3</kbd>. Wind turbines are cheap and clean; coal is powerful but dirty. Electricity flows through touching buildings and zones.', group: 'power', check: () => countBld((d) => d.power > 0) > 0 },
  { icon: '💧', title: 'Turn on the taps', text: 'Place a <b>water pump</b> next to a river or lake, or a <b>water tower</b> anywhere <kbd>4</kbd>.', group: 'water', check: () => countBld((d) => d.water > 0) > 0 },
  { icon: '🏗️', title: 'Watch your city grow', text: 'Let time run — press <kbd>]</kbd> to speed up. New buildings appear where there is demand, road access, power and water.', check: () => growCount() > 5, progress: () => Math.min(1, growCount() / 6) },
  { icon: '💰', title: 'Check the budget', text: 'Click your <b>funds</b> in the top bar or press <kbd>M</kbd>. Taxes pay for everything — keep the monthly balance green!', panel: 'budget', check: () => !!TUT.flags.budget },
  { icon: '🚓', title: 'Keep citizens safe & happy', text: 'Every city needs services. Build each of these, then sprinkle parks around your homes.', group: 'safety',
    list: [{ label: '🚓 Police station', check: () => countBld(cover('police')) > 0 }, { label: '🚒 Fire station', check: () => countBld(cover('fire')) > 0 }, { label: '🏫 School', check: () => countBld(cover('edu')) > 0 }, { label: '🌳 Park', check: () => countBld(cover('park')) > 0 }] },
];
function stepDone(s) {
  try {
    if (s.list) return s.list.every((x) => x.check());
    return s.check();
  } catch (e) { return false; }
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
  if (s.group || s.panel) actions.appendChild(h('button', { class: 'btn small primary', onclick: () => showMe(s) }, '👉 Show me'));
  actions.appendChild(h('button', { class: 'btn small ghost', 'data-tip': 'Skip this step', onclick: () => advance(true) }, 'Next ›'));
  const body = h('div', { class: 'tut-text' }, h('div', { class: 'tut-title' }, s.title), h('div', { class: 'tut-desc', html: s.text }));
  if (s.list) {
    const ul = h('div', { class: 'tut-list' });
    s.list.forEach((x) => ul.appendChild(h('div', { class: 'tut-li', 'data-i': x.label }, h('span', { class: 'tut-check' }), x.label)));
    body.appendChild(ul);
  }
  if (s.progress) body.appendChild(h('div', { class: 'tut-prog' }, h('i')));
  card.append(
    h('div', { class: 'tut-head' }, h('span', { class: 'tut-badge' }, '🎓 Tutorial'), h('span', { class: 'tut-step' }, `Step ${TUT.step + 1} of ${STEPS.length}`), h('button', { class: 'tut-skip', onclick: skip }, 'Skip tutorial')),
    h('div', { class: 'tut-body' }, h('div', { class: 'tut-icon' }, s.icon), body),
    h('div', { class: 'tut-foot' }, dots, actions)
  );
  if (TUT.card) TUT.card.replaceWith(card);
  else slot.appendChild(card);
  TUT.card = card;
  pulse(s.group || null);
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
function showMe(s) {
  VC.bus.emit('sfx', { name: 'click' });
  if (s.panel) { TUT.flags[s.panel] = TUT.flags[s.panel] || false; VC.hud.openPanel(s.panel); }
  else if (s.group) VC.hud.openPalette(s.group);
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
  else render();
}
function finish() {
  TUT.on = false;
  VC.settings.tutorial = false;
  VC.saveSettings();
  render();
  VC.ui.toast('<b>Tutorial complete!</b><br>You’re ready to build the city of your dreams, Mayor. 🎉', { type: 'good', icon: '🎓', duration: 6500 });
}
function skip() {
  VC.bus.emit('sfx', { name: 'click' });
  stopTutorial();
  VC.settings.tutorial = false;
  VC.saveSettings();
  VC.ui.toast('Tutorial skipped. You can restart it any time from ⚙️ Settings → Gameplay.', { type: 'info', icon: '🎓' });
}
function startTutorial(force) {
  if (!VC.state || VC.state.demo) return;
  if (!force && !(VC.settings && VC.settings.tutorial)) return;
  TUT.on = true;
  TUT.flags = {};
  TUT.step = 0;
  TUT.advancing = false;
  while (TUT.step < STEPS.length && stepDone(STEPS[TUT.step])) TUT.step++;
  if (TUT.step >= STEPS.length) { TUT.on = false; return; }
  render();
}
function stopTutorial() {
  TUT.on = false;
  render();
}

VC.hud.register({
  name: 'tutorial',
  order: 40,
  init() {
    const markPanel = (id) => { if (typeof id === 'string') for (const k of ['budget']) if (id === k || id.indexOf(k) >= 0) TUT.flags[k] = true; };
    VC.bus.on('windowOpened', markPanel);
    VC.bus.on('panelRequest', markPanel);
  },
  reset() {
    stopTutorial();
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

Object.assign(VC.hud, { startTutorial, stopTutorial, tutorialStep: () => (TUT.on ? TUT.step : -1) });
