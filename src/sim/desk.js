/*
 * VOXELPOLIS — Mayor's Desk (VC.desk): every ~3-5 game months a decision lands on the mayor's desk — a
 * short story presented by one of the VC.ADVISORS with 2-3 choices. Every choice carries a one-line
 * consequence summary (chips) and applies some of: money (VC.money, ledger category 'desk'), temporary
 * modifiers (VC.econ.addTempMod, source 'desk'), a recurring monthly payment, a demand nudge, a headline
 * (VC.advisors.pushNews) and special effects (fireworks, fixing up abandoned buildings, clearing rubble,
 * cheering residents up, putting out fires). Some choices are gambles (`roll`: with probability p an
 * extra outcome applies). The card waits — the game is not paused; after DECIDE_DAYS unanswered the
 * event resolves with its "ignore" outcome (the choice flagged ignore, else event.ignore, else nothing).
 *
 * CADENCE  never in the first 2 months of a city, during an active disaster, while the tutorial runs or
 *   in the title-screen demo (S.demo). The next event is due 90-150 days after the previous one was
 *   resolved. Events have conditions (population range, buildings present, season, policy state, city
 *   problems) and a per-event cooldown (~2 years) so the pool stays fresh.
 *
 * STATE (plain JSON, saved with the game): S.desk = {
 *   next (day), start (day the desk opened), seq,
 *   pending: {seq, id, day, expires, k ($ scale of this event), adv} | null,
 *   history: [{seq, id, title, icon, choice (-1 = ignored), label, out, day, auto}] (last 20),
 *   seen: {eventId: day}, recurring: [{id, label, amount (+ income / − cost), left (months)}] }
 * Money amounts in the pool are multiples of k = $1,000 + $0.35 per citizen (2 significant digits), so
 * a decision matters in a village and in a metropolis alike.
 *
 * API  EVENTS, pending() -> view | null, choose(i) -> {ok, outcome, label, reason?}, trigger(id?) (debug:
 *   puts an event on the desk now, ignoring the cadence; an explicit id also ignores its conditions),
 *   history(), view(pending) -> {seq, id, icon, title, text, advisor:{key,name,role,icon,color},
 *   choices:[{i, label, chips:[{t, c:'good'|'bad'|'gold'|'risk'|'neu'}], dur ('6 mo'), cost, affordable, ignore}], day,
 *   expires, daysLeft, decideDays}, addTempMod(entry) / removeTempMod(id) (VC.econ's when it has them,
 *   else a small fallback that keeps S.tempMods in the contract format and folds them into S.mods).
 * BUS  'deskEvent' {event: view} when a decision arrives; 'deskResolved' {event, choice, label, outcome,
 *   auto} when it is answered or expires. The HUD (ui/hud_desk.js) shows the card, plays 'advisor' on
 *   arrival and toasts expiries; this module emits no toast / sfx itself.
 *
 * LIFECYCLE  init() (bus listeners, once), reset(S) (creates / migrates S.desk), update() (no per-frame
 *   work: everything runs on bus 'day' / 'month'). Joins VC.MODULE_ORDER at boot if main.js lacks it.
 */
const M = VC.M;
const DECIDE_DAYS = 60; // unanswered decisions resolve with their ignore outcome after this
const FIRST_DAYS = 60; // no decisions during a city's first two months
const GAP_MIN = 90, GAP_MAX = 150; // days between decisions
const RETRY_DAYS = 12; // nothing eligible / blocked: look again after this
const COOLDOWN = 720; // an event does not come back for ~2 years (unless the pool runs dry)
const HISTORY_CAP = 20;

let inited = false;
const S_ = () => VC.state;
const live = (S) => !!(S && !S.demo && S.desk);
const tutorialOn = () => !!(VC.hud && VC.hud.tutorialStep && VC.hud.tutorialStep() >= 0);
const disasterOn = () => !!(VC.disasters && VC.disasters.active && VC.disasters.active.length);

/** Two significant digits. */
function nice(v) {
  const a = Math.abs(v);
  if (a < 100) return Math.round(v / 10) * 10;
  const p = Math.pow(10, Math.floor(Math.log10(a)) - 1);
  return Math.round(v / p) * p;
}
/** $ scale of a decision for the current city. */
function scaleK(S) {
  const pop = Math.max((S.stats && S.stats.pop) || 0, (S.peakPop || 0) * 0.8);
  return nice(M.clamp(1000 + pop * 0.35, 1000, 80000));
}
const SEASON = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];

/* ------------------------------------------------------------------ */
/* the event pool                                                        */
/* ------------------------------------------------------------------ */
/*
 * {id, adv (VC.ADVISORS key), icon, title, text ('{city}' = city name), when(c) -> bool, weight?,
 *  choices: [{label, fx, out, ignore?, roll?: {p, fx, out, note}}], ignore?: {fx, out}}
 * fx: {money (x k; − = cost), monthly: {k, months}, mods: {VC.MODS key: additive}, days, demand: {R,C,I},
 *      special: 'fireworks'|'restore'|'clearRubble'|'cheer'|'extinguish'|'clearAbandoned', n, news, note}
 * c: {S, pop, peak, month, season, money, st (stats), has(key) (catalog buildings placed), group(g),
 *     pol(key) (policy on), k}
 */
