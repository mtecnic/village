/*
 * VOXELPOLIS — Settings and Help windows.
 *   VC.hud.openSettings(tab?)  window 'settings': Graphics (quality preset, dynamic resolution, bloom,
 *       tilt-shift, shadows, ambient occlusion (ssao), god rays (godRays), weather visuals, day/night mode,
 *       FPS), Audio (mute all, master / music / sound effects / ambience volume: muted, masterVol, musicVol,
 *       sfxVol, ambienceVol), Gameplay (random disasters: this city = S.disastersEnabled via
 *       VC.disasters.setEnabled, new cities = VC.settings.disasters; autosave, edge scrolling, invert zoom,
 *       grid, tutorial hints + restart), Interface (UI scale, news ticker, reset). Every settings change is
 *       persisted with VC.saveSettings() (emits 'settings'); sliders apply live while dragging.
 *   VC.hud.openHelp(tab?)      window 'help': Controls (VC.input.KEYMAP or built-in list: alternatives ', ' or
 *       ' / ', chords ' + ', see keyChips; the camera rows carry this keyboard layout's labels, with a note while
 *       VC.input does not know them yet), How to Play (illustrated guide), Overlays (every overlay + "try it"), Tips.
 * Both toggle when called while open with no tab argument.
 */
const h = VC.h;

function set(key, value, after) {
  VC.settings[key] = value;
  VC.saveSettings();
  if (after) { try { after(value); } catch (e) { console.error('[settings]', e); } }
}
const S = () => VC.settings || {};

/* ================================================================== */
/* SETTINGS                                                            */
/* ================================================================== */
function openSettings(tab) {
  const ui = VC.ui;
  if (ui.isOpen('settings') && !tab) { ui.closeWindow('settings'); return; }
  const w = ui.window('settings', { title: 'Settings', icon: '⚙️', width: 500, cls: 'win-settings' });
  w.body.innerHTML = '';
  const tabs = ui.tabs([
    { key: 'graphics', label: 'Graphics', icon: '🎨', render: renderGraphics },
    { key: 'audio', label: 'Audio', icon: '🔊', render: renderAudio },
    { key: 'gameplay', label: 'Gameplay', icon: '🎮', render: renderGameplay },
    { key: 'interface', label: 'Interface', icon: '🖥️', render: renderInterface },
  ], { active: tab || w._tab || 'graphics', onChange: (k) => (w._tab = k) });
  w.body.appendChild(tabs);
  w.body.appendChild(h('div', { class: 'set-foot' }, h('span', null, '💾 Settings are saved automatically'), h('span', { class: 'set-ver' }, VC.NAME + ' v' + VC.VERSION)));
}

