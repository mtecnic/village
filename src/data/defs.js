/*
 * VOXELPOLIS — game data definitions. THE shared contract for all modules.
 * Constants, enums, zones, roads, the building catalog, policies, departments,
 * overlays, milestones, quality presets, advisors.
 *
 * Coordinates: tile (x, z), 0..W-1 / 0..H-1, index i = z * W + x.
 * World space: 1 tile = 1 world unit on X/Z. Y is up. Tile (x,z) spans [x,x+1] x [z,z+1].
 * Terrain height is an integer LEVEL per tile; world Y of a tile top = level * C.STEP.
 * Voxel models use C.VOX = 1/8 world unit per voxel, i.e. 8 voxels per tile edge.
 */
const C = (VC.C = {
  VOX: 1 / 8, // world units per voxel
  TPV: 8, // voxels per tile edge
  STEP: 0.25, // world height of one terrain level (= 2 voxels)
  SEA: 6, // terrain level of dry land at sea; tiles with level < SEA are water
  MAXH: 48, // maximum terrain level
  CHUNK: 16, // terrain chunk size in tiles
  DAY_SEC: 1.0, // real seconds per sim day at speed 1
  SPEEDS: [0, 1, 3, 8], // sim days per real second, index = speed setting (0 = paused)
  DAYS_PER_MONTH: 30,
  START_YEAR: 2025,
  MONTHS: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  DAYCYCLE_SEC: 300, // real seconds per visual day/night cycle
  ROAD_ACCESS: 3, // zoned tile must be within this many tiles of a road (street/avenue) to grow
  BRIDGE_MUL: 4, // road cost multiplier on water tiles
  ZONE_COST: 5, // $ per zoned tile (x density)
  PLINE_COST: 5, // $ per power line tile
  TREE_COST: 15, // $ per tree planted
  TERRAFORM_COST: 12, // $ per level raised/lowered per tile
  DEMOLISH_COST: 0.1, // fraction of build cost to bulldoze a placed building
});
/** World Y of the water surface. Land at level SEA sits slightly above it. */
C.SEA_Y = C.SEA * C.STEP - 0.12;

/* ------------------------------------------------------------------ */
/* Difficulty, map sizes, map types                                     */
/* ------------------------------------------------------------------ */
/**
 * money: starting treasury. costMul: construction / zoning / one-off prices (VC.money.costMul()).
 * upkeepMul: recurring building & road upkeep and policy costs (econ; defaults to costMul).
 * grantMul: scale of the state grant young towns receive (econ).
 * demandMul: growth demand scale.
 */
VC.DIFFICULTY = {
  easy: { name: 'Relaxed', money: 150000, costMul: 0.8, upkeepMul: 0.85, grantMul: 1.2, demandMul: 1.2, desc: 'Plenty of cash, forgiving citizens.' },
  normal: { name: 'Mayor', money: 60000, costMul: 1.0, upkeepMul: 1.0, grantMul: 1, demandMul: 1.0, desc: 'The classic experience.' },
  hard: { name: 'Tycoon', money: 30000, costMul: 1.25, upkeepMul: 1.1, grantMul: 0.8, demandMul: 0.85, desc: 'Tight budgets, demanding voters.' },
  sandbox: { name: 'Sandbox', money: 1e9, costMul: 0, upkeepMul: 1, demandMul: 1.3, unlockAll: true, desc: 'Infinite money, everything unlocked.' },
};
VC.MAP_SIZES = { small: 96, medium: 128, large: 192, huge: 256 };
VC.MAP_TYPES = [
  { key: 'river', name: 'River Valley', icon: '🏞️', desc: 'A winding river through rolling hills.' },
  { key: 'coast', name: 'Coastline', icon: '🏖️', desc: 'Beaches, bays and an endless ocean.' },
  { key: 'islands', name: 'Archipelago', icon: '🏝️', desc: 'Scattered islands. Bridges required.' },
  { key: 'mountains', name: 'Alpine Highlands', icon: '🏔️', desc: 'Snowy peaks and deep valleys.' },
  { key: 'lakes', name: 'Lakeland', icon: '🌊', desc: 'Dozens of lakes among forests.' },
  { key: 'plains', name: 'Great Plains', icon: '🌾', desc: 'Flat and easy. Room to sprawl.' },
];

/* ------------------------------------------------------------------ */
/* Terrain materials (state.terr)                                       */
/* ------------------------------------------------------------------ */
VC.TERR = { GRASS: 0, SAND: 1, DIRT: 2, ROCK: 3, SNOW: 4, MEADOW: 5 };

/* ------------------------------------------------------------------ */
/* Tile flags (state.flags, Uint16) — maintained by sim                 */
/* ------------------------------------------------------------------ */
VC.F = {
  POWER: 1, // tile is energized (network reaches it and supply suffices)
  WATER: 2, // tile has water service
  ACCESS: 4, // within C.ROAD_ACCESS of a street/avenue
  POWERNET: 8, // part of the conductive power network (regardless of supply)
  WATERNET: 16, // part of the water network
};

