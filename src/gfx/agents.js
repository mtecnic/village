/*
 * VOXELPOLIS — moving agents (VC.agents). Opaque layer 'agents' (order 200, + shadow pass) and an
 * additive glow layer 'agents_glow' (order 650, after water/particles so lights over water survive).
 *
 * ROAD VEHICLES (this file): cars, taxis, buses, trucks, tankers, garbage trucks, police patrols and
 * dispatched emergency vehicles, as instanced voxel models (VC.models 'car', 'bus', ... drawn through
 * VC.fxgl.modelBatch). Movement is per tile on the road graph:
 *   - a vehicle crossing tile T enters on the edge opposite its travel direction and leaves through the
 *     chosen exit edge; the path inside the tile is a cubic Bezier between lane points, so straight runs,
 *     turns, lane changes and dead-end U-turns are all smooth and tangent-continuous across tiles
 *   - right-hand traffic; streets have 1 lane each way, avenues/highways 2 (turning lanes chosen by intent)
 *   - next direction: weighted random among connected neighbours (busier tiles and going straight
 *     preferred, U-turns only at dead ends); connectivity mirrors the terrain's road rules (|Δlevel| <= 1,
 *     ramps, bridges) or uses VC.terrain.roadInfo when available
 *   - height follows VC.terrain.roadY (ramps, bridge decks) with a local fallback
 *   - car-following: spatial hash per tile, brake behind the vehicle ahead in the same lane; traffic
 *     signals at intersections (VC.agents.signal(x, z) exposes the phase for prop renderers); vehicles
 *     stuck for a while briefly "ghost" through to avoid gridlock
 *   - density ∝ population x time of day x local traffic, capped by quality().cars, spawned / despawned
 *     around the camera target so the density is where the player looks
 *
 * API
 *   dispatch(kind, x, z)   'firetruck' | 'police_car' | 'ambulance' (aliases: fire, police, health):
 *                          sends a vehicle from the nearest matching service building along the roads
 *                          (BFS) with flashing lights + siren; it works on scene, then drives back and
 *                          despawns. Returns a handle id (> 0) or 0 if impossible.
 *   count()                number of moving agents (road + air + sea + birds)
 *   signal(x, z)           traffic-light phase of an intersection tile: -1 none, 0 X-axis green,
 *                          1 X yellow, 2 Z-axis green, 3 Z yellow
 *   vehicles()             debug: array of {kind, x, z, speed, role}
 * Air, sea, birds and balloons live in gfx/fx_air.js (VC.fxAir), updated and drawn from here.
 */
const M = VC.M, C = VC.C;
const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1], OPP = [1, 0, 3, 2];
const RX = [0, 0, -1, 1], RZ = [1, -1, 0, 0]; // right-hand side of travel direction d
const RIGHT_OF = [2, 3, 1, 0], LEFT_OF = [3, 2, 0, 1];
const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
const LANE = [[0.18, 0.18], [0.18, 0.18], [0.125, 0.31], [0.14, 0.34]]; // [road type][lane 0 inner, 1 outer]
const ROAD_SPEED = [1, 1, 1.3, 2.1];
const GAME_SPEED = [0, 1, 1.5, 2.2]; // vehicle speed multiplier per sim speed setting (visual, not 1:1)
const CYCLE = 11, GREEN = 4.8, YELLOW = 0.7; // signal timing (agent seconds)

/* vehicle kinds */
const KIND = [
  { key: 'car', v: 1.0, w: 0.25 },
  { key: 'taxi', v: 1.05, w: 0.25 },
  { key: 'bus', v: 0.8, w: 0.3 },
  { key: 'truck', v: 0.8, w: 0.3 },
  { key: 'police_car', v: 1.05, w: 0.25 },
  { key: 'firetruck', v: 0.95, w: 0.3 },
  { key: 'ambulance', v: 1.0, w: 0.28 },
  { key: 'garbage_truck', v: 0.7, w: 0.3 },
  { key: 'tanker', v: 0.8, w: 0.3 },
];
const K = { car: 0, taxi: 1, bus: 2, truck: 3, police: 4, fire: 5, ambulance: 6, garbage: 7, tanker: 8 };
const SERVICE = {
  firetruck: { kind: K.fire, keys: ['fire_station', 'fire_hq'] },
  police_car: { kind: K.police, keys: ['police_station', 'police_hq'] },
  ambulance: { kind: K.ambulance, keys: ['clinic', 'hospital'] },
};
const ALIAS = { fire: 'firetruck', fire_truck: 'firetruck', firetruck: 'firetruck', police: 'police_car', police_car: 'police_car', health: 'ambulance', ambulance: 'ambulance', medical: 'ambulance' };

/* roles */
const R_TRAFFIC = 0, R_DISPATCH = 1, R_PATROL = 2;
/* dispatch states */
const D_GO = 0, D_SCENE = 1, D_BACK = 2;

/* ---------------- vehicle SoA ---------------- */
const CAP = 1200;
const alive = new Uint8Array(CAP), kind = new Uint8Array(CAP), role = new Uint8Array(CAP), vstate = new Uint8Array(CAP);
const tile = new Int32Array(CAP), din = new Uint8Array(CAP), dout = new Uint8Array(CAP), lane = new Uint8Array(CAP);
const tt = new Float32Array(CAP), clen = new Float32Array(CAP), spd = new Float32Array(CAP), vmax = new Float32Array(CAP);
const lo = new Float32Array(CAP); // lane offset at the current exit boundary
const curve = new Float32Array(CAP * 8), ys = new Float32Array(CAP * 3);
const posX = new Float32Array(CAP), posY = new Float32Array(CAP), posZ = new Float32Array(CAP), hdg = new Float32Array(CAP), pitch = new Float32Array(CAP);
const vlen = new Float32Array(CAP), vwid = new Float32Array(CAP), vscale = new Float32Array(CAP), fade = new Float32Array(CAP);
const wait = new Float32Array(CAP), ghost = new Float32Array(CAP), timer = new Float32Array(CAP), vseed = new Float32Array(CAP), brake = new Float32Array(CAP);
const stopT = new Float32Array(CAP); // dispatched: stop at this t on the final tile
const models = new Array(CAP).fill(null), paths = new Array(CAP).fill(null), pathPos = new Int32Array(CAP), targets = new Array(CAP).fill(null);
const freeIdx = new Int32Array(CAP);
let nFree = 0, nCars = 0, nSpecial = 0;
const HB = 8192, hashHead = new Int32Array(HB).fill(-1), hashNext = new Int32Array(CAP).fill(-1);

