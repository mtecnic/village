/*
 * VOXELPOLIS — Mayor's Goals (VC.goals): 2-3 live objectives generated from the city's situation and
 * progression (next population milestone, the biggest problem from VC.sim.issues(), a missing service
 * from VC.sim.serviceStats(), an affordable landmark, a negative budget, low happiness, parks near
 * homes, jobs, denser zones, tourism, clean power…). Each goal has a title, a "why", a live progress
 * value 0..1 (+ a short progress text), a small reward (cash scaled to the city size, or a temporary
 * modifier via VC.econ.addTempMod) and a "Show me" focus (camera / overlay / panel / palette / tool).
 *
 * FLOW  generate (one goal at a time, a few game days apart) -> live progress (evaluated at most twice a
 *   second of real time, and only when a day passed or the city changed) -> complete (g.done, bus
 *   'goalDone' {goal}; the HUD celebrates: toast + confetti + sfx) -> claim (reward granted, bus
 *   'goalClaimed' {goal}; auto-claimed silently once it has waited AUTO_CLAIM_DAYS game days AND the
 *   goals card has shown it for AUTO_CLAIM_SEC real seconds — g.shown, counted by ui/hud_goals.js — so a
 *   fast-forwarded city still gets to see the gold Claim button) -> a new goal after NEXT_DAYS.
 *   An open goal that has not made progress for STALE_DAYS rotates out (swapped for a fresh one, bus
 *   'goalRotated' {goal, next}). Nothing happens in the title-screen demo (S.demo) or while the tutorial
 *   runs (VC.hud.tutorialStep()).
 *
 * POPULATION goals aim at round numbers BETWEEN the milestones (POP_STEPS), never at a milestone itself:
 *   reaching a milestone is already celebrated by the advisors' banner; none while the population has
 *   stalled (under 2% growth in a year, or no room left). Problem goals (power, water, abandoned
 *   buildings) keep their title's count live. Cash rewards scale with the city (cash()) with a floor of
 *   about a month of a small town's income, x VC.DIFFICULTY[..].rewardMul. Ledger category 'goal'.
 * ANTI-FARMING: problem kinds (K.persist) only become goals once the problem has existed for that many
 *   days (G.seen, checked every PROBLEM_EVERY days); a swap never draws a 'fix' goal; a fixed problem
 *   must stay fixed for K.hold days before the goal completes (progress shows 99% "hold it"); the budget
 *   goal needs 2 of the last 3 months in the red and pays at most 1.5x the average deficit; 'Save up'
 *   does not count money borrowed since the goal started. (Undoing the build that completed a goal is
 *   refused by VC.actions.) Stale rotations back a kind off (G.stale): 480, 960 … days, optional kinds
 *   (trees, landmark) never return after two.
 *
 * STATE (plain JSON, saved with the game): S.goals = {
 *   active: [{id, kind, cat, title, desc, icon, target, base, cur, progress 0..1, text, unit,
 *             reward: {money?, mods?, days?, label?, text (short), long}, focus: {panel?|group?|tool?|overlay?|locate?|x,z},
 *             day, done?, doneDay?, shown? (real s the completed goal was on screen), best?, lastProg?
 *             (best progress so far and the day it was reached), meta?}],
 *   done: [ids] (capped), log: [{id, kind, title, icon, day}] (last 30), seq, next (day the next goal may
 *   appear), cool: {kind: day} (per-kind cooldowns), count (goals completed), rotDay (last stale-goal
 *   rotation), seen: {kind: day the problem was first seen}, stale: {kind: stale rotations}, v }
 *   (goals also carry holdSince while a fixed problem is being held)
 *
 * API  list() -> active goals (live objects, read-only for callers), claim(id) -> bool, refresh() (debug:
 *   evaluate + fill every free slot now), swap(id) (replace a goal; its kind cools down), focusOf(id) ->
 *   {x?, z?, dist?, panel?, group?, tool?, overlay?} (live location for "Show me"), add(kind) (debug),
 *   rewardText(reward) / rewardLong(reward), KINDS. Bus: 'goalsChanged' (structure changed), 'goalDone' {goal},
 *   'goalClaimed' {goal}.
 *
 * LIFECYCLE  init() (bus listeners, once), reset(S) (creates / migrates S.goals), update(dt, rdt) (cheap:
 *   a timer check per frame). If main.js does not list 'goals' in VC.MODULE_ORDER, this module inserts
 *   itself after 'advisors' when the game boots so main drives it like any other module.
 */
const M = VC.M, C = VC.C;
const MAX_ACTIVE = 3;
const EVAL_SEC = 0.5; // real seconds between progress evaluations
const NEXT_DAYS = 4; // game days between a claim / swap and the next goal
const FILL_DAYS = 1; // game days between goals while the card is filling up
const FIRST_DAYS = 3; // a new city gets its first goal after this many days
const AUTO_CLAIM_DAYS = 30; // unclaimed completed goals are claimed automatically after this ...
const AUTO_CLAIM_SEC = 15; // ... once the card has also shown them this long (real seconds, see hud_goals.js)
const STALE_DAYS = 150; // an open goal without any progress for this long rotates out …
const ROTATE_GAP = 30; // … one at a time, at least this many days apart
const CASH_FLOOR = 1000; // cash rewards never go below this x the goal's multiplier (starter goals: $800)
const PROBLEM_EVERY = 5; // days between checks of how long each city problem has existed (G.seen)
const HOLD_DAYS = 10; // a fixed problem must stay fixed this long before its goal completes
/** Population goal targets: round numbers between the milestones (never a milestone's own number). */
const POP_STEPS = [100, 150, 400, 600, 800, 1500, 2000, 2500, 4000, 5000, 7500, 12500, 15000, 20000, 30000, 35000, 40000, 60000, 75000, 125000, 150000, 175000, 250000, 300000, 350000, 450000, 500000, 750000, 1000000];
const DONE_CAP = 100, LOG_CAP = 30;
const ONCE = 1e9; // cooldown for one-time goals

let rnd = M.rng(1);
let acc = 0, lastEvalDay = -1, dirty = true, inited = false;

const num = (v) => VC.fmt.num(v);
const money = (v) => VC.fmt.money(v);
const pct = (v) => Math.round((v || 0) * 100) + '%';
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
/** Rounds to two significant digits (1,234 -> 1,200; 56,789 -> 57,000). */
function nice(v) {
  const a = Math.abs(v);
  if (a < 100) return Math.round(v / 10) * 10;
  const p = Math.pow(10, Math.floor(Math.log10(a)) - 1);
  return Math.round(v / p) * p;
}
function niceUp(v) {
  const a = Math.abs(v);
  if (a < 100) return Math.ceil(v / 10) * 10;
  const p = Math.pow(10, Math.floor(Math.log10(a)) - 1);
  return Math.ceil(v / p) * p;
}
const S_ = () => VC.state;
const tutorialOn = () => !!(VC.hud && VC.hud.tutorialStep && VC.hud.tutorialStep() >= 0);
const unlocked = (key) => { try { return VC.world.isUnlocked(key); } catch (e) { return true; } };
const bldName = (key) => (VC.BLD[key] ? VC.BLD[key].name : key);
const debtNow = () => { try { return (VC.econ && VC.econ.debt && VC.econ.debt()) || 0; } catch (e) { return 0; } };

