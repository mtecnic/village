/*
 * VOXELPOLIS — civic models: LANDMARKS (part 2, the wonders).
 * tv_tower (+ part 'tv_tower_ring', the revolving restaurant), pyramid,
 * space_center (+ standalone model 'rocket' and part 'radar_dish'), arcology.
 * Helpers: VC.civicKit (models/civic.js). Front/entrance faces +Z.
 *
 * 'rocket' (12 x 50 x 12, base center at [6, 0, 6], meta.nozzle) is also used by the fx
 * module for launches; space_center.meta.rocket = {x, y, z} is the pad position (parent voxels)
 * of the static rocket. The pad rocket is a PART of the space center (speed 0, pad: true), not pasted
 * voxels: the building renderer hides it while VC.fx.isLaunching(b) (the fx module flies its twin from
 * the same spot) and raises a fresh one out of the pad after a cooldown.
 */
const P = VC.P, K = VC.civicKit;

/** Rounded-square (superellipse) prism: |dx|^p + |dz|^p <= r^p. c may be fn(x, y, z, dx, dz, surface). */
function rsq(g, cx, y0, cz, r, h, c, p = 4) {
  const rp = r ** p, ri = (r - 1) ** p, fn = typeof c === 'function';
  for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = Math.abs(x + 0.5 - cx), dz = Math.abs(z + 0.5 - cz), e = dx ** p + dz ** p;
      if (e > rp) continue;
      const surf = e > ri;
      for (let y = y0; y < y0 + h; y++) g.set(x, y, z, fn ? c(x, y, z, dx, dz, surf) : c);
    }
}

