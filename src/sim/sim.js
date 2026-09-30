/*
 * VOXELPOLIS — simulation core (VC.sim). Contract: docs/ARCHITECTURE.md §VC.sim.
 *
 * Files: sim/names.js (names), sim/sim.js (this: time, growth, occupancy, happiness, demand, fires,
 * stats, inspector API), sim/sim_maps.js (derived maps), sim/sim_net.js (power/water/access),
 * sim/traffic.js (commuter traffic). All attach to VC.sim; shared scratch lives in VC.sim._ (X).
 *
 * TIME: update() turns rdt * C.SPEEDS[speed] / C.DAY_SEC into whole days (<= 8 tickDay() per frame).
 *   Construction progress is advanced continuously per frame (smooth build-up animation); when tickDay()
 *   is called directly (VC.debug.run) it advances construction itself.
 * DAILY: construction, occupancy (move-ins / job filling), happiness, garbage, abandonment,
 *   fire ignition/spread, growth slice (1/4 of the map in a fixed random order), stats.
 *   day%4==1 networks, day%4==2 maps, day%8==3 traffic, day%3==0 demand (smoothed).
 * MONTHLY: level-ups, wealth drift, rubble clearing, long-abandoned buildings collapse -> then 'month'.
 * RESPONSIVENESS: bldAdd/bldRemove/roadChange/power-line edits schedule recalcNetworks() (throttled to
 *   ~150 ms, also while paused); service placement/budget/policy changes schedule computeMaps().
 *
 * Building runtime fields added here (prefix sim): simI (center tile), simRoad (access road tile),
 *   simPo/simPw/simWo/simWu (power/water out/use), simJobs (filled jobs of catalog buildings),
 *   simCommute (-1 = no path to work), simGarbage 0..1, simUnhappy/simGood/simAband/simDown (day
 *   counters), simWealthCnt, simCause (rubble: 'fire'), simDispatched (fire truck sent).
 */
const SIM = (VC.sim = VC.sim || {});
const X = (SIM._ = SIM._ || {});
const C = VC.C, M = VC.M, F = VC.F;
const ZK = [null, 'R', 'C', 'I'];

const LABOR = 0.5; // share of residents who work
const LV_REQ = { 1: [0, 0, 85, 135], 2: [0, 0, 80, 125] }; // land value needed for level 2 / 3
const EDU_REQ = [0, 0, 70, 140]; // industry: education coverage needed for level 2 / 3
const GROW_DAYS = 5; // growables take 5..10 days to build
const PLACE_DAYS = 3; // placed catalog buildings

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */
const clamp = M.clamp;
const defOf = (b) => (b.key === 'grow' || b.key === 'rubble' ? null : VC.BLD[b.key] || null);
function capOf(b) {
  if (b.key === 'grow') {
    const g = VC.GROW[ZK[b.zt]];
    const d = g && g[b.den];
    return d ? d.cap[clamp(b.level | 0, 1, 3) - 1] * b.w * b.d : 0;
  }
  const def = VC.BLD[b.key];
  return def ? def.housing || def.jobs || 0 : 0;
}
function rate(b) {
  if (b.key === 'grow') return 1 / (GROW_DAYS + (b.variant % 6));
  return 1 / PLACE_DAYS;
}
/** Own tax effect for a zone/wealth: 9% neutral, each point above costs ~0.07. */
function ownTax(S, zk, w) {
  const t = S.tax && S.tax[zk];
  const pct = t ? (w == null ? (t[0] + t[1] + t[2]) / 3 : t[w]) : 9;
  const eff = pct * Math.max(0, 1 + (S.mods['tax' + zk] || 0));
  return clamp(-(eff - 9) * 0.07, -1, 1);
}
function fac(out, label, v) {
  if (out && Math.abs(v) >= 0.005) out.push({ label, value: clamp(v * 2.5, -1, 1), raw: v });
  return v;
}
const fxOk = () => X.inUpdate && X.fxBudget-- > 0;
function burst(type, b, n, dy) {
  if (!VC.particles || !VC.particles.burst || !fxOk()) return;
  try {
    VC.particles.burst(type, b.x + b.w / 2, VC.world.topY(b.x, b.z) + (dy != null ? dy : b.hgt || 1), b.z + b.d / 2, n);
  } catch (e) { /* fx are optional */ }
}
function toast(text, type, icon) {
  VC.bus.emit('toast', { text, type, icon });
}

/**
 * Defines every sim runtime field up front, always in the same order, so that all building
 * objects share one hidden class (lazily added fields made the hot loops megamorphic).
 */
function initBuilding(S, b) {
  b.simI = (b.z + (b.d >> 1)) * S.W + b.x + (b.w >> 1);
  if (b.simRoad == null) b.simRoad = -1;
  if (b.simPo == null) b.simPo = 0;
  if (b.simPw == null) b.simPw = 0;
  if (b.simWo == null) b.simWo = 0;
  if (b.simWu == null) b.simWu = 0;
  if (b.simNet == null) b.simNet = 0;
  if (b.simNetP == null) b.simNetP = 0;
  if (b.simNetW == null) b.simNetW = 0;
  if (b.simServed == null) b.simServed = 0;
  if (b.simJobs == null) b.simJobs = 0;
  if (b.simCommute == null) b.simCommute = 0;
  if (b.simGarbage == null) b.simGarbage = 0;
  if (b.simUnhappy == null) b.simUnhappy = 0;
  if (b.simGood == null) b.simGood = 0;
  if (b.simAband == null) b.simAband = 0;
  if (b.simDown == null) b.simDown = 0;
  if (b.simCapL == null) b.simCapL = 0;
  if (b.simWealthCnt == null) b.simWealthCnt = 0;
  if (b.simReplay == null) b.simReplay = false;
  if (b.simDispatched == null) b.simDispatched = false;
  if (b.simCause == null) b.simCause = '';
  // static per-building facts (the catalog never changes)
  b.simNeedP = X.needsPower(b);
  b.simNeedW = X.needsWater(b);
  b.simSrcP = !!(VC.BLD[b.key] && VC.BLD[b.key].power > 0);
  if (b.key === 'grow') {
    b.cap = capOf(b);
    b.simCapL = b.level;
  }
  if (b.built < 1) X.constructing.add(b.id);
  if (b.fire > 0) X.burning.add(b.id);
}

/* ------------------------------------------------------------------ */
/* construction                                                          */
/* ------------------------------------------------------------------ */
function progressConstruction(S, days) {
  if (!X.constructing.size) return;
  for (const id of X.constructing) {
    const b = S.buildings.get(id);
    if (!b) { X.constructing.delete(id); continue; }
    b.built += days * rate(b) * (b.simReplay ? 1.6 : 1);
    if (b.built >= 1) {
      b.built = 1;
      X.constructing.delete(id);
      const wasReplay = b.simReplay;
      b.simReplay = false;
      if (b.key !== 'grow') {
        X.netDirty = true;
        X.mapsDirty = true;
        burst('dust', b, 10, 0.2);
      } else if (!wasReplay) burst('dust', b, 5, 0.1);
    }
  }
}

/* ------------------------------------------------------------------ */
/* happiness                                                             */
/* ------------------------------------------------------------------ */
/**
 * Target happiness 0..1 of a growable. When `out` is an array, pushes named factors
 * {label, value -1..1 (display scale), raw (additive contribution)}.
 */
