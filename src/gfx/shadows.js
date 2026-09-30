/*
 * VOXELPOLIS — sun/moon shadow maps (VC.shadows.render(ctx), called by gfx core before the main pass).
 *
 * ONE depth atlas (DEPTH_COMPONENT24, hardware compare, LINEAR) holding 1 or 2 orthographic cascades
 * side by side:  cascade 0 = NEAR (the focus area around the camera target), cascade 1 = FAR (the rest of
 * the visible city). High/Ultra use the far cascade only when the view is long (low pitch); top-down
 * views fit in one cascade. Medium uses a single map. Quality 'low' (shadow 0) or settings.shadows=false
 * skips the pass (core).
 *
 * FITTING (per cascade, per frame):
 *   the camera frustum, truncated at the cascade distance, is intersected with the slab of heights where
 *   receivers exist (ground .. ground + tallest building, refined from a coarse per-block min/max grid),
 *   projected to XZ, convex-hulled and clipped to the map rectangle. The minimal enclosing circle of that
 *   footprint + the slab height gives a light-space square whose size does not change when the camera
 *   orbits (rotation-invariant). The size is quantized with hysteresis (only grows when needed, shrinks
 *   when > 30 % too big) and the center is snapped to whole shadow texels, so shadows never shimmer while
 *   panning or rotating. The depth range spans every caster on the map toward the light, so nothing is clipped.
 *
 * OUTPUT: VC.gfx.setShadow(tex, mat) — mat maps world -> atlas texture space of the near cascade — plus
 *   VC.gfx.shadowFar = {k, ox, oy} (far cascade coords = near * k + o), which core writes into uPad for
 *   shaderlib's shadowAt(). Slope-scaled polygon offset is set through VC.gfx.shadowBias (core applies it
 *   in the shadow pass); the receiver side uses a texel-sized normal offset + rotated 12-tap PCF.
 *
 * EXTRA API: VC.shadows.stats (cascades, half sizes, last pass ms), VC.shadows.viewProj[c] (light VP of
 *   cascade c, valid after render), VC.shadows.maxHeight() (tallest receiver Y, from the height grid).
 */
