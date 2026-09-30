/*
 * VOXELPOLIS — civic models: EDUCATION.
 * school, high_school, library, university, science_center.
 * Buildings stand on a 1-voxel lot plate (y = 0), walls start at y = 1.
 * Helpers: VC.civicKit (models/civic.js). Front/entrance faces +Z.
 */
const P = VC.P, K = VC.civicKit;

/** Small playground set: slide tower + swings + merry-go-round within [x, x+4] x [z, z+8]. */
function playSet(g, x, z) {
  g.box(x, 0, z, 5, 1, 9, P.TRACK_RED);
  // slide
  g.box(x + 1, 1, z + 1, 1, 3, 1, P.WOOD); g.box(x + 2, 1, z + 1, 1, 3, 1, P.WOOD);
  g.box(x + 1, 4, z + 1, 2, 1, 2, P.YELLOW);
  g.box(x + 1, 5, z + 1, 2, 1, 1, P.RED);
  g.box(x + 1, 3, z + 3, 2, 1, 1, P.BLUE); g.box(x + 1, 2, z + 4, 2, 1, 1, P.BLUE); g.box(x + 1, 1, z + 5, 2, 1, 1, P.BLUE);
  // swings
  g.box(x + 4, 1, z + 2, 1, 4, 1, P.RED); g.box(x + 4, 1, z + 7, 1, 4, 1, P.RED);
  g.box(x + 4, 5, z + 2, 1, 1, 6, P.RED);
  for (const sz of [z + 4, z + 6]) { g.box(x + 4, 3, sz, 1, 2, 1, P.METAL); g.set(x + 4, 2, sz, P.BLACK); }
  // merry-go-round
  g.cyl(x + 1.5, 1, z + 7.5, 1.5, 1, P.GREEN);
  g.set(x + 1, 2, z + 7, P.YELLOW);
}
/** Picket fence along X at z (gap = [a, b] left open). */
function picket(g, x0, x1, z, gap, c = P.WHITE) {
  for (let x = x0; x <= x1; x++) {
    if (gap && x >= gap[0] && x <= gap[1]) continue;
    g.box(x, 1, z, 1, x & 1 ? 1 : 2, 1, c);
  }
}

