/*
 * VOXELPOLIS — world generation.
 *
 *   VC.worldgen.generate(S, opts)          fills S.height / S.terr / S.trees for S.mapType from S.seed
 *   VC.worldgen.previewCanvas(o, px)       o = {seed, mapType, size, showStart?} -> px x px mini-map canvas of
 *                                            the same map (showStart: dashed outline of the start plateau)
 *   VC.worldgen.startArea(S)               -> {x0, z0, x1, z1, level, cx, cz}: the guaranteed dry, flat
 *                                            32x32 start plateau near the map center (inclusive tile rect)
 *   VC.worldgen.sample(seed, type, size, res) raw generator output {h, terr, trees, res, step, start}
 *   VC.worldgen.TYPES, VC.worldgen.lastMs  map type keys; duration of the last generate() call
 *
 * Pipeline (deterministic from seed + map type; RESOLUTION INDEPENDENT so the low-res preview
 * shows the same map): continuous height field in terrain levels built from type-specific landforms
 * (meandering river paths rasterized through a distance transform, noisy coastline with bays and
 * cliffs, island blobs, ridged mountain ranges around a valley, lake noise + blob lakes, gentle
 * plains with ponds) -> voxel terraces on land -> flat start plateau near the center -> integer
 * levels -> despeckle + contour smoothing (no 1-tile notches) -> shallow shelves along shores + seabed
 * smoothing -> materials (sand beaches, rock on steep/high ground, snow on peaks, dirt/meadow patches,
 * sandy shallows / silty deep beds along a noisy boundary) -> clustered forests + lone trees.
 *
 * Sampling: at resolution `res` sample (i, j) sits at tile coordinate (i + 0.5) * step - 0.5 with
 * step = size / res (step 1 = one sample per tile). Every distance / radius is in TILES.
 */
const M = VC.M, C = VC.C, TERR = VC.TERR;
const SEA = C.SEA;
const SQ2 = Math.SQRT2;

/** Per map type tuning: terrace period/sharpness, forest bias, beach width + noise gate (-1 = always). */
const TUNE = {
  river: { period: 3, sharp: [0.3, 0.6], forest: 0.1, beach: 1.3, gate: 0.05 },
  coast: { period: 3, sharp: [0.3, 0.6], forest: 0.14, beach: 2.6, gate: -1 },
  islands: { period: 3, sharp: [0.3, 0.55], forest: 0.1, beach: 2.2, gate: -1 },
  mountains: { period: 4, sharp: [0.35, 0.65], forest: 0.0, beach: 1.1, gate: 0.25 },
  lakes: { period: 3, sharp: [0.3, 0.6], forest: -0.1, beach: 1.3, gate: 0.2 },
  plains: { period: 2, sharp: [0.35, 0.6], forest: 0.3, beach: 1.3, gate: 0.0 },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */
/**
 * Two-pass 8-neighbour chamfer distance transform in SAMPLE units. seeds: Uint8Array (1 = source).
 * vals (optional Float32Array): value carried along from the nearest source (e.g. river width).
 */
function distField(res, seeds, vals) {
  const N = res * res;
  const d = new Float32Array(N);
  const v = vals ? Float32Array.from(vals) : null;
  for (let k = 0; k < N; k++) d[k] = seeds[k] ? 0 : 1e9;
  for (let j = 0; j < res; j++)
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      let best = d[k], src = -1;
      if (i > 0 && d[k - 1] + 1 < best) { best = d[k - 1] + 1; src = k - 1; }
      if (j > 0) {
        if (d[k - res] + 1 < best) { best = d[k - res] + 1; src = k - res; }
        if (i > 0 && d[k - res - 1] + SQ2 < best) { best = d[k - res - 1] + SQ2; src = k - res - 1; }
        if (i < res - 1 && d[k - res + 1] + SQ2 < best) { best = d[k - res + 1] + SQ2; src = k - res + 1; }
      }
      if (src >= 0) { d[k] = best; if (v) v[k] = v[src]; }
    }
  for (let j = res - 1; j >= 0; j--)
    for (let i = res - 1; i >= 0; i--) {
      const k = j * res + i;
      let best = d[k], src = -1;
      if (i < res - 1 && d[k + 1] + 1 < best) { best = d[k + 1] + 1; src = k + 1; }
      if (j < res - 1) {
        if (d[k + res] + 1 < best) { best = d[k + res] + 1; src = k + res; }
        if (i < res - 1 && d[k + res + 1] + SQ2 < best) { best = d[k + res + 1] + SQ2; src = k + res + 1; }
        if (i > 0 && d[k + res - 1] + SQ2 < best) { best = d[k + res - 1] + SQ2; src = k + res - 1; }
      }
      if (src >= 0) { d[k] = best; if (v) v[k] = v[src]; }
    }
  return { d, v };
}

