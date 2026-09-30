/*
 * VOXELPOLIS — simulation: utility networks and road access (part of VC.sim).
 *
 *   VC.sim.recalcNetworks()  immediate recompute of S.flags (POWER, WATER, ACCESS, POWERNET, WATERNET),
 *                            b.powered / b.watered / b.simRoad, power & water balance. Emits 'flagsUpdated'.
 *
 * POWER conducts through road tiles (any type, incl. bridges), power lines (S.pline) and building
 * footprints (4-neighbour). Zoned-but-empty tiles do not conduct, but energized conductors "reach"
 * 1 tile into non-conducting land (so zones beside a powered road can develop; interior lots get
 * power once their neighbours are built — lots fill from the street inward). WATER is the same through roads + buildings (pipes run
 * under roads; power lines carry no water) and its pumps only run while powered.
 * Per connected component: supply >= demand -> everyone served; otherwise buildings are served in
 * BFS order from the sources until the supply runs out (the far end of town blacks out).
 * ACCESS = within C.ROAD_ACCESS tiles of a street/avenue (highways give no access); the nearest
 * access road tile per tile is kept in X.accRoad for traffic and building rotation.
 */
const SIM = (VC.sim = VC.sim || {});
const X = (SIM._ = SIM._ || {});
const C = VC.C, F = VC.F, M = VC.M;

/* ---------------- per-building utility use / output ---------------- */
const USE_R = 0.02, USE_C = 0.04, USE_I = 0.08; // MW per resident / job
const WUSE_R = 0.04, WUSE_J = 0.03; // kL per resident / job

/** Season daylight factor for solar (month 0 = Jan). */
function solarFactor(S) {
  const m = Math.floor(S.time.day / C.DAYS_PER_MONTH) % 12;
  const season = m >= 5 && m <= 7 ? 1.0 : m === 11 || m <= 1 ? 0.55 : 0.8;
  const cloud = S.weather ? S.weather.cloud || 0 : 0.25;
  return season * (1 - 0.35 * M.sat(cloud));
}
/** Wind turbine factor: weather wind and elevation above the sea. */
function windFactor(S, b) {
  const wind = S.weather && S.weather.wind != null ? M.sat(S.weather.wind) : 0.5;
  const h = S.height[b.z * S.W + b.x] - C.SEA;
  return (0.35 + 0.9 * wind) * (0.75 + 0.5 * M.sat(h / 24));
}