function evalHappy(S, b, out) {
  const i = b.simI, m = S.maps, zt = b.zt, den = b.den;
  const pol = m.pollution[i] / 255, cri = m.crime[i] / 255, noi = m.noise[i] / 255, lv = m.landValue[i] / 255;
  const pc = m.police[i] / 255, fc = m.fire[i] / 255, gc = m.garbage[i] / 255, pk = m.park[i] / 255;
  const hc = Math.min(1, m.health[i] / 255 + (S.mods.health || 0) * 0.5);
  const ec = Math.min(1, m.edu[i] / 255 + (S.mods.education || 0) * 0.5);
  const rt = b.simRoad >= 0 ? m.traffic[b.simRoad] / 255 : 0;
  const tax = X.taxW[zt] ? X.taxW[zt][b.wealth | 0] : 0;
  let h = 0.55;
  if (b.simRoad < 0) h += fac(out, 'No road access', -0.3);
  if (zt === 1) {
    h += fac(out, 'Power', b.powered ? 0.04 : -0.32);
    h += fac(out, 'Water', b.watered ? 0.04 : den >= 2 ? -0.28 : -0.1);
    h += fac(out, 'Pollution', 0.02 - pol * 0.55);
    h += fac(out, 'Crime', 0.02 - cri * 0.4);
    h += fac(out, 'Noise', -noi * 0.22);
    // missing services mostly block upgrades; good coverage makes people genuinely happy
    const sv = 0.22 * pc + 0.22 * fc + 0.22 * hc + 0.22 * ec + 0.12 * gc - (0.15 + 0.1 * (b.level - 1) + 0.05 * (den - 1));
    h += fac(out, 'Services', sv > 0 ? sv * 0.45 : sv * 0.25);
    h += fac(out, 'Parks', (pk - 0.12) * 0.14);
    h += fac(out, 'Land value', (lv - 0.3) * 0.25);
    h += fac(out, 'Taxes', tax * 0.35);
    h += fac(out, 'Commute', b.simCommute < 0 ? -0.12 : -Math.min(0.1, Math.max(0, (b.simCommute - 30) / 300)) - rt * 0.06);
    h += fac(out, 'Jobs', X.unemp > 0.08 ? -Math.min(0.18, (X.unemp - 0.08) * 0.6) : 0.03);
    if (b.simGarbage > 0.05) h += fac(out, 'Garbage', -b.simGarbage * 0.08);
    h += fac(out, 'Policies & landmarks', X.happyMod);
  } else if (zt === 2) {
    h += fac(out, 'Power', b.powered ? 0.04 : -0.35);
    h += fac(out, 'Water', b.watered ? 0.02 : den >= 2 ? -0.2 : -0.05);
    h += fac(out, 'Pollution', -pol * 0.2);
    h += fac(out, 'Crime', 0.02 - cri * 0.4);
    const sv = 0.35 * pc + 0.35 * fc + 0.3 * gc - 0.2;
    h += fac(out, 'Services', sv > 0 ? sv * 0.3 : sv * 0.2);
    h += fac(out, 'Customers', clamp(S.demand.C, -1, 1) * 0.12 + (lv - 0.3) * 0.2);
    h += fac(out, 'Taxes', tax * 0.4);
    h += fac(out, 'Workers', -(1 - X.fill) * 0.35);
    h += fac(out, 'Traffic', -rt * 0.06);
    if (b.simGarbage > 0.05) h += fac(out, 'Garbage', -b.simGarbage * 0.06);
    h += fac(out, 'Policies & landmarks', X.happyMod * 0.5);
  } else {
    h += fac(out, 'Power', b.powered ? 0.04 : -0.4);
    h += fac(out, 'Water', b.watered ? 0.02 : den >= 2 ? -0.2 : -0.05);
    h += fac(out, 'Crime', 0.02 - cri * 0.2);
    const sv = 0.5 * fc + 0.3 * pc + 0.2 * gc - 0.2;
    h += fac(out, 'Services', sv > 0 ? sv * 0.25 : sv * 0.15);
    h += fac(out, 'Trade', clamp(S.demand.I, -1, 1) * 0.15);
    h += fac(out, 'Taxes', tax * 0.4);
    h += fac(out, 'Workers', -(1 - X.fill) * 0.4);
    if (b.level >= 2) h += fac(out, 'Skilled workforce', ((ec + X.cityEdu) * 0.5 - 0.3) * 0.2);
    h += fac(out, 'Freight traffic', -rt * 0.08);
    if (b.simGarbage > 0.05) h += fac(out, 'Garbage', -b.simGarbage * 0.06);
    h += fac(out, 'Policies & landmarks', X.happyMod * 0.4);
  }
  return clamp(h, 0, 1);
}

/* ------------------------------------------------------------------ */
/* daily building pass                                                   */
/* ------------------------------------------------------------------ */
function newTot() {
  return {
    pop: 0, capR: 0, capRBuilt: 0, capC: 0, capCBuilt: 0, capI: 0, capIBuilt: 0, jobsSvc: 0, jobsFilled: 0,
    growables: 0, catalog: 0, rubble: 0, abandoned: 0, constructing: 0, burning: 0,
    happyS: 0, happyW: 0, eduS: 0, healthS: 0, crimeS: 0, polS: 0, polW: 0, lvS: 0, svcS: 0,
    tourismRaw: 0, happyMod: 0, parks: 0, seaports: 0, airports: 0,
    unpowered: 0, unwatered: 0, noAccess: 0, noCommute: 0, garbage: 0,
  };
}

function fireRisk(S, b, def) {
  const fc = S.maps.fire[b.simI] / 255;
  const wet = S.weather ? S.weather.wet || 0 : 0;
  let r = 1.1e-5 * (1 - fc * 0.85) * Math.max(0, 1 + (S.mods.fire || 0)) * (1 - 0.6 * wet) * X.seasonFire;
  if (def) {
    if (def.group === 'parks' && !def.jobs) return 0;
    r *= b.key === 'coal_plant' || b.key === 'gas_plant' || b.key === 'incinerator' ? 2 : 0.5;
  } else {
    r *= (1 + 0.5 * b.den) * (b.zt === 3 ? 2.2 : 1) * (1 + b.age / 7200) * (b.abandoned ? 3 : 1);
  }
  return r;
}

/**
 * One pass over all buildings. Cheap work (totals, occupancy) runs daily for everyone; the
 * heavier per-building evaluation (happiness, garbage, abandonment, fire risk) runs for a
 * quarter of the buildings per day (b.id + day) & 3, with rates scaled to the 4-day step.
 * sim = false: totals only (used after reset/load).
 */
