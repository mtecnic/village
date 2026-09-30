/*
 * VOXELPOLIS — growable COMMERCIAL models (see grow.js for the toolkit & conventions).
 *   grow_C1  shops: corner stores, retro diners, cafés, bakeries, florists, gas stations,
 *            small offices, burger joints, pubs, pharmacies — shop windows, awnings, neon signs
 *   grow_C2  offices & retail: office blocks, department stores, hotels, malls, banks, glass
 *            offices, brick offices with billboards, cinemas, parking garages, deco offices
 *   grow_C3  skyscrapers: glass boxes, art-deco spires, setback towers, twisting towers,
 *            helipad towers, LED towers, gherkins, twin towers, tapered towers, shards
 * Level grows floors / signage / rooftop program; wealth moves from concrete & roll-down
 * shutters to marble, gold lettering, planters and glass.
 */
const P = VC.P, M = VC.M, K = VC.growKit;
const { lotCtx, walls, slots, winSlot, mirrorX, towerFloors, towerRect, plaza, lobby, roofTop, TOWER_WALL } = K;

/* ------------------------------------------------------------------ */
/* Shared commercial helpers                                           */
/* ------------------------------------------------------------------ */
const CPAL = {
  wall: [[P.CONCRETE, P.BRICK_D, P.CONCRETE_L, P.STONE, P.PLASTER], [P.BRICK, P.PLASTER_CREAM, P.BRICK_L, P.PLASTER, P.BRICK_Y, P.WOOD_L], [P.MARBLE, P.WHITE, P.SANDSTONE, P.BRICK_Y, P.PLASTER_CREAM]],
  awning: [P.AWNING_R, P.AWNING_G, P.AWNING_B, P.AWNING_Y],
};
/**
 * Shop building: ground-floor shop (4 tall) + o.floors upper floors (4 tall each).
 * o: { wall, upper, floors, win, door, doorU, awning: [c1, c2] | null, band (sign band color),
 *      sign (neon color) , signBg, sideWin, shutters (poor roll-down shutters), parapet }
 * Returns the y on top of the roof slab.
 */
function shop(c, x, z, w, d, o) {
  const g = c.g, fz = z + d;
  g.box(x, 1, z, w, 4, d, o.wall);
  const du = o.doorU != null ? o.doorU : w - 2;
  K.facade(g, x, 1, z, w, 4, d, (u, v, f, len) => {
    if (u === 0 || u === len - 1) return 0;
    if (f === 0) {
      if (v === 3) return o.band || 0;
      if (u === du) return v < 3 ? (o.door || P.GLASS_DARK) | K.RECESS : 0;
      if (o.shutters && v === 2) return P.METAL_D;
      return P.WIN_SHOP;
    }
    if (f === 1 && o.sideWin && v >= 1 && v <= 2) return P.WIN_SHOP;
    if (f === 2 && u === 1 && v < 2) return P.WOOD_D;
    return 0;
  });
  let top = 5;
  if (o.floors > 0) top = walls(c, x, 5, z, w, d, o.floors, { wall: o.upper || o.wall, trim: o.trim || P.WHITE, doorU: -1, win: o.win || P.WIN, recess: true, sills: o.sills || 0 });
  // awning over the shop window, sign band above it
  if (o.awning) K.awning(g, x + 1, 3, fz, w - 2, 2, o.awning[0], o.awning[1]);
  if (o.sign) K.sign(g, x + 1, 4, fz, w - 2, 1, o.sign, o.signBg || 0, c.rng, 0, true);
  // roof slab + parapet
  g.box(x, top, z, w, 1, d, P.CONCRETE_D);
  if (o.parapet !== false) K.ring(g, x, top + 1, z, w, d, o.upper || o.wall);
  return top + 1;
}
/** Sidewalk in front of the building plus curb furniture. */
function sidewalk(c, z0, opts = {}) {
  const g = c.g;
  g.box(0, 0, z0, c.W, 1, c.D - z0, c.Wl === 2 ? P.SANDSTONE : P.SIDEWALK);
  if (opts.bench && c.D - z0 >= 2) { g.box(1, 1, c.D - 1, 2, 1, 1, P.WOOD); }
  if (c.Wl && opts.planters !== false && c.W >= 8) {
    g.set(0, 1, c.D - 1, P.CONCRETE_L); g.set(0, 2, c.D - 1, c.Wl === 2 ? P.FLOWER_R : P.HEDGE);
  }
}
/** Tall sign pole with a neon board (always glowing). Returns the top y. */
function polesign(c, x, z, h, bw, bh, neon, frame = P.METAL_D) {
  const g = c.g;
  g.box(x, 1, z, 1, h, 1, frame);
  const bx = x - (bw >> 1);
  g.box(bx, h + 1, z, bw, bh, 1, frame);
  K.sign(g, bx, h + 1, z, bw, bh, neon, P.BLACK, c.rng, 0, true);
  g.box(bx, h + 1 + bh, z, bw, 1, 1, frame);
  return h + 2 + bh;
}
/** Rooftop AC units / vents scattered on a roof rect. */
function roofJunk(c, x, y, z, w, d, n = 2) {
  const g = c.g;
  for (let k = 0; k < n; k++) {
    const ax = x + ((M.hashU(k, 3, c.v) >> 4) % Math.max(1, w - 2)), az = z + ((M.hashU(k, 5, c.v) >> 4) % Math.max(1, d - 1));
    K.ac(g, ax, y, az, k & 1 ? 'x' : 'z');
  }
}

