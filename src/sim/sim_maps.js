/*
 * VOXELPOLIS — simulation: derived per-tile maps (part of VC.sim).
 *
 *   VC.sim.computeMaps()  rewrites every S.maps[VC.MAP_KEYS] layer (Uint8 0..255) except 'traffic'
 *                         (traffic.js owns it), bumps S.ver.maps, emits 'mapsUpdated'. Synchronous.
 *   X.startMaps()/stepMaps(ms)  the same pass in 6 stages spread over frames (the live game uses
 *                         this so a 256 map never stalls one frame for the whole pass).
 *
 * COVERAGE (police, fire, health, edu, park, transit, garbage): each built service building stamps a
 *   plateau-then-smooth-falloff disc; radius & strength scale with VC.econ.effectiveness(dept), drop
 *   to 40% while unpowered and to 30% without a street at the door (X.accessMul). CAPACITY: a
 *   building with def.capacity serves that many residents at full strength; the residents inside
 *   its disc are shared with overlapping buildings of the same service (each resident counts
 *   1/n for n covering buildings); overload (capF = min(1, capacity / load)) shrinks the radius a
 *   little and the strength by capF squared
 *   (b.simLoad = residents it serves, b.simCapF = that factor). Overlaps add softly (max + 1/4 of
 *   the smaller). Trees add a little park.
 * POLLUTION: industry (dirty low-tech, clean high-tech), catalog sources (def.pollution/pollR), road
 *   traffic, garbage, fires; blurred, drifted downwind (sim weather X.wx.windDir), minus trees & parks.
 * NOISE: roads by type + traffic, industry, commerce, def.noise/noiseR; blurred; trees damp it.
 * CRIME: people density x poverty (low land value, unemployment) + abandoned buildings, minus police.
 * LAND VALUE: base 60 + water views + elevation + def.lv stamps (positive ones scale with the
 *   department's funding, up to 100%) + parks + services + shops + trees - pollution - crime - noise
 *   - industry (jammed roads count through their extra noise); smoothed.
 * HAPPINESS: per-building happiness painted on footprints and feathered 1 tile around.
 *
 * EFFICIENCY: everything except the coverage stamps is computed only inside the DEVELOPED RECT
 * (bounding box of buildings + roads plus a 20-tile margin covering the largest pollution radius,
 * blur and wind drift), so a small town on a 256 map costs a fraction of the full map. Box blurs are
 * rect-aware and match full-map blurs (cells outside the rect are zero). Outside the rect, land value
 * is a cached static base (water views, elevation, forests) rebuilt only when terrain heights change
 * (detected on 'dirty') or every 60 sim days (tree changes).
 */
const SIM = (VC.sim = VC.sim || {});
const X = (SIM._ = SIM._ || {});
const C = VC.C, M = VC.M;

const IND_POL = [0, 70, 95, 120]; // industrial pollution per tile by density

X.eff = function (dept) {
  const e = VC.econ && VC.econ.effectiveness ? VC.econ.effectiveness(dept) : 1;
  return typeof e === 'number' && isFinite(e) ? Math.max(0, e) : 1;
};

X.ensureMaps = function (S) {
  const N = S.N;
  if (X.mapN === N && X.fA) return;
  X.mapN = N;
  for (const k of ['fA', 'fB', 'polF', 'noiF', 'lvF', 'indF', 'comF', 'popF', 'crF', 'treeD', 'hapS', 'hapW', 'resF', 'cntF']) X[k] = new Float32Array(N);
  X.waterDist = new Uint8Array(N);
  X.lvBase = new Uint8Array(N);
  X.lvPrev = new Uint8Array(N); // last land value (crime's poverty input)
  X.hCopy = null;
  X.staticVer = -1;
};

/* ---------------- helpers ---------------- */
/*
 * Rect-aware separable box blur rows/columns. Only cells in [x0..x1] x [z0..z1] are read and
 * written; everything outside is treated as zero while the divisor is the true window size
 * clipped at the MAP edges — identical to a full-map blur when the outside really is zero.
 */
