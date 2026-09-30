/*
 * VOXELPOLIS — growable RESIDENTIAL models (see grow.js for the toolkit & conventions).
 *   grow_R1  suburbs: cottages, bungalows, family homes, A-frames, modern cubes, colonials,
 *            ranches, farmhouses, tudors, villas, victorians, chalets — lawns, fences, pools
 *   grow_R2  townhouses & walk-ups (defined below)
 *   grow_R3  residential towers (defined below)
 * Level 1..3 grows the house (floors, extensions, ornament); wealth 0..2 shifts materials and
 * amenities (chain-link & bins -> pickets & flowers -> hedges, pools, lamps, marble).
 */
const P = VC.P, M = VC.M, K = VC.growKit;
const { lotCtx, mark, isFree, findFree, mirrorX, winSlot, walls, slots, towerFloors, towerRect, plaza, lobby, roofTop, TOWER_WALL } = K;
const OCC = K.OCC;


/* ------------------------------------------------------------------ */
/* R1 palettes                                                         */
/* ------------------------------------------------------------------ */
const R1PAL = {
  wall: [
    [P.PLASTER, P.PLASTER_CREAM, P.CONCRETE_L, P.BRICK_D, P.WOOD, P.STONE, P.PLASTER_SKY, P.CONCRETE],
    [P.PLASTER_CREAM, P.PLASTER_PEACH, P.PLASTER_MINT, P.PLASTER_SKY, P.PLASTER_PINK, P.PLASTER_LEMON, P.PLASTER_LILAC, P.BRICK, P.BRICK_L, P.WOOD_L, P.WHITE],
    [P.WHITE, P.MARBLE, P.SANDSTONE, P.PLASTER_CREAM, P.BRICK_Y, P.STONE, P.PLASTER, P.BRICK_L],
  ],
  roof: [
    [P.ROOF_GREY, P.ROOF_BROWN, P.ROOF_BLACK, P.ROOF_GREY, P.RUST],
    [P.ROOF_RED, P.ROOF_TERRA, P.ROOF_SLATE, P.ROOF_GREEN, P.ROOF_BLUE, P.ROOF_BROWN, P.ROOF_TEAL, P.ROOF_RED],
    [P.ROOF_SLATE, P.ROOF_TERRA, P.ROOF_BLACK, P.COPPER_GREEN, P.ROOF_BLUE, P.ROOF_RED, P.ROOF_GREY],
  ],
  trim: [[P.CONCRETE_D, P.WOOD_D, P.CONCRETE], [P.WHITE, P.CREAM, P.WHITE], [P.WHITE, P.MARBLE, P.CREAM]],
  door: [P.WOOD_D, P.RED, P.NAVY, P.GREEN, P.BLUE, P.YELLOW, P.BLACK, P.WOOD, P.ROOF_TEAL],
  shutter: [P.GREEN, P.NAVY, P.ROOF_TEAL, P.RED, P.BLACK, P.WOOD_D, P.BLUE],
  lawn: [P.GRASS_D, P.GRASS, P.GRASS_L],
  path: [P.CONCRETE, P.SIDEWALK, P.SANDSTONE],
  drive: [P.ASPHALT, P.CONCRETE_L, P.STONE],
  cars: [[P.CAR_SILVER, P.CAR_WHITE, P.RUST, P.CAR_GREEN], [P.CAR_RED, P.CAR_BLUE, P.CAR_WHITE, P.CAR_SILVER, P.CAR_YELLOW, P.CAR_GREEN], [P.CAR_BLACK, P.CAR_RED, P.CAR_WHITE, P.CAR_SILVER]],
};

/* ------------------------------------------------------------------ */
/* R1 yard dressing                                                     */
/* ------------------------------------------------------------------ */
/**
 * Decorates the lot around the house. h = { x, z, w, d (main house rect), door (door x),
 * rects: extra occupied rects [[x,z,w,d]], drive: {x,z,w,d} | null, car (bool), trees (kinds),
 * fence: kind | undefined (auto) | null (none), pool: false to suppress }.
 */
function yard(c, h) {
  const g = c.g, W = c.W, D = c.D, Wl = c.Wl, rng = c.rng;
  mark(c, h.x, h.z, h.w, h.d, OCC.HOUSE);
  for (const r of h.rects || []) mark(c, r[0], r[1], r[2], r[3], OCC.HOUSE);
  const frontZ = h.z + h.d;
  // path from the door to the street
  const pathC = R1PAL.path[Wl];
  if (h.door != null) {
    for (let z = h.doorZ || frontZ; z < D; z++) { g.set(h.door, 0, z, pathC); mark(c, h.door, z, 1, 1, OCC.PATH); }
  }
  // driveway + car
  if (h.drive) {
    const d = h.drive;
    g.box(d.x, 0, d.z, d.w, 1, d.d, R1PAL.drive[Wl]);
    mark(c, d.x, d.z, d.w, d.d, OCC.DRIVE);
    if (h.car !== false && d.w >= 2 && d.d >= 3) K.car(g, d.x + ((d.w - 2) >> 1), 1, D - 3 - (d.z + d.d < D ? D - d.z - d.d : 0), 'z', c.pk(9, R1PAL.cars));
  }
  // pool for the rich (back or side yard)
  if (Wl === 2 && h.pool !== false) {
    const deck = c.pk(10, [P.WHITE, P.SANDSTONE, P.WOOD_L, P.MARBLE]);
    let r = findFree(c, 4, 5, frontZ) || findFree(c, 5, 4, frontZ);
    if (r) {
      const pw = isFree(c, r.x, r.z, 4, 5) ? 2 : 3, pd = pw === 2 ? 3 : 2;
      K.pool(g, r.x + 1, r.z + 1, pw, pd, deck, 0, rng);
      mark(c, r.x, r.z, pw + 2, pd + 2, OCC.POOL);
    } else if ((r = findFree(c, 2, 4, frontZ)) || (r = findFree(c, 2, 3, frontZ))) {
      const pd = isFree(c, r.x, r.z, 2, 4) ? 4 : 3;
      g.box(r.x, 0, r.z, 2, 1, pd, deck);
      g.box(r.x, 0, r.z + (pd > 3 ? 1 : 0), 2, 1, pd > 3 ? 2 : 2, P.WATER_POOL);
      mark(c, r.x, r.z, 2, pd, OCC.POOL);
    }
  }
  // flower bed / hedge row along the house front
  if (Wl >= 1 && frontZ < D - 1) {
    for (let x = h.x; x < h.x + h.w; x++) {
      if (c.occ[frontZ * W + x]) continue;
      if (Wl === 2 && (x - h.x) % 3 === 1) K.tree(g, x, 1, frontZ, 1, 'bush', P.HEDGE);
      else { g.set(x, 0, frontZ, P.SOIL); g.set(x, 1, frontZ, (x + c.ids[11]) % 2 ? c.pk(12, [P.FLOWER_R, P.FLOWER_Y, P.FLOWER_P, P.FLOWER_V]) : P.LEAF_D); }
      mark(c, x, frontZ, 1, 1, OCC.GARDEN);
    }
  }
  // front fence with gaps for path & drive
  let fence = h.fence;
  if (fence === undefined) fence = c.pk(13, [['chain', 'chain', null, 'rail'], ['picket', 'picket', 'hedge', null, 'rail', 'picket'], ['hedge2', 'iron', 'hedge', 'wall', 'hedge2']]);
  if (fence) {
    const gap = (x, z) => c.occ[z * W + x] === OCC.PATH || c.occ[z * W + x] === OCC.DRIVE;
    K.fence(g, 0, D - 1, W - 1, D - 1, 1, fence, gap);
    if (Wl === 2 && fence.startsWith('hedge')) { K.fence(g, 0, 0, 0, D - 2, 1, 'hedge', gap); K.fence(g, W - 1, 0, W - 1, D - 2, 1, 'hedge', gap); }
    else if (fence !== 'hedge') { K.fence(g, 0, 0, 0, frontZ - 1, 1, fence === 'picket' ? 'rail' : fence, gap); K.fence(g, W - 1, 0, W - 1, frontZ - 1, 1, fence === 'picket' ? 'rail' : fence, gap); }
    for (let x = 0; x < W; x++) if (!c.occ[(D - 1) * W + x]) mark(c, x, D - 1, 1, 1, OCC.GARDEN);
  }
  // trees in the largest free corners
  const kinds = h.trees || [c.pk(14, ['oak', 'round', 'birch', 'pine', 'oak', 'fruit'])];
  const nTrees = Wl === 0 ? 1 : Wl === 1 ? 2 : 3;
  let planted = 0;
  for (const s of [3, 2]) {
    for (let t = 0; t < 12 && planted < nTrees; t++) {
      const r = findFree(c, s, s, D, t % 2 === 1);
      if (!r) break;
      const kind = kinds[planted % kinds.length];
      K.tree(g, r.x + (s >> 1), 1, r.z + (s >> 1), s === 3 ? 1 + Math.min(2, c.L) : 1, kind, kind === 'oak' || kind === 'round' || kind === 'fruit' ? K.leaf(rng) : undefined);
      mark(c, r.x, r.z, s, s, OCC.GARDEN);
      planted++;
    }
  }
  // small extras
  if (Wl === 0) {
    const r = findFree(c, 2, 1);
    if (r) { K.bins(g, r.x, 1, r.z); mark(c, r.x, r.z, 2, 1, OCC.GARDEN); }
    for (let k = 0; k < 3; k++) {
      const q = findFree(c, 1, 1, D, k % 2 === 0);
      if (q) { g.set(q.x, 0, q.z, P.SOIL); mark(c, q.x, q.z, 1, 1, OCC.GARDEN); }
    }
  } else if (Wl === 1 && c.L >= 2) {
    const r = findFree(c, 3, 1);
    if (r && c.bit(15)) { g.set(r.x, 1, r.z, P.WOOD_D); g.set(r.x + 2, 1, r.z, P.WOOD_D); g.box(r.x, 2, r.z, 3, 1, 1, P.WOOD_D); g.set(r.x + 1, 1, r.z, P.RED); mark(c, r.x, r.z, 3, 1, OCC.GARDEN); } // swing set
    else if (r) { g.box(r.x, 1, r.z, 1, 1, 1, P.WOOD); g.set(r.x, 2, r.z, P.ROOF_RED); mark(c, r.x, r.z, 1, 1, OCC.GARDEN); } // dog house
  } else if (Wl === 2 && h.door != null) {
    // lamp posts beside the path at the street
    const x = h.door;
    if (x + 1 < W && !c.occ[(D - 2) * W + x + 1]) K.lamp(g, x + 1, 1, D - 2, 3, P.LAMP, P.BLACK, 0.55);
  }
  // mailbox
  if (Wl >= 1 && h.door != null && h.door > 0 && c.occ[(D - 1) * W + h.door - 1] !== OCC.DRIVE) {
    g.set(h.door - 1, 1, D - 1, P.WOOD_D);
    g.set(h.door - 1, 2, D - 1, c.pk(8, [P.BLUE, P.RED, P.BLACK, P.WHITE]));
  }
}

