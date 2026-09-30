/*
 * VOXELPOLIS — ambience (VC.audio.amb): the sound of the place the camera is looking at.
 *
 * BEDS  seamless stereo loops rendered offline (city hum, industry, wind, rain, waves, crickets, fire,
 *       tornado, UFO hum, quake rumble, monster growl). Each bed has a gain (+ panner for positional
 *       ones); its level follows a target computed every ~0.35 s. Beds start lazily and are stopped
 *       after a few silent seconds, so idle loops cost nothing.
 * TARGETS come from a 9x9 sample grid around the camera target (radius scales with zoom): water,
 *       greenery (trees + park map), buildings by zone type, construction sites, road traffic
 *       (S.maps.traffic), plus population, VC.gfx.env (night, season), S.weather (wet, wind, type,
 *       lightning), VC.disasters.active and burning buildings.
 * ONE-SHOTS (Poisson timers, positional via VC.audio.play): songbirds by day (dawn chorus, more over
 *       greenery, fewer in winter/rain), gulls over water, owls and frogs at night, traffic swooshes
 *       and the odd horn when zoomed in over busy roads, hammer taps at construction sites, thunder
 *       after lightning flashes (unless the weather module already played one).
 */
const A = VC.audio, M = VC.M;
const TAU = Math.PI * 2;
const AMB = (A.amb = { on: false, beds: {}, env: null, targets: {} });

