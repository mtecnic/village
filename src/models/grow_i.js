/*
 * VOXELPOLIS — growable INDUSTRIAL models (see grow.js for the toolkit & conventions).
 *   grow_I1  light industry & agriculture: workshops, corrugated sheds, lumber yards, farms
 *            (barn + silo + crop rows), greenhouses, garages, breweries, small depots
 *   grow_I2  factories: sawtooth-roof brick/metal factories with chimneys, warehouses with
 *            loading docks, tank farms, container yards, bottling plants, foundries
 *   grow_I3  heavy & high-tech: refineries, cooling towers, steel mills, chemical plants, gas
 *            flares (level 1-2 / poor) — clean high-tech campuses, server farms, labs, solar
 *            roofs (level 3 or wealth 2)
 * Emitters: 'smoke' at chimney tops, 'steam' on cooling towers & vents, 'fire' on flares.
 */
const P = VC.P, M = VC.M, K = VC.growKit;
const { lotCtx, mirrorX } = K;

/* ------------------------------------------------------------------ */
/* Shared industrial helpers                                           */
/* ------------------------------------------------------------------ */
const IPAL = {
  shed: [[P.METAL_D, P.RUST, P.CONCRETE_D, P.STEEL_BLUE], [P.STEEL_BLUE, P.METAL_D, P.CONCRETE, P.BRICK, P.ROOF_GREEN], [P.WHITE, P.STEEL_BLUE, P.CONCRETE_L, P.METAL]],
  brick: [[P.BRICK_D, P.BRICK, P.CONCRETE_D], [P.BRICK, P.BRICK_D, P.BRICK_L], [P.BRICK_L, P.BRICK_Y, P.CONCRETE_L]],
  roof: [[P.RUST, P.METAL_D, P.ROOF_GREY], [P.METAL_D, P.ROOF_GREY, P.STEEL_BLUE, P.ROOF_GREEN], [P.METAL, P.ROOF_SLATE, P.STEEL_BLUE]],
  yard: [P.ASPHALT, P.CONCRETE_D, P.CONCRETE],
};
/** Industrial lot surface: asphalt / concrete with a gravel strip. */
function yardSlab(c) {
  const g = c.g;
  K.slab(g, IPAL.yard[c.Wl]);
  if (c.Wl === 0) for (let k = 0; k < c.W * c.D / 24; k++) g.set(M.hashU(k, 1, c.v) % c.W, 0, M.hashU(k, 2, c.v) % c.D, P.STONE_D);
}
/** Perimeter fence with a front gate (chain-link for poor, wall/hedge for rich). */
function perimeter(c, gateX, gateW = 3) {
  const kind = c.Wl === 2 ? 'hedge' : c.Wl === 1 ? 'chain' : 'chain';
  K.fenceRect(c.g, 0, 0, c.W, c.D, 1, kind, (x, z) => z === c.D - 1 && x >= gateX && x < gateX + gateW);
}
/**
 * Corrugated shed: walls + ribbed gable roof along x. o: { wall, roof, door (roll-up door count),
 * h (wall height), pitch }. Returns the roof top y.
 */
function shed(c, x, z, w, d, o) {
  const g = c.g, h = o.h || 5;
  g.box(x, 1, z, w, h, d, o.wall);
  // vertical ribbing on the side walls
  K.facade(g, x, 1, z, w, h, d, (u, v, f) => (f & 1 ? 0 : u % 2 ? 0 : o.rib || 0));
  // roll-up doors on the front
  const nd = o.doors || 1, dw = Math.min(3, Math.max(2, (w - 2) / nd - 1) | 0);
  for (let k = 0; k < nd; k++) {
    const dx = x + 1 + Math.round(((k + 0.5) * (w - 2)) / nd - dw / 2);
    g.box(dx, 1, z + d - 1, dw, Math.min(h - 1, 4), 1, o.doorC || P.CONCRETE_L);
    for (let yy = 2; yy < Math.min(h, 5); yy += 2) g.box(dx, yy, z + d - 1, dw, 1, 1, P.CONCRETE);
    g.box(dx - 1, 1, z + d, 1, 1, 1, P.HAZARD_Y);
  }
  // high strip windows on the sides
  if (h >= 5) K.facade(g, x, h - 1, z, w, 1, d, (u, v, f, len) => (u > 0 && u < len - 1 && u % 3 === 1 ? P.WIN : 0), 10);
  const top = K.roof(g, x, 1 + h, z, w, d, { type: o.roofType || 'gable', c: o.roof, fill: o.wall, pitch: o.pitch || 0.5, stripe: o.stripe === undefined ? P.METAL_D : o.stripe, oh: 0 });
  K.wallLight(g, x + w - 1, h - 1, z + d, P.LAMP_WHITE, 0.4);
  return top;
}
/**
 * Sawtooth factory roof over [x,x+w) x [z,z+d) at y: teeth along z, glazed north faces.
 * Returns top y.
 */
function sawtooth(g, x, y, z, w, d, c, glass = P.GLASS_CYAN, tooth = 4) {
  for (let j = 0; j < d; j++) {
    const k = j % tooth, hgt = k + 1;
    g.box(x, y, z + j, w, hgt, 1, c);
    if (k === tooth - 1) g.box(x, y + 1, z + j, w, hgt - 1, 1, glass);
  }
  return y + tooth;
}
/** Loading dock on the front: raised apron, bays with doors, bumpers. */
function dock(c, x, z, w, bays) {
  const g = c.g;
  g.box(x, 1, z, w, 1, 1, P.CONCRETE);
  for (let k = 0; k < bays; k++) {
    const bx = x + 1 + Math.round((k * (w - 2)) / bays);
    g.set(bx, 1, z, P.HAZARD_Y);
    g.set(bx + 2, 1, z, P.HAZARD_B);
  }
}
/** Parked semis in front of dock bays (cab toward the street). */
function trucks(c, x, z, n, len = 6) {
  const g = c.g;
  for (let k = 0; k < n; k++) {
    if (M.hash(k, 7, c.v) < 0.3) continue;
    const cab = c.rng.pick([P.RED, P.BLUE, P.WHITE, P.YELLOW, P.GREEN, P.ORANGE]);
    const box = c.rng.pick([P.WHITE, P.CONCRETE_L, P.CONTAINER_B, P.CONTAINER_R, P.METAL]);
    K.truck(g, x + k * 3, 1, z, 'z', cab, box, len);
  }
}
/** Container stack (rows along x). */
function containers(c, x, z, w, d, maxH) {
  const g = c.g;
  for (let j = 0; j + 2 <= d; j += 2)
    for (let i = 0; i + 5 <= w; i += 5) {
      const h = 1 + (M.hashU(i, j, c.v) % maxH);
      for (let k = 0; k < h; k++) K.container(g, x + i, 1 + k * 2, z + j, 'x', K.containerColor(c.rng));
    }
}
/** Hazard stripes along a ground edge. */
function hazardLine(g, x0, z0, len, axis = 'x') {
  for (let k = 0; k < len; k++) axis === 'x' ? g.set(x0 + k, 0, z0, k % 2 ? P.HAZARD_Y : P.HAZARD_B) : g.set(x0, 0, z0 + k, k % 2 ? P.HAZARD_Y : P.HAZARD_B);
}
/** Brick office annex at the front with windows and a company sign. Returns top y. */
function officeAnnex(c, x, z, w, d, floors, wall) {
  const g = c.g;
  const top = K.walls(c, x, 1, z, w, d, floors, { wall, trim: P.CONCRETE_L, doorU: 1, door: P.GLASS_DARK, win: P.WIN_OFFICE, recess: true });
  g.box(x, top, z, w, 1, d, P.CONCRETE_D);
  K.sign(g, x + 2, top - 2, z + d, Math.max(2, w - 3), 1, c.rng.pick([P.NEON_BLUE, P.NEON_RED, P.SIGN_WHITE, P.NEON_GREEN]), P.BLACK, c.rng, 0, true);
  return top + 1;
}

