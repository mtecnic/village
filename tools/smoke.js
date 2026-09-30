#!/usr/bin/env node
/*
 * VOXELPOLIS integration smoke test. Plays a scripted game through the public APIs and
 * checks invariants. Prints a JSON report and screenshots into --outdir.
 *
 *   node tools/smoke.js [--outdir /tmp/smoke] [--size 128] [--days 720] [--quick] [--html file]
 */
'use strict';
const path = require('path');
const fs = require('fs');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const OUT = opt('outdir', '/tmp/smoke');
const SIZE = +opt('size', 128);
const DAYS = +opt('days', 720);
const QUICK = argv.includes('--quick');
fs.mkdirSync(OUT, { recursive: true });
const html = path.resolve(opt('html', path.join(__dirname, '..', 'Voxelpolis.html')));

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message)));
  await page.goto(`file://${html}?autostart=1&seed=4242&size=${SIZE}&map=river&difficulty=normal`);
  await page.waitForFunction(() => window.VC && VC.gfx && VC.gfx.frameCount > 3, null, { timeout: 90000 });
  const shot = async (name) => { await page.waitForTimeout(1500); await page.screenshot({ path: path.join(OUT, name + '.png') }); };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const report = {};

  // 1. Build a starter city through VC.actions (the real player path).
  report.build = await ev(() => {
    const S = VC.state, A = VC.actions, W = VC.world, C = VC.C;
    const out = { steps: [] };
    // find a dry flat-ish 30x30 area near the center
    let best = null;
    for (let t = 0; t < 400; t++) {
      const x = 10 + Math.floor(Math.random() * (S.W - 50)), z = 10 + Math.floor(Math.random() * (S.H - 50));
      let dry = 0;
      for (let zz = z; zz < z + 30; zz += 3) for (let xx = x; xx < x + 30; xx += 3) if (!W.isWater(xx, zz)) dry++;
      const score = dry - Math.hypot(x + 15 - S.W / 2, z + 15 - S.H / 2) * 0.1;
      if (!best || score > best.score) best = { x, z, score };
    }
    const x0 = best.x, z0 = best.z;
    out.origin = [x0, z0];
    const road = (ax, az, bx, bz, type = 1) => { const p = A.roadPath(ax, az, bx, bz); const r = A.buildRoad(p, type); out.steps.push(['road', r.ok, r.cost, r.reason]); };
    for (let k = 0; k <= 4; k++) { road(x0, z0 + k * 6, x0 + 24, z0 + k * 6); road(x0 + k * 6, z0, x0 + k * 6, z0 + 24); }
    const zone = (ax, az, bx, bz, code) => { const r = A.zone(ax, az, bx, bz, code); out.steps.push(['zone', code, r.ok, r.cost]); };
    zone(x0 + 1, z0 + 1, x0 + 11, z0 + 11, VC.zcode(1, 1));
    zone(x0 + 13, z0 + 1, x0 + 23, z0 + 5, VC.zcode(2, 1));
    zone(x0 + 13, z0 + 7, x0 + 23, z0 + 11, VC.zcode(1, 1));
    zone(x0 + 1, z0 + 13, x0 + 11, z0 + 23, VC.zcode(1, 1));
    zone(x0 + 13, z0 + 19, x0 + 23, z0 + 23, VC.zcode(3, 1));
    const place = (key, x, z) => {
      for (let dz = 0; dz < 6; dz++) for (let dx = 0; dx < 6; dx++) for (let rot = 0; rot < 4; rot++) {
        const c = A.canPlace(key, x + dx, z + dz, rot);
        if (c && c.ok) { const r = A.placeBuilding(key, x + dx, z + dz, rot); out.steps.push(['place', key, r.ok]); return r; }
      }
      out.steps.push(['place', key, false]);
      return null;
    };
    place('coal_plant', x0 + 25, z0 + 19);
    place('water_tower', x0 + 13, z0 + 13);
    place('water_tower', x0 + 15, z0 + 13);
    place('police_station', x0 + 13, z0 + 14);
    place('fire_station', x0 + 17, z0 + 13);
    place('school', x0 + 19, z0 + 15);
    place('small_park', x0 + 21, z0 + 13);
    out.money = S.money;
    out.buildings = S.buildings.size;
    VC.debug.cam(x0 + 12, z0 + 12, 45, 0.7, 0.85);
    return out;
  });
  await shot('01_built');

  // 2. Fast-forward the simulation.
  report.growth = await ev((days) => {
    const S = VC.state;
    const t0 = performance.now();
    const snaps = [];
    for (let d = 0; d < days; d += 60) { VC.debug.run(60); snaps.push({ day: S.time.day, pop: S.stats.pop, money: Math.round(S.money), R: +S.demand.R.toFixed(2), C: +S.demand.C.toFixed(2), I: +S.demand.I.toFixed(2) }); }
    const ms = performance.now() - t0;
    return { msPerDay: +(ms / days).toFixed(3), snaps, stats: S.stats, buildings: S.buildings.size, history: Object.keys(S.history) };
  }, QUICK ? 180 : DAYS);
  await shot('02_grown');

  // 3. Overlays, time of day.
  for (const ov of ['landValue', 'pollution', 'power', 'traffic']) {
    await ev((k) => VC.gfx.setOverlay(k), ov);
    await shot('03_overlay_' + ov);
  }
  await ev(() => VC.gfx.setOverlay('none'));
  await ev(() => VC.debug.tod(0.92));
  await shot('04_night');
  await ev(() => VC.debug.tod(0.45));

  // 4. Panels.
  report.panels = await ev(() => {
    const keys = (VC.panels.list || []).map((p) => p.key);
    const res = {};
    for (const k of keys) { try { VC.panels.open(k); res[k] = VC.ui.isOpen(k) || !!document.querySelector(`[data-win="${k}"]`); } catch (e) { res[k] = 'ERR ' + e.message; } }
    return res;
  });
  await shot('05_panels');
  await ev(() => VC.ui.closeAll());

  // 5. Disasters.
  report.disasters = await ev(() => {
    const out = {};
    for (const t of (VC.disasters.TYPES || [])) {
      try { out[t.key] = VC.disasters.trigger(t.key, VC.camera.tx, VC.camera.tz); } catch (e) { out[t.key] = 'ERR ' + e.message; }
    }
    return out;
  });
  await page.waitForTimeout(4000);
  await ev(() => VC.debug.run(20));
  await shot('06_disasters');

  // 6. Save / load round trip.
  report.save = await ev(async () => {
    try {
      const S = VC.state;
      const before = { pop: S.stats.pop, n: S.buildings.size, money: Math.round(S.money), day: S.time.day };
      const ok = await VC.save.save('smoke');
      const ok2 = await VC.save.load('smoke');
      const T = VC.state;
      const after = { pop: T.stats.pop, n: T.buildings.size, money: Math.round(T.money), day: T.time.day };
      return { ok, ok2, before, after, same: JSON.stringify(before) === JSON.stringify(after) };
    } catch (e) { return 'ERR ' + e.message; }
  });

  // 7. Perf.
  await page.waitForTimeout(3000);
  report.perf = await ev(() => VC.debug.perf());
  report.errors = errs.concat(await ev(() => VC.errors));
  console.log(JSON.stringify(report, null, 1));
  await browser.close();
  process.exit(report.errors.length ? 1 : 0);
})();
