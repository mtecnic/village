/*
 * VOXELPOLIS — post-processing chain: VC.gfx.hdr {color, depth} (internal size rw x rh) -> canvas (W x H).
 *
 *   1. AUTO EXPOSURE  log-luminance of the scene at 32x18 -> 1x1 center-weighted average, adapted over time
 *                     (ping-pong, GPU only). Final exposure = env.exposure (time-of-day, from core) nudged
 *                     gently toward a key value, so night is never pitch black and noon never blows out.
 *   2. SSAO           (high/ultra) half-res normal-oriented hemisphere AO from depth only (normals rebuilt
 *                     from depth), 4x4 depth-aware blur. Subtle; skipped on emissive pixels.
 *   3. BLOOM          soft-knee bright pass (Karis average) at half res, 6-level dual-filter (Kawase)
 *                     down/up chain; every level is accumulated (normalized) for crisp + wide glows.
 *                     Stronger and lower-threshold at night: windows, neon and street lamps glow.
 *   4. TILT-SHIFT     miniature/diorama DOF: circle of confusion from the screen-y distance to a focus band
 *                     slightly below center, relaxed near the focus depth (tall buildings in focus stay sharp),
 *                     scaled with camera distance. Half-res 24-tap disk gather that never lets sharp
 *                     foreground bleed into blurred background.
 *   5. GOD RAYS       around sunrise/sunset: sky mask near the sun, two radial-blur passes toward the sun.
 *   6. COMPOSITE      AO, DOF blend, exposure, bloom, rays, lightning flash, white balance, ACES filmic (Hill
 *                     fit), lift/gamma/gain, contrast, saturation, vignette, subtle edge chromatic aberration.
 *   7. FXAA 3.11      (quality) luma-in-alpha, with animated film grain, upscaling to the canvas.
 * 'low' quality = exposure + tonemap + grade + vignette only. Render targets live in a small pool keyed by
 * name and are (re)allocated only when their size changes (i.e. on resize). A target that cannot be allocated
 * is not retried (and nothing leaks) until the next resize; core then falls back to its basic tonemap.
 * HDR ALPHA (see core.js): alpha < 0.4 = water surface; 0.4..1 marks "data" pixels (overlay) that skip the
 * night grade. Pixels whose depth lies below the sea surface inside the map are water too (no SSAO there,
 * tilt-shift focus uses the sea plane).
 * Context restore: registered with VC.gfx.onRestore (targets and programs are rebuilt).
 *
 * EXTRA API: VC.post.stats (active features, ms), VC.post.debugView = null | 'ao' | 'bloom' | 'dof' | 'coc' |
 *   'rays' | 'lum' (shows an intermediate buffer), VC.post.readExposure() -> {avgLum, exposure} (test only;
 *   stalls the GPU).
 */
const M = VC.M;

