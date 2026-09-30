/*
 * VOXELPOLIS — simulation: utility networks and road access (part of VC.sim).
 *
 *   VC.sim.recalcNetworks(force)  immediate recompute of S.flags (POWER, WATER, ACCESS, POWERNET, WATERNET),
 *                            b.powered / b.watered / b.simRoad, power & water balance. Emits 'flagsUpdated'
 *                            when something changed. force = true: full topology rebuild.
 *   X.netGen(S, force, live, clock)  the same pass as a generator; the live game runs it through the sim's
 *                            job scheduler (sim.js) in slices of a few ms. Between slices every visible
 *                            result stays consistent: solves write a working copy of the flags (X.fw) and
 *                            fresh X.power / X.water objects, published at the end of the pass.
 *   X.water.unpoweredSources pumps / towers that produce nothing because they have no power.
 *
 * POWER conducts through road tiles (any type, incl. bridges), power lines (S.pline) and building
 * footprints (4-neighbour). Zoned-but-empty tiles do not conduct, but energized conductors "reach"
 * 1 tile into non-conducting land (so zones beside a powered road can develop; interior lots get
 * power once their neighbours are built — lots fill from the street inward). WATER is the same through roads + buildings (pipes run
 * under roads; power lines carry no water) and its pumps only run while powered.
 * Per connected component: supply >= demand -> everyone served; otherwise water pumps / towers /
 * treatment plants are powered first (they draw little and a dry city is worse than a dark one),
 * then buildings are served in BFS order from the sources until the supply runs out (the far end
 * of town blacks out).
 * ACCESS = within C.ROAD_ACCESS tiles of a street/avenue (highways give no access); the nearest
 * access road tile per tile is kept in X.accRoad for traffic and building rotation. Catalog
 * buildings only count as having road access (b.simRoad >= 0) when a street/avenue touches their
 * footprint (same rule as the placement warning); staffed ones (X.needsAccess) work at reduced
 * effectiveness without it.
 * FUNDING: utilities funding scales plant/pump output 15% (0%) .. 100% (100%) .. 110%.
 * WEATHER: wind and sun come from the sim's own weather (X.wx, see sim.js), never from the visual
 * weather, so graphics settings cannot change the simulation.
 * INCREMENTAL: the expensive flood fills only run when the network topology changed (roads, power
 * lines, catalog buildings, removals, or a new growable that bridges two networks). New growables
 * that touch a single existing network join it in O(footprint); daily re-balancing (growing demand,
 * wind, season) re-uses the cached components (see recalcNetworks).
 * COLUMNS: per recalc, one pass copies each building's outputs / uses / footprint into typed arrays
 * (X.cPo, X.cPw, …, indexed like X.blist); the flood fills and balances read only those, so they
 * never touch the (differently shaped) building objects in their hot loops.
 */
const SIM = (VC.sim = VC.sim || {});
const X = (SIM._ = SIM._ || {});
const C = VC.C, F = VC.F, M = VC.M;

/* ---------------- per-building utility use / output ---------------- */
const USE_R = 0.02, USE_C = 0.04, USE_I = 0.08; // MW per resident / job
const WUSE_R = 0.04, WUSE_J = 0.03; // kL per resident / job

/** Sim weather (X.wx, deterministic per day) — neutral values before the sim has computed it. */
const wx = () => X.wx || { cloud: 0.35, wind: 0.4, wet: 0.1 };
/** Season daylight factor for solar (month 0 = Jan). */
function solarFactor(S) {
  const m = Math.floor(S.time.day / C.DAYS_PER_MONTH) % 12;
  const season = m >= 5 && m <= 7 ? 1.0 : m === 11 || m <= 1 ? 0.55 : 0.8;
  return season * (1 - 0.35 * M.sat(wx().cloud));
}
/** Wind turbine factor: sim wind and elevation above the sea. */
function windFactor(S, b) {
  const h = S.height[b.z * S.W + b.x] - C.SEA;
  return (0.35 + 0.9 * M.sat(wx().wind)) * (0.75 + 0.5 * M.sat(h / 24));
}

/** Utilities funding: 15% output at zero funding, 100% at full funding, up to 110% (strikes included). */
function fundMul() {
  const e = X.eff ? X.eff('utilities') : 1;
  return M.clamp(0.15 + 0.85 * e, 0.15, 1.1);
}
/** Staffed catalog buildings (5+ jobs) need a street/avenue at the door to work fully. */
X.needsAccess = (def) => !!def && (def.jobs || 0) >= 5;
/** Output / effectiveness multiplier for a catalog building's road access (1 = fine). */
X.accessMul = (b, def) => (b.simRoad >= 0 || !X.needsAccess(def) ? 1 : def.cover ? 0.3 : 0.5);
/** Seasonal demand: winter heating, summer air-conditioning (power); summer gardens (water). */
function seasonUse(S, water) {
  const m = Math.floor(S.time.day / C.DAYS_PER_MONTH) % 12;
  if (water) return m >= 5 && m <= 7 ? 1.15 : 1;
  return m === 11 || m <= 1 ? 1.12 : m >= 5 && m <= 7 ? 1.06 : 1;
}

