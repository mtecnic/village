/*
 * VOXELPOLIS — terrain renderer: a stepped voxel diorama.
 *
 * GEOMETRY (chunked, C.CHUNK² tiles per chunk, typed arrays, rebuilt only when height/material/road
 * data in a chunk (+2 tile margin) actually changed; per-frame time budget; frustum culled per pass):
 *   - tile tops at level * STEP (seabed for water tiles), road ramps as sloped tops
 *   - cliff sides toward lower neighbours; map edges get skirts down to SKIRT_Y (the diorama slab)
 *     standing on a wooden plinth ring
 *   - roads: raised sidewalks + kerbs (street/avenue), green median (straight avenues), jersey
 *     barriers (highway), bridges on water tiles (deck at DECK_Y, fascia, railings, piers)
 * SURFACES are procedural in the fragment shader on a world-space 1/8 voxel grid: grass/meadow/sand/
 * dirt/rock/snow, strata on sides, road markings, crosswalks, zone lots, lot bases under buildings,
 * seasons (autumn tint, snow), rain (darkening, puddles with ripples), night lamp pools, caustics,
 * build grid, hover glow and a smooth (bilinear) data-overlay heatmap.
 *
 * VERTEX FORMAT (12 bytes):
 *   loc 0 aP  int16 x4  x, y, z, w in 1/64 world units (float attrib). w = top-edge Y of side faces
 *   loc 1 aI  uint8 x4  (integer attrib)
 *     .x normal index (0 +X,1 -X,2 +Y,3 -Y,4 +Z,5 -Z, 6+d = ramp rising toward dir d) | kind << 4
 *     .y terr | road type << 3 | bridge << 5 | ramp << 6
 *     .z road connection mask (bit d: 0 +X,1 -X,2 +Z,3 -Z) | neighbour-is-intersection mask << 4
 *     .w tops: AO mask (edge higher: 1 +X,2 -X,4 +Z,8 -Z; corner: 16 +X+Z,32 -X+Z,64 +X-Z,128 -X-Z)
 *        sides: bottom level (255 = slab bottom)
 *
 * ROAD RULES: roads connect to any adjacent road (street/avenue/highway) whose road level differs by
 * at most 1. A 1-level difference becomes a RAMP on the lower tile when that tile is straight along the
 * link; bridges (road on water) act as road level DECK_LVL and never ramp (a higher land tile ramps
 * down onto them instead). Right-hand traffic: stop lines sit on the lane approaching an intersection.
 * Night light pools sit at sidewalk mid-points of non-connected edges on tiles with (x + z) even —
 * see lampSpots(x, z) (props should put their street lamps there).
 *
 * API (VC.terrain): SKIRT_Y, DECK_Y, CURB, markDirty(x0,z0,x1,z1), rebuildAll(), stats,
 *   roadY(wx, wz) road surface height (ramps/bridge decks) or null, surfaceY(wx, wz) walkable top,
 *   roadInfo(x, z) -> {type, mask, inter, bridge, ramp:{dir, up}|null, y}, lampSpots(x, z) -> [{x, z, dir}]
 */
const C = VC.C, M = VC.M;
const STEP = C.STEP, SEA = C.SEA, CH = C.CHUNK;
const Q = 64; // position quantization (units of 1/64 world unit)
const SKIRT_Y = -3; // diorama slab bottom
const DECK_LVL = SEA + 1; // bridges behave like roads at this level
const DECK_Y = DECK_LVL * STEP; // 1.75 (= C.SEA_Y + 0.37)
const DECK_T = 0.125; // deck thickness
const CURB = 3 / 64; // sidewalk / median height
const SW = [0, 9 / 64, 6 / 64, 0]; // sidewalk width per road type
const BAR_W = 3 / 64, BAR_H = 5 / 64; // highway jersey barrier
const RAIL_H = 6 / 64, POST = 1.5 / 64; // bridge railing
const MED_HW = 2 / 64; // half width of the raised avenue median
const PLINTH = 0.4; // plinth ring width
const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1], OPP = [1, 0, 3, 2];
const NSIDE = [0, 1, 4, 5]; // normal index of a face looking toward dir d
const K = { TOP: 0, ROAD: 1, SIDE: 2, WALK: 3, CURB: 4, MEDIAN: 5, BARRIER: 6, RAIL: 7, DECKSIDE: 8, PILLAR: 9, PLINTH: 10 };
const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]; // popcount of a 4-bit mask

const T = (VC.terrain = {
  name: 'terrain',
  order: 0,
  SKIRT_Y, DECK_Y, CURB,
  chunks: [],
  cw: 0, ch: 0,
  full: true,
  stats: { chunks: 0, quads: 0, drawn: 0, rebuilt: 0, skipped: 0, lastMs: 0, fullMs: 0, maxChunkMs: 0 },
  budgetMs: 4, // incremental rebuild budget per frame

  init() {
    T.prog = VC.gfx.program('terrain', VS, FS);
    T.progShadow = VC.gfx.program('terrain_shadow', VS_SHADOW, FS_SHADOW);
    VC.gfx.addLayer(T);
    VC.bus.on('dirty', (d) => T.markDirty(d.x0, d.z0, d.x1, d.z1));
  },

  reset(S) {
    const gl = VC.gfx.gl;
    for (const c of T.chunks) if (c.vao) { gl.deleteVertexArray(c.vao); gl.deleteBuffer(c.vbo); }
    T.chunks = [];
    T.dirty = [];
    T.cw = Math.ceil(S.W / CH);
    T.ch = Math.ceil(S.H / CH);
    for (let cz = 0; cz < T.ch; cz++)
      for (let cx = 0; cx < T.cw; cx++) {
        const c = { cx, cz, x0: cx * CH, z0: cz * CH, x1: Math.min(S.W, cx * CH + CH), z1: Math.min(S.H, cz * CH + CH), dirty: false, vao: null, vbo: null, quads: 0, hash: -1, minY: 0, maxY: 1, dist: 0 };
        T.chunks.push(c);
        setDirty(c);
      }
    T.full = true;
    T.stats.chunks = T.chunks.length;
    T.stats.quads = 0;
    buildPlinth(S);
  },

  update() {
    // meshing happens lazily at draw time (after VC.world.flush), so edits show up the same frame
  },

  /** Marks chunks overlapping the inclusive tile rect (+ margin for road/ramp context) for rebuild. */
  markDirty(x0, z0, x1, z1) {
    if (!T.chunks.length) return;
    const c0x = Math.max(0, Math.floor((x0 - 2) / CH)), c1x = Math.min(T.cw - 1, Math.floor((x1 + 2) / CH));
    const c0z = Math.max(0, Math.floor((z0 - 2) / CH)), c1z = Math.min(T.ch - 1, Math.floor((z1 + 2) / CH));
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) setDirty(T.chunks[cz * T.cw + cx]);
  },

  /** Rebuilds every chunk synchronously (forced, ignores the change hash). */
  rebuildAll() {
    for (const c of T.chunks) { c.hash = -1; setDirty(c); }
    T.full = true;
    T._frame = -1;
    process();
  },
  /** Debug/benchmark: rebuilds one chunk synchronously. */
  _build(c) {
    if (!VC.state) return;
    bindState(VC.state);
    c.hash = -1;
    buildChunk(c);
  },

  shadow(ctx) {
    process();
    draw(ctx, true);
  },
  opaque(ctx) {
    process();
    draw(ctx, false);
  },

  /* ---------------- queries for other modules ---------------- */
  /** Road surface height at world (wx, wz) — follows ramps and bridge decks. null if no road. */
  roadY(wx, wz) {
    const S = VC.state;
    if (!S) return null;
    const x = Math.floor(wx), z = Math.floor(wz);
    if (x < 0 || z < 0 || x >= S.W || z >= S.H) return null;
    const i = z * S.W + x;
    if (!S.road[i]) return null;
    bindState(S);
    if (S.height[i] < SEA) return DECK_Y;
    return rampY(S.height[i], rampOf(x, z), wx - x, wz - z);
  },
  /** Top of whatever you would stand on at (wx, wz): road deck/ramp, else terrain (water surface on water). */
  surfaceY(wx, wz) {
    const r = T.roadY(wx, wz);
    if (r != null) return r;
    const S = VC.state;
    if (!S) return 0;
    const x = M.clamp(Math.floor(wx), 0, S.W - 1), z = M.clamp(Math.floor(wz), 0, S.H - 1);
    return Math.max(S.height[z * S.W + x] * STEP, C.SEA_Y);
  },
  /** Connectivity of a road tile as rendered: {type, mask, inter, bridge, ramp: {dir, up} | null, y}. */
  roadInfo(x, z) {
    const S = VC.state;
    if (!S || x < 0 || z < 0 || x >= S.W || z >= S.H) return null;
    const i = z * S.W + x;
    if (!S.road[i]) return null;
    bindState(S);
    const mask = finalMask(x, z), rc = rampOf(x, z), bridge = S.height[i] < SEA;
    return {
      type: S.road[i], mask, inter: POP[mask] >= 3, bridge,
      ramp: rc ? { dir: (rc - 1) >> 1, up: !((rc - 1) & 1) } : null,
      y: bridge ? DECK_Y : S.height[i] * STEP,
    };
  },
  /** Where this renderer puts street-lamp light pools on road tile (x, z) (world coords). */
  lampSpots(x, z) {
    const S = VC.state;
    const out = [];
    if (!S || x < 0 || z < 0 || x >= S.W || z >= S.H || (x + z) & 1) return out;
    const rt = S.road[z * S.W + x];
    if (!rt) return out;
    bindState(S);
    const m = finalMask(x, z);
    if (rt === 3) {
      if (m === 3 || m === 12) out.push({ x: x + 0.5, z: z + 0.5, dir: m === 3 ? 0 : 2 });
      return out;
    }
    const h = SW[rt] * 0.5;
    if (!(m & 1)) out.push({ x: x + 1 - h, z: z + 0.5, dir: 0 });
    if (!(m & 2)) out.push({ x: x + h, z: z + 0.5, dir: 1 });
    if (!(m & 4)) out.push({ x: x + 0.5, z: z + 1 - h, dir: 2 });
    if (!(m & 8)) out.push({ x: x + 0.5, z: z + h, dir: 3 });
    return out;
  },
});

