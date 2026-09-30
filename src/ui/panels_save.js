/*
 * VOXELPOLIS — Save & Load panel ('save'): save the current city to a named slot (overwrite with
 * confirmation), list slots from VC.save.list() with thumbnail / population / date / money / saved
 * time, Load / Overwrite / Delete / Import (all confirmed), Export files. Every VC.save call may be
 * synchronous or return a Promise; buttons are disabled while an operation is in flight. Save names are
 * user text: always escaped (U.esc) before they go into HTML. Esc in the name field closes the panel.
 * OVERWRITE: "Save city" only asks to overwrite when a MANUAL save with that exact slot id exists (an
 * autosave carrying the city's name is a different slot and is never replaced by it).
 * WHERE SAVES LIVE: a footer note explains that saves stay in this browser for this copy of the game (a moved
 * or re-downloaded file:// page starts with an empty list; private windows forget them) and to Export
 * backups; when storage is unavailable (VC.save.storageInfo().mode 'memory') it says so loudly.
 */
const P = VC.panels, U = P.util, h = VC.h;

/** Normalizes whatever VC.save.list() returns per slot into a display record. */
function norm(s, i) {
  if (s == null) return null;
  if (typeof s !== 'object') return { slot: s, name: String(s) };
  const slot = s.slot != null ? s.slot : s.id != null ? s.id : s.key != null ? s.key : s.name != null ? s.name : i;
  const t = s.time;
  return {
    slot,
    name: s.name || s.city || s.cityName || String(slot),
    label: s.label || (s.name && String(slot) !== s.name ? String(slot) : ''),
    pop: s.pop != null ? s.pop : s.population != null ? s.population : s.stats && s.stats.pop,
    day: s.day != null ? s.day : t && typeof t === 'object' ? t.day : null,
    money: s.money,
    saved: typeof t === 'number' ? t : s.savedAt || s.saved || s.ts || s.date || s.timestamp || null,
    thumb: s.thumb || s.thumbnail || s.image || s.img || null,
    auto: !!s.auto || /auto/i.test(String(slot)),
    size: s.size || s.W,
    mapType: s.mapType,
  };
}
function ago(ts) {
  if (ts == null) return '';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d)) return String(ts);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' days ago';
  return d.toLocaleDateString();
}
const has = (fn) => VC.save && typeof VC.save[fn] === 'function';

