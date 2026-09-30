/*
 * VOXELPOLIS — FALLBACK voxel models for moving agents and effects (VC.fxModels).
 *
 * The real vehicle / creature models are authored elsewhere; VC.fxModels.ensure() (called from
 * agents.init / fx.init, i.e. after every models/*.js file has run) defines a stand-in ONLY for keys
 * that nobody else defined, so real generators always win.
 *
 * Conventions shared with the renderers (gfx/fx_gl.js pose()):
 *   - FRONT faces +Z, y = 0 is the bottom (wheels / keel / feet), origin = bottom centre (sx/2, 0, sz/2)
 *   - road vehicles use scale 0.5 (1/16 world unit voxels): a car is ~4 x 4 x 8 voxels
 *   - meta.draft (voxels) = how deep a boat sits in the water; meta.eyes = [[x,y,z],...] glowing eyes
 *   - model lights (grid.light) are drawn as glow sprites by the fx module (ufo, balloon, monster)
 *
 * Keys: car (10 variants), taxi, bus (4), truck (4), police_car, firetruck, ambulance, garbage_truck,
 * tanker (2), plane (3), helicopter (4) + part helicopter_rotor, boat (3), ferry, cargo_ship, bird (3 flap
 * frames), balloon (4), meteor, ufo, monster (4 walk frames), rocket, fx_cube (1 white voxel).
 */
const P = VC.P;
const G = (sx, sy, sz) => new VC.VoxelGrid(sx, sy, sz);

const CAR_COLORS = () => [P.CAR_RED, P.CAR_BLUE, P.CAR_WHITE, P.CAR_BLACK, P.CAR_SILVER, P.CAR_GREEN, VC.voxel.color('#2a8a9a', VC.MAT.METAL), VC.voxel.color('#d8742a', VC.MAT.METAL), P.CAR_SILVER, VC.voxel.color('#6a2a7a', VC.MAT.METAL)];

/** Four wheels + chassis + lights for a vehicle grid of width sx (4 or 5) and length sz. */
function chassis(g, sx, sz, wz0, wz1) {
  for (const x of [0, sx - 1]) for (const z of [wz0, wz1]) g.set(x, 0, z, P.TIRE);
  g.box(1, 0, 0, sx - 2, 1, sz, P.CONCRETE_DD);
}
function lights(g, sx, sz, y) {
  g.set(0, y, sz - 1, P.HEADLIGHT);
  g.set(sx - 1, y, sz - 1, P.HEADLIGHT);
  g.set(0, y, 0, P.TAILLIGHT);
  g.set(sx - 1, y, 0, P.TAILLIGHT);
}