/* ---------------- road data ---------------- */
let S = null, W = 0, H = 0, N = 0;
let mask = null, inter = null; // link masks, intersection flags
let roadList = new Int32Array(0), roadCount = 0;
let nearList = new Int32Array(0), nearCount = 0;
let dirty = null, roadsDirty = true;
let bfsQ = null, bfsPrev = null, bfsMark = null, bfsStamp = 1;
let trafficMax = 1, popEst = 0;

let rnd = M.rng(1);
const T12 = new Float32Array(12);
const P3 = [0, 0, 0];

const A = (VC.agents = {
  name: 'agents',
  order: 200,
  clock: 0, // agent time (advances with the game, frozen while paused)
  desired: 0,
  stats: { cars: 0, special: 0, desired: 0, near: 0, drawn: 0, ms: 0 },

  init() {
    if (VC.fxModels) VC.fxModels.ensure();
    A.batch = VC.fxgl.modelBatch(1024);
    A.glows = VC.fxgl.glowBatch(2048);
    VC.gfx.addLayer(A);
    VC.gfx.addLayer(A.glowLayer);
    VC.bus.on('dirty', (d) => markRoads(d.x0, d.z0, d.x1, d.z1, false));
    VC.bus.on('roadChange', (d) => markRoads(d.x, d.z, d.x, d.z, true));
    if (VC.fxAir && VC.fxAir.init) VC.fxAir.init();
  },

  reset(st) {
    S = st;
    W = st.W; H = st.H; N = st.N;
    mask = new Uint8Array(N);
    inter = new Uint8Array(N);
    bfsQ = new Int32Array(N);
    bfsPrev = new Int32Array(N);
    bfsMark = new Uint32Array(N);
    bfsStamp = 1;
    dirty = { x0: 0, z0: 0, x1: W - 1, z1: H - 1 };
    roadsDirty = true;
    rnd = M.rng((st.seed ^ 0xa9e7) >>> 0);
    clearAll();
    A.clock = 0;
    popT = 0; nearT = 0;
    if (VC.fxAir && VC.fxAir.reset) VC.fxAir.reset(st);
  },

  update(dt, rdt) {
    if (!S || S !== VC.state) { if (VC.state) A.reset(VC.state); else return; }
    const t0 = performance.now();
    if (dirty) rebuildRoads();
    const sp = GAME_SPEED[S.time.speed | 0] || 1;
    const gdt = dt * sp;
    A.clock += gdt;
    buildHash();
    if (rdt > 0) manage(rdt);
    if (gdt > 0) step(gdt);
    if (VC.fxAir) VC.fxAir.update(gdt, rdt, S);
    buildRender();
    A.stats.ms = +(performance.now() - t0).toFixed(2);
  },

  shadow(ctx) {
    A.batch.draw(ctx, true);
  },
  opaque(ctx) {
    A.batch.draw(ctx, false);
  },
  glowLayer: {
    name: 'agents_glow',
    order: 650,
    transparent(ctx) {
      A.glows.draw(ctx);
    },
  },

  count() {
    return nCars + nSpecial + (VC.fxAir ? VC.fxAir.count() : 0);
  },

  signal(x, z) {
    if (!S || x < 0 || z < 0 || x >= W || z >= H) return -1;
    const j = z * W + x;
    if (!inter || !inter[j]) return -1;
    const ph = signalTime(j);
    return ph < GREEN ? 0 : ph < GREEN + YELLOW ? 1 : ph < 2 * GREEN + YELLOW ? 2 : 3;
  },

  dispatch(kindName, x, z) {
    try {
      return dispatch(kindName, x, z);
    } catch (e) {
      console.error('[agents] dispatch failed', e);
      return 0;
    }
  },

  vehicles() {
    const out = [];
    for (let i = 0; i < CAP; i++) if (alive[i]) out.push({ kind: KIND[kind[i]].key, x: +posX[i].toFixed(2), z: +posZ[i].toFixed(2), y: +posY[i].toFixed(2), speed: +spd[i].toFixed(2), role: role[i], tile: tile[i] });
    return out;
  },
});

/* ------------------------------------------------------------------ */
/* Road graph                                                            */
/* ------------------------------------------------------------------ */
/** Marks link masks in a tile rect for recomputation; roadSet = the set of road tiles changed. */
function markRoads(x0, z0, x1, z1, roadSet) {
  if (!S) return;
  x0 = Math.max(0, x0 - 2); z0 = Math.max(0, z0 - 2);
  x1 = Math.min(W - 1, x1 + 2); z1 = Math.min(H - 1, z1 + 2);
  if (!dirty) dirty = { x0, z0, x1, z1 };
  else {
    dirty.x0 = Math.min(dirty.x0, x0); dirty.z0 = Math.min(dirty.z0, z0);
    dirty.x1 = Math.max(dirty.x1, x1); dirty.z1 = Math.max(dirty.z1, z1);
  }
  if (roadSet) roadsDirty = true;
}

/* mirror of the terrain renderer's road rules (used when VC.terrain.roadInfo is unavailable) */
function RL(x, z) {
  if (x < 0 || z < 0 || x >= W || z >= H) return -1;
  const i = z * W + x;
  if (!S.road[i]) return -1;
  const h = S.height[i];
  return h < C.SEA ? C.SEA + 1 : h;
}
const isBridge = (x, z) => S.road[z * W + x] !== 0 && S.height[z * W + x] < C.SEA;
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
function link(x, z, d) {
  const r = RL(x, z), nx = x + DX[d], nz = z + DZ[d], n = RL(nx, nz);
  if (r < 0 || n < 0) return false;
  const dh = n - r;
  if (dh === 0) return true;
  if (dh === 1) return rampOf(x, z) === 1 + d * 2 || (isBridge(x, z) && rampOf(nx, nz) === 2 + OPP[d] * 2);
  if (dh === -1) return rampOf(nx, nz) === 1 + OPP[d] * 2 || (isBridge(nx, nz) && rampOf(x, z) === 2 + d * 2);
  return false;
}
function tileMask(x, z) {
  const T = VC.terrain;
  if (T && T.roadInfo) {
    try {
      const info = T.roadInfo(x, z);
      return info ? info.mask & 15 : 0;
    } catch (e) { /* fall back */ }
  }
  if (RL(x, z) < 0) return 0;
  let m = 0;
  for (let d = 0; d < 4; d++) if (link(x, z, d)) m |= 1 << d;
  return m;
}
function rampY(lv, rc, u, v) {
  let y = lv * C.STEP;
  if (rc) {
    const d = (rc - 1) >> 1;
    const t = d === 0 ? u : d === 1 ? 1 - u : d === 2 ? v : 1 - v;
    y += (rc - 1) & 1 ? -C.STEP * t : C.STEP * t;
  }
  return y;
}
/** Road surface height at world (wx, wz). */
function roadY(wx, wz) {
  const T = VC.terrain;
  if (T && T.roadY) {
    const y = T.roadY(wx, wz);
    if (y != null) return y;
  }
  const x = Math.floor(wx), z = Math.floor(wz);
  if (x < 0 || z < 0 || x >= W || z >= H) return C.SEA_Y;
  const i = z * W + x, h = S.height[i];
  if (!S.road[i]) return Math.max(h * C.STEP, C.SEA_Y);
  if (h < C.SEA) return C.SEA_Y + 0.35;
  return rampY(h, rampOf(x, z), wx - x, wz - z);
}

