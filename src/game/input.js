/*
 * VOXELPOLIS — input (VC.input): mouse / touch / keyboard -> camera + tools. Contract: docs/ARCHITECTURE.md §VC.input.
 *
 * POINTER (canvas only; the #ui overlay swallows events over windows, so canvas events are game events):
 *   left        tool action (VC.tools.down/move/up); with the select tool: click = inspect, drag = pan
 *   right-drag  orbit (yaw + pitch); right-click without dragging = cancel drag / back to select tool
 *   middle-drag pan;  wheel = zoom toward the cursor (VC.settings.invertZoom); Ctrl/Shift/Alt+wheel = brush size
 *   double-click focus the camera on a building (or the ground) with the select tool
 *   edge scroll when VC.settings.edgeScroll
 *   touch       1 finger = tool (or pan with the select tool, tap = inspect); 2 fingers = pinch zoom + twist
 *               rotate + pan (any tool drag is cancelled)
 * KEYBOARD (central; ignored while typing in INPUT/TEXTAREA/SELECT, behind menus and modals): see KEYMAP.
 *   Continuous camera moves use real dt: pan speed ∝ zoom distance (Shift = faster).
 * API: KEYMAP [{group, keys, action}] (help window), keys Set of held codes, mouse {x, y (client px), buttons,
 *   over}, mods {shift, ctrl, alt}, enabled(), PANEL_KEYS {code: panelKey}.
 */
const M = VC.M;

/** Panel hotkeys (fallback when VC.panels.list has no hotkey info). */
const PANEL_KEYS = { KeyM: 'budget', KeyP: 'policies', KeyG: 'stats', KeyU: 'population', KeyV: 'services', KeyY: 'utilities', KeyN: 'advisors', KeyJ: 'milestones', KeyX: 'disasters', KeyK: 'save' };
const HOLD = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'PageUp', 'PageDown']);
const DRAG_PX = 5; // movement before a press becomes a drag
const EDGE_PX = 14;

let cv = null;
let ptr = null; // active mouse/pen press: {id, button, sx, sy, x, y, mode, moved}
const touches = new Map(); // pointerId -> {x, y, sx, sy}
let tmode = null; // touch mode: 'tool' | 'panOrTap' | 'pan' | 'gesture' | 'wait'
let gest = null; // two-finger gesture state
let lastWheel = 0;

