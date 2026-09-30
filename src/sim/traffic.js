/*
 * VOXELPOLIS — simulation: commuter traffic on the road graph (part of VC.sim).
 *
 *   VC.sim.computeTraffic()      full recompute (sim calls it every 8 days; ~1-3 ms on 128x128)
 *   VC.sim.trafficAt(x, z)       congestion ratio on a road tile (0 empty, 1 at capacity, >1 jammed)
 *   VC.sim.trafficVolume         Float32Array(N): peak-hour cars per road tile (for the car renderer)
 *   VC.sim.trafficParent         Int32Array(N): next road tile toward jobs (-1 = none) — cars can follow it
 *   VC.sim.trafficStats()        {avgCongestion, jammedTiles, roadTiles, noPath, trips}
 *
 * Model: multi-source Dijkstra over road tiles from every job building's access road tile (sources
 * with many open jobs start slightly "closer" so big employers attract more commuters). Edge cost =
 * 1/speed of the road type, inflated by last run's congestion, so traffic spreads onto alternatives.
 * Each residential building sends pop * 0.5 (workers) * car share * peak factor along the parent
 * pointers; volumes are accumulated in reverse settle order (O(road tiles), not O(paths)).
 * Transit coverage and mods.traffic reduce the car share. Result -> S.maps.traffic (0..255,
 * 170 = at capacity). Road funding scales capacity (50% at 0% funding .. 110%).
 * Residential buildings with no road path to any job get b.simCommute = -1 (a happiness problem);
 * otherwise b.simCommute is the congestion-inflated travel time, so jams lengthen commutes
 * (sim.js turns long commutes and jammed home streets into unhappiness, lower job fill and
 * lower shop desirability).
 */
const SIM = (VC.sim = VC.sim || {});
const X = (SIM._ = SIM._ || {});
const M = VC.M;

const PEAK = 0.3; // share of commuters on the road in the peak hour
const INF = 1e30;

function ensure(S) {
  const N = S.N;
  if (X.trN === N && X.trDist) return;
  X.trN = N;
  X.trDist = new Float32Array(N);
  X.trOrder = new Int32Array(N);
  X.trHeapI = new Int32Array(N * 4 + 16); // lazy deletion: up to 4 relaxations per road tile
  X.trHeapK = new Float32Array(N * 4 + 16);
  X.trBias = new Float32Array(N); // source attraction bias carried along the tree (dist - bias = travel time)
  X.trCong = new Float32Array(N);
  SIM.trafficVolume = new Float32Array(N);
  SIM.trafficParent = new Int32Array(N).fill(-1);
  X.trStats = { avgCongestion: 0, jammedTiles: 0, roadTiles: 0, noPath: 0, trips: 0 };
}

/* binary min-heap on typed arrays (lazy deletion) */
let hn = 0;
function hpush(i, k) {
  const HI = X.trHeapI, HK = X.trHeapK;
  let c = hn++;
  while (c > 0) {
    const p = (c - 1) >> 1;
    if (HK[p] <= k) break;
    HI[c] = HI[p];
    HK[c] = HK[p];
    c = p;
  }
  HI[c] = i;
  HK[c] = k;
}
function hpop() {
  const HI = X.trHeapI, HK = X.trHeapK;
  const top = HI[0];
  const li = HI[--hn], lk = HK[hn];
  let c = 0;
  for (;;) {
    let l = c * 2 + 1;
    if (l >= hn) break;
    if (l + 1 < hn && HK[l + 1] < HK[l]) l++;
    if (HK[l] >= lk) break;
    HI[c] = HI[l];
    HK[c] = HK[l];
    c = l;
  }
  HI[c] = li;
  HK[c] = lk;
  return top;
}