/* ------------------------------------------------------------------ */
/* Zones (state.zone). code = type * 4 + density; 0 = none             */
/* ------------------------------------------------------------------ */
VC.ZT = { NONE: 0, R: 1, C: 2, I: 3 };
VC.zcode = (type, den) => (type ? type * 4 + den : 0);
VC.ztype = (code) => code >> 2;
VC.zden = (code) => code & 3;
VC.ZONES = {
  1: { key: 'R', name: 'Residential', color: '#39d98a', icon: '🏠' },
  2: { key: 'C', name: 'Commercial', color: '#3fa7ff', icon: '🏬' },
  3: { key: 'I', name: 'Industrial', color: '#ffc83d', icon: '🏭' },
};
VC.DENSITY = { 1: 'Low', 2: 'Medium', 3: 'High' };
/** Density unlocks by peak population. */
VC.DENSITY_UNLOCK = { 1: 0, 2: 800, 3: 6000 };
/**
 * Growable building parameters. cap = residents (R) or jobs (C, I) PER TILE of footprint
 * at level 1..3. sizes = footprints [w,d] the growth logic may choose (first = most common).
 * fallback = extra footprints used only where none of `sizes` fits (odd strips at block edges),
 * so a zoned block always fills up completely.
 */
VC.GROW = {
  R: {
    1: { cap: [6, 10, 16], sizes: [[1, 1]] },
    2: { cap: [30, 55, 85], sizes: [[1, 1], [2, 2], [2, 1]] },
    3: { cap: [120, 220, 380], sizes: [[2, 2], [1, 1], [3, 3]] },
  },
  C: {
    1: { cap: [5, 9, 14], sizes: [[1, 1]] },
    2: { cap: [25, 45, 70], sizes: [[1, 1], [2, 2]] },
    3: { cap: [90, 170, 300], sizes: [[2, 2], [3, 3], [1, 1]] },
  },
  I: {
    1: { cap: [10, 15, 22], sizes: [[1, 1], [2, 2]] },
    2: { cap: [28, 42, 60], sizes: [[2, 2], [3, 3]], fallback: [[1, 1]] },
    3: { cap: [50, 80, 120], sizes: [[3, 3], [2, 2]], fallback: [[1, 1]] },
  },
};
/** Zone tools (painted with rectangle drag). */
VC.ZONE_TOOLS = [];
for (const t of [1, 2, 3]) {
  for (const d of [1, 2, 3]) {
    const z = VC.ZONES[t];
    VC.ZONE_TOOLS.push({
      key: 'zone_' + z.key.toLowerCase() + d,
      code: VC.zcode(t, d),
      type: t,
      den: d,
      name: VC.DENSITY[d] + ' Density ' + z.name,
      icon: z.icon,
      cost: C.ZONE_COST * d,
      unlock: VC.DENSITY_UNLOCK[d],
    });
  }
}

/* ------------------------------------------------------------------ */
/* Roads (state.road)                                                   */
/* ------------------------------------------------------------------ */
VC.ROAD = { NONE: 0, STREET: 1, AVENUE: 2, HIGHWAY: 3 };
VC.ROADS = {
  1: { key: 'street', name: 'Street', icon: '🛣️', cost: 10, upkeep: 0.25, capacity: 120, speed: 1.0, access: true, unlock: 0, desc: 'Two-lane street. Gives zones road access.' },
  2: { key: 'avenue', name: 'Avenue', icon: '🚦', cost: 35, upkeep: 0.7, capacity: 340, speed: 1.3, access: true, unlock: 1500, desc: 'Four lanes with a median. Much higher capacity.' },
  3: { key: 'highway', name: 'Highway', icon: '🛤️', cost: 120, upkeep: 2.0, capacity: 1000, speed: 2.2, access: false, unlock: 15000, desc: 'Fast, huge capacity. No zone access — connect with streets.' },
};

/* ------------------------------------------------------------------ */
/* Budget departments. Every catalog building has a `dept`.             */
/* ------------------------------------------------------------------ */
VC.DEPARTMENTS = [
  { key: 'police', name: 'Police', icon: '🚓' },
  { key: 'fire', name: 'Fire', icon: '🚒' },
  { key: 'health', name: 'Health', icon: '🏥' },
  { key: 'education', name: 'Education', icon: '🎓' },
  { key: 'transit', name: 'Transit', icon: '🚌' },
  { key: 'parks', name: 'Parks & Culture', icon: '🌳' },
  { key: 'utilities', name: 'Power & Water', icon: '⚡' },
  { key: 'waste', name: 'Sanitation', icon: '♻️' },
  { key: 'roads', name: 'Roads', icon: '🛣️' },
];