P.defs.save = {
  title: 'Save & Load',
  icon: '💾',
  width: 580,
  place: 'center',
  build(p) {
    let busy = false, slots = [], loaded = false, lastList = 0, err = null;
    const S = VC.state;
    const input = h('input', { class: 'pn-input', type: 'text', maxlength: 40, placeholder: 'Save name', value: S.name || 'My City', onkeydown: (e) => {
      e.stopPropagation(); // typing must not trigger game hotkeys
      if (e.key === 'Enter') doSave(input.value);
      else if (e.key === 'Escape') {
        e.preventDefault();
        input.blur();
        P.close('save');
      }
    } });
    const saveBtn = VC.ui.button('Save city', () => doSave(input.value), { icon: '💾', cls: 'primary' });
    p.body.appendChild(h('div', { class: 'pn-card pn-save-new' }, h('div', { class: 'pn-save-new-title' }, '💾 Save current city'), h('div', { class: 'pn-save-new-row' }, input, saveBtn)));
    const list = h('div', { class: 'pn-slots' });
    const empty = U.empty('🗂️', 'No saved cities yet', 'Save your city above, or import a city file you exported earlier.');
    const loading = h('div', { class: 'pn-muted-note pn-save-loading' }, 'Loading saves…');
    const countEl = h('span', { class: 'pn-muted-note' });
    p.body.appendChild(h('div', { class: 'pn-sec' }, h('div', { class: 'pn-toolbar' }, h('span', { class: 'pn-sec-title pn-inline' }, 'Saved cities'), countEl), loading, list, empty));
    // export/import never lock the panel: a file picker the user cancels may never settle its promise
    const fail = (text, e) => VC.ui.toast(U.esc(text + (e && e.message ? ' ' + e.message : '')), { type: 'bad', icon: '💾', sfx: 'error' });
    const expBtn = VC.ui.button('Export file', () => U.async(() => VC.save.exportFile(), (ok, v, e) => {
      if (e) fail('Export failed.', e);
    }), { icon: '⬇️', cls: 'small', tip: 'Download the current city as a file you can back up or share' });
    // importing replaces the running city, like Load: confirm first (the file picker opens from the dialog's button)
    const impBtn = VC.ui.button('Import file', () => VC.ui.confirm('Import a city file?<br>It replaces the current city — unsaved progress will be lost.', () => U.async(() => VC.save.importFile(), (ok, v, e) => {
      if (e) fail('Import failed.', e);
      refresh();
    }), { title: '📥 Import city', yes: 'Choose file…' }), { icon: '⬆️', cls: 'small', tip: 'Load a city from a previously exported file' });
    const autoNote = h('span', { class: 'pn-muted-note' });
    p.body.appendChild(h('div', { class: 'pn-save-foot' }, expBtn, impBtn, h('span', { class: 'pn-grow' }), autoNote));
    // where saves live (checked once per opening: storageInfo reads every slot's size)
    let mode = 'local';
    try { mode = (has('storageInfo') && VC.save.storageInfo().mode) || 'local'; } catch (e) { mode = 'local'; }
    const local = typeof location !== 'undefined' && location.protocol === 'file:';
    const where = mode === 'memory'
      ? '⚠️ This browser is blocking storage, so saves only last until you close the tab. Use <b>Export file</b> to keep your city.'
      : '💡 Saves live in this browser' + (local ? ', for this copy of Voxelpolis.html — keep the file in one place' : '') + '. Private windows and clearing site data erase them: use <b>Export file</b> for backups or to move a city to another computer.';
    const whereEl = h('div', { class: 'pn-banner t-' + (mode === 'memory' ? 'warn' : 'info') + ' pn-save-where' }, h('span', { html: where, style: { fontWeight: '550', lineHeight: '1.45' } }));
    p.body.appendChild(whereEl);

    function setBusy(b) {
      busy = b;
      U.cls(p.body, 'pn-busy', b);
      for (const btn of p.body.querySelectorAll('button')) if (!btn.classList.contains('win-close')) btn.disabled = b;
    }
    /** Runs a save-module call (sync or async) with busy state + toasts, then refreshes the list. */
    function run(fn, okText, failText, refreshAfter, after) {
      if (busy) return;
      setBusy(true);
      U.async(fn, (ok, v, e) => {
        setBusy(false);
        if (ok && okText) VC.ui.toast(okText, { type: 'good', icon: '💾', sfx: 'success' });
        if (!ok && failText) fail(failText, e);
        if (ok && after) after(v);
        if (refreshAfter !== false) refresh();
      });
    }
    function doSave(name) {
      name = String(name || '').trim() || S.name || 'My City';
      if (!has('save')) return fail('Saving is not available.');
      // only a manual save in the very slot this writes to gets replaced (autosaves have their own slots)
      const exists = slots.some((s) => !s.auto && String(s.slot) === name);
      const go = () => run(() => VC.save.save(name), `City saved as <b>${U.esc(name)}</b>.`, 'Save failed — storage may be full or unavailable.');
      if (exists) VC.ui.confirm(`Overwrite the save <b>${U.esc(name)}</b>?`, go, { title: '💾 Overwrite save', yes: 'Overwrite' });
      else go();
    }
    function refresh() {
      if (!has('list')) {
        loaded = true;
        err = 'unavailable';
        render();
        return;
      }
      lastList = performance.now();
      U.async(() => VC.save.list(), (ok, v) => {
        loaded = true;
        err = ok ? null : 'failed';
        slots = (Array.isArray(v) ? v : []).map(norm).filter(Boolean);
        // newest first when timestamps exist
        slots.sort((a, b) => (+new Date(b.saved || 0) || 0) - (+new Date(a.saved || 0) || 0));
        render();
      });
    }
    const slotEl = (s) => {
      const thumb = h('div', { class: 'pn-slot-thumb' });
      const name = h('div', { class: 'pn-slot-name' });
      const meta = h('div', { class: 'pn-slot-meta' });
      const when = h('div', { class: 'pn-slot-when' });
      const load = VC.ui.button('Load', () => {
        const x = el._s;
        VC.ui.confirm(`Load <b>${U.esc(x.name)}</b>?<br>Unsaved progress in the current city will be lost.`, () => run(() => VC.save.load(x.slot), `Loaded <b>${U.esc(x.name)}</b>.`, 'Could not load this save.', false, () => P.close('save')), { title: '📂 Load city', yes: 'Load' });
      }, { icon: '📂', cls: 'small primary' });
      const over = VC.ui.button('', () => {
        const x = el._s;
        VC.ui.confirm(`Overwrite <b>${U.esc(x.name)}</b> with the current city?`, () => run(() => VC.save.save(x.slot), 'Save overwritten.', 'Save failed.'), { title: '💾 Overwrite save', yes: 'Overwrite' });
      }, { icon: '💾', cls: 'small', tip: 'Overwrite with the current city' });
      const del = VC.ui.button('', () => {
        const x = el._s;
        VC.ui.confirm(`Delete <b>${U.esc(x.name)}</b> permanently?`, () => run(() => VC.save.remove(x.slot), 'Save deleted.', 'Could not delete this save.'), { title: '🗑️ Delete save', yes: 'Delete' });
      }, { icon: '🗑️', cls: 'small danger', tip: 'Delete this save' });
      const el = h('div', { class: 'pn-slot' }, thumb, h('div', { class: 'pn-slot-info' }, name, meta, when), h('div', { class: 'pn-slot-btns' }, load, over, del));
      el.set = (x) => {
        el._s = x;
        if (thumb._src !== x.thumb) {
          thumb._src = x.thumb;
          thumb.innerHTML = '';
          if (x.thumb) thumb.appendChild(h('img', { src: x.thumb, alt: '' }));
          else thumb.appendChild(h('span', null, '🏙️'));
        }
        U.txt(name, x.name);
        if (x.auto && !name.querySelector('.pn-pill')) name.appendChild(U.pill('Autosave', 'info'));
        const bits = [];
        if (x.pop != null) bits.push('👥 ' + U.int(x.pop));
        if (x.money != null) bits.push('💰 ' + U.money(x.money));
        if (x.day != null) bits.push('📅 ' + VC.fmt.date(x.day));
        U.txt(meta, bits.join('  ·  ') || (x.label ? 'Slot: ' + x.label : ''));
        U.txt(when, (x.saved ? 'Saved ' + ago(x.saved) : '') + (x.size ? (x.saved ? ' · ' : '') + x.size + '×' + x.size + ' map' : ''));
        over.disabled = load.disabled = del.disabled = busy;
      };
      return el;
    };
    function render() {
      U.show(loading, !loaded);
      U.keyed(list, slots, (s) => String(s.slot), slotEl, (el, s) => el.set(s));
      U.show(empty, loaded && !slots.length);
      U.txt(countEl, slots.length ? slots.length + ' save' + (slots.length === 1 ? '' : 's') : err === 'unavailable' ? 'save system unavailable' : '');
      saveBtn.disabled = busy || !has('save');
      U.txt(autoNote, VC.settings && VC.settings.autosave === false ? '⏸️ Autosave is off (Settings)' : '🔄 Autosave keeps a rolling backup');
      expBtn.disabled = busy || !has('exportFile');
      impBtn.disabled = busy || !has('importFile');
    }
    render();
    refresh();
    return () => {
      // pick up autosaves while the window stays open
      if (!busy && performance.now() - lastList > 5000) refresh();
      else render();
    };
  },
};