function rebuildRoads() {
  const d = dirty;
  dirty = null;
  for (let z = d.z0; z <= d.z1; z++)
    for (let x = d.x0; x <= d.x1; x++) {
      const i = z * W + x;
      const m = S.road[i] ? tileMask(x, z) : 0;
      mask[i] = m;
      inter[i] = POP[m] >= 3 && S.road[i] !== 3 ? 1 : 0;
    }
  if (roadsDirty) {
    roadsDirty = false;
    let n = 0;
    for (let i = 0; i < N; i++) if (S.road[i]) n++;
    if (roadList.length < n) roadList = new Int32Array(Math.max(n, 256) * 2);
    n = 0;
    for (let i = 0; i < N; i++) if (S.road[i]) roadList[n++] = i;
    roadCount = n;
    nearT = 0;
  }
}

/* signal phase time for intersection tile j (each intersection has its own offset) */
function signalTime(j) {
  const off = M.hash(j % W, (j / W) | 0, 77) * CYCLE;
  return (A.clock + off) % CYCLE;
}
/** True if a vehicle travelling in direction d may enter intersection tile j now. */
function mayEnter(j, d, near) {
  const ph = signalTime(j);
  const xAxis = d < 2;
  if (xAxis) return ph < GREEN || (near && ph < GREEN + YELLOW);
  const p2 = ph - GREEN - YELLOW;
  return (p2 >= 0 && p2 < GREEN) || (near && p2 >= 0 && p2 < GREEN + YELLOW);
}

/* ------------------------------------------------------------------ */
/* Vehicles                                                              */
/* ------------------------------------------------------------------ */
function clearAll() {
  nFree = 0;
  for (let i = CAP - 1; i >= 0; i--) {
    alive[i] = 0;
    models[i] = null;
    paths[i] = null;
    targets[i] = null;
    freeIdx[nFree++] = i;
  }
  nCars = 0;
  nSpecial = 0;
}

function alloc() {
  return nFree ? freeIdx[--nFree] : -1;
}
function free(i) {
  if (!alive[i]) return;
  alive[i] = 0;
  if (role[i] === R_DISPATCH) nSpecial--;
  else nCars--;
  models[i] = null;
  paths[i] = null;
  targets[i] = null;
  freeIdx[nFree++] = i;
}

/** Creates a vehicle of kind k on road tile j heading out through exit direction d. Returns index or -1. */
function spawnVehicle(k, j, d, rl, t0) {
  const i = alloc();
  if (i < 0) return -1;
  const key = KIND[k].key;
  const def = VC.models.defs[key];
  const nv = def ? def.variants || 1 : 1;
  const m = VC.models.get(key, Math.floor(rnd() * nv));
  if (!m) { freeIdx[nFree++] = i; return -1; }
  alive[i] = 1;
  kind[i] = k;
  role[i] = rl;
  vstate[i] = 0;
  models[i] = m;
  const mw = m.sx * m.vox, ml = m.sz * m.vox;
  const sc = Math.min(1.15, KIND[k].w / Math.max(0.05, mw));
  vscale[i] = sc;
  vlen[i] = ml * sc;
  vwid[i] = mw * sc;
  vmax[i] = 1.2 * KIND[k].v * (0.88 + rnd() * 0.24);
  spd[i] = 0;
  wait[i] = 0;
  ghost[i] = 0;
  timer[i] = 0;
  brake[i] = 0;
  stopT[i] = 2;
  fade[i] = 0;
  vseed[i] = rnd();
  lane[i] = rnd() < 0.5 ? 1 : 0;
  const rt = S.road[j];
  lo[i] = LANE[rt][lane[i]];
  if (rl === R_DISPATCH) nSpecial++;
  else nCars++;
  // enter from the opposite side (straight) so the first curve is clean
  enterTile(i, j, d, d);
  tt[i] = t0 || 0;
  evalPos(i);
  return i;
}

/**
 * Sets up vehicle i on tile j arriving with direction dIn. forcedOut (optional) fixes the exit.
 * Returns false if the tile is not a road (vehicle should despawn).
 */