function dailyBuildings(S, sim) {
  const tot = (X.tot = newTot());
  const m = S.maps, dem = S.demand, rnd = X.rnd;
  const fill = X.fill;
  const pend = X.pending;
  const day = S.time.day;
  const leave = Math.max(0, X.unemp - 0.1) * 0.6; // unemployed families move away
  const garbMul = 0.016 * Math.max(0, 1 + (S.mods.garbage || 0));
  pend.length = 0;
  if (sim) X.bk[-day & 3].fill(0);
  else for (let k = 0; k < 4; k++) X.bk[k].fill(0);
  for (const b of S.buildings.values()) {
    if (b.simI == null) initBuilding(S, b);
    if (sim) b.age = (b.age || 0) + 1;
    const key = b.key;
    if (key === 'rubble') {
      tot.rubble++;
      continue;
    }
    if (b.fire > 0) tot.burning++;
    const slice = sim && ((b.id + day) & 3) === 0;
    if (key !== 'grow') {
      /* ---------- catalog buildings ---------- */
      const def = VC.BLD[key];
      if (!def) continue;
      tot.catalog++;
      if (b.built < 1) { tot.constructing++; continue; }
      const jobs = def.jobs || 0;
      if (key === 'seaport') tot.seaports++;
      else if (key === 'airport') tot.airports++;
      if (def.group === 'parks' && !def.unique) tot.parks++;
      tot.tourismRaw += def.tourism || 0;
      tot.happyMod += def.happy || 0;
      if (jobs) {
        tot.jobsSvc += jobs;
        b.simJobs = Math.round(jobs * fill * (b.powered ? 1 : 0.5));
        tot.jobsFilled += b.simJobs;
        if (!def.housing) {
          b.pop = b.simJobs;
          b.cap = jobs;
        }
      }
      if (def.housing) {
        // arcology: residents move in like a giant residential building
        b.cap = def.housing;
        if (sim) {
          const occ = clamp(0.55 + 0.4 * (X.happyAvg || 0.6) + 0.3 * X.rAppeal - leave, 0.2, 1) * (b.powered ? 1 : 0.3) * (b.watered ? 1 : 0.5);
          const target = Math.floor(def.housing * occ);
          if (b.pop < target) b.pop += Math.ceil((target - b.pop) * 0.04);
          else if (b.pop > target) b.pop -= Math.ceil((b.pop - target) * 0.05);
        }
        tot.pop += b.pop;
        tot.capR += def.housing;
        tot.capRBuilt += def.housing;
      }
      if (!b.powered && b.simNeedP) tot.unpowered++;
      if (slice) {
        b.happy = clamp((b.powered ? 0.75 : 0.35) - (b.watered ? 0 : 0.1) + X.happyMod, 0, 1);
        if (b.fire <= 0 && rnd() < fireRisk(S, b, def) * 4) SIM.ignite(b);
      }
      continue;
    }
    /* ---------- growables ---------- */
    tot.growables++;
    const zt = b.zt, i = b.simI;
    if (b.simCapL !== b.level) {
      b.cap = capOf(b);
      b.simCapL = b.level;
    }
    if (b.abandoned) {
      tot.abandoned++;
      b.pop = 0;
      if (slice) {
        const h = evalHappy(S, b, null);
        b.happy += (h - b.happy) * 0.45;
        b.simGood = h > 0.5 && dem[ZK[zt]] > 0 ? b.simGood + 4 : Math.max(0, b.simGood - 8);
        if (b.simGood > 60) {
          b.abandoned = false;
          b.simUnhappy = 0;
          b.simAband = 0;
          b.simGood = 0;
          b.happy = 0.5;
          VC.world.changed(b);
        }
        if (b.fire <= 0 && rnd() < fireRisk(S, b, null) * 4) SIM.ignite(b);
      }
      if (sim && ++b.simAband > 360) pend.push(b);
      continue;
    }
    if (zt === 1) tot.capR += b.cap;
    else if (zt === 2) tot.capC += b.cap;
    else tot.capI += b.cap;
    if (b.built < 1 && !b.simReplay) {
      tot.constructing++;
      continue;
    }
    if (zt === 1) tot.capRBuilt += b.cap;
    else if (zt === 2) tot.capCBuilt += b.cap;
    else tot.capIBuilt += b.cap;

    if (sim) {
      /* occupancy (daily) */
      if (zt === 1) {
        let occ = clamp(0.5 + 0.45 * b.happy + 0.3 * X.rAppeal - leave, 0.15, 1);
        if (!b.powered) occ *= 0.35;
        if (!b.watered && (b.den >= 2 || b.level >= 2)) occ *= 0.5;
        if (b.simRoad < 0) occ *= 0.3;
        const target = Math.floor(b.cap * occ);
        if (b.pop < target) b.pop += Math.ceil((target - b.pop) * (0.06 + 0.1 * rnd()));
        else if (b.pop > target) b.pop -= Math.ceil((b.pop - target) * 0.05);
      } else {
        let f = fill * (b.powered ? 1 : 0.25) * (b.simRoad < 0 ? 0.3 : 1);
        if (!b.watered && (b.den >= 2 || b.level >= 2)) f *= 0.6;
        const target = Math.floor(b.cap * (f < 1 ? f : 1));
        const dp = target - b.pop;
        if (dp) b.pop += dp > 0 ? Math.ceil(dp * 0.15) : -Math.ceil(-dp * 0.15);
      }
      if (b.pop > b.cap) b.pop = b.cap;
    }
    if (slice) {
      const h = evalHappy(S, b, null);
      b.happy += (h - b.happy) * 0.45;
      /* garbage (light) */
      const gc = m.garbage[i] / 255;
      if (gc < 0.3) b.simGarbage = Math.min(1, b.simGarbage + garbMul * (0.5 + 0.5 * b.den));
      else if (b.simGarbage > 0) b.simGarbage = Math.max(0, b.simGarbage - 0.12 * gc);
      /* abandonment: sustained misery, or unhappy while the zone is in decline */
      const zd = dem[ZK[zt]];
      const bad = b.happy < 0.22 || (b.happy < 0.35 && zd < -0.4);
      b.simUnhappy = bad ? b.simUnhappy + 4 : Math.max(0, b.simUnhappy - 8);
      if (b.simUnhappy > 100) {
        b.abandoned = true;
        b.pop = 0;
        b.simAband = 0;
        b.simGood = 0;
        b.simUnhappy = 0;
        X.abandonedMonth++;
        tot.abandoned++;
        VC.world.changed(b);
        continue;
      }
      /* downgrade */
      if (b.level > 1) {
        b.simDown = b.happy < 0.3 ? b.simDown + 4 : Math.max(0, b.simDown - 4);
        if (b.simDown > 75) {
          b.level--;
          b.cap = capOf(b);
          if (b.pop > b.cap) b.pop = b.cap;
          b.simDown = 0;
          VC.world.changed(b);
        }
      }
      if (b.fire <= 0 && rnd() < fireRisk(S, b, null) * 4) SIM.ignite(b);
    }
    /* totals (exact, daily) */
    if (!b.powered) tot.unpowered++;
    if (!b.watered) tot.unwatered++;
    if (b.simRoad < 0) tot.noAccess++;
    if (b.simGarbage > 0.4) tot.garbage++;
    const p = b.pop;
    if (zt === 1) {
      tot.pop += p;
      if (b.simCommute < 0) tot.noCommute++;
    } else tot.jobsFilled += p;
    /* pop-weighted map statistics: accumulated per 4-day slice bucket */
    if (slice || !sim) {
      const B = X.bk[b.id & 3];
      if (zt === 1) {
        if (p > 0) {
          B[0] += b.happy * p;
          B[1] += p;
          B[2] += m.edu[i] * p;
          B[3] += m.health[i] * p;
          B[4] += m.crime[i] * p;
          B[5] += m.landValue[i] * p;
          B[6] += (m.police[i] + m.fire[i] + m.health[i] + m.edu[i]) * 0.25 * p;
        }
        B[7] += m.pollution[i] * (p + 1);
        B[8] += p + 1;
      } else {
        B[7] += m.pollution[i] * (p * 0.3 + 1);
        B[8] += p * 0.3 + 1;
      }
    }
  }
  for (let k = 0; k < 4; k++) {
    const B = X.bk[k];
    tot.happyS += B[0]; tot.happyW += B[1]; tot.eduS += B[2]; tot.healthS += B[3];
    tot.crimeS += B[4]; tot.lvS += B[5]; tot.svcS += B[6]; tot.polS += B[7]; tot.polW += B[8];
  }
  // collapse long-abandoned buildings (outside the iteration)
  for (const b of pend) toRubble(S, b, 'abandon');
  pend.length = 0;
}

/* ------------------------------------------------------------------ */
/* stats                                                                 */
/* ------------------------------------------------------------------ */
function updateStats(S) {
  const t = X.tot, st = S.stats, mods = S.mods;
  const pop = t.pop;
  const workers = pop * LABOR;
  const jobs = t.capCBuilt + t.capIBuilt + t.jobsSvc;
  const ext = 40 + pop * 0.04; // regional commuters fill vacancies in small towns
  X.fill = jobs > 0 ? Math.min(1, (workers + ext) / jobs) : 1;
  X.unemp = workers > 0 ? Math.max(0, workers - jobs) / workers : 0;
  st.pop = pop;
  st.jobs = jobs;
  st.jobsC = t.capCBuilt;
  st.jobsI = t.capIBuilt;
  st.jobsService = t.jobsSvc;
  st.jobsFilled = t.jobsFilled;
  st.workers = Math.round(workers);
  st.unemployment = X.unemp;
  st.capR = t.capRBuilt;
  const hw = t.happyW;
  st.happiness = hw > 0 ? t.happyS / hw : 0.6;
  X.happyAvg = st.happiness;
  st.education = hw > 0 ? clamp((t.eduS / hw / 255) * (1 + (mods.education || 0)), 0, 1) : 0;
  st.health = hw > 0 ? clamp((t.healthS / hw / 255) * (1 + (mods.health || 0)), 0, 1) : 0;
  st.crime = hw > 0 ? t.crimeS / hw / 255 : 0;
  st.pollution = t.polW > 0 ? t.polS / t.polW / 255 : 0;
  st.landValue = hw > 0 ? t.lvS / hw : 0;
  const svc = hw > 0 ? t.svcS / hw / 255 : 0;
  X.svcCov = svc;
  X.cityEdu = st.education;
  const tr = SIM.trafficStats ? SIM.trafficStats() : null;
  st.traffic = tr ? tr.avgCongestion : 0;
  st.tourism = Math.round(t.tourismRaw * Math.max(0, 1 + (mods.tourism || 0)) + t.parks * 1.5);
  st.buildings = t.growables + t.catalog;
  st.abandoned = t.abandoned;
  st.rubble = t.rubble;
  st.fires = X.burning.size;
  st.unpowered = t.unpowered;
  st.unwatered = t.unwatered;
  st.noAccess = t.noAccess;
  st.noCommute = t.noCommute;
  st.garbage = t.growables ? t.garbage / t.growables : 0;
  const taxAvg = (X.taxZ[1] + X.taxZ[2] + X.taxZ[3]) / 3;
  st.approval = clamp(0.55 * st.happiness + 0.25 * (0.5 + taxAvg * 0.5) + 0.2 * Math.min(1, svc * 1.4), 0, 1);
  if (pop > S.peakPop) S.peakPop = pop;
  X.happyMod = (mods.happiness || 0) + t.happyMod;
}

