/*
 * VOXELPOLIS — advisors, news ticker, milestones + unlock announcements, achievements.
 *
 * ADVISORS: on bus 'month' (after econ) a context snapshot of the city is gathered once and every
 * RULE is evaluated. Triggered rules respect per-rule cooldowns; at most MAX_PER_MONTH new messages
 * are posted (worst severity first, one per advisor). Messages land in the inbox (newest first,
 * capped); 'warn'/'bad' ones are also emitted on bus 'advisor' (the HUD pops a card).
 * advice(key) evaluates the same rules for one advisor right now (ignoring cooldowns).
 *
 * NEWS: 2-4 headlines per month are scheduled over the following month (context-aware ones built
 * from the snapshot + funny evergreen ones from VC.headlines.POOL); events (disasters, milestones,
 * policies, loans, landmarks) make the news immediately. Bus 'news' {text}.
 *
 * MILESTONES: whenever S.peakPop crosses VC.MILESTONES[i].pop (checked daily): S.milestone = i,
 * reward, bus 'milestone', toast, news, fireworks. Newly unlocked buildings / roads / zone densities /
 * policies are announced.
 *
 * ACHIEVEMENTS: ACH list below; S.achievements[key] = day unlocked; bus 'achievement'.
 *
 * Persistent data (plain JSON, saved with the state): S.adv {inbox, news, cooldown, …}.
 */
const M = VC.M, C = VC.C;
const INBOX_CAP = 60, NEWS_CAP = 40, MAX_PER_MONTH = 2;
const SEV_RANK = { bad: 3, warn: 2, good: 1, info: 1 };
const HL = () => VC.headlines || { POOL: ['{city} news'], CTX: {}, fill: (t) => t };

let rnd = M.rng(1);
let sawMaps = false, sawFlags = false; // has the real sim produced maps / network flags this game?
let ctxCache = null, ctxDay = -1, ctxS = null;

function S_() { return VC.state; }
const pct = (v) => Math.round(v * 100);
const money = (v) => VC.fmt.money(v);
const num = (v) => VC.fmt.num(v);
const choose = (a) => (Array.isArray(a) ? a[Math.floor(rnd() * a.length)] : a);

/* ------------------------------------------------------------------ */
/* City snapshot                                                        */
/* ------------------------------------------------------------------ */
const PARKS = { small_park: 1, playground: 1, plaza: 1, sports_field: 1, big_park: 1, botanical_garden: 1 };
const RENEWABLE = { wind_turbine: 1, solar_farm: 1, fusion_plant: 1 };
const FOSSIL = { coal_plant: 1, gas_plant: 1, incinerator: 1 };

/** Gathers everything the rules need in one pass over buildings / tiles. Cached per sim day. */
function gather(force) {
  const S = S_();
  if (!force && ctxCache && ctxS === S && ctxDay === S.time.day) return ctxCache;
  const st = S.stats, W = S.W, N = S.N || S.W * S.H;
  const c = {
    S, st, day: S.time.day, pop: st.pop || 0, money: S.money,
    fc: VC.econ && VC.econ.forecast ? VC.econ.forecast() : { income: {}, expenses: {}, totalIncome: 0, totalExpenses: 0, net: 0 },
    count: {}, dept: {}, grow: { R: 0, C: 0, I: 0 }, growN: 0,
    unpowered: 0, unwatered: 0, abandoned: 0, burning: 0, rubble: 0, parks: 0, landmarks: 0,
    powerCap: 0, waterCap: 0, renewCap: 0, fossilCap: 0,
    zoned: 0, zonedEmpty: 0, noAccess: 0, roads: 0, roadType: [0, 0, 0, 0], jam: 0, trafficAvg: 0,
    mapsOn: sawMaps || (S.ver && S.ver.maps > 0), flagsOn: sawFlags || (S.ver && S.ver.flags > 0),
    avg: {}, homeAvg: {},
  };
  const keys = ['crime', 'pollution', 'happiness', 'health', 'edu', 'police', 'fire', 'park', 'garbage', 'landValue', 'noise'];
  const sum = {}, hsum = {};
  for (const k of keys) { sum[k] = 0; hsum[k] = 0; }
  let wsum = 0, hw = 0;
  for (const b of S.buildings.values()) {
    if (b.key === 'rubble') { c.rubble++; continue; }
    if (b.fire > 0) c.burning++;
    if (b.key === 'grow') {
      c.growN++;
      const z = VC.ZONES[b.zt];
      if (z) c.grow[z.key]++;
      if (b.abandoned) { c.abandoned++; continue; }
      if (b.built >= 1) {
        if (!b.powered) c.unpowered++;
        if (!b.watered) c.unwatered++;
      }
      // sample the maps at the building's origin tile (weighted by occupants)
      const i = b.z * W + b.x, w = 1 + (b.pop || 0) * 0.1;
      for (const k of keys) { const m = S.maps[k]; if (m) sum[k] += m[i] * w; }
      wsum += w;
      if (b.zt === 1) { for (const k of keys) { const m = S.maps[k]; if (m) hsum[k] += m[i] * w; } hw += w; }
      continue;
    }
    const def = VC.BLD[b.key];
    if (!def) continue;
    c.count[b.key] = (c.count[b.key] || 0) + 1;
    c.dept[def.dept] = (c.dept[def.dept] || 0) + 1;
    if (PARKS[b.key]) c.parks++;
    if (def.group === 'landmarks') c.landmarks++;
    if (def.power) {
      c.powerCap += def.power;
      if (RENEWABLE[b.key]) c.renewCap += def.power;
      if (FOSSIL[b.key] || b.key === 'nuclear_plant') c.fossilCap += def.power;
    }
    if (def.water) c.waterCap += def.water;
  }
  for (const k of keys) {
    c.avg[k] = wsum ? sum[k] / wsum / 255 : 0;
    c.homeAvg[k] = hw ? hsum[k] / hw / 255 : 0;
  }
  // tiles: zoning, road access, traffic
  const zone = S.zone, bld = S.bld, flags = S.flags, road = S.road, traffic = S.maps.traffic;
  const ACC = VC.F.ACCESS;
  let tsum = 0;
  for (let i = 0; i < N; i++) {
    if (zone[i]) {
      c.zoned++;
      if (!bld[i]) {
        c.zonedEmpty++;
        if (!(flags[i] & ACC)) c.noAccess++;
      }
    }
    const r = road[i];
    if (r) {
      c.roads++;
      c.roadType[r]++;
      const t = traffic ? traffic[i] : 0;
      tsum += t;
      if (t >= 190) c.jam++;
    }
  }
  c.trafficAvg = c.roads ? tsum / c.roads / 255 : 0;
  c.jamFrac = c.roads ? c.jam / c.roads : 0;
  const tax = S.tax;
  c.taxAvg = (tax.R[0] + tax.R[1] + tax.R[2] + tax.C[0] + tax.C[1] + tax.C[2] + tax.I[0] + tax.I[1] + tax.I[2]) / 9;
  c.taxMax = Math.max(...tax.R, ...tax.C, ...tax.I);
  c.net = c.fc.net;
  c.runway = c.net < 0 ? Math.max(0, S.money / -c.net) : Infinity;
  c.happy = st.happiness == null ? 0.6 : st.happiness;
  c.econ = S.econ || {};
  c.has = (k) => (c.count[k] || 0) > 0;
  c.hasAny = (...ks) => ks.some((k) => (c.count[k] || 0) > 0);
  c.unlocked = (k) => VC.world.isUnlocked(k);
  c.fund = (d) => (VC.econ && VC.econ.getFunding ? VC.econ.getFunding(d) : 1);
  c.lowFund = (d) => (c.econ.lowFund && c.econ.lowFund[d]) || 0;
  c.powerKnown = st.powerDemand > 0 || st.powerSupply > 0;
  c.waterKnown = st.waterDemand > 0 || st.waterSupply > 0;
  ctxCache = c; ctxDay = S.time.day; ctxS = S;
  return c;
}

