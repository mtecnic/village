/*
 * VOXELPOLIS — NATURE: shared authoring kit (VC.natureKit) and every tree species.
 *
 * Files of this module (loaded alphabetically, this one first):
 *   nature.js           kit + trees: tree_oak, tree_maple, tree_birch, tree_pine, tree_cypress,
 *                       tree_palm, tree_cherry, tree_bush
 *   nature_props.js     streetlamp, traffic_light, pylon, bench, bus_stop, hydrant, billboard,
 *                       rubble (sized), crater (sized)
 *   nature_special.js   plane, helicopter (+ parts), boat / ferry / cargo_ship, ufo, rocket (fallback),
 *                       monster (CUBEZILLA walk cycle), meteor, bird, balloon
 *   nature_vehicles.js  car, taxi, bus, truck, tanker, police_car, firetruck, ambulance, garbage_truck
 *
 * TREES: 8 x H x 8 grids (one tile), 4 (bush) to 22 voxels tall, trunk on the tile centre, canopies
 * built from clustered blobs in 2-3 FOLIAGE shades (lower lobes darker, crown lighter) so they read
 * as irregular foliage but still mesh to <= 250 quads. Nothing leaves the 8x8 footprint. 5-6 variants
 * each. Maples use their own MAPLE colours and cherries BLOSSOM pinks; palms, pines and cypresses
 * only evergreen shades (PALM, HEDGE, PINE*), so the season table below leaves them green.
 * WINTER: deciduous crowns (oak, maple, birch, cherry) hide a SKELETON — the leader, limbs and twigs drawn
 * only through voxels buried inside the canopy (the summer look is unchanged). Their definitions carry
 * `openFoliage: true`, so the registry also builds model.winter meshes in which the wood faces touching leaves
 * exist (VC.voxel.mesh open set); when the renderer drops the leaves in late autumn it draws those, and the bare
 * tree keeps a real branch structure (the summer meshes stay as lean as before). The winter LOD mesh is built
 * from the wood alone (VC.voxel.winterLodMesh: trunk, leader and limbs survive the half-resolution downsample,
 * the 2x2 trunk stays 2 voxels wide) and also stands in for the 1/4-res tier while crowns are bare, so keep
 * trunks on voxels 3..4 and skeletons connected. Bush flowers and
 * fallen cherry petals use FOLIAGE-flagged colours (BLOOM_*), so they follow the seasons like leaves.
 *
 * Non-building models (props, vehicles, creatures) are centred on their grid: the renderer's origin
 * is the bottom centre (sx/2, 0, sz/2); the front faces +Z. See the per-file headers for meta fields.
 * Thin models carry `lodMinFill: 1` in their definition: a hint that the LOD downsample should keep
 * any block with >= 1 voxel (poles, stems and rotor blades otherwise vanish at LOD). Thin street furniture
 * (streetlamp, traffic_light, hydrant) is `lod: false` instead: no downsampled LOD at all (see nature_props.js).
 *
 * VC.natureKit (usable by any module after load):
 *   seasonPalette()          { autumn, winter: Float32Array(256*3) sRGB, mask: Uint8Array(256) }
 *                            per-palette-index foliage recolouring (maples red, birches gold, ...)
 *   treeFor(hash, level, terr)  species key for a tile (beach palms, alpine pines, meadow maples...)
 *   TREES                    every tree key
 *   toWorld(model, p, x, y, z, angle, out?)  model-local voxel point -> world (meta points)
 *   signalVariant(phase, rot)   traffic_light variant for a VC.agents.signal() phase (props file)
 *   col(name)                custom palette entries: BLOSSOM, BLOSSOM_L, MAPLE, MAPLE_L, NAV_GREEN, KAIJU_D,
 *                            IRON (street furniture), BLOOM_R/Y/P/W/V (seasonal bush flowers and petals)
 *   text(g, str, x, y, z, c, face)  3x5 pixel font; fit, under, blobIn, mirrorX, beam, disc, ring,
 *                            exposed, sprinkle: grid helpers
 */
const P = VC.P, MAT = VC.MAT;
const K = (VC.natureKit = {});