function blurH(src, dst, W, x0, z0, x1, z1, r) {
  for (let z = z0; z <= z1; z++) {
    const o = z * W;
    let sum = 0;
    for (let x = x0; x <= x0 + r && x <= x1; x++) sum += src[o + x];
    let cnt = Math.min(x0 + r, W - 1) - Math.max(x0 - r, 0) + 1;
    for (let x = x0; x <= x1; x++) {
      dst[o + x] = sum / cnt;
      const xa = x + r + 1, xr = x - r;
      if (xa <= x1) sum += src[o + xa];
      if (xa < W) cnt++;
      if (xr >= x0) sum -= src[o + xr];
      if (xr >= 0) cnt--;
    }
  }
}
function blurV(src, dst, W, H, x0, z0, x1, z1, r) {
  for (let x = x0; x <= x1; x++) {
    let sum = 0;
    for (let z = z0; z <= z0 + r && z <= z1; z++) sum += src[z * W + x];
    let cnt = Math.min(z0 + r, H - 1) - Math.max(z0 - r, 0) + 1;
    for (let z = z0; z <= z1; z++) {
      dst[z * W + x] = sum / cnt;
      const za = z + r + 1, zr = z - r;
      if (za <= z1) sum += src[za * W + x];
      if (za < H) cnt++;
      if (zr >= z0) sum -= src[zr * W + x];
      if (zr >= 0) cnt--;
    }
  }
}
/** In-place separable box blur over rect R, `passes` times (2 passes ~ gaussian). */
function blur(buf, S, R, r, passes) {
  const t = X.fB === buf ? X.fA : X.fB;
  for (let p = 0; p < passes; p++) {
    blurH(buf, t, S.W, R[0], R[1], R[2], R[3], r);
    blurV(t, buf, S.W, S.H, R[0], R[1], R[2], R[3], r);
  }
}
/** Additive smooth radial stamp into a Float32 buffer: strength at the center, 0 at radius r. */
function stampRadial(buf, S, cx, cz, r, strength) {
  if (r <= 0 || !strength) return;
  const W = S.W, H = S.H;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
  const z0 = Math.max(0, Math.floor(cz - r)), z1 = Math.min(H - 1, Math.ceil(cz + r));
  const r2 = r * r, ir = 1 / r;
  for (let z = z0; z <= z1; z++) {
    const dz = z + 0.5 - cz;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r2) continue;
      const t = Math.sqrt(d2) * ir;
      buf[z * W + x] += strength * (1 - t * t * (3 - 2 * t));
    }
  }
}
/** Coverage disc into a Uint8 map: flat core to r/2 then smooth falloff; soft-saturating combine. */
function stampCover(map, S, cx, cz, r, strength) {
  if (r <= 0 || strength <= 0) return;
  const W = S.W, H = S.H;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
  const z0 = Math.max(0, Math.floor(cz - r)), z1 = Math.min(H - 1, Math.ceil(cz + r));
  const r2 = r * r, ir = 1 / r;
  for (let z = z0; z <= z1; z++) {
    const dz = z + 0.5 - cz;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r2) continue;
      const t = Math.sqrt(d2) * ir;
      let f = 1;
      if (t > 0.5) { const u = (t - 0.5) * 2; f = 1 - u * u * (3 - 2 * u); }
      const v = strength * f;
      const i = z * W + x, a = map[i];
      const hi = a > v ? a : v, lo = a > v ? v : a;
      const n = hi + lo * 0.25;
      map[i] = n > 255 ? 255 : n;
    }
  }
}
/** Distance (tiles, capped at 12) from every land tile to open water. */
function computeWaterDist(S) {
  const W = S.W, N = S.N, d = X.waterDist, q = X.queue, hgt = S.height;
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) {
    if (hgt[i] < C.SEA) { d[i] = 0; q[qt++] = i; } else d[i] = 255;
  }
  while (qh < qt) {
    const i = q[qh++];
    const nd = d[i] + 1;
    if (nd > 12) continue;
    const x = i % W;
    if (x > 0 && d[i - 1] > nd) { d[i - 1] = nd; q[qt++] = i - 1; }
    if (x < W - 1 && d[i + 1] > nd) { d[i + 1] = nd; q[qt++] = i + 1; }
    if (i >= W && d[i - W] > nd) { d[i - W] = nd; q[qt++] = i - W; }
    if (i < N - W && d[i + W] > nd) { d[i + W] = nd; q[qt++] = i + W; }
  }
}
/** Static land value (no city influence): base + water views + elevation + forests. */
function refreshStatic(S) {
  computeWaterDist(S);
  const N = S.N, base = X.lvBase, hgt = S.height, wd = X.waterDist, trees = S.trees;
  for (let i = 0; i < N; i++) {
    const h = hgt[i];
    if (h < C.SEA) { base[i] = 0; continue; }
    let v = 60;
    const w = wd[i];
    if (w <= 8) v += (9 - w) * 5;
    const el = (h - C.SEA) * 1.1;
    v += (el > 22 ? 22 : el) + trees[i] * 6.5; // forests: shade + a little park value
    base[i] = v > 255 ? 255 : v;
  }
  X.staticVer = X.terrVer;
  X.staticDay = S.time.day;
}

