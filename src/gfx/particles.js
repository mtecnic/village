/*
 * VOXELPOLIS — particle system (VC.particles). Transparent layer order 600 (+ opaque pass for cubes).
 *
 * Structure-of-arrays pool (typed arrays, fixed capacity, free-list), CPU simulation, instanced
 * rendering in three flavours:
 *   - soft lit billboards (alpha, depth-bucket sorted): smoke, steam, dust, contrail, fog, wake,
 *     droplets (fountain, splash) and rain-splash rings — noise-shaped, lit by sun/sky/lightning, fogged
 *   - additive HDR sprites: fire, spark, ember, firework, sparkle (star glints), flash
 *   - small lit voxel cubes with physics + bounce (opaque pass): debris, confetti, leaf
 *
 * API
 *   emit(type, x, y, z, opts)        one particle; returns its index or -1
 *   burst(type, x, y, z, n, opts)    n particles with type-specific spread; returns the count emitted
 *   opts: { vx, vy, vz, life, size, grow, color:[r,g,b] | paletteIndex, colors:[...], alpha, spread,
 *           emissive (soft types: warm self-glow), grav, jitter (position radius) }
 *   count(), clear(), TYPES (names), stats
 *
 * AUTOMATIC EFFECTS (driven by the world, all culled near the camera):
 *   building emitters (VC.models emitters: smoke/steam/fire/sparkle/fountain) of built, powered,
 *   non-abandoned buildings; burning buildings (b.fire > 0): flames, embers, smoke column, light pool;
 *   construction dust (and welding sparks at night); debris + dust on bldRemove (bulldoze/disaster/fire)
 *   coloured from the building's model; dust puffs for 'built' events; sparkles on level-ups;
 *   seasonal ambience (spring petals, autumn leaves, summer-night fireflies, winter chimney smoke).
 *   Buildings are found through VC.fxgl.cells (8x8-tile cells around the camera, kept up to date from
 *   bldAdd / bldRemove / bldChange) and their models only through VC.fxgl.cachedModel: particles never
 *   build a model synchronously (a building whose model is not built yet joins a later scan).
 * WATER: the water surface writes no depth, so sprites below SEA_Y over water are clipped in the shaders
 *   and retired once fully submerged.
 * PERF: per-type parameters live in typed arrays and the per-particle loops call no helpers with double
 *   arguments (no boxed HeapNumbers: near-zero garbage per frame).
 */
const M = VC.M, C = VC.C;
const MAX = 6000;

// render kinds
const K_SOFT = 0, K_ADD = 1, K_DROP = 2, K_RING = 3, K_STAR = 4, K_CUBE = 5, K_FIRE = 6, K_FLAT = 7;

/*
 * Type table. life/size = [min, max]; grow = end size multiplier; col = linear colour (HDR for additive);
 * a = alpha; grav, buoy (up accel), drag (1/s), wind (follow factor), spread (burst speed), vy (burst up speed),
 * bounce (cubes), flutter (cubes), jit (position jitter for bursts).
 */
const TYPES = {
  smoke: { k: K_SOFT, life: [4, 7], size: [0.3, 0.5], grow: 3.4, col: [0.24, 0.24, 0.25], a: 0.5, buoy: 0.35, drag: 0.7, wind: 1, spread: 0.3, vy: 0.7, jit: 0.1 },
  steam: { k: K_SOFT, life: [2, 3.4], size: [0.28, 0.42], grow: 3.2, col: [0.92, 0.93, 0.95], a: 0.5, buoy: 0.5, drag: 0.9, wind: 0.8, spread: 0.25, vy: 1, jit: 0.08 },
  dust: { k: K_SOFT, life: [1.4, 2.8], size: [0.25, 0.45], grow: 2.8, col: [0.6, 0.52, 0.4], a: 0.5, buoy: 0.1, drag: 1.8, wind: 0.6, spread: 1.3, vy: 0.5, jit: 0.3 },
  contrail: { k: K_SOFT, life: [7, 11], size: [0.3, 0.45], grow: 5, col: [0.96, 0.97, 1], a: 0.45, drag: 0.3, wind: 0.5, spread: 0.05, jit: 0.05 },
  fog: { k: K_SOFT, life: [5, 9], size: [2, 3.5], grow: 1.6, col: [0.82, 0.84, 0.88], a: 0.16, drag: 0.5, wind: 0.6, spread: 0.1, jit: 1 },
  wake: { k: K_FLAT, life: [1.8, 2.8], size: [0.08, 0.12], grow: 3.2, col: [0.92, 0.96, 1], a: 0.5, drag: 1.2, spread: 0.15, jit: 0.05 },
  fire: { k: K_FIRE, life: [0.45, 0.9], size: [0.22, 0.4], grow: 0.4, col: [1, 1, 1], a: 1, buoy: 1.8, drag: 1.4, wind: 0.35, spread: 0.4, vy: 0.9, jit: 0.15 },
  spark: { k: K_ADD, life: [0.5, 1.1], size: [0.035, 0.06], grow: 0.5, col: [5, 2.6, 0.8], a: 1, grav: 6, drag: 0.6, spread: 2.6, vy: 2.2, jit: 0.05 },
  ember: { k: K_ADD, life: [1.2, 2.4], size: [0.03, 0.05], grow: 0.6, col: [4, 1.3, 0.25], a: 1, buoy: 0.9, drag: 0.8, wind: 1, spread: 0.7, vy: 1.3, jit: 0.3, flicker: 1 },
  firework: { k: K_ADD, life: [1.4, 2.4], size: [0.13, 0.18], grow: 0.3, col: [3, 3, 3], a: 1, grav: 1.1, drag: 1.5, spread: 5, jit: 0, flicker: 0.45 },
  firefly: { k: K_ADD, life: [3, 5], size: [0.05, 0.07], grow: 1, col: [2.2, 3.6, 0.6], a: 1, drag: 1.2, spread: 0.25, vy: 0.05, jit: 0.4, flutter: 0.5, pulse: 2.6 },
  willow: { k: K_ADD, life: [2.4, 3.4], size: [0.07, 0.1], grow: 0.5, col: [4, 2.6, 0.9], a: 1, grav: 2.4, drag: 2.4, spread: 4.5, jit: 0, flicker: 0.7 },
  crackle: { k: K_STAR, life: [0.25, 0.5], size: [0.1, 0.16], grow: 0.4, col: [5, 4.5, 3.5], a: 1, grav: 1, drag: 2, spread: 1.2, jit: 0.8 },
  flash: { k: K_ADD, life: [0.12, 0.22], size: [1.4, 2], grow: 1.6, col: [6, 4, 2.4], a: 1, jit: 0 },
  sparkle: { k: K_STAR, life: [0.6, 1.3], size: [0.09, 0.16], grow: 0.3, col: [3, 2.6, 1.4], a: 1, buoy: 0.3, drag: 1, spread: 0.7, vy: 0.4, jit: 0.3 },
  fountain: { k: K_DROP, life: [0.9, 1.3], size: [0.03, 0.05], grow: 1, col: [0.75, 0.88, 1], a: 0.85, grav: 6, drag: 0.1, spread: 0.35, vy: 2.6, jit: 0.04 },
  splash: { k: K_DROP, life: [0.35, 0.65], size: [0.025, 0.045], grow: 1, col: [0.85, 0.92, 1], a: 0.8, grav: 7, drag: 0.3, spread: 0.9, vy: 1.7, jit: 0.1 },
  rainsplash: { k: K_RING, life: [0.2, 0.32], size: [0.05, 0.08], grow: 3.2, col: [0.78, 0.82, 0.9], a: 0.55, jit: 0 },
  debris: { k: K_CUBE, life: [2.5, 4.5], size: [0.05, 0.12], col: [0.5, 0.48, 0.45], grav: 9.8, drag: 0.25, spread: 2.2, vy: 3.5, bounce: 0.35, jit: 0.3 },
  confetti: { k: K_CUBE, life: [4, 6.5], size: [0.035, 0.05], col: [1, 1, 1], grav: 1.3, drag: 1.9, spread: 3, vy: 4.5, flutter: 1.6, bounce: 0.05, jit: 0.3 },
  leaf: { k: K_CUBE, life: [2.5, 4], size: [0.035, 0.055], col: [0.2, 0.42, 0.1], grav: 1.1, drag: 1.6, spread: 1.4, vy: 1.6, flutter: 1, bounce: 0.1, jit: 0.3 },
};
const TYPE_NAMES = Object.keys(TYPES);
const TYPE_LIST = TYPE_NAMES.map((k) => TYPES[k]);
const TYPE_ID = {};
TYPE_NAMES.forEach((k, i) => (TYPE_ID[k] = i));
/*
 * Per-type parameters flattened into typed arrays for the per-particle loops: reading doubles from ~20
 * differently shaped type objects is a megamorphic load that boxes a fresh HeapNumber every time.
 */