/* ------------------------------------------------------------------ */
/* evaluation context: cheap fields up front, heavy ones lazily, once   */
/* per evaluation (issues() / serviceStats() / one pass over buildings) */
/* ------------------------------------------------------------------ */
const cx = { S: null, day: 0, pop: 0, peak: 0, money: 0, net: 0, st: null, _iss: null, _svc: null, _cnt: false, _trees: -1, _roads: -1, _zones: -1, _clean: -1 };
const cnt = {
  grow: 0, den2: 0, den3: 0, lvl3: 0, parks: 0, power: 0, water: 0, abandoned: 0,
  unpow: 0, unwat: 0, aband: 0, // ids of one unpowered / unwatered / abandoned building (for "Show me")
  byKey: new Map(), built: new Map(),
};
function prep(S) {
  cx.S = S;
  cx.day = S.time.day;
  cx.st = S.stats || {};
  cx.pop = cx.st.pop || 0;
  cx.peak = S.peakPop || 0;
  cx.money = S.money || 0;
  cx.net = cx.st.net || 0;
  cx._iss = null;
  cx._svc = null;
  cx._cnt = false;
  cx._trees = cx._roads = cx._zones = cx._clean = -1;
  return cx;
}
function iss() {
  if (!cx._iss) {
    let o = null;
    try { o = VC.sim && VC.sim.issues ? VC.sim.issues() : null; } catch (e) { o = null; }
    cx._iss = o || {};
  }
  return cx._iss;
}
function svc() {
  if (!cx._svc) {
    let o = null;
    try { o = VC.sim && VC.sim.serviceStats ? VC.sim.serviceStats() : null; } catch (e) { o = null; }
    cx._svc = o || {};
  }
  return cx._svc;
}
function counts() {
  if (cx._cnt) return cnt;
  cx._cnt = true;
  cnt.grow = cnt.den2 = cnt.den3 = cnt.lvl3 = cnt.parks = cnt.power = cnt.water = cnt.abandoned = 0;
  cnt.unpow = cnt.unwat = cnt.aband = 0;
  cnt.byKey.clear();
  cnt.built.clear();
  for (const b of cx.S.buildings.values()) {
    if (b.key === 'rubble') continue;
    const done = b.built >= 1;
    if (done && b.simNeedP && !b.powered && !cnt.unpow) cnt.unpow = b.id;
    if (done && b.simNeedW && !b.watered && !cnt.unwat) cnt.unwat = b.id;
    if (b.key === 'grow') {
      if (b.abandoned) {
        cnt.abandoned++;
        if (!cnt.aband) cnt.aband = b.id;
        continue;
      }
      cnt.grow++;
      if (b.den === 2) cnt.den2++;
      else if (b.den === 3) cnt.den3++;
      if (b.level >= 3) cnt.lvl3++;
      continue;
    }
    const def = VC.BLD[b.key];
    if (!def) continue;
    cnt.byKey.set(b.key, (cnt.byKey.get(b.key) || 0) + 1);
    if (done) cnt.built.set(b.key, (cnt.built.get(b.key) || 0) + 1);
    if (def.power > 0 && b.key !== 'incinerator') cnt.power++;
    if (def.water > 0) cnt.water++;
    if (def.group === 'parks' && def.cover && def.cover.park) cnt.parks++;
  }
  return cnt;
}
/** Tiles with trees / roads / zones (O(N), only computed for goals that need them). */
function tileCount(layer) {
  const a = cx.S[layer];
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i]) n++;
  return n;
}
function trees() { if (cx._trees < 0) cx._trees = tileCount('trees'); return cx._trees; }
function roads() { if (cx._roads < 0) cx._roads = tileCount('road'); return cx._roads; }
function zones() { if (cx._zones < 0) cx._zones = tileCount('zone'); return cx._zones; }
const CLEAN = { wind_turbine: 1, solar_farm: 1, nuclear_plant: 1, fusion_plant: 1 };
/** Share of the power supply coming from clean plants (0..1). */
function cleanShare() {
  if (cx._clean >= 0) return cx._clean;
  let tot = 0, clean = 0;
  try {
    const p = VC.sim.powerInfo();
    for (const e of p.plants || []) {
      const o = +e.output || 0;
      tot += o;
      if (e.b && CLEAN[e.b.key]) clean += o;
    }
  } catch (e) { /* no sim */ }
  cx._clean = tot > 0 ? clean / tot : 0;
  return cx._clean;
}
/** Difficulty multiplier for cash rewards (VC.DIFFICULTY[..].rewardMul: easy 1.2, normal 1, hard 0.8). */
function rewardMul(S) {
  const d = S && VC.DIFFICULTY && VC.DIFFICULTY[S.difficulty];
  return d && typeof d.rewardMul === 'number' ? d.rewardMul : 1;
}
/**
 * Cash reward scaled to the city size (x mul, x difficulty), with a floor for young towns (about one
 * month of a small town's income); two significant digits.
 */
function cash(mul) {
  mul = mul || 1;
  return nice(Math.max(M.clamp(300 + Math.max(cx.pop, cx.peak * 0.8) * 0.3, 500, 40000), CASH_FLOOR) * mul * rewardMul(cx.S));
}
function nextMilestone() {
  const L = VC.MILESTONES || [];
  for (let i = 0; i < L.length; i++) if (L[i].pop > cx.peak) return L[i];
  return null;
}
/** Next population target: the first POP_STEPS entry comfortably above today's peak (never a milestone). */
function popTarget(c) {
  const base = Math.max(c.pop, c.peak);
  const isMs = (v) => (VC.MILESTONES || []).some((m) => m.pop === v);
  // (big cities grow slowly: a smaller step keeps the goal reachable)
  const step = base >= 100000 ? 1.08 : 1.15;
  for (const v of POP_STEPS) if (v >= base * step && v - base >= 50 && !isMs(v)) return v;
  let t = niceUp(Math.max(1000, base * 1.4));
  while (isMs(t)) t = niceUp(t * 1.1);
  return t;
}

/* ------------------------------------------------------------------ */
/* goal kinds                                                            */
/* ------------------------------------------------------------------ */
/*
 * Each kind: cat ('grow' | 'fix' | 'build'), score(c) -> priority (0 = not now; >= 8 urgent),
 * make(c) -> goal fields {title, desc, icon, target, base?, unit, focus, reward, meta?},
 * cur(c, g) -> current value, prog(c, g, cur) -> 0..1, text(g, cur)? (default from unit),
 * cool: days before the kind may come back after completion (ONCE = never).
 */
const KINDS = {};