/** Power output (MW) of a building right now. */
X.powerOut = function (S, b) {
  const def = VC.BLD[b.key];
  if (!def || !def.power || b.built < 1) return 0;
  let p = def.power * fundMul() * X.accessMul(b, def);
  if (b.key === 'wind_turbine') p *= windFactor(S, b);
  else if (b.key === 'solar_farm') p *= solarFactor(S);
  if (b.fire > 0) p *= 0.4;
  return p;
};
/** Water output (kL) — pumps must be powered. */
X.waterOut = function (S, b) {
  const def = VC.BLD[b.key];
  if (!def || !def.water || b.built < 1 || !b.powered) return 0;
  return def.water * fundMul() * X.accessMul(b, def) * (b.fire > 0 ? 0.4 : 1);
};
/** Power consumption (MW). */
X.powerUse = function (S, b) {
  let u = 0;
  if (b.key === 'grow') {
    const occ = Math.max(b.pop, b.cap * 0.25);
    u = b.built < 1 && !b.simReplay ? b.cap * 0.002 : occ * (b.zt === 1 ? USE_R : b.zt === 2 ? USE_C : USE_I);
    if (b.abandoned) u *= 0.1;
  } else {
    const def = VC.BLD[b.key];
    if (!def || def.power > 0) return 0;
    if (def.powerUse != null) u = def.powerUse;
    else u = (def.jobs || 0) * 0.05 + (def.housing ? Math.max(b.pop, def.housing * 0.1) * USE_R : 0);
  }
  return u * Math.max(0.2, 1 + (S.mods.powerUse || 0)) * seasonUse(S, false);
};
/** Water consumption (kL). */
X.waterUse = function (S, b) {
  let u = 0;
  if (b.key === 'grow') {
    const occ = Math.max(b.pop, b.cap * 0.25);
    u = b.built < 1 && !b.simReplay ? 0 : occ * (b.zt === 1 ? WUSE_R : WUSE_J);
    if (b.abandoned) u *= 0.1;
  } else {
    const def = VC.BLD[b.key];
    if (!def || def.water > 0) return 0;
    if (def.waterUse != null) u = def.waterUse;
    else u = (def.jobs || 0) * WUSE_J + (def.housing ? Math.max(b.pop, def.housing * 0.1) * WUSE_R : 0);
  }
  return u * Math.max(0.2, 1 + (S.mods.waterUse || 0)) * seasonUse(S, true);
};
/** Does this building need power / water at all? (parks, rubble and plants don't) */
X.needsPower = (b) => {
  if (b.key === 'grow') return true;
  const def = VC.BLD[b.key];
  return !!def && !(def.power > 0) && ((def.jobs || 0) > 0 || (def.housing || 0) > 0 || def.powerUse > 0);
};
X.needsWater = (b) => {
  if (b.key === 'grow') return true;
  const def = VC.BLD[b.key];
  return !!def && !(def.water > 0) && ((def.jobs || 0) >= 10 || (def.housing || 0) > 0 || def.waterUse > 0);
};

/* ---------------- buffers ---------------- */
function newInfo(kind) {
  return kind
    ? { supply: 0, demand: 0, served: 0, connectedDemand: 0, sources: [], unwatered: 0, unpoweredSources: 0, networks: 0, shortage: false }
    : { supply: 0, demand: 0, served: 0, connectedDemand: 0, plants: [], unpowered: 0, networks: 0, shortage: false };
}
X.ensureNet = function (S) {
  const N = S.N;
  if (X.netN === N && X.cond) return;
  X.netN = N;
  X.cond = new Uint8Array(N); // bit 1 power conductor, bit 2 water conductor
  X.mark = new Int32Array(N); // epoch stamps
  X.queue = new Int32Array(N);
  X.queue2 = new Int32Array(N);
  X.reach = new Uint8Array(N);
  X.accRoad = new Int32Array(N);
  X.accDist = new Uint8Array(N);
  X.accRoadW = new Int32Array(N); // access arrays being rebuilt by a staged pass (swapped in at its end)
  X.accDistW = new Uint8Array(N);
  X.plineCopy = new Uint8Array(N);
  X.tileB = new Int32Array(N);
  X.fw = new Uint8Array(N); // working copy of S.flags while a (staged) solve runs; committed at its end
  X.compT = [new Int32Array(N), new Int32Array(N)]; // component id per tile (power, water); 0 = none
  X.compN = [0, 0];
  X.cSup = new Float64Array(64);
  X.cDem = new Float64Array(64);
  X.blist = [];
  X.joinQ = [];
  X.epoch = 1;
  X.topoDirty = true;
  X.power = newInfo(0);
  X.water = newInfo(1);
};

/*
 * Per-building columns (index = X.blist index), filled once per recalc by columns() — the only pass that
 * reads building objects before the results are written back — so the solver's hot loops work on typed
 * arrays instead of building objects of many different shapes (other modules add their own fields).
 */
