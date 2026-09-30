/*
 * VOXELPOLIS — newspaper headline data + templating for the news ticker (used by sim/advisors.js).
 *
 *   VC.headlines.POOL       ≥ 150 funny evergreen headlines (templates)
 *   VC.headlines.CTX[key]   context-aware headline variants (population, traffic, smog, weather, …)
 *   VC.headlines.names(S)   deterministic per-city names: mayor, streets, districts, team
 *   VC.headlines.fill(tpl, vars, rng)  replaces {tokens}
 *
 * Headlines are PLAIN TEXT (they may contain the player's city name): escape them before using them as HTML.
 *
 * Tokens: {city} {mayor} {street} {street2} {district} {team} {person} {person2} {pet} {company}
 *         {n} (2-9) {nn} (10-99) {nnn} (100-999) {year} {month} {season} + any key passed in vars.
 */
const FIRST = ['Ada', 'Barry', 'Cleo', 'Dmitri', 'Esme', 'Frank', 'Gloria', 'Hank', 'Ines', 'Jules', 'Kiki', 'Lars', 'Mabel', 'Ned', 'Olive', 'Pablo', 'Quinn', 'Rosa', 'Stan', 'Tilly', 'Umar', 'Vera', 'Walt', 'Xena', 'Yuri', 'Zelda', 'Bo', 'Priya', 'Omar', 'Hattie', 'Gus', 'Noor', 'Iggy', 'Marisol'];
const LAST = ['Blockwell', 'Cubano', 'Voxelson', 'Squarely', 'Brickman', 'Pixelberg', 'Gridley', 'Stackhouse', 'McCube', 'Hexley', 'Boxer', 'Cornerstone', 'Plumb', 'Quarry', 'Mortar', 'Beamish', 'Tilesworth', 'Lattice', 'Cobble', 'Edgeworth', 'Chunkley', 'Blocksberg', 'Rightangle', 'Stonewall'];
const STREET_A = ['Maple', 'Oak', 'Cedar', 'Main', 'Voxel', 'Cube', 'Pixel', 'Elm', 'Harbor', 'Mill', 'Birch', 'Sunset', 'Lakeview', 'Station', 'Market', 'Chestnut', 'Willow', 'Granite', 'Bramble', 'Juniper', 'Poplar', 'Lantern', 'Clover', 'Beacon', 'Orchard', 'Foundry'];
const STREET_B = ['Street', 'Avenue', 'Lane', 'Road', 'Boulevard', 'Way', 'Drive', 'Terrace', 'Row', 'Crescent'];
const DISTRICTS = ['Old Town', 'the North Side', 'Downtown', 'the Docks', 'Uptown', 'the East End', 'Little Pixel', 'the Heights', 'Riverside', 'Midtown', 'the West End', 'Cube Hill', 'the Flats', 'Brickton'];
const PETS = ['a cat named Sir Whiskers', 'a goose', 'a golden retriever named Biscuit', 'a raccoon', 'a very large pigeon', 'a tortoise named Gerald', 'a parrot', 'a hamster named Chairman Nibbles', 'an alpaca', 'a llama in a tiny hat', 'a corgi', 'a suspiciously square frog', 'three ducks in a trench coat', 'a cat', 'a ferret named Kevin'];
const COMPANIES = ['CubeCorp', 'Voxel Dynamics', 'Square Deal Insurance', 'Pixel & Sons', 'Stackable Foods', 'Gridlock Logistics', 'Cornerstone Bank', 'Brickhouse Brewing', 'Octagon Labs', 'MegaBlock Mining', 'Right Angle Realty', 'Blocky Balboa Gyms', 'Quadrant Media', 'Chunk Norris Security', 'Hexahedron Holdings'];
const SEASONS = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];