/* ================================================================== */
/* C1 — shops                                                          */
/* ================================================================== */
const C1_ARCH = [
  {
    name: 'corner',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const bd = D - 2, z0 = 0;
      const wall = c.pk(0, CPAL.wall);
      const aw = c.pk(1, CPAL.awning);
      const top = shop(c, 0, z0, W, bd, { wall, floors: c.L - 1, awning: c.Wl ? [aw, P.WHITE] : null, sign: c.pk(2, [P.NEON_RED, P.NEON_YELLOW, P.NEON_GREEN, P.SIGN_WHITE]), signBg: P.BLACK, band: P.BLACK, sideWin: true, shutters: c.Wl === 0, sills: c.Wl === 2 ? P.WOOD_D : 0 });
      sidewalk(c, bd, { bench: c.Wl > 0 });
      roofJunk(c, 1, top, 1, W - 2, bd - 2, 1 + c.L);
      if (c.L === 3 && W >= 8) K.billboard(g, 1, top + 3, bd - 2, W - 2, 4, c.rng, 0, 2);
      // crates of produce outside
      if (c.Wl) { g.set(W - 1, 1, bd, P.WOOD_L); g.set(W - 1, 2, bd, c.rng.pick([P.FLOWER_R, P.FLOWER_Y, P.LEAF_L])); }
    },
  },
  {
    name: 'diner',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const w = Math.min(W - 1, c.L === 1 ? 6 : 7 + ((W - 8) >> 1)), d = c.L === 1 ? 3 : 4, x = 1, z = 1;
      const body = c.pk(0, [[P.METAL, P.CONCRETE_L], [P.CHROME, P.WHITE, P.METAL], [P.CHROME, P.WHITE]]);
      const stripe = c.pk(1, [P.RED, P.ROOF_TEAL, P.PINK, P.AWNING_B, P.YELLOW]);
      g.box(0, 0, 0, W, 1, D, P.ASPHALT);
      K.prism(g, x, 1, z, w, 4, d, body, 'chamfer', 1);
      K.skin(g, x, 1, z, x + w, 5, z + d, (xx, yy) => (yy === 1 || yy === 4 ? stripe : P.WIN_SHOP));
      g.box(x + (w >> 1), 1, z + d - 1, 1, 3, 1, P.GLASS_DARK);
      g.box(x + (w >> 1) - 1, 1, z + d, 3, 3, 1, body); // vestibule
      g.box(x + (w >> 1), 1, z + d, 1, 2, 1, P.WIN_SHOP);
      g.box(x + 1, 5, z + 1, w - 2, 1, d - 2, P.METAL_D);
      K.chimney(g, x + w - 2, 5, z + 1, 1, P.METAL, 'steam', 0.3);
      // parking bays with cars in front
      for (let k = 0; k < (W >= 16 ? 4 : 2); k++) {
        const cx = x + k * 3 + (k > 0 ? 1 : 0);
        if (cx + 2 > W) break;
        if (M.hash(k, 1, c.v) < 0.75) K.car(g, cx, 1, D - 3, 'z', K.carColor(c.rng));
        g.set(cx + 2, 0, D - 3, P.ROAD_MARK);
      }
      // neon pole sign
      const neon = c.pk(2, [P.NEON_PINK, P.NEON_CYAN, P.NEON_RED, P.NEON_YELLOW]);
      const top = polesign(c, 0, D - 1, 4 + c.L * 2, 3, 2, neon);
      if (c.L >= 2) { g.set(0, top, D - 1, P.NEON_YELLOW); g.set(0, top + 1, D - 1, P.NEON_YELLOW); g.light(0.5, top + 1, D - 0.5, [1, 0.9, 0.3], 0.8); }
      if (c.L === 3) K.sign(g, x + 1, 6, z + d - 1, w - 2, 2, neon === P.NEON_PINK ? P.NEON_CYAN : P.NEON_PINK, 0, c.rng, 0, true);
      K.lamp(g, W - 1, 1, D - 1, 4, P.LAMP_WHITE, P.METAL_D, 0.6);
    },
  },
  {
    name: 'cafe',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const bd = D - 3;
      const pl = c.Wl === 0 ? [P.PLASTER, P.CONCRETE_L, P.BRICK_D] : K.paint().ALL.concat([P.PLASTER_PEACH, P.PLASTER_CREAM]);
      const wall = pl[c.ids[0] % pl.length];
      const aw = c.pk(1, CPAL.awning);
      const top = shop(c, 0, 0, W, bd, { wall, upper: c.Wl === 2 ? P.WHITE : wall, floors: c.L - 1, awning: [aw, P.WHITE], sign: P.SIGN_WHITE, band: P.WOOD_D, doorU: 1, sills: P.WOOD, door: P.WOOD_D });
      sidewalk(c, bd, { planters: false });
      // café tables with umbrellas
      for (let x = 2; x + 1 < W; x += 4) {
        K.umbrella(g, x, 1, D - 2, x % 8 === 2 ? aw : P.WHITE, aw);
        g.set(x - 1, 1, D - 2, P.WOOD_D); g.set(x + 1, 1, D - 2, P.WOOD_D);
      }
      // chalkboard
      g.set(0, 1, bd, P.BLACK);
      if (c.L === 3) { K.roofGarden(g, 1, top, 1, W - 2, bd - 2, c.rng); for (let x = 1; x < W - 1; x += 2) g.set(x, top + 2, bd - 1, P.LAMP); g.light(W / 2, top + 2, bd - 0.5, [1, 0.8, 0.5], 0.8); }
    },
  },
  {
    name: 'bakery',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const bd = D - 2;
      const wall = c.pk(0, [[P.BRICK_D, P.CONCRETE], [P.BRICK, P.BRICK_L, P.PLASTER_CREAM], [P.BRICK_Y, P.SANDSTONE, P.WHITE]]);
      const aw = c.pk(1, [P.AWNING_Y, P.AWNING_R, P.AWNING_B]);
      const top = shop(c, 0, 0, W, bd, { wall, floors: c.L - 1, awning: [aw, P.WHITE], sign: P.NEON_ORANGE, signBg: P.WOOD_D, band: P.WOOD_D, doorU: 1, shutters: c.Wl === 0 });
      sidewalk(c, bd, { bench: true });
      // bread display & oven chimney with a whiff of smoke
      g.box(3, 1, bd - 1, W - 5, 1, 1, P.WOOD_L);
      g.set(3, 2, bd - 1, P.SANDSTONE); g.set(5, 2, bd - 1, P.ORANGE);
      K.chimney(g, W - 2, top, 1, 3 + c.L, P.BRICK_D, 'smoke', 0.25);
      // hanging pretzel sign
      g.set(W - 1, 5, bd, P.METAL_D); g.set(W - 1, 4, bd + 1, P.SANDSTONE);
    },
  },
  {
    name: 'florist',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const bd = D - 3;
      const pt = K.paint();
      const wall = c.pk(0, [[P.CONCRETE, P.PLASTER], [pt.SAGE, P.GREEN, pt.TEAL, P.PLASTER_MINT], [pt.SAGE, P.WHITE, pt.TEAL]]);
      const top = shop(c, 0, 0, W, bd, { wall, upper: c.Wl === 2 ? P.WHITE : P.PLASTER_CREAM, floors: c.L - 1, awning: null, sign: P.NEON_GREEN, signBg: P.WOOD_D, band: P.WOOD_D, doorU: W - 2, sills: P.WOOD });
      // greenhouse bay window
      g.box(1, 1, bd, W - 4, 3, 1, P.GLASS_GREEN);
      g.box(1, 4, bd, W - 4, 1, 1, P.GLASS_GREEN);
      for (let x = 1; x < W - 3; x += 2) g.set(x, 1, bd, P.LEAF);
      sidewalk(c, bd, { planters: false });
      // flower buckets on crates along the sidewalk
      const fl = [P.FLOWER_R, P.FLOWER_Y, P.FLOWER_P, P.FLOWER_V, P.FLOWER_W];
      for (let x = 0; x < W - 2; x++) {
        g.set(x, 1, D - 2, P.WOOD_L);
        g.set(x, 2, D - 2, fl[(x + c.ids[3]) % fl.length]);
      }
      if (c.L >= 2) for (let x = 1; x < W - 1; x += 2) { g.set(x, 8, bd, P.LEAF_L); }
      if (c.L === 3) K.roofGarden(g, 1, top, 1, W - 2, bd - 2, c.rng);
    },
  },
  {
    name: 'gas',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      g.box(0, 0, 0, W, 1, D, P.ASPHALT);
      const brand = c.pk(0, [P.RED, P.GREEN, P.BLUE, P.YELLOW, P.ORANGE]);
      const neon = brand === P.GREEN ? P.NEON_GREEN : brand === P.BLUE ? P.NEON_BLUE : brand === P.YELLOW ? P.NEON_YELLOW : brand === P.ORANGE ? P.NEON_ORANGE : P.NEON_RED;
      // kiosk at the back
      const kw = Math.min(W - 2, 4 + c.L), kx = W - kw;
      g.box(kx, 1, 0, kw, 4, 3, P.WHITE);
      g.box(kx + 1, 1, 2, kw - 2, 3, 1, P.WIN_SHOP);
      g.box(kx, 4, 0, kw, 1, 3, brand);
      g.box(kx, 5, 0, kw, 1, 3, P.CONCRETE_D);
      // canopy on posts over the pumps
      const cx = 0, cz = 3, cw = Math.min(W, 7 + (W - 8)), cd = Math.min(4, D - 4);
      for (const [px, pz] of [[cx + 1, cz], [cx + cw - 2, cz], [cx + 1, cz + cd - 1], [cx + cw - 2, cz + cd - 1]]) g.box(px, 1, pz, 1, 4, 1, P.WHITE);
      g.box(cx, 5, cz, cw, 1, cd, P.WHITE);
      K.ring(g, cx, 5, cz, cw, cd, brand);
      g.box(cx + 1, 4, cz + 1, cw - 2, 1, cd - 2, P.LAMP_WHITE);
      g.light(cx + cw / 2, 4.2, cz + cd / 2, [0.9, 0.95, 1], 1.4);
      // pumps
      for (let k = 0; k < (W >= 16 ? 3 : 2); k++) {
        const px = cx + 2 + k * 3;
        g.box(px, 1, cz + 1, 1, 2, 1, brand);
        g.set(px, 2, cz + 1, P.SIGN_WHITE);
        if (M.hash(k, 4, c.v) < 0.6) K.car(g, px + 1, 1, cz, 'z', K.carColor(c.rng));
      }
      // price pole
      polesign(c, W - 1, D - 1, 3 + c.L, 1, 3, neon, brand);
      if (c.L >= 2) { g.box(kx + 1, 6, 0, 1, 1, 1, P.METAL_D); roofJunk(c, kx + 1, 6, 0, kw - 1, 2, 1); }
    },
  },
  {
    name: 'office',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const bd = D - 2;
      const wall = c.pk(0, [[P.CONCRETE, P.CONCRETE_L], [P.CONCRETE_L, P.PLASTER, P.BRICK], [P.WHITE, P.MARBLE, P.SANDSTONE]]);
      const F = c.L + 1;
      K.section(g, 0, 1, 0, W, bd, F, 4, { wall, win: P.WIN_OFFICE, spandrel: wall, trim: wall, style: 'ribbon' });
      // entrance
      g.box((W >> 1) - 1, 1, bd - 1, 2, 3, 1, P.GLASS_DARK);
      g.box((W >> 1) - 2, 4, bd, 4, 1, 1, P.CONCRETE_DD);
      const top = 1 + F * 4;
      g.box(0, top, 0, W, 1, bd, P.CONCRETE_D);
      K.sign(g, 1, top + 1, bd - 1, W - 2, 1, c.pk(1, [P.SIGN_WHITE, P.NEON_BLUE, P.NEON_CYAN]), 0, c.rng, 0, true);
      roofJunk(c, 1, top + 1, 1, W - 2, bd - 3, 2);
      sidewalk(c, bd, {});
      if (c.Wl === 2) { K.tree(g, 1, 1, D - 1, 1, 'round'); K.tree(g, W - 2, 1, D - 1, 1, 'round'); }
    },
  },
  {
    name: 'burger',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      g.box(0, 0, 0, W, 1, D, P.ASPHALT);
      const red = c.pk(0, [P.RED, P.ORANGE, P.CAR_RED]), yel = c.pk(1, [P.YELLOW, P.CREAM, P.WHITE]);
      const w = Math.min(W - 1, 6 + (W - 8)), d = 4, x = 0, z = 1;
      g.box(x, 1, z, w, 4, d, red);
      K.facade(g, x, 1, z, w, 4, d, (u, v, f, len) => (u > 0 && u < len - 1 && v >= 1 && v <= 2 ? P.WIN_SHOP : v === 3 ? yel : 0));
      g.box(x + 1, 1, z + d - 1, 1, 3, 1, P.GLASS_DARK);
      // mansard-ish roof band
      g.box(x - 0, 5, z, w, 1, d, yel);
      g.box(x + 1, 6, z + 1, w - 2, 1, d - 2, red);
      // roof sign (glowing arches)
      const sx = x + (w >> 1) - 2;
      g.box(sx, 7, z + 1, 1, 3, 1, P.NEON_YELLOW); g.box(sx + 2, 7, z + 1, 1, 3, 1, P.NEON_YELLOW); g.box(sx + 4, 7, z + 1, 1, 3, 1, P.NEON_YELLOW);
      g.box(sx, 10, z + 1, 5, 1, 1, P.NEON_YELLOW); g.set(sx + 1, 10, z + 1, 0); g.set(sx + 3, 10, z + 1, 0);
      g.box(sx + 1, 10, z + 1, 1, 1, 1, P.NEON_YELLOW); g.box(sx + 3, 10, z + 1, 1, 1, 1, P.NEON_YELLOW);
      g.light(sx + 2.5, 9, z + 1.5, [1, 0.85, 0.2], 1.1);
      // drive-thru lane on the side
      for (let zz = 0; zz < D; zz++) g.set(W - 1, 0, zz, zz % 2 ? P.ASPHALT : P.HAZARD_Y);
      g.box(w - 1, 2, z + 1, 1, 1, 1, P.WIN_SHOP);
      // parking + car
      K.car(g, 1, 1, D - 3, 'z', K.carColor(c.rng));
      if (c.L >= 2) K.car(g, 4, 1, D - 3, 'z', K.carColor(c.rng));
      if (c.L === 3) polesign(c, W - 2, D - 1, 7, 3, 2, P.NEON_RED, P.METAL_D);
    },
  },
  {
    name: 'pub',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const bd = D - 2;
      const pt = K.paint();
      const front = c.pk(0, [[P.WOOD_D, P.BLACK], [P.WOOD_D, P.GREEN, P.NAVY, pt.PLUM, P.RED], [P.NAVY, P.BLACK, P.GREEN, P.WOOD_D]]);
      const upper = c.pk(1, CPAL.wall);
      const top = shop(c, 0, 0, W, bd, { wall: front, upper, floors: c.L - 1, awning: null, sign: c.Wl === 2 ? P.GOLD : P.NEON_ORANGE, signBg: front, band: front, doorU: W >> 1, door: P.WOOD, sills: P.WOOD_D });
      // small-paned windows: glazing bars
      for (let x = 1; x < W - 1; x++) if (x !== W >> 1) g.set(x, 2, bd - 1, front);
      // lanterns beside the door
      K.wallLight(g, (W >> 1) - 1, 3, bd, P.LAMP, 0.5);
      K.wallLight(g, (W >> 1) + 1, 3, bd, P.LAMP, 0.5);
      // hanging sign bracket
      g.set(0, 5, bd, P.BLACK); g.set(0, 4, bd + 1, c.pk(2, [P.RED, P.GREEN, P.GOLD]));
      sidewalk(c, bd, { bench: true });
      g.set(W - 1, 1, bd, P.WOOD_D); // beer barrel
      roofJunk(c, 1, top, 1, W - 2, bd - 2, 1);
      if (c.L >= 2) K.chimney(g, 0, top - 1, 1, 3, P.BRICK_D);
    },
  },
  {
    name: 'pharmacy',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const bd = D - 2;
      const wall = c.pk(0, [[P.CONCRETE_L, P.PLASTER], [P.WHITE, P.PLASTER_SKY, P.CONCRETE_L], [P.WHITE, P.MARBLE]]);
      const neon = c.pk(1, [P.NEON_GREEN, P.NEON_GREEN, P.NEON_BLUE, P.NEON_CYAN]);
      const top = shop(c, 0, 0, W, bd, { wall, floors: c.L - 1, awning: null, sign: neon, signBg: 0, band: wall, doorU: 1, win: P.WIN_COOL });
      // glowing cross blade sign on the corner
      const sx = W - 2, sy = 5 + (c.L > 1 ? 2 : 0), sz = bd;
      g.box(sx, sy, sz, 1, 3, 1, neon);
      g.box(sx - 1, sy + 1, sz, 3, 1, 1, neon);
      g.light(sx + 0.5, sy + 1.5, sz + 0.8, K.glowRGB(neon), 0.9);
      sidewalk(c, bd, {});
      roofJunk(c, 1, top, 1, W - 2, bd - 2, 2);
      if (c.Wl === 0) for (let x = 2; x < W - 1; x += 2) g.set(x, 2, bd - 1, P.METAL_D); // security bars
    },
  },
];

