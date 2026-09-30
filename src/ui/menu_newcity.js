/*
 * VOXELPOLIS — New City dialog: VC.menu.newCity().
 *   City name (+ 🎲 fun name generator), map type cards with live mini-map previews
 *   (VC.worldgen.previewCanvas when available, else a fast built-in noise preview), a large preview of
 *   the selection, seed (+ 🎲, text seeds hash to numbers), map size with a performance note, difficulty
 *   cards (VC.DIFFICULTY), disasters + tutorial toggles. "Found City" -> VC.menu.startGame(opts).
 * API: VC.menu.newCity(), VC.menu.closeDialog(instant?), VC.menu.dialogOpen(), VC.menu.randomCityName(rng?)
 */
const h = VC.h;
const NC = { back: null, o: null, cards: new Map(), big: null, bigLabel: null, gen: 0, seedInput: null };

/* ---------------- names ---------------- */
const N_PRE = ['New ', 'Port ', 'Fort ', 'Mount ', 'Lake ', 'East ', 'West ', 'North ', 'South ', 'Upper ', 'Saint ', 'Old ', 'Little ', 'Grand '];
const N_ROOT = ['Vox', 'Cube', 'Block', 'Pixel', 'Brick', 'Square', 'Grid', 'Tile', 'Stack', 'Quad', 'Chunk', 'Cobble', 'Dice', 'Prism', 'Voxel', 'Mosaic', 'Crate', 'Boxel', 'Cubic', 'Slab'];
const N_SUF = ['ton', 'ington', 'ville', 'burg', 'haven', 'field', 'ford', 'port', 'wood', 'dale', 'shire', 'stead', 'polis', 'mouth', 'bury', 'chester', 'holm', 'bridge', 'minster', 'worth', 'ham', 'ridge', 'view'];
const N_END = [' Falls', ' Heights', ' Springs', ' Bay', ' City', ' Harbor', ' Hills', ' Valley', ' Park', ' Junction', ' Crossing', ' Point', ' Creek', ' Grove', ' Shores', ' Meadows'];
function randomCityName(r) {
  r = r || Math.random;
  const pick = (a) => a[Math.floor(r() * a.length)];
  let root = pick(N_ROOT);
  const suf = pick(N_SUF);
  if (/[aeiouy]$/i.test(root) && /^[aeiouy]/.test(suf)) root = root.slice(0, -1); // Cube+ington -> Cubington
  const base = root + suf;
  const k = r();
  if (k < 0.34) return pick(N_PRE) + base;
  if (k < 0.68) return base + pick(N_END);
  if (k < 0.76) return pick(N_PRE) + root + pick(N_END);
  return base;
}