/** Per-day city-level caches used by happiness/demand. */
function refreshCity(S) {
  X.taxZ = [0, 0, 0, 0];
  X.taxW = [null, [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let z = 1; z <= 3; z++) {
    const zk = ZK[z];
    for (let w = 0; w < 3; w++) X.taxW[z][w] = ownTax(S, zk, w);
    const own = ownTax(S, zk, null);
    let e = null;
    try { e = VC.econ && VC.econ.taxEffect ? VC.econ.taxEffect(zk) : null; } catch (err) { e = null; }
    X.taxZ[z] = typeof e === 'number' && isFinite(e) && e !== 0 ? clamp(e, -1, 1) : own;
  }
  const mo = Math.floor(S.time.day / C.DAYS_PER_MONTH) % 12;
  X.seasonFire = mo >= 5 && mo <= 7 ? 1.4 : mo === 11 || mo <= 1 ? 0.7 : 1;
}

/* ------------------------------------------------------------------ */
/* demand                                                                */
/* ------------------------------------------------------------------ */
function updateDemand(S, instant) {
  const t = X.tot, st = S.stats, mods = S.mods;
  const pop = t.pop, workers = pop * LABOR;
  const jobsAll = t.capC + t.capI + t.jobsSvc; // incl. under construction
  const diff = VC.DIFFICULTY[S.difficulty] || VC.DIFFICULTY.normal;
  const mul = diff.demandMul || 1;
  const powerShort = X.power && X.power.shortage, waterShort = X.water && X.water.shortage;
  const fR = [], fC = [], fI = [];
  const add = (arr, label, v) => { if (Math.abs(v) >= 0.005) arr.push({ label, value: v }); return v; };
  let R = 0, Cd = 0, I = 0;

  // ---- residential ----
  R += add(fR, pop < 3000 ? 'Small-town appeal' : 'Regional migration', 0.1 + 0.5 * Math.exp(-pop / 2500));
  const jt = clamp((jobsAll - workers) / Math.max(120, workers * 0.6), -1, 1) * 0.6;
  R += add(fR, jt >= 0 ? 'Jobs available' : 'Unemployment', jt);
  const vac = t.capRBuilt > 0 ? -clamp((t.capRBuilt - pop - 30) / Math.max(150, t.capRBuilt) - 0.1, 0, 1) * 1.2 : 0;
  R += add(fR, 'Vacant homes', vac);
  const pendR = t.capR - t.capRBuilt;
  R += add(fR, 'Homes under construction', -clamp(pendR / Math.max(300, pop * 1.5), 0, 1) * 0.5);
  if (pop > 50) R += add(fR, 'Citizen happiness', (st.happiness - 0.55) * 0.5);
  R += add(fR, 'Residential taxes', X.taxZ[1] * 0.6);
  if (pop > 100) R += add(fR, 'Pollution & crime', -(st.pollution * 0.3 + st.crime * 0.3));
  if (pop > 300) R += add(fR, 'City services', (X.svcCov * 1.4 - 0.35) * 0.2);
  if (powerShort || waterShort) R += add(fR, 'Utility shortage', -(powerShort ? 0.25 : 0) - (waterShort ? 0.2 : 0));
  R += add(fR, 'Policies', mods.demandR || 0);

  // ---- commercial ----
  const tour = st.tourism * 3;
  const needC = pop * 0.15 + tour + 15;
  const scale = Math.max(40, needC * 0.5);
  const shop = clamp((needC - t.capC) / scale, -1, 1) * 0.7;
  const tourPart = shop > 0 ? Math.min(shop, (tour / scale) * 0.7) : 0;
  Cd += add(fC, shop >= 0 ? 'Shoppers' : 'Too many shops', shop - tourPart);
  Cd += add(fC, 'Tourists', tourPart);
  const laborShort = jobsAll > 0 ? Math.max(0, 1 - (workers + 40 + pop * 0.04) / jobsAll) : 0;
  const wk = X.unemp > 0.03 ? X.unemp * 0.4 : -laborShort * 0.5;
  Cd += add(fC, wk >= 0 ? 'Available workers' : 'Labor shortage', wk);
  Cd += add(fC, 'Commercial taxes', X.taxZ[2] * 0.6);
  if (powerShort || waterShort) Cd += add(fC, 'Utility shortage', -0.15);
  Cd += add(fC, 'Policies', mods.demandC || 0);

  // ---- industrial ----
  const it = clamp((workers - jobsAll) / Math.max(80, workers * 0.4), -1, 1) * 0.6;
  I += add(fI, it >= 0 ? 'Workers seeking jobs' : 'Labor shortage', it);
  const trade = 0.12 + 0.25 * Math.exp(-pop / 4000) + Math.min(0.3, t.seaports * 0.12) + (t.airports ? 0.15 : 0);
  I += add(fI, 'External trade', trade);
  if (X.cityEdu > 0.05) I += add(fI, 'Educated workforce', X.cityEdu * 0.1);
  I += add(fI, 'Industrial taxes', X.taxZ[3] * 0.6);
  if (powerShort || waterShort) I += add(fI, 'Utility shortage', -0.15);
  I += add(fI, 'Policies', mods.demandI || 0);

  const fin = (v) => clamp(v > 0 ? v * mul : v / mul, -1, 1);
  // occupancy uses the city's appeal without the vacancy terms (else vacancy -> low demand -> more vacancy)
  const appeal = fin(R - vac - (fR.find((f) => f.label === 'Homes under construction') || { value: 0 }).value);
  X.rAppeal += (appeal - X.rAppeal) * (instant ? 1 : 0.25);
  const k = instant ? 1 : 0.25;
  S.demand.R += (fin(R) - S.demand.R) * k;
  S.demand.C += (fin(Cd) - S.demand.C) * k;
  S.demand.I += (fin(I) - S.demand.I) * k;
  const sort = (a) => a.sort((p, q) => Math.abs(q.value) - Math.abs(p.value));
  X.factors = { R: sort(fR), C: sort(fC), I: sort(fI) };
}

/* ------------------------------------------------------------------ */
/* growth                                                                */
/* ------------------------------------------------------------------ */
function desirability(S, zt, i) {
  const m = S.maps;
  const lv = m.landValue[i] / 255, pol = m.pollution[i] / 255, cri = m.crime[i] / 255, noi = m.noise[i] / 255;
  let d;
  if (zt === 1) {
    const svc = (m.police[i] + m.fire[i] + m.health[i] + m.edu[i]) / 1020;
    d = 0.3 + lv * 0.6 - pol * 0.6 - cri * 0.3 - noi * 0.2 + svc * 0.25 + (m.park[i] / 255) * 0.15;
  } else if (zt === 2) {
    d = 0.35 + lv * 0.45 - cri * 0.3 - pol * 0.15 + Math.min(0.2, (m.traffic[i] / 255) * 0.3);
  } else {
    d = 0.6 - lv * 0.2 - cri * 0.1;
  }
  return clamp(d, 0.05, 1);
}

/** Checks a footprint for a new growable. */
function fits(S, x0, z0, w, d, code, h0) {
  if (x0 < 0 || z0 < 0 || x0 + w > S.W || z0 + d > S.H) return false;
  const W = S.W;
  for (let z = z0; z < z0 + d; z++)
    for (let x = x0; x < x0 + w; x++) {
      const i = z * W + x;
      if (S.zone[i] !== code || S.bld[i] || S.road[i] || S.pline[i]) return false;
      const h = S.height[i];
      if (h < C.SEA || h > h0 + 1 || h < h0 - 1) return false;
      if (!(S.flags[i] & F.ACCESS)) return false;
    }
  return true;
}

function tryGrow(S, i, zt, den, dem) {
  const W = S.W, rnd = X.rnd;
  const x = i % W, z = (i - x) / W;
  const code = S.zone[i];
  const G = VC.GROW[ZK[zt]] && VC.GROW[ZK[zt]][den];
  if (!G) return null;
  const sizes = G.sizes;
  const lv = S.maps.landValue[i] / 255;
  // first choice: the biggest lot when demand / land value are high, else mostly the common size;
  // fall back to the other sizes from big to small so small gaps still fill up
  let first = sizes[0];
  if (sizes.length > 1) {
    if (rnd() < 0.12 + 0.4 * Math.max(dem, lv)) first = sizes.reduce((a, s) => (s[0] * s[1] > a[0] * a[1] ? s : a), sizes[0]);
    else if (rnd() > 0.75) first = sizes[1 + Math.floor(rnd() * (sizes.length - 1))];
  }
  const order = [first];
  for (const s of sizes) if (s !== first) order.push(s);
  if (order.length > 2) {
    const rest = order.splice(1).sort((a, b) => b[0] * b[1] - a[0] * a[1]);
    for (const s of rest) order.push(s);
  }
  const h0 = S.height[i];
  for (const s of order) {
    for (let rot = 0; rot < (s[0] !== s[1] ? 2 : 1); rot++) {
      const w = rot ? s[1] : s[0], d = rot ? s[0] : s[1];
      for (let oz = 0; oz < d; oz++)
        for (let ox = 0; ox < w; ox++) {
          const x0 = x - ox, z0 = z - oz;
          if (!fits(S, x0, z0, w, d, code, h0)) continue;
          return placeGrow(S, x0, z0, w, d, zt, den);
        }
    }
  }
  return null;
}

function wealthFor(S, zt, i) {
  if (zt === 3) {
    // industry follows education (high-tech is clean and rich)
    const e = Math.max(S.maps.edu[i] / 255, X.cityEdu || 0);
    return e >= 0.66 ? 2 : e >= 0.33 ? 1 : 0;
  }
  const lv = S.maps.landValue[i];
  return lv < 90 ? 0 : lv < 170 ? 1 : 2;
}

function placeGrow(S, x0, z0, w, d, zt, den) {
  const W = S.W;
  const ci = (z0 + (d >> 1)) * W + x0 + (w >> 1);
  let rot = VC.world.adjacentRoadDir(x0, z0, w, d);
  if (rot < 0) {
    // face the nearest access road
    const r = X.accRoad ? X.accRoad[ci] : -1;
    if (r >= 0) {
      const rx = r % W, rz = (r - rx) / W;
      const dx = rx - (x0 + w / 2), dz = rz - (z0 + d / 2);
      rot = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 1 : 3) : dz > 0 ? 0 : 2;
    } else rot = X.rnd.int(0, 3);
  }
  const b = VC.world.addBuilding({ key: 'grow', zt, den, level: 1, wealth: wealthFor(S, zt, ci), x: x0, z: z0, w, d, rot });
  b.built = 0;
  b.cap = capOf(b);
  b.pop = 0;
  b.happy = 0.6;
  const fl = S.flags[ci];
  b.powered = !!(fl & F.POWER);
  b.watered = !!(fl & F.WATER);
  b.simRoad = X.accRoad ? X.accRoad[ci] : -1;
  initBuilding(S, b);
  return b;
}