/* ------------------------------------------------------------------ */
/* Advisor rules                                                        */
/* key, adv, sev ('info'|'warn'|'bad'|'good' or fn), cd (cooldown days), when(c), title, text (string |  */
/* [variants] | fn(c)), panel (panel key the UI may offer), overlay (overlay key)                        */
/* ------------------------------------------------------------------ */
const RULES = [
  /* ---- Finance: Penny Pincher ---- */
  { key: 'f_broke', adv: 'finance', sev: 'bad', cd: 75, panel: 'budget', when: (c) => c.money < 0 && !c.S.sandbox,
    title: 'We are in the red!',
    text: (c) => choose([
      `The treasury is at ${money(c.money)}. Raise taxes, trim budgets or take a loan before the bank starts calling.`,
      `Mayor, the vault echoes. We're at ${money(c.money)} and the Bank of Blocks is sharpening its pencils.`,
    ]) + (c.econ.bankruptMonths >= 2 ? ` ${c.econ.bankruptMonths}/6 months below -$10k before a forced bail-out.` : '') },
  { key: 'f_runway', adv: 'finance', sev: 'warn', cd: 120, panel: 'budget', when: (c) => c.net < 0 && c.money >= 0 && c.runway < 12 && !c.S.sandbox,
    title: 'Running out of money',
    text: (c) => choose([
      `We lose ${money(-c.net)} a month. At this rate we're broke in about ${Math.max(1, Math.round(c.runway))} months.`,
      `Cash burn: ${money(-c.net)}/month. I give the treasury ${Math.max(1, Math.round(c.runway))} months. I've started clipping coupons.`,
    ]) },
  { key: 'f_deficit', adv: 'finance', sev: 'info', cd: 150, panel: 'budget', when: (c) => c.net < -100 && c.runway >= 12 && !c.S.sandbox,
    title: 'Monthly deficit',
    text: (c) => `We spend ${money(-c.net)} more than we earn each month. The cushion is fine for now, but cushions deflate.` },
  { key: 'f_high_tax', adv: 'finance', sev: 'warn', cd: 150, panel: 'budget', when: (c) => c.taxAvg >= 13,
    title: 'Taxes are high',
    text: (c) => choose([
      `Taxes average ${c.taxAvg.toFixed(1)}%. Every point above 12 costs goodwill and growth.`,
      `At ${c.taxAvg.toFixed(1)}% average tax, citizens are counting their coins — and not fondly.`,
    ]) },
  { key: 'f_low_tax', adv: 'finance', sev: 'info', cd: 180, panel: 'budget', when: (c) => c.taxAvg <= 6 && c.net < 0 && !c.S.sandbox,
    title: 'Low taxes, low funds',
    text: (c) => `Taxes average only ${c.taxAvg.toFixed(1)}% and we're losing money. Even a point or two would help.` },
  { key: 'f_loans', adv: 'finance', sev: 'warn', cd: 180, panel: 'loans', when: (c) => (c.fc.expenses.loanPayment || 0) > 0.3 * Math.max(1, c.fc.totalIncome),
    title: 'Loan payments are heavy',
    text: (c) => `Loan payments eat ${pct((c.fc.expenses.loanPayment || 0) / Math.max(1, c.fc.totalIncome))}% of our income. Interest is the most expensive thing we buy.` },
  { key: 'f_policy', adv: 'finance', sev: 'info', cd: 180, panel: 'policies', when: (c) => (c.fc.expenses.policy || 0) > 500 && (c.fc.expenses.policy || 0) > 0.25 * Math.max(1, c.fc.totalIncome),
    title: 'Policies are pricey',
    text: (c) => `Policies cost ${money(c.fc.expenses.policy)} a month — ${pct(c.fc.expenses.policy / Math.max(1, c.fc.totalIncome))}% of income. Worth reviewing what we actually need.` },
  { key: 'f_overfund', adv: 'finance', sev: 'info', cd: 240, panel: 'budget',
    when: (c) => c.net < 0 && VC.DEPARTMENTS.find((d) => c.fund(d.key) > 1.2 && (c.fc.dept[d.key] || 0) > 200),
    title: 'Diminishing returns',
    text: (c) => { const d = VC.DEPARTMENTS.find((x) => c.fund(x.key) > 1.2 && (c.fc.dept[x.key] || 0) > 200); return `${d.name} is funded at ${pct(c.fund(d.key))}%. Past 100% you get diminishing returns — lovely service, ugly spreadsheet.`; } },
  { key: 'f_surplus', adv: 'finance', sev: 'good', cd: 240, panel: 'budget', when: (c) => c.net > 500 && c.money > 50000 + 5 * c.fc.totalIncome && !c.S.sandbox,
    title: 'Healthy surplus',
    text: (c) => `We make ${money(c.net)} a month and sit on ${money(c.money)}. Dare I say it? Invest a little in services.` },
  { key: 'f_balanced', adv: 'finance', sev: 'good', cd: 300, panel: 'budget', when: (c) => (c.econ.balancedMonths || 0) >= 6 && c.pop > 500 && !c.S.sandbox,
    title: 'In the black',
    text: (c) => `${c.econ.balancedMonths} months in a row without a deficit. I've framed the ledger.` },

  /* ---- Safety: Chief Blaze ---- */
  { key: 's_no_fire', adv: 'safety', sev: 'warn', cd: 120, when: (c) => c.pop >= 400 && !c.hasAny('fire_station', 'fire_hq'),
    title: 'No fire protection',
    text: ['We have zero fire stations. ZERO. One spark and this town is kindling. Build a Fire Station.', "No fire station in town. I'm fighting fires with a garden hose and a prayer."] },
  { key: 's_no_police', adv: 'safety', sev: 'warn', cd: 120, when: (c) => c.pop >= 600 && !c.hasAny('police_station', 'police_hq'),
    title: 'No police',
    text: ['No police in town, and the crooks have noticed. A Police Station would do wonders.', 'Without a Police Station, crime is basically on the honour system.'] },
  { key: 's_crime', adv: 'safety', sev: (c) => (c.avg.crime >= 0.5 ? 'bad' : 'warn'), cd: 120, overlay: 'crime',
    when: (c) => c.mapsOn && c.pop >= 300 && c.avg.crime >= 0.3,
    title: 'Crime is rising',
    text: (c) => choose([
      `Crime is running hot at ${pct(c.avg.crime)}% in populated areas. More police coverage, now.`,
      `Crime at ${pct(c.avg.crime)}%. Police stations, a Neighborhood Watch and jobs for idle hands will cool it down.`,
    ]) },
  { key: 's_fire_cov', adv: 'safety', sev: 'warn', cd: 150, overlay: 'fire',
    when: (c) => c.mapsOn && c.pop >= 1500 && c.hasAny('fire_station', 'fire_hq') && c.avg.fire < 0.35,
    title: 'Gaps in fire coverage',
    text: (c) => `Only about ${pct(Math.min(1, c.avg.fire * 1.6))}% of neighbourhoods are well inside a fire station's reach. The rest are on their own.` },
  { key: 's_police_cov', adv: 'safety', sev: 'info', cd: 180, overlay: 'police',
    when: (c) => c.mapsOn && c.pop >= 2000 && c.hasAny('police_station', 'police_hq') && c.avg.police < 0.3,
    title: 'Thin police coverage',
    text: 'Our patrols cover too little of the city. Check the Police overlay and fill the gaps.' },
  { key: 's_burning', adv: 'safety', sev: 'warn', cd: 30, when: (c) => c.burning >= 3,
    title: 'Fires burning!',
    text: (c) => `${c.burning} buildings are ablaze right now! Fire funding is at ${pct(c.fund('fire'))}% — my crews need everything they've got.` },
  { key: 's_nuclear', adv: 'safety', sev: 'warn', cd: 240, panel: 'budget', when: (c) => c.has('nuclear_plant') && c.fund('fire') < 0.8,
    title: 'Nuclear safety',
    text: "We run a nuclear plant with an underfunded fire department. That's not a plan, that's a movie plot." },
  { key: 's_praise', adv: 'safety', sev: 'good', cd: 300, when: (c) => c.mapsOn && c.pop >= 2000 && c.avg.crime < 0.08 && c.hasAny('fire_station', 'fire_hq'),
    title: 'All quiet',
    text: ["Streets are quiet and the hoses are dry. That's how I like it.", 'Crime is low and nothing is on fire. I may take a vacation. Kidding. I never take vacations.'] },

  /* ---- Health & Education: Dr. Wellbeing ---- */
  { key: 'h_no_clinic', adv: 'health', sev: 'warn', cd: 150, when: (c) => c.pop >= 1200 && !c.hasAny('clinic', 'hospital'),
    title: 'No health care',
    text: ['No clinic in town! People are treating everything with chicken soup. Build a Medical Clinic, stat!', "We need a clinic! I've been doing house calls on a bicycle."] },
  { key: 'h_no_school', adv: 'health', sev: 'warn', cd: 150, when: (c) => c.pop >= 800 && !c.hasAny('school', 'high_school', 'library', 'university'),
    title: 'No schools',
    text: ['Our kids have nowhere to learn! An Elementary School would make the whole city smarter.', 'No school means the kids are educating themselves. Mostly about skateboarding.'] },
  { key: 'h_high_school', adv: 'health', sev: 'info', cd: 240, when: (c) => c.pop >= 4000 && c.unlocked('high_school') && !c.hasAny('high_school', 'university'),
    title: 'Time for a High School',
    text: 'Our graduates want a High School. Educated workers attract cleaner, fancier industry!' },
  { key: 'h_hospital', adv: 'health', sev: 'info', cd: 240, when: (c) => c.pop >= 8000 && c.unlocked('hospital') && !c.has('hospital'),
    title: 'A Hospital would help',
    text: 'A city this size deserves a proper Hospital. Clinics are great, but they draw the line at open-heart surgery.' },
  { key: 'h_university', adv: 'health', sev: 'info', cd: 300, when: (c) => c.pop >= 20000 && c.unlocked('university') && !c.has('university'),
    title: 'Dream big: a University',
    text: 'Imagine a University here! Brilliant minds, high-tech jobs and students who think instant noodles are a food group.' },
  { key: 'h_health_cov', adv: 'health', sev: 'warn', cd: 150, overlay: 'health',
    when: (c) => c.mapsOn && c.pop >= 2000 && c.hasAny('clinic', 'hospital') && c.avg.health < 0.35,
    title: 'Patchy health coverage',
    text: 'Too many neighbourhoods are far from a clinic. Check the Health overlay — the red bits are sniffling.' },
  { key: 'h_edu_cov', adv: 'health', sev: 'info', cd: 180, overlay: 'edu',
    when: (c) => c.mapsOn && c.pop >= 2000 && c.hasAny('school', 'high_school', 'library', 'university') && c.avg.edu < 0.35,
    title: 'Education gaps',
    text: 'Many kids live too far from a school. More schools and libraries raise land value too!' },
  { key: 'h_pollution', adv: 'health', sev: 'warn', cd: 150, overlay: 'pollution', when: (c) => c.mapsOn && c.pop >= 500 && c.homeAvg.pollution >= 0.35,
    title: 'Pollution is making people sick',
    text: 'Pollution near homes is making people sick. Coughing is not a hobby! Keep industry away from houses.' },
  { key: 'h_praise', adv: 'health', sev: 'good', cd: 300, when: (c) => c.mapsOn && c.pop >= 3000 && c.avg.health >= 0.55 && c.avg.edu >= 0.55,
    title: 'Healthy and wise',
    text: ['Healthy bodies, curious minds! I prescribe more of the same.', 'Check-ups are clean and test scores are up. I could cry. Happy tears, medically speaking.'] },

  /* ---- Environment: Fern Greenleaf ---- */
  { key: 'e_pollution', adv: 'environment', sev: (c) => (c.homeAvg.pollution >= 0.45 ? 'bad' : 'warn'), cd: 120, overlay: 'pollution',
    when: (c) => c.mapsOn && c.pop >= 300 && c.homeAvg.pollution >= 0.25,
    title: 'Dirty air',
    text: (c) => choose([
      `The air over our homes tastes like pennies (${pct(c.homeAvg.pollution)}% pollution). Move industry away, plant trees, or pass the Clean Air Act.`,
      "The sky is supposed to be blue, not beige. Let's get pollution away from where people live.",
    ]) },
  { key: 'e_coal', adv: 'environment', sev: 'info', cd: 300, when: (c) => c.has('coal_plant') && c.pop >= 8000 && (c.unlocked('gas_plant') || c.unlocked('solar_farm')),
    title: 'Retire the coal plant?',
    text: 'That coal plant is a dragon made of soot. Wind, solar or gas would love to replace it.' },
  { key: 'e_garbage', adv: 'environment', sev: 'warn', cd: 120, when: (c) => c.pop >= 1500 && !c.hasAny('landfill', 'incinerator', 'recycling'),
    title: 'Garbage is piling up',
    text: ["Trash is piling up with nowhere to go. A Landfill isn't glamorous, but neither are rats.", 'The garbage has started forming its own neighbourhood association. Build a Landfill!'] },
  { key: 'e_garbage_cov', adv: 'environment', sev: 'warn', cd: 150, overlay: 'garbage',
    when: (c) => c.mapsOn && c.pop >= 3000 && c.hasAny('landfill', 'incinerator', 'recycling') && c.avg.garbage < 0.3,
    title: 'Missed pickups',
    text: 'Garbage trucks can’t reach every street. Another landfill or recycling center would help.' },
  { key: 'e_parks', adv: 'environment', sev: 'info', cd: 180, when: (c) => c.pop >= 1500 && c.parks < c.pop / 1500,
    title: 'More green, please',
    text: ['People need green! Sprinkle parks and playgrounds between the homes — land value blooms too.', 'A city without parks is just a very large parking lot. Plant some joy!'] },
  { key: 'e_noise', adv: 'environment', sev: 'info', cd: 240, overlay: 'noise', when: (c) => c.mapsOn && c.pop >= 1000 && c.homeAvg.noise >= 0.35,
    title: 'Too noisy',
    text: 'Homes are too close to the racket. Buffer them with parks or move the noisy stuff.' },
  { key: 'e_praise', adv: 'environment', sev: 'good', cd: 300, when: (c) => c.mapsOn && c.pop >= 3000 && c.avg.pollution < 0.08,
    title: 'Clean and green',
    text: ['Birds are singing, the sky is blue. I could hug this whole city.', 'Our air is so clean the trees are sending thank-you notes.'] },

  /* ---- Transport: Rhoda Gridlock ---- */
  { key: 't_start', adv: 'transport', sev: 'info', cd: 99999, when: (c) => c.roads === 0 && c.pop === 0 && c.day < 90 + 90,
    title: 'Welcome, Mayor!',
    text: 'Every great city starts with a single road. Draw one and we’ll get moving — I’ll be here, complaining about traffic.' },
  { key: 't_jams', adv: 'transport', sev: (c) => (c.jamFrac >= 0.2 ? 'bad' : 'warn'), cd: 120, overlay: 'traffic',
    when: (c) => c.mapsOn && c.roads > 50 && c.jamFrac >= 0.1,
    title: 'Traffic jams',
    text: (c) => choose([
      `${pct(c.jamFrac)}% of our roads are parking lots at rush hour. Avenues, transit, or a time machine — pick one.`,
      `Gridlock on ${pct(c.jamFrac)}% of roads. I didn't pick my name, but I'm starting to live up to it.`,
    ]) },
  { key: 't_transit', adv: 'transport', sev: 'info', cd: 240, when: (c) => c.pop >= 5000 && c.unlocked('bus_depot') && !c.hasAny('bus_depot', 'metro_station'),
    title: 'No public transit',
    text: (c) => `Not a single bus in a city of ${num(c.pop)}? Everyone's driving. Everyone. A Bus Depot would help.` },
  { key: 't_avenue', adv: 'transport', sev: 'info', cd: 300, when: (c) => c.mapsOn && c.unlocked('avenue') && c.roadType[2] < 12 && c.jamFrac >= 0.05,
    title: 'Try avenues',
    text: 'Avenues carry nearly three times the traffic of streets. Upgrade the busiest routes.' },
  { key: 't_potholes', adv: 'transport', sev: 'warn', cd: 120, panel: 'budget', when: (c) => c.roads > 20 && c.fund('roads') < 0.6,
    title: 'Potholes',
    text: (c) => `Road maintenance is at ${pct(c.fund('roads'))}%. The potholes are developing personalities.` },
  { key: 't_praise', adv: 'transport', sev: 'good', cd: 300, when: (c) => c.mapsOn && c.pop >= 5000 && c.roads > 100 && c.jamFrac < 0.02,
    title: 'Smooth sailing',
    text: ["Traffic is flowing like butter. I'm almost out of a job.", 'Green lights everywhere. Someone check if the cars are real.'] },

  /* ---- Utilities: Watt Flowmore ---- */
  { key: 'u_no_power', adv: 'utilities', sev: 'bad', cd: 60, overlay: 'power', when: (c) => c.powerCap === 0 && (c.growN > 0 || c.zoned >= 16),
    title: 'No power plant!',
    text: ["We have zones but zero power plants. Buildings won't grow in the dark! Build a Coal Plant or some Wind Turbines.", 'No power plant yet! Without electricity this city is just a very ambitious campsite.'] },
  { key: 'u_power_short', adv: 'utilities', sev: 'bad', cd: 75, overlay: 'power', when: (c) => c.st.powerDemand > c.st.powerSupply && c.st.powerDemand > 0,
    title: 'Power shortage!',
    text: (c) => choose([
      `Demand (${num(c.st.powerDemand)} MW) exceeds supply (${num(c.st.powerSupply)} MW)! Brownouts incoming. I'm positively de-volted.`,
      `We're ${num(c.st.powerDemand - c.st.powerSupply)} MW short. Build another plant before the lights go out — watt are we waiting for?`,
    ]) },
  { key: 'u_power_margin', adv: 'utilities', sev: 'warn', cd: 120, overlay: 'power',
    when: (c) => c.st.powerDemand > 50 && c.st.powerDemand <= c.st.powerSupply && c.st.powerDemand > c.st.powerSupply * 0.9,
    title: 'Power running tight',
    text: (c) => `We're using ${pct(c.st.powerDemand / c.st.powerSupply)}% of our power capacity. Build another plant before the next growth spurt.` },
  { key: 'u_no_water', adv: 'utilities', sev: 'warn', cd: 90, overlay: 'water', when: (c) => c.waterCap === 0 && (c.growN >= 20 || c.pop >= 300),
    title: 'No water supply',
    text: 'No water supply! A Water Pump by the shore or a Water Tower anywhere will get things flowing.' },
  { key: 'u_water_short', adv: 'utilities', sev: 'bad', cd: 75, overlay: 'water', when: (c) => c.st.waterDemand > c.st.waterSupply && c.st.waterDemand > 0,
    title: 'Water shortage!',
    text: (c) => `Water demand (${num(c.st.waterDemand)} kL) is more than we pump (${num(c.st.waterSupply)} kL). Taps are sputtering!` },
  { key: 'u_water_margin', adv: 'utilities', sev: 'warn', cd: 120, overlay: 'water',
    when: (c) => c.st.waterDemand > 50 && c.st.waterDemand <= c.st.waterSupply && c.st.waterDemand > c.st.waterSupply * 0.9,
    title: 'Water running tight',
    text: (c) => `Water use is at ${pct(c.st.waterDemand / c.st.waterSupply)}% of capacity. Another pump would keep things flowing.` },
  { key: 'u_unpowered', adv: 'utilities', sev: 'warn', cd: 120, overlay: 'power',
    when: (c) => c.flagsOn && c.powerCap > 0 && c.unpowered >= Math.max(5, c.growN * 0.1) && !(c.st.powerDemand > c.st.powerSupply),
    title: 'Buildings off the grid',
    text: (c) => `${num(c.unpowered)} buildings aren't connected to the grid. Run power lines to them — a current event, if you will.` },
  { key: 'u_unwatered', adv: 'utilities', sev: 'info', cd: 150, overlay: 'water',
    when: (c) => c.flagsOn && c.waterCap > 0 && c.unwatered >= Math.max(8, c.growN * 0.15) && !(c.st.waterDemand > c.st.waterSupply),
    title: 'Dry neighbourhoods',
    text: (c) => `${num(c.unwatered)} buildings have no running water. Extend the network or add a water tower nearby.` },
  { key: 'u_praise', adv: 'utilities', sev: 'good', cd: 300,
    when: (c) => c.st.powerDemand > 100 && c.st.powerSupply >= c.st.powerDemand * 1.25 && c.st.waterSupply >= c.st.waterDemand * 1.2 && c.st.waterDemand > 0,
    title: 'Fully charged',
    text: ['Plenty of juice and plenty of water. Current affairs are excellent!', "Supply's high, demand's covered. I'm positively glowing."] },

  /* ---- Planning: Zoe Ning ---- */
  { key: 'p_start', adv: 'planning', sev: 'info', cd: 99999, when: (c) => c.zoned === 0 && c.pop === 0 && c.day < 90 + 150,
    title: 'Getting started',
    text: 'Zone Residential along your roads, add Commercial and Industrial for jobs, and give them power. Then watch it grow!' },
  { key: 'p_demand_R', adv: 'planning', sev: 'info', cd: 120, when: (c) => c.S.demand.R > 0.6 && c.day > 150,
    title: 'Citizens want more homes!',
    text: ['Residential demand is through the roof. Zone more homes near jobs and services.', 'People are lining up to move in! Zone more Residential.'] },
  { key: 'p_demand_C', adv: 'planning', sev: 'info', cd: 120, when: (c) => c.S.demand.C > 0.6 && c.day > 150,
    title: 'Shops wanted',
    text: ['Shoppers are restless — zone more Commercial, ideally near homes.', 'Commercial demand is high. Nobody likes driving across town for milk.'] },
  { key: 'p_demand_I', adv: 'planning', sev: 'info', cd: 120, when: (c) => c.S.demand.I > 0.6 && c.day > 150,
    title: 'Industry wants room',
    text: ['Industry is itching to expand. More Industrial zones — downwind, please.', 'Factories want land! Zone Industrial away from homes.'] },
  { key: 'p_demand_low', adv: 'planning', sev: 'info', cd: 240, panel: 'budget',
    when: (c) => c.pop > 500 && c.S.demand.R < -0.2 && c.S.demand.C < -0.2 && c.S.demand.I < -0.2,
    title: 'Weak demand',
    text: 'Demand is weak across the board. Lower taxes or better services will attract newcomers.' },
  { key: 'p_access', adv: 'planning', sev: 'warn', cd: 120, when: (c) => c.flagsOn && c.noAccess >= 10,
    title: 'Zones without roads',
    text: (c) => `${num(c.noAccess)} zoned tiles are too far from a street to grow. Keep zones within ${C.ROAD_ACCESS} tiles of a road.` },
  { key: 'p_unemployment', adv: 'planning', sev: 'warn', cd: 120, when: (c) => c.pop >= 1000 && c.st.unemployment >= 0.12,
    title: 'Unemployment',
    text: (c) => `Unemployment is ${pct(c.st.unemployment)}%. Zone Commercial or Industrial so people have somewhere to work.` },
  { key: 'p_labor', adv: 'planning', sev: 'info', cd: 150, when: (c) => c.pop >= 1000 && c.st.workers > 0 && c.st.jobs > c.st.workers * 1.25,
    title: 'Labour shortage',
    text: 'We have far more jobs than workers. Zone Residential to fill those positions.' },
  { key: 'p_abandoned', adv: 'planning', sev: 'warn', cd: 120, when: (c) => c.abandoned >= Math.max(5, c.growN * 0.05),
    title: 'Abandoned buildings',
    text: (c) => `${num(c.abandoned)} buildings stand abandoned. Check power, water, pollution, crime and taxes around them.` },
  { key: 'p_rubble', adv: 'planning', sev: 'info', cd: 150, when: (c) => c.rubble >= 6,
    title: 'Clear the rubble',
    text: (c) => `There's rubble in ${num(c.rubble)} places. Bulldoze it so new buildings can rise.` },
  { key: 'p_unhappy', adv: 'planning', sev: 'warn', cd: 120, when: (c) => c.pop >= 500 && c.happy < 0.4,
    title: 'Citizens are unhappy',
    text: (c) => `Happiness is down to ${pct(c.happy)}%. Services, parks, lower taxes and cleaner air all help.` },
  { key: 'p_city_hall', adv: 'planning', sev: 'info', cd: 400, when: (c) => c.pop >= 1500 && c.unlocked('city_hall') && !c.has('city_hall'),
    title: 'A City Hall?',
    text: 'Every proper town needs a City Hall. It boosts land value and civic pride — and gives you a nice office.' },
  { key: 'p_praise', adv: 'planning', sev: 'good', cd: 300, when: (c) => c.pop >= 1000 && c.happy >= 0.75,
    title: 'A city people love',
    text: (c) => `Happiness is at ${pct(c.happy)}%. People are writing songs about this place. Mostly good ones.` },
];
// Budget-cut grumbling and strikes, one pair per department.
const DEPT_ADVISOR = { police: 'safety', fire: 'safety', health: 'health', education: 'health', transit: 'transport', roads: 'transport', parks: 'environment', waste: 'environment', utilities: 'utilities' };
for (const d of VC.DEPARTMENTS) {
  RULES.push({
    key: 'strike_warn_' + d.key, adv: DEPT_ADVISOR[d.key] || 'finance', sev: 'warn', cd: 60, panel: 'budget',
    when: (c) => c.lowFund(d.key) === 2,
    title: `${d.name} staff grumbling`,
    text: `${d.name} has been under 50% funding for two months. One more and they walk off the job.`,
  });
  RULES.push({
    key: 'strike_' + d.key, adv: DEPT_ADVISOR[d.key] || 'finance', sev: 'bad', cd: 60, panel: 'budget',
    when: (c) => c.lowFund(d.key) >= 3,
    title: `${d.name} ON STRIKE`,
    text: (c) => `${d.name} workers are on strike after ${c.lowFund(d.key)} months of budget cuts. Service is crippled until funding is back above 50%.`,
  });
}