/* ------------------------------------------------------------------ */
/* school (2x2)                                                         */
/* ------------------------------------------------------------------ */
VC.models.define('school', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(2, 2, 24);
    K.lot(g, P.GRASS);
    g.box(4, 0, 9, 3, 1, 7, P.SIDEWALK);
    g.box(0, 0, 11, 10, 1, 3, P.ASPHALT);
    const wall = v ? P.PLASTER_CREAM : P.BRICK, roof = v ? P.ROOF_TERRA : P.ROOF_SLATE;
    K.block(g, 1, 1, 1, 9, 7, 8, { wall, win: P.WIN, floorH: 3, winH: 2, gap: 1, base: P.CONCRETE_L, sill: P.WHITE, faces: 'swe' });
    g.roofGable(0, 8, 0, 11, 10, roof, 'x', 0, wall);
    // porch with a little pediment
    K.door(g, 's', 5, 1, 8, 1, 3, P.WOOD_D);
    g.box(4, 1, 9, 1, 4, 1, P.WHITE); g.box(6, 1, 9, 1, 4, 1, P.WHITE);
    K.pediment(g, 3, 5, 9, 5, P.WHITE, 1, 1);
    // bell tower with clock
    g.box(4, 11, 3, 3, 5, 3, P.WHITE);
    K.clock(g, 's', 5, 13, 6, 1.5);
    g.box(5, 15, 3, 1, 1, 3, 0); g.box(4, 15, 4, 3, 1, 1, 0);
    g.set(5, 15, 4, P.GOLD);
    K.spire(g, 3, 16, 2, 5, 5, v ? P.ROOF_BLUE : P.ROOF_RED, 1);
    g.set(5, 19, 4, P.GOLD);
    // playground, school bus, fence, flag, trees
    playSet(g, 11, 1);
    K.vehicle(g, 'bus', 1, 1, 11, 1, P.CAR_YELLOW, P.CAR_YELLOW);
    g.box(1, 1, 11, 1, 1, 2, P.BLACK);
    picket(g, 0, 15, 15, [4, 6]);
    K.flag(g, 8, 1, 14, 8, [P.BLUE, P.YELLOW]);
    K.tree(g, 13, 1, 12, 'oak', 1);
    K.tree(g, 0, 1, 9, 'bush', 0.7);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* high_school (3x3)                                                    */
/* ------------------------------------------------------------------ */
VC.models.define('high_school', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(3, 3, 32);
    K.lot(g, P.GRASS);
    const wall = v ? P.BRICK_Y : P.BRICK_L;
    // L-shaped main building
    K.block(g, 1, 1, 1, 16, 11, 8, { wall, win: P.WIN, floorH: 3, winH: 2, gap: 1, base: P.CONCRETE_D, bands: [[10, P.CONCRETE_L]], roof: P.ROOF_GREY, parapet: P.CONCRETE_L });
    K.block(g, 1, 1, 8, 8, 11, 13, { wall, win: P.WIN, floorH: 3, winH: 2, gap: 1, base: P.CONCRETE_D, bands: [[10, P.CONCRETE_L]], roof: P.ROOF_GREY, parapet: P.CONCRETE_L, faces: 'sew' });
    K.roofJunk(g, 2, 12, 2, 14, 6, rng, 3, 'avs');
    // gymnasium with copper barrel roof
    K.block(g, 16, 1, 1, 7, 8, 10, { wall: P.BRICK, win: P.WIN_COOL, floorH: 8, winH: 3, y0: 3, gap: 1, faces: 'se' });
    g.hcyl('z', 1, 10, 9, 19.5, 3.5, P.COPPER_GREEN);
    g.hcyl('z', 1, 1, 9, 19.5, 3.6, P.WHITE); g.hcyl('z', 10, 1, 9, 19.5, 3.6, P.WHITE);
    K.door(g, 's', 18, 1, 10, 3, 3, P.WOOD_D);
    // entrance pavilion + clock
    g.box(2, 1, 21, 6, 5, 1, P.GLASS_BLUE);
    g.box(1, 6, 21, 8, 1, 2, P.CONCRETE_L);
    K.door(g, 's', 4, 1, 21, 2, 3, P.GLASS_DARK);
    K.clock(g, 's', 4, 9, 21);
    // running track with a football field
    const cx = 17, cz = 17;
    g.box(10, 0, 10, 14, 1, 14, (x, y, z) => {
      const dx = Math.abs(x + 0.5 - cx), dz = Math.abs(z + 0.5 - cz);
      const d = dz <= 0.6 ? dx : Math.hypot(dx, dz - 0.6);
      if (d > 6.4) return P.GRASS;
      if (d > 4.3) return P.TRACK_RED;
      if (d > 3.6 || Math.abs(z + 0.5 - cz) < 0.5) return P.FIELD_LINE;
      return ((z >> 1) & 1) ? P.FIELD_GREEN : P.GRASS_L;
    });
    for (const gz of [13, 20]) { g.box(16, 1, gz, 1, 3, 1, P.YELLOW); g.box(18, 1, gz, 1, 3, 1, P.YELLOW); g.box(16, 2, gz, 3, 1, 1, P.YELLOW); }
    // bleachers
    g.box(10, 1, 13, 1, 1, 8, P.BLUE);
    g.box(9, 1, 13, 1, 1, 8, P.WHITE);
    g.box(9, 2, 13, 1, 1, 8, P.BLUE);
    // buses, trees, flag
    K.vehicle(g, 'bus', 0, 1, 22, 1, P.CAR_YELLOW, P.CAR_YELLOW);
    K.tree(g, 12, 1, 23, 'oak', 0.9);
    K.tree(g, 23, 1, 12, 'pine', 0.8);
    K.flag(g, 9, 1, 21, 10, [P.RED, P.WHITE]);
    K.lamp(g, 9, 1, 11, 5, P.LAMP_WHITE);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* library (2x2)                                                        */
/* ------------------------------------------------------------------ */
VC.models.define('library', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(2, 2, 24);
    K.lot(g, P.GRASS);
    if (v === 0) {
      // classical temple of books: podium, portico, pediment, copper dome
      g.box(5, 0, 13, 6, 1, 3, P.SIDEWALK);
      g.box(1, 0, 1, 14, 2, 12, P.MARBLE);
      K.block(g, 2, 2, 1, 12, 9, 9, { wall: P.SANDSTONE, win: P.WIN, winH: 4, floorH: 9, y0: 1, gap: 2, faces: 'ewn' });
      g.box(2, 10, 1, 12, 1, 9, P.MARBLE);
      K.door(g, 's', 7, 2, 9, 2, 4, P.WOOD_D);
      K.columns(g, 2, 2, 11, 3, 2, 7, P.MARBLE);
      K.columns(g, 9, 2, 11, 3, 2, 7, P.MARBLE);
      g.box(2, 9, 10, 12, 1, 3, P.MARBLE);
      K.pediment(g, 2, 10, 10, 12, P.MARBLE, 3, 2);
      g.box(7, 11, 12, 2, 1, 1, P.GOLD);
      K.steps(g, 3, 0, 13, 10, 2, P.MARBLE);
      g.cyl(8, 11, 5.5, 3.3, 2, P.MARBLE);
      K.dome(g, 8, 13, 5.5, 3.5, P.COPPER_GREEN, 3.6);
      g.cyl(8, 16, 5.5, 1.1, 2, P.MARBLE);
      g.box(7, 18, 5, 2, 1, 1, P.GOLD);
      K.lamp(g, 1, 1, 14, 4);
      K.lamp(g, 14, 1, 14, 4);
      K.tree(g, 0, 1, 3, 'cypress', 1);
      K.tree(g, 15, 1, 3, 'cypress', 1);
      K.tree(g, 0, 1, 9, 'cypress', 0.9);
      K.tree(g, 15, 1, 9, 'cypress', 0.9);
    } else {
      // modern library with a giant bookshelf facade and a green roof
      g.box(0, 0, 13, 16, 1, 3, P.SIDEWALK);
      K.block(g, 1, 1, 2, 14, 10, 10, { wall: P.GLASS_BLUE, noWin: true, roof: P.GRASS, parapet: P.WOOD_L });
      for (let z = 3; z < 11; z += 2) { g.box(0, 1, z, 1, 10, 1, P.WOOD_L); g.box(15, 1, z, 1, 10, 1, P.WOOD_L); }
      const books = [P.RED, P.BLUE, P.YELLOW, P.GREEN, P.ORANGE, P.PURPLE, P.NAVY, P.BROWN, P.CREAM, P.PINK];
      g.box(1, 1, 12, 14, 1, 1, P.WOOD_D); g.box(1, 5, 12, 14, 1, 1, P.WOOD_D); g.box(1, 9, 12, 14, 1, 1, P.WOOD_D);
      g.box(1, 1, 12, 1, 9, 1, P.WOOD_D); g.box(14, 1, 12, 1, 9, 1, P.WOOD_D);
      for (let x = 2; x < 14; x++) {
        if (x !== 7 && x !== 8) g.box(x, 2, 12, 1, rng.int(2, 3), 1, rng.pick(books));
        g.box(x, 6, 12, 1, rng.int(2, 3), 1, rng.pick(books));
      }
      g.box(7, 1, 12, 2, 4, 1, 0);
      K.door(g, 's', 7, 1, 11, 2, 4, P.GLASS_DARK);
      K.tree(g, 4, 11, 5, 'bush', 0.8);
      K.tree(g, 11, 11, 7, 'oak', 0.7);
      K.bench(g, 1, 1, 14, 'x', 3);
      K.bench(g, 12, 1, 14, 'x', 3);
      K.lamp(g, 6, 1, 15, 4);
    }
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* university (4x4)                                                     */
/* ------------------------------------------------------------------ */
VC.models.define('university', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(4, 4, 44);
    K.lot(g, P.GRASS);
    // quad paths + fountain
    g.box(15, 0, 11, 3, 1, 21, P.SIDEWALK);
    g.box(6, 0, 19, 21, 1, 2, P.SIDEWALK);
    g.cyl(16.5, 0, 19.5, 3.6, 1, P.SIDEWALK);
    g.cyl(16.5, 1, 19.5, 2.4, 1, P.MARBLE);
    g.cyl(16.5, 1, 19.5, 1.6, 1, P.WATER);
    g.box(16, 2, 19, 1, 2, 1, P.MARBLE);
    g.emit(16.5, 4, 19.5, 'fountain', 1);
    // main hall with clock tower
    K.block(g, 7, 1, 2, 19, 12, 9, { wall: P.SANDSTONE, win: P.WIN, floorH: 4, winH: 2, gap: 1, base: P.STONE, bands: [[11, P.WHITE]] });
    g.roofGable(6, 13, 1, 21, 11, P.ROOF_SLATE, 'x');
    g.box(14, 1, 7, 5, 27, 6, P.SANDSTONE);
    g.walls(14, 1, 7, 5, 2, 6, P.STONE);
    K.windows(g, 14, 1, 7, 5, 27, 6, { win: P.WIN, floorH: 5, winH: 3, y0: 6, top: 9, faces: 'sew', margin: 2 });
    K.door(g, 's', 15, 1, 12, 3, 4, P.WOOD_D);
    g.box(13, 1, 13, 7, 1, 2, P.STONE);
    K.clock(g, 's', 16, 22, 13, 1.5);
    K.clock(g, 'e', 10, 22, 19, 1.5);
    K.clock(g, 'w', 10, 22, 13, 1.5);
    g.walls(14, 20, 7, 5, 1, 6, P.STONE); g.walls(14, 24, 7, 5, 1, 6, P.STONE);
    g.box(14, 25, 7, 5, 2, 6, 0);
    for (const [px, pz] of [[14, 7], [18, 7], [14, 12], [18, 12], [16, 7], [16, 12]]) g.box(px, 25, pz, 1, 2, 1, P.SANDSTONE);
    g.sphere(16.5, 25.8, 9.5, 1, P.GOLD);
    g.box(13, 27, 6, 7, 1, 8, P.STONE);
    K.spire(g, 14, 28, 7, 5, 6, P.COPPER_GREEN, 3);
    g.box(16, 37, 9, 1, 2, 2, P.GOLD);
    // side halls
    K.block(g, 1, 1, 6, 5, 9, 22, { wall: P.BRICK, win: P.WIN, floorH: 3, winH: 2, gap: 1, base: P.STONE, sill: P.WHITE });
    g.roofGable(0, 10, 5, 7, 24, P.ROOF_RED, 'z', 0, P.BRICK);
    K.door(g, 'e', 18, 1, 5, 3, 3, P.WOOD_D);
    if (v === 0) {
      K.block(g, 27, 1, 6, 5, 9, 22, { wall: P.CONCRETE_L, win: P.WIN_OFFICE, ribbon: true, floorH: 3, winH: 2, margin: 0, roof: P.CONCRETE, parapet: P.CONCRETE_D });
      for (let z = 8; z < 26; z += 3) g.box(28, 10, z, 3, 1, 2, P.SOLAR);
      K.door(g, 'w', 18, 1, 27, 3, 3, P.GLASS_DARK);
    } else {
      K.block(g, 27, 1, 6, 5, 9, 22, { wall: P.BRICK, win: P.WIN, floorH: 3, winH: 2, gap: 1, base: P.STONE, sill: P.WHITE });
      g.roofGable(26, 10, 5, 7, 24, P.ROOF_RED, 'z', 0, P.BRICK);
      K.door(g, 'w', 18, 1, 27, 3, 3, P.WOOD_D);
    }
    // trees, benches, lamps
    for (const [tx, tz] of [[9, 14], [23, 14], [9, 25], [23, 25], [10, 28], [22, 28]]) K.tree(g, tx, 1, tz, 'oak', rng.range(0.9, 1.2));
    for (const [bx, bz] of [[12, 17], [20, 17], [12, 22], [20, 22]]) K.bench(g, bx, 1, bz, 'x', 2);
    for (const [lx, lz] of [[14, 15], [18, 15], [14, 25], [18, 25]]) K.lamp(g, lx, 1, lz, 4);
    // gateway arch with "UNI"
    g.box(12, 1, 30, 2, 6, 2, P.BRICK); g.box(19, 1, 30, 2, 6, 2, P.BRICK);
    g.box(12, 7, 30, 9, 5, 1, P.BRICK_D);
    g.box(11, 12, 30, 11, 1, 2, P.STONE);
    K.text(g, 'UNI', 16.5, 7, 31, P.GOLD);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* science_center (3x3)                                                 */
/* ------------------------------------------------------------------ */
VC.models.define('science_center', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(3, 3, 32);
    K.lot(g, P.CONCRETE_L);
    g.box(0, 0, 19, 24, 1, 5, P.SIDEWALK);
    g.box(20, 0, 12, 4, 1, 7, P.GRASS);
    // planetarium: glass drum, chrome ring, white dome with a window band
    g.cyl(7.5, 1, 7.5, 6.6, 3, P.GLASS_CYAN);
    K.ring(g, 7.5, 1, 7.5, 6.6, 7.2, 1, P.NEON_CYAN);
    K.ring(g, 7.5, 4, 7.5, 5.8, 7.2, 1, P.CHROME);
    K.dome(g, 7.5, 5, 7.5, 7, (x, y) => (y === 8 ? P.GLASS_CYAN : P.WHITE), 7);
    g.box(7, 12, 7, 1, 1, 1, P.CHROME);
    // observatory tower with a telescope poking out of the slit
    g.cyl(18.5, 1, 5.5, 3.4, 9, P.WHITE);
    g.cyl(18.5, 9, 5.5, 3.6, 1, P.METAL_D);
    K.dome(g, 18.5, 10, 5.5, 3.6, (x, y, z) => (x === 18 && z >= 5 ? P.GLASS_DARK : P.METAL), 3.6);
    K.beam(g, 18, 12, 6, 18, 15, 10, P.WHITE);
    g.set(18, 15, 10, P.METAL_D); g.set(18, 16, 10, P.METAL_D);
    K.windows(g, 15, 1, 2, 7, 9, 7, { win: P.WIN_COOL, floorH: 3, winH: 1, y0: 2, faces: 'se' });
    // glass exhibit wing with chrome mullions and a solar roof
    g.box(8, 1, 12, 13, 6, 7, P.GLASS_CYAN);
    for (let x = 8; x <= 20; x += 3) g.box(x, 1, 18, 1, 6, 1, P.CHROME);
    g.box(8, 7, 12, 13, 1, 7, P.WHITE);
    g.box(8, 7, 18, 13, 1, 1, P.NEON_CYAN);
    for (let z = 13; z < 18; z += 2) g.box(10, 8, z, 9, 1, 1, P.SOLAR);
    K.door(g, 's', 13, 1, 18, 3, 3, P.GLASS_DARK);
    g.box(12, 5, 19, 5, 1, 2, P.WHITE);
    // sculpture: DNA double helix (v0) or ringed planet (v1)
    const sx = 3.5, sz = 20.5;
    g.box(2, 1, 19, 3, 1, 3, P.CHROME);
    if (v === 0) {
      for (let y = 2; y < 15; y++) {
        const a = y * 0.62;
        const ax = sx + Math.cos(a) * 1.6, az = sz + Math.sin(a) * 1.6;
        const bx = sx - Math.cos(a) * 1.6, bz = sz - Math.sin(a) * 1.6;
        g.set(Math.floor(ax), y, Math.floor(az), P.NEON_PURPLE);
        g.set(Math.floor(bx), y, Math.floor(bz), P.NEON_CYAN);
        if (y % 3 === 0) K.beam(g, Math.floor(ax), y, Math.floor(az), Math.floor(bx), y, Math.floor(bz), P.WHITE);
      }
      g.light(sx, 9, sz, K.LC.purple, 1.2);
    } else {
      g.box(3, 2, 20, 1, 5, 1, P.METAL_D);
      g.sphere(sx, 9, sz, 2.3, (x, y) => (y === 9 ? P.SANDSTONE : P.ORANGE));
      K.ring(g, sx, 9, sz, 2.6, 3.8, 1, P.GOLD);
      g.light(sx, 9, sz, K.LC.yellow, 1);
    }
    K.lamp(g, 10, 1, 21, 4, P.LAMP_WHITE);
    K.lamp(g, 18, 1, 21, 4, P.LAMP_WHITE);
    K.tree(g, 21, 1, 14, 'birch', 1);
    K.tree(g, 22, 1, 17, 'bush', 0.8);
    K.bench(g, 13, 1, 21, 'x', 3);
    return K.fit(g);
  },
});
