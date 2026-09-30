/*
 * VOXELPOLIS — player tools (VC.tools). Contract: docs/ARCHITECTURE.md §VC.tools.
 *
 * TOOL KEYS: select, bulldoze, road_street, road_avenue, road_highway, pline, zone_r1..zone_i3 (VC.ZONE_TOOLS),
 *   dezone, bld:<catalogKey>, trees, terrain_raise, terrain_lower, terrain_level.
 * STATE: current, kind ('select'|'bulldoze'|'road'|'pline'|'zone'|'dezone'|'bld'|'trees'|'terrain'),
 *   hover {x,z}|null (tile under the cursor; read by the renderer UBO), hoverId (building under the cursor for
 *   select/bulldoze), selectedId, rotation (ghost), manualRot, brush {terrain, trees} radius 0..3, plan (last
 *   validation result), drag (active gesture or null).
 * INTERACTION (driven by VC.input): pointer(px,py,inside), down/move/up(px,py) for the active tool, click(px,py)
 *   for the select tool, cancel() (drag first, then back to select), cancelDrag(), rotate(dir), adjustBrush(d).
 *   Roads / power lines: drag an L-shaped path (Shift = straight), commit on release. Zones / dezone / bulldoze:
 *   drag a rectangle, commit on release. Buildings: click (1x1 buildings: drag to place a row), R rotates,
 *   the ghost auto-faces an adjacent road until rotated manually. Trees / terrain: brush while held.
 * PREVIEWS: a draw list rebuilt only when the inputs of the plan change (tile, drag, rotation, world / money /
 *   unlock versions) and replayed into VC.gfx.gizmo from a GL-free transparent layer ('tools', order 990), i.e.
 *   exactly once per rendered frame. Buildings also get a ghost via VC.bldgfx.setGhost({key, x, z, rot, valid})
 *   (x/z = footprint min corner, as VC.world.addBuilding; called only on change, null clears), a voxel service
 *   coverage ring (plus faint rings of existing buildings of the same service) and an entrance arrow.
 * CURSOR LABEL: div.tool-cursor in #ui (style: game/tools.css + .tc-good in ui/hud.css) with cost, size / count
 *   and a red reason ("Not enough money · $X short" included). A commit refused for money pulses the label: the
 *   HUD's 'noMoney' toast (emitted by VC.money.spend) is the only notification, tools never toast money failures
 *   themselves. Producers (power / water) say whether they connect ("Connected to grid ✔" or how to link them,
 *   from VC.actions.canPlace). Zoning previews the road reach: new tiles farther than C.ROAD_ACCESS from a
 *   street / avenue are tinted red and hatched, and the label counts them. The label flips above the cursor
 *   instead of covering the toolbar / active-tool chip. Select tool: resting on an empty zoned lot shows
 *   VC.sim.growReason ("No power", "No road access…", "Ready — waiting for developers").
 *   "Nothing to do here" results (QUIET: already built / zoned…) preview in neutral grey, not failure red.
 * FEEDBACK: other meaningful failures get ONE error sound + ONE (rate-limited) VC.ui.toast, shown directly
 *   (a bus 'toast' would add the audio module's notify sound on top of the error sound).
 * CONFIRMS: demolishing expensive / unique buildings asks first; the confirm re-checks, by id, that the very
 *   buildings it showed still stand and only demolishes those (the sim keeps running behind the dialog).
 * PHOTO MODE (VC.hud.uiHidden / photo): falls back to the select tool — no invisible edits.
 * Bus: emits 'tool' {key}, 'select' {building, x, z} | null, 'sfx'.
 */
const C = VC.C, M = VC.M;
const W = VC.world;
const STEP = C.STEP;

/* ------------------------------------------------------------------ */
/* Colors (linear-ish rgba for the gizmo shader)                        */
/* ------------------------------------------------------------------ */
/* Values > 1 are intentional: the scene is linear HDR, so previews glow slightly (and bloom with post).
 * Contrast on grass: "valid" is cyan / white (never green), "invalid" red; the residential zone preview is
 * a light mint fill with a bright outline so it separates from the lawn it is painted on. */
const COL = {
  ok: [0.3, 1.0, 1.45, 0.55],
  bad: [1.6, 0.22, 0.16, 0.6],
  skip: [1.0, 1.0, 1.0, 0.16],
  path: [0.06, 0.28, 0.42, 0.62],
  pathBad: [0.75, 0.05, 0.04, 0.62],
  pathLine: [0.7, 2.0, 2.7, 1],
  plineLine: [2.6, 2.1, 0.6, 1],
  badLine: [2.8, 0.45, 0.35, 1],
  center: [2.2, 2.2, 2.2, 0.9],
  upgrade: [0.3, 0.15, 0.65, 0.6],
  post: [1.6, 1.6, 1.6, 0.85],
  zone: { 1: [0.42, 1.35, 0.95, 0.62], 2: [0.04, 0.38, 1.0, 0.55], 3: [1.0, 0.62, 0.04, 0.55] },
  zoneDim: { 1: [0.42, 1.35, 0.95, 0.2], 2: [0.04, 0.38, 1.0, 0.16], 3: [1.0, 0.62, 0.04, 0.16] },
  zoneLine: { 1: [1.5, 3.2, 2.3, 1], 2: [0.7, 1.4, 2.6, 1], 3: [2.6, 1.9, 0.6, 1] },
  dezone: [0.9, 0.2, 0.08, 0.5],
  dezoneLine: [2.4, 0.8, 0.5, 1],
  bull: [1.0, 0.3, 0.04, 0.38],
  bullLine: [2.4, 0.8, 0.3, 1],
  bullB: [1.2, 0.18, 0.04, 0.34],
  pline: [0.55, 0.4, 0.03, 0.55],
  pylon: [1.2, 1.2, 1.3, 0.85],
  wire: [2.4, 2.0, 0.8, 1],
  trees: [0.05, 0.62, 0.1, 0.55],
  treesLine: [0.8, 2.4, 0.9, 1],
  raise: [0.05, 0.45, 1.0, 0.52],
  lower: [1.0, 0.35, 0.05, 0.52],
  level: [0.95, 0.85, 0.35, 0.52],
  hover: [1.0, 1.0, 1.0, 0.06],
  sel: [0.35, 0.9, 1.4, 0.08],
  ghostOk: [0.3, 1.0, 1.45, 0.45],
  ghostBad: [1.1, 0.08, 0.05, 0.5],
  arrowOk: [1.0, 2.4, 3.0, 1],
  arrowBad: [2.4, 0.7, 0.6, 1],
  // zone tiles beyond C.ROAD_ACCESS of a street: red-dim fill + a diagonal hatch stroke per tile
  far: [1.25, 0.2, 0.12, 0.44],
  farLine: [2.6, 0.55, 0.4, 0.9],
  // "nothing to do here" (already built / zoned): neutral grey, never the red of a real failure
  quiet: [0.8, 0.85, 0.95, 0.14],
  quietLine: [1.3, 1.35, 1.5, 0.55],
};
const SVC_COL = {
  police: [0.4, 0.75, 2.2], fire: [2.2, 0.55, 0.3], health: [2.2, 0.7, 1.3], edu: [1.3, 0.8, 2.2],
  park: [0.5, 2.2, 0.7], transit: [2.2, 1.3, 0.4], garbage: [1.6, 1.4, 0.7],
};

/* ------------------------------------------------------------------ */
/* Tool registry                                                        */
/* ------------------------------------------------------------------ */
const ROAD_TOOL = { road_street: 1, road_avenue: 2, road_highway: 3 };
const TERRAIN_MODE = { terrain_raise: 'raise', terrain_lower: 'lower', terrain_level: 'level' };
const QUIET = new Set(['Already built', 'Already zoned', 'Nothing to bulldoze', 'Nothing to dezone', 'Already level', 'No room for trees', 'Nothing to build', 'Nothing to zone here', 'Maximum height', 'Minimum depth', 'Blocked by buildings/roads', 'Out of bounds', 'Invalid position']);
const NO_MONEY = 'Not enough money';