const NT = TYPE_LIST.length;
const TK = new Uint8Array(NT), TDRAG = new Float32Array(NT), TWIND = new Float32Array(NT), TBUOY = new Float32Array(NT);
const TGRAV = new Float32Array(NT), TFLUT = new Float32Array(NT), TBOUNCE = new Float32Array(NT);
const TFLICK = new Float32Array(NT), TPULSE = new Float32Array(NT);
const TJIT = new Float32Array(NT), TSPREAD = new Float32Array(NT), TVY = new Float32Array(NT), TGROW = new Float32Array(NT);
const TLIFE0 = new Float32Array(NT), TLIFE1 = new Float32Array(NT), TSIZE0 = new Float32Array(NT), TSIZE1 = new Float32Array(NT), TA = new Float32Array(NT);
const DK = new Float32Array(NT), DKY = new Float32Array(NT); // per-frame drag decay (xz, y)
for (let t = 0; t < NT; t++) {
  const T = TYPE_LIST[t];
  TK[t] = T.k; TDRAG[t] = T.drag || 0; TWIND[t] = T.wind || 0; TBUOY[t] = T.buoy || 0; TGRAV[t] = T.grav || 0;
  TFLUT[t] = T.flutter || 0; TBOUNCE[t] = T.bounce || 0.2; TFLICK[t] = T.flicker || 0; TPULSE[t] = T.pulse || 0;
  TJIT[t] = T.jit || 0; TSPREAD[t] = T.spread || 0; TVY[t] = T.vy || 0; TGROW[t] = T.grow || 1; TA[t] = T.a == null ? 1 : T.a;
  TLIFE0[t] = T.life[0]; TLIFE1[t] = T.life[1]; TSIZE0[t] = T.size[0]; TSIZE1[t] = T.size[1];
}
const CONFETTI_COLS = [[1, 0.2, 0.25], [1, 0.8, 0.1], [0.2, 0.6, 1], [0.3, 0.9, 0.35], [0.9, 0.35, 1], [1, 0.55, 0.1], [1, 1, 1]];
const LEAF_COLS = [[0.2, 0.42, 0.1], [0.32, 0.5, 0.12], [0.55, 0.45, 0.1], [0.7, 0.32, 0.08]];
const SMOKE_DARK = [0.1, 0.095, 0.09], SMOKE_WOOD = [0.55, 0.55, 0.58];
const WELD_OPT = { spread: 1.4 };
const AUTUMN_COLS = [[0.75, 0.3, 0.05], [0.85, 0.5, 0.08], [0.6, 0.16, 0.05], [0.5, 0.35, 0.12], [0.9, 0.7, 0.15]];
const PETAL_COLS = [[1, 0.7, 0.8], [1, 0.85, 0.9], [0.98, 0.95, 0.97], [0.95, 0.55, 0.75]];

/* ---------------- SoA pool ---------------- */
const px = new Float32Array(MAX), py = new Float32Array(MAX), pz = new Float32Array(MAX);
const vx = new Float32Array(MAX), vy = new Float32Array(MAX), vz = new Float32Array(MAX);
const age = new Float32Array(MAX), life = new Float32Array(MAX);
const size0 = new Float32Array(MAX), grow = new Float32Array(MAX);
const cr = new Float32Array(MAX), cg = new Float32Array(MAX), cb = new Float32Array(MAX), ca = new Float32Array(MAX);
const rot = new Float32Array(MAX), rotV = new Float32Array(MAX), seed = new Float32Array(MAX), emis = new Float32Array(MAX);
const ptype = new Uint8Array(MAX), rest = new Uint8Array(MAX);
const active = new Int32Array(MAX), freeList = new Int32Array(MAX);
let nActive = 0, nFree = 0;

/* ---------------- render scratch ---------------- */
const softData = new Float32Array(MAX * 12), addData = new Float32Array(MAX * 12), cubeData = new Float32Array(MAX * 12);
const softIdx = new Int32Array(MAX), softDepth = new Float32Array(MAX), order = new Int32Array(MAX);
const NB = 64, bucketCount = new Int32Array(NB), bucketOff = new Int32Array(NB);
let nSoft = 0, nAdd = 0, nCube = 0;

let rnd = VC.fxgl.rng(99);
const tmp3 = [0, 0, 0];
const Pt = (VC.particles = {
  name: 'particles',
  order: 600,
  TYPES: TYPE_NAMES,
  stats: { active: 0, soft: 0, add: 0, cube: 0, emitters: 0, burning: 0, ms: 0 },

  init() {
    for (let i = MAX - 1; i >= 0; i--) freeList[nFree++] = i;
    initGL();
    Pt.glows = VC.fxgl.glowBatch(256);
    VC.gfx.addLayer(Pt);
    VC.fxgl.cells.init(); // building registry per 8x8 cell (emitter / fire scans near the camera)
    VC.bus.on('bldAdd', onBldAdd);
    VC.bus.on('bldRemove', onBldRemove);
    VC.bus.on('bldChange', onBldChange);
    VC.bus.on('built', onBuilt);
  },
  reset(S) {
    Pt.clear();
    rnd = VC.fxgl.rng((S.seed ^ 0x9a17) >>> 0);
    scanT = 0;
    scanN = 0;
    scanI = 0;
    nearBuf.length = 0;
    emitList.length = 0;
    burnList.length = 0;
    hearthList.length = 0;
    buildList.length = 0;
    burnSet.clear();
    for (const b of S.buildings.values()) {
      if (b.built < 1) buildList.push(b);
      if (b.fire > 0) burnSet.add(b);
    }
    VC.fxgl.cells.sync();
  },
  clear() {
    nActive = 0;
    nFree = 0;
    for (let i = MAX - 1; i >= 0; i--) freeList[nFree++] = i;
  },
  count() {
    return nActive;
  },
  cap() {
    const q = VC.gfx.quality ? VC.gfx.quality() : null;
    return Math.min(MAX, (q && q.particles) || 3000);
  },

  emit(type, x, y, z, opts) {
    const tid = TYPE_ID[type];
    if (tid == null || !isFinite(x + y + z)) return -1;
    return spawn(tid, x, y, z, opts, false);
  },
  burst(type, x, y, z, n, opts) {
    const tid = TYPE_ID[type];
    if (tid == null || !isFinite(x + y + z)) return 0;
    n = Math.min(n | 0, 400);
    let k = 0;
    for (let i = 0; i < n; i++) if (spawn(tid, x, y, z, opts, true) >= 0) k++;
    return k;
  },

  update(dt, rdt) {
    const S = VC.state;
    if (!S) return;
    const t0 = performance.now();
    if (rdt > 0) {
      autoEffects(S, rdt);
      simulate(S, rdt);
    }
    buildInstances();
    Pt.stats.active = nActive;
    Pt.stats.ms = Math.round((performance.now() - t0) * 100) / 100;
  },

  opaque(ctx) {
    drawCubes(ctx, false);
  },
  transparent(ctx) {
    drawSprites(ctx);
    Pt.glows.draw(ctx);
  },
});

