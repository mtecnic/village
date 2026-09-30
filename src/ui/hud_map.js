/*
 * VOXELPOLIS — HUD minimap (bottom-left), overlay picker and overlay legend.
 *   MINIMAP  W x H pixel image of the world (terrain by material/height with hill shading, water depth,
 *            trees, roads, power lines, zones, buildings in zone colours, civic buildings white) or the
 *            active overlay (S.maps / network flags) using the same ramps as shaderlib overlayRamp.
 *            Incremental: plain colours are cached per tile (buildings via bldAdd/Change/Remove); world edits
 *            repaint only the 16-row bands they touch, overlay data changes re-tint at most once per second,
 *            and all painting runs within ~1.5 ms per frame (bands finish over the next frames).
 *            Overlays whose 0 means "no data" (happiness: see sim_maps.js) show those tiles grey.
 *            The camera view is drawn as a trapezoid (screen corners projected to the ground plane) from
 *            matrices recomputed for the current camera state (never last frame's), so it is right after
 *            jumps (new city, load, focus). Click / drag to move the camera, wheel to zoom (honours
 *            VC.settings.invertZoom like the main view). Collapsible (VC.settings.minimapOpen).
 *   PICKER   VC.hud.openOverlayPicker(anchorEl, side) — popover grid of VC.OVERLAYS.
 *   LEGEND   floating card for the active overlay (gradient ramp or network swatches), ✕ to clear.
 * Also exports VC.hud.OVERLAY_DESC {key: text} and VC.hud.overlayGradient(rampKind) -> CSS gradient.
 */
const h = VC.h, M = VC.M;
const MM = {
  size: 184, base: null, bctx: null, img: null, px: null, col: null, bc: null, bx0: null, bx1: null, bandAt: 0, W: 0, H: 0,
  full: true, viewRow: -1, viewPending: false, viewNext: 0, viewBurst: false, redraw: true, drawn: false, open: true, drag: false, settle: 0,
};

const OVERLAY_DESC = {
  none: 'The plain city view.',
  landValue: 'What land is worth. Rises near parks, water, services and landmarks; falls near pollution, crime and noise. High value lets buildings level up and pay more tax.',
  pollution: 'Air pollution from industry, power plants and traffic. Makes citizens sick and lowers land value. Plant trees, use clean energy and keep industry downwind.',
  crime: 'Crime rate. Grows with density and unemployment; police stations and good education bring it down.',
  traffic: 'Road congestion. Build avenues, bus depots and metro stations to keep your city moving.',
  noise: 'Noise from highways, industry, airports and stadiums. Residents hate living next to it.',
  happiness: 'How happy citizens are where they live — the sum of services, land value, jobs and nuisances.',
  power: 'Electricity. Cyan = powered, red = no power. Buildings connect when they touch powered buildings, zones or power lines.',
  water: 'Water service. Cyan = served, red = dry. Pumps, towers and treatment plants feed nearby buildings.',
  police: 'Police coverage. Well-covered areas have far less crime.',
  fire: 'Fire protection. Uncovered buildings burn longer and fires spread.',
  health: 'Health care coverage from clinics and hospitals.',
  edu: 'Education coverage. Educated citizens earn more and attract high-tech industry.',
  park: 'Access to parks and leisure. Boosts happiness and land value.',
  transit: 'Public transit coverage. Reduces traffic around stations.',
  garbage: 'Garbage pickup coverage. Without it, trash piles up and pollution rises.',
};
const RAMP_KIND = { good: 0, bad: 1, value: 2, net: 3 };
const RAMP_LABELS = { good: ['Poor', 'Excellent'], bad: ['None', 'Severe'], value: ['Low', 'High'] };

