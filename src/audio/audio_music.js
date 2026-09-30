/*
 * VOXELPOLIS — generative soundtrack (VC.audio.music). Calm lo-fi / ambient city-builder music that
 * never repeats: a lookahead scheduler (setInterval 25 ms, 0.12 s ahead on the AudioContext clock)
 * sequences 16th-note steps.
 *
 * HARMONY   voice-led 7th/9th chord progressions (I^7–vi9–IV^7–V9sus, ii9–V13–I^9, lydian and dorian
 *           vamps, …) from DAY / NIGHT / TENSION pools; sections of 16-32 bars change progression, key
 *           (4ths/5ths/whole steps), tempo, instruments and patterns; every few sections a sparse
 *           "breather" interlude.
 * LAYERS    pad (real-time detuned PeriodicWave pairs -> lowpass -> stereo chorus -> hall reverb),
 *           round bass (sine + triangle), keys arpeggios and a motif-based lead from sampled
 *           instruments rendered offline (FM e-piano, Karplus-Strong pluck, modal marimba / kalimba /
 *           celesta), brushed lo-fi drums, optional vinyl crackle. Arps and lead feed a tempo-synced
 *           ping-pong delay. A shared slow "tape wow" LFO detunes everything a few cents.
 * MOOD      VC.gfx.env night/dusk/season, weather, game speed, city size (milestone), active disasters /
 *           bankruptcy (tension). Night = slower, sparser, darker, dreamier; day = brighter, drums.
 *           Paused -> scheduling stops and a soft drone fades in; unpausing starts a new section.
 * API       start(), stop(), update(), reset(S), info() -> {key, bpm, bar, section…}, stats {notes, bars, sections},
 *           next() (force a new section), INST / DRUMS (sample renderers), PROGS.
 */
const A = VC.audio, M = VC.M;
const TAU = Math.PI * 2;
const LOOKAHEAD = 0.12;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const rnd = Math.random;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;

/* ------------------------------------------------------------------ */
/* Harmony data                                                         */
/* ------------------------------------------------------------------ */
const QUAL = {
  maj7: [0, 4, 7, 11], maj9: [0, 4, 7, 11, 14], add9: [0, 4, 7, 14], six9: [0, 4, 7, 9, 14], maj7s11: [0, 4, 7, 11, 18],
  m7: [0, 3, 7, 10], m9: [0, 3, 7, 10, 14], m11: [0, 3, 7, 10, 14, 17], m6: [0, 3, 7, 9, 14],
  dom9: [0, 4, 7, 10, 14], dom13: [0, 4, 10, 14, 21], sus: [0, 5, 7, 10, 14], sus2: [0, 2, 7, 14],
};
/** Voicing priority by interval: guide tones first, root last (the bass has it). */
const PRIO = { 3: 0, 4: 0, 10: 1, 11: 1, 5: 1.5, 2: 2, 14: 2, 18: 2, 9: 2.5, 21: 2.5, 17: 2.7, 7: 3, 0: 6 };
const PENT_MAJ = [0, 2, 4, 7, 9], PENT_MIN = [0, 3, 5, 7, 10];
const PROGS = {
  day: [
    { ch: [[0, 'maj7'], [9, 'm9'], [5, 'maj7'], [7, 'sus']] },
    { ch: [[2, 'm9'], [7, 'dom13'], [0, 'maj9'], [0, 'six9']] },
    { ch: [[0, 'maj7'], [4, 'm7'], [9, 'm9'], [5, 'maj7']] },
    { ch: [[5, 'maj7'], [4, 'm7'], [2, 'm9'], [0, 'maj9']] },
    { ch: [[0, 'maj9'], [2, 'dom9'], [0, 'maj9'], [2, 'dom9']] },
    { ch: [[5, 'maj9'], [7, 'sus'], [4, 'm7'], [9, 'm9']] },
    { ch: [[9, 'm9'], [5, 'maj7'], [0, 'add9'], [7, 'sus']] },
    { ch: [[0, 'maj9'], [4, 'm7'], [5, 'maj7'], [7, 'sus'], [9, 'm9'], [4, 'm7'], [5, 'maj9'], [7, 'dom9']] },
    { ch: [[5, 'maj7'], [7, 'dom9'], [4, 'm7'], [9, 'm7'], [2, 'm9'], [7, 'sus'], [0, 'six9'], [0, 'maj9']] },
  ],
  night: [
    { ch: [[0, 'maj7s11'], [0, 'maj7s11'], [9, 'm9'], [9, 'm9']], slow: true },
    { ch: [[0, 'm9'], [5, 'dom9'], [0, 'm9'], [5, 'dom9']], minor: true },
    { ch: [[9, 'm11'], [5, 'maj9'], [0, 'maj9'], [7, 'sus']] },
    { ch: [[0, 'maj9'], [10, 'maj7'], [0, 'maj9'], [10, 'maj7s11']] },
    { ch: [[5, 'maj7s11'], [4, 'm7'], [2, 'm9'], [0, 'six9']] },
    { ch: [[0, 'm11'], [8, 'maj7s11'], [0, 'm11'], [8, 'maj7s11']], minor: true, slow: true },
  ],
  tension: [
    { ch: [[0, 'm9'], [8, 'maj7'], [5, 'm9'], [7, 'sus']], minor: true },
    { ch: [[0, 'm11'], [10, 'sus2'], [8, 'maj7s11'], [7, 'sus']], minor: true },
    { ch: [[0, 'm9'], [0, 'm9'], [8, 'maj7'], [10, 'sus2']], minor: true },
  ],
};