function enterTile(i, j, dIn, forcedOut) {
  const rt = S.road[j];
  if (!rt) return false;
  tile[i] = j;
  din[i] = dIn;
  const x = j % W, z = (j / W) | 0;
  const m = mask[j];
  let dOut = forcedOut;
  if (dOut == null) {
    if (role[i] === R_DISPATCH) dOut = pathDir(i, j, dIn);
    else dOut = chooseExit(i, j, dIn, m);
  }
  dout[i] = dOut;
  // lane choice: turning lanes on multi-lane roads
  if (rt >= 2) {
    if (dOut === RIGHT_OF[dIn]) lane[i] = 1;
    else if (dOut === LEFT_OF[dIn]) lane[i] = 0;
    else if (rnd() < 0.04) lane[i] ^= 1;
  }
  const loIn = lo[i];
  const loOut = LANE[rt][lane[i]];
  lo[i] = loOut;
  const cx = x + 0.5, cz = z + 0.5;
  const fix = DX[dIn], fiz = DZ[dIn], rix = RX[dIn], riz = RZ[dIn];
  const fox = DX[dOut], foz = DZ[dOut], rox = RX[dOut], roz = RZ[dOut];
  const p0x = cx - fix * 0.5 + rix * loIn, p0z = cz - fiz * 0.5 + riz * loIn;
  const p3x = cx + fox * 0.5 + rox * loOut, p3z = cz + foz * 0.5 + roz * loOut;
  let c1x, c1z, c2x, c2z;
  if (dOut === dIn) {
    c1x = p0x + fix / 3; c1z = p0z + fiz / 3;
    c2x = p3x - fox / 3; c2z = p3z - foz / 3;
  } else if (dOut === OPP[dIn]) {
    c1x = p0x + fix * 0.6; c1z = p0z + fiz * 0.6;
    c2x = p3x - fox * 0.6; c2z = p3z - foz * 0.6;
  } else {
    const qx = cx + rix * loIn + rox * loOut, qz = cz + riz * loIn + roz * loOut;
    c1x = p0x + (qx - p0x) * 0.6667; c1z = p0z + (qz - p0z) * 0.6667;
    c2x = p3x + (qx - p3x) * 0.6667; c2z = p3z + (qz - p3z) * 0.6667;
  }
  const o = i * 8;
  curve[o] = p0x; curve[o + 1] = p0z; curve[o + 2] = c1x; curve[o + 3] = c1z;
  curve[o + 4] = c2x; curve[o + 5] = c2z; curve[o + 6] = p3x; curve[o + 7] = p3z;
  const l = (Math.hypot(c1x - p0x, c1z - p0z) + Math.hypot(c2x - c1x, c2z - c1z) + Math.hypot(p3x - c2x, p3z - c2z) + Math.hypot(p3x - p0x, p3z - p0z)) * 0.5;
  clen[i] = Math.max(0.2, l);
  // heights at entry / middle / exit (sampled just inside the tile)
  const mx = 0.125 * (p0x + 3 * c1x + 3 * c2x + p3x), mz = 0.125 * (p0z + 3 * c1z + 3 * c2z + p3z);
  ys[i * 3] = roadY(p0x + fix * 0.03, p0z + fiz * 0.03);
  ys[i * 3 + 1] = roadY(mx, mz);
  ys[i * 3 + 2] = roadY(p3x - fox * 0.03, p3z - foz * 0.03);
  return true;
}

/** Weighted random exit: busier neighbours and straight ahead preferred; U-turn only at dead ends. */
function chooseExit(i, j, dIn, m) {
  let tot = 0;
  const w = chooseW;
  const vol = VC.sim && VC.sim.trafficVolume && VC.sim.trafficVolume.length === N ? VC.sim.trafficVolume : null;
  const tmap = S.maps && S.maps.traffic;
  const highway = S.road[j] === 3;
  for (let d = 0; d < 4; d++) {
    w[d] = 0;
    if (!(m & (1 << d)) || d === OPP[dIn]) continue;
    const n = j + DX[d] + DZ[d] * W;
    let v = 1;
    if (vol) v += Math.min(3, (vol[n] / trafficMax) * 3);
    else if (tmap) v += (tmap[n] / 255) * 2;
    if (d === dIn) v += 1.6;
    if (highway && S.road[n] === 3) v += 3;
    if (mask[n] === (1 << OPP[d])) v *= 0.25; // avoid dead ends
    w[d] = v;
    tot += v;
  }
  if (tot <= 0) return m & (1 << OPP[dIn]) ? OPP[dIn] : dIn;
  let r = rnd() * tot;
  for (let d = 0; d < 4; d++) if ((r -= w[d]) <= 0 && w[d] > 0) return d;
  return dIn;
}
const chooseW = new Float32Array(4);

/** Cubic Bezier position/tangent -> world pose of vehicle i. */
function evalPos(i) {
  const o = i * 8, t = tt[i], u = 1 - t;
  const b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
  posX[i] = b0 * curve[o] + b1 * curve[o + 2] + b2 * curve[o + 4] + b3 * curve[o + 6];
  posZ[i] = b0 * curve[o + 1] + b1 * curve[o + 3] + b2 * curve[o + 5] + b3 * curve[o + 7];
  const d0 = 3 * u * u, d1 = 6 * u * t, d2 = 3 * t * t;
  const tx = d0 * (curve[o + 2] - curve[o]) + d1 * (curve[o + 4] - curve[o + 2]) + d2 * (curve[o + 6] - curve[o + 4]);
  const tz = d0 * (curve[o + 3] - curve[o + 1]) + d1 * (curve[o + 5] - curve[o + 3]) + d2 * (curve[o + 7] - curve[o + 5]);
  if (tx * tx + tz * tz > 1e-8) hdg[i] = Math.atan2(tz, tx);
  const y0 = ys[i * 3], y1 = ys[i * 3 + 1], y2 = ys[i * 3 + 2];
  const half = clen[i] * 0.5;
  if (t < 0.5) {
    posY[i] = y0 + (y1 - y0) * t * 2;
    pitch[i] = Math.atan2(y1 - y0, half);
  } else {
    posY[i] = y1 + (y2 - y1) * (t - 0.5) * 2;
    pitch[i] = Math.atan2(y2 - y1, half);
  }
}

/* ---------------- dispatch paths ---------------- */
/** Exit direction toward the next tile of vehicle i's path (straight on at the end). */
function pathDir(i, j, dIn) {
  const p = paths[i];
  if (!p) return dIn;
  let k = pathPos[i];
  if (p[k] !== j) {
    // re-sync (should not happen): find j in the path
    k = p.indexOf(j);
    if (k < 0) { paths[i] = null; return chooseExit(i, j, dIn, mask[j]); }
  }
  pathPos[i] = k;
  if (k >= p.length - 1) return (mask[j] & (1 << dIn)) || !mask[j] ? dIn : chooseExit(i, j, dIn, mask[j]);
  const n = p[k + 1];
  const d = n - j;
  return d === 1 ? 0 : d === -1 ? 1 : d === W ? 2 : 3;
}

/** BFS over the road graph from tile a to tile b. Returns Int32Array path (a..b) or null. */
function bfs(a, b, maxN) {
  if (a === b) return Int32Array.of(a);
  const stamp = ++bfsStamp;
  if (stamp > 4e9) { bfsMark.fill(0); bfsStamp = 1; }
  let qh = 0, qt = 0;
  bfsQ[qt++] = a;
  bfsMark[a] = bfsStamp;
  bfsPrev[a] = -1;
  let found = false;
  while (qh < qt && qt < (maxN || N)) {
    const j = bfsQ[qh++];
    const m = mask[j];
    for (let d = 0; d < 4; d++) {
      if (!(m & (1 << d))) continue;
      const n = j + DX[d] + DZ[d] * W;
      if (bfsMark[n] === bfsStamp) continue;
      bfsMark[n] = bfsStamp;
      bfsPrev[n] = j;
      if (n === b) { found = true; break; }
      bfsQ[qt++] = n;
    }
    if (found) break;
  }
  if (!found) return null;
  let len = 1;
  for (let j = b; j !== a; j = bfsPrev[j]) len++;
  const p = new Int32Array(len);
  let k = len - 1;
  for (let j = b; k >= 0; j = bfsPrev[j]) p[k--] = j;
  return p;
}