const PP = (VC.post = {
  programs: {},
  stats: { features: '', ms: 0 },
  debugView: null,
  ok: false,
  frame: 0,
  /** Tunables (exposure metering). */
  tune: { autoStrength: 0.3, keyDay: 0.18, keyNight: 0.05, autoRange: 1.5 },

  init() {
    const G = VC.gfx, gl = G.gl;
    PP.float = !!G.caps.floatRT;
    PP.dummy = G.texture({ w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) });
    PP.black = G.texture({ w: 1, h: 1, data: new Uint8Array([0, 0, 0, 255]) });
    const P = PP.programs;
    const prog = (name, body) => (P[name] = G.program('post_' + name, G.FS_VS, POST_HEAD + body));
    prog('lum', FS_LUM);
    prog('adapt', FS_ADAPT);
    prog('bright', EXPO + FS_BRIGHT);
    prog('down', FS_DOWN);
    prog('up', FS_UP);
    prog('ssao8', DEPTH_FN + '#define AO_SAMPLES 8\n' + FS_SSAO);
    prog('ssao12', DEPTH_FN + '#define AO_SAMPLES 12\n' + FS_SSAO);
    prog('aoblur', DEPTH_FN + FS_AOBLUR);
    prog('dofprep', DEPTH_FN + TILT_FN + FS_DOFPREP);
    prog('dof', DEPTH_FN + '#define DOF_TAPS 24\n' + FS_DOF);
    prog('raymask', FS_RAYMASK);
    prog('rays', FS_RAYS);
    prog('comp', DEPTH_FN + TILT_FN + EXPO + FS_COMP);
    prog('fxaa', FS_FXAA);
    prog('show', FS_SHOW);
    // fixed sampler units per program (units 5-7 stay reserved for noise/tile/shadow)
    for (const k in P) {
      const u = P[k].u;
      gl.useProgram(P[k].prog);
      for (const s in SAMPLER_UNITS) if (u[s]) gl.uniform1i(u[s], SAMPLER_UNITS[s]);
    }
    PP.adaptIdx = 0;
    PP.adaptFresh = true;
    PP.feat = {};
    PP._downs = [];
    PP._expo = new Float32Array(4);
    PP._tilt = new Float32Array(4);
    PP._focus = new Float32Array(2);
    PP._raysCol = new Float32Array(3);
    PP._levelW = new Float32Array(LEVEL_W.length);
    PP.ok = true;
    if (!PP._restoreReg && G.onRestore) {
      PP._restoreReg = true;
      G.onRestore(() => PP.restore());
    }
  },

  /** WebGL context restored: every GL object is gone; rebuild the pool and the programs' sampler setup. */
  restore() {
    for (const k in RT) delete RT[k];
    for (const k in RT_FAIL) delete RT_FAIL[k];
    PP.ok = false;
    PP.adaptTex = PP.adaptRT = null;
    PP.init();
  },

  /** Internal render size changed: size-dependent targets are re-created lazily on next use. */
  resize() {
    PP.adaptFresh = true;
    for (const k in RT_FAIL) delete RT_FAIL[k]; // a new size may allocate fine
  },

  render(ctx) {
    if (!PP.ok) throw new Error('post not initialized');
    if (VC.gfx.lost) return;
    const G = VC.gfx, gl = G.gl, env = ctx.env, cam = ctx.cam;
    const t0 = performance.now();
    const hdr = G.hdr, rw = hdr.w, rh = hdr.h;
    const q = G.quality(), qk = (VC.settings && VC.settings.quality) || 'high', st = VC.settings || {};
    const low = qk === 'low';
    const f = PP.feat;
    f.bloom = !low && q.bloom !== false && st.bloom !== false;
    f.tilt = !low && !!q.tilt && st.tiltShift !== false;
    f.fxaa = !low && !!q.fxaa;
    f.ssao = !low && (q.ssao != null ? !!q.ssao : qk === 'high' || qk === 'ultra') && st.ssao !== false;
    f.rays = !low && (q.godrays != null ? !!q.godrays : qk !== 'medium') && st.godRays !== false;
    const hw = Math.max(1, (rw + 1) >> 1), hh = Math.max(1, (rh + 1) >> 1);
    const fl = PP.float, P = PP.programs;
    let u;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.depthMask(false);
    gl.colorMask(true, true, true, true);

    /* ---- 1. auto exposure ---- */
    const lumT = rt('lum', 32, 18, false);
    u = pass(P.lum, lumT);
    tex(P.lum, 'uSrc', hdr.color);
    gl.uniform2f(u.uStep, 0.25 / 32, 0.25 / 18);
    G.fullscreen();
    const aPrev = rt(PP.adaptIdx ? 'adapt1' : 'adapt0', 1, 1, fl, true), aNext = rt(PP.adaptIdx ? 'adapt0' : 'adapt1', 1, 1, fl, true);
    u = pass(P.adapt, aNext);
    tex(P.adapt, 'uLum', lumT.tex);
    tex(P.adapt, 'uPrev', aPrev.tex);
    gl.uniform1f(u.uRate, PP.adaptFresh || !fl ? 1 : 1 - Math.exp(-Math.min(ctx.rdt || 0.016, 0.1) * 1.6));
    G.fullscreen();
    PP.adaptIdx = 1 - PP.adaptIdx;
    PP.adaptFresh = false;
    PP.adaptTex = aNext.tex;
    PP.adaptRT = aNext;
    const n = env.night || 0;
    const expo = PP._expo, T = PP.tune;
    const ovOn = !!G.overlay && G.overlay !== 'none';
    expo[0] = (env.exposure || 1) * (ovOn ? 1 + n * 0.35 : 1); // data overlay at night: a brighter map
    expo[1] = T.autoStrength; // auto-exposure strength (0 = off, 1 = full)
    expo[2] = M.lerp(T.keyDay, T.keyNight, n); // target key (exposed average luminance)
    expo[3] = T.autoRange; // max correction factor either way

    /* ---- 2. SSAO ---- */
    let aoTex = PP.dummy;
    if (f.ssao) {
      const a0 = rt('ao0', hw, hh, false), a1 = rt('ao1', hw, hh, true);
      const R = M.clamp(0.28 + cam.dist * 0.011, 0.35, 2.4);
      const Pa = qk === 'ultra' ? P.ssao12 : P.ssao8;
      u = pass(Pa, a0);
      tex(Pa, 'uDepth', hdr.depth);
      gl.uniform4f(u.uAOP, R, 1.35, R * 0.04, Math.min(cam.far * 0.5, cam.dist * 3 + 60));
      G.fullscreen();
      u = pass(P.aoblur, a1);
      tex(P.aoblur, 'uSrc', a0.tex);
      tex(P.aoblur, 'uDepth', hdr.depth);
      gl.uniform2f(u.uTexel, 1 / hw, 1 / hh);
      G.fullscreen();
      aoTex = a1.tex;
    }

    /* ---- 3. bloom ---- */
    let bloomTex = PP.black, bloomNorm = 1;
    // Zoomed out, lit windows are tiny and dense: the same screen-space glow would merge into a haze over
    // the whole city, so intensity, threshold and the widest levels scale with the camera distance.
    const far = M.sat((cam.dist - 30) / 120);
    const bloomI = 0.2 + n * (0.75 - far * 0.3) + (env.blueHour || 0) * 0.15 + (env.lightning || 0) * 0.3;
    const LW = PP._levelW;
    for (let i = 0; i < LEVEL_W.length; i++) LW[i] = LEVEL_W[i] * (i >= 4 ? (1 - n * 0.35) * (1 - far * 0.5) : i === 3 ? 1 - far * 0.25 : 1);
    if (f.bloom) {
      let w = hw, h = hh;
      const downs = PP._downs;
      downs.length = 0;
      const d0 = rt('bd0', w, h, fl);
      const th = M.lerp(1.05, 0.62, n) + n * far * 0.25;
      u = pass(P.bright, d0);
      tex(P.bright, 'uSrc', hdr.color);
      tex(P.bright, 'uAdapt', PP.adaptTex);
      gl.uniform2f(u.uTexel, 1 / rw, 1 / rh);
      // clamp: isolated specular fireflies (sea glints) must not blow up into wide bokeh-like halos
      gl.uniform3f(u.uThresh, th, th * 0.6, fl ? 32 : 1);
      gl.uniform4fv(u.uExpo, expo);
      G.fullscreen();
      downs.push(d0);
      for (let i = 1; i < LEVEL_W.length; i++) {
        const pw = w, ph = h;
        w = Math.max(1, (w + 1) >> 1);
        h = Math.max(1, (h + 1) >> 1);
        if (w < 3 || h < 3) break;
        const d = rt(BD_NAMES[i], w, h, fl);
        u = pass(P.down, d);
        tex(P.down, 'uSrc', downs[i - 1].tex);
        gl.uniform2f(u.uTexel, 1 / pw, 1 / ph);
        G.fullscreen();
        downs.push(d);
      }
      // upsample: up_i = tent(up_{i+1}) + down_i * w_i ; bloom = up_0 / sum(w)
      const nl = downs.length;
      let src = downs[nl - 1], wsum = LW[nl - 1];
      for (let i = nl - 2; i >= 0; i--) {
        const d = downs[i], out = rt(BU_NAMES[i], d.w, d.h, fl);
        wsum += LW[i];
        u = pass(P.up, out);
        tex(P.up, 'uSrc', src.tex);
        tex(P.up, 'uBase', d.tex);
        gl.uniform2f(u.uTexel, 1 / src.w, 1 / src.h);
        gl.uniform1f(u.uBaseW, LW[i]);
        G.fullscreen();
        src = out;
      }
      bloomTex = src.tex;
      bloomNorm = 1 / wsum;
    }

    /* ---- 4. tilt-shift DOF ---- */
    let dofTex = PP.black;
    const tilt = PP._tilt, focus = PP._focus;
    {
      // Strongest at the diorama distances (~40-70); an overview is for reading the whole map, so the blur
      // fades there (and the sharp band widens). Near-top-down views have no miniature perspective to fake,
      // and low street-level views get a milder, photographic amount.
      const d = cam.dist, pitch = cam.pitch;
      const amt = M.lerp(4.5, 7.5, M.smoothstep(10, 60, d)) * M.lerp(1, 0.4, M.smoothstep(70, 140, d));
      const tiltK = M.smoothstep(1.35, 1.0, pitch) * M.lerp(0.6, 1, M.smoothstep(0.12, 0.5, pitch));
      const maxCocFull = amt * tiltK * (rh / 1080) * (cam.cinematic ? 1.25 : 1);
      tilt[0] = 0.45; // focus band center (uv.y, 0 = bottom): slightly below the screen center
      tilt[1] = M.lerp(0.17, 0.22, M.smoothstep(60, 160, d)); // sharp half-width
      tilt[2] = 0.48; // falloff to full blur
      tilt[3] = maxCocFull * 0.5; // max CoC in half-res px
      focus[0] = d;
      focus[1] = 0.65; // depth awareness
    }
    if (f.tilt && tilt[3] >= 0.75) {
      const pT = rt('dofp', hw, hh, fl), bT = rt('dofb', hw, hh, fl);
      u = pass(P.dofprep, pT);
      tex(P.dofprep, 'uSrc', hdr.color);
      tex(P.dofprep, 'uDepth', hdr.depth);
      gl.uniform4fv(u.uTilt, tilt);
      gl.uniform2fv(u.uFocusZ, focus);
      G.fullscreen();
      u = pass(P.dof, bT);
      tex(P.dof, 'uSrc', pT.tex);
      tex(P.dof, 'uDepth', hdr.depth);
      gl.uniform2f(u.uTexel, 1 / hw, 1 / hh);
      gl.uniform1f(u.uMaxCoc, tilt[3]);
      G.fullscreen();
      dofTex = bT.tex;
    } else f.tilt = false;

    /* ---- 5. god rays ---- */
    let raysTex = PP.black;
    const raysCol = PP._raysCol;
    raysCol[0] = raysCol[1] = raysCol[2] = 0;
    if (f.rays) {
      const sun = env.sun, h = env.sunUp;
      let k = M.smoothstep(-0.06, 0.02, h) * (0.3 + 0.7 * M.smoothstep(0.45, 0.06, h)) * (1 - env.cloud * 0.85) * (1 - n);
      // sun position on screen (a direction = point at infinity)
      const vp = cam.viewProj;
      const cx = vp[0] * sun[0] + vp[4] * sun[1] + vp[8] * sun[2];
      const cy = vp[1] * sun[0] + vp[5] * sun[1] + vp[9] * sun[2];
      const cwv = vp[3] * sun[0] + vp[7] * sun[1] + vp[11] * sun[2];
      const su = (cx / cwv) * 0.5 + 0.5, sv = (cy / cwv) * 0.5 + 0.5;
      if (cwv > 0.05) k *= M.smoothstep(2.2, 0.6, Math.max(Math.abs(su - 0.5), Math.abs(sv - 0.5)));
      else k = 0;
      if (k > 0.01) {
        const qw = Math.max(1, (rw + 3) >> 2), qh = Math.max(1, (rh + 3) >> 2);
        const m0 = rt('ray0', qw, qh, fl), m1 = rt('ray1', qw, qh, fl);
        u = pass(P.raymask, m0);
        tex(P.raymask, 'uSrc', hdr.color);
        tex(P.raymask, 'uDepth', hdr.depth);
        gl.uniform3f(u.uSun, sun[0], sun[1], sun[2]);
        G.fullscreen();
        // two radial passes (coarse, then fine) = 24 x 24 effective samples
        u = pass(P.rays, m1);
        tex(P.rays, 'uSrc', m0.tex);
        gl.uniform2f(u.uSunUv, su, sv);
        gl.uniform2f(u.uParam, 0.9, 0.955);
        G.fullscreen();
        u = pass(P.rays, m0);
        tex(P.rays, 'uSrc', m1.tex);
        gl.uniform2f(u.uParam, 0.9 / 24, 0.985);
        G.fullscreen();
        raysTex = m0.tex;
        const warm = M.smoothstep(0.35, 0.0, h);
        raysCol[0] = k * 0.45;
        raysCol[1] = k * 0.45 * M.lerp(0.92, 0.66, warm);
        raysCol[2] = k * 0.45 * M.lerp(0.8, 0.4, warm);
      } else f.rays = false;
    }

    /* ---- 6. composite ---- */
    const gp = grade(env, ovOn);
    const toScreen = !f.fxaa;
    const ldr = toScreen ? null : rt('ldr', rw, rh, false);
    const grain = low ? 0 : 0.024;
    const Pc = P.comp;
    u = pass(Pc, ldr);
    tex(Pc, 'uSrc', hdr.color);
    tex(Pc, 'uDepth', hdr.depth);
    tex(Pc, 'uBloom', bloomTex);
    tex(Pc, 'uDof', dofTex);
    tex(Pc, 'uAO', aoTex);
    tex(Pc, 'uRays', raysTex);
    tex(Pc, 'uAdapt', PP.adaptTex);
    gl.uniform4f(u.uOn, f.bloom ? 1 : 0, f.tilt ? 1 : 0, f.ssao ? 1 : 0, f.rays ? 1 : 0);
    gl.uniform4fv(u.uExpo, expo);
    gl.uniform2f(u.uBloomP, f.bloom ? bloomI * bloomNorm : 0, 0);
    gl.uniform3fv(u.uRaysCol, raysCol);
    gl.uniform3fv(u.uTint, gp.tint);
    gl.uniform3fv(u.uTintData, gp.tintData);
    gl.uniform3fv(u.uLift, gp.lift);
    gl.uniform3fv(u.uGamma, gp.gamma);
    gl.uniform3fv(u.uGain, gp.gain);
    gl.uniform4f(u.uGradeP, gp.sat, gp.contrast, gp.vignette, low ? 0 : 0.0025);
    gl.uniform4f(u.uFx, grain, ctx.time % 100, M.sat(env.lightning || 0), toScreen ? 1 : 0);
    gl.uniform4fv(u.uTilt, tilt);
    gl.uniform2fv(u.uFocusZ, focus);
    gl.uniform1f(u.uAoStr, 0.75);
    gl.uniform1f(u.uAoBilateral, fl ? 1 : 0);
    // (with a data overlay on, the moonlit shift is mostly skipped everywhere: the map must stay readable)
    gl.uniform1f(u.uScotopic, M.smoothstep(0.3, 1.0, n) * 0.65 * (ovOn ? 0.35 : 1));
    gl.uniform1f(u.uKeepHue, 0.3 + n * 0.25);
    G.fullscreen();

    /* ---- 7. FXAA + grain -> canvas ---- */
    if (!toScreen) {
      u = pass(P.fxaa, null);
      tex(P.fxaa, 'uSrc', ldr.tex);
      gl.uniform2f(u.uRcp, 1 / rw, 1 / rh);
      gl.uniform2f(u.uGrain, grain, ctx.time % 100);
      G.fullscreen();
    }

    if (PP.debugView) debugShow(PP.debugView, { ao: aoTex, bloom: bloomTex, dof: dofTex, rays: raysTex, lum: lumT.tex });

    // release targets of features that have been off for ~4 s (quality / settings changes)
    PP.frame++;
    if ((PP.frame & 63) === 0) {
      for (const k in RT) {
        const t = RT[k];
        if (PP.frame - t.used > 240) {
          gl.deleteFramebuffer(t.fbo);
          gl.deleteTexture(t.tex);
          delete RT[k];
        }
      }
    }

    // Unbind our textures so no stale post texture (e.g. hdr color/depth) stays on a unit a layer may sample.
    for (let i = 0; i < UNBIND.length; i++) {
      gl.activeTexture(gl.TEXTURE0 + UNBIND[i]);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.depthMask(true);
    const mask = (f.ssao ? 1 : 0) | (f.bloom ? 2 : 0) | (f.tilt ? 4 : 0) | (f.rays ? 8 : 0) | (f.fxaa ? 16 : 0);
    if (mask !== PP._mask) {
      PP._mask = mask;
      PP.stats.features = (f.ssao ? 'ssao ' : '') + (f.bloom ? 'bloom ' : '') + (f.tilt ? 'tilt ' : '') + (f.rays ? 'rays ' : '') + (f.fxaa ? 'fxaa' : '');
    }
    PP.stats.ms = performance.now() - t0;
  },

  /** Test helper: reads the adapted average luminance (GPU stall — never call per frame). */
  readExposure() {
    const G = VC.gfx, gl = G.gl, r = PP.adaptRT;
    if (!r) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbo);
    let v;
    if (r.float) { const px = new Float32Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px); v = px[0]; }
    else { const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); v = px[0] / 255; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const avg = Math.pow(2, v * 20 - 12);
    const e = PP._expo;
    const ex = e[0] * M.clamp(Math.pow(e[2] / Math.max(avg * e[0], 1e-4), e[1]), 1 / e[3], e[3]);
    return { avgLum: +avg.toFixed(4), baseExposure: +e[0].toFixed(3), exposure: +ex.toFixed(3) };
  },
});

