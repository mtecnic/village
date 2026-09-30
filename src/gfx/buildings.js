/*
 * VOXELPOLIS — building / tree renderer (VC.bldgfx: layer 'buildings', order 100) and the shared
 * INSTANCED VOXEL ENGINE (VC.bldgfx.eng) that gfx/props.js (VC.props, layer 'props', order 150) builds on.
 *
 * INSTANCE STORE
 *   Everything drawn here (buildings, trees, props, animated parts, the placement ghost) is a SLOT:
 *   16 floats in a persistent Float32Array mirrored into an RGBA32F data texture (4 texels per slot,
 *   256 slots per 1024-texel row):
 *     t0 = x, y, z (base centre, world), yaw (radians)   t1 = scale, seed 0..1, reveal 0..1, flags (FL bits)
 *     t2 = building id, fire 0..1, popT, extra           t3 = model centre x, z (voxels), voxel size, height (voxels)
 *   popT = VC.gfx.time % 3600 of the last "pop" (squash-and-stretch bounce; trees grow in from it).
 *   extra = tree species index (SPECIES). Animated PARTS keep a 3x4 world matrix in t0..t2 (rows) and
 *   (seed, reveal, flags, id) in t3. Slots change only on events — bus bldAdd / bldRemove / bldChange,
 *   'dirty' rects (trees, terrain height), live construction / fire / UFO lifts, 'flagsUpdated' — and only
 *   changed slots are uploaded (per-slot texSubImage2D, or dirty-row runs for bulk changes).
 *
 * CULLING + LOD (per pass: camera, each shadow cascade)
 *   Slots are bucketed per 8x8-tile CELL (per set: 0 = buildings/trees/parts, 1 = props) with conservative
 *   bounds. Visible cells (ctx.frustum, or planes from the camera matrix) are scanned; each instance picks a
 *   LOD tier by camera distance (0 full mesh, 1 model.lod, 2 a 1/4-resolution mesh built lazily here from
 *   model.grid), tiny/far things are skipped, and the visible slot indices are counting-sorted per
 *   (model, tier) into a stream buffer. Result: ONE drawElementsInstanced per visible (model, tier); the
 *   vertex shader reads the instance from the data texture (attribute 2 = slot index). Shadow passes use
 *   tier >= 1 (the far cascade tier 2) and skip small casters.
 *
 * SHADERS: one uber voxel shader with #define variants: KIND 0 building, 1 tree, 2 prop, 3 part (matrix);
 *   SHADOW (depth only; trees keep a discard for bare winter crowns); GHOST (translucent hologram).
 *   Buildings: construction reveal (vertices clamp to the cut plane, so the shell stays closed and
 *   rises layer by layer) with a glowing cut line, scaffolding + netting band and a poured-slab cap; night
 *   windows lit per window from per-zone schedules driven by the time of day (homes in the evening,
 *   offices dark late, TV flicker, warm/neutral/cool tints), unpowered/abandoned buildings dark; sky
 *   reflections + sun specular on glass/windows/metal; snow on up faces (not NOSNOW); rain sheen;
 *   abandoned grime + boarded/broken windows; fire glow from inside with a charred top that grows with
 *   b.fire; pulsing cyan rim + scanline on the selected building, brighten (select) / red (bulldoze) on
 *   hover; earthquake shaking. Trees: wind sway with travelling gusts + leaf flutter, autumn colours per
 *   species/tree, bare deciduous crowns in winter, blossoms in spring, snow caps, backlit leaves.
 *   Coarse LOD tiers (uFar) paint procedural lit windows on facades so the far city still sparkles.
 *   Camera-pass buckets are drawn nearest first (early-Z), tree 'discard' only exists in the winter
 *   variant, wet top faces are left to shade() when the lighting library handles them (BG_LIBWET), and
 *   LIB_SOFT (software rasterizer) uses a cheap sky gradient for reflections and coarser LOD distances.
 *
 * GLOW SPRITES: model.lights become additive camera-facing soft sprites (transparent pass): night-only
 *   lights switch on progressively at dusk, always-on lights stay lit, red always-on lights blink
 *   (aviation beacons). Static sprites are rebuilt (throttled) when instances/flags change; props and
 *   animated parts add dynamic sprites every frame (eng.dynSprite).
 *
 * CONSTRUCTION: while b.built < 0.3 a 'construction' site model (if defined) rises on the lot, then the
 *   real model rises (reveal = (built - 0.3) / 0.7); level-up replays (b.simReplay) reveal from b.built.
 *   Completion and level changes "pop". Models are built lazily through VC.models; uncached models queue
 *   and are built within a per-frame time budget (no hitches), VC.bldgfx.warm() flushes the queue.
 *
 * API (VC.bldgfx): setGhost({key, x, z, rot, valid} | null), handlesLift (true: draws b.disLift UFO lifts),
 *   warm(ms?) (build queued models now), inspect(id) (debug: render state of a building), stats,
 *   eng (instancing engine used by gfx/props.js, see E at the end of this file), SPECIES, FL.
 * Also reads: VC.tools.selectedId / hoverId / hover / current, VC.disasters.active (earthquake shake,
 *   UFO lifts), VC.particles.burst('dust') when a construction site turns into its building, VC.gfx.env.
 */
const M = VC.M, C = VC.C;
const TAU = Math.PI * 2;
const SLOT_F = 16; // floats per slot
const ROW_SLOTS = 256; // slots per data-texture row
const TEX_W = ROW_SLOTS * 4; // texels per row
const CS = 8; // cell size (tiles)
const K_BLD = 0, K_TREE = 1, K_PROP = 2, K_PART = 3, NK = 4;
const SET_MAIN = 0, SET_PROPS = 1;
/** Instance flag bits (t1.w). */
const FL = { ABANDONED: 1, FIRE: 2, UNPOWERED: 4, R: 8, C: 16, I: 32, CIVIC: 64, GHOST_BAD: 128, NIGHTLIFE: 256, RUBBLE: 512, SITE: 1024, LIFT: 2048 };
/** Tree species; the index is stored in t2.w. 3..5 are evergreen. */
const SPECIES = ['tree_oak', 'tree_maple', 'tree_birch', 'tree_pine', 'tree_cypress', 'tree_palm', 'tree_cherry', 'tree_bush'];
const NO_POP = -1000;
const SITE_END = 0.3; // construction site phase (fraction of b.built)
const NIGHTLIFE_KEYS = { casino: 1, stadium: 1, ferris_wheel: 1, tv_tower: 1, arcology: 1, sports_field: 1 };

const B = (VC.bldgfx = {
  name: 'buildings',
  order: 100,
  handlesLift: true,
  FL,
  SPECIES,
  stats: { slots: 0, buildings: 0, trees: 0, parts: 0, models: 0, pending: 0, l2: 0, sprites: 0, dynSprites: 0, visible: 0, draws: 0, verts: 0, gatherMs: 0 },

  init() {
    gl = VC.gfx.gl;
    initGL();
    VC.gfx.addLayer(B);
    const bus = VC.bus;
    bus.on('bldAdd', (b) => live() && onAdd(b));
    bus.on('bldRemove', (b) => live() && onRemove(b));
    bus.on('bldChange', (b) => live() && onChange(b));
    bus.on('dirty', (r) => live() && onDirty(r));
    bus.on('flagsUpdated', () => (flagsAll = true));
    bus.on('day', () => (flagsAll = true));
    bus.on('policyChanged', () => (flagsAll = true));
    if (VC.props && VC.props.init) callSafe(VC.props.init, VC.props);
  },

  reset(S) {
    resetAll(S);
    if (VC.props && VC.props.reset) callSafe(VC.props.reset, VC.props, S);
  },

  update(dt, rdt) {
    const S = VC.state;
    if (!S || !gl || curS !== S) return;
    nDyn = 0;
    try {
      frameUpdate(S, rdt || 0);
    } catch (e) {
      if (!B._err) console.error('[bldgfx] update failed', e);
      B._err = (B._err || 0) + 1;
    }
    const PR = VC.props;
    if (PR && PR.tick) {
      PR.driven = true; // main.js may list 'props' one day: its direct update() call then becomes a no-op
      callSafe(PR.tick, PR, dt, rdt);
    } else if (PR && PR.update) callSafe(PR.update, PR, dt, rdt);
    try {
      flushTex();
    } catch (e) {
      if (!B._texErr) console.error('[bldgfx] texture upload failed', e);
      B._texErr = true;
    }
  },

  shadow(ctx) {
    drawSet(ctx, SET_MAIN, true);
  },
  opaque(ctx) {
    drawSet(ctx, SET_MAIN, false);
  },
  transparent(ctx) {
    drawGhost(ctx);
    drawSprites(ctx);
  },

  /** Placement preview: {key, x, z, rot, valid} or null. Draws the catalog model as a hologram. */
  setGhost(g) {
    if (!g || !g.key || !VC.models.has(g.key)) {
      ghost = null;
      return;
    }
    let m = null;
    try {
      m = VC.models.get(g.key, 0);
    } catch (e) {
      m = null;
    }
    if (!m) {
      ghost = null;
      return;
    }
    const def = VC.BLD[g.key];
    const rot = (g.rot | 0) & 3;
    const sz = def ? def.size : [Math.max(1, Math.round(m.sx / 8)), Math.max(1, Math.round(m.sz / 8))];
    const w = rot & 1 ? sz[1] : sz[0], d = rot & 1 ? sz[0] : sz[1];
    ghost = { key: g.key, x: g.x | 0, z: g.z | 0, w, d, rot, valid: !!g.valid, mw: getMW(m, K_BLD) };
  },

  /** Debug: render state of building id -> {slot, model, site, reveal, flags, y, lift, fire, parts, pending} or null. */
  inspect(id) {
    const rec = recs.get(id);
    if (!rec) return null;
    const o = rec.slot * SLOT_F;
    return {
      slot: rec.slot, model: rec.mw ? rec.mw.m.key : null, site: rec.site, pending: rec.pending,
      reveal: rec.slot > 0 ? D[o + 6] : null, flags: rec.slot > 0 ? D[o + 7] : null,
      y: rec.slot > 0 ? D[o + 1] : null, yaw: rec.slot > 0 ? D[o + 3] : null, lift: rec.lift, fire: rec.slot > 0 ? D[o + 9] : null,
      popT: rec.slot > 0 ? D[o + 10] : null, parts: rec.parts ? rec.parts.length : 0, live: liveSet.has(rec),
    };
  },

  /** Builds queued models synchronously (up to ms milliseconds, default: all). Returns the remaining queue length. */
  warm(ms) {
    if (curS !== VC.state) return 0;
    processPending(ms == null ? 1e9 : ms);
    flushTex();
    return pendQ.length;
  },
});

function callSafe(fn, self, a, b) {
  try {
    fn.call(self, a, b);
  } catch (e) {
    console.error('[bldgfx] props call failed', e);
  }
}
const live = () => !!gl && curS && curS === VC.state;

/* ================================================================== */
/* Engine state                                                        */
/* ================================================================== */
let gl = null;
let curS = null;
let cap = 0, D = null;
let sModel = null, sSet = null, sCell = null, sPos = null, sDirty = null, sLit = null;
let freeStack = null, nFree = 0;
let dirtyList = new Int32Array(1024), nDirty = 0, dirtyAll = false, rowLo = 1e9, rowHi = -1, rowDirty = new Uint8Array(0);
let dataTex = null, texRealloc = true;
// gather scratch
let tmpB = null, tmpS = null, out = null;
let bCnt = new Int32Array(0), bCur = new Int32Array(0), bStart = new Int32Array(0), used = new Int32Array(0), nUsed = 0;
let bMin = new Float32Array(0), sortKeys = new Float64Array(0);
// cells
let cw = 0, cht = 0, nCells = 0;
const cellL = [[], []];
const cellN = [new Int32Array(0), new Int32Array(0)];
const cellB = [new Float32Array(0), new Float32Array(0)]; // per cell: x0, z0, x1, z1, y0, y1
let cellSeen = new Int32Array(0); // frameCount when the camera pass last saw the cell (set 0)
// models
const MWS = [];
const mwMap = new Map();
let mwKind = new Uint8Array(64), mwHasL2 = new Uint8Array(64), mwL2State = new Uint8Array(64);
const mwSkip = [new Float32Array(64), new Float32Array(64), new Float32Array(64)]; // (factor * lodDist)^2 per mode (camera, shadow near, shadow far), in units of lodDist^2
const l2Queue = [];
// lit slots (model has lights) for the static sprite list
let litList = new Int32Array(256), nLit = 0;
let spritesDirty = true, spriteT = 0;
// buildings, trees, parts
const recs = new Map(); // building id -> rec
const liveSet = new Set(); // recs needing per-frame updates
const pendQ = []; // recs waiting for their model
const parts = []; // part records
let flagsAll = true, flagCursor = 0, recsVer = 0, rrVer = -1;
const rrList = [];
let treeSlot = null, treeSig = null;
let treeKinds = null; // available species indices
let ghost = null;
let hasSite = false;
let seenTreeVer = -1, treeScan = false;
let warmList = null, warmIdle = false;
// GL objects
let streamBuf = null, streamCap = 0;
const PROGS = [[], [], [], []];
let ghostProg = null, sprProg = null;
let sprVao = null, sprBuf = null, sprData = new Float32Array(8 * 1024), nSpr = 0;
let dynVao = null, dynBuf = null, dynData = new Float32Array(8 * 256), nDyn = 0;
const planesTmp = new Float32Array(24);
let quality = null;
const U = { sched: [0, 0, 0, 0], bg: [0, 0, 0, 0], quake: [0, 0, 1, 0] };