/* ------------------------------------------------------------------ */
/* R1 archetypes. Each build(c) draws the house and returns the yard spec. */
/* ------------------------------------------------------------------ */
/** Standard placement: house rect sized for the lot, back yard of 1+. */
function place(c, bw, bd) {
  const w = Math.min(c.W - 2, bw + Math.floor((c.W - 8) * 0.55));
  const d = Math.min(c.D - 3, bd + Math.floor((c.D - 8) * 0.45));
  const x = 1, z = Math.max(1, Math.min(c.D - d - 2, 1 + ((c.D - 8) >> 2)));
  return { x, z, w, d };
}
/** Side driveway in the free strip to the right of the house (2 wide) if there is room. */
function sideDrive(c, h, len = 3) {
  const x = h.x + h.w + (c.W - (h.x + h.w) >= 3 ? 1 : 0);
  if (c.W - x < 2) return null;
  const d = Math.min(c.D - (h.z + 1), len + h.d);
  return { x: Math.min(x, c.W - 2), z: c.D - d, w: 2, d };
}

const R1_ARCH = [
  {
    name: 'cottage',
    build(c) {
      const g = c.g, L = c.L;
      const h = place(c, L === 1 ? 5 : 6, L === 3 ? 5 : 4);
      const fh = L === 1 ? 4 : 5;
      const top = walls(c, h.x, 1, h.z, h.w, h.d, 1, { fh, sills: c.Wl ? P.WOOD : 0, lamp: c.Wl > 0, hood: L > 1 ? c.roof : 0, recess: c.Wl > 0 });
      const rt = K.roof(g, h.x, top, h.z, h.w, h.d, { type: 'gable', c: c.roof, fill: c.wall, pitch: 2 });
      if (L >= 2) K.dormer(g, h.x + (h.w >> 1) - 1, top, h.z + h.d - 2, c.wall, c.roof);
      K.chimney(g, h.x + (c.bit(1) ? 0 : h.w - 1), top - 1, h.z + 1, rt - top + 1, c.Wl ? P.BRICK_D : P.STONE_D);
      if (L === 3 && c.W >= 16) walls(c, h.x + h.w, 1, h.z + 1, 3, h.d - 1, 1, { doorU: -1 });
      return Object.assign(h, { door: h.x + (h.w >> 1), drive: L > 1 ? sideDrive(c, h) : null });
    },
  },
  {
    name: 'bungalow',
    build(c) {
      const g = c.g, L = c.L;
      const h = place(c, L === 1 ? 5 : 6, 4);
      const floors = L === 3 ? 2 : 1;
      // porch: 1 voxel deep strip in front covered by the roof
      const top = walls(c, h.x, 1, h.z, h.w, h.d - 1, floors, { lamp: true, corners: c.Wl > 0, recess: L > 1 });
      g.box(h.x, 0, h.z + h.d - 1, h.w, 1, 1, P.WOOD_L);
      for (const px of [h.x, h.x + h.w - 1, h.x + (h.w >> 1) - (h.w % 2 ? 1 : 0)]) if (px !== h.x + (h.w >> 1)) g.box(px, 1, h.z + h.d - 1, 1, 4, 1, c.trim);
      if (floors === 1) g.box(h.x, 1, h.z + h.d - 1, h.w, 1, 1, 0), g.box(h.x, 1, h.z + h.d - 1, 1, 4, 1, c.trim), g.box(h.x + h.w - 1, 1, h.z + h.d - 1, 1, 4, 1, c.trim);
      else g.box(h.x, 5, h.z + h.d - 1, h.w, 1, 1, c.roof);
      K.roof(g, h.x, top, h.z, h.w, floors === 1 ? h.d : h.d - 1, { type: 'hip', c: c.roof, fill: c.wall, pitch: L === 1 ? 1 : 0.5 });
      if (L >= 2) K.chimney(g, h.x + h.w - 2, top, h.z + 1, 3, P.BRICK);
      return Object.assign(h, { door: h.x + (h.w >> 1), drive: sideDrive(c, h) });
    },
  },
  {
    name: 'family',
    build(c) {
      const g = c.g, L = c.L;
      const h = place(c, 5, L === 1 ? 4 : 5);
      const floors = L === 1 ? 1 : 2;
      const top = walls(c, h.x, 1, h.z, h.w, h.d, floors, { lamp: true, band: c.Wl > 0, recess: c.Wl > 0, hood: c.trim });
      K.roof(g, h.x, top, h.z, h.w, h.d, { type: 'gablez', c: c.roof, fill: c.wall, pitch: 1 });
      // gable window
      g.set(h.x + (h.w >> 1), top + 1, h.z + h.d - 1, P.WIN);
      let drive = sideDrive(c, h);
      const rects = [];
      if (L === 3 && c.W - (h.x + h.w) >= 2) {
        // attached garage with flat roof + deck railing
        const gx = h.x + h.w, gw = Math.min(c.W - gx, 3), gd = h.d - 1;
        g.box(gx, 1, h.z, gw, 4, gd, c.wall);
        g.box(gx, 1, h.z + gd - 1, gw, 3, 1, c.pk(2, [P.WHITE, P.CONCRETE_L, P.WOOD_L]));
        for (let yy = 1; yy < 4; yy++) if (yy % 2) g.box(gx, yy, h.z + gd - 1, gw, 1, 1, P.CONCRETE_D);
        g.box(gx, 5, h.z, gw, 1, gd, c.trim);
        rects.push([gx, h.z, gw, gd]);
        drive = { x: gx, z: h.z + gd, w: Math.min(2, gw), d: c.D - h.z - gd };
      }
      return Object.assign(h, { door: h.x + (h.w >> 1), drive, rects });
    },
  },
  {
    name: 'aframe',
    build(c) {
      const g = c.g, L = c.L;
      const h = place(c, L === 1 ? 5 : 6, L === 3 ? 5 : 4);
      const wood = c.pk(3, [[P.WOOD_D, P.WOOD], [P.WOOD, P.WOOD_L, P.WOOD_D], [P.WOOD_L, P.WOOD]]);
      g.box(h.x, 1, h.z, h.w, 1, h.d, wood);
      const rt = K.roof(g, h.x, 1, h.z, h.w, h.d, { type: 'gablez', c: c.roof, fill: wood, pitch: 2, oh: 0 });
      // glass triangle on the front gable + door
      const fz = h.z + h.d - 1, mid = h.x + (h.w >> 1);
      for (let y = 2; y < rt; y++)
        for (let x = h.x + 1; x < h.x + h.w - 1; x++) {
          if (g.get(x, y, fz) === wood && g.get(x - 1, y, fz) && g.get(x + 1, y, fz) && g.get(x, y + 1, fz)) g.set(x, y, fz, (x - mid) % 2 === 0 && y > 2 ? wood : c.Wl ? P.GLASS_BLUE : P.WIN);
        }
      g.box(mid, 1, fz, 1, 2, 1, c.door);
      // deck in front with railing
      if (fz + 1 < c.D - 1) {
        g.box(h.x, 1, fz + 1, h.w, 1, 1, P.WOOD_L);
        if (c.Wl > 0) { g.set(h.x, 2, fz + 1, P.WOOD_D); g.set(h.x + h.w - 1, 2, fz + 1, P.WOOD_D); }
      }
      K.chimney(g, h.x + h.w - 2, rt - 3, h.z + 1, 3, P.METAL_D, null);
      if (L >= 2) K.wallLight(g, mid + 1, 2, fz + 1 < c.D ? fz + 1 : fz, P.LAMP, 0.4);
      return Object.assign(h, { door: mid, drive: sideDrive(c, h), trees: ['pine', 'pine', 'birch'], fence: c.Wl === 2 ? 'rail' : null, rects: [[h.x, h.z + h.d, h.w, 1]] });
    },
  },
  {
    name: 'modern',
    build(c) {
      const g = c.g, L = c.L, Wl = c.Wl;
      const h = place(c, 6, L === 1 ? 4 : 5);
      const wall = c.pk(4, [[P.CONCRETE_L, P.CONCRETE, P.PLASTER], [P.WHITE, P.CONCRETE_L, P.PLASTER, P.WHITE], [P.WHITE, P.MARBLE, P.WHITE, P.CONCRETE_L]]);
      const accent = c.pk(5, [[P.WOOD_D, P.CONCRETE_D], [P.WOOD, P.BLACK, P.WOOD_D], [P.WOOD, P.BLACK, P.GOLD, P.WOOD_L]]);
      const glass = Wl ? P.GLASS_BLUE : P.WIN_COOL;
      // ground box
      g.box(h.x, 1, h.z, h.w, 4, h.d, wall);
      K.facade(g, h.x, 1, h.z, h.w, 4, h.d, (u, v, f, len) => {
        if (f === 0) return u >= 1 && u <= len - 3 && v >= 0 && v <= 2 ? glass : u === len - 2 && v < 2 ? accent : 0;
        return winSlot(u, len) && v >= 1 && v <= 2 ? P.WIN_COOL : 0;
      });
      g.box(h.x, 5, h.z, h.w, 1, h.d, P.CONCRETE_DD);
      let top = 6;
      if (L >= 2) {
        // cantilevered upper box shifted sideways
        const ux = h.x + (c.bit(1) ? 0 : 1), uw = h.w - 1, ud = h.d - 1;
        g.box(ux, 6, h.z, uw, 4, ud, L === 3 ? accent : wall);
        K.facade(g, ux, 6, h.z, uw, 4, ud, (u, v, f, len) => (f === 0 ? (v >= 1 && v <= 2 && u > 0 && u < len - 1 ? glass : 0) : v === 1 || v === 2 ? (u % 3 === 1 ? P.WIN_COOL : 0) : 0));
        g.box(ux, 10, h.z, uw, 1, ud, P.CONCRETE_DD);
        // roof terrace railing on the ground box
        K.fence(g, h.x, h.z + h.d - 1, h.x + h.w - 1, h.z + h.d - 1, 6, 'rail');
        g.box(h.x, 6, h.z + h.d - 1, h.w, 1, 1, P.GLASS_CYAN);
        top = 11;
        if (L === 3) K.solar(g, ux + 1, 11, h.z + 1, uw - 2, ud - 1);
      }
      if (Wl === 2) g.box(h.x + 1, 5, h.z + h.d, h.w - 2, 1, 1, P.CONCRETE_DD); // entrance canopy
      return Object.assign(h, { door: h.x + h.w - 2, drive: sideDrive(c, h), fence: Wl === 2 ? 'hedge2' : Wl ? 'hedge' : null, trees: ['birch', 'round'] });
    },
  },
  {
    name: 'colonial',
    build(c) {
      const g = c.g, L = c.L;
      const h = place(c, L === 1 ? 6 : 7, 4);
      h.w = Math.min(h.w, c.W - 1);
      const floors = L === 1 ? 1 : 2;
      const shutter = c.pk(6, R1PAL.shutter);
      const top = walls(c, h.x, 1, h.z, h.w, h.d, floors, { lamp: true, lintel: true, recess: true, hood: L === 3 ? 0 : c.trim, doorU: h.w >> 1 });
      // shutters beside the front windows
      for (let fl = 0; fl < floors; fl++)
        for (let u = 1; u < h.w - 1; u++) {
          if (!winSlot(u, h.w) || (fl === 0 && u === h.w >> 1)) continue;
          for (const s of [u - 1, u + 1]) if (s > 0 && s < h.w - 1 && !winSlot(s, h.w) && s !== h.w >> 1) g.box(h.x + s, 2 + fl * 4, h.z + h.d, 1, 2, 1, shutter);
        }
      const rt = K.roof(g, h.x, top, h.z, h.w, h.d, { type: 'gable', c: c.roof, fill: c.wall, pitch: L === 1 ? 2 : 1 });
      if (L === 1) { K.dormer(g, h.x + 1, top, h.z + h.d - 2, c.wall, c.roof); K.dormer(g, h.x + h.w - 4, top, h.z + h.d - 2, c.wall, c.roof); }
      K.chimney(g, h.x, top - 2, h.z + 1, rt - top + 2, P.BRICK);
      if (L >= 2) K.chimney(g, h.x + h.w - 1, top - 2, h.z + 1, rt - top + 2, P.BRICK);
      if (L === 3) {
        // portico: 2 columns + pediment over the door
        const m = h.x + (h.w >> 1), fz = h.z + h.d;
        if (fz < c.D - 1) {
          g.box(m - 1, 1, fz, 1, 4, 1, P.WHITE); g.box(m + 1, 1, fz, 1, 4, 1, P.WHITE);
          g.box(m - 1, 5, fz, 3, 1, 1, P.WHITE); g.set(m, 6, fz, P.WHITE);
        }
      }
      return Object.assign(h, { door: h.x + (h.w >> 1), drive: null, fence: c.Wl ? (c.Wl === 2 ? 'hedge2' : 'picket') : 'chain', rects: L === 3 ? [[h.x + (h.w >> 1) - 1, h.z + h.d, 3, 1]] : [] });
    },
  },
  {
    name: 'ranch',
    build(c) {
      const g = c.g, L = c.L;
      const w = Math.min(c.W - 1, 7 + (c.W - 8)), d = L === 1 ? 3 : 4;
      const h = { x: 0, z: 1 + ((c.D - 8) >> 2), w, d };
      if (w >= 7) h.x = (c.W - w) >> 1;
      const top = walls(c, h.x, 1, h.z, h.w, h.d, 1, { doorU: 2, lamp: true, recess: c.Wl > 0 });
      // garage wing forward on the right
      const gw = 3, gx = h.x + h.w - gw, gz = h.z + h.d, gd = L === 1 ? 1 : 2;
      g.box(gx, 1, gz, gw, 4, gd, c.wall);
      g.box(gx, 1, gz + gd - 1, gw, 3, 1, P.WHITE);
      g.box(gx, 2, gz + gd - 1, gw, 1, 1, P.CONCRETE_L);
      K.roof(g, h.x, top, h.z, h.w, h.d, { type: 'hip', c: c.roof, fill: c.wall, pitch: 0.5 });
      K.roof(g, gx, top, gz - 1, gw, gd + 1, { type: 'gablez', c: c.roof, fill: c.wall, pitch: 0.5 });
      if (L >= 2) K.chimney(g, h.x + 1, top, h.z + 1, 2, P.STONE);
      if (L === 3 && c.Wl) g.box(h.x + 3, 1, gz, 1, 3, 1, c.trim); // porch post
      const drive = { x: gx, z: gz + gd, w: 3, d: c.D - gz - gd };
      return Object.assign(h, { door: h.x + 2, drive, car: drive.d >= 3, rects: [[gx, gz, gw, gd]] });
    },
  },
  {
    name: 'farmhouse',
    build(c) {
      const g = c.g, L = c.L;
      const h = place(c, 5, 4);
      const wall = c.pk(4, [[P.WOOD, P.PLASTER], [P.WHITE, P.CREAM, P.PLASTER_SKY, P.PLASTER_LEMON], [P.WHITE, P.CREAM]]);
      const roof = c.pk(5, [[P.RUST, P.ROOF_GREY], [P.ROOF_GREY, P.ROOF_GREEN, P.ROOF_RED, P.METAL_D], [P.ROOF_BLACK, P.COPPER_GREEN, P.ROOF_SLATE]]);
      const floors = L === 1 ? 1 : 2;
      const top = walls(c, h.x, 1, h.z, h.w, h.d - 1, floors, { wall, corners: true, trim: P.WHITE, lamp: true });
      // full-width front porch with shed roof & posts
      const pz = h.z + h.d - 1;
      g.box(h.x, 0, pz, h.w, 1, 1, P.WOOD_L);
      for (let x = h.x; x < h.x + h.w; x += 2) g.box(x, 1, pz, 1, 3, 1, P.WHITE);
      g.box(h.x - (h.x > 0 ? 1 : 0), 4, pz, h.w + (h.x > 0 ? 2 : 1), 1, 1, roof);
      if (c.Wl) for (let x = h.x; x < h.x + h.w; x++) if (x % 2) g.set(x, 1, pz, P.WHITE); // railing
      g.set(h.x + (h.w >> 1), 1, pz, 0);
      const rt = K.roof(g, h.x, top, h.z, h.w, h.d - 1, { type: 'gable', c: roof, fill: wall, pitch: 1, stripe: roof === P.METAL_D ? P.METAL : 0 });
      K.chimney(g, h.x + h.w - 2, top, h.z + 1, rt - top, P.BRICK);
      return Object.assign(h, { door: h.x + (h.w >> 1), drive: sideDrive(c, h), fence: c.Wl ? 'rail' : 'chain', trees: ['oak', 'fruit'] });
    },
  },
  {
    name: 'tudor',
    build(c) {
      const g = c.g, L = c.L;
      const h = place(c, L === 1 ? 5 : 6, 5);
      const base = c.pk(4, [[P.BRICK_D, P.STONE_D], [P.BRICK, P.STONE, P.BRICK_L], [P.STONE, P.BRICK_Y, P.BRICK]]);
      const plaster = c.pk(5, [P.CREAM, P.PLASTER_CREAM, P.PLASTER]);
      const beam = P.WOOD_D;
      const floors = L === 1 ? 1 : 2;
      const top = walls(c, h.x, 1, h.z, h.w, h.d, floors, { wall: base, upper: plaster, lamp: true, recess: true });
      if (floors === 2) {
        // half-timbering on the upper floor
        K.facade(g, h.x, 5, h.z, h.w, 4, h.d, (u, v, f, len) => (g && (u === 0 || u === len - 1 || v === 3 || v === 0 || (u % 3 === 0 && !winSlot(u, len)))) ? beam : 0);
      }
      const roof = c.pk(6, [[P.ROOF_BROWN, P.ROOF_GREY], [P.ROOF_BROWN, P.ROOF_SLATE, P.ROOF_BLACK], [P.ROOF_SLATE, P.ROOF_BLACK]]);
      const rt = K.roof(g, h.x, top, h.z, h.w, h.d, { type: 'gablez', c: roof, fill: floors === 2 ? plaster : base, pitch: 2 });
      if (floors === 2) for (let y = top; y < rt - 1; y++) g.set(h.x + (h.w >> 1), y, h.z + h.d - 1 + 0, beam);
      K.chimney(g, h.x + h.w - 1, top - 3, h.z + 2, rt - top + 3, base);
      if (L === 3) {
        // front cross-gable bay
        const bx = h.x, bz = h.z + h.d, bw = 3;
        if (bz < c.D - 2) {
          walls(c, bx, 1, bz, bw, 1, 1, { wall: base, doorU: -1 });
          K.roof(g, bx, 5, bz - 1, bw, 2, { type: 'gablez', c: roof, fill: plaster, pitch: 2, oh: 0 });
          h.rects = [[bx, bz, bw, 1]];
        }
      }
      return Object.assign(h, { door: h.x + (h.w >> 1), drive: sideDrive(c, h), trees: ['oak', 'pine'] });
    },
  },
  {
    name: 'villa',
    build(c) {
      const g = c.g, L = c.L, Wl = c.Wl;
      const h = place(c, L === 1 ? 5 : 6, L === 1 ? 4 : 5);
      const wall = c.pk(4, [[P.PLASTER_CREAM, P.PLASTER], [P.PLASTER_PEACH, P.PLASTER_CREAM, P.PLASTER_LEMON, P.WHITE], [P.WHITE, P.PLASTER_CREAM, P.SANDSTONE]]);
      const floors = L === 1 ? 1 : 2;
      const shutter = c.pk(6, [P.GREEN, P.ROOF_TEAL, P.BLUE, P.WOOD]);
      const top = walls(c, h.x, 1, h.z, h.w, h.d, floors, { wall, trim: wall, lamp: true, recess: true, sills: Wl ? P.ROOF_TERRA : 0 });
      K.roof(g, h.x, top, h.z, h.w, h.d, { type: 'hip', c: P.ROOF_TERRA, fill: wall, pitch: 0.5 });
      if (floors === 2) {
        // iron balcony on the upper floor with shuttered french door
        const m = h.x + (h.w >> 1), fz = h.z + h.d;
        g.box(m, 5, fz - 1, 1, 3, 1, P.WIN | 0);
        g.set(m - 1, 6, fz - 1, shutter); g.set(m + 1, 6, fz - 1, shutter);
        if (fz < c.D - 1) { g.box(m - 1, 5, fz, 3, 1, 1, wall); g.box(m - 1, 6, fz, 3, 1, 1, P.BLACK); g.set(m, 6, fz, 0); }
      }
      if (L === 3) {
        // little tower with a pyramid roof at the back corner
        const tx = h.x + h.w - 3, tz = h.z;
        g.box(tx, top, tz, 3, 4, 3, wall);
        g.set(tx + 1, top + 2, tz + 2, P.WIN);
        g.set(tx + 2, top + 2, tz + 1, P.WIN);
        K.roof(g, tx, top + 4, tz, 3, 3, { type: 'pyramid', c: P.ROOF_TERRA, pitch: 1, oh: 0 });
      }
      if (Wl === 2) g.emit(1.5, 2, c.D - 2.5, 'fountain', 0.3);
      if (Wl === 2) { g.cyl(1.5, 1, c.D - 2.5, 1.2, 1, P.MARBLE); g.set(1, 1, c.D - 3, P.WATER_POOL); }
      return Object.assign(h, { door: h.x + (h.w >> 1), drive: Wl === 2 ? null : sideDrive(c, h), trees: ['cypress', 'palm', 'cypress'], fence: Wl ? 'wall' : null, rects: Wl === 2 ? [[0, c.D - 4, 3, 3]] : [] });
    },
  },
  {
    name: 'victorian',
    build(c) {
      const g = c.g, L = c.L;
      const h = place(c, 5, 5);
      const wall = c.pk(4, [[P.PLASTER_SKY, P.PLASTER_MINT, P.WOOD], [P.PLASTER_LILAC, P.PLASTER_PINK, P.PLASTER_MINT, P.PLASTER_SKY, P.PLASTER_LEMON], [P.PLASTER_LILAC, P.PLASTER_MINT, P.CREAM, P.PLASTER_PINK]]);
      const floors = L === 1 ? 1 : 2;
      const top = walls(c, h.x, 1, h.z, h.w, h.d, floors, { wall, trim: P.WHITE, corners: true, band: true, lamp: true, lintel: true, doorU: 1 });
      const roof = c.pk(5, [[P.ROOF_GREY], [P.ROOF_SLATE, P.ROOF_RED, P.ROOF_TEAL], [P.ROOF_SLATE, P.COPPER_GREEN, P.ROOF_BLACK]]);
      const rt = K.roof(g, h.x, top, h.z, h.w, h.d, { type: 'gablez', c: roof, fill: wall, pitch: 2 });
      // decorative gable trim & round window
      g.set(h.x + (h.w >> 1), top + 2, h.z + h.d - 1, P.WIN);
      // corner turret with a tall pointed roof (level 2+)
      if (L >= 2) {
        const tx = h.x + h.w - 3, tz = h.z + h.d - 2;
        const th = top - 1 + 2;
        K.prism(g, tx, 1, tz, 3, th, 3, wall, 'chamfer', 1);
        for (let y = 2; y < th; y += 4) { g.set(tx + 1, y + 1, tz + 2, P.WIN); g.set(tx + 1, y + 2, tz + 2, P.WIN); g.set(tx + 2, y + 1, tz + 1, P.WIN); }
        K.roof(g, tx, th + 1, tz, 3, 3, { type: 'pyramid', c: roof, pitch: 3, oh: 0 });
        g.box(tx, th, tz, 3, 1, 3, P.WHITE);
        g.set(tx + 1, th + 1 + 5, tz + 1, P.GOLD);
      }
      // wrap porch
      const pz = h.z + h.d;
      if (pz < c.D - 1) {
        g.box(h.x, 0, pz, 3, 1, 1, P.WOOD_L);
        g.box(h.x, 1, pz, 1, 3, 1, P.WHITE);
        g.box(h.x + 2, 1, pz, 1, 3, 1, P.WHITE);
        g.box(h.x, 4, pz, 3, 1, 1, roof);
      }
      K.chimney(g, h.x + 1, top - 1, h.z + 1, rt - top + 1, P.BRICK_D);
      return Object.assign(h, { door: h.x + 1, drive: sideDrive(c, h), rects: [[h.x, pz, 3, 1]], fence: c.Wl === 2 ? 'iron' : c.Wl ? 'picket' : 'chain' });
    },
  },
  {
    name: 'chalet',
    build(c) {
      const g = c.g, L = c.L;
      const h = place(c, 6, 4);
      const floors = L === 1 ? 1 : 2;
      const log = c.pk(4, [[P.WOOD_D], [P.WOOD, P.WOOD_D], [P.WOOD_L, P.WOOD]]);
      const base = c.pk(5, [P.STONE, P.STONE_D, P.PLASTER]);
      const top = walls(c, h.x, 1, h.z, h.w, h.d, floors, { wall: floors === 2 ? base : log, upper: log, trim: P.WOOD_D, lamp: true, sills: c.Wl ? P.WOOD_D : 0 });
      // log stripes
      K.facade(g, h.x, 1, h.z, h.w, floors * 4, h.d, (u, v, f, len) => ((floors === 1 || v >= 4) && v % 2 === 1 && !(winSlot(u, len) && v % 4 >= 1 && v % 4 <= 2) && !(f === 0 && v < 2 && u === len >> 1) ? P.WOOD_D : 0));
      const roof = c.pk(6, [[P.ROOF_GREY, P.ROOF_BROWN], [P.ROOF_BROWN, P.ROOF_RED, P.ROOF_GREEN], [P.ROOF_SLATE, P.ROOF_BROWN]]);
      K.roof(g, h.x, top, h.z, h.w, h.d, { type: 'gablez', c: roof, fill: log, pitch: 1, oh: 1 });
      // balcony across the upper floor front
      if (floors === 2 && h.z + h.d < c.D - 1) {
        const fz = h.z + h.d;
        g.box(h.x, 5, fz, h.w, 1, 1, P.WOOD_D);
        for (let x = h.x; x < h.x + h.w; x++) g.set(x, 6, fz, x % 2 ? P.WOOD_L : P.FLOWER_R);
        g.box(h.x + (h.w >> 1), 5, fz - 1, 1, 3, 1, P.WIN);
      }
      K.chimney(g, h.x + 1, top, h.z + 1, 3, P.STONE_D);
      return Object.assign(h, { door: h.x + (h.w >> 1), drive: sideDrive(c, h), trees: ['pine', 'pine', 'birch'], fence: c.Wl ? 'rail' : null });
    },
  },
];

