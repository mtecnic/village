/*
 * VOXELPOLIS — civic models: SAFETY & HEALTH.
 * police_station, police_hq, fire_station, fire_hq, clinic, hospital.
 * Buildings stand on a 1-voxel lot plate (y = 0), so walls start at y = 1.
 * Helpers: VC.civicKit (models/civic.js). Front/entrance faces +Z.
 */
const P = VC.P, K = VC.civicKit;

/** Open garage bay in the +Z face (surface plane zf): dark interior, rolled-up door lip, vehicle inside. */
function bay(g, x, w, h, zf, depth, veh, arg = 0) {
  g.box(x, 1, zf - depth + 1, w, h, depth, 0);
  g.box(x, 1, zf - depth, w, h, 1, P.CONCRETE_DD);
  g.box(x, 0, zf - depth + 1, w, 1, depth, P.CONCRETE_D);
  g.box(x, h, zf, w, 1, 1, P.METAL);
  g.box(x, h - 1, zf - 1, w, 1, 1, P.METAL_D);
  if (veh) K.vehicle(g, veh, x + ((w - 3) >> 1), 1, zf - 6, 0, arg);
}
/** Landing pad on a roof: square, painted ring, letter, corner lights. */
function helipad(g, x, y, z, w, d, letter, ringC = P.HAZARD_Y, letterC = P.WHITE) {
  const cx = x + w / 2, cz = z + d / 2;
  g.box(x, y, z, w, 1, d, P.CONCRETE_D);
  K.ring(g, cx, y, cz, Math.min(w, d) / 2 - 1.6, Math.min(w, d) / 2 - 0.6, 1, ringC);
  K.text(g, letter, cx, y, cz, letterC, 'top');
  for (const [lx, lz] of [[x, z], [x + w - 1, z], [x, z + d - 1], [x + w - 1, z + d - 1]]) {
    g.set(lx, y + 1, lz, P.NEON_GREEN);
    g.light(lx + 0.5, y + 1.5, lz + 0.5, K.LC.green, 0.5);
  }
}