const CF_NEEDP = 1, CF_NEEDW = 2, CF_SRCP = 4, CF_WSRC = 8, CF_BUILT = 16;
function ensureCols(n) {
  if (X.cPo && X.cPo.length >= n) return;
  const m = Math.max(1024, Math.ceil(n * 1.5));
  X.cPo = new Float64Array(m); // power out / use (MW)
  X.cPw = new Float64Array(m);
  X.cWo = new Float64Array(m); // water out (after the power pass: pumps need power) / use (kL)
  X.cWu = new Float64Array(m);
  X.cWb = new Float64Array(m); // water out if powered
  X.cX = new Int32Array(m); // footprint
  X.cZ = new Int32Array(m);
  X.cW = new Int32Array(m);
  X.cD = new Int32Array(m);
  X.cFl = new Uint8Array(m); // CF_* bits
  X.cNet = new Int32Array(m); // component id in the running solve
  X.cSrv = new Uint8Array(m); // 0 = not reached, 1 = served, 2 = reached but blacked out
  X.cLab = [new Int32Array(m), new Int32Array(m)]; // cached component labels (b.simNetP / b.simNetW)
  X.cOn = [new Uint8Array(m), new Uint8Array(m)]; // result: powered / watered
}
/** Fills the columns for every building of X.blist (outputs, uses, footprint, static bits). */
function* columns(S, live) {
  const blist = X.blist, n = blist.length;
  ensureCols(n);
  const cPo = X.cPo, cPw = X.cPw, cWu = X.cWu, cWb = X.cWb, cX = X.cX, cZ = X.cZ, cW = X.cW, cD = X.cD, cFl = X.cFl;
  const labP = X.cLab[0], labW = X.cLab[1];
  // city-wide factors, hoisted out of the per-building formulas (same results as X.powerOut & co.)
  const fund = fundMul(), sol = solarFactor(S);
  const pMod = Math.max(0.2, 1 + (S.mods.powerUse || 0)), pSea = seasonUse(S, false);
  const wMod = Math.max(0.2, 1 + (S.mods.waterUse || 0)), wSea = seasonUse(S, true);
  for (let k = 0; k < n; k++) {
    const b = blist[k];
    cX[k] = b.x; cZ[k] = b.z; cW[k] = b.w; cD[k] = b.d;
    const key = b.key;
    const def = key === 'grow' || key === 'rubble' ? null : VC.BLD[key] || null;
    const built = b.built >= 1;
    let fl = built ? CF_BUILT : 0;
    if (b.simNeedP) fl |= CF_NEEDP;
    if (b.simNeedW) fl |= CF_NEEDW;
    if (b.simSrcP) fl |= CF_SRCP;
    if (def && def.water > 0) fl |= CF_WSRC;
    cFl[k] = fl;
    // outputs (X.powerOut / X.waterOut without the 'powered' condition, applied after the power pass)
    let po = 0, wb = 0;
    if (def && built) {
      if (def.power) {
        po = def.power * fund * X.accessMul(b, def);
        if (key === 'wind_turbine') po *= windFactor(S, b);
        else if (key === 'solar_farm') po *= sol;
        if (b.fire > 0) po *= 0.4;
      }
      if (def.water) wb = def.water * fund * X.accessMul(b, def) * (b.fire > 0 ? 0.4 : 1);
    }
    cPo[k] = po;
    cWb[k] = wb;
    // uses (X.powerUse / X.waterUse)
    let pu = 0, wu = 0;
    if (key === 'grow') {
      const occ = Math.max(b.pop, b.cap * 0.25);
      const pre = b.built < 1 && !b.simReplay;
      const zt = b.zt;
      if (fl & CF_NEEDP) pu = pre ? b.cap * 0.002 : occ * (zt === 1 ? USE_R : zt === 2 ? USE_C : USE_I);
      if (fl & CF_NEEDW) wu = pre ? 0 : occ * (zt === 1 ? WUSE_R : WUSE_J);
      if (b.abandoned) { pu *= 0.1; wu *= 0.1; }
    } else if (def) {
      if ((fl & CF_NEEDP) && !(def.power > 0)) pu = def.powerUse != null ? def.powerUse : (def.jobs || 0) * 0.05 + (def.housing ? Math.max(b.pop, def.housing * 0.1) * USE_R : 0);
      if ((fl & CF_NEEDW) && !(def.water > 0)) wu = def.waterUse != null ? def.waterUse : (def.jobs || 0) * WUSE_J + (def.housing ? Math.max(b.pop, def.housing * 0.1) * WUSE_R : 0);
    }
    cPw[k] = fl & CF_NEEDP ? pu * pMod * pSea : 0;
    cWu[k] = fl & CF_NEEDW ? wu * wMod * wSea : 0;
    labP[k] = b.simNetP | 0;
    labW[k] = b.simNetW | 0;
    if (live && (k & 1023) === 1023) yield 'cols';
  }
}