/** Generic tips per advisor, used by advice() when nothing is wrong. */
const TIPS = {
  finance: ['Taxes around 9% keep everyone content. Above 12% growth slows; above 15% people start packing.', 'Budget sliders above 100% buy diminishing returns. 100% is usually the sweet spot.', 'Loans are fine for big investments, but interest adds up. Pay them off early when flush.', 'Wealthy citizens pay far more tax. Parks, schools and clean air attract them.'],
  safety: ['A fire station covers about 14 tiles. Keep every neighbourhood inside its reach.', 'Police cut crime nearby. Dense, poor, unemployed areas need them most.', 'The Smoke Detector Program cuts fires cheaply. Just saying.'],
  health: ['Clinics keep neighbourhoods healthy; hospitals cover whole districts.', 'Education raises land value and attracts high-tech industry.', 'Libraries are cheap and people love them. So do I.'],
  environment: ['Keep industry downwind and away from homes. Parks soak up the grumbles.', 'Wind turbines love hills. Solar farms love money.', 'Recycling beats landfills once you can afford it.'],
  transport: ['Grids with an avenue every few blocks keep traffic moving.', 'Buses and metros take cars off the road — place them where it’s busiest.', 'Highways are fast but give no zone access. Connect them with streets.'],
  utilities: ['Build power before zoning — buildings won’t grow in the dark.', 'Water pumps must touch water; water towers work anywhere.', 'Power lines carry electricity across empty land.'],
  planning: ['Watch the RCI demand bars and zone whatever is highest.', 'Mix homes near shops so people can walk to work.', `Density unlocks with population: Medium at ${num(VC.DENSITY_UNLOCK[2])}, High at ${num(VC.DENSITY_UNLOCK[3])}.`],
};