/* ------------------------------------------------------------------ */
/* Sampled instruments (rendered offline, pitch-shifted by playbackRate) */
/* ------------------------------------------------------------------ */
const INST = {
  epiano: {
    vol: 0.42, base: [48, 60, 72, 84],
    render(D, m) {
      const f = mtof(m), k = Math.pow(2, -(m - 60) / 24), dur = 1.2 + 2.4 * k;
      const b = D.buf(dur);
      D.fm(b, 0, dur, f, 1, 1.9, 0.12, 0.85, { a: 0.003, d: 1.5 * k, id: 0.35 }); // warm tine body
      D.fm(b, 0, 0.35, f, 14, 1.2, 0, 0.1, { a: 0.001, d: 0.05, id: 0.03 }); // bell-like attack
      D.tone(b, 0, dur, f * 2, f * 2, 0.07, { d: 0.45 * k });
      D.sat(b, 1.15);
      return D.fade(D.normalize(b, 0.85), 0.001, 0.08);
    },
  },
  pluck: {
    vol: 0.46, base: [48, 60, 72, 84],
    render(D, m, r) {
      const f = mtof(m), dur = 2.4 - (m - 48) / 40;
      const b = D.buf(dur);
      D.ks(b, 0, dur, f, 1, { damp: 0.9972 - Math.max(0, m - 60) * 0.00012, bright: 0.45, rnd: r });
      D.filter(b, 'lp', Math.min(9000, f * 9), 0.6);
      return D.fade(D.normalize(b, 0.85), 0.001, 0.06);
    },
  },
  marimba: {
    vol: 0.5, base: [60, 72, 84],
    render(D, m, r) {
      const f = mtof(m), k = Math.pow(2, -(m - 60) / 18), dur = 0.6 + 1.1 * k;
      const b = D.buf(dur);
      D.modal(b, 0, dur, f, [[1, 1, 0.42 * k], [3.93, 0.3, 0.1 * k], [9.4, 0.07, 0.025]], 1, { a: 0.0015 });
      D.noise(b, 0, 0.012, 0.12, { f: 'lp', f0: 2500, d: 0.004, rnd: r });
      return D.fade(D.normalize(b, 0.85), 0.001, 0.05);
    },
  },
  kalimba: {
    vol: 0.44, base: [60, 72, 84],
    render(D, m, r) {
      const f = mtof(m), dur = 2.2 - (m - 60) / 30;
      const b = D.buf(dur);
      D.modal(b, 0, dur, f, [[1, 1, 0.75], [5.4, 0.18, 0.06], [12.3, 0.07, 0.02]], 1, { a: 0.002 });
      D.noise(b, 0, 0.008, 0.08, { f: 'bp', f0: 1800, q: 1, d: 0.003, rnd: r });
      return D.fade(D.normalize(b, 0.85), 0.001, 0.06);
    },
  },
  celesta: {
    vol: 0.34, base: [72, 84, 96],
    render(D, m) {
      const f = mtof(m), dur = 2.8 - (m - 72) / 20;
      const b = D.buf(dur);
      D.modal(b, 0, dur, f, [[1, 1, 1.0], [2.0, 0.22, 0.45], [3.0, 0.1, 0.25], [4.16, 0.06, 0.1]], 1, { a: 0.002 });
      D.fm(b, 0, 0.3, f, 3.5, 0.8, 0, 0.12, { a: 0.001, d: 0.05, id: 0.04 });
      return D.fade(D.normalize(b, 0.85), 0.001, 0.08);
    },
  },
};
const DRUMS = {
  kick: (D) => { const b = D.buf(0.45); D.tone(b, 0, 0.45, 118, 44, 1, { a: 0.001, d: 0.15 }); D.noise(b, 0, 0.01, 0.25, { f: 'lp', f0: 3000, d: 0.003 }); D.filter(b, 'lp', 2200, 0.7); return D.normalize(b, 0.9); },
  brush: (D) => { const b = D.buf(0.36); D.noise(b, 0, 0.36, 1, { color: 'pink', f: 'bp', f0: 2300, q: 0.6, a: 0.012, d: 0.08 }); D.tone(b, 0, 0.12, 190, 172, 0.25, { d: 0.035 }); return D.normalize(b, 0.8); },
  hat: (D) => { const b = D.buf(0.09); D.noise(b, 0, 0.09, 1, { f: 'hp', f0: 7000, f2: 'bp', q2: 0.6, d: 0.02 }); return D.normalize(b, 0.7); },
  ohat: (D) => { const b = D.buf(0.4); D.noise(b, 0, 0.4, 1, { f: 'hp', f0: 6500, a: 0.004, d: 0.12 }); return D.normalize(b, 0.6); },
  shaker: (D) => { const b = D.buf(0.13); D.noise(b, 0, 0.13, 1, { f: 'bp', f0: 6200, q: 1.1, a: 0.014, d: 0.03 }); return D.normalize(b, 0.7); },
  rim: (D) => { const b = D.buf(0.12); D.modal(b, 0, 0.12, 1650, [[1, 1, 0.018], [2.3, 0.5, 0.01]], 0.8); D.noise(b, 0, 0.012, 0.4, { f: 'bp', f0: 3000, q: 1, d: 0.004 }); return D.normalize(b, 0.8); },
  vinyl: (D) => {
    const long = D.buf(4.5);
    D.crackle(long, 0, 4.5, 9, 0.9, { f: 3500, q: 0.7, len: 0.0008 });
    D.noise(long, 0, 4.5, 0.05, { f: 'bp', f0: 3000, q: 0.5 });
    return D.loopify(long, 4, 0.5);
  },
};