function renderGraphics(c) {
  const ui = VC.ui, st = S();
  const q = VC.QUALITY;
  const qDesc = h('div', { class: 'note set-qnote' });
  const describeQ = (k) => {
    const p = q[k] || q.high;
    qDesc.innerHTML = `${p.shadow ? `Shadows ${p.shadow}px` : 'No shadows'} · ${p.bloom ? 'Bloom' : 'No bloom'} · ${Math.round(p.scale * 100)}% resolution · up to ${VC.fmt.num(p.cars)} cars`;
  };
  c.appendChild(ui.section('Quality',
    ui.segmented({ options: Object.keys(q).map((k) => ({ value: k, label: q[k].name })), value: st.quality, onChange: (v) => { describeQ(v); set('quality', v, () => VC.gfx && VC.gfx.resize && VC.gfx.resize()); } }),
    qDesc,
    ui.toggle({ label: 'Dynamic resolution', desc: 'Lowers render resolution when the framerate drops', value: st.autoQuality, onChange: (v) => set('autoQuality', v, () => VC.gfx && VC.gfx.resize && VC.gfx.resize()) })));
  describeQ(st.quality);
  c.appendChild(ui.section('Effects',
    h('div', { class: 'set-grid' },
      ui.toggle({ label: 'Bloom', desc: 'Glowing lights and highlights', value: st.bloom, onChange: (v) => set('bloom', v) }),
      ui.toggle({ label: 'Tilt-shift', desc: 'Miniature-world depth of field', value: st.tiltShift, onChange: (v) => set('tiltShift', v) }),
      ui.toggle({ label: 'Shadows', desc: 'Sun and moon shadows', value: st.shadows, onChange: (v) => set('shadows', v) }),
      ui.toggle({ label: 'Ambient occlusion', desc: 'Soft contact shadows in corners (High & Ultra)', value: st.ssao !== false, onChange: (v) => set('ssao', v) }),
      ui.toggle({ label: 'God rays', desc: 'Shafts of sunlight through the haze (High & Ultra)', value: st.godRays !== false, onChange: (v) => set('godRays', v) }),
      ui.toggle({ label: 'Weather effects', desc: 'Draws rain, snow, fog and lightning', value: st.weather, onChange: (v) => set('weather', v) }))));
  c.appendChild(ui.section('Time of day',
    ui.segmented({ options: [{ value: 'cycle', icon: '🔄', label: 'Cycle' }, { value: 'day', icon: '☀️', label: 'Day' }, { value: 'sunset', icon: '🌇', label: 'Sunset' }, { value: 'night', icon: '🌙', label: 'Night' }], value: st.dayNight || 'cycle', onChange: (v) => set('dayNight', v) }),
    ui.toggle({ label: 'Show FPS counter', desc: 'Frame rate and render resolution, bottom-right', value: !!st.showFps, onChange: (v) => set('showFps', v) })));
}

function renderAudio(c) {
  const ui = VC.ui, st = S();
  const pct = (v) => (v === 0 ? 'Off' : Math.round(v) + '%');
  const MUTED_COL = '#707b92';
  const vol = (key, def) => Math.round((st[key] != null ? st[key] : def) * 100);
  /** Volume slider bound to settings[key] (0..1): live while dragging, persisted on release. */
  const volSlider = (key, def, label, icon, color, desc, after) => {
    const el = ui.slider({ label, icon, min: 0, max: 100, step: 1, value: vol(key, def), format: pct, tip: desc,
      color: (v) => (v === 0 ? MUTED_COL : color),
      onInput: (v) => { VC.settings[key] = v / 100; },
      onChange: (v) => { set(key, v / 100); if (after) after(v); } });
    return el;
  };
  const sliders = h('div', { class: 'set-vols' },
    volSlider('masterVol', 1, 'Master volume', '🔊', '#e9eef8', 'Scales everything below'),
    volSlider('musicVol', 0.5, 'Music', '🎵', '#b388ff', 'Generative soundtrack'),
    volSlider('sfxVol', 0.7, 'Sound effects', '🔔', '#5ad1ff', 'Building, alerts and interface sounds', () => VC.bus.emit('sfx', { name: 'click' })),
    volSlider('ambienceVol', 0.6, 'Ambience', '🌳', '#3ddc84', 'City hum, traffic, birds, wind, rain and disaster sounds'));
  const syncMute = (m) => sliders.classList.toggle('muted', !!m);
  const mute = ui.toggle({ label: 'Mute all sound', desc: 'Silences music, effects and ambience (also the 🔊 button in the top bar)', value: !!st.muted, onChange: (v) => { set('muted', v); syncMute(v); } });
  syncMute(st.muted);
  c.appendChild(ui.section('Volume', mute, sliders));
  c.appendChild(ui.note('Every sound and note in Voxelpolis is generated live by your browser — no audio files. Music adapts to the time of day and how your city is doing.'));
}

