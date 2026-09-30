/*
 * VOXELPOLIS — weather, precipitation, lightning, disaster visuals and celebrations (VC.fx).
 * Layer 'fx': transparent order 700 (+ opaque/shadow passes for effect models).
 *
 * WEATHER STATE MACHINE (writes S.weather every frame):
 *   { type 'clear'|'cloudy'|'rain'|'storm'|'snow'|'fog', intensity 0..1, cloud 0..1, wet 0..1,
 *     fog 0..1, wind 0..1, windDir (radians, slow drift), lightning 0..1 (spike + decay) }
 *   Season-weighted random weather lasting several game days (and at least ~40-110 real seconds),
 *   smooth ~15 s transitions of every parameter; winter turns rain into snow; morning fog on some
 *   spring/autumn days; wetness accumulates in rain and dries slowly (faster in summer sun).
 *   The reported type follows the rendered state (rain only once it is actually raining).
 *   VC.settings.weather === false -> clear skies.
 * PRECIPITATION: GPU-only rain streaks / snowflakes (instanced, world-anchored wrapping volume around
 *   the camera target, wind-slanted, distance faded, lit by lightning) + rain-splash particles.
 * LIGHTNING: jagged branching bolts (camera-facing ribbons, HDR) for ~0.3 s with flicker, scene flash
 *   through S.weather.lightning, delayed 'thunder' sfx.
 * DISASTERS: gfx/fx_disasters.js (VC.fxDis) renders VC.disasters.active every frame.
 * CELEBRATIONS: gfx/fx_celebrate.js (VC.fxCel): fireworks, confetti, space-center rocket launches.
 *
 * API: setWeather(type | 'auto', instant), fireworks(x, z, n), confetti(x, z, n), launchRocket(b?),
 *      isLaunching(b), lightning(x, z), weatherInfo() -> {target, forced, nextInDays, precipKind}, stats
 */
const M = VC.M, C = VC.C;
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

