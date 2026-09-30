/*
 * VOXELPOLIS — procedural audio engine (VC.audio): context + mixer, positional SFX voices, the offline
 * DSP toolkit every sound is synthesized with, and the game-event hooks. Everything is generated at
 * runtime — no samples, no data URIs. Companion files extend VC.audio:
 *   audio_sfx.js   RECIPES: every named sound effect (rendered once per variant into AudioBuffers)
 *   audio_music.js music:   generative soundtrack (scheduler, instruments, sections, moods)
 *   audio_amb.js   amb:     ambience beds + scheduled one-shots driven by what the camera sees
 *
 * MIXER   sources -> music / sfx / amb busses (volumes from VC.settings.musicVol / sfxVol, optional
 *         ambienceVol / masterVol / muted) -> master in -> glue compressor -> limiter -> master -> out.
 *         Music and SFX each have a generated-IR ConvolverNode reverb (hall / room).
 * LIFECYCLE  The AudioContext is created + resumed on the first pointerdown/keydown/touchend (autoplay
 *         policy); nothing throws if WebAudio is missing. Hidden tab -> fade out + suspend.
 * SFX     play(name, {x, z, vol, rate}) or bus 'sfx' {name, x?, z?, vol?}. With x,z the sound is attenuated
 *         by distance from the camera target (scaled by zoom), low-passed when far and panned by screen x.
 *         Duplicate suppression: every sound belongs to a GROUP with a minimum re-trigger window, so the
 *         same event reported by several modules (e.g. 'built' + sfx 'build', HUD 'fanfare' + advisors
 *         'milestone') plays once. Voice cap 32 (low-priority sounds are dropped first).
 * AUTO-HANDLED BUS EVENTS (see api notes): built, bldRemove, milestone, achievement, advisor, noMoney,
 *         disaster (start), windowOpened/windowClosed, toast, policyChanged, speed; UI button hover.
 * API     play, stop(), duck(amount, sec), spatial(x, z), unlocked(), ready(), stats, list() (sound names),
 *         dsp (offline synthesis toolkit), buffer(name, variant).
 */
const M = VC.M;
const A = (VC.audio = Object.assign(VC.audio || {}, {
  ctx: null,
  bus: null, // {master, in, music, sfx, amb, musicIn, sfxIn, ambIn, musicVerb, sfxVerb, duck}
  RECIPES: {},
  ALIAS: {},
  stats: { played: 0, deduped: 0, dropped: 0, voices: 0, live: 0, renders: 0, renderMs: 0, jobs: 0 },
  started: false,
}));

const MAX_VOICES = 32;
const lastGroup = Object.create(null);
const activeByName = Object.create(null);
const bufCache = new Map();
const jobs = [];
let unlockBound = false;
let hiddenTimer = 0;
let lastVols = { music: -1, sfx: -1, amb: -1, master: -1 };
let warnedUnknown = Object.create(null);

/* ------------------------------------------------------------------ */
/* DSP toolkit — offline synthesis into Float32Arrays                   */
/* ------------------------------------------------------------------ */
let SR = 44100;
const TAU = Math.PI * 2;
/** xorshift32 PRNG -> [0,1). */
function rng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
/** RBJ biquad (direct form I) usable inside per-sample loops. */
class Biquad {
  constructor(type, f, q) {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.set(type || 'lp', f || 1000, q || 0.707);
  }
  set(type, f, q) {
    const w = (TAU * M.clamp(f, 10, SR * 0.45)) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * (q || 0.707));
    let b0, b1, b2;
    if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; }
    else { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    const a0 = 1 + al;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = (-2 * c) / a0; this.a2 = (1 - al) / a0;
    this.type = type;
    return this;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}
/** Noise source factory: 'white' | 'pink' (Kellet) | 'brown' (leaky integrator). */
function noiseGen(color, r) {
  if (color === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    return () => {
      const w = r() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      const o = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
      return o;
    };
  }
  if (color === 'brown') {
    let b = 0;
    return () => { b = (b + 0.02 * (r() * 2 - 1)) / 1.02; return b * 3.5; };
  }
  return () => r() * 2 - 1;
}
/** PolyBLEP correction for band-limited saw/square. */
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