/* ------------------------------------------------------------------ */
/* Messages                                                             */
/* ------------------------------------------------------------------ */
function ensureAdv(S) {
  const a = S.adv || (S.adv = {});
  if (!a.inbox) a.inbox = [];
  if (!a.news) a.news = [];
  if (!a.newsLog) a.newsLog = [];
  if (!a.cooldown) a.cooldown = {};
  if (!a.carded) a.carded = {};
  if (!a.newsCd) a.newsCd = {};
  if (!a.queue) a.queue = [];
  if (!a.recent) a.recent = [];
  if (a.nextId == null) a.nextId = 1;
  if (a.unlockPop == null) a.unlockPop = S.peakPop || 0;
  if (!a.stats) a.stats = { spent: 0 };
  if (a.prevPop == null) a.prevPop = S.stats.pop || 0;
  if (a.prevTax == null) a.prevTax = null;
  if (!S.achievements) S.achievements = {};
  return a;
}

function textOf(r, c) {
  const t = typeof r.text === 'function' ? r.text(c) : choose(r.text);
  return t;
}

/** Posts a message from an advisor. msg: {title, text, severity, key?, panel?, overlay?, x?, z?}. */
function post(advKey, msg) {
  const S = S_();
  if (!S) return null;
  const a = ensureAdv(S);
  const def = VC.ADVISORS[advKey] || VC.ADVISORS.planning;
  const m = Object.assign({
    id: a.nextId++, advisor: advKey, name: def.name, role: def.role, icon: def.icon, color: def.color,
    title: '', text: '', severity: 'info', day: S.time.day, read: false,
  }, msg);
  a.inbox.unshift(m);
  if (a.inbox.length > INBOX_CAP) a.inbox.length = INBOX_CAP;
  if (m.severity === 'warn' || m.severity === 'bad') {
    // pop a HUD card; a repeated warning within 180 days only lands in the inbox
    const k = m.key || m.title;
    const last = a.carded[k];
    if (m.severity === 'bad' || last == null || S.time.day - last >= 180) {
      a.carded[k] = S.time.day;
      VC.bus.emit('advisor', m);
      VC.bus.emit('sfx', { name: m.severity === 'bad' ? 'alert' : 'notify' });
    }
  }
  return m;
}

