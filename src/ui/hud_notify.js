/*
 * VOXELPOLIS — HUD notifications: news ticker, advisor cards, milestone celebration, achievement and
 * money toasts, disaster alerts.
 *   TICKER      bottom strip; smooth JS-driven scroll (transform only, widths cached). Headlines from bus
 *               'news' {text} (shown next, tagged BREAKING), recycled with VC.advisors.news, state-aware
 *               headlines and a pool of fun generic ones. Hover pauses. VC.settings.ticker === false hides it.
 *   ADVISORS    bus 'advisor' {advisor, title, text, severity}: warn/bad -> slide-in card (portrait, name,
 *               role colour, message, Details -> advisors panel, auto-dismiss with timer bar, max 3 + queue);
 *               good -> toast.
 *   MILESTONE   bus 'milestone' {index, milestone}: banner + confetti, reward, newly unlocked items.
 *   OTHER       'achievement' -> trophy toast, 'noMoney' -> throttled toast + funds shake,
 *               'disaster' {phase:'start'} -> red alert card with "Show me" (camera focus).
 * API (on VC.hud): pushNews(text, breaking?), showMilestone(index), unlocksBetween(popLo, popHi)
 */
const h = VC.h;
const TK = { x: 0, queue: [], items: [], trackW: 0, speed: 64, hover: false, lastText: '', genericIdx: 0, viewW: 0 };
const NOTE = { cards: [], queue: [] };
let lastNoMoney = 0;

const GENERIC_NEWS = [
  'Mayor sworn in at a charmingly awkward ribbon-cutting ceremony',
  'Scientists confirm: everything in town is, in fact, made of cubes',
  'Local pigeons petition council for more statues to sit on',
  'Traffic engineers baffled by a car that only ever turns left',
  'Forecast: 70% chance of sunshine, 30% chance of voxels',
  'Residents vote “Cube” the city’s favourite shape for the 12th year running',
  'Estate agents report record interest in lots “with road access”',
  'Town’s oldest tree celebrates its eighth voxel birthday',
  'Study: citizens 40% happier within walking distance of a park',
  'Local bakery unveils a perfectly cubic croissant; critics divided',
  'Power company reminds residents that power lines are not for drying laundry',
  'Opinion: why every city deserves at least one ridiculous landmark',
  'Retired mayor still writes monthly letters about the pothole on 3rd Street',
  'Fire department open day: kids allowed to press the big red button',
  'Mysterious cube-shaped footprints spotted by the lake — “probably nothing,” say officials',
  'City council approves budget after only seven hours of debate',
  'Garbage crews win the “Unsung Heroes” award for the third year in a row',
  'Local cat elected honorary deputy mayor; approval ratings soar',
  'New study finds 9 out of 10 citizens prefer streets that lead somewhere',
  'Weekend farmers market sells out of square watermelons by noon',
  'Architects debate: is a voxel a very small building or a very large brick?',
  'Library reports surge in borrowing of “Zoning for Dummies”',
];