const D = {
  get sr() { return SR; },
  rng,
  Biquad,
  noiseGen,
  n: (sec) => Math.max(1, Math.round(sec * SR)),
  buf: (sec) => new Float32Array(Math.max(1, Math.round(sec * SR))),
  mtof: (m) => 440 * Math.pow(2, (m - 69) / 12),
  /**
   * Adds an oscillator. f0 -> f1 glide (exponential unless o.glide 'lin'). Envelope: linear attack o.a (s),
   * then exponential decay with time constant o.d (s; 0 = sustain), o.hold (s) before decaying.
   * o.type 'sin' | 'tri' | 'saw' | 'sqr' (o.pw), o.vib [rateHz, depth], o.env(t01) extra gain curve.
   */
  tone(out, t0, dur, f0, f1, amp, o = {}) {
    const i0 = Math.round(t0 * SR), n = Math.min(out.length - i0, Math.round(dur * SR));
    if (n <= 0 || i0 < 0) return out;
    const att = Math.max(1, (o.a == null ? 0.002 : o.a) * SR), hold = (o.hold || 0) * SR;
    const decf = o.d ? Math.exp(-1 / (o.d * SR)) : 1;
    const lin = o.glide === 'lin';
    const fr = f1 && f1 !== f0 && !lin ? Math.pow(f1 / f0, 1 / n) : 1;
    const fstep = lin ? (f1 - f0) / n : 0;
    const vr = o.vib ? (o.vib[0] * TAU) / SR : 0, vd = o.vib ? o.vib[1] : 0;
    const type = o.type || 'sin', pw = o.pw || 0.5, envf = o.env;
    const rel = Math.min(n >> 1, Math.round(0.004 * SR));
    let f = f0, ph = o.phase || 0, vp = 0, e = 1, ev = 1;
    for (let i = 0; i < n; i++) {
      let fi = f;
      if (vr) { vp += vr; fi *= 1 + vd * Math.sin(vp); }
      const dt = fi / SR;
      ph += dt;
      if (ph >= 1) ph -= Math.floor(ph);
      let s;
      if (type === 'sin') s = Math.sin(ph * TAU);
      else if (type === 'tri') s = 1 - 4 * Math.abs(ph - 0.5);
      else if (type === 'saw') s = 2 * ph - 1 - blep(ph, dt);
      else { s = (ph < pw ? 1 : -1) + blep(ph, dt) - blep((ph + 1 - pw) % 1, dt); }
      let g;
      if (i < att) g = i / att;
      else { if (i > att + hold) e *= decf; g = e; }
      if (envf && (i & 31) === 0) ev = envf(i / n);
      g *= ev;
      if (i > n - rel) g *= (n - i) / rel;
      out[i0 + i] += s * g * amp;
      f = lin ? f + fstep : f * fr;
    }
    return out;
  },
  /**
   * Adds filtered noise. o.color, o.f 'lp'|'hp'|'bp' with cutoff o.f0 -> o.f1 (exp sweep) and o.q,
   * o.f2 second filter type (same cutoff), envelope as tone() (o.a, o.hold, o.d, o.env).
   */
  noise(out, t0, dur, amp, o = {}) {
    const i0 = Math.round(t0 * SR), n = Math.min(out.length - i0, Math.round(dur * SR));
    if (n <= 0 || i0 < 0) return out;
    const r = o.rnd || rng((Math.random() * 4294967295) >>> 0);
    const src = noiseGen(o.color || 'white', r);
    const bq = o.f ? new Biquad(o.f, o.f0 || 1000, o.q) : null;
    const bq2 = o.f2 ? new Biquad(o.f2, o.f0 || 1000, o.q2 || o.q) : null;
    const sweep = bq && o.f1 && o.f1 !== o.f0;
    const att = Math.max(1, (o.a == null ? 0.002 : o.a) * SR), hold = (o.hold || 0) * SR;
    const decf = o.d ? Math.exp(-1 / (o.d * SR)) : 1;
    const envf = o.env;
    const rel = Math.min(n >> 1, Math.round(0.004 * SR));
    let e = 1, ev = 1;
    for (let i = 0; i < n; i++) {
      if ((i & 31) === 0) {
        if (sweep) {
          const fc = o.f0 * Math.pow(o.f1 / o.f0, i / n);
          bq.set(o.f, fc, o.q);
          if (bq2) bq2.set(o.f2, fc, o.q2 || o.q);
        }
        if (envf) ev = envf(i / n);
      }
      let s = src();
      if (bq) s = bq.run(s);
      if (bq2) s = bq2.run(s);
      let g;
      if (i < att) g = i / att;
      else { if (i > att + hold) e *= decf; g = e; }
      g *= ev;
      if (i > n - rel) g *= (n - i) / rel;
      out[i0 + i] += s * g * amp;
    }
    return out;
  },
  /** 2-operator FM: carrier fc, modulator fc*ratio, index idx0 -> idx1 (time constant o.id), amp env o.a/o.d. */
  fm(out, t0, dur, fc, ratio, idx0, idx1, amp, o = {}) {
    const i0 = Math.round(t0 * SR), n = Math.min(out.length - i0, Math.round(dur * SR));
    if (n <= 0 || i0 < 0) return out;
    const att = Math.max(1, (o.a == null ? 0.002 : o.a) * SR);
    const decf = o.d ? Math.exp(-1 / (o.d * SR)) : 1;
    const idf = Math.exp(-1 / ((o.id || 0.3) * SR));
    const wc = (TAU * fc) / SR, wm = wc * ratio;
    const rel = Math.min(n >> 1, Math.round(0.004 * SR));
    let pc = 0, pm = 0, e = 1, idx = idx0 - idx1;
    for (let i = 0; i < n; i++) {
      pc += wc; pm += wm;
      const s = Math.sin(pc + (idx1 + idx) * Math.sin(pm));
      idx *= idf;
      let g;
      if (i < att) g = i / att;
      else { e *= decf; g = e; }
      if (i > n - rel) g *= (n - i) / rel;
      out[i0 + i] += s * g * amp;
    }
    return out;
  },
  /** Modal synthesis: modes [[ratio, amp, decaySec], …] of fundamental f; o.a attack. */
  modal(out, t0, dur, f, modes, amp, o = {}) {
    const i0 = Math.round(t0 * SR), n = Math.min(out.length - i0, Math.round(dur * SR));
    if (n <= 0 || i0 < 0) return out;
    const att = Math.max(1, (o.a == null ? 0.001 : o.a) * SR);
    const rel = Math.min(n >> 1, Math.round(0.006 * SR));
    for (const [ratio, ma, dec] of modes) {
      const fr = f * ratio;
      if (fr > SR * 0.45) continue;
      // recursive sine oscillator: cheap, exact
      const w = (TAU * fr) / SR, k = 2 * Math.cos(w);
      let y1 = Math.sin(-w + (o.phase || 0)), y2 = Math.sin(-2 * w + (o.phase || 0));
      const decf = Math.exp(-1 / (dec * SR));
      let e = ma * amp;
      for (let i = 0; i < n; i++) {
        const y = k * y1 - y2;
        y2 = y1; y1 = y;
        let g = e;
        if (i < att) g *= i / att;
        if (i > n - rel) g *= (n - i) / rel;
        out[i0 + i] += y * g;
        e *= decf;
      }
    }
    return out;
  },
  /** Karplus-Strong plucked string. o.damp (0.99..0.999), o.bright (0..1 excitation brightness). */
  ks(out, t0, dur, f, amp, o = {}) {
    const i0 = Math.round(t0 * SR), n = Math.min(out.length - i0, Math.round(dur * SR));
    if (n <= 0 || i0 < 0) return out;
    const r = o.rnd || rng((f * 1000) | 0);
    const N = Math.max(2, Math.round(SR / f - 0.5));
    const line = new Float32Array(N);
    const lp = new Biquad('lp', 800 + (o.bright == null ? 0.5 : o.bright) * 7000, 0.7);
    for (let i = 0; i < N; i++) line[i] = lp.run(r() * 2 - 1);
    let mean = 0;
    for (let i = 0; i < N; i++) mean += line[i];
    mean /= N;
    for (let i = 0; i < N; i++) line[i] -= mean;
    const damp = o.damp || 0.996;
    const rel = Math.min(n >> 1, Math.round(0.01 * SR));
    let p = 0, prev = 0;
    for (let i = 0; i < n; i++) {
      const cur = line[p];
      const nx = (cur + prev) * 0.5 * damp;
      prev = cur;
      line[p] = nx;
      p = p + 1 === N ? 0 : p + 1;
      let g = amp;
      if (i > n - rel) g *= (n - i) / rel;
      out[i0 + i] += cur * g;
    }
    return out;
  },
  /** Random clicks (Poisson, `rate` per second) of decaying bursts, band-passed at o.f (q o.q). */
  crackle(out, t0, dur, rate, amp, o = {}) {
    const i0 = Math.round(t0 * SR), n = Math.min(out.length - i0, Math.round(dur * SR));
    if (n <= 0 || i0 < 0) return out;
    const r = o.rnd || rng((Math.random() * 4294967295) >>> 0);
    const bq = new Biquad('bp', o.f || 3000, o.q || 1.2);
    const p = rate / SR;
    const envf = o.env;
    let burst = 0, bdec = 0, bamp = 0, ev = 1;
    for (let i = 0; i < n; i++) {
      if ((i & 63) === 0 && envf) ev = envf(i / n);
      if (r() < p * ev) {
        burst = 1;
        bamp = (0.3 + 0.7 * r()) * (r() < 0.15 ? 1.8 : 1);
        bdec = Math.exp(-1 / ((0.0004 + r() * (o.len || 0.002)) * SR));
      }
      const x = burst > 0.001 ? (r() * 2 - 1) * burst * bamp : 0;
      burst *= bdec;
      out[i0 + i] += bq.run(x) * amp;
    }
    return out;
  },
  /** In-place biquad over the whole buffer (or [i0, i1)). */
  filter(out, type, f, q, i0 = 0, i1 = out.length) {
    const bq = new Biquad(type, f, q);
    for (let i = i0; i < i1; i++) out[i] = bq.run(out[i]);
    return out;
  },
  /** Soft saturation (tanh-like) with drive. */
  sat(out, drive = 1.5) {
    for (let i = 0; i < out.length; i++) { const x = out[i] * drive; out[i] = x / (1 + Math.abs(x)); }
    return out;
  },
  /** Scales to the given peak. */
  normalize(out, peak = 0.9) {
    let m = 0;
    for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > m) m = a; }
    if (m > 1e-6) { const k = peak / m; for (let i = 0; i < out.length; i++) out[i] *= k; }
    return out;
  },
  /** Short fades against clicks. */
  fade(out, fin = 0.002, fout = 0.01) {
    const a = Math.min(out.length, Math.round(fin * SR)), b = Math.min(out.length, Math.round(fout * SR));
    for (let i = 0; i < a; i++) out[i] *= i / a;
    for (let i = 0; i < b; i++) out[out.length - 1 - i] *= i / b;
    return out;
  },
  /** Mixes src into dst at time t0 with gain. */
  mix(dst, src, t0 = 0, g = 1) {
    const i0 = Math.round(t0 * SR);
    const n = Math.min(src.length, dst.length - i0);
    for (let i = 0; i < n; i++) dst[i0 + i] += src[i] * g;
    return dst;
  },
  /** Seamless loop: buffer rendered with an extra `fadeSec` tail -> crossfaded loop of loopSec. */
  loopify(buf, loopSec, fadeSec) {
    const L = Math.round(loopSec * SR), F = Math.min(Math.round(fadeSec * SR), buf.length - L);
    const out = buf.slice(0, L);
    for (let i = 0; i < F; i++) {
      const t = i / F, a = Math.sqrt(t), b = Math.sqrt(1 - t);
      out[i] = buf[i] * a + buf[L + i] * b;
    }
    return out;
  },
  /** Renders fn(buf, rnd) for each channel (independent random streams) -> [L, R]. */
  stereo(sec, seed, fn) {
    const L = D.buf(sec), R = D.buf(sec);
    fn(L, rng(seed), 0);
    fn(R, rng(seed * 7 + 13), 1);
    return [L, R];
  },
};
A.dsp = D;