/* ---------------- colours ---------------- */
const pack = (r, g, b) => ((255 << 24) | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r)) >>> 0;
const TERR_RGB = [[98, 160, 74], [214, 198, 142], [142, 112, 78], [126, 128, 134], [236, 242, 250], [124, 172, 84]];
const TREE_RGB = [40, 96, 50];
const ROAD_RGB = [null, [188, 196, 210], [222, 228, 238], [255, 232, 160]];
const ZONE_RGB = { 1: [57, 217, 138], 2: [63, 167, 255], 3: [255, 200, 61] };
const CIVIC_RGB = [246, 248, 253];
const RUBBLE_RGB = [118, 106, 96];
function sm(e0, e1, x) { const t = M.clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
/** JS twin of shaderlib overlayRamp (linear colours). */
function rampLin(v, kind) {
  if (kind === 0) return mix(mix([0.9, 0.15, 0.1], [1.0, 0.85, 0.1], sm(0, 0.5, v)), [0.15, 0.9, 0.35], sm(0.5, 1, v));
  if (kind === 1) return v < 0.02 ? [0.2, 0.7, 0.35] : mix(mix([1.0, 0.9, 0.2], [1.0, 0.35, 0.1], sm(0, 0.5, v)), [0.6, 0.05, 0.4], sm(0.5, 1, v));
  if (kind === 2) return mix(mix([0.1, 0.1, 0.45], [0.1, 0.75, 0.9], sm(0, 0.5, v)), [1.0, 0.8, 0.2], sm(0.5, 1, v));
  return v > 0.5 ? [0.2, 0.85, 1.0] : [0.95, 0.2, 0.15];
}
const toSrgb = (c) => c.map((x) => Math.round(255 * Math.pow(M.sat(x), 1 / 1.6)));
/** 256-entry sRGB LUTs per ramp kind. */
const LUT = [0, 1, 2, 3].map((k) => { const a = []; for (let i = 0; i < 256; i++) a.push(toSrgb(rampLin(i / 255, k))); return a; });
/** The same LUTs as per-channel typed arrays (paint loops). */
const LUTF = LUT.map((a) => [0, 1, 2].map((ch) => Float32Array.from(a, (c) => c[ch])));
/** Overlays whose map value 0 means "no data" (sim_maps.js: happiness 0 = nobody lives / works there). */
const NODATA0 = { happiness: 1 };
function overlayGradient(ramp) {
  const k = RAMP_KIND[ramp] || 0;
  if (k === 3) return 'linear-gradient(90deg, rgb(' + LUT[3][0] + ') 0 50%, rgb(' + LUT[3][255] + ') 50% 100%)';
  const stops = [];
  for (let i = 0; i <= 8; i++) { const c = LUT[k][Math.round((i / 8) * 255)]; stops.push(`rgb(${c[0]},${c[1]},${c[2]}) ${(i / 8) * 100}%`); }
  if (k === 1) stops[0] = `rgb(${LUT[1][0]}) 0%, rgb(${LUT[1][0]}) 2%, rgb(${LUT[1][6]}) 2.5%`;
  return 'linear-gradient(90deg, ' + stops.join(', ') + ')';
}

/* ---------------- build ---------------- */
function build(root) {
  MM.open = !(VC.settings && VC.settings.minimapOpen === false);
  MM.canvas = h('canvas', { class: 'mm-canvas' });
  MM.ctx = MM.canvas.getContext('2d');
  MM.base = document.createElement('canvas');
  MM.bctx = MM.base.getContext('2d');
  MM.title = h('span', { class: 'mm-title' }, 'Map');
  MM.ovBtn = h('button', { class: 'mm-btn', 'aria-label': 'Map overlays', 'data-tip': '<b>Map overlays</b> <kbd>O</kbd>', onclick: (e) => { e.stopPropagation(); VC.bus.emit('sfx', { name: 'click' }); openOverlayPicker(MM.ovBtn, 'top'); } }, '🎨');
  MM.colBtn = h('button', { class: 'mm-btn mm-col', 'aria-label': 'Collapse minimap', 'data-tip': 'Collapse / expand', onclick: (e) => { e.stopPropagation(); toggleOpen(); } }, h('i'));
  const head = h('div', { class: 'mm-head', onclick: () => { if (!MM.open) toggleOpen(); } }, h('span', { class: 'mm-glyph' }, '🗺️'), MM.title, MM.ovBtn, MM.colBtn);
  MM.north = h('span', { class: 'mm-north' }, 'N');
  MM.body = h('div', { class: 'mm-body' }, MM.canvas, MM.north);
  MM.el = h('div', { class: 'hud-minimap pe' + (MM.open ? '' : ' collapsed') }, head, MM.body);
  // legend
  MM.lgIcon = h('span', { class: 'lg-icon' });
  MM.lgName = h('span', { class: 'lg-name' });
  MM.lgRamp = h('div', { class: 'lg-ramp' });
  MM.lgLo = h('span');
  MM.lgHi = h('span');
  MM.lgNet = h('div', { class: 'lg-net' });
  // compact legend: the long description lives in its tooltip
  MM.legend = h('div', { class: 'hud-legend pe', 'data-tip': '1' },
    h('div', { class: 'lg-head' }, MM.lgIcon, MM.lgName, h('button', { class: 'win-btn lg-x', title: 'Clear overlay', onclick: () => { VC.bus.emit('sfx', { name: 'click' }); VC.gfx.setOverlay('none'); } }, '×')),
    MM.lgRamp, h('div', { class: 'lg-labels' }, MM.lgLo, MM.lgHi), MM.lgNet);
  MM.legend._tip = () => { const k = VC.gfx.overlay; const o = VC.OVERLAYS.find((x) => x.key === k); return o ? `<div class="tt-head"><span class="tt-icon">${o.icon}</span>${o.name}</div><div class="tt-desc">${OVERLAY_DESC[k] || ''}</div><div class="tt-foot">Press <kbd>O</kbd> to cycle overlays</div>` : ''; };
  root.appendChild(h('div', { class: 'hud-bl' }, MM.legend, MM.el));
  // interaction
  const toWorld = (e) => {
    const r = MM.canvas.getBoundingClientRect();
    const S = VC.state;
    return [((e.clientX - r.left) / r.width) * S.W, ((e.clientY - r.top) / r.height) * S.H];
  };
  MM.canvas.addEventListener('pointerdown', (e) => {
    if (!VC.state || e.button > 0) return;
    MM.drag = true;
    MM.canvas.setPointerCapture(e.pointerId);
    const [x, z] = toWorld(e);
    VC.camera.focus(x, z);
    VC.bus.emit('sfx', { name: 'click' });
  });
  MM.canvas.addEventListener('pointermove', (e) => {
    if (!MM.drag || !VC.state) return;
    const [x, z] = toWorld(e);
    VC.camera.focus(x, z);
  });
  const end = () => (MM.drag = false);
  MM.canvas.addEventListener('pointerup', end);
  MM.canvas.addEventListener('pointercancel', end);
  MM.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!VC.state || !VC.camera) return;
    // same feel as the 3D view: lines / pages -> px, and the player's Invert zoom setting
    let d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    d = VC.M.clamp(d, -240, 240);
    if (VC.settings && VC.settings.invertZoom) d = -d;
    VC.camera.zoom(Math.pow(1.0015, d));
  }, { passive: false });
  refreshLegend();
}
function toggleOpen() {
  VC.bus.emit('sfx', { name: 'click' });
  MM.open = !MM.open;
  MM.el.classList.toggle('collapsed', !MM.open);
  if (VC.settings) { VC.settings.minimapOpen = MM.open; try { localStorage.setItem('voxelpolis.settings', JSON.stringify(VC.settings)); } catch (e) { /* ignore */ } }
  if (MM.open) { MM.full = true; MM.redraw = true; }
}

