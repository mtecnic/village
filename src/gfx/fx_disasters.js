/*
 * VOXELPOLIS — disaster visuals (VC.fxDis), driven every frame by VC.disasters.active and drawn by
 * the VC.fx layer. Entries are read-only (see sim/disasters.js for their fields).
 *
 *   tornado     translucent swirling double funnel (procedural cone mesh, noise-scrolled dust), orbiting
 *               debris cubes flung out at the top, dust skirt at the base, dark wall cloud above
 *   meteor      glowing tumbling 'meteor' model with fire + smoke trail and a streak of glows, ground
 *               glow growing before impact; impact flash, expanding shockwave ring, fireballs, sparks,
 *               crater glow and a smoke column during the aftermath
 *   earthquake  dust clouds along the fault line and from shaken buildings, hopping debris
 *   ufo         bobbing, spinning 'ufo' model with chasing rim lights, tractor beam (additive beam +
 *               ground ring + rising sparkles) and the abducted building drawn rising (b.disLift)
 *   monster     'monster' model with its 4 walk-cycle variants, glowing eyes, stomp dust rings,
 *               wading splashes and the blue atomic breath beam
 * Per-entry visual state lives in a Map keyed by entry id and is dropped when the entry ends.
 */
const M = VC.M, C = VC.C;
const TAU = Math.PI * 2;
const T12 = new Float32Array(12), P3 = [0, 0, 0], Q3 = [0, 0, 0];
const states = new Map();
let rnd = M.rng(11);
let t = 0; // visual clock (real seconds, frozen while paused)
const DEBRIS_COLS = [[0.55, 0.52, 0.48], [0.62, 0.32, 0.22], [0.45, 0.32, 0.2], [0.25, 0.42, 0.15], [0.7, 0.7, 0.68], [0.3, 0.3, 0.32]];

const D = (VC.fxDis = {
  init() {
    initGL();
  },
  reset() {
    states.clear();
  },
  update(dt, rdt, S, B, G) {
    const list = (VC.disasters && VC.disasters.active) || [];
    t += dt;
    const seen = D._seen || (D._seen = new Set());
    seen.clear();
    D.tornados = 0;
    for (let k = 0; k < list.length; k++) {
      const e = list[k];
      if (!e || e.x == null) continue;
      const key = e.id != null ? e.id : e;
      seen.add(key);
      let st = states.get(key);
      if (!st) states.set(key, (st = { born: t }));
      try {
        const fn = H[e.type];
        if (fn) fn(e, st, dt, S, B, G);
      } catch (err) {
        if (!st.err) console.error('[fxDis] ' + e.type, err);
        st.err = true;
      }
    }
    for (const k of states.keys()) if (!seen.has(k)) states.delete(k);
  },
  drawTransparent(ctx) {
    drawFunnels(ctx);
  },
});

function surf(x, z) {
  return VC.fxgl.surfaceY(x, z);
}
function P() {
  return VC.particles;
}

/* ------------------------------------------------------------------ */
const H = {};

