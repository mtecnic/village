/*
 * VOXELPOLIS — NATURE: aircraft, boats and special / disaster models.
 *
 * All models are centred on their grid (origin = bottom centre (sx/2, 0, sz/2)) and face +Z.
 *
 *   plane              scale .5, 47x17x52 airliner, 4 liveries. Wings span the full grid width.
 *                      meta.nav = {red:[x,y,z] (+X / port tip), green:[x,y,z] (-X / starboard)},
 *                      meta.engines = exhaust points, meta.wingY = wing height (voxels).
 *   helicopter         scale .5, 7x11x20, variants 0 police, 1 medical, 2 news, 3 tour. Parts:
 *                      'helicopter_rotor' (main, spins about Y) and 'helicopter_tail_rotor' (about X).
 *   boat               scale .5, variants: 0 sailboat (white sail), 1 sailboat (striped sail),
 *                      2 speedboat, 3 ferry, 4 cargo ship. Also as separate keys: 'sailboat' (2),
 *                      'speedboat' (2), 'ferry', 'cargo_ship'. meta.draft = voxels below the
 *                      waterline, meta.kind = 'sail' | 'speed' | 'ferry' | 'cargo', meta.mast (sail).
 *   ufo                scale 1, 25x12x25 saucer; 12 always-on rim lights (g.light) alternating green /
 *                      cyan; meta.beam = tractor beam origin (bottom centre).
 *   rocket             scale 1 fallback, defined only when no other file defined 'rocket';
 *                      meta.nozzle = engine exhaust point.
 *   monster            scale 1, CUBEZILLA ~48 tall: variants 0..3 = walk-cycle poses (0 left foot
 *                      forward, 1 passing / right foot lifted, 2 right foot forward, 3 passing / left
 *                      lifted); identical grid size for every pose. meta.eyes = glowing eye points,
 *                      meta.mouth = breath origin, meta.feet = [[x,y,z] left, right] (stomp dust).
 *   meteor             scale 1, 13x13x13 jagged rock with glowing FIRE seams, 3 variants.
 *   bird               scale .25 (the fx flocks expect ~1/32-unit voxels), 11x5x7, variants 0 wings up,
 *                      1 glide, 2 wings down. Mostly WHITE so fx can tint species.
 *   balloon            scale 1, 15x25x15 hot-air balloon, 4 envelopes; burner g.light (always on),
 *                      meta.burner = flame point.
 */