/* ------------------------------------------------------------------ */
/* Bed renderers                                                        */
/* ------------------------------------------------------------------ */
/** Renders a stereo loop of `sec` seconds (+0.6 s crossfade tail) and normalizes to `peak`. */
function loopStereo(D, sec, seed, peak, fn) {
  return D.stereo(sec + 0.6, seed, fn).map((c) => D.normalize(D.loopify(c, sec, 0.6), peak));
}
/** Band-passed noise whose centre wanders (wind / howl). */
function wander(D, b, r, f0, f1, q, amp, rate, color = 'pink') {
  const nz = D.noiseGen(color, r), bq = new D.Biquad('bp', f0, q);
  const p1 = r() * TAU, p2 = r() * TAU;
  for (let i = 0; i < b.length; i++) {
    if ((i & 63) === 0) {
      const t = i / D.sr;
      const x = 0.5 + 0.35 * Math.sin(t * rate * TAU + p1) + 0.15 * Math.sin(t * rate * 2.7 * TAU + p2);
      bq.set('bp', f0 + (f1 - f0) * x, q);
    }
    b[i] += bq.run(nz()) * amp;
  }
}
const BEDS = {
  city: { vol: 0.5, render: (D) => loopStereo(D, 6, 3, 0.8, (b, r) => {
    D.noise(b, 0, 6.6, 1, { color: 'brown', f: 'lp', f0: 240, rnd: r, env: (x) => 0.8 + 0.2 * Math.sin(x * 19 + r() * 6) });
    D.noise(b, 0, 6.6, 0.22, { color: 'pink', f: 'bp', f0: 850, q: 0.5, rnd: r });
    for (let k = 0; k < 5; k++) D.noise(b, r() * 5.4, 1.3, 0.3, { color: 'pink', f: 'bp', f0: 380, f1: 950, q: 0.9, rnd: r, env: (x) => Math.sin(Math.PI * x) ** 2 });
  }) },
  industry: { vol: 0.4, render: (D) => loopStereo(D, 4, 5, 0.75, (b, r, ch) => {
    for (const [f, a] of [[50, 0.6], [100, 0.35], [150, 0.2], [200.6, 0.12]]) D.tone(b, 0, 4.6, f * (1 + ch * 0.002), f * (1 + ch * 0.002), a, { a: 0.1 });
    for (let t = 0.1; t < 4.5; t += 0.5) D.modal(b, t + r() * 0.03, 0.3, 140 + r() * 30, [[1, 1, 0.05], [2.8, 0.5, 0.03], [5.3, 0.3, 0.012]], 0.35);
    D.noise(b, 0, 4.6, 0.25, { color: 'pink', f: 'bp', f0: 1800, q: 0.7, rnd: r });
  }) },
  wind: { vol: 0.55, render: (D) => loopStereo(D, 8, 7, 0.8, (b, r) => {
    wander(D, b, r, 280, 900, 1.4, 1, 0.09);
    wander(D, b, r, 1400, 3000, 3, 0.15, 0.13, 'white');
  }) },
  rain: { vol: 0.4, render: (D) => loopStereo(D, 5, 9, 0.8, (b, r) => {
    D.noise(b, 0, 5.6, 0.5, { f: 'hp', f0: 900, f2: 'lp', q2: 0.6, rnd: r });
    D.filter(b, 'lp', 9000, 0.5);
    D.crackle(b, 0, 5.6, 420, 0.5, { f: 3800, q: 1.4, len: 0.0012, rnd: r });
    D.crackle(b, 0, 5.6, 35, 0.45, { f: 1300, q: 2.5, len: 0.004, rnd: r });
  }) },
  waves: { vol: 0.55, render: (D) => loopStereo(D, 9, 11, 0.8, (b, r) => {
    const o = r() * 0.8;
    const swell = (x) => {
      // two waves per loop: slow build, crash, long receding hiss
      const t = ((x * 9.6 + o) % 4.8) / 4.8;
      return t < 0.55 ? 0.2 + 0.8 * (t / 0.55) ** 2 : 0.2 + 0.8 * Math.exp(-(t - 0.55) * 6);
    };
    D.noise(b, 0, 9.6, 1, { color: 'brown', f: 'lp', f0: 600, rnd: r, env: swell });
    D.noise(b, 0, 9.6, 0.35, { color: 'pink', f: 'hp', f0: 1500, rnd: r, env: (x) => swell(x) ** 3 });
  }) },
  crickets: { vol: 0.28, render: (D) => loopStereo(D, 4, 13, 0.7, (b, r) => {
    for (let c = 0; c < 3; c++) {
      const f = 4200 + r() * 1100, period = 0.45 + r() * 0.5, pulses = 2 + Math.floor(r() * 3), amp = 0.4 + r() * 0.6;
      for (let t = r() * period; t < 4.5; t += period * (0.95 + r() * 0.1))
        for (let p = 0; p < pulses; p++) D.tone(b, t + p * 0.03, 0.02, f, f, amp, { a: 0.004, d: 0.008 });
    }
  }) },
  fire: { vol: 0.55, pos: true, render: (D) => loopStereo(D, 3, 17, 0.85, (b, r) => {
    D.noise(b, 0, 3.6, 0.7, { color: 'brown', f: 'lp', f0: 420, rnd: r, env: (x) => 0.7 + 0.3 * Math.sin(x * 23) });
    D.crackle(b, 0, 3.6, 50, 1, { f: 2600, q: 1.1, len: 0.003, rnd: r });
    D.crackle(b, 0, 3.6, 12, 0.7, { f: 900, q: 1.5, len: 0.01, rnd: r });
  }) },
  tornado: { vol: 0.75, pos: true, render: (D) => loopStereo(D, 5, 19, 0.85, (b, r) => {
    wander(D, b, r, 220, 650, 4.5, 1, 0.35);
    D.noise(b, 0, 5.6, 0.8, { color: 'brown', f: 'lp', f0: 180, rnd: r });
    D.crackle(b, 0, 5.6, 60, 0.3, { f: 1500, q: 0.8, len: 0.006, rnd: r });
  }) },
  ufo: { vol: 0.35, pos: true, render: (D) => loopStereo(D, 4, 23, 0.7, (b, r, ch) => {
    D.tone(b, 0, 4.6, 110, 110, 0.5, { a: 0.2 });
    D.tone(b, 0, 4.6, 165.8 + ch, 165.8 + ch, 0.3, { a: 0.2 });
    D.tone(b, 0, 4.6, 620, 620, 0.22, { a: 0.3, vib: [5, 0.03] });
  }) },
  quake: { vol: 0.8, pos: true, render: (D) => loopStereo(D, 4, 29, 0.85, (b, r) => {
    D.noise(b, 0, 4.6, 1, { color: 'brown', f: 'lp', f0: 95, q: 1, rnd: r, env: (x) => 0.6 + 0.4 * Math.sin(x * 37) * Math.sin(x * 11) });
    D.crackle(b, 0, 4.6, 25, 0.4, { f: 700, q: 0.8, len: 0.012, rnd: r });
  }) },
  growl: { vol: 0.45, pos: true, render: (D) => loopStereo(D, 4, 31, 0.8, (b, r) => {
    D.tone(b, 0, 4.6, 52, 52, 0.8, { type: 'saw', a: 0.2, env: (x) => 0.5 + 0.5 * Math.sin(x * 4.6 * TAU * 0.5) ** 2 });
    D.filter(b, 'lp', 420, 1.5);
    D.noise(b, 0, 4.6, 0.2, { color: 'brown', f: 'bp', f0: 300, q: 1.5, rnd: r, env: (x) => 0.5 + 0.5 * Math.sin(x * 4.6 * TAU * 0.5) ** 2 });
  }) },
};
AMB.BEDS = BEDS;