/* ================================================================== */
/* C2 — offices & retail (4 voxels per floor)                          */
/* ================================================================== */
function c2Floors(c) {
  const small = Math.max(c.W, c.D) <= 8;
  return M.clamp([0, small ? 4 : 5, small ? 6 : 9, small ? 9 : 13][c.L] + (c.ids[9] % 3) - 1, 3, 16);
}
/** Main building rect: full width on small lots (street wall), inset on big ones. */
function c2Rect(c, maxW = 16, maxD = 14) {
  if (c.W <= 8) return { x: 0, z: 0, w: c.W, d: c.D - 2 };
  return towerRect(c, 1, maxW, maxD);
}
const OFFICE_WALL = [[P.CONCRETE, P.CONCRETE_L, P.STONE], [P.CONCRETE_L, P.STONE, P.BRICK_Y, P.WHITE], [P.WHITE, P.MARBLE, P.SANDSTONE]];

const C2_ARCH = [
  {
    name: 'office',
    build(c) {
      const g = c.g, F = c2Floors(c), t = c2Rect(c);
      plaza(c, t, c.Wl === 2);
      const wall = c.pk(0, OFFICE_WALL);
      let y = lobby(c, t.x, 1, t.z, t.w, t.d, wall, 5);
      K.section(g, t.x, y, t.z, t.w, t.d, F - 1, 4, { wall, win: P.WIN_OFFICE, spandrel: wall, trim: wall, style: 'ribbon' });
      y += (F - 1) * 4;
      g.box(t.x, y, t.z, t.w, 1, t.d, P.CONCRETE_D);
      K.ring(g, t.x, y + 1, t.z, t.w, t.d, wall);
      if (t.w >= 14 && t.d >= 12) K.roofDress(g, t.x + 1, y + 1, t.z + 1, t.w - 2, t.d - 3, c.ids[6], c.Wl === 2, false);
      else {
        K.hvac(g, t.x + 1, y + 1, t.z + 1, Math.min(4, t.w - 2), Math.min(4, t.d - 2));
        if (t.w >= 8) K.penthouse(g, t.x + t.w - 4, y + 1, t.z + 1, 3, 3, 3);
      }
      if (c.L >= 2) K.sign(g, t.x + 1, y + 1, t.z + t.d - 1, t.w - 2, 2, c.pk(1, [P.SIGN_WHITE, P.NEON_BLUE, P.NEON_CYAN, P.NEON_RED]), 0, c.rng, 0, true);
    },
  },
  {
    name: 'dept',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const F = M.clamp(c2Floors(c) - 2, 2, 7), bd = D - 2, t = { x: 0, z: 0, w: W, d: bd };
      const wall = c.pk(0, [[P.CONCRETE, P.BRICK_D], [P.BRICK_Y, P.SANDSTONE, P.BRICK, P.CONCRETE_L], [P.MARBLE, P.SANDSTONE, P.WHITE]]);
      const acc = c.pk(1, [[P.CONCRETE_D], [P.BRICK_D, P.CONCRETE_D, P.STEEL_BLUE], [P.GOLD, P.BRICK_D, P.COPPER_GREEN]]);
      g.box(0, 0, bd, W, 1, D - bd, P.SIDEWALK);
      g.box(0, 1, 0, W, 5 + (F - 1) * 4, bd, wall);
      // display windows + awnings
      K.facade(g, 0, 1, 0, W, 5, bd, (u, v, f, len) => (u > 0 && u < len - 1 && v < 4 && f !== 2 ? (u % 4 === 0 ? 0 : P.WIN_SHOP) : v === 4 ? acc : 0));
      for (let x = 1; x + 3 <= W; x += 4) K.awning(g, x, 4, bd, 3, 1, CPAL.awning[(x >> 2) % 4], P.WHITE);
      // upper floors: blank panels with vertical ribs, windows only on the top floor
      K.facade(g, 0, 6, 0, W, (F - 1) * 4, bd, (u, v, f, len) => {
        const top = v >= (F - 2) * 4;
        if (u % 4 === 0) return acc;
        if (top && v % 4 >= 1 && v % 4 <= 2 && u % 2) return P.WIN;
        return 0;
      });
      const topY = 6 + (F - 1) * 4;
      g.box(0, topY, 0, W, 1, bd, acc);
      // vertical blade sign on the front corner
      const neon = c.pk(2, [P.NEON_RED, P.NEON_PINK, P.NEON_YELLOW, P.NEON_CYAN]);
      const bh = Math.min(topY - 6, 12);
      for (let k = 0; k < bh; k++) g.set(1, 6 + k, bd, k % 3 === 2 ? P.BLACK : neon);
      g.box(1, 6 + bh, bd, 1, 1, 1, P.METAL_D);
      g.light(1.5, 6 + bh / 2, bd + 0.8, K.glowRGB(neon), 1.1);
      if (c.L >= 2 && W >= 8) K.billboard(g, 2, topY + 3, bd - 3, Math.min(W - 4, 10), 4, c.rng, 0, 2);
      else roofJunk(c, 1, topY + 1, 1, W - 2, bd - 2, 2);
      if (W >= 16 && bd >= 12) K.roofDress(g, 1, topY + 1, 1, W - 2, bd - 6, c.ids[6], c.Wl === 2, false);
    },
  },
  {
    name: 'hotel',
    build(c) {
      const g = c.g, F = c2Floors(c) + 1;
      const t = c.W <= 8 ? { x: 0, z: 1, w: c.W, d: c.D - 3 } : towerRect(c, 1, 16, 8);
      plaza(c, t, c.Wl === 2);
      const wall = c.pk(0, [[P.CONCRETE_L, P.PLASTER], [P.PLASTER_PEACH, P.WHITE, P.PLASTER_CREAM, P.PLASTER_SKY], [P.WHITE, P.MARBLE, P.SANDSTONE]]);
      let y = lobby(c, t.x, 1, t.z, t.w, t.d, P.GLASS_DARK, 5);
      K.section(g, t.x, y, t.z, t.w, t.d, F - 1, 3, { wall, win: P.WIN, style: 'punched' });
      for (let f = 0; f < F - 1; f++) K.balconies(g, t.x, y + f * 3, t.z, t.w, t.d, wall, c.Wl === 2 ? P.GLASS_CYAN : P.METAL, 'rect', 1, 1);
      y += (F - 1) * 3;
      g.box(t.x, y, t.z, t.w, 1, t.d, P.CONCRETE_D);
      // entrance canopy to the curb with lights
      const fz = t.z + t.d, m = t.x + (t.w >> 1);
      g.box(m - 2, 4, fz, 5, 1, c.D - fz, c.pk(1, [P.RED, P.NAVY, P.GOLD, P.GREEN]));
      g.box(m - 2, 1, c.D - 1, 1, 3, 1, P.GOLD); g.box(m + 2, 1, c.D - 1, 1, 3, 1, P.GOLD);
      g.light(m + 0.5, 3.8, fz + 1, [1, 0.85, 0.55], 1.0);
      // rooftop sign
      const neon = c.pk(2, [P.NEON_RED, P.NEON_PINK, P.NEON_CYAN, P.NEON_YELLOW]);
      K.sign(g, t.x + 1, y + 2, t.z + t.d - 1, t.w - 2, 2, neon, P.BLACK, c.rng, 0, true);
      for (let x = t.x + 1; x < t.x + t.w - 1; x += 3) g.set(x, y + 1, t.z + t.d - 1, P.METAL_D);
      if (c.Wl === 2 && t.d >= 6 && t.w >= 7) K.roofPool(g, t.x + 1, y + 1, t.z, Math.min(t.w - 2, 7), t.d - 1);
      else if (t.d >= 5) roofJunk(c, t.x + 1, y + 1, t.z, t.w - 2, t.d - 2, 2);
      // flags at the entrance
      if (c.W >= 16) for (let k = 0; k < 3; k++) { const x = t.x + 1 + k * 2; g.box(x, 1, c.D - 1, 1, 5, 1, P.METAL); g.set(x + 0, 6, c.D - 1, [P.RED, P.BLUE, P.YELLOW][k]); }
    },
  },
  {
    name: 'mall',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const big = W >= 16 && D >= 16;
      const d = big ? D - 7 : D - 2, z = 0, F = big ? M.clamp(c.L + 1, 2, 3) : c.L === 3 ? 2 : 1;
      const wall = c.pk(0, [[P.CONCRETE, P.CONCRETE_L], [P.SANDSTONE, P.CONCRETE_L, P.PLASTER_CREAM, P.BRICK_Y], [P.WHITE, P.MARBLE, P.SANDSTONE]]);
      const acc = c.pk(1, [P.RED, P.BLUE, P.ORANGE, P.GREEN, P.PURPLE]);
      g.box(0, 1, z, W, F * 4, d, wall);
      K.facade(g, 0, 1, z, W, F * 4, d, (u, v, f, len) => (v % 4 === 3 ? acc : f === 0 && v < 3 && u > 0 && u < len - 1 && u % 5 !== 0 ? P.WIN_SHOP : 0));
      const top = 1 + F * 4;
      g.box(0, top, z, W, 1, d, P.CONCRETE_D);
      // skylight vault along x
      const vd = Math.max(3, d - 4);
      K.roof(g, 1, top + 1, z + ((d - vd) >> 1), W - 2, vd, { type: 'barrel', c: P.GLASS_CYAN, fill: P.GLASS_CYAN, pitch: 0.8, oh: 0 });
      for (let x = 2; x < W - 2; x += 3) K.roof(g, x, top + 1, z + ((d - vd) >> 1), 1, vd, { type: 'barrel', c: P.METAL, fill: P.METAL, pitch: 0.8, oh: 0 });
      // entrance portal + sign
      const m = W >> 1;
      g.box(m - 2, 1, d - 1, 4, Math.min(F * 4, 6), 1, P.GLASS_DARK);
      g.box(m - 3, Math.min(F * 4, 6) + 1, d - 1, 6, 2, 1, acc);
      K.sign(g, m - 2, Math.min(F * 4, 6) + 1, d, 4, 2, P.SIGN_WHITE, 0, c.rng, 0, true);
      if (big) {
        K.parking(g, 0, d + 1, W, D - d - 1, c.rng, 0.55);
        K.lamp(g, 0, 1, D - 1, 4, P.LAMP_WHITE, P.METAL_D, 0.8);
        K.lamp(g, W - 1, 1, D - 1, 4, P.LAMP_WHITE, P.METAL_D, 0.8);
        g.box(0, 0, d, W, 1, 1, P.SIDEWALK);
        if (c.L >= 2) K.billboard(g, W - 7, top + 5, z + 1, 6, 4, c.rng, 0, 2);
      } else g.box(0, 0, d, W, 1, D - d, P.SIDEWALK);
    },
  },
  {
    name: 'bank',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const stone = c.pk(0, [[P.CONCRETE_L, P.STONE], [P.SANDSTONE, P.STONE, P.MARBLE], [P.MARBLE, P.WHITE]]);
      const gold = c.Wl === 0 ? P.CONCRETE_D : P.GOLD;
      const bd = D - 3, x0 = W >= 16 ? 1 : 0, w = W - 2 * x0;
      g.box(0, 0, 0, W, 1, D, P.SIDEWALK);
      // podium with steps
      g.box(x0, 1, 0, w, 1, bd + 1, stone);
      g.box(x0 + 1, 1, bd + 1, w - 2, 1, 1, stone);
      const H = 4 + c.L * 2 + (W >= 16 ? 2 : 0);
      g.box(x0, 2, 0, w, H, bd - 1, stone);
      K.facade(g, x0, 2, 0, w, H, bd - 1, (u, v, f, len) => (f !== 0 && u % 3 === 1 && v >= 2 && v < H - 2 ? P.WIN | K.RECESS : 0), 14);
      g.box(x0 + 2, 2, bd - 2, w - 4, H - 2, 1, P.WIN_SHOP);
      g.box((W >> 1) - 1, 2, bd - 2, 2, 3, 1, P.WOOD_D);
      // colonnade
      for (let x = x0; x < x0 + w; x += 2) g.box(x, 2, bd - 1, 1, H, 1, P.MARBLE === stone ? P.WHITE : P.MARBLE);
      g.box(x0, 2 + H, 0, w, 1, bd, stone); // entablature
      g.box(x0 + 1, 1 + H, bd - 1, w - 2, 1, 1, gold);
      // pediment
      const pt = K.roof(g, x0, 3 + H, 0, w, bd, { type: 'gable', c: stone, fill: stone, pitch: 0.5, oh: 0 });
      g.set(W >> 1, 3 + H, bd - 1, gold);
      if ((c.L === 3 || c.Wl === 2) && w >= 8) {
        // dome on a drum
        const cx = W / 2, cz = bd / 2;
        g.cyl(cx, pt - 1, cz, Math.min(4, w / 3), 3, stone);
        g.ellipsoid(cx, pt + 2, cz, Math.min(3.6, w / 3 - 0.4), 3, Math.min(3.6, w / 3 - 0.4), c.Wl === 2 ? P.GOLD : P.COPPER_GREEN);
        g.set(Math.floor(cx), pt + 5, Math.floor(cz), P.GOLD);
      }
      K.lamp(g, x0, 1, D - 1, 3, P.LAMP, P.BLACK, 0.55);
      K.lamp(g, x0 + w - 1, 1, D - 1, 3, P.LAMP, P.BLACK, 0.55);
    },
  },
  {
    name: 'glass',
    build(c) {
      const g = c.g, F = c2Floors(c), t = c2Rect(c, 14, 12);
      plaza(c, t, c.Wl === 2);
      const glass = c.pk(0, TOWER_WALL.glass), frame = c.pk(1, [[P.CONCRETE_D], [P.METAL, P.CONCRETE_L, P.BLACK], [P.CHROME, P.GOLD, P.WHITE]]);
      let y = lobby(c, t.x, 1, t.z, t.w, t.d, frame, 5);
      const Fm = Math.max(1, F - 3);
      K.section(g, t.x, y, t.z, t.w, t.d, Fm, 4, { wall: glass, glass, win: P.WIN_OFFICE, mullion: frame, mstep: 3, style: 'curtain' });
      y += Fm * 4;
      // cantilevered top floors (stick out 1 on the front and back)
      const cz = Math.max(0, t.z - 1), cd = Math.min(c.D - cz, t.d + 2);
      K.section(g, t.x, y, cz, t.w, cd, F - Fm - 1 > 0 ? F - Fm - 1 : 1, 4, { wall: frame, win: P.WIN_OFFICE, style: 'ribbon', trim: frame, spandrel: frame });
      y += (F - Fm - 1 > 0 ? F - Fm - 1 : 1) * 4;
      g.box(t.x, y, cz, t.w, 1, cd, frame);
      if (c.Wl >= 1 && t.w >= 5) K.roofGarden(g, t.x + 1, y + 1, cz + 1, t.w - 2, cd - 2, c.rng);
      else K.hvac(g, t.x + 1, y + 1, cz + 1, Math.min(4, t.w - 2), Math.min(4, cd - 2));
    },
  },
  {
    name: 'brickoffice',
    build(c) {
      const g = c.g, F = c2Floors(c) - 1, t = c2Rect(c, 16, 12);
      plaza(c, t, false);
      const brick = c.pk(0, [[P.BRICK_D, P.BRICK], [P.BRICK, P.BRICK_L, P.BRICK_D], [P.BRICK_L, P.BRICK_Y]]);
      g.box(t.x, 1, t.z, t.w, F * 4 + 1, t.d, brick);
      K.facade(g, t.x, 1, t.z, t.w, F * 4, t.d, (u, v, f, len) => {
        const r = v % 4, fl = (v / 4) | 0;
        if (u <= 0 || u >= len - 1 || u % 3 === 0) return 0;
        if (fl === 0 && f === 0) return r < 3 ? P.WIN_SHOP : P.BLACK;
        if (r >= 1 && r <= 2) return P.WIN_OFFICE;
        return r === 3 ? P.BLACK : 0;
      });
      const top = 1 + F * 4;
      g.box(t.x, top, t.z, t.w, 1, t.d, P.CONCRETE_D);
      K.ring(g, t.x, top + 1, t.z, t.w, t.d, brick);
      if (t.w >= 8 && t.d >= 6 && c.L >= 2) K.waterTank(g, t.x + 1, top + 1, t.z + 1, P.WOOD_D);
      K.billboard(g, t.x + (t.w >= 12 ? 5 : 1), top + 4, t.z + t.d - 2, Math.min(t.w - 2, 9), 4, c.rng, 0, 2);
      g.box(t.x + (t.w >> 1), 1, t.z + t.d - 1, 1, 3, 1, P.STEEL_BLUE);
    },
  },
  {
    name: 'cinema',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const bd = D - 3, F = M.clamp(c.L + 1, 2, 4);
      const wall = c.pk(0, [[P.CONCRETE, P.BRICK_D], [P.BRICK, P.PLASTER_CREAM, P.BRICK_Y], [P.MARBLE, P.SANDSTONE, P.WHITE]]);
      g.box(0, 0, bd, W, 1, D - bd, P.SIDEWALK);
      g.box(0, 1, 0, W, F * 4 + 1, bd, wall);
      // fly tower at the back
      g.box(1, F * 4 + 2, 0, W - 2, 4, Math.max(2, bd >> 1), wall);
      // front: posters & doors
      K.facade(g, 0, 1, 0, W, 4, bd, (u, v, f, len) => {
        if (f !== 0 || u <= 0 || u >= len - 1) return 0;
        if (Math.abs(u - len / 2 + 0.5) < 1.5) return v < 3 ? P.GLASS_DARK : 0;
        return v >= 1 && v <= 2 ? [P.NEON_PINK, P.NEON_CYAN, P.NEON_YELLOW, P.NEON_BLUE][u % 4] : 0;
      });
      // marquee with chaser bulbs
      const my = 5;
      g.box(0, my, bd, W, 2, 2, P.BLACK);
      for (let x = 0; x < W; x++) { g.set(x, my + 2, bd, x % 2 ? P.NEON_YELLOW : P.SIGN_WHITE); g.set(x, my - 1, bd + 1, x % 2 ? P.SIGN_WHITE : P.NEON_YELLOW); }
      K.sign(g, 1, my, bd + 2, W - 2, 2, P.NEON_RED, P.SIGN_WHITE, c.rng, 0, true);
      // vertical blade sign
      const bh = Math.min(F * 4 - 3, 10), bx = W >> 1;
      for (let k = 0; k < bh; k++) { g.set(bx, my + 3 + k, bd, k % 2 ? P.NEON_RED : P.SIGN_WHITE); }
      g.set(bx, my + 3 + bh, bd, P.NEON_YELLOW);
      g.light(bx + 0.5, my + 3 + bh / 2, bd + 1, [1, 0.4, 0.4], 1.2);
      roofJunk(c, 1, F * 4 + 2, Math.max(2, bd >> 1) + 1, W - 2, 2, 2);
    },
  },
  {
    name: 'garage',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const bd = D - 2, F = M.clamp(c.L + 2, 3, 6), fh = 3;
      g.box(0, 0, bd, W, 1, D - bd, P.SIDEWALK);
      // ground floor shops
      g.box(0, 1, 0, W, 3, bd, P.CONCRETE);
      K.facade(g, 0, 1, 0, W, 3, bd, (u, v, f, len) => (f === 0 && u > 0 && u < len - 1 && v < 2 ? (u === 1 ? P.CONCRETE_DD : P.WIN_SHOP) : v === 2 ? P.CONCRETE_D : 0));
      g.box(1, 1, bd - 1, 2, 2, 1, P.CONCRETE_DD); // car entrance
      // open decks with cars
      for (let f = 0; f < F; f++) {
        const y = 4 + f * fh;
        g.box(0, y, 0, W, 1, bd, P.CONCRETE_L);
        K.ring(g, 0, y + 1, 0, W, bd, P.CONCRETE);
        for (let x = 0; x < W; x += 4) for (let z = 0; z < bd; z += Math.max(1, bd - 1)) g.box(x, y + 1, z, 1, fh - 1, 1, P.CONCRETE);
        for (let x = 1; x + 2 < W; x += 3) if (M.hash(x, f, c.v) < 0.55) K.car(g, x, y + 1, 1 + ((x >> 1) % 2), 'z', K.carColor(c.rng));
        g.set(W - 1, y + 1, bd - 1, P.HAZARD_Y);
      }
      const top = 4 + F * fh;
      g.box(0, top, 0, W, 1, bd, P.CONCRETE_L);
      K.ring(g, 0, top + 1, 0, W, bd, P.CONCRETE);
      // open top deck: bay stripes + a few cars
      for (let z = 1; z + 3 < bd; z += 4)
        for (let x = 1; x + 2 < W - 3; x += 3) {
          g.set(x + 2, top, z, P.ROAD_MARK);
          if (M.hash(x, z, c.v + 17) < 0.4) K.car(g, x, top + 1, z, 'z', K.carColor(c.rng));
        }
      K.lamp(g, 1, top + 1, 1, 3, P.LAMP_WHITE, P.METAL_D, 0.7);
      if (W >= 8) K.lamp(g, W - 2, top + 1, bd - 2, 3, P.LAMP_WHITE, P.METAL_D, 0.7);
      // stair tower with the P sign
      g.box(W - 3, 1, bd - 3, 3, top + 2, 3, P.CONCRETE_D);
      g.box(W - 3, 4, bd - 1, 1, top - 4, 1, P.WIN_COOL);
      g.box(W - 2, top - 3, bd, 1, 3, 1, P.NEON_BLUE);
      g.light(W - 1.5, top - 1.5, bd + 0.8, [0.3, 0.5, 1], 0.9);
    },
  },
  {
    name: 'decooffice',
    build(c) {
      const g = c.g, F = c2Floors(c), t = c2Rect(c, 14, 12);
      plaza(c, t, c.Wl === 2);
      const wall = c.pk(0, TOWER_WALL.stone), trim = c.Wl === 2 ? P.GOLD : P.CONCRETE_DD;
      let y = lobby(c, t.x, 1, t.z, t.w, t.d, wall, 5);
      const F1 = Math.max(2, F - 3);
      K.section(g, t.x, y, t.z, t.w, t.d, F1, 4, { wall, win: P.WIN_OFFICE, spandrel: trim === P.GOLD ? P.CONCRETE_DD : P.CONCRETE_DD, style: 'deco' });
      y += F1 * 4;
      g.box(t.x, y, t.z, t.w, 1, t.d, wall);
      const r1 = { x: t.x + 1, z: t.z + 1, w: t.w - 2, d: t.d - 2 };
      K.section(g, r1.x, y + 1, r1.z, r1.w, r1.d, 2, 4, { wall, win: P.WIN_OFFICE, spandrel: P.CONCRETE_DD, style: 'deco' });
      y += 9;
      g.box(r1.x, y, r1.z, r1.w, 1, r1.d, trim);
      const r2 = { x: r1.x + 1, z: r1.z + 1, w: Math.max(2, r1.w - 2), d: Math.max(2, r1.d - 2) };
      g.box(r2.x, y + 1, r2.z, r2.w, 3, r2.d, wall);
      K.facade(g, r2.x, y + 1, r2.z, r2.w, 3, r2.d, (u, v) => (u % 2 && v < 2 ? P.LAMP_WHITE : 0));
      K.spire(g, r2.x + r2.w / 2, y + 4, r2.z + r2.d / 2, Math.min(2, r2.w / 2), trim === P.GOLD ? P.GOLD : wall, 4);
      g.light(t.x + t.w / 2, y + 2, t.z + t.d / 2, [1, 0.9, 0.7], 1.4);
    },
  },
];