/* ================================================================== */
/* Slots                                                               */
/* ================================================================== */
function growI32(a, n, fill) {
  const o = new Int32Array(n);
  if (fill) o.fill(fill);
  if (a) o.set(a);
  return o;
}
function growU8(a, n, fill) {
  const o = new Uint8Array(n);
  if (fill) o.fill(fill);
  if (a) o.set(a);
  return o;
}
function growCap(need) {
  let nc = Math.max(4096, cap);
  while (nc < need) nc *= 2;
  nc = Math.ceil(nc / ROW_SLOTS) * ROW_SLOTS;
  if (nc <= cap) return;
  const oD = D;
  D = new Float32Array(nc * SLOT_F);
  if (oD) D.set(oD);
  sModel = growI32(sModel, nc, -1);
  sSet = growU8(sSet, nc, 255);
  sCell = growI32(sCell, nc, -1);
  sPos = growI32(sPos, nc, 0);
  sDirty = growU8(sDirty, nc, 0);
  sLit = growI32(sLit, nc, 0);
  const nf = new Int32Array(nc);
  if (freeStack) nf.set(freeStack.subarray(0, nFree));
  for (let s = nc - 1; s >= Math.max(cap, 1); s--) nf[nFree++] = s; // slot 0 = ghost (never allocated)
  freeStack = nf;
  cap = nc;
  tmpB = new Int32Array(nc);
  tmpS = new Int32Array(nc);
  out = new Uint32Array(nc);
  rowDirty = growU8(rowDirty, nc / ROW_SLOTS, 0);
  texRealloc = true;
}
function alloc(set) {
  if (!nFree) growCap(cap + 1);
  const s = freeStack[--nFree];
  sSet[s] = set;
  sModel[s] = -1;
  sCell[s] = -1;
  return s;
}
function release(s) {
  if (s <= 0 || sSet[s] === 255) return;
  cellRemove(s);
  setLit(s, false);
  sModel[s] = -1;
  sSet[s] = 255;
  freeStack[nFree++] = s;
}
function markDirty(s) {
  if (sDirty[s]) return;
  sDirty[s] = 1;
  const r = s >> 8;
  rowDirty[r] = 1;
  if (r < rowLo) rowLo = r;
  if (r > rowHi) rowHi = r;
  if (nDirty < dirtyList.length) dirtyList[nDirty++] = s;
  else dirtyAll = true;
}
function resetPixelStore() {
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
}
/** Uploads changed slots to the data texture (or reallocates it after growth). */
function flushTex() {
  if (!gl || !cap) return;
  if (texRealloc) {
    if (dataTex) gl.deleteTexture(dataTex);
    dataTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, dataTex);
    resetPixelStore();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, cap / ROW_SLOTS, 0, gl.RGBA, gl.FLOAT, D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    texRealloc = false;
    sDirty.fill(0);
    rowDirty.fill(0);
    nDirty = 0;
    dirtyAll = false;
    rowLo = 1e9;
    rowHi = -1;
    return;
  }
  if (!nDirty && !dirtyAll) return;
  gl.bindTexture(gl.TEXTURE_2D, dataTex);
  resetPixelStore();
  if (dirtyAll || nDirty > 160) {
    // runs of dirty rows
    for (let r = rowLo; r <= rowHi; r++) {
      if (!rowDirty[r]) continue;
      let e = r;
      while (e + 1 <= rowHi && rowDirty[e + 1]) e++;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, e - r + 1, gl.RGBA, gl.FLOAT, D, r * ROW_SLOTS * SLOT_F);
      sDirty.fill(0, r * ROW_SLOTS, (e + 1) * ROW_SLOTS);
      r = e;
    }
  } else {
    for (let i = 0; i < nDirty; i++) {
      const s = dirtyList[i];
      sDirty[s] = 0;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, (s & 255) * 4, s >> 8, 4, 1, gl.RGBA, gl.FLOAT, D, s * SLOT_F);
    }
  }
  if (rowHi >= rowLo) rowDirty.fill(0, rowLo, rowHi + 1);
  nDirty = 0;
  dirtyAll = false;
  rowLo = 1e9;
  rowHi = -1;
}

/* ================================================================== */
/* Cells                                                               */
/* ================================================================== */
function initCells(S) {
  cw = Math.ceil(S.W / CS);
  cht = Math.ceil(S.H / CS);
  nCells = cw * cht;
  for (let set = 0; set < 2; set++) {
    cellL[set] = new Array(nCells).fill(null);
    cellN[set] = new Int32Array(nCells);
    const b = (cellB[set] = new Float32Array(nCells * 6));
    for (let c = 0; c < nCells; c++) {
      const x = (c % cw) * CS, z = ((c / cw) | 0) * CS;
      b[c * 6] = x; b[c * 6 + 1] = z; b[c * 6 + 2] = Math.min(S.W, x + CS); b[c * 6 + 3] = Math.min(S.H, z + CS);
      b[c * 6 + 4] = 1e9; b[c * 6 + 5] = -1e9;
    }
  }
  cellSeen = new Int32Array(nCells);
}
function cellOf(x, z) {
  const cx = M.clamp(Math.floor(x / CS), 0, cw - 1), cz = M.clamp(Math.floor(z / CS), 0, cht - 1);
  return cz * cw + cx;
}
/** Puts slot s into the cell containing (x, z) and grows that cell's bounds by radius r / [y0, y1]. */
function place(s, x, z, r, y0, y1) {
  const set = sSet[s];
  const c = cellOf(x, z);
  if (sCell[s] !== c) {
    cellRemove(s);
    let L = cellL[set][c];
    const n = cellN[set][c];
    if (!L || n >= L.length) {
      const nl = new Int32Array(Math.max(16, n * 2));
      if (L) nl.set(L);
      cellL[set][c] = L = nl;
    }
    L[n] = s;
    sPos[s] = n;
    sCell[s] = c;
    cellN[set][c] = n + 1;
  }
  const b = cellB[set], o = c * 6;
  if (x - r < b[o]) b[o] = x - r;
  if (z - r < b[o + 1]) b[o + 1] = z - r;
  if (x + r > b[o + 2]) b[o + 2] = x + r;
  if (z + r > b[o + 3]) b[o + 3] = z + r;
  if (y0 < b[o + 4]) b[o + 4] = y0;
  if (y1 > b[o + 5]) b[o + 5] = y1;
}
function cellRemove(s) {
  const c = sCell[s];
  if (c < 0) return;
  const set = sSet[s];
  const L = cellL[set][c];
  const n = --cellN[set][c];
  const p = sPos[s];
  const last = L[n];
  L[p] = last;
  sPos[last] = p;
  sCell[s] = -1;
}

/* ================================================================== */
/* Model wrappers                                                      */
/* ================================================================== */
function ensureMwArrays(n) {
  if (n <= mwKind.length) return;
  let len = mwKind.length;
  while (len < n) len *= 2;
  mwKind = growU8(mwKind, len, 0);
  mwHasL2 = growU8(mwHasL2, len, 0);
  mwL2State = growU8(mwL2State, len, 0);
  for (let k = 0; k < 3; k++) {
    const a = new Float32Array(len);
    a.set(mwSkip[k]);
    mwSkip[k] = a;
  }
}
/** Default skip distances (in lodDist units) per kind: [camera, shadow near, shadow far]. */
const SKIP_DEF = [
  [Infinity, Infinity, Infinity], // buildings: always drawn
  [Infinity, 2.2, 3.2], // trees
  [1.4, 0.45, 0], // props
  [2.5, 0.8, 0], // parts
];
/** Returns the renderer wrapper of VC model m for a kind (created on first use). */
function getMW(m, kind) {
  if (!m) return null;
  let arr = mwMap.get(m);
  if (!arr) mwMap.set(m, (arr = []));
  if (arr[kind]) return arr[kind];
  const idx = MWS.length;
  ensureMwArrays(idx + 1);
  const l0 = m.vao && m.quads ? { vao: m.vao, quads: m.quads } : null;
  const l1 = m.lod && m.lod.vao && m.lod.quads ? { vao: m.lod.vao, quads: m.lod.quads } : l0;
  const mw = {
    idx, m, kind,
    lv: [l0, l1, null],
    vox: m.vox || C.VOX,
    cx: m.sx / 2, cz: m.sz / 2, h: m.sy,
    height: m.height || m.sy * (m.vox || C.VOX),
    radius: Math.hypot(m.sx, m.sz) * 0.5 * (m.vox || C.VOX),
    lights: m.lights && m.lights.length ? m.lights : null,
    noStaticLights: false,
    pool: false,
  };
  MWS.push(mw);
  arr[kind] = mw;
  mwKind[idx] = kind;
  mwHasL2[idx] = 0;
  mwL2State[idx] = l0 ? 0 : 3;
  // tiny models (bushes, hydrants) are skipped earlier
  const small = mw.height < 0.35 && mw.radius < 0.45;
  for (let k = 0; k < 3; k++) {
    const f = SKIP_DEF[kind][k] * (small && kind !== K_BLD ? 0.6 : 1);
    mwSkip[k][idx] = f === Infinity ? Infinity : f * f;
  }
  B.stats.models = MWS.length;
  return mw;
}
/** Overrides skip distances (in units of quality lodDist; Infinity = never skip, 0 = never draw) for a wrapper. */
function setSkip(mw, cam, shNear, shFar) {
  const a = [cam, shNear, shFar];
  for (let k = 0; k < 3; k++) mwSkip[k][mw.idx] = a[k] === Infinity ? Infinity : a[k] * a[k];
}
/** Fast 1/4-resolution downsample (most common colour of each 4x4x4 block, windows/emissive preferred). */
function downsample4(g) {
  const f = 4, nx = Math.ceil(g.sx / f), ny = Math.ceil(g.sy / f), nz = Math.ceil(g.sz / f);
  const o = new VC.VoxelGrid(nx, ny, nz);
  const v = g.v, sx = g.sx, sz = g.sz, sy = g.sy, pal = VC.voxel.palette;
  const cols = new Uint8Array(64), cnts = new Float32Array(64);
  for (let by = 0; by < ny; by++)
    for (let bz = 0; bz < nz; bz++)
      for (let bx = 0; bx < nx; bx++) {
        let nc = 0, n = 0;
        for (let y = by * f; y < Math.min(sy, by * f + f); y++)
          for (let z = bz * f; z < Math.min(sz, bz * f + f); z++) {
            let i = bx * f + sx * (z + sz * y);
            for (let x = bx * f; x < Math.min(sx, bx * f + f); x++, i++) {
              const c = v[i];
              if (!c) continue;
              n++;
              let k = 0;
              while (k < nc && cols[k] !== c) k++;
              if (k === nc) { cols[nc] = c; cnts[nc] = pal[c * 4 + 3] & 5 ? 0.6 : 0; nc++; }
              cnts[k] += 1;
            }
          }
        if (n >= 6 || (n > 0 && by === 0)) {
          let best = 0;
          for (let k = 1; k < nc; k++) if (cnts[k] > cnts[best]) best = k;
          o.v[bx + nx * (bz + nz * by)] = cols[best];
        }
      }
  return o;
}
function buildL2(mi) {
  const mw = MWS[mi];
  const g = mw.m.grid;
  if (!g || !VC.voxel.mesh) { mwL2State[mi] = 3; return; }
  const small = downsample4(g);
  const mesh = VC.voxel.mesh(small, 4);
  if (!mesh.quads) { mwL2State[mi] = 3; return; }
  mw.lv[2] = VC.voxel.upload(mesh);
  mwHasL2[mi] = 1;
  mwL2State[mi] = 2;
  B.stats.l2++;
}

/* ================================================================== */
/* Lit slots (sprites)                                                 */
/* ================================================================== */
function setLit(s, on) {
  const p = sLit[s];
  if (on) {
    if (p) return;
    if (nLit >= litList.length) litList = growI32(litList, litList.length * 2, 0);
    litList[nLit++] = s;
    sLit[s] = nLit;
  } else if (p) {
    const last = litList[--nLit];
    litList[p - 1] = last;
    sLit[last] = p;
    sLit[s] = 0;
  }
  spritesDirty = true;
}
/** Sets the model of slot s (mw may be null = hidden) and keeps derived state in sync. */
function setModel(s, mw) {
  const mi = mw ? mw.idx : -1;
  if (sModel[s] === mi) return;
  sModel[s] = mi;
  setLit(s, !!(mw && mw.lights && !mw.noStaticLights));
  if (mw) {
    const o = s * SLOT_F;
    if (mwKind[mi] !== K_PART) {
      D[o + 12] = mw.cx; D[o + 13] = mw.cz; D[o + 14] = mw.vox; D[o + 15] = mw.h;
    }
    markDirty(s);
  }
}