/* ------------------------------------------------------------------ */
/* Ambient one-shot recipes (bus 'amb')                                 */
/* ------------------------------------------------------------------ */
const R = A.RECIPES;
const mt = (m) => 440 * Math.pow(2, (m - 69) / 12);
R.bird = {
  vol: 0.2, group: 'bird', win: 90, variants: 7, pitch: 0.08, prio: 0, bus: 'amb', wet: 0.12,
  render(D, r, v) {
    const b = D.buf(1.3);
    let t = 0;
    const f0 = 2600 + r() * 2200;
    if (v % 3 === 0) { // trill
      const n = 5 + Math.floor(r() * 8), dt = 0.04 + r() * 0.03;
      for (let k = 0; k < n; k++) D.tone(b, k * dt, dt * 0.8, f0 * (1 + 0.15 * Math.sin(k)), f0 * 1.2, 0.6, { a: 0.004, d: dt * 0.4 });
    } else if (v % 3 === 1) { // two-note whistle ("fee-bee")
      D.tone(b, 0, 0.28, f0 * 1.25, f0 * 1.22, 0.7, { a: 0.03, hold: 0.15, d: 0.05 });
      D.tone(b, 0.35, 0.3, f0, f0 * 0.97, 0.7, { a: 0.03, hold: 0.15, d: 0.05 });
    } else { // chirps with fast sweeps
      const n = 2 + Math.floor(r() * 4);
      for (let k = 0; k < n; k++) {
        t += 0.06 + r() * 0.12;
        D.tone(b, t, 0.07, f0 * (0.8 + r() * 0.5), f0 * (1.3 + r() * 0.5), 0.6, { a: 0.004, d: 0.025, vib: [60, 0.02] });
      }
    }
    return D.fade(D.normalize(b, 0.8), 0.001, 0.05);
  },
};
R.gull = {
  vol: 0.18, group: 'gull', win: 400, variants: 3, pitch: 0.06, prio: 0, bus: 'amb', wet: 0.2,
  render(D, r) {
    const b = D.buf(1.3);
    for (let k = 0, t = 0; k < 3; k++, t += 0.24 + r() * 0.1) {
      D.tone(b, t, 0.22, 1250 + r() * 200, 820, 0.7, { type: 'saw', a: 0.02, d: 0.08, vib: [28, 0.03] });
    }
    D.filter(b, 'bp', 1400, 0.9);
    return D.fade(D.normalize(b, 0.8), 0.002, 0.05);
  },
};
R.owl = {
  vol: 0.16, group: 'owl', win: 2000, variants: 2, pitch: 0.04, prio: 0, bus: 'amb', wet: 0.4,
  render(D, r, v) {
    const b = D.buf(1.6);
    const f = v ? 390 : 360;
    D.tone(b, 0, 0.35, f * 1.05, f, 0.6, { a: 0.05, hold: 0.15, d: 0.07 });
    D.tone(b, 0.55, 0.6, f * 1.03, f * 0.96, 0.7, { a: 0.06, hold: 0.3, d: 0.1, vib: [6, 0.01] });
    D.noise(b, 0, 1.2, 0.04, { f: 'bp', f0: f * 2, q: 3, a: 0.1, d: 0.4, rnd: r });
    return D.fade(D.normalize(b, 0.8), 0.002, 0.05);
  },
};
R.frog = {
  vol: 0.16, group: 'frog', win: 150, variants: 3, pitch: 0.1, prio: 0, bus: 'amb', wet: 0.15,
  render(D, r, v) {
    const b = D.buf(0.5);
    const f = 180 + v * 60 + r() * 40;
    for (let k = 0; k < 2 + v; k++) D.tone(b, k * 0.11, 0.09, f * 1.3, f, 0.7, { type: 'sqr', pw: 0.3, a: 0.005, d: 0.03, vib: [45, 0.05] });
    D.filter(b, 'bp', 700, 1.2);
    return D.fade(D.normalize(b, 0.8), 0.001, 0.03);
  },
};
R.swoosh = {
  vol: 0.2, group: 'swoosh', win: 110, variants: 4, pitch: 0.12, prio: 0, bus: 'amb', wet: 0.05,
  render(D, r, v) {
    const b = D.buf(1.2);
    // car pass-by: rising then falling band of road noise with a doppler hint
    D.noise(b, 0, 1.2, 1, { color: 'pink', f: 'bp', f0: 500 + v * 120, f1: 1100, q: 0.8, rnd: r, env: (x) => Math.exp(-((x - 0.5) ** 2) / 0.03) });
    D.tone(b, 0, 1.2, 150 + v * 20, 110 + v * 15, 0.12, { type: 'saw', a: 0.3, env: (x) => Math.exp(-((x - 0.5) ** 2) / 0.02) });
    D.filter(b, 'lp', 3000, 0.6);
    return D.fade(D.normalize(b, 0.8), 0.01, 0.1);
  },
};

