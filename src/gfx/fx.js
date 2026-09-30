/*
 * VOXELPOLIS — weather, precipitation, lightning, disaster visuals and celebrations (VC.fx).
 * Layer 'fx': transparent order 700 (+ opaque/shadow passes for effect models).
 *
 * WEATHER STATE MACHINE (writes S.weather every frame):
 *   { type 'clear'|'cloudy'|'rain'|'storm'|'snow'|'fog', intensity 0..1, cloud 0..1, wet 0..1,
 *     fog 0..1, wind 0..1, windDir (radians, slow drift), lightning 0..1 (spike + decay) }
 *   FOLLOWS THE SIMULATION: the target type is VC.sim.weather().type (deterministic by seed and day), taken
 *   over whenever the current one has been on screen for DWELL real seconds (the sim's spells last a few
 *   game days = seconds at high speed, so the visuals low-pass them instead of flickering); wind speed /
 *   direction ease toward the sim's, and the sim's ground wetness is a floor for the visual one. Visual-only
 *   extra: morning fog on some spring/autumn days (setWeather('fog') for a foggy spell). Without VC.sim the
 *   module falls back to its own season-weighted random weather. setWeather() overrides for a while.
 *   Smooth ~15 s transitions of every parameter; winter turns rain into snow; wetness accumulates in rain
 *   and dries slowly (faster in summer sun). The reported type follows the rendered state (rain only once
 *   it is actually raining). VC.settings.weather === false -> clear, calm visuals (precipitation, fog and
 *   lightning off); the simulation keeps its own weather either way.
 * PRECIPITATION: GPU-only rain streaks / snowflakes (instanced, world-anchored wrapping volume around
 *   the camera target, wind-slanted, distance faded, lit by lightning) that stop at the first surface
 *   below them: a per-tile height texture (terrain, water, bridge decks and building roofs — the roof is the
 *   height most of the tile's voxel columns reach, from the building's model) kept up to date from bus
 *   events and polled around the camera. Rain-splash rings land on the ground, decks and roofs.
 * LIGHTNING: jagged branching bolts (camera-facing ribbons, HDR) for ~0.3 s with flicker, scene flash
 *   through S.weather.lightning, delayed 'thunder' sfx; VC.fx.lastBolt = {x, z, t} (the sky lights the
 *   clouds above it).
 * DISASTERS: gfx/fx_disasters.js (VC.fxDis) renders VC.disasters.active every frame.
 * CELEBRATIONS: gfx/fx_celebrate.js (VC.fxCel): fireworks, confetti, space-center rocket launches.
 *
 * WEBGL CONTEXT LOSS: while the context is lost update() keeps the weather state machine (CPU only) but skips the
 *   effect models (disasters / celebrations: no model builds). restore() (layer hook) re-uploads the shared model
 *   meshes (VC.fxgl.restoreModels), re-creates the precipitation / bolt VAOs + buffer, the tornado mesh
 *   (VC.fxDis.restore) and the precipitation floor texture (full upload on the next draw); programs relink by
 *   themselves, batches re-create their buffers on their next draw.
 *
 * API: setWeather(type | 'auto', instant), fireworks(x, z, n), confetti(x, z, n), launchRocket(b?),
 *      isLaunching(b), lightning(x, z), weatherInfo() -> {target, forced, nextInDays, precipKind, sim},
 *      lastBolt, stats, restore()
 */
const M = VC.M, C = VC.C;
/** Vector lengths without Math.hypot (V8's hypot allocates its argument list; these are on per-frame paths). */
const hyp = (x, z) => Math.sqrt(x * x + z * z);
const hyp3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
const TYPES = ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog'];
const WX = {
  clear: { cloud: 0.12, precip: 0, fog: 0, wind: 0.28 },
  cloudy: { cloud: 0.64, precip: 0, fog: 0.04, wind: 0.45 },
  rain: { cloud: 0.86, precip: 0.6, fog: 0.05, wind: 0.55 },
  storm: { cloud: 1.0, precip: 1.0, fog: 0.07, wind: 0.95 },
  snow: { cloud: 0.8, precip: 0.7, fog: 0.12, wind: 0.32 },
  fog: { cloud: 0.35, precip: 0, fog: 0.85, wind: 0.06 },
};
const SEASON_W = [
  { clear: 34, cloudy: 24, rain: 24, storm: 6, fog: 10 }, // spring
  { clear: 52, cloudy: 18, rain: 10, storm: 16, fog: 3 }, // summer
  { clear: 28, cloudy: 28, rain: 24, storm: 5, fog: 15 }, // autumn
  { clear: 28, cloudy: 30, snow: 34, fog: 8 }, // winter
];
const MAX_DROPS = { low: 3000, medium: 6000, high: 10000, ultra: 16000 };
const DWELL = 25; // minimum real seconds a visual weather type stays before following the sim again

let rnd = M.rng(5);
const W = {
  target: 'clear', forced: false, untilDay: 0, realLeft: 0,
  cloud: 0.2, precip: 0, fog: 0, wind: 0.4, windDir: 0.6, wet: 0, lightning: 0,
  pkind: 'rain', gust: 0, fast: 0, adopt: false,
};
const bolts = []; // active lightning bolts
let boltTimer = 4, thunder = [];