/* ================================================================== */
/* Buildings                                                           */
/* ================================================================== */
const nowT = () => (VC.gfx.time || 0) % 3600;
function seedOf(b) {
  return (((b.variant | 0) * 7919 + b.id * 131) % 1009) / 1009;
}
function fwOf(b) { return b.rot & 1 ? b.d : b.w; }
function fdOf(b) { return b.rot & 1 ? b.w : b.d; }
function wantsSite(b) {
  return hasSite && b.built < SITE_END && !b.simReplay && b.key !== 'rubble' && b.key !== 'crater';
}
function revealOf(b, site) {
  const bt = M.clamp(b.built == null ? 1 : b.built, 0, 1);
  if (bt >= 1) return 1;
  if (site) return Math.min(1, bt / SITE_END);
  if (b.simReplay || !hasSite || b.key === 'rubble') return bt;
  return M.clamp((bt - SITE_END) / (1 - SITE_END), 0, 1);
}
/** Model cache key for b (mirrors VC.models.forBuilding) — used to avoid synchronous builds. */
function cacheKeyFor(b, site) {
  const defs = VC.models.defs;
  let key, params = null;
  if (site) {
    key = 'construction';
    params = { fw: fwOf(b), fd: fdOf(b) };
  } else if (b.key === 'grow') {
    const zk = (VC.ZONES[b.zt] || VC.ZONES[1]).key;
    key = 'grow_' + zk + b.den;
    params = { fw: fwOf(b), fd: fdOf(b), level: b.level, wealth: b.wealth || 0 };
  } else {
    key = b.key;
    const def = defs[key];
    if (def && def.sized) params = { fw: fwOf(b), fd: fdOf(b) };
  }
  const def = defs[key];
  if (!def) return null;
  const nv = def.variants || 1;
  const v = (((b.variant | 0) % nv) + nv) % nv;
  return VC.models.cacheKey(key, v, params);
}
function modelFor(b, site) {
  if (site) return VC.models.get('construction', b.variant, { fw: fwOf(b), fd: fdOf(b) });
  return VC.models.forBuilding(b);
}
function flagsOf(b, rec) {
  let f = 0;
  if (b.abandoned) f |= FL.ABANDONED;
  if (b.fire > 0) f |= FL.FIRE;
  if (b.powered === false) f |= FL.UNPOWERED;
  if (b.key === 'grow') f |= b.zt === 1 ? FL.R : b.zt === 2 ? FL.C : FL.I;
  else if (b.key === 'rubble' || b.key === 'crater') f |= FL.RUBBLE;
  else f |= FL.CIVIC;
  if (NIGHTLIFE_KEYS[b.key]) f |= FL.NIGHTLIFE;
  if (b.key === 'grow' && b.zt === 2 && curS && curS.policies && curS.policies.nightlife) f |= FL.NIGHTLIFE;
  if (rec && rec.site) f |= FL.SITE;
  if (b.disLift > 0) f |= FL.LIFT;
  return f;
}
function isLive(rec) {
  const b = rec.b;
  return rec.reveal < 1 || b.built < 1 || b.fire > 0 || rec.fire > 0 || b.disLift > 0 || rec.lift > 0;
}
function onAdd(b) {
  if (recs.has(b.id)) onRemove(recs.get(b.id).b);
  const rec = { b, slot: -1, mw: null, site: false, parts: null, reveal: 1, q: -1, fire: 0, flags: 0, popT: NO_POP, lift: 0, pending: false, y: 0 };
  recs.set(b.id, rec);
  recsVer++;
  resolveRec(rec, false);
  B.stats.buildings = recs.size;
}
function onRemove(b) {
  const rec = recs.get(b.id);
  if (!rec) return;
  freeParts(rec);
  if (rec.slot > 0) release(rec.slot);
  rec.slot = -1;
  recs.delete(b.id);
  recsVer++;
  liveSet.delete(rec);
  rec.removed = true;
  spritesDirty = true;
  B.stats.buildings = recs.size;
}
function onChange(b) {
  const rec = recs.get(b.id);
  if (!rec) return onAdd(b);
  resolveRec(rec, false);
}
/** Finds / builds the model of rec and (re)writes its slot. Queues uncached models unless `build`. */
function resolveRec(rec, build) {
  const b = rec.b;
  const site = wantsSite(b);
  const ck = cacheKeyFor(b, site);
  if (!build && ck && !VC.models.cached().has(ck)) {
    if (!rec.pending) {
      rec.pending = true;
      pendQ.push(rec);
    }
    // keep showing the old model meanwhile (a level-up keeps the old look until the new one exists)
    if (rec.slot > 0) refreshRec(rec);
    return false;
  }
  let m = null;
  try {
    m = modelFor(b, site);
  } catch (e) {
    console.error('[bldgfx] model failed for', b.key, e);
  }
  rec.pending = false;
  const mw = m ? getMW(m, K_BLD) : null;
  if (!mw || !mw.lv[0]) {
    if (rec.slot > 0) { release(rec.slot); rec.slot = -1; }
    freeParts(rec);
    return true;
  }
  const wasSite = rec.site;
  rec.site = site;
  rec.level = b.level;
  rec.wealth = b.wealth;
  if (!site) b.hgt = mw.height;
  else if (!b.hgt || b.hgt < 0.3) b.hgt = 0.3;
  if (rec.slot < 0) rec.slot = alloc(SET_MAIN);
  let newParts = false;
  if (rec.mw !== mw) {
    if (wasSite && !site && rec.mw) siteDone(b);
    // a finished building swapping models (level / wealth change) pops when the new look appears
    else if (rec.mw && !wasSite && !site) rec.popT = nowT();
    rec.mw = mw;
    setModel(rec.slot, mw);
    freeParts(rec);
    newParts = !site && !!(mw.m.parts && mw.m.parts.length);
  }
  refreshRec(rec, true);
  if (newParts) makeParts(rec); // after the parent slot is written (parts derive their matrix from it)
  return true;
}
/** Rewrites the whole slot of rec from the building state. */
function refreshRec(rec, full) {
  const b = rec.b, s = rec.slot, mw = rec.mw;
  if (s <= 0 || !mw) return;
  const o = s * SLOT_F;
  const reveal = revealOf(b, rec.site);
  const lift = b.disLift > 0 ? b.disLift : 0;
  const cx = b.x + b.w / 2, cz = b.z + b.d / 2;
  const gy = VC.world.topY(b.x, b.z);
  rec.y = gy;
  const spin = lift > 0 ? lift * 0.35 + Math.sin((VC.gfx.time || 0) * 2) * 0.05 * Math.min(1, lift) : 0;
  const wasBuilding = rec.reveal < 1 && !rec.site;
  rec.reveal = reveal;
  rec.fire = b.fire > 0 ? b.fire : 0;
  rec.lift = lift;
  rec.flags = flagsOf(b, rec);
  if (wasBuilding && reveal >= 1 && !full) {
    rec.popT = nowT();
    spritesDirty = true;
  }
  D[o] = cx; D[o + 1] = gy + lift; D[o + 2] = cz; D[o + 3] = (b.rot & 3) * Math.PI * 0.5 + spin;
  D[o + 4] = 1; D[o + 5] = seedOf(b); D[o + 6] = reveal; D[o + 7] = rec.flags;
  D[o + 8] = b.id; D[o + 9] = rec.fire; D[o + 10] = rec.popT; D[o + 11] = 0;
  D[o + 12] = mw.cx; D[o + 13] = mw.cz; D[o + 14] = mw.vox; D[o + 15] = mw.h;
  markDirty(s);
  rec.q = Math.floor(reveal * mw.h + 0.5);
  const r = Math.max(mw.radius, Math.hypot(b.w, b.d) * 0.5) + 0.3;
  place(s, cx, cz, r, gy - 0.3, gy + lift + mw.height * 1.2 + 0.5);
  if (isLive(rec)) liveSet.add(rec);
  spritesDirty = true;
}
/** Dust puff when the construction site turns into the building. */
function siteDone(b) {
  const P = VC.particles;
  if (P && P.burst) {
    try {
      P.burst('dust', b.x + b.w / 2, VC.world.topY(b.x, b.z) + 0.2, b.z + b.d / 2, 8 + b.w * b.d * 3, { spread: Math.max(b.w, b.d) * 0.5 });
    } catch (e) { /* optional */ }
  }
}
/** Per-frame work for buildings under construction / burning / being lifted. */
function updateLive() {
  // UFO lifts: disasters set b.disLift without a bldChange
  const A = VC.disasters && VC.disasters.active;
  if (A && A.length) {
    for (const e of A) {
      const L = e && e.lifting;
      if (L && L.b) {
        const rec = recs.get(L.b.id);
        if (rec && rec.slot > 0) liveSet.add(rec);
      }
    }
  }
  if (!liveSet.size) return;
  for (const rec of liveSet) {
    const b = rec.b;
    if (rec.removed || rec.slot <= 0) { liveSet.delete(rec); continue; }
    if (rec.pending) continue;
    const site = wantsSite(b);
    if (site !== rec.site) {
      resolveRec(rec, false);
      continue;
    }
    const s = rec.slot, o = s * SLOT_F;
    const reveal = revealOf(b, site);
    const q = Math.floor(reveal * rec.mw.h + 0.5);
    const fire = b.fire > 0 ? b.fire : 0;
    const lift = b.disLift > 0 ? b.disLift : 0;
    if (reveal >= 1 && rec.reveal < 1) {
      refreshRec(rec, false); // completion pop + sprites
    } else if (q !== rec.q || Math.abs(fire - rec.fire) > 0.004 || lift !== rec.lift || (lift === 0) !== (rec.lift === 0)) {
      if (lift > 0 || rec.lift > 0 || (fire > 0) !== (rec.fire > 0)) refreshRec(rec, true);
      else {
        rec.reveal = reveal;
        rec.q = q;
        rec.fire = fire;
        D[o + 6] = reveal;
        D[o + 9] = fire;
        markDirty(s);
      }
    }
    if (!isLive(rec)) liveSet.delete(rec);
  }
}
/** Re-evaluates instance flags (power, abandonment, fire, zone) — all at once after network updates. */
function refreshFlags() {
  if (!recs.size) return;
  if (flagsAll) {
    flagsAll = false;
    for (const rec of recs.values()) checkFlags(rec);
    return;
  }
  // round robin: a few per frame catch changes made without events (e.g. b.powered)
  if (rrVer !== recsVer) {
    rrList.length = 0;
    for (const rec of recs.values()) rrList.push(rec);
    rrVer = recsVer;
  }
  const n = Math.min(48, rrList.length);
  for (let k = 0; k < n; k++) {
    flagCursor = (flagCursor + 1) % rrList.length;
    const rec = rrList[flagCursor];
    if (!rec.removed) checkFlags(rec);
  }
}
function checkFlags(rec) {
  if (rec.slot <= 0 || rec.pending) return;
  const f = flagsOf(rec.b, rec);
  if (f !== rec.flags) {
    rec.flags = f;
    D[rec.slot * SLOT_F + 7] = f;
    markDirty(rec.slot);
    spritesDirty = true;
    if (isLive(rec)) liveSet.add(rec);
  }
  if (rec.b.fire > 0 && !liveSet.has(rec)) liveSet.add(rec);
}
/** Builds queued models within a time budget. */
function processPending(budgetMs) {
  if (!pendQ.length) return;
  const t0 = performance.now();
  let i = 0;
  while (i < pendQ.length) {
    const rec = pendQ[i++];
    if (rec.removed || !rec.pending) continue;
    rec.pending = false;
    resolveRec(rec, true);
    if (performance.now() - t0 > budgetMs) break;
  }
  pendQ.splice(0, i);
  B.stats.pending = pendQ.length;
}

/**
 * Idle prewarm: catalog models (+ their parts and the construction site) are built one at a time while
 * the browser is idle, so the first placement ghost / new building never hitches. Needs requestIdleCallback.
 */
function prewarm() {
  if (warmIdle || typeof requestIdleCallback !== 'function') return;
  if (!warmList) {
    warmList = [];
    for (const d of VC.CATALOG || []) if (VC.models.has(d.key)) warmList.push([d.key, 0]);
    for (const k of SPECIES) if (VC.models.has(k)) warmList.push([k, 0]);
  }
  if (!warmList.length) return;
  warmIdle = true;
  requestIdleCallback((dl) => {
    warmIdle = false;
    while (warmList.length && dl.timeRemaining() > 4) {
      const [key, v] = warmList.shift();
      try {
        const m = VC.models.get(key, v);
        const parts = m && m.parts;
        if (parts) for (const p of parts) if (p && p.model && VC.models.has(p.model)) VC.models.get(p.model, p.variant || 0);
      } catch (e) { /* the registry logs generator failures */ }
    }
  }, { timeout: 2000 });
}