/** A real (non-demo) city is running. */
const inCity = () => !!(VC.state && !VC.state.demo && VC.hud.visible);
function renderGameplay(c) {
  const ui = VC.ui, st = S();
  // Random disasters: ONE switch per city (S.disastersEnabled, same as the Disasters panel and the New City
  // dialog); the settings value is only the default for cities founded from now on.
  const city = inCity() ? VC.state : null;
  const cityTg = city ? ui.toggle({ label: 'Random disasters in this city', desc: `Fires, tornadoes, meteors… in ${city.name || 'this city'}. Same switch as the 🌪️ Disasters panel; you can always trigger them by hand there.`, value: city.disastersEnabled !== false, onChange: (v) => {
    if (VC.disasters && VC.disasters.setEnabled) VC.disasters.setEnabled(v);
    else city.disastersEnabled = v;
    VC.panels && VC.panels.refresh && VC.panels.refresh('disasters');
  } }) : null;
  const defTg = ui.toggle({ label: city ? 'Disasters in new cities' : 'Random disasters', desc: 'Default for the “Natural disasters” option when you found a new city.', value: st.disasters !== false, onChange: (v) => set('disasters', v) });
  c.appendChild(ui.section('Simulation', cityTg, defTg,
    ui.toggle({ label: 'Autosave', desc: 'Keeps a rolling backup of your city while you play', value: st.autosave, onChange: (v) => set('autosave', v) })));
  c.appendChild(ui.section('Camera & building',
    ui.toggle({ label: 'Edge scrolling', desc: 'Move the camera when the mouse touches the screen edge', value: st.edgeScroll, onChange: (v) => set('edgeScroll', v) }),
    ui.toggle({ label: 'Invert zoom', desc: 'Reverse the mouse-wheel zoom direction', value: st.invertZoom, onChange: (v) => set('invertZoom', v) }),
    ui.toggle({ label: 'Show build grid', desc: 'Tile grid while a building tool is active', value: st.showGrid, onChange: (v) => set('showGrid', v) })));
  const restart = ui.button('Restart tutorial', () => { set('tutorial', true); VC.hud.startTutorial(true); tg.setValue(true); }, { icon: '🎓', cls: 'small', disabled: !(VC.hud.visible && VC.state && !VC.state.demo) });
  const tg = ui.toggle({ label: 'Tutorial hints', desc: 'Step-by-step guide when you found a new city', value: st.tutorial, onChange: (v) => { set('tutorial', v); if (!v) VC.hud.stopTutorial && VC.hud.stopTutorial(); } });
  c.appendChild(ui.section('Help', tg, h('div', { class: 'row', style: { marginTop: '6px' } }, restart)));
}

function renderInterface(c) {
  const ui = VC.ui, st = S();
  c.appendChild(ui.section('Display',
    ui.slider({ label: 'Interface scale', icon: '🔍', min: 0.8, max: 1.4, step: 0.05, value: st.uiScale || 1, ticks: [1], format: (v) => Math.round(v * 100) + '%', onChange: (v) => set('uiScale', +v.toFixed(2)) }),
    ui.toggle({ label: 'News ticker', desc: 'Scrolling headlines along the bottom of the screen', value: st.ticker !== false, onChange: (v) => set('ticker', v) }),
    ui.toggle({ label: 'Growth popups & celebrations', desc: 'Floating +residents, level-ups, coins and milestone confetti', value: st.juice !== false, onChange: (v) => set('juice', v) })));
  c.appendChild(ui.section('Reset',
    h('div', { class: 'row' },
      ui.button('Restore defaults', () => ui.confirm('Reset every setting to its default value?', () => {
        const keep = { tutorial: VC.settings.tutorial };
        // keys the defaults table may not list (masterVol, ssao, godRays) are reset explicitly
        Object.assign(VC.settings, { masterVol: 1, ssao: true, godRays: true, muted: false }, VC.DEFAULT_SETTINGS, keep, { showFps: false, ticker: true, minimapOpen: true });
        VC.saveSettings();
        VC.gfx && VC.gfx.resize && VC.gfx.resize();
        openSettings('interface');
        ui.toast('Settings restored to defaults.', { type: 'good' });
      }, { yes: 'Reset', danger: true }), { icon: '↺', cls: 'small danger' }))));
  c.appendChild(ui.note('Tip: press H to hide the interface for screenshots, or use 📷 Photo mode in the dock.'));
}

