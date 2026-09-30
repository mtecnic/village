/*
 * VOXELPOLIS — game actions (VC.actions): validated, costed world edits. Contract: docs/ARCHITECTURE.md §VC.actions.
 *
 * Every edit comes as a PURE validator (can*) returning a plan (used by the tool previews every time the
 * cursor moves) and a COMMIT that re-validates, charges VC.money and mutates the world through VC.world.
 * All costs are multiplied by VC.money.costMul() (0 in sandbox). Commits emit bus 'built'
 * {kind, x, z, w, d, key, cost, count} (x/z/w/d = bounding box of the edit) and 'sfx' {name, x, z}
 * (unless opts.quiet; names: road, zone, dezone, build, pline, bulldoze, demolish, plant, terraform, whoosh = undo).
 * Particles are left to the fx module, which reacts to 'built' and 'bldRemove'.
 *
 *   roadPath(x0,z0,x1,z1, straight)    -> [{x,z}] L-shaped (longer axis first) or straight (dominant axis)
 *   canBuildRoad(tiles, type)          -> plan {ok, cost, reason, bad:[i], count, bridges, levelCost, status, levels,
 *                                         tiles} (status/levels/bad index plan.tiles = the input minus duplicates)
 *   buildRoad(tiles, type)             -> {ok, cost, reason, count}
 *   canZone / zone(x0,z0,x1,z1, code)  code 0 = dezone (removes growables, demolish fee); any other code must be
 *                                      a VC.ZONE_TOOLS code (undefined / junk is rejected, never a silent dezone)
 *   canPlace(key,x,z,rot)              -> {ok, reason, cost, w, d, flattenCost, level, warn}
 *   placeBuilding(key,x,z,rot)         -> {ok, reason, cost, b}
 *   canBulldoze / bulldoze(x0,z0,x1,z1, opts {buildings, roads, trees, plines, zones, ids})
 *                                      ids (array | Set of building ids): only those buildings are demolished
 *                                      (confirm dialogs pass the ids they showed, so a lot that changed meanwhile
 *                                      is never demolished by mistake)
 *   canPowerLine / powerLine(tiles)    (plan.tiles = the input minus duplicates)
 *   canPlantTrees / plantTrees(x0,z0,x1,z1, opts {tiles})     (+1 tree density, max 3; duplicate tiles count once)
 *   brushTiles(x,z,radius)             -> [{x,z}] round brush, radius 0..3
 *   canTerraform / terraform(x,z,radius, mode 'raise'|'lower'|'level', level)
 *   UNDO: every commit is journaled (tiles touched + buildings added/removed + money spent).
 *     beginGroup(label) / endGroup() merge several commits (brush strokes, multi-place drags) into one step.
 *     canUndo() -> {ok, label, age}, undo() -> {ok, reason, refund}: allowed for UNDO_SEC seconds and only
 *     while every touched tile / added building is still exactly as the action left it. Refunds are booked
 *     under the money category 'refund' (so spending stats / achievements can tell them apart from income).
 *
 * INPUT VALIDATION: every public entry point rejects non-integer / non-finite coordinates ('Invalid position'),
 *   off-map tiles ('Out of bounds'), unknown keys / modes / zone codes, and de-duplicates tile lists, so a bad
 *   call can never create a corrupt building or charge for the same tile twice.
 * MONEY: commits charge through VC.money; an unaffordable commit calls VC.money.spend, which is the ONLY emitter
 *   of bus 'noMoney' (the HUD shows it). Actions never toast; the result is fail('Not enough money', {plan}).
 *
 * Road levels: consecutive road tiles may differ by at most 1 level (the terrain renders ramps). Bridges
 * (roads on water tiles) keep their seabed height and act as road level SEA+1 (the terrain deck level).
 * Steeper steps are auto-leveled toward the neighbouring road level (terraform cost), never below SEA.
 * Bridges: at most MAX_BRIDGE water tiles in a row — counted across segments, i.e. the existing bridge that
 *   continues a new run at an open path end (followed around corners) and existing bridge tiles in line with a new
 *   tile along either axis count too — and every new run of water tiles must touch land or a road (bridgeCheck).
 */
const C = VC.C, M = VC.M;
const W = VC.world;

const UNDO_SEC = 10; // undo window (real seconds)
const UNDO_MAX = 12; // journal depth
const MAX_BRIDGE = 20; // max consecutive water tiles in one road
const MAX_STEEP = 3; // max terrain unevenness inside a building footprint
const DECK_LVL = C.SEA + 1; // road level of bridges (terrain renderer contract)
const GROW_DEMOLISH = 5; // $ per tile to demolish a growable
const ROAD_DEMOLISH = 2; // $ per road tile
const TREE_DEMOLISH = 1; // $ per tree
const PLINE_DEMOLISH = 1; // $ per power line tile
const DX4 = [1, -1, 0, 0], DZ4 = [0, 0, 1, -1];

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */
const mul = () => (VC.money && VC.money.costMul ? VC.money.costMul() : 1);
const fmtPop = (n) => VC.fmt.num(n || 0);
const lockReason = (unlock) => 'Locked: ' + fmtPop(unlock) + ' pop';
const isRubble = (b) => b && b.key === 'rubble';
const roadDef = (type) => (Number.isInteger(type) && VC.ROADS[type]) || null;
/** Catalog definition (own keys only: 'constructor' & co. are not buildings). */
const bldDef = (key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(VC.BLD, key) ? VC.BLD[key] : null);
const isInt = Number.isInteger;
const BAD_POS = 'Invalid position';
const TERRAFORM_MODES = new Set(['raise', 'lower', 'level']);
/** Building removal reasons (core/state.js). */
const REM = VC.REMOVE || { BULLDOZE: 'bulldoze', REPLACE: 'replace', UNDO: 'undo' };

/** Clips an (unordered) inclusive rectangle to the map. Returns {x0,z0,x1,z1,w,d} or null (off-map / not integers). */
function clipRect(x0, z0, x1, z1) {
  const S = VC.state;
  if (!S || !isInt(x0) || !isInt(z0) || !isInt(x1) || !isInt(z1)) return null;
  let a = Math.min(x0, x1), b = Math.max(x0, x1), c = Math.min(z0, z1), d = Math.max(z0, z1);
  a = Math.max(0, a); c = Math.max(0, c);
  b = Math.min(S.W - 1, b); d = Math.min(S.H - 1, d);
  if (a > b || c > d) return null;
  return { x0: a, z0: c, x1: b, z1: d, w: b - a + 1, d: d - c + 1 };
}
/** Failure reason for a rectangle clipRect rejected. */
function rectReason(x0, z0, x1, z1) {
  return isInt(x0) && isInt(z0) && isInt(x1) && isInt(z1) ? 'Out of bounds' : BAD_POS;
}
/**
 * Copy of a tile list without repeated tiles (first occurrence wins, order kept). Malformed entries stay in the
 * list as {x: NaN, z: NaN} / as given so validators can flag them; only valid on-map tiles are de-duplicated.
 */
