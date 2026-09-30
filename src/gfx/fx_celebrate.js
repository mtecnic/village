/*
 * VOXELPOLIS — celebrations (VC.fxCel), drawn by the VC.fx layer.
 *
 *   fireworks(x, z, n)  a show of n shells over ~5-20 s (a finale cluster at the end): rockets with
 *                       spark trails, then peony / two-tone / ring / willow / crackle bursts in HDR colours
 *                       with flashes that light the sky ('sfx' firework). Triggered automatically on
 *                       'milestone' (30 shells + confetti) and 'year' (New Year, 18 shells) over City Hall
 *                       or the population-weighted city centre.
 *   confetti(x, z, n)   confetti + sparkle bursts (above City Hall when (x, z) is omitted)
 *   isLaunching(b)      true while space_center b's pad rocket must NOT be drawn by the building renderer:
 *                       from lift-off, through the empty-pad pause after the flight, until the replacement
 *                       rocket drawn here has risen onto the pad (then the static one takes over, same pose)
 *   launchPhase(b)      null | 'count' | 'ignite' | 'lift' | 'reset' | 'rollout' (debug / UI)
 *   launch(b)           space-center rocket launch: countdown venting, ignition with a huge steam cloud,
 *                       ascent with flame, exhaust glow and smoke trail, gravity turn ('sfx' rocket), then
 *                       the pad stays empty for a while and a new rocket rises onto it from the silo.
 *                       Happens automatically a few times per game year for every working space_center.
 *                       The flying rocket uses the building's orientation, so the hand-over from the static
 *                       pad rocket (hidden while isLaunching) is seamless.
 * Uses real time so shows keep playing while the game is paused.
 */
const M = VC.M, C = VC.C;
/** Vector lengths without Math.hypot (V8's hypot allocates its argument list; these are on per-frame paths). */
const hyp = (x, z) => Math.sqrt(x * x + z * z);
const hyp3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
const TAU = Math.PI * 2;
const FW_COLS = [[4, 0.6, 0.5], [0.6, 4, 0.9], [0.8, 1.2, 5], [4, 2.6, 0.8], [3, 0.8, 4], [0.6, 3.5, 4], [4, 4, 4], [4, 1.2, 2.6]];
const T12 = new Float32Array(12);
let rnd = M.rng(21);
const queue = []; // pending shells {t, x, z}
const shells = []; // rising shells
const pops = []; // delayed crackles / flashes {t, x, y, z, kind, c}
const launches = [];
let sfxT = 0;
let showSeq = 0; // incremented by every fireworks() call
let pending = null; // deferred automatic celebration {n, confetti, seq}
const PAD_EMPTY = 30, ROLLOUT = 5; // real seconds the pad stays empty after a flight / the new rocket rises