/** Pushes a path point radially out of the disc (cx, cz, R) — keeps rivers off the start plateau. */
function pushOut(p, cx, cz, R) {
  const dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz);
  if (d < R) {
    const a = d > 1e-6 ? Math.atan2(dz, dx) : 0;
    p.x = cx + Math.cos(a) * R;
    p.z = cz + Math.sin(a) * R;
  }
}

/** Rasterizes path points {x, z, w} (tile coords) into distance-transform seeds (keeps the widest). */
function stampPath(g, pts, seeds, vals) {
  const { res, step } = g;
  for (const p of pts) {
    const i = Math.round((p.x + 0.5) / step - 0.5), j = Math.round((p.z + 0.5) / step - 0.5);
    if (i < 0 || j < 0 || i >= res || j >= res) continue;
    const k = j * res + i;
    if (!seeds[k] || vals[k] < p.w) { seeds[k] = 1; vals[k] = p.w; }
  }
}

/** Voxel terrace: flat treads with a rise in the last `sharp` fraction of each period. */
function terrace(off, period, sharp) {
  const t = off / period, k = Math.floor(t), f = t - k;
  return (k + M.smoothstep(1 - sharp, 1, f)) * period;
}

/**
 * Smooth noise field: fn(tx, tz) evaluated on a coarse lattice every `cell` tiles and bilinearly
 * upsampled to res x res. All low-frequency noise goes through here (the expensive part).
 */
function field(g, fn, cell) {
  const { res, step } = g;
  const out = new Float32Array(res * res);
  const cs = Math.max(1, Math.round(cell / step));
  if (cs === 1) {
    for (let j = 0, k = 0; j < res; j++) for (let i = 0; i < res; i++, k++) out[k] = fn((i + 0.5) * step - 0.5, (j + 0.5) * step - 0.5);
    return out;
  }
  const nc = Math.ceil((res - 1) / cs) + 1;
  const lat = new Float32Array(nc * nc);
  for (let b = 0; b < nc; b++) for (let a = 0; a < nc; a++) lat[b * nc + a] = fn((a * cs + 0.5) * step - 0.5, (b * cs + 0.5) * step - 0.5);
  for (let j = 0, k = 0; j < res; j++) {
    const b = (j / cs) | 0, fz = (j - b * cs) / cs, r0 = b * nc, r1 = Math.min(nc - 1, b + 1) * nc;
    for (let i = 0; i < res; i++, k++) {
      const a = (i / cs) | 0, fx = (i - a * cs) / cs, a1 = Math.min(nc - 1, a + 1);
      const v00 = lat[r0 + a], v10 = lat[r0 + a1], v01 = lat[r1 + a], v11 = lat[r1 + a1];
      out[k] = v00 + (v10 - v00) * fx + (v01 - v00) * fz + (v00 - v10 - v01 + v11) * fx * fz;
    }
  }
  return out;
}

/** Registers the rolling-hills fields (dry-land base of river/coast maps). */
function hillFields(g) {
  const nz = g.nz;
  g.hA = field(g, (x, z) => 10.5 + nz.fbm(x / 70, z / 70, 4) * 7.5, 4);
  g.hB = field(g, (x, z) => Math.max(0, nz.ridge(x / 38 + 11, z / 38 - 7, 3) - 0.55) * 16, 2);
}
/** Rolling hills at sample k (levels, roughly 6..22). */
function hills(g, tx, tz, k) {
  return g.hA[k] + g.hB[k] + g.nz.n2(tx / 9, tz / 9) * 0.6;
}

/** Carves blob lakes {x, z, r} with sloping shores into height h. */
function blobs(g, list, h, tx, tz) {
  for (let q = 0; q < list.length; q++) {
    const b = list[q];
    const dx = tx - b.x, dz = tz - b.z, lim = b.r * 1.6 + 4;
    if (dx > lim || dx < -lim || dz > lim || dz < -lim) continue;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > lim) continue;
    const li = 1 - d / b.r + g.nz.n2(tx / 5 + b.x * 0.37, tz / 5 - b.z * 0.21) * 0.2;
    if (li > 0) h = Math.min(h, SEA - 1 - Math.min(3.5, li * 6));
    else if (li > -0.55) h = M.lerp(h, Math.min(h, SEA + 0.35), M.smoothstep(-0.55, 0, li));
  }
  return h;
}