let rnd = M.rng(5);
const W = {
  target: 'clear', forced: false, untilDay: 0, realLeft: 0,
  cloud: 0.2, precip: 0, fog: 0, wind: 0.4, windDir: 0.6, wet: 0, lightning: 0,
  pkind: 'rain', gust: 0, fast: 0,
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
    if (VC.fxCel && VC.fxCel.init) VC.fxCel.init();
    if (VC.fxDis && VC.fxDis.init) VC.fxDis.init();
  },

  reset(S) {
    rnd = M.rng((S.seed ^ 0x3e11) >>> 0);
    const w = S.weather || {};
    W.target = TYPES.indexOf(w.type) >= 0 ? w.type : 'clear';
    if (W.target === 'rain' && VC.fxgl.season(S) === 3) W.target = 'snow';
    W.forced = false;
    W.untilDay = S.time.day + 3 + Math.floor(rnd() * 6);
    W.realLeft = 30 + rnd() * 40;
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
    writeWeather(S);
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
    }
    FXL.batch.begin();
    FXL.glows.begin();
    if (VC.fxDis) VC.fxDis.update(dt, rdt, S, FXL.batch, FXL.glows);
    if (VC.fxCel) VC.fxCel.update(dt, rdt, S, FXL.batch, FXL.glows);
    boltGlows();
    FXL.stats.ms = +(performance.now() - t0).toFixed(2);
  },

  shadow(ctx) {
    FXL.batch.draw(ctx, true);
  },
  opaque(ctx) {
    FXL.batch.draw(ctx, false);
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
      W.forced = false;
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
    const S = VC.state;
    return { target: W.target, forced: W.forced, nextInDays: S ? Math.max(0, W.untilDay - S.time.day) : 0, precipKind: W.pkind };
  },
  fireworks(x, z, n = 20) {
    return VC.fxCel ? VC.fxCel.fireworks(x, z, n) : false;
  },
  confetti(x, z, n = 150) {
    return VC.fxCel ? VC.fxCel.confetti(x, z, n) : false;
  },
  launchRocket(b) {
    return VC.fxCel ? VC.fxCel.launch(b) : false;
  },
  /** True while space_center b has its rocket in flight (renderers may hide the model's static pad rocket). */
  isLaunching(b) {
    return VC.fxCel ? VC.fxCel.isLaunching(b) : false;
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

function updateWeather(S, rdt) {
  const enabled = !VC.settings || VC.settings.weather !== false;
  W.realLeft -= rdt;
  if (!enabled) {
    W.target = 'clear';
  } else if (S.time.day >= W.untilDay && W.realLeft <= 0) {
    W.forced = false;
    pickNext(S);
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
  W.cloud = M.damp(W.cloud, p.cloud, rate, rdt);
  W.precip = M.damp(W.precip, precipTarget, W.precip > precipTarget ? rate * 1.4 : rate, rdt);
  if (W.precip < 0.003 && precipTarget === 0) W.precip = 0;
  W.fog = M.damp(W.fog, enabled ? Math.max(p.fog, morningFog(S)) : 0, rate * 0.8, rdt);
  // wind: base + slow gusts; direction drifts
  W.gust += rdt;
  const gust = 0.12 * Math.sin(W.gust * 0.37) * Math.sin(W.gust * 0.11 + 1.3) + (tgt === 'storm' ? 0.08 * Math.sin(W.gust * 1.7) : 0);
  W.wind = M.damp(W.wind, M.clamp(p.wind + gust, 0, 1), 0.3, rdt);
  W.windDir += (Math.sin(W.gust * 0.05) * 0.02 + (rnd() - 0.5) * 0.01) * rdt;
  // wetness
  const env = VC.gfx.env || {};
  if (W.pkind === 'rain' && W.precip > 0.05) W.wet = Math.min(1, W.wet + W.precip * 0.06 * rdt);
  else {
    const sun = 1 - (env.night || 0);
    const dry = 0.003 + 0.008 * sun * (1 - W.cloud) + (season === 1 ? 0.005 : 0);
    W.wet = Math.max(0, W.wet - dry * rdt);
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
  const dist = Math.hypot(x - cam.tx, z - cam.tz) + cam.dist * 0.4;
  const strength = M.clamp(1.25 - dist / 160, 0.25, 1);
  bolts.push({ seg, n, age: 0, life: 0.34, x, z, gy: hitY, top, strength });
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
    const i = Math.floor(z) * S.W + Math.floor(x);
    if (S.bld[i]) continue;
    const y = VC.fxgl.surfaceY(x, z) + 0.01;
    VC.particles.emit('rainsplash', x, y, z, { vx: 0, vy: 0, vz: 0 });
    if (rnd() < 0.3) VC.particles.emit('splash', x, y + 0.02, z, { vx: (rnd() - 0.5) * 0.6, vy: 0.9 + rnd() * 0.6, vz: (rnd() - 0.5) * 0.6, size: 0.02 });
  }
}

/* ------------------------------------------------------------------ */
/* GL: precipitation + bolts                                             */
/* ------------------------------------------------------------------ */
const PVS = `
uniform vec4 uBox;   // centre xyz, half extent
uniform vec4 uRain;  // box height, fall speed, time, streak length
uniform vec4 uWindV; // wind velocity xz, snow (0/1), intensity
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
  float edge = 1.0 - smoothstep(ext * 0.6, ext, length(head.xz - uBox.xz));
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
  const G = VC.gfx, gl = G.gl;
  GLR.precip = G.program('fx_precip', PVS, PFS);
  GLR.bolt = G.program('fx_bolt', BVS, BFS);
  GLR.emptyVao = gl.createVertexArray();
  GLR.boltVao = gl.createVertexArray();
  GLR.boltBuf = gl.createBuffer();
  GLR.boltData = new Float32Array(6 * 5 * 90 * 4);
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
  const P = GLR.precip;
  P.use();
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
      const w = s[o + 6] + Math.hypot(x0 - cx, y0 - cy, z0 - cz) * 0.002;
      const inten = s[o + 7] * f;
      // side vector = normalize(cross(dir, toCam))
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
      const tx = cx - x0, ty = cy - y0, tz = cz - z0;
      let sx = dy * tz - dz * ty, sy = dz * tx - dx * tz, sz = dx * ty - dy * tx;
      const l = Math.hypot(sx, sy, sz) || 1;
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
  gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, v), gl.DYNAMIC_DRAW);
  gl.drawArrays(gl.TRIANGLES, 0, v / 5);
  gl.bindVertexArray(null);
}
