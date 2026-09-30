/*
 * VOXELPOLIS — save / load / export / import / autosave (VC.save). Format + compression: io/save_codec.js.
 *
 * STORAGE: localStorage 'voxelpolis.save.<slot>' = storage string (see codec), plus the index
 *   'voxelpolis.saves' = [{slot, name, city, cityId, pop, money, day, savedAt, time, thumb, mapType, size,
 *   difficulty, milestone, bytes, auto}] (thumb = small JPEG data URL from VC.gfx.capture). When storage
 *   is blocked (e.g. Safari on file://) an in-memory store is used for the session and the player is
 *   told to use Export. Quota errors are reported with a toast that suggests Export / deleting saves.
 *
 * CITY ID: every real city carries a stable S.cityId (created when it starts, saved with the state), so
 *   all saves of one city can be grouped: list() entries carry `cityId` (null for old saves).
 * AUTOSAVE: slot 'autosave:<cityId>' — ONE rolling backup PER CITY, so starting or loading another city
 *   never overwrites this city's backup (the old shared slot 'autosave' stays listed and loadable). At most
 *   VC.save.autosaveKeep autosave slots are kept (oldest removed); when storage is full, an autosave first
 *   evicts the oldest autosave of another city (manual saves are never touched). Automatic triggers run
 *   only with VC.settings.autosave !== false, never for the title-screen demo city or an untouched map, and
 *   only when the city changed since it was last saved (buildings, terrain, day, money, taxes, budget, …):
 *     - every VC.save.autosaveMonths game months (at most once per autosaveMinMs real time)
 *     - every VC.save.autosaveEveryMs real time (5 min), also while paused
 *     - when the tab becomes hidden (async), and synchronously (JS gzip, quiet) on beforeunload / pagehide
 *     - for the old city when another state replaces it (new game, load, import, main menu)
 *   A quiet "Autosaved" toast (no sound) shows at most every autosaveToastMs.
 *   OFF THE CRITICAL PATH: the month / timer autosaves never run inside the sim's month tick. They start
 *   a frame later and take the snapshot in slices of ~3 ms from the frame loop (codec.snapshotGen) while
 *   the sim holds its day ticks (VC.sim._.hold), so the city cannot change under it; a world edit in the
 *   meantime (player, disaster) restarts it (after 3 tries it waits for the next trigger). Compression
 *   is async (CompressionStream). Autosaves capture NO thumbnail (a canvas capture stalls the GPU
 *   pipeline): the entry reuses this city's latest thumbnail; manual saves capture one.
 * WHOLE DAYS: every snapshot of the running city (save, quick save, sliced / sync autosave, serialize,
 *   encode / export) first finishes a sim day the frame loop left half-done (VC.sim.finishDay), so a save
 *   never holds half a day or a month boundary whose billing has not run yet.
 * PAUSE MENU: while it is open (or after it paused the game) a save stores the speed the game resumes at
 *   (VC.menu.resumeSpeed() when available, else the speed before the menu paused), so it never loads paused.
 *
 * API (all async calls resolve false on failure after telling the player why; they never reject):
 *   serialize(S) -> object            deserialize(obj) -> S (throws Error(.friendly) on corrupt data)
 *   save(slot, name?, opts?) -> Promise<bool>   opts {auto, quiet, thumb:false, force (allow demo), toast}
 *   load(slot, opts?) -> Promise<bool>          (VC.startState + camera restore + toast "Loaded …")
 *   list() -> index entries (+cityId), newest first (sync)   latest()   has(slot)   remove(slot)   rename(slot, name)
 *   exportFile(slot?) / exportBlob(slot?) -> {blob, name, text}   (slot omitted = the running city)
 *   importFile() -> Promise<bool> (file picker)   importText(text|bytes) -> Promise<bool>
 *   parse(text|bytes|object) -> Promise<S> (no start)   encode(S) -> Promise<storage string>
 *   quickSave() / quickLoad()   autosave() -> Promise<bool> (now, to this city's slot)   autosaveSync() -> bool
 *   cityId(S?)   autosaveSlot(S?)   isAutoSlot(slot)   changed(S?)
 *   register(key, {save(S) -> json, load(S, data)})   selfTest()   storageInfo()
 * Slot 'quick' = Ctrl+S (input.js normally calls save('quick'); this module only handles Ctrl+S itself if
 * nothing else prevented the key's default).
 * Toasts: suppressed while the 'save' manager window is open (the panel reports results itself).
 * Bus: emits 'saved' {slot, name, auto, bytes, cityId}, 'loaded' {slot, name}, 'saveFailed' {slot, reason}.
 */