/* ------------------------------------------------------------------ */
/* Engine state                                                         */
/* ------------------------------------------------------------------ */
const samples = {}; // inst -> [{midi, buf}] (sorted)
const queued = {};
const drums = {};
let N = null; // music nodes
let timer = 0;
const MU = (A.music = {
  on: false,
  bpm: 84, key: 5,
  nextT: 0, step: 0, bar: 0, secBar: 0,
  sec: null, chord: null, voicing: null, prevVoicing: null,
  mode: 'off', // 'play' | 'drone' | 'off'
  sections: 0,
  stats: { notes: 0, bars: 0, sections: 0 },
  trace: null, // set to [] to record [time, kind, …] events (debug / tests)
  INST, DRUMS, PROGS, QUAL,
});

function ensureInst(name) {
  if (samples[name] || queued[name]) return;
  queued[name] = true;
  const I = INST[name];
  const list = [];
  for (const m of I.base) {
    A.job(() => {
      const D = A.dsp;
      const t0 = performance.now();
      list.push({ midi: m, buf: A.toBuffer(I.render(D, m, D.rng(m * 131 + name.length))) });
      list.sort((a, b) => a.midi - b.midi);
      A.stats.renders++;
      A.stats.renderMs += performance.now() - t0;
      if (list.length === I.base.length) samples[name] = list;
    });
  }
}
function ensureDrums() {
  if (drums._q) return;
  drums._q = true;
  for (const k in DRUMS) A.job(() => { drums[k] = A.toBuffer(DRUMS[k](A.dsp)); });
}

/* ------------------------------------------------------------------ */
/* Mix graph                                                            */
/* ------------------------------------------------------------------ */
function build() {
  const ctx = A.ctx, B = A.bus;
  const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
  const pan = (v) => { if (!B.hasPan) return g(1); const p = ctx.createStereoPanner(); p.pan.value = v; return p; };
  const lp = (f, q) => { const n = ctx.createBiquadFilter(); n.type = 'lowpass'; n.frequency.value = f; n.Q.value = q || 0.5; return n; };
  N = {};
  N.level = g(0); // section/pause fades
  N.level.connect(B.musicIn);
  // delay (ping-pong, tempo-synced)
  N.delayIn = g(1);
  N.dl = ctx.createDelay(2); N.dr = ctx.createDelay(2);
  N.fb = g(0.36);
  const dTone = lp(3200, 0.4);
  N.delayOut = g(0.42);
  N.delayIn.connect(N.dl); N.dl.connect(N.dr); N.dr.connect(N.fb); N.fb.connect(N.dl);
  const merge = ctx.createChannelMerger(2);
  N.dl.connect(merge, 0, 0); N.dr.connect(merge, 0, 1);
  merge.connect(dTone); dTone.connect(N.delayOut); N.delayOut.connect(N.level);
  N.delayOut.connect(B.musicVerb);
  // pad: lowpass (mood) -> dry + two modulated chorus taps panned wide -> reverb
  N.pad = g(1);
  N.padLP = lp(1800, 0.7);
  N.pad.connect(N.padLP);
  N.padLP.connect(N.level);
  const pv = g(0.7);
  N.padLP.connect(pv); pv.connect(B.musicVerb);
  for (const [dt, rate, pn] of [[0.017, 0.31, -0.7], [0.023, 0.23, 0.7]]) {
    const d = ctx.createDelay(0.1);
    d.delayTime.value = dt;
    const lfo = ctx.createOscillator(), depth = g(0.0035);
    lfo.frequency.value = rate;
    lfo.connect(depth); depth.connect(d.delayTime); lfo.start();
    const p = pan(pn), tg = g(0.42);
    N.padLP.connect(d); d.connect(tg); tg.connect(p); p.connect(N.level);
  }
  // keys / lead
  const sendBus = (panV, verb, delay) => {
    const i = g(1), p = pan(panV);
    i.connect(p); p.connect(N.level);
    const v = g(verb); i.connect(v); v.connect(B.musicVerb);
    const d = g(delay); i.connect(d); d.connect(N.delayIn);
    return i;
  };
  N.keys = sendBus(-0.22, 0.32, 0.22);
  N.lead = sendBus(0.28, 0.5, 0.34);
  // bass
  N.bass = g(1);
  const bl = lp(650, 0.6);
  N.bass.connect(bl); bl.connect(N.level);
  // drums
  N.drums = g(1);
  N.drumLP = lp(9000, 0.4);
  N.drums.connect(N.drumLP); N.drumLP.connect(N.level);
  const dv = g(0.12); N.drums.connect(dv); dv.connect(B.musicVerb);
  // vinyl crackle bed (lo-fi sections)
  N.vinylG = g(0);
  N.vinylG.connect(N.level);
  // drone (pause)
  N.drone = g(0);
  N.droneLP = lp(700, 0.8);
  N.drone.connect(N.droneLP); N.droneLP.connect(N.level);
  const dvv = g(0.8); N.droneLP.connect(dvv); dvv.connect(B.musicVerb);
  const dlfo = ctx.createOscillator(), dlg = g(260);
  dlfo.frequency.value = 0.07;
  dlfo.connect(dlg); dlg.connect(N.droneLP.frequency); dlfo.start();
  // pad wave: soft saw-like spectrum with rolled-off highs
  const H = 28, re = new Float32Array(H), im = new Float32Array(H);
  for (let n = 1; n < H; n++) im[n] = (1 / Math.pow(n, 1.35)) * (n % 2 ? 1 : 0.72) * Math.exp(-n / 22);
  N.wave = ctx.createPeriodicWave(re, im);
}