const EVENTS = [
  {
    id: 'tech_campus', adv: 'finance', icon: '💻', title: 'Big Tech Comes Knocking',
    text: 'Cubify Inc. — makers of the world’s squarest smartphone — want to build their headquarters in {city}. Hundreds of jobs! The catch: they want a tax holiday. Their CEO is waiting in the lobby in a voxel hoodie.',
    when: (c) => c.pop >= 1500,
    choices: [
      { label: '🎉 Roll out the red carpet', fx: { demand: { I: 0.3 }, mods: { demandC: 0.12, demandI: 0.15, taxC: -0.3, taxI: -0.3 }, days: 360 }, out: 'Cubify breaks ground! The ribbon cutting featured a 40-minute keynote about a slightly rounder button.' },
      { label: '🤝 Offer a modest deal', fx: { mods: { demandI: 0.07, taxI: -0.1 }, days: 360 }, out: 'Cubify grumbles but accepts. Their “satellite office” is, for now, one guy with a laptop and big dreams.' },
      { label: '🙅 No special treatment', ignore: true, fx: {}, out: 'Cubify builds in the next town over. Residents there report an alarming number of scooters.' },
    ],
  },
  {
    id: 'dog_park', adv: 'planning', icon: '🐕', title: 'A Petition for a Dog Park',
    text: 'A petition with 1,200 signatures (and 300 paw prints) demands a dog park. The lead organiser is a corgi named Mayor Waffles. He has brought his own tiny clipboard.',
    when: (c) => c.pop >= 300,
    choices: [
      { label: '🦴 Build a grand dog park', fx: { money: -1.2, mods: { happiness: 0.03, landValue: 0.03 }, days: 240 }, out: 'The dog park opens to thunderous barking. Mayor Waffles gives a speech. It is mostly barking, but very moving.' },
      { label: '🌳 Fence off a corner of a park', fx: { money: -0.3, mods: { happiness: 0.01 }, days: 180 }, out: 'A modest but beloved fenced corner. Mayor Waffles accepts the compromise with dignity (and a treat).' },
      { label: '🚶 Sidewalks will do', ignore: true, fx: { mods: { happiness: -0.01 }, days: 90 }, out: 'Mayor Waffles is not angry. Just disappointed. The whole city can feel it.' },
    ],
  },
  {
    id: 'film_crew', adv: 'transport', icon: '🎬', title: 'Lights, Camera, Voxels!',
    text: 'A big studio wants to shoot the car-chase blockbuster “Cube Fury 7” in downtown {city}. They pay handsomely — but need the streets closed for weeks.',
    when: (c) => c.pop >= 800,
    choices: [
      { label: '🎥 Close the streets, roll film', fx: { money: 2.5, mods: { traffic: 0.2, tourism: 0.3 }, days: 45, news: 'Hollywood comes to {city}: “Cube Fury 7” shuts down downtown' }, out: '“Cube Fury 7” wraps filming. Three cars exploded, all of them on purpose. The premiere is already sold out.' },
      { label: '🌙 Night shoots only', fx: { money: 1, mods: { tourism: 0.15, noise: 0.1 }, days: 45 }, out: 'The crew films every night under blinding lights. Residents now sleep in sunglasses.' },
      { label: '✋ We have a city to run', ignore: true, fx: {}, out: 'The studio films in a warehouse instead. The movie looks noticeably cheaper.' },
    ],
  },
  {
    id: 'heatwave', adv: 'health', icon: '🥵', title: 'Heatwave Warning',
    text: 'Thermometers are melting — they are voxel thermometers, so they are melting into smaller cubes. The elderly and the pets of {city} need relief.',
    when: (c) => c.season === 'summer' && c.pop >= 300,
    choices: [
      { label: '❄️ Open cooling centres', fx: { money: -1, mods: { health: 0.1, happiness: 0.02 }, days: 60 }, out: 'Air-conditioned libraries fill up. Record numbers of citizens discover they like reading.' },
      { label: '🍦 Free ice cream in every park', fx: { money: -1.6, mods: { happiness: 0.05 }, days: 45 }, out: 'Record ice cream consumption! A local dairy names a flavour after you: “Mayor Mint”.' },
      { label: '🏠 Tell everyone to stay inside', ignore: true, fx: { mods: { health: -0.05, happiness: -0.02 }, days: 60 }, out: 'People stay home and sweat it out. Fans sell out citywide.' },
    ],
  },
  {
    id: 'band_stadium', adv: 'planning', icon: '🎸', title: 'The Local Band Wants the Stadium',
    text: 'The Cubic Rhythms — a garage band with 14 fans, 11 of them relatives — want to play the Stadium. They promise “a spectacle”. Their drummer promises “a lot of cymbals”.',
    when: (c) => c.has('stadium'),
    choices: [
      { label: '🎆 Give them the big stage', fx: { money: -0.6, special: 'fireworks', n: 24, mods: { happiness: 0.03, tourism: 0.2 }, days: 60, news: 'Garage band The Cubic Rhythms sells out the Stadium; experts baffled' }, out: 'Against all odds, the show is legendary. The fireworks finale is visible from space (and from the next town).' },
      { label: '💵 Rent it at the usual price', fx: { money: 0.8 }, out: 'The band pays in coins from a jar labelled “TOUR FUND”. The concert has 14 attendees.' },
      { label: '⚽ Stadiums are for sports', ignore: true, fx: {}, out: 'The band plays the Stadium parking lot anyway. The parking lot has never sounded better.' },
    ],
  },
  {
    id: 'park_concert', adv: 'planning', icon: '🎺', title: 'Concert in the Park?',
    text: 'The {city} Community Brass Band wants to give a free summer concert in the park. They have been practising. The neighbours can confirm this.',
    when: (c) => !c.has('stadium') && c.group('parks') >= 2 && (c.season === 'summer' || c.season === 'spring'),
    choices: [
      { label: '🎶 Sponsor it (with fireworks!)', fx: { money: -0.5, special: 'fireworks', n: 14, mods: { happiness: 0.025 }, days: 60 }, out: 'Tubas at sunset, fireworks at dusk. Even the pigeons tapped their feet.' },
      { label: '👍 Allow it, no budget', fx: { mods: { happiness: 0.01, noise: 0.05 }, days: 30 }, out: 'The concert goes ahead. The tuba solo runs twenty minutes long. Nobody minds.' },
      { label: '🤫 Too noisy', ignore: true, fx: {}, out: 'The band practises in a basement instead. The basement’s owners are reconsidering things.' },
    ],
  },
  {
    id: 'potholes', adv: 'transport', icon: '🕳️', title: 'Pothole Crisis',
    text: 'A pothole on Main Street has grown so large that locals have started fishing in it. Somebody caught a trout. Nobody knows how the trout got there.',
    when: (c) => c.pop >= 500,
    choices: [
      { label: '🚧 Emergency repaving blitz', fx: { money: -1.5, mods: { traffic: -0.1, happiness: 0.01 }, days: 180 }, out: 'Smooth roads everywhere! Drivers weep with joy. The trout has been relocated to a lake.' },
      { label: '🛠️ Fill only the worst ones', fx: { money: -0.5, mods: { traffic: -0.03 }, days: 90 }, out: 'The worst holes are patched. The second-worst holes are now the worst holes.' },
      { label: '🎣 Stock it with more trout', ignore: true, fx: { mods: { traffic: 0.06, tourism: 0.05 }, days: 120 }, out: 'The Main Street Pothole is now a minor tourist attraction. Traffic, less so.' },
    ],
  },
  {
    id: 'scientist_lab', adv: 'health', icon: '🧪', title: 'A Brilliant Scientist Needs a Lab',
    text: 'Dr. Ada Cubelace says she can make every appliance in {city} 20% more efficient. She also says her hair is naturally like that. Both claims are under review.',
    when: (c) => c.pop >= 2000,
    choices: [
      { label: '🔬 Fund her research', fx: { money: -2, mods: { powerUse: -0.12, education: 0.05 }, days: 360 }, out: 'Breakthrough! Dr. Cubelace’s “Square Watt” bulbs are in every home. Her hair remains unexplained.' },
      { label: '🏚️ A garage and a small grant', fx: { money: -0.6, mods: { powerUse: -0.04 }, days: 240 }, roll: { p: 0.25, fx: { mods: { fire: 0.1 }, days: 60 }, out: 'The garage caught fire twice, but the gadgets work. Mostly.', note: '🎲 Might get explosive' }, out: 'Working from a garage, she invents a better toaster and a slightly better light bulb.' },
      { label: '🧙 Sounds like mad science', ignore: true, fx: {}, out: 'Dr. Cubelace moves to a rival city and names her next invention after you. It is a very rude invention.' },
    ],
  },
  {
    id: 'union_strike', adv: 'finance', icon: '📢', title: 'Union Strike Threat',
    text: 'The City Workers’ Union demands a raise and — this part is non-negotiable — a better coffee machine. They are prepared to put down their tools.',
    when: (c) => c.pop >= 3000,
    choices: [
      { label: '🤝 Give them the raise', fx: { monthly: { k: -0.25, months: 12 }, mods: { happiness: 0.02 }, days: 360 }, out: 'Crisis averted. The new coffee machine is so good it has formed its own union.' },
      { label: '☕ Just the coffee machine', fx: { money: -0.3 }, roll: { p: 0.45, fx: { mods: { garbage: 0.25, happiness: -0.02 }, days: 30 }, out: 'The coffee was not enough. A one-month strike leaves trash piling up on the kerbs.', note: '🎲 They might strike anyway' }, out: 'It worked! The machine makes 14 kinds of latte. Productivity is up 3%.' },
      { label: '✊ Hold firm', ignore: true, fx: { mods: { garbage: 0.3, happiness: -0.03 }, days: 45 }, out: 'The workers strike. Trash piles up; so does resentment. Eventually everyone goes back to work, grumpily.' },
    ],
  },
  {
    id: 'festival', adv: 'planning', icon: '🎪', title: 'Festival Season!',
    text: 'The Voxel Arts & Music Festival wants to take over the parks of {city} for a long weekend. Glitter in every crevice is guaranteed.',
    when: (c) => c.pop >= 400 && (c.month >= 4 && c.month <= 8),
    choices: [
      { label: '🎆 Go all out — fireworks included', fx: { money: -1.5, special: 'fireworks', n: 30, mods: { happiness: 0.04, tourism: 0.3, demandC: 0.05 }, days: 45, news: '{city} festival draws record crowds; glitter shortage feared' }, out: 'Three days of music, food and fireworks. The glitter will be found for years.' },
      { label: '🎠 A modest county fair', fx: { money: -0.5, mods: { happiness: 0.015, tourism: 0.1 }, days: 30 }, out: 'A charming fair with a pie contest. The winning pie is, naturally, square.' },
      { label: '📅 Not this year', ignore: true, fx: {}, out: 'The festival goes elsewhere. The glitter stays in its jars, waiting.' },
    ],
  },
  {
    id: 'meteorite', adv: 'environment', icon: '☄️', title: 'A Mysterious Glowing Meteorite',
    text: 'Kids found a softly glowing rock in a field outside {city}. It hums. Sometimes it hums show tunes. Scientists and a museum are both very interested.',
    when: (c) => c.pop >= 600,
    choices: [
      { label: '🏛️ Sell it to a museum', fx: { money: 3 }, out: 'The Museum of Suspicious Rocks pays top dollar. The rock hums “Money, Money, Money” on its way out.' },
      { label: '✨ Put it on display in a park', fx: { mods: { tourism: 0.25, happiness: 0.02 }, days: 360, news: 'Humming space rock “Glowy” becomes {city}’s newest star attraction' }, out: 'Tourists flock to see “Glowy”. It has started taking requests.' },
      { label: '🤷 Leave it in the field', ignore: true, fx: {}, out: 'Nobody touches it. Every night at 3 a.m. it hums a lullaby, and the whole valley sleeps a little better.' },
    ],
  },
  {
    id: 'marathon', adv: 'health', icon: '🏃', title: 'The First City Marathon',
    text: 'Runners want to hold the first {city} Marathon: 42.195 km of perfectly square corners. Knees across the city are nervous.',
    when: (c) => c.pop >= 1500 && c.season !== 'winter',
    choices: [
      { label: '🏅 Sponsor it', fx: { money: -1, mods: { health: 0.06, happiness: 0.02, traffic: 0.05 }, days: 60 }, out: 'A triumph! The winner finishes in 2:08 and immediately asks why every corner is 90 degrees.' },
      { label: '👟 Allow it, no sponsorship', fx: { mods: { traffic: 0.08, health: 0.02 }, days: 30 }, out: 'The marathon runs on a shoestring (literally, the finish line is a shoestring).' },
      { label: '🚗 Roads are for cars', ignore: true, fx: {}, out: 'The runners run laps around the park instead. 400 laps. They are fine. Probably.' },
    ],
  },
  {
    id: 'pigeons', adv: 'environment', icon: '🐦', title: 'The Pigeon Situation',
    text: 'Pigeons have occupied the tallest roof in {city}. They have formed a government. Their first act: mandatory breadcrumbs.',
    when: (c) => c.pop >= 800,
    choices: [
      { label: '🦅 Hire a falconer', fx: { money: -0.6, mods: { happiness: 0.01 }, days: 120 }, out: 'The falconer arrives. The pigeons flee, then write a strongly worded letter.' },
      { label: '🕊️ Negotiate with the pigeons', fx: { money: -0.1 }, roll: { p: 0.5, fx: { mods: { garbage: 0.08 }, days: 90 }, out: 'Talks collapse over breadcrumb quotas. Pigeons 1, City Hall 0.', note: '🎲 Pigeons drive a hard bargain' }, out: 'A historic treaty! The pigeons agree to leave the statues alone in exchange for one bakery.' },
      { label: '🐦 Pigeons are citizens too', ignore: true, fx: { mods: { garbage: 0.05, tourism: 0.05 }, days: 120 }, out: 'The Pigeon Parliament now gives guided tours of its roof. They are surprisingly good.' },
    ],
  },
  {
    id: 'food_trucks', adv: 'planning', icon: '🌮', title: 'Food Truck Invasion',
    text: 'A fleet of food trucks wants permits downtown. Menu highlights: cubic tacos, square pizza and “The Brick” (a burrito). The restaurants are nervous.',
    when: (c) => c.pop >= 1000,
    choices: [
      { label: '🚚 Welcome them all', fx: { money: 0.3, mods: { demandC: 0.08, happiness: 0.02, traffic: 0.03 }, days: 180 }, out: 'Lunch is now an adventure. “The Brick” wins a regional food award.' },
      { label: '📆 Weekends only', fx: { money: 0.1, mods: { demandC: 0.03 }, days: 180 }, out: 'Weekend food-truck fairs become a local tradition.' },
      { label: '🍽️ Protect the restaurants', ignore: true, fx: {}, out: 'The trucks roll on. The restaurants celebrate with a slightly smug happy hour.' },
    ],
  },
  {
    id: 'solar_coop', adv: 'utilities', icon: '☀️', title: 'Rooftop Solar Co-op',
    text: 'A green-energy co-op offers to put solar panels on the roofs of {city} — if the city chips in. The roofs are, conveniently, all perfectly flat.',
    when: (c) => c.pop >= 2000,
    choices: [
      { label: '🔆 Chip in for every roof', fx: { money: -2, mods: { powerUse: -0.15, pollution: -0.05 }, days: 360 }, out: 'The city glitters. Power demand drops, and the roofs have never looked so futuristic.' },
      { label: '🧪 Start a pilot program', fx: { money: -0.7, mods: { powerUse: -0.05 }, days: 240 }, out: 'A few hundred roofs go solar. The rest are jealous.' },
      { label: '🏭 Coal works fine', ignore: true, fx: {}, out: 'The co-op moves on. The coal plant sends a thank-you card, printed on coal.' },
    ],
  },
  {
    id: 'water_main', adv: 'utilities', icon: '⛲', title: 'Burst Water Main!',
    text: 'A water main burst under Market Street, creating a geyser 30 metres tall. Kids are delighted. Engineers are not.',
    when: (c) => c.pop >= 1200 && c.water,
    choices: [
      { label: '🔧 Send emergency crews', fx: { money: -1.2 }, out: 'Fixed overnight. Market Street is sad to see its geyser go.' },
      { label: '🩹 Patch it with duct tape', fx: { money: -0.2 }, roll: { p: 0.5, fx: { mods: { waterUse: 0.15 }, days: 60 }, out: 'The duct tape held for three days. Then it did not. The leak is back.', note: '🎲 50% it springs a leak' }, out: 'Against all engineering principles, the duct tape holds. It is now load-bearing.' },
      { label: '🎟️ Charge admission to the geyser', ignore: true, fx: { money: 0.4, mods: { waterUse: 0.25, tourism: 0.05 }, days: 90 }, out: 'The “Market Street Geyser Experience” is a hit. The water bill, less so.' },
    ],
  },
  {
    id: 'science_fair', adv: 'health', icon: '🌋', title: 'Science Fair Triumph',
    text: 'Students from {city} built a working volcano, a robot and a small, very polite AI. They qualified for the national finals but cannot afford the trip.',
    when: (c) => c.pop >= 800 && c.has('school'),
    choices: [
      { label: '🚌 Fund the trip', fx: { money: -0.5, mods: { education: 0.06, happiness: 0.01 }, days: 180, news: '{city} students win national science fair with a very polite AI' }, out: 'They win first prize! The polite AI thanks the judges for 40 minutes.' },
      { label: '🍪 Help them crowdfund', fx: { mods: { education: 0.02 }, days: 120 }, out: 'A bake sale raises the money. The volcano cake is a highlight.' },
      { label: '📚 Education starts at home', ignore: true, fx: {}, out: 'The students stay home. The robot is sad. Robots should not be able to be sad.' },
    ],
  },
  {
    id: 'celebrity_wedding', adv: 'finance', icon: '💒', title: 'A Celebrity Wedding',
    text: 'Pop superstar Cubey Minogue wants to get married in {city}. The paparazzi are already circling like very well-dressed vultures.',
    when: (c) => c.pop >= 5000,
    choices: [
      { label: '💐 Host it lavishly', fx: { money: -1, special: 'fireworks', n: 16, mods: { tourism: 0.4, demandC: 0.05 }, days: 60, news: 'Cubey Minogue says “I do” in {city}; fans travel from across the world' }, out: 'The wedding of the decade! Every hotel is booked and the souvenir shops are empty.' },
      { label: '🧾 Charge a venue fee', fx: { money: 2, mods: { tourism: 0.1 }, days: 30 }, out: 'Cubey pays in full and complains in a song that goes platinum. Free publicity!' },
      { label: '🙏 Politely decline', ignore: true, fx: {}, out: 'The wedding happens in a castle somewhere. The paparazzi leave. Birds return.' },
    ],
  },
  {
    id: 'alien_signal', adv: 'utilities', icon: '📡', title: 'A Signal from Space?',
    text: 'The weather radar picked up a repeating signal from deep space: “CUBE. CUBE. CUBE.” Watt from Utilities is very excited and has not slept.',
    when: (c) => c.pop >= 4000,
    choices: [
      { label: '👽 Broadcast a warm welcome', fx: { mods: { tourism: 0.2 }, days: 150 }, roll: { p: 0.25, fx: { money: 1.5 }, out: 'The aliens reply — with a coupon for a galactic furniture store. The city sells it for a fortune.', note: '🎲 They might reply' }, out: 'No reply yet, but UFO tourism is booming. T-shirts sell out.' },
      { label: '🤐 Keep it top secret', ignore: true, fx: {}, out: 'The signal stops. Probably nothing. Probably.' },
    ],
  },
  {
    id: 'farmers_market', adv: 'environment', icon: '🍉', title: 'Farmers’ Market Proposal',
    text: 'Local farmers want to sell square watermelons in the town square every Saturday. They are very proud of the watermelons.',
    when: (c) => c.pop >= 200 && c.pop < 30000,
    choices: [
      { label: '🥕 Approve the market', fx: { money: 0.2, mods: { health: 0.03, demandC: 0.03, happiness: 0.01 }, days: 240 }, out: 'Saturdays are now the best day of the week. The square watermelons stack beautifully.' },
      { label: '🛒 Only once a month', fx: { mods: { health: 0.01 }, days: 180 }, out: 'A monthly market it is. People mark it on their calendars in green ink.' },
      { label: '🙅 Not in my square', ignore: true, fx: {}, out: 'The farmers go home. The watermelons are shipped to a city with more appreciation for geometry.' },
    ],
  },
  {
    id: 'mural', adv: 'safety', icon: '🎨', title: 'The Great Cat Mural',
    text: 'Overnight, street artists painted a 30-metre mural of a cat on the side of a power plant. Critics call it “bold”. The plant manager calls it “vandalism”. The cat is not available for comment.',
    when: (c) => c.pop >= 1500,
    choices: [
      { label: '🖌️ Commission more murals', fx: { money: -0.5, mods: { landValue: 0.03, tourism: 0.1, crime: -0.03 }, days: 240 }, out: 'A mural festival transforms grey walls into art. The cat remains the fan favourite.' },
      { label: '🧽 Paint over it', fx: { money: -0.3, mods: { happiness: -0.01 }, days: 90 }, out: 'The wall is beige again. Somewhere, the cat weeps.' },
      { label: '🐈 Leave it', ignore: true, fx: { mods: { tourism: 0.03 }, days: 120 }, out: 'The cat mural stays. Some say its eyes follow you. Some say that is the point.' },
    ],
  },
  {
    id: 'cube_games', adv: 'planning', icon: '🏅', title: 'Bid for the Cube Games',
    text: 'The International Cube Games Committee is choosing a host city. Hosting is expensive — but the whole world would be watching {city}.',
    when: (c) => c.pop >= 20000,
    choices: [
      { label: '🏟️ Submit a bold bid', fx: { money: -4 }, roll: { p: 0.5, fx: { special: 'fireworks', n: 40, mods: { tourism: 0.5, demandC: 0.1, happiness: 0.04 }, days: 360, news: '{city} wins the Cube Games! Celebrations run all night' }, out: 'WE WON! The Cube Games are coming to {city}. The whole city parties until dawn.', note: '🎲 50% chance to win' }, out: 'We lost to a city made entirely of spheres. Disgraceful. The bid money is gone.' },
      { label: '📉 Not worth the gamble', ignore: true, fx: {}, out: 'The Games go to a city of spheres. We watch on TV, muttering.' },
    ],
  },
  {
    id: 'lottery', adv: 'finance', icon: '🎟️', title: 'A City Lottery?',
    text: 'Someone suggested a city lottery to fund parks. The odds of winning: 1 in 14 million. The odds of the council arguing about it: 1 in 1.',
    when: (c) => c.pop >= 1000,
    choices: [
      { label: '🎰 Launch the lottery', fx: { monthly: { k: 0.2, months: 12 }, mods: { happiness: 0.01, crime: 0.02 }, days: 360 }, out: 'Weekly draws on TV! The money rolls in, and a retired baker wins big.' },
      { label: '🙅 A slippery slope', ignore: true, fx: {}, out: 'No lottery. The council argues about it anyway, for old times’ sake.' },
    ],
  },
  {
    id: 'blizzard', adv: 'transport', icon: '❄️', title: 'Blizzard Incoming',
    text: 'Forecasters predict a metre of snow. The snowplough fleet is ready (one of them is a converted ice-cream truck, still playing its tune).',
    when: (c) => c.season === 'winter' && c.pop >= 400,
    choices: [
      { label: '🧂 Pre-salt every road', fx: { money: -1, mods: { traffic: -0.05 }, days: 30 }, out: 'The roads stay clear. The ice-cream plough becomes a local legend.' },
      { label: '⛄ Declare a snow day!', fx: { mods: { happiness: 0.03, demandC: -0.05 }, days: 30 }, out: 'Snowball fights, sledding and hot chocolate for all. Shops are quiet, hearts are full.' },
      { label: '🤞 We’ll manage', ignore: true, fx: { mods: { traffic: 0.12 }, days: 30 }, out: 'We did not manage. Traffic crawls for weeks.' },
    ],
  },
  {
    id: 'haunted_house', adv: 'safety', icon: '👻', title: 'Haunted House Reports',
    text: 'Residents report spooky noises from an old house on Elm Street. Investigators found raccoons. Very theatrical raccoons.',
    when: (c) => c.pop >= 500 && (c.month === 9 || c.month === 10 || c.month === 8),
    choices: [
      { label: '🎃 Make it a Halloween attraction', fx: { money: -0.4, mods: { tourism: 0.15, happiness: 0.02 }, days: 60 }, out: 'The “Haunted Raccoon Manor” is a hit. The raccoons demand top billing.' },
      { label: '🦝 Relocate the raccoons', fx: { money: -0.2 }, out: 'The raccoons move to a lovely forest. They were, frankly, overqualified for the house.' },
      { label: '👻 Who you gonna call? Nobody.', ignore: true, fx: { mods: { happiness: -0.01 }, days: 60 }, out: 'The noises continue. Elm Street property prices do a spooky little dip.' },
    ],
  },
  {
    id: 'artists_abandoned', adv: 'planning', icon: '🖼️', title: 'Artists Want the Empty Buildings',
    text: 'A collective of artists offers to move into the abandoned buildings of {city} and turn them into studios. They will bring their own paint (and opinions).',
    when: (c) => (c.st.abandoned || 0) >= 2,
    choices: [
      { label: '🎨 Let them move in', fx: { money: -0.8, special: 'restore', n: 6, mods: { landValue: 0.02 }, days: 180, note: '🏚️ Revives up to 6 buildings' }, out: 'Studios, galleries and a very good café. The old buildings are alive again.' },
      { label: '🏗️ Clear the lots for developers', fx: { money: 0.6, special: 'clearAbandoned', n: 6, note: '🚜 Clears up to 6 buildings' }, out: 'The empty buildings come down. Fresh lots are ready for something new to grow.' },
      { label: '🔒 Leave them boarded up', ignore: true, fx: {}, out: 'The buildings stay empty. The artists move into a lighthouse instead.' },
    ],
  },
  {
    id: 'cleanup_day', adv: 'environment', icon: '🧹', title: 'Volunteer Cleanup Day',
    text: 'Hundreds of volunteers offer to clear the rubble around {city} and plant flowers — in exchange for free pizza. A lot of free pizza.',
    when: (c) => (c.st.rubble || 0) >= 2,
    choices: [
      { label: '🍕 Buy the pizza', fx: { money: -0.3, special: 'clearRubble', mods: { happiness: 0.01 }, days: 60, note: '🧱 Clears all rubble' }, out: 'The rubble is gone by lunchtime. The pizza is gone by 12:05.' },
      { label: '🙅 No free lunch', ignore: true, fx: {}, out: 'The volunteers go home. The rubble stays, looking smug.' },
    ],
  },
  {
    id: 'skyscraper', adv: 'planning', icon: '🏗️', title: 'A Developer Proposes a Skyscraper',
    text: 'A developer wants to build the tallest tower {city} has ever seen. It is shaped like a giant cube. Of course it is.',
    when: (c) => c.pop >= 5000,
    choices: [
      { label: '⚡ Fast-track the permits', fx: { money: 1.5, mods: { demandC: 0.1, landValue: 0.03, traffic: 0.05 }, days: 240 }, out: 'Permit fees roll in and the tower rises. Pigeons immediately claim the top floor.' },
      { label: '🏘️ Only with affordable housing', fx: { demand: { R: 0.25 }, mods: { demandR: 0.08, demandC: 0.05 }, days: 240 }, out: 'A compromise! The tower includes 300 affordable flats and one very expensive penthouse.' },
      { label: '🌆 Protect the skyline', ignore: true, fx: {}, out: 'The skyline stays as it is. Postcard sales hold steady.' },
    ],
  },
  {
    id: 'smog_protest', adv: 'environment', icon: '😷', title: 'Smog Protest',
    text: 'Protesters in gas masks march on City Hall. One of them brought a very sad-looking houseplant as evidence.',
    when: (c) => c.pop >= 1000 && (c.st.pollution || 0) > 0.22,
    choices: [
      { label: '🌳 Plant 1,000 trees', fx: { money: -1.2, mods: { pollution: -0.12, happiness: 0.02 }, days: 360 }, out: 'The city turns green. The houseplant recovers and is named Honorary Citizen.' },
      { label: '📋 Promise an investigation', fx: { mods: { happiness: -0.01 }, days: 60 }, out: 'The investigation is ongoing. The houseplant is not impressed.' },
      { label: '🙉 Ignore the protest', ignore: true, fx: { mods: { happiness: -0.03 }, days: 90 }, out: 'The protesters go home, coughing pointedly.' },
    ],
  },
  {
    id: 'bike_thefts', adv: 'safety', icon: '🚲', title: 'The Left-Wheel Bandit',
    text: 'Someone is stealing bicycles — but only the left wheel. Police are baffled. The unicycle market is booming.',
    when: (c) => c.pop >= 1500,
    choices: [
      { label: '🚓 Extra patrols', fx: { money: -0.8, mods: { crime: -0.12 }, days: 180 }, out: 'The Left-Wheel Bandit is caught with 412 left wheels. Motive: “aesthetic”.' },
      { label: '🔒 Free bike locks for all', fx: { money: -0.3, mods: { crime: -0.04, happiness: 0.01 }, days: 120 }, out: 'Bikes are locked tight. The bandit moves on to shopping-cart wheels.' },
      { label: '🎪 Everyone rides unicycles now', ignore: true, fx: { mods: { crime: 0.04 }, days: 90 }, out: 'The bandit strikes again and again. The circus school has a waiting list.' },
    ],
  },
  {
    id: 'traffic_app', adv: 'transport', icon: '📱', title: 'A Startup Offers a Traffic App',
    text: 'Startup “Wayz Around” claims its app can end traffic jams in {city} with AI. It has a 4-star rating — from the founder’s mum.',
    when: (c) => c.pop >= 3000,
    choices: [
      { label: '📲 License the app', fx: { monthly: { k: -0.1, months: 12 }, mods: { traffic: -0.08 }, days: 360 }, roll: { p: 0.3, fx: { mods: { traffic: 0.12 }, days: 90 }, out: 'The app routes every single car through the same back alley. The alley has become a parking lot.', note: '🎲 Beta software…' }, out: 'It actually works! Commutes are shorter and the founder’s mum upgrades to 5 stars.' },
      { label: '🛣️ We’ll build roads instead', ignore: true, fx: {}, out: 'The startup pivots to a dating app for pigeons. It is doing great.' },
    ],
  },
  {
    id: 'influencer', adv: 'finance', icon: '🤳', title: 'A Viral Travel Blogger',
    text: 'Influencer @CubeWanderer (2.4M followers) is visiting {city} next week. Her posts can make — or break — a destination.',
    when: (c) => c.pop >= 2000,
    choices: [
      { label: '⭐ Give her the VIP tour', fx: { money: -0.5, mods: { tourism: 0.35 }, days: 120 }, out: '“Hidden gem!!” — 400k likes. Tour buses start arriving on Monday.' },
      { label: '🧳 Treat her like any tourist', fx: {}, roll: { p: 0.5, fx: { mods: { tourism: 0.12 }, days: 90 }, out: 'She loved the authenticity! A glowing post goes viral.', note: '🎲 50% she loves it' }, out: 'She posted mostly about a pothole. Engagement was, unfortunately, huge.' },
      { label: '🙈 Ignore her', ignore: true, fx: {}, out: 'She visits, eats one sandwich and leaves. The sandwich gets 12 likes.' },
    ],
  },
  {
    id: 'donor', adv: 'health', icon: '🎁', title: 'An Anonymous Donor',
    text: 'An anonymous millionaire wants to give {city} a gift: a new hospital wing, a mountain of library books — or a solid-gold statue of their cat.',
    when: (c) => c.pop >= 1000,
    choices: [
      { label: '🏥 The hospital wing', fx: { mods: { health: 0.12 }, days: 360 }, out: 'The new wing opens with a plaque that simply reads: “From a friend (and their cat)”.' },
      { label: '📚 The library books', fx: { mods: { education: 0.1 }, days: 360 }, out: 'Fifty thousand books arrive. Librarians are ecstatic; the shelves are nervous.' },
      { label: '🐈 The golden cat statue', fx: { mods: { tourism: 0.2, happiness: 0.02 }, days: 360, news: 'Mysterious donor gifts {city} a solid-gold cat statue' }, out: 'The Golden Cat becomes the city’s mascot. Rubbing its nose is said to bring luck.' },
    ],
    ignore: { fx: {}, out: 'The donor got tired of waiting and gave the money to a rival city. Their cat approved.' },
  },
  {
    id: 'lights_out', adv: 'utilities', icon: '🌌', title: 'Lights Out for the Stars',
    text: 'Astronomers ask {city} to switch off the lights for one night a month so everyone can see the Milky Way. Watt is torn: he loves stars AND electricity.',
    when: (c) => c.pop >= 1000,
    choices: [
      { label: '🔭 Monthly star nights', fx: { mods: { powerUse: -0.06, happiness: 0.015, crime: 0.02 }, days: 180 }, out: 'Thousands lie in the parks looking up. Several marriage proposals follow.' },
      { label: '💡 Keep the lights on', ignore: true, fx: {}, out: 'The city keeps glowing. The astronomers move their telescopes up a mountain.' },
    ],
  },
  {
    id: 'birthday', adv: 'planning', icon: '🎂', title: 'Happy Birthday, Mayor!',
    text: 'The staff baked a cake shaped like the city. It is mostly roads. They want to throw a party in the square — with fireworks, if you are feeling generous.',
    when: (c) => c.pop >= 300,
    choices: [
      { label: '🎆 Party for everyone!', fx: { money: -0.5, special: 'fireworks', n: 20, mods: { happiness: 0.03 }, days: 30 }, out: 'The whole city sings. You eat the highway interchange. Best birthday ever.' },
      { label: '🍰 Just cake in the office', fx: { special: 'cheer' }, out: 'A quiet celebration. The cake is delicious. Somebody ate the park, which feels symbolic.' },
    ],
    ignore: { fx: {}, out: 'You were too busy to notice. The staff ate the cake. All of it. Even the river.' },
  },
  {
    id: 'tax_holiday', adv: 'finance', icon: '🧾', title: 'Citizens Demand a Tax Holiday',
    text: 'A popular campaign demands a one-month tax holiday “to celebrate how great {city} is”. Penny from Finance has fainted twice.',
    when: (c) => c.pop >= 2000,
    choices: [
      { label: '🎉 One month tax-free!', fx: { mods: { taxR: -0.9, happiness: 0.05, demandR: 0.08 }, days: 30 }, out: 'A month of tax-free bliss! Shops are packed. Penny is breathing into a paper bag.' },
      { label: '🎈 A symbolic 10% cut', fx: { mods: { taxR: -0.1, happiness: 0.01 }, days: 90 }, out: 'A small cut, a big press conference. Everyone is mildly pleased.' },
      { label: '📊 Absolutely not', ignore: true, fx: { mods: { happiness: -0.02 }, days: 60 }, out: 'The campaign fizzles. Penny sends you a thank-you fruit basket.' },
    ],
  },
  {
    id: 'water_park', adv: 'planning', icon: '🏊', title: 'Splash Pads for Summer',
    text: 'Parents want splash pads in the parks of {city}. The kids have already drawn up blueprints (they are mostly slides).',
    when: (c) => c.season === 'summer' && c.pop >= 700,
    choices: [
      { label: '💦 Build splash pads', fx: { money: -0.9, mods: { happiness: 0.03, waterUse: 0.05 }, days: 150 }, out: 'Shrieks of joy echo across the city. The blueprints’ slides were, sadly, not approved.' },
      { label: '🚒 Fire-hydrant fridays', fx: { mods: { happiness: 0.015, waterUse: 0.08, fire: 0.05 }, days: 60 }, out: 'The fire department opens hydrants every Friday. Soaking wet, everyone agrees it is genius.' },
      { label: '🌞 Sprinklers are for lawns', ignore: true, fx: {}, out: 'The kids file a formal complaint written in crayon. It is surprisingly persuasive.' },
    ],
  },
  {
    id: 'factory_expansion', adv: 'environment', icon: '🏭', title: 'Factory Wants to Expand',
    text: 'The biggest factory in {city} wants to double in size. More jobs, more taxes… and more smoke. Fern from Environment has started glaring.',
    when: (c) => c.pop >= 1200 && (c.st.jobsI || 0) > 200,
    choices: [
      { label: '🏭 Approve the expansion', fx: { money: 1, mods: { demandI: 0.15, pollution: 0.1 }, days: 240 }, out: 'The factory doubles. So does the smoke. Fern has not blinked in a week.' },
      { label: '🌱 Only with filters', fx: { mods: { demandI: 0.07, pollution: 0.02 }, days: 240 }, out: 'A cleaner, bigger factory. Fern allows herself one small nod.' },
      { label: '🚫 Deny it', ignore: true, fx: { mods: { demandI: -0.04 }, days: 90 }, out: 'The factory stays the same size and sulks, very quietly.' },
    ],
  },
  {
    id: 'fire_drill', adv: 'safety', icon: '🚒', title: 'Fire Safety Week',
    text: 'Chief Blaze wants a city-wide fire safety week: drills, free smoke-alarm batteries and a very loud truck parade.',
    when: (c) => c.pop >= 600 && c.has('fire_station'),
    choices: [
      { label: '🔥 Full safety week', fx: { money: -0.6, special: 'extinguish', mods: { fire: -0.25 }, days: 180 }, out: 'Every alarm beeps, every kid knows the drill, and the parade was deafening. Chief Blaze is beaming.' },
      { label: '🔋 Just the batteries', fx: { money: -0.2, mods: { fire: -0.1 }, days: 120 }, out: 'Fresh batteries in every alarm. The 3 a.m. low-battery chirps finally stop.' },
      { label: '🙄 We are fine', ignore: true, fx: {}, out: 'Chief Blaze sighs, very loudly, through a megaphone.' },
    ],
  },
  {
    id: 'bakery', adv: 'planning', icon: '🥐', title: 'The Perfect Croissant',
    text: 'A local bakery has created a perfectly cubic croissant. Food critics are divided; queues are not. The baker asks for help opening a second shop.',
    when: (c) => c.pop >= 250 && c.pop < 20000,
    choices: [
      { label: '💸 Small business grant', fx: { money: -0.4, mods: { demandC: 0.05, happiness: 0.01 }, days: 180 }, out: 'The second shop opens to a queue around the block. You get the first croissant.' },
      { label: '📣 Give it a shout-out', fx: { mods: { demandC: 0.02 }, days: 90 }, out: 'A mention in your weekly address. Sales double overnight.' },
      { label: '🍞 Let the market decide', ignore: true, fx: {}, out: 'The market decides: it is delicious. The baker expands anyway, very slowly.' },
    ],
  },
  /* ---- policy follow-ups (only while the policy is enacted) ---- */
  {
    id: 'karaoke', adv: 'safety', icon: '🎤', title: 'The 4 a.m. Karaoke Problem',
    text: 'The Night Life District is a hit — maybe too much of a hit. Residents report that someone sings “My Heart Will Go On” at 4 a.m. Every. Single. Night.',
    when: (c) => c.pol('nightlife'), weight: 2,
    choices: [
      { label: '🔇 Quiet hours after 2 a.m.', fx: { mods: { noise: -0.12, demandC: -0.03, happiness: 0.01 }, days: 180 }, out: 'Quiet hours begin. The 4 a.m. singer now performs at 1:59 a.m., with great urgency.' },
      { label: '🎶 Soundproof the clubs', fx: { money: -1, mods: { noise: -0.08 }, days: 360 }, out: 'Foam everywhere. Inside, the karaoke is louder than ever. Outside: blissful silence.' },
      { label: '🌃 Karaoke is culture', ignore: true, fx: { mods: { noise: 0.06, tourism: 0.08 }, days: 120 }, out: 'The 4 a.m. ballad becomes a tourist attraction. Earplug sales triple.' },
    ],
  },
  {
    id: 'pet_mayor', adv: 'planning', icon: '🐈', title: 'A Cat Runs for School Board',
    text: 'Since “Pets Welcome Everywhere” passed, a tabby named Sir Whiskers has been attending every school board meeting. Now he is officially on the ballot.',
    when: (c) => c.pol('pets'), weight: 2,
    choices: [
      { label: '🗳️ Let democracy decide', fx: { mods: { happiness: 0.03, tourism: 0.08 }, days: 180, news: 'Cat named Sir Whiskers wins {city} school board seat in a landslide' }, out: 'Sir Whiskers wins in a landslide. His first act: longer nap time. Test scores somehow improve.' },
      { label: '🐾 Make him honorary mascot', fx: { mods: { happiness: 0.015 }, days: 120 }, out: 'Sir Whiskers accepts the title, then knocks the certificate off the table.' },
      { label: '📋 Humans only, please', ignore: true, fx: { mods: { happiness: -0.01 }, days: 60 }, out: 'Sir Whiskers withdraws. He is seen glaring at City Hall from a windowsill.' },
    ],
  },
  {
    id: 'packed_buses', adv: 'transport', icon: '🚌', title: 'Free Buses, Full Buses',
    text: 'Free Public Transit is so popular that buses are packed like voxel sardines. One commuter has lived on the Route 7 bus for a week.',
    when: (c) => c.pol('free_transit'), weight: 2,
    choices: [
      { label: '🚍 Buy more buses', fx: { money: -2, mods: { traffic: -0.08, happiness: 0.02 }, days: 360 }, out: 'A shiny new fleet rolls out. The Route 7 resident finally gets off — at his own stop.' },
      { label: '⏰ Stagger work hours', fx: { mods: { traffic: -0.04, demandC: -0.02 }, days: 240 }, out: 'Half the city now starts work at 10. The other half is jealous.' },
      { label: '🥫 Sardines are cosy', ignore: true, fx: { mods: { happiness: -0.02 }, days: 90 }, out: 'The buses stay packed. Commuters form lifelong friendships, mostly against their will.' },
    ],
  },
  {
    id: 'recycling_champs', adv: 'environment', icon: '♻️', title: 'Recycling Champions',
    text: 'Thanks to Mandatory Recycling, {city} placed second in the National Recycling Awards. First place went to a town that recycles its own awards.',
    when: (c) => c.pol('recycling_law'), weight: 2,
    choices: [
      { label: '🏆 Throw a (zero-waste) party', fx: { money: -0.4, mods: { happiness: 0.02, garbage: -0.05 }, days: 120 }, out: 'A party with reusable everything. Even the confetti gets collected afterwards.' },
      { label: '💰 Sell the recycled glass', fx: { money: 1.2 }, out: 'A mountain of sorted glass becomes a very tidy sum.' },
      { label: '📰 Just a press release', ignore: true, fx: { mods: { happiness: 0.005 }, days: 60 }, out: 'The press release is printed on recycled paper. Of course it is.' },
    ],
  },
];
const EVENT = {};
for (const e of EVENTS) EVENT[e.id] = e;