/* ------------------------------------------------------------------ */
/* Spawning                                                             */
/* ------------------------------------------------------------------ */
function spawn(tid, x, y, z, o, isBurst) {
  if (nFree === 0 || nActive >= Pt.cap()) return -1;
  const T = TYPE_LIST[tid];
  const i = freeList[--nFree];
  active[nActive++] = i;
  const r = rnd;
  const j = o && o.jitter != null ? o.jitter : isBurst ? TJIT[tid] : 0;
  px[i] = x + (j ? (r() - 0.5) * 2 * j : 0);
  py[i] = y + (j ? (r() - 0.5) * j : 0);
  pz[i] = z + (j ? (r() - 0.5) * 2 * j : 0);
  if (o && o.vx != null) {
    vx[i] = o.vx; vy[i] = o.vy || 0; vz[i] = o.vz || 0;
    if (isBurst && o.spread) {
      vx[i] += (r() - 0.5) * o.spread; vy[i] += (r() - 0.5) * o.spread; vz[i] += (r() - 0.5) * o.spread;
    }
  } else {
    const sp = o && o.spread != null ? o.spread : TSPREAD[tid];
    if (isBurst && (tid === TYPE_ID.firework || tid === TYPE_ID.spark || tid === TYPE_ID.willow)) {
      // spherical shell
      const u = r() * 2 - 1, a = r() * M.PI2, s = Math.sqrt(1 - u * u), m = sp * (0.55 + 0.45 * Math.cbrt(r()));
      vx[i] = Math.cos(a) * s * m; vy[i] = u * m + TVY[tid] * 0.3; vz[i] = Math.sin(a) * s * m;
    } else {
      const a = r() * M.PI2, m = sp * (isBurst ? 0.3 + r() * 0.7 : r() * 0.5);
      vx[i] = Math.cos(a) * m;
      vz[i] = Math.sin(a) * m;
      vy[i] = TVY[tid] * (isBurst ? 0.6 + r() * 0.6 : 0.8 + r() * 0.4);
    }
  }
  const lf = o && o.life != null ? o.life : TLIFE0[tid] + (TLIFE1[tid] - TLIFE0[tid]) * r();
  life[i] = Math.max(0.05, lf);
  age[i] = 0;
  size0[i] = o && o.size != null ? o.size * (0.85 + r() * 0.3) : TSIZE0[tid] + (TSIZE1[tid] - TSIZE0[tid]) * r();
  grow[i] = o && o.grow != null ? o.grow : TGROW[tid];
  let col = T.col;
  if (o && o.colors && o.colors.length) col = o.colors[Math.floor(r() * o.colors.length)];
  else if (o && o.color != null) col = o.color;
  else if (tid === TYPE_ID.confetti) col = CONFETTI_COLS[Math.floor(r() * CONFETTI_COLS.length)];
  else if (tid === TYPE_ID.leaf) col = LEAF_COLS[Math.floor(r() * LEAF_COLS.length)];
  if (typeof col === 'number') col = VC.fxgl.palRGB(col, tmp3);
  else if (typeof col === 'string') col = VC.color.toLinear(VC.color.rgb(col));
  if (!col || col.length < 3) col = T.col;
  const jv = TK[tid] === K_SOFT ? 0.9 + r() * 0.2 : 1;
  cr[i] = col[0] * jv; cg[i] = col[1] * jv; cb[i] = col[2] * jv;
  ca[i] = o && o.alpha != null ? o.alpha : TA[tid];
  rot[i] = r() * M.PI2;
  rotV[i] = (r() - 0.5) * (TK[tid] === K_CUBE ? 14 : 1.2);
  seed[i] = r();
  emis[i] = o && o.emissive ? o.emissive : 0;
  ptype[i] = tid;
  rest[i] = 0;
  return i;
}

function kill(k) {
  const i = active[k];
  active[k] = active[--nActive];
  freeList[nFree++] = i;
}