function growth(S) {
  const dem = S.demand, st = S.stats;
  const t = X.tot;
  const drive = (1 + (t.pop + (t.capC + t.capI) * 0.5) / 350) * Math.max(0, 1 + (S.mods.growth || 0));
  let any = false;
  for (let z = 1; z <= 3; z++) {
    const d = dem[ZK[z]];
    X.growAcc[z] = Math.min(3, X.growAcc[z] + Math.max(0, d) * drive);
    if (X.growAcc[z] >= 1) any = true;
  }
  if (!any) return;
  const N = S.N, perm = X.perm, zone = S.zone, bld = S.bld, road = S.road, flags = S.flags, rnd = X.rnd;
  const K = Math.ceil(N / 4);
  for (let k = 0; k < K; k++) {
    const i = perm[X.permPos];
    if (++X.permPos >= N) X.permPos = 0;
    const code = zone[i];
    if (!code || bld[i] || road[i]) continue;
    const zt = code >> 2, den = code & 3;
    if (X.growAcc[zt] < 1) continue;
    const fl = flags[i];
    if (!(fl & F.ACCESS) || !(fl & F.POWER)) continue;
    if (den >= 2 && !(fl & F.WATER)) continue;
    const d = dem[ZK[zt]];
    if (d <= 0.02) continue;
    const p = clamp(d * 1.5, 0.15, 1) * desirability(S, zt, i);
    if (rnd() >= p) continue;
    if (tryGrow(S, i, zt, den, d)) X.growAcc[zt] -= 1;
  }
}

/* ------------------------------------------------------------------ */
/* fires                                                                 */
/* ------------------------------------------------------------------ */
function toRubble(S, b, reason) {
  const x = b.x, z = b.z, w = b.w, d = b.d;
  X.selfEdit = true; // the periodic recalc picks this up; no immediate network solve needed
  VC.world.removeBuilding(b, reason);
  const rb = VC.world.addBuilding({ key: 'rubble', x, z, w, d, rot: 0 }, { instant: true });
  X.selfEdit = false;
  rb.simCause = reason;
  rb.powered = rb.watered = true;
  initBuilding(S, rb);
  return rb;
}

function burnDown(S, b) {
  const name = SIM.buildingName(b);
  burst('debris', b, 16, 0.5);
  burst('smoke', b, 14);
  VC.bus.emit('sfx', { name: 'collapse', x: b.x + b.w / 2, z: b.z + b.d / 2 });
  toRubble(S, b, 'fire');
  const day = S.time.day;
  X.fireLog.push(day);
  while (X.fireLog.length && X.fireLog[0] < day - 30) X.fireLog.shift();
  if (day - X.lastBurnToast > 1) {
    X.lastBurnToast = day;
    toast(`${name} burned down!`, 'bad', '🔥');
  }
  if (X.fireLog.length >= 3 && day - X.lastFireNews > 60) {
    X.lastFireNews = day;
    VC.bus.emit('news', { text: `Massive blaze in ${SIM.districtName(b.x, b.z)}: ${X.fireLog.length} buildings lost this month. Residents demand more fire stations!` });
  }
}

function spreadFrom(S, b) {
  const rnd = X.rnd;
  // random tile on the ring around the footprint
  const per = 2 * (b.w + b.d) + 4;
  let k = Math.floor(rnd() * per), x, z;
  if (k < b.w + 2) { x = b.x - 1 + k; z = b.z - 1; }
  else if ((k -= b.w + 2) < b.w + 2) { x = b.x - 1 + k; z = b.z + b.d; }
  else if ((k -= b.w + 2) < b.d) { x = b.x - 1; z = b.z + k; }
  else { x = b.x + b.w; z = b.z + (k - b.d); }
  const n = VC.world.buildingAt(x, z);
  if (n && n !== b && !(n.fire > 0)) SIM.ignite(n);
}

function fireStep(S) {
  if (!X.burning.size) return;
  const rnd = X.rnd, fmap = S.maps.fire;
  const wet = S.weather ? S.weather.wet || 0 : 0;
  const arr = X._burnArr;
  arr.length = 0;
  for (const id of X.burning) arr.push(id);
  for (const id of arr) {
    const b = S.buildings.get(id);
    if (!b || !(b.fire > 0)) { X.burning.delete(id); continue; }
    const fc = fmap[b.simI] / 255;
    if (!b.simDispatched && fc > 0.12) {
      b.simDispatched = true;
      if (VC.agents && VC.agents.dispatch) {
        try { VC.agents.dispatch('firetruck', b.x, b.z); } catch (e) { /* optional */ }
      }
    }
    const ext = fc * 0.5 + wet * 0.15 + (b.simDispatched ? 0.04 : 0);
    if (b.fire > 0.08 && rnd() < ext) {
      SIM.extinguish(b);
      continue;
    }
    b.fire += 0.06 + 0.06 * rnd() * (1 - fc * 0.5);
    if (b.fire > 0.3 && rnd() < 0.15 * (1 - fc * 0.8) * (1 - wet * 0.5)) spreadFrom(S, b);
    if (b.fire >= 1) {
      X.burning.delete(id);
      burnDown(S, b);
    }
  }
}