const P = VC.P;
const K = VC.natureKit;
const M = VC.M;
const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ */
/* Airliner                                                              */
/* ------------------------------------------------------------------ */
const LIVERY = () => [
  { tail: P.BLUE, line: P.BLUE, logo: P.WHITE, belly: P.CAR_SILVER },
  { tail: P.RED, line: P.RED, logo: P.WHITE, belly: P.CAR_SILVER },
  { tail: P.ORANGE, line: P.ORANGE, logo: P.WHITE, belly: P.ORANGE },
  { tail: P.NAVY, line: P.GOLD, logo: P.GOLD, belly: P.NAVY },
];
VC.models.define('plane', {
  variants: 4,
  scale: 0.5,
  gen(rng, v) {
    const L = LIVERY()[v % 4];
    const W = 47, H = 17, LEN = 52;
    const g = new VC.VoxelGrid(W, H, LEN);
    const cx = 23.5, cy = 6.5;
    // fuselage cross-section: 7 wide x 7 tall octagon; colour depends only on (x, y) so every
    // side stripe is one long quad
    const skin = (a, y, x) => (y === 7 && (x === 20 || x === 26) ? P.WIN : y === 6 && (x === 20 || x === 26) ? L.line : y <= 4 ? L.belly : P.WHITE);
    g.hcyl('z', 5, 41, cy, cx, 3.3, skin);
    // nose with cockpit glazing, drooping slightly
    [[3.1, 6.4], [2.8, 6.3], [2.4, 6.1], [1.9, 5.9], [1.3, 5.7], [0.8, 5.6]].forEach(([r, y], k) =>
      g.hcyl('z', 46 + k, 1, y, cx, r, (a, yy) => (yy >= 7 && k < 3 ? P.GLASS_DARK : yy <= 4 ? L.belly : P.WHITE)));
    // upswept tail cone
    [[1.1, 8.6], [1.7, 8.1], [2.3, 7.5], [2.8, 7], [3.1, 6.7]].forEach(([r, y], k) => g.hcyl('z', k, 1, y, cx, r, P.WHITE));
    // swept, tapered low wings with winglets
    for (let k = 0; k <= 19; k++) {
      const zf = 31 - Math.round(k * 0.55), zb = 22 - Math.round(k * 0.3);
      g.box(19 - k, 4, zb, 1, 1, zf - zb + 1, P.CAR_SILVER);
      g.box(27 + k, 4, zb, 1, 1, zf - zb + 1, P.CAR_SILVER);
    }
    g.box(0, 5, 16, 1, 2, 2, L.tail);
    g.box(W - 1, 5, 16, 1, 2, 2, L.tail);
    // nav lights: port (+X) red, starboard (-X) green
    g.set(W - 1, 4, 18, P.TAILLIGHT);
    g.set(0, 4, 18, K.col('NAV_GREEN'));
    g.light(W - 0.5, 4.5, 18.5, [1, 0.1, 0.08], 0.5, true);
    g.light(0.5, 4.5, 18.5, [0.1, 1, 0.3], 0.5, true);
    g.meta.nav = { red: [W - 0.5, 4.5, 18.5], green: [0.5, 4.5, 18.5] };
    g.meta.wingY = 4.5;
    // engines under the wings: nacelle, chrome intake lip, dark fan and exhaust
    g.meta.engines = [];
    for (const ex of [cx - 8, cx + 8]) {
      g.hcyl('z', 20, 8, 2.6, ex, 1.75, P.METAL_D);
      g.hcyl('z', 27, 1, 2.6, ex, 1.75, P.CHROME);
      g.set(Math.floor(ex), 2, 27, P.CONCRETE_DD);
      g.set(Math.floor(ex), 2, 20, P.CONCRETE_DD);
      g.box(Math.floor(ex), 4, 22, 1, 1, 4, P.CAR_SILVER); // pylon
      g.meta.engines.push([ex, 2.6, 20]);
    }
    // horizontal stabilisers
    for (let k = 0; k <= 8; k++) {
      const zf = 7 - Math.round(k * 0.35), zb = 1 + Math.round(k * 0.45);
      g.box(19 - k, 8, zb, 1, 1, Math.max(1, zf - zb + 1), P.CAR_SILVER);
      g.box(27 + k, 8, zb, 1, 1, Math.max(1, zf - zb + 1), P.CAR_SILVER);
    }
    // swept fin in the livery colour with a logo
    for (let y = 9; y < H; y++) {
      const z0 = Math.round((y - 9) * 0.8), z1 = 9 - Math.round((y - 9) * 0.3);
      g.box(23, y, z0, 1, 1, z1 - z0 + 1, L.tail);
    }
    g.box(23, 12, 5, 1, 2, 2, L.logo);
    // anti-collision beacon on the crown, white strobe on the tail cone
    g.set(23, 10, 24, P.BEACON_RED);
    g.set(23, 8, 0, P.HEADLIGHT);
    return g;
  },
});

