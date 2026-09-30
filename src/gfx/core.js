/*
 * VOXELPOLIS — WebGL2 core: context, shader programs, buffers, textures, render targets,
 * the Frame UBO, environment lighting (time of day / season / weather), render-layer
 * orchestration, the shared tile-data texture, and an immediate-mode gizmo renderer.
 *
 * RENDER LAYERS register with VC.gfx.addLayer(layer):
 *   layer = { name, order, shadow(ctx)?, opaque(ctx)?, transparent(ctx)? }
 *   Lower order draws first. Before EVERY layer call the core resets GL state to:
 *     depth test LEQUAL on, cull BACK on (CCW front faces), blend off, depthMask true   (shadow/opaque)
 *     depth test LEQUAL on, cull BACK on, blend SRC_ALPHA/ONE_MINUS_SRC_ALPHA on, depthMask false (transparent)
 *   so layers may change state freely without restoring it.
 *   ctx = { gl, pass: 'shadow'|'opaque'|'transparent', S (state), time, dt, cam: VC.camera, env: VC.gfx.env }
 *   During the shadow pass the Frame UBO's uViewProj holds the LIGHT view-projection,
 *   so layers can reuse their normal vertex shaders (write depth only).
 *
 * OPTIONAL MODULE HOOKS (implemented by other files, detected at runtime):
 *   VC.shadows.render(ctx)  — renders the shadow map; must call VC.gfx.drawLayers('shadow', ctx)
 *                             and VC.gfx.setShadow(texture, shadowMat) (or setShadow(null) to disable)
 *   VC.post.render(ctx)     — full post-processing chain from VC.gfx.hdr (color + depth textures)
 *                             to the default framebuffer. If absent, a basic tonemap is used.
 *   VC.post.resize(w, h)    — called when the internal render size changes.
 */
const M = VC.M, V3 = VC.V3;
const G = (VC.gfx = {
  gl: null,
  canvas: null,
  caps: {},
  layers: [],
  programs: {},
  W: 1, H: 1, // canvas drawing-buffer size
  rw: 1, rh: 1, // internal render-target size (W,H * resScale)
  resScale: 1,
  autoScale: 1,
  env: null,
  overlay: 'none',
  frameData: new Float32Array(VC.shaderlib.FRAME_FLOATS),
  frameCount: 0,
  time: 0,
  fps: 60,
  frameMs: 16,
  shadowTex: null,
  shadowMat: null,
  stats: { drawCalls: 0, tris: 0 },
});

const U = { SHADOW: 7, TILE: 6, NOISE: 5 };
G.UNIT = U;

/* ------------------------------------------------------------------ */
/* Init                                                                 */
/* ------------------------------------------------------------------ */
G.init = function (canvas) {
  G.canvas = canvas;
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return false;
  G.gl = gl;
  G.caps.floatRT = !!gl.getExtension('EXT_color_buffer_float');
  G.caps.floatLinear = !!gl.getExtension('OES_texture_float_linear');
  G.caps.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  G.caps.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  G.caps.renderer = (() => {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  })();

  // Frame UBO
  G.ubo = gl.createBuffer();
  gl.bindBuffer(gl.UNIFORM_BUFFER, G.ubo);
  gl.bufferData(gl.UNIFORM_BUFFER, G.frameData.byteLength, gl.DYNAMIC_DRAW);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, G.ubo);

  G.emptyVao = gl.createVertexArray();
  G.noiseTex = makeNoiseTexture(gl);
  G.dummyShadow = G.texture({ w: 1, h: 1, internal: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT, filter: gl.LINEAR, compare: true, data: new Uint32Array([0xffffffff]) });
  G.tileTex = null;
  G.tileTexDirty = true;

  G._tonemap = G.program(
    'core_tonemap',
    `out vec2 vUv; void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`,
    `in vec2 vUv; uniform sampler2D uSrc; out vec4 fragColor;
     vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
     void main(){ vec3 c = texture(uSrc, vUv).rgb; c = aces(c * 1.0); c = pow(c, vec3(1.0/2.2));
       vec2 q = vUv - 0.5; c *= 1.0 - dot(q, q) * 0.45; fragColor = vec4(c, 1.0); }`
  );

  initGizmos();
  VC.bus.on('dirty', () => (G.tileTexDirty = true));
  VC.bus.on('mapsUpdated', () => (G.tileTexDirty = true));
  VC.bus.on('flagsUpdated', () => (G.tileTexDirty = true));
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    VC.bus.emit('toast', { text: 'Graphics context lost — please reload the page.', type: 'error' });
  });
  G.resize();
  window.addEventListener('resize', () => G.resize());
  return true;
};