/* ≥150 evergreen headlines. Keep them short: they scroll in a ticker. */
const POOL = [
  'Local cat elected to parks committee',
  'Scientists confirm {city} is 100% voxels',
  "Mayor's approval rating now measured in cubes",
  'Man finds perfectly round object, experts baffled',
  '{person} wins pie-eating contest, loses to pie in rematch',
  'Pigeons on {street} form union, demand better crumbs',
  'Study: residents spend {nn}% of their day looking for parking',
  '{company} unveils revolutionary square wheel',
  'Resident insists the sun is "slightly pixelated today"',
  'Garden gnome goes missing on {street}; ransom note demands garden',
  '{pet} named employee of the month at {company}',
  'Local bakery introduces cube-shaped donuts; hole remains controversial',
  'Weather forecast: 70% chance of blocks',
  '{mayor} caught jaywalking, fines self',
  'City council debates whether a hot dog is a sandwich; session runs {n} hours',
  'Library reports record number of overdue books about deadlines',
  'Town crier replaced by slightly louder town crier',
  'Residents of {district} report mysterious humming; turns out to be fridge',
  'New study finds {nn}% of statistics are made up on the spot',
  'Local man reticulates splines, refuses to explain',
  '{person} breaks record for most consecutive right angles',
  'Squirrel caught stealing Wi-Fi from {company} HQ',
  'Traffic cone on {street} celebrates {n} years in the same spot',
  '"It\'s hip to be square," declares {city} fashion week',
  'Chef grills perfectly cubic steak; critics call it "edgy"',
  'Scientists discover new shade of grey; city repaints nothing',
  'Area teenager says "no cap", city removes all caps from fire hydrants',
  'Pothole on {street} granted historic landmark status',
  'Fountain coins total ${nnn}; city considers "fountain bonds"',
  'Local philosopher asks: if a building grows and no one zones it, is it zoned?',
  'Annual cheese rolling event cancelled: cheese too square to roll',
  '{person} opens museum dedicated to beige',
  'Bus driver completes route on time; passengers suspicious',
  '{mayor} promises "more of the good stuff, less of the bad stuff"',
  'Seagulls declare war on {district} french fries',
  '{company} stock soars after CEO says "synergy" {n} times',
  'Residents vote to rename Tuesday "Blocksday"',
  'Newly discovered beetle is "basically a tiny cube"',
  'Local dog learns to open doors; city in crisis',
  'Knitting club yarn-bombs {street}; lamp posts now cozy',
  'Science fair winner builds working model of {city} out of sugar cubes',
  'Citywide survey: {nn}% prefer "the pointy buildings"',
  'Time capsule from last Tuesday opened; contents "still pretty fresh"',
  "Mime arrested, has the right to remain silent (again)",
  'Ice cream truck jingle voted city anthem by accident',
  '{pet} spotted riding the bus alone, pays exact fare',
  "Local bank's vault found to contain mostly spare buttons",
  'Opinion: why are all our clouds so blocky? A mayor responds',
  'Street performer on {street} juggles {n} flaming cubes',
  '{person} claims to have seen a triangle; no one believes them',
  'City planners admit the roundabout "should have been square"',
  'Residents complain new skyscraper blocks view of other skyscraper',
  '{company} launches app that tells you what time it is, sort of',
  'Researchers: napping at your desk increases productivity by {nn}%',
  'Local election decided by coin toss; coin demands recount',
  'Farmers market sells record {nnn} square watermelons',
  'Duck crossing on {street} causes pleasant 10-minute delay',
  'Man who ate {nn} tacos "regrets nothing"',
  '{city} Zoo welcomes baby giraffe; neck "unexpectedly voxelated"',
  'Parks department plants tree, tree grows, everyone thrilled',
  'Weatherman predicts weather; weather occurs',
  'New café serves coffee in cubes: "just add water"',
  '{person} wins lottery, spends it all on lottery tickets',
  'Choir performs {n}-hour rendition of the city jingle',
  'Local sculptor unveils statue of a slightly smaller statue',
  'Historians debate whether {street} was always this long',
  '{team} lose again; fans "still believe"',
  '{team} win by {nn} points, parade planned for {street}',
  'Referee ejected from {team} game for "excessive whistling"',
  'Retired robot opens flower shop on {street}',
  'Residents report hearing jazz from the sewers',
  'City launches investigation into who keeps stacking the benches',
  "{company}'s new slogan: \"We're a company.\"",
  'Air guitar championship draws crowd of {nnn}',
  "{mayor}'s cat now has more followers than the mayor",
  'Scientists teach pigeon to read; pigeon prefers comics',
  'Unexplained cube appears in {district}; turns out to be a building',
  'Local grandma out-bench-presses entire gym',
  'Frisbee lost on roof in 2025 finally returns',
  '{person} crowned {city} spelling bee champion after spelling "voxel" correctly',
  'Toast lands butter-side up; physicists stunned',
  'New law requires all clowns to use turn signals',
  'Fire department rescues cat, cat unimpressed',
  'Police department adds {n} more donuts to annual budget',
  'Local artist paints entire mural with a single pixel',
  'Owl hired as night-shift crossing guard',
  'Residents told to stop hugging the wind turbines',
  "Man who says he's \"not a morning person\" confirmed correct",
  'Snail wins {city} marathon, runners demand rematch',
  'Beekeepers report bees "unusually productive and slightly cubic"',
  'Chess club match ends in {n}-way draw',
  '{company} recalls self-folding laundry: "it folded the owners"',
  'City saves money by painting potholes to look like roads',
  '{person} still waiting for bus that never comes, it is a bench',
  'Kite festival colors the {city} skyline',
  'Ghost reportedly haunting City Hall "just wants to help with paperwork"',
  'Survey finds {nn}% of residents have never seen a circle',
  'Hot air balloon lands on {street}, pilot "just popping in"',
  "{district} book club finishes a book for the first time",
  'Pizza place begins delivering by catapult, "mostly accurate"',
  'Town dentist warns of rising sugar cube consumption',
  'Moose spotted on {street}, attends city council meeting',
  'Local nerd builds computer inside a computer game inside {city}',
  'Opinion: the stars look very square tonight',
  '{person} declares lawn "a no-mow zone", bees rejoice',
  'Retired admiral commands the duck pond with an iron fist',
  'New bridge so pretty that drivers stop to take selfies, causing jam',
  'Handyman fixes squeaky door; city holds celebration',
  'Community garden grows prize-winning {nn}-kilogram pumpkin',
  '{mayor} admits to occasionally pausing time',
  'City sues cloud for blocking the sun',
  "{company} opens office entirely made of other companies' offices",
  'Residents report "suspicious lack of problems" in {district}',
  'Local dog elected honorary fire chief; approves all treats',
  'Fashion trend alert: hats that are also smaller hats',
  'Scientists confirm the grass is, in fact, greener on the other side',
  '{person} teaches parrot to say "please zone more commercial"',
  'Sidewalk chalk artist creates 3D hole; {n} people fall for it',
  "City's oldest resident credits long life to \"not reading headlines\"",
  'New museum exhibit: "Rocks, and why they rock"',
  'Crossword in yesterday\'s paper had no solution, editor apologizes',
  "Train enthusiasts gather to watch trains that don't exist yet",
  'Council approves budget for giant rubber duck in the harbor',
  'Local wizard applies for building permit, denied for "insufficient tower"',
  'Stray balloon causes minor panic at {company} headquarters',
  'Citizens report aggressively friendly neighbours on {street}',
  'Math teacher proves 2+2 still equals 4, parents relieved',
  '{pet} goes viral for skateboarding down {street}',
  'Rumours of a secret {nn}th floor at City Hall denied from the {nn}th floor',
  'Street renamed after typo becomes more popular than original name',
  'The moon: still up there, confirms {city} Observatory',
  'Tourist asks for directions, receives {n} conflicting answers',
  '{person} knits sweater for entire {team} roster',
  'City installs benches facing other benches "for conversation"',
  'Local restaurant earns zero stars, proudly displays sign',
  'Blimp over {city} advertises nothing, draws huge crowds',
  'Owner of {n} cats announces plans for {nn} cats',
  'Scientists: the smell of fresh voxels boosts mood',
  "{company} CEO's paper airplane lands on {street}; stock up {n}%",
  '{mayor} opens new ribbon-cutting ribbon factory',
  'Local legend claims pothole on {street} leads to another city',
  "Barbershop quartet refuses to add fifth member: \"it wouldn't be square\"",
  'Children petition for "more slides, fewer bedtimes"',
  'Clock tower runs {n} minutes fast; residents enjoy being early',
  'Record {nnn} people attend free concert in the park',
  'Garbage collectors stage flawless ballet on {street}',
  'Recycling bins refuse to accept another pizza box',
  'Grandpa assembles flat-pack furniture on first try; family in shock',
  'Man accidentally invents new sport, rules unclear',
  '{city} hot sauce festival sends {nn} to the drinking fountain',
  'Local pigeon sets record for most statues perched on',
  "Police arrest man selling \"slightly used\" clouds",
  'Firefighters host bake-off, nothing catches fire',
  'Opinion: the right angle is the only angle',
  'Voxel artist sues city for "unauthorized use of cubes"',
  'Honeybee population booming, flowers overworked',
  'New traffic light installed, immediately turns yellow forever',
  'Office workers at {company} discover the stairs',
  'Kindergarten class designs new city flag; it is mostly dinosaurs',
  'Couple married atop the tallest building in {district}',
  'Karaoke night at City Hall ends with {mayor} power ballad',
  'Local inventor unveils umbrella for sunshine',
  '{person} finds ${nnn} in old coat, donates it to the pothole fund',
  'Researchers say residents are {nn}% more cheerful on paydays',
  'Crows seen organizing on {street}; experts "a little worried"',
  "Town's single tumbleweed gets a name: Terry",
  'Man shouts "Enhance!" at blurry photo, photo does not enhance',
  'City-wide game of hide-and-seek enters its {n}th week',
  'Postal worker delivers {nnn} letters, all addressed to Santa',
  'Beaver builds dam in {district}; city impressed by work ethic',
  'Everyone agrees on something at council meeting; minutes lost',
  'Film crew shoots blockbuster in {city}; plot "mostly buildings"',
  'Local yoga class achieves perfect cube pose',
  "Scientists say {city}'s clouds are 'suspiciously fluffy'",
  'Fortune cookie factory predicts "a zoning decision in your future"',
];

