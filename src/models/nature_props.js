/*
 * VOXELPOLIS — NATURE: street furniture, utility and disaster props.
 *
 * Street furniture uses scale 0.5 (1/16-unit voxels, 16 per tile) so poles stay slim next to the
 * 1/8-unit buildings. Non-sized props are centred on their grid (renderer origin = bottom centre
 * (sx/2, 0, sz/2)); odd grid widths keep 1-voxel poles exactly on that origin. Front = +Z.
 * Lamps, traffic lights and hydrants are `lod: false`: a half-resolution LOD would double their 1-voxel poles
 * into chunky pillars, so the full mesh (a few dozen quads) is drawn at every distance.
 *
 *   streetlamp     scale .5, 9x13x9 (0.81 units: a one-storey eave, about half a two-storey house). Pole on
 *                  the origin, the head hangs 3-3.5 voxels out along +Z (the terrain's light pools and
 *                  VC.props.lampReach, ~0.2 units, sit under it). Variants: 0 classic (dark grey-green
 *                  cast-iron crook + lantern, warm LAMP — not pure black, so the slim pole still reads against
 *                  dark asphalt), 1 modern (grey LED arm, LAMP_WHITE). meta.head = lamp position (voxels);
 *                  g.light at the head (glows at night).
 *   traffic_light  scale .5, 9x14x17 (0.88 units). Pole on the origin, mast arm along +Z over the lanes
 *                  carrying a double-faced head that faces +-X (seen by traffic moving along X; its underside
 *                  clears the tallest vehicles); a small pole head faces +-Z for the crossing direction.
 *                  Variants (main head / pole head): 0 red/green, 1 green/red, 2 yellow/red,
 *                  3 red/yellow. VC.natureKit.signalVariant(phase, rot) maps an agents.signal()
 *                  phase to the right variant. meta.heads = lit lamps of the main head; every
 *                  lit lamp also has an always-on g.light.
 *   pylon          scale .5, 15x46x15 steel lattice tower; cross arms along X, wires run along +-Z.
 *                  meta.wire = 6 insulator attachment points in voxel coords, 3 per side:
 *                  [-X low, -X mid, -X high, +X low, +X mid, +X high]; meta.earth = top peak.
 *                  World position of a point: VC.natureKit.toWorld(model, p, x, y, z, angle).
 *   bench          scale .5, variants 3 (park wood / painted green / modern concrete); faces +Z.
 *   bus_stop       scale .5, 15x12x7 glass shelter open to +Z, bench, backlit ad, round sign.
 *   hydrant        scale .5, variants 2.
 *   billboard      scale .5, 15x22x5 roadside billboard, emissive screen on +Z; variants 4 designs.
 *   rubble         scale 1, sized {fw, fd}: concrete / brick / charred piles, rebar, wall stumps.
 *   crater         scale 1, sized {fw, fd}: scorched bowl, raised rim, glowing ember voxels,
 *                  meteor remains; smoke + fire emitters and ember glow lights.
 */
const P = VC.P;
const K = VC.natureKit;
const M = VC.M;