function setDirty(c) {
  if (c.dirty) return;
  c.dirty = true;
  T.dirty.push(c);
}

/* ------------------------------------------------------------------ */
/* Road connectivity (reads the bound state)                            */
/* ------------------------------------------------------------------ */
let S = null, W = 0, H = 0;
function bindState(st) {
  S = st;
  W = st.W;
  H = st.H;
}
/** Road level: land level, DECK_LVL for bridges, -1 if no road / off map. */
function RL(x, z) {
  if (x < 0 || z < 0 || x >= W || z >= H) return -1;
  const i = z * W + x;
  if (!S.road[i]) return -1;
  const h = S.height[i];
  return h < SEA ? DECK_LVL : h;
}
function isBridge(x, z) {
  const i = z * W + x;
  return S.road[i] !== 0 && S.height[i] < SEA;
}
function rawMask(x, z) {
  const r = RL(x, z);
  if (r < 0) return 0;
  let m = 0;
  for (let d = 0; d < 4; d++) {
    const n = RL(x + DX[d], z + DZ[d]);
    if (n >= 0 && n - r <= 1 && r - n <= 1) m |= 1 << d;
  }
  return m;
}
/** Ramp code: 0 flat, else 1 + dir * 2 + (down ? 1 : 0). Only straight land roads ramp (first match wins). */
function rampOf(x, z) {
  const r = RL(x, z);
  if (r < 0 || isBridge(x, z)) return 0;
  const m = rawMask(x, z);
  if (!m || (m & 3 && m & 12)) return 0;
  for (let d = 0; d < 4; d++) {
    if (!(m & (1 << d))) continue;
    const nx = x + DX[d], nz = z + DZ[d], n = RL(nx, nz);
    if (n === r + 1) return 1 + d * 2;
    if (n === r - 1 && isBridge(nx, nz)) return 2 + d * 2;
  }
  return 0;
}
/** True if road tile (x, z) connects to its neighbour in dir d (symmetric). */
function link(x, z, d) {
  const r = RL(x, z), nx = x + DX[d], nz = z + DZ[d], n = RL(nx, nz);
  if (r < 0 || n < 0) return false;
  const dh = n - r;
  if (dh === 0) return true;
  if (dh === 1) return rampOf(x, z) === 1 + d * 2 || (isBridge(x, z) && rampOf(nx, nz) === 2 + OPP[d] * 2);
  if (dh === -1) return rampOf(nx, nz) === 1 + OPP[d] * 2 || (isBridge(nx, nz) && rampOf(x, z) === 2 + d * 2);
  return false;
}
function finalMask(x, z) {
  if (RL(x, z) < 0) return 0;
  let m = 0;
  for (let d = 0; d < 4; d++) if (link(x, z, d)) m |= 1 << d;
  return m;
}
/** Surface height of a tile at local (u, v) for base level lv and ramp code rc. */
function rampY(lv, rc, u, v) {
  let y = lv * STEP;
  if (rc) {
    const d = (rc - 1) >> 1;
    const t = d === 0 ? u : d === 1 ? 1 - u : d === 2 ? v : 1 - v;
    y += (rc - 1) & 1 ? -STEP * t : STEP * t;
  }
  return y;
}
/** Normal index of a ramp surface (rises toward d for up-ramps, toward OPP[d] for down-ramps). */
function rampNormal(rc) {
  const d = (rc - 1) >> 1;
  return 6 + ((rc - 1) & 1 ? OPP[d] : d);
}

/* per-chunk cache of final masks & ramp codes (chunk + 1 tile margin) */
const CM = CH + 2;
const cacheFM = new Uint8Array(CM * CM), cacheRC = new Uint8Array(CM * CM);
let cx0 = 0, cz0 = 0;
function prepCache(x0, z0) {
  cx0 = x0 - 1;
  cz0 = z0 - 1;
  for (let j = 0; j < CM; j++)
    for (let i = 0; i < CM; i++) {
      const x = cx0 + i, z = cz0 + j, k = j * CM + i;
      if (RL(x, z) < 0) { cacheFM[k] = 0; cacheRC[k] = 0; continue; }
      cacheFM[k] = finalMask(x, z);
      cacheRC[k] = rampOf(x, z);
    }
}
function cFM(x, z) {
  const i = x - cx0, j = z - cz0;
  return i < 0 || j < 0 || i >= CM || j >= CM ? finalMask(x, z) : cacheFM[j * CM + i];
}
function cRC(x, z) {
  const i = x - cx0, j = z - cz0;
  return i < 0 || j < 0 || i >= CM || j >= CM ? rampOf(x, z) : cacheRC[j * CM + i];
}
/** Top height of tile (x, z) at its local corner (u, v); SKIRT_Y off the map. */
function cornerY(x, z, u, v) {
  if (x < 0 || z < 0 || x >= W || z >= H) return SKIRT_Y;
  const i = z * W + x, lv = S.height[i];
  return rampY(lv, S.road[i] && lv >= SEA ? cRC(x, z) : 0, u, v);
}

/* ------------------------------------------------------------------ */
/* Vertex writer                                                        */
/* ------------------------------------------------------------------ */
let VB = new ArrayBuffer(48 * 16384);
let I16 = new Int16Array(VB), U8 = new Uint8Array(VB);
let nv = 0; // vertices written
let aKind = 0, aB = 0, aC = 0, aD = 0; // attributes of the face being written
function ensure(quads) {
  const need = (nv + quads * 4) * 12;
  if (need <= VB.byteLength) return;
  const nb = new ArrayBuffer(Math.max(need, VB.byteLength * 2));
  new Uint8Array(nb).set(U8.subarray(0, nv * 12));
  VB = nb;
  I16 = new Int16Array(VB);
  U8 = new Uint8Array(VB);
}
function V(x, y, z, w, nrm) {
  const o = nv * 6, u = nv * 12 + 8;
  I16[o] = Math.round(x * Q);
  I16[o + 1] = Math.round(y * Q);
  I16[o + 2] = Math.round(z * Q);
  I16[o + 3] = Math.round(w * Q);
  U8[u] = nrm | (aKind << 4);
  U8[u + 1] = aB;
  U8[u + 2] = aC;
  U8[u + 3] = aD;
  nv++;
}
/** Horizontal-ish quad over [x0,x1]x[z0,z1] with corner heights y0 (x0,z0), y1 (x1,z0), y2 (x1,z1), y3 (x0,z1). */
function topQ(x0, z0, x1, z1, y0, y1, y2, y3, nrm) {
  ensure(1);
  V(x0, y3, z1, 0, nrm);
  V(x1, y2, z1, 0, nrm);
  V(x1, y1, z0, 0, nrm);
  V(x0, y0, z0, 0, nrm);
}
/** Vertical face at x = xf spanning z0..z1; b0,b1 / t0,t1 = bottom / top heights at z0 and z1. */
function sideX(xf, z0, z1, b0, b1, t0, t1, pos) {
  ensure(1);
  if (pos) { V(xf, b1, z1, t1, 0); V(xf, b0, z0, t0, 0); V(xf, t0, z0, t0, 0); V(xf, t1, z1, t1, 0); }
  else { V(xf, b0, z0, t0, 1); V(xf, b1, z1, t1, 1); V(xf, t1, z1, t1, 1); V(xf, t0, z0, t0, 1); }
}
/** Vertical face at z = zf spanning x0..x1; b0,b1 / t0,t1 = bottom / top heights at x0 and x1. */
function sideZ(zf, x0, x1, b0, b1, t0, t1, pos) {
  ensure(1);
  if (pos) { V(x0, b0, zf, t0, 4); V(x1, b1, zf, t1, 4); V(x1, t1, zf, t1, 4); V(x0, t0, zf, t0, 4); }
  else { V(x1, b1, zf, t1, 5); V(x0, b0, zf, t0, 5); V(x0, t0, zf, t0, 5); V(x1, t1, zf, t1, 5); }
}
/**
 * Prism over [x0,x1]x[z0,z1] with bottom corner heights b0..b3 (same corner order as topQ) and
 * thickness h. faces: 1 +X, 2 -X, 4 +Z, 8 -Z, 16 top.
 */
