/*
 * VOXELPOLIS — game state layout and the WORLD API.
 *
 * ALL mutations of tile layers and buildings go through VC.world so that renderers
 * and the simulation get consistent change notifications:
 *   bus 'dirty'     {x0,z0,x1,z1}   tiles changed (height/terrain/road/zone/pline/trees) — inclusive rect
 *   bus 'bldAdd'    building
 *   bus 'bldRemove' building
 *   bus 'bldChange' building        (level/abandon/fire/model-affecting change)
 *   bus 'money'     {amount, cat, balance}
 *
 * The current state is VC.state (also VC.world.S).
 */

/** Creates an empty state object. worldgen fills terrain afterwards. */
VC.createState = function (opts = {}) {
  const size = opts.size || VC.MAP_SIZES.medium;
  const W = size, H = size, N = W * H;
  const diff = VC.DIFFICULTY[opts.difficulty || 'normal'] || VC.DIFFICULTY.normal;
  const maps = {};
  for (const k of VC.MAP_KEYS) maps[k] = new Uint8Array(N);
  const budget = {};
  for (const d of VC.DEPARTMENTS) budget[d.key] = 1.0;
  const S = {
    version: 1,
    W, H, N,
    seed: opts.seed >>> 0 || 1,
    name: opts.name || 'New Voxelpolis',
    mapType: opts.mapType || 'river',
    difficulty: opts.difficulty || 'normal',
    sandbox: !!diff.unlockAll,

    // ---- tile layers (index = z * W + x) ----
    height: new Uint8Array(N), // terrain level 0..MAXH
    terr: new Uint8Array(N), // VC.TERR material
    zone: new Uint8Array(N), // zone code (VC.zcode)
    road: new Uint8Array(N), // VC.ROAD type
    pline: new Uint8Array(N), // 1 = power line
    trees: new Uint8Array(N), // 0 none, 1..3 = tree count/density
    bld: new Int32Array(N), // building id occupying tile, 0 = none
    flags: new Uint16Array(N), // VC.F bits (maintained by sim)
    maps, // derived Uint8 maps: VC.MAP_KEYS

    // ---- entities ----
    buildings: new Map(), // id -> building
    nextId: 1,

    // ---- time ----
    time: { day: 90, tod: 0.32, speed: 1 }, // day 90 = April 1st of START_YEAR

    // ---- economy ----
    money: diff.money,
    tax: { R: [9, 9, 9], C: [9, 9, 9], I: [9, 9, 9] }, // % per wealth level (low, mid, high)
    budget, // department funding 0..1.5
    policies: {}, // key -> true when active
    loans: [], // {amount, remaining, rate, monthly, months}
    ledger: { month: {}, last: {} }, // category -> $ this month / last month (econ fills)

    // ---- simulation outputs ----
    demand: { R: 0.6, C: 0.3, I: 0.5 }, // -1..1
    stats: {
      pop: 0, jobs: 0, jobsC: 0, jobsI: 0, workers: 0, unemployment: 0,
      happiness: 0.6, approval: 0.6,
      powerSupply: 0, powerDemand: 0, waterSupply: 0, waterDemand: 0,
      income: 0, expenses: 0, net: 0,
      tourism: 0, education: 0, health: 0, crime: 0, pollution: 0, traffic: 0,
      buildings: 0, abandoned: 0,
    },
    history: {}, // key -> array of monthly samples (econ fills: pop, money, happiness, income, expenses, demandR/C/I, crime, pollution)
    mods: {}, // modifier key -> additive value (econ computes from policies)
    peakPop: 0,
    milestone: 0,
    achievements: {},
    weather: { type: 'clear', intensity: 0, cloud: 0.25, wet: 0, fog: 0, wind: 0.5, windDir: 0.6, lightning: 0 },
    disastersEnabled: true,
    stateVersion: 0,

    // ---- change counters (renderers compare to decide rebuilds) ----
    ver: { terrain: 0, bld: 0, trees: 0, maps: 0, flags: 0 },
  };
  for (const m of VC.MODS) S.mods[m] = 0;
  return S;
};

