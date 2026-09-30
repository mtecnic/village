/*
 * VOXELPOLIS — growable (zoned) building models, part 1: the shared toolkit VC.growKit
 * and the 'construction' site model.
 *
 * Files of this module (loaded alphabetically, this one first):
 *   grow.js    toolkit (facade painter, roofs, props, towers) + 'construction'
 *   grow_c.js  commercial   grow_C1 shops, grow_C2 offices & retail, grow_C3 skyscrapers
 *   grow_i.js  industrial   grow_I1 workshops & farms, grow_I2 factories, grow_I3 heavy / high-tech
 *   grow_r.js  residential  grow_R1 suburbs, grow_R2 townhouses & walk-ups, grow_R3 towers
 *
 * Every generator follows the model conventions of gfx/voxel.js: grid (fw*8) x H x (fd*8),
 * y = 0 is the tile top, the front / entrance faces +Z, params = { fw, fd, level 1..3, wealth 0..2 }.
 * House rules used throughout:
 *   - a 1-voxel lot slab at y = 0 (lawn / paving / gravel); structures start at y = 1
 *   - IDENTITY (archetype, colors) comes from K.idRng(key, variant) so a building keeps its look
 *     when it levels up; the registry rng only drives small level/wealth-specific details
 *   - big flat color regions + regular patterns (greedy-mesher friendly); grids are cropped
 *     to the used height (K.finish) so construction reveal & LOD use the true height
 *   - night: MAT.WINDOW colors light randomly, NEON/SIGN/BEACON always glow, LAMP at night;
 *     g.light() halos for lamps & signs, always-on blinking beacons on towers > ~80 voxels;
 *     g.emit() smoke / steam / fire / fountain at chimney tops etc.
 */
const P = VC.P, M = VC.M;

const K = (VC.growKit = {});
/** Face ids used by the facade painter: 0 front (+Z), 1 right (+X), 2 back (-Z), 3 left (-X). */
K.FRONT = 0; K.RIGHT = 1; K.BACK = 2; K.LEFT = 3;
/** Outward normal (dx, dz) per face. */
K.FN = [[0, 1], [1, 0], [0, -1], [-1, 0]];
/** Facade painter flag: OR into a returned color to recess that voxel one step into the wall. */
K.RECESS = 256;

/* ------------------------------------------------------------------ */
/* Grid basics                                                          */
/* ------------------------------------------------------------------ */
K.grid = (fw, fd, h) => new VC.VoxelGrid(fw * 8, h, fd * 8);

