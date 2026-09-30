/*
 * VOXELPOLIS — placeholder models. Loaded after all other models/*.js files (zz_ prefix);
 * defines a simple stand-in ONLY for keys that no real generator has defined yet,
 * so the game never renders missing buildings as invisible.
 */
const P = VC.P;
function ph(key, def) {
  if (!VC.models.has(key)) VC.models.define(key, def);
}
// growables
for (const zk of ['R', 'C', 'I']) {
  for (const den of [1, 2, 3]) {
    ph('grow_' + zk + den, {
      variants: 4,
      gen(rng, v, p) {
        const fw = p.fw || 1, fd = p.fd || 1, lvl = p.level || 1;
        const sx = fw * 8, sz = fd * 8;
        const h = Math.round((zk === 'I' ? 6 : 5 + den * den * 3) * (0.7 + lvl * 0.3) * (0.8 + rng() * 0.4));
        const g = new VC.VoxelGrid(sx, h + 4, sz);
        const wall = zk === 'R' ? rng.pick([P.PLASTER, P.PLASTER_CREAM, P.BRICK, P.PLASTER_PEACH]) : zk === 'C' ? rng.pick([P.CONCRETE_L, P.GLASS_BLUE, P.CONCRETE]) : rng.pick([P.METAL_D, P.CONCRETE_D, P.RUST]);
        g.box(1, 0, 1, sx - 2, h, sz - 2, wall);
        g.windows(1, 0, 1, sx - 2, h, sz - 2, { win: zk === 'C' ? P.WIN_OFFICE : P.WIN });
        if (zk === 'R' && den === 1) g.roofGable(0, h, 0, sx, sz, rng.pick([P.ROOF_RED, P.ROOF_GREY, P.ROOF_TERRA]), 'x');
        else g.box(1, h, 1, sx - 2, 1, sz - 2, P.CONCRETE_D);
        if (zk === 'I') { g.box(sx - 3, h, 1, 2, 4, 2, P.CHIMNEY); g.emit(sx - 2, h + 4, 2, 'smoke'); }
        return g;
      },
    });
  }
}
// catalog
for (const def of VC.CATALOG) {
  ph(def.key, {
    variants: 1,
    gen(rng) {
      const sx = def.size[0] * 8, sz = def.size[1] * 8;
      const h = 6 + Math.round(Math.sqrt(def.cost) / 12);
      const g = new VC.VoxelGrid(sx, h + 2, sz);
      const col = { power: P.METAL_D, water: P.STEEL_BLUE, safety: P.BRICK, education: P.BRICK_Y, parks: P.GRASS, transit: P.CONCRETE, waste: P.RUST, landmarks: P.MARBLE }[def.group] || P.CONCRETE;
      if (def.group === 'parks') {
        g.box(0, 0, 0, sx, 1, sz, P.GRASS);
        for (let k = 0; k < def.size[0] * def.size[1] * 2; k++) g.sphere(rng.int(2, sx - 3), 4, rng.int(2, sz - 3), 2.2, P.LEAF);
      } else {
        g.box(1, 0, 1, sx - 2, h, sz - 2, col);
        g.windows(1, 0, 1, sx - 2, h, sz - 2, { win: P.WIN });
        g.box(2, h, 2, sx - 4, 1, sz - 4, P.CONCRETE_D);
      }
      return g;
    },
  });
}
// trees
const treeDef = (leaf, trunkH, r) => ({
  variants: 3,
  gen(rng) {
    const g = new VC.VoxelGrid(8, trunkH + r * 2 + 2, 8);
    g.box(3, 0, 3, 2, trunkH, 2, P.TRUNK);
    g.sphere(4, trunkH + r, 4, r + rng() * 0.6, leaf);
    return g;
  },
});
ph('tree_oak', treeDef(P.LEAF, 4, 3));
ph('tree_birch', treeDef(P.BIRCH_LEAF, 5, 2.5));
ph('tree_bush', treeDef(P.LEAF_D, 1, 2));
ph('tree_pine', {
  variants: 3,
  gen(rng) {
    const g = new VC.VoxelGrid(8, 16, 8);
    g.box(3, 0, 3, 2, 3, 2, P.TRUNK);
    for (let y = 3, r = 3.6; r > 0.4; y += 2, r -= 0.7) g.cyl(4, y, 4, r, 2, P.PINE);
    return g;
  },
});
ph('tree_palm', treeDef(P.PALM, 7, 2));
ph('rubble', {
  variants: 2,
  gen(rng, v, p) {
    const sx = (p.fw || 1) * 8, sz = (p.fd || 1) * 8;
    const g = new VC.VoxelGrid(sx, 3, sz);
    for (let k = 0; k < sx * sz * 0.6; k++) g.set(rng.int(0, sx - 1), rng.int(0, 1), rng.int(0, sz - 1), rng.pick([P.CONCRETE_D, P.BRICK_D, P.STONE_D]));
    return g;
  },
});
