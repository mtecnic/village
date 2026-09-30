/*
 * VOXELPOLIS — air, sea and wildlife agents (VC.fxAir), updated and drawn by VC.agents.
 *
 *   PLANES      with an airport: take-offs (roll, rotate, climb out) and landings (glide slope, flare,
 *               roll-out) along the airport's long axis, alternating every ~half minute; otherwise an
 *               occasional airliner crossing the map at altitude with contrails. Nav lights + strobes.
 *   HELICOPTERS one per hospital / police HQ / fire HQ near the camera: rooftop pad -> climb -> orbit the
 *               district -> land again. Rotor = model part (VC.models parts), banking in turns.
 *   BOATS       sailboats / motorboats wandering on water (steering with look-ahead probes), a ferry
 *               shuttling across the widest nearby strait, cargo ships sailing to a seaport (BFS distance
 *               field over water from the port) or passing offshore along an ocean edge. Wakes + lights.
 *   BIRDS       flocks circling over forests and parks by day, seagulls over the coast (3 flap frames of
 *               the 'bird' model, tinted per species).
 *   BALLOONS    rare hot-air balloons drifting with the wind on clear days, burner flickering.
 * Movement uses game-scaled time (frozen while paused). Everything spawns around the camera target.
 */
const M = VC.M, C = VC.C;
const TAU = Math.PI * 2;
const FLAP = [0, 1, 2, 1];
const DX4 = [1, -1, 0, 0], DZ4 = [0, 0, 1, -1];
const DX8 = [1, -1, 0, 0, 1, 1, -1, -1], DZ8 = [0, 0, 1, -1, 1, -1, 1, -1];

let S = null, W = 0, H = 0;
let rnd = M.rng(3);
let clock = 0;
const T12 = new Float32Array(12);
const P3 = [0, 0, 0];

const planes = [], helis = [], boats = [], flocks = [], balloons = [];
let scanT = 0, waterTiles = 0, oceanEdge = -1, ferryRoute = null, ferryT = 0;
let airport = null, seaport = null, portField = null, portFieldFor = null;
let crossT = 20, airportT = 8, balloonT = 30, offshoreT = 25;

const A = (VC.fxAir = {
  init() {},
  reset(st) {
    S = st;
    W = st.W; H = st.H;
    rnd = M.rng((st.seed ^ 0x51a7) >>> 0);
    planes.length = helis.length = boats.length = flocks.length = balloons.length = 0;
    scanT = 0;
    ferryRoute = null;
    ferryT = 0;
    portField = null;
    portFieldFor = null;
    airport = seaport = null;
    crossT = 15 + rnd() * 20;
    airportT = 6;
    balloonT = 20 + rnd() * 30;
    offshoreT = 15 + rnd() * 20;
    countWater();
  },
  count() {
    let n = planes.length + helis.length + boats.length + balloons.length;
    for (const f of flocks) n += f.n;
    return n;
  },
  stats() {
    return { planes: planes.length, helis: helis.length, boats: boats.length, flocks: flocks.length, balloons: balloons.length, water: waterTiles, ferry: !!ferryRoute, airport: !!airport, seaport: !!seaport };
  },
  /** Debug / showcase spawners. */
  spawn: {
    takeoff() { if (!airport) scan(); if (airport) startAirportMove(airport, true); return !!airport; },
    landing() { if (!airport) scan(); if (airport) startAirportMove(airport, false); return !!airport; },
    crossing() { startCrossing(); return true; },
    balloon() { balloonT = 0; return true; },
    flock(gull) { return !!newFlock(!!gull, VC.camera); },
  },
  planes() {
    return planes.map((p) => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), phase: p.phase || 'cruise', speed: +p.speed.toFixed(2) }));
  },

  update(dt, rdt, st) {
    if (st !== S) A.reset(st);
    clock += dt;
    scanT -= rdt;
    if (scanT <= 0) {
      scanT = 3;
      scan();
    }
    if (dt <= 0) return;
    updatePlanes(dt);
    updateHelis(dt);
    updateBoats(dt);
    updateBirds(dt);
    updateBalloons(dt);
  },

  render(B, G, cam, night) {
    const FXg = VC.fxgl, F = FXg.frustum;
    const lod = (x, y, z) => Math.hypot(x - cam.pos[0], y - cam.pos[1], z - cam.pos[2]) > 60; // (one closure per frame)
    const t = VC.agents ? VC.agents.clock : clock;
    for (const p of planes) {
      if (!F.sphere(p.x, p.y, p.z, 4)) continue;
      FXg.pose(T12, p.m, p.x, p.y, p.z, p.h, p.pitch, p.roll, p.scale);
      B.add(p.m, lod(p.x, p.y, p.z), T12, FXg.F.BEACON | (p.onGround ? 0 : FXg.F.LIGHTS), 0, FXg.WHITE, p.seed);
      planeLights(G, p, night, t);
    }
    for (const h of helis) {
      if (!F.sphere(h.x, h.y, h.z, 2)) continue;
      FXg.pose(T12, h.m, h.x, h.y, h.z, h.h, h.pitch, h.roll, 1);
      B.addWithParts(h.m, lod(h.x, h.y, h.z), T12, FXg.F.BEACON | (h.police ? FXg.F.SIREN : 0), 0, FXg.WHITE, h.seed, t, h.rotor);
      if (night > 0.2 && h.state !== 0) {
        // searchlight
        const gy = VC.fxgl.surfaceY(h.x, h.z);
        const len = h.y - gy;
        G.add(h.x, h.y - 0.1, h.z, 0.12, 1, 0.95, 0.8, 0.8 * night, 5, 0, len, 5);
        G.add(h.x + Math.cos(h.h) * 0.4, gy + 0.05, h.z + Math.sin(h.h) * 0.4, 1.3, 1, 0.95, 0.85, 0.9 * night, 1, 0, 1, 0);
      }
    }
    for (const b of boats) {
      if (!F.sphere(b.x, b.y, b.z, b.r)) continue;
      FXg.pose(T12, b.m, b.x, b.y, b.z, b.h, b.pitch, b.roll, 1);
      B.add(b.m, lod(b.x, b.y, b.z), T12, FXg.F.BEACON, 0, FXg.WHITE, b.seed);
      if (night > 0.2) {
        const top = b.y + b.m.sy * b.m.vox * 0.85;
        G.add(b.x, top, b.z, 0.12, 1, 0.95, 0.85, 1.6 * night, 0, 0, 1, 0.6);
        const fx = Math.cos(b.h), fz = Math.sin(b.h), rx = -fz, rz = fx, w = b.m.sx * b.m.vox * 0.45;
        G.add(b.x - rx * w, b.y + 0.15, b.z - rz * w, 0.08, 0.1, 1, 0.2, 1.2 * night, 0, 0, 1, 0.6);
        G.add(b.x + rx * w, b.y + 0.15, b.z + rz * w, 0.08, 1, 0.1, 0.05, 1.2 * night, 0, 0, 1, 0.6);
        if (b.kind >= 2) G.add(b.x + fx * 0.2, C.SEA_Y + 0.02, b.z + fz * 0.2, b.r * 0.7, 1, 0.85, 0.6, 0.35 * night, 1, b.h, 1.8, 0);
      }
    }
    for (const f of flocks) {
      if (!F.sphere(f.x, f.y, f.z, f.rad + 1)) continue;
      const m0 = f.models;
      for (let k = 0; k < f.n; k++) {
        const o = k * 8, d = f.b;
        const fr = FLAP[Math.floor(t * f.flap + d[o + 6] * 4) & 3];
        const m = d[o + 7] > 0.5 ? m0[1] : m0[fr];
        FXg.pose(T12, m, d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5], f.scale * M.clamp(f.fade + 1, 0, 1));
        B.add(m, true, T12, 0, 0, f.tint, 0);
      }
    }
    for (const b of balloons) {
      if (!F.sphere(b.x, b.y + 1.5, b.z, 3)) continue;
      FXg.pose(T12, b.m, b.x, b.y, b.z, b.h, 0, Math.sin(t * 0.7 + b.seed * 9) * 0.03, Math.max(0.01, b.fade));
      B.add(b.m, lod(b.x, b.y, b.z), T12, 0, 0, FXg.WHITE, b.seed);
      const burn = b.burn > 0 ? 1 : 0;
      FXg.xfPoint(T12, b.m.sx * 0.5, 5, b.m.sz * 0.5, P3);
      G.add(P3[0], P3[1], P3[2], 0.25 + burn * 0.5, 1, 0.55, 0.15, (0.4 + burn * 3) * (0.3 + night), 0, 0, 1, 0.4);
      if (burn) G.add(P3[0], P3[1] + 1.5, P3[2], 1.6, 1, 0.5, 0.15, 0.5 * (0.2 + night), 0, 0, 1, 0);
    }
  },
});