/* ================================================================== */
/* TICKER                                                              */
/* ================================================================== */
function buildTicker(root) {
  TK.track = h('div', { class: 'tk-track' });
  TK.view = h('div', { class: 'tk-view' }, TK.track);
  TK.el = h('div', { class: 'hud-ticker pe' }, h('div', { class: 'tk-label' }, h('span', { class: 'tk-dot' }), 'VOXEL NEWS'), TK.view);
  TK.el.addEventListener('pointerenter', () => (TK.hover = true));
  TK.el.addEventListener('pointerleave', () => (TK.hover = false));
  root.appendChild(TK.el);
  applyTickerSetting();
  window.addEventListener('resize', () => (TK.viewW = 0));
}
function applyTickerSetting() {
  const on = !(VC.settings && VC.settings.ticker === false);
  TK.el.classList.toggle('hidden', !on);
  VC.hud.root && VC.hud.root.classList.toggle('no-ticker', !on);
}
function stateHeadline() {
  const S = VC.state;
  if (!S) return null;
  const st = S.stats || {}, dm = S.demand || {}, esc = VC.hud.escapeHtml;
  const opts = [];
  const name = esc(S.name || 'the city');
  if (st.pop > 0) opts.push(`${name} is now home to ${VC.fmt.num(st.pop)} proud citizens`);
  if ((dm.R || 0) > 0.5) opts.push('Housing crunch! Families queue around the block for new homes');
  if ((dm.C || 0) > 0.5) opts.push('Shoppers demand more stores — commercial space in short supply');
  if ((dm.I || 0) > 0.5) opts.push('Manufacturers want to expand: industrial land in hot demand');
  if ((st.unemployment || 0) > 0.12) opts.push('Job fairs packed as unemployment climbs to ' + VC.fmt.pct(st.unemployment));
  if ((st.powerDemand || 0) > (st.powerSupply || 0) && st.powerDemand > 0) opts.push('Blackouts! Residents light candles as power demand outstrips supply');
  if ((st.waterDemand || 0) > (st.waterSupply || 0) && st.waterDemand > 0) opts.push('Dry taps reported across town — water officials “looking into it”');
  if (S.money < 0) opts.push('City treasury in the red; accountants reportedly “sweating cubes”');
  const w = S.weather && S.weather.type;
  if (w === 'rain' || w === 'storm') opts.push('Umbrella sales soar as rain soaks ' + name);
  if (w === 'snow') opts.push('Snow day! Kids build the city’s first voxel snowman');
  if ((st.approval || st.happiness || 0) > 0.8) opts.push('Poll: citizens adore their mayor — approval at record highs');
  if (!opts.length) return null;
  return opts[Math.floor(Math.random() * opts.length)];
}
function nextHeadline() {
  if (TK.queue.length) return { text: TK.queue.shift(), breaking: true };
  const r = Math.random();
  let text = null;
  if (r < 0.3) text = stateHeadline();
  if (!text && r < 0.6) {
    const n = VC.advisors && VC.advisors.news;
    if (n && n.length) {
      const it = n[Math.floor(Math.random() * Math.min(n.length, 12))];
      text = typeof it === 'string' ? it : it && it.text;
      if (text) text = VC.hud.escapeHtml(text);
    }
  }
  if (!text) {
    text = GENERIC_NEWS[TK.genericIdx % GENERIC_NEWS.length];
    TK.genericIdx += 1 + Math.floor(Math.random() * 3);
  }
  if (text === TK.lastText) text = GENERIC_NEWS[TK.genericIdx++ % GENERIC_NEWS.length];
  return { text, breaking: false };
}
function appendHeadline() {
  const it = nextHeadline();
  TK.lastText = it.text;
  const el = h('span', { class: 'tk-item' + (it.breaking ? ' breaking' : '') }, it.breaking ? h('b', { class: 'tk-tag' }, 'BREAKING') : null, h('span', { html: it.text }), h('i', { class: 'tk-sep' }, '◆'));
  TK.track.appendChild(el);
  const w = el.offsetWidth;
  TK.items.push(w);
  TK.trackW += w;
}
function tickerUpdate(rdt) {
  if (!TK.track || TK.el.classList.contains('hidden')) return;
  if (!TK.viewW) TK.viewW = TK.view.clientWidth || 800;
  if (!TK.hover) TK.x -= TK.speed * Math.min(rdt, 0.05);
  // drop items that scrolled out on the left
  while (TK.items.length && TK.x + TK.items[0] < 0) {
    TK.x += TK.items[0];
    TK.trackW -= TK.items.shift();
    TK.track.firstChild.remove();
  }
  let guard = 0;
  while (TK.x + TK.trackW < TK.viewW + 60 && guard++ < 6) appendHeadline();
  const tf = `translate3d(${TK.x.toFixed(1)}px,0,0)`;
  if (TK.track._tf !== tf) { TK.track._tf = tf; TK.track.style.transform = tf; }
}
/** Queues a headline to appear next (tagged BREAKING). */
function pushNews(text, breaking = true) {
  if (!text) return;
  const t = VC.hud.escapeHtml(String(text));
  if (breaking) {
    if (!TK.queue.includes(t)) TK.queue.push(t);
    if (TK.queue.length > 6) TK.queue.shift();
  }
}