const M = VC.M;
const SH = (VC.shadows = {
  tex: null,
  fbo: null,
  size: 0, // per-cascade resolution
  atlasW: 0,
  atlasH: 0,
  cascades: 0, // cascades rendered this frame (0 = none)
  viewProj: [new Float32Array(16), new Float32Array(16)],
  frustum: [new Float32Array(24), new Float32Array(24)],
  mat: new Float32Array(16),
  far: { k: 0, ox: 0, oy: 0 },
  stats: { cascades: 0, half: [0, 0], size: 0, ms: 0, reused: 0 },
  /** Frames between shadow map updates (1 = every frame; 'ultra' always uses 1). */
  interval: 2,
  cache: { valid: false, n: 0, moon: false, size: 0, frame: -1, L: [0, 0, 0] },
  _err: false,

  init() {
    const gl = VC.gfx.gl;
    SH.clampExt = gl.getExtension('EXT_polygon_offset_clamp');
  },
  reset() {
    slot.near.half = slot.far.half = 0;
    grid.S = null;
    SH.cache.valid = false;
  },
  /** Tallest receiver world Y on the map (terrain + buildings + trees). */
  maxHeight() {
    return grid.S ? grid.maxY : VC.C.MAXH * VC.C.STEP + 8;
  },

  render(ctx) {
    const G = VC.gfx, gl = ctx.gl, S = ctx.S, env = ctx.env, cam = ctx.cam;
    SH.cascades = 0;
    SH.stats.cascades = 0;
    const wasValid = SH.cache.valid;
    SH.cache.valid = false; // set again below when a map is rendered or reused
    if (!S) return;
    // Skip when the key light cannot contribute (sun/moon crossover, very dim moon under clouds).
    const keyLum = (env.sunColor[0] * 0.2126 + env.sunColor[1] * 0.7152 + env.sunColor[2] * 0.0722) * env.keyVis;
    if (env.keyVis < 0.01 || keyLum < 0.004) return;
    const q = G.quality();
    const want = Math.min(q.shadow | 0, 3072, (G.caps.maxTex || 4096) >> 1);
    if (want < 256) return;
    const allowTwo = want >= 2048;
    if (!ensureTarget(gl, want, allowTwo)) return;

    const t0 = performance.now();
    updateGrid(S, ctx.time);
    const L = env.sunDir;
    lightBasis(L);

    // --- fit cascades ---
    const farDist = Math.min(cam.far * 0.95, cam.dist * 2.4 + 30);
    if (!fit(cam, S, farDist, slot.far)) return; // no receivers on the map in view
    let two = false;
    if (allowTwo) {
      const nearDist = cam.dist * 1.1 + 8;
      if (nearDist < farDist * 0.85 && fit(cam, S, nearDist, slot.near)) {
        const ratio = slot.far.need / Math.max(1e-3, slot.near.need);
        two = ratio > (SH.cascades2 ? 1.35 : 1.6);
      }
    }
    SH.cascades2 = two;
    const list = two ? CASC2 : CASC1;
    const n = list.length;

    // --- temporal reuse: the atlas and its matrices stay self-consistent, so between updates the previous
    // map is reused as long as it still covers the view (moving casters lag one frame at most).
    const C = SH.cache;
    const moon = env.sunUp < -0.02;
    const interval = (VC.settings && VC.settings.quality) === 'ultra' ? 1 : SH.interval;
    const due = !wasValid || SH._realloc || C.n !== n || C.moon !== moon || C.size !== SH.size || G.frameCount - C.frame >= interval ||
      L[0] * C.L[0] + L[1] * C.L[1] + L[2] * C.L[2] < 0.99996 || !covers(list, SH.size);
    if (!due) {
      C.valid = true;
      G.setShadow(SH.tex, SH.mat);
      G.shadowFar = C.n === 2 ? SH.far : null;
      SH.cascades = n;
      SH.stats.cascades = n;
      SH.stats.reused++;
      return;
    }

    // shared depth range: receivers' farthest point .. every map caster toward the light
    let zMin = Infinity;
    for (let c = 0; c < n; c++) zMin = Math.min(zMin, list[c].zlo);
    const zMax = mapMaxAlongLight(S) + 1;
    zMin -= 1;
    const dz = Math.max(1, zMax - zMin);

    for (let c = 0; c < n; c++) {
      const sl = list[c];
      stabilize(sl, SH.size);
      buildVP(SH.viewProj[c], sl, zMax, dz);
      G.frustumPlanes(SH.viewProj[c], SH.frustum[c]);
    }
    // world -> atlas texture space (near cascade)
    const cw = SH.atlasW > SH.atlasH ? 0.5 : 1;
    const vp = SH.viewProj[0], m = SH.mat;
    for (let col = 0; col < 4; col++) {
      m[col * 4] = vp[col * 4] * 0.5 * cw + (col === 3 ? 0.5 * cw : 0);
      m[col * 4 + 1] = vp[col * 4 + 1] * 0.5 + (col === 3 ? 0.5 : 0);
      m[col * 4 + 2] = vp[col * 4 + 2] * 0.5 + (col === 3 ? 0.5 : 0);
      m[col * 4 + 3] = col === 3 ? 1 : 0;
    }
    if (two) {
      const a = list[0], b = list[1], k = a.half / b.half;
      SH.far.k = k;
      SH.far.ox = 0.5 - 0.5 * k + (a.cx - b.cx) / (2 * b.half);
      SH.far.oy = 0.5 - 0.5 * k + (a.cy - b.cy) / (2 * b.half);
    }

    // --- render ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, SH.fbo);
    gl.viewport(0, 0, SH.atlasW, SH.atlasH);
    gl.colorMask(false, false, false, false);
    gl.depthMask(true);
    gl.clearDepth(1);
    // clear only the atlas part in use
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, n * SH.size, SH.size);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
    // slope-scaled bias; clamp (when supported) keeps steep walls from detaching their contact shadows
    G.shadowBias = [1.6, 2.5];
    for (let c = 0; c < n; c++) {
      gl.viewport(c * SH.size, 0, SH.size, SH.size);
      G.writeFrame(SH.viewProj[c]);
      ctx.viewProj = SH.viewProj[c];
      ctx.frustum = SH.frustum[c];
      ctx.cascade = two ? c : 0;
      G.drawLayers('shadow', ctx);
    }
    G.shadowBias = null;
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    G.setShadow(SH.tex, SH.mat);
    G.shadowFar = two ? SH.far : null;
    SH.cascades = n;
    C.valid = true;
    SH._realloc = false;
    C.n = n;
    C.moon = moon;
    C.size = SH.size;
    C.frame = G.frameCount;
    C.L[0] = L[0]; C.L[1] = L[1]; C.L[2] = L[2];
    const st = SH.stats;
    st.cascades = n;
    st.size = SH.size;
    st.half[0] = +list[0].half.toFixed(2);
    st.half[1] = two ? +list[1].half.toFixed(2) : 0;
    st.ms = performance.now() - t0;
  },
});