/* ---------------- animated parts ---------------- */
function makeParts(rec) {
  const list = rec.mw.m.parts;
  rec.parts = [];
  for (const def of list) {
    if (!def || !def.model || !VC.models.has(def.model)) continue;
    let pm = null;
    try {
      pm = VC.models.get(def.model, def.variant || 0);
    } catch (e) {
      pm = null;
    }
    const pmw = pm ? getMW(pm, K_PART) : null;
    if (!pmw || !pmw.lv[0]) continue;
    const s = alloc(SET_MAIN);
    const pr = { slot: s, def, mw: pmw, parent: rec, phase: M.hash(rec.b.id, s, 3) * TAU, speed: +def.speed || 0 };
    setModel(s, pmw);
    rec.parts.push(pr);
    parts.push(pr);
    writePart(pr);
  }
  B.stats.parts = parts.length;
}
function freeParts(rec) {
  if (!rec.parts) return;
  for (const pr of rec.parts) {
    release(pr.slot);
    pr.dead = true;
  }
  rec.parts = null;
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i].dead) parts.splice(i, 1);
  B.stats.parts = parts.length;
}
const _R = new Float64Array(9), _A = new Float64Array(9);
/** World matrix of a part: parent * T(pivot) * Rot(axis, phase) * S(ratio) * T(-partPivot). */
function writePart(pr) {
  const rec = pr.parent, mw = rec.mw, pmw = pr.mw, def = pr.def;
  const ps = rec.slot * SLOT_F, o = pr.slot * SLOT_F;
  const px = D[ps], py = D[ps + 1], pz = D[ps + 2], yaw = D[ps + 3];
  const sc = mw.vox * D[ps + 4];
  const ratio = pmw.vox / mw.vox;
  const ca = Math.cos(pr.phase), sa = Math.sin(pr.phase);
  const R = _R, A = _A;
  const ax = def.axis || 'y';
  if (ax === 'x') { R[0] = 1; R[1] = 0; R[2] = 0; R[3] = 0; R[4] = ca; R[5] = -sa; R[6] = 0; R[7] = sa; R[8] = ca; }
  else if (ax === 'z') { R[0] = ca; R[1] = -sa; R[2] = 0; R[3] = sa; R[4] = ca; R[5] = 0; R[6] = 0; R[7] = 0; R[8] = 1; }
  else { R[0] = ca; R[1] = 0; R[2] = sa; R[3] = 0; R[4] = 1; R[5] = 0; R[6] = -sa; R[7] = 0; R[8] = ca; }
  // Ry(yaw) rows: [c 0 s; 0 1 0; -s 0 c] (x' = x c + z s, z' = -x s + z c)
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const k = rec.reveal < 0.999 ? 0 : sc * ratio; // hidden until the parent is complete
  for (let j = 0; j < 3; j++) {
    A[j] = (c * R[j] + s * R[6 + j]) * k;
    A[3 + j] = R[3 + j] * k;
    A[6 + j] = (-s * R[j] + c * R[6 + j]) * k;
  }
  const pv = def.pivot || [0, 0, 0], pp = def.partPivot || [0, 0, 0];
  const lx = (pv[0] - mw.cx) * sc, ly = pv[1] * sc, lz = (pv[2] - mw.cz) * sc;
  const tx = px + lx * c + lz * s, ty = py + ly, tz = pz - lx * s + lz * c;
  for (let r = 0; r < 3; r++) {
    const a0 = A[r * 3], a1 = A[r * 3 + 1], a2 = A[r * 3 + 2];
    D[o + r * 4] = a0; D[o + r * 4 + 1] = a1; D[o + r * 4 + 2] = a2;
    D[o + r * 4 + 3] = (r === 0 ? tx : r === 1 ? ty : tz) - (a0 * pp[0] + a1 * pp[1] + a2 * pp[2]);
  }
  D[o + 12] = D[ps + 5]; D[o + 13] = rec.reveal; D[o + 14] = rec.flags; D[o + 15] = rec.b.id;
  markDirty(pr.slot);
  const pr2 = pmw.radius / Math.max(ratio, 1e-3) + mw.radius + 0.5;
  place(pr.slot, px, pz, pr2, py - 0.5, py + mw.height + pmw.height * ratio + 1);
}
function updateParts(rdt) {
  if (!parts.length) return;
  const env = VC.gfx.env || {};
  const wind = env.windStrength == null ? 0.5 : env.windStrength;
  const frame = VC.gfx.frameCount | 0;
  for (const pr of parts) {
    const rec = pr.parent;
    if (rec.slot <= 0) continue;
    const f = rec.flags;
    let k = pr.def.anim === 'wind' ? 0.15 + 1.7 * wind : 1;
    if ((f & (FL.ABANDONED | FL.FIRE)) || ((f & FL.UNPOWERED) && pr.def.anim !== 'wind')) k = 0;
    pr.phase = (pr.phase + rdt * pr.speed * k) % (TAU * 64);
    // only animate parts whose cell the camera saw recently (others keep their last pose)
    const c = sCell[rec.slot];
    if (c >= 0 && frame - cellSeen[c] > 3 && pr.written) continue;
    pr.written = true;
    writePart(pr);
    // lights on animated parts (ferris wheel gondolas...) are dynamic sprites
    const L = pr.mw.lights;
    if (L && rec.reveal >= 1 && !(f & FL.ABANDONED) && c >= 0 && frame - cellSeen[c] <= 3) {
      const o = pr.slot * SLOT_F;
      const night = env.night || 0;
      for (const l of L) {
        if (!l.always && ((f & FL.UNPOWERED) || night < 0.05)) continue;
        const x = D[o] * l.x + D[o + 1] * l.y + D[o + 2] * l.z + D[o + 3];
        const y = D[o + 4] * l.x + D[o + 5] * l.y + D[o + 6] * l.z + D[o + 7];
        const z = D[o + 8] * l.x + D[o + 9] * l.y + D[o + 10] * l.z + D[o + 11];
        const col = l.color || [1, 0.85, 0.6];
        dynSprite(x, y, z, (l.size || 1) * 0.28, col[0], col[1], col[2], l.always ? 1 : 0);
      }
    }
  }
}

/* ================================================================== */
/* Trees                                                               */
/* ================================================================== */
const TREE_POS = [
  [[0.5, 0.5]],
  [[0.3, 0.32], [0.7, 0.68]],
  [[0.27, 0.3], [0.73, 0.38], [0.47, 0.75]],
];
function treeSigOf(S, i) {
  const n = S.trees[i];
  // roads, buildings, water and power-line corridors (cleared right of way) show no trees
  if (!n || S.road[i] || S.bld[i] || S.pline[i] || S.height[i] < C.SEA) return 0;
  return 1 + (Math.min(3, n) | (S.height[i] << 2) | (S.terr[i] << 8));
}
function nearWater(S, x, z, r) {
  for (let dz = -r; dz <= r; dz++)
    for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, zz = z + dz;
      if (xx < 0 || zz < 0 || xx >= S.W || zz >= S.H) continue;
      if (S.height[zz * S.W + xx] < C.SEA) return true;
    }
  return false;
}
/** Species index for tree k on tile (x, z): palms on beaches, conifers up high, clustered forests. */
function pickSpecies(S, x, z, k, h) {
  const i = z * S.W + x;
  const has = treeKinds;
  const lvl = S.height[i];
  const terr = S.terr[i];
  const T = VC.TERR || {};
  const r = (h >>> 8) % 1000 / 1000;
  const want = (sp) => (has[sp] ? sp : -1);
  if (want(5) >= 0 && r < 0.8 && (terr === T.SAND || ((S.mapType === 'coast' || S.mapType === 'islands') && lvl <= C.SEA + 3 && r < 0.65)) && nearWater(S, x, z, 2)) return 5;
  const mtn = S.mapType === 'mountains';
  if ((lvl >= 26 || terr === T.SNOW || terr === T.ROCK) && r < 0.92) return want(r < 0.7 ? 3 : 4) >= 0 ? (r < 0.7 ? 3 : 4) : firstOf([3, 4, 0]);
  if ((lvl >= 19 || mtn) && r < (mtn ? 0.65 : 0.5)) return want(3) >= 0 ? 3 : firstOf([4, 0]);
  // forest patches: a dominant species per 6x6 region, mixed with a few others
  const rh = M.hashU(Math.floor(x / 6), Math.floor(z / 6), S.seed | 0);
  const DOM = [0, 1, 2, 0, 1, 6, 3, 2, 0, 4];
  let sp = DOM[rh % DOM.length];
  if (r > 0.62) {
    const MIX = [0, 1, 2, 7, 7, 6, 0, 1, 4, 3, 7, 2];
    sp = MIX[(h >>> 4) % MIX.length];
  }
  if (terr === T.SAND && r < 0.5) sp = 7;
  if (!has[sp]) sp = firstOf([sp === 6 ? 1 : 0, 0, 1, 2, 7, 3]);
  return sp;
}
function firstOf(list) {
  for (const sp of list) if (treeKinds[sp]) return sp;
  for (let sp = 0; sp < SPECIES.length; sp++) if (treeKinds[sp]) return sp;
  return -1;
}
function clearTreeTile(i) {
  for (let k = 0; k < 3; k++) {
    const s = treeSlot[i * 3 + k];
    if (s > 0) {
      release(s);
      B.stats.trees--;
    }
    treeSlot[i * 3 + k] = -1;
  }
}
function buildTreeTile(S, i, popT) {
  const sig = treeSigOf(S, i);
  treeSig[i] = sig;
  if (!sig) return;
  const n = Math.min(3, S.trees[i]);
  const x = i % S.W, z = (i / S.W) | 0;
  const y = S.height[i] * C.STEP;
  const pat = TREE_POS[n - 1];
  const hm = M.hashU(x, z, 7777);
  const flipX = hm & 1, flipZ = hm & 2, swap = hm & 4;
  for (let k = 0; k < n; k++) {
    const h = M.hashU(x, z, 1013 + k * 97);
    const sp = pickSpecies(S, x, z, k, h);
    if (sp < 0) return;
    const def = VC.models.defs[SPECIES[sp]];
    const nv = (def && def.variants) || 1;
    let m = null;
    try {
      m = VC.models.get(SPECIES[sp], (h >>> 3) % nv);
    } catch (e) {
      m = null;
    }
    const mw = m ? getMW(m, K_TREE) : null;
    if (!mw || !mw.lv[0]) continue;
    let px = pat[k][0], pz = pat[k][1];
    if (swap) { const t = px; px = pz; pz = t; }
    if (flipX) px = 1 - px;
    if (flipZ) pz = 1 - pz;
    px += (((h >>> 12) & 15) / 15 - 0.5) * 0.14;
    pz += (((h >>> 16) & 15) / 15 - 0.5) * 0.14;
    const base = n === 1 ? 0.9 : n === 2 ? 0.8 : 0.72;
    const scale = base * (0.85 + ((h >>> 20) & 63) / 63 * 0.33) * (sp === 7 ? 1.1 : 1);
    const s = alloc(SET_MAIN);
    const o = s * SLOT_F;
    D[o] = x + px; D[o + 1] = y; D[o + 2] = z + pz; D[o + 3] = ((h >>> 24) / 256) * TAU;
    D[o + 4] = scale; D[o + 5] = ((h >>> 5) % 997) / 997; D[o + 6] = 1; D[o + 7] = 0;
    D[o + 8] = 0; D[o + 9] = 0; D[o + 10] = popT; D[o + 11] = sp;
    setModel(s, mw);
    D[o + 12] = mw.cx; D[o + 13] = mw.cz; D[o + 14] = mw.vox; D[o + 15] = mw.h;
    markDirty(s);
    place(s, x + px, z + pz, mw.radius * scale + 0.25, y - 0.2, y + mw.height * scale * 1.2 + 0.2);
    treeSlot[i * 3 + k] = s;
    B.stats.trees++;
  }
}
function rebuildTreesRect(S, x0, z0, x1, z1, popT) {
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const i = z * S.W + x;
      const sig = treeSigOf(S, i);
      if (sig === treeSig[i]) continue;
      clearTreeTile(i);
      buildTreeTile(S, i, popT);
    }
}

/* ================================================================== */
/* Events                                                              */
/* ================================================================== */
function onDirty(r) {
  const S = curS;
  const x0 = Math.max(0, r.x0 | 0), z0 = Math.max(0, r.z0 | 0), x1 = Math.min(S.W - 1, r.x1 | 0), z1 = Math.min(S.H - 1, r.z1 | 0);
  if (x1 < x0 || z1 < z0) return;
  rebuildTreesRect(S, x0, z0, x1, z1, nowT());
  // buildings whose ground moved
  const stamp = (onDirty._stamp = (onDirty._stamp || 0) + 1);
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const id = S.bld[z * S.W + x];
      if (!id) continue;
      const rec = recs.get(id);
      if (!rec || rec.stamp === stamp || rec.slot <= 0) continue;
      rec.stamp = stamp;
      const b = rec.b;
      if (Math.abs(VC.world.topY(b.x, b.z) - rec.y) > 1e-4) refreshRec(rec, true);
    }
}

function resetAll(S) {
  curS = S;
  // free every slot (keep capacity + GL objects + model wrappers)
  if (!cap) growCap(8192);
  nFree = 0;
  for (let s = cap - 1; s >= 1; s--) freeStack[nFree++] = s;
  sModel.fill(-1);
  sSet.fill(255);
  sCell.fill(-1);
  sLit.fill(0);
  nLit = 0;
  texRealloc = true;
  initCells(S);
  for (const r of recs.values()) r.removed = true; // stale references (round-robin list, queues) become inert
  recs.clear();
  recsVer++;
  rrList.length = 0;
  liveSet.clear();
  pendQ.length = 0;
  parts.length = 0;
  ghost = null;
  flagsAll = true;
  spritesDirty = true;
  B.stats.buildings = B.stats.trees = B.stats.parts = 0;
  hasSite = VC.models.has('construction');
  seenTreeVer = S.ver.trees;
  treeScan = false;
  treeKinds = SPECIES.map((k) => VC.models.has(k));
  treeSlot = new Int32Array(S.N * 3).fill(-1);
  treeSig = new Uint16Array(S.N);
  for (let i = 0; i < S.N; i++) buildTreeTile(S, i, NO_POP);
  // buildings: build models synchronously up to a budget; the rest streams in over the next frames
  const t0 = performance.now();
  for (const b of S.buildings.values()) {
    const rec = { b, slot: -1, mw: null, site: false, parts: null, reveal: 1, q: -1, fire: 0, flags: 0, popT: NO_POP, lift: 0, pending: false, y: 0 };
    recs.set(b.id, rec);
    resolveRec(rec, performance.now() - t0 < 350);
  }
  B.stats.buildings = recs.size;
}

