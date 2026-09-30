/*
 * VOXELPOLIS — core namespace, event bus, math, RNG, noise, formatting, DOM helper.
 * Loaded first. Everything shared lives on the global `VC` object.
 */
const VC = (window.VC = window.VC || {});
VC.VERSION = '1.0.0';
VC.NAME = 'VOXELPOLIS';

/* ------------------------------------------------------------------ */
/* Event bus                                                           */
/* ------------------------------------------------------------------ */
{
  const handlers = Object.create(null);
  VC.bus = {
    on(name, fn) {
      (handlers[name] || (handlers[name] = [])).push(fn);
      return fn;
    },
    off(name, fn) {
      const a = handlers[name];
      if (!a) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    once(name, fn) {
      const w = (d) => {
        VC.bus.off(name, w);
        fn(d);
      };
      return VC.bus.on(name, w);
    },
    emit(name, data) {
      const a = handlers[name];
      if (!a || !a.length) return;
      for (const fn of a.slice()) {
        try {
          fn(data);
        } catch (e) {
          console.error('[bus:' + name + ']', e);
        }
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Scalar math                                                         */
/* ------------------------------------------------------------------ */
const M = (VC.M = {});
M.PI2 = Math.PI * 2;
M.DEG = Math.PI / 180;
M.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
M.sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
M.lerp = (a, b, t) => a + (b - a) * t;
M.invLerp = (a, b, v) => (v - a) / (b - a);
M.remap = (v, a0, a1, b0, b1) => b0 + ((v - a0) / (a1 - a0)) * (b1 - b0);
M.smoothstep = (e0, e1, x) => {
  const t = M.clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
M.fract = (x) => x - Math.floor(x);
M.sign = (x) => (x < 0 ? -1 : x > 0 ? 1 : 0);
/** Frame-rate independent exponential approach: returns new value moving `cur` toward `target`. */
M.damp = (cur, target, rate, dt) => target + (cur - target) * Math.exp(-rate * dt);
M.dampAngle = (cur, target, rate, dt) => {
  let d = ((target - cur + Math.PI) % M.PI2) - Math.PI;
  if (d < -Math.PI) d += M.PI2;
  return target - d * Math.exp(-rate * dt);
};
M.dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/** Deterministic integer hash of (x, z, seed) -> float in [0, 1). */
M.hash = (x, z = 0, s = 0) => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
/** Deterministic integer hash -> uint32. */
M.hashU = (x, z = 0, s = 0) => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
};
/** Seeded PRNG (mulberry32). Returns a function -> float in [0, 1). Helpers attached. */
M.rng = (seed) => {
  let a = seed >>> 0 || 0x9e3779b9;
  const r = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)); // inclusive
  r.range = (lo, hi) => lo + r() * (hi - lo);
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.chance = (p) => r() < p;
  return r;
};
M.seedFromString = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
};

/* ------------------------------------------------------------------ */
/* Vectors (plain arrays) and 4x4 matrices (Float32Array, column-major) */
/* ------------------------------------------------------------------ */
const V3 = (VC.V3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
});

const Mat4 = (VC.Mat4 = {
  create() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },
  identity(o) {
    o.fill(0);
    o[0] = o[5] = o[10] = o[15] = 1;
    return o;
  },
  copy(o, a) {
    o.set(a);
    return o;
  },
  /** o = a * b */
  mul(o, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    for (let i = 0; i < 4; i++) {
      const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
      o[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      o[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      o[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      o[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    }
    return o;
  },
  perspective(o, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    o.fill(0);
    o[0] = f / aspect;
    o[5] = f;
    o[10] = (far + near) * nf;
    o[11] = -1;
    o[14] = 2 * far * near * nf;
    return o;
  },
  ortho(o, l, r, b, t, n, f) {
    o.fill(0);
    o[0] = 2 / (r - l);
    o[5] = 2 / (t - b);
    o[10] = -2 / (f - n);
    o[12] = -(r + l) / (r - l);
    o[13] = -(t + b) / (t - b);
    o[14] = -(f + n) / (f - n);
    o[15] = 1;
    return o;
  },
  lookAt(o, eye, ctr, up) {
    let zx = eye[0] - ctr[0], zy = eye[1] - ctr[1], zz = eye[2] - ctr[2];
    let l = Math.hypot(zx, zy, zz) || 1;
    zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1;
    xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
    o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
    o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
    o[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    o[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    o[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    o[15] = 1;
    return o;
  },
  invert(o, a) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null;
    det = 1 / det;
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  },
  /** Transforms point (x,y,z,1) by m; returns [x,y,z,w] (no divide). */
  xform4(m, x, y, z, w = 1) {
    return [
      m[0] * x + m[4] * y + m[8] * z + m[12] * w,
      m[1] * x + m[5] * y + m[9] * z + m[13] * w,
      m[2] * x + m[6] * y + m[10] * z + m[14] * w,
      m[3] * x + m[7] * y + m[11] * z + m[15] * w,
    ];
  },
  /** Projects world point through viewProj -> [ndcX, ndcY, ndcZ, w]. */
  project(m, x, y, z) {
    const r = Mat4.xform4(m, x, y, z, 1);
    const iw = 1 / r[3];
    return [r[0] * iw, r[1] * iw, r[2] * iw, r[3]];
  },
});

/* ------------------------------------------------------------------ */
/* Noise: seeded 2D simplex, fbm, ridged                                */
/* ------------------------------------------------------------------ */
VC.makeNoise = function (seed) {
  const rnd = M.rng(seed);
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const G = [1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1];
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  /** Simplex noise, returns roughly [-1, 1]. */
  function n2(xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0, tt, g;
    tt = 0.5 - x0 * x0 - y0 * y0;
    if (tt > 0) { g = (perm[ii + perm[jj]] & 7) * 2; tt *= tt; n += tt * tt * (G[g] * x0 + G[g + 1] * y0); }
    tt = 0.5 - x1 * x1 - y1 * y1;
    if (tt > 0) { g = (perm[ii + i1 + perm[jj + j1]] & 7) * 2; tt *= tt; n += tt * tt * (G[g] * x1 + G[g + 1] * y1); }
    tt = 0.5 - x2 * x2 - y2 * y2;
    if (tt > 0) { g = (perm[ii + 1 + perm[jj + 1]] & 7) * 2; tt *= tt; n += tt * tt * (G[g] * x2 + G[g + 1] * y2); }
    return 70 * n;
  }
  /** Fractal brownian motion, returns roughly [-1, 1]. */
  function fbm(x, y, oct = 5, lac = 2, gain = 0.5) {
    let a = 1, f = 1, s = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      s += a * n2(x * f, y * f);
      norm += a;
      a *= gain;
      f *= lac;
    }
    return s / norm;
  }
  /** Ridged multifractal, returns [0, 1]. */
  function ridge(x, y, oct = 5, lac = 2, gain = 0.5) {
    let a = 1, f = 1, s = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      const v = 1 - Math.abs(n2(x * f, y * f));
      s += a * v * v;
      norm += a;
      a *= gain;
      f *= lac;
    }
    return s / norm;
  }
  return { n2, fbm, ridge };
};

/* ------------------------------------------------------------------ */
/* Color helpers                                                        */
/* ------------------------------------------------------------------ */
VC.color = {
  /** 0xRRGGBB or '#rrggbb' -> [r,g,b] in 0..1 (sRGB). */
  rgb(hex) {
    if (typeof hex === 'string') hex = parseInt(hex.replace('#', ''), 16);
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  },
  toLinear(c) {
    return c.map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  },
  css(c, a = 1) {
    return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
  },
  mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  },
};

/* ------------------------------------------------------------------ */
/* Formatting                                                           */
/* ------------------------------------------------------------------ */
VC.fmt = {
  num(n) {
    return Math.round(n).toLocaleString('en-US');
  },
  short(n) {
    const a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e9) return s + (a / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
    if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e4) return s + (a / 1e3).toFixed(0) + 'k';
    if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'k';
    return s + Math.round(a);
  },
  money(n) {
    if (!isFinite(n)) return '∞';
    const s = n < 0 ? '-' : '';
    const a = Math.abs(n);
    if (a >= 1e6) return s + '$' + VC.fmt.short(a);
    return s + '$' + Math.round(a).toLocaleString('en-US');
  },
  pct(x, digits = 0) {
    return (x * 100).toFixed(digits) + '%';
  },
  /** Sim day index -> 'Mar 2027'. */
  date(day) {
    const C = VC.C;
    const m = Math.floor(day / C.DAYS_PER_MONTH) % 12;
    const y = C.START_YEAR + Math.floor(day / (C.DAYS_PER_MONTH * 12));
    return C.MONTHS[m] + ' ' + y;
  },
  fullDate(day) {
    const C = VC.C;
    const d = (day % C.DAYS_PER_MONTH) + 1;
    return VC.fmt.date(day).replace(' ', ' ' + d + ', ');
  },
};

/* ------------------------------------------------------------------ */
/* DOM helper: VC.h('div', {class:'x', onclick: fn, style:{...}}, ...children) */
/* ------------------------------------------------------------------ */
VC.h = function (tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
};
VC.$ = (sel, root = document) => root.querySelector(sel);
VC.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* Small base64 helpers for typed arrays (used by save/load). */
VC.b64 = {
  fromBytes(u8) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  },
  toBytes(str) {
    const s = atob(str);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  },
};