/* ------------------------------------------------------------------ */
/* condition context                                                    */
/* ------------------------------------------------------------------ */
function makeCtx(S) {
  const counts = new Map(), groups = new Map();
  let water = 0;
  for (const b of S.buildings.values()) {
    const d = VC.BLD[b.key];
    if (!d) continue;
    counts.set(b.key, (counts.get(b.key) || 0) + 1);
    groups.set(d.group, (groups.get(d.group) || 0) + 1);
    if (d.water > 0) water++;
  }
  const month = Math.floor(S.time.day / VC.C.DAYS_PER_MONTH) % 12;
  return {
    S, st: S.stats || {}, pop: (S.stats && S.stats.pop) || 0, peak: S.peakPop || 0, money: S.money, month, season: SEASON[month],
    water: water > 0, k: scaleK(S),
    has: (key) => (counts.get(key) || 0) > 0,
    group: (g) => groups.get(g) || 0,
    pol: (key) => !!(VC.econ && VC.econ.isPolicyOn && VC.econ.isPolicyOn(key)),
  };
}

/* ------------------------------------------------------------------ */
/* summaries (chips)                                                    */
/* ------------------------------------------------------------------ */
const MODI = {
  happiness: ['😊', 'Happiness', 1], crime: ['🚓', 'Crime', -1], fire: ['🔥', 'Fire risk', -1], pollution: ['🌫️', 'Pollution', -1],
  health: ['🩺', 'Health', 1], education: ['🎓', 'Education', 1], landValue: ['💎', 'Land value', 1], traffic: ['🚗', 'Traffic', -1],
  powerUse: ['⚡', 'Power use', -1], waterUse: ['💧', 'Water use', -1], garbage: ['🗑️', 'Garbage', -1],
  demandR: ['🏠', 'Housing', 1], demandC: ['🏬', 'Shops', 1], demandI: ['🏭', 'Industry', 1],
  taxR: ['💸', 'Home taxes', 1], taxC: ['💸', 'Shop taxes', 1], taxI: ['💸', 'Factory taxes', 1],
  tourism: ['📸', 'Tourism', 1], noise: ['🔊', 'Noise', -1], growth: ['🏗️', 'Growth', 1],
};
const durText = (d) => (d >= 60 ? Math.round(d / 30) + ' mo' : d + ' days');
const signed = (v) => (v < 0 ? '−' : '+') + VC.fmt.money(Math.abs(v));
function chipsFor(fx, k, roll) {
  const out = [];
  fx = fx || {};
  if (fx.money) { const v = nice(fx.money * k); out.push({ t: signed(v), c: v < 0 ? 'bad' : 'gold' }); }
  if (fx.monthly) { const v = nice(fx.monthly.k * k); out.push({ t: `${signed(v)}/mo × ${fx.monthly.months}`, c: v < 0 ? 'bad' : 'gold' }); }
  if (fx.mods) {
    for (const key in fx.mods) {
      const v = fx.mods[key];
      if (!v) continue;
      const info = MODI[key] || ['✨', key, 1];
      out.push({ t: `${info[0]} ${info[1]} ${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}%`, c: v * info[2] > 0 ? 'good' : 'bad' });
    }
  }
  if (fx.demand) for (const z in fx.demand) out.push({ t: `${{ R: '🏠', C: '🏬', I: '🏭' }[z] || ''} ${{ R: 'Housing', C: 'Shop', I: 'Industry' }[z] || z} ${fx.demand[z] > 0 ? 'boom now' : 'slump now'}`, c: fx.demand[z] > 0 ? 'good' : 'bad' });
  if (fx.special === 'fireworks') out.push({ t: '🎆 Fireworks', c: 'good' });
  if (fx.special === 'cheer') out.push({ t: '🥳 Happy residents', c: 'good' });
  if (fx.special === 'extinguish') out.push({ t: '🧯 Puts out fires', c: 'good' });
  if (fx.note) out.push({ t: fx.note, c: 'neu' });
  if (roll && roll.note) out.push({ t: roll.note, c: 'risk' });
  if (!out.length) out.push({ t: 'Nothing changes', c: 'neu' });
  return out;
}