/* ---------------- base image ---------------- */
/*
 * Two layers per tile: MM.col = the plain map colour (terrain, trees, roads, zones, lines, buildings) and
 * MM.px = what is shown (MM.col, or MM.col tinted by the active overlay). MM.bc caches each building
 * tile's colour (0 = no building), updated from bldAdd / bldChange / bldRemove, so painting never looks
 * buildings up. Work is done in bands of BAND rows within a per-frame budget: world edits mark the
 * bands they touch (plain colour + view), overlay data changes re-tint every band at most once per
 * OV_REFRESH_MS; each finished band is uploaded with its own putImageData rect.
 */
const BAND = 16, PAINT_MS = 1.5, OV_REFRESH_MS = 1000;
function alloc(S) {
  MM.W = S.W; MM.H = S.H;
  MM.base.width = S.W; MM.base.height = S.H;
  MM.img = MM.bctx.createImageData(S.W, S.H);
  MM.px = new Uint32Array(MM.img.data.buffer);
  MM.col = new Uint32Array(S.N || S.W * S.H);
  MM.bc = new Uint32Array(S.N || S.W * S.H);
  const nb = Math.ceil(S.H / BAND);
  MM.bx0 = new Int32Array(nb); // dirty x-span per band (plain colour + view); bx0 > bx1 = clean
  MM.bx1 = new Int32Array(nb);
  MM.full = true;
}
/** Marks every band for a full repaint and rebuilds the building-colour cache. */
function markAll(S) {
  MM.bx0.fill(0);
  MM.bx1.fill(S.W - 1);
  const bc = MM.bc, W = S.W;
  bc.fill(0);
  for (const b of S.buildings.values()) stampBld(b, bldColor(b), W, bc);
  MM.viewRow = -1; // a pending overlay refresh is covered by the full repaint
  MM.viewBurst = true; // the first picture of a map comes in one go (a frame's worth of budget)
  MM.full = false;
}
function stampBld(b, c, W, bc) {
  const x0 = Math.max(0, b.x | 0), z0 = Math.max(0, b.z | 0), x1 = Math.min(MM.W, (b.x + b.w) | 0), z1 = Math.min(MM.H, (b.z + b.d) | 0);
  for (let z = z0; z < z1; z++) for (let x = x0, i = z * W + x0; x < x1; x++, i++) bc[i] = c;
}
function markRect(x0, z0, x1, z1) {
  // a corrupt rect (NaN from a bad building) must not reach putImageData: repaint everything instead
  if (!isFinite(x0) || !isFinite(z0) || !isFinite(x1) || !isFinite(z1)) { MM.full = true; return; }
  const W = MM.W, H = MM.H;
  const ax = Math.max(0, Math.floor(Math.min(x0, x1))), bx = Math.min(W - 1, Math.ceil(Math.max(x0, x1)));
  const az = Math.max(0, Math.floor(Math.min(z0, z1))), bz = Math.min(H - 1, Math.ceil(Math.max(z0, z1)));
  if (bx < ax || bz < az) return;
  for (let b = (az / BAND) | 0, b1 = (bz / BAND) | 0; b <= b1; b++) {
    if (MM.bx0[b] > MM.bx1[b]) { MM.bx0[b] = ax; MM.bx1[b] = bx; }
    else { if (ax < MM.bx0[b]) MM.bx0[b] = ax; if (bx > MM.bx1[b]) MM.bx1[b] = bx; }
  }
}
/** Building event: refresh its cached colour (0 = gone) and mark its footprint. */
function onBld(b, gone) {
  if (!b || !MM.px || !MM.bc || !isFinite(b.x) || !isFinite(b.z)) return;
  stampBld(b, gone ? 0 : bldColor(b), MM.W, MM.bc);
  markRect(b.x, b.z, b.x + b.w - 1, b.z + b.d - 1);
}
const FIRE_P = pack(255, 112, 40), RUBBLE_P = pack(RUBBLE_RGB[0], RUBBLE_RGB[1], RUBBLE_RGB[2]), ABAND_P = pack(86, 86, 94), CIVIC_P = pack(CIVIC_RGB[0], CIVIC_RGB[1], CIVIC_RGB[2]);
function bldColor(b) {
  if (b.fire > 0) return FIRE_P;
  if (b.key === 'rubble') return RUBBLE_P;
  if (b.abandoned) return ABAND_P;
  if (b.key === 'grow') {
    const z = ZONE_RGB[b.zt] || CIVIC_RGB;
    const k = 0.72 + 0.14 * (b.level || 1);
    return pack((z[0] * k) | 0, (z[1] * k) | 0, (z[2] * k) | 0);
  }
  return CIVIC_P;
}
/** Plain map colours of [x0..x1] x [z0..z1] into MM.col. */
function paintBase(S, x0, z0, x1, z1) {
  const W = S.W, col = MM.col, bc = MM.bc;
  const hgt = S.height, terr = S.terr, road = S.road, zone = S.zone, trees = S.trees, pline = S.pline;
  const SEA = VC.C.SEA, hk = 0.42 / VC.C.MAXH;
  for (let z = z0; z <= z1; z++) {
    for (let x = x0, i = z * W + x0; x <= x1; x++, i++) {
      const c = bc[i];
      if (c) { col[i] = c; continue; }
      const lv = hgt[i];
      let r, g, b;
      if (lv < SEA) {
        const t = Math.min(1, (SEA - lv) / 6);
        r = 60 - 38 * t; g = 146 - 80 * t; b = 206 - 84 * t;
      } else {
        const tc = TERR_RGB[terr[i]] || TERR_RGB[0];
        // height brightness + NW hill shading
        const hn = z > 0 && x > 0 ? hgt[i - W - 1] : lv;
        const sh = (lv - hn) * 0.07;
        const k = 0.78 + lv * hk + (sh < -0.22 ? -0.22 : sh > 0.22 ? 0.22 : sh);
        r = tc[0] * k; g = tc[1] * k; b = tc[2] * k;
        const tr = trees[i];
        if (tr) { const t = 0.35 + tr * 0.17; r += (TREE_RGB[0] - r) * t; g += (TREE_RGB[1] - g) * t; b += (TREE_RGB[2] - b) * t; }
      }
      const rd = road[i];
      if (rd) {
        const rc = ROAD_RGB[rd] || ROAD_RGB[1];
        r = rc[0]; g = rc[1]; b = rc[2];
      } else {
        const zc = zone[i];
        if (zc) { const zr = ZONE_RGB[zc >> 2]; if (zr) { r += (zr[0] - r) * 0.5; g += (zr[1] - g) * 0.5; b += (zr[2] - b) * 0.5; } }
        if (pline[i]) { r += (255 - r) * 0.55; g += (214 - g) * 0.55; b += (90 - b) * 0.55; }
      }
      col[i] = pack(r | 0, g | 0, b | 0);
    }
  }
}
/** Overlay state for painting (null = plain map). */
function overlayState(S) {
  const key = VC.gfx.overlay || 'none';
  const ov = key !== 'none' ? VC.OVERLAYS.find((o) => o.key === key) : null;
  if (!ov) return null;
  const F = VC.F;
  const kind = RAMP_KIND[ov.ramp] || 0;
  const netFlag = ov.ramp === 'net' ? ov.flag : 0;
  return {
    kind, map: ov.map ? S.maps[ov.map] : null, netFlag, netNet: netFlag === F.POWER ? F.POWERNET : F.WATERNET,
    nodata: !!(ov.nodata0 || NODATA0[key]), lr: LUTF[kind][0], lg: LUTF[kind][1], lb: LUTF[kind][2],
  };
}
/** Shown colours of [x0..x1] x [z0..z1]: MM.col as is, or tinted by the overlay (keeps luminance for shape). */
function paintView(S, o, x0, z0, x1, z1) {
  const W = S.W, px = MM.px, col = MM.col;
  if (!o) {
    for (let z = z0; z <= z1; z++) { const a = z * W + x0; px.set(col.subarray(a, a + x1 - x0 + 1), a); }
    return;
  }
  const hgt = S.height, flags = S.flags, zone = S.zone, bld = S.bld, SEA = VC.C.SEA;
  const map = o.map, lr = o.lr, lg = o.lg, lb = o.lb, nodata = o.nodata, netFlag = o.netFlag, netNet = o.netNet;
  const on = LUT[3][255], off = LUT[3][0];
  for (let z = z0; z <= z1; z++) {
    for (let x = x0, i = z * W + x0; x <= x1; x++, i++) {
      const c = col[i];
      let r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255;
      const lum = (r * 0.3 + g * 0.59 + b * 0.11) / 255;
      if (map) {
        if (hgt[i] >= SEA) {
          const v = map[i];
          if (nodata && v === 0) { const gr = lum * 110; r = gr; g = gr; b = gr * 1.1; } // n/a: nobody there
          else { const s = 0.45 + lum * 0.6; r = lr[v] * s; g = lg[v] * s; b = lb[v] * s; }
        } else { r *= 0.45; g *= 0.5; b *= 0.6; }
      } else if (netFlag) {
        const fl = flags[i];
        if (bld[i] || zone[i]) {
          const cc = fl & netFlag ? on : off;
          r = cc[0]; g = cc[1]; b = cc[2];
        } else if (fl & netNet) { r = 40; g = 120; b = 150; }
        else { const gr = lum * 110; r = gr; g = gr; b = gr * 1.1; }
      }
      px[i] = ((255 << 24) | ((b > 255 ? 255 : b) << 16) | ((g > 255 ? 255 : g) << 8) | (r > 255 ? 255 : r)) >>> 0;
    }
  }
}
/**
 * Advances the repaint within the frame budget: dirty bands first (plain colours + view), then a
 * pending overlay re-tint (row bands, at most once per OV_REFRESH_MS). Returns true if pixels changed.
 */