SIM.computeTraffic = function () {
  const S = VC.state;
  if (!S || !S.road) return;
  const t0 = performance.now();
  ensure(S);
  const W = S.W, N = S.N, road = S.road, maps = S.maps;
  const dist = X.trDist, order = X.trOrder, cong = X.trCong, bias = X.trBias;
  const vol = SIM.trafficVolume, parent = SIM.trafficParent;
  const ROADS = VC.ROADS;
  // edge costs per road type
  const cost = [0, 1 / ROADS[1].speed, 1 / ROADS[2].speed, 1 / ROADS[3].speed];
  // road maintenance funding: neglected roads (potholes, lane closures) carry less traffic —
  // half the capacity at zero funding (sim.js also charges a road-condition happiness penalty)
  const rf = M.clamp(0.5 + 0.5 * (X.eff ? X.eff('roads') : 1), 0.5, 1.1);
  const capOf = [1, ROADS[1].capacity * rf, ROADS[2].capacity * rf, ROADS[3].capacity * rf];

  dist.fill(INF);
  parent.fill(-1);
  vol.fill(0);
  hn = 0;
  // ---- sources: job buildings' access road tiles ----
  let sources = 0;
  for (const b of S.buildings.values()) {
    if (b.built < 1 || b.abandoned) continue;
    let jobs = 0;
    if (b.key === 'grow') {
      if (b.zt === 1) continue;
      jobs = b.cap;
    } else {
      const def = VC.BLD[b.key];
      jobs = def ? def.jobs || 0 : 0;
    }
    if (jobs <= 0) continue;
    const r = b.simRoad;
    if (r == null || r < 0 || !road[r]) continue;
    // bigger employers pull commuters from further away
    const k = -Math.min(6, Math.log(1 + jobs / 25) * 1.6);
    if (k < dist[r]) {
      dist[r] = k;
      bias[r] = k;
      hpush(r, k);
      sources++;
    }
  }
  // ---- Dijkstra over road tiles ----
  let settled = 0;
  while (hn > 0) {
    const kTop = X.trHeapK[0];
    const i = hpop();
    if (kTop > dist[i]) continue; // stale entry
    order[settled++] = i;
    const x = i % W;
    const base = dist[i];
    // cost to step onto neighbour j
    for (let n = 0; n < 4; n++) {
      let j;
      if (n === 0) { if (x === 0) continue; j = i - 1; }
      else if (n === 1) { if (x === W - 1) continue; j = i + 1; }
      else if (n === 2) { if (i < W) continue; j = i - W; }
      else { if (i >= N - W) continue; j = i + W; }
      const rt = road[j];
      if (!rt) continue;
      const c = cong[j];
      const nd = base + cost[rt] * (c > 0.8 ? 1 + (c - 0.8) * 1.5 : 1);
      if (nd < dist[j]) {
        dist[j] = nd;
        bias[j] = bias[i];
        parent[j] = i;
        hpush(j, nd);
      }
    }
  }

  // ---- commuters from homes ----
  const transit = maps.transit;
  const carBase = 0.85 * Math.max(0.2, 1 + (S.mods.traffic || 0));
  let noPath = 0, trips = 0;
  for (const b of S.buildings.values()) {
    const res = b.key === 'grow' ? (b.zt === 1 ? b.pop : 0) : b.key === 'arcology' ? b.pop * 0.35 : 0;
    if (b.key === 'grow' && b.zt !== 1) {
      // workplaces: commute ok if the building is on the network at all
      b.simCommute = b.simRoad >= 0 && dist[b.simRoad] < INF ? 0 : -1;
      continue;
    }
    if (b.key !== 'grow' && b.key !== 'arcology') continue;
    const r = b.simRoad;
    if (r == null || r < 0 || dist[r] >= INF) {
      // jobs exist but no road leads there (with no jobs at all, unemployment covers it)
      b.simCommute = sources > 0 ? -1 : 0;
      if (sources > 0 && res > 0) noPath++;
      continue;
    }
    b.simCommute = dist[r] - bias[r]; // travel time (street-tile units) to the chosen workplace
    if (res <= 0) continue;
    const i = b.simI != null ? b.simI : b.z * W + b.x;
    const car = carBase * (1 - (transit[i] / 255) * 0.6);
    const t = res * 0.5 * car * PEAK;
    vol[r] += t;
    trips += t;
  }
  // ---- accumulate along the shortest-path tree (farthest first) ----
  for (let k = settled - 1; k >= 0; k--) {
    const i = order[k];
    const p = parent[i];
    if (p >= 0) vol[p] += vol[i];
  }
  // ---- congestion -> map ----
  const out = maps.traffic;
  let sum = 0, roadTiles = 0, jammed = 0;
  for (let i = 0; i < N; i++) {
    const rt = road[i];
    if (!rt) {
      out[i] = 0;
      cong[i] = 0;
      continue;
    }
    const c = vol[i] / capOf[rt];
    // smooth over runs so traffic does not flicker
    cong[i] = cong[i] * 0.3 + c * 0.7;
    const v = cong[i] * 170;
    out[i] = v >= 255 ? 255 : v;
    roadTiles++;
    sum += cong[i] > 1 ? 1 : cong[i];
    if (cong[i] > 1) jammed++;
  }
  const st = X.trStats;
  st.avgCongestion = roadTiles ? sum / roadTiles : 0;
  st.jammedTiles = jammed;
  st.roadTiles = roadTiles;
  st.noPath = noPath;
  st.trips = Math.round(trips);
  X.trafficMs = performance.now() - t0;
};

/** Congestion ratio on a tile (0 = empty road or not a road, 1 = at capacity, >1 jammed). */
SIM.trafficAt = function (x, z) {
  const S = VC.state;
  if (!S || !X.trCong || x < 0 || z < 0 || x >= S.W || z >= S.H) return 0;
  return X.trCong[z * S.W + x];
};
SIM.trafficStats = function () {
  return X.trStats || { avgCongestion: 0, jammedTiles: 0, roadTiles: 0, noPath: 0, trips: 0 };
};
/**
 * New game / load: congestion memory comes from the (saved) traffic map, never from the previous
 * city, so a loaded game continues exactly as it was saved.
 */
X.ensureTraffic = function (S) {
  ensure(S);
  const cong = X.trCong, t = S.maps.traffic, road = S.road;
  for (let i = 0; i < S.N; i++) cong[i] = road[i] ? t[i] / 170 : 0;
};
