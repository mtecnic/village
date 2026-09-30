/*
 * VOXELPOLIS — Disasters panel ('disasters'): random-disaster toggle (S.disastersEnabled), a grid of
 * VC.disasters.TYPES to unleash (with confirmation) at the camera centre or at a location picked on
 * the map (next bus 'select' is consumed via VC.panels.onSelectHook), and the active disasters list.
 */
const P = VC.panels, U = P.util, h = VC.h;

const FLAVOR = {
  fire: 'Sets a building ablaze. Fire coverage decides how far it spreads.',
  tornado: 'A twister carves a path of destruction across town.',
  meteor: 'A flaming rock from the heavens. Big crater guaranteed.',
  earthquake: 'The ground shakes and weaker buildings crumble.',
  ufo: 'Visitors from beyond, armed with a tractor beam.',
  monster: 'Cubezilla stomps through downtown. Run!',
};
let targetMode = 'camera'; // 'camera' | 'pick'
let armed = null; // disaster type waiting for a map click

function types() {
  const t = VC.disasters && VC.disasters.TYPES;
  return Array.isArray(t) ? t : [];
}
function typeInfo(key) {
  return types().find((t) => t.key === key) || { key, name: key, icon: '⚠️' };
}
function disarm() {
  armed = null;
  if (P.onSelectHook === pickHook) P.onSelectHook = null;
  P.refresh('disasters');
}
function unleash(type, x, z) {
  const t = typeInfo(type);
  VC.ui.confirm(`Unleash <b>${t.icon} ${t.name}</b> near tile <b>${Math.round(x)}, ${Math.round(z)}</b>?<br><span style="color:var(--warn)">Buildings may be destroyed. This cannot be undone.</span>`, () => {
    let ok = false;
    if (VC.disasters && typeof VC.disasters.trigger === 'function') ok = U.safe(() => VC.disasters.trigger(type, x, z), false);
    if (ok === false) VC.bus.emit('toast', { text: `The ${t.name.toLowerCase()} fizzled out — nothing happened.`, type: 'warn', icon: t.icon });
    else if (VC.camera && VC.camera.focus) VC.camera.focus(x, z);
    P.refresh('disasters');
  }, { title: '⚠️ Trigger disaster', yes: t.icon + ' Unleash it' });
}
/** Consumes the next map click while a disaster is armed. */
function pickHook(sel) {
  if (!armed) return false;
  if (!sel) return true; // clicking empty space / cancelling keeps the mode armed
  const type = armed;
  disarm();
  const b = sel.building;
  const x = sel.x != null ? sel.x : b ? b.x + b.w / 2 : 0;
  const z = sel.z != null ? sel.z : b ? b.z + b.d / 2 : 0;
  unleash(type, x, z);
  return true;
}