/** Float32Array | [L, R] -> AudioBuffer. */
function toBuffer(data) {
  const chans = Array.isArray(data) ? data : [data];
  const ab = A.ctx.createBuffer(chans.length, chans[0].length, SR);
  for (let c = 0; c < chans.length; c++) {
    if (ab.copyToChannel) ab.copyToChannel(chans[c], c);
    else ab.getChannelData(c).set(chans[c]);
  }
  return ab;
}
A.toBuffer = toBuffer;

/** Generated reverb impulse: early reflections + exponentially decaying, darkening stereo noise. */
function makeIR(sec, decay, damp, seed) {
  const n = Math.round(sec * SR), pre = Math.round(0.012 * SR);
  const chans = [];
  for (let c = 0; c < 2; c++) {
    const r = rng(seed + c * 101), out = new Float32Array(n);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / SR;
      const env = Math.exp(-t / decay);
      const k = M.clamp(damp / (1 + t * 6), 0.02, 0.95); // high frequencies die faster
      lp += ((r() * 2 - 1) - lp) * k;
      out[i] = lp * env;
    }
    for (let e = 0; e < 10; e++) {
      const at = pre + Math.round((0.004 + r() * 0.07) * SR);
      if (at < n) out[at] += (r() < 0.5 ? -1 : 1) * (0.5 - e * 0.04);
    }
    for (let i = 0; i < Math.min(n, 64); i++) out[i] *= i / 64;
    chans.push(out);
  }
  return toBuffer(chans);
}

