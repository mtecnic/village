/*
 * VOXELPOLIS — simulation core (VC.sim). Contract: docs/ARCHITECTURE.md §VC.sim.
 *
 * Files: sim/names.js (names), sim/sim.js (this: time, growth, occupancy, happiness, demand, fires,
 * stats, inspector API), sim/sim_maps.js (derived maps), sim/sim_net.js (power/water/access),
 * sim/traffic.js (commuter traffic). All attach to VC.sim; shared scratch lives in VC.sim._ (X).
 *
 * TIME: update() turns rdt * C.SPEEDS[speed] / C.DAY_SEC into whole days (<= 8 per frame).
 *   Construction progress is advanced continuously per frame (smooth build-up animation); when tickDay()
 *   is called directly (VC.debug.run) it advances construction itself.
 * FRAME BUDGET: the frame loop runs each day as a generator (dayGen) and the heavy passes (networks,
 *   maps, traffic) as staged jobs (see "job scheduler"), all within ~4 ms per frame (a quarter of the
 *   frame on slow machines): a big city's day may span two frames, the month's bookkeeping gets its own
 *   slice, only one heavy pass runs (and finishes) per frame, and at high speed the passes run every
 *   N days such that they stay >= 1-2 s real time apart. tickDay() still does a whole day synchronously.
 * DAILY: construction, occupancy (move-ins / job filling), stats; for a quarter of the buildings
 *   ((id + day) & 3): happiness, garbage, abandonment, downgrade, level-up, fire ignition. Fire
 *   spread/extinguish, growth slice (1/4 of the map in a fixed random order), abandoned 12+ months
 *   -> rubble. day%3==0 demand (smoothed). Heavy passes: tickDay() day%4==1 networks, day%4==2 maps,
 *   day%8==3 traffic; frame loop every 4 / 4 / 8 days at 1x, 8 / 12 / 16 at 8x (CADENCE).
 * GROWTH BUDGET: capacity units per zone per day (demand x sub-linear city size), spent by new
 *   buildings and level-ups; lot sizes are capped by the zone's unmet need.
 * MONTHLY: wealth drift, rubble clearing (6 months), abandonment summary -> then 'month' / 'year'.
 * RESPONSIVENESS: bldAdd/bldRemove/roadChange/power-line edits schedule recalcNetworks() (throttled to
 *   max(150 ms, 4x its last duration), also while paused); service placement/budget/policy changes
 *   schedule computeMaps(). Topology edits set X.topoDirty (full network rebuild); new growables
 *   are queued in X.joinQ and joined incrementally (sim_net.js).
 * REDEVELOPMENT: repainting a developed lot with another density of the same zone type (up- or
 *   downzoning) makes the building redevelop to that density over the next weeks (upzoning needs
 *   demand and growth budget; the lot replays its construction).
 * TRAFFIC: long congested commutes and jammed home streets cost happiness; jammed access roads
 *   lower shop/factory job fill; road funding below 60% adds a 'Road condition' penalty.
 * WEATHER: the sim keeps its own deterministic weather X.wx (VC.sim.weather()), derived from the
 *   seed and the day — never from the visual weather, so graphics settings can't change results.
 * FIRES: ordinary fires are announced in one aggregated, rate-limited toast (<= 1 per 8 s real
 *   time); fires started by a disaster (ignite(b, {disaster:true}) or b.fireCause === 'disaster')
 *   and anything in the title-screen demo (S.demo) stay silent.
 * PERSISTENCE: growth accumulators and occupancy appeal live in S.simState (saved), so loading a
 *   game continues exactly where it was saved (reset recomputes demand factors, not demand).
 *
 * Building runtime fields added here (prefix sim): simI (center tile), simRoad (access road tile),
 *   simPo/simPw/simWo/simWu (power/water out/use), simJobs (filled jobs of catalog buildings),
 *   simCommute (-1 = no path to work), simGarbage 0..1, simUnhappy/simGood/simAband/simDown (day
 *   counters), simWealthCnt, simCause (rubble: 'fire'), simDispatched (fire truck sent),
 *   simLoad / simCapF (service buildings: residents served, capacity factor), simFireD (the fire
 *   was started by a disaster).
 */
const SIM = (VC.sim = VC.sim || {});
const X = (SIM._ = SIM._ || {});
const C = VC.C, M = VC.M, F = VC.F;
const ZK = [null, 'R', 'C', 'I'];