function monthlyAdvice(S, c) {
  const a = ensureAdv(S);
  const day = S.time.day;
  const hits = [];
  for (const r of RULES) {
    let ok = false;
    try { ok = !!r.when(c); } catch (err) { ok = false; }
    const cd = a.cooldown[r.key] || 0;
    if (!ok) {
      // a resolved problem may be reported again a month after it comes back
      if (cd > day + 30 && r.cd < 9999) a.cooldown[r.key] = day + 30;
      continue;
    }
    if (cd > day) continue;
    const sev = typeof r.sev === 'function' ? r.sev(c) : r.sev;
    hits.push({ r, sev, k: SEV_RANK[sev] * 10 + rnd() * 5 });
  }
  hits.sort((x, y) => y.k - x.k);
  const used = new Set();
  let posted = 0, problems = 0;
  for (const h of hits) {
    if (posted >= MAX_PER_MONTH) break;
    if (used.has(h.r.adv)) continue;
    if (h.sev === 'good' && (problems || rnd() < 0.5)) continue; // praise only in quiet months
    let text;
    try { text = textOf(h.r, c); } catch (err) { console.error('[advisors] rule ' + h.r.key, err); continue; }
    post(h.r.adv, { key: h.r.key, title: h.r.title, text, severity: h.sev, panel: h.r.panel, overlay: h.r.overlay });
    a.cooldown[h.r.key] = day + h.r.cd;
    used.add(h.r.adv);
    posted++;
    if (h.sev === 'warn' || h.sev === 'bad') problems++;
  }
}

/* ------------------------------------------------------------------ */
/* News                                                                 */
/* ------------------------------------------------------------------ */
function emitNews(text, force) {
  const S = S_();
  if (!S || !text) return;
  const a = ensureAdv(S);
  // at most 2 headlines a day: extra event news is queued for the following days
  if (a.newsDay !== S.time.day) { a.newsDay = S.time.day; a.newsDayCount = 0; }
  if (!force && a.newsDayCount >= 2) {
    a.queue.push({ day: S.time.day + a.newsDayCount - 1, text });
    a.queue.sort((x, y) => x.day - y.day);
    a.newsDayCount++;
    return;
  }
  a.newsDayCount++;
  a.news.unshift(text);
  if (a.news.length > NEWS_CAP) a.news.length = NEWS_CAP;
  a.newsLog.unshift({ text, day: S.time.day });
  if (a.newsLog.length > NEWS_CAP) a.newsLog.length = NEWS_CAP;
  A.news = a.news;
  VC.bus.emit('news', { text });
}
function headline(key, vars) {
  const bank = HL().CTX[key];
  if (!bank || !bank.length) return null;
  return HL().fill(choose(bank), vars || {}, rnd);
}
/** Random evergreen headline, avoiding the last ~60 used. */
function randomHeadline(S) {
  const a = ensureAdv(S);
  const pool = HL().POOL;
  let i = 0;
  for (let k = 0; k < 12; k++) {
    i = Math.floor(rnd() * pool.length);
    if (a.recent.indexOf(i) < 0) break;
  }
  a.recent.push(i);
  if (a.recent.length > Math.min(60, pool.length >> 1)) a.recent.shift();
  return HL().fill(pool[i], {}, rnd);
}
const NICE_POP = [];
for (const base of [1, 2.5, 5, 7.5]) for (let e = 2; e <= 6; e++) NICE_POP.push(Math.round(base * Math.pow(10, e)));
NICE_POP.sort((x, y) => x - y);
while (NICE_POP[0] < 500) NICE_POP.shift(); // "population hits 250!" is not news

/** Builds 2-4 headlines for the coming month and schedules them over its days. */
function monthlyNews(S, c) {
  const a = ensureAdv(S);
  const day = S.time.day;
  const ctx = [];
  const add = (key, vars, cd = 90) => {
    if ((a.newsCd[key] || 0) > day) return;
    const t = headline(key, vars);
    if (t) ctx.push({ key, t, cd });
  };
  const pop = c.pop;
  // population round numbers
  const crossed = NICE_POP.filter((p) => a.prevPop < p && pop >= p);
  if (crossed.length) { a.newsCd.popUp = 0; add('popUp', { pop: num(crossed[crossed.length - 1]) }, 0); }
  else if (a.prevPop > 1000 && pop < a.prevPop * 0.93) add('popDown', { pop: num(pop) }, 180);
  a.prevPop = pop;
  // taxes
  if (a.prevTax != null) {
    if (c.taxAvg >= a.prevTax + 1) add('taxUp', {}, 60);
    else if (c.taxAvg <= a.prevTax - 1) add('taxDown', {}, 60);
  }
  a.prevTax = c.taxAvg;
  // the state of things
  if (c.mapsOn) {
    if (c.roads > 50 && c.jamFrac >= 0.12) add('traffic', {}, 120);
    else if (c.roads > 150 && c.jamFrac < 0.02 && pop > 5000) add('trafficGood', {}, 360);
    if (c.has('coal_plant') && c.avg.pollution >= 0.25) add('smog', {}, 150);
    else if (c.homeAvg.pollution >= 0.3) add('pollution', {}, 150);
    else if (pop > 3000 && c.avg.pollution < 0.06) add('clean', {}, 360);
    if (c.avg.crime >= 0.35) add('crime', {}, 120);
    else if (pop > 3000 && c.avg.crime < 0.05) add('safe', {}, 360);
  }
  if (pop >= 1000 && c.st.unemployment >= 0.12) add('unemployment', { unemp: pct(c.st.unemployment) }, 150);
  if (pop >= 1000 && c.st.workers > 0 && c.st.jobs > c.st.workers * 1.3) add('laborShortage', {}, 240);
  if (pop >= 500 && c.happy >= 0.78) add('happy', { happy: pct(c.happy) }, 240);
  if (pop >= 500 && c.happy < 0.4) add('unhappy', { approval: pct(c.st.approval == null ? c.happy : c.st.approval) }, 150);
  if (!S.sandbox) {
    if (S.money < 0) add('deficit', {}, 120);
    else if (c.net > 1000 && S.money > 100000) add('surplus', {}, 240);
  }
  if (c.st.powerDemand > c.st.powerSupply && c.st.powerDemand > 0) add('blackout', {}, 90);
  else if (c.powerCap === 0 && c.growN > 10) add('noPower', {}, 240);
  if (c.st.waterDemand > c.st.waterSupply && c.st.waterDemand > 0) add('waterShort', {}, 90);
  if (pop >= 2500 && !c.hasAny('landfill', 'incinerator', 'recycling')) add('garbage', {}, 180);
  if (c.burning >= 4) add('fires', {}, 60);
  // weather & seasons
  const w = S.weather || {};
  if (w.type === 'rain') add('rain', {}, 60);
  else if (w.type === 'storm') add('storm', {}, 60);
  else if (w.type === 'snow') add('snow', {}, 90);
  else if (w.type === 'fog') add('fog', {}, 90);
  const m = Math.floor(day / C.DAYS_PER_MONTH) % 12;
  if (m === 2) add('spring', {}, 300);
  else if (m === 5) add('summer', {}, 300);
  else if (m === 8) add('autumn', {}, 300);
  else if (m === 11) add('winter', {}, 300);
  if ((m === 6 || m === 7) && w.type !== 'rain' && w.type !== 'storm' && rnd() < 0.4) add('heat', {}, 300);

  // pick up to 2 context headlines + fill with evergreen ones (2-4 total)
  for (let i = ctx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = ctx[i]; ctx[i] = ctx[j]; ctx[j] = t; }
  // round-number population news always wins a slot
  ctx.sort((x, y) => (y.key === 'popUp') - (x.key === 'popUp'));
  const total = 2 + Math.floor(rnd() * 3);
  const out = [];
  for (const it of ctx.slice(0, 2)) { out.push(it.t); a.newsCd[it.key] = day + it.cd; }
  while (out.length < total) out.push(randomHeadline(S));
  // spread over the coming month
  const slots = out.length;
  for (let k = 0; k < slots; k++) {
    const at = day + 1 + Math.floor(((k + rnd() * 0.8) / slots) * (C.DAYS_PER_MONTH - 2));
    a.queue.push({ day: at, text: out[k] });
  }
  a.queue.sort((x, y) => x.day - y.day);
  if (a.queue.length > 12) a.queue.splice(0, a.queue.length - 12);
}