/* ------------------------------------------------------------------ */
/* Custom palette entries (created lazily, shared by all nature files)  */
/* ------------------------------------------------------------------ */
const CUSTOM = {
  BLOSSOM: ['#f29cc2', MAT.FOLIAGE],
  BLOSSOM_L: ['#fbcfe0', MAT.FOLIAGE],
  MAPLE: ['#4f9e36', MAT.FOLIAGE], // own indices so the season table can turn maples vivid red
  MAPLE_L: ['#79bf42', MAT.FOLIAGE],
  NAV_GREEN: ['#3cff6e', MAT.NIGHTLIGHT | MAT.NOSNOW],
  KAIJU_D: ['#27502d', 0],
  IRON: ['#3c434b', MAT.METAL], // painted cast iron (lamp posts): dark, but not a black hole on asphalt
  // flowers that belong to a plant: FOLIAGE, so they sway, turn with autumn and drop in winter
  BLOOM_R: ['#e83a4a', MAT.FOLIAGE],
  BLOOM_Y: ['#f8d83a', MAT.FOLIAGE],
  BLOOM_P: ['#e87ab8', MAT.FOLIAGE],
  BLOOM_W: ['#f4f4f4', MAT.FOLIAGE],
  BLOOM_V: ['#9a5ad8', MAT.FOLIAGE],
};
const customIdx = {};
/** Palette index of a named custom nature color (BLOSSOM, BLOSSOM_L, MAPLE, MAPLE_L, NAV_GREEN, KAIJU_D). */
K.col = (name) => customIdx[name] || (customIdx[name] = VC.voxel.color(CUSTOM[name][0], CUSTOM[name][1]));

/* ------------------------------------------------------------------ */
/* Seasonal foliage hints (for renderers)                                */
/* ------------------------------------------------------------------ */
/**
 * Per-palette-index foliage recolouring for autumn and winter, so each species turns its own
 * colour: maples vivid red, birches gold, oaks orange/russet, cherries orange-red, evergreens
 * (pine, palm, cypress) unchanged. Returns { autumn, winter: Float32Array(256*3) sRGB 0..1,
 * mask: Uint8Array(256) (bit 1 autumn entry, bit 2 winter entry) } — cheap to upload as a 256x2
 * texture and blend by the Frame UBO season. Rebuilt when the palette grows (call again).
 */
K.seasonPalette = () => {
  const autumn = new Float32Array(256 * 3), winter = new Float32Array(256 * 3), mask = new Uint8Array(256);
  const put = (arr, bit, idx, hex) => {
    if (!idx) return;
    const c = VC.color.rgb(hex);
    arr[idx * 3] = c[0];
    arr[idx * 3 + 1] = c[1];
    arr[idx * 3 + 2] = c[2];
    mask[idx] |= bit;
  };
  const A = [
    [P.LEAF, '#c8702a'], [P.LEAF_D, '#9a4a22'], [P.LEAF_L, '#e0a030'], [P.LEAF_Y, '#f0c640'],
    [P.BIRCH_LEAF, '#f2cc3a'], [K.col('MAPLE'), '#d42a1c'], [K.col('MAPLE_L'), '#f0502a'],
    [K.col('BLOSSOM'), '#d8683a'], [K.col('BLOSSOM_L'), '#e8904a'],
  ];
  // winter: bare twig browns (the renderer's snow cover whitens the tops)
  const Wn = [
    [P.LEAF, '#6e5e4e'], [P.LEAF_D, '#5e5044'], [P.LEAF_L, '#7a6a58'], [P.LEAF_Y, '#827260'],
    [P.BIRCH_LEAF, '#8a7e70'], [K.col('MAPLE'), '#6a5646'], [K.col('MAPLE_L'), '#7a6452'],
    [K.col('BLOSSOM'), '#6e5a58'], [K.col('BLOSSOM_L'), '#7e6a66'],
  ];
  for (const [i, h] of A) put(autumn, 1, i, h);
  for (const [i, h] of Wn) put(winter, 2, i, h);
  return { autumn, winter, mask };
};

/* ------------------------------------------------------------------ */
/* Species picker (for tree renderers / world generation)               */
/* ------------------------------------------------------------------ */
const T_BANDS = {
  beach: [['tree_palm', 7], ['tree_bush', 2], ['tree_cypress', 1]],
  lowland: [['tree_oak', 5], ['tree_maple', 3], ['tree_birch', 2], ['tree_bush', 3], ['tree_cypress', 1], ['tree_cherry', 1]],
  meadow: [['tree_maple', 4], ['tree_oak', 3], ['tree_cherry', 2], ['tree_bush', 3], ['tree_birch', 1]],
  upland: [['tree_pine', 4], ['tree_birch', 3], ['tree_oak', 2], ['tree_maple', 1], ['tree_bush', 1]],
  alpine: [['tree_pine', 8], ['tree_birch', 1], ['tree_cypress', 1]],
};
/** Every tree model key this module defines. */
K.TREES = ['tree_oak', 'tree_maple', 'tree_birch', 'tree_pine', 'tree_cypress', 'tree_palm', 'tree_cherry', 'tree_bush'];
/**
 * Picks a species for a tile: h = any uint32 hash of the tile/tree, level = terrain level,
 * terr = VC.TERR code. Beaches get palms, mountains pines, meadows maples and cherries.
 */