function updateBase(force) {
  const S = VC.state;
  if (!S || !MM.px) return false;
  const now = performance.now();
  if (MM.full) markAll(S);
  const H = S.H, nb = MM.bx0.length, t0 = now, budget = force ? 1e9 : MM.viewBurst ? 12 : PAINT_MS;
  let o = null, oReady = false, changed = false;
  const ov = () => { if (!oReady) { o = overlayState(S); oReady = true; } return o; };
  for (let k = 0; k < nb; k++) {
    const b = (MM.bandAt + k) % nb; // round-robin so a busy area cannot starve the rest
    if (MM.bx0[b] > MM.bx1[b]) continue;
    const x0 = MM.bx0[b], x1 = MM.bx1[b], z0 = b * BAND, z1 = Math.min(H - 1, z0 + BAND - 1);
    MM.bx0[b] = 1; MM.bx1[b] = 0;
    paintBase(S, x0, z0, x1, z1);
    paintView(S, ov(), x0, z0, x1, z1);
    MM.bctx.putImageData(MM.img, 0, 0, x0, z0, x1 - x0 + 1, z1 - z0 + 1);
    changed = true;
    if (performance.now() - t0 >= budget) { MM.bandAt = (b + 1) % nb; return true; }
  }
  if (MM.viewRow < 0) MM.viewBurst = false; // every band is clean again
  // overlay data changed (maps / networks): re-tint everything, sliced, at most once per OV_REFRESH_MS
  if (MM.viewRow < 0 && MM.viewPending && now >= MM.viewNext) {
    MM.viewPending = false;
    MM.viewRow = 0;
  }
  // (a re-tint the player asked for — a new overlay — may take a whole frame's worth of budget)
  const vBudget = MM.viewBurst ? Math.max(budget, 12) : budget;
  while (MM.viewRow >= 0) {
    const z0 = MM.viewRow, z1 = Math.min(H - 1, z0 + BAND - 1);
    paintView(S, ov(), 0, z0, S.W - 1, z1);
    MM.bctx.putImageData(MM.img, 0, 0, 0, z0, S.W, z1 - z0 + 1);
    changed = true;
    MM.viewRow = z1 + 1 < H ? z1 + 1 : -1;
    if (MM.viewRow < 0) {
      MM.viewNext = performance.now() + OV_REFRESH_MS;
      MM.viewBurst = false;
    }
    if (performance.now() - t0 >= vBudget) break;
  }
  return changed;
}
/** Overlay picked / changed: re-tint from the top now (not throttled). */
function viewNow() {
  MM.viewPending = false;
  MM.viewRow = 0;
  MM.viewBurst = true;
}