/* ------------------------------------------------------------------ */
/* Toolbar groups                                                       */
/* ------------------------------------------------------------------ */
VC.TOOL_GROUPS = [
  { key: 'roads', name: 'Roads', icon: '🛣️', hotkey: '1' },
  { key: 'zones', name: 'Zoning', icon: '🏘️', hotkey: '2' },
  { key: 'power', name: 'Power', icon: '⚡', hotkey: '3' },
  { key: 'water', name: 'Water', icon: '💧', hotkey: '4' },
  { key: 'safety', name: 'Safety & Health', icon: '🚒', hotkey: '5' },
  { key: 'education', name: 'Education', icon: '🎓', hotkey: '6' },
  { key: 'parks', name: 'Parks & Leisure', icon: '🌳', hotkey: '7' },
  { key: 'transit', name: 'Transport', icon: '🚌', hotkey: '8' },
  { key: 'waste', name: 'Sanitation', icon: '♻️', hotkey: '9' },
  { key: 'landmarks', name: 'Landmarks', icon: '🏛️', hotkey: '0' },
  { key: 'terrain', name: 'Terraform', icon: '⛰️', hotkey: 'T' },
  { key: 'bulldoze', name: 'Bulldoze', icon: '🚜', hotkey: 'B' },
];

/* ------------------------------------------------------------------ */
/* Building catalog — every player-placeable building.                  */
/*                                                                       */
/* Fields:                                                               */
/*  key, name, group (toolbar), dept (budget), icon, size [w,d] in tiles */
/*  cost ($), upkeep ($/month at 100% funding), unlock (peak pop)        */
/*  jobs: workers employed                                               */
/*  power: MW produced (+), water: kL produced (+)                       */
/*  powerUse / waterUse: consumption (default derived from jobs)         */
/*  pollution: air pollution strength 0..255 at source, pollR: radius    */
/*  noise: noise strength, noiseR                                        */
/*  cover: { service: radius } — service coverage (police, fire,         */
/*         health, edu, park, transit, garbage)                         */
/*  capacity: residents one building can serve at full strength; its    */
/*         coverage weakens by capacity / residents in its area (shared */
/*         with overlapping buildings of the same service)              */
/*  lv: land value bonus at source (+/-), lvR: radius                    */
/*  happy: flat citywide happiness bonus (fraction, e.g. 0.01)           */
/*  tourism: tourism points                                              */
/*  income: $/month earned (casino, stadium tickets, …)                  */
/*  housing: residents housed (arcology)                                 */
/*  needsWater: must touch a water tile                                  */
/*  unique: only one allowed                                             */
/*  requiresPolicy: policy key that must be active                       */
/*  anim: hint for renderer ('wind','ferris','rocket','beacon','spin')   */
/*  desc: flavour text                                                   */
/* ------------------------------------------------------------------ */
VC.CATALOG = [
  // ---- Power ----
  { key: 'coal_plant', name: 'Coal Power Plant', group: 'power', dept: 'utilities', icon: '🏭', size: [3, 3], cost: 5000, upkeep: 150, unlock: 0, jobs: 60, power: 600, pollution: 220, pollR: 11, noise: 120, noiseR: 5, lv: -40, lvR: 8, desc: 'Cheap, reliable, filthy. Belches smoke day and night.' },
  { key: 'gas_plant', name: 'Natural Gas Plant', group: 'power', dept: 'utilities', icon: '🔥', size: [2, 2], cost: 9000, upkeep: 260, unlock: 1500, jobs: 30, power: 350, pollution: 90, pollR: 6, noise: 60, noiseR: 4, lv: -15, lvR: 5, desc: 'Cleaner than coal, pricier to run.' },
  { key: 'wind_turbine', name: 'Wind Turbine', group: 'power', dept: 'utilities', icon: '🌬️', size: [1, 1], cost: 1400, upkeep: 20, unlock: 0, jobs: 1, power: 30, noise: 40, noiseR: 2, anim: 'wind', desc: 'Free energy from the breeze. Output varies with wind; best on hills.' },
  { key: 'solar_farm', name: 'Solar Farm', group: 'power', dept: 'utilities', icon: '☀️', size: [3, 3], cost: 14000, upkeep: 90, unlock: 4000, jobs: 6, power: 170, desc: 'Silent, clean, a bit expensive. Glitters in the sun.' },
  { key: 'nuclear_plant', name: 'Nuclear Power Plant', group: 'power', dept: 'utilities', icon: '☢️', size: [4, 4], cost: 60000, upkeep: 1500, unlock: 25000, jobs: 200, power: 3500, noise: 40, noiseR: 4, lv: -30, lvR: 10, desc: 'Enormous output. Keep the fire department well funded…' },
  { key: 'fusion_plant', name: 'Fusion Reactor', group: 'power', dept: 'utilities', icon: '🌀', size: [4, 4], cost: 250000, upkeep: 4000, unlock: 120000, jobs: 150, power: 12000, lv: 10, lvR: 6, anim: 'spin', desc: 'A captive star. Practically limitless clean power.' },

  // ---- Water ----
  { key: 'water_pump', name: 'Water Pump', group: 'water', dept: 'utilities', icon: '🚰', size: [1, 1], cost: 800, upkeep: 30, unlock: 0, jobs: 3, water: 260, needsWater: true, desc: 'Pumps fresh water. Must be placed next to water.' },
  { key: 'water_tower', name: 'Water Tower', group: 'water', dept: 'utilities', icon: '🗼', size: [1, 1], cost: 1500, upkeep: 45, unlock: 0, jobs: 2, water: 110, desc: 'Collects groundwater anywhere. Lower output.' },
  { key: 'water_plant', name: 'Water Treatment Plant', group: 'water', dept: 'utilities', icon: '💧', size: [2, 2], cost: 9000, upkeep: 280, unlock: 3000, jobs: 20, water: 1000, needsWater: true, happy: 0.01, desc: 'Big, clean supply. Must be placed next to water.' },
  { key: 'desalination', name: 'Desalination Plant', group: 'water', dept: 'utilities', icon: '🌊', size: [3, 3], cost: 40000, upkeep: 900, unlock: 20000, jobs: 50, water: 4000, needsWater: true, noise: 50, noiseR: 4, desc: 'Turns the sea itself into tap water.' },

  // ---- Safety & Health ----
  { key: 'police_station', name: 'Police Station', group: 'safety', dept: 'police', icon: '🚓', size: [2, 2], cost: 3000, upkeep: 170, unlock: 0, jobs: 20, cover: { police: 14 }, capacity: 4000, desc: 'Reduces crime nearby.' },
  { key: 'police_hq', name: 'Police Headquarters', group: 'safety', dept: 'police', icon: '👮', size: [3, 3], cost: 14000, upkeep: 750, unlock: 10000, jobs: 90, cover: { police: 26 }, capacity: 20000, desc: 'Large coverage and a helicopter unit.' },
  { key: 'fire_station', name: 'Fire Station', group: 'safety', dept: 'fire', icon: '🚒', size: [2, 2], cost: 3000, upkeep: 170, unlock: 0, jobs: 20, cover: { fire: 14 }, capacity: 4500, desc: 'Prevents and fights fires nearby.' },
  { key: 'fire_hq', name: 'Fire Headquarters', group: 'safety', dept: 'fire', icon: '🧯', size: [3, 3], cost: 14000, upkeep: 750, unlock: 10000, jobs: 90, cover: { fire: 26 }, capacity: 22000, desc: 'Big trucks, big coverage.' },
  { key: 'clinic', name: 'Medical Clinic', group: 'safety', dept: 'health', icon: '🩺', size: [2, 2], cost: 2500, upkeep: 150, unlock: 0, jobs: 15, cover: { health: 12 }, capacity: 2800, desc: 'Keeps the neighbourhood healthy.' },
  { key: 'hospital', name: 'Hospital', group: 'safety', dept: 'health', icon: '🏥', size: [3, 3], cost: 16000, upkeep: 900, unlock: 5000, jobs: 150, cover: { health: 26 }, capacity: 16000, lv: 10, lvR: 6, desc: 'Full medical care. Citizens live longer.' },

  // ---- Education ----
  { key: 'school', name: 'Elementary School', group: 'education', dept: 'education', icon: '🏫', size: [2, 2], cost: 3000, upkeep: 180, unlock: 0, jobs: 25, cover: { edu: 12 }, capacity: 2500, lv: 8, lvR: 5, desc: 'Reading, writing, arithmetic.' },
  { key: 'high_school', name: 'High School', group: 'education', dept: 'education', icon: '🎒', size: [3, 3], cost: 11000, upkeep: 600, unlock: 3000, jobs: 60, cover: { edu: 20 }, capacity: 8000, lv: 10, lvR: 6, desc: 'An educated workforce attracts better industry.' },
  { key: 'library', name: 'Public Library', group: 'education', dept: 'education', icon: '📚', size: [2, 2], cost: 4000, upkeep: 260, unlock: 1000, jobs: 10, cover: { edu: 16 }, capacity: 4000, lv: 12, lvR: 6, happy: 0.005, desc: 'Books, quiet, and free wifi.' },
  { key: 'university', name: 'University', group: 'education', dept: 'education', icon: '🎓', size: [4, 4], cost: 45000, upkeep: 2200, unlock: 15000, jobs: 300, cover: { edu: 40 }, capacity: 30000, lv: 25, lvR: 12, tourism: 20, desc: 'Brilliant minds. Unlocks high-tech industry growth.' },
  { key: 'science_center', name: 'Science Center', group: 'education', dept: 'education', icon: '🔬', size: [3, 3], cost: 30000, upkeep: 1000, unlock: 30000, jobs: 120, cover: { edu: 30 }, capacity: 20000, lv: 20, lvR: 10, tourism: 30, desc: 'Research labs boosting education and high-tech jobs.' },

  // ---- Parks & Leisure ----
  { key: 'small_park', name: 'Small Park', group: 'parks', dept: 'parks', icon: '🌳', size: [1, 1], cost: 250, upkeep: 10, unlock: 0, cover: { park: 5 }, lv: 12, lvR: 4, desc: 'A patch of green. Neighbours love it.' },
  { key: 'playground', name: 'Playground', group: 'parks', dept: 'parks', icon: '🛝', size: [1, 1], cost: 400, upkeep: 15, unlock: 0, cover: { park: 5 }, lv: 10, lvR: 4, desc: 'Swings, slides and happy kids.' },
  { key: 'plaza', name: 'Fountain Plaza', group: 'parks', dept: 'parks', icon: '⛲', size: [2, 2], cost: 1200, upkeep: 40, unlock: 500, cover: { park: 7 }, lv: 18, lvR: 6, desc: 'A paved plaza with a sparkling fountain.' },
  { key: 'sports_field', name: 'Sports Field', group: 'parks', dept: 'parks', icon: '⚽', size: [3, 2], cost: 2500, upkeep: 80, unlock: 1500, jobs: 4, cover: { park: 9 }, lv: 10, lvR: 6, noise: 30, noiseR: 3, desc: 'Weekend league games under the lights.' },
  { key: 'big_park', name: 'Central Park', group: 'parks', dept: 'parks', icon: '🏞️', size: [3, 3], cost: 5000, upkeep: 150, unlock: 2000, jobs: 5, cover: { park: 13 }, lv: 30, lvR: 10, desc: 'Lakes, trees and winding paths.' },
  { key: 'botanical_garden', name: 'Botanical Garden', group: 'parks', dept: 'parks', icon: '🌺', size: [4, 4], cost: 22000, upkeep: 500, unlock: 25000, jobs: 30, cover: { park: 18 }, lv: 40, lvR: 14, tourism: 40, desc: 'Glass domes full of exotic plants.' },

  // ---- Transport ----
  { key: 'bus_depot', name: 'Bus Depot', group: 'transit', dept: 'transit', icon: '🚌', size: [2, 2], cost: 4000, upkeep: 300, unlock: 1000, jobs: 30, cover: { transit: 16 }, capacity: 6000, desc: 'Buses take cars off the road nearby.' },
  { key: 'metro_station', name: 'Metro Station', group: 'transit', dept: 'transit', icon: '🚇', size: [2, 2], cost: 12000, upkeep: 500, unlock: 12000, jobs: 20, cover: { transit: 22 }, capacity: 20000, lv: 15, lvR: 8, desc: 'Fast underground trains. Big traffic relief.' },
  { key: 'seaport', name: 'Seaport', group: 'transit', dept: 'transit', icon: '⚓', size: [4, 3], cost: 25000, upkeep: 800, unlock: 8000, jobs: 200, needsWater: true, pollution: 60, pollR: 6, noise: 80, noiseR: 6, desc: 'Ships boost industrial demand. Must touch water.' },
  { key: 'airport', name: 'International Airport', group: 'transit', dept: 'transit', icon: '✈️', size: [6, 4], cost: 90000, upkeep: 2500, unlock: 40000, jobs: 600, noise: 200, noiseR: 12, tourism: 120, lv: -20, lvR: 8, unique: true, desc: 'Planes! Huge commercial demand and tourism.' },

  // ---- Sanitation ----
  { key: 'landfill', name: 'Landfill', group: 'waste', dept: 'waste', icon: '🗑️', size: [3, 3], cost: 2500, upkeep: 100, unlock: 0, jobs: 10, cover: { garbage: 30 }, capacity: 8000, pollution: 110, pollR: 7, lv: -50, lvR: 7, desc: 'Somewhere for the trash to go. Smells awful.' },
  { key: 'incinerator', name: 'Incinerator', group: 'waste', dept: 'waste', icon: '🔥', size: [2, 2], cost: 12000, upkeep: 400, unlock: 5000, jobs: 20, cover: { garbage: 30 }, capacity: 20000, power: 90, pollution: 140, pollR: 8, lv: -30, lvR: 6, desc: 'Burns garbage, generates a little power.' },
  { key: 'recycling', name: 'Recycling Center', group: 'waste', dept: 'waste', icon: '♻️', size: [2, 2], cost: 15000, upkeep: 500, unlock: 12000, jobs: 40, cover: { garbage: 36 }, capacity: 25000, pollution: 20, pollR: 3, desc: 'Clean, green waste management.' },

  // ---- Landmarks ----
  { key: 'city_hall', name: 'City Hall', group: 'landmarks', dept: 'parks', icon: '🏛️', size: [3, 3], cost: 8000, upkeep: 200, unlock: 1000, jobs: 40, lv: 30, lvR: 12, happy: 0.02, unique: true, desc: 'The seat of your glorious administration.' },
  { key: 'statue', name: 'Mayor Statue', group: 'landmarks', dept: 'parks', icon: '🗿', size: [1, 1], cost: 1500, upkeep: 5, unlock: 250, cover: { park: 4 }, lv: 10, lvR: 4, happy: 0.002, desc: 'A modest tribute to yourself.' },
  { key: 'monument', name: 'Grand Obelisk', group: 'landmarks', dept: 'parks', icon: '🗼', size: [2, 2], cost: 6000, upkeep: 50, unlock: 3000, lv: 25, lvR: 10, tourism: 15, unique: true, desc: 'Towering marble monument.' },
  { key: 'ferris_wheel', name: 'Ferris Wheel', group: 'landmarks', dept: 'parks', icon: '🎡', size: [3, 3], cost: 20000, upkeep: 300, unlock: 8000, jobs: 15, cover: { park: 14 }, lv: 20, lvR: 8, tourism: 50, happy: 0.01, unique: true, anim: 'ferris', desc: 'A glowing wheel that turns all night.' },
  { key: 'casino', name: 'Casino Royale', group: 'landmarks', dept: 'parks', icon: '🎰', size: [3, 3], cost: 25000, upkeep: 300, unlock: 15000, jobs: 120, income: 1500, tourism: 60, lv: 10, lvR: 6, requiresPolicy: 'gambling', unique: true, desc: 'Neon, money and trouble. Requires Legalized Gambling.' },
  { key: 'stadium', name: 'Stadium', group: 'landmarks', dept: 'parks', icon: '🏟️', size: [4, 4], cost: 45000, upkeep: 1200, unlock: 20000, jobs: 100, income: 900, cover: { park: 25 }, noise: 120, noiseR: 8, tourism: 80, happy: 0.02, unique: true, desc: 'Home of the Voxelpolis Cubes. Floodlit on game nights.' },
  { key: 'tv_tower', name: 'Sky Needle', group: 'landmarks', dept: 'parks', icon: '📡', size: [2, 2], cost: 35000, upkeep: 400, unlock: 30000, jobs: 30, lv: 35, lvR: 16, tourism: 70, unique: true, anim: 'beacon', desc: 'Observation tower with a revolving restaurant.' },
  { key: 'pyramid', name: 'Voxel Pyramid', group: 'landmarks', dept: 'parks', icon: '🔺', size: [5, 5], cost: 120000, upkeep: 600, unlock: 60000, lv: 40, lvR: 18, tourism: 150, happy: 0.02, unique: true, desc: 'A glass-and-gold wonder of the world.' },
  { key: 'space_center', name: 'Space Center', group: 'landmarks', dept: 'education', icon: '🚀', size: [5, 5], cost: 200000, upkeep: 3000, unlock: 100000, jobs: 800, cover: { edu: 50 }, capacity: 40000, lv: 40, lvR: 20, tourism: 200, happy: 0.03, unique: true, anim: 'rocket', desc: 'Rocket launches every few months. Inspires a generation.' },
  { key: 'arcology', name: 'Arcology', group: 'landmarks', dept: 'parks', icon: '🌆', size: [4, 4], cost: 350000, upkeep: 2000, unlock: 200000, jobs: 3000, housing: 25000, lv: 30, lvR: 12, tourism: 100, desc: 'A self-contained city in a single megastructure.' },
];
VC.BLD = {};
for (const b of VC.CATALOG) VC.BLD[b.key] = b;

