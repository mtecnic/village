/*
 * VOXELPOLIS — save codec: exact, versioned (de)serialization of the whole game state and the
 * compact storage format. Used by VC.save (io/save.js); exposed as VC.save.codec.
 *
 * SERIALIZED OBJECT (plain JSON-able, format v1)
 *   { app:'voxelpolis', v:1, game:VC.VERSION, meta:{name, pop, money, day, savedAt, mapType, size, …},
 *     state:{ …every field of S… }, extra:{ …module extras… } }
 *   The state is walked GENERICALLY, so fields other modules add (S.econ, S.adv, S.disasterStats, …)
 *   are saved without this file knowing about them. Value encoding:
 *     typed array  {$t:'u8'|'u16'|'i32'|…, b:base64 little-endian}   (binary container: {$t, o, n, f})
 *     Map / Set    {$m:[[k,v],…]} / {$s:[…]}          non-finite number {$n:'NaN'|'Inf'|'-Inf'}
 *     building ref {$b:id}  (an object that IS a live building, found outside S.buildings)
 *     Date {$d:ms}, undefined in arrays {$u:1}, objects with '$' keys are escaped as {$o:{…}}
 *   Skipped (transient): keys starting with '_' at any depth, S.demo, functions, class instances
 *   (DOM / WebGL objects), and renderer fields on buildings (hgt, disLift and keys prefixed gfx, bldgfx, fx, agents, particles, render).
 *   S.buildings is stored as an array of building objects.
 *
 * STORAGE STRING (localStorage value and exported file)
 *   'VXPZ1:' + base64(gzip(container))      when CompressionStream is available
 *   raw JSON of the serialized object         otherwise (typed arrays inline base64)
 *   container = 'VXPB' | u32 1 | u32 jsonBytes | u32 blobBytes | json utf8 | pad4 | blob
 *   Blob chunks are typed-array bytes with a byte-plane shuffle + delta filter (f:1), which makes
 *   height/zone/id layers compress 2-4x better. Decoding also accepts raw gzip files and uses a
 *   built-in JS inflate when DecompressionStream is missing (older Safari/Firefox).
 *
 * MIGRATION: MIGRATIONS[v](obj) upgrades format v -> v+1. Newer-than-known formats are refused with a
 * friendly error; structurally broken data throws Error with .friendly = true.
 */
const CODEC_V = 1;
const MAGIC = 0x42505856; // 'VXPB' little-endian
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const TA_TAG = { Uint8Array: 'u8', Int8Array: 'i8', Uint8ClampedArray: 'u8c', Uint16Array: 'u16', Int16Array: 'i16', Uint32Array: 'u32', Int32Array: 'i32', Float32Array: 'f32', Float64Array: 'f64' };
const TA_CTOR = { u8: Uint8Array, i8: Int8Array, u8c: Uint8ClampedArray, u16: Uint16Array, i16: Int16Array, u32: Uint32Array, i32: Int32Array, f32: Float32Array, f64: Float64Array };
/** Building fields that belong to renderers / transient effects and are never saved. */
const BLD_SKIP = /^(_|hgt$|removed$|disLift$|bldgfx|gfx|fx[A-Z_]|agents?[A-Z_]|particles?[A-Z_]|render)/;
/** Top-level state keys never saved. */
const STATE_SKIP = { demo: 1 };
/** Format migrations: MIGRATIONS[v](obj) -> obj of format v+1. */
const MIGRATIONS = {};

function friendly(msg) {
  const e = new Error(msg);
  e.friendly = true;
  return e;
}
const DAMAGED = 'This save is damaged or is not a Voxelpolis city.';

