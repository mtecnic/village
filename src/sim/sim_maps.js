/*
 * VOXELPOLIS — simulation: derived per-tile maps (part of VC.sim).
 *
 *   VC.sim.computeMaps()  rewrites every S.maps[VC.MAP_KEYS] layer (Uint8 0..255), bumps S.ver.maps,
 *                         emits 'mapsUpdated'. ~1-3 ms on 128x128 (all passes are O(N) on Float32 scratch).
 *
 * COVERAGE (police, fire, health, edu, park, transit, garbage): each built service building stamps a
 *   plateau-then-smooth-falloff disc; radius & strength scale with VC.econ.effectiveness(dept) and
 *   drop to 40% while unpowered. Overlaps add softly (max + 1/4 of the smaller). Trees add a little park.
 * POLLUTION: industry (dirty low-tech, clean high-tech), catalog sources (def.pollution/pollR), road
 *   traffic, garbage, fires; blurred, drifted downwind (S.weather.windDir), minus trees & parks.
 * NOISE: roads by type + traffic, industry, commerce, def.noise/noiseR; blurred; trees damp it.
 * CRIME: people density x poverty (low land value, unemployment) + abandoned buildings, minus police.
 * LAND VALUE: base 60 + water views + elevation + def.lv stamps + parks + services + shops + trees
 *   - pollution - crime - noise - industry; smoothed.
 * HAPPINESS: per-building happiness painted on footprints and feathered 1 tile around.
 */
const SIM = (VC.sim = VC.sim || {});
const X = (SIM._ = SIM._ || {});
const C = VC.C, M = VC.M;

const SVC_KEYS = ['police', 'fire', 'health', 'edu', 'park', 'transit', 'garbage'];

X.eff = function (dept) {
  const e = VC.econ && VC.econ.effectiveness ? VC.econ.effectiveness(dept) : 1;
  return typeof e === 'number' && isFinite(e) ? Math.max(0, e) : 1;
};

X.ensureMaps = function (S) {
  const N = S.N;
  if (X.mapN === N && X.fA) return;
  X.mapN = N;
  for (const k of ['fA', 'fB', 'polF', 'noiF', 'lvF', 'indF', 'comF', 'popF', 'crF', 'treeD', 'hapS', 'hapW']) X[k] = new Float32Array(N);
  X.waterDist = new Uint8Array(N);
  X.waterVer = -1;
};