/** Picks n blob lakes away from the start plateau. accept(x, z) filters candidates. */
function placeBlobs(g, n, rMin, rMax, accept) {
  const out = [];
  const { rng, size, sc } = g;
  for (let t = 0; t < 300 && out.length < n; t++) {
    const r = rMin + rng() * (rMax - rMin);
    const x = r + 3 + rng() * (size - 2 * r - 6), z = r + 3 + rng() * (size - 2 * r - 6);
    if (Math.hypot(x - sc[0], z - sc[1]) < g.keep + r) continue;
    if (out.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + r + 4)) continue;
    if (accept && !accept(x, z, r)) continue;
    out.push({ x, z, r });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Map types: setup(g) once, then height(g, tx, tz, k) per sample       */
/* ------------------------------------------------------------------ */
const GEN = {};

/* ---- River valley: a meandering river edge to edge (+ maybe a tributary) in a broad valley ---- */
GEN.river = {
  setup(g) {
    const { size, rng, nz2, sc } = g;
    const half = (size - 1) / 2;
    const alongX = rng() < 0.5;
    const side = rng() < 0.5 ? -1 : 1;
    const off0 = side * (g.keep * 0.92 + size * (0.01 + rng() * 0.05));
    const A1 = size * (0.04 + rng() * 0.06), L1 = size * (0.55 + rng() * 0.4), P1 = rng() * 6.283;
    const A2 = size * (0.012 + rng() * 0.022), L2 = size * (0.16 + rng() * 0.12), P2 = rng() * 6.283;
    const drift = (rng() - 0.5) * 0.3;
    const wAdd = (size / 256) * 0.8;
    const mk = (a, c, w) => (alongX ? { x: a, z: c, w } : { x: c, z: a, w });
    const main = [];
    for (let a = -6; a <= size + 6; a += 0.5) {
      let c = half + off0 + drift * (a - half) + A1 * Math.sin((a / L1) * 6.283 + P1) + A2 * Math.sin((a / L2) * 6.283 + P2) + nz2.n2(a / 40, 17.3) * size * 0.025;
      c = M.clamp(c, 3, size - 4);
      const w = 2.1 + 2.6 * (0.5 + 0.5 * nz2.n2(a / 28, 5.1)) + wAdd;
      const p = mk(a, c, w);
      pushOut(p, sc[0], sc[1], g.keep);
      main.push(p);
    }
    const paths = [main];
    // tributary: joins near one end of the main river and crosses to the opposite side of the map
    if (rng() < 0.65) {
      const t0 = rng() < 0.5 ? 0.1 + rng() * 0.14 : 0.76 + rng() * 0.14;
      const j0 = M.clamp(Math.round((t0 * size + 6) / 0.5), 0, main.length - 1);
      const s0 = main[j0];
      const aBase = alongX ? s0.x : s0.z, cStart = alongX ? s0.z : s0.x;
      const cEnd = side > 0 ? -6 : size + 6;
      const n = Math.ceil(Math.abs(cEnd - cStart) / 0.5);
      const TA = size * (0.03 + rng() * 0.04), TL = size * (0.25 + rng() * 0.3), TP = rng() * 6.283;
      const tdrift = (rng() - 0.5) * 0.45;
      const trib = [];
      for (let s = 0; s <= n; s++) {
        const pr = s / n;
        const c = cStart + (cEnd - cStart) * pr;
        const dc = Math.abs(c - cStart);
        const a = M.clamp(aBase + tdrift * dc + TA * Math.sin((dc / TL) * 6.283 + TP) * Math.min(1, pr * 5) - TA * Math.sin(TP) * Math.min(1, pr * 5), 3, size - 4);
        const w = 1.5 + 1.3 * (0.5 + 0.5 * nz2.n2(c / 20, 71.1)) * (1 - pr * 0.35) + wAdd * 0.5;
        const p = mk(a, c, w);
        pushOut(p, sc[0], sc[1], g.keep);
        trib.push(p);
      }
      paths.push(trib);
    }
    const seeds = new Uint8Array(g.N), vals = new Float32Array(g.N);
    for (const p of paths) stampPath(g, p, seeds, vals);
    g.riv = distField(g.res, seeds, vals);
    g.paths = paths;
    hillFields(g);
    g.flood = field(g, (x, z) => SEA + 1.1 + Math.max(0, g.nz.fbm(x / 30 + 5, z / 30, 2)) * 1.6, 4);
    g.valW = field(g, (x, z) => 8 + 9 * (0.5 + 0.5 * g.nz.n2(x / 45, z / 45 + 9)), 4);
  },
  height(g, tx, tz, k) {
    const d = g.riv.d[k] * g.step, hw = g.riv.v[k] * 0.5;
    if (d < hw) return SEA - 1.3 - 2.3 * (1 - d / hw);
    if (d < hw + 1.1) return SEA + 0.2; // low bank
    const land = Math.max(SEA + 1.4, hills(g, tx, tz, k));
    return M.lerp(g.flood[k], land, M.smoothstep(hw + 1.1, hw + 1.1 + g.valW[k], d));
  },
};

/* ---- Coastline: ocean on one or two edges, bays, beaches, headlands and occasional cliffs ---- */
GEN.coast = {
  setup(g) {
    const { size, rng } = g;
    const e1 = rng.int(0, 3);
    g.edges = [e1];
    if (rng() < 0.4) g.edges.push(e1 < 2 ? 2 + rng.int(0, 1) : rng.int(0, 1));
    // move the start plateau inland, away from the ocean edges
    const sh = size * 0.05;
    for (const e of g.edges) {
      if (e === 0) g.sc[0] += sh;
      else if (e === 1) g.sc[0] -= sh;
      else if (e === 2) g.sc[1] += sh;
      else g.sc[1] -= sh;
    }
    g.noiseAmp = size * 0.1;
    let minS = 1e9; // distance from the plateau's far corner to the nearest ocean edge
    for (const e of g.edges) {
      const c = e < 2 ? g.sc[0] : g.sc[1];
      minS = Math.min(minS, e % 2 === 0 ? c : size - 1 - c);
    }
    const maxDist = minS - g.outer * 1.05 - 2 - g.noiseAmp * 0.75;
    g.coastDist = Math.max(size * 0.08, Math.min(size * (0.17 + rng() * 0.08), maxDist));
    hillFields(g);
    g.cN = field(g, (x, z) => g.nz2.fbm(x / 48, z / 48, 4) * g.noiseAmp, 4);
    g.cl = field(g, (x, z) => g.nz2.n2(x / 30 + 400, z / 30 - 70), 2);
  },
  height(g, tx, tz, k) {
    const { nz, size } = g;
    let s = 1e9;
    for (const e of g.edges) s = Math.min(s, e === 0 ? tx : e === 1 ? size - 1 - tx : e === 2 ? tz : size - 1 - tz);
    const c = s - g.coastDist + g.cN[k] + nz.n2(tx / 11, tz / 11) * 1.8;
    if (c < 0) return SEA - 1 - Math.min(5.5, -c * 0.3);
    const land = Math.max(SEA + 1.4, hills(g, tx, tz, k));
    let h = M.lerp(SEA + 0.25, land, M.smoothstep(2.4, 16, c));
    const cl = g.cl[k];
    if (cl > 0.28) {
      const cf = M.smoothstep(0.28, 0.45, cl) * M.smoothstep(-0.2, 1.2, c) * (1 - M.smoothstep(14, 24, c));
      if (cf > 0.02) {
        h = M.lerp(h, Math.max(h, 12 + cl * 9), cf);
        if (cf > 0.4 && c < 6) g.cliff[k] = 1;
      }
    }
    return h;
  },
};

/* ---- Archipelago: a big main island at the center plus 3..7 islands separated by channels ---- */
GEN.islands = {
  setup(g) {
    const { size, rng, sc } = g;
    const list = [{ x: sc[0] + (rng() - 0.5) * size * 0.03, z: sc[1] + (rng() - 0.5) * size * 0.03, r: Math.max(g.core * 1.19 + 9, size * 0.3), peak: 15 + rng() * 6 }];
    const extra = rng.int(3, 7);
    for (let n = 0, t = 0; n < extra && t < 600; t++) {
      const r = Math.max(5, size * (0.045 + rng() * 0.08));
      const x = r + 2 + rng() * (size - 2 * r - 4), z = r + 2 + rng() * (size - 2 * r - 4);
      if (list.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r + 6)) {
        list.push({ x, z, r, peak: 9 + rng() * 11 });
        n++;
      }
    }
    g.isl = list;
    g.eN = field(g, (x, z) => g.nz2.fbm(x / 20, z / 20, 3) * 0.3, 2);
    g.iN = field(g, (x, z) => 0.5 + 0.5 * g.nz.fbm(x / 34, z / 34, 3), 4);
  },
  height(g, tx, tz, k) {
    const nz = g.nz;
    let best = -9, bi = 0;
    for (let q = 0; q < g.isl.length; q++) {
      const o = g.isl[q];
      const dx = tx - o.x, dz = tz - o.z;
      const e = 1 - Math.sqrt(dx * dx + dz * dz) / o.r;
      if (e > best) { best = e; bi = q; }
    }
    const e = best + g.eN[k] + nz.n2(tx / 6.5, tz / 6.5) * 0.05;
    if (e < 0) return SEA - 1 + Math.max(-6, e * 16);
    const pk = g.isl[bi].peak;
    const n01 = g.iN[k];
    const inner = SEA + 1.2 + (pk - SEA - 1.2) * (0.25 + 0.75 * n01) * M.smoothstep(0.1, 0.8, e);
    return M.lerp(SEA + 0.25, inner, M.smoothstep(0.03, 0.3, e));
  },
};