/* ------------------------------------------------------------------ */
/* Render target                                                        */
/* ------------------------------------------------------------------ */
function ensureTarget(gl, size, two) {
  const w = two ? size * 2 : size;
  if (SH.tex && SH.size === size && SH.atlasW === w) return !!SH.fbo;
  if (SH._failedAt === w * 100000 + size) return false;
  if (SH.fbo) gl.deleteFramebuffer(SH.fbo);
  if (SH.tex) gl.deleteTexture(SH.tex);
  SH.tex = VC.gfx.texture({ w, h: size, internal: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT, filter: gl.LINEAR, compare: true });
  SH.fbo = VC.gfx.framebuffer(null, SH.tex);
  SH.size = size;
  SH.atlasW = w;
  SH.atlasH = size;
  slot.near.half = slot.far.half = 0;
  SH._realloc = true;
  if (!SH.fbo) {
    SH._failedAt = w * 100000 + size;
    if (!SH._err) console.warn('[shadows] shadow framebuffer unsupported at ' + w + 'x' + size + '; shadows disabled');
    SH._err = true;
    gl.deleteTexture(SH.tex);
    SH.tex = null;
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Coarse height grid (8x8-tile blocks): ground min / receiver max Y     */
/* ------------------------------------------------------------------ */
const grid = { S: null, bs: 8, gw: 0, gh: 0, lo: null, hi: null, verT: -1, verB: -1, verTr: -1, t: -1e9, minY: 0, maxY: 0 };
function updateGrid(S, time) {
  const v = S.ver || {};
  if (grid.S === S && v.terrain === grid.verT && v.trees === grid.verTr && (v.bld === grid.verB || time - grid.t < 0.5)) return;
  grid.S = S;
  grid.verT = v.terrain;
  grid.verB = v.bld;
  grid.verTr = v.trees;
  grid.t = time;
  const C = VC.C, bs = grid.bs;
  const gw = Math.ceil(S.W / bs), gh = Math.ceil(S.H / bs);
  if (!grid.lo || grid.gw !== gw || grid.gh !== gh) {
    grid.lo = new Float32Array(gw * gh);
    grid.hi = new Float32Array(gw * gh);
    grid.gw = gw;
    grid.gh = gh;
  }
  const lo = grid.lo.fill(1e9), hi = grid.hi.fill(-1e9);
  for (let z = 0; z < S.H; z++) {
    const row = ((z / bs) | 0) * gw;
    for (let x = 0; x < S.W; x++) {
      const i = z * S.W + x;
      const y = Math.max(S.height[i] * C.STEP, C.SEA_Y);
      const b = row + ((x / bs) | 0);
      if (y < lo[b]) lo[b] = y;
      const top = y + (S.trees[i] ? 1.7 : 0.3);
      if (top > hi[b]) hi[b] = top;
    }
  }
  for (const b of S.buildings.values()) {
    const y = Math.max(S.height[b.z * S.W + b.x] * C.STEP, C.SEA_Y) + Math.max(b.hgt || 0, 3) + 0.5;
    const bx0 = (b.x / bs) | 0, bx1 = ((b.x + (b.w || 1) - 1) / bs) | 0;
    const bz0 = (b.z / bs) | 0, bz1 = ((b.z + (b.d || 1) - 1) / bs) | 0;
    for (let bz = bz0; bz <= bz1 && bz < gh; bz++) for (let bx = bx0; bx <= bx1 && bx < gw; bx++) if (y > hi[bz * gw + bx]) hi[bz * gw + bx] = y;
  }
  let mn = 1e9, mx = -1e9;
  for (let i = 0; i < lo.length; i++) { if (lo[i] < mn) mn = lo[i]; if (hi[i] > mx) mx = hi[i]; }
  grid.minY = mn;
  grid.maxY = mx;
}
/** Min ground / max receiver Y over the tile rect [x0,x1]x[z0,z1] (world units). Writes into out[0..1]. */
function gridRange(x0, z0, x1, z1, out) {
  const bs = grid.bs;
  const bx0 = M.clamp(Math.floor(x0 / bs), 0, grid.gw - 1), bx1 = M.clamp(Math.floor(x1 / bs), 0, grid.gw - 1);
  const bz0 = M.clamp(Math.floor(z0 / bs), 0, grid.gh - 1), bz1 = M.clamp(Math.floor(z1 / bs), 0, grid.gh - 1);
  let mn = 1e9, mx = -1e9;
  for (let bz = bz0; bz <= bz1; bz++)
    for (let bx = bx0; bx <= bx1; bx++) {
      const i = bz * grid.gw + bx;
      if (grid.lo[i] < mn) mn = grid.lo[i];
      if (grid.hi[i] > mx) mx = grid.hi[i];
    }
  out[0] = mn;
  out[1] = mx;
  return out;
}

/* ------------------------------------------------------------------ */
/* Light basis (standard lookAt basis toward the light: right-handed)   */
/* ------------------------------------------------------------------ */
const LX = [1, 0, 0], LY = [0, 1, 0], LZ = [0, 0, 1];
function lightBasis(L) {
  // X' = normalize(cross(worldUp, L)), Y' = cross(L, X'), Z' = L   (L never vertical on our sun/moon paths)
  let x = L[2], z = -L[0];
  const l = Math.hypot(x, z) || 1;
  x /= l; z /= l;
  LX[0] = x; LX[1] = 0; LX[2] = z;
  LY[0] = L[1] * z; LY[1] = L[2] * x - L[0] * z; LY[2] = -L[1] * x;
  LZ[0] = L[0]; LZ[1] = L[1]; LZ[2] = L[2];
}
/** Max of L·p over the map box (all casters). */
function mapMaxAlongLight(S) {
  const y0 = 0, y1 = grid.maxY;
  let m = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? S.W : 0, y = i & 2 ? y1 : y0, z = i & 4 ? S.H : 0;
    const d = LZ[0] * x + LZ[1] * y + LZ[2] * z;
    if (d > m) m = d;
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* Cascade fitting                                                      */
/* ------------------------------------------------------------------ */
const mkSlot = () => ({ need: 0, half: 0, cx: 0, cy: 0, zlo: 0, rawX: 0, rawY: 0 });
const slot = { near: mkSlot(), far: mkSlot() };
const CASC1 = [slot.far], CASC2 = [slot.near, slot.far];
SH._slot = slot;

const CX = new Float64Array(8), CY = new Float64Array(8), CZ = new Float64Array(8);
const PX = new Float64Array(48), PZ = new Float64Array(48);
const HX = new Float64Array(64), HZ = new Float64Array(64);
const TX = new Float64Array(64), TZ = new Float64Array(64);
const EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
const _rng = [0, 0];
const _circ = [0, 0, 0];

/** Camera frustum corners at view-axis distances near .. tFar. */
function frustumCorners(cam, tFar) {
  const v = cam.view, p = cam.pos;
  const rx = v[0], ry = v[4], rz = v[8]; // right
  const ux = v[1], uy = v[5], uz = v[9]; // up
  const fx = -v[2], fy = -v[6], fz = -v[10]; // forward
  const tv = Math.tan(cam.fov / 2), th = tv * cam.aspect;
  for (let k = 0; k < 2; k++) {
    const t = k ? tFar : cam.near;
    for (let c = 0; c < 4; c++) {
      const sx = c === 0 || c === 3 ? -1 : 1, sy = c < 2 ? -1 : 1;
      const i = k * 4 + c;
      CX[i] = p[0] + (fx + rx * sx * th + ux * sy * tv) * t;
      CY[i] = p[1] + (fy + ry * sx * th + uy * sy * tv) * t;
      CZ[i] = p[2] + (fz + rz * sx * th + uz * sy * tv) * t;
    }
  }
}

/** XZ footprint of (frustum ∩ slab y0..y1) clipped to the map; returns hull point count (in HX/HZ). */
function footprint(y0, y1, W, H) {
  let n = 0;
  for (let i = 0; i < 8; i++) if (CY[i] >= y0 && CY[i] <= y1) { PX[n] = CX[i]; PZ[n] = CZ[i]; n++; }
  for (let e = 0; e < 24; e += 2) {
    const a = EDGES[e], b = EDGES[e + 1];
    const ya = CY[a], yb = CY[b];
    for (let s = 0; s < 2; s++) {
      const Y = s ? y1 : y0;
      if ((ya - Y) * (yb - Y) < 0) {
        const t = (Y - ya) / (yb - ya);
        PX[n] = CX[a] + (CX[b] - CX[a]) * t;
        PZ[n] = CZ[a] + (CZ[b] - CZ[a]) * t;
        n++;
      }
    }
  }
  if (n === 0) return 0;
  n = convexHull(n);
  return clipRect(n, -1, -1, W + 1, H + 1);
}

/** Andrew's monotone chain on PX/PZ[0..n) -> HX/HZ (CCW). Returns hull size. */
function convexHull(n) {
  // insertion sort by x then z (n is tiny)
  for (let i = 1; i < n; i++) {
    const x = PX[i], z = PZ[i];
    let j = i - 1;
    while (j >= 0 && (PX[j] > x || (PX[j] === x && PZ[j] > z))) { PX[j + 1] = PX[j]; PZ[j + 1] = PZ[j]; j--; }
    PX[j + 1] = x; PZ[j + 1] = z;
  }
  if (n < 3) { for (let i = 0; i < n; i++) { HX[i] = PX[i]; HZ[i] = PZ[i]; } return n; }
  const cross = (o, a, bx, bz) => (HX[a] - HX[o]) * (bz - HZ[o]) - (HZ[a] - HZ[o]) * (bx - HX[o]);
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k >= 2 && cross(k - 2, k - 1, PX[i], PZ[i]) <= 0) k--;
    HX[k] = PX[i]; HZ[k] = PZ[i]; k++;
  }
  for (let i = n - 2, t = k + 1; i >= 0; i--) {
    while (k >= t && cross(k - 2, k - 1, PX[i], PZ[i]) <= 0) k--;
    HX[k] = PX[i]; HZ[k] = PZ[i]; k++;
  }
  return k - 1;
}

/** Sutherland-Hodgman clip of the convex polygon HX/HZ[0..n) against a rectangle; result in HX/HZ. */
function clipRect(n, x0, z0, x1, z1) {
  for (let side = 0; side < 4 && n > 0; side++) {
    let m = 0;
    const inside = (x, z) => (side === 0 ? x >= x0 : side === 1 ? x <= x1 : side === 2 ? z >= z0 : z <= z1);
    for (let i = 0; i < n; i++) {
      const ax = HX[i], az = HZ[i];
      const j = (i + 1) % n, bx = HX[j], bz = HZ[j];
      const ain = inside(ax, az), bin = inside(bx, bz);
      if (ain) { TX[m] = ax; TZ[m] = az; m++; }
      if (ain !== bin) {
        let t;
        if (side < 2) { const X = side === 0 ? x0 : x1; t = (X - ax) / (bx - ax); }
        else { const Z = side === 2 ? z0 : z1; t = (Z - az) / (bz - az); }
        TX[m] = ax + (bx - ax) * t; TZ[m] = az + (bz - az) * t; m++;
      }
    }
    for (let i = 0; i < m; i++) { HX[i] = TX[i]; HZ[i] = TZ[i]; }
    n = m;
  }
  return n;
}

/** Minimal enclosing circle of HX/HZ[0..n) (incremental Welzl) -> _circ [cx, cz, r]. */
function enclosingCircle(n) {
  let cx = HX[0], cz = HZ[0], r = 0;
  const out = (i) => Math.hypot(HX[i] - cx, HZ[i] - cz) > r + 1e-7;
  for (let i = 1; i < n; i++) {
    if (!out(i)) continue;
    cx = HX[i]; cz = HZ[i]; r = 0;
    for (let j = 0; j < i; j++) {
      if (!out(j)) continue;
      cx = (HX[i] + HX[j]) / 2; cz = (HZ[i] + HZ[j]) / 2;
      r = Math.hypot(HX[i] - cx, HZ[i] - cz);
      for (let k = 0; k < j; k++) {
        if (!out(k)) continue;
        // circumcircle of i, j, k
        const ax = HX[i], az = HZ[i], bx = HX[j], bz = HZ[j], qx = HX[k], qz = HZ[k];
        const d = 2 * (ax * (bz - qz) + bx * (qz - az) + qx * (az - bz));
        if (Math.abs(d) < 1e-12) continue;
        const a2 = ax * ax + az * az, b2 = bx * bx + bz * bz, c2 = qx * qx + qz * qz;
        cx = (a2 * (bz - qz) + b2 * (qz - az) + c2 * (az - bz)) / d;
        cz = (a2 * (qx - bx) + b2 * (ax - qx) + c2 * (bx - ax)) / d;
        r = Math.hypot(ax - cx, az - cz);
      }
    }
  }
  _circ[0] = cx; _circ[1] = cz; _circ[2] = r;
  return _circ;
}

/**
 * Fits slot sl to the receivers visible up to view distance tFar. Computes the light-space center
 * (rawX, rawY), the required half-size `need` and the receivers' lowest depth along the light `zlo`.
 */
function fit(cam, S, tFar, sl) {
  frustumCorners(cam, tFar);
  let y0 = grid.minY - 0.05, y1 = grid.maxY;
  let n = footprint(y0, y1, S.W, S.H);
  if (n < 1) return false;
  // refine the slab with the local heights under the footprint's bounding box
  let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (HX[i] < bx0) bx0 = HX[i]; if (HX[i] > bx1) bx1 = HX[i];
    if (HZ[i] < bz0) bz0 = HZ[i]; if (HZ[i] > bz1) bz1 = HZ[i];
  }
  gridRange(bx0, bz0, bx1, bz1, _rng);
  if (_rng[0] > y0 + 0.2 || _rng[1] < y1 - 0.2) {
    y0 = _rng[0] - 0.05;
    y1 = Math.max(_rng[1], y0 + 0.5);
    const n2 = footprint(y0, y1, S.W, S.H);
    if (n2 >= 1) n = n2;
  }
  const c = enclosingCircle(n);
  const rc = Math.max(c[2], 1.5), hh = (y1 - y0) * 0.5, cy = (y0 + y1) * 0.5;
  sl.wx = c[0]; sl.wz = c[1]; sl.rc = rc; sl.y0 = y0; sl.y1 = y1; sl.n = n;
  // light-space center and half extents of the receiver cylinder (radius rc, half height hh)
  const px = c[0], pz = c[1];
  sl.rawX = LX[0] * px + LX[1] * cy + LX[2] * pz;
  sl.rawY = LY[0] * px + LY[1] * cy + LY[2] * pz;
  const ext = (u) => rc * Math.hypot(u[0], u[2]) + hh * Math.abs(u[1]);
  sl.need = Math.max(ext(LX), ext(LY));
  sl.zlo = LZ[0] * px + LZ[1] * cy + LZ[2] * pz - ext(LZ);
  return true;
}