/* ---------------- tornado ---------------- */
const funnels = []; // [x, y, z, height, r0, r1, intensity, seed] per active tornado (rebuilt each frame)
H.tornado = function (e, st, dt, S, B, G) {
  const I = M.clamp(e.intensity == null ? 1 : e.intensity, 0, 1);
  const gy = surf(e.x, e.z);
  const height = 18 + (e.radius || 2) * 2;
  const r0 = 0.55 + (e.radius || 2) * 0.3, r1 = 3.8 + (e.radius || 2) * 1.1;
  if (D.tornados < 4) {
    const o = D.tornados++ * 8;
    funnels[o] = e.x; funnels[o + 1] = gy - 0.2; funnels[o + 2] = e.z; funnels[o + 3] = height;
    funnels[o + 4] = r0; funnels[o + 5] = r1; funnels[o + 6] = I; funnels[o + 7] = st.seed || (st.seed = rnd() * 10);
  }
  // orbiting debris (tinted cubes)
  if (!st.deb) {
    const n = 70;
    st.deb = new Float32Array(n * 8); // angle, radius, height, vh, angVel, size, colIdx, spin
    for (let k = 0; k < n; k++) resetDebris(st.deb, k, true);
  }
  const deb = st.deb, cube = VC.models.get('fx_cube');
  for (let k = 0; k < deb.length / 8; k++) {
    const o = k * 8;
    deb[o + 2] += deb[o + 3] * dt;
    const hr = deb[o + 2] / 14;
    deb[o + 1] = M.lerp(0.6, 3.5, hr) * (e.radius || 2) * 0.5 + 0.4;
    deb[o] += deb[o + 4] * dt / Math.max(0.5, deb[o + 1] * 0.5);
    if (deb[o + 2] > 14 || deb[o + 2] < 0) resetDebris(deb, k, false);
    const sway = hr * hr * 2.2;
    const x = e.x + Math.cos(deb[o]) * deb[o + 1] + Math.sin(hr * 2.8 + t * 0.9 + st.seed) * sway * 0.3;
    const z = e.z + Math.sin(deb[o]) * deb[o + 1];
    const y = gy + deb[o + 2];
    if (!cube || I < 0.05) continue;
    const c = DEBRIS_COLS[deb[o + 6] | 0];
    VC.fxgl.pose(T12, cube, x, y, z, deb[o + 7] * t, t * 3 + k, t * 2.3 + k, deb[o + 5] * 8 * I);
    B.add(cube, true, T12, 0, 0, VC.fxgl.tint(c[0], c[1], c[2]), 0);
  }
  // dust skirt + flung debris + wall cloud
  const Pt = P();
  if (Pt && dt > 0) {
    const cam = VC.camera;
    const near = Math.hypot(e.x - cam.tx, e.z - cam.tz) < 120;
    if (near) {
      st.acc = (st.acc || 0) + dt * 45 * I;
      while (st.acc >= 1) {
        st.acc -= 1;
        const a = rnd() * TAU, r = r0 + 0.5 + rnd() * 1.5;
        const tx = -Math.sin(a), tz = Math.cos(a);
        Pt.emit('dust', e.x + Math.cos(a) * r, gy + 0.2, e.z + Math.sin(a) * r, { vx: tx * 3 + Math.cos(a) * 1.2, vy: 0.6 + rnd() * 1.4, vz: tz * 3 + Math.sin(a) * 1.2, size: 0.5 + rnd() * 0.5, color: [0.42, 0.37, 0.3], alpha: 0.55 });
      }
      if (rnd() < dt * 2 * I) Pt.emit('smoke', e.x + (rnd() - 0.5) * 8, gy + height * 0.92, e.z + (rnd() - 0.5) * 8, { vx: 0, vy: 0, vz: 0, size: 3 + rnd() * 2, life: 8, color: [0.16, 0.17, 0.19], alpha: 0.5 });
      if (rnd() < dt * 5 * I) Pt.burst('leaf', e.x, gy + 3 + rnd() * 5, e.z, 2, { spread: 6 });
    }
  }
};
function resetDebris(deb, k, initial) {
  const o = k * 8;
  deb[o] = rnd() * TAU;
  deb[o + 2] = initial ? rnd() * 14 : 0.1;
  deb[o + 3] = 1.5 + rnd() * 3.5;
  deb[o + 4] = (4 + rnd() * 4) * 0.8;
  deb[o + 5] = 0.05 + rnd() * rnd() * 0.3;
  deb[o + 6] = Math.floor(rnd() * DEBRIS_COLS.length);
  deb[o + 7] = rnd() * 6;
}

