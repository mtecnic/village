/*
 * VOXELPOLIS — sound effect recipes (VC.audio.RECIPES + VC.audio.ALIAS).
 *
 * Every effect is synthesized offline with VC.audio.dsp into an AudioBuffer (a few variants each, cached)
 * and played with a small random pitch spread, so repeated actions never sound machine-gunned.
 * Recipe fields:
 *   render(D, rnd, variant) -> Float32Array | [L, R]
 *   vol    base gain            group/win  duplicate-suppression group + min re-trigger ms
 *   wet    reverb send          variants   number of rendered variants      pitch  random rate spread
 *   prio   0 ui .. 3 critical   max        max simultaneous voices          duck   music duck amount
 *   pos    false = never positional (UI / global events)
 * Sound names: see the ALIAS table at the end for accepted synonyms (money/coin -> cash, fanfare ->
 * milestone, level_up -> levelup, monster -> roar, earthquake -> rumble, …).
 */
const A = VC.audio;
const R = A.RECIPES;
const TAU = Math.PI * 2;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/* ---------------- shared building blocks ---------------- */
/** Soft bell / chime partials. */
function chime(D, out, t, midi, amp, dur = 0.8, bright = 1) {
  D.modal(out, t, dur, mtof(midi), [[1, 1, 0.42 * dur], [2.0, 0.28 * bright, 0.18 * dur], [3.01, 0.12 * bright, 0.09 * dur], [4.16, 0.06 * bright, 0.05 * dur]], amp, { a: 0.002 });
}
/** Mallet (marimba-like) note. */
function mallet(D, out, t, midi, amp, dur = 0.6) {
  const f = mtof(midi);
  D.modal(out, t, dur, f, [[1, 1, 0.22 * dur], [3.93, 0.3, 0.06 * dur], [9.4, 0.08, 0.02]], amp, { a: 0.001 });
  D.noise(out, t, 0.012, amp * 0.15, { f: 'lp', f0: 3000, d: 0.004 });
}
/** Low punchy thud with a pitch drop. */
function thud(D, out, t, f0, f1, amp, dec) {
  D.tone(out, t, dec * 7, f0, f1, amp, { a: 0.0015, d: dec });
}
/** Band-passed noise sweep with a bell-shaped envelope. */
function whoosh(D, out, t, dur, f0, f1, amp, q = 1.1, color = 'pink', rnd) {
  D.noise(out, t, dur, amp, { color, f: 'bp', f0, f1, q, a: 0.001, rnd, env: (x) => Math.sin(Math.PI * Math.min(1, x * 1.15)) ** 1.5 });
}
/** Falling debris: dense crackle thinning out. */
function debris(D, out, t, dur, amp, rnd, f = 2200) {
  D.crackle(out, t, dur, 260, amp, { f, q: 0.9, len: 0.004, rnd, env: (x) => (1 - x) ** 2 });
  D.crackle(out, t, dur * 0.8, 70, amp * 0.8, { f: 700, q: 0.8, len: 0.01, rnd, env: (x) => (1 - x) ** 1.5 });
}
function fin(D, b, peak = 0.9) {
  D.fade(D.normalize(b, peak), 0.001, 0.02);
  return b;
}