function prism(x0, z0, x1, z1, b0, b1, b2, b3, h, faces, kTop, kSide, nTop) {
  const t0 = b0 + h, t1 = b1 + h, t2 = b2 + h, t3 = b3 + h;
  if (faces & 16) { aKind = kTop; topQ(x0, z0, x1, z1, t0, t1, t2, t3, nTop); }
  aKind = kSide;
  if (faces & 1) sideX(x1, z0, z1, b1, b2, t1, t2, true);
  if (faces & 2) sideX(x0, z0, z1, b0, b3, t0, t3, false);
  if (faces & 4) sideZ(z1, x0, x1, b3, b2, t3, t2, true);
  if (faces & 8) sideZ(z0, x0, x1, b0, b1, t0, t1, false);
}

/* ------------------------------------------------------------------ */
/* Tile mesher                                                          */
/* ------------------------------------------------------------------ */
let curLv = 0, curRc = 0, curN = 2; // road surface of the tile being built (for extras)
function sY(u, v) {
  return rampY(curLv, curRc, u, v);
}
/** Prism in tile-local coords [u0,u1]x[v0,v1] sitting on the road surface (+ yOff). */
function pr(x, z, u0, v0, u1, v1, h, yOff, faces, kTop, kSide) {
  prism(x + u0, z + v0, x + u1, z + v1, sY(u0, v0) + yOff, sY(u1, v0) + yOff, sY(u1, v1) + yOff, sY(u0, v1) + yOff, h, faces | 16, kTop, kSide, curN);
}

function aoMask(x, z, lv, fm) {
  const hi = (xx, zz) => xx >= 0 && zz >= 0 && xx < W && zz < H && S.height[zz * W + xx] > lv;
  let m = 0;
  if (!(fm & 1) && hi(x + 1, z)) m |= 1;
  if (!(fm & 2) && hi(x - 1, z)) m |= 2;
  if (!(fm & 4) && hi(x, z + 1)) m |= 4;
  if (!(fm & 8) && hi(x, z - 1)) m |= 8;
  if (!(m & 5) && hi(x + 1, z + 1)) m |= 16;
  if (!(m & 6) && hi(x - 1, z + 1)) m |= 32;
  if (!(m & 9) && hi(x + 1, z - 1)) m |= 64;
  if (!(m & 10) && hi(x - 1, z - 1)) m |= 128;
  return m;
}
function nbInter(x, z, fm) {
  let b = 0;
  for (let d = 0; d < 4; d++) if (fm & (1 << d) && POP[cFM(x + DX[d], z + DZ[d])] >= 3) b |= 1 << d;
  return b;
}

/** Side face of tile (x, z) toward dir d if it sticks out above the neighbour (tA,tB own tops; bA,bB neighbour tops). */
function sideFace(x, z, d, tA, tB, bA, bB) {
  if (tA <= bA + 1e-4 && tB <= bB + 1e-4) return;
  const b0 = Math.min(bA, tA), b1 = Math.min(bB, tB);
  aD = bA <= SKIRT_Y + 1e-3 ? 255 : M.clamp(Math.round(Math.min(b0, b1) / STEP), 0, 254);
  if (d === 0) sideX(x + 1, z, z + 1, b0, b1, tA, tB, true);
  else if (d === 1) sideX(x, z, z + 1, b0, b1, tA, tB, false);
  else if (d === 2) sideZ(z + 1, x, x + 1, b0, b1, tA, tB, true);
  else sideZ(z, x, x + 1, b0, b1, tA, tB, false);
}

function emitTile(x, z) {
  const i = z * W + x;
  const lv = S.height[i], water = lv < SEA, rt = S.road[i], terr = S.terr[i];
  const landRoad = rt !== 0 && !water;
  const rc = landRoad ? cRC(x, z) : 0;
  const fm = rt ? cFM(x, z) : 0;
  const nbi = rt ? nbInter(x, z, fm) : 0;
  const y0 = rampY(lv, rc, 0, 0), y1 = rampY(lv, rc, 1, 0), y2 = rampY(lv, rc, 1, 1), y3 = rampY(lv, rc, 0, 1);
  // ---- top ----
  aKind = landRoad ? K.ROAD : K.TOP;
  aB = terr | (landRoad ? rt << 3 : 0) | (rc ? 64 : 0);
  aC = landRoad ? fm | (nbi << 4) : 0;
  aD = aoMask(x, z, lv, landRoad ? fm : 0);
  topQ(x, z, x + 1, z + 1, y0, y1, y2, y3, rc ? rampNormal(rc) : 2);
  // ---- sides toward lower neighbours (and skirts at the map edge) ----
  aKind = K.SIDE;
  aB = terr | (landRoad ? rt << 3 : 0);
  aC = 0;
  sideFace(x, z, 0, y1, y2, cornerY(x + 1, z, 0, 0), cornerY(x + 1, z, 0, 1));
  sideFace(x, z, 1, y0, y3, cornerY(x - 1, z, 1, 0), cornerY(x - 1, z, 1, 1));
  sideFace(x, z, 2, y3, y2, cornerY(x, z + 1, 0, 0), cornerY(x, z + 1, 1, 0));
  sideFace(x, z, 3, y0, y1, cornerY(x, z - 1, 0, 1), cornerY(x, z - 1, 1, 1));
  if (rt) roadExtras(x, z, rt, fm, nbi, water, lv, rc, terr);
}

function roadExtras(x, z, rt, fm, nbi, bridge, lv, rc, terr) {
  curLv = bridge ? DECK_LVL : lv;
  curRc = bridge ? 0 : rc;
  curN = curRc ? rampNormal(curRc) : 2;
  aB = terr | (rt << 3) | (bridge ? 32 : 0) | (curRc ? 64 : 0);
  aC = fm | (nbi << 4);
  aD = 0;
  if (bridge) {
    // deck surface
    aKind = K.ROAD;
    topQ(x, z, x + 1, z + 1, DECK_Y, DECK_Y, DECK_Y, DECK_Y, 2);
    // fascia along open edges
    aKind = K.DECKSIDE;
    const yb = DECK_Y - DECK_T;
    if (!(fm & 1)) sideX(x + 1, z, z + 1, yb, yb, DECK_Y, DECK_Y, true);
    if (!(fm & 2)) sideX(x, z, z + 1, yb, yb, DECK_Y, DECK_Y, false);
    if (!(fm & 4)) sideZ(z + 1, x, x + 1, yb, yb, DECK_Y, DECK_Y, true);
    if (!(fm & 8)) sideZ(z, x, x + 1, yb, yb, DECK_Y, DECK_Y, false);
    piers(x, z, fm, lv);
  }
  if (rt === 3) {
    strips(x, z, fm, BAR_W, BAR_H, 0, K.BARRIER, K.BARRIER, true);
  } else {
    strips(x, z, fm, SW[rt], CURB, 0, K.WALK, K.CURB, true);
    if (bridge) railings(x, z, fm);
  }
  if (rt === 2 && (fm === 3 || fm === 12)) median(x, z, fm, nbi);
}

/** Raised strips along the open (non-connected) edges + corner squares between two connections. */
function strips(x, z, fm, w, h, yOff, kTop, kSide, corners) {
  const sPX = !(fm & 1), sNX = !(fm & 2), sPZ = !(fm & 4), sNZ = !(fm & 8);
  if (sNZ) pr(x, z, 0, 0, 1, w, h, yOff, 4 | 8, kTop, kSide);
  if (sPZ) pr(x, z, 0, 1 - w, 1, 1, h, yOff, 4 | 8, kTop, kSide);
  const v0 = sNZ ? w : 0, v1 = sPZ ? 1 - w : 1;
  if (sPX) pr(x, z, 1 - w, v0, 1, v1, h, yOff, 1 | 2, kTop, kSide);
  if (sNX) pr(x, z, 0, v0, w, v1, h, yOff, 1 | 2, kTop, kSide);
  if (!corners) return;
  if (!sPX && !sPZ) pr(x, z, 1 - w, 1 - w, 1, 1, h, yOff, 2 | 8, kTop, kSide);
  if (!sNX && !sPZ) pr(x, z, 0, 1 - w, w, 1, h, yOff, 1 | 8, kTop, kSide);
  if (!sPX && !sNZ) pr(x, z, 1 - w, 0, 1, w, h, yOff, 2 | 4, kTop, kSide);
  if (!sNX && !sNZ) pr(x, z, 0, 0, w, w, h, yOff, 1 | 4, kTop, kSide);
}

/** Bridge railings: posts every 1/8 unit + a top rail along open edges, on top of the sidewalk. */
function railings(x, z, fm) {
  const y = CURB, rw = POST, ph = RAIL_H - 1 / 64;
  for (let d = 0; d < 4; d++) {
    if (fm & (1 << d)) continue;
    const alongX = d >= 2; // edge runs along X for ±Z edges
    const e0 = d === 0 ? 1 - rw * 1.5 : d === 1 ? rw * 0.5 : d === 2 ? 1 - rw * 1.5 : rw * 0.5; // across-edge position
    // top rail
    if (alongX) pr(x, z, 0, e0 - rw * 0.25, 1, e0 + rw * 1.25, 1.2 / 64, y + ph, 4 | 8, K.RAIL, K.RAIL);
    else pr(x, z, e0 - rw * 0.25, 0, e0 + rw * 1.25, 1, 1.2 / 64, y + ph, 1 | 2, K.RAIL, K.RAIL);
    for (let p = 0; p < 8; p++) {
      const a = p / 8 + 1 / 16 - rw * 0.5;
      if (alongX) pr(x, z, a, e0, a + rw, e0 + rw, ph, y, 15, K.RAIL, K.RAIL);
      else pr(x, z, e0, a, e0 + rw, a + rw, ph, y, 15, K.RAIL, K.RAIL);
    }
  }
}