/* ---------------- road access (multi-source BFS, depth C.ROAD_ACCESS) ---------------- */
// While a pass rebuilds the access arrays (into X.accRoadW / accDistW) buildingRoad() reads the new ones;
// everyone else keeps reading X.accRoad / accDist until the pass publishes them.
let ACC = null, ACCD = null;
function* computeAccess(S, live) {
  const W = S.W, H = S.H, N = S.N;
  const acc = X.accRoadW, dist = X.accDistW, q = X.queue, flags = X.fw, road = S.road, hgt = S.height;
  const R = C.ROAD_ACCESS;
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) {
    const r = road[i];
    if (r && VC.ROADS[r] && VC.ROADS[r].access) {
      acc[i] = i;
      dist[i] = 0;
      q[qt++] = i;
    } else {
      acc[i] = -1;
      dist[i] = 255;
    }
  }
  while (qh < qt) {
    const i = q[qh++];
    const nd = dist[i] + 1;
    if (nd > R) continue;
    const x = i % W, z = (i - x) / W;
    // 4 neighbours; access does not travel across open water
    if (x > 0) { const j = i - 1; if (dist[j] > nd && hgt[j] >= C.SEA) { dist[j] = nd; acc[j] = acc[i]; q[qt++] = j; } }
    if (x < W - 1) { const j = i + 1; if (dist[j] > nd && hgt[j] >= C.SEA) { dist[j] = nd; acc[j] = acc[i]; q[qt++] = j; } }
    if (z > 0) { const j = i - W; if (dist[j] > nd && hgt[j] >= C.SEA) { dist[j] = nd; acc[j] = acc[i]; q[qt++] = j; } }
    if (z < H - 1) { const j = i + W; if (dist[j] > nd && hgt[j] >= C.SEA) { dist[j] = nd; acc[j] = acc[i]; q[qt++] = j; } }
    if (live && (qh & 16383) === 0) yield 'access';
  }
  for (let i = 0; i < N; i++) if (dist[i] <= R) flags[i] |= F.ACCESS;
  ACC = acc;
  ACCD = dist;
}

/**
 * Access road tile for a building (-1 if none). Growables: the nearest street/avenue within
 * C.ROAD_ACCESS tiles. Catalog buildings: a street/avenue tile touching the footprint (front first).
 */
function buildingRoad(S, b) {
  const W = S.W, H = S.H;
  if (b.key !== 'grow') {
    if (b.key === 'rubble') return -1;
    const road = S.road;
    const at = (x, z) => {
      if (x < 0 || z < 0 || x >= W || z >= H) return -1;
      const i = z * W + x, r = road[i];
      return r && VC.ROADS[r] && VC.ROADS[r].access ? i : -1;
    };
    let r = -1;
    for (let x = b.x; x < b.x + b.w && r < 0; x++) r = Math.max(at(x, b.z + b.d), at(x, b.z - 1));
    for (let z = b.z; z < b.z + b.d && r < 0; z++) r = Math.max(at(b.x + b.w, z), at(b.x - 1, z));
    return r;
  }
  const acc = ACC || X.accRoad, dist = ACCD || X.accDist;
  let best = -1, bd = 255;
  for (let z = b.z; z < b.z + b.d; z++)
    for (let x = b.x; x < b.x + b.w; x++) {
      if (x < 0 || z < 0 || x >= W || z >= H) continue;
      const i = z * W + x;
      const r = acc[i];
      if (r >= 0 && dist[i] < bd) {
        bd = dist[i];
        best = r;
      }
    }
  return best;
}
X.buildingRoad = buildingRoad;

/* ---------------- generic network solve ---------------- */
/**
 * Per-building served status after a solve / rebalance (kind 0 power, 1 water): writes b.powered /
 * b.watered and the cached component label (b.simNetP / simNetW), counts the unserved into info.
 */
function finishStatus(kind, info) {
  const blist = X.blist, nb = blist.length, fl = X.cFl, srv = X.cSrv, net = X.cNet, on = X.cOn[kind];
  const out = kind ? X.cWo : X.cPo;
  let changed = false, bad = 0;
  for (let k = 0; k < nb; k++) {
    const f = fl[k], b = blist[k];
    if (kind) {
      const ok = !(f & CF_NEEDW) || out[k] > 0 || srv[k] === 1;
      on[k] = ok ? 1 : 0;
      if (b.watered !== ok) { changed = true; b.watered = ok; }
      b.simNetW = net[k];
      if (!ok) bad++;
    } else {
      const ok = !(f & CF_NEEDP) || out[k] > 0 || srv[k] === 1 || (f & CF_SRCP) !== 0;
      on[k] = ok ? 1 : 0;
      if (b.powered !== ok) { changed = true; b.powered = ok; }
      b.simNetP = net[k];
      if (!ok) bad++;
    }
  }
  if (kind) info.unwatered = bad;
  else info.unpowered = bad;
  return changed;
}
/** Publishes a finished info object (X.power / X.water are only ever replaced whole). */
function commitInfo(kind, info) {
  if (kind) X.water = info;
  else X.power = info;
}

/**
 * kind 0 = power, 1 = water. Works on the columns and X.tileB (tile -> blist index, -1 none) and
 * writes the working flags X.fw (committed to S.flags by the caller), the component labels
 * (X.compT[kind], X.cNet), the served state and a fresh info object. live: yields between chunks.
 */
