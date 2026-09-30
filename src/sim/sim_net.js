/*
 * VOXELPOLIS — simulation: utility networks and road access (part of VC.sim).
 *
 *   VC.sim.recalcNetworks(force)  immediate recompute of S.flags (POWER, WATER, ACCESS, POWERNET, WATERNET),
 *                            b.powered / b.watered / b.simRoad, power & water balance. Emits 'flagsUpdated'
 *                            when something changed. force = true: full topology rebuild.
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
/** Water producers (pumps, towers, plants) get power first during a brownout. */
const isWaterSource = (b) => {
  const def = b.key !== 'grow' ? VC.BLD[b.key] : null;
  return !!def && def.water > 0;
};

/* ---------------- buffers ---------------- */
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
  X.plineCopy = new Uint8Array(N);
  X.tileB = new Int32Array(N);
  X.compT = [new Int32Array(N), new Int32Array(N)]; // component id per tile (power, water); 0 = none
  X.compN = [0, 0];
  X.cSup = new Float64Array(64);
  X.cDem = new Float64Array(64);
  X.blist = [];
  X.joinQ = [];
  X.epoch = 1;
  X.topoDirty = true;
  X.power = { supply: 0, demand: 0, served: 0, connectedDemand: 0, plants: [], unpowered: 0, networks: 0, shortage: false };
  X.water = { supply: 0, demand: 0, served: 0, connectedDemand: 0, sources: [], unwatered: 0, unpoweredSources: 0, networks: 0, shortage: false };
};

/* ---------------- road access (multi-source BFS, depth C.ROAD_ACCESS) ---------------- */
function computeAccess(S) {
  const W = S.W, H = S.H, N = S.N;
  const acc = X.accRoad, dist = X.accDist, q = X.queue, flags = S.flags, road = S.road, hgt = S.height;
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
  }
  for (let i = 0; i < N; i++) if (dist[i] <= R) flags[i] |= F.ACCESS;
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
  let best = -1, bd = 255;
  for (let z = b.z; z < b.z + b.d; z++)
    for (let x = b.x; x < b.x + b.w; x++) {
      if (x < 0 || z < 0 || x >= W || z >= H) continue;
      const i = z * W + x;
      const r = X.accRoad[i];
      if (r >= 0 && X.accDist[i] < bd) {
        bd = X.accDist[i];
        best = r;
      }
    }
  return best;
}
X.buildingRoad = buildingRoad;

/* ---------------- generic network solve ---------------- */
/** Per-building served status after a solve / rebalance (kind 0 power, 1 water). */
function finishStatus(kind, info) {
  const blist = X.blist, nb = blist.length;
  let changed = false;
  for (let k = 0; k < nb; k++) {
    const b = blist[k];
    if (kind) {
      const ok = !b.simNeedW || b.simWo > 0 || b.simServed === 1;
      if (b.watered !== ok) changed = true;
      b.watered = ok;
      b.simNetW = b.simNet;
      if (!ok) info.unwatered++;
    } else {
      const ok = !b.simNeedP || b.simPo > 0 || b.simServed === 1 || b.simSrcP;
      if (b.powered !== ok) changed = true;
      b.powered = ok;
      b.simNetP = b.simNet;
      if (!ok) info.unpowered++;
    }
  }
  return changed;
}
function resetInfo(info) {
  info.supply = 0;
  info.demand = 0;
  info.served = 0;
  info.connectedDemand = 0;
  info.unpowered = 0;
  info.unwatered = 0;
  info.networks = 0;
  info.shortage = false;
}

/**
 * kind 0 = power, 1 = water. Works on X.blist (array snapshot of buildings) and X.tileB
 * (tile -> blist index, -1 none) built by recalcNetworks, so the hot loops avoid Map lookups.
 * Uses b.simPo/b.simWo (outputs) and b.simPw/b.simWu (uses); writes the flag bits, the component
 * labels (X.compT[kind], b.simNetP / simNetW), b.powered/b.watered and the info object.
 */