K.treeFor = (h, level, terr) => {
  const T = VC.TERR, C = VC.C;
  const band = terr === T.SAND || level <= C.SEA ? 'beach' : terr === T.SNOW || terr === T.ROCK || level > 26 ? 'alpine' : level > 17 ? 'upland' : terr === T.MEADOW ? 'meadow' : 'lowland';
  const list = T_BANDS[band];
  let tot = 0;
  for (const e of list) tot += e[1];
  let r = (h >>> 0) % tot;
  for (const e of list) if ((r -= e[1]) < 0) return e[0];
  return list[0][0];
};

/* ------------------------------------------------------------------ */
/* Grid helpers                                                         */
/* ------------------------------------------------------------------ */
/** Trims the grid height to its content (the renderer uses sy for construction/picking). */
K.fit = (g) => {
  const h = Math.max(1, g.maxHeight());
  if (h >= g.sy) return g;
  const o = new VC.VoxelGrid(g.sx, h, g.sz);
  o.v.set(g.v.subarray(0, g.sx * g.sz * h));
  o.emitters = g.emitters;
  o.lights = g.lights;
  o.meta = g.meta;
  return o;
};

/** Ellipsoid that only fills EMPTY voxels (keeps what is already there). */
K.under = (g, cx, cy, cz, rx, ry, rz, c) => g.ellipsoid(cx, cy, cz, rx, ry, rz, (x, y, z) => g.get(x, y, z) || c);

/** Ellipsoid clamped so it never pokes outside [0,sx) x [0,sz) (keeps round silhouettes, no flat cuts). */
K.blobIn = (g, cx, cy, cz, rx, ry, rz, c, keep) => {
  cx = VC.M.clamp(cx, rx, g.sx - rx);
  cz = VC.M.clamp(cz, rz, g.sz - rz);
  return keep ? K.under(g, cx, cy, cz, rx, ry, rz, c) : g.ellipsoid(cx, cy, cz, rx, ry, rz, c);
};

/** Mirrors a grid along X in place; emitters, lights and meta points follow. */
K.mirrorX = (g) => {
  const sx = g.sx, v = g.v;
  for (let y = 0; y < g.sy; y++)
    for (let z = 0; z < g.sz; z++) {
      const o = sx * (z + g.sz * y);
      for (let x = 0; x < sx >> 1; x++) {
        const a = o + x, b = o + sx - 1 - x, t = v[a];
        v[a] = v[b];
        v[b] = t;
      }
    }
  for (const e of g.emitters) e.x = sx - e.x;
  for (const l of g.lights) l.x = sx - l.x;
  return g;
};

/** Thick 3D line (cube brush t x t x t). */
K.beam = (g, x0, y0, z0, x1, y1, z1, c, t = 1) => {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), 1);
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    g.box(Math.round(x0 + (x1 - x0) * f), Math.round(y0 + (y1 - y0) * f), Math.round(z0 + (z1 - z0) * f), t, t, t, c);
  }
  return g;
};

/**
 * World position of a model-local voxel point p = [x,y,z] (e.g. meta.wire / meta.head) for an
 * instance whose bottom centre (sx/2, 0, sz/2) sits at world (x, y, z), rotated `angle` radians
 * about Y with the renderer convention x' = x*c + z*s, z' = -x*s + z*c (quarter turn q: q*PI/2).
 * model = VC.models.get(...) result (or any {sx, sz, vox}). Writes into `out` when given.
 */
K.toWorld = (model, p, x, y, z, angle = 0, out = [0, 0, 0]) => {
  const vox = model.vox || VC.C.VOX;
  const px = (p[0] - model.sx / 2) * vox, pz = (p[2] - model.sz / 2) * vox;
  const c = Math.cos(angle), s = Math.sin(angle);
  out[0] = x + px * c + pz * s;
  out[1] = y + p[1] * vox;
  out[2] = z - px * s + pz * c;
  return out;
};

/** Disc of radius r (voxel-centre test) at height y, h voxels thick. c may be fn(x,y,z). */
K.disc = (g, cx, y, cz, r, c, h = 1) => g.cyl(cx, y, cz, r, h, c);

/** Annulus r0 < d <= r1 around (cx, cz) from y to y+h (voxel-centre test). */
K.ring = (g, cx, y, cz, r0, r1, h, c) => {
  const a2 = r0 * r0, b2 = r1 * r1;
  for (let z = Math.floor(cz - r1); z <= Math.ceil(cz + r1); z++)
    for (let x = Math.floor(cx - r1); x <= Math.ceil(cx + r1); x++) {
      const dx = x + 0.5 - cx, dz = z + 0.5 - cz, d2 = dx * dx + dz * dz;
      if (d2 > a2 && d2 <= b2) g.box(x, y, z, 1, h, 1, c);
    }
  return g;
};