/* ---------------- meteor ---------------- */
H.meteor = function (e, st, dt, S, B, G) {
  const Pt = P();
  const incoming = e.phase === 'incoming' || e.impactAt == null;
  const mx = e.mx != null ? e.mx : e.x, my = e.my != null ? e.my : e.y + 40, mz = e.mz != null ? e.mz : e.z;
  const ix = e.ix != null ? e.ix : e.x, iz = e.iz != null ? e.iz : e.z;
  const iy = e.iy != null ? e.iy : surf(ix, iz);
  if (incoming) {
    const m = VC.models.get('meteor');
    const sx = e.sx != null ? e.sx : mx, sy = e.sy != null ? e.sy : my + 50, sz = e.sz != null ? e.sz : mz;
    const dx = ix - sx, dy = iy - sy, dz = iz - sz;
    const hd = Math.atan2(dz, dx), pt = Math.atan2(dy, Math.hypot(dx, dz));
    if (m) {
      VC.fxgl.pose(T12, m, mx, my - m.sy * m.vox * 0.8, mz, hd + t * 2.1, t * 3.3, t * 2.7, 1.7);
      B.add(m, false, T12, VC.fxgl.F.HOT | VC.fxgl.F.UNLIT, 2.2, VC.fxgl.WHITE, 0.3);
    }
    // head glow + streak of fading glows along the recent path
    G.add(mx, my, mz, 3.2, 1, 0.55, 0.2, 5, 0, 0, 1, 0.6);
    G.add(mx, my, mz, 9, 1, 0.35, 0.08, 1.2, 0, 0, 1, 0);
    const len = Math.hypot(dx, dy, dz) || 1;
    for (let k = 1; k <= 14; k++) {
      const b = k * 1.6;
      const f = 1 - k / 15;
      G.add(mx - (dx / len) * b, my - (dy / len) * b, mz - (dz / len) * b, 1.6 * f + 0.4, 1, 0.3 + 0.3 * f, 0.08, 2.4 * f, 0, 0, 1, 0.3);
    }
    // ground glow brightening as it approaches
    const pr = e.progress == null ? 0.5 : e.progress;
    G.add(ix, iy + 0.05, iz, 2 + pr * 7, 1, 0.45, 0.15, pr * pr * 2.2, 1, 0, 1, 0);
    // fire + smoke trail between the previous and the current position
    if (Pt && dt > 0) {
      const px = st.px != null ? st.px : mx, py = st.py != null ? st.py : my, pz = st.pz != null ? st.pz : mz;
      const segLen = Math.hypot(mx - px, my - py, mz - pz);
      const n = Math.min(12, Math.ceil(segLen / 0.9));
      for (let k = 0; k < n; k++) {
        const f = (k + rnd()) / n;
        const x = M.lerp(px, mx, f), y = M.lerp(py, my, f), z = M.lerp(pz, mz, f);
        Pt.emit('fire', x, y, z, { vx: (rnd() - 0.5), vy: rnd(), vz: (rnd() - 0.5), size: 0.8 + rnd() * 0.6, life: 0.5 + rnd() * 0.3 });
        if (rnd() < 0.6) Pt.emit('smoke', x, y, z, { vx: 0, vy: 0.3, vz: 0, size: 0.9, life: 5 + rnd() * 3, color: [0.18, 0.16, 0.15], alpha: 0.6, emissive: 0.8 });
      }
    }
    st.px = mx; st.py = my; st.pz = mz;
  } else {
    // impact + aftermath
    const since = e.rt != null && e.impactAt != null ? e.rt - e.impactAt : t - (st.impT || (st.impT = t));
    if (!st.impacted) {
      st.impacted = true;
      if (Pt) {
        Pt.burst('flash', ix, iy + 1, iz, 2, { size: 4, color: [8, 5, 2.5] });
        for (let k = 0; k < 40; k++) {
          const a = rnd() * TAU, s = 3 + rnd() * 5;
          Pt.emit('fire', ix, iy + 0.5, iz, { vx: Math.cos(a) * s, vy: 2 + rnd() * 5, vz: Math.sin(a) * s, size: 0.7 + rnd() * 0.8, life: 0.6 + rnd() * 0.6 });
        }
        for (let k = 0; k < 50; k++) {
          const a = rnd() * TAU, s = 4 + rnd() * 4;
          Pt.emit('dust', ix + Math.cos(a), iy + 0.3, iz + Math.sin(a), { vx: Math.cos(a) * s, vy: 0.5 + rnd(), vz: Math.sin(a) * s, size: 0.7 + rnd() * 0.6, life: 2.5 + rnd() * 2, color: [0.45, 0.4, 0.34] });
        }
        Pt.burst('spark', ix, iy + 0.5, iz, 60, { spread: 9 });
        Pt.burst('debris', ix, iy + 0.5, iz, 50, { colors: [[0.35, 0.3, 0.26], [0.5, 0.45, 0.4], [0.25, 0.2, 0.18]], spread: 6 });
      }
      if (VC.camera && VC.camera.shake) VC.camera.shake(0.6);
    }
    const f = M.clamp(1 - since / 6, 0, 1);
    // flash, shockwave, crater glow
    if (since < 0.6) G.add(ix, iy + 2, iz, 14 + since * 20, 1, 0.75, 0.45, (1 - since / 0.6) * 6, 0, 0, 1, 0.2);
    if (since < 1.6) {
      const k = since / 1.6;
      G.add(ix, iy + 0.08, iz, 1 + k * 26, 1, 0.7, 0.45, (1 - k) * 3, 4, 0, 1, 0.12);
      G.add(ix, iy + 0.12, iz, 1 + k * 18, 1, 0.9, 0.7, (1 - k) * 1.5, 4, 0, 1, 0.06);
    }
    G.add(ix, iy + 0.05, iz, 2 + (e.radius || 3) * 1.2, 1, 0.4, 0.1, f * 2.5 * (0.85 + 0.15 * Math.sin(t * 9)), 1, 0, 1, 0);
    if (Pt && dt > 0 && f > 0) {
      if (rnd() < dt * 14 * f) Pt.emit('smoke', ix + (rnd() - 0.5) * 2, iy + 0.5, iz + (rnd() - 0.5) * 2, { vx: 0, vy: 1.6, vz: 0, size: 1 + rnd(), life: 7, color: [0.12, 0.11, 0.1], alpha: 0.7, emissive: 0.7 * f });
      if (rnd() < dt * 10 * f) Pt.emit('ember', ix + (rnd() - 0.5) * 3, iy + 0.4, iz + (rnd() - 0.5) * 3, null);
      if (rnd() < dt * 6 * f) Pt.emit('fire', ix + (rnd() - 0.5) * 2, iy + 0.3, iz + (rnd() - 0.5) * 2, { vx: 0, vy: 1, vz: 0, size: 0.6 });
    }
  }
};

