/*
 * VOXELPOLIS — input (BASIC FOUNDATION VERSION — to be replaced/extended).
 * Camera: wheel zoom (toward cursor), right-drag orbit, middle/left-drag pan, WASD/arrows pan, Q/E rotate.
 */
const I = (VC.input = {
  keys: new Set(),
  mouse: { x: 0, y: 0, buttons: 0, over: false },
  init() {
    const cv = VC.gfx.canvas;
    let drag = null;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('mousedown', (e) => {
      drag = { b: e.button, x: e.clientX, y: e.clientY };
      cv.focus();
    });
    window.addEventListener('mouseup', () => (drag = null));
    window.addEventListener('mousemove', (e) => {
      I.mouse.x = e.clientX;
      I.mouse.y = e.clientY;
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.b === 2) VC.camera.orbit(-dx * 0.006, dy * 0.004);
      else VC.camera.pan(dx, dy);
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      VC.camera.zoom(Math.pow(1.0015, e.deltaY), e.clientX, e.clientY);
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      I.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => I.keys.delete(e.code));
    window.addEventListener('blur', () => I.keys.clear());
  },
  update(dt, rdt) {
    const k = I.keys, cam = VC.camera;
    const sp = cam.goal.dist * 0.9 * rdt;
    if (k.has('KeyW') || k.has('ArrowUp')) cam.panLocal(sp, 0);
    if (k.has('KeyS') || k.has('ArrowDown')) cam.panLocal(-sp, 0);
    if (k.has('KeyA') || k.has('ArrowLeft')) cam.panLocal(0, -sp);
    if (k.has('KeyD') || k.has('ArrowRight')) cam.panLocal(0, sp);
    if (k.has('KeyQ')) cam.orbit(1.4 * rdt, 0);
    if (k.has('KeyE')) cam.orbit(-1.4 * rdt, 0);
  },
});