function kindOf(key) {
  if (!key || key === 'select') return 'select';
  if (key.startsWith('bld:')) return 'bld';
  if (ROAD_TOOL[key]) return 'road';
  if (key.startsWith('zone_')) return 'zone';
  if (TERRAIN_MODE[key]) return 'terrain';
  return key; // bulldoze, pline, dezone, trees
}
/** Static tool definitions (costs etc. are resolved at query time). */
let REG = null;
function registry() {
  if (REG) return REG;
  REG = new Map();
  const add = (o) => REG.set(o.key, o);
  add({ key: 'select', group: null, name: 'Inspect', icon: '👆', hotkey: 'Esc', desc: 'Click buildings and land to inspect them. Drag to pan.' });
  for (const t of [1, 2, 3]) {
    const r = VC.ROADS[t];
    add({ key: 'road_' + r.key, group: 'roads', name: r.name, icon: r.icon, base: r.cost, costUnit: '/tile', unlockKey: r.key, unlock: r.unlock || 0, upkeep: r.upkeep, desc: r.desc + ' Drag to build; hold Shift for a straight line. Bridges cost ×' + C.BRIDGE_MUL + '.' });
  }
  for (const z of VC.ZONE_TOOLS) {
    const what = { 1: 'homes', 2: 'shops and offices', 3: 'factories and warehouses' }[z.type];
    add({ key: z.key, group: 'zones', name: z.name, icon: z.icon, base: z.cost, costUnit: '/tile', unlockKey: z.key, unlock: z.unlock || 0, zt: z.type, den: z.den, desc: 'Drag a rectangle to zone land for ' + what + '. Needs road access, power' + (z.den >= 2 ? ' and water' : '') + ' to grow.' });
  }
  add({ key: 'dezone', group: 'zones', name: 'Dezone', icon: '🧽', base: 0, desc: 'Drag to remove zoning. Buildings grown on dezoned land are demolished ($' + 5 + '/tile).' });
  add({ key: 'pline', group: 'power', name: 'Power Line', icon: '🔌', base: C.PLINE_COST, costUnit: '/tile', desc: 'Carries electricity across gaps. Drag to lay a line; crosses roads but not water or buildings.' });
  for (const d of VC.CATALOG) add({ key: 'bld:' + d.key, group: d.group, name: d.name, icon: d.icon, base: d.cost, unlockKey: d.key, unlock: d.unlock || 0, upkeep: d.upkeep || 0, size: d.size, def: d, desc: d.desc });
  add({ key: 'trees', group: 'parks', name: 'Plant Trees', icon: '🌲', base: C.TREE_COST, costUnit: '/tree', brush: true, desc: 'Hold and paint to plant trees (up to 3 per tile). Trees raise land value and soak up pollution. Ctrl+Wheel: brush size.' });
  add({ key: 'terrain_raise', group: 'terrain', name: 'Raise Land', icon: '⛰️', base: C.TERRAFORM_COST, costUnit: '/level', brush: true, desc: 'Hold to raise the ground. Raise the sea floor to create new land. Ctrl+Wheel: brush size.' });
  add({ key: 'terrain_lower', group: 'terrain', name: 'Lower Land', icon: '🕳️', base: C.TERRAFORM_COST, costUnit: '/level', brush: true, desc: 'Hold to dig down. Dig below sea level to create water. Ctrl+Wheel: brush size.' });
  add({ key: 'terrain_level', group: 'terrain', name: 'Level Land', icon: '📏', base: C.TERRAFORM_COST, costUnit: '/level', brush: true, desc: 'Flattens the ground to the height of the tile where you start (water → sea level).' });
  add({ key: 'bulldoze', group: 'bulldoze', name: 'Bulldozer', icon: '🚜', base: 0, hotkey: 'B', desc: 'Click or drag to demolish buildings, roads, power lines and trees. Clears rubble for free.' });
  return REG;
}
/** Group -> ordered tool keys. */
function groupKeys(group) {
  const out = [];
  for (const [k, t] of registry()) if (t.group === group) out.push(k);
  return out;
}
/** Policy active? (numeric levels; VC.actions.policyOn / VC.econ.isPolicyOn when present). */
function policyOn(key) {
  try {
    if (VC.actions && VC.actions.policyOn) return VC.actions.policyOn(key);
    if (VC.econ && VC.econ.isPolicyOn) return !!VC.econ.isPolicyOn(key);
  } catch (e) { /* fall through */ }
  const S = VC.state, v = S && S.policies ? S.policies[key] : 0;
  return v === true || v > 0;
}
/** Building counts per catalog key (cached per building version; used for unique landmarks). */
const countCache = { ver: -1, map: new Map() };
function builtCount(key) {
  const S = VC.state;
  if (countCache.ver !== S.ver.bld) {
    countCache.ver = S.ver.bld;
    countCache.map.clear();
    for (const b of S.buildings.values()) countCache.map.set(b.key, (countCache.map.get(b.key) || 0) + 1);
  }
  return countCache.map.get(key) || 0;
}
/** Resolves a static registry entry into a toolbar descriptor. */
function describe(t) {
  const S = VC.state;
  let m = 1;
  try { if (S) m = VC.money.costMul(); } catch (e) { m = 1; }
  const o = {
    key: t.key, name: t.name, icon: t.icon, desc: t.desc, group: t.group,
    cost: (t.base || 0) * m, costUnit: t.costUnit || '', unlock: t.unlock || 0,
    locked: !!(S && t.unlockKey && !W.isUnlocked(t.unlockKey)),
  };
  if (t.hotkey) o.hotkey = t.hotkey;
  if (t.upkeep != null) o.upkeep = t.upkeep;
  if (t.size) o.size = t.size.slice();
  if (t.brush) o.brush = true;
  if (t.zt) { o.zt = t.zt; o.den = t.den; }
  if (t.def) {
    o.def = t.def;
    if (t.def.unique) { o.unique = true; o.built = !!(S && builtCount(t.def.key) > 0); }
    if (t.def.requiresPolicy && S && !policyOn(t.def.requiresPolicy)) o.needsPolicy = t.def.requiresPolicy;
  }
  return o;
}

/* ------------------------------------------------------------------ */
/* Draw list (rebuilt when the plan changes, replayed every frame)      */
/* ------------------------------------------------------------------ */
const DL = { boxes: [], lines: [] };
function dlClear() {
  DL.boxes.length = 0;
  DL.lines.length = 0;
}
function dlBox(x0, y0, z0, x1, y1, z1, c, wire) {
  DL.boxes.push({ x0, y0, z0, x1, y1, z1, c, wire: !!wire });
}
function dlLine(x0, y0, z0, x1, y1, z1, c) {
  DL.lines.push({ x0, y0, z0, x1, y1, z1, c });
}
/** Tile top Y (water tiles: water surface). */
function topY(x, z) {
  const S = VC.state;
  return Math.max(S.height[z * S.W + x] * STEP, C.SEA_Y);
}
/**
 * Adds merged slabs for a rectangle: colorOf(x, z) -> color or null; consecutive tiles of a row with the same
 * color and the same top Y become one box (cheap previews for big rectangles).
 */
function dlRectRuns(r, colorOf, th = 0.06) {
  for (let z = r.z0; z <= r.z1; z++) {
    let sx = -1, sc = null, sy = 0;
    for (let x = r.x0; x <= r.x1 + 1; x++) {
      const c = x <= r.x1 ? colorOf(x, z) : null;
      const y = x <= r.x1 ? topY(x, z) : -1;
      if (sx >= 0 && (c !== sc || y !== sy)) {
        dlBox(sx + 0.03, sy + 0.012, z + 0.03, x - 0.03, sy + 0.012 + th, z + 0.97, sc, false);
        sx = -1;
      }
      if (sx < 0 && c) { sx = x; sc = c; sy = y; }
    }
  }
  if (DL.boxes.length > 1500) DL.boxes.length = 1500; // cap for giant drags on rugged terrain (outline stays)
}
/** Rectangle outline following the terrain (one segment per tile edge). */
function dlRectOutline(r, c) {
  const y = (x, z) => topY(M.clamp(x, r.x0, r.x1), M.clamp(z, r.z0, r.z1)) + 0.1;
  for (let x = r.x0; x <= r.x1; x++) {
    dlLine(x, y(x, r.z0), r.z0, x + 1, y(x, r.z0), r.z0, c);
    dlLine(x, y(x, r.z1), r.z1 + 1, x + 1, y(x, r.z1), r.z1 + 1, c);
  }
  for (let z = r.z0; z <= r.z1; z++) {
    dlLine(r.x0, y(r.x0, z), z, r.x0, y(r.x0, z), z + 1, c);
    dlLine(r.x1 + 1, y(r.x1, z), z, r.x1 + 1, y(r.x1, z), z + 1, c);
  }
}
/**
 * Terrain-following circle (service coverage). voxel = also a band of tile slabs along the circle
 * (a "pixelated" ring that reads well from any distance and matches the voxel look).
 */