/** Utilities funding: underfunded plants run below capacity (60% at zero funding, ~108% at 150%). */
function fundMul() {
  const e = X.eff ? X.eff('utilities') : 1;
  return M.clamp(0.6 + 0.4 * e, 0.6, 1.1);
}
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
  let p = def.power * fundMul();
  if (b.key === 'wind_turbine') p *= windFactor(S, b);
  else if (b.key === 'solar_farm') p *= solarFactor(S);
  if (b.fire > 0) p *= 0.4;
  return p;
};
/** Water output (kL) — pumps must be powered. */
X.waterOut = function (S, b) {
  const def = VC.BLD[b.key];
  if (!def || !def.water || b.built < 1 || !b.powered) return 0;
  return def.water * fundMul() * (b.fire > 0 ? 0.4 : 1);
};
/** Power consumption (MW). */
X.powerUse = function (S, b) {
  let u = 0;
  if (b.key === 'grow') {
    const occ = Math.max(b.pop, b.cap * 0.25);
    u = b.built < 1 ? b.cap * 0.002 : occ * (b.zt === 1 ? USE_R : b.zt === 2 ? USE_C : USE_I);
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
    u = b.built < 1 ? 0 : occ * (b.zt === 1 ? WUSE_R : WUSE_J);
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
  X.blist = [];
  X.epoch = 1;
  X.power = { supply: 0, demand: 0, served: 0, connectedDemand: 0, plants: [], unpowered: 0, networks: 0, shortage: false };
  X.water = { supply: 0, demand: 0, served: 0, connectedDemand: 0, sources: [], unwatered: 0, networks: 0, shortage: false };
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

/** Nearest access road tile for a building (-1 if none within range). */
function buildingRoad(S, b) {
  const W = S.W;
  let best = -1, bd = 255;
  for (let z = b.z; z < b.z + b.d; z++)
    for (let x = b.x; x < b.x + b.w; x++) {
      if (x < 0 || z < 0 || x >= W || z >= S.H) continue;
      const i = z * W + x;
      const r = X.accRoad[i];
      if (r >= 0 && X.accDist[i] < bd) {
        bd = X.accDist[i];
        best = r;
      }
    }
  // adjacent tiles (building tiles themselves are at distance >= 1 from the road)
  return best;
}

/* ---------------- generic network solve ---------------- */
/**
 * kind 0 = power, 1 = water. Works on X.blist (array snapshot of buildings) and X.tileB
 * (tile -> blist index, -1 none) built by recalcNetworks, so the hot loops avoid Map lookups.
 * Uses b.simPo/b.simWo (outputs) and b.simPw/b.simWu (uses); writes the flag bits,
 * b.powered/b.watered and the info object.
 */
function solve(S, kind) {
  const W = S.W, H = S.H, N = S.N;
  const bit = kind ? 2 : 1;
  const FNET = kind ? F.WATERNET : F.POWERNET;
  const FON = kind ? F.WATER : F.POWER;
  const cond = X.cond, mark = X.mark, q = X.queue, q2 = X.queue2, flags = S.flags;
  const blist = X.blist, tileB = X.tileB, nb = blist.length;
  const info = kind ? X.water : X.power;
  const list = kind ? info.sources : info.plants;
  list.length = 0;
  info.supply = 0;
  info.demand = 0;
  info.served = 0;
  info.connectedDemand = 0;
  info.unpowered = 0;
  info.unwatered = 0;
  info.networks = 0;
  info.shortage = false;

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
  // clear flags bits, set NET bit on all conductors
  for (let i = 0; i < N; i++) {
    let f = flags[i] & ~(FNET | FON);
    if (cond[i] & bit) f |= FNET;
    flags[i] = f;
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
    // ---- shortage: serve in BFS order from every source until supply runs out ----
    info.shortage = true;
    const ep2 = ++X.epoch;
    let h2 = 0, t2 = 0, remaining = supply;
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

  // ---- building status ----
  for (let k = 0; k < nb; k++) {
    const b = blist[k];
    if (kind) {
      const ok = !b.simNeedW || b.simWo > 0 || b.simServed === 1;
      b.watered = ok;
      b.simNetW = b.simNet;
      if (!ok) info.unwatered++;
    } else {
      const ok = !b.simNeedP || b.simPo > 0 || b.simServed === 1 || b.simSrcP;
      b.powered = ok;
      b.simNetP = b.simNet;
      if (!ok) info.unpowered++;
    }
  }
}

/* ---------------- public: full recompute ---------------- */
SIM.recalcNetworks = function () {
  const S = VC.state;
  if (!S || !S.flags) return;
  const t0 = performance.now();
  X.ensureNet(S);
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
    b.simPo = X.powerOut(S, b);
    b.simPw = b.simNeedP ? X.powerUse(S, b) : 0;
    if (b.key === 'rubble') continue;
    for (let z = b.z; z < b.z + b.d && z < H; z++)
      for (let x = b.x; x < b.x + b.w && x < W; x++) {
        const i = z * W + x;
        cond[i] = 3;
        tileB[i] = k;
      }
  }
  solve(S, 0);
  // water: pumps need power, so outputs are evaluated after the power solve
  for (let k = 0; k < blist.length; k++) {
    const b = blist[k];
    b.simWo = X.waterOut(S, b);
    b.simWu = b.simNeedW ? X.waterUse(S, b) : 0;
  }
  solve(S, 1);
  blist.length = 0; // do not keep removed buildings alive

  const st = S.stats;
  st.powerSupply = Math.round(X.power.supply);
  st.powerDemand = Math.round(X.power.demand);
  st.waterSupply = Math.round(X.water.supply);
  st.waterDemand = Math.round(X.water.demand);
  X.netDirty = false;
  X.lastNet = performance.now();
  X.netMs = X.lastNet - t0;
  S.ver.flags++;
  VC.bus.emit('flagsUpdated');
};

/** True if the pline layer changed inside rect (cheap check used on 'dirty'). */
X.plineChanged = function (S, r) {
  if (!X.plineCopy || X.plineCopy.length !== S.N) return true;
  const W = S.W, p = S.pline, c = X.plineCopy;
  for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) { const i = z * W + x; if (p[i] !== c[i]) return true; }
  return false;
};