/** Car shapes on a 4 x 5 x 8 grid. */
function carShape(g, shape, c) {
  chassis(g, 4, 8, 1, 6);
  if (shape === 'van') {
    g.box(0, 1, 0, 4, 3, 7, c);
    g.box(0, 1, 7, 4, 2, 1, c);
    g.box(0, 3, 6, 4, 1, 1, P.GLASS_DARK);
    for (let z = 1; z < 6; z += 2) { g.set(0, 3, z, P.GLASS_DARK); g.set(3, 3, z, P.GLASS_DARK); }
    g.box(0, 4, 0, 4, 1, 7, P.CAR_WHITE);
  } else if (shape === 'suv') {
    g.box(0, 1, 0, 4, 2, 8, c);
    g.box(0, 3, 1, 4, 1, 5, P.GLASS_DARK);
    g.box(0, 4, 1, 4, 1, 5, c);
    g.box(1, 4, 2, 2, 1, 3, P.CONCRETE_DD); // roof rack
  } else if (shape === 'pickup') {
    g.box(0, 1, 0, 4, 1, 8, c);
    g.box(0, 2, 4, 4, 1, 2, P.GLASS_DARK);
    g.box(0, 2, 6, 4, 1, 2, c);
    g.box(0, 3, 4, 4, 1, 2, c);
    g.box(0, 2, 0, 1, 1, 4, c);
    g.box(3, 2, 0, 1, 1, 4, c);
    g.box(1, 2, 0, 2, 1, 1, c);
    g.box(1, 2, 1, 2, 1, 2, P.WOOD_D); // cargo
  } else if (shape === 'sports') {
    g.box(0, 1, 0, 4, 1, 8, c);
    g.box(0, 2, 2, 4, 1, 3, P.GLASS_DARK);
    g.box(0, 2, 0, 4, 1, 1, c); // spoiler
    g.box(1, 2, 2, 2, 1, 2, c);
  } else if (shape === 'hatch') {
    g.box(0, 1, 0, 4, 1, 8, c);
    g.box(0, 2, 1, 4, 1, 5, P.GLASS_DARK);
    g.box(0, 2, 0, 4, 1, 1, c);
    g.box(0, 2, 6, 4, 1, 2, c);
    g.box(0, 3, 1, 4, 1, 4, c);
  } else {
    // sedan
    g.box(0, 1, 0, 4, 1, 8, c);
    g.box(0, 2, 2, 4, 1, 4, P.GLASS_DARK);
    g.box(0, 2, 0, 4, 1, 2, c);
    g.box(0, 2, 6, 4, 1, 2, c);
    g.box(0, 3, 2, 4, 1, 3, c);
  }
  g.set(1, 1, 7, P.METAL_D);
  g.set(2, 1, 7, P.METAL_D);
  lights(g, 4, 8, 1);
}
const CAR_SHAPES = ['sedan', 'hatch', 'suv', 'sedan', 'pickup', 'sports', 'van', 'hatch', 'sedan', 'suv'];

/** Emergency light bar across the roof at (y, z). */
function lightBar(g, sx, y, z) {
  const h = sx >> 1;
  for (let x = 0; x < sx; x++) g.set(x, y, z, x < h ? P.NEON_RED : P.NEON_BLUE);
}