/* ================================================================== */
/* UI                                                                   */
/* ================================================================== */
R.click = {
  vol: 0.32, group: 'click', win: 35, variants: 3, pitch: 0.06, prio: 0, pos: false,
  render(D, r) {
    const b = D.buf(0.05);
    D.modal(b, 0, 0.05, 1750 + r() * 250, [[1, 1, 0.007], [2.37, 0.45, 0.004]], 1);
    D.noise(b, 0, 0.006, 0.5, { f: 'hp', f0: 3500, d: 0.0015, rnd: r });
    return fin(D, b);
  },
};
R.hover = {
  vol: 0.06, group: 'hover', win: 45, variants: 2, pitch: 0.08, prio: 0, pos: false,
  render(D, r) {
    const b = D.buf(0.035);
    D.tone(b, 0, 0.035, 2500 + r() * 300, 2300, 1, { a: 0.002, d: 0.008 });
    return fin(D, b);
  },
};
R.tick = {
  vol: 0.28, group: 'click', win: 40, variants: 1, prio: 0, pos: false,
  render(D) {
    const b = D.buf(0.12);
    D.modal(b, 0, 0.05, 1500, [[1, 1, 0.008], [2.4, 0.4, 0.004]], 1);
    D.modal(b, 0.055, 0.05, 2000, [[1, 1, 0.008], [2.4, 0.4, 0.004]], 0.9);
    return fin(D, b);
  },
};
R.pause = {
  vol: 0.26, group: 'click', win: 40, variants: 1, prio: 0, pos: false,
  render(D) {
    const b = D.buf(0.3);
    D.tone(b, 0, 0.12, 880, 870, 0.8, { a: 0.003, d: 0.05 });
    D.tone(b, 0.09, 0.2, 659, 650, 0.8, { a: 0.003, d: 0.07 });
    return fin(D, b);
  },
};
R.open = {
  vol: 0.26, group: 'open', win: 120, variants: 2, prio: 0, pos: false, wet: 0.1,
  render(D, r) {
    const b = D.buf(0.26);
    whoosh(D, b, 0, 0.22, 500, 2800, 1, 1.3, 'pink', r);
    D.tone(b, 0.01, 0.2, 520, 800, 0.25, { a: 0.02, d: 0.08 });
    D.modal(b, 0, 0.03, 2200, [[1, 1, 0.006]], 0.3);
    return fin(D, b);
  },
};
R.close = {
  vol: 0.22, group: 'close', win: 120, variants: 2, prio: 0, pos: false, wet: 0.1,
  render(D, r) {
    const b = D.buf(0.24);
    whoosh(D, b, 0, 0.2, 2600, 450, 1, 1.3, 'pink', r);
    D.tone(b, 0.01, 0.18, 760, 480, 0.22, { a: 0.01, d: 0.06 });
    return fin(D, b);
  },
};
R.whoosh = {
  vol: 0.34, group: 'whoosh', win: 200, variants: 2, prio: 1, pos: false, wet: 0.25,
  render(D, r) {
    const b = D.buf(0.75);
    whoosh(D, b, 0, 0.7, 250, 3200, 1, 0.9, 'pink', r);
    whoosh(D, b, 0.05, 0.6, 4000, 900, 0.35, 2, 'white', r);
    return fin(D, b);
  },
};
R.error = {
  vol: 0.28, group: 'error', win: 250, variants: 1, prio: 1, pos: false,
  render(D) {
    const b = D.buf(0.26);
    D.tone(b, 0, 0.1, 196, 196, 0.6, { type: 'sqr', a: 0.004, d: 0.08 });
    D.tone(b, 0.11, 0.13, 164.8, 164.8, 0.6, { type: 'sqr', a: 0.004, d: 0.09 });
    D.filter(b, 'lp', 1300, 0.7);
    return fin(D, b, 0.8);
  },
};
R.success = {
  vol: 0.3, group: 'notify', win: 400, variants: 1, prio: 1, pos: false, wet: 0.25,
  render(D) {
    const b = D.buf(0.8);
    chime(D, b, 0, 76, 0.7, 0.6);
    chime(D, b, 0.09, 83, 0.8, 0.7);
    return fin(D, b);
  },
};
R.notify = {
  vol: 0.28, group: 'notify', win: 400, variants: 2, prio: 1, pos: false, wet: 0.3,
  render(D, r, v) {
    const b = D.buf(1.0);
    const m = v ? 84 : 81;
    D.fm(b, 0, 1.0, mtof(m), 3.5, 1.2, 0.05, 0.35, { a: 0.002, d: 0.3, id: 0.08 });
    chime(D, b, 0, m, 0.7, 0.9);
    return fin(D, b);
  },
};
R.advisor = {
  vol: 0.32, group: 'notify', win: 400, variants: 1, prio: 1, pos: false, wet: 0.25,
  render(D) {
    const b = D.buf(0.9);
    mallet(D, b, 0, 79, 0.9, 0.7);
    mallet(D, b, 0.13, 84, 1, 0.8);
    return fin(D, b);
  },
};
R.alert = {
  vol: 0.34, group: 'notify', win: 400, variants: 1, prio: 2, pos: false, wet: 0.2,
  render(D) {
    const b = D.buf(0.8);
    for (const [t, m] of [[0, 88], [0.11, 83], [0.3, 88], [0.41, 83]]) {
      D.fm(b, t, 0.3, mtof(m), 2, 0.8, 0.1, 0.5, { a: 0.002, d: 0.08, id: 0.05 });
    }
    return fin(D, b);
  },
};
R.alarm = {
  vol: 0.3, group: 'alarm', win: 3000, variants: 1, prio: 3, pos: false, duck: 0.35, wet: 0.2,
  render(D) {
    const b = D.buf(1.05);
    for (let k = 0; k < 3; k++) {
      D.tone(b, k * 0.32, 0.15, 880, 880, 0.5, { type: 'sqr', a: 0.006, hold: 0.1, d: 0.03 });
      D.tone(b, k * 0.32 + 0.16, 0.15, 659, 659, 0.5, { type: 'sqr', a: 0.006, hold: 0.1, d: 0.03 });
    }
    D.filter(b, 'lp', 2400, 0.8);
    return fin(D, b, 0.85);
  },
};
R.camera = {
  vol: 0.38, group: 'camera', win: 200, variants: 1, prio: 1, pos: false,
  render(D, r) {
    const b = D.buf(0.2);
    for (const t of [0, 0.075]) {
      D.noise(b, t, 0.012, 0.8, { f: 'hp', f0: 2500, d: 0.003, rnd: r });
      D.modal(b, t, 0.04, 1250, [[1, 1, 0.01], [2.6, 0.5, 0.006]], 0.5);
    }
    D.noise(b, 0.01, 0.07, 0.15, { f: 'bp', f0: 2000, q: 3, rnd: r });
    return fin(D, b);
  },
};
R.policy = {
  vol: 0.46, group: 'policy', win: 200, variants: 2, prio: 1, pos: false, wet: 0.1,
  render(D, r) {
    const b = D.buf(0.3);
    thud(D, b, 0, 150, 70, 1, 0.045);
    D.noise(b, 0, 0.08, 0.6, { f: 'lp', f0: 1400, d: 0.025, rnd: r });
    D.modal(b, 0.002, 0.1, 420, [[1, 1, 0.03], [2.7, 0.4, 0.015]], 0.35);
    return fin(D, b);
  },
};
R.cash = {
  vol: 0.34, group: 'money', win: 250, variants: 2, prio: 1, pos: false, wet: 0.25,
  render(D, r) {
    const b = D.buf(0.9);
    D.noise(b, 0, 0.05, 0.5, { f: 'bp', f0: 2500, q: 0.8, d: 0.012, rnd: r });
    D.modal(b, 0, 0.06, 900, [[1, 1, 0.015], [2.3, 0.6, 0.01]], 0.4);
    for (const [t, m] of [[0.06, 93], [0.15, 100]]) {
      D.fm(b, t, 0.7, mtof(m), 1.41, 2.2, 0.2, 0.5, { a: 0.001, d: 0.2, id: 0.05 });
    }
    D.crackle(b, 0.12, 0.4, 120, 0.12, { f: 7000, q: 1, rnd: r, env: (x) => 1 - x });
    return fin(D, b);
  },
};
R.milestone = {
  vol: 0.5, group: 'milestone', win: 4000, variants: 1, pitch: 0, prio: 3, pos: false, duck: 0.65, wet: 0.35,
  render(D) {
    return D.stereo(2.8, 77, (b, r, ch) => {
      // brassy saw stack through an opening filter: C E G -> sustained C major swell
      const brass = (t, m, dur, amp) => {
        const tmp = D.buf(dur + 0.3);
        D.tone(tmp, 0, dur, mtof(m), mtof(m), amp, { type: 'saw', a: 0.03, hold: dur * 0.6, d: 0.25, vib: [5.2, 0.004] });
        D.tone(tmp, 0, dur, mtof(m) * 1.003, mtof(m) * 1.003, amp * 0.6, { type: 'saw', a: 0.04, hold: dur * 0.6, d: 0.25 });
        const bq = new D.Biquad('lp', 600, 0.9);
        for (let i = 0; i < tmp.length; i++) {
          if ((i & 31) === 0) bq.set('lp', 500 + 3200 * Math.min(1, i / (0.12 * D.sr)) * Math.exp(-i / (1.2 * D.sr)), 0.9);
          tmp[i] = bq.run(tmp[i]);
        }
        D.mix(b, tmp, t);
      };
      brass(0, 60, 0.16, 0.5); brass(0.12, 64, 0.16, 0.5); brass(0.24, 67, 0.16, 0.5);
      const chord = ch ? [64, 72, 79] : [60, 67, 76];
      for (const m of chord) brass(0.4, m, 1.9, 0.38);
      thud(D, b, 0.4, 110, 55, 0.6, 0.12); // soft timpani
      for (let k = 0; k < 6; k++) chime(D, b, 0.45 + k * 0.09 + r() * 0.02, [84, 88, 91, 96, 91, 100][k] + (ch ? 0 : -12 * (k & 1)), 0.18, 1.2);
    }).map((c) => fin(D, c, 0.85));
  },
};
R.achievement = {
  vol: 0.38, group: 'achievement', win: 1500, variants: 1, pitch: 0, prio: 3, pos: false, duck: 0.3, wet: 0.45,
  render(D) {
    const pent = [0, 2, 4, 7, 9];
    return D.stereo(1.6, 31, (b, r, ch) => {
      for (let k = 0; k < 12; k++) {
        const m = 84 + pent[k % 5] + 12 * Math.floor(k / 5);
        const g = r() < 0.5 === !!ch ? 0.5 : 0.2;
        D.fm(b, k * 0.045, 0.9, mtof(m), 2.0, 0.6, 0.05, g, { a: 0.001, d: 0.25, id: 0.1 });
      }
      D.noise(b, 0, 1.4, 0.05, { f: 'hp', f0: 7000, a: 0.2, d: 0.4, rnd: r });
    }).map((c) => fin(D, c, 0.85));
  },
};
R.levelup = {
  vol: 0.26, group: 'levelup', win: 250, variants: 2, prio: 1, max: 3, wet: 0.2,
  render(D, r, v) {
    const b = D.buf(0.7);
    const base = v ? 74 : 79;
    [0, 4, 7].forEach((iv, k) => D.ks(b, k * 0.07, 0.55, mtof(base + iv), 0.7, { damp: 0.993, bright: 0.7, rnd: r }));
    return fin(D, b);
  },
};