/* ================================================================== */
/* ADVISOR CARDS / DISASTER ALERTS                                     */
/* ================================================================== */
function showNote(n) {
  const slot = VC.hud.slots && VC.hud.slots.notes;
  if (!slot) return;
  if (NOTE.cards.some((c) => c.key === n.key)) return; // same message already on screen
  // room in the left column: fewer cards on short screens / while the tutorial card is up
  const tut = VC.hud.tutorialStep && VC.hud.tutorialStep() >= 0;
  const max = Math.max(1, (tut ? 1 : 2) + (window.innerHeight / VC.ui.scale() >= 860 ? 1 : 0));
  if (NOTE.cards.length >= max) {
    if (!NOTE.queue.some((q) => q.key === n.key)) NOTE.queue.push(n);
    if (NOTE.queue.length > 8) NOTE.queue.shift();
    return;
  }
  const card = h('div', { class: 'adv-card sev-' + (n.severity || 'warn') + (n.cls ? ' ' + n.cls : '') });
  card.style.setProperty('--ac', n.color || '#5ad1ff');
  const timer = h('i', { class: 'adv-timer' });
  const close = () => {
    if (card._closed) return;
    card._closed = true;
    card.classList.add('out');
    NOTE.cards = NOTE.cards.filter((c) => c.card !== card);
    setTimeout(() => {
      card.remove();
      if (NOTE.queue.length) showNote(NOTE.queue.shift());
    }, 260);
  };
  const actions = h('div', { class: 'adv-actions' });
  for (const a of n.actions || []) actions.appendChild(h('button', { class: 'btn small ' + (a.cls || ''), onclick: (e) => { e.stopPropagation(); VC.bus.emit('sfx', { name: 'click' }); a.onClick && a.onClick(); close(); } }, a.label));
  actions.appendChild(h('button', { class: 'btn small ghost', onclick: (e) => { e.stopPropagation(); close(); } }, 'Dismiss'));
  card.append(
    h('div', { class: 'adv-portrait' }, h('span', null, n.icon || '🧑‍💼')),
    h('div', { class: 'adv-main' },
      h('div', { class: 'adv-top' }, h('b', { class: 'adv-name' }, n.name || 'Advisor'), n.role ? h('span', { class: 'adv-role' }, n.role) : null, n.chip ? h('span', { class: 'adv-chip' }, n.chip) : null),
      n.title ? h('div', { class: 'adv-title', html: n.title }) : null,
      n.text ? h('div', { class: 'adv-text', html: n.text }) : null,
      actions),
    h('button', { class: 'win-btn adv-x', title: 'Dismiss', onclick: (e) => { e.stopPropagation(); close(); } }, '×'),
    timer
  );
  // auto-dismiss timer, paused while hovered
  const life = n.duration || 11000;
  let left = life, last = performance.now(), hover = false;
  card.addEventListener('pointerenter', () => (hover = true));
  card.addEventListener('pointerleave', () => (hover = false));
  const tick = () => {
    if (card._closed) return;
    const now = performance.now();
    if (!hover) left -= now - last;
    last = now;
    timer.style.transform = `scaleX(${Math.max(0, left / life).toFixed(3)})`;
    if (left <= 0) close();
    else setTimeout(tick, 100);
  };
  setTimeout(tick, 100);
  slot.appendChild(card);
  NOTE.cards.push({ key: n.key, card });
  VC.bus.emit('sfx', { name: n.severity === 'bad' ? 'alert' : 'notify' });
}
function onAdvisor(m) {
  if (!m || !VC.hud.visible || isDemo()) return;
  const sev = m.severity || 'info';
  const a = (VC.ADVISORS && VC.ADVISORS[m.advisor]) || { name: 'City Advisor', role: '', icon: '🧑‍💼', color: '#5ad1ff' };
  const esc = VC.hud.escapeHtml;
  if (sev === 'good') {
    VC.ui.toast(`<b>${esc(a.name)}:</b> ${esc(m.title || m.text || '')}`, { type: 'good', icon: a.icon, duration: 5000 });
    return;
  }
  if (sev !== 'warn' && sev !== 'bad') return;
  showNote({
    key: 'adv:' + (m.title || m.text),
    severity: sev,
    color: a.color,
    icon: a.icon,
    name: a.name,
    role: a.role,
    chip: sev === 'bad' ? 'URGENT' : null,
    title: esc(m.title || ''),
    text: esc(m.text || ''),
    duration: sev === 'bad' ? 15000 : 11000,
    actions: [{ label: 'Details', cls: 'primary', onClick: () => { try { if (m.id != null && VC.advisors && VC.advisors.markRead) VC.advisors.markRead(m.id); } catch (e) { /* ignore */ } VC.hud.openPanel('advisors'); } }],
  });
}
function onDisaster(d) {
  if (!d || d.phase !== 'start' || !VC.hud.visible || isDemo()) return;
  const types = (VC.disasters && VC.disasters.TYPES) || [];
  const t = types.find((x) => x.key === d.type) || { name: d.type || 'Disaster', icon: '⚠️' };
  const TXT = {
    fire: 'A fire has broken out! Make sure fire stations cover the area.',
    tornado: 'A tornado is tearing through the city. Take cover!',
    meteor: 'A meteor is streaking towards the city!',
    earthquake: 'The ground is shaking! Buildings may collapse.',
    ufo: 'Unidentified flying objects hover over the city…',
    monster: 'CUBEZILLA has emerged and is stomping through town!',
  };
  const acts = [];
  if (d.x != null && d.z != null) acts.push({ label: '📍 Show me', cls: 'danger', onClick: () => VC.camera && VC.camera.focus(d.x, d.z, 38) });
  showNote({ key: 'dis:' + d.type + ':' + (d.x | 0) + ':' + (d.z | 0), severity: 'bad', cls: 'disaster', color: '#ff5a6a', icon: t.icon, name: t.name.toUpperCase() + '!', role: 'Emergency', text: TXT[d.type] || 'Disaster strikes!', duration: 16000, actions: acts });
  VC.bus.emit('sfx', { name: 'alarm' });
}
const isDemo = () => !!(VC.state && VC.state.demo) || !!(VC.menu && VC.menu.active);