/* ================================================================== */
/* C3 — skyscrapers (3 voxels per floor, 60..150 voxels tall)          */
/* ================================================================== */
function c3Floors(c) {
  let F = [0, 20, 30, 40][c.L] + (c.ids[9] % 5) - 2;
  if (Math.max(c.W, c.D) <= 8) F = Math.round(F * 0.7);
  return M.clamp(F, 12, 42);
}
/** Tower rect for skyscrapers: 1x1 -> 6x6, 2x2 -> up to 12x12, 3x3 -> up to 16x16. */
function c3Rect(c, maxS = 16) {
  const m = c.W <= 8 ? 1 : 2;
  return towerRect(c, m, Math.min(maxS, c.W >= 24 ? 16 : 12), Math.min(maxS, c.D >= 24 ? 16 : 12));
}
/** Double-height colonnaded lobby (h voxels). */
function grandLobby(c, t, frame, h = 6) {
  const g = c.g;
  g.box(t.x, 1, t.z, t.w, h, t.d, frame);
  K.facade(g, t.x, 1, t.z, t.w, h, t.d, (u, v, f, len) => (u % 2 && u < len - 1 && v < h - 1 ? P.GLASS_DARK | K.RECESS : 0));
  if (t.z + t.d < c.D) g.box(t.x + (t.w >> 1) - 1, 1, t.z + t.d - 1, 2, 3, 1, P.WIN_SHOP);
  return 1 + h;
}
/** Mast + beacon on top when the building is tall; returns top y. */
function mast(c, x, y, z, maxH = 16) {
  const h = Math.min(maxH, 149 - y);
  if (h < 4) return y;
  K.antenna(c.g, x, y, z, h, true);
  return y + h;
}
/** Filled rotated square (side s, angle a) centred at (cx, cz), rows y..y+h-1. */
function rotSquare(g, cx, cz, s, a, y, h, col) {
  const ca = Math.cos(a), sa = Math.sin(a), R = s * 0.75;
  const hs = s / 2;
  for (let z = Math.floor(cz - R); z <= Math.ceil(cz + R); z++)
    for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
      const dx = x + 0.5 - cx, dz = z + 0.5 - cz;
      const u = dx * ca + dz * sa, w = -dx * sa + dz * ca;
      if (Math.abs(u) <= hs && Math.abs(w) <= hs) g.box(x, y, z, 1, h, 1, col);
    }
}