/* ------------------------------------------------------------------ */
/* Programs                                                             */
/* ------------------------------------------------------------------ */
/**
 * Compiles a program. vs/fs are BODIES (no #version); the shaderlib header is prepended.
 * Returns { prog, u: {uniformName: location}, name, use() }.
 * Samplers uShadowMap/uTileTex/uNoiseTex are auto-bound to their units; the Frame block to binding 0.
 * opts.defines: string of #define lines. opts.attribs: {name: location} bound before link.
 */
G.program = function (name, vsBody, fsBody, opts = {}) {
  const gl = G.gl;
  const defs = opts.defines || '';
  const vsSrc = VC.shaderlib.build('vs', vsBody, defs);
  const fsSrc = VC.shaderlib.build('fs', fsBody, defs);
  const vs = compile(gl.VERTEX_SHADER, vsSrc, name + '.vs');
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc, name + '.fs');
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  if (opts.attribs) for (const k in opts.attribs) gl.bindAttribLocation(prog, opts.attribs[k], k);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    console.error(`[gfx] link error in program "${name}":\n${log}`);
    throw new Error('Program link failed: ' + name);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  const blk = gl.getUniformBlockIndex(prog, 'Frame');
  if (blk !== gl.INVALID_INDEX) gl.uniformBlockBinding(prog, blk, 0);
  const u = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    const nm = info.name.replace(/\[0\]$/, '');
    const loc = gl.getUniformLocation(prog, info.name);
    if (loc) u[nm] = loc;
  }
  gl.useProgram(prog);
  if (u.uShadowMap) gl.uniform1i(u.uShadowMap, U.SHADOW);
  if (u.uTileTex) gl.uniform1i(u.uTileTex, U.TILE);
  if (u.uNoiseTex) gl.uniform1i(u.uNoiseTex, U.NOISE);
  const P = { name, prog, u, use: () => gl.useProgram(prog) };
  G.programs[name] = P;
  return P;
};

function compile(type, src, name) {
  const gl = G.gl;
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    // Show the offending body lines (line numbers are relative to the body thanks to #line 1).
    const body = src.split('#line 1\n')[1] || src;
    const lines = body.split('\n');
    const m = /ERROR: \d+:(\d+)/.exec(log);
    let ctxt = '';
    if (m) {
      const ln = +m[1];
      for (let i = Math.max(1, ln - 3); i <= Math.min(lines.length, ln + 2); i++) ctxt += `${i === ln ? '>>' : '  '} ${i}: ${lines[i - 1]}\n`;
    }
    console.error(`[gfx] shader compile error in ${name}:\n${log}\n${ctxt}`);
    throw new Error('Shader compile failed: ' + name + ' ' + log);
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Buffers / textures / render targets                                  */
/* ------------------------------------------------------------------ */
G.buffer = function (target, data, usage) {
  const gl = G.gl;
  const b = gl.createBuffer();
  gl.bindBuffer(target, b);
  gl.bufferData(target, data, usage || gl.STATIC_DRAW);
  return b;
};

/**
 * opts: { w, h, internal, format, type, filter, wrap, data, mips, compare }
 * Defaults: RGBA8, LINEAR, CLAMP_TO_EDGE.
 */
G.texture = function (o) {
  const gl = G.gl;
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  const internal = o.internal || gl.RGBA8;
  const format = o.format || gl.RGBA;
  const type = o.type || gl.UNSIGNED_BYTE;
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, o.w, o.h, 0, format, type, o.data || null);
  const filter = o.filter || gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, o.mips ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, o.wrap || gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, o.wrap || gl.CLAMP_TO_EDGE);
  if (o.compare) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  }
  if (o.mips) gl.generateMipmap(gl.TEXTURE_2D);
  t.w = o.w;
  t.h = o.h;
  return t;
};

