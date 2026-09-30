/*
 * VOXELPOLIS — voxel engine: palette, VoxelGrid authoring API, greedy mesher with
 * ambient occlusion, LOD downsampling, and the MODEL REGISTRY.
 *
 * ---------------------------------------------------------------------------
 * PALETTE: 256 entries (index 0 = empty). Each entry = sRGB color + material flags:
 *   VC.MAT.WINDOW  1   dark glass by day; randomly lit (warm/cool) at night
 *   VC.MAT.GLASS   2   specular / reflective
 *   VC.MAT.EMISSIVE 4  always glowing (neon, signs, reactor) — blooms
 *   VC.MAT.FOLIAGE 8   sways in wind, seasonal tint (autumn/winter)
 *   VC.MAT.METAL  16   specular metal
 *   VC.MAT.WATER  32   animated water surface (pools, fountains)
 *   VC.MAT.NIGHTLIGHT 64  emissive only at night (lamps, floodlights, headlights)
 *   VC.MAT.NOSNOW 128  never gets snow on top
 * Named colors: VC.P.CONCRETE etc. Custom colors: VC.voxel.color('#rrggbb', flags) -> index.
 * The palette is also a 256x1 RGBA8 texture: VC.voxel.paletteTexture() (rgb = sRGB, a = flags).
 *
 * ---------------------------------------------------------------------------
 * MESH VERTEX FORMAT (8 bytes/vertex, 4 vertices/quad, draw with VC.gfx.quadIndexBuffer):
 *   location 0: aPos  int16 x3  (voxel-corner coords, NOT normalized -> vec3 floats)
 *   location 1: aInfo uint8 x2  (vertexAttribIPointer -> uvec2):
 *                 .x = palette index, .y = normal (bits 0-2: 0 +X,1 -X,2 +Y,3 -Y,4 +Z,5 -Z) | ao << 3 (0..3, 3 = open)
 *   Locations 2..7 are free for per-instance attributes (set by the renderer).
 *
 * ---------------------------------------------------------------------------
 * MODEL REGISTRY:
 *   VC.models.define(key, {
 *     variants: 4,                         // number of distinct variants
 *     scale: 1,                            // voxel size multiplier (0.5 for vehicles: 1/16 unit voxels)
 *     gen(rng, variant, params) { ... return grid; },   // build and return a VoxelGrid
 *     parts: [{ model:'wind_rotor', pivot:[x,y,z], partPivot:[x,y,z], axis:'x'|'y'|'z', speed: radPerSec }],
 *     sized: false,                        // true: forBuilding passes params {fw, fd} (e.g. 'rubble')
 *   })
 *   PARTS: an animated sub-model. pivot = attachment point in the PARENT grid (voxels);
 *   partPivot = rotation center in the PART grid (voxels). Renderer draws the part with
 *   world = parentTransform * T(pivot) * Rot(axis, time*speed [* wind for anim 'wind']) * T(-partPivot).
 *   VC.models.get(key, variant, params) -> Model (generated, meshed, uploaded on first use; cached)
 *   Model = { key, variant, params, sx, sy, sz, vox, height, quads, vao, vbo, lod:{quads,vao,vbo},
 *             emitters:[{x,y,z,type}], lights:[{x,y,z,color,size}], parts }
 *
 * BUILDING MODEL CONVENTIONS:
 *   - A building of unrotated footprint fw x fd tiles is a grid of exactly (fw*8) x H x (fd*8) voxels.
 *   - y = 0 is the ground (tile top). The FRONT/entrance faces +Z (the z = fd*8 side).
 *   - Growables: key 'grow_' + zone key + density, e.g. 'grow_R1', 'grow_C3', 'grow_I2';
 *     params = { fw, fd, level (1..3), wealth (0..2) }.
 *   - Catalog buildings: key = VC.BLD key (e.g. 'coal_plant'); params = {}.
 *   - Trees: 'tree_oak','tree_pine','tree_birch','tree_palm','tree_bush' (8x8 footprint max).
 *   - Props: 'rubble' (params {fw,fd}), 'streetlamp', etc. Vehicles: 'car','bus','truck', ...
 *
 * INSTANCE TRANSFORM (shared by renderer, particles, picking):
 *   world = footprintCenter + rotY(rot) * ((p - [fw*4, 0, fd*4]) * vox)
 *   footprintCenter = [b.x + b.w/2, groundY, b.z + b.d/2]; rotY(q): x' = x*c + z*s, z' = -x*s + z*c, angle = q*90deg
 *   (rot 0: front faces +Z, 1: +X, 2: -Z, 3: -X). See VC.models.localToWorld.
 */