function dlRing(cx, cz, r, rgb, alpha, voxel) {
  const S = VC.state;
  const segs = M.clamp(Math.round(r * 5), 24, 160);
  const c = [rgb[0], rgb[1], rgb[2], alpha];
  let px = cx + r, pz = cz, py = W.groundY(px, pz) + 0.14;
  for (let k = 1; k <= segs; k++) {
    const a = (k / segs) * M.PI2;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const inside = x >= 0 && z >= 0 && x < S.W && z < S.H;
    const y = (inside ? W.groundY(x, z) : C.SEA_Y) + 0.14;
    dlLine(px, py, pz, x, y, z, c);
    px = x; pz = z; py = y;
  }
  if (!voxel) return;
  const m = Math.max(rgb[0], rgb[1], rgb[2]) || 1;
  const band = [(rgb[0] / m) * 0.85, (rgb[1] / m) * 0.85, (rgb[2] / m) * 0.85, 0.45];
  const z0 = Math.max(0, Math.floor(cz - r - 1)), z1 = Math.min(S.H - 1, Math.ceil(cz + r + 1));
  const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(S.W - 1, Math.ceil(cx + r + 1));
  const lo = (r - 0.5) * (r - 0.5), hi = (r + 0.5) * (r + 0.5);
  for (let z = z0; z <= z1; z++) {
    let sx = -1, sy = 0;
    for (let x = x0; x <= x1 + 1; x++) {
      let on = false, y = 0;
      if (x <= x1) {
        const dx = x + 0.5 - cx, dz = z + 0.5 - cz, d2 = dx * dx + dz * dz;
        on = d2 >= lo && d2 < hi;
        y = topY(x, z);
      }
      if (sx >= 0 && (!on || y !== sy)) {
        dlBox(sx + 0.08, sy + 0.012, z + 0.08, x - 0.08, sy + 0.07, z + 0.92, band, false);
        sx = -1;
      }
      if (on && sx < 0) { sx = x; sy = y; }
    }
  }
}
/** Wire box around a building. */
function dlBuilding(b, c) {
  const y = W.topY(b.x, b.z);
  dlBox(b.x + 0.02, y, b.z + 0.02, b.x + b.w - 0.02, y + Math.max(0.3, b.hgt || 1) + 0.04, b.z + b.d - 0.02, c, true);
}
function replay() {
  const G = VC.gfx.gizmo;
  if (!G) return;
  for (const b of DL.boxes) G.box(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, b.c, b.wire);
  for (const l of DL.lines) G.line(l.x0, l.y0, l.z0, l.x1, l.y1, l.z1, l.c);
}

/* ------------------------------------------------------------------ */
/* Tools                                                                */
/* ------------------------------------------------------------------ */
const hoverObj = { x: 0, z: 0 };
const sig = new Float64Array(24);
const sigNew = new Float64Array(24);
let sigKey = '';
let planDirty = true;
let policyVer = 0;
let gridA = 0;
let ghostSig = '';
let label = null, labelHtml = '', labelShown = false, labelX = -1, labelY = -1;
let lastToast = -1e9, lastSfx = -1e9;
let camSig = new Float32Array(16), camPx = -1, camPy = -1, camVer = -1;
let svcCache = { ver: -1, list: [] };

const T = (VC.tools = {
  current: 'select',
  kind: 'select',
  hover: null,
  hoverId: 0,
  selectedId: 0,
  rotation: 0,
  manualRot: false,
  ghostRot: 0,
  brush: { terrain: 1, trees: 1 },
  plan: null,
  drag: null,
  px: 0, py: 0, inside: false,
  confirmDemolish: true, // ask before bulldozing expensive/unique buildings

  init() {
    registry();
    if (VC.gfx && VC.gfx.addLayer) VC.gfx.addLayer(LAYER);
    const root = document.getElementById('ui') || document.body;
    label = VC.h('div', { class: 'tool-cursor' });
    root.appendChild(label);
    VC.bus.on('policyChanged', () => { policyVer++; planDirty = true; });
    VC.bus.on('loanChanged', () => { planDirty = true; });
    VC.bus.on('settings', () => { planDirty = true; });
    VC.bus.on('bldRemove', (b) => {
      if (T.hoverId === b.id) T.hoverId = 0;
      if (T.selectedId !== b.id) return;
      setTimeout(() => {
        const S = VC.state;
        if (T.selectedId === b.id && (!S || !S.buildings.has(b.id))) T.selectedId = 0;
      }, 0);
    });
  },

  reset() {
    T.current = 'select';
    T.kind = 'select';
    T.drag = null;
    T.hover = null;
    T.hoverId = 0;
    T.selectedId = 0;
    T.rotation = 0;
    T.manualRot = false;
    T.plan = null;
    planDirty = true;
    dlClear();
    ghostSig = '-';
    setGhost(null);
    showLabel(false);
    svcCache.ver = -1;
    countCache.ver = -1;
  },

  /* ---------------- catalog ---------------- */
  /** Toolbar descriptors of a group (all tools when group is omitted). */
  list(group) {
    const out = [];
    if (group == null) {
      for (const t of registry().values()) if (t.group) out.push(describe(t));
      return out;
    }
    for (const k of groupKeys(group)) out.push(describe(registry().get(k)));
    return out;
  },
  info(key) {
    const t = registry().get(key);
    return t ? describe(t) : null;
  },
  isTool(key) {
    return registry().has(key);
  },

  /* ---------------- selection ---------------- */
  select(key) {
    if (!key || !registry().has(key)) key = 'select';
    T.cancelDrag();
    if (key !== T.current) T.manualRot = false;
    T.current = key;
    T.kind = kindOf(key);
    T.plan = null;
    planDirty = true;
    dlClear();
    setGhost(null);
    if (T.kind !== 'select') T.hoverId = 0;
    camPx = -1; // re-pick: select/bulldoze pick buildings, the other tools only the ground
    VC.bus.emit('tool', { key });
  },
  /** Grid visibility for the terrain shader: fades in while a build tool is active. */
  gridAlpha() {
    return gridA;
  },
  isBrush() {
    return T.kind === 'terrain' || T.kind === 'trees';
  },
  brushSize() {
    return T.kind === 'terrain' ? T.brush.terrain : T.kind === 'trees' ? T.brush.trees : 0;
  },
  /** Changes the brush radius of the active brush tool (0..3). Returns the new radius or -1. */
  adjustBrush(delta) {
    const k = T.kind === 'terrain' ? 'terrain' : T.kind === 'trees' ? 'trees' : null;
    if (!k) return -1;
    const r = M.clamp(T.brush[k] + (delta > 0 ? 1 : -1), 0, 3);
    if (r !== T.brush[k]) {
      T.brush[k] = r;
      planDirty = true;
      VC.bus.emit('sfx', { name: 'click', vol: 0.4 });
    }
    return r;
  },
  /** Rotates the building ghost (R). Returns true if a building tool is active. */
  rotate(dir = 1) {
    if (T.kind !== 'bld') return false;
    T.rotation = ((T.manualRot ? T.rotation : T.ghostRot) + (dir < 0 ? 3 : 1)) & 3;
    T.manualRot = true;
    planDirty = true;
    VC.bus.emit('sfx', { name: 'click', vol: 0.5 });
    return true;
  },
  dragging() {
    return !!T.drag;
  },
  /** Pulsing marker on a footprint for a few seconds (e.g. the HUD's problems chip showing an example lot). */
  ping(x, z, w, d, sec) {
    const S = VC.state;
    if (!S || !Number.isFinite(x) || !Number.isFinite(z)) return;
    PING.x = x | 0; PING.z = z | 0; PING.w = Math.max(1, w | 0 || 1); PING.d = Math.max(1, d | 0 || 1);
    PING.until = performance.now() + (sec || 3.5) * 1000;
  },

  /* ---------------- pointer (called by VC.input) ---------------- */
  /** Cursor position in canvas CSS px; inside = the pointer is over the canvas (not over UI). */
  pointer(px, py, inside) {
    T.px = px;
    T.py = py;
    T.inside = !!inside;
  },
  /** Primary button / touch down with a build tool. */
  down(px, py) {
    const S = VC.state;
    if (!S || T.kind === 'select') return false;
    T.pointer(px, py, true);
    pick(true);
    const h = T.hover;
    if (!h) return false;
    const k = T.kind;
    const d = { kind: k, sx: h.x, sz: h.z, ex: h.x, ez: h.z, lastX: h.x, lastZ: h.z, acc: 0, warned: false, placed: 0, group: false, level: 0 };
    T.drag = d;
    planDirty = true;
    if (k === 'bld') {
      const def = VC.BLD[T.current.slice(4)];
      d.multi = !!def && def.size[0] === 1 && def.size[1] === 1;
      if (d.multi) {
        VC.actions.beginGroup(def.name);
        d.group = true;
        feedback(placeAtHover(false));
      }
    } else if (k === 'trees' || k === 'terrain') {
      VC.actions.beginGroup(k === 'trees' ? 'Trees' : 'Terraform');
      d.group = true;
      if (k === 'terrain') d.level = Math.max(C.SEA, S.height[h.z * S.W + h.x]);
      applyBrush(d, false);
    }
    return true;
  },
  move(px, py) {
    T.pointer(px, py, true);
    if (T.drag) track();
  },
  /** Release: commits drags. */
  up(px, py) {
    const d = T.drag;
    if (!d) return;
    if (px != null) T.pointer(px, py, true);
    track();
    T.drag = null;
    planDirty = true;
    const S = VC.state;
    if (!S) { if (d.group) VC.actions.endGroup(); return; }
    let res = null;
    switch (d.kind) {
      case 'road': res = VC.actions.buildRoad(VC.actions.roadPath(d.sx, d.sz, d.ex, d.ez, straightHeld()), ROAD_TOOL[T.current]); break;
      case 'pline': res = VC.actions.powerLine(VC.actions.roadPath(d.sx, d.sz, d.ex, d.ez, straightHeld())); break;
      case 'zone': {
        const zt = VC.ZONE_TOOLS.find((z) => z.key === T.current);
        if (zt) res = VC.actions.zone(d.sx, d.sz, d.ex, d.ez, zt.code);
        break;
      }
      case 'dezone': res = VC.actions.zone(d.sx, d.sz, d.ex, d.ez, 0); break;
      case 'bulldoze': res = bulldozeRect(d.sx, d.sz, d.ex, d.ez); break;
      case 'bld':
        if (!d.multi) res = placeAtHover(false);
        break;
    }
    if (d.group) VC.actions.endGroup();
    if (res) feedback(res);
  },
  /** Select-tool click: inspect a building / tile. */
  click(px, py) {
    const S = VC.state;
    if (!S) return;
    const hit = VC.camera.raycast(px, py);
    if (!hit || hit.offMap || !W.inb(hit.x, hit.z)) {
      T.selectedId = 0;
      VC.bus.emit('select', null);
      return;
    }
    if (hit.building) {
      T.selectedId = hit.building.id;
      VC.bus.emit('select', { building: hit.building, x: hit.x, z: hit.z });
    } else {
      T.selectedId = 0;
      VC.bus.emit('select', { building: null, x: hit.x, z: hit.z });
    }
    VC.bus.emit('sfx', { name: 'click', vol: 0.5 });
  },
  /** Bulldozes one building (Delete key on the selection), with the usual landmark confirmation. */
  demolish(b) {
    const S = VC.state;
    if (!b || !S || S.buildings.get(b.id) !== b) return;
    feedback(bulldozeRect(b.x, b.z, b.x + b.w - 1, b.z + b.d - 1, { ids: [b.id], roads: false, trees: false, plines: false }));
  },
  /** Cancels the active drag (brush strokes keep what was already applied). */
  cancelDrag() {
    const d = T.drag;
    if (!d) return false;
    T.drag = null;
    planDirty = true;
    if (d.group) VC.actions.endGroup();
    return true;
  },
  /** Right-click / Esc: cancel the drag first, then fall back to the select tool. Returns what happened. */
  cancel() {
    if (T.cancelDrag()) return 'drag';
    if (T.current !== 'select') {
      T.select('select');
      return 'tool';
    }
    return false;
  },

  /* ---------------- frame ---------------- */
  update(dt, rdt) {
    const S = VC.state;
    const st = VC.settings || {};
    const target = !S || T.kind === 'select' || st.showGrid === false ? 0 : T.kind === 'bulldoze' ? 0.55 : 1;
    gridA = M.damp(gridA, target, 9, rdt || 0.016);
    if (gridA < 0.002 && target === 0) gridA = 0;
    if (!S || !VC.gfx || !VC.gfx.gizmo || !VC.camera) return;
    if ((VC.menu && VC.menu.active) || S.demo) {
      T.hover = null;
      setGhost(null);
      showLabel(false);
      return;
    }
    // photo mode / hidden UI: look, don't build (no invisible edits, clean screenshots)
    if (VC.hud && (VC.hud.uiHidden || VC.hud.photo) && T.current !== 'select') T.select('select');
    pick(false);
    if (T.drag) {
      track();
      stepDrag(rdt || 0.016);
    }
    refreshPlan();
    updateGhost();
    updateLabel();
  },
});