/* ================================================================== */
/* I1 — light industry & agriculture                                   */
/* ================================================================== */
const CROPS = [[P.GREEN, P.LEAF_L], [P.YELLOW, P.LEAF_Y], [P.LEAF, P.GRASS_D], [P.LEAF_Y, P.SAND], [P.FLOWER_V, P.LEAF], [P.ORANGE, P.LEAF_D]];
/** Crop field over [x,x+w) x [z,z+d): soil furrows + planted rows (heights vary by crop). */
function field(c, x, z, w, d, crop, rowsAlong = 'x') {
  const g = c.g;
  const [a, b] = crop;
  for (let j = 0; j < d; j++)
    for (let i = 0; i < w; i++) {
      const r = rowsAlong === 'x' ? j : i;
      g.set(x + i, 0, z + j, P.SOIL);
      if (r % 2 === 0) {
        g.set(x + i, 1, z + j, (i + j) % 3 === 0 ? b : a);
        if (a === P.YELLOW || a === P.LEAF_Y) g.set(x + i, 2, z + j, a); // tall wheat / corn
      }
    }
}
const I1_ARCH = [
  {
    name: 'farm',
    build(c) {
      const g = c.g, W = c.W, D = c.D, big = W >= 16;
      K.slab(g, P.GRASS_D);
      // fields fill the lot, farmyard in the front corner
      const crops = [CROPS[c.ids[0] % CROPS.length], CROPS[(c.ids[0] + 2) % CROPS.length]];
      if (big) {
        field(c, 0, 0, W >> 1, D - 8, crops[0]);
        field(c, (W >> 1) + 1, 0, (W >> 1) - 1, D - 8, crops[1], 'z');
      } else field(c, 0, 0, W, 3, crops[0]);
      const yz = big ? D - 8 : 3, yx = big ? W - 9 : 0;
      g.box(yx, 0, yz, big ? 9 : W, 1, D - yz, P.SOIL);
      // barn (gambrel roof), red with white trim
      const barnC = c.pk(1, [[P.BRICK_D, P.WOOD], [P.RED, P.BRICK, P.RED], [P.RED, P.WHITE, P.ROOF_GREEN]]);
      const bw = 5, bd = big ? 6 : 4, bx = yx, bz = yz;
      g.box(bx, 1, bz, bw, 3 + c.L, bd, barnC);
      K.facade(g, bx, 1, bz, bw, 3 + c.L, bd, (u, v, f, len) => (u === 0 || u === len - 1 ? P.WHITE : f === 0 && u >= 1 && u <= 3 && v < 3 ? (u === 2 || v === 1 ? P.WHITE : P.WOOD_D) : 0));
      K.roof(g, bx, 4 + c.L, bz, bw, bd, { type: 'gambrelz', c: c.pk(2, [P.ROOF_GREY, P.ROOF_BROWN, P.ROOF_GREEN, P.RUST]), fill: barnC, oh: 0 });
      g.set(bx + 2, 5 + c.L, bz + bd - 1, P.WHITE);
      // silo(s)
      const sx = bx + bw + 1.5, sz = bz + 1.5;
      const nsil = c.L >= 2 && big ? 2 : 1;
      for (let k = 0; k < nsil; k++) {
        const hx = Math.min(W - 1.5, sx + k * 3);
        g.cyl(hx, 1, sz, 1.5, 7 + c.L * 2, c.pk(3, [P.CONCRETE_L, P.METAL, P.BRICK]));
        g.ellipsoid(hx, 8 + c.L * 2, sz, 1.5, 1.2, 1.5, P.METAL);
      }
      // hay bales, tractor
      if (D - (bz + bd) >= 2) {
        g.hcyl('x', bx, 2, 1.5, bz + bd + 0.5, 0.6, P.LEAF_Y);
        g.box(bx + 3, 1, bz + bd, 2, 1, 1, P.GREEN); g.set(bx + 4, 2, bz + bd, P.GREEN); g.set(bx + 3, 1, bz + bd, P.TIRE);
      }
      // fence around the fields
      K.fence(g, 0, D - 1, yx - 1, D - 1, 1, 'rail');
      if (c.L === 3 && big) K.tree(g, 1, 1, D - 3, 3, 'oak', K.leaf(c.rng));
    },
  },
  {
    name: 'workshop',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      yardSlab(c);
      const wall = c.pk(0, IPAL.shed), roof = c.pk(1, IPAL.roof);
      const w = Math.min(W - 1, 6 + (W - 8)), d = Math.min(D - 3, 4 + c.L + (D - 8));
      const top = shed(c, 0, 0, w, d, { wall, roof, doors: W >= 16 ? 2 : 1, h: 3 + c.L, rib: 0 });
      K.chimney(g, 1, top - 2, 1, 3 + c.L, P.METAL_D, c.Wl < 2 ? 'smoke' : null, 0.4);
      // work yard: pallets, barrels, a van
      K.crates(g, W - 2, 1, 0, 2, 2, 2, P.WOOD_L);
      g.set(W - 1, 1, 3, P.ORANGE); g.set(W - 1, 1, 4, P.BLUE);
      K.truck(g, W - 3, 1, D - 6, 'z', P.WHITE, P.WHITE, 4);
      hazardLine(g, 0, D - 1, W);
      if (c.L >= 2) K.sign(g, 1, 4 + c.L - 1, d, w - 2, 1, P.NEON_ORANGE, 0, c.rng, 0, true);
    },
  },
  {
    name: 'lumber',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      K.slab(g, P.SOIL);
      for (let k = 0; k < W * D / 10; k++) g.set(M.hashU(k, 3, c.v) % W, 0, M.hashU(k, 4, c.v) % D, P.WOOD_L); // sawdust
      // open saw shed
      const sw = Math.min(W, 7 + (W - 8)), sd = 4;
      for (const [px, pz] of [[0, 0], [sw - 1, 0], [0, sd - 1], [sw - 1, sd - 1]]) g.box(px, 1, pz, 1, 4, 1, P.WOOD_D);
      K.roof(g, 0, 5, 0, sw, sd, { type: 'shed', c: c.pk(1, IPAL.roof), pitch: 0.5, oh: 0 });
      g.box(2, 1, 1, sw - 4, 1, 2, P.METAL_D); g.set(3, 2, 1, P.CHROME); // saw bench
      // log piles and plank stacks
      const lz = sd + 1;
      K.logs(g, 0, 1, lz, Math.min(W, 7), 'x', c.L >= 2 ? 3 : 2);
      if (D - lz >= 6) K.logs(g, 0, 1, lz + 3, Math.min(W, 7), 'x', 2);
      for (let k = 0; k < (W >= 16 ? 3 : 1); k++) K.crates(g, W - 3 - k * 3, 1, D - 3, 2, 2, 1 + c.L, P.WOOD_L);
      K.chimney(g, sw - 2, 5, 1, 3, P.METAL_D, 'smoke', 0.3);
      K.truck(g, W - 2, 1, 2, 'z', P.GREEN, P.WOOD, 5);
      K.fenceRect(g, 0, 0, W, D, 1, 'rail', (x, z) => z === D - 1 && x >= 1 && x < 4);
    },
  },
  {
    name: 'greenhouse',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      K.slab(g, P.GRASS_D);
      const n = W >= 16 ? 2 : 1, gw = Math.floor((W - (n - 1)) / n), gd = D - 3;
      for (let k = 0; k < n; k++) {
        const gx = k * (gw + 1);
        g.box(gx, 1, 0, gw, 3, gd, P.GLASS_GREEN);
        K.roof(g, gx, 4, 0, gw, gd, { type: c.bit(2) ? 'barrelz' : 'gablez', c: P.GLASS_GREEN, fill: P.GLASS_GREEN, pitch: 1, oh: 0 });
        // frame ribs
        for (let z = 0; z < gd; z += 3) K.facade(g, gx, 1, z, gw, 3, 1, (u, v, f, len) => (u === 0 || u === len - 1 ? P.WHITE : 0), 5);
        // plant rows inside visible through glass
        for (let x = gx + 1; x < gx + gw - 1; x += 2) g.box(x, 1, 1, 1, 1, gd - 2, x % 4 === 1 ? P.LEAF_L : P.FLOWER_R);
        g.box(gx + (gw >> 1), 1, gd - 1, 1, 2, 1, P.WHITE);
      }
      // front: potting yard with planters and a delivery van
      for (let x = 0; x < W - 4; x += 2) { g.set(x, 1, D - 2, P.ROOF_TERRA); g.set(x, 2, D - 2, c.rng.pick([P.FLOWER_R, P.FLOWER_Y, P.FLOWER_P, P.LEAF])); }
      K.truck(g, W - 3, 1, D - 3, 'x', P.GREEN, P.WHITE, 3);
      if (c.L >= 2) K.lamp(g, W - 1, 1, 0, 3, P.LAMP_WHITE, P.METAL_D, 0.5);
    },
  },
  {
    name: 'garage',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      yardSlab(c);
      const wall = c.pk(0, [[P.CONCRETE_D, P.CONCRETE], [P.CONCRETE_L, P.WHITE, P.BRICK], [P.WHITE, P.CONCRETE_L]]);
      const w = W - 1, d = Math.min(D - 3, 5 + (D - 8));
      g.box(0, 1, 0, w, 4, d, wall);
      const bays = Math.max(2, Math.floor(w / 3));
      for (let k = 0; k < bays; k++) {
        const bx = 1 + k * 3;
        if (bx + 2 > w) break;
        g.box(bx, 1, d - 1, 2, 3, 1, k % 2 && c.L > 1 ? P.GLASS_DARK : P.CONCRETE_L);
        if (M.hash(k, 9, c.v) < 0.6) K.car(g, bx, 1, d, 'z', K.carColor(c.rng));
      }
      g.box(0, 5, 0, w, 1, d, P.CONCRETE_D);
      const brand = c.pk(1, [P.NEON_RED, P.NEON_BLUE, P.NEON_YELLOW, P.NEON_ORANGE]);
      K.sign(g, 1, 5, d, w - 2, 1, brand, P.BLACK, c.rng, 0, true);
      // tire stack & oil drums
      g.box(W - 1, 1, 0, 1, 3, 1, P.TIRE);
      g.set(W - 1, 1, 2, P.RED); g.set(W - 1, 1, 3, P.BLUE);
      if (c.L >= 2) K.car(g, W - 3, 1, D - 3, 'x', P.RUST);
      hazardLine(g, 0, D - 1, W);
    },
  },
  {
    name: 'brewery',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      yardSlab(c);
      const brick = c.pk(0, IPAL.brick);
      const w = Math.min(W - 3, 5 + (W - 8)), d = D - 3;
      const top = K.walls(c, 0, 1, 0, w, d, 1 + (c.L > 1 ? 1 : 0), { wall: brick, trim: P.CONCRETE_L, doorU: 1, door: P.WOOD_D, win: P.WIN, band: true });
      K.roof(g, 0, top, 0, w, d, { type: 'gable', c: c.pk(1, IPAL.roof), fill: brick, pitch: 1, oh: 0 });
      // copper kettles / steel fermenters beside the hall
      const tx = w + 1.5;
      K.tank(g, Math.min(W - 1.5, tx), 1, 2, 1.5, 5 + c.L, c.Wl ? P.COPPER_GREEN : P.METAL);
      if (D >= 16 || c.L >= 2) K.tank(g, Math.min(W - 1.5, tx), 1, 6, 1.5, 4 + c.L, P.METAL);
      K.chimney(g, 1, top, 1, 4 + c.L, P.BRICK_D, 'steam', 0.5);
      // barrels
      g.set(w - 1, 1, d, P.WOOD); g.set(w - 2, 1, d, P.WOOD);
      K.sign(g, 1, top - 2, d, w - 2, 1, P.NEON_ORANGE, 0, c.rng, 0, true);
    },
  },
  {
    name: 'depot',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      yardSlab(c);
      // small warehouse + fenced yard with pallets
      const wall = c.pk(0, IPAL.shed), roof = c.pk(1, IPAL.roof);
      const w = W >= 16 ? W - 6 : W - 2, d = Math.min(6, D - 3);
      const top = shed(c, 0, 0, w, d, { wall, roof, doors: W >= 16 ? 2 : 1, h: 4, roofType: 'shed', pitch: 0.4 });
      dock(c, 0, d, w, W >= 16 ? 2 : 1);
      if (W >= 16) trucks(c, 1, d + 1, 2, 5);
      for (let k = 0; k < 2 + c.L; k++) K.crates(g, W - 2, 1, 1 + k * 2, 2, 1, 1 + (k % 2), P.WOOD_L);
      perimeter(c, 1, 4);
      K.lamp(g, W - 1, 1, D - 2, 4, P.LAMP_WHITE, P.METAL_D, 0.6);
      if (c.L >= 2) roofVents(c, 1, top - 2, 1, w - 2);
    },
  },
  {
    name: 'mill',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      K.slab(g, P.GRASS_D);
      g.box(0, 0, D - 5, W, 1, 5, P.SOIL);
      // grain elevator: a row of joined concrete bins under a tall head house
      const n = Math.max(2, Math.min(5, Math.floor((W - 3) / 3))), H = 9 + c.L * 3, bz = 1.5 + (D >= 16 ? 2 : 0);
      const binC = c.pk(3, [P.CONCRETE_L, P.CONCRETE, P.TANK_WHITE]);
      for (let k = 0; k < n; k++) g.cyl(1.5 + k * 3, 1, bz, 1.6, H, binC);
      g.box(1, 1, Math.floor(bz), n * 3 - 1, H, 1, binC); // web between the bins
      g.box(0, H + 1, Math.floor(bz) - 1, n * 3 + 1, 1, 3, P.CONCRETE_D); // gallery floor
      const hx = c.bit(4) ? 0 : n * 3 - 3;
      const head = c.pk(0, [P.WOOD, P.RUST, P.METAL_D, P.RED]);
      g.box(hx, H + 2, Math.floor(bz) - 1, 4, 5 + c.L, 3, head);
      g.box(hx + 1, H + 4, Math.floor(bz) + 1, 2, 1, 1, P.WIN);
      K.roof(g, hx, H + 7 + c.L, Math.floor(bz) - 1, 4, 3, { type: 'gablez', c: P.METAL_D, oh: 0, pitch: 1 });
      K.sign(g, 1, H - 2, Math.floor(bz) + 2, Math.min(n * 3 - 2, 8), 1, P.SIGN_WHITE, 0, c.rng, 0, false);
      // loading shed with a chute over the truck lane
      const sx = Math.min(W - 4, n * 3 + 1);
      g.box(sx, 1, D - 7, 4, 4, 3, P.RUST);
      g.box(sx, 5, D - 7, 4, 1, 3, P.METAL_D);
      g.line(hx + 2, H + 2, Math.floor(bz) + 1, sx + 1, 5, D - 6, P.METAL_D);
      g.line(hx + 2, H + 1, Math.floor(bz) + 1, sx + 1, 4, D - 6, P.METAL_D);
      K.truck(g, Math.min(W - 2, sx + 1), 1, D - 4, 'z', P.RED, P.LEAF_Y, 4);
      field(c, 0, D - 5, Math.min(W - 5, sx - 1), 4, CROPS[1]);
      K.lamp(g, W - 1, 1, D - 1, 4, P.LAMP, P.WOOD_D, 0.5);
    },
  },
];
/** Roof vents row (small boxes). */
function roofVents(c, x, y, z, w) {
  for (let i = 0; i < w; i += 3) c.g.box(x + i, y, z, 1, 2, 1, P.METAL);
}