/* ================================================================== */
/* MILESTONE BANNER                                                    */
/* ================================================================== */
/** Everything that unlocks when peak population passes (lo, hi]. -> [{icon, name, kind}] */
function unlocksBetween(lo, hi) {
  const out = [];
  const inRange = (u) => (u || 0) > lo && (u || 0) <= hi;
  for (const t of [1, 2, 3]) { const r = VC.ROADS[t]; if (inRange(r.unlock)) out.push({ icon: r.icon, name: r.name, kind: 'road' }); }
  const dens = new Set();
  for (const z of VC.ZONE_TOOLS) if (inRange(z.unlock) && !dens.has(z.den)) { dens.add(z.den); out.push({ icon: '🏙️', name: VC.DENSITY[z.den] + '-density zones', kind: 'zone' }); }
  for (const d of VC.CATALOG) if (inRange(d.unlock)) out.push({ icon: d.icon, name: d.name, kind: 'building' });
  for (const p of VC.POLICIES) if (inRange(p.unlock)) out.push({ icon: p.icon, name: p.name, kind: 'policy' });
  return out;
}
function showMilestone(index, ms) {
  ms = ms || VC.MILESTONES[index];
  if (!ms) return;
  const S = VC.state, esc = VC.hud.escapeHtml;
  const prev = VC.MILESTONES[Math.max(0, index - 1)];
  const unl = index > 0 ? unlocksBetween(prev.pop, ms.pop) : [];
  const old = document.querySelector('.ms-banner');
  if (old) old.remove();
  const chips = h('div', { class: 'ms-unlocks' });
  unl.slice(0, 10).forEach((u, i) => chips.appendChild(h('span', { class: 'ms-chip', style: { animationDelay: 0.6 + i * 0.06 + 's' } }, h('b', null, u.icon), u.name)));
  if (unl.length > 10) chips.appendChild(h('span', { class: 'ms-chip more' }, '+' + (unl.length - 10) + ' more'));
  const close = () => { if (banner._closed) return; banner._closed = true; banner.classList.add('out'); setTimeout(() => banner.remove(), 400); };
  const banner = h('div', { class: 'ms-banner pe', onclick: close },
    h('div', { class: 'ms-rays' }),
    h('div', { class: 'ms-medal' }, h('span', null, '🏆')),
    h('div', { class: 'ms-kicker' }, 'Milestone reached'),
    h('div', { class: 'ms-title', html: `🎉 ${esc((S && S.name) || 'Your city')} is now a <em>${esc(ms.name)}</em>!` }),
    ms.reward ? h('div', { class: 'ms-reward' }, h('span', null, '💰'), `+${VC.fmt.money(ms.reward)} city grant`) : null,
    unl.length ? h('div', { class: 'ms-unl-title' }, '✨ Newly unlocked') : null,
    unl.length ? chips : null,
    h('button', { class: 'btn primary ms-ok', onclick: (e) => { e.stopPropagation(); close(); } }, 'Hooray!'));
  VC.hud.root.appendChild(banner);
  confetti();
  VC.bus.emit('sfx', { name: 'fanfare' });
  setTimeout(close, 11000);
}
function confetti() {
  const box = h('div', { class: 'confetti' });
  const cols = ['#5ad1ff', '#b388ff', '#39d98a', '#ffc83d', '#ff5a6a', '#ffffff', '#ff8fd8'];
  for (let i = 0; i < 90; i++) {
    const p = h('i');
    const s = p.style;
    s.left = Math.random() * 100 + '%';
    s.background = cols[i % cols.length];
    s.animationDuration = 2.6 + Math.random() * 2.4 + 's';
    s.animationDelay = Math.random() * 0.9 + 's';
    s.setProperty('--dx', (Math.random() * 2 - 1) * 160 + 'px');
    s.setProperty('--rot', (Math.random() * 1400 - 700) + 'deg');
    s.width = 6 + Math.random() * 6 + 'px';
    s.height = 8 + Math.random() * 8 + 'px';
    if (i % 3 === 0) s.borderRadius = '50%';
    box.appendChild(p);
  }
  VC.hud.root.appendChild(box);
  setTimeout(() => box.remove(), 6200);
}