const M = VC.M;

/* ------------------------------------------------------------------ */
/* Palette                                                              */
/* ------------------------------------------------------------------ */
const MAT = (VC.MAT = { WINDOW: 1, GLASS: 2, EMISSIVE: 4, FOLIAGE: 8, METAL: 16, WATER: 32, NIGHTLIGHT: 64, NOSNOW: 128 });
const PAL = new Uint8Array(256 * 4);
const P = (VC.P = {});
let palCount = 1;
let palVersion = 1;
function palAdd(name, hex, flags = 0) {
  const c = VC.color.rgb(hex);
  const i = palCount++;
  PAL[i * 4] = Math.round(c[0] * 255);
  PAL[i * 4 + 1] = Math.round(c[1] * 255);
  PAL[i * 4 + 2] = Math.round(c[2] * 255);
  PAL[i * 4 + 3] = flags;
  if (name) P[name] = i;
  return i;
}
const E = MAT.EMISSIVE | MAT.NOSNOW, N = MAT.NIGHTLIGHT | MAT.NOSNOW;
[
  // structure
  ['CONCRETE', '#b8b4ac'], ['CONCRETE_L', '#d8d4ca'], ['CONCRETE_D', '#86827c'], ['CONCRETE_DD', '#5e5b57'],
  ['ASPHALT', '#3a3c40'], ['SIDEWALK', '#b4b0a8'], ['ROAD_MARK', '#f4f0e0'],
  ['BRICK', '#a0503a'], ['BRICK_D', '#7a3a2a'], ['BRICK_L', '#c07050'], ['BRICK_Y', '#c9a66b'],
  ['STONE', '#9a958c'], ['STONE_D', '#6e6a64'], ['MARBLE', '#eeeae2'], ['SANDSTONE', '#d8c08a'],
  ['WOOD', '#9a6a3a'], ['WOOD_D', '#6a4424'], ['WOOD_L', '#c49a64'],
  ['PLASTER', '#f0ece0'], ['PLASTER_CREAM', '#efe0bc'], ['PLASTER_PEACH', '#f2c6a0'], ['PLASTER_MINT', '#bfe0c8'],
  ['PLASTER_SKY', '#bcd6ea'], ['PLASTER_PINK', '#f0c0c8'], ['PLASTER_LEMON', '#f2e6a0'], ['PLASTER_LILAC', '#d4c4e8'],
  // roofs
  ['ROOF_RED', '#b03a2e'], ['ROOF_TERRA', '#c8643c'], ['ROOF_BROWN', '#6e4630'], ['ROOF_GREY', '#5a5e66'],
  ['ROOF_SLATE', '#3e4450'], ['ROOF_GREEN', '#3e7a52'], ['ROOF_BLUE', '#3a5a8a'], ['ROOF_BLACK', '#26282c'], ['ROOF_TEAL', '#2f7d7d'],
  // metals
  ['METAL', '#9aa4ae', MAT.METAL], ['METAL_D', '#5a6068', MAT.METAL], ['STEEL_BLUE', '#50708e', MAT.METAL], ['RUST', '#9a5a32'],
  ['COPPER_GREEN', '#5fa08a', MAT.METAL], ['GOLD', '#e8b830', MAT.METAL], ['CHROME', '#d8dee4', MAT.METAL],
  // glass
  ['GLASS_BLUE', '#3a6a9a', MAT.GLASS], ['GLASS_TEAL', '#2a7a7a', MAT.GLASS], ['GLASS_DARK', '#1e2a38', MAT.GLASS],
  ['GLASS_GOLD', '#b89040', MAT.GLASS], ['GLASS_GREEN', '#3a7a5a', MAT.GLASS], ['GLASS_CYAN', '#5ab0d0', MAT.GLASS],
  // windows (lit at night)
  ['WIN', '#2a3444', MAT.WINDOW], ['WIN_COOL', '#28384a', MAT.WINDOW], ['WIN_OFFICE', '#34506a', MAT.WINDOW | MAT.GLASS],
  ['WIN_SHOP', '#3a4a5a', MAT.WINDOW | MAT.GLASS],
  // emissive
  ['NEON_PINK', '#ff3cac', E], ['NEON_CYAN', '#2ef2ff', E], ['NEON_YELLOW', '#ffe23a', E], ['NEON_GREEN', '#4dff6a', E],
  ['NEON_RED', '#ff3030', E], ['NEON_BLUE', '#3a6aff', E], ['NEON_ORANGE', '#ff8a1a', E], ['NEON_PURPLE', '#b04dff', E],
  ['SIGN_WHITE', '#ffffff', E], ['BEACON_RED', '#ff2020', E], ['FIRE', '#ff7a20', E], ['GLOW_REACTOR', '#5affd0', E],
  ['LAMP', '#ffd890', N], ['LAMP_WHITE', '#eef4ff', N], ['HEADLIGHT', '#fff4d0', N], ['TAILLIGHT', '#ff2a2a', N],
  // nature
  ['GRASS', '#5a9a3a'], ['GRASS_D', '#3e7a2a'], ['GRASS_L', '#7ab84a'],
  ['LEAF', '#3e8a34', MAT.FOLIAGE], ['LEAF_D', '#2a6a2a', MAT.FOLIAGE], ['LEAF_L', '#6aaa3a', MAT.FOLIAGE], ['LEAF_Y', '#a8b83a', MAT.FOLIAGE],
  ['PINE', '#2a5a3a', MAT.FOLIAGE], ['PINE_D', '#1e4a30', MAT.FOLIAGE], ['BIRCH_LEAF', '#8ac04a', MAT.FOLIAGE], ['PALM', '#4a9a3a', MAT.FOLIAGE],
  ['HEDGE', '#3a7a34', MAT.FOLIAGE], ['TRUNK', '#6a4a2a'], ['TRUNK_BIRCH', '#e0dccc'],
  ['FLOWER_R', '#e83a4a'], ['FLOWER_Y', '#f8d83a'], ['FLOWER_P', '#e87ab8'], ['FLOWER_V', '#9a5ad8'], ['FLOWER_W', '#f4f4f4'],
  ['SOIL', '#6a4a30'], ['SAND', '#dcc890'], ['ROCK', '#7e7a74'],
  ['WATER', '#3a8ac8', MAT.WATER | MAT.NOSNOW], ['WATER_POOL', '#4ac0e0', MAT.WATER | MAT.NOSNOW],
  // paint
  ['RED', '#d23a3a'], ['ORANGE', '#ee7a2a'], ['YELLOW', '#f2c230'], ['GREEN', '#3aa64a'], ['BLUE', '#2a6ad2'],
  ['PURPLE', '#8a4ad2'], ['PINK', '#ea6aa8'], ['WHITE', '#f4f4f0'], ['BLACK', '#202226'], ['GREY', '#7a7e84'],
  ['BROWN', '#7a5234'], ['NAVY', '#22345a'], ['CREAM', '#f4e8c8'],
  // vehicles
  ['CAR_RED', '#c8282a', MAT.METAL], ['CAR_BLUE', '#2856b8', MAT.METAL], ['CAR_WHITE', '#e8e8e8', MAT.METAL], ['CAR_BLACK', '#222428', MAT.METAL],
  ['CAR_SILVER', '#aab2ba', MAT.METAL], ['CAR_YELLOW', '#f0c020', MAT.METAL], ['CAR_GREEN', '#2a8a4a', MAT.METAL], ['TIRE', '#1a1a1c'],
  // industrial
  ['HAZARD_Y', '#f0c000'], ['HAZARD_B', '#202020'], ['TANK_WHITE', '#e4e4dc'], ['PIPE', '#8a8e94', MAT.METAL],
  ['CHIMNEY', '#9a8a80'], ['CHIMNEY_RED', '#b04030'], ['SOLAR', '#1e3a6a', MAT.GLASS | MAT.METAL],
  ['CONTAINER_R', '#b83a2a'], ['CONTAINER_B', '#2a5aa0'], ['CONTAINER_G', '#3a8a4a'], ['CONTAINER_O', '#d8782a'],
  // sports / leisure
  ['FIELD_GREEN', '#3aa040'], ['FIELD_LINE', '#f4f4f4'], ['TRACK_RED', '#b84a3a'], ['COURT_BLUE', '#3a6ab0'],
  ['AWNING_R', '#d04040'], ['AWNING_G', '#3a9a5a'], ['AWNING_B', '#3a6ab8'], ['AWNING_Y', '#e8c040'],
  ['SNOW', '#f4f8ff'],
].forEach(([n, hex, f]) => palAdd(n, hex, f || 0));

