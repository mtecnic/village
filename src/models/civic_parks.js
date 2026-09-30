/*
 * VOXELPOLIS — civic models: PARKS & LEISURE.
 * small_park, playground, plaza, sports_field, big_park, botanical_garden.
 * Lots are paved/grassed at y = 0; everything else stands from y = 1.
 * Helpers: VC.civicKit (models/civic.js). Front/entrance faces +Z.
 */
const P = VC.P, K = VC.civicKit;

/* ------------------------------------------------------------------ */
/* small_park (1x1)                                                     */
/* ------------------------------------------------------------------ */
VC.models.define('small_park', {
  variants: 3,
  gen(rng, v) {
    const g = K.grid(1, 1, 14);
    if (v === 0) {
      // hedged square with crossing gravel paths and a flower planter
      K.lot(g, P.GRASS);
      g.box(3, 0, 0, 2, 1, 8, P.SAND); g.box(0, 0, 3, 8, 1, 2, P.SAND);
      g.walls(0, 1, 0, 8, 1, 8, P.HEDGE);
      g.box(3, 1, 0, 2, 1, 1, 0); g.box(3, 1, 7, 2, 1, 1, 0); g.box(0, 1, 3, 1, 1, 2, 0); g.box(7, 1, 3, 1, 1, 2, 0);
      g.box(3, 1, 3, 2, 1, 2, P.STONE);
      g.set(3, 2, 3, P.FLOWER_R); g.set(4, 2, 3, P.FLOWER_Y); g.set(3, 2, 4, P.FLOWER_Y); g.set(4, 2, 4, P.FLOWER_R);
      K.tree(g, 1, 1, 1, 'oak', 0.85);
      K.bench(g, 5, 1, 1, 'x', 2);
      K.lamp(g, 1, 1, 5, 4);
      g.set(2, 1, 5, P.FLOWER_P); g.set(1, 1, 6, P.FLOWER_W); g.set(2, 1, 6, P.FLOWER_P);
      K.tree(g, 5, 1, 5, 'birch', 0.8);
    } else if (v === 1) {
      // duck pond with a willow and a bench
      K.lot(g, P.GRASS);
      g.ellipsoid(3, 0.5, 3.2, 3.3, 1, 2.9, P.ROCK);
      g.ellipsoid(3, 0.5, 3.2, 2.5, 1, 2.1, P.WATER);
      g.set(2, 0, 2, P.LEAF_L); g.set(4, 1, 4, P.YELLOW); g.set(4, 1, 3, 0);
      g.box(4, 0, 6, 4, 1, 2, P.SAND); g.box(6, 0, 3, 2, 1, 3, P.SAND);
      K.bench(g, 1, 1, 6, 'x', 2, true);
      K.tree(g, 6, 1, 1, 'oak', 0.9, P.LEAF_L);
      K.flowers(g, 6, 1, 6, 1, 1, [P.FLOWER_V]);
      K.lamp(g, 7, 1, 7, 4);
    } else {
      // flower garden around a little white gazebo
      K.lot(g, P.GRASS_L);
      g.box(3, 0, 0, 2, 1, 8, P.SIDEWALK);
      K.flowers(g, 0, 1, 0, 3, 2, [P.FLOWER_R, P.FLOWER_Y]);
      K.flowers(g, 5, 1, 0, 3, 2, [P.FLOWER_P, P.FLOWER_W]);
      K.flowers(g, 0, 1, 6, 2, 2, [P.FLOWER_V, P.FLOWER_P]);
      K.flowers(g, 6, 1, 6, 2, 2, [P.FLOWER_Y, P.FLOWER_R]);
      g.box(2, 1, 2, 4, 1, 4, P.WOOD_L);
      for (const [px, pz] of [[2, 2], [5, 2], [2, 5], [5, 5]]) g.box(px, 2, pz, 1, 3, 1, P.WHITE);
      K.spire(g, 1, 5, 1, 6, 6, P.ROOF_GREEN, 1);
      g.set(3, 8, 3, P.GOLD);
      K.bench(g, 3, 2, 3, 'x', 2);
    }
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* playground (1x1)                                                     */
/* ------------------------------------------------------------------ */
VC.models.define('playground', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(1, 1, 12);
    K.lot(g, v ? P.COURT_BLUE : P.TRACK_RED);
    // slide tower with a little roof, ladder and slide
    g.box(0, 1, 0, 2, 2, 2, P.WOOD);
    g.box(0, 3, 0, 2, 1, 2, P.YELLOW);
    g.box(0, 4, 0, 1, 1, 1, P.WOOD); g.box(1, 4, 1, 1, 1, 1, P.WOOD);
    g.box(0, 5, 0, 2, 1, 2, v ? P.ROOF_GREEN : P.ROOF_RED);
    g.set(2, 1, 0, P.WOOD); g.set(2, 2, 0, P.WOOD);
    g.box(0, 3, 2, 2, 1, 1, P.BLUE); g.box(0, 2, 3, 2, 1, 1, P.BLUE); g.box(0, 1, 4, 2, 1, 1, P.BLUE);
    // swings
    g.box(6, 1, 0, 1, 4, 1, P.RED); g.box(6, 1, 4, 1, 4, 1, P.RED);
    g.box(6, 5, 0, 1, 1, 5, P.RED);
    for (const sz of [1, 3]) { g.box(6, 3, sz, 1, 2, 1, P.METAL); g.set(6, 2, sz, P.BLACK); }
    // sandbox with bucket, seesaw, climbing dome
    g.box(0, 0, 5, 3, 1, 3, P.SAND);
    g.walls(0, 1, 5, 3, 1, 3, P.WOOD_L);
    g.set(1, 1, 6, P.RED);
    g.set(3, 1, 2, P.YELLOW); g.set(4, 1, 2, P.METAL_D); g.set(4, 2, 2, P.YELLOW); g.set(5, 2, 2, P.YELLOW);
    K.dome(g, 5.5, 1, 6.5, 2, (x, y, z) => ((x + y + z) & 1 ? (v ? P.ORANGE : P.GREEN) : 0), 2.2);
    K.lamp(g, 7, 1, 7, 4);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* plaza (2x2)                                                          */
/* ------------------------------------------------------------------ */
VC.models.define('plaza', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(2, 2, 20);
    const c = 8;
    g.box(0, 0, 0, 16, 1, 16, (x, y, z) => {
      const d = Math.hypot(x + 0.5 - c, z + 0.5 - c);
      if (d < 4.6) return P.MARBLE;
      return Math.floor(d) % 3 === 0 ? (v ? P.BRICK_L : P.CONCRETE_L) : P.SIDEWALK;
    });
    // tiered fountain
    K.ring(g, c, 1, c, 3.3, 4.4, 2, P.MARBLE);
    g.cyl(c, 1, c, 3.3, 1, P.WATER);
    g.cyl(c, 1, c, 1.1, 3, P.MARBLE);
    g.cyl(c, 4, c, 2.3, 1, P.MARBLE);
    g.cyl(c, 4, c, 1.4, 1, P.WATER);
    g.box(7, 5, 7, 2, 1, 2, P.MARBLE);
    g.box(7, 6, 7, 2, 1, 2, v ? P.COPPER_GREEN : P.GOLD);
    g.emit(c, 7.2, c, 'fountain', 2);
    for (const [ex, ez] of [[c + 2.4, c], [c - 2.4, c], [c, c + 2.4], [c, c - 2.4]]) g.emit(ex, 2, ez, 'fountain', 0.5);
    g.light(c, 3, c, K.LC.cyan, 1.5);
    // benches facing the fountain
    K.bench(g, 7, 1, 1, 'x', 2);
    K.bench(g, 7, 1, 13, 'x', 2, true);
    K.bench(g, 1, 1, 7, 'z', 2);
    K.bench(g, 13, 1, 7, 'z', 2, true);
    // corner planters with trees, lamps on the diagonals
    for (const [px, pz] of [[0, 0], [13, 0], [0, 13], [13, 13]]) {
      g.box(px, 1, pz, 3, 1, 3, P.STONE);
      g.box(px + 1, 1, pz + 1, 1, 1, 1, P.SOIL);
      K.tree(g, px + 1, 2, pz + 1, v ? 'blossom' : 'oak', 0.95);
    }
    for (const [lx, lz] of [[4, 4], [11, 4], [4, 11], [11, 11]]) K.lamp(g, lx, 1, lz, 5);
    for (const [fx, fz] of [[4, 1], [11, 1], [4, 14], [11, 14]]) K.flowers(g, fx, 1, fz, 1, 1, [rng.pick([P.FLOWER_R, P.FLOWER_Y, P.FLOWER_P])]);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* sports_field (3x2)                                                   */
/* ------------------------------------------------------------------ */
VC.models.define('sports_field', {
  variants: 1,
  gen(rng) {
    const g = K.grid(3, 2, 24);
    K.lot(g, P.GRASS);
    // pitch with mowing stripes and lines
    const L = P.FIELD_LINE;
    g.box(1, 0, 4, 21, 1, 11, (x) => ((x >> 1) & 1 ? P.FIELD_GREEN : P.GRASS));
    g.box(1, 0, 4, 21, 1, 1, L); g.box(1, 0, 14, 21, 1, 1, L);
    g.box(1, 0, 4, 1, 1, 11, L); g.box(21, 0, 4, 1, 1, 11, L);
    g.box(11, 0, 4, 1, 1, 11, L);
    K.ring(g, 11.5, 0, 9.5, 1.9, 2.8, 1, L);
    for (const [x0, x1] of [[1, 4], [18, 21]]) {
      g.box(x0, 0, 6, x1 - x0 + 1, 1, 1, L); g.box(x0, 0, 12, x1 - x0 + 1, 1, 1, L);
      g.box(x0 === 1 ? x1 : x0, 0, 6, 1, 1, 7, L);
    }
    // goals with nets
    for (const [gx, bx] of [[1, 0], [21, 22]]) {
      g.box(bx, 1, 7, 1, 2, 5, P.CONCRETE_L);
      g.box(gx, 1, 7, 1, 2, 1, P.WHITE); g.box(gx, 1, 11, 1, 2, 1, P.WHITE);
      g.box(Math.min(gx, bx), 3, 7, 2, 1, 5, P.WHITE);
    }
    // covered bleachers along the back
    g.box(6, 1, 2, 11, 1, 1, P.BLUE);
    g.box(6, 1, 1, 11, 2, 1, P.WHITE);
    g.box(6, 1, 0, 11, 3, 1, P.BLUE);
    g.box(6, 5, 0, 11, 1, 3, P.WHITE);
    g.box(6, 1, 0, 1, 4, 1, P.METAL); g.box(16, 1, 0, 1, 4, 1, P.METAL);
    // floodlights
    for (const [fx, fz] of [[0, 1], [23, 1], [0, 15], [23, 15]]) {
      g.box(fx, 1, fz, 1, 13, 1, P.METAL);
      const hx = fx === 0 ? 0 : 22;
      g.box(hx, 14, fz, 2, 2, 1, P.LAMP_WHITE);
      g.light(hx + 1, 15, fz + 0.5, K.LC.white, 2.2);
    }
    // dugouts
    for (const dx of [7, 14]) {
      g.box(dx, 1, 15, 3, 1, 1, P.BLUE);
      g.box(dx, 3, 15, 3, 1, 1, P.AWNING_B);
      g.box(dx, 1, 15, 1, 2, 1, P.METAL);
    }
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* big_park (3x3) — Central Park                                        */
/* ------------------------------------------------------------------ */
VC.models.define('big_park', {
  variants: 2,
  gen(rng, v) {
    const g = K.grid(3, 3, 24);
    // normalized distance to a two-lobed pond
    const pond = (x, z) => Math.min(
      Math.hypot((x + 0.5 - 9) / 5.5, (z + 0.5 - 10) / 4),
      Math.hypot((x + 0.5 - 14) / 4.2, (z + 0.5 - 13.5) / 3.4),
    );
    const onEntry = (x, z) => (x >= 11 && x <= 12 && z >= 17) || (x >= 19 && z >= 13 && z <= 14);
    g.box(0, 0, 0, 24, 1, 24, (x, y, z) => {
      const f = pond(x, z);
      if (f < 1) return P.WATER;
      if (f < 1.2) return P.ROCK;
      if ((f > 1.45 && f < 1.78) || onEntry(x, z)) return P.SAND;
      return VC.M.hash(x >> 2, z >> 2, 77) < 0.3 ? P.GRASS_L : P.GRASS;
    });
    // red arched bridge across the pond waist
    for (let z = 6; z <= 17; z++) {
      const t = (z - 6) / 11, y = 1 + Math.round(Math.sin(t * Math.PI) * 2.2);
      g.box(11, y, z, 2, 1, 1, P.WOOD_L);
      g.box(11, 0, z, 2, y, 1, 0);
      if (pond(11, z) >= 1) g.box(11, 0, z, 2, 1, 1, P.SAND);
      else g.box(11, 0, z, 2, 1, 1, P.WATER);
      if (z % 2 === 0) { g.set(10, y + 1, z, P.RED); g.set(13, y + 1, z, P.RED); }
      g.set(10, y, z, P.RED); g.set(13, y, z, P.RED);
    }
    // gazebo
    g.cyl(19.5, 1, 4.5, 2.7, 1, P.WOOD_L);
    for (const [px, pz] of [[18, 3], [21, 3], [18, 6], [21, 6]]) g.box(px, 2, pz, 1, 3, 1, P.WHITE);
    K.spire(g, 17, 5, 2, 6, 6, v ? P.ROOF_RED : P.ROOF_GREEN, 1);
    g.box(19, 8, 4, 2, 1, 2, P.GOLD);
    // trees scattered on the lawns (away from water, paths and the gazebo)
    const kinds = v ? ['oak', 'oak', 'blossom', 'birch'] : ['oak', 'oak', 'pine', 'birch', 'blossom'];
    const placed = [];
    for (let t = 0; t < 400 && placed.length < 14; t++) {
      const x = rng.int(1, 22), z = rng.int(1, 22);
      const f = pond(x, z);
      if (f < 2.0 || onEntry(x, z) || (x > 15 && z < 9)) continue;
      if (placed.some(([px, pz]) => Math.hypot(px - x, pz - z) < 4)) continue;
      placed.push([x, z]);
      K.tree(g, x, 1, z, rng.pick(kinds), rng.range(0.8, 1.2));
    }
    // benches by the pond, lamps, flowers, boat and ducks
    K.bench(g, 3, 1, 17, 'x', 2, true);
    K.bench(g, 17, 1, 6, 'x', 2);
    K.bench(g, 19, 1, 16, 'z', 2, true);
    for (const [lx, lz] of [[10, 20], [13, 20], [21, 12], [2, 5]]) K.lamp(g, lx, 1, lz, 4);
    K.flowers(g, 7, 1, 21, 3, 2, [P.FLOWER_R, P.FLOWER_Y]);
    K.flowers(g, 14, 1, 21, 3, 2, [P.FLOWER_P, P.FLOWER_W]);
    g.box(6, 1, 9, 2, 1, 1, P.WHITE); g.set(7, 2, 9, P.RED);
    g.set(15, 1, 14, P.YELLOW); g.set(16, 1, 13, P.WHITE);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* botanical_garden (4x4)                                               */
/* ------------------------------------------------------------------ */
/** Glasshouse pane color: white ribs + green (plants behind) low panes + cyan upper panes. */
function paneColor(ribMeridian, ribRing, y) {
  if (ribMeridian || ribRing) return P.WHITE;
  return y < 4 ? P.GLASS_GREEN : P.GLASS_CYAN;
}
/** Hollow glass dome (open oculus) standing on y = 1. */
function glassDome(g, cx, cz, r, oculus = 0.7) {
  for (let y = 1; y < 1 + r; y++)
    for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - 1, dz = z + 0.5 - cz;
        const d = Math.hypot(dx, dy, dz);
        if (d > r || d <= r - 1.15 || dy > r - oculus) continue;
        const rib = Math.abs(dx) < 0.6 || Math.abs(dz) < 0.6 || Math.abs(Math.abs(dx) - Math.abs(dz)) < 0.5;
        g.set(x, y, z, paneColor(rib, y % 3 === 1, y));
      }
}
/** Hollow barrel-vault glasshouse along X. */
function glassVault(g, x0, len, cz, r) {
  g.hcyl('x', x0, len, 1, cz, r, (a, y, q) => {
    if (y < 1) return P.GRASS_D;
    const d = Math.hypot(y + 0.5 - 1, q + 0.5 - cz);
    if (d <= r - 1.1) return 0;
    return paneColor((a - x0) % 3 === 0 || a === x0 + len - 1, false, y);
  });
}
VC.models.define('botanical_garden', {
  variants: 1,
  gen(rng) {
    const g = K.grid(4, 4, 32);
    K.lot(g, P.GRASS);
    // paths
    g.box(15, 0, 17, 2, 1, 15, P.SIDEWALK);
    g.box(10, 0, 24, 20, 1, 2, P.SIDEWALK);
    // glass vault wings + great dome (built hollow, planted inside)
    glassVault(g, 1, 8, 11, 4.4);
    glassVault(g, 23, 8, 11, 4.4);
    g.box(1, 0, 8, 30, 1, 7, P.GRASS_D);
    for (let x = 2; x < 30; x += 3) g.ellipsoid(x + 0.5, 1.5, 11, 1.4, 1.8, 1.4, rng.pick([P.LEAF, P.LEAF_D, P.PALM]));
    glassDome(g, 16, 11, 8.6);
    // giant palm rising through the oculus
    for (let y = 1; y < 10; y++) g.box(15, y, 10, 1, 1, 1, P.TRUNK);
    for (let k = 1; k <= 3; k++) {
      const dy = k === 3 ? -1 : 0;
      g.set(15 + k, 10 + dy, 10, P.PALM); g.set(15 - k, 10 + dy, 10, P.PALM);
      g.set(15, 10 + dy, 10 + k, P.PALM); g.set(15, 10 + dy, 10 - k, P.PALM);
      g.set(15 + k, 10 + dy, 10 + k, P.PALM); g.set(15 - k, 10 + dy, 10 - k, P.PALM);
    }
    g.set(15, 10, 10, P.PALM); g.set(15, 11, 10, P.PALM);
    // dome entrance portico
    g.box(14, 1, 18, 4, 4, 2, 0);
    g.box(14, 1, 19, 1, 4, 1, P.WHITE); g.box(17, 1, 19, 1, 4, 1, P.WHITE);
    g.box(14, 5, 18, 4, 1, 2, P.WHITE);
    // small tropical dome
    glassDome(g, 5, 27.5, 4.2, 0.5);
    g.ellipsoid(5, 1.5, 27.5, 2, 2, 2, P.PALM);
    // formal flower beds with hedge rims
    const beds = [[9, 18, [P.FLOWER_R, P.FLOWER_Y]], [18, 18, [P.FLOWER_P, P.FLOWER_W]], [9, 27, [P.FLOWER_V, P.FLOWER_Y]], [18, 27, [P.FLOWER_R, P.FLOWER_P]]];
    for (const [bx, bz, cols] of beds) {
      g.box(bx, 1, bz, 5, 1, 4, P.HEDGE);
      K.flowers(g, bx + 1, 1, bz + 1, 3, 2, cols);
    }
    // fountain at the crossing, lily pond, palms, lamps
    K.ring(g, 15.5 + 0.5, 1, 24.5 + 0.5, 1.6, 2.5, 1, P.MARBLE);
    g.cyl(16, 1, 25, 1.6, 1, P.WATER);
    g.emit(16, 2.5, 25, 'fountain', 1);
    K.pool(g, 24, 1, 26, 7, 5, P.MARBLE, P.WATER, 2);
    g.set(26, 1, 28, P.LEAF_L); g.set(28, 1, 27, P.LEAF_L); g.set(27, 1, 29, P.FLOWER_P);
    for (const [px, pz] of [[14, 22], [17, 22], [14, 29], [17, 29]]) K.tree(g, px, 1, pz, 'palm', 1);
    for (const z of [18, 21]) { K.tree(g, 1, 1, z, 'cypress', 0.9); K.tree(g, 30, 1, z, 'cypress', 0.9); }
    for (const [lx, lz] of [[13, 23], [18, 23], [23, 23], [8, 23]]) K.lamp(g, lx, 1, lz, 4);
    return K.fit(g);
  },
});
