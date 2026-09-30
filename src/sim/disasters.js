/*
 * VOXELPOLIS — disasters (logic): fire outbreaks, tornadoes, meteors, earthquakes, UFOs, Cubezilla.
 * Visuals live in VC.fx, which renders every frame from VC.disasters.active.
 *
 * ACTIVE ENTRY (renderers read, never write). Common fields:
 *   id, type, name, icon
 *   x, z       world XZ of the disaster centre / creature / craft (tile units, fractional)
 *   y          world Y: ground under it, the meteor/UFO altitude for those types
 *   t          game-seconds alive (= game days x C.DAY_SEC; frozen while paused, faster at speed 3/8)
 *   rt         real seconds alive (only advances while unpaused)
 *   dir        heading in radians; motion direction on XZ is (cos dir, sin dir)
 *   radius     damage radius in tiles
 *   phase      type-specific string (see below)
 *   intensity  0..1 fade-in / fade-out envelope
 *   destroyed, burned  counters
 * Type-specific:
 *   fire        phase 'burning'; targets [building ids]; burning (count still on fire)
 *   tornado     phase 'active'; speed (tiles/day), traveled, length
 *   meteor      phase 'incoming' -> 'impact'; impactT (real s from start to impact); progress 0..1 of the
 *               fall; mx,my,mz current meteor world position; sx,sy,sz start; ix,iy,iz impact point;
 *               impactAt (rt of impact, then an ~6 s aftermath for dust/glow)
 *   earthquake  phase 'shaking'; magnitude (Richter); duration (real s); shake 0..1 current amplitude;
 *               fault {x0,z0,x1,z1} fissure line (world)
 *   ufo         phase 'arrive' | 'hover' | 'leave'; y altitude; beam 0..1; abducted (count);
 *               lifting {id, b, progress 0..1, x, z, y0, h, lift (current world Y offset)} | null.
 *               While lifting, the building also carries b.disLift (world Y offset) for the renderer.
 *   monster     phase 'enter' | 'rampage' | 'leave'; step (tiles walked, drives the walk cycle);
 *               stomp 0..1 (pulse on each footfall); roar 0..1 (pulse); breath {x, z, t} | null (atomic
 *               breath target, t = game days since it started)
 * Bus: 'disaster' {type, phase:'start'|'update'|'end', x, z, id, name, icon, entry, ...} (+ 'what' on
 * update: 'impact' | 'abduct' | 'breath'). On 'start', x/z is the point worth looking at (the UFO's
 * target area, not the map edge it flies in from); UIs that keep a "Show me" button should follow the
 * live entry: VC.disasters.focus({id}) / VC.disasters.get(id).
 *
 * NOTIFICATIONS (one domain event -> one notification + one sound): the start emits ONLY bus 'disaster'
 * (the HUD shows the alert card, audio plays alarm + the type's sound) — no toast, no start sfx. The end
 * is reported by one toast (bus 'toast', the summary). In-world sounds while a disaster runs (stomp,
 * explosion, abduct, ufo, roar) are spatial 'sfx'. Building removals use VC.REMOVE.DISASTER ('disaster';
 * particles + audio react to bus 'bldRemove' — no extra bursts here) and VC.REMOVE.ABDUCT ('abduct',
 * UFO: the building is beamed up, no debris). Fires are started through VC.sim.ignite(b, {disaster:true})
 * with b.fireCause = 'disaster' (cleared again when the fire ends) so sim does not toast each one.
 * Nothing random happens while S.demo (title-screen city).
 *
 * UFO targets: growables (taller / denser preferred); non-essential small parks/plazas/statues only as a
 * rare fallback. Never utilities (power/water), services, unique landmarks or big-ticket buildings.
 *
 * SAVE/LOAD: active entries are persisted through VC.save.register('disasters') (plain JSON: Sets become
 * arrays, building references become ids) and resume after loading.
 * Persistent stats: S.disasterStats (= VC.disasters.stats) {count, byType, survived, destroyed, abducted, nextDay, relief}.
 *
 * FAIRNESS: random disasters strike after FIRST_YEARS and then every GAP_YEARS (per difficulty); tornadoes,
 * meteors and Cubezilla need a big enough city (TYPE_MIN_POP). A random tornado's damage scales with the
 * city's size (e.sizeF) and stops at 5% of its buildings (e.cap); any tornado destroys at most 2 power /
 * water buildings. A random Cubezilla skips the far neighbourhood in cities under 20k and leaves once it has
 * flattened 6% (e.sated, phase 'leave'). (Disasters the player triggers are not capped.) When a RANDOM
 * disaster ends, the state pays relief: half the price of the public buildings lost + $50 per lost lot
 * (ledger 'relief'; the 'end' event and the summary toast carry it).
 * Random disasters need S.disastersEnabled && VC.settings.disasters !== false; flipping the Settings
 * toggle also flips S.disastersEnabled of the running city (one switch from the player's view).
 */
const M = VC.M, C = VC.C;

const TYPES = [
  { key: 'fire', name: 'Fire', icon: '🔥', desc: 'A major fire breaks out in a neighbourhood.' },
  { key: 'tornado', name: 'Tornado', icon: '🌪️', desc: 'A twister carves a path of destruction.' },
  { key: 'meteor', name: 'Meteor Strike', icon: '☄️', desc: 'A space rock leaves a smoking crater.' },
  { key: 'earthquake', name: 'Earthquake', icon: '🌋', desc: 'The ground shakes; buildings topple and burn.' },
  { key: 'ufo', name: 'UFO Invasion', icon: '🛸', desc: 'Visitors from beyond abduct your buildings.' },
  { key: 'monster', name: 'Cubezilla', icon: '🦖', desc: 'A giant voxel lizard stomps across town.' },
];
const TYPE = Object.create(null); // no prototype: trigger('toString') must not find anything
for (const t of TYPES) TYPE[t.key] = t;
// Relative odds of each random disaster (tornadoes in spring/summer, fires in summer, see seasonWeight).
const ODDS = { fire: 20, tornado: 20, meteor: 12, earthquake: 20, ufo: 11, monster: 11 };
const RANDOM_MIN_POP = 2000;
// the big ones only strike cities that can take them (random disasters; the Disasters window can still
// trigger anything)
const TYPE_MIN_POP = { tornado: 4000, meteor: 8000, monster: 15000 };
// years until the first random disaster of a city / between random disasters, per difficulty
const FIRST_YEARS = { easy: [5, 7], normal: [4, 5], hard: [3, 4] };
const GAP_YEARS = { easy: [5, 8], normal: [3, 5], hard: [3, 4] };
const RELIEF_SHARE = 0.5, RELIEF_PER_LOT = 50; // disaster relief: 50% of lost public buildings + $50 a lot
const YEAR = C.DAYS_PER_MONTH * 12;

let rnd = M.rng(1);
let seq = 0;
let lastGlobal = null; // last seen VC.settings.disasters (mirrored into S.disastersEnabled on change)
const seen = new Set(); // scratch for buildingsNear
const REASON = () => VC.REMOVE || { DISASTER: 'disaster', ABDUCT: 'abduct' };
const SET_FIELDS = ['hits', 'tiles']; // entry fields that are Sets (saved as arrays)

function S_() { return VC.state; }
function W_() { return VC.world; }
function stats() { return D.stats; }