/* ---------------- view frustum ---------------- */
const corner = [0, 0];
const quad = new Float32Array(8); // frustum corners in minimap px
const camLast = new Float64Array(7); // last drawn camera state (tx, tz, yaw, pitch, dist, W, H)
/** True if the camera moved enough since the last minimap draw (no allocations). */
function camChanged() {
  const c = VC.camera, g = VC.gfx;
  const v0 = c.tx, v1 = c.tz, v2 = c.yaw, v3 = c.pitch, v4 = c.dist, v5 = g.W, v6 = g.H;
  const ch = Math.abs(v0 - camLast[0]) > 0.02 || Math.abs(v1 - camLast[1]) > 0.02 || Math.abs(v2 - camLast[2]) > 0.002 || Math.abs(v3 - camLast[3]) > 0.002 || Math.abs(v4 - camLast[4]) > 0.02 || v5 !== camLast[5] || v6 !== camLast[6];
  if (ch) { camLast[0] = v0; camLast[1] = v1; camLast[2] = v2; camLast[3] = v3; camLast[4] = v4; camLast[5] = v5; camLast[6] = v6; }
  return ch;
}
function groundPoint(px, py, Y, maxT) {
  const r = VC.camera.screenRay(px, py);
  const o = r.o, d = r.d;
  let t = d[1] < -1e-3 ? (Y - o[1]) / d[1] : Infinity;
  if (t < 0) t = Infinity;
  if (t > maxT) {
    // looking at the horizon: clamp along the horizontal direction
    const hl = Math.hypot(d[0], d[2]) || 1;
    corner[0] = o[0] + (d[0] / hl) * maxT;
    corner[1] = o[2] + (d[2] / hl) * maxT;
  } else {
    corner[0] = o[0] + d[0] * t;
    corner[1] = o[2] + d[2] * t;
  }
  return corner;
}
function draw() {
  const S = VC.state, cam = VC.camera, cv = MM.canvas, ctx = MM.ctx;
  if (!S || !cam || !VC.gfx.canvas) return;
  // HUD parts update before the renderer rebuilds the camera matrices: without this the frustum is drawn
  // with last frame's matrices and, once the camera stops, stays wrong until the next move
  if (cam.computeMatrices) { try { cam.computeMatrices(); } catch (e) { /* camera not ready */ } }
  const dpr = Math.min(2, window.devicePixelRatio || 1) * VC.ui.scale();
  const size = MM.size;
  const bw = Math.round(size * dpr);
  if (cv.width !== bw) { cv.width = bw; cv.height = bw; }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, bw, bw);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(MM.base, 0, 0, bw, bw);
  const sx = bw / S.W, sz = bw / S.H;
  // frustum
  const gc = VC.gfx.canvas;
  const w = gc.clientWidth, hh = gc.clientHeight;
  const Y = isFinite(cam.ty) && cam.ty ? cam.ty : VC.C.SEA_Y;
  const maxT = cam.dist * 5 + 40;
  for (let k = 0; k < 4; k++) {
    const p = groundPoint(k === 1 || k === 2 ? w : 0, k >= 2 ? hh : 0, Y, maxT);
    quad[k * 2] = isFinite(p[0]) ? p[0] * sx : 0;
    quad[k * 2 + 1] = isFinite(p[1]) ? p[1] * sz : 0;
  }
  ctx.beginPath();
  ctx.moveTo(quad[0], quad[1]);
  ctx.lineTo(quad[2], quad[3]);
  ctx.lineTo(quad[4], quad[5]);
  ctx.lineTo(quad[6], quad[7]);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fill();
  ctx.lineWidth = 1.5 * dpr;
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineJoin = 'round';
  ctx.stroke();
  // target marker
  ctx.fillStyle = '#5ad1ff';
  ctx.beginPath();
  ctx.arc(cam.tx * sx, cam.tz * sz, 2.6 * dpr, 0, Math.PI * 2);
  ctx.fill();
  // active disasters: pulsing red beacons
  const act = VC.disasters && VC.disasters.active;
  if (act && act.length) {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.008);
    for (let i = 0; i < act.length; i++) {
      const d = act[i];
      if (!d || !isFinite(d.x) || !isFinite(d.z)) continue;
      const px = d.x * sx, pz = d.z * sz;
      ctx.beginPath();
      ctx.arc(px, pz, (5 + pulse * 6) * dpr, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,90,106,${(0.45 * (1 - pulse)).toFixed(3)})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, pz, 3 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#ff5a6a';
      ctx.fill();
      ctx.lineWidth = 1.2 * dpr;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
  }
  MM.drawn = true;
}

