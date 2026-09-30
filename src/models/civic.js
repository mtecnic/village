/*
 * VOXELPOLIS — civic / service / utility / landmark models: SHARED KIT.
 *
 * Every VC.CATALOG key gets a hand-designed voxel generator in the civic_*.js files
 * (loaded right after this one, alphabetically). This file defines VC.civicKit — the
 * authoring helpers they share: tight grids, facades with recessed windows, doors,
 * roofs, pixel-font signage, clocks, trees, lamps, benches, flags, fences, and a small
 * fleet of voxel vehicles (cars, police cars, ambulances, fire trucks, buses,
 * helicopters, jets, bulldozers) that are stamped into the models.
 *
 * Conventions (see gfx/voxel.js): grid = (fw*8) x H x (fd*8), y = 0 is the tile top,
 * the FRONT/entrance faces +Z. Faces are named 's' (+Z front), 'n' (-Z back),
 * 'e' (+X) and 'w' (-X). Generators only use the provided seeded rng.
 */
const P = VC.P;
const K = (VC.civicKit = {});

/* ------------------------------------------------------------------ */
/* Grids                                                                */
/* ------------------------------------------------------------------ */
/** New grid for a footprint of fw x fd tiles and h voxels of headroom. */
K.grid = (fw, fd, h) => new VC.VoxelGrid(fw * 8, h, fd * 8);

/**
 * Trims the grid height to its content. The renderer's construction animation and the
 * picking height use the grid height, so generators allocate generously and fit at the end.
 */
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

/** Mirrors a grid along X in place (cheap variant variety); emitters and lights follow. */
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

/** Copies grid s into g at (ox, oy, oz), rotated by rot quarter turns (0: s's +Z stays +Z, 1: -> +X, 2: -> -Z, 3: -> -X). */
K.pasteRot = (g, s, ox, oy, oz, rot = 0) => {
  rot &= 3;
  for (let y = 0; y < s.sy; y++)
    for (let z = 0; z < s.sz; z++)
      for (let x = 0; x < s.sx; x++) {
        const c = s.v[x + s.sx * (z + s.sz * y)];
        if (!c) continue;
        let dx, dz;
        if (rot === 0) { dx = x; dz = z; }
        else if (rot === 1) { dx = z; dz = s.sx - 1 - x; }
        else if (rot === 2) { dx = s.sx - 1 - x; dz = s.sz - 1 - z; }
        else { dx = s.sz - 1 - z; dz = x; }
        g.set(ox + dx, oy + y, oz + dz, c);
      }
  return g;
};

/* ------------------------------------------------------------------ */
/* Shapes                                                               */
/* ------------------------------------------------------------------ */
/** Annulus (r0 < d <= r1) around (cx, cz), from y to y+h. c may be fn(x,y,z,angle). */
K.ring = (g, cx, y, cz, r0, r1, h, c) => {
  const a2 = r0 * r0, b2 = r1 * r1, fn = typeof c === 'function';
  for (let z = Math.floor(cz - r1); z <= Math.ceil(cz + r1); z++)
    for (let x = Math.floor(cx - r1); x <= Math.ceil(cx + r1); x++) {
      const dx = x + 0.5 - cx, dz = z + 0.5 - cz, d2 = dx * dx + dz * dz;
      if (d2 > a2 && d2 <= b2)
        for (let yy = y; yy < y + h; yy++) g.set(x, yy, z, fn ? c(x, yy, z, Math.atan2(dz, dx)) : c);
    }
  return g;
};
/** Upper half-ellipsoid dome standing on plane y (radius r, height ry). */
K.dome = (g, cx, y, cz, r, c, ry = r) => {
  const fn = typeof c === 'function';
  for (let yy = y; yy < y + ry; yy++)
    for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = (x + 0.5 - cx) / r, dy = (yy + 0.5 - y) / ry, dz = (z + 0.5 - cz) / r;
        if (dx * dx + dy * dy + dz * dz <= 1) g.set(x, yy, z, fn ? c(x, yy, z) : c);
      }
  return g;
};
/** Solid cone (round) from radius r at y down to ~0 at y+h. */
K.cone = (g, cx, y, cz, r, h, c) => {
  for (let k = 0; k < h; k++) g.cyl(cx, y + k, cz, Math.max(0.5, r * (1 - k / h)), 1, c);
  return g;
};
/** n voxels evenly spaced on a circle (marquee bulbs, columns). */
K.dots = (g, cx, y, cz, r, n, c, phase = 0, h = 1) => {
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const x = Math.floor(cx + Math.cos(a) * r), z = Math.floor(cz + Math.sin(a) * r);
    for (let yy = y; yy < y + h; yy++) g.set(x, yy, z, c);
  }
  return g;
};
/** Thick 3D line (cube brush of size t). */
K.beam = (g, x0, y0, z0, x1, y1, z1, c, t = 1) => {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), 1);
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const x = Math.round(x0 + (x1 - x0) * f), y = Math.round(y0 + (y1 - y0) * f), z = Math.round(z0 + (z1 - z0) * f);
    if (t === 1) g.set(x, y, z, c);
    else g.box(x, y, z, t, t, t, c);
  }
  return g;
};
/** Box filled with diagonal hazard stripes. */
K.hazard = (g, x, y, z, w, h, d, a = P.HAZARD_Y, b = P.HAZARD_B) =>
  g.box(x, y, z, w, h, d, (xx, yy, zz) => (((xx + zz + yy) >> 1) & 1 ? b : a));