function isTyping(e) {
  const t = e && e.target;
  return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
}
function local(e) {
  const r = cv.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
function tools() {
  return VC.tools;
}
function cam() {
  return VC.camera;
}
function setMods(e) {
  I.mods.shift = !!e.shiftKey;
  I.mods.ctrl = !!(e.ctrlKey || e.metaKey);
  I.mods.alt = !!e.altKey;
}
function capture(id) {
  try { cv.setPointerCapture(id); } catch (e) { /* synthetic or already released */ }
}
function release(id) {
  try { if (cv.hasPointerCapture && cv.hasPointerCapture(id)) cv.releasePointerCapture(id); } catch (e) { /* ignore */ }
}
function toast(text, icon) {
  VC.bus.emit('toast', { text, type: 'info', icon });
}

const I = (VC.input = {
  keys: new Set(),
  mouse: { x: 0, y: 0, buttons: 0, over: false },
  mods: { shift: false, ctrl: false, alt: false },
  PANEL_KEYS,
  KEYMAP: [
    { group: 'Camera', keys: 'W A S D / Arrows', action: 'Pan the camera (hold Shift = faster)' },
    { group: 'Camera', keys: 'Right-drag', action: 'Rotate and tilt' },
    { group: 'Camera', keys: 'Middle-drag', action: 'Pan (drag the ground)' },
    { group: 'Camera', keys: 'Left-drag', action: 'Pan with the Inspect tool' },
    { group: 'Camera', keys: 'Wheel / + / −', action: 'Zoom toward the cursor' },
    { group: 'Camera', keys: 'Q / E', action: 'Rotate left / right' },
    { group: 'Camera', keys: 'PgUp / PgDn', action: 'Tilt the camera' },
    { group: 'Camera', keys: 'Double-click', action: 'Focus on a building' },
    { group: 'Camera', keys: 'C', action: 'Cinematic camera' },
    { group: 'Building', keys: '1 … 0', action: 'Open tool groups' },
    { group: 'Building', keys: 'T', action: 'Terraform tools' },
    { group: 'Building', keys: 'B', action: 'Bulldozer' },
    { group: 'Building', keys: 'Left-drag', action: 'Build roads, zones, power lines' },
    { group: 'Building', keys: 'Shift + drag', action: 'Straight road / power line' },
    { group: 'Building', keys: 'R', action: 'Rotate building (Shift+R: back)' },
    { group: 'Building', keys: 'Ctrl + Wheel', action: 'Brush size (terrain, trees)' },
    { group: 'Building', keys: 'Right-click / Esc', action: 'Cancel / back to Inspect' },
    { group: 'Building', keys: 'Ctrl + Z', action: 'Undo last action (' + ((VC.actions && VC.actions.UNDO_SEC) || 10) + ' s)' },
    { group: 'Building', keys: 'L', action: 'Toggle build grid' },
    { group: 'Building', keys: 'Delete', action: 'Demolish the selected building' },
    { group: 'Game', keys: 'Space', action: 'Pause / resume' },
    { group: 'Game', keys: ', / .', action: 'Slower / faster (also [ / ])' },
    { group: 'Game', keys: 'O', action: 'Cycle map overlays (Shift+O: back)' },
    { group: 'Game', keys: 'H', action: 'Hide interface (photo mode)' },
    { group: 'Game', keys: 'F1', action: 'Help' },
    { group: 'Game', keys: 'Ctrl + S', action: 'Quick save' },
    { group: 'Game', keys: 'Esc', action: 'Close window / pause menu' },
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
  ],

  /** Game input is live (a city is running and no title menu is up). */
  enabled() {
    const S = VC.state;
    return !!(S && VC.running && !S.demo && !(VC.menu && VC.menu.active));
  },

  init() {
    cv = VC.gfx.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    cv.addEventListener('lostpointercapture', (e) => { if (ptr && ptr.id === e.pointerId && ptr.captured) endPress(e, false); });
    cv.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      I.mouse.over = false;
      if (!ptr && tools()) tools().pointer(I.mouse.x, I.mouse.y, false);
    });
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('dblclick', onDblClick);
    // middle-click autoscroll off
    cv.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    // pointer left the browser window (edge scrolling must stop)
    window.addEventListener('mouseout', (e) => { if (!e.relatedTarget) I.mouse.inside = false; });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', (e) => {
      I.keys.delete(e.code);
      setMods(e);
    });
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', () => { if (document.hidden) onBlur(); });
  },

  reset() {
    I.keys.clear();
    ptr = null;
    touches.clear();
    tmode = null;
    gest = null;
  },

  update(dt, rdt) {
    const c = cam();
    if (!c || !I.enabled()) return;
    const k = I.keys;
    if (k.size) {
      const fast = k.has('ShiftLeft') || k.has('ShiftRight') || I.mods.shift ? 2.6 : 1;
      const sp = c.goal.dist * 0.9 * rdt * fast;
      let f = 0, r = 0;
      if (k.has('KeyW') || k.has('ArrowUp')) f += sp;
      if (k.has('KeyS') || k.has('ArrowDown')) f -= sp;
      if (k.has('KeyA') || k.has('ArrowLeft')) r -= sp;
      if (k.has('KeyD') || k.has('ArrowRight')) r += sp;
      if (f || r) c.panLocal(f, r);
      if (k.has('KeyQ')) c.orbit(1.6 * rdt * fast, 0);
      if (k.has('KeyE')) c.orbit(-1.6 * rdt * fast, 0);
      if (k.has('PageUp')) c.orbit(0, 0.9 * rdt);
      if (k.has('PageDown')) c.orbit(0, -0.9 * rdt);
      if (k.has('Equal') || k.has('NumpadAdd')) c.zoom(Math.exp(-1.8 * rdt * fast));
      if (k.has('Minus') || k.has('NumpadSubtract')) c.zoom(Math.exp(1.8 * rdt * fast));
    }
    // edge scrolling (mouse only, never while dragging)
    const st = VC.settings || {};
    if (st.edgeScroll && !ptr && !touches.size && I.mouse.inside !== false && document.hasFocus()) {
      const vw = window.innerWidth, vh = window.innerHeight, mx = I.mouse.x, my = I.mouse.y;
      const sp = c.goal.dist * 0.8 * rdt;
      let f = 0, r = 0;
      if (mx <= EDGE_PX) r -= sp * (1 - mx / EDGE_PX * 0.5);
      else if (mx >= vw - 1 - EDGE_PX) r += sp;
      if (my <= EDGE_PX) f += sp;
      else if (my >= vh - 1 - EDGE_PX) f -= sp;
      if (f || r) c.panLocal(f, r);
    }
  },
});