/* ------------------------------------------------------------------ */
/* temporary modifiers: VC.econ's when available, else a fallback       */
/* ------------------------------------------------------------------ */
const econTM = () => !!(VC.econ && typeof VC.econ.addTempMod === 'function');
/** Fallback only (economy without temp modifiers): S.mods = policy mods + active S.tempMods. */
function refold(S) {
  if (econTM() || !S) return;
  if (!Array.isArray(S.tempMods)) S.tempMods = [];
  const day = S.time.day;
  S.tempMods = S.tempMods.filter((t) => t && t.mods && day < t.until);
  if (VC.econ && VC.econ.computeMods) VC.econ.computeMods();
  const m = S.mods || (S.mods = {});
  for (const t of S.tempMods) for (const k in t.mods) m[k] = (m[k] || 0) + (+t.mods[k] || 0);
  for (const k in m) m[k] = Math.round(M.clamp(m[k], -0.95, 2) * 1000) / 1000;
}
function addTempMod(entry) {
  if (econTM()) return VC.econ.addTempMod(entry);
  const S = S_();
  if (!S || !entry || !entry.mods) return null;
  if (!Array.isArray(S.tempMods)) S.tempMods = [];
  S.tempMods = S.tempMods.filter((t) => t && t.id !== entry.id);
  S.tempMods.push(entry);
  refold(S);
  VC.bus.emit('budgetChanged');
  return entry;
}
function removeTempMod(id) {
  if (econTM() && typeof VC.econ.removeTempMod === 'function') return VC.econ.removeTempMod(id);
  const S = S_();
  if (!S || !Array.isArray(S.tempMods)) return false;
  const n = S.tempMods.length;
  S.tempMods = S.tempMods.filter((t) => t && t.id !== id);
  refold(S);
  VC.bus.emit('budgetChanged');
  return S.tempMods.length !== n;
}