function* solve(S, kind, live) {
  const W = S.W, H = S.H, N = S.N;
  const bit = kind ? 2 : 1;
  const FNET = kind ? F.WATERNET : F.POWERNET;
  const FON = kind ? F.WATER : F.POWER;
  const cond = X.cond, mark = X.mark, q = X.queue, q2 = X.queue2, flags = X.fw, compT = X.compT[kind];
  const blist = X.blist, tileB = X.tileB, nb = blist.length;
  const out = kind ? X.cWo : X.cPo, use = kind ? X.cWu : X.cPw, net = X.cNet, srv = X.cSrv, fl = X.cFl;
  const cx = X.cX, cz = X.cZ, cw = X.cW, cd = X.cD;
  const info = newInfo(kind);
  const list = kind ? info.sources : info.plants;
  const srcK = X._srcK || (X._srcK = []);
  srcK.length = 0;

  // reset served state; tally totals
  for (let k = 0; k < nb; k++) {
    net[k] = 0;
    srv[k] = 0;
    info.demand += use[k];
    const o = out[k];
    if (o > 0) {
      info.supply += o;
      list.push({ b: blist[k], output: o });
      srcK.push(k);
    }
  }
  // clear flag bits, set NET bit on all conductors, clear component labels
  for (let i = 0; i < N; i++) {
    let f = flags[i] & ~(FNET | FON);
    if (cond[i] & bit) f |= FNET;
    flags[i] = f;
    compT[i] = 0;
  }
  if (live) yield 'clear';

  const ep = ++X.epoch;
  let comp = 0;
  const compK = X._compK || (X._compK = []); // blist indices of the component's buildings
  for (let s = 0; s < srcK.length; s++) {
    const sk = srcK[s];
    const si = cz[sk] * W + cx[sk];
    if (mark[si] === ep) continue; // component already solved
    comp++;
    info.networks++;
    // ---- flood fill the component, collecting buildings ----
    let qt = 0, qh = 0;
    compK.length = 0;
    let supply = 0, demand = 0;
    mark[si] = ep;
    q[qt++] = si;
    while (qh < qt) {
      const i = q[qh++];
      compT[i] = comp;
      const k = tileB[i];
      if (k >= 0 && net[k] !== comp) {
        net[k] = comp;
        compK.push(k);
        supply += out[k];
        demand += use[k];
      }
      const x = i % W;
      if (x > 0 && (cond[i - 1] & bit) && mark[i - 1] !== ep) { mark[i - 1] = ep; q[qt++] = i - 1; }
      if (x < W - 1 && (cond[i + 1] & bit) && mark[i + 1] !== ep) { mark[i + 1] = ep; q[qt++] = i + 1; }
      if (i >= W && (cond[i - W] & bit) && mark[i - W] !== ep) { mark[i - W] = ep; q[qt++] = i - W; }
      if (i < N - W && (cond[i + W] & bit) && mark[i + W] !== ep) { mark[i + W] = ep; q[qt++] = i + W; }
      if (live && (qh & 4095) === 0) yield 'fill';
    }
    info.connectedDemand += demand;
    const nk = compK.length;
    if (supply >= demand) {
      // everyone served
      for (let k = 0; k < qt; k++) flags[q[k]] |= FON;
      for (let j = 0; j < nk; j++) srv[compK[j]] = 1;
      info.served += demand;
      continue;
    }
    // ---- shortage ----
    info.shortage = true;
    let remaining = supply;
    // power: water sources first — they draw little, and without them the whole town runs dry
    if (!kind) {
      for (let j = 0; j < nk; j++) {
        const k = compK[j];
        if (srv[k] === 0 && out[k] <= 0 && (fl[k] & CF_WSRC) && remaining >= use[k]) {
          remaining -= use[k];
          info.served += use[k];
          srv[k] = 1;
        }
      }
    }
    // then serve in BFS order from every source until the supply runs out
    const ep2 = ++X.epoch;
    let h2 = 0, t2 = 0;
    for (let j = 0; j < nk; j++) {
      const k = compK[j];
      if (out[k] > 0) {
        const z1 = Math.min(H, cz[k] + cd[k]), x1 = Math.min(W, cx[k] + cw[k]);
        for (let z = cz[k]; z < z1; z++)
          for (let x = cx[k]; x < x1; x++) {
            const i = z * W + x;
            if (mark[i] === ep) { mark[i] = ep2; q2[t2++] = i; }
          }
        srv[k] = 1;
      }
    }
    while (h2 < t2) {
      const i = q2[h2++];
      const k = tileB[i];
      if (k >= 0 && net[k] === comp && srv[k] === 0) {
        const u = use[k];
        if (remaining >= u) {
          remaining -= u;
          info.served += u;
          srv[k] = 1;
        } else srv[k] = 2;
      }
      // conductors carry energy while supply remains
      if (remaining > 0) flags[i] |= FON;
      const x = i % W;
      if (x > 0 && mark[i - 1] === ep) { mark[i - 1] = ep2; q2[t2++] = i - 1; }
      if (x < W - 1 && mark[i + 1] === ep) { mark[i + 1] = ep2; q2[t2++] = i + 1; }
      if (i >= W && mark[i - W] === ep) { mark[i - W] = ep2; q2[t2++] = i - W; }
      if (i < N - W && mark[i + W] === ep) { mark[i + W] = ep2; q2[t2++] = i + W; }
      if (live && (h2 & 4095) === 0) yield 'bfs';
    }
    // footprints show exactly the building's state
    for (let j = 0; j < nk; j++) {
      const k = compK[j];
      const on = srv[k] === 1;
      if (!on) srv[k] = 2;
      const z1 = Math.min(H, cz[k] + cd[k]), x1 = Math.min(W, cx[k] + cw[k]);
      for (let z = cz[k]; z < z1; z++)
        for (let x = cx[k]; x < x1; x++) {
          if (on) flags[z * W + x] |= FON;
          else flags[z * W + x] &= ~FON;
        }
    }
  }
  X.compN[kind] = comp;
  if (live) yield 'comps';

  // ---- reach: served conductors energize the adjacent non-conducting land (zones grow there,
  // and every new building therefore touches the network it draws from) ----
  const hgt = S.height, SEA = C.SEA, reach = X.reach;
  for (let i = 0; i < N; i++) {
    reach[i] = 0;
    if (cond[i] & bit || hgt[i] < SEA) continue;
    const x = i % W;
    let j = i - 1;
    if (x > 0 && (cond[j] & bit) && (flags[j] & FON)) { reach[i] = 1; continue; }
    j = i + 1;
    if (x < W - 1 && (cond[j] & bit) && (flags[j] & FON)) { reach[i] = 1; continue; }
    j = i - W;
    if (i >= W && (cond[j] & bit) && (flags[j] & FON)) { reach[i] = 1; continue; }
    j = i + W;
    if (i < N - W && (cond[j] & bit) && (flags[j] & FON)) reach[i] = 1;
  }
  for (let i = 0; i < N; i++) if (reach[i]) flags[i] |= FON;

  finishStatus(kind, info);
  commitInfo(kind, info);
}