/* ---------------- previews ---------------- */
function mixc(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
/** Fast stand-in mini-map (used when VC.worldgen.previewCanvas is not available). */
function fallbackPreview(seed, type, px) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(px, px);
  const nz = VC.makeNoise(seed >>> 0);
  const r = VC.M.rng(seed >>> 0);
  const ph = r() * 6.28, amp = 0.12 + r() * 0.1, side = r() < 0.5, flip = r() < 0.5;
  const E = new Float32Array(px * px);
  for (let y = 0; y < px; y++)
    for (let x = 0; x < px; x++) {
      const u = x / px, v = y / px;
      let e = nz.fbm(u * 3 + 11, v * 3 - 7, 4) * 0.5 + 0.5;
      if (type === 'river') {
        const t = side ? v : u, s = side ? u : v;
        const rx = 0.5 + Math.sin(t * 6.5 + ph) * amp + nz.n2(t * 3, 5) * 0.05;
        e = Math.min(0.36 + e * 0.5, 0.1 + Math.abs(s - rx) * 2.8);
      } else if (type === 'coast') {
        const g = side ? (flip ? 1 - u : u) : flip ? 1 - v : v;
        e = e * 0.55 + g * 0.85 - 0.25 + nz.n2(u * 5, v * 5) * 0.06;
      } else if (type === 'islands') {
        const cx = u - 0.5, cy = v - 0.5;
        e = e * 1.05 - 0.2 + nz.n2(u * 6 + 3, v * 6) * 0.14 - (cx * cx + cy * cy) * 0.5;
      } else if (type === 'mountains') {
        e = 0.28 + nz.ridge(u * 2.4 + 3, v * 2.4, 4) * 0.72 * (0.55 + e * 0.55);
      } else if (type === 'lakes') {
        const l = nz.n2(u * 7 + 40, v * 7);
        e = 0.42 + e * 0.32 - (l > 0.42 ? (l - 0.42) * 1.7 : 0);
      } else {
        e = 0.4 + e * 0.2;
      }
      E[y * px + x] = e;
    }
  const SEA = 0.3;
  const P = new Uint32Array(img.data.buffer);
  const C = { deep: [22, 66, 122], shallow: [58, 146, 204], sand: [214, 198, 142], grass: [102, 164, 76], grass2: [84, 142, 62], forest: [42, 98, 52], rock: [128, 128, 136], snow: [238, 244, 250] };
  for (let y = 0; y < px; y++)
    for (let x = 0; x < px; x++) {
      const i = y * px + x, e = E[i];
      let c;
      if (e < SEA) c = mixc(C.shallow, C.deep, Math.min(1, (SEA - e) / 0.18));
      else {
        if (e < SEA + 0.025) c = C.sand;
        else if (e > 0.84) c = C.snow;
        else if (e > 0.7) c = C.rock;
        else c = nz.n2(x * 0.09 + 90, y * 0.09) > 0.28 ? C.forest : e > 0.55 ? C.grass2 : C.grass;
        const ex = x ? E[i - 1] : e, ey = y ? E[i - px] : e;
        const k = VC.M.clamp(1 + (e - ex + e - ey) * 7, 0.72, 1.3);
        c = [c[0] * k, c[1] * k, c[2] * k];
      }
      P[i] = ((255 << 24) | (Math.min(255, c[2]) << 16) | (Math.min(255, c[1]) << 8) | Math.min(255, c[0])) >>> 0;
    }
  ctx.putImageData(img, 0, 0);
  return cv;
}
function drawPreview(target, seed, type, size) {
  const px = target.width;
  let src = null;
  try {
    if (VC.worldgen && VC.worldgen.previewCanvas) src = VC.worldgen.previewCanvas({ seed, mapType: type, size }, px);
  } catch (e) { src = null; }
  if (!src || !src.width) src = fallbackPreview(seed, type, Math.min(px, 128));
  const ctx = target.getContext('2d');
  ctx.imageSmoothingEnabled = src.width < px;
  ctx.clearRect(0, 0, px, px);
  ctx.drawImage(src, 0, 0, px, px);
  target.classList.add('ready');
}
/** Regenerates every preview, staggered so the dialog stays responsive. */
function refreshPreviews() {
  const gen = ++NC.gen;
  const o = NC.o;
  const jobs = [[NC.big, o.mapType]];
  for (const [k, cv] of NC.cards) jobs.push([cv, k]);
  jobs.forEach(([cv, type], i) => {
    cv.classList.remove('ready');
    setTimeout(() => { if (gen === NC.gen && NC.back) drawPreview(cv, o.seed, type, o.size); }, 30 + i * 45);
  });
  updateBigLabel();
}
function updateBigLabel() {
  const m = VC.MAP_TYPES.find((x) => x.key === NC.o.mapType) || VC.MAP_TYPES[0];
  NC.bigLabel.textContent = `${m.icon} ${m.name} · ${NC.o.size}×${NC.o.size}`;
}

