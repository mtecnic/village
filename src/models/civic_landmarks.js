/*
 * VOXELPOLIS — civic models: LANDMARKS (part 1).
 * city_hall, statue, monument, ferris_wheel (+ part 'ferris_wheel_wheel'), casino, stadium.
 * Helpers: VC.civicKit (models/civic.js). Front/entrance faces +Z.
 */
const P = VC.P, K = VC.civicKit;

/* ------------------------------------------------------------------ */
/* city_hall (3x3)                                                      */
/* ------------------------------------------------------------------ */
VC.models.define('city_hall', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(3, 3, 40);
    const domeC = v ? P.COPPER_GREEN : P.GOLD;
    K.lot(g, P.GRASS);
    g.box(0, 0, 17, 24, 1, 7, P.SIDEWALK);
    g.box(10, 0, 19, 4, 1, 5, P.MARBLE);
    // podium + main hall
    g.box(2, 0, 2, 20, 2, 15, P.STONE);
    K.block(g, 3, 2, 3, 18, 9, 12, { wall: P.MARBLE, win: P.WIN, floorH: 4, winH: 3, gap: 2, y0: 1, faces: 'swen', bands: [[8, P.WHITE]] });
    g.box(2, 11, 2, 20, 1, 14, P.WHITE);
    g.box(4, 12, 4, 16, 1, 10, P.MARBLE);
    K.door(g, 's', 11, 2, 14, 2, 5, P.WOOD_D);
    // portico: six columns, entablature, pediment with clock, grand steps
    g.box(5, 0, 15, 14, 2, 4, P.STONE);
    for (const cx of [6, 8, 10, 13, 15, 17]) { g.box(cx, 2, 17, 1, 9, 1, P.MARBLE); g.set(cx, 10, 17, P.WHITE); }
    g.box(5, 11, 15, 14, 1, 4, P.WHITE);
    K.pediment(g, 5, 12, 15, 14, P.MARBLE, 4, 2);
    K.clock(g, 's', 11, 13, 19, 1.5, P.GOLD, P.WHITE, P.BLACK);
    K.steps(g, 5, 0, 19, 14, 2, P.MARBLE);
    // drum with colonnade windows, cornice, dome, lantern, flag
    const dx = 12, dz = 9;
    K.ring(g, dx, 12, dz, 3.5, 5, 4, (x, y, z, a) => (y === 12 || y === 15 ? P.MARBLE : Math.floor(((a + Math.PI) / (Math.PI * 2)) * 20) & 1 ? P.WIN : P.MARBLE));
    g.cyl(dx, 12, dz, 3.5, 4, P.MARBLE);
    g.cyl(dx, 16, dz, 5.6, 1, P.WHITE);
    K.dome(g, dx, 17, dz, 5.1, (x, y, z) => {
      const a = Math.atan2(z + 0.5 - dz, x + 0.5 - dx) / (Math.PI / 4);
      return Math.abs(a - Math.round(a)) < 0.12 && y < 21 ? P.WHITE : domeC;
    }, 5.4);
    g.cyl(dx, 22, dz, 1.4, 3, P.MARBLE);
    K.dome(g, dx, 25, dz, 1.5, P.GOLD, 1.5);
    g.box(12, 26, 9, 1, 5, 1, P.WHITE);
    for (let k = 1; k <= 3; k++) { g.set(12 + k, 30, 9, P.BLUE); g.set(12 + k, 29, 9, P.YELLOW); }
    // flags, lamps, hedged lawns, trees
    K.flag(g, 3, 1, 20, 11, [P.BLUE, P.YELLOW]);
    K.flag(g, 20, 1, 20, 11, [P.RED, P.WHITE]);
    for (const lx of [8, 15]) K.lamp(g, lx, 1, 22, 5);
    g.box(0, 1, 17, 4, 1, 1, P.HEDGE); g.box(20, 1, 17, 4, 1, 1, P.HEDGE);
    for (const z of [3, 8, 13]) { K.tree(g, 0, 1, z, 'cypress', 1); K.tree(g, 23, 1, z, 'cypress', 1); }
    K.flowers(g, 4, 1, 22, 4, 1, [P.FLOWER_R]);
    K.flowers(g, 16, 1, 22, 4, 1, [P.FLOWER_Y]);
    // warm floodlighting of the facade at night
    for (const lx of [7, 12, 16]) g.light(lx, 6, 19.5, K.LC.warm, 1.4);
    g.light(12, 20, 9, K.LC.yellow, 2.2);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* statue (1x1) — the Mayor, in gold (or green patina with a torch)     */
/* ------------------------------------------------------------------ */
VC.models.define('statue', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(1, 1, 22);
    const S = v ? P.COPPER_GREEN : P.GOLD;
    K.lot(g, P.SIDEWALK);
    for (const [hx, hz] of [[0, 0], [6, 0], [0, 6], [6, 6]]) g.box(hx, 1, hz, 2, 1, 2, P.HEDGE);
    g.set(0, 2, 7, P.FLOWER_R); g.set(7, 2, 7, P.FLOWER_Y);
    // plinth
    g.box(1, 1, 1, 6, 1, 6, P.MARBLE);
    g.box(2, 2, 2, 4, 4, 4, P.STONE);
    g.box(2, 6, 2, 4, 1, 4, P.MARBLE);
    g.box(3, 3, 6, 2, 2, 1, S);
    // figure: striding legs, coat, arms, head, top hat
    g.box(3, 7, 4, 1, 3, 1, S); g.box(4, 7, 3, 1, 3, 1, S);
    g.box(3, 10, 3, 2, 3, 2, S);
    g.box(2, 12, 3, 4, 1, 2, S);
    g.box(2, 9, 3, 1, 3, 1, S);
    g.box(3, 13, 3, 2, 2, 2, S);
    if (v) {
      // raised torch
      g.set(5, 13, 3, S); g.set(5, 14, 3, S); g.set(5, 15, 3, S); g.set(5, 16, 3, S);
      g.set(5, 17, 3, P.FIRE);
      g.light(5.5, 17.8, 3.5, K.LC.orange, 1.2, true);
      g.emit(5.5, 18, 3.5, 'fire', 0.3);
      g.box(3, 15, 3, 2, 1, 2, S); g.set(3, 16, 3, S); g.set(4, 16, 4, S);
    } else {
      // pointing proudly toward the future
      g.set(5, 12, 4, S); g.set(5, 13, 5, S); g.set(5, 14, 6, S);
      g.box(2, 15, 3, 4, 1, 2, S);
      g.box(3, 16, 3, 2, 2, 2, S);
      g.emit(4, 18.5, 4, 'sparkle', 0.4);
    }
    // uplights
    g.set(1, 1, 7, P.LAMP); g.set(6, 1, 7, P.LAMP);
    g.light(4, 9, 6.5, K.LC.warm, 1.4);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* monument (2x2) — Grand Obelisk with reflecting pool                  */
/* ------------------------------------------------------------------ */
VC.models.define('monument', {
  variants: 1,
  gen(rng) {
    const g = K.grid(2, 2, 60);
    K.lot(g, P.GRASS);
    g.box(3, 0, 0, 10, 1, 16, P.SIDEWALK);
    // stepped base, shaft (chamfered upper half), golden pyramidion, beacon
    g.box(3, 1, 1, 10, 1, 8, P.STONE_D);
    g.box(4, 2, 2, 8, 1, 6, P.STONE);
    g.box(5, 3, 3, 6, 1, 4, P.MARBLE);
    g.box(6, 4, 3, 4, 44, 4, P.MARBLE);
    for (let y = 26; y < 48; y++) for (const [cx, cz] of [[6, 3], [9, 3], [6, 6], [9, 6]]) g.set(cx, y, cz, 0);
    g.box(6, 3, 7, 4, 2, 1, P.GOLD);
    g.box(6, 48, 3, 4, 1, 4, P.GOLD);
    g.box(7, 49, 4, 2, 2, 2, P.GOLD);
    K.beacon(g, 7, 51, 4, 0.8);
    // reflecting pool
    K.pool(g, 4, 1, 9, 8, 6, P.MARBLE, P.WATER, 2);
    // lamps, cypress rows, uplights
    for (const [lx, lz] of [[3, 9], [12, 9], [3, 15], [12, 15]]) K.lamp(g, lx, 1, lz, 4);
    for (const z of [2, 6, 10, 14]) { K.tree(g, 1, 1, z, 'cypress', 0.9); K.tree(g, 14, 1, z, 'cypress', 0.9); }
    for (const [ux, uz] of [[5, 8], [10, 8]]) { g.set(ux, 1, uz, P.LAMP); g.light(ux + 0.5, 14, uz - 1.5, K.LC.warm, 1.6); }
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* ferris_wheel (3x3) + rotating wheel part                             */
/* ------------------------------------------------------------------ */
const FW_R = 10; // rim radius (voxels); rim + gondolas stay inside the 24-voxel footprint
const FW_C = 13; // wheel center in the part grid (y and z)
const FW_HUB = [12, 15, 12]; // hub in the parent grid
VC.models.define('ferris_wheel_wheel', {
  gen() {
    const S = FW_C * 2, g = new VC.VoxelGrid(6, S, S);
    const neon = [P.NEON_PINK, P.NEON_CYAN, P.NEON_YELLOW, P.NEON_PURPLE];
    const pods = [P.RED, P.BLUE, P.YELLOW, P.GREEN, P.ORANGE, P.PURPLE, P.PINK, P.CAR_WHITE];
    for (const x of [0, 5]) {
      for (let y = 0; y < S; y++)
        for (let z = 0; z < S; z++) {
          const dy = y + 0.5 - FW_C, dz = z + 0.5 - FW_C, d = Math.hypot(dy, dz);
          if (d > FW_R - 0.6 && d <= FW_R + 0.4) {
            const a = Math.atan2(dy, dz);
            g.set(x, y, z, Math.floor(((a + Math.PI) / (Math.PI * 2)) * 48) % 3 === 0 ? P.NEON_YELLOW : P.WHITE);
          }
        }
      // glowing spokes
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        for (let t = 2; t < FW_R - 0.5; t += 0.5) g.set(x, Math.floor(FW_C + sa * t), Math.floor(FW_C + ca * t), neon[k % 4]);
      }
    }
    // hub
    g.hcyl('x', 0, 6, FW_C, FW_C, 2.1, P.CHROME);
    g.hcyl('x', 0, 6, FW_C, FW_C, 1.0, P.NEON_PINK);
    // gondola pods on the rim (rounded, look right at any rotation)
    for (let k = 0; k < 12; k++) {
      const a = ((k + 0.5) / 12) * Math.PI * 2;
      const py = FW_C + Math.sin(a) * (FW_R + 0.5), pz = FW_C + Math.cos(a) * (FW_R + 0.5);
      g.ellipsoid(3, py, pz, 2.3, 1.5, 1.5, pods[k % pods.length]);
      g.box(0, Math.floor(FW_C + Math.sin(a) * FW_R), Math.floor(FW_C + Math.cos(a) * FW_R), 6, 1, 1, P.METAL);
    }
    return g;
  },
});
VC.models.define('ferris_wheel', {
  variants: 1,
  parts: [{ model: 'ferris_wheel_wheel', pivot: FW_HUB, partPivot: [3, FW_C, FW_C], axis: 'x', speed: 0.12 }],
  gen(rng) {
    const g = K.grid(3, 3, 32);
    K.lot(g, P.SIDEWALK);
    g.box(0, 0, 0, 24, 1, 24, (x, y, z) => ((x >> 2) + (z >> 2)) & 1 ? P.SIDEWALK : P.CONCRETE_L);
    // A-frame supports and axle
    const [hx, hy, hz] = FW_HUB;
    for (const lx of [7, 8, 15, 16]) {
      K.beam(g, lx, 1, hz - 8, lx, hy, hz, P.WHITE);
      K.beam(g, lx, 1, hz + 7, lx, hy, hz - 1, P.WHITE);
    }
    for (const lx of [7, 15]) { g.box(lx, 0, hz - 9, 2, 1, 2, P.CONCRETE_D); g.box(lx, 0, hz + 7, 2, 1, 2, P.CONCRETE_D); }
    g.hcyl('x', 6, 12, hy, hz, 1.15, P.CHROME);
    for (const lx of [6, 17]) g.box(lx, hy - 1, hz - 1, 1, 2, 2, P.NEON_PINK);
    g.light(hx, hy, hz, K.LC.pink, 2, true);
    // boarding platform with stairs
    g.box(8, 0, 7, 8, 1, 10, P.WOOD_L);
    g.box(8, 0, 17, 8, 1, 1, P.WOOD);
    for (const rx of [8, 15]) for (let z = 7; z < 17; z++) g.set(rx, 1, z, z & 1 ? P.RED : P.WHITE);
    // ticket booth with striped awning + queue rails
    K.block(g, 1, 1, 18, 4, 4, 4, { wall: P.WHITE, noWin: true });
    g.box(2, 2, 21, 2, 2, 1, P.GLASS_DARK);
    K.awning(g, 0, 5, 17, 6, 6, P.AWNING_R, P.WHITE);
    K.text(g, '*', 3, 6, 20, P.NEON_YELLOW);
    for (const qz of [19, 21]) { g.box(6, 2, qz, 5, 1, 1, P.METAL); g.set(6, 1, qz, P.METAL_D); g.set(10, 1, qz, P.METAL_D); }
    // popcorn stand, balloon cart
    g.box(19, 1, 19, 3, 3, 2, (x, y) => (x & 1 ? P.RED : P.WHITE));
    g.box(19, 4, 19, 3, 1, 2, P.YELLOW);
    g.box(19, 1, 2, 2, 2, 2, P.BLUE);
    for (const [bx, bz, c] of [[19, 2, P.RED], [20, 3, P.YELLOW], [20, 2, P.PINK], [19, 3, P.GREEN]]) { g.box(bx, 3, bz, 1, 2, 1, P.WHITE); g.set(bx, 5 + ((bx + bz) & 1), bz, c); }
    // festoon lights between poles
    const neon = [P.NEON_PINK, P.NEON_YELLOW, P.NEON_CYAN, P.NEON_GREEN];
    const poles = [[1, 1], [22, 1], [22, 22], [1, 22]];
    for (const [px, pz] of poles) { g.box(px, 1, pz, 1, 7, 1, P.METAL_D); g.light(px + 0.5, 8, pz + 0.5, K.LC.pink, 0.8); }
    for (let i = 0; i < 4; i++) {
      const [ax, az] = poles[i], [bx, bz] = poles[(i + 1) % 4];
      const n = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
      for (let t = 1; t < n; t++) {
        const x = Math.round(ax + ((bx - ax) * t) / n), z = Math.round(az + ((bz - az) * t) / n);
        const sag = Math.round(Math.sin((t / n) * Math.PI) * 2);
        g.set(x, 7 - sag, z, t % 2 ? neon[(t >> 1) % 4] : P.METAL_D);
      }
    }
    K.tree(g, 3, 1, 3, 'oak', 1);
    K.tree(g, 21, 1, 9, 'oak', 0.9);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* casino (3x3) — Casino Royale                                         */
/* ------------------------------------------------------------------ */
/** 5x5x5 die with pips on the visible faces (top 5, front 3, east 2). */
function die(g, x, y, z, body, pip) {
  g.box(x, y, z, 5, 5, 5, body);
  for (const [a, b] of [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3]]) g.set(x + a, y + 4, z + b, pip);
  for (const [a, b] of [[1, 3], [2, 2], [3, 1]]) g.set(x + a, y + b, z + 4, pip);
  for (const [a, b] of [[1, 3], [3, 1]]) g.set(x + 4, y + a, z + b, pip);
}
VC.models.define('casino', {
  variants: 1,
  gen(rng) {
    const g = K.grid(3, 3, 56);
    K.lot(g, P.SIDEWALK);
    g.box(8, 0, 17, 8, 1, 7, P.ASPHALT);
    g.box(10, 0, 17, 4, 1, 7, P.RED);
    // hotel tower: gold glass, purple neon edges, pink crown, star
    K.block(g, 5, 1, 1, 14, 38, 7, { wall: P.GLASS_GOLD, win: P.WIN_OFFICE, ribbon: true, floorH: 3, winH: 1, y0: 12, top: 3, margin: 0 });
    for (const [ex, ez] of [[5, 1], [18, 1], [5, 7], [18, 7]]) g.box(ex, 11, ez, 1, 28, 1, P.NEON_PURPLE);
    g.box(5, 38, 1, 14, 1, 7, P.NEON_PINK);
    g.box(6, 39, 2, 12, 1, 5, P.GOLD);
    K.text(g, '*', 12, 40, 4, P.NEON_YELLOW);
    g.light(12, 42.5, 4.5, K.LC.yellow, 2.5, true);
    // casino hall: purple with gold pilasters and a neon roofline
    K.block(g, 1, 1, 7, 22, 10, 11, { wall: P.PURPLE, noWin: true, roof: P.ROOF_BLACK });
    for (let x = 1; x < 23; x += 3) g.box(x, 1, 17, 1, 10, 1, P.GOLD);
    g.walls(1, 10, 7, 22, 1, 11, P.NEON_PINK);
    K.door(g, 's', 9, 1, 17, 6, 4, P.GLASS_DARK);
    // giant dice on the roof
    die(g, 3, 11, 9, P.RED, P.WHITE);
    die(g, 16, 11, 9, P.WHITE, P.BLACK);
    // CASINO sign board with chaser bulbs
    g.box(1, 11, 17, 22, 7, 1, P.BLACK);
    K.text(g, 'CASINO', 11.5, 12, 18, P.NEON_PINK);
    for (let x = 1; x < 23; x++) { g.set(x, 11, 17, x & 1 ? P.NEON_YELLOW : P.GOLD); g.set(x, 17, 17, x & 1 ? P.GOLD : P.NEON_YELLOW); }
    g.light(11.5, 14.5, 19, K.LC.pink, 3, true);
    // marquee canopy with bulbs
    g.box(5, 6, 18, 14, 1, 3, P.GOLD);
    for (let x = 5; x < 19; x++) g.set(x, 6, 20, x & 1 ? P.NEON_YELLOW : P.SIGN_WHITE);
    for (let z = 18; z < 21; z++) { g.set(5, 6, z, z & 1 ? P.NEON_YELLOW : P.SIGN_WHITE); g.set(18, 6, z, z & 1 ? P.NEON_YELLOW : P.SIGN_WHITE); }
    for (const lx of [7, 12, 17]) g.light(lx, 5, 19.5, K.LC.yellow, 1.2, true);
    // fountains with neon rims
    for (const fx of [4, 20]) {
      K.ring(g, fx, 1, 21, 2.1, 3, 2, P.MARBLE);
      g.cyl(fx, 1, 21, 2.1, 1, P.WATER_POOL);
      K.ring(g, fx, 2, 21, 2.1, 3, 1, P.NEON_CYAN);
      g.box(fx - 1, 1, 20, 2, 2, 2, P.GOLD);
      g.emit(fx, 3.5, 21, 'fountain', 1.5);
    }
    for (const [px, pz] of [[0, 18], [23, 18], [7, 22], [16, 22]]) K.tree(g, px, 1, pz, 'palm', 1);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* stadium (4x4) — home of the Voxelpolis Cubes                         */
/* ------------------------------------------------------------------ */
VC.models.define('stadium', {
  variants: 1,
  gen(rng) {
    const g = K.grid(4, 4, 40);
    const cx = 16, cz = 16, A = 8, B = 5.5, SEAT = 6.6, WALL = 7.7;
    K.lot(g, P.CONCRETE_L);
    const dist = (x, z) => Math.hypot(Math.max(Math.abs(x + 0.5 - cx) - A, 0), Math.max(Math.abs(z + 0.5 - cz) - B, 0));
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++) {
        const d = dist(x, z);
        if (d === 0) {
          g.set(x, 0, z, (x >> 1) & 1 ? P.FIELD_GREEN : P.GRASS);
        } else if (d <= 1.2) {
          g.set(x, 0, z, P.TRACK_RED);
        } else if (d <= SEAT) {
          const h = 1 + Math.floor((d - 1.2) * 1.6);
          const sec = Math.floor(((Math.atan2(z + 0.5 - cz, x + 0.5 - cx) + Math.PI) / (Math.PI * 2)) * 24);
          const col = sec % 6 === 0 ? P.CONCRETE_L : h > 6 ? P.YELLOW : P.BLUE;
          g.box(x, 0, z, 1, h - 1, 1, P.CONCRETE);
          g.box(x, h - 1, z, 1, 2, 1, col);
        } else if (d <= WALL) {
          g.box(x, 0, z, 1, 12, 1, P.CONCRETE_L);
          g.set(x, 11, z, P.NEON_BLUE);
          g.set(x, 10, z, P.BLUE);
          if ((x + z) % 3 === 0) { g.set(x, 1, z, P.GLASS_DARK); g.set(x, 2, z, P.GLASS_DARK); }
        }
      }
    // pitch markings + goals
    const L = P.FIELD_LINE;
    g.box(8, 0, 10, 16, 1, 1, L); g.box(8, 0, 21, 16, 1, 1, L);
    g.box(8, 0, 10, 1, 1, 12, L); g.box(23, 0, 10, 1, 1, 12, L);
    g.box(15, 0, 10, 2, 1, 12, L);
    K.ring(g, 16, 0, 16, 1.8, 2.7, 1, L);
    g.box(15, 0, 15, 2, 1, 2, L);
    for (const [gx, px] of [[8, 9], [23, 20]]) {
      g.box(Math.min(px, px + 2), 0, 13, 3, 1, 1, L); g.box(Math.min(px, px + 2), 0, 18, 3, 1, 1, L);
      g.box(gx === 8 ? 11 : 20, 0, 13, 1, 1, 6, L);
      g.box(gx, 1, 14, 1, 2, 1, P.WHITE); g.box(gx, 1, 17, 1, 2, 1, P.WHITE); g.box(gx, 3, 14, 1, 1, 4, P.WHITE);
    }
    // thin roof lip on top of the bowl wall
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++) {
        const d = dist(x, z);
        if (d > 5.9 && d <= WALL) g.set(x, 12, z, d <= 6.6 ? P.CHROME : P.WHITE);
      }
    // scoreboard on the west end facing the pitch
    g.box(1, 12, 10, 1, 7, 12, P.BLACK);
    K.text(g, '3-1', 2, 13, 16, P.NEON_YELLOW, 'e');
    g.box(2, 18, 10, 1, 1, 12, P.NEON_BLUE);
    // floodlight towers
    for (const [fx, fz] of [[1, 1], [29, 1], [1, 29], [29, 29]]) {
      g.box(fx, 1, fz, 2, 24, 2, P.METAL_D);
      for (let y = 5; y < 24; y += 5) g.box(fx, y, fz, 2, 1, 2, P.METAL);
      g.box(fx - (fx > 16 ? 1 : 0), 25, fz - (fz > 16 ? 1 : 0), 3, 3, 3, P.LAMP_WHITE);
      g.light(fx + 1, 26.5, fz + 1, K.LC.white, 3.2);
    }
    // entrance flags
    for (const [fx, c] of [[10, P.BLUE], [21, P.YELLOW]]) K.flag(g, fx, 1, 30, 10, [c, P.WHITE]);
    return K.fit(g);
  },
});