/* ---------------- helpers ---------------- */
function bldDist(b, px, pz) {
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w));
  const dz = Math.max(b.z - pz, 0, pz - (b.z + b.d));
  return Math.hypot(dx, dz);
}
/** Buildings whose footprint lies within r tiles of (px,pz): [{b, d}] (d = footprint distance). */
function buildingsNear(px, pz, r, filter) {
  const S = S_();
  const out = [];
  seen.clear();
  const x0 = Math.max(0, Math.floor(px - r)), x1 = Math.min(S.W - 1, Math.floor(px + r));
  const z0 = Math.max(0, Math.floor(pz - r)), z1 = Math.min(S.H - 1, Math.floor(pz + r));
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const id = S.bld[z * S.W + x];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const b = S.buildings.get(id);
      if (!b || (filter && !filter(b))) continue;
      const d = bldDist(b, px, pz);
      if (d <= r) out.push({ b, d });
    }
  return out;
}
const notRubble = (b) => b.key !== 'rubble';
/** Whether sim would accept a fire on b (mirrors VC.sim.ignite's refusals: rubble, burning, parks without staff). */
function canBurn(b) {
  if (!b || b.key === 'rubble' || b.fire > 0) return false;
  const def = VC.BLD[b.key];
  return !(def && def.group === 'parks' && !def.jobs);
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function centerOf(b) {
  return [b.x + b.w / 2, b.z + b.d / 2];
}
/** Population-weighted centre of the city (map centre if empty). */
function cityCenter() {
  const S = S_();
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
/** Uniformly random building matching filter (reservoir sampling), or null. */
function randomBuilding(filter) {
  const S = S_();
  let pick = null, n = 0;
  for (const b of S.buildings.values()) {
    if (filter && !filter(b)) continue;
    if (rnd() * ++n < 1) pick = b;
  }
  return pick;
}
/**
 * Random point on (or `margin` tiles outside) the map edge. away=true: on the far side of the map
 * from (tx, tz) so a mover crosses it; away=false: the edge nearest to (tx, tz).
 */
function edgePoint(tx, tz, margin = 1, away = true) {
  const S = S_();
  const a = Math.atan2(tz - S.H / 2, tx - S.W / 2) + (away ? Math.PI : 0) + (rnd() - 0.5) * (away ? 1.6 : 0.6);
  const cx = S.W / 2, cz = S.H / 2;
  const dx = Math.cos(a), dz = Math.sin(a);
  // intersect the ray from the centre with the map rectangle
  const tX = dx ? (dx > 0 ? S.W - cx : -cx) / dx : Infinity;
  const tZ = dz ? (dz > 0 ? S.H - cz : -cz) / dz : Infinity;
  const t = Math.min(tX, tZ);
  return [M.clamp(cx + dx * t, -margin, S.W + margin), M.clamp(cz + dz * t, -margin, S.H + margin)];
}
function inMap(x, z, margin = 0) {
  const S = S_();
  return x >= -margin && z >= -margin && x < S.W + margin && z < S.H + margin;
}
function groundAt(x, z) {
  return W_().groundY(M.clamp(x, 0, S_().W - 1), M.clamp(z, 0, S_().H - 1));
}
function particles(type, x, z, n, y) {
  const P = VC.particles;
  if (P && P.burst) P.burst(type, x, y != null ? y : groundAt(x, z) + 0.3, z, n, {});
}
function sfx(name, x, z, vol) {
  VC.bus.emit('sfx', { name, x, z, vol });
}
function toast(text, type, icon) {
  VC.bus.emit('toast', { text, type, icon });
}
/** Shakes the camera, attenuated by distance between the camera target and (x, z). */
function shakeAt(x, z, amount, range = 40) {
  const cam = VC.camera;
  if (!cam || !cam.shake) return;
  const d = Math.hypot((cam.tx || 0) - x, (cam.tz || 0) - z);
  const f = M.clamp(1 - d / range, 0.15, 1);
  cam.shake(amount * f);
}

/**
 * Destroys a building. opts.rubble (default true) leaves rubble behind. Returns true if destroyed.
 * Debris/dust particles and the crash sound come from particles/audio reacting to bus 'bldRemove'.
 */
function wreck(b, e, opts = {}) {
  const S = S_();
  if (!b || !S.buildings.has(b.id)) return false;
  // a capped disaster (tornado, monster: scaled to the city's size) stops flattening once it has taken its share
  if (e && e.cap > 0 && (e.destroyed || 0) >= e.cap) return false;
  const wasRubble = b.key === 'rubble';
  const { x, z, w, d } = b;
  if (e && !wasRubble) {
    const def = VC.BLD[b.key];
    if (def) e.lossValue = (e.lossValue || 0) + (def.cost || 0);
    else if (b.key === 'grow') e.lossLots = (e.lossLots || 0) + 1;
  }
  W_().removeBuilding(b, REASON().DISASTER);
  if (opts.rubble !== false && !wasRubble) {
    try {
      W_().addBuilding({ key: 'rubble', x, z, w, d, rot: 0 }, { instant: true, noFlatten: true });
    } catch (err) { /* footprint out of bounds etc. */ }
  }
  if (!wasRubble) {
    if (e) e.destroyed = (e.destroyed || 0) + 1;
    stats().destroyed = (stats().destroyed || 0) + 1;
  }
  return true;
}
/**
 * Sets a building on fire through the sim (fallback: flag it). Returns true only if it really caught
 * fire (sim refuses rubble, burning buildings and parks without staff); only then is it counted.
 * b.fireCause = 'disaster' + {disaster:true} tell sim not to announce this fire on its own.
 */
function burn(b, e) {
  const S = S_();
  if (!b || !S.buildings.has(b.id) || !canBurn(b)) return false;
  if (VC.sim && VC.sim.ignite) {
    const prev = b.fireCause;
    b.fireCause = 'disaster';
    let ok = false;
    try { ok = VC.sim.ignite(b, { disaster: true, cause: e ? e.type : 'disaster' }); } catch (err) { console.error('[disasters] ignite', err); }
    if (ok === false || !(b.fire > 0)) {
      if (prev === undefined) delete b.fireCause; else b.fireCause = prev;
      return false;
    }
  } else {
    b.fire = 1;
    b.fireCause = 'disaster';
    W_().changed(b);
  }
  if (e) e.burned = (e.burned || 0) + 1;
  const [cx, cz] = centerOf(b);
  particles('fire', cx, cz, 12, groundAt(cx, cz) + (b.hgt || 1) * 0.6);
  return true;
}
/** Removes trees in a tile with probability p. */
function trample(x, z, p = 1) {
  const S = S_();
  if (x < 0 || z < 0 || x >= S.W || z >= S.H) return;
  const i = z * S.W + x;
  if (S.trees[i] && rnd() < p) {
    W_().setTrees(x, z, 0);
    particles('leaf', x + 0.5, z + 0.5, 6);
  }
}

/* ------------------------------------------------------------------ */
/* Disaster behaviours: start(e, x, z) -> bool, update(e, gd, dt)      */
/* gd = game days elapsed this frame, dt = real seconds (unpaused)     */
/* ------------------------------------------------------------------ */
const H = Object.create(null);

/* ---------------- fire outbreak ---------------- */
H.fire = {
  start(e, x, z) {
    let cx = x, cz = z;
    if (cx == null) {
      const b = randomBuilding((b) => b.key === 'grow' && b.pop > 0 && canBurn(b)) || randomBuilding(canBurn);
      if (!b) return false;
      [cx, cz] = centerOf(b);
    }
    const near = buildingsNear(cx, cz, 7, canBurn);
    if (!near.length) return false;
    near.sort((a, b) => a.d - b.d);
    const pool = near.slice(0, 10);
    const n = Math.min(pool.length, 3 + Math.floor(rnd() * 4));
    e.targets = [];
    let rad = 1;
    for (let k = 0; k < n; k++) {
      const j = k + Math.floor(rnd() * (pool.length - k));
      const t = pool[j]; pool[j] = pool[k]; pool[k] = t;
      if (burn(t.b, e)) { e.targets.push(t.b.id); rad = Math.max(rad, t.d + 1); }
    }
    if (!e.targets.length) return false;
    e.x = cx; e.z = cz; e.radius = rad; e.phase = 'burning';
    e.burning = e.targets.length;
    return true;
  },
  update(e) {
    const S = S_();
    let n = 0, lost = 0;
    for (const id of e.targets) {
      const b = S.buildings.get(id);
      if (!b) lost++; // burnt down (sim turned it into rubble)
      else if (b.fire > 0) n++;
    }
    if (lost > (e.lost || 0)) {
      const dl = lost - (e.lost || 0);
      e.lost = lost;
      e.destroyed = (e.destroyed || 0) + dl;
      stats().destroyed = (stats().destroyed || 0) + dl;
    }
    e.burning = n;
    e.intensity = M.clamp(n / Math.max(1, e.targets.length) + 0.2, 0, 1);
    if ((n === 0 && e.t > 2 * C.DAY_SEC) || e.t > 45 * C.DAY_SEC) e.done = true;
  },
  startText: () => 'A major fire has broken out! Firefighters are responding.',
  endText: (e) => `The fire outbreak is over.${e.destroyed ? ` ${e.destroyed} building${e.destroyed > 1 ? 's' : ''} lost.` : ' No buildings lost.'}`,
};

/* ---------------- tornado ---------------- */
H.tornado = {
  start(e, x, z) {
    const S = S_();
    const [tx, tz] = cityCenter();
    if (x == null) {
      // touch down in open country 16-26 tiles from the city (or at the map edge on small maps)
      const a = rnd() * M.PI2, dist = 16 + rnd() * 10;
      x = M.clamp(tx + Math.cos(a) * dist, 0.5, S.W - 0.5);
      z = M.clamp(tz + Math.sin(a) * dist, 0.5, S.H - 0.5);
    }
    e.x = x; e.z = z;
    const toC = Math.atan2(tz - z, tx - x);
    e.dir = e.baseDir = Math.hypot(tx - x, tz - z) > 3 ? toC + (rnd() - 0.5) * 0.5 : rnd() * M.PI2;
    e.radius = 1.5 + rnd() * 1.0;
    e.length = 40 + rnd() * 40;
    e.speed = e.length / (30 + rnd() * 12); // ~1-2.7 tiles/day
    e.traveled = 0;
    e.p1 = rnd() * 10; e.p2 = rnd() * 10;
    e.hits = new Set();
    e.tiles = new Set();
    e.phase = 'active';
    // a random tornado's damage scales with the city (a small town loses fewer lots); utilities are
    // sturdy either way (see update: at most 2 per tornado, so it never erases a utility cluster)
    if (e.random) {
      e.sizeF = M.clamp((S.stats.pop || 0) / 20000, 0.35, 1);
      e.cap = Math.max(8, Math.round(standing() * 0.05));
    }
    e.utilHits = 0;
    return true;
  },
  update(e, gd) {
    const S = S_();
    const td = e.t / C.DAY_SEC;
    const left = e.length - e.traveled;
    e.intensity = M.clamp(Math.min(td / 1.5, left / 4), 0, 1);
    e.dir = e.baseDir + 0.45 * Math.sin(td * 0.21 + e.p1) + 0.3 * Math.sin(td * 0.53 + e.p2);
    const step = e.speed * gd;
    e.x += Math.cos(e.dir) * step;
    e.z += Math.sin(e.dir) * step;
    e.traveled += step;
    e.y = groundAt(e.x, e.z);
    if (e.traveled >= e.length || !inMap(e.x, e.z, 3)) { e.done = true; return; }
    shakeAt(e.x, e.z, 0.1 * e.intensity, 25);
    if (e.intensity < 0.35) return;
    // damage every tile under the funnel once
    const r = e.radius * (0.6 + 0.4 * e.intensity);
    const x0 = Math.max(0, Math.floor(e.x - r)), x1 = Math.min(S.W - 1, Math.floor(e.x + r));
    const z0 = Math.max(0, Math.floor(e.z - r)), z1 = Math.min(S.H - 1, Math.floor(e.z + r));
    for (let tz = z0; tz <= z1; tz++)
      for (let tx = x0; tx <= x1; tx++) {
        if (Math.hypot(tx + 0.5 - e.x, tz + 0.5 - e.z) > r) continue;
        const i = tz * S.W + tx;
        if (!e.tiles.has(i)) { e.tiles.add(i); trample(tx, tz, 0.75); }
        const id = S.bld[i];
        if (!id || e.hits.has(id)) continue;
        e.hits.add(id);
        const b = S.buildings.get(id);
        if (!b || b.key === 'rubble') continue;
        // small / low buildings are more likely to be flattened; power plants, pumps and towers are
        // sturdy (at most 2 per tornado)
        const def = VC.BLD[b.key];
        const util = !!(def && (def.power > 0 || def.water > 0));
        const sf = Number.isFinite(e.sizeF) ? e.sizeF : 1;
        let pD = (b.key === 'grow' ? 0.45 + 0.2 * (1 - (b.level || 1) / 3) : 0.4) * sf;
        let pF = 0.28;
        if (util) { pD = (e.utilHits || 0) >= 2 ? 0 : 0.15 * sf; pF = 0.1; }
        const roll = rnd();
        if (roll < pD) { if (wreck(b, e) && util) e.utilHits = (e.utilHits || 0) + 1; }
        else if (roll < pD + pF) burn(b, e);
      }
  },
  startText: () => 'Tornado warning! A twister is tearing across the land.',
  endText: (e) => `The tornado has dissipated after ${Math.round(e.traveled)} tiles.${e.destroyed ? ` ${e.destroyed} building${e.destroyed > 1 ? 's' : ''} destroyed.` : ''}`,
};

/* ---------------- meteor ---------------- */
H.meteor = {
  start(e, x, z) {
    const S = S_();
    if (x == null) {
      const b = randomBuilding((b) => notRubble(b) && (b.pop > 0 || b.key !== 'grow'));
      if (b) [x, z] = centerOf(b);
      else {
        // any dry tile near the middle
        for (let k = 0; k < 200; k++) {
          const tx = Math.floor(S.W * (0.25 + rnd() * 0.5)), tz = Math.floor(S.H * (0.25 + rnd() * 0.5));
          if (!W_().isWater(tx, tz)) { x = tx + 0.5; z = tz + 0.5; break; }
        }
        if (x == null) { x = S.W / 2; z = S.H / 2; }
      }
      x += (rnd() - 0.5) * 3; z += (rnd() - 0.5) * 3;
    }
    x = M.clamp(x, 1, S.W - 1); z = M.clamp(z, 1, S.H - 1);
    e.x = x; e.z = z;
    e.radius = 2 + rnd() * 2;
    e.dir = rnd() * M.PI2;
    e.impactT = 3.2;
    e.progress = 0;
    e.ix = x; e.iy = groundAt(x, z); e.iz = z;
    e.sx = x - Math.cos(e.dir) * 70; e.sy = e.iy + 90; e.sz = z - Math.sin(e.dir) * 70;
    e.mx = e.sx; e.my = e.sy; e.mz = e.sz;
    e.y = e.my;
    e.phase = 'incoming';
    return true;
  },
  update(e, gd, dt) {
    if (e.phase === 'incoming') {
      e.progress = Math.min(1, e.rt / e.impactT);
      const p = Math.pow(e.progress, 1.7); // accelerating fall
      e.mx = M.lerp(e.sx, e.ix, p); e.my = M.lerp(e.sy, e.iy, p); e.mz = M.lerp(e.sz, e.iz, p);
      e.y = e.my;
      e.intensity = e.progress;
      shakeAt(e.x, e.z, 0.06 * e.progress, 60);
      if (e.progress >= 1) H.meteor.impact(e);
      return;
    }
    const since = e.rt - e.impactAt;
    e.intensity = M.clamp(1 - since / 6, 0, 1);
    if (since > 6) e.done = true;
  },
  impact(e) {
    const S = S_(), W = W_();
    e.phase = 'impact';
    e.impactAt = e.rt;
    e.mx = e.ix; e.my = e.iy; e.mz = e.iz;
    const R = e.radius, cx = e.x, cz = e.z;
    // 1) buildings: vaporised in the crater, smashed or burning around it
    for (const { b, d } of buildingsNear(cx, cz, R + 2)) {
      if (d <= R) { wreck(b, e, { rubble: false }); continue; }
      const near = 1 - (d - R) / 2; // 1 at the crater lip, 0 at the edge of the blast
      if (rnd() < 0.2 + 0.45 * near) wreck(b, e);
      else if (rnd() < 0.75) burn(b, e);
    }
    // 2) terrain: bowl-shaped crater with a raised rim and scorched surroundings
    const depth = 2 + Math.round(R);
    const x0 = Math.max(0, Math.floor(cx - R - 3)), x1 = Math.min(S.W - 1, Math.floor(cx + R + 3));
    const z0 = Math.max(0, Math.floor(cz - R - 3)), z1 = Math.min(S.H - 1, Math.floor(cz + R + 3));
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
        const i = z * S.W + x;
        const h = S.height[i];
        if (d <= R) {
          const dh = Math.round(depth * (1 - (d / R) * (d / R)));
          if (S.road[i]) W.setRoad(x, z, 0);
          if (S.zone[i]) W.setZone(x, z, 0);
          if (S.pline[i]) W.setPowerLine(x, z, 0);
          if (S.trees[i]) W.setTrees(x, z, 0);
          if (h >= C.SEA) W.setHeight(x, z, Math.max(1, h - Math.max(1, dh)));
          W.setTerr(x, z, d < R * 0.55 ? VC.TERR.ROCK : VC.TERR.DIRT);
        } else if (d <= R + 1.3) {
          if (!S.bld[i] && !S.road[i] && h >= C.SEA) {
            W.setHeight(x, z, h + 1);
            W.setTerr(x, z, VC.TERR.DIRT);
          }
          if (S.trees[i]) W.setTrees(x, z, 0);
        } else if (d <= R + 3) {
          trample(x, z, 0.7);
          if (!S.road[i] && h >= C.SEA && rnd() < 0.35) W.setTerr(x, z, VC.TERR.DIRT);
        }
      }
    shakeAt(cx, cz, 2.2, 90);
    sfx('explosion', cx, cz, 1); // one impact sound (the rumble is part of the explosion)
    const gy = groundAt(cx, cz);
    particles('debris', cx, cz, 90, gy + 0.5);
    particles('dust', cx, cz, 70, gy + 0.5);
    particles('fire', cx, cz, 40, gy + 0.5);
    particles('smoke', cx, cz, 50, gy + 1);
    particles('spark', cx, cz, 40, gy + 1);
    if (VC.sim && VC.sim.recalcNetworks) { try { VC.sim.recalcNetworks(); } catch (err) { console.error(err); } }
    emit(e, 'update', { what: 'impact' });
  },
  startText: () => '<b>A meteor is approaching!</b> Brace for impact!',
  endText: (e) => `The meteor left a ${Math.round(e.radius * 2)}-tile crater.${e.destroyed ? ` ${e.destroyed} building${e.destroyed > 1 ? 's' : ''} destroyed.` : ''}`,
};

/* ---------------- earthquake ---------------- */
H.earthquake = {
  start(e, x, z) {
    const S = S_();
    if (x == null) {
      const [tx, tz] = cityCenter();
      x = M.clamp(tx + (rnd() - 0.5) * 16, 2, S.W - 2);
      z = M.clamp(tz + (rnd() - 0.5) * 16, 2, S.H - 2);
    }
    e.x = x; e.z = z;
    e.radius = 12 + rnd() * 8;
    const sev = rnd();
    e.magnitude = Math.round((5.6 + sev * 2.2) * 10) / 10;
    e.duration = 5 + sev * 1.8;
    e.dir = rnd() * Math.PI;
    e.phase = 'shaking';
    e.shake = 0;
    // victims: 5-15% of buildings in range, weighted toward the epicentre (Efraimidis-Spirakis sampling)
    const cands = buildingsNear(x, z, e.radius, notRubble);
    const n = Math.round(cands.length * (0.05 + 0.1 * sev));
    for (const c of cands) c.k = Math.pow(rnd(), 1 / (1 - 0.75 * (c.d / e.radius)));
    cands.sort((a, b) => b.k - a.k);
    e.queue = cands.slice(0, n).map((c) => ({ id: c.b.id, at: 0.4 + rnd() * (e.duration - 0.8), kind: rnd() < 0.4 ? 'destroy' : 'fire' }));
    e.queue.sort((a, b) => a.at - b.at);
    // fault line: fissure tiles cracked progressively along a jittered line through the epicentre
    const L = e.radius * 0.8, cdx = Math.cos(e.dir), cdz = Math.sin(e.dir);
    e.fault = { x0: x - cdx * L, z0: z - cdz * L, x1: x + cdx * L, z1: z + cdz * L };
    e.cracks = [];
    const ph = rnd() * 10;
    for (let s = -L; s <= L; s += 0.5) {
      const j = Math.sin(s * 0.7 + ph) * 1.2;
      const fx = Math.floor(x + cdx * s - cdz * j), fz = Math.floor(z + cdz * s + cdx * j);
      e.cracks.push({ x: fx, z: fz, at: ((s + L) / (2 * L)) * (e.duration * 0.7) + 0.3 });
    }
    return true;
  },
  update(e, gd, dt) {
    const S = S_(), W = W_();
    const k = M.clamp(e.rt / e.duration, 0, 1);
    e.shake = k < 1 ? Math.sqrt(Math.sin(Math.PI * k)) * (0.6 + 0.2 * (e.magnitude - 5.6)) : 0;
    e.intensity = e.shake;
    if (e.shake > 0) shakeAt(e.x, e.z, e.shake, e.radius * 4);
    while (e.queue.length && e.queue[0].at <= e.rt) {
      const q = e.queue.shift();
      const b = S.buildings.get(q.id);
      if (!b) continue;
      if (q.kind === 'destroy') wreck(b, e);
      else burn(b, e);
    }
    while (e.cracks.length && e.cracks[0].at <= e.rt) {
      const c = e.cracks.shift();
      if (!W.inb(c.x, c.z)) continue;
      const i = c.z * S.W + c.x;
      if (S.bld[i] || S.road[i] || S.height[i] < C.SEA) continue;
      W.setTerr(c.x, c.z, VC.TERR.DIRT);
      if (S.height[i] > C.SEA) W.setHeight(c.x, c.z, S.height[i] - 1);
      trample(c.x, c.z, 1);
      if (rnd() < 0.3) particles('dust', c.x + 0.5, c.z + 0.5, 6);
    }
    if (e.rt >= e.duration + 1.5 && !e.queue.length) e.done = true;
  },
  startText: (e) => `<b>Earthquake!</b> Magnitude ${e.magnitude.toFixed(1)} tremor under the city!`,
  endText: (e) => `The shaking has stopped.${e.destroyed || e.burned ? ` ${e.destroyed} building${e.destroyed === 1 ? '' : 's'} collapsed, ${e.burned} on fire.` : ' Minimal damage.'}`,
};

/* ---------------- UFO ---------------- */
const UFO_ALT = 16, UFO_HOVER = 6.5;
H.ufo = {
  start(e, x, z) {
    const [tx, tz] = x != null ? [x, z] : cityCenter();
    const [sx, sz] = edgePoint(tx, tz, 4);
    e.x = sx; e.z = sz;
    e.tx = tx; e.tz = tz;
    e.y = groundAt(tx, tz) + UFO_ALT;
    e.dir = Math.atan2(tz - sz, tx - sx);
    e.radius = 1.2;
    e.phase = 'arrive';
    e.hoverDays = 18 + rnd() * 6;
    e.beam = 0;
    e.lifting = null;
    e.goal = null;
    e.lastAbduct = 0;
    e.abducted = 0;
    e.taken = []; // names of the first few abducted buildings (for the end summary)
    return true;
  },
  update(e, gd) {
    const S = S_();
    const td = e.t / C.DAY_SEC;
    const move = (gx, gz, speed) => {
      const dx = gx - e.x, dz = gz - e.z, d = Math.hypot(dx, dz);
      if (d < 1e-4) return 0;
      const s = Math.min(d, speed * gd);
      e.x += (dx / d) * s; e.z += (dz / d) * s;
      e.dir = Math.atan2(dz, dx);
      return d - s;
    };
    const ground = groundAt(e.x, e.z);
    if (e.phase === 'arrive') {
      e.intensity = Math.min(1, e.intensity + gd);
      e.y = M.damp(e.y, ground + UFO_ALT * 0.7, 0.5, gd);
      if (move(e.tx, e.tz, 7) < 0.5) { e.phase = 'hover'; e.hoverStart = td; e.lastAbduct = td - 1; }
    } else if (e.phase === 'hover') {
      // hover above the local skyline (e.ceiling = tallest roof near the current target area)
      let wantY = Math.max(ground + UFO_HOVER, (e.ceiling || 0) + 2.5);
      if (e.lifting) wantY = Math.max(wantY, e.lifting.y0 + e.lifting.h + 3.5);
      e.y = M.damp(e.y, wantY, 1.2, gd);
      if (e.lifting) {
        const L = e.lifting;
        const b = S.buildings.get(L.id);
        if (!b || !ufoTarget(b)) {
          // gone (bulldozed, burnt) or caught fire mid-lift: drop it back down
          if (b) delete b.disLift;
          e.lifting = null;
          e.lastAbduct = td - 1;
        } else {
          L.b = b;
          L.progress = Math.min(1, L.progress + gd / 1.4);
          L.lift = L.progress * L.progress * Math.max(0.5, e.y - L.y0 - L.h - 0.3);
          b.disLift = L.lift;
          if (L.progress >= 1) {
            const name = VC.sim && VC.sim.buildingName ? VC.sim.buildingName(b) : b.key;
            delete b.disLift;
            W_().removeBuilding(b, REASON().ABDUCT);
            e.abducted++;
            if (e.taken && e.taken.length < 3 && name && e.taken.indexOf(String(name)) < 0) e.taken.push(String(name));
            stats().abducted = (stats().abducted || 0) + 1;
            e.destroyed = (e.destroyed || 0) + 1;
            stats().destroyed = (stats().destroyed || 0) + 1;
            particles('sparkle', L.x, L.z, 40, e.y - 1);
            sfx('abduct', L.x, L.z);
            emit(e, 'update', { what: 'abduct', key: b.key, buildingName: name });
            e.lifting = null;
            e.lastAbduct = td;
          }
        }
      } else if (e.goal) {
        const b = S.buildings.get(e.goal);
        if (!b || !ufoTarget(b)) e.goal = null;
        else {
          const [gx, gz] = centerOf(b);
          if (move(gx, gz, 3.5) < 0.15) {
            e.lifting = { id: b.id, b, progress: 0, x: gx, z: gz, y0: groundAt(gx, gz), h: b.hgt || 1, lift: 0 };
            e.goal = null;
            sfx('ufo', gx, gz);
          }
        }
      } else {
        // lazy circle around the target area while choosing the next victim
        const a = td * 0.6;
        move(e.tx + Math.cos(a) * 3, e.tz + Math.sin(a) * 3, 2);
        if (td - e.lastAbduct >= 2 && td - e.hoverStart < e.hoverDays) {
          const near = buildingsNear(e.x, e.z, 14, notRubble);
          e.ceiling = 0;
          let best = null, bs = -Infinity;
          for (const c of near) {
            // remember the skyline so we fly over it
            e.ceiling = Math.max(e.ceiling, groundAt(c.b.x, c.b.z) + (c.b.hgt || 1));
            const w = ufoWeight(c.b);
            if (!w) continue;
            const s = rnd() * w - c.d * 0.03;
            if (s > bs) { bs = s; best = c.b; }
          }
          if (best) e.goal = best.id;
          else e.lastAbduct = td; // nothing worth taking here: try again later
        }
      }
      if (td - e.hoverStart >= e.hoverDays && !e.lifting && !e.goal) {
        e.phase = 'leave';
        [e.tx, e.tz] = edgePoint(e.x, e.z, 12, false); // exit via the nearest edge
        sfx('ufo', e.x, e.z);
      }
      e.beam = M.damp(e.beam, e.lifting ? 1 : 0, 4, gd);
    } else {
      e.beam = M.damp(e.beam, 0, 4, gd);
      e.y += gd * 4;
      const left = move(e.tx, e.tz, 9);
      e.intensity = M.clamp(left / 8, 0, 1);
      if (left < 0.5 || !inMap(e.x, e.z, 10)) e.done = true;
    }
  },
  startText: () => '<b>Unidentified flying object</b> spotted over the city!',
  endText: (e) => {
    if (!e.abducted) return 'The UFO has left without taking anything. We are not alone.';
    const n = e.abducted, names = (e.taken || []).map(esc);
    const list = names.length ? ` (${names.join(', ')}${n > names.length ? ', …' : ''})` : '';
    return `The UFO has left with ${n === 1 ? 'one of our buildings' : `${n} of our buildings`}${list}. We are not alone.`;
  },
};
/** Small cosmetic civic buildings a UFO may take when no ordinary building is around. */
const UFO_MINOR = { small_park: 1, playground: 1, plaza: 1, statue: 1 };
/** Whether a UFO may abduct b: growables, or a few cheap cosmetic civic buildings. Never utilities, services, landmarks. */
function ufoTarget(b) {
  if (!b || b.key === 'rubble' || b.fire > 0) return false;
  if (b.key === 'grow') return true;
  const def = VC.BLD[b.key];
  if (!def || !UFO_MINOR[b.key]) return false;
  return !(def.power || def.water || def.unique || (def.cost || 0) > 2000);
}
/** Target preference: taller / denser growables; finished buildings over construction sites; civic rarely. */
function ufoWeight(b) {
  if (!ufoTarget(b)) return 0;
  if (b.key !== 'grow') return 0.25;
  const w = 1 + (b.level || 1) * (b.den || 1) * 0.25;
  return b.built < 1 ? w * 0.3 : w;
}

/* ---------------- Cubezilla ---------------- */
H.monster = {
  start(e, x, z) {
    const S = S_();
    const [cx, cz] = cityCenter();
    let sx = x, sz = z;
    if (sx == null) {
      // emerge from the sea at the map edge closest to the city if there is coast, else any edge
      let best = null, bd = Infinity;
      const n = 24;
      for (let k = 0; k < n * 4; k++) {
        const side = k % 4, f = (Math.floor(k / 4) + 0.5) / n;
        const px = side === 0 ? f * S.W : side === 1 ? S.W - 1 : side === 2 ? f * S.W : 0;
        const pz = side === 0 ? 0 : side === 1 ? f * S.H : side === 2 ? S.H - 1 : f * S.H;
        if (!W_().isWater(Math.floor(M.clamp(px, 0, S.W - 1)), Math.floor(M.clamp(pz, 0, S.H - 1)))) continue;
        const d = Math.hypot(px - cx, pz - cz) * (0.8 + rnd() * 0.4);
        if (d < bd) { bd = d; best = [px, pz]; }
      }
      [sx, sz] = best || edgePoint(cx, cz, 0);
    }
    e.x = sx; e.z = sz;
    e.y = groundAt(sx, sz);
    // route: city centre -> a far-flung neighbourhood (only in big cities) -> out the far side
    const far = randomBuilding((b) => notRubble(b) && Math.hypot(b.x - cx, b.z - cz) > 8);
    const wp = [[cx + (rnd() - 0.5) * 6, cz + (rnd() - 0.5) * 6]];
    if (far && (!e.random || (S.stats.pop || 0) >= 20000)) wp.push(centerOf(far));
    // a random Cubezilla loses interest once it has flattened its share of the city (6%, at least 12)
    if (e.random) e.cap = Math.max(12, Math.round(standing() * 0.06));
    const last = wp[wp.length - 1];
    const ax = last[0] - sx, az = last[1] - sz, al = Math.hypot(ax, az) || 1;
    wp.push([last[0] + (ax / al) * S.W * 1.5, last[1] + (az / al) * S.H * 1.5]); // exit, clipped by inMap
    e.waypoints = wp;
    e.dir = Math.atan2(wp[0][1] - sz, wp[0][0] - sx);
    e.speed = 1.8 + rnd() * 0.5;
    e.radius = 1.2;
    e.step = 0;
    e.stomp = 0;
    e.roar = 1;
    e.breath = null;
    e.nextBreath = 3 + rnd() * 3;
    e.lastFoot = 0;
    e.phase = 'enter';
    return true;
  },
  update(e, gd) {
    const S = S_();
    const td = e.t / C.DAY_SEC;
    e.intensity = Math.min(1, e.intensity + gd);
    e.stomp = Math.max(0, e.stomp - gd * 4);
    e.roar = Math.max(0, e.roar - gd * 0.8);
    const wp = e.waypoints[0];
    if (!wp) { e.done = true; return; }
    // steer smoothly toward the waypoint
    const want = Math.atan2(wp[1] - e.z, wp[0] - e.x);
    let da = ((want - e.dir + Math.PI) % M.PI2 + M.PI2) % M.PI2 - Math.PI;
    e.dir += M.clamp(da, -2.6 * gd, 2.6 * gd); // turn radius < waypoint radius
    const s = e.speed * gd;
    e.x += Math.cos(e.dir) * s;
    e.z += Math.sin(e.dir) * s;
    e.step += s;
    e.y = groundAt(e.x, e.z);
    if (Math.hypot(wp[0] - e.x, wp[1] - e.z) < 1.2) {
      e.waypoints.shift();
      if (e.waypoints.length === 1) e.phase = 'leave';
    }
    if (e.phase === 'enter' && inMap(e.x, e.z) && !W_().isWater(Math.floor(e.x), Math.floor(e.z))) e.phase = 'rampage';
    if (!e.sated && e.cap > 0 && (e.destroyed || 0) >= e.cap) {
      // had its fill: head straight out, away from the city centre, flattening nothing more
      e.sated = true;
      const [cx, cz] = cityCenter();
      let ax = e.x - cx, az = e.z - cz, al = Math.hypot(ax, az);
      if (al < 1) { ax = Math.cos(e.dir); az = Math.sin(e.dir); al = 1; }
      e.waypoints = [[e.x + (ax / al) * S.W * 1.5, e.z + (az / al) * S.H * 1.5]];
      e.phase = 'leave';
      e.breath = null;
    }
    if (e.waypoints.length <= 1 && !inMap(e.x, e.z, 3)) { e.done = true; return; }
    if (td > 90) { e.done = true; return; }
    // footfalls every half tile: stomp everything under the feet
    const foot = Math.floor(e.step * 2);
    if (foot !== e.lastFoot) {
      e.lastFoot = foot;
      e.stomp = 1;
      if (inMap(e.x, e.z)) {
        shakeAt(e.x, e.z, 0.35, 30);
        if (foot % 2 === 0) sfx('stomp', e.x, e.z);
        if (!e.sated) {
          for (const { b } of buildingsNear(e.x, e.z, e.radius, notRubble)) {
            if (rnd() < 0.8) wreck(b, e);
            else burn(b, e);
          }
        }
        const tx = Math.floor(e.x), tz = Math.floor(e.z);
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) trample(tx + dx, tz + dz, 0.8);
        particles('dust', e.x, e.z, 8);
      }
    }
    // atomic breath: ignite a building a few tiles ahead
    if (e.breath) {
      e.breath.t += gd;
      if (e.breath.t > 1.5) e.breath = null;
    } else if (td >= e.nextBreath && e.phase !== 'leave') {
      e.nextBreath = td + 4 + rnd() * 3;
      const ax = e.x + Math.cos(e.dir) * 4, az = e.z + Math.sin(e.dir) * 4;
      const near = buildingsNear(ax, az, 2.5, (b) => notRubble(b) && !b.fire);
      e.roar = 1;
      sfx('roar', e.x, e.z, 1);
      if (near.length) {
        const t = near[Math.floor(rnd() * near.length)].b;
        const [bx, bz] = centerOf(t);
        e.breath = { x: bx, z: bz, t: 0 };
        burn(t, e);
        emit(e, 'update', { what: 'breath', bx, bz });
      }
    }
  },
  startText: () => '<b>CUBEZILLA</b> has emerged and is heading for the city!',
  endText: (e) => `Cubezilla has wandered off.${e.destroyed ? ` ${e.destroyed} building${e.destroyed > 1 ? 's' : ''} flattened.` : ''}`,
};