KINDS.first_roads = {
  cat: 'fix', cool: ONCE,
  score: (c) => (roads() < 10 ? 9 : 0),
  make: (c) => ({ title: 'Lay down your first roads', desc: 'Every lot needs a street within 3 tiles. Open Roads and drag across the land.', icon: '🛣️', target: 30, base: 0, unit: 'num', focus: { group: 'roads', tool: 'road_street' }, reward: { money: cash(0.8) } }),
  cur: () => roads(),
  prog: (c, g, v) => v / g.target,
};
KINDS.first_zones = {
  cat: 'fix', cool: ONCE,
  score: (c) => (roads() >= 10 && zones() < 30 ? 8.5 : 0),
  make: (c) => ({ title: 'Zone land for homes and jobs', desc: 'Paint residential, commercial and industrial zones along your roads — buildings grow there by themselves.', icon: '🏘️', target: 60, base: 0, unit: 'num', focus: { group: 'zones' }, reward: { money: cash(0.8) } }),
  cur: () => zones(),
  prog: (c, g, v) => v / g.target,
};
KINDS.first_power = {
  cat: 'fix', cool: ONCE,
  score: (c) => (counts().power === 0 && (cnt.grow > 0 || zones() >= 10) ? 10 : 0),
  make: (c) => ({ title: 'Power up the town', desc: 'Nothing grows without electricity. Build a power plant next to a road — wind turbines are cheap and clean.', icon: '⚡', target: 1, base: 0, unit: 'flag', focus: { group: 'power', tool: 'bld:wind_turbine' }, reward: { money: cash(0.6) } }),
  cur: () => counts().power,
  prog: (c, g, v) => (v > 0 ? 1 : 0),
};
KINDS.first_water = {
  cat: 'fix', cool: ONCE,
  score: (c) => (counts().power > 0 && cnt.water === 0 && (c.pop >= 120 || c.peak >= 200) ? 7.5 : 0),
  make: (c) => ({ title: 'Turn on the taps', desc: 'Medium and high density need running water. Place a water pump by a river or lake, or a water tower beside a road.', icon: '💧', target: 1, base: 0, unit: 'flag', focus: { group: 'water' }, reward: { money: cash(0.6) } }),
  cur: () => counts().water,
  prog: (c, g, v) => (v > 0 ? 1 : 0),
};
/** Population has stopped growing (under 2% in the last year) or there is no room left to grow. */
function popStalled(c) {
  const h = c.S.history && c.S.history.pop;
  if (h && h.length >= 12 && h[h.length - 1] < h[h.length - 12] * 1.02) return true;
  return c.pop >= 5000 && (iss().zonedEmpty || 0) - (iss().zonedNoAccess || 0) < 8;
}
KINDS.pop = {
  cat: 'grow', cool: 0,
  score: (c) => (roads() >= 10 && !popStalled(c) ? 3 : 0),
  make(c) {
    // a round number between the milestones: the milestone itself has its own banner (no double party)
    const target = popTarget(c);
    const m = nextMilestone();
    let why = 'The sky is the limit!';
    if (m && m.pop < target) why = `On the way you become ${/^[AEIOU]/.test(m.name) ? 'an' : 'a'} ${m.name}${m.reward ? ' (+' + money(m.reward) + ' state grant)' : ''}.`;
    else if (m) why = `Next up: ${m.name} at ${num(m.pop)} citizens${m.reward ? ' (+' + money(m.reward) + ' state grant)' : ''}.`;
    return { title: `Grow to ${num(target)} citizens`, desc: why + ' Zone homes with jobs and shops nearby.', icon: '👥', target, base: 0, unit: 'num', focus: { panel: 'population' }, reward: { money: cash(1) } };
  },
  cur: (c) => c.pop,
  prog: (c, g, v) => v / g.target,
};
KINDS.jobs = {
  cat: 'grow', cool: 180,
  score: (c) => (c.pop >= 300 && (c.st.unemployment || 0) > 0.1 ? 4 + (c.st.unemployment || 0) * 10 : 0),
  make(c) {
    const jobs = c.st.jobs || 0, workers = c.st.workers || c.pop * 0.5;
    const target = niceUp(Math.max(jobs + 20, jobs + (workers - jobs) * 0.7));
    return { title: `Reach ${num(target)} jobs`, desc: `${pct(c.st.unemployment)} of workers can't find a job. Zone commercial and industrial land near homes.`, icon: '💼', target, base: jobs, unit: 'num', focus: { group: 'zones' }, reward: { money: cash(1) } };
  },
  cur: (c) => c.st.jobs || 0,
  prog: (c, g, v) => (v - g.base) / Math.max(1, g.target - g.base),
};
KINDS.density_mid = {
  cat: 'grow', cool: 360,
  score: (c) => ((c.S.sandbox || c.peak >= VC.DENSITY_UNLOCK[2]) && c.pop >= 600 && counts().den2 < 12 && cnt.water > 0 ? 2.5 : 0),
  make: (c) => ({ title: 'Grow 6 medium-density buildings', desc: 'Paint medium-density zones where there is water. Denser lots house more people on the same land.', icon: '🏢', target: counts().den2 + 6, base: cnt.den2, unit: 'step', focus: { group: 'zones' }, reward: { mods: { demandR: 0.08, demandC: 0.05 }, days: 120, label: 'Developer interest' } }),
  cur: () => counts().den2,
  prog: (c, g, v) => (v - g.base) / Math.max(1, g.target - g.base),
  text: (g, v) => `${Math.max(0, v - g.base)} / ${g.target - g.base}`,
};
KINDS.density_high = {
  cat: 'grow', cool: 360,
  score: (c) => ((c.S.sandbox || c.peak >= VC.DENSITY_UNLOCK[3]) && counts().den3 < 12 && cnt.water > 0 ? 2.5 : 0),
  make: (c) => ({ title: 'Raise 4 high-rises', desc: 'High-density zones grow towers — they need water, power and plenty of demand.', icon: '🏙️', target: counts().den3 + 4, base: cnt.den3, unit: 'step', focus: { group: 'zones' }, reward: { money: cash(1.2) } }),
  cur: () => counts().den3,
  prog: (c, g, v) => (v - g.base) / Math.max(1, g.target - g.base),
  text: (g, v) => `${Math.max(0, v - g.base)} / ${g.target - g.base}`,
};
KINDS.level3 = {
  cat: 'grow', cool: 240,
  score: (c) => (c.pop >= 2500 && counts().grow >= 40 ? 2 : 0),
  make: (c) => ({ title: 'Grow 8 upscale buildings', desc: 'Buildings reach level 3 with high land value: parks, schools, landmarks and clean air nearby.', icon: '✨', target: counts().lvl3 + 8, base: cnt.lvl3, unit: 'step', focus: { overlay: 'landValue' }, reward: { money: cash(1.2) } }),
  cur: () => counts().lvl3,
  prog: (c, g, v) => (v - g.base) / Math.max(1, g.target - g.base),
  text: (g, v) => `${Math.max(0, v - g.base)} / ${g.target - g.base}`,
};
KINDS.tourism = {
  cat: 'grow', cool: 360, optional: true,
  score: (c) => (c.pop >= 4000 ? 2 : 0),
  make(c) {
    const t = c.st.tourism || 0;
    const target = niceUp(Math.max(60, t * 1.25 + 30));
    return { title: `Attract ${num(target)} tourists`, desc: 'Landmarks, big parks and a tourism campaign bring visitors — and their wallets.', icon: '📸', target, base: t, unit: 'num', focus: { group: 'landmarks' }, reward: { money: cash(1.2) } };
  },
  cur: (c) => c.st.tourism || 0,
  prog: (c, g, v) => (v - g.base) / Math.max(1, g.target - g.base),
};
KINDS.treasury = {
  cat: 'grow', cool: 240,
  score: (c) => (!c.S.sandbox && c.pop >= 500 && c.net > 0 && c.money < cash(12) ? 1.5 : 0),
  make(c) {
    const target = niceUp(c.money + Math.max(5000, c.net * 4));
    return { title: `Save up ${money(target)}`, desc: 'A healthy reserve pays for the next big project — and for rainy days. (Borrowed money does not count.)', icon: '🏦', target, base: c.money, unit: 'money', focus: { panel: 'budget' }, reward: { mods: { happiness: 0.015 }, days: 120, label: 'Confident citizens' }, meta: { debt0: debtNow() } };
  },
  // money borrowed since the goal started does not count as savings
  cur: (c, g) => c.money - Math.max(0, debtNow() - ((g.meta && g.meta.debt0) || 0)),
  prog: (c, g, v) => (v - g.base) / Math.max(1, g.target - g.base),
};
KINDS.fix_power = {
  cat: 'fix', cool: 180, persist: 10, hold: HOLD_DAYS,
  score: (c) => (counts().power > 0 && (iss().unpowered || 0) >= 5 ? 8 : 0),
  make(c) {
    const n = iss().unpowered || 0;
    const short = iss().powerShortage;
    return { title: powerTitle(n), desc: short ? 'Demand exceeds supply — build another power plant.' : 'Some buildings are not connected — link them to the grid with roads or power lines.', icon: '🔌', target: 0, base: n, unit: 'left', focus: { overlay: 'power', locate: 'unpowered', group: 'power' }, reward: { money: nice(cash(0.8) * M.clamp(n / 40, 0.3, 1)) } };
  },
  cur: () => iss().unpowered || 0,
  prog: (c, g, v) => 1 - v / Math.max(1, g.base),
  title: (g, v) => powerTitle(v), // live count
  doneTitle: () => 'Restore power to every building',
  text: (g, v) => `${num(Math.max(0, g.base - v))} / ${num(g.base)} fixed`,
};
function powerTitle(n) { return `Restore power to ${num(n)} building${n === 1 ? '' : 's'}`; }
function waterTitle(n) { return `Bring water to ${num(n)} building${n === 1 ? '' : 's'}`; }
function abandTitle(n) { return `Revive ${num(n)} abandoned building${n === 1 ? '' : 's'}`; }
KINDS.fix_water = {
  cat: 'fix', cool: 180, persist: 10, hold: HOLD_DAYS,
  score: (c) => (counts().water > 0 && (iss().unwatered || 0) >= 5 ? 7 : 0),
  make(c) {
    const n = iss().unwatered || 0;
    return { title: waterTitle(n), desc: iss().waterShortage ? 'The pumps can not keep up — add pumps or towers (and make sure they have power).' : 'Some buildings are cut off — connect them with roads to a pump or tower.', icon: '🚰', target: 0, base: n, unit: 'left', focus: { overlay: 'water', locate: 'unwatered', group: 'water' }, reward: { money: nice(cash(0.8) * M.clamp(n / 40, 0.3, 1)) } };
  },
  cur: () => iss().unwatered || 0,
  prog: (c, g, v) => 1 - v / Math.max(1, g.base),
  title: (g, v) => waterTitle(v), // live count
  doneTitle: () => 'Bring water to every building',
  text: (g, v) => `${num(Math.max(0, g.base - v))} / ${num(g.base)} fixed`,
};
/** Empty zoned tiles without road access (indices; at most 4000). */
function noAccessTiles(S) {
  const out = [], F = VC.F;
  for (let i = 0; i < S.N && out.length < 4000; i++) if (S.zone[i] && !S.bld[i] && !(S.flags[i] & F.ACCESS)) out.push(i);
  return out;
}
/**
 * The goal's own tiles still to fix: a tile is fixed when it is zoned with road access (or built on), or a road
 * now runs over it (those count for at most 35% of the tiles). Dezoning is NOT a fix, so zoning a remote patch
 * and dezoning it again cannot farm the reward. Older saves without the tile list count the city-wide number.
 */