/** Deterministic identity rng for (key, variant): stable across level / wealth changes. */
K.idRng = (key, v, salt = 0) => M.rng((M.seedFromString(key + '/' + v) ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0);

/** Returns a copy of g cropped to its filled height (keeps emitters, lights, meta). */
K.crop = function (g) {
  const h = Math.max(1, g.maxHeight());
  if (h >= g.sy) return g;
  const o = new VC.VoxelGrid(g.sx, h, g.sz);
  o.v.set(g.v.subarray(0, g.sx * g.sz * h));
  o.emitters = g.emitters;
  o.lights = g.lights;
  o.meta = g.meta;
  return o;
};
/** Final step of every generator: stores the style tag and crops. */
K.finish = function (g, style, extra) {
  g.meta.style = style;
  if (extra) Object.assign(g.meta, extra);
  return K.crop(g);
};

/** Fills the lot slab (y = 0). */
K.slab = (g, c) => g.box(0, 0, 0, g.sx, 1, g.sz, c);

/**
 * A few mid-saturation facade paints missing from the named palette (the plaster pastels read
 * almost white in full sun). Created lazily on first use (6 custom palette slots in total).
 */
let paints = null;
K.paint = function () {
  if (!paints) {
    const c = (hex) => VC.voxel.color(hex, 0);
    paints = { BLUE: c('#6f8fc4'), SAGE: c('#86a97c'), MUSTARD: c('#d8a948'), ROSE: c('#d98594'), TEAL: c('#4f9d98'), PLUM: c('#8f6aa8') };
    paints.ALL = [paints.BLUE, paints.SAGE, paints.MUSTARD, paints.ROSE, paints.TEAL, paints.PLUM];
  }
  return paints;
};

/** Picks from a per-wealth list: lists = [poor[], mid[], rich[]]. */
K.pickW = (rng, lists, wealth) => rng.pick(lists[Math.max(0, Math.min(lists.length - 1, wealth | 0))]);

/* ------------------------------------------------------------------ */
/* Facade painting                                                      */
/* ------------------------------------------------------------------ */
function paint(g, x, y, z, c, f) {
  if (!c) return;
  if (c < 0) { g.set(x, y, z, 0); return; }
  if (!g.get(x, y, z)) return;
  if (c & K.RECESS) {
    const n = K.FN[f];
    g.set(x, y, z, 0);
    g.set(x - n[0], y, z - n[1], c & 255);
  } else g.set(x, y, z, c);
}
/**
 * Paints the four side faces of the box [x,x+w) x [y,y+h) x [z,z+d). Only existing voxels are
 * repainted. fn(u, v, face, len) -> palette index (0 = keep, -1 = carve, | K.RECESS = push in).
 * u runs left -> right as seen from outside the face (0..len-1), v = y offset (0..h-1).
 * faces: bitmask 1 front, 2 right, 4 back, 8 left.
 */
K.facade = function (g, x, y, z, w, h, d, fn, faces = 15) {
  for (let v = 0; v < h; v++) {
    const yy = y + v;
    if (faces & 1) for (let u = 0; u < w; u++) paint(g, x + u, yy, z + d - 1, fn(u, v, 0, w), 0);
    if (faces & 2) for (let u = 0; u < d; u++) paint(g, x + w - 1, yy, z + d - 1 - u, fn(u, v, 1, d), 1);
    if (faces & 4) for (let u = 0; u < w; u++) paint(g, x + w - 1 - u, yy, z, fn(u, v, 2, w), 2);
    if (faces & 8) for (let u = 0; u < d; u++) paint(g, x, yy, z + u, fn(u, v, 3, d), 3);
  }
};
/**
 * Paints every horizontally exposed voxel inside [x0,x1) x [y0,y1) x [z0,z1) (any shape: round or
 * chamfered towers). fn(x, y, z, face) -> color (0 keep). face = outward side (0..3) of the exposure.
 */
K.skin = function (g, x0, y0, z0, x1, y1, z1, fn) {
  for (let y = y0; y < y1; y++)
    for (let z = z0; z < z1; z++)
      for (let x = x0; x < x1; x++) {
        if (!g.get(x, y, z)) continue;
        let f = -1;
        if (!g.get(x, y, z + 1)) f = 0;
        else if (!g.get(x + 1, y, z)) f = 1;
        else if (!g.get(x, y, z - 1)) f = 2;
        else if (!g.get(x - 1, y, z)) f = 3;
        if (f < 0) continue;
        const c = fn(x, y, z, f);
        if (c) g.set(x, y, z, c);
      }
};
/** One-voxel ring (perimeter only) around [x,x+w) x [z,z+d) at height y..y+h-1. */
K.ring = (g, x, y, z, w, d, c, h = 1) => g.walls(x, y, z, w, h, d, c);
/** Cornice / slab that sticks out `o` voxels around the box footprint (clipped to the grid). */
K.cornice = (g, x, y, z, w, d, c, o = 1, h = 1) => g.box(x - o, y, z - o, w + 2 * o, h, d + 2 * o, c);

/* ------------------------------------------------------------------ */
/* Shapes                                                               */
/* ------------------------------------------------------------------ */
/**
 * Solid prism with a shaped footprint. shape: 'rect' | 'chamfer' (cut corners by k) | 'round'
 * (rounded corners radius k) | 'circle' | 'oct'. Returns nothing.
 */
K.prism = function (g, x, y, z, w, h, d, c, shape = 'rect', k = 1) {
  if (shape === 'rect') { g.box(x, y, z, w, h, d, c); return; }
  const cx = w / 2, cz = d / 2;
  for (let j = 0; j < d; j++)
    for (let i = 0; i < w; i++) {
      if (!K.inShape(i, j, w, d, shape, k, cx, cz)) continue;
      g.box(x + i, y, z + j, 1, h, 1, c);
    }
};
/** Footprint test used by prism (local cell i,j of a w x d box). */
K.inShape = function (i, j, w, d, shape, k, cx = w / 2, cz = d / 2) {
  const di = Math.min(i, w - 1 - i), dj = Math.min(j, d - 1 - j);
  if (shape === 'chamfer' || shape === 'oct') {
    const kk = shape === 'oct' ? Math.round(Math.min(w, d) * 0.3) : k;
    return di + dj >= kk;
  }
  if (shape === 'round') {
    if (di >= k || dj >= k) return true;
    const ax = k - di - 0.5, az = k - dj - 0.5;
    return ax * ax + az * az <= k * k;
  }
  if (shape === 'circle') {
    const ax = (i + 0.5 - cx) / cx, az = (j + 0.5 - cz) / cz;
    return ax * ax + az * az <= 1.02;
  }
  return true;
};

/* ------------------------------------------------------------------ */
/* Roofs                                                                */
/* ------------------------------------------------------------------ */
/**
 * Height-field roof over the wall rectangle [x,x+w) x [z,z+d), first roof layer at y.
 * o = { type, c (roof color), fill (gable wall color), oh (eave overhang, default 1),
 *       pitch (rise per step, 1 = 45deg), stripe (alt color for ribbed metal), ridge (ridge cap color),
 *       top (flat-top color for mansard), cap (max height) }
 * types: 'gable' (ridge along x — faces the street), 'gablez' (gable end faces the street),
 *        'hip', 'pyramid', 'shed' (rises toward the back), 'mansard', 'gambrel' (barn, ridge along x),
 *        'gambrelz', 'barrel' (vault along x), 'barrelz', 'saltbox'.
 * Returns the top y (exclusive) of the roof.
 */
K.roof = function (g, x, y, z, w, d, o) {
  const type = o.type || 'gable', oh = o.oh == null ? 1 : o.oh, pitch = o.pitch || 1;
  const c = o.c, fill = o.fill || c;
  const X0 = x - oh, Z0 = z - oh, WW = w + 2 * oh, DD = d + 2 * oh;
  const th = Math.max(1, Math.ceil(pitch));
  let top = y;
  const hOf = (k, span) => {
    // k = 1-based distance from the eave edge
    switch (type) {
      case 'gambrel': case 'gambrelz': {
        const a = Math.max(1, Math.round(span * 0.18));
        return k <= a ? k * 2 : a * 2 + Math.ceil((k - a) * 0.6);
      }
      case 'barrel': case 'barrelz': {
        const r = span / 2, t = r - (k - 0.5);
        return Math.max(1, Math.round(Math.sqrt(Math.max(0, r * r - t * t)) * (o.pitch || 0.8)));
      }
      case 'mansard': return Math.min(Math.ceil(k * pitch), o.cap || 4);
      default: return Math.ceil(k * pitch);
    }
  };
  for (let j = 0; j < DD; j++)
    for (let i = 0; i < WW; i++) {
      const di = Math.min(i, WW - 1 - i) + 1, dj = Math.min(j, DD - 1 - j) + 1;
      let h;
      switch (type) {
        case 'gable': case 'gambrel': case 'barrel': h = hOf(dj, DD); break;
        case 'gablez': case 'gambrelz': case 'barrelz': h = hOf(di, WW); break;
        case 'shed': h = Math.ceil((DD - j) * pitch * 0.5); break;
        case 'saltbox': h = j < DD * 0.4 ? hOf(Math.min(dj, Math.ceil(DD * 0.4)), DD) : hOf(Math.ceil((DD - j) * 0.7), DD); break;
        default: h = hOf(Math.min(di, dj), Math.min(WW, DD));
      }
      if (o.cap) h = Math.min(h, o.cap);
      const xx = X0 + i, zz = Z0 + j;
      const inside = i >= oh && i < WW - oh && j >= oh && j < DD - oh;
      const t = type === 'mansard' && h >= (o.cap || 4) ? 1 : th;
      const y0 = inside ? y : y + h - t;
      for (let yy = Math.max(y, y0); yy < y + h; yy++) {
        let col = yy >= y + h - t ? c : fill;
        if (col === c && o.stripe && ((type === 'gable' || type === 'gambrel' || type === 'barrel' || type === 'shed') ? i : j) % 2) col = o.stripe;
        if (type === 'mansard' && o.top && h >= (o.cap || 4) && yy === y + h - 1) col = o.top;
        g.set(xx, yy, zz, col);
      }
      if (o.ridge && h > 1) {
        const peak = type === 'gable' ? dj >= Math.floor((DD + 1) / 2) : type === 'gablez' ? di >= Math.floor((WW + 1) / 2) : false;
        if (peak) g.set(xx, y + h - 1, zz, o.ridge);
      }
      if (y + h > top) top = y + h;
    }
  return top;
};

/** Flat roof slab + parapet (h voxels) of color pc. Returns the y above the roof surface. */
K.flatRoof = function (g, x, y, z, w, d, c, pc, ph = 1) {
  g.box(x, y, z, w, 1, d, c);
  if (pc && ph > 0) g.walls(x, y + 1, z, w, ph, d, pc);
  return y + 1;
};

/** Small gable dormer on a roof slope facing the street (+Z): window at the front. */
K.dormer = function (g, x, y, z, c, roofC, win = P.WIN) {
  g.box(x, y, z, 3, 2, 2, c);
  g.set(x + 1, y, z + 1, win);
  g.box(x, y + 2, z, 3, 1, 2, roofC);
  g.box(x + 1, y + 3, z, 1, 1, 2, roofC);
};

/* ------------------------------------------------------------------ */
/* Vegetation                                                           */
/* ------------------------------------------------------------------ */
const LEAVES = [P.LEAF, P.LEAF_D, P.LEAF_L];
/**
 * Small voxel tree with its trunk at voxel (x, z), standing on y.
 * s = size 1..4; kind: 'oak' | 'round' | 'pine' | 'birch' | 'palm' | 'cypress' | 'fruit' | 'bush'.
 */
K.tree = function (g, x, y, z, s = 2, kind = 'oak', leaf) {
  const cx = x + 0.5, cz = z + 0.5;
  switch (kind) {
    case 'pine': {
      g.box(x, y, z, 1, 1 + (s > 2 ? 1 : 0), 1, P.TRUNK);
      let yy = y + 1, r = 0.9 + s * 0.55;
      const c = leaf || (s & 1 ? P.PINE : P.PINE_D);
      while (r > 0.5) { g.cyl(cx, yy, cz, r, 2, c); yy += 2; r -= 0.7; }
      g.set(x, yy, z, c);
      break;
    }
    case 'cypress':
      g.set(x, y, z, P.TRUNK);
      g.ellipsoid(cx, y + 2 + s, cz, 1.05, 1.6 + s, 1.05, leaf || P.PINE_D);
      break;
    case 'birch':
      g.box(x, y, z, 1, 2 + s, 1, P.TRUNK_BIRCH);
      g.ellipsoid(cx, y + 2.5 + s, cz, 0.9 + s * 0.35, 1.2 + s * 0.45, 0.9 + s * 0.35, leaf || P.BIRCH_LEAF);
      break;
    case 'palm': {
      const h = 3 + s;
      g.box(x, y, z, 1, h, 1, P.TRUNK);
      const c = leaf || P.PALM, r = 1 + Math.ceil(s / 2);
      g.set(x, y + h, z, c);
      for (let k = 1; k <= r; k++) {
        const yy = y + h - (k === r ? 1 : 0);
        g.set(x + k, yy, z, c); g.set(x - k, yy, z, c); g.set(x, yy, z + k, c); g.set(x, yy, z - k, c);
      }
      break;
    }
    case 'bush':
      g.ellipsoid(cx, y + 0.4, cz, 0.8 + s * 0.35, 0.7 + s * 0.3, 0.8 + s * 0.35, leaf || P.HEDGE);
      break;
    case 'fruit': {
      g.box(x, y, z, 1, 2, 1, P.TRUNK);
      const r = 1.1 + s * 0.4;
      g.sphere(cx, y + 2 + r * 0.7, cz, r, leaf || P.LEAF);
      g.set(x + 1, y + 3, z, P.FLOWER_R);
      g.set(x - 1, y + 2 + Math.round(r), z, P.FLOWER_R);
      break;
    }
    default: {
      // oak / round
      const th = kind === 'round' ? 1 + (s > 2 ? 1 : 0) : 1 + Math.ceil(s / 2);
      g.box(x, y, z, 1, th, 1, P.TRUNK);
      const r = 0.9 + s * 0.5;
      g.sphere(cx, y + th + r * 0.8, cz, r, leaf || P.LEAF);
    }
  }
};
/** Random leaf color from the foliage set. */
K.leaf = (rng) => rng.pick(LEAVES);
const FLOWERS = [P.FLOWER_R, P.FLOWER_Y, P.FLOWER_P, P.FLOWER_V, P.FLOWER_W];
/** Flower bed: soil in the slab + flowers on top in a regular 2-color pattern. */
K.flowers = function (g, x, z, w, d, rng, y = 0) {
  const a = rng.pick(FLOWERS), b = rng.pick(FLOWERS);
  for (let j = 0; j < d; j++)
    for (let i = 0; i < w; i++) {
      g.set(x + i, y, z + j, P.SOIL);
      if ((i + j) % 2 === 0) g.set(x + i, y + 1, z + j, (i >> 1) % 2 ? a : b);
      else g.set(x + i, y + 1, z + j, P.LEAF_D);
    }
};
/** Planter box with a bush (plazas, roofs). */
K.planter = function (g, x, y, z, w, d, c = P.CONCRETE_L, leaf = P.HEDGE) {
  g.box(x, y, z, w, 1, d, c);
  g.box(x, y + 1, z, w, 1, d, leaf);
};
/** Roof garden: grass mat with shrubs and paths over [x,x+w) x [z,z+d) at height y. */
K.roofGarden = function (g, x, y, z, w, d, rng) {
  g.box(x, y, z, w, 1, d, P.GRASS);
  for (let j = 1; j < d - 1; j += 3)
    for (let i = 1; i < w - 1; i += 3) {
      const r = rng();
      if (r < 0.35) K.tree(g, x + i, y + 1, z + j, 1, rng.pick(['bush', 'round']), K.leaf(rng));
      else if (r < 0.55) g.set(x + i, y + 1, z + j, rng.pick(FLOWERS));
    }
};

/* ------------------------------------------------------------------ */
/* Lot props                                                            */
/* ------------------------------------------------------------------ */
const CARS = [P.CAR_RED, P.CAR_BLUE, P.CAR_WHITE, P.CAR_BLACK, P.CAR_SILVER, P.CAR_YELLOW, P.CAR_GREEN];
K.carColor = (rng) => rng.pick(CARS);
/** Tiny parked car (2 x 3 voxels). axis 'z' = long side along z. */
K.car = function (g, x, y, z, axis, c) {
  if (axis === 'z') {
    g.box(x, y, z, 2, 1, 3, c);
    g.box(x, y + 1, z + 1, 2, 1, 1, P.GLASS_DARK);
  } else {
    g.box(x, y, z, 3, 1, 2, c);
    g.box(x + 1, y + 1, z, 1, 1, 2, P.GLASS_DARK);
  }
};
/** Delivery truck / semi (2 wide, len 4..7). The cab is at the + end of the axis. */
K.truck = function (g, x, y, z, axis, cab, box, len = 5) {
  const L = len;
  if (axis === 'z') {
    g.box(x, y, z, 2, 2, L - 1, box);
    g.box(x, y, z + L - 1, 2, 2, 1, cab);
    g.box(x, y + 1, z + L - 1, 2, 1, 1, P.GLASS_DARK);
    g.box(x, y, z, 2, 1, L, P.TIRE);
    g.box(x, y, z + L - 1, 2, 1, 1, cab);
  } else {
    g.box(x, y, z, L - 1, 2, 2, box);
    g.box(x + L - 1, y, z, 1, 2, 2, cab);
    g.box(x + L - 1, y + 1, z, 1, 1, 2, P.GLASS_DARK);
    g.box(x, y, z, L, 1, 2, P.TIRE);
    g.box(x + L - 1, y, z, 1, 1, 2, cab);
  }
};
/** Parking lot stripes on the slab of [x,x+w) x [z,z+d): bays along x, cars randomly. */
K.parking = function (g, x, z, w, d, rng, fill = 0.6, y = 0) {
  g.box(x, y, z, w, 1, d, P.ASPHALT);
  // bays of 3 voxels along x; rows of depth 3 facing each other across an aisle
  for (let row = 0; row + 3 <= d; row += (row % 8 === 0 ? 5 : 3)) {
    for (let i = 0; i + 2 <= w; i += 3) {
      g.set(x + i + 2, y, z + row, P.ROAD_MARK);
      if (rng.chance(fill)) K.car(g, x + i, y + 1, z + row, 'z', K.carColor(rng));
    }
  }
};
/**
 * Fence along the straight line (x0,z0)-(x1,z1) (inclusive) on top of height y.
 * kind: 'picket' | 'hedge' | 'hedge2' | 'chain' | 'wall' | 'rail' | 'iron'
 * skip(x,z) -> true leaves a gap (gates, paths).
 */
K.fence = function (g, x0, z0, x1, z1, y, kind, skip) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
  const sx = Math.sign(x1 - x0), sz = Math.sign(z1 - z0);
  for (let k = 0; k <= n; k++) {
    const x = x0 + sx * k, z = z0 + sz * k;
    if (skip && skip(x, z)) continue;
    switch (kind) {
      case 'picket': g.set(x, y, z, P.WHITE); break;
      case 'rail': g.set(x, y, z, P.WOOD_L); break;
      case 'hedge': g.set(x, y, z, P.HEDGE); break;
      case 'hedge2': g.box(x, y, z, 1, 2, 1, P.HEDGE); break;
      case 'wall': g.set(x, y, z, k % 3 ? P.STONE : P.STONE_D); break;
      case 'iron': g.set(x, y, z, P.BLACK); if (k % 2 === 0) g.set(x, y + 1, z, P.BLACK); break;
      case 'chain': g.set(x, y + 1, z, P.GREY); if (k % 3 === 0 || k === n) g.set(x, y, z, P.METAL_D); break;
    }
  }
};
/** Rectangle fence around [x,x+w) x [z,z+d). */
K.fenceRect = function (g, x, z, w, d, y, kind, skip) {
  K.fence(g, x, z, x + w - 1, z, y, kind, skip);
  K.fence(g, x, z + d - 1, x + w - 1, z + d - 1, y, kind, skip);
  K.fence(g, x, z, x, z + d - 1, y, kind, skip);
  K.fence(g, x + w - 1, z, x + w - 1, z + d - 1, y, kind, skip);
};
/** Swimming pool sunk into the slab with a deck ring. Adds loungers when there is room. */
K.pool = function (g, x, z, w, d, deck = P.WHITE, y = 0, rng = null) {
  g.box(x - 1, y, z - 1, w + 2, 1, d + 2, deck);
  g.box(x, y, z, w, 1, d, P.WATER_POOL);
  if (y > 0) g.box(x, y - 1, z, w, 1, d, P.WATER_POOL);
  if (rng && rng.chance(0.6)) g.set(x - 1, y + 1, z + d, P.CHROME); // ladder
};
/** Street-style lamp post: pole h voxels, LAMP head, night glow sprite. */
K.lamp = function (g, x, y, z, h = 3, head = P.LAMP, pole = P.METAL_D, size = 0.7) {
  g.box(x, y, z, 1, h - 1, 1, pole);
  g.set(x, y + h - 1, z, head);
  g.light(x + 0.5, y + h - 0.2, z + 0.5, head === P.LAMP_WHITE ? [0.85, 0.92, 1] : [1, 0.8, 0.5], size);
};
/** Wall-mounted light (voxel + glow). */
K.wallLight = function (g, x, y, z, c = P.LAMP, size = 0.45) {
  g.set(x, y, z, c);
  g.light(x + 0.5, y + 0.5, z + 0.5, c === P.LAMP_WHITE ? [0.85, 0.92, 1] : [1, 0.78, 0.45], size);
};
/** Patio umbrella with a small table. */
K.umbrella = function (g, x, y, z, c, c2 = P.WHITE) {
  g.box(x, y, z, 1, 2, 1, P.WHITE);
  g.box(x - 1, y + 2, z - 1, 3, 1, 3, c);
  g.set(x, y + 2, z, c2);
};
/** Trash bins. */
K.bins = function (g, x, y, z) {
  g.set(x, y, z, P.GREEN);
  g.set(x + 1, y, z, P.GREY);
};

