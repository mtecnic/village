/*
 * VOXELPOLIS — street props (VC.props, layer 'props', order 150): street lamps, traffic lights at
 * intersections, fire hydrants, power pylons and their sagging catenary wires.
 *
 * Placement is derived from the tile layers and rebuilt INCREMENTALLY: bus 'dirty' rects (grown by one
 * tile, since lamp spots / pylon anchors depend on neighbours) are queued and rebuilt tile by tile within
 * a per-frame budget; wires are regenerated when a pylon changed. All voxel props are instances of the
 * shared engine in gfx/buildings.js (VC.bldgfx.eng, set 1) — same culling, LOD, shadows, night lighting
 * and glow sprites as buildings. main.js does not list 'props': VC.bldgfx.init/reset/update call ours.
 *
 *   street lamps   at VC.terrain.lampSpots(x, z) when the terrain provides it (the terrain paints the
 *                  matching warm light pools), else on tiles with x+z even at the mid-points of open
 *                  sidewalk edges (and we add our own pool sprites); arms overhang the road.
 *   traffic lights two poles on opposite corners of every street/avenue intersection (>= 3 links); one
 *                  shows the X-axis aspect, the other (rotated) the Z-axis aspect. The aspect follows
 *                  VC.agents.signal(x, z) (0 X green, 1 X yellow, 2 Z green, 3 Z yellow) or a local
 *                  11 s cycle, by switching model variants (0 red, 1 green, 2 yellow) + glowing heads.
 *   hydrants       sparse, on street sidewalks between lamps (if a 'hydrant' model exists).
 *   pylons         on power-line tiles at ends, corners, junctions and every 3rd tile of straight runs
 *                  (not on roads / buildings / water), oriented across the line (45 deg at corners).
 *   wires          6 conductors (model meta.wire, paired by side and height) + an earth wire between
 *                  consecutive pylons: one instanced ribbon draw, catenary sag + wind sway in the shader.
 * Models 'streetlamp', 'traffic_light', 'pylon' come from the nature models; simple fallbacks are
 * registered in init() only if those keys are missing.
 *
 * API (VC.props): init(), reset(S), update(dt, rdt) / tick(dt, rdt) (VC.bldgfx sets props.driven and calls
 *   tick), rebuild(x0, z0, x1, z1) (queue a rect), stats.
 */
const M = VC.M, C = VC.C;
const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
const SEG = 12; // wire segments
const SW = [0, 9 / 64, 6 / 64, 0]; // sidewalk width per road type (matches the terrain renderer)
const K_LAMP = 1, K_TL = 2, K_PYLON = 3, K_HYDRANT = 4;

const PR = (VC.props = {
  name: 'props',
  order: 150,
  stats: { lamps: 0, lights: 0, pylons: 0, hydrants: 0, wires: 0, queued: 0 },

  init() {
    if (inited || !VC.bldgfx || !VC.bldgfx.eng || !VC.gfx.gl) return;
    inited = true;
    E = VC.bldgfx.eng;
    gl = VC.gfx.gl;
    defineFallbacks();
    initWires();
    VC.gfx.addLayer(PR);
    VC.bus.on('dirty', (r) => {
      if (!S || S !== VC.state) return;
      // the whole-map rect main.js emits right after reset() is already built
      if (fresh && r.x0 <= 0 && r.z0 <= 0 && r.x1 >= S.W - 1 && r.z1 >= S.H - 1) { fresh = false; return; }
      queue.push([r.x0 - 1, r.z0 - 1, r.x1 + 1, r.z1 + 1]);
    });
  },

  reset(st) {
    if (!inited) return;
    if (st === S && resetFrame === VC.gfx.frameCount) return;
    resetFrame = VC.gfx.frameCount;
    S = st;
    for (const k in PR.stats) PR.stats[k] = 0;
    tileRecs = new Array(S.N).fill(null);
    pylonAt = new Int32Array(S.N).fill(-1);
    pylons.clear();
    tls.clear();
    queue.length = 0;
    cur = null;
    resolveModels();
    for (let z = 0; z < S.H; z++) for (let x = 0; x < S.W; x++) buildTile(x, z);
    wiresDirty = true;
    fresh = true;
  },

  /** Per-frame work. Driven by VC.bldgfx.update (via tick); a direct call from main.js is ignored then. */
  update(dt, rdt) {
    if (!PR.driven) PR.tick(dt, rdt);
  },
  tick(dt, rdt) {
    if (!inited || !S || S !== VC.state) return;
    if (!mw.lamp) resolveModels();
    fresh = false;
    processQueue(3);
    if (wiresDirty) rebuildWires();
    updateSignals(rdt || 0);
    PR.stats.queued = queue.length;
  },

  /** Rebuilds the props of an inclusive tile rect (queued; done within the frame budget). */
  rebuild(x0, z0, x1, z1) {
    queue.push([x0, z0, x1, z1]);
  },

  shadow(ctx) {
    if (E && S === ctx.S) E.draw(ctx, E.SET.PROPS, true);
  },
  opaque(ctx) {
    if (!E || S !== ctx.S) return;
    E.draw(ctx, E.SET.PROPS, false);
    drawWires(ctx);
  },
});