function accessLeft(g) {
  const S = S_(), t = g.meta && g.meta.tiles;
  if (!S || !Array.isArray(t)) return iss().zonedNoAccess || 0;
  const F = VC.F, roadCap = Math.floor(t.length * 0.35);
  let left = 0, roads = 0;
  for (const i of t) {
    if (S.zone[i] && (S.bld[i] || S.flags[i] & F.ACCESS)) continue;
    if (!S.zone[i] && S.road[i] && roads < roadCap) { roads++; continue; }
    left++;
  }
  return left;
}
KINDS.fix_access = {
  cat: 'fix', cool: 240, persist: 30, hold: HOLD_DAYS,
  score: (c) => ((iss().zonedNoAccess || 0) >= 12 ? 7 : 0),
  make(c) {
    const tiles = noAccessTiles(c.S), n = tiles.length;
    return { title: 'Connect zones to roads', desc: `${num(n)} zoned tiles are more than ${C.ROAD_ACCESS} tiles from a street, so nothing can grow there. Run streets to them.`, icon: '🚧', target: Math.floor(n * 0.2), base: n, unit: 'left', focus: { group: 'roads', locate: 'noaccess', tool: 'road_street' }, reward: { money: nice(cash(0.8) * M.clamp(n / 60, 0.25, 1)) }, meta: { tiles } };
  },
  cur: (c, g) => accessLeft(g),
  prog: (c, g, v) => (g.base - v) / Math.max(1, g.base - g.target),
  text: (g, v) => `${num(Math.max(0, v - g.target))} tiles to go`,
};
KINDS.fix_abandoned = {
  cat: 'fix', cool: 120, hold: HOLD_DAYS,
  score: (c) => ((c.st.abandoned || 0) >= 4 ? 6 : 0),
  make(c) {
    const n = c.st.abandoned || 0;
    return { title: abandTitle(n - Math.floor(n / 3)), desc: 'Empty buildings drag the whole street down. Check power, water, jobs, services, pollution and taxes around them.', icon: '🏚️', target: Math.floor(n / 3), base: n, unit: 'left', focus: { locate: 'abandoned', overlay: 'happiness' }, reward: { money: cash(1) } };
  },
  cur: (c) => c.st.abandoned || 0,
  prog: (c, g, v) => (g.base - v) / Math.max(1, g.base - g.target),
  title: (g, v) => abandTitle(Math.max(0, v - g.target)), // live count
  doneTitle: () => 'Revive the abandoned buildings',
  text: (g, v) => `${num(M.clamp(g.base - v, 0, g.base - g.target))} / ${num(g.base - g.target)} done`,
};
KINDS.fix_traffic = {
  cat: 'fix', cool: 180, persist: 30, hold: HOLD_DAYS, optional: true,
  score: (c) => ((iss().jammedRoads || 0) >= 12 ? 5 : 0),
  make(c) {
    const n = iss().jammedRoads || 0;
    return { title: 'Unjam the streets', desc: `${num(n)} road tiles are jammed — clear at least ${num(n - Math.floor(n * 0.7))} of them. Build avenues, alternative routes, bus depots — or try bike lanes.`, icon: '🚗', target: Math.floor(n * 0.7), base: n, unit: 'left', focus: { overlay: 'traffic' }, reward: { mods: { happiness: 0.02 }, days: 120, label: 'Smooth commutes' } };
  },
  cur: () => iss().jammedRoads || 0,
  prog: (c, g, v) => (g.base - v) / Math.max(1, g.base - g.target),
  text: (g, v) => `${num(Math.max(0, v - g.target))} jammed tiles to go`,
};
/**
 * Average monthly deficit of the last 3 months when at least 2 of them were in the red and it is not
 * trivial (>= $200 and 3% of income), else 0. A one-off bad month (or one staged on purpose) does not count.
 */