/**
 * Cheap re-balance on unchanged topology: sums supply and demand per cached component. Succeeds
 * (true) when every component can serve all its buildings and nothing was short before, which is
 * the normal state of a healthy city; otherwise the caller runs the full solve.
 * Returns false (full solve needed) or true; sets X.netChanged when a building's status changed.
 */
function rebalance(S, kind) {
  if ((kind ? X.water : X.power).shortage) return false;
  const blist = X.blist, nb = blist.length, nc = X.compN[kind];
  if (X.cSup.length <= nc) { X.cSup = new Float64Array(nc * 2 + 8); X.cDem = new Float64Array(nc * 2 + 8); }
  const sup = X.cSup, dem = X.cDem;
  const out = kind ? X.cWo : X.cPo, use = kind ? X.cWu : X.cPw, lab = X.cLab[kind];
  for (let c = 0; c <= nc; c++) { sup[c] = 0; dem[c] = 0; }
  let supply = 0, demand = 0;
  for (let k = 0; k < nb; k++) {
    const o = out[k], u = use[k], c = lab[k];
    if (o > 0 && !(c > 0)) return false; // a new source (or one that came back): components change
    demand += u;
    supply += o;
    if (c > 0 && c <= nc) { sup[c] += o; dem[c] += u; }
  }
  for (let c = 1; c <= nc; c++) if (sup[c] < dem[c]) return false;
  // healthy: every building inside a component is served
  const info = newInfo(kind);
  const list = kind ? info.sources : info.plants;
  info.supply = supply;
  info.demand = demand;
  info.networks = nc;
  const net = X.cNet, srv = X.cSrv;
  for (let k = 0; k < nb; k++) {
    const c = lab[k];
    const o = out[k];
    if (o > 0) list.push({ b: blist[k], output: o });
    net[k] = c > 0 ? c : 0;
    srv[k] = c > 0 ? 1 : 0;
    if (c > 0) info.served += use[k];
  }
  info.connectedDemand = info.served;
  if (finishStatus(kind, info)) X.netChanged = true;
  commitInfo(kind, info);
  return true;
}

/**
 * Joins growables added since the last recalc to the cached networks (their footprints become
 * conductors). Returns false when a new building touches two different networks (they merge:
 * full solve needed).
 */
function joinNew(S) {
  const q = X.joinQ;
  if (!q.length) return true;
  const W = S.W, H = S.H, cond = X.cond, tileB = X.tileB, flags = X.fw, blist = X.blist;
  const cp = X.compT[0], cw = X.compT[1];
  const joined = X._joined || (X._joined = []);
  for (const b of q) {
    if (b.removed || !S.buildings.has(b.id) || b.key !== 'grow') continue;
    // labels of the conductors around the footprint (-1 = none seen yet)
    let lp = -1, lw = -1, clash = false;
    const see = (x, z) => {
      if (x < 0 || z < 0 || x >= W || z >= H) return;
      const i = z * W + x, c = cond[i];
      if (c & 1) { const v = cp[i]; if (lp < 0) lp = v; else if (lp !== v) clash = true; }
      if (c & 2) { const v = cw[i]; if (lw < 0) lw = v; else if (lw !== v) clash = true; }
    };
    for (let x = b.x; x < b.x + b.w; x++) { see(x, b.z - 1); see(x, b.z + b.d); }
    for (let z = b.z; z < b.z + b.d; z++) { see(b.x - 1, z); see(b.x + b.w, z); }
    if (clash) return false;
    const k = blist.length;
    blist.push(b);
    for (let z = b.z; z < b.z + b.d && z < H; z++)
      for (let x = b.x; x < b.x + b.w && x < W; x++) {
        const i = z * W + x;
        cond[i] = 3;
        tileB[i] = k;
        cp[i] = lp > 0 ? lp : 0;
        cw[i] = lw > 0 ? lw : 0;
        flags[i] |= F.POWERNET | F.WATERNET;
      }
    b.simNetP = lp > 0 ? lp : 0;
    b.simNetW = lw > 0 ? lw : 0;
    b.simRoad = buildingRoad(S, b);
    joined.push(b);
  }
  q.length = 0;
  return true;
}
/**
 * After a successful rebalance of kind 0 (power) / 1 (water): joined footprints in a served network
 * are energized, and so is the land they now reach (a full solve does this itself: done[kind] = false).
 * Writes the working flags X.fw.
 */