// Relative weights of the bloom levels (half res .. 1/64): tight glows + wide atmospheric halo.
const LEVEL_W = [1.0, 0.95, 0.9, 0.85, 0.8, 0.75];
const BD_NAMES = LEVEL_W.map((_, i) => 'bd' + i), BU_NAMES = LEVEL_W.map((_, i) => 'bu' + i);
const SAMPLER_UNITS = { uSrc: 0, uDepth: 1, uBloom: 2, uDof: 3, uAO: 4, uRays: 8, uAdapt: 9, uPrev: 10, uLum: 11, uBase: 12 };
const UNBIND = [0, 1, 2, 3, 4, 8, 9, 10, 11, 12];

/* ------------------------------------------------------------------ */
/* Render target pool                                                   */
/* ------------------------------------------------------------------ */
const RT = {};
const RT_FAIL = {}; // targets that could not be allocated at this size (not retried until resize / restore)
/** Named render target of size w x h; hdr = half-float when supported. Re-created only on size change. */
function rt(name, w, h, hdr, nearest) {
  const G = VC.gfx, gl = G.gl;
  const float = !!(hdr && PP.float);
  let t = RT[name];
  if (t && t.w === w && t.h === h && t.float === float) { t.used = PP.frame; return t; }
  const key = name + ':' + w + 'x' + h + (float ? 'f' : '');
  if (RT_FAIL[key]) throw new Error('post: render target ' + name + ' unavailable');
  if (t) {
    gl.deleteFramebuffer(t.fbo);
    gl.deleteTexture(t.tex);
    delete RT[name];
  }
  const tex = G.texture({ w, h, internal: float ? gl.RGBA16F : gl.RGBA8, format: gl.RGBA, type: float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, filter: nearest ? gl.NEAREST : gl.LINEAR });
  const fbo = G.framebuffer(tex);
  if (!fbo) {
    gl.deleteTexture(tex); // never leak the texture of a failed target
    RT_FAIL[key] = 1;
    throw new Error('post: render target ' + name + ' incomplete');
  }
  t = RT[name] = { tex, fbo, w, h, float, used: PP.frame };
  return t;
}