/* ------------------------------------------------------------------ */
/* Rooftop & facade equipment                                          */
/* ------------------------------------------------------------------ */
/** Air-conditioning unit (2 x 1 x 1, grill side facing +Z or +X). */
K.ac = function (g, x, y, z, axis = 'x') {
  if (axis === 'x') { g.box(x, y, z, 2, 1, 1, P.METAL); g.set(x + 1, y, z, P.CONCRETE_DD); }
  else { g.box(x, y, z, 1, 1, 2, P.METAL); g.set(x, y, z + 1, P.CONCRETE_DD); }
};
/** Wall AC box hanging on a facade voxel position (single voxel). */
K.wallAc = (g, x, y, z) => g.set(x, y, z, P.METAL);
/** NYC-style wooden water tank on legs, needs a 4 x 4 area; (x,z) = corner. */
K.waterTank = function (g, x, y, z, c = P.WOOD_D) {
  g.set(x, y, z, P.METAL_D); g.set(x + 3, y, z, P.METAL_D); g.set(x, y, z + 3, P.METAL_D); g.set(x + 3, y, z + 3, P.METAL_D);
  g.box(x, y + 1, z, 4, 1, 4, P.METAL_D);
  g.cyl(x + 2, y + 2, z + 2, 2.05, 4, c);
  g.cyl(x + 2, y + 3, z + 2, 2.05, 1, P.METAL_D);
  g.cyl(x + 2, y + 6, z + 2, 1.5, 1, P.ROOF_BROWN);
  g.box(x + 1, y + 7, z + 1, 2, 1, 2, P.ROOF_BROWN);
};
/** Rooftop HVAC block with fans. */
K.hvac = function (g, x, y, z, w, d, c = P.METAL) {
  g.box(x, y, z, w, 2, d, c);
  for (let j = 0; j + 1 < d; j += 2) for (let i = 0; i + 1 < w; i += 2) g.set(x + i + 1, y + 2, z + j + 1, P.CONCRETE_DD);
  g.box(x, y, z, w, 1, d, P.METAL_D);
};
/** Beacon voxel + always-on blinking red glow. */
K.beacon = function (g, x, y, z, size = 1.2) {
  g.set(x, y, z, P.BEACON_RED);
  g.light(x + 0.5, y + 0.5, z + 0.5, [1, 0.12, 0.08], size, true);
};
/** Antenna mast of height h with a beacon on top (red/white banded when striped). */
K.antenna = function (g, x, y, z, h, beacon = true, striped = false) {
  for (let k = 0; k < h - 1; k++) g.set(x, y + k, z, striped && ((k / 3) | 0) % 2 ? P.RED : striped ? P.WHITE : P.METAL_D);
  if (beacon) K.beacon(g, x, y + h - 1, z);
  else g.set(x, y + h - 1, z, P.METAL);
};
/** Helipad deck with H marking and edge lights. s = side (>= 5). */
K.helipad = function (g, x, y, z, s) {
  g.box(x, y, z, s, 1, s, P.CONCRETE_DD);
  const m = (s / 2) | 0;
  if (s >= 5) {
    for (let k = 1; k < s - 1; k++) { g.set(x + 1, y, z + k, P.WHITE); g.set(x + s - 2, y, z + k, P.WHITE); }
    for (let k = 1; k < s - 1; k++) g.set(x + k, y, z + m, P.WHITE);
    g.box(x + 1, y, z + 1, 1, 1, 1, P.WHITE);
  }
  for (const [a, b] of [[0, 0], [s - 1, 0], [0, s - 1], [s - 1, s - 1]]) {
    g.set(x + a, y + 1, z + b, P.LAMP_WHITE);
  }
  g.light(x + s / 2, y + 1.2, z + s / 2, [0.7, 1, 0.8], 1.0);
};
/** Rows of tilted solar panels over [x,x+w) x [z,z+d) at y. */
K.solar = function (g, x, y, z, w, d) {
  for (let j = 0; j + 1 < d; j += 3) {
    g.box(x, y, z + j, w, 1, 1, P.SOLAR);
    g.box(x, y + 1, z + j + 1, w, 1, 1, P.SOLAR);
    g.set(x, y, z + j + 1, P.METAL_D);
    g.set(x + w - 1, y, z + j + 1, P.METAL_D);
  }
};
/** Chimney column with a cap; optional particle emitter. Returns top y. */
K.chimney = function (g, x, y, z, h, c = P.BRICK_D, emit = null, rate = 1) {
  g.box(x, y, z, 1, h, 1, c);
  g.set(x, y + h, z, P.CONCRETE_DD);
  if (emit) g.emit(x + 0.5, y + h + 1, z + 0.5, emit, rate);
  return y + h + 1;
};
/** Round industrial smoke stack (radius r) with optional stripes and an emitter at the top. */
K.stack = function (g, cx, y, cz, r, h, c = P.CHIMNEY, stripe = 0, emit = 'smoke', rate = 1) {
  g.cyl(cx, y, cz, r, h, c);
  if (stripe) for (let k = h - 3; k > h * 0.5; k -= 6) g.cyl(cx, y + k, cz, r, 2, stripe);
  g.cyl(cx, y + h, cz, r + 0.35, 1, P.CONCRETE_DD);
  if (r >= 1.4) g.cyl(cx, y + h, cz, r - 0.8, 1, 0);
  if (emit) g.emit(cx, y + h + 1, cz, emit, rate);
  if (y + h > 70) K.beacon(g, Math.floor(cx), y + h + 1, Math.floor(cz), 0.9);
  return y + h + 1;
};
/** Vertical storage tank (cylinder with a dome cap and a ladder stripe). */
K.tank = function (g, cx, y, cz, r, h, c = P.TANK_WHITE, band = 0) {
  g.cyl(cx, y, cz, r, h, c);
  if (band) g.cyl(cx, y + Math.floor(h * 0.6), cz, r, 1, band);
  g.ellipsoid(cx, y + h, cz, r - 0.1, Math.max(1, r * 0.35), r - 0.1, c);
  g.box(Math.floor(cx + r) - 1, y, Math.floor(cz), 1, h, 1, P.METAL_D);
};
/** Horizontal pipe run: axis 'x' | 'z', from a0 for len voxels at height y and cross coordinate cc. */
K.pipe = function (g, axis, a0, len, y, cc, c = P.PIPE) {
  for (let a = a0; a < a0 + len; a++) axis === 'x' ? g.set(a, y, cc, c) : g.set(cc, y, a, c);
};
const CONTAINERS = [P.CONTAINER_R, P.CONTAINER_B, P.CONTAINER_G, P.CONTAINER_O];
K.containerColor = (rng) => rng.pick(CONTAINERS);
/** Shipping container 2 x 2 x 5 (axis = long side). */
K.container = function (g, x, y, z, axis, c) {
  if (axis === 'x') { g.box(x, y, z, 5, 2, 2, c); g.box(x + 4, y, z, 1, 2, 2, P.METAL_D); }
  else { g.box(x, y, z, 2, 2, 5, c); g.box(x, y, z + 4, 2, 2, 1, P.METAL_D); }
};
/** Pallet stack / crates. */
K.crates = function (g, x, y, z, w, d, h, c = P.WOOD_L) {
  g.box(x, y, z, w, h, d, c);
  g.box(x, y, z, w, 1, d, P.WOOD_D);
};
/** Log pile along axis (horizontal cylinders). */
K.logs = function (g, x, y, z, len, axis = 'x', rows = 2) {
  for (let r = 0; r < rows; r++)
    for (let k = 0; k < rows - r; k++) {
      const cy = y + r + 0.5, cc = (axis === 'x' ? z : x) + k + r * 0.5 + 0.5;
      g.hcyl(axis, axis === 'x' ? x : z, len, cy, cc, 0.55, P.TRUNK);
      if (axis === 'x') g.set(x + len - 1, Math.floor(cy), Math.floor(cc), P.WOOD_L);
      else g.set(Math.floor(cc), Math.floor(cy), z + len - 1, P.WOOD_L);
    }
};
/** Striped awning sloping down toward +Z over [x,x+w), attached at (y, z), depth dz. */
K.awning = function (g, x, y, z, w, dz, c1, c2 = P.WHITE) {
  for (let k = 0; k < dz; k++) for (let i = 0; i < w; i++) g.set(x + i, y - (k >> 1), z + k, i % 2 ? c2 : c1);
};
/** Side awning along z (for right facades): slopes down toward +X. */
K.awningX = function (g, x, y, z, d, dx, c1, c2 = P.WHITE) {
  for (let k = 0; k < dx; k++) for (let j = 0; j < d; j++) g.set(x + k, y - (k >> 1), z + j, j % 2 ? c2 : c1);
};
/**
 * Emissive sign panel on a front facade: w x h voxels at plane z (protruding voxels), with a
 * pseudo-lettering pattern (lit / unlit columns) generated from rng.
 * face: 0 front (spans x), 1 right (spans z, plane x).
 */