const Cel = (VC.fxCel = {
  init() {
    // Deferred one frame: if another module already started a show for the same event (advisors call
    // VC.fx.fireworks on milestones), only the confetti is added.
    VC.bus.on('milestone', () => (pending = { n: 30, confetti: true, seq: showSeq }));
    VC.bus.on('year', () => { if (!pending) pending = { n: 18, confetti: false, seq: showSeq }; });
    VC.bus.on('month', onMonth);
  },
  reset(S) {
    rnd = VC.fxgl.rng((S.seed ^ 0xf1e0) >>> 0);
    queue.length = shells.length = pops.length = launches.length = 0;
    pending = null;
  },
  stats() {
    return { queued: queue.length, shells: shells.length, launches: launches.length };
  },
  /** True while space_center b's static pad rocket must be hidden (flight, empty pad, rollout). */
  isLaunching(b) {
    for (let k = 0; k < launches.length; k++) {
      const l = launches[k];
      if (l.b === b) return l.phase === 'lift' || l.phase === 'reset' || l.phase === 'rollout';
    }
    return false;
  },
  launchPhase(b) {
    for (let k = 0; k < launches.length; k++) if (launches[k].b === b) return launches[k].phase;
    return null;
  },

  fireworks(x, z, n = 20) {
    const S = VC.state;
    if (!S) return false;
    if (x == null || z == null) [x, z] = center(S);
    n = M.clamp(n | 0, 1, 80);
    showSeq++;
    const D = M.clamp(n * 0.55, 4, 20);
    for (let k = 0; k < n; k++) {
      const finale = k >= n * 0.82;
      queue.push({ t: finale ? D * 0.85 + rnd() * D * 0.15 : rnd() * D * 0.85, x: x + (rnd() - 0.5) * 7, z: z + (rnd() - 0.5) * 7 });
    }
    return true;
  },

  confetti(x, z, n = 150) {
    const S = VC.state, Pt = VC.particles;
    if (!S || !Pt) return false;
    let y;
    if (x == null || z == null) {
      const hall = findKey(S, 'city_hall');
      if (hall) {
        x = hall.x + hall.w / 2; z = hall.z + hall.d / 2;
        y = VC.world.topY(hall.x, hall.z) + (hall.hgt || 2) + 0.8;
      } else [x, z] = center(S);
    }
    if (y == null) y = VC.fxgl.surfaceY(x, z) + 3;
    Pt.burst('confetti', x, y, z, n, { jitter: 1.2 });
    Pt.burst('sparkle', x, y, z, Math.round(n / 5), { jitter: 1.5 });
    pops.push({ t: 0.7, x: x + 1, y: y + 0.5, z, kind: 'confetti', c: n >> 1 });
    pops.push({ t: 1.4, x: x - 1, y: y + 0.3, z: z + 0.5, kind: 'confetti', c: n >> 1 });
    return true;
  },

  launch(b) {
    const S = VC.state;
    if (!S) return false;
    b = b || findKey(S, 'space_center');
    if (!b || launches.some((l) => l.b === b)) return false;
    // the pad position comes from the building's model: only when it is built (never build it here)
    const bm = VC.fxgl.cachedModel(b);
    const rm = VC.models.get('rocket');
    if (!rm || !bm) return false;
    let x = b.x + b.w / 2, z = b.z + b.d / 2, y = VC.world.topY(b.x, b.z);
    const pad = bm.meta && bm.meta.rocket;
    if (pad) {
      const w = VC.models.localToWorld(b, bm, pad.x, pad.y, pad.z);
      x = w[0]; y = w[1]; z = w[2];
    }
    // heading of the building's model frame (as VC.fxgl.poseBuilding): the flying rocket replaces the static
    // one in exactly the same pose; the gravity turn leans along the pad's front axis
    const h = Math.PI * 0.5 - (b.rot | 0) * Math.PI * 0.5;
    launches.push({ b, m: rm, x, y, z, y0: y, pad: { x, y, z }, t: 0, phase: 'count', v: 0, tilt: 0, h, stat: !!pad, dist: 0 });
    VC.bus.emit('toast', { text: '🚀 Launch countdown at the Space Center!', type: 'good', icon: '🚀' });
    return true;
  },

  update(dt, rdt, S, B, G) {
    if (pending) {
      const p = pending;
      pending = null;
      if (showSeq === p.seq) celebrate(p.n, false);
      if (p.confetti) Cel.confetti();
    }
    if (rdt <= 0) return drawOnly(B, G);
    const Pt = VC.particles;
    sfxT -= rdt;
    // queued shells
    for (let k = queue.length - 1; k >= 0; k--) {
      const q = queue[k];
      q.t -= rdt;
      if (q.t > 0) continue;
      queue.splice(k, 1);
      const gy = VC.fxgl.surfaceY(M.clamp(q.x, 0, S.W - 1), M.clamp(q.z, 0, S.H - 1));
      shells.push({ x: q.x, y: gy + 0.3, z: q.z, vx: (rnd() - 0.5) * 1.4, vy: 9 + rnd() * 3, vz: (rnd() - 0.5) * 1.4, fuse: 0.95 + rnd() * 0.5, c1: Math.floor(rnd() * FW_COLS.length), c2: Math.floor(rnd() * FW_COLS.length), pat: pickPattern() });
    }
    // rising shells
    for (let k = shells.length - 1; k >= 0; k--) {
      const s = shells[k];
      s.fuse -= rdt;
      s.vy -= 4 * rdt;
      s.x += s.vx * rdt; s.y += s.vy * rdt; s.z += s.vz * rdt;
      if (Pt) Pt.emit('spark', s.x, s.y, s.z, { vx: (rnd() - 0.5) * 0.4, vy: -1, vz: (rnd() - 0.5) * 0.4, life: 0.35 + rnd() * 0.2, size: 0.05 });
      if (s.fuse <= 0) {
        shells.splice(k, 1);
        burst(s);
      }
    }
    // delayed pops
    for (let k = pops.length - 1; k >= 0; k--) {
      const p = pops[k];
      p.t -= rdt;
      if (p.kind === 'flash' && p.t > -0.3) continue;
      if (p.t > 0) continue;
      pops.splice(k, 1);
      if (!Pt) continue;
      if (p.kind === 'crackle') {
        Pt.burst('crackle', p.x, p.y, p.z, 28, { jitter: 2.6 });
        if (sfxT <= 0) { VC.bus.emit('sfx', { name: 'firework', x: p.x, z: p.z, vol: 0.35, rate: 1.5 }); sfxT = 0.08; }
      } else if (p.kind === 'confetti') Pt.burst('confetti', p.x, p.y, p.z, p.c, { jitter: 1 });
    }
    updateLaunches(S, rdt, Pt);
    drawOnly(B, G);
  },
});