/* ------------------------------------------------------------------ */
/* Context + mixer                                                      */
/* ------------------------------------------------------------------ */
function createContext() {
  if (A.ctx || A.failed) return A.ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) { A.failed = true; return null; }
  try {
    A.ctx = new Ctor();
  } catch (e) {
    A.failed = true;
    console.warn('[audio] WebAudio unavailable', e);
    return null;
  }
  const ctx = A.ctx;
  SR = ctx.sampleRate;
  try {
    buildGraph(ctx);
  } catch (e) {
    console.warn('[audio] graph failed', e);
    A.failed = true;
    return null;
  }
  ctx.onstatechange = () => { if (ctx.state === 'running') onRunning(); };
  if (ctx.state === 'running') onRunning();
  return ctx;
}
function gainNode(ctx, v) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}
function buildGraph(ctx) {
  const B = (A.bus = {});
  B.master = gainNode(ctx, 0);
  B.master.connect(ctx.destination);
  // gentle glue compression, then a fast limiter to keep stacked events from clipping
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20; comp.knee.value = 14; comp.ratio.value = 3; comp.attack.value = 0.012; comp.release.value = 0.28;
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.12;
  B.in = gainNode(ctx, 0.9);
  B.in.connect(comp); comp.connect(lim); lim.connect(B.master);
  // music: in -> tone lowpass -> duck -> volume -> master in; reverb returns join before the tone filter
  B.music = gainNode(ctx, 0);
  B.duck = gainNode(ctx, 1);
  B.musicTone = ctx.createBiquadFilter();
  B.musicTone.type = 'lowpass'; B.musicTone.frequency.value = 9000; B.musicTone.Q.value = 0.4;
  B.musicIn = gainNode(ctx, 1);
  B.musicIn.connect(B.musicTone); B.musicTone.connect(B.duck); B.duck.connect(B.music); B.music.connect(B.in);
  B.musicVerb = gainNode(ctx, 1); // send input
  const mv = ctx.createConvolver();
  mv.buffer = makeIR(3.4, 0.85, 0.5, 11);
  B.musicVerbRet = gainNode(ctx, 0.55);
  B.musicVerb.connect(mv); mv.connect(B.musicVerbRet); B.musicVerbRet.connect(B.musicTone);
  // sfx
  B.sfx = gainNode(ctx, 0);
  B.sfxIn = gainNode(ctx, 1);
  B.sfxIn.connect(B.sfx); B.sfx.connect(B.in);
  B.sfxVerb = gainNode(ctx, 1);
  const sv = ctx.createConvolver();
  sv.buffer = makeIR(1.3, 0.28, 0.7, 23);
  B.sfxVerbRet = gainNode(ctx, 0.5);
  B.sfxVerb.connect(sv); sv.connect(B.sfxVerbRet); B.sfxVerbRet.connect(B.sfx);
  // ambience
  B.amb = gainNode(ctx, 0);
  B.ambIn = gainNode(ctx, 1);
  B.ambIn.connect(B.amb); B.amb.connect(B.in);
  B.ambVerb = B.sfxVerb; // ambient one-shots share the room reverb
  // shared slow "tape wow" LFO: connected to oscillator / buffer-source detune params (cents)
  const wow = ctx.createOscillator();
  wow.frequency.value = 0.42;
  B.wow = gainNode(ctx, 4);
  wow.connect(B.wow);
  wow.start();
  B.hasPan = typeof ctx.createStereoPanner === 'function';
}
function onRunning() {
  if (A.started) return;
  A.started = true;
  lastVols.master = -1; // force volume ramps
  applyVolumes(true);
  // pre-render in idle time (one variant per job): everyday sounds first, then the frequent rest.
  // Heavy, rare disaster / weather sounds render on first use (or are warmed when a disaster starts).
  warm(['click', 'hover', 'open', 'close', 'build', 'road', 'zone', 'bulldoze', 'notify', 'cash', 'error', 'plant', 'tick', 'pause']);
  warm(['levelup', 'success', 'advisor', 'alert', 'alarm', 'dezone', 'demolish', 'collapse', 'fire', 'siren', 'policy', 'terraform', 'pline', 'milestone', 'achievement', 'bird', 'swoosh', 'construct', 'horn', 'splash']);
  if (A.music && A.music.start) try { A.music.start(); } catch (e) { console.error('[audio] music start', e); }
  if (A.amb && A.amb.start) try { A.amb.start(); } catch (e) { console.error('[audio] ambience start', e); }
  VC.bus.emit('audioStarted');
}
function unlock() {
  const ctx = createContext();
  if (!ctx) return;
  if (ctx.state !== 'running' && !document.hidden) {
    const p = ctx.resume();
    if (p && p.then) p.then(() => { if (ctx.state === 'running') onRunning(); }, () => {});
  }
}
function bindUnlock() {
  if (unlockBound) return;
  unlockBound = true;
  const opts = { capture: true, passive: true };
  for (const ev of ['pointerdown', 'keydown', 'touchend', 'mousedown']) window.addEventListener(ev, unlock, opts);
}
function onVisibility() {
  const ctx = A.ctx;
  if (!ctx || !A.bus) return;
  const t = ctx.currentTime;
  clearTimeout(hiddenTimer);
  if (document.hidden) {
    A.bus.master.gain.cancelScheduledValues(t);
    A.bus.master.gain.setTargetAtTime(0, t, 0.05);
    hiddenTimer = setTimeout(() => { if (document.hidden && ctx.state === 'running') ctx.suspend().catch(() => {}); }, 300);
  } else {
    const p = ctx.resume();
    if (p && p.catch) p.catch(() => {});
    lastVols.master = -1;
    applyVolumes(false);
  }
}
/** Perceptual volume curve for 0..1 sliders. */
const curve = (v) => (v > 0 ? Math.pow(M.clamp(v, 0, 1), 1.6) : 0);
function applyVolumes(force) {
  const B = A.bus, ctx = A.ctx;
  if (!B || !ctx) return;
  const st = VC.settings || {};
  const music = curve(st.musicVol == null ? 0.5 : st.musicVol) * 0.62;
  const sfx = curve(st.sfxVol == null ? 0.7 : st.sfxVol) * 0.95;
  const amb = curve(st.ambienceVol != null ? st.ambienceVol : st.sfxVol == null ? 0.7 : st.sfxVol) * 0.85;
  const master = document.hidden || st.muted ? 0 : st.masterVol != null ? M.clamp(st.masterVol, 0, 1) : 1;
  const t = ctx.currentTime;
  setVol(B.music, 'music', music, force ? 1.2 : 0.08, t, force); // the soundtrack eases in on start
  setVol(B.sfx, 'sfx', sfx, 0.05, t, force);
  setVol(B.amb, 'amb', amb, force ? 1.5 : 0.1, t, force);
  setVol(B.master, 'master', master, 0.05, t, force);
}
function setVol(g, key, v, tc, t, force) {
  if (!force && Math.abs(lastVols[key] - v) < 1e-4) return;
  lastVols[key] = v;
  g.gain.cancelScheduledValues(t);
  g.gain.setTargetAtTime(v, t, tc);
}