/* ------------------------------------------------------------------ */
/* Helicopter + rotors                                                   */
/* ------------------------------------------------------------------ */
VC.models.define('helicopter_rotor', {
  scale: 0.5,
  gen() {
    const g = new VC.VoxelGrid(27, 1, 27);
    g.box(0, 0, 13, 27, 1, 1, P.METAL_D);
    g.box(13, 0, 0, 1, 1, 27, P.METAL_D);
    g.box(12, 0, 12, 3, 1, 3, P.CONCRETE_DD);
    for (const [x, z] of [[0, 13], [26, 13], [13, 0], [13, 26]]) g.set(x, 0, z, P.HAZARD_Y); // tip markings
    return g;
  },
});
VC.models.define('helicopter_tail_rotor', {
  scale: 0.5,
  gen() {
    const g = new VC.VoxelGrid(1, 7, 7);
    g.box(0, 0, 3, 1, 7, 1, P.METAL_D);
    g.box(0, 3, 0, 1, 1, 7, P.METAL_D);
    return g;
  },
});
const HELI = () => [
  { body: P.NAVY, trim: P.CAR_WHITE },
  { body: P.CAR_WHITE, trim: P.RED },
  { body: P.ORANGE, trim: P.CAR_WHITE },
  { body: P.CAR_BLUE, trim: P.CAR_YELLOW },
];
VC.models.define('helicopter', {
  variants: 4,
  scale: 0.5,
  parts: [
    { model: 'helicopter_rotor', pivot: [3.5, 9, 12.5], partPivot: [13.5, 0, 13.5], axis: 'y', speed: 28 },
    { model: 'helicopter_tail_rotor', pivot: [4, 7.5, 1.5], partPivot: [0, 3.5, 3.5], axis: 'x', speed: 42 },
  ],
  gen(rng, v) {
    const k = v % 4, C = HELI()[k];
    const g = new VC.VoxelGrid(7, 11, 20);
    // cabin pod with wrap-around glazing and a trim line
    g.ellipsoid(3.5, 4.2, 12.5, 3.3, 3, 5.6, (x, y, z) =>
      (z >= 15 && y >= 4) || (y >= 4 && y <= 5 && z >= 10 && z <= 13 && (x === 0 || x === 6)) ? P.GLASS_DARK : y === 3 ? C.trim : C.body);
    g.box(2, 7, 8, 3, 1, 6, C.body); // engine cowling
    g.box(2, 7, 8, 3, 1, 1, P.METAL_D); // exhaust
    // tail boom, fin, stabiliser
    g.box(3, 5, 0, 1, 2, 9, C.body);
    g.box(3, 7, 0, 1, 3, 2, C.trim);
    g.box(1, 5, 2, 5, 1, 1, C.trim);
    g.set(3, 10, 0, P.BEACON_RED);
    g.light(3.5, 10.5, 0.5, [1, 0.12, 0.1], 0.5, true);
    // rotor mast
    g.box(3, 8, 12, 1, 1, 1, P.METAL_D);
    // landing skids
    g.box(1, 0, 8, 1, 1, 10, P.METAL_D);
    g.box(5, 0, 8, 1, 1, 10, P.METAL_D);
    for (const x of [1, 5]) {
      g.set(x, 1, 10, P.METAL_D);
      g.set(x, 1, 15, P.METAL_D);
      g.set(x, 1, 18, P.METAL_D);
    }
    g.set(3, 1, 17, P.HEADLIGHT); // searchlight
    if (k === 0) {
      g.set(2, 7, 14, P.NEON_RED);
      g.set(4, 7, 14, P.NEON_BLUE);
      g.meta.siren = [[2.5, 7.5, 14.5], [4.5, 7.5, 14.5]];
    } else if (k === 1) {
      // red crosses on the doors
      for (const x of [0, 6]) {
        if (!g.get(x, 4, 9)) continue;
        g.box(x, 3, 9, 1, 3, 1, P.RED);
        g.box(x, 4, 8, 1, 1, 3, P.RED);
      }
    } else if (k === 2) {
      g.box(3, 1, 13, 1, 1, 2, P.METAL_D); // camera pod
      g.set(3, 1, 15, P.GLASS_DARK);
    }
    g.meta.kind = ['police', 'medical', 'news', 'tour'][k];
    return g;
  },
});

/* ------------------------------------------------------------------ */
/* Boats                                                                 */
/* ------------------------------------------------------------------ */
/**
 * Hull of width W (odd) and length L: bow taper over `bow` voxels, stern slightly rounded.
 * rows: colours bottom -> top (length = hull height); deck: top-layer interior colour.
 */
function hull(g, W, L, bow, rows, deck) {
  const H = rows.length;
  for (let z = 0; z < L; z++) {
    const t = z > L - 1 - bow ? (z - (L - 1 - bow)) / bow : 0;
    let w = Math.max(1, Math.round(W * (1 - Math.pow(t, 1.4)) / 2) * 2 + 1);
    if (w > W) w = W;
    if (z === 0) w = Math.max(1, W - 2);
    const x0 = (W - w) >> 1;
    for (let y = 0; y < H; y++) {
      // hull narrows a little toward the keel
      const inset = y === 0 && w > 3 ? 1 : 0;
      g.box(x0 + inset, y, z, w - inset * 2, 1, 1, rows[y]);
    }
    if (deck && w > 2 && z > 0 && z < L - 1) g.box(x0 + 1, H - 1, z, w - 2, 1, 1, deck);
  }
}