/* ---------------- dialog ---------------- */
const SIZE_INFO = {
  96: { label: 'Small', note: '⚡ Fast on any machine — great for laptops.' },
  128: { label: 'Medium', note: '👍 Recommended — room for a real metropolis.' },
  192: { label: 'Large', note: '🖥️ Needs a decent GPU for big cities.' },
  256: { label: 'Huge', note: '🔥 High-end PCs only. Epic sprawl.' },
};
const DIFF_ICON = { easy: '🌴', normal: '🎩', hard: '💼', sandbox: '🧸' };
function newSeed() {
  return (Math.random() * 4294967295) >>> 0;
}
function parseSeed(v) {
  v = String(v || '').trim();
  if (!v) return newSeed();
  if (/^\d+$/.test(v)) return Number(v) >>> 0;
  return VC.M.seedFromString(v);
}
function newCity() {
  const ui = VC.ui, menuRoot = VC.menu._root && VC.menu._root();
  if (!menuRoot) return;
  closeDialog(true);
  const st = VC.settings || {};
  NC.o = { name: randomCityName(), seed: newSeed(), mapType: 'river', size: 128, difficulty: 'normal', disasters: st.disasters !== false, tutorial: st.tutorial !== false };
  const o = NC.o;

  // name
  const nameIn = ui.input({ value: o.name, placeholder: 'City name', maxLength: 32, onInput: (v) => (o.name = v), onEnter: found });
  const dice = (fn, tip) => h('button', { class: 'nc-dice', 'data-tip': tip, onclick: (e) => { VC.bus.emit('sfx', { name: 'click' }); VC.ui.flash(e.currentTarget, 'roll'); fn(); } }, '🎲');
  const nameRow = h('div', { class: 'nc-inrow' }, nameIn, dice(() => { o.name = randomCityName(); nameIn.value = o.name; }, 'Random name'));

  // map types
  NC.cards.clear();
  const maps = h('div', { class: 'nc-maps' });
  const mapCards = new Map();
  for (const m of VC.MAP_TYPES) {
    const cv = h('canvas', { class: 'nc-mini', width: 72, height: 72 });
    NC.cards.set(m.key, cv);
    const card = h('button', { class: 'nc-map' + (m.key === o.mapType ? ' active' : ''), onclick: () => {
      VC.bus.emit('sfx', { name: 'click' });
      o.mapType = m.key;
      for (const [k, c] of mapCards) c.classList.toggle('active', k === m.key);
      NC.big.classList.remove('ready');
      setTimeout(() => drawPreview(NC.big, o.seed, o.mapType, o.size), 10);
      updateBigLabel();
    } }, h('div', { class: 'nc-mini-wrap' }, cv), h('div', { class: 'nc-map-t' }, h('b', null, m.icon + ' ' + m.name), h('span', null, m.desc)));
    mapCards.set(m.key, card);
    maps.appendChild(card);
  }

  // difficulty
  const diff = ui.cards(Object.keys(VC.DIFFICULTY).map((k) => {
    const d = VC.DIFFICULTY[k];
    return { value: k, icon: DIFF_ICON[k] || '🏙️', title: d.name, sub: d.unlockAll ? 'Unlimited $' : VC.fmt.money(d.money), desc: d.desc };
  }), { value: o.difficulty, columns: 4, cls: 'nc-diff', onSelect: (v) => (o.difficulty = v) });

  // preview + seed + size
  NC.big = h('canvas', { class: 'nc-big', width: 220, height: 220 });
  NC.bigLabel = h('div', { class: 'nc-big-label' });
  NC.seedInput = ui.input({ value: String(o.seed), placeholder: 'Seed (number or word)', maxLength: 24, onEnter: (v) => { o.seed = parseSeed(v); refreshPreviews(); } });
  let seedT = 0;
  NC.seedInput.addEventListener('input', () => { clearTimeout(seedT); seedT = setTimeout(() => { o.seed = parseSeed(NC.seedInput.value); refreshPreviews(); }, 350); });
  const seedRow = h('div', { class: 'nc-inrow' }, NC.seedInput, dice(() => { o.seed = newSeed(); NC.seedInput.value = String(o.seed); refreshPreviews(); }, 'New random map'));
  const sizeNote = h('div', { class: 'note nc-sizenote' }, SIZE_INFO[o.size].note);
  const sizes = ui.segmented({ options: Object.keys(VC.MAP_SIZES).map((k) => { const v = VC.MAP_SIZES[k]; return { value: v, label: (SIZE_INFO[v] || { label: k }).label, tip: `${v} × ${v} tiles` }; }), value: o.size, cls: 'nc-sizes', onChange: (v) => { o.size = v; sizeNote.textContent = (SIZE_INFO[v] || {}).note || ''; refreshPreviews(); } });

  const toggles = h('div', { class: 'nc-toggles' },
    ui.toggle({ label: 'Disasters', desc: 'Random fires, tornadoes, meteors…', value: o.disasters, onChange: (v) => (o.disasters = v) }),
    ui.toggle({ label: 'Tutorial', desc: 'Step-by-step hints', value: o.tutorial, onChange: (v) => (o.tutorial = v) }));

  const lbl = (t) => h('div', { class: 'nc-label' }, t);
  const dialog = h('div', { class: 'nc-dialog' },
    h('div', { class: 'nc-head' }, h('span', { class: 'nc-hicon' }, '🏗️'), h('div', null, h('b', null, 'Found a New City'), h('small', null, 'Choose your land, your name and your challenge')), h('button', { class: 'win-btn', title: 'Back (Esc)', onclick: () => closeDialog() }, '×')),
    h('div', { class: 'nc-body' },
      h('div', { class: 'nc-left' }, lbl('City name'), nameRow, lbl('Landscape'), maps, lbl('Difficulty'), diff),
      h('div', { class: 'nc-right' },
        h('div', { class: 'nc-pv' }, NC.big, NC.bigLabel),
        lbl('Map seed'), seedRow,
        lbl('Map size'), sizes, sizeNote,
        toggles)),
    h('div', { class: 'nc-foot' },
      VC.ui.button('Back', () => closeDialog(), { cls: 'ghost' }),
      h('span', { class: 'nc-flex' }),
      h('button', { class: 'btn primary big nc-found', onclick: found }, h('span', { class: 'btn-icon' }, '🏙️'), h('span', null, 'Found City'))));
  NC.back = h('div', { class: 'nc-back' }, dialog);
  NC.back.addEventListener('pointerdown', (e) => { if (e.target === NC.back) closeDialog(); });
  menuRoot.appendChild(NC.back);
  menuRoot.classList.add('has-dialog');
  refreshPreviews();
  setTimeout(() => { try { nameIn.focus({ preventScroll: true }); nameIn.select(); } catch (e) { /* ignore */ } }, 60);
}
function found() {
  const o = NC.o;
  if (!o) return;
  const name = (o.name || '').trim() || randomCityName();
  if (VC.settings.tutorial !== o.tutorial) { VC.settings.tutorial = o.tutorial; VC.saveSettings(); }
  const opts = { name: name.slice(0, 32), seed: o.seed >>> 0, size: o.size, mapType: o.mapType, difficulty: o.difficulty, disasters: o.disasters };
  VC.bus.emit('sfx', { name: 'click' });
  closeDialog(true);
  VC.menu.startGame(opts);
}
function closeDialog(instant) {
  const b = NC.back;
  if (!b) return;
  NC.back = null;
  NC.gen++;
  const root = VC.menu._root && VC.menu._root();
  if (root) root.classList.remove('has-dialog');
  if (instant) b.remove();
  else { b.classList.add('out'); setTimeout(() => b.remove(), 220); }
}

Object.assign(VC.menu, {
  newCity,
  closeDialog,
  dialogOpen: () => !!NC.back,
  randomCityName,
  previewCanvas: (seed, type, size, px) => { const cv = document.createElement('canvas'); cv.width = cv.height = px || 96; drawPreview(cv, seed, type, size); return cv; },
});