K.sign = function (g, x, y, z, w, h, c, bg, rng, face = 0, lightIt = true) {
  for (let i = 0; i < w; i++) {
    const glyph = rng ? rng.int(1, 7) : 7;
    for (let j = 0; j < h; j++) {
      const lit = h === 1 ? (i % 2 === 0 || !bg) : (glyph >> (j % 3)) & 1 || i === 0;
      const col = lit ? c : bg;
      if (!col) continue;
      if (face === 0) g.set(x + i, y + j, z, col);
      else g.set(x, y + j, z + i, col);
    }
  }
  if (lightIt) {
    const rgb = K.glowRGB(c);
    if (face === 0) g.light(x + w / 2, y + h / 2, z + 1, rgb, 0.4 + w * 0.12);
    else g.light(x + 1, y + h / 2, z + w / 2, rgb, 0.4 + w * 0.12);
  }
};
/** Approximate glow color for a palette index (for g.light halos). */
K.glowRGB = function (c) {
  const pal = VC.voxel.palette;
  return [pal[c * 4] / 255, pal[c * 4 + 1] / 255, pal[c * 4 + 2] / 255];
};
const NEONS = [P.NEON_PINK, P.NEON_CYAN, P.NEON_YELLOW, P.NEON_GREEN, P.NEON_RED, P.NEON_BLUE, P.NEON_ORANGE, P.NEON_PURPLE];
K.neon = (rng) => rng.pick(NEONS);
/**
 * Billboard on posts: panel w x h facing +Z (face 0) or +X (face 1), bottom-left at (x, y, z).
 * The advert is always-emissive (glows at night).
 */