/** Raised green median on straight avenue tiles; stops short before intersections / road ends. */
function median(x, z, fm, nbi) {
  const ax = fm === 3;
  const dN = ax ? 1 : 3, dP = ax ? 0 : 2;
  const cont = (d) => {
    const nx = x + DX[d], nz = z + DZ[d];
    return RL(nx, nz) >= 0 && S.road[nz * W + nx] === 2 && cFM(nx, nz) === fm;
  };
  let a0 = 0, a1 = 1, faces = ax ? 4 | 8 : 1 | 2;
  if (!cont(dN)) { a0 = (nbi >> dN) & 1 ? 0.3 : 0.14; faces |= ax ? 2 : 8; }
  if (!cont(dP)) { a1 = 1 - ((nbi >> dP) & 1 ? 0.3 : 0.14); faces |= ax ? 1 : 4; }
  const m0 = 0.5 - MED_HW, m1 = 0.5 + MED_HW;
  if (ax) pr(x, z, a0, m0, a1, m1, CURB, 0, faces, K.MEDIAN, K.CURB);
  else pr(x, z, m0, a0, m1, a1, CURB, 0, faces, K.MEDIAN, K.CURB);
}

/** Bridge piers down to the seabed: every other tile along straight spans, always under junctions. */
function piers(x, z, fm, lv) {
  const ax = fm === 3 ? 1 : fm === 12 ? 2 : 0;
  if ((ax === 1 && x & 1) || (ax === 2 && z & 1)) return;
  const yb = lv * STEP, capH = 0.07, yc = DECK_Y - DECK_T - capH;
  const col = (u0, v0, u1, v1) => prism(x + u0, z + v0, x + u1, z + v1, yb, yb, yb, yb, yc - yb, 15, K.PILLAR, K.PILLAR, 2);
  const cap = (u0, v0, u1, v1) => prism(x + u0, z + v0, x + u1, z + v1, yc, yc, yc, yc, capH, 15, K.PILLAR, K.PILLAR, 2);
  if (ax === 1) {
    col(0.44, 0.15, 0.56, 0.27);
    col(0.44, 0.73, 0.56, 0.85);
    cap(0.41, 0.08, 0.59, 0.92);
  } else if (ax === 2) {
    col(0.15, 0.44, 0.27, 0.56);
    col(0.73, 0.44, 0.85, 0.56);
    cap(0.08, 0.41, 0.92, 0.59);
  } else {
    col(0.4, 0.4, 0.6, 0.6);
    cap(0.28, 0.28, 0.72, 0.72);
  }
}

/* ------------------------------------------------------------------ */
/* Chunks                                                               */
/* ------------------------------------------------------------------ */
/** Hash of everything the chunk mesh depends on (height/terr/road in chunk + 2 tile margin). */
function chunkHash(c) {
  let h = 2166136261;
  const x0 = Math.max(0, c.x0 - 2), z0 = Math.max(0, c.z0 - 2), x1 = Math.min(W, c.x1 + 2), z1 = Math.min(H, c.z1 + 2);
  const hg = S.height, tr = S.terr, rd = S.road;
  for (let z = z0; z < z1; z++)
    for (let i = z * W + x0, e = z * W + x1; i < e; i++) h = Math.imul(h ^ (hg[i] | (tr[i] << 8) | (rd[i] << 12)), 16777619);
  return h >>> 0;
}

function buildChunk(c) {
  const gl = VC.gfx.gl;
  c.dirty = false;
  const hsh = chunkHash(c);
  if (c.vao && hsh === c.hash) { T.stats.skipped++; return false; }
  c.hash = hsh;
  prepCache(c.x0, c.z0);
  nv = 0;
  let minY = 1e9, maxY = -1e9;
  for (let z = c.z0; z < c.z1; z++)
    for (let x = c.x0; x < c.x1; x++) {
      const i = z * W + x, lv = S.height[i];
      emitTile(x, z);
      const y = lv * STEP;
      if (y < minY) minY = y;
      const top = S.road[i] && lv < SEA ? DECK_Y : y;
      if (top > maxY) maxY = top;
    }
  if (c.x0 === 0 || c.z0 === 0 || c.x1 === W || c.z1 === H) minY = SKIRT_Y;
  c.minY = minY - 0.05;
  c.maxY = maxY + 0.3;
  const quads = nv >> 2;
  const ib = VC.gfx.quadIndexBuffer(quads); // (unbinds VAOs) — call before binding ours
  if (!c.vao) {
    c.vao = gl.createVertexArray();
    c.vbo = gl.createBuffer();
    gl.bindVertexArray(c.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.SHORT, false, 12, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 4, gl.UNSIGNED_BYTE, 12, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  } else {
    gl.bindVertexArray(c.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  }
  gl.bufferData(gl.ARRAY_BUFFER, U8.subarray(0, nv * 12), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  T.stats.quads += quads - c.quads;
  c.quads = quads;
  T.stats.rebuilt++;
  return true;
}

/** Rebuilds dirty chunks: everything after a reset, otherwise nearest-first within the time budget. */
function process() {
  const G = VC.gfx, st = VC.state;
  if (!st || T._frame === G.frameCount) return;
  T._frame = G.frameCount;
  if (!T.dirty.length) return;
  bindState(st);
  const t0 = performance.now();
  const list = T.dirty;
  if (T.full) {
    for (const c of list) buildChunk(c);
    list.length = 0;
    T.full = false;
    T.stats.fullMs = performance.now() - t0;
    return;
  }
  if (list.length > 1) {
    const cam = VC.camera;
    for (const c of list) c.dist = Math.hypot((c.x0 + c.x1) / 2 - cam.tx, (c.z0 + c.z1) / 2 - cam.tz);
    list.sort((a, b) => a.dist - b.dist);
  }
  let n = 0;
  while (n < list.length) {
    const t1 = performance.now();
    if (buildChunk(list[n])) T.stats.maxChunkMs = Math.max(T.stats.maxChunkMs * 0.98, performance.now() - t1);
    n++;
    if (performance.now() - t0 > T.budgetMs) break;
  }
  list.splice(0, n);
  T.stats.lastMs = performance.now() - t0;
}

/* ------------------------------------------------------------------ */
/* Diorama plinth (wooden base ring around the slab)                   */
/* ------------------------------------------------------------------ */
function buildPlinth(st) {
  const gl = VC.gfx.gl;
  const w = st.W, h = st.H, p = PLINTH, yb = SKIRT_Y - 0.32, th = 0.44;
  nv = 0;
  aB = 0; aC = 0; aD = 0;
  const ring = (x0, z0, x1, z1, faces) => prism(x0, z0, x1, z1, yb, yb, yb, yb, th, faces | 16, K.PLINTH, K.PLINTH, 2);
  ring(-p, -p, w + p, 0, 1 | 2 | 8);
  ring(-p, h, w + p, h + p, 1 | 2 | 4);
  ring(-p, 0, 0, h, 2);
  ring(w, 0, w + p, h, 1);
  if (!T.plinth) {
    T.plinth = { vao: gl.createVertexArray(), vbo: gl.createBuffer(), quads: 0 };
  }
  const quads = nv >> 2;
  const ib = VC.gfx.quadIndexBuffer(quads);
  gl.bindVertexArray(T.plinth.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, T.plinth.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, U8.slice(0, nv * 12), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.SHORT, false, 12, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribIPointer(1, 4, gl.UNSIGNED_BYTE, 12, 8);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bindVertexArray(null);
  T.plinth.quads = quads;
}

/* ------------------------------------------------------------------ */
/* Drawing + frustum culling                                            */
/* ------------------------------------------------------------------ */
const PL = new Float32Array(24);
const visible = [];
function extractPlanes(m) {
  const r = [
    m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12],
    m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12],
    m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13],
    m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13],
    m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14],
    m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14],
  ];
  for (let i = 0; i < 24; i++) PL[i] = r[i];
}
function boxVisible(x0, y0, z0, x1, y1, z1) {
  for (let p = 0; p < 24; p += 4) {
    const a = PL[p], b = PL[p + 1], c = PL[p + 2], d = PL[p + 3];
    if (a * (a > 0 ? x1 : x0) + b * (b > 0 ? y1 : y0) + c * (c > 0 ? z1 : z0) + d < 0) return false;
  }
  return true;
}

function draw(ctx, shadow) {
  const gl = ctx.gl;
  if (!T.chunks.length) return;
  // uViewProj of the current pass (the light's matrix during the shadow pass) lives in frameData[0..15]
  extractPlanes(VC.gfx.frameData);
  visible.length = 0;
  const cp = ctx.cam.pos;
  for (const c of T.chunks) {
    if (!c.quads || !c.vao) continue;
    if (!boxVisible(c.x0, c.minY, c.z0, c.x1, c.maxY, c.z1)) continue;
    c.dist = (c.x0 + CH * 0.5 - cp[0]) ** 2 + (c.z0 + CH * 0.5 - cp[2]) ** 2;
    visible.push(c);
  }
  if (!shadow) visible.sort((a, b) => a.dist - b.dist); // front to back for early-z
  const prog = shadow ? T.progShadow : T.prog;
  prog.use();
  for (const c of visible) {
    gl.bindVertexArray(c.vao);
    gl.drawElements(gl.TRIANGLES, c.quads * 6, gl.UNSIGNED_INT, 0);
  }
  if (!shadow) {
    T.stats.drawn = visible.length;
    if (T.plinth && T.plinth.quads) {
      gl.bindVertexArray(T.plinth.vao);
      gl.drawElements(gl.TRIANGLES, T.plinth.quads * 6, gl.UNSIGNED_INT, 0);
    }
  }
  gl.bindVertexArray(null);
}