/** Checkerboard paving. */
K.checker = (g, x, y, z, w, d, a, b, cell = 2) =>
  g.box(x, y, z, w, 1, d, (xx, yy, zz) => ((((xx - x) / cell) | 0) + (((zz - z) / cell) | 0)) & 1 ? b : a);
/** Full-footprint ground plate at y = 0. */
K.lot = (g, c, h = 1) => g.box(0, 0, 0, g.sx, h, g.sz, c);

/* ------------------------------------------------------------------ */
/* Facades                                                              */
/* ------------------------------------------------------------------ */
// face -> (horizontal axis mapping, inward step)
function faceXZ(face, a, plane) {
  switch (face) {
    case 's': return [a, plane, 0, -1];
    case 'n': return [a, plane, 0, 1];
    case 'e': return [plane, a, -1, 0];
    default: return [plane, a, 1, 0]; // 'w'
  }
}
K.faceXZ = faceXZ;

/**
 * Window grid on the faces of the (already filled) box [x,x+w) x [y,y+h) x [z,z+d).
 * o: { win, floorH=3, winW=1, winH=2, gap=1, y0=1 (first row offset), top=1 (rows kept free at top),
 *      margin=1, faces='nsew', recess=true (1 voxel deep), ribbon=false (continuous band), sill }
 * Only replaces existing (solid) surface voxels, so it also works on shaped buildings.
 */
K.windows = (g, x, y, z, w, h, d, o = {}) => {
  const win = o.win || P.WIN, fh = o.floorH || 3, wh = o.winH || 2, ww = o.winW || 1;
  const gap = o.gap == null ? 1 : o.gap, y0 = o.y0 == null ? 1 : o.y0, top = o.top == null ? 1 : o.top;
  const mg = o.margin == null ? 1 : o.margin, faces = o.faces || 'nsew', rec = o.recess !== false;
  const cols = (len) => {
    const out = [], avail = len - 2 * mg;
    if (avail < ww) return out;
    if (o.ribbon) { for (let a = mg; a < len - mg; a++) out.push(a); return out; }
    const per = ww + gap, n = Math.floor((avail + gap) / per), used = n * per - gap;
    const off = mg + ((avail - used) >> 1);
    for (let i = 0; i < n; i++) for (let k = 0; k < ww; k++) out.push(off + i * per + k);
    return out;
  };
  const rows = [];
  for (let yy = y + y0; yy < y + h - top; yy++) if ((yy - y - y0) % fh < wh) rows.push(yy);
  const put = (face, a, yy, plane) => {
    const [sx, sz, ix, iz] = faceXZ(face, a, plane);
    if (!g.get(sx, yy, sz)) return;
    if (rec && g.get(sx + ix, yy, sz + iz)) {
      g.set(sx, yy, sz, 0);
      g.set(sx + ix, yy, sz + iz, win);
      if (o.sill && (yy - y - y0) % fh === 0) g.set(sx - ix, yy - 1, sz - iz, o.sill);
    } else g.set(sx, yy, sz, win);
  };
  const cx = cols(w), cz = cols(d);
  for (const yy of rows) {
    if (faces.includes('s')) for (const a of cx) put('s', x + a, yy, z + d - 1);
    if (faces.includes('n')) for (const a of cx) put('n', x + a, yy, z);
    if (faces.includes('e')) for (const a of cz) put('e', z + a, yy, x + w - 1);
    if (faces.includes('w')) for (const a of cz) put('w', z + a, yy, x);
  }
  return g;
};