const PREFIX = 'voxelpolis.save.', INDEX_KEY = 'voxelpolis.saves';
const THUMB_W = 200;
let store = null; // window.localStorage when usable
let memory = null; // Map fallback (session only)
let indexCache = null;
let chain = Promise.resolve();
let monthsSince = 0, lastAutoAt = 0, lastAutoToast = -1e9, nextCheck = 0, unloadAt = -1e9;
let warnedMemory = false, warnedQuota = false;
const hooks = Object.create(null);
const AUTO_PREFIX = 'autosave:';
const CITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
let cur = null; // the running real (non-demo) city
let saved = null; // {S, fp}: fingerprint of `cur` when it started or was last written to storage
let lastSpeed = 1; // last speed seen on the bus (to know what the pause menu paused from)
let menuPause = null; // {S, from}: the pause menu paused S, which was running at speed `from`

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function toast(text, type, icon, duration, extra) {
  VC.bus.emit('toast', Object.assign({ text, type: type || 'info', icon: icon || '💾', duration }, extra));
}
/** The save manager window reports results itself; avoid double toasts while it is open. */
const panelOpen = () => !!(VC.ui && VC.ui.isOpen && VC.ui.isOpen('save'));
const codec = () => VC.save.codec;
const friendlyMsg = (e, fallback) => (e && e.friendly ? e.message : fallback);
const isQuota = (e) => !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
function normSlot(slot) {
  const s = String(slot == null ? 'quick' : slot).trim().slice(0, 64);
  return s || 'quick';
}
function fileName(name) {
  const s = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || 'Voxelpolis';
}

/* ------------------------------------------------------------------ */
/* Key/value storage with memory fallback                               */
/* ------------------------------------------------------------------ */
function detectStorage() {
  try {
    const ls = window.localStorage;
    if (!ls) return null;
    ls.getItem(INDEX_KEY); // throws SecurityError where blocked
    try {
      ls.setItem('voxelpolis.__probe', '1');
      ls.removeItem('voxelpolis.__probe');
    } catch (e) {
      if (!isQuota(e)) return null; // full but readable: keep it (existing saves stay loadable)
    }
    return ls;
  } catch (e) {
    return null;
  }
}
function useMemory() {
  if (!memory) memory = new Map();
}
function sget(k) {
  if (store) {
    try {
      const v = store.getItem(k);
      if (v != null) return v;
    } catch (e) { /* ignore */ }
  }
  return memory && memory.has(k) ? memory.get(k) : null;
}
/** Writes a value. Throws quota errors; other storage failures switch to the memory store. */
function sset(k, v) {
  if (store) {
    try {
      store.setItem(k, v);
      if (memory) memory.delete(k);
      return 'local';
    } catch (e) {
      if (isQuota(e)) throw e;
      store = null; // storage became unusable (privacy mode etc.)
    }
  }
  useMemory();
  memory.set(k, v);
  return 'memory';
}
function sdel(k) {
  if (store) try { store.removeItem(k); } catch (e) { /* ignore */ }
  if (memory) memory.delete(k);
}
function storedSlots() {
  const out = new Set();
  if (store) {
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith(PREFIX)) out.add(k.slice(PREFIX.length));
      }
    } catch (e) { /* ignore */ }
  }
  if (memory) for (const k of memory.keys()) if (k.startsWith(PREFIX)) out.add(k.slice(PREFIX.length));
  return out;
}

/* ------------------------------------------------------------------ */
/* Index                                                                */
/* ------------------------------------------------------------------ */
function readIndex() {
  if (indexCache) return indexCache;
  let arr = null;
  const raw = sget(INDEX_KEY);
  if (raw) try { arr = JSON.parse(raw); } catch (e) { arr = null; }
  if (!Array.isArray(arr)) arr = [];
  const present = storedSlots();
  const seen = new Set();
  arr = arr.filter((e) => {
    if (!e || typeof e !== 'object' || e.slot == null) return false;
    const s = String(e.slot);
    if (!present.has(s) || seen.has(s)) return false;
    seen.add(s);
    e.slot = s;
    return true;
  });
  // saves whose index entry got lost still show up (without details)
  for (const s of present) if (!seen.has(s)) arr.push({ slot: s, name: s, savedAt: 0, auto: isAutoSlot(s), cityId: cityIdOfSlot(s) });
  indexCache = arr;
  return arr;
}
/** Persists the index; drops thumbnails (oldest first) if storage is too full for them. */
function writeIndex(arr) {
  indexCache = arr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      sset(INDEX_KEY, JSON.stringify(arr));
      return true;
    } catch (e) {
      if (!isQuota(e)) return false;
      if (attempt === 0) {
        const withThumb = arr.filter((x) => x.thumb).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
        for (let i = 0; i < Math.ceil(withThumb.length / 2); i++) withThumb[i].thumb = null;
      } else for (const x of arr) x.thumb = null;
    }
  }
  return false;
}
/** Newest thumbnail stored for a city (any slot), or null. */
function cityThumb(cityId) {
  if (!cityId) return null;
  let best = null;
  for (const e of readIndex()) if (e.thumb && e.cityId === cityId && (!best || (e.savedAt || 0) > (best.savedAt || 0))) best = e;
  return best ? best.thumb : null;
}
function entryOf(slot) {
  const s = String(slot);
  return readIndex().find((e) => e.slot === s) || null;
}
function dropSlot(slot) {
  sdel(PREFIX + slot);
  writeIndex(readIndex().filter((e) => e.slot !== slot));
}

