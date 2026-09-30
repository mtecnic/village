/*
 * VOXELPOLIS — save / load / export / import / autosave (VC.save). Format + compression: io/save_codec.js.
 *
 * STORAGE: localStorage 'voxelpolis.save.<slot>' = storage string (see codec), plus the index
 *   'voxelpolis.saves' = [{slot, name, city, pop, money, day, savedAt, time, thumb, mapType, size,
 *   difficulty, milestone, bytes, auto}] (thumb = small JPEG data URL from VC.gfx.capture). When storage
 *   is blocked (e.g. Safari on file://) an in-memory store is used for the session and the player is
 *   told to use Export. Quota errors are reported with a toast that suggests Export / deleting saves.
 *
 * API (all async calls resolve false on failure after telling the player why; they never reject):
 *   serialize(S) -> object            deserialize(obj) -> S (throws Error(.friendly) on corrupt data)
 *   save(slot, name?, opts?) -> Promise<bool>   opts {auto, quiet, thumb:false, force (allow demo), toast}
 *   load(slot, opts?) -> Promise<bool>          (VC.startState + camera restore + toast "Loaded …")
 *   list() -> index entries, newest first (sync)   latest()   has(slot)   remove(slot)   rename(slot, name)
 *   exportFile(slot?) / exportBlob(slot?) -> {blob, name, text}   (slot omitted = the running city)
 *   importFile() -> Promise<bool> (file picker)   importText(text|bytes) -> Promise<bool>
 *   parse(text|bytes|object) -> Promise<S> (no start)   encode(S) -> Promise<storage string>
 *   quickSave() / quickLoad()   register(key, {save(S) -> json, load(S, data)})   selfTest()   storageInfo()
 * Slots 'autosave' (every VC.save.autosaveMonths game months when VC.settings.autosave, never for the
 * title-screen demo city) and 'quick' (Ctrl+S; input.js normally calls save('quick'), this module only
 * handles Ctrl+S itself if nothing else prevented the key's default).
 * Toasts: suppressed while the 'save' manager window is open (the panel reports results itself).
 * Bus: emits 'saved' {slot, name, auto, bytes}, 'loaded' {slot, name}, 'saveFailed' {slot, reason}.
 */