/* ------------------------------------------------------------------ */
/* special effects                                                      */
/* ------------------------------------------------------------------ */
function focusXZ(S) {
  const cam = VC.camera;
  if (cam && isFinite(cam.tx) && isFinite(cam.tz)) return [cam.tx, cam.tz];
  return [S.W / 2, S.H / 2];
}
const SPECIAL = {
  fireworks(S, fx) {
    const [x, z] = focusXZ(S);
    try { if (VC.fx && VC.fx.fireworks) VC.fx.fireworks(x, z, fx.n || 18); } catch (e) { /* fx optional */ }
  },
  /** Fixes up abandoned buildings (the sim's own "recovered" path). */
  restore(S, fx) {
    let n = fx.n || 5;
    for (const b of S.buildings.values()) {
      if (n <= 0) break;
      if (b.key !== 'grow' || !b.abandoned) continue;
      b.abandoned = false;
      b.simUnhappy = 0;
      b.simAband = 0;
      b.simGood = 0;
      b.happy = 0.6;
      VC.world.changed(b);
      n--;
    }
  },
  clearAbandoned(S, fx) {
    let n = fx.n || 5;
    const list = [];
    for (const b of S.buildings.values()) if (b.key === 'grow' && b.abandoned && list.length < n) list.push(b);
    for (const b of list) VC.world.removeBuilding(b, VC.REMOVE ? VC.REMOVE.CLEARED : 'cleared');
  },
  clearRubble(S) {
    const list = [];
    for (const b of S.buildings.values()) if (b.key === 'rubble') list.push(b);
    for (const b of list) VC.world.removeBuilding(b, VC.REMOVE ? VC.REMOVE.CLEARED : 'cleared');
  },
  /** A short happiness boost for every home (the sim eases it back over the following weeks). */
  cheer(S) {
    for (const b of S.buildings.values()) if (b.key === 'grow' && !b.abandoned) b.happy = Math.min(1, (b.happy || 0.5) + 0.12);
  },
  extinguish(S) {
    if (!VC.sim || !VC.sim.extinguish) return;
    const list = [];
    for (const b of S.buildings.values()) if (b.fire > 0) list.push(b);
    for (const b of list) { try { VC.sim.extinguish(b); } catch (e) { /* ignore */ } }
  },
};

