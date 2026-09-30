/*
 * VOXELPOLIS — deterministic, fun names for buildings and the city.
 *
 *   VC.sim.buildingName(b)  -> "The Hendersons' Cottage", "Sunset Apartments", "Cubey's Diner",
 *                              "Big Block Steel", "Riverside Fire Station", …  (stable per b.id/variant;
 *                              the category follows zone, density, wealth and level)
 *   VC.sim.cityTitle()      -> "Town of Voxelpolis" (milestone name by peak population)
 *   VC.sim.zoneLabel(b)     -> "Medium Density Residential" (growables) / catalog group label
 *   VC.sim.districtName(x,z)-> neighbourhood name for a tile (used for news & service names)
 *
 * Loaded before sim.js (alphabetical), so it only attaches functions to VC.sim.
 */
const SIM = (VC.sim = VC.sim || {});
const M = VC.M;

const FAMILY = ['Henderson', 'Nakamura', 'Okafor', 'Petrov', 'Garcia', 'Lindqvist', 'Moreau', 'Kowalski', 'Brennan', 'Castillo',
  'Nguyen', 'Fischer', 'Haddad', 'Sorensen', 'Abernathy', 'Pemberton', 'Blockley', 'Cubington', 'Voxley', 'Rossi', 'Tanaka',
  'Mbeki', "O'Malley", 'Dubois', 'Jensen', 'Patel', 'Silva', 'Novak', 'Kim', 'Squarewell', 'Hughes', 'Larsen', 'Moretti',
  'Oyelaran', 'Whitaker', 'Yamada', 'Becker', 'Quill', 'Fairweather', 'Pixelton'];
const TREE = ['Maple', 'Oak', 'Birch', 'Willow', 'Cedar', 'Elm', 'Aspen', 'Juniper', 'Magnolia', 'Rowan', 'Hazel', 'Linden',
  'Chestnut', 'Poplar', 'Holly', 'Laurel', 'Cypress', 'Alder', 'Sycamore', 'Hawthorn'];
const FLOWER = ['Rose', 'Daisy', 'Lavender', 'Tulip', 'Poppy', 'Iris', 'Violet', 'Lilac', 'Clover', 'Heather', 'Marigold', 'Primrose'];
const SCENIC = ['Sunset', 'Riverside', 'Hillcrest', 'Lakeview', 'Parkside', 'Meadow', 'Harbor', 'Sunrise', 'Brookside', 'Summit',
  'Bayview', 'Greenway', 'Starlight', 'Silverleaf', 'Evergreen', 'Cobblestone', 'Northgate', 'Southbank', 'Westwind', 'Eastfield',
  'Crystal Springs', 'Foxglove', 'Kingsbridge', 'Moonrise', 'Old Mill', 'Stonebridge', 'Willowbrook', 'Harmony', 'Pinewood', 'Goldcrest'];
const LUX = ['Aurora', 'Regency', 'Solstice', 'Opal', 'Sapphire', 'Monarch', 'Zenith', 'Celestia', 'Paramount', 'Belvedere', 'Obsidian', 'Platinum'];
const OWNER = ['Cubey', 'Blocky', 'Pixel', 'Voxie', 'Bitsy', 'Gridley', 'Tetra', 'Stacy', 'Chunky', 'Squarey', 'Boxworth', 'Mo', 'Lulu', 'Big Sal', 'Uncle Tetris'];
const SHOP = ['Diner', 'Bakery', 'Barber Shop', 'Books', 'Deli', 'Hardware', 'Café', 'Laundromat', 'Pharmacy', 'Florist', 'Taco Stand',
  'Noodle Bar', 'Arcade', 'Pet Shop', 'Ice Cream', 'Pizzeria', 'Bike Shop', 'Record Store', 'Tailor', 'Donut Hole', 'Corner Store'];
const SHOP_FIXED = ['Voxel Mart', 'Pixel Pizza', 'Quik-Cube', 'The Square Meal', '8-Bit Burgers', 'Cube Cola Kiosk', 'Block Party Supplies',
  'The Greedy Voxel', 'Hip To Be Square', 'Brick & Mortar Coffee', 'The Cubic Zirconia', 'Right Angle Optics'];