/* ================================================================== */
/* Per-frame                                                           */
/* ================================================================== */
function frameUpdate(S, rdt) {
  quality = VC.gfx.quality();
  // model queue: spend more when the backlog is big (e.g. right after a big city appeared)
  if (pendQ.length) processPending(Math.min(40, 5 + pendQ.length * 0.4));
  // lazy 1/4-res LOD meshes
  if (l2Queue.length) {
    const t0 = performance.now();
    while (l2Queue.length && performance.now() - t0 < 3) buildL2(l2Queue.shift());
  }
  // safety net: tree counts changed without a 'dirty' rect -> rescan signatures
  if (S.ver.trees !== seenTreeVer) {
    seenTreeVer = S.ver.trees;
    treeScan = true;
  } else if (treeScan) {
    treeScan = false;
    rebuildTreesRect(S, 0, 0, S.W - 1, S.H - 1, nowT());
  }
  if (!pendQ.length && !l2Queue.length) prewarm();
  refreshFlags();
  updateLive();
  updateParts(rdt);
  // static sprites: rebuilt when something lit changed (throttled)
  spriteT -= rdt;
  if (spritesDirty && spriteT <= 0) {
    rebuildSprites();
    spriteT = 0.25;
  }
  // shader uniforms that depend on the clock / tools / disasters
  const env = VC.gfx.env || {};
  const tod = env.tod == null ? S.time.tod : env.tod;
  scheduleAt(tod * 24, U.sched, S);
  const T = VC.tools;
  U.bg[0] = tod;
  U.bg[1] = (T && T.selectedId) || 0;
  let hov = 0;
  if (T) {
    if (T.hoverId) hov = T.hoverId;
    else if (T.hover && VC.world.inb(T.hover.x, T.hover.z)) {
      const b = VC.world.buildingAt(T.hover.x, T.hover.z);
      hov = b ? b.id : 0;
    }
  }
  const tool = T && T.current;
  U.bg[2] = tool === 'select' || tool === 'bulldoze' || !tool ? hov : 0;
  U.bg[3] = tool === 'bulldoze' ? 1 : 0;
  U.quake[3] = 0;
  const A = VC.disasters && VC.disasters.active;
  if (A) for (const e of A) if (e && e.type === 'earthquake' && e.shake > 0) { U.quake[0] = e.x; U.quake[1] = e.z; U.quake[2] = Math.max(8, e.radius || 20); U.quake[3] = e.shake; }
  // ghost slot 0
  if (ghost) writeGhost();
  B.stats.slots = cap - nFree;
}
/* Fraction of lit windows per zone type through the day (hour -> fraction). */
const SCHED = [
  // homes
  [[0, 0.36], [1.5, 0.24], [4, 0.1], [5.5, 0.16], [7, 0.45], [8.5, 0.22], [12, 0.12], [16.5, 0.2], [18.5, 0.52], [20.5, 0.64], [22.5, 0.52], [24, 0.36]],
  // offices
  [[0, 0.07], [5.5, 0.07], [7.5, 0.45], [9, 0.85], [17, 0.85], [18.5, 0.62], [20, 0.32], [22, 0.12], [24, 0.07]],
  // shops
  [[0, 0.05], [7, 0.1], [9, 0.9], [20, 0.9], [21.5, 0.35], [23, 0.08], [24, 0.05]],
  // industry (shifts)
  [[0, 0.45], [6, 0.5], [8, 0.72], [18, 0.72], [20, 0.52], [24, 0.45]],
];
function schedOf(tab, hr) {
  let i = 0;
  while (i < tab.length - 2 && hr > tab[i + 1][0]) i++;
  const a = tab[i], b = tab[i + 1];
  return a[1] + (b[1] - a[1]) * M.smoothstep(a[0], b[0], hr);
}
function scheduleAt(hr, out4, S) {
  for (let k = 0; k < 4; k++) out4[k] = schedOf(SCHED[k], hr);
  if (S && S.policies && S.policies.nightlife) out4[2] = Math.max(out4[2], 0.6);
}

/* ================================================================== */
/* Gather + draw                                                       */
/* ================================================================== */
function ensureBuckets() {
  const n = MWS.length * 3;
  if (bCnt.length >= n) return;
  let len = Math.max(256, bCnt.length);
  while (len < n) len *= 2;
  bCnt = new Int32Array(len);
  bCur = new Int32Array(len);
  bStart = new Int32Array(len);
  used = new Int32Array(len);
  bMin = new Float32Array(len);
  sortKeys = new Float64Array(len);
}
/** Frustum planes for the pass (core's ctx.frustum, else extracted from the pass matrix). */
function passPlanes(ctx, shadow) {
  if (ctx.frustum && ctx.frustum.length === 24) return ctx.frustum;
  const m = ctx.viewProj || (!shadow && ctx.cam ? ctx.cam.viewProj : null);
  if (!m) return null;
  for (let p = 0; p < 6; p++) {
    const r = p >> 1, sg = p & 1 ? -1 : 1;
    const a = m[3] + sg * m[r], b = m[7] + sg * m[4 + r], c = m[11] + sg * m[8 + r], d = m[15] + sg * m[12 + r];
    const l = Math.hypot(a, b, c) || 1;
    planesTmp[p * 4] = a / l; planesTmp[p * 4 + 1] = b / l; planesTmp[p * 4 + 2] = c / l; planesTmp[p * 4 + 3] = d / l;
  }
  return planesTmp;
}
function boxVisible(pl, x0, y0, z0, x1, y1, z1) {
  for (let p = 0; p < 24; p += 4) {
    const a = pl[p], b = pl[p + 1], c = pl[p + 2];
    if (a * (a > 0 ? x1 : x0) + b * (b > 0 ? y1 : y0) + c * (c > 0 ? z1 : z0) + pl[p + 3] < 0) return false;
  }
  return true;
}
/* LOD tier thresholds per kind in units of lodDist: [full -> lod, lod -> 1/4]. */
const TIER_F = [[1.0, 2.6], [0.42, 1.15], [0.35, 0.8], [0.9, 2.2]];
/**
 * Collects the visible slots of a set into (model, tier) buckets. mode: 0 camera, 1 shadow near, 2 shadow far.
 * Returns the number of visible instances; buckets are in used[0..nUsed), slot lists in out[].
 */
function gather(set, planes, mode) {
  ensureBuckets();
  nUsed = 0;
  // software rasterizers (headless tests): switch to the coarser meshes sooner
  const lod = (quality ? quality.lodDist : 90) * (VC.gfx.caps && VC.gfx.caps.software ? 0.55 : 1);
  const L2 = lod * lod;
  // trees are skipped well beyond the draw distance (fog has swallowed them there)
  const dd = (quality ? quality.drawDist : 300) * (mode === 0 ? 1.7 : mode === 1 ? 0.8 : 1.1);
  const treeCap = dd * dd;
  const T0 = gather._t0 || (gather._t0 = new Float32Array(NK)), T1 = gather._t1 || (gather._t1 = new Float32Array(NK));
  for (let k = 0; k < NK; k++) {
    T0[k] = TIER_F[k][0] * TIER_F[k][0] * L2;
    T1[k] = TIER_F[k][1] * TIER_F[k][1] * L2;
  }
  const minTier = mode === 0 ? 0 : mode === 1 ? 1 : 2;
  const skip = mwSkip[mode];
  const cam = VC.camera.pos;
  const px = cam[0], py = cam[1], pz = cam[2];
  const lists = cellL[set], ns = cellN[set], cb = cellB[set];
  const frame = VC.gfx.frameCount | 0;
  let k = 0;
  for (let c = 0; c < nCells; c++) {
    const n = ns[c];
    if (!n) continue;
    const o6 = c * 6;
    if (planes && !boxVisible(planes, cb[o6], cb[o6 + 4], cb[o6 + 1], cb[o6 + 2], cb[o6 + 5], cb[o6 + 3])) continue;
    if (mode === 0) cellSeen[c] = frame;
    const L = lists[c];
    for (let j = 0; j < n; j++) {
      const s = L[j];
      const mi = sModel[s];
      if (mi < 0) continue;
      const kd = mwKind[mi];
      const o = s << 4;
      let dx, dy, dz;
      if (kd === K_PART) { dx = D[o + 3] - px; dy = D[o + 7] - py; dz = D[o + 11] - pz; }
      else { dx = D[o] - px; dy = D[o + 1] - py; dz = D[o + 2] - pz; }
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > skip[mi] * L2 || (kd === K_TREE && d2 > treeCap)) continue;
      let tier = d2 < T0[kd] ? 0 : d2 < T1[kd] ? 1 : 2;
      if (tier < minTier) tier = minTier;
      if (tier === 2 && !mwHasL2[mi]) {
        if (mwL2State[mi] === 0) { mwL2State[mi] = 1; l2Queue.push(mi); }
        tier = 1;
      }
      const bk = mi * 3 + tier;
      if (bCnt[bk]++ === 0) { used[nUsed++] = bk; bMin[bk] = d2; }
      else if (d2 < bMin[bk]) bMin[bk] = d2;
      tmpB[k] = bk;
      tmpS[k] = s;
      k++;
    }
  }
  let off = 0;
  for (let u = 0; u < nUsed; u++) {
    const bk = used[u];
    bStart[bk] = off;
    bCur[bk] = off;
    off += bCnt[bk];
  }
  for (let j = 0; j < k; j++) out[bCur[tmpB[j]]++] = tmpS[j];
  // camera pass: nearest buckets first (early-Z rejects the overdraw of towers behind towers)
  if (mode === 0 && nUsed > 1) {
    for (let u = 0; u < nUsed; u++) sortKeys[u] = Math.floor(Math.sqrt(bMin[used[u]]) * 16) * 65536 + u;
    const keys = sortKeys.subarray(0, nUsed);
    keys.sort();
    const tmp = gather._tmp && gather._tmp.length >= nUsed ? gather._tmp : (gather._tmp = new Int32Array(Math.max(256, nUsed * 2)));
    for (let u = 0; u < nUsed; u++) tmp[u] = used[keys[u] % 65536];
    used.set(tmp.subarray(0, nUsed));
  }
  return k;
}
function uploadStream(data, n) {
  gl.bindBuffer(gl.ARRAY_BUFFER, streamBuf);
  const bytes = n * 4;
  if (bytes > streamCap || streamCap > bytes * 8) {
    streamCap = Math.max(4096, bytes * 2);
    gl.bufferData(gl.ARRAY_BUFFER, streamCap, gl.STREAM_DRAW);
  } else gl.bufferData(gl.ARRAY_BUFFER, streamCap, gl.STREAM_DRAW); // orphan: no stall on in-flight draws
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n);
}
function bindCommon(p) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, VC.voxel.paletteTexture());
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, dataTex);
  gl.activeTexture(gl.TEXTURE0);
  const u = p.u;
  if (u.uSched) gl.uniform4f(u.uSched, U.sched[0], U.sched[1], U.sched[2], U.sched[3]);
  if (u.uBG) gl.uniform4f(u.uBG, U.bg[0], U.bg[1], U.bg[2], U.bg[3]);
  if (u.uQuake) gl.uniform4f(u.uQuake, U.quake[0], U.quake[1], U.quake[2], U.quake[3]);
}
/** True while deciduous crowns may be (partly) bare: autumn's end .. early spring (+-0.15 per-tree offset). */
function bareSeason() {
  const s = (VC.gfx.env && VC.gfx.env.season) || 0;
  return s > 2.45 && s < 3.99;
}
/** Instanced draw of one bucket (model LOD level lv with `count` slot indices starting at `start`). */
function drawBucket(lv, start, count) {
  gl.bindVertexArray(lv.vao);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribDivisor(2, 1);
  gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 4, start * 4);
  gl.drawElementsInstanced(gl.TRIANGLES, lv.quads * 6, gl.UNSIGNED_INT, 0, count);
}
/** Gathers and draws a set for the current pass. Returns the number of instances drawn. */
function drawSet(ctx, set, shadow) {
  if (!curS || curS !== ctx.S || !PROGS[0][0]) return 0;
  if (texRealloc || nDirty || dirtyAll) flushTex();
  if (!dataTex) return 0;
  const t0 = performance.now();
  if (!quality) quality = VC.gfx.quality();
  const mode = shadow ? (ctx.cascade > 0 ? 2 : 1) : 0;
  const planes = passPlanes(ctx, shadow);
  const n = gather(set, planes, mode);
  if (!n) return 0;
  uploadStream(out, n);
  let draws = 0, verts = 0, curTier = -1;
  for (let kind = 0; kind < NK; kind++) {
    let prog = null;
    for (let u = 0; u < nUsed; u++) {
      const bk = used[u];
      const mi = (bk / 3) | 0;
      if (mwKind[mi] !== kind) continue;
      const lv = MWS[mi].lv[bk - mi * 3];
      if (!lv || !lv.quads) continue;
      if (!prog) {
        prog = PROGS[kind][(shadow ? 1 : 0) + (kind === K_TREE && bareSeason() ? 2 : 0)];
        prog.use();
        bindCommon(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, streamBuf);
        curTier = -1;
      }
      const tier = bk - mi * 3;
      if (tier !== curTier && prog.u.uFar) {
        curTier = tier;
        gl.uniform1f(prog.u.uFar, tier);
      }
      drawBucket(lv, bStart[bk], bCnt[bk]);
      draws++;
      verts += lv.quads * 4 * bCnt[bk];
    }
  }
  for (let u = 0; u < nUsed; u++) bCnt[used[u]] = 0;
  gl.bindVertexArray(null);
  if (mode === 0) {
    const st = B.stats;
    if (set === SET_MAIN) { st.visible = n; st.draws = draws; st.verts = verts; st.gatherMs = +(performance.now() - t0).toFixed(3); }
    else { st.propVisible = n; st.propDraws = draws; st.propVerts = verts; }
  }
  return n;
}