/** Height-change detector (called on 'dirty'): terrain edits invalidate the static fields. */
X.heightChanged = function (S, r) {
  if (!X.hCopy || X.hCopy.length !== S.N) return;
  const W = S.W, h = S.height, c = X.hCopy;
  let changed = false;
  for (let z = r.z0; z <= r.z1; z++)
    for (let x = r.x0; x <= r.x1; x++) {
      const i = z * W + x;
      if (h[i] !== c[i]) { c[i] = h[i]; changed = true; }
    }
  if (changed) X.terrVer = (X.terrVer || 0) + 1;
};

/** Developed rect (buildings + roads) + margin, or null when nothing is built. */
function devRect(S) {
  let x0 = S.W, z0 = S.H, x1 = -1, z1 = -1;
  for (const b of S.buildings.values()) {
    if (b.x < x0) x0 = b.x;
    if (b.z < z0) z0 = b.z;
    if (b.x + b.w - 1 > x1) x1 = b.x + b.w - 1;
    if (b.z + b.d - 1 > z1) z1 = b.z + b.d - 1;
  }
  const rb = X.roadBox;
  if (rb) {
    if (rb[0] < x0) x0 = rb[0];
    if (rb[1] < z0) z0 = rb[1];
    if (rb[2] > x1) x1 = rb[2];
    if (rb[3] > z1) z1 = rb[3];
  }
  if (x1 < 0) return null;
  if (X.fullRect) { x0 = 0; z0 = 0; x1 = S.W - 1; z1 = S.H - 1; } // debug: verify rect == full map
  const m = 20;
  const R = X._rect || (X._rect = [0, 0, 0, 0]);
  R[0] = Math.max(0, x0 - m);
  R[1] = Math.max(0, z0 - m);
  R[2] = Math.min(S.W - 1, x1 + m);
  R[3] = Math.min(S.H - 1, z1 + m);
  return R;
}

/** Coverage effectiveness of a built catalog building before capacity: funding x power x road access. */
function coverF(b, def, effCache) {
  return (effCache[def.dept] != null ? effCache[def.dept] : 1) * (b.powered ? 1 : 0.4) * (X.accessMul ? X.accessMul(b, def) : 1);
}
/** Tiles of a disc (same rule as stampCover): calls fn(i) for every tile centre inside radius r. */
function forDisc(S, cx, cz, r, fn) {
  const W = S.W, H = S.H;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
  const z0 = Math.max(0, Math.floor(cz - r)), z1 = Math.min(H - 1, Math.ceil(cz + r));
  const r2 = r * r;
  for (let z = z0; z <= z1; z++) {
    const dz = z + 0.5 - cz;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      if (dx * dx + dz * dz < r2) fn(z * W + x);
    }
  }
}
/**
 * Service capacity: residents inside each capacity-limited service building's disc, shared between
 * overlapping buildings of the same service -> b.simLoad, b.simCapF = min(1, capacity / load).
 */
