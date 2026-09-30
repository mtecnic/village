/*
 * VOXELPOLIS — NATURE: road vehicles (scale 0.5 -> 1/16-unit voxels).
 *
 * Conventions (shared with the agents renderer): FRONT faces +Z, length along Z, y = 0 is the tyre
 * contact, origin = bottom centre (sx/2, 0, sz/2). Cars are 4 wide (one lane = 0.25 units), buses
 * and trucks 5 wide. HEADLIGHT voxels at the front, TAILLIGHT at the back (both glow at night),
 * cabins GLASS_DARK, bus windows WIN_COOL (randomly lit at night). Emergency light bars use
 * NEON_RED + NEON_BLUE (always emissive); meta.siren = [[x,y,z], ...] marks them for flashing.
 * meta.kind names the body style.
 *
 *   car            24 variants: shape = v % 8 (0 sedan, 1 hatchback, 2 SUV, 3 pickup, 4 sports,
 *                  5 van, 6 beetle, 7 convertible), colour = floor(v / 8) picks from a per-shape
 *                  list of CAR_* paints
 *   taxi           2 (0 yellow sedan with checker band + roof sign, 1 black cab)
 *   bus            4 (0 blue city bus, 1 green city bus, 2 red double-decker, 3 yellow school bus)
 *   truck          4 box trucks (white / red / blue / orange boxes)
 *   tanker         2 (0 chrome fuel tanker, 1 white milk tanker)
 *   police_car     2 (0 sedan, 1 SUV) black & white with light bar
 *   firetruck      1 red ladder truck      ambulance  1      garbage_truck  1 (green)
 */
const P = VC.P;
const K = VC.natureKit;

/* ------------------------------------------------------------------ */
/* Shared parts                                                          */
/* ------------------------------------------------------------------ */
/** Tyres at y=0 on both sides for each axle z (2 voxels long), dark underbody between. */
function wheels(g, sx, axles, sz) {
  g.box(1, 0, 1, sx - 2, 1, sz - 2, P.CONCRETE_DD);
  for (const z of axles) {
    g.box(0, 0, z, 1, 1, 2, P.TIRE);
    g.box(sx - 1, 0, z, 1, 1, 2, P.TIRE);
  }
}
/** Head- and taillights at the outer corners of layer y (front z = sz-1, back z = 0). */
function lamps(g, sx, sz, y, yBack = y) {
  g.set(0, y, sz - 1, P.HEADLIGHT);
  g.set(sx - 1, y, sz - 1, P.HEADLIGHT);
  g.set(0, yBack, 0, P.TAILLIGHT);
  g.set(sx - 1, yBack, 0, P.TAILLIGHT);
}
/** Emergency light bar across the roof at (y, z): red half / blue half. */
function lightBar(g, sx, y, z, x0 = 0) {
  g.meta.siren = g.meta.siren || [];
  for (let x = x0; x < sx - x0; x++) g.set(x, y, z, x < sx / 2 ? P.NEON_RED : P.NEON_BLUE);
  g.meta.siren.push([x0 + 0.5, y + 0.5, z + 0.5], [sx - x0 - 0.5, y + 0.5, z + 0.5]);
}

/* ------------------------------------------------------------------ */
/* Cars                                                                  */
/* ------------------------------------------------------------------ */
const SHAPES = ['sedan', 'hatchback', 'suv', 'pickup', 'sports', 'van', 'beetle', 'convertible'];
const SHAPE_PAINT = () => ({
  sedan: [P.CAR_SILVER, P.CAR_BLUE, P.CAR_RED],
  hatchback: [P.CAR_RED, P.CAR_WHITE, P.CAR_GREEN],
  suv: [P.CAR_BLACK, P.CAR_WHITE, P.NAVY],
  pickup: [P.CAR_RED, P.CAR_SILVER, P.CAR_BLUE],
  sports: [P.CAR_RED, P.CAR_YELLOW, P.ORANGE],
  van: [P.CAR_WHITE, P.CAR_SILVER, P.CAR_BLUE],
  beetle: [P.CAR_GREEN, P.CREAM, P.CAR_BLUE],
  convertible: [P.CAR_BLACK, P.CAR_RED, P.CAR_WHITE],
});