/** Road tile nearest to (x, z) within r tiles (prefers access roads), or -1. */
function nearestRoad(x, z, r) {
  x = Math.floor(x); z = Math.floor(z);
  let best = -1, bd = 1e9;
  for (let dz = -r; dz <= r; dz++)
    for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, zz = z + dz;
      if (xx < 0 || zz < 0 || xx >= W || zz >= H) continue;
      const j = zz * W + xx;
      if (!S.road[j] || !mask[j]) continue;
      const d = dx * dx + dz * dz + (S.road[j] === 3 ? 6 : 0);
      if (d < bd) { bd = d; best = j; }
    }
  return best;
}
/** Road tile touching building b's footprint nearest to (tx, tz). */
function roadNextTo(b, tx, tz) {
  let best = -1, bd = 1e9;
  const test = (x, z) => {
    if (x < 0 || z < 0 || x >= W || z >= H) return;
    const j = z * W + x;
    if (!S.road[j] || !mask[j]) return;
    const d = (x - tx) * (x - tx) + (z - tz) * (z - tz);
    if (d < bd) { bd = d; best = j; }
  };
  for (let x = b.x; x < b.x + b.w; x++) { test(x, b.z - 1); test(x, b.z + b.d); }
  for (let z = b.z; z < b.z + b.d; z++) { test(b.x - 1, z); test(b.x + b.w, z); }
  return best >= 0 ? best : nearestRoad(b.x + b.w / 2, b.z + b.d / 2, 4);
}

function dispatch(kindName, x, z) {
  if (!S || !mask) return 0;
  if (dirty) rebuildRoads();
  const key = ALIAS[kindName] || kindName;
  const svc = SERVICE[key];
  if (!svc || x == null || z == null) return 0;
  if (nSpecial >= 24) return 0;
  const tx = +x + 0.5, tz = +z + 0.5;
  // nearest working station
  let st = null, sd = 1e9;
  for (const b of S.buildings.values()) {
    if (svc.keys.indexOf(b.key) < 0 || b.built < 1 || b.abandoned) continue;
    const d = Math.hypot(b.x + b.w / 2 - tx, b.z + b.d / 2 - tz);
    if (d < sd) { sd = d; st = b; }
  }
  if (!st) return 0;
  const target = VC.world.buildingAt(Math.floor(x), Math.floor(z));
  const from = roadNextTo(st, tx, tz);
  const to = target ? roadNextTo(target, st.x + st.w / 2, st.z + st.d / 2) : nearestRoad(tx, tz, 6);
  if (from < 0 || to < 0) return 0;
  const p = bfs(from, to);
  if (!p) return 0;
  const d0 = p.length > 1 ? dirTo(p[0], p[1]) : firstDir(from);
  const i = spawnVehicle(svc.kind, from, d0, R_DISPATCH, 0.1);
  if (i < 0) return 0;
  paths[i] = p;
  pathPos[i] = 0;
  vstate[i] = D_GO;
  targets[i] = { x: tx, z: tz, b: target, home: from, station: st };
  vmax[i] *= 1.35;
  fade[i] = 0.6;
  VC.fxgl.sfx('siren', tx, tz, 0.8, 90);
  timer[i] = 6;
  return i + 1;
}
function dirTo(a, b) {
  const d = b - a;
  return d === 1 ? 0 : d === -1 ? 1 : d === W ? 2 : 3;
}
function firstDir(j) {
  const m = mask[j];
  for (let d = 0; d < 4; d++) if (m & (1 << d)) return d;
  return 0;
}

/** Dispatched vehicle state machine (called every step). */
function dispatchLogic(i, dt) {
  const tg = targets[i];
  if (!tg) return;
  const p = paths[i];
  if (vstate[i] === D_GO) {
    timer[i] -= dt;
    if (timer[i] <= 0) {
      timer[i] = 7;
      VC.fxgl.sfx('siren', posX[i], posZ[i], 0.6, 60);
    }
    if (p && pathPos[i] >= p.length - 1 && tile[i] === p[p.length - 1]) {
      stopT[i] = 0.5;
      if (tt[i] >= 0.45 && spd[i] < 0.08) {
        vstate[i] = D_SCENE;
        timer[i] = kind[i] === K.fire ? 40 : 8 + rnd() * 6;
      }
    }
  } else if (vstate[i] === D_SCENE) {
    timer[i] -= dt;
    stopT[i] = tt[i];
    let done = timer[i] <= 0;
    if (kind[i] === K.fire) {
      const b = tg.b;
      const burning = b && S.buildings.has(b.id) && b.fire > 0;
      if (!burning && timer[i] < 34) done = true;
      // water cannon arc toward the fire
      if (burning && VC.particles && rnd() < dt * 30) {
        const bx = b.x + b.w / 2, bz = b.z + b.d / 2, by = VC.world.topY(b.x, b.z) + (b.hgt || 1) * 0.7;
        const dx = bx - posX[i], dz = bz - posZ[i], dl = Math.max(0.3, Math.hypot(dx, dz));
        const tFlight = 0.55 + dl * 0.12;
        const vy = (by - posY[i] - 0.3) / tFlight + 3 * tFlight;
        VC.particles.emit('fountain', posX[i], posY[i] + 0.3, posZ[i], { vx: dx / tFlight, vy, vz: dz / tFlight, life: tFlight * 1.1, size: 0.05 });
        if (rnd() < 0.2) VC.particles.emit('steam', bx, by, bz, { vx: 0, vy: 1, vz: 0 });
      }
    }
    if (done) {
      // drive home: new path from here, leaving smoothly from the current pose
      const back = bfs(tile[i], tg.home);
      vstate[i] = D_BACK;
      stopT[i] = 2;
      vmax[i] /= 1.35;
      timer[i] = 12;
      if (back && back.length > 1) {
        paths[i] = back;
        pathPos[i] = 0;
        recurve(i, dirTo(back[0], back[1]));
      } else paths[i] = null;
    }
  } else if (fade[i] >= 0) {
    // returning: fade out on arrival at the station (or after a while without a path)
    if (!p) {
      timer[i] -= dt;
      if (timer[i] <= 0) fade[i] = -0.001;
    } else if (pathPos[i] >= p.length - 1 && tile[i] === p[p.length - 1] && tt[i] > 0.4) fade[i] = -0.001;
  }
}