/* ---------------- ghost ---------------- */
function writeGhost() {
  const g = ghost, mw = g.mw, S = curS;
  if (!mw || !S) return;
  const o = 0;
  const x = M.clamp(g.x, 0, S.W - 1), z = M.clamp(g.z, 0, S.H - 1);
  D[o] = g.x + g.w / 2; D[o + 1] = VC.world.topY(x, z) + 0.01; D[o + 2] = g.z + g.d / 2; D[o + 3] = g.rot * Math.PI * 0.5;
  D[o + 4] = 1; D[o + 5] = 0.5; D[o + 6] = 1; D[o + 7] = g.valid ? 0 : FL.GHOST_BAD;
  D[o + 8] = 0; D[o + 9] = 0; D[o + 10] = NO_POP; D[o + 11] = 0;
  D[o + 12] = mw.cx; D[o + 13] = mw.cz; D[o + 14] = mw.vox; D[o + 15] = mw.h;
  markDirty(0);
}
const ONE_SLOT = new Uint32Array(1);
function drawGhost(ctx) {
  if (!ghost || !ghost.mw || !ghostProg) return;
  if (texRealloc || nDirty || dirtyAll) flushTex();
  if (!dataTex) return;
  const lv = ghost.mw.lv[0];
  if (!lv) return;
  ONE_SLOT[0] = 0;
  uploadStream(ONE_SLOT, 1);
  ghostProg.use();
  bindCommon(ghostProg);
  const u = ghostProg.u;
  if (u.uGhost) gl.uniform4f(u.uGhost, ghost.valid ? 0.25 : 1.0, ghost.valid ? 1.0 : 0.22, ghost.valid ? 0.5 : 0.16, ghost.valid ? 1 : 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, streamBuf);
  // depth prepass so only the front-most hologram surface blends
  gl.colorMask(false, false, false, false);
  gl.depthMask(true);
  gl.depthFunc(gl.LESS);
  drawBucket(lv, 0, 1);
  gl.colorMask(true, true, true, true);
  gl.depthMask(false);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
  drawBucket(lv, 0, 1);
  gl.bindVertexArray(null);
}

/* ================================================================== */
/* Glow sprites                                                        */
/* ================================================================== */
function pushSprite(arr, n, x, y, z, size, r, g, b, mode) {
  const o = n * 8;
  arr[o] = x; arr[o + 1] = y; arr[o + 2] = z; arr[o + 3] = size;
  arr[o + 4] = r; arr[o + 5] = g; arr[o + 6] = b; arr[o + 7] = mode;
}
/** Adds a sprite for this frame only (props / animated parts). mode bits: 1 always, 2 blink, 4 ground pool, 16 flicker. */
function dynSprite(x, y, z, size, r, g, b, mode) {
  if ((nDyn + 1) * 8 > dynData.length) {
    const nd = new Float32Array(dynData.length * 2);
    nd.set(dynData);
    dynData = nd;
  }
  pushSprite(dynData, nDyn++, x, y, z, size, r, g, b, mode);
}
function rebuildSprites() {
  spritesDirty = false;
  const pools = !(VC.terrain && VC.terrain.lampSpots);
  let n = 0;
  for (let i = 0; i < nLit; i++) {
    const s = litList[i];
    const mi = sModel[s];
    if (mi < 0) continue;
    const mw = MWS[mi];
    const L = mw.lights;
    if (!L || mw.noStaticLights || mwKind[mi] === K_PART) continue;
    const o = s * SLOT_F;
    const fl = D[o + 7];
    if (D[o + 6] < 0.999 || (fl & FL.ABANDONED) || (fl & FL.SITE)) continue;
    const off = (fl & (FL.UNPOWERED | FL.FIRE)) !== 0;
    const x = D[o], y = D[o + 1], z = D[o + 2], yaw = D[o + 3];
    const sc = D[o + 4] * D[o + 14], cx = D[o + 12], cz = D[o + 13];
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    for (const l of L) {
      if (off && !l.always) continue;
      if ((n + 2) * 8 > sprData.length) {
        const nd = new Float32Array(sprData.length * 2);
        nd.set(sprData);
        sprData = nd;
      }
      const lx = (l.x - cx) * sc, ly = l.y * sc, lz = (l.z - cz) * sc;
      const wx = x + lx * c + lz * sn, wy = y + ly, wz = z - lx * sn + lz * c;
      const col = l.color || [1, 0.85, 0.6];
      let mode = l.always ? 1 : 0;
      if (l.always && col[0] > 0.7 && col[1] < 0.4 && col[2] < 0.4) mode |= 2; // aviation beacon
      pushSprite(sprData, n++, wx, wy, wz, (l.size || 1) * 0.17, col[0], col[1], col[2], mode);
      if (pools && mw.pool) pushSprite(sprData, n++, wx, y + 0.02, wz, 0.75, col[0], col[1] * 0.9, col[2] * 0.75, 4);
    }
  }
  nSpr = n;
  gl.bindBuffer(gl.ARRAY_BUFFER, sprBuf);
  gl.bufferData(gl.ARRAY_BUFFER, sprData.subarray(0, Math.max(8, n * 8)), gl.DYNAMIC_DRAW);
  B.stats.sprites = n;
}
function drawSprites(ctx) {
  if (!sprProg || (!nSpr && !nDyn)) return;
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
  gl.depthMask(false);
  gl.disable(gl.CULL_FACE);
  sprProg.use();
  if (nSpr) {
    gl.bindVertexArray(sprVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nSpr);
  }
  if (nDyn) {
    gl.bindVertexArray(dynVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, dynBuf);
    gl.bufferData(gl.ARRAY_BUFFER, dynData.subarray(0, nDyn * 8), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nDyn);
  }
  B.stats.dynSprites = nDyn;
  gl.bindVertexArray(null);
}

/* ================================================================== */
/* GL setup                                                            */
/* ================================================================== */
function initGL() {
  const G = VC.gfx;
  // the lighting library of the render core darkens + reflects wet top faces inside shade() already
  const lib = (VC.shaderlib && VC.shaderlib.lighting) || '';
  const libWet = /wetTop/.test(lib) ? '#define BG_LIBWET 1\n' : '';
  for (let k = 0; k < NK; k++) {
    const def = `#define KIND ${k}\n` + libWet;
    PROGS[k][0] = G.program('bld_k' + k, VS, k === K_TREE ? FS_TREE : FS_BLD, { defines: def });
    PROGS[k][1] = G.program('bld_k' + k + '_sh', VS, 'void main(){}', { defines: def + '#define SHADOW\n' });
  }
  // trees: winter variants with the bare-crown discard (kept out of the others: discard disables early-Z)
  PROGS[K_TREE][2] = G.program('bld_k1_bare', VS, FS_TREE, { defines: '#define KIND 1\n#define BARE\n' + libWet });
  PROGS[K_TREE][3] = G.program('bld_k1_sh_bare', VS, FS_TREE_SHADOW, { defines: '#define KIND 1\n#define SHADOW\n#define BARE\n' });
  ghostProg = G.program('bld_ghost', VS, FS_GHOST, { defines: '#define KIND 0\n#define GHOST\n' });
  for (const p of [...PROGS[0], ...PROGS[1], ...PROGS[2], ...PROGS[3], ghostProg]) {
    if (!p) continue;
    p.use();
    if (p.u.uPal) gl.uniform1i(p.u.uPal, 0);
    if (p.u.uInst) gl.uniform1i(p.u.uInst, 1);
    if (p.u.uWinPal) gl.uniform4i(p.u.uWinPal, VC.P.WIN_OFFICE | 0, VC.P.WIN_SHOP | 0, VC.P.WIN_COOL | 0, 0);
  }
  streamBuf = gl.createBuffer();
  // sprites
  sprProg = G.program('bld_sprites', VS_SPR, FS_SPR);
  // per-vertex quad corners (divisor 0) + per-instance sprite data (divisor 1)
  const cornerBuf = G.buffer(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
  const mk = (buf) => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, 64, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    return vao;
  };
  sprBuf = gl.createBuffer();
  sprVao = mk(sprBuf);
  dynBuf = gl.createBuffer();
  dynVao = mk(dynBuf);
}

/* ================================================================== */
/* Shaders                                                             */
/* ================================================================== */
const VS = `
layout(location=0) in vec3 aPos;
layout(location=1) in uvec2 aInfo;
layout(location=2) in uint aSlot;
uniform highp sampler2D uInst;
uniform highp sampler2D uPal;
uniform vec4 uQuake;
out vec3 vWp;
out vec3 vVox;
out float vAo;
flat out uint vPal;
flat out uint vMat;
flat out vec3 vN;
flat out vec3 vNl;
flat out vec4 vA;
flat out vec4 vB;
const vec3 BG_NRM[6] = vec3[6](vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1));
vec4 bgFetch(int t){ return texelFetch(uInst, ivec2(t & 1023, t >> 10), 0); }
void main(){
  int base = int(aSlot) * 4;
  vec4 t0 = bgFetch(base), t1 = bgFetch(base + 1), t2 = bgFetch(base + 2), t3 = bgFetch(base + 3);
  vec3 nl = BG_NRM[aInfo.y & 7u];
  uint mat = uint(texelFetch(uPal, ivec2(int(aInfo.x), 0), 0).a * 255.0 + 0.5);
  vec3 v = aPos;
  vec3 wp, n;
#if KIND == 3
  vec4 hp = vec4(v, 1.0);
  wp = vec3(dot(t0, hp), dot(t1, hp), dot(t2, hp));
  n = normalize(vec3(dot(t0.xyz, nl), dot(t1.xyz, nl), dot(t2.xyz, nl)) + 1e-6);
  vA = t3;
  vB = vec4(0.0, 64.0, 1.0e5, 0.0);
#else
  float ws = t3.z * t1.x;
  // construction: every vertex above the cut drops onto the cut plane -> the shell stays closed
  float cut = t1.z < 0.999 ? floor(t1.z * t3.w + 0.5) : 1.0e5;
  v.y = min(v.y, cut);
  vec3 p = vec3(v.x - t3.x, v.y, v.z - t3.y) * ws;
  float pt = TIME - t2.z;
  if (pt < 0.0) pt += 3600.0;
#if KIND == 1
  float gr = smoothstep(0.0, 1.4, pt);
  p *= max(0.02, gr + sin(pt * 9.0) * exp(-pt * 3.5) * 0.18 * gr);
#else
  if (pt < 1.3) { float bn = sin(pt * 13.0) * exp(-pt * 4.2); p.y *= 1.0 + bn * 0.14; p.xz *= 1.0 - bn * 0.06; }
#endif
  float c = cos(t0.w), sn = sin(t0.w);
  wp = vec3(t0.x + p.x * c + p.z * sn, t0.y + p.y, t0.z - p.x * sn + p.z * c);
  n = vec3(nl.x * c + nl.z * sn, nl.y, -nl.x * sn + nl.z * c);
#if KIND == 1
  // wind: the whole tree bends (quadratic in height), gusts travel with the wind, leaves flutter
  float th = max(t3.w * ws, 0.05);
  float hn = clamp(p.y / th, 0.0, 1.2);
  float wstr = uWind.z;
  float gust = tnoise(t0.xz * 0.013 - uWind.xy * TIME * 0.035).r;
  float bend = (sin(TIME * 1.3 + t1.y * 40.0) * 0.3 + (gust - 0.4) * 1.8 * wstr) * (0.2 + wstr) * hn * hn * th * 0.06;
  wp.xz += uWind.xy * bend;
  if ((mat & 8u) != 0u) wp += vec3(sin(TIME * 5.3 + aPos.y * 0.9 + t1.y * 17.0), sin(TIME * 6.1 + aPos.x * 1.3) * 0.5, cos(TIME * 4.7 + aPos.z * 1.1)) * (0.003 + 0.01 * wstr) * hn * t1.x;
#elif KIND == 0
  if (uQuake.w > 0.0) {
    float qd = length(wp.xz - uQuake.xy);
    float qa = uQuake.w * (1.0 - smoothstep(uQuake.z * 0.4, uQuake.z, qd)) * min(p.y, 4.0) * 0.035;
    wp.x += sin(TIME * 29.0 + t0.z * 3.1) * qa;
    wp.z += cos(TIME * 23.0 + t0.x * 2.7) * qa;
  }
#endif
  vA = vec4(t1.y, t1.z, t1.w, t2.x);
#if KIND == 1
  vB = vec4(t2.y, t3.w, cut, t2.w);
#else
  vB = vec4(t2.y, t3.w, cut, pt); // buildings / props: seconds since the last pop
#endif
#endif
  vWp = wp;
  vVox = v - nl * 0.5;
  vAo = float(aInfo.y >> 3u) / 3.0;
  vPal = aInfo.x;
  vMat = mat;
  vN = n;
  vNl = nl;
  gl_Position = uViewProj * vec4(wp, 1.0);
}`;