/**
 * Gizmo submission happens from a (GL-free) transparent render-layer callback: the core draws and clears
 * the gizmo buffers right after the transparent layers, so previews are emitted exactly once per rendered
 * frame no matter how often update() runs.
 */
const PING = { x: 0, z: 0, w: 1, d: 1, until: 0, c: [2.6, 1.9, 0.5, 1], f: [1.6, 1.1, 0.2, 0.3] };
const LAYER = {
  name: 'tools',
  order: 990,
  transparent() {
    const S = VC.state;
    if (!S || S.demo || (VC.menu && VC.menu.active) || !VC.gfx.gizmo) return;
    replay();
    if (T.kind === 'select') drawSelect();
    if (PING.until) drawPing(S);
  },
};
/** The ping marker: a gold slab + a column that pulses, fading out at the end. */
function drawPing(S) {
  const now = performance.now();
  const left = PING.until - now;
  if (left <= 0 || PING.x >= S.W || PING.z >= S.H) { PING.until = 0; return; }
  const G = VC.gfx.gizmo;
  const pulse = 0.5 + 0.5 * Math.sin(now * 0.009);
  const fade = Math.min(1, left / 600);
  const y = topY(M.clamp(PING.x, 0, S.W - 1), M.clamp(PING.z, 0, S.H - 1));
  const g = 0.12 + pulse * 0.18;
  PING.f[3] = (0.22 + 0.25 * pulse) * fade;
  PING.c[3] = fade;
  G.box(PING.x - g, y + 0.02, PING.z - g, PING.x + PING.w + g, y + 0.1, PING.z + PING.d + g, PING.f, false);
  G.box(PING.x - g, y, PING.z - g, PING.x + PING.w + g, y + 0.6 + pulse * 0.5, PING.z + PING.d + g, PING.c, true);
}

/* ------------------------------------------------------------------ */
/* Picking                                                              */
/* ------------------------------------------------------------------ */
/** Raycasts the cursor (cached: only when the cursor, camera or world changed). */
function pick(force) {
  const S = VC.state, cam = VC.camera;
  if (!T.inside && !T.drag) {
    T.hover = null;
    T.hoverId = 0;
    return;
  }
  const vp = cam.viewProj;
  let same = !force && T.px === camPx && T.py === camPy && camVer === S.ver.terrain + S.ver.bld * 4096;
  if (same) for (let k = 0; k < 16; k++) if (vp[k] !== camSig[k]) { same = false; break; }
  if (same) return;
  camSig.set(vp);
  camPx = T.px;
  camPy = T.py;
  camVer = S.ver.terrain + S.ver.bld * 4096;
  const withB = T.kind === 'select' || T.kind === 'bulldoze';
  const hit = cam.raycast(T.px, T.py, { ignoreBuildings: !withB });
  T.hoverId = hit && hit.building ? hit.building.id : 0;
  if (!hit) {
    if (!T.drag) T.hover = null;
    return;
  }
  const x = M.clamp(hit.x, 0, S.W - 1), z = M.clamp(hit.z, 0, S.H - 1);
  if (hit.offMap && !T.drag) {
    T.hover = null;
    return;
  }
  hoverObj.x = x;
  hoverObj.z = z;
  T.hover = hoverObj;
}
/** Updates the drag end from the hover tile. */
function track() {
  const d = T.drag;
  if (!d) return;
  pick(false);
  const h = T.hover;
  if (!h) return;
  if (h.x !== d.ex || h.z !== d.ez) {
    d.ex = h.x;
    d.ez = h.z;
    planDirty = true;
  }
}
function straightHeld() {
  const I = VC.input;
  return !!(I && I.mods && I.mods.shift);
}

/* ------------------------------------------------------------------ */
/* Drag steps (brushes, multi-place)                                    */
/* ------------------------------------------------------------------ */
function stepDrag(rdt) {
  const d = T.drag, h = T.hover;
  if (!d || !h) return;
  d.acc += rdt;
  const moved = h.x !== d.lastX || h.z !== d.lastZ;
  if (d.kind === 'bld' && d.multi) {
    if (moved) {
      d.lastX = h.x;
      d.lastZ = h.z;
      placeAtHover(true);
    }
  } else if (d.kind === 'trees') {
    if ((moved && d.acc > 0.05) || d.acc >= 0.3) applyBrush(d, true);
  } else if (d.kind === 'terrain') {
    const mode = TERRAIN_MODE[T.current];
    if (mode === 'level' ? moved || d.acc >= 0.25 : (moved && d.acc > 0.08) || d.acc >= 0.22) applyBrush(d, true);
  }
}
function applyBrush(d, repeat) {
  const h = T.hover;
  if (!h) return;
  d.acc = 0;
  d.lastX = h.x;
  d.lastZ = h.z;
  const A = VC.actions;
  const trees = d.kind === 'trees';
  const mode = TERRAIN_MODE[T.current];
  const tiles = trees ? A.brushTiles(h.x, h.z, T.brush.trees) : null;
  const lvl = mode === 'level' ? d.level : null;
  if (repeat && d.noMoney) {
    // still short of money: validate only, so a held brush does not fire 'noMoney' several times a second
    const plan = trees ? A.canPlantTrees(0, 0, 0, 0, { tiles }) : A.canTerraform(h.x, h.z, T.brush.terrain, mode, lvl);
    if (!plan.ok && plan.money) return;
  }
  const now = performance.now();
  const quiet = repeat && now - lastSfx < 280;
  if (!quiet) lastSfx = now;
  const res = trees ? A.plantTrees(0, 0, 0, 0, { tiles, quiet }) : A.terraform(h.x, h.z, T.brush.terrain, mode, lvl, { quiet });
  if (!res.ok && res.reason === NO_MONEY) d.noMoney = true;
  planDirty = true;
  if (!res.ok && !d.warned && !(repeat && QUIET.has(res.reason))) {
    if (!QUIET.has(res.reason)) d.warned = true;
    feedback(res);
  }
}
/**
 * Places the current building at the ghost position. quiet: row placement — tiles that cannot take the building
 * are skipped without feedback; a money shortage is committed (and so reported by VC.money) once per drag only.
 */