function deficit(c) {
  const h = c.S.history && c.S.history.net;
  if (!h || h.length < 3 || c.net >= 0) return 0;
  let n = 0, sum = 0;
  for (let i = h.length - 3; i < h.length; i++) if (h[i] < 0) { n++; sum -= h[i]; }
  const avg = n ? sum / n : 0;
  return n >= 2 && avg >= Math.max(200, 0.03 * (c.st.income || 0)) ? avg : 0;
}
KINDS.budget = {
  cat: 'fix', cool: 360,
  score: (c) => (!c.S.sandbox && c.pop >= 100 && deficit(c) > 0 ? 6 : 0),
  // the reward never exceeds 1.5x the deficit it fixes: running up deficits to farm it never pays
  make: (c) => ({ title: 'Balance the budget for 3 months', desc: 'The monthly balance is in the red. Trim department funding, drop pricey policies or raise taxes a little.', icon: '⚖️', target: 3, base: 0, unit: 'months', focus: { panel: 'budget' }, reward: { money: Math.min(cash(1.5), nice(1.5 * deficit(c))) }, meta: { streak: 0 } }),
  cur: (c, g) => (g.meta && g.meta.streak) || 0,
  prog: (c, g, v) => v / g.target,
};
KINDS.happiness = {
  cat: 'fix', cool: 240, persist: 30,
  score: (c) => (c.pop >= 300 && (c.st.happiness || 0) < 0.62 ? 4 + (0.62 - c.st.happiness) * 8 : 0),
  make(c) {
    const h = c.st.happiness || 0;
    const target = M.clamp(Math.ceil((h + 0.08) * 20) / 20, 0.5, 0.8);
    return { title: `Reach ${pct(target)} happiness`, desc: 'Parks, services, clean air, short commutes and fair taxes all make citizens smile.', icon: '😊', target, base: Math.min(h, target - 0.05), unit: 'pct', focus: { overlay: 'happiness', panel: 'stats' }, reward: { mods: { demandR: 0.08 }, days: 120, label: 'Happy-town buzz' } };
  },
  cur: (c) => c.st.happiness || 0,
  prog: (c, g, v) => (v - g.base) / Math.max(0.01, g.target - g.base),
};
KINDS.pollution = {
  cat: 'fix', cool: 360,
  score: (c) => (c.pop >= 1000 && (c.st.pollution || 0) > 0.3 ? 4 : 0),
  make(c) {
    const p = c.st.pollution || 0;
    const target = Math.floor(p * 0.7 * 20) / 20;
    return { title: `Clear the air: pollution below ${pct(target)}`, desc: 'Smog is choking the city. Plant trees, move industry away from homes, go clean on power or try the Clean Air Act.', icon: '🌫️', target, base: p, unit: 'pctdown', focus: { overlay: 'pollution' }, reward: { mods: { landValue: 0.05 }, days: 180, label: 'Fresh-air premium' } };
  },
  cur: (c) => c.st.pollution || 0,
  prog: (c, g, v) => (g.base - v) / Math.max(0.01, g.base - g.target),
};
KINDS.crime = {
  cat: 'fix', cool: 360,
  score: (c) => (c.pop >= 1000 && (c.st.crime || 0) > 0.3 ? 4 : 0),
  make(c) {
    const p = c.st.crime || 0;
    const target = Math.floor(p * 0.7 * 20) / 20;
    return { title: `Crack down on crime: below ${pct(target)}`, desc: 'Police stations near homes (and a Neighborhood Watch) keep the streets safe.', icon: '🦹', target, base: p, unit: 'pctdown', focus: { overlay: 'crime', group: 'safety' }, reward: { money: cash(1) } };
  },
  cur: (c) => c.st.crime || 0,
  prog: (c, g, v) => (g.base - v) / Math.max(0.01, g.base - g.target),
};
/* service coverage goals (parks have their own count-based goal) */
const SVC = [
  { key: 'fire', name: 'Fire', group: 'safety', first: 'fire_station', pop: 250, max: 0.6, why: 'Without fire stations a single spark can take out a whole block.' },
  { key: 'police', name: 'Police', group: 'safety', first: 'police_station', pop: 350, max: 0.6, why: 'Police keep crime — and the land-value slump it brings — away.' },
  { key: 'health', name: 'Health', group: 'safety', first: 'clinic', pop: 350, max: 0.6, why: 'Clinics keep residents healthy, happy and at work.' },
  { key: 'edu', name: 'School', group: 'education', first: 'school', pop: 450, max: 0.6, why: 'Schools raise land value and let industry level up.' },
  { key: 'garbage', name: 'Trash pickup', group: 'waste', first: 'landfill', pop: 600, max: 0.7, why: 'Uncollected trash makes citizens miserable — and buildings get abandoned.' },
  { key: 'transit', name: 'Transit', group: 'transit', first: 'bus_depot', pop: 3000, max: 0.45, why: 'Buses take cars off jammed streets.' },
];
for (const s of SVC) {
  KINDS['svc_' + s.key] = {
    cat: 'build', cool: 150, svc: s.key,
    score(c) {
      if (c.pop < s.pop || !unlocked(s.first)) return 0;
      const r = svc()[s.key];
      if (!r) return 0;
      const cov = r.coverage || 0;
      if (cov >= s.max * 0.6) return 0;
      const sc = 3 + (1 - cov / s.max) * 3 + Math.min(2, c.pop / 4000) + (r.buildings ? 0 : 1);
      // urgent (>= 8: skips the variety rule) only when the service is practically missing in a grown town
      return cov < 0.1 && c.pop >= s.pop * 2 ? sc : Math.min(7.9, sc);
    },
    make(c) {
      const r = svc()[s.key] || {};
      const cov = r.coverage || 0;
      const target = M.clamp(Math.round((cov + 0.4) * 20) / 20, 0.4, s.max);
      const def = VC.BLD[s.first];
      return {
        title: `${s.name} coverage to ${pct(target)}`,
        desc: `Only ${pct(cov)} of homes are covered. ` + (r.buildings ? `Build another ${def ? def.name : 'service building'} near homes. ` : `Build a ${def ? def.name : 'service building'} near homes. `) + s.why,
        icon: (def && def.icon) || '🏛️', target, base: cov, unit: 'pct', focus: { group: s.group, tool: 'bld:' + s.first }, reward: { money: cash(1) },
      };
    },
    cur: (c) => ((svc()[s.key] || {}).coverage || 0),
    prog: (c, g, v) => v / Math.max(0.01, g.target),
  };
}
KINDS.parks = {
  cat: 'build', cool: 240,
  score(c) {
    if (c.pop < 150) return 0;
    const r = svc().park;
    const cov = r ? r.coverage || 0 : 0;
    return cov < 0.5 ? 3.5 + (0.5 - cov) * 4 : 0;
  },
  make: (c) => ({ title: 'Build 3 parks near homes', desc: 'Parks and playgrounds raise land value and happiness for everyone nearby.', icon: '🌳', target: counts().parks + 3, base: cnt.parks, unit: 'step', focus: { group: 'parks', tool: 'bld:small_park' }, reward: { mods: { happiness: 0.02 }, days: 120, label: 'Green pride' } }),
  cur: () => counts().parks,
  prog: (c, g, v) => (v - g.base) / Math.max(1, g.target - g.base),
  text: (g, v) => `${Math.max(0, Math.min(v - g.base, g.target - g.base))} / ${g.target - g.base}`,
};
KINDS.trees = {
  cat: 'build', cool: ONCE, optional: true,
  score: (c) => (c.pop >= 80 ? 1.5 : 0),
  make: (c) => ({ title: 'Plant 30 trees', desc: 'Trees soak up pollution and noise — and make every street prettier.', icon: '🌲', target: trees() + 30, base: trees(), unit: 'step', focus: { tool: 'trees', group: 'parks' }, reward: { mods: { pollution: -0.06 }, days: 180, label: 'Fresh air' } }),
  cur: () => trees(),
  prog: (c, g, v) => (v - g.base) / Math.max(1, g.target - g.base),
  text: (g, v) => `${Math.max(0, Math.min(v - g.base, g.target - g.base))} / ${g.target - g.base}`,
};
KINDS.policy = {
  cat: 'build', cool: ONCE,
  score(c) {
    if (c.pop < 800) return 0;
    const P = c.S.policies || {};
    for (const k in P) if (P[k]) return 0;
    return VC.POLICIES.some((p) => unlocked(p.key)) ? 2.5 : 0;
  },
  make: (c) => ({ title: 'Enact your first policy', desc: 'Open Policies and try one — each slider sets how strongly it applies (and what it costs).', icon: '📜', target: 1, base: 0, unit: 'flag', focus: { panel: 'policies' }, reward: { money: cash(0.6) } }),
  cur(c) {
    const P = c.S.policies || {};
    let n = 0;
    for (const k in P) if (P[k]) n++;
    return n;
  },
  prog: (c, g, v) => (v > 0 ? 1 : 0),
};
KINDS.clean_power = {
  cat: 'build', cool: 540, optional: true,
  score: (c) => (c.pop >= 3000 && counts().power > 0 && cleanShare() < 0.3 && unlocked('wind_turbine') ? 2 : 0),
  make: (c) => ({ title: 'Go green: 50% clean power', desc: 'Wind, solar and nuclear power keep the lights on without the smog.', icon: '🌬️', target: 0.5, base: cleanShare(), unit: 'pct', focus: { group: 'power', overlay: 'pollution' }, reward: { mods: { happiness: 0.02, landValue: 0.03 }, days: 240, label: 'Green reputation' } }),
  cur: () => cleanShare(),
  prog: (c, g, v) => v / g.target,
};
/** Unique landmarks the city can afford now, cheapest first. */
function landmarkPick(c) {
  let best = null;
  const mul = (() => { try { return VC.money.costMul(); } catch (e) { return 1; } })();
  for (const d of VC.CATALOG) {
    if (d.group !== 'landmarks' || !d.unique || !unlocked(d.key)) continue;
    if (d.requiresPolicy && !(VC.econ && VC.econ.isPolicyOn && VC.econ.isPolicyOn(d.requiresPolicy))) continue;
    if (counts().byKey.get(d.key)) continue;
    const cost = d.cost * mul;
    if (!c.S.sandbox && cost > c.money * 0.7) continue;
    if (!best || d.cost < best.cost) best = d;
  }
  return best;
}
KINDS.landmark = {
  cat: 'build', cool: 120, optional: true,
  score: (c) => (c.pop >= 200 && landmarkPick(c) ? 3 : 0),
  make(c) {
    const d = landmarkPick(c);
    if (!d) return null;
    return { title: `Build the ${d.name}`, desc: d.desc || 'A landmark your citizens will be proud of.', icon: d.icon || '🏛️', target: 1, base: 0, unit: 'flag', focus: { group: 'landmarks', tool: 'bld:' + d.key }, reward: { mods: { happiness: 0.02, tourism: 0.1 }, days: 180, label: 'Civic pride' }, meta: { key: d.key } };
  },
  cur: (c, g) => (counts().built.get(g.meta && g.meta.key) || 0) + (cnt.byKey.get(g.meta && g.meta.key) ? 0.5 : 0),
  prog: (c, g, v) => (v >= 1 ? 1 : v > 0 ? 0.5 : 0),
  text: (g, v) => (v >= 1 ? 'Built!' : v > 0 ? 'Under construction…' : 'Not built yet'),
};
for (const k in KINDS) KINDS[k].key = k;