/* ------------------------------------------------------------------ */
/* Street lamp                                                           */
/* ------------------------------------------------------------------ */
VC.models.define('streetlamp', {
  lod: false, // (thin pole: the full mesh is its own LOD)
  variants: 2,
  scale: 0.5,
  gen(rng, v) {
    const g = new VC.VoxelGrid(9, 13, 9);
    const X = 4, Z = 4;
    if (v % 2 === 0) {
      // classic: stepped cast-iron base, fluted pole, shepherd's crook, hanging lantern
      const IRON = K.col('IRON');
      g.box(3, 0, 3, 3, 1, 3, IRON);
      g.box(X, 1, Z, 1, 11, 1, IRON);
      g.set(X, 3, Z, P.GOLD);
      g.set(X, 12, Z, P.GOLD); // finial
      g.box(X, 11, Z + 1, 1, 1, 3, IRON); // arm
      g.set(X, 10, Z + 1, IRON); // scroll brace
      g.set(X, 10, Z + 3, IRON); // lantern cap
      g.box(X, 8, Z + 3, 1, 2, 1, P.LAMP);
      g.set(X, 7, Z + 3, IRON);
      g.meta.head = [X + 0.5, 8.5, Z + 3.5];
      g.light(X + 0.5, 8.5, Z + 3.5, [1, 0.78, 0.45], 1.2);
    } else {
      // modern: slim grey pole, rising arm, flat LED head
      g.box(3, 0, 3, 3, 1, 3, P.CONCRETE_D);
      g.box(X, 1, Z, 1, 11, 1, P.METAL);
      g.line(X, 11, Z, X, 12, Z + 2, P.METAL);
      g.box(X, 12, Z + 2, 1, 1, 3, P.METAL_D);
      g.box(X, 11, Z + 3, 1, 1, 2, P.LAMP_WHITE);
      g.meta.head = [X + 0.5, 11, Z + 4];
      g.light(X + 0.5, 11, Z + 4, [0.85, 0.92, 1], 1.2);
    }
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* Traffic light                                                         */
/* ------------------------------------------------------------------ */
const SIG_ON = () => [P.NEON_RED, P.NEON_ORANGE, P.NEON_GREEN];
const SIG_OFF = () => [P.BRICK_D, P.WOOD_D, K.col('KAIJU_D')];
const SIG_RGB = [[1, 0.2, 0.15], [1, 0.6, 0.1], [0.3, 1, 0.4]];
/**
 * Traffic-light variant for an intersection phase as returned by VC.agents.signal(x, z)
 * (0 X-axis green, 1 X yellow, 2 Z-axis green, 3 Z yellow; <0 none) and the prop's quarter-turn
 * rotation (rot 0/2: main head seen by X traffic, rot 1/3: by Z traffic).
 */
K.signalVariant = (phase, rot = 0) => (phase < 0 ? 0 : (rot & 1 ? [0, 3, 1, 2] : [1, 2, 0, 3])[phase & 3]);
VC.models.define('traffic_light', {
  lod: false, // (thin pole: the full mesh is its own LOD)
  variants: 4,
  scale: 0.5,
  gen(rng, v) {
    const g = new VC.VoxelGrid(9, 14, 17);
    const X = 4, Z = 8;
    const on = SIG_ON(), off = SIG_OFF();
    // variant -> lit lamp (0 top red, 1 yellow, 2 green) of the main (X-facing) head and the pole
    // (Z-facing) head: 0 red/green, 1 green/red, 2 yellow/red, 3 red/yellow
    const litX = [0, 2, 1, 0][v % 4], litZ = [2, 0, 0, 1][v % 4];
    g.box(3, 0, 7, 3, 1, 3, P.CONCRETE_D);
    g.box(X, 1, Z, 1, 12, 1, P.METAL_D);
    g.box(X, 12, Z + 1, 1, 1, 8, P.METAL_D); // mast arm over the lanes
    g.set(X, 11, Z + 1, P.METAL_D); // gusset
    // street-name blade on the arm
    g.box(X, 13, Z + 2, 1, 1, 3, P.GREEN);
    g.set(X, 13, Z + 3, P.WHITE);
    // main head hanging from the arm end: lamps on the +-X faces, black housing around them. Its underside
    // (y 8 = 0.5 units + the kerb) clears the tallest vehicles (trucks, 0.5 units) passing below
    const hz = Z + 6;
    g.box(X, 8, hz - 1, 1, 4, 3, P.BLACK);
    g.meta.heads = [];
    for (let k = 0; k < 3; k++) {
      const y = 10 - k;
      g.set(X, y, hz, k === litX ? on[k] : off[k]);
      if (k === litX) {
        g.meta.heads.push([X + 0.5, y + 0.5, hz + 0.5]);
        g.light(X - 0.2, y + 0.5, hz + 0.5, SIG_RGB[k], 0.5, true);
        g.light(X + 1.2, y + 0.5, hz + 0.5, SIG_RGB[k], 0.5, true);
      }
    }
    // pole head for the crossing direction (faces +-Z), complementary aspect
    g.box(X + 1, 5, Z, 2, 5, 1, P.BLACK);
    for (let k = 0; k < 3; k++) {
      const y = 8 - k;
      g.set(X + 1, y, Z, k === litZ ? on[k] : off[k]);
      if (k === litZ) g.light(X + 1.5, y + 0.5, Z + 1.2, SIG_RGB[k], 0.45, true);
    }
    // push-button box for pedestrians
    g.set(X, 4, Z - 1, P.HAZARD_Y);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* Power pylon                                                           */
/* ------------------------------------------------------------------ */
VC.models.define('pylon', {
  lodMinFill: 1,
  variants: 1,
  scale: 0.5,
  gen() {
    const g = new VC.VoxelGrid(15, 46, 15);
    const C = 7, ST = P.METAL, TOP = 30;
    const half = (y) => (y >= TOP ? 2 : Math.round(6 - (4 * y) / TOP));
    // four tapering legs, then a straight upper mast
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        g.line(C + sx * 6, 0, C + sz * 6, C + sx * 2, TOP, C + sz * 2, ST);
        g.box(C + sx * 2, TOP, C + sz * 2, 1, 12, 1, ST);
        g.line(C + sx * 2, 42, C + sz * 2, C, 44, C, ST);
        g.box(C + sx * 6 - (sx > 0 ? 0 : 0), 0, C + sz * 6, 1, 1, 1, P.CONCRETE_D); // footing
      }
    g.box(C, 44, C, 1, 2, 1, ST); // earth-wire peak
    // girth rings
    const rings = [7, 14, 21, TOP, 42];
    for (const y of rings) {
      const w = half(y);
      g.box(C - w, y, C - w, 2 * w + 1, 1, 1, ST);
      g.box(C - w, y, C + w, 2 * w + 1, 1, 1, ST);
      g.box(C - w, y, C - w, 1, 1, 2 * w + 1, ST);
      g.box(C + w, y, C - w, 1, 1, 2 * w + 1, ST);
    }
    // lattice braces (diagonal voxels are the expensive part of the mesh): a full X in the
    // bottom panel, alternating single diagonals in the next two, girth rings carry the rest
    const faces = [[1, -1], [1, 1], [0, -1], [0, 1]]; // [alongX, side]
    let y0 = 0;
    rings.slice(0, 3).forEach((y1, i) => {
      const w0 = half(y0), w1 = half(y1);
      faces.forEach(([ax, s], f) => {
        const pt = (w, y, t) => (ax ? [C + t * w, y, C + s * w] : [C + s * w, y, C + t * w]);
        const a = pt(w0, y0, -1), b = pt(w1, y1, 1), c = pt(w0, y0, 1), d = pt(w1, y1, -1);
        if ((i + f) % 2) g.line(a[0], a[1], a[2], b[0], b[1], b[2], ST);
        else g.line(c[0], c[1], c[2], d[0], d[1], d[2], ST);
      });
      y0 = y1;
    });
    // three cross arms along X (triangulated), insulator strings hanging at the tips
    const wire = [[], []];
    [[28, 7], [34, 6], [40, 5]].forEach(([y, L]) => {
      g.box(C - L, y, C, 2 * L + 1, 1, 1, ST);
      for (const s of [-1, 1]) {
        g.line(C + s * half(y - 3), y - 3, C, C + s * (L - 1), y - 1, C, ST);
        g.box(C + s * L, y - 2, C, 1, 2, 1, P.GLASS_CYAN);
        wire[s < 0 ? 0 : 1].push([C + s * L + 0.5, y - 2, C + 0.5]);
      }
    });
    g.meta.wire = wire[0].concat(wire[1]);
    g.meta.earth = [C + 0.5, 46, C + 0.5];
    // danger plate on one leg
    g.set(C - 5, 6, C - 6, P.HAZARD_Y);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* Bench, hydrant                                                        */
/* ------------------------------------------------------------------ */
VC.models.define('bench', {
  lodMinFill: 1,
  variants: 3,
  scale: 0.5,
  gen(rng, v) {
    const g = new VC.VoxelGrid(7, 4, 3);
    const kind = v % 3;
    if (kind === 2) {
      // modern: concrete block with a timber top, no back
      g.box(0, 0, 0, 1, 1, 3, P.CONCRETE_L);
      g.box(6, 0, 0, 1, 1, 3, P.CONCRETE_L);
      g.box(0, 1, 0, 7, 1, 3, P.WOOD_L);
      return K.fit(g);
    }
    const slat = kind === 0 ? P.WOOD_L : P.GREEN, frame = P.BLACK;
    g.box(0, 0, 0, 1, 3, 1, frame); // rear legs + back posts
    g.box(6, 0, 0, 1, 3, 1, frame);
    g.box(0, 0, 2, 1, 2, 1, frame); // front legs + armrests
    g.box(6, 0, 2, 1, 2, 1, frame);
    g.box(0, 2, 1, 1, 1, 2, frame);
    g.box(6, 2, 1, 1, 1, 2, frame);
    g.box(1, 1, 0, 5, 1, 3, slat); // seat
    g.box(1, 2, 0, 5, 1, 1, slat); // back rest
    g.box(1, 3, 0, 5, 1, 1, slat);
    return K.fit(g);
  },
});

VC.models.define('hydrant', {
  lod: false, // (tiny: a half-resolution LOD is a blob)
  variants: 2,
  scale: 0.5,
  gen(rng, v) {
    const g = new VC.VoxelGrid(3, 4, 3);
    const body = v % 2 ? P.YELLOW : P.RED, cap = v % 2 ? P.RED : P.YELLOW;
    g.box(0, 0, 1, 3, 1, 1, body);
    g.box(1, 0, 0, 1, 1, 3, body);
    g.box(1, 1, 1, 1, 2, 1, body);
    g.set(0, 2, 1, P.CHROME); // side outlets
    g.set(2, 2, 1, P.CHROME);
    g.set(1, 2, 2, P.CHROME); // pumper nozzle faces the street
    g.set(1, 3, 1, cap);
    return g;
  },
});

/* ------------------------------------------------------------------ */
/* Bus stop                                                              */
/* ------------------------------------------------------------------ */
VC.models.define('bus_stop', {
  lodMinFill: 1,
  variants: 2,
  scale: 0.5,
  gen(rng, v) {
    const g = new VC.VoxelGrid(15, 12, 7);
    const frame = P.METAL_D, glass = P.GLASS_CYAN;
    const roof = v % 2 ? P.ROOF_TEAL : P.METAL;
    // posts
    for (const x of [1, 13]) for (const z of [1, 5]) g.box(x, 0, z, 1, 8, 1, frame);
    // back glass wall with rails
    g.box(2, 1, 1, 11, 6, 1, glass);
    g.box(2, 0, 1, 11, 1, 1, frame);
    g.box(2, 7, 1, 11, 1, 1, frame);
    // side panels: glass on the left, backlit advert on the right
    g.box(1, 1, 2, 1, 6, 3, glass);
    g.box(13, 1, 2, 1, 6, 3, P.SIGN_WHITE);
    g.box(13, 2, 3, 1, 3, 1, v % 2 ? P.NEON_PINK : P.NEON_BLUE);
    g.set(13, 5, 2, P.NEON_YELLOW);
    // roof slab with a lip, light strip underneath
    g.box(0, 8, 0, 15, 1, 7, roof);
    g.box(0, 8, 6, 15, 1, 1, frame);
    g.box(3, 7, 3, 9, 1, 1, P.LAMP_WHITE);
    g.light(7.5, 7, 3.5, [0.85, 0.92, 1], 1.1);
    // bench
    g.box(4, 2, 2, 7, 1, 2, P.WOOD_L);
    g.box(4, 0, 3, 1, 2, 1, frame);
    g.box(10, 0, 3, 1, 2, 1, frame);
    // round stop sign on a pole, outside the shelter at the kerb
    g.box(14, 0, 6, 1, 9, 1, frame);
    g.box(14, 9, 5, 1, 3, 1, P.BLUE);
    g.box(14, 10, 4, 1, 1, 3, P.BLUE);
    g.set(14, 10, 5, P.SIGN_WHITE);
    // litter bin
    g.box(0, 0, 5, 1, 2, 1, P.GREEN);
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* Billboard                                                             */
/* ------------------------------------------------------------------ */
/** Screen painters: (u, v) in [0,13) x [0,8) from bottom-left -> palette index. */
const ADS = [
  // synthwave sunset
  (u, v) => {
    const d = Math.hypot(u - 6, v - 3.2);
    if (d < 3.4 && v >= 2 && !(v === 3 || v === 5 && d > 2)) return v > 4 ? P.NEON_YELLOW : P.NEON_ORANGE;
    return v < 2 ? P.NEON_PURPLE : v < 4 ? P.NEON_PINK : v < 6 ? P.NEON_PURPLE : P.NAVY;
  },
  // soda
  null,
  // VOX logo
  null,
  // city skyline under the moon
  (u, v) => {
    const sky = [3, 5, 2, 6, 4, 7, 3, 5, 2, 4, 6, 3, 2][u];
    if (v < sky) return (u * 3 + v) % 5 === 0 && v > 0 ? P.NEON_YELLOW : P.NAVY;
    if (Math.hypot(u - 10, v - 6) < 1.3) return P.SIGN_WHITE;
    return P.NEON_BLUE;
  },
];
VC.models.define('billboard', {
  lodMinFill: 1,
  variants: 4,
  scale: 0.5,
  gen(rng, v) {
    const g = new VC.VoxelGrid(15, 22, 5);
    const frame = P.METAL_D;
    // legs, catwalk, back plate and frame
    g.box(3, 0, 1, 1, 12, 1, frame);
    g.box(11, 0, 1, 1, 12, 1, frame);
    g.box(2, 0, 0, 3, 1, 3, P.CONCRETE_D);
    g.box(10, 0, 0, 3, 1, 3, P.CONCRETE_D);
    g.box(0, 11, 2, 15, 1, 3, P.METAL);
    g.box(0, 12, 1, 15, 10, 1, frame);
    g.box(0, 12, 2, 15, 10, 1, frame);
    // flood lamps on the catwalk
    for (const x of [2, 7, 12]) g.set(x, 12, 4, P.LAMP_WHITE);
    const kind = v % 4;
    const paint = ADS[kind];
    for (let vv = 0; vv < 8; vv++) for (let u = 0; u < 13; u++) g.set(1 + u, 13 + vv, 2, paint ? paint(u, vv) : kind === 1 ? P.NEON_RED : P.NAVY);
    if (kind === 1) {
      // soda: white swoosh + POP lettering
      for (let u = 0; u < 13; u++) g.set(1 + u, 13 + Math.round(1.2 + Math.sin(u * 0.6) * 0.9), 2, P.SIGN_WHITE);
      K.text(g, 'POP', 2, 15, 2, P.SIGN_WHITE, 's');
      g.box(13, 16, 2, 1, 3, 1, P.NEON_YELLOW);
    } else if (kind === 2) {
      K.text(g, 'VOX', 2, 15, 2, P.NEON_CYAN, 's');
      g.box(1, 13, 2, 13, 1, 1, P.NEON_PINK);
      g.box(1, 20, 2, 13, 1, 1, P.NEON_PINK);
    }
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* Rubble (sized)                                                        */
/* ------------------------------------------------------------------ */
const RUBBLE_MATS = () => [
  [P.CONCRETE, P.CONCRETE_D, P.CONCRETE_L, P.STONE_D],
  [P.BRICK, P.BRICK_D, P.BRICK_L, P.CONCRETE_D],
  [P.CONCRETE_D, P.CONCRETE_DD, P.BLACK, P.BRICK_D],
];
VC.models.define('rubble', {
  variants: 3,
  sized: true,
  gen(rng, v, p) {
    const fw = p.fw || 1, fd = p.fd || 1, sx = fw * 8, sz = fd * 8;
    const g = new VC.VoxelGrid(sx, 16, sz);
    const mats = RUBBLE_MATS()[v % 3];
    const seed = rng.int(0, 1e6);
    // dusty debris floor, patchy in 2x2 blocks (cheap to mesh)
    g.box(0, 0, 0, sx, 1, sz, (x, y, z) => (M.hash(x >> 1, z >> 1, seed) < 0.3 ? P.SOIL : M.hash(x >> 1, z >> 1, seed + 1) < 0.5 ? mats[1] : P.CONCRETE_D));
    // mounds: height = max over overlapping cones, material of the winning mound
    const n = Math.round(fw * fd * 1.5 + 1 + rng());
    const mounds = [];
    for (let k = 0; k < n; k++)
      mounds.push({ x: rng.range(1.5, sx - 1.5), z: rng.range(1.5, sz - 1.5), r: rng.range(2.6, 4.2) * Math.min(1.5, Math.sqrt(Math.min(fw, fd))), h: rng.range(2.5, 5) + Math.min(fw, fd) * 0.8, c: mats[k % 2] });
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        let best = 0, bm = null;
        for (const m of mounds) {
          const d = Math.hypot(x + 0.5 - m.x, z + 0.5 - m.z) / m.r;
          if (d >= 1) continue;
          const h = m.h * (1 - d * d) + (M.hash(x >> 1, z >> 1, seed + 7) - 0.5) * 1.2;
          if (h > best) { best = h; bm = m; }
        }
        const H = Math.round(best);
        if (H < 1) continue;
        const top = M.hash(x >> 1, z >> 1, seed + 3) < 0.25 ? mats[2] : M.hash(x >> 1, z >> 1, seed + 5) < 0.15 ? mats[3] : bm.c;
        g.box(x, 1, z, 1, H - 1, 1, bm.c);
        g.set(x, H, z, top);
      }
    // a standing wall stump with a window gap (concrete/brick variants)
    if (v % 3 !== 2 || rng.chance(0.5)) {
      const alongX = rng.chance(0.5), len = Math.min(alongX ? sx : sz, rng.int(4, 7) + Math.min(fw, fd) * 2);
      const off = rng.int(0, (alongX ? sx : sz) - len), edge = rng.chance(0.5) ? 1 : (alongX ? sz : sx) - 2;
      const wc = v % 3 === 1 ? P.BRICK : P.CONCRETE_L;
      for (let t = 0; t < len; t++) {
        const hh = Math.max(2, Math.round(3 + (Math.min(fw, fd) + 3) * Math.sin(((t + 0.5) / len) * Math.PI) * rng.range(0.6, 1)));
        for (let y = 1; y <= hh; y++) {
          const gap = t >= 2 && t <= 3 && y >= 3 && y <= 4 && len > 5;
          if (!gap) alongX ? g.set(off + t, y, edge, wc) : g.set(edge, y, off + t, wc);
        }
      }
    }
    // a few bent rebar rods poking out of the piles
    const nr = Math.max(1, Math.round(fw * fd * rng.range(0.6, 1.2)));
    for (let k = 0; k < nr; k++) {
      const x = rng.int(1, sx - 2), z = rng.int(1, sz - 2), y = g.heightAt(x, z);
      g.line(x, y, z, M.clamp(x + rng.int(-2, 2), 0, sx - 1), y + rng.int(2, 3), M.clamp(z + rng.int(-2, 2), 0, sz - 1), P.BROWN);
    }
    // charred beams lying across
    const nb = rng.int(1, 2) * Math.min(2, fw * fd);
    for (let k = 0; k < nb; k++) {
      const x0 = rng.int(0, sx - 1), z0 = rng.int(0, sz - 1), x1 = M.clamp(x0 + rng.int(-5, 5), 0, sx - 1), z1 = M.clamp(z0 + rng.int(-5, 5), 0, sz - 1);
      const y = Math.max(g.heightAt(x0, z0), g.heightAt(x1, z1));
      g.line(x0, y, z0, x1, Math.max(1, y - 1), z1, v % 3 === 2 ? P.BLACK : P.WOOD_D);
    }
    return K.fit(g);
  },
});

/* ------------------------------------------------------------------ */
/* Crater (sized)                                                        */
/* ------------------------------------------------------------------ */
VC.models.define('crater', {
  variants: 2,
  sized: true,
  gen(rng, v, p) {
    const fw = p.fw || 1, fd = p.fd || 1, sx = fw * 8, sz = fd * 8;
    const g = new VC.VoxelGrid(sx, 12, sz);
    const cx = sx / 2, cz = sz / 2, R = Math.min(sx, sz) / 2 - 0.2;
    const ph = rng() * 6.28, ph2 = rng() * 6.28, big = Math.sqrt(fw * fd);
    const jag = (a) => 1 + 0.08 * Math.sin(a * 5 + ph) + 0.06 * Math.sin(a * 9 + ph2);
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const dx = x + 0.5 - cx, dz = z + 0.5 - cz, a = Math.atan2(dz, dx);
        const d = Math.hypot(dx / (sx / 2 - 0.2), dz / (sz / 2 - 0.2)) / jag(a);
        if (d >= 1.02) continue;
        // scorched floor: black core, ash ring, burnt soil edge
        g.set(x, 0, z, d < 0.42 ? P.BLACK : d < 0.72 ? P.CONCRETE_DD : P.SOIL);
        // raised rim of thrown-up rock and soil
        if (d > 0.7 && d < 1) {
          const h = Math.round((1 + big * 0.9) * (1 - Math.abs(d - 0.86) / 0.16) * (0.75 + 0.25 * Math.sin(a * 3 + ph2)));
          if (h > 0) {
            const sector = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 7);
            const c = sector % 3 === 0 ? P.ROCK : sector % 3 === 1 ? P.SOIL : P.STONE_D;
            g.box(x, 1, z, 1, h, 1, c);
          }
        }
      }
    // meteor remains: cracked rock chunks with glowing seams
    const nChunks = 1 + Math.round(big);
    for (let k = 0; k < nChunks; k++) {
      const a = rng() * 6.28, dd = k === 0 ? 0 : rng.range(0.15, 0.35) * R;
      const x = cx + Math.cos(a) * dd, z = cz + Math.sin(a) * dd, r = (k === 0 ? 1.6 : 1.1) * (0.8 + big * 0.35);
      g.ellipsoid(x, r * 0.55, z, r, r * 0.8, r, k % 2 ? P.STONE_D : P.ROCK);
      // glowing seam: recolour only voxels of the chunk along a chord
      const x0 = Math.round(x - r), x1 = Math.round(x + r * 0.5), z0 = Math.round(z), z1 = Math.round(z + r * 0.4), y1 = Math.round(r * 1.1);
      for (let i = 0, n = Math.max(1, Math.abs(x1 - x0)); i <= n; i++) {
        const px = Math.round(x0 + ((x1 - x0) * i) / n), py = Math.round(1 + ((y1 - 1) * i) / n), pz = Math.round(z0 + ((z1 - z0) * i) / n);
        if (g.get(px, py, pz)) g.set(px, py, pz, P.FIRE);
      }
    }
    g.light(cx, 1.5, cz, [1, 0.45, 0.12], 1.3 * big, true);
    g.emit(cx, Math.round(2 + big), cz, 'smoke', 1);
    g.emit(cx, 1, cz, 'fire', 0.6);
    // embers smouldering IN the scorched floor (flush, so they read as glowing cracks)
    const ne = Math.round(3 * fw * fd);
    for (let k = 0; k < ne; k++) {
      const a = rng() * 6.28, dd = rng.range(0.2, 0.6) * R;
      const x = Math.floor(cx + Math.cos(a) * dd), z = Math.floor(cz + Math.sin(a) * dd);
      if (g.get(x, 1, z) || !g.get(x, 0, z)) continue;
      g.set(x, 0, z, P.FIRE);
      if (k % 3 === 0) g.light(x + 0.5, 1, z + 0.5, [1, 0.5, 0.15], 0.6, true);
      if (k % 4 === 0) g.emit(x + 0.5, 1, z + 0.5, 'smoke', 0.4);
    }
    return K.fit(g);
  },
});