/* ------------------------------------------------------------------ */
/* Mouse / pen                                                          */
/* ------------------------------------------------------------------ */
function onDown(e) {
  if (e.pointerType === 'touch') return touchDown(e);
  setMods(e);
  const [px, py] = local(e);
  I.mouse.x = e.clientX;
  I.mouse.y = e.clientY;
  I.mouse.buttons = e.buttons;
  I.mouse.over = true;
  if (document.activeElement && document.activeElement !== cv && document.activeElement.blur) document.activeElement.blur();
  try { cv.focus({ preventScroll: true }); } catch (err) { /* old browsers */ }
  if (!I.enabled()) return;
  const T = tools();
  if (ptr) {
    // a second button while dragging: cancel the tool drag / stop the camera gesture
    if (ptr.mode === 'tool' && T) T.cancelDrag();
    release(ptr.id);
    ptr = null;
    return;
  }
  ptr = { id: e.pointerId, button: e.button, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, mode: '', moved: false, captured: false };
  if (e.button === 0) {
    if (!T || T.kind === 'select') ptr.mode = 'panOrClick';
    else {
      ptr.mode = 'tool';
      if (T) T.pointer(px, py, true);
      if (!T.down(px, py)) ptr.mode = 'panOrClick';
    }
  } else if (e.button === 1) {
    ptr.mode = 'pan';
    e.preventDefault();
  } else if (e.button === 2) {
    ptr.mode = 'orbitOrCancel';
  } else {
    ptr = null;
    return;
  }
  capture(e.pointerId);
  ptr.captured = true;
}

function onMove(e) {
  if (e.pointerType === 'touch') return touchMove(e);
  setMods(e);
  I.mouse.x = e.clientX;
  I.mouse.y = e.clientY;
  I.mouse.buttons = e.buttons;
  I.mouse.inside = true;
  if (!cv) return;
  const over = e.target === cv;
  const [px, py] = local(e);
  const T = tools();
  if (!ptr) {
    I.mouse.over = over;
    if (T) T.pointer(px, py, over && I.enabled());
    return;
  }
  if (e.pointerId !== ptr.id) return;
  const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
  ptr.x = e.clientX;
  ptr.y = e.clientY;
  if (!ptr.moved && Math.hypot(e.clientX - ptr.sx, e.clientY - ptr.sy) > DRAG_PX) ptr.moved = true;
  const c = cam();
  switch (ptr.mode) {
    case 'panOrClick':
      if (T) T.pointer(px, py, true);
      if (ptr.moved) {
        ptr.mode = 'pan';
        c.pan(e.clientX - ptr.sx, e.clientY - ptr.sy); // include the dead-zone movement
      }
      break;
    case 'pan':
      c.pan(dx, dy);
      if (T) T.pointer(px, py, over);
      break;
    case 'orbitOrCancel':
      if (ptr.moved) {
        ptr.mode = 'orbit';
        c.orbit(-(e.clientX - ptr.sx) * 0.006, (e.clientY - ptr.sy) * 0.004);
      }
      break;
    case 'orbit':
      c.orbit(-dx * 0.006, dy * 0.004);
      break;
    case 'tool':
      if (T) T.move(px, py);
      break;
  }
}

