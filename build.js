#!/usr/bin/env node
/*
 * VOXELPOLIS build script.
 * Inlines every source file under src/ into ONE self-contained HTML file (Voxelpolis.html)
 * that runs by double-clicking it — no server, no network, no dependencies.
 *
 *   node build.js            -> builds Voxelpolis.html
 *   node build.js --check    -> syntax-checks every file, no output written
 *   node build.js --out f    -> custom output path
 *
 * Load order: EARLY files first (they define shared APIs used at top level),
 * then every other .js under src/ alphabetically by path, then src/main.js last.
 * Each file is wrapped in its own IIFE + <script> tag, so top-level names never
 * collide between files and a crash in one file cannot take down the others.
 * Files communicate only through the global `VC` namespace.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(ROOT, 'Voxelpolis.html');

const EARLY = [
  'core/base.js',
  'data/defs.js',
  'core/state.js',
  'gfx/shaderlib.js',
  'gfx/core.js',
  'gfx/voxel.js',
];
const LAST = ['main.js'];

function walk(dir, ext, out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, ext, out);
    else if (name.endsWith(ext)) out.push(path.relative(SRC, p).split(path.sep).join('/'));
  }
  return out;
}

const allJs = walk(SRC, '.js');
const middle = allJs.filter((f) => !EARLY.includes(f) && !LAST.includes(f));
const order = [...EARLY.filter((f) => allJs.includes(f)), ...middle, ...LAST.filter((f) => allJs.includes(f))];

let errors = 0;
const scripts = [];
for (const f of order) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  const wrapped = `(function(){'use strict';\n${code}\n})();\n//# sourceURL=voxelpolis/${f}`;
  try {
    new vm.Script(wrapped, { filename: 'src/' + f, lineOffset: -1 });
  } catch (e) {
    errors++;
    const stack = String(e.stack || e).split('\n').slice(0, 5).join('\n');
    console.error(`\n[SYNTAX ERROR] src/${f}\n${stack}\n`);
  }
  if (/<\/script/i.test(code)) {
    errors++;
    console.error(`[ERROR] src/${f} contains a literal "</script" which would break inlining. Split the string.`);
  }
  scripts.push(`<script>\n${wrapped}\n</script>`);
}

const cssFiles = walk(SRC, '.css').sort((a, b) => (a === 'ui/base.css' ? -1 : b === 'ui/base.css' ? 1 : a < b ? -1 : 1));
const css = cssFiles.map((f) => `/* ==== ${f} ==== */\n` + fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');

if (errors) {
  console.error(`Build failed: ${errors} error(s).`);
  process.exit(1);
}
if (CHECK_ONLY) {
  console.log(`OK: ${order.length} js files, ${cssFiles.length} css files syntax-checked.`);
  process.exit(0);
}

let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
html = html.replace('/*@CSS@*/', () => css).replace('<!--@JS@-->', () => scripts.join('\n'));
fs.writeFileSync(OUT, html);
const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`Built ${path.relative(ROOT, OUT)} (${kb} KB) from ${order.length} js + ${cssFiles.length} css files.`);