const CORP = ['Cubix', 'Voxelcorp', 'Quadra', 'Hexa Holdings', 'Polycube', 'Megablock', 'Isometrix', 'Gridline', 'Monolith', 'Tessera',
  'Orthogon', 'Parallax', 'Keystone', 'Vertex', 'Octant'];
const IND_LOW = ['Acme Widget Works', 'Big Block Steel', 'Cubic Chemicals', 'Grindstone Metals', 'Square Peg Manufacturing',
  'Rustbelt Canning Co.', 'Boxworks Packaging', 'Anvil & Sons Foundry', 'Chunky Concrete', 'Gearhead Motors', 'Sawdust Lumber Mill',
  'Crate Expectations Logistics', 'Sprocket & Cog', 'Blocktown Brewery', 'Iron Cube Forge', 'Plastiblox Moulding'];
const IND_MID = ['Precision Parts', 'Assembly Works', 'Textiles', 'Printing Press', 'Food Processing', 'Logistics Hub', 'Glassworks',
  'Electronics Assembly', 'Furniture Co.', 'Paper Mill'];
const IND_HI = ['VoxelSoft Labs', 'Quantum Circuits', 'Photon Dynamics', 'NeuroCube AI', 'Helix Biotech', 'Fusion Micro',
  'Nanoblock Fabrication', 'Qubit Foundry', 'Stellar Robotics', 'Hologrid Systems', 'Aether Aerospace', 'Lumen Optics'];

const pick = (arr, h) => arr[h % arr.length];
/** English possessive plural of a family name: Henderson -> "Hendersons'". */
const plural = (n) => (/(s|x|z|ch|sh)$/.test(n) ? n + "es'" : n + "s'");

function nameGrow(b, h) {
  const h1 = h >>> 7, h2 = h >>> 13, h3 = h >>> 19;
  const w = b.wealth | 0, den = b.den | 0, lvl = b.level | 0;
  if (b.zt === 1) {
    if (den <= 1) {
      if (w === 0) return pick([
        () => `The ${plural(pick(FAMILY, h1))} ${pick(['Cottage', 'Bungalow', 'Cabin', 'Little House'], h2)}`,
        () => `${pick(FLOWER, h1)} Cottage`,
        () => `${pick(TREE, h1)} Bungalow`,
      ], h)();
      if (w === 1) return pick([
        () => `The ${pick(FAMILY, h1)} Residence`,
        () => `${pick(TREE, h1)} Villa`,
        () => `${pick(TREE, h1)} House`,
        () => `The ${plural(pick(FAMILY, h1))} Place`,
      ], h)();
      return pick([
        () => `${pick(SCENIC, h1)} Manor`,
        () => `The ${pick(FAMILY, h1)} Estate`,
        () => `Villa ${pick(LUX, h1)}`,
        () => `${pick(TREE, h1)} Hall`,
      ], h)();
    }
    if (den === 2) {
      const kind = w === 0 ? pick(['Flats', 'Walk-ups', 'Row Houses', 'Tenements'], h2) : w === 1 ? pick(['Apartments', 'Court', 'Townhomes', 'Terrace'], h2) : pick(['Lofts', 'Residences', 'Mansions', 'Brownstones'], h2);
      return pick([() => `${pick(SCENIC, h1)} ${kind}`, () => `${pick(TREE, h1)}wood ${kind}`, () => `${pick(FLOWER, h1)} ${kind}`], h)();
    }
    if (w === 0) return `${pick(SCENIC, h1)} ${pick(['Housing Block', 'Tower Block', 'Estates', 'Heights'], h2)}`;
    if (w === 1) return pick([() => `${pick(SCENIC, h1)} Tower`, () => 'Skyline Residences', () => `${pick(LUX, h1)} Heights`], h3 % 5 === 0 ? 1 : h)();
    return pick([() => `The ${pick(LUX, h1)}`, () => `${pick(LUX, h1)} Luxury Residences`, () => `One ${pick(SCENIC, h1)} Park`, () => 'The Pinnacle'], h)();
  }
  if (b.zt === 2) {
    if (den <= 1) {
      if (h3 % 4 === 0) return pick(SHOP_FIXED, h1);
      return `${pick(OWNER, h1)}'s ${pick(SHOP, h2)}`;
    }
    if (den === 2) return pick([
      () => `${pick(SCENIC, h1)} Shopping Arcade`,
      () => `${pick(FAMILY, h1)} & Sons Department Store`,
      () => `${pick(TREE, h1)} Plaza`,
      () => 'Main Street Market',
      () => `Cornerstone ${pick(['Offices', 'Galleria', 'Emporium'], h2)}`,
      () => 'Voxel Mart Supercenter',
    ], h)();
    if (lvl >= 3 || w === 2) return pick([() => `${pick(CORP, h1)} Tower`, () => `${pick(CORP, h1)} World HQ`, () => 'Blocktower Plaza', () => `One ${pick(SCENIC, h1)} Place`], h)();
    return pick([() => `${pick(SCENIC, h1)} Trade Center`, () => `${pick(CORP, h1)} Building`, () => `${pick(LUX, h1)} Business Park`], h)();
  }
  // industry: high-tech when well educated (wealth 2) or fully upgraded
  if (w === 2 || lvl >= 3) return h3 % 3 === 0 ? `${pick(CORP, h1)} Robotics` : pick(IND_HI, h1);
  if (w === 1) return `${pick(FAMILY, h1)} ${pick(IND_MID, h2)}`;
  return h3 % 3 === 0 ? `${pick(FAMILY, h1)} Brothers ${pick(['Foundry', 'Factory', 'Scrapyard', 'Mill'], h2)}` : pick(IND_LOW, h1);
}