/**
 * Flat-roofed block with windows. Returns the roof-top y (first free layer).
 * o: all K.windows options + { wall, roof (roof surface color), parapet (color), base (plinth color),
 *    baseH=1, band: [y, color] horizontal trim, noWin }
 */
K.block = (g, x, y, z, w, h, d, o = {}) => {
  g.box(x, y, z, w, h, d, o.wall || P.CONCRETE_L);
  if (o.base) g.walls(x, y, z, w, o.baseH || 1, d, o.base);
  if (o.bands) for (const [by, bc] of o.bands) g.walls(x, y + by, z, w, 1, d, bc);
  if (!o.noWin) K.windows(g, x, y, z, w, h, d, o);
  if (o.roof) g.box(x + 1, y + h - 1, z + 1, w - 2, 1, d - 2, o.roof);
  if (o.parapet) g.walls(x, y + h, z, w, 1, d, o.parapet);
  return y + h;
};

/** Recessed door (or any opening) of w x h on a face. plane = the surface voxel coordinate. */
K.door = (g, face, a, y, plane, w, h, c = P.GLASS_DARK) => {
  for (let i = 0; i < w; i++)
    for (let yy = y; yy < y + h; yy++) {
      const [sx, sz, ix, iz] = faceXZ(face, a + i, plane);
      g.set(sx, yy, sz, 0);
      g.set(sx + ix, yy, sz + iz, c);
    }
  return g;
};
/** Voxels proud of a face (signs, canopies): sets c on the plane in front of the surface. */
K.onFace = (g, face, a, y, plane, w, h, c) => {
  for (let i = 0; i < w; i++) for (let yy = y; yy < y + h; yy++) {
    const [sx, sz] = faceXZ(face, a + i, plane);
    g.set(sx, yy, sz, c);
  }
  return g;
};
/** Striped awning / canopy sticking out of the +Z face at plane z (depth voxels deep). */
K.awning = (g, x, y, z, w, depth, a, b = 0) => {
  for (let i = 0; i < w; i++) g.box(x + i, y, z, 1, 1, depth, b && i & 1 ? b : a);
  return g;
};
/** Parapet ring on top of a roof. */
K.parapet = (g, x, y, z, w, d, c) => g.walls(x, y, z, w, 1, d, c);
/** Steps descending toward +Z: n steps, top at y+n-1, starting at plane z. */
K.steps = (g, x, y, z, w, n, c) => {
  for (let i = 0; i < n; i++) g.box(x, y, z + i, w, n - i, 1, c);
  return g;
};
/** Classical pediment (flat triangle) on a face plane: slope = voxels inset per layer. */
K.pediment = (g, x, y, z, w, c, depth = 1, slope = 2) => {
  for (let k = 0; w - 2 * k * slope > 0; k++) g.box(x + k * slope, y + k, z, w - 2 * k * slope, 1, depth, c);
  return g;
};
/** Steep stepped spire / pyramid roof: each ring is `rise` voxels tall. */
K.spire = (g, x, y, z, w, d, c, rise = 2) => {
  for (let s = 0; w - 2 * s > 0 && d - 2 * s > 0; s++) g.box(x + s, y + s * rise, z + s, w - 2 * s, rise, d - 2 * s, c);
  return g;
};
/** Row of columns along X at plane z. */
K.columns = (g, x0, y, z, n, step, h, c, cap = 0) => {
  for (let i = 0; i < n; i++) {
    g.box(x0 + i * step, y, z, 1, h, 1, c);
    if (cap) g.set(x0 + i * step, y + h - 1, z, cap);
  }
  return g;
};