/* ------------------------------------------------------------------ */
/* monthly                                                               */
/* ------------------------------------------------------------------ */
function monthly(S) {
  const rnd = X.rnd, m = S.maps, dem = S.demand;
  const clear = [];
  let levelUps = 0;
  for (const b of S.buildings.values()) {
    if (b.key === 'rubble') {
      if (b.age > 180) clear.push(b);
      continue;
    }
    if (b.key !== 'grow' || b.abandoned || b.built < 1) continue;
    const i = b.simI, zt = b.zt, zk = ZK[zt];
    // wealth drifts with land value (industry: education)
    const tw = wealthFor(S, zt, i);
    if (tw !== b.wealth) {
      b.simWealthCnt = (b.simWealthCnt || 0) + 1;
      if (b.simWealthCnt >= 3 && rnd() < 0.4) {
        b.wealth += tw > b.wealth ? 1 : -1;
        b.simWealthCnt = 0;
        VC.world.changed(b);
      }
    } else b.simWealthCnt = 0;
    // level up
    if (b.level >= 3 || b.pop < b.cap * 0.85 || b.happy <= 0.65 || dem[zk] <= 0 || !b.powered) continue;
    const next = b.level + 1;
    if (!b.watered) continue;
    if (zt === 3) {
      if (Math.max(m.edu[i], (X.cityEdu || 0) * 255) < EDU_REQ[next]) continue;
    } else if (m.landValue[i] < LV_REQ[zt][next]) continue;
    if (rnd() >= 0.35) continue;
    b.level = next;
    b.cap = capOf(b);
    b.built = 0.6;
    b.simReplay = true;
    X.constructing.add(b.id);
    levelUps++;
    VC.world.changed(b);
    if (levelUps <= 3) {
      burst('sparkle', b, 14);
      VC.bus.emit('sfx', { name: 'levelup', x: b.x + b.w / 2, z: b.z + b.d / 2, vol: 0.4 });
    }
  }
  X.selfEdit = true;
  for (const b of clear) VC.world.removeBuilding(b, 'cleared');
  X.selfEdit = false;
  if (X.abandonedMonth >= 3) toast(`${X.abandonedMonth} buildings were abandoned this month`, 'warn', '🏚️');
  X.abandonedMonth = 0;
  X.levelUpsMonth = levelUps;
}

/* ------------------------------------------------------------------ */
/* shortages (edge-triggered toasts)                                     */
/* ------------------------------------------------------------------ */
function checkShortages(S) {
  const day = S.time.day;
  const p = X.power.shortage, w = X.water.shortage;
  if (p && !X.wasPowerShort && day - X.lastPowerToast > 45) {
    X.lastPowerToast = day;
    toast('Power shortage! Parts of the city are blacking out. Build more power plants.', 'bad', '⚡');
  }
  if (w && !X.wasWaterShort && day - X.lastWaterToast > 45) {
    X.lastWaterToast = day;
    toast('Water shortage! Taps are running dry. Build more pumps or towers.', 'bad', '💧');
  }
  X.wasPowerShort = p;
  X.wasWaterShort = w;
}

