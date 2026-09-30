#!/usr/bin/env node
/*
 * VOXELPOLIS headless test harness (Playwright + SwiftShader WebGL2).
 *
 *   node tools/shot.js [options]
 *     --html <file>        built HTML (default Voxelpolis.html)
 *     --query <qs>         URL query (default "autostart=1&seed=12345&size=96")
 *     --eval <js>          JS run in the page after boot (may return a value / promise; printed as JSON)
 *     --wait <ms>          wait after eval before the screenshot (default 2500)
 *     --out <png>          screenshot path (default /tmp/vp_shot.png); "none" = no screenshot
 *     --w <px> --h <px>    viewport (default 1280x720)
 *     --steps <json>       array of {eval, wait, out} run sequentially on the same page
 *     --gl                 capture the WebGL canvas only via VC.gfx.capture (fast; no HTML UI)
 *     --quiet              only print errors
 * Always prints: page console errors/warnings, uncaught exceptions, VC.errors, and eval results.
 * Exit code 1 if any page error occurred.
 */
'use strict';
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);
const html = path.resolve(opt('html', path.join(__dirname, '..', 'Voxelpolis.html')));
const query = opt('query', 'autostart=1&seed=12345&size=96');
const W = +opt('w', 1280), H = +opt('h', 720);
const quiet = has('quiet');
const glOnly = has('gl');
let steps = opt('steps', null);
steps = steps ? JSON.parse(steps) : [{ eval: opt('eval', null), wait: +opt('wait', 2500), out: opt('out', '/tmp/vp_shot.png') }];

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  let errors = 0;
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') {
      if (t === 'error') errors++;
      console.log(`[console.${t}] ${m.text()}`);
    } else if (!quiet) console.log(`[console.${t}] ${m.text()}`);
  });
  page.on('pageerror', (e) => { errors++; console.log('[pageerror] ' + (e.stack || e.message)); });
  const url = 'file://' + html + (query ? '?' + query : '');
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.VC && VC.gfx && VC.gfx.frameCount > 2, null, { timeout: 180000 }).catch(() => console.log('[harness] timeout waiting for frames'));
  if (!quiet) console.log(`[harness] booted in ${Date.now() - t0} ms`);
  for (const s of steps) {
    if (s.eval) {
      try {
        const r = await page.evaluate(async (code) => {
          // eslint-disable-next-line no-eval
          const v = await (0, eval)(code);
          try { return JSON.stringify(v, (k, x) => (typeof x === 'number' && !isFinite(x) ? String(x) : x)); } catch (e) { return String(v); }
        }, s.eval);
        if (r !== undefined) console.log('[eval] ' + (r.length > 4000 ? r.slice(0, 4000) + '…' : r));
      } catch (e) {
        errors++;
        console.log('[eval error] ' + e.message);
      }
    }
    await page.waitForTimeout(s.wait == null ? 2500 : s.wait);
    if (s.out && s.out !== 'none') {
      if (glOnly || s.gl) {
        const b64 = await page.evaluate(async (w) => {
          const p = VC.gfx.capture(w, 'image/png');
          VC.gfx.render(0, 0.016, true);
          const url = await p;
          return url ? url.split(',')[1] : null;
        }, W);
        if (b64) require('fs').writeFileSync(s.out, Buffer.from(b64, 'base64'));
        else console.log('[harness] gl capture failed');
      } else await page.screenshot({ path: s.out, timeout: 180000 });
      if (!quiet) console.log('[harness] screenshot -> ' + s.out);
    }
  }
  const info = await page.evaluate(() => ({ errors: (window.VC && VC.errors) || [], perf: window.VC && VC.debug ? VC.debug.perf() : null }));
  if (info.errors.length) { errors += info.errors.length; console.log('[VC.errors] ' + JSON.stringify(info.errors)); }
  if (!quiet) console.log('[perf] ' + JSON.stringify(info.perf));
  await browser.close();
  process.exit(errors ? 1 : 0);
})();