K.billboard = function (g, x, y, z, w, h, rng, face = 0, posts = 2) {
  const bg = rng.pick([P.SIGN_WHITE, P.NEON_BLUE, P.NEON_PINK, P.NEON_YELLOW, P.NEON_CYAN]);
  let fg = K.neon(rng);
  if (fg === bg) fg = P.NEON_ORANGE;
  const fg2 = bg === P.SIGN_WHITE ? P.NEON_RED : P.SIGN_WHITE;
  const circ = rng.chance(0.5), cx = rng.int(1, Math.max(1, w - 3));
  const at = (i, j) => {
    if (i === 0 || j === 0 || i === w - 1 || j === h - 1) return P.METAL_D;
    if (circ && Math.abs(i - cx - 1) + Math.abs(j - h / 2 + 0.5) < h * 0.35) return fg;
    if (!circ && j === (h >> 1) && i > 1 && i < w - 2) return fg;
    if (j === 1 && i > w * 0.45 && i < w - 2 && i % 2) return fg2;
    return bg;
  };
  for (let i = 0; i < w; i++)
    for (let j = 0; j < h; j++) {
      if (face === 0) g.set(x + i, y + j, z, at(i, j));
      else g.set(x, y + j, z + w - 1 - i, at(i, j));
    }
  // posts & back
  for (let p = 0; p < posts; p++) {
    const i = posts === 1 ? w >> 1 : p === 0 ? 1 : w - 2;
    for (let yy = y - 1; yy >= 0 && yy >= y - 60; yy--) {
      const px = face === 0 ? x + i : x, pz = face === 0 ? z - 1 : z + w - 1 - i;
      const qx = face === 0 ? px : px - 1, qz = face === 0 ? pz : pz;
      if (g.get(qx, yy, qz)) break;
      g.set(qx, yy, qz, P.METAL_D);
    }
  }
  const rgb = K.glowRGB(bg);
  if (face === 0) g.light(x + w / 2, y + h / 2, z + 1.5, rgb, 0.5 + w * 0.1);
  else g.light(x + 1.5, y + h / 2, z + w / 2, rgb, 0.5 + w * 0.1);
};

/* ------------------------------------------------------------------ */
/* Towers: sections with facade styles, balcony rings, crowns          */
/* ------------------------------------------------------------------ */
/**
 * Facade styles for K.section. Signature: (o, u, v, f, len, fh) -> color | 0 where u = index along
 * the face, v = height inside the section, f = face, len = face length, fh = floor height.
 * o carries colors: wall, win, trim, spandrel, glass.
 */
K.STYLES = {
  /** Punched windows every other column (rows 1..2 of a floor), wall corners. */
  punched(o, u, v, f, len, fh) {
    const r = v % fh;
    if (u <= 0 || u >= len - 1 || (u - 1) % 2) return 0;
    return r >= 1 && r <= (fh >= 4 ? 2 : fh - 1) ? o.win : 0;
  },
  /** Paired windows (2 wide) with 1-wide piers. */
  paired(o, u, v, f, len, fh) {
    const r = v % fh;
    return u > 0 && u < len - 1 && u % 3 !== 0 && r >= 1 ? o.win : 0;
  },
  /** Continuous ribbon windows, spandrel row per floor, corner piers. */
  ribbon(o, u, v, f, len, fh) {
    if (u === 0 || u === len - 1) return o.trim || 0;
    return v % fh >= 1 ? o.win : o.spandrel || 0;
  },
  /** Full curtain wall: glass spandrels + window rows (lit at night), thin mullions every 4. */
  curtain(o, u, v, f, len, fh) {
    const r = v % fh;
    if (o.mullion && u % 4 === 0) return o.mullion;
    return r === 0 ? o.glass : o.win;
  },
  /** Grid of mullions (trim) around 1-wide glazing. */
  grid(o, u, v, f, len, fh) {
    const r = v % fh;
    if (u % 2 === 0 || r === 0) return o.trim || 0;
    return o.win;
  },
  /** Art-deco: stone piers every 3, dark recessed spandrels, tall windows. */
  deco(o, u, v, f, len, fh) {
    const r = v % fh;
    if (u % 3 === 0) return 0;
    return r === 0 ? o.spandrel || P.CONCRETE_DD : o.win;
  },
  /** Brick / panel: punched windows with lintel trim above. */
  lintel(o, u, v, f, len, fh) {
    const r = v % fh;
    if (u <= 0 || u >= len - 1 || (u - 1) % 2) return 0;
    if (r >= 1 && r <= fh - 2) return o.win;
    return r === fh - 1 && o.trim ? o.trim : 0;
  },
  /** Loggias: recessed window strips 3 wide separated by piers (panel blocks). */
  loggia(o, u, v, f, len, fh) {
    const r = v % fh;
    if (u <= 0 || u >= len - 1) return 0;
    const m = u % 4;
    if (m === 0) return 0;
    return r >= 1 ? (m === 2 ? o.win : o.glass || o.win) | (o.recess ? K.RECESS : 0) : o.spandrel || 0;
  },
};
/**
 * Tower section: prism of `floors` floors (fh voxels each) over the footprint (x, z, w, d) with
 * o = { wall, win, trim, spandrel, glass, mullion, style, shape, k, faces }. Returns the top y.
 */
