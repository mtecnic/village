/*
 * VOXELPOLIS — HUD minimap (bottom-left), overlay picker and overlay legend.
 *   MINIMAP  W x H pixel image of the world (terrain by material/height with hill shading, water depth,
 *            trees, roads, power lines, zones, buildings in zone colours, civic buildings white) or the
 *            active overlay (S.maps / network flags) using the same ramps as shaderlib overlayRamp.
 *            Incremental: 'dirty' / 'bldChange' rects are recoloured; overlay maps refresh ≤ 1/s.
 *            The camera view is drawn as a trapezoid (screen corners projected to the ground plane).
 *            Click / drag to move the camera, wheel to zoom. Collapsible (VC.settings.minimapOpen).
 *   PICKER   VC.hud.openOverlayPicker(anchorEl, side) — popover grid of VC.OVERLAYS.
 *   LEGEND   floating card for the active overlay (gradient ramp or network swatches), ✕ to clear.
 * Also exports VC.hud.OVERLAY_DESC {key: text} and VC.hud.overlayGradient(rampKind) -> CSS gradient.
 */
const h = VC.h, M = VC.M;
const MM = { size: 184, base: null, bctx: null, img: null, px: null, W: 0, H: 0, dirty: null, full: true, lastBase: 0, redraw: true, drawn: false, open: true, drag: false, bcol: new Map() };

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
  MM.ovBtn = h('button', { class: 'mm-btn', 'data-tip': '<b>Map overlays</b> <kbd>O</kbd>', onclick: (e) => { e.stopPropagation(); VC.bus.emit('sfx', { name: 'click' }); openOverlayPicker(MM.ovBtn, 'top'); } }, '🎨');
  MM.colBtn = h('button', { class: 'mm-btn mm-col', 'data-tip': 'Collapse / expand', onclick: (e) => { e.stopPropagation(); toggleOpen(); } }, h('i'));
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
  MM.lgDesc = h('div', { class: 'lg-desc' });
  MM.legend = h('div', { class: 'hud-legend pe' },
    h('div', { class: 'lg-head' }, MM.lgIcon, MM.lgName, h('button', { class: 'win-btn lg-x', title: 'Clear overlay', onclick: () => { VC.bus.emit('sfx', { name: 'click' }); VC.gfx.setOverlay('none'); } }, '×')),
    MM.lgRamp, h('div', { class: 'lg-labels' }, MM.lgLo, MM.lgHi), MM.lgNet, MM.lgDesc);
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
  MM.canvas.addEventListener('wheel', (e) => { e.preventDefault(); VC.camera.zoom(Math.pow(1.0015, e.deltaY)); }, { passive: false });
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
function alloc(S) {
  MM.W = S.W; MM.H = S.H;
  MM.base.width = S.W; MM.base.height = S.H;
  MM.img = MM.bctx.createImageData(S.W, S.H);
  MM.px = new Uint32Array(MM.img.data.buffer);
  MM.full = true;
  MM.dirty = null;
}
function markRect(x0, z0, x1, z1) {
  const d = MM.dirty;
  if (!d) MM.dirty = { x0, z0, x1, z1 };
  else { d.x0 = Math.min(d.x0, x0); d.z0 = Math.min(d.z0, z0); d.x1 = Math.max(d.x1, x1); d.z1 = Math.max(d.z1, z1); }
}
function buildingRGB(b) {
  if (b.fire > 0) return [255, 112, 40];
  if (b.key === 'rubble') return RUBBLE_RGB;
  if (b.abandoned) return [86, 86, 94];
  if (b.key === 'grow') {
    const z = ZONE_RGB[b.zt] || CIVIC_RGB;
    const k = 0.72 + 0.14 * (b.level || 1);
    return [z[0] * k, z[1] * k, z[2] * k];
  }
  return CIVIC_RGB;
}
/** Recolours tiles in [x0..x1] x [z0..z1]. */
function paint(x0, z0, x1, z1) {
  const S = VC.state, W = S.W, px = MM.px;
  const hgt = S.height, terr = S.terr, road = S.road, zone = S.zone, bld = S.bld, trees = S.trees, pline = S.pline, flags = S.flags;
  const SEA = VC.C.SEA, F = VC.F;
  const ovKey = VC.gfx.overlay || 'none';
  const ov = ovKey !== 'none' ? VC.OVERLAYS.find((o) => o.key === ovKey) : null;
  const kind = ov ? RAMP_KIND[ov.ramp] || 0 : -1;
  const map = ov && ov.map ? S.maps[ov.map] : null;
  const netFlag = ov && ov.ramp === 'net' ? ov.flag : 0;
  const netNet = netFlag === F.POWER ? F.POWERNET : F.WATERNET;
  const bcol = MM.bcol;
  bcol.clear();
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const i = z * W + x;
      const lv = hgt[i];
      let r, g, b;
      if (lv < SEA) {
        const t = Math.min(1, (SEA - lv) / 6);
        r = 60 - 38 * t; g = 146 - 80 * t; b = 206 - 84 * t;
      } else {
        const tc = TERR_RGB[terr[i]] || TERR_RGB[0];
        // height brightness + NW hill shading
        const hn = z > 0 && x > 0 ? hgt[i - W - 1] : lv;
        let k = 0.78 + (lv / VC.C.MAXH) * 0.42 + M.clamp((lv - hn) * 0.07, -0.22, 0.22);
        r = tc[0] * k; g = tc[1] * k; b = tc[2] * k;
        const tr = trees[i];
        if (tr) { const t = 0.35 + tr * 0.17; r += (TREE_RGB[0] - r) * t; g += (TREE_RGB[1] - g) * t; b += (TREE_RGB[2] - b) * t; }
      }
      const id = bld[i];
      if (id) {
        let c = bcol.get(id);
        if (!c) { const bb = S.buildings.get(id); c = bb ? buildingRGB(bb) : CIVIC_RGB; bcol.set(id, c); }
        r = c[0]; g = c[1]; b = c[2];
      } else if (road[i]) {
        const c = ROAD_RGB[road[i]] || ROAD_RGB[1];
        r = c[0]; g = c[1]; b = c[2];
      } else {
        const zc = zone[i];
        if (zc) { const c = ZONE_RGB[zc >> 2]; if (c) { r += (c[0] - r) * 0.5; g += (c[1] - g) * 0.5; b += (c[2] - b) * 0.5; } }
        if (pline[i]) { r += (255 - r) * 0.55; g += (214 - g) * 0.55; b += (90 - b) * 0.55; }
      }
      if (kind >= 0) {
        // overlay: tint with the ramp, keep luminance for shape
        const lum = (r * 0.3 + g * 0.59 + b * 0.11) / 255;
        if (map) {
          if (lv >= SEA) {
            const c = LUT[kind][map[i]];
            const s = 0.45 + lum * 0.6;
            r = c[0] * s; g = c[1] * s; b = c[2] * s;
          } else { r *= 0.45; g *= 0.5; b *= 0.6; }
        } else if (netFlag) {
          const fl = flags[i];
          if (id || zone[i]) {
            const c = fl & netFlag ? LUT[3][255] : LUT[3][0];
            r = c[0]; g = c[1]; b = c[2];
          } else if (fl & netNet) { r = 40; g = 120; b = 150; }
          else { const gr = lum * 110; r = gr; g = gr; b = gr * 1.1; }
        }
      }
      px[i] = pack(r | 0, g | 0, b | 0);
    }
  }
}
function updateBase(force) {
  const S = VC.state;
  if (!S || !MM.px) return false;
  const now = performance.now();
  if (MM.full) {
    if (!force && now - MM.lastBase < 250) return false;
    paint(0, 0, S.W - 1, S.H - 1);
    MM.bctx.putImageData(MM.img, 0, 0);
    MM.full = false;
    MM.dirty = null;
    MM.lastBase = now;
    return true;
  }
  if (MM.dirty && now - MM.lastBase >= 120) {
    const d = MM.dirty;
    const x0 = M.clamp(d.x0, 0, S.W - 1), z0 = M.clamp(d.z0, 0, S.H - 1), x1 = M.clamp(d.x1, 0, S.W - 1), z1 = M.clamp(d.z1, 0, S.H - 1);
    MM.dirty = null;
    paint(x0, z0, x1, z1);
    MM.bctx.putImageData(MM.img, 0, 0, x0, z0, x1 - x0 + 1, z1 - z0 + 1);
    MM.lastBase = now;
    return true;
  }
  return false;
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
  const Y = cam.ty || VC.C.SEA_Y;
  const maxT = cam.dist * 5 + 40;
  for (let k = 0; k < 4; k++) {
    const p = groundPoint(k === 1 || k === 2 ? w : 0, k >= 2 ? hh : 0, Y, maxT);
    quad[k * 2] = p[0] * sx;
    quad[k * 2 + 1] = p[1] * sz;
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
  MM.lgDesc.textContent = OVERLAY_DESC[key] || '';
  const net = ov.ramp === 'net';
  MM.lgRamp.style.display = net ? 'none' : '';
  MM.lgLo.parentNode.style.display = net ? 'none' : '';
  MM.lgNet.style.display = net ? '' : 'none';
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
    bus.on('bldChange', (b) => { if (b && MM.px) markRect(b.x, b.z, b.x + b.w - 1, b.z + b.d - 1); });
    bus.on('bldRemove', (b) => { if (b && MM.px) markRect(b.x, b.z, b.x + b.w - 1, b.z + b.d - 1); });
    const refull = () => { if (VC.gfx.overlay && VC.gfx.overlay !== 'none') MM.full = true; };
    bus.on('mapsUpdated', refull);
    bus.on('flagsUpdated', refull);
    bus.on('overlay', () => { MM.full = true; MM.lastBase = 0; refreshLegend(); VC.hud.refreshDock && VC.hud.refreshDock(); });
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
    if (camChanged() || changed || MM.redraw || !MM.drawn) {
      MM.redraw = false;
      draw();
    }
  },
  onShow() { MM.full = true; MM.redraw = true; refreshLegend(); },
});

Object.assign(VC.hud, { openOverlayPicker, OVERLAY_DESC, overlayGradient, overlayLUT: LUT });
/** Benchmark hook: ms for one full minimap repaint + draw (tests / perf checks). */
VC.hud.debugMinimap = function () {
  const S = VC.state;
  if (!S) return null;
  if (!MM.px || MM.W !== S.W) alloc(S);
  const t0 = performance.now();
  paint(0, 0, S.W - 1, S.H - 1);
  MM.bctx.putImageData(MM.img, 0, 0);
  const t1 = performance.now();
  draw();
  return { paintMs: +(t1 - t0).toFixed(2), drawMs: +(performance.now() - t1).toFixed(2), size: S.W + 'x' + S.H, buildings: S.buildings.size };
};