/* ---- Alpine highlands: ridged snowy ranges around a buildable valley, alpine lakes ---- */
GEN.mountains = {
  setup(g) {
    const { size } = g;
    g.mmask = (tx, tz) => {
      const dc = Math.hypot(tx - g.sc[0], tz - g.sc[1]) / (size * 0.5);
      return M.smoothstep(0.3, 0.88, dc + g.nz.fbm(tx / 60 + 30, tz / 60, 3) * 0.35);
    };
    const n = 2 + (g.rng() * 3) | 0;
    const s = size / 128;
    g.lakes = placeBlobs(g, n, 3 * s + 1, 5.5 * s + 2, (x, z) => {
      const m = g.mmask(x, z);
      return m > 0.04 && m < 0.35;
    });
    g.mm = field(g, g.mmask, 4);
    // broad massifs (snowy summits) + ridged crests and gullies
    g.rdg = field(g, (x, z) => {
      const m = M.clamp(0.5 + 0.85 * g.nz2.fbm(x / 85, z / 85, 4), 0, 1);
      return 12 + m * 27 + Math.pow(g.nz2.ridge(x / 38 + 3, z / 38, 4), 2) * 17;
    }, 2);
    g.val = field(g, (x, z) => 8.2 + g.nz.fbm(x / 38, z / 38, 3) * 2.4, 4);
  },
  height(g, tx, tz, k) {
    const peak = g.rdg[k] + g.nz.n2(tx / 12, tz / 12) * 1.5;
    return blobs(g, g.lakes, M.lerp(g.val[k], peak, g.mm[k]), tx, tz);
  },
};