/* ------------------------------------------------------------------ */
/* World scanning                                                        */
/* ------------------------------------------------------------------ */
function countWater() {
  let n = 0;
  for (let i = 0; i < S.N; i++) if (S.height[i] < C.SEA) n++;
  waterTiles = n;
  // ocean edge: a map side that is mostly water (for offshore traffic)
  oceanEdge = -1;
  let best = 0.6;
  for (let side = 0; side < 4; side++) {
    let w = 0;
    const L = side < 2 ? W : H;
    for (let k = 0; k < L; k++) {
      const x = side === 0 ? k : side === 1 ? k : side === 2 ? 0 : W - 1;
      const z = side === 0 ? 0 : side === 1 ? H - 1 : k;
      if (S.height[z * W + x] < C.SEA) w++;
    }
    if (w / L > best) { best = w / L; oceanEdge = side; }
  }
}
/** Water at world (x, z)? Outside the map continues the edge tile (ocean beyond a watery edge). */
function isWater(x, z) {
  const tx = M.clamp(Math.floor(x), 0, W - 1), tz = M.clamp(Math.floor(z), 0, H - 1);
  const i = tz * W + tx;
  if (S.height[i] >= C.SEA) return false;
  if (x >= 0 && z >= 0 && x < W && z < H && S.road[i]) return false; // bridges block boats
  return true;
}
function waterLine(x0, z0, x1, z1) {
  const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) * 2);
  for (let k = 0; k <= n; k++) if (!isWater(x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n)) return false;
  return true;
}

function scan() {
  airport = seaport = null;
  const heliBase = [];
  const cam = VC.camera;
  for (const b of S.buildings.values()) {
    if (b.built < 1) continue;
    if (b.key === 'airport' && !airport) airport = b;
    else if (b.key === 'seaport' && !seaport) seaport = b;
    else if (b.key === 'hospital' || b.key === 'police_hq' || b.key === 'fire_hq') {
      const d = Math.hypot(b.x - cam.tx, b.z - cam.tz);
      if (d < 90) heliBase.push({ b, d });
    }
  }
  // helicopters: keep one per nearby base (max 4)
  heliBase.sort((a, b) => a.d - b.d);
  const want = heliBase.slice(0, 4).map((e) => e.b);
  for (let k = helis.length - 1; k >= 0; k--) {
    const h = helis[k];
    if (want.indexOf(h.base) < 0 || !S.buildings.has(h.base.id)) helis.splice(k, 1);
  }
  for (const b of want) if (!helis.some((h) => h.base === b)) spawnHeli(b);
  // seaport distance field
  if (seaport && portFieldFor !== seaport) buildPortField(seaport);
  if (!seaport) { portField = null; portFieldFor = null; }
  if (waterTiles > 30) {
    if (!ferryRoute && (ferryT -= 3) <= 0) { ferryT = 30; findFerryRoute(); }
    manageBoats();
  } else boats.length = 0;
}