const FS_IN = `
in vec3 vWp;
in vec3 vVox;
in float vAo;
flat in uint vPal;
flat in uint vMat;
flat in vec3 vN;
flat in vec3 vNl;
flat in vec4 vA;
flat in vec4 vB;
uniform highp sampler2D uPal;
`;

/* Buildings, props and parts. vA = (seed, reveal, flags, id), vB = (fire, height, cut, extra). */
const FS_BLD = FS_IN + `
uniform vec4 uSched;   // lit-window fractions: homes, offices, shops, industry
uniform vec4 uBG;      // tod, selected id, hovered id, hover mode (1 = bulldoze)
uniform ivec4 uWinPal; // palette indices: office window, shop window
uniform float uFar;    // LOD tier of this draw (coarse meshes lose window voxels -> procedural facade lights)
out vec4 fragColor;
void main(){
  vec4 pe = texelFetch(uPal, ivec2(int(vPal), 0), 0);
  uint mat = vMat;
  uint fl = uint(vA.z + 0.5);
  float seed = vA.x, reveal = vA.y, id = vA.w;
  vec3 n = vN;
  vec3 V = normalize(uCamPos.xyz - vWp);
  float ndv = max(dot(n, V), 0.0);
  vec3 alb = srgb2lin(pe.rgb);
  vec3 em = vec3(0.0);
  float ao = 0.32 + 0.68 * vAo;
  vec3 vc = floor(vVox + 1e-3);
  bool aband = (fl & 1u) != 0u, burn = (fl & 2u) != 0u, unpow = (fl & 4u) != 0u;
  bool win = (mat & 1u) != 0u, glass = (mat & 2u) != 0u, metal = (mat & 16u) != 0u;
  float refl = 0.0, gloss = 48.0, specS = 0.0;
  float night = smoothstep(0.02, 0.5, NIGHT);
#if KIND != 2
  // ---------------- construction ----------------
  if (reveal < 0.999) {
    float cut = vB.z;
    if (n.y > 0.5 && vVox.y > cut - 0.52) {
      // freshly poured slab with a glowing rebar grid
      vec2 g = abs(fract(vVox.xz * 0.5) - 0.5);
      float grid = smoothstep(0.36, 0.46, max(g.x, g.y));
      alb = mix(vec3(0.3, 0.3, 0.29), vec3(0.42, 0.2, 0.08), grid);
      em += vec3(1.0, 0.5, 0.15) * grid * (0.35 + 0.25 * sin(TIME * 4.0 + seed * 30.0));
      win = false; glass = false; metal = false;
      mat &= ~(4u | 32u | 64u); // unbuilt neon / beacons / pools collapsed onto the cap do not glow
    } else {
      float below = cut - vVox.y;
      if (abs(vNl.y) < 0.5 && below < 6.0) {
        // scaffolding band: poles every 3 voxels, planks every 2, green safety netting between
        float u = abs(vNl.x) > 0.5 ? vVox.z : vVox.x;
        float pole = 1.0 - step(0.11, abs(fract(u / 3.0 + 0.5) - 0.5));
        float plank = 1.0 - step(0.09, abs(fract(vVox.y * 0.5) - 0.5));
        alb = mix(alb, vec3(0.1, 0.26, 0.18), 0.62);
        if (pole + plank > 0.5) { alb = vec3(0.8, 0.46, 0.08); metal = true; }
        win = false; glass = false;
      }
      em += vec3(1.0, 0.7, 0.36) * (1.0 - smoothstep(0.0, 1.2, below)) * 2.4;
    }
  }
  // ---------------- windows ----------------
  if (win) {
    vec3 wc3 = vec3(floor(vVox.x * 0.5), floor(vVox.y / 3.0), floor(vVox.z * 0.5));
    float h = hash13(wc3 + seed * 113.0);
    float h2 = hash13(wc3 * 1.7 + seed * 57.0 + 11.0);
    bool office = int(vPal) == uWinPal.x, shop = int(vPal) == uWinPal.y;
    float f;
    if (shop) f = uSched.z;
    else if ((fl & 32u) != 0u) f = uSched.w;
    else if ((fl & 16u) != 0u) f = office ? uSched.y : uSched.x * 0.85;
    else if ((fl & 8u) != 0u) f = uSched.x;
    else f = uSched.y * 0.7 + 0.12;
    if ((fl & 256u) != 0u) f = max(f, 0.8);
    if (aband) {
      float hb = hash13(vc + seed * 31.0);
      alb = hb < 0.4 ? vec3(0.2, 0.12, 0.06) : hb < 0.72 ? vec3(0.012) : alb * 0.45;
      refl = hb < 0.4 ? 0.0 : 0.1;
    } else {
      refl = 0.5; gloss = 110.0; specS = 1.0;
      alb *= 0.5;
      if (!unpow && !burn && reveal >= 0.999 && h < f) {
        vec3 lc = h2 < 0.52 ? vec3(1.0, 0.55, 0.22) : h2 < 0.8 ? vec3(1.0, 0.74, 0.42) : h2 < 0.94 ? vec3(0.62, 0.74, 1.0) : vec3(0.3, 0.45, 1.0);
        if (office) lc = mix(lc, vec3(0.75, 0.86, 1.0), 0.35);
        float inten = 0.45 + 0.7 * fract(h2 * 7.31);
        // mullions: a dark frame around every window voxel, so glass curtain walls read as panes
        vec2 wuv = abs(vNl.x) > 0.5 ? vVox.zy : vVox.xy;
        vec2 fw = abs(fract(wuv) - 0.5);
        inten *= 0.35 + 0.65 * (1.0 - smoothstep(0.36, 0.47, max(fw.x, fw.y)));
        if (h2 >= 0.94 && (fl & 8u) != 0u) inten *= 0.35 + 1.1 * tnoise(vec2(TIME * 0.37 + h * 9.0, h2 * 3.0)).r; // TV
        inten *= 0.82 + 0.3 * fract(vVox.y);
        em += lc * inten * 0.95 * night;
        refl *= 1.0 - night;
      }
    }
  }
  // coarse LOD: fake lit windows on facades so the far city still sparkles at night
  if (uFar > 0.5 && !win && abs(vNl.y) < 0.5 && (fl & 120u) != 0u && !aband && !unpow && !burn && reveal >= 0.999 && night > 0.0 && vVox.y > 2.0 && (mat & 4u) == 0u) {
    vec2 fu = vec2(abs(vNl.x) > 0.5 ? vVox.z : vVox.x, vVox.y);
    vec2 cell = floor(fu / vec2(2.0, 3.0));
    float h = hash13(vec3(cell, floor(abs(vNl.x) > 0.5 ? vVox.x : vVox.z)) + seed * 113.0);
    float f = (fl & 32u) != 0u ? uSched.w : (fl & 16u) != 0u ? uSched.y : (fl & 8u) != 0u ? uSched.x : uSched.y * 0.7 + 0.12;
    vec2 wf = abs(fract(fu / vec2(2.0, 3.0)) - 0.5);
    float pane = 1.0 - smoothstep(0.3, 0.42, max(wf.x, wf.y * 1.2));
    if (h < f * 0.8) {
      float h2 = fract(h * 91.7);
      vec3 lc = h2 < 0.55 ? vec3(1.0, 0.55, 0.22) : h2 < 0.85 ? vec3(1.0, 0.74, 0.42) : vec3(0.62, 0.74, 1.0);
      em += lc * (0.45 + 0.6 * fract(h * 7.3)) * 0.9 * night * mix(0.55, 1.0, pane) * min(uFar, 1.0);
    }
  }
#endif
  if (glass && !win) { refl = 0.55; gloss = 120.0; specS = 1.2; alb *= 0.6; }
  if (metal) { refl = max(refl, 0.28); gloss = max(gloss, 60.0); specS = max(specS, 0.7); }
  if ((mat & 32u) != 0u) { refl = 0.65; gloss = 140.0; specS = 1.2; alb *= 0.85 + 0.15 * sin(TIME * 2.3 + vWp.x * 9.0 + vWp.z * 7.0); }
  // ---------------- weather ----------------
  if (n.y > 0.5 && (mat & 128u) == 0u && SNOW > 0.0) {
    float sn = SNOW * smoothstep(0.1, 0.4, hash13(vc * 0.5 + seed) * 0.4 + SNOW * 0.6);
    alb = mix(alb, vec3(0.86, 0.9, 0.96), sn);
    refl *= 1.0 - sn;
  }
  if (WET > 0.0) {
#ifdef BG_LIBWET
    if (n.y < 0.5) { alb *= 1.0 - WET * 0.2; refl = max(refl, WET * 0.16); }
#else
    alb *= 1.0 - WET * 0.22;
    refl = max(refl, WET * (n.y > 0.5 ? 0.45 : 0.18));
#endif
    specS = max(specS, WET * 0.5);
  }
#if KIND != 2
  // ---------------- abandoned ----------------
  if (aband) {
    float l = dot(alb, vec3(0.3, 0.59, 0.11));
    alb = mix(alb, vec3(l) * vec3(1.0, 0.93, 0.8), 0.72) * 0.72;
    float streak = hash12(vec2(floor(vVox.x + vVox.z * 0.73), seed * 17.0));
    alb *= 1.0 - 0.4 * streak * smoothstep(0.3, 1.0, fract(vVox.y * 0.13 + streak));
  }
  // ---------------- fire ----------------
  if (burn) {
    float fire = clamp(vB.x, 0.0, 1.0);
    float chH = vB.y * (1.0 - fire * 0.92);
    float ch = smoothstep(chH - 3.0, chH + 1.0, vVox.y);
    alb = mix(alb, vec3(0.045, 0.036, 0.03) * (0.7 + 0.6 * hash13(vc * 0.5 + seed)), ch);
    refl *= 1.0 - ch;
    float flick = 0.55 + 0.45 * sin(TIME * 11.0 + vVox.y * 0.8 + seed * 40.0) * sin(TIME * 6.7 + vVox.x * 0.6 + vVox.z * 0.4);
    vec3 fc = vec3(1.0, 0.36, 0.06);
    if (win) {
      // every window burns on its own: flickering at its own rate, some black with smoke
      vec3 fcell = vec3(floor(vVox.x * 0.5), floor(vVox.y / 3.0), floor(vVox.z * 0.5));
      float hw = hash13(fcell + seed * 71.0);
      float fl2 = 0.55 + 0.45 * sin(TIME * (6.0 + hw * 7.0) + hw * 40.0);
      vec2 fu = abs(vNl.x) > 0.5 ? vVox.zy : vVox.xy;
      vec2 fm = abs(fract(fu) - 0.5);
      float frame = 0.4 + 0.6 * (1.0 - smoothstep(0.36, 0.47, max(fm.x, fm.y)));
      em = fc * (0.5 + 1.3 * fl2) * step(0.22, hw) * (0.45 + fire) * frame * (1.0 - ch * 0.65);
      alb *= 0.4;
    }
    else em += fc * (0.12 + 0.22 * flick) * fire * (1.0 - ch);
    em += fc * step(0.9, hash13(vc + floor(TIME * 3.0 + seed * 10.0))) * ch * 1.6;
  }
#endif
  // ---------------- emissive ----------------
  if ((mat & 4u) != 0u) em += srgb2lin(pe.rgb) * (aband ? 0.0 : unpow ? 0.25 : mix(1.1, 2.4, night));
  if ((mat & 64u) != 0u) em += srgb2lin(pe.rgb) * 3.4 * night * (aband || unpow ? 0.0 : 1.0);
  if ((fl & 2048u) != 0u) { alb *= vec3(0.85, 1.0, 0.9); em += vec3(0.2, 1.0, 0.6) * 0.25 * pow(1.0 - ndv, 2.0); }
#if KIND == 0
  // "ding!": a bright sweep runs up the building when it pops (completed / levelled up)
  if (vB.w < 1.4) {
    float k = vB.w / 1.4;
    float band = exp(-pow((vVox.y / max(vB.y, 1.0) - k * 1.3) * 7.0, 2.0));
    em += vec3(1.0, 0.92, 0.7) * band * (1.0 - k) * (0.45 + 0.6 * pow(1.0 - ndv, 2.0));
  }
#endif
  // ---------------- selection / hover ----------------
  float sel = id > 0.5 && abs(id - uBG.y) < 0.5 ? 1.0 : 0.0;
  float hov = id > 0.5 && abs(id - uBG.z) < 0.5 ? 1.0 : 0.0;
  if (hov > 0.0) alb = uBG.w > 0.5 ? mix(alb, vec3(0.9, 0.12, 0.08), 0.45) : alb * 1.22;
  vec3 col = shade(alb, n, vWp, ao);
  if (refl > 0.0) {
    vec3 R = reflect(-V, n);
    float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
#ifdef LIB_SOFT
    vec3 env = mix(uFog.rgb, uSkyAmb.rgb * 1.7, smoothstep(-0.1, 0.6, R.y));
#else
    vec3 env = skyColor(R);
#endif
    col += env * refl * (0.22 + 0.78 * fres);
  }
  if (specS > 0.0) col += specular(n, vWp, gloss, specS);
  col += em;
  if (sel > 0.0) {
    float rim = pow(1.0 - ndv, 2.5);
    float pulse = 0.55 + 0.45 * sin(TIME * 5.0);
    float scan = exp(-pow((fract(vVox.y / max(vB.y, 1.0) - TIME * 0.45) - 0.5) * 22.0, 2.0));
    // voxel edges glow faintly: reads as an outline hugging the building
    vec3 ed = 0.5 - abs(fract(vVox) - 0.5);
    vec3 e3 = ed / max(fwidth(vVox) * 1.5, vec3(1e-4));
    float e = min(abs(vNl.x) > 0.5 ? 1e5 : e3.x, min(abs(vNl.y) > 0.5 ? 1e5 : e3.y, abs(vNl.z) > 0.5 ? 1e5 : e3.z));
    float edge = (1.0 - smoothstep(0.5, 1.5, e)) * 0.06;
    vec3 cy = vec3(0.12, 0.8, 1.0);
    col += cy * (rim * 1.1 + scan * 0.55 + edge + (n.y > 0.5 ? 0.04 : 0.0)) * pulse * (1.0 - 0.45 * NIGHT);
  }
  if (hov > 0.0) col += (uBG.w > 0.5 ? vec3(1.0, 0.2, 0.1) : vec3(0.5, 0.8, 1.0)) * pow(1.0 - ndv, 3.0) * 0.5;
  col = applyFog(col, vWp);
  fragColor = vec4(col, 1.0);
}`;