function placeAtHover(quiet) {
  const g = ghostPos();
  if (!g) return null;
  const d = T.drag;
  if (quiet) {
    const p = VC.actions.canPlace(g.key, g.x, g.z, g.rot);
    if (!p.ok && (!p.money || !d || d.noMoney)) return null;
  }
  const res = VC.actions.placeBuilding(g.key, g.x, g.z, g.rot, { quiet: quiet && d && d.placed > 0 && performance.now() - lastSfx < 150 });
  if (res.ok) {
    lastSfx = performance.now();
    if (d) d.placed++;
  } else if (res.reason === NO_MONEY && d) d.noMoney = true;
  planDirty = true;
  if (!quiet || res.ok) return res;
  if (res.reason === NO_MONEY) flashLabel();
  return null;
}
/**
 * Bulldoze with a confirmation for expensive / unique buildings. opts: VC.actions.bulldoze options (ids, roads…).
 * The confirm callback runs later (the sim keeps going behind the modal): it re-validates by id that the shown
 * landmarks still stand and demolishes only the buildings the dialog listed.
 */
function bulldozeRect(x0, z0, x1, z1, opts) {
  const A = VC.actions;
  const p = A.canBulldoze(x0, z0, x1, z1, opts);
  // short of money: commit anyway so VC.money reports it (the HUD's single 'noMoney' notification)
  if (!p.ok) return p.money ? A.bulldoze(x0, z0, x1, z1, opts) : p;
  const pricey = p.buildings.filter((b) => {
    const def = VC.BLD[b.key];
    return def && (def.unique || def.cost >= 20000);
  });
  if (T.confirmDemolish && pricey.length && VC.ui && VC.ui.confirm) {
    const names = pricey.slice(0, 3).map((b) => esc(VC.sim && VC.sim.buildingName ? safeName(b) : VC.BLD[b.key].name));
    const more = pricey.length > 3 ? ` and ${pricey.length - 3} more` : '';
    const o = Object.assign({}, opts || {}, { ids: p.buildings.map((b) => b.id) });
    VC.ui.confirm(`Demolish <b>${names.join(', ')}</b>${more}? This costs ${VC.fmt.money(p.cost)} and cannot be refunded.`, () => {
      const S = VC.state;
      if (!S || pricey.some((b) => S.buildings.get(b.id) !== b)) {
        notify(pricey.length > 1 ? 'Those buildings are already gone.' : 'That building is already gone.', 'info', '🚜');
        return;
      }
      feedback(A.bulldoze(x0, z0, x1, z1, o));
    }, { title: '🚜 Demolish?', yes: 'Demolish' });
    return null;
  }
  return A.bulldoze(x0, z0, x1, z1, opts);
}
function safeName(b) {
  try { return VC.sim.buildingName(b) || VC.BLD[b.key].name; } catch (e) { return VC.BLD[b.key].name; }
}
/** One visible message, no extra sound (never over the title-screen demo). text is HTML. */
function notify(html, type, icon) {
  const S = VC.state;
  if ((S && S.demo) || !VC.ui || !VC.ui.toast) return null;
  return VC.ui.toast(html, { type, icon });
}
/**
 * Success is audible via actions' sfx. Money failures: VC.money.spend already emitted 'noMoney' (HUD toast +
 * sound), so only the cursor label reacts. Other failures: one error sound + one rate-limited toast.
 */
function feedback(res) {
  if (!res || res.ok) return;
  if (res.reason === NO_MONEY) { flashLabel(); return; }
  if (QUIET.has(res.reason)) return;
  VC.bus.emit('sfx', { name: 'error' });
  const now = performance.now();
  if (now - lastToast < 900) return;
  lastToast = now;
  notify(esc(res.reason), 'warn', '🚧');
}

/* ------------------------------------------------------------------ */
/* Plan + preview                                                       */
/* ------------------------------------------------------------------ */
/** Current building ghost placement: {key, def, x, z, rot, w, d} (cursor = footprint center). */
function ghostPos() {
  const h = T.hover;
  if (!h || T.kind !== 'bld') return null;
  const key = T.current.slice(4), def = VC.BLD[key];
  if (!def) return null;
  let rot = T.rotation & 3;
  if (!T.manualRot) {
    const r = autoRot(def, h.x, h.z);
    if (r >= 0) rot = r;
    T.rotation = rot;
  }
  T.ghostRot = rot;
  const w = rot & 1 ? def.size[1] : def.size[0], d = rot & 1 ? def.size[0] : def.size[1];
  return { key, def, rot, w, d, x: h.x - ((w - 1) >> 1), z: h.z - ((d - 1) >> 1) };
}
/** First rotation (starting with the current one) whose front edge touches an access road; -1 none. */
function autoRot(def, hx, hz) {
  const S = VC.state;
  const road = (x, z) => {
    if (!W.inb(x, z)) return false;
    const r = S.road[z * S.W + x];
    return r && VC.ROADS[r].access;
  };
  for (let k = 0; k < 4; k++) {
    const rot = (T.rotation + k) & 3;
    const w = rot & 1 ? def.size[1] : def.size[0], d = rot & 1 ? def.size[0] : def.size[1];
    const x = hx - ((w - 1) >> 1), z = hz - ((d - 1) >> 1);
    let ok = false;
    if (rot === 0) for (let i = x; i < x + w && !ok; i++) ok = road(i, z + d);
    else if (rot === 1) for (let i = z; i < z + d && !ok; i++) ok = road(x + w, i);
    else if (rot === 2) for (let i = x; i < x + w && !ok; i++) ok = road(i, z - 1);
    else for (let i = z; i < z + d && !ok; i++) ok = road(x - 1, i);
    if (ok) return rot;
  }
  return -1;
}

function refreshPlan() {
  const S = VC.state;
  const d = T.drag, h = T.hover;
  let n = 0;
  const put = (v) => { sigNew[n++] = v; };
  put(h ? h.x : -1); put(h ? h.z : -1);
  put(d ? d.sx : -1); put(d ? d.sz : -1); put(d ? d.ex : -1); put(d ? d.ez : -1);
  put(straightHeld() ? 1 : 0); put(T.rotation); put(T.manualRot ? 1 : 0);
  put(T.brush.terrain); put(T.brush.trees);
  put(S.ver.terrain); put(S.ver.bld); put(S.ver.trees);
  put(Math.floor(S.money)); put(S.peakPop); put(policyVer); put(d ? d.level : -1);
  let same = !planDirty && sigKey === T.current;
  if (same) for (let k = 0; k < n; k++) if (sig[k] !== sigNew[k]) { same = false; break; }
  if (same) return;
  sig.set(sigNew);
  sigKey = T.current;
  planDirty = false;
  dlClear();
  T.plan = null;
  try {
    buildPlan();
  } catch (e) {
    console.error('[tools] preview failed', e);
    T.plan = null;
    dlClear();
  }
}

function buildPlan() {
  const S = VC.state;
  const A = VC.actions;
  const d = T.drag, h = T.hover;
  const k = T.kind;
  if (k === 'select') return;
  if (!h && !d) return;
  const sx = d ? d.sx : h.x, sz = d ? d.sz : h.z, ex = d ? d.ex : h.x, ez = d ? d.ez : h.z;
  if (k === 'road' || k === 'pline') {
    const path = A.roadPath(sx, sz, ex, ez, straightHeld());
    const res = k === 'road' ? A.canBuildRoad(path, ROAD_TOOL[T.current]) : A.canPowerLine(path);
    if (!res.tiles) res.tiles = path; // (actions return the de-duplicated list the status array indexes)
    res.kind = k;
    T.plan = res;
    drawPath(res, res.tiles, k);
  } else if (k === 'zone' || k === 'dezone') {
    const zt = VC.ZONE_TOOLS.find((z) => z.key === T.current);
    const code = k === 'zone' && zt ? zt.code : 0;
    const res = A.canZone(sx, sz, ex, ez, code);
    res.kind = k;
    res.far = 0;
    if (code && res.rect && res.status) {
      // tiles too far from a street never grow: count them for the label, tint them in the preview
      const r = res.rect;
      roadReach(r);
      for (let z = r.z0; z <= r.z1; z++)
        for (let x = r.x0; x <= r.x1; x++) if (res.status[(z - r.z0) * r.w + (x - r.x0)] === 1 && !inReach(x, z)) res.far++;
    }
    T.plan = res;
    drawZone(res, code);
  } else if (k === 'bulldoze') {
    const res = A.canBulldoze(sx, sz, ex, ez);
    res.kind = k;
    T.plan = res;
    drawBulldoze(res, !!d);
  } else if (k === 'bld') {
    const g = ghostPos();
    if (!g) return;
    const res = A.canPlace(g.key, g.x, g.z, g.rot);
    res.kind = k;
    res.ghost = g;
    T.plan = res;
    drawBuilding(res, g);
  } else if (k === 'trees') {
    if (!h) return;
    const tiles = A.brushTiles(h.x, h.z, T.brush.trees);
    const res = A.canPlantTrees(0, 0, 0, 0, { tiles });
    res.kind = k;
    res.brush = tiles;
    T.plan = res;
    drawTrees(res, tiles);
  } else if (k === 'terrain') {
    if (!h) return;
    const mode = TERRAIN_MODE[T.current];
    const lvl = mode === 'level' ? (d ? d.level : Math.max(C.SEA, S.height[h.z * S.W + h.x])) : null;
    const res = A.canTerraform(h.x, h.z, T.brush.terrain, mode, lvl);
    res.kind = k;
    T.plan = res;
    drawTerrain(res, mode);
  }
}