K.section = function (g, x, y, z, w, d, floors, fh, o) {
  const h = floors * fh;
  if (h <= 0) return y;
  K.prism(g, x, y, z, w, h, d, o.wall, o.shape || 'rect', o.k || 1);
  const style = typeof o.style === 'function' ? o.style : K.STYLES[o.style || 'punched'];
  if (!o.shape || o.shape === 'rect') {
    K.facade(g, x, y, z, w, h, d, (u, v, f, len) => style(o, u, v, f, len, fh), o.faces || 15);
  } else {
    K.skin(g, x, y, z, x + w, y + h, z + d, (xx, yy, zz, f) => {
      const len = f & 1 ? d : w, u = f & 1 ? zz - z : xx - x;
      return style(o, u, yy - y, f, len, fh);
    });
  }
  return y + h;
};
/** Perimeter ring of a shaped footprint (cells inside shape(w,d) but not inside the 1-inset shape). */
K.shapeRing = function (g, x, y, z, w, d, shape, k, c) {
  for (let j = 0; j < d; j++)
    for (let i = 0; i < w; i++) {
      if (!K.inShape(i, j, w, d, shape, k)) continue;
      const inner = i > 0 && j > 0 && i < w - 1 && j < d - 1 && K.inShape(i - 1, j - 1, w - 2, d - 2, shape, Math.max(0, k - 1));
      if (!inner) g.set(x + i, y, z + j, c);
    }
};
/**
 * Balcony ring: slab protruding 1 voxel around the footprint at y, railing on top.
 * faces: bitmask of sides for rect footprints (1 front, 2 right, 4 back, 8 left); ignored for shapes.
 */
K.balconies = function (g, x, y, z, w, d, slab, rail, shape = 'rect', k = 1, faces = 15) {
  if (shape === 'rect') {
    const x0 = faces & 8 ? x - 1 : x, x1 = faces & 2 ? x + w + 1 : x + w;
    const z0 = faces & 4 ? z - 1 : z, z1 = faces & 1 ? z + d + 1 : z + d;
    g.box(x0, y, z0, x1 - x0, 1, z1 - z0, slab);
    if (rail) {
      if (faces & 1) g.box(x0, y + 1, z + d, x1 - x0, 1, 1, rail);
      if (faces & 4) g.box(x0, y + 1, z - 1, x1 - x0, 1, 1, rail);
      if (faces & 2) g.box(x + w, y + 1, z0, 1, 1, z1 - z0, rail);
      if (faces & 8) g.box(x - 1, y + 1, z0, 1, 1, z1 - z0, rail);
    }
  } else {
    K.prism(g, x - 1, y, z - 1, w + 2, 1, d + 2, slab, shape, k + 1);
    if (rail) K.shapeRing(g, x - 1, y + 1, z - 1, w + 2, d + 2, shape, k + 1, rail);
  }
};
/** Rooftop pool with deck on a flat roof (deck covers the given rect). */
K.roofPool = function (g, x, y, z, w, d, deck = P.WHITE) {
  g.box(x, y, z, w, 1, d, deck);
  g.box(x + 1, y, z + 1, w - 2, 1, d - 2, P.WATER_POOL);
  if (w >= 5) { g.set(x, y + 1, z + 1, P.WHITE); g.set(x, y + 1, z + 2, P.WHITE); }
  K.ring(g, x, y + 1, z, w, d, P.GLASS_CYAN);
  g.box(x + 1, y + 1, z, w - 2, 1, 1, 0);
};
/** Mechanical penthouse with vents; returns top y. */
K.penthouse = function (g, x, y, z, w, h, d, c = P.CONCRETE_D) {
  g.box(x, y, z, w, h, d, c);
  for (let i = 1; i < w - 1; i += 2) g.set(x + i, y + h - 2, z + d - 1, P.METAL_D);
  g.box(x, y + h, z, w, 1, d, P.CONCRETE_DD);
  return y + h + 1;
};
/** Corner fins rising h voxels above y at the 4 corners of the rect. */
K.fins = function (g, x, y, z, w, d, h, c) {
  for (const [a, b] of [[x, z], [x + w - 1, z], [x, z + d - 1], [x + w - 1, z + d - 1]]) g.box(a, y, b, 1, h, 1, c);
};
/** Emissive crown band (ring) around the footprint rect / shape at y (always glowing). */
K.crownBand = function (g, x, y, z, w, d, c, shape = 'rect', k = 1) {
  if (shape === 'rect') g.walls(x, y, z, w, 1, d, c);
  else K.shapeRing(g, x, y, z, w, d, shape, k, c);
  g.light(x + w / 2, y + 1, z + d / 2, K.glowRGB(c), Math.max(1, w * 0.18), false);
};
/** Tapering spire (stepped pyramid) + antenna with a beacon. Returns top y. */
K.spire = function (g, cx, y, cz, r, c, mast = 10) {
  let yy = y;
  for (let rr = r; rr >= 0.5; rr -= 0.5, yy += 2) g.cyl(cx, yy, cz, rr, 2, c);
  K.antenna(g, Math.floor(cx), yy, Math.floor(cz), mast, true);
  return yy + mast;
};

/* ------------------------------------------------------------------ */
/* Lot context (shared by every generator)                             */
/* ------------------------------------------------------------------ */
/**
 * c = { g, rng, id, ids[], W, D, fw, fd, L (level), Wl (wealth), occ (lot occupancy) }.
 * ids[] are pre-drawn identity numbers (stable per variant, independent of level/wealth).
 */
function lotCtx(key, rng, v, p, H) {
  const fw = Math.max(1, p.fw | 0 || 1), fd = Math.max(1, p.fd | 0 || 1);
  const id = K.idRng(key, v);
  const c = {
    key, rng, v, id, fw, fd, W: fw * 8, D: fd * 8,
    L: M.clamp(p.level | 0 || 1, 1, 3), Wl: M.clamp(p.wealth | 0, 0, 2),
    g: new VC.VoxelGrid(fw * 8, H, fd * 8),
    ids: [],
  };
  for (let i = 0; i < 16; i++) c.ids.push(id.int(0, 1 << 20));
  c.occ = new Uint8Array(c.W * c.D);
  /** Identity pick #k from a list, or from lists[wealth] when given per-wealth lists. */
  c.pk = (k, lists) => {
    const list = Array.isArray(lists[0]) ? lists[c.Wl] : lists;
    return list[c.ids[k] % list.length];
  };
  c.bit = (k, n = 2) => c.ids[k] % n;
  return c;
}
const OCC = { FREE: 0, HOUSE: 1, PATH: 2, DRIVE: 3, POOL: 4, GARDEN: 5 };
function mark(c, x, z, w, d, code) {
  for (let j = z; j < z + d; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < c.W && j < c.D) c.occ[j * c.W + i] = code;
}
function isFree(c, x, z, w, d) {
  if (x < 0 || z < 0 || x + w > c.W || z + d > c.D) return false;
  for (let j = z; j < z + d; j++) for (let i = x; i < x + w; i++) if (c.occ[j * c.W + i]) return false;
  return true;
}
/** First free w x d rectangle; scan order: back rows first (z ascending) unless front. */
function findFree(c, w, d, zMax = c.D, front = false) {
  if (front) {
    for (let z = c.D - d; z >= 0; z--) for (let x = 0; x + w <= c.W; x++) if (isFree(c, x, z, w, d)) return { x, z };
  } else {
    for (let z = 0; z + d <= zMax; z++) for (let x = c.W - w; x >= 0; x--) if (isFree(c, x, z, w, d)) return { x, z };
  }
  return null;
}
/** Mirrors the grid (and lights / emitters) across x. */
function mirrorX(g) {
  const sx = g.sx;
  for (let y = 0; y < g.sy; y++)
    for (let z = 0; z < g.sz; z++) {
      const o = sx * (z + g.sz * y);
      for (let x = 0; x < sx >> 1; x++) {
        const a = g.v[o + x];
        g.v[o + x] = g.v[o + sx - 1 - x];
        g.v[o + sx - 1 - x] = a;
      }
    }
  for (const e of g.emitters) e.x = sx - e.x;
  for (const l of g.lights) l.x = sx - l.x;
}
K.mirrorX = mirrorX;

/** Window slots along a facade of length len: symmetric pattern, corners stay wall. */
const winSlot = (u, len) => u > 0 && u < len - 1 && Math.min(u - 1, len - 2 - u) % 2 === 0;
K.winSlot = winSlot;

/**
 * House block with windows and a door: box [x,x+w) x [y,y+floors*fh) x [z,z+d).
 * o: { wall, upper (upper floors color), trim, win, door, fh (4), doorU (front u, -1 = none),
 *      corners, band, lintel, recess, sills (flower boxes), lamp, hood, faces (window faces mask),
 *      winRows [r0, r1] rows of a floor holding windows }
 * Returns the y above the walls.
 */