/** Starts a fullscreen pass of program P into target (null = canvas). Returns P's uniform table. */
function pass(P, target) {
  const G = VC.gfx, gl = G.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
  if (target) gl.viewport(0, 0, target.w, target.h);
  else gl.viewport(0, 0, G.W, G.H);
  gl.useProgram(P.prog);
  return P.u;
}
/** Binds texture t to P's sampler `name` (fixed unit, see SAMPLER_UNITS) if the program uses it. */
function tex(P, name, t) {
  if (!P.u[name]) return;
  const gl = VC.gfx.gl;
  gl.activeTexture(gl.TEXTURE0 + SAMPLER_UNITS[name]);
  gl.bindTexture(gl.TEXTURE_2D, t);
}

function debugShow(view, texs) {
  const G = VC.gfx, gl = G.gl, P = PP.programs.show;
  if (view === 'shadow') {
    // shadow atlas depth (compare mode must be off to read raw depth)
    const t = VC.shadows && VC.shadows.tex;
    if (!t) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t);
    // raw depth is only readable unfiltered
    const mode = (m, f) => { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, m); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f); };
    mode(gl.NONE, gl.NEAREST);
    gl.uniform1i(pass(P, null).uMode, 4);
    tex(P, 'uSrc', t);
    G.fullscreen();
    gl.bindTexture(gl.TEXTURE_2D, t);
    mode(gl.COMPARE_REF_TO_TEXTURE, gl.LINEAR);
    return;
  }
  const t = view === 'coc' ? RT.dofp && RT.dofp.tex : texs[view];
  if (!t) return;
  gl.uniform1i(pass(P, null).uMode, view === 'coc' ? 1 : view === 'lum' ? 2 : view === 'ao' ? 3 : 0);
  tex(P, 'uSrc', t);
  G.fullscreen();
}

/* ------------------------------------------------------------------ */
/* Color grading from the lighting environment                          */
/* ------------------------------------------------------------------ */
const GP = { tint: new Float32Array(3), tintData: new Float32Array(3), lift: new Float32Array(3), gamma: new Float32Array(3), gain: new Float32Array(3), sat: 1, contrast: 1, vignette: 0.3 };
const WB_GOLD = [1.14, 1.0, 0.8], WB_DUSK = [1.08, 0.95, 1.02], WB_BLUE = [0.9, 0.96, 1.14], WB_NIGHT = [0.84, 0.95, 1.16], WB_WET = [0.96, 0.99, 1.04];
function mix3(o, c, t) {
  o[0] += (c[0] - o[0]) * t; o[1] += (c[1] - o[1]) * t; o[2] += (c[2] - o[2]) * t;
}
function grade(env, ovOn) {
  const n = env.night || 0, g = env.golden || 0, bh = env.blueHour || 0, dk = env.dusk || 0;
  const cl = env.cloud || 0, wet = env.wet || 0, snow = env.snow || 0;
  const t = GP.tint, td = GP.tintData, lift = GP.lift, gam = GP.gamma, gain = GP.gain;
  // white balance: warm golden hour, pink dusk, blue hour + moonlit night cool. The golden weight is strong:
  // flat ground at low sun is lit mostly by the sky dome, so the light alone cannot carry the warmth.
  t[0] = 1; t[1] = 1; t[2] = 1;
  mix3(t, WB_GOLD, g * (1 - cl * 0.6));
  mix3(t, WB_DUSK, dk * (1 - g) * 0.7 * (1 - cl * 0.6));
  mix3(t, WB_WET, wet * 0.6 + snow * 0.25);
  td[0] = t[0]; td[1] = t[1]; td[2] = t[2]; // data pixels (overlays): no blue-hour / night cast
  mix3(t, WB_BLUE, bh * 0.6);
  mix3(t, WB_NIGHT, n * 0.12 * (ovOn ? 0.3 : 1)); // (the scotopic shift in the shader cools the darks; lights stay warm)
  // lift (shadow tint), gamma, gain (highlight tint)
  lift[0] = 0.004 - n * 0.002; lift[1] = 0.004 + n * 0.004; lift[2] = 0.006 + n * 0.016 + bh * 0.01;
  gam[0] = gam[1] = gam[2] = 1 / (1.0 + n * 0.04);
  gain[0] = 1 + g * 0.06; gain[1] = 1; gain[2] = 1 - g * 0.05 + n * 0.02;
  // saturation: moderate base (above ~1.1 lush grass reads lime and dark evergreens read black)
  GP.sat = 1.05 + g * 0.08 + dk * 0.05 - n * 0.06 - cl * 0.2 - wet * 0.12;
  GP.contrast = 1.04 + g * 0.04 + snow * 0.06 * (1 - n) - cl * 0.06 - wet * 0.02; // (snow: keep definition)
  GP.vignette = 0.32 + n * 0.14;
  return GP;
}

/* ------------------------------------------------------------------ */
/* GLSL                                                                 */
/* ------------------------------------------------------------------ */
const POST_HEAD = `in vec2 vUv;
out vec4 fragColor;
`;

