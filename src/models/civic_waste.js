/*
 * VOXELPOLIS — civic models: SANITATION.
 * landfill, incinerator, recycling.
 * Helpers: VC.civicKit (models/civic.js). Front/entrance faces +Z.
 */
const P = VC.P, K = VC.civicKit;

/* ------------------------------------------------------------------ */
/* landfill (3x3)                                                       */
/* ------------------------------------------------------------------ */
const TRASH = () => [P.WHITE, P.GREY, P.BLUE, P.RED, P.YELLOW, P.BROWN, P.CONCRETE_D, P.GREEN, P.ORANGE];
VC.models.define('landfill', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(3, 3, 24);
    K.lot(g, P.SOIL);
    g.box(10, 0, 16, 4, 1, 8, P.CONCRETE_D);
    // old capped mound (grassed) + active trash mound (clustered junk, mesher friendly 2x2x2 cells)
    g.ellipsoid(6.5, 0.5, 7, 6, v ? 4 : 5, 5.5, (x, y, z) => (y > 2 ? P.GRASS_D : P.SOIL));
    const trash = TRASH(), seed = v * 101 + 7;
    g.ellipsoid(15, 0.5, 9, 7, 5.2, 6, (x, y, z) => {
      const h = VC.M.hash((x >> 1) + (y >> 1) * 57, z >> 1, seed);
      return h < 0.45 ? P.BROWN : trash[Math.floor(h * 97) % trash.length];
    });
    K.vehicle(g, 'bulldozer', 13, 5, 8, 1);
    K.vehicle(g, 'bulldozer', 4, 4, 6, 2);
    // garbage truck arriving + weighbridge + gatehouse
    K.vehicle(g, 'truck', 11, 1, 16, 0, P.CAR_GREEN, P.GREEN);
    g.box(10, 0, 16, 4, 1, 1, P.METAL_D);
    K.block(g, 16, 1, 18, 5, 4, 4, { wall: P.PLASTER_CREAM, win: P.WIN, floorH: 4, winH: 1, y0: 2, faces: 'sw', roof: P.ROOF_GREEN });
    K.door(g, 's', 18, 1, 21, 1, 3, P.WOOD_D);
    g.box(14, 1, 22, 1, 3, 1, P.HAZARD_B);
    g.box(10, 3, 22, 4, 1, 1, (x) => (x & 1 ? P.RED : P.WHITE));
    // methane flare
    g.box(2, 1, 19, 1, 6, 1, P.METAL_D);
    g.box(1, 1, 18, 3, 1, 3, P.CONCRETE_D);
    g.set(2, 7, 19, P.FIRE);
    g.emit(2.5, 8, 19.5, 'fire', 0.8);
    g.light(2.5, 8, 19.5, K.LC.orange, 1.2, true);
    // fence with gate
    K.fence(g, 0, 0, 23, 23, 1, P.METAL_D, { h: 2, step: 3, skip: (x, z) => z === 23 && x >= 10 && x <= 13 });
    K.lamp(g, 9, 1, 22, 4, P.LAMP_WHITE);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* incinerator (2x2)                                                    */
/* ------------------------------------------------------------------ */
VC.models.define('incinerator', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(2, 2, 44);
    K.lot(g, P.CONCRETE_D);
    g.box(2, 0, 12, 6, 1, 4, P.ASPHALT);
    // boiler/furnace hall
    const wall = v ? P.STEEL_BLUE : P.METAL_D;
    K.block(g, 1, 1, 2, 10, 11, 10, { wall, noWin: true, base: P.CONCRETE, bands: [[8, P.RUST], [9, P.RUST]], roof: P.ROOF_GREY });
    for (const x of [1, 8, 10]) g.box(x, 1, 12, 1, 8, 1, P.METAL);
    // tipping hall door with a garbage truck backing in
    g.box(3, 1, 8, 4, 5, 4, 0);
    g.box(3, 1, 7, 4, 5, 1, P.CONCRETE_DD);
    g.box(3, 6, 11, 4, 1, 1, P.HAZARD_Y);
    K.vehicle(g, 'truck', 4, 1, 9, 0, P.CAR_GREEN, P.GREEN);
    // furnace viewing windows glowing orange
    for (const z of [4, 7]) {
      g.box(10, 3, z, 1, 2, 2, P.FIRE);
      g.light(11.2, 4, z + 1, K.LC.orange, 1.1, true);
    }
    // flue-gas cleaning + chimney
    K.block(g, 11, 1, 7, 4, 7, 5, { wall: P.METAL, noWin: true, roof: P.METAL_D });
    g.box(12, 8, 8, 2, 3, 2, P.PIPE);
    g.box(12, 10, 5, 2, 1, 4, P.PIPE);
    g.cyl(13, 0, 3.5, 2.4, 3, P.CONCRETE);
    for (let y = 3; y < 36; y++) g.cyl(13, y, 3.5, 1.9 - (y * 0.4) / 36, 1, y > 30 ? (((36 - y) >> 1) & 1 ? P.WHITE : P.CHIMNEY_RED) : P.CHIMNEY);
    g.set(13, 35, 3, P.BLACK);
    g.emit(13, 36.5, 3.5, 'smoke', 1.3);
    K.beacon(g, 14, 35, 3, 0.8);
    // power output
    g.box(12, 1, 13, 2, 3, 2, P.METAL_D);
    g.set(12, 4, 13, P.WHITE); g.set(13, 4, 14, P.WHITE);
    K.lamp(g, 8, 1, 14, 4, P.LAMP_WHITE);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* recycling (2x2)                                                      */
/* ------------------------------------------------------------------ */
// chasing-arrows triangle (9 x 6)
const RECYCLE = ['....#....', '...#.#...', '..#...#..', '.##...##.', '#.......#', '####.####'];
VC.models.define('recycling', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(2, 2, 24);
    K.lot(g, P.CONCRETE_L);
    g.box(0, 0, 13, 16, 1, 3, P.GRASS);
    // clean sorting hall with a big glowing recycle symbol
    K.block(g, 1, 1, 1, 10, 9, 9, {
      wall: v ? P.PLASTER_MINT : P.WHITE, win: P.WIN_COOL, ribbon: true, floorH: 9, winH: 1, y0: 1, faces: 'w',
      base: P.GREEN, bands: [[8, P.GREEN]], roof: P.GRASS, parapet: P.GREEN,
    });
    for (let r = 0; r < RECYCLE.length; r++)
      for (let k = 0; k < 9; k++) if (RECYCLE[r][k] === '#') g.set(2 + k, 8 - r, 10, P.NEON_GREEN);
    g.light(6.5, 5.5, 10.8, K.LC.green, 1.6);
    K.door(g, 's', 5, 1, 9, 2, 2, P.GLASS_DARK);
    for (let z = 2; z < 9; z += 2) g.box(3, 10, z, 6, 1, 1, P.SOLAR);
    K.tree(g, 9, 10, 7, 'bush', 0.6);
    // roller door + conveyor with sorted items
    K.door(g, 'e', 3, 1, 10, 3, 4, P.METAL_D);
    for (let i = 0; i < 5; i++) g.box(11 + i, 4 - Math.floor(i * 0.7), 4, 1, 1, 2, P.METAL_D);
    g.set(12, 5, 4, P.BLUE); g.set(14, 4, 5, P.YELLOW);
    g.box(13, 1, 4, 1, 2, 1, P.METAL_D);
    // colour-coded bins
    const bins = [P.BLUE, P.GREEN, P.YELLOW, P.RED];
    bins.forEach((c, i) => {
      g.box(1 + i * 3, 1, 11, 2, 2, 2, c);
      g.box(1 + i * 3, 3, 11, 2, 1, 2, P.CONCRETE_DD);
    });
    // bales of sorted material
    const bales = [P.CREAM, P.CHROME, P.GREEN, P.BLUE, P.WHITE, P.CREAM];
    let bi = 0;
    for (let z = 7; z < 13; z += 3)
      for (let x = 12; x < 16; x += 2) {
        const h = 1 + ((x + z + v) & 1);
        for (let k = 0; k < h; k++) g.box(x, 1 + k * 2, z, 2, 2, 2, bales[bi++ % bales.length]);
      }
    K.tree(g, 14, 1, 14, 'oak', 0.7);
    K.tree(g, 1, 1, 14, 'bush', 0.7);
    K.lamp(g, 8, 1, 14, 4);
    return K.fit(g);
  },
});