/* ------------------------------------------------------------------ */
/* Positional audio                                                     */
/* ------------------------------------------------------------------ */
const SP = { g: 1, pan: 0, lp: 0 };
/**
 * Distance gain / pan / low-pass for a world (x, z) relative to the camera. Returns a shared object
 * {g, pan, lp} (lp = cutoff Hz or 0) — copy the values if you need to keep them.
 */
A.spatial = function (x, z) {
  const cam = VC.camera;
  SP.g = 1; SP.pan = 0; SP.lp = 0;
  if (!cam || !isFinite(x) || !isFinite(z)) return SP;
  const dx = x - cam.tx, dz = z - cam.tz;
  const dist = cam.dist || 40;
  const R = 10 + dist * 0.55; // hearing radius grows when zoomed out
  const d2 = (dx * dx + dz * dz) / (R * R);
  let g = 1 / (1 + d2 * 1.6);
  g *= M.clamp(1.3 - dist / 200, 0.35, 1); // far overview: individual sounds recede
  let pan = null;
  const cv = VC.gfx && VC.gfx.canvas;
  if (cam.worldToScreen && cv && cv.clientWidth) {
    const gy = VC.world && VC.state ? VC.world.groundY(x, z) : 0;
    const p = cam.worldToScreen(x, gy, z);
    if (p) pan = M.clamp((p[0] / cv.clientWidth) * 2 - 1, -1.4, 1.4) * 0.65;
  }
  if (pan == null) {
    const s = Math.sin(cam.yaw || 0), c = Math.cos(cam.yaw || 0);
    pan = ((dx * c - dz * s) / (Math.sqrt(dx * dx + dz * dz) + R * 0.3)) * 0.8;
  }
  SP.g = g;
  SP.pan = M.clamp(pan, -0.9, 0.9);
  SP.lp = g < 0.7 ? 900 + 16000 * g * g : 0;
  return SP;
};