/* ---- Lakeland: dozens of lakes of every size among forested hills ---- */
GEN.lakes = {
  setup(g) {
    const s = g.size / 128;
    g.lakes = placeBlobs(g, 1 + ((g.rng() * 3) | 0), 5 * s + 2, 11 * s + 2);
    g.lA = field(g, (x, z) => 9 + g.nz.fbm(x / 70, z / 70, 4) * 4, 4);
    g.lB = field(g, (x, z) => Math.max(0, g.nz.fbm(x / 26 + 50, z / 26, 3)) * 6, 2);
    g.lL = field(g, (x, z) => g.nz2.fbm(x / 23 + 700, z / 23 - 300, 4), 2);
  },
  height(g, tx, tz, k) {
    const nz = g.nz;
    const land = g.lA[k] + g.lB[k] + nz.n2(tx / 8, tz / 8) * 0.4;
    const L = g.lL[k] + nz.n2(tx / 7, tz / 7) * 0.05;
    const thr = 0.17;
    let h;
    if (L > thr) h = SEA - 1 - Math.min(4, (L - thr) * 22);
    else h = M.lerp(Math.max(land, SEA + 1.2), SEA + 0.35, M.smoothstep(thr - 0.08, thr, L));
    return blobs(g, g.lakes, h, tx, tz);
  },
};

/* ---- Great plains: mostly flat, gentle rises, a few ponds ---- */
GEN.plains = {
  setup(g) {
    g.pA = field(g, (x, z) => 8 + g.nz.fbm(x / 90, z / 90, 4) * 3.2 + Math.max(0, g.nz.fbm(x / 32 + 40, z / 32, 3) - 0.05) * 7, 4);
    g.pP = field(g, (x, z) => g.nz2.fbm(x / 26 + 300, z / 26, 3), 2);
  },
  height(g, tx, tz, k) {
    const nz = g.nz;
    const h = g.pA[k] + nz.n2(tx / 7, tz / 7) * 0.3;
    const P = g.pP[k] + nz.n2(tx / 5, tz / 5) * 0.04;
    const thr = 0.5;
    if (P > thr) return SEA - 1 - Math.min(3, (P - thr) * 20);
    return M.lerp(Math.max(h, SEA + 1.2), SEA + 0.4, M.smoothstep(thr - 0.05, thr, P));
  },
};

/* ------------------------------------------------------------------ */
/* Core generator                                                       */
/* ------------------------------------------------------------------ */
/**
 * Generates a map of size x size tiles sampled at res x res.
 * Returns { res, step, h (levels), terr, trees (Uint8Array res*res), start }.
 */