/* ================================================================== */
/* HELP                                                                */
/* ================================================================== */
const DEFAULT_KEYS = [
  { group: 'Camera', keys: 'W A S D / Arrows', action: 'Pan the camera' },
  { group: 'Camera', keys: 'Right-drag', action: 'Rotate and tilt' },
  { group: 'Camera', keys: 'Middle-drag', action: 'Pan (drag the ground)' },
  { group: 'Camera', keys: 'Wheel / + / −', action: 'Zoom in and out' },
  { group: 'Camera', keys: 'Q / E', action: 'Rotate left / right' },
  { group: 'Camera', keys: 'C', action: 'Cinematic camera' },
  { group: 'Building', keys: '1 … 0 / T / B', action: 'Open tool groups' },
  { group: 'Building', keys: 'Left-drag', action: 'Build roads, zones, lines' },
  { group: 'Building', keys: 'R', action: 'Rotate building' },
  { group: 'Building', keys: 'B', action: 'Bulldozer' },
  { group: 'Building', keys: 'L', action: 'Toggle build grid' },
  { group: 'Building', keys: 'Esc', action: 'Cancel tool / close window / menu' },
  { group: 'Game', keys: 'Space', action: 'Pause / resume' },
  { group: 'Game', keys: '[ / ]', action: 'Slower / faster' },
  { group: 'Game', keys: 'O', action: 'Cycle map overlays' },
  { group: 'Game', keys: 'H', action: 'Hide interface (photo)' },
  { group: 'Game', keys: 'F1', action: 'This help' },
  { group: 'Managers', keys: 'M', action: 'Budget & taxes' },
  { group: 'Managers', keys: 'P', action: 'Policies' },
  { group: 'Managers', keys: 'G', action: 'Statistics' },
  { group: 'Managers', keys: 'U', action: 'Population & demand' },
  { group: 'Managers', keys: 'V', action: 'City services' },
  { group: 'Managers', keys: 'Y', action: 'Power & water' },
  { group: 'Managers', keys: 'N', action: 'Advisors' },
  { group: 'Managers', keys: 'J', action: 'Milestones' },
  { group: 'Managers', keys: 'X', action: 'Disasters' },
  { group: 'Managers', keys: 'K', action: 'Save & load' },
];
const GUIDE = [
  { icon: '🛣️', title: 'Build roads', text: 'Everything starts with roads. Pick <b>Roads</b> <kbd>1</kbd> and drag across the land. Zones only develop within a few tiles of a street or avenue; highways move traffic fast but give no zone access.' },
  { icon: '🏘️', title: 'Zone land', text: 'Paint <b style="color:var(--R)">Residential</b> for homes, <b style="color:var(--C)">Commercial</b> for shops and offices, <b style="color:var(--I)">Industrial</b> for factories <kbd>2</kbd>. Denser zones unlock as your population grows.' },
  { icon: '📊', title: 'Read the demand', text: 'The <b>R C I</b> bars in the top bar show what citizens want. Bars above the line mean “build more of this!”. Balance homes with jobs.' },
  { icon: '⚡', title: 'Power', text: 'Build a power plant <kbd>3</kbd> next to a road. Electricity travels along roads, power lines and touching buildings — empty zoned land does not carry it. Watch the ⚡ pill for shortages.' },
  { icon: '💧', title: 'Water', text: 'Place a <b>water pump</b> next to a river or lake, or a <b>water tower</b> anywhere <kbd>4</kbd>, beside a road: water flows through the pipes under roads, and pumps and towers need power. No water, no growth.' },
  { icon: '🚓', title: 'Services', text: 'Police, fire, clinics and schools cover a radius around them <kbd>5</kbd> <kbd>6</kbd>. Covered neighbourhoods are safer, healthier and worth more. Parks <kbd>7</kbd> make everyone happier.' },
  { icon: '💰', title: 'Budget', text: 'Taxes pay for everything. Open the budget <kbd>M</kbd> to tune tax rates per zone and wealth level, fund departments and enact policies. Keep the monthly net above zero — or take a loan.' },
  { icon: '💎', title: 'Land value & growth', text: 'Buildings level up when land value, services and happiness are high. Pollution, crime, noise and traffic drag value down. Use overlays <kbd>O</kbd> to find problems.' },
  { icon: '😊', title: 'Happiness', text: 'Happy citizens pay taxes and stay. Jobs, services, parks, low taxes and clean air all help. Your approval rating is the 🙂 in the top bar.' },
  { icon: '🌪️', title: 'Disasters', text: 'Fires, tornadoes, meteors, earthquakes, UFOs… and Cubezilla. Keep fire coverage high and cash in the bank. Switch random disasters on or off for your city in the Disasters panel <kbd>X</kbd>.' },
  { icon: '🏆', title: 'Milestones', text: 'Growing your peak population earns new titles, cash grants and unlocks: avenues, dense zones, big services, landmarks and wonders.' },
];
const TIPS = [
  'Put industry downwind and away from homes — pollution tanks land value.',
  'A grid of streets with one avenue through the middle keeps traffic flowing.',
  'Water towers work anywhere; pumps need water but give more.',
  'Parks are cheap and raise land value around them. Sprinkle them everywhere!',
  'Lower taxes on a zone to boost its demand; raise them when you need cash.',
  'Build a school early — educated citizens attract better jobs.',
  'Watch the ⚡ and 💧 pills: red and pulsing means a shortage.',
  'Use the land value overlay to decide where to put high-density zones.',
  'Unique landmarks boost tourism, which boosts commercial demand.',
  'Loans are fine for big investments — just make sure your net is positive.',
  'Right-drag to rotate the view and see your city from new angles.',
  'Press C for a cinematic camera, H to hide the UI and take a screenshot.',
  'Fire stations cut fire risk dramatically. Don’t let coverage lapse!',
  'Buildings without road access, power or water will never grow.',
  'Hover anything in the top bar for detailed tooltips.',
];