/* ------------------------------------------------------------------ */
/* state + flow                                                         */
/* ------------------------------------------------------------------ */
function ensure(S) {
  let D = S.desk;
  if (!D || typeof D !== 'object' || Array.isArray(D)) D = S.desk = {};
  if (!isFinite(D.start)) D.start = S.time.day;
  if (!isFinite(D.next)) D.next = Math.max(D.start + FIRST_DAYS, S.time.day + 30) + Math.floor(M.hash(S.seed | 0, D.start | 0, 5) * 30);
  if (!(D.seq >= 0)) D.seq = 0;
  if (!Array.isArray(D.history)) D.history = [];
  if (!D.seen || typeof D.seen !== 'object') D.seen = {};
  if (!Array.isArray(D.recurring)) D.recurring = [];
  if (D.pending && (typeof D.pending !== 'object' || !EVENT[D.pending.id])) D.pending = null;
  if (D.pending === undefined) D.pending = null;
  if (D.pending) {
    const p = D.pending;
    if (!isFinite(p.expires)) p.expires = S.time.day + DECIDE_DAYS;
    if (!(p.k > 0)) p.k = scaleK(S);
  }
  return D;
}
const fill = (t, S) => String(t || '').replace(/\{city\}/g, (S && S.name) || 'the city');
/** Display object for a pending event (what the HUD renders). */
function view(p) {
  const S = S_();
  if (!p || !S) return null;
  const e = EVENT[p.id];
  if (!e) return null;
  const A = (VC.ADVISORS && VC.ADVISORS[p.adv || e.adv]) || { name: 'City Hall', role: 'Mayor’s Office', icon: '💼', color: '#ffd166' };
  const choices = e.choices.map((ch, i) => {
    const cost = ch.fx && ch.fx.money < 0 ? nice(-ch.fx.money * p.k) : 0;
    return {
      i, label: ch.label, ignore: !!ch.ignore, cost,
      affordable: !cost || S.sandbox || S.money >= cost,
      chips: chipsFor(ch.fx, p.k, ch.roll),
      dur: ch.fx && ch.fx.mods && ch.fx.days ? durText(ch.fx.days) : '', // how long the modifiers last
    };
  });
  return {
    seq: p.seq, id: e.id, icon: e.icon, title: e.title, text: fill(e.text, S),
    advisor: { key: p.adv || e.adv, name: A.name, role: A.role, icon: A.icon, color: A.color },
    choices, day: p.day, expires: p.expires, daysLeft: Math.max(0, p.expires - S.time.day), decideDays: DECIDE_DAYS,
  };
}
function pickEvent(S, c, forceId) {
  if (forceId) return EVENT[forceId] || null;
  const D = S.desk, day = S.time.day;
  const rnd = M.rng((S.seed ^ Math.imul(day + 13, 2246822519) ^ (D.seq * 31)) >>> 0);
  const ok = (e, fresh) => {
    if (fresh && D.seen[e.id] != null && day - D.seen[e.id] < COOLDOWN) return false;
    try { return !!e.when(c); } catch (err) { return false; }
  };
  let pool = EVENTS.filter((e) => ok(e, true));
  if (!pool.length) pool = EVENTS.filter((e) => ok(e, false) && D.history[0] && D.history[0].id !== e.id);
  if (!pool.length) return null;
  let tot = 0;
  for (const e of pool) tot += e.weight || 1;
  let r = rnd() * tot;
  for (const e of pool) { r -= e.weight || 1; if (r <= 0) return e; }
  return pool[pool.length - 1];
}
/** Puts an event on the desk. Returns its view. */
function open(S, e) {
  const D = S.desk, day = S.time.day;
  D.pending = { seq: ++D.seq, id: e.id, day, expires: day + DECIDE_DAYS, k: scaleK(S), adv: e.adv };
  D.seen[e.id] = day;
  const v = view(D.pending);
  VC.bus.emit('deskEvent', { event: v });
  return v;
}
function applyFx(S, fx, p, e, tag, force) {
  if (!fx) return;
  const k = p.k, day = S.time.day;
  if (fx.money) {
    const v = nice(fx.money * k);
    if (v > 0) VC.money.earn(v, 'desk');
    else VC.money.spend(-v, 'desk', force);
  }
  if (fx.monthly && fx.monthly.months > 0) {
    S.desk.recurring.push({ id: 'desk:' + p.seq + tag, label: e.title, amount: nice(fx.monthly.k * k), left: fx.monthly.months | 0 });
  }
  if (fx.mods) addTempMod({ id: 'desk:' + p.seq + tag, source: 'desk', label: e.title, mods: Object.assign({}, fx.mods), until: day + (fx.days || 90) });
  if (fx.demand && S.demand) for (const z in fx.demand) if (z in S.demand) S.demand[z] = M.clamp(S.demand[z] + fx.demand[z], -1, 1);
  if (fx.special && SPECIAL[fx.special]) { try { SPECIAL[fx.special](S, fx); } catch (err) { console.error('[desk] special ' + fx.special, err); } }
  if (fx.news && VC.advisors && VC.advisors.pushNews) { try { VC.advisors.pushNews(fill(fx.news, S), 0, 'desk:' + e.id); } catch (err) { /* ignore */ } }
}
/** Resolves the pending event with choice i (-1 = ignore / expired). */
function resolve(S, i, auto) {
  const D = S.desk, p = D.pending;
  if (!p) return { ok: false, reason: 'Nothing on the desk' };
  const e = EVENT[p.id];
  if (!e) { D.pending = null; return { ok: false, reason: 'Unknown event' }; }
  let ch = i >= 0 ? e.choices[i] : null;
  if (i < 0) {
    const j = e.choices.findIndex((x) => x.ignore);
    if (j >= 0) { ch = e.choices[j]; i = j; }
  }
  const v = view(p);
  let out, fx, label;
  if (ch) {
    const cost = ch.fx && ch.fx.money < 0 ? nice(-ch.fx.money * p.k) : 0;
    if (!auto && cost && !S.sandbox && S.money < cost) {
      VC.bus.emit('noMoney', { amount: cost, cat: 'desk' });
      return { ok: false, reason: 'Not enough money' };
    }
    fx = ch.fx;
    out = ch.out;
    label = ch.label;
  } else {
    const ig = e.ignore || {};
    fx = ig.fx;
    out = ig.out || 'The moment passed. Nothing changed.';
    label = 'No decision';
  }
  applyFx(S, fx, p, e, ':' + i, !!auto);
  if (ch && ch.roll && Math.random() < ch.roll.p) {
    applyFx(S, ch.roll.fx, p, e, ':' + i + 'r', true);
    out = ch.roll.out || out;
  }
  out = fill(out, S);
  D.history.unshift({ seq: p.seq, id: e.id, title: e.title, icon: e.icon, choice: auto ? -1 : i, label, out, day: S.time.day, auto: !!auto });
  if (D.history.length > HISTORY_CAP) D.history.length = HISTORY_CAP;
  D.pending = null;
  const gap = GAP_MIN + Math.floor(M.hash(p.seq, S.time.day, S.seed | 0) * (GAP_MAX - GAP_MIN + 1));
  D.next = S.time.day + gap;
  VC.bus.emit('deskResolved', { event: v, choice: auto ? -1 : i, label, outcome: out, auto: !!auto });
  return { ok: true, outcome: out, label };
}