/* ------------------------------------------------------------------ */
/* rewards                                                               */
/* ------------------------------------------------------------------ */
const MOD_TXT = {
  happiness: ['😊', 'happiness', 1], demandR: ['🏠', 'housing demand', 1], demandC: ['🏬', 'shop demand', 1], demandI: ['🏭', 'industry demand', 1],
  tourism: ['📸', 'tourism', 1], landValue: ['💎', 'land value', 1], pollution: ['🌿', 'pollution', -1], crime: ['🚓', 'crime', -1],
  traffic: ['🚗', 'traffic', -1], health: ['🩺', 'health', 1], education: ['🎓', 'education', 1],
};
/** Short reward label for the HUD: "🎁 $1,200" or "🎁 +2% happiness" (first modifier only). */
function rewardText(r) {
  if (!r) return '';
  const parts = [];
  if (r.money) parts.push(money(r.money));
  if (r.mods) {
    const k = Object.keys(r.mods)[0];
    const t = MOD_TXT[k] || ['✨', k, 1];
    const v = r.mods[k];
    parts.push(`${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}% ${t[1]}`); // how long: rewardLong (tooltip)
  }
  return parts.length ? '🎁 ' + parts.join(' + ') : '';
}
/** Full reward description (tooltips, toasts): "$1,200" / "+2% happiness, +10% tourism for 6 months". */
function rewardLong(r) {
  if (!r) return '';
  const parts = [];
  if (r.money) parts.push(money(r.money));
  if (r.mods) {
    const mods = [];
    for (const k in r.mods) {
      const t = MOD_TXT[k] || ['✨', k, 1];
      const v = r.mods[k];
      mods.push(`${t[0]} ${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}% ${t[1]}`);
    }
    parts.push(mods.join(', ') + (r.days ? ` for ${r.days >= 60 ? Math.round(r.days / 30) + ' months' : r.days + ' days'}` : '') + (r.label ? ` (“${r.label}”)` : ''));
  }
  return parts.join(' + ');
}
/** Temporary modifiers: VC.econ.addTempMod (contract), or the desk module's fallback on older economies. */
function addTempMod(entry) {
  const E = VC.econ;
  if (E && typeof E.addTempMod === 'function') return E.addTempMod(entry);
  if (VC.desk && typeof VC.desk.addTempMod === 'function') return VC.desk.addTempMod(entry);
  return null;
}
function grant(S, g) {
  const r = g.reward || {};
  if (r.money > 0) VC.money.earn(r.money, 'goal');
  if (r.mods) addTempMod({ id: 'goal:' + g.id, source: 'goal', label: r.label || g.title, mods: Object.assign({}, r.mods), until: S.time.day + (r.days || 90) });
}

/* ------------------------------------------------------------------ */
/* state                                                                 */
/* ------------------------------------------------------------------ */
function ensure(S) {
  let G = S.goals;
  if (!G || typeof G !== 'object' || Array.isArray(G)) G = S.goals = {};
  if (!Array.isArray(G.active)) G.active = [];
  if (!Array.isArray(G.done)) G.done = [];
  if (!Array.isArray(G.log)) G.log = [];
  if (!G.cool || typeof G.cool !== 'object') G.cool = {};
  if (!G.seen || typeof G.seen !== 'object') G.seen = {};
  if (!G.stale || typeof G.stale !== 'object') G.stale = {};
  if (!(G.seq >= 0)) G.seq = 0;
  if (!(G.count >= 0)) G.count = 0;
  if (!isFinite(G.next)) G.next = S.time.day + FIRST_DAYS;
  G.v = 1;
  // drop goals of unknown kinds (older / newer versions) and repair fields the HUD relies on
  G.active = G.active.filter((g) => g && typeof g === 'object' && KINDS[g.kind]);
  for (const g of G.active) {
    if (!isFinite(g.progress)) g.progress = 0;
    if (!g.reward || typeof g.reward !== 'object') g.reward = {};
    if (!g.reward.text) g.reward.text = rewardText(g.reward);
    if (!g.reward.long) g.reward.long = rewardLong(g.reward);
    if (!g.focus || typeof g.focus !== 'object') g.focus = {};
    if (!g.cat) g.cat = KINDS[g.kind].cat;
    if (!isFinite(g.lastProg)) g.lastProg = S.time.day; // older saves: the stale clock starts now
  }
  return G;
}
const live = (S) => !!(S && !S.demo && S.goals);