/** Random rooftop clutter (AC units, vents, skylights, tanks) on the free roof area. */
K.roofJunk = (g, x, y, z, w, d, rng, n = 3, kinds = 'avst') => {
  for (let t = 0, placed = 0; t < n * 6 && placed < n; t++) {
    const k = kinds[rng.int(0, kinds.length - 1)];
    const bw = k === 's' ? 2 : k === 't' ? 3 : 2, bd = k === 's' ? 3 : k === 't' ? 3 : 2;
    const px = rng.int(x + 1, x + w - bw - 1), pz = rng.int(z + 1, z + d - bd - 1);
    if (px < x || pz < z) continue;
    let free = true;
    for (let zz = pz - 1; zz <= pz + bd && free; zz++) for (let xx = px - 1; xx <= px + bw && free; xx++) if (g.get(xx, y, zz)) free = false;
    if (!free) continue;
    placed++;
    if (k === 'a') { g.box(px, y, pz, 2, 1, 2, P.METAL); g.set(px, y + 1, pz, P.METAL_D); }
    else if (k === 'v') { g.box(px, y, pz, 1, 2, 1, P.METAL_D); g.set(px + 1, y, pz + 1, P.PIPE); }
    else if (k === 's') g.box(px, y, pz, 2, 1, 3, P.GLASS_BLUE);
    else { g.cyl(px + 1.5, y, pz + 1.5, 1.4, 3, P.WOOD_D); g.cyl(px + 1.5, y + 3, pz + 1.5, 1.0, 1, P.ROOF_BLACK); }
  }
  return g;
};

/* ------------------------------------------------------------------ */
/* Pixel font (signs, runway numbers, scoreboards)                      */
/* ------------------------------------------------------------------ */
const FONT = {
  A: '.#.|#.#|###|#.#|#.#', B: '##.|#.#|##.|#.#|##.', C: '.##|#..|#..|#..|.##', D: '##.|#.#|#.#|#.#|##.',
  E: '###|#..|##.|#..|###', F: '###|#..|##.|#..|#..', G: '.##|#..|#.#|#.#|.##', H: '#.#|#.#|###|#.#|#.#',
  I: '#|#|#|#|#', J: '..#|..#|..#|#.#|.#.', K: '#.#|#.#|##.|#.#|#.#', L: '#..|#..|#..|#..|###',
  M: '#...#|##.##|#.#.#|#...#|#...#', N: '#..#|##.#|#.##|#..#|#..#', O: '.#.|#.#|#.#|#.#|.#.',
  P: '##.|#.#|##.|#..|#..', Q: '.#.|#.#|#.#|##.|.##', R: '##.|#.#|##.|#.#|#.#', S: '.##|#..|.#.|..#|##.',
  T: '###|.#.|.#.|.#.|.#.', U: '#.#|#.#|#.#|#.#|###', V: '#.#|#.#|#.#|#.#|.#.', W: '#...#|#...#|#.#.#|##.##|#...#',
  X: '#.#|#.#|.#.|#.#|#.#', Y: '#.#|#.#|.#.|.#.|.#.', Z: '###|..#|.#.|#..|###',
  0: '###|#.#|#.#|#.#|###', 1: '.#|##|.#|.#|.#', 2: '##.|..#|.#.|#..|###', 3: '##.|..#|.#.|..#|##.',
  4: '#.#|#.#|###|..#|..#', 5: '###|#..|##.|..#|##.', 6: '.##|#..|###|#.#|###', 7: '###|..#|.#.|.#.|.#.',
  8: '###|#.#|###|#.#|###', 9: '###|#.#|###|..#|##.', '-': '...|...|###|...|...', ':': '.|#|.|#|.',
  ' ': '..|..|..|..|..', '+': '...|.#.|###|.#.|...', '*': '..#..|.###.|#####|.###.|.#.#.',
  '$': '.##|##.|.#.|.##|##.', '!': '#|#|#|.|#', '.': '.|.|.|.|#',
};
const GLYPHS = {};
for (const ch in FONT) GLYPHS[ch] = FONT[ch].split('|');
K.glyph = (ch) => GLYPHS[ch] || GLYPHS[' '];
/** Width in voxels of a string (before scaling). */
K.textWidth = (str, spacing = 1) => {
  let w = 0;
  for (let i = 0; i < str.length; i++) w += K.glyph(str[i])[0].length + (i ? spacing : 0);
  return w;
};
/**
 * Draws text. face 's'/'n' (plane = z), 'e'/'w' (plane = x), 'top' (plane = y, readable from the front).
 * (cx, y, cz): horizontal center, bottom row y (or plane y for 'top'), plane coordinate.
 */