function onUp(e) {
  if (e.pointerType === 'touch') return touchUp(e, true);
  setMods(e);
  I.mouse.buttons = e.buttons;
  if (!ptr || e.pointerId !== ptr.id || e.button !== ptr.button) return;
  endPress(e, true);
}
/** Finishes the active mouse press. commit=false (capture lost / cancel) aborts tool drags. */
function endPress(e, commit) {
  const p = ptr;
  if (!p) return;
  ptr = null;
  release(p.id);
  const T = tools();
  if (!T || !I.enabled()) return;
  const [px, py] = local(e);
  try {
    if (p.mode === 'tool') {
      if (commit) T.up(px, py);
      else T.cancelDrag();
    } else if (p.mode === 'panOrClick' && commit) {
      T.click(px, py);
    } else if (p.mode === 'orbitOrCancel' && commit) {
      T.cancel();
    }
  } finally {
    T.pointer(px, py, e.target === cv || (px >= 0 && py >= 0 && px < cv.clientWidth && py < cv.clientHeight && document.elementFromPoint && document.elementFromPoint(e.clientX, e.clientY) === cv));
  }
}
function onCancel(e) {
  if (e.pointerType === 'touch') return touchUp(e, false);
  if (ptr && ptr.id === e.pointerId) endPress(e, false);
}
function onBlur() {
  I.keys.clear();
  I.mods.shift = I.mods.ctrl = I.mods.alt = false;
  const T = tools();
  if (ptr) {
    if (ptr.mode === 'tool' && T) T.cancelDrag();
    release(ptr.id);
    ptr = null;
  }
  if (touches.size) {
    if (tmode === 'tool' && T) T.cancelDrag();
    touches.clear();
    tmode = null;
    gest = null;
  }
}

function onWheel(e) {
  e.preventDefault();
  if (!I.enabled()) return;
  const T = tools();
  let d = e.deltaY || e.deltaX; // Shift+wheel scrolls horizontally in some browsers
  if (e.deltaMode === 1) d *= 33;
  else if (e.deltaMode === 2) d *= 400;
  if ((e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) && T && T.isBrush && T.isBrush()) {
    const now = performance.now();
    if (now - lastWheel > 90 && d) {
      lastWheel = now;
      T.adjustBrush(d < 0 ? 1 : -1);
    }
    return;
  }
  if (!e.deltaY) return;
  d = M.clamp(e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1), -300, 300);
  if (VC.settings && VC.settings.invertZoom) d = -d;
  const [px, py] = local(e);
  cam().zoom(Math.exp(d * 0.0016), px, py);
}

function onDblClick(e) {
  if (!I.enabled()) return;
  const T = tools();
  if (T && T.kind !== 'select') return;
  const [px, py] = local(e);
  const hit = cam().raycast(px, py);
  if (!hit || hit.offMap) return;
  const b = hit.building;
  if (b) {
    const c = VC.world.center(b);
    cam().focus(c[0], c[2], M.clamp(Math.max(b.w, b.d) * 4 + (b.hgt || 1) * 1.2 + 8, 10, 40));
  } else {
    cam().focus(hit.wx, hit.wz, Math.min(cam().goal.dist, 40));
  }
  VC.bus.emit('sfx', { name: 'click', vol: 0.4 });
}

