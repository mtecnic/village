/*
 * VOXELPOLIS — civic models: POWER PLANTS.
 * coal_plant, gas_plant, wind_turbine (+ part 'wind_turbine_rotor'), solar_farm,
 * nuclear_plant, fusion_plant (+ parts 'fusion_ring', 'fusion_ring_inner').
 * Helpers: VC.civicKit (models/civic.js). Front/entrance faces +Z.
 */
const P = VC.P, K = VC.civicKit;

/* ------------------------------------------------------------------ */
/* shared plant pieces                                                  */
/* ------------------------------------------------------------------ */
/** Striped industrial chimney: base plinth, shaft, walkway, sooty hollow top, smoke + beacon. */
function chimney(g, cx, cz, h, r = 2, stripe = P.CHIMNEY_RED, emit = 'smoke') {
  g.cyl(cx, 0, cz, r + 0.7, 3, P.CONCRETE_D);
  for (let y = 3; y < h; y++) {
    const rr = r - (0.45 * (y - 3)) / h;
    const top = h - y;
    const col = top <= 12 ? ((top >> 2) & 1 ? P.WHITE : stripe) : P.CHIMNEY;
    g.cyl(cx, y, cz, rr, 1, col);
  }
  K.ring(g, cx, h - 14, cz, r - 0.2, r + 0.7, 1, P.METAL_D);
  g.cyl(cx, h - 1, cz, r - 1.1, 1, P.BLACK);
  g.emit(cx, h + 0.5, cz, emit, 1.5);
  K.beacon(g, Math.floor(cx + r - 0.6), h - 1, Math.floor(cz));
}
/** Electrical transformer: dark box with blue cooling fins and white insulators. */
function transformer(g, x, y, z) {
  g.box(x, y, z, 2, 3, 3, P.METAL_D);
  g.box(x - 1, y, z + 1, 1, 2, 1, P.STEEL_BLUE);
  g.box(x + 2, y, z + 1, 1, 2, 1, P.STEEL_BLUE);
  g.set(x, y + 3, z, P.WHITE); g.set(x + 1, y + 3, z + 1, P.WHITE); g.set(x, y + 3, z + 2, P.WHITE);
  g.set(x, y + 4, z, P.WHITE); g.set(x + 1, y + 4, z + 1, P.WHITE); g.set(x, y + 4, z + 2, P.WHITE);
}
/** Substation gantry: two posts and a beam with hanging insulators. */
function gantry(g, x0, x1, z, h) {
  g.box(x0, 1, z, 1, h, 1, P.METAL);
  g.box(x1, 1, z, 1, h, 1, P.METAL);
  g.box(x0, h + 1, z, x1 - x0 + 1, 1, 1, P.METAL);
  for (let x = x0 + 2; x < x1; x += 2) g.set(x, h, z, P.WHITE);
}