K.text = (g, str, cx, y, cz, c, face = 's', scale = 1, spacing = 1) => {
  const W = K.textWidth(str, spacing) * scale;
  let pen = 0;
  for (let i = 0; i < str.length; i++) {
    const gl = K.glyph(str[i]), gw = gl[0].length;
    for (let r = 0; r < 5; r++)
      for (let k = 0; k < gw; k++) {
        if (gl[r][k] !== '#') continue;
        for (let s1 = 0; s1 < scale; s1++)
          for (let s2 = 0; s2 < scale; s2++) {
            const u = (pen + k) * scale + s1; // along reading direction
            const v = (4 - r) * scale + s2; // up
            if (face === 's') g.set(Math.round(cx - W / 2) + u, y + v, cz, c);
            else if (face === 'n') g.set(Math.round(cx + W / 2) - 1 - u, y + v, cz, c);
            else if (face === 'e') g.set(cx, y + v, Math.round(cz + W / 2) - 1 - u, c);
            else if (face === 'w') g.set(cx, y + v, Math.round(cz - W / 2) + u, c);
            else g.set(Math.round(cx - W / 2) + u, y, Math.round(cz - (5 * scale) / 2) + r * scale + s2, c);
          }
      }
    pen += gw + spacing;
  }
  return g;
};

/** Clock face on a wall plane (voxel-centered at (cx, cy)); r ~ 2.3 gives a round 5x5 dial. */
K.clock = (g, face, ca, cy, plane, r = 2.3, rim = P.GOLD, dial = P.WHITE, hands = P.BLACK) => {
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy++)
    for (let da = -R; da <= R; da++) {
      const d = Math.hypot(da, dy);
      if (d > r) continue;
      const [x, z] = faceXZ(face, ca + (face === 'n' || face === 'e' ? -da : da), plane);
      g.set(x, cy + dy, z, d > r - 0.95 && r >= 2 ? rim : dial);
    }
  const hand = (da, dy) => {
    const [x, z] = faceXZ(face, ca + (face === 'n' || face === 'e' ? -da : da), plane);
    g.set(x, cy + dy, z, hands);
  };
  hand(0, 0);
  hand(0, 1);
  if (r > 2) hand(1, 0);
  return g;
};
/** Plus / cross symbol on a face plane (arm = half length, t = thickness). */
K.cross = (g, face, ca, cy, plane, arm, t, c) => {
  const h = (t - 1) >> 1;
  for (let dy = -arm; dy <= arm; dy++)
    for (let da = -arm; da <= arm; da++) {
      if (Math.abs(da) > h && Math.abs(dy) > h) continue;
      const [x, z] = faceXZ(face, ca + da, plane);
      g.set(x, cy + dy, z, c);
    }
  return g;
};

/* ------------------------------------------------------------------ */
/* Lights                                                               */
/* ------------------------------------------------------------------ */
K.LC = {
  warm: [1, 0.78, 0.45], white: [0.85, 0.92, 1], red: [1, 0.12, 0.08], cyan: [0.2, 0.95, 1], green: [0.3, 1, 0.45],
  blue: [0.25, 0.45, 1], pink: [1, 0.3, 0.75], purple: [0.72, 0.35, 1], yellow: [1, 0.86, 0.3], orange: [1, 0.5, 0.12],
};
/** Street lamp: post + glowing head + night light sprite. */
K.lamp = (g, x, y, z, h = 4, head = P.LAMP, post = P.METAL_D, size = 0.8) => {
  g.box(x, y, z, 1, h - 1, 1, post);
  g.set(x, y + h - 1, z, head);
  g.light(x + 0.5, y + h - 0.4, z + 0.5, head === P.LAMP_WHITE ? K.LC.white : K.LC.warm, size);
  return g;
};
/** Blinking aviation beacon (always visible). */
K.beacon = (g, x, y, z, size = 0.9) => {
  g.set(x, y, z, P.BEACON_RED);
  g.light(x + 0.5, y + 0.6, z + 0.5, K.LC.red, size, true);
  return g;
};

/* ------------------------------------------------------------------ */
/* Nature & street furniture                                             */
/* ------------------------------------------------------------------ */
/**
 * Small voxel tree planted at voxel (x, y, z). kind: oak | pine | birch | bush | palm | cypress | blossom.
 * s scales the crown. leaf overrides the crown color.
 */