function sailboat(rng, striped) {
  const g = new VC.VoxelGrid(7, 22, 15);
  hull(g, 7, 15, 5, [P.RED, P.CAR_WHITE, P.CAR_WHITE], P.WOOD_L);
  g.box(0, 1, 2, 1, 1, 9, P.NAVY); // boot stripe
  g.box(6, 1, 2, 1, 1, 9, P.NAVY);
  g.box(2, 3, 3, 3, 1, 5, P.CAR_WHITE); // cabin
  g.set(2, 3, 5, P.GLASS_DARK);
  g.set(4, 3, 5, P.GLASS_DARK);
  g.box(3, 3, 9, 1, 18, 1, P.CHROME); // mast
  g.box(3, 4, 3, 1, 1, 6, P.WOOD_D); // boom
  // mainsail (behind the mast) and jib (ahead of it)
  const sail = (y) => (striped ? (y >> 1) % 2 ? P.AWNING_R : P.WHITE : P.WHITE);
  for (let y = 5; y < 20; y++) {
    const len = Math.round((20 - y) * 0.42) + 1;
    g.box(3, y, 9 - len, 1, 1, len, sail(y));
  }
  for (let y = 4; y < 16; y++) {
    const len = Math.round((16 - y) * 0.32);
    if (len > 0) g.box(3, y, 10, 1, 1, len, P.CREAM);
  }
  g.set(3, 21, 9, P.BEACON_RED);
  g.meta = { draft: 1, kind: 'sail', mast: [3.5, 21.5, 9.5] };
  return g;
}

function speedboat(rng, v) {
  const g = new VC.VoxelGrid(5, 4, 11);
  const stripe = v % 2 ? P.CAR_RED : P.CAR_BLUE;
  hull(g, 5, 11, 5, [P.NAVY, P.CAR_WHITE], P.WOOD_L);
  g.box(0, 1, 1, 1, 1, 6, stripe);
  g.box(4, 1, 1, 1, 1, 6, stripe);
  g.box(1, 2, 6, 3, 1, 1, P.GLASS_CYAN); // windscreen
  g.box(1, 2, 3, 3, 1, 1, P.BROWN); // bench seat
  g.box(2, 1, 0, 1, 2, 1, P.BLACK); // outboard
  g.set(2, 3, 0, P.BLACK);
  g.meta = { draft: 1, kind: 'speed' };
  return g;
}

function ferry(rng) {
  const g = new VC.VoxelGrid(11, 14, 32);
  hull(g, 11, 32, 7, [P.RED, P.NAVY, P.CAR_WHITE, P.CAR_WHITE], P.CONCRETE_L);
  // car deck at the stern with a few parked cars
  g.box(1, 4, 1, 9, 1, 4, P.CONCRETE_D);
  for (const [x, z, c] of [[2, 1, P.CAR_RED], [5, 2, P.CAR_BLUE], [8, 1, P.CAR_SILVER]]) g.box(x, 4, z, 1, 1, 2, c);
  // passenger decks with window bands
  g.box(1, 4, 5, 9, 3, 20, P.WHITE);
  g.box(1, 5, 6, 1, 1, 18, P.WIN);
  g.box(9, 5, 6, 1, 1, 18, P.WIN);
  g.box(2, 7, 9, 7, 2, 14, P.WHITE);
  g.box(2, 8, 10, 1, 1, 12, P.WIN);
  g.box(8, 8, 10, 1, 1, 12, P.WIN);
  // bridge with wrap-around glass
  g.box(3, 9, 18, 5, 2, 4, P.WHITE);
  g.box(3, 10, 21, 5, 1, 1, P.GLASS_DARK);
  // lifeboats
  for (const z of [11, 16]) {
    g.box(1, 7, z, 1, 1, 2, P.ORANGE);
    g.box(9, 7, z, 1, 1, 2, P.ORANGE);
  }
  // funnel
  g.box(4, 9, 11, 3, 3, 3, P.CAR_BLUE);
  g.box(4, 12, 11, 3, 1, 3, P.BLACK);
  g.emit(5.5, 13, 12.5, 'smoke', 0.5);
  g.set(5, 11, 19, P.BEACON_RED);
  g.meta = { draft: 2, kind: 'ferry' };
  return g;
}