/* ================================================================== */
/* Building / tools                                                     */
/* ================================================================== */
R.build = {
  vol: 0.6, group: 'build', win: 70, variants: 3, prio: 2, wet: 0.15,
  render(D, r) {
    const b = D.buf(0.55);
    thud(D, b, 0, 115 + r() * 20, 50, 1, 0.07); // satisfying low thunk
    D.modal(b, 0, 0.25, 170 + r() * 40, [[1, 1, 0.07], [2.31, 0.55, 0.04], [4.2, 0.25, 0.02], [6.7, 0.1, 0.01]], 0.55); // wood/concrete body
    D.noise(b, 0, 0.05, 0.55, { f: 'lp', f0: 2600, d: 0.018, rnd: r }); // contact
    D.crackle(b, 0.045, 0.3, 55, 0.35, { f: 3200 + r() * 1000, q: 2.2, len: 0.003, rnd: r, env: (x) => (1 - x) ** 2 }); // small rattle
    D.modal(b, 0.08 + r() * 0.05, 0.08, 900 + r() * 600, [[1, 1, 0.015], [2.7, 0.5, 0.008]], 0.18);
    return fin(D, b);
  },
};
R.road = {
  vol: 0.42, group: 'road', win: 80, variants: 3, prio: 1, wet: 0.08,
  render(D, r) {
    const b = D.buf(0.4);
    D.noise(b, 0, 0.3, 0.7, { color: 'pink', f: 'bp', f0: 3400, f1: 700, q: 0.8, a: 0.012, d: 0.09, rnd: r }); // asphalt swish
    thud(D, b, 0.045, 95, 55, 0.7, 0.045);
    D.crackle(b, 0.04, 0.2, 90, 0.2, { f: 1800, q: 1, rnd: r, env: (x) => 1 - x }); // gravel
    return fin(D, b);
  },
};
R.zone = {
  vol: 0.2, group: 'zone', win: 90, variants: 2, prio: 1, wet: 0.3,
  render(D, r, v) {
    const b = D.buf(0.8);
    const m = v ? 84 : 72;
    chime(D, b, 0, m, 0.8, 0.7, 0.6);
    chime(D, b, 0.035, m + 7, 0.35, 0.6, 0.4);
    return fin(D, b);
  },
};
R.dezone = {
  vol: 0.18, group: 'zone', win: 90, variants: 1, prio: 1, wet: 0.25,
  render(D) {
    const b = D.buf(0.6);
    chime(D, b, 0, 79, 0.7, 0.4, 0.5);
    chime(D, b, 0.07, 72, 0.6, 0.45, 0.5);
    return fin(D, b);
  },
};
R.bulldoze = {
  vol: 0.55, group: 'bulldoze', win: 100, variants: 3, prio: 2, wet: 0.12,
  render(D, r) {
    const b = D.buf(0.55);
    D.crackle(b, 0, 0.4, 420, 0.8, { f: 1600 + r() * 600, q: 0.7, len: 0.003, rnd: r, env: (x) => (1 - x) ** 1.2 }); // crunch
    D.noise(b, 0, 0.35, 0.45, { color: 'brown', f: 'lp', f0: 500, a: 0.005, d: 0.1, rnd: r });
    thud(D, b, 0.01, 85, 40, 0.8, 0.08);
    return fin(D, b);
  },
};
R.demolish = {
  vol: 0.68, group: 'bulldoze', win: 150, variants: 2, prio: 2, duck: 0.15, wet: 0.2,
  render(D, r) {
    const b = D.buf(1.4);
    thud(D, b, 0, 75, 30, 1, 0.18);
    debris(D, b, 0.03, 1.2, 0.7, r);
    D.noise(b, 0.02, 1.2, 0.35, { color: 'brown', f: 'lp', f0: 700, f1: 200, a: 0.02, d: 0.35, rnd: r }); // dust rumble
    return fin(D, b);
  },
};
R.collapse = {
  vol: 0.66, group: 'crash', win: 220, variants: 2, prio: 2, wet: 0.25,
  render(D, r) {
    const b = D.buf(1.6);
    D.noise(b, 0, 0.12, 0.6, { f: 'lp', f0: 2500, d: 0.04, rnd: r });
    thud(D, b, 0.02, 65, 28, 1, 0.22);
    debris(D, b, 0.05, 1.4, 0.8, r, 1800);
    D.noise(b, 0.05, 1.4, 0.3, { color: 'brown', f: 'lp', f0: 400, a: 0.05, d: 0.4, rnd: r });
    return fin(D, b);
  },
};
R.plant = {
  vol: 0.34, group: 'plant', win: 80, variants: 3, prio: 1, wet: 0.08,
  render(D, r) {
    const b = D.buf(0.32);
    D.tone(b, 0, 0.06, 480 + r() * 120, 950, 0.8, { a: 0.001, d: 0.025 }); // pop
    D.noise(b, 0.01, 0.28, 0.5, { f: 'hp', f0: 3000, a: 0.01, rnd: r, env: (x) => (1 - x) * (0.5 + 0.5 * Math.sin(x * 60 + r() * 3)) }); // leafy rustle
    return fin(D, b);
  },
};
R.terraform = {
  vol: 0.5, group: 'terraform', win: 120, variants: 3, prio: 1, wet: 0.1,
  render(D, r) {
    const b = D.buf(0.7);
    D.noise(b, 0, 0.65, 1, { color: 'brown', f: 'lp', f0: 220, a: 0.03, d: 0.22, rnd: r });
    D.crackle(b, 0.02, 0.5, 160, 0.4, { f: 1100, q: 0.8, len: 0.006, rnd: r, env: (x) => 1 - x });
    D.tone(b, 0, 0.5, 58, 46, 0.4, { a: 0.03, d: 0.18, vib: [9, 0.05] });
    return fin(D, b);
  },
};
R.pline = {
  vol: 0.28, group: 'pline', win: 90, variants: 2, prio: 1, wet: 0.05,
  render(D, r) {
    const b = D.buf(0.32);
    D.tone(b, 0, 0.28, 110, 110, 0.5, { type: 'saw', a: 0.005, d: 0.1, vib: [50, 0.02] });
    D.tone(b, 0, 0.28, 220, 220, 0.25, { type: 'sqr', a: 0.005, d: 0.08 });
    D.crackle(b, 0, 0.2, 300, 0.4, { f: 5000, q: 1.5, rnd: r, env: (x) => 1 - x });
    D.filter(b, 'lp', 3500, 0.7);
    return fin(D, b, 0.8);
  },
};
R.splash = {
  vol: 0.5, group: 'splash', win: 150, variants: 2, prio: 1, wet: 0.2,
  render(D, r) {
    const b = D.buf(0.8);
    D.noise(b, 0, 0.5, 0.9, { f: 'bp', f0: 1800, f1: 350, q: 0.7, a: 0.004, d: 0.14, rnd: r });
    for (let k = 0; k < 7; k++) D.tone(b, 0.05 + r() * 0.5, 0.05, 500 + r() * 500, 1300 + r() * 900, 0.18, { a: 0.002, d: 0.015 }); // bubbles
    return fin(D, b);
  },
};

