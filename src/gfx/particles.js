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
 *   coloured from the building's model; dust puffs for 'built' events; sparkles on level-ups.
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
  firework: { k: K_ADD, life: [1.3, 2.3], size: [0.09, 0.13], grow: 0.35, col: [3, 3, 3], a: 1, grav: 1.1, drag: 1.5, spread: 5, jit: 0, flicker: 0.4 },
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
const CONFETTI_COLS = [[1, 0.2, 0.25], [1, 0.8, 0.1], [0.2, 0.6, 1], [0.3, 0.9, 0.35], [0.9, 0.35, 1], [1, 0.55, 0.1], [1, 1, 1]];
const LEAF_COLS = [[0.2, 0.42, 0.1], [0.32, 0.5, 0.12], [0.55, 0.45, 0.1], [0.7, 0.32, 0.08]];

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

let rnd = M.rng(99);
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
    VC.bus.on('bldAdd', onBldAdd);
    VC.bus.on('bldRemove', onBldRemove);
    VC.bus.on('bldChange', onBldChange);
    VC.bus.on('built', onBuilt);
  },
  reset(S) {
    Pt.clear();
    rnd = M.rng((S.seed ^ 0x9a17) >>> 0);
    scanT = 0;
    emitList.length = 0;
    burnList.length = 0;
    buildList.length = 0;
    for (const b of S.buildings.values()) if (b.built < 1) buildList.push(b);
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
    Pt.stats.ms = +(performance.now() - t0).toFixed(2);
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
  const j = o && o.jitter != null ? o.jitter : isBurst ? T.jit || 0 : 0;
  px[i] = x + (j ? (r() - 0.5) * 2 * j : 0);
  py[i] = y + (j ? (r() - 0.5) * j : 0);
  pz[i] = z + (j ? (r() - 0.5) * 2 * j : 0);
  if (o && o.vx != null) {
    vx[i] = o.vx; vy[i] = o.vy || 0; vz[i] = o.vz || 0;
    if (isBurst && o.spread) {
      vx[i] += (r() - 0.5) * o.spread; vy[i] += (r() - 0.5) * o.spread; vz[i] += (r() - 0.5) * o.spread;
    }
  } else {
    const sp = o && o.spread != null ? o.spread : T.spread || 0;
    if (isBurst && (tid === TYPE_ID.firework || tid === TYPE_ID.spark || tid === TYPE_ID.willow)) {
      // spherical shell
      const u = r() * 2 - 1, a = r() * M.PI2, s = Math.sqrt(1 - u * u), m = sp * (0.55 + 0.45 * Math.cbrt(r()));
      vx[i] = Math.cos(a) * s * m; vy[i] = u * m + (T.vy || 0) * 0.3; vz[i] = Math.sin(a) * s * m;
    } else {
      const a = r() * M.PI2, m = sp * (isBurst ? 0.3 + r() * 0.7 : r() * 0.5);
      vx[i] = Math.cos(a) * m;
      vz[i] = Math.sin(a) * m;
      vy[i] = (T.vy || 0) * (isBurst ? 0.6 + r() * 0.6 : 0.8 + r() * 0.4);
    }
  }
  const lf = o && o.life != null ? o.life : M.lerp(T.life[0], T.life[1], r());
  life[i] = Math.max(0.05, lf);
  age[i] = 0;
  size0[i] = o && o.size != null ? o.size * (0.85 + r() * 0.3) : M.lerp(T.size[0], T.size[1], r());
  grow[i] = o && o.grow != null ? o.grow : T.grow || 1;
  let col = T.col;
  if (o && o.colors && o.colors.length) col = o.colors[Math.floor(r() * o.colors.length)];
  else if (o && o.color != null) col = o.color;
  else if (tid === TYPE_ID.confetti) col = CONFETTI_COLS[Math.floor(r() * CONFETTI_COLS.length)];
  else if (tid === TYPE_ID.leaf) col = LEAF_COLS[Math.floor(r() * LEAF_COLS.length)];
  if (typeof col === 'number') col = VC.fxgl.palRGB(col, tmp3);
  const jv = T.k === K_SOFT ? 0.9 + r() * 0.2 : 1;
  cr[i] = col[0] * jv; cg[i] = col[1] * jv; cb[i] = col[2] * jv;
  ca[i] = o && o.alpha != null ? o.alpha : T.a == null ? 1 : T.a;
  rot[i] = r() * M.PI2;
  rotV[i] = (r() - 0.5) * (T.k === K_CUBE ? 14 : 1.2);
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
  const STEP = C.STEP, W = S.W, H = S.H, hgt = S.height, SEA_Y = C.SEA_Y;
  for (let k = nActive - 1; k >= 0; k--) {
    const i = active[k];
    const a = (age[i] += dt);
    if (a >= life[i]) { kill(k); continue; }
    const T = TYPE_LIST[ptype[i]];
    if (rest[i]) continue;
    // forces
    const drag = T.drag || 0;
    const dk = drag ? Math.exp(-drag * dt) : 1;
    if (T.wind) {
      const f = 1 - dk;
      vx[i] += (windX * T.wind - vx[i]) * f;
      vz[i] += (windZ * T.wind - vz[i]) * f;
    } else {
      vx[i] *= dk;
      vz[i] *= dk;
    }
    vy[i] = vy[i] * (T.buoy ? Math.exp(-drag * 0.5 * dt) : dk) + ((T.buoy || 0) - (T.grav || 0)) * dt;
    if (T.flutter) {
      const s = seed[i] * 40;
      vx[i] += Math.sin(a * 5.3 + s) * T.flutter * dt * 3;
      vz[i] += Math.cos(a * 4.1 + s) * T.flutter * dt * 3;
    }
    px[i] += vx[i] * dt;
    py[i] += vy[i] * dt;
    pz[i] += vz[i] * dt;
    rot[i] += rotV[i] * dt;
    // ground collision for cubes and droplets
    if (T.k === K_CUBE || T.k === K_DROP) {
      const tx = px[i] | 0, tz = pz[i] | 0;
      let gy = SEA_Y;
      let water = true;
      if (tx >= 0 && tz >= 0 && tx < W && tz < H) {
        const h = hgt[tz * W + tx];
        if (h >= C.SEA) { gy = h * STEP; water = false; }
      }
      const half = T.k === K_CUBE ? size0[i] * 0.5 : 0;
      if (py[i] < gy + half) {
        if (water || T.k === K_DROP) {
          // sink / vanish in water or on ground (droplets)
          if (age[i] < life[i] - 0.25) age[i] = life[i] - 0.25;
          if (water && T.k === K_CUBE) { vy[i] *= 0.2; vx[i] *= 0.5; vz[i] *= 0.5; }
          else { vy[i] = 0; vx[i] = vz[i] = 0; py[i] = gy + half; }
        } else {
          py[i] = gy + half;
          if (vy[i] < -0.6) {
            vy[i] = -vy[i] * (T.bounce || 0.2);
            vx[i] *= 0.65; vz[i] *= 0.65; rotV[i] *= 0.6;
          } else {
            vy[i] = 0; vx[i] *= 0.5; vz[i] *= 0.5; rotV[i] = 0;
            if (Math.abs(vx[i]) + Math.abs(vz[i]) < 0.05) rest[i] = 1;
          }
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Instance building (camera-sorted)                                    */
/* ------------------------------------------------------------------ */
function buildInstances() {
  const cam = VC.camera, F = VC.fxgl.frustum;
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
    const T = TYPE_LIST[ptype[i]];
    const t = age[i] / life[i];
    const s = size0[i] * (1 + (grow[i] - 1) * (1 - (1 - t) * (1 - t)));
    if (!F.sphere(px[i], py[i], pz[i], s + 0.2)) continue;
    const kind = T.k;
    if (kind === K_CUBE) {
      const o = nCube++ * 12, d = cubeData;
      const sc = t > 0.85 ? s * (1 - (t - 0.85) / 0.15) : s;
      d[o] = px[i]; d[o + 1] = py[i]; d[o + 2] = pz[i]; d[o + 3] = sc;
      d[o + 4] = cr[i]; d[o + 5] = cg[i]; d[o + 6] = cb[i]; d[o + 7] = emis[i];
      const sd = seed[i] * 6.2831;
      d[o + 8] = Math.cos(sd); d[o + 9] = 0.6; d[o + 10] = Math.sin(sd); d[o + 11] = rot[i];
      continue;
    }
    // alpha envelope: quick fade in, fade out at the end
    let a = ca[i] * Math.min(1, t * 10) * (1 - M.smoothstep(0.55, 1, t));
    if (kind === K_ADD || kind === K_STAR || kind === K_FIRE) {
      if (T.flicker) a *= 1 - T.flicker * (0.5 + 0.5 * Math.sin(TIME * 23 + seed[i] * 50)) * M.smoothstep(0.4, 1, t);
      const o = nAdd++ * 12, d = addData;
      let r = cr[i], g = cg[i], b = cb[i];
      if (kind === K_FIRE) {
        // incandescent gradient: white-yellow -> orange -> deep red, tinted by the particle colour
        const h = 1 - t;
        r *= 1.2 + 3.8 * h; g *= 0.25 + 2.3 * h * h; b *= 0.05 + 1.2 * h * h * h;
        a *= 0.85 + 0.3 * Math.sin(TIME * 30 + seed[i] * 70);
      }
      d[o] = px[i]; d[o + 1] = py[i]; d[o + 2] = pz[i]; d[o + 3] = s;
      d[o + 4] = r; d[o + 5] = g; d[o + 6] = b; d[o + 7] = a;
      d[o + 8] = rot[i]; d[o + 9] = kind; d[o + 10] = seed[i]; d[o + 11] = 0;
      continue;
    }
    const n = nSoft++;
    const dd = (px[i] - cx) * fx + (py[i] - cy) * fy + (pz[i] - cz) * fz;
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
      const T = TYPE_LIST[ptype[i]];
      const t = age[i] / life[i];
      const s = size0[i] * (1 + (grow[i] - 1) * (1 - (1 - t) * (1 - t)));
      const a = ca[i] * Math.min(1, t * 8) * (1 - M.smoothstep(T.k === K_RING ? 0.2 : 0.5, 1, t));
      const o = n * 12, d = softData;
      d[o] = px[i]; d[o + 1] = py[i]; d[o + 2] = pz[i]; d[o + 3] = s;
      d[o + 4] = cr[i]; d[o + 5] = cg[i]; d[o + 6] = cb[i]; d[o + 7] = a;
      d[o + 8] = rot[i]; d[o + 9] = T.k; d[o + 10] = seed[i]; d[o + 11] = emis[i] * (1 - t) * (1 - t);
    }
  }
  Pt.stats.soft = nSoft;
  Pt.stats.add = nAdd;
  Pt.stats.cube = nCube;
}

/* ------------------------------------------------------------------ */
/* Automatic effects                                                     */
/* ------------------------------------------------------------------ */
const emitList = []; // buildings with emitters near the camera
const burnList = []; // burning buildings near the camera
const buildList = []; // buildings under construction
const emCache = new WeakMap(); // building -> { model, rot, x, z, pts: Float32Array(x,y,z,typeId,rate), acc }
const levelSeen = new WeakMap();
let scanT = 0;
const EM_TYPES = { smoke: 0, steam: 1, fire: 2, sparkle: 3, fountain: 4 };
const EM_NAMES = ['smoke', 'steam', 'fire', 'sparkle', 'fountain'];
const EM_RATE = [1.4, 1.7, 6, 2, 26];

function emittersOf(b, m) {
  let c = emCache.get(b);
  if (c && c.model === m && c.rot === b.rot && c.x === b.x && c.z === b.z) return c;
  const list = (m && m.emitters) || [];
  const pts = new Float32Array(list.length * 5);
  for (let k = 0; k < list.length; k++) {
    const e = list[k];
    const w = VC.models.localToWorld(b, m, e.x, e.y, e.z);
    pts[k * 5] = w[0]; pts[k * 5 + 1] = w[1]; pts[k * 5 + 2] = w[2];
    pts[k * 5 + 3] = EM_TYPES[e.type] != null ? EM_TYPES[e.type] : 0;
    pts[k * 5 + 4] = e.rate == null ? 1 : e.rate;
  }
  c = { model: m, rot: b.rot, x: b.x, z: b.z, pts, acc: new Float32Array(list.length) };
  emCache.set(b, c);
  return c;
}

function scan(S) {
  const cam = VC.camera, F = VC.fxgl.frustum;
  const R = M.clamp(40 + cam.dist * 0.6, 50, 110);
  const R2 = R * R;
  emitList.length = 0;
  burnList.length = 0;
  for (const b of S.buildings.values()) {
    const bx = b.x + b.w * 0.5, bz = b.z + b.d * 0.5;
    const dx = bx - cam.tx, dz = bz - cam.tz;
    const d2 = dx * dx + dz * dz;
    if (b.fire > 0) {
      if (d2 < R2 * 2.2) burnList.push(b);
      continue;
    }
    if (d2 > R2 || b.built < 1 || b.abandoned || b.powered === false || b.key === 'rubble') continue;
    const m = VC.models.forBuilding(b);
    if (!m || !m.emitters || !m.emitters.length) continue;
    if (!F.sphere(bx, VC.world.topY(b.x, b.z) + m.height * 0.5, bz, m.height + Math.max(b.w, b.d) + 3)) continue;
    emitList.push(b);
  }
  for (let k = buildList.length - 1; k >= 0; k--) {
    const b = buildList[k];
    if (b.built >= 1 || !S.buildings.has(b.id)) buildList.splice(k, 1);
  }
  Pt.stats.emitters = emitList.length;
  Pt.stats.burning = burnList.length;
}

function autoEffects(S, dt) {
  scanT -= dt;
  if (scanT <= 0) {
    scanT = 0.3;
    scan(S);
  }
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
      const b = emitList[n];
      if (!VC.state.buildings.has(b.id)) continue;
      const m = VC.models.forBuilding(b);
      if (!m) continue;
      const c = emittersOf(b, m);
      const pts = c.pts;
      const dist = Math.hypot(b.x - cam.tx, b.z - cam.tz);
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
            spawn(TYPE_ID.fire, x, y, z, { vx: (r() - 0.5) * 0.3, vy: 0.6, vz: (r() - 0.5) * 0.3, size: 0.16 }, false);
          } else spawn(ty === 1 ? TYPE_ID.steam : TYPE_ID.smoke, x, y, z, { vx: (r() - 0.5) * 0.2, vy: ty === 1 ? 1.1 : 0.8, vz: (r() - 0.5) * 0.2, size: ty === 1 ? 0.3 : 0.26, alpha: ty === 1 ? 0.45 : 0.38 }, false);
        }
      }
    }
  }
  // ---- burning buildings ----
  const TIME = VC.gfx.time;
  for (let n = 0; n < burnList.length; n++) {
    const b = burnList[n];
    if (!(b.fire > 0) || !VC.state.buildings.has(b.id)) continue;
    const m = VC.models.forBuilding(b);
    const hgt = Math.max(0.4, (m && m.height) || b.hgt || 1);
    const gy = VC.world.topY(b.x, b.z);
    const area = b.w * b.d;
    const f = M.clamp(0.35 + b.fire, 0.35, 1.3);
    const dist = Math.hypot(b.x + b.w / 2 - cam.tx, b.z + b.d / 2 - cam.tz);
    const lod = M.clamp(1.4 - dist / 120, 0.2, 1);
    const flick = 0.75 + 0.25 * Math.sin(TIME * 13 + b.id) * Math.sin(TIME * 7.3 + b.id * 3);
    const cxw = b.x + b.w / 2, czw = b.z + b.d / 2;
    // light: ground pool + halo (strong at night)
    const L = (0.35 + night * 1.2) * f * flick;
    Pt.glows.add(cxw, gy + 0.05, czw, 1.6 + Math.max(b.w, b.d) * 1.1, 1.0, 0.42, 0.12, L * 1.3, 1, 0, 1, 0);
    Pt.glows.add(cxw, gy + hgt * 0.7, czw, 1.0 + hgt * 0.6 + b.w * 0.4, 1.0, 0.38, 0.1, L * 0.55, 0, 0, 1, 0.1);
    if (nActive >= cap * 0.95) continue;
    const nFire = (6 + 10 * Math.pow(area, 0.7)) * f * lod * dt;
    for (let k = 0; k < 6 && (k < Math.floor(nFire) || r() < nFire - k); k++) {
      const x = b.x + 0.1 + r() * (b.w - 0.2), z = b.z + 0.1 + r() * (b.d - 0.2);
      const y = gy + hgt * (0.3 + 0.75 * Math.sqrt(r()));
      spawn(TYPE_ID.fire, x, y, z, { vx: 0, vy: 0.8 + r() * 0.6, vz: 0, size: 0.25 + 0.2 * Math.sqrt(area) * r() }, false);
    }
    const nSmoke = (3 + 4 * Math.sqrt(area)) * f * lod * dt;
    for (let k = 0; k < 3 && (k < Math.floor(nSmoke) || r() < nSmoke - k); k++) {
      spawn(TYPE_ID.smoke, cxw + (r() - 0.5) * b.w * 0.6, gy + hgt + 0.1, czw + (r() - 0.5) * b.d * 0.6, { vx: 0, vy: 1.3 + r() * 0.4, vz: 0, size: 0.3 + 0.14 * Math.sqrt(area), life: 5 + r() * 3, color: [0.1, 0.095, 0.09], alpha: 0.7, emissive: 0.22 }, false);
    }
    if (r() < 2.5 * lod * dt * f) spawn(TYPE_ID.ember, cxw + (r() - 0.5) * b.w, gy + hgt * r(), czw + (r() - 0.5) * b.d, null, true);
  }
  // ---- construction sites ----
  if (room && buildList.length) {
    for (let n = 0; n < buildList.length; n++) {
      const b = buildList[n];
      const cxw = b.x + b.w / 2, czw = b.z + b.d / 2;
      const dist = Math.hypot(cxw - cam.tx, czw - cam.tz);
      if (dist > 70) continue;
      const gy = VC.world.topY(b.x, b.z);
      if (r() < 1.6 * dt * Math.sqrt(b.w * b.d)) {
        const side = r() * 4 | 0;
        const x = side < 2 ? b.x + r() * b.w : side === 2 ? b.x : b.x + b.w;
        const z = side >= 2 ? b.z + r() * b.d : side === 0 ? b.z : b.z + b.d;
        spawn(TYPE_ID.dust, x, gy + 0.1, z, { vx: (r() - 0.5) * 0.4, vy: 0.25, vz: (r() - 0.5) * 0.4, size: 0.25, alpha: 0.35 }, false);
      }
      if (night > 0.3 && r() < 0.7 * dt) {
        const m = VC.models.forBuilding(b);
        const top = gy + Math.max(0.3, (m ? m.height : 1) * b.built);
        spawn(TYPE_ID.spark, b.x + r() * b.w, top, b.z + r() * b.d, { spread: 1.4 }, true);
        spawn(TYPE_ID.spark, b.x + r() * b.w, top, b.z + r() * b.d, { spread: 1.4 }, true);
      }
    }
  }
}