function energizeJoined(S, done) {
  const joined = X._joined;
  if (!joined || !joined.length) return;
  const W = S.W, H = S.H, cond = X.cond, flags = X.fw, hgt = S.height;
  for (const b of joined) {
    for (let kind = 0; kind < 2; kind++) {
      if (!done[kind] || !((kind ? b.simNetW : b.simNetP) > 0) || !(kind ? b.watered : b.powered)) continue;
      const FON = kind ? F.WATER : F.POWER, bit = kind ? 2 : 1;
      for (let z = b.z - 1; z <= b.z + b.d; z++)
        for (let x = b.x - 1; x <= b.x + b.w; x++) {
          if (x < 0 || z < 0 || x >= W || z >= H) continue;
          const i = z * W + x;
          const inside = x >= b.x && x < b.x + b.w && z >= b.z && z < b.z + b.d;
          const corner = (x < b.x || x >= b.x + b.w) && (z < b.z || z >= b.z + b.d);
          if (inside || (!corner && !(cond[i] & bit) && hgt[i] >= C.SEA)) flags[i] |= FON;
        }
    }
  }
  X.netChanged = true;
}

/**
 * Drops removed homes / shops / rubble from the cached network (their footprints stop conducting;
 * the land keeps power / water if a live conductor still touches it). A network split this may
 * cause is resolved by the next scheduled full rebuild (at most a month later).
 */
function compactRemoved(S) {
  const W = S.W, H = S.H, blist = X.blist, cond = X.cond, tileB = X.tileB, flags = X.fw;
  const cp = X.compT[0], cw = X.compT[1], road = S.road, pline = S.pline, hgt = S.height;
  const freed = X._freed || (X._freed = []);
  freed.length = 0;
  let k = 0;
  for (let j = 0; j < blist.length; j++) {
    const b = blist[j];
    const gone = b.removed || !S.buildings.has(b.id);
    for (let z = b.z; z < b.z + b.d && z < H; z++)
      for (let x = b.x; x < b.x + b.w && x < W; x++) {
        const i = z * W + x;
        if (tileB[i] !== j) continue;
        if (gone) {
          cond[i] = (road[i] ? 3 : 0) | (pline[i] ? 1 : 0);
          tileB[i] = -1;
          if (!cond[i]) { cp[i] = 0; cw[i] = 0; flags[i] &= ~(F.POWER | F.WATER | F.POWERNET | F.WATERNET); freed.push(i); }
        } else tileB[i] = k;
      }
    if (!gone) blist[k++] = b;
  }
  blist.length = k;
  // freed land next to a live, energized conductor is still "reached"
  for (const i of freed) {
    if (hgt[i] < C.SEA) continue;
    const x = i % W;
    for (let kind = 0; kind < 2; kind++) {
      const bit = kind ? 2 : 1, FON = kind ? F.WATER : F.POWER;
      const on = (j) => (cond[j] & bit) && (flags[j] & FON);
      if ((x > 0 && on(i - 1)) || (x < W - 1 && on(i + 1)) || (i >= W && on(i - W)) || (i < S.N - W && on(i + W))) flags[i] |= FON;
    }
  }
  X.softRemoved = false;
  X.netChanged = true;
}

/* ---------------- full rebuild of the network topology ---------------- */
function* rebuild(S, live) {
  const N = S.N, W = S.W, H = S.H, cond = X.cond, road = S.road, pline = S.pline, flags = X.fw;
  const tileB = X.tileB, blist = X.blist;
  let rx0 = W, rz0 = H, rx1 = -1, rz1 = -1;
  for (let i = 0; i < N; i++) {
    const r = road[i];
    cond[i] = (r ? 3 : 0) | (pline[i] ? 1 : 0);
    flags[i] &= ~F.ACCESS;
    tileB[i] = -1;
    if (r) {
      const x = i % W, z = (i - x) / W;
      if (x < rx0) rx0 = x;
      if (x > rx1) rx1 = x;
      if (z < rz0) rz0 = z;
      if (z > rz1) rz1 = z;
    }
  }
  X.roadBox = rx1 >= 0 ? [rx0, rz0, rx1, rz1] : null; // developed-area bounds for computeMaps
  X.plineCopy.set(pline);
  if (live) yield 'grid';
  yield* computeAccess(S, live);
  if (live) yield 'access';

  // snapshot buildings; footprints conduct power and water (rubble does not)
  blist.length = 0;
  for (const b of S.buildings.values()) {
    const k = blist.length;
    if (live && (k & 511) === 511) yield 'blist';
    blist.push(b);
    if (b.simNeedP == null) {
      b.simNeedP = X.needsPower(b);
      b.simNeedW = X.needsWater(b);
      const def = VC.BLD[b.key];
      b.simSrcP = !!(def && def.power > 0);
    }
    b.simRoad = buildingRoad(S, b);
    if (b.key === 'rubble') continue;
    for (let z = b.z; z < b.z + b.d && z < H; z++)
      for (let x = b.x; x < b.x + b.w && x < W; x++) {
        const i = z * W + x;
        cond[i] = 3;
        tileB[i] = k;
      }
  }
  X.joinQ.length = 0;
  if (X._joined) X._joined.length = 0;
  X.topoDirty = false;
  X.softRemoved = false;
  X.lastFullDay = S.time.day;
}