/* ---------------- overlay picker + legend ---------------- */
function openOverlayPicker(anchor, side) {
  const ui = VC.ui;
  if (ui.isPopoverOpen && ui.isPopoverOpen('overlays')) { ui.closePopovers(); return; }
  const cur = VC.gfx.overlay || 'none';
  const grid = h('div', { class: 'ov-grid' });
  for (const o of VC.OVERLAYS) {
    const strip = o.ramp ? h('i', { class: 'ov-strip', style: { background: overlayGradient(o.ramp) } }) : h('i', { class: 'ov-strip none' });
    grid.appendChild(h('button', { class: 'ov-tile' + (o.key === cur ? ' active' : ''), 'data-tip': OVERLAY_DESC[o.key] || '', onclick: () => { VC.bus.emit('sfx', { name: 'click' }); VC.gfx.setOverlay(o.key); pop.close(); } }, h('span', { class: 'ov-icon' }, o.icon), h('span', { class: 'ov-name' }, o.name), strip));
  }
  const pop = ui.popover(anchor, grid, { id: 'overlays', title: 'Map overlays · O to cycle', side: side || 'left', cls: 'ov-pop' });
  return pop;
}
function refreshLegend() {
  const key = (VC.gfx && VC.gfx.overlay) || 'none';
  const ov = VC.OVERLAYS.find((o) => o.key === key);
  const on = !!(ov && key !== 'none');
  MM.legend.classList.toggle('show', on);
  MM.title.textContent = on ? ov.name : 'Map';
  if (MM.ovBtn) MM.ovBtn.classList.toggle('active', on);
  if (!on) return;
  MM.lgIcon.textContent = ov.icon;
  MM.lgName.textContent = ov.name;
  const net = ov.ramp === 'net', nd = !net && !!(ov.nodata0 || NODATA0[key]);
  MM.lgRamp.style.display = net ? 'none' : '';
  MM.lgLo.parentNode.style.display = net ? 'none' : '';
  MM.lgNet.style.display = net || nd ? '' : 'none';
  if (nd) MM.lgNet.innerHTML = '<span><i style="background:rgb(66,66,74)"></i>No residents or workers</span>';
  if (net) {
    const c = (v) => `rgb(${LUT[3][v].join(',')})`;
    const what = ov.flag === VC.F.POWER ? ['Powered', 'No power'] : ['Water service', 'No water'];
    MM.lgNet.innerHTML = `<span><i style="background:${c(255)}"></i>${what[0]}</span><span><i style="background:${c(0)}"></i>${what[1]}</span><span><i style="background:rgb(40,120,150)"></i>Network</span>`;
  } else {
    MM.lgRamp.style.background = overlayGradient(ov.ramp);
    const lb = RAMP_LABELS[ov.ramp] || ['Low', 'High'];
    MM.lgLo.textContent = lb[0];
    MM.lgHi.textContent = lb[1];
  }
}