/* ---------------- earthquake ---------------- */
H.earthquake = function (e, st, dt, S, B, G) {
  const Pt = P();
  const s = M.clamp(e.shake == null ? 0.6 : e.shake, 0, 1.5);
  if (!Pt || dt <= 0 || s <= 0.01) return;
  const f = e.fault || { x0: e.x - 8, z0: e.z, x1: e.x + 8, z1: e.z };
  st.acc = (st.acc || 0) + dt * 40 * s;
  while (st.acc >= 1) {
    st.acc -= 1;
    const k = rnd();
    const x = M.lerp(f.x0, f.x1, k) + (rnd() - 0.5) * 1.5, z = M.lerp(f.z0, f.z1, k) + (rnd() - 0.5) * 1.5;
    if (x < 0 || z < 0 || x >= S.W || z >= S.H) continue;
    const y = surf(x, z);
    Pt.emit('dust', x, y + 0.2, z, { vx: (rnd() - 0.5) * 1.5, vy: 0.4 + rnd(), vz: (rnd() - 0.5) * 1.5, size: 0.5 + rnd() * 0.5, color: [0.52, 0.45, 0.36], alpha: 0.55 });
    if (rnd() < 0.25) Pt.emit('debris', x, y + 0.1, z, { vx: (rnd() - 0.5), vy: 1.5 + rnd() * 2, vz: (rnd() - 0.5), colors: [[0.4, 0.3, 0.2], [0.5, 0.45, 0.4]] });
  }
  // dust shaken off buildings around the epicentre
  const R = e.radius || 12;
  st.bacc = (st.bacc || 0) + dt * 25 * s;
  while (st.bacc >= 1) {
    st.bacc -= 1;
    const x = Math.floor(e.x + (rnd() * 2 - 1) * R), z = Math.floor(e.z + (rnd() * 2 - 1) * R);
    if (x < 0 || z < 0 || x >= S.W || z >= S.H) continue;
    const b = VC.world.buildingAt(x, z);
    if (!b) continue;
    const y = VC.world.topY(b.x, b.z) + (b.hgt || 1) * rnd();
    Pt.emit('dust', x + rnd(), y, z + rnd(), { vx: 0, vy: -0.3, vz: 0, size: 0.35, color: [0.62, 0.58, 0.52], alpha: 0.45 });
  }
};