function openHelp(tab) {
  const ui = VC.ui;
  if (ui.isOpen('help') && !tab) { ui.closeWindow('help'); return; }
  const w = ui.window('help', { title: 'How to Play', icon: '❓', width: 640, cls: 'win-help' });
  w.body.innerHTML = '';
  w.body.appendChild(ui.tabs([
    { key: 'guide', label: 'How to Play', icon: '📖', render: renderGuide },
    { key: 'controls', label: 'Controls', icon: '⌨️', render: renderControls },
    { key: 'overlays', label: 'Overlays', icon: '🗺️', render: renderOverlays },
    { key: 'tips', label: 'Tips', icon: '💡', render: renderTips },
  ], { active: tab || w._tab || 'guide', onChange: (k) => (w._tab = k) }));
}
const MOUSE_RE = /drag|click|wheel|scroll|tap|pinch/i;
/**
 * KEYMAP key strings -> chips: 'Wheel, Pinch, +, −' -> 🖱 Wheel or 🖱 Pinch or [+] or [−]; 'Ctrl + Z' ->
 * [Ctrl]+[Z]; 'W A S D, Arrows' -> 4 caps or [Arrows]; 'Right-click, Esc' -> 🖱 Right-click or [Esc].
 * Alternatives are separated by ', ' (VC.input.KEYMAP) or ' / ' (the built-in list), chords by ' + ' (or glued,
 * as in 'Ctrl+Z'); a lone ',' '+' '/' or '−' is a key of its own. Each chord part is a mouse chip when it names
 * a mouse gesture, else a key cap.
 */