/* ------------------------------------------------------------------ */
/* coal_plant (3x3)                                                     */
/* ------------------------------------------------------------------ */
VC.models.define('coal_plant', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(3, 3, 64);
    K.lot(g, P.CONCRETE);
    g.box(0, 0, 22, 24, 1, 2, P.GRASS);
    g.box(14, 0, 11, 3, 1, 13, P.ASPHALT);
    for (let z = 12; z < 24; z += 3) g.set(15, 0, z, P.ROAD_MARK);
    // rail siding with coal hoppers
    g.box(0, 0, 0, 3, 1, 24, P.STONE_D);
    for (let z = 0; z < 24; z += 2) g.box(0, 1, z, 3, 1, 1, P.WOOD_D);
    g.box(0, 1, 0, 1, 1, 24, P.METAL); g.box(2, 1, 0, 1, 1, 24, P.METAL);
    for (const hz of v ? [2, 9] : [2, 9, 16]) {
      g.box(0, 2, hz, 3, 3, 6, P.RUST);
      g.box(0, 2, hz, 3, 1, 6, P.METAL_D);
      g.box(0, 5, hz + 1, 3, 1, 4, P.BLACK);
    }
    // turbine hall: brick, tall arched windows, gable roof
    K.block(g, 3, 0, 2, 9, 10, 10, { wall: P.BRICK, win: P.WIN, winH: 5, floorH: 9, y0: 2, gap: 1, base: P.CONCRETE_D, faces: 'sew' });
    g.roofGable(3, 10, 2, 9, 10, P.ROOF_GREY, 'x');
    g.box(3, 9, 2, 9, 1, 10, P.BRICK_D);
    // boiler house
    K.block(g, 12, 0, 1, 8, 20, 10, { wall: P.BRICK_D, win: P.WIN, floorH: 5, winH: 2, gap: 2, roof: P.ROOF_BLACK, parapet: P.CONCRETE_D, base: P.CONCRETE_D });
    K.door(g, 's', 14, 1, 10, 3, 5, P.METAL_D);
    g.box(14, 6, 10, 3, 1, 1, P.HAZARD_Y);
    g.box(14, 20, 3, 2, 3, 2, P.METAL); g.box(17, 20, 6, 2, 2, 2, P.METAL_D);
    g.emit(15, 23.5, 4, 'steam', 0.6);
    // chimneys
    chimney(g, 21.5, 3.5, 50);
    chimney(g, 21.5, 9.5, 46);
    if (v === 1) chimney(g, 21.5, 15.5, 42);
    // coal piles with a dozer, covered conveyor gallery rising to the boiler house
    g.ellipsoid(7, 0.5, 16.5, 4, 3.6, 3.4, P.BLACK);
    g.ellipsoid(8, 0.5, 20.5, 3.2, 2.4, 2.4, P.BLACK);
    g.ellipsoid(4.5, 0.5, 21, 1.6, 1.5, 1.6, P.CONCRETE_DD);
    K.vehicle(g, 'bulldozer', 8, 3, 18, 1);
    g.box(11, 0, 20, 3, 4, 3, P.CONCRETE_D);
    for (let z = 20; z >= 11; z--) {
      const y = Math.round(3 + ((20 - z) * 12) / 9);
      g.box(12, y, z, 2, 2, 1, P.CONCRETE_L);
      g.box(12, y + 2, z, 2, 1, 1, P.ROOF_GREY);
    }
    g.box(12, 1, 16, 1, 6, 1, P.METAL_D); g.box(13, 1, 16, 1, 6, 1, P.METAL_D);
    g.box(12, 1, 13, 2, 9, 1, P.METAL_D);
    // transformer yard
    const tz = v ? 18 : 13, td = v ? 5 : 8;
    g.box(17, 0, tz, 7, 1, td, P.CONCRETE_D);
    K.fence(g, 17, tz, 23, tz + td - 1, 1, P.METAL_D, { h: 2 });
    transformer(g, 19, 1, tz + 1);
    if (!v) transformer(g, 19, 1, tz + 4);
    gantry(g, 17, 23, tz + td - 1, 6);
    K.lamp(g, 13, 1, 22, 5, P.LAMP_WHITE);
    K.lamp(g, 17, 1, 11, 5, P.LAMP_WHITE);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* gas_plant (2x2)                                                      */
/* ------------------------------------------------------------------ */
VC.models.define('gas_plant', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(2, 2, 40);
    K.lot(g, P.CONCRETE_L);
    g.box(0, 0, 14, 16, 1, 2, P.GRASS);
    g.box(5, 0, 9, 3, 1, 7, P.ASPHALT);
    for (let z = 10; z < 16; z += 2) g.set(6, 0, z, P.ROAD_MARK);
    // turbine hall
    K.block(g, 1, 0, 1, 8, 8, 8, {
      wall: P.CONCRETE_L, win: P.WIN_COOL, ribbon: true, y0: 4, winH: 1, floorH: 8, top: 2,
      bands: [[6, P.STEEL_BLUE], [7, P.STEEL_BLUE]], roof: P.ROOF_GREY, faces: 'sw',
    });
    K.door(g, 's', 5, 1, 8, 3, 3, P.METAL_D);
    g.box(2, 8, 2, 2, 1, 2, P.METAL); g.box(5, 8, 5, 2, 1, 2, P.METAL);
    // heat recovery boiler + exhaust stacks
    K.block(g, 9, 0, 1, 6, 11, 6, { wall: P.METAL_D, noWin: true, roof: P.STEEL_BLUE });
    for (let x = 10; x < 15; x += 2) g.box(x, 1, 7, 1, 9, 1, P.METAL);
    const stacks = v ? [[11, 3.5], [14, 3.5]] : [[12.5, 3.5]];
    for (const [sx, sz] of stacks) {
      g.cyl(sx, 11, sz, 1.4, 16, P.METAL);
      K.ring(g, sx, 17, sz, 0.5, 1.8, 1, P.METAL_D);
      K.ring(g, sx, 25, sz, 0.5, 1.8, 1, P.CHIMNEY_RED);
      g.set(Math.floor(sx), 26, Math.floor(sz), P.BLACK);
      g.emit(sx, 27.5, sz, 'steam', 1);
    }
    K.beacon(g, Math.floor(stacks[0][0]) + 1, 26, 3);
    // gas storage: spherical tank(s) on legs
    const sph = v ? [[12.5, 11.5, 2.9], [2.5, 12, 2.4]] : [[12.5, 11.5, 2.9]];
    for (const [cx, cz, r] of sph) {
      for (const [lx, lz] of [[-2, -2], [1, -2], [-2, 1], [1, 1]]) g.box(Math.floor(cx) + lx, 1, Math.floor(cz) + lz, 1, 3, 1, P.METAL_D);
      g.sphere(cx, 3 + r, cz, r, P.TANK_WHITE);
      K.ring(g, cx, 3 + Math.round(r), cz, r - 0.7, r + 0.2, 1, P.STEEL_BLUE);
    }
    if (!v) {
      // horizontal bullet tank on saddles
      g.box(1, 1, 10, 3, 2, 1, P.CONCRETE_D); g.box(1, 1, 13, 3, 2, 1, P.CONCRETE_D);
      g.hcyl('z', 9, 6, 3.5, 2.5, 1.7, P.TANK_WHITE);
      g.hcyl('z', 11, 1, 3.5, 2.5, 1.8, P.STEEL_BLUE);
    }
    // pipes & valves
    g.box(9, 4, 8, 4, 1, 1, P.PIPE);
    g.box(12, 4, 8, 1, 4, 1, P.PIPE);
    g.set(10, 5, 8, P.HAZARD_Y);
    g.box(2, 6, 8, 3, 1, 1, P.PIPE);
    g.set(2, 5, 8, P.PIPE);
    K.lamp(g, 8, 1, 14, 4, P.LAMP_WHITE);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* wind_turbine (1x1) + rotor part                                      */
/* ------------------------------------------------------------------ */
const ROTOR_R = 26; // blade length (voxels)
const HUB_Y = 66;
VC.models.define('wind_turbine_rotor', {
  gen() {
    const S = ROTOR_R * 2 + 2, c = ROTOR_R + 1;
    const g = new VC.VoxelGrid(S, S, 3);
    for (let b = 0; b < 3; b++) {
      const a = Math.PI / 2 + (b * Math.PI * 2) / 3, dx = Math.cos(a), dy = Math.sin(a);
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const px = x + 0.5 - c, py = y + 0.5 - c;
          const t = px * dx + py * dy, q = Math.abs(-px * dy + py * dx);
          if (t < 1 || t > ROTOR_R) continue;
          // chord: wide near the root, tapering to the tip, slight airfoil offset
          const hw = t < 6 ? 0.75 + t * 0.09 : 1.3 - ((t - 6) / (ROTOR_R - 6)) * 0.75;
          if (q <= hw) g.set(x, y, 0, t > ROTOR_R - 2.5 ? P.RED : P.WHITE);
        }
    }
    g.box(c - 1, c - 1, 0, 2, 2, 2, P.WHITE);
    g.box(c - 2, c - 1, 0, 1, 2, 1, P.WHITE); g.box(c + 1, c - 1, 0, 1, 2, 1, P.WHITE);
    g.box(c - 1, c - 2, 0, 2, 1, 1, P.WHITE); g.box(c - 1, c + 1, 0, 2, 1, 1, P.WHITE);
    g.box(c - 1, c - 1, 2, 2, 2, 1, P.CONCRETE_L);
    return g;
  },
});
VC.models.define('wind_turbine', {
  variants: 2,
  parts: [{ model: 'wind_turbine_rotor', pivot: [4, HUB_Y, 7], partPivot: [ROTOR_R + 1, ROTOR_R + 1, 0], axis: 'z', speed: 1.8, anim: 'wind' }],
  gen(rng, v) {
    const g = new VC.VoxelGrid(8, HUB_Y + 6, 8);
    g.cyl(4, 0, 4, 3.6, 1, P.CONCRETE_L);
    g.box(5, 1, 0, 3, 2, 2, P.METAL_D);
    g.set(6, 1, 2, P.HAZARD_Y);
    const top = HUB_Y - 2;
    for (let y = 1; y < top; y++) {
      const r = 1.95 - (0.95 * y) / top;
      let col = P.WHITE;
      if (v === 1 && y < 13) col = y < 4 ? P.GREEN : y < 8 ? (y & 1 ? P.GRASS_L : P.GREEN) : y === 10 ? P.GRASS_L : P.WHITE;
      if (v === 0 && (y === 2 || y === 3)) col = P.CONCRETE;
      g.cyl(4, y, 4, r, 1, col);
    }
    K.door(g, 's', 3, 1, 5, 2, 2, P.GREY);
    // nacelle: 4x4 box from the tower top toward the rotor (+Z)
    g.box(2, HUB_Y - 2, 1, 4, 4, 6, P.WHITE);
    g.box(2, HUB_Y + 1, 1, 4, 1, 2, P.CONCRETE_L);
    g.box(3, HUB_Y + 2, 1, 1, 1, 1, P.METAL_D);
    g.box(2, HUB_Y - 2, 1, 4, 1, 1, P.CONCRETE);
    K.beacon(g, 4, HUB_Y + 2, 2);
    return g;
  },
});

/* ------------------------------------------------------------------ */
/* solar_farm (3x3)                                                     */
/* ------------------------------------------------------------------ */
VC.models.define('solar_farm', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(3, 3, 16);
    K.lot(g, P.GRASS);
    g.box(0, 0, 20, 24, 1, 2, P.CONCRETE_D);
    g.box(10, 0, 22, 4, 1, 2, P.CONCRETE_D);
    // panel rows: tilted toward the front, module seams every 5 voxels
    const rows = [1, 6, 11, 16];
    rows.forEach((z0, ri) => {
      const x1 = ri < 2 ? 23 : 17;
      for (let x = 1; x < x1; x++) {
        const seam = (x - 1) % 5 === 4;
        for (let i = 0; i < 4; i++) g.set(x, 1 + (3 - i), z0 + i, seam ? P.METAL : P.SOLAR);
        if ((x - 1) % 5 === 2) g.box(x, 1, z0, 1, 3, 1, P.METAL_D);
      }
    });
    if (v === 0) {
      // control building + inverter
      K.block(g, 18, 0, 11, 5, 5, 6, { wall: P.WHITE, win: P.WIN_COOL, floorH: 5, winH: 1, y0: 3, roof: P.STEEL_BLUE, faces: 'sw' });
      K.door(g, 's', 20, 1, 16, 1, 3, P.STEEL_BLUE);
      g.box(19, 5, 12, 2, 1, 2, P.METAL);
      transformer(g, 20, 1, 17);
    } else {
      // battery storage containers with status LEDs
      for (let k = 0; k < 2; k++) {
        const x = 18 + k * 3;
        g.box(x, 1, 11, 2, 3, 7, P.WHITE);
        g.box(x, 4, 11, 2, 1, 7, P.CONCRETE_L);
        for (let z = 12; z < 18; z += 2) g.set(x + 1, 2, z, P.NEON_GREEN);
      }
    }
    K.fence(g, 0, 0, 23, 23, 1, P.METAL_D, { h: 2, step: 3, skip: (x, z) => z === 23 && x >= 10 && x <= 13 });
    K.lamp(g, 9, 1, 22, 4, P.LAMP_WHITE);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* nuclear_plant (4x4)                                                  */
/* ------------------------------------------------------------------ */
/** Hyperboloid cooling tower (hollow, open colonnade base, pond inside). */
function coolingTower(g, cx, cz, H, r0 = 7.4, waist = 4.5) {
  const yw = H * 0.76, c = yw / Math.sqrt((r0 / waist) ** 2 - 1);
  for (let y = 0; y < H; y++) {
    const r = Math.round(waist * Math.sqrt(1 + ((y - yw) / c) ** 2) * 3) / 3; // quantized: cleaner voxel rings
    const col = y >= H - 2 || y === H - 5 ? P.CONCRETE : P.CONCRETE_L;
    if (y === 0) continue;
    if (y < 3) K.ring(g, cx, y, cz, r - 1.3, r, 1, (x, yy, z, a) => (Math.floor(((a + Math.PI) / Math.PI) * 10) & 1 ? P.CONCRETE_D : 0));
    else K.ring(g, cx, y, cz, r - 1.25, r, 1, col);
  }
  g.cyl(cx, 0, cz, r0 - 1.6, 1, P.WATER);
  const rt = waist * Math.sqrt(1 + ((H - 1 - yw) / c) ** 2);
  g.emit(cx - 1.2, H + 0.5, cz, 'steam', 2);
  g.emit(cx + 1.2, H + 0.5, cz + 1, 'steam', 2);
  K.beacon(g, Math.floor(cx + rt - 0.7), H - 1, Math.floor(cz));
}
VC.models.define('nuclear_plant', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(4, 4, 56);
    K.lot(g, P.CONCRETE_L);
    g.box(0, 0, 0, 32, 1, 1, P.GRASS); g.box(0, 0, 0, 1, 1, 32, P.GRASS); g.box(31, 0, 0, 1, 1, 32, P.GRASS);
    g.box(0, 0, 30, 32, 1, 2, P.GRASS);
    g.box(12, 0, 25, 4, 1, 7, P.ASPHALT);
    // cooling towers
    coolingTower(g, 8, 8.5, v ? 30 : 33);
    coolingTower(g, 24, 8.5, 33);
    // reactor containment: cylinder + dome, glowing band, trefoil sign
    const rx = 8, rz = 22.5;
    g.cyl(rx, 1, rz, 5.6, 10, P.CONCRETE_L);
    K.ring(g, rx, 10, rz, 4.8, 5.8, 1, P.GLOW_REACTOR);
    K.dome(g, rx, 11, rz, 5.6, P.MARBLE, 5.2);
    g.box(rx - 1, 16, rz - 1, 2, 1, 2, P.METAL);
    g.box(6, 3, 28, 5, 5, 1, P.HAZARD_Y);
    for (const [px, py] of [[6, 7], [7, 7], [9, 7], [10, 7], [6, 6], [7, 6], [9, 6], [10, 6], [8, 5], [7, 4], [8, 4], [9, 4], [7, 3], [8, 3], [9, 3]]) g.set(px, py, 28, P.HAZARD_B);
    // corridor + turbine hall
    g.box(13, 1, 20, 4, 6, 4, P.CONCRETE);
    K.block(g, 16, 0, 17, 15, 11, 10, {
      wall: P.CONCRETE_L, win: P.WIN_COOL, ribbon: true, floorH: 11, winH: 2, y0: 6, top: 2,
      bands: [[8, P.STEEL_BLUE], [9, P.STEEL_BLUE]], roof: P.ROOF_GREY, parapet: P.STEEL_BLUE,
    });
    K.door(g, 's', 20, 1, 26, 4, 4, P.METAL_D);
    K.roofJunk(g, 16, 11, 17, 15, 10, rng, 4, 'av');
    // offices at the front + transformer yard
    K.block(g, 18, 0, 27, 7, 5, 3, { wall: P.WHITE, win: P.WIN_OFFICE, ribbon: true, floorH: 5, winH: 2, y0: 1, roof: P.CONCRETE, faces: 's' });
    g.box(26, 0, 27, 5, 1, 3, P.CONCRETE_D);
    transformer(g, 27, 1, 27);
    gantry(g, 26, 30, 27, 5);
    // fence with hazard gate
    K.fence(g, 0, 0, 31, 31, 1, P.METAL_D, { h: 2, step: 3, skip: (x, z) => z === 31 && x >= 12 && x <= 15 });
    K.hazard(g, 11, 1, 31, 1, 3, 1);
    K.hazard(g, 16, 1, 31, 1, 3, 1);
    g.box(12, 3, 31, 4, 1, 1, (x) => (x & 1 ? P.RED : P.WHITE));
    K.lamp(g, 11, 1, 29, 5, P.LAMP_WHITE);
    K.lamp(g, 17, 1, 25, 5, P.LAMP_WHITE);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* fusion_plant (4x4) + two spinning containment rings                   */
/* ------------------------------------------------------------------ */
const FC = [16, 15, 18]; // plasma core center (parent voxels)
VC.models.define('fusion_ring', {
  gen() {
    const R = 10.6, S = 26, c = 13;
    const g = new VC.VoxelGrid(S, 5, S);
    for (let y = 0; y < 5; y++)
      for (let z = 0; z < S; z++)
        for (let x = 0; x < S; x++) {
          const dx = x + 0.5 - c, dz = z + 0.5 - c, dy = y + 0.5 - 2.5;
          const q = Math.hypot(dx, dz) - R;
          const seg = Math.floor(((Math.atan2(dz, dx) + Math.PI) / (Math.PI * 2)) * 24) % 24;
          const coil = seg % 4 === 0;
          const rr = coil ? 2.2 : 1.45;
          if (q * q + dy * dy > rr * rr) continue;
          g.set(x, y, z, coil ? (Math.abs(dy) > 1.5 ? P.CHROME : P.METAL_D) : seg % 4 === 2 ? P.NEON_CYAN : P.GLOW_REACTOR);
        }
    return g;
  },
});
VC.models.define('fusion_ring_inner', {
  gen() {
    const R = 6.4, g = new VC.VoxelGrid(18, 18, 3);
    for (let z = 0; z < 3; z++)
      for (let y = 0; y < 18; y++)
        for (let x = 0; x < 18; x++) {
          const dx = x + 0.5 - 9, dy = y + 0.5 - 9, dz = z + 0.5 - 1.5;
          const q = Math.hypot(dx, dy) - R;
          if (q * q + dz * dz > 1.35) continue;
          const seg = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2)) * 12) % 12;
          g.set(x, y, z, seg % 3 === 0 ? P.CHROME : P.NEON_PURPLE);
        }
    return g;
  },
});
VC.models.define('fusion_plant', {
  variants: 1,
  parts: [
    { model: 'fusion_ring', pivot: FC, partPivot: [13, 2.5, 13], axis: 'y', speed: 0.6 },
    { model: 'fusion_ring_inner', pivot: FC, partPivot: [9, 9, 1.5], axis: 'y', speed: -1.3 },
  ],
  gen(rng) {
    const g = K.grid(4, 4, 32);
    const [cx, cy, cz] = FC;
    K.lot(g, P.CONCRETE_L);
    g.box(0, 0, 30, 32, 1, 2, P.GRASS_L);
    g.box(13, 0, 29, 6, 1, 3, P.WHITE);
    // research / containment building at the back
    K.block(g, 1, 0, 1, 30, 10, 6, { wall: P.WHITE, win: P.WIN_OFFICE, ribbon: true, floorH: 4, winH: 2, y0: 2, top: 2, roof: P.CONCRETE_L, faces: 'sew' });
    g.box(1, 9, 1, 30, 1, 6, P.CHROME);
    g.box(1, 8, 7, 30, 1, 1, P.NEON_CYAN);
    K.dome(g, 7, 10, 4, 2.6, P.CHROME, 2.4);
    K.dome(g, 25, 10, 4, 2.6, P.CHROME, 2.4);
    // podium with glowing ring
    g.cyl(cx, 0, cz, 11.5, 1, P.CONCRETE);
    g.cyl(cx, 1, cz, 10.2, 1, P.METAL_D);
    K.ring(g, cx, 2, cz, 8.4, 9.4, 1, P.NEON_CYAN);
    g.cyl(cx, 2, cz, 8.4, 1, P.CHROME);
    g.cyl(cx, 3, cz, 3, 1, P.METAL_D);
    g.cyl(cx, 4, cz, 2, 2, P.CHROME);
    g.cyl(cx, 6, cz, 1, 1, P.NEON_CYAN);
    // plasma core
    g.sphere(cx, cy, cz, 3.2, P.GLOW_REACTOR);
    g.sphere(cx, cy, cz, 2.0, P.SIGN_WHITE);
    g.light(cx, cy, cz, K.LC.cyan, 3, true);
    g.emit(cx, cy + 3.5, cz, 'sparkle', 1.5);
    // energy conduits to four pylons
    const pyl = [[5, 8], [26, 8], [5, 27], [26, 27]];
    for (const [px, pz] of pyl) {
      K.beam(g, px, 0, pz, cx, 0, cz, P.NEON_CYAN);
      g.box(px - 2, 0, pz - 2, 4, 1, 4, P.CONCRETE_D);
      g.box(px - 1, 1, pz - 1, 2, 18, 2, P.METAL_D);
      for (let y = 5; y < 18; y += 5) g.box(px - 2, y, pz - 2, 4, 1, 4, P.CHROME);
      g.box(px - 1, 19, pz - 1, 2, 2, 2, P.NEON_CYAN);
      g.light(px, 20.5, pz, K.LC.cyan, 1.4, true);
      g.emit(px, 21.5, pz, 'sparkle', 0.6);
    }
    // capacitor banks
    for (const [bx, bz] of [[2.5, 26], [29.5, 26]]) {
      g.cyl(bx, 1, bz, 1.6, 4, P.CHROME);
      g.cyl(bx, 5, bz, 1.0, 1, P.NEON_CYAN);
    }
    K.lamp(g, 12, 1, 29, 4, P.LAMP_WHITE);
    K.lamp(g, 19, 1, 29, 4, P.LAMP_WHITE);
    return K.fit(g);
  },
});