/* ------------------------------------------------------------------ */
/* Milestones & unlocks                                                 */
/* ------------------------------------------------------------------ */
function cityCentre(S) {
  const ch = [...S.buildings.values()].find((b) => b.key === 'city_hall');
  if (ch) return [ch.x + ch.w / 2, ch.z + ch.d / 2];
  let x = 0, z = 0, n = 0;
  for (const b of S.buildings.values()) { if (b.key === 'rubble') continue; x += b.x + b.w / 2; z += b.z + b.d / 2; n++; }
  return n ? [x / n, z / n] : [S.W / 2, S.H / 2];
}
function checkMilestones(S) {
  const a = ensureAdv(S);
  if ((S.stats.pop || 0) > (S.peakPop || 0)) S.peakPop = S.stats.pop;
  const peak = S.peakPop || 0;
  const MS = VC.MILESTONES;
  if (S.milestone == null) S.milestone = 0;
  while (S.milestone + 1 < MS.length && peak >= MS[S.milestone + 1].pop) {
    S.milestone++;
    const ms = MS[S.milestone];
    if (ms.reward && !S.sandbox) VC.money.earn(ms.reward, 'reward');
    VC.bus.emit('milestone', { index: S.milestone, milestone: ms });
    VC.bus.emit('toast', { text: `<b>${S.name}</b> is now a <b>${ms.name}</b>!${ms.reward ? ` Reward: <b>${money(ms.reward)}</b>` : ''}`, type: 'good', icon: '🏆' });
    VC.bus.emit('sfx', { name: 'milestone' });
    emitNews(headline('milestone', { milestone: ms.name }));
    post('planning', { key: 'milestone', severity: 'good', title: `${ms.name}!`, text: `We crossed ${num(ms.pop)} citizens and the council granted ${money(ms.reward)}. Onward!`, panel: 'milestones' });
    if (VC.fx && VC.fx.fireworks) {
      const [cx, cz] = cityCentre(S);
      try { VC.fx.fireworks(cx, cz, 10 + S.milestone * 3); } catch (err) { /* fx optional */ }
    }
  }
  if (!S.sandbox && peak > a.unlockPop) {
    const items = unlocksBetween(a.unlockPop, peak);
    a.unlockPop = peak;
    if (items.length) {
      const names = items.map((u) => u.name);
      const shown = names.length > 5 ? names.slice(0, 5).join(', ') + ` +${names.length - 5} more` : names.join(', ');
      VC.bus.emit('toast', { text: `<b>New:</b> ${shown} unlocked`, type: 'good', icon: '🔓', duration: 6000 });
      post('planning', { key: 'unlock', severity: 'info', title: 'New options unlocked', text: 'Now available: ' + names.join(', ') + '.' });
      emitNews(headline('unlock', { things: names.slice(0, 2).join(' and ') }));
      VC.bus.emit('unlocked', { items });
    }
  }
}
/** Everything whose unlock threshold lies in (p0, p1]. */
function unlocksBetween(p0, p1) {
  const out = [];
  const inRange = (u) => u > p0 && u <= p1;
  for (const d of VC.CATALOG) if (inRange(d.unlock || 0)) out.push({ kind: 'building', key: d.key, name: d.name, icon: d.icon, unlock: d.unlock });
  for (const t in VC.ROADS) { const r = VC.ROADS[t]; if (inRange(r.unlock || 0)) out.push({ kind: 'road', key: r.key, name: r.name, icon: r.icon, unlock: r.unlock }); }
  for (const d in VC.DENSITY_UNLOCK) if (inRange(VC.DENSITY_UNLOCK[d])) out.push({ kind: 'zone', key: 'density' + d, name: VC.DENSITY[d] + ' density zones', icon: '🏙️', unlock: VC.DENSITY_UNLOCK[d] });
  for (const p of VC.POLICIES) if (inRange(p.unlock || 0)) out.push({ kind: 'policy', key: p.key, name: p.name + ' policy', icon: p.icon, unlock: p.unlock });
  out.sort((x, y) => x.unlock - y.unlock);
  return out;
}