/** Rebuilds vehicle i's curve from its current position/heading to the exit edge dOut of its tile. */
function recurve(i, dOut) {
  const j = tile[i], rt = S.road[j] || 1;
  const x = j % W, z = (j / W) | 0;
  const loOut = LANE[rt][lane[i]];
  const p0x = posX[i], p0z = posZ[i];
  const fx = Math.cos(hdg[i]), fz = Math.sin(hdg[i]);
  const p3x = x + 0.5 + DX[dOut] * 0.5 + RX[dOut] * loOut, p3z = z + 0.5 + DZ[dOut] * 0.5 + RZ[dOut] * loOut;
  const L = Math.hypot(p3x - p0x, p3z - p0z);
  const k = 0.35 + L * 0.3;
  const o = i * 8;
  curve[o] = p0x; curve[o + 1] = p0z;
  curve[o + 2] = p0x + fx * k; curve[o + 3] = p0z + fz * k;
  curve[o + 4] = p3x - DX[dOut] * k; curve[o + 5] = p3z - DZ[dOut] * k;
  curve[o + 6] = p3x; curve[o + 7] = p3z;
  clen[i] = Math.max(0.2, (L + k * 2 + L) * 0.5);
  const y = posY[i];
  ys[i * 3] = y;
  ys[i * 3 + 1] = y;
  ys[i * 3 + 2] = roadY(p3x - DX[dOut] * 0.03, p3z - DZ[dOut] * 0.03);
  din[i] = dOut === OPP[din[i]] ? din[i] : din[i];
  dout[i] = dOut;
  lo[i] = loOut;
  tt[i] = 0;
}

/* ------------------------------------------------------------------ */
/* Simulation step                                                      */
/* ------------------------------------------------------------------ */
function buildHash() {
  hashHead.fill(-1);
  for (let i = 0; i < CAP; i++) {
    if (!alive[i]) continue;
    const h = ((Math.floor(posZ[i]) * W + Math.floor(posX[i])) & (HB - 1));
    hashNext[i] = hashHead[h];
    hashHead[h] = i;
  }
}

/** Distance gap to the nearest vehicle ahead of i in the same lane (or 9). */
function leaderGap(i) {
  const fx = Math.cos(hdg[i]), fz = Math.sin(hdg[i]);
  const x = posX[i], z = posZ[i];
  let best = 9;
  for (let s = 0; s < 2; s++) {
    const qx = s ? x + fx * 0.75 : x, qz = s ? z + fz * 0.75 : z;
    const tx = Math.floor(qx), tz = Math.floor(qz);
    if (tx < 0 || tz < 0 || tx >= W || tz >= H) continue;
    if (s && Math.floor(x) === tx && Math.floor(z) === tz) continue;
    for (let j = hashHead[(tz * W + tx) & (HB - 1)]; j >= 0; j = hashNext[j]) {
      if (j === i || !alive[j]) continue;
      const dx = posX[j] - x, dz = posZ[j] - z;
      const along = dx * fx + dz * fz;
      if (along <= 0.02 || along > 1.4) continue;
      const lat = Math.abs(dx * fz - dz * fx);
      if (lat > 0.12) continue;
      if (Math.abs(posY[j] - posY[i]) > 0.5) continue;
      const cosH = Math.cos(hdg[j] - hdg[i]);
      if (cosH < 0.1) continue;
      const gap = along - (vlen[i] + vlen[j]) * 0.5;
      if (gap < best) best = gap;
    }
  }
  return best;
}

/** True if a vehicle travelling on the other axis is currently inside intersection tile n. */
function crossTraffic(n, d) {
  const xAxis = d < 2;
  for (let j = hashHead[n & (HB - 1)]; j >= 0; j = hashNext[j]) {
    if (!alive[j] || tile[j] !== n) continue;
    if ((din[j] < 2) !== xAxis && tt[j] < 0.85) return true;
  }
  return false;
}

function step(dt) {
  for (let i = 0; i < CAP; i++) {
    if (!alive[i]) continue;
    const j = tile[i];
    if (!S.road[j]) { free(i); continue; }
    // fading in / out
    if (fade[i] < 0) {
      fade[i] -= dt * 2.5;
      if (fade[i] < -1.99) { free(i); continue; }
    } else if (fade[i] < 1) fade[i] = Math.min(1, fade[i] + dt * 2.5);
    const isD = role[i] === R_DISPATCH;
    if (isD) dispatchLogic(i, dt);
    if (!alive[i]) continue;
    // ---- desired speed ----
    const rt = S.road[j];
    let want = vmax[i] * ROAD_SPEED[rt];
    if (dout[i] !== din[i]) want *= dout[i] === OPP[din[i]] ? 0.35 : 0.55;
    const len = clen[i];
    const t = tt[i];
    if (ghost[i] > 0) ghost[i] -= dt;
    else {
      const gap = leaderGap(i);
      if (gap < 9) want = Math.min(want, vmax[i] * ROAD_SPEED[rt] * M.clamp((gap - 0.05) / 0.55, 0, 1));
      // traffic signal at the next tile
      const n = j + DX[dout[i]] + DZ[dout[i]] * W;
      if (!(isD && vstate[i] === D_GO) && inter[n] && !inter[j]) {
        const dist = (0.94 - t) * len;
        if (dist > -0.02 && (!mayEnter(n, dout[i], dist < 0.12) || crossTraffic(n, dout[i]))) want = Math.min(want, Math.max(0, dist - 0.02) * 3);
      }
    }
    // dispatched: stop point on the final tile
    if (stopT[i] <= 1) {
      const dist = (stopT[i] - t) * len;
      want = Math.min(want, Math.max(0, dist) * 2.5);
    }
    // ---- integrate ----
    const prev = spd[i];
    const dv = want - prev;
    spd[i] = dv > 0 ? prev + Math.min(dv, 1.3 * dt) : prev + Math.max(dv, -6 * dt);
    brake[i] = dv < -0.02 || spd[i] < 0.05 ? Math.min(1, brake[i] + dt * 6) : Math.max(0, brake[i] - dt * 3);
    if (spd[i] < 0.03 && want < 0.03) {
      wait[i] += dt;
      if (wait[i] > (isD ? 1.5 : 7) && !(stopT[i] <= 1)) { ghost[i] = 1.6; wait[i] = 0; }
    } else wait[i] = 0;
    let nt = t + (spd[i] * dt) / len;
    if (nt >= 1) {
      // move into the next tile, carrying over the remaining distance
      const rem = (nt - 1) * len;
      const d = dout[i];
      const x = (j % W) + DX[d], z = ((j / W) | 0) + DZ[d];
      if (x < 0 || z < 0 || x >= W || z >= H) { free(i); continue; }
      const n = z * W + x;
      if (isD && paths[i]) pathPos[i]++;
      if (!enterTile(i, n, d)) { free(i); continue; }
      nt = Math.min(0.99, rem / clen[i]);
    }
    tt[i] = nt;
    evalPos(i);
  }
}

