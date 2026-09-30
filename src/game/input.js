/*
 * VOXELPOLIS — input (VC.input): mouse / touch / keyboard -> camera + tools. Contract: docs/ARCHITECTURE.md §VC.input.
 *
 * POINTER (canvas only; the #ui overlay swallows events over windows, so canvas events are game events):
 *   left        tool action (VC.tools.down/move/up); with the select tool: click = inspect, drag = pan
 *   right-drag  orbit (yaw + pitch); right-click without dragging = cancel drag / back to select tool
 *   middle-drag pan;  wheel = zoom toward the cursor (VC.settings.invertZoom); Ctrl/Cmd/Shift/Alt+wheel = brush
 *               size (only with a REAL modifier key held: a trackpad pinch arrives as ctrl+wheel and always zooms)
 *   double-click focus the camera on a building (or the ground) with the select tool
 *   edge scroll when VC.settings.edgeScroll
 *   touch       1 finger = tool (or pan with the select tool, tap = inspect); 2 fingers = pinch zoom + twist
 *               rotate + pan (any tool drag is cancelled)
 *   trackpad    pinch = zoom (Chrome/Firefox: ctrl+wheel; Safari: gesturestart/change/end, also twist = rotate);
 *               the page itself never zooms (ctrl+wheel and Safari gestures are prevented over the whole UI)
 *   Mac         Ctrl-click = right-click (cancel / orbit drag); Cmd works for every Ctrl shortcut
 * KEYBOARD LAYOUTS: positional keys use e.code (WASD / arrows / Q E / PgUp PgDn camera cluster); mnemonic
 *   letters (managers M P G U V Y N J X K, tools T B, R H C O L), symbols (+ − , . [ ] ?) and Ctrl/Cmd shortcuts
 *   use the CHARACTER (e.key), so AZERTY / QWERTZ / Dvorak players press the key labelled with the letter;
 *   e.code is the fallback when e.key is not a Latin letter (Cyrillic, Greek…). Digits: the character when it
 *   is a digit (AZERTY Shift+digit, numpad), else the physical digit-row key (AZERTY & é " ' ( - è _ ç à, Czech
 *   + ě š …: the row keeps its 1 … 0 meaning; AZERTY zooms with = / + and the numpad). A printable character
 *   with no meaning here does nothing (never its US-position code: AZERTY ')' or QWERTZ 'ß' do not zoom).
 *   Backspace = Delete (Mac 'delete' key); '?' = help (F1 is brightness on Macs). AltGr characters count
 *   ([ ] on many layouts), AltGr is never Ctrl. A remapped key blocks the positional fallbacks of other
 *   modules (preventDefault).
 * KEYBOARD (central; behind menus and modals): see KEYMAP. Ignored only while TYPING — focus in a text-like
 *   field (text/search/number/email/password/… inputs, textarea, select, contenteditable). Sliders, checkboxes,
 *   radios and buttons keep focus after a click but never swallow hotkeys (a focused slider keeps only its own
 *   arrow / Home / End / PgUp / PgDn keys; Space never also "clicks" a focused control).
 *   Interface hidden (H / photo mode, VC.hud.isVisible() false): only camera keys, H, Esc, C, O, Space, speed keys
 *   and Ctrl+S work — no invisible windows, palettes or edits.
 *   Continuous camera moves use real dt: pan speed ∝ zoom distance (Shift = faster).
 * FEEDBACK: toggles (cinematic, grid, overlay, undo) show ONE toast via VC.ui.toast directly (a bus 'toast' would
 *   add the audio module's notify sound); overlay cycling reuses a single toast that updates in place.
 * API: KEYMAP [{group, keys, action}] (help window; keys: alternatives separated by ', ', chords by ' + ', so a
 *   bare '+' / '−' is a key of its own; '⌘' instead of 'Ctrl' on Macs), keys Set of held (logical) codes,
 *   mouse {x, y (client px), buttons, over}, mods {shift, ctrl, alt}, enabled(), PANEL_KEYS {code: panelKey},
 *   isTyping(e), IS_MAC, MOD ('⌘' | 'Ctrl'), logicalKey(e) -> the layout-aware key code this module acts on,
 *   zoomDir() -> 1 | -1 (VC.settings.invertZoom; multiply wheel deltas by it), wheelZoom(e) -> camera zoom factor
 *   for a wheel event (normalised delta, clamped, invert applied) — for other zoomable views such as the minimap.
 */
