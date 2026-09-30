/*
 * VOXELPOLIS — civic models: WATER UTILITIES.
 * water_pump, water_tower, water_plant, desalination.
 * Water buildings touch water on any side, so they stay compact and read well from all angles;
 * intakes are drawn toward the front (+Z). Helpers: VC.civicKit (models/civic.js).
 */
const P = VC.P, K = VC.civicKit;

/** Blue water-drop emblem on a face plane (5 tall). */
function drop(g, face, ca, y, plane, c = P.BLUE) {
  const rows = ['.#.', '.#.', '###', '###', '.#.'];
  for (let r = 0; r < 5; r++)
    for (let k = 0; k < 3; k++) {
      if (rows[r][k] !== '#') continue;
      const [x, z] = K.faceXZ(face, ca - 1 + (face === 'n' || face === 'e' ? 2 - k : k), plane);
      g.set(x, y + 4 - r, z, c);
    }
}

/* ------------------------------------------------------------------ */
/* water_pump (1x1)                                                     */
/* ------------------------------------------------------------------ */
VC.models.define('water_pump', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(1, 1, 12);
    K.lot(g, P.CONCRETE_L);
    // intake grate + pipe diving into the ground at the front
    g.box(0, 0, 6, 5, 1, 2, (x, y, z) => ((x + z) & 1 ? P.METAL_D : P.BLACK));
    const wall = v ? P.PLASTER_SKY : P.BRICK_L, roof = v ? P.ROOF_TEAL : P.ROOF_BLUE;
    K.block(g, 1, 0, 1, 5, 5, 5, { wall, noWin: true, base: P.CONCRETE_D });
    g.roofGable(0, 5, 1, 7, 5, roof, 'z', 0, wall);
    K.door(g, 's', 3, 1, 5, 1, 3, P.WOOD_D);
    g.set(3, 4, 6, P.LAMP);
    g.light(3.5, 4.5, 6.8, K.LC.warm, 0.5);
    g.set(1, 3, 3, 0); g.set(2, 3, 3, P.WIN); // side window
    g.set(3, 6, 5, P.GLASS_BLUE);
    g.hcyl('z', 2, 5, 2.5, 6.5, 1.05, P.STEEL_BLUE);
    g.cyl(6.5, 0, 6.5, 1.05, 3, P.STEEL_BLUE);
    g.box(6, 4, 4, 2, 1, 1, P.RED);
    g.set(6, 1, 1, P.METAL_D); g.set(6, 2, 1, P.METAL_D); g.set(7, 1, 1, P.NEON_GREEN);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* water_tower (1x1)                                                    */
/* ------------------------------------------------------------------ */
VC.models.define('water_tower', {
  variants: 3,
  gen(rng, v) {
    const g = K.grid(1, 1, 40);
    const leg = v === 2 ? P.RUST : v === 1 ? P.STEEL_BLUE : P.METAL_D;
    const legs = [[1, 1], [6, 1], [1, 6], [6, 6]];
    for (const [x, z] of legs) g.box(x - (x > 3 ? 0 : 1), 0, z - (z > 3 ? 0 : 1), 2, 1, 2, P.CONCRETE);
    for (const [x, z] of legs) g.box(x, 0, z, 1, 22, 1, leg);
    // X-bracing on each side
    for (const [ya, yb] of [[3, 11], [11, 19]]) {
      g.line(1, ya, 1, 6, yb, 1, leg); g.line(6, ya, 1, 1, yb, 1, leg);
      g.line(1, ya, 6, 6, yb, 6, leg); g.line(6, ya, 6, 1, yb, 6, leg);
      g.line(1, ya, 1, 1, yb, 6, leg); g.line(1, ya, 6, 1, yb, 1, leg);
      g.line(6, ya, 1, 6, yb, 6, leg); g.line(6, ya, 6, 6, yb, 1, leg);
    }
    g.box(3, 0, 3, 2, 22, 2, P.PIPE);
    // tank
    const body = v === 1 ? P.PLASTER_SKY : P.TANK_WHITE;
    const band = v === 1 ? P.WHITE : P.BLUE;
    g.cyl(4, 20, 4, 2.6, 1, body);
    g.cyl(4, 21, 4, 3.4, 1, body);
    g.cyl(4, 21, 4, 4.3, 1, P.METAL_D);
    for (let y = 22; y < 32; y++) {
      let c = body;
      if (v === 2) c = (x, yy, z) => ((((x + z) >> 1) + (yy >> 1)) & 1 ? P.WHITE : P.CHIMNEY_RED);
      else if (y === 23 || y === 31) c = band;
      g.cyl(4, y, 4, 3.95, 1, c);
    }
    if (v !== 2) {
      // city logo on the front (+Z) of the tank
      K.text(g, 'V', 4.5, 25, 7, v === 1 ? P.WHITE : P.BLUE);
      K.text(g, 'V', 7, 25, 4.5, v === 1 ? P.WHITE : P.BLUE, 'e');
    }
    const roofC = v === 2 ? P.CHIMNEY_RED : v === 1 ? P.ROOF_BLUE : P.ROOF_GREY;
    g.cyl(4, 32, 4, 3.7, 1, roofC);
    g.cyl(4, 33, 4, 3.0, 1, roofC);
    g.cyl(4, 34, 4, 2.2, 1, roofC);
    g.cyl(4, 35, 4, 1.3, 1, roofC);
    g.box(3, 36, 3, 2, 1, 2, P.METAL);
    K.beacon(g, 4, 37, 4, 0.7);
    // railing posts on the catwalk
    K.dots(g, 4, 22, 4, 4.1, 8, P.METAL, Math.PI / 8);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* water_plant (2x2)                                                    */
/* ------------------------------------------------------------------ */
/** Round clarifier basin with sloshing water, central drive and rotating bridge. */
function clarifier(g, cx, cz, r, bridgeDir = 1) {
  g.cyl(cx, 0, cz, r, 3, P.CONCRETE);
  g.cyl(cx, 1, cz, r - 0.8, 2, 0);
  g.cyl(cx, 1, cz, r - 0.8, 1, P.WATER);
  g.box(Math.floor(cx), 1, Math.floor(cz), 1, 3, 1, P.METAL);
  K.beam(g, Math.floor(cx), 3, Math.floor(cz), Math.floor(cx + bridgeDir * (r - 0.6)), 3, Math.floor(cz), P.METAL_D);
  g.set(Math.floor(cx + bridgeDir * (r - 1)), 4, Math.floor(cz), P.HAZARD_Y);
}
VC.models.define('water_plant', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(2, 2, 20);
    K.lot(g, P.CONCRETE_L);
    g.box(0, 0, 15, 16, 1, 1, P.GRASS);
    // filter building + tall pump hall with emblem
    K.block(g, 1, 0, 1, 14, 7, 6, { wall: P.PLASTER_SKY, win: P.WIN_COOL, floorH: 3, winH: 2, gap: 1, roof: P.CONCRETE, parapet: P.STEEL_BLUE, base: P.STEEL_BLUE, faces: 'swe' });
    K.block(g, 10, 0, 1, 5, 10, 6, { wall: P.WHITE, win: P.WIN_COOL, floorH: 3, winH: 1, y0: 7, roof: P.ROOF_BLUE, parapet: P.STEEL_BLUE, base: P.STEEL_BLUE, faces: 'e' });
    drop(g, 's', 12, 3, 7);
    K.door(g, 's', 5, 1, 6, 2, 3, P.GLASS_BLUE);
    g.box(4, 4, 7, 4, 1, 1, P.STEEL_BLUE);
    K.roofJunk(g, 1, 7, 1, 9, 6, rng, 2, 'a');
    if (v === 0) {
      clarifier(g, 4, 11.5, 3.6, 1);
      clarifier(g, 12, 11.5, 3.6, -1);
    } else {
      clarifier(g, 4.5, 11.5, 3.8, 1);
      // rectangular filter beds
      g.box(9, 0, 8, 6, 3, 7, P.CONCRETE);
      g.box(10, 2, 9, 4, 1, 5, P.WATER);
      g.box(10, 2, 11, 4, 1, 1, P.CONCRETE);
      g.box(12, 2, 9, 1, 1, 5, P.CONCRETE);
    }
    g.box(4, 1, 7, 1, 1, 2, P.PIPE); g.box(12, 1, 7, 1, 1, 2, P.PIPE);
    K.lamp(g, 8, 1, 14, 4);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* desalination (3x3)                                                   */
/* ------------------------------------------------------------------ */
VC.models.define('desalination', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(3, 3, 24);
    K.lot(g, P.CONCRETE_L);
    // sea intake basin at the front
    g.box(0, 0, 20, 14, 2, 4, P.CONCRETE);
    g.box(1, 1, 21, 12, 1, 2, P.WATER);
    for (let x = 2; x < 13; x += 2) g.set(x, 2, 20, P.METAL_D);
    // barrel-vaulted evaporator halls with blue stripes and steam vents
    for (const hx of [1, 8]) {
      K.block(g, hx, 0, 1, 6, 6, 15, { wall: P.WHITE, win: P.WIN_COOL, ribbon: true, floorH: 6, winH: 1, y0: 4, top: 1, faces: 'sew', bands: [[2, P.BLUE]] });
      g.hcyl('z', 1, 15, 6, hx + 3, 3, (a) => (a % 4 === 1 ? P.STEEL_BLUE : P.WHITE));
      K.door(g, 's', hx + 2, 1, 15, 2, 3, P.METAL_D);
      g.box(hx + 2, 9, 5, 2, 1, 2, P.METAL);
      g.emit(hx + 3, 10.5, 6, 'steam', 0.7);
      g.box(hx + 2, 9, 11, 2, 1, 2, P.METAL);
      g.emit(hx + 3, 10.5, 12, 'steam', 0.7);
      // intake pipes
      g.hcyl('z', 16, 5, 1.5, hx + 3, 1.1, P.STEEL_BLUE);
    }
    // storage tanks
    const tanks = v ? [[18.5, 4], [18.5, 10]] : [[18, 3.5], [21.5, 8], [18, 12.5]];
    for (const [tx, tz] of tanks) {
      const r = v ? 3 : 2.4;
      g.cyl(tx, 1, tz, r, 8, P.TANK_WHITE);
      g.cyl(tx, 5, tz, r + 0.05, 1, P.BLUE);
      K.dome(g, tx, 9, tz, r, P.TANK_WHITE, 1.6);
      g.set(Math.floor(tx), 10, Math.floor(tz), P.METAL);
    }
    // pipe rack: posts + three pipes running to the tanks
    for (const x of [7, 14, 18, 22]) g.box(x, 1, 16, 1, 6, 1, P.METAL_D);
    g.box(14, 7, 16, 9, 1, 1, P.METAL_D);
    g.box(1, 6, 17, 22, 1, 1, P.PIPE);
    g.box(1, 5, 18, 22, 1, 1, P.STEEL_BLUE);
    for (let x = 14; x < 23; x += 4) g.box(x, 1, 18, 1, 4, 1, P.METAL_D);
    // control building
    K.block(g, 15, 0, 19, 8, 5, 4, { wall: P.PLASTER_SKY, win: P.WIN_COOL, floorH: 5, winH: 2, y0: 2, roof: P.ROOF_BLUE, faces: 'se' });
    K.door(g, 's', 17, 1, 22, 1, 3, P.GLASS_BLUE);
    drop(g, 's', 21, 1, 23, P.BLUE);
    K.lamp(g, 14, 1, 22, 4, P.LAMP_WHITE);
    return K.fit(g);
  },
});