VC.models.define('grow_R1', {
  variants: 12,
  gen(rng, v, p) {
    const c = lotCtx('grow_R1', rng, v, p, 48);
    const A = R1_ARCH[v % R1_ARCH.length];
    c.wall = c.pk(0, R1PAL.wall);
    c.roof = c.pk(1, R1PAL.roof);
    c.trim = c.pk(2, R1PAL.trim);
    c.door = c.pk(3, R1PAL.door);
    K.slab(c.g, R1PAL.lawn[c.Wl]);
    const h = A.build(c);
    yard(c, h);
    if (c.bit(7)) mirrorX(c.g);
    return K.finish(c.g, 'R1_' + A.name);
  },
});

K.yard = yard;

/* ================================================================== */
/* R2 — townhouses & walk-ups                                          */
/* ================================================================== */
const R2PAL = {
  brick: [[P.BRICK_D, P.CONCRETE_D, P.BRICK, P.STONE_D], [P.BRICK, P.BRICK_D, P.BRICK_L, P.ROOF_BROWN, P.BRICK_Y], [P.BRICK_Y, P.SANDSTONE, P.BRICK_L, P.STONE, P.BRICK]],
  plaster: [[P.PLASTER, P.CONCRETE_L, P.PLASTER_CREAM, P.STONE], [P.PLASTER_PEACH, P.PLASTER_LEMON, P.PLASTER_PINK, P.PLASTER_MINT, P.PLASTER_SKY, P.PLASTER_CREAM, P.PLASTER_LILAC], [P.WHITE, P.PLASTER_CREAM, P.MARBLE, P.SANDSTONE, P.PLASTER_PEACH]],
  pastel: [P.PLASTER_PINK, P.PLASTER_MINT, P.PLASTER_SKY, P.PLASTER_LEMON, P.PLASTER_LILAC, P.PLASTER_PEACH, P.CREAM, P.PLASTER_SKY],
  stone: [[P.CONCRETE, P.STONE, P.PLASTER], [P.SANDSTONE, P.PLASTER_CREAM, P.BRICK_Y, P.STONE], [P.SANDSTONE, P.MARBLE, P.PLASTER_CREAM, P.BRICK_Y]],
};
/** Floors of an R2 building for the lot size & level. */
function r2Floors(c) {
  const big = Math.min(c.W, c.D) >= 16;
  return [0, big ? 4 : 3, big ? 6 : 4, big ? 8 : 5][c.L];
}
/** Split the lot width into row-house units ~4 voxels wide. */
function units(W) {
  const n = Math.max(1, Math.round(W / 4)), out = [];
  for (let i = 0; i < n; i++) { const x = Math.round((i * W) / n); out.push([x, Math.round(((i + 1) * W) / n) - x]); }
  return out;
}
/** Back garden behind row houses on deep lots (grass, trees, sheds). */
function backGarden(c, z1) {
  const g = c.g;
  if (z1 < 2) return;
  g.box(0, 0, 0, c.W, 1, z1, c.Wl ? P.GRASS : P.GRASS_D);
  for (let x = 0; x < c.W; x += 4) {
    K.fence(g, x, 0, x, z1 - 1, 1, c.Wl === 2 ? 'hedge' : 'rail');
    if (z1 >= 4 && (x / 4 + c.ids[5]) % 3 !== 0) K.tree(g, x + 2, 1, (z1 >> 1) - 1, Math.min(3, z1 >> 1), c.pk(6, ['oak', 'round', 'birch', 'fruit']), K.leaf(c.rng));
    else if (z1 >= 3) { g.box(x + 1, 1, 1, 2, 2, 2, P.WOOD); g.box(x + 1, 3, 1, 2, 1, 2, P.ROOF_GREY); }
  }
}
/** Front sidewalk strip with occasional street trees / planters (mid & rich). */
function frontStrip(c, z0, doorXs) {
  const g = c.g;
  g.box(0, 0, z0, c.W, 1, c.D - z0, P.SIDEWALK);
  if (c.Wl === 0) return;
  for (let x = 1; x < c.W - 1; x += 4) {
    if (doorXs.some((d) => Math.abs(d - x) <= 1)) continue;
    const z = c.D - 1;
    if (g.get(x, 1, z)) continue;
    if (c.Wl === 2) K.tree(g, x, 1, z, 1, 'round', K.leaf(c.rng));
    else { g.set(x, 1, z, P.CONCRETE_L); g.set(x, 2, z, P.HEDGE); }
  }
}