const M = VC.M;

/** Mac: ⌘ in key labels, Ctrl-click = right-click. */
const IS_MAC = (() => {
  try {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    return /mac|iphone|ipad|ipod/i.test(p);
  } catch (e) {
    return false;
  }
})();
const MOD = IS_MAC ? '⌘' : 'Ctrl';

/** Panel hotkeys (fallback when VC.panels.list has no hotkey info). */
const PANEL_KEYS = { KeyM: 'budget', KeyP: 'policies', KeyG: 'stats', KeyU: 'population', KeyV: 'services', KeyY: 'utilities', KeyN: 'advisors', KeyJ: 'milestones', KeyX: 'disasters', KeyK: 'save' };
/** Continuous (held) keys by PHYSICAL position: the camera cluster. Zoom keys are resolved by character. */
const HOLD = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'PageUp', 'PageDown']);
const holdOf = new Map(); // held physical code -> its logical key (e.g. NumpadAdd / QWERTZ '+' -> 'Equal')
let ctrlHeld = false; // a real Ctrl / Cmd key is down (a trackpad pinch sends ctrl+wheel without it)
const DRAG_PX = 5; // movement before a press becomes a drag
const EDGE_PX = 14;

let cv = null;
let ptr = null; // active mouse/pen press: {id, button, sx, sy, x, y, mode, moved}
const touches = new Map(); // pointerId -> {x, y, sx, sy}
let tmode = null; // touch mode: 'tool' | 'panOrTap' | 'pan' | 'gesture' | 'wait'
let gest = null; // two-finger gesture state
let lastWheel = 0;

/** Input types that take no text: hotkeys pass through them. */
const NON_TEXT = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'color', 'file']);
/** True while the key goes into a text-like field (so it must not trigger hotkeys). */
function isTyping(e) {
  const t = e && e.target;
  if (!t || !t.tagName) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t.tagName === 'INPUT' && !NON_TEXT.has(String(t.type || 'text').toLowerCase());
}
/** Keys a focused slider handles itself. */
const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
/** Hotkeys that still work while the interface is hidden (camera, look & time; no windows, palettes or edits). */
const HIDDEN_OK = new Set(['Escape', 'KeyH', 'KeyC', 'KeyO', 'Space', 'SpeedDown', 'SpeedUp']);
/** Interface shown (false in H / photo mode). */
function uiVisible() {
  const H = VC.hud;
  if (!H) return true;
  if (typeof H.isVisible === 'function') return !!H.isVisible();
  return !(H.uiHidden || H.photo);
}
/** Normalised wheel delta in px (line / page modes scaled). */
function wheelPx(e, v) {
  return v * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
}
const zoomDir = () => (VC.settings && VC.settings.invertZoom ? -1 : 1);
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
/**
 * One info toast shown directly (no bus 'toast': audio would add its notify sound). reuse: a previous toast element
 * to update in place instead of stacking a new one. Returns the element (or null).
 */