/* ------------------------------------------------------------------ */
/* Touch                                                                */
/* ------------------------------------------------------------------ */
function touchDown(e) {
  if (!I.enabled()) return;
  e.preventDefault();
  capture(e.pointerId);
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
  const T = tools();
  const [px, py] = local(e);
  if (touches.size === 1) {
    I.mouse.x = e.clientX;
    I.mouse.y = e.clientY;
    if (T && T.kind !== 'select') {
      T.pointer(px, py, true);
      tmode = T.down(px, py) ? 'tool' : 'panOrTap';
    } else tmode = 'panOrTap';
  } else if (touches.size === 2) {
    if (tmode === 'tool' && T) T.cancelDrag();
    tmode = 'gesture';
    gest = gestureState();
  }
}
function touchMove(e) {
  const t = touches.get(e.pointerId);
  if (!t) return;
  const dx = e.clientX - t.x, dy = e.clientY - t.y;
  t.x = e.clientX;
  t.y = e.clientY;
  const T = tools(), c = cam();
  const [px, py] = local(e);
  if (tmode === 'gesture' && touches.size >= 2) {
    const g = gestureState();
    if (gest && g.dist > 1 && gest.dist > 1) {
      const r = cv.getBoundingClientRect();
      c.zoom(gest.dist / g.dist, g.mx - r.left, g.my - r.top);
      let da = g.ang - gest.ang;
      if (da > Math.PI) da -= M.PI2;
      if (da < -Math.PI) da += M.PI2;
      c.orbit(-da, 0);
      c.pan(g.mx - gest.mx, g.my - gest.my);
    }
    gest = g;
    return;
  }
  if (touches.size !== 1) return;
  I.mouse.x = e.clientX;
  I.mouse.y = e.clientY;
  if (tmode === 'panOrTap' && Math.hypot(e.clientX - t.sx, e.clientY - t.sy) > DRAG_PX * 2) {
    tmode = 'pan';
    c.pan(e.clientX - t.sx - dx, e.clientY - t.sy - dy);
  }
  if (tmode === 'pan') c.pan(dx, dy);
  else if (tmode === 'tool' && T) T.move(px, py);
}
function touchUp(e, commit) {
  const t = touches.get(e.pointerId);
  if (!t) return;
  touches.delete(e.pointerId);
  release(e.pointerId);
  const T = tools();
  const [px, py] = local(e);
  if (tmode === 'gesture') {
    // wait until every finger is lifted before the next gesture/tool action
    tmode = touches.size ? 'wait' : null;
    gest = null;
    return;
  }
  if (touches.size) return;
  const mode = tmode;
  tmode = null;
  if (!T || !I.enabled()) return;
  if (mode === 'tool') {
    if (commit) T.up(px, py);
    else T.cancelDrag();
  } else if (mode === 'panOrTap' && commit) T.click(px, py);
  T.pointer(px, py, false); // no hover without a finger on the screen
}
function gestureState() {
  const it = touches.values();
  const a = it.next().value, b = it.next().value;
  return { dist: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                             */
/* ------------------------------------------------------------------ */
function panelKey(code) {
  const P = VC.panels;
  if (P && Array.isArray(P.list)) {
    const it = P.list.find((l) => l && l.hotkey === code);
    if (it) return it.key;
  }
  return PANEL_KEYS[code] || null;
}

function onKeyDown(e) {
  setMods(e);
  if (isTyping(e)) return;
  if (!I.enabled()) return;
  if (VC.ui && VC.ui.modalCount && VC.ui.modalCount() > 0) return;
  const code = e.code;
  const T = tools();
  const ctrl = e.ctrlKey || e.metaKey;
  // ---- Ctrl / Cmd shortcuts ----
  if (ctrl) {
    if (code === 'KeyS') {
      e.preventDefault();
      if (!e.repeat && VC.save && VC.save.save) {
        try { VC.save.save('quick'); } catch (err) { console.error('[input] quick save failed', err); }
      }
    } else if (code === 'KeyZ' && !e.shiftKey) {
      e.preventDefault();
      if (!e.repeat) undo();
    }
    return;
  }
  if (e.altKey) return;
  if (HOLD.has(code)) {
    I.keys.add(code);
    if (code.startsWith('Arrow') || code.startsWith('Page')) e.preventDefault();
    return;
  }
  if (e.repeat && code !== 'KeyR') return;
  // ---- tool groups: Digit1..Digit0, T, B ----
  const grp = VC.TOOL_GROUPS.find((g) => g.hotkey && (code === 'Digit' + g.hotkey || code === 'Numpad' + g.hotkey || code === 'Key' + g.hotkey));
  if (grp) {
    e.preventDefault();
    if (grp.key === 'bulldoze' && T) {
      // the HUD toggles the bulldozer when it handles the group; do it ourselves if nobody did
      const before = T.current;
      VC.bus.emit('toolGroup', { key: grp.key });
      if (T.current === before) T.select(before === 'bulldoze' ? 'select' : 'bulldoze');
    } else VC.bus.emit('toolGroup', { key: grp.key });
    return;
  }
  const pk = panelKey(code);
  if (pk) {
    if (VC.panels && VC.panels.toggle) VC.panels.toggle(pk); // synchronous: panels de-duplicate their own fallback
    return;
  }
  switch (code) {
    case 'Escape':
      escape();
      break;
    case 'Space': {
      e.preventDefault();
      const ae = document.activeElement;
      if (ae && ae !== cv && ae.blur && ae.tagName === 'BUTTON') ae.blur(); // no double action on a focused button
      VC.togglePause();
      break;
    }
    case 'Comma':
    case 'BracketLeft':
      VC.setSpeed(Math.max(0, VC.speed() - 1));
      break;
    case 'Period':
    case 'BracketRight':
      VC.setSpeed(Math.min(VC.C.SPEEDS.length - 1, VC.speed() + 1));
      break;
    case 'KeyR':
      if (T) T.rotate(e.shiftKey ? -1 : 1);
      break;
    case 'KeyH':
      if (VC.hud && VC.hud.toggleUI) VC.hud.toggleUI();
      break;
    case 'KeyC': {
      const c = cam();
      c.cinematic = !c.cinematic;
      toast(c.cinematic ? 'Cinematic camera <b>on</b> — press C to stop' : 'Cinematic camera <b>off</b>', '🎬');
      break;
    }
    case 'KeyO':
      cycleOverlay(e.shiftKey ? -1 : 1);
      break;
    case 'KeyL': {
      const st = VC.settings;
      st.showGrid = st.showGrid === false;
      if (VC.saveSettings) VC.saveSettings();
      toast('Build grid <b>' + (st.showGrid ? 'on' : 'off') + '</b>', '📐');
      break;
    }
    case 'F1':
      e.preventDefault();
      if (VC.hud && VC.hud.openHelp) VC.hud.openHelp();
      break;
    case 'Delete':
      // Delete: bulldoze the selected building (with the usual confirmation for landmarks)
      if (T && T.selectedId && T.demolish && VC.state.buildings.has(T.selectedId)) T.demolish(VC.state.buildings.get(T.selectedId));
      break;
  }
}

/** Esc: cancel drag -> select tool -> close top window -> pause menu. */
function escape() {
  const T = tools();
  if (T && T.cancel && T.cancel()) return;
  if (VC.ui && VC.ui.closeTop && VC.ui.closeTop()) return;
  if (VC.menu && VC.menu.pause) VC.menu.pause();
}

function cycleOverlay(dir) {
  const G = VC.gfx, list = VC.OVERLAYS;
  if (!G || !G.setOverlay) return;
  const i = Math.max(0, list.findIndex((o) => o.key === G.overlay));
  const o = list[(i + dir + list.length) % list.length];
  G.setOverlay(o.key);
  toast(o.icon + ' ' + o.name, null);
}

function undo() {
  const A = VC.actions;
  if (!A || !A.undo) return;
  const r = A.undo();
  if (r.ok) VC.bus.emit('toast', { text: 'Undone: <b>' + r.label + '</b>' + (r.refund > 0 ? ' — refunded ' + VC.fmt.money(r.refund) : ''), type: 'info', icon: '↩️' });
  else {
    VC.bus.emit('sfx', { name: 'error' });
    VC.bus.emit('toast', { text: r.reason, type: 'warn', icon: '↩️' });
  }
}