function uniqTiles(tiles) {
  const S = VC.state, out = [];
  if (!Array.isArray(tiles)) return out;
  const seen = new Set();
  for (const t of tiles) {
    if (!t || typeof t !== 'object') { out.push({ x: NaN, z: NaN }); continue; }
    if (isInt(t.x) && isInt(t.z) && W.inb(t.x, t.z)) {
      const i = t.z * S.W + t.x;
      if (seen.has(i)) continue;
      seen.add(i);
    }
    out.push(t);
  }
  return out;
}
/** Invalid-tile reason ('' when the tile is a valid on-map integer tile). */
function tileReason(t) {
  if (!isInt(t.x) || !isInt(t.z)) return BAD_POS;
  return W.inb(t.x, t.z) ? '' : 'Out of bounds';
}
const adjacent = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1;
/** Bounding box of a tile list. */
function tilesBox(tiles) {
  let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
  for (const t of tiles) {
    if (t.x < x0) x0 = t.x;
    if (t.x > x1) x1 = t.x;
    if (t.z < z0) z0 = t.z;
    if (t.z > z1) z1 = t.z;
  }
  return { x: x0, z: z0, w: x1 - x0 + 1, d: z1 - z0 + 1 };
}
function fail(reason, extra) {
  return Object.assign({ ok: false, cost: 0, reason }, extra || {});
}
function sfx(name, x, z, opts, vol) {
  if (opts && opts.quiet) return;
  VC.bus.emit('sfx', vol != null ? { name, x, z, vol } : { name, x, z });
}
function built(kind, box, key, cost, count, extra) {
  VC.bus.emit('built', Object.assign({ kind, x: box.x, z: box.z, w: box.w, d: box.d, key, cost, count }, extra || {}));
}
/**
 * Charges several [amount, category] parts atomically. When the total is unaffordable, VC.money.spend is asked
 * for it anyway: it refuses and emits bus 'noMoney' (the single owner of that event — never emit it here).
 */
function pay(parts) {
  let total = 0;
  for (const p of parts) total += Math.max(0, p[0]);
  if (!Number.isFinite(total)) {
    console.warn('[actions] bad cost', parts);
    return false;
  }
  if (total <= 0) return true;
  const sandbox = VC.state && VC.state.sandbox;
  if (!VC.money.canAfford(total)) {
    if (!VC.money.spend(total, parts[0][1])) return false; // emits 'noMoney'
    if (J && !sandbox) J.spent.push([total, parts[0][1]]); // (cannot happen: canAfford and spend agree)
    return true;
  }
  for (const p of parts) {
    if (!(p[0] > 0)) continue;
    VC.money.spend(p[0], p[1], true);
    if (J && !sandbox) J.spent.push([p[0], p[1]]);
  }
  return true;
}
/** Money check for plans (sandbox is always affordable). */
const affordable = (cost) => cost <= 0 || VC.money.canAfford(cost);

/* ------------------------------------------------------------------ */
/* Journal (undo)                                                        */
/* ------------------------------------------------------------------ */
let J = null; // record being written
let groupDepth = 0;
const history = [];

function jOpen(label) {
  if (J) return false;
  J = { label, t: 0, tiles: new Map(), added: [], removed: [], spent: [] };
  return true;
}
function jClose() {
  const r = J;
  J = null;
  if (!r || (!r.tiles.size && !r.added.length && !r.removed.length)) return;
  const S = VC.state;
  for (const [i, e] of r.tiles) e.post = snap(S, i);
  r.t = performance.now();
  history.push(r);
  while (history.length > UNDO_MAX) history.shift();
}
function snap(S, i) {
  return [S.height[i], S.terr[i], S.zone[i], S.road[i], S.pline[i], S.trees[i], S.bld[i]];
}
/** Records the pre-edit state of tile i (first touch wins). */
function touch(x, z) {
  if (!J) return;
  const S = VC.state, i = z * S.W + x;
  if (!J.tiles.has(i)) J.tiles.set(i, { pre: snap(S, i), post: null });
}
function touchRect(x, z, w, d) {
  if (!J) return;
  for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) if (W.inb(xx, zz)) touch(xx, zz);
}
/* journaled world setters */
const setH = (x, z, v) => { touch(x, z); W.setHeight(x, z, v); };
const setT = (x, z, v) => { touch(x, z); W.setTerr(x, z, v); };
const setZ = (x, z, v) => { touch(x, z); W.setZone(x, z, v); };
const setR = (x, z, v) => { touch(x, z); W.setRoad(x, z, v); };
const setP = (x, z, v) => { touch(x, z); W.setPowerLine(x, z, v); };
const setTr = (x, z, v) => { touch(x, z); W.setTrees(x, z, v); };
function addB(props, opts) {
  const def = VC.BLD[props.key];
  let w = props.w, d = props.d;
  if (w == null || d == null) {
    const sz = def ? def.size : [1, 1];
    w = props.rot & 1 ? sz[1] : sz[0];
    d = props.rot & 1 ? sz[0] : sz[1];
  }
  touchRect(props.x, props.z, w, d);
  const b = W.addBuilding(props, opts);
  if (b && J) J.added.push(b.id);
  return b;
}
function removeB(b, reason) {
  touchRect(b.x, b.z, b.w, b.d);
  W.removeBuilding(b, reason);
  if (!J) return;
  const k = J.added.indexOf(b.id);
  if (k >= 0) J.added.splice(k, 1); // added and removed within the same step
  else J.removed.push(b);
}
/** Runs fn inside its own journal record unless a group/record is already open. */
function journaled(label, fn) {
  const own = jOpen(label);
  try {
    return fn();
  } finally {
    if (own) jClose();
  }
}

/* ------------------------------------------------------------------ */
/* Brush                                                                 */
/* ------------------------------------------------------------------ */
/** Round brush tiles around (x,z): radius 0 = 1 tile, 1 = 3x3, 2 = 21 tiles, 3 = 37 tiles. */
function brushTiles(x, z, radius) {
  const out = [];
  if (!isInt(x) || !isInt(z)) return out;
  const r = M.clamp(radius | 0, 0, 3), lim = r * r + r;
  for (let dz = -r; dz <= r; dz++)
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > lim) continue;
      if (W.inb(x + dx, z + dz)) out.push({ x: x + dx, z: z + dz });
    }
  return out;
}