/* ------------------------------------------------------------------ */
/* Population / spawning around the camera                              */
/* ------------------------------------------------------------------ */
let popT = 0, nearT = 0, spawnAcc = 0;
function todFactor(tod) {
  // quiet nights, morning + evening rush hours
  const day = M.smoothstep(0.2, 0.3, tod) * (1 - M.smoothstep(0.84, 0.95, tod));
  const rush = Math.exp(-Math.pow((tod - 0.33) / 0.035, 2)) + Math.exp(-Math.pow((tod - 0.72) / 0.04, 2));
  return 0.22 + 0.78 * day + 0.35 * rush;
}

function manage(rdt) {
  const cam = VC.camera;
  const q = VC.gfx.quality();
  const capCars = Math.min(CAP - 40, q.cars || 250);
  // population estimate (sim stats, or sum of building populations)
  popT -= rdt;
  if (popT <= 0) {
    popT = 2;
    let p = 0;
    for (const b of S.buildings.values()) p += b.pop || 0;
    popEst = Math.max((S.stats && S.stats.pop) || 0, p);
    const vol = VC.sim && VC.sim.trafficVolume;
    if (vol && vol.length === N) {
      let mx = 1;
      for (let k = 0; k < roadCount; k++) if (vol[roadList[k]] > mx) mx = vol[roadList[k]];
      trafficMax = mx;
    }
  }
  const R = M.clamp(cam.dist * 1.05, 16, 150);
  nearT -= rdt;
  if (nearT <= 0) {
    nearT = 0.5;
    if (nearList.length < roadCount) nearList = new Int32Array(Math.max(256, roadCount * 2));
    let n = 0;
    const R2 = R * R;
    for (let k = 0; k < roadCount; k++) {
      const j = roadList[k];
      const dx = (j % W) + 0.5 - cam.tx, dz = ((j / W) | 0) + 0.5 - cam.tz;
      if (dx * dx + dz * dz < R2 && mask[j]) nearList[n++] = j;
    }
    nearCount = n;
    const tod = S.time.tod;
    const density = M.clamp(popEst / Math.max(40, roadCount) / 32, 0, 0.42) * todFactor(tod);
    A.desired = Math.min(capCars, Math.round(nearCount * density));
    A.stats.desired = A.desired;
    A.stats.near = nearCount;
  }
  // despawn far vehicles
  const Rd = R * 1.3, F = VC.fxgl.frustum;
  let excess = nCars - A.desired;
  for (let i = 0; i < CAP; i++) {
    if (!alive[i] || role[i] === R_DISPATCH) continue;
    if (fade[i] < 0) { excess--; continue; } // already leaving
    const d = Math.hypot(posX[i] - cam.tx, posZ[i] - cam.tz);
    if (d > Rd && (d > Rd * 1.3 || !F.sphere(posX[i], posY[i], posZ[i], 0.6))) { free(i); excess--; continue; }
    if (excess > A.desired * 0.12 + 2 && fade[i] >= 1 && !F.sphere(posX[i], posY[i], posZ[i], 0.6)) { fade[i] = -0.001; excess--; }
  }
  // spawn toward the desired count (fast when far below, a trickle otherwise)
  if (nCars < A.desired && nearCount) {
    const deficit = A.desired - nCars;
    const initial = nCars < A.desired * 0.6;
    spawnAcc += initial ? deficit : Math.min(30, 3 + deficit * 1.2) * rdt;
    const maxPer = initial ? 40 : 6;
    let tries = 0, made = 0;
    while (spawnAcc >= 1 && made < maxPer && tries++ < maxPer * 4) {
      const j = nearList[Math.floor(rnd() * nearCount)];
      if (!acceptSpawn(j, initial, cam, R)) continue;
      spawnAcc -= 1;
      made++;
      const k = pickKind(j);
      const d = pickDir(j);
      const i = spawnVehicle(k, j, d, k === K.police && rnd() < 0.8 ? R_PATROL : R_TRAFFIC, rnd() * 0.8);
      if (i >= 0) {
        fade[i] = initial ? 0.6 : 0;
        if (role[i] === R_PATROL && rnd() < 0.18) { vstate[i] = 1; vmax[i] *= 1.2; } // patrol responding with lights on
      }
    }
    if (spawnAcc > maxPer) spawnAcc = maxPer;
  } else spawnAcc = 0;
  A.stats.cars = nCars;
  A.stats.special = nSpecial;
}