let inited = false, E = null, gl = null, S = null;
let resetFrame = -1, fresh = false;
let tileRecs = [];
let pylonAt = new Int32Array(0);
const pylons = new Map(); // tile index -> pylon record
const tls = new Set();
const queue = [];
let cur = null; // rect being processed: {x0, z0, x1, z1, x, z}
let wiresDirty = false;
const mw = { lamp: null, lamp2: null, tl: [], pylon: null, hydrant: null };
let signalClock = 0;

/* ------------------------------------------------------------------ */
/* Models                                                               */
/* ------------------------------------------------------------------ */
function crop(g) {
  const h = Math.max(1, g.maxHeight());
  if (h >= g.sy) return g;
  const o = new VC.VoxelGrid(g.sx, h, g.sz);
  o.v.set(g.v.subarray(0, g.sx * g.sz * h));
  o.emitters = g.emitters;
  o.lights = g.lights;
  o.meta = g.meta;
  return o;
}
/** Simple stand-ins, registered only when the nature models are missing (the real ones win). */
function defineFallbacks() {
  const P = VC.P;
  if (!VC.models.has('streetlamp')) {
    VC.models.define('streetlamp', {
      variants: 2,
      scale: 0.5,
      gen(rng, v) {
        const g = new VC.VoxelGrid(9, 19, 9);
        const X = 4, Z = 4, dark = v ? P.METAL : P.BLACK;
        g.box(3, 0, 3, 3, 1, 3, P.CONCRETE_D);
        g.box(X, 1, Z, 1, 15, 1, dark);
        g.box(X, 15, Z + 1, 1, 1, 3, dark);
        g.box(X, 13, Z + 3, 1, 2, 1, v ? P.LAMP_WHITE : P.LAMP);
        g.meta.head = [X + 0.5, 13, Z + 3.5];
        g.light(X + 0.5, 13, Z + 3.5, v ? [0.85, 0.92, 1] : [1, 0.78, 0.45], 1.2);
        return crop(g);
      },
    });
  }
  if (!VC.models.has('traffic_light')) {
    const ON = [P.NEON_RED, P.NEON_YELLOW, P.NEON_GREEN], OFF = [P.BRICK_D, P.WOOD_D, P.GRASS_D];
    const RGB = [[1, 0.2, 0.15], [1, 0.6, 0.1], [0.3, 1, 0.4]];
    VC.models.define('traffic_light', {
      variants: 3,
      scale: 0.5,
      gen(rng, v) {
        const g = new VC.VoxelGrid(9, 18, 17);
        const X = 4, Z = 8, litX = [0, 2, 1][v % 3], litZ = litX === 0 ? 2 : 0;
        g.box(3, 0, 7, 3, 1, 3, P.CONCRETE_D);
        g.box(X, 1, Z, 1, 15, 1, P.METAL_D);
        g.box(X, 15, Z + 1, 1, 1, 8, P.METAL_D);
        const hz = Z + 6;
        g.box(X, 10, hz - 1, 1, 5, 3, P.BLACK);
        for (let k = 0; k < 3; k++) {
          g.set(X, 13 - k, hz, k === litX ? ON[k] : OFF[k]);
          if (k === litX) {
            g.light(X - 0.2, 13.5 - k, hz + 0.5, RGB[k], 0.5, true);
            g.light(X + 1.2, 13.5 - k, hz + 0.5, RGB[k], 0.5, true);
          }
        }
        g.box(X + 1, 7, Z, 2, 5, 1, P.BLACK);
        for (let k = 0; k < 3; k++) {
          g.set(X + 1, 10 - k, Z, k === litZ ? ON[k] : OFF[k]);
          if (k === litZ) g.light(X + 1.5, 10.5 - k, Z + 1.2, RGB[k], 0.45, true);
        }
        return crop(g);
      },
    });
  }
  if (!VC.models.has('pylon')) {
    VC.models.define('pylon', {
      variants: 1,
      scale: 0.5,
      gen() {
        const g = new VC.VoxelGrid(15, 46, 15);
        const Cc = 7, ST = P.METAL, TOP = 30;
        for (const sx of [-1, 1])
          for (const sz of [-1, 1]) {
            g.line(Cc + sx * 5, 0, Cc + sz * 5, Cc + sx * 2, TOP, Cc + sz * 2, ST);
            g.box(Cc + sx * 2, TOP, Cc + sz * 2, 1, 12, 1, ST);
          }
        for (const y of [8, 16, 24, TOP, 41]) {
          const w = y >= TOP ? 2 : Math.round(5 - (3 * y) / TOP);
          g.box(Cc - w, y, Cc - w, 2 * w + 1, 1, 1, ST);
          g.box(Cc - w, y, Cc + w, 2 * w + 1, 1, 1, ST);
          g.box(Cc - w, y, Cc - w, 1, 1, 2 * w + 1, ST);
          g.box(Cc + w, y, Cc - w, 1, 1, 2 * w + 1, ST);
        }
        g.box(Cc, 42, Cc, 1, 4, 1, ST);
        const wire = [[], []];
        [[TOP, 7], [35, 6], [40, 5]].forEach(([y, L]) => {
          g.box(Cc - L, y, Cc, 2 * L + 1, 1, 1, ST);
          for (const s of [-1, 1]) {
            g.set(Cc + s * L, y - 1, Cc, P.GLASS_CYAN);
            wire[s < 0 ? 0 : 1].push([Cc + s * L + 0.5, y - 1.5, Cc + 0.5]);
          }
        });
        g.meta.wire = wire[0].concat(wire[1]);
        g.meta.earth = [Cc + 0.5, 46, Cc + 0.5];
        return g;
      },
    });
  }
}
function getModel(key, v) {
  if (!VC.models.has(key)) return null;
  try {
    return VC.models.get(key, v);
  } catch (e) {
    return null;
  }
}
function resolveModels() {
  const K = E.K;
  mw.lamp = E.mw(getModel('streetlamp', 0), K.PROP);
  mw.lamp2 = E.mw(getModel('streetlamp', 1), K.PROP) || mw.lamp;
  const pools = !(VC.terrain && VC.terrain.lampSpots);
  for (const w of [mw.lamp, mw.lamp2]) if (w) w.pool = pools;
  mw.tl = [0, 1, 2].map((v) => E.mw(getModel('traffic_light', v), K.PROP));
  for (const w of mw.tl) if (w) w.noStaticLights = true; // aspect changes: glow heads are dynamic sprites
  mw.pylon = E.mw(getModel('pylon', 0), K.PROP);
  if (mw.pylon) E.setSkip(mw.pylon, 3.2, 1.6, 1.3);
  mw.hydrant = E.mw(getModel('hydrant', 0), K.PROP);
  if (mw.hydrant) E.setSkip(mw.hydrant, 0.55, 0.25, 0);
  for (const w of mw.tl) if (w) E.setSkip(w, 1.5, 0.5, 0);
}