/* ------------------------------------------------------------------ */
/* City identity, change tracking, per-city autosave slots              */
/* ------------------------------------------------------------------ */
function isAutoSlot(slot) {
  const s = String(slot);
  return s === 'autosave' || s.startsWith(AUTO_PREFIX);
}
function cityIdOfSlot(slot) {
  const s = String(slot);
  return s.startsWith(AUTO_PREFIX) ? s.slice(AUTO_PREFIX.length) : null;
}
function newCityId() {
  let r = '';
  try {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    r = a[0].toString(36) + a[1].toString(36);
  } catch (e) {
    r = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  return 'c' + Date.now().toString(36) + r.slice(0, 10);
}
/** Stable id of a city (created on first use and stored in the state, so it travels with every save). */
function cityIdOf(S) {
  if (!S) return null;
  if (typeof S.cityId !== 'string' || !CITY_ID_RE.test(S.cityId)) S.cityId = newCityId();
  return S.cityId;
}
const autoSlotOf = (S) => AUTO_PREFIX + cityIdOf(S);
/** Cheap summary of everything a player can change (compared to decide whether a city needs saving). */
function fingerprint(S) {
  const v = S.ver || {}, t = S.time || {};
  let f = [v.terrain, v.bld, v.trees, t.day, Math.round(S.money || 0), S.name, S.buildings ? S.buildings.size : 0, S.nextId, S.loans ? S.loans.length : 0, S.disastersEnabled].join('|');
  try { f += JSON.stringify(S.tax) + JSON.stringify(S.budget) + JSON.stringify(S.policies); } catch (e) { /* ignore */ }
  return f;
}
/** True when S changed since it started or was last saved (unknown states count as changed). */
function changedSinceSave(S) {
  return !saved || saved.S !== S || saved.fp !== fingerprint(S);
}
/** A freshly generated map nobody built on is not worth a backup. */
function isEmptyCity(S) {
  if (S.buildings && S.buildings.size) return false;
  const r = S.road, z = S.zone;
  if (!r || !z) return false;
  for (let i = 0; i < r.length; i++) if (r[i] || z[i]) return false;
  return true;
}
/** Automatic saves are allowed for this state (real city, setting on). */
function autoOK(S) {
  return !!(S && S.buildings && S.height && S.time && !S.demo) && !(VC.settings && VC.settings.autosave === false);
}
/**
 * Speed index to store. A game paused by the pause menu stores the speed it resumes at, so a city saved
 * from the pause menu (or backed up while leaving through it) does not load paused.
 */
function storedSpeed(S) {
  const t = S.time;
  if (t.speed > 0) return t.speed;
  const m = VC.menu;
  if (S === VC.state && m && typeof m.resumeSpeed === 'function' && (!m.isPaused || m.isPaused())) {
    const v = m.resumeSpeed();
    if (v != null && Number.isFinite(+v)) return +v;
  }
  if (menuPause && menuPause.S === S) return menuPause.from;
  return t.speed;
}
/**
 * The running city may be in the middle of a staged sim day (a big city's day can span frames; on a
 * month's last day the billing runs in the day's final slice): finish it first, so a save never holds
 * half a day or skips a month's billing. Only for the running city (VC.sim.finishDay ignores others).
 */
function wholeDay(S) {
  if (!S || S !== VC.state || !VC.sim || typeof VC.sim.finishDay !== 'function') return;
  try { VC.sim.finishDay(); } catch (e) { console.error('[save] finishing the sim day failed', e); }
}
/** Synchronous snapshot storing the resume speed (see storedSpeed). */
function snapshotOf(S, withExtra) {
  if (!S || !S.time) return codec().snapshot(S, null); // throws the friendly "no city" error
  wholeDay(S);
  return codec().snapshot(S, withExtra === false ? null : collectExtra(S), { speed: storedSpeed(S) });
}
/** Writes a storage string. An autosave that hits the quota evicts other cities' oldest autosaves first. */
function writeSlot(slot, text, auto) {
  for (let tries = 0; ; tries++) {
    try {
      return sset(PREFIX + slot, text);
    } catch (e) {
      if (!isQuota(e) || !auto || tries >= 8) throw e;
      let victim = null;
      for (const x of readIndex()) if (x.slot !== slot && isAutoSlot(x.slot) && (!victim || (x.savedAt || 0) < (victim.savedAt || 0))) victim = x;
      if (!victim) throw e;
      console.warn('[save] storage full: removing the oldest autosave (' + (victim.city || victim.name || victim.slot) + ')');
      dropSlot(victim.slot);
    }
  }
}
/** Keeps at most SV.autosaveKeep autosave slots (the one just written always stays). */
function pruneAutosaves(keep) {
  const autos = readIndex().filter((e) => e.slot !== keep && isAutoSlot(e.slot)).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  for (let i = Math.max(0, SV.autosaveKeep - 1); i < autos.length; i++) dropSlot(autos[i].slot);
}
/**
 * Stores a finished save + its index entry (synchronous). Returns 'local' | 'memory'. Throws storage
 * errors (quota) after an autosave's evictions failed.
 */
function commit(S, slot, display, text, meta, thumb, auto) {
  const where = writeSlot(slot, text, auto);
  const prev = entryOf(slot);
  const cityId = meta.cityId || null;
  const entry = {
    slot, name: display, city: meta.name, cityId, pop: meta.pop, money: meta.money, day: meta.day, savedAt: Date.now(),
    // no fresh thumbnail (autosave, hidden tab, page unload): keep the previous one of the same city,
    // else this city's newest thumbnail from any slot
    thumb: thumb || (prev && prev.thumb && prev.cityId === cityId && cityId ? prev.thumb : null) || cityThumb(cityId),
    mapType: meta.mapType, size: meta.size, difficulty: meta.difficulty, milestone: meta.milestone,
    bytes: text.length, auto, v: codec().VERSION,
  };
  entry.time = entry.savedAt;
  const idx = readIndex().filter((e) => e.slot !== slot);
  idx.push(entry);
  writeIndex(idx);
  if (auto) pruneAutosaves(slot);
  return where;
}

/* ------------------------------------------------------------------ */
/* Extras: camera, stub advisor inbox, module hooks                     */
/* ------------------------------------------------------------------ */
function collectExtra(S) {
  const ex = {};
  const cam = VC.camera;
  if (cam && cam.goal) {
    const g = cam.goal;
    ex.camera = { tx: g.tx, tz: g.tz, yaw: g.yaw, pitch: g.pitch, dist: g.dist };
  }
  const A = VC.advisors;
  if (A) {
    // advisors that keep their inbox in state (S.adv) are saved with the state already
    const inState = S.adv && typeof S.adv === 'object' && (S.adv.inbox === A.inbox || S.adv.news === A.news);
    if (!inState) {
      if (Array.isArray(A.inbox) && A.inbox.length) ex.advisorsInbox = A.inbox.slice(0, 100);
      if (Array.isArray(A.news) && A.news.length) ex.advisorsNews = A.news.slice(0, 60);
    }
  }
  for (const k in hooks) {
    try {
      const d = hooks[k].save ? hooks[k].save(S) : undefined;
      if (d !== undefined) (ex.hooks || (ex.hooks = {}))[k] = d;
    } catch (e) {
      console.warn('[save] hook ' + k + ' failed', e);
    }
  }
  return ex;
}
function applyExtra(S, ex) {
  if (!ex) return;
  const cam = VC.camera, c = ex.camera;
  if (cam && cam.goal && c && Number.isFinite(c.tx) && Number.isFinite(c.dist)) {
    Object.assign(cam.goal, { tx: c.tx, tz: c.tz, yaw: c.yaw, pitch: c.pitch, dist: c.dist });
    if (cam.snap) cam.snap();
  }
  const A = VC.advisors;
  if (A) {
    if (Array.isArray(ex.advisorsInbox) && Array.isArray(A.inbox) && !A.inbox.length) A.inbox.push(...ex.advisorsInbox);
    if (Array.isArray(ex.advisorsNews) && Array.isArray(A.news) && !A.news.length) A.news.push(...ex.advisorsNews);
  }
  if (ex.hooks) {
    for (const k in ex.hooks) {
      try { if (hooks[k] && hooks[k].load) hooks[k].load(S, ex.hooks[k]); } catch (e) { console.warn('[save] hook ' + k + ' load failed', e); }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */
function captureThumb() {
  const G = VC.gfx;
  if (!G || !G.capture || (typeof document !== 'undefined' && document.hidden)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 2000); // rAF stalls in hidden tabs
    G.capture(THUMB_W).then(
      (u) => { clearTimeout(t); resolve(typeof u === 'string' && u.startsWith('data:image') && u.length < 80000 ? u : null); },
      () => { clearTimeout(t); resolve(null); }
    );
  });
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
}
function readFileBytes(file) {
  if (file.arrayBuffer) return file.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result));
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsArrayBuffer(file);
  });
}
function fail(slot, reason, quiet) {
  if (!quiet) toast(reason, 'bad', '💾', 6000);
  VC.bus.emit('saveFailed', { slot, reason });
  return false;
}
/** Installs a decoded state as the running game. */
function start(S, slot, quiet) {
  const extra = S._saveExtra;
  delete S._saveExtra;
  delete S._saveMeta;
  VC.startState(S);
  applyExtra(S, extra);
  monthsSince = 0;
  lastAutoAt = now();
  if (!quiet) toast(`Loaded <b>${esc(S.name)}</b>`, 'good', '📂');
  VC.bus.emit('loaded', { slot, name: S.name });
}