/* ------------------------------------------------------------------ */
/* Planes                                                                */
/* ------------------------------------------------------------------ */
function planeModel() {
  const def = VC.models.defs.plane;
  return VC.models.get('plane', Math.floor(rnd() * ((def && def.variants) || 1)));
}
function updatePlanes(dt) {
  // airport movements
  if (airport) {
    airportT -= dt;
    if (airportT <= 0 && !planes.some((p) => p.ap)) {
      airportT = 22 + rnd() * 25;
      startAirportMove(airport, rnd() < 0.5);
    }
  }
  // high-altitude crossings
  crossT -= dt;
  if (crossT <= 0) {
    crossT = 45 + rnd() * 60;
    const wx = S.weather || {};
    if (wx.type !== 'storm' && planes.filter((p) => !p.ap).length < 2) startCrossing();
  }
  for (let k = planes.length - 1; k >= 0; k--) {
    const p = planes[k];
    p.t += dt;
    if (p.ap) stepAirportPlane(p, dt);
    else {
      p.x += Math.cos(p.h) * p.speed * dt;
      p.z += Math.sin(p.h) * p.speed * dt;
      p.contrail -= dt;
      if (p.contrail <= 0 && VC.particles) {
        p.contrail = 0.07;
        const fx = Math.cos(p.h), fz = Math.sin(p.h), rx = -fz, rz = fx;
        const back = p.m.sz * p.m.vox * p.scale * 0.35, side = p.m.sx * p.m.vox * p.scale * 0.2;
        for (const s of [-1, 1]) VC.particles.emit('contrail', p.x - fx * back + rx * side * s, p.y - 0.1, p.z - fz * back + rz * side * s, { vx: 0, vy: 0, vz: 0 });
      }
    }
    if (p.done || p.t > 200 || Math.abs(p.x - W / 2) > W + 120 || Math.abs(p.z - H / 2) > H + 120) planes.splice(k, 1);
  }
}
function startCrossing() {
  const a = rnd() * TAU;
  const R = Math.max(W, H) * 0.5 + 60;
  const cx = W / 2 + (rnd() - 0.5) * W * 0.5, cz = H / 2 + (rnd() - 0.5) * H * 0.5;
  const m = planeModel();
  if (!m) return;
  planes.push({ ap: false, m, x: cx - Math.cos(a) * R, z: cz - Math.sin(a) * R, y: 28 + rnd() * 10, h: a, pitch: 0, roll: 0, speed: 9, t: 0, contrail: 0, scale: 1, seed: rnd(), onGround: false });
}
function runway(b) {
  const alongX = b.w >= b.d;
  const cx = b.x + b.w / 2, cz = b.z + b.d / 2;
  const L = (alongX ? b.w : b.d) / 2 - 0.4;
  return { cx, cz, ux: alongX ? 1 : 0, uz: alongX ? 0 : 1, L, y: VC.world.topY(b.x, b.z) + 0.12 };
}
function startAirportMove(b, takeoff) {
  const m = planeModel();
  if (!m) return;
  const r = runway(b);
  const s = rnd() < 0.5 ? 1 : -1; // runway direction
  const ux = r.ux * s, uz = r.uz * s;
  const h = Math.atan2(uz, ux);
  const p = { ap: true, m, rw: r, ux, uz, h, pitch: 0, roll: 0, t: 0, scale: 0.8, seed: rnd(), takeoff };
  if (takeoff) {
    Object.assign(p, { phase: 'roll', x: r.cx - ux * r.L, z: r.cz - uz * r.L, y: r.y, speed: 0, onGround: true });
  } else {
    const D = 110;
    Object.assign(p, { phase: 'approach', x: r.cx - ux * (r.L + D), z: r.cz - uz * (r.L + D), y: r.y + D * 0.075, speed: 6.5, onGround: false });
  }
  planes.push(p);
  VC.fxgl.sfx('plane', r.cx, r.cz, 0.7, 120);
}
function stepAirportPlane(p, dt) {
  const r = p.rw;
  const along = (p.x - r.cx) * p.ux + (p.z - r.cz) * p.uz; // position along the runway (negative = before)
  if (p.phase === 'roll') {
    p.speed = Math.min(7, p.speed + 1.4 * dt);
    if (p.speed > 5) p.phase = 'climb';
  } else if (p.phase === 'climb') {
    p.pitch = M.damp(p.pitch, 0.2, 2, dt);
    p.onGround = false;
    p.speed = Math.min(9, p.speed + 1 * dt);
    p.y += Math.sin(p.pitch) * p.speed * dt;
    if (p.y > r.y + 45) { p.pitch = M.damp(p.pitch, 0, 1, dt); }
    if (Math.abs(along) > Math.max(W, H) + 40) p.done = true;
  } else if (p.phase === 'approach') {
    // glide slope toward the threshold at -L
    const toTh = -r.L - along; // distance remaining to the threshold
    const gs = r.y + Math.max(0, toTh) * 0.075;
    p.y = M.damp(p.y, gs, 3, dt);
    p.pitch = toTh < 6 ? M.damp(p.pitch, 0.08, 3, dt) : -0.03;
    if (toTh <= 0) { p.phase = 'rollout'; p.y = r.y; p.onGround = true; if (VC.particles) VC.particles.burst('dust', p.x, r.y + 0.05, p.z, 6, { jitter: 0.3, color: [0.4, 0.4, 0.42] }); }
  } else if (p.phase === 'rollout') {
    p.pitch = M.damp(p.pitch, 0, 4, dt);
    p.speed = Math.max(0.6, p.speed - 2.2 * dt);
    if (along > r.L * 0.4) { p.phase = 'taxi'; p.t = 0; }
  } else if (p.phase === 'taxi') {
    p.speed = M.damp(p.speed, 0, 1, dt);
    p.scale = Math.max(0, 0.8 - Math.max(0, p.t - 3) * 0.4);
    if (p.scale <= 0.01) p.done = true;
  }
  p.x += p.ux * p.speed * dt;
  p.z += p.uz * p.speed * dt;
  if (p.onGround) p.y = r.y;
}
function planeLights(G, p, night, t) {
  const fx = Math.cos(p.h), fz = Math.sin(p.h), rx = -fz, rz = fx;
  const span = p.m.sx * p.m.vox * p.scale * 0.48;
  const k = 0.5 + night * 2.5;
  const y = p.y + 0.45 * p.scale;
  G.add(p.x + rx * span, y, p.z + rz * span, 0.12, 0.1, 1, 0.25, k, 0, 0, 1, 0.6); // right: green
  G.add(p.x - rx * span, y, p.z - rz * span, 0.12, 1, 0.08, 0.05, k, 0, 0, 1, 0.6); // left: red
  if ((t * 1.1 + p.seed) % 1 < 0.08) {
    G.add(p.x + rx * span, y, p.z + rz * span, 0.35, 1, 1, 1, 4, 3, 0, 1, 0.5);
    G.add(p.x - rx * span, y, p.z - rz * span, 0.35, 1, 1, 1, 4, 3, 0, 1, 0.5);
  }
  if (p.ap && night > 0.1 && !(p.phase === 'taxi')) {
    const nose = p.m.sz * p.m.vox * p.scale * 0.5;
    G.add(p.x + fx * nose, p.y + 0.3, p.z + fz * nose, 0.25, 1, 0.95, 0.85, 3 * night, 0, 0, 1, 0.5);
  }
}