/** True if the last rendered cascades (stabilized cx, cy, half) still contain every slot's required region. */
function covers(list, size) {
  for (let c = 0; c < list.length; c++) {
    const sl = list[c];
    if (!sl.half) return false;
    const need = Math.max(3, sl.need * (1 + 12 / size));
    if (Math.abs(sl.rawX - sl.cx) + need > sl.half || Math.abs(sl.rawY - sl.cy) + need > sl.half) return false;
  }
  return true;
}

/** Hysteresis on the half-size (log-quantized) + texel snapping of the center. */
function stabilize(sl, size) {
  // margin for PCF radius + normal offset (~6 texels)
  const need = Math.max(3, sl.need * (1 + 12 / size));
  if (!sl.half || need > sl.half || need < sl.half * 0.7) {
    sl.half = Math.pow(2, Math.ceil(Math.log2(need * 1.1) * 16) / 16);
  }
  const texel = (2 * sl.half) / size;
  sl.cx = Math.round(sl.rawX / texel) * texel;
  sl.cy = Math.round(sl.rawY / texel) * texel;
}

/** Light view-projection (column-major) for slot sl with the shared depth range. */
function buildVP(m, sl, zMax, dz) {
  const ir = 1 / sl.half;
  m[0] = LX[0] * ir; m[4] = LX[1] * ir; m[8] = LX[2] * ir; m[12] = -sl.cx * ir;
  m[1] = LY[0] * ir; m[5] = LY[1] * ir; m[9] = LY[2] * ir; m[13] = -sl.cy * ir;
  m[2] = (-2 * LZ[0]) / dz; m[6] = (-2 * LZ[1]) / dz; m[10] = (-2 * LZ[2]) / dz; m[14] = (2 * zMax) / dz - 1;
  m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
}