/* ------------------------------------------------------------------ */
/* Simulation                                                           */
/* ------------------------------------------------------------------ */
function simulate(S, dt) {
  const wx = S.weather || {};
  const wa = wx.windDir || 0, ws = 0.4 + (wx.wind == null ? 0.5 : wx.wind) * 2.2;
  const windX = Math.cos(wa) * ws, windZ = Math.sin(wa) * ws;
  const STEP = C.STEP, W = S.W, H = S.H, hgt = S.height, SEA_Y = C.SEA_Y, SEA = C.SEA;
  for (let t = 0; t < NT; t++) {
    const d = TDRAG[t];
    DK[t] = d ? Math.exp(-d * dt) : 1;
    DKY[t] = TBUOY[t] ? Math.exp(-d * 0.5 * dt) : DK[t];
  }
  for (let k = nActive - 1; k >= 0; k--) {
    const i = active[k];
    const a = (age[i] += dt);
    if (a >= life[i]) { kill(k); continue; }
    if (rest[i]) continue;
    const ty = ptype[i], kind = TK[ty];
    // forces
    const dk = DK[ty], wf = TWIND[ty];
    if (wf) {
      const f = 1 - dk;
      vx[i] += (windX * wf - vx[i]) * f;
      vz[i] += (windZ * wf - vz[i]) * f;
    } else {
      vx[i] *= dk;
      vz[i] *= dk;
    }
    vy[i] = vy[i] * DKY[ty] + (TBUOY[ty] - TGRAV[ty]) * dt;
    const fl = TFLUT[ty];
    if (fl) {
      const s = seed[i] * 40;
      vx[i] += Math.sin(a * 5.3 + s) * fl * dt * 3;
      vz[i] += Math.cos(a * 4.1 + s) * fl * dt * 3;
    }
    px[i] += vx[i] * dt;
    py[i] += vy[i] * dt;
    pz[i] += vz[i] * dt;
    rot[i] += rotV[i] * dt;
    if (kind === K_CUBE || kind === K_DROP) {
      // ground collision for cubes and droplets
      const tx = px[i] | 0, tz = pz[i] | 0;
      let gy = SEA_Y;
      let water = true;
      if (tx >= 0 && tz >= 0 && tx < W && tz < H) {
        const h = hgt[tz * W + tx];
        if (h >= SEA) { gy = h * STEP; water = false; }
      }
      const half = kind === K_CUBE ? size0[i] * 0.5 : 0;
      if (py[i] < gy + half) {
        if (water || kind === K_DROP) {
          // sink / vanish in water or on ground (droplets)
          if (age[i] < life[i] - 0.25) age[i] = life[i] - 0.25;
          if (water && kind === K_CUBE) { vy[i] *= 0.2; vx[i] *= 0.5; vz[i] *= 0.5; }
          else { vy[i] = 0; vx[i] = vz[i] = 0; py[i] = gy + half; }
        } else {
          py[i] = gy + half;
          if (vy[i] < -0.6) {
            vy[i] = -vy[i] * TBOUNCE[ty];
            vx[i] *= 0.65; vz[i] *= 0.65; rotV[i] *= 0.6;
          } else {
            vy[i] = 0; vx[i] *= 0.5; vz[i] *= 0.5; rotV[i] = 0;
            if (Math.abs(vx[i]) + Math.abs(vz[i]) < 0.05) rest[i] = 1;
          }
        }
      }
    } else if (py[i] < SEA_Y && kind !== K_RING && kind !== K_FLAT) {
      // sprites entirely below the water surface (over water or off the map) are invisible: the water
      // writes no depth, so they would otherwise draw on top of it (the shaders clip partly submerged ones)
      const tx = Math.floor(px[i]), tz = Math.floor(pz[i]);
      if (tx < 0 || tz < 0 || tx >= W || tz >= H || hgt[tz * W + tx] < SEA) {
        const u = 1 - a / life[i];
        const s = size0[i] * (1 + (grow[i] - 1) * (1 - u * u));
        if (py[i] + s < SEA_Y) kill(k);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Instance building (camera-sorted)                                    */
/* ------------------------------------------------------------------ */
function buildInstances() {
  const cam = VC.camera, F = VC.fxgl.frustum, PL = F.planes;
  F.update(cam.viewProj);
  const cx = cam.pos[0], cy = cam.pos[1], cz = cam.pos[2];
  // camera forward from the view matrix (third row, negated)
  const v = cam.view;
  const fx = -v[2], fy = -v[6], fz = -v[10];
  nSoft = 0; nAdd = 0; nCube = 0;
  let dmin = 1e9, dmax = -1e9;
  const TIME = VC.gfx.time;
  for (let k = 0; k < nActive; k++) {
    const i = active[k];
    const ty = ptype[i], kind = TK[ty];
    const t = age[i] / life[i], u = 1 - t;
    const s = size0[i] * (1 + (grow[i] - 1) * (1 - u * u));
    const x = px[i], y = py[i], z = pz[i], rr = s + 0.2;
    // frustum test (inlined)
    let vis = true;
    for (let p = 0; p < 24; p += 4) {
      if (PL[p] * x + PL[p + 1] * y + PL[p + 2] * z + PL[p + 3] < -rr) { vis = false; break; }
    }
    if (!vis) continue;
    if (kind === K_CUBE) {
      const o = nCube++ * 12, d = cubeData;
      const sc = t > 0.85 ? s * (1 - (t - 0.85) / 0.15) : s;
      d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = sc;
      d[o + 4] = cr[i]; d[o + 5] = cg[i]; d[o + 6] = cb[i]; d[o + 7] = emis[i];
      const sd = seed[i] * 6.2831;
      d[o + 8] = Math.cos(sd); d[o + 9] = 0.6; d[o + 10] = Math.sin(sd); d[o + 11] = rot[i];
      continue;
    }
    if (kind === K_ADD || kind === K_STAR || kind === K_FIRE) {
      // alpha envelope: quick fade in, fade out at the end (smoothstep(0.55, 1, t))
      let e = (t - 0.55) / 0.45;
      e = e < 0 ? 0 : e > 1 ? 1 : e;
      let a = ca[i] * (t < 0.1 ? t * 10 : 1) * (1 - e * e * (3 - 2 * e));
      const fl = TFLICK[ty];
      if (fl) {
        let e2 = (t - 0.4) / 0.6;
        e2 = e2 < 0 ? 0 : e2 > 1 ? 1 : e2;
        a *= 1 - fl * (0.5 + 0.5 * Math.sin(TIME * 23 + seed[i] * 50)) * e2 * e2 * (3 - 2 * e2);
      }
      const pu = TPULSE[ty];
      if (pu) {
        const sn = Math.sin(TIME * pu + seed[i] * 40);
        a *= 0.1 + 0.9 * (sn > 0 ? sn : 0);
      }
      const o = nAdd++ * 12, d = addData;
      let r = cr[i], g = cg[i], b = cb[i];
      if (kind === K_FIRE) {
        // incandescent gradient: white-yellow -> orange -> deep red, tinted by the particle colour
        r *= 1.2 + 3.8 * u; g *= 0.25 + 2.3 * u * u; b *= 0.05 + 1.2 * u * u * u;
        a *= 0.85 + 0.3 * Math.sin(TIME * 30 + seed[i] * 70);
      }
      d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = s;
      d[o + 4] = r; d[o + 5] = g; d[o + 6] = b; d[o + 7] = a;
      d[o + 8] = rot[i]; d[o + 9] = kind; d[o + 10] = seed[i]; d[o + 11] = 0;
      continue;
    }
    const n = nSoft++;
    const dd = (x - cx) * fx + (y - cy) * fy + (z - cz) * fz;
    softIdx[n] = i;
    softDepth[n] = dd;
    if (dd < dmin) dmin = dd;
    if (dd > dmax) dmax = dd;
  }
  // bucket sort soft particles far -> near
  if (nSoft) {
    bucketCount.fill(0);
    const inv = (NB - 1) / Math.max(1e-3, dmax - dmin);
    for (let n = 0; n < nSoft; n++) {
      const b = NB - 1 - (((softDepth[n] - dmin) * inv) | 0);
      softDepth[n] = b;
      bucketCount[b]++;
    }
    let off = 0;
    for (let b = 0; b < NB; b++) { bucketOff[b] = off; off += bucketCount[b]; }
    for (let n = 0; n < nSoft; n++) order[bucketOff[softDepth[n]]++] = softIdx[n];
    for (let n = 0; n < nSoft; n++) {
      const i = order[n];
      const kind = TK[ptype[i]];
      const t = age[i] / life[i], u = 1 - t;
      const s = size0[i] * (1 + (grow[i] - 1) * (1 - u * u));
      const e0 = kind === K_RING ? 0.2 : 0.5;
      let e = (t - e0) / (1 - e0);
      e = e < 0 ? 0 : e > 1 ? 1 : e;
      const a = ca[i] * (t < 0.125 ? t * 8 : 1) * (1 - e * e * (3 - 2 * e));
      const o = n * 12, d = softData;
      d[o] = px[i]; d[o + 1] = py[i]; d[o + 2] = pz[i]; d[o + 3] = s;
      d[o + 4] = cr[i]; d[o + 5] = cg[i]; d[o + 6] = cb[i]; d[o + 7] = a;
      d[o + 8] = rot[i]; d[o + 9] = kind; d[o + 10] = seed[i]; d[o + 11] = emis[i] * u * u;
    }
  }
  Pt.stats.soft = nSoft;
  Pt.stats.add = nAdd;
  Pt.stats.cube = nCube;
}

/* ------------------------------------------------------------------ */
/* Automatic effects                                                     */
/* ------------------------------------------------------------------ */
/** Reusable spawn options for internal emitters (no per-particle object allocation). */
const SO = { vx: 0, vy: 0, vz: 0, size: null, life: null, alpha: null, color: null, colors: null, emissive: 0, spread: null, jitter: null, grow: null };
function so(vx, vy, vz, size, life, alpha, color, emissive) {
  SO.vx = vx; SO.vy = vy; SO.vz = vz;
  SO.size = size == null ? null : size;
  SO.life = life == null ? null : life;
  SO.alpha = alpha == null ? null : alpha;
  SO.color = color || null;
  SO.colors = null;
  SO.emissive = emissive || 0;
  SO.spread = null; SO.jitter = null; SO.grow = null;
  return SO;
}
let emitList = []; // cell-registry entries (VC.fxgl.cells) of buildings with emitters near the camera
let hearthList = []; // winter: small houses with a chimney fire near the camera
let nextEmit = [], nextHearth = []; // being filled by the running (sliced) scan
let season = 1, natureAcc = 0;
const burnSet = new Set(); // burning buildings (from bldChange: sim.ignite announces every fire)
const burnList = []; // burning buildings near the camera
const buildList = []; // buildings under construction
const nearBuf = []; // entries of the running scan (VC.fxgl.cells.near)
const levelSeen = new WeakMap();
let scanT = 0, scanI = 0, scanN = 0, scanR2 = 0, scanH2 = 0;
const SCAN_SLICE = 2500; // entries examined per frame by a running scan
const EM_TYPES = { smoke: 0, steam: 1, fire: 2, sparkle: 3, fountain: 4 };
const EM_NAMES = ['smoke', 'steam', 'fire', 'sparkle', 'fountain'];
const EM_RATE = [1.4, 1.7, 6, 2, 26];

/**
 * Building b's model ONLY if it is already built (VC.fxgl.cachedModel): particles never generate / mesh /
 * upload models synchronously; the building renderer builds them within its frame budget and the next
 * scan picks them up.
 */
function modelOf(b) {
  return VC.fxgl.cachedModel(b);
}
VC.fxgl.modelOf = modelOf;

/** World-space emitter points of entry e's building (cached on the entry: e.pEm). */
function emittersOf(e, m) {
  const b = e.b;
  let c = e.pEm;
  if (c && c.model === m && c.rot === b.rot && c.x === b.x && c.z === b.z) return c;
  const list = (m && m.emitters) || [];
  const pts = new Float32Array(list.length * 5);
  for (let k = 0; k < list.length; k++) {
    const em = list[k];
    const w = VC.models.localToWorld(b, m, em.x, em.y, em.z);
    pts[k * 5] = w[0]; pts[k * 5 + 1] = w[1]; pts[k * 5 + 2] = w[2];
    pts[k * 5 + 3] = EM_TYPES[em.type] != null ? EM_TYPES[em.type] : 0;
    pts[k * 5 + 4] = em.rate == null ? 1 : em.rate;
  }
  const acc = new Float32Array(list.length);
  for (let k = 0; k < acc.length; k++) acc[k] = rnd(); // random phase: puffs start right away, unsynchronized
  c = e.pEm = { model: m, rot: b.rot, x: b.x, z: b.z, pts, acc };
  return c;
}

/**
 * Every 0.3 s a scan collects the model emitters and winter hearths among the buildings of the 8x8 cells
 * around the camera (VC.fxgl.cells, maintained incrementally from bldAdd / bldRemove / bldChange; built,
 * powered and abandoned are polled). It runs sliced over a few frames (SCAN_SLICE entries each) and then
 * replaces the lists. Buildings whose model is not built yet are skipped until it is. Burning buildings
 * come from burnSet (every fire is announced with bldChange), not from the scan.
 */
function scanStart(S) {
  const cells = VC.fxgl.cells;
  cells.sync();
  const cam = VC.camera;
  const R = M.clamp(40 + cam.dist * 0.6, 50, 110);
  scanR2 = R * R;
  scanH2 = scanR2 * 0.3;
  season = VC.fxgl.season(S);
  nextEmit.length = 0;
  nextHearth.length = 0;
  scanN = cells.near(cam.tx, cam.tz, R, nearBuf);
  scanI = 0;
  // burning buildings near the camera (small set)
  burnList.length = 0;
  const B2 = scanR2 * 2.2;
  for (const b of burnSet) {
    if (!(b.fire > 0) || !S.buildings.has(b.id)) { burnSet.delete(b); continue; }
    const dx = b.x + b.w * 0.5 - cam.tx, dz = b.z + b.d * 0.5 - cam.tz;
    if (dx * dx + dz * dz < B2) burnList.push(b);
  }
  for (let k = buildList.length - 1; k >= 0; k--) {
    const b = buildList[k];
    if (b.built >= 1 || !S.buildings.has(b.id)) buildList.splice(k, 1);
  }
  Pt.stats.burning = burnList.length;
}
/** Examines up to `budget` entries of the running scan; publishes the lists when it is complete. */
function scanStep(budget) {
  const cells = VC.fxgl.cells, cam = VC.camera, PL = VC.fxgl.frustum.planes;
  const end = Math.min(scanN, scanI + budget);
  for (let k = scanI; k < end; k++) {
    const e = nearBuf[k], b = e.b;
    const bx = b.x + b.w * 0.5, bz = b.z + b.d * 0.5;
    const dx = bx - cam.tx, dz = bz - cam.tz;
    const d2 = dx * dx + dz * dz;
    if (d2 > scanR2 || b.fire > 0 || b.built < 1 || b.abandoned || b.powered === false || b.key === 'rubble') continue;
    if (season === 3 && d2 < scanH2 && b.key === 'grow' && b.zt === 1 && (b.den === 1 || b.level === 1) && nextHearth.length < 48) nextHearth.push(b);
    const m = cells.model(e);
    if (!m || !m.emitters || !m.emitters.length) continue;
    const by = VC.world.topY(b.x, b.z) + m.height * 0.5, r = m.height + Math.max(b.w, b.d) + 3;
    let vis = true;
    for (let p = 0; p < 24; p += 4) {
      if (PL[p] * bx + PL[p + 1] * by + PL[p + 2] * bz + PL[p + 3] < -r) { vis = false; break; }
    }
    if (vis) nextEmit.push(e);
  }
  scanI = end;
  if (scanI < scanN) return;
  // complete: publish (swap the double-buffered lists)
  let t = emitList; emitList = nextEmit; nextEmit = t;
  t = hearthList; hearthList = nextHearth; nextHearth = t;
  nearBuf.length = 0;
  scanN = 0;
  scanI = 0;
  Pt.stats.emitters = emitList.length;
}

function autoEffects(S, dt) {
  scanT -= dt;
  if (scanT <= 0 && scanN === 0) {
    scanT = 0.3;
    scanStart(S);
  }
  if (scanN) scanStep(SCAN_SLICE);
  const cam = VC.camera, cap = Pt.cap();
  const room = nActive < cap * 0.8;
  const qf = cap / 3000;
  const env = VC.gfx.env || {};
  const night = env.night || 0;
  Pt.glows.begin();
  const r = rnd;
  // ---- model emitters (thinned when many are in view) ----
  const crowd = Math.min(1, Math.sqrt(14 / Math.max(1, emitList.length)));
  if (room) {
    for (let n = 0; n < emitList.length; n++) {
      const en = emitList[n], b = en.b;
      if (!VC.state.buildings.has(b.id)) continue;
      const m = en.m;
      if (!m) continue;
      const c = emittersOf(en, m);
      const pts = c.pts;
      const ex = b.x - cam.tx, ez = b.z - cam.tz;
      const dist = Math.sqrt(ex * ex + ez * ez);
      const lod = M.clamp(1.3 - dist / 90, 0.15, 1) * M.clamp(qf, 0.3, 1.5) * crowd;
      for (let e = 0; e < c.acc.length; e++) {
        const ty = pts[e * 5 + 3];
        c.acc[e] += EM_RATE[ty] * pts[e * 5 + 4] * lod * dt;
        let guard = 0;
        while (c.acc[e] >= 1 && guard++ < 8) {
          c.acc[e] -= 1;
          const x = pts[e * 5], y = pts[e * 5 + 1], z = pts[e * 5 + 2];
          if (ty === 4) spawn(TYPE_ID.fountain, x, y, z, null, true);
          else if (ty === 3) spawn(TYPE_ID.sparkle, x, y, z, null, true);
          else if (ty === 2) {
            spawn(TYPE_ID.fire, x, y, z, so((r() - 0.5) * 0.3, 0.6, (r() - 0.5) * 0.3, 0.16), false);
          } else spawn(ty === 1 ? TYPE_ID.steam : TYPE_ID.smoke, x, y, z, so((r() - 0.5) * 0.2, ty === 1 ? 1.1 : 0.8, (r() - 0.5) * 0.2, ty === 1 ? 0.3 : 0.26, null, ty === 1 ? 0.45 : 0.38), false);
        }
      }
    }
  }
  // ---- burning buildings ----
  const TIME = VC.gfx.time;
  for (let n = 0; n < burnList.length; n++) {
    const b = burnList[n];
    if (!(b.fire > 0) || !VC.state.buildings.has(b.id)) continue;
    const m = modelOf(b);
    const hgt = Math.max(0.4, (m && m.height) || b.hgt || 1);
    const gy = VC.world.topY(b.x, b.z);
    const area = b.w * b.d;
    const f = M.clamp(0.35 + b.fire, 0.35, 1.3);
    const ex = b.x + b.w / 2 - cam.tx, ez = b.z + b.d / 2 - cam.tz;
    const dist = Math.sqrt(ex * ex + ez * ez);
    const lod = M.clamp(1.4 - dist / 120, 0.2, 1);
    const flick = 0.75 + 0.25 * Math.sin(TIME * 13 + b.id) * Math.sin(TIME * 7.3 + b.id * 3);
    const cxw = b.x + b.w / 2, czw = b.z + b.d / 2;
    // light: ground pool + halo (strong at night)
    const L = (0.35 + night * 1.2) * f * flick;
    Pt.glows.add(cxw, gy + 0.05, czw, 1.6 + Math.max(b.w, b.d) * 1.1, 1.0, 0.42, 0.12, L * 1.3, 1, 0, 1, 0);
    Pt.glows.add(cxw, gy + hgt * 0.7, czw, 1.0 + hgt * 0.5 + b.w * 0.4, 1.0, 0.32, 0.06, L * 0.4, 0, 0, 1, 0);
    if (nActive >= cap * 0.95) continue;
    const nFire = (6 + 10 * Math.pow(area, 0.7)) * f * lod * dt;
    for (let k = 0; k < 6 && (k < Math.floor(nFire) || r() < nFire - k); k++) {
      const x = b.x + 0.1 + r() * (b.w - 0.2), z = b.z + 0.1 + r() * (b.d - 0.2);
      const y = gy + hgt * (0.3 + 0.75 * Math.sqrt(r()));
      spawn(TYPE_ID.fire, x, y, z, so(0, 0.8 + r() * 0.6, 0, 0.25 + 0.2 * Math.sqrt(area) * r()), false);
    }
    const nSmoke = (3 + 4 * Math.sqrt(area)) * f * lod * dt;
    for (let k = 0; k < 3 && (k < Math.floor(nSmoke) || r() < nSmoke - k); k++) {
      spawn(TYPE_ID.smoke, cxw + (r() - 0.5) * b.w * 0.6, gy + hgt + 0.1, czw + (r() - 0.5) * b.d * 0.6, so(0, 1.3 + r() * 0.4, 0, 0.3 + 0.14 * Math.sqrt(area), 5 + r() * 3, 0.7, SMOKE_DARK, 0.22), false);
    }
    if (r() < 2.5 * lod * dt * f) spawn(TYPE_ID.ember, cxw + (r() - 0.5) * b.w, gy + hgt * r(), czw + (r() - 0.5) * b.d, null, true);
  }
  // ---- seasonal ambience ----
  if (room) nature(S, dt, night);
  // ---- construction sites ----
  if (room && buildList.length) {
    for (let n = 0; n < buildList.length; n++) {
      const b = buildList[n];
      const cxw = b.x + b.w / 2, czw = b.z + b.d / 2;
      const ex = cxw - cam.tx, ez = czw - cam.tz;
      if (ex * ex + ez * ez > 4900) continue;
      const gy = VC.world.topY(b.x, b.z);
      if (r() < 1.6 * dt * Math.sqrt(b.w * b.d)) {
        const side = r() * 4 | 0;
        const x = side < 2 ? b.x + r() * b.w : side === 2 ? b.x : b.x + b.w;
        const z = side >= 2 ? b.z + r() * b.d : side === 0 ? b.z : b.z + b.d;
        spawn(TYPE_ID.dust, x, gy + 0.1, z, so((r() - 0.5) * 0.4, 0.25, (r() - 0.5) * 0.4, 0.25, null, 0.35), false);
      }
      if (night > 0.3 && r() < 0.7 * dt) {
        const m = modelOf(b);
        const top = gy + Math.max(0.3, (m ? m.height : 1) * b.built);
        spawn(TYPE_ID.spark, b.x + r() * b.w, top, b.z + r() * b.d, WELD_OPT, true);
        spawn(TYPE_ID.spark, b.x + r() * b.w, top, b.z + r() * b.d, WELD_OPT, true);
      }
    }
  }
}

/**
 * Seasonal touches around the camera: cherry petals in spring, falling leaves in autumn (more in wind),
 * fireflies on summer nights, wood smoke from small houses in winter.
 */
function nature(S, dt, night) {
  const cam = VC.camera;
  if (cam.dist > 75) return;
  const r = rnd, wx = S.weather || {};
  const wet = wx.type === 'rain' || wx.type === 'storm' || wx.type === 'snow';
  const wa = wx.windDir || 0, ws = 0.3 + (wx.wind || 0.3) * 1.5;
  // winter hearths
  if (season === 3) {
    for (let n = 0; n < hearthList.length; n++) {
      if (r() > 0.4 * dt) continue;
      const b = hearthList[n];
      if (!S.buildings.has(b.id)) continue;
      const m = modelOf(b);
      const y = VC.world.topY(b.x, b.z) + ((m && m.height) || b.hgt || 1) + 0.05;
      spawn(TYPE_ID.smoke, b.x + b.w * (0.3 + r() * 0.4), y, b.z + b.d * (0.3 + r() * 0.4), so(0, 0.5, 0, 0.1, 4 + r() * 2, 0.28, SMOKE_WOOD), false);
    }
    return;
  }
  let rate = 0;
  if (season === 0 && !wet && night < 0.5) rate = 8;
  else if (season === 2 && night < 0.6) rate = 10 + (wx.wind || 0) * 14;
  else if (season === 1 && night > 0.55 && !wet) rate = 22;
  if (!rate) return;
  natureAcc = Math.min(12, natureAcc + rate * dt);
  const R = M.clamp(cam.dist * 0.5, 8, 26);
  let guard = 0;
  while (natureAcc >= 1 && guard++ < 24) {
    natureAcc -= 1;
    const x = cam.tx + (r() * 2 - 1) * R, z = cam.tz + (r() * 2 - 1) * R;
    if (x < 0 || z < 0 || x >= S.W || z >= S.H) continue;
    const i = Math.floor(z) * S.W + Math.floor(x);
    if (S.height[i] < C.SEA) continue;
    const gy = S.height[i] * C.STEP;
    if (season === 1) {
      if (S.bld[i] || S.road[i]) continue;
      spawn(TYPE_ID.firefly, x, gy + 0.2 + r() * 0.7, z, null, true);
      continue;
    }
    if (!S.trees[i]) continue;
    const cols = season === 0 ? PETAL_COLS : AUTUMN_COLS;
    const o = so(Math.cos(wa) * ws * 0.4, -0.1, Math.sin(wa) * ws * 0.4, season === 0 ? 0.04 : 0.055, 5 + r() * 3);
    o.colors = cols;
    spawn(TYPE_ID.leaf, x, gy + 0.9 + r() * 0.6, z, o, false);
  }
}

/* ---------------- world event handlers ---------------- */
function nearCam(x, z, r) {
  const cam = VC.camera, dx = x - cam.tx, dz = z - cam.tz, R = r + cam.dist * 0.8;
  return dx * dx + dz * dz < R * R;
}
function onBldAdd(b) {
  if (b.built < 1) {
    buildList.push(b);
    const cx = b.x + b.w / 2, cz = b.z + b.d / 2;
    if (nearCam(cx, cz, 60)) Pt.burst('dust', cx, VC.world.topY(b.x, b.z) + 0.15, cz, 4 + b.w * b.d * 2, { jitter: Math.max(b.w, b.d) * 0.45 });
  }
  levelSeen.set(b, b.level);
}
/** A few representative colours of a model (non-glass, non-emissive voxels), as linear RGB. */
const colorCache = new WeakMap();
function modelColors(m) {
  if (!m || !m.grid) return null;
  let c = colorCache.get(m);
  if (c) return c;
  const g = m.grid, v = g.v, counts = new Map();
  const step = Math.max(1, Math.floor(v.length / 1500));
  for (let i = 0; i < v.length; i += step) {
    const p = v[i];
    if (!p) continue;
    const f = VC.voxel.flags(p);
    if (f & (VC.MAT.EMISSIVE | VC.MAT.WINDOW | VC.MAT.NIGHTLIGHT)) continue;
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  c = top.map(([p]) => VC.fxgl.palRGB(p, [0, 0, 0]));
  if (!c.length) c = null;
  colorCache.set(m, c);
  return c;
}
function onBldRemove(b) {
  const why = b.removed;
  if (why !== 'bulldoze' && why !== 'disaster' && why !== 'fire') return;
  const cx = b.x + b.w / 2, cz = b.z + b.d / 2;
  if (!nearCam(cx, cz, 70)) return;
  const gy = VC.world.topY(b.x, b.z);
  let m = null;
  try { m = b.key === 'rubble' ? null : modelOf(b); } catch (e) { m = null; } // (cached only: never builds)
  const hgt = (m && m.height) || b.hgt || 0.5;
  const area = b.w * b.d;
  const cols = modelColors(m) || [[0.45, 0.43, 0.4], [0.3, 0.28, 0.26]];
  const jit = Math.max(b.w, b.d) * 0.4;
  const nDeb = Math.min(70, Math.round(8 + area * 4 + hgt * 4)) * (why === 'fire' ? 0.5 : 1);
  Pt.burst('debris', cx, gy + Math.min(hgt, 3) * 0.5, cz, nDeb, { colors: cols, jitter: jit });
  Pt.burst('dust', cx, gy + 0.3, cz, Math.min(40, 6 + area * 4), { jitter: jit, color: why === 'fire' ? [0.2, 0.19, 0.18] : null });
  if (why === 'fire') Pt.burst('smoke', cx, gy + 0.5, cz, 6 + area * 2, { jitter: jit, color: [0.12, 0.11, 0.1] });
}
function onBldChange(b) {
  if (b.fire > 0) burnSet.add(b); // (sim.ignite announces every new fire with world.changed)
  const prev = levelSeen.get(b);
  levelSeen.set(b, b.level);
  if (prev == null || !(b.level > prev) || b.built < 1) return;
  const cx = b.x + b.w / 2, cz = b.z + b.d / 2;
  if (!nearCam(cx, cz, 60)) return;
  let hgt = b.hgt || 1;
  try { const m = modelOf(b); if (m) hgt = m.height; } catch (e) { /* ignore */ } // (cached only; else b.hgt)
  const gy = VC.world.topY(b.x, b.z);
  Pt.burst('sparkle', cx, gy + hgt + 0.3, cz, 18 + b.w * b.d * 4, { jitter: Math.max(b.w, b.d) * 0.5 });
}
function onBuilt(e) {
  if (!e || e.x == null) return;
  const S = VC.state;
  const w = Math.max(1, e.w || 1), d = Math.max(1, e.d || 1);
  if (!nearCam(e.x + w / 2, e.z + d / 2, 60 + Math.max(w, d))) return;
  const kind = e.kind;
  const n = w * d;
  const stride = Math.max(1, Math.ceil(n / 36));
  let k = 0;
  for (let z = e.z; z < e.z + d; z++)
    for (let x = e.x; x < e.x + w; x++) {
      if (k++ % stride) continue;
      if (x < 0 || z < 0 || x >= S.W || z >= S.H) continue;
      const i = z * S.W + x;
      if (kind === 'road' && !S.road[i]) continue;
      if (kind === 'zone' && !S.zone[i]) continue;
      if (kind === 'pline' && !S.pline[i]) continue;
      const y = VC.fxgl.surfaceY(x + 0.5, z + 0.5) + 0.05;
      if (kind === 'trees') {
        Pt.burst('leaf', x + 0.5, y + 0.4, z + 0.5, 5, null);
        continue;
      }
      if (kind === 'zone') {
        if (rnd() < 0.5) Pt.burst('sparkle', x + 0.5, y + 0.1, z + 0.5, 1, { jitter: 0.4, color: [1.2, 1.6, 2.2] });
        continue;
      }
      Pt.burst('dust', x + 0.5, y, z + 0.5, kind === 'terraform' ? 3 : 2, { jitter: 0.4, alpha: 0.4 });
      if (kind === 'terraform' || kind === 'bulldoze') Pt.burst('debris', x + 0.5, y + 0.1, z + 0.5, 2, { colors: [[0.35, 0.26, 0.17], [0.45, 0.38, 0.3]], spread: 1.2 });
    }
}

/* ------------------------------------------------------------------ */
/* GL                                                                    */
/* ------------------------------------------------------------------ */
const SVS = `
layout(location=0) in vec4 aP0;
layout(location=1) in vec4 aP1;
layout(location=2) in vec4 aP2;
out vec2 vUv; flat out vec4 vCol; flat out vec4 vP; out vec3 vWp;
void main(){
  vec2 q = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  bool flame = abs(aP2.y - 6.0) < 0.5;
  float ang = flame ? sin(aP2.x * 3.0 + TIME * 4.0) * 0.12 : aP2.x;
  float c = cos(ang), s = sin(ang);
  vec2 rq = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  if (flame) rq.y = rq.y * 1.7 + 0.5;
  vec3 camR = vec3(uView[0][0], uView[1][0], uView[2][0]);
  vec3 camU = vec3(uView[0][1], uView[1][1], uView[2][1]);
  if (aP2.y > 6.5) { camR = vec3(1.0, 0.0, 0.0); camU = vec3(0.0, 0.0, 1.0); }
  vec3 wp = aP0.xyz + (camR * rq.x + camU * rq.y) * aP0.w;
  vUv = q; vCol = aP1; vP = aP2; vWp = wp;
  gl_Position = uViewProj * vec4(wp, 1.0);
}`;
// under the water surface of a water tile (the water writes no depth, so test it here)
const UNDERWATER = `
bool underWater(vec3 wp){ return wp.y < SEA_Y && (int(tileData(wp.xz).b * 255.0 + 0.5) & 16) != 0; }`;
const SFS_SOFT = UNDERWATER + `
in vec2 vUv; flat in vec4 vCol; flat in vec4 vP; in vec3 vWp;
out vec4 fragColor;
void main(){
  int kind = int(vP.y + 0.5);
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  if (kind == 0 && underWater(vWp)) discard; // smoke / steam / dust (drops, rings, wakes sit on the surface)
  vec3 col = vCol.rgb;
  float a;
  if (kind == 0) {
    float n = tnoise(vUv * 0.21 + vP.z * 7.31).r * 0.65 + tnoise(vUv * 0.47 + vP.z * 3.17 + 0.5).g * 0.35;
    a = smoothstep(1.0, 0.2, r2 + (n - 0.5) * 0.9);
    vec3 camR = vec3(uView[0][0], uView[1][0], uView[2][0]);
    vec3 camU = vec3(uView[0][1], uView[1][1], uView[2][1]);
    vec3 camF = normalize(uCamPos.xyz - vWp);
    vec3 nrm = normalize(camR * vUv.x + camU * vUv.y + camF * sqrt(1.0 - r2) * 1.3);
    float ndl = max(dot(nrm, uSunDir.xyz), 0.0);
    vec3 light = uSkyAmb.rgb * 0.85 + uGroundAmb.rgb * 0.45 + uSunColor.rgb * uSunDir.w * (0.2 + 0.8 * ndl) * 0.7
               + vec3(0.8, 0.85, 1.0) * uMisc.z * 1.6;
    col = col * light * (0.7 + 0.6 * n) + vec3(1.0, 0.42, 0.1) * vP.w * (1.2 - r2);
  } else if (kind == 7) {
    float n = tnoise(vUv * 0.3 + vP.z * 9.1).r;
    float r = sqrt(r2);
    a = smoothstep(1.0, 0.55, r) * (0.35 + 0.65 * smoothstep(0.35, 0.7, n + r * 0.35));
    col = col * (uSkyAmb.rgb * 1.1 + uSunColor.rgb * uSunDir.w * 0.55) ;
  } else if (kind == 2) {
    a = smoothstep(1.0, 0.45, r2);
    vec3 light = uSkyAmb.rgb * 1.1 + uSunColor.rgb * uSunDir.w * 0.5 + vec3(0.8, 0.85, 1.0) * uMisc.z;
    col = col * light + vec3(1.0) * pow(max(0.0, 1.0 - length(vUv - vec2(-0.35, 0.35)) * 2.2), 3.0) * (0.3 + uSunDir.w * 0.6);
  } else {
    float r = sqrt(r2);
    float d = (r - 0.72) / 0.16;
    a = exp(-d * d);
    col = col * (uSkyAmb.rgb * 1.3 + uSunColor.rgb * uSunDir.w * 0.3 + vec3(0.6) * uMisc.z);
  }
  col = applyFog(col, vWp);
  fragColor = vec4(col, a * vCol.a);
}`;
const SFS_ADD = UNDERWATER + `
in vec2 vUv; flat in vec4 vCol; flat in vec4 vP; in vec3 vWp;
out vec4 fragColor;
void main(){
  int kind = int(vP.y + 0.5);
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0 && kind != 6) discard;
  if (underWater(vWp)) discard;
  float a;
  if (kind == 4) {
    float cx = exp(-abs(vUv.x) * 16.0) * (1.0 - abs(vUv.y));
    float cy = exp(-abs(vUv.y) * 16.0) * (1.0 - abs(vUv.x));
    a = exp(-r2 * 22.0) * 1.4 + (cx + cy) * 0.9;
  } else if (kind == 6) {
    // teardrop flame: wide at the base, licking to a point at the top
    float n = tnoise(vUv * 0.3 + vP.z * 5.7 + vec2(0.0, -TIME * 0.9)).r;
    float w = mix(1.0, 0.3, vUv.y * 0.5 + 0.5);
    float d = length(vec2(vUv.x / w, vUv.y));
    a = smoothstep(1.0, 0.05, d + (n - 0.5) * 0.7) * (0.7 + 0.6 * n);
  } else {
    a = exp(-r2 * 4.5) * 0.8 + exp(-r2 * 22.0) * 0.8;
  }
  float fogK = exp(-length(vWp - uCamPos.xyz) * uFog.w * 0.7);
  fragColor = vec4(vCol.rgb * vCol.a * a * fogK, 0.0);
}`;
const CVS = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec4 aC0;
layout(location=3) in vec4 aC1;
layout(location=4) in vec4 aC2;
out vec3 vWp; flat out vec3 vN; flat out vec4 vCol;
vec3 rotAxis(vec3 v, vec3 k, float a){ float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }
void main(){
  vec3 k = normalize(aC2.xyz);
  vec3 p = rotAxis(aPos, k, aC2.w) * aC0.w;
  vN = rotAxis(aNrm, k, aC2.w);
  vWp = aC0.xyz + p;
  vCol = aC1;
  gl_Position = uViewProj * vec4(vWp, 1.0);
}`;
const CFS = `
in vec3 vWp; flat in vec3 vN; flat in vec4 vCol;
out vec4 fragColor;
void main(){
  vec3 n = normalize(vN);
  vec3 c = shade(vCol.rgb, n, vWp, 1.0) + vCol.rgb * vCol.a;
  c += specular(n, vWp, 40.0, 0.15);
  fragColor = vec4(applyFog(c, vWp), 1.0);
}`;

const GLR = {};
function initGL() {
  const G = VC.gfx, gl = G.gl;
  GLR.soft = G.program('particles_soft', SVS, SFS_SOFT);
  GLR.add = G.program('particles_add', SVS, SFS_ADD);
  GLR.cube = G.program('particles_cube', CVS, CFS);
  GLR.spriteVao = gl.createVertexArray();
  GLR.softBuf = gl.createBuffer();
  GLR.addBuf = gl.createBuffer();
  // unit cube: 6 faces x 4 verts (pos + normal), CCW outward
  const F = [
    [[1, 0, 0], [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]]],
    [[-1, 0, 0], [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]]],
    [[0, 1, 0], [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]]],
    [[0, -1, 0], [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]]],
    [[0, 0, 1], [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]]],
    [[0, 0, -1], [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]]],
  ];
  const vd = [], id = [];
  F.forEach(([n, vs], f) => {
    for (const v of vs) vd.push(v[0], v[1], v[2], n[0], n[1], n[2]);
    const b = f * 4;
    id.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  GLR.cubeVao = gl.createVertexArray();
  gl.bindVertexArray(GLR.cubeVao);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vd), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(id), gl.STATIC_DRAW);
  GLR.cubeBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, GLR.cubeBuf);
  for (let k = 0; k < 3; k++) {
    gl.enableVertexAttribArray(2 + k);
    gl.vertexAttribPointer(2 + k, 4, gl.FLOAT, false, 48, k * 16);
    gl.vertexAttribDivisor(2 + k, 1);
  }
  gl.bindVertexArray(null);
}

function drawCubes(ctx) {
  if (!nCube) return;
  const gl = ctx.gl;
  GLR.cube.use();
  gl.bindVertexArray(GLR.cubeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, GLR.cubeBuf);
  gl.bufferData(gl.ARRAY_BUFFER, cubeData, gl.DYNAMIC_DRAW, 0, nCube * 12); // (offset/length: no subarray view per frame)
  gl.drawElementsInstanced(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0, nCube);
  gl.bindVertexArray(null);
}

function bindSprites(gl, buf, data, n) {
  gl.bindVertexArray(GLR.spriteVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW, 0, n * 12);
  for (let k = 0; k < 3; k++) {
    gl.enableVertexAttribArray(k);
    gl.vertexAttribPointer(k, 4, gl.FLOAT, false, 48, k * 16);
    gl.vertexAttribDivisor(k, 1);
  }
}

function drawSprites(ctx) {
  const gl = ctx.gl;
  gl.disable(gl.CULL_FACE);
  if (nSoft) {
    GLR.soft.use();
    bindSprites(gl, GLR.softBuf, softData, nSoft);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nSoft);
  }
  if (nAdd) {
    gl.blendFunc(gl.ONE, gl.ONE);
    GLR.add.use();
    bindSprites(gl, GLR.addBuf, addData, nAdd);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nAdd);
  }
  gl.bindVertexArray(null);
}