/* ------------------------------------------------------------------ */
/* Shaders                                                              */
/* ------------------------------------------------------------------ */
const VS = `
layout(location=0) in vec4 aP;
layout(location=1) in uvec4 aI;
out vec3 vWp; out float vTop; flat out uvec4 vI;
void main(){
  vec3 p = aP.xyz * (1.0 / 64.0);
  vWp = p; vTop = aP.w * (1.0 / 64.0); vI = aI;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

const VS_SHADOW = `
layout(location=0) in vec4 aP;
void main(){ gl_Position = uViewProj * vec4(aP.xyz * (1.0 / 64.0), 1.0); }`;

const FS_SHADOW = `
out vec4 fragColor;
void main(){ fragColor = vec4(1.0); }`;

const FS = `
in vec3 vWp; in float vTop; flat in uvec4 vI;
out vec4 fragColor;

const vec3 NRM[10] = vec3[10](vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1),
  vec3(-0.2425,0.9701,0.0), vec3(0.2425,0.9701,0.0), vec3(0.0,0.9701,-0.2425), vec3(0.0,0.9701,0.2425));
const float SW_ST = 0.140625, SW_AV = 0.09375;

float gPx; // world size of one pixel (set in main, used for texture LOD / AA)

/** Integer lattice hash -> [0,1): pattern-free on voxel grids (floor(c) is hashed). */
float ih(vec2 c){
  uvec2 q = uvec2(ivec2(floor(c)) + 65536);
  uint h = (q.x * 0x27d4eb2du) ^ ((q.y + 0x9e3779b9u) * 0x165667b1u);
  h ^= h >> 15u; h *= 0x2c1b3c6du; h ^= h >> 12u; h *= 0x297a2d39u; h ^= h >> 15u;
  return float(h >> 8u) * (1.0 / 16777216.0);
}
/** Noise texture sampled with an explicit LOD (safe inside divergent branches). */
vec4 tn(vec2 p, float s){ return textureLod(uNoiseTex, p * s, max(0.0, log2(gPx * s * 256.0))); }
float bnd(float x, float a, float b, float w){ return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x)); }

/* ---------------- seasons ---------------- */
float seasonF(){ return mod(uMisc.y, 4.0); }
vec3 seasonGrass(){
  float s = seasonF();
  vec3 sp = vec3(0.42, 0.66, 0.26), su = vec3(0.36, 0.58, 0.22), au = vec3(0.54, 0.55, 0.25), wi = vec3(0.5, 0.5, 0.35);
  return s < 1.0 ? mix(sp, su, s) : s < 2.0 ? mix(su, au, s - 1.0) : s < 3.0 ? mix(au, wi, s - 2.0) : mix(wi, sp, s - 3.0);
}
float autumnAmt(){ float s = seasonF(); return smoothstep(1.3, 2.0, s) * (1.0 - smoothstep(2.7, 3.2, s)); }
float flowerAmt(){ float s = seasonF(); return s < 2.0 ? smoothstep(0.0, 0.3, s) * (1.0 - smoothstep(1.3, 1.9, s)) : smoothstep(3.6, 4.0, s); }

/* ---------------- materials (sRGB albedo) ---------------- */
vec3 grassCol(vec2 cell, vec2 p, bool meadow, float fade){
  vec3 g = seasonGrass();
  vec4 nb = tn(p, 0.017), nm = tn(p + 3.1, 0.07);
  g *= 0.84 + 0.32 * nb.r;
  g = mix(g, g * vec3(1.16, 1.05, 0.62), smoothstep(0.55, 0.85, nm.g) * 0.55);
  g = mix(g, g * vec3(0.78, 0.95, 0.85), smoothstep(0.6, 0.8, nb.b) * 0.45);
  float h = ih(cell), h2 = ih(cell + 174.0);
  g *= 1.0 + (h - 0.5) * 0.2 * fade;
  g = mix(g, g * 0.74, step(0.92, h2) * fade);
  g = mix(g, g * 1.17, step(h2, 0.05) * fade);
  if (meadow) {
    g = mix(g, g * vec3(1.1, 1.08, 0.8), 0.35);
    float fl = step(0.95, h2) * fade * max(flowerAmt(), 0.15);
    vec3 fc = h < 0.3 ? vec3(0.98, 0.84, 0.22) : h < 0.55 ? vec3(0.98, 0.97, 0.94) : h < 0.8 ? vec3(0.93, 0.45, 0.66) : vec3(0.62, 0.42, 0.9);
    g = mix(g, fc, fl);
  } else {
    g = mix(g, vec3(0.98, 0.9, 0.3), step(0.993, h2) * fade * flowerAmt());
  }
  g = mix(g, vec3(0.78, 0.4, 0.12), step(0.955, ih(cell + 211.0)) * fade * autumnAmt() * 0.9);
  return g;
}
vec3 sandCol(vec2 cell, float fade){
  vec2 c = (cell + 0.5) * 0.125;
  float r = sin(dot(c, vec2(2.3, 3.9)) * 4.0 + tn(c, 0.043).r * 9.0);
  vec3 s = vec3(0.84, 0.76, 0.55) * (0.95 + 0.05 * r * fade);
  s *= 1.0 + (ih(cell) - 0.5) * 0.08 * fade;
  s = mix(s, vec3(0.97, 0.95, 0.9), step(0.975, ih(cell + 248.0)) * fade);
  s = mix(s, vec3(0.62, 0.56, 0.46), step(0.986, ih(cell + 285.0)) * fade);
  return s;
}
vec3 dirtCol(vec2 cell, vec2 p, float fade){
  vec3 d = vec3(0.5, 0.38, 0.26) * (0.86 + 0.28 * tn(p + 0.7, 0.05).g);
  d *= 1.0 + (ih(cell) - 0.5) * 0.18 * fade;
  d = mix(d, vec3(0.57, 0.47, 0.36), step(0.95, ih(cell + 322.0)) * fade);
  d = mix(d, seasonGrass() * 0.9, step(0.9, ih(cell + 359.0)) * fade * 0.8);
  return d;
}
vec3 rockCol(vec2 cell, float fade){
  vec2 c = (cell + 0.5) * 0.125;
  vec3 r = vec3(0.53, 0.51, 0.48) * (0.82 + 0.3 * tn(c, 0.06).b);
  r *= 1.0 + (ih(cell) - 0.5) * 0.16 * fade;
  float cn = tn(c + 0.3, 0.21).g;
  r *= 1.0 - (1.0 - smoothstep(0.0, 0.04, abs(cn - 0.5))) * 0.45 * fade;
  r = mix(r, vec3(0.46, 0.53, 0.33), smoothstep(0.6, 0.72, tn(c + 0.7, 0.13).a) * 0.45);
  return r;
}
vec3 snowCol(vec2 cell, float fade){
  vec2 p = (cell + 0.5) * 0.125;
  return vec3(0.9, 0.93, 0.98) * (0.93 + 0.07 * tn(p, 0.07).b) * (0.96 + 0.06 * ih(cell + 396.0) * fade);
}
float sparkle(vec2 cell, vec3 V, float fade){ return step(0.992, hash13(vec3(cell, floor(dot(V, vec3(23.0, 17.0, 29.0)))))) * fade; }