const PREFIX = 'voxelpolis.save.', INDEX_KEY = 'voxelpolis.saves';
const THUMB_W = 200;
let store = null; // window.localStorage when usable
let memory = null; // Map fallback (session only)
let indexCache = null;
let chain = Promise.resolve();
let monthsSince = 0, lastAutoAt = 0, lastAutoToast = -1e9;
let warnedMemory = false, warnedQuota = false;
const hooks = Object.create(null);

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function toast(text, type, icon, duration) {
  VC.bus.emit('toast', { text, type: type || 'info', icon: icon || '💾', duration });
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
  for (const s of present) if (!seen.has(s)) arr.push({ slot: s, name: s, savedAt: 0, auto: s === 'autosave' });
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
function entryOf(slot) {
  const s = String(slot);
  return readIndex().find((e) => e.slot === s) || null;
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
    const t = setTimeout(() => resolve(null), 1200); // rAF stalls in hidden tabs
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
/* Autosave + Ctrl+S fallback                                           */
/* ------------------------------------------------------------------ */
function onMonth() {
  const S = VC.state;
  if (!S || S.demo || !VC.running) return;
  if (VC.settings && VC.settings.autosave === false) return;
  if (++monthsSince < SV.autosaveMonths) return;
  if (now() - lastAutoAt < SV.autosaveMinMs || SV.busy) return; // retried next month
  monthsSince = 0;
  lastAutoAt = now();
  SV.save('autosave', null, { auto: true, quiet: true }).then((ok) => {
    if (ok && now() - lastAutoToast > 300000 && !panelOpen()) {
      lastAutoToast = now();
      toast('Autosaved', 'info', '💾', 1800);
    }
  });
}
function onKey(e) {
  if (e.code !== 'KeyS' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  if (e.defaultPrevented) return; // input.js (or another handler) already took care of it
  e.preventDefault(); // never open the browser's "Save page" dialog
  if (e.repeat) return;
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
  busy: 0,

  init() {
    store = detectStorage();
    if (!store) useMemory();
    VC.bus.on('month', () => { try { onMonth(); } catch (e) { console.error('[save] autosave', e); } });
    window.addEventListener('keydown', onKey);
    window.addEventListener('storage', (e) => { if (!e.key || e.key.startsWith('voxelpolis.')) indexCache = null; });
  },
  reset() {
    monthsSince = 0;
    lastAutoAt = now();
  },

  serialize(S) {
    return codec().serialize(S || VC.state, { extra: collectExtra(S || VC.state) });
  },
  deserialize(obj) {
    return codec().deserialize(obj);
  },
  /** State -> storage string (gzip+base64 container, or raw JSON without CompressionStream). */
  encode(S) {
    S = S || VC.state;
    return codec().finish(codec().snapshot(S, collectExtra(S)));
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

  save(slot, name, opts = {}) {
    const S = VC.state;
    slot = normSlot(slot);
    const quiet = opts.quiet != null ? !!opts.quiet : panelOpen();
    if (!S || !S.buildings) return Promise.resolve(fail(slot, 'There is no city to save.', quiet));
    if (S.demo && !opts.force) return Promise.resolve(false);
    let snap, meta;
    try {
      // snapshot synchronously so the running game can't change what gets written
      snap = codec().snapshot(S, collectExtra(S));
      meta = codec().meta(S);
    } catch (e) {
      console.error('[save] serialize failed', e);
      return Promise.resolve(fail(slot, friendlyMsg(e, 'The city could not be saved.'), quiet));
    }
    const prev = entryOf(slot);
    const display = name ? String(name).slice(0, 60) : slot === 'autosave' || slot === 'quick' ? S.name : (prev && prev.name) || slot;
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
        const where = sset(PREFIX + slot, text);
        if (where === 'memory' && !warnedMemory) {
          warnedMemory = true;
          toast('Your browser blocks storage for this page, so saves only last until the tab is closed. Use <b>Export</b> in the Save window to keep your city.', 'warn', '💾', 9000);
        }
      } catch (e) {
        if (isQuota(e)) {
          // autosave keeps trying every few months: tell the player once per session
          const silent = opts.auto ? warnedQuota : quiet;
          if (opts.auto) warnedQuota = true;
          return fail(slot, 'Not enough browser storage to save. Delete old saves, or use <b>Export</b> to keep this city as a file.', silent);
        }
        throw e;
      }
      const entry = {
        slot, name: display, city: S.name, pop: meta.pop, money: meta.money, day: meta.day, savedAt: Date.now(),
        thumb, mapType: meta.mapType, size: meta.size, difficulty: meta.difficulty, milestone: meta.milestone,
        bytes: text.length, auto: !!opts.auto || slot === 'autosave', v: codec().VERSION,
      };
      entry.time = entry.savedAt;
      const idx = readIndex().filter((e) => e.slot !== slot);
      idx.push(entry);
      writeIndex(idx);
      VC.bus.emit('saved', { slot, name: display, auto: entry.auto, bytes: text.length });
      if ((!quiet && !entry.auto) || opts.toast) toast(`Saved <b>${esc(display)}</b>${slot === 'quick' ? ' <small>(quick save)</small>' : ''}`, 'good', '💾', 2600);
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
  },

  load(slot, opts = {}) {
    slot = normSlot(slot);
    const quiet = opts.quiet != null ? !!opts.quiet : panelOpen();
    const text = sget(PREFIX + slot);
    if (text == null) return Promise.resolve(fail(slot, 'That save no longer exists.', quiet));
    const job = chain.then(() => SV.parse(text)).then((S) => {
      start(S, slot, quiet);
      return true;
    }, (e) => {
      console.warn('[save] load failed', e);
      return fail(slot, friendlyMsg(e, 'This save could not be opened (it may be damaged).'), quiet);
    });
    chain = job;
    return job;
  },

  /** Index entries, newest first (copies). */
  list() {
    return readIndex()
      .slice()
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .map((e) => Object.assign({}, e, { time: e.savedAt || 0 }));
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
  autosave() {
    return SV.save('autosave', null, { auto: true, quiet: true });
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