/* Trees. vA = (seed, 1, flags, 0), vB = (0, height, cut, species). */
const FS_TREE_COMMON = `
bool bgEver(float sp){ return sp > 2.5 && sp < 5.5; }
float bgSeason(float seed){ return mod(uMisc.y + (seed - 0.5) * 0.3 + 4.0, 4.0); }
float bgBare(float st, float sp){ float b = smoothstep(2.62, 2.92, st) * (1.0 - smoothstep(3.72, 3.97, st)); return sp > 6.5 ? b * 0.55 : b; }
`;
const FS_TREE = FS_IN + FS_TREE_COMMON + `
out vec4 fragColor;
vec3 bgAutumn(float sp, float h, float seed){
  vec3 a, b;
  if (sp < 0.5) { a = vec3(0.62, 0.3, 0.04); b = vec3(0.36, 0.17, 0.05); }
  else if (sp < 1.5) { a = vec3(0.75, 0.08, 0.03); b = vec3(0.85, 0.35, 0.03); }
  else if (sp < 2.5) { a = vec3(0.85, 0.62, 0.06); b = vec3(0.7, 0.45, 0.04); }
  else if (sp < 6.5) { a = vec3(0.8, 0.22, 0.05); b = vec3(0.65, 0.07, 0.05); }
  else { a = vec3(0.55, 0.08, 0.05); b = vec3(0.45, 0.25, 0.05); }
  return mix(a, b, fract(seed * 5.13 + h * 0.6)) * (0.75 + 0.5 * h);
}
void main(){
  vec4 pe = texelFetch(uPal, ivec2(int(vPal), 0), 0);
  vec3 alb = srgb2lin(pe.rgb);
  vec3 n = vN;
  float seed = vA.x, sp = vB.w;
  bool leaf = (vMat & 8u) != 0u;
  vec3 vc = floor(vVox + 1e-3);
  float st = bgSeason(seed);
  if (leaf) {
    float hv = hash13(vc + seed * 71.0);
    alb *= vec3(0.9 + 0.2 * fract(seed * 7.3), 0.92 + 0.16 * fract(seed * 3.1), 0.9 + 0.15 * fract(seed * 5.7));
    if (!bgEver(sp)) {
      float bare = bgBare(st, sp);
#ifdef BARE
      if (hv < bare * 0.82) discard;
#endif
      float blossom = smoothstep(0.02, 0.12, st) * (1.0 - smoothstep(0.55, 0.8, st));
      float aut = smoothstep(1.8, 2.3, st) * (1.0 - smoothstep(2.9, 3.1, st));
      bool pink = pe.r > pe.g + 0.12 && pe.b > pe.g - 0.02;
      bool cherry = sp > 5.5 && sp < 6.5;
      if (pink && blossom < 0.5) alb = vec3(0.07, 0.2, 0.05) * (0.8 + 0.4 * hv);
      alb = mix(alb, bgAutumn(sp, hv, seed), aut);
      bool bloomTree = cherry || (seed < 0.3 && sp < 1.5);
      if (bloomTree && !pink && hv > 0.62) alb = mix(alb, hv > 0.88 ? vec3(0.9, 0.86, 0.88) : vec3(0.92, 0.45, 0.62), blossom);
      else alb = mix(alb, alb * vec3(1.05, 1.22, 0.75), blossom * 0.6);
      alb = mix(alb, vec3(0.13, 0.1, 0.08) * (0.8 + 0.4 * hv), bare);
    } else {
      alb *= 1.0 - 0.18 * smoothstep(2.6, 3.2, st) * (1.0 - smoothstep(3.7, 3.95, st));
    }
  }
  if (n.y > 0.5 && SNOW > 0.0) alb = mix(alb, vec3(0.9, 0.93, 0.98), SNOW * (leaf ? 0.95 : 0.7) * step(0.2, hash13(vc * 1.3 + seed)));
  float hn = clamp(vVox.y / max(vB.y, 1.0), 0.0, 1.0);
  float ao = (0.35 + 0.65 * vAo) * (0.72 + 0.28 * hn);
#ifndef BG_LIBWET
  if (WET > 0.0) alb *= 1.0 - WET * 0.25;
#endif
  vec3 col = shade(alb, n, vWp, ao);
  if (leaf) {
    vec3 V = normalize(uCamPos.xyz - vWp);
    float bl = pow(max(dot(-V, uSunDir.xyz), 0.0), 3.0);
    col += alb * uSunColor.rgb * uSunDir.w * bl * 0.3;
  }
  if (WET > 0.0) col += specular(n, vWp, 40.0, WET * 0.4);
  col = applyFog(col, vWp);
  fragColor = vec4(col, 1.0);
}`;

const FS_TREE_SHADOW = FS_IN + FS_TREE_COMMON + `
void main(){
  if ((vMat & 8u) != 0u && !bgEver(vB.w)) {
    float bare = bgBare(bgSeason(vA.x), vB.w);
    if (bare > 0.0 && hash13(floor(vVox + 1e-3) + vA.x * 71.0) < bare * 0.82) discard;
  }
}`;

/* Placement preview hologram: voxel-grid blueprint lines, rising scanline, pulsing, hazard stripes if invalid. */
const FS_GHOST = FS_IN + `
uniform vec4 uGhost; // rgb tint, w = 1 valid / 0 invalid
out vec4 fragColor;
void main(){
  vec4 pe = texelFetch(uPal, ivec2(int(vPal), 0), 0);
  vec3 alb = srgb2lin(pe.rgb);
  vec3 n = vN;
  float lam = 0.5 + 0.5 * max(dot(n, normalize(vec3(0.35, 0.85, 0.4))), 0.0);
  vec3 tint = uGhost.rgb;
  vec3 d = 0.5 - abs(fract(vVox) - 0.5);
  vec3 e3 = d / max(fwidth(vVox) * 1.3, vec3(1e-4));
  float e = 1e5;
  if (abs(vNl.x) < 0.5) e = min(e, e3.x);
  if (abs(vNl.y) < 0.5) e = min(e, e3.y);
  if (abs(vNl.z) < 0.5) e = min(e, e3.z);
  float line = 1.0 - smoothstep(0.6, 1.6, e);
  float pulse = 0.82 + 0.18 * sin(TIME * 6.0);
  float scan = exp(-pow((fract(vVox.y / max(vB.y, 1.0) - TIME * 0.35) - 0.5) * 10.0, 2.0));
  vec3 col = mix(alb * lam, tint * lam, 0.62) * 0.85 + tint * (line * 1.4 + scan * 0.9);
  float a = (0.3 + line * 0.45 + scan * 0.25) * pulse;
  if (uGhost.w < 0.5) col *= 0.7 + 0.45 * step(0.5, fract((vWp.x + vWp.y + vWp.z) * 2.5));
  fragColor = vec4(col, clamp(a, 0.0, 0.95));
}`;

/* Glow sprites: aS0 = (position, radius), aS1 = (rgb, mode). */
const VS_SPR = `
layout(location=0) in vec4 aS0;
layout(location=1) in vec4 aS1;
layout(location=2) in vec2 aCorner;
out vec2 vQ;
flat out vec3 vCol;
flat out float vGround;
void main(){
  vec2 q = aCorner;
  uint mode = uint(aS1.w + 0.5);
  float h = hash13(aS0.xyz * 7.13);
  float I = (mode & 1u) != 0u ? 1.0 : smoothstep(0.18 + h * 0.3, 0.38 + h * 0.3, NIGHT);
  if ((mode & 2u) != 0u) I *= step(fract(TIME * 0.75 + h), 0.2) * 1.4 + 0.05;
  if ((mode & 16u) != 0u) I *= 0.75 + 0.25 * sin(TIME * 9.0 + h * 40.0);
  if ((mode & 1u) != 0u && (mode & 2u) == 0u) I *= 0.35 + 0.65 * smoothstep(0.0, 0.4, NIGHT + 0.15);
  vec3 toC = uCamPos.xyz - aS0.xyz;
  float dist = length(toC);
  vGround = (mode & 4u) != 0u ? 1.0 : 0.0;
  vec3 wp;
  if (vGround > 0.5) {
    wp = aS0.xyz + vec3(q.x, 0.0, q.y) * aS0.w;
  } else {
    vec3 camR = vec3(uView[0][0], uView[1][0], uView[2][0]);
    vec3 camU = vec3(uView[0][1], uView[1][1], uView[2][1]);
    float sz = aS0.w * max(1.0, dist * 0.011);
    wp = aS0.xyz + toC / max(dist, 1e-3) * min(aS0.w * 0.8, 0.35) + (camR * q.x + camU * q.y) * sz;
    I *= min(1.0, dist * 0.35);
  }
  float fogK = exp(-dist * uFog.w * 0.8);
  vCol = aS1.rgb * I * fogK;
  vQ = q;
  gl_Position = I < 0.002 ? vec4(2.0, 2.0, 2.0, 1.0) : uViewProj * vec4(wp, 1.0);
}`;
const FS_SPR = `
in vec2 vQ;
flat in vec3 vCol;
flat in float vGround;
out vec4 fragColor;
void main(){
  float r2 = dot(vQ, vQ);
  if (r2 > 1.0) discard;
  vec3 c;
  if (vGround > 0.5) { float f = 1.0 - r2; c = vCol * f * f * 0.35; }
  else c = vCol * (exp(-r2 * 26.0) * 3.2 + exp(-r2 * 5.0) * (1.0 - r2) * 0.45);
  fragColor = vec4(c, 1.0);
}`;

/* ================================================================== */
/* Engine API for gfx/props.js                                          */
/* ================================================================== */
const E = {
  K: { BLD: K_BLD, TREE: K_TREE, PROP: K_PROP, PART: K_PART },
  SET: { MAIN: SET_MAIN, PROPS: SET_PROPS },
  FL,
  SLOT_F,
  /** Wrapper for VC model m drawn as `kind` (null if m is null). Fields: idx, m, lights, noStaticLights, pool. */
  mw: getMW,
  setSkip,
  /** New slot in set (0 main / 1 props) with model wrapper mw at (x,y,z), yaw, scale. Returns the slot. */
  add(set, mw, x, y, z, yaw, scale = 1, flags = 0, seed = 0.5, extra = 0) {
    const s = alloc(set);
    const o = s * SLOT_F;
    D[o] = x; D[o + 1] = y; D[o + 2] = z; D[o + 3] = yaw;
    D[o + 4] = scale; D[o + 5] = seed; D[o + 6] = 1; D[o + 7] = flags;
    D[o + 8] = 0; D[o + 9] = 0; D[o + 10] = NO_POP; D[o + 11] = extra;
    setModel(s, mw);
    if (mw) { D[o + 12] = mw.cx; D[o + 13] = mw.cz; D[o + 14] = mw.vox; D[o + 15] = mw.h; }
    markDirty(s);
    const r = mw ? mw.radius * scale + 0.3 : 1;
    place(s, x, z, r, y - 0.2, y + (mw ? mw.height * scale : 1) + 0.3);
    spritesDirty = true;
    return s;
  },
  /** Switches the model of slot s (e.g. traffic-light aspect). */
  setModel(s, mw) {
    setModel(s, mw);
  },
  remove(s) {
    release(s);
    spritesDirty = true;
  },
  /** Raw slot data (read/write; call touch(s) after writing). */
  data: () => D,
  touch(s) {
    markDirty(s);
  },
  dynSprite,
  /** Gathers + draws a set in the current layer pass (props layer uses set 1). */
  draw(ctx, set, shadow) {
    return drawSet(ctx, set, shadow);
  },
  /** Marks static sprites for rebuild. */
  spritesDirty() {
    spritesDirty = true;
  },
  /** True while the camera pass saw the cell of world (x, z) within the last few frames. */
  cellSeen(x, z) {
    if (!nCells) return false;
    return (VC.gfx.frameCount | 0) - cellSeen[cellOf(x, z)] <= 3;
  },
};
B.eng = E;