function cargoShip(rng) {
  const g = new VC.VoxelGrid(13, 18, 60);
  const hullC = rng.pick([P.NAVY, P.CONCRETE_DD, P.GREEN]);
  hull(g, 13, 60, 9, [P.RED, P.RED, hullC, hullC, hullC], P.CONCRETE_D);
  // container stacks (3 wide x 2 tall x 5 long), stack heights vary
  const cols = [P.CONTAINER_R, P.CONTAINER_B, P.CONTAINER_G, P.CONTAINER_O, P.CAR_WHITE];
  for (let z = 10; z < 48; z += 6)
    for (let x = 0; x < 4; x++) {
      const n = rng.int(1, 3);
      for (let k = 0; k < n; k++) g.box(1 + x * 3 - (x > 1 ? 0 : 0), 5 + k * 2, z, 3, 2, 5, rng.pick(cols));
    }
  // stern superstructure: accommodation block, bridge, funnel
  g.box(2, 5, 1, 9, 7, 7, P.WHITE);
  for (let y = 6; y < 11; y += 2) g.box(2, y, 7, 9, 1, 1, P.WIN);
  g.box(1, 12, 3, 11, 1, 5, P.WHITE);
  g.box(1, 12, 7, 11, 1, 1, P.GLASS_DARK);
  g.box(5, 13, 1, 3, 3, 3, P.CAR_RED);
  g.box(5, 16, 1, 3, 1, 3, P.BLACK);
  g.emit(6.5, 17, 2.5, 'smoke', 0.6);
  g.set(6, 13, 5, P.BEACON_RED);
  // foremast
  g.box(6, 5, 52, 1, 5, 1, P.METAL);
  g.set(6, 10, 52, P.LAMP_WHITE);
  g.meta = { draft: 3, kind: 'cargo' };
  return g;
}

VC.models.define('boat', {
  variants: 5,
  scale: 0.5,
  gen(rng, v) {
    const k = v % 5;
    return k === 0 ? sailboat(rng, false) : k === 1 ? sailboat(rng, true) : k === 2 ? speedboat(rng, 0) : k === 3 ? ferry(rng) : cargoShip(rng);
  },
});
VC.models.define('sailboat', { variants: 2, scale: 0.5, gen: (rng, v) => sailboat(rng, v % 2 === 1) });
VC.models.define('speedboat', { variants: 2, scale: 0.5, gen: (rng, v) => speedboat(rng, v) });
VC.models.define('ferry', { variants: 1, scale: 0.5, gen: (rng) => ferry(rng) });
VC.models.define('cargo_ship', { variants: 2, scale: 0.5, gen: (rng) => cargoShip(rng) });

/* ------------------------------------------------------------------ */
/* UFO                                                                   */
/* ------------------------------------------------------------------ */
VC.models.define('ufo', {
  variants: 1,
  scale: 1,
  gen() {
    const g = new VC.VoxelGrid(25, 12, 25);
    const c = 12.5;
    g.cyl(c, 0, c, 2.6, 1, P.GLOW_REACTOR); // beam emitter
    K.ring(g, c, 0, c, 2.6, 4.6, 1, P.METAL_D);
    g.cyl(c, 1, c, 8, 1, P.METAL_D);
    g.cyl(c, 2, c, 11, 1, P.CHROME);
    g.cyl(c, 3, c, 12.4, 1, P.CHROME);
    g.cyl(c, 4, c, 11, 1, P.METAL);
    g.cyl(c, 5, c, 8.4, 1, P.METAL);
    g.cyl(c, 6, c, 6.2, 1, P.CHROME);
    // glass dome with a tiny green pilot silhouette showing at the crown
    g.ellipsoid(c, 6.5, c, 5, 4.6, 5, (x, y) => (y >= 10 ? P.NEON_GREEN : P.GLASS_CYAN));
    // rim lights: 12 alternating green / cyan
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU;
      const x = c + Math.cos(a) * 11.9, z = c + Math.sin(a) * 11.9;
      g.set(Math.floor(x), 3, Math.floor(z), k % 2 ? P.NEON_CYAN : P.NEON_GREEN);
      g.light(x, 3.5, z, k % 2 ? [0.2, 0.95, 1] : [0.3, 1, 0.4], 0.7, true);
    }
    g.meta.beam = [c, 0, c];
    return g;
  },
});