/* ================================================================== */
/* I2 — factories                                                      */
/* ================================================================== */
const I2_ARCH = [
  {
    name: 'sawtooth',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      yardSlab(c);
      const brick = c.pk(0, IPAL.brick), roofC = c.pk(1, IPAL.roof);
      const w = W - 2, d = D - 4 - (D >= 24 ? 2 : 0), H = 5 + c.L;
      g.box(0, 1, 0, w, H, d, brick);
      K.facade(g, 0, 1, 0, w, H, d, (u, v, f, len) => (u > 0 && u < len - 1 && u % 3 !== 0 && v >= 2 && v <= H - 2 ? P.WIN : v === H - 1 ? P.CONCRETE_D : 0));
      sawtooth(g, 0, 1 + H, 0, w, d, roofC, P.GLASS_CYAN, 4);
      // chimney(s) with stripes
      const nch = c.L >= 2 && W >= 16 ? 2 : 1;
      for (let k = 0; k < nch; k++) K.stack(g, w + 0.5 - (k ? 0 : 0), 1, 2.5 + k * 5, 1.3, 16 + c.L * 6 - k * 4, c.Wl === 2 ? P.CHIMNEY : P.CHIMNEY_RED, P.WHITE, 'smoke', 1);
      // loading doors + trucks
      dock(c, 0, d, w, Math.max(1, (w / 6) | 0));
      for (let k = 0; k < Math.max(1, (w / 6) | 0); k++) g.box(2 + k * 6, 1, d - 1, 3, 4, 1, P.CONCRETE_L);
      if (D >= 16) trucks(c, 2, d + 1, Math.max(1, (w / 6) | 0), 5);
      hazardLine(g, 0, D - 1, W);
      K.lamp(g, W - 1, 1, D - 2, 4, P.LAMP_WHITE, P.METAL_D, 0.7);
    },
  },
  {
    name: 'warehouse',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      yardSlab(c);
      const wall = c.pk(0, IPAL.shed), roof = c.pk(1, IPAL.roof);
      const d = Math.max(6, D - 8), H = 5 + c.L;
      const top = shed(c, 0, 0, W, d, { wall, roof, doors: Math.max(2, (W / 5) | 0), h: H, roofType: 'barrel', pitch: 0.35, stripe: P.METAL_D });
      dock(c, 0, d, W, Math.max(2, (W / 5) | 0));
      trucks(c, 1, d + 1, Math.max(1, ((W - 2) / 3) | 0), Math.min(6, D - d - 2));
      if (c.L >= 2) K.billboard(g, 1, top + 1, 2, Math.min(W - 2, 10), 3, c.rng, 0, 1);
      K.wallLight(g, 0, H, d, P.LAMP_WHITE, 0.6);
      perimeter(c, W - 4, 3);
    },
  },
  {
    name: 'tankfarm',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      yardSlab(c);
      hazardLine(g, 0, 0, W);
      // grid of storage tanks with bund walls, pipes between them
      const r = W >= 24 ? 3.5 : 2.5, sp = r * 2 + 2;
      const nx = Math.max(1, Math.floor((W - 2) / sp)), nz = Math.max(1, Math.floor((D - 5) / sp));
      for (let j = 0; j < nz; j++)
        for (let i = 0; i < nx; i++) {
          const cx = 1 + sp * i + sp / 2, cz = 1 + sp * j + sp / 2;
          K.ring(g, Math.floor(cx - r - 1), 1, Math.floor(cz - r - 1), Math.ceil(r * 2 + 2), Math.ceil(r * 2 + 2), P.CONCRETE);
          const col = (i + j + c.ids[0]) % 3 === 0 ? P.TANK_WHITE : c.pk(1, [P.TANK_WHITE, P.METAL, P.CONTAINER_G, P.CONTAINER_B]);
          K.tank(g, cx, 1, cz, r, 4 + c.L * 2 + ((i + j) % 2) * 2, col, P.HAZARD_Y);
          if (i < nx - 1) K.pipe(g, 'x', Math.floor(cx + r), Math.ceil(sp - 2 * r) + 1, 2, Math.floor(cz), P.PIPE);
        }
      // pump house + flare stack
      g.box(W - 4, 1, D - 4, 3, 3, 3, P.CONCRETE_D);
      g.box(W - 4, 4, D - 4, 3, 1, 3, P.METAL_D);
      K.pipe(g, 'z', 1, D - 5, 2, W - 3, P.PIPE);
      if (c.L >= 2) { K.stack(g, W - 1.5, 1, D - 1.5, 0.8, 14, P.METAL_D, 0, 'fire', 0.6); g.set(W - 2, 16, D - 2, P.FIRE); }
      K.lamp(g, 0, 1, D - 1, 4, P.LAMP_WHITE, P.METAL_D, 0.6);
    },
  },
  {
    name: 'containers',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      K.slab(g, P.ASPHALT);
      for (let x = 0; x < W; x += 5) for (let z = 0; z < D; z++) if (z % 4 === 3) g.set(x, 0, z, P.HAZARD_Y);
      containers(c, 0, 0, W - 3, D - 5, 1 + c.L);
      // gantry crane over the stacks
      const gx = 2 + (c.ids[1] % Math.max(1, W - 8)), gh = 4 + c.L * 2 + 4;
      for (const zz of [0, D - 6]) { g.box(gx, 1, zz, 1, gh, 1, P.HAZARD_Y); g.box(gx + 4, 1, zz, 1, gh, 1, P.HAZARD_Y); }
      g.box(gx, gh + 1, 0, 5, 1, D - 5, P.HAZARD_Y);
      g.box(gx + 1, gh, 2, 3, 1, 2, P.RED);
      K.beacon(g, gx, gh + 2, 0, 0.6);
      // office cabin & reach stacker
      g.box(W - 3, 1, D - 4, 3, 3, 3, P.WHITE);
      g.box(W - 3, 2, D - 2, 3, 1, 1, P.WIN_OFFICE);
      K.truck(g, 1, 1, D - 4, 'x', P.ORANGE, K.containerColor(c.rng), 7);
      K.lamp(g, W - 1, 1, 0, 6, P.LAMP_WHITE, P.METAL_D, 0.9);
    },
  },
  {
    name: 'plant',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      yardSlab(c);
      const wall = c.pk(0, [[P.CONCRETE_D, P.METAL_D], [P.CONCRETE_L, P.WHITE, P.STEEL_BLUE], [P.WHITE, P.CONCRETE_L]]);
      const accent = c.pk(1, [P.BLUE, P.RED, P.GREEN, P.ORANGE]);
      const w = W - 2, d = Math.max(6, D - 6), H = 6 + c.L * 2;
      g.box(0, 1, 0, w, H, d, wall);
      g.box(0, H - 1, 0, w, 1, d, accent);
      K.facade(g, 0, 1, 0, w, H - 2, d, (u, v, f, len) => (u > 0 && u < len - 1 && v >= 2 && v <= 3 && u % 4 !== 0 ? P.WIN_OFFICE : 0));
      g.box(0, 1 + H, 0, w, 1, d, P.CONCRETE_D);
      // rooftop process equipment: silos, ducts, AC
      K.tank(g, 2.5, 2 + H, 2.5, 1.5, 4, P.TANK_WHITE, accent);
      if (w >= 12) K.tank(g, 6.5, 2 + H, 2.5, 1.5, 4, P.TANK_WHITE, accent);
      K.hvac(g, w - 5, 2 + H, 1, 3, 3);
      g.hcyl('x', 3, w - 6, 3 + H, d - 2.5, 0.8, P.PIPE);
      K.stack(g, w - 1.5, 2 + H, d - 2.5, 1, 8 + c.L * 3, P.METAL, 0, c.Wl === 2 ? 'steam' : 'smoke', 0.8);
      // side conveyor + dock
      dock(c, 0, d, w, 2);
      if (D - d >= 5) trucks(c, 2, d + 1, 2, 4);
      K.sign(g, 2, H - 3, d, Math.min(8, w - 4), 2, P.SIGN_WHITE, accent, c.rng, 0, true);
      perimeter(c, w - 3, 3);
    },
  },
  {
    name: 'foundry',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      yardSlab(c);
      const brick = c.pk(0, IPAL.brick);
      const w = W - 3, d = D - 5, H = 7 + c.L;
      g.box(0, 1, 0, w, H, d, brick);
      K.facade(g, 0, 1, 0, w, H, d, (u, v, f, len) => (u > 0 && u < len - 1 && u % 4 === 2 && v >= 2 && v <= H - 2 ? P.WIN : 0));
      // glowing furnace door at the front
      g.box(2, 1, d - 1, 3, 3, 1, P.FIRE);
      g.light(3.5, 2, d + 0.5, [1, 0.5, 0.15], 1.1, true);
      g.emit(3.5, 4, d + 0.5, 'fire', 0.25);
      K.roof(g, 0, 1 + H, 0, w, d, { type: 'gable', c: c.pk(1, IPAL.roof), fill: brick, pitch: 0.6, stripe: P.METAL_D, oh: 0 });
      // monitor (raised ridge vent)
      g.box(2, H + 3, (d >> 1) - 1, w - 4, 2, 2, P.METAL_D);
      g.box(2, H + 3, (d >> 1) - 1, w - 4, 1, 2, P.GLASS_DARK);
      for (let k = 0; k < (W >= 16 ? 3 : 2); k++) K.stack(g, w + 1.5, 1, 1.5 + k * 3, 1, 14 + c.L * 5 - k * 2, P.CHIMNEY, P.CHIMNEY_RED, 'smoke', 1);
      // slag heap & ingots
      g.ellipsoid(W - 3, 1, D - 3, 2.2, 1.6, 1.8, P.CONCRETE_DD);
      g.box(0, 1, D - 3, 3, 1, 2, P.RUST); g.box(0, 2, D - 3, 2, 1, 2, P.METAL_D);
      hazardLine(g, 0, D - 1, W - 5);
    },
  },
  {
    name: 'bottling',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      yardSlab(c);
      const wall = c.pk(0, [[P.CONCRETE, P.PLASTER], [P.WHITE, P.CONCRETE_L, P.PLASTER_CREAM], [P.WHITE, P.MARBLE]]);
      const brand = c.pk(1, [P.RED, P.BLUE, P.GREEN, P.ORANGE, P.PURPLE]);
      const w = W - 1, d = Math.max(5, D - 7), H = 5 + c.L;
      g.box(0, 1, 0, w, H, d, wall);
      K.facade(g, 0, 1, 0, w, H, d, (u, v, f, len) => (v === H - 2 ? brand : f === 0 && u > 0 && u < len - 1 && v >= 1 && v <= 2 && u % 5 !== 0 ? P.WIN_SHOP : 0));
      g.box(0, 1 + H, 0, w, 1, d, P.CONCRETE_D);
      // row of steel silos on the roof & a giant bottle landmark
      for (let x = 2; x < w - 3; x += 3) K.tank(g, x + 0.5, 2 + H, 2.5, 1.2, 4 + c.L, P.METAL, 0);
      const bx = w - 2, bz = d - 2;
      g.cyl(bx + 0.5, 2 + H, bz + 0.5, 1.3, 5, brand === P.GREEN ? P.GLASS_GREEN : P.GLASS_CYAN);
      g.cyl(bx + 0.5, 7 + H, bz + 0.5, 0.6, 3, brand === P.GREEN ? P.GLASS_GREEN : P.GLASS_CYAN);
      g.set(bx, 10 + H, bz, brand);
      g.light(bx + 0.5, 5 + H, bz + 0.5, [0.6, 0.9, 1], 0.9);
      dock(c, 0, d, w, 2);
      trucks(c, 1, d + 1, Math.max(1, ((W - 2) / 4) | 0), 5);
    },
  },
  {
    name: 'recycler',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      K.slab(g, P.CONCRETE_D);
      // scrap piles with the magnet crane
      const piles = [[P.RUST, P.METAL_D], [P.METAL, P.RUST], [P.CONTAINER_B, P.METAL_D], [P.CONCRETE_D, P.RUST]];
      const pr = W >= 24 ? 4 : W >= 16 ? 3.2 : 2.4, np = W >= 24 ? 3 : W >= 16 ? 2 : 1;
      for (let k = 0; k < np; k++) {
        const [a, b] = piles[(k + c.ids[2]) % 4];
        const px = pr + 1 + k * (pr * 2 + 1), pz = pr + 1;
        g.ellipsoid(px, 1, pz, pr, pr * 0.7 + c.L * 0.5, pr * 0.9, (x, y, z) => ((x * 3 + y * 5 + z * 7) % 5 ? a : b));
      }
      // sorted bales along the side
      for (let k = 0; k < 2 + c.L; k++) g.box(W - 2, 1, 1 + k * 2, 2, 1 + (k % 2), 1, [P.BLUE, P.GREEN, P.YELLOW, P.WHITE][k % 4]);
      // shredder shed + 2-wide conveyor belt
      const top = shed(c, W - 7, D - 7, 6, 5, { wall: P.STEEL_BLUE, roof: P.METAL_D, doors: 1, h: 5, roofType: 'shed' });
      for (let k = 0; k < 6; k++) { g.box(W - 9 - k, 2 + (k >> 1), D - 5, 2, 1, 2, P.METAL_D); }
      // crane with magnet
      g.box(1, 1, D - 3, 3, 2, 2, P.YELLOW);
      g.set(2, 3, D - 2, P.GLASS_DARK);
      g.line(2, 3, D - 3, Math.round(pr + 1), 11, Math.round(pr + 1), P.YELLOW);
      g.line(3, 3, D - 3, Math.round(pr + 2), 11, Math.round(pr + 1), P.YELLOW);
      g.box(Math.round(pr + 1), 8, Math.round(pr + 1), 1, 3, 1, P.BLACK);
      g.cyl(Math.round(pr + 1) + 0.5, 7, Math.round(pr + 1) + 0.5, 1.2, 1, P.METAL_D);
      K.stack(g, W - 1.5, 1, 1.5, 0.9, 10 + c.L * 3, P.METAL_D, 0, 'smoke', 0.6);
      perimeter(c, 4, 3);
      g.meta.top = top;
    },
  },
];