/* ---------------- UFO ---------------- */
H.ufo = function (e, st, dt, S, B, G) {
  const m = VC.models.get('ufo');
  const I = M.clamp(e.intensity == null ? 1 : e.intensity, 0, 1);
  const bob = Math.sin(t * 1.7) * 0.25;
  const y = (e.y || surf(e.x, e.z) + 10) + bob;
  // tilt toward the direction of motion
  const vx = st.lx != null && dt > 0 ? (e.x - st.lx) / dt : 0, vz = st.lz != null && dt > 0 ? (e.z - st.lz) / dt : 0;
  st.lx = e.x; st.lz = e.z;
  const sp = Math.min(1, Math.hypot(vx, vz) / 4);
  st.tilt = M.damp(st.tilt || 0, sp * 0.25, 3, dt || 0.016);
  const mh = Math.atan2(vz, vx) || e.dir || 0;
  st.spin = (st.spin || 0) + dt * 2.2;
  const scale = 1.25 * (0.3 + 0.7 * I);
  if (m) {
    // spin the saucer around its own axis; lean toward the travel direction (tilt decomposed into the
    // spinning frame's pitch/roll, fine for small angles)
    VC.fxgl.pose(T12, m, e.x, y, e.z, st.spin, -st.tilt * Math.cos(st.spin - mh), st.tilt * Math.sin(st.spin - mh), scale);
    B.add(m, false, T12, VC.fxgl.F.BEACON, 0.15, VC.fxgl.WHITE, 0.5);
    // chasing rim lights (model lights, or a default ring)
    const L = m.lights && m.lights.length ? m.lights : null;
    const n = L ? L.length : 12;
    for (let k = 0; k < n; k++) {
      let r = 1, g = 0.4, b = 0.9;
      if (L) { VC.fxgl.xfPoint(T12, L[k].x, L[k].y, L[k].z, P3); r = L[k].color[0]; g = L[k].color[1]; b = L[k].color[2]; }
      else {
        const a = st.spin + (k / n) * TAU, R = m.sx * m.vox * scale * 0.45;
        P3[0] = e.x + Math.cos(a) * R; P3[1] = y + 0.3 * scale; P3[2] = e.z + Math.sin(a) * R;
      }
      const chase = 0.5 + 0.5 * Math.sin(t * 7 - k * 1.1);
      G.add(P3[0], P3[1], P3[2], 0.35 * scale, r, g, b, (0.8 + chase * 3) * I, 0, 0, 1, 0.5);
    }
    G.add(e.x, y - 0.2, e.z, 1.2 * scale, 0.3, 1, 0.7, 1.4 * I, 0, 0, 1, 0.4);
  }
  // tractor beam
  const beam = M.clamp(e.beam || 0, 0, 1);
  const gy = surf(e.x, e.z);
  if (beam > 0.02) {
    const len = y - gy - 0.2;
    const pulse = 0.85 + 0.15 * Math.sin(t * 10);
    G.add(e.x, y - 0.2, e.z, 0.55, 0.35, 1, 0.75, 1.6 * beam * pulse, 5, 0, len, 3.2);
    G.add(e.x, y - 0.2, e.z, 0.3, 0.7, 1, 0.9, 1.4 * beam, 5, 0, len, 2.5);
    G.add(e.x, gy + 0.06, e.z, 2.0, 0.35, 1, 0.75, 1.5 * beam * pulse, 4, 0, 1, 0.18);
    G.add(e.x, gy + 0.05, e.z, 1.8, 0.35, 1, 0.75, 1.0 * beam, 1, 0, 1, 0);
    const Pt = P();
    if (Pt && dt > 0 && rnd() < dt * 30 * beam) {
      const a = rnd() * TAU, r = rnd() * 1.2;
      Pt.emit('sparkle', e.x + Math.cos(a) * r, gy + rnd() * len * 0.5, e.z + Math.sin(a) * r, { vx: 0, vy: 1.5 + rnd() * 2, vz: 0, color: [0.8, 3, 1.8], life: 1.2 });
    }
  }
  // the abducted building rising into the saucer
  const L = e.lifting;
  if (L && L.b && !(VC.bldgfx && VC.bldgfx.handlesLift)) {
    const b = L.b;
    const bm = VC.models.forBuilding(b);
    const lift = b.disLift != null ? b.disLift : L.lift || 0;
    if (bm && lift > 0.001) {
      VC.fxgl.poseBuilding(T12, b, bm, lift, lift * 0.35 + Math.sin(t * 2) * 0.05 * Math.min(1, lift));
      B.add(bm, false, T12, 0, 0.35 * Math.min(1, lift), VC.fxgl.tint(0.85, 1, 0.9), (b.variant % 997) / 997);
      const Pt = P();
      if (Pt && dt > 0 && rnd() < dt * 8) Pt.emit('debris', b.x + rnd() * b.w, VC.world.topY(b.x, b.z) + lift, b.z + rnd() * b.d, { vx: 0, vy: -0.5, vz: 0, colors: [[0.4, 0.35, 0.3], [0.3, 0.25, 0.2]] });
    }
  }
};