/* ================================================================== */
/* Events, emergencies, disasters                                       */
/* ================================================================== */
R.fire = {
  vol: 0.5, group: 'fire', win: 400, variants: 2, prio: 2, wet: 0.2,
  render(D, r) {
    const b = D.buf(1.7);
    D.noise(b, 0, 0.5, 0.8, { color: 'pink', f: 'lp', f0: 200, f1: 1400, a: 0.12, d: 0.25, rnd: r }); // fwoomp
    D.noise(b, 0.1, 1.6, 0.35, { color: 'brown', f: 'lp', f0: 500, a: 0.2, d: 0.8, rnd: r }); // roar
    D.crackle(b, 0.05, 1.6, 45, 0.9, { f: 2600, q: 1.1, len: 0.003, rnd: r, env: (x) => 1 - x * 0.7 });
    return fin(D, b);
  },
};
R.explosion = {
  vol: 0.85, group: 'explosion', win: 150, variants: 2, prio: 3, duck: 0.5, wet: 0.35,
  render(D, r, v) {
    return D.stereo(2.4, 5 + v, (b, rr) => {
      D.tone(b, 0, 1.6, 75, 26, 1, { a: 0.002, d: 0.45 }); // sub boom
      D.noise(b, 0, 1.2, 1, { color: 'brown', f: 'lp', f0: 1600, f1: 180, a: 0.001, d: 0.35, rnd: rr });
      D.noise(b, 0, 0.12, 0.7, { f: 'lp', f0: 5000, d: 0.03, rnd: rr });
      debris(D, b, 0.15, 2.1, 0.45, rr, 2500);
      D.sat(b, 1.8);
    }).map((c) => fin(D, c));
  },
};
R.siren = {
  vol: 0.3, group: 'siren', win: 1800, variants: 2, prio: 2, wet: 0.2,
  render(D, r, v) {
    const b = D.buf(2.1);
    // classic wail: pitch rises and falls, slightly squared tone through a lowpass
    const lo = v ? 600 : 680, hi = v ? 1250 : 1350;
    let ph = 0;
    for (let i = 0; i < b.length; i++) {
      const t = i / D.sr;
      const x = (t % 1.05) / 1.05;
      const f = lo + (hi - lo) * (x < 0.55 ? Math.sin((x / 0.55) * Math.PI * 0.5) : Math.cos(((x - 0.55) / 0.45) * Math.PI * 0.5));
      ph += f / D.sr;
      const s = Math.sin(ph * TAU);
      b[i] = (s + 0.35 * Math.sign(s) * s * s) * Math.min(1, t * 20) * Math.min(1, (2.1 - t) * 6);
    }
    D.filter(b, 'lp', 2800, 0.7);
    return fin(D, b, 0.8);
  },
};
R.thunder = {
  vol: 0.75, group: 'thunder', win: 1500, variants: 2, prio: 2, pos: false, duck: 0.25, wet: 0.3,
  render(D, r, v) {
    return D.stereo(4, 91 + v * 3, (b, rr) => {
      const bumps = [];
      for (let k = 0; k < 6; k++) bumps.push([k === 0 ? 0 : 0.1 + rr() * 2.3, 0.4 + rr() * 0.6]);
      const env = (x) => {
        const t = x * 4;
        let e = 0;
        for (const [t0, a] of bumps) if (t >= t0) e += a * Math.exp(-(t - t0) / 0.55);
        return Math.min(1.4, e);
      };
      if (v === 0) D.noise(b, 0, 0.08, 0.8, { f: 'hp', f0: 1200, d: 0.02, rnd: rr }); // close crack
      D.noise(b, 0, 4, 1, { color: 'brown', f: 'lp', f0: 520, f1: 140, a: 0.01, rnd: rr, env });
      D.noise(b, 0, 3.0, 0.2, { color: 'pink', f: 'lp', f0: 1500, f1: 300, a: 0.005, d: 0.6, rnd: rr });
    }).map((c) => fin(D, c));
  },
};
R.rocket = {
  vol: 0.7, group: 'rocket', win: 3000, variants: 1, prio: 3, duck: 0.4, wet: 0.35,
  render(D) {
    return D.stereo(6, 61, (b, rr) => {
      const env = (x) => Math.min(1, x * 6) * (x < 0.55 ? 1 : 1 - (x - 0.55) / 0.45);
      D.noise(b, 0, 6, 1, { color: 'pink', f: 'lp', f0: 1200, q: 0.6, rnd: rr, env });
      D.noise(b, 0, 6, 0.8, { color: 'brown', f: 'lp', f0: 160, rnd: rr, env });
      D.crackle(b, 0, 5, 140, 0.4, { f: 3000, q: 0.8, rnd: rr, env });
      D.tone(b, 0, 6, 42, 38, 0.4, { a: 0.3, env });
      D.sat(b, 1.4);
    }).map((c) => fin(D, c));
  },
};
R.ufo = {
  vol: 0.4, group: 'ufo', win: 1500, variants: 2, prio: 2, wet: 0.45,
  render(D, r, v) {
    const b = D.buf(2.4);
    let p1 = 0, p2 = 0;
    for (let i = 0; i < b.length; i++) {
      const t = i / D.sr, x = t / 2.4;
      // theremin: swooping pitch + wide vibrato, plus a ring-modulated shimmer
      const base = (v ? 380 : 440) * (1 + 1.1 * Math.sin(x * Math.PI) - 0.25 * x);
      const f = base * (1 + 0.025 * Math.sin(TAU * 6.2 * t));
      p1 += f / D.sr; p2 += (f * 1.5) / D.sr;
      const s = Math.sin(TAU * p1) + 0.25 * Math.sin(TAU * p2) * Math.sin(TAU * 31 * t);
      b[i] = s * Math.min(1, t * 6) * Math.min(1, (2.4 - t) * 3);
    }
    return fin(D, b, 0.8);
  },
};
R.abduct = {
  vol: 0.36, group: 'abduct', win: 500, variants: 1, prio: 2, wet: 0.4,
  render(D) {
    const b = D.buf(1.4);
    D.tone(b, 0, 1.3, 220, 1300, 0.7, { a: 0.1, hold: 0.9, d: 0.2, vib: [18, 0.03] });
    D.tone(b, 0, 1.3, 330, 1950, 0.2, { a: 0.1, hold: 0.9, d: 0.2 });
    D.noise(b, 0, 1.3, 0.08, { f: 'hp', f0: 6000, a: 0.3, d: 0.5 });
    return fin(D, b, 0.8);
  },
};
R.roar = {
  vol: 0.8, group: 'roar', win: 1000, variants: 2, prio: 3, duck: 0.35, wet: 0.3,
  render(D, r, v) {
    const b = D.buf(2.0);
    let ph = 0;
    const f0 = v ? 95 : 80;
    for (let i = 0; i < b.length; i++) {
      const t = i / D.sr, x = t / 2.0;
      const f = f0 * (1 + 0.35 * Math.sin(x * Math.PI) - 0.3 * x) * (1 + 0.03 * Math.sin(TAU * 7 * t));
      ph += f / D.sr;
      const saw = 2 * (ph - Math.floor(ph)) - 1;
      const growl = 0.6 + 0.4 * Math.sin(TAU * 27 * t); // throat flutter
      b[i] = saw * growl * Math.min(1, t * 5) * Math.min(1, (2.0 - t) * 2.5);
    }
    // vocal-tract formants
    const f1 = new D.Biquad('bp', 380, 2.2), f2 = new D.Biquad('bp', 1100, 3), lp = new D.Biquad('lp', 2200, 0.7);
    const nz = D.noiseGen('pink', r);
    for (let i = 0; i < b.length; i++) {
      const x = b[i] + nz() * 0.25 * Math.min(1, i / (0.3 * D.sr));
      b[i] = lp.run(f1.run(x) * 1.2 + f2.run(x) * 0.7 + x * 0.2);
    }
    D.sat(b, 2.2);
    return fin(D, b);
  },
};
R.stomp = {
  vol: 0.75, group: 'stomp', win: 200, variants: 2, prio: 2, wet: 0.2,
  render(D, r) {
    const b = D.buf(0.9);
    thud(D, b, 0, 62, 27, 1, 0.2);
    D.noise(b, 0, 0.5, 0.5, { color: 'brown', f: 'lp', f0: 300, d: 0.15, rnd: r });
    D.crackle(b, 0.03, 0.6, 120, 0.25, { f: 1500, q: 0.8, rnd: r, env: (x) => (1 - x) ** 2 });
    D.sat(b, 1.5);
    return fin(D, b);
  },
};
R.meteor = {
  vol: 0.5, group: 'meteor', win: 1500, variants: 1, prio: 2, wet: 0.25,
  render(D, r) {
    const b = D.buf(2.2);
    const env = (x) => 0.15 + 0.85 * x * x;
    D.tone(b, 0, 2.2, 2600, 280, 0.35, { a: 0.2, env });
    D.noise(b, 0, 2.2, 0.9, { color: 'pink', f: 'bp', f0: 3000, f1: 400, q: 1.2, a: 0.3, rnd: r, env });
    D.crackle(b, 0.5, 1.7, 90, 0.3, { f: 2500, rnd: r, env });
    return fin(D, b);
  },
};
R.rumble = {
  vol: 0.75, group: 'rumble', win: 1500, variants: 2, prio: 2, duck: 0.2, wet: 0.2,
  render(D, r, v) {
    return D.stereo(3.2, 17 + v, (b, rr) => {
      const env = (x) => Math.min(1, x * 5) * (1 - x) * (0.6 + 0.4 * Math.sin(x * 40 + rr()));
      D.noise(b, 0, 3.2, 1, { color: 'brown', f: 'lp', f0: 110, q: 0.9, rnd: rr, env });
      D.tone(b, 0, 3.2, 34, 30, 0.5, { a: 0.3, env, vib: [4, 0.08] });
      D.crackle(b, 0.2, 2.8, 30, 0.35, { f: 900, q: 0.8, len: 0.01, rnd: rr, env });
    }).map((c) => fin(D, c));
  },
};
R.wind = {
  vol: 0.42, group: 'wind', win: 1000, variants: 2, prio: 1, pos: false, wet: 0.1,
  render(D, r, v) {
    return D.stereo(2.2, 41 + v, (b, rr) => {
      D.noise(b, 0, 2.2, 1, { color: 'pink', f: 'bp', f0: 380, f1: 950, q: 1.6, rnd: rr, env: (x) => Math.sin(Math.PI * x) ** 1.3 });
    }).map((c) => fin(D, c));
  },
};
R.horn = {
  vol: 0.26, group: 'horn', win: 300, variants: 2, prio: 1, wet: 0.15,
  render(D, r, v) {
    const b = D.buf(v ? 0.45 : 0.3);
    const d = v ? 0.12 : 0.25;
    D.tone(b, 0, d, 415, 415, 0.5, { type: 'sqr', a: 0.01, hold: d, d: 0.05 });
    D.tone(b, 0, d, 523, 523, 0.4, { type: 'sqr', a: 0.01, hold: d, d: 0.05 });
    if (v) {
      D.tone(b, 0.18, 0.12, 415, 415, 0.5, { type: 'sqr', a: 0.01, hold: 0.1, d: 0.05 });
      D.tone(b, 0.18, 0.12, 523, 523, 0.4, { type: 'sqr', a: 0.01, hold: 0.1, d: 0.05 });
    }
    D.filter(b, 'lp', 1800, 1.2);
    return fin(D, b, 0.8);
  },
};
R.firework = {
  vol: 0.5, group: 'firework', win: 120, variants: 3, prio: 1, pos: true, wet: 0.4,
  render(D, r) {
    const b = D.buf(2.0);
    D.tone(b, 0, 0.55, 700 + r() * 300, 2200 + r() * 800, 0.15, { a: 0.05, env: (x) => 1 - x * 0.5 }); // launch whistle
    thud(D, b, 0.6, 140, 60, 0.9, 0.08); // pop
    D.noise(b, 0.6, 0.2, 0.6, { f: 'lp', f0: 3000, d: 0.05, rnd: r });
    D.crackle(b, 0.7, 1.2, 260, 0.35, { f: 5500, q: 1.2, len: 0.0015, rnd: r, env: (x) => (1 - x) ** 1.5 }); // glitter
    return fin(D, b);
  },
};
R.construct = {
  vol: 0.22, group: 'construct', win: 250, variants: 3, prio: 0, wet: 0.15, bus: 'amb',
  render(D, r, v) {
    const b = D.buf(0.5);
    // hammer taps (v 0/1) or a short drill (v 2)
    if (v === 2) {
      D.tone(b, 0, 0.4, 180, 190, 0.5, { type: 'saw', a: 0.02, hold: 0.3, d: 0.05, vib: [35, 0.1] });
      D.filter(b, 'bp', 1200, 0.8);
    } else {
      for (let k = 0; k < 2 + v; k++) D.modal(b, k * 0.14, 0.1, 700 + r() * 200, [[1, 1, 0.02], [2.4, 0.6, 0.012], [5.1, 0.3, 0.006]], 0.8);
    }
    return fin(D, b);
  },
};