function textOf(K, g, v) {
  if (K.text) return K.text(g, v);
  switch (g.unit) {
    case 'num': return `${num(v)} / ${num(g.target)}`;
    case 'money': return `${money(v)} / ${money(g.target)}`;
    case 'pct': return `${pct(v)} / ${pct(g.target)}`;
    case 'pctdown': return `${pct(v)} → ${pct(g.target)}`;
    case 'left': return `${num(v)} left`;
    case 'months': return `${v} / ${g.target} months`;
    case 'step': return `${v} / ${g.target}`;
    case 'flag': return v >= 1 ? 'Done!' : 'Not yet';
    default: return '';
  }
}
/** Recomputes progress of every open goal; completes the ones that reached 1. */
function evaluate(S) {
  const G = S.goals;
  prep(S);
  for (const g of G.active) {
    if (g.done) continue;
    const K = KINDS[g.kind];
    let v = 0, p = 0;
    try {
      v = K.cur(cx, g);
      p = K.prog(cx, g, v);
    } catch (e) { continue; }
    if (!isFinite(p)) p = 0;
    g.cur = typeof v === 'number' && isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
    g.progress = clamp01(p);
    try { g.text = textOf(K, g, v); } catch (e) { g.text = ''; }
    if (K.title && p < 1) { try { const t = K.title(g, v); if (t) g.title = t; } catch (e) { /* keep */ } }
    // stale-goal bookkeeping: the best progress so far and when it was reached
    if (!(g.best >= 0)) { g.best = g.progress; g.lastProg = S.time.day; }
    else if (g.progress > g.best + 0.005) { g.best = g.progress; g.lastProg = S.time.day; }
    if (p >= 1 && K.hold > 0) {
      // a fixed problem has to STAY fixed for a while (undoing the cause of a staged problem is not enough)
      if (!(g.holdSince >= 0)) g.holdSince = S.time.day;
      const left = K.hold - (S.time.day - g.holdSince);
      if (left > 0) {
        g.progress = 0.99;
        g.text = `Fixed — hold it ${left} more day${left === 1 ? '' : 's'}`;
        continue;
      }
    } else if (g.holdSince != null) delete g.holdSince;
    if (p >= 1) complete(S, g);
  }
  lastEvalDay = S.time.day;
  dirty = false;
}
function complete(S, g) {
  g.done = true;
  g.progress = 1;
  g.doneDay = S.time.day;
  g.shown = 0;
  const G = S.goals;
  const K0 = KINDS[g.kind];
  if (K0 && K0.doneTitle) { try { g.title = K0.doneTitle(g); } catch (e) { /* keep */ } }
  G.count++;
  G.done.push(g.id);
  if (G.done.length > DONE_CAP) G.done.splice(0, G.done.length - DONE_CAP);
  G.log.unshift({ id: g.id, kind: g.kind, title: g.title, icon: g.icon, day: S.time.day });
  if (G.log.length > LOG_CAP) G.log.length = LOG_CAP;
  const K = KINDS[g.kind];
  G.cool[g.kind] = S.time.day + ((K && K.cool) || 0);
  if (G.stale) delete G.stale[g.kind];
  VC.bus.emit('goalDone', { goal: g });
  VC.bus.emit('goalsChanged', G.active);
}
/**
 * Adds the most relevant new goal (or `forceKind`). opts.noFix: no 'fix' goal (a swap must not turn a
 * problem created a moment ago into a goal). Problem kinds (K.persist) only come up once the problem
 * has existed for K.persist days (G.seen, see trackProblems). Returns the goal or null.
 */
function generate(S, forceKind, opts) {
  const noFix = !!(opts && opts.noFix);
  const G = S.goals;
  if (G.active.length >= MAX_ACTIVE && !forceKind) return null;
  prep(S);
  const day = S.time.day;
  rnd = M.rng((S.seed ^ Math.imul(day + 7, 2654435761) ^ (G.seq * 97)) >>> 0);
  const cands = [];
  // a thin card (fewer than 2 goals) halves the rest of grow/build kinds that completed (not stale ones, not
  // fixes): late-game cities have few fresh kinds left and the card must not sit empty
  const thin = G.active.length < 2;
  if (forceKind) { if (KINDS[forceKind]) cands.push({ K: KINDS[forceKind], s: 1 }); }
  else {
    for (const key in KINDS) {
      const K = KINDS[key];
      if (G.active.some((g) => g.kind === key)) continue;
      const cool = G.cool[key] || 0;
      if (cool > day && !(thin && K.cat !== 'fix' && !G.stale[key] && K.cool < ONCE && cool - day <= K.cool / 2)) continue;
      if (noFix && K.cat === 'fix') continue;
      if (K.persist && !(G.seen[key] != null && day - G.seen[key] >= K.persist)) continue;
      let s = 0;
      try { s = +K.score(cx) || 0; } catch (e) { s = 0; }
      if (!(s > 0)) continue;
      // kinds that went stale before are less likely to come back (prefer goals the city can finish)
      if (G.stale[key]) s -= 1.5 * G.stale[key];
      // variety: a second goal of the same category has to be urgent to win
      if (s < 8 && G.active.some((g) => g.cat === K.cat)) s -= 2.5;
      // ... and two "X coverage to N%" goals at once only when the new one is urgent
      if (K.svc && s < 8 && G.active.some((g) => KINDS[g.kind] && KINDS[g.kind].svc)) s -= 3;
      cands.push({ K, s: s + rnd() * 1.5 });
    }
    cands.sort((a, b) => b.s - a.s);
  }
  // best first; a goal that would already be complete is pointless: skip it (and rest that kind a while)
  for (const { K } of cands) {
    let f = null;
    try { f = K.make(cx); } catch (e) { console.error('[goals] make ' + K.key, e); f = null; }
    if (!f) continue;
    const g = Object.assign({ id: 'g' + (G.seq + 1), kind: K.key, cat: K.cat, day, progress: 0, cur: 0, text: '', done: false, lastProg: day }, f);
    g.reward = Object.assign({}, g.reward || {});
    g.reward.text = rewardText(g.reward);
    g.reward.long = rewardLong(g.reward);
    g.focus = g.focus || {};
    try {
      const v = K.cur(cx, g);
      const p = K.prog(cx, g, v);
      if (p >= 1 && !forceKind) { G.cool[K.key] = day + 30; continue; }
      g.cur = typeof v === 'number' && isFinite(v) ? v : 0;
      g.progress = clamp01(p);
      g.best = g.progress;
      g.text = textOf(K, g, v);
    } catch (e) { /* keep defaults */ }
    G.seq++;
    G.active.push(g);
    VC.bus.emit('goalsChanged', G.active);
    return g;
  }
  return null;
}
/**
 * How long has each city problem (kinds with K.persist) existed? G.seen[kind] = the first check day its
 * score was > 0, cleared as soon as it is 0 — so a problem created on purpose only becomes a goal after
 * it has hurt the city for a while.
 */
function trackProblems(S) {
  const G = S.goals, day = S.time.day;
  prep(S);
  for (const key in KINDS) {
    const K = KINDS[key];
    if (!K.persist) continue;
    let sc = 0;
    try { sc = +K.score(cx) || 0; } catch (e) { sc = 0; }
    if (sc > 0) { if (G.seen[key] == null) G.seen[key] = day; }
    else delete G.seen[key];
  }
}
function onDay() {
  const S = S_();
  if (!live(S) || tutorialOn()) return;
  const G = S.goals, day = S.time.day;
  if (day % PROBLEM_EVERY === 0) trackProblems(S);
  // auto-claim forgotten rewards so the slot frees up — only after the card has shown them a while
  // (real seconds, counted by the HUD; without a HUD the game days alone decide)
  const hudOn = !!(VC.hud && VC.hud.register);
  for (let i = G.active.length - 1; i >= 0; i--) {
    const g = G.active[i];
    if (g.done && day - (g.doneDay || day) >= AUTO_CLAIM_DAYS && (!hudOn || (g.shown || 0) >= AUTO_CLAIM_SEC)) claim(g.id, true);
  }
  // rotate out a goal that has not moved for a long time (at most one a month; fresh progress first)
  const isStale = (g) => !g.done && day - (isFinite(g.lastProg) ? g.lastProg : g.day) >= STALE_DAYS;
  if (day - (G.rotDay || -1e9) >= ROTATE_GAP && G.active.some(isStale)) {
    evaluate(S);
    const stale = G.active.find(isStale);
    if (stale) { G.rotDay = day; rotate(S, stale); }
  }
  if (G.active.length < MAX_ACTIVE && day >= G.next) {
    const g = generate(S);
    G.next = day + (g ? (G.active.length < MAX_ACTIVE ? FILL_DAYS : NEXT_DAYS) : 7);
  }
}
function onMonth() {
  const S = S_();
  if (!live(S)) return;
  for (const g of S.goals.active) {
    if (g.kind !== 'budget' || g.done) continue;
    g.meta = g.meta || {};
    g.meta.streak = (S.stats.net || 0) >= 0 ? (g.meta.streak || 0) + 1 : 0;
  }
  dirty = true;
}