function keyChips(keys) {
  const wrap = h('span', { class: 'hk-keys' });
  const str = String(keys).trim();
  const alts = str.length === 1 ? [str] : str.split(/\s*,\s+|\s+\/\s+/).filter((a) => a !== '');
  alts.forEach((alt, i) => {
    if (i) wrap.appendChild(h('span', { class: 'hk-or' }, 'or'));
    let chord = alt.split(/\s+\+\s+/);
    if (chord.length === 1 && /^[^\s+]+\+[^\s+]+$/.test(alt)) chord = alt.split('+');
    chord.forEach((k, j) => {
      if (j) wrap.appendChild(h('span', { class: 'hk-or' }, '+'));
      if (MOUSE_RE.test(k)) { wrap.appendChild(h('span', { class: 'hk-mouse' }, '🖱️ ' + k)); return; }
      // "W A S D" -> four caps; multi-word labels stay together
      const parts = /^([A-Za-z0-9À-ɏͰ-ӿ] )+[A-Za-z0-9À-ɏͰ-ӿ]$/.test(k) ? k.split(' ') : [k];
      parts.forEach((p) => wrap.appendChild(h('kbd', { class: 'kbd' }, p)));
    });
  });
  return wrap;
}
function renderControls(c) {
  const km = VC.input && Array.isArray(VC.input.KEYMAP) && VC.input.KEYMAP.length ? VC.input.KEYMAP : DEFAULT_KEYS;
  const groups = new Map();
  for (const k of km) {
    const g = k.group || 'Controls';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(k);
  }
  const grid = h('div', { class: 'hk-grid' });
  for (const [g, list] of groups) {
    grid.appendChild(h('div', { class: 'hk-group' }, h('div', { class: 'section-title' }, g), list.map((k) => h('div', { class: 'hk-row' }, keyChips(k.keys || k.key || ''), h('span', { class: 'hk-act' }, k.action || k.desc || '')))));
  }
  c.appendChild(grid);
  // the camera letter keys work by POSITION: until VC.input knows this keyboard's labels for them, say so
  const I = VC.input;
  if (I && typeof I.posKnown === 'function' && !I.posKnown()) {
    c.appendChild(VC.ui.note('⌨️ The camera keys work by position: W A S D and Q E are the keys where those letters sit on a US keyboard (Z Q S D and A E on a French AZERTY keyboard).'));
  }
}
function renderGuide(c) {
  const list = h('div', { class: 'guide' });
  GUIDE.forEach((g, i) => list.appendChild(h('div', { class: 'guide-step', style: { animationDelay: i * 0.03 + 's' } }, h('div', { class: 'gs-num' }, h('span', { class: 'gs-icon' }, g.icon), h('b', null, i + 1)), h('div', { class: 'gs-text' }, h('div', { class: 'gs-title' }, g.title), h('div', { class: 'gs-desc', html: g.text })))));
  c.appendChild(list);
}
function renderOverlays(c) {
  const desc = VC.hud.OVERLAY_DESC || {};
  const list = h('div', { class: 'ovh-list' });
  for (const o of VC.OVERLAYS) {
    if (o.key === 'none') continue;
    const grad = VC.hud.overlayGradient ? VC.hud.overlayGradient(o.ramp) : '';
    list.appendChild(h('div', { class: 'ovh-row' },
      h('span', { class: 'ovh-icon' }, o.icon),
      h('div', { class: 'ovh-text' }, h('div', { class: 'ovh-name' }, o.name, h('i', { class: 'ovh-strip', style: { background: grad } })), h('div', { class: 'ovh-desc' }, desc[o.key] || '')),
      VC.ui.button('Show', () => VC.gfx.setOverlay(o.key), { cls: 'small' })));
  }
  c.appendChild(list);
}
function renderTips(c) {
  const list = h('div', { class: 'tips' });
  TIPS.forEach((t) => list.appendChild(h('div', { class: 'tip-row' }, h('span', { class: 'tip-bulb' }, '💡'), h('span', null, t))));
  c.appendChild(list);
}

Object.assign(VC.hud, { openSettings, openHelp, TIPS });