/* ================================================================== */
/* I3 — heavy industry (level 1-2) / high-tech (level 3 or wealth 2)   */
/* ================================================================== */
/** Hyperboloid cooling tower (waisted cylinder) with steam. */
function coolingTower(g, cx, y, cz, r, h, c = P.CONCRETE_L) {
  for (let k = 0; k < h; k++) {
    const t = k / (h - 1);
    const rr = r * (0.72 + 0.28 * Math.pow(Math.abs(t - 0.62) / 0.62, 1.6));
    g.cyl(cx, y + k, cz, rr, 1, k === h - 1 || k < 2 ? P.CONCRETE_D : c);
    if (rr > 2) g.cyl(cx, y + k, cz, rr - 1, 1, 0);
  }
  g.emit(cx, y + h + 1, cz, 'steam', 1.4);
  g.emit(cx + r * 0.3, y + h + 1, cz - r * 0.2, 'steam', 1);
}
/** Distillation column with platforms (refinery). */
function column(g, cx, y, cz, r, h, c = P.METAL) {
  g.cyl(cx, y, cz, r, h, c);
  for (let k = 4; k < h; k += 5) g.cyl(cx, y + k, cz, r + 0.8, 1, P.HAZARD_Y);
  g.ellipsoid(cx, y + h, cz, r, 1, r, c);
}
/** Glass lab block with fins, a lawn and neon data strips. Returns top y. */
function lab(c, x, z, w, d, floors, glass, frame, neon) {
  const g = c.g;
  const y = 1;
  K.section(g, x, y, z, w, d, floors, 4, { wall: glass, glass, win: P.WIN_OFFICE, mullion: frame, mstep: 3, style: 'curtain' });
  for (let f = 0; f < floors; f++) K.ring(g, x, y + f * 4 + 3, z, w, d, frame);
  const top = y + floors * 4;
  g.box(x, top, z, w, 1, d, frame);
  K.facade(g, x, top - 1, z, w, 1, d, (u, v, f, len) => (u > 0 && u < len - 1 ? neon : 0));
  return top + 1;
}
const I3_HEAVY = [
  {
    name: 'refinery',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      yardSlab(c);
      hazardLine(g, 0, D - 1, W);
      const s = W / 24;
      // distillation columns
      const cols = W >= 16 ? 4 : 2;
      for (let k = 0; k < cols; k++) column(g, 2.5 + k * 3.2, 1, 3.5, 1.3, 14 + c.L * 6 + (k % 2) * 6, k % 2 ? P.METAL : P.TANK_WHITE);
      // pipe racks
      for (let y of [3, 5]) K.pipe(g, 'x', 0, W, y, 6, P.PIPE);
      for (let x = 0; x < W; x += 4) g.box(x, 1, 6, 1, 5, 1, P.METAL_D);
      g.hcyl('x', 0, W, 4, 7.5, 0.6, P.RUST);
      // tanks in the back half
      if (D >= 16) for (let k = 0; k < Math.floor(W / 8); k++) K.tank(g, 4 + k * 8, 1, D - 6, 3, 5 + c.L, P.TANK_WHITE, P.HAZARD_Y);
      // flare stack
      const fx = W - 1.5, fz = 1.5, fh = Math.round((22 + c.L * 8) * Math.max(0.7, s));
      K.stack(g, fx, 1, fz, 0.8, fh, P.METAL_D, P.RED, 'fire', 1.2);
      g.set(Math.floor(fx), fh + 2, Math.floor(fz), P.FIRE);
      g.light(fx, fh + 2.5, fz, [1, 0.55, 0.15], 1.6, true);
      K.lamp(g, 0, 1, D - 2, 5, P.LAMP_WHITE, P.METAL_D, 0.8);
      for (let k = 0; k < cols; k += 2) g.light(2.5 + k * 3.2, 8, 3.5, [1, 0.85, 0.5], 0.5);
    },
  },
  {
    name: 'cooling',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      yardSlab(c);
      const n = W >= 24 ? 2 : 1, r = W >= 16 ? Math.min(6, W / (2 * n) - 1) : 3.5;
      for (let k = 0; k < n; k++) coolingTower(g, W / (2 * n) * (2 * k + 1), 1, r + 1, r, Math.round(r * 3.2 + c.L * 3));
      // turbine hall
      const hz = Math.ceil(r * 2 + 3), hd = Math.max(3, D - hz - 2);
      g.box(0, 1, hz, W, 6 + c.L, hd, P.CONCRETE);
      K.facade(g, 0, 1, hz, W, 6 + c.L, hd, (u, v, f, len) => (u % 4 === 2 && v >= 2 && v <= 4 ? P.WIN : v === 5 + c.L ? P.STEEL_BLUE : 0));
      g.box(0, 7 + c.L, hz, W, 1, hd, P.METAL_D);
      K.stack(g, W - 2.5, 7 + c.L, hz + 1.5, 1.2, 12 + c.L * 5, P.CHIMNEY, P.CHIMNEY_RED, 'smoke', 1);
      // transformer yard
      for (let x = 1; x < W - 2; x += 3) { g.box(x, 1, D - 2, 2, 2, 1, P.METAL_D); g.set(x, 3, D - 2, P.CHROME); }
      hazardLine(g, 0, D - 1, W);
    },
  },
  {
    name: 'steelmill',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      yardSlab(c);
      // blast furnace: tall tapered cylinder with bustle pipe and skip hoist
      const bx = 4.5, bz = 4.5, H = 16 + c.L * 6;
      for (let k = 0; k < H; k++) g.cyl(bx, 1 + k, bz, 3 - (k / H) * 1.6, 1, k % 6 === 5 ? P.RUST : P.METAL_D);
      g.cyl(bx, 1 + H, bz, 1.2, 4, P.METAL_D);
      g.emit(bx, 6 + H, bz, 'smoke', 1.2);
      g.line(bx + 2, H, bz, W - 3, 2, bz, P.HAZARD_Y); // skip incline
      // hot stoves (3 domed cylinders)
      for (let k = 0; k < 3; k++) { g.cyl(9.5 + k * 3, 1, 2.5, 1.3, H - 4, P.METAL); g.ellipsoid(9.5 + k * 3, H - 3, 2.5, 1.3, 1, 1.3, P.METAL); }
      // rolling mill shed along the front
      const sz = Math.max(9, D - 7);
      shed(c, 0, sz, W, D - sz - 1, { wall: P.RUST, roof: P.METAL_D, doors: 2, h: 6, rib: P.METAL_D });
      g.box(1, 1, sz - 1, 3, 2, 1, P.FIRE);
      g.light(2.5, 2, sz - 0.5, [1, 0.45, 0.1], 1.2, true);
      for (let k = 0; k < 2; k++) K.stack(g, W - 1.5 - k * 3, 1, 1.5, 1, 20 + c.L * 6, P.CHIMNEY, P.CHIMNEY_RED, 'smoke', 1);
      g.ellipsoid(W - 4, 1, sz - 3, 2.4, 1.8, 2, P.CONCRETE_DD); // coke pile
    },
  },
  {
    name: 'chemical',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      yardSlab(c);
      // spherical tanks, reactors, crazy pipework
      const sr = W >= 24 ? 3 : 2.3;
      for (let k = 0; k < Math.max(1, Math.floor(W / 9)); k++) {
        const cx = 3 + k * 8, cz = 3.5;
        for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.box(Math.floor(cx + a * sr * 0.6), 1, Math.floor(cz + b * sr * 0.6), 1, Math.ceil(sr), 1, P.METAL_D);
        g.sphere(cx, sr + 2, cz, sr, c.pk(0, [P.TANK_WHITE, P.WHITE, P.METAL]));
      }
      for (let k = 0; k < 3; k++) column(g, 3 + k * 3, 1, D - 7, 1, 10 + c.L * 4 + k * 2, P.METAL);
      for (let y = 3; y <= 9; y += 3) K.pipe(g, 'x', 0, W, y, D - 4, y === 6 ? P.CONTAINER_G : P.PIPE);
      for (let x = 0; x < W; x += 5) { g.box(x, 1, D - 4, 1, 9, 1, P.METAL_D); g.line(x, 9, D - 4, x, 9, 8, P.PIPE); }
      K.stack(g, W - 2, 1, D - 9, 1, 18 + c.L * 5, P.METAL_D, P.HAZARD_Y, 'smoke', 0.8);
      g.emit(3, 11 + c.L * 4, D - 7, 'steam', 0.8);
      K.lamp(g, W - 1, 1, D - 1, 5, P.LAMP_WHITE, P.METAL_D, 0.8);
      hazardLine(g, 0, D - 1, W);
    },
  },
];
const I3_TECH = [
  {
    name: 'campus',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      K.slab(g, P.GRASS_L);
      const glass = c.pk(0, [[P.GLASS_BLUE], [P.GLASS_TEAL, P.GLASS_BLUE], [P.GLASS_CYAN, P.GLASS_TEAL, P.GLASS_BLUE]]);
      const neon = c.pk(1, [P.NEON_CYAN, P.NEON_BLUE, P.NEON_GREEN, P.NEON_PURPLE]);
      // two lab wings joined by a bridge, solar on the roof
      const w1 = Math.min(W - 4, Math.round(W * 0.55)), d1 = Math.min(10, D - 6);
      const t1 = lab(c, 1, 1, w1, d1, 2 + (c.L > 2 ? 1 : 0), glass, P.WHITE, neon);
      K.solar(g, 2, t1, 2, w1 - 2, d1 - 2);
      const w2 = W - w1 - 4;
      if (w2 >= 4) {
        const t2 = lab(c, w1 + 3, 3, w2, Math.min(8, D - 8), 1 + (c.L > 2 ? 1 : 0), glass, P.WHITE, neon);
        g.box(w1 + 1, 5, 4, 2, 3, 2, P.GLASS_CYAN);
        K.roofGarden(g, w1 + 3, t2, 3, w2, Math.min(8, D - 8), c.rng);
      }
      // paths, trees, parking
      g.box(0, 0, D - 4, W, 1, 1, P.SIDEWALK);
      g.box((w1 >> 1), 0, 1 + d1, 2, 1, D - 1 - d1, P.SIDEWALK);
      for (let x = 2; x < W - 2; x += 5) K.tree(g, x, 1, D - 2, 2, c.pk(2, ['birch', 'round', 'oak']), K.leaf(c.rng));
      K.parking(g, W - 8, D - 3, 7, 3, c.rng, 0.5);
      K.lamp(g, 0, 1, D - 1, 3, P.LAMP_WHITE, P.METAL, 0.6);
      // logo totem
      g.box(W - 1, 1, D - 5, 1, 4, 1, P.WHITE);
      g.box(W - 1, 5, D - 5, 1, 2, 1, neon);
      g.light(W - 0.5, 6, D - 4.5, K.glowRGB(neon), 0.8);
    },
  },
  {
    name: 'datacenter',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      K.slab(g, P.CONCRETE);
      const neon = c.pk(1, [P.NEON_CYAN, P.NEON_BLUE, P.NEON_PURPLE, P.NEON_GREEN]);
      const w = W - 2, d = Math.max(6, D - 6), H = 6 + c.L;
      g.box(1, 1, 0, w, H, d, P.CONCRETE_DD);
      // vertical neon strips + louvre panels
      K.facade(g, 1, 1, 0, w, H, d, (u, v, f, len) => (u % 4 === 0 ? neon : v % 2 ? P.METAL_D : 0));
      g.box(1, 1 + H, 0, w, 1, d, P.METAL_D);
      // rooftop chillers with fans (steam wisps)
      for (let x = 2; x + 3 < w; x += 4) for (let z = 1; z + 3 < d; z += 4) { K.hvac(g, x, 2 + H, z, 3, 3, P.METAL); }
      g.emit(W / 2, 5 + H, d / 2, 'steam', 0.5);
      // backup generators + fuel tanks in the yard
      for (let x = 1; x + 3 < W; x += 4) { g.box(x, 1, d + 1, 3, 2, 2, P.WHITE); g.set(x + 1, 2, d + 2, P.METAL_D); }
      K.tank(g, W - 2, 1, D - 2, 1.2, 2, P.TANK_WHITE);
      K.fenceRect(g, 0, 0, W, D, 1, 'chain', (x, z) => z === D - 1 && x >= 1 && x < 4);
      g.light(W / 2, H / 2, d + 0.5, K.glowRGB(neon), 1.4);
    },
  },
  {
    name: 'solarlab',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      K.slab(g, P.GRASS_L);
      // panel field + a round glass research pavilion
      K.solar(g, 0, 1, 0, W, Math.max(3, D - 10));
      const r = Math.min(W, 12) / 2 - 1, cx = W / 2, cz = D - r - 2;
      g.cyl(cx, 1, cz, r, 5 + c.L, P.GLASS_CYAN);
      g.cyl(cx, 1, cz, r - 1, 5 + c.L, 0);
      K.skin(g, 0, 1, 0, W, 6 + c.L, D, (x, y) => (y % 3 === 0 ? P.WHITE : 0));
      g.cyl(cx, 6 + c.L, cz, r + 0.5, 1, P.WHITE);
      g.cyl(cx, 7 + c.L, cz, r - 1.5, 1, P.SOLAR);
      // wind turbine mast (static) on big lots
      if (W >= 16) { g.box(1, 1, D - 2, 1, 18, 1, P.WHITE); g.box(0, 19, D - 2, 3, 1, 1, P.WHITE); g.box(1, 18, D - 2, 1, 3, 1, P.WHITE); }
      g.light(cx, 3, cz, [0.6, 0.95, 1], 1.2);
      K.lamp(g, W - 1, 1, D - 1, 3, P.LAMP_WHITE, P.METAL, 0.6);
    },
  },
  {
    name: 'fab',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      K.slab(g, P.CONCRETE_L);
      const neon = c.pk(1, [P.NEON_BLUE, P.NEON_CYAN, P.NEON_PURPLE]);
      const w = W - 2, d = D - 5, H = 7 + c.L * 2;
      // chip fab: huge white box, blue accent band, rooftop stacks of scrubbers
      g.box(1, 1, 0, w, H, d, P.WHITE);
      g.box(1, 3, 0, w, 1, d, P.BLUE);
      K.facade(g, 1, 1, 0, w, 2, d, (u, v, f, len) => (f === 0 && u > 1 && u < len - 2 ? P.GLASS_DARK : 0));
      g.box(1, 1 + H, 0, w, 1, d, P.CONCRETE);
      for (let x = 3; x < w - 1; x += 4) { g.cyl(x + 0.5, 2 + H, 2.5, 1, 4, P.METAL); g.emit(x + 0.5, 7 + H, 2.5, 'steam', 0.4); }
      K.hvac(g, w - 6, 2 + H, d - 4, 4, 3);
      K.sign(g, 3, H - 2, d, Math.min(w - 5, 10), 2, neon, 0, c.rng, 0, true);
      K.parking(g, 0, d + 1, W, 4, c.rng, 0.6);
      K.tree(g, 0, 1, d, 1, 'round');
    },
  },
];

VC.models.define('grow_I1', {
  variants: 8,
  gen(rng, v, p) {
    const c = lotCtx('grow_I1', rng, v, p, 48);
    const A = I1_ARCH[v % I1_ARCH.length];
    A.build(c);
    if (c.bit(8)) mirrorX(c.g);
    return K.finish(c.g, 'I1_' + A.name);
  },
});
VC.models.define('grow_I2', {
  variants: 8,
  gen(rng, v, p) {
    const c = lotCtx('grow_I2', rng, v, p, 72);
    const A = I2_ARCH[v % I2_ARCH.length];
    A.build(c);
    if (c.bit(8)) mirrorX(c.g);
    return K.finish(c.g, 'I2_' + A.name);
  },
});
VC.models.define('grow_I3', {
  variants: 8,
  gen(rng, v, p) {
    const c = lotCtx('grow_I3', rng, v, p, 80);
    // clean high-tech at level 3 or for rich industry; heavy industry otherwise
    const tech = c.L === 3 || c.Wl === 2;
    const list = tech ? I3_TECH : I3_HEAVY;
    const A = list[v % list.length];
    A.build(c);
    if (c.bit(8)) mirrorX(c.g);
    return K.finish(c.g, 'I3_' + A.name, { tech });
  },
});