/* ------------------------------------------------------------------ */
/* Services with coverage maps (state.maps[key])                        */
/* ------------------------------------------------------------------ */
VC.SERVICES = [
  { key: 'police', name: 'Police', dept: 'police', icon: '🚓' },
  { key: 'fire', name: 'Fire Protection', dept: 'fire', icon: '🚒' },
  { key: 'health', name: 'Health Care', dept: 'health', icon: '🏥' },
  { key: 'edu', name: 'Education', dept: 'education', icon: '🎓' },
  { key: 'park', name: 'Parks', dept: 'parks', icon: '🌳' },
  { key: 'transit', name: 'Transit', dept: 'transit', icon: '🚌' },
  { key: 'garbage', name: 'Garbage Pickup', dept: 'waste', icon: '♻️' },
];

/* ------------------------------------------------------------------ */
/* Data overlays (map views). map = key in state.maps                    */
/* ramp: 'good' (low=red, high=green), 'bad' (low=green, high=red),    */
/*       'value' (low=dark blue, high=gold), 'net' (special network)    */
/* ------------------------------------------------------------------ */
VC.OVERLAYS = [
  { key: 'none', name: 'No Overlay', icon: '🗺️' },
  { key: 'landValue', name: 'Land Value', icon: '💎', map: 'landValue', ramp: 'value' },
  { key: 'pollution', name: 'Air Pollution', icon: '🌫️', map: 'pollution', ramp: 'bad' },
  { key: 'crime', name: 'Crime', icon: '🦹', map: 'crime', ramp: 'bad' },
  { key: 'traffic', name: 'Traffic', icon: '🚗', map: 'traffic', ramp: 'bad' },
  { key: 'noise', name: 'Noise', icon: '🔊', map: 'noise', ramp: 'bad' },
  { key: 'happiness', name: 'Happiness', icon: '😊', map: 'happiness', ramp: 'good', nodata0: true },
  { key: 'power', name: 'Power Grid', icon: '⚡', ramp: 'net', flag: 1 },
  { key: 'water', name: 'Water Service', icon: '💧', ramp: 'net', flag: 2 },
  { key: 'police', name: 'Police Coverage', icon: '🚓', map: 'police', ramp: 'good' },
  { key: 'fire', name: 'Fire Coverage', icon: '🚒', map: 'fire', ramp: 'good' },
  { key: 'health', name: 'Health Coverage', icon: '🏥', map: 'health', ramp: 'good' },
  { key: 'edu', name: 'Education', icon: '🎓', map: 'edu', ramp: 'good' },
  { key: 'park', name: 'Parks & Leisure', icon: '🌳', map: 'park', ramp: 'good' },
  { key: 'transit', name: 'Transit Coverage', icon: '🚌', map: 'transit', ramp: 'good' },
  { key: 'garbage', name: 'Garbage Pickup', icon: '♻️', map: 'garbage', ramp: 'good' },
];
/** Names of all per-tile derived maps (Uint8Array 0..255 in state.maps). */
VC.MAP_KEYS = ['landValue', 'pollution', 'crime', 'noise', 'traffic', 'happiness', 'police', 'fire', 'health', 'edu', 'park', 'transit', 'garbage'];