/* ------------------------------------------------------------------ */
/* Environment sampling (no allocations)                                */
/* ------------------------------------------------------------------ */
const E = { n: 0, water: 0, green: 0, urban: 0, res: 0, com: 0, ind: 0, build: 0, roads: 0, traffic: 0, bx: 0, bz: 0, r: 10 };
const IND_KEYS = { coal_plant: 1, gas_plant: 1, incinerator: 1, landfill: 1, recycling: 1, seaport: 1, nuclear_plant: 1, desalination: 1, water_plant: 0.5 };
function sampleEnv(S) {
  const cam = VC.camera;
  const cx = cam.tx, cz = cam.tz, W = S.W, H = S.H;
  const r = M.clamp(cam.dist * 0.45, 6, 48), G = 9, step = (2 * r) / (G - 1);
  let n = 0, water = 0, green = 0, urban = 0, res = 0, com = 0, ind = 0, build = 0, roads = 0, traffic = 0;
  const park = S.maps && S.maps.park, tmap = S.maps && S.maps.traffic;
  const SEA = VC.C.SEA;
  for (let gz = 0; gz < G; gz++) {
    const z = Math.floor(cz - r + gz * step);
    if (z < 0 || z >= H) continue;
    for (let gx = 0; gx < G; gx++) {
      const x = Math.floor(cx - r + gx * step);
      if (x < 0 || x >= W) continue;
      const i = z * W + x;
      n++;
      if (S.height[i] < SEA) { water++; continue; }
      green += S.trees[i] / 3 + (park ? park[i] / 510 : 0);
      if (S.road[i]) { roads++; if (tmap) traffic += tmap[i]; }
      const id = S.bld[i];
      if (id) {
        urban++;
        const b = S.buildings.get(id);
        if (b) {
          if (b.zt === 1) res++; else if (b.zt === 2) com++; else if (b.zt === 3) ind++;
          else if (IND_KEYS[b.key]) ind += IND_KEYS[b.key];
          if (b.built < 1) { build++; E.bx = b.x + b.w / 2; E.bz = b.z + b.d / 2; }
        }
      }
    }
  }
  const k = n ? 1 / n : 0;
  E.n = n; E.r = r;
  E.water = water * k; E.green = Math.min(1, green * k * 1.4); E.urban = urban * k;
  E.res = res * k; E.com = com * k; E.ind = Math.min(1, ind * k);
  E.build = build; E.roads = roads * k; E.traffic = roads ? traffic / roads / 255 : 0;
  return E;
}
/** Loudest burning building (sim fires) near the camera: {g, pan} in FIRE. Runs ~1/s. */
const FIRE = { g: 0, pan: 0 };
function scanFires(S) {
  FIRE.g = 0; FIRE.pan = 0;
  for (const b of S.buildings.values()) {
    if (!(b.fire > 0)) continue;
    const sp = A.spatial(b.x + b.w / 2, b.z + b.d / 2);
    const g = sp.g * Math.min(1, 0.4 + b.fire);
    if (g > FIRE.g) { FIRE.g = g; FIRE.pan = sp.pan; }
  }
}
/** Random tile near the camera matching a predicate (few tries) -> sets PT.x/z. */
const PT = { x: 0, z: 0 };
function findTile(S, pred, tries) {
  const cam = VC.camera, r = E.r;
  for (let t = 0; t < tries; t++) {
    const x = Math.floor(cam.tx + (Math.random() * 2 - 1) * r), z = Math.floor(cam.tz + (Math.random() * 2 - 1) * r);
    if (x < 0 || z < 0 || x >= S.W || z >= S.H) continue;
    if (pred(S, z * S.W + x)) { PT.x = x + 0.5; PT.z = z + 0.5; return true; }
  }
  return false;
}
const isTree = (S, i) => S.trees[i] > 0 || (S.maps && S.maps.park && S.maps.park[i] > 60);
const isWater = (S, i) => S.height[i] < VC.C.SEA;
const isRoad = (S, i) => S.road[i] > 0;
const nearWater = (S, i) => { const W = S.W; return S.height[i] >= VC.C.SEA && (isWater(S, i - 1) || isWater(S, i + 1) || isWater(S, i - W) || isWater(S, i + W)); };