const customMap = new Map();

/* ------------------------------------------------------------------ */
/* VoxelGrid                                                            */
/* ------------------------------------------------------------------ */
class VoxelGrid {
  /** sx, sy, sz in voxels. Voxel value 0 = empty, else palette index. */
  constructor(sx, sy, sz) {
    this.sx = sx | 0;
    this.sy = sy | 0;
    this.sz = sz | 0;
    this.v = new Uint8Array(this.sx * this.sy * this.sz);
    this.emitters = [];
    this.lights = [];
    this.meta = {};
  }
  idx(x, y, z) {
    return x + this.sx * (z + this.sz * y);
  }
  inb(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }
  get(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz ? this.v[x + this.sx * (z + this.sz * y)] : 0;
  }
  set(x, y, z, c) {
    x |= 0; y |= 0; z |= 0;
    if (x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz) this.v[x + this.sx * (z + this.sz * y)] = c;
    return this;
  }
  /** Fills [x,x+w) x [y,y+h) x [z,z+d). c = palette index or fn(x,y,z) -> index (0 erases). */
  box(x, y, z, w, h, d, c) {
    x |= 0; y |= 0; z |= 0; w |= 0; h |= 0; d |= 0;
    const x0 = Math.max(0, x), y0 = Math.max(0, y), z0 = Math.max(0, z);
    const x1 = Math.min(this.sx, x + w), y1 = Math.min(this.sy, y + h), z1 = Math.min(this.sz, z + d);
    const fn = typeof c === 'function';
    for (let yy = y0; yy < y1; yy++)
      for (let zz = z0; zz < z1; zz++) {
        let i = x0 + this.sx * (zz + this.sz * yy);
        for (let xx = x0; xx < x1; xx++, i++) this.v[i] = fn ? c(xx, yy, zz) | 0 : c;
      }
    return this;
  }
  /** Only the outer shell of the box. */
  hollow(x, y, z, w, h, d, c) {
    this.box(x, y, z, w, h, d, c);
    if (w > 2 && h > 2 && d > 2) this.box(x + 1, y + 1, z + 1, w - 2, h - 2, d - 2, 0);
    return this;
  }
  /** Four vertical walls (no floor/ceiling). */
  walls(x, y, z, w, h, d, c) {
    this.box(x, y, z, w, h, 1, c);
    this.box(x, y, z + d - 1, w, h, 1, c);
    this.box(x, y, z, 1, h, d, c);
    this.box(x + w - 1, y, z, 1, h, d, c);
    return this;
  }
  /** Vertical cylinder centered on (cx, cz) (floats ok), from y to y+h. */
  cyl(cx, y, cz, r, h, c) {
    const r2 = r * r;
    for (let zz = Math.floor(cz - r); zz <= Math.ceil(cz + r); zz++)
      for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
        const dx = xx + 0.5 - cx, dz = zz + 0.5 - cz;
        if (dx * dx + dz * dz <= r2) for (let yy = y; yy < y + h; yy++) this.set(xx, yy, zz, typeof c === 'function' ? c(xx, yy, zz) : c);
      }
    return this;
  }
  /** Horizontal cylinder along axis 'x' or 'z' centered at (cy, cc) in the other two axes. */
  hcyl(axis, a0, len, cy, cc, r, c) {
    const r2 = r * r;
    for (let a = a0; a < a0 + len; a++)
      for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++)
        for (let q = Math.floor(cc - r); q <= Math.ceil(cc + r); q++) {
          const dy = yy + 0.5 - cy, dq = q + 0.5 - cc;
          if (dy * dy + dq * dq <= r2) {
            const col = typeof c === 'function' ? c(a, yy, q) : c;
            if (axis === 'x') this.set(a, yy, q, col);
            else this.set(q, yy, a, col);
          }
        }
    return this;
  }
  sphere(cx, cy, cz, r, c) {
    const r2 = r * r;
    for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++)
      for (let zz = Math.floor(cz - r); zz <= Math.ceil(cz + r); zz++)
        for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
          const dx = xx + 0.5 - cx, dy = yy + 0.5 - cy, dz = zz + 0.5 - cz;
          if (dx * dx + dy * dy + dz * dz <= r2) this.set(xx, yy, zz, typeof c === 'function' ? c(xx, yy, zz) : c);
        }
    return this;
  }
  /** Ellipsoid with radii rx, ry, rz. */
  ellipsoid(cx, cy, cz, rx, ry, rz, c) {
    for (let yy = Math.floor(cy - ry); yy <= Math.ceil(cy + ry); yy++)
      for (let zz = Math.floor(cz - rz); zz <= Math.ceil(cz + rz); zz++)
        for (let xx = Math.floor(cx - rx); xx <= Math.ceil(cx + rx); xx++) {
          const dx = (xx + 0.5 - cx) / rx, dy = (yy + 0.5 - cy) / ry, dz = (zz + 0.5 - cz) / rz;
          if (dx * dx + dy * dy + dz * dz <= 1) this.set(xx, yy, zz, typeof c === 'function' ? c(xx, yy, zz) : c);
        }
    return this;
  }
  /** 3D line of voxels. */
  line(x0, y0, z0, x1, y1, z1, c) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), 1);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      this.set(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), Math.round(z0 + (z1 - z0) * t), c);
    }
    return this;
  }
  /** Gable roof over [x,x+w) x [z,z+d) starting at height y; ridge runs along `axis` ('x' or 'z'). */
  roofGable(x, y, z, w, d, c, axis = 'x', overhang = 0, gableC = 0) {
    const span = axis === 'x' ? d : w;
    const half = Math.ceil(span / 2);
    for (let s = 0; s < half; s++) {
      const yy = y + s;
      if (axis === 'x') {
        this.box(x - overhang, yy, z + s - overhang * (s === 0 ? 1 : 0), w + overhang * 2, 1, 1 + (s === 0 ? overhang : 0), c);
        this.box(x - overhang, yy, z + d - 1 - s, w + overhang * 2, 1, 1 + (s === 0 ? overhang : 0), c);
        if (gableC && s > 0) { this.box(x, yy, z + s, 1, 1, d - 2 * s, gableC); this.box(x + w - 1, yy, z + s, 1, 1, d - 2 * s, gableC); }
        if (d - 2 * s > 2) this.box(x, yy, z + s + 1, w, 1, d - 2 * s - 2, gableC || c);
      } else {
        this.box(x + s - overhang * (s === 0 ? 1 : 0), yy, z - overhang, 1 + (s === 0 ? overhang : 0), 1, d + overhang * 2, c);
        this.box(x + w - 1 - s, yy, z - overhang, 1 + (s === 0 ? overhang : 0), 1, d + overhang * 2, c);
        if (gableC && s > 0) { this.box(x + s, yy, z, w - 2 * s, 1, 1, gableC); this.box(x + s, yy, z + d - 1, w - 2 * s, 1, 1, gableC); }
        if (w - 2 * s > 2) this.box(x + s + 1, yy, z, w - 2 * s - 2, 1, d, gableC || c);
      }
    }
    return this;
  }
  /** Stepped hip/pyramid roof. */
  roofHip(x, y, z, w, d, c, step = 1) {
    let s = 0;
    while (w - 2 * s > 0 && d - 2 * s > 0) {
      this.box(x + s, y + Math.floor(s / step), z + s, w - 2 * s, 1, d - 2 * s, c);
      s++;
    }
    return this;
  }
  /**
   * Windows on the 4 faces of the box [x,x+w) x [y,y+h) x [z,z+d): replaces SURFACE voxels
   * with window color in a grid. opts: { win, floorH=3, winH=2, spacing=2, startY=1, margin=1, faces='nsew', frame }
   */
  windows(x, y, z, w, h, d, opts = {}) {
    const win = opts.win || P.WIN, fh = opts.floorH || 3, wh = opts.winH || 2, sp = opts.spacing || 2;
    const sy = opts.startY == null ? 1 : opts.startY, mg = opts.margin == null ? 1 : opts.margin;
    const faces = opts.faces || 'nsew';
    const winAt = (a, yy) => (yy - y - sy) % fh < wh && yy - y >= sy && (a % sp) === 0;
    for (let yy = y; yy < y + h - (opts.top == null ? 1 : opts.top); yy++) {
      for (let a = mg; a < w - mg; a++) {
        if (!winAt(a - mg, yy)) continue;
        if (faces.includes('s') && this.get(x + a, yy, z + d - 1)) this.set(x + a, yy, z + d - 1, win);
        if (faces.includes('n') && this.get(x + a, yy, z)) this.set(x + a, yy, z, win);
      }
      for (let a = mg; a < d - mg; a++) {
        if (!winAt(a - mg, yy)) continue;
        if (faces.includes('e') && this.get(x + w - 1, yy, z + a)) this.set(x + w - 1, yy, z + a, win);
        if (faces.includes('w') && this.get(x, yy, z + a)) this.set(x, yy, z + a, win);
      }
    }
    return this;
  }
  /** Replaces all voxels of color a with b. */
  replace(a, b) {
    for (let i = 0; i < this.v.length; i++) if (this.v[i] === a) this.v[i] = b;
    return this;
  }
  /** Copies another grid in at offset (skips empty voxels). */
  paste(g, ox, oy, oz) {
    for (let y = 0; y < g.sy; y++) for (let z = 0; z < g.sz; z++) for (let x = 0; x < g.sx; x++) {
      const c = g.v[x + g.sx * (z + g.sz * y)];
      if (c) this.set(ox + x, oy + y, oz + z, c);
    }
    return this;
  }
  /** Highest filled y at column (x,z) + 1, or 0. */
  heightAt(x, z) {
    for (let y = this.sy - 1; y >= 0; y--) if (this.get(x, y, z)) return y + 1;
    return 0;
  }
  /** Max filled height of the whole grid. */
  maxHeight() {
    for (let y = this.sy - 1; y >= 0; y--) {
      const o = this.sx * this.sz * y;
      for (let i = 0; i < this.sx * this.sz; i++) if (this.v[o + i]) return y + 1;
    }
    return 0;
  }
  /** Registers a particle emitter at voxel coords. type: 'smoke'|'steam'|'fire'|'sparkle'|'fountain'. */
  emit(x, y, z, type = 'smoke', rate = 1) {
    this.emitters.push({ x, y, z, type, rate });
    return this;
  }
  /** Registers a glow light point (drawn as a bloom sprite at night). color = [r,g,b] 0..1. */
  light(x, y, z, color = [1, 0.85, 0.6], size = 1, always = false) {
    this.lights.push({ x, y, z, color, size, always });
    return this;
  }
}
VC.VoxelGrid = VoxelGrid;

