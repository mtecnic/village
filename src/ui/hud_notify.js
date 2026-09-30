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
 * API (on VC.hud): pushNews(text, breaking?), showMilestone(index, milestone?, unlockItems?),
 *   unlocksBetween(popLo, popHi), describeUnlocks(keys) -> [{key, icon, name, kind}], showNote(n)
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
  const a = (VC.ADVISORS && VC.ADVISORS[m.advisor]) || { name: 'City Advisor', role: '', icon: '🧑‍💼', color: '#5ad1ff' };
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
VC.hud.register({
  name: 'notify',
  order: 30,
  init(root) {
    buildTicker(root);
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
    window.addEventListener('resize', () => { if (MS.banner && !MS.banner._closed) fitBanner(); });
    VC.ui.toastAvoid.push(bannerRect);
    claimNotifications();
  },
  reset() {
    claimNotifications();
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
  },
  onShow() { TK.viewW = 0; },
  onHide() {
    for (const c of NOTE.cards.slice()) c.close(true);
    NOTE.queue = [];
    closeBanner();
  },
});

Object.assign(VC.hud, { pushNews, showMilestone, unlocksBetween, describeUnlocks, showNote });