function serviceLoads(S, effCache) {
  const res = X.resF, cnt = X.cntF, W = S.W;
  res.fill(0);
  const groups = X._svcGroups || (X._svcGroups = {});
  for (const k in groups) groups[k].length = 0;
  for (const b of S.buildings.values()) {
    if (b.key === 'grow') {
      if (b.zt !== 1 || !(b.pop > 0)) continue;
      const per = b.pop / (b.w * b.d);
      for (let z = b.z; z < b.z + b.d; z++) for (let x = b.x; x < b.x + b.w; x++) res[z * W + x] += per;
      continue;
    }
    const def = VC.BLD[b.key];
    if (!def) continue;
    if (def.housing && b.pop > 0) {
      const per = b.pop / (b.w * b.d);
      for (let z = b.z; z < b.z + b.d; z++) for (let x = b.x; x < b.x + b.w; x++) res[z * W + x] += per;
    }
    if (!def.cover || !def.capacity) continue;
    b.simLoad = 0;
    b.simCapF = 1;
    if (b.built < 1) continue;
    const f = coverF(b, def, effCache);
    if (!(f > 0)) continue;
    const fr = 0.45 + 0.55 * Math.min(f, 1.3);
    for (const svc in def.cover) {
      const g = groups[svc] || (groups[svc] = []);
      // better-funded departments handle more people per building (more staff)
      const cap = def.capacity * M.clamp(effCache[def.dept] != null ? effCache[def.dept] : 1, 0.3, 1.3);
      g.push({ b, cx: b.x + b.w * 0.5, cz: b.z + b.d * 0.5, r: def.cover[svc] * fr, cap, load: 0 });
    }
  }
  for (const svc in groups) {
    const g = groups[svc];
    if (!g.length) continue;
    for (const e of g) forDisc(S, e.cx, e.cz, e.r, (i) => { cnt[i] += 1; });
    for (const e of g) {
      let load = 0;
      forDisc(S, e.cx, e.cz, e.r, (i) => { if (res[i] > 0) load += res[i] / cnt[i]; });
      e.load = load;
    }
    for (const e of g) forDisc(S, e.cx, e.cz, e.r, (i) => { cnt[i] = 0; });
    for (const e of g) {
      const b = e.b;
      b.simLoad = Math.max(b.simLoad, Math.round(e.load));
      b.simCapF = Math.min(b.simCapF, e.load > e.cap ? e.cap / e.load : 1);
    }
  }
}

/** End of a map pass. tWork = ms actually spent computing (a staged pass spans several frames). */
function finish(S, t0, tWork) {
  X.lastMaps = performance.now();
  X.mapsMs = tWork != null ? tWork : X.lastMaps - t0;
  S.ver.maps++;
  VC.bus.emit('mapsUpdated');
}

/* ---------------- main ---------------- */
const COVER_KEYS = ['police', 'fire', 'health', 'edu', 'park', 'transit', 'garbage'];
/**
 * The map pass as a sequence of stages (generator; `yield` between stages). Each stage clears and
 * rewrites only the output maps it owns, so the maps stay valid between stages: coverage (+ point
 * sources) -> pollution -> noise -> crime -> land value -> happiness. Scratch buffers live in X and
 * are only touched by the running job.
 */