/* ------------------------------------------------------------------ */
/* Buffers, voices, play                                                */
/* ------------------------------------------------------------------ */
function hashName(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** Rendered AudioBuffer of a recipe variant (cached; renders synchronously on first use). */
A.buffer = function (name, variant = 0) {
  if (!A.ctx) return null;
  const key = name + '#' + variant;
  let b = bufCache.get(key);
  if (b) return b;
  const R = A.RECIPES[name];
  if (!R) return null;
  const t0 = performance.now();
  try {
    b = toBuffer(R.render(D, rng(hashName(name) + variant * 7919 + 1), variant));
  } catch (e) {
    console.error('[audio] render ' + name, e);
    b = A.ctx.createBuffer(1, 16, SR);
  }
  A.stats.renders++;
  A.stats.renderMs += performance.now() - t0;
  bufCache.set(key, b);
  return b;
};
/** Queues work for idle frames (a few ms per frame). */
A.job = function (fn) {
  jobs.push(fn);
};
A.ready = () => !!(A.ctx && A.ctx.state === 'running' && A.bus);
/** Queues idle-time rendering of every variant of the named recipes. */
function warm(names) {
  for (const n of names) {
    const R = A.RECIPES[A.ALIAS[n] || n];
    if (!R) continue;
    for (let v = 0; v < (R.variants || 1); v++) jobs.push(() => A.buffer(A.ALIAS[n] || n, v));
  }
}
A.warm = warm;
/** performance.now() of the last time a sound of this group started (-1e9 if never). */
A.lastPlayed = (group) => lastGroup[group] || -1e9;
A.unlocked = () => A.started;
A.list = () => Object.keys(A.RECIPES).concat(Object.keys(A.ALIAS)).sort();

/**
 * Plays a named effect. opts: {x, z (world, positional), vol (0..1+), rate (pitch mul), delay (s)}.
 * Returns true when a voice started.
 */
A.play = function (name, opts) {
  if (!A.ready() || !name) return false;
  const o = opts || {};
  name = A.ALIAS[name] || name;
  const R = A.RECIPES[name];
  if (!R) {
    if (!warnedUnknown[name]) { warnedUnknown[name] = 1; console.info('[audio] unknown sfx "' + name + '"'); }
    return false;
  }
  const nowMs = performance.now();
  const grp = R.group || name;
  if (nowMs - (lastGroup[grp] || -1e9) < (R.win == null ? 60 : R.win)) { A.stats.deduped++; return false; }
  let gain = (o.vol == null ? 1 : o.vol) * (R.vol == null ? 1 : R.vol);
  let pan = 0, lp = 0;
  if (o.x != null && o.z != null && R.pos !== false) {
    const sp = A.spatial(+o.x, +o.z);
    gain *= sp.g; pan = sp.pan; lp = sp.lp;
  }
  if (gain < 0.012) { A.stats.dropped++; return false; }
  const prio = R.prio == null ? 1 : R.prio;
  if (A.stats.voices >= MAX_VOICES + (prio >= 2 ? 6 : 0)) { A.stats.dropped++; return false; }
  if (R.max && (activeByName[name] || 0) >= R.max) { A.stats.dropped++; return false; }
  lastGroup[grp] = nowMs;
  const buf = A.buffer(name, Math.floor(Math.random() * (R.variants || 1)));
  if (!buf) return false;
  const ctx = A.ctx, B = A.bus;
  const t = ctx.currentTime + (o.delay || 0) + 0.005;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const pv = R.pitch == null ? 0.05 : R.pitch;
  src.playbackRate.value = (o.rate || 1) * (1 + (Math.random() * 2 - 1) * pv);
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g);
  let tail = g;
  const nodes = [src, g];
  if (lp) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = lp; f.Q.value = 0.5;
    tail.connect(f); tail = f; nodes.push(f);
  }
  if (pan && B.hasPan) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    tail.connect(p); tail = p; nodes.push(p);
  }
  tail.connect(R.bus === 'amb' ? B.ambIn : B.sfxIn);
  // reverb send: per recipe, plus more for distant positional sounds (a natural distance cue)
  const wet = (R.wet || 0) + (lp ? 0.25 : 0);
  if (wet > 0.01) {
    const s = gainNode(ctx, wet);
    tail.connect(s); s.connect(B.sfxVerb); nodes.push(s);
  }
  A.stats.voices++;
  A.stats.live += nodes.length;
  A.stats.played++;
  activeByName[name] = (activeByName[name] || 0) + 1;
  src.onended = () => {
    for (const n of nodes) try { n.disconnect(); } catch (e) { /* ignore */ }
    A.stats.voices--;
    A.stats.live -= nodes.length;
    activeByName[name]--;
  };
  src.start(t);
  if (R.duck) A.duck(R.duck, Math.min(4, buf.duration / src.playbackRate.value));
  return true;
};
/** Temporarily lowers the music (0..1 amount) for `sec` seconds (fanfares, explosions). */
A.duck = function (amount, sec) {
  const B = A.bus, ctx = A.ctx;
  if (!B || !ctx) return;
  const t = ctx.currentTime, p = B.duck.gain;
  p.cancelScheduledValues(t);
  p.setTargetAtTime(1 - M.clamp(amount, 0, 0.9), t, 0.04);
  p.setTargetAtTime(1, t + sec, 0.7);
};
/** Silences everything immediately (e.g. before a reload). */
A.stop = function () {
  if (A.bus && A.ctx) A.bus.master.gain.setTargetAtTime(0, A.ctx.currentTime, 0.02);
};