/* ------------------------------------------------------------------ */
/* Beds                                                                 */
/* ------------------------------------------------------------------ */
const bufs = {};
function bed(key) {
  let bd = AMB.beds[key];
  if (bd) return bd;
  const ctx = A.ctx, B = A.bus;
  bd = AMB.beds[key] = { key, src: null, gain: ctx.createGain(), pan: null, level: 0, silent: 0 };
  bd.gain.gain.value = 0;
  let tail = bd.gain;
  if (BEDS[key].pos && B.hasPan) {
    bd.pan = ctx.createStereoPanner();
    bd.gain.connect(bd.pan);
    tail = bd.pan;
  }
  tail.connect(B.ambIn);
  return bd;
}
function startBed(bd) {
  if (bd.src) return;
  if (!bufs[bd.key]) {
    if (!bd.queued) { bd.queued = true; A.job(() => { bufs[bd.key] = A.toBuffer(BEDS[bd.key].render(A.dsp)); }, true); }
    return;
  }
  const src = A.ctx.createBufferSource();
  src.buffer = bufs[bd.key];
  src.loop = true;
  src.connect(bd.gain);
  // random start point so beds never line up the same way
  src.start(A.ctx.currentTime + 0.02, Math.random() * src.buffer.duration);
  bd.src = src;
  A.stats.live++;
}
function stopBed(bd) {
  if (!bd.src) return;
  const src = bd.src;
  bd.src = null;
  try { src.stop(A.ctx.currentTime + 0.05); } catch (e) { /* ignore */ }
  src.onended = () => { try { src.disconnect(); } catch (e) { /* ignore */ } };
  A.stats.live--;
}
/** Moves a bed toward target level (0..1) and pan; starts / retires its source. */
function setBed(key, target, pan, tc, dt) {
  const bd = bed(key);
  const v = M.clamp(target, 0, 1.2) * BEDS[key].vol;
  const ctx = A.ctx, t = ctx.currentTime;
  if (v > 0.002) { bd.silent = 0; startBed(bd); }
  else if ((bd.silent += dt) > 6) stopBed(bd);
  if (Math.abs(v - bd.level) > 0.003) {
    bd.level = v;
    bd.gain.gain.setTargetAtTime(v, t, tc || 0.8);
  }
  if (bd.pan && pan != null && Math.abs(bd.pan.pan.value - pan) > 0.02) bd.pan.pan.setTargetAtTime(M.clamp(pan, -0.9, 0.9), t, 0.3);
}