/* ------------------------------------------------------------------ */
/* Policies (ordinances). effects are additive modifiers (see VC.MODS). */
/* cost: flat $/month; costPerCap: $/month per resident                  */
/* visitors: flat tourism points added by the sim (not a modifier)       */
/* Costs are billed per day active (econ), so toggling does not dodge them.*/
/* ------------------------------------------------------------------ */
VC.MODS = ['crime', 'fire', 'pollution', 'health', 'education', 'landValue', 'happiness', 'traffic', 'powerUse', 'waterUse', 'garbage', 'demandR', 'demandC', 'demandI', 'taxR', 'taxC', 'taxI', 'tourism', 'noise', 'growth'];
VC.POLICIES = [
  { key: 'smoke_detectors', name: 'Smoke Detector Program', icon: '🔥', costPerCap: 0.02, unlock: 0, effects: { fire: -0.3 }, desc: 'Free smoke detectors for every home. Fewer fires.' },
  { key: 'neighborhood_watch', name: 'Neighborhood Watch', icon: '👀', costPerCap: 0.02, unlock: 0, effects: { crime: -0.15 }, desc: 'Nosy neighbours become crime fighters.' },
  { key: 'free_clinics', name: 'Free Clinics', icon: '🩺', costPerCap: 0.05, unlock: 500, effects: { health: 0.2, happiness: 0.02 }, desc: 'Walk-in care for all. Healthier, happier citizens.' },
  { key: 'tutoring', name: 'Free Tutoring', icon: '📚', costPerCap: 0.04, unlock: 1000, effects: { education: 0.2 }, desc: 'After-school tutoring boosts education.' },
  { key: 'recycling_law', name: 'Mandatory Recycling', icon: '♻️', costPerCap: 0.03, unlock: 1000, effects: { garbage: -0.3, pollution: -0.05, happiness: -0.01 }, desc: 'Sort your trash! Less garbage, grumpier citizens.' },
  { key: 'clean_air', name: 'Clean Air Act', icon: '🌬️', cost: 0, unlock: 2000, effects: { pollution: -0.3, demandI: -0.15 }, desc: 'Strict emission limits. Industry hates it.' },
  { key: 'green_energy', name: 'Green Energy Subsidy', icon: '🌱', costPerCap: 0.015, unlock: 2000, effects: { powerUse: -0.15, pollution: -0.08, happiness: 0.005 }, desc: 'Efficient appliances cut power demand and smog.' },
  { key: 'water_saving', name: 'Water Conservation', icon: '🚿', costPerCap: 0.01, unlock: 500, effects: { waterUse: -0.2, happiness: -0.01 }, desc: 'Short showers for everyone.' },
  { key: 'tourism_promo', name: 'Tourism Campaign', icon: '📸', cost: 500, unlock: 5000, visitors: 12, effects: { tourism: 0.35, demandC: 0.06 }, desc: '"Visit Voxelpolis!" ads worldwide. Brings some visitors on its own; landmarks multiply it.' },
  { key: 'pro_business', name: 'Business Tax Breaks', icon: '💼', cost: 0, unlock: 1000, effects: { demandC: 0.12, demandI: 0.12, taxC: -0.35, taxI: -0.35 }, desc: 'Businesses pay 35% less tax. More shops and factories, much less revenue.' },
  { key: 'gambling', name: 'Legalize Gambling', icon: '🎲', cost: 0, unlock: 10000, effects: { crime: 0.12, tourism: 0.2, taxC: 0.05 }, desc: 'Allows the Casino. Brings money… and crime.' },
  { key: 'nightlife', name: 'Night Life District', icon: '🌃', cost: 300, unlock: 3000, effects: { demandC: 0.1, noise: 0.15, happiness: 0.02, crime: 0.05 }, desc: 'Clubs open till dawn. Neon everywhere.' },
  { key: 'rent_control', name: 'Rent Control', icon: '🏘️', cost: 0, unlock: 5000, effects: { demandR: 0.15, landValue: -0.15, taxR: -0.1 }, desc: 'Affordable homes, lower property values and property taxes.' },
  { key: 'bike_lanes', name: 'Bike Lane Initiative', icon: '🚲', costPerCap: 0.02, unlock: 2000, effects: { traffic: -0.12, health: 0.05, pollution: -0.03 }, desc: 'Paint the town in bike lanes.' },
  { key: 'free_transit', name: 'Free Public Transit', icon: '🎫', costPerCap: 0.08, unlock: 8000, effects: { traffic: -0.2, happiness: 0.03 }, desc: 'Ride for free. Cars stay home.' },
  { key: 'four_day_week', name: 'Four-Day Work Week', icon: '🏖️', cost: 0, unlock: 12000, effects: { happiness: 0.05, demandC: -0.1, demandI: -0.2, taxC: -0.15, taxI: -0.15 }, desc: 'Long weekends forever. Businesses produce (and pay) less.' },
  { key: 'curfew', name: 'Youth Curfew', icon: '🌙', cost: 50, unlock: 3000, effects: { crime: -0.1, happiness: -0.03 }, desc: 'Kids home by 10pm. Less crime, less fun.' },
  { key: 'pets', name: 'Pets Welcome Everywhere', icon: '🐕', cost: 0, unlock: 0, effects: { happiness: 0.02, garbage: 0.2, noise: 0.08 }, desc: 'Dogs in offices. Cats in libraries. Barking and more trash.' },
  { key: 'ubi', name: 'Universal Basic Income', icon: '💸', costPerCap: 0.6, unlock: 50000, effects: { happiness: 0.1, crime: -0.12, demandR: 0.1 }, desc: 'Monthly cheques for every citizen. Very popular. Very expensive.' },
];
VC.POLICY = {};
for (const p of VC.POLICIES) VC.POLICY[p.key] = p;