/* ------------------------------------------------------------------ */
/* Game event hooks                                                     */
/* ------------------------------------------------------------------ */
const BUILT_SOUND = { road: 'road', zone: 'zone', building: 'build', bulldoze: 'bulldoze', terraform: 'terraform', trees: 'plant', pline: 'pline' };
function center(d) {
  if (!d) return null;
  if (d.x == null || d.z == null) return null;
  return { x: d.x + (d.w || 1) / 2, z: d.z + (d.d || 1) / 2 };
}
function onBuilt(d) {
  if (!d) return;
  let name = BUILT_SOUND[d.kind];
  if (!name) return;
  if (d.kind === 'zone' && (d.key === 'dezone' || d.code === 0)) name = 'dezone';
  const c = center(d);
  const o = c ? { x: c.x, z: c.z } : {};
  if (d.kind === 'building') {
    const def = VC.BLD && VC.BLD[d.key];
    const area = def ? def.size[0] * def.size[1] : (d.w || 1) * (d.d || 1);
    o.rate = M.clamp(1.12 - Math.sqrt(area) * 0.07, 0.72, 1.1); // big buildings land lower and heavier
    o.vol = M.clamp(0.8 + area * 0.03, 0.8, 1.3);
  } else if (d.kind === 'zone' && d.key) {
    const t = String(d.key).match(/zone_([rci])/);
    if (t) o.rate = { r: 1, c: 1.26, i: 0.84 }[t[1]]; // R C I chime on a major triad
  }
  A.play(name, o);
}
function onRemove(b) {
  if (!b || !b.removed) return;
  const c = center(b);
  const big = (b.w || 1) * (b.d || 1) >= 4 || b.level >= 3;
  if (b.removed === 'bulldoze') A.play(big ? 'demolish' : 'bulldoze', c);
  else if (b.removed === 'fire') A.play('collapse', c);
  else if (b.removed === 'disaster') A.play('crash', c);
}
const DISASTER_START = { fire: 'fire', tornado: 'wind', meteor: 'meteor', earthquake: 'rumble', ufo: 'ufo', monster: 'roar' };
const DISASTER_WARM = { fire: ['collapse'], tornado: ['collapse'], meteor: ['explosion', 'collapse'], earthquake: ['collapse', 'explosion'], ufo: ['abduct'], monster: ['stomp', 'collapse', 'explosion'] };
function hookBus() {
  const on = (ev, fn) => VC.bus.on(ev, (d) => { if (A.ready()) fn(d); });
  on('sfx', (d) => { if (d) A.play(typeof d === 'string' ? d : d.name, typeof d === 'string' ? null : d); });
  on('built', onBuilt);
  on('bldRemove', onRemove);
  on('milestone', () => A.play('milestone'));
  on('achievement', () => A.play('achievement'));
  on('advisor', (m) => A.play(m && m.severity === 'bad' ? 'alert' : m && m.severity === 'warn' ? 'advisor' : 'notify'));
  on('noMoney', () => A.play('error'));
  on('disaster', (d) => {
    if (!d || d.phase !== 'start') return;
    warm(DISASTER_WARM[d.type] || []);
    A.play('alarm');
    const n = DISASTER_START[d.type];
    if (n) A.play(n, { x: d.x, z: d.z, delay: 0.25 });
  });
  on('windowOpened', () => A.play('open'));
  on('windowClosed', () => A.play('close'));
  on('toast', (t) => A.play(t && (t.type === 'bad' || t.type === 'error') ? 'alert' : t && t.type === 'good' ? 'success' : 'notify', { vol: 0.8 }));
  on('policyChanged', () => A.play('policy'));
  on('speed', (s) => A.play(s ? 'tick' : 'pause')); // same group as 'click': a UI button click wins
  on('settings', () => applyVolumes(false));
}
/** Very soft hover ticks on buttons (mouse only). */
function hookHover() {
  let last = null;
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const t = e.target && e.target.closest ? e.target.closest('button, .btn, [role="button"], .tab, .card, .tool') : null;
    if (t === last) return;
    last = t;
    if (t && !t.disabled && A.ready()) A.play('hover');
  }, { passive: true });
}