const R2_ARCH = [
  {
    name: 'brownstone',
    build(c) {
      const g = c.g, W = c.W, D = c.D, sd = 2;
      const bd = Math.min(D - sd, 10), z0 = D - sd - bd, fz = z0 + bd;
      const list = [[P.BRICK_D, P.ROOF_BROWN, P.CONCRETE_D, P.BRICK], [P.ROOF_BROWN, P.BRICK_D, P.BRICK, P.BRICK_L, P.SANDSTONE], [P.SANDSTONE, P.ROOF_BROWN, P.BRICK_Y, P.STONE]][c.Wl];
      const corn = c.pk(7, [P.CONCRETE_DD, P.WOOD_D, P.BLACK, P.STONE_D]);
      const F = r2Floors(c) - 1;
      const doors = [];
      units(W).forEach(([ux, w], i) => {
        const col = list[(c.ids[0] + i * 3) % list.length];
        const f = Math.max(2, F + (((c.ids[1] >> i) & 3) === 0 ? 1 : 0));
        const H = 2 + f * 4, top = 1 + H;
        const du = (i + c.ids[2]) % 2 ? 1 : w - 2;
        g.box(ux, 1, z0, w, H, bd, col);
        g.box(ux, 1, fz - 1, w, 2, 1, P.STONE_D); // rusticated basement
        g.set(ux + (du === 1 ? w - 2 : 1), 1, fz - 1, P.WIN);
        K.facade(g, ux, 3, z0, w, f * 4, bd, (u, v, fc, len) => {
          const r = v % 4, fl = (v / 4) | 0;
          if (fc === 0 && fl === 0 && u === du) return r < 2 ? c.door | K.RECESS : r === 2 ? P.WIN | K.RECESS : 0;
          if (u === 0 || u === len - 1) return 0;
          if (r >= 1 && r <= 2) return P.WIN | (fc === 0 ? K.RECESS : 0);
          if (r === 3 && fc === 0) return P.STONE;
          return 0;
        }, 5);
        // stoop with iron rail
        g.box(ux + du, 1, fz, 1, 2, 1, P.STONE);
        g.set(ux + du, 1, fz + 1, P.STONE);
        g.set(ux + du + (du === 1 ? -1 : 1), 3, fz, P.BLACK);
        if (c.L >= 2 || c.Wl) K.wallLight(g, ux + du + (du === 1 ? 1 : -1), 5, fz, P.LAMP, 0.35);
        doors.push(ux + du);
        // bay window over two floors
        if (c.L >= 2 && w >= 4) {
          const bu = du === 1 ? 2 : 1;
          g.box(ux + bu, 3, fz, 1, 8, 1, col);
          g.box(ux + bu, 4, fz, 1, 2, 1, P.WIN); g.box(ux + bu, 8, fz, 1, 2, 1, P.WIN);
          g.set(ux + bu, 11, fz, corn);
        }
        // cornice with brackets
        g.box(ux, top, z0, w, 1, bd + 1, corn);
        for (let x = ux; x < ux + w; x += 2) g.set(x, top - 1, fz, corn);
        if (c.Wl === 2 && i % 2 === 0) K.roofGarden(g, ux, top + 1, z0 + 1, w, bd - 3, c.rng);
        else K.chimney(g, ux + (du === 1 ? w - 1 : 0), top + 1, z0 + 1, 2, P.BRICK_D);
      });
      frontStrip(c, fz, doors);
      backGarden(c, z0);
    },
  },
  {
    name: 'painted',
    build(c) {
      const g = c.g, W = c.W, D = c.D, sd = 1;
      const bd = Math.min(D - sd, 9), z0 = D - sd - bd, fz = z0 + bd;
      const F = Math.max(2, r2Floors(c) - (c.L === 3 ? 1 : 0));
      const roof = c.pk(3, [[P.ROOF_GREY, P.ROOF_BLACK], [P.ROOF_SLATE, P.ROOF_GREY, P.ROOF_BLACK], [P.ROOF_SLATE, P.ROOF_BLACK]]);
      const doors = [];
      units(W).forEach(([ux, w], i) => {
        const pal = c.Wl === 0 ? [P.PLASTER, P.PLASTER_SKY, P.CONCRETE_L, P.PLASTER_CREAM] : K.paint().ALL.concat([P.PLASTER_PINK, P.PLASTER_LEMON]);
        const col = pal[(c.ids[0] + i * 5) % pal.length];
        const trim = c.Wl === 0 ? P.CONCRETE : i % 3 === 2 ? P.CREAM : P.WHITE;
        const du = (i + c.ids[2]) % 2 ? 1 : w - 2, bu = du === 1 ? 2 : 1;
        const top = walls(c, ux, 1, z0, w, bd, F, { wall: col, trim, corners: true, doorU: du, faces: 5, recess: true });
        // full-height bay column with white frames
        g.box(ux + bu, 2, fz, 1, F * 4 - 1, 1, col);
        for (let fl = 0; fl < F; fl++) { g.box(ux + bu, 2 + fl * 4, fz, 1, 2, 1, P.WIN); g.set(ux + bu, 4 + fl * 4, fz, trim); }
        g.set(ux + du, 1, fz, P.STONE);
        K.roof(g, ux, top, z0, w, bd, { type: 'gablez', c: roof, fill: col, pitch: 2, oh: 0 });
        g.set(ux + bu, top + 1, fz - 1, P.WIN);
        g.set(ux + du, top, fz - 1, trim);
        doors.push(ux + du);
        if (c.Wl) K.wallLight(g, ux + du, 3, fz, P.LAMP, 0.35);
      });
      frontStrip(c, fz, doors);
      backGarden(c, z0);
    },
  },
  {
    name: 'canal',
    build(c) {
      const g = c.g, W = c.W, D = c.D, sd = 1;
      const bd = Math.min(D - sd, 9), z0 = D - sd - bd, fz = z0 + bd;
      const list = [[P.BRICK_D, P.CONCRETE_DD, P.BRICK], [P.BRICK, P.BRICK_D, P.BRICK_L, P.CONCRETE_DD, P.PLASTER_CREAM], [P.BRICK_L, P.BRICK, P.WHITE, P.CONCRETE_DD, P.SANDSTONE]][c.Wl];
      const F = r2Floors(c) + 1;
      const doors = [];
      units(W).forEach(([ux, w], i) => {
        const col = list[(c.ids[0] + i * 2) % list.length];
        const frame = col === P.WHITE ? P.CONCRETE_DD : P.WHITE;
        const f = F - ((c.ids[1] >> i) & 1);
        const H = f * 4, top = 1 + H;
        g.box(ux, 1, z0, w, H, bd, col);
        const du = (i + c.ids[2]) % 2 ? 1 : w - 2;
        K.facade(g, ux, 1, z0, w, H, bd, (u, v, fc, len) => {
          const r = v % 4, fl = (v / 4) | 0;
          if (fc === 0 && fl === 0 && u === du) return r < 3 ? (r < 2 ? c.door : P.WIN) | K.RECESS : frame;
          if (u === 0 || u === len - 1) return 0;
          if (r >= 1 && r <= 2) return P.WIN | K.RECESS;
          return fc === 0 ? frame : 0;
        }, 5);
        // gable facade (crow-stepped or bell) above the roof line
        const bell = (c.ids[3] >> i) & 1;
        K.roof(g, ux, top, z0, w, bd, { type: 'gablez', c: P.ROOF_BROWN, fill: col, pitch: 2, oh: 0 });
        const z = fz - 1;
        g.box(ux, top, z, w, 3, 1, col);
        g.box(ux + 1, top + 3, z, w - 2, 2, 1, col);
        g.box(ux + 1, top + 1, z, w - 2, 2, 1, P.WIN);
        if (bell) { g.set(ux, top + 2, z, frame); g.set(ux + w - 1, top + 2, z, frame); g.box(ux + 1, top + 5, z, w - 2, 1, 1, frame); }
        else { g.set(ux, top + 3, z, 0); g.set(ux + w - 1, top + 3, z, 0); g.set(ux + 1, top + 5, z, col); }
        g.set(ux + (w >> 1), top + 4, fz, P.WOOD_D); // hoist beam
        doors.push(ux + du);
      });
      frontStrip(c, fz, doors);
      backGarden(c, z0);
    },
  },
  {
    name: 'walkup',
    build(c) {
      const g = c.g, W = c.W, D = c.D, sd = 1;
      const bd = D - sd - (D > 8 ? 2 : 0), z0 = D - sd - bd, fz = z0 + bd;
      const brick = c.pk(0, R2PAL.brick), trim = c.pk(1, [[P.CONCRETE, P.STONE_D], [P.STONE, P.CONCRETE_L, P.SANDSTONE], [P.MARBLE, P.SANDSTONE, P.WHITE]]);
      const F = r2Floors(c) + (c.W >= 16 ? 0 : 1);
      g.box(0, 1, z0, W, F * 4, bd, brick);
      const du = W >> 1;
      K.facade(g, 0, 1, z0, W, F * 4, bd, (u, v, f, len) => {
        const r = v % 4, fl = (v / 4) | 0;
        if (f === 0 && fl === 0 && (u === du || (W >= 16 && u === du - 1))) return r < 3 ? (r < 2 ? P.WOOD_D : P.WIN) | K.RECESS : trim;
        if (u <= 0 || u >= len - 1 || (u - 1) % 2) return 0;
        if (r >= 1 && r <= 2) return P.WIN;
        if (r === 3) return trim;
        return 0;
      });
      // cornice
      const top = 1 + F * 4;
      g.box(0, top, z0, W, 1, bd + 1, trim);
      for (let x = 0; x < W; x += 2) g.set(x, top - 1, fz, trim);
      K.ring(g, 0, top + 1, z0, W, bd, brick);
      // fire escape (front)
      const span = Math.min(5, W - 3), fx = c.bit(4) ? 1 : W - 1 - span;
      for (let fl = 1; fl < F; fl++) {
        const y = 1 + fl * 4;
        g.box(fx, y, fz, span, 1, 1, P.BLACK);
        g.box(fx, y + 2, fz, span, 1, 1, P.BLACK);
        g.set(fx, y + 1, fz, P.BLACK); g.set(fx + span - 1, y + 1, fz, P.BLACK);
        if (fl < F - 1) g.line(fx + 1, y + 1, fz, fx + span - 2, y + 3, fz, P.METAL_D);
      }
      // window AC units
      if (c.Wl < 2) for (let fl = 1; fl < F; fl++) for (let u = 1; u < W - 1; u += 2) if (M.hash(u, fl, c.v) < 0.18 && (u < fx - 1 || u > fx + span)) K.wallAc(g, u, 1 + fl * 4, fz);
      // steps + lamps
      g.box(du - (W >= 16 ? 1 : 0), 0, fz, W >= 16 ? 2 : 1, 1, 1, P.STONE);
      K.wallLight(g, du + 1, 3, fz, P.LAMP, 0.4);
      // roof: water tank, hatch
      if (bd >= 6) K.waterTank(g, c.bit(4) ? W - 5 : 1, top + 1, z0 + 1, c.Wl === 2 ? P.WOOD : P.WOOD_D);
      g.box(c.bit(4) ? 1 : W - 3, top + 1, z0 + bd - 3, 2, 2, 2, P.CONCRETE_D);
      if (c.L === 3 && W >= 16) K.ac(g, W >> 1, top + 1, z0 + 2);
      frontStrip(c, fz, [du]);
      if (z0 > 1) backGarden(c, z0);
    },
  },
  {
    name: 'modern',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const bd = D - 2 - (D > 8 ? 2 : 0), z0 = D - 2 - bd, fz = z0 + bd;
      const wall = c.pk(0, [[P.CONCRETE_L, P.CONCRETE], [P.WHITE, P.CONCRETE_L, P.PLASTER], [P.WHITE, P.MARBLE]]);
      const acc = c.pk(1, [[P.CONCRETE_D, P.WOOD_D], [P.WOOD, P.CONCRETE_DD, P.STEEL_BLUE], [P.WOOD, P.GOLD, P.BLACK]]);
      const F = r2Floors(c);
      const win = c.Wl === 2 ? P.GLASS_BLUE : P.WIN_COOL;
      K.section(g, 0, 1, z0, W, bd, F, 4, { wall, win, style: 'paired' });
      // lobby
      g.box(1, 1, fz - 1, W - 2, 3, 1, P.GLASS_DARK);
      g.box(W >> 1, 1, fz - 1, 1, 2, 1, P.WIN_SHOP);
      // balconies on the front, alternating accent panels
      for (let fl = 1; fl < F; fl++) {
        const y = 1 + fl * 4;
        g.box(0, y, fz, W, 1, 1, wall);
        g.box(0, y + 1, fz, W, 1, 1, P.GLASS_CYAN);
        for (let x = 0; x < W; x += 4) g.box(x + ((fl & 1) ? 0 : 2), y + 1, fz, 1, 3, 1, acc);
      }
      // penthouse setback & roof
      const top = 1 + F * 4;
      g.box(0, top, z0, W, 1, bd, P.CONCRETE_D);
      if (c.L >= 2) {
        const pd = bd - 3;
        K.section(g, 1, top + 1, z0, W - 2, pd, 1, 4, { wall: acc === P.GOLD ? P.WHITE : acc, win: P.GLASS_BLUE, style: 'ribbon' });
        g.box(1, top + 5, z0, W - 2, 1, pd, P.CONCRETE_DD);
        g.box(0, top + 1, z0 + bd - 1, W, 1, 1, P.GLASS_CYAN);
        if (c.Wl === 2 && W >= 8) K.umbrella(g, 2, top + 1, z0 + bd - 2, P.AWNING_B);
        if (c.L === 3) K.solar(g, 2, top + 6, z0 + 1, W - 4, pd - 1);
      } else if (c.Wl) K.roofGarden(g, 1, top + 1, z0 + 1, W - 2, bd - 2, c.rng);
      g.box(0, 4, fz, W, 1, 1, acc); // entrance canopy band
      frontStrip(c, fz, [W >> 1]);
      if (z0 > 1) backGarden(c, z0);
    },
  },
  {
    name: 'courtyard',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const wall = c.pk(0, R2PAL.plaster), roof = c.pk(1, [[P.ROOF_GREY, P.ROOF_BROWN], [P.ROOF_TERRA, P.ROOF_RED, P.ROOF_TERRA], [P.ROOF_TERRA, P.ROOF_SLATE]]);
      const F = r2Floors(c) - 1, fh = 4, H = F * fh;
      const ww = W >= 16 ? 5 : 4, wd = D >= 16 ? 5 : 4;
      const three = W >= 16 && D >= 16;
      const wings = three ? [[0, 0, ww, D - 1], [W - ww, 0, ww, D - 1], [0, 0, W, wd]] : [[0, 0, W, wd], [0, 0, ww, D - 1]];
      for (const [x, z, w, d] of wings) walls(c, x, 1, z, w, d, F, { wall, doorU: -1, trim: wall, recess: c.Wl > 0 });
      for (const [x, z, w, d] of wings) K.roof(g, x, 1 + H, z, w, d, { type: 'hip', c: roof, fill: wall, pitch: 1, oh: 0 });
      // courtyard garden
      const cx0 = ww, cz0 = wd, cx1 = three ? W - ww : W, cz1 = D - 1;
      g.box(cx0, 0, cz0, cx1 - cx0, 1, cz1 - cz0 + 1, c.Wl ? P.GRASS : P.GRASS_D);
      const mx = (cx0 + cx1) >> 1, mz = (cz0 + cz1) >> 1;
      for (let z = cz0; z <= cz1; z++) g.set(mx, 0, z, P.SANDSTONE);
      if (c.Wl === 2 && cx1 - cx0 >= 5) { g.cyl(mx + 0.5, 1, mz + 0.5, 1.6, 1, P.MARBLE); g.set(mx, 1, mz, P.WATER_POOL); g.emit(mx + 0.5, 2, mz + 0.5, 'fountain', 0.4); }
      else if (cx1 - cx0 >= 3) K.tree(g, mx + (cx1 - cx0 >= 5 ? 1 : 0), 1, mz, Math.min(3, (cx1 - cx0) >> 1), c.pk(6, ['oak', 'round', 'birch']), K.leaf(c.rng));
      if (cx1 - cx0 >= 6) { K.tree(g, cx0 + 1, 1, cz0 + 1, 1, 'bush'); K.tree(g, cx1 - 2, 1, cz0 + 1, 1, 'bush'); }
      // entrance door in the courtyard + gate
      g.set(mx, 1, cz0 - 1, c.door); g.set(mx, 2, cz0 - 1, c.door);
      K.fence(g, cx0, D - 1, cx1 - 1, D - 1, 1, c.Wl ? 'iron' : 'chain', (x) => x === mx);
      K.wallLight(g, mx + 1, 3, cz0, P.LAMP, 0.4);
      g.box(0, 0, D - 1, ww, 1, 1, P.SIDEWALK);
      if (three) g.box(W - ww, 0, D - 1, ww, 1, 1, P.SIDEWALK);
    },
  },
  {
    name: 'haussmann',
    build(c) {
      const g = c.g, W = c.W, D = c.D, sd = 1;
      const bd = D - sd - (D > 8 ? 2 : 0), z0 = D - sd - bd, fz = z0 + bd;
      const stone = c.pk(0, R2PAL.stone), slate = c.pk(1, [P.ROOF_SLATE, P.ROOF_BLUE, P.METAL_D, P.ROOF_GREY]);
      const F = r2Floors(c) + 1;
      // ground floor: rusticated, taller
      g.box(0, 1, z0, W, 5, bd, stone);
      const gs = slots(W, 3);
      K.facade(g, 0, 1, z0, W, 5, bd, (u, v, f) => {
        if (f === 0 && (u === W >> 1 || u === (W >> 1) - 1) && v < 4) return P.WOOD_D | K.RECESS;
        if (f === 0 && gs[u] && v >= 1 && v <= 3) return P.WIN | K.RECESS;
        return v % 2 ? P.STONE : 0;
      }, 1);
      // upper floors with tall windows
      const yb = 6;
      g.box(0, yb, z0, W, (F - 1) * 4, bd, stone);
      const ws = slots(W, 2);
      K.facade(g, 0, yb, z0, W, (F - 1) * 4, bd, (u, v, f, len) => {
        const r = v % 4;
        if (!(f === 0 ? ws[u] : winSlot(u, len))) return 0;
        return r >= 1 ? P.WIN | K.RECESS : 0;
      }, 5);
      // iron balconies on the 2nd and top floors
      for (const fl of [1, F - 1]) {
        const y = yb + (fl - 1) * 4;
        g.box(0, y, fz, W, 1, 1, stone);
        g.box(0, y + 1, fz, W, 1, 1, P.BLACK);
      }
      const top = yb + (F - 1) * 4;
      g.box(0, top, z0, W, 1, bd + 1, stone); // cornice
      // zinc mansard with dormers
      K.roof(g, 0, top + 1, z0, W, bd, { type: 'mansard', c: slate, fill: stone, pitch: 2, cap: 4, oh: 0, top: P.CONCRETE_DD });
      for (let u = 1; u < W - 1; u++) if (ws[u]) { g.box(u, top + 1, fz - 2, 1, 2, 2, stone); g.set(u, top + 2, fz - 1, P.WIN); g.set(u, top + 3, fz - 2, slate); }
      // chimney stacks on the party walls
      for (const x of [0, W - 1]) { g.box(x, top + 1, z0 + 1, 1, 6, 2, P.BRICK_L); g.set(x, top + 7, z0 + 1, P.ROOF_TERRA); g.set(x, top + 7, z0 + 2, P.ROOF_TERRA); }
      K.wallLight(g, (W >> 1) + 1, 4, fz, P.LAMP, 0.45);
      K.wallLight(g, (W >> 1) - 2, 4, fz, P.LAMP, 0.45);
      frontStrip(c, fz, [W >> 1, (W >> 1) - 1]);
      if (z0 > 1) backGarden(c, z0);
    },
  },
  {
    name: 'stucco',
    build(c) {
      const g = c.g, W = c.W, D = c.D, sd = 1;
      const bd = D - sd - (D > 8 ? 3 : 0), z0 = D - sd - bd, fz = z0 + bd;
      const wall = c.pk(0, R2PAL.plaster), shutter = c.pk(1, [P.GREEN, P.ROOF_TEAL, P.BLUE, P.WOOD, P.GREEN]);
      const F = r2Floors(c);
      g.box(0, 1, z0, W, F * 4, bd, wall);
      const s = slots(W, 3), sd2 = slots(bd, 3);
      const du = W >> 1;
      K.facade(g, 0, 1, z0, W, F * 4, bd, (u, v, f, len) => {
        const r = v % 4, fl = (v / 4) | 0;
        const S = f & 1 ? sd2 : s;
        if (f === 0 && fl === 0 && u === du) return r < 2 ? c.door | K.RECESS : 0;
        if (S[u] && r >= 1 && r <= 2) return P.WIN | K.RECESS;
        if (f === 0 && (S[u - 1] || S[u + 1]) && r >= 1 && r <= 2 && u > 0 && u < len - 1) return shutter;
        return 0;
      });
      // flower ledges + laundry lines
      for (let fl = 1; fl < F; fl++) {
        for (let u = 1; u < W - 1; u++) if (s[u]) { g.set(u, 1 + fl * 4, fz, wall); g.set(u, 2 + fl * 4, fz, c.rng.pick([P.FLOWER_R, P.FLOWER_P, P.FLOWER_Y, P.LEAF])); }
        if (c.Wl === 0 && (fl + c.ids[5]) % 2 === 0) for (let u = 1; u < W - 1; u++) if (!s[u] && u % 2) g.set(u, 3 + fl * 4, fz, c.rng.pick([P.WHITE, P.RED, P.BLUE, P.YELLOW]));
      }
      const top = 1 + F * 4;
      K.roof(g, 0, top, z0, W, bd, { type: 'hip', c: P.ROOF_TERRA, fill: wall, pitch: 0.5, oh: 0 });
      g.box(0, top, fz, W, 1, 1, P.ROOF_TERRA);
      K.wallLight(g, du + 1, 3, fz, P.LAMP, 0.4);
      frontStrip(c, fz, [du]);
      if (c.Wl === 2) g.box(0, 0, fz, W, 1, D - fz, P.SANDSTONE);
      if (z0 > 1) backGarden(c, z0);
    },
  },
  {
    name: 'panel',
    build(c) {
      const g = c.g, W = c.W, D = c.D;
      const bd = Math.min(D - 2, D > 8 ? 10 : 6), z0 = D - 1 - bd, fz = z0 + bd;
      const wall = c.pk(0, [[P.CONCRETE, P.CONCRETE_D, P.STONE], [P.CONCRETE_L, P.PLASTER, P.PLASTER_SKY], [P.WHITE, P.CONCRETE_L, P.PLASTER_CREAM]]);
      const F = r2Floors(c) + 1;
      const cols = [P.PLASTER_SKY, P.PLASTER_LEMON, P.PLASTER_PINK, P.CONCRETE_L, P.WIN_COOL, P.PLASTER_MINT];
      g.box(0, 1, z0, W, F * 3, bd, wall);
      K.facade(g, 0, 1, z0, W, F * 3, bd, (u, v, f, len) => {
        const r = v % 3, fl = (v / 3) | 0;
        if (u <= 0 || u >= len - 1 || r === 0) return P.CONCRETE_D;
        if (f !== 0) return (u - 1) % 3 === 0 && r === 1 ? P.WIN : 0;
        const bay = (u - 1) >> 2, m = (u - 1) % 4;
        if (fl === 0) return u === len >> 1 ? (r === 1 ? c.door : 0) : m === 1 && r === 1 ? P.WIN : 0;
        if (m === 3) return 0;
        const colr = c.Wl === 2 ? P.GLASS_CYAN : cols[(M.hashU(bay, fl, c.v) >> 3) % cols.length];
        return r === 1 ? colr : P.WIN;
      });
      const top = 1 + F * 3;
      g.box(0, top, z0, W, 1, bd, P.CONCRETE_DD);
      g.box(1, top + 1, z0 + 1, 3, 3, 3, wall); // elevator housing
      for (let k = 0; k < 2 + c.L; k++) { const x = 5 + k * 2; if (x < W - 1) { g.box(x, top + 1, z0 + 2, 1, 3, 1, P.METAL_D); g.set(x, top + 4, z0 + 2, P.METAL); } }
      // satellite dishes
      for (let k = 0; k < 3 + c.L; k++) { const u = 1 + ((M.hashU(k, 7, c.v) >> 4) % (W - 2)), fl = 1 + ((M.hashU(k, 9, c.v) >> 4) % Math.max(1, F - 1)); g.set(u, 2 + fl * 3, fz, P.WHITE); }
      g.box(0, 0, fz, W, 1, D - fz, P.SIDEWALK);
      g.box((W >> 1) - 1, 3, fz, 3, 1, 1, P.CONCRETE_DD);
      K.wallLight(g, (W >> 1) + 1, 2, fz, P.LAMP_WHITE, 0.4);
      g.box(0, 0, 0, W, 1, z0, P.GRASS_D);
    },
  },
  {
    name: 'loft',
    build(c) {
      const g = c.g, W = c.W, D = c.D, sd = 1;
      const bd = D - sd - (D > 8 ? 2 : 0), z0 = D - sd - bd, fz = z0 + bd;
      const brick = c.pk(0, [[P.BRICK_D, P.BRICK], [P.BRICK, P.BRICK_D, P.BRICK_L], [P.BRICK_L, P.BRICK, P.BRICK_Y]]);
      const F = Math.max(2, r2Floors(c) - 1), fh = 5;
      g.box(0, 1, z0, W, F * fh, bd, brick);
      K.facade(g, 0, 1, z0, W, F * fh, bd, (u, v, f, len) => {
        const r = v % fh, fl = (v / fh) | 0;
        if (u <= 0 || u >= len - 1 || u % 3 === 0) return 0;
        if (fl === 0 && f === 0) return r < 4 ? (r === 3 ? P.BLACK : P.WIN_SHOP) : 0;
        if (r >= 1 && r <= 3) return r === 2 ? P.BLACK : P.WIN;
        return r === 4 ? P.CONCRETE_L : 0;
      });
      const top = 1 + F * fh;
      g.box(0, top, z0, W, 1, bd, P.CONCRETE_D);
      K.ring(g, 0, top + 1, z0, W, bd, brick);
      // roof terrace with string lights & umbrellas
      if (c.Wl >= 1) {
        g.box(1, top + 1, z0 + 1, W - 2, 1, bd - 2, P.WOOD_L);
        K.umbrella(g, 3, top + 2, z0 + 3, c.pk(5, [P.AWNING_R, P.AWNING_Y, P.AWNING_G, P.AWNING_B]));
        for (let x = 1; x < W - 1; x++) g.set(x, top + 4 - ((x & 1) ? 1 : 0), z0 + bd - 1, (x & 1) ? P.LAMP : P.BLACK);
        g.light(W / 2, top + 4, z0 + bd - 0.5, [1, 0.8, 0.5], 0.9);
        if (c.Wl === 2) K.planter(g, W - 3, top + 2, z0 + 1, 2, bd - 3);
      }
      if (bd >= 7 && c.L >= 2) K.waterTank(g, W - 5, top + 2, z0 + 1, P.WOOD);
      g.box(0, 0, fz, W, 1, D - fz, P.SIDEWALK);
      g.box(W >> 1, 1, fz - 1, 1, 3, 1, P.STEEL_BLUE);
      K.wallLight(g, (W >> 1) + 1, 4, fz, P.LAMP, 0.45);
      if (z0 > 1) backGarden(c, z0);
    },
  },
];