/* ------------------------------------------------------------------ */
/* World API                                                             */
/* ------------------------------------------------------------------ */
const W = (VC.world = {
  S: null,

  /** Installs a state as current. Called by main before modules' reset(). */
  setState(S) {
    W.S = S;
    VC.state = S;
  },

  idx: (x, z) => z * W.S.W + x,
  inb: (x, z) => x >= 0 && z >= 0 && x < W.S.W && z < W.S.H,
  level: (x, z) => W.S.height[z * W.S.W + x],
  /** World Y of tile top. */
  topY: (x, z) => W.S.height[z * W.S.W + x] * VC.C.STEP,
  isWater: (x, z) => W.S.height[z * W.S.W + x] < VC.C.SEA,
  isWaterI: (i) => W.S.height[i] < VC.C.SEA,
  /** Terrain height at arbitrary world (x,z), bilinear across tile centers, water clamped. */
  groundY(wx, wz) {
    const S = W.S;
    const x = VC.M.clamp(Math.floor(wx), 0, S.W - 1), z = VC.M.clamp(Math.floor(wz), 0, S.H - 1);
    return Math.max(S.height[z * S.W + x] * VC.C.STEP, VC.C.SEA_Y);
  },

  /* ---------------- change notification ---------------- */
  _dirty: null,
  /** Marks an inclusive tile rectangle as changed. Coalesced and emitted once per frame by flush(). */
  markDirty(x0, z0, x1 = x0, z1 = z0) {
    const S = W.S;
    x0 = Math.max(0, Math.min(x0, x1) - 1);
    z0 = Math.max(0, Math.min(z0, z1) - 1);
    x1 = Math.min(S.W - 1, Math.max(x0, x1) + 1);
    z1 = Math.min(S.H - 1, Math.max(z0, z1) + 1);
    const d = W._dirty;
    if (!d) W._dirty = { x0, z0, x1, z1 };
    else {
      d.x0 = Math.min(d.x0, x0);
      d.z0 = Math.min(d.z0, z0);
      d.x1 = Math.max(d.x1, x1);
      d.z1 = Math.max(d.z1, z1);
    }
    S.ver.terrain++;
  },
  /** Emits the coalesced 'dirty' event. main calls this every frame. Also callable directly. */
  flush() {
    if (W._dirty) {
      const d = W._dirty;
      W._dirty = null;
      VC.bus.emit('dirty', d);
    }
  },

  /* ---------------- tile setters ---------------- */
  setHeight(x, z, h) {
    const i = W.idx(x, z);
    h = VC.M.clamp(h | 0, 0, VC.C.MAXH);
    if (W.S.height[i] === h) return;
    W.S.height[i] = h;
    W.markDirty(x, z);
  },
  setTerr(x, z, m) {
    const i = W.idx(x, z);
    if (W.S.terr[i] === m) return;
    W.S.terr[i] = m;
    W.markDirty(x, z);
  },
  setRoad(x, z, type) {
    const i = W.idx(x, z);
    if (W.S.road[i] === type) return;
    W.S.road[i] = type;
    if (type) {
      W.S.zone[i] = 0;
      W.S.trees[i] = 0;
      W.S.ver.trees++;
    }
    W.markDirty(x, z);
    VC.bus.emit('roadChange', { x, z, type });
  },
  setZone(x, z, code) {
    const i = W.idx(x, z);
    if (W.S.zone[i] === code) return;
    W.S.zone[i] = code;
    W.markDirty(x, z);
  },
  setPowerLine(x, z, v) {
    const i = W.idx(x, z);
    v = v ? 1 : 0;
    if (W.S.pline[i] === v) return;
    W.S.pline[i] = v;
    W.markDirty(x, z);
  },
  setTrees(x, z, n) {
    const i = W.idx(x, z);
    if (W.S.trees[i] === n) return;
    W.S.trees[i] = n;
    W.S.ver.trees++;
    W.markDirty(x, z);
  },
  /** Sets every tile in the footprint to level h. */
  flatten(x, z, w, d, h) {
    for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) if (W.inb(xx, zz)) W.setHeight(xx, zz, h);
  },

  /* ---------------- queries ---------------- */
  /** True if the footprint is in bounds, dry, flat-able and free of roads/buildings. */
  areaFree(x, z, w, d, opts = {}) {
    const S = W.S;
    for (let zz = z; zz < z + d; zz++)
      for (let xx = x; xx < x + w; xx++) {
        if (!W.inb(xx, zz)) return false;
        const i = zz * S.W + xx;
        if (S.bld[i] || S.road[i]) return false;
        if (!opts.allowWater && S.height[i] < VC.C.SEA) return false;
        if (!opts.allowPline && S.pline[i]) return false;
        if (opts.zone != null && S.zone[i] !== opts.zone) return false;
      }
    return true;
  },
  /** True if any tile orthogonally adjacent to the footprint is a road with access (street/avenue). */
  roadAdjacent(x, z, w, d, anyRoad = false) {
    return W.adjacentRoadDir(x, z, w, d, anyRoad) >= 0;
  },
  /**
   * Returns a rotation 0..3 such that the building's front faces an adjacent road, or -1.
   * Rotation convention: rot 0 = front faces +Z, 1 = +X, 2 = -Z, 3 = -X.
   */
  adjacentRoadDir(x, z, w, d, anyRoad = false) {
    const S = W.S;
    const ok = (xx, zz) => {
      if (!W.inb(xx, zz)) return false;
      const r = S.road[zz * S.W + xx];
      return r && (anyRoad || VC.ROADS[r].access);
    };
    for (let xx = x; xx < x + w; xx++) if (ok(xx, z + d)) return 0;
    for (let zz = z; zz < z + d; zz++) if (ok(x + w, zz)) return 1;
    for (let xx = x; xx < x + w; xx++) if (ok(xx, z - 1)) return 2;
    for (let zz = z; zz < z + d; zz++) if (ok(x - 1, zz)) return 3;
    return -1;
  },
  buildingAt(x, z) {
    if (!W.inb(x, z)) return null;
    const id = W.S.bld[W.idx(x, z)];
    return id ? W.S.buildings.get(id) : null;
  },
  get(id) {
    return W.S.buildings.get(id) || null;
  },
  count(key) {
    let n = 0;
    for (const b of W.S.buildings.values()) if (b.key === key) n++;
    return n;
  },

  /* ---------------- buildings ---------------- */
  /**
   * Adds a building. props: { key, x, z, w, d, rot, ...extra }.
   *  - key 'grow' for growables (extra: zt 1..3, den 1..3, level 1..3, wealth 0..2)
   *  - otherwise a VC.BLD key (w/d default from catalog size, swapped when rot is odd)
   * Clears trees, flattens to the level of the first tile (unless opts.noFlatten).
   * Growables keep the zone under them; placed buildings clear it.
   */
  addBuilding(props, opts = {}) {
    const S = W.S;
    const def = props.key === 'grow' ? null : VC.BLD[props.key];
    let w = props.w, d = props.d;
    const rot = props.rot | 0;
    if (w == null || d == null) {
      const sz = def ? def.size : [1, 1];
      w = rot & 1 ? sz[1] : sz[0];
      d = rot & 1 ? sz[0] : sz[1];
    }
    const b = Object.assign(
      {
        id: S.nextId++,
        key: props.key,
        x: props.x, z: props.z, w, d, rot,
        variant: VC.M.hashU(props.x, props.z, S.nextId) & 0xffff,
        level: 1, zt: 0, den: 0, wealth: 0,
        pop: 0, cap: 0, // residents (R/housing) or jobs filled / capacity
        built: opts.instant ? 1 : 0, // construction progress 0..1
        powered: false, watered: false,
        happy: 0.6, abandoned: false, fire: 0, age: 0,
        hgt: 1, // world height (renderer sets from model)
      },
      props,
      { w, d, rot }
    );
    if (def) {
      b.cap = def.housing || def.jobs || 0;
    }
    const lvl = S.height[W.idx(b.x, b.z)];
    for (let zz = b.z; zz < b.z + b.d; zz++)
      for (let xx = b.x; xx < b.x + b.w; xx++) {
        if (!W.inb(xx, zz)) continue;
        const i = W.idx(xx, zz);
        S.bld[i] = b.id;
        if (S.trees[i]) { S.trees[i] = 0; S.ver.trees++; }
        if (def) S.zone[i] = 0;
        if (!opts.noFlatten && S.height[i] !== lvl && S.height[i] >= VC.C.SEA) S.height[i] = lvl;
      }
    S.buildings.set(b.id, b);
    S.ver.bld++;
    W.markDirty(b.x, b.z, b.x + b.w - 1, b.z + b.d - 1);
    VC.bus.emit('bldAdd', b);
    return b;
  },
  /** Removes a building. reason: 'bulldoze' | 'fire' | 'abandon' | 'upgrade' | 'disaster' | 'replace'. */
  removeBuilding(id, reason = 'bulldoze') {
    const S = W.S;
    const b = typeof id === 'object' ? id : S.buildings.get(id);
    if (!b || !S.buildings.has(b.id)) return null;
    for (let zz = b.z; zz < b.z + b.d; zz++)
      for (let xx = b.x; xx < b.x + b.w; xx++) {
        if (!W.inb(xx, zz)) continue;
        const i = W.idx(xx, zz);
        if (S.bld[i] === b.id) S.bld[i] = 0;
      }
    S.buildings.delete(b.id);
    b.removed = reason;
    S.ver.bld++;
    W.markDirty(b.x, b.z, b.x + b.w - 1, b.z + b.d - 1);
    VC.bus.emit('bldRemove', b);
    return b;
  },
  /** Call after changing a building's level/abandoned/fire/etc so renderers update. */
  changed(b) {
    W.S.ver.bld++;
    VC.bus.emit('bldChange', b);
  },
  /** Center of a building in world coordinates. */
  center(b) {
    return [b.x + b.w / 2, W.topY(b.x, b.z), b.z + b.d / 2];
  },

  /* ---------------- unlocks ---------------- */
  isUnlocked(key) {
    const S = W.S;
    if (S.sandbox) return true;
    const def = VC.BLD[key];
    if (def) return S.peakPop >= (def.unlock || 0);
    const road = Object.values(VC.ROADS).find((r) => r.key === key);
    if (road) return S.peakPop >= (road.unlock || 0);
    const zt = VC.ZONE_TOOLS.find((z) => z.key === key);
    if (zt) return S.peakPop >= (zt.unlock || 0);
    const pol = VC.POLICY[key];
    if (pol) return S.peakPop >= (pol.unlock || 0);
    return true;
  },
});