function toast(text, icon, o = {}) {
  const U = VC.ui;
  if (!U || !U.toast || (VC.state && VC.state.demo)) return null;
  if (o.sfx) VC.bus.emit('sfx', { name: o.sfx, vol: 0.5 });
  const el = o.reuse;
  if (el && el.isConnected && !el.classList.contains('out')) {
    const tx = el.querySelector('.toast-text'), ic = el.querySelector('.toast-icon');
    if (tx && ic) {
      tx.innerHTML = text;
      ic.textContent = icon || '';
      return el;
    }
  }
  return U.toast(text, { type: o.type || 'info', icon, duration: o.duration });
}
/** Fades a toast out like VC.ui does (used for the self-managed overlay toast). */
function toastOut(el) {
  if (!el || !el.isConnected || el.classList.contains('out')) return;
  el.classList.add('out');
  setTimeout(() => el.remove(), 380);
}
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const I = (VC.input = {
  keys: new Set(),
  mouse: { x: 0, y: 0, buttons: 0, over: false },
  mods: { shift: false, ctrl: false, alt: false },
  PANEL_KEYS,
  // keys: alternatives separated by ', ', chords by ' + ' (a lone '+' or '−' is a key); see hud_settings keyChips
  KEYMAP: [
    { group: 'Camera', keys: 'W A S D, Arrows', action: 'Pan the camera (hold Shift = faster)' },
    { group: 'Camera', keys: 'Right-drag', action: 'Rotate and tilt' },
    { group: 'Camera', keys: 'Middle-drag', action: 'Pan (drag the ground)' },
    { group: 'Camera', keys: 'Left-drag', action: 'Pan with the Inspect tool' },
    { group: 'Camera', keys: 'Wheel, Pinch, +, −', action: 'Zoom toward the cursor' },
    { group: 'Camera', keys: 'Q, E', action: 'Rotate left / right' },
    { group: 'Camera', keys: 'PgUp, PgDn', action: 'Tilt the camera' },
    { group: 'Camera', keys: 'Double-click', action: 'Focus on a building' },
    { group: 'Camera', keys: 'C', action: 'Cinematic camera' },
    { group: 'Building', keys: '1 … 0', action: 'Open tool groups' },
    { group: 'Building', keys: 'T', action: 'Terraform tools' },
    { group: 'Building', keys: 'B', action: 'Bulldozer' },
    { group: 'Building', keys: 'Left-drag', action: 'Build roads, zones, power lines' },
    { group: 'Building', keys: 'Shift + Left-drag', action: 'Straight road / power line' },
    { group: 'Building', keys: 'R', action: 'Rotate building (Shift+R: back)' },
    { group: 'Building', keys: MOD + ' + Wheel, Shift + Wheel', action: 'Brush size (terrain, trees)' },
    { group: 'Building', keys: IS_MAC ? 'Right-click, Ctrl + Click, Esc' : 'Right-click, Esc', action: 'Cancel / back to Inspect' },
    { group: 'Building', keys: MOD + ' + Z', action: 'Undo last action (' + ((VC.actions && VC.actions.UNDO_SEC) || 10) + ' s)' },
    { group: 'Building', keys: 'L', action: 'Toggle build grid' },
    { group: 'Building', keys: IS_MAC ? 'Delete' : 'Delete, Backspace', action: 'Demolish the selected building' },
    { group: 'Game', keys: 'Space', action: 'Pause / resume' },
    { group: 'Game', keys: '[, ]', action: 'Slower / faster (the , and . keys work too)' },
    { group: 'Game', keys: 'O', action: 'Cycle map overlays (Shift+O: back)' },
    { group: 'Game', keys: 'H', action: 'Hide interface (photo mode)' },
    { group: 'Game', keys: IS_MAC ? '?' : 'F1, ?', action: 'Help' },
    { group: 'Game', keys: MOD + ' + S', action: 'Quick save' },
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

  isTyping,
  IS_MAC,
  MOD,
  logicalKey,
  /** +1, or -1 with VC.settings.invertZoom: multiply wheel deltas by it (minimap & co. zoom like the 3D view). */
  zoomDir,
  /**
   * Camera zoom factor (VC.camera.zoom(f)) for a wheel event: normalised delta, clamped, invert applied.
   * A trackpad pinch (ctrl+wheel without a real Ctrl key) sends small deltas: scaled up so it feels direct.
   */
  wheelZoom(e) {
    const pinch = isPinch(e);
    const d = (pinch ? M.clamp(wheelPx(e, e.deltaY || 0) * 6, -150, 150) : M.clamp(wheelPx(e, e.deltaY || 0), -300, 300)) * zoomDir();
    return Math.exp(d * 0.0016);
  },
  /** True for a trackpad pinch delivered as a wheel event (Chrome / Firefox / Edge: ctrlKey, no Ctrl held). */
  isPinch,

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
    // ctrl+wheel (mouse + Ctrl, or a trackpad pinch) never zooms the PAGE, wherever the pointer is (windows,
    // HUD): the canvas handler above zooms the camera, everything else just scrolls normally without Ctrl
    window.addEventListener('wheel', (e) => { if (e.ctrlKey && e.cancelable) e.preventDefault(); }, { passive: false });
    // Safari trackpad pinch / twist (WebKit GestureEvents): camera zoom + rotate instead of page magnification
    cv.addEventListener('gesturestart', onGestureStart);
    cv.addEventListener('gesturechange', onGestureChange);
    cv.addEventListener('gestureend', onGestureEnd);
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('gesturechange', (e) => e.preventDefault());
    cv.addEventListener('dblclick', onDblClick);
    // middle-click autoscroll off
    cv.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    // pointer left the browser window (edge scrolling must stop)
    window.addEventListener('mouseout', (e) => { if (!e.relatedTarget) I.mouse.inside = false; });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', (e) => {
      trackCtrl(e, false);
      releaseKey(e.code);
      setMods(e);
    });
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', () => { if (document.hidden) onBlur(); });
  },

  reset() {
    I.keys.clear();
    holdOf.clear();
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
      if (k.has('Equal')) c.zoom(Math.exp(-1.8 * rdt * fast)); // (logical: '=' '+' numpad + …)
      if (k.has('Minus')) c.zoom(Math.exp(1.8 * rdt * fast));
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
  // Mac convention: Ctrl-click is a secondary (right) click — cancel / orbit drag, never a tool action
  const btn = IS_MAC && e.button === 0 && e.ctrlKey && !e.metaKey ? 2 : e.button;
  if (btn === 0) {
    if (!T || T.kind === 'select') ptr.mode = 'panOrClick';
    else {
      ptr.mode = 'tool';
      if (T) T.pointer(px, py, true);
      if (!T.down(px, py)) ptr.mode = 'panOrClick';
    }
  } else if (btn === 1) {
    ptr.mode = 'pan';
    e.preventDefault();
  } else if (btn === 2) {
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
  holdOf.clear();
  ctrlHeld = false;
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

/** Remembers whether a real Ctrl / Cmd key is down (keydown / keyup of the key itself). */
function trackCtrl(e, down) {
  const c = e.code || '';
  if (c === 'ControlLeft' || c === 'ControlRight' || c === 'MetaLeft' || c === 'MetaRight' || e.key === 'Control' || e.key === 'Meta') ctrlHeld = down;
  else if (down && !(e.ctrlKey || e.metaKey)) ctrlHeld = false; // missed keyup (focus left the page)
}
/** A trackpad pinch delivered as a wheel event: ctrlKey set by the browser while no Ctrl key is held. */
function isPinch(e) {
  return !!(e && e.ctrlKey && !ctrlHeld && !e.metaKey);
}
function onWheel(e) {
  e.preventDefault();
  if (!I.enabled()) return;
  const T = tools();
  const d = wheelPx(e, e.deltaY || e.deltaX); // Shift+wheel scrolls horizontally in some browsers
  const pinch = isPinch(e);
  if (pinch && gActive) return; // Safari: the gesture events already zoom (never both)
  if (!pinch && (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) && T && T.isBrush && T.isBrush()) {
    const now = performance.now();
    if (now - lastWheel > 90 && d) {
      lastWheel = now;
      T.adjustBrush(d < 0 ? 1 : -1);
    }
    return;
  }
  if (!e.deltaY) return;
  const [px, py] = local(e);
  cam().zoom(I.wheelZoom(e), px, py);
}

/* Safari trackpad gestures (GestureEvent: scale / rotation since gesturestart). */
let gScale = 1, gRot = 0, gActive = false;
function onGestureStart(e) {
  e.preventDefault();
  gActive = true;
  gScale = e.scale || 1;
  gRot = e.rotation || 0;
}
function onGestureChange(e) {
  e.preventDefault();
  if (!I.enabled()) return;
  const s = e.scale || 1, r = e.rotation || 0;
  const c = cam();
  if (c && s > 0 && gScale > 0) {
    const [px, py] = e.clientX != null ? local(e) : [cv.clientWidth / 2, cv.clientHeight / 2];
    c.zoom(M.clamp(gScale / s, 0.5, 2), px, py);
    const dr = r - gRot;
    if (dr && Math.abs(dr) < 45) c.orbit(-dr * (Math.PI / 180), 0);
  }
  gScale = s;
  gRot = r;
}
function onGestureEnd(e) {
  e.preventDefault();
  gActive = false;
  gScale = 1;
  gRot = 0;
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

/* ---- layout-aware key resolution ---- */
/** The typed character, lower-cased ('' for named keys such as Escape / F1 / Shift). */
function keyChar(e) {
  const k = e.key;
  return k && k.length === 1 ? k.toLowerCase() : '';
}
/** True when the key typed Latin letter `l`, or (non-Latin layouts only) sits where the US layout has it. */
function isLetter(e, l) {
  const k = keyChar(e);
  if (k === l) return true;
  return !/^[a-z]$/.test(k) && e.code === 'Key' + l.toUpperCase();
}
const ZOOM_IN = new Set(['+', '=']), SPEED_DOWN = new Set([',', '[', '<']), SPEED_UP = new Set(['.', ']', '>']);
let LETTER_RE = /[a-z\u00C0-\u024F\u0370-\u04FF]/i;
try { LETTER_RE = new RegExp('\\p{L}', 'u'); } catch (e) { /* old engines: Latin / Greek / Cyrillic */ }
/**
 * The layout-aware key this module acts on, as a code-like name: 'KeyM' (letter by CHARACTER; e.code when the
 * character is not a Latin letter), 'Digit5', 'Equal' / 'Minus' (zoom by character), 'SpeedDown' / 'SpeedUp',
 * 'Help' ('?'), 'Delete' (also Backspace), 'Space', 'Escape', 'F1'…; the positional camera cluster keeps e.code.
 */
function logicalKey(e) {
  const code = e.code || '', k = keyChar(e);
  if (HOLD.has(code)) return code; // WASD / QE / arrows / PgUp PgDn: physical position on every layout
  if (code === 'NumpadAdd') return 'Equal';
  if (code === 'NumpadSubtract') return 'Minus';
  if (k) {
    if (/^[a-z]$/.test(k)) return 'Key' + k.toUpperCase();
    if (/^[0-9]$/.test(k)) return 'Digit' + k;
    // the digit row keeps its 1 … 0 meaning (AZERTY & é " ' ( - è _ ç à, Czech + ě š …) — except AltGr
    // characters typed there ([ ] on AZERTY / QWERTZ), which mean themselves
    if (/^Digit\d$/.test(code) && !(e.getModifierState && e.getModifierState('AltGraph'))) return code;
    if (/^Key[A-Z]$/.test(code) && LETTER_RE.test(k)) return code; // non-Latin letter (Cyrillic, Greek…): US position
    if (ZOOM_IN.has(k)) return 'Equal';
    if (k === '-' || (k === '_' && code === 'Minus')) return 'Minus';
    if (SPEED_DOWN.has(k)) return 'SpeedDown';
    if (SPEED_UP.has(k)) return 'SpeedUp';
    if (k === '?') return 'Help';
    if (k === ' ') return 'Space';
    return ''; // a character without a meaning here (not its US-position code: AZERTY ')' is not zoom)
  }
  // named keys and dead keys (e.key 'Dead', 'Unidentified'): by position where that is unambiguous
  if (/^Digit\d$/.test(code)) return code;
  if (/^Numpad\d$/.test(code)) return 'Digit' + code.slice(6);
  if (/^Key[A-Z]$/.test(code)) return code;
  if (code === 'Backspace' || e.key === 'Backspace') return 'Delete';
  if (code === 'Space') return 'Space';
  if (code === 'Equal' || code === 'Minus' || code === 'Comma' || code === 'Period' || /^Bracket/.test(code)) return ''; // dead keys there
  return code || e.key || '';
}
/** keyup: releases a held key; a logical key stays held while another physical key still maps to it. */
function releaseKey(code) {
  const L = holdOf.get(code);
  if (L === undefined) { I.keys.delete(code); return; }
  holdOf.delete(code);
  for (const v of holdOf.values()) if (v === L) return; // (e.g. '=' and numpad + both held)
  I.keys.delete(L);
}

function onKeyDown(e) {
  setMods(e);
  trackCtrl(e, true);
  if (isTyping(e)) return;
  if (!I.enabled()) return;
  if (VC.ui && VC.ui.modalCount && VC.ui.modalCount() > 0) return;
  const code = e.code || '';
  const tg = e.target;
  // a focused slider keeps its own keys (value steps); everything else is a hotkey
  if (tg && tg.tagName === 'INPUT' && tg.type === 'range' && SLIDER_KEYS.has(code)) return;
  const T = tools();
  // AltGr (Windows reports it as Ctrl+Alt) types characters such as [ ] on many layouts: not a shortcut
  const altGr = !!(e.getModifierState && e.getModifierState('AltGraph'));
  const ctrl = (e.ctrlKey || e.metaKey) && !altGr;
  const shown = uiVisible();
  // ---- Ctrl / Cmd shortcuts (by character: Ctrl+Z is the key labelled Z on AZERTY / QWERTZ too) ----
  if (ctrl) {
    if (isLetter(e, 's')) {
      e.preventDefault();
      if (!e.repeat && VC.save && VC.save.save) {
        try { VC.save.save('quick'); } catch (err) { console.error('[input] quick save failed', err); }
      }
    } else if (isLetter(e, 'z') && !e.shiftKey) {
      e.preventDefault();
      if (!e.repeat && shown) undo(); // no invisible edits in photo mode
    } else if (code === 'KeyS') e.preventDefault(); // (not S on this layout: keep the positional save fallback out)
    return;
  }
  if (e.altKey && !altGr) return;
  const L = logicalKey(e);
  // a remapped letter / digit key must not also trigger other modules' positional (e.code) fallbacks
  if (L !== code && /^(Key|Digit)/.test(code)) e.preventDefault();
  if (HOLD.has(L) || L === 'Equal' || L === 'Minus') {
    I.keys.add(L);
    holdOf.set(code || L, L);
    if (L.startsWith('Arrow') || L.startsWith('Page') || L === 'Equal' || L === 'Minus') e.preventDefault();
    return;
  }
  // interface hidden (H / photo mode): camera, time and look keys only — never invisible windows / palettes / edits
  if (!shown && !HIDDEN_OK.has(L)) {
    // consumed: later hotkey fallbacks (panels, HUD) must not open invisible windows either
    if (/^(Key|Digit|Numpad|F\d)/.test(L) || L === 'Delete' || L === 'Help') {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    return;
  }
  if (e.repeat && L !== 'KeyR') return;
  // ---- tool groups: 1..0 (digit row / numpad), T, B ----
  const grp = VC.TOOL_GROUPS.find((g) => g.hotkey && (L === 'Digit' + g.hotkey || L === 'Key' + g.hotkey));
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
  const pk = panelKey(L);
  if (pk) {
    e.preventDefault(); // (the panels module's own e.code fallback stays out of it)
    if (VC.panels && VC.panels.toggle) VC.panels.toggle(pk); // synchronous: panels de-duplicate their own fallback
    return;
  }
  switch (L) {
    case 'Escape':
      if (!shown) showUI();
      else escape();
      break;
    case 'Space': {
      e.preventDefault();
      // no double action: a focused button / checkbox / radio would also "click" on keyup
      const ae = document.activeElement;
      if (ae && ae !== cv && ae !== document.body && ae.blur && (ae.tagName === 'BUTTON' || ae.tagName === 'INPUT' || ae.getAttribute('role') === 'button')) ae.blur();
      VC.togglePause();
      break;
    }
    case 'SpeedDown':
      e.preventDefault();
      VC.setSpeed(Math.max(0, VC.speed() - 1));
      break;
    case 'SpeedUp':
      e.preventDefault();
      VC.setSpeed(Math.min(VC.C.SPEEDS.length - 1, VC.speed() + 1));
      break;
    case 'KeyR':
      if (T) T.rotate(e.shiftKey ? -1 : 1);
      break;
    case 'KeyH':
      if (!shown) showUI();
      else if (VC.hud && VC.hud.toggleUI) VC.hud.toggleUI(false);
      break;
    case 'KeyC': {
      const c = cam();
      c.cinematic = !c.cinematic;
      if (shown) toast(c.cinematic ? 'Cinematic camera <b>on</b> — press C to stop' : 'Cinematic camera <b>off</b>', '🎬', { sfx: 'click' });
      break;
    }
    case 'KeyO':
      cycleOverlay(e.shiftKey ? -1 : 1, shown);
      break;
    case 'KeyL': {
      const st = VC.settings;
      st.showGrid = st.showGrid === false;
      if (VC.saveSettings) VC.saveSettings();
      toast('Build grid <b>' + (st.showGrid ? 'on' : 'off') + '</b>', '📐', { sfx: 'click' });
      break;
    }
    case 'F1':
    case 'Help':
      e.preventDefault();
      if (VC.hud && VC.hud.openHelp) VC.hud.openHelp();
      break;
    case 'Delete':
      // Delete / Backspace (the Mac 'delete' key): bulldoze the selected building (usual landmark confirmation)
      e.preventDefault();
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
/** Leaves H / photo mode (the HUD usually handles H/Esc itself in the capture phase; this is the fallback). */
function showUI() {
  const H = VC.hud;
  if (!H) return;
  if (H.photo && H.photoMode) H.photoMode(false);
  else if (H.toggleUI) H.toggleUI(true);
}

/** Overlay cycling: ONE toast that updates in place while O is pressed repeatedly, then fades out. */
let ovToast = null, ovTimer = 0;
function cycleOverlay(dir, shown) {
  const G = VC.gfx, list = VC.OVERLAYS;
  if (!G || !G.setOverlay) return;
  const i = Math.max(0, list.findIndex((o) => o.key === G.overlay));
  const o = list[(i + dir + list.length) % list.length];
  G.setOverlay(o.key);
  if (!shown) return; // photo mode: the map colours are the feedback
  const n = list.indexOf(o);
  const text = '<b>' + escHtml(o.name) + '</b>' + (n > 0 ? ' <small>' + n + '/' + (list.length - 1) + '</small>' : '');
  ovToast = toast(text, o.icon, { reuse: ovToast, duration: 600000, sfx: 'click' });
  clearTimeout(ovTimer);
  const el = ovToast;
  if (el) ovTimer = setTimeout(() => toastOut(el), 2200);
}

function undo() {
  const A = VC.actions;
  if (!A || !A.undo) return;
  const r = A.undo();
  // success: actions play the 'whoosh'; failure: one error sound. One toast either way.
  if (r.ok) toast('Undone: <b>' + escHtml(r.label) + '</b>' + (r.refund > 0 ? ' — refunded ' + VC.fmt.money(r.refund) : ''), '↩️');
  else {
    VC.bus.emit('sfx', { name: 'error' });
    toast(escHtml(r.reason), '↩️', { type: 'warn' });
  }
}