/* ---------------- helpers ---------------- */
function blurH(src, dst, W, H, r) {
  for (let z = 0; z < H; z++) {
    const o = z * W;
    let sum = 0, cnt = 0;
    for (let x = 0; x <= r && x < W; x++) { sum += src[o + x]; cnt++; }
    for (let x = 0; x < W; x++) {
      dst[o + x] = sum / cnt;
      const xa = x + r + 1, xr = x - r;
      if (xa < W) { sum += src[o + xa]; cnt++; }
      if (xr >= 0) { sum -= src[o + xr]; cnt--; }
    }
  }
}
function blurV(src, dst, W, H, r) {
  for (let x = 0; x < W; x++) {
    let sum = 0, cnt = 0;
    for (let z = 0; z <= r && z < H; z++) { sum += src[z * W + x]; cnt++; }
    for (let z = 0; z < H; z++) {
      dst[z * W + x] = sum / cnt;
      const za = z + r + 1, zr = z - r;
      if (za < H) { sum += src[za * W + x]; cnt++; }
      if (zr >= 0) { sum -= src[zr * W + x]; cnt--; }
    }
  }
}
/** In-place separable box blur, `passes` times (2-3 passes approximate a gaussian). */
function blur(buf, W, H, r, passes) {
  const t = X.fB === buf ? X.fA : X.fB;
  for (let p = 0; p < passes; p++) {
    blurH(buf, t, W, H, r);
    blurV(t, buf, W, H, r);
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
  const W = S.W, H = S.H, N = S.N, d = X.waterDist, q = X.queue, hgt = S.height;
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
  X.waterVer = S.ver.terrain;
}

/* ---------------- main ---------------- */
SIM.computeMaps = function () {
  const S = VC.state;
  if (!S || !S.maps) return;
  const t0 = performance.now();
  X.ensureNet(S);
  X.ensureMaps(S);
  const W = S.W, H = S.H, N = S.N, maps = S.maps, mods = S.mods;
  const polF = X.polF, noiF = X.noiF, lvF = X.lvF, indF = X.indF, comF = X.comF, popF = X.popF, crF = X.crF;
  const hapS = X.hapS, hapW = X.hapW, fA = X.fA, treeD = X.treeD;
  polF.fill(0); noiF.fill(0); lvF.fill(0); indF.fill(0); comF.fill(0); popF.fill(0); crF.fill(0); hapS.fill(0); hapW.fill(0);
  for (const k of SVC_KEYS) maps[k].fill(0);
  if (X.waterVer !== S.ver.terrain) computeWaterDist(S);

  const effCache = X._effCache || (X._effCache = {});
  for (const d of VC.DEPARTMENTS) effCache[d.key] = X.eff(d.key);
  const cityEdu = X.cityEdu || 0;

  /* ---- buildings: coverage stamps + point sources ---- */
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
      const f = (effCache[def.dept] != null ? effCache[def.dept] : 1) * (b.powered ? 1 : 0.4);
      if (def.cover && f > 0) {
        const fr = 0.45 + 0.55 * Math.min(f, 1.3);
        const str = 255 * Math.min(1.25, 0.3 + 0.8 * f);
        for (const svc in def.cover) if (maps[svc]) stampCover(maps[svc], S, cx, cz, def.cover[svc] * fr, str);
      }
      if (def.pollution) stampRadial(polF, S, cx, cz, def.pollR || 4, def.pollution * (b.fire > 0 ? 1.4 : 1));
      if (def.noise) stampRadial(noiF, S, cx, cz, def.noiseR || 3, def.noise);
      if (def.lv) stampRadial(lvF, S, cx, cz, def.lvR || 4, def.lv);
      const jobsPer = (b.simJobs != null ? b.simJobs : b.pop) / area;
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
      pol = [0, 70, 95, 120][b.den] * (0.35 + 0.65 * occ) * clean * (b.built < 1 ? 0.3 : 1);
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
  for (let i = 0; i < N; i++) {
    const r = road[i];
    if (r) {
      const t = traffic[i] * (1 / 255);
      polF[i] += (r === 3 ? 22 : r === 2 ? 8 : 3) + 70 * t;
      noiF[i] += (r === 3 ? 70 : r === 2 ? 38 : 18) + 70 * t;
    }
    treeD[i] = trees[i] * (1 / 3);
  }
  blur(treeD, W, H, 2, 1);

  /* ---- park coverage gets a little from forests ---- */
  const park = maps.park;
  for (let i = 0; i < N; i++) {
    if (treeD[i] > 0.02) {
      const v = park[i] + treeD[i] * 40;
      park[i] = v > 255 ? 255 : v;
    }
  }

  /* ---- pollution: blur, drift downwind, sinks ---- */
  blur(polF, W, H, 2, 2);
  const wind = S.weather ? M.sat(S.weather.wind != null ? S.weather.wind : 0.5) : 0.5;
  const wdir = S.weather && S.weather.windDir != null ? S.weather.windDir : 0.6;
  const sh = 1 + 2 * wind;
  const sx = Math.round(Math.cos(wdir) * sh), sz = Math.round(Math.sin(wdir) * sh);
  const pMul = Math.max(0, 1 + (mods.pollution || 0));
  const polOut = maps.pollution;
  for (let z = 0; z < H; z++) {
    const uz = M.clamp(z - sz, 0, H - 1);
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      const up = polF[uz * W + M.clamp(x - sx, 0, W - 1)];
      // -6: trace amounts (quiet streets) read as clean air
      let v = (0.55 * polF[i] + 0.45 * up - treeD[i] * 26 - park[i] * 0.05 - 6) * pMul;
      polOut[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
    }
  }

  /* ---- noise ---- */
  blur(noiF, W, H, 1, 2);
  const nMul = Math.max(0, 1 + (mods.noise || 0));
  const noiOut = maps.noise;
  for (let i = 0; i < N; i++) {
    const v = (noiF[i] - treeD[i] * 10) * nMul;
    noiOut[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
  }

  /* ---- crime ---- */
  const lvOld = maps.landValue, police = maps.police;
  const unemp = S.stats.unemployment || 0;
  for (let i = 0; i < N; i++) {
    const p = popF[i];
    if (p <= 0 && crF[i] <= 0) { fA[i] = 0; continue; }
    const dens = p >= 45 ? 1 : p / 45;
    const lvn = lvOld[i] * (1 / 153); // 153 = 0.6 * 255
    const poverty = 0.35 + 0.65 * (1 - (lvn > 1 ? 1 : lvn)) + unemp * 1.2;
    fA[i] = (p > 0 ? 0.1 : 0) + dens * poverty * 0.75 + crF[i];
  }
  blur(fA, W, H, 1, 2);
  const cMul = Math.max(0, 1 + (mods.crime || 0));
  const crOut = maps.crime;
  for (let i = 0; i < N; i++) {
    const v = (fA[i] - police[i] * (0.8 / 255) - park[i] * (0.08 / 255)) * cMul * 255;
    crOut[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
  }

  /* ---- land value ---- */
  blur(comF, W, H, 2, 2);
  blur(indF, W, H, 2, 2);
  const hgt = S.height, wd = X.waterDist, edu = maps.edu, health = maps.health;
  const lvMul = Math.max(0, 1 + (mods.landValue || 0));
  for (let i = 0; i < N; i++) {
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
  blur(fA, W, H, 1, 1);
  const lvOut = maps.landValue;
  for (let i = 0; i < N; i++) {
    const v = hgt[i] < C.SEA ? 0 : fA[i];
    lvOut[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
  }

  /* ---- happiness: footprints + 1-tile feather ---- */
  fA.set(hapS);
  const fB = X.fB;
  const t = X.lvF; // lvF no longer needed: reuse as scratch
  blurH(fA, t, W, H, 1); blurV(t, fA, W, H, 1);
  t.set(hapW);
  blurH(t, fB, W, H, 1); blurV(fB, t, W, H, 1);
  const hOut = maps.happiness;
  for (let i = 0; i < N; i++) {
    let v = 0;
    if (hapW[i] > 0) v = hapS[i] / hapW[i];
    else if (t[i] > 0.05) v = fA[i] / t[i];
    v *= 255;
    hOut[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
  }

  X.mapsDirty = false;
  X.lastMaps = performance.now();
  X.mapsMs = X.lastMaps - t0;
  S.ver.maps++;
  VC.bus.emit('mapsUpdated');
};