/** Voxel at (x,y,z) has at least one empty 6-neighbour (i.e. it is visible). */
K.exposed = (g, x, y, z) => !g.get(x + 1, y, z) || !g.get(x - 1, y, z) || !g.get(x, y + 1, z) || !g.get(x, y - 1, z) || !g.get(x, y, z + 1) || !g.get(x, y, z - 1);

/**
 * Sprinkles n accent voxels onto the visible surface of voxels matching `on` (Set of palette
 * indices): picks random columns / sides and recolours the outermost matching voxel.
 */
K.sprinkle = (g, rng, n, on, color, minY = 0) => {
  let placed = 0;
  for (let tries = 0; tries < n * 12 && placed < n; tries++) {
    const x = rng.int(0, g.sx - 1), z = rng.int(0, g.sz - 1);
    let y = g.heightAt(x, z) - 1;
    if (rng.chance(0.45)) {
      // side hit: walk inward from a random side at a random height
      y = rng.int(minY, g.sy - 1);
      const dir = rng.int(0, 3), dx = [1, -1, 0, 0][dir], dz = [0, 0, 1, -1][dir];
      let px = dx > 0 ? 0 : dx < 0 ? g.sx - 1 : x, pz = dz > 0 ? 0 : dz < 0 ? g.sz - 1 : z;
      while (px >= 0 && pz >= 0 && px < g.sx && pz < g.sz && !g.get(px, y, pz)) { px += dx; pz += dz; }
      if (!on.has(g.get(px, y, pz))) continue;
      g.set(px, y, pz, typeof color === 'function' ? color() : color);
      placed++;
      continue;
    }
    if (y < minY || !on.has(g.get(x, y, z))) continue;
    g.set(x, y, z, typeof color === 'function' ? color() : color);
    placed++;
  }
  return placed;
};

/* ------------------------------------------------------------------ */
/* 3x5 pixel font for signs (rows top -> bottom, 3 bits each, MSB left)  */
/* ------------------------------------------------------------------ */
const FONT = {
  A: 0x2bed, B: 0x6bae, C: 0x3923, D: 0x6b6e, E: 0x79a7, F: 0x79a4, G: 0x396b, H: 0x5bed, I: 0x7497,
  K: 0x5bad, L: 0x4927, M: 0x5fed, N: 0x6b6d, O: 0x2b6a, P: 0x6ba4, R: 0x6bad, S: 0x388e, T: 0x7492,
  U: 0x5b6f, V: 0x5b6a, X: 0x5aad, Y: 0x5a92, Z: 0x72a7, 0: 0x7b6f, 1: 0x2c97, 2: 0x62a7, 3: 0x628e,
  4: 0x5bc9, 5: 0x798e, 6: 0x39ef, 7: 0x7292, 8: 0x7bef, 9: 0x7bce, '+': 0x05d0, '-': 0x01c0, '!': 0x2482,
};
/**
 * Writes text with the 3x5 font; (x, y, z) = bottom-left corner as seen by the viewer.
 * face: 's' (+Z, reads toward +X), 'n' (-Z, reads toward -X), 'e' (+X, reads toward -Z),
 * 'w' (-X, reads toward +Z). Returns the advance in voxels (4 per glyph).
 */
K.text = (g, str, x, y, z, c, face = 's') => {
  const ux = face === 's' ? 1 : face === 'n' ? -1 : 0, uz = face === 'e' ? -1 : face === 'w' ? 1 : 0;
  let o = 0;
  for (const ch of String(str).toUpperCase()) {
    const bits = FONT[ch] || 0;
    for (let row = 0; row < 5; row++)
      for (let col = 0; col < 3; col++)
        if (bits & (1 << (14 - row * 3 - col))) g.set(x + ux * (o + col), y + 4 - row, z + uz * (o + col), c);
    o += 4;
  }
  return o - 1;
};

/** Width in voxels of a string in the 3x5 font. */
K.textW = (str) => String(str).length * 4 - 1;