/* ------------------------------------------------------------------ */
/* tv_tower (2x2) — the Sky Needle                                      */
/* ------------------------------------------------------------------ */
const TV_RING_Y = 90;
VC.models.define('tv_tower_ring', {
  gen() {
    const g = new VC.VoxelGrid(16, 5, 16);
    const seg = (a) => Math.floor(((a + Math.PI) / (Math.PI * 2)) * 24);
    K.ring(g, 8, 0, 8, 2.9, 7.6, 1, P.CONCRETE_L);
    K.ring(g, 8, 1, 8, 2.9, 7.3, 3, (x, y, z, a) => (seg(a) % 3 === 0 ? P.WHITE : P.WIN_COOL));
    K.ring(g, 8, 4, 8, 2.9, 7.7, 1, P.WHITE);
    K.ring(g, 8, 4, 8, 7.0, 7.7, 1, (x, y, z, a) => (seg(a) & 1 ? P.NEON_CYAN : P.WHITE));
    return g;
  },
});
VC.models.define('tv_tower', {
  variants: 1,
  parts: [{ model: 'tv_tower_ring', pivot: [8, TV_RING_Y, 8], partPivot: [8, 0, 8], axis: 'y', speed: 0.15 }],
  gen(rng) {
    const g = K.grid(2, 2, 160);
    K.lot(g, P.SIDEWALK);
    // glass entrance pavilion
    g.cyl(8, 1, 8, 5.6, 4, P.GLASS_BLUE);
    g.cyl(8, 5, 8, 6.2, 1, P.WHITE);
    g.cyl(8, 6, 8, 4.4, 1, P.CONCRETE_L);
    K.door(g, 's', 7, 1, 13, 2, 3, P.GLASS_DARK);
    g.box(6, 4, 14, 4, 1, 2, P.WHITE);
    // tripod legs flaring into the shaft
    for (let k = 0; k < 3; k++) {
      const a = -Math.PI / 2 + (k * Math.PI * 2) / 3;
      for (let y = 1; y <= 36; y++) {
        const r = 7 - (5.4 * (y - 1)) / 35;
        g.box(Math.round(8 + Math.cos(a) * r - 1), y, Math.round(8 + Math.sin(a) * r - 1), 2, 1, 2, P.CONCRETE_L);
      }
    }
    // shaft with a glowing elevator strip up the front
    for (let y = 1; y < 108; y++) {
      const r = 2.75 - (0.85 * y) / 108;
      g.cyl(8, y, 8, r, 1, (x, yy, z) => (z >= 10 && (x === 7 || x === 8) && (yy & 1) ? P.WIN_COOL : P.CONCRETE_L));
    }
    // bracket under the revolving restaurant (the ring itself is a part)
    [3.2, 4.4, 5.6, 6.8].forEach((r, i) => g.cyl(8, TV_RING_Y - 4 + i, 8, r, 1, i === 3 ? P.METAL_D : P.CONCRETE_L));
    // observation deck: underside cone, glass band, roof with neon rim, dome
    [3.5, 5, 6.2].forEach((r, i) => g.cyl(8, 95 + i, 8, r, 1, P.CONCRETE_L));
    g.cyl(8, 98, 8, 6.5, 1, P.WHITE);
    K.ring(g, 8, 99, 8, 0, 6.1, 3, (x, y, z, a) => (Math.floor(((a + Math.PI) / (Math.PI * 2)) * 20) % 4 === 0 ? P.WHITE : P.WIN_COOL));
    g.cyl(8, 102, 8, 6.7, 1, P.WHITE);
    K.ring(g, 8, 102, 8, 6.0, 6.7, 1, P.NEON_CYAN);
    K.dome(g, 8, 103, 8, 4.8, P.WHITE, 2.2);
    g.light(8, 100, 8, K.LC.cyan, 3.5);
    // antenna mast with red/white bands and aviation beacons
    g.cyl(8, 105, 8, 1.45, 10, P.METAL);
    for (let y = 115; y < 151; y++) {
      const col = ((y - 115) / 5) & 1 ? P.WHITE : P.CHIMNEY_RED;
      if (y < 135) g.box(7, y, 7, 2, 1, 2, col);
      else g.set(8, y, 8, col);
    }
    K.beacon(g, 8, 151, 8, 1.2);
    K.beacon(g, 9, 134, 8, 0.8);
    K.beacon(g, 9, 114, 8, 0.8);
    // plaza
    for (const [lx, lz] of [[1, 14], [14, 14]]) K.lamp(g, lx, 1, lz, 4);
    K.flag(g, 2, 1, 11, 8, [P.BLUE, P.YELLOW]);
    for (const [tx, tz] of [[1, 1], [14, 2]]) K.tree(g, tx, 1, tz, 'oak', 0.8);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* pyramid (5x5) — glass & gold wonder                                  */
/* ------------------------------------------------------------------ */
VC.models.define('pyramid', {
  variants: 1,
  gen(rng) {
    const g = K.grid(5, 5, 40);
    const cx = 20, cz = 18, HW = 16;
    g.box(0, 0, 0, 40, 1, 40, (x, y, z) => (((x >> 2) + (z >> 2)) & 1 ? P.SANDSTONE : P.SAND));
    let y = 1;
    for (; ; y++) {
      const hw = HW - Math.floor(((y - 1) * 2) / 3);
      if (hw < 1) break;
      const x0 = cx - hw, z0 = cz - hw, w = hw * 2;
      if (hw <= 2) { g.box(x0, y, z0, w, 1, w, P.GOLD); continue; }
      const face = y % 6 === 0 ? P.GOLD : y % 2 === 0 ? P.WIN_OFFICE : P.GLASS_BLUE;
      g.box(x0, y, z0, w, 1, w, P.GLASS_DARK);
      g.walls(x0, y, z0, w, 1, w, face);
      g.walls(x0 + 1, y, z0 + 1, w - 2, 1, w - 2, face);
      // gold edges that glow at night
      for (const [ex, ez, sx, sz] of [[x0, z0, 1, 1], [x0 + w - 1, z0, -1, 1], [x0, z0 + w - 1, 1, -1], [x0 + w - 1, z0 + w - 1, -1, -1]]) {
        g.set(ex, y, ez, P.LAMP);
        g.set(ex + sx, y, ez, P.GOLD); g.set(ex, y, ez + sz, P.GOLD);
      }
    }
    // glowing capstone
    g.box(cx - 1, y, cz - 1, 2, 1, 2, P.NEON_YELLOW);
    g.light(cx, y + 1, cz, K.LC.yellow, 4.5, true);
    g.emit(cx, y + 1.5, cz, 'sparkle', 0.8);
    // small glass entrance pyramid (Louvre style) + path
    g.box(18, 0, 33, 4, 1, 7, P.MARBLE);
    for (let k = 0; k < 3; k++) g.box(17 + k, 1 + k, 34 + k, 6 - 2 * k, 1, 6 - 2 * k, k === 2 ? P.GOLD : k & 1 ? P.GLASS_CYAN : P.WIN_OFFICE);
    // reflecting pools with fountains, gold-tipped obelisks, palms, lamps
    for (const px of [3, 25]) {
      K.pool(g, px, 1, 34, 12, 5, P.MARBLE, P.WATER, 2);
      g.emit(px + 3, 2.5, 36.5, 'fountain', 0.7);
      g.emit(px + 9, 2.5, 36.5, 'fountain', 0.7);
    }
    for (const ox of [16, 23]) { g.box(ox, 1, 35, 1, 7, 1, P.SANDSTONE); g.set(ox, 8, 35, P.GOLD); }
    for (let z = 3; z < 34; z += 6) { K.tree(g, 1, 1, z, 'palm', 1.1); K.tree(g, 38, 1, z, 'palm', 1.1); }
    for (const [lx, lz] of [[15, 38], [24, 38], [2, 39], [37, 39]]) K.lamp(g, lx, 1, lz, 5);
    for (const [ex, ez] of [[cx - HW, cz - HW], [cx + HW, cz - HW], [cx - HW, cz + HW], [cx + HW, cz + HW]]) g.light(ex, 3, ez, K.LC.yellow, 1.4);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* rocket (standalone model) + radar_dish (part)                        */
/* ------------------------------------------------------------------ */
VC.models.define('rocket', {
  gen() {
    const g = new VC.VoxelGrid(12, 50, 12), c = 6;
    for (let y = 0; y < 41; y++) {
      let col = P.WHITE, r = 2.6;
      if (y < 3) { col = P.METAL_D; r = y === 0 ? 2.1 : 2.6; }
      else if (y === 17 || y === 30) col = P.BLACK;
      else if (y === 31 || y === 32) { col = P.BLACK; r = 2.4; }
      else if (y > 32) r = 2.2;
      g.cyl(c, y, c, r, 1, (x, yy, z) => (y >= 4 && y < 10 && x < c && z < c ? P.BLACK : col));
    }
    g.cyl(c, 41, c, 1.9, 1, P.METAL);
    g.cyl(c, 42, c, 1.5, 1, P.WHITE);
    g.cyl(c, 43, c, 1.0, 1, P.WHITE);
    g.box(5, 44, 5, 2, 2, 2, P.RED);
    g.box(5, 46, 5, 1, 3, 1, P.METAL);
    g.set(5, 49, 5, P.RED);
    // strap-on boosters
    for (const bx of [c - 4.1, c + 4.1]) {
      for (let y = 0; y < 22; y++) g.cyl(bx, y, c, 1.75, 1, y < 1 ? P.METAL_D : y === 12 ? P.BLACK : P.WHITE);
      g.cyl(bx, 22, c, 1.2, 1, P.WHITE);
      g.cyl(bx, 23, c, 0.7, 1, P.RED);
    }
    // fins + city flag
    for (let y = 0; y < 6; y++) {
      const len = Math.max(1, 3 - (y >> 1));
      g.box(5, y, 9, 2, 1, len, P.RED);
      g.box(5, y, 3 - len, 2, 1, len, P.RED);
    }
    g.box(5, 20, 8, 2, 3, 1, P.BLUE);
    g.box(5, 21, 8, 2, 1, 1, P.YELLOW);
    g.meta.nozzle = [6, 0, 6];
    return g;
  },
});
VC.models.define('radar_dish', {
  gen() {
    const g = new VC.VoxelGrid(13, 12, 13);
    g.box(6, 0, 6, 1, 5, 1, P.METAL_D);
    g.box(5, 4, 5, 3, 1, 2, P.METAL_D);
    const n = VC.V3.norm([0, 0.6, 1]), vx = 6.5, vy = 5.6, vz = 5.8;
    const R = 5.3, depth = 1.9, f = (R * R) / (4 * depth);
    for (let y = 0; y < 12; y++)
      for (let z = 0; z < 13; z++)
        for (let x = 0; x < 13; x++) {
          const px = x + 0.5 - vx, py = y + 0.5 - vy, pz = z + 0.5 - vz;
          const along = px * n[0] + py * n[1] + pz * n[2];
          const qx = px - n[0] * along, qy = py - n[1] * along, qz = pz - n[2] * along;
          const perp = Math.hypot(qx, qy, qz);
          if (perp <= R && Math.abs(along - (perp * perp) / (4 * f)) < 0.55) g.set(x, y, z, perp > R - 0.9 ? P.METAL : P.WHITE);
        }
    for (let t = 0.5; t < f * 0.8; t += 0.5) g.set(Math.floor(vx + n[0] * t), Math.floor(vy + n[1] * t), Math.floor(vz + n[2] * t), P.METAL_D);
    g.set(Math.floor(vx + n[0] * f * 0.8), Math.floor(vy + n[1] * f * 0.8), Math.floor(vz + n[2] * f * 0.8), P.BEACON_RED);
    return g;
  },
});

/* ------------------------------------------------------------------ */
/* space_center (5x5)                                                   */
/* ------------------------------------------------------------------ */
const ROCKET_AT = [30, 2, 11]; // pad rocket base center (parent voxels)
const DISH_AT = [10, 11, 31]; // radar dish pivot on the mission control roof
function lattice(g, x, z, w, d, y0, h, col, brace) {
  for (const [cx, cz] of [[x, z], [x + w - 1, z], [x, z + d - 1], [x + w - 1, z + d - 1]]) g.box(cx, y0, cz, 1, h, 1, col);
  for (let y = y0; y < y0 + h; y += 4) g.walls(x, y, z, w, 1, d, col);
  for (let y = y0; y + 4 <= y0 + h; y += 4) {
    g.line(x, y, z, x + w - 1, y + 4, z, brace); g.line(x, y, z + d - 1, x + w - 1, y + 4, z + d - 1, brace);
    g.line(x, y, z, x, y + 4, z + d - 1, brace); g.line(x + w - 1, y, z, x + w - 1, y + 4, z + d - 1, brace);
  }
}
VC.models.define('space_center', {
  variants: 1,
  parts: [
    { model: 'radar_dish', pivot: DISH_AT, partPivot: [6.5, 0, 6.5], axis: 'y', speed: 0.5 },
    // the pad rocket: static (speed 0); pad = hidden while its launch is in the air
    { model: 'rocket', pivot: ROCKET_AT, partPivot: [6, 0, 6], axis: 'y', speed: 0, pad: true },
  ],
  gen(rng) {
    const g = K.grid(5, 5, 72);
    K.lot(g, P.CONCRETE_L);
    g.box(0, 0, 20, 40, 1, 4, P.GRASS);
    g.box(0, 0, 38, 40, 1, 2, P.ASPHALT);
    // launch pad, flame trench, hazard border
    g.box(21, 0, 2, 18, 2, 18, P.CONCRETE_D);
    K.hazard(g, 21, 1, 19, 18, 1, 1);
    g.box(28, 1, 13, 4, 1, 7, P.BLACK);
    g.box(28, 0, 13, 4, 1, 7, P.CONCRETE_DD);
    // the rocket on the pad is a part (see parts); venting LOX beside it
    g.emit(ROCKET_AT[0] + 3, 14, ROCKET_AT[2] + 1, 'steam', 0.6);
    g.meta.rocket = { x: ROCKET_AT[0], y: ROCKET_AT[1], z: ROCKET_AT[2] };
    // service tower with access arms and lightning mast
    lattice(g, 28, 1, 4, 4, 2, 56, P.RED, P.RUST);
    for (const ay of [30, 42]) g.box(29, ay, 5, 2, 1, 4, P.RED);
    g.box(29, 58, 2, 1, 6, 1, P.METAL);
    K.beacon(g, 29, 64, 2, 1);
    K.beacon(g, 31, 57, 4, 0.7);
    // propellant spheres
    for (const [sx, sz] of [[36, 4.5], [36, 16.5]]) {
      for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.box(sx + lx, 2, Math.floor(sz) + lz, 1, 2, 1, P.METAL_D);
      g.sphere(sx + 0.5, 6, sz, 2.4, P.TANK_WHITE);
    }
    // pad floodlights
    for (const [fx, fz] of [[21, 2], [38, 2], [21, 18], [38, 18]]) {
      g.box(fx, 2, fz, 1, 10, 1, P.METAL);
      g.box(fx, 12, fz, 1, 1, 1, P.LAMP_WHITE);
      g.light(fx + 0.5, 12.5, fz + 0.5, K.LC.white, 2);
    }
    // vehicle assembly building: huge door toward the pad, flag and emblem
    K.block(g, 2, 1, 2, 14, 34, 13, { wall: P.WHITE, noWin: true, roof: P.CONCRETE_L });
    for (let x = 3; x < 15; x += 3) g.box(x, 1, 14, 1, 33, 1, P.CONCRETE_L);
    K.door(g, 'e', 4, 1, 15, 7, 28, P.METAL_D);
    for (let y = 4; y < 28; y += 4) g.box(15, y, 4, 1, 1, 7, P.CONCRETE_D);
    g.box(3, 20, 15, 7, 7, 1, P.BLUE);
    K.text(g, '*', 6.5, 21, 16, P.YELLOW);
    for (let y = 21; y < 26; y++) for (let x = 10; x < 15; x++) if (Math.hypot(x + 0.5 - 12.5, y + 0.5 - 23.5) <= 2.5) g.set(x, y, 15, P.NAVY);
    g.line(10, 22, 16, 14, 25, 16, P.RED);
    g.set(11, 24, 16, P.WHITE); g.set(13, 22, 16, P.WHITE);
    // crawlerway + crawler transporter
    g.box(16, 0, 5, 5, 1, 8, P.SAND);
    g.box(16, 1, 6, 5, 1, 6, P.TIRE);
    g.box(16, 2, 6, 5, 2, 6, P.METAL_D);
    g.box(17, 4, 7, 3, 1, 4, P.CONCRETE);
    // mission control with rooftop dish
    K.block(g, 2, 1, 26, 16, 7, 11, { wall: P.WHITE, win: P.WIN_OFFICE, ribbon: true, floorH: 3, winH: 2, y0: 1, top: 1, roof: P.CONCRETE, parapet: P.CONCRETE_D });
    K.door(g, 's', 9, 1, 36, 2, 3, P.GLASS_DARK);
    g.box(8, 4, 37, 4, 1, 2, P.WHITE);
    g.box(9, 8, 30, 2, 3, 2, P.METAL_D);
    K.roofJunk(g, 2, 8, 26, 6, 10, rng, 2, 'a');
    g.box(15, 8, 28, 1, 8, 1, P.METAL); K.beacon(g, 15, 16, 28, 0.6);
    // visitor rocket garden
    const mini = (x, z, h, c) => {
      g.cyl(x, 1, z, 1.2, h, (xx, yy) => (yy % 5 === 0 ? c : P.WHITE));
      g.box(Math.floor(x) - 1, 1, Math.floor(z), 3, 2, 1, c);
      g.set(Math.floor(x), h + 1, Math.floor(z), c);
    };
    mini(25, 29, 13, P.RED);
    mini(30, 31, 17, P.BLUE);
    mini(35, 28, 11, P.CHROME);
    for (let x = 22; x < 39; x += 4) K.flag(g, x, 1, 35, 7, [x % 8 === 2 ? P.BLUE : P.RED, P.WHITE]);
    K.bench(g, 23, 1, 32, 'x', 3);
    K.bench(g, 33, 1, 32, 'x', 3);
    for (const [lx, lz] of [[21, 25], [38, 25], [21, 36], [38, 36]]) K.lamp(g, lx, 1, lz, 5);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* arcology (4x4) — a city in one megastructure                         */
/* ------------------------------------------------------------------ */
function facade(y0, ring, strip) {
  return (x, y, z, dx, dz, surf) => {
    if (!surf) return P.CONCRETE;
    const f = (y - y0) % 16;
    if (f === 15) return ring;
    if ((y - y0) % 3 === 0) return P.WHITE;
    if (dx < 1.1 || dz < 1.1) return strip;
    return P.WIN_OFFICE;
  };
}
VC.models.define('arcology', {
  variants: 1,
  gen(rng) {
    const g = K.grid(4, 4, 160);
    K.lot(g, P.CONCRETE_L);
    // two-tier podium with garden terraces
    rsq(g, 16, 1, 16, 15.6, 8, (x, y, z, dx, dz, surf) => (!surf ? P.CONCRETE : y === 8 ? P.WHITE : y % 4 === 0 ? P.WHITE : P.WIN_SHOP));
    rsq(g, 16, 8, 16, 14.8, 1, P.GRASS);
    rsq(g, 16, 9, 16, 15.2, 1, (x, y, z, dx, dz, surf) => (surf ? P.HEDGE : 0));
    rsq(g, 16, 9, 16, 12.6, 8, (x, y, z, dx, dz, surf) => (!surf ? P.CONCRETE : y % 4 === 0 ? P.WHITE : P.WIN_OFFICE));
    rsq(g, 16, 16, 16, 11.8, 1, P.GRASS);
    rsq(g, 16, 17, 16, 12.2, 1, (x, y, z, dx, dz, surf) => (surf ? P.HEDGE : 0));
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      K.tree(g, Math.floor(16 + Math.cos(a) * 13.9), 9, Math.floor(16 + Math.sin(a) * 13.9), k & 1 ? 'oak' : 'bush', 0.7);
    }
    // grand entrance
    g.box(12, 1, 29, 8, 6, 3, 0);
    g.box(12, 1, 28, 8, 6, 1, P.GLASS_DARK);
    g.box(11, 1, 31, 1, 7, 1, P.NEON_CYAN); g.box(20, 1, 31, 1, 7, 1, P.NEON_CYAN); g.box(11, 7, 31, 10, 1, 1, P.NEON_CYAN);
    // side towers (with bridges) and the stepped central tower
    rsq(g, 5, 17, 26, 3.4, 70, facade(17, P.NEON_PINK, P.GREEN));
    rsq(g, 5, 87, 26, 2.6, 1, P.GRASS_D);
    K.dome(g, 5, 87, 26, 2.2, P.GLASS_CYAN, 2.2);
    rsq(g, 27, 17, 6, 3.4, 90, facade(17, P.NEON_PURPLE, P.GREEN));
    rsq(g, 27, 107, 6, 3.0, 1, P.NEON_PURPLE);
    g.box(26, 108, 5, 2, 6, 2, P.METAL);
    K.beacon(g, 26, 114, 5, 0.8);
    const tiers = [[17, 7, 45], [62, 5.6, 40], [102, 4.4, 36]];
    for (const [ty, tr, th] of tiers) {
      rsq(g, 16, ty, 16, tr, th, facade(ty, P.NEON_CYAN, P.GRASS_D));
      rsq(g, 16, ty + th, 16, tr - 0.4, 1, P.GRASS_D);
    }
    for (const [ty, tr] of [[62, 7], [102, 5.6]]) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const tx = Math.floor(16 + Math.cos(a) * (tr - 0.8)), tz = Math.floor(16 + Math.sin(a) * (tr - 0.8));
        g.box(tx, ty, tz, 1, 2, 1, P.TRUNK);
        g.box(tx, ty + 2, tz, 1, 1, 1, P.GREEN);
      }
    }
    // sky bridges (glass tubes)
    K.beam(g, 6, 72, 23, 11, 72, 18, P.GLASS_CYAN, 3);
    K.beam(g, 23, 92, 6, 18, 92, 11, P.GLASS_CYAN, 3);
    K.beam(g, 7, 75, 24, 12, 75, 19, P.WHITE);
    K.beam(g, 24, 95, 7, 19, 95, 12, P.WHITE);
    // crown: glowing spire and halo
    const top = 138;
    for (let k = 0; k < 12; k++) g.cyl(16, top + k, 16, Math.max(0.6, 4.2 * (1 - k / 12)), 1, k % 3 === 2 ? P.NEON_PURPLE : P.GOLD);
    g.box(15, top + 12, 15, 2, 4, 2, P.CHROME);
    K.beacon(g, 16, top + 16, 16, 1.2);
    K.ring(g, 16, top + 3, 16, 6.2, 7.2, 1, P.NEON_CYAN);
    for (const [sx, sz] of [[16, 9], [16, 22], [9, 16], [22, 16]]) K.beam(g, sx, top + 3, sz, 16 + Math.sign(sx - 16) * 2, top + 1, 16 + Math.sign(sz - 16) * 2, P.METAL);
    // a few lit terrace lamps on the podium gardens
    for (const [lx, lz] of [[3, 16], [28, 16], [16, 3], [16, 28]]) K.lamp(g, lx, 9, lz, 3);
    g.light(16, top + 8, 16, K.LC.purple, 5, true);
    g.light(16, top + 3, 16, K.LC.cyan, 3.5, true);
    for (const [ly, lc] of [[32, K.LC.cyan], [77, K.LC.cyan], [117, K.LC.cyan]]) g.light(16, ly, 16, lc, 3);
    return K.fit(g);
  },
});