function walls(c, x, y, z, w, d, floors, o = {}) {
  const g = c.g, fh = o.fh || 4, H = floors * fh;
  const wall = o.wall || c.wall, trim = o.trim || c.trim, win = o.win || P.WIN, door = o.door || c.door;
  g.box(x, y, z, w, H, d, wall);
  if (o.upper && floors > 1) g.box(x, y + fh, z, w, H - fh, d, o.upper);
  const doorU = o.doorU == null ? w >> 1 : o.doorU;
  const rec = o.recess ? K.RECESS : 0;
  const r0 = o.winRows ? o.winRows[0] : 1, r1 = o.winRows ? o.winRows[1] : Math.min(2, fh - 2);
  const faces = o.faces == null ? 15 : o.faces;
  K.facade(g, x, y, z, w, H, d, (u, v, f, len) => {
    const fl = (v / fh) | 0, r = v % fh;
    if (f === 0 && fl === 0 && doorU >= 0 && u === doorU) return r < 2 ? door | K.RECESS : 0;
    if (o.corners && (u === 0 || u === len - 1)) return trim;
    if (o.band && r === fh - 1 && fl < floors - 1) return trim;
    if (!((faces >> f) & 1)) return 0;
    if (winSlot(u, len) && r >= r0 && r <= r1) {
      if (f === 0 && fl === 0 && Math.abs(u - doorU) < 1) return 0;
      return win | rec;
    }
    if (o.lintel && winSlot(u, len) && r === r1 + 1 && !(f === 0 && fl === 0 && u === doorU)) return trim;
    return 0;
  });
  const fz = z + d; // plane in front of the facade
  if (doorU >= 0) {
    if (o.hood) g.box(x + doorU - 1, y + 2, fz, 3, 1, 1, o.hood);
    if (o.lamp) K.wallLight(g, x + doorU + 1, y + 1, fz, P.LAMP, 0.4);
  }
  if (o.sills) {
    for (let fl = 0; fl < floors; fl++)
      for (let u = 1; u < w - 1; u++) {
        if (!winSlot(u, w) || (fl === 0 && Math.abs(u - doorU) < 1)) continue;
        const yy = y + fl * fh + r0 - 1;
        g.set(x + u, yy, fz, fl === 0 ? P.HEDGE : o.sills);
        if (fl > 0) g.set(x + u, yy + 1, fz, c.rng.pick([P.FLOWER_R, P.FLOWER_P, P.FLOWER_Y]));
      }
  }
  return y + H;
}
K.walls = walls;

/** Centered window slots with spacing s along a face of length len (corners excluded). */
function slots(len, s) {
  const n = Math.max(1, Math.floor((len - 3) / s) + 1);
  const start = 1 + Math.floor((len - 2 - ((n - 1) * s + 1)) / 2);
  const a = new Uint8Array(len + 1);
  for (let k = 0; k < n; k++) { const u = start + k * s; if (u > 0 && u < len - 1) a[u] = 1; }
  return a;
}
K.slots = slots;

/* ================================================================== */
/* R3 — residential towers (3 voxels per floor)                        */
/* ================================================================== */
/** Tower floor count for level/lot; the whole model stays <= ~150 voxels. */
function towerFloors(c, extra = 0) {
  let F = [0, 11, 20, 32][c.L] + (c.ids[9] % 5) - 2;
  if (Math.max(c.W, c.D) <= 8) F = Math.round(F * 0.75);
  if (Math.min(c.W, c.D) >= 24) F += 3;
  return M.clamp(F, 6, 40 - extra);
}
K.towerFloors = towerFloors;
/** Centered tower rect inside the lot with margin m (clamped to max w/d). */
function towerRect(c, m, maxW = 99, maxD = 99) {
  const w = Math.max(3, Math.min(c.W - 2 * m, maxW)), d = Math.max(3, Math.min(c.D - 2 * m, maxD));
  return { x: (c.W - w) >> 1, z: Math.max(Math.min(m, c.D - d), ((c.D - d) >> 1) - (c.D >= 16 ? 1 : 0)), w, d };
}
K.towerRect = towerRect;
/** Plaza slab + planters, trees and lamps in the free ring around a footprint. */
function plaza(c, t, rich) {
  const g = c.g, W = c.W, D = c.D;
  g.box(0, 0, 0, W, 1, D, rich ? P.MARBLE : c.Wl ? P.SIDEWALK : P.CONCRETE);
  if (W < 16 && D < 16) {
    if (c.Wl) { g.set(0, 1, D - 1, P.HEDGE); g.set(W - 1, 1, D - 1, P.HEDGE); }
    return;
  }
  const fz = t.z + t.d; // front edge of the tower
  if (D - fz >= 3) {
    for (const x of [1, W - 2]) {
      if (c.Wl) K.tree(g, x, 1, D - 2, 2, 'round', K.leaf(c.rng));
      else g.box(x, 1, D - 2, 1, 1, 1, P.CONCRETE_L);
    }
    K.lamp(g, (W >> 1) - 3, 1, D - 1, 4, P.LAMP_WHITE, P.METAL_D, 0.7);
    K.lamp(g, (W >> 1) + 2, 1, D - 1, 4, P.LAMP_WHITE, P.METAL_D, 0.7);
    if (rich && W >= 16) { g.cyl(W / 2, 1, D - 1.5 - Math.max(0, (D - fz - 3) >> 1), 1.6, 1, P.MARBLE); g.set(W >> 1, 1, D - 2 - Math.max(0, (D - fz - 3) >> 1), P.WATER_POOL); g.emit(W / 2, 2, D - 1.5 - Math.max(0, (D - fz - 3) >> 1), 'fountain', 0.5); }
  }
  // side lawns
  if (t.x >= 2) { g.box(0, 0, 1, t.x - 1, 1, D - 3, c.Wl ? P.GRASS : P.GRASS_D); if (t.x >= 3) K.tree(g, 0 + ((t.x - 1) >> 1), 1, t.z + 1, 1, c.pk(6, ['birch', 'round', 'pine']), undefined); }
  if (W - t.x - t.w >= 2) { g.box(t.x + t.w + 1, 0, 1, W - t.x - t.w - 1, 1, D - 3, c.Wl ? P.GRASS : P.GRASS_D); }
}
K.plaza = plaza;
/** Glass lobby floor (h voxels) with canopy over the entrance on the front face. */
function lobby(c, x, y, z, w, d, wall, h = 4) {
  const g = c.g;
  g.box(x, y, z, w, h, d, wall);
  K.facade(g, x, y, z, w, h, d, (u, v, f, len) => (u > 0 && u < len - 1 && v < h - 1 ? (f === 0 && Math.abs(u - (len >> 1)) < 1 && v < 2 ? P.WIN_SHOP : P.GLASS_DARK) : 0));
  const m = x + (w >> 1);
  if (z + d < c.D) {
    g.box(m - 2, y + h - 1, z + d, 5, 1, 1, P.CONCRETE_DD);
    K.wallLight(g, m - 2, y + h - 2, z + d, P.LAMP_WHITE, 0.5);
    K.wallLight(g, m + 2, y + h - 2, z + d, P.LAMP_WHITE, 0.5);
  }
  return y + h;
}
K.lobby = lobby;
/** Roof program by wealth: pool / garden / mechanical, plus antenna + beacon on tall towers. */
function roofTop(c, x, y, z, w, d, opts = {}) {
  const g = c.g;
  g.box(x, y, z, w, 1, d, P.CONCRETE_D);
  let top = y + 1;
  if (c.Wl === 2 && w >= 5 && d >= 5 && !opts.noPool) {
    K.roofPool(g, x + 1, y + 1, z + 1, Math.min(w - 2, 8), Math.min(d - 2, 6), P.WHITE);
    if (w >= 8) K.umbrella(g, x + w - 3, y + 2, z + d - 3, P.AWNING_B);
  } else if (c.Wl === 1 && w >= 5 && d >= 5) {
    K.roofGarden(g, x + 1, y + 1, z + 1, w - 2, d - 2, c.rng);
  } else if (w >= 4 && d >= 4) {
    top = K.penthouse(g, x + 1, y + 1, z + 1, Math.min(4, w - 2), 3, Math.min(4, d - 2));
    K.hvac(g, x + w - 3, y + 1, z + d - 3, 2, 2);
  }
  if (y > 70 || opts.mast) {
    const mh = opts.mastH || Math.max(6, Math.min(18, 150 - y - 3));
    K.antenna(g, x + (w >> 1), y + 1, z + (d >> 1), mh, true, opts.striped);
    top = y + 1 + mh;
  }
  return top;
}
K.roofTop = roofTop;
const TOWER_WALL = {
  light: [[P.CONCRETE, P.CONCRETE_L, P.STONE], [P.WHITE, P.CONCRETE_L, P.PLASTER, P.PLASTER_CREAM], [P.WHITE, P.MARBLE, P.PLASTER_CREAM]],
  glass: [[P.GLASS_DARK, P.GLASS_BLUE], [P.GLASS_BLUE, P.GLASS_TEAL, P.GLASS_DARK], [P.GLASS_TEAL, P.GLASS_BLUE, P.GLASS_GOLD, P.GLASS_CYAN]],
  stone: [[P.CONCRETE, P.STONE_D, P.BRICK_D], [P.SANDSTONE, P.BRICK_Y, P.STONE, P.BRICK_L], [P.SANDSTONE, P.MARBLE, P.BRICK_Y]],
};