/* ------------------------------------------------------------------ */
/* Tree building blocks                                                  */
/* ------------------------------------------------------------------ */
/** 2x2 trunk on the tile centre from y0 to y1 (exclusive). */
function trunk2(g, y0, y1, c = P.TRUNK) {
  g.box(3, y0, 3, 2, y1 - y0, 2, c);
}
/** A few root flare voxels at the trunk base. */
function roots(g, rng, n, c = P.TRUNK) {
  const spots = [[2, 3], [2, 4], [5, 3], [5, 4], [3, 2], [4, 2], [3, 5], [4, 5]];
  for (let k = 0; k < n; k++) {
    const s = spots.splice(rng.int(0, spots.length - 1), 1)[0];
    g.set(s[0], 0, s[1], c);
  }
}
/** True for a FOLIAGE voxel buried inside the canopy (no empty 6-neighbour): wood drawn there never shows in leaf. */
function buried(g, x, y, z) {
  const v = g.get(x, y, z);
  return !!v && (VC.voxel.flags(v) & MAT.FOLIAGE) !== 0 && !K.exposed(g, x, y, z);
}
/** 3D voxel line that only replaces buried leaves (a hidden limb / twig). */
function hiddenLine(g, x0, y0, z0, x1, y1, z1, c) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t), z = Math.round(z0 + (z1 - z0) * t);
    if (buried(g, x, y, z)) g.set(x, y, z, c);
  }
}
/**
 * Winter skeleton of a deciduous crown (drawn AFTER the canopy, through buried leaves only): a leader continuing
 * the trunk up to y1, `n` limbs from the leader out to ~0.8 of the crown radius, and a forked twig at each limb end.
 * o = {y0 (leader start), y1 (leader top), cy, rx, ry (crown), n, x, z (leader corner, default trunk), c}
 */
function skeleton(g, rng, o) {
  const c = o.c || P.TRUNK;
  const lx = o.x == null ? 3 : o.x, lz = o.z == null ? 3 : o.z;
  // leader: 2x2 in the lower crown, a single column higher up
  for (let y = o.y0; y < o.y1; y++) {
    const w = y < o.y0 + (o.y1 - o.y0) * 0.55 ? 2 : 1;
    for (let dz = 0; dz < w; dz++) for (let dx = 0; dx < w; dx++) if (buried(g, lx + dx, y, lz + dz)) g.set(lx + dx, y, lz + dz, c);
  }
  const a0 = rng() * Math.PI * 2;
  for (let k = 0; k < o.n; k++) {
    const a = a0 + (k / o.n) * Math.PI * 2 + rng.range(-0.35, 0.35);
    const ys = Math.round(o.y0 + (o.y1 - o.y0) * rng.range(0.1, 0.75));
    const r = o.rx * rng.range(0.7, 0.95);
    const ex = Math.round(3.5 + Math.cos(a) * r), ez = Math.round(3.5 + Math.sin(a) * r);
    const ey = Math.round(Math.min(o.cy + o.ry * 0.75, ys + rng.range(1.2, 2.6)));
    hiddenLine(g, lx, ys, lz, ex, ey, ez, c);
    // forked twig
    for (const sg of [-1, 1]) {
      const b = a + sg * rng.range(0.5, 0.9);
      hiddenLine(g, ex, ey, ez, Math.round(ex + Math.cos(b) * 1.4), ey + rng.int(1, 2), Math.round(ez + Math.sin(b) * 1.4), c);
    }
  }
}
/** Branch from the trunk (3.5, y, 3.5) out toward angle a, reaching radius r, rising dy. */
function branch(g, y, a, r, dy, c = P.TRUNK) {
  const x1 = Math.round(3.5 + Math.cos(a) * r), z1 = Math.round(3.5 + Math.sin(a) * r);
  g.line(Math.round(3.5 + Math.cos(a) * 0.8), y, Math.round(3.5 + Math.sin(a) * 0.8), VC.M.clamp(x1, 0, 7), y + dy, VC.M.clamp(z1, 0, 7), c);
  return [x1, y + dy, z1];
}


/**
 * Lobed crown: a modest core plus n lobes spread around (4, cy, 4) so the silhouette stays bumpy
 * (a single big ellipsoid gets flat sides inside the 8-voxel footprint). Lobe shade follows its
 * height: low -> dark, mid -> mid, high -> light. Optional light top cap.
 */