/* ---------------- monster ---------------- */
H.monster = function (e, st, dt, S, B, G) {
  const def = VC.models.defs.monster;
  const nv = (def && def.variants) || 1;
  const frame = Math.floor((e.step || 0) * 4) & 3;
  const m = VC.models.get('monster', frame % nv);
  if (!m) return;
  const I = M.clamp(e.intensity == null ? 1 : e.intensity, 0, 1);
  const tx = Math.floor(e.x), tz = Math.floor(e.z);
  const inWater = tx < 0 || tz < 0 || tx >= S.W || tz >= S.H || S.height[tz * S.W + tx] < C.SEA;
  const ground = surf(e.x, e.z);
  const wantY = inWater ? C.SEA_Y - 1.4 : ground;
  st.y = st.y == null ? wantY : M.damp(st.y, wantY, 3, dt || 0.016);
  st.h = st.h == null ? e.dir || 0 : M.dampAngle(st.h, e.dir || 0, 6, dt || 0.016);
  const bob = Math.abs(Math.sin((e.step || 0) * Math.PI * 2)) * 0.12;
  const scale = 0.25 + 0.75 * I;
  VC.fxgl.pose(T12, m, e.x, st.y + bob, e.z, st.h, 0, Math.sin((e.step || 0) * Math.PI * 2) * 0.04, scale);
  B.add(m, false, T12, 0, 0.1 * (e.roar || 0), VC.fxgl.WHITE, 0.7);
  // glowing eyes (model meta.eyes, else an estimate near the front top)
  const eyes = (m.meta && m.meta.eyes) || [[m.sx * 0.4, m.sy * 0.85, m.sz * 0.9], [m.sx * 0.6, m.sy * 0.85, m.sz * 0.9]];
  const glow = 1.5 + (e.roar || 0) * 4;
  for (const ey of eyes) {
    VC.fxgl.xfPoint(T12, ey[0], ey[1], ey[2], P3);
    G.add(P3[0], P3[1], P3[2], 0.35 + (e.roar || 0) * 0.3, 1, 0.85, 0.2, glow, 0, 0, 1, 0.6);
  }
  // atomic dorsal glow when roaring
  if (e.roar > 0.05) {
    VC.fxgl.xfPoint(T12, m.sx * 0.5, m.sy * 0.7, m.sz * 0.4, P3);
    G.add(P3[0], P3[1], P3[2], 4, 0.2, 0.9, 1, e.roar * 1.2, 0, 0, 1, 0.1);
  }
  const Pt = P();
  // stomp: dust ring at the planted foot
  const stomp = e.stomp || 0;
  if (Pt && dt > 0 && stomp > 0.95 && (st.prevStomp || 0) < 0.95) {
    const side = (Math.floor((e.step || 0) * 2) & 1) ? 1 : -1;
    const fx = Math.cos(st.h), fz = Math.sin(st.h);
    const px = e.x - fz * side * 0.6 * scale, pz = e.z + fx * side * 0.6 * scale;
    if (inWater) {
      Pt.burst('splash', px, C.SEA_Y + 0.1, pz, 40, { spread: 3.5 });
      Pt.burst('wake', px, C.SEA_Y + 0.02, pz, 8, { jitter: 1 });
    } else {
      for (let k = 0; k < 18; k++) {
        const a = (k / 18) * TAU;
        Pt.emit('dust', px + Math.cos(a) * 0.5, ground + 0.15, pz + Math.sin(a) * 0.5, { vx: Math.cos(a) * 2.8, vy: 0.3 + rnd() * 0.4, vz: Math.sin(a) * 2.8, size: 0.5, color: [0.5, 0.45, 0.38] });
      }
      Pt.burst('debris', px, ground + 0.2, pz, 6, { spread: 2.5, colors: [[0.35, 0.3, 0.25], [0.45, 0.42, 0.38]] });
    }
    st.ring = 0;
    st.rx = px; st.rz = pz; st.ry = inWater ? C.SEA_Y : ground;
  }
  st.prevStomp = stomp;
  if (st.ring != null && st.ring < 0.7) {
    st.ring += dt;
    const k = st.ring / 0.7;
    G.add(st.rx, st.ry + 0.06, st.rz, 0.5 + k * 4, 0.9, 0.85, 0.7, (1 - k) * 0.8, 4, 0, 1, 0.15);
  }
  // wading wake
  if (Pt && inWater && dt > 0 && rnd() < dt * 12) Pt.emit('wake', e.x + (rnd() - 0.5) * 2, C.SEA_Y + 0.02, e.z + (rnd() - 0.5) * 2, { vx: 0, vy: 0, vz: 0, size: 0.4 });
  // atomic breath
  const br = e.breath;
  if (br && br.x != null) {
    VC.fxgl.xfPoint(T12, m.sx * 0.5, m.sy * 0.74, m.sz * 0.98, P3);
    const tyy = surf(br.x, br.z) + 1;
    const dx = br.x - P3[0], dy = tyy - P3[1], dz = br.z - P3[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const bt = br.t || 0;
    const env = bt < 1.2 ? M.smoothstep(0, 0.15, bt) : 1 - M.smoothstep(1.2, 1.5, bt);
    const n = Math.ceil(len / 0.45);
    for (let k = 0; k <= n; k++) {
      const f = k / n;
      const w = 0.35 + f * 0.5 + 0.15 * Math.sin(t * 40 + k);
      G.add(P3[0] + dx * f, P3[1] + dy * f, P3[2] + dz * f, w, 0.3, 0.75, 1, 2.8 * env, 0, 0, 1, 0.5);
    }
    G.add(br.x, tyy, br.z, 3, 0.4, 0.8, 1, 3 * env, 0, 0, 1, 0.3);
    if (Pt && dt > 0) {
      for (let k = 0; k < 3; k++) {
        const f = rnd();
        Pt.emit('fire', P3[0] + dx * f, P3[1] + dy * f, P3[2] + dz * f, { vx: dx / len * 3 + (rnd() - 0.5), vy: dy / len * 3 + rnd(), vz: dz / len * 3 + (rnd() - 0.5), size: 0.4 + rnd() * 0.4, color: [0.25, 0.6, 1.4], life: 0.4 });
      }
    }
  }
};

/* ------------------------------------------------------------------ */
/* Tornado funnel mesh + shader                                          */
/* ------------------------------------------------------------------ */
const NR = 28, NS = 24;
const TVS = `
layout(location=0) in vec2 aAH; // angle 0..1, height 0..1
uniform vec4 uPos;   // x, groundY, z, height
uniform vec4 uR;     // r bottom, r top, time, intensity
uniform vec4 uP2;    // swirl speed, outer layer (0/1), seed, -
out vec3 vWp; out vec2 vAH; out vec3 vN;
void main(){
  float h = aAH.y, a = aAH.x * 6.2831853;
  float outer = uP2.y;
  float r = mix(uR.x, uR.y, pow(h, 1.5)) * (1.0 + 0.14 * sin(h * 17.0 - uR.z * 6.0 + a * 2.0)) * (1.0 + outer * 0.4);
  r *= 0.35 + 0.65 * uR.w;
  vec2 sway = vec2(sin(h * 2.8 + uR.z * 0.9 + uP2.z), cos(h * 2.3 + uR.z * 0.7 + uP2.z * 1.3)) * (h * h * 2.6 + sin(h * 9.0 + uR.z * 2.0) * 0.25 * h);
  vec3 wp = vec3(uPos.x + cos(a) * r + sway.x, uPos.y + h * uPos.w, uPos.z + sin(a) * r + sway.y);
  vN = normalize(vec3(cos(a), 0.25, sin(a)));
  vWp = wp; vAH = aAH;
  gl_Position = uViewProj * vec4(wp, 1.0);
}`;
const TFS = `
in vec3 vWp; in vec2 vAH; in vec3 vN;
uniform vec4 uR; uniform vec4 uP2;
out vec4 fragColor;
void main(){
  float h = vAH.y;
  float sw = vAH.x * 3.0 - uR.z * uP2.x + h * 2.5;
  float n = tnoise(vec2(sw, h * 1.4 - uR.z * 0.55)).r * 0.6 + tnoise(vec2(sw * 2.1 + 0.3, h * 3.2 - uR.z * 1.1)).g * 0.4;
  vec3 V = normalize(uCamPos.xyz - vWp);
  float edge = 1.0 - abs(dot(normalize(vec3(vN.x, 0.0, vN.z)), V));
  float a = (0.5 + 0.5 * smoothstep(0.25, 0.7, n)) * (0.55 + 0.45 * edge);
  a *= smoothstep(0.0, 0.04, h) * (1.0 - 0.6 * smoothstep(0.8, 1.0, h));
  a *= (uP2.y > 0.5 ? 0.42 : 1.0) * uR.w;
  vec3 base = mix(vec3(0.2, 0.18, 0.16), vec3(0.3, 0.3, 0.32), h);
  vec3 light = uSkyAmb.rgb * 1.1 + uGroundAmb.rgb * 0.3 + uSunColor.rgb * uSunDir.w * 0.35 * (0.5 + 0.5 * dot(vN, uSunDir.xyz)) + vec3(0.8, 0.85, 1.0) * uMisc.z * 2.0;
  vec3 col = applyFog(base * light * (0.65 + 0.55 * n), vWp);
  fragColor = vec4(col, clamp(a, 0.0, 0.85));
}`;
const GLR = {};
function initGL() {
  const G = VC.gfx, gl = G.gl;
  GLR.prog = G.program('fx_tornado', TVS, TFS);
  const v = new Float32Array((NS + 1) * (NR + 1) * 2);
  let o = 0;
  for (let r = 0; r <= NR; r++) for (let s = 0; s <= NS; s++) { v[o++] = s / NS; v[o++] = r / NR; }
  const idx = new Uint16Array(NR * NS * 6);
  o = 0;
  for (let r = 0; r < NR; r++)
    for (let s = 0; s < NS; s++) {
      const a = r * (NS + 1) + s, b = a + 1, c = a + NS + 1, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
  GLR.vao = gl.createVertexArray();
  gl.bindVertexArray(GLR.vao);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  GLR.count = idx.length;
}
function drawFunnels(ctx) {
  const n = D.tornados || 0;
  if (!n) return;
  const gl = ctx.gl, P = GLR.prog;
  P.use();
  gl.bindVertexArray(GLR.vao);
  gl.disable(gl.CULL_FACE);
  for (let k = 0; k < n; k++) {
    const o = k * 8;
    gl.uniform4f(P.u.uPos, funnels[o], funnels[o + 1], funnels[o + 2], funnels[o + 3]);
    gl.uniform4f(P.u.uR, funnels[o + 4], funnels[o + 5], t, funnels[o + 6]);
    for (let outer = 1; outer >= 0; outer--) {
      gl.uniform4f(P.u.uP2, outer ? 1.6 : 2.6, outer, funnels[o + 7], 0);
      gl.drawElements(gl.TRIANGLES, GLR.count, gl.UNSIGNED_SHORT, 0);
    }
  }
  gl.bindVertexArray(null);
}