/* ------------------------------------------------------------------ */
/* Bridges                                                               */
/* ------------------------------------------------------------------ */
/**
 * Bridge rules for a road path (tiles already de-duplicated; status 3 = invalid position). Calls markBad(k, why)
 * for offending tiles. A "deck" tile after the build = a water tile that has a road or is a tile of this path.
 *  1. every run of consecutive touching water tiles in the path, plus the existing bridge that continues an open
 *     end of the run (followed around corners: farthest existing deck tile by walking distance), is at most
 *     MAX_BRIDGE tiles;
 *  2. no new deck tile ends up in a straight line (x or z) of more than MAX_BRIDGE deck tiles — this is what
 *     stops long bridges assembled from short segments (gaps filled afterwards, segments in line, …);
 *  3. every run must touch land or a road (no roads floating in open water).
 */
function bridgeCheck(S, tiles, status, markBad) {
  const n = tiles.length, SW = S.W;
  const TOO_LONG = 'Bridge too long (max ' + MAX_BRIDGE + ')';
  const path = new Set();
  for (let k = 0; k < n; k++) if (status[k] !== 3) path.add(tiles[k].z * SW + tiles[k].x);
  const water = (x, z) => S.height[z * SW + x] < C.SEA;
  const deck = (x, z) => W.inb(x, z) && water(x, z) && (S.road[z * SW + x] > 0 || path.has(z * SW + x));
  const oldDeck = (x, z) => W.inb(x, z) && water(x, z) && S.road[z * SW + x] > 0 && !path.has(z * SW + x);
  /** Tiles satisfying fn in a straight line from (x,z) (exclusive), capped just above the limit. */
  const walk = (x, z, dx, dz, fn) => {
    let c = 0;
    for (x += dx, z += dz; c <= MAX_BRIDGE && fn(x, z); x += dx, z += dz) c++;
    return c;
  };
  /**
   * Existing bridge continuing from tile (x,z): walking distance (BFS over existing deck tiles, never through
   * this path) to its farthest tile, capped just above the limit. 0 when (x,z) is not an existing deck tile.
   */
  const chain = (x, z) => {
    if (!oldDeck(x, z)) return 0;
    const seen = new Set([z * SW + x]);
    let front = [z * SW + x], depth = 1;
    while (depth <= MAX_BRIDGE) {
      const next = [];
      for (const i of front) {
        const cx = i % SW, cz = (i - cx) / SW;
        for (let d = 0; d < 4; d++) {
          const ax = cx + DX4[d], az = cz + DZ4[d];
          if (!oldDeck(ax, az) || seen.has(az * SW + ax)) continue;
          seen.add(az * SW + ax);
          next.push(az * SW + ax);
        }
      }
      if (!next.length) break;
      depth++;
      front = next;
    }
    return depth;
  };
  /** Existing bridges leaving tile t (not toward `back`), longest first. */
  const ext = (t, back) => {
    const v = [];
    for (let d = 0; d < 4; d++) {
      if (back && back.x === t.x + DX4[d] && back.z === t.z + DZ4[d]) continue;
      v.push(chain(t.x + DX4[d], t.z + DZ4[d]));
    }
    return v.sort((a, b) => b - a);
  };
  const isW = (k) => status[k] !== 3 && water(tiles[k].x, tiles[k].z);
  // 1 + 3: runs along the path
  for (let k = 0; k < n; ) {
    if (!isW(k)) { k++; continue; }
    let e = k;
    while (e + 1 < n && isW(e + 1) && adjacent(tiles[e], tiles[e + 1])) e++;
    // an end is "open" unless the path continues onto land right there
    const openS = !(k > 0 && status[k - 1] !== 3 && adjacent(tiles[k - 1], tiles[k]));
    const openE = !(e + 1 < n && status[e + 1] !== 3 && adjacent(tiles[e], tiles[e + 1]));
    const len = e - k + 1;
    let total = len;
    if (len === 1 && openS && openE) {
      const v = ext(tiles[k], null);
      total += v[0] + v[1];
    } else {
      if (openS) total += ext(tiles[k], len > 1 ? tiles[k + 1] : null)[0];
      if (openE) total += ext(tiles[e], len > 1 ? tiles[e - 1] : null)[0];
    }
    let anchored = !openS || !openE;
    for (let q = k; q <= e && !anchored; q++) {
      const t = tiles[q];
      if (S.road[t.z * SW + t.x]) anchored = true; // already part of the road network
      for (let d = 0; d < 4 && !anchored; d++) {
        const nx = t.x + DX4[d], nz = t.z + DZ4[d];
        if (W.inb(nx, nz) && (!water(nx, nz) || S.road[nz * SW + nx])) anchored = true;
      }
    }
    if (!anchored) for (let q = k; q <= e; q++) markBad(q, 'Bridges must start at land or a road');
    else if (total > MAX_BRIDGE) for (let q = k; q <= e; q++) markBad(q, TOO_LONG);
    k = e + 1;
  }
  // 2: straight deck lines through every new water tile
  for (let k = 0; k < n; k++) {
    if (!isW(k)) continue; // (also skips tiles rule 1 already rejected)
    const t = tiles[k];
    if (S.road[t.z * SW + t.x]) continue; // existing deck: its lines only grow through new tiles (checked)
    if (1 + walk(t.x, t.z, 1, 0, deck) + walk(t.x, t.z, -1, 0, deck) > MAX_BRIDGE || 1 + walk(t.x, t.z, 0, 1, deck) + walk(t.x, t.z, 0, -1, deck) > MAX_BRIDGE) markBad(k, TOO_LONG);
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                               */
/* ------------------------------------------------------------------ */
const A = (VC.actions = {
  UNDO_SEC,
  MAX_BRIDGE,
  DECK_LVL,

  init() {},
  reset() {
    history.length = 0;
    J = null;
    groupDepth = 0;
  },

  brushTiles,

  /* ================= ROADS ================= */
  /**
   * Tile path from (x0,z0) to (x1,z1): L-shaped along the longer axis first, then the other;
   * straight = only along the dominant axis. Out-of-map tiles are dropped.
   */
  roadPath(x0, z0, x1, z1, straight) {
    const out = [];
    const S = VC.state;
    if (!S || !isInt(x0) || !isInt(z0) || !isInt(x1) || !isInt(z1)) return out;
    const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
    if (straight) {
      if (alongX) z1 = z0;
      else x1 = x0;
    }
    // clamp to one tile outside the map: same on-map tiles, bounded loops for absurd inputs
    x0 = M.clamp(x0, -1, S.W); x1 = M.clamp(x1, -1, S.W);
    z0 = M.clamp(z0, -1, S.H); z1 = M.clamp(z1, -1, S.H);
    const push = (x, z) => { if (W.inb(x, z)) out.push({ x, z }); };
    const sx = Math.sign(x1 - x0), sz = Math.sign(z1 - z0);
    if (alongX) {
      for (let x = x0; ; x += sx) { push(x, z0); if (x === x1) break; }
      if (z1 !== z0) for (let z = z0 + sz; ; z += sz) { push(x1, z); if (z === z1) break; }
    } else {
      for (let z = z0; ; z += sz) { push(x0, z); if (z === z1) break; }
      if (x1 !== x0) for (let x = x0 + sx; ; x += sx) { push(x, z1); if (x === x1) break; }
    }
    return out;
  },

  /**
   * Validates a road path. status per tile: 0 new, 1 existing (skipped), 2 upgrade, 3 bad.
   * levels = planned road level per tile (bridges = DECK_LVL).
   */
  canBuildRoad(tiles, type) {
    const S = VC.state;
    tiles = S ? uniqTiles(tiles) : [];
    const n = tiles.length;
    const res = { ok: false, cost: 0, reason: '', bad: [], count: 0, upgrades: 0, bridges: 0, leveled: 0, roadCost: 0, levelCost: 0, status: new Uint8Array(n), levels: new Int16Array(n), money: false, type, tiles };
    const rd = roadDef(type);
    if (!S || !rd) { res.reason = 'Unknown road type'; return res; }
    if (!n) { res.reason = 'Nothing to build'; return res; }
    const m = mul();
    const locked = !W.isUnlocked(rd.key);
    const fixed = new Uint8Array(n);
    const reasons = [];
    const markBad = (k, why) => {
      if (res.status[k] !== 3) { res.status[k] = 3; res.bad.push(k); }
      reasons.push(why);
    };
    for (let k = 0; k < n; k++) {
      const why = tileReason(tiles[k]);
      if (why) markBad(k, why);
    }
    bridgeCheck(S, tiles, res.status, markBad);
    for (let k = 0; k < n; k++) {
      const { x, z } = tiles[k];
      if (tileReason(tiles[k])) continue;
      const i = z * S.W + x, h = S.height[i], water = h < C.SEA, rt = S.road[i];
      res.levels[k] = water ? DECK_LVL : h;
      if (rt >= type) { res.status[k] = res.status[k] === 3 ? 3 : 1; fixed[k] = 1; continue; }
      const id = S.bld[i];
      if (id) {
        const b = S.buildings.get(id);
        if (b && !isRubble(b)) { markBad(k, 'Blocked by building'); fixed[k] = 1; continue; }
      }
      if (locked) { markBad(k, lockReason(rd.unlock)); continue; }
      if (res.status[k] === 3) continue;
      if (water || rt) fixed[k] = 1; // bridge decks sit at DECK_LVL; upgrades keep the existing grade
      res.status[k] = rt ? 2 : 0;
      const base = rt ? rd.cost - VC.ROADS[rt].cost : rd.cost;
      res.roadCost += Math.max(0, base) * (water ? C.BRIDGE_MUL : 1);
      res.count++;
      if (rt) res.upgrades++;
      if (water) res.bridges++;
    }
    // ramps: neighbouring road levels may differ by at most 1 — relax toward the neighbours
    // (only consecutive tiles that really touch: callers may pass arbitrary tile lists)
    const L = res.levels;
    const link = new Uint8Array(n); // link[k] = tiles k-1 and k are valid 4-neighbours
    for (let k = 1; k < n; k++) link[k] = !tileReason(tiles[k]) && !tileReason(tiles[k - 1]) && adjacent(tiles[k], tiles[k - 1]) ? 1 : 0;
    for (let it = 0; it < 4; it++) {
      for (let k = 1; k < n; k++) if (link[k] && !fixed[k]) L[k] = Math.max(C.SEA, M.clamp(L[k], L[k - 1] - 1, L[k - 1] + 1));
      for (let k = n - 2; k >= 0; k--) if (link[k + 1] && !fixed[k]) L[k] = Math.max(C.SEA, M.clamp(L[k], L[k + 1] - 1, L[k + 1] + 1));
    }
    for (let k = 1; k < n; k++) {
      if (link[k] && Math.abs(L[k] - L[k - 1]) > 1) {
        if (!fixed[k]) markBad(k, 'Too steep');
        else if (!fixed[k - 1]) markBad(k - 1, 'Too steep');
        else if (res.status[k] !== 1 || res.status[k - 1] !== 1) markBad(res.status[k] !== 1 ? k : k - 1, 'Too steep');
      }
    }
    for (let k = 0; k < n; k++) {
      if (fixed[k] || res.status[k] === 3) continue;
      const t = tiles[k], h = S.height[t.z * S.W + t.x];
      if (L[k] !== h) {
        res.leveled++;
        res.levelCost += Math.abs(L[k] - h) * C.TERRAFORM_COST;
      }
    }
    res.roadCost *= m;
    res.levelCost *= m;
    res.cost = res.roadCost + res.levelCost;
    if (res.bad.length) res.reason = reasons[0];
    else if (!res.count) res.reason = 'Already built';
    else if (!affordable(res.cost)) { res.reason = 'Not enough money'; res.money = true; }
    else res.ok = true;
    return res;
  },

  buildRoad(tiles, type, opts) {
    const S = VC.state;
    if (!S) return fail('No city');
    const p = A.canBuildRoad(tiles, type);
    if (!p.ok && !p.money) return fail(p.reason, { plan: p });
    const rd = roadDef(type);
    return journaled('Road', () => {
      if (!pay([[p.roadCost, 'roads'], [p.levelCost, 'terraform']])) return fail('Not enough money', { plan: p });
      const tiles = p.tiles; // de-duplicated
      for (let k = 0; k < tiles.length; k++) {
        const st = p.status[k];
        if (st === 1 || st === 3) continue;
        const { x, z } = tiles[k];
        const i = z * S.W + x;
        const b = S.bld[i] ? S.buildings.get(S.bld[i]) : null;
        if (isRubble(b)) removeB(b, REM.BULLDOZE);
        if (S.height[i] >= C.SEA && p.levels[k] !== S.height[i]) setH(x, z, p.levels[k]);
        setR(x, z, type);
      }
      const box = tilesBox(tiles);
      built('road', box, rd.key, p.cost, p.count, { bridges: p.bridges });
      const mid = tiles[tiles.length >> 1];
      sfx('road', mid.x + 0.5, mid.z + 0.5, opts);
      return { ok: true, cost: p.cost, count: p.count, bridges: p.bridges };
    });
  },

  /* ================= ZONES ================= */
  /**
   * status per rect tile (row-major): 0 invalid/skip, 1 will be (re)zoned, 2 already this zone, 3 will be dezoned.
   * Painting over growables of the SAME zone type at another density re-zones their lots (charged like any
   * zoning): the building stays and the sim redevelops it to the new density (up- or down-zoning) over time.
   * Other buildings, roads, water and power lines are skipped. code must be 0 (dezone) or a VC.ZONE_TOOLS code.
   */
  canZone(x0, z0, x1, z1, code) {
    const S = VC.state;
    const r = clipRect(x0, z0, x1, z1);
    const res = { ok: false, cost: 0, reason: '', count: 0, rect: r, status: null, remove: [], fee: 0, code, money: false };
    if (!S) { res.reason = 'No city'; return res; }
    if (!r) { res.reason = rectReason(x0, z0, x1, z1); return res; }
    res.status = new Uint8Array(r.w * r.d);
    if (!isInt(code) || (code && !VC.ZONE_TOOLS.some((t) => t.code === code))) { res.reason = 'Unknown zone'; return res; }
    const m = mul();
    if (!code) {
      const seen = new Set();
      for (let z = r.z0; z <= r.z1; z++)
        for (let x = r.x0; x <= r.x1; x++) {
          const i = z * S.W + x, k = (z - r.z0) * r.w + (x - r.x0);
          if (S.zone[i]) { res.status[k] = 3; res.count++; }
          const id = S.bld[i];
          if (id && !seen.has(id)) {
            seen.add(id);
            const b = S.buildings.get(id);
            if (b && b.key === 'grow') { res.remove.push(b); res.fee += GROW_DEMOLISH * b.w * b.d; }
          }
        }
      res.fee *= m;
      res.cost = res.fee;
      if (!res.count && !res.remove.length) res.reason = 'Nothing to dezone';
      else if (!affordable(res.cost)) { res.reason = 'Not enough money'; res.money = true; }
      else res.ok = true;
      return res;
    }
    const zt = VC.ZONE_TOOLS.find((t) => t.code === code);
    if (!zt) { res.reason = 'Unknown zone'; return res; }
    const type = VC.ztype(code), den = VC.zden(code);
    const locked = !W.isUnlocked(zt.key);
    let blocked = 0;
    for (let z = r.z0; z <= r.z1; z++)
      for (let x = r.x0; x <= r.x1; x++) {
        const i = z * S.W + x, k = (z - r.z0) * r.w + (x - r.x0);
        if (S.height[i] < C.SEA || S.road[i] || S.pline[i]) { blocked++; continue; }
        if (S.bld[i]) {
          const b = S.buildings.get(S.bld[i]);
          if (!b || b.key !== 'grow' || b.zt !== type) { blocked++; continue; }
        }
        if (S.zone[i] === code) { res.status[k] = 2; continue; }
        res.status[k] = 1;
        res.count++;
      }
    res.cost = res.count * C.ZONE_COST * den * m;
    if (locked) res.reason = lockReason(zt.unlock);
    else if (!res.count) res.reason = blocked && !res.status.some((s) => s === 2) ? 'Nothing to zone here' : 'Already zoned';
    else if (!affordable(res.cost)) { res.reason = 'Not enough money'; res.money = true; }
    else res.ok = true;
    return res;
  },

  zone(x0, z0, x1, z1, code, opts) {
    const S = VC.state;
    if (!S) return fail('No city');
    const p = A.canZone(x0, z0, x1, z1, code);
    if (!p.ok && !p.money) return fail(p.reason, { plan: p });
    const r = p.rect;
    const box = { x: r.x0, z: r.z0, w: r.w, d: r.d };
    return journaled(code ? 'Zoning' : 'Dezoning', () => {
      if (!pay([[p.cost, code ? 'zoning' : 'demolish']])) return fail('Not enough money', { plan: p });
      for (const b of p.remove) removeB(b, REM.BULLDOZE);
      for (let z = r.z0; z <= r.z1; z++)
        for (let x = r.x0; x <= r.x1; x++) {
          const st = p.status[(z - r.z0) * r.w + (x - r.x0)];
          if (st === 1) setZ(x, z, code);
          else if (st === 3) setZ(x, z, 0);
        }
      const zt = VC.ZONE_TOOLS.find((t) => t.code === code);
      built('zone', box, zt ? zt.key : 'dezone', p.cost, p.count, { code, removed: p.remove.length });
      sfx(code ? 'zone' : 'dezone', r.x0 + r.w / 2, r.z0 + r.d / 2, opts);
      return { ok: true, cost: p.cost, count: p.count, removed: p.remove.length };
    });
  },

  /* ================= BUILDINGS ================= */
  /** Footprint of a catalog building at rotation rot -> [w, d]. */
  footprint(key, rot) {
    const def = bldDef(key);
    const sz = def ? def.size : [1, 1];
    return rot & 1 ? [sz[1], sz[0]] : [sz[0], sz[1]];
  },

  canPlace(key, x, z, rot) {
    const S = VC.state;
    const def = bldDef(key);
    rot = (rot | 0) & 3;
    const [w, d] = A.footprint(key, rot);
    const res = { ok: false, reason: '', cost: 0, w, d, flattenCost: 0, level: 0, warn: '', money: false, key, x, z, rot };
    if (!S || !def) { res.reason = 'Unknown building'; return res; }
    if (!isInt(x) || !isInt(z)) { res.reason = BAD_POS; return res; }
    const m = mul();
    res.cost = def.cost * m;
    // hard gates first (they explain the red ghost best)
    if (!W.isUnlocked(key)) { res.reason = lockReason(def.unlock); return res; }
    if (def.requiresPolicy && !(S.policies && S.policies[def.requiresPolicy])) {
      const pol = VC.POLICY[def.requiresPolicy];
      res.reason = 'Requires policy: ' + (pol ? pol.name : def.requiresPolicy);
      return res;
    }
    if (def.unique && W.count(key) > 0) { res.reason = 'Already built (only one allowed)'; return res; }
    if (x < 0 || z < 0 || x + w > S.W || z + d > S.H) { res.reason = 'Out of bounds'; return res; }
    let lo = 99, hi = -1, sum = 0, why = '';
    for (let zz = z; zz < z + d; zz++)
      for (let xx = x; xx < x + w; xx++) {
        const i = zz * S.W + xx, h = S.height[i];
        if (h < C.SEA) { why = why || (def.needsWater ? 'Must be on land beside water' : 'Must be on dry land'); continue; }
        if (S.road[i]) { why = why || 'Blocked by road'; continue; }
        if (S.bld[i]) {
          const b = S.buildings.get(S.bld[i]);
          if (b && !isRubble(b)) { why = why || 'Blocked by building'; continue; }
        }
        if (h < lo) lo = h;
        if (h > hi) hi = h;
        sum += h;
      }
    if (why) { res.reason = why; return res; }
    if (hi - lo > MAX_STEEP) { res.reason = 'Too steep'; return res; }
    if (def.needsWater) {
      let near = false;
      for (let xx = x; xx < x + w && !near; xx++) near = (z > 0 && W.isWater(xx, z - 1)) || (z + d < S.H && W.isWater(xx, z + d));
      for (let zz = z; zz < z + d && !near; zz++) near = (x > 0 && W.isWater(x - 1, zz)) || (x + w < S.W && W.isWater(x + w, zz));
      if (!near) { res.reason = 'Needs water nearby'; return res; }
    }
    // flatten to the rounded mean level (cheapest), never below the sea
    const L = Math.max(C.SEA, M.clamp(Math.round(sum / (w * d)), lo, hi));
    let dl = 0;
    for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) dl += Math.abs(S.height[zz * S.W + xx] - L);
    res.level = L;
    res.flattenCost = dl * C.TERRAFORM_COST * m;
    res.cost += res.flattenCost;
    const needsRoad = VC.sim && VC.sim.needsRoadAccess ? VC.sim.needsRoadAccess(key) : true;
    if (needsRoad && !W.roadAdjacent(x, z, w, d)) res.warn = 'No road access';
    if (!affordable(res.cost)) { res.reason = 'Not enough money'; res.money = true; return res; }
    res.ok = true;
    return res;
  },

  placeBuilding(key, x, z, rot, opts) {
    const S = VC.state;
    if (!S) return fail('No city');
    rot = (rot | 0) & 3;
    const p = A.canPlace(key, x, z, rot);
    if (!p.ok && !p.money) return fail(p.reason, { plan: p });
    const def = bldDef(key);
    return journaled(def.name, () => {
      const spent0 = J ? J.spent.length : 0;
      if (!pay([[p.cost - p.flattenCost, 'construction'], [p.flattenCost, 'terraform']])) return fail('Not enough money', { plan: p });
      const { w, d } = p;
      // clear the lot: rubble, power lines (buildings conduct), then grade it
      const seen = new Set();
      for (let zz = z; zz < z + d; zz++)
        for (let xx = x; xx < x + w; xx++) {
          const i = zz * S.W + xx;
          const id = S.bld[i];
          if (id && !seen.has(id)) {
            seen.add(id);
            const rb = S.buildings.get(id);
            if (isRubble(rb)) removeB(rb, REM.REPLACE);
          }
          if (S.pline[i]) setP(xx, zz, 0);
          if (S.height[i] !== p.level) setH(xx, zz, p.level);
        }
      const b = addB({ key, x, z, rot }, { noFlatten: true });
      if (!b) {
        // the world refused the footprint (cannot happen after canPlace): give the money back
        if (J) for (const [amt] of J.spent.splice(spent0)) VC.money.earn(amt, 'refund');
        return fail('Cannot build here', { plan: p });
      }
      const box = { x, z, w, d };
      built('building', box, key, p.cost, 1, { id: b.id });
      sfx('build', x + w / 2, z + d / 2, opts);
      return { ok: true, cost: p.cost, b };
    });
  },

  /* ================= BULLDOZE ================= */
  canBulldoze(x0, z0, x1, z1, opts) {
    const S = VC.state;
    const o = Object.assign({ buildings: true, roads: true, trees: true, plines: true, zones: false }, opts || {});
    // ids: restrict building demolition to these building ids (others in the rectangle are left alone)
    const ids = o.ids == null ? null : new Set(Array.isArray(o.ids) || o.ids instanceof Set ? o.ids : [o.ids]);
    const r = clipRect(x0, z0, x1, z1);
    const res = { ok: false, cost: 0, reason: '', rect: r, buildings: [], roads: 0, trees: 0, plines: 0, zones: 0, rubble: 0, count: 0, money: false, opts: o };
    if (!S) { res.reason = 'No city'; return res; }
    if (!r) { res.reason = rectReason(x0, z0, x1, z1); return res; }
    const seen = new Set();
    let cost = 0;
    for (let z = r.z0; z <= r.z1; z++)
      for (let x = r.x0; x <= r.x1; x++) {
        const i = z * S.W + x;
        const id = S.bld[i];
        if (o.buildings && id && !seen.has(id) && (!ids || ids.has(id))) {
          seen.add(id);
          const b = S.buildings.get(id);
          if (b) {
            res.buildings.push(b);
            if (isRubble(b)) res.rubble++;
            else if (b.key === 'grow') cost += GROW_DEMOLISH * b.w * b.d;
            else cost += C.DEMOLISH_COST * ((VC.BLD[b.key] || {}).cost || 0);
          }
        }
        if (o.roads && S.road[i]) { res.roads++; cost += ROAD_DEMOLISH; }
        if (o.trees && S.trees[i] && !S.bld[i]) { res.trees += S.trees[i]; cost += TREE_DEMOLISH * S.trees[i]; }
        if (o.plines && S.pline[i]) { res.plines++; cost += PLINE_DEMOLISH; }
        if (o.zones && S.zone[i]) res.zones++;
      }
    res.cost = cost * mul();
    res.count = res.buildings.length + res.roads + res.trees + res.plines + res.zones;
    if (!res.count) res.reason = 'Nothing to bulldoze';
    else if (!affordable(res.cost)) { res.reason = 'Not enough money'; res.money = true; }
    else res.ok = true;
    return res;
  },

  bulldoze(x0, z0, x1, z1, opts) {
    const S = VC.state;
    if (!S) return fail('No city');
    const p = A.canBulldoze(x0, z0, x1, z1, opts);
    if (!p.ok && !p.money) return fail(p.reason, { plan: p });
    const r = p.rect, o = p.opts;
    return journaled('Bulldoze', () => {
      if (!pay([[p.cost, 'demolish']])) return fail('Not enough money', { plan: p });
      let bx0 = r.x0, bz0 = r.z0, bx1 = r.x1, bz1 = r.z1, big = 0;
      for (const b of p.buildings) {
        bx0 = Math.min(bx0, b.x); bz0 = Math.min(bz0, b.z);
        bx1 = Math.max(bx1, b.x + b.w - 1); bz1 = Math.max(bz1, b.z + b.d - 1);
        if (!isRubble(b)) big = Math.max(big, b.w * b.d);
        removeB(b, REM.BULLDOZE);
      }
      for (let z = r.z0; z <= r.z1; z++)
        for (let x = r.x0; x <= r.x1; x++) {
          const i = z * S.W + x;
          if (o.roads && S.road[i]) setR(x, z, 0);
          if (o.trees && S.trees[i] && !S.bld[i]) setTr(x, z, 0);
          if (o.plines && S.pline[i]) setP(x, z, 0);
          if (o.zones && S.zone[i]) setZ(x, z, 0);
        }
      if (big >= 9 && VC.camera && VC.camera.shake) VC.camera.shake(Math.min(0.35, big * 0.02));
      const box = { x: bx0, z: bz0, w: bx1 - bx0 + 1, d: bz1 - bz0 + 1 };
      built('bulldoze', box, 'bulldoze', p.cost, p.count, { buildings: p.buildings.length, roads: p.roads, trees: p.trees, plines: p.plines });
      sfx(big >= 9 ? 'demolish' : 'bulldoze', r.x0 + r.w / 2, r.z0 + r.d / 2, opts);
      return { ok: true, cost: p.cost, count: p.count, buildings: p.buildings.length, roads: p.roads, trees: p.trees, plines: p.plines };
    });
  },

  /* ================= POWER LINES ================= */
  /** status per tile of plan.tiles (input minus duplicates): 0 new, 1 existing, 3 bad. Crosses roads, not buildings or water. */
  canPowerLine(tiles) {
    const S = VC.state;
    tiles = S ? uniqTiles(tiles) : [];
    const n = tiles.length;
    const res = { ok: false, cost: 0, reason: '', bad: [], count: 0, status: new Uint8Array(n), money: false, tiles };
    if (!S || !n) { res.reason = 'Nothing to build'; return res; }
    let why = '';
    for (let k = 0; k < n; k++) {
      const { x, z } = tiles[k];
      const bad = (w) => { res.status[k] = 3; res.bad.push(k); why = why || w; };
      const tr = tileReason(tiles[k]);
      if (tr) { bad(tr); continue; }
      const i = z * S.W + x;
      if (S.height[i] < C.SEA) { bad('Cannot cross water'); continue; }
      if (S.bld[i]) {
        const b = S.buildings.get(S.bld[i]);
        if (b && !isRubble(b)) { bad('Blocked by building'); continue; }
      }
      if (S.pline[i]) { res.status[k] = 1; continue; }
      res.count++;
    }
    res.cost = res.count * C.PLINE_COST * mul();
    if (why) res.reason = why;
    else if (!res.count) res.reason = 'Already built';
    else if (!affordable(res.cost)) { res.reason = 'Not enough money'; res.money = true; }
    else res.ok = true;
    return res;
  },

  powerLine(tiles, opts) {
    const S = VC.state;
    if (!S) return fail('No city');
    const p = A.canPowerLine(tiles);
    if (!p.ok && !p.money) return fail(p.reason, { plan: p });
    return journaled('Power line', () => {
      if (!pay([[p.cost, 'pline']])) return fail('Not enough money', { plan: p });
      const tiles = p.tiles; // de-duplicated
      for (let k = 0; k < tiles.length; k++) {
        if (p.status[k] !== 0) continue;
        const { x, z } = tiles[k];
        const i = z * S.W + x;
        const b = S.bld[i] ? S.buildings.get(S.bld[i]) : null;
        if (isRubble(b)) removeB(b, REM.BULLDOZE);
        if (S.trees[i]) setTr(x, z, 0);
        setP(x, z, 1);
      }
      const box = tilesBox(tiles);
      built('pline', box, 'pline', p.cost, p.count);
      const mid = tiles[tiles.length >> 1];
      sfx('pline', mid.x + 0.5, mid.z + 0.5, opts);
      return { ok: true, cost: p.cost, count: p.count };
    });
  },

  /* ================= TREES ================= */
  /** True if a tree can be added on tile i (empty dry non-rock land, not zoned, < 3 trees). */
  canTreeAt(i) {
    const S = VC.state;
    return S.height[i] >= C.SEA && !S.road[i] && !S.bld[i] && !S.zone[i] && !S.pline[i] && S.terr[i] !== VC.TERR.ROCK && S.trees[i] < 3;
  },
  /**
   * opts.tiles: explicit tile list (brush) instead of the rectangle; invalid / off-map entries are ignored and a
   * tile listed twice still gets one tree. plan.tiles = the plantable tiles.
   */
  canPlantTrees(x0, z0, x1, z1, opts) {
    const S = VC.state;
    const res = { ok: false, cost: 0, reason: '', count: 0, tiles: [], money: false };
    if (!S) { res.reason = 'No city'; return res; }
    let list = opts && opts.tiles;
    if (list) list = uniqTiles(list);
    else {
      const r = clipRect(x0, z0, x1, z1);
      if (!r) { res.reason = rectReason(x0, z0, x1, z1); return res; }
      list = [];
      for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) list.push({ x, z });
    }
    for (const t of list) {
      if (tileReason(t)) continue;
      if (A.canTreeAt(t.z * S.W + t.x)) res.tiles.push({ x: t.x, z: t.z });
    }
    res.count = res.tiles.length;
    res.cost = res.count * C.TREE_COST * mul();
    if (!res.count) res.reason = 'No room for trees';
    else if (!affordable(res.cost)) { res.reason = 'Not enough money'; res.money = true; }
    else res.ok = true;
    return res;
  },

  plantTrees(x0, z0, x1, z1, opts) {
    const S = VC.state;
    if (!S) return fail('No city');
    const p = A.canPlantTrees(x0, z0, x1, z1, opts);
    if (!p.ok && !p.money) return fail(p.reason, { plan: p });
    return journaled('Trees', () => {
      if (!pay([[p.cost, 'trees']])) return fail('Not enough money', { plan: p });
      for (const t of p.tiles) setTr(t.x, t.z, S.trees[t.z * S.W + t.x] + 1);
      const box = tilesBox(p.tiles);
      built('trees', box, 'trees', p.cost, p.count);
      const c = p.tiles[p.tiles.length >> 1];
      sfx('plant', c.x + 0.5, c.z + 0.5, opts);
      return { ok: true, cost: p.cost, count: p.count };
    });
  },

  /* ================= TERRAFORM ================= */
  /**
   * Plan for a terraform brush. tiles: [{x, z, from, to}] (to === from when skipped: buildings/roads).
   * level mode: target level (clamped 0..MAXH).
   */
  canTerraform(x, z, radius, mode, level) {
    const S = VC.state;
    const res = { ok: false, cost: 0, reason: '', count: 0, levels: 0, tiles: [], skipped: 0, mode, level: 0, money: false };
    if (!S) { res.reason = 'No city'; return res; }
    if (!isInt(x) || !isInt(z)) { res.reason = BAD_POS; return res; }
    if (!W.inb(x, z)) { res.reason = 'Out of bounds'; return res; }
    if (!TERRAFORM_MODES.has(mode)) { res.reason = 'Unknown terraform mode'; return res; }
    if (level != null && !Number.isFinite(level)) { res.reason = 'Invalid level'; return res; }
    const lv = M.clamp(level == null ? S.height[z * S.W + x] : Math.round(level), 0, C.MAXH);
    res.level = lv;
    for (const t of brushTiles(x, z, radius)) {
      const i = t.z * S.W + t.x, h = S.height[i];
      let to = h;
      if (S.bld[i] || S.road[i]) { res.skipped++; res.tiles.push({ x: t.x, z: t.z, from: h, to: h, skip: true }); continue; }
      if (mode === 'raise') to = Math.min(C.MAXH, h + 1);
      else if (mode === 'lower') to = Math.max(0, h - 1);
      else if (mode === 'level') to = lv;
      res.tiles.push({ x: t.x, z: t.z, from: h, to, skip: false });
      if (to !== h) { res.count++; res.levels += Math.abs(to - h); }
    }
    res.cost = res.levels * C.TERRAFORM_COST * mul();
    if (!res.count) res.reason = res.skipped && res.skipped === res.tiles.length ? 'Blocked by buildings/roads' : mode === 'level' ? 'Already level' : mode === 'raise' ? 'Maximum height' : 'Minimum depth';
    else if (!affordable(res.cost)) { res.reason = 'Not enough money'; res.money = true; }
    else res.ok = true;
    return res;
  },

  terraform(x, z, radius, mode, level, opts) {
    const S = VC.state;
    if (!S) return fail('No city');
    const p = A.canTerraform(x, z, radius, mode, level);
    if (!p.ok && !p.money) return fail(p.reason, { plan: p });
    return journaled('Terraform', () => {
      if (!pay([[p.cost, 'terraform']])) return fail('Not enough money', { plan: p });
      const TR = VC.TERR;
      const changed = [];
      for (const t of p.tiles) {
        if (t.skip || t.to === t.from) continue;
        setH(t.x, t.z, t.to);
        changed.push(t);
        const i = t.z * S.W + t.x;
        if (t.to < C.SEA) {
          // flooded: nothing survives under water
          if (S.zone[i]) setZ(t.x, t.z, 0);
          if (S.trees[i]) setTr(t.x, t.z, 0);
          if (S.pline[i]) setP(t.x, t.z, 0);
        }
      }
      // materials: new land from the sea is sand, dug/raised land is dirt, steep faces are rock
      for (const t of changed) {
        const i = t.z * S.W + t.x, h = S.height[i];
        let m;
        if (h < C.SEA) m = TR.SAND;
        else {
          let steep = 0, wet = false;
          for (let k = 0; k < 4; k++) {
            const nx = t.x + DX4[k], nz = t.z + DZ4[k];
            if (!W.inb(nx, nz)) continue;
            const nh = S.height[nz * S.W + nx];
            steep = Math.max(steep, Math.abs(nh - h));
            if (nh < C.SEA) wet = true;
          }
          m = steep >= 3 ? TR.ROCK : t.from < C.SEA || (wet && h <= C.SEA + 1) ? TR.SAND : TR.DIRT;
        }
        setT(t.x, t.z, m);
      }
      const box = tilesBox(p.tiles);
      built('terraform', box, mode, p.cost, p.count, { level: p.level });
      sfx('terraform', x + 0.5, z + 0.5, opts);
      return { ok: true, cost: p.cost, count: p.count, levels: p.levels };
    });
  },

  /* ================= UNDO ================= */
  /** Opens a journal group: every commit until endGroup() becomes ONE undo step. */
  beginGroup(label) {
    if (groupDepth++ === 0) jOpen(label || 'Edit');
  },
  endGroup() {
    if (groupDepth <= 0) return;
    if (--groupDepth === 0) jClose();
  },
  canUndo() {
    const r = history[history.length - 1];
    if (!r) return { ok: false, reason: 'Nothing to undo' };
    const age = (performance.now() - r.t) / 1000;
    if (age > UNDO_SEC) return { ok: false, reason: 'Nothing to undo', label: r.label, age };
    return { ok: true, label: r.label, age };
  },
  /** Reverts the most recent step if nothing has touched its tiles/buildings since. */
  undo() {
    const S = VC.state;
    if (!S || J) return fail('Busy');
    const can = A.canUndo();
    if (!can.ok) { if (history.length && can.age > UNDO_SEC) history.length = 0; return fail(can.reason); }
    const r = history.pop();
    // validate: the world must be exactly as the step left it
    for (const [i, e] of r.tiles) {
      const cur = snap(S, i);
      for (let k = 0; k < cur.length; k++) if (cur[k] !== e.post[k]) return fail('Can’t undo — the city changed there');
    }
    for (const id of r.added) if (!S.buildings.has(id)) return fail('Can’t undo — the city changed there');
    for (const b of r.removed) if (S.buildings.has(b.id)) return fail('Can’t undo — the city changed there');
    // 1) remove what the step added
    for (const id of r.added) W.removeBuilding(id, REM.UNDO);
    // 2) bring back what it removed (same id, runtime fields of other modules stripped so they re-init)
    for (const b of r.removed) {
      const props = {};
      for (const k in b) if (k !== 'removed' && !k.startsWith('sim') && k[0] !== '_') props[k] = b[k];
      W.addBuilding(props, { noFlatten: true, instant: true });
    }
    // 3) restore tile layers (roads first: setRoad clears zones/trees on road tiles)
    for (const [i, e] of r.tiles) {
      const x = i % S.W, z = (i - x) / S.W, pre = e.pre;
      if (S.road[i] !== pre[3]) W.setRoad(x, z, pre[3]);
      W.setHeight(x, z, pre[0]);
      W.setTerr(x, z, pre[1]);
      W.setZone(x, z, pre[2]);
      W.setPowerLine(x, z, pre[4]);
      W.setTrees(x, z, pre[5]);
    }
    // 4) refund — booked as 'refund' (not as income of the original category), so spending stats and
    //    achievements can tell an undone expense from real income
    let refund = 0;
    for (const [amt] of r.spent) {
      VC.money.earn(amt, 'refund');
      refund += amt;
    }
    VC.bus.emit('sfx', { name: 'whoosh' });
    return { ok: true, cost: -refund, refund, label: r.label };
  },
  /** Drops the undo history (e.g. after loading a game). */
  clearUndo() {
    history.length = 0;
  },
});