/* ------------------------------------------------------------------ */
/* Voices                                                               */
/* ------------------------------------------------------------------ */
function track(nodes, src, params) {
  A.stats.live += nodes.length;
  MU.stats.notes++;
  src.onended = () => {
    for (const p of params) try { A.bus.wow.disconnect(p); } catch (e) { /* ignore */ }
    for (const n of nodes) try { n.disconnect(); } catch (e) { /* ignore */ }
    A.stats.live -= nodes.length;
  };
}
/** Sampler note: nearest rendered pitch, shifted by playbackRate. dur = optional damp time. */
function sampleNote(inst, midi, t, vel, dest, dur) {
  const set = samples[inst];
  if (!set || !set.length) return;
  if (MU.trace) MU.trace.push([t, dest === N.lead ? 'lead' : 'keys', midi, vel]);
  let s = set[0];
  for (const x of set) if (Math.abs(x.midi - midi) < Math.abs(s.midi - midi)) s = x;
  const ctx = A.ctx;
  const src = ctx.createBufferSource();
  src.buffer = s.buf;
  src.playbackRate.value = Math.pow(2, (midi - s.midi) / 12);
  const gn = ctx.createGain();
  const v = vel * INST[inst].vol;
  gn.gain.value = v;
  if (dur) {
    gn.gain.setValueAtTime(v, t + dur);
    gn.gain.setTargetAtTime(0, t + dur, 0.12);
  }
  src.connect(gn); gn.connect(dest);
  const params = [];
  if (src.detune) { A.bus.wow.connect(src.detune); params.push(src.detune); }
  track([src, gn], src, params);
  src.start(t);
  if (dur) src.stop(t + dur + 0.8);
}
function drum(k, t, vel) {
  const b = drums[k];
  if (!b) return;
  if (MU.trace) MU.trace.push([t, 'drum', k, vel]);
  const ctx = A.ctx;
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.playbackRate.value = 1 + (rnd() - 0.5) * 0.04;
  const gn = ctx.createGain();
  gn.gain.value = vel;
  src.connect(gn); gn.connect(N.drums);
  track([src, gn], src, []);
  src.start(t);
}
/** Real-time pad voice: two detuned oscillators with a slow swell. */
function padNote(midi, t, dur, vel, att, rel) {
  const ctx = A.ctx, f = mtof(midi);
  if (MU.trace) MU.trace.push([t, 'pad', midi, vel]);
  const gn = ctx.createGain();
  gn.gain.setValueAtTime(0, t);
  gn.gain.linearRampToValueAtTime(vel, t + att);
  gn.gain.setValueAtTime(vel, t + Math.max(att, dur));
  gn.gain.setTargetAtTime(0, t + Math.max(att, dur), rel / 3.5);
  const nodes = [gn], params = [];
  for (const det of [-7, 6]) {
    const o = ctx.createOscillator();
    o.setPeriodicWave(N.wave);
    o.frequency.value = f;
    o.detune.value = det + (rnd() - 0.5) * 3;
    o.connect(gn);
    A.bus.wow.connect(o.detune);
    params.push(o.detune);
    o.start(t);
    o.stop(t + Math.max(att, dur) + rel + 0.1);
    nodes.push(o);
  }
  gn.connect(N.pad);
  track(nodes, nodes[1], params);
}
function bassNote(midi, t, dur, vel) {
  const ctx = A.ctx, f = mtof(midi);
  if (MU.trace) MU.trace.push([t, 'bass', midi, vel]);
  const gn = ctx.createGain();
  gn.gain.setValueAtTime(0, t);
  gn.gain.linearRampToValueAtTime(vel, t + 0.012);
  gn.gain.setTargetAtTime(vel * 0.62, t + 0.02, 0.25);
  gn.gain.setTargetAtTime(0, t + dur, 0.07);
  const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g2 = ctx.createGain();
  o.frequency.value = f; o2.type = 'triangle'; o2.frequency.value = f * 2; g2.gain.value = 0.16;
  o.connect(gn); o2.connect(g2); g2.connect(gn); gn.connect(N.bass);
  o.start(t); o2.start(t);
  o.stop(t + dur + 0.5); o2.stop(t + dur + 0.5);
  track([o, o2, g2, gn], o, []);
}
let droneNodes = null;
function droneOn(t) {
  if (droneNodes || !MU.chord) return;
  const ctx = A.ctx;
  const root = 36 + ((MU.key + MU.chord[0]) % 12);
  droneNodes = [];
  for (const [m, v] of [[root + 12, 0.16], [root + 19, 0.1], [root + 26, 0.06], [root + 31, 0.035]]) {
    for (const det of [-5, 5]) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(N.wave);
      o.frequency.value = mtof(m);
      o.detune.value = det;
      const gn = ctx.createGain();
      gn.gain.value = v;
      o.connect(gn); gn.connect(N.drone);
      o.start(t);
      droneNodes.push(o, gn);
    }
  }
  A.stats.live += droneNodes.length;
  N.drone.gain.cancelScheduledValues(t);
  N.drone.gain.setValueAtTime(N.drone.gain.value, t);
  N.drone.gain.setTargetAtTime(0.55, t, 1.4);
}
function droneOff(t) {
  if (!droneNodes) return;
  const nodes = droneNodes;
  droneNodes = null;
  N.drone.gain.cancelScheduledValues(t);
  N.drone.gain.setTargetAtTime(0, t, 0.7);
  for (const n of nodes) if (n.stop) n.stop(t + 3.5);
  nodes[0].onended = () => {
    for (const n of nodes) try { n.disconnect(); } catch (e) { /* ignore */ }
    A.stats.live -= nodes.length;
  };
}