/** Builds a 4-wide car of the given shape and paint into a fresh grid. */
function carBody(shape, c, rng) {
  const G = P.GLASS_DARK;
  const g = new VC.VoxelGrid(4, 6, 8);
  g.meta.kind = shape;
  wheels(g, 4, [1, 5], 8);
  if (shape === 'suv' || shape === 'van') {
    g.box(0, 1, 0, 4, 2, 8, c);
  } else {
    g.box(0, 1, 0, 4, 1, 8, c);
  }
  switch (shape) {
    case 'sedan':
      g.box(0, 2, 0, 4, 1, 2, c); // trunk
      g.box(0, 2, 2, 4, 1, 4, G); // cabin glass
      g.box(0, 2, 6, 4, 1, 2, c); // hood
      g.box(0, 3, 3, 4, 1, 2, c); // roof (glass ends read as sloped screens)
      g.box(0, 2, 4, 1, 1, 1, c); // B-pillars
      g.box(3, 2, 4, 1, 1, 1, c);
      break;
    case 'hatchback':
      g.box(0, 2, 0, 4, 1, 1, c);
      g.box(0, 2, 1, 4, 1, 5, G);
      g.box(0, 2, 6, 4, 1, 2, c);
      g.box(0, 3, 1, 4, 1, 4, c);
      break;
    case 'suv':
      g.box(0, 3, 1, 4, 1, 5, G);
      g.box(0, 3, 0, 4, 1, 1, c);
      g.box(0, 4, 1, 4, 1, 5, c);
      g.box(1, 2, 0, 2, 1, 1, P.TIRE); // spare wheel on the tailgate
      break;
    case 'pickup':
      g.box(0, 2, 4, 4, 1, 2, G); // cab
      g.box(0, 3, 4, 4, 1, 2, c);
      g.box(0, 2, 6, 4, 1, 2, c); // hood
      g.box(0, 2, 0, 1, 1, 4, c); // bed walls + tailgate
      g.box(3, 2, 0, 1, 1, 4, c);
      g.box(1, 2, 0, 2, 1, 1, c);
      if (rng.chance(0.6)) g.box(1, 2, 1, 2, 1, 2, rng.pick([P.WOOD_L, P.CONTAINER_O, P.HAZARD_Y])); // cargo
      break;
    case 'sports':
      g.box(0, 2, 3, 4, 1, 2, G); // bubble canopy
      g.box(0, 2, 2, 4, 1, 1, c);
      g.box(0, 2, 0, 4, 1, 1, c); // rear wing
      g.box(1, 1, 5, 2, 1, 3, c === P.CAR_YELLOW ? P.BLACK : P.WHITE); // racing stripe on the hood
      break;
    case 'van':
      g.box(0, 3, 0, 4, 1, 7, c);
      g.box(0, 3, 6, 4, 1, 1, G); // windscreen
      g.box(0, 3, 1, 1, 1, 4, G); // side glass
      g.box(3, 3, 1, 1, 1, 4, G);
      g.box(0, 4, 0, 4, 1, 7, c);
      g.box(1, 1, 7, 2, 2, 1, c); // short nose
      break;
    case 'beetle':
      g.set(0, 1, 0, 0); // rounded corners
      g.set(3, 1, 0, 0);
      g.set(0, 1, 7, P.TIRE);
      g.set(3, 1, 7, P.TIRE);
      g.box(0, 2, 1, 4, 1, 1, c);
      g.box(0, 2, 2, 4, 1, 4, G);
      g.box(0, 2, 6, 4, 1, 1, c);
      g.box(1, 3, 2, 2, 1, 4, c); // domed roof
      g.box(0, 3, 3, 4, 1, 2, c);
      g.set(0, 1, 7, P.HEADLIGHT);
      g.set(3, 1, 7, P.HEADLIGHT);
      break;
    case 'convertible':
      g.box(0, 2, 0, 4, 1, 2, c); // rear deck
      g.box(0, 2, 2, 1, 1, 3, c); // doors
      g.box(3, 2, 2, 1, 1, 3, c);
      g.box(0, 2, 5, 4, 1, 1, G); // windscreen
      g.box(0, 2, 6, 4, 1, 2, c);
      g.box(1, 2, 2, 2, 1, 1, P.BROWN); // seat backs
      g.box(1, 2, 4, 2, 1, 1, P.BROWN);
      g.set(1, 3, 4, P.PLASTER_PEACH); // driver
      break;
  }
  g.box(1, 1, 7, 2, 1, 1, shape === 'sports' ? P.BLACK : P.METAL_D); // grille
  g.box(1, 1, 0, 2, 1, 1, P.CREAM); // plate
  lamps(g, 4, 8, 1);
  return g;
}