/* ---------------- recompute (sync API + staged job) ---------------- */
/**
 * The network pass as a generator. live = true: yields between chunks so the sim's job scheduler can
 * spread it over frames. Everything other modules can see stays consistent between chunks: the
 * topology (cond / tileB / blist) is private to the pass, every flag change goes to the working copy
 * X.fw, road access is rebuilt into X.accRoadW / accDistW, the solves publish fresh info objects, and
 * S.flags (POWER/WATER/*NET/ACCESS bits) + X.accRoad / accDist are updated in one go at the end.
 * ck {work, t0}: work-time clock maintained by the scheduler (null for a synchronous run).
 */
function* netGen(S, force, live, ck) {
  const clk = ck || { work: 0, t0: performance.now() };
  X.ensureNet(S);
  X.netDirty = false; // edits after this point schedule the next pass
  ACC = ACCD = null;
  const blist = X.blist;
  let full = force === true || X.topoDirty || (!blist.length && S.buildings.size > 0);
  // removals are handled cheaply, with a full rebuild at least monthly to catch network splits
  if (!full && X.softRemoved && !(S.time.day - (X.lastFullDay || 0) < 30)) full = true;
  X.netChanged = false;
  // every flag change of this pass goes to the working copy, published in one piece at the end
  X.fw.set(S.flags);
  if (!full && X.softRemoved) compactRemoved(S);
  if (!full && !joinNew(S)) full = true;
  if (full) yield* rebuild(S, live);
  if (live) yield 'topo';
  yield* columns(S, live);
  if (full) X.netChanged = true;
  let mode = full ? 'full' : 'rebalance';
  const done = [false, false];
  if (!full && rebalance(S, 0)) done[0] = true;
  else {
    if (live) yield 'bal0';
    yield* solve(S, 0, live);
    X.netChanged = true;
    if (!full) mode = 'resolve';
  }
  // water outputs: pumps only run while powered
  const n = X.blist.length, on = X.cOn[0], wb = X.cWb, wo = X.cWo, fl = X.cFl;
  let unpSrc = 0;
  for (let k = 0; k < n; k++) {
    const w = on[k] ? wb[k] : 0;
    wo[k] = w;
    if (w <= 0 && (fl[k] & CF_BUILT) && !on[k] && (fl[k] & CF_WSRC)) unpSrc++;
  }
  if (!full && rebalance(S, 1)) done[1] = true;
  else {
    if (live) yield 'bal1';
    yield* solve(S, 1, live);
    X.netChanged = true;
    if (!full) mode = 'resolve';
  }
  X.water.unpoweredSources = unpSrc;
  energizeJoined(S, done);
  if (X._joined) X._joined.length = 0;
  // publish: flags (network + access bits), then the rebuilt access arrays
  const flags = S.flags, fw = X.fw, N = S.N, MASK = F.POWER | F.WATER | F.POWERNET | F.WATERNET | F.ACCESS, KEEP = ~MASK & 255;
  for (let i = 0; i < N; i++) flags[i] = (flags[i] & KEEP) | (fw[i] & MASK);
  if (ACC) {
    X.accRoadW = X.accRoad;
    X.accDistW = X.accDist;
    X.accRoad = ACC;
    X.accDist = ACCD;
    ACC = ACCD = null;
  }

  const st = S.stats;
  st.powerSupply = Math.round(X.power.supply);
  st.powerDemand = Math.round(X.power.demand);
  st.waterSupply = Math.round(X.water.supply);
  st.waterDemand = Math.round(X.water.demand);
  X.lastNet = performance.now();
  X.netMs = clk.work + (X.lastNet - clk.t0);
  X.netProf = { mode, ms: +X.netMs.toFixed(2) };
  // adaptive throttle for editing: never spend more than ~1/4 of the time re-solving
  X.netGap = Math.max(150, X.netMs * 4);
  if (X.netChanged) {
    S.ver.flags++;
    VC.bus.emit('flagsUpdated');
  }
}
X.netGen = netGen;

/**
 * Recomputes flags, served state and balances NOW (synchronously; cancels a staged pass that is
 * still running). force = true: full topology rebuild + solve. Otherwise the cached topology is
 * re-used when possible (see header). Emits 'flagsUpdated' when anything visible changed.
 */
SIM.recalcNetworks = function (force) {
  const S = VC.state;
  if (!S || !S.flags) return;
  if (X.cancelJob) X.cancelJob('net');
  const g = netGen(S, force, false, null);
  while (!g.next().done);
};

/** True if the pline layer changed inside rect (cheap check used on 'dirty'). */
X.plineChanged = function (S, r) {
  if (!X.plineCopy || X.plineCopy.length !== S.N) return true;
  const W = S.W, p = S.pline, c = X.plineCopy;
  for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) { const i = z * W + x; if (p[i] !== c[i]) return true; }
  return false;
};