/* ------------------------------------------------------------------ */
/* Mood + section planning                                              */
/* ------------------------------------------------------------------ */
const mood = { night: 0, dusk: 0, season: 1, rain: 0, tension: 0, growth: 0, speed: 1, paused: true };
function readMood() {
  const S = VC.state, env = VC.gfx && VC.gfx.env;
  mood.night = env ? env.night || 0 : 0;
  mood.dusk = env ? env.dusk || 0 : 0;
  mood.season = env && env.season != null ? Math.floor(env.season + 0.5) % 4 : 1;
  const w = S && S.weather;
  mood.rain = w ? Math.max(w.wet || 0, w.type === 'rain' || w.type === 'storm' ? w.intensity || 0 : 0) : 0;
  const dis = VC.disasters && VC.disasters.active ? VC.disasters.active.length : 0;
  mood.tension = dis ? 1 : S && S.money < 0 && !S.sandbox ? 0.55 : 0;
  mood.growth = S ? M.clamp((S.milestone || 0) / 7, 0, 1) : 0;
  mood.speed = S ? S.time.speed : 0;
  mood.paused = !S || !VC.running || !S.time.speed;
  return mood;
}
function instFor(m) {
  if (m.tension > 0.6) return { keys: 'epiano', lead: 'celesta' };
  if (m.night > 0.55) return pick([{ keys: 'epiano', lead: 'celesta' }, { keys: 'epiano', lead: 'kalimba' }, { keys: 'pluck', lead: 'celesta' }]);
  const bySeason = [
    [{ keys: 'pluck', lead: 'kalimba' }, { keys: 'kalimba', lead: 'marimba' }, { keys: 'epiano', lead: 'kalimba' }], // spring
    [{ keys: 'marimba', lead: 'pluck' }, { keys: 'pluck', lead: 'marimba' }, { keys: 'epiano', lead: 'marimba' }], // summer
    [{ keys: 'epiano', lead: 'pluck' }, { keys: 'pluck', lead: 'epiano' }, { keys: 'epiano', lead: 'kalimba' }], // autumn
    [{ keys: 'epiano', lead: 'celesta' }, { keys: 'celesta', lead: 'epiano' }, { keys: 'pluck', lead: 'celesta' }], // winter
  ];
  return pick(bySeason[m.season] || bySeason[1]);
}
const ARPS = ['up8', 'broken', 'sparse', 'pedal', 'updown', 'pairs'];
function planSection() {
  const m = readMood();
  const prev = MU.sec;
  MU.sections++;
  MU.stats.sections++;
  const breather = MU.sections > 2 && MU.sections % 5 === 0 && m.tension < 0.5;
  const poolKey = m.tension > 0.6 ? 'tension' : m.night > 0.55 || (m.dusk > 0.5 && chance(0.5)) ? 'night' : 'day';
  const pool = PROGS[poolKey];
  let prog = pick(pool);
  for (let k = 0; k < 4 && prev && prog === prev.prog; k++) prog = pick(pool);
  // key: stay, or move by a 4th / 5th / whole step (kept in a comfortable register)
  if (!prev) MU.key = pick([0, 2, 3, 5, 7, 9, 10]);
  else if (chance(0.55)) MU.key = (MU.key + pick([5, 7, 2, 10])) % 12;
  const energy = M.clamp(0.35 + 0.35 * m.growth + 0.25 * (1 - m.night) + (m.speed - 1) * 0.07 - m.rain * 0.2, 0.2, 1);
  const day = m.night < 0.4 && m.tension < 0.6;
  const inst = instFor(m);
  const sec = {
    prog, pool: poolKey, breather,
    bars: breather ? 8 : pick([16, 16, 24, 32]),
    perChord: prog.slow || (m.night > 0.7 && chance(0.5)) ? 2 : 1,
    bpm: Math.round(M.clamp(M.lerp(90, 70, m.night) + (m.speed - 1) * 3 + m.tension * 6 + (rnd() - 0.5) * 5, 64, 98)),
    keys: inst.keys, lead: inst.lead,
    arp: pick(ARPS),
    bass: m.tension > 0.6 ? 'pulse' : m.night > 0.6 ? pick(['whole', 'whole', 'lofi']) : pick(['lofi', 'lofi', 'pulse', 'walk']),
    drums: breather ? 'none' : m.tension > 0.6 ? 'pulse' : day && m.rain < 0.6 ? pick(['lofi', 'lofi', 'soft']) : chance(0.35) ? 'shaker' : 'none',
    density: energy * (breather ? 0.5 : 1),
    swing: day ? 0.1 + rnd() * 0.08 : 0.06,
    lofi: day && chance(0.5),
    bright: M.lerp(8200, 2600, m.night) * (1 - m.rain * 0.35) * (m.tension > 0.6 ? 0.75 : 1),
    minor: !!prog.minor,
    motif: null,
  };
  sec.motif = makeMotif(sec);
  MU.sec = sec;
  MU.secBar = 0;
  MU.bpm = sec.bpm;
  ensureInst(sec.keys);
  ensureInst(sec.lead);
  ensureDrums();
  const ctx = A.ctx, t = ctx.currentTime;
  const stepDur = 60 / MU.bpm / 4;
  N.dl.delayTime.setTargetAtTime(stepDur * 3, t, 0.2);
  N.dr.delayTime.setTargetAtTime(stepDur * 3, t, 0.2);
  N.vinylG.gain.setTargetAtTime(sec.lofi ? 0.05 : 0, t, 2);
  N.drumLP.frequency.setTargetAtTime(sec.lofi ? 6500 : 10000, t, 1);
}
/** A 2-bar motif: rhythm on a 32-step grid + a scale-degree walk. */
function makeMotif(sec) {
  const grid = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28];
  const strong = { 0: 3, 4: 2, 8: 2.5, 12: 1.5, 16: 3, 20: 1.5, 24: 2, 28: 1 };
  const count = 3 + Math.floor(rnd() * 4);
  const steps = [];
  while (steps.length < count) {
    const s = pick(grid);
    if (steps.includes(s)) continue;
    if (rnd() * 3 < (strong[s] || 0.6)) steps.push(s);
  }
  steps.sort((a, b) => a - b);
  let deg = pick([0, 2, 4]);
  return steps.map((s, i) => {
    if (i) deg += pick([-2, -1, -1, 1, 1, 2, 0]);
    deg = M.clamp(deg, -2, 8);
    const next = steps[i + 1] == null ? 32 : steps[i + 1];
    return { s, deg, len: Math.min(8, next - s) };
  });
}