function acceptSpawn(j, initial, cam, R) {
  if (!mask[j]) return false;
  const x = (j % W) + 0.5, z = ((j / W) | 0) + 0.5;
  // traffic-weighted acceptance
  const vol = VC.sim && VC.sim.trafficVolume && VC.sim.trafficVolume.length === N ? VC.sim.trafficVolume : null;
  let act;
  if (vol) act = Math.min(1, (vol[j] / trafficMax) * 2);
  else if (S.maps && S.maps.traffic && S.maps.traffic[j]) act = S.maps.traffic[j] / 160;
  else act = nearBuildings(j) ? 0.7 : 0.25;
  if (rnd() > 0.3 + 0.7 * Math.min(1, act)) return false;
  // prefer spawning out of view once the initial fill is done
  if (!initial) {
    const y = VC.world.topY(Math.min(W - 1, x | 0), Math.min(H - 1, z | 0));
    if (VC.fxgl.frustum.sphere(x, y, z, 0.8) && Math.hypot(x - cam.tx, z - cam.tz) < R * 0.7 && rnd() < 0.85) return false;
  }
  // clearance
  const h = j & (HB - 1);
  for (let k = hashHead[h]; k >= 0; k = hashNext[k]) if (alive[k] && tile[k] === j) return false;
  return true;
}
function nearBuildings(j) {
  const x = j % W, z = (j / W) | 0;
  for (let d = 0; d < 4; d++) {
    const xx = x + DX[d], zz = z + DZ[d];
    if (xx >= 0 && zz >= 0 && xx < W && zz < H && S.bld[zz * W + xx]) return true;
  }
  return false;
}
function pickDir(j) {
  const m = mask[j];
  let n = POP[m], k = Math.floor(rnd() * n);
  for (let d = 0; d < 4; d++) if (m & (1 << d) && k-- === 0) return d;
  return 0;
}
function zoneNear(j, zt) {
  const x = j % W, z = (j / W) | 0;
  for (let dz = -2; dz <= 2; dz += 2)
    for (let dx = -2; dx <= 2; dx += 2) {
      const xx = x + dx, zz = z + dz;
      if (xx < 0 || zz < 0 || xx >= W || zz >= H) continue;
      if (VC.ztype(S.zone[zz * W + xx]) === zt) return true;
    }
  return false;
}
let hasPolice = false, hasTransit = false, svcCheckT = 0;
function pickKind(j) {
  const now = A.clock;
  if (now - svcCheckT > 5 || now < svcCheckT) {
    svcCheckT = now;
    hasPolice = false; hasTransit = false;
    for (const b of S.buildings.values()) {
      if (b.key === 'police_station' || b.key === 'police_hq') hasPolice = true;
      else if (b.key === 'bus_depot' || b.key === 'metro_station') hasTransit = true;
    }
  }
  const tod = S.time.tod;
  const night = tod < 0.22 || tod > 0.86;
  const r = rnd();
  const transit = S.maps && S.maps.transit ? S.maps.transit[j] / 255 : 0;
  const pBus = (hasTransit ? 0.03 : 0.012) + 0.12 * transit;
  const ind = zoneNear(j, 3);
  const pTruck = S.road[j] === 3 ? 0.16 : ind ? 0.32 : 0.045;
  const pGarb = tod > 0.24 && tod < 0.42 ? 0.025 : 0.004;
  const pPol = hasPolice ? (night ? 0.05 : 0.012) : 0;
  const pTaxi = 0.06 + (zoneNear(j, 2) ? 0.08 : 0);
  let a = r;
  if ((a -= pPol) < 0) return K.police;
  if ((a -= pBus) < 0) return K.bus;
  if ((a -= pTruck) < 0) return rnd() < 0.2 ? K.tanker : K.truck;
  if ((a -= pGarb) < 0) return K.garbage;
  if ((a -= pTaxi) < 0) return K.taxi;
  return K.car;
}

/* ------------------------------------------------------------------ */
/* Render lists                                                          */
/* ------------------------------------------------------------------ */
function buildRender() {
  const cam = VC.camera, FXg = VC.fxgl, F = FXg.frustum;
  F.update(cam.viewProj);
  const B = A.batch, G = A.glows;
  B.begin();
  G.begin();
  const q = VC.gfx.quality();
  const drawDist = q.drawDist || 220;
  const env = VC.gfx.env || {};
  const night = env.night || 0;
  const lightsOn = M.smoothstep(0.1, 0.5, night + (env.cloud || 0) * 0.15 + (env.wet || 0) * 0.2);
  const cx = cam.pos[0], cy = cam.pos[1], cz = cam.pos[2];
  const TIME = VC.gfx.time;
  let drawn = 0;
  for (let i = 0; i < CAP; i++) {
    if (!alive[i]) continue;
    const x = posX[i], y = posY[i], z = posZ[i];
    const f = fade[i] < 0 ? Math.max(0, 1 + fade[i] * 0.5) : Math.min(1, 0.3 + fade[i] * 0.7);
    if (f <= 0.02) continue;
    if (!F.sphere(x, y + 0.15, z, Math.max(0.5, vlen[i]))) continue;
    const dist = Math.hypot(x - cx, y - cy, z - cz);
    if (dist > drawDist) continue;
    const m = models[i];
    const h = hdg[i];
    FXg.pose(T12, m, x, y, z, h, pitch[i], 0, vscale[i] * f);
    const siren = (role[i] === R_DISPATCH && vstate[i] !== D_BACK) || (role[i] === R_PATROL && vstate[i] === 1);
    B.add(m, dist > 38, T12, siren ? FXg.F.SIREN : 0, 0, FXg.WHITE, vseed[i]);
    drawn++;
    // ---- lights ----
    const fx = Math.cos(h), fz = Math.sin(h), rx = -fz, rz = fx;
    const hl = vlen[i] * 0.5, hw = vwid[i] * 0.36;
    if (siren) {
      const ph = (TIME * 2.4 + vseed[i]) % 1;
      const red = ph < 0.5;
      const on = (ph * 4) % 1 > 0.2 ? 1 : 0.15;
      const ly = y + (m.sy * m.vox * vscale[i]) + 0.05;
      const k = (2.2 + 4 * night) * on;
      G.add(x + rx * hw, ly, z + rz * hw, 0.32, 1, 0.1, 0.08, red ? k : k * 0.05, 0, 0, 1, 0.5);
      G.add(x - rx * hw, ly, z - rz * hw, 0.32, 0.15, 0.3, 1, red ? k * 0.05 : k, 0, 0, 1, 0.5);
      if (dist < 80) G.add(x, y + 0.03, z, 0.9, red ? 1 : 0.2, 0.15, red ? 0.1 : 1, (0.35 + night * 0.9) * on, 1, h, 1, 0);
    }
    if (lightsOn > 0.01 && dist < 110) {
      const hx = x + fx * hl, hz = z + fz * hl, hy = y + 0.07;
      const k = lightsOn * (dist < 60 ? 1 : 1 - (dist - 60) / 50);
      // headlight flares
      G.add(hx + rx * hw, hy, hz + rz * hw, 0.07, 1, 0.9, 0.7, 1.6 * k, 0, 0, 1, 0.7);
      G.add(hx - rx * hw, hy, hz - rz * hw, 0.07, 1, 0.9, 0.7, 1.6 * k, 0, 0, 1, 0.7);
      // light pool on the road ahead
      if (dist < 70) G.add(hx + fx * 0.32, y + 0.025, hz + fz * 0.32, 0.17, 1, 0.82, 0.55, 0.55 * k, 1, h, 2.1, 0.9);
      // tail / brake lights
      const tx = x - fx * hl, tz = z - fz * hl;
      const br = 0.5 + brake[i] * 1.6;
      G.add(tx + rx * hw, hy, tz + rz * hw, 0.05 + brake[i] * 0.02, 1, 0.06, 0.03, br * k, 0, 0, 1, 0.6);
      G.add(tx - rx * hw, hy, tz - rz * hw, 0.05 + brake[i] * 0.02, 1, 0.06, 0.03, br * k, 0, 0, 1, 0.6);
    }
  }
  A.stats.drawn = drawn;
  if (VC.fxAir) VC.fxAir.render(B, G, cam, night);
}