/* ================================================================== */
VC.hud.register({
  name: 'notify',
  order: 30,
  init(root) {
    buildTicker(root);
    const bus = VC.bus;
    bus.on('news', (n) => { if (!isDemo()) pushNews(n && (n.text || n), true); });
    bus.on('advisor', onAdvisor);
    bus.on('disaster', onDisaster);
    bus.on('milestone', (m) => { if (m && VC.hud.visible && !isDemo()) showMilestone(m.index != null ? m.index : VC.MILESTONES.indexOf(m.milestone), m.milestone); });
    bus.on('achievement', (a) => {
      if (!a || !VC.hud.visible || isDemo()) return;
      VC.ui.toast(`<b>Achievement unlocked!</b><br>${a.icon || '🏅'} ${VC.hud.escapeHtml(a.name || a.key || '')}`, { cls: 'toast-achv', icon: '🏆', duration: 6500 });
      VC.bus.emit('sfx', { name: 'achievement' });
    });
    bus.on('noMoney', (e) => {
      if (!VC.hud.visible || isDemo()) return;
      const now = performance.now();
      VC.hud.flashFunds();
      if (now - lastNoMoney < 2000) return;
      lastNoMoney = now;
      VC.ui.toast(`<b>Not enough money!</b>${e && e.amount ? ` This costs ${VC.fmt.money(e.amount)}.` : ''}`, { type: 'bad', icon: '💸', duration: 3200 });
      VC.bus.emit('sfx', { name: 'error' });
    });
    bus.on('settings', applyTickerSetting);
  },
  reset() {
    TK.queue = [];
    for (const c of NOTE.cards) c.card.remove();
    NOTE.cards = [];
    NOTE.queue = [];
  },
  update(dt, rdt) {
    tickerUpdate(rdt);
  },
  onShow() { TK.viewW = 0; },
});

Object.assign(VC.hud, { pushNews, showMilestone, unlocksBetween, showNote });