/* ------------------------------------------------------------------ */
/* Helicopters                                                           */
/* ------------------------------------------------------------------ */
function spawnHeli(b) {
  const def = VC.models.defs.helicopter;
  const police = b.key === 'police_hq';
  const v = police ? 0 : b.key === 'hospital' ? 1 : 3;
  const m = VC.models.get('helicopter', v % ((def && def.variants) || 1));
  if (!m) return;
  const bm = VC.models.forBuilding(b);
  const roof = VC.world.topY(b.x, b.z) + ((bm && bm.height) || b.hgt || 1) + 0.05;
  const cx = b.x + b.w / 2, cz = b.z + b.d / 2;
  helis.push({ base: b, m, police, x: cx, z: cz, y: roof, roof, cx, cz, h: rnd() * TAU, pitch: 0, roll: 0, state: 0, timer: 4 + rnd() * 12, ang: rnd() * TAU, rad: 5 + rnd() * 4, alt: 5 + rnd() * 3, rotor: 0, seed: rnd() });
}
function updateHelis(dt) {
  for (const h of helis) {
    h.timer -= dt;
    if (h.state === 0) {
      // on the pad: rotor spools down / up
      h.rotor = M.damp(h.rotor, h.timer < 2 ? 1 : 0, 1.5, dt);
      if (h.timer <= 0) { h.state = 1; h.timer = 3; }
    } else if (h.state === 1) {
      h.rotor = 1;
      h.y = M.damp(h.y, h.roof + h.alt, 1.2, dt);
      if (h.timer <= 0) { h.state = 2; h.timer = 20 + rnd() * 25; }
    } else if (h.state === 2) {
      // orbit a point that wanders around the base
      const w = 0.28;
      h.ang += w * dt;
      const tx = h.cx + Math.cos(h.ang) * h.rad, tz = h.cz + Math.sin(h.ang) * h.rad;
      const dx = tx - h.x, dz = tz - h.z;
      const want = Math.atan2(dz, dx);
      let da = ((want - h.h + Math.PI) % TAU + TAU) % TAU - Math.PI;
      h.h += M.clamp(da, -1.2 * dt, 1.2 * dt);
      const sp = Math.min(2.4, Math.hypot(dx, dz) * 1.5);
      h.x += Math.cos(h.h) * sp * dt;
      h.z += Math.sin(h.h) * sp * dt;
      const gy = VC.fxgl.surfaceY(h.x, h.z);
      h.y = M.damp(h.y, Math.max(h.roof, gy + 3) + h.alt, 1, dt);
      h.roll = M.damp(h.roll, M.clamp(da * 0.8, -0.35, 0.35), 3, dt);
      h.pitch = M.damp(h.pitch, -0.12 * (sp / 2.4), 3, dt);
      if (h.timer <= 0) { h.state = 3; }
    } else if (h.state === 3) {
      // return to the pad and land
      const dx = h.cx - h.x, dz = h.cz - h.z, d = Math.hypot(dx, dz);
      if (d > 0.2) {
        const want = Math.atan2(dz, dx);
        let da = ((want - h.h + Math.PI) % TAU + TAU) % TAU - Math.PI;
        h.h += M.clamp(da, -1.5 * dt, 1.5 * dt);
        const sp = Math.min(2, d * 1.2);
        h.x += Math.cos(h.h) * sp * dt;
        h.z += Math.sin(h.h) * sp * dt;
        h.pitch = M.damp(h.pitch, -0.1 * (sp / 2), 3, dt);
        h.roll = M.damp(h.roll, M.clamp(da * 0.6, -0.3, 0.3), 3, dt);
      } else {
        h.pitch = M.damp(h.pitch, 0, 3, dt);
        h.roll = M.damp(h.roll, 0, 3, dt);
        h.y = M.damp(h.y, h.roof, 1.4, dt);
        if (h.y - h.roof < 0.03) { h.state = 0; h.timer = 15 + rnd() * 25; h.y = h.roof; }
      }
    }
    if (h.state && VC.particles && h.y - VC.fxgl.surfaceY(h.x, h.z) < 2.5 && rnd() < dt * 8) VC.particles.emit('dust', h.x + (rnd() - 0.5), VC.fxgl.surfaceY(h.x, h.z) + 0.1, h.z + (rnd() - 0.5), { vx: (rnd() - 0.5) * 2, vy: 0.2, vz: (rnd() - 0.5) * 2, alpha: 0.3 });
  }
}