/* ------------------------------------------------------------------ */
/* Mesher                                                               */
/* ------------------------------------------------------------------ */
/**
 * Greedy mesher with per-vertex AO. Returns { data: Uint8Array (8 B/vertex), quads }.
 * scale multiplies output positions (for LOD grids).
 */
function mesh(g, scale = 1) {
  const sx = g.sx, sy = g.sy, sz = g.sz, v = g.v;
  const dims = [sx, sy, sz];
  const solid = (x, y, z) => (x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz ? v[x + sx * (z + sz * y)] : 0) !== 0;
  let cap = 4096;
  let buf = new ArrayBuffer(cap * 32);
  let i16 = new Int16Array(buf), u8 = new Uint8Array(buf);
  let quads = 0;
  const pushQuad = (verts) => {
    if (quads >= cap) {
      cap *= 2;
      const nb = new ArrayBuffer(cap * 32);
      new Uint8Array(nb).set(u8);
      buf = nb;
      i16 = new Int16Array(buf);
      u8 = new Uint8Array(buf);
    }
    let o = quads * 32;
    for (let k = 0; k < 4; k++, o += 8) {
      const vv = verts[k];
      i16[o >> 1] = vv[0] * scale;
      i16[(o >> 1) + 1] = vv[1] * scale;
      i16[(o >> 1) + 2] = vv[2] * scale;
      u8[o + 6] = vv[3];
      u8[o + 7] = vv[4];
    }
    quads++;
  };
  const p = [0, 0, 0], q = [0, 0, 0];
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, w = (d + 2) % 3;
    const du = dims[u], dw = dims[w];
    const mask = new Int32Array(du * dw);
    for (const dir of [1, -1]) {
      const nrm = d * 2 + (dir > 0 ? 0 : 1);
      for (let i = 0; i < dims[d]; i++) {
        // build mask
        let any = false;
        for (let b = 0; b < dw; b++)
          for (let a = 0; a < du; a++) {
            p[d] = i; p[u] = a; p[w] = b;
            const c = v[p[0] + sx * (p[2] + sz * p[1])];
            let m = 0;
            if (c) {
              q[d] = i + dir; q[u] = a; q[w] = b;
              if (!solid(q[0], q[1], q[2])) {
                // AO for corners (-u,-w), (+u,-w), (+u,+w), (-u,+w) sampled in the neighbor layer
                const ao = [0, 0, 0, 0];
                const su = [-1, 1, 1, -1], sw = [-1, -1, 1, 1];
                for (let k = 0; k < 4; k++) {
                  q[u] = a + su[k]; q[w] = b;
                  const s1 = solid(q[0], q[1], q[2]);
                  q[u] = a; q[w] = b + sw[k];
                  const s2 = solid(q[0], q[1], q[2]);
                  q[u] = a + su[k]; q[w] = b + sw[k];
                  const cc = solid(q[0], q[1], q[2]);
                  ao[k] = s1 && s2 ? 0 : 3 - ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (cc ? 1 : 0));
                }
                m = c | (ao[0] << 8) | (ao[1] << 10) | (ao[2] << 12) | (ao[3] << 14) | (1 << 16);
                any = true;
              }
            }
            mask[b * du + a] = m;
          }
        if (!any) continue;
        // greedy merge
        const plane = dir > 0 ? i + 1 : i;
        for (let b = 0; b < dw; b++)
          for (let a = 0; a < du; ) {
            const m = mask[b * du + a];
            if (!m) { a++; continue; }
            let wa = 1;
            while (a + wa < du && mask[b * du + a + wa] === m) wa++;
            let hb = 1;
            outer: while (b + hb < dw) {
              for (let k = 0; k < wa; k++) if (mask[(b + hb) * du + a + k] !== m) break outer;
              hb++;
            }
            for (let bb = 0; bb < hb; bb++) for (let k = 0; k < wa; k++) mask[(b + bb) * du + a + k] = 0;
            const col = m & 255;
            const ao = [(m >> 8) & 3, (m >> 10) & 3, (m >> 12) & 3, (m >> 14) & 3];
            const corner = (ua, wb, aoV) => {
              const r = [0, 0, 0, col, nrm | (aoV << 3)];
              r[d] = plane; r[u] = ua; r[w] = wb;
              return r;
            };
            let vs = [corner(a, b, ao[0]), corner(a + wa, b, ao[1]), corner(a + wa, b + hb, ao[2]), corner(a, b + hb, ao[3])];
            if (dir < 0) vs = [vs[0], vs[3], vs[2], vs[1]];
            // flip the diagonal to avoid AO anisotropy
            const aoOf = (vv) => vv[4] >> 3;
            if (aoOf(vs[0]) + aoOf(vs[2]) < aoOf(vs[1]) + aoOf(vs[3])) vs = [vs[1], vs[2], vs[3], vs[0]];
            pushQuad(vs);
            a += wa;
          }
      }
    }
  }
  return { data: new Uint8Array(buf, 0, quads * 32), quads };
}