/**
 * Road / power line path: a dark translucent ribbon (reads on grass, sand and snow alike) with a glowing
 * outline, a centre line showing the direction, and end posts. Road tiles are drawn at their planned
 * level (bridges at deck level; tiles to be dug down stay on the surface so they never hide inside it).
 */
function drawPath(res, tiles, k) {
  const S = VC.state;
  const n = tiles.length;
  if (!n) return;
  const allOk = res.ok;
  const quiet = !allOk && QUIET.has(res.reason); // e.g. 'Already built' right after a drag: neutral, not red
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = tiles[i], cur = topY(t.x, t.z);
    if (k === 'road') {
      const bridge = S.height[t.z * S.W + t.x] < C.SEA;
      ys[i] = bridge ? VC.actions.DECK_LVL * STEP : Math.max(cur, res.levels[i] * STEP);
    } else ys[i] = cur;
  }
  const line = allOk ? (k === 'pline' ? COL.plineLine : COL.pathLine) : quiet ? COL.quietLine : COL.badLine;
  for (let i = 0; i < n; i++) {
    const t = tiles[i], st = res.status[i], y = ys[i];
    let c;
    if (st === 3) c = COL.pathBad;
    else if (st === 1) c = quiet ? COL.quiet : COL.skip;
    else if (!allOk) c = quiet ? COL.quiet : COL.pathBad;
    else if (st === 2) c = COL.upgrade;
    else c = k === 'pline' ? COL.pline : COL.path;
    dlBox(t.x + 0.04, y + 0.02, t.z + 0.04, t.x + 0.96, y + 0.12, t.z + 0.96, c, false);
    // outline: edges not shared with the previous / next tile of the path
    const p = i > 0 ? tiles[i - 1] : null, q = i < n - 1 ? tiles[i + 1] : null;
    const link = (dx, dz) => (p && p.x === t.x + dx && p.z === t.z + dz) || (q && q.x === t.x + dx && q.z === t.z + dz);
    const ly = y + 0.125, lc = st === 3 ? COL.badLine : line;
    if (!link(0, -1)) dlLine(t.x + 0.04, ly, t.z + 0.04, t.x + 0.96, ly, t.z + 0.04, lc);
    if (!link(0, 1)) dlLine(t.x + 0.04, ly, t.z + 0.96, t.x + 0.96, ly, t.z + 0.96, lc);
    if (!link(-1, 0)) dlLine(t.x + 0.04, ly, t.z + 0.04, t.x + 0.04, ly, t.z + 0.96, lc);
    if (!link(1, 0)) dlLine(t.x + 0.96, ly, t.z + 0.04, t.x + 0.96, ly, t.z + 0.96, lc);
    // centre line toward the next tile (direction of the drag)
    if (q) dlLine(t.x + 0.5, ly, t.z + 0.5, q.x + 0.5, ys[i + 1] + 0.125, q.z + 0.5, allOk ? COL.center : quiet ? COL.quietLine : COL.badLine);
    if (k === 'pline') {
      // pylons + wire preview
      const py = y + 0.62;
      dlBox(t.x + 0.45, y, t.z + 0.45, t.x + 0.55, py, t.z + 0.55, st === 3 || (!allOk && !quiet) ? COL.pathBad : COL.pylon, false);
      if (p) dlLine(p.x + 0.5, ys[i - 1] + 0.62, p.z + 0.5, t.x + 0.5, py, t.z + 0.5, allOk ? COL.wire : quiet ? COL.quietLine : COL.badLine);
    }
  }
  // start / end posts
  const ends = n > 1 ? [0, n - 1] : [0];
  for (const i of ends) {
    const t = tiles[i], y = ys[i];
    dlBox(t.x + 0.4, y, t.z + 0.4, t.x + 0.6, y + 0.5, t.z + 0.6, allOk || quiet ? COL.post : COL.pathBad, false);
  }
}

/*
 * Road reach of a zone rectangle (preview only): distance in 4-neighbour steps from the nearest street / avenue
 * tile, not crossing open water — the sim's access rule (sim_net computeAccess). Searched in the rectangle grown
 * by C.ROAD_ACCESS (a road farther out cannot reach inside), into reused scratch arrays.
 */
const RCH = { d: new Uint8Array(0), q: new Int32Array(0), x0: 0, z0: 0, gw: 0 };
function roadReach(r) {
  const S = VC.state, R = C.ROAD_ACCESS;
  const x0 = Math.max(0, r.x0 - R), z0 = Math.max(0, r.z0 - R), x1 = Math.min(S.W - 1, r.x1 + R), z1 = Math.min(S.H - 1, r.z1 + R);
  const gw = x1 - x0 + 1, gd = z1 - z0 + 1, n = gw * gd;
  if (RCH.d.length < n) { RCH.d = new Uint8Array(Math.ceil(n * 1.25)); RCH.q = new Int32Array(Math.ceil(n * 1.25)); }
  const dist = RCH.d, q = RCH.q, SW = S.W, road = S.road, hgt = S.height, SEA = C.SEA;
  dist.fill(255, 0, n);
  let qt = 0, qh = 0;
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const t = road[z * SW + x];
      if (t && VC.ROADS[t] && VC.ROADS[t].access) { const k = (z - z0) * gw + (x - x0); dist[k] = 0; q[qt++] = k; }
    }
  while (qh < qt) {
    const k = q[qh++], nd = dist[k] + 1;
    if (nd > R) continue;
    const lx = k % gw, lz = (k - lx) / gw, gx = x0 + lx, gz = z0 + lz;
    if (lx > 0 && dist[k - 1] > nd && hgt[gz * SW + gx - 1] >= SEA) { dist[k - 1] = nd; q[qt++] = k - 1; }
    if (lx < gw - 1 && dist[k + 1] > nd && hgt[gz * SW + gx + 1] >= SEA) { dist[k + 1] = nd; q[qt++] = k + 1; }
    if (lz > 0 && dist[k - gw] > nd && hgt[(gz - 1) * SW + gx] >= SEA) { dist[k - gw] = nd; q[qt++] = k - gw; }
    if (lz < gd - 1 && dist[k + gw] > nd && hgt[(gz + 1) * SW + gx] >= SEA) { dist[k + gw] = nd; q[qt++] = k + gw; }
  }
  RCH.x0 = x0; RCH.z0 = z0; RCH.gw = gw;
}
/** Is tile (x,z) of the last roadReach() rectangle within reach of a street? */
const inReach = (x, z) => RCH.d[(z - RCH.z0) * RCH.gw + (x - RCH.x0)] <= C.ROAD_ACCESS;

function drawZone(res, code) {
  const r = res.rect;
  if (!r) return;
  const st = res.status;
  if (code) {
    const zt = VC.ztype(code);
    const quiet = !res.ok && QUIET.has(res.reason);
    const cNew = res.ok ? COL.zone[zt] : COL.bad, cOld = COL.zoneDim[zt];
    const far = res.far > 0;
    dlRectRuns(r, (x, z) => {
      const s = st[(z - r.z0) * r.w + (x - r.x0)];
      return s === 1 ? (far && !inReach(x, z) ? COL.far : cNew) : s === 2 ? cOld : null;
    });
    if (far) {
      // one hatch stroke per out-of-reach tile (capped for giant drags)
      let n = 0;
      for (let z = r.z0; z <= r.z1 && n < 900; z++)
        for (let x = r.x0; x <= r.x1 && n < 900; x++) {
          if (st[(z - r.z0) * r.w + (x - r.x0)] !== 1 || inReach(x, z)) continue;
          const y = topY(x, z) + 0.09;
          dlLine(x + 0.12, y, z + 0.88, x + 0.88, y, z + 0.12, COL.farLine);
          n++;
        }
    }
    dlRectOutline(r, res.ok ? COL.zoneLine[zt] : quiet ? COL.quietLine : COL.bullLine);
  } else {
    dlRectRuns(r, (x, z) => (st[(z - r.z0) * r.w + (x - r.x0)] === 3 ? COL.dezone : null));
    for (const b of res.remove) dlBuilding(b, COL.bullB);
    dlRectOutline(r, COL.dezoneLine);
  }
}

function drawBulldoze(res, dragging) {
  const r = res.rect;
  if (!r) return;
  if (dragging || !res.buildings.length) dlRectRuns(r, () => COL.bull);
  for (const b of res.buildings) dlBuilding(b, COL.bullB);
  dlRectOutline(r, COL.bullLine);
}