/* Context-aware banks (advisors.js picks one variant). Extra tokens are documented per key. */
const CTX = {
  popUp: ['Population hits {pop}!', '{city} welcomes resident #{pop}; cake served', 'Census: {city} now home to {pop} souls', 'Moving vans jam {street} as population passes {pop}'],
  popDown: ['Exodus: {city} population slips to {pop}', 'Residents leaving {city}; "it\'s not you, it\'s the potholes"'],
  traffic: ['Traffic on {street} worse than ever', 'Commuters report {n}-hour delays on {street}', 'Local man finally reaches work after leaving last year', '{street} declared "world\'s slowest parking lot"', 'Honking on {street} reaches symphonic levels'],
  trafficGood: ['Traffic flows freely; commuters "bored", arrive early', 'Rush hour on {street} lasts a record-low {n} minutes'],
  smog: ['Coal plant smog blankets {city}', 'Residents spotted wearing gas masks to brunch', 'Sunset now "mostly beige", say {city} residents', 'Smog so thick in {district} you can chew it'],
  pollution: ['Air quality hits new low in {district}', 'Doctors advise holding breath "whenever possible"', 'Birds seen coughing over {district}'],
  clean: ['{city} air "cleanest in the region", say scientists', 'Residents rediscover the colour of the sky'],
  crime: ['Crime wave hits {district}', 'Police baffled as {n} garden gnomes vanish from {street}', 'Pickpockets report record quarter in {district}', 'Neighbourhood watch recruits record numbers after break-ins'],
  safe: ['{district} goes a whole month without a single crime', 'Police officers report "nothing to report"; take up knitting'],
  unemployment: ['Job fair on {street} draws crowd of {nnn}', 'Unemployment reaches {unemp}%; {mayor} promises "jobs, cubes, more jobs"', 'Lines around the block at {city} employment office'],
  laborShortage: ['Help Wanted signs outnumber residents in {district}', '{company} so desperate for staff it hires a goose'],
  happy: ['Poll: {happy}% of residents love living in {city}', 'Citizens rate {mayor} "pretty okay, actually"', 'Spontaneous street party breaks out on {street}'],
  unhappy: ['Protesters gather outside City Hall, demand "fewer problems"', 'Approval for {mayor} dips to {approval}%', 'Residents of {district} write strongly worded letters'],
  taxUp: ['{mayor} raises taxes; wallets weep', 'Tax hike sparks grumbling at {street} diner', 'New tax rates "a bit much", say {nn}% of residents'],
  taxDown: ['Tax cut! Residents celebrate with modest purchases', '{mayor} slashes taxes; shopkeepers on {street} rejoice', 'Lower taxes lure newcomers to {city}'],
  deficit: ['City budget deep in the red, says treasurer', '{city} treasury "looking a bit thin", admits {mayor}', 'Council considers bake sale to plug budget hole'],
  surplus: ['Budget surplus! {mayor} considers gold-plated fountain', 'City coffers overflow; treasurer seen swimming in coins', '{city} posts healthy surplus for {n}th month running'],
  broke: ['{city} teeters on the brink of bankruptcy', 'Bank of Blocks bails out {city}; mayor "very grateful, very sorry"'],
  blackout: ['Blackouts roll across {city}; candle sales soar', 'Power shortage leaves {district} in the dark', 'Residents charge phones by rubbing balloons'],
  noPower: ['{city} still has no power plant; residents read by moonlight'],
  waterShort: ['Taps run dry in {district}', 'Water shortage: residents told to shower "in spirit"', 'Rain dances held in {district} amid water crisis'],
  garbage: ['Trash piles up on {street}; seagulls ecstatic', 'Garbage mountain in {district} now visible from space', 'Raccoons form a government amid trash crisis'],
  fires: ['Firefighters battle blaze on {street}', '{n} buildings burn in {district}; fire chief calls for more stations'],
  rain: ['Rain soaks {city}; umbrella stocks surge', 'Puddle on {street} declared a lake', 'Drizzle ruins {n} picnics'],
  storm: ['Thunderstorm lights up the {city} skyline', 'Lightning strikes {company} HQ, "improves Wi-Fi"'],
  snow: ['Snow day! Schools across {city} closed', 'Snowball fight on {street} escalates to diplomatic incident', 'Snowplows battle drifts on {street}'],
  fog: ['Thick fog swallows {district}; residents navigate by smell', 'Fog so dense on {street} that it has its own postcode'],
  heat: ['Heatwave! Ice cream trucks sell out on {street}', 'Sidewalk egg-frying contest draws {nnn} on {street}'],
  spring: ['Spring has sprung in {city}; allergies too', 'Cherry blossoms paint {street} pink'],
  summer: ['Summer arrives; {city} beaches packed', 'School\'s out! Kids flood the parks of {district}'],
  autumn: ['Autumn leaves blanket {street}', 'Pumpkin spice everything returns to {city}'],
  winter: ['Winter arrives in {city}; scarves mandatory', 'First frost glitters on the rooftops of {district}'],
  milestone: ['{city} officially declared a {milestone}!', 'From humble beginnings: {city} becomes a {milestone}', 'Fireworks as {city} graduates to {milestone} status'],
  unlock: ['Council approves {things} for {city}', 'Coming soon to {city}: {things}'],
  building: ['Grand opening: {building} unveiled in {district}', 'Ribbon cut at new {building}; scissors described as "enormous"', '{city} celebrates its new {building}'],
  policyOn: ['{policy} takes effect citywide', 'Council passes {policy}; reactions mixed', 'New ordinance: {policy}'],
  policyOff: ['Council repeals {policy}', '{policy} scrapped by City Hall'],
  loan: ['{city} borrows {amount} from the Bank of Blocks', 'City takes out {amount} loan; "we\'ll pay it back, promise"'],
  loanRepaid: ['{city} pays off its loan; accountants weep with joy', 'Debt-free! {city} settles with the Bank of Blocks'],
  strike: ['{dept} workers strike over budget cuts', 'Picket lines form outside {dept} offices'],
  achievement: ['{city} earns "{achievement}" honours', 'Achievement unlocked: {achievement}'],
  // disasters (extra tokens: {destroyed}, {magnitude}, {abducted}, {building})
  fire_start: ['Major fire rages in {district}', 'Blaze erupts in {district}; residents evacuated'],
  fire_end: ['Firefighters contain {district} blaze', 'Smoke clears over {district} after major fire'],
  tornado_start: ['Tornado touches down near {city}!', 'Twister spotted heading for {district}'],
  tornado_end: ['Tornado cleanup begins; {destroyed} buildings lost', 'Residents recover belongings scattered by twister, some found in next town'],
  meteor_start: ['Meteor streaks across the sky toward {city}!'],
  meteor_impact: ['METEOR STRIKES {city}! Crater visible from orbit', 'Space rock slams into {district}; astronomers "told you so"'],
  meteor_end: ['Meteor crater becomes instant tourist attraction', 'Scientists flock to {city} crater; souvenir rocks sell out'],
  earthquake_start: ['Magnitude {magnitude} quake rattles {city}', 'EARTHQUAKE! {city} shakes, rattles and rolls'],
  earthquake_end: ['Quake aftermath: {destroyed} buildings collapsed', 'Seismologists: "that was a big one"'],
  ufo_start: ['UFO sighted over {city}! Officials "not ruling anything out"', 'Mysterious lights hover above {district}'],
  ufo_abduct: ['Aliens beam up {building}! Owners demand refund', 'UFO abducts {building}; witnesses "mostly fine"'],
  ufo_end: ['UFO departs {city} with {abducted} buildings; "we are not alone," says {mayor}', 'Aliens leave; conspiracy theorists "totally vindicated"'],
  monster_start: ['CUBEZILLA SPOTTED OFF THE COAST OF {city}!', 'Giant voxel lizard emerges, heads for {district}'],
  monster_end: ['Cubezilla wanders off after flattening {destroyed} buildings', 'Monster gone; {city} begins long cleanup'],
};