P.defs.disasters = {
  title: 'Disasters',
  icon: '🌪️',
  width: 520,
  place: 'left',
  onClose() {
    disarm();
  },
  build(p) {
    const S = VC.state;
    p.body.appendChild(h('div', { class: 'pn-banner t-bad' }, '⚠️ Disasters destroy buildings and cost money. Save your city first if you want to be able to undo the damage.'));
    const tg = VC.ui.toggle({ label: 'Random disasters', desc: 'Nature strikes now and then. Turn off for a peaceful city.', value: S.disastersEnabled !== false, onChange: (v) => {
      VC.state.disastersEnabled = v;
      VC.bus.emit('toast', { text: v ? 'Random disasters <b>enabled</b>. Stay alert!' : 'Random disasters <b>disabled</b>.', type: v ? 'warn' : 'info', icon: '🌪️' });
    } });
    const glob = h('div', { class: 'pn-banner t-info' }, 'ℹ️ Disasters are switched off in Settings, so random events will not occur.');
    p.body.append(h('div', { class: 'pn-card pn-dis-toggle' }, tg), glob);
    const seg = U.seg([{ value: 'camera', label: '🎯 Camera centre' }, { value: 'pick', label: '📍 Pick on map' }], targetMode, (v) => {
      targetMode = v;
      if (v === 'camera') disarm();
    });
    p.body.appendChild(h('div', { class: 'pn-toolbar' }, h('span', { class: 'pn-toolbar-label' }, 'Target'), seg));
    const armBox = h('div', { class: 'pn-banner t-warn pn-dis-armed' });
    const cancel = VC.ui.button('Cancel', disarm, { cls: 'small' });
    armBox.appendChild(h('span', { class: 'pn-grow' }));
    armBox.appendChild(cancel);
    const armTxt = h('span');
    armBox.insertBefore(armTxt, armBox.firstChild);
    p.body.appendChild(armBox);
    const grid = h('div', { class: 'pn-dis-grid' });
    const btns = {};
    for (const t of types()) {
      const b = h('button', { class: 'pn-dis', 'data-tip': FLAVOR[t.key] || t.name, onclick: () => {
        VC.bus.emit('sfx', { name: 'click' });
        if (targetMode === 'pick') {
          armed = armed === t.key ? null : t.key;
          if (armed) {
            P.onSelectHook = pickHook;
            if (VC.tools && VC.tools.current !== 'select' && VC.tools.select) VC.tools.select('select');
            VC.bus.emit('toast', { text: `📍 Click on the map to choose where the <b>${t.name}</b> strikes.`, type: 'warn', icon: t.icon });
          } else disarm();
          P.refresh('disasters');
        } else {
          const cam = VC.camera || {};
          unleash(t.key, U.num(cam.tx, VC.state.W / 2), U.num(cam.tz, VC.state.H / 2));
        }
      } }, h('span', { class: 'pn-dis-icon' }, t.icon), h('span', { class: 'pn-dis-name' }, t.name), h('span', { class: 'pn-dis-desc' }, FLAVOR[t.key] || ''));
      btns[t.key] = b;
      grid.appendChild(b);
    }
    p.body.appendChild(U.sec('Unleash', types().length ? grid : U.empty('🕊️', 'No disasters available', '')));
    const act = h('div', { class: 'pn-dis-active' });
    const none = h('div', { class: 'pn-em-none' }, '☀️ No active disasters. Enjoy the calm.');
    p.body.appendChild(U.sec('Active now', act, none));
    const actRow = () => {
      const nm = h('span', { class: 'pn-em-name' });
      const where = h('span', { class: 'pn-dis-where' });
      const el = h('div', { class: 'pn-em' }, h('span', { class: 'pn-em-ic' }), nm, where, VC.ui.button('', () => el._d && VC.camera && VC.camera.focus && VC.camera.focus(el._d.x, el._d.z), { icon: '📍', cls: 'small', tip: 'Focus camera' }));
      el.set = (d) => {
        el._d = d;
        const t = typeInfo(d.type);
        U.txt(el.firstChild, t.icon);
        U.txt(nm, t.name);
        U.txt(where, d.x != null ? `at ${Math.round(d.x)}, ${Math.round(d.z)}` : '');
      };
      return el;
    };
    return () => {
      tg.setValue(VC.state.disastersEnabled !== false);
      U.show(glob, VC.settings && VC.settings.disasters === false);
      seg.set(targetMode);
      U.show(armBox, !!armed);
      if (armed) U.txt(armTxt, `${typeInfo(armed).icon} Click anywhere on the map to drop the ${typeInfo(armed).name.toLowerCase()}…`);
      for (const k in btns) U.cls(btns[k], 'armed', armed === k);
      const list = (VC.disasters && Array.isArray(VC.disasters.active) ? VC.disasters.active : []).filter((d) => d && d.type);
      U.keyed(act, list, (d, i) => d.id != null ? d.id : d.type + ':' + i, actRow, (el, d) => el.set(d));
      U.show(none, !list.length);
    };
  },
};