const FXL = (VC.fx = {
  name: 'fx',
  order: 700,
  stats: { drops: 0, bolts: 0, ms: 0 },

  init() {
    if (VC.fxModels) VC.fxModels.ensure();
    const G = VC.fxgl;
    FXL.batch = G.modelBatch(256);
    FXL.glows = G.glowBatch(512);
    initGL();
    VC.gfx.addLayer(FXL);
    // precipitation floor (roofs / decks / terrain) kept up to date from world events
    VC.fxgl.cells.init();
    VC.bus.on('dirty', (d) => roofMark(d.x0, d.z0, d.x1, d.z1));
    VC.bus.on('roadChange', (d) => roofMark(d.x, d.z, d.x, d.z));
    VC.bus.on('bldAdd', roofBld);
    VC.bus.on('bldRemove', roofBld);
    VC.bus.on('bldChange', roofBld);
    if (VC.fxCel && VC.fxCel.init) VC.fxCel.init();
    if (VC.fxDis && VC.fxDis.init) VC.fxDis.init();
  },

  reset(S) {
    rnd = VC.fxgl.rng((S.seed ^ 0x3e11) >>> 0);
    const w = S.weather || {};
    W.target = TYPES.indexOf(w.type) >= 0 ? w.type : 'clear';
    if (W.target === 'rain' && VC.fxgl.season(S) === 3) W.target = 'snow';
    W.forced = false;
    W.untilDay = S.time.day + 3 + Math.floor(rnd() * 6);
    W.realLeft = 30 + rnd() * 40;
    W.adopt = true; // first update: take over the simulation's weather (the sim resets after this module)
    const p = WX[W.target];
    W.cloud = w.cloud != null ? w.cloud : p.cloud;
    W.precip = w.intensity != null && p.precip > 0 ? w.intensity : p.precip;
    W.fog = w.fog != null ? w.fog : p.fog;
    W.wind = w.wind != null ? w.wind : p.wind;
    W.windDir = w.windDir != null ? w.windDir : rnd() * Math.PI * 2;
    W.wet = w.wet || 0;
    W.lightning = 0;
    W.pkind = W.target === 'snow' ? 'snow' : 'rain';
    bolts.length = 0;
    thunder.length = 0;
    FXL.lastBolt = null;
    writeWeather(S);
    roofReset(S);
    if (VC.fxDis && VC.fxDis.reset) VC.fxDis.reset(S);
    if (VC.fxCel && VC.fxCel.reset) VC.fxCel.reset(S);
  },

  update(dt, rdt) {
    const S = VC.state;
    if (!S) return;
    const t0 = performance.now();
    if (rdt > 0) {
      updateWeather(S, rdt);
      updateBolts(S, rdt);
      rainSplashes(S, rdt);
      fogPuffs(S, rdt);
    }
    // context lost: effect models are not rebuilt (they may build models, whose meshes could not be uploaded)
    if (VC.fxgl.lost()) { FXL.stats.ms = Math.round((performance.now() - t0) * 100) / 100; return; }
    FXL.batch.begin();
    FXL.glows.begin();
    if (VC.fxDis) VC.fxDis.update(dt, rdt, S, FXL.batch, FXL.glows);
    if (VC.fxCel) VC.fxCel.update(dt, rdt, S, FXL.batch, FXL.glows);
    boltGlows();
    if (rdt > 0) roofPoll(S, rdt);
    FXL.stats.ms = Math.round((performance.now() - t0) * 100) / 100;
  },

  shadow(ctx) {
    FXL.batch.draw(ctx, true);
  },
  opaque(ctx) {
    FXL.batch.draw(ctx, false);
  },
  /** WebGL context restored: every GL object of this layer is gone (see the header). */
  restore() {
    VC.fxgl.restoreModels();
    initBuffers();
    RF.tex = null; // (dead handle: never deleted) re-created with the whole floor by roofUpload
    if (VC.fxDis && VC.fxDis.restore) VC.fxDis.restore();
  },
  transparent(ctx) {
    if (VC.fxDis && VC.fxDis.drawTransparent) VC.fxDis.drawTransparent(ctx);
    drawPrecip(ctx);
    drawBolts(ctx);
    FXL.glows.draw(ctx);
  },

  /** Forces a weather type ('clear','cloudy','rain','storm','snow','fog'); 'auto' resumes random weather. */
  setWeather(type, instant) {
    const S = VC.state;
    if (!S) return false;
    if (type == null || type === 'auto') {
      W.forced = false; // back to the simulation's weather (taken over right away)
      W.untilDay = 0;
      W.realLeft = 0;
      return true;
    }
    if (!WX[type]) return false;
    W.target = type;
    W.forced = true;
    W.untilDay = S.time.day + 20;
    W.realLeft = 120;
    W.fast = 4;
    if (type === 'snow') W.pkind = W.precip < 0.05 || instant ? 'snow' : W.pkind;
    else if (type === 'rain' || type === 'storm') W.pkind = W.precip < 0.05 || instant ? 'rain' : W.pkind;
    if (instant) {
      const p = WX[type];
      W.cloud = p.cloud;
      W.precip = p.precip;
      W.fog = p.fog;
      W.wind = p.wind;
      W.pkind = type === 'snow' ? 'snow' : 'rain';
      if (type === 'rain' || type === 'storm') W.wet = Math.max(W.wet, 0.6);
      writeWeather(S);
    }
    return true;
  },
  weatherInfo() {
    const S = VC.state, sw = simWeather();
    return { target: W.target, forced: W.forced, nextInDays: S ? Math.max(0, W.untilDay - S.time.day) : 0, precipKind: W.pkind, sim: sw ? sw.type : null };
  },
  /** World position {x, z, t} of the latest lightning strike (null before the first), read by the sky. */
  lastBolt: null,
  fireworks(x, z, n = 20) {
    return VC.fxCel ? VC.fxCel.fireworks(x, z, n) : false;
  },
  confetti(x, z, n = 150) {
    return VC.fxCel ? VC.fxCel.confetti(x, z, n) : false;
  },
  launchRocket(b) {
    return VC.fxCel ? VC.fxCel.launch(b) : false;
  },
  /**
   * True while the building renderer must hide space_center b's static pad rocket: from lift-off, through
   * the empty-pad pause, until the replacement rocket (drawn here) has risen onto the pad in the same pose.
   */
  isLaunching(b) {
    return VC.fxCel ? VC.fxCel.isLaunching(b) : false;
  },
  /** World Y where rain / snow stops on tile (x, z): terrain, water, bridge deck or roof (debug / effects). */
  floorY(x, z) {
    const S = VC.state;
    if (!S || !RF.y || x < 0 || z < 0 || x >= RF.W || z >= RF.H) return C.SEA_Y;
    return RF.y[(z | 0) * RF.W + (x | 0)];
  },
  /** Launch phase of space_center b: null | 'count' | 'ignite' | 'lift' | 'reset' | 'rollout'. */
  launchPhase(b) {
    return VC.fxCel && VC.fxCel.launchPhase ? VC.fxCel.launchPhase(b) : null;
  },
  /** Triggers a lightning strike near (x, z) (debug / effects). */
  lightning(x, z) {
    const S = VC.state;
    if (S) spawnBolt(S, x, z);
  },
});