/* ================================================================== */
/* Synonyms used by other modules                                       */
/* ================================================================== */
Object.assign(A.ALIAS, {
  money: 'cash', coin: 'cash', cash_register: 'cash', income: 'cash',
  ding: 'notify', toast: 'notify', notification: 'notify', message: 'notify', news: 'notify',
  warn: 'alert', warning: 'alert', bad: 'alert', danger: 'alert',
  fanfare: 'milestone', celebrate: 'milestone',
  sparkle: 'achievement', unlock: 'achievement',
  level_up: 'levelup', upgrade: 'levelup', grow: 'levelup',
  place: 'build', building: 'build', construct_done: 'build',
  street: 'road', avenue: 'road', highway: 'road',
  trees: 'plant', tree: 'plant',
  terrain: 'terraform', raise: 'terraform', lower: 'terraform', level: 'terraform',
  powerline: 'pline', power_line: 'pline', zap: 'pline',
  crash: 'collapse', destroy: 'collapse', debris: 'collapse',
  boom: 'explosion', impact: 'explosion', meteor_impact: 'explosion',
  monster: 'roar', cubezilla: 'roar',
  earthquake: 'rumble', quake: 'rumble', aftershock: 'rumble',
  tornado: 'wind', gust: 'wind',
  lightning: 'thunder', thunderclap: 'thunder',
  beam: 'abduct', tractor: 'abduct',
  launch: 'rocket', water: 'splash',
  fireworks: 'firework',
  select: 'click', toggle: 'click', tab: 'click', button: 'click',
  shutter: 'camera', screenshot: 'camera', photo: 'camera',
  stamp: 'policy', ordinance: 'policy',
  emergency: 'siren', police: 'siren', ambulance: 'siren',
  honk: 'horn', car: 'horn',
  window: 'open', window_open: 'open', window_close: 'close',
  transition: 'whoosh', swish: 'whoosh', // ('swoosh' is the ambient car pass-by recipe)
  unpause: 'tick', resume: 'tick', speed: 'tick',
  hammer: 'construct', construction: 'construct',
  complete: 'success', done: 'success', ok: 'success',
  fail: 'error', denied: 'error', invalid: 'error',
});