VC.models.define('car', {
  variants: 24,
  scale: 0.5,
  gen(rng, v) {
    const shape = SHAPES[v % 8];
    const paints = SHAPE_PAINT()[shape];
    return K.fit(carBody(shape, paints[Math.floor(v / 8) % paints.length], rng));
  },
});

VC.models.define('taxi', {
  variants: 2,
  scale: 0.5,
  gen(rng, v) {
    if (v % 2) {
      // black cab: tall hatch body with an amber roof sign
      const g = carBody('hatchback', P.CAR_BLACK, rng);
      g.box(1, 4, 2, 2, 1, 1, P.NEON_ORANGE);
      g.meta.kind = 'cab';
      return K.fit(g);
    }
    const g = carBody('sedan', P.CAR_YELLOW, rng);
    for (let z = 2; z < 6; z++) {
      const c = z % 2 ? P.BLACK : P.WHITE; // checker band
      g.set(0, 1, z, c);
      g.set(3, 1, z, c);
    }
    g.box(1, 4, 3, 2, 1, 1, P.SIGN_WHITE); // roof sign
    g.meta.kind = 'taxi';
    return K.fit(g);
  },
});

VC.models.define('police_car', {
  variants: 2,
  scale: 0.5,
  gen(rng, v) {
    const suv = v % 2 === 1;
    const g = carBody(suv ? 'suv' : 'sedan', P.CAR_WHITE, rng);
    // black hood/trunk, white doors
    if (suv) {
      g.box(0, 1, 6, 4, 2, 2, P.CAR_BLACK);
      g.box(0, 1, 0, 4, 1, 1, P.CAR_BLACK);
      lightBar(g, 4, 5, 3);
    } else {
      g.box(0, 1, 6, 4, 2, 2, P.CAR_BLACK);
      g.box(0, 1, 0, 4, 2, 2, P.CAR_BLACK);
      g.box(0, 2, 6, 4, 1, 2, P.CAR_BLACK);
      lightBar(g, 4, 4, 3);
    }
    g.box(1, 1, 0, 2, 1, 1, P.CREAM);
    lamps(g, 4, 8, 1);
    g.box(1, 1, 7, 2, 1, 1, P.METAL_D); // push bar
    g.meta.kind = 'police';
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* Buses                                                                 */
/* ------------------------------------------------------------------ */
VC.models.define('bus', {
  variants: 4,
  scale: 0.5,
  gen(rng, v) {
    const kind = v % 4;
    const L = 22, W = 5;
    if (kind === 2) {
      // red double-decker
      const g = new VC.VoxelGrid(W, 10, L);
      wheels(g, W, [3, 16], L);
      g.box(0, 1, 0, W, 8, L, P.CAR_RED);
      g.box(0, 3, 1, 1, 2, 20, P.WIN_COOL);
      g.box(W - 1, 3, 1, 1, 2, 20, P.WIN_COOL);
      g.box(0, 6, 1, 1, 2, 20, P.WIN_COOL);
      g.box(W - 1, 6, 1, 1, 2, 20, P.WIN_COOL);
      g.box(0, 5, 0, W, 1, L, P.CREAM); // between-decks band
      g.box(0, 1, 17, 1, 4, 2, P.GLASS_DARK); // door (kerb side = -X)
      g.box(0, 3, L - 1, W, 2, 1, P.GLASS_DARK);
      g.box(0, 6, L - 1, W, 2, 1, P.GLASS_DARK);
      g.box(1, 8, L - 1, 3, 1, 1, P.NEON_ORANGE); // destination blind
      g.box(0, 9, 1, W, 1, L - 2, P.CAR_RED); // rounded roof
      g.box(1, 1, L - 1, 3, 1, 1, P.METAL_D);
      lamps(g, W, L, 1, 2);
      g.meta.kind = 'double_decker';
      return K.fit(g);
    }
    if (kind === 3) {
      // yellow school bus with a hood
      const g = new VC.VoxelGrid(W, 7, L);
      wheels(g, W, [3, 17], L);
      g.box(0, 1, 0, W, 5, 18, P.CAR_YELLOW);
      g.box(0, 1, 18, W, 2, 4, P.CAR_YELLOW); // hood
      g.box(1, 1, L - 1, 3, 2, 1, P.METAL_D); // grille
      g.box(0, 3, 17, W, 2, 1, P.GLASS_DARK); // windscreen
      // window band split by a few pillars
      g.box(0, 3, 1, 1, 2, 15, P.WIN_COOL);
      g.box(W - 1, 3, 1, 1, 2, 15, P.WIN_COOL);
      for (const z of [5, 9, 13]) {
        g.box(0, 3, z, 1, 2, 1, P.CAR_YELLOW);
        g.box(W - 1, 3, z, 1, 2, 1, P.CAR_YELLOW);
      }
      g.box(0, 2, 0, 1, 1, 18, P.BLACK); // rub rails
      g.box(W - 1, 2, 0, 1, 1, 18, P.BLACK);
      g.box(0, 1, 15, 1, 4, 2, P.GLASS_DARK); // door
      g.box(0, 6, 1, W, 1, 16, P.CAR_WHITE);
      g.set(1, 5, 17, P.NEON_RED);
      g.set(3, 5, 17, P.NEON_RED);
      g.box(W - 1, 3, 13, 1, 1, 1, P.NEON_RED); // stop arm
      lamps(g, W, L, 1, 2);
      g.meta.kind = 'school_bus';
      return K.fit(g);
    }
    // city bus: livery skirt, long window band, white roof with AC pod
    const liv = kind === 0 ? P.CAR_BLUE : P.GREEN;
    const g = new VC.VoxelGrid(W, 7, L);
    wheels(g, W, [3, 16], L);
    g.box(0, 1, 0, W, 5, L, P.CAR_WHITE);
    g.box(0, 1, 0, W, 2, L, liv);
    g.box(0, 3, 1, 1, 2, L - 2, P.WIN_COOL);
    g.box(W - 1, 3, 1, 1, 2, L - 2, P.WIN_COOL);
    g.box(0, 1, 17, 1, 4, 2, P.GLASS_DARK); // front + middle doors (kerb side)
    g.box(0, 1, 8, 1, 4, 2, P.GLASS_DARK);
    g.box(0, 2, L - 1, W, 3, 1, P.GLASS_DARK); // windscreen
    g.box(1, 5, L - 1, 3, 1, 1, P.NEON_ORANGE); // destination sign
    g.box(1, 6, 7, 3, 1, 6, P.METAL); // AC pod
    g.box(0, 2, 0, W, 1, 1, liv);
    g.box(1, 3, 0, 3, 2, 1, P.GLASS_DARK); // rear window
    lamps(g, W, L, 1, 2);
    g.meta.kind = 'city_bus';
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* Trucks                                                                */
/* ------------------------------------------------------------------ */
/** 5-wide cab at z0..z0+3 (front at z0+3): body colour c, windscreen, lamps. Returns the grid. */
function cab(g, z0, c, h = 4) {
  const W = 5;
  g.box(0, 1, z0, W, h - 1, 4, c);
  g.box(0, h - 1, z0 + 3, W, 1, 1, P.GLASS_DARK);
  g.box(0, h - 1, z0 + 1, 1, 1, 2, P.GLASS_DARK);
  g.box(W - 1, h - 1, z0 + 1, 1, 1, 2, P.GLASS_DARK);
  g.box(0, h, z0, W, 1, 3, c); // roof
  g.box(1, 1, z0 + 3, 3, 1, 1, P.CHROME); // grille
  g.set(0, 1, z0 + 3, P.HEADLIGHT);
  g.set(W - 1, 1, z0 + 3, P.HEADLIGHT);
  return g;
}

VC.models.define('truck', {
  variants: 4,
  scale: 0.5,
  gen(rng, v) {
    const k = v % 4;
    const box = [P.CAR_WHITE, P.CONTAINER_R, P.CONTAINER_B, P.CONTAINER_O][k];
    const cabC = [P.CAR_BLUE, P.CAR_WHITE, P.CAR_RED, P.CAR_BLACK][k];
    const stripe = [P.CAR_RED, P.CAR_WHITE, P.YELLOW, P.CAR_WHITE][k];
    const g = new VC.VoxelGrid(5, 8, 14);
    wheels(g, 5, [1, 11], 14);
    g.box(0, 0, 3, 1, 1, 1, P.TIRE); // tandem rear axle
    g.box(4, 0, 3, 1, 1, 1, P.TIRE);
    cab(g, 10, cabC);
    g.box(0, 1, 0, 5, 1, 10, P.CONCRETE_DD); // chassis rail
    g.box(0, 2, 0, 5, 6, 10, box);
    g.box(0, 7, 0, 5, 1, 10, P.CONCRETE_L); // roof
    g.box(0, 4, 1, 1, 1, 8, stripe); // livery stripe on both sides
    g.box(4, 4, 1, 1, 1, 8, stripe);
    g.box(1, 2, 0, 3, 5, 1, P.METAL_D); // roll-up door
    g.box(1, 3, 0, 3, 1, 1, P.METAL);
    g.set(0, 2, 0, P.TAILLIGHT);
    g.set(4, 2, 0, P.TAILLIGHT);
    g.meta.kind = 'box_truck';
    return K.fit(g);
  },
});

VC.models.define('tanker', {
  variants: 2,
  scale: 0.5,
  gen(rng, v) {
    const milk = v % 2 === 1;
    const g = new VC.VoxelGrid(5, 7, 16);
    wheels(g, 5, [2, 12], 16);
    cab(g, 12, milk ? P.CAR_BLUE : P.ORANGE);
    g.box(1, 1, 0, 3, 1, 12, P.CONCRETE_DD);
    g.hcyl('z', 0, 11, 3.5, 2.5, 2.45, milk ? P.TANK_WHITE : P.CHROME);
    g.box(0, 1, 0, 5, 1, 1, milk ? P.CAR_BLUE : P.CAR_RED); // rear bumper
    g.box(2, 6, 2, 1, 1, 7, P.METAL_D); // catwalk
    g.box(2, 2, 0, 1, 2, 1, milk ? P.CAR_BLUE : P.HAZARD_Y); // placard
    g.set(0, 1, 0, P.TAILLIGHT);
    g.set(4, 1, 0, P.TAILLIGHT);
    g.meta.kind = milk ? 'milk_tanker' : 'fuel_tanker';
    return K.fit(g);
  },
});

VC.models.define('garbage_truck', {
  variants: 1,
  scale: 0.5,
  gen() {
    const g = new VC.VoxelGrid(5, 8, 14);
    wheels(g, 5, [1, 11], 14);
    g.box(0, 0, 3, 1, 1, 1, P.TIRE);
    g.box(4, 0, 3, 1, 1, 1, P.TIRE);
    cab(g, 10, P.CAR_WHITE);
    g.box(0, 1, 1, 5, 5, 9, P.GREEN);
    g.box(0, 6, 2, 5, 1, 7, P.CAR_GREEN); // curved roof
    g.box(0, 3, 1, 1, 1, 9, P.CAR_WHITE); // side stripe
    g.box(4, 3, 1, 1, 1, 9, P.CAR_WHITE);
    // rear hopper with hazard chevrons
    g.box(0, 1, 0, 5, 4, 1, P.METAL_D);
    g.box(1, 2, 0, 3, 2, 1, P.CONCRETE_DD);
    for (let x = 0; x < 5; x++) g.set(x, 1, 0, x % 2 ? P.HAZARD_B : P.HAZARD_Y);
    g.set(0, 4, 0, P.TAILLIGHT);
    g.set(4, 4, 0, P.TAILLIGHT);
    g.set(2, 5, 12, P.NEON_ORANGE); // beacon
    g.meta.siren = [[2.5, 5.5, 12.5]];
    g.meta.kind = 'garbage';
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* Emergency                                                             */
/* ------------------------------------------------------------------ */
VC.models.define('firetruck', {
  variants: 1,
  scale: 0.5,
  gen() {
    const L = 16;
    const g = new VC.VoxelGrid(5, 8, L);
    wheels(g, 5, [2, 12], L);
    g.box(0, 0, 4, 1, 1, 1, P.TIRE);
    g.box(4, 0, 4, 1, 1, 1, P.TIRE);
    cab(g, 12, P.CAR_RED, 4);
    g.box(0, 1, 0, 5, 4, 12, P.CAR_RED);
    g.box(0, 2, 0, 1, 1, 12, P.WHITE); // white stripe
    g.box(4, 2, 0, 1, 1, 12, P.WHITE);
    g.box(0, 3, 3, 1, 1, 6, P.METAL_D); // equipment lockers
    g.box(4, 3, 3, 1, 1, 6, P.METAL_D);
    // ladder: chrome rails with rungs painted over a dark bed (solid strip meshes far cheaper
    // than open rungs), lying on the roof
    g.box(1, 5, 0, 1, 1, 12, P.CHROME);
    g.box(3, 5, 0, 1, 1, 12, P.CHROME);
    g.box(2, 5, 0, 1, 1, 12, P.METAL_D);
    for (let z = 1; z < 12; z += 3) g.set(2, 5, z, P.CHROME);
    g.box(0, 1, 0, 5, 1, 1, P.METAL_D); // rear step
    g.set(0, 3, 0, P.TAILLIGHT);
    g.set(4, 3, 0, P.TAILLIGHT);
    lightBar(g, 5, 5, 13, 0);
    g.meta.kind = 'firetruck';
    return K.fit(g);
  },
});

VC.models.define('ambulance', {
  variants: 1,
  scale: 0.5,
  gen() {
    const L = 11;
    const g = new VC.VoxelGrid(5, 7, L);
    wheels(g, 5, [1, 8], L);
    cab(g, 7, P.CAR_WHITE, 3);
    g.box(0, 1, 0, 5, 5, 8, P.CAR_WHITE);
    g.box(0, 2, 0, 1, 1, 11, P.RED); // stripe
    g.box(4, 2, 0, 1, 1, 11, P.RED);
    // red crosses on both sides and the back
    for (const x of [0, 4]) {
      g.box(x, 3, 4, 1, 3, 1, P.RED);
      g.box(x, 4, 3, 1, 1, 3, P.RED);
    }
    g.box(2, 3, 0, 1, 2, 1, P.RED);
    g.box(1, 4, 0, 3, 1, 1, P.RED);
    g.set(1, 5, 0, P.GLASS_DARK);
    g.set(3, 5, 0, P.GLASS_DARK);
    g.set(0, 2, 0, P.TAILLIGHT);
    g.set(4, 2, 0, P.TAILLIGHT);
    lightBar(g, 5, 6, 7, 0);
    g.meta.kind = 'ambulance';
    return K.fit(g);
  },
});