/* ------------------------------------------------------------------ */
/* Rocket (fallback only)                                                */
/* ------------------------------------------------------------------ */
if (!VC.models.has('rocket'))
  VC.models.define('rocket', {
    variants: 1,
    scale: 1,
    gen() {
      const g = new VC.VoxelGrid(13, 52, 13);
      const c = 6.5;
      g.cyl(c, 0, c, 1.8, 3, P.METAL_D); // engine bell
      for (let y = 3; y < 40; y++) g.cyl(c, y, c, 2.8, 1, y === 16 || y === 30 ? P.BLACK : P.WHITE);
      for (let y = 40; y < 49; y++) g.cyl(c, y, c, Math.max(0.6, 2.8 - (y - 40) * 0.3), 1, y > 45 ? P.RED : P.WHITE);
      g.set(6, 34, 3, P.GLASS_DARK);
      g.set(6, 34, 9, P.GLASS_DARK);
      // side boosters and fins
      for (const bx of [c - 4.3, c + 4.3]) {
        g.cyl(bx, 1, c, 1.6, 22, P.WHITE);
        g.cyl(bx, 23, c, 1, 2, P.RED);
        g.cyl(bx, 0, c, 1, 1, P.METAL_D);
      }
      for (let y = 3; y < 10; y++) {
        const w = Math.max(1, Math.round((10 - y) * 0.45));
        g.box(6, y, 9, 1, 1, w, P.RED);
        g.box(6, y, 4 - w, 1, 1, w, P.RED);
      }
      g.meta.nozzle = [c, 0, c];
      return K.fit(g);
    },
  });

/* ------------------------------------------------------------------ */
/* CUBEZILLA                                                             */
/* ------------------------------------------------------------------ */
VC.models.define('monster', {
  variants: 4,
  scale: 1,
  gen(rng, v) {
    const W = 31, H = 52, D = 46, cx = 15.5;
    const g = new VC.VoxelGrid(W, H, D);
    const SKIN = P.GRASS_D, LIGHT = P.GRASS, DARK = K.col('KAIJU_D'), BELLY = P.GRASS_L, CLAW = P.CREAM;
    const ph = (v % 4) * (Math.PI / 2);
    const stride = Math.cos(ph); // +1 left foot forward, -1 right foot forward
    const liftL = Math.round(Math.max(0, -Math.sin(ph)) * 4), liftR = Math.round(Math.max(0, Math.sin(ph)) * 4);
    const bob = v % 2; // body rises on passing poses
    // skin with dark bands across the back and a banded belly
    const skin = (x, y, z) => {
      const front = z > 27 - (y - 20) * 0.12 && Math.abs(x + 0.5 - cx) < 5.5;
      if (front && y > 12 && y < 36) return y % 3 === 0 ? LIGHT : BELLY;
      const back = z < 20 && y > 22;
      if (back && Math.floor((y + z) / 4) % 2 === 0) return DARK;
      return Math.abs(x + 0.5 - cx) > 7 && y > 16 ? LIGHT : SKIN;
    };
    // ---- legs + feet ----
    const feet = [];
    for (const s of [-1, 1]) {
      const zo = Math.round(stride * 4 * (s < 0 ? 1 : -1)), lift = s < 0 ? liftL : liftR;
      const fx = cx + s * 6;
      K.beam(g, Math.round(fx - 2), 14 + bob, 19, Math.round(fx - 2), 5 + lift, 20 + zo, SKIN, 5); // thigh -> ankle
      g.ellipsoid(fx, 15 + bob, 20, 5, 5.5, 5.5, skin);
      g.box(Math.round(fx - 3.5), lift, 17 + zo, 7, 3, 10, SKIN); // foot
      g.box(Math.round(fx - 3.5), lift + 2, 17 + zo, 7, 1, 10, DARK);
      for (const cxo of [-3, 0, 3]) g.box(Math.round(fx - 0.5 + cxo), lift, 27 + zo, 1, 2, 1, CLAW); // toe claws
      feet.push([fx, lift, 22 + zo]);
    }
    // ---- tail: thick base tapering to the ground, swaying side to side ----
    for (let k = 0; k <= 16; k++) {
      const t = k / 16;
      const sway = Math.sin(ph) * 4 * Math.pow(t, 1.4);
      g.sphere(cx + sway, 17 + bob - 13 * t + Math.sin(t * Math.PI) * 2, 15 - 14 * t, 5.6 - 4.4 * t, t > 0.55 ? DARK : SKIN);
    }
    // ---- torso: pear-shaped, leaning forward ----
    g.ellipsoid(cx, 22 + bob, 21, 9, 11, 8.2, skin);
    g.ellipsoid(cx, 31 + bob, 24, 7.2, 7, 6.8, skin);
    // ---- stubby arms swinging against the legs ----
    for (const s of [-1, 1]) {
      const za = Math.round(-stride * 2 * (s < 0 ? 1 : -1));
      const ax = Math.round(cx + s * 8.5 - 1);
      K.beam(g, ax, 32 + bob, 26, ax + s, 26 + bob, 31 + za, SKIN, 3);
      for (const dz of [0, 2]) g.box(ax + s + 1, 25 + bob, 31 + za + dz, 1, 1, 1, CLAW);
    }
    // ---- neck + blocky head with jaw, teeth, glowing eyes ----
    const hy = 40 + bob;
    g.ellipsoid(cx, hy - 4, 28, 5, 5, 5, skin);
    g.box(Math.round(cx - 5), hy - 3, 29, 10, 7, 11, SKIN); // skull
    g.box(Math.round(cx - 4), hy - 2, 40, 8, 4, 4, SKIN); // snout
    g.box(Math.round(cx - 4), hy - 4, 31, 8, 2, 11, LIGHT); // lower jaw
    g.box(Math.round(cx - 4), hy - 2, 32, 8, 1, 12, P.RED); // open mouth line
    g.box(Math.round(cx - 3), hy - 2, 43, 6, 1, 1, P.RED);
    for (let z = 34; z < 44; z += 2) {
      g.set(Math.round(cx - 4), hy - 1, z, P.WHITE); // upper teeth
      g.set(Math.round(cx + 3), hy - 1, z, P.WHITE);
    }
    g.box(Math.round(cx - 5), hy + 3, 36, 10, 1, 3, DARK); // brow ridge
    // glowing eyes set in dark sockets so they pop against the green hide by day too
    g.box(Math.round(cx - 5), hy, 37, 3, 3, 3, P.BLACK);
    g.box(Math.round(cx + 2), hy, 37, 3, 3, 3, P.BLACK);
    g.box(Math.round(cx - 5), hy + 1, 38, 2, 2, 2, P.NEON_GREEN);
    g.box(Math.round(cx + 3), hy + 1, 38, 2, 2, 2, P.NEON_GREEN);
    g.set(Math.round(cx - 2), hy + 1, 43, P.BLACK); // nostrils
    g.set(Math.round(cx + 1), hy + 1, 43, P.BLACK);
    g.meta.eyes = [[cx - 4.5, hy + 2, 39.5], [cx + 4.5, hy + 2, 39.5]];
    g.meta.mouth = [cx, hy - 1.5, 44];
    g.meta.feet = feet;
    // ---- dorsal plates along the spine, big at the shoulders ----
    const spine = [[40, 29, 3], [38, 25, 5], [35, 21, 7], [32, 17, 7], [28, 14, 6], [24, 11, 5], [20, 8, 4], [16, 5, 3], [12, 3, 2]];
    for (const [yy, zz, h] of spine) {
      const tz = zz;
      let y0 = H - 1;
      while (y0 > 0 && !g.get(15, y0, tz)) y0--;
      for (let d = 0; d < h; d++) {
        const half = Math.max(0, Math.round((h - d) * 0.5) - 1);
        g.box(15, y0 + 1 + d, tz - half, 2, 1, half * 2 + 1, d === h - 1 ? P.NEON_GREEN : DARK);
      }
    }
    return g;
  },
});