const DISTRICT_NAMED = { safety: 1, education: 1, transit: 1, power: 1, water: 1, waste: 1 };

Object.assign(SIM, {
  /** Neighbourhood name for a tile: stable 12x12-tile districts. */
  districtName(x, z) {
    const S = VC.state;
    const h = M.hashU((x / 12) | 0, (z / 12) | 0, (S ? S.seed : 0) + 4242);
    return SCENIC[h % SCENIC.length];
  },

  buildingName(b) {
    if (!b) return '';
    const h = M.hashU(b.id | 0, b.variant | 0, 9173);
    if (b.key === 'grow') return nameGrow(b, h);
    if (b.key === 'rubble') return b.simCause === 'fire' ? 'Charred Ruins' : 'Rubble';
    const def = VC.BLD[b.key];
    if (!def) return String(b.key);
    if (def.unique) return b.key === 'city_hall' && VC.state ? VC.state.name + ' City Hall' : def.name;
    switch (b.key) {
      case 'small_park': return `${pick(TREE, h >>> 5)} Park`;
      case 'playground': return `${pick(FLOWER, h >>> 5)} Playground`;
      case 'plaza': return `${pick(SCENIC, h >>> 5)} Plaza`;
      case 'sports_field': return `${pick(FAMILY, h >>> 5)} Field`;
      case 'statue': return `Statue of Mayor ${pick(FAMILY, h >>> 5)}`;
      case 'school': return `${pick(TREE, h >>> 5)} Elementary School`;
      case 'high_school': return `${SIM.districtName(b.x, b.z)} High School`;
      default:
        if (DISTRICT_NAMED[def.group]) return `${SIM.districtName(b.x, b.z)} ${def.name}`;
        return def.name;
    }
  },

  /** Short description of what kind of building this is. */
  zoneLabel(b) {
    if (!b) return '';
    if (b.key === 'grow') return `${VC.DENSITY[b.den] || ''} Density ${(VC.ZONES[b.zt] || {}).name || ''}`;
    if (b.key === 'rubble') return 'Debris';
    const def = VC.BLD[b.key];
    const g = def && VC.TOOL_GROUPS.find((t) => t.key === def.group);
    return g ? g.name : '';
  },

  /** "Town of Voxelpolis" — milestone title by peak population. */
  cityTitle() {
    const S = VC.state;
    if (!S) return VC.NAME;
    let m = VC.MILESTONES[0];
    for (const x of VC.MILESTONES) if (S.peakPop >= x.pop) m = x;
    return `${m.name} of ${S.name}`;
  },
});