// Linear view depth (positive distance) from a depth-buffer value, using the Frame UBO projection.
const DEPTH_FN = `
float linZ(float d){ return uProj[3][2] / ((d * 2.0 - 1.0) + uProj[2][2]); }
vec3 viewPos(vec2 uv, float d){ float z = linZ(d); vec2 ndc = uv * 2.0 - 1.0; return vec3(ndc.x * z / uProj[0][0], ndc.y * z / uProj[1][1], -z); }
// Water surface at this pixel? Returns the linear view depth of the sea surface (every water body lies at
// SEA_Y) when the visible surface is water, else 0: HDR alpha < 0.4 (water layer mark), or geometry seen
// below the sea plane where the ray crosses it inside the map (the depth buffer holds the seabed there,
// since water writes no depth). The diorama skirts outside the map are excluded by the map test.
float waterZ(vec2 uv, float d, float hdrA){
  vec3 wd = transpose(mat3(uView)) * vec3((uv.x * 2.0 - 1.0) / uProj[0][0], (uv.y * 2.0 - 1.0) / uProj[1][1], -1.0);
  if (wd.y > -1e-4) return 0.0;
  float zs = (SEA_Y - uCamPos.y) / wd.y;
  if (zs <= 0.0) return 0.0;
  if (hdrA < 0.4) return zs;
  if (d >= 0.99999 || linZ(d) <= zs + 0.02) return 0.0;
  vec2 p = uCamPos.xz + wd.xz * zs;
  if (p.x < 0.05 || p.y < 0.05 || p.x > uMap.x - 0.05 || p.y > uMap.y - 0.05) return 0.0;
  return zs;
}
`;

// Tilt-shift circle of confusion 0..1 (screen-y band, relaxed near the focus depth).
const TILT_FN = `
uniform vec4 uTilt;   // x focus y, y sharp half-width, z falloff, w max coc (half-res px)
uniform vec2 uFocusZ; // x focus distance, y depth awareness 0..1
float tiltCocZ(vec2 uv, float z, float sky){
  float s = smoothstep(uTilt.y, uTilt.y + uTilt.z, abs(uv.y - uTilt.x));
  if (sky > 0.5) return s;
  float dz = abs(z - uFocusZ.x) / uFocusZ.x;
  return s * mix(1.0, smoothstep(0.03, 0.3, dz), uFocusZ.y);
}
float tiltCoc(vec2 uv, float d){ return tiltCocZ(uv, linZ(d), d >= 0.99999 ? 1.0 : 0.0); }
`;

// Exposure: env exposure * gentle auto correction toward a key value (adapted log-luminance in uAdapt).
const EXPO = `
uniform sampler2D uAdapt;
uniform vec4 uExpo; // x base exposure, y auto strength, z target key, w max correction
float postExposure(){
  float ex = uExpo.x;
  if (uExpo.y > 0.0) {
    float L = exp2(texelFetch(uAdapt, ivec2(0), 0).r * 20.0 - 12.0);
    ex *= clamp(pow(uExpo.z / max(L * ex, 1e-4), uExpo.y), 1.0 / uExpo.w, uExpo.w);
  }
  return ex;
}
`;

const FS_LUM = `
uniform sampler2D uSrc; uniform vec2 uStep;
void main(){
  float s = 0.0;
  for (int y = -1; y <= 2; y++) for (int x = -1; x <= 2; x++) {
    vec3 c = texture(uSrc, vUv + (vec2(x, y) - 0.5) * uStep).rgb;
    s += log2(libLuma(c) + 0.0005);
  }
  fragColor = vec4(clamp((s / 16.0 + 12.0) / 20.0, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

const FS_ADAPT = `
uniform sampler2D uLum; uniform sampler2D uPrev; uniform float uRate;
void main(){
  float s = 0.0, ws = 0.0;
  for (int y = 0; y < 18; y++) for (int x = 0; x < 32; x++) {
    vec2 p = (vec2(x, y) + 0.5) / vec2(32.0, 18.0) - 0.5;
    float w = 1.0 - dot(p, p) * 1.8;   // center-weighted metering
    s += texelFetch(uLum, ivec2(x, y), 0).r * w;
    ws += w;
  }
  float cur = s / ws;
  float prev = texelFetch(uPrev, ivec2(0), 0).r;
  fragColor = vec4(mix(prev, cur, uRate), 0.0, 0.0, 1.0);
}`;

const FS_BRIGHT = `
uniform sampler2D uSrc; uniform vec2 uTexel; uniform vec3 uThresh; // threshold, knee, clamp
vec3 tap(vec2 o, out float w){ vec3 c = texture(uSrc, vUv + o * uTexel).rgb; w = 1.0 / (1.0 + libLuma(c)); return c; }
void main(){
  float wa, wb, wc, wd;
  vec3 a = tap(vec2(-1.0, -1.0), wa), b = tap(vec2(1.0, -1.0), wb), c = tap(vec2(-1.0, 1.0), wc), d = tap(vec2(1.0, 1.0), wd);
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);   // Karis average: no fireflies
  col = max(col * postExposure(), vec3(0.0));
  float br = max(col.r, max(col.g, col.b));
  float soft = clamp(br - uThresh.x + uThresh.y, 0.0, 2.0 * uThresh.y);
  soft = soft * soft / (4.0 * uThresh.y + 1e-4);
  float w = max(soft, br - uThresh.x) / max(br, 1e-4);
  fragColor = vec4(min(col * w, vec3(uThresh.z)), 1.0);
}`;

const FS_DOWN = `
uniform sampler2D uSrc; uniform vec2 uTexel;
void main(){
  vec2 o = uTexel;
  vec3 s = texture(uSrc, vUv).rgb * 4.0;
  s += texture(uSrc, vUv + vec2(-o.x, -o.y)).rgb;
  s += texture(uSrc, vUv + vec2( o.x, -o.y)).rgb;
  s += texture(uSrc, vUv + vec2(-o.x,  o.y)).rgb;
  s += texture(uSrc, vUv + vec2( o.x,  o.y)).rgb;
  fragColor = vec4(s * 0.125, 1.0);
}`;

const FS_UP = `
uniform sampler2D uSrc; uniform sampler2D uBase; uniform vec2 uTexel; uniform float uBaseW;
void main(){
  vec2 o = uTexel;
  vec3 s = texture(uSrc, vUv + vec2(-o.x, 0.0)).rgb + texture(uSrc, vUv + vec2(o.x, 0.0)).rgb
         + texture(uSrc, vUv + vec2(0.0, -o.y)).rgb + texture(uSrc, vUv + vec2(0.0, o.y)).rgb;
  vec2 h = o * 0.5;
  s += (texture(uSrc, vUv + vec2(-h.x, -h.y)).rgb + texture(uSrc, vUv + vec2(h.x, -h.y)).rgb
      + texture(uSrc, vUv + vec2(-h.x, h.y)).rgb + texture(uSrc, vUv + vec2(h.x, h.y)).rgb) * 2.0;
  fragColor = vec4(s / 12.0 + texture(uBase, vUv).rgb * uBaseW, 1.0);
}`;

const FS_SSAO = `
uniform sampler2D uDepth; uniform vec4 uAOP; // x radius (world), y power, z bias, w max distance
const vec3 KERNEL[12] = vec3[12](vec3(-0.0725, 0.0575, 0.0667), vec3(0.0850, 0.0860, 0.0916), vec3(0.0567, 0.1320, 0.0504),
  vec3(0.0834, -0.0146, 0.2091), vec3(0.1449, 0.1105, 0.2219), vec3(0.3011, -0.0942, 0.1237), vec3(-0.1374, -0.2847, 0.1219),
  vec3(-0.2656, 0.0711, 0.2983), vec3(-0.2097, -0.2429, 0.5177), vec3(0.0200, -0.4513, 0.2737), vec3(-0.4182, -0.2347, 0.5131),
  vec3(-0.0743, 0.6401, 0.5600));