const C3_ARCH = [
  {
    name: 'glassbox',
    build(c) {
      const g = c.g, F = c3Floors(c), t = c3Rect(c);
      plaza(c, t, c.Wl === 2);
      const glass = c.pk(0, [[P.GLASS_DARK, P.GLASS_BLUE], [P.GLASS_DARK, P.GLASS_BLUE, P.GLASS_TEAL], [P.GLASS_DARK, P.GLASS_GOLD, P.GLASS_TEAL]]);
      const mull = c.pk(1, [[P.METAL_D], [P.METAL_D, P.METAL, P.BLACK], [P.GOLD, P.CHROME, P.GOLD]]);
      let y = grandLobby(c, t, mull);
      K.section(g, t.x, y, t.z, t.w, t.d, F, 3, { wall: glass, glass, win: P.WIN_OFFICE, mullion: mull, mstep: 2, style: 'curtain' });
      y += F * 3;
      // mechanical crown: louvre bands
      g.box(t.x, y, t.z, t.w, 4, t.d, P.METAL_D);
      K.facade(g, t.x, y, t.z, t.w, 4, t.d, (u, v) => (v % 2 ? P.GLASS_DARK : 0));
      g.box(t.x, y + 4, t.z, t.w, 1, t.d, mull);
      y += 5;
      if (c.L >= 2) K.crownBand(g, t.x, y - 1, t.z, t.w, t.d, c.pk(2, [P.LAMP_WHITE, P.NEON_CYAN, P.LAMP_WHITE]));
      if (y > 70) mast(c, t.x + 1, y, t.z + 1, 14);
    },
  },
  {
    name: 'chrysler',
    build(c) {
      const g = c.g, F = c3Floors(c), t = c3Rect(c, 12);
      plaza(c, t, c.Wl === 2);
      const stone = c.pk(0, [[P.CONCRETE_L, P.STONE], [P.WHITE, P.CONCRETE_L, P.SANDSTONE], [P.WHITE, P.MARBLE]]);
      const metal = c.Wl === 0 ? P.METAL : P.CHROME;
      let y = grandLobby(c, t, stone, 5);
      const f1 = Math.ceil(F * 0.5), f2 = Math.ceil(F * 0.3), f3 = F - f1 - f2;
      K.section(g, t.x, y, t.z, t.w, t.d, f1, 3, { wall: stone, win: P.WIN_OFFICE, spandrel: P.CONCRETE_DD, style: 'deco' });
      y += f1 * 3;
      g.box(t.x, y, t.z, t.w, 1, t.d, stone);
      for (const [a, b] of [[t.x, t.z], [t.x + t.w - 1, t.z], [t.x, t.z + t.d - 1], [t.x + t.w - 1, t.z + t.d - 1]]) g.set(a, y + 1, b, metal); // eagles
      const r1 = { x: t.x + 1, z: t.z + 1, w: t.w - 2, d: t.d - 2 };
      K.section(g, r1.x, y + 1, r1.z, r1.w, r1.d, f2, 3, { wall: stone, win: P.WIN_OFFICE, spandrel: P.CONCRETE_DD, style: 'deco' });
      y += 1 + f2 * 3;
      const r2 = { x: r1.x + 1, z: r1.z + 1, w: Math.max(3, r1.w - 2), d: Math.max(3, r1.d - 2) };
      K.section(g, r2.x, y, r2.z, r2.w, r2.d, Math.max(1, f3), 3, { wall: stone, win: P.WIN_OFFICE, spandrel: P.CONCRETE_DD, style: 'deco' });
      y += Math.max(1, f3) * 3;
      // terraced crown of chrome arches with glowing sunburst windows
      let r = { ...r2 };
      while (r.w >= 3 && r.d >= 3 && y < 136) {
        g.box(r.x, y, r.z, r.w, 3, r.d, metal);
        K.facade(g, r.x, y, r.z, r.w, 3, r.d, (u, v, f, len) => (u > 0 && u < len - 1 && ((v === 1 && u % 2) || (v === 2 && u === len >> 1)) ? P.LAMP_WHITE : 0));
        y += 3;
        r = { x: r.x + 1, z: r.z + 1, w: r.w - 2, d: r.d - 2 };
      }
      g.light(t.x + t.w / 2, y - 3, t.z + t.d / 2, [1, 0.95, 0.8], 2.2);
      // needle
      const nx = t.x + (t.w >> 1), nz = t.z + (t.d >> 1);
      const nh = Math.min(16, 148 - y);
      for (let k = 0; k < nh; k++) g.set(nx, y + k, nz, metal);
      if (nh > 2) K.beacon(g, nx, y + nh, nz);
    },
  },
  {
    name: 'empire',
    build(c) {
      const g = c.g, F = c3Floors(c), t0 = towerRect(c, c.W <= 8 ? 0 : 1, 20, 18);
      plaza(c, t0, c.Wl === 2);
      const stone = c.pk(0, [[P.CONCRETE, P.STONE], [P.SANDSTONE, P.STONE, P.CONCRETE_L], [P.SANDSTONE, P.MARBLE, P.BRICK_Y]]);
      const deco = { wall: stone, win: P.WIN_OFFICE, spandrel: P.CONCRETE_DD, style: 'deco' };
      let y = 1;
      // podium
      const fp = Math.min(5, F >> 2);
      K.section(g, t0.x, y, t0.z, t0.w, t0.d, fp, 3, deco);
      y += fp * 3;
      g.box(t0.x, y, t0.z, t0.w, 1, t0.d, stone);
      y += 1;
      const tiers = [0.62, 0.2, 0.18];
      let r = { x: t0.x + 2, z: t0.z + 2, w: t0.w - 4, d: t0.d - 4 };
      if (c.W <= 8) r = { x: t0.x + 1, z: t0.z + 1, w: t0.w - 2, d: t0.d - 2 };
      const rest = F - fp;
      tiers.forEach((fr, i) => {
        const n = Math.max(1, Math.round(rest * fr));
        if (r.w < 3 || r.d < 3) return;
        K.section(g, r.x, y, r.z, r.w, r.d, n, 3, deco);
        y += n * 3;
        g.box(r.x, y, r.z, r.w, 1, r.d, stone);
        y += 1;
        if (i < 2) r = { x: r.x + 1, z: r.z + 1, w: r.w - 2, d: r.d - 2 };
      });
      // floodlit crown + mooring mast
      const neon = c.L >= 2 ? c.pk(2, [P.NEON_BLUE, P.NEON_RED, P.NEON_PURPLE, P.NEON_GREEN, P.LAMP_WHITE]) : P.LAMP_WHITE;
      K.crownBand(g, r.x, y - 2, r.z, r.w, r.d, neon);
      const cx = r.x + r.w / 2, cz = r.z + r.d / 2;
      g.cyl(cx, y, cz, Math.max(1, Math.min(r.w, r.d) / 2 - 0.5), 4, stone);
      g.cyl(cx, y + 4, cz, 1, 3, P.METAL);
      mast(c, Math.floor(cx), y + 7, Math.floor(cz), 14);
    },
  },
  {
    name: 'twist',
    build(c) {
      const g = c.g, F = c3Floors(c), small = c.W <= 8;
      const s = small ? 5 : c.W >= 24 ? 15 : 10;
      const cx = c.W / 2, cz = small ? c.D / 2 : c.D / 2 - 0.5;
      plaza(c, { x: Math.floor(cx - s / 2), z: Math.floor(cz - s / 2), w: s, d: s }, c.Wl === 2);
      const glass = c.pk(0, TOWER_WALL.glass), slab = c.pk(1, [[P.CONCRETE_L], [P.WHITE, P.CONCRETE_L], [P.WHITE, P.CHROME]]);
      // lobby
      rotSquare(g, cx, cz, s, 0, 1, 5, P.GLASS_DARK);
      let y = 6;
      // each rotation group = slab + a band of floors glazed with office windows (lit at night);
      // uniform bands keep the stair-stepped outline cheap for the greedy mesher
      const step = small || c.W < 24 ? 4 : 3, groups = Math.ceil(F / step), maxA = small ? Math.PI / 4 : Math.PI / 2;
      for (let k = 0; k < groups; k++) {
        const a = (k / Math.max(1, groups - 1)) * maxA;
        const n = Math.min(step, F - k * step);
        rotSquare(g, cx, cz, s, a, y, 1, slab);
        rotSquare(g, cx, cz, s, a, y + 1, n * 3 - 1, k % 2 ? glass : P.WIN_OFFICE);
        y += n * 3;
      }
      rotSquare(g, cx, cz, s, maxA, y, 1, slab);
      const neon = c.pk(2, [P.NEON_CYAN, P.NEON_PURPLE, P.NEON_BLUE]);
      rotSquare(g, cx, cz, s - 2, maxA, y + 1, 1, c.L >= 2 ? neon : P.LAMP_WHITE);
      rotSquare(g, cx, cz, s - 2, maxA, y + 2, 1, slab);
      g.light(cx, y + 2, cz, K.glowRGB(neon), 1.6);
      if (y > 70) mast(c, Math.floor(cx), y + 3, Math.floor(cz), 14);
    },
  },
  {
    name: 'helipad',
    build(c) {
      const g = c.g, F = c3Floors(c), t = c3Rect(c);
      plaza(c, t, c.Wl === 2);
      const glass = c.pk(0, TOWER_WALL.glass), frame = c.pk(1, [[P.CONCRETE], [P.CONCRETE_L, P.WHITE], [P.WHITE, P.CHROME]]);
      let y = grandLobby(c, t, frame);
      K.section(g, t.x, y, t.z, t.w, t.d, F, 3, { wall: frame, win: glass === P.GLASS_GOLD ? P.WIN_OFFICE : P.WIN_OFFICE, trim: frame, style: 'grid' });
      // glass corner strips
      for (const [a, b] of [[t.x, t.z], [t.x + t.w - 1, t.z], [t.x, t.z + t.d - 1], [t.x + t.w - 1, t.z + t.d - 1]]) g.box(a, y, b, 1, F * 3, 1, glass);
      y += F * 3;
      g.box(t.x, y, t.z, t.w, 1, t.d, P.CONCRETE_D);
      // raised helipad deck on steel legs
      const s = Math.max(5, Math.min(t.w, t.d) - 1);
      const hx = t.x + ((t.w - s) >> 1), hz = t.z + ((t.d - s) >> 1);
      for (const [a, b] of [[hx + 1, hz + 1], [hx + s - 2, hz + 1], [hx + 1, hz + s - 2], [hx + s - 2, hz + s - 2]]) g.box(a, y + 1, b, 1, 2, 1, P.METAL_D);
      K.helipad(g, hx, y + 3, hz, s);
      // corner beacons & windsock
      K.beacon(g, t.x, y + 1, t.z, 0.8);
      K.beacon(g, t.x + t.w - 1, y + 1, t.z + t.d - 1, 0.8);
      g.box(t.x + t.w - 1, y + 1, t.z, 1, 3, 1, P.METAL_D);
      g.set(t.x + t.w - 2, y + 3, t.z, P.ORANGE); g.set(t.x + t.w - 3, y + 3, t.z, P.WHITE);
    },
  },
  {
    name: 'ledtower',
    build(c) {
      const g = c.g, F = c3Floors(c), small = c.W <= 8;
      const pod = small ? { x: 0, z: 0, w: c.W, d: c.D - 1 } : towerRect(c, 1, 22, 20);
      plaza(c, pod, false);
      const pf = small ? 3 : 5;
      // podium wrapped in LED screens
      g.box(pod.x, 1, pod.z, pod.w, pf * 3 + 1, pod.d, P.CONCRETE_DD);
      K.facade(g, pod.x, 1, pod.z, pod.w, 3, pod.d, (u, v, f, len) => (u > 0 && u < len - 1 && v < 2 ? P.WIN_SHOP : 0));
      const bw = Math.min(pod.w - 2, 12);
      K.billboard(g, pod.x + 1, 5, pod.z + pod.d, bw, pf * 3 - 4, c.rng, 0, 0);
      if (!small) {
        K.billboard(g, pod.x + pod.w, 5, pod.z + 1, Math.min(pod.d - 2, 10), pf * 3 - 5, c.rng, 1, 0);
        for (let x = pod.x; x < pod.x + pod.w; x++) g.set(x, 4, pod.z + pod.d, [P.NEON_PINK, P.NEON_CYAN, P.NEON_YELLOW][x % 3]);
      }
      let y = 2 + pf * 3;
      const t = small ? { x: 1, z: 1, w: c.W - 2, d: c.D - 3 } : c3Rect(c, 12);
      const Ft = Math.max(6, F - pf);
      K.section(g, t.x, y, t.z, t.w, t.d, Ft, 3, { wall: P.GLASS_DARK, glass: P.GLASS_DARK, win: P.WIN_OFFICE, style: 'curtain' });
      const neon = c.pk(2, [P.NEON_PINK, P.NEON_CYAN, P.NEON_PURPLE, P.NEON_BLUE]);
      for (const [a, b] of [[t.x, t.z], [t.x + t.w - 1, t.z], [t.x, t.z + t.d - 1], [t.x + t.w - 1, t.z + t.d - 1]]) g.box(a, y, b, 1, Ft * 3, 1, neon);
      y += Ft * 3;
      g.box(t.x, y, t.z, t.w, 1, t.d, neon);
      g.box(t.x + 1, y + 1, t.z + 1, t.w - 2, 2, t.d - 2, P.GLASS_DARK);
      g.light(t.x + t.w / 2, y, t.z + t.d / 2, K.glowRGB(neon), 1.8);
      if (y > 70) mast(c, t.x + (t.w >> 1), y + 3, t.z + (t.d >> 1), 12);
    },
  },
  {
    name: 'gherkin',
    build(c) {
      const g = c.g, F = c3Floors(c), t = c3Rect(c);
      const s = Math.min(t.w, t.d), R = s / 2;
      const cx = t.x + t.w / 2, cz = t.z + t.d / 2;
      plaza(c, t, c.Wl === 2);
      const ga = c.pk(0, [[P.GLASS_DARK], [P.GLASS_TEAL, P.GLASS_BLUE], [P.GLASS_TEAL, P.GLASS_CYAN]]), gb = P.GLASS_DARK;
      let y = 1;
      for (let f = 0; f < F; f++) {
        const tf = f / (F - 1);
        let r = R * (0.62 + 0.38 * Math.sin(Math.PI * (0.12 + 0.76 * tf)));
        if (tf > 0.84) r *= 1 - ((tf - 0.84) / 0.16) * 0.72;
        r = Math.max(1, r);
        g.cyl(cx, y, cz, r, 3, ga);
        y += 3;
      }
      // diagonal diamond pattern + lit window rows
      K.skin(g, 0, 1, 0, c.W, y, c.D, (x, yy, z) => {
        const d1 = (x + z + (yy >> 1)) % 6, d2 = (x - z + 64 + (yy >> 1)) % 6;
        if (d1 === 0 || d2 === 0) return gb;
        return yy % 3 === 1 ? P.WIN_OFFICE : 0;
      });
      K.skin(g, 0, 1, 0, c.W, 4, c.D, () => P.GLASS_DARK);
      g.ellipsoid(cx, y, cz, R * 0.28 + 0.6, 2, R * 0.28 + 0.6, P.GLASS_CYAN);
      g.set(Math.floor(cx), y + 2, Math.floor(cz), P.LAMP_WHITE);
      g.light(cx, y + 1, cz, [0.8, 0.95, 1], 1.3);
      if (y > 90) mast(c, Math.floor(cx), y + 3, Math.floor(cz), 8);
    },
  },
  {
    name: 'petronas',
    build(c) {
      const g = c.g, F = c3Floors(c), wide = c.W >= 24;
      const steel = c.pk(0, [[P.METAL_D, P.CONCRETE], [P.METAL, P.CHROME, P.STEEL_BLUE], [P.CHROME, P.GOLD, P.METAL]]);
      const style = { wall: steel, win: P.WIN_OFFICE, spandrel: steel, trim: steel, style: 'ribbon', shape: 'oct' };
      const tw = wide ? 9 : Math.min(c.W - 2, 11), gap = 3;
      const tz = Math.max(1, ((c.D - tw) >> 1) - 1);
      const xs = wide ? [((c.W - (2 * tw + gap)) >> 1), ((c.W - (2 * tw + gap)) >> 1) + tw + gap] : [(c.W - tw) >> 1];
      plaza(c, { x: xs[0], z: tz, w: wide ? 2 * tw + gap : tw, d: tw }, c.Wl === 2);
      const tiers = [0.58, 0.14, 0.1, 0.09, 0.09];
      let bridgeY = 0;
      for (const x0 of xs) {
        let y = 1, r = { x: x0, z: tz, w: tw, d: tw };
        tiers.forEach((fr, i) => {
          const n = Math.max(1, Math.round(F * fr));
          if (r.w < 3) return;
          K.section(g, r.x, y, r.z, r.w, r.d, n, 3, style);
          y += n * 3;
          if (i === 0) bridgeY = Math.round(y * 0.72);
          if (i > 0 || r.w > 7) r = { x: r.x + 1, z: r.z + 1, w: r.w - 2, d: r.d - 2 };
        });
        // pinnacle
        const cx = x0 + tw / 2, cz = tz + tw / 2;
        g.cyl(cx, y, cz, 1.6, 3, steel);
        g.cyl(cx, y + 3, cz, 1.1, 4, P.CHROME);
        for (let k = 0; k < 3; k++) g.cyl(cx, y + 7 + k * 3, cz, 0.9 - k * 0.2, 2, P.CHROME);
        mast(c, Math.floor(cx), y + 16, Math.floor(cz), 8);
        g.light(cx, y + 2, cz, [0.85, 0.9, 1], 1.4);
      }
      if (wide) {
        // double-deck skybridge with legs
        const bx = xs[0] + tw - 1, bz = tz + (tw >> 1) - 1;
        g.box(bx, bridgeY, bz, gap + 2, 2, 3, P.GLASS_CYAN);
        g.box(bx, bridgeY - 1, bz, gap + 2, 1, 3, steel);
        g.box(bx, bridgeY + 2, bz, gap + 2, 1, 3, steel);
        g.line(bx + 1, bridgeY - 1, bz + 1, bx + 1, bridgeY - 12, bz + 1, steel);
        g.line(bx + gap, bridgeY - 1, bz + 1, bx + gap, bridgeY - 12, bz + 1, steel);
        // podium between the towers
        g.box(xs[0], 1, tz + tw, 2 * tw + gap, 7, Math.min(3, c.D - tz - tw - 1), P.GLASS_DARK);
      }
    },
  },
  {
    name: 'tapered',
    build(c) {
      const g = c.g, F = c3Floors(c), t = c3Rect(c);
      plaza(c, t, c.Wl === 2);
      const wall = c.pk(0, [[P.CONCRETE, P.CONCRETE_L], [P.WHITE, P.CONCRETE_L, P.SANDSTONE], [P.WHITE, P.MARBLE]]);
      const s0 = Math.min(t.w, t.d), cx = t.x + t.w / 2, cz = t.z + t.d / 2;
      let y = grandLobby(c, t, wall, 5);
      for (let f = 0; f < F; f += 2) {
        const s = Math.max(3, Math.round(s0 * (1 - 0.72 * (f / F))));
        const x = Math.round(cx - s / 2), z = Math.round(cz - s / 2), n = Math.min(2, F - f);
        K.section(g, x, y, z, s, s, n, 3, { wall, win: P.WIN_OFFICE, style: 'punched' });
        // elevator "wings" near the top
        if (f > F * 0.6 && s >= 5) { g.box(x - 1, y, z + (s >> 1) - 1, 1, n * 3, 2, wall); g.box(x + s, y, z + (s >> 1) - 1, 1, n * 3, 2, wall); }
        y += n * 3;
      }
      const top = K.spire(g, cx, y, cz, 1.5, c.Wl === 2 ? P.GOLD : wall, Math.min(14, 146 - y - 6));
      g.light(cx, y + 1, cz, [1, 0.9, 0.7], 1.2);
      g.meta.top = top;
    },
  },
  {
    name: 'shard',
    build(c) {
      const g = c.g, F = c3Floors(c), t = c3Rect(c);
      plaza(c, t, c.Wl === 2);
      const glass = c.pk(0, [[P.GLASS_BLUE, P.GLASS_DARK], [P.GLASS_CYAN, P.GLASS_BLUE, P.GLASS_TEAL], [P.GLASS_CYAN, P.GLASS_TEAL]]);
      let y = 1;
      const Fb = Math.round(F * 0.84), s0 = Math.min(t.w, t.d);
      const k = Math.max(2, Math.floor(Fb / Math.max(1, (s0 >> 1) - 1)));
      let r = { x: t.x, z: t.z, w: t.w, d: t.d };
      for (let f = 0; f < Fb; f++) {
        if (f > 0 && f % k === 0 && r.w > 4 && r.d > 4) r = { x: r.x + ((f / k) % 2 ? 1 : 0), z: r.z + 1, w: r.w - 1, d: r.d - 1 - ((f / k) % 2 ? 0 : 1) };
        K.section(g, r.x, y, r.z, r.w, r.d, 1, 3, { wall: glass, glass, win: P.WIN_OFFICE, style: 'curtain', shape: 'chamfer', k: 1 });
        y += 3;
      }
      // splintered crown: shards rising to different heights
      const spikes = [[r.x, r.z, 2], [r.x + r.w - 2, r.z + 1, 2], [r.x + 1, r.z + r.d - 2, 2], [r.x + r.w - 3, r.z + r.d - 3, 2]];
      spikes.forEach(([x, z, w], i) => {
        const h = Math.min(148 - y, 8 + ((c.ids[12] >> (i * 2)) & 3) * 4 + (F - Fb) * 2);
        g.box(x, y, z, w, h, w, glass);
        g.box(x, y, z, 1, h - 1, 1, P.LAMP_WHITE);
      });
      g.light(r.x + r.w / 2, y + 6, r.z + r.d / 2, [0.85, 0.95, 1], 1.8);
      if (y > 70) K.beacon(g, spikes[0][0], Math.min(149, y + Math.min(148 - y, 8 + (c.ids[12] & 3) * 4 + (F - Fb) * 2)), spikes[0][1]);
    },
  },
];

VC.models.define('grow_C3', {
  variants: 10,
  gen(rng, v, p) {
    const c = lotCtx('grow_C3', rng, v, p, 160);
    const A = C3_ARCH[v % C3_ARCH.length];
    K.slab(c.g, P.SIDEWALK);
    A.build(c);
    if (c.bit(8)) mirrorX(c.g);
    return K.finish(c.g, 'C3_' + A.name);
  },
});

VC.models.define('grow_C2', {
  variants: 10,
  gen(rng, v, p) {
    const c = lotCtx('grow_C2', rng, v, p, 96);
    const A = C2_ARCH[v % C2_ARCH.length];
    K.slab(c.g, P.SIDEWALK);
    A.build(c);
    if (c.bit(8)) mirrorX(c.g);
    return K.finish(c.g, 'C2_' + A.name);
  },
});

VC.models.define('grow_C1', {
  variants: 10,
  gen(rng, v, p) {
    const c = lotCtx('grow_C1', rng, v, p, 48);
    const A = C1_ARCH[v % C1_ARCH.length];
    K.slab(c.g, P.SIDEWALK);
    A.build(c);
    if (c.bit(8)) mirrorX(c.g);
    return K.finish(c.g, 'C1_' + A.name);
  },
});