/** Deterministic per-city names from the seed (re-derived when the city or its mayor is renamed). */
function names(S) {
  const key = String(S.name) + '\u0001' + String(S.mayorName || S.mayor || '');
  if (names._S === S && names._c && names._k === key) return names._c;
  const r = VC.M.rng((S.seed ^ 0x6e657773) >>> 0);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const streets = [];
  const used = new Set();
  while (streets.length < 16) {
    const s = pick(STREET_A) + ' ' + pick(STREET_B);
    if (!used.has(s)) { used.add(s); streets.push(s); }
  }
  const surname = S.mayorName || S.mayor || pick(LAST);
  const city = S.name || 'Voxelpolis';
  const c = {
    city,
    mayor: /^mayor\b/i.test(surname) ? surname : 'Mayor ' + surname,
    streets,
    districts: DISTRICTS.slice(),
    team: city.split(' ')[0] + ' ' + pick(['Cubes', 'Blockers', 'Voxels', 'Bricks', 'Stackers', 'Pixels']),
  };
  names._S = S;
  names._c = c;
  names._k = key;
  return c;
}

/** Replaces {tokens} in tpl. vars override defaults; rng defaults to Math.random. */
function fill(tpl, vars = {}, rng = Math.random) {
  const S = VC.state;
  const nm = S ? names(S) : { city: 'Voxelpolis', mayor: 'Mayor Blockwell', streets: ['Main Street', 'Oak Avenue'], districts: DISTRICTS, team: 'Voxelpolis Cubes' };
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const st1 = pick(nm.streets);
  let st2 = pick(nm.streets);
  if (st2 === st1) st2 = nm.streets[(nm.streets.indexOf(st1) + 1) % nm.streets.length];
  const day = S ? S.time.day : 0;
  const m = Math.floor(day / VC.C.DAYS_PER_MONTH) % 12;
  return tpl.replace(/\{(\w+)\}/g, (all, k) => {
    if (vars[k] != null) return String(vars[k]);
    switch (k) {
      case 'city': return nm.city;
      case 'mayor': return nm.mayor;
      case 'street': return st1;
      case 'street2': return st2;
      case 'district': return pick(nm.districts);
      case 'team': return nm.team;
      case 'person': return pick(FIRST) + ' ' + pick(LAST);
      case 'person2': return pick(FIRST) + ' ' + pick(LAST);
      case 'pet': return pick(PETS);
      case 'company': return pick(COMPANIES);
      case 'n': return String(2 + Math.floor(rng() * 8));
      case 'nn': return String(10 + Math.floor(rng() * 90));
      case 'nnn': return String(100 + Math.floor(rng() * 900));
      case 'year': return String(VC.C.START_YEAR + Math.floor(day / (VC.C.DAYS_PER_MONTH * 12)));
      case 'month': return VC.C.MONTHS[m];
      case 'season': return SEASONS[m];
      case 'pop': return S ? VC.fmt.num(S.stats.pop) : '0';
      default: return all;
    }
  }).replace(/^./, (c) => c.toUpperCase());
}

VC.headlines = { POOL, CTX, FIRST, LAST, STREET_A, STREET_B, DISTRICTS, PETS, COMPANIES, names, fill };