/* ------------------------------------------------------------------ */
/* Harmony helpers                                                      */
/* ------------------------------------------------------------------ */
function voiceChord(rootPc, qual, prev) {
  const iv = QUAL[qual] || QUAL.maj7;
  // one tone per pitch class (sus2 / add9 contain both 2 and 14), guide tones first
  const tones = [];
  for (const x of iv.slice().sort((a, b) => (PRIO[a] == null ? 4 : PRIO[a]) - (PRIO[b] == null ? 4 : PRIO[b]))) {
    if (tones.length < 4 && !tones.some((y) => y % 12 === x % 12)) tones.push(x);
  }
  const center = prev ? prev.reduce((s, x) => s + x, 0) / prev.length : 63;
  let notes = tones.map((ivl) => {
    const pc = (rootPc + ivl) % 12;
    let m = pc + 12 * Math.round((center - pc) / 12);
    while (m < 52) m += 12;
    while (m > 76) m -= 12;
    return m;
  });
  notes.sort((a, b) => a - b);
  for (let i = 1; i < notes.length; i++) {
    if (notes[i] - notes[i - 1] < 2) {
      if (notes[i] + 12 <= 79) notes[i] += 12;
      else notes[i - 1] -= 12;
      notes.sort((a, b) => a - b);
    }
  }
  return notes;
}
/** True if midi m is not a chord tone but sits a semitone away from one (clashes with the pad). */
function avoidNote(m) {
  const ch = MU.chord;
  if (!ch) return false;
  const root = (MU.key + ch[0]) % 12, pc = ((m % 12) - root + 12) % 12;
  const iv = QUAL[ch[1]] || QUAL.maj7;
  let tone = false, near = false;
  for (const x of iv) {
    const c = x % 12;
    if (c === pc) tone = true;
    else if ((c - pc + 12) % 12 === 1 || (pc - c + 12) % 12 === 1) near = true;
  }
  return !tone && near;
}
function scaleNotes(sec, lo, hi) {
  const sc = sec.minor ? PENT_MIN : PENT_MAJ;
  const out = [];
  for (let m = lo; m <= hi; m++) if (sc.includes((m - MU.key + 120) % 12)) out.push(m);
  return out;
}