/* ------------------------------------------------------------------ */
/* API                                                                   */
/* ------------------------------------------------------------------ */
function list() {
  const S = S_();
  return S && S.goals && Array.isArray(S.goals.active) ? S.goals.active : [];
}
/** Grants a completed goal's reward and removes it. silent: no 'goalClaimed' celebration hint. */
function claim(id, silent) {
  const S = S_();
  if (!live(S)) return false;
  const G = S.goals;
  const i = G.active.findIndex((g) => g.id === id);
  if (i < 0 || !G.active[i].done) return false;
  const g = G.active[i];
  G.active.splice(i, 1);
  try { grant(S, g); } catch (e) { console.error('[goals] reward', e); }
  G.next = Math.max(G.next, S.time.day + NEXT_DAYS);
  VC.bus.emit('goalClaimed', { goal: g, auto: !!silent });
  VC.bus.emit('goalsChanged', G.active);
  return true;
}
/** A goal that sat still for STALE_DAYS makes room for a fresh one (its kind rests a while). */
function rotate(S, g) {
  const G = S.goals;
  const i = G.active.indexOf(g);
  if (i < 0) return;
  G.active.splice(i, 1);
  // each stale rotation rests the kind twice as long (480, 960, … days); optional goals (trees,
  // landmarks) that went stale twice do not come back
  const st = (G.stale[g.kind] = (G.stale[g.kind] || 0) + 1);
  const K = KINDS[g.kind];
  const rest = K && K.optional && st >= 2 ? ONCE : Math.min(ONCE, 240 * Math.pow(2, st));
  G.cool[g.kind] = Math.max(G.cool[g.kind] || 0, S.time.day + rest);
  const n = generate(S);
  G.next = S.time.day + (n ? NEXT_DAYS : 2);
  if (!n) VC.bus.emit('goalsChanged', G.active);
  VC.bus.emit('goalRotated', { goal: g, next: n });
}
/** Replaces an open goal with another (its kind cools down for a while). */
function swap(id) {
  const S = S_();
  if (!live(S)) return false;
  const G = S.goals;
  const i = G.active.findIndex((g) => g.id === id);
  if (i < 0 || G.active[i].done) return false;
  const g = G.active.splice(i, 1)[0];
  const K = KINDS[g.kind];
  // (at least a full cooldown: the thin-card rule in generate() must not hand the swapped kind straight back)
  G.cool[g.kind] = Math.max(G.cool[g.kind] || 0, S.time.day + Math.max(120, K && K.cool < ONCE ? K.cool : 0));
  const n = generate(S, null, { noFix: true });
  G.next = S.time.day + (n ? NEXT_DAYS : 2);
  if (!n) VC.bus.emit('goalsChanged', G.active);
  return true;
}
/** Live "Show me" target: stored focus + a located building / tile for problem goals. */
function focusOf(id) {
  const S = S_();
  const g = list().find((x) => x.id === id);
  if (!S || !g) return null;
  const f = Object.assign({}, g.focus || {});
  // "Show me" opens the palette the tool really lives in (older saves stored the trees goal under 'terrain')
  if (f.tool && VC.tools && typeof VC.tools.info === 'function') {
    try { const ti = VC.tools.info(f.tool); if (ti && ti.group) f.group = ti.group; } catch (e) { /* keep */ }
  }
  const loc = f.locate;
  delete f.locate;
  if (loc) {
    prep(S);
    let b = null;
    if (loc === 'unpowered') b = VC.world.get(counts().unpow);
    else if (loc === 'unwatered') b = VC.world.get(counts().unwat);
    else if (loc === 'abandoned') b = VC.world.get(counts().aband);
    if (b) { f.x = b.x + b.w / 2; f.z = b.z + b.d / 2; }
    else if (loc === 'noaccess') {
      const F = VC.F;
      for (let i = 0; i < S.N; i++) {
        if (S.zone[i] && !S.bld[i] && !(S.flags[i] & F.ACCESS)) { f.x = (i % S.W) + 0.5; f.z = Math.floor(i / S.W) + 0.5; break; }
      }
    }
  }
  if (g.kind === 'landmark' && g.meta && g.meta.key) {
    for (const b of S.buildings.values()) if (b.key === g.meta.key) { f.x = b.x + b.w / 2; f.z = b.z + b.d / 2; delete f.tool; break; }
  }
  return f;
}

const Goals = (VC.goals = {
  KINDS,
  MAX_ACTIVE,
  AUTO_CLAIM_SEC,
  STALE_DAYS,
  init() {
    if (inited) return;
    inited = true;
    const bus = VC.bus;
    bus.on('day', () => { try { onDay(); } catch (e) { console.error('[goals] day', e); } });
    bus.on('month', () => { try { onMonth(); } catch (e) { console.error('[goals] month', e); } });
    const mark = () => { dirty = true; };
    for (const ev of ['bldAdd', 'bldRemove', 'built', 'policyChanged', 'budgetChanged', 'flagsUpdated', 'mapsUpdated']) bus.on(ev, mark);
  },
  reset(S) {
    acc = 0;
    lastEvalDay = -1;
    dirty = true;
    if (!S || S.demo) return;
    ensure(S);
  },
  update(dt, rdt) {
    acc += rdt || 0;
    if (acc < EVAL_SEC) return;
    acc = 0;
    const S = S_();
    if (!live(S) || tutorialOn()) return;
    if (!dirty && lastEvalDay === S.time.day) return;
    if (!S.goals.active.length) { lastEvalDay = S.time.day; dirty = false; return; }
    evaluate(S);
  },
  list,
  claim: (id) => claim(id, false),
  swap,
  focusOf,
  rewardText,
  rewardLong,
  /** Debug: evaluate now and fill every free slot immediately. Returns the active goals. */
  refresh() {
    const S = S_();
    if (!live(S)) return [];
    evaluate(S);
    for (let n = 0; n < MAX_ACTIVE && S.goals.active.length < MAX_ACTIVE; n++) if (!generate(S)) break;
    S.goals.next = S.time.day + NEXT_DAYS;
    return S.goals.active;
  },
  /** Debug: adds a goal of a given kind now (replacing the oldest open goal when full). */
  add(kind) {
    const S = S_();
    if (!live(S) || !KINDS[kind]) return null;
    const G = S.goals;
    if (G.active.length >= MAX_ACTIVE) {
      const i = G.active.findIndex((g) => !g.done);
      if (i >= 0) G.active.splice(i, 1);
    }
    return generate(S, kind);
  },
});

/* Lifecycle fallback: join main's module loop when main.js does not list this module. */
VC.bus.on('boot', () => {
  const order = VC.MODULE_ORDER;
  if (!order || order.indexOf('goals') >= 0) return;
  const at = order.indexOf('advisors');
  order.splice(at >= 0 ? at + 1 : order.length, 0, 'goals');
  try { Goals.init(); } catch (e) { console.error('[goals] init', e); }
});