/* ------------------------------------------------------------------ */
/* Weather state machine                                                 */
/* ------------------------------------------------------------------ */
function pickNext(S) {
  const season = VC.fxgl.season(S);
  const w = SEASON_W[season];
  let tot = 0;
  for (const k in w) tot += w[k];
  let type = 'clear';
  for (let tries = 0; tries < 2; tries++) {
    let r = rnd() * tot;
    for (const k in w) if ((r -= w[k]) <= 0) { type = k; break; }
    if (type !== W.target) break; // mild bias against repeating
  }
  W.target = type;
  let days = 4 + rnd() * 12;
  if (type === 'storm') days *= 0.5;
  W.untilDay = S.time.day + Math.round(days);
  W.realLeft = 40 + rnd() * 70;
}

function morningFog(S) {
  const season = VC.fxgl.season(S);
  if (season !== 0 && season !== 2) return 0;
  if (M.hash(S.time.day, 17, S.seed) > 0.55) return 0;
  const t = S.time.tod;
  return M.smoothstep(0.17, 0.23, t) * (1 - M.smoothstep(0.3, 0.4, t)) * 0.5;
}

/**
 * The simulation's weather of the day ({type, cloud, wind, wet, windDir}) or null without VC.sim. It only
 * changes with the day, so it is fetched once per day (VC.sim.weather() returns a fresh object per call).
 */
let swCache = null, swDay = -1, swState = null;
function simWeather() {
  const sim = VC.sim, S = VC.state;
  if (!sim || typeof sim.weather !== 'function' || !S) return null;
  const day = S.time.day;
  if (day === swDay && S === swState) return swCache;
  try {
    const w = sim.weather();
    swCache = w && w.type ? w : null;
  } catch (e) {
    swCache = null;
  }
  swDay = day;
  swState = S;
  return swCache;
}
/** Visual type for the sim's weather (fog is visual only: mornings, see morningFog, or setWeather('fog')). */
function simTarget(S, sw) {
  return WX[sw.type] ? sw.type : 'clear';
}

function updateWeather(S, rdt) {
  const enabled = !VC.settings || VC.settings.weather !== false;
  const sw = simWeather();
  W.realLeft -= rdt;
  if (W.forced && S.time.day >= W.untilDay && W.realLeft <= 0) {
    W.forced = false;
    W.realLeft = 0;
  }
  if (W.adopt && sw) {
    // new game / load: start on the simulation's weather (snapping to it unless the saved look already shows it)
    W.adopt = false;
    const t = simTarget(S, sw);
    if (enabled && t !== W.target) {
      const p0 = WX[t];
      W.target = t;
      W.cloud = p0.cloud; W.precip = p0.precip; W.fog = p0.fog; W.wind = p0.wind;
      W.pkind = t === 'snow' ? 'snow' : 'rain';
    }
    W.wet = Math.max(W.wet, enabled ? M.clamp(sw.wet, 0, 1) * 0.8 : 0);
    if (isFinite(sw.windDir)) W.windDir = sw.windDir;
    W.realLeft = DWELL;
  }
  if (!enabled) {
    W.target = 'clear';
  } else if (!W.forced) {
    if (sw) {
      // follow the simulation, but hold each look for DWELL real seconds (no flicker at high game speed)
      const t = simTarget(S, sw);
      if (t !== W.target && W.realLeft <= 0) {
        W.target = t;
        W.realLeft = DWELL;
      }
    } else if (S.time.day >= W.untilDay && W.realLeft <= 0) pickNext(S); // no simulation: own random weather
  }
  const season = VC.fxgl.season(S);
  // winter precipitation falls as snow, otherwise as rain
  let tgt = W.target;
  if (season === 3 && (tgt === 'rain' || tgt === 'storm') && !W.forced) tgt = W.target = 'snow';
  if (season !== 3 && tgt === 'snow' && !W.forced) tgt = W.target = 'rain';
  const p = WX[tgt];
  const wantKind = tgt === 'snow' ? 'snow' : 'rain';
  if (W.pkind !== wantKind && W.precip < 0.04) W.pkind = wantKind;
  const precipTarget = W.pkind === wantKind ? p.precip : 0;
  if (W.fast > 0) W.fast -= rdt;
  const rate = !enabled ? 1.5 : W.fast > 0 ? 0.5 : 0.14;
  // (exponential easing written inline: this runs every frame, no boxed doubles through helper calls)
  const kr = Math.exp(-rate * rdt);
  W.cloud = p.cloud + (W.cloud - p.cloud) * kr;
  W.precip = precipTarget + (W.precip - precipTarget) * (W.precip > precipTarget ? Math.exp(-rate * 1.4 * rdt) : kr);
  if (W.precip < 0.003 && precipTarget === 0) W.precip = 0;
  const fogT = enabled ? Math.max(p.fog, morningFog(S)) : 0;
  W.fog = fogT + (W.fog - fogT) * Math.exp(-rate * 0.8 * rdt);
  // wind: base (between the look's and the simulation's) + slow gusts; direction eases toward the sim's
  W.gust += rdt;
  const gust = 0.12 * Math.sin(W.gust * 0.37) * Math.sin(W.gust * 0.11 + 1.3) + (tgt === 'storm' ? 0.08 * Math.sin(W.gust * 1.7) : 0);
  const sww = sw ? (sw.wind < 0 ? 0 : sw.wind > 1 ? 1 : sw.wind) : 0;
  const base = sw && enabled && !W.forced ? (p.wind + sww) * 0.5 : p.wind;
  let windT = base + gust;
  windT = windT < 0 ? 0 : windT > 1 ? 1 : windT;
  W.wind = windT + (W.wind - windT) * Math.exp(-0.3 * rdt);
  if (sw && isFinite(sw.windDir)) W.windDir = M.dampAngle(W.windDir, sw.windDir, 0.08, rdt) + Math.sin(W.gust * 0.05) * 0.01 * rdt;
  else W.windDir += (Math.sin(W.gust * 0.05) * 0.02 + (rnd() - 0.5) * 0.01) * rdt;
  // wetness: rain soaks, sun dries; the simulation's ground wetness (recent rainy days) is a floor
  const env = VC.gfx.env || {};
  if (W.pkind === 'rain' && W.precip > 0.05) W.wet = Math.min(1, W.wet + W.precip * 0.06 * rdt);
  else {
    const sun = 1 - (env.night || 0);
    const dry = 0.003 + 0.008 * sun * (1 - W.cloud) + (season === 1 ? 0.005 : 0);
    W.wet = Math.max(0, W.wet - dry * rdt);
  }
  if (sw && enabled && !W.forced) {
    const floor = M.clamp(sw.wet, 0, 1) * 0.8;
    if (W.wet < floor) W.wet = M.damp(W.wet, floor, 0.05, rdt);
  }
  // lightning flash decay
  W.lightning = Math.max(0, W.lightning - rdt * 4);
  writeWeather(S);
}