function pickPattern() {
  const r = rnd();
  return r < 0.3 ? 0 : r < 0.5 ? 1 : r < 0.65 ? 2 : r < 0.82 ? 3 : 4;
}
function burst(s) {
  const Pt = VC.particles;
  const c1 = FW_COLS[s.c1], c2 = FW_COLS[s.c2];
  if (Pt) {
    Pt.burst('flash', s.x, s.y, s.z, 1, { size: 1.6, color: [c1[0] * 1.2, c1[1] * 1.2, c1[2] * 1.2] });
    switch (s.pat) {
      case 0:
        Pt.burst('firework', s.x, s.y, s.z, 120, { color: c1, spread: 5.5 });
        break;
      case 1:
        Pt.burst('firework', s.x, s.y, s.z, 70, { color: c1, spread: 5.8 });
        Pt.burst('firework', s.x, s.y, s.z, 55, { color: c2, spread: 3.4 });
        break;
      case 2: {
        // ring in a random plane
        const nx = rnd() - 0.5, ny = 1 + rnd(), nz = rnd() - 0.5;
        const l = hyp3(nx, ny, nz);
        const n = [nx / l, ny / l, nz / l];
        let u = [n[1], -n[0], 0];
        const ul = hyp3(u[0], u[1], u[2]) || 1;
        u = [u[0] / ul, u[1] / ul, u[2] / ul];
        const w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
        for (let k = 0; k < 72; k++) {
          const a = (k / 72) * TAU, sp = 6;
          Pt.emit('firework', s.x, s.y, s.z, { vx: (u[0] * Math.cos(a) + w[0] * Math.sin(a)) * sp, vy: (u[1] * Math.cos(a) + w[1] * Math.sin(a)) * sp, vz: (u[2] * Math.cos(a) + w[2] * Math.sin(a)) * sp, color: c1 });
        }
        Pt.burst('firework', s.x, s.y, s.z, 20, { color: c2, spread: 1.5 });
        break;
      }
      case 3:
        Pt.burst('willow', s.x, s.y, s.z, 90, { spread: 4.6 });
        break;
      default:
        Pt.burst('firework', s.x, s.y, s.z, 60, { color: c1, spread: 5 });
        pops.push({ t: 0.9 + rnd() * 0.3, x: s.x, y: s.y - 1.5, z: s.z, kind: 'crackle' });
    }
  }
  pops.push({ t: 0, x: s.x, y: s.y, z: s.z, kind: 'flash', c: s.c1 });
  if (sfxT <= 0) { VC.fxgl.sfx('firework', s.x, s.z, 0.8, 140); sfxT = 0.1; }
}

function drawOnly(B, G) {
  // shell heads + burst flashes lighting the sky
  for (let k = 0; k < shells.length; k++) {
    const s = shells[k];
    G.add(s.x, s.y, s.z, 0.25, 1, 0.8, 0.5, 3, 0, 0, 1, 0.6);
  }
  for (let n = 0; n < pops.length; n++) {
    const p = pops[n];
    if (p.kind !== 'flash') continue;
    const k = M.clamp(-p.t / 0.3, 0, 1);
    const c = FW_COLS[p.c];
    G.add(p.x, p.y, p.z, 5 + k * 4, c[0] * 0.25, c[1] * 0.25, c[2] * 0.25, (1 - k) * (1 - k) * 0.8, 0, 0, 1, 0.05);
  }
  for (let k = 0; k < launches.length; k++) drawLaunch(launches[k], B, G);
}

