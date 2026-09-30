/*
 * VOXELPOLIS — boot sequence, module lifecycle, main loop, settings, debug API.
 *
 * MODULE LIFECYCLE (any VC.<name> object in MODULE_ORDER may implement):
 *   init()          once at boot, after the WebGL context exists (in MODULE_ORDER)
 *   reset(S)        whenever a game starts or a save is loaded (state fully populated)
 *   update(dt, rdt) every frame. rdt = real seconds (<= 0.1). dt = rdt, or 0 while paused.
 * Renderers additionally register as layers with VC.gfx.addLayer (see gfx/core.js).
 */
const MODULE_ORDER = [
  'audio', 'camera', 'shadows', 'post', 'sky', 'terrain', 'water', 'bldgfx', 'agents', 'particles', 'fx',
  'worldgen', 'sim', 'econ', 'disasters', 'advisors', 'actions', 'tools', 'input', 'save',
  'ui', 'hud', 'panels', 'menu',
];
VC.MODULE_ORDER = MODULE_ORDER;
VC.errors = [];
window.addEventListener('error', (e) => {
  VC.errors.push(String(e.message) + ' @ ' + (e.filename || '') + ':' + (e.lineno || ''));
});
window.addEventListener('unhandledrejection', (e) => VC.errors.push('unhandled rejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));

/* ---------------- settings ---------------- */
VC.settings = Object.assign({}, VC.DEFAULT_SETTINGS);
try {
  const s = JSON.parse(localStorage.getItem('voxelpolis.settings') || 'null');
  if (s) Object.assign(VC.settings, s);
} catch (e) { /* storage unavailable (file:// in some browsers) */ }
VC.saveSettings = function () {
  try { localStorage.setItem('voxelpolis.settings', JSON.stringify(VC.settings)); } catch (e) { /* ignore */ }
  VC.bus.emit('settings', VC.settings);
};
VC.params = new URLSearchParams(location.search);

const failures = Object.create(null); // module name -> {msg, n}
function each(fn) {
  for (const name of MODULE_ORDER) {
    const m = VC[name];
    if (!m) continue;
    try {
      fn(m, name);
    } catch (e) {
      // log the first occurrence with its stack, then only count repeats (no console flood)
      const msg = `${name}: ${e && e.message}`;
      const f = failures[name];
      if (!f || f.msg !== msg) {
        console.error(`[main] module "${name}" failed:`, e);
        failures[name] = { msg, n: 1 };
        if (VC.errors.length < 200) VC.errors.push(msg);
      } else if (++f.n === 2 || f.n % 600 === 0) {
        const i = VC.errors.lastIndexOf(msg);
        if (i >= 0) VC.errors[i] = msg; // keep one entry; repeat count is in VC.debug.failures()
      }
    }
  }
}

/* ---------------- game start ---------------- */
/**
 * Starts a brand-new game. opts: { name, seed, size (tiles), mapType, difficulty, disasters }
 */
VC.newGame = function (opts = {}) {
  const seed = opts.seed != null ? opts.seed >>> 0 : (Math.random() * 4294967295) >>> 0;
  const S = VC.createState(Object.assign({}, opts, { seed }));
  if (opts.disasters === false) S.disastersEnabled = false;
  if (opts.demo) S.demo = true; // title-screen demo: set BEFORE any module sees the state
  VC.world.setState(S);
  VC.worldgen.generate(S, opts);
  VC.startState(S);
  VC.bus.emit('newGame', S);
  return S;
};
/** Installs a fully-populated state (new or loaded) and resets every module. */
VC.startState = function (S) {
  VC.world.setState(S);
  VC.world._dirty = null;
  each((m) => m.reset && m.reset(S));
  VC.world.markDirty(0, 0, S.W - 1, S.H - 1);
  VC.world.flush();
  VC.running = true;
  VC.bus.emit('started', S);
};
/** Current sim speed index (0 = paused). */
VC.speed = () => (VC.state ? VC.state.time.speed : 0);
VC.setSpeed = function (s) {
  if (!VC.state) return;
  VC.state.time.speed = VC.M.clamp(s | 0, 0, VC.C.SPEEDS.length - 1);
  VC.bus.emit('speed', VC.state.time.speed);
};
VC.togglePause = function () {
  const S = VC.state;
  if (!S) return;
  if (S.time.speed) { S.time.prevSpeed = S.time.speed; VC.setSpeed(0); }
  else VC.setSpeed(S.time.prevSpeed || 1);
};

/* ---------------- day/night clock ---------------- */
const todRate = (h) => 0.4 + 0.6 * VC.M.smoothstep(0.06, 0.35, h);
/** Normalisation so that one full cycle still takes C.DAYCYCLE_SEC on average (sun height ~ sin). */
const TOD_NORM = (() => {
  let acc = 0;
  const n = 2000;
  for (let i = 0; i < n; i++) acc += 1 / todRate(Math.abs(Math.sin(((i + 0.5) / n) * Math.PI * 2)));
  return acc / n;
})();

/* ---------------- main loop ---------------- */
let last = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const rdt = Math.min(0.1, Math.max(0, (t - (last || t)) / 1000));
  last = t;
  const S = VC.state;
  const dt = S && S.time.speed > 0 ? rdt : 0;
  if (S && VC.running && VC.settings.dayNight === 'cycle' && S.time.speed > 0) {
    // the clock slows near the horizon so golden hour / blue hour last; TOD_NORM keeps the cycle length
    const env = VC.gfx.env;
    const h = env && isFinite(env.sunUp) ? Math.abs(env.sunUp) : 1;
    S.time.tod = (S.time.tod + (rdt / VC.C.DAYCYCLE_SEC) * todRate(h) * TOD_NORM) % 1;
  }
  each((m) => m.update && m.update(dt, rdt));
  if (S) VC.world.flush();
  try {
    VC.gfx.render(dt, rdt);
  } catch (e) {
    if (!frame._err) console.error('[main] render failed', e);
    frame._err = true;
  }
}

/* ---------------- boot ---------------- */
/** Full-screen, human-readable boot failure (with copyable details). */
function showBootError(msg, err) {
  const el = document.getElementById('boot-error');
  if (!el) return;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const details = [
    'VOXELPOLIS ' + VC.VERSION,
    navigator.userAgent,
    'GPU: ' + ((VC.gfx && VC.gfx.caps && VC.gfx.caps.renderer) || 'unknown'),
    err ? String((err && err.message) || err).split('\n')[0] : '',
  ].filter(Boolean).join('\n');
  el.style.display = 'flex';
  el.innerHTML = `<div style="max-width:560px;padding:24px"><h1>VOXELPOLIS</h1><p>${esc(msg)}</p>
    <p style="opacity:.75">Please use a recent Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled.</p>
    <pre style="text-align:left;white-space:pre-wrap;font-size:12px;opacity:.6;background:#0006;padding:10px;border-radius:8px">${esc(details)}</pre></div>`;
  VC.bootFailed = true;
}
VC.showBootError = showBootError;

function boot() {
  const canvas = document.getElementById('gl');
  let ok = false;
  try {
    ok = VC.gfx.init(canvas);
  } catch (e) {
    console.error('[main] graphics init failed', e);
    showBootError('Graphics initialisation failed on this browser / GPU.', e);
    return;
  }
  if (!ok) {
    showBootError('Your browser does not support WebGL 2.');
    return;
  }
  each((m) => m.init && m.init());
  // graphics modules that failed to initialise leave the game half-rendered: tell the player once
  const gfxMods = ['shadows', 'post', 'sky', 'terrain', 'water', 'bldgfx', 'agents', 'particles', 'fx'];
  const bad = gfxMods.filter((n) => failures[n]);
  if (bad.length) {
    setTimeout(() => VC.bus.emit('toast', { text: 'Some graphics features failed on this browser/GPU (' + bad.join(', ') + '). Try Settings → Graphics quality: Low.', type: 'warn', icon: '⚠️' }), 1500);
  }
  VC.bus.emit('boot');
  const p = VC.params;
  if (p.has('autostart') || !VC.menu || !VC.menu.show) {
    VC.newGame({
      seed: p.has('seed') ? +p.get('seed') : 12345,
      size: p.has('size') ? +p.get('size') : VC.MAP_SIZES.medium,
      mapType: p.get('map') || 'river',
      difficulty: p.get('difficulty') || 'normal',
      name: p.get('name') || 'Voxelpolis',
    });
    if (p.has('city')) VC.debug.sampleCity({ grow: p.get('city') !== 'plan' });
  } else {
    VC.menu.show();
  }
  requestAnimationFrame(frame);
}
function safeBoot() {
  try {
    boot();
  } catch (e) {
    console.error('[main] boot failed', e);
    showBootError('VOXELPOLIS could not start on this browser.', e);
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeBoot);
else setTimeout(safeBoot, 0);

/* ------------------------------------------------------------------ */
/* Debug / test API (used by tools/shot.js and for development)         */
/* ------------------------------------------------------------------ */
VC.debug = {
  newGame(opts) {
    return VC.newGame(Object.assign({ seed: 12345, size: 128, mapType: 'river' }, opts));
  },
  /** Camera: world target (x,z), distance, yaw, pitch (radians). Snaps immediately. */
  cam(x, z, dist, yaw, pitch) {
    const g = VC.camera.goal;
    if (x != null) g.tx = x;
    if (z != null) g.tz = z;
    if (dist != null) g.dist = dist;
    if (yaw != null) g.yaw = yaw;
    if (pitch != null) g.pitch = pitch;
    VC.camera.snap();
  },
  /** Time of day 0..1 (0.5 noon, 0.75 sunset, 0.9 night). */
  tod(t) {
    VC.settings.dayNight = 'cycle';
    if (VC.state) VC.state.time.tod = t;
  },
  /** Fast-forward the simulation by n days (synchronously). */
  run(days) {
    if (!VC.sim || !VC.sim.tickDay) return 'no sim';
    const S = VC.state;
    const dis = VC.disasters && VC.disasters.update;
    const speed = S.time.speed;
    for (let i = 0; i < days; i++) {
      VC.sim.tickDay();
      if (dis) {
        // advance active disasters by one game day at speed 1 so they finish during fast-forward
        S.time.speed = 1;
        try { for (let k = 0; k < 10; k++) VC.disasters.update(0.1 * VC.C.DAY_SEC, 0.1 * VC.C.DAY_SEC); } catch (e) { /* keep running */ }
        S.time.speed = speed;
      }
    }
    VC.world.flush();
    return VC.state.stats;
  },
  failures() {
    return failures;
  },
  perf() {
    return { fps: Math.round(VC.gfx.fps), frameMs: +VC.gfx.frameMs.toFixed(2), res: [VC.gfx.rw, VC.gfx.rh], models: VC.models.stats, buildings: VC.state ? VC.state.buildings.size : 0 };
  },
  errors() {
    return VC.errors;
  },
  /**
   * Builds a sample city directly through the world API (bypasses costs).
   * opts: { cx, cz, blocks (per side, default 4), grow (instantly add buildings), seed }
   */
  sampleCity(opts = {}) {
    const S = VC.state, W = VC.world, C = VC.C;
    const r = VC.M.rng(opts.seed || 7);
    const blocks = opts.blocks || 4;
    const BS = 6; // road every 6 tiles -> 5x5 lots
    const span = blocks * BS + 1;
    // find a dry area near the center
    let cx = opts.cx, cz = opts.cz;
    if (cx == null) {
      let best = -1;
      for (let t = 0; t < 200; t++) {
        const x = r.int(4, S.W - span - 4), z = r.int(4, S.H - span - 4);
        let dry = 0, hs = 0;
        for (let zz = z; zz < z + span; zz += 2) for (let xx = x; xx < x + span; xx += 2) { const h = S.height[zz * S.W + xx]; if (h >= C.SEA + 1) { dry++; hs += h; } }
        const score = dry - Math.abs(x + span / 2 - S.W / 2) * 0.3 - Math.abs(z + span / 2 - S.H / 2) * 0.3;
        if (score > best) { best = score; cx = x; cz = z; }
      }
    }
    // flatten to the median dry level
    const hs = [];
    for (let zz = cz; zz < cz + span; zz++) for (let xx = cx; xx < cx + span; xx++) hs.push(S.height[zz * S.W + xx]);
    hs.sort((a, b) => a - b);
    const lvl = Math.max(C.SEA + 1, hs[hs.length >> 1]);
    for (let zz = cz; zz < cz + span; zz++) for (let xx = cx; xx < cx + span; xx++) {
      W.setHeight(xx, zz, lvl);
      W.setTrees(xx, zz, 0);
      W.setTerr(xx, zz, VC.TERR.GRASS);
    }
    for (let k = 0; k <= blocks; k++)
      for (let t = 0; t < span; t++) {
        const type = k === Math.floor(blocks / 2) ? VC.ROAD.AVENUE : VC.ROAD.STREET;
        W.setRoad(cx + k * BS, cz + t, type);
        W.setRoad(cx + t, cz + k * BS, type);
      }
    const placed = [];
    const place = (key, bx, bz) => {
      const def = VC.BLD[key];
      if (!W.areaFree(bx, bz, def.size[0], def.size[1])) return null;
      const b = W.addBuilding({ key, x: bx, z: bz, rot: Math.max(0, W.adjacentRoadDir(bx, bz, def.size[0], def.size[1])) }, { instant: true });
      b.powered = b.watered = true;
      placed.push(b);
      return b;
    };
    for (let bz = 0; bz < blocks; bz++)
      for (let bx = 0; bx < blocks; bx++) {
        const x0 = cx + bx * BS + 1, z0 = cz + bz * BS + 1;
        const d = Math.max(Math.abs(bx - (blocks - 1) / 2), Math.abs(bz - (blocks - 1) / 2));
        let zt = d < 1 ? 2 : bz === blocks - 1 ? 3 : 1;
        if (bx === 0 && bz === 0) { place('coal_plant', x0, z0); place('water_tower', x0 + 4, z0); continue; }
        if (bx === blocks - 1 && bz === 0) { place('police_station', x0, z0); place('fire_station', x0 + 3, z0); place('school', x0, z0 + 3); place('small_park', x0 + 3, z0 + 3); continue; }
        if (bx === 0 && bz === blocks - 1) { place('coal_plant', x0, z0); place('water_tower', x0 + 4, z0); place('water_tower', x0 + 4, z0 + 1); place('water_tower', x0 + 4, z0 + 2); place('clinic', x0, z0 + 3); continue; }
        const den = d < 1 ? 3 : d < 2 ? 2 : 1;
        for (let zz = z0; zz < z0 + 5; zz++) for (let xx = x0; xx < x0 + 5; xx++) W.setZone(xx, zz, VC.zcode(zt, den));
        if (opts.grow !== false) {
          for (let zz = z0; zz < z0 + 5; zz++)
            for (let xx = x0; xx < x0 + 5; xx++) {
              if (S.bld[zz * S.W + xx]) continue;
              const big = den >= 2 && r() < 0.5 && xx + 1 < x0 + 5 && zz + 1 < z0 + 5 && W.areaFree(xx, zz, 2, 2, { zone: VC.zcode(zt, den) });
              const s = big ? 2 : 1;
              const rot = W.adjacentRoadDir(xx, zz, s, s);
              const b = W.addBuilding({ key: 'grow', x: xx, z: zz, w: s, d: s, rot: rot < 0 ? r.int(0, 3) : rot, zt, den, level: r.int(1, 3), wealth: r.int(0, 2) }, { instant: true });
              b.powered = b.watered = true;
              b.pop = Math.round(((VC.GROW[VC.ZONES[zt].key][den].cap[b.level - 1]) || 5) * s * s * 0.8);
              placed.push(b);
            }
        }
      }
    W.flush();
    VC.debug.cam(cx + span / 2, cz + span / 2, span * 1.1);
    return { cx, cz, span, buildings: placed.length };
  },
};