VC.hud.register({
  name: 'minimap',
  order: 20,
  init(root) {
    build(root);
    const bus = VC.bus;
    bus.on('dirty', (d) => { if (d && MM.px) markRect(d.x0, d.z0, d.x1, d.z1); });
    bus.on('bldAdd', (b) => onBld(b, false));
    bus.on('bldChange', (b) => onBld(b, false));
    bus.on('bldRemove', (b) => onBld(b, true));
    // camera jumps (new city / load / Continue) happen without motion the next frame: force a redraw
    for (const ev of ['newGame', 'started']) bus.on(ev, () => { MM.redraw = true; MM.settle = 3; });
    // overlay data changed: re-tint (at most once per OV_REFRESH_MS, sliced over frames)
    const ovData = (net) => () => {
      const k = VC.gfx.overlay;
      const ov = k && k !== 'none' ? VC.OVERLAYS.find((o) => o.key === k) : null;
      if (ov && (net ? ov.ramp === 'net' : !!ov.map)) MM.viewPending = true;
    };
    bus.on('mapsUpdated', ovData(false));
    bus.on('flagsUpdated', ovData(true));
    bus.on('overlay', () => { viewNow(); refreshLegend(); VC.hud.refreshDock && VC.hud.refreshDock(); });
    bus.on('settings', () => { MM.redraw = true; });
  },
  reset(S) {
    alloc(S);
    MM.redraw = true;
    refreshLegend();
  },
  update() {
    const S = VC.state;
    if (!S || !MM.open || VC.hud.uiHidden) return;
    if (MM.W !== S.W || MM.H !== S.H || !MM.px) alloc(S);
    const changed = updateBase(false);
    const dis = VC.disasters && VC.disasters.active && VC.disasters.active.length > 0; // beacons animate
    // redraw while the camera moves and once more after it settles (the eased camera ends in tiny steps)
    const moved = camChanged();
    if (moved) MM.settle = 2;
    if (moved || changed || MM.redraw || !MM.drawn || dis || MM.settle > 0) {
      if (!moved && MM.settle > 0) MM.settle--;
      MM.redraw = false;
      draw();
    }
  },
  onShow() { MM.full = true; MM.redraw = true; refreshLegend(); },
});

Object.assign(VC.hud, { openOverlayPicker, OVERLAY_DESC, overlayGradient, overlayLUT: LUT });
/**
 * Benchmark hook: ms for one full minimap repaint (unbudgeted; the live minimap spreads it over frames),
 * an overlay re-tint of the whole map (viewMs, with the active overlay) and the draw.
 */
VC.hud.debugMinimap = function () {
  const S = VC.state;
  if (!S) return null;
  if (!MM.px || MM.W !== S.W) alloc(S);
  const t0 = performance.now();
  markAll(S);
  updateBase(true);
  const t1 = performance.now();
  paintView(S, overlayState(S), 0, 0, S.W - 1, S.H - 1);
  MM.bctx.putImageData(MM.img, 0, 0);
  const t2 = performance.now();
  draw();
  return { paintMs: +(t1 - t0).toFixed(2), viewMs: +(t2 - t1).toFixed(2), drawMs: +(performance.now() - t2).toFixed(2), size: S.W + 'x' + S.H, buildings: S.buildings.size };
};
