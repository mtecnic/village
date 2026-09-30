/*
 * VOXELPOLIS — HUD notifications: the display side of the notification policy.
 * One domain event -> exactly ONE visible notification. Sounds for these events come from the audio
 * module's own bus hooks (milestone, achievement, advisor, unlock, noMoney, disaster), so nothing here emits
 * 'sfx' for them, and every toast goes straight to VC.ui.toast (never bus 'toast', which audio also voices).
 *   TICKER      bottom strip; smooth JS-driven scroll (transform only, widths cached). Breaking headlines come
 *               only from bus 'news' {text}: de-duplicated (queue + recently shown) and dropped when stale
 *               (> 45 game days or 2 real minutes old). Filler: recent VC.advisors headlines, state-aware
 *               headlines and a pool of fun generic ones. Hover pauses. VC.settings.ticker === false hides it.
 *   ADVISORS    bus 'advisor' {advisor, title, text, severity}: warn/bad -> slide-in card (portrait, name, role
 *               colour, message, Details -> advisors panel, auto-dismiss timer). At most one new advisor card
 *               per 10 s; the rest wait in a short queue (bad first) and expire after 90 s.
 *               good -> one toast; info -> nothing here (the dock's inbox badge shows it).
 *   MILESTONE   bus 'milestone' {index, milestone, unlocked:[keys]} -> banner + confetti listing exactly
 *               `unlocked` (fallback when absent: items of the milestone's range not already announced).
 *               Milestones arriving while a banner is up merge into it (path, summed rewards, all unlocks).
 *               The banner sits above windows and toasts; toasts and advisor cards move out of its way.
 *   UNLOCK      bus 'unlock' {keys} -> one toast "New: A, B unlocked".
 *   ACHIEVEMENT bus 'achievement' {key, name, icon} -> one toast (VC.advisors.toastAchievements forced off).
 *   NO MONEY    bus 'noMoney' {amount} -> one toast per 2 s + funds shake (callers never toast it).
 *   DISASTER    bus 'disaster' {phase:'start', type, x, z, id} -> one red alert card whose "Show me" follows
 *               the LIVE VC.disasters.active entry (by id; start point as fallback). Closes on phase 'end'.
 *   DEMO        nothing at all while VC.state.demo (title-screen city) or the title menu is up.
 *   JUICE       floating "+12 👥" / "⭐ Level 2!" / "💰 +$" pills over growing buildings, month-end cha-ching
 *               with coin showers, a small celebration every 25 % toward the next milestone (see JUICE below;
 *               VC.settings.juice === false turns it off). Never notifications: no toasts, at most one sound.
 * API (on VC.hud): pushNews(text, breaking?), showMilestone(index, milestone?, unlockItems?),
 *   unlocksBetween(popLo, popHi), describeUnlocks(keys) -> [{key, icon, name, kind}], showNote(n),
 *   juice: {pop(x, y, z, text, cls?) (a world-anchored pill, rate-limited), stats(), texts(), month(), poll(),
 *   hold(on)} (the last five: debug / tests)
 */
const h = VC.h;
const TK = { x: 0, queue: [], items: [], trackW: 0, speed: 64, hover: false, lastText: '', genericIdx: 0, viewW: 0, recent: [] };
const NOTE = { cards: [], queue: [], lastAdvAt: -1e9 };
const MS = { banner: null, list: [], unlocks: [], timer: 0, announced: new Set() };
let lastNoMoney = 0;

const ADV_GAP_MS = 10000; // min real time between two advisor cards
const ADV_STALE_MS = 90000; // queued advisor cards older than this are dropped
const NEWS_STALE_DAYS = 45; // queued breaking headlines older than this (game days) are dropped
const NEWS_STALE_MS = 120000; // … or older than this in real time
const esc = (s) => VC.ui.esc(s);
const finite = (v) => typeof v === 'number' && isFinite(v);

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