/* ------------------------------------------------------------------ */
/* Achievements                                                         */
/* check(c) runs monthly (c = snapshot); event-driven ones are granted from bus handlers.            */
/* noSandbox: not available in sandbox (infinite money)                                              */
/* ------------------------------------------------------------------ */
const survivedAll = (S) => VC.disasters && VC.disasters.TYPES.every((t) => S.disasterStats && S.disasterStats.survived && S.disasterStats.survived[t.key]);
const ACH = [
  { key: 'first_road', name: 'Paving the Way', icon: '🛣️', desc: 'Build your first road.' },
  { key: 'first_home', name: 'Welcome Home', icon: '🏡', desc: 'Your first residents move in.' },
  { key: 'first_job', name: 'Open for Business', icon: '🏪', desc: 'Your first shop or factory opens.' },
  { key: 'pop_1k', name: 'Town Pride', icon: '👥', desc: 'Reach 1,000 citizens.', check: (c) => c.pop >= 1000 },
  { key: 'pop_10k', name: 'Big City Lights', icon: '🏙️', desc: 'Reach 10,000 citizens.', check: (c) => c.pop >= 10000 },
  { key: 'pop_50k', name: 'Metropolis Now', icon: '🌆', desc: 'Reach 50,000 citizens.', check: (c) => c.pop >= 50000 },
  { key: 'pop_100k', name: 'Megacity', icon: '🌃', desc: 'Reach 100,000 citizens.', check: (c) => c.pop >= 100000 },
  { key: 'full_power', name: 'Fully Charged', icon: '⚡', desc: 'Every building powered, with 100+ buildings and spare capacity.',
    check: (c) => c.growN >= 100 && c.unpowered === 0 && c.powerCap > 0 && c.st.powerSupply >= c.st.powerDemand && c.flagsOn },
  { key: 'full_water', name: 'Hydrated', icon: '💧', desc: 'Every building has running water (100+ buildings).',
    check: (c) => c.growN >= 100 && c.unwatered === 0 && c.waterCap > 0 && c.st.waterSupply >= c.st.waterDemand && c.flagsOn },
  { key: 'balanced', name: 'Balanced Books', icon: '📒', desc: '12 months in a row without a deficit.', noSandbox: true, check: (c) => (c.econ.balancedMonths || 0) >= 12 },
  { key: 'zero_crime', name: 'Zero Crime District', icon: '😇', desc: '25+ homes with virtually no crime.',
    check: (c) => c.mapsOn && c.pop >= 2000 && c.hasAny('police_station', 'police_hq') && zeroCrimeHomes(c.S) >= 25 },
  { key: 'parks_100', name: 'Green Thumb', icon: '🌳', desc: 'Build 100 parks.', check: (c) => c.parks >= 100 },
  { key: 'first_disaster', name: 'Baptism by Fire', icon: '🧯', desc: 'Survive your first disaster.' },
  { key: 'survivor', name: 'Unbreakable', icon: '🛡️', desc: 'Survive every type of disaster.', check: (c) => survivedAll(c.S) },
  { key: 'millionaire', name: 'Millionaire', icon: '💰', desc: 'Have $1,000,000 in the treasury.', noSandbox: true, check: (c) => c.money >= 1e6 },
  { key: 'first_loan', name: 'Credit Where Due', icon: '🏦', desc: 'Take out your first loan.', noSandbox: true, check: (c) => !!c.econ.hadLoan },
  { key: 'debt_free', name: 'Debt Free', icon: '🕊️', desc: 'Pay off every loan you took.', noSandbox: true, check: (c) => !!c.econ.hadLoan && !c.S.loans.length },
  { key: 'comeback', name: 'Comeback Kid', icon: '🔥', desc: 'Recover from bankruptcy: back above $25,000 after an emergency loan.', noSandbox: true, check: (c) => !!c.econ.recovered },
  { key: 'eco_city', name: 'Eco City', icon: '🌿', desc: '5,000+ citizens, no coal power and clean air.',
    check: (c) => c.mapsOn && c.pop >= 5000 && !c.has('coal_plant') && c.avg.pollution < 0.08 && c.powerCap > 0 },
  { key: 'clean_energy', name: 'Clean Energy', icon: '☀️', desc: 'Power 2,000+ citizens using only renewables.',
    check: (c) => c.pop >= 2000 && c.renewCap > 0 && c.fossilCap === 0 && c.st.powerSupply >= c.st.powerDemand },
  { key: 'big_spender', name: 'Big Spender', icon: '💸', desc: 'Spend $500,000 on construction.', noSandbox: true, check: (c) => (c.S.adv.stats.spent || 0) >= 500000 },
  { key: 'night_owl', name: 'Night Owl', icon: '🦉', desc: 'Run your city between midnight and 4 a.m. (real time!).', check: () => new Date().getHours() < 4 },
  { key: 'happy_city', name: 'Utopia', icon: '😊', desc: 'Happiness above 85% with 5,000+ citizens.', check: (c) => c.pop >= 5000 && c.happy >= 0.85 },
  { key: 'tax_haven', name: 'Tax Haven', icon: '🎈', desc: '3,000+ citizens with every tax at 5% or less.', noSandbox: true, check: (c) => c.pop >= 3000 && c.taxMax <= 5 },
  { key: 'tourist_trap', name: 'Tourist Trap', icon: '📸', desc: 'Earn $3,000 from tourism in one month.', check: (c) => (c.S.ledger.last.tourism || 0) >= 3000 },
  { key: 'policy_wonk', name: 'Policy Wonk', icon: '📜', desc: 'Have 8 policies active at once.', check: (c) => Object.keys(c.S.policies).filter((k) => c.S.policies[k]).length >= 8 },
  { key: 'full_service', name: 'Full Service', icon: '🏥', desc: 'Police, fire, health, school, park, transit and waste all in service.',
    check: (c) => ['police', 'fire', 'health', 'education', 'parks', 'transit', 'waste'].every((d) => (c.dept[d] || 0) > 0) },
  { key: 'wonders', name: 'Wonder Builder', icon: '🏛️', desc: 'Build 5 different landmarks.', check: (c) => VC.CATALOG.filter((d) => d.group === 'landmarks' && c.has(d.key)).length >= 5 },
  { key: 'smooth_traffic', name: 'Smooth Operator', icon: '🚦', desc: '10,000+ citizens and virtually no traffic jams.', check: (c) => c.mapsOn && c.pop >= 10000 && c.roads > 100 && c.jamFrac < 0.01 },
  { key: 'full_employment', name: 'Full Employment', icon: '💼', desc: 'Unemployment under 3% with 5,000+ citizens.', check: (c) => c.pop >= 5000 && c.st.workers > 0 && c.st.unemployment < 0.03 },
  { key: 'abducted', name: 'Close Encounters', icon: '👽', desc: 'Lose a building to alien abduction.' },
  { key: 'cubezilla', name: 'Monster Mash', icon: '🦖', desc: 'Survive a Cubezilla rampage.' },
  { key: 'nuclear', name: 'Splitting Atoms', icon: '☢️', desc: 'Build a nuclear power plant.', check: (c) => c.has('nuclear_plant') },
  { key: 'to_the_stars', name: 'To the Stars', icon: '🚀', desc: 'Build the Space Center.', check: (c) => c.has('space_center') },
  { key: 'decade', name: 'Decade in Office', icon: '🗓️', desc: 'Govern for 10 years.', check: (c) => (c.econ.months || 0) >= 120 },
  { key: 'ecumenopolis', name: 'Ecumenopolis', icon: '🌐', desc: 'Reach the final milestone.', check: (c) => (c.S.milestone || 0) >= VC.MILESTONES.length - 1 },
];
const ACH_BY = {};
for (const a of ACH) ACH_BY[a.key] = a;

function zeroCrimeHomes(S) {
  const crime = S.maps.crime;
  let n = 0;
  for (const b of S.buildings.values()) if (b.key === 'grow' && b.zt === 1 && !b.abandoned && b.pop > 0 && crime[b.z * S.W + b.x] < 8) n++;
  return n;
}

function grant(key) {
  const S = S_();
  const def = ACH_BY[key];
  if (!S || !def || !S.adv) return false;
  if (S.achievements[key] != null) return false;
  if (def.noSandbox && S.sandbox) return false;
  S.achievements[key] = S.time.day;
  const info = { key, name: def.name, icon: def.icon, desc: def.desc };
  VC.bus.emit('achievement', info);
  VC.bus.emit('sfx', { name: 'achievement' });
  if (A.toastAchievements) VC.bus.emit('toast', { text: `Achievement unlocked: <b>${def.name}</b><br><small>${def.desc}</small>`, type: 'good', icon: def.icon, duration: 5000 });
  if (rnd() < 0.5) emitNews(headline('achievement', { achievement: def.name }));
  return true;
}
function checkAchievements(c) {
  const S = c.S;
  for (const a of ACH) {
    if (!a.check || S.achievements[a.key] != null) continue;
    let ok = false;
    try { ok = a.check(c); } catch (err) { ok = false; }
    if (ok) grant(a.key);
  }
}

/* ------------------------------------------------------------------ */
/* Event handlers                                                       */
/* ------------------------------------------------------------------ */
const DISASTER_LINES = {
  fire: ['Major fire outbreak! My crews are rolling. If it spreads, it’s because we’re short on stations.', 'Multiple buildings burning! Every truck we have is on its way.'],
  tornado: ['Twister on the ground! Nothing to do but hold on to your hats — and your houses.', 'Tornado! Keep the fire department funded; there’ll be fires in its wake.'],
  meteor: ['Something big is falling out of the sky. I suggest not being under it.', 'Incoming meteor! I’d evacuate, but it’s moving faster than my paperwork.'],
  earthquake: ['The ground is moving! Expect collapses and fires. Crews on standby.', 'EARTHQUAKE! Duck, cover, and please stop building on fault lines.'],
  ufo: ['Uh, Mayor? There’s a flying saucer over town. I don’t have a procedure for this.', 'A UFO is abducting buildings. My hoses don’t reach that high.'],
  monster: ['CUBEZILLA! My hoses are not rated for giant lizards. Stay clear of its path!', 'A giant voxel lizard is stomping through town. This was NOT in the training manual.'],
};

function onDisaster(ev) {
  const S = S_();
  if (!S || !S.adv) return;
  const type = ev.type;
  if (ev.phase === 'start') {
    post('safety', { key: 'disaster_' + type, severity: 'bad', title: `${ev.icon || '⚠️'} ${ev.name || type}!`, text: choose(DISASTER_LINES[type] || ['Disaster!']), panel: 'disasters', x: ev.x, z: ev.z });
    emitNews(headline(type + '_start', { magnitude: ev.entry && ev.entry.magnitude ? ev.entry.magnitude.toFixed(1) : '6' }));
  } else if (ev.phase === 'update') {
    if (ev.what === 'impact') emitNews(headline('meteor_impact'));
    else if (ev.what === 'abduct') {
      grant('abducted');
      emitNews(headline('ufo_abduct', { building: ev.buildingName ? 'the ' + ev.buildingName : 'a building' }));
    }
  } else if (ev.phase === 'end') {
    grant('first_disaster');
    if (type === 'monster') grant('cubezilla');
    if (survivedAll(S)) grant('survivor');
    emitNews(headline(type + '_end', { destroyed: num(ev.destroyed || 0), abducted: num(ev.abducted || 0) }));
  }
}

let lastBuildNews = -999;
function onBldAdd(b) {
  const S = S_();
  if (!S || !S.adv || !A._live) return;
  if (b.key === 'grow') {
    if (b.zt === 1) grant('first_home');
    else if (b.zt === 2 || b.zt === 3) grant('first_job');
    return;
  }
  const def = VC.BLD[b.key];
  if (!def) return;
  if (b.key === 'nuclear_plant') grant('nuclear');
  if (b.key === 'space_center') grant('to_the_stars');
  // grand openings for landmarks and big-ticket civic buildings (throttled)
  if ((def.group === 'landmarks' || def.cost >= 12000) && S.time.day - lastBuildNews >= 5) {
    lastBuildNews = S.time.day;
    emitNews(headline('building', { building: def.name }));
  }
}