/* ------------------------------------------------------------------ */
/* Milestones (by peak population)                                      */
/* ------------------------------------------------------------------ */
VC.MILESTONES = [
  { pop: 0, name: 'Hamlet', reward: 0 },
  { pop: 250, name: 'Village', reward: 5000 },
  { pop: 1000, name: 'Town', reward: 10000 },
  { pop: 3000, name: 'Small City', reward: 15000 },
  { pop: 10000, name: 'City', reward: 25000 },
  { pop: 25000, name: 'Large City', reward: 40000 },
  { pop: 50000, name: 'Metropolis', reward: 60000 },
  { pop: 100000, name: 'Megacity', reward: 100000 },
  { pop: 200000, name: 'Megalopolis', reward: 150000 },
  { pop: 400000, name: 'Ecumenopolis', reward: 250000 },
];

/* ------------------------------------------------------------------ */
/* Advisors                                                             */
/* ------------------------------------------------------------------ */
VC.ADVISORS = {
  finance: { name: 'Penny Pincher', role: 'Finance', icon: '💰', color: '#ffd166' },
  safety: { name: 'Chief Blaze', role: 'Safety', icon: '🚨', color: '#ff6b6b' },
  health: { name: 'Dr. Wellbeing', role: 'Health & Education', icon: '⚕️', color: '#4cc9f0' },
  environment: { name: 'Fern Greenleaf', role: 'Environment', icon: '🌿', color: '#80ed99' },
  transport: { name: 'Rhoda Gridlock', role: 'Transport', icon: '🚦', color: '#f4a261' },
  utilities: { name: 'Watt Flowmore', role: 'Utilities', icon: '⚡', color: '#b8c0ff' },
  planning: { name: 'Zoe Ning', role: 'City Planning', icon: '📐', color: '#c77dff' },
};