/* ------------------------------------------------------------------ */
/* Typed array bytes (explicit little-endian so files move between machines) */
/* ------------------------------------------------------------------ */
function swapBytes(u8, size) {
  for (let i = 0; i < u8.length; i += size)
    for (let a = i, b = i + size - 1; a < b; a++, b--) { const t = u8[a]; u8[a] = u8[b]; u8[b] = t; }
  return u8;
}
/** Little-endian byte view (copy only on big-endian hosts). */
function taBytes(ta) {
  const u8 = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);
  return LE || ta.BYTES_PER_ELEMENT === 1 ? u8 : swapBytes(u8.slice(), ta.BYTES_PER_ELEMENT);
}
function bytesToTA(tag, u8) {
  const Ctor = TA_CTOR[tag];
  if (!Ctor) throw friendly(DAMAGED);
  const size = Ctor.BYTES_PER_ELEMENT;
  if (u8.length % size) throw friendly(DAMAGED);
  const out = new Ctor(u8.length / size);
  const ob = new Uint8Array(out.buffer);
  ob.set(u8);
  if (!LE && size > 1) swapBytes(ob, size);
  return out;
}
/** Byte-plane shuffle + per-plane delta: runs and smooth fields become long zero runs. */
function filterEnc(u8, size) {
  const n = (u8.length / size) | 0, out = new Uint8Array(u8.length);
  for (let k = 0; k < size; k++) {
    let prev = 0;
    const base = k * n;
    for (let i = 0, j = k; i < n; i++, j += size) {
      const v = u8[j];
      out[base + i] = (v - prev) & 255;
      prev = v;
    }
  }
  return out;
}
function filterDec(u8, size) {
  const n = (u8.length / size) | 0, out = new Uint8Array(u8.length);
  for (let k = 0; k < size; k++) {
    let prev = 0;
    const base = k * n;
    for (let i = 0, j = k; i < n; i++, j += size) {
      prev = (prev + u8[base + i]) & 255;
      out[j] = prev;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Generic value encoder / decoder                                      */
/* ------------------------------------------------------------------ */
function isPlain(v) {
  if (v === null || typeof v !== 'object') return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}
/** cx: { S, sink: null | {parts:[], len}, stack: Set } */
function enc(v, cx) {
  switch (typeof v) {
    case 'number': return Number.isFinite(v) ? v : { $n: v !== v ? 'NaN' : v > 0 ? 'Inf' : '-Inf' };
    case 'string': case 'boolean': return v;
    case 'bigint': return { $big: String(v) };
    case 'undefined': case 'function': case 'symbol': return undefined;
  }
  if (v === null) return null;
  if (ArrayBuffer.isView(v)) return encTA(v, cx);
  if (cx.stack.has(v)) return undefined; // cycle: drop the back-reference
  let out;
  cx.stack.add(v);
  if (Array.isArray(v)) {
    out = new Array(v.length);
    for (let i = 0; i < v.length; i++) {
      const x = enc(v[i], cx);
      out[i] = x === undefined ? { $u: 1 } : x;
    }
  } else if (v instanceof Map) {
    out = { $m: [] };
    for (const [k, x] of v) {
      const ek = enc(k, cx), ex = enc(x, cx);
      if (ek !== undefined) out.$m.push([ek, ex === undefined ? { $u: 1 } : ex]);
    }
  } else if (v instanceof Set) {
    out = { $s: [] };
    for (const x of v) { const ex = enc(x, cx); if (ex !== undefined) out.$s.push(ex); }
  } else if (v instanceof Date) {
    out = { $d: v.getTime() };
  } else if (!isPlain(v)) {
    out = undefined; // DOM nodes, GL objects, class instances: transient by definition
  } else if (cx.S && typeof v.id === 'number' && cx.S.buildings && cx.S.buildings.get(v.id) === v) {
    out = { $b: v.id }; // reference to a live building (restored to the same object on load)
  } else {
    out = encObj(v, cx, null);
  }
  cx.stack.delete(v);
  return out;
}
function encObj(v, cx, skip) {
  const o = {};
  let esc = false;
  for (const k in v) {
    if (k.charCodeAt(0) === 95 || (skip && skip.test(k))) continue; // '_' = transient
    const x = enc(v[k], cx);
    if (x === undefined) continue;
    o[k] = x;
    if (k.charCodeAt(0) === 36) esc = true; // '$' keys would look like tags
  }
  return esc ? { $o: o } : o;
}
function encTA(v, cx) {
  const tag = TA_TAG[v.constructor.name] || (v instanceof Uint8Array ? 'u8' : null);
  if (!tag) return undefined; // DataView etc.
  const bytes = taBytes(v);
  if (cx.sink) {
    const f = filterEnc(bytes, v.BYTES_PER_ELEMENT);
    const o = cx.sink.len;
    cx.sink.parts.push(f);
    cx.sink.len += f.length;
    return { $t: tag, o, n: f.length, f: 1 };
  }
  return { $t: tag, b: VC.b64.fromBytes(bytes) };
}

/** cx: { bmap: Map of restored buildings, blob: Uint8Array | null } */
function dec(v, cx) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = dec(v[i], cx);
    return out;
  }
  for (const k in v) {
    // tagged values: the encoder escapes every plain object whose keys start with '$'
    if (k.charCodeAt(0) === 36) {
      switch (k) {
        case '$t': return decTA(v, cx);
        case '$n': return v.$n === 'NaN' ? NaN : v.$n === '-Inf' ? -Infinity : Infinity;
        case '$m': { const m = new Map(); for (const e of v.$m) if (Array.isArray(e)) m.set(dec(e[0], cx), dec(e[1], cx)); return m; }
        case '$s': return new Set(dec(v.$s, cx));
        case '$b': return (cx.bmap && cx.bmap.get(v.$b)) || null;
        case '$d': return new Date(v.$d);
        case '$u': return undefined;
        case '$big': return typeof BigInt === 'function' ? BigInt(v.$big) : Number(v.$big);
        case '$o': return decObj(v.$o, cx);
      }
    }
    break;
  }
  return decObj(v, cx);
}
function decObj(v, cx) {
  const o = {};
  for (const k in v) {
    const x = dec(v[k], cx);
    if (x !== undefined) o[k] = x;
  }
  return o;
}
function decTA(v, cx) {
  let bytes;
  if (typeof v.b === 'string') bytes = VC.b64.toBytes(v.b);
  else {
    if (!cx.blob || !(v.o >= 0) || !(v.n >= 0) || v.o + v.n > cx.blob.length) throw friendly(DAMAGED);
    bytes = cx.blob.subarray(v.o, v.o + v.n);
  }
  const Ctor = TA_CTOR[v.$t];
  if (!Ctor) throw friendly(DAMAGED);
  if (v.f === 1) bytes = filterDec(bytes, Ctor.BYTES_PER_ELEMENT);
  return bytesToTA(v.$t, bytes);
}

/* ------------------------------------------------------------------ */
/* State <-> serialized object                                          */
/* ------------------------------------------------------------------ */
function meta(S) {
  const st = S.stats || {};
  return {
    name: S.name, pop: Math.round(st.pop || 0), money: Math.round(S.money || 0), day: S.time ? S.time.day : 0,
    savedAt: Date.now(), mapType: S.mapType, size: S.W, difficulty: S.difficulty, milestone: S.milestone || 0,
    buildings: S.buildings ? S.buildings.size : 0, seed: S.seed, sandbox: !!S.sandbox,
  };
}

/** Serializes state S. opts.sink collects typed arrays for the binary container. */
function serialize(S, opts = {}) {
  if (!S || !S.height || !S.buildings) throw friendly('There is no city to save.');
  const cx = { S, sink: opts.sink || null, stack: new Set() };
  const state = {};
  for (const k in S) {
    if (k.charCodeAt(0) === 95 || STATE_SKIP[k]) continue;
    if (k === 'buildings') {
      const arr = [];
      for (const b of S.buildings.values()) arr.push(encObj(b, cx, BLD_SKIP));
      state.buildings = arr;
      continue;
    }
    const x = enc(S[k], cx);
    if (x !== undefined) state[k] = x;
  }
  const out = { app: 'voxelpolis', v: CODEC_V, game: VC.VERSION, meta: meta(S), state };
  const extra = opts.extra ? enc(opts.extra, cx) : undefined;
  if (extra && Object.keys(extra).length) out.extra = extra;
  return out;
}

function migrate(obj) {
  let v = obj.v | 0;
  if (v < 1) throw friendly(DAMAGED);
  if (v > CODEC_V) throw friendly('This city was saved by a newer version of Voxelpolis. Please update the game to open it.');
  while (v < CODEC_V) {
    const m = MIGRATIONS[v];
    if (!m) throw friendly('This save uses an old format that can no longer be opened.');
    obj = m(obj) || obj;
    obj.v = ++v;
  }
  return obj;
}

/** Deep-merges loaded plain objects over fresh defaults (new fields keep defaults). */
function mergeDefaults(fresh, loaded) {
  if (!isPlain(fresh) || !isPlain(loaded)) return loaded;
  for (const k in loaded) fresh[k] = isPlain(fresh[k]) && isPlain(loaded[k]) ? mergeDefaults(fresh[k], loaded[k]) : loaded[k];
  return fresh;
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Rebuilds a complete state from a serialized object. Throws Error(.friendly) on corrupt data.
 * obj._blob (Uint8Array) holds binary-container chunks when the object came from decode().
 * The returned state carries S._saveExtra (decoded extras) for VC.save to apply after startState.
 */
function deserialize(obj) {
  if (!obj || typeof obj !== 'object' || !obj.state || typeof obj.state !== 'object') throw friendly(DAMAGED);
  if (obj.app && obj.app !== 'voxelpolis') throw friendly(DAMAGED);
  const blob = obj._blob || null;
  obj = migrate(obj);
  const st = obj.state;
  const W = st.W | 0, H = st.H == null ? W : st.H | 0;
  if (!(W >= 8 && W <= 2048) || H !== W) throw friendly(DAMAGED);
  const diff = VC.DIFFICULTY[st.difficulty] ? st.difficulty : 'normal';
  const S = VC.createState({ size: W, difficulty: diff, seed: st.seed, name: typeof st.name === 'string' ? st.name : 'Voxelpolis', mapType: st.mapType });
  const N = S.N;
  const cx = { bmap: S.buildings, blob };

  // ---- buildings: pass 1 creates every object (so $b refs resolve), pass 2 fills fields ----
  const list = Array.isArray(st.buildings) ? st.buildings : [];
  const raw = [];
  let dropped = 0;
  for (const e of list) {
    const b = e && typeof e === 'object' ? (e.$o || e) : null;
    if (!b || !(b.id > 0) || S.buildings.has(b.id) || !num(b.x) || !num(b.z) || !num(b.w) || !num(b.d) ||
        b.x < 0 || b.z < 0 || b.w < 1 || b.d < 1 || b.x + b.w > W || b.z + b.d > H || typeof b.key !== 'string') { dropped++; continue; }
    S.buildings.set(b.id, {});
    raw.push(e);
  }
  for (const e of raw) {
    const src = e.$o || e;
    const b = S.buildings.get(src.id);
    Object.assign(b, dec(e, cx));
    if (b.hgt == null) b.hgt = 1; // renderer refines it
  }

  // ---- every other field ----
  for (const k in st) {
    if (k === 'buildings' || k === 'W' || k === 'H' || k === 'N') continue;
    const val = dec(st[k], cx);
    const cur = S[k];
    if (ArrayBuffer.isView(cur)) {
      if (!ArrayBuffer.isView(val) || val.length !== cur.length) throw friendly(DAMAGED);
      if (val.constructor === cur.constructor) S[k] = val;
      else cur.set(val);
    } else if (k === 'maps') {
      if (!isPlain(val)) continue;
      for (const mk in val) {
        const m = val[mk];
        if (!ArrayBuffer.isView(m) || m.length !== N) continue; // stale / resized map: sim recomputes
        if (cur[mk] && cur[mk].constructor !== m.constructor) cur[mk].set(m);
        else cur[mk] = m;
      }
    } else if (isPlain(cur) && isPlain(val)) {
      S[k] = mergeDefaults(cur, val);
    } else if (val !== undefined) {
      S[k] = val;
    }
  }

  // ---- consistency repair ----
  let maxId = 0, bad = 0;
  for (const b of S.buildings.values()) {
    if (b.id > maxId) maxId = b.id;
    for (let z = b.z; z < b.z + b.d && !bad; z++) for (let x = b.x; x < b.x + b.w; x++) if (S.bld[z * W + x] !== b.id) { bad = 1; break; }
  }
  if (!bad) for (let i = 0; i < N; i++) { const id = S.bld[i]; if (id && !S.buildings.has(id)) { bad = 1; break; } }
  if (bad) {
    S.bld.fill(0);
    for (const b of S.buildings.values()) for (let z = b.z; z < b.z + b.d; z++) for (let x = b.x; x < b.x + b.w; x++) S.bld[z * W + x] = b.id;
    console.warn('[save] building tile index repaired');
  }
  if (!(S.nextId > maxId)) S.nextId = maxId + 1;
  if (!S.time || !num(S.time.day)) throw friendly(DAMAGED);
  if (!num(S.money)) S.money = 0;
  if (dropped) console.warn('[save] dropped ' + dropped + ' invalid building(s)');
  // renderers compare change counters: make sure everything counts as changed
  for (const k in S.ver) S.ver[k] = (S.ver[k] | 0) + 1;
  S._saveExtra = obj.extra ? dec(obj.extra, cx) : null;
  S._saveMeta = obj.meta || null;
  return S;
}

/* ------------------------------------------------------------------ */
/* Binary container                                                     */
/* ------------------------------------------------------------------ */
function containerEncode(S, extra) {
  const sink = { parts: [], len: 0 };
  const obj = serialize(S, { sink, extra });
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const jpad = (4 - (json.length & 3)) & 3;
  const out = new Uint8Array(16 + json.length + jpad + sink.len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, json.length, true);
  dv.setUint32(12, sink.len, true);
  out.set(json, 16);
  let o = 16 + json.length + jpad;
  for (const p of sink.parts) { out.set(p, o); o += p.length; }
  return out;
}
function isContainer(u8) {
  return u8.length >= 16 && u8[0] === 0x56 && u8[1] === 0x58 && u8[2] === 0x50 && u8[3] === 0x42;
}
function containerDecode(u8) {
  if (!isContainer(u8)) throw friendly(DAMAGED);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const jl = dv.getUint32(8, true), bl = dv.getUint32(12, true);
  const jpad = (4 - (jl & 3)) & 3;
  if (16 + jl + jpad + bl > u8.length) throw friendly(DAMAGED);
  let obj;
  try { obj = JSON.parse(new TextDecoder().decode(u8.subarray(16, 16 + jl))); } catch (e) { throw friendly(DAMAGED); }
  if (!obj || typeof obj !== 'object') throw friendly(DAMAGED);
  Object.defineProperty(obj, '_blob', { value: u8.subarray(16 + jl + jpad, 16 + jl + jpad + bl), enumerable: false });
  return obj;
}

/* ------------------------------------------------------------------ */
/* gzip (native streams) + JS inflate fallback                          */
/* ------------------------------------------------------------------ */
const canGzip = () => typeof CompressionStream === 'function';
async function streamThrough(u8, ts) {
  const stream = new Blob([u8]).stream().pipeThrough(ts);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gzip(u8) {
  return streamThrough(u8, new CompressionStream('gzip'));
}
async function gunzip(u8) {
  if (typeof DecompressionStream === 'function') {
    try { return await streamThrough(u8, new DecompressionStream('gzip')); } catch (e) { /* fall through to JS */ }
  }
  return inflateGzip(u8);
}
const isGzip = (u8) => u8.length > 18 && u8[0] === 0x1f && u8[1] === 0x8b;

/** Minimal RFC1951 inflate (puff-style canonical Huffman decoding). */
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function huff(lengths, n) {
  const count = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(n);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  for (let i = 0; i < n; i++) if (lengths[i]) sym[offs[lengths[i]]++] = i;
  return { count, sym };
}
function inflateRaw(src, pos, sizeHint) {
  let out = new Uint8Array(Math.max(1024, sizeHint || src.length * 4)), op = 0;
  let bitbuf = 0, bitcnt = 0;
  const bits = (n) => {
    while (bitcnt < n) {
      if (pos >= src.length) throw friendly(DAMAGED);
      bitbuf |= src[pos++] << bitcnt;
      bitcnt += 8;
    }
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n;
    bitcnt -= n;
    return v;
  };
  const room = (n) => {
    if (op + n <= out.length) return;
    let len = out.length * 2;
    while (len < op + n) len *= 2;
    const o2 = new Uint8Array(len);
    o2.set(out.subarray(0, op));
    out = o2;
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.sym[index + (code - first)];
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    throw friendly(DAMAGED);
  };
  let fixedL = null, fixedD = null;
  for (;;) {
    const last = bits(1), type = bits(2);
    if (type === 0) {
      bitbuf = 0; bitcnt = 0;
      if (pos + 4 > src.length) throw friendly(DAMAGED);
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      if (pos + len > src.length) throw friendly(DAMAGED);
      room(len);
      out.set(src.subarray(pos, pos + len), op);
      op += len; pos += len;
    } else if (type === 1 || type === 2) {
      let lh, dh;
      if (type === 1) {
        if (!fixedL) {
          const l = new Uint8Array(288);
          l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
          fixedL = huff(l, 288);
          fixedD = huff(new Uint8Array(30).fill(5), 30);
        }
        lh = fixedL; dh = fixedD;
      } else {
        const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < ncode; i++) cl[CLORD[i]] = bits(3);
        const ch = huff(cl, 19);
        const lens = new Uint8Array(nlen + ndist);
        for (let i = 0; i < nlen + ndist;) {
          const sym = decode(ch);
          if (sym < 16) lens[i++] = sym;
          else {
            let rep, val = 0;
            if (sym === 16) { if (!i) throw friendly(DAMAGED); val = lens[i - 1]; rep = 3 + bits(2); }
            else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            if (i + rep > nlen + ndist) throw friendly(DAMAGED);
            while (rep--) lens[i++] = val;
          }
        }
        lh = huff(lens.subarray(0, nlen), nlen);
        dh = huff(lens.subarray(nlen), ndist);
      }
      for (;;) {
        let sym = decode(lh);
        if (sym < 256) { room(1); out[op++] = sym; }
        else if (sym === 256) break;
        else {
          sym -= 257;
          if (sym >= 29) throw friendly(DAMAGED);
          const len = LBASE[sym] + bits(LEXT[sym]);
          const ds = decode(dh);
          if (ds >= 30) throw friendly(DAMAGED);
          const dist = DBASE[ds] + bits(DEXT[ds]);
          if (dist > op) throw friendly(DAMAGED);
          room(len);
          for (let k = 0; k < len; k++, op++) out[op] = out[op - dist];
        }
      }
    } else throw friendly(DAMAGED);
    if (last) break;
  }
  return out.subarray(0, op);
}
function inflateGzip(u8) {
  if (!isGzip(u8) || u8[2] !== 8) throw friendly(DAMAGED);
  const flg = u8[3];
  let p = 10;
  if (flg & 4) p += 2 + (u8[p] | (u8[p + 1] << 8));
  if (flg & 8) { while (p < u8.length && u8[p]) p++; p++; }
  if (flg & 16) { while (p < u8.length && u8[p]) p++; p++; }
  if (flg & 2) p += 2;
  const n = u8.length;
  const isize = (u8[n - 4] | (u8[n - 3] << 8) | (u8[n - 2] << 16) | (u8[n - 1] << 24)) >>> 0;
  return inflateRaw(u8, p, isize);
}

/* ------------------------------------------------------------------ */
/* Storage strings / files                                              */
/* ------------------------------------------------------------------ */
/**
 * Synchronous snapshot for saving (so later mutations can't leak into an in-flight save).
 * Returns { bin: Uint8Array } (to be gzipped) or { text } (raw JSON fallback).
 */
function snapshot(S, extra) {
  if (canGzip()) return { bin: containerEncode(S, extra) };
  return { text: JSON.stringify(serialize(S, { extra })) };
}
/** Finishes a snapshot into the storage string. */
async function finish(snap) {
  if (snap.text != null) return snap.text;
  try {
    return 'VXPZ1:' + VC.b64.fromBytes(await gzip(snap.bin));
  } catch (e) {
    // compression failed (rare): store the container uncompressed
    return 'VXPB1:' + VC.b64.fromBytes(snap.bin);
  }
}
/** Storage string / exported text -> serialized object (with _blob when binary). */
async function decodeText(text) {
  if (typeof text !== 'string') throw friendly(DAMAGED);
  text = text.trim();
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let bytes = null;
  if (text.startsWith('VXPZ1:')) bytes = await gunzip(b64(text.slice(6)));
  else if (text.startsWith('VXPB1:')) bytes = b64(text.slice(6));
  else if (text[0] === '{') {
    try { return JSON.parse(text); } catch (e) { throw friendly(DAMAGED); }
  } else if (text.startsWith('H4sI')) bytes = await gunzip(b64(text)); // bare base64 gzip
  else throw friendly(DAMAGED);
  return decodeBytes(bytes);
}
function b64(s) {
  try { return VC.b64.toBytes(s.replace(/\s+/g, '')); } catch (e) { throw friendly(DAMAGED); }
}
/** Raw file bytes (gzip, container, or UTF-8 text) -> serialized object. */
async function decodeBytes(u8) {
  if (isGzip(u8)) return decodeBytes(await gunzip(u8));
  if (isContainer(u8)) return containerDecode(u8);
  let text;
  try { text = new TextDecoder().decode(u8); } catch (e) { throw friendly(DAMAGED); }
  return decodeText(text);
}

/* ------------------------------------------------------------------ */
/* Deep compare (tests / VC.save.selfTest)                              */
/* ------------------------------------------------------------------ */
/**
 * Returns up to opts.max (20) difference strings between a and b, skipping transient keys
 * ('_*', renderer building fields) and opts.skip top-level keys (e.g. {ver:1}).
 */
function diff(a, b, opts = {}) {
  const out = [], max = opts.max || 20, skipTop = opts.skip || {};
  const walk = (x, y, path, skip) => {
    if (out.length >= max) return;
    if (x === y) return;
    if (typeof x === 'number' && typeof y === 'number') { if (x !== x && y !== y) return; out.push(path + ': ' + x + ' != ' + y); return; }
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) { out.push(path + ': ' + String(x).slice(0, 40) + ' != ' + String(y).slice(0, 40)); return; }
    if (ArrayBuffer.isView(x) || ArrayBuffer.isView(y)) {
      if (!ArrayBuffer.isView(x) || !ArrayBuffer.isView(y) || x.constructor !== y.constructor || x.length !== y.length) { out.push(path + ': typed array type/length'); return; }
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && !(x[i] !== x[i] && y[i] !== y[i])) { out.push(path + '[' + i + ']: ' + x[i] + ' != ' + y[i]); return; }
      return;
    }
    if (x instanceof Map || y instanceof Map) {
      if (!(x instanceof Map) || !(y instanceof Map) || x.size !== y.size) { out.push(path + ': map size'); return; }
      for (const [k, v] of x) walk(v, y.get(k), path + '<' + k + '>', path === '.buildings' ? BLD_SKIP : null);
      return;
    }
    if (x instanceof Set || y instanceof Set) {
      if (!(x instanceof Set) || !(y instanceof Set) || x.size !== y.size) out.push(path + ': set');
      return;
    }
    if (Array.isArray(x) !== Array.isArray(y)) { out.push(path + ': array/object'); return; }
    const keys = new Set();
    for (const k in x) keys.add(k);
    for (const k in y) keys.add(k);
    for (const k of keys) {
      if (k.charCodeAt(0) === 95 || (skip && skip.test(k)) || (path === '' && skipTop[k])) continue;
      const vx = x[k], vy = y[k];
      if (typeof vx === 'function' || typeof vy === 'function') continue;
      if (vx !== undefined && vx !== null && typeof vx === 'object' && !Array.isArray(vx) && !ArrayBuffer.isView(vx) && !(vx instanceof Map) && !(vx instanceof Set) && !isPlain(vx)) continue;
      walk(vx, vy, path + '.' + k, null);
      if (out.length >= max) return;
    }
  };
  walk(a, b, '', null);
  return out;
}

VC.save = VC.save || {};
VC.save.codec = {
  VERSION: CODEC_V, MIGRATIONS, BLD_SKIP, STATE_SKIP,
  serialize, deserialize, meta, migrate, snapshot, finish, decodeText, decodeBytes,
  containerEncode, containerDecode, gzip, gunzip, inflateGzip, inflateRaw, canGzip, diff, enc, dec, friendly,
};
