/*
 * VOXELPOLIS — game actions (validated, costed world edits). STUB — replaced by the tools agent.
 * Contract: docs/ARCHITECTURE.md §VC.actions.
 */
VC.actions = {
  roadPath(x0, z0, x1, z1) { return []; },
  canBuildRoad(tiles, type) { return { ok: false, cost: 0, reason: 'stub' }; },
  buildRoad(tiles, type) { return { ok: false, cost: 0 }; },
  zone(x0, z0, x1, z1, code) { return { ok: false, cost: 0 }; },
  canPlace(key, x, z, rot) { return { ok: false, reason: 'stub', cost: 0 }; },
  placeBuilding(key, x, z, rot) { return { ok: false }; },
  bulldoze(x0, z0, x1, z1, opts) { return { ok: false, cost: 0 }; },
  terraform(x, z, radius, mode, level) { return { ok: false, cost: 0 }; },
  plantTrees(x0, z0, x1, z1) { return { ok: false, cost: 0 }; },
  powerLine(tiles) { return { ok: false, cost: 0 }; },
};