function* mapsJob(S) {
  const t0 = performance.now();
  let tWork = 0, tStage = t0;
  const lapW = () => { const n = performance.now(); tWork += n - tStage; };
  X.ensureNet(S);
  X.ensureMaps(S);
  const W = S.W, H = S.H, N = S.N, maps = S.maps, mods = S.mods;
  if (!X.hCopy || X.hCopy.length !== N) {
    X.hCopy = new Uint8Array(S.height);
    X.terrVer = (X.terrVer || 0) + 1;
  }
  if (X.staticVer !== X.terrVer || S.time.day - X.staticDay >= 60 || S.time.day < X.staticDay) refreshStatic(S);
  const lvMul = Math.max(0, 1 + (mods.landValue || 0));
  const lvOut = maps.landValue, base = X.lvBase;
  const eduAdd = (X.cityEdu || 0) * 6;
  /** land value: static base everywhere (scaled by policy); city effects overwrite the developed rect */
  const lvBaseFill = () => {
    for (let i = 0; i < N; i++) {
      const bv = base[i];
      const v = bv ? (bv + eduAdd) * lvMul : 0;
      lvOut[i] = v >= 255 ? 255 : v;
    }
  };
  const R0 = devRect(S);
  if (!R0) {
    for (const k of VC.MAP_KEYS) if (k !== 'traffic' && k !== 'landValue') maps[k].fill(0);
    lvBaseFill();
    lapW();
    return finish(S, t0, tWork);
  }
  const R = R0.slice(); // own copy: the rect must not change while the job runs across frames
  const rx0 = R[0], rz0 = R[1], rx1 = R[2], rz1 = R[3];

  const polF = X.polF, noiF = X.noiF, lvF = X.lvF, indF = X.indF, comF = X.comF, popF = X.popF, crF = X.crF;
  const hapS = X.hapS, hapW = X.hapW, fA = X.fA, fB = X.fB, treeD = X.treeD;
  polF.fill(0); noiF.fill(0); lvF.fill(0); indF.fill(0); comF.fill(0); popF.fill(0); crF.fill(0);
  hapS.fill(0); hapW.fill(0); fA.fill(0); fB.fill(0); treeD.fill(0);

  const effCache = X._effCache || (X._effCache = {});
  for (const d of VC.DEPARTMENTS) effCache[d.key] = X.eff(d.key);
  const cityEdu = X.cityEdu || 0;

  /* ======== stage 1: coverage stamps + point sources ======== */
  for (const k of COVER_KEYS) if (maps[k]) maps[k].fill(0);
  serviceLoads(S, effCache);
  for (const b of S.buildings.values()) {
    const cx = b.x + b.w * 0.5, cz = b.z + b.d * 0.5;
    const area = b.w * b.d;
    if (b.key === 'rubble') {
      for (let z = b.z; z < b.z + b.d; z++) for (let x = b.x; x < b.x + b.w; x++) crF[z * W + x] += 0.15;
      continue;
    }
    if (b.key !== 'grow') {
      const def = VC.BLD[b.key];
      if (!def || b.built < 1) continue;
      if (def.cover) {
        // overload (capF < 1) shrinks the radius a little and weakens the service sharply:
        // a station serving twice its capacity barely counts as coverage
        const capF = def.capacity && b.simCapF > 0 ? b.simCapF : 1;
        const f0 = coverF(b, def, effCache), f = f0 * capF;
        if (f > 0) {
          const fr = 0.45 + 0.55 * Math.min(f, 1.3);
          const str = 255 * Math.min(1.25, 0.3 + 0.8 * f0) * capF * capF;
          for (const svc in def.cover) if (maps[svc]) stampCover(maps[svc], S, cx, cz, def.cover[svc] * fr, str);
        }
      }
      if (def.pollution) stampRadial(polF, S, cx, cz, def.pollR || 4, def.pollution * (b.fire > 0 ? 1.4 : 1));
      if (def.noise) stampRadial(noiF, S, cx, cz, def.noiseR || 3, def.noise);
      // amenities (parks, landmarks, schools) lose their land-value pull when their budget is cut
      if (def.lv) stampRadial(lvF, S, cx, cz, def.lvR || 4, def.lv > 0 ? def.lv * Math.min(1, effCache[def.dept] != null ? effCache[def.dept] : 1) : def.lv);
      const jobsPer = (b.simJobs || 0) / area;
      const resPer = def.housing ? b.pop / area : 0;
      for (let z = b.z; z < b.z + b.d; z++)
        for (let x = b.x; x < b.x + b.w; x++) {
          const i = z * W + x;
          popF[i] += resPer + jobsPer * 0.3;
          if (b.fire > 0) polF[i] += 90;
        }
      continue;
    }
    // growables
    const occ = b.cap > 0 ? b.pop / b.cap : 0;
    let pol = 0, noi = 0, com = 0, ind = 0, pop = 0;
    if (b.zt === 1) {
      pop = b.pop / area;
      noi = 2 * b.den;
    } else if (b.zt === 2) {
      pop = (b.pop / area) * 0.45;
      com = b.den * (0.5 + 0.5 * occ);
      noi = 7 + 6 * b.den;
    } else {
      pop = (b.pop / area) * 0.3;
      ind = 0.6 + 0.2 * b.den;
      // dirty low-tech vs clean high-tech (level 3 or rich = educated workforce)
      const clean = b.level >= 3 || b.wealth >= 2 ? 0.3 : b.wealth === 1 ? 0.7 : 1;
      pol = IND_POL[b.den] * (0.35 + 0.65 * occ) * clean * (b.built < 1 ? 0.3 : 1);
      noi = 18 + 10 * b.den;
    }
    if (b.simGarbage) pol += b.simGarbage * 28;
    if (b.fire > 0) pol += 90;
    const crime = b.abandoned ? 0.55 : 0;
    const hs = b.abandoned ? 0 : b.happy;
    for (let z = b.z; z < b.z + b.d; z++)
      for (let x = b.x; x < b.x + b.w; x++) {
        const i = z * W + x;
        polF[i] += pol;
        noiF[i] += noi;
        comF[i] += com;
        indF[i] += ind;
        popF[i] += pop;
        crF[i] += crime;
        hapS[i] += hs;
        hapW[i] += 1;
      }
  }

  /* ---- roads and trees ---- */
  const road = S.road, traffic = maps.traffic, trees = S.trees;
  for (let z = rz0; z <= rz1; z++)
    for (let x = rx0, i = z * W + rx0; x <= rx1; x++, i++) {
      const r = road[i];
      if (r) {
        const t = traffic[i] * (1 / 255);
        polF[i] += (r === 3 ? 22 : r === 2 ? 8 : 3) + 70 * t;
        // jammed roads (t > 0.66 = over capacity) are much noisier: honking, idling engines
        noiF[i] += (r === 3 ? 70 : r === 2 ? 38 : 18) + 70 * t + (t > 0.66 ? 150 * (t - 0.66) : 0);
      }
      treeD[i] = trees[i] * (1 / 3);
    }
  blur(treeD, S, R, 2, 1);

  /* ---- park coverage gets a little from forests ---- */
  const park = maps.park;
  for (let z = rz0; z <= rz1; z++)
    for (let x = rx0, i = z * W + rx0; x <= rx1; x++, i++) {
      if (treeD[i] > 0.02) {
        const v = park[i] + treeD[i] * 40;
        park[i] = v > 255 ? 255 : v;
      }
    }
  lapW();
  yield 1;
  tStage = performance.now();

  /* ======== stage 2: pollution: blur, drift downwind, sinks ======== */
  blur(polF, S, R, 2, 2);
  const wx = X.wx; // sim weather (never the visual one)
  const wind = wx ? M.sat(wx.wind) : 0.5;
  const wdir = wx ? wx.windDir : 0.6;
  const sh = 1 + 2 * wind;
  const sx = Math.round(Math.cos(wdir) * sh), sz = Math.round(Math.sin(wdir) * sh);
  const pMul = Math.max(0, 1 + (mods.pollution || 0));
  const polOut = maps.pollution;
  polOut.fill(0);
  for (let z = rz0; z <= rz1; z++) {
    const uz = M.clamp(z - sz, 0, H - 1);
    for (let x = rx0; x <= rx1; x++) {
      const i = z * W + x;
      const up = polF[uz * W + M.clamp(x - sx, 0, W - 1)];
      // -6: trace amounts (quiet streets) read as clean air
      const v = (0.55 * polF[i] + 0.45 * up - treeD[i] * 26 - park[i] * 0.05 - 6) * pMul;
      polOut[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
    }
  }
  lapW();
  yield 2;
  tStage = performance.now();

  /* ======== stage 3: noise ======== */
  blur(noiF, S, R, 1, 2);
  const nMul = Math.max(0, 1 + (mods.noise || 0));
  const noiOut = maps.noise;
  noiOut.fill(0);
  for (let z = rz0; z <= rz1; z++)
    for (let x = rx0, i = z * W + rx0; x <= rx1; x++, i++) {
      const v = (noiF[i] - treeD[i] * 10) * nMul;
      noiOut[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
    }
  lapW();
  yield 3;
  tStage = performance.now();

  /* ======== stage 4: crime (poverty uses the previous land value) ======== */
  const police = maps.police, lvPrev = X.lvPrev;
  const unemp = S.stats.unemployment || 0;
  fA.fill(0);
  for (let z = rz0; z <= rz1; z++)
    for (let x = rx0, i = z * W + rx0; x <= rx1; x++, i++) {
      const p = popF[i];
      if (p <= 0 && crF[i] <= 0) continue;
      const dens = p >= 45 ? 1 : p / 45;
      const lvn = lvPrev[i] * (1 / 153); // 153 = 0.6 * 255
      const poverty = 0.35 + 0.65 * (1 - (lvn > 1 ? 1 : lvn)) + unemp * 1.2;
      fA[i] = (p > 0 ? 0.1 : 0) + dens * poverty * 0.75 + crF[i];
    }
  blur(fA, S, R, 1, 2);
  const cMul = Math.max(0, 1 + (mods.crime || 0));
  const crOut = maps.crime;
  crOut.fill(0);
  for (let z = rz0; z <= rz1; z++)
    for (let x = rx0, i = z * W + rx0; x <= rx1; x++, i++) {
      const v = (fA[i] - police[i] * (0.8 / 255) - park[i] * (0.08 / 255)) * cMul * 255;
      crOut[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
    }
  lapW();
  yield 4;
  tStage = performance.now();

  /* ======== stage 5: land value (rect) ======== */
  blur(comF, S, R, 2, 2);
  blur(indF, S, R, 2, 2);
  const hgt = S.height, wd = X.waterDist, edu = maps.edu, health = maps.health;
  for (let z = rz0; z <= rz1; z++)
    for (let x = rx0, i = z * W + rx0; x <= rx1; x++, i++) {
      if (hgt[i] < C.SEA) { fA[i] = 0; continue; }
      let v = 60;
      const w = wd[i];
      if (w <= 8) v += (9 - w) * 5;
      const el = (hgt[i] - C.SEA) * 1.1;
      v += el > 22 ? 22 : el;
      v += lvF[i];
      v += park[i] * (30 / 255) + (edu[i] + health[i] + police[i]) * (12 / 255);
      v += (comF[i] > 1.5 ? 1.5 : comF[i]) * 10 + treeD[i] * 15 + cityEdu * 6;
      v -= polOut[i] * 0.45 + crOut[i] * 0.3 + noiOut[i] * 0.2 + (indF[i] > 1 ? 1 : indF[i]) * 45;
      fA[i] = v * lvMul;
    }
  // (no final blur: its inputs are already smooth, and blurring would mix in the zero-valued water
  // tiles and rob waterfront lots of their premium)
  lvBaseFill();
  // blend into the static base near the rect border so there is no visible seam
  // (only on rect sides that are not the map edge)
  for (let z = rz0; z <= rz1; z++) {
    const ez = Math.min(rz0 > 0 ? z - rz0 : 99, rz1 < H - 1 ? rz1 - z : 99);
    for (let x = rx0, i = z * W + rx0; x <= rx1; x++, i++) {
      if (hgt[i] < C.SEA) { lvOut[i] = 0; continue; }
      const e = Math.min(ez, rx0 > 0 ? x - rx0 : 99, rx1 < W - 1 ? rx1 - x : 99);
      let v = fA[i];
      if (e < 4) v += ((base[i] + eduAdd) * lvMul - v) * (1 - e / 4);
      lvOut[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
    }
  }
  lvPrev.set(lvOut);
  lapW();
  yield 5;
  tStage = performance.now();

  /* ======== stage 6: happiness: footprints + 1-tile feather ======== */
  const t = lvF; // lvF is no longer needed: reuse as scratch
  blurH(hapS, fB, W, rx0, rz0, rx1, rz1, 1);
  blurV(fB, fA, W, H, rx0, rz0, rx1, rz1, 1);
  blurH(hapW, fB, W, rx0, rz0, rx1, rz1, 1);
  blurV(fB, t, W, H, rx0, rz0, rx1, rz1, 1);
  const hOut = maps.happiness;
  hOut.fill(0);
  for (let z = rz0; z <= rz1; z++)
    for (let x = rx0, i = z * W + rx0; x <= rx1; x++, i++) {
      let v = 0;
      if (hapW[i] > 0) v = hapS[i] / hapW[i];
      else if (t[i] > 0.05) v = fA[i] / t[i];
      v *= 255;
      hOut[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
    }
  lapW();
  return finish(S, t0, tWork);
}

/**
 * Recomputes every map now (synchronously; cancels a running staged job). Used by reset, by
 * VC.debug.run and whenever the sim is not inside a frame update.
 */
SIM.computeMaps = function () {
  const S = VC.state;
  if (!S || !S.maps) return;
  X.mapsJob = null;
  X.mapsDirty = false;
  const job = mapsJob(S);
  while (!job.next().done);
};
/**
 * Starts a staged map pass (one stage per call of stepMaps — the sim advances it once per frame),
 * unless one is running already. Keeps big maps from stalling a frame for the whole pass.
 */
X.startMaps = function () {
  const S = VC.state;
  if (!S || !S.maps || X.mapsJob) return;
  X.mapsDirty = false;
  X.mapsJob = mapsJob(S);
  X.mapsJobS = S;
};
/** Advances a running staged map pass by one stage (at most budgetMs, at least one stage). */
X.stepMaps = function (budgetMs) {
  const job = X.mapsJob;
  if (!job) return;
  if (X.mapsJobS !== VC.state) { X.mapsJob = null; return; }
  const t0 = performance.now();
  do {
    let r;
    try { r = job.next(); } catch (e) { X.mapsJob = null; throw e; }
    if (r.done) { X.mapsJob = null; return; }
  } while (performance.now() - t0 < (budgetMs || 0));
};