/* ------------------------------------------------------------------ */
/* Placement                                                            */
/* ------------------------------------------------------------------ */
const roadAt = (x, z) => (x >= 0 && z >= 0 && x < S.W && z < S.H ? S.road[z * S.W + x] : 0);
const plAt = (x, z) => (x >= 0 && z >= 0 && x < S.W && z < S.H ? S.pline[z * S.W + x] : 0);
/** Road connection mask (bit d: 0 +X, 1 -X, 2 +Z, 3 -Z) as the terrain renders it. */
function roadMask(x, z) {
  const T = VC.terrain;
  if (T && T.roadInfo) {
    const r = T.roadInfo(x, z);
    if (r) return r.mask;
  }
  let m = 0;
  for (let d = 0; d < 4; d++) if (roadAt(x + DX[d], z + DZ[d])) m |= 1 << d;
  return m;
}
function popc(m) {
  return (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
}
function roadSurfY(wx, wz, x, z) {
  const T = VC.terrain;
  if (T && T.roadY) {
    const y = T.roadY(wx, wz);
    if (y != null) return y;
  }
  const h = S.height[z * S.W + x];
  return h < C.SEA ? (C.SEA + 1) * C.STEP : h * C.STEP;
}
/** Our lamp spots when the terrain does not provide lampSpots (same rule as the terrain renderer). */
function lampSpots(x, z) {
  const T = VC.terrain;
  if (T && T.lampSpots) return T.lampSpots(x, z) || [];
  const out = [];
  if ((x + z) & 1) return out;
  const rt = roadAt(x, z);
  if (!rt) return out;
  const m = roadMask(x, z);
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
}
// yaw that turns the model front (+Z) toward the road for a lamp on edge `dir`
const YAW_TO_ROAD = [-Math.PI / 2, Math.PI / 2, Math.PI, 0];

function addRec(i, kind, slot, extra) {
  const r = { kind, slot };
  if (extra) Object.assign(r, extra);
  (tileRecs[i] || (tileRecs[i] = [])).push(r);
  return r;
}
function clearTile(i) {
  const L = tileRecs[i];
  if (!L) return;
  for (const r of L) {
    E.remove(r.slot);
    if (r.kind === K_TL) { tls.delete(r); PR.stats.lights--; }
    else if (r.kind === K_LAMP) PR.stats.lamps--;
    else if (r.kind === K_HYDRANT) PR.stats.hydrants--;
    else if (r.kind === K_PYLON) {
      pylonAt[i] = -1;
      pylons.delete(i);
      wiresDirty = true;
      PR.stats.pylons--;
    }
  }
  tileRecs[i] = null;
}
function buildTile(x, z) {
  const i = z * S.W + x;
  const rt = S.road[i];
  const SET = E.SET.PROPS;
  if (rt) {
    const curb = (VC.terrain && VC.terrain.CURB) || 3 / 64;
    // street lamps
    const spots = lampSpots(x, z);
    const h = M.hashU(x >> 3, z >> 3, 51);
    const lampMw = rt >= 2 || h % 5 === 0 ? mw.lamp2 : mw.lamp;
    if (lampMw) {
      for (const sp of spots) {
        const y = roadSurfY(sp.x, sp.z, x, z) + (rt === 3 ? 0.06 : curb);
        if (rt === 3) {
          // highway median: back-to-back pair over both carriageways
          const a = sp.dir === 0 ? 0 : Math.PI / 2;
          addRec(i, K_LAMP, E.add(SET, lampMw, sp.x, y, sp.z, a, 1, 0, 0.5));
          addRec(i, K_LAMP, E.add(SET, lampMw, sp.x, y, sp.z, a + Math.PI, 1, 0, 0.5));
          PR.stats.lamps += 2;
        } else {
          addRec(i, K_LAMP, E.add(SET, lampMw, sp.x, y, sp.z, YAW_TO_ROAD[sp.dir], 1, 0, 0.5));
          PR.stats.lamps++;
        }
      }
    }
    const m = roadMask(x, z);
    const n = popc(m);
    // traffic lights at street / avenue intersections
    if (n >= 3 && rt <= 2 && mw.tl[0]) {
      const sw = SW[rt] * 0.5;
      const y = roadSurfY(x + 0.5, z + 0.5, x, z) + curb;
      const a = addRec(i, K_TL, E.add(SET, mw.tl[0], x + sw, y, z + sw, 0, 1, 0, 0.3), { x, z, zAxis: false, v: 0 });
      const b = addRec(i, K_TL, E.add(SET, mw.tl[0], x + 1 - sw, y, z + 1 - sw, -Math.PI / 2, 1, 0, 0.7), { x, z, zAxis: true, v: 0 });
      tls.add(a);
      tls.add(b);
      PR.stats.lights += 2;
    }
    // hydrants: sparse, on street tiles without lamps
    if (mw.hydrant && rt === 1 && (x + z) & 1 && n <= 2 && M.hashU(x, z, 97) % 7 === 0) {
      for (let d = 0; d < 4; d++) {
        if (m & (1 << d)) continue;
        const h2 = SW[1] * 0.5;
        const off = (M.hash(x, z, 5) - 0.5) * 0.5;
        let px, pz;
        if (d === 0) { px = x + 1 - h2; pz = z + 0.5 + off; }
        else if (d === 1) { px = x + h2; pz = z + 0.5 + off; }
        else if (d === 2) { px = x + 0.5 + off; pz = z + 1 - h2; }
        else { px = x + 0.5 + off; pz = z + h2; }
        addRec(i, K_HYDRANT, E.add(SET, mw.hydrant, px, roadSurfY(px, pz, x, z) + curb, pz, YAW_TO_ROAD[d], 1, 0, 0.5));
        PR.stats.hydrants++;
        break;
      }
    }
    return;
  }
  // power pylons
  if (S.pline[i] && mw.pylon && !S.bld[i] && S.height[i] >= C.SEA && isAnchor(x, z)) {
    const e = plAt(x + 1, z), w = plAt(x - 1, z), s = plAt(x, z + 1), nn = plAt(x, z - 1);
    const cnt = e + w + s + nn;
    let yaw = 0;
    if (cnt === 2 && e && w) yaw = Math.PI / 2;
    else if (cnt === 2 && !(s && nn)) yaw = (e && s) || (w && nn) ? -Math.PI / 4 : Math.PI / 4;
    else if (cnt === 1 && (e || w)) yaw = Math.PI / 2;
    const y = S.height[i] * C.STEP;
    const scale = 0.92;
    const slot = E.add(E.SET.PROPS, mw.pylon, x + 0.5, y, z + 0.5, yaw, scale, 0, M.hash(x, z, 9));
    addRec(i, K_PYLON, slot);
    pylonAt[i] = slot;
    pylons.set(i, pylonRecord(x + 0.5, y, z + 0.5, yaw, scale));
    wiresDirty = true;
    PR.stats.pylons++;
  }
}
/** Pylons stand at line ends, corners and junctions, and every 3rd tile of straight runs. */
function isAnchor(x, z) {
  const e = plAt(x + 1, z), w = plAt(x - 1, z), s = plAt(x, z + 1), n = plAt(x, z - 1);
  const cnt = e + w + s + n;
  if (cnt !== 2) return true;
  if (e && w) return x % 3 === 0;
  if (s && n) return z % 3 === 0;
  return true;
}
/** Processes queued dirty rects tile by tile within budgetMs. */
function processQueue(budgetMs) {
  if (!queue.length && !cur) return;
  const t0 = performance.now();
  let n = 0;
  while (true) {
    if (!cur) {
      if (!queue.length) return;
      const r = queue.shift();
      const x0 = Math.max(0, r[0]), z0 = Math.max(0, r[1]), x1 = Math.min(S.W - 1, r[2]), z1 = Math.min(S.H - 1, r[3]);
      if (x1 < x0 || z1 < z0) continue;
      cur = { x0, z0, x1, z1, x: x0, z: z0 };
    }
    const i = cur.z * S.W + cur.x;
    clearTile(i);
    buildTile(cur.x, cur.z);
    if (++cur.x > cur.x1) {
      cur.x = cur.x0;
      if (++cur.z > cur.z1) cur = null;
    }
    if ((++n & 31) === 0 && performance.now() - t0 > budgetMs) return;
  }
}

/* ------------------------------------------------------------------ */
/* Traffic signals                                                      */
/* ------------------------------------------------------------------ */
/** Phase of intersection (x, z): 0 X green, 1 X yellow, 2 Z green, 3 Z yellow. */
function phaseAt(x, z) {
  const A = VC.agents;
  if (A && A.signal) {
    const p = A.signal(x, z);
    if (p >= 0) return p;
  }
  const t = (signalClock + M.hash(x, z, 77) * 11) % 11;
  return t < 4.8 ? 0 : t < 5.5 ? 1 : t < 10.3 ? 2 : 3;
}
function updateSignals(rdt) {
  signalClock += rdt * (VC.state && VC.state.time.speed ? 1 : 0.35);
  if (!tls.size) return;
  const cam = VC.camera.pos;
  const D = E.data();
  const night = (VC.gfx.env && VC.gfx.env.night) || 0;
  for (const r of tls) {
    const ph = phaseAt(r.x, r.z);
    const v = r.zAxis ? (ph === 2 ? 1 : ph === 3 ? 2 : 0) : ph === 0 ? 1 : ph === 1 ? 2 : 0;
    const w = mw.tl[v] || mw.tl[0];
    if (v !== r.v) {
      r.v = v;
      E.setModel(r.slot, w);
    }
    // glowing lamp heads nearby
    if (!w || !w.lights || !E.cellSeen(r.x, r.z)) continue;
    const o = r.slot * E.SLOT_F;
    const dx = D[o] - cam[0], dz = D[o + 2] - cam[2];
    if (dx * dx + dz * dz > 110 * 110) continue;
    const yaw = D[o + 3], sc = D[o + 4] * D[o + 14], c = Math.cos(yaw), s = Math.sin(yaw);
    for (const l of w.lights) {
      const lx = (l.x - D[o + 12]) * sc, lz = (l.z - D[o + 13]) * sc;
      const col = l.color || [1, 0.3, 0.2];
      const k = 0.5 + 0.5 * night;
      E.dynSprite(D[o] + lx * c + lz * s, D[o + 1] + l.y * sc, D[o + 2] - lx * s + lz * c, (l.size || 0.5) * 0.3, col[0] * k, col[1] * k, col[2] * k, 1);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pylons + wires                                                       */
/* ------------------------------------------------------------------ */
/** World-space attachment points of a pylon (meta.wire + meta.earth), for pairing conductors. */
function pylonRecord(x, y, z, yaw, scale) {
  const m = mw.pylon.m;
  const meta = m.meta || {};
  const sc = m.vox * scale, c = Math.cos(yaw), s = Math.sin(yaw);
  const cx = m.sx / 2, cz = m.sz / 2;
  const tf = (p) => {
    const lx = (p[0] - cx) * sc, lz = (p[2] - cz) * sc;
    return [x + lx * c + lz * s, y + p[1] * sc, z - lx * s + lz * c];
  };
  let pts = Array.isArray(meta.wire) && meta.wire.length ? meta.wire.map(tf) : null;
  if (!pts) {
    // no metadata: three conductors per side near the top
    pts = [];
    for (const sd of [-1, 1]) for (const f of [0.7, 0.8, 0.9]) pts.push(tf([cx + sd * m.sx * 0.42, m.sy * f, cz]));
  }
  const earth = meta.earth ? tf(meta.earth) : [x, y + m.sy * sc, z];
  return { x, y, z, pts, earth };
}
let wireProg = null, wireVao = null, wireBuf = null, wireData = new Float32Array(8 * 256), nWires = 0;
function initWires() {
  const G = VC.gfx;
  wireProg = G.program('props_wires', WIRE_VS, WIRE_FS);
  const seg = new Float32Array((SEG + 1) * 4);
  for (let i = 0; i <= SEG; i++) {
    seg[i * 4] = i / SEG; seg[i * 4 + 1] = -1;
    seg[i * 4 + 2] = i / SEG; seg[i * 4 + 3] = 1;
  }
  const segBuf = G.buffer(gl.ARRAY_BUFFER, seg);
  wireBuf = gl.createBuffer();
  wireVao = gl.createVertexArray();
  gl.bindVertexArray(wireVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, segBuf);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 8, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, wireBuf);
  gl.bufferData(gl.ARRAY_BUFFER, 64, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
  gl.vertexAttribDivisor(0, 1);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
  gl.vertexAttribDivisor(1, 1);
  gl.bindVertexArray(null);
}
function pushWire(a, b, width) {
  if ((nWires + 1) * 8 > wireData.length) {
    const nd = new Float32Array(wireData.length * 2);
    nd.set(wireData);
    wireData = nd;
  }
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const o = nWires++ * 8;
  wireData[o] = a[0]; wireData[o + 1] = a[1]; wireData[o + 2] = a[2]; wireData[o + 3] = 0.03 + len * 0.045;
  wireData[o + 4] = b[0]; wireData[o + 5] = b[1]; wireData[o + 6] = b[2]; wireData[o + 7] = width;
}
/** Splits attachment points into the two sides of span direction (dx, dz), each sorted bottom-up. */
function sides(P, pts, dx, dz) {
  const L = [], R = [];
  for (const p of pts) ((p[0] - P.x) * -dz + (p[2] - P.z) * dx < 0 ? L : R).push(p);
  L.sort((a, b) => a[1] - b[1]);
  R.sort((a, b) => a[1] - b[1]);
  return [L, R];
}
function addSpan(A, Bp) {
  const dx = Bp.x - A.x, dz = Bp.z - A.z, l = Math.hypot(dx, dz) || 1;
  const ux = dx / l, uz = dz / l;
  const [al, ar] = sides(A, A.pts, ux, uz), [bl, br] = sides(Bp, Bp.pts, ux, uz);
  if (al.length && bl.length && ar.length && br.length) {
    for (let k = 0; k < Math.min(al.length, bl.length); k++) pushWire(al[k], bl[k], 0.009);
    for (let k = 0; k < Math.min(ar.length, br.length); k++) pushWire(ar[k], br[k], 0.009);
  } else {
    // arms parallel to the span: pair in order
    for (let k = 0; k < Math.min(A.pts.length, Bp.pts.length); k++) pushWire(A.pts[k], Bp.pts[k], 0.009);
  }
  pushWire(A.earth, Bp.earth, 0.006);
}
function rebuildWires() {
  wiresDirty = false;
  nWires = 0;
  for (const [i, A] of pylons) {
    const x = i % S.W, z = (i / S.W) | 0;
    for (let d = 0; d < 4; d += 2) {
      // walk +X (d = 0) and +Z (d = 2) along the line to the next pylon
      let xx = x + DX[d], zz = z + DZ[d];
      for (let k = 0; k < 16 && plAt(xx, zz); k++) {
        const j = zz * S.W + xx;
        const Bp = pylons.get(j);
        if (Bp) {
          addSpan(A, Bp);
          break;
        }
        xx += DX[d];
        zz += DZ[d];
      }
    }
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, wireBuf);
  gl.bufferData(gl.ARRAY_BUFFER, wireData.subarray(0, Math.max(8, nWires * 8)), gl.DYNAMIC_DRAW);
  PR.stats.wires = nWires;
}
function drawWires(ctx) {
  if (!nWires || !wireProg) return;
  gl.disable(gl.CULL_FACE);
  wireProg.use();
  gl.bindVertexArray(wireVao);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (SEG + 1) * 2, nWires);
  gl.bindVertexArray(null);
}

/* aW0 = (end A, sag), aW1 = (end B, half width), aSeg = (t, side). */
const WIRE_VS = `
layout(location=0) in vec4 aW0;
layout(location=1) in vec4 aW1;
layout(location=2) in vec2 aSeg;
out vec3 vWp;
out float vSide;
void main(){
  float t = aSeg.x;
  vec3 a = aW0.xyz, b = aW1.xyz;
  float bow = 4.0 * t * (1.0 - t);
  vec3 p = mix(a, b, t);
  p.y -= aW0.w * bow;
  float sway = sin(TIME * 1.3 + a.x * 0.7 + a.z * 0.9) * 0.025 * bow * (0.3 + uWind.z);
  p.xz += uWind.xy * sway;
  vec3 tg = b - a;
  tg.y -= aW0.w * 4.0 * (1.0 - 2.0 * t);
  tg = normalize(tg);
  vec3 toC = uCamPos.xyz - p;
  float dist = length(toC);
  vec3 sd = normalize(cross(tg, toC / max(dist, 1e-3)) + vec3(1e-5));
  float w = max(aW1.w, dist * 0.00045);
  p += sd * w * aSeg.y;
  vWp = p;
  vSide = aSeg.y;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;
const WIRE_FS = `
in vec3 vWp;
in float vSide;
out vec4 fragColor;
void main(){
  vec3 alb = vec3(0.035, 0.037, 0.04);
  vec3 n = normalize(vec3(0.0, 1.0, 0.0) + vec3(0.0, 0.0, vSide) * 0.3);
  vec3 col = alb * (uSkyAmb.rgb * 1.2 + uSunColor.rgb * uSunDir.w * 0.35);
  vec3 V = normalize(uCamPos.xyz - vWp);
  vec3 H = normalize(V + uSunDir.xyz);
  col += uSunColor.rgb * uSunDir.w * pow(max(dot(n, H), 0.0), 24.0) * 0.08;
  col = applyFog(col, vWp);
  fragColor = vec4(col, 1.0);
}`;