vec3 terrainTop(uint terr, vec2 cell, vec2 p, float fade){
  if (terr == 1u) return sandCol(cell, fade);
  if (terr == 2u) return dirtCol(cell, p, fade);
  if (terr == 3u) return rockCol(cell, fade);
  if (terr == 4u) return snowCol(cell, fade);
  return grassCol(cell, p, terr == 5u, fade);
}
vec3 seabed(uint terr, vec2 cell, vec2 p, float depth, float fade){
  vec3 s = terr == 1u ? sandCol(cell, fade) * vec3(0.84, 0.88, 0.78) : vec3(0.36, 0.38, 0.26) * (0.85 + 0.3 * tn(p, 0.05).r);
  s *= 1.0 + (ih(cell) - 0.5) * 0.12 * fade;
  float wd = smoothstep(0.55, 0.75, tn(p + 0.2, 0.09).b);
  s = mix(s, vec3(0.2, 0.38, 0.2), wd * 0.7 * step(0.3, ih(cell + 433.0)));
  s *= mix(0.95, 0.55, smoothstep(0.1, 1.2, depth));
  return s * vec3(0.84, 0.97, 0.92);
}
/** Colour of the top material where it wraps over a cliff edge. */
vec3 lipCol(uint terr, vec2 cell, vec2 p, float fade){
  if (terr == 1u) return sandCol(cell, fade);
  if (terr == 3u) return rockCol(cell, fade);
  if (terr == 4u) return snowCol(cell, fade);
  if (terr == 2u) return dirtCol(cell, p, fade);
  return seasonGrass() * (0.9 + 0.2 * ih(cell + 470.0) * fade);
}
/** Stratified soil / rock on vertical faces: bands every 2 voxels, darker toward the slab bottom. */
vec3 sideCol(vec3 wp, float topY, uint terr, uint road, vec2 cell, float fade){
  float below = topY - wp.y;
  float band = floor(wp.y * 4.0 + 0.001);
  float bh = hash11(band * 0.618 + 3.1);
  vec3 soil = bh < 0.25 ? vec3(0.49, 0.35, 0.23) : bh < 0.5 ? vec3(0.57, 0.43, 0.29) : bh < 0.75 ? vec3(0.43, 0.32, 0.24) : vec3(0.63, 0.51, 0.36);
  vec3 stone = mix(vec3(0.44, 0.43, 0.41), vec3(0.57, 0.55, 0.51), bh);
  float rocky = smoothstep(1.4, -0.4, wp.y);
  if (terr == 3u || terr == 4u) rocky = max(rocky, 0.8);
  vec3 col = mix(soil, stone, rocky);
  if (terr == 1u) col = mix(col, vec3(0.8, 0.71, 0.5), smoothstep(0.75, 0.1, below) * (1.0 - rocky));
  float soilTop = (terr == 0u || terr == 5u || terr == 2u) ? 1.0 : 0.0;
  col = mix(col, vec3(0.34, 0.24, 0.16), smoothstep(0.42, 0.18, below) * (1.0 - rocky) * soilTop);
  col *= 1.0 + (ih(cell) - 0.5) * 0.16 * fade;
  col = mix(col, stone * 1.08, step(0.955, ih(cell + 507.0)) * fade * (1.0 - rocky));
  float bf = fract(wp.y * 4.0);
  col *= 1.0 - 0.13 * (1.0 - smoothstep(0.0, 0.14, bf)) * fade;
  col *= mix(0.4, 1.0, smoothstep(-3.0, 1.3, wp.y));
  if (road > 0u) {
    if (below < 0.07) col = vec3(0.21, 0.215, 0.23);
    else if (below < 0.16) col = vec3(0.5, 0.48, 0.45) * (0.9 + 0.2 * ih(cell));
  } else {
    float lipH = 0.125 * (1.0 + step(0.62, ih(vec2(cell.x, 5.0)))) + SNOW * 0.07;
    if (below < lipH) {
      col = lipCol(terr, cell, wp.xz, fade);
      if (SNOW > 0.2 && terr != 1u) col = mix(col, snowCol(cell, fade), smoothstep(0.2, 0.6, SNOW));
    }
  }
  return col;
}

/* ---------------- effects ---------------- */
float caustic(vec2 p){
  float t = TIME * 0.05;
  float a = tn(p + vec2(t, t * 0.7) * 11.0, 0.09).g;
  float b = tn(p * 1.37 - vec2(t * 0.8, -t * 0.4) * 11.0 + 5.0, 0.09).g;
  return pow(1.0 - smoothstep(0.0, 0.07, abs(a - b)), 3.0);
}
float topAO(vec2 uv, uint m){
  float a = 1.0;
  const float R = 0.34;
  if ((m & 1u) != 0u) a *= mix(0.58, 1.0, smoothstep(0.0, R, 1.0 - uv.x));
  if ((m & 2u) != 0u) a *= mix(0.58, 1.0, smoothstep(0.0, R, uv.x));
  if ((m & 4u) != 0u) a *= mix(0.58, 1.0, smoothstep(0.0, R, 1.0 - uv.y));
  if ((m & 8u) != 0u) a *= mix(0.58, 1.0, smoothstep(0.0, R, uv.y));
  if ((m & 16u) != 0u) a *= mix(0.65, 1.0, smoothstep(0.0, R, length(1.0 - uv)));
  if ((m & 32u) != 0u) a *= mix(0.65, 1.0, smoothstep(0.0, R, length(vec2(uv.x, 1.0 - uv.y))));
  if ((m & 64u) != 0u) a *= mix(0.65, 1.0, smoothstep(0.0, R, length(vec2(1.0 - uv.x, uv.y))));
  if ((m & 128u) != 0u) a *= mix(0.65, 1.0, smoothstep(0.0, R, length(uv)));
  return a;
}
/** Warm street-lamp light pools (tiles with x+z even; mid-points of open sidewalks). */
float lampPool(vec2 uv, uint mask, uint road, vec2 tile){
  if (((uint(tile.x) + uint(tile.y)) & 1u) != 0u) return 0.0;
  if (road == 3u) {
    if (mask != 3u && mask != 12u) return 0.0;
    vec2 d = uv - 0.5; d *= mask == 3u ? vec2(0.7, 1.4) : vec2(1.4, 0.7);
    return exp(-dot(d, d) * 9.0);
  }
  float h = (road == 1u ? SW_ST : SW_AV) * 0.5, p = 0.0;
  vec2 d;
  if ((mask & 1u) == 0u) { d = uv - vec2(1.0 - h, 0.5); p += exp(-dot(d, d) * 14.0); }
  if ((mask & 2u) == 0u) { d = uv - vec2(h, 0.5); p += exp(-dot(d, d) * 14.0); }
  if ((mask & 4u) == 0u) { d = uv - vec2(0.5, 1.0 - h); p += exp(-dot(d, d) * 14.0); }
  if ((mask & 8u) == 0u) { d = uv - vec2(0.5, h); p += exp(-dot(d, d) * 14.0); }
  return min(p, 1.2);
}
/** Painted line from the tile centre toward connection d at lateral offset off (half width hw). */
float seg(vec2 uv, vec2 wxz, uint d, float off, float hw, float to, float dashF, float aa){
  float along = d == 0u ? uv.x - 0.5 : d == 1u ? 0.5 - uv.x : d == 2u ? uv.y - 0.5 : 0.5 - uv.y;
  float lat = d < 2u ? uv.y - 0.5 : uv.x - 0.5;
  float cov = bnd(along, -hw, to, aa) * bnd(lat, off - hw, off + hw, aa);
  if (dashF > 0.0) cov *= step(0.5, fract((d < 2u ? wxz.x : wxz.y) * dashF));
  return cov;
}
/** Zebra crossing at the edge toward d + stop line on the approaching lane (right-hand traffic). */
float crossing(vec2 uv, uint d, float sw, float aa){
  float e = d == 0u ? 1.0 - uv.x : d == 1u ? uv.x : d == 2u ? 1.0 - uv.y : uv.y;
  float q = d < 2u ? uv.y : uv.x;
  float stripes = smoothstep(0.25 - aa * 9.0, 0.25 + aa * 9.0, abs(fract(q * 9.0) - 0.5));
  float cw = bnd(e, 0.035, 0.2, aa) * bnd(q, sw + 0.025, 1.0 - sw - 0.025, aa) * stripes;
  float side = d == 0u ? uv.y - 0.5 : d == 1u ? 0.5 - uv.y : d == 2u ? 0.5 - uv.x : uv.x - 0.5;
  float stp = bnd(e, 0.235, 0.26, aa) * bnd(side, 0.0, 0.5 - sw - 0.012, aa);
  return max(cw, stp);
}
/** Paved / lawn lot base under buildings, by zone. */
vec3 lotBase(vec3 alb, uint zc, vec2 uv, vec2 p, float fade, float aa){
  uint zt = zc >> 2u, den = zc & 3u;
  vec2 f = abs(fract(p * 4.0) - 0.5);
  float joint = 1.0 - smoothstep(0.003, 0.003 + aa, (0.5 - max(f.x, f.y)) * 0.25);
  float sl = ih(floor(p * 4.0));
  vec3 lawn = seasonGrass() * (0.95 + 0.1 * step(0.5, fract(p.x * 2.0))) * (1.0 + (ih(floor(p * 8.0)) - 0.5) * 0.1 * fade);
  vec3 pv = (zt == 3u ? vec3(0.55, 0.54, 0.51) : zt == 2u ? vec3(0.67, 0.65, 0.61) : vec3(0.72, 0.7, 0.66)) * (0.94 + 0.1 * sl);
  pv *= 1.0 - joint * 0.2 * fade;
  if (zt == 3u) pv = mix(pv, pv * 0.7, smoothstep(0.62, 0.7, tn(p, 0.3).b) * 0.6);
  if (zt == 1u && den == 1u) return lawn;
  if (zt == 1u && den == 2u) {
    float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    return mix(pv, lawn, smoothstep(0.12, 0.12 + aa, e));
  }
  return pv;
}