/* ------------------------------------------------------------------ */
/* Boats                                                                 */
/* ------------------------------------------------------------------ */
const BOAT_KIND = { SAIL: 0, MOTOR: 1, FERRY: 2, CARGO: 3 };
function boatModel(kind) {
  if (kind === BOAT_KIND.FERRY) return VC.models.get(VC.models.has('ferry') ? 'ferry' : 'boat', 0);
  if (kind === BOAT_KIND.CARGO) return VC.models.get(VC.models.has('cargo_ship') ? 'cargo_ship' : 'boat', 0);
  const def = VC.models.defs.boat;
  const nv = (def && def.variants) || 1;
  if (kind === BOAT_KIND.MOTOR) return VC.models.get('boat', nv >= 3 ? 2 : 0);
  return VC.models.get('boat', Math.floor(rnd() * Math.min(nv, nv >= 3 ? 2 : nv)));
}
function newBoat(kind, x, z, h) {
  const m = boatModel(kind);
  if (!m) return null;
  const draft = ((m.meta && m.meta.draft) || 1) * m.vox;
  const b = { kind, m, x, z, y: C.SEA_Y - draft, draft, h, pitch: 0, roll: 0, speed: 0, vmax: [0.55, 1.2, 0.8, 0.9][kind], tx: x, tz: z, wait: 0, seed: rnd(), r: Math.max(m.sx, m.sz) * m.vox * 0.6 + 0.3, wake: 0 };
  boats.push(b);
  return b;
}
function randomWaterNear(cx, cz, R) {
  for (let k = 0; k < 40; k++) {
    const x = cx + (rnd() * 2 - 1) * R, z = cz + (rnd() * 2 - 1) * R;
    if (x < 1 || z < 1 || x > W - 1 || z > H - 1) continue;
    if (isWater(x, z) && isWater(x + 0.8, z) && isWater(x - 0.8, z) && isWater(x, z + 0.8) && isWater(x, z - 0.8)) return [x, z];
  }
  return null;
}
function manageBoats() {
  const cam = VC.camera;
  // despawn far small boats
  for (let k = boats.length - 1; k >= 0; k--) {
    const b = boats[k];
    if (b.kind <= 1 && Math.hypot(b.x - cam.tx, b.z - cam.tz) > 110) boats.splice(k, 1);
  }
  const small = boats.filter((b) => b.kind <= 1).length;
  const want = Math.min(7, Math.round(waterTiles / 350) + 1);
  for (let n = small; n < want; n++) {
    const p = randomWaterNear(cam.tx, cam.tz, 55);
    if (!p) break;
    newBoat(rnd() < 0.3 ? BOAT_KIND.MOTOR : BOAT_KIND.SAIL, p[0], p[1], rnd() * TAU);
  }
  if (ferryRoute && !boats.some((b) => b.kind === BOAT_KIND.FERRY)) {
    const f = newBoat(BOAT_KIND.FERRY, ferryRoute.ax, ferryRoute.az, Math.atan2(ferryRoute.bz - ferryRoute.az, ferryRoute.bx - ferryRoute.ax));
    if (f) { f.leg = 1; f.tx = ferryRoute.bx; f.tz = ferryRoute.bz; }
  }
  const cargo = boats.filter((b) => b.kind === BOAT_KIND.CARGO).length;
  if (seaport && portField && cargo < 1 && rnd() < 0.5) spawnCargoToPort();
}
function findFerryRoute() {
  // sample shore water tiles, cast across the water, keep the longest good crossing near the camera
  const cam = VC.camera;
  let best = null, bs = 0;
  for (let k = 0; k < 160; k++) {
    const x = Math.floor(cam.tx + (rnd() * 2 - 1) * 60), z = Math.floor(cam.tz + (rnd() * 2 - 1) * 60);
    if (x < 1 || z < 1 || x >= W - 1 || z >= H - 1) continue;
    if (!isWater(x + 0.5, z + 0.5)) continue;
    let shoreDir = -1;
    for (let d = 0; d < 4; d++) if (!isWater(x + 0.5 + DX4[d], z + 0.5 + DZ4[d])) shoreDir = d;
    if (shoreDir < 0) continue;
    const dx = -DX4[shoreDir], dz = -DZ4[shoreDir];
    let L = 1;
    while (L < 60 && isWater(x + 0.5 + dx * L, z + 0.5 + dz * L)) L++;
    const ex = x + 0.5 + dx * L, ez = z + 0.5 + dz * L;
    if (L < 9 || L >= 60 || ex < 0 || ez < 0 || ex >= W || ez >= H) continue;
    const ax = x + 0.5 + dx * 0.9, az = z + 0.5 + dz * 0.9, bx = x + 0.5 + dx * (L - 1.9), bz = z + 0.5 + dz * (L - 1.9);
    if (!waterLine(ax - dz * 0.6, az - dx * 0.6, bx - dz * 0.6, bz - dx * 0.6) || !waterLine(ax + dz * 0.6, az + dx * 0.6, bx + dz * 0.6, bz + dx * 0.6)) continue;
    const score = L - Math.hypot(ax - cam.tx, az - cam.tz) * 0.1;
    if (score > bs) { bs = score; best = { ax, az, bx, bz }; }
  }
  ferryRoute = best;
}
function buildPortField(port) {
  portFieldFor = port;
  const N = S.N;
  const f = new Int32Array(N).fill(-1);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let z = port.z - 1; z <= port.z + port.d; z++)
    for (let x = port.x - 1; x <= port.x + port.w; x++) {
      if (x < 0 || z < 0 || x >= W || z >= H) continue;
      const i = z * W + x;
      if (S.height[i] < C.SEA && !S.road[i] && f[i] < 0) { f[i] = 0; q[qt++] = i; }
    }
  while (qh < qt) {
    const i = q[qh++];
    const x = i % W, z = (i / W) | 0;
    for (let d = 0; d < 4; d++) {
      const xx = x + DX4[d], zz = z + DZ4[d];
      if (xx < 0 || zz < 0 || xx >= W || zz >= H) continue;
      const j = zz * W + xx;
      if (f[j] >= 0 || S.height[j] >= C.SEA || S.road[j]) continue;
      f[j] = f[i] + 1;
      q[qt++] = j;
    }
  }
  portField = qt > 1 ? f : null;
}
function spawnCargoToPort() {
  // farthest reachable edge water tile
  let best = -1, bd = 0;
  for (let k = 0; k < 400; k++) {
    const side = Math.floor(rnd() * 4), t = Math.floor(rnd() * (side < 2 ? W : H));
    const x = side === 0 || side === 1 ? t : side === 2 ? 0 : W - 1, z = side === 0 ? 0 : side === 1 ? H - 1 : t;
    const i = z * W + x;
    if (portField[i] > bd) { bd = portField[i]; best = i; }
  }
  if (best < 0 || bd < 12) return;
  const x = (best % W) + 0.5, z = ((best / W) | 0) + 0.5;
  const b = newBoat(BOAT_KIND.CARGO, x, z, 0);
  if (!b) return;
  b.toPort = true;
  b.trail = [best];
  // start facing downhill
  b.h = Math.atan2(H / 2 - z, W / 2 - x);
}
function portStep(b) {
  // steer toward the neighbouring tile two steps down the distance field
  const x = M.clamp(Math.floor(b.x), 0, W - 1), z = M.clamp(Math.floor(b.z), 0, H - 1);
  let i = z * W + x;
  if (portField[i] < 0) return false;
  for (let s = 0; s < 3; s++) {
    let bi = i, bv = portField[i];
    const xx = i % W, zz = (i / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = xx + DX8[d], nz = zz + DZ8[d];
      if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
      const j = nz * W + nx, v = portField[j];
      if (v >= 0 && v < bv) { bv = v; bi = j; }
    }
    if (bi === i) break;
    i = bi;
  }
  b.tx = (i % W) + 0.5;
  b.tz = ((i / W) | 0) + 0.5;
  return portField[z * W + x] <= 1;
}
function updateBoats(dt) {
  const cam = VC.camera;
  // offshore traffic along an ocean edge when there is no seaport
  if (!seaport && oceanEdge >= 0) {
    offshoreT -= dt;
    if (offshoreT <= 0 && !boats.some((b) => b.offshore)) {
      offshoreT = 60 + rnd() * 60;
      const off = 5 + rnd() * 3, dir = rnd() < 0.5 ? 1 : -1;
      let x, z, h;
      if (oceanEdge < 2) { z = oceanEdge === 0 ? -off : H + off; x = dir > 0 ? -30 : W + 30; h = dir > 0 ? 0 : Math.PI; }
      else { x = oceanEdge === 2 ? -off : W + off; z = dir > 0 ? -30 : H + 30; h = dir > 0 ? Math.PI / 2 : -Math.PI / 2; }
      const b = newBoat(BOAT_KIND.CARGO, x, z, h);
      if (b) { b.offshore = true; b.tx = x + Math.cos(h) * (Math.max(W, H) + 60); b.tz = z + Math.sin(h) * (Math.max(W, H) + 60); }
    }
  }
  for (let k = boats.length - 1; k >= 0; k--) {
    const b = boats[k];
    let wantSpeed = b.vmax;
    if (b.wait > 0) { b.wait -= dt; wantSpeed = 0; }
    if (b.kind === BOAT_KIND.FERRY && ferryRoute) {
      const d = Math.hypot(b.tx - b.x, b.tz - b.z);
      if (d < 0.6 && b.wait <= 0) {
        b.leg ^= 1;
        b.tx = b.leg ? ferryRoute.bx : ferryRoute.ax;
        b.tz = b.leg ? ferryRoute.bz : ferryRoute.az;
        b.wait = 5;
      }
      wantSpeed = Math.min(wantSpeed, d * 0.5 + 0.1);
    } else if (b.kind === BOAT_KIND.CARGO && !b.offshore) {
      if (b.toPort) {
        if (!portField || portFieldFor !== seaport) { b.toPort = false; }
        else if (portStep(b)) { b.toPort = false; b.docked = 14; wantSpeed = 0; }
        const x = M.clamp(Math.floor(b.x), 0, W - 1), z = M.clamp(Math.floor(b.z), 0, H - 1), i = z * W + x;
        if (b.trail[b.trail.length - 1] !== i) b.trail.push(i);
      } else if (b.docked > 0) {
        b.docked -= dt;
        wantSpeed = 0;
        if (b.docked <= 0) b.leaving = true;
      } else if (b.leaving) {
        // retrace the inbound trail
        while (b.trail.length && Math.hypot((b.trail[b.trail.length - 1] % W) + 0.5 - b.x, ((b.trail[b.trail.length - 1] / W) | 0) + 0.5 - b.z) < 1.5) b.trail.pop();
        if (!b.trail.length) { boats.splice(k, 1); continue; }
        const i = b.trail[Math.max(0, b.trail.length - 3)];
        b.tx = (i % W) + 0.5; b.tz = ((i / W) | 0) + 0.5;
      } else { boats.splice(k, 1); continue; }
    } else if (b.offshore) {
      if (Math.hypot(b.tx - b.x, b.tz - b.z) < 2) { boats.splice(k, 1); continue; }
    } else {
      // pleasure boats: new random target when reached / blocked
      if (Math.hypot(b.tx - b.x, b.tz - b.z) < 1 || b.stuck > 3) {
        const p = randomWaterNear(b.x, b.z, 25);
        if (p && waterLine(b.x, b.z, p[0], p[1])) { b.tx = p[0]; b.tz = p[1]; b.stuck = 0; }
        else b.stuck = (b.stuck || 0) + 1;
        if (rnd() < 0.2) b.wait = 2 + rnd() * 4;
      }
    }
    // steering with look-ahead probe
    const want = Math.atan2(b.tz - b.z, b.tx - b.x);
    let da = ((want - b.h + Math.PI) % TAU + TAU) % TAU - Math.PI;
    const turn = b.kind >= 2 ? 0.35 : 0.9;
    b.h += M.clamp(da, -turn * dt, turn * dt);
    if (Math.abs(da) > 1.2) wantSpeed *= 0.4;
    const la = b.r + 0.6 + b.speed;
    if (!b.offshore && !isWater(b.x + Math.cos(b.h) * la, b.z + Math.sin(b.h) * la)) {
      wantSpeed = 0;
      b.h += turn * dt; // swing away
      b.stuck = (b.stuck || 0) + dt;
      if (b.kind <= 1 && b.stuck > 6) { boats.splice(k, 1); continue; }
    }
    b.speed = M.damp(b.speed, wantSpeed, 0.8, dt);
    b.x += Math.cos(b.h) * b.speed * dt;
    b.z += Math.sin(b.h) * b.speed * dt;
    // bobbing on the swell
    const tw = clock * 1.3 + b.seed * 20;
    const wx = S.weather ? S.weather.wind || 0 : 0;
    b.y = C.SEA_Y - b.draft + Math.sin(tw) * 0.025 * (b.kind >= 2 ? 0.4 : 1);
    b.pitch = Math.sin(tw * 0.8 + 1) * 0.025 * (b.kind >= 2 ? 0.3 : 1);
    b.roll = Math.sin(tw * 0.6) * 0.04 * (b.kind >= 2 ? 0.3 : 1) + (b.kind === BOAT_KIND.SAIL ? 0.12 * wx : 0);
    // wake: flat foam patches spreading in a V from the stern
    if (VC.particles && b.speed > 0.15 && Math.hypot(b.x - cam.tx, b.z - cam.tz) < 70) {
      b.wake -= dt;
      if (b.wake <= 0) {
        b.wake = 0.1 / Math.max(0.3, b.speed);
        const fx = Math.cos(b.h), fz = Math.sin(b.h), rx = -fz, rz = fx;
        const back = b.m.sz * b.m.vox * 0.45, half = b.m.sx * b.m.vox * 0.35;
        b.wakeSide = -(b.wakeSide || 1);
        const s = b.wakeSide;
        VC.particles.emit('wake', b.x - fx * back + rx * half * s, C.SEA_Y + 0.03, b.z - fz * back + rz * half * s, { vx: rx * s * 0.25 * b.speed - fx * 0.1, vy: 0, vz: rz * s * 0.25 * b.speed - fz * 0.1, size: 0.06 + b.r * 0.05 });
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Birds                                                                 */
/* ------------------------------------------------------------------ */
function birdModels() {
  const def = VC.models.defs.bird;
  const nv = (def && def.variants) || 1;
  return [VC.models.get('bird', 0), VC.models.get('bird', Math.min(1, nv - 1)), VC.models.get('bird', Math.min(2, nv - 1))];
}
function flockTarget(f, cam) {
  for (let k = 0; k < 30; k++) {
    const x = Math.floor(cam.tx + (rnd() * 2 - 1) * 45), z = Math.floor(cam.tz + (rnd() * 2 - 1) * 45);
    if (x < 0 || z < 0 || x >= W || z >= H) continue;
    const i = z * W + x;
    if (f.gull) {
      if (S.height[i] >= C.SEA) continue;
      let shore = false;
      for (let d = 0; d < 4 && !shore; d++) {
        const xx = x + [3, -3, 0, 0][d], zz = z + [0, 0, 3, -3][d];
        if (xx >= 0 && zz >= 0 && xx < W && zz < H && S.height[zz * W + xx] >= C.SEA) shore = true;
      }
      if (!shore) continue;
    } else {
      const b = S.bld[i] ? S.buildings.get(S.bld[i]) : null;
      if (S.trees[i] < 2 && !(b && VC.BLD[b.key] && VC.BLD[b.key].group === 'parks')) continue;
    }
    return [x + 0.5, z + 0.5];
  }
  return null;
}
function newFlock(gull, cam) {
  const f = { gull, n: gull ? 5 + Math.floor(rnd() * 4) : 7 + Math.floor(rnd() * 7), models: birdModels(), x: 0, y: 0, z: 0, vx: 0, vz: 0, tx: 0, tz: 0, circle: 0, rad: 2, scale: gull ? 1.25 : 0.9, flap: gull ? 5 : 9, tint: gull ? VC.fxgl.WHITE : VC.fxgl.tint(0.32, 0.3, 0.3), fade: 0, leave: false };
  const t = flockTarget(f, cam);
  if (!t) return null;
  const a = rnd() * TAU;
  f.x = t[0] + Math.cos(a) * 30;
  f.z = t[1] + Math.sin(a) * 30;
  f.tx = t[0]; f.tz = t[1];
  f.y = VC.fxgl.surfaceY(f.x, f.z) + 8;
  f.b = new Float32Array(f.n * 8);
  f.p = new Float32Array(f.n * 4); // per bird: orbit angle, radius, speed, bob phase
  for (let k = 0; k < f.n; k++) {
    f.p[k * 4] = rnd() * TAU;
    f.p[k * 4 + 1] = 0.6 + rnd() * 1.8;
    f.p[k * 4 + 2] = (0.6 + rnd() * 0.7) * (rnd() < 0.15 ? -1 : 1);
    f.p[k * 4 + 3] = rnd() * TAU;
    f.b[k * 8 + 6] = rnd();
  }
  flocks.push(f);
  return f;
}
function updateBirds(dt) {
  const cam = VC.camera, env = VC.gfx.env || {}, wx = S.weather || {};
  const ok = (env.night || 0) < 0.5 && wx.type !== 'rain' && wx.type !== 'storm' && wx.type !== 'snow';
  const land = flocks.filter((f) => !f.gull && !f.leave).length, gulls = flocks.filter((f) => f.gull && !f.leave).length;
  if (ok && cam.dist < 120) {
    if (land < 3 && rnd() < dt * 0.3) newFlock(false, cam);
    if (gulls < 1 && waterTiles > 60 && rnd() < dt * 0.2) newFlock(true, cam);
  }
  for (let k = flocks.length - 1; k >= 0; k--) {
    const f = flocks[k];
    if (!ok || Math.hypot(f.x - cam.tx, f.z - cam.tz) > 120) f.leave = true;
    // flock centre steering
    const dx = f.tx - f.x, dz = f.tz - f.z, d = Math.hypot(dx, dz);
    const sp = f.gull ? 2.2 : 3;
    if (f.leave) {
      f.vx = M.damp(f.vx, Math.cos(f.seedA || 0) * 4, 1, dt);
      f.vz = M.damp(f.vz, Math.sin(f.seedA || 0) * 4, 1, dt);
      f.y += dt * 1.5;
      f.fade -= dt * 0.3;
      if (f.fade < -1) { flocks.splice(k, 1); continue; }
    } else {
      f.fade = Math.min(1, f.fade + dt);
      if (d > 3) {
        f.vx = M.damp(f.vx, (dx / d) * sp, 1.2, dt);
        f.vz = M.damp(f.vz, (dz / d) * sp, 1.2, dt);
        f.circle = 0;
      } else {
        f.circle += dt;
        f.vx = M.damp(f.vx, 0, 1, dt);
        f.vz = M.damp(f.vz, 0, 1, dt);
        if (f.circle > 6 + rnd() * 6) {
          const t = flockTarget(f, cam);
          if (t) { f.tx = t[0]; f.tz = t[1]; }
          else f.leave = true;
          f.seedA = rnd() * TAU;
        }
      }
      const gy = f.gull ? C.SEA_Y + 3.5 : VC.fxgl.surfaceY(f.x, f.z) + 6.5;
      f.y = M.damp(f.y, gy + Math.sin(clock * 0.4 + k) * 1.2, 0.8, dt);
    }
    f.x += f.vx * dt;
    f.z += f.vz * dt;
    // birds orbit the centre
    const circling = f.circle > 0 ? 1 : 0.35;
    f.rad = 0;
    for (let b = 0; b < f.n; b++) {
      const p = f.p, o = b * 4, q = b * 8, B = f.b;
      p[o] += p[o + 2] * dt * (0.8 + circling);
      const r = p[o + 1] * (1 + circling * (f.gull ? 2 : 1.2));
      const ox = Math.cos(p[o]) * r, oz = Math.sin(p[o]) * r;
      const bob = Math.sin(clock * 1.7 + p[o + 3]) * 0.35;
      B[q] = f.x + ox;
      B[q + 1] = f.y + bob + Math.sin(p[o] * 2) * 0.2;
      B[q + 2] = f.z + oz;
      // heading = orbit tangent + flock velocity
      const tvx = -Math.sin(p[o]) * r * p[o + 2] * (0.8 + circling) + f.vx;
      const tvz = Math.cos(p[o]) * r * p[o + 2] * (0.8 + circling) + f.vz;
      B[q + 3] = Math.atan2(tvz, tvx);
      B[q + 4] = Math.cos(clock * 1.7 + p[o + 3]) * 0.2;
      B[q + 5] = -0.35 * Math.sign(p[o + 2]) * circling;
      B[q + 7] = f.gull && Math.sin(clock * 0.5 + p[o + 3]) > 0.2 ? 1 : 0; // gulls glide
      f.rad = Math.max(f.rad, r);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Balloons                                                              */
/* ------------------------------------------------------------------ */
function updateBalloons(dt) {
  const cam = VC.camera, wx = S.weather || {}, tod = S.time.tod;
  const nice = (wx.type === 'clear' || wx.type === 'cloudy' || !wx.type) && (wx.wind == null || wx.wind < 0.7) && tod > 0.27 && tod < 0.7;
  balloonT -= dt;
  if (balloonT <= 0) {
    balloonT = 40 + rnd() * 50;
    if (nice && balloons.length < 2 && rnd() < 0.5) {
      const a = wx.windDir || 0;
      const def = VC.models.defs.balloon;
      const m = VC.models.get('balloon', Math.floor(rnd() * ((def && def.variants) || 1)));
      if (m) {
        const x = cam.tx - Math.cos(a) * 55 + (rnd() - 0.5) * 30, z = cam.tz - Math.sin(a) * 55 + (rnd() - 0.5) * 30;
        balloons.push({ m, x, z, y: VC.fxgl.surfaceY(x, z) + 14 + rnd() * 10, h: rnd() * TAU, seed: rnd(), burn: 0, burnT: 2, fade: 0, alt: 14 + rnd() * 10 });
      }
    }
  }
  for (let k = balloons.length - 1; k >= 0; k--) {
    const b = balloons[k];
    const a = wx.windDir || 0, ws = 0.35 + (wx.wind || 0.3) * 0.6;
    b.x += Math.cos(a) * ws * dt;
    b.z += Math.sin(a) * ws * dt;
    b.h += dt * 0.05;
    const gy = VC.fxgl.surfaceY(b.x, b.z);
    b.y = M.damp(b.y, gy + b.alt + Math.sin(clock * 0.3 + b.seed * 10) * 1.5, 0.3, dt);
    b.burnT -= dt;
    if (b.burnT <= 0) {
      b.burn = 1.2;
      b.burnT = 4 + rnd() * 6;
      VC.fxgl.sfx('burner', b.x, b.z, 0.4, 50);
    }
    if (b.burn > 0) {
      b.burn -= dt;
      if (VC.particles && rnd() < dt * 20) {
        VC.fxgl.xfPoint(VC.fxgl.pose(T12, b.m, b.x, b.y, b.z, b.h, 0, 0, 1), b.m.sx * 0.5, 5, b.m.sz * 0.5, P3);
        VC.particles.emit('fire', P3[0], P3[1], P3[2], { vx: 0, vy: 1.5, vz: 0, size: 0.14, life: 0.3 });
      }
    }
    const far = Math.hypot(b.x - cam.tx, b.z - cam.tz) > 100 || !nice;
    b.fade = far ? b.fade - dt * 0.5 : Math.min(1, b.fade + dt * 0.5);
    if (b.fade < 0) balloons.splice(k, 1);
  }
}
