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
const PHASE = { active: 'on the ground', burning: 'burning', incoming: 'incoming!', impact: 'impact', shaking: 'shaking', arrive: 'arriving', hover: 'hovering', leave: 'leaving', enter: 'arriving', rampage: 'rampaging' };
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
const activeList = () => (VC.disasters && Array.isArray(VC.disasters.active) ? VC.disasters.active : []).filter((d) => d && d.type);
function unleash(type, x, z) {
  const t = typeInfo(type);
  VC.ui.confirm(`Unleash <b>${t.icon} ${t.name}</b> near tile <b>${Math.round(x)}, ${Math.round(z)}</b>?<br><span style="color:var(--warn)">Buildings may be destroyed. This cannot be undone.</span>`, () => {
    let ok = false;
    if (VC.disasters && typeof VC.disasters.trigger === 'function') ok = U.safe(() => VC.disasters.trigger(type, x, z), false);
    if (ok === false) {
      const act = activeList();
      const why = act.length >= 4 ? 'Too many disasters are already underway.' : act.some((d) => d.type === type) ? `A ${t.name.toLowerCase()} is already underway.` : 'Nothing happened — try another spot.';
      VC.bus.emit('toast', { text: `${t.name}: ${why}`, type: 'warn', icon: t.icon });
    } else if (VC.camera && VC.camera.focus) VC.camera.focus(x, z);
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
      if (VC.disasters && typeof VC.disasters.setEnabled === 'function') VC.disasters.setEnabled(v);
      else VC.state.disastersEnabled = v;
      VC.bus.emit('toast', { text: v ? 'Random disasters <b>enabled</b>. Stay alert!' : 'Random disasters <b>disabled</b>.', type: v ? 'warn' : 'info', icon: '🌪️' });
    } });
    const glob = h('div', { class: 'pn-banner t-info' }, 'ℹ️ Disasters are switched off in Settings, so random events will not occur.');
    const next = h('div', { class: 'pn-dis-next' });
    p.body.append(h('div', { class: 'pn-card pn-dis-toggle' }, tg, next), glob);
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
    const counts = {};
    for (const t of types()) {
      const desc = t.desc || FLAVOR[t.key] || '';
      const cnt = h('span', { class: 'pn-dis-count' });
      counts[t.key] = cnt;
      const b = h('button', { class: 'pn-dis', 'data-tip': `<b>${t.icon} ${t.name}</b><br>${desc}`, onclick: () => {
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
      } }, cnt, h('span', { class: 'pn-dis-icon' }, t.icon), h('span', { class: 'pn-dis-name' }, t.name), h('span', { class: 'pn-dis-desc' }, desc));
      btns[t.key] = b;
      grid.appendChild(b);
    }
    p.body.appendChild(U.sec('Unleash', types().length ? grid : U.empty('🕊️', 'No disasters available', '')));
    const act = h('div', { class: 'pn-dis-active' });
    const none = h('div', { class: 'pn-em-none' }, '☀️ No active disasters. Enjoy the calm.');
    p.body.appendChild(U.sec('Active now', act, none));
    const kTot = U.kpi('Disasters', { icon: '📜', tip: 'Disasters this city has suffered' });
    const kDes = U.kpi('Destroyed', { icon: '🏚️', tip: 'Buildings destroyed by disasters' });
    const kAbd = U.kpi('Abducted', { icon: '🛸', tip: 'Buildings taken by UFOs' });
    p.body.appendChild(U.sec('City record', h('div', { class: 'pn-kpis cols3' }, kTot, kDes, kAbd)));
    const focusD = (d) => {
      if (!d) return;
      if (VC.disasters && typeof VC.disasters.focus === 'function' && VC.disasters.focus(d)) return;
      if (VC.camera && VC.camera.focus) VC.camera.focus(d.x, d.z, 38);
    };
    const actRow = () => {
      const nm = h('span', { class: 'pn-em-name' });
      const where = h('span', { class: 'pn-dis-where' });
      const el = h('div', { class: 'pn-em' }, h('span', { class: 'pn-em-ic' }), nm, where, VC.ui.button('', () => focusD(el._d), { icon: '📍', cls: 'small', tip: 'Focus camera' }));
      el.set = (d) => {
        el._d = d;
        const t = typeInfo(d.type);
        U.txt(el.firstChild, d.icon || t.icon);
        const dmg = (d.destroyed || 0) + (d.abducted || 0);
        const ph = d.phase && d.phase !== 'start' ? PHASE[d.phase] || d.phase : '';
        U.txt(nm, (d.name || t.name) + (ph ? ' · ' + ph : '') + (dmg ? ' · ' + dmg + ' lost' : ''));
        U.txt(where, d.x != null ? `${Math.round(d.x)}, ${Math.round(d.z)}` : '');
      };
      return el;
    };
    return () => {
      const S = VC.state;
      tg.setValue(S.disastersEnabled !== false);
      U.show(glob, VC.settings && VC.settings.disasters === false);
      const ni = U.api('disasters', 'nextIn', [], null);
      U.txt(next, typeof ni === 'number' ? (ni <= 0 ? '⏳ A random disaster could strike any day now…' : `⏳ Next random disaster possible in ~${Math.round(ni)} days`) : '');
      U.show(next, typeof ni === 'number');
      const st = S.disasterStats || (VC.disasters && VC.disasters.stats) || {};
      kTot.set(U.int(st.count || 0), st.count ? 'survived so far' : 'none yet');
      kDes.set(U.int(st.destroyed || 0), 'buildings', st.destroyed ? 'bad' : '');
      kAbd.set(U.int(st.abducted || 0), 'buildings', st.abducted ? 'warn' : '');
      for (const k in counts) {
        const n = (st.byType && st.byType[k]) || 0;
        U.txt(counts[k], n ? '×' + n : '');
        U.show(counts[k], n > 0);
      }
      seg.set(targetMode);
      U.show(armBox, !!armed);
      if (armed) U.txt(armTxt, `${typeInfo(armed).icon} Click anywhere on the map to drop the ${typeInfo(armed).name.toLowerCase()}…`);
      for (const k in btns) U.cls(btns[k], 'armed', armed === k);
      const list = activeList();
      U.keyed(act, list, (d, i) => d.id != null ? d.id : d.type + ':' + i, actRow, (el, d) => el.set(d));
      U.show(none, !list.length);
    };
  },
};