/* ------------------------------------------------------------------ */
function emit(e, phase, extra) {
  VC.bus.emit('disaster', Object.assign({ type: e.type, phase, x: e.x, z: e.z, name: e.name, icon: e.icon, entry: e, id: e.id }, extra || {}));
}
/**
 * The point a camera should look at for entry e right now (clamped into the map): the UFO's target area
 * while it is still flying in from the edge, the impact point of a meteor, else the entry itself.
 */
function focusPoint(e) {
  const S = S_();
  if (!e) return null;
  let x = e.x, z = e.z;
  if (e.type === 'ufo' && e.phase === 'arrive' && Number.isFinite(e.tx) && Number.isFinite(e.tz)) { x = e.tx; z = e.tz; }
  else if (e.type === 'meteor' && Number.isFinite(e.ix) && Number.isFinite(e.iz)) { x = e.ix; z = e.iz; }
  x = +x; z = +z;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  if (S) { x = M.clamp(x, 0, S.W - 1); z = M.clamp(z, 0, S.H - 1); }
  return [x, z];
}

function randomType() {
  const S = S_();
  const m = Math.floor(S.time.day / C.DAYS_PER_MONTH) % 12;
  const summer = m >= 5 && m <= 7, spring = m >= 2 && m <= 4;
  const pop = S.stats.pop || 0;
  let tot = 0;
  const w = {};
  for (const t of TYPES) {
    let v = ODDS[t.key] || 10;
    if (pop < (TYPE_MIN_POP[t.key] || 0)) v = 0;
    if (t.key === 'tornado') v *= spring || summer ? 1.6 : 0.5;
    if (t.key === 'fire') v *= summer ? 1.5 : 0.8;
    w[t.key] = v;
    tot += v;
  }
  let r = rnd() * tot;
  for (const t of TYPES) if ((r -= w[t.key]) <= 0) return t.key;
  return 'fire';
}
/** Schedules the next random disaster (first = the city's first one), spaced per difficulty. */
function scheduleNext(S, first) {
  const T = first ? FIRST_YEARS : GAP_YEARS;
  const [a, b] = T[S.difficulty] || T.normal;
  stats().nextDay = S.time.day + Math.round(YEAR * (a + rnd() * (b - a)));
}
/** Standing (non-rubble) buildings: the base for size-scaled damage caps. */
function standing() {
  const S = S_();
  const st = S.stats || {};
  return Math.max(0, st.buildings || S.buildings.size);
}
/** After random disasters get switched on, give the player 6-12 months of peace (nextDay may be long overdue). */
function grace(S) {
  const st = stats();
  const min = S.time.day + 180;
  if (st.nextDay == null || st.nextDay < min) st.nextDay = min + Math.round(rnd() * 180);
}