function solve(S, kind) {
  const W = S.W, H = S.H, N = S.N;
  const bit = kind ? 2 : 1;
  const FNET = kind ? F.WATERNET : F.POWERNET;
  const FON = kind ? F.WATER : F.POWER;
  const cond = X.cond, mark = X.mark, q = X.queue, q2 = X.queue2, flags = S.flags, compT = X.compT[kind];
  const blist = X.blist, tileB = X.tileB, nb = blist.length;
  const info = kind ? X.water : X.power;
  const list = kind ? info.sources : info.plants;
  list.length = 0;
  resetInfo(info);

  // reset served state; tally totals
  for (let k = 0; k < nb; k++) {
    const b = blist[k];
    const out = kind ? b.simWo : b.simPo;
    b.simNet = 0; // component id
    b.simServed = 0; // 0 = not reached, 1 = served, 2 = reached but blacked out
    info.demand += kind ? b.simWu : b.simPw;
    if (out > 0) {
      info.supply += out;
      list.push({ b, output: out });
    }
  }
  // clear flags bits, set NET bit on all conductors, clear component labels
  for (let i = 0; i < N; i++) {
    let f = flags[i] & ~(FNET | FON);
    if (cond[i] & bit) f |= FNET;
    flags[i] = f;
    compT[i] = 0;
  }

  const ep = ++X.epoch;
  let comp = 0;
  const compBld = X._compBld || (X._compBld = []);
  for (let s = 0; s < list.length; s++) {
    const sb = list[s].b;
    const si = sb.z * W + sb.x;
    if (mark[si] === ep) continue; // component already solved
    comp++;
    info.networks++;
    // ---- flood fill the component, collecting buildings ----
    let qt = 0, qh = 0;
    compBld.length = 0;
    let supply = 0, demand = 0;
    mark[si] = ep;
    q[qt++] = si;
    while (qh < qt) {
      const i = q[qh++];
      compT[i] = comp;
      const k = tileB[i];
      if (k >= 0) {
        const b = blist[k];
        if (b.simNet !== comp) {
          b.simNet = comp;
          compBld.push(b);
          supply += kind ? b.simWo : b.simPo;
          demand += kind ? b.simWu : b.simPw;
        }
      }
      const x = i % W;
      if (x > 0 && (cond[i - 1] & bit) && mark[i - 1] !== ep) { mark[i - 1] = ep; q[qt++] = i - 1; }
      if (x < W - 1 && (cond[i + 1] & bit) && mark[i + 1] !== ep) { mark[i + 1] = ep; q[qt++] = i + 1; }
      if (i >= W && (cond[i - W] & bit) && mark[i - W] !== ep) { mark[i - W] = ep; q[qt++] = i - W; }
      if (i < N - W && (cond[i + W] & bit) && mark[i + W] !== ep) { mark[i + W] = ep; q[qt++] = i + W; }
    }
    info.connectedDemand += demand;
    if (supply >= demand) {
      // everyone served
      for (let k = 0; k < qt; k++) flags[q[k]] |= FON;
      for (let k = 0; k < compBld.length; k++) compBld[k].simServed = 1;
      info.served += demand;
      continue;
    }
    // ---- shortage ----
    info.shortage = true;
    let remaining = supply;
    // power: water sources first — they draw little, and without them the whole town runs dry
    if (!kind) {
      for (const b of compBld) {
        if (b.simServed === 0 && b.simPo <= 0 && isWaterSource(b) && remaining >= b.simPw) {
          remaining -= b.simPw;
          info.served += b.simPw;
          b.simServed = 1;
        }
      }
    }
    // then serve in BFS order from every source until the supply runs out
    const ep2 = ++X.epoch;
    let h2 = 0, t2 = 0;
    for (const b of compBld) {
      if ((kind ? b.simWo : b.simPo) > 0) {
        for (let z = b.z; z < b.z + b.d && z < H; z++)
          for (let x = b.x; x < b.x + b.w && x < W; x++) {
            const i = z * W + x;
            if (mark[i] === ep) { mark[i] = ep2; q2[t2++] = i; }
          }
        b.simServed = 1;
      }
    }
    while (h2 < t2) {
      const i = q2[h2++];
      const k = tileB[i];
      if (k >= 0) {
        const b = blist[k];
        if (b.simNet === comp && b.simServed === 0) {
          const use = kind ? b.simWu : b.simPw;
          if (remaining >= use) {
            remaining -= use;
            info.served += use;
            b.simServed = 1;
          } else b.simServed = 2;
        }
      }
      // conductors carry energy while supply remains
      if (remaining > 0) flags[i] |= FON;
      const x = i % W;
      if (x > 0 && mark[i - 1] === ep) { mark[i - 1] = ep2; q2[t2++] = i - 1; }
      if (x < W - 1 && mark[i + 1] === ep) { mark[i + 1] = ep2; q2[t2++] = i + 1; }
      if (i >= W && mark[i - W] === ep) { mark[i - W] = ep2; q2[t2++] = i - W; }
      if (i < N - W && mark[i + W] === ep) { mark[i + W] = ep2; q2[t2++] = i + W; }
    }
    // footprints show exactly the building's state
    for (const b of compBld) {
      const on = b.simServed === 1;
      if (!on) b.simServed = 2;
      for (let z = b.z; z < b.z + b.d && z < H; z++)
        for (let x = b.x; x < b.x + b.w && x < W; x++) {
          if (on) flags[z * W + x] |= FON;
          else flags[z * W + x] &= ~FON;
        }
    }
  }
  X.compN[kind] = comp;

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
  return true;
}