function drawTrees(res, tiles) {
  const S = VC.state;
  const ok = new Set();
  for (const t of res.tiles) ok.add(t.z * S.W + t.x);
  for (const t of tiles) {
    if (!ok.has(t.z * S.W + t.x)) continue;
    const y = topY(t.x, t.z);
    dlBox(t.x + 0.06, y + 0.015, t.z + 0.06, t.x + 0.94, y + 0.08, t.z + 0.94, res.ok ? COL.trees : COL.bad, false);
  }
  brushOutline(tiles, COL.treesLine);
}

function drawTerrain(res, mode) {
  const c = !res.ok && res.money ? COL.bad : COL[mode] || COL.level;
  for (const t of res.tiles) {
    if (t.skip) {
      const y = topY(t.x, t.z);
      dlBox(t.x + 0.1, y + 0.02, t.z + 0.1, t.x + 0.9, y + 0.07, t.z + 0.9, COL.bad, false);
      continue;
    }
    const y = t.to * STEP;
    dlBox(t.x + 0.04, y + 0.015, t.z + 0.04, t.x + 0.96, y + 0.085, t.z + 0.96, c, false);
    // vertical guide showing the height change
    if (t.to !== t.from) dlLine(t.x + 0.5, t.from * STEP, t.z + 0.5, t.x + 0.5, t.to * STEP, t.z + 0.5, [c[0], c[1], c[2], 0.9]);
  }
  brushOutline(res.tiles, [c[0], c[1], c[2], 0.8]);
}
/** Outline of a tile set (edges not shared with another tile of the set). */
function brushOutline(tiles, c) {
  const S = VC.state;
  const set = new Set();
  for (const t of tiles) set.add(t.z * S.W + t.x);
  const has = (x, z) => W.inb(x, z) && set.has(z * S.W + x);
  for (const t of tiles) {
    const y = topY(t.x, t.z) + 0.1, x = t.x, z = t.z;
    if (!has(x, z - 1)) dlLine(x, y, z, x + 1, y, z, c);
    if (!has(x, z + 1)) dlLine(x, y, z + 1, x + 1, y, z + 1, c);
    if (!has(x - 1, z)) dlLine(x, y, z, x, y, z + 1, c);
    if (!has(x + 1, z)) dlLine(x + 1, y, z, x + 1, y, z + 1, c);
  }
}

function drawBuilding(res, g) {
  const S = VC.state;
  const { x, z, w, d, rot, def } = g;
  if (x + w <= 0 || z + d <= 0 || x >= S.W || z >= S.H) return;
  const cx = M.clamp(x, 0, S.W - 1), cz = M.clamp(z, 0, S.H - 1);
  const y = res.level ? res.level * STEP : topY(cx, cz);
  const ok = res.ok;
  // footprint pad, slightly larger than the lot so its rim and outline stay visible around the ghost
  dlBox(x - 0.06, y + 0.01, z - 0.06, x + w + 0.06, y + 0.1, z + d + 0.06, ok ? COL.ghostOk : COL.ghostBad, true);
  // fallback ghost volume when the renderer has no ghost support
  if (!(VC.bldgfx && VC.bldgfx.setGhost)) {
    let hgt = 1;
    try {
      const m = VC.models && VC.models.has && VC.models.has(def.key) ? VC.models.get(def.key, 0) : null;
      if (m && m.height) hgt = Math.min(6, m.height);
    } catch (e) { hgt = 1; }
    dlBox(x + 0.08, y + 0.1, z + 0.08, x + w - 0.08, y + hgt, z + d - 0.08, ok ? [0.3, 1.4, 0.6, 0.16] : [1.6, 0.25, 0.2, 0.22], true);
  }
  // entrance arrow (front edge)
  const mx = x + w / 2, mz = z + d / 2, ay = y + 0.14;
  const fx = [0, 1, 0, -1][rot], fz = [1, 0, -1, 0][rot];
  const ex = mx + fx * (w / 2 + 0.45), ez = mz + fz * (d / 2 + 0.45);
  const bx = mx + fx * (w / 2 + 0.05), bz = mz + fz * (d / 2 + 0.05);
  const ac = ok ? COL.arrowOk : COL.arrowBad;
  dlLine(bx, ay, bz, ex, ay, ez, ac);
  dlLine(ex, ay, ez, ex - fx * 0.2 + fz * 0.18, ay, ez - fz * 0.2 - fx * 0.18, ac);
  dlLine(ex, ay, ez, ex - fx * 0.2 - fz * 0.18, ay, ez - fz * 0.2 + fx * 0.18, ac);
  // service coverage: this building + faint rings of existing buildings of the same service
  if (def.cover) {
    for (const svc in def.cover) {
      const rgb = SVC_COL[svc] || [1, 1, 1];
      dlRing(mx, mz, def.cover[svc], rgb, ok ? 1 : 0.5, true);
      for (const e of serviceBuildings(svc)) {
        if (Math.abs(e.cx - mx) > e.r + 60 || Math.abs(e.cz - mz) > e.r + 60) continue;
        dlRing(e.cx, e.cz, e.r, rgb, 0.35, false);
      }
    }
  }
  // pollution footprint hint (industrial-strength buildings)
  if (def.pollR && def.pollution >= 80) dlRing(mx, mz, def.pollR, [1.3, 0.95, 0.4], 0.5, false);
}
/** Existing catalog buildings providing a service (cached per building version). */
function serviceBuildings(svc) {
  const S = VC.state;
  if (svcCache.ver !== S.ver.bld) {
    svcCache.ver = S.ver.bld;
    svcCache.list = [];
    for (const b of S.buildings.values()) {
      const def = VC.BLD[b.key];
      if (!def || !def.cover) continue;
      for (const s in def.cover) svcCache.list.push({ svc: s, cx: b.x + b.w / 2, cz: b.z + b.d / 2, r: def.cover[s] });
    }
  }
  const out = [];
  for (const e of svcCache.list) if (e.svc === svc && out.length < 40) out.push(e);
  return out;
}

/** Select tool: hovered + selected building outlines (drawn every frame, cheap). */
function drawSelect() {
  const S = VC.state, G = VC.gfx.gizmo;
  const box = (b, c) => {
    const y = W.topY(b.x, b.z);
    G.box(b.x + 0.01, y, b.z + 0.01, b.x + b.w - 0.01, y + Math.max(0.3, b.hgt || 1) + 0.05, b.z + b.d - 0.01, c, true);
  };
  if (T.hoverId && T.hoverId !== T.selectedId) {
    const b = S.buildings.get(T.hoverId);
    if (b) box(b, COL.hover);
  }
  if (T.selectedId) {
    const b = S.buildings.get(T.selectedId);
    if (b) box(b, COL.sel);
  }
}

/* ------------------------------------------------------------------ */
/* Ghost                                                                */
/* ------------------------------------------------------------------ */
function setGhost(g) {
  const s = g ? g.key + '|' + g.x + '|' + g.z + '|' + g.rot + '|' + (g.valid ? 1 : 0) : '';
  if (s === ghostSig) return;
  ghostSig = s;
  const B = VC.bldgfx;
  if (!B || !B.setGhost) return;
  try {
    B.setGhost(g);
  } catch (e) {
    console.error('[tools] setGhost failed', e);
  }
}
function updateGhost() {
  const p = T.plan;
  if (T.kind !== 'bld' || !p || !p.ghost || !T.hover) {
    setGhost(null);
    return;
  }
  const g = p.ghost;
  setGhost({ key: g.key, x: g.x, z: g.z, rot: g.rot, valid: !!p.ok });
}