/* ------------------------------------------------------------------ */
/* Saving                                                               */
/* ------------------------------------------------------------------ */
/**
 * Saves state S (normally the running city) to a slot. opts as SV.save plus extra:false (no extras).
 * pre {snap, meta, fp}: a snapshot taken already (the sliced autosave); otherwise it is taken now.
 */
function saveState(S, slot, name, opts, pre) {
  slot = normSlot(slot);
  const quiet = opts.quiet != null ? !!opts.quiet : panelOpen();
  if (!S || !S.buildings) return Promise.resolve(fail(slot, 'There is no city to save.', quiet));
  if (S.demo && !opts.force) return Promise.resolve(false);
  const auto = !!opts.auto || isAutoSlot(slot);
  let snap, meta, fp;
  if (pre) ({ snap, meta, fp } = pre);
  else {
    try {
      // snapshot synchronously so the running game can't change what gets written
      wholeDay(S); // (before the fingerprint: finishing the day changes the city)
      if (!S.demo) cityIdOf(S);
      fp = fingerprint(S);
      snap = snapshotOf(S, opts.extra);
      meta = codec().meta(S);
    } catch (e) {
      console.error('[save] serialize failed', e);
      return Promise.resolve(fail(slot, friendlyMsg(e, 'The city could not be saved.'), quiet));
    }
  }
  const prev = entryOf(slot);
  const display = name ? String(name).slice(0, 60) : isAutoSlot(slot) || slot === 'quick' ? meta.name : (prev && prev.name) || slot;
  const t0 = now();
  const thumbP = opts.thumb === false ? Promise.resolve(null) : captureThumb();
  SV.busy++;
  const job = chain.then(async () => {
    const t1 = now();
    const text = await codec().finish(snap);
    const t2 = now();
    const thumb = await thumbP;
    SV.lastTimings = { snapshot: +(t1 - t0).toFixed(1), compress: +(t2 - t1).toFixed(1), thumb: +(now() - t2).toFixed(1) };
    try {
      const where = commit(S, slot, display, text, meta, thumb, auto);
      if (where === 'memory' && !warnedMemory) {
        warnedMemory = true;
        toast('Your browser blocks storage for this page, so saves only last until the tab is closed. Use <b>Export</b> in the Save window to keep your city.', 'warn', '💾', 9000);
      }
    } catch (e) {
      if (isQuota(e)) {
        // autosave keeps trying: tell the player once per session
        const silent = auto ? warnedQuota : quiet;
        if (auto) warnedQuota = true;
        return fail(slot, 'Not enough browser storage to save. Delete old saves, or use <b>Export</b> to keep this city as a file.', silent);
      }
      throw e;
    }
    if (S === cur) saved = { S, fp };
    VC.bus.emit('saved', { slot, name: display, auto, bytes: text.length, cityId: meta.cityId || null });
    if ((!quiet && !auto) || opts.toast) toast(`Saved <b>${esc(display)}</b>${slot === 'quick' ? ' <small>(quick save)</small>' : ''}`, 'good', '💾', 2600);
    return true;
  }).catch((e) => {
    console.error('[save] save failed', e);
    return fail(slot, friendlyMsg(e, 'The city could not be saved.'), quiet);
  }).then((ok) => {
    SV.busy = Math.max(0, SV.busy - 1);
    return ok;
  });
  chain = job;
  return job;
}