/**
 * Cheap re-balance on unchanged topology: sums supply and demand per cached component. Succeeds
 * (true) when every component can serve all its buildings and nothing was short before, which is
 * the normal state of a healthy city; otherwise the caller runs the full solve.
 * Returns false (full solve needed) or true; sets X.netChanged when a building's status changed.
 */
function rebalance(S, kind) {
  const info = kind ? X.water : X.power;
  if (info.shortage) return false;
  const blist = X.blist, nb = blist.length, nc = X.compN[kind];
  if (X.cSup.length <= nc) { X.cSup = new Float64Array(nc * 2 + 8); X.cDem = new Float64Array(nc * 2 + 8); }
  const sup = X.cSup, dem = X.cDem;
  for (let c = 0; c <= nc; c++) { sup[c] = 0; dem[c] = 0; }
  let supply = 0, demand = 0;
  for (let k = 0; k < nb; k++) {
    const b = blist[k];
    const out = kind ? b.simWo : b.simPo, use = kind ? b.simWu : b.simPw;
    const c = kind ? b.simNetW : b.simNetP;
    if (out > 0 && !(c > 0)) return false; // a new source (or one that came back): components change
    demand += use;
    supply += out;
    if (c > 0 && c <= nc) { sup[c] += out; dem[c] += use; }
  }
  for (let c = 1; c <= nc; c++) if (sup[c] < dem[c]) return false;
  // healthy: every building inside a component is served
  const list = kind ? info.sources : info.plants;
  list.length = 0;
  resetInfo(info);
  info.supply = supply;
  info.demand = demand;
  info.networks = nc;
  for (let k = 0; k < nb; k++) {
    const b = blist[k];
    const c = kind ? b.simNetW : b.simNetP;
    const out = kind ? b.simWo : b.simPo;
    if (out > 0) list.push({ b, output: out });
    b.simNet = c > 0 ? c : 0;
    b.simServed = c > 0 ? 1 : 0;
    if (c > 0) info.served += kind ? b.simWu : b.simPw;
  }
  info.connectedDemand = info.served;
  if (finishStatus(kind, info)) X.netChanged = true;
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
  const W = S.W, H = S.H, cond = X.cond, tileB = X.tileB, flags = S.flags, blist = X.blist;
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
 */
function energizeJoined(S, done) {
  const joined = X._joined;
  if (!joined || !joined.length) return;
  const W = S.W, H = S.H, cond = X.cond, flags = S.flags, hgt = S.height;
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
  const W = S.W, H = S.H, blist = X.blist, cond = X.cond, tileB = X.tileB, flags = S.flags;
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
function rebuild(S) {
  const N = S.N, W = S.W, H = S.H, cond = X.cond, road = S.road, pline = S.pline, flags = S.flags;
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
  computeAccess(S);

  // snapshot buildings; footprints conduct power and water (rubble does not)
  blist.length = 0;
  for (const b of S.buildings.values()) {
    const k = blist.length;
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

/* ---------------- public: recompute ---------------- */
/**
 * Recomputes flags, served state and balances. force = true: full topology rebuild + solve.
 * Otherwise the cached topology is re-used when possible (see header). Emits 'flagsUpdated' when
 * anything visible changed.
 */
SIM.recalcNetworks = function (force) {
  const S = VC.state;
  if (!S || !S.flags) return;
  const t0 = performance.now();
  X.ensureNet(S);
  const blist = X.blist;
  let full = force === true || X.topoDirty || (!blist.length && S.buildings.size > 0);
  // removals are handled cheaply, with a full rebuild at least monthly to catch network splits
  if (!full && X.softRemoved && !(S.time.day - (X.lastFullDay || 0) < 30)) full = true;
  X.netChanged = false;
  if (!full && X.softRemoved) compactRemoved(S);
  if (!full && !joinNew(S)) full = true;
  if (full) rebuild(S);
  // outputs / uses (outputs of pumps are evaluated after the power pass: they need power)
  for (let k = 0; k < blist.length; k++) {
    const b = blist[k];
    b.simPo = X.powerOut(S, b);
    b.simPw = b.simNeedP ? X.powerUse(S, b) : 0;
  }
  if (full) X.netChanged = true;
  let mode = full ? 'full' : 'rebalance';
  const done = [false, false];
  if (!full && rebalance(S, 0)) done[0] = true;
  else { solve(S, 0); X.netChanged = true; if (!full) mode = 'resolve'; }
  let unpSrc = 0;
  for (let k = 0; k < blist.length; k++) {
    const b = blist[k];
    b.simWo = X.waterOut(S, b);
    b.simWu = b.simNeedW ? X.waterUse(S, b) : 0;
    if (b.simWo <= 0 && b.built >= 1 && !b.powered && isWaterSource(b)) unpSrc++;
  }
  if (!full && rebalance(S, 1)) done[1] = true;
  else { solve(S, 1); X.netChanged = true; if (!full) mode = 'resolve'; }
  X.water.unpoweredSources = unpSrc;
  energizeJoined(S, done);
  if (X._joined) X._joined.length = 0;

  const st = S.stats;
  st.powerSupply = Math.round(X.power.supply);
  st.powerDemand = Math.round(X.power.demand);
  st.waterSupply = Math.round(X.water.supply);
  st.waterDemand = Math.round(X.water.demand);
  X.netDirty = false;
  X.lastNet = performance.now();
  X.netMs = X.lastNet - t0;
  X.netProf = { mode, ms: +X.netMs.toFixed(2) };
  // adaptive throttle for editing: never spend more than ~1/4 of the time re-solving
  X.netGap = Math.max(150, X.netMs * 4);
  if (X.netChanged) {
    S.ver.flags++;
    VC.bus.emit('flagsUpdated');
  }
};

/** True if the pline layer changed inside rect (cheap check used on 'dirty'). */
X.plineChanged = function (S, r) {
  if (!X.plineCopy || X.plineCopy.length !== S.N) return true;
  const W = S.W, p = S.pline, c = X.plineCopy;
  for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) { const i = z * W + x; if (p[i] !== c[i]) return true; }
  return false;
};