function onDay() {
  const S = S_();
  if (!S || !D.randomEnabled()) return;
  const st = stats();
  if (st.nextDay == null) scheduleNext(S, true);
  if (S.time.day < st.nextDay) return;
  if (D.active.length || (S.stats.pop || 0) <= RANDOM_MIN_POP) {
    st.nextDay = S.time.day + (D.active.length ? 30 : 90);
    return;
  }
  if (D.trigger(randomType(), null, null, { random: true })) scheduleNext(S, false);
  else st.nextDay = S.time.day + 30;
}

/** Settings → "Random disasters" also switches the running city (so the two toggles act as one). */
function onSettings(set) {
  const g = ((set || VC.settings || {}).disasters) !== false;
  if (lastGlobal === null) { lastGlobal = g; return; }
  if (g === lastGlobal) return;
  const S = S_();
  const before = !!(S && !S.demo && S.disastersEnabled && lastGlobal);
  lastGlobal = g;
  if (!S || S.demo) return;
  S.disastersEnabled = g;
  if (!before && D.randomEnabled()) grace(S);
}

/* ---------------- save / load of active entries ---------------- */
/** Plain-JSON copy of an active entry: Sets -> arrays, building references -> ids. */
function packEntry(e) {
  const o = Object.assign({}, e);
  delete o.entry;
  for (const k of SET_FIELDS) if (o[k] instanceof Set) o[k] = Array.from(o[k]);
  if (o.lifting) {
    o.lifting = Object.assign({}, o.lifting);
    delete o.lifting.b;
  }
  return JSON.parse(JSON.stringify(o));
}
/** Rebuilds an active entry saved by packEntry (null if it is unusable). */
function unpackEntry(S, o) {
  if (!o || typeof o !== 'object' || !H[o.type] || !TYPE[o.type]) return null;
  const e = Object.assign({}, o);
  const def = TYPE[e.type];
  e.name = def.name; e.icon = def.icon;
  for (const k of ['x', 'z']) { e[k] = +e[k]; if (!Number.isFinite(e[k])) return null; }
  const num = (k, d) => { e[k] = Number.isFinite(+e[k]) && e[k] !== null ? +e[k] : d; };
  num('y', 0); num('t', 0); num('rt', 0); num('dir', 0); num('radius', 1); num('intensity', 0); num('destroyed', 0); num('burned', 0);
  for (const k of SET_FIELDS) if (k in e) e[k] = new Set(Array.isArray(e[k]) ? e[k] : []);
  if (e.type === 'tornado') { if (!e.hits) e.hits = new Set(); if (!e.tiles) e.tiles = new Set(); }
  if (e.lifting) {
    const b = e.lifting.id != null ? S.buildings.get(e.lifting.id) : null;
    if (b && ufoTarget(b)) { e.lifting.b = b; b.disLift = +e.lifting.lift || 0; }
    else e.lifting = null;
  }
  if (e.type === 'ufo' && !Array.isArray(e.taken)) e.taken = [];
  e.done = false;
  e.id = Number.isFinite(+e.id) ? +e.id : ++seq;
  if (e.id > seq) seq = e.id;
  return e;
}
const saveHooks = {
  save(S) {
    if (!S || S !== S_() || !D.active.length) return undefined;
    return { v: 1, day: S.time.day, active: D.active.map(packEntry) };
  },
  load(S, data) {
    if (!S || S !== S_() || !data || !Array.isArray(data.active)) return;
    D.active = [];
    for (const o of data.active) {
      if (D.active.length >= 4) break;
      let e = null;
      try { e = unpackEntry(S, o); } catch (err) { console.warn('[disasters] could not restore an active disaster', err); }
      if (e && !D.active.some((a) => a.id === e.id)) D.active.push(e);
    }
  },
};

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */
const D = (VC.disasters = {
  TYPES,
  active: [],
  stats: { count: 0, byType: {}, survived: {}, destroyed: 0, abducted: 0, nextDay: null },

  init() {
    VC.bus.on('day', () => {
      try { onDay(); } catch (err) { console.error('[disasters] day', err); }
    });
    VC.bus.on('settings', (set) => {
      try { onSettings(set); } catch (err) { console.error('[disasters] settings', err); }
    });
    // a disaster fire that went out is an ordinary building again
    VC.bus.on('bldChange', (b) => { if (b && b.fireCause === 'disaster' && !(b.fire > 0)) delete b.fireCause; });
    if (VC.save && VC.save.register) VC.save.register('disasters', saveHooks);
  },

  reset(S) {
    D.active = []; // a loaded game gets its running disasters back from the 'disasters' save hook
    lastGlobal = VC.settings ? VC.settings.disasters !== false : true;
    rnd = M.rng((S.seed ^ 0x5eed) + S.time.day);
    const st = S.disasterStats || (S.disasterStats = {});
    if (st.count == null) st.count = 0;
    if (!st.byType) st.byType = {};
    if (!st.survived) st.survived = {};
    if (st.destroyed == null) st.destroyed = 0;
    if (st.abducted == null) st.abducted = 0;
    for (const t of TYPES) if (st.byType[t.key] == null) st.byType[t.key] = 0;
    D.stats = st;
    if (st.nextDay == null) scheduleNext(S, true);
  },

  update(dt) {
    if (!dt || !D.active.length) return;
    const S = S_();
    if (!S) return;
    const gd = (dt * C.SPEEDS[S.time.speed | 0]) / C.DAY_SEC; // game days this frame
    for (let i = 0; i < D.active.length; i++) {
      const e = D.active[i];
      try {
        e.t += gd * C.DAY_SEC;
        e.rt += dt;
        H[e.type].update(e, gd, dt);
      } catch (err) {
        console.error('[disasters] ' + e.type, err);
        e.done = true;
      }
      if (e.done) {
        D.active.splice(i--, 1);
        finish(e);
      }
    }
  },

  /**
   * Starts a disaster. x, z (tiles, optional) = target point (fire/meteor/quake: centre; tornado/
   * monster: start point; ufo: area to hover over). Both or neither must be given; non-numeric /
   * non-finite values or points far outside the map are refused (points up to 2 tiles off the edge are
   * clamped). opts.random marks scheduler-triggered ones. Returns true if it started.
   */
  trigger(type, x, z, opts = {}) {
    const S = S_();
    const h = H[type], def = TYPE[type];
    if (!S || !h || !def) return false;
    if (D.active.length >= 4) return false;
    if (type !== 'fire' && type !== 'meteor' && D.active.some((a) => a.type === type)) return false;
    const given = (v) => v != null && v !== '';
    if (given(x) || given(z)) {
      const px = given(x) ? +x : NaN, pz = given(z) ? +z : NaN;
      if (!Number.isFinite(px) || !Number.isFinite(pz) || px < -2 || pz < -2 || px > S.W + 2 || pz > S.H + 2) {
        console.warn('[disasters] trigger: invalid coordinates', x, z);
        return false;
      }
      x = M.clamp(px, 0, S.W - 0.01);
      z = M.clamp(pz, 0, S.H - 0.01);
    } else x = z = null;
    const e = {
      id: ++seq, type, name: def.name, icon: def.icon,
      x: 0, z: 0, y: 0, t: 0, rt: 0, dir: 0, radius: 1, phase: 'start', intensity: 0,
      destroyed: 0, burned: 0, random: !!(opts && opts.random), day: S.time.day,
    };
    let ok = false;
    try { ok = h.start(e, x, z); } catch (err) { console.error('[disasters] start ' + type, err); ok = false; }
    if (!ok || !Number.isFinite(e.x) || !Number.isFinite(e.z)) return false;
    if (!e.y) e.y = groundAt(e.x, e.z);
    D.active.push(e);
    const st = stats();
    st.count++;
    st.byType[type] = (st.byType[type] || 0) + 1;
    st.lastDay = S.time.day;
    // the only start notification: the HUD shows the alert card, audio plays the alarm
    const fp = focusPoint(e) || [e.x, e.z];
    emit(e, 'start', { x: fp[0], z: fp[1], random: e.random });
    // random disasters slow the game down so the player can react
    if (e.random && S.time.speed > 1 && VC.setSpeed) VC.setSpeed(1);
    return true;
  },

  /** Info entry for a type key. */
  info(type) {
    return TYPE[type] || null;
  },
  /** Live active entry by id (null once it has ended). */
  get(id) {
    if (id == null) return null;
    const n = +id;
    return D.active.find((e) => e.id === n) || null;
  },
  /** Whether random disasters can currently happen. */
  randomEnabled() {
    const S = S_();
    return !!(S && !S.demo && S.disastersEnabled && (!VC.settings || VC.settings.disasters !== false));
  },
  /** Turns random disasters on/off for the running city (switching on grants 6-12 months of peace). */
  setEnabled(on) {
    const S = S_();
    if (!S) return;
    const before = D.randomEnabled();
    S.disastersEnabled = !!on;
    if (!before && D.randomEnabled()) grace(S);
  },
  /** Days until the next random disaster may strike (null if disabled). */
  nextIn() {
    const S = S_();
    if (!S || !D.randomEnabled()) return null;
    return Math.max(0, (stats().nextDay || 0) - S.time.day);
  },
  /**
   * Moves the camera to an active disaster: an entry, anything with an id (e.g. the 'disaster' event —
   * the LIVE entry with that id is used; once it has ended, the object's own x/z), or an index into
   * active (default the newest). Returns false if there is nothing (finite) to look at.
   */
  focus(which) {
    let e = null;
    if (which && typeof which === 'object') e = (which.id != null && D.get(which.id)) || which;
    else e = D.active[which == null ? D.active.length - 1 : which];
    if (!e || !VC.camera || !VC.camera.focus) return false;
    const p = focusPoint(e);
    if (!p) return false;
    VC.camera.focus(p[0], p[1], 38);
    return true;
  },
  /** World point to look at for an entry (see focus); null if unknown. */
  focusPoint,
  /** Ends every active disaster immediately (debug / new game). */
  clear() {
    for (const e of D.active.splice(0)) finish(e, true);
  },
});