K.tree = (g, x, y, z, kind = 'oak', s = 1, leaf = 0) => {
  const cx = x + 0.5, cz = z + 0.5;
  if (kind === 'pine') {
    g.box(x, y, z, 1, 2, 1, P.TRUNK);
    const h = Math.round(6 * s + 2);
    for (let k = 0; k < h; k++) {
      const r = (2.4 * s + 0.3) * (1 - k / h) + 0.35;
      g.cyl(cx, y + 1 + k, cz, r, 1, leaf || (k & 2 ? P.PINE : P.PINE_D));
    }
  } else if (kind === 'birch') {
    const t = Math.round(3 * s + 1);
    g.box(x, y, z, 1, t, 1, P.TRUNK_BIRCH);
    g.ellipsoid(cx, y + t + 1.5 * s, cz, 1.5 * s + 0.3, 2.3 * s + 0.3, 1.5 * s + 0.3, leaf || P.BIRCH_LEAF);
  } else if (kind === 'bush') {
    g.ellipsoid(cx, y + 0.6 * s, cz, 1.3 * s + 0.2, 1.1 * s + 0.2, 1.3 * s + 0.2, leaf || P.HEDGE);
  } else if (kind === 'palm') {
    const t = Math.round(5 * s + 1);
    for (let k = 0; k < t; k++) g.set(x + (k > t * 0.6 ? 1 : 0), y + k, z, P.TRUNK);
    const tx = x + (t > 2 ? 1 : 0), ty = y + t;
    const L = Math.round(2 * s + 1), c = leaf || P.PALM;
    g.set(tx, ty, z, c);
    for (let k = 1; k <= L; k++) {
      const dy = k === L ? -1 : 0;
      g.set(tx + k, ty + dy, z, c); g.set(tx - k, ty + dy, z, c);
      g.set(tx, ty + dy, z + k, c); g.set(tx, ty + dy, z - k, c);
    }
    g.set(tx, ty + 1, z, c);
  } else if (kind === 'cypress') {
    g.set(x, y, z, P.TRUNK);
    g.ellipsoid(cx, y + 1 + 2.6 * s, cz, 1.2 * s + 0.2, 2.9 * s + 0.3, 1.2 * s + 0.2, leaf || P.PINE);
  } else {
    // oak / blossom: round crown
    const t = Math.round(2 * s + 1), r = 1.8 * s + 0.45;
    g.box(x, y, z, 1, t, 1, P.TRUNK);
    g.sphere(cx, y + t + r - 0.6, cz, r, leaf || (kind === 'blossom' ? P.FLOWER_P : P.LEAF));
  }
  return g;
};
/** Bench (seat + backrest) of length len along X (back toward -Z) or along Z (axis 'z', back toward -X). */
K.bench = (g, x, y, z, axis = 'x', len = 2) => {
  if (axis === 'x') { g.box(x, y, z + 1, len, 1, 1, P.WOOD); g.box(x, y, z, len, 2, 1, P.WOOD_D); }
  else { g.box(x + 1, y, z, 1, 1, len, P.WOOD); g.box(x, y, z, 1, 2, len, P.WOOD_D); }
  return g;
};
/** Flag pole (height h) with a 3x2 flag pointing +X (dir 'x') or +Z (dir 'z'). cols = [top, bottom]. */
K.flag = (g, x, y, z, h, cols = [P.BLUE, P.YELLOW], dir = 'x') => {
  g.box(x, y, z, 1, h, 1, P.WHITE);
  g.set(x, y + h, z, P.GOLD);
  for (let k = 1; k <= 3; k++) {
    const fx = dir === 'x' ? x + k : x, fz = dir === 'x' ? z : z + k;
    g.set(fx, y + h - 1, fz, cols[0]);
    g.set(fx, y + h - 2, fz, cols[1] || cols[0]);
  }
  return g;
};
/**
 * Fence around the rectangle [x0..x1] x [z0..z1] (inclusive) at height y.
 * o: { h=2, step=2 (post spacing), skip(x,z) -> true for gate gaps, post (color) }
 */
K.fence = (g, x0, z0, x1, z1, y, c, o = {}) => {
  const h = o.h || 2, step = o.step || 2, post = o.post || c;
  let i = 0;
  const at = (x, z) => {
    if (o.skip && o.skip(x, z)) { i++; return; }
    g.set(x, y + h - 1, z, c);
    if (i % step === 0) g.box(x, y, z, 1, h, 1, post);
    i++;
  };
  for (let x = x0; x <= x1; x++) at(x, z0);
  for (let z = z0 + 1; z <= z1; z++) at(x1, z);
  for (let x = x1 - 1; x >= x0; x--) at(x, z1);
  for (let z = z1 - 1; z > z0; z--) at(x0, z);
  return g;
};
/** Flower bed: rows of colors (neat, mesher friendly) with a hedge/soil rim. */
K.flowers = (g, x, y, z, w, d, cols = [P.FLOWER_R, P.FLOWER_Y, P.FLOWER_P], rim = 0) => {
  if (rim) g.box(x - 1, y, z - 1, w + 2, 1, d + 2, rim);
  for (let zz = 0; zz < d; zz++) g.box(x, y, z + zz, w, 1, 1, cols[zz % cols.length]);
  return g;
};
/** Rectangular pool: rim + water surface one voxel below the rim top. */
K.pool = (g, x, y, z, w, d, rim, water = P.WATER, rimH = 2) => {
  g.box(x, y, z, w, rimH, d, rim);
  g.box(x + 1, y + rimH - 1, z + 1, w - 2, 1, d - 2, water);
  return g;
};