/* ------------------------------------------------------------------ */
/* Sequencer                                                            */
/* ------------------------------------------------------------------ */
function onBar(t) {
  const sec = MU.sec;
  const bars = sec.bars;
  const ci = Math.floor(MU.secBar / sec.perChord) % sec.prog.ch.length;
  const ch = sec.prog.ch[ci];
  const barDur = (60 / MU.bpm) * 4;
  MU.chord = ch;
  MU.stats.bars++;
  if (MU.trace) MU.trace.push([t, 'bar', MU.secBar, (MU.key + ch[0]) % 12, ch[1], sec.pool, sec.keys, sec.lead, sec.arp, sec.bass, sec.drums, MU.bpm]);
  const rootPc = (MU.key + ch[0]) % 12;
  if (MU.secBar % sec.perChord === 0) {
    MU.prevVoicing = MU.voicing;
    MU.voicing = voiceChord(rootPc, ch[1], MU.prevVoicing);
    const soft = mood.night > 0.5 ? 1 : 0;
    const dur = barDur * sec.perChord;
    for (const m of MU.voicing) padNote(m, t + rnd() * 0.03, dur + 0.15, 0.036 + rnd() * 0.008, M.lerp(0.5, 1.6, soft) + rnd() * 0.3, M.lerp(1.4, 2.8, soft));
  }
  // mood-driven brightness, eased each bar
  N.padLP.frequency.setTargetAtTime(sec.bright * 0.34 + 500, t, 1.5);
  A.bus.musicTone.frequency.setTargetAtTime(Math.max(2600, sec.bright * 1.25), t, 2);
  // arrangement arc: layers enter and leave over the section
  const b = MU.secBar;
  sec.bassOn = b >= (MU.sections > 1 ? 0 : 2) && b < bars - 1 && !sec.breather;
  sec.arpOn = b >= 2 && b < bars - 1;
  sec.drumsOn = sec.drums !== 'none' && b >= 4 && b < bars - 2;
  // lead: every other 4-bar phrase in the body of a section; throughout a breather interlude
  sec.leadOn = sec.breather ? b >= 2 && b < bars - 2 : b >= 8 && b < bars - 4 && Math.floor(b / 4) % 2 === 0;
  sec.arc = Math.sqrt(Math.sin((Math.PI * (b + 0.5)) / bars));
}
function bassStep(step, t, stepDur) {
  const sec = MU.sec, ch = MU.chord;
  if (!sec.bassOn || !ch) return;
  let root = 36 + ((MU.key + ch[0]) % 12);
  if (root > 45) root -= 12;
  const beat = stepDur * 4;
  const nextCh = sec.prog.ch[(Math.floor((MU.secBar + 1) / sec.perChord)) % sec.prog.ch.length];
  const iv = QUAL[ch[1]] || QUAL.maj7;
  const fifth = iv.includes(7) ? 7 : 5;
  const v = 0.2 + rnd() * 0.03;
  switch (sec.bass) {
    case 'whole':
      if (step === 0 && MU.secBar % sec.perChord === 0) bassNote(root, t, beat * 4 * sec.perChord * 0.95, v);
      break;
    case 'pulse':
      if (step === 0 || step === 8) bassNote(root, t, beat * 1.6, v);
      if (mood.tension > 0.6 && (step === 3 || step === 11)) bassNote(root, t, beat * 0.4, v * 0.6);
      break;
    case 'walk': {
      if (step % 4) break;
      const q = step / 4;
      let m = root;
      // beat 2: the chord's 3rd (or its suspension: never a clashing 3rd over a sus chord)
      if (q === 1) m = root + (iv.includes(4) ? 4 : iv.includes(3) ? 3 : iv.includes(5) ? 5 : 2);
      else if (q === 2) m = root + fifth;
      else if (q === 3) { const nr = 36 + ((MU.key + nextCh[0]) % 12); m = (nr > 45 ? nr - 12 : nr) + (chance(0.5) ? -1 : 2); }
      bassNote(m, t, beat * 0.85, v * (q ? 0.8 : 1));
      break;
    }
    default: // lofi
      if (step === 0) bassNote(root, t, beat * 2.4, v);
      else if (step === 10) bassNote(chance(0.6) ? root : root + fifth, t, beat * 1.1, v * 0.8);
      else if (step === 14 && chance(0.4)) {
        const nr = 36 + ((MU.key + nextCh[0]) % 12);
        bassNote((nr > 45 ? nr - 12 : nr) + (chance(0.5) ? -1 : 1), t, beat * 0.4, v * 0.6);
      }
  }
}
const PAT = {
  lofi: { kick: { 0: 0.9, 10: 0.7 }, brush: { 4: 0.75, 12: 0.8 }, hatEvery: 2 },
  soft: { kick: { 0: 0.7, 8: 0.55 }, rim: { 12: 0.45 }, shaker: true },
  pulse: { kick: { 0: 0.9, 3: 0.45, 8: 0.8, 11: 0.4 }, hatEvery: 4 },
  shaker: { shaker: true, rim: { 12: 0.25 } },
};
function drumStep(step, t) {
  const sec = MU.sec;
  if (!sec.drumsOn) return;
  const p = PAT[sec.drums];
  if (!p) return;
  const k = 0.75 + 0.25 * sec.arc;
  const hv = (x) => x * k * (0.85 + rnd() * 0.3);
  if (p.kick && p.kick[step]) drum('kick', t, hv(p.kick[step]) * 0.55);
  if (p.kick === PAT.lofi.kick && step === 7 && chance(0.25)) drum('kick', t, hv(0.3) * 0.55);
  if (p.brush && p.brush[step]) drum('brush', t, hv(p.brush[step]) * 0.3);
  if (p.rim && p.rim[step] && chance(0.7)) drum('rim', t, hv(p.rim[step]) * 0.22);
  if (p.hatEvery && step % p.hatEvery === 0) drum(step % 4 === 2 && chance(0.12) ? 'ohat' : 'hat', t, hv(step % 4 === 0 ? 0.55 : 0.35) * 0.16 * (0.6 + sec.density * 0.5));
  if (p.hatEvery === 2 && step % 2 && chance(sec.density * 0.18)) drum('hat', t, hv(0.2) * 0.12);
  if (p.shaker && (sec.drums === 'shaker' ? step % 2 === 0 : true)) drum('shaker', t, hv(step % 4 === 0 ? 0.5 : 0.3) * (sec.drums === 'shaker' ? 0.07 : 0.1));
  if (MU.secBar === sec.bars - 3 && step >= 13 && p.brush && chance(0.5)) drum('brush', t, hv(0.4) * 0.25);
}
function arpTones() {
  const v = MU.voicing || [60, 64, 67, 71];
  const out = [];
  for (const m of v) for (const o of [0, 12]) { const x = m + o; if (x >= 57 && x <= 88 && !out.includes(x)) out.push(x); }
  return out.sort((a, b) => a - b);
}
function arpStep(step, t, stepDur) {
  const sec = MU.sec;
  if (!sec.arpOn || !samples[sec.keys]) return;
  const tones = arpTones();
  const n = tones.length;
  const d = sec.density * (0.55 + 0.45 * sec.arc) * (mood.night > 0.6 ? 0.7 : 1);
  let idx = -1, vel = 0.5;
  switch (sec.arp) {
    case 'up8': if (step % 2 === 0 && chance(0.4 + d * 0.6)) idx = (step / 2) % n; break;
    case 'updown': if (step % 2 === 0 && chance(0.35 + d * 0.6)) { const k = (step / 2) % (2 * n - 2 || 1); idx = k < n ? k : 2 * n - 2 - k; } break;
    case 'broken': if ([0, 3, 6, 8, 11, 14].includes(step) && chance(0.45 + d * 0.5)) idx = [0, 2, 1, 3, 2, 4][[0, 3, 6, 8, 11, 14].indexOf(step)] % n; break;
    case 'pedal': if (step % 2 === 0 && chance(0.3 + d * 0.55)) idx = step % 8 === 6 && chance(0.5) ? n - 2 : n - 1; break;
    case 'pairs': if ((step === 0 || step === 6 || step === 8 || step === 14) && chance(0.5 + d * 0.4)) { idx = Math.floor(rnd() * n); vel = 0.45; } break;
    default: if (step % 2 === 0 && chance(0.1 + d * 0.4)) idx = Math.floor(rnd() * n);
  }
  if (idx < 0 || idx >= n) return;
  vel *= (step % 4 === 0 ? 1 : 0.78) * (0.85 + rnd() * 0.3);
  sampleNote(sec.keys, tones[idx], t + (rnd() - 0.5) * 0.012, vel, N.keys, null);
  if (sec.arp === 'pairs' && idx + 1 < n) sampleNote(sec.keys, tones[idx + 1], t + 0.012 + rnd() * 0.01, vel * 0.8, N.keys, null);
}
function leadStep(step, t, stepDur) {
  const sec = MU.sec;
  if (!sec.leadOn || !sec.motif || !samples[sec.lead]) return;
  const phraseBar = MU.secBar % 4;
  const s32 = (phraseBar % 2) * 16 + step;
  const answer = phraseBar >= 2;
  if (answer && MU.secBar % 8 >= 4 && chance(0.4)) return; // leave some space
  const sc = scaleNotes(sec, 64, 93);
  const base = sc.findIndex((m) => m >= 72);
  for (let i = 0; i < sec.motif.length; i++) {
    const nt = sec.motif[i];
    if (nt.s !== s32) continue;
    let deg = nt.deg + (answer && i >= sec.motif.length - 2 ? pick([-1, 1, 2]) : 0);
    let m = sc[M.clamp(base + deg, 0, sc.length - 1)];
    // strong beats snap to a chord tone; elsewhere "avoid notes" (a semitone from a chord tone) move
    // to the nearest chord tone, so the melody never rubs against the harmony
    if (MU.voicing && (step % 8 === 0 || avoidNote(m))) {
      let best = m, bd = 99;
      for (const c of MU.voicing) for (const o of [12, 24]) { const x = c + o; const dd = Math.abs(x - m); if (dd < bd && x <= 93) { bd = dd; best = x; } }
      if (bd <= 2 || avoidNote(m)) m = best;
    }
    const vel = (0.55 + rnd() * 0.2) * (i === 0 ? 1 : 0.85);
    sampleNote(sec.lead, m, t + (rnd() - 0.5) * 0.014, vel, N.lead, nt.len * stepDur * 1.6 + 0.2);
  }
}
function scheduleStep(t) {
  const stepDur = 60 / MU.bpm / 4;
  const st = MU.step;
  const sw = st & 1 ? MU.sec.swing * stepDur : 0;
  const T = t + sw;
  if (st === 0) onBar(T);
  bassStep(st, T, stepDur);
  drumStep(st, T);
  arpStep(st, T, stepDur);
  leadStep(st, T, stepDur);
  MU.nextT += stepDur;
  if (++MU.step >= 16) {
    MU.step = 0;
    MU.bar++;
    if (++MU.secBar >= MU.sec.bars || MU.pendingNew) {
      MU.pendingNew = false;
      planSection();
    }
  }
}
function tick() {
  const ctx = A.ctx;
  if (!MU.on || !ctx || ctx.state !== 'running' || MU.mode !== 'play' || !MU.sec) return;
  const now = ctx.currentTime;
  if (MU.nextT < now - 0.25) MU.nextT = now + 0.05; // main thread stalled: skip ahead, never burst
  let guard = 0;
  while (MU.nextT < now + LOOKAHEAD && guard++ < 16) scheduleStep(MU.nextT);
}

