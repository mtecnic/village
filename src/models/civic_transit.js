/*
 * VOXELPOLIS — civic models: TRANSPORT.
 * bus_depot, metro_station, seaport, airport (+ part 'radar_antenna').
 * Water-side buildings (seaport) put their dock on the front (+Z) edge.
 * Helpers: VC.civicKit (models/civic.js).
 */
const P = VC.P, K = VC.civicKit;

/* ------------------------------------------------------------------ */
/* bus_depot (2x2)                                                      */
/* ------------------------------------------------------------------ */
VC.models.define('bus_depot', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(2, 2, 20);
    K.lot(g, P.ASPHALT);
    const body = v ? P.CAR_RED : P.CAR_GREEN;
    // garage hall with three open bays
    K.block(g, 1, 1, 1, 14, 10, 8, { wall: P.CONCRETE_L, noWin: true, base: P.CONCRETE_D, bands: [[5, v ? P.RED : P.GREEN]] });
    K.windows(g, 1, 1, 1, 14, 10, 8, { win: P.WIN_COOL, floorH: 10, winH: 2, y0: 6, faces: 'we' });
    for (const bx of [2, 6, 10]) {
      g.box(bx, 1, 3, 3, 4, 6, 0);
      g.box(bx, 1, 2, 3, 4, 1, P.CONCRETE_DD);
      g.box(bx, 4, 8, 3, 1, 1, P.METAL);
      K.vehicle(g, 'bus', bx, 1, 1, 0, body, P.CAR_WHITE);
    }
    K.text(g, 'BUS', 7.5, 6, 9, P.SIGN_WHITE);
    // sawtooth roof with north-light glazing
    for (let k = 0; k < 3; k++) {
      const z0 = 1 + k * 3 - (k === 2 ? 1 : 0);
      for (let i = 0; i < 3; i++) g.box(1, 11, z0 + i, 14, 3 - i, 1, i === 0 ? P.GLASS_BLUE : P.ROOF_GREY);
      g.box(1, 13, z0, 14, 1, 1, P.ROOF_GREY);
    }
    // parked buses, fuel island
    K.vehicle(g, 'bus', 0, 1, 10, 1, body, P.CAR_WHITE);
    K.vehicle(g, 'bus', 0, 1, 13, 1, body, P.CAR_WHITE);
    for (let x = 0; x < 9; x += 2) g.set(x, 0, 12, P.ROAD_MARK);
    g.box(10, 0, 10, 5, 1, 5, P.CONCRETE);
    g.box(10, 5, 10, 5, 1, 5, P.WHITE);
    g.box(10, 5, 14, 5, 1, 1, body);
    g.box(12, 1, 11, 1, 4, 1, P.METAL); g.box(12, 1, 13, 1, 4, 1, P.METAL);
    g.box(12, 1, 12, 1, 2, 1, P.RED); g.set(12, 2, 12, P.WHITE);
    K.lamp(g, 15, 1, 15, 4, P.LAMP_WHITE);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* metro_station (2x2)                                                  */
/* ------------------------------------------------------------------ */
VC.models.define('metro_station', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(2, 2, 24);
    // raised plaza with a stairwell descending toward the back (darker = deeper)
    g.box(0, 0, 0, 16, 2, 16, (x, y, z) => (y === 1 && (x + z) % 4 === 0 ? P.CONCRETE_L : P.SIDEWALK));
    const steps = [P.CONCRETE, P.CONCRETE_D, P.CONCRETE_D, P.CONCRETE_DD, P.CONCRETE_DD, P.BLACK, P.BLACK, P.BLACK];
    for (let z = 5; z <= 12; z++) {
      g.box(5, 1, z, 6, 1, 1, 0);
      g.box(5, 0, z, 6, 1, 1, steps[12 - z]);
    }
    g.box(6, 0, 7, 1, 1, 6, P.METAL); g.box(9, 0, 7, 1, 1, 6, P.METAL);
    // railings
    for (let z = 5; z <= 12; z += 1) { g.set(4, 2, z, P.METAL); g.set(11, 2, z, P.METAL); }
    g.box(4, 2, 4, 8, 1, 1, P.METAL);
    // curved glass canopy on a steel frame
    g.hcyl('z', 4, 10, 4, 8, 4.4, (a, y, q) => {
      if (y < 4) return g.get(q, y, a);
      const d = Math.hypot(y + 0.5 - 4, q + 0.5 - 8);
      if (d <= 3.4) return 0;
      return (a - 4) % 3 === 0 ? P.METAL_D : P.GLASS_CYAN;
    });
    for (const [px, pz] of [[4, 4], [11, 4], [4, 13], [11, 13]]) g.box(px, 2, pz, 1, 3, 1, P.METAL_D);
    // M sign pylon (glowing both sides)
    g.box(12, 2, 13, 1, 7, 1, P.NAVY);
    g.box(9, 9, 13, 7, 7, 1, P.SIGN_WHITE);
    g.box(9, 9, 13, 7, 1, 1, P.NAVY); g.box(9, 15, 13, 7, 1, 1, P.NAVY);
    K.text(g, 'M', 12.5, 10, 14, P.NEON_BLUE);
    K.text(g, 'M', 12.5, 10, 12, P.NEON_BLUE, 'n');
    g.light(12.5, 12.5, 13.5, K.LC.blue, 1.6, true);
    // ticket hall / ventilation at the back
    K.block(g, 1, 2, 0, 14, 4, 3, { wall: v ? P.BRICK_L : P.GLASS_BLUE, noWin: true, roof: P.CONCRETE_L });
    for (let x = 1; x < 15; x += 3) g.box(x, 2, 2, 1, 4, 1, P.CHROME);
    g.box(1, 6, 0, 14, 1, 3, P.WHITE);
    // planters, benches, bike rack
    for (const [tx, tz] of [[1, 6], [1, 12]]) { g.box(tx, 2, tz, 2, 1, 2, P.STONE); K.tree(g, tx, 3, tz, 'oak', 0.7); }
    K.bench(g, 13, 2, 6, 'z', 3, true);
    for (let z = 9; z < 12; z++) g.set(14, 2, z, P.METAL);
    K.lamp(g, 1, 2, 15, 4);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* seaport (4x3)                                                        */
/* ------------------------------------------------------------------ */
function gantryCrane(g, x0, col) {
  for (const [lx, lz] of [[x0, 9], [x0 + 4, 9], [x0, 14], [x0 + 4, 14]]) g.box(lx, 2, lz, 1, 20, 1, col);
  g.box(x0, 12, 9, 5, 1, 1, col); g.box(x0, 12, 14, 5, 1, 1, col);
  g.box(x0, 21, 9, 1, 1, 6, col); g.box(x0 + 4, 21, 9, 1, 1, 6, col);
  // boom reaching over the ship
  g.box(x0 + 1, 22, 4, 3, 2, 20, col);
  g.box(x0 + 1, 24, 7, 3, 3, 4, P.WHITE);
  g.box(x0 + 1, 24, 8, 3, 1, 1, P.GLASS_DARK);
  // trolley + hanging container
  g.box(x0 + 1, 21, 19, 3, 1, 2, P.METAL_D);
  g.box(x0 + 2, 12, 19, 1, 9, 1, P.METAL_D);
  g.box(x0 + 1, 11, 18, 3, 1, 4, P.HAZARD_Y);
  g.light(x0 + 2.5, 21, 21, K.LC.white, 1.2);
}
VC.models.define('seaport', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(4, 3, 40);
    // quay (2 voxels high) + dock basin at the front
    g.box(0, 0, 0, 32, 2, 16, P.CONCRETE);
    g.box(0, 1, 15, 32, 1, 1, P.HAZARD_Y);
    g.box(0, 0, 16, 32, 1, 8, P.WATER);
    for (let x = 2; x < 32; x += 5) g.set(x, 2, 15, P.BLACK);
    for (const rz of [9, 14]) g.box(0, 2, rz, 32, 1, 1, P.METAL_D);
    // warehouse
    K.block(g, 1, 2, 1, 11, 7, 7, { wall: v ? P.BRICK : P.PLASTER_CREAM, noWin: true, base: P.CONCRETE_D });
    g.roofGable(0, 9, 0, 13, 9, P.ROOF_GREY, 'x', 0, v ? P.BRICK : P.PLASTER_CREAM);
    for (const dx of [2, 7]) K.door(g, 's', dx, 2, 7, 3, 4, P.METAL_D);
    // container yard
    const cols = [P.CONTAINER_R, P.CONTAINER_B, P.CONTAINER_G, P.CONTAINER_O, P.WHITE];
    for (const cz of [1, 4]) for (const cx of [14, 20, 26]) {
      const h = rng.int(1, 3);
      for (let k = 0; k < h; k++) K.vehicle(g, 'container', cx, 2 + k * 3, cz, 1, rng.pick(cols));
    }
    // cranes
    gantryCrane(g, 10, v ? P.STEEL_BLUE : P.CONTAINER_O);
    gantryCrane(g, 21, v ? P.STEEL_BLUE : P.CONTAINER_O);
    K.beacon(g, 12, 27, 9, 0.7);
    K.beacon(g, 23, 27, 9, 0.7);
    // docked container ship
    const hull = v ? P.NAVY : P.BLACK;
    for (let x = 2; x <= 30; x++) {
      const bow = x > 26 ? x - 26 : 0;
      const z0 = 17 + (bow >= 3 ? 2 : bow >= 1 ? 1 : 0), z1 = 22 - (bow >= 3 ? 2 : bow >= 1 ? 1 : 0);
      g.box(x, 0, z0, 1, 1, z1 - z0 + 1, P.RED);
      g.box(x, 1, z0, 1, 3, z1 - z0 + 1, hull);
      g.box(x, 4, z0, 1, 1, z1 - z0 + 1, P.CONCRETE_D);
    }
    g.box(2, 4, 17, 27, 1, 1, P.WHITE); g.box(2, 4, 22, 27, 1, 1, P.WHITE);
    // bridge superstructure + funnel
    K.block(g, 3, 5, 17, 5, 7, 6, { wall: P.WHITE, win: P.WIN, floorH: 2, winH: 1, y0: 1, gap: 1, faces: 'sen' });
    g.box(3, 11, 16, 5, 1, 8, P.WHITE);
    g.box(3, 10, 17, 5, 1, 6, P.GLASS_DARK); g.box(3, 10, 17, 1, 1, 6, P.WHITE);
    g.box(4, 12, 19, 2, 4, 2, P.RED);
    g.box(4, 16, 19, 2, 1, 2, P.BLACK);
    g.emit(5, 17.5, 20, 'smoke', 0.5);
    g.box(6, 12, 20, 1, 3, 1, P.METAL);
    K.beacon(g, 6, 15, 20, 0.5);
    // deck containers (two rows along the ship)
    for (const cx of [9, 15, 21]) for (const cz of [17, 20]) {
      const h = rng.int(1, 2);
      for (let k = 0; k < h; k++) K.vehicle(g, 'container', cx, 5 + k * 3, cz, 1, rng.pick(cols));
    }
    // harbour light at the quay end + a truck
    g.cyl(30.5, 2, 12.5, 1.2, 6, (x, y) => ((y >> 1) & 1 ? P.RED : P.WHITE));
    g.box(30, 8, 12, 1, 1, 1, P.LAMP);
    g.light(30.5, 8.6, 12.5, K.LC.warm, 1.2, true);
    K.vehicle(g, 'truck', 1, 2, 10, 1, P.CAR_BLUE, P.CONTAINER_G);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* airport (6x4) + rotating radar antenna                              */
/* ------------------------------------------------------------------ */
const RADAR = [42.5, 11, 16.5]; // antenna pivot (top of the mast at voxel column 42,16)
VC.models.define('radar_antenna', {
  gen() {
    const g = new VC.VoxelGrid(9, 4, 3);
    g.box(4, 0, 1, 1, 2, 1, P.METAL_D);
    g.box(0, 2, 0, 9, 2, 1, P.WHITE);
    g.box(1, 2, 1, 7, 1, 1, P.METAL);
    g.set(0, 3, 0, P.BEACON_RED); g.set(8, 3, 0, P.BEACON_RED);
    return g;
  },
});
VC.models.define('airport', {
  variants: 1,
  parts: [{ model: 'radar_antenna', pivot: RADAR, partPivot: [4.5, 0, 1.5], axis: 'y', speed: 2.2 }],
  gen(rng) {
    const g = K.grid(6, 4, 48);
    K.lot(g, P.GRASS);
    // runway with piano keys, numbers, centerline and edge lights
    g.box(0, 0, 1, 48, 1, 7, P.ASPHALT);
    for (let x = 12; x < 36; x += 4) g.box(x, 0, 4, 2, 1, 1, P.ROAD_MARK);
    for (const kx of [1, 44]) for (const kz of [2, 3, 5, 6]) g.box(kx, 0, kz, 3, 1, 1, P.ROAD_MARK);
    K.text(g, '09', 7.5, 0, 4.5, P.ROAD_MARK, 'top');
    K.text(g, '27', 40.5, 0, 4.5, P.ROAD_MARK, 'top');
    for (let x = 0; x < 48; x += 4) { g.set(x, 0, 1, P.LAMP_WHITE); g.set(x, 0, 7, P.LAMP_WHITE); }
    g.light(0.5, 0.8, 4.5, K.LC.green, 1.2, true);
    g.light(47.5, 0.8, 4.5, K.LC.red, 1.2, true);
    // taxiway + connectors
    g.box(0, 0, 9, 48, 1, 3, P.ASPHALT);
    g.box(0, 0, 10, 48, 1, 1, P.HAZARD_Y);
    for (const cx of [3, 43]) g.box(cx, 0, 8, 3, 1, 1, P.ASPHALT);
    // apron with lead-in lines
    g.box(0, 0, 12, 48, 1, 10, P.CONCRETE);
    // terminal: wave roof over a glass hall, jet bridges
    g.hcyl('x', 3, 34, 6, 24.5, 4.6, (a, y) => (y < 7 ? 0 : a % 4 === 0 ? P.CHROME : P.WHITE));
    K.block(g, 4, 1, 22, 32, 7, 6, { wall: P.CONCRETE_L, win: P.WIN_OFFICE, ribbon: true, floorH: 7, winH: 5, y0: 1, top: 1, margin: 0, faces: 'ns' });
    for (let x = 4; x < 36; x += 4) { g.box(x, 1, 21, 1, 6, 1, P.CHROME); g.box(x, 1, 28, 1, 6, 1, P.CHROME); }
    for (const [gx, liv] of [[5, P.BLUE], [17, P.RED], [29, P.GREEN]]) {
      K.vehicle(g, 'jet', gx, 1, 10, 0, liv);
      g.box(gx + 7, 2, 18, 2, 2, 4, P.CONCRETE_L);
      g.box(gx + 8, 1, 18, 1, 1, 1, P.METAL_D);
      g.box(gx + 5, 0, 21, 2, 1, 1, P.HAZARD_Y);
    }
    // control tower
    g.box(37, 1, 22, 10, 4, 7, P.WHITE);
    K.windows(g, 37, 1, 22, 10, 4, 7, { win: P.WIN_COOL, floorH: 4, winH: 2, y0: 1, faces: 'nse' });
    g.cyl(42, 5, 25.5, 1.7, 24, P.CONCRETE_L);
    g.cyl(42, 29, 25.5, 3.4, 1, P.WHITE);
    g.cyl(42, 30, 25.5, 3.2, 3, P.GLASS_TEAL);
    g.cyl(42, 33, 25.5, 3.6, 1, P.WHITE);
    g.cyl(42, 34, 25.5, 1.2, 1, P.METAL_D);
    g.box(41, 35, 25, 1, 4, 1, P.METAL);
    K.beacon(g, 41, 39, 25, 1);
    g.light(42, 34.6, 25.5, K.LC.green, 1.6, true);
    // radar mast (the antenna spins as a part)
    g.box(41, 0, 15, 3, 1, 3, P.CONCRETE_D);
    g.box(42, 1, 16, 1, RADAR[1] - 1, 1, P.METAL);
    g.box(41, RADAR[1] - 1, 15, 3, 1, 3, P.METAL_D);
    // landside: drop-off road, taxis, bus
    g.box(0, 0, 29, 48, 1, 3, P.ASPHALT);
    for (let x = 1; x < 48; x += 4) g.box(x, 0, 30, 2, 1, 1, P.ROAD_MARK);
    K.vehicle(g, 'car', 6, 1, 29, 1, P.CAR_YELLOW);
    K.vehicle(g, 'car', 12, 1, 29, 1, P.CAR_YELLOW);
    K.vehicle(g, 'bus', 20, 1, 29, 1, P.CAR_BLUE, P.CAR_WHITE);
    K.vehicle(g, 'car', 33, 1, 30, 3, P.CAR_WHITE);
    // apron floodlights + windsock
    for (const lx of [2, 46]) { g.box(lx, 1, 20, 1, 9, 1, P.METAL); g.box(lx, 10, 20, 1, 1, 1, P.LAMP_WHITE); g.light(lx + 0.5, 10.5, 20.5, K.LC.white, 1.8); }
    g.box(46, 1, 8, 1, 4, 1, P.METAL);
    g.box(47, 4, 8, 1, 1, 1, P.ORANGE); g.box(47, 3, 8, 1, 1, 1, P.WHITE);
    return K.fit(g);
  },
});