function writeWeather(S) {
  const w = S.weather || (S.weather = {});
  let type;
  if (W.precip > 0.12) type = W.pkind === 'snow' ? 'snow' : W.target === 'storm' && W.precip > 0.5 ? 'storm' : 'rain';
  else if (W.fog > 0.45) type = 'fog';
  else if (W.cloud > 0.45) type = 'cloudy';
  else type = 'clear';
  w.type = type;
  w.intensity = type === 'fog' ? W.fog : type === 'cloudy' ? W.cloud : type === 'clear' ? 0 : W.precip;
  w.cloud = W.cloud;
  w.wet = W.wet;
  w.fog = W.fog;
  w.wind = W.wind;
  w.windDir = W.windDir;
  w.lightning = W.lightning;
}

/* ------------------------------------------------------------------ */
/* Lightning                                                             */
/* ------------------------------------------------------------------ */
const SEG = 8; // floats per segment: x0 y0 z0 x1 y1 z1 width intensity
function spawnBolt(S, x, z) {
  const cam = VC.camera;
  if (x == null) {
    const a = rnd() * Math.PI * 2, r = 8 + rnd() * 70;
    x = cam.tx + Math.cos(a) * r;
    z = cam.tz + Math.sin(a) * r;
  }
  const gy = VC.fxgl.surfaceY(M.clamp(x, 0, S.W - 1), M.clamp(z, 0, S.H - 1));
  // strike the tallest building nearby if there is one
  let hitY = gy;
  const b = VC.world.inb(Math.floor(x), Math.floor(z)) ? VC.world.buildingAt(Math.floor(x), Math.floor(z)) : null;
  if (b) hitY = gy + (b.hgt || 1);
  const top = hitY + 40 + rnd() * 20;
  const seg = new Float32Array(SEG * 90);
  let n = 0;
  const add = (x0, y0, z0, x1, y1, z1, w, k) => {
    if (n >= 90) return;
    const o = n++ * SEG;
    seg[o] = x0; seg[o + 1] = y0; seg[o + 2] = z0; seg[o + 3] = x1; seg[o + 4] = y1; seg[o + 5] = z1; seg[o + 6] = w; seg[o + 7] = k;
  };
  const N = 26;
  let px = x + (rnd() - 0.5) * 12, pz = z + (rnd() - 0.5) * 12, py = top;
  const main = [];
  for (let k = 1; k <= N; k++) {
    const t = k / N;
    const tx = M.lerp(px, x, 0.25 + t * 0.75), tz = M.lerp(pz, z, 0.25 + t * 0.75);
    const nx = k === N ? x : tx + (rnd() - 0.5) * 2.4 * (1 - t * 0.6);
    const nz = k === N ? z : tz + (rnd() - 0.5) * 2.4 * (1 - t * 0.6);
    const ny = k === N ? hitY : top + (hitY - top) * t + (rnd() - 0.5) * 0.8;
    add(px, py, pz, nx, ny, nz, 0.16, 1);
    main.push([nx, ny, nz]);
    px = nx; py = ny; pz = nz;
  }
  for (let b2 = 0; b2 < 4; b2++) {
    const start = main[3 + Math.floor(rnd() * (N - 10))];
    let bx = start[0], by = start[1], bz = start[2];
    const dx = rnd() - 0.5, dz = rnd() - 0.5;
    const L = 5 + Math.floor(rnd() * 7);
    for (let k = 0; k < L; k++) {
      const nx = bx + dx * 2.2 + (rnd() - 0.5) * 1.6, nz = bz + dz * 2.2 + (rnd() - 0.5) * 1.6, ny = by - 0.8 - rnd() * 1.6;
      add(bx, by, bz, nx, ny, nz, 0.07 * (1 - k / L) + 0.02, 0.55 * (1 - k / L));
      bx = nx; by = ny; bz = nz;
    }
  }
  const dist = hyp(x - cam.tx, z - cam.tz) + cam.dist * 0.4;
  const strength = M.clamp(1.25 - dist / 160, 0.25, 1);
  bolts.push({ seg, n, age: 0, life: 0.34, x, z, gy: hitY, top, strength });
  const lb = FXL.lastBolt || (FXL.lastBolt = { x: 0, z: 0, t: 0 });
  lb.x = x; lb.z = z; lb.t = VC.gfx.time;
  thunder.push({ t: 0.35 + dist / 45, x, z, vol: strength });
  if (VC.particles && dist < 90) {
    VC.particles.burst('spark', x, hitY + 0.1, z, 16, { spread: 3 });
    VC.particles.burst('flash', x, hitY + 0.3, z, 1, { color: [3, 3.5, 5] });
  }
}
function flicker(t) {
  if (t < 0.05) return 1;
  if (t < 0.09) return 0.25;
  if (t < 0.15) return 0.95;
  if (t < 0.2) return 0.4;
  return Math.max(0, 0.8 - (t - 0.2) * 5.5);
}
function updateBolts(S, rdt) {
  const storm = W.target === 'storm' && W.precip > 0.55 && (!VC.settings || VC.settings.weather !== false);
  if (storm) {
    boltTimer -= rdt;
    if (boltTimer <= 0) {
      boltTimer = 1.8 + rnd() * 6.5;
      spawnBolt(S);
      if (rnd() < 0.3) boltTimer = 0.25; // double strike
    }
  }
  let L = 0;
  for (let k = bolts.length - 1; k >= 0; k--) {
    const b = bolts[k];
    b.age += rdt;
    if (b.age >= b.life) { bolts.splice(k, 1); continue; }
    L = Math.max(L, flicker(b.age) * b.strength);
  }
  if (L > W.lightning) {
    W.lightning = L;
    S.weather.lightning = L;
  }
  for (let k = thunder.length - 1; k >= 0; k--) {
    const th = thunder[k];
    th.t -= rdt;
    if (th.t <= 0) {
      thunder.splice(k, 1);
      VC.bus.emit('sfx', { name: 'thunder', x: th.x, z: th.z, vol: th.vol });
    }
  }
  FXL.stats.bolts = bolts.length;
}
function boltGlows() {
  const G = FXL.glows;
  for (const b of bolts) {
    const f = flicker(b.age);
    G.add(b.x, b.gy + 0.4, b.z, 5, 0.7, 0.8, 1, f * 3 * b.strength, 0, 0, 1, 0.3);
    G.add(b.x, b.top, b.z, 18, 0.6, 0.7, 1, f * 1.2 * b.strength, 0, 0, 1, 0.1);
    G.add(b.x, b.gy + 0.03, b.z, 6, 0.7, 0.8, 1, f * 1.5 * b.strength, 1, 0, 1, 0);
  }
}