/* ------------------------------------------------------------------ */
/* Update                                                               */
/* ------------------------------------------------------------------ */
let acc = 0, fireAcc = 0, gust = 0.5, gustT = 0;
let tBird = 2, tGull = 5, tOwl = 20, tFrog = 3, tSwoosh = 1, tHorn = 20, tBuild = 2, tStorm = 20;
let lastLightning = 0, thunderIn = -1;
const T = AMB.targets;
const exp = (rate) => (rate > 1e-4 ? -Math.log(1 - Math.random()) / rate : 1e9);
const DIS_BED = { tornado: 'tornado', fire: 'fire', ufo: 'ufo', earthquake: 'quake', monster: 'growl' };
const dis = { tornado: [0, 0], fire: [0, 0], ufo: [0, 0], quake: [0, 0], growl: [0, 0] };

function computeTargets(S, dt) {
  const env = VC.gfx && VC.gfx.env, cam = VC.camera;
  const night = env ? env.night : 0, tod = env ? env.tod : 0.5;
  const season = env && env.season != null ? Math.floor(env.season + 0.5) % 4 : 1;
  const w = S.weather || {};
  const rain = w.type === 'snow' ? 0 : Math.max(w.type === 'rain' || w.type === 'storm' ? (w.intensity == null ? 0.7 : w.intensity) : 0, w.wet || 0);
  const snow = w.type === 'snow' ? (w.intensity == null ? 0.6 : w.intensity) : 0;
  const zoomNear = M.clamp(1 - (cam.dist - 12) / 140, 0.05, 1);
  const pop = (S.stats && S.stats.pop) || 0;
  const popF = M.clamp(Math.log10(pop + 1) / 5, 0, 1);
  const paused = !S.time.speed;
  const warm = [0.55, 1, 0.6, 0][season];
  E.night = night; E.rain = rain; E.zoomNear = zoomNear; E.warm = warm; E.paused = paused; E.popF = popF;
  E.day = M.clamp(1 - night * 1.2, 0, 1);
  E.dawn = tod > 0.22 && tod < 0.36 ? 1 : 0;

  T.city = ((0.1 + 0.9 * E.urban) * (0.2 + 0.8 * popF) * (0.3 + 0.7 * zoomNear) + popF * 0.25 * (1 - zoomNear)) * (1 - 0.35 * night) * (paused ? 0.6 : 1);
  T.industry = E.ind * (0.2 + 0.8 * zoomNear) * (paused ? 0.5 : 1);
  // gusty wind: stronger high up, in storms and snow
  gustT -= dt;
  if (gustT <= 0) { gust = 0.35 + Math.random() * 0.65; gustT = 2 + Math.random() * 5; }
  const wind = w.wind == null ? 0.4 : w.wind;
  T.wind = M.clamp((0.18 + 0.82 * wind) * (0.25 + 0.75 * M.clamp(cam.dist / 170, 0, 1)) * (0.6 + 0.4 * gust) + snow * 0.25 + (w.type === 'storm' ? 0.35 : 0), 0, 1);
  T.rain = rain * (0.65 + 0.35 * zoomNear);
  T.waves = Math.pow(E.water, 0.8) * (0.25 + 0.75 * zoomNear) * (0.7 + 0.5 * wind);
  T.crickets = night * warm * (0.3 + 0.7 * E.green) * (1 - E.urban * 0.5) * (1 - rain) * (0.3 + 0.7 * zoomNear);
  // disasters: loudest instance of each type, panned to it
  for (const k in dis) { dis[k][0] = 0; dis[k][1] = 0; }
  const act = VC.disasters && VC.disasters.active;
  if (act) {
    for (const d of act) {
      const key = DIS_BED[d.type];
      if (!key || d.x == null) continue;
      const sp = A.spatial(d.x, d.z);
      let g = Math.max(0.12, sp.g) * (d.intensity == null ? 1 : d.intensity);
      if (d.type === 'earthquake') g = Math.max(g, 0.35) * (d.shake == null ? 1 : 0.4 + d.shake);
      if (d.type === 'ufo' && d.beam) g *= 1 + d.beam * 0.5;
      if (g > dis[key][0]) { dis[key][0] = g; dis[key][1] = sp.pan; }
    }
  }
  if (FIRE.g > dis.fire[0]) { dis.fire[0] = FIRE.g; dis.fire[1] = FIRE.pan; }
}
function applyTargets(dt) {
  setBed('city', T.city, null, 1.2, dt);
  setBed('industry', T.industry, null, 1.2, dt);
  setBed('wind', T.wind, null, 1.5, dt);
  setBed('rain', T.rain, null, 1.5, dt);
  setBed('waves', T.waves, null, 1.2, dt);
  setBed('crickets', T.crickets, null, 2, dt);
  for (const k in dis) setBed(k, dis[k][0], dis[k][1], 0.4, dt);
}
function oneShots(S, dt) {
  const zn = E.zoomNear;
  // songbirds: day, greenery, fewer in winter / rain; a proper dawn chorus
  const birdRate = E.day * (0.15 + E.green) * (E.warm > 0 ? 1 : 0.15) * (1 - E.rain) * (0.35 + 0.65 * zn) * (E.dawn ? 2.2 : 0.7) * (1 - E.urban * 0.4);
  if ((tBird -= dt) <= 0) {
    tBird = Math.max(0.2, exp(birdRate));
    if (birdRate > 0.02 && findTile(S, isTree, 6)) A.play('bird', { x: PT.x, z: PT.z, vol: 0.6 + Math.random() * 0.5 });
  }
  const gullRate = E.day * (E.water > 0.2 ? E.water : 0) * 0.25 * (0.3 + zn) * (1 - E.rain);
  if ((tGull -= dt) <= 0) {
    tGull = Math.max(1.5, exp(gullRate));
    if (gullRate > 0.005 && findTile(S, isWater, 4)) A.play('gull', { x: PT.x, z: PT.z });
  }
  const owlRate = E.night > 0.8 ? 0.03 * E.green * (1 - E.rain) : 0;
  if ((tOwl -= dt) <= 0) {
    tOwl = Math.max(6, exp(owlRate));
    if (owlRate > 0.003 && findTile(S, isTree, 6)) A.play('owl', { x: PT.x, z: PT.z });
  }
  const frogRate = E.night * E.warm * (E.water > 0.03 ? 0.6 : 0) * (1 - E.rain * 0.5) * (0.3 + zn);
  if ((tFrog -= dt) <= 0) {
    tFrog = Math.max(0.25, exp(frogRate));
    if (frogRate > 0.01 && findTile(S, nearWater, 8)) A.play('frog', { x: PT.x, z: PT.z, vol: 0.5 + Math.random() * 0.5 });
  }
  // traffic pass-bys when zoomed in over busy roads (cars stop while paused)
  const busy = E.roads > 0 ? M.clamp(E.traffic * 1.6 + 0.08, 0, 1) : 0;
  const swooshRate = E.paused || zn < 0.45 ? 0 : busy * 3 * zn * Math.min(1, E.roads * 6);
  if ((tSwoosh -= dt) <= 0) {
    tSwoosh = Math.max(0.12, exp(swooshRate));
    if (swooshRate > 0.02 && findTile(S, isRoad, 8)) A.play('swoosh', { x: PT.x, z: PT.z, vol: 0.4 + busy * 0.6 });
  }
  const hornRate = E.paused ? 0 : (E.traffic > 0.45 ? 0.05 : 0.005) * busy * zn;
  if ((tHorn -= dt) <= 0) {
    tHorn = Math.max(4, exp(hornRate));
    if (hornRate > 0.001 && findTile(S, isRoad, 8)) A.play('horn', { x: PT.x, z: PT.z, vol: 0.5 });
  }
  const buildRate = E.build > 0 && !E.paused && zn > 0.45 ? Math.min(1, E.build / 2) * 0.8 : 0;
  if ((tBuild -= dt) <= 0) {
    tBuild = Math.max(0.4, exp(buildRate));
    if (buildRate > 0.01) A.play('construct', { x: E.bx, z: E.bz });
  }
  // thunder after a lightning flash (distance delay), or now and then in storms without flashes
  const w = S.weather || {};
  const L = w.lightning || 0;
  if (!AMB.thunderWarm && (w.type === 'storm' || L > 0)) { AMB.thunderWarm = true; A.warm(['thunder']); }
  if (L > 0.5 && lastLightning <= 0.5) thunderIn = 0.35 + Math.random() * 2.2;
  lastLightning = L;
  if (w.type === 'storm' && (tStorm -= dt) <= 0) { tStorm = 12 + Math.random() * 25; if (thunderIn < 0) thunderIn = 0.1; }
  if (thunderIn >= 0 && (thunderIn -= dt) < 0) {
    if (performance.now() - A.lastPlayed('thunder') > 2500) A.play('thunder', { vol: 0.55 + Math.random() * 0.45 });
  }
}