/** Half-resolution grid (factor f) keeping the most common color of each block if >= minFill voxels set. */
function downsample(g, f = 2, minFill = 3) {
  const nx = Math.ceil(g.sx / f), ny = Math.ceil(g.sy / f), nz = Math.ceil(g.sz / f);
  const o = new VoxelGrid(nx, ny, nz);
  const counts = new Map();
  for (let y = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        counts.clear();
        let n = 0, best = 0, bestN = 0;
        for (let yy = 0; yy < f; yy++) for (let zz = 0; zz < f; zz++) for (let xx = 0; xx < f; xx++) {
          const c = g.get(x * f + xx, y * f + yy, z * f + zz);
          if (!c) continue;
          n++;
          const k = (counts.get(c) || 0) + 1;
          counts.set(c, k);
          // prefer emissive/window colors slightly so night lighting survives LOD
          const w = k + (PAL[c * 4 + 3] & (MAT.WINDOW | MAT.EMISSIVE) ? 0.5 : 0);
          if (w > bestN) { bestN = w; best = c; }
        }
        if (n >= minFill || (n > 0 && y === 0)) o.v[x + nx * (z + nz * y)] = best;
      }
  return o;
}

/* ------------------------------------------------------------------ */
/* VC.voxel API                                                          */
/* ------------------------------------------------------------------ */
VC.voxel = {
  palette: PAL,
  mesh,
  downsample,
  get palVersion() {
    return palVersion;
  },
  /** Returns palette index for a custom color (adds it if new). */
  color(hex, flags = 0) {
    const key = (typeof hex === 'number' ? hex : parseInt(String(hex).replace('#', ''), 16)) + ':' + flags;
    if (customMap.has(key)) return customMap.get(key);
    if (palCount >= 256) return P.GREY;
    const i = palAdd(null, hex, flags);
    customMap.set(key, i);
    palVersion++;
    if (VC.voxel._palTex) VC.voxel._palDirty = true;
    return i;
  },
  /** Material flags of palette index. */
  flags(i) {
    return PAL[i * 4 + 3];
  },
  /** 256x1 RGBA8 palette texture (rgb = sRGB color, a = MAT flags). Re-uploads if custom colors were added. */
  paletteTexture() {
    const G = VC.gfx, gl = G.gl;
    if (!VC.voxel._palTex) {
      VC.voxel._palTex = G.texture({ w: 256, h: 1, data: PAL, filter: gl.NEAREST });
      VC.voxel._palDirty = false;
    } else if (VC.voxel._palDirty) {
      gl.bindTexture(gl.TEXTURE_2D, VC.voxel._palTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, PAL);
      VC.voxel._palDirty = false;
    }
    return VC.voxel._palTex;
  },
  /** Uploads a mesh; returns { vao, vbo, quads }. Attributes 0 and 1 configured; element buffer bound. */
  upload(m) {
    const G = VC.gfx, gl = G.gl;
    const vao = gl.createVertexArray();
    const ib = G.quadIndexBuffer(m.quads);
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, m.data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.SHORT, false, 8, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 2, gl.UNSIGNED_BYTE, 8, 6);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bindVertexArray(null);
    return { vao, vbo, quads: m.quads };
  },
};