/* ------------------------------------------------------------------ */
/* Rain splashes                                                         */
/* ------------------------------------------------------------------ */
const SPL = { vx: 0, vy: 0, vz: 0, size: null }; // reused emit options
function rainSplashes(S, rdt) {
  if (!VC.particles || W.pkind !== 'rain' || W.precip < 0.1) return;
  const cam = VC.camera;
  if (cam.dist > 90) return;
  const ext = M.clamp(cam.dist * 0.5, 6, 30);
  let n = W.precip * 70 * rdt;
  while (n > 0 && (n >= 1 || rnd() < n)) {
    n -= 1;
    const x = cam.tx + (rnd() * 2 - 1) * ext, z = cam.tz + (rnd() * 2 - 1) * ext;
    if (x < 0 || z < 0 || x >= S.W || z >= S.H) continue;
    const ly = landingY(S, x, z); // roofs (exact voxel column), yards, bridge decks, ground, water
    if (ly < 0) continue; // building whose model is not built yet
    const y = ly + 0.01;
    SPL.vx = 0; SPL.vy = 0; SPL.vz = 0; SPL.size = null;
    VC.particles.emit('rainsplash', x, y, z, SPL);
    if (rnd() < 0.3) {
      SPL.vx = (rnd() - 0.5) * 0.6; SPL.vy = 0.9 + rnd() * 0.6; SPL.vz = (rnd() - 0.5) * 0.6; SPL.size = 0.02;
      VC.particles.emit('splash', x, y + 0.02, z, SPL);
    }
  }
}

/** Low drifting fog banks near the ground (and hugging water) when the fog is thick. */
let fogAcc = 0;
function fogPuffs(S, rdt) {
  const Pt = VC.particles;
  if (!Pt || W.fog < 0.3) return;
  const cam = VC.camera;
  if (cam.dist > 110) return;
  fogAcc = Math.min(6, fogAcc + (W.fog - 0.25) * 10 * rdt);
  const ext = M.clamp(cam.dist * 0.7, 12, 50);
  while (fogAcc >= 1) {
    fogAcc -= 1;
    const x = cam.tx + (rnd() * 2 - 1) * ext, z = cam.tz + (rnd() * 2 - 1) * ext;
    const y = VC.fxgl.surfaceY(M.clamp(x, 0, S.W - 1), M.clamp(z, 0, S.H - 1)) + 0.3 + rnd() * 0.8;
    Pt.emit('fog', x, y, z, { vx: 0, vy: 0, vz: 0, size: 1.6 + rnd() * 2.2, alpha: 0.12 + W.fog * 0.12 });
  }
}

/* ------------------------------------------------------------------ */
/* Precipitation floor: where rain / snow stops                          */
/* ------------------------------------------------------------------ */
/*
 * RF.y[i] = world Y of the first surface a drop meets on tile i: terrain top, the water surface, a bridge
 * deck, or a building's roof there. A roof is the height that at least ~40 % of the tile's voxel columns
 * reach in the building's model (so a thin mast or a low wall does not stop the rain over a whole lot),
 * scaled by the construction reveal. Mirrored into an R32F texture (RF.tex) sampled by the precipitation
 * vertex shader. Updated incrementally: bus 'dirty' / roadChange / bld* events mark tile rects (recomputed
 * within a per-frame tile budget); models appear later (built by the building renderer in its budget) and
 * sites rise, so buildings around the camera are re-checked twice a second while it rains or snows.
 * Models are only read when already built (VC.fxgl.cachedModel), never built here.
 */
const RF = { y: null, W: 0, H: 0, tex: null, texW: 0, texH: 0, cx0: 0, cz0: 0, cx1: -1, cz1: -1, ux0: 0, uz0: 0, ux1: -1, uz1: -1, pollT: 0, pollN: 0, pollI: 0, near: [], colT0: 0 };
const ROOF_BUDGET = 3072, ROOF_BUDGET_DRY = 1024; // tiles recomputed per frame (while precipitating / not)
const C4 = [1, 0, -1, 0], S4 = [0, 1, 0, -1]; // cos / sin of rot * 90 deg (exact)
const colMemo = new WeakMap(); // model -> {cols: top voxel + 1 per column, tiles: roof height per model tile, tx, tz}
const colScratch = new Int32Array(1024);

function roofReset(S) {
  RF.W = S.W;
  RF.H = S.H;
  if (!RF.y || RF.y.length !== S.N) RF.y = new Float32Array(S.N);
  // start from the bare terrain everywhere (cheap), then let the budgeted pass add the buildings
  for (let i = 0; i < S.N; i++) RF.y[i] = groundTop(S, i);
  RF.cx0 = 0; RF.cz0 = 0; RF.cx1 = S.W - 1; RF.cz1 = S.H - 1;
  RF.ux0 = 0; RF.uz0 = 0; RF.ux1 = S.W - 1; RF.uz1 = S.H - 1;
  RF.pollT = 0;
  RF.pollN = 0;
  RF.near.length = 0;
}
/** Marks a tile rect for recomputation (clamped, coalesced into one pending rect). */
function roofMark(x0, z0, x1, z1) {
  if (!RF.y) return;
  x0 = Math.max(0, Math.min(x0, x1) | 0); z0 = Math.max(0, Math.min(z0, z1) | 0);
  x1 = Math.min(RF.W - 1, Math.max(x0, x1) | 0); z1 = Math.min(RF.H - 1, Math.max(z0, z1) | 0);
  if (x1 < x0 || z1 < z0) return;
  if (RF.cx1 < RF.cx0 || RF.cz1 < RF.cz0) { RF.cx0 = x0; RF.cz0 = z0; RF.cx1 = x1; RF.cz1 = z1; return; }
  RF.cx0 = Math.min(RF.cx0, x0); RF.cz0 = Math.min(RF.cz0, z0);
  RF.cx1 = Math.max(RF.cx1, x1); RF.cz1 = Math.max(RF.cz1, z1);
}
function roofBld(b) {
  if (b && b.x != null) roofMark(b.x, b.z, b.x + b.w - 1, b.z + b.d - 1);
}
function upMark(x0, z0, x1, z1) {
  if (RF.ux1 < RF.ux0 || RF.uz1 < RF.uz0) { RF.ux0 = x0; RF.uz0 = z0; RF.ux1 = x1; RF.uz1 = z1; return; }
  RF.ux0 = Math.min(RF.ux0, x0); RF.uz0 = Math.min(RF.uz0, z0);
  RF.ux1 = Math.max(RF.ux1, x1); RF.uz1 = Math.max(RF.uz1, z1);
}
function deckY() {
  const T = VC.terrain;
  return T && T.DECK_Y != null ? T.DECK_Y : C.SEA_Y + 0.37;
}
/** Terrain / water / bridge-deck top of tile i. */
function groundTop(S, i) {
  const h = S.height[i];
  if (h < C.SEA) return S.road[i] ? deckY() : C.SEA_Y;
  return h * C.STEP;
}
/** Visible fraction of a building's model (construction reveal, like the building renderer). */
function revealOf(b) {
  const bt = b.built == null ? 1 : b.built;
  if (bt >= 1) return 1;
  if (b.simReplay) return M.clamp(bt, 0, 1);
  return M.clamp((bt - 0.3) / 0.7, 0, 1);
}
/**
 * Column tops + per-tile roof heights of a model (memoized per model). New ones are computed within a
 * per-frame time budget (RF.colT0 set by roofPoll); null when over budget (callers retry later).
 */