function build(seed, type, size, res) {
  if (!GEN[type]) type = 'river';
  const step = size / res, N = res * res;
  const g = {
    seed, type, size, res, step, N,
    nz: VC.makeNoise(seed),
    nz2: VC.makeNoise((Math.imul(seed, 2654435761) + 1013904223) >>> 0),
    rng: M.rng((seed ^ M.seedFromString('worldgen:' + type)) >>> 0),
    tune: TUNE[type],
    sc: [(size - 1) / 2, (size - 1) / 2],
    cliff: new Uint8Array(N),
  };
  g.core = 19; // superellipse radius of the fully flat plateau (contains a 32x32 square)
  g.outer = g.core + Math.max(6, Math.round(size * 0.06)); // blend back into the landscape
  g.keep = g.outer * 1.2 + 2; // rivers/lakes stay outside this radius
  const T = g.tune, nz = g.nz, nz2 = g.nz2;
  GEN[type].setup(g);
  const sc = g.sc;

  // ---- 1. continuous heights + terraces ----
  const h = new Float32Array(N);
  const gen = GEN[type].height;
  const sharp = field(g, (x, z) => M.lerp(T.sharp[0], T.sharp[1], 0.5 + 0.5 * nz.n2(x / 40 + 77, z / 40 - 13)), 4);
  const B = SEA + 1; // first terrace tread (0.37 above the water surface)
  for (let j = 0, k = 0; j < res; j++) {
    const tz = (j + 0.5) * step - 0.5;
    for (let i = 0; i < res; i++, k++) {
      const tx = (i + 0.5) * step - 0.5;
      let v = gen(g, tx, tz, k);
      if (v > B) {
        v = B + terrace(v - B, T.period, sharp[k]);
      }
      h[k] = v;
    }
  }

  // ---- 2. flat start plateau (superellipse |dx|^4 + |dz|^4, contains a 32x32 square) ----
  const sw = new Float32Array(N); // plateau weight 0..1 (used to thin forests)
  const sdist = (tx, tz) => {
    const dx = (tx - sc[0]) ** 2, dz = (tz - sc[1]) ** 2;
    return Math.sqrt(Math.sqrt(dx * dx + dz * dz));
  };
  let sum = 0, cnt = 0;
  for (let j = 0, k = 0; j < res; j++)
    for (let i = 0; i < res; i++, k++) {
      const d = sdist((i + 0.5) * step - 0.5, (j + 0.5) * step - 0.5);
      if (d < g.core) { sum += h[k]; cnt++; }
    }
  const Lf = M.clamp(Math.round(cnt ? sum / cnt : SEA + 2), SEA + 1, 16);
  for (let j = 0, k = 0; j < res; j++) {
    const tz = (j + 0.5) * step - 0.5;
    for (let i = 0; i < res; i++, k++) {
      const tx = (i + 0.5) * step - 0.5;
      const d = sdist(tx, tz);
      if (d >= g.outer + 4) continue;
      const w = 1 - M.smoothstep(g.core, g.outer + nz.n2(tx / 9, tz / 9) * 2.5, d);
      sw[k] = w;
      h[k] = M.lerp(h[k], Lf, w);
    }
  }

  // ---- 3. integer levels, despeckle ----
  const L = new Uint8Array(N);
  for (let k = 0; k < N; k++) L[k] = M.clamp(Math.round(h[k]), 0, C.MAXH);
  for (let pass = 0; pass < 2; pass++)
    for (let j = 1; j < res - 1; j++)
      for (let i = 1, k = j * res + 1; i < res - 1; i++, k++) {
        const a = L[k - 1], b = L[k + 1], c = L[k - res], d = L[k + res];
        const mx = Math.max(a, b, c, d), mn = Math.min(a, b, c, d);
        if (L[k] > mx) L[k] = mx;
        else if (L[k] < mn) L[k] = mn;
      }
  // contour smoothing: a land tile one level off from 3+ agreeing neighbours takes their level. Removes the
  // 1-tile notches / protrusions along every contour, whose 0.25-high risers (and their shadows) read as
  // short dark scratches all over gentle maps. Shorelines never move (both levels must be dry land).
  for (let pass = 0; pass < 2; pass++)
    for (let j = 1; j < res - 1; j++)
      for (let i = 1, k = j * res + 1; i < res - 1; i++, k++) {
        const c = L[k];
        if (c < SEA) continue;
        const a = L[k - 1], b = L[k + 1], d = L[k - res], e = L[k + res];
        const t = a === b && (a === d || a === e) ? a : d === e && (d === a || d === b) ? d : -1;
        if (t >= SEA && (t === c + 1 || t === c - 1)) L[k] = t;
      }

  // ---- 4. distance to water / land, shallow shelves along shores ----
  const wet = new Uint8Array(N), dry = new Uint8Array(N);
  for (let k = 0; k < N; k++) { wet[k] = L[k] < SEA ? 1 : 0; dry[k] = 1 - wet[k]; }
  const dW = distField(res, wet).d, dL = distField(res, dry).d;
  for (let k = 0; k < N; k++) {
    if (!wet[k]) continue;
    const d = dL[k] * step;
    if (d <= 1.01) L[k] = Math.max(L[k], SEA - 1);
    else if (d <= 2.6) L[k] = Math.max(L[k], SEA - 2);
  }
  // the same notch smoothing on the seabed: single tiles one level off their shelf show through the water as
  // a light / dark tile checkerboard (water stays water)
  for (let pass = 0; pass < 2; pass++)
    for (let j = 1; j < res - 1; j++)
      for (let i = 1, k = j * res + 1; i < res - 1; i++, k++) {
        const c = L[k];
        if (c >= SEA) continue;
        const a = L[k - 1], b = L[k + 1], d = L[k - res], e = L[k + res];
        const t = a === b && (a === d || a === e) ? a : d === e && (d === a || d === b) ? d : -1;
        if (t >= 0 && t < SEA && (t === c + 1 || t === c - 1)) L[k] = t;
      }

  // ---- 5. materials + forests ----
  const terr = new Uint8Array(N), trees = new Uint8Array(N);
  const mtn = type === 'mountains';
  const fS = field(g, (x, z) => nz.n2(x / 9 + 300, z / 9), 2);
  const fG = T.gate < -0.5 ? null : field(g, (x, z) => nz2.n2(x / 12 - 120, z / 12), 2);
  const fD = field(g, (x, z) => nz.fbm(x / 22 + 200, z / 22 - 50, 3), 2);
  const fM = field(g, (x, z) => nz2.fbm(x / 19 + 150, z / 19 + 80, 3), 2);
  const fF = field(g, (x, z) => nz2.fbm(x / 17 + 900, z / 17 - 400, 3), 2);
  for (let j = 0, k = 0; j < res; j++) {
    const tz = (j + 0.5) * step - 0.5;
    for (let i = 0; i < res; i++, k++) {
      const tx = (i + 0.5) * step - 0.5;
      const lv = L[k];
      if (lv < SEA) {
        // sandy shallows, silty deep beds; the boundary follows smooth noise (a bare distance threshold
        // lands in the middle of 4-6 tile rivers and scatters sand / silt tiles into a checkerboard)
        terr[k] = dL[k] * step + fS[k] * 0.9 <= 3.2 ? TERR.SAND : TERR.DIRT;
        continue;
      }
      let sl = 0;
      if (i > 0) sl = Math.max(sl, Math.abs(lv - L[k - 1]));
      if (i < res - 1) sl = Math.max(sl, Math.abs(lv - L[k + 1]));
      if (j > 0) sl = Math.max(sl, Math.abs(lv - L[k - res]));
      if (j < res - 1) sl = Math.max(sl, Math.abs(lv - L[k + res]));
      sl /= step;
      const nS = fS[k];
      const dw = dW[k] * step;
      let m;
      if (lv >= 34 + nS * 2.5) m = TERR.SNOW;
      else if (lv >= 27 + nS * 3 || (sl >= 5 && lv > SEA + 5 && nS > -0.3) || (mtn && sl >= 3 && lv > 18) || (g.cliff[k] && dw < 4)) m = TERR.ROCK;
      else if (dw <= T.beach && lv <= SEA + 1 && (!fG || fG[k] > T.gate)) m = TERR.SAND;
      else if (fD[k] > 0.5) m = TERR.DIRT;
      else if (fM[k] > 0.16) m = TERR.MEADOW;
      else m = TERR.GRASS;
      terr[k] = m;
      if (m === TERR.SAND || m === TERR.ROCK || m === TERR.SNOW) continue;
      let F = fF[k] - T.forest + (M.hash(i, j, seed + 5) - 0.5) * 0.1;
      F -= Math.max(0, lv - 18) * 0.022 + sw[k] * 0.3;
      if (dw < 1.5) F -= 0.08;
      let n = F > 0.3 ? 3 : F > 0.17 ? 2 : F > 0.05 ? 1 : 0;
      if (!n && m !== TERR.DIRT && M.hash(i, j, seed) < 0.012) n = 1;
      trees[k] = n;
    }
  }

  // start rect: inclusive 32x32 tiles around the plateau center
  const x0 = M.clamp(Math.round(sc[0] - 15.5), 0, size - 32), z0 = M.clamp(Math.round(sc[1] - 15.5), 0, size - 32);
  const start = { x0, z0, x1: x0 + 31, z1: z0 + 31, level: Lf, cx: sc[0], cz: sc[1] };
  return { res, step, h: L, terr, trees, start, g };
}