/* ------------------------------------------------------------------ */
/* Money API. Every expense/income goes through here.                   */
/* cat: ledger category ('construction', 'roads', 'zoning', 'demolish', */
/* 'terraform', 'upkeep:<dept>', 'tax:R', 'policy', 'loan', 'reward', …)*/
/* ------------------------------------------------------------------ */
VC.money = {
  costMul() {
    const S = W.S;
    return (VC.DIFFICULTY[S.difficulty] || VC.DIFFICULTY.normal).costMul;
  },
  canAfford(amount) {
    const S = W.S;
    return S.sandbox || S.money >= amount;
  },
  /** Deducts amount. Returns false (and emits 'noMoney') if unaffordable, unless force. */
  spend(amount, cat = 'misc', force = false) {
    const S = W.S;
    if (amount <= 0) return true;
    if (S.sandbox) return true;
    if (!force && S.money < amount) {
      VC.bus.emit('noMoney', { amount, cat });
      return false;
    }
    S.money -= amount;
    const L = S.ledger.month;
    L[cat] = (L[cat] || 0) - amount;
    VC.bus.emit('money', { amount: -amount, cat, balance: S.money });
    return true;
  },
  earn(amount, cat = 'misc') {
    const S = W.S;
    if (amount <= 0) return;
    S.money += amount;
    const L = S.ledger.month;
    L[cat] = (L[cat] || 0) + amount;
    VC.bus.emit('money', { amount, cat, balance: S.money });
  },
};