/* ------------------------------------------------------------------ */
/* Cursor label                                                         */
/* ------------------------------------------------------------------ */
function showLabel(on) {
  if (!label || on === labelShown) return;
  labelShown = on;
  label.classList.toggle('show', on);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function money(n) {
  const S = VC.state;
  if (S && S.sandbox) return 'Free';
  return n > 0 ? VC.fmt.money(n) : '$0';
}
function plural(n, one, many) {
  return VC.fmt.num(n) + ' ' + (n === 1 ? one : many || one + 's');
}
/** Label HTML for the current plan: cost, details, reason (red) / warning (yellow). */
function labelContent(p) {
  const S = VC.state;
  const parts = [];
  let reason = p.ok ? '' : p.reason || '';
  let warn = '', good = '';
  let cost = p.cost || 0;
  let showCost = true;
  switch (p.kind) {
    case 'road':
      parts.push(plural(p.count, 'tile'));
      if (p.bridges) parts.push('🌉 ' + p.bridges);
      if (p.upgrades) parts.push('⬆ ' + p.upgrades);
      if (p.levelCost > 0) parts.push('⛰ ' + money(p.levelCost));
      if (reason === 'Already built') { showCost = false; reason = ''; parts.length = 0; parts.push('Already built'); }
      break;
    case 'pline':
      parts.push(plural(p.count, 'tile'));
      if (reason === 'Already built') { showCost = false; reason = ''; parts.length = 0; parts.push('Already built'); }
      break;
    case 'zone':
      if (p.rect) parts.push(p.rect.w + '×' + p.rect.d);
      parts.push(plural(p.count, 'tile'));
      if (reason === 'Already zoned') { showCost = false; reason = ''; parts.length = 0; parts.push('Already zoned'); }
      else if (p.far > 0) warn = (p.far === p.count && p.count > 1 ? 'All ' : '') + plural(p.far, 'tile') + ' out of road reach — ' + (p.far === 1 ? "it won't" : "they won't") + ' grow (max ' + C.ROAD_ACCESS + ' from a street)';
      break;
    case 'dezone':
      parts.push(plural(p.count, 'tile'));
      if (p.remove && p.remove.length) warn = plural(p.remove.length, 'building') + ' demolished';
      if (!p.fee) showCost = false;
      break;
    case 'bulldoze': {
      if (p.buildings.length) parts.push(plural(p.buildings.length, 'building'));
      if (p.roads) parts.push(plural(p.roads, 'road'));
      if (p.plines) parts.push(plural(p.plines, 'line'));
      if (p.trees) parts.push(plural(p.trees, 'tree'));
      if (p.buildings.length === 1 && !p.roads && !p.trees) {
        const b = p.buildings[0];
        parts[0] = b.key === 'rubble' ? 'Rubble' : b.key === 'grow' ? (VC.sim && VC.sim.buildingName ? safeGrowName(b) : 'Building') : (VC.BLD[b.key] || {}).name || 'Building';
      }
      if (reason === 'Nothing to bulldoze') { showCost = false; }
      break;
    }
    case 'bld': {
      const g = p.ghost;
      parts.push(g.def.name);
      parts.push(g.w + '×' + g.d);
      if (p.ok && p.flattenCost > 0) parts.push('⛰ ' + money(p.flattenCost));
      if ((p.ok || p.money) && p.warn) warn = p.warn; // short of money: still say whether it would connect
      if ((p.ok || p.money) && p.good) good = p.good;
      break;
    }
    case 'trees':
      parts.push(plural(p.count, 'tree'));
      parts.push('⌀' + (T.brush.trees * 2 + 1));
      break;
    case 'terrain': {
      const mode = p.mode;
      parts.push(mode === 'level' ? 'Level ' + (p.level - C.SEA) : mode === 'raise' ? '▲ ' + plural(p.count, 'tile') : '▼ ' + plural(p.count, 'tile'));
      parts.push('⌀' + (T.brush.terrain * 2 + 1));
      break;
    }
  }
  if (reason && QUIET.has(reason) && reason !== 'Nothing to bulldoze') { warn = warn || reason; reason = ''; }
  // money: say by how much (the label is where a refused commit is explained; the HUD toasts 'noMoney' once)
  if (reason === NO_MONEY && S && !S.sandbox && cost > S.money) reason = NO_MONEY + ' · ' + VC.fmt.money(Math.ceil(cost - Math.max(0, S.money))) + ' short';
  const cls = reason ? 'bad' : warn ? 'warn' : '';
  let html = '<div class="tc-main">';
  if (showCost) html += '<span class="tc-cost' + (S && S.sandbox ? ' free' : '') + '">' + esc(money(cost)) + '</span>';
  if (parts.length) html += '<span class="tc-info">' + esc(parts.join(' · ')) + '</span>';
  html += '</div>';
  if (reason) html += '<div class="tc-reason">' + esc(reason) + '</div>';
  if (warn && (!reason || p.money)) html += '<div class="tc-warn">' + esc(warn) + '</div>';
  if (good && (!reason || p.money)) html += '<div class="tc-good">' + esc(good) + '</div>';
  return { html, cls };
}
/*
 * Select tool: hovering an EMPTY zoned lot explains why nothing grows there (VC.sim.growReason) in the cursor
 * label, once the pointer rested on the tile for a moment. Recomputed only when the tile, the network flags,
 * the buildings or the demand sign change.
 */
const HINT = { i: -1, fv: -1, bv: -1, dem: -1, tile: -1, since: 0, html: '', cls: '' };
const ZONE_ICON = { 1: '🏠', 2: '🏬', 3: '🏭' };
function selectHint() {
  const S = VC.state, h = T.hover;
  if (!h || T.drag || !W.inb(h.x, h.z)) { HINT.tile = -1; return null; }
  const i = h.z * S.W + h.x;
  const code = S.zone[i];
  if (!code || S.bld[i] || T.hoverId) { HINT.tile = -1; return null; }
  const now = performance.now();
  if (HINT.tile !== i) { HINT.tile = i; HINT.since = now; }
  if (now - HINT.since < 260) return null;
  const zt = code >> 2, den = code & 3, z = VC.ZONES[zt] || { key: '?' };
  const dem = (S.demand && S.demand[z.key]) > 0.02 ? 1 : 0;
  // recompute only when the tile, the network flags, the buildings or the demand sign changed (no per-frame garbage)
  if (HINT.i !== i || HINT.fv !== S.ver.flags || HINT.bv !== S.ver.bld || HINT.dem !== dem) {
    HINT.i = i; HINT.fv = S.ver.flags; HINT.bv = S.ver.bld; HINT.dem = dem;
    let why = '';
    try { why = VC.sim && VC.sim.growReason ? VC.sim.growReason(h.x, h.z) : ''; } catch (e) { why = ''; }
    const ready = /^Ready/.test(why);
    const nm = z.name ? (VC.DENSITY[den] || '') + ' ' + z.name.toLowerCase() : 'Zone';
    let html = '<div class="tc-main"><span class="tc-info">' + (ZONE_ICON[zt] || '') + ' ' + esc(nm) + ' · empty lot</span></div>';
    if (why) html += '<div class="' + (ready ? 'tc-good' : 'tc-warn') + '">' + esc(why) + '</div>';
    HINT.html = html;
    HINT.cls = why && !ready ? 'warn' : '';
  }
  return HINT;
}
function safeGrowName(b) {
  try { return VC.sim.buildingName(b) || 'Building'; } catch (e) { return 'Building'; }
}
let labelCls = '', labelW = 0, labelH = 0, flashTimer = 0;
/** Pulses the cursor label (a commit was refused for money: the label already shows the reason). */
function flashLabel() {
  if (!label) return;
  label.classList.remove('flash');
  void label.offsetWidth; // restart the animation
  label.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => label.classList.remove('flash'), 700);
}
/* HUD rects the label must not cover (active-tool chip, toolbar); refreshed a few times a second */
const AVOID = { t: 0, rects: [] };
function avoidRects() {
  const now = performance.now();
  if (now - AVOID.t < 300) return AVOID.rects;
  AVOID.t = now;
  AVOID.rects.length = 0;
  for (const sel of ['.tool-chip.show', '.hud-toolbar']) {
    const el = document.querySelector('#ui ' + sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) AVOID.rects.push(r);
  }
  return AVOID.rects;
}
const overlaps = (x, y, w, h, r) => x < r.right && x + w > r.left && y < r.bottom && y + h > r.top;
/** Sets the label content (html + state class); re-measures only when it changed. */
function setLabel(html, cls) {
  if (html !== labelHtml) {
    labelHtml = html;
    label.innerHTML = html;
    labelW = 0; // re-measure (only when the content changed: avoids a forced layout every frame)
  }
  if (cls !== labelCls) {
    if (labelCls) label.classList.remove(labelCls);
    if (cls) label.classList.add(cls);
    labelCls = cls;
  }
}
function updateLabel() {
  if (!label) return;
  const p = T.plan;
  const hidden = VC.hud && (VC.hud.uiHidden || VC.hud.photo);
  if (T.kind === 'select') {
    const hint = hidden || !T.inside ? null : selectHint();
    label._plan = null;
    if (!hint) { showLabel(false); return; }
    setLabel(hint.html, hint.cls);
  } else {
    if (!p || !p.kind || (!T.inside && !T.drag) || hidden || (p.kind === 'bulldoze' && !p.count)) {
      showLabel(false);
      return;
    }
    if (p !== label._plan) {
      label._plan = p;
      const c = labelContent(p);
      setLabel(c.html, c.cls);
    }
  }
  if (!labelW) {
    labelW = label.offsetWidth || 120;
    labelH = label.offsetHeight || 30;
  }
  // follow the cursor (canvas px == client px: the canvas is fixed at 0,0), keep inside the viewport and off
  // the toolbar / active-tool chip (flip above the cursor when below would cover them)
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = Math.round(T.px + 18), y = Math.round(T.py + 20);
  const lw = labelW, lh = labelH;
  if (x + lw > vw - 6) x = Math.round(T.px - lw - 12);
  if (y + lh > vh - 6) y = Math.round(T.py - lh - 14);
  const av = avoidRects();
  for (let k = 0; k < av.length; k++) if (overlaps(x, y, lw, lh, av[k])) { y = Math.round(Math.min(T.py, av[k].top) - lh - 10); break; }
  x = M.clamp(x, 4, Math.max(4, vw - lw - 4));
  y = M.clamp(y, 4, Math.max(4, vh - lh - 4));
  if (x !== labelX || y !== labelY) {
    labelX = x;
    labelY = y;
    label.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }
  showLabel(true);
}