function crown(g, rng, o) {
  const { cy, rx, ry, n, spread, lr, dark, mid, light } = o;
  K.blobIn(g, 4, cy, 4, rx, ry, rx, mid);
  const a0 = rng() * Math.PI * 2;
  for (let k = 0; k < n; k++) {
    const a = a0 + (k / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    // alternate low / high lobes so the shading reads as clumps, not bands
    const dy = (k % 2 ? -0.45 : 0.25) * ry + rng.range(-0.3, 0.3) * ry;
    const r = lr * rng.range(0.9, 1.1);
    const col = dy < -ry * 0.2 ? dark : dy > ry * 0.2 ? light : mid;
    K.blobIn(g, 4 + Math.cos(a) * spread, cy + dy, 4 + Math.sin(a) * spread, r, r * 0.85, r, col);
  }
  if (o.cap) K.blobIn(g, 4 + rng.range(-0.6, 0.6), cy + ry * 0.7, 4 + rng.range(-0.6, 0.6), o.cap, o.cap * 0.7, o.cap, o.capC || light);
}

/* ------------------------------------------------------------------ */
/* Species                                                               */
/* ------------------------------------------------------------------ */
const T = 8; // tree grid width/depth

VC.models.define('tree_oak', {
  variants: 6,
  openFoliage: true,
  gen(rng) {
    const g = new VC.VoxelGrid(T, 18, T);
    const th = rng.int(3, 4);
    trunk2(g, 0, th + 3);
    roots(g, rng, rng.int(2, 3));
    // forked limbs reaching out under the crown
    const a0 = rng() * Math.PI * 2, nb = rng.int(2, 3);
    const limbs = [];
    for (let k = 0; k < nb; k++) limbs.push(a0 + (k / nb) * Math.PI * 2);
    for (const a of limbs) branch(g, th, a, 2.7, 2);
    crown(g, rng, { cy: th + 4, rx: 2.9, ry: 2.7, n: 6, spread: 2.1, lr: 1.85, dark: P.LEAF_D, mid: P.LEAF, light: P.LEAF_L, cap: 2.1 });
    trunk2(g, 0, th);
    // the limbs again where the crown swallowed them, then the hidden winter skeleton
    for (const a of limbs) {
      const x1 = VC.M.clamp(Math.round(3.5 + Math.cos(a) * 2.7), 0, 7), z1 = VC.M.clamp(Math.round(3.5 + Math.sin(a) * 2.7), 0, 7);
      hiddenLine(g, Math.round(3.5 + Math.cos(a) * 0.8), th, Math.round(3.5 + Math.sin(a) * 0.8), x1, th + 2, z1, P.TRUNK);
    }
    skeleton(g, rng, { y0: th, y1: th + 6, cy: th + 4, rx: 2.9, ry: 2.7, n: 4 });
    return K.fit(g);
  },
});

VC.models.define('tree_maple', {
  variants: 6,
  openFoliage: true,
  gen(rng) {
    const g = new VC.VoxelGrid(T, 20, T);
    const th = rng.int(3, 4);
    trunk2(g, 0, th + 4);
    roots(g, rng, 2);
    const a0 = rng() * Math.PI * 2;
    for (let k = 0; k < 2; k++) branch(g, th, a0 + k * Math.PI + rng.range(-0.4, 0.4), 2.3, 3);
    // taller, denser, egg-shaped crown in bright greens
    const MA = K.col('MAPLE'), ML = K.col('MAPLE_L');
    crown(g, rng, { cy: th + 5, rx: 2.7, ry: 3.7, n: 6, spread: 1.95, lr: 1.8, dark: MA, mid: ML, light: ML, cap: 1.9, capC: P.BIRCH_LEAF });
    trunk2(g, 0, th);
    skeleton(g, rng, { y0: th, y1: th + 8, cy: th + 5, rx: 2.7, ry: 3.7, n: 5 });
    return K.fit(g);
  },
});

VC.models.define('tree_birch', {
  lodMinFill: 1,
  variants: 6,
  openFoliage: true,
  gen(rng) {
    const g = new VC.VoxelGrid(T, 22, T);
    const hs = rng.int(13, 16);
    // 1-3 slender white stems from a shared base, with dark bark bands
    const stems = [[3, 3, 3, 3]];
    if (rng.chance(0.75)) stems.push([4, 4, rng.pick([5, 6]), rng.pick([5, 6])]);
    if (rng.chance(0.35)) stems.push([3, 4, 1, rng.pick([5, 6])]);
    const tops = [], stemVox = [];
    stems.forEach(([x0, z0, x1, z1], si) => {
      const n = si === 0 ? hs : hs - rng.int(2, 4);
      let px = x0, pz = z0;
      for (let y = 0; y < n; y++) {
        const f = Math.pow(y / n, 1.6);
        const x = Math.round(x0 + (x1 - x0) * f), z = Math.round(z0 + (z1 - z0) * f);
        const band = (y + si * 2) % 4 === 1 && y > 0 && y < n - 4;
        if (x !== px || z !== pz) { g.set(px, y, pz, P.TRUNK_BIRCH); stemVox.push([px, y, pz, P.TRUNK_BIRCH]); }
        g.set(x, y, z, band ? P.BLACK : P.TRUNK_BIRCH);
        stemVox.push([x, y, z, band ? P.BLACK : P.TRUNK_BIRCH]);
        px = x;
        pz = z;
      }
      tops.push([px + 0.5, n, pz + 0.5]);
    });
    // airy canopy: separate small clumps around the upper stems, trunks visible below
    const nC = stems.length > 2 ? 5 : rng.int(5, 6);
    for (let k = 0; k < nC; k++) {
      const t = tops[k % tops.length];
      const a = rng() * Math.PI * 2, d = rng.range(0.4, 1.7);
      const cy = t[1] - rng.range(0.3, 5) + (k === 0 ? 1 : 0);
      const r = rng.range(1.5, 2);
      K.blobIn(g, t[0] + Math.cos(a) * d, cy, t[2] + Math.sin(a) * d, r, r * 0.9, r, cy > t[1] - 2 ? P.BIRCH_LEAF : P.LEAF_L);
    }
    // winter: the white stems again inside the clumps, plus fine twigs off the stem tops
    for (const [x, y, z, c] of stemVox) if (buried(g, x, y, z)) g.set(x, y, z, c);
    for (const t of tops) {
      const b0 = rng() * Math.PI * 2;
      for (let k = 0; k < 3; k++) {
        const a = b0 + (k / 3) * Math.PI * 2;
        hiddenLine(g, Math.floor(t[0]), t[1] - 3, Math.floor(t[2]), Math.round(t[0] - 0.5 + Math.cos(a) * 1.8), t[1] - 1 + rng.int(0, 1), Math.round(t[2] - 0.5 + Math.sin(a) * 1.8), P.WOOD_D);
      }
    }
    return K.fit(g);
  },
});

VC.models.define('tree_pine', {
  variants: 6,
  gen(rng) {
    const g = new VC.VoxelGrid(T, 23, T);
    const H = rng.int(17, 21);
    const tiers = 4, y0 = 2;
    const step = (H - y0 - 3) / tiers;
    trunk2(g, 0, H - 2); // core: shows below the skirts and between tiers
    for (let t = 0; t < tiers; t++) {
      const yb = Math.round(y0 + t * step), yn = Math.round(y0 + (t + 1) * step);
      const r = 3.5 - t * 0.52 + rng.range(-0.08, 0.08);
      // each tier: a dark drooping skirt, then a narrower body filling up to the next skirt
      // (equal outlines stack into tall merged side faces)
      K.disc(g, 4, yb, 4, r, P.PINE_D);
      K.disc(g, 4, yb + 1, 4, r - 0.8, P.PINE, Math.max(1, yn - yb - 1));
    }
    // leader spike
    const top = Math.round(y0 + tiers * step);
    g.box(3, top, 3, 2, Math.max(1, H - top - 1), 2, P.PINE);
    g.set(3 + rng.int(0, 1), H - 1, 3 + rng.int(0, 1), P.PINE);
    return K.fit(g);
  },
});

VC.models.define('tree_cypress', {
  variants: 5,
  gen(rng) {
    const g = new VC.VoxelGrid(T, 22, T);
    const H = rng.int(15, 20);
    trunk2(g, 0, 3);
    // flame-shaped column from quantized disc radii (1.6 plus-shape, 2.3 square, 2.7 round) so
    // consecutive layers share outlines and mesh into tall faces
    const body = H - 2;
    for (let y = 2; y < H; y++) {
      const t = (y - 2) / body;
      const r = t < 0.08 ? 1.6 : t < 0.18 ? 2.3 : t < 0.55 ? 2.7 : t < 0.78 ? 2.3 : t < 0.92 ? 1.6 : 0.8;
      K.disc(g, 4, y, 4, r, P.PINE);
    }
    // a few darker flame licks break the symmetry
    for (let k = 0; k < 3; k++) {
      const a = rng.int(0, 3), y = rng.int(4, Math.round(2 + body * 0.7));
      const x = [1, 6, 3, 4][a], z = [3, 4, 1, 6][a];
      g.box(x, y, z, 1, rng.int(2, 4), 1, P.PINE_D);
    }
    g.set(3 + rng.int(0, 1), H, 3 + rng.int(0, 1), P.PINE);
    return K.fit(g);
  },
});

VC.models.define('tree_palm', {
  lodMinFill: 1,
  variants: 6,
  gen(rng) {
    const g = new VC.VoxelGrid(T, 20, T);
    const H = rng.int(12, 15);
    // gently curved trunk leaning toward +X (the renderer rotates trees randomly), rings in pairs
    const bx = 2, bz = rng.int(3, 4), lean = rng.range(1.5, 2.1);
    let px = bx;
    g.box(1, 0, bz, 2, 1, 1, P.WOOD);
    for (let y = 0; y <= H; y++) {
      const x = Math.round(bx + lean * Math.pow(y / H, 1.5));
      if (x !== px) g.set(px, y, bz, P.WOOD);
      g.set(x, y, bz, (y >> 1) % 2 ? P.WOOD : P.TRUNK);
      px = x;
    }
    const cx = px, cz = bz, cy = H + 1;
    g.box(cx, cy - 1, cz, 1, 3, 1, P.PALM); // crown hub + young upright frond
    // four long axis-aligned fronds (straight runs mesh cheaply) that arch then droop,
    // with leaflet rows hanging one voxel lower on both sides
    const AX = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const a0 = rng.int(0, 1);
    AX.forEach(([dx, dz], k) => {
      const room = dx > 0 ? 7 - cx : dx < 0 ? cx : dz > 0 ? 7 - cz : cz;
      const L = Math.min(room, rng.int(3, 4));
      const col = (k + a0) % 2 ? P.PALM : P.HEDGE; // evergreen shades only
      const prof = rng.chance(0.5) ? [0, 0, -1, -2] : [1, 0, -1, -2];
      for (let t = 1; t <= L; t++) {
        const x = cx + dx * t, z = cz + dz * t, y = cy + prof[t - 1];
        g.set(x, y, z, col);
        if (t >= 2 && t < L) {
          g.set(x + dz, y - 1, z + dx, col);
          g.set(x - dz, y - 1, z - dx, col);
        }
      }
    });
    // four shorter diagonal fronds
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const L = rng.int(2, 3);
      for (let t = 1; t <= L; t++) {
        const x = cx + dx * t, z = cz + dz * t;
        if (x < 0 || z < 0 || x > 7 || z > 7) break;
        g.set(x, cy - t + 1, z, t === L ? P.HEDGE : P.PALM);
      }
    }
    // coconut cluster under the crown
    const nc = rng.int(2, 3);
    for (let k = 0; k < nc; k++) g.set(cx + [1, -1, 0][k], H - 1, cz + [0, 0, 1][k], P.BROWN);
    return K.fit(g);
  },
});