/* ------------------------------------------------------------------ */
/* Graphics quality presets                                              */
/* ------------------------------------------------------------------ */
VC.QUALITY = {
  low: { name: 'Low', scale: 0.6, maxDpr: 1, shadow: 0, bloom: false, tilt: false, fxaa: false, ssao: false, godrays: false, particles: 400, cars: 80, lodDist: 40, drawDist: 160 },
  medium: { name: 'Medium', scale: 0.85, maxDpr: 1, shadow: 1024, bloom: true, tilt: false, fxaa: true, ssao: false, godrays: false, particles: 1500, cars: 250, lodDist: 60, drawDist: 220 },
  high: { name: 'High', scale: 1.0, maxDpr: 1.5, shadow: 2048, bloom: true, tilt: true, fxaa: true, ssao: true, godrays: true, particles: 3000, cars: 500, lodDist: 90, drawDist: 300 },
  ultra: { name: 'Ultra', scale: 1.0, maxDpr: 2, shadow: 4096, bloom: true, tilt: true, fxaa: true, ssao: true, godrays: true, particles: 6000, cars: 900, lodDist: 140, drawDist: 400 },
};

/* ------------------------------------------------------------------ */
/* Default user settings (persisted separately from saves)              */
/* ------------------------------------------------------------------ */
VC.DEFAULT_SETTINGS = {
  quality: 'high',
  autoQuality: true, // dynamic resolution to hold framerate
  dayNight: 'cycle', // 'cycle' | 'day' | 'sunset' | 'night'
  bloom: true,
  tiltShift: true,
  shadows: true,
  ssao: true, // screen-space ambient occlusion (only where the quality preset allows it)
  godRays: true, // sun shafts (only where the quality preset allows it)
  weather: true, // visual only: the simulation keeps its own weather (VC.sim.weather())
  masterVol: 1,
  musicVol: 0.5,
  sfxVol: 0.7,
  ambienceVol: 0.6,
  muted: false,
  edgeScroll: false,
  invertZoom: false,
  showGrid: true,
  autosave: true,
  disasters: true,
  uiScale: 1,
  tutorial: true,
  showFps: false,
  ticker: true,
  minimapOpen: true,
};