function onDay() {
  const S = S_();
  if (!live(S)) return;
  const D = S.desk, day = S.time.day;
  if (!econTM() && Array.isArray(S.tempMods) && S.tempMods.length) refold(S);
  if (D.pending) {
    if (day >= D.pending.expires) resolve(S, -1, true);
    return;
  }
  if (day < D.next) return;
  if (tutorialOn() || disasterOn()) { D.next = day + 5; return; }
  const c = makeCtx(S);
  const e = pickEvent(S, c);
  if (!e) { D.next = day + RETRY_DAYS; return; }
  open(S, e);
}
function onMonth() {
  const S = S_();
  if (!live(S)) return;
  const R = S.desk.recurring;
  if (!R.length) return;
  for (const r of R) {
    if (r.amount > 0) VC.money.earn(r.amount, 'desk');
    else if (r.amount < 0) VC.money.spend(-r.amount, 'desk', true);
    r.left--;
  }
  S.desk.recurring = R.filter((r) => r.left > 0);
}

const Desk = (VC.desk = {
  EVENTS,
  DECIDE_DAYS,
  init() {
    if (inited) return;
    inited = true;
    VC.bus.on('day', () => { try { onDay(); } catch (e) { console.error('[desk] day', e); } });
    VC.bus.on('month', () => { try { onMonth(); } catch (e) { console.error('[desk] month', e); } });
    // fallback temp modifiers: econ.computeMods() (policy changes, takeover) rebuilds S.mods from policies only
    VC.bus.on('policyChanged', () => { const S = S_(); if (S && !econTM() && Array.isArray(S.tempMods) && S.tempMods.length) refold(S); });
  },
  reset(S) {
    if (!S || S.demo) return;
    ensure(S);
    if (!econTM() && Array.isArray(S.tempMods) && S.tempMods.length) refold(S);
  },
  update() {},
  /** The decision waiting on the desk (display object) or null. */
  pending() {
    const S = S_();
    return live(S) && S.desk.pending ? view(S.desk.pending) : null;
  },
  view,
  /** Answers the pending decision with choice i. Returns {ok, outcome, label, reason?}. */
  choose(i) {
    const S = S_();
    if (!live(S)) return { ok: false, reason: 'No city' };
    const p = S.desk.pending;
    const e = p && EVENT[p.id];
    if (!e || !(i >= 0 && i < e.choices.length)) return { ok: false, reason: 'No such choice' };
    return resolve(S, i | 0, false);
  },
  /** Debug: puts an event on the desk now (any pending one is dropped). id omitted = a random eligible one. */
  trigger(id) {
    const S = S_();
    if (!S || S.demo) return null;
    ensure(S);
    if (id && !EVENT[id]) return null;
    const e = pickEvent(S, makeCtx(S), id) || (id ? null : EVENTS[Math.floor(Math.random() * EVENTS.length)]);
    if (!e) return null;
    S.desk.pending = null;
    return open(S, e);
  },
  history() {
    const S = S_();
    return S && S.desk ? S.desk.history : [];
  },
  addTempMod,
  removeTempMod,
});

/* Lifecycle fallback: join main's module loop when main.js does not list this module. */
VC.bus.on('boot', () => {
  const order = VC.MODULE_ORDER;
  if (!order || order.indexOf('desk') >= 0) return;
  const at = order.indexOf('goals') >= 0 ? order.indexOf('goals') : order.indexOf('advisors');
  order.splice(at >= 0 ? at + 1 : order.length, 0, 'desk');
  try { Desk.init(); } catch (e) { console.error('[desk] init', e); }
});