/* ---------------- space center launches ---------------- */
function updateLaunches(S, rdt, Pt) {
  const cam = VC.camera;
  for (let k = launches.length - 1; k >= 0; k--) {
    const l = launches[k];
    l.t += rdt;
    if (!S.buildings.has(l.b.id) && l.phase !== 'lift') { launches.splice(k, 1); continue; }
    if (l.phase === 'reset') {
      // empty pad after the flight (the static rocket stays hidden: isLaunching)
      if (l.t > PAD_EMPTY) { l.phase = 'rollout'; l.t = 0; }
      continue;
    }
    if (l.phase === 'rollout') {
      // the replacement rocket rises from the silo onto the pad, then the static pad rocket takes over
      if (Pt && hyp(l.pad.x - cam.tx, l.pad.z - cam.tz) < 140 && rnd() < rdt * 10) {
        const a = rnd() * TAU;
        Pt.emit('steam', l.pad.x + Math.cos(a) * 0.6, l.pad.y + 0.2, l.pad.z + Math.sin(a) * 0.6, { vx: Math.cos(a) * 0.6, vy: 0.4, vz: Math.sin(a) * 0.6, size: 0.35 });
      }
      if (l.t > ROLLOUT) launches.splice(k, 1);
      continue;
    }
    const near = hyp(l.x - cam.tx, l.z - cam.tz) < 140;
    if (l.phase === 'count') {
      if (Pt && near && rnd() < rdt * 14) {
        const a = rnd() * TAU;
        Pt.emit('steam', l.x + Math.cos(a) * 0.5, l.y + 0.4 + rnd() * 3, l.z + Math.sin(a) * 0.5, { vx: Math.cos(a) * 0.8, vy: 0.3, vz: Math.sin(a) * 0.8, size: 0.3 });
      }
      if (l.t > 5) { l.phase = 'ignite'; l.t = 0; VC.fxgl.sfx('rocket', l.x, l.z, 1, 160); }
    } else if (l.phase === 'ignite') {
      if (Pt && near) cloud(Pt, l, rdt, 22);
      if (cam.shake && near) cam.shake(0.06);
      if (l.t > 2) { l.phase = 'lift'; l.t = 0; }
    } else if (l.phase === 'lift') {
      l.v += (2 + l.t * 0.4) * rdt;
      const alt = l.dist;
      if (alt > 25) l.tilt = Math.min(0.45, l.tilt + rdt * 0.03);
      const st = Math.sin(l.tilt), ct = Math.cos(l.tilt);
      const step = l.v * rdt;
      l.x += Math.cos(l.h) * st * step;
      l.z += Math.sin(l.h) * st * step;
      l.y += ct * step;
      l.dist += step;
      if (Pt && near) {
        if (l.t < 4) cloud(Pt, l.pad, rdt, 18 * (1 - l.t / 4));
        const n = Math.min(6, Math.ceil(rdt * 90));
        for (let q = 0; q < n; q++) {
          const f = rnd();
          Pt.emit('fire', l.x - Math.cos(l.h) * st * step * f, l.y - ct * step * f - 0.2, l.z - Math.sin(l.h) * st * step * f, { vx: -Math.cos(l.h) * st * 6 + (rnd() - 0.5) * 1.5, vy: -ct * 6 - rnd() * 2, vz: -Math.sin(l.h) * st * 6 + (rnd() - 0.5) * 1.5, size: 0.5 + rnd() * 0.4, life: 0.35 });
        }
        if (l.dist < 160 && rnd() < rdt * 24) Pt.emit('steam', l.x, l.y - 1, l.z, { vx: (rnd() - 0.5) * 0.5, vy: -0.5, vz: (rnd() - 0.5) * 0.5, size: 0.5 + l.dist * 0.008, life: 8 + rnd() * 4, alpha: 0.45, grow: 2.4 });
      }
      if (cam.shake && l.t < 3 && near) cam.shake(0.05 * (1 - l.t / 3));
      if (l.dist > 240 || l.t > 40) {
        // flight over: keep the record (pad empty, then rollout) unless there is no pad rocket to restore
        if (!l.stat || !S.buildings.has(l.b.id)) launches.splice(k, 1);
        else { l.phase = 'reset'; l.t = 0; }
      }
    }
  }
}
function cloud(Pt, l, rdt, rate) {
  let n = rate * rdt;
  while (n > 0 && (n >= 1 || rnd() < n)) {
    n -= 1;
    const a = rnd() * TAU, s = 1.5 + rnd() * 3;
    Pt.emit(rnd() < 0.7 ? 'steam' : 'dust', l.x + Math.cos(a) * 0.6, l.y + 0.2, l.z + Math.sin(a) * 0.6, { vx: Math.cos(a) * s, vy: 0.3 + rnd() * 0.8, vz: Math.sin(a) * s, size: 0.45 + rnd() * 0.45, life: 4 + rnd() * 3, alpha: 0.5, grow: 2.6 });
  }
}
function drawLaunch(l, B, G) {
  if (l.phase === 'reset') return;
  if (l.phase === 'rollout') {
    const k = M.clamp(l.t / ROLLOUT, 0, 1), e = k * k * (3 - 2 * k);
    VC.fxgl.pose(T12, l.m, l.pad.x, l.pad.y - (1 - e) * (l.m.height + 0.2), l.pad.z, l.h, 0, 0, 1);
    B.add(l.m, false, T12, 0, 0, VC.fxgl.WHITE, 0.2);
    return;
  }
  const moving = l.phase === 'lift';
  // the pad already shows a static rocket in the space center model: only draw ours once it moves
  if (moving || !l.stat) {
    VC.fxgl.pose(T12, l.m, l.x, l.y, l.z, l.h, -l.tilt, 0, 1);
    B.add(l.m, l.dist > 60, T12, 0, 0, VC.fxgl.WHITE, 0.2);
  }
  if (l.phase === 'ignite' || moving) {
    const k = l.phase === 'ignite' ? Math.min(1, l.t * 1.5) : 1;
    const flick = 0.85 + 0.15 * Math.sin(VC.gfx.time * 37);
    G.add(l.x, l.y - 0.2, l.z, 1.3 * k, 1, 0.75, 0.4, 7 * k * flick, 0, 0, 1, 0.7);
    G.add(l.x, l.y - 0.1, l.z, 0.45 * k, 1, 0.7, 0.35, 4 * k * flick, 5, 0, 3.2 * k, 2.4);
    G.add(l.x, l.y, l.z, 7 * k, 1, 0.5, 0.2, 0.9 * k, 0, 0, 1, 0);
    if (l.dist < 30) G.add(l.pad.x, l.pad.y + 0.05, l.pad.z, 8 * k, 1, 0.55, 0.25, 1.6 * k * (1 - l.dist / 30), 1, 0, 1, 0);
  }
}

/* ---------------- triggers ---------------- */
function findKey(S, key) {
  for (const b of S.buildings.values()) if (b.key === key && b.built >= 1) return b;
  return null;
}
function center(S) {
  const hall = findKey(S, 'city_hall');
  if (hall) return [hall.x + hall.w / 2, hall.z + hall.d / 2];
  let sx = 0, sz = 0, sw = 0;
  for (const b of S.buildings.values()) {
    if (b.key === 'rubble') continue;
    const w = 1 + (b.pop || 0) * 0.05;
    sx += (b.x + b.w / 2) * w;
    sz += (b.z + b.d / 2) * w;
    sw += w;
  }
  return sw ? [sx / sw, sz / sw] : [S.W / 2, S.H / 2];
}
function celebrate(n, confetti) {
  const S = VC.state;
  if (!S || !S.buildings.size) return;
  const [x, z] = center(S);
  Cel.fireworks(x, z, n);
  if (confetti) Cel.confetti();
}
function onMonth() {
  const S = VC.state;
  if (!S) return;
  for (const b of S.buildings.values()) {
    if (b.key !== 'space_center' || b.built < 1 || b.powered === false || b.abandoned) continue;
    if (rnd() < 0.28) Cel.launch(b);
  }
}