/* ------------------------------------------------------------------ */
/* Autosave + Ctrl+S fallback                                           */
/* ------------------------------------------------------------------ */
/**
 * Autosaves S to its own slot when it changed (and is not an empty map). why: 'month' | 'timer' | 'hidden' |
 * 'leave' | 'manual' ('manual' = VC.save.autosave(): always writes).
 */
function autosaveNow(S, why) {
  if (why !== 'leave') {
    monthsSince = 0;
    lastAutoAt = now();
  }
  if (why !== 'manual' && (!changedSinceSave(S) || isEmptyCity(S))) return Promise.resolve(false);
  // leaving: the renderer and camera already show the next city (no camera/module extras)
  const leaving = why === 'leave';
  // routine backups of the running, visible game: snapshot in slices from the frame loop
  const sliced = (why === 'month' || why === 'timer') && S === VC.state && !inc && !(typeof document !== 'undefined' && document.hidden);
  const p = sliced ? startInc(S) : saveState(S, autoSlotOf(S), null, { auto: true, quiet: true, thumb: false, extra: leaving ? false : undefined });
  return p.then((ok) => {
    if (ok && (why === 'month' || why === 'timer') && now() - lastAutoToast > SV.autosaveToastMs && !panelOpen()) {
      lastAutoToast = now();
      toast('Autosaved', 'info', '💾', 1800, { sfx: false }); // quiet: no sound for a routine backup
    }
    return ok;
  });
}
/* ---- sliced autosave (see header) ---- */
const INC_SLICE_MS = 3;
let inc = null; // running sliced snapshot: {S, gen, sig, tries, resolve}
let pendingAuto = null; // {S, why, frames}: an autosave waiting for the frame after the month tick
/** What must not change while a sliced snapshot runs (buildings, tiles, trees). */
function structSig(S) {
  const v = S.ver || {};
  return v.bld + '|' + v.terrain + '|' + v.trees + '|' + (S.buildings ? S.buildings.size : 0) + '|' + S.nextId;
}
/** Holds the sim's day ticks (renewed every slice; expires by itself if this module stops). */
function holdSim(S, on) {
  const X = VC.sim && VC.sim._;
  if (X) X.hold = on ? { S, until: now() + 1500 } : null;
}
function startInc(S) {
  return new Promise((resolve) => {
    inc = { S, gen: null, sig: '', tries: 0, resolve };
    SV.busy++;
    restartInc();
  });
}
function restartInc() {
  const j = inc;
  j.tries++;
  wholeDay(j.S); // whole days only, and no new day may start before the first slice (sim.update runs first)
  holdSim(j.S, true);
  j.sig = structSig(j.S);
  j.gen = codec().snapshotGen(j.S, collectExtra(j.S), { speed: storedSpeed(j.S) });
}
/** Ends the sliced snapshot; result: false or the save's promise. */
function endInc(result) {
  const j = inc;
  if (!j) return;
  inc = null;
  holdSim(j.S, false);
  SV.busy = Math.max(0, SV.busy - 1);
  j.resolve(result);
}
/** One slice of the sliced snapshot (called from SV.update); hands the result to saveState when done. */
function stepInc(budgetMs) {
  const j = inc, S = j.S;
  if (S !== VC.state || !autoOK(S)) return endInc(false);
  if (structSig(S) !== j.sig) {
    // the world changed under the snapshot: start over (or wait for the next trigger)
    if (j.tries >= 3) return endInc(false);
    restartInc();
  }
  holdSim(S, true);
  const t0 = now();
  let r;
  try {
    do r = j.gen.next(); while (!r.done && now() - t0 < budgetMs);
  } catch (e) {
    console.error('[save] autosave snapshot failed', e);
    return endInc(false);
  }
  if (!r.done || structSig(S) !== j.sig) return; // continue (or restart) next frame
  let pre;
  try {
    pre = { snap: r.value, meta: codec().meta(S), fp: fingerprint(S) };
  } catch (e) {
    console.error('[save] autosave failed', e);
    return endInc(false);
  }
  endInc(saveState(S, autoSlotOf(S), null, { auto: true, quiet: true, thumb: false }, pre));
}