/* ------------------------------------------------------------------ */
/* police_station (2x2)                                                 */
/* ------------------------------------------------------------------ */
VC.models.define('police_station', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(2, 2, 32);
    K.lot(g, P.SIDEWALK);
    // patrol car parking
    g.box(0, 0, 3, 6, 1, 13, P.ASPHALT);
    g.box(3, 0, 7, 1, 1, 6, P.ROAD_MARK);
    K.vehicle(g, 'police', 1, 1, 8, 0);
    K.vehicle(g, 'police', 4, 1, 8, 0);
    if (v) K.vehicle(g, 'police', 1, 1, 3, 2);
    // station building
    const wall = v ? P.BRICK : P.PLASTER;
    K.block(g, 7, 1, 1, 8, 10, 10, {
      wall, win: P.WIN, floorH: 3, winH: 2, gap: 1, faces: 'swe',
      base: P.NAVY, bands: [[9, v ? P.WHITE : P.BLUE]], roof: P.ROOF_GREY, parapet: v ? 0 : P.NAVY,
    });
    if (v) g.roofHip(6, 11, 0, 10, 12, P.ROOF_SLATE);
    K.door(g, 's', 10, 1, 10, 2, 3, P.GLASS_BLUE);
    g.box(9, 4, 11, 4, 1, 2, P.NAVY);
    g.set(10, 5, 12, P.NEON_BLUE);
    g.light(10.5, 5.6, 12.5, K.LC.blue, 0.8);
    K.text(g, '*', 11, 5, 11, P.GOLD);
    // radio mast with beacon
    const mx = v ? 1 : 13, mz = v ? 14 : 2, my = v ? 1 : 11;
    g.box(mx, my, mz, 1, v ? 20 : 12, 1, P.METAL_D);
    g.box(mx - 1, my + (v ? 14 : 8), mz, 3, 1, 1, P.METAL);
    K.beacon(g, mx, my + (v ? 20 : 12), mz);
    if (!v) K.roofJunk(g, 7, 11, 1, 8, 10, rng, 2, 'a');
    // forecourt
    K.flag(g, 7, 1, 14, 9, [P.BLUE, P.WHITE]);
    g.box(12, 1, 13, 3, 1, 2, P.HEDGE);
    K.flowers(g, 12, 2, 13, 3, 2, [P.FLOWER_Y, P.FLOWER_W]);
    K.lamp(g, 15, 1, 15, 4);
    K.tree(g, 15, 1, 12, 'bush', 0.8);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* police_hq (3x3)                                                      */
/* ------------------------------------------------------------------ */
VC.models.define('police_hq', {
  variants: 1,
  gen(rng) {
    const g = K.grid(3, 3, 48);
    K.lot(g, P.SIDEWALK);
    K.block(g, 1, 1, 2, 22, 15, 11, {
      wall: P.CONCRETE_L, win: P.WIN_OFFICE, floorH: 3, winW: 2, winH: 2, gap: 1,
      base: P.NAVY, baseH: 2, bands: [[14, P.NAVY]], roof: P.CONCRETE, parapet: P.NAVY,
    });
    // vertical blue fins on the facade
    for (const x of [1, 6, 17, 22]) g.box(x, 1, 13, 1, 15, 1, P.NAVY);
    // glass atrium entrance
    g.box(9, 1, 12, 6, 6, 3, P.GLASS_BLUE);
    g.box(8, 7, 12, 8, 1, 4, P.NAVY);
    for (const x of [9, 14]) g.box(x, 1, 15, 1, 6, 1, P.CHROME);
    K.door(g, 's', 11, 1, 14, 2, 3, P.GLASS_DARK);
    // rooftop sign, helipad, parked helicopter, antenna mast
    for (const x of [2, 11, 20]) g.box(x, 16, 11, 1, 5, 1, P.METAL_D);
    K.text(g, 'POLICE', 11.5, 16, 12, P.NEON_BLUE);
    helipad(g, 2, 16, 3, 9, 8, 'H');
    K.vehicle(g, 'heli', 12, 16, 1, 0, P.NAVY, P.WHITE);
    g.box(20, 16, 3, 2, 18, 2, P.METAL_D);
    for (let y = 20; y < 34; y += 4) g.box(20, y, 3, 2, 1, 2, P.METAL);
    K.beacon(g, 20, 34, 3);
    K.beacon(g, 21, 26, 4, 0.6);
    // forecourt: flags, parking, garden
    for (const [fx, c] of [[12, P.NAVY], [16, P.BLUE], [20, P.RED]]) K.flag(g, fx, 1, 16, 11, [c, P.WHITE]);
    g.box(0, 0, 18, 10, 1, 6, P.ASPHALT);
    for (const x of [3, 6]) g.box(x, 0, 18, 1, 1, 3, P.ROAD_MARK);
    K.vehicle(g, 'police', 1, 1, 18, 0);
    K.vehicle(g, 'police', 4, 1, 18, 0);
    K.vehicle(g, 'truck', 7, 1, 18, 0, P.CAR_BLACK, P.CAR_BLACK);
    g.box(11, 0, 19, 13, 1, 5, P.GRASS);
    g.box(11, 1, 19, 13, 1, 1, P.HEDGE);
    K.tree(g, 14, 1, 21, 'oak', 1);
    K.tree(g, 20, 1, 21, 'oak', 1.1);
    K.bench(g, 16, 1, 21, 'x', 2);
    K.lamp(g, 10, 1, 17, 5);
    K.lamp(g, 23, 1, 17, 5);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* fire_station (2x2)                                                   */
/* ------------------------------------------------------------------ */
VC.models.define('fire_station', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(2, 2, 32);
    K.lot(g, P.CONCRETE_L);
    const wall = v ? P.CONCRETE_L : P.BRICK;
    K.block(g, 1, 1, 1, 14, 12, 10, {
      wall, win: P.WIN, floorH: 4, winH: 2, y0: 7, faces: 'we',
      roof: P.ROOF_GREY, parapet: v ? P.RED : P.BRICK_D, bands: v ? [[5, P.RED], [11, P.RED]] : [[5, P.WHITE], [11, P.BRICK_D]],
    });
    if (v) {
      for (const x of [3, 7, 11]) bay(g, x, 3, 5, 10, 7, 'firetruck', x === 7 ? 1 : 0);
    } else {
      bay(g, 2, 5, 5, 10, 7, 'firetruck', 0);
      bay(g, 9, 5, 5, 10, 7, 'firetruck', 1);
    }
    K.text(g, 'FIRE', 8, 7, 11, v ? P.RED : P.GOLD);
    for (const x of v ? [4, 8, 12] : [4, 11]) g.set(x, 6, 11, P.TAILLIGHT);
    // hose drying tower
    const tw = v ? P.CONCRETE : P.BRICK;
    g.box(1, 1, 1, 4, 20, 4, tw);
    K.windows(g, 1, 1, 1, 4, 20, 4, { win: P.WIN, floorH: 4, winH: 2, y0: 12, faces: 'se' });
    g.box(1, 18, 1, 4, 1, 4, v ? P.RED : P.WHITE);
    K.spire(g, 0, 21, 0, 6, 6, v ? P.RED : P.ROOF_SLATE, 1);
    g.set(2, 24, 2, P.GOLD);
    // siren + apron
    g.box(8, 13, 4, 2, 1, 1, P.METAL_D);
    g.set(8, 14, 4, P.NEON_RED);
    K.hazard(g, 2, 0, 14, 12, 1, 1, P.RED, P.WHITE);
    g.set(15, 1, 12, P.RED); g.set(15, 2, 12, P.CHROME);
    K.flag(g, 0, 1, 14, 8, [P.RED, P.WHITE]);
    K.bench(g, 13, 1, 13, 'x', 2);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* fire_hq (3x3)                                                        */
/* ------------------------------------------------------------------ */
VC.models.define('fire_hq', {
  variants: 1,
  gen(rng) {
    const g = K.grid(3, 3, 48);
    K.lot(g, P.CONCRETE_L);
    K.block(g, 1, 1, 1, 22, 14, 11, {
      wall: P.BRICK, win: P.WIN, floorH: 3, winH: 2, y0: 7, faces: 'we',
      roof: P.ROOF_GREY, parapet: P.BRICK_D, bands: [[6, P.WHITE], [13, P.WHITE]],
    });
    K.windows(g, 1, 1, 1, 22, 14, 11, { win: P.WIN, floorH: 3, winH: 2, y0: 7, faces: 'n' });
    // drill tower with zig-zag fire escape
    g.box(17, 1, 1, 5, 30, 4, P.STONE);
    K.windows(g, 17, 1, 1, 5, 30, 4, { win: P.WIN, floorH: 3, winH: 2, y0: 15, faces: 'swe' });
    g.box(17, 28, 1, 5, 2, 4, P.RED);
    K.parapet(g, 17, 31, 1, 5, 4, P.STONE_D);
    for (let y = 15; y < 29; y += 3) {
      const up = ((y - 15) / 3) & 1;
      K.beam(g, 22, y, up ? 4 : 1, 22, y + 3, up ? 1 : 4, P.METAL_D);
    }
    K.beacon(g, 19, 31, 2);
    K.flag(g, 21, 31, 4, 5, [P.RED, P.WHITE]);
    for (const [i, x] of [3, 8, 13, 18].entries()) bay(g, x, 3, 6, 11, 7, 'firetruck', i & 1);
    K.text(g, 'FIRE', 12, 8, 12, P.GOLD);
    for (const x of [4, 9, 14, 19]) g.set(x, 7, 12, P.TAILLIGHT);
    // apron: tower-ladder truck leaning on the facade, ambulance, memorial bell
    K.hazard(g, 1, 0, 13, 22, 1, 1, P.RED, P.WHITE);
    K.vehicle(g, 'firetruck', 2, 1, 15, 0, 1);
    K.beam(g, 3, 4, 16, 3, 14, 12, P.CHROME);
    K.beam(g, 4, 4, 16, 4, 14, 12, P.METAL);
    K.vehicle(g, 'ambulance', 20, 1, 15, 0);
    g.box(11, 1, 20, 3, 2, 3, P.STONE_D);
    g.sphere(12.5, 4, 21.5, 1.3, P.GOLD);
    K.lamp(g, 9, 1, 21, 5);
    K.lamp(g, 16, 1, 21, 5);
    g.set(23, 1, 13, P.RED); g.set(23, 2, 13, P.CHROME);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* clinic (2x2)                                                         */
/* ------------------------------------------------------------------ */
VC.models.define('clinic', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(2, 2, 24);
    K.lot(g, P.GRASS);
    g.box(0, 0, 11, 11, 1, 5, P.SIDEWALK);
    g.box(11, 0, 0, 5, 1, 16, P.ASPHALT);
    const wall = v ? P.PLASTER_MINT : P.WHITE;
    K.block(g, 1, 1, 1, 10, 8, 9, {
      wall, win: P.WIN_COOL, floorH: 4, winW: 2, winH: 2, gap: 1,
      base: P.ROOF_TEAL, bands: [[3, P.ROOF_TEAL]], roof: P.CONCRETE_L, parapet: v ? P.WHITE : P.PLASTER_MINT,
    });
    K.door(g, 's', 4, 1, 9, 3, 3, P.GLASS_BLUE);
    g.box(3, 4, 10, 5, 1, 2, P.WHITE);
    g.box(3, 1, 11, 1, 3, 1, P.CHROME); g.box(7, 1, 11, 1, 3, 1, P.CHROME);
    // green cross sign on the roof edge
    g.box(3, 9, 9, 5, 5, 1, P.WHITE);
    K.cross(g, 's', 5, 11, 10, 2, 1, P.NEON_GREEN);
    g.light(5.5, 11.5, 10.8, K.LC.green, 1.2);
    K.roofJunk(g, 1, 9, 1, 10, 7, rng, 2, v ? 'as' : 'a');
    // ambulance bay with canopy
    g.box(11, 5, 1, 5, 1, 10, P.WHITE);
    g.box(11, 5, 10, 5, 1, 1, P.RED);
    g.box(15, 1, 2, 1, 4, 1, P.CHROME); g.box(15, 1, 9, 1, 4, 1, P.CHROME);
    K.vehicle(g, 'ambulance', 12, 1, 4, 0);
    g.box(11, 0, 13, 5, 1, 1, P.ROAD_MARK);
    // garden
    K.tree(g, 1, 1, 13, 'oak', 0.9);
    K.tree(g, 9, 1, 13, 'birch', 0.8);
    K.bench(g, 4, 1, 13, 'x', 3);
    K.flowers(g, 1, 1, 10, 2, 1, [P.FLOWER_W]);
    K.flowers(g, 8, 1, 10, 3, 1, [P.FLOWER_R]);
    K.lamp(g, 10, 1, 15, 4);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* hospital (3x3)                                                       */
/* ------------------------------------------------------------------ */
VC.models.define('hospital', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(3, 3, 48);
    K.lot(g, P.SIDEWALK);
    g.box(0, 0, 21, 9, 1, 3, P.GRASS);
    g.box(15, 0, 20, 9, 1, 4, P.ASPHALT);
    g.box(15, 0, 20, 1, 1, 4, P.ROAD_MARK);
    const accent = v ? P.ROOF_BLUE : P.ROOF_TEAL;
    // wings
    for (const wx of [1, 17]) {
      K.block(g, wx, 1, 5, 6, 13, 15, { wall: P.WHITE, win: P.WIN_COOL, floorH: 3, winW: 1, winH: 2, gap: 1, base: accent, roof: P.CONCRETE_L, parapet: accent });
    }
    // main tower with teal core stripe
    K.block(g, 6, 1, 3, 12, 28, 11, { wall: P.WHITE, win: P.WIN_COOL, floorH: 3, winW: 2, winH: 2, gap: 1, bands: [[26, accent], [27, accent]], roof: P.CONCRETE, parapet: accent });
    g.box(12, 1, 13, 1, 26, 1, v ? P.GLASS_BLUE : P.GLASS_TEAL);
    // big red cross (glows)
    g.box(9, 19, 14, 7, 7, 1, P.WHITE);
    K.cross(g, 's', 12, 22, 15, 3, 3, P.NEON_RED);
    g.light(12.5, 22.5, 15.8, K.LC.red, 1.8);
    // rooftop helipad + beacon
    helipad(g, 7, 29, 4, 10, 9, 'H', P.WHITE, P.RED);
    K.beacon(g, 17, 30, 3);
    // roof garden on the left wing, machinery on the right
    g.box(2, 14, 6, 4, 1, 13, P.GRASS);
    K.tree(g, 3, 15, 8, 'oak', 0.8);
    K.tree(g, 3, 15, 15, 'oak', 0.8);
    K.tree(g, 4, 15, 12, 'bush', 0.7);
    K.roofJunk(g, 17, 14, 5, 6, 15, rng, 3, 'av');
    // glass lobby + canopy
    g.box(7, 1, 14, 10, 6, 5, v ? P.GLASS_BLUE : P.GLASS_TEAL);
    g.box(7, 6, 14, 10, 1, 5, P.WHITE);
    g.box(8, 6, 19, 8, 1, 2, P.WHITE);
    g.box(8, 1, 20, 1, 5, 1, P.CHROME); g.box(15, 1, 20, 1, 5, 1, P.CHROME);
    K.door(g, 's', 11, 1, 18, 2, 3, P.GLASS_DARK);
    // emergency entrance on the right wing
    K.door(g, 's', 18, 1, 19, 4, 3, P.GLASS_DARK);
    K.text(g, 'ER', 19.5, 7, 20, P.NEON_RED);
    K.vehicle(g, 'ambulance', 17, 1, 21, 1);
    K.tree(g, 1, 1, 22, 'oak', 1);
    K.tree(g, 5, 1, 22, 'oak', 0.9);
    K.bench(g, 2, 1, 20, 'x', 2);
    K.lamp(g, 8, 1, 22, 5);
    K.lamp(g, 15, 1, 22, 5);
    return K.fit(g);
  },
});