void main(){
  uint nIdx = vI.x & 15u, kind = vI.x >> 4u;
  uint terr = vI.y & 7u, road = (vI.y >> 3u) & 3u;
  uint mask = vI.z & 15u, nbi = vI.z >> 4u;
  vec3 n = NRM[nIdx];
  vec3 wp = vWp;
  vec3 V = normalize(uCamPos.xyz - wp);
  gPx = length(fwidth(wp)) + 1e-5;
  float aa = gPx * 0.6;
  float fade = 1.0 - smoothstep(0.07, 0.26, gPx);
  vec2 tileF = floor(wp.xz - n.xz * 0.02);
  vec2 uv = wp.xz - tileF;
  bool top = n.y > 0.5;
  bool under = wp.y < SEA_Y - 0.01;
  vec2 cellT = floor(wp.xz * 8.0);
  vec2 cell = top ? cellT : floor(vec2(dot(wp.xz, abs(n.zx)) * 8.0, wp.y * 8.0));
  vec4 td = texelFetch(uTileTex, ivec2(clamp(tileF, vec2(0.0), uMap.xy - 1.0)), 0);
  uint tfl = uint(td.b * 255.0 + 0.5), zc = uint(td.a * 255.0 + 0.5);

  vec3 alb = vec3(0.5), emis = vec3(0.0);
  float ao = 1.0, snowF = 0.0, wetP = 0.0, gut = 1.0, pool = 0.0, metal = 0.0, ovA = 0.0, decA = 0.0;
  vec3 decCol = vec3(0.0);

  if (kind == 0u) { // ---------------- terrain & seabed tops
    if (under) alb = seabed(terr, cell, wp.xz, SEA_Y - wp.y, fade);
    else {
      alb = terrainTop(terr, cell, wp.xz, fade);
      if ((tfl & 8u) != 0u) alb = lotBase(alb, zc, uv, wp.xz, fade, aa);
      else if (zc > 0u) {
        uint zt = zc >> 2u, den = zc & 3u;
        vec3 zcol = zt == 1u ? vec3(0.224, 0.851, 0.541) : zt == 2u ? vec3(0.247, 0.655, 1.0) : vec3(1.0, 0.784, 0.239);
        float ga = uMisc.w;
        // planned lot: cleared, calm lawn tinted in the zone colour
        if (terr == 0u || terr == 2u || terr == 5u) {
          vec3 lawn = seasonGrass() * (0.94 + 0.08 * tn(wp.xz, 0.05).r) * (1.0 + (ih(cell + 655.0) - 0.5) * 0.08 * fade);
          alb = mix(alb, lawn, 0.8);
        }
        alb = mix(alb, zcol, 0.1 + 0.2 * ga);
        // dashed inset border with solid corners + 1..3 density markers (applied after snow)
        float ex = min(uv.x, 1.0 - uv.x), ez = min(uv.y, 1.0 - uv.y), e = min(ex, ez);
        float da = abs((ex < ez ? uv.y : uv.x) - 0.5);
        float border = bnd(e, 0.05, 0.078, aa) * ((da < 0.14 || da > 0.31) ? 1.0 : 0.0);
        float mkr = 0.0;
        for (uint q = 0u; q < 3u; q++) {
          if (q >= den) break;
          vec2 dd = abs(uv - vec2(0.5 + (float(q) - (float(den) - 1.0) * 0.5) * 0.2, 0.5));
          mkr = max(mkr, 1.0 - smoothstep(0.06, 0.06 + aa, max(dd.x, dd.y)));
        }
        decA = max(border * (0.6 + 0.35 * ga), mkr * (0.75 + 0.2 * ga));
        decCol = mkr > border ? zcol : zcol * 0.85;
        emis += srgb2lin(zcol) * (border * 0.35 + mkr * 0.7) * (0.04 + 0.96 * ga) * (0.35 + NIGHT);
      }
      snowF = 1.0;
      wetP = (terr == 1u || terr == 4u) ? 0.0 : 0.55;
      ovA = 0.85;
    }
    ao = topAO(uv, vI.w);
  } else if (kind == 1u) { // ---------------- road surface (land, ramps, bridge decks)
    float sw = road == 1u ? SW_ST : road == 2u ? SW_AV : 0.0;
    uint cnt = (mask & 1u) + ((mask >> 1u) & 1u) + ((mask >> 2u) & 1u) + ((mask >> 3u) & 1u);
    bool inter = cnt >= 3u, straight = mask == 3u || mask == 12u;
    float dk = 9.0;
    if ((mask & 1u) == 0u) dk = min(dk, 1.0 - uv.x);
    if ((mask & 2u) == 0u) dk = min(dk, uv.x);
    if ((mask & 4u) == 0u) dk = min(dk, 1.0 - uv.y);
    if ((mask & 8u) == 0u) dk = min(dk, uv.y);
    if (road != 3u) {
      if ((mask & 5u) == 5u) dk = min(dk, max(1.0 - uv.x, 1.0 - uv.y));
      if ((mask & 6u) == 6u) dk = min(dk, max(uv.x, 1.0 - uv.y));
      if ((mask & 9u) == 9u) dk = min(dk, max(1.0 - uv.x, uv.y));
      if ((mask & 10u) == 10u) dk = min(dk, max(uv.x, uv.y));
    }
    gut = dk - sw;
    if (road == 3u) {
      alb = vec3(0.6, 0.59, 0.56) * (0.9 + 0.15 * tn(wp.xz, 0.21).r);
      vec2 jf = fract(wp.xz * 2.0);
      float jd = min(min(jf.x, 1.0 - jf.x), min(jf.y, 1.0 - jf.y)) * 0.5;
      alb *= 1.0 - (1.0 - smoothstep(0.004, 0.004 + aa, jd)) * 0.22 * fade;
      alb *= 1.0 + (ih(floor(wp.xz * 2.0)) - 0.5) * 0.07;
      alb *= 1.0 + (ih(cell) - 0.5) * 0.05 * fade;
    } else {
      alb = vec3(0.235, 0.24, 0.255) * (0.86 + 0.24 * tn(wp.xz, 0.17).r);
      alb *= 1.0 + (ih(cell) - 0.5) * 0.12 * fade;
      alb = mix(alb, alb * 0.86, smoothstep(0.64, 0.68, tn(wp.xz + 0.4, 0.09).g) * 0.5);
      alb = mix(alb, vec3(0.34, 0.34, 0.35), step(0.985, ih(cell + 544.0)) * fade * 0.6);
    }
    alb *= mix(0.78, 1.0, smoothstep(0.0, 0.07, gut));
    if (inter) alb *= 0.97 - 0.07 * smoothstep(0.35, 0.0, length(uv - 0.5));
    float mk = 0.0, mky = 0.0;
    if (!inter && cnt > 0u) {
      for (uint d = 0u; d < 4u; d++) {
        if ((mask & (1u << d)) == 0u) continue;
        bool app = ((nbi >> d) & 1u) != 0u;
        float to = app ? 0.21 : 0.5 + aa;
        if (road == 1u) mky = max(mky, seg(uv, wp.xz, d, 0.0, 0.013, to, 3.0, aa));
        else if (road == 2u) {
          mk = max(mk, max(seg(uv, wp.xz, d, 0.215, 0.009, to, 3.0, aa), seg(uv, wp.xz, d, -0.215, 0.009, to, 3.0, aa)));
          if (!straight) mky = max(mky, max(seg(uv, wp.xz, d, 0.022, 0.007, to, 0.0, aa), seg(uv, wp.xz, d, -0.022, 0.007, to, 0.0, aa)));
        } else {
          mky = max(mky, max(seg(uv, wp.xz, d, 0.02, 0.008, 0.5 + aa, 0.0, aa), seg(uv, wp.xz, d, -0.02, 0.008, 0.5 + aa, 0.0, aa)));
          mk = max(mk, max(seg(uv, wp.xz, d, 0.25, 0.008, 0.5 + aa, 2.0, aa), seg(uv, wp.xz, d, -0.25, 0.008, 0.5 + aa, 2.0, aa)));
        }
        if (road != 3u && app) mk = max(mk, crossing(uv, d, sw, aa));
      }
    }
    if (road == 3u) mk = max(mk, bnd(dk, 0.07, 0.088, aa));
    float wear = 0.72 + 0.28 * tn(wp.xz, 0.45).a;
    alb = mix(alb, vec3(0.92, 0.91, 0.87), mk * 0.92 * wear);
    alb = mix(alb, vec3(0.93, 0.74, 0.2), mky * 0.9 * wear);
    alb = mix(alb, vec3(0.43, 0.42, 0.41), SNOW * 0.25);
    snowF = max(1.0 - smoothstep(0.01, 0.1, gut), 0.25 * tn(wp.xz, 0.6).r);
    pool = lampPool(uv, mask, road, tileF);
    wetP = 1.0;
    ovA = 0.5;
    ao = topAO(uv, vI.w);
  } else if (kind == 2u) { // ---------------- cliffs, seabed steps, diorama skirt
    alb = sideCol(wp, vTop, terr, road, cell, fade);
    float by = vI.w == 255u ? ${SKIRT_Y.toFixed(1)} : float(vI.w) * 0.25;
    ao = mix(0.55, 1.0, smoothstep(0.0, 0.32, wp.y - by));
    if (under) alb *= vec3(0.8, 0.93, 0.88) * mix(0.9, 0.6, smoothstep(0.0, 1.2, SEA_Y - wp.y));
  } else if (kind == 3u) { // ---------------- sidewalk
    vec2 sl = floor(wp.xz * 4.0);
    alb = vec3(0.7, 0.69, 0.66) * (0.93 + 0.1 * ih(sl)) * (0.92 + 0.12 * tn(wp.xz, 0.23).g);
    alb *= 1.0 + (ih(cell) - 0.5) * 0.06 * fade;
    vec2 f = abs(fract(wp.xz * 4.0) - 0.5);
    alb *= 1.0 - (1.0 - smoothstep(0.003, 0.003 + aa, (0.5 - max(f.x, f.y)) * 0.25)) * 0.2 * fade;
    pool = lampPool(uv, mask, road, tileF);
    snowF = 0.85; wetP = 0.7; ovA = 0.6;
  } else if (kind == 4u) { // ---------------- kerb faces
    alb = vec3(0.76, 0.75, 0.72) * (1.0 + (ih(cell) - 0.5) * 0.08 * fade);
    ao = 0.85;
    snowF = 0.6;
  } else if (kind == 5u) { // ---------------- green median
    float h = ih(cell);
    alb = seasonGrass() * 0.92 * (1.0 + (h - 0.5) * 0.25 * fade);
    alb = mix(alb, alb * 0.62, step(0.72, ih(floor(wp.xz * 4.0))));
    alb = mix(alb, vec3(0.95, 0.5, 0.65), step(0.96, h) * flowerAmt() * fade);
    snowF = 1.0; ovA = 0.6;
  } else if (kind == 6u) { // ---------------- highway jersey barrier
    alb = vec3(0.8, 0.79, 0.76) * (1.0 + (ih(cell) - 0.5) * 0.06 * fade);
    if (!top) {
      float along = dot(wp.xz, abs(n.zx)), below = vTop - wp.y;
      alb *= 1.0 - 0.2 * bnd(below, 0.045, 0.058, aa);
      float refl = bnd(below, 0.014, 0.03, aa) * step(fract(along * 2.0), 0.08);
      emis += vec3(1.0, 0.5, 0.08) * refl * (0.25 + NIGHT * 2.5);
    }
    snowF = 1.0;
  } else if (kind == 7u) { // ---------------- bridge railing (painted steel)
    alb = vec3(0.3, 0.5, 0.5);
    metal = 1.0; snowF = 1.0; ao = top ? 1.0 : 0.85;
  } else if (kind == 8u) { // ---------------- bridge deck fascia
    float below = vTop - wp.y;
    alb = vec3(0.68, 0.67, 0.64) * (0.92 + 0.12 * tn(wp.xz + wp.y, 0.3).r);
    alb *= 1.0 - 0.22 * smoothstep(0.05, 0.11, below);
    alb *= 1.0 - 0.15 * bnd(below, 0.012, 0.022, aa);
  } else if (kind == 9u) { // ---------------- bridge piers
    alb = vec3(0.62, 0.61, 0.58) * (0.9 + 0.14 * tn(vec2(wp.x + wp.z, wp.y), 0.4).g);
    alb *= 1.0 + (ih(cell) - 0.5) * 0.08 * fade;
    float wl = wp.y - SEA_Y;
    alb = mix(alb, vec3(0.3, 0.36, 0.27), 1.0 - smoothstep(-0.02, 0.1, wl));
    if (under) alb *= 0.8;
  } else { // ---------------- wooden plinth
    float along = top ? wp.x + wp.z : dot(wp.xz, abs(n.zx));
    float grain = sin(along * 34.0 + tn(vec2(along * 0.3, wp.y * 3.0), 0.2).r * 14.0) * 0.5 + 0.5;
    alb = mix(vec3(0.26, 0.15, 0.08), vec3(0.42, 0.26, 0.14), grain * 0.55 + 0.2);
    if (!top) alb *= mix(0.7, 1.0, smoothstep(${(SKIRT_Y - 0.32).toFixed(2)}, ${(SKIRT_Y + 0.12).toFixed(2)}, wp.y));
    metal = 0.35;
  }

  ao = mix(ao, 1.0, smoothstep(0.12, 0.45, gPx)); // voxel AO only reads up close

  // ---------------- snow cover ----------------
  float snowAmt = 0.0;
  if (SNOW > 0.01 && top && !under && snowF > 0.0) {
    float cover = smoothstep(0.08, 0.32, SNOW * 1.3 - tn(wp.xz, 0.045).g * 0.42 - ih(cellT) * 0.07 * fade + (wp.y - 2.5) * 0.015);
    cover *= snowF;
    alb = mix(alb, snowCol(cellT, fade), cover);
    snowAmt = cover;
  }
  if (kind == 0u && terr == 4u && !under) snowAmt = 1.0;
  alb = mix(alb, decCol, decA); // zone decals stay visible in winter

  // ---------------- rain: darkening + puddles ----------------
  float wetS = WET;
  if (kind == 1u) wetS = max(wetS, SNOW * 0.5);
  if (!under) alb *= 1.0 - (kind == 2u ? 0.15 : 0.3) * wetS * (1.0 - snowAmt);
  float pud = 0.0;
  if (wetP > 0.0 && wetS > 0.05 && n.y > 0.99 && snowAmt < 0.5) {
    float pn = tn(wp.xz + 0.17, 0.11).b;
    float thr = mix(0.9, 0.56, wetS) - (kind == 1u ? 0.1 * (1.0 - smoothstep(0.0, 0.12, gut)) : 0.0);
    pud = smoothstep(thr, thr + 0.025, pn) * smoothstep(0.15, 0.45, wetS) * wetP;
  }

  // ---------------- lighting ----------------
  vec3 albL = srgb2lin(alb);
  vec3 c = shade(albL, n, wp, ao);
  float sheen = (kind == 1u || kind == 3u) ? wetS * 0.6 : 0.0;
  float refl = max(pud, sheen * 0.35);
  if (refl > 0.001 && !under) {
    vec3 pn = n;
    if (pud > 0.01 && WET > 0.05) { // rain ripples
      vec2 rp = wp.xz * 5.0, ci = floor(rp);
      vec2 cf = fract(rp) - 0.5 - (hash22(ci) - 0.5) * 0.5;
      float ph = fract(TIME * 0.9 + hash12(ci)), r = length(cf);
      float ring = sin((r - ph * 0.5) * 60.0) * smoothstep(0.1, 0.0, abs(r - ph * 0.5)) * (1.0 - ph);
      pn = normalize(vec3(cf.x, 0.0, cf.y) * ring * 0.35 * WET + n);
    }
    float fres = 0.03 + 0.97 * pow(1.0 - max(dot(pn, V), 0.0), 5.0);
    c = mix(c, c * 0.55, pud * 0.7);
    c += skyColor(reflect(-V, pn)) * fres * refl * 1.1 + specular(pn, wp, 220.0, 3.0) * refl;
    c += vec3(1.0, 0.7, 0.4) * pool * NIGHT * refl * 0.5;
  }
  if (pool > 0.0) c += albL * vec3(1.0, 0.72, 0.42) * pool * NIGHT * (kind == 3u ? 1.4 : 2.0);
  if (snowAmt > 0.2) c += uSunColor.rgb * uSunDir.w * sparkle(cellT, V, fade) * snowAmt * 2.5;
  if (metal > 0.0) c += specular(n, wp, 60.0, 0.8 * metal);
  if (under) {
    float depth = SEA_Y - wp.y;
    c += albL * uSunColor.rgb * uSunDir.w * caustic(wp.xz + wp.y * 0.3) * 0.55 * exp(-depth * 1.1) * (0.4 + 0.6 * max(n.y, 0.0));
  }

  // ---------------- build grid + hover ----------------
  if (top && !under && kind != 10u) {
    float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    if (uMisc.w > 0.0) {
      float gl = 1.0 - smoothstep(0.0, aa * 1.5 + 0.004, e);
      c = mix(c, c * 0.5 + vec3(0.02, 0.03, 0.04) * (0.3 + NIGHT), gl * uMisc.w * 0.7);
    }
    if (abs(tileF.x - uHover.x) < 0.5 && abs(tileF.y - uHover.y) < 0.5) {
      float glow = exp(-e * 26.0) * 0.9 + 0.08;
      emis += vec3(0.45, 0.85, 1.0) * glow * (0.85 + 0.15 * sin(TIME * 6.0)) * 1.4;
    }
  }
  c += emis;

  // ---------------- data overlay: smooth heatmap between tile centres ----------------
  if (uMap.w > 0.0 && ovA > 0.0) {
    float kindR = uHover.w, v;
    bool show = true;
    if (kindR > 2.5) { v = td.g; show = v > 0.0; }
    else {
      vec2 p = wp.xz - 0.5, i0 = floor(p), f = p - i0;
      f = f * f * (3.0 - 2.0 * f);
      vec2 lo = clamp(i0, vec2(0.0), uMap.xy - 1.0), hi = clamp(i0 + 1.0, vec2(0.0), uMap.xy - 1.0);
      float v00 = texelFetch(uTileTex, ivec2(lo), 0).g, v10 = texelFetch(uTileTex, ivec2(hi.x, lo.y), 0).g;
      float v01 = texelFetch(uTileTex, ivec2(lo.x, hi.y), 0).g, v11 = texelFetch(uTileTex, ivec2(hi), 0).g;
      v = mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
    }
    if (show) {
      vec3 oc = srgb2lin(overlayRamp(v, kindR));
      // follow scene exposure by day, stay readable at night
      vec3 amb = mix(uGroundAmb.rgb, uSkyAmb.rgb, 0.5 + 0.5 * n.y);
      float lum = dot(amb + uSunColor.rgb * max(dot(n, uSunDir.xyz), 0.0) * uSunDir.w * 0.75, vec3(0.3, 0.55, 0.15));
      float q = abs(fract(v * 10.0) - 0.5);
      float line = kindR > 2.5 ? 0.0 : 1.0 - smoothstep(0.0, 0.06, 0.5 - q);
      vec3 ocol = oc * max(lum, 0.55) * 0.8 * (1.0 - line * 0.3);
      c = mix(c, ocol, uMap.w * ovA * 1.1);
    }
  }

  c = applyFog(c, wp);
  fragColor = vec4(c, 1.0);
}`;