const isDemo = () => !!(VC.state && VC.state.demo) || !!(VC.menu && VC.menu.active);
const live = () => VC.hud.visible && !isDemo();

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
  const st = S.stats || {}, dm = S.demand || {};
  const opts = [];
  const name = esc(S.name || 'the city');
  if (st.pop > 0) opts.push(`${name} is now home to ${VC.fmt.num(st.pop)} proud citizens`);
  // demand headlines only once people live here (at pop 0 the demand is only the starting pull)
  if (st.pop > 0 && (dm.R || 0) > 0.5) opts.push('Housing crunch! Families queue around the block for new homes');
  if (st.pop > 0 && (dm.C || 0) > 0.5) opts.push('Shoppers demand more stores — commercial space in short supply');
  if (st.pop > 0 && (dm.I || 0) > 0.5) opts.push('Manufacturers want to expand: industrial land in hot demand');
  if ((st.unemployment || 0) > 0.12) opts.push('Job fairs packed as unemployment climbs to ' + VC.fmt.pct(st.unemployment));
  if ((st.powerDemand || 0) > (st.powerSupply || 0) && st.powerDemand > 0) opts.push('Blackouts! Residents light candles as power demand outstrips supply');
  if ((st.waterDemand || 0) > (st.waterSupply || 0) && st.waterDemand > 0) opts.push('Dry taps reported across town — water officials “looking into it”');
  if (S.money < 0) opts.push('City treasury in the red; accountants reportedly “sweating cubes”');
  const w = S.weather && S.weather.type;
  if (w === 'rain' || w === 'storm') opts.push('Umbrella sales soar as rain soaks ' + name);
  if (w === 'snow') opts.push('Snow day! Kids build the city’s first voxel snowman');
  if (st.pop > 0 && (st.approval || st.happiness || 0) > 0.8) opts.push('Poll: citizens adore their mayor — approval at record highs');
  if (!opts.length) return null;
  return opts[Math.floor(Math.random() * opts.length)];
}
/** A recent real headline to recycle (only from the last ~60 game days, never one shown just now). */
function recycledHeadline() {
  const S = VC.state;
  const log = S && S.adv && Array.isArray(S.adv.newsLog) ? S.adv.newsLog : null;
  let pool;
  if (log && log.length) {
    const day = S.time.day;
    pool = log.filter((it) => it && it.text && (it.day == null || day - it.day <= 60)).map((it) => it.text);
  } else {
    const n = VC.advisors && VC.advisors.news;
    pool = Array.isArray(n) ? n.slice(0, 6).map((it) => (typeof it === 'string' ? it : it && it.text)).filter(Boolean) : [];
  }
  pool = pool.map((t) => esc(t)).filter((t) => !TK.recent.includes(t));
  return pool.length ? pool[Math.floor(Math.random() * Math.min(pool.length, 8))] : null;
}
function nextHeadline() {
  const now = performance.now(), day = VC.state ? VC.state.time.day : 0;
  while (TK.queue.length) {
    const q = TK.queue.shift();
    if (day - q.day > NEWS_STALE_DAYS || now - q.t > NEWS_STALE_MS) continue; // stale news is no news
    return { text: q.text, breaking: true };
  }
  const r = Math.random();
  let text = null;
  if (r < 0.3) text = stateHeadline();
  if (!text && r < 0.6) text = recycledHeadline();
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
  TK.recent.push(it.text);
  if (TK.recent.length > 12) TK.recent.shift();
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
/** Queues a headline to appear next (tagged BREAKING). Plain text; identical headlines are dropped. */
function pushNews(text, breaking = true) {
  if (!text) return;
  const t = esc(String(text));
  if (!breaking) return;
  if (TK.queue.some((q) => q.text === t) || TK.recent.slice(-4).includes(t)) return;
  TK.queue.push({ text: t, day: VC.state ? VC.state.time.day : 0, t: performance.now() });
  while (TK.queue.length > 4) TK.queue.shift(); // a burst keeps its newest headlines
}

/* ================================================================== */
/* CARDS (advisor messages, disaster alerts)                           */
/* ================================================================== */
/** Cards that fit the right column above the toast lane (bottom-right). */
function maxCards() {
  return VC.M.clamp(Math.floor((window.innerHeight / VC.ui.scale() - 430) / 140), 1, 4);
}
/**
 * Shows a card now. n = {key, severity, color, icon, name, role, chip, title, text (HTML, escaped by the
 * caller), duration, cls, actions:[{label, cls, onClick}], urgent}. Urgent cards make room by closing the
 * oldest regular card. No sound: the event that caused the card is voiced by the audio module.
 */
function showNote(n) {
  const slot = VC.hud.slots && VC.hud.slots.notes;
  if (!slot) return null;
  const same = NOTE.cards.find((c) => c.key === n.key);
  if (same) return same;
  if (NOTE.cards.length >= maxCards()) {
    const victim = n.urgent ? NOTE.cards.find((c) => !c.urgent) || NOTE.cards[0] : null;
    if (!victim) { queueNote(n); return null; }
    victim.close(true);
  }
  const card = h('div', { class: 'adv-card sev-' + (n.severity || 'warn') + (n.cls ? ' ' + n.cls : '') });
  card.style.setProperty('--ac', n.color || '#5ad1ff');
  const timer = h('i', { class: 'adv-timer' });
  const entry = { key: n.key, card, urgent: !!n.urgent, close: null };
  const close = (instant) => {
    if (card._closed) return;
    card._closed = true;
    NOTE.cards = NOTE.cards.filter((c) => c !== entry);
    if (instant) card.remove();
    else {
      card.classList.add('out');
      setTimeout(() => card.remove(), 260);
    }
    setTimeout(pumpNotes, 280);
  };
  entry.close = close;
  const actions = h('div', { class: 'adv-actions' });
  for (const a of n.actions || []) actions.appendChild(h('button', { class: 'btn small ' + (a.cls || ''), onclick: (e) => { e.stopPropagation(); VC.bus.emit('sfx', { name: 'click' }); a.onClick && a.onClick(); if (!a.keep) close(); } }, a.label));
  actions.appendChild(h('button', { class: 'btn small ghost', onclick: (e) => { e.stopPropagation(); close(); } }, 'Dismiss'));
  card.append(
    h('div', { class: 'adv-portrait' }, h('span', null, n.icon || '💼')),
    h('div', { class: 'adv-main' },
      h('div', { class: 'adv-top' }, h('b', { class: 'adv-name' }, n.name || 'Advisor'), n.role ? h('span', { class: 'adv-role' }, n.role) : null, n.chip ? h('span', { class: 'adv-chip' }, n.chip) : null),
      n.title ? h('div', { class: 'adv-title', html: n.title }) : null,
      n.text ? h('div', { class: 'adv-text', html: n.text }) : null,
      actions),
    h('button', { class: 'win-btn adv-x', title: 'Dismiss', onclick: (e) => { e.stopPropagation(); close(); } }, '×'),
    timer
  );
  // auto-dismiss timer, paused while hovered
  const lifeMs = n.duration || 11000;
  let left = lifeMs, last = performance.now(), hover = false;
  card.addEventListener('pointerenter', () => (hover = true));
  card.addEventListener('pointerleave', () => (hover = false));
  const tick = () => {
    if (card._closed) return;
    const now = performance.now();
    if (!hover) left -= now - last;
    last = now;
    timer.style.transform = `scaleX(${Math.max(0, left / lifeMs).toFixed(3)})`;
    if (left <= 0) close();
    else setTimeout(tick, 100);
  };
  setTimeout(tick, 100);
  slot.appendChild(card);
  NOTE.cards.push(entry);
  return entry;
}
function queueNote(n) {
  if (NOTE.cards.some((c) => c.key === n.key) || NOTE.queue.some((q) => q.key === n.key)) return;
  n.at = n.at || performance.now();
  NOTE.queue.push(n);
  while (NOTE.queue.length > 6) NOTE.queue.shift();
}
/** Shows the next queued advisor card when the rate limit and the column allow it. */
function pumpNotes() {
  if (!NOTE.queue.length) return;
  const now = performance.now();
  NOTE.queue = NOTE.queue.filter((q) => now - q.at < ADV_STALE_MS);
  if (!NOTE.queue.length || NOTE.cards.length >= maxCards() || now - NOTE.lastAdvAt < ADV_GAP_MS) return;
  if (!live() || VC.hud.uiHidden || (VC.menu && VC.menu.isPaused && VC.menu.isPaused())) return;
  let i = NOTE.queue.findIndex((q) => q.severity === 'bad');
  if (i < 0) i = 0;
  const n = NOTE.queue.splice(i, 1)[0];
  NOTE.lastAdvAt = now;
  showNote(n);
}
function closeNote(key) {
  NOTE.queue = NOTE.queue.filter((q) => q.key !== key);
  const c = NOTE.cards.find((x) => x.key === key);
  if (c) c.close();
}
function onAdvisor(m) {
  if (!m || !live()) return;
  const sev = m.severity || 'info';
  const a = (VC.ADVISORS && VC.ADVISORS[m.advisor]) || { name: 'City Advisor', role: '', icon: '💼', color: '#5ad1ff' };
  if (sev === 'good') {
    VC.ui.toast(`<b>${esc(a.name)}:</b> ${esc(m.title || m.text || '')}`, { type: 'good', icon: a.icon, duration: 5000 });
    return;
  }
  if (sev !== 'warn' && sev !== 'bad') return; // info: inbox badge only
  // a disaster start has its own alert card (onDisaster; the advisor's note may even arrive first, from
  // inside the same 'disaster' event): never a second card for it — the inbox keeps the advisor's text
  if (/^disaster_/.test(String(m.key || ''))) return;
  queueNote({
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
  pumpNotes();
}

/* ---------------- disasters ---------------- */
const DIS_TXT = {
  fire: 'A fire has broken out! Make sure fire stations cover the area.',
  tornado: 'A tornado is tearing through the city. Take cover!',
  meteor: 'A meteor is streaking towards the city!',
  earthquake: 'The ground is shaking! Buildings may collapse.',
  ufo: 'Unidentified flying objects hover over the city…',
  monster: 'CUBEZILLA has emerged and is stomping through town!',
};
/** Camera to where the disaster is NOW (live entry by id), else its start point. */
function focusDisaster(id, entry, sx, sz) {
  const act = (VC.disasters && Array.isArray(VC.disasters.active) && VC.disasters.active) || [];
  const e = (id != null && act.find((a) => a && a.id === id)) || (entry && act.includes(entry) ? entry : null);
  let x = null, z = null;
  if (e) {
    // a UFO still flying in from the map edge: look at the area it is heading for
    if (e.type === 'ufo' && e.phase === 'arrive' && finite(e.tx) && finite(e.tz)) { x = e.tx; z = e.tz; }
    else { x = e.x; z = e.z; }
  }
  if (!finite(x) || !finite(z)) { x = sx; z = sz; }
  if (!finite(x) || !finite(z) || !VC.camera || !VC.camera.focus) return;
  const S = VC.state;
  if (S) { x = VC.M.clamp(x, 0, S.W - 1); z = VC.M.clamp(z, 0, S.H - 1); }
  VC.camera.focus(x, z, 38);
}
function onDisaster(d) {
  if (!d) return;
  const id = d.id != null ? d.id : d.entry && d.entry.id != null ? d.entry.id : null;
  if (d.phase === 'end') {
    if (id != null) closeNote('dis:' + id);
    return;
  }
  if (d.phase !== 'start' || !live()) return;
  const types = (VC.disasters && VC.disasters.TYPES) || [];
  const t = types.find((x) => x.key === d.type) || { name: d.name || d.type || 'Disaster', icon: d.icon || '⚠️' };
  const sx = finite(d.x) ? d.x : null, sz = finite(d.z) ? d.z : null;
  const entry = d.entry || null;
  const acts = [];
  if (id != null || entry || (sx != null && sz != null)) acts.push({ label: '📍 Show me', cls: 'danger', keep: true, onClick: () => focusDisaster(id, entry, sx, sz) });
  showNote({ key: 'dis:' + (id != null ? id : d.type + ':' + sx + ':' + sz), urgent: true, severity: 'bad', cls: 'disaster', color: '#ff5a6a', icon: t.icon, name: String(t.name || '').toUpperCase() + '!', role: 'Emergency', text: esc(DIS_TXT[d.type] || 'Disaster strikes!'), duration: 16000, actions: acts });
}

/* ================================================================== */
/* UNLOCKS                                                             */
/* ================================================================== */
/** Everything that unlocks when peak population passes (lo, hi]. -> [{key, icon, name, kind}] */
function unlocksBetween(lo, hi) {
  const out = [];
  const inRange = (u) => (u || 0) > lo && (u || 0) <= hi;
  for (const t in VC.ROADS) { const r = VC.ROADS[t]; if (r && inRange(r.unlock)) out.push({ key: r.key, icon: r.icon, name: r.name, kind: 'road' }); }
  for (const d in VC.DENSITY_UNLOCK) if (inRange(VC.DENSITY_UNLOCK[d])) out.push({ key: 'density' + d, icon: '🏙️', name: VC.DENSITY[d] + '-density zones', kind: 'zone' });
  for (const d of VC.CATALOG) if (inRange(d.unlock)) out.push({ key: d.key, icon: d.icon, name: d.name, kind: 'building' });
  for (const p of VC.POLICIES) if (inRange(p.unlock)) out.push({ key: p.key, icon: p.icon, name: p.name + ' policy', kind: 'policy' });
  return out;
}
/** Display info for one unlock key ('solar_farm', 'avenue', 'density2', 'zone_r2', 'policy:ubi', or an object). */
function describeUnlock(k) {
  if (k && typeof k === 'object') return { key: k.key != null ? String(k.key) : String(k.name || ''), icon: k.icon || '✨', name: String(k.name || k.key || ''), kind: k.kind || '' };
  let key = String(k == null ? '' : k);
  let kind = null;
  const m = /^(bld|building|road|policy|zone|density):(.+)$/.exec(key);
  if (m) { kind = m[1] === 'bld' ? 'building' : m[1]; key = m[2]; }
  if (/^road_/.test(key)) { kind = 'road'; key = key.slice(5); }
  const road = Object.values(VC.ROADS).find((r) => r && r.key === key);
  const pol = VC.POLICY && VC.POLICY[key];
  const bld = VC.BLD[key];
  const dm = /^(?:density|zone_[rci])(\d)$/.exec(key);
  if ((!kind || kind === 'building') && bld) return { key, icon: bld.icon, name: bld.name, kind: 'building' };
  if ((!kind || kind === 'road') && road) return { key, icon: road.icon, name: road.name, kind: 'road' };
  if ((!kind || kind === 'policy') && pol) return { key, icon: pol.icon, name: pol.name + ' policy', kind: 'policy' };
  if (dm) return { key: 'density' + dm[1], icon: '🏙️', name: (VC.DENSITY[+dm[1]] || '') + '-density zones', kind: 'zone' };
  return { key, icon: '✨', name: key.replace(/[_:]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), kind: kind || '' };
}
function describeUnlocks(keys) {
  const out = [], seen = new Set();
  for (const k of keys || []) {
    const u = describeUnlock(k);
    if (!u.name || seen.has(u.kind + ':' + u.name)) continue;
    seen.add(u.kind + ':' + u.name);
    out.push(u);
  }
  return out;
}
function onUnlock(e) {
  const keys = e && (e.keys || e.items);
  if (!Array.isArray(keys) || !keys.length) return;
  const items = describeUnlocks(keys);
  for (const u of items) MS.announced.add(u.key);
  if (!items.length || !live()) return;
  const names = items.map((u) => esc(u.name));
  const shown = names.length > 5 ? names.slice(0, 5).join(', ') + ` +${names.length - 5} more` : names.join(', ');
  VC.ui.toast(`<b>New:</b> ${shown} unlocked`, { type: 'good', icon: '🔓', duration: 6000 });
}

/* ================================================================== */
/* MILESTONE BANNER                                                    */
/* ================================================================== */
function onMilestone(m) {
  if (!m) return;
  const index = m.index != null ? m.index : VC.MILESTONES.indexOf(m.milestone);
  const ms = m.milestone || VC.MILESTONES[index];
  if (!ms) return;
  let items;
  if (Array.isArray(m.unlocked)) items = describeUnlocks(m.unlocked);
  else {
    // older advisors: the milestone's range minus whatever an 'unlock' event already announced
    const prev = VC.MILESTONES[Math.max(0, index - 1)];
    items = index > 0 ? unlocksBetween(prev.pop, ms.pop).filter((u) => !MS.announced.has(u.key)) : [];
  }
  for (const u of items) MS.announced.add(u.key);
  if (!live()) return;
  showMilestone(index, ms, items);
}
/** Banner geometry in screen px, independent of its entrance animation. */
function bannerRect() {
  const b = MS.banner;
  if (!b || b._closed || !b.isConnected) return null;
  const s = VC.ui.scale(), w = b.offsetWidth * s, hgt = b.offsetHeight * s, top = b.offsetTop;
  const left = window.innerWidth / 2 - w / 2;
  return { left, top, right: left + w, bottom: top + hgt };
}
/** Keeps the banner clear of the left/right card columns: narrower when there is room, else cards move down. */
function fitBanner() {
  const b = MS.banner;
  if (!b) return;
  const s = VC.ui.scale(), vw = window.innerWidth;
  const side = (10 + 322 + 12) * s; // tutorial column (left) ~ advisor column (right: 66 + 322)
  const sideR = (66 + 322 + 12) * s;
  const room = vw - 2 * Math.max(side, sideR);
  b.style.width = room >= 440 * s ? Math.min(560, room / s) + 'px' : '';
  const right = VC.hud.root && VC.hud.root.querySelector('.hud-right');
  if (right) {
    const r = bannerRect();
    const colLeft = vw - sideR;
    const dy = r && r.right > colLeft ? Math.max(0, r.bottom + 8 - 70 * s) : 0;
    right.style.translate = dy ? `0 ${Math.round(dy)}px` : '';
  }
  VC.ui.layoutToasts();
}
function unfitBanner() {
  const right = VC.hud.root && VC.hud.root.querySelector('.hud-right');
  if (right) right.style.translate = '';
  VC.ui.layoutToasts(); // bannerRect() is null once the banner is closing: toasts may return to their lane
}
/**
 * Shows (or extends) the milestone banner. items: [{icon, name}] newly unlocked things; omitted -> the
 * milestone's range not yet announced. Several calls while it is up merge into one banner.
 */
function showMilestone(index, ms, items) {
  ms = ms || VC.MILESTONES[index];
  if (!ms || !VC.hud.root) return;
  if (!items) {
    const prev = VC.MILESTONES[Math.max(0, index - 1)];
    items = index > 0 ? unlocksBetween(prev.pop, ms.pop).filter((u) => !MS.announced.has(u.key)) : [];
  }
  const merging = MS.banner && !MS.banner._closed && MS.banner.isConnected;
  if (!merging) { MS.list = []; MS.unlocks = []; }
  if (MS.list.some((x) => x.index === index)) return; // same milestone twice
  MS.list.push({ index, ms });
  MS.list.sort((a, b) => a.index - b.index);
  for (const u of items) if (!MS.unlocks.some((x) => x.name === u.name)) MS.unlocks.push(u);
  renderBanner(!merging);
  clearTimeout(MS.timer);
  MS.timer = setTimeout(closeBanner, 11000);
}
function closeBanner() {
  const b = MS.banner;
  if (!b || b._closed) return;
  b._closed = true;
  clearTimeout(MS.timer);
  b.classList.add('out');
  setTimeout(() => { b.remove(); if (MS.banner === b) MS.banner = null; }, 400);
  unfitBanner();
}
function renderBanner(fresh) {
  const S = VC.state;
  const top = MS.list[MS.list.length - 1].ms;
  const reward = MS.list.reduce((a, x) => a + (x.ms.reward || 0), 0);
  const unl = MS.unlocks;
  const chips = h('div', { class: 'ms-unlocks' });
  unl.slice(0, 10).forEach((u, i) => chips.appendChild(h('span', { class: 'ms-chip', style: { animationDelay: 0.6 + i * 0.06 + 's' } }, h('b', null, u.icon), u.name)));
  if (unl.length > 10) chips.appendChild(h('span', { class: 'ms-chip more' }, '+' + (unl.length - 10) + ' more'));
  const path = MS.list.length > 1 ? h('div', { class: 'ms-path' }, MS.list.map((x, i) => [i ? h('i', null, '→') : null, h('span', null, x.ms.name)])) : null;
  const kids = [
    h('div', { class: 'ms-rays' }),
    h('div', { class: 'ms-medal' }, h('span', null, '🏆')),
    h('div', { class: 'ms-kicker' }, MS.list.length > 1 ? MS.list.length + ' milestones reached' : 'Milestone reached'),
    h('div', { class: 'ms-title', html: `🎉 ${esc((S && S.name) || 'Your city')} is now a <em>${esc(top.name)}</em>!` }),
    path,
    reward && !(S && S.sandbox) ? h('div', { class: 'ms-reward' }, h('span', null, '💰'), `+${VC.fmt.money(reward)} city grant`) : null,
    unl.length ? h('div', { class: 'ms-unl-title' }, '✨ Newly unlocked') : null,
    unl.length ? chips : null,
    h('button', { class: 'btn primary ms-ok', onclick: (e) => { e.stopPropagation(); closeBanner(); } }, 'Hooray!'),
  ];
  if (fresh) {
    if (MS.banner) MS.banner.remove();
    MS.banner = h('div', { class: 'ms-banner pe', onclick: closeBanner }, kids);
    VC.hud.root.appendChild(MS.banner);
    confetti();
  } else {
    MS.banner.innerHTML = '';
    MS.banner.append(...kids.filter(Boolean));
    MS.banner.classList.add('merged');
  }
  fitBanner();
}
function confetti() {
  if (VC.hud.root.querySelector('.confetti')) return; // one shower at a time
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
/* ACHIEVEMENTS / MONEY                                                */
/* ================================================================== */
function onAchievement(a) {
  if (!a || !live()) return;
  VC.ui.toast(`<b>Achievement unlocked!</b><br>${esc(a.icon || '🏅')} ${esc(a.name || a.key || '')}`, { cls: 'toast-achv', icon: '🏆', duration: 6500 });
}
function onNoMoney(e) {
  if (!live()) return;
  const now = performance.now();
  VC.hud.flashFunds();
  if (now - lastNoMoney < 2000) return;
  lastNoMoney = now;
  const amt = e && finite(+e.amount) && +e.amount > 0 ? ` This costs ${VC.fmt.money(+e.amount)}.` : '';
  VC.ui.toast(`<b>Not enough money!</b>${amt}`, { type: 'bad', icon: '💸', duration: 3200 });
}
/** The HUD owns these popups: the advisors module must not toast them as well. */
function claimNotifications() {
  const A = VC.advisors;
  if (!A) return;
  A.toastAchievements = false;
  A.toastMilestones = false;
}

/* ================================================================== */
/* JUICE: rewarding growth feedback (never spammy)                      */
/* ================================================================== */
/*
 * Derived only from existing events + cheap polling (the sim emits nothing new):
 *   - construction: buildings with built < 1 are tracked from bldAdd / bldChange (a sim level-up or
 *     redevelopment replays the construction) and polled every 0.25 s; a finished RESIDENTIAL lot joins the
 *     move-in list (polled every 0.5 s for up to 60 game days): each bulk gain (>= 30 % of its capacity, at
 *     least 3 residents) floats "+N 👥" from its roof.
 *   - level-ups (bldChange with b.level above the level seen before, growables only): "⭐ Level N!", plus
 *     "💰 +$" and a small shower of 'coin' particles for commercial / industrial. The sparkle burst is the
 *     particle module's own level-up effect and the 'levelup' sound comes from the sim (no sound here).
 *   - month end (a profitable month, at most every 6 s real time, never in sandbox): ONE gentle 'chaching'
 *     (skipped while a milestone banner celebrates), a coin shower over the busiest commercial building on
 *     screen and a few gold coins hopping out of the funds display (the HUD floats the "+$1,234" delta there).
 *   - milestone progress: every 25 % of the way to the next milestone (peak population) -> tiny confetti at
 *     the camera target, a "🎯 50% of the way to Town" pill under the top bar and a soft 'progress' chime.
 *     Crossing a milestone itself celebrates nothing here (the milestone banner does).
 * World pills are pooled DOM elements placed by VC.gfx.onFrame (after each rendered frame, with that frame's
 * camera: the VC.camera.worldToScreen projection, done in place without allocating), so they stay glued to
 * the 3D image. Only buildings within ~70 units of the camera eye whose anchor projects into the safe screen
 * area (clear of the top bar and the tool bar) get one. Rate: token bucket (2.5 / s, burst 3; level-ups have
 * priority over move-ins), one pill per building per ~2 s, a pool of 10. Lifetimes are real time (the rise /
 * fade is the CSS animation jpRise, 1.75 s). Nothing while VC.state.demo, the title menu, photo / hidden UI,
 * or with VC.settings.juice === false (read defensively: missing = on). No state is saved: progress quarters
 * are re-derived on reset (loading a city never celebrates).
 */
const J = {
  layer: null, pool: [], live: [], coins: [], msPill: null, msTimer: 0,
  tokens: 3, tokT: 0, unhook: null, hold: false,
  building: new Map(), moveIn: new Map(), levels: new Map(), lastPop: new Map(), // building: id -> pop at start
  pollB: 0, pollM: 0, pollMs: 0, monthPending: false, lastMonthFx: -1e9, msIdx: -1, msQ: 0,
};
const JUICE_POOL = 10;
const JUICE_LIFE = 1750; // ms: the jpRise animation (base.css)
const JUICE_RATE = 2.5, JUICE_BURST = 3; // pills per second (token bucket)
const JUICE_DIST2 = 70 * 70; // world units from the camera eye
const JUICE_BLD_GAP = 2200; // ms between two pills of the same building
const MONTH_FX_GAP = 6000; // ms between two month-end effects
/** Juice is live: a real city with the HUD showing (not photo / hidden UI) and VC.settings.juice not false. */
function juiceOn() {
  const st = VC.settings, H = VC.hud;
  if (st && st.juice === false) return false;
  return live() && !H.uiHidden && !H.photo;
}
/** Pill text with emoji, or the plain variant without a colour-emoji font (VC.ui.hasEmoji false). */
const jt = (emo, plain) => (VC.ui && VC.ui.hasEmoji === false ? plain : emo);

function buildJuice(root) {
  J.layer = h('div', { class: 'juice', 'aria-hidden': 'true' });
  root.insertBefore(J.layer, root.firstChild); // first in the HUD: pills paint under every other HUD element
  for (let i = 0; i < JUICE_POOL; i++) {
    const inner = h('div', { class: 'jp-in' });
    const el = h('div', { class: 'jp' }, inner);
    el.style.display = 'none';
    J.layer.appendChild(el);
    J.pool.push({ el, inner, x: 0, y: 0, z: 0, ox: 0, oy: 0, t0: 0, end: 0, sx: NaN, sy: NaN, cls: '', shown: false, vis: true });
  }
  // placement after each rendered frame (same camera as the image); older cores: in update()
  if (VC.gfx && VC.gfx.onFrame) J.unhook = VC.gfx.onFrame(placePopups);
}
/** Hides every live pill / coin / progress pill (pooled pills go back to the pool). */
function clearPopups() {
  for (const p of J.live) { p.el.style.display = 'none'; J.pool.push(p); }
  J.live.length = 0;
  for (const c of J.coins) c.remove();
  J.coins.length = 0;
  clearTimeout(J.msTimer);
  if (J.msPill) { J.msPill.remove(); J.msPill = null; }
}
function resetJuice(S) {
  clearPopups();
  J.building.clear();
  J.moveIn.clear();
  J.levels.clear();
  J.lastPop.clear();
  J.monthPending = false;
  J.tokens = JUICE_BURST;
  if (!S) return;
  for (const b of S.buildings.values()) {
    J.levels.set(b.id, b.level);
    if (b.built < 1) J.building.set(b.id, b.pop || 0);
  }
  const m = msProgress(S);
  J.msIdx = m ? m.idx : -1;
  J.msQ = m ? m.q : 0;
}

/* ---- screen projection ---- */
const PRJ = { x: 0, y: 0 };
/**
 * VC.camera.worldToScreen(x, y, z) into PRJ (canvas CSS px) without allocating; false when behind the camera
 * or more than `margin` px off screen.
 */
function project(x, y, z, margin) {
  const cam = VC.camera, m = cam && cam.viewProj, cv = VC.gfx && VC.gfx.canvas;
  if (!m || !cv) return false;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (w <= 0.01) return false;
  const W = cv.clientWidth, H = cv.clientHeight;
  PRJ.x = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w * 0.5 + 0.5) * W;
  PRJ.y = (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w * 0.5) * H;
  return PRJ.x > -margin && PRJ.x < W + margin && PRJ.y > -margin && PRJ.y < H + margin;
}
/** PRJ lies in the popup-safe screen area (clear of the top bar and the tool bar). */
function safeOnScreen() {
  const cv = VC.gfx.canvas;
  return PRJ.y > 80 && PRJ.y < cv.clientHeight - 100 && PRJ.x > 24 && PRJ.x < cv.clientWidth - 24;
}
/**
 * World Y to anchor a pill on building b (above the roof; for a tall building seen from close up part-way
 * up, else just above the ground), or NaN when b is farther than ~70 units from the camera eye or no anchor
 * is in the safe screen area.
 */
function bldAnchor(b) {
  const cam = VC.camera, pos = cam && cam.pos;
  if (!pos || !VC.world) return NaN;
  const x = b.x + b.w * 0.5, z = b.z + b.d * 0.5, gy = VC.world.topY(b.x, b.z), hg = b.hgt || 1;
  const dx = x - pos[0], dy = gy + hg * 0.5 - pos[1], dz = z - pos[2];
  if (dx * dx + dy * dy + dz * dz > JUICE_DIST2) return NaN;
  let y = gy + hg + 0.35;
  if (project(x, y, z, 0) && safeOnScreen()) return y;
  y = gy + hg * 0.55;
  if (hg > 2.5 && project(x, y, z, 0) && safeOnScreen()) return y;
  y = gy + 0.9;
  if (project(x, y, z, 0) && safeOnScreen()) return y;
  return NaN;
}
/**
 * Takes a pill token (rate limit). reserve: tokens that must stay in the bucket afterwards (low-priority
 * pills leave room for level-ups).
 */
function juiceToken(reserve) {
  if (!J.pool.length) return false;
  const now = performance.now();
  J.tokens = Math.min(JUICE_BURST, J.tokens + (Math.max(0, now - J.tokT) / 1000) * JUICE_RATE);
  J.tokT = now;
  if (J.tokens < 1 + (reserve || 0)) return false;
  J.tokens -= 1;
  return true;
}
/** Building b had no pill for a while (pills of one building never stack). */
function bldFree(b, now) {
  const t = J.lastPop.get(b.id);
  return t == null || now - t > JUICE_BLD_GAP;
}
/**
 * Floats a pill (text, class) rising from world point (x, y, z). delay: ms before it appears; ox, oy: screen
 * offset in px (x UI scale), e.g. to set a second pill of the same building beside the first.
 */
function popAt(x, y, z, text, cls, delay, ox, oy) {
  const p = J.pool.pop();
  if (!p) return null;
  p.x = x; p.y = y; p.z = z;
  p.ox = ox || 0; p.oy = oy || 0;
  p.t0 = performance.now() + (delay || 0);
  p.end = p.t0 + JUICE_LIFE + 1500; // (a pill that never got a frame to appear in is dropped anyway)
  p.sx = p.sy = NaN;
  p.shown = false;
  p.inner.textContent = text;
  if (p.cls !== cls) { p.inner.className = 'jp-in ' + cls; p.cls = cls; }
  p.el.style.display = 'none';
  J.live.push(p);
  if (!J.unhook) placePopups();
  return p;
}
function recycle(i) {
  const p = J.live[i];
  p.el.style.display = 'none';
  J.live.splice(i, 1);
  J.pool.push(p);
}
/** Expires pills (real time, from the moment they appeared). Also runs from update(). */
function expirePopups(now) {
  if (J.hold) return;
  for (let i = J.live.length - 1; i >= 0; i--) if (now >= J.live[i].end) recycle(i);
}
/**
 * Places the live pills for the frame just rendered (VC.gfx.onFrame). A pill appears (display: the CSS
 * rise / fade starts) at its start time; off screen it is only made invisible, so its animation keeps its
 * place in time.
 */
function placePopups() {
  if (!J.live.length) return;
  const now = performance.now();
  expirePopups(now);
  const us = J.live.length ? VC.ui.scale() : 1;
  for (let i = 0; i < J.live.length; i++) {
    const p = J.live[i];
    if (now < p.t0) continue;
    const on = project(p.x, p.y, p.z, 80);
    if (on) {
      const sx = Math.round((PRJ.x + p.ox * us) * 2) / 2, sy = Math.round((PRJ.y + p.oy * us) * 2) / 2;
      if (sx !== p.sx || sy !== p.sy) {
        p.sx = sx; p.sy = sy;
        p.el.style.translate = sx + 'px ' + sy + 'px';
      }
    }
    if (on !== p.vis) { p.vis = on; p.el.style.visibility = on ? '' : 'hidden'; }
    if (!p.shown) {
      // display none -> shown restarts the jpRise animation; the pill lives as long as it runs
      p.shown = true;
      p.end = now + JUICE_LIFE;
      if (p.el !== J.layer.lastElementChild) J.layer.appendChild(p.el); // the newest pill paints on top
      p.el.style.display = '';
    }
  }
}

/* ---- construction / move-in / level-ups ---- */
function onJuiceBldAdd(b) {
  if (!b) return;
  J.levels.set(b.id, b.level);
  if (b.built < 1) J.building.set(b.id, b.pop || 0);
}
function onJuiceBldRemove(b) {
  if (!b) return;
  J.levels.delete(b.id);
  J.building.delete(b.id);
  J.moveIn.delete(b.id);
  J.lastPop.delete(b.id);
}
function onJuiceBldChange(b) {
  if (!b) return;
  if (b.built < 1 && !J.building.has(b.id)) J.building.set(b.id, b.pop || 0); // (a replay keeps its residents)
  const prev = J.levels.get(b.id);
  J.levels.set(b.id, b.level);
  if (prev == null || !(b.level > prev) || b.key !== 'grow' || b.abandoned || !juiceOn()) return;
  const y = bldAnchor(b);
  if (y !== y || !juiceToken(0)) return;
  const x = b.x + b.w * 0.5, z = b.z + b.d * 0.5;
  J.lastPop.set(b.id, performance.now());
  popAt(x, y, z, jt('⭐ Level ' + b.level + '!', 'Level ' + b.level + '!'), 'jp-lvl', 0);
  if (b.zt === 2 || b.zt === 3) {
    // the money side of it: a second pill beside the first (no extra token: same event) + coins
    popAt(x, y, z, jt('💰 +$', '+$'), 'jp-cash', 400, 72, 22);
    const Pt = VC.particles;
    if (Pt && Pt.coins) Pt.coins(x, y - 0.2, z, 8 + b.w * b.d * 2);
  }
}
function pollBuilding(S) {
  if (!J.building.size) return;
  for (const [id, pop0] of J.building) {
    const b = S.buildings.get(id);
    if (!b) { J.building.delete(id); continue; }
    if (b.built < 1) continue;
    J.building.delete(id);
    // residents of a finished (or rebuilt) home arrive over the next days: watch them move in (a level-up's
    // replay already takes new residents in while it builds: they count from its start)
    if (b.key === 'grow' && b.zt === 1 && !b.abandoned) J.moveIn.set(id, { shown: Math.min(pop0, b.pop || 0), until: S.time.day + 60 });
  }
}
function pollMoveIn(S) {
  if (!J.moveIn.size) return;
  const on = juiceOn(), day = S.time.day, now = performance.now();
  for (const [id, m] of J.moveIn) {
    const b = S.buildings.get(id);
    if (!b || b.abandoned || day > m.until) { J.moveIn.delete(id); continue; }
    const pop = b.pop || 0, gain = pop - m.shown;
    if (gain < 0) { m.shown = pop; continue; }
    const full = b.cap > 0 && pop >= b.cap * 0.95;
    if (gain >= Math.max(3, Math.ceil((b.cap || 0) * 0.3)) || (full && gain >= 1)) {
      // shown or not (off screen, rate limit), these residents are counted: no pill for stale gains later
      m.shown = pop;
      if (on && bldFree(b, now)) {
        const y = bldAnchor(b);
        if (y === y && juiceToken(1)) {
          J.lastPop.set(id, now);
          const n = '+' + VC.fmt.num(gain);
          popAt(b.x + b.w * 0.5, y, b.z + b.d * 0.5, jt(n + ' 👥', n + (gain === 1 ? ' resident' : ' residents')), 'jp-pop', 0);
        }
      }
    }
    if (full) J.moveIn.delete(id);
  }
}

/* ---- month end: cha-ching ---- */
function monthJuice(S) {
  const now = performance.now();
  if (S.sandbox || now - J.lastMonthFx < MONTH_FX_GAP) return;
  const net = +((S.stats || {}).net);
  if (!(net > 0)) return;
  J.lastMonthFx = now;
  // one sound per event: a milestone banner that just went up is the bigger news
  if (!(MS.banner && !MS.banner._closed)) VC.bus.emit('sfx', { name: 'chaching' });
  // coins over the busiest commercial building on screen
  let best = null, bp = 0, by = 0;
  for (const b of S.buildings.values()) {
    if (b.key !== 'grow' || b.zt !== 2 || b.built < 1 || b.abandoned || !(b.pop > bp)) continue;
    const y = bldAnchor(b);
    if (y !== y) continue;
    best = b;
    bp = b.pop;
    by = y;
  }
  const Pt = VC.particles;
  if (best && Pt && Pt.coins) Pt.coins(best.x + best.w * 0.5, by, best.z + best.d * 0.5, 16);
  coinSpray();
}
/** A few gold coins hopping out of the funds display (DOM, CSS-animated). */
function coinSpray() {
  const seg = VC.hud.root && VC.hud.root.querySelector('.tb-money');
  if (!seg || !J.layer) return;
  const r = seg.getBoundingClientRect(), lr = J.layer.getBoundingClientRect();
  if (!r.width) return;
  for (const c of J.coins) c.remove();
  J.coins.length = 0;
  const x0 = r.left - lr.left + Math.min(26, r.width * 0.25), y0 = r.top - lr.top + r.height * 0.55;
  const done = (c) => {
    c.remove();
    const k = J.coins.indexOf(c);
    if (k >= 0) J.coins.splice(k, 1);
  };
  for (let i = 0; i < 8; i++) {
    const c = h('i', { class: 'jc', onanimationend: () => done(c) });
    const s = c.style;
    s.left = x0 + 'px';
    s.top = y0 + 'px';
    // a short hop out of the funds display, then a fall past the top bar into the city
    s.setProperty('--dx', Math.round((Math.random() * 2 - 1) * 50 + 8) + 'px');
    s.setProperty('--dy', Math.round(-8 - Math.random() * 16) + 'px');
    s.setProperty('--fall', Math.round(58 + Math.random() * 40) + 'px');
    s.setProperty('--spin', Math.round(360 + Math.random() * 540) + 'deg');
    s.animationDelay = (i * 0.045).toFixed(3) + 's';
    J.layer.appendChild(c);
    J.coins.push(c);
  }
  const mine = J.coins.slice();
  setTimeout(() => { for (const c of mine) if (c.isConnected) done(c); }, 3000); // (no animationend: tab hidden)
}

/* ---- milestone progress ---- */
/** {idx, q (quarters 0..3 of the way to the next milestone), next} or null at the last milestone. */
function msProgress(S) {
  const L = VC.MILESTONES;
  if (!S || !L || !L.length) return null;
  const idx = VC.hud.milestoneIndex ? VC.hud.milestoneIndex(S) : S.milestone | 0;
  const cur = L[idx], next = L[idx + 1];
  if (!cur || !next) return null;
  const p = ((S.peakPop || 0) - (cur.pop || 0)) / Math.max(1, next.pop - (cur.pop || 0));
  return { idx, q: VC.M.clamp(Math.floor(p * 4), 0, 3), next };
}
function pollMilestone(S) {
  const m = msProgress(S);
  if (!m) return;
  if (m.idx !== J.msIdx) { J.msIdx = m.idx; J.msQ = m.q; return; } // the milestone itself has its banner
  if (m.q <= J.msQ) return;
  J.msQ = m.q;
  if (!juiceOn()) return;
  const cam = VC.camera;
  if (VC.fx && VC.fx.confetti && cam) VC.fx.confetti(cam.tx, cam.tz, 24);
  VC.bus.emit('sfx', { name: 'progress' });
  clearTimeout(J.msTimer);
  if (J.msPill) J.msPill.remove();
  const pill = h('div', { class: 'jms pe', role: 'status', onclick: () => VC.hud.openPanel && VC.hud.openPanel('milestones') },
    h('b', null, jt('🎯 ', '') + m.q * 25 + '%'), ' of the way to ', h('em', null, m.next.name || 'the next milestone'));
  J.layer.appendChild(pill);
  J.msPill = pill;
  J.msTimer = setTimeout(() => { pill.remove(); if (J.msPill === pill) J.msPill = null; }, 4300);
}

function updateJuice(dt, rdt) {
  const S = VC.state;
  if (!S || !J.layer) return;
  if (J.live.length) {
    if (J.unhook) expirePopups(performance.now());
    else placePopups();
  }
  if (isDemo()) return;
  if ((J.pollB += rdt) >= 0.25) { J.pollB = 0; pollBuilding(S); }
  if ((J.pollM += rdt) >= 0.5) { J.pollM = 0; pollMoveIn(S); }
  if ((J.pollMs += rdt) >= 1) { J.pollMs = 0; pollMilestone(S); }
  if (J.monthPending) {
    J.monthPending = false;
    if (juiceOn()) monthJuice(S);
  }
}

/* ================================================================== */
VC.hud.register({
  name: 'notify',
  order: 30,
  init(root) {
    buildTicker(root);
    buildJuice(root);
    const bus = VC.bus;
    bus.on('news', (n) => { if (!isDemo()) pushNews(n && (n.text || n), true); });
    bus.on('advisor', onAdvisor);
    bus.on('disaster', onDisaster);
    bus.on('milestone', onMilestone);
    bus.on('unlock', onUnlock);
    // legacy event (older advisors): only remembered so the milestone banner does not repeat those items
    bus.on('unlocked', (e) => { for (const u of (e && e.items) || []) if (u && u.key != null) MS.announced.add(String(u.key)); });
    bus.on('achievement', onAchievement);
    bus.on('noMoney', onNoMoney);
    bus.on('settings', applyTickerSetting);
    bus.on('settings', () => { if (VC.settings && VC.settings.juice === false) clearPopups(); });
    bus.on('bldAdd', onJuiceBldAdd);
    bus.on('bldRemove', onJuiceBldRemove);
    bus.on('bldChange', onJuiceBldChange);
    bus.on('month', () => { if (!isDemo()) J.monthPending = true; }); // handled next frame (econ has booked it)
    bus.on('started', (S) => {
      if (!S || S.demo || !VC.audio || !VC.audio.warm) return;
      try { VC.audio.warm(['chaching', 'progress']); } catch (e) { /* sounds render on first use instead */ }
    });
    window.addEventListener('resize', () => { if (MS.banner && !MS.banner._closed) fitBanner(); });
    VC.ui.toastAvoid.push(bannerRect);
    claimNotifications();
  },
  reset(S) {
    claimNotifications();
    resetJuice(S);
    TK.queue = [];
    TK.recent = [];
    for (const c of NOTE.cards.slice()) c.close(true);
    NOTE.cards = [];
    NOTE.queue = [];
    NOTE.lastAdvAt = -1e9;
    clearTimeout(MS.timer);
    if (MS.banner) MS.banner.remove();
    MS.banner = null;
    MS.list = [];
    MS.unlocks = [];
    MS.announced.clear();
    unfitBanner();
    const cf = VC.hud.root && VC.hud.root.querySelector('.confetti');
    if (cf) cf.remove();
  },
  update(dt, rdt) {
    tickerUpdate(rdt);
    if (NOTE.queue.length) pumpNotes();
    updateJuice(dt, rdt);
  },
  onShow() { TK.viewW = 0; },
  onHide() {
    for (const c of NOTE.cards.slice()) c.close(true);
    NOTE.queue = [];
    closeBanner();
    clearPopups();
  },
});

const juiceApi = {
  /** Floats a pill (plain text) from world point (x, y, z); cls: 'jp-pop' | 'jp-cash' | 'jp-lvl' | ''. */
  pop(x, y, z, text, cls) {
    if (!juiceOn() || !isFinite(x + y + z) || !juiceToken(0)) return false;
    return !!popAt(x, y, z, String(text == null ? '' : text), cls || '', 0);
  },
  /** Live counts (debug / tests). */
  stats: () => ({ live: J.live.length, shown: J.live.filter((p) => p.shown && p.vis).length, pool: J.pool.length, building: J.building.size, moveIn: J.moveIn.size, levels: J.levels.size, msQ: J.msQ, msIdx: J.msIdx, tokens: +J.tokens.toFixed(2), on: juiceOn() }),
  /** Texts of the pills on screen now (tests). */
  texts: () => J.live.filter((p) => p.shown && p.vis).map((p) => p.inner.textContent),
  /** (tests) runs the month-end effect now, ignoring the 6 s gap. */
  month() { J.lastMonthFx = -1e9; if (VC.state && juiceOn()) monthJuice(VC.state); },
  /** (tests / screenshots) true keeps pills alive until hold(false). */
  hold(on) { J.hold = !!on; },
  /** (tests) polls construction / move-in / milestone progress now. */
  poll() { const S = VC.state; if (S && !isDemo()) { pollBuilding(S); pollMoveIn(S); pollMilestone(S); } },
};
Object.assign(VC.hud, { pushNews, showMilestone, unlocksBetween, describeUnlocks, showNote, juice: juiceApi });