/**
 * Best-effort synchronous autosave for page unload (promises never settle there): JS gzip, no thumbnail,
 * no toast. Returns true when written.
 */
function saveSync(S, force) {
  if (!S || !S.buildings || S.demo) return false;
  if (!force && (!changedSinceSave(S) || isEmptyCity(S))) return false;
  const t0 = now();
  try {
    wholeDay(S);
    cityIdOf(S);
    const fp = fingerprint(S);
    const meta = codec().meta(S);
    const text = codec().finishSync(snapshotOf(S));
    const slot = autoSlotOf(S);
    commit(S, slot, meta.name, text, meta, null, true);
    if (S === cur) saved = { S, fp };
    SV.lastSync = { ms: +(now() - t0).toFixed(1), bytes: text.length, slot };
    VC.bus.emit('saved', { slot, name: meta.name, auto: true, bytes: text.length, cityId: meta.cityId || null, sync: true });
    return true;
  } catch (e) {
    console.warn('[save] unload autosave failed', e);
    return false;
  }
}
function onMonth() {
  const S = VC.state;
  if (!autoOK(S) || !VC.running) return;
  if (++monthsSince < SV.autosaveMonths) return;
  if (now() - lastAutoAt < SV.autosaveMinMs || SV.busy || inc || pendingAuto) return; // retried next month
  pendingAuto = { S, why: 'month', frames: 1 }; // never inside the sim's month tick: starts next frame
}
/** Tab hidden (switching away, minimizing, closing on mobile): back up now while promises still run. */
function onVisibility() {
  if (document.visibilityState !== 'hidden') return;
  const S = VC.state;
  const wasSliced = !!inc || !!pendingAuto;
  if (inc) endInc(false); // rAF stops in hidden tabs: finish with a synchronous snapshot instead
  pendingAuto = null;
  if (!autoOK(S) || !VC.running || SV.busy || (!wasSliced && now() - lastAutoAt < 20000)) return;
  autosaveNow(S, 'hidden');
}
/** beforeunload / pagehide (reload, close, navigate away): synchronous, quiet, once. */
function onUnload() {
  if (now() - unloadAt < 1500) return; // beforeunload and pagehide both fire
  if (inc) endInc(false);
  pendingAuto = null;
  const S = VC.state;
  if (!autoOK(S) || !VC.running) return;
  unloadAt = now();
  saveSync(S, false);
}
/** Tracks what the pause menu paused from (it keeps the resume speed private). */
function onSpeed(s) {
  const S = VC.state;
  if (!S) return;
  const m = VC.menu;
  if (s === 0 && m && m.isPaused && m.isPaused()) {
    if (!menuPause || menuPause.S !== S) menuPause = { S, from: lastSpeed };
  } else if (s > 0) menuPause = null;
  lastSpeed = s;
}
function onKey(e) {
  if (e.code !== 'KeyS' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  if (e.defaultPrevented) return; // input.js (or another handler) already took care of it
  e.preventDefault(); // never open the browser's "Save page" dialog
  if (e.repeat) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // typing
  if (VC.ui && VC.ui.modalCount && VC.ui.modalCount() > 0) return; // a dialog is up
  const S = VC.state;
  if (!S || S.demo || (VC.menu && VC.menu.active)) return;
  SV.quickSave();
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */
const SV = (VC.save = Object.assign(VC.save || {}, {
  autosaveMonths: 3,
  autosaveMinMs: 45000, // never autosave more often than this (fast-forward speed)
  autosaveEveryMs: 300000, // real-time autosave interval (also while paused, when something changed)
  autosaveKeep: 8, // autosave slots kept in total (one per city)
  autosaveToastMs: 600000, // at most one quiet "Autosaved" toast per 10 minutes
  busy: 0,

  init() {
    store = detectStorage();
    if (!store) useMemory();
    const guard = (fn) => (d) => { try { fn(d); } catch (e) { console.error('[save] autosave', e); } };
    VC.bus.on('month', guard(onMonth));
    VC.bus.on('speed', guard(onSpeed));
    // baseline for change tracking once every module has reset (reset() runs before the initial repaint)
    VC.bus.on('started', guard((S) => { if (S && S === cur) saved = { S, fp: fingerprint(S) }; }));
    window.addEventListener('keydown', onKey);
    window.addEventListener('storage', (e) => { if (!e.key || e.key.startsWith('voxelpolis.')) indexCache = null; });
    document.addEventListener('visibilitychange', guard(onVisibility));
    window.addEventListener('pagehide', guard(onUnload));
    window.addEventListener('beforeunload', guard(onUnload)); // never prompts
  },
  reset(S) {
    const prev = cur;
    if (inc) endInc(false);
    pendingAuto = null;
    cur = S && !S.demo ? S : null;
    // the city being replaced (new game, load, main menu) keeps its progress in its own autosave slot
    if (prev && prev !== S && autoOK(prev)) {
      try { autosaveNow(prev, 'leave'); } catch (e) { console.error('[save] leave autosave', e); }
    }
    if (cur) cityIdOf(cur);
    saved = null; // set on 'started'
    menuPause = null;
    lastSpeed = S && S.time ? S.time.speed : 1;
    monthsSince = 0;
    lastAutoAt = now();
  },
  /** Sliced autosave steps + real-time autosave timer (runs while paused too; saves only when something changed). */
  update() {
    if (inc) stepInc(INC_SLICE_MS);
    else if (pendingAuto && pendingAuto.frames-- <= 0) {
      const p = pendingAuto;
      pendingAuto = null;
      if (p.S === VC.state && autoOK(p.S) && VC.running && !SV.busy) autosaveNow(p.S, p.why);
    }
    const t = now();
    if (t < nextCheck) return;
    nextCheck = t + 2000;
    const S = VC.state;
    if (!autoOK(S) || !VC.running || SV.busy || inc || pendingAuto || S !== cur) return;
    if (t - lastAutoAt < SV.autosaveEveryMs) return;
    autosaveNow(S, 'timer');
  },
  /** True while a sliced autosave snapshot is running (the sim holds its day ticks meanwhile). */
  snapshotting() {
    return !!inc;
  },

  serialize(S) {
    S = S || VC.state;
    wholeDay(S);
    return codec().serialize(S, { extra: collectExtra(S) });
  },
  deserialize(obj) {
    return codec().deserialize(obj);
  },
  /** State -> storage string (gzip+base64 container; stores the resume speed when the pause menu paused it). */
  encode(S) {
    S = S || VC.state;
    if (S && S.buildings && !S.demo) cityIdOf(S);
    return codec().finish(snapshotOf(S));
  },
  /** Storage string / file bytes / serialized object -> new state (not started). */
  async parse(data) {
    const C = codec();
    let obj;
    if (typeof data === 'string') obj = await C.decodeText(data);
    else if (data instanceof Uint8Array) obj = await C.decodeBytes(data);
    else if (data instanceof ArrayBuffer) obj = await C.decodeBytes(new Uint8Array(data));
    else obj = data;
    return C.deserialize(obj);
  },

  /** Saves the running city. slot 'autosave' means this city's own autosave slot ('autosave:<cityId>'). */
  save(slot, name, opts = {}) {
    const S = VC.state;
    if (slot === 'autosave' && S && !S.demo) slot = autoSlotOf(S);
    return saveState(S, slot, name, opts || {});
  },

  load(slot, opts = {}) {
    slot = normSlot(slot);
    const quiet = opts.quiet != null ? !!opts.quiet : panelOpen();
    if (!SV.busy && sget(PREFIX + slot) == null) return Promise.resolve(fail(slot, 'That save no longer exists.', quiet));
    // read the slot once saves queued before this load (e.g. the autosave of the city being left) are written
    const job = chain.then(() => {
      const text = sget(PREFIX + slot);
      if (text == null) throw codec().friendly('That save no longer exists.');
      return SV.parse(text);
    }).then((S) => {
      start(S, slot, quiet);
      return true;
    }, (e) => {
      console.warn('[save] load failed', e);
      return fail(slot, friendlyMsg(e, 'This save could not be opened (it may be damaged).'), quiet);
    });
    chain = job;
    return job;
  },

  /** Index entries, newest first (copies). Every entry has cityId (null for old saves) and auto. */
  list() {
    return readIndex()
      .slice()
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .map((e) => Object.assign({}, e, { time: e.savedAt || 0, cityId: e.cityId || cityIdOfSlot(e.slot) || null, auto: !!e.auto || isAutoSlot(e.slot) }));
  },
  latest() {
    return SV.list()[0] || null;
  },
  has(slot) {
    return sget(PREFIX + normSlot(slot)) != null;
  },
  remove(slot) {
    slot = normSlot(slot);
    sdel(PREFIX + slot);
    writeIndex(readIndex().filter((e) => e.slot !== slot));
    return true;
  },
  rename(slot, name) {
    const e = entryOf(normSlot(slot));
    if (!e || !name) return false;
    e.name = String(name).slice(0, 60);
    return writeIndex(readIndex());
  },

  async exportBlob(slot) {
    let text, name;
    if (slot != null) {
      text = sget(PREFIX + normSlot(slot));
      if (text == null) throw codec().friendly('That save no longer exists.');
      const e = entryOf(normSlot(slot));
      name = (e && (e.city || e.name)) || String(slot);
    } else {
      const S = VC.state;
      if (!S || S.demo) throw codec().friendly('There is no city to export.');
      text = await SV.encode(S);
      name = S.name;
    }
    const file = fileName(name) + '.voxelpolis';
    return { blob: new Blob([text], { type: 'application/octet-stream' }), name: file, text };
  },
  async exportFile(slot) {
    try {
      const r = await SV.exportBlob(slot);
      download(r.blob, r.name);
      toast(`Exported <b>${esc(r.name)}</b> (${Math.max(1, Math.round(r.blob.size / 1024))} KB)`, 'good', '⬇️', 3500);
      return true;
    } catch (e) {
      console.warn('[save] export failed', e);
      return fail(null, friendlyMsg(e, 'Export failed.'), false);
    }
  },
  /** Opens a file picker; loads the chosen city. Resolves false on cancel or error. */
  importFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.voxelpolis,.vxp,.json,.txt,.gz,application/json,text/plain';
      input.style.display = 'none';
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        input.remove();
        resolve(v);
      };
      input.addEventListener('change', () => {
        const f = input.files && input.files[0];
        if (!f) return finish(false);
        readFileBytes(f).then((bytes) => SV.importText(bytes, { name: f.name })).then(finish, (e) => {
          console.warn('[save] import failed', e);
          finish(fail(null, 'Could not read that file.', false));
        });
      });
      input.addEventListener('cancel', () => finish(false));
      // older browsers have no 'cancel' event: give up once focus returns without a file
      window.addEventListener('focus', () => setTimeout(() => { if (!input.files || !input.files.length) finish(false); }, 1500), { once: true });
      document.body.appendChild(input);
      input.click();
    });
  },
  /** Loads a city from exported text / bytes / object. Resolves true when it is running. */
  importText(data, opts = {}) {
    const job = chain.then(() => SV.parse(data)).then((S) => {
      start(S, null, !!opts.quiet);
      return true;
    }, (e) => {
      console.warn('[save] import failed', e);
      return fail(null, friendlyMsg(e, 'That file is not a Voxelpolis city.'), !!opts.quiet);
    });
    chain = job;
    return job;
  },

  quickSave() {
    return SV.save('quick', null, { quiet: false });
  },
  quickLoad() {
    return SV.load('quick', { quiet: false });
  },
  /** Autosaves the running city to its own slot now (ignores the change check). */
  autosave() {
    const S = VC.state;
    if (!S || !S.buildings || S.demo) return Promise.resolve(false);
    return autosaveNow(S, 'manual');
  },
  /** Synchronous best-effort autosave of the running city (what page unload does). force: even if unchanged. */
  autosaveSync(force) {
    return saveSync(VC.state, force !== false);
  },
  /** Stable id of a city (the running one by default); created if missing. */
  cityId(S) {
    S = S || VC.state;
    return S && !S.demo ? cityIdOf(S) : null;
  },
  /** This city's autosave slot ('autosave:<cityId>'). */
  autosaveSlot(S) {
    S = S || VC.state;
    return S && !S.demo ? autoSlotOf(S) : null;
  },
  isAutoSlot,
  /** True when the city changed since it was started / last saved. */
  changed(S) {
    S = S || VC.state;
    return !!S && changedSinceSave(S);
  },
  /** Lets a module persist data outside VC.state: hooks {save(S) -> JSON-able, load(S, data)}. */
  register(key, h) {
    if (key && h) hooks[key] = h;
  },
  storageInfo() {
    let bytes = 0, slots = 0;
    for (const s of storedSlots()) {
      const v = sget(PREFIX + s);
      if (v) { bytes += v.length; slots++; }
    }
    const idx = sget(INDEX_KEY);
    return { mode: store ? (memory && memory.size ? 'mixed' : 'local') : 'memory', slots, bytes: bytes + (idx ? idx.length : 0), gzip: codec().canGzip() };
  },
  /** Round-trips the running city through JSON and the storage format; returns differences. */
  async selfTest() {
    const S = VC.state, C = codec();
    const t0 = now();
    const json = JSON.stringify(SV.serialize(S));
    const t1 = now();
    const S2 = SV.deserialize(JSON.parse(json));
    const t2 = now();
    const d1 = C.diff(S, S2, { skip: { ver: 1 } }); // before any await: S keeps running
    const text = await SV.encode(S);
    const t3 = now();
    const S3 = await SV.parse(text);
    const t4 = now();
    // S3 was snapshotted in the same tick as S2, so they must match exactly
    const diffs = d1.concat(C.diff(S2, S3, { skip: { ver: 1 } }));
    return {
      ok: !diffs.length, diffs, buildings: S.buildings.size, jsonBytes: json.length, storedBytes: text.length,
      ms: { serialize: +(t1 - t0).toFixed(1), deserialize: +(t2 - t1).toFixed(1), encode: +(t3 - t2).toFixed(1), decode: +(t4 - t3).toFixed(1) },
    };
  },
}));