/* ---------------- world event handlers ---------------- */
function nearCam(x, z, r) {
  const cam = VC.camera;
  return Math.hypot(x - cam.tx, z - cam.tz) < r + cam.dist * 0.8;
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
  try { m = b.key === 'rubble' ? null : VC.models.forBuilding(b); } catch (e) { m = null; }
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
  const prev = levelSeen.get(b);
  levelSeen.set(b, b.level);
  if (prev == null || !(b.level > prev) || b.built < 1) return;
  const cx = b.x + b.w / 2, cz = b.z + b.d / 2;
  if (!nearCam(cx, cz, 60)) return;
  let hgt = b.hgt || 1;
  try { const m = VC.models.forBuilding(b); if (m) hgt = m.height; } catch (e) { /* ignore */ }
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
  float c = cos(aP2.x), s = sin(aP2.x);
  vec2 rq = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  vec3 camR = vec3(uView[0][0], uView[1][0], uView[2][0]);
  vec3 camU = vec3(uView[0][1], uView[1][1], uView[2][1]);
  if (aP2.y > 6.5) { camR = vec3(1.0, 0.0, 0.0); camU = vec3(0.0, 0.0, 1.0); }
  vec3 wp = aP0.xyz + (camR * rq.x + camU * rq.y) * aP0.w;
  vUv = q; vCol = aP1; vP = aP2; vWp = wp;
  gl_Position = uViewProj * vec4(wp, 1.0);
}`;
const SFS_SOFT = `
in vec2 vUv; flat in vec4 vCol; flat in vec4 vP; in vec3 vWp;
out vec4 fragColor;
void main(){
  int kind = int(vP.y + 0.5);
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
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
    a = exp(-pow((r - 0.72) / 0.16, 2.0));
    col = col * (uSkyAmb.rgb * 1.3 + uSunColor.rgb * uSunDir.w * 0.3 + vec3(0.6) * uMisc.z);
  }
  col = applyFog(col, vWp);
  fragColor = vec4(col, a * vCol.a);
}`;
const SFS_ADD = `
in vec2 vUv; flat in vec4 vCol; flat in vec4 vP; in vec3 vWp;
out vec4 fragColor;
void main(){
  int kind = int(vP.y + 0.5);
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float a;
  if (kind == 4) {
    float cx = exp(-abs(vUv.x) * 16.0) * (1.0 - abs(vUv.y));
    float cy = exp(-abs(vUv.y) * 16.0) * (1.0 - abs(vUv.x));
    a = exp(-r2 * 22.0) * 1.4 + (cx + cy) * 0.9;
  } else if (kind == 6) {
    float n = tnoise(vUv * 0.3 + vP.z * 5.7 + vec2(0.0, -TIME * 0.9)).r;
    a = smoothstep(1.0, 0.0, r2 + (n - 0.5) * 0.9) * (0.7 + 0.6 * n);
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
  gl.bufferData(gl.ARRAY_BUFFER, cubeData.subarray(0, nCube * 12), gl.DYNAMIC_DRAW);
  gl.drawElementsInstanced(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0, nCube);
  gl.bindVertexArray(null);
}

function bindSprites(gl, buf, data, n) {
  gl.bindVertexArray(GLR.spriteVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * 12), gl.DYNAMIC_DRAW);
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