/* ------------------------------------------------------------------ */
/* Meteor                                                                */
/* ------------------------------------------------------------------ */
VC.models.define('meteor', {
  variants: 3,
  scale: 1,
  gen(rng) {
    const g = new VC.VoxelGrid(13, 13, 13);
    const c = 6.5;
    // jagged, charred body: overlapping boulders in three dark rock tones
    const tones = [P.STONE_D, P.CONCRETE_DD, P.ROCK];
    g.ellipsoid(c, c, c, 4.6, 4.2, 4.8, P.CONCRETE_DD);
    for (let k = 0; k < 7; k++) {
      const a = rng() * TAU, b = rng.range(-1, 1), d = rng.range(2.5, 3.6);
      const x = c + Math.cos(a) * d * Math.sqrt(1 - b * b), y = c + b * d, z = c + Math.sin(a) * d * Math.sqrt(1 - b * b);
      if (rng.chance(0.5)) g.ellipsoid(x, y, z, rng.range(1.6, 2.6), rng.range(1.4, 2.2), rng.range(1.6, 2.6), tones[k % 3]);
      else g.box(Math.round(x - 1.5), Math.round(y - 1.5), Math.round(z - 1.5), rng.int(2, 3), rng.int(2, 3), rng.int(2, 3), tones[k % 3]);
    }
    // glowing seams: only surface voxels along a few chords get the FIRE colour
    for (let k = 0; k < 5; k++) {
      const p0 = [rng.int(1, 11), rng.int(1, 11), rng.int(1, 11)], p1 = [rng.int(1, 11), rng.int(1, 11), rng.int(1, 11)];
      const n = 16;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        let x = Math.round(p0[0] + (p1[0] - p0[0]) * t), y = Math.round(p0[1] + (p1[1] - p0[1]) * t), z = Math.round(p0[2] + (p1[2] - p0[2]) * t);
        // project outward to the surface along the direction from the centre
        const dx = x - c, dy = y - c, dz = z - c, l = Math.hypot(dx, dy, dz) || 1;
        for (let s = 0; s < 8; s++) {
          const px = Math.round(x + (dx / l) * s), py = Math.round(y + (dy / l) * s), pz = Math.round(z + (dz / l) * s);
          if (g.get(px, py, pz) && !g.get(Math.round(px + dx / l), Math.round(py + dy / l), Math.round(pz + dz / l))) {
            g.set(px, py, pz, P.FIRE);
            break;
          }
        }
      }
    }
    g.light(c, c, c, [1, 0.5, 0.15], 1.6, true);
    return g;
  },
});