/**
 * Disaster relief for a RANDOM disaster (never one the player triggered): the state pays back half the
 * price of the public buildings it destroyed plus a little per lost lot (clearing the rubble). Booked
 * under ledger category 'relief'. Returns the amount.
 */
function relief(e) {
  const S = S_();
  if (!S || S.demo || S.sandbox || !e.random) return 0;
  let mul = 1;
  try { mul = VC.money.costMul(); } catch (err) { mul = 1; }
  const v = Math.round(((e.lossValue || 0) * mul * RELIEF_SHARE + (e.lossLots || 0) * RELIEF_PER_LOT) / 100) * 100;
  if (!(v > 0)) return 0;
  VC.money.earn(v, 'relief');
  const st = stats();
  st.relief = (st.relief || 0) + v;
  return v;
}
function finish(e, cleared) {
  const st = stats();
  st.survived[e.type] = (st.survived[e.type] || 0) + 1;
  if (e.lifting && e.lifting.b) delete e.lifting.b.disLift;
  e.lifting = null;
  e.phase = 'end';
  const h = H[e.type];
  let text = '';
  try { text = h.endText(e); } catch (err) { text = `${e.name} is over.`; }
  const aid = cleared ? 0 : relief(e);
  if (aid) text += ` The state sends <b>${VC.fmt.money(aid)}</b> in disaster relief.`;
  e.relief = aid;
  toast(text, e.destroyed > 5 ? 'warn' : 'info', e.icon);
  emit(e, 'end', { destroyed: e.destroyed || 0, burned: e.burned || 0, abducted: e.abducted || 0, relief: aid });
}