function onPolicy(key) {
  const S = S_();
  const def = VC.POLICY[key];
  if (!S || !S.adv || !def || !A._live) return;
  const on = !!S.policies[key];
  const k = 'pol_' + key;
  if ((S.adv.newsCd[k] || 0) > S.time.day) return; // no spam when toggling back and forth
  S.adv.newsCd[k] = S.time.day + 20;
  emitNews(headline(on ? 'policyOn' : 'policyOff', { policy: def.name }));
}

function onLoan(l) {
  const S = S_();
  if (!S || !S.adv || !A._live) return;
  if (l && l.amount) {
    grant('first_loan');
    emitNews(headline(l.emergency ? 'broke' : 'loan', { amount: money(l.amount) }));
  } else if (!S.loans.length && S.econ && S.econ.hadLoan) {
    grant('debt_free');
    emitNews(headline('loanRepaid'));
  }
}

const CAPITAL = { construction: 1, roads: 1, zoning: 1, terraform: 1, trees: 1, pline: 1, demolish: 1 };
function onMoney(m) {
  const S = S_();
  if (!S || !S.adv || !(m.amount < 0) || !CAPITAL[m.cat]) return;
  S.adv.stats.spent = (S.adv.stats.spent || 0) + -m.amount;
  if (S.adv.stats.spent >= 500000) grant('big_spender');
}

function onMonth() {
  const S = S_();
  if (!S) return;
  ensureAdv(S);
  checkMilestones(S);
  const c = gather(true);
  monthlyAdvice(S, c);
  monthlyNews(S, c);
  checkAchievements(c);
}

function onYear(year) {
  const S = S_();
  if (!S || !S.adv) return;
  const H = S.history || {};
  const pops = H.pop || [];
  const prev = pops.length > 12 ? pops[pops.length - 13] : 0; // a year ago (if we have that much history)
  const pop = S.stats.pop || 0;
  const growth = prev > 0 ? ` (${pop >= prev ? '+' : ''}${pct((pop - prev) / prev)}%)` : '';
  const sum = (k) => (H[k] || []).slice(-12).reduce((x, y) => x + y, 0);
  const inc = sum('income'), exp = sum('expenses');
  post('finance', {
    key: 'annual', severity: 'info', panel: 'stats', title: `Annual report ${year - 1}`,
    text: `Population ${num(pop)}${growth}. Income ${money(inc)}, expenses ${money(exp)}, ` +
      `${inc - exp >= 0 ? 'surplus' : 'deficit'} ${money(Math.abs(inc - exp))}. Treasury: ${money(S.money)}.`,
  });
}

function onDay() {
  const S = S_();
  if (!S || !S.adv) return;
  checkMilestones(S);
  const q = S.adv.queue;
  let n = 0;
  while (q.length && q[0].day <= S.time.day && n++ < 2) emitNews(q.shift().text, true);
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */
const A = (VC.advisors = {
  inbox: [],
  news: [],
  RULES,
  ACHIEVEMENTS: ACH,
  /** Set false if the HUD shows its own achievement popups (bus 'achievement'). */
  toastAchievements: true,
  _live: false,

  init() {
    const safe = (fn) => (arg) => { try { fn(arg); } catch (err) { console.error('[advisors]', err); } };
    VC.bus.on('month', safe(onMonth));
    VC.bus.on('year', safe(onYear));
    VC.bus.on('day', safe(onDay));
    VC.bus.on('disaster', safe(onDisaster));
    VC.bus.on('bldAdd', safe(onBldAdd));
    VC.bus.on('policyChanged', safe(onPolicy));
    VC.bus.on('loanChanged', safe(onLoan));
    VC.bus.on('money', safe(onMoney));
    VC.bus.on('econ', safe((ev) => { if (ev && ev.type === 'strike') emitNews(headline('strike', { dept: ev.name })); }));
    VC.bus.on('built', safe((e) => { if (e && e.kind === 'road') grant('first_road'); }));
    VC.bus.on('mapsUpdated', () => { sawMaps = true; });
    VC.bus.on('flagsUpdated', () => { sawFlags = true; });
    VC.bus.on('started', () => { A._live = true; });
    VC.bus.on('newGame', () => {
      // a fresh city gets a welcome note
      const S = S_();
      if (S && S.adv && !S.adv.welcomed) {
        S.adv.welcomed = true;
        post('planning', { key: 'welcome', severity: 'info', title: `Welcome to ${S.name}!`, text: 'Your advisors are standing by. Roads first, then zones, power and water — we’ll shout if anything goes wrong.' });
      }
    });
  },

  reset(S) {
    A._live = false; // ignore bldAdd storms while a game is being set up
    rnd = M.rng((S.seed ^ 0xad715) + S.time.day);
    sawMaps = false; sawFlags = false;
    ctxCache = null;
    lastBuildNews = -999;
    const a = ensureAdv(S);
    A.inbox = a.inbox;
    A.news = a.news;
  },

  update() {},

  /** Inbox, newest first. */
  messages() {
    return A.inbox;
  },
  unreadCount() {
    let n = 0;
    for (const m of A.inbox) if (!m.read) n++;
    return n;
  },
  /** Marks a message (id) — or every message ('all' / no id) — as read. */
  markRead(id) {
    for (const m of A.inbox) if (id == null || id === 'all' || m.id === id) m.read = true;
  },
  /** Removes a message from the inbox. */
  dismiss(id) {
    const i = A.inbox.findIndex((m) => m.id === id);
    if (i >= 0) A.inbox.splice(i, 1);
  },
  /** Posts a message: post(advisorKey, {title, text, severity, key?, panel?, overlay?, x?, z?}). */
  post,
  /** Pushes a headline to the ticker right away. */
  pushNews: emitNews,
  /** Recent headlines with their day: [{text, day}] (newest first). */
  newsLog() {
    const S = S_();
    return S && S.adv ? S.adv.newsLog : [];
  },

  /** Current, state-based tip from one advisor (string). */
  advice(key) {
    return A.adviceInfo(key).text;
  },
  /** {text, title, severity, mood ('happy'|'ok'|'worried'|'upset'), issues: [{title, severity}]} for one advisor. */
  adviceInfo(key) {
    const S = S_();
    if (!S) return { text: '', title: '', severity: 'info', mood: 'ok', issues: [] };
    const c = gather(false);
    const hits = [];
    for (const r of RULES) {
      if (r.adv !== key) continue;
      let ok = false;
      try { ok = !!r.when(c); } catch (err) { ok = false; }
      if (ok) hits.push({ r, sev: typeof r.sev === 'function' ? r.sev(c) : r.sev });
    }
    hits.sort((x, y) => SEV_RANK[y.sev] - SEV_RANK[x.sev] || (y.sev === 'good') - (x.sev === 'good'));
    const problems = hits.filter((h) => h.sev !== 'good' && h.sev !== 'info');
    const mood = problems.some((h) => h.sev === 'bad') ? 'upset' : problems.length ? 'worried' : hits.some((h) => h.sev === 'good') ? 'happy' : 'ok';
    const issues = hits.map((h) => ({ title: h.r.title, severity: h.sev, key: h.r.key, panel: h.r.panel, overlay: h.r.overlay }));
    if (!hits.length) {
      const tips = TIPS[key] || TIPS.planning;
      return { text: tips[Math.floor(S.time.day / C.DAYS_PER_MONTH) % tips.length], title: 'All good', severity: 'info', mood, issues };
    }
    // stable text per day (no flicker when the window re-renders)
    const saved = rnd;
    rnd = M.rng(S.time.day + hits[0].r.key.length);
    let text = '';
    try { text = textOf(hits[0].r, c); } catch (err) { text = hits[0].r.title; }
    rnd = saved;
    return { text, title: hits[0].r.title, severity: hits[0].sev, mood, issues };
  },

  /** All achievements with their status: [{key, name, icon, desc, done, day}]. */
  achievements() {
    const S = S_();
    const got = (S && S.achievements) || {};
    return ACH.map((a) => ({ key: a.key, name: a.name, icon: a.icon, desc: a.desc, done: got[a.key] != null, day: got[a.key] != null ? got[a.key] : null, sandbox: !a.noSandbox }));
  },
  /** Grants an achievement by key (returns true if newly unlocked). */
  grant,
  /** Milestone info: {index, current, next, progress 0..1}. */
  milestoneInfo() {
    const S = S_();
    const MS = VC.MILESTONES;
    const i = (S && S.milestone) || 0;
    const cur = MS[i], next = MS[i + 1] || null;
    const peak = (S && S.peakPop) || 0;
    return { index: i, current: cur, next, progress: next ? M.clamp((peak - cur.pop) / (next.pop - cur.pop), 0, 1) : 1, unlocksNext: next ? unlocksBetween(cur.pop, next.pop) : [] };
  },
  /** Items unlocked in the population range (p0, p1]. */
  unlocksBetween,
});