/* ------------------------------------------------------------------ */
/* Module lifecycle                                                     */
/* ------------------------------------------------------------------ */
A.init = function () {
  bindUnlock();
  hookBus();
  hookHover();
  document.addEventListener('visibilitychange', onVisibility);
};
A.reset = function (S) {
  if (A.music && A.music.reset) try { A.music.reset(S); } catch (e) { console.error('[audio] music reset', e); }
  if (A.amb && A.amb.reset) try { A.amb.reset(S); } catch (e) { console.error('[audio] ambience reset', e); }
};
A.update = function (dt, rdt) {
  if (!A.ctx || !A.bus || A.ctx.state !== 'running') return;
  applyVolumes(false); // cheap; picks up live slider drags that don't emit 'settings'
  if (jobs.length) {
    const t0 = performance.now();
    while (jobs.length && performance.now() - t0 < 3) {
      const j = jobs.shift();
      A.stats.jobs++;
      try { j(); } catch (e) { console.error('[audio] job', e); }
    }
  }
  if (A.music && A.music.update) try { A.music.update(dt, rdt); } catch (e) { if (!A._mErr) console.error('[audio] music', e); A._mErr = true; }
  if (A.amb && A.amb.update) try { A.amb.update(dt, rdt); } catch (e) { if (!A._aErr) console.error('[audio] ambience', e); A._aErr = true; }
};