VC.models.define('tree_cherry', {
  variants: 5,
  openFoliage: true,
  gen(rng) {
    const g = new VC.VoxelGrid(T, 16, T);
    const B = K.col('BLOSSOM'), BL = K.col('BLOSSOM_L');
    const th = rng.int(3, 4);
    trunk2(g, 0, th, P.WOOD_D);
    roots(g, rng, 2, P.WOOD_D);
    // gnarled limbs spreading wide
    const nb = 3, a0 = rng() * Math.PI * 2, ends = [];
    for (let k = 0; k < nb; k++) ends.push(branch(g, th - 1, a0 + (k / nb) * Math.PI * 2 + rng.range(-0.3, 0.3), rng.range(2.3, 2.9), rng.int(3, 4), P.WOOD_D));
    // flattened blossom clouds at the limb tips, a crown and one light highlight
    for (const e of ends) K.blobIn(g, e[0] + 0.5, e[1] + 1.2, e[2] + 0.5, 2, 1.45, 2, B);
    K.blobIn(g, 4, th + 5.3, 4, 2.5, 1.8, 2.5, B);
    K.blobIn(g, 4 + rng.range(-0.8, 0.8), th + 6.4, 4 + rng.range(-0.8, 0.8), 2, 1.1, 2, BL);
    // winter: the limbs again inside the clouds + a hidden skeleton in the crown
    for (const e of ends) {
      const x1 = VC.M.clamp(e[0], 0, 7), z1 = VC.M.clamp(e[2], 0, 7);
      hiddenLine(g, 3, th - 1, 3, x1, e[1], z1, P.WOOD_D);
      for (const sg of [-1, 1]) hiddenLine(g, x1, e[1], z1, x1 + sg * rng.int(0, 1), e[1] + 2, z1 - sg * rng.int(0, 1), P.WOOD_D);
    }
    skeleton(g, rng, { y0: th, y1: th + 6, cy: th + 5.3, rx: 2.5, ry: 1.8, n: 3, c: P.WOOD_D });
    // a couple of fallen petals by the trunk (seasonal: they vanish outside blossom time)
    const petal = K.col('BLOOM_P');
    for (const [x, z] of [[2, 5], [5, 2], [6, 5], [1, 2]]) if (rng.chance(0.5) && !g.get(x, 0, z)) g.set(x, 0, z, petal);
    return K.fit(g);
  },
});

VC.models.define('tree_bush', {
  variants: 6,
  gen(rng, v) {
    const g = new VC.VoxelGrid(T, 8, T);
    const n = rng.int(3, 4);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rng();
      const d = k === 0 ? 0 : rng.range(1.2, 1.9);
      const r = rng.range(1.7, 2.3);
      const ry = rng.range(1.6, 2.3);
      K.blobIn(g, 4 + Math.cos(a) * d, ry - 0.4, 4 + Math.sin(a) * d, r, ry, r, k === 0 ? P.HEDGE : k % 2 ? P.LEAF_D : P.LEAF);
    }
    // flowers / berries by variant (0: plain green); FOLIAGE colours, so they follow the seasons
    const fk = [null, 'BLOOM_R', 'BLOOM_Y', 'BLOOM_P', 'BLOOM_W', 'BLOOM_V'][v % 6];
    const FL = fk ? K.col(fk) : 0;
    if (FL) K.sprinkle(g, rng, rng.int(6, 9), new Set([P.HEDGE, P.LEAF_D, P.LEAF]), FL, 1);
    return K.fit(g);
  },
});