/** Creates a framebuffer. colors: texture or array of textures; depth: depth texture (optional). */
G.framebuffer = function (colors, depth) {
  const gl = G.gl;
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const list = colors ? (Array.isArray(colors) ? colors : [colors]) : [];
  list.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
  if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  if (list.length) gl.drawBuffers(list.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
  else gl.drawBuffers([gl.NONE]);
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (st !== gl.FRAMEBUFFER_COMPLETE) {
    console.error('[gfx] framebuffer incomplete', st.toString(16));
    return null;
  }
  return fb;
};

/** Draws a fullscreen triangle with the currently bound program (vertex shader uses gl_VertexID). */
G.fullscreen = function () {
  const gl = G.gl;
  gl.bindVertexArray(G.emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
};

/** Standard fullscreen vertex shader body for post passes: outputs vUv. */
G.FS_VS = `out vec2 vUv; void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

/** A shared index buffer for quad lists: indices (0,1,2, 0,2,3) + 4k. Grows as needed. */
G.quadIndexBuffer = function (quads) {
  const gl = G.gl;
  if (G._qib && G._qibQuads >= quads) return G._qib;
  let n = Math.max(quads, (G._qibQuads || 16384) * 2);
  const idx = new Uint32Array(n * 6);
  for (let q = 0, v = 0, i = 0; q < n; q++, v += 4) {
    idx[i++] = v; idx[i++] = v + 1; idx[i++] = v + 2;
    idx[i++] = v; idx[i++] = v + 2; idx[i++] = v + 3;
  }
  if (!G._qib) G._qib = gl.createBuffer();
  // Must not disturb a bound VAO's element binding: unbind VAO first.
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, G._qib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  G._qibQuads = n;
  return G._qib;
};

/* ------------------------------------------------------------------ */
/* Resize / resolution scaling                                          */
/* ------------------------------------------------------------------ */
G.quality = function () {
  return VC.QUALITY[(VC.settings && VC.settings.quality) || 'high'] || VC.QUALITY.high;
};
G.resize = function () {
  const gl = G.gl;
  if (!gl) return;
  const q = G.quality();
  const dpr = Math.min(window.devicePixelRatio || 1, q.maxDpr);
  const cw = Math.max(1, Math.floor(window.innerWidth * dpr));
  const ch = Math.max(1, Math.floor(window.innerHeight * dpr));
  if (G.canvas.width !== cw || G.canvas.height !== ch) {
    G.canvas.width = cw;
    G.canvas.height = ch;
  }
  G.W = cw;
  G.H = ch;
  G.resScale = M.clamp(q.scale * G.autoScale, 0.35, 1);
  const rw = Math.max(1, Math.round(cw * G.resScale));
  const rh = Math.max(1, Math.round(ch * G.resScale));
  if (rw !== G.rw || rh !== G.rh || !G.hdr) {
    G.rw = rw;
    G.rh = rh;
    createHDR();
    if (VC.post && VC.post.resize) {
      try { VC.post.resize(rw, rh); } catch (e) { console.error('[post.resize]', e); }
    }
  }
};

function createHDR() {
  const gl = G.gl;
  if (G.hdr) {
    gl.deleteFramebuffer(G.hdr.fbo);
    gl.deleteTexture(G.hdr.color);
    gl.deleteTexture(G.hdr.depth);
  }
  const float = G.caps.floatRT;
  const color = G.texture({ w: G.rw, h: G.rh, internal: float ? gl.RGBA16F : gl.RGBA8, format: gl.RGBA, type: float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE });
  const depth = G.texture({ w: G.rw, h: G.rh, internal: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT, filter: gl.NEAREST });
  const fbo = G.framebuffer(color, depth);
  G.hdr = { fbo, color, depth, w: G.rw, h: G.rh, float };
}

/** Adapts internal resolution to hold ~50+ fps. Called every frame. */
function autoQuality(rdt) {
  G._aqT = (G._aqT || 0) + rdt;
  G._aqN = (G._aqN || 0) + 1;
  if (G._aqT < 2.0) return;
  const avg = (G._aqT / G._aqN) * 1000;
  G._aqT = 0;
  G._aqN = 0;
  if (!VC.settings || !VC.settings.autoQuality) {
    if (G.autoScale !== 1) { G.autoScale = 1; G.resize(); }
    return;
  }
  let s = G.autoScale;
  if (avg > 24) s -= 0.1;
  else if (avg < 13 && s < 1) s += 0.05;
  s = M.clamp(s, 0.5, 1);
  if (Math.abs(s - G.autoScale) > 0.001) {
    G.autoScale = s;
    G.resize();
  }
}

/* ------------------------------------------------------------------ */
/* Layers                                                               */
/* ------------------------------------------------------------------ */
G.addLayer = function (layer) {
  if (G.layers.includes(layer)) return;
  G.layers.push(layer);
  G.layers.sort((a, b) => (a.order || 0) - (b.order || 0));
};
G.removeLayer = function (layer) {
  const i = G.layers.indexOf(layer);
  if (i >= 0) G.layers.splice(i, 1);
};

function resetState(pass) {
  const gl = G.gl;
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.frontFace(gl.CCW);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  if (pass === 'transparent') {
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
  } else {
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }
  gl.colorMask(pass !== 'shadow', pass !== 'shadow', pass !== 'shadow', pass !== 'shadow');
}

/** Calls fn = pass on every layer that implements it, with GL state reset before each. */
G.drawLayers = function (pass, ctx) {
  ctx.pass = pass;
  for (const L of G.layers) {
    const fn = L[pass];
    if (!fn) continue;
    resetState(pass);
    try {
      fn.call(L, ctx);
    } catch (e) {
      if (!L._errored) console.error(`[gfx] layer "${L.name}" ${pass} failed:`, e);
      L._errored = (L._errored || 0) + 1;
    }
  }
  resetState('opaque');
  G.gl.bindVertexArray(null);
};

/* ------------------------------------------------------------------ */
/* Environment: sun, moon, sky, fog, season, weather                    */
/* ------------------------------------------------------------------ */
G.computeEnv = function (S) {
  const st = VC.settings || {};
  let tod = S ? S.time.tod : 0.35;
  if (st.dayNight === 'day') tod = 0.42;
  else if (st.dayNight === 'sunset') tod = 0.735;
  else if (st.dayNight === 'night') tod = 0.93;
  const wx = (S && S.weather) || { cloud: 0.2, wet: 0, fog: 0, wind: 0.5, windDir: 0.6, lightning: 0 };

  // Sun path: rises in the east (+X), sets in the west, tilted toward -Z.
  const a = (tod - 0.25) * M.PI2;
  const sun = V3.norm([Math.cos(a) * 0.85, Math.sin(a), -0.42]);
  const moon = V3.norm([-Math.cos(a) * 0.7, Math.max(0.35, -Math.sin(a)), 0.5]);
  const sunUp = sun[1];
  const night = M.smoothstep(0.08, -0.18, sunUp); // 0 day .. 1 night
  const dusk = M.smoothstep(0.45, 0.02, Math.abs(sunUp)) * (1 - night);
  const cloudDim = 1 - wx.cloud * 0.55 - wx.wet * 0.2;

  // key light: sun by day, moon by night (crossfade around the horizon)
  const useMoon = sunUp < -0.02;
  const dir = useMoon ? moon : sun;
  const sunWarm = VC.color.mix([1.0, 0.95, 0.88], [1.0, 0.52, 0.24], dusk);
  const sunI = 3.1 * M.smoothstep(-0.02, 0.18, sunUp) * cloudDim;
  const moonI = 0.33 * M.smoothstep(-0.02, -0.2, sunUp) * (1 - wx.cloud * 0.6);
  const keyCol = useMoon ? [0.55 * moonI, 0.68 * moonI, 1.0 * moonI] : V3.scale(sunWarm, sunI);
  const keyVis = useMoon ? M.smoothstep(-0.02, -0.12, sunUp) : M.smoothstep(-0.02, 0.06, sunUp);

  const skyDay = [0.42, 0.56, 0.8], skyDusk = [0.55, 0.42, 0.45], skyNight = [0.045, 0.06, 0.12];
  let skyAmb = VC.color.mix(VC.color.mix(skyDay, skyDusk, dusk), skyNight, night);
  skyAmb = V3.scale(skyAmb, 0.95 * (1 - wx.cloud * 0.15));
  const grDay = [0.3, 0.26, 0.2], grNight = [0.02, 0.022, 0.03];
  const groundAmb = VC.color.mix(grDay, grNight, night);

  const fogDay = [0.66, 0.76, 0.88], fogDusk = [0.85, 0.6, 0.45], fogNight = [0.03, 0.045, 0.085];
  let fog = VC.color.mix(VC.color.mix(fogDay, fogDusk, dusk), fogNight, night);
  if (wx.wet > 0) fog = VC.color.mix(fog, V3.scale([0.5, 0.53, 0.58], 1 - night * 0.9), wx.wet * 0.6);
  const fogDensity = 0.0035 + wx.fog * 0.03 + wx.wet * 0.006;

  // season from month (0 spring, 1 summer, 2 autumn, 3 winter; 4 wraps)
  let season = 1, snow = 0;
  if (S) {
    const mf = (S.time.day / VC.C.DAYS_PER_MONTH) % 12; // 0 = Jan
    season = (((mf - 2) / 3) % 4 + 4) % 4;
    // snow: ramps in during Dec, full Jan-Feb, melts during March
    const m = mf;
    if (m >= 11) snow = M.smoothstep(11.0, 11.8, m);
    else if (m < 2) snow = 1;
    else if (m < 3) snow = 1 - M.smoothstep(2.0, 2.9, m);
    if (S.weather && S.weather.type === 'snow') snow = Math.max(snow, 0.6);
  }
  const wa = wx.windDir || 0;
  G.env = {
    tod, sunDir: dir, sun, moon, sunColor: keyCol, keyVis, night, dusk,
    skyAmb, groundAmb, fog, fogDensity, season, snow,
    wet: wx.wet || 0, cloud: wx.cloud || 0, wind: [Math.cos(wa), Math.sin(wa)], windStrength: wx.wind == null ? 0.5 : wx.wind,
    lightning: wx.lightning || 0,
  };
  return G.env;
};

/* ------------------------------------------------------------------ */
/* Frame UBO                                                            */
/* ------------------------------------------------------------------ */
/** Writes the Frame UBO. vp overrides uViewProj (used by the shadow pass). */
G.writeFrame = function (vp) {
  const gl = G.gl, f = G.frameData, cam = VC.camera, e = G.env, S = VC.state;
  f.set(vp || cam.viewProj, 0);
  f.set(cam.view, 16);
  f.set(cam.proj, 32);
  f.set(G.shadowMat || cam.viewProj, 48);
  let o = 64;
  const v4 = (a, b, c, d) => { f[o++] = a; f[o++] = b; f[o++] = c; f[o++] = d; };
  v4(cam.pos[0], cam.pos[1], cam.pos[2], G.time % 3600);
  v4(e.sunDir[0], e.sunDir[1], e.sunDir[2], e.keyVis);
  v4(e.sunColor[0], e.sunColor[1], e.sunColor[2], e.night);
  v4(e.skyAmb[0], e.skyAmb[1], e.skyAmb[2], e.snow);
  v4(e.groundAmb[0], e.groundAmb[1], e.groundAmb[2], e.wet);
  v4(e.fog[0], e.fog[1], e.fog[2], e.fogDensity);
  v4(e.wind[0], e.wind[1], e.windStrength, e.cloud);
  const ov = VC.OVERLAYS.find((x) => x.key === G.overlay);
  v4(S ? S.W : 1, S ? S.H : 1, VC.C.SEA_Y, G.overlay !== 'none' ? 0.75 : 0);
  v4(G.rw, G.rh, 1 / G.rw, 1 / G.rh);
  const grid = VC.tools && VC.tools.gridAlpha ? VC.tools.gridAlpha() : 0;
  v4(G.shadowTex ? 1 : 0, e.season, e.lightning, grid);
  const hov = (VC.tools && VC.tools.hover) || null;
  const sel = (VC.tools && VC.tools.selectedId) || 0;
  const ramp = ov ? { good: 0, bad: 1, value: 2, net: 3 }[ov.ramp] || 0 : 0;
  v4(hov ? hov.x : -1, hov ? hov.z : -1, sel, ramp);
  v4(0, 0, 0, 0);
  gl.bindBuffer(gl.UNIFORM_BUFFER, G.ubo);
  gl.bufferSubData(gl.UNIFORM_BUFFER, 0, f);
};

/** Shadow module reports its result here. tex = depth texture (compare mode) or null. */
G.setShadow = function (tex, mat) {
  G.shadowTex = tex;
  G.shadowMat = mat;
};

/* ------------------------------------------------------------------ */
/* Tile data texture                                                    */
/* ------------------------------------------------------------------ */
G.setOverlay = function (key) {
  if (!VC.OVERLAYS.find((o) => o.key === key)) key = 'none';
  G.overlay = key;
  G.tileTexDirty = true;
  VC.bus.emit('overlay', key);
};

function updateTileTex(S) {
  const gl = G.gl;
  if (!G.tileTex || G.tileTex.w !== S.W || G.tileTex.h !== S.H) {
    if (G.tileTex) gl.deleteTexture(G.tileTex);
    G.tileTex = G.texture({ w: S.W, h: S.H, filter: gl.NEAREST });
    G._tileData = new Uint8Array(S.W * S.H * 4);
  }
  const d = G._tileData;
  const ov = VC.OVERLAYS.find((o) => o.key === G.overlay) || VC.OVERLAYS[0];
  const map = ov.map ? S.maps[ov.map] : null;
  const F = VC.F;
  for (let i = 0, j = 0; i < S.N; i++, j += 4) {
    const fl = S.flags[i];
    const b = (fl & F.POWER ? 1 : 0) | (fl & F.WATER ? 2 : 0) | (S.road[i] ? 4 : 0) | (S.bld[i] ? 8 : 0) | (S.height[i] < VC.C.SEA ? 16 : 0) | (S.zone[i] ? 32 : 0);
    let g = 0;
    if (map) g = map[i];
    else if (ov.ramp === 'net') {
      if (S.bld[i] || S.zone[i]) g = fl & ov.flag ? 255 : 64;
      else if (fl & (ov.flag === F.POWER ? F.POWERNET : F.WATERNET)) g = 200;
    }
    d[j] = S.height[i];
    d[j + 1] = g;
    d[j + 2] = b;
    d[j + 3] = S.zone[i];
  }
  gl.bindTexture(gl.TEXTURE_2D, G.tileTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, S.W, S.H, gl.RGBA, gl.UNSIGNED_BYTE, d);
  G.tileTexDirty = false;
}

function makeNoiseTexture(gl) {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const periods = [8, 16, 32, 4];
  for (let ch = 0; ch < 4; ch++) {
    const P = periods[ch];
    const oct = [];
    for (let o = 0; o < 4; o++) {
      const p = P << o;
      const lat = new Float32Array(p * p);
      const r = M.rng(1234 + ch * 97 + o * 13);
      for (let i = 0; i < lat.length; i++) lat[i] = r();
      oct.push({ p, lat, amp: Math.pow(0.5, o) });
    }
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let s = 0, norm = 0;
        for (const { p, lat, amp } of oct) {
          const fx = (x / N) * p, fy = (y / N) * p;
          const ix = Math.floor(fx), iy = Math.floor(fy);
          let tx = fx - ix, ty = fy - iy;
          tx = tx * tx * (3 - 2 * tx);
          ty = ty * ty * (3 - 2 * ty);
          const x0 = ix % p, y0 = iy % p, x1 = (ix + 1) % p, y1 = (iy + 1) % p;
          const a = lat[y0 * p + x0], b = lat[y0 * p + x1], c = lat[y1 * p + x0], d = lat[y1 * p + x1];
          s += amp * (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty);
          norm += amp;
        }
        data[(y * N + x) * 4 + ch] = Math.round((s / norm) * 255);
      }
  }
  const t = G.texture({ w: N, h: N, data, wrap: gl.REPEAT, mips: true });
  return t;
}

/* ------------------------------------------------------------------ */
/* Gizmos: immediate-mode translucent boxes & lines for tool previews   */
/* ------------------------------------------------------------------ */
const GZ = { tris: [], lines: [] };
function initGizmos() {
  const gl = G.gl;
  GZ.prog = G.program(
    'core_gizmo',
    `layout(location=0) in vec3 aPos; layout(location=1) in vec4 aCol; out vec4 vCol; out vec3 vWp;
     void main(){ vCol = aCol; vWp = aPos; gl_Position = uViewProj * vec4(aPos, 1.0); }`,
    `in vec4 vCol; in vec3 vWp; out vec4 fragColor;
     void main(){ float pulse = 0.85 + 0.15 * sin(TIME * 6.0); fragColor = vec4(vCol.rgb * (1.0 + NIGHT * 0.5), vCol.a * pulse); }`
  );
  GZ.vbo = gl.createBuffer();
  GZ.vao = gl.createVertexArray();
  gl.bindVertexArray(GZ.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, GZ.vbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
  gl.bindVertexArray(null);
}
function gzV(arr, x, y, z, c) {
  arr.push(x, y, z, c[0], c[1], c[2], c[3] == null ? 0.35 : c[3]);
}
G.gizmo = {
  /** Axis-aligned box. color [r,g,b,a] (linear-ish 0..1). wire: also draw edges. */
  box(x0, y0, z0, x1, y1, z1, color, wire = true) {
    const t = GZ.tris, c = color;
    const q = (a, b, cc, d) => { gzV(t, ...a, c); gzV(t, ...b, c); gzV(t, ...cc, c); gzV(t, ...a, c); gzV(t, ...cc, c); gzV(t, ...d, c); };
    const p000 = [x0, y0, z0], p100 = [x1, y0, z0], p010 = [x0, y1, z0], p110 = [x1, y1, z0];
    const p001 = [x0, y0, z1], p101 = [x1, y0, z1], p011 = [x0, y1, z1], p111 = [x1, y1, z1];
    q(p010, p011, p111, p110); // top
    q(p001, p101, p111, p011); // +z
    q(p100, p000, p010, p110); // -z
    q(p101, p100, p110, p111); // +x
    q(p000, p001, p011, p010); // -x
    if (wire) {
      const lc = [Math.min(1, c[0] * 1.4 + 0.2), Math.min(1, c[1] * 1.4 + 0.2), Math.min(1, c[2] * 1.4 + 0.2), 0.9];
      const L = GZ.lines;
      const e = (a, b) => { gzV(L, ...a, lc); gzV(L, ...b, lc); };
      e(p010, p110); e(p110, p111); e(p111, p011); e(p011, p010);
      e(p000, p010); e(p100, p110); e(p101, p111); e(p001, p011);
    }
  },
  line(x0, y0, z0, x1, y1, z1, color) {
    gzV(GZ.lines, x0, y0, z0, color);
    gzV(GZ.lines, x1, y1, z1, color);
  },
  /** Thin slab covering one tile at its terrain height (follows terrain). */
  tile(x, z, color, h = 0.06) {
    const S = VC.state;
    if (!S || x < 0 || z < 0 || x >= S.W || z >= S.H) return;
    const y = Math.max(S.height[z * S.W + x] * VC.C.STEP, VC.C.SEA_Y) + 0.01;
    G.gizmo.box(x + 0.04, y, z + 0.04, x + 0.96, y + h, z + 0.96, color, false);
  },
  /** Footprint box for a building preview. */
  footprint(x, z, w, d, height, color) {
    const S = VC.state;
    const y = Math.max(S.height[z * S.W + x] * VC.C.STEP, VC.C.SEA_Y) + 0.01;
    G.gizmo.box(x + 0.02, y, z + 0.02, x + w - 0.02, y + height, z + d - 0.02, color, true);
  },
  clear() {
    GZ.tris.length = 0;
    GZ.lines.length = 0;
  },
};
function drawGizmos() {
  const gl = G.gl;
  if (!GZ.tris.length && !GZ.lines.length) return;
  resetState('transparent');
  gl.disable(gl.CULL_FACE);
  GZ.prog.use();
  gl.bindVertexArray(GZ.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, GZ.vbo);
  const all = new Float32Array(GZ.tris.length + GZ.lines.length);
  all.set(GZ.tris, 0);
  all.set(GZ.lines, GZ.tris.length);
  gl.bufferData(gl.ARRAY_BUFFER, all, gl.STREAM_DRAW);
  const nt = GZ.tris.length / 7, nl = GZ.lines.length / 7;
  if (nt) gl.drawArrays(gl.TRIANGLES, 0, nt);
  if (nl) gl.drawArrays(gl.LINES, nt, nl);
  gl.bindVertexArray(null);
  G.gizmo.clear();
}

/* ------------------------------------------------------------------ */
/* Frame                                                                */
/* ------------------------------------------------------------------ */
G.render = function (dt, rdt) {
  const gl = G.gl;
  if (!gl) return;
  G.time += rdt;
  G.frameCount++;
  G.frameMs = M.lerp(G.frameMs, rdt * 1000, 0.05);
  G.fps = 1000 / Math.max(1, G.frameMs);
  autoQuality(rdt);
  const S = VC.state;
  if (S && (G.tileTexDirty || !G.tileTex)) updateTileTex(S);
  G.computeEnv(S);
  const cam = VC.camera;
  cam.aspect = G.rw / G.rh;
  cam.computeMatrices();

  const ctx = { gl, pass: '', S, time: G.time, dt, rdt, cam, env: G.env };

  // shared textures
  gl.activeTexture(gl.TEXTURE0 + U.NOISE);
  gl.bindTexture(gl.TEXTURE_2D, G.noiseTex);
  gl.activeTexture(gl.TEXTURE0 + U.TILE);
  gl.bindTexture(gl.TEXTURE_2D, G.tileTex || G.noiseTex);
  gl.activeTexture(gl.TEXTURE0 + U.SHADOW);
  gl.bindTexture(gl.TEXTURE_2D, G.dummyShadow);
  gl.activeTexture(gl.TEXTURE0);

  // ---- shadow pass ----
  G.shadowTex = null;
  G.shadowMat = null;
  const st = VC.settings || {};
  if (S && VC.shadows && VC.shadows.render && st.shadows !== false && G.quality().shadow > 0) {
    try {
      VC.shadows.render(ctx);
    } catch (e) {
      if (!G._shadowErr) console.error('[gfx] shadows failed', e);
      G._shadowErr = true;
      G.shadowTex = null;
    }
  }
  gl.activeTexture(gl.TEXTURE0 + U.SHADOW);
  gl.bindTexture(gl.TEXTURE_2D, G.shadowTex || G.dummyShadow);
  gl.activeTexture(gl.TEXTURE0);

  // ---- main pass ----
  G.writeFrame(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, G.hdr.fbo);
  gl.viewport(0, 0, G.rw, G.rh);
  const f = G.env.fog;
  gl.clearColor(f[0], f[1], f[2], 1);
  gl.depthMask(true);
  gl.colorMask(true, true, true, true);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (S) {
    G.drawLayers('opaque', ctx);
    G.drawLayers('transparent', ctx);
    drawGizmos();
  }

  // ---- post ----
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(true);
  let posted = false;
  if (VC.post && VC.post.render) {
    try {
      VC.post.render(ctx);
      posted = true;
    } catch (e) {
      if (!G._postErr) console.error('[gfx] post failed, using basic tonemap', e);
      G._postErr = true;
    }
  }
  if (!posted) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, G.W, G.H);
    G._tonemap.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, G.hdr.color);
    gl.uniform1i(G._tonemap.u.uSrc, 0);
    G.fullscreen();
  }
  gl.enable(gl.DEPTH_TEST);
  if (G._captures && G._captures.length) {
    const list = G._captures;
    G._captures = [];
    for (const c of list) {
      try {
        const cv = document.createElement('canvas');
        const s = Math.min(1, c.maxW / G.W);
        cv.width = Math.max(1, Math.round(G.W * s));
        cv.height = Math.max(1, Math.round(G.H * s));
        cv.getContext('2d').drawImage(G.canvas, 0, 0, cv.width, cv.height);
        c.resolve(cv.toDataURL(c.type || 'image/jpeg', 0.8));
      } catch (e) {
        c.resolve(null);
      }
    }
  }
};

/** Captures the next rendered frame as a data URL (scaled to maxW px wide). Returns a Promise. */
G.capture = function (maxW = 320, type = 'image/jpeg') {
  return new Promise((resolve) => {
    (G._captures || (G._captures = [])).push({ maxW, type, resolve });
  });
};