/* ------------------------------------------------------------------ */
/* Vehicles — built in a local grid (front = +Z) and pasted rotated      */
/* ------------------------------------------------------------------ */
const vehCache = new Map();
function veh(type, a, b) {
  const key = type + ':' + (a || 0) + ':' + (b || 0);
  let s = vehCache.get(key);
  if (s) return s;
  const V = (w, h, d) => (s = new VC.VoxelGrid(w, h, d));
  switch (type) {
    case 'car': { // a body color
      V(2, 2, 4);
      s.box(0, 0, 0, 2, 1, 4, a || P.CAR_RED);
      s.box(0, 1, 1, 2, 1, 2, P.GLASS_DARK);
      break;
    }
    case 'police': {
      V(2, 3, 4);
      s.box(0, 0, 0, 2, 1, 4, P.CAR_WHITE);
      s.box(0, 0, 1, 2, 1, 2, P.CAR_BLACK);
      s.box(0, 1, 1, 2, 1, 2, P.CAR_WHITE);
      s.set(0, 2, 2, P.NEON_RED); s.set(1, 2, 2, P.NEON_BLUE);
      break;
    }
    case 'ambulance': {
      V(2, 3, 5);
      s.box(0, 0, 0, 2, 1, 5, P.CAR_WHITE);
      s.box(0, 1, 0, 2, 1, 4, P.RED);
      s.set(0, 1, 4, P.GLASS_DARK); s.set(1, 1, 4, P.GLASS_DARK);
      s.box(0, 2, 0, 2, 1, 4, P.CAR_WHITE);
      s.set(0, 2, 3, P.NEON_RED); s.set(1, 2, 3, P.NEON_BLUE);
      break;
    }
    case 'firetruck': { // a = with ladder
      V(3, 3, 7);
      s.box(0, 0, 0, 3, 2, 7, P.CAR_RED);
      for (const zz of [1, 5]) { s.set(0, 0, zz, P.TIRE); s.set(2, 0, zz, P.TIRE); }
      s.box(0, 1, 0, 1, 1, 5, P.WHITE); s.box(2, 1, 0, 1, 1, 5, P.WHITE);
      s.box(0, 1, 6, 3, 1, 1, P.GLASS_DARK);
      s.box(0, 2, 5, 3, 1, 2, P.CAR_RED);
      s.set(0, 2, 6, P.NEON_RED); s.set(2, 2, 6, P.NEON_RED);
      s.box(0, 0, 6, 3, 1, 1, P.CHROME);
      if (a) s.box(1, 2, 0, 1, 1, 5, P.CHROME);
      else {
        s.box(0, 2, 0, 3, 1, 5, P.CAR_RED);
        s.box(1, 2, 1, 1, 1, 3, P.CHROME);
      }
      break;
    }
    case 'bus': { // a body, b stripe/roof
      V(2, 3, 8);
      s.box(0, 0, 0, 2, 1, 8, a || P.CAR_BLUE);
      for (const zz of [1, 6]) { s.set(0, 0, zz, P.TIRE); s.set(1, 0, zz, P.TIRE); }
      s.box(0, 1, 0, 2, 1, 8, P.GLASS_DARK);
      s.box(0, 2, 0, 2, 1, 8, b || a || P.CAR_WHITE);
      s.set(0, 0, 7, P.HEADLIGHT); s.set(1, 0, 7, P.HEADLIGHT);
      break;
    }
    case 'truck': { // a cab, b box
      V(2, 3, 6);
      s.box(0, 0, 0, 2, 3, 4, b || P.WHITE);
      s.box(0, 0, 4, 2, 2, 2, a || P.CAR_BLUE);
      s.box(0, 1, 5, 2, 1, 1, P.GLASS_DARK);
      s.set(0, 0, 1, P.TIRE); s.set(1, 0, 1, P.TIRE);
      break;
    }
    case 'bulldozer': {
      V(3, 3, 5);
      s.box(0, 0, 0, 3, 1, 4, P.TIRE);
      s.box(0, 1, 0, 3, 1, 4, P.HAZARD_Y);
      s.box(1, 2, 0, 1, 1, 2, P.GLASS_DARK);
      s.box(0, 0, 4, 3, 2, 1, P.METAL_D);
      s.set(2, 2, 0, P.METAL_D);
      break;
    }
    case 'heli': { // a body, b stripe
      V(9, 4, 11);
      s.box(3, 0, 3, 1, 1, 5, P.METAL_D); s.box(5, 0, 3, 1, 1, 5, P.METAL_D);
      s.box(3, 1, 3, 3, 2, 5, a || P.NAVY);
      s.box(3, 1, 5, 3, 1, 2, b || P.WHITE);
      s.box(3, 2, 7, 3, 1, 1, P.GLASS_DARK);
      s.box(4, 2, 0, 1, 1, 3, a || P.NAVY);
      s.box(4, 3, 0, 1, 1, 1, b || P.WHITE);
      s.box(0, 3, 5, 9, 1, 1, P.METAL_D); s.box(4, 3, 1, 1, 1, 9, P.METAL_D);
      break;
    }
    case 'jet': { // a tail/livery color
      V(12, 5, 12);
      const L = a || P.BLUE;
      s.box(5, 1, 1, 2, 2, 10, P.WHITE);
      s.box(5, 1, 11, 2, 1, 1, P.WHITE);
      s.box(5, 2, 10, 2, 1, 1, P.GLASS_DARK);
      s.box(5, 1, 3, 2, 1, 6, L); // cheat line
      s.box(5, 2, 0, 2, 1, 1, P.WHITE);
      for (let k = 1; k <= 5; k++) {
        const zz = 6 - Math.ceil(k / 2);
        s.box(5 - k, 1, zz, 1, 1, 2, P.CAR_SILVER);
        s.box(6 + k, 1, zz, 1, 1, 2, P.CAR_SILVER);
      }
      s.box(3, 0, 5, 1, 1, 2, P.METAL_D); s.box(8, 0, 5, 1, 1, 2, P.METAL_D);
      s.box(3, 2, 1, 6, 1, 1, P.CAR_SILVER);
      s.box(5, 3, 0, 2, 1, 3, L); s.box(5, 4, 0, 2, 1, 2, L);
      break;
    }
    case 'container': { // a color, 6 long
      V(3, 3, 6);
      s.box(0, 0, 0, 3, 3, 6, a || P.CONTAINER_R);
      s.box(0, 2, 0, 3, 1, 6, b || a || P.CONTAINER_R);
      break;
    }
    default:
      V(1, 1, 1);
      s.set(0, 0, 0, P.PINK);
  }
  vehCache.set(key, s);
  return s;
}
K.VEH = veh;
/**
 * Stamps a vehicle. (x, z) = min corner of the rotated footprint, rot: 0 front +Z, 1 +X, 2 -Z, 3 -X.
 * Types: car(a=color) police ambulance firetruck(a=ladder) bus(a=body,b=roof) truck(a=cab,b=box)
 * bulldozer heli(a=body,b=stripe) jet(a=livery) container(a=color).
 */
K.vehicle = (g, type, x, y, z, rot = 0, a = 0, b = 0) => K.pasteRot(g, veh(type, a, b), x, y, z, rot);
/** Footprint [w, d] of a vehicle type at rotation rot. */
K.vehSize = (type, rot = 0) => {
  const s = veh(type, 0, 0);
  return rot & 1 ? [s.sz, s.sx] : [s.sx, s.sz];
};
/** Parking lot: asphalt with painted bay lines and optional parked cars (along X, bays of 3). */
K.parking = (g, x, y, z, w, d, rng, fill = 0.6, cols = null) => {
  g.box(x, y, z, w, 1, d, P.ASPHALT);
  const palette = cols || [P.CAR_RED, P.CAR_BLUE, P.CAR_WHITE, P.CAR_BLACK, P.CAR_SILVER, P.CAR_YELLOW, P.CAR_GREEN];
  for (let bx = x; bx + 2 <= x + w; bx += 3) {
    if (bx > x) g.box(bx - 1, y, z, 1, 1, Math.min(2, d), P.ROAD_MARK);
    if (d >= 4 && rng() < fill) K.vehicle(g, 'car', bx, y + 1, z, 0, rng.pick(palette));
  }
  return g;
};