const COL_BUDGET_MS = 1.5;
function colInfo(m) {
  let c = colMemo.get(m);
  if (c) return c;
  if (performance.now() - RF.colT0 > COL_BUDGET_MS) return null;
  const g = m.grid, sx = g.sx, sy = g.sy, sz = g.sz, v = g.v;
  const cols = new Uint16Array(sx * sz);
  for (let z = 0; z < sz; z++)
    for (let x = 0; x < sx; x++) {
      let top = 0;
      for (let y = sy - 1; y >= 0; y--) if (v[x + sx * (z + sz * y)]) { top = y + 1; break; }
      cols[z * sx + x] = top;
    }
  const ts = Math.max(1, Math.round(1 / m.vox));
  const tx = Math.ceil(sx / ts), tz = Math.ceil(sz / ts);
  const tiles = new Float32Array(tx * tz);
  for (let mz = 0; mz < tz; mz++)
    for (let mx = 0; mx < tx; mx++) {
      let n = 0;
      for (let z = mz * ts; z < Math.min(sz, (mz + 1) * ts); z++)
        for (let x = mx * ts; x < Math.min(sx, (mx + 1) * ts); x++) if (n < colScratch.length) colScratch[n++] = cols[z * sx + x];
      const a = colScratch.subarray(0, n).sort();
      tiles[mz * tx + mx] = n ? a[Math.floor(n * 0.6)] * m.vox : 0;
    }
  c = { cols, tiles, tx, tz, sx, sz };
  colMemo.set(m, c);
  return c;
}
/**
 * Model-local position of world point (wx, wz) for building b (inverse of VC.models.localToWorld), written
 * to RQ = [x, z] in voxels.
 */