const LABOR = 0.5; // share of residents who work
const LV_REQ = { 1: [0, 0, 80, 120], 2: [0, 0, 75, 110] }; // land value needed for level 2 / 3
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
/** User-facing toast; silent in the title-screen demo. Text is HTML: escape user strings with esc(). */
function toast(text, type, icon) {
  const S = VC.state;
  if (S && S.demo) return;
  VC.bus.emit('toast', { text, type, icon });
}
function sfx(o) {
  const S = VC.state;
  if (S && S.demo) return;
  VC.bus.emit('sfx', o);
}
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => (VC.esc ? VC.esc(s) : String(s).replace(/[&<>"']/g, (c) => ESC[c]));
/** Level-up needs a nearly full building; floor() so small lots (cap 6 -> 5) are reachable. */
const fullEnough = (b) => b.pop >= Math.max(1, Math.floor(b.cap * 0.85));
/** Is this catalog venue closed because its required policy is off (e.g. the casino)? */
const closedVenue = (S, def) => !!(def && def.requiresPolicy && !(S.policies && S.policies[def.requiresPolicy]));

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
  if (b.simLoad == null) b.simLoad = 0;
  if (b.simCapF == null) b.simCapF = 1;
  if (b.simFireD == null) b.simFireD = false;
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
    // congestion-inflated travel time (street tiles) beyond a 12-tile commute, and jams at the door
    h += fac(out, 'Commute', b.simCommute < 0 ? -0.12 : -Math.min(0.12, Math.max(0, (b.simCommute - 12) / 100)));
    h += fac(out, 'Street traffic', -rt * 0.15);
    if (X.roadPen) h += fac(out, 'Road condition', -X.roadPen);
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
    h += fac(out, 'Traffic', -rt * 0.1);
    if (X.roadPen) h += fac(out, 'Road condition', -X.roadPen * 0.5);
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
    h += fac(out, 'Freight traffic', -rt * 0.12);
    if (X.roadPen) h += fac(out, 'Road condition', -X.roadPen * 0.5);
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
  const wet = X.wx ? X.wx.wet : 0;
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
 * Level up a nearly full, happy growable when land value (industry: education) allows and the
 * zone's growth budget has room. Checked in the building's 4-day slice (~35% chance a month).
 */
function tryLevelUp(S, b) {
  if (b.level >= 3 || b.built < 1 || !fullEnough(b) || b.happy <= 0.65 || !b.powered || !b.watered) return;
  const zt = b.zt;
  if (S.demand[ZK[zt]] <= 0 || X.growAcc[zt] <= 0 || X.rnd() >= 0.055) return;
  const next = b.level + 1, i = b.simI, m = S.maps;
  if (zt === 3) {
    if (Math.max(m.edu[i], (X.cityEdu || 0) * 255) < EDU_REQ[next]) return;
  } else if (m.landValue[i] < LV_REQ[zt][next]) return;
  const old = b.cap;
  b.level = next;
  b.cap = capOf(b);
  b.simCapL = next;
  X.growAcc[zt] -= b.cap - old;
  b.built = 0.6;
  b.simReplay = true;
  X.constructing.add(b.id);
  VC.world.changed(b);
  // (the sparkle burst comes from the particles module, which bursts on every level-up it sees)
  if (++X.levelUps <= 3) sfx({ name: 'levelup', x: b.x + b.w / 2, z: b.z + b.d / 2, vol: 0.4 });
}

/**
 * Up- / downzoning: the player repainted this developed lot with another density of the same zone
 * type (the zone code under the building's centre tile). Upzoning waits for demand and growth budget,
 * then rebuilds the lot at the new density (level 1, construction replay); downzoning rebuilds
 * it smaller at the same level. Checked in the building's 4-day slice. Returns true if it changed.
 */
function tryRedevelop(S, b) {
  const code = S.zone[b.simI];
  if (!code || code >> 2 !== b.zt) return false;
  const zd = code & 3;
  if (zd === b.den || b.built < 1 || b.fire > 0) return false;
  const zt = b.zt;
  if (zd > b.den) {
    if (S.demand[ZK[zt]] <= 0.02 || X.growAcc[zt] <= 0 || !b.powered || (zd >= 2 && !b.watered)) return false;
    if (X.rnd() >= 0.25) return false; // ~2 weeks on average once conditions hold
  } else if (X.rnd() >= 0.15) return false;
  const old = b.cap;
  if (zd > b.den) b.level = 1; // a new, denser building starts over at level 1
  b.den = zd;
  return redevelopTo(S, b, old);
}
function redevelopTo(S, b, oldCap) {
  b.cap = capOf(b);
  b.simCapL = b.level;
  if (b.cap > oldCap) X.growAcc[b.zt] -= b.cap - oldCap;
  if (b.pop > b.cap) b.pop = b.cap;
  b.wealth = wealthFor(S, b.zt, b.simI);
  b.simWealthCnt = 0;
  b.built = 0.3;
  b.simReplay = true;
  X.constructing.add(b.id);
  VC.world.changed(b);
  X.redevelopedMonth++;
  return true;
}

/**
 * One pass over all buildings. Cheap work (totals, occupancy) runs daily for everyone; the
 * heavier per-building evaluation (happiness, garbage, abandonment, fire risk) runs for a
 * quarter of the buildings per day (b.id + day) & 3, with rates scaled to the 4-day step.
 * sim = false: totals only (used after reset/load).
 */
function* dailyBuildings(S, sim, live) {
  const tot = newTot(); // published as X.tot when the pass is done (a live pass spans frames)
  const m = S.maps, dem = S.demand, rnd = X.rnd;
  const fill = X.fill;
  const pend = X.pending;
  const day = S.time.day;
  const leave = Math.max(0, X.unemp - 0.1) * 0.6; // unemployed families move away
  const garbMul = 0.016 * Math.max(0, 1 + (S.mods.garbage || 0));
  pend.length = 0;
  if (sim) X.bk[-day & 3].fill(0);
  else for (let k = 0; k < 4; k++) X.bk[k].fill(0);
  let nb = 0;
  for (const b of S.buildings.values()) {
    if (live && (++nb & 255) === 0) yield 'bld';
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
      // a venue whose policy is off (casino without Legalized Gambling) is closed: no staff,
      // no visitors, no happiness bonus
      const closed = closedVenue(S, def);
      const jobs = closed ? 0 : def.jobs || 0;
      if (key === 'seaport') tot.seaports++;
      else if (key === 'airport') tot.airports++;
      if (def.group === 'parks' && !def.unique) tot.parks++;
      if (!closed) {
        // amenities need their budget (and power, if they use any) to draw crowds
        const run = Math.min(1, X.effC[def.dept || 'parks'] != null ? X.effC[def.dept || 'parks'] : 1) * (b.powered ? 1 : 0.5);
        tot.tourismRaw += (def.tourism || 0) * run;
        tot.happyMod += (def.happy || 0) * run;
      }
      if (jobs) {
        tot.jobsSvc += jobs;
        // staff can't commute to a building without a street at the door
        b.simJobs = Math.round(jobs * fill * (b.powered ? 1 : 0.5) * (b.simRoad >= 0 || !X.needsAccess(def) ? 1 : 0.3));
        tot.jobsFilled += b.simJobs;
        if (!def.housing) {
          b.pop = b.simJobs;
          b.cap = jobs;
        }
      } else if (closed && def.jobs) {
        b.simJobs = 0;
        b.pop = 0;
        b.cap = def.jobs;
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
        // a jammed access road (over capacity) keeps staff and customers away
        if (b.simRoad >= 0 && m.traffic[b.simRoad] > 180) f *= 0.85;
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
      if (b.simUnhappy > 80 + (b.variant % 61)) { // 80..140 days: people don't all give up the same week
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
      if (!tryRedevelop(S, b)) tryLevelUp(S, b);
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
  X.tot = tot;
  // collapse long-abandoned buildings (outside the iteration)
  for (const b of pend) toRubble(S, b, 'abandon');
  pend.length = 0;
}
/** Runs a generator to completion (synchronous use of the staged passes). */
function runSync(g) {
  while (!g.next().done);
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
  st.happiness = hw > 0 ? t.happyS / hw : 0.65; // no residents yet: a hopeful, neutral mood
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
  // landmarks + parks + policy visitors (Tourism Campaign), all scaled by the tourism modifier
  let visitors = 0;
  // (the policy's slider scales its visitors like its cost: 50 % ad budget = half the visitors)
  for (const k in S.policies) {
    const d = VC.POLICY[k];
    if (!d || !d.visitors || !S.policies[k]) continue;
    const lv = VC.econ && VC.econ.policyLevel ? VC.econ.policyLevel(k) : S.policies[k] === true ? 1 : clamp(+S.policies[k] || 0, 0, 1);
    visitors += d.visitors * lv;
  }
  st.tourism = Math.round((t.tourismRaw + t.parks * 1.5 + visitors) * Math.max(0, 1 + (mods.tourism || 0)));
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
  // services only weigh in once people live here (an empty new city reads neutral-positive, ~60%)
  const svcW = Math.min(1, pop / 1000);
  const svcTerm = 0.65 * (1 - svcW) + Math.min(1, svc * 1.4) * svcW;
  st.approval = clamp(0.55 * st.happiness + 0.25 * (0.5 + taxAvg * 0.5) + 0.2 * svcTerm, 0, 1);
  if (pop > S.peakPop) S.peakPop = pop;
  X.happyMod = (mods.happiness || 0) + t.happyMod;
}

/* ------------------------------------------------------------------ */
/* job scheduler (live game)                                            */
/* ------------------------------------------------------------------ */
/*
 * The heavy passes (networks, maps, traffic) are generators (X.netGen, X.mapsGen, X.trafficGen) that the
 * frame loop advances in slices within the sim's per-frame time budget: one pass at a time (priority
 * net > maps > traffic, since maps read the networks' results) and at most one pass finishing per frame
 * (its bus event fans out into renderer rebuilds). Their day cadence stretches with the game speed so a
 * pass never runs more often than every CADENCE[k][1] real seconds (at 8x: networks every 8 days, maps
 * every 12, traffic every 16 instead of 4 / 4 / 8). Synchronous calls (recalcNetworks, computeMaps,
 * computeTraffic, tickDay) cancel a running pass of the same kind and do the whole work at once.
 */
const CADENCE = { net: [4, 1.0], maps: [4, 1.5], traffic: [8, 2.0] }; // [days at 1x, min real seconds]
function cadence(S, kind) {
  const c = CADENCE[kind];
  const dps = (C.SPEEDS[S.time.speed] || 1) / C.DAY_SEC;
  return Math.max(c[0], Math.ceil(c[1] * dps));
}
const JOB_ORDER = ['net', 'maps', 'traffic'];
/** Drops a staged pass that is still running (kind omitted: whatever runs). */
function cancelJob(kind) {
  const j = X.job;
  if (!j || (kind && j.kind !== kind)) return;
  X.job = null;
  if (j.kind === 'net') X.topoDirty = true; // its partial topology work is redone by a full rebuild
  else if (j.kind === 'maps') X.mapsDirty = true;
}
X.cancelJob = cancelJob;
function startJob(S) {
  for (const kind of JOB_ORDER) {
    if (!X.want[kind]) continue;
    X.want[kind] = false;
    const ck = { work: 0, t0: 0 };
    let gen = null;
    if (kind === 'net') {
      gen = X.netGen(S, false, true, ck);
      X.netDay = S.time.day;
    } else if (kind === 'maps') {
      X.mapsDirty = false;
      gen = X.mapsGen(S, true, ck);
      X.mapsDay = S.time.day;
    } else {
      if (!X.trafficGen) continue;
      gen = X.trafficGen(S, true, ck);
      X.trafDay = S.time.day;
    }
    X.job = { kind, gen, ck, S };
    return true;
  }
  return false;
}
/** Advances the running pass for about budgetMs (at least one slice), or starts the next wanted one. */
function runJobs(S, budgetMs) {
  const t0 = performance.now();
  if (X.job && X.job.S !== S) X.job = null;
  if (!X.job && !startJob(S)) return;
  const j = X.job, ck = j.ck;
  for (;;) {
    ck.t0 = performance.now();
    let r;
    try {
      r = j.gen.next();
    } catch (e) {
      cancelJob();
      throw e;
    }
    const tn = performance.now();
    ck.work += tn - ck.t0;
    sliceStat(j.kind, r.done ? 'end' : r.value, tn - ck.t0);
    if (r.done) {
      X.job = null;
      X.jobDone[j.kind] = (X.jobDone[j.kind] || 0) + 1;
      if (j.kind === 'net') checkShortages(S);
      return; // at most one pass finishes per frame
    }
    if (tn - t0 >= budgetMs) return;
  }
}
/** Profiling: longest slice per job kind and phase (the value its generator yielded at the end of it). */
function sliceStat(kind, tag, ms) {
  const all = X.slices || (X.slices = {});
  const m = all[kind] || (all[kind] = {});
  const e = m[tag || '-'] || (m[tag || '-'] = [0, 0, 0]); // count, sum, max
  e[0]++;
  e[1] += ms;
  if (ms > e[2]) e[2] = ms;
}
/** Advances the running day for about budgetMs (at least one slice). True when the day is done. */
function stepDay(budgetMs) {
  const g = X.dayJob, pc = X.dayClock;
  const t0 = performance.now();
  for (;;) {
    if (pc.lastYield) pc.paused += performance.now() - pc.lastYield;
    let r;
    try {
      r = g.next();
    } catch (e) {
      X.dayJob = null;
      pc.lastYield = 0;
      throw e;
    }
    const tn = performance.now();
    sliceStat('day', r.done ? 'end' : r.value, tn - (pc.lastYield > t0 ? pc.lastYield : t0));
    if (r.done) {
      X.dayJob = null;
      pc.lastYield = 0;
      return true;
    }
    pc.lastYield = tn;
    if (tn - t0 >= budgetMs) return false;
  }
}

/** Growth state that must survive save/load (S.simState is saved with the city). */
function saveState(S) {
  const ss = S.simState && typeof S.simState === 'object' ? S.simState : (S.simState = {});
  ss.v = 1;
  ss.growAcc = X.growAcc;
  ss.rAppeal = X.rAppeal;
  ss.permPos = X.permPos;
}

/** Per-day city-level caches used by happiness/demand. */
function refreshCity(S) {
  if (!X.taxZ) {
    X.taxZ = [0, 0, 0, 0];
    X.taxW = [null, [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  }
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
  // department effectiveness (funding, strikes) cached for the day
  const effC = X.effC || (X.effC = {});
  for (const d of VC.DEPARTMENTS) effC[d.key] = X.eff(d.key);
  // potholes: road funding below 60% effectiveness costs happiness (up to -0.09 at 0%)
  X.roadPen = Math.max(0, 0.6 - effC.roads) * 0.15;
  X.wx = simWeather(S);
}

/* ------------------------------------------------------------------ */
/* sim weather (deterministic; independent of the visual weather)      */
/* ------------------------------------------------------------------ */
// per season (0 spring, 1 summer, 2 autumn, 3 winter): chance of storm, rain/snow, clouds
const WX_P = [[0.05, 0.3, 0.3], [0.1, 0.15, 0.25], [0.05, 0.3, 0.35], [0.03, 0.25, 0.35]];
const WX_T = {
  clear: { cloud: 0.15, wind: 0.3, precip: 0 }, cloudy: { cloud: 0.6, wind: 0.45, precip: 0 },
  rain: { cloud: 0.8, wind: 0.5, precip: 0.6 }, storm: { cloud: 0.95, wind: 0.9, precip: 1 },
  snow: { cloud: 0.8, wind: 0.4, precip: 0.5 },
};
function wxType(S, day) {
  const mo = Math.floor(day / C.DAYS_PER_MONTH) % 12;
  const season = mo >= 2 && mo <= 4 ? 0 : mo >= 5 && mo <= 7 ? 1 : mo >= 8 && mo <= 10 ? 2 : 3;
  // weather spells of 4 days, each with its own draw
  const r = M.hash(Math.floor(day / 4), 71, S.seed | 0);
  const p = WX_P[season];
  if (r < p[0]) return season === 3 ? 'snow' : 'storm';
  if (r < p[0] + p[1]) return season === 3 ? 'snow' : 'rain';
  if (r < p[0] + p[1] + p[2]) return 'cloudy';
  return 'clear';
}
/** Weather for the current sim day: {type, cloud, wind, wet, windDir} — a pure function of seed + day. */
function simWeather(S) {
  const day = S.time.day, seed = S.seed | 0;
  const type = wxType(S, day), T = WX_T[type];
  // ground wetness: rain today and the last three days (snow counts half)
  let wet = 0;
  const wts = [0.45, 0.25, 0.15, 0.1];
  for (let k = 0; k < 4; k++) {
    const t = k ? wxType(S, day - k) : type;
    wet += wts[k] * WX_T[t].precip * (t === 'snow' ? 0.5 : 1);
  }
  const o = X._wx || (X._wx = { type: '', cloud: 0, wind: 0, wet: 0, windDir: 0 });
  o.type = type;
  o.cloud = T.cloud;
  o.wind = clamp(T.wind + (M.hash(day, 72, seed) - 0.5) * 0.2, 0, 1);
  o.wet = clamp(wet, 0, 1);
  // prevailing wind direction drifts slowly (smooth between 4-day spells)
  const s = day / 4, s0 = Math.floor(s), u = s - s0;
  const a0 = M.hash(s0, 73, seed) * M.PI2, a1 = M.hash(s0 + 1, 73, seed) * M.PI2;
  let d = a1 - a0;
  if (d > Math.PI) d -= M.PI2;
  else if (d < -Math.PI) d += M.PI2;
  o.windDir = a0 + d * u;
  return o;
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
  const needC = pop * 0.18 + tour + 15;
  const scale = Math.max(40, needC * 0.5);
  const shop = clamp((needC - t.capC) / scale, -1, 1) * 0.7;
  const tourPart = shop > 0 ? Math.min(shop, (tour / scale) * 0.7) : 0;
  Cd += add(fC, shop >= 0 ? 'Shoppers' : 'Too many shops', shop - tourPart);
  Cd += add(fC, 'Tourists', tourPart);
  const laborShort = jobsAll > 0 ? Math.max(0, 1 - (workers + 40 + pop * 0.04) / jobsAll) : 0;
  const wk = X.unemp > 0.03 ? X.unemp * 0.4 : -laborShort * 0.5;
  Cd += add(fC, wk >= 0 ? 'Available workers' : 'Labor shortage', wk);
  if (t.airports) Cd += add(fC, 'Airport', 0.12);
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

  // unmet capacity per zone (residents / jobs) — growth picks lot sizes that fit it
  X.unmet[1] = Math.max(0, S.demand.R) * (120 + pop * 0.25);
  X.unmet[2] = Math.max(0, needC - t.capC) + (S.demand.C > 0 ? 20 : 0);
  X.unmet[3] = Math.max(0, workers - jobsAll) + Math.max(0, S.demand.I) * (60 + pop * 0.05);

  const fin = (v) => clamp(v > 0 ? v * mul : v / mul, -1, 1);
  // occupancy uses the city's appeal without the vacancy terms (else vacancy -> low demand -> more vacancy)
  const appeal = fin(R - vac - (fR.find((f) => f.label === 'Homes under construction') || { value: 0 }).value);
  // instant === 'factors': explain the demand (after a load) without moving it
  if (instant !== 'factors') {
    X.rAppeal += (appeal - X.rAppeal) * (instant ? 1 : 0.25);
    const k = instant ? 1 : 0.25;
    S.demand.R += (fin(R) - S.demand.R) * k;
    S.demand.C += (fin(Cd) - S.demand.C) * k;
    S.demand.I += (fin(I) - S.demand.I) * k;
  }
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
    // shops like passing trade on the street out front (busy, not jammed: 0.67 = at capacity)
    const r = X.accRoad ? X.accRoad[i] : -1;
    const t = r >= 0 ? m.traffic[r] / 255 : 0;
    d = 0.35 + lv * 0.45 - cri * 0.3 - pol * 0.15 + (t < 0.6 ? t * 0.35 : 0.21 - (t - 0.6) * 1.0);
  } else {
    // industry wants cheap land and fast roads for freight
    const r = X.accRoad ? X.accRoad[i] : -1;
    d = 0.6 - lv * 0.2 - cri * 0.1 + (r >= 0 && S.road[r] >= 2 ? 0.1 : 0);
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
  // don't drop a 800-job tower into a town that needs 200 more jobs: skip lots far above the unmet need
  let smallest = sizes[0];
  for (const s of sizes) if (s[0] * s[1] < smallest[0] * smallest[1]) smallest = s;
  const limit = Math.max(0, X.unmet[zt]) * 1.3;
  const h0 = S.height[i];
  /** Places lot size s covering tile (x, z) if it fits (place = false: only test). */
  const tryOne = (s, place) => {
    for (let rot = 0; rot < (s[0] !== s[1] ? 2 : 1); rot++) {
      const w = rot ? s[1] : s[0], d = rot ? s[0] : s[1];
      for (let oz = 0; oz < d; oz++)
        for (let ox = 0; ox < w; ox++) {
          const x0 = x - ox, z0 = z - oz;
          if (fits(S, x0, z0, w, d, code, h0)) return place ? placeGrow(S, x0, z0, w, d, zt, den) : true;
        }
    }
    return null;
  };
  for (const s of order) {
    if (s !== smallest && G.cap[0] * s[0] * s[1] > limit) continue;
    const b = tryOne(s, true);
    if (b) return b;
  }
  // odd strips no regular lot fits into (e.g. the 5th column of a 5-wide industrial block)
  if (G.fallback) {
    for (const s of sizes) if (tryOne(s, false)) return null; // a regular lot fits: wait for demand
    for (const s of G.fallback) {
      const b = tryOne(s, true);
      if (b) return b;
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

/**
 * Daily growth budget in CAPACITY units (residents / jobs) per zone. It scales sub-linearly
 * with city size (big cities grow faster, but not exponentially) and is spent by new
 * buildings AND level-ups, so a 480-resident tower costs as much as 80 cottages.
 */
const ZONE_SHARE = [0, 1, 0.4, 0.5];
function growBudget(S) {
  const t = X.tot;
  const rate = (9 + 0.42 * Math.sqrt(t.pop + (t.capC + t.capI) * 0.5)) * Math.max(0, 1 + (S.mods.growth || 0));
  for (let z = 1; z <= 3; z++) {
    const u = Math.max(0, S.demand[ZK[z]]) * rate * ZONE_SHARE[z];
    X.growRate[z] = u;
    X.growAcc[z] = Math.min(u * 3 + 1, X.growAcc[z] + u);
  }
}

function* growth(S, live) {
  const dem = S.demand;
  if (X.growAcc[1] <= 0 && X.growAcc[2] <= 0 && X.growAcc[3] <= 0) return;
  const N = S.N, perm = X.perm, zone = S.zone, bld = S.bld, road = S.road, flags = S.flags, rnd = X.rnd;
  const K = Math.ceil(N / 4);
  for (let k = 0; k < K; k++) {
    if (live && (k & 4095) === 4095) yield 'growth';
    const i = perm[X.permPos];
    if (++X.permPos >= N) X.permPos = 0;
    const code = zone[i];
    if (!code || bld[i] || road[i]) continue;
    const zt = code >> 2, den = code & 3;
    if (X.growAcc[zt] <= 0) continue;
    const fl = flags[i];
    if (!(fl & F.ACCESS) || !(fl & F.POWER)) continue;
    if (den >= 2 && !(fl & F.WATER)) continue;
    const d = dem[ZK[zt]];
    if (d <= 0.02) continue;
    // development clusters: lots next to existing buildings fill first, so blocks fill up
    // instead of scattering houses across every zoned field
    const x = i % S.W;
    let nb = 0;
    if (x > 0 && bld[i - 1]) nb++;
    if (x < S.W - 1 && bld[i + 1]) nb++;
    if (i >= S.W && bld[i - S.W]) nb++;
    if (i < N - S.W && bld[i + S.W]) nb++;
    const p = clamp(d * 1.5, 0.15, 1) * desirability(S, zt, i) * (0.3 + 0.35 * nb);
    if (rnd() >= p) continue;
    const nw = tryGrow(S, i, zt, den, d);
    if (nw) {
      X.growAcc[zt] -= nw.cap;
      X.unmet[zt] -= nw.cap;
    }
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

/** Was this fire started by a disaster (or did it spread from one)? Those stay silent here. */
const disasterFire = (b) => !!(b.simFireD || b.fireCause === 'disaster');

function burnDown(S, b) {
  // debris / dust / smoke and the collapse sound come from the particles & audio modules'
  // own 'bldRemove' handlers (reason 'fire'); this only does the bookkeeping
  const name = SIM.buildingName(b);
  const quiet = disasterFire(b);
  // today's totals were counted before the fire step: keep the stats exact (a save made now and
  // loaded again must show the same population)
  const t = X.tot;
  if (t && b.key === 'grow' && !b.abandoned) {
    const built = b.built >= 1 || b.simReplay;
    if (b.zt === 1) { t.pop -= b.pop; t.capR -= b.cap; if (built) t.capRBuilt -= b.cap; }
    else {
      t.jobsFilled -= b.pop;
      if (b.zt === 2) { t.capC -= b.cap; if (built) t.capCBuilt -= b.cap; }
      else { t.capI -= b.cap; if (built) t.capIBuilt -= b.cap; }
    }
  }
  toRubble(S, b, 'fire');
  if (quiet) return;
  const day = S.time.day;
  X.fireLog.push(day);
  while (X.fireLog.length && X.fireLog[0] < day - 30) X.fireLog.shift();
  X.fireLost++;
  X.fireLostName = name;
  if (X.fireLog.length >= 3 && day - X.lastFireNews > 60 && !S.demo) {
    X.lastFireNews = day;
    const text = `Massive blaze in ${SIM.districtName(b.x, b.z)}: ${X.fireLog.length} buildings lost this month. Residents demand more fire stations!`;
    if (VC.advisors && VC.advisors.pushNews) VC.advisors.pushNews(text);
    else VC.bus.emit('news', { text });
  }
}

/**
 * One aggregated fire toast at most every FIRE_TOAST_MS of real time: new fires and buildings lost
 * since the last one ("Fire at X!", "3 buildings on fire", "Maple Cottage burned down"). Fires
 * started by disasters are announced by the disaster card instead.
 */
const FIRE_TOAST_MS = 8000;
function fireNotice(S) {
  if (!X.fireNew && !X.fireLost) return;
  const now = performance.now();
  if (now - X.lastFireToast < FIRE_TOAST_MS) return;
  X.lastFireToast = now;
  let burning = 0;
  for (const id of X.burning) {
    const b = S.buildings.get(id);
    if (b && !disasterFire(b)) burning++;
  }
  let text, type = 'warn';
  if (X.fireLost) {
    type = 'bad';
    text = X.fireLost === 1 ? `<b>${esc(X.fireLostName)}</b> burned down!` : `${X.fireLost} buildings burned down!`;
    if (burning) text += ` ${burning} still on fire.`;
  } else if (burning <= 1 && X.fireNew === 1 && X.fireNewB) {
    text = `Fire at <b>${esc(SIM.buildingName(X.fireNewB))}</b>!`;
  } else if (burning > 0) text = `${burning} buildings on fire!`;
  X.fireNew = 0;
  X.fireNewB = null;
  X.fireLost = 0;
  X.fireLostName = '';
  if (text) toast(text, type, '🔥');
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
  // a disaster fire that spreads is still part of the disaster
  if (n && n !== b && !(n.fire > 0)) SIM.ignite(n, disasterFire(b) ? SPREAD_D : null);
}
const SPREAD_D = { disaster: true };

function fireStep(S) {
  if (!X.burning.size) return;
  const rnd = X.rnd, fmap = S.maps.fire;
  const wet = X.wx ? X.wx.wet : 0;
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
  const rnd = X.rnd;
  const clear = [];
  for (const b of S.buildings.values()) {
    if (b.key === 'rubble') {
      if (b.age > 180) clear.push(b);
      continue;
    }
    if (b.key !== 'grow' || b.abandoned || b.built < 1) continue;
    // wealth drifts with land value (industry: education)
    const tw = wealthFor(S, b.zt, b.simI);
    if (tw !== b.wealth) {
      b.simWealthCnt++;
      if (b.simWealthCnt >= 3 && rnd() < 0.4) {
        b.wealth += tw > b.wealth ? 1 : -1;
        b.simWealthCnt = 0;
        VC.world.changed(b);
      }
    } else b.simWealthCnt = 0;
  }
  X.selfEdit = true;
  for (const b of clear) VC.world.removeBuilding(b, 'cleared');
  X.selfEdit = false;
  if (X.abandonedMonth >= 3) toast(`${X.abandonedMonth} buildings were abandoned this month`, 'warn', '🏚️');
  X.abandonedMonth = 0;
  X.levelUpsMonth = X.levelUps;
  X.levelUps = 0;
  X.redevelopedLast = X.redevelopedMonth;
  X.redevelopedMonth = 0;
}

/* ------------------------------------------------------------------ */
/* shortages (edge-triggered toasts)                                     */
/* ------------------------------------------------------------------ */
function checkShortages(S) {
  const day = S.time.day;
  // a shortage is either a network that cannot serve everyone, or consumers with no plant at all
  const p = X.power.shortage || (X.power.supply <= 0 && X.power.demand > 2);
  const w = X.water.shortage || (X.water.supply <= 0 && X.water.demand > 2);
  if (p && !X.wasPowerShort && day - X.lastPowerToast > 45) {
    X.lastPowerToast = day;
    toast(X.power.supply > 0 ? 'Power shortage! Parts of the city are blacking out. Build more power plants.' : 'The city has no power! Build a power plant and connect it with roads or power lines.', 'bad', '⚡');
  }
  if (w && !X.wasWaterShort && day - X.lastWaterToast > 45) {
    X.lastWaterToast = day;
    const dark = X.water.unpoweredSources | 0;
    let text;
    if (dark > 0) text = `Water shortage! ${dark} water ${dark === 1 ? 'source has' : 'sources have'} no power — connect ${dark === 1 ? 'it' : 'them'} to the grid with a road or power line.`;
    else if (X.water.supply > 0) text = 'Water shortage! Taps are running dry. Build more pumps or towers.';
    else text = 'No water supply! Build a water tower or pump (pumps need power).';
    toast(text, 'bad', '💧');
  }
  X.wasPowerShort = p;
  X.wasWaterShort = w;
}

/* ------------------------------------------------------------------ */
/* one day                                                               */
/* ------------------------------------------------------------------ */
/**
 * One sim day as a generator. live = true (frame loop): yields between the day's phases and inside
 * the long loops so a big city's day can be spread over frames, and requests the heavy passes from the
 * job scheduler (speed-scaled cadence). live = false (tickDay): everything now, heavy passes
 * synchronously on fixed day phases (networks day%4==1 or dirty, maps day%4==2 or dirty, traffic day%8==3).
 */
function* dayGen(S, live) {
  const t0 = performance.now();
  const pc = X.dayClock, paused0 = pc.paused; // time spent between slices is not the day's work
  S.time.day++;
  const day = S.time.day;
  X.fxBudget = 8;
  let t = t0, pl = paused0;
  // section profiler: accumulated and max ms per section
  const lap = (k) => {
    const tn = performance.now(), d = tn - t - (pc.paused - pl);
    X.prof[k] += d;
    if (d > X.profMax[k]) X.profMax[k] = d;
    t = tn;
    pl = pc.paused;
  };
  refreshCity(S);
  if (!live) progressConstruction(S, 1); // the frame loop advances construction continuously
  if (live) {
    if (X.netDirty || day - X.netDay >= cadence(S, 'net')) X.want.net = true;
  } else if (X.netDirty || day % 4 === 1) {
    SIM.recalcNetworks();
    checkShortages(S);
    lap('net');
  }
  growBudget(S);
  yield* dailyBuildings(S, true, live);
  lap('bld');
  fireStep(S);
  updateStats(S);
  lap('misc');
  if (live) yield 'bld-end';
  yield* growth(S, live);
  lap('growth');
  if (live) {
    if (X.mapsDirty || day - X.mapsDay >= cadence(S, 'maps')) X.want.maps = true;
    if (SIM.computeTraffic && day - X.trafDay >= cadence(S, 'traffic')) X.want.traffic = true;
  } else {
    if (day % 4 === 2 || X.mapsDirty) {
      SIM.computeMaps();
      lap('maps');
    }
    if (day % 8 === 3 && SIM.computeTraffic) {
      SIM.computeTraffic();
      lap('traffic');
    }
  }
  if (day % 3 === 0) updateDemand(S, false);
  saveState(S);
  fireNotice(S);
  const ms = performance.now() - t0 - (pc.paused - paused0);
  X.days++;
  X.dayMs += ms;
  if (ms > X.dayMsMax) X.dayMsMax = ms;
  VC.bus.emit('day', day);
  if (day % C.DAYS_PER_MONTH === 0) {
    if (live) yield 'day-end'; // the month's bookkeeping (econ, advisors, ...) gets a slice of its own
    monthly(S);
    const month = Math.floor(day / C.DAYS_PER_MONTH) % 12;
    const year = C.START_YEAR + Math.floor(day / (C.DAYS_PER_MONTH * 12));
    VC.bus.emit('month', { month, year });
    if (month === 0) VC.bus.emit('year', year);
  }
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
      if (b.key === 'grow') {
        // joins the cached network on the next (periodic) recalc — no full rebuild needed
        if (X.joinQ) X.joinQ.push(b);
      } else if (b.key === 'rubble') {
        // rubble conducts nothing and needs nothing: no network work at all
      } else {
        // road access right away (coverage / staffing must not wait for the network solve)
        if (X.buildingRoad && X.accRoad) b.simRoad = X.buildingRoad(S, b);
        X.topoDirty = true;
        if (!X.selfEdit) {
          X.netDirty = true;
          if (b.key !== 'rubble') X.mapsDirty = true;
        }
      }
    });
    bus.on('bldRemove', (b) => {
      if (!X.ready) return;
      X.constructing.delete(b.id);
      X.burning.delete(b.id);
      // homes / shops / rubble: drop their footprint from the cached network (a split it may cause
      // is picked up by the next scheduled full rebuild); catalog buildings rebuild the topology
      if (b.key === 'grow' || b.key === 'rubble') X.softRemoved = true;
      else X.topoDirty = true;
      if (X.selfEdit) return;
      X.netDirty = true;
      if (b.key !== 'grow') X.mapsDirty = true;
    });
    bus.on('roadChange', () => { X.netDirty = X.topoDirty = true; });
    bus.on('dirty', (r) => {
      const S = VC.state;
      if (!X.ready || !S) return;
      if (X.plineChanged(S, r)) X.netDirty = X.topoDirty = true;
      if (X.heightChanged) {
        const v = X.terrVer;
        X.heightChanged(S, r);
        if (X.terrVer !== v) X.topoDirty = true; // road access does not cross water
      }
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
    X.topoDirty = true;
    X.joinQ = [];
    // staged work of the previous city is dropped; the heavy passes start their cadence today
    X.job = null;
    X.dayJob = null;
    X.hold = null;
    X.want = { net: false, maps: false, traffic: false };
    X.jobDone = {};
    X.netDay = X.mapsDay = X.trafDay = S.time.day;
    X.dayClock = { paused: 0, lastYield: 0 };
    X.lvPrev.set(S.maps.landValue); // crime's poverty input: this city's land value, not the last one's
    X.hCopy = null; // new terrain: rebuild static land value / water distance
    X.staticVer = -1;
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
    // persisted growth state (saved games continue exactly; new games get a small head start)
    const ss = S.simState;
    const saved = ss && Array.isArray(ss.growAcc) && ss.growAcc.length === 4 && ss.growAcc.every((v) => typeof v === 'number' && isFinite(v));
    X.permPos = saved && ss.permPos >= 0 && ss.permPos < N ? ss.permPos | 0 : 0;
    X.growAcc = saved ? ss.growAcc.slice() : [0, 12, 4, 6]; // a little head start so the first homes appear within days
    X.rAppeal = saved && typeof ss.rAppeal === 'number' && isFinite(ss.rAppeal) ? ss.rAppeal : 0.3;
    X.growRate = [0, 0, 0, 0];
    X.constructing = new Set();
    X.burning = new Set();
    X.pending = [];
    X.bk = [new Float64Array(9), new Float64Array(9), new Float64Array(9), new Float64Array(9)];
    X._burnArr = [];
    X.fireLog = [];
    X.fireNew = 0;
    X.fireNewB = null;
    X.fireLost = 0;
    X.fireLostName = '';
    X.lastFireToast = -1e9;
    X.lastFireNews = -999;
    X.lastPowerToast = X.lastWaterToast = -999;
    X.wasPowerShort = X.wasWaterShort = false;
    X.abandonedMonth = 0;
    X.levelUpsMonth = 0;
    X.levelUps = 0;
    X.redevelopedMonth = 0;
    X.redevelopedLast = 0;
    X.fill = 1;
    X.unemp = 0;
    X.unmet = [0, 150, 40, 80];
    X.cityEdu = 0;
    X.svcCov = 0;
    X.happyMod = S.mods.happiness || 0;
    X.happyAvg = S.stats.happiness || 0.6;
    X.fxBudget = 0;
    X.inUpdate = false;
    X.dayMs = 0;
    X.dayMsMax = 0;
    X.days = 0;
    X.netGap = 150;
    X.prof = { net: 0, bld: 0, misc: 0, growth: 0, maps: 0, traffic: 0 };
    X.profMax = { net: 0, bld: 0, misc: 0, growth: 0, maps: 0, traffic: 0 };
    X.factors = { R: [], C: [], I: [] };
    X.tot = newTot();
    for (const b of S.buildings.values()) initBuilding(S, b);
    X.ready = true;
    refreshCity(S);
    // full recompute so loaded games show correct flags, maps and stats immediately
    SIM.recalcNetworks(true);
    runSync(dailyBuildings(S, false, false));
    updateStats(S);
    if (SIM.computeTraffic) SIM.computeTraffic();
    SIM.computeMaps();
    runSync(dailyBuildings(S, false, false));
    updateStats(S);
    // explain the (saved) demand without moving it: loading must not change the game
    if (S.buildings.size) updateDemand(S, 'factors');
    else X.factors = { R: [{ label: 'Small-town appeal', value: 0.6 }], C: [{ label: 'Shoppers', value: 0.26 }], I: [{ label: 'External trade', value: 0.37 }] };
    saveState(S);
  },

  /**
   * Frame loop: turns rdt * speed into whole days (<= 8 per frame, backlog <= 2) and advances the running
   * day and then the running heavy pass within a per-frame budget (~4 ms at 60 fps, a quarter of the
   * frame on slow machines, <= 20 ms). A day that does not fit continues next frame.
   */
  update(dt, rdt) {
    const S = VC.state;
    if (!S || !X.ready) return;
    const t0 = performance.now();
    const budget = clamp((rdt || 0) * 250, 4, 20);
    // responsive network / coverage updates after edits (also while paused); the network gap adapts
    // to how long a pass takes, so big maps never spend more than ~1/4 of the time re-solving
    if (X.netDirty && t0 - (X.lastNet || 0) > (X.netGap || 150)) X.want.net = true;
    if (X.mapsDirty && !X.netDirty && t0 - (X.lastMaps || 0) > 600) X.want.maps = true; // maps read the networks' results
    fireNotice(S);
    // a sliced autosave snapshot (VC.save) holds the days so the city cannot change under it
    const H = X.hold, held = !!H && H.S === S && t0 < H.until;
    const sp = held ? 0 : C.SPEEDS[S.time.speed] || 0;
    X.inUpdate = true;
    try {
      if (sp) {
        const days = (rdt * sp) / C.DAY_SEC;
        progressConstruction(S, days);
        X.acc += days;
      }
      let n = 0;
      for (;;) {
        if (held) break;
        if (!X.dayJob) {
          if (!sp || X.acc < 1 || n >= 8) break;
          X.acc -= 1;
          n++;
          X.dayJob = dayGen(S, true);
        }
        if (!stepDay(budget - (performance.now() - t0))) break;
        if (performance.now() - t0 >= budget) break;
      }
      if (X.acc > 2) X.acc = 2; // never build up a backlog
      runJobs(S, Math.max(1, budget - (performance.now() - t0)));
    } finally {
      X.inUpdate = false;
    }
  },

  /**
   * Advances one day NOW, synchronously (VC.debug.run, tests): the heavy passes run on their fixed day
   * phases. The frame loop (update) runs the same day as a staged generator instead (see dayGen).
   */
  tickDay() {
    const S = VC.state;
    if (!S) return;
    if (!X.ready) SIM.reset(S);
    // a day the frame loop is still working on finishes first
    if (X.dayJob) {
      const g = X.dayJob;
      X.dayJob = null;
      X.dayClock.lastYield = 0;
      runSync(g);
    }
    runSync(dayGen(S, false));
  },

  /* ---------------- fires ---------------- */
  /**
   * Sets b on fire. opts.disaster (or b.fireCause === 'disaster'): part of a disaster — the disaster
   * card is its notification, the sim stays silent. Returns false if b cannot burn (parks without
   * staff, rubble, already burning).
   */
  ignite(b, opts) {
    if (typeof b === 'number') b = VC.world.get(b);
    if (!b || b.key === 'rubble' || b.fire > 0 || !VC.state || !VC.state.buildings.has(b.id)) return false;
    const def = defOf(b);
    if (def && def.group === 'parks' && !def.jobs) return false;
    b.fire = 0.05;
    b.simDispatched = false;
    b.simFireD = !!((opts && opts.disaster) || b.fireCause === 'disaster');
    X.burning && X.burning.add(b.id);
    VC.world.changed(b);
    // no sound here: the aggregated fire toast (fireNotice) is the one cue, and the audio
    // module's ambience voices burning buildings
    if (!b.simFireD) {
      X.fireNew = (X.fireNew || 0) + 1;
      X.fireNewB = b;
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
      L('ON FIRE', pct(Math.min(1, b.fire)) + ' burned', 'bad');
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
      // level-up hint: every gate tryLevelUp checks, so "Ready" really means ready
      if (b.level < 3 && !b.abandoned) {
        const next = b.level + 1;
        const need = [];
        if (!fullEnough(b)) need.push(b.zt === 1 ? 'more residents' : 'more workers');
        if (hs <= 0.65) need.push('happier');
        if (b.zt === 3) { if (Math.max(m.edu[i], X.cityEdu * 255) < EDU_REQ[next]) need.push('better education'); }
        else if (m.landValue[i] < LV_REQ[b.zt][next]) need.push('higher land value');
        if (!b.watered) need.push('water');
        if (!b.powered) need.push('power');
        if (S.demand[zk] <= 0) need.push(`more ${VC.ZONES[b.zt].name.toLowerCase()} demand`);
        let txt = need.length ? 'Needs ' + need.join(', ') : 'Ready to upgrade';
        if (!need.length && X.growAcc[b.zt] <= 0) txt = 'Ready — waiting for the city to grow';
        L('Next level', txt, need.length ? null : 'good');
      }
      // repainted with another density: the lot is waiting to be redeveloped
      const zc = S.zone[i];
      if (zc && zc >> 2 === b.zt && (zc & 3) !== b.den && !b.abandoned) {
        const up = (zc & 3) > b.den;
        L('Rezoned', `${up ? 'Upzoning' : 'Downzoning'} to ${VC.DENSITY[zc & 3].toLowerCase()} density` + (up && S.demand[zk] <= 0.02 ? ' (waits for demand)' : ''), 'warn');
      }
      if (S.demand[zk] < -0.3) problems.push(`Low ${VC.ZONES[b.zt].name.toLowerCase()} demand`);
      if (b.zt === 1 && b.simCommute < 0 && b.built >= 1) problems.push('No road route to any jobs');
      if (b.zt === 1 && b.simCommute > 30) problems.push('Very long commute — build avenues or transit');
      if (b.zt !== 1 && X.fill < 0.7) problems.push('Not enough workers');
      if (b.zt === 2 && S.demand.C < -0.3) problems.push('Not enough customers');
      if (b.simGarbage > 0.4) problems.push('Garbage piling up — no garbage pickup');
      if (X.taxW[b.zt] && X.taxW[b.zt][b.wealth | 0] < -0.3) problems.push('Taxes too high');
    } else if (def) {
      subtitle = `${subtitle}${def.dept ? ' · ' + ((VC.DEPARTMENTS.find((d) => d.key === def.dept) || {}).name || '') : ''}`;
      const closed = closedVenue(S, def);
      const access = X.accessMul(b, def);
      if (closed) {
        const pol = VC.POLICY[def.requiresPolicy];
        L('Status', 'Closed', 'bad');
        problems.push(`Closed — requires the ${pol ? pol.name : def.requiresPolicy} policy`);
      }
      if (def.power) {
        const out = X.powerOut(S, b);
        L('Output', `${Math.round(out)} MW` + (b.key === 'wind_turbine' ? ' (wind)' : b.key === 'solar_farm' ? ' (sun)' : ''), 'good');
        L('City power', `${VC.fmt.num(S.stats.powerDemand)} / ${VC.fmt.num(S.stats.powerSupply)} MW used`, X.power.shortage ? 'bad' : null);
      }
      if (def.water) {
        const out = X.waterOut(S, b);
        L('Output', `${Math.round(out)} kL` + (out <= 0 && b.built >= 1 ? ' (needs power)' : ''), out > 0 ? 'good' : 'bad');
        L('City water', `${VC.fmt.num(S.stats.waterDemand)} / ${VC.fmt.num(S.stats.waterSupply)} kL used`, X.water.shortage ? 'bad' : null);
        if (out <= 0 && b.built >= 1 && !b.powered) problems.push('No power — pumps need electricity (connect a road or power line)');
      }
      if (def.jobs) L('Staff', `${VC.fmt.num(b.simJobs != null ? b.simJobs : 0)} / ${def.jobs}`);
      if (def.housing) L('Residents', `${VC.fmt.num(b.pop)} / ${VC.fmt.num(def.housing)}`);
      if (def.cover) {
        const capF = def.capacity && b.simCapF > 0 ? b.simCapF : 1;
        const eff = X.eff(def.dept) * (b.powered ? 1 : 0.4) * access * capF;
        for (const svc in def.cover) {
          const s = VC.SERVICES.find((q) => q.key === svc);
          L((s ? s.name : svc) + ' radius', `${Math.round(def.cover[svc] * (0.45 + 0.55 * Math.min(eff, 1.3)))} tiles`);
        }
        if (def.capacity) {
          const cap = Math.round(def.capacity * clamp(X.eff(def.dept), 0.3, 1.3));
          L('Serves', `${VC.fmt.num(b.simLoad || 0)} / ${VC.fmt.num(cap)} residents`, (b.simLoad || 0) > cap ? 'warn' : null);
          if ((b.simLoad || 0) > cap * 1.15) problems.push('Overloaded — too many residents for one building: build another nearby');
        }
        L('Effectiveness', pct(eff), eff < 0.7 ? 'warn' : 'good');
        if (X.eff(def.dept) < 0.6) problems.push('Underfunded — raise the budget');
      }
      if (def.tourism) L('Tourism', closed ? 'Closed' : '+' + def.tourism, closed ? 'bad' : null);
      if (def.income) L('Income', closed ? 'Closed' : VC.fmt.money(def.income) + '/mo', closed ? 'bad' : 'good');
      if (def.happy) L('City happiness', '+' + (def.happy * 100).toFixed(1) + '%', 'good');
      if (def.pollution) L('Pollution', lvl(def.pollution), 'bad');
      if (access < 1) problems.push(`No road access — staff and vehicles can't reach it (works at ${Math.round(access * 100)}%)`);
    }
    // shared lines
    const needP = b.simNeedP, needW = b.simNeedW;
    if (needP) L('Power', b.powered ? 'Connected' : 'No power', b.powered ? 'good' : 'bad');
    if (needW) L('Water', b.watered ? 'Connected' : 'No water', b.watered ? 'good' : b.key === 'grow' && b.den === 1 ? 'warn' : 'bad');
    if (needP && !b.powered) problems.push(X.power.shortage && b.simNetP ? 'Power shortage — build more power plants' : 'Not connected to the power grid');
    if (needW && !b.watered) {
      const dark = X.water.unpoweredSources | 0;
      problems.push(X.water.shortage && b.simNetW ? (dark ? `Water shortage — ${dark} pump${dark > 1 ? 's have' : ' has'} no power` : 'Water shortage — build more pumps') : 'No water service — connect with roads to a pump or tower');
    }
    if (b.key === 'grow' || b.key === 'arcology') {
      L('Land value', VC.fmt.money(m.landValue[i] * 40) + ' /tile', m.landValue[i] > 150 ? 'good' : m.landValue[i] < 60 ? 'warn' : null);
      L('Pollution', lvl(m.pollution[i]), m.pollution[i] > 120 ? 'bad' : null);
      L('Crime', lvl(m.crime[i]), m.crime[i] > 120 ? 'bad' : null);
      if (m.noise[i] > 60) L('Noise', lvl(m.noise[i]), m.noise[i] > 140 ? 'warn' : null);
      if (b.simRoad >= 0) {
        const cg = SIM.trafficAt ? SIM.trafficAt(b.simRoad % S.W, (b.simRoad / S.W) | 0) : 0;
        L('Street traffic', cg > 1 ? 'Jammed' : cg > 0.6 ? 'Busy' : 'Light', cg > 1 ? 'bad' : cg > 0.6 ? 'warn' : null);
        if (cg > 1) problems.push('Jammed street — build avenues, alternative routes or transit');
      }
      if (m.pollution[i] > 120) problems.push('Heavy air pollution');
      if (m.crime[i] > 120) problems.push('High crime — build police stations');
      // industry burns 2x as often: flag it more readily
      if (b.key === 'grow' && m.fire[i] < (b.zt === 3 ? 70 : 40)) problems.push(b.zt === 3 ? 'No fire protection — factories burn easily' : 'No fire protection');
    }
    if (b.simRoad < 0 && b.key === 'grow') problems.push('No road access');

    L('Age', b.age >= 360 ? Math.floor(b.age / 360) + ' yr' : Math.floor((b.age || 0) / 30) + ' mo');
    return { name, subtitle, lines, problems, factors };
  },

  demandFactors() {
    return X.factors || { R: [], C: [], I: [] };
  },

  /**
   * {supply, demand (MW, whole city), plants:[{b, output}], served (MW delivered), connectedDemand,
   *  shortage (some network cannot serve all its load), deficit (demand > supply), unpowered (buildings), networks}
   */
  powerInfo() {
    const p = X.power || { supply: 0, demand: 0, plants: [], served: 0 };
    return {
      supply: p.supply, demand: p.demand, plants: p.plants.slice(), served: p.served,
      connectedDemand: p.connectedDemand, shortage: !!p.shortage, deficit: p.demand > p.supply, unpowered: p.unpowered | 0, networks: p.networks | 0,
    };
  },
  /** Same shape as powerInfo with sources:[{b, output}] (kL), unwatered and unpoweredSources (pumps with no power). */
  waterInfo() {
    const p = X.water || { supply: 0, demand: 0, sources: [], served: 0 };
    return {
      supply: p.supply, demand: p.demand, sources: p.sources.slice(), served: p.served,
      connectedDemand: p.connectedDemand, shortage: !!p.shortage, deficit: p.demand > p.supply, unwatered: p.unwatered | 0, networks: p.networks | 0,
      unpoweredSources: p.unpoweredSources | 0,
    };
  },

  /**
   * {police:{coverage, buildings, funding, effectiveness, name, icon, jobs, capacity, load, usage,
   *  overloaded, noAccess}, …}. coverage = share of residents covered; capacity = residents the
   * service's buildings can serve at the current funding; load = residents inside their areas;
   * usage = population / capacity (> 1: the city needs more buildings); overloaded = buildings
   * serving more than their capacity.
   */
  serviceStats() {
    const S = VC.state;
    const res = {};
    if (!S) return res;
    const covered = {};
    for (const s of VC.SERVICES) {
      res[s.key] = {
        name: s.name, icon: s.icon, coverage: 0, buildings: 0, funding: S.budget[s.dept] != null ? S.budget[s.dept] : 1, effectiveness: X.eff(s.dept), jobs: 0,
        capacity: 0, load: 0, usage: 0, overloaded: 0, noAccess: 0,
      };
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
        if (!def || !def.cover || b.built < 1) continue;
        for (const k in def.cover) {
          const r = res[k];
          if (!r) continue;
          r.buildings++;
          r.jobs += def.jobs || 0;
          if (X.accessMul(b, def) < 1) r.noAccess++;
          if (def.capacity) {
            const cap = def.capacity * clamp(X.eff(def.dept), 0.3, 1.3);
            r.capacity += cap;
            r.load += b.simLoad || 0;
            if ((b.simLoad || 0) > cap * 1.15) r.overloaded++;
          }
        }
      }
    }
    for (const s of VC.SERVICES) {
      const r = res[s.key];
      r.coverage = pop > 0 ? covered[s.key] / pop : 0;
      r.capacity = Math.round(r.capacity);
      r.usage = r.capacity > 0 ? pop / r.capacity : 0;
    }
    return res;
  },

  /** Sim weather for today: {type: clear|cloudy|rain|storm|snow, cloud, wind, wet 0..1, windDir}. */
  weather() {
    const w = X.wx || (VC.state ? simWeather(VC.state) : null);
    return w ? { type: w.type, cloud: w.cloud, wind: w.wind, wet: w.wet, windDir: w.windDir } : { type: 'clear', cloud: 0.2, wind: 0.3, wet: 0, windDir: 0.6 };
  },
  /** Does a catalog building (key) need a street/avenue at the door to work fully? */
  needsRoadAccess(key) {
    return X.needsAccess(VC.BLD[key]);
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
    X.slices = {};
    X.prof = { net: 0, bld: 0, misc: 0, growth: 0, maps: 0, traffic: 0 };
    X.profMax = { net: 0, bld: 0, misc: 0, growth: 0, maps: 0, traffic: 0 };
  },
  perf() {
    return {
      netMs: +(X.netMs || 0).toFixed(2), mapsMs: +(X.mapsMs || 0).toFixed(2), trafficMs: +(X.trafficMs || 0).toFixed(2),
      dayAvgMs: X.days ? +(X.dayMs / X.days).toFixed(3) : 0, dayMaxMs: +(X.dayMsMax || 0).toFixed(2), days: X.days,
      perDay: Object.fromEntries(Object.entries(X.prof || {}).map(([k, v]) => [k, +(v / Math.max(1, X.days)).toFixed(3)])),
      maxMs: Object.fromEntries(Object.entries(X.profMax || {}).map(([k, v]) => [k, +v.toFixed(2)])),
      job: X.job ? X.job.kind : null, jobsDone: Object.assign({}, X.jobDone), dayPending: !!X.dayJob, slices: Object.fromEntries(Object.entries(X.slices || {}).map(([k, m]) => [k, Object.fromEntries(Object.entries(m).map(([t, e]) => [t, [e[0], +(e[1] / e[0]).toFixed(2), +e[2].toFixed(1)]]))])),
    };
  },
});
// fallback if names.js is missing
if (!SIM.buildingName) SIM.buildingName = (b) => (b ? (b.key === 'grow' ? (VC.ZONES[b.zt] || {}).name + ' building' : (VC.BLD[b.key] || {}).name || b.key) : '');
if (!SIM.districtName) SIM.districtName = () => 'Downtown';
X.dailyBuildings = (S, sim) => runSync(dailyBuildings(S, sim, false)); // exposed for profiling tests