const DEFS = {
  car: {
    variants: 10,
    scale: 0.5,
    gen(rng, v) {
      const g = G(4, 5, 8);
      carShape(g, CAR_SHAPES[v % CAR_SHAPES.length], CAR_COLORS()[v % 10]);
      return g;
    },
  },
  taxi: {
    scale: 0.5,
    gen() {
      const g = G(4, 5, 8);
      carShape(g, 'sedan', P.CAR_YELLOW);
      g.box(0, 1, 3, 4, 1, 2, P.BLACK);
      g.set(1, 4, 3, P.NEON_YELLOW);
      g.set(2, 4, 3, P.NEON_YELLOW);
      return g;
    },
  },
  police_car: {
    scale: 0.5,
    gen() {
      const g = G(4, 5, 8);
      carShape(g, 'sedan', P.CAR_WHITE);
      g.box(0, 1, 2, 4, 1, 4, P.CAR_BLACK);
      g.box(0, 2, 6, 4, 1, 2, P.CAR_BLACK);
      lightBar(g, 4, 4, 3);
      return g;
    },
  },
  ambulance: {
    scale: 0.5,
    gen() {
      const g = G(4, 6, 10);
      chassis(g, 4, 10, 1, 8);
      g.box(0, 1, 0, 4, 4, 8, P.CAR_WHITE);
      g.box(0, 1, 8, 4, 2, 2, P.CAR_WHITE);
      g.box(0, 3, 8, 4, 1, 1, P.GLASS_DARK);
      g.box(0, 2, 0, 1, 1, 8, P.RED);
      g.box(3, 2, 0, 1, 1, 8, P.RED);
      g.box(1, 3, 0, 2, 1, 1, P.RED);
      lightBar(g, 4, 5, 7);
      lights(g, 4, 10, 1);
      return g;
    },
  },
  firetruck: {
    scale: 0.5,
    gen() {
      const g = G(4, 6, 14);
      chassis(g, 4, 14, 2, 11);
      g.box(0, 0, 3, 4, 1, 1, P.TIRE);
      g.box(0, 1, 0, 4, 3, 14, P.CAR_RED);
      g.box(0, 2, 0, 1, 1, 10, P.WHITE);
      g.box(3, 2, 0, 1, 1, 10, P.WHITE);
      g.box(0, 3, 13, 4, 1, 1, P.GLASS_DARK);
      g.box(0, 3, 11, 1, 1, 2, P.GLASS_DARK);
      g.box(3, 3, 11, 1, 1, 2, P.GLASS_DARK);
      g.box(0, 4, 10, 4, 1, 4, P.CAR_RED);
      g.box(1, 4, 0, 2, 1, 10, P.CHROME);
      for (let z = 1; z < 10; z += 2) g.box(1, 4, z, 2, 1, 1, P.METAL_D);
      lightBar(g, 4, 5, 12);
      lights(g, 4, 14, 1);
      g.box(1, 1, 13, 2, 1, 1, P.CHROME);
      return g;
    },
  },
  bus: {
    variants: 4,
    scale: 0.5,
    gen(rng, v) {
      const body = [P.CAR_BLUE, P.GREEN, P.RED, P.CAR_YELLOW][v % 4];
      const roof = v === 3 ? P.CAR_YELLOW : P.CAR_WHITE;
      const g = G(5, 6, 18);
      for (const x of [0, 4]) for (const z of [2, 3, 13, 14]) g.set(x, 0, z, P.TIRE);
      g.box(1, 0, 0, 3, 1, 18, P.CONCRETE_DD);
      g.box(0, 1, 0, 5, 4, 18, body);
      for (let z = 1; z < 16; z++) if (z % 3) { g.box(0, 3, z, 1, 1, 1, P.WIN_COOL); g.box(4, 3, z, 1, 1, 1, P.WIN_COOL); }
      g.box(0, 2, 17, 5, 2, 1, P.GLASS_DARK);
      g.box(1, 4, 17, 3, 1, 1, P.NEON_ORANGE);
      g.box(0, 5, 0, 5, 1, 18, roof);
      g.box(1, 5, 5, 3, 1, 6, P.METAL_D);
      g.set(0, 1, 17, P.HEADLIGHT); g.set(4, 1, 17, P.HEADLIGHT);
      g.set(0, 2, 0, P.TAILLIGHT); g.set(4, 2, 0, P.TAILLIGHT);
      return g;
    },
  },
  truck: {
    variants: 4,
    scale: 0.5,
    gen(rng, v) {
      const box = [P.CAR_WHITE, P.CONTAINER_R, P.CONTAINER_B, P.CONTAINER_O][v % 4];
      const cab = [P.CAR_BLUE, P.CAR_WHITE, P.CAR_RED, P.CAR_BLACK][v % 4];
      const g = G(5, 7, 14);
      for (const x of [0, 4]) for (const z of [1, 2, 7, 11]) g.set(x, 0, z, P.TIRE);
      g.box(1, 0, 0, 3, 1, 14, P.CONCRETE_DD);
      g.box(0, 1, 0, 5, 6, 10, box);
      g.box(0, 5, 0, 5, 1, 10, P.CONCRETE_L);
      g.box(0, 2, 0, 5, 1, 1, P.METAL_D);
      g.box(0, 1, 10, 5, 4, 4, cab);
      g.box(0, 3, 13, 5, 1, 1, P.GLASS_DARK);
      g.box(0, 3, 11, 1, 1, 2, P.GLASS_DARK);
      g.box(4, 3, 11, 1, 1, 2, P.GLASS_DARK);
      g.box(1, 1, 13, 3, 1, 1, P.CHROME);
      g.set(0, 1, 13, P.HEADLIGHT); g.set(4, 1, 13, P.HEADLIGHT);
      g.set(0, 1, 0, P.TAILLIGHT); g.set(4, 1, 0, P.TAILLIGHT);
      return g;
    },
  },
  garbage_truck: {
    scale: 0.5,
    gen() {
      const g = G(5, 6, 13);
      for (const x of [0, 4]) for (const z of [1, 2, 10]) g.set(x, 0, z, P.TIRE);
      g.box(1, 0, 0, 3, 1, 13, P.CONCRETE_DD);
      g.box(0, 1, 0, 5, 5, 9, P.GREEN);
      g.box(0, 1, 0, 5, 1, 1, P.HAZARD_Y);
      g.box(1, 2, 0, 3, 3, 1, P.METAL_D);
      g.box(0, 5, 1, 5, 1, 7, VC.voxel.color('#2e7a3c'));
      g.box(0, 1, 9, 5, 4, 4, P.CAR_WHITE);
      g.box(0, 3, 12, 5, 1, 1, P.GLASS_DARK);
      g.set(0, 1, 12, P.HEADLIGHT); g.set(4, 1, 12, P.HEADLIGHT);
      g.set(2, 5, 10, P.NEON_ORANGE);
      g.set(0, 1, 0, P.TAILLIGHT); g.set(4, 1, 0, P.TAILLIGHT);
      return g;
    },
  },
  tanker: {
    variants: 2,
    scale: 0.5,
    gen(rng, v) {
      const g = G(5, 6, 15);
      for (const x of [0, 4]) for (const z of [1, 2, 8, 12]) g.set(x, 0, z, P.TIRE);
      g.box(1, 0, 0, 3, 1, 15, P.CONCRETE_DD);
      g.hcyl('z', 0, 11, 3.2, 2.5, 2.4, v ? P.TANK_WHITE : P.CHROME);
      g.box(2, 5, 3, 1, 1, 4, P.METAL_D);
      g.box(0, 1, 11, 5, 4, 4, v ? P.CAR_RED : P.ORANGE);
      g.box(0, 3, 14, 5, 1, 1, P.GLASS_DARK);
      g.set(0, 1, 14, P.HEADLIGHT); g.set(4, 1, 14, P.HEADLIGHT);
      g.set(0, 1, 0, P.TAILLIGHT); g.set(4, 1, 0, P.TAILLIGHT);
      return g;
    },
  },
  plane: {
    variants: 3,
    scale: 1,
    gen(rng, v) {
      const liv = [P.BLUE, P.RED, VC.voxel.color('#1e8a6a')][v % 3];
      const g = G(36, 15, 40);
      const cx = 18, cy = 5;
      g.hcyl('z', 3, 33, cy, cx, 2.45, P.WHITE);
      [2.1, 1.8, 1.3, 0.8].forEach((r, k) => g.hcyl('z', 36 + k, 1, cy - k * 0.25, cx, r, P.WHITE));
      [1.2, 1.7, 2.1].forEach((r, k) => g.hcyl('z', k, 1, cy + 0.8 - k * 0.25, cx, r, P.WHITE));
      g.box(17, 6, 35, 3, 1, 2, P.GLASS_DARK);
      for (let z = 6; z < 34; z++) {
        if (z % 2 === 0) { g.set(16, 6, z, P.WIN); g.set(20, 6, z, P.WIN); }
        g.set(16, 5, z, liv); g.set(20, 5, z, liv);
      }
      // wings (swept), engines, tailplanes, fin
      for (let k = 0; k < 15; k++) {
        const zb = Math.round(15 + k * 0.55), zf = Math.round(25 - k * 0.3);
        for (const s of [-1, 1]) g.box(cx + s * (2 + k), 3, zb, 1, 1, Math.max(1, zf - zb), P.CAR_SILVER);
      }
      for (const s of [-1, 1]) {
        g.box(cx + s * 17, 4, 23, 1, 2, 2, liv);
        g.hcyl('z', 19, 7, 2, cx + s * 7 + 0.5, 1.35, P.METAL_D);
        g.set(cx + s * 7, 2, 25, P.TIRE);
        for (let k = 0; k < 7; k++) g.box(cx + s * (2 + k), 6, Math.round(1 + k * 0.45), 1, 1, 4 - Math.round(k * 0.3), P.CAR_SILVER);
      }
      for (let y = 7; y < 15; y++) g.box(cx, y, Math.round(0.5 + (y - 7) * 0.6), 1, 1, Math.max(1, 6 - Math.round((y - 7) * 0.45)), liv);
      g.set(cx, 8, 20, P.BEACON_RED);
      g.set(cx, 2, 18, P.BEACON_RED);
      g.box(cx, 0, 32, 1, 3, 1, P.METAL_D);
      g.box(cx - 3, 0, 21, 1, 3, 1, P.METAL_D);
      g.box(cx + 3, 0, 21, 1, 3, 1, P.METAL_D);
      g.set(cx, 3, 38, P.HEADLIGHT);
      return g;
    },
  },
  helicopter_rotor: {
    scale: 0.5,
    gen() {
      const g = G(27, 1, 27);
      g.box(0, 0, 12, 27, 1, 2, P.METAL_D);
      g.box(12, 0, 0, 2, 1, 27, P.METAL_D);
      g.box(12, 0, 12, 2, 1, 2, P.CONCRETE_DD);
      return g;
    },
  },
  helicopter: {
    variants: 4,
    scale: 0.5,
    parts: [{ model: 'helicopter_rotor', pivot: [4, 7.5, 10.5], partPivot: [13, 0, 13], axis: 'y', speed: 26 }],
    gen(rng, v) {
      const body = [P.NAVY, P.CAR_WHITE, P.ORANGE, P.CAR_BLUE][v % 4];
      const trim = [P.CAR_WHITE, P.RED, P.CAR_WHITE, P.CAR_SILVER][v % 4];
      const g = G(8, 8, 18);
      g.box(1, 0, 5, 1, 1, 10, P.METAL_D);
      g.box(6, 0, 5, 1, 1, 10, P.METAL_D);
      g.set(1, 1, 7, P.METAL_D); g.set(6, 1, 7, P.METAL_D); g.set(1, 1, 12, P.METAL_D); g.set(6, 1, 12, P.METAL_D);
      g.ellipsoid(4, 3.6, 11, 2.7, 2.2, 4.2, (x, y, z) => (z >= 13 && y >= 3 ? P.GLASS_DARK : y === 3 ? trim : body));
      g.box(3, 4, 1, 2, 1, 7, body);
      g.box(4, 5, 0, 1, 2, 2, trim);
      g.box(5, 5, 1, 1, 3, 1, P.METAL_D);
      g.box(4, 6, 10, 1, 2, 1, P.METAL_D);
      g.set(4, 1, 15, P.HEADLIGHT);
      g.set(4, 5, 11, P.BEACON_RED);
      if (v === 0) lightBar(g, 2, 2, 8);
      return g;
    },
  },
  boat: {
    variants: 3,
    scale: 0.5,
    gen(rng, v) {
      if (v === 2) {
        // motorboat
        const g = G(5, 4, 11);
        for (let z = 0; z < 11; z++) {
          const w = z > 7 ? Math.max(1, 5 - (z - 7) * 1.4) : 5;
          const x0 = Math.round((5 - w) / 2);
          g.box(x0, 0, z, Math.round(w), 1, 1, P.NAVY);
          g.box(x0, 1, z, Math.round(w), 1, 1, P.WHITE);
        }
        g.box(1, 2, 2, 3, 1, 4, P.WOOD_L);
        g.box(1, 2, 6, 3, 1, 1, P.GLASS_CYAN);
        g.set(2, 2, 0, P.METAL_D);
        g.meta.draft = 1;
        return g;
      }
      const sail = v === 1 ? P.AWNING_R : P.WHITE;
      const g = G(6, 18, 13);
      for (let z = 0; z < 13; z++) {
        const w = z > 8 ? Math.max(1, 6 - (z - 8) * 1.3) : z < 1 ? 5 : 6;
        const x0 = Math.round((6 - w) / 2), wi = Math.max(1, Math.round(w));
        g.box(x0 + (z > 8 ? 0 : 1), 0, z, Math.max(1, wi - (z > 8 ? 0 : 2)), 1, 1, P.CAR_BLUE);
        g.box(x0, 1, z, wi, 1, 1, P.WHITE);
      }
      g.box(1, 2, 2, 4, 1, 6, P.WOOD_L);
      g.box(2, 2, 3, 2, 1, 2, P.WHITE);
      g.box(3, 2, 7, 1, 15, 1, P.WOOD_D);
      for (let y = 4; y < 17; y++) {
        const back = Math.round((17 - y) * 0.42);
        g.box(3, y, 7 - back, 1, 1, back, sail);
        if (y < 14) g.box(3, y, 8, 1, 1, Math.round((14 - y) * 0.3), P.WHITE);
      }
      g.meta.draft = 1.2;
      return g;
    },
  },
  ferry: {
    scale: 0.5,
    gen() {
      const g = G(10, 12, 30);
      for (let z = 0; z < 30; z++) {
        const w = z > 24 ? Math.max(2, 10 - (z - 24) * 1.5) : 10;
        const x0 = Math.round((10 - w) / 2), wi = Math.round(w);
        g.box(x0, 0, z, wi, 3, 1, P.NAVY);
        g.box(x0, 3, z, wi, 1, 1, P.WHITE);
      }
      g.box(1, 4, 3, 8, 3, 21, P.WHITE);
      for (let z = 4; z < 23; z++) if (z % 2) { g.set(1, 5, z, P.WIN); g.set(8, 5, z, P.WIN); }
      g.box(2, 7, 16, 6, 2, 6, P.WHITE);
      g.box(2, 8, 21, 6, 1, 1, P.GLASS_DARK);
      g.box(4, 7, 8, 2, 4, 2, P.RED);
      g.box(4, 10, 8, 2, 1, 2, P.BLACK);
      g.set(5, 9, 19, P.BEACON_RED);
      g.emit(5, 11, 9, 'smoke', 0.5);
      g.meta.draft = 2.2;
      return g;
    },
  },
  cargo_ship: {
    scale: 0.5,
    gen(rng) {
      const g = G(14, 16, 60);
      for (let z = 0; z < 60; z++) {
        const w = z > 50 ? Math.max(2, 14 - (z - 50) * 1.3) : z < 3 ? 12 : 14;
        const x0 = Math.round((14 - w) / 2), wi = Math.round(w);
        g.box(x0, 0, z, wi, 2, 1, P.RUST);
        g.box(x0, 2, z, wi, 3, 1, P.NAVY);
      }
      g.box(1, 5, 2, 12, 1, 54, P.CONCRETE_D);
      const cols = [P.CONTAINER_R, P.CONTAINER_B, P.CONTAINER_G, P.CONTAINER_O, P.CAR_WHITE];
      for (let z = 12; z < 50; z += 6)
        for (let x = 1; x < 13; x += 3) {
          const hgt = 1 + Math.floor(rng() * 3);
          for (let k = 0; k < hgt; k++) g.box(x, 6 + k * 2, z, 3, 2, 5, rng.pick(cols));
        }
      g.box(2, 6, 2, 10, 7, 8, P.WHITE);
      for (let x = 3; x < 11; x += 2) g.set(x, 11, 9, P.WIN);
      g.box(2, 12, 7, 10, 1, 3, P.GLASS_DARK);
      g.box(5, 13, 3, 4, 3, 3, P.RED);
      g.set(7, 15, 8, P.BEACON_RED);
      g.emit(7, 16, 4, 'smoke', 0.6);
      g.meta.draft = 3;
      return g;
    },
  },
  bird: {
    variants: 3,
    scale: 0.25,
    gen(rng, v) {
      const g = G(9, 5, 6);
      const W = P.WHITE, D = P.GREY;
      g.box(4, 2, 1, 1, 1, 4, W);
      g.set(4, 2, 5, P.ORANGE);
      g.set(4, 2, 0, D);
      const hw = [[1, 2, 3, 4], [2, 2, 2, 2], [2, 1, 1, 0]][v % 3];
      for (let k = 0; k < 4; k++) {
        const c = k === 3 ? D : W;
        g.box(3 - k, hw[k], 2, 1, 1, k < 2 ? 2 : 1, c);
        g.box(5 + k, hw[k], 2, 1, 1, k < 2 ? 2 : 1, c);
      }
      return g;
    },
  },
  balloon: {
    variants: 4,
    scale: 1,
    gen(rng, v) {
      const pairs = [[P.RED, P.YELLOW], [P.BLUE, P.WHITE], [P.PURPLE, P.ORANGE], [P.GREEN, P.CREAM]][v % 4];
      const g = G(13, 22, 13);
      const c = 6.5;
      g.ellipsoid(c, 14.5, c, 5.8, 6.8, 5.8, (x, y, z) => {
        const a = Math.atan2(z + 0.5 - c, x + 0.5 - c);
        const k = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 10);
        return y > 19 ? pairs[1] : pairs[k & 1];
      });
      for (let y = 7; y < 10; y++) g.cyl(c, y, c, 1.5 + (y - 7) * 1.2, 1, pairs[0]);
      g.box(5, 0, 5, 3, 3, 3, P.WOOD);
      g.box(5, 2, 5, 3, 1, 3, P.WOOD_D);
      g.box(6, 4, 6, 1, 1, 1, P.METAL_D);
      for (const [x, z] of [[5, 5], [7, 5], [5, 7], [7, 7]]) g.box(x, 3, z, 1, 4, 1, P.METAL_D);
      g.light(6.5, 5, 6.5, [1.0, 0.55, 0.2], 1.2, true);
      return g;
    },
  },
  meteor: {
    scale: 1,
    gen(rng) {
      const g = G(10, 10, 10);
      g.sphere(5, 5, 5, 4.4, (x, y, z) => (rng() < 0.18 ? P.FIRE : rng() < 0.5 ? P.ROCK : P.STONE_D));
      for (let k = 0; k < 6; k++) g.sphere(rng.int(2, 7), rng.int(2, 7), rng.int(2, 7), 1.6, P.CONCRETE_DD);
      return g;
    },
  },
  ufo: {
    scale: 1,
    gen() {
      const g = G(24, 10, 24);
      const c = 12;
      const prof = [[0, 3.5, P.NEON_GREEN], [1, 7.5, P.METAL_D], [2, 11, P.CHROME], [3, 9.5, P.METAL], [4, 6.5, P.METAL]];
      for (const [y, r, col] of prof) g.cyl(c, y, c, r, 1, col);
      g.cyl(c, 0, c, 2.2, 1, P.GLOW_REACTOR);
      for (let y = 5; y < 9; y++) g.cyl(c, y, c, [4.5, 4, 3.2, 2][y - 5], 1, P.GLASS_CYAN);
      g.set(12, 5, 12, P.NEON_GREEN);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const x = c + Math.cos(a) * 10.6, z = c + Math.sin(a) * 10.6;
        g.set(Math.floor(x), 2, Math.floor(z), k & 1 ? P.NEON_CYAN : P.NEON_PINK);
        g.light(x, 2.5, z, k & 1 ? [0.3, 1, 1] : [1, 0.3, 0.8], 0.8, true);
      }
      return g;
    },
  },
  monster: {
    variants: 4,
    scale: 1,
    gen(rng, v) {
      const g = G(26, 46, 44);
      const skin = VC.voxel.color('#3f7a3a'), dark = VC.voxel.color('#2c5a2a'), belly = VC.voxel.color('#9ab85a');
      const cx = 13;
      const ph = (v % 4) * Math.PI * 0.5, sw = Math.sin(ph);
      // legs (alternating stride) + feet
      for (const s of [-1, 1]) {
        const off = Math.round(sw * 4 * s);
        const lift = Math.max(0, Math.round(Math.cos(ph + (s > 0 ? 0 : Math.PI)) * 2));
        const lx = cx + s * 5 - 2;
        g.box(lx, lift, 20 + off, 5, 3, 7, dark);
        g.box(lx, lift + 3, 21 + off, 4, 9, 4, skin);
        g.box(lx, 12, 20, 5, 6, 7, skin);
        g.box(lx, lift, 26 + off, 1, 1, 2, P.WHITE);
        g.box(lx + 4, lift, 26 + off, 1, 1, 2, P.WHITE);
      }
      // torso + belly
      g.ellipsoid(cx, 22, 22, 8.5, 11, 8.5, (x, y, z) => (z > 27 && Math.abs(x + 0.5 - cx) < 5 ? belly : skin));
      // tail (sways)
      for (let k = 0; k < 12; k++) {
        const t = k / 11;
        const tx = cx + Math.sin(ph + t * 2.5) * 3 * t;
        g.sphere(tx, 15 - t * 12 + 2, 16 - t * 15, 5 - t * 3.6, t > 0.8 ? dark : skin);
      }
      // arms
      for (const s of [-1, 1]) g.box(cx + s * 6 - 1, 23 + Math.round(sw * s), 28, 2, 2, 5, dark);
      // neck + head with jaw, teeth and glowing eyes
      g.ellipsoid(cx, 31, 27, 5, 5, 5, skin);
      g.ellipsoid(cx, 36, 32, 5.5, 4.5, 7, skin);
      g.box(cx - 4, 32, 32, 8, 2, 9, dark);
      for (let z = 34; z < 41; z += 2) { g.set(cx - 3, 34, z, P.WHITE); g.set(cx + 2, 34, z, P.WHITE); }
      g.box(cx - 4, 37, 36, 2, 2, 2, P.NEON_YELLOW);
      g.box(cx + 2, 37, 36, 2, 2, 2, P.NEON_YELLOW);
      g.meta.eyes = [[cx - 3, 38, 38], [cx + 3, 38, 38]];
      // glowing dorsal plates from head to tail
      for (let k = 0; k < 14; k++) {
        const t = k / 13;
        const py = Math.round(40 - t * 30), pz = Math.round(28 - t * 26);
        const h = Math.round(4 - t * 2.5);
        g.box(cx - (k & 1), py, pz, 1, h, 2, P.NEON_CYAN);
      }
      return g;
    },
  },
  rocket: {
    scale: 1,
    gen() {
      const g = G(12, 50, 12), c = 6;
      for (let y = 0; y < 42; y++) g.cyl(c, y, c, y < 3 ? 2.2 : y > 34 ? 2.4 - (y - 34) * 0.25 : 2.6, 1, y === 17 || y === 30 ? P.BLACK : P.WHITE);
      g.cyl(c, 42, c, 1.2, 3, P.WHITE);
      g.box(5, 45, 5, 2, 3, 2, P.RED);
      for (const bx of [c - 4.1, c + 4.1]) {
        for (let y = 0; y < 22; y++) g.cyl(bx, y, c, 1.7, 1, y === 12 ? P.BLACK : P.WHITE);
        g.cyl(bx, 22, c, 0.8, 1, P.RED);
      }
      for (let y = 0; y < 6; y++) { g.box(5, y, 9, 2, 1, 3 - (y >> 1), P.RED); g.box(5, y, 3 - (3 - (y >> 1)), 2, 1, 3 - (y >> 1), P.RED); }
      g.meta.nozzle = [6, 0, 6];
      return g;
    },
  },
  fx_cube: {
    scale: 1,
    gen() {
      const g = G(1, 1, 1);
      g.set(0, 0, 0, P.WHITE);
      return g;
    },
  },
};

VC.fxModels = {
  DEFS,
  /** Defines every fallback whose key is still undefined. Safe to call repeatedly. */
  ensure() {
    for (const k in DEFS) if (!VC.models.has(k)) VC.models.define(k, DEFS[k]);
  },
};