const R3_ARCH = [
  {
    name: 'balcony',
    build(c) {
      const g = c.g, F = towerFloors(c), m = c.W >= 16 ? 2 : 1;
      const t = towerRect(c, m, 14, 12);
      plaza(c, t, c.Wl === 2);
      const wall = c.pk(0, TOWER_WALL.light), win = c.Wl === 2 ? P.GLASS_CYAN : P.WIN_COOL;
      let y = lobby(c, t.x, 1, t.z, t.w, t.d, wall);
      const all = c.Wl === 2 ? 15 : 5;
      K.section(g, t.x, y, t.z, t.w, t.d, F, 3, { wall, win, spandrel: wall, trim: wall, style: 'ribbon' });
      for (let f = 0; f < F; f++) K.balconies(g, t.x, y + f * 3, t.z, t.w, t.d, wall, f % 4 === 3 && c.Wl ? P.GLASS_BLUE : P.GLASS_CYAN, 'rect', 1, all);
      y += F * 3;
      K.fins(g, t.x - 1, y, t.z - 1, t.w + 2, t.d + 2, 3, wall);
      roofTop(c, t.x, y, t.z, t.w, t.d);
      if (c.L >= 2) K.crownBand(g, t.x, y + 1, t.z, t.w, t.d, c.pk(4, [P.NEON_CYAN, P.NEON_PINK, P.NEON_BLUE, P.LAMP_WHITE]));
    },
  },
  {
    name: 'setback',
    build(c) {
      const g = c.g, F = towerFloors(c), m = c.W >= 16 ? 1 : 1;
      const t = towerRect(c, m, 16, 14);
      plaza(c, t, c.Wl === 2);
      const wall = c.pk(0, TOWER_WALL.stone), win = P.WIN;
      let y = lobby(c, t.x, 1, t.z, t.w, t.d, wall, 5);
      const tiers = [Math.ceil(F * 0.5), Math.ceil(F * 0.3), F - Math.ceil(F * 0.5) - Math.ceil(F * 0.3)];
      let r = { x: t.x, z: t.z, w: t.w, d: t.d };
      tiers.forEach((n, i) => {
        if (n <= 0 || r.w < 3 || r.d < 3) return;
        K.section(g, r.x, y, r.z, r.w, r.d, n, 3, { wall, win, style: c.Wl === 2 ? 'deco' : 'punched', spandrel: P.CONCRETE_DD });
        y += n * 3;
        g.box(r.x, y, r.z, r.w, 1, r.d, wall);
        const ni = c.W >= 16 ? 2 : 1;
        const nr = { x: r.x + ni, z: r.z + ni, w: r.w - 2 * ni, d: r.d - 2 * ni };
        if (i < 2 && nr.w >= 3 && nr.d >= 3) {
          // terrace: garden ring + railing
          if (c.Wl) { K.ring(g, r.x, y + 1, r.z, r.w, r.d, c.Wl === 2 ? P.GLASS_CYAN : P.METAL_D); for (let k = 0; k < 4; k++) K.tree(g, r.x + 1 + ((k & 1) ? r.w - 3 : 0), y + 1, r.z + 1 + ((k & 2) ? r.d - 3 : 0), 1, 'bush', K.leaf(c.rng)); }
          else K.ring(g, r.x, y + 1, r.z, r.w, r.d, wall);
          y += 1;
          r = nr;
        }
      });
      roofTop(c, r.x, y, r.z, r.w, r.d, { mast: F > 26, striped: true });
    },
  },
  {
    name: 'round',
    build(c) {
      const g = c.g, F = towerFloors(c), m = c.W >= 16 ? 2 : 1;
      const t = towerRect(c, m, 13, 13);
      const s = Math.min(t.w, t.d);
      t.x = (c.W - s) >> 1; t.w = t.d = s;
      plaza(c, t, c.Wl === 2);
      const wall = c.pk(0, TOWER_WALL.light), win = c.Wl === 2 ? P.GLASS_BLUE : P.WIN_COOL;
      let y = 1;
      K.prism(g, t.x, y, t.z, s, 4, s, wall, 'circle');
      K.skin(g, t.x, y, t.z, t.x + s, y + 3, t.z + s, () => P.GLASS_DARK);
      g.set(t.x + (s >> 1), 1, t.z + s - 1, P.WIN_SHOP); g.set(t.x + (s >> 1), 2, t.z + s - 1, P.WIN_SHOP);
      y += 4;
      K.section(g, t.x, y, t.z, s, s, F, 3, { wall, win, spandrel: wall, style: 'ribbon', shape: 'circle', trim: win });
      const step = s <= 8 ? 4 : F > 24 ? 3 : 2;
      for (let f = step - 1; f < F; f += step) K.balconies(g, t.x, y + f * 3, t.z, s, s, wall, P.GLASS_CYAN, 'circle', 1);
      y += F * 3;
      K.prism(g, t.x, y, t.z, s, 1, s, P.CONCRETE_D, 'circle');
      const neon = c.pk(4, [P.NEON_CYAN, P.NEON_PURPLE, P.NEON_BLUE, P.NEON_PINK]);
      K.crownBand(g, t.x, y, t.z, s, s, c.L >= 2 ? neon : P.LAMP_WHITE, 'circle');
      // stepped cap
      K.prism(g, t.x + 2, y + 1, t.z + 2, s - 4, 3, s - 4, wall, 'circle');
      K.prism(g, t.x + 3, y + 4, t.z + 3, Math.max(2, s - 6), 2, Math.max(2, s - 6), win, 'circle');
      const top = y + 6;
      if (top > 60) K.antenna(g, t.x + (s >> 1), top, t.z + (s >> 1), Math.min(16, 148 - top), true);
    },
  },
  {
    name: 'brick70s',
    build(c) {
      const g = c.g, F = towerFloors(c), m = c.W >= 16 ? 2 : 1;
      const t = towerRect(c, m, 14, 10);
      plaza(c, t, false);
      const wall = c.pk(0, [[P.BRICK_D, P.CONCRETE_D, P.BRICK], [P.BRICK, P.BRICK_L, P.BRICK_Y, P.CONCRETE], [P.BRICK_Y, P.BRICK_L, P.SANDSTONE]]);
      let y = lobby(c, t.x, 1, t.z, t.w, t.d, P.CONCRETE_D);
      K.section(g, t.x, y, t.z, t.w, t.d, F, 3, { wall, win: P.WIN, style: 'punched' });
      // vertical concrete strips & window ACs
      for (const x of [t.x + (t.w >> 1)]) g.box(x, y, t.z + t.d - 1, 1, F * 3, 1, P.CONCRETE_L);
      if (c.Wl < 2) for (let f = 1; f < F; f++) for (let u = 1; u < t.w - 1; u += 2) if (M.hash(u, f, c.v + 3) < 0.12) K.wallAc(g, t.x + u, y + f * 3, t.z + t.d);
      y += F * 3;
      g.box(t.x, y, t.z, t.w, 1, t.d, P.CONCRETE_DD);
      K.ring(g, t.x, y + 1, t.z, t.w, t.d, wall);
      if (t.w >= 6 && t.d >= 6) K.waterTank(g, t.x + 1, y + 1, t.z + 1, P.WOOD_D);
      if (t.w >= 12) K.waterTank(g, t.x + t.w - 5, y + 1, t.z + 1, P.WOOD);
      K.penthouse(g, t.x + (t.w >> 1) - 1, y + 1, t.z + t.d - 4, 3, 3, 3);
      if (y > 60) K.antenna(g, t.x + t.w - 2, y + 1, t.z + t.d - 2, Math.min(14, 148 - y), true, true);
    },
  },
  {
    name: 'stacked',
    build(c) {
      const g = c.g, F = towerFloors(c), m = c.W >= 16 ? 2 : 1;
      const base = towerRect(c, m + 1, 12, 11);
      plaza(c, base, c.Wl === 2);
      const glass = c.pk(0, TOWER_WALL.glass), frame = c.pk(1, [[P.CONCRETE_D], [P.BLACK, P.WHITE, P.CONCRETE_DD], [P.WHITE, P.GOLD, P.BLACK]]);
      let y = lobby(c, base.x, 1, base.z, base.w, base.d, frame);
      let f = 0, k = 0;
      const jr = c.W >= 16 ? 2 : 1;
      while (f < F) {
        const n = Math.min(F - f, 3 + ((c.ids[10] >> k) % 3));
        const dx = ((M.hashU(k, 1, c.v) % (2 * jr + 1)) - jr), dz = ((M.hashU(k, 2, c.v) % (2 * jr + 1)) - jr);
        const x = M.clamp(base.x + dx, 0, c.W - base.w), z = M.clamp(base.z + dz, 0, c.D - base.d);
        K.section(g, x, y, z, base.w, base.d, n, 3, { wall: glass, win: P.WIN_COOL, glass, style: 'curtain' });
        K.ring(g, x, y + n * 3 - 1, z, base.w, base.d, frame);
        y += n * 3;
        // terrace on top of this box (partly covered by the next one)
        g.box(x, y, z, base.w, 1, base.d, c.Wl ? P.WOOD_L : P.CONCRETE_D);
        if (c.Wl) for (let q = 0; q < 3; q++) K.tree(g, x + ((M.hashU(k, q + 5, c.v) >> 3) % base.w), y + 1, z + ((M.hashU(k, q + 9, c.v) >> 3) % base.d), 1, 'bush', K.leaf(c.rng));
        f += n; k++;
      }
      g.box(base.x, y, base.z, base.w, 1, base.d, frame);
      roofTop(c, base.x, y, base.z, base.w, base.d, { noPool: true });
    },
  },
  {
    name: 'forest',
    build(c) {
      const g = c.g, F = towerFloors(c), m = c.W >= 16 ? 2 : 1;
      const t = towerRect(c, m, 12, 12);
      plaza(c, t, true);
      const wall = c.pk(0, [[P.CONCRETE], [P.CONCRETE_L, P.WHITE], [P.WHITE, P.CONCRETE_L]]);
      let y = lobby(c, t.x, 1, t.z, t.w, t.d, P.CONCRETE_D);
      K.section(g, t.x, y, t.z, t.w, t.d, F, 3, { wall, win: P.WIN_COOL, style: 'paired' });
      const leaves = [P.LEAF, P.LEAF_L, P.LEAF_D, P.BIRCH_LEAF];
      const step = t.w <= 6 ? 4 : F > 24 ? 3 : 2, gap = t.w <= 6 ? 4 : 3;
      for (let f = 0; f < F; f++) {
        const yy = y + f * 3;
        if (f % step !== step - 1) continue;
        K.balconies(g, t.x, yy, t.z, t.w, t.d, P.CONCRETE_L, P.HEDGE, 'rect', 1);
        {
          // shrubs & little trees poking out of the planter rail
          for (let a = 0; a < 2 * (t.w + t.d) + 4; a += gap) {
            const h = M.hashU(a, f, c.v);
            const col = leaves[h % leaves.length];
            let x, z;
            if (a < t.w + 2) { x = t.x - 1 + a; z = t.z + t.d; } else if (a < 2 * (t.w + 2)) { x = t.x - 1 + a - (t.w + 2); z = t.z - 1; } else if (a < 2 * (t.w + 2) + t.d) { x = t.x - 1; z = t.z + a - 2 * (t.w + 2); } else { x = t.x + t.w; z = t.z + a - 2 * (t.w + 2) - t.d; }
            g.set(x, yy + 2, z, col);
            if (h & 16) g.set(x, yy + 3, z, col);
          }
        }
      }
      y += F * 3;
      g.box(t.x, y, t.z, t.w, 1, t.d, P.GRASS);
      for (let k = 0; k < 4; k++) K.tree(g, t.x + 1 + (k & 1) * (t.w - 3), y + 1, t.z + 1 + (k >> 1) * (t.d - 3), 2, 'oak', leaves[k]);
      if (y > 70) K.antenna(g, t.x + (t.w >> 1), y + 1, t.z + (t.d >> 1), Math.min(12, 148 - y), true);
    },
  },
  {
    name: 'deco',
    build(c) {
      const g = c.g, F = towerFloors(c), m = 1;
      const t = towerRect(c, m, 16, 14);
      plaza(c, t, c.Wl === 2);
      const wall = c.pk(0, TOWER_WALL.stone), roofC = c.pk(1, [[P.ROOF_GREY], [P.COPPER_GREEN, P.ROOF_SLATE], [P.COPPER_GREEN, P.GOLD]]);
      let y = lobby(c, t.x, 1, t.z, t.w, t.d, wall, 5);
      const F1 = Math.ceil(F * 0.65), F2 = F - F1;
      K.section(g, t.x, y, t.z, t.w, t.d, F1, 3, { wall, win: P.WIN, style: 'deco', spandrel: P.CONCRETE_DD });
      y += F1 * 3;
      g.box(t.x, y, t.z, t.w, 1, t.d, wall);
      const inset = t.w >= 10 ? 1 : 0;
      K.section(g, t.x + inset, y + 1, t.z + inset, t.w - 2 * inset, t.d - 2 * inset, F2, 3, { wall, win: P.WIN, style: 'deco', spandrel: P.CONCRETE_DD });
      y += 1 + F2 * 3;
      // crowns: twin temples on wide towers, one centred otherwise
      const cw = t.w >= 12 ? 4 : Math.min(5, t.w - 2 * inset - 2);
      const xs = t.w >= 12 ? [t.x + inset + 1, t.x + t.w - inset - 1 - cw] : [t.x + ((t.w - cw) >> 1)];
      g.box(t.x + inset, y, t.z + inset, t.w - 2 * inset, 1, t.d - 2 * inset, P.CONCRETE_D);
      const cz = t.z + ((t.d - cw) >> 1);
      for (const x of xs) {
        g.box(x, y + 1, cz, cw, 5, cw, wall);
        g.box(x + 1, y + 1, cz, cw - 2, 4, cw, 0); g.box(x, y + 1, cz + 1, cw, 4, cw - 2, 0);
        g.box(x + 1, y + 1, cz + 1, cw - 2, 5, cw - 2, P.WIN);
        const top = K.roof(g, x, y + 6, cz, cw, cw, { type: 'pyramid', c: roofC, pitch: 1.5, oh: 0 });
        g.set(x + (cw >> 1), top, cz + (cw >> 1), P.GOLD);
        K.wallLight(g, x, y + 1, cz + cw, P.LAMP_WHITE, 0.8);
      }
      if (y > 75) K.beacon(g, xs[0] + (cw >> 1), y + 12, cz + (cw >> 1));
    },
  },
  {
    name: 'glass',
    build(c) {
      const g = c.g, F = towerFloors(c), m = c.W >= 16 ? 2 : 1;
      const t = towerRect(c, m, 13, 12);
      plaza(c, t, c.Wl === 2);
      const glass = c.pk(0, TOWER_WALL.glass);
      let y = lobby(c, t.x, 1, t.z, t.w, t.d, P.CONCRETE_DD);
      const Fs = Math.min(6, F >> 2), Fm = F - Fs;
      const k = t.w >= 10 ? 2 : 1;
      K.section(g, t.x, y, t.z, t.w, t.d, Fm, 3, { wall: glass, win: P.WIN_COOL, glass, style: 'curtain', shape: 'chamfer', k });
      y += Fm * 3;
      // slanted crown: each floor steps back from the front
      for (let f = 0; f < Fs; f++) {
        const d = t.d - f - 1;
        if (d < 3) break;
        K.section(g, t.x, y, t.z, t.w, d, 1, 3, { wall: glass, win: P.WIN_COOL, glass, style: 'curtain', shape: 'chamfer', k });
        const neon = c.pk(4, [P.NEON_CYAN, P.NEON_BLUE, P.NEON_PURPLE, P.LAMP_WHITE]);
        g.box(t.x + k, y + 2, t.z + d - 1, t.w - 2 * k, 1, 1, c.L >= 2 ? neon : P.LAMP_WHITE);
        y += 3;
      }
      g.light(t.x + t.w / 2, y, t.z + t.d / 2, [0.5, 0.9, 1], 1.5);
      if (y > 60) K.antenna(g, t.x + (t.w >> 1), y, t.z + 2, Math.min(18, 148 - y), true);
    },
  },
  {
    name: 'twin',
    build(c) {
      const g = c.g, F = towerFloors(c), wide = c.W >= 16;
      const wall = c.pk(0, TOWER_WALL.light), glass = c.pk(1, TOWER_WALL.glass);
      if (!wide) {
        const t = towerRect(c, 1, 6, 6);
        plaza(c, t, c.Wl === 2);
        let y = lobby(c, t.x, 1, t.z, t.w, t.d, wall);
        K.section(g, t.x, y, t.z, t.w, t.d, F, 3, { wall, win: glass, style: 'grid', trim: wall });
        y += F * 3;
        K.crownBand(g, t.x, y - 1, t.z, t.w, t.d, c.pk(4, [P.NEON_CYAN, P.NEON_PINK, P.LAMP_WHITE]));
        roofTop(c, t.x, y, t.z, t.w, t.d, { mast: F > 20 });
        return;
      }
      const m = 2, gap = 2;
      const tw = Math.min(8, (c.W - 2 * m - gap) >> 1), td = Math.min(10, c.D - 2 * m - 2);
      const tz = Math.max(1, ((c.D - td) >> 1) - 1);
      const x0 = (c.W - (2 * tw + gap)) >> 1, x1 = x0 + tw + gap;
      plaza(c, { x: x0, z: tz, w: 2 * tw + gap, d: td }, c.Wl === 2);
      const F2 = F - 2 - (c.ids[11] % 3);
      for (const [x, n] of [[x0, F], [x1, F2]]) {
        let y = lobby(c, x, 1, tz, tw, td, wall);
        K.section(g, x, y, tz, tw, td, n, 3, { wall, win: glass, style: 'grid', trim: wall });
        y += n * 3;
        K.crownBand(g, x, y - 1, tz, tw, td, c.pk(4, [P.NEON_CYAN, P.NEON_PINK, P.LAMP_WHITE]));
        roofTop(c, x, y, tz, tw, td, { noPool: true, mast: n === F && F > 20 });
      }
      // skybridge
      const by = 5 + Math.round(F2 * 0.6) * 3;
      g.box(x0 + tw, by, tz + (td >> 1) - 1, gap, 3, 3, P.GLASS_CYAN);
      g.box(x0 + tw, by - 1, tz + (td >> 1) - 1, gap, 1, 3, wall);
      g.box(x0 + tw, by + 3, tz + (td >> 1) - 1, gap, 1, 3, wall);
    },
  },
  {
    name: 'slab',
    build(c) {
      const g = c.g, F = Math.max(8, towerFloors(c) - 4);
      const t = towerRect(c, 1, 22, c.D >= 16 ? 8 : 6);
      plaza(c, t, false);
      const wall = c.pk(0, [[P.CONCRETE, P.CONCRETE_D], [P.CONCRETE_L, P.PLASTER, P.PLASTER_SKY], [P.WHITE, P.PLASTER_CREAM]]);
      let y = 1;
      // pilotis
      for (let x = t.x; x < t.x + t.w; x += 3) g.box(x, y, t.z, 1, 4, t.d, P.CONCRETE_D);
      g.box(t.x + 2, y, t.z + 1, Math.max(1, t.w - 4), 3, t.d - 2, P.GLASS_DARK);
      y += 4;
      const cols = [P.PLASTER_SKY, P.PLASTER_LEMON, P.PLASTER_PINK, P.PLASTER_MINT, P.WIN_COOL, P.ORANGE, P.RED, P.BLUE];
      K.section(g, t.x, y, t.z, t.w, t.d, F, 3, {
        wall, style: (o, u, v, f, len) => {
          const r = v % 3, fl = (v / 3) | 0;
          if (u <= 0 || u >= len - 1 || r === 0) return P.CONCRETE_D;
          if (f & 1) return r === 1 && u % 2 ? P.WIN : 0;
          const m4 = (u - 1) % 3;
          if (m4 === 2) return 0;
          return r === 2 ? P.WIN : cols[(M.hashU((u - 1) / 3 | 0, fl, c.v) >> 5) % (c.Wl ? cols.length : 4)];
        },
      });
      y += F * 3;
      g.box(t.x, y, t.z, t.w, 1, t.d, P.CONCRETE_DD);
      // rooftop sign letters
      if (c.L >= 2) {
        const neon = c.pk(4, [P.NEON_RED, P.NEON_BLUE, P.NEON_GREEN, P.NEON_YELLOW]);
        K.sign(g, t.x + 1, y + 2, t.z + t.d - 1, t.w - 2, 2, neon, 0, c.rng, 0, true);
        for (let x = t.x + 2; x < t.x + t.w - 2; x += 3) g.set(x, y + 1, t.z + t.d - 1, P.METAL_D);
      }
      for (let k = 0; k < 3; k++) g.box(t.x + 1 + k * 3, y + 1, t.z + 1, 1, 3, 1, P.METAL_D);
      if (y > 70) K.antenna(g, t.x + 1, y + 1, t.z + 1, Math.min(12, 148 - y), true);
    },
  },
];

VC.models.define('grow_R3', {
  variants: 10,
  gen(rng, v, p) {
    const c = lotCtx('grow_R3', rng, v, p, 160);
    const A = R3_ARCH[v % R3_ARCH.length];
    c.door = c.pk(3, R1PAL.door);
    A.build(c);
    if (c.bit(8)) mirrorX(c.g);
    return K.finish(c.g, 'R3_' + A.name);
  },
});

VC.models.define('grow_R2', {
  variants: 10,
  gen(rng, v, p) {
    const c = lotCtx('grow_R2', rng, v, p, 80);
    const A = R2_ARCH[v % R2_ARCH.length];
    c.door = c.pk(3, R1PAL.door);
    c.trim = P.WHITE;
    K.slab(c.g, P.SIDEWALK);
    A.build(c);
    if (c.bit(8)) mirrorX(c.g);
    return K.finish(c.g, 'R2_' + A.name);
  },
});