/* ------------------------------------------------------------------ */
/* Preview palette                                                      */
/* ------------------------------------------------------------------ */
const PREV = {
  deep: [24, 72, 122], shallow: [66, 156, 178], sand: [226, 208, 152], dirt: [150, 116, 78],
  rock: [132, 127, 120], snow: [242, 245, 252], grassLo: [104, 166, 74], grassHi: [138, 150, 86],
  meadow: [132, 178, 84], forest: [46, 104, 52],
};

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */
VC.worldgen = {
  TYPES: Object.keys(GEN),
  lastMs: 0,

  generate(S, opts = {}) {
    const t0 = performance.now();
    const type = GEN[S.mapType] ? S.mapType : 'river';
    const size = Math.max(S.W, S.H);
    const r = build(S.seed >>> 0, type, size, size);
    if (S.W === size && S.H === size) {
      S.height.set(r.h);
      S.terr.set(r.terr);
      S.trees.set(r.trees);
    } else {
      for (let z = 0; z < S.H; z++)
        for (let x = 0; x < S.W; x++) {
          const i = z * S.W + x, k = z * size + x;
          S.height[i] = r.h[k];
          S.terr[i] = r.terr[k];
          S.trees[i] = r.trees[k];
        }
    }
    S.worldgenStart = r.start;
    S.ver.terrain++;
    S.ver.trees++;
    VC.worldgen.lastMs = performance.now() - t0;
    return S;
  },

  /** The guaranteed dry, flat start plateau (inclusive tile rect) or a best-effort search on loaded maps. */
  startArea(S) {
    S = S || VC.state;
    if (!S) return null;
    if (S.worldgenStart) return S.worldgenStart;
    const x0 = Math.max(0, (S.W >> 1) - 16), z0 = Math.max(0, (S.H >> 1) - 16);
    return { x0, z0, x1: Math.min(S.W - 1, x0 + 31), z1: Math.min(S.H - 1, z0 + 31), level: S.height[(S.H >> 1) * S.W + (S.W >> 1)], cx: S.W / 2, cz: S.H / 2 };
  },

  /** Raw generator (no state): {h, terr, trees, res, step, start} at resolution res (default = size). */
  sample(seed, mapType, size, res) {
    return build(seed >>> 0, mapType, size, res || size);
  },

  /**
   * Mini-map preview of the map the given options will generate. Fast (< 60 ms): the same
   * generator runs at reduced resolution; output is px x px with hill shading and forests.
   */
  previewCanvas(o = {}, px = 160) {
    px = Math.max(16, px | 0);
    const size = o.size || VC.MAP_SIZES.medium;
    const res = Math.min(size, px, 128);
    const r = build((o.seed >>> 0) || 1, o.mapType || 'river', size, res);
    const cv = document.createElement('canvas');
    cv.width = cv.height = px;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(px, px);
    const d = img.data;
    const H = r.h, TR = r.terr, TRE = r.trees;
    const col = new Uint8Array(res * res * 3);
    for (let j = 0, k = 0; j < res; j++)
      for (let i = 0; i < res; i++, k++) {
        const lv = H[k];
        let c;
        if (lv < SEA) {
          const t = M.clamp(lv / (SEA - 1), 0, 1);
          c = [M.lerp(PREV.deep[0], PREV.shallow[0], t), M.lerp(PREV.deep[1], PREV.shallow[1], t), M.lerp(PREV.deep[2], PREV.shallow[2], t)];
        } else {
          const m = TR[k];
          if (m === TERR.SAND) c = PREV.sand;
          else if (m === TERR.ROCK) c = PREV.rock;
          else if (m === TERR.SNOW) c = PREV.snow;
          else if (m === TERR.DIRT) c = PREV.dirt;
          else {
            const t = M.clamp((lv - SEA) / 22, 0, 1);
            const base = m === TERR.MEADOW ? PREV.meadow : PREV.grassLo;
            c = [M.lerp(base[0], PREV.grassHi[0], t), M.lerp(base[1], PREV.grassHi[1], t), M.lerp(base[2], PREV.grassHi[2], t)];
          }
          if (TRE[k]) {
            const f = 0.35 + TRE[k] * 0.2;
            c = [M.lerp(c[0], PREV.forest[0], f), M.lerp(c[1], PREV.forest[1], f), M.lerp(c[2], PREV.forest[2], f)];
          }
          // hill shading, light from the north-west
          const nw = H[Math.max(0, j - 1) * res + Math.max(0, i - 1)];
          const s = M.clamp(1 + (lv - Math.max(nw, SEA)) * 0.09 / r.step, 0.72, 1.28);
          c = [c[0] * s, c[1] * s, c[2] * s];
        }
        col[k * 3] = M.clamp(c[0], 0, 255);
        col[k * 3 + 1] = M.clamp(c[1], 0, 255);
        col[k * 3 + 2] = M.clamp(c[2], 0, 255);
      }
    for (let y = 0, o4 = 0; y < px; y++) {
      const j = Math.min(res - 1, ((y * res) / px) | 0);
      for (let x = 0; x < px; x++, o4 += 4) {
        const k = (j * res + Math.min(res - 1, ((x * res) / px) | 0)) * 3;
        d[o4] = col[k];
        d[o4 + 1] = col[k + 1];
        d[o4 + 2] = col[k + 2];
        d[o4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    if (o.showStart) {
      // dashed outline of the guaranteed flat start plateau
      const st = r.start, k = px / size;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = Math.max(1, px / 160);
      ctx.setLineDash([Math.max(2, px / 40), Math.max(2, px / 60)]);
      ctx.strokeRect(st.x0 * k + 0.5, st.z0 * k + 0.5, (st.x1 - st.x0 + 1) * k - 1, (st.z1 - st.z0 + 1) * k - 1);
      ctx.restore();
    }
    return cv;
  },
};