void main(){
  // This pass runs at half resolution: its pixel centres fall exactly on full-res texel corners, where a
  // nearest-filtered fetch picks either neighbour depending on rounding (row by row), so a "neighbour" could
  // be the centre texel itself -> zero-length tangent -> garbage normal -> horizontal occlusion bands.
  // Work on explicit full-res texels instead.
  ivec2 dsz = textureSize(uDepth, 0), mx = dsz - 1;
  ivec2 c = clamp(ivec2(vUv * vec2(dsz)), ivec2(1), mx - 1);
  vec2 ts = 1.0 / vec2(dsz);
  vec2 uv0 = (vec2(c) + 0.5) * ts;
  float d = texelFetch(uDepth, c, 0).r;
  if (d >= 0.99999) { fragColor = vec4(1.0); return; }
  vec3 P = viewPos(uv0, d);
  if (-P.z > uAOP.w) { fragColor = vec4(1.0); return; }
  vec3 pr = viewPos(uv0 + vec2(ts.x, 0.0), texelFetch(uDepth, c + ivec2(1, 0), 0).r);
  vec3 pl = viewPos(uv0 - vec2(ts.x, 0.0), texelFetch(uDepth, c - ivec2(1, 0), 0).r);
  vec3 pu = viewPos(uv0 + vec2(0.0, ts.y), texelFetch(uDepth, c + ivec2(0, 1), 0).r);
  vec3 pd = viewPos(uv0 - vec2(0.0, ts.y), texelFetch(uDepth, c - ivec2(0, 1), 0).r);
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));
  float a = libIgn(mod(floor(gl_FragCoord.xy), 4.0) * 7.0) * 6.2831853;   // 4x4 pattern, removed by the blur
  vec3 rv = vec3(cos(a), sin(a), 0.37);
  vec3 T = normalize(rv - N * dot(rv, N));
  mat3 TBN = mat3(T, cross(N, T), N);
  float R = uAOP.x, occ = 0.0;
  // depth precision drops with distance (24-bit depth, reconstructed normals): a bias that grows with the
  // view depth keeps flat distant ground from self-occluding in screen-space bands
  float bias = uAOP.z - P.z * 0.0025;
  for (int i = 0; i < AO_SAMPLES; i++) {
    vec3 s = P + TBN * (KERNEL[i] * R);
    vec4 c = uProj * vec4(s, 1.0);
    vec2 suv = c.xy / c.w * 0.5 + 0.5;
    float sz = linZ(texture(uDepth, suv).r);
    float range = smoothstep(0.0, 1.0, R / max(abs(-P.z - sz), 1e-4));
    occ += (sz < -s.z - bias ? 1.0 : 0.0) * range;
  }
  float ao = pow(clamp(1.0 - occ / float(AO_SAMPLES), 0.0, 1.0), uAOP.y);
  ao = mix(ao, 1.0, smoothstep(uAOP.w * 0.7, uAOP.w, -P.z));
  fragColor = vec4(ao, 0.0, 0.0, 1.0);
}`;

const FS_AOBLUR = `
uniform sampler2D uSrc; uniform sampler2D uDepth; uniform vec2 uTexel;
void main(){
  float zc = linZ(texture(uDepth, vUv).r);
  float s = 0.0, ws = 0.0;
  for (int y = -2; y < 2; y++) for (int x = -2; x < 2; x++) {
    vec2 uv = vUv + (vec2(x, y) + 0.5) * uTexel;
    float z = linZ(texture(uDepth, uv).r);
    float w = exp(-abs(z - zc) / zc * 25.0) + 1e-4;
    s += texture(uSrc, uv).r * w;
    ws += w;
  }
  fragColor = vec4(s / ws, zc, 0.0, 1.0);   // g = view depth, for the bilateral upsample (float targets)
}`;

const FS_DOFPREP = `
uniform sampler2D uSrc; uniform sampler2D uDepth;
void main(){
  vec4 c = texture(uSrc, vUv);
  float d = texture(uDepth, vUv).r;
  float zw = waterZ(vUv, d, c.a);
  fragColor = vec4(c.rgb, zw > 0.0 ? tiltCocZ(vUv, zw, 0.0) : tiltCoc(vUv, d));
}`;

const DISK24 =
  'vec2(0.1443, 0.0000), vec2(-0.1843, 0.1689), vec2(0.0282, -0.3215), vec2(0.2324, 0.3031), vec2(-0.4264, -0.0754), vec2(0.4039, -0.2569), ' +
  'vec2(-0.1351, 0.5026), vec2(-0.2577, -0.4961), vec2(0.5590, 0.2041), vec2(-0.5816, 0.2401), vec2(0.2803, -0.5991), vec2(0.2072, 0.6605), ' +
  'vec2(-0.6244, -0.3619), vec2(0.7325, -0.1610), vec2(-0.4470, 0.6359), vec2(-0.1033, -0.7970), vec2(0.6340, 0.5343), vec2(-0.8532, 0.0353), ' +
  'vec2(0.6223, -0.6193), vec2(-0.0416, 0.9004), vec2(-0.5922, -0.7096), vec2(0.9380, 0.1262), vec2(-0.7948, 0.5530), vec2(0.2172, -0.9654)';

const FS_DOF = `
uniform sampler2D uSrc; uniform sampler2D uDepth; uniform vec2 uTexel; uniform float uMaxCoc;
const vec2 DISK[24] = vec2[24](${DISK24});
void main(){
  vec4 c0 = texture(uSrc, vUv);
  float r0 = c0.a * uMaxCoc;
  if (r0 < 0.5) { fragColor = c0; return; }
  float z0 = linZ(texture(uDepth, vUv).r);
  vec3 acc = c0.rgb; float ws = 1.0;
  for (int i = 0; i < DOF_TAPS; i++) {
    vec2 o = DISK[i * (24 / DOF_TAPS)] * r0;
    vec2 uv = vUv + o * uTexel;
    vec4 s = texture(uSrc, uv);
    float zi = linZ(texture(uDepth, uv).r);
    // a nearer tap only contributes if its own blur reaches this pixel: sharp foreground never bleeds
    float rs = zi < z0 * 0.97 ? s.a * uMaxCoc : r0;
    float w = clamp(rs - length(o) + 1.0, 0.0, 1.0);
    acc += s.rgb * w;
    ws += w;
  }
  fragColor = vec4(acc / ws, c0.a);
}`;

const FS_RAYMASK = `
uniform sampler2D uSrc; uniform sampler2D uDepth; uniform vec3 uSun;
void main(){
  float d = texture(uDepth, vUv).r;
  if (d < 0.99999) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }   // geometry occludes
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 vd = normalize(vec3(ndc.x / uProj[0][0], ndc.y / uProj[1][1], -1.0));
  vec3 wd = transpose(mat3(uView)) * vd;
  float mu = max(dot(wd, uSun), 0.0);
  vec3 c = min(texture(uSrc, vUv).rgb, vec3(8.0));
  // only the bright sky around the sun feeds the shafts
  float b = smoothstep(0.7, 2.5, libLuma(c)) * smoothstep(-0.02, 0.06, wd.y);   // sky only (not sea glints)
  fragColor = vec4(c * b * (pow(mu, 4.0) * 0.5 + pow(mu, 32.0) * 1.5), 1.0);
}`;

const FS_RAYS = `
uniform sampler2D uSrc; uniform vec2 uSunUv; uniform vec2 uParam; // x density (fraction of the way to the sun), y decay
void main(){
  vec2 dlt = (uSunUv - vUv) * (uParam.x / 24.0);
  vec2 uv = vUv;
  vec3 acc = vec3(0.0); float w = 1.0, ws = 0.0;
  for (int i = 0; i < 24; i++) {
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    acc += texture(uSrc, uv).rgb * w;
    ws += w;
    w *= uParam.y;
    uv += dlt;
  }
  fragColor = vec4(acc / max(ws, 1.0), 1.0);
}`;

const FS_COMP = `
uniform sampler2D uSrc; uniform sampler2D uDepth; uniform sampler2D uBloom; uniform sampler2D uDof; uniform sampler2D uAO; uniform sampler2D uRays;
uniform vec4 uOn;      // x bloom, y dof, z ao, w rays
uniform vec2 uBloomP;  // x intensity (already normalized by level weights)
uniform vec3 uRaysCol;
uniform vec3 uTint; uniform vec3 uTintData; uniform vec3 uLift; uniform vec3 uGamma; uniform vec3 uGain;
uniform vec4 uGradeP;  // x saturation, y contrast, z vignette, w chromatic aberration
uniform vec4 uFx;      // x grain, y time, z lightning flash, w writes to canvas (grain here)
uniform float uAoStr;
uniform float uAoBilateral;
uniform float uScotopic;
uniform float uKeepHue;
const mat3 ACES_IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
const mat3 ACES_OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
vec3 rrtOdt(vec3 v){ return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081); }
vec3 acesFilm(vec3 v){ return clamp(ACES_OUT * rrtOdt(ACES_IN * v), 0.0, 1.0); }
// ACES desaturates bright lights to white; blending in a hue-preserving (luminance-mapped) version keeps
// warm windows warm and neon signs colorful.
vec3 tonemap(vec3 c, float keepHue){
  vec3 a = acesFilm(c);
  float L = max(libLuma(c), 1e-5);
  vec3 b = c * (clamp(rrtOdt(vec3(L)).x, 0.0, 1.0) / L);
  b /= max(1.0, max(b.r, max(b.g, b.b)));
  return mix(a, b, keepHue * smoothstep(0.2, 1.0, L));
}
// Depth-aware 2x upsample of the half-res AO: bilinear weights x depth similarity (no halos on silhouettes).
float aoUpsample(vec2 uv, float z){
  vec2 hs = vec2(textureSize(uAO, 0));
  vec2 p = uv * hs - 0.5;
  vec2 f = fract(p);
  ivec2 i0 = ivec2(floor(p)), mx = ivec2(hs) - 1;
  float s = 0.0, ws = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    vec2 t = texelFetch(uAO, clamp(i0 + o, ivec2(0), mx), 0).rg;
    float wb = (o.x == 0 ? 1.0 - f.x : f.x) * (o.y == 0 ? 1.0 - f.y : f.y);
    float w = wb / (1e-3 + abs(t.y - z) / z * 40.0) + 1e-5;
    s += t.x * w;
    ws += w;
  }
  return s / ws;
}
vec3 toSrgb(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main(){
  vec2 uv = vUv;
  vec2 dc = uv - 0.5;
  vec4 c0 = texture(uSrc, uv);
  vec3 col = c0.rgb;
  if (uGradeP.w > 0.0) {
    vec2 off = dc * dot(dc, dc) * uGradeP.w;
    col.r = texture(uSrc, uv + off).r;
    col.b = texture(uSrc, uv - off).b;
  }
  float d = texture(uDepth, uv).r;
  float zw = waterZ(uv, d, c0.a);
  float sky = d >= 0.99999 && zw == 0.0 ? 1.0 : 0.0;
  float z = zw > 0.0 ? zw : linZ(d);
  float ovm = c0.a >= 0.4 ? clamp((1.0 - c0.a) * 4.0, 0.0, 1.0) : 0.0;   // data (overlay) pixel mark
  // aerial perspective (same start as libFogAmount: just before the view target)
  float fogK = sky > 0.5 ? 1.0 : 1.0 - exp(-max(z - uFocusZ.x * 0.8, 0.0) * uFog.w * 1.5);
  if (uOn.z > 0.5 && zw == 0.0 && sky < 0.5) {   // no SSAO on the water surface (it was computed from the seabed)
    float ao = uAoBilateral > 0.5 ? aoUpsample(uv, z) : texture(uAO, uv).r;
    ao = mix(ao, 1.0, fogK);                    // fog hides contact shadows
    col *= mix(1.0, ao, uAoStr * (1.0 - smoothstep(0.8, 3.0, libLuma(col))));
  }
  if (uOn.y > 0.5) {
    float cocPx = tiltCocZ(uv, z, sky) * uTilt.w * 2.0;
    col = mix(col, texture(uDof, uv).rgb, smoothstep(0.35, 1.6, cocPx));
  }
  col *= postExposure();
  if (uOn.x > 0.5) col += texture(uBloom, uv).rgb * uBloomP.x;
  if (uOn.w > 0.5) col += texture(uRays, uv).rgb * uRaysCol;
  col *= mix(uTint, uTintData, ovm);
  // night vision: dark areas shift toward desaturated moonlit blue, bright lights keep their color
  float sl = libLuma(col);
  col = mix(col, sl * vec3(0.62, 0.78, 1.18), uScotopic * (1.0 - ovm) * (1.0 - smoothstep(0.06, 0.6, sl)));
  // lightning: the geometry is lit in shade(); here only the sky and the rain haze flash
  col += vec3(0.5, 0.56, 0.75) * (uFx.z * 0.35 * max(fogK, 0.12));
  col = toSrgb(tonemap(max(col, vec3(0.0)), uKeepHue));
  // lift / gamma / gain, contrast, saturation (display space)
  col = col * uGain + uLift * (1.0 - col);
  col = pow(max(col, vec3(0.0)), uGamma);
  col = clamp((col - 0.5) * uGradeP.y + 0.5, 0.0, 1.0);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = clamp(mix(vec3(l), col, uGradeP.x), 0.0, 1.0);
  // vignette (aspect-corrected, soft)
  vec2 vq = dc * vec2(uScreen.x / uScreen.y, 1.0) * 0.9;
  col *= mix(1.0, smoothstep(1.05, 0.25, length(vq)), uGradeP.z);
  if (uFx.w > 0.5 && uFx.x > 0.0) {
    vec2 gp = gl_FragCoord.xy + fract(uFx.y * vec2(12.9898, 78.233)) * 512.0;
    float g = hash12(gp) + hash12(gp + 37.1) - 1.0;
    col += g * uFx.x * (4.0 * l * (1.0 - l));
  }
  l = dot(col, vec3(0.299, 0.587, 0.114));
  fragColor = vec4(col, l);
}`;

// FXAA 3.11 (quality preset 39-like: 12 search steps), luma in alpha. Adds animated film grain.
const FS_FXAA = `
uniform sampler2D uSrc; uniform vec2 uRcp; uniform vec2 uGrain;
#define EDGE_TH 0.125
#define EDGE_TH_MIN 0.0312
#define SUBPIX 0.75
const float QP[12] = float[12](1.0, 1.0, 1.0, 1.0, 1.0, 1.5, 2.0, 2.0, 2.0, 2.0, 4.0, 8.0);
float L(vec2 p){ return textureLod(uSrc, p, 0.0).a; }
vec3 fxaa(vec2 posM){
  vec4 rgbyM = textureLod(uSrc, posM, 0.0);
  float lumaM = rgbyM.a;
  float lumaS = textureLodOffset(uSrc, posM, 0.0, ivec2(0, 1)).a;
  float lumaE = textureLodOffset(uSrc, posM, 0.0, ivec2(1, 0)).a;
  float lumaN = textureLodOffset(uSrc, posM, 0.0, ivec2(0, -1)).a;
  float lumaW = textureLodOffset(uSrc, posM, 0.0, ivec2(-1, 0)).a;
  float rangeMax = max(max(lumaN, lumaW), max(lumaE, max(lumaS, lumaM)));
  float rangeMin = min(min(lumaN, lumaW), min(lumaE, min(lumaS, lumaM)));
  float range = rangeMax - rangeMin;
  if (range < max(EDGE_TH_MIN, rangeMax * EDGE_TH)) return rgbyM.rgb;
  float lumaNW = textureLodOffset(uSrc, posM, 0.0, ivec2(-1, -1)).a;
  float lumaSE = textureLodOffset(uSrc, posM, 0.0, ivec2(1, 1)).a;
  float lumaNE = textureLodOffset(uSrc, posM, 0.0, ivec2(1, -1)).a;
  float lumaSW = textureLodOffset(uSrc, posM, 0.0, ivec2(-1, 1)).a;
  float lumaNS = lumaN + lumaS, lumaWE = lumaW + lumaE;
  float subpixRcpRange = 1.0 / range;
  float subpixNSWE = lumaNS + lumaWE;
  float edgeHorz1 = -2.0 * lumaM + lumaNS, edgeVert1 = -2.0 * lumaM + lumaWE;
  float lumaNESE = lumaNE + lumaSE, lumaNWNE = lumaNW + lumaNE;
  float edgeHorz2 = -2.0 * lumaE + lumaNESE, edgeVert2 = -2.0 * lumaN + lumaNWNE;
  float lumaNWSW = lumaNW + lumaSW, lumaSWSE = lumaSW + lumaSE;
  float edgeHorz4 = abs(edgeHorz1) * 2.0 + abs(edgeHorz2);
  float edgeVert4 = abs(edgeVert1) * 2.0 + abs(edgeVert2);
  float edgeHorz3 = -2.0 * lumaW + lumaNWSW, edgeVert3 = -2.0 * lumaS + lumaSWSE;
  float edgeHorz = abs(edgeHorz3) + edgeHorz4, edgeVert = abs(edgeVert3) + edgeVert4;
  float subpixNWSWNESE = lumaNWSW + lumaNESE;
  float lengthSign = uRcp.x;
  bool horzSpan = edgeHorz >= edgeVert;
  float subpixA = subpixNSWE * 2.0 + subpixNWSWNESE;
  if (!horzSpan) { lumaN = lumaW; lumaS = lumaE; } else lengthSign = uRcp.y;
  float subpixB = subpixA * (1.0 / 12.0) - lumaM;
  float gradientN = lumaN - lumaM, gradientS = lumaS - lumaM;
  float lumaNN = lumaN + lumaM, lumaSS = lumaS + lumaM;
  bool pairN = abs(gradientN) >= abs(gradientS);
  float gradient = max(abs(gradientN), abs(gradientS));
  if (pairN) lengthSign = -lengthSign;
  float subpixC = clamp(abs(subpixB) * subpixRcpRange, 0.0, 1.0);
  vec2 posB = posM;
  vec2 offNP = horzSpan ? vec2(uRcp.x, 0.0) : vec2(0.0, uRcp.y);
  if (!horzSpan) posB.x += lengthSign * 0.5; else posB.y += lengthSign * 0.5;
  vec2 posN = posB - offNP * QP[0];
  vec2 posP = posB + offNP * QP[0];
  float subpixD = -2.0 * subpixC + 3.0;
  float lumaEndN = L(posN), lumaEndP = L(posP);
  float subpixE = subpixC * subpixC;
  if (!pairN) lumaNN = lumaSS;
  float gradientScaled = gradient * 0.25;
  float lumaMM = lumaM - lumaNN * 0.5;
  float subpixF = subpixD * subpixE;
  bool lumaMLTZero = lumaMM < 0.0;
  lumaEndN -= lumaNN * 0.5;
  lumaEndP -= lumaNN * 0.5;
  bool doneN = abs(lumaEndN) >= gradientScaled, doneP = abs(lumaEndP) >= gradientScaled;
  if (!doneN) posN -= offNP * QP[1];
  if (!doneP) posP += offNP * QP[1];
  for (int i = 2; i < 12; i++) {
    if (doneN && doneP) break;
    if (!doneN) lumaEndN = L(posN) - lumaNN * 0.5;
    if (!doneP) lumaEndP = L(posP) - lumaNN * 0.5;
    doneN = abs(lumaEndN) >= gradientScaled;
    doneP = abs(lumaEndP) >= gradientScaled;
    if (!doneN) posN -= offNP * QP[i];
    if (!doneP) posP += offNP * QP[i];
  }
  float dstN = horzSpan ? posM.x - posN.x : posM.y - posN.y;
  float dstP = horzSpan ? posP.x - posM.x : posP.y - posM.y;
  bool goodSpanN = (lumaEndN < 0.0) != lumaMLTZero;
  bool goodSpanP = (lumaEndP < 0.0) != lumaMLTZero;
  float spanLengthRcp = 1.0 / (dstP + dstN);
  bool directionN = dstN < dstP;
  float dst = min(dstN, dstP);
  bool goodSpan = directionN ? goodSpanN : goodSpanP;
  float subpixG = subpixF * subpixF;
  float pixelOffset = dst * (-spanLengthRcp) + 0.5;
  float subpixH = subpixG * SUBPIX;
  float pixelOffsetSubpix = max(goodSpan ? pixelOffset : 0.0, subpixH);
  if (!horzSpan) posM.x += pixelOffsetSubpix * lengthSign; else posM.y += pixelOffsetSubpix * lengthSign;
  return textureLod(uSrc, posM, 0.0).rgb;
}
void main(){
  vec3 col = fxaa(vUv);
  if (uGrain.x > 0.0) {
    vec2 gp = gl_FragCoord.xy + fract(uGrain.y * vec2(12.9898, 78.233)) * 512.0;
    float g = hash12(gp) + hash12(gp + 37.1) - 1.0;
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col += g * uGrain.x * (4.0 * l * (1.0 - l));
  }
  fragColor = vec4(col, 1.0);
}`;

const FS_SHOW = `
uniform sampler2D uSrc; uniform int uMode;
void main(){
  vec4 c = texture(uSrc, vUv);
  vec3 o = c.rgb;
  if (uMode == 1) o = vec3(c.a);
  else if (uMode == 2) o = vec3(c.r);
  else if (uMode == 3) o = vec3(c.r);
  else if (uMode == 4) o = vec3(fract(c.r * 8.0));
  else o = o / (1.0 + o);
  fragColor = vec4(pow(o, vec3(1.0 / 2.2)), 1.0);
}`;