AMB.start = function () {
  AMB.on = true;
  AMB.env = E;
};
AMB.reset = function () {
  acc = 1; // resample immediately
  thunderIn = -1;
};
let lastT = 0;
AMB.update = function () {
  const S = VC.state;
  if (!AMB.on || !S || !VC.camera || !A.ctx) return;
  // real elapsed time (the frame dt is capped at 0.1 s, which would slow ambience on slow machines)
  const now = performance.now();
  const rdt = lastT ? Math.min(0.5, (now - lastT) / 1000) : 0.016;
  lastT = now;
  acc += rdt;
  fireAcc += rdt;
  if (fireAcc > 1) { fireAcc = 0; scanFires(S); }
  if (acc >= 0.35) {
    const step = acc;
    acc = 0;
    sampleEnv(S);
    computeTargets(S, step);
    applyTargets(step);
  }
  oneShots(S, rdt);
};
AMB.info = function () {
  const lv = {};
  for (const k in AMB.beds) lv[k] = +AMB.beds[k].level.toFixed(3) + (AMB.beds[k].src ? '' : ' (off)');
  return { env: { water: +E.water.toFixed(2), green: +E.green.toFixed(2), urban: +E.urban.toFixed(2), ind: +E.ind.toFixed(2), traffic: +E.traffic.toFixed(2), build: E.build }, beds: lv };
};