/* ------------------------------------------------------------------ */
/* Model registry                                                        */
/* ------------------------------------------------------------------ */
const defs = Object.create(null);
const cache = new Map();
VC.models = {
  defs,
  stats: { built: 0, quads: 0, ms: 0 },
  define(key, def) {
    defs[key] = Object.assign({ variants: 1, scale: 1, parts: null }, def);
    return defs[key];
  },
  has(key) {
    return !!defs[key];
  },
  /** Cache key for (key, variant, params). */
  cacheKey(key, variant, params) {
    let k = key + '#' + variant;
    if (params) for (const p in params) k += '|' + p + '=' + params[p];
    return k;
  },
  /** Generates (without GPU upload) the grid for a model. Useful for tests/inspection. */
  grid(key, variant = 0, params = {}) {
    const def = defs[key];
    if (!def) return null;
    const rng = M.rng(M.seedFromString(key) + variant * 7919 + (params.level || 0) * 104729 + (params.fw || 0) * 31 + (params.fd || 0) * 17 + (params.wealth || 0) * 1301);
    return def.gen(rng, variant, params);
  },
  /** Returns a GPU-ready model (builds on first use), or null if the key is unknown. */
  get(key, variant = 0, params = null) {
    const def = defs[key];
    if (!def) return null;
    variant = ((variant % def.variants) + def.variants) % def.variants;
    const ck = VC.models.cacheKey(key, variant, params);
    let m = cache.get(ck);
    if (m) return m;
    const t0 = performance.now();
    let g;
    try {
      g = VC.models.grid(key, variant, params || {});
    } catch (e) {
      console.error(`[models] generator "${key}" failed`, e);
      g = null;
    }
    if (!g) {
      g = new VoxelGrid(8, 8, 8);
      g.box(1, 0, 1, 6, 6, 6, P.PINK);
    }
    const vox = VC.C.VOX * (def.scale || 1);
    const full = mesh(g, 1);
    const lodGrid = downsample(g, 2);
    const lodMesh = mesh(lodGrid, 2);
    m = {
      key, variant, params, sx: g.sx, sy: g.sy, sz: g.sz, vox,
      height: g.maxHeight() * vox,
      quads: full.quads,
      emitters: g.emitters,
      lights: g.lights,
      meta: g.meta,
      parts: def.parts || null,
      grid: g,
    };
    if (VC.gfx.gl) {
      Object.assign(m, VC.voxel.upload(full));
      m.lod = VC.voxel.upload(lodMesh);
    }
    cache.set(ck, m);
    const dt = performance.now() - t0;
    VC.models.stats.built++;
    VC.models.stats.quads += full.quads;
    VC.models.stats.ms += dt;
    return m;
  },
  /** Returns the model for a building object (handles growables & rotation). */
  forBuilding(b) {
    if (b.key === 'grow') {
      const zk = (VC.ZONES[b.zt] || VC.ZONES[1]).key;
      const fw = b.rot & 1 ? b.d : b.w, fd = b.rot & 1 ? b.w : b.d;
      return VC.models.get('grow_' + zk + b.den, b.variant, { fw, fd, level: b.level, wealth: b.wealth || 0 });
    }
    const def = defs[b.key];
    if (def) {
      if (def.sized) return VC.models.get(b.key, b.variant, { fw: b.rot & 1 ? b.d : b.w, fd: b.rot & 1 ? b.w : b.d });
      return VC.models.get(b.key, b.variant);
    }
    return null;
  },
  /**
   * Converts a model-local voxel coordinate to world space for building b.
   * Returns [x, y, z].
   */
  localToWorld(b, model, lx, ly, lz) {
    const vox = model ? model.vox : VC.C.VOX;
    const fw = b.rot & 1 ? b.d : b.w, fd = b.rot & 1 ? b.w : b.d;
    const px = (lx - fw * 4) * vox, pz = (lz - fd * 4) * vox;
    const a = (b.rot | 0) * Math.PI * 0.5, c = Math.cos(a), s = Math.sin(a);
    const gy = VC.world.topY(b.x, b.z);
    return [b.x + b.w / 2 + px * c + pz * s, gy + ly * vox, b.z + b.d / 2 - px * s + pz * c];
  },
  /** Drops all cached models (e.g. after palette/generator changes in dev). */
  clear() {
    const gl = VC.gfx.gl;
    for (const m of cache.values()) {
      if (gl && m.vbo) { gl.deleteBuffer(m.vbo); gl.deleteVertexArray(m.vao); }
      if (gl && m.lod) { gl.deleteBuffer(m.lod.vbo); gl.deleteVertexArray(m.lod.vao); }
    }
    cache.clear();
  },
  cached() {
    return cache;
  },
};