K.TOWER_WALL = TOWER_WALL;
K.lotCtx = lotCtx;
K.OCC = OCC;
K.mark = mark;
K.isFree = isFree;
K.findFree = findFree;

/* ------------------------------------------------------------------ */
/* Construction site ('construction', sized)                          */
/* ------------------------------------------------------------------ */
/** Lattice mast (2 x 2 column) in color c from y for h voxels. */
function lattice(g, x, y, z, h, c) {
  for (let k = 0; k < h; k++) {
    g.set(x, y + k, z, c); g.set(x + 1, y + k, z + 1, c);
    if (k % 2 === 0) { g.set(x + 1, y + k, z, c); g.set(x, y + k, z + 1, c); }
  }
}
/** Tower crane: mast at (x,z), jib along +X or -X over the lot, cab & counterweight. */
K.crane = function (g, x, y, z, h, jib, dir = 1, c = P.YELLOW, load = true) {
  lattice(g, x, y, z, h, c);
  const ty = y + h;
  g.box(x - 1, ty, z - 1, 4, 1, 4, c); // slewing platform
  g.box(x, ty + 1, z, 2, 2, 2, P.WHITE); // cab
  g.set(dir > 0 ? x + 1 : x, ty + 1, z + 1, P.GLASS_CYAN);
  // jib + counter-jib
  for (let k = -Math.ceil(jib * 0.35); k <= jib; k++) {
    const xx = dir > 0 ? x + 1 + k : x - k;
    g.set(xx, ty + 3, z, c);
    g.set(xx, ty + 3, z + 1, k % 2 ? c : 0);
  }
  const cwX = dir > 0 ? x + 1 - Math.ceil(jib * 0.35) : x + Math.ceil(jib * 0.35) - 1;
  g.box(Math.min(cwX, cwX + dir), ty + 1, z, 2, 2, 2, P.CONCRETE_DD); // counterweight
  lattice(g, x, ty + 3, z, 3, c); // A-frame top
  K.beacon(g, x, ty + 6, z, 0.8);
  // hook & load
  const hx = dir > 0 ? x + 1 + Math.round(jib * 0.7) : x - Math.round(jib * 0.7);
  if (load) {
    const hy = ty + 2 - Math.max(3, Math.round(h * 0.45));
    for (let yy = hy + 1; yy < ty + 3; yy++) g.set(hx, yy, z, P.BLACK);
    g.box(hx - 1, hy - 1, z - 1, 3, 1, 3, P.WOOD_L);
    g.box(hx - 1, hy - 1, z, 3, 1, 1, P.BRICK);
  }
  return ty + 7;
};
/** Scaffold frame around the box [x,x+w) x [z,z+d) from y to y+h (1 voxel outside). */
K.scaffold = function (g, x, y, z, w, h, d, c = P.ORANGE) {
  for (let yy = y; yy < y + h; yy++) {
    const deck = (yy - y) % 3 === 2;
    for (let i = -1; i <= w; i++) {
      const post = i === -1 || i === w || i % 3 === 0;
      if (deck || post) { g.set(x + i, yy, z - 1, deck ? P.WOOD_L : c); g.set(x + i, yy, z + d, deck ? P.WOOD_L : c); }
    }
    for (let j = 0; j < d; j++) {
      const post = j % 3 === 0;
      if (deck || post) { g.set(x - 1, yy, z + j, deck ? P.WOOD_L : c); g.set(x + w, yy, z + j, deck ? P.WOOD_L : c); }
    }
  }
};
VC.models.define('construction', {
  variants: 2,
  sized: true,
  gen(rng, v, p) {
    const fw = Math.max(1, p.fw || 1), fd = Math.max(1, p.fd || 1);
    const W = fw * 8, D = fd * 8, big = Math.max(fw, fd);
    const g = new VC.VoxelGrid(W, 30 + big * 16, D);
    // dirt lot with gravel patches
    K.slab(g, P.SOIL);
    for (let k = 0; k < fw * fd * 3; k++) g.box(rng.int(1, W - 3), 0, rng.int(1, D - 3), 2, 1, 2, rng.pick([P.SAND, P.STONE]));
    // hoarding fence: panels with a hazard band, gate at the front
    const gate = (x, z) => z === D - 1 && x >= (W >> 1) - 1 && x <= (W >> 1);
    K.fenceRect(g, 0, 0, W, D, 1, 'rail', gate);
    for (let x = 0; x < W; x++) for (const z of [0, D - 1]) if (!gate(x, z)) g.set(x, 2, z, x % 2 ? P.HAZARD_Y : P.HAZARD_B);
    for (let z = 0; z < D; z++) for (const x of [0, W - 1]) g.set(x, 2, z, z % 2 ? P.HAZARD_Y : P.HAZARD_B);
    // building core rising out of the pit
    const bx = 2, bz = 2, bw = W - 4 - (big > 1 ? 2 : 0), bd = D - 5;
    const floors = v === 0 ? 1 + big : 2 + big * 2;
    const fh = 3, core = floors * fh;
    for (let f = 0; f < floors; f++) {
      const y = 1 + f * fh;
      g.box(bx, y + fh - 1, bz, bw, 1, bd, P.CONCRETE); // slab
      for (let i = 0; i < bw; i += 3) for (let j = 0; j < bd; j += Math.max(1, bd - 1)) g.box(bx + i, y, bz + j, 1, fh - 1, 1, P.CONCRETE_D);
      g.box(bx + bw - 1, y, bz + bd - 1, 1, fh - 1, 1, P.CONCRETE_D);
    }
    // stair / elevator core and rebar on top
    g.box(bx + 1, 1, bz + 1, 2, core + 2, 2, P.CONCRETE_L);
    for (let i = 0; i < bw; i += 2) g.set(bx + i, core + 1, bz, P.RUST);
    if (v === 1 || big > 1) K.scaffold(g, bx, 1, bz, bw, core, bd);
    // material piles in the front yard
    const fy = D - 2;
    K.crates(g, 1, 1, fy - 1, 2, 1, 1, P.WOOD_L);
    g.box(W - 4, 1, fy - 1, 2, 1, 1, P.BRICK);
    g.set(W - 4, 2, fy - 1, P.BRICK);
    g.hcyl('x', 1, 3, 1.5, fy + 0.5, 0.5, P.PIPE);
    if (W >= 16) {
      g.ellipsoid(W - 6, 1, D - 4, 2.2, 1.6, 1.6, P.SAND);
      g.box(3, 1, D - 4, 1, 2, 1, P.BLUE); // portable toilet
    }
    // tower crane (variant 0 or big sites) — beside the core, jib over the lot
    if (v === 0 || big >= 2) {
      const h = core + 8 + big * 6;
      const cx = W - 3, cz = 1;
      const top = K.crane(g, cx, 1, cz, h, W - 5, -1);
      g.meta.top = top;
    } else {
      // small mobile crane / excavator in the yard
      g.box(W - 4, 1, 1, 3, 1, 3, P.YELLOW);
      g.box(W - 4, 2, 2, 2, 2, 2, P.YELLOW);
      g.set(W - 3, 3, 3, P.GLASS_DARK);
      g.line(W - 3, 4, 2, W - 6, 8, 2, P.YELLOW);
      g.line(W - 6, 8, 2, W - 6, 5, 2, P.BLACK);
    }
    // work lights
    K.lamp(g, 1, 1, 1, 4, P.LAMP_WHITE, P.METAL_D, 0.8);
    return K.finish(g, 'construction');
  },
});