const RQ = [0, 0];
function toLocal(b, m, wx, wz) {
  const r = b.rot & 3, c = C4[r], s = S4[r];
  const dx = wx - (b.x + b.w * 0.5), dz = wz - (b.z + b.d * 0.5);
  RQ[0] = (dx * c - dz * s) / m.vox + m.sx * 0.5;
  RQ[1] = (dx * s + dz * c) / m.vox + m.sz * 0.5;
  return RQ;
}
/** Roof height of building b over tile (x, z), or -1 when unknown (model not built yet / not revealed). */
function bldTileTop(b, x, z) {
  const m = VC.fxgl.cachedModel(b);
  if (!m || !m.grid) return -1;
  const rv = revealOf(b);
  if (rv <= 0) return -1;
  const ci = colInfo(m);
  if (!ci) return -1;
  toLocal(b, m, x + 0.5, z + 0.5);
  const ts = Math.max(1, Math.round(1 / m.vox));
  const mx = Math.floor(RQ[0] / ts), mz = Math.floor(RQ[1] / ts);
  if (mx < 0 || mz < 0 || mx >= ci.tx || mz >= ci.tz) return -1;
  return VC.world.topY(b.x, b.z) + ci.tiles[mz * ci.tx + mx] * rv;
}
/** Exact surface under world point (x, z) on building b's lot (roof or yard), or -1 when unknown. */
function bldPointTop(b, x, z) {
  const m = VC.fxgl.cachedModel(b);
  if (!m || !m.grid) return -1;
  const ci = colInfo(m);
  if (!ci) return -1;
  toLocal(b, m, x, z);
  const lx = Math.floor(RQ[0]), lz = Math.floor(RQ[1]);
  if (lx < 0 || lz < 0 || lx >= ci.sx || lz >= ci.sz) return -1;
  return VC.world.topY(b.x, b.z) + ci.cols[lz * ci.sx + lx] * m.vox * revealOf(b);
}
function tileTop(S, x, z) {
  const i = z * S.W + x;
  let y = groundTop(S, i);
  const id = S.bld[i];
  if (id) {
    const b = S.buildings.get(id);
    if (b) {
      const t = bldTileTop(b, x, z);
      if (t > y) y = t;
    }
  }
  return y;
}
/** Budgeted recomputation of the pending rect + (while precipitating) re-checks of nearby buildings. */
function roofPoll(S, rdt) {
  if (!RF.y || RF.W !== S.W || RF.H !== S.H) roofReset(S);
  RF.colT0 = performance.now();
  let budget = W.precip >= 0.01 ? ROOF_BUDGET : ROOF_BUDGET_DRY;
  while (RF.cx1 >= RF.cx0 && RF.cz1 >= RF.cz0 && budget > 0) {
    const z = RF.cz0;
    for (let x = RF.cx0; x <= RF.cx1; x++) RF.y[z * S.W + x] = tileTop(S, x, z);
    upMark(RF.cx0, z, RF.cx1, z);
    budget -= RF.cx1 - RF.cx0 + 1;
    RF.cz0++;
  }
  if (W.precip < 0.01) { RF.near.length = 0; RF.pollN = 0; return; }
  const cells = VC.fxgl.cells;
  if (!RF.pollN) {
    RF.pollT -= rdt;
    if (RF.pollT > 0) return;
    RF.pollT = 0.5;
    // models that became available, sites that rose: rewrite those footprints (sliced over frames)
    const cam = VC.camera;
    cells.sync();
    const R = M.clamp(cam.dist * 0.55, 8, 42) + 4;
    RF.pollN = cells.near(cam.tx, cam.tz, R, RF.near);
    RF.pollI = 0;
  }
  const n = RF.pollN;
  let k = RF.pollI;
  for (; k < n; k++) {
    if ((k & 31) === 31 && performance.now() - RF.colT0 > 1.5) break; // frame budget: continue next frame
    const e = RF.near[k], b = e.b;
    const m = VC.fxgl.cachedModel(b);
    const rv = Math.round(revealOf(b) * 10);
    if (e.fxRoofM === m && e.fxRoofRv === rv) continue;
    if (m && m.grid && !colInfo(m)) continue; // column data not computed yet (frame budget): next poll
    e.fxRoofM = m;
    e.fxRoofRv = rv;
    const x1 = Math.min(S.W - 1, b.x + b.w - 1), z1 = Math.min(S.H - 1, b.z + b.d - 1);
    for (let z = Math.max(0, b.z); z <= z1; z++)
      for (let x = Math.max(0, b.x); x <= x1; x++) RF.y[z * S.W + x] = tileTop(S, x, z);
    upMark(Math.max(0, b.x), Math.max(0, b.z), x1, z1);
  }
  RF.pollI = k;
  if (k >= n) {
    RF.near.length = 0;
    RF.pollN = 0;
  }
}
/** Uploads the changed rows of the precipitation floor texture (call with a GL context, before drawing). */
function roofUpload(gl) {
  if (!RF.y) return null;
  if (!RF.tex || RF.texW !== RF.W || RF.texH !== RF.H) {
    if (RF.tex) gl.deleteTexture(RF.tex);
    RF.tex = VC.gfx.texture({ w: RF.W, h: RF.H, internal: gl.R32F, format: gl.RED, type: gl.FLOAT, filter: gl.NEAREST, data: RF.y });
    RF.texW = RF.W;
    RF.texH = RF.H;
    RF.ux1 = -1;
    return RF.tex;
  }
  if (RF.ux1 >= RF.ux0 && RF.uz1 >= RF.uz0) {
    gl.bindTexture(gl.TEXTURE_2D, RF.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const w = RF.ux1 - RF.ux0 + 1;
    for (let z = RF.uz0; z <= RF.uz1; z++) gl.texSubImage2D(gl.TEXTURE_2D, 0, RF.ux0, z, w, 1, gl.RED, gl.FLOAT, RF.y, z * RF.W + RF.ux0);
    RF.ux0 = 0; RF.uz0 = 0; RF.ux1 = -1; RF.uz1 = -1;
  }
  return RF.tex;
}
/** Surface a rain drop lands on at world (x, z): roof / yard of a building, bridge deck, ground or water. */
function landingY(S, x, z) {
  const i = Math.floor(z) * S.W + Math.floor(x);
  const id = S.bld[i];
  if (id) {
    const b = S.buildings.get(id);
    return b ? bldPointTop(b, x, z) : -1;
  }
  return VC.fxgl.surfaceY(x, z);
}

/* ------------------------------------------------------------------ */
/* GL: precipitation + bolts                                             */
/* ------------------------------------------------------------------ */
const PVS = `
uniform vec4 uBox;   // centre xyz, half extent
uniform vec4 uRain;  // box height, fall speed, time, streak length
uniform vec4 uWindV; // wind velocity xz, snow (0/1), intensity
uniform sampler2D uRoof; // per-tile precipitation floor (terrain / water / decks / roofs), world Y
out vec2 vUv; out float vA; out vec3 vWp;
void main(){
  float id = float(gl_InstanceID);
  vec3 h = vec3(hash11(id * 0.7131 + 0.13), hash11(id * 1.3717 + 4.1), hash11(id * 2.1113 + 7.7));
  float ext = uBox.w, Hh = uRain.x, t = uRain.z;
  bool snow = uWindV.z > 0.5;
  float speed = uRain.y * (0.8 + 0.4 * h.y);
  float fy = mod(h.y * 97.0 - t * speed, Hh);
  vec3 o = vec3(uBox.x - ext, uBox.y - Hh * 0.25, uBox.z - ext);
  vec2 drift = uWindV.xy * t;
  if (snow) drift += vec2(sin(t * 1.1 + h.z * 40.0), cos(t * 0.9 + h.x * 40.0)) * 0.45;
  vec2 xz = o.xz + mod(h.xz * 2.0 * ext * 13.0 + drift - o.xz, 2.0 * ext);
  vec3 head = vec3(xz.x, o.y + fy, xz.y);
  vec3 vel = normalize(vec3(uWindV.x, -speed, uWindV.y));
  vec2 q = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec3 toCam = uCamPos.xyz - head;
  float dc = length(toCam);
  vec3 wp;
  float w = max(0.01, dc * 0.0021);
  if (snow) {
    vec3 camR = vec3(uView[0][0], uView[1][0], uView[2][0]);
    vec3 camU = vec3(uView[0][1], uView[1][1], uView[2][1]);
    float s = (0.016 + 0.02 * h.z) + w * 0.45;
    wp = head + (camR * (q.x * 2.0 - 1.0) + camU * (q.y * 2.0 - 1.0)) * s;
  } else {
    vec3 side = normalize(cross(vel, toCam / max(dc, 1e-3)));
    wp = head - vel * q.y * uRain.w * (0.7 + 0.6 * h.z) + side * (q.x * 2.0 - 1.0) * w;
  }
  vUv = q * 2.0 - 1.0;
  // first surface below the drop (terrain, water, bridge deck, roof): no drops inside hills or buildings,
  // under bridges or falling on through roofs
  float ground = max(texelFetch(uRoof, ivec2(clamp(floor(head.xz), vec2(0.0), uMap.xy - 1.0)), 0).r, SEA_Y);
  float edge = (1.0 - smoothstep(ext * 0.6, ext, length(head.xz - uBox.xz))) * step(ground, head.y);
  float near = smoothstep(0.6, 2.5, dc);
  float vert = smoothstep(0.0, 1.5, fy) * (1.0 - smoothstep(Hh - 2.0, Hh, fy));
  vA = edge * near * vert * (0.55 + 0.45 * h.x) * uWindV.w;
  vWp = wp;
  gl_Position = uViewProj * vec4(wp, 1.0);
}`;
const PFS = `
in vec2 vUv; in float vA; in vec3 vWp;
uniform float uSnowF;
out vec4 fragColor;
void main(){
  float a;
  vec3 col;
  vec3 amb = uSkyAmb.rgb * 1.3 + uSunColor.rgb * uSunDir.w * 0.18 + vec3(0.9, 0.95, 1.0) * uMisc.z * 0.9;
  if (uSnowF > 0.5) {
    float r2 = dot(vUv, vUv);
    a = smoothstep(1.0, 0.0, r2) * 0.85;
    col = vec3(0.95, 0.97, 1.0) * (amb * 1.25 + 0.05);
  } else {
    a = (1.0 - vUv.x * vUv.x) * (1.0 - vUv.y * 0.5 - 0.5) * 0.32;
    col = vec3(0.62, 0.68, 0.78) * (amb + 0.03);
  }
  col = applyFog(col, vWp);
  fragColor = vec4(col, a * vA);
}`;
const BVS = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUK; // side -1..1, intensity
out vec2 vUK;
void main(){ vUK = aUK; gl_Position = uViewProj * vec4(aPos, 1.0); }`;
const BFS = `
in vec2 vUK;
uniform float uBright;
out vec4 fragColor;
void main(){
  float u = vUK.x;
  float core = exp(-u * u * 30.0) * 6.0 + exp(-u * u * 4.0) * 1.2;
  fragColor = vec4(vec3(0.72, 0.8, 1.0) * core * vUK.y * uBright, 0.0);
}`;
const GLR = {};
function initGL() {
  const G = VC.gfx;
  GLR.precip = G.program('fx_precip', PVS, PFS);
  GLR.bolt = G.program('fx_bolt', BVS, BFS);
  GLR.boltData = new Float32Array(6 * 5 * 90 * 4);
  initBuffers();
}
/** VAOs + bolt vertex buffer (init, and after a context restore: the program wrappers stay valid). */
function initBuffers() {
  const gl = VC.gfx.gl;
  GLR.emptyVao = gl.createVertexArray();
  GLR.boltVao = gl.createVertexArray();
  GLR.boltBuf = gl.createBuffer();
  gl.bindVertexArray(GLR.boltVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, GLR.boltBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
  gl.bindVertexArray(null);
}

function drawPrecip(ctx) {
  if (W.precip < 0.01 || (VC.settings && VC.settings.weather === false)) { FXL.stats.drops = 0; return; }
  const gl = ctx.gl, cam = ctx.cam;
  const qk = (VC.settings && VC.settings.quality) || 'high';
  const snow = W.pkind === 'snow';
  const n = Math.floor((MAX_DROPS[qk] || 8000) * W.precip * (snow ? 0.7 : 1));
  if (n <= 0) return;
  const ext = M.clamp(cam.dist * 0.55, 8, 42);
  const Hh = M.clamp(cam.dist * 0.6, 10, 36);
  gl.activeTexture(gl.TEXTURE1);
  const roofTex = roofUpload(gl);
  if (!roofTex) return;
  gl.bindTexture(gl.TEXTURE_2D, roofTex);
  gl.activeTexture(gl.TEXTURE0);
  const P = GLR.precip;
  P.use();
  gl.uniform1i(P.u.uRoof, 1);
  gl.disable(gl.CULL_FACE);
  const wa = W.windDir, ws = snow ? 0.4 + W.wind * 1.2 : 0.6 + W.wind * 3.5;
  gl.uniform4f(P.u.uBox, cam.tx, cam.ty, cam.tz, ext);
  gl.uniform4f(P.u.uRain, Hh, snow ? 1.1 : 13, VC.gfx.time % 1000, snow ? 0 : 0.55);
  gl.uniform4f(P.u.uWindV, Math.cos(wa) * ws, Math.sin(wa) * ws, snow ? 1 : 0, M.clamp(W.precip * 1.4, 0, 1));
  gl.uniform1f(P.u.uSnowF, snow ? 1 : 0);
  gl.bindVertexArray(GLR.emptyVao);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
  gl.bindVertexArray(null);
  FXL.stats.drops = n;
}

function drawBolts(ctx) {
  if (!bolts.length) return;
  const gl = ctx.gl, cam = ctx.cam;
  const d = GLR.boltData;
  let v = 0;
  const cx = cam.pos[0], cy = cam.pos[1], cz = cam.pos[2];
  for (const b of bolts) {
    const f = flicker(b.age) * (0.6 + 0.4 * b.strength);
    for (let k = 0; k < b.n; k++) {
      const o = k * SEG, s = b.seg;
      const x0 = s[o], y0 = s[o + 1], z0 = s[o + 2], x1 = s[o + 3], y1 = s[o + 4], z1 = s[o + 5];
      const w = s[o + 6] + hyp3(x0 - cx, y0 - cy, z0 - cz) * 0.002;
      const inten = s[o + 7] * f;
      // side vector = normalize(cross(dir, toCam))
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
      const tx = cx - x0, ty = cy - y0, tz = cz - z0;
      let sx = dy * tz - dz * ty, sy = dz * tx - dx * tz, sz = dx * ty - dy * tx;
      const l = hyp3(sx, sy, sz) || 1;
      sx = (sx / l) * w; sy = (sy / l) * w; sz = (sz / l) * w;
      if (v + 30 > d.length) break;
      const put = (x, y, z, u) => { d[v++] = x; d[v++] = y; d[v++] = z; d[v++] = u; d[v++] = inten; };
      put(x0 - sx, y0 - sy, z0 - sz, -1); put(x0 + sx, y0 + sy, z0 + sz, 1); put(x1 + sx, y1 + sy, z1 + sz, 1);
      put(x0 - sx, y0 - sy, z0 - sz, -1); put(x1 + sx, y1 + sy, z1 + sz, 1); put(x1 - sx, y1 - sy, z1 - sz, -1);
    }
  }
  if (!v) return;
  const P = GLR.bolt;
  P.use();
  gl.uniform1f(P.u.uBright, 1.0);
  gl.disable(gl.CULL_FACE);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.bindVertexArray(GLR.boltVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, GLR.boltBuf);
  gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW, 0, v);
  gl.drawArrays(gl.TRIANGLES, 0, v / 5);
  gl.bindVertexArray(null);
}