/* ------------------------------------------------------------------ */
/* Bird                                                                  */
/* ------------------------------------------------------------------ */
VC.models.define('bird', {
  variants: 3,
  scale: 0.25,
  gen(rng, v) {
    const g = new VC.VoxelGrid(11, 5, 7);
    const Wc = P.WHITE, TIP = P.BLACK;
    g.box(5, 2, 1, 1, 1, 5, Wc); // body
    g.set(5, 3, 5, Wc); // head
    g.set(5, 3, 6, P.ORANGE); // beak
    g.box(4, 2, 0, 3, 1, 1, P.GREY); // tail fan
    // wing heights from the body outward: 0 up, 1 glide, 2 down
    const hw = [[3, 3, 4, 4, 4], [2, 2, 2, 2, 2], [2, 1, 1, 0, 0]][v % 3];
    for (let k = 0; k < 5; k++) {
      const c = k === 4 ? TIP : Wc, d = k < 2 ? 2 : 1;
      g.box(4 - k, hw[k], 2, 1, 1, d, c);
      g.box(6 + k, hw[k], 2, 1, 1, d, c);
    }
    return g;
  },
});

/* ------------------------------------------------------------------ */
/* Hot-air balloon                                                       */
/* ------------------------------------------------------------------ */
VC.models.define('balloon', {
  variants: 4,
  scale: 1,
  gen(rng, v) {
    const g = new VC.VoxelGrid(15, 25, 15);
    const c = 7.5;
    const k = v % 4;
    const RAINBOW = [P.RED, P.ORANGE, P.YELLOW, P.GREEN, P.BLUE, P.PURPLE];
    const pair = [[P.RED, P.YELLOW], [P.BLUE, P.WHITE], [P.PURPLE, P.ORANGE], null][k];
    const gore = (x, y, z) => {
      const a = Math.atan2(z + 0.5 - c, x + 0.5 - c);
      const s = Math.floor(((a + Math.PI) / TAU) * 12) % 12;
      if (!pair) return RAINBOW[s % 6];
      if (y >= 15 && y <= 16) return pair[1]; // belt
      return pair[s % 2];
    };
    // envelope: round crown on a tapering cone down to the throat
    g.ellipsoid(c, 17, c, 7, 7.4, 7, gore);
    for (let y = 8; y < 13; y++) g.cyl(c, y, c, 2 + (y - 8) * 1.05, 1, gore);
    g.cyl(c, 8, c, 2, 1, P.BROWN); // throat skirt
    // rigging, burner and wicker basket
    for (const [x, z] of [[6, 6], [8, 6], [6, 8], [8, 8]]) g.box(x, 4, z, 1, 4, 1, P.WOOD_D);
    g.box(7, 5, 7, 1, 1, 1, P.METAL_D);
    g.set(7, 6, 7, P.FIRE);
    g.box(6, 0, 6, 3, 3, 3, P.WOOD);
    g.box(6, 3, 6, 3, 1, 3, P.WOOD_D);
    g.box(7, 3, 7, 1, 1, 1, 0);
    g.light(c, 6.5, c, [1, 0.55, 0.2], 1.2, true);
    g.meta.burner = [c, 6.5, c];
    return g;
  },
});