/* ------------------------------------------------------------------ */
/* public API                                                            */
/* ------------------------------------------------------------------ */
Object.assign(SIM, {
  capOf,

  init() {
    if (X.inited) return;
    X.inited = true;
    const bus = VC.bus;
    bus.on('bldAdd', (b) => {
      const S = VC.state;
      if (!X.ready || !S) return;
      if (b.simI == null) initBuilding(S, b);
      if (b.key !== 'grow' && !X.selfEdit) {
        X.netDirty = true;
        if (b.key !== 'rubble') X.mapsDirty = true;
      }
    });
    bus.on('bldRemove', (b) => {
      if (!X.ready) return;
      X.constructing.delete(b.id);
      X.burning.delete(b.id);
      if (X.selfEdit) return;
      X.netDirty = true;
      if (b.key !== 'grow') X.mapsDirty = true;
    });
    bus.on('roadChange', () => { X.netDirty = true; });
    bus.on('dirty', (r) => {
      const S = VC.state;
      if (X.ready && S && !X.netDirty && X.plineChanged(S, r)) X.netDirty = true;
    });
    const md = () => { X.mapsDirty = true; };
    bus.on('budgetChanged', md);
    bus.on('policyChanged', md);
  },

  reset(S) {
    X.ready = false;
    X.ensureNet(S);
    X.ensureMaps(S);
    if (X.ensureTraffic) X.ensureTraffic(S);
    X.acc = 0;
    X.rnd = M.rng(((S.seed ^ 0x51ed5eed) + S.time.day * 7919) >>> 0);
    const N = S.N;
    X.perm = new Int32Array(N);
    for (let i = 0; i < N; i++) X.perm[i] = i;
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(X.rnd() * (i + 1));
      const t = X.perm[i];
      X.perm[i] = X.perm[j];
      X.perm[j] = t;
    }
    X.permPos = 0;
    X.growAcc = [0, 0.9, 0.6, 0.6];
    X.constructing = new Set();
    X.burning = new Set();
    X.pending = [];
    X.bk = [new Float64Array(9), new Float64Array(9), new Float64Array(9), new Float64Array(9)];
    X._burnArr = [];
    X.fireLog = [];
    X.lastBurnToast = -99;
    X.lastFireNews = -999;
    X.lastPowerToast = X.lastWaterToast = -999;
    X.wasPowerShort = X.wasWaterShort = false;
    X.abandonedMonth = 0;
    X.levelUpsMonth = 0;
    X.fill = 1;
    X.unemp = 0;
    X.rAppeal = 0.3;
    X.cityEdu = 0;
    X.svcCov = 0;
    X.happyMod = S.mods.happiness || 0;
    X.happyAvg = S.stats.happiness || 0.6;
    X.fxBudget = 0;
    X.inUpdate = false;
    X.dayMs = 0;
    X.dayMsMax = 0;
    X.days = 0;
    X.prof = { net: 0, bld: 0, misc: 0, growth: 0, maps: 0, traffic: 0 };
    X.profMax = { net: 0, bld: 0, misc: 0, growth: 0, maps: 0, traffic: 0 };
    X.factors = { R: [], C: [], I: [] };
    X.tot = newTot();
    for (const b of S.buildings.values()) initBuilding(S, b);
    X.ready = true;
    refreshCity(S);
    // full recompute so loaded games show correct flags, maps and stats immediately
    SIM.recalcNetworks();
    dailyBuildings(S, false);
    updateStats(S);
    if (SIM.computeTraffic) SIM.computeTraffic();
    SIM.computeMaps();
    dailyBuildings(S, false);
    updateStats(S);
    if (S.buildings.size) updateDemand(S, false);
    else X.factors = { R: [{ label: 'Small-town appeal', value: 0.6 }], C: [{ label: 'Shoppers', value: 0.26 }], I: [{ label: 'External trade', value: 0.37 }] };
  },

  update(dt, rdt) {
    const S = VC.state;
    if (!S || !X.ready) return;
    const now = performance.now();
    // responsive network / coverage updates (also while paused)
    if (X.netDirty && now - (X.lastNet || 0) > 150) SIM.recalcNetworks();
    if (X.mapsDirty && now - (X.lastMaps || 0) > 600) SIM.computeMaps();
    const sp = C.SPEEDS[S.time.speed] || 0;
    if (!sp) return;
    const days = (rdt * sp) / C.DAY_SEC;
    progressConstruction(S, days);
    X.acc += days;
    let n = 0;
    X.inUpdate = true;
    try {
      while (X.acc >= 1 && n < 8) {
        X.acc -= 1;
        n++;
        SIM.tickDay();
      }
    } finally {
      X.inUpdate = false;
    }
    if (X.acc > 2) X.acc = 2; // never build up a backlog
  },

  tickDay() {
    const S = VC.state;
    if (!S) return;
    if (!X.ready) SIM.reset(S);
    const t0 = performance.now();
    S.time.day++;
    const day = S.time.day;
    X.fxBudget = 8;
    let t = t0;
    // section profiler: accumulated and max ms per section
    const lap = (k) => {
      const tn = performance.now(), d = tn - t;
      X.prof[k] += d;
      if (d > X.profMax[k]) X.profMax[k] = d;
      t = tn;
    };
    refreshCity(S);
    if (!X.inUpdate) progressConstruction(S, 1);
    if (X.netDirty || day % 4 === 1) {
      SIM.recalcNetworks();
      checkShortages(S);
      lap('net');
    }
    dailyBuildings(S, true);
    lap('bld');
    fireStep(S);
    updateStats(S);
    lap('misc');
    growth(S);
    lap('growth');
    if (day % 4 === 2 || X.mapsDirty) {
      SIM.computeMaps();
      lap('maps');
    }
    if (day % 8 === 3 && SIM.computeTraffic) {
      SIM.computeTraffic();
      lap('traffic');
    }
    if (day % 3 === 0) updateDemand(S, false);
    const ms = performance.now() - t0;
    X.days++;
    X.dayMs += ms;
    if (ms > X.dayMsMax) X.dayMsMax = ms;
    VC.bus.emit('day', day);
    if (day % C.DAYS_PER_MONTH === 0) {
      monthly(S);
      const month = Math.floor(day / C.DAYS_PER_MONTH) % 12;
      const year = C.START_YEAR + Math.floor(day / (C.DAYS_PER_MONTH * 12));
      VC.bus.emit('month', { month, year });
      if (month === 0) VC.bus.emit('year', year);
    }
  },

  /* ---------------- fires ---------------- */
  ignite(b) {
    if (typeof b === 'number') b = VC.world.get(b);
    if (!b || b.key === 'rubble' || b.fire > 0 || !VC.state || !VC.state.buildings.has(b.id)) return false;
    const def = defOf(b);
    if (def && def.group === 'parks' && !def.jobs) return false;
    b.fire = 0.05;
    b.simDispatched = false;
    X.burning && X.burning.add(b.id);
    VC.world.changed(b);
    VC.bus.emit('sfx', { name: 'fire', x: b.x + b.w / 2, z: b.z + b.d / 2 });
    const day = VC.state.time.day;
    if (X.burning && X.burning.size === 1 && day - (X.lastFireToast || -99) > 3) {
      X.lastFireToast = day;
      toast(`Fire at ${SIM.buildingName(b)}!`, 'warn', '🔥');
    }
    return true;
  },
  extinguish(b) {
    if (typeof b === 'number') b = VC.world.get(b);
    if (!b || !(b.fire > 0)) return false;
    b.fire = 0;
    b.simDispatched = false;
    X.burning && X.burning.delete(b.id);
    VC.world.changed(b);
    burst('steam', b, 10);
    return true;
  },

  /* ---------------- queries ---------------- */
  /** Why a zoned tile is (not) growing — for tooltips / advisors. */
  growReason(x, z) {
    const S = VC.state;
    if (!S || !VC.world.inb(x, z)) return '';
    const i = z * S.W + x, code = S.zone[i];
    if (!code) return 'Not zoned';
    if (S.bld[i]) return 'Developed';
    const zt = code >> 2, den = code & 3, fl = S.flags[i];
    if (S.height[i] < C.SEA) return 'Under water';
    if (!(fl & F.ACCESS)) return `No road access (streets within ${C.ROAD_ACCESS} tiles)`;
    if (!(fl & F.POWER)) return 'No power';
    if (den >= 2 && !(fl & F.WATER)) return 'Needs water service (medium/high density)';
    if (S.demand[ZK[zt]] <= 0.02) return `No demand for ${VC.ZONES[zt].name}`;
    return 'Ready — waiting for developers';
  },

  tileInfo(x, z) {
    const S = VC.state;
    if (!S || !VC.world.inb(x, z)) return null;
    const i = z * S.W + x, fl = S.flags[i], code = S.zone[i];
    const o = {
      x, z, i,
      height: S.height[i],
      isWater: S.height[i] < C.SEA,
      terrain: S.terr[i],
      zone: code,
      zoneType: code ? ZK[code >> 2] : null,
      density: code ? code & 3 : 0,
      road: S.road[i],
      roadName: S.road[i] ? VC.ROADS[S.road[i]].name : null,
      pline: !!S.pline[i],
      trees: S.trees[i],
      bld: S.bld[i],
      flags: fl,
      powered: !!(fl & F.POWER),
      watered: !!(fl & F.WATER),
      access: !!(fl & F.ACCESS),
      powerNet: !!(fl & F.POWERNET),
      waterNet: !!(fl & F.WATERNET),
      congestion: SIM.trafficAt ? SIM.trafficAt(x, z) : 0,
      trafficVolume: SIM.trafficVolume ? Math.round(SIM.trafficVolume[i]) : 0,
      growReason: code && !S.bld[i] ? SIM.growReason(x, z) : '',
      desirability: code ? desirability(S, code >> 2, i) : 0,
      maps: {},
    };
    for (const k of VC.MAP_KEYS) o[k] = o.maps[k] = S.maps[k][i];
    return o;
  },

  buildingInfo(b) {
    const S = VC.state;
    if (typeof b === 'number') b = VC.world.get(b);
    if (!S || !b) return { name: '', subtitle: '', lines: [], problems: [], factors: [] };
    if (b.simI == null) initBuilding(S, b);
    const i = b.simI, m = S.maps, def = defOf(b);
    const lines = [], problems = [], factors = [];
    const L = (label, value, cls) => lines.push(cls ? { label, value, cls } : { label, value });
    const pct = (v) => Math.round(v * 100) + '%';
    const lvl = (v) => (v > 170 ? 'High' : v > 85 ? 'Medium' : v > 20 ? 'Low' : 'None');
    const name = SIM.buildingName(b);
    let subtitle = SIM.zoneLabel ? SIM.zoneLabel(b) : '';

    if (b.key === 'rubble') {
      L('Status', b.simCause === 'fire' ? 'Burnt down' : 'Debris', 'bad');
      L('Clears in', Math.max(0, Math.ceil((180 - b.age) / 30)) + ' months');
      return { name, subtitle: 'Rubble', lines, problems: ['Blocks development until bulldozed'], factors };
    }
    if (b.built < 1) L(b.simReplay ? 'Upgrading' : 'Under construction', pct(b.built), 'warn');
    if (b.fire > 0) {
      L('ON FIRE', pct(b.fire) + ' burned', 'bad');
      problems.push(m.fire[i] > 30 ? 'Burning! Firefighters are on the way.' : 'Burning with no fire coverage!');
    }
    if (b.key === 'grow') {
      const zk = ZK[b.zt];
      subtitle = `${subtitle} · Level ${b.level} · ${['Low', 'Middle', 'High'][b.wealth | 0]} wealth`;
      if (b.abandoned) {
        L('Status', 'Abandoned', 'bad');
        problems.push('Abandoned — fix the problems below and it may be reoccupied.');
      }
      if (b.zt === 1) L('Residents', `${VC.fmt.num(b.pop)} / ${VC.fmt.num(b.cap)}`);
      else L('Jobs', `${VC.fmt.num(b.pop)} / ${VC.fmt.num(b.cap)} filled`, b.pop < b.cap * 0.6 && b.built >= 1 ? 'warn' : null);
      const hs = b.happy;
      L('Happiness', pct(hs), hs > 0.65 ? 'good' : hs < 0.35 ? 'bad' : null);
      evalHappy(S, b, factors);
      factors.sort((p, q) => Math.abs(q.raw) - Math.abs(p.raw));
      // level-up hint
      if (b.level < 3 && !b.abandoned) {
        const next = b.level + 1;
        const need = [];
        if (b.pop < b.cap * 0.85) need.push('fuller');
        if (hs <= 0.65) need.push('happier');
        if (b.zt === 3) { if (Math.max(m.edu[i], X.cityEdu * 255) < EDU_REQ[next]) need.push('better education'); }
        else if (m.landValue[i] < LV_REQ[b.zt][next]) need.push('higher land value');
        if (!b.watered) need.push('water');
        L('Next level', need.length ? 'Needs ' + need.join(', ') : 'Ready to upgrade', need.length ? null : 'good');
      }
      if (S.demand[zk] < -0.3) problems.push(`Low ${VC.ZONES[b.zt].name.toLowerCase()} demand`);
      if (b.zt === 1 && b.simCommute < 0 && b.built >= 1) problems.push('No road route to any jobs');
      if (b.zt !== 1 && X.fill < 0.7) problems.push('Not enough workers');
      if (b.zt === 2 && S.demand.C < -0.3) problems.push('Not enough customers');
      if (b.simGarbage > 0.4) problems.push('Garbage piling up — no garbage pickup');
      if (X.taxW[b.zt] && X.taxW[b.zt][b.wealth | 0] < -0.3) problems.push('Taxes too high');
    } else if (def) {
      subtitle = `${subtitle}${def.dept ? ' · ' + ((VC.DEPARTMENTS.find((d) => d.key === def.dept) || {}).name || '') : ''}`;
      if (def.power) {
        const out = X.powerOut(S, b);
        L('Output', `${Math.round(out)} MW` + (b.key === 'wind_turbine' ? ' (wind)' : b.key === 'solar_farm' ? ' (sun)' : ''), 'good');
        L('City power', `${VC.fmt.num(S.stats.powerDemand)} / ${VC.fmt.num(S.stats.powerSupply)} MW used`, X.power.shortage ? 'bad' : null);
      }
      if (def.water) {
        const out = X.waterOut(S, b);
        L('Output', `${Math.round(out)} kL` + (out <= 0 && b.built >= 1 ? ' (needs power)' : ''), out > 0 ? 'good' : 'bad');
        L('City water', `${VC.fmt.num(S.stats.waterDemand)} / ${VC.fmt.num(S.stats.waterSupply)} kL used`, X.water.shortage ? 'bad' : null);
      }
      if (def.jobs) L('Staff', `${VC.fmt.num(b.simJobs != null ? b.simJobs : 0)} / ${def.jobs}`);
      if (def.housing) L('Residents', `${VC.fmt.num(b.pop)} / ${VC.fmt.num(def.housing)}`);
      if (def.cover) {
        const eff = X.eff(def.dept) * (b.powered ? 1 : 0.4);
        for (const svc in def.cover) {
          const s = VC.SERVICES.find((q) => q.key === svc);
          L((s ? s.name : svc) + ' radius', `${Math.round(def.cover[svc] * (0.45 + 0.55 * Math.min(eff, 1.3)))} tiles`);
        }
        L('Effectiveness', pct(eff), eff < 0.7 ? 'warn' : 'good');
        if (X.eff(def.dept) < 0.6) problems.push('Underfunded — raise the budget');
      }
      if (def.tourism) L('Tourism', '+' + def.tourism);
      if (def.income) L('Income', VC.fmt.money(def.income) + '/mo', 'good');
      if (def.happy) L('City happiness', '+' + (def.happy * 100).toFixed(1) + '%', 'good');
      if (def.pollution) L('Pollution', lvl(def.pollution), 'bad');
    }
    // shared lines
    const needP = b.simNeedP, needW = b.simNeedW;
    if (needP) L('Power', b.powered ? 'Connected' : 'No power', b.powered ? 'good' : 'bad');
    if (needW) L('Water', b.watered ? 'Connected' : 'No water', b.watered ? 'good' : b.key === 'grow' && b.den === 1 ? 'warn' : 'bad');
    if (needP && !b.powered) problems.push(X.power.shortage && b.simNetP ? 'Power shortage — build more power plants' : 'Not connected to the power grid');
    if (needW && !b.watered) problems.push(X.water.shortage && b.simNetW ? 'Water shortage — build more pumps' : 'No water service — connect with roads to a pump or tower');
    if (b.key === 'grow' || b.key === 'arcology') {
      L('Land value', VC.fmt.money(m.landValue[i] * 40) + ' /tile', m.landValue[i] > 150 ? 'good' : m.landValue[i] < 60 ? 'warn' : null);
      L('Pollution', lvl(m.pollution[i]), m.pollution[i] > 120 ? 'bad' : null);
      L('Crime', lvl(m.crime[i]), m.crime[i] > 120 ? 'bad' : null);
      if (m.noise[i] > 60) L('Noise', lvl(m.noise[i]), m.noise[i] > 140 ? 'warn' : null);
      if (b.simRoad >= 0) {
        const cg = SIM.trafficAt ? SIM.trafficAt(b.simRoad % S.W, (b.simRoad / S.W) | 0) : 0;
        L('Street traffic', cg > 1 ? 'Jammed' : cg > 0.6 ? 'Busy' : 'Light', cg > 1 ? 'bad' : cg > 0.6 ? 'warn' : null);
      }
      if (m.pollution[i] > 120) problems.push('Heavy air pollution');
      if (m.crime[i] > 120) problems.push('High crime — build police stations');
      if (b.key === 'grow' && b.zt === 1 && m.fire[i] < 40) problems.push('No fire protection');
    }
    if (b.simRoad < 0 && b.key === 'grow') problems.push('No road access');
    L('Age', b.age >= 360 ? Math.floor(b.age / 360) + ' yr' : Math.floor((b.age || 0) / 30) + ' mo');
    return { name, subtitle, lines, problems, factors };
  },

  demandFactors() {
    return X.factors || { R: [], C: [], I: [] };
  },

  powerInfo() {
    const p = X.power || { supply: 0, demand: 0, plants: [] };
    return {
      supply: p.supply, demand: p.demand, plants: p.plants.slice(), served: p.served,
      connectedDemand: p.connectedDemand, shortage: p.shortage, unpowered: p.unpowered, networks: p.networks,
    };
  },
  waterInfo() {
    const p = X.water || { supply: 0, demand: 0, sources: [] };
    return {
      supply: p.supply, demand: p.demand, sources: p.sources.slice(), served: p.served,
      connectedDemand: p.connectedDemand, shortage: p.shortage, unwatered: p.unwatered, networks: p.networks,
    };
  },

  /** {police:{coverage, buildings, funding, effectiveness, name, icon}, …} coverage = share of residents covered. */
  serviceStats() {
    const S = VC.state;
    const res = {};
    if (!S) return res;
    const covered = {};
    for (const s of VC.SERVICES) {
      res[s.key] = { name: s.name, icon: s.icon, coverage: 0, buildings: 0, funding: S.budget[s.dept] != null ? S.budget[s.dept] : 1, effectiveness: X.eff(s.dept), jobs: 0 };
      covered[s.key] = 0;
    }
    let pop = 0;
    for (const b of S.buildings.values()) {
      if (b.simI == null) continue;
      if ((b.key === 'grow' && b.zt === 1) || b.key === 'arcology') {
        if (b.pop <= 0) continue;
        pop += b.pop;
        for (const s of VC.SERVICES) if (S.maps[s.key][b.simI] > 96) covered[s.key] += b.pop;
      } else if (b.key !== 'grow') {
        const def = VC.BLD[b.key];
        if (def && def.cover && b.built >= 1) for (const k in def.cover) if (res[k]) { res[k].buildings++; res[k].jobs += def.jobs || 0; }
      }
    }
    for (const s of VC.SERVICES) res[s.key].coverage = pop > 0 ? covered[s.key] / pop : 0;
    return res;
  },

  /** City-wide problem counts for advisors/HUD. */
  issues() {
    const S = VC.state;
    const st = S ? S.stats : {};
    const o = {
      unpowered: st.unpowered || 0, unwatered: st.unwatered || 0, noAccess: st.noAccess || 0, noCommute: st.noCommute || 0,
      fires: X.burning ? X.burning.size : 0, abandoned: st.abandoned || 0, rubble: st.rubble || 0,
      powerShortage: !!(X.power && X.power.shortage), waterShortage: !!(X.water && X.water.shortage),
      zonedNoAccess: 0, zonedNoPower: 0, zonedNoWater: 0, zonedEmpty: 0,
      garbage: st.garbage || 0, jammedRoads: SIM.trafficStats ? SIM.trafficStats().jammedTiles : 0,
    };
    if (!S) return o;
    for (let i = 0; i < S.N; i++) {
      const code = S.zone[i];
      if (!code || S.bld[i]) continue;
      o.zonedEmpty++;
      const fl = S.flags[i];
      if (!(fl & F.ACCESS)) o.zonedNoAccess++;
      else if (!(fl & F.POWER)) o.zonedNoPower++;
      else if ((code & 3) >= 2 && !(fl & F.WATER)) o.zonedNoWater++;
    }
    return o;
  },

  /** Timing info for profiling (perDay = average ms per simulated day by section). */
  resetPerf() {
    X.days = 0; X.dayMs = 0; X.dayMsMax = 0;
    X.prof = { net: 0, bld: 0, misc: 0, growth: 0, maps: 0, traffic: 0 };
    X.profMax = { net: 0, bld: 0, misc: 0, growth: 0, maps: 0, traffic: 0 };
  },
  perf() {
    return {
      netMs: +(X.netMs || 0).toFixed(2), mapsMs: +(X.mapsMs || 0).toFixed(2), trafficMs: +(X.trafficMs || 0).toFixed(2),
      dayAvgMs: X.days ? +(X.dayMs / X.days).toFixed(3) : 0, dayMaxMs: +(X.dayMsMax || 0).toFixed(2), days: X.days,
      perDay: Object.fromEntries(Object.entries(X.prof || {}).map(([k, v]) => [k, +(v / Math.max(1, X.days)).toFixed(3)])),
      maxMs: Object.fromEntries(Object.entries(X.profMax || {}).map(([k, v]) => [k, +v.toFixed(2)])),
    };
  },
});
// fallback if names.js is missing
if (!SIM.buildingName) SIM.buildingName = (b) => (b ? (b.key === 'grow' ? (VC.ZONES[b.zt] || {}).name + ' building' : (VC.BLD[b.key] || {}).name || b.key) : '');
if (!SIM.districtName) SIM.districtName = () => 'Downtown';
X.dailyBuildings = dailyBuildings; // exposed for profiling tests