/* ------------------------------------------------------------------ */
/* Public                                                               */
/* ------------------------------------------------------------------ */
MU.start = function () {
  if (MU.on || !A.ctx) return;
  build();
  MU.on = true;
  MU.mode = 'off';
  ensureDrums();
  const ctx = A.ctx;
  N.level.gain.setValueAtTime(0, ctx.currentTime);
  timer = setInterval(tick, 25);
  MU.update(0, 0);
};
MU.stop = function () {
  if (!MU.on) return;
  MU.on = false;
  clearInterval(timer);
  const t = A.ctx.currentTime;
  N.level.gain.setTargetAtTime(0, t, 0.3);
  droneOff(t);
  MU.mode = 'off';
};
MU.reset = function () {
  if (MU.on) MU.pendingNew = true; // new city: a fresh section at the next bar
};
MU.next = function () {
  MU.pendingNew = true;
};
MU.update = function () {
  if (!MU.on || !A.ctx) return;
  const ctx = A.ctx, t = ctx.currentTime;
  readMood();
  const want = mood.paused ? 'drone' : 'play';
  if (want !== MU.mode) {
    if (want === 'play') {
      planSection(); // coming back from pause (or the first start): begin a fresh section
      MU.step = 0;
      MU.nextT = t + 0.1;
      droneOff(t);
      N.level.gain.cancelScheduledValues(t);
      N.level.gain.setTargetAtTime(1, t, MU.mode === 'off' ? 2.5 : 0.8);
    } else {
      if (!MU.sec) planSection();
      if (!MU.chord) MU.chord = MU.sec.prog.ch[0];
      droneOn(t + 0.05);
      N.level.gain.cancelScheduledValues(t);
      N.level.gain.setTargetAtTime(0.8, t, 1.2);
    }
    MU.mode = want;
  }
  // a disaster starts mid-section: wrap up within two bars and switch to the tension palette
  if (MU.mode === 'play' && MU.sec && mood.tension > 0.6 && MU.sec.pool !== 'tension' && MU.sec.bars - MU.secBar > 2) MU.sec.bars = MU.secBar + 2;
  tick();
};
MU.info = function () {
  const s = MU.sec;
  return s ? { mode: MU.mode, key: MU.key, bpm: MU.bpm, bar: MU.secBar, bars: s.bars, pool: s.pool, keys: s.keys, lead: s.lead, arp: s.arp, bass: s.bass, drums: s.drums, breather: s.breather, ready: { keys: !!samples[s.keys], lead: !!samples[s.lead], drums: !!drums.kick } } : { mode: MU.mode };
};
