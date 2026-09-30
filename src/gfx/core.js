/*
 * VOXELPOLIS — WebGL2 core: context, shader programs, buffers, textures, render targets,
 * the Frame UBO, environment lighting (time of day / season / weather), render-layer
 * orchestration, the shared tile-data texture, and an immediate-mode gizmo renderer.
 *
 * RENDER LAYERS register with VC.gfx.addLayer(layer):
 *   layer = { name, order, shadow(ctx)?, opaque(ctx)?, transparent(ctx)? }
 *   Lower order draws first. Before EVERY layer call the core resets GL state to:
 *     depth test LEQUAL on, cull BACK on (CCW front faces), blend off, depthMask true   (opaque)
 *     same, but cull FRONT + slope-scaled polygon offset, color writes off               (shadow)
 *     depth test LEQUAL on, cull BACK on, blend SRC_ALPHA/ONE_MINUS_SRC_ALPHA on, depthMask false (transparent)
 *   so layers may change state freely without restoring it.
 *   SHADOW CASTERS: the shadow map stores the surfaces facing AWAY from the light (front faces are culled),
 *   so closed voxel meshes never self-shadow (no acne, no peter-panning, LOD meshes are safe). Draw closed
 *   meshes as-is; for open or single-sided casters (flat sprites, planes) call gl.disable(gl.CULL_FACE).
 *   Use a cheap fragment shader there (see G.depthProgram) — shadow maps have more pixels than the screen.
 *   ctx = { gl, pass: 'shadow'|'opaque'|'transparent', S (state), time, dt, cam: VC.camera, env: VC.gfx.env,
 *           viewProj, frustum, cascade }
 *   During the shadow pass the Frame UBO's uViewProj holds the LIGHT view-projection,
 *   so layers can reuse their normal vertex shaders (write depth only).
 *   ctx.viewProj = the matrix in uViewProj for this pass (camera, or light during 'shadow');
 *   ctx.frustum  = its 6 planes (Float32Array(24), see G.frustumPlanes) — CULL AGAINST THIS, not the
 *                  camera, so off-screen casters still cast into the view. Use G.boxVisible / G.sphereVisible.
 *   ctx.cascade  = -1 (camera passes) or the shadow cascade index 0 (near) / 1 (far: layers may skip
 *                  tiny casters such as agents/props there).
 *   Polygon offset (slope-scaled depth bias) is enabled by the core during the shadow pass.
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
  shadowFar: null, // {k, ox, oy} far-cascade mapping relative to the near cascade (set by VC.shadows)
  shadowBias: null, // [factor, units] polygon offset used during the shadow pass (set by VC.shadows)
  camFrustum: new Float32Array(24),
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

  // Fallback tonemap (used only when VC.post is missing or failed).
  G._tonemap = G.program(
    'core_tonemap',
    `out vec2 vUv; void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`,
    `in vec2 vUv; uniform sampler2D uSrc; uniform float uExposure; out vec4 fragColor;
     vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
     void main(){ vec3 c = texture(uSrc, vUv).rgb; c = aces(c * uExposure * 0.8); c = pow(c, vec3(1.0/2.2));
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

/**
 * Depth-only variant of a layer program for the SHADOW pass: same vertex body (same attributes and
 * uniforms, e.g. uViewProj from the Frame UBO), empty fragment shader. Shadow maps have many more pixels
 * than the screen (up to 6144x3072), so layers should never run their full lighting shader there.
 * (Use your own FS instead only if you need `discard`, e.g. construction clipping or alpha-tested leaves.)
 */
G.depthProgram = function (name, vsBody, opts = {}) {
  return G.program(name, vsBody, 'void main(){}', opts);
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

/**
 * Dynamic resolution: adapts G.autoScale (0.5..1, steps of 0.05) to hold ~50+ fps. Called every frame.
 * Measures 1 s windows. Drops after 2 consecutive slow windows (> 24 ms); probes upward after 4 fast
 * windows (< 18.5 ms — works with 60 Hz vsync). A scale that proved too slow becomes a ceiling for
 * 30 s, and each change is followed by a 1.5 s settle period, so the resolution never oscillates.
 */
const AQ = { t: 0, n: 0, slow: 0, fast: 0, settle: 0, ceiling: 1, ceilT: 0 };
function autoQuality(rdt) {
  if (!VC.settings || !VC.settings.autoQuality) {
    if (G.autoScale !== 1) { G.autoScale = 1; G.resize(); }
    AQ.t = AQ.n = AQ.slow = AQ.fast = 0;
    return;
  }
  if (typeof document !== 'undefined' && document.hidden) return;
  AQ.settle -= rdt;
  AQ.ceilT -= rdt;
  if (AQ.settle > 0) return; // ignore frames right after a resolution change
  AQ.t += rdt;
  AQ.n++;
  if (AQ.t < 1.0) return;
  const ms = (AQ.t / AQ.n) * 1000;
  AQ.t = AQ.n = 0;
  if (AQ.ceilT <= 0) AQ.ceiling = 1;
  if (ms > 24) { AQ.slow++; AQ.fast = 0; }
  else if (ms < 18.5) { AQ.fast++; AQ.slow = 0; }
  else { AQ.slow = 0; AQ.fast = 0; }
  let s = G.autoScale;
  if (AQ.slow >= 2) {
    AQ.ceiling = s;
    AQ.ceilT = 30;
    s -= ms > 40 ? 0.15 : 0.05;
    AQ.slow = 0;
  } else if (AQ.fast >= 4 && s < 1) {
    const next = s + 0.05;
    if (next < AQ.ceiling - 1e-3) s = next;
    AQ.fast = 0;
  }
  s = Math.round(M.clamp(s, 0.5, 1) * 20) / 20;
  if (s !== G.autoScale) {
    G.autoScale = s;
    AQ.settle = 1.5;
    G.resize();
  }
}

/* ------------------------------------------------------------------ */
/* Frustum culling helpers                                              */
/* ------------------------------------------------------------------ */
/**
 * Extracts the 6 planes (a,b,c,d; inside when a*x+b*y+c*z+d >= 0) of view-projection m into out
 * (Float32Array(24)). Order: left, right, bottom, top, near, far.
 */
G.frustumPlanes = function (m, out) {
  out = out || new Float32Array(24);
  for (let p = 0; p < 6; p++) {
    const r = p >> 1, sg = p & 1 ? -1 : 1; // row 0,0,1,1,2,2 with +/-
    let a = m[3] + sg * m[r], b = m[7] + sg * m[4 + r], c = m[11] + sg * m[8 + r], d = m[15] + sg * m[12 + r];
    const l = Math.hypot(a, b, c) || 1;
    out[p * 4] = a / l; out[p * 4 + 1] = b / l; out[p * 4 + 2] = c / l; out[p * 4 + 3] = d / l;
  }
  return out;
};
/** True if the axis-aligned box intersects the frustum (conservative). */
G.boxVisible = function (pl, x0, y0, z0, x1, y1, z1) {
  for (let p = 0; p < 24; p += 4) {
    const a = pl[p], b = pl[p + 1], c = pl[p + 2];
    if (a * (a > 0 ? x1 : x0) + b * (b > 0 ? y1 : y0) + c * (c > 0 ? z1 : z0) + pl[p + 3] < 0) return false;
  }
  return true;
};
/** True if the sphere intersects the frustum. */
G.sphereVisible = function (pl, x, y, z, r) {
  for (let p = 0; p < 24; p += 4) if (pl[p] * x + pl[p + 1] * y + pl[p + 2] * z + pl[p + 3] < -r) return false;
  return true;
};

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
  gl.cullFace(pass === 'shadow' ? gl.FRONT : gl.BACK);
  gl.frontFace(gl.CCW);
  if (pass === 'shadow' && G.shadowBias) {
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(G.shadowBias[0], G.shadowBias[1]);
  } else gl.disable(gl.POLYGON_OFFSET_FILL);
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
/*
 * Time-of-day palette keyed by the sun elevation h (y of the unit sun vector): deep night, blue hour,
 * pink/purple dusk, sunset, golden hour, morning, noon. Every key: sun radiance (rgb * intensity),
 * sky ambient, ground bounce, fog/horizon color, exposure. Interpolated with smoothstep between keys.
 */
const TOD_KEYS = [
  // h      sun (radiance)          sky ambient            ground bounce          fog / horizon           exposure
  [-1.0, [0, 0, 0], [0.03, 0.045, 0.1], [0.014, 0.013, 0.018], [0.01, 0.017, 0.04], 1.6],
  [-0.24, [0, 0, 0], [0.03, 0.045, 0.1], [0.014, 0.013, 0.018], [0.01, 0.017, 0.04], 1.6],
  [-0.14, [0, 0, 0], [0.06, 0.085, 0.2], [0.024, 0.024, 0.036], [0.05, 0.075, 0.18], 1.5],
  [-0.06, [0, 0, 0], [0.2, 0.17, 0.3], [0.07, 0.05, 0.05], [0.4, 0.26, 0.32], 1.3],
  [0.0, [0.6, 0.2, 0.05], [0.36, 0.28, 0.34], [0.16, 0.1, 0.07], [0.72, 0.44, 0.36], 1.12],
  [0.07, [2.3, 1.1, 0.4], [0.42, 0.38, 0.46], [0.28, 0.19, 0.12], [0.86, 0.62, 0.46], 0.98],
  [0.18, [3.0, 2.0, 1.05], [0.42, 0.46, 0.6], [0.3, 0.24, 0.17], [0.78, 0.72, 0.68], 0.92],
  [0.36, [3.2, 2.8, 2.25], [0.4, 0.52, 0.74], [0.3, 0.27, 0.2], [0.64, 0.76, 0.9], 0.88],
  [0.7, [3.35, 3.2, 2.95], [0.4, 0.54, 0.8], [0.3, 0.28, 0.21], [0.6, 0.75, 0.93], 0.86],
  [1.01, [3.35, 3.2, 2.95], [0.4, 0.54, 0.8], [0.3, 0.28, 0.21], [0.6, 0.75, 0.93], 0.86],
];
G.TOD_KEYS = TOD_KEYS; // exposed for tuning / debugging
function todLookup(h, out) {
  let i = 0;
  while (i < TOD_KEYS.length - 2 && h > TOD_KEYS[i + 1][0]) i++;
  const A = TOD_KEYS[i], B = TOD_KEYS[i + 1];
  const t = M.smoothstep(A[0], B[0], h);
  for (let k = 1; k <= 4; k++) for (let c = 0; c < 3; c++) out[k - 1][c] = A[k][c] + (B[k][c] - A[k][c]) * t;
  out[4] = A[5] + (B[5] - A[5]) * t;
  return out;
}
const _tod = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], 1];
const lum3 = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
/** Mixes c toward its grey value by t (desaturate) and scales by s, in place. */
function greyish(c, t, s) {
  const l = lum3(c);
  for (let i = 0; i < 3; i++) c[i] = (c[i] + (l - c[i]) * t) * s;
}
/** Sun direction for path angle a (radians, 0 = sunrise) and season (0..4). Mirrored by libSunDir() in GLSL. */
G.sunDirection = function (a, season, out) {
  const s = Math.cos((season - 1) * Math.PI * 0.5); // 1 summer (high sun) .. -1 winter (low sun)
  const x = Math.cos(a) * 0.85, y = Math.sin(a), z = -(0.42 - 0.12 * s);
  const l = Math.hypot(x, y, z);
  out = out || [0, 0, 0];
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
};

G.computeEnv = function (S) {
  const st = VC.settings || {};
  let tod = S ? S.time.tod : 0.35;
  if (st.dayNight === 'day') tod = 0.42;
  else if (st.dayNight === 'sunset') tod = 0.72;
  else if (st.dayNight === 'night') tod = 0.93;
  const wx = (S && S.weather) || { cloud: 0.2, wet: 0, fog: 0, wind: 0.5, windDir: 0.6, lightning: 0 };
  const cloud = M.sat(wx.cloud || 0), wet = M.sat(wx.wet || 0), wfog = M.sat(wx.fog || 0);
  const e = G.env || (G.env = { sunDir: [0, 1, 0], sun: [0, 1, 0], moon: [0, 1, 0], sunColor: [1, 1, 1], skyAmb: [0, 0, 0], groundAmb: [0, 0, 0], fog: [0, 0, 0], wind: [1, 0] });

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

  // Sun path: rises in the east (+X), sets in the west, tilted toward -Z (lower in winter).
  const a = (tod - 0.25) * M.PI2;
  const sun = G.sunDirection(a, season, e.sun);
  const ma = -Math.cos(a) * 0.7, mb = Math.max(0.35, -Math.sin(a)), ml = Math.hypot(ma, mb, 0.5);
  const moon = e.moon;
  moon[0] = ma / ml; moon[1] = mb / ml; moon[2] = 0.5 / ml;
  const h = sun[1];
  const night = M.smoothstep(0.08, -0.18, h); // 0 day .. 1 night
  const dusk = M.smoothstep(0.45, 0.02, Math.abs(h)) * (1 - night);
  const golden = M.smoothstep(0.34, 0.1, h) * M.smoothstep(-0.03, 0.05, h);
  const blueHour = M.smoothstep(-0.03, -0.1, h) * M.smoothstep(-0.26, -0.14, h);

  const P = todLookup(h, _tod);
  const sunRad = P[0], sky = P[1], gnd = P[2], fog = P[3];
  let exposure = P[4];

  // key light: sun by day, moon by night (keyVis crossfades through 0 at the switch)
  const useMoon = h < -0.02;
  const overcast = 1 - cloud * 0.62 - wet * 0.22; // clouds + rain dim and flatten the direct light
  const col = e.sunColor;
  if (useMoon) {
    const mi = 0.3 * M.smoothstep(-0.02, -0.2, h) * (1 - cloud * 0.7);
    col[0] = 0.5 * mi; col[1] = 0.64 * mi; col[2] = 1.0 * mi;
  } else for (let i = 0; i < 3; i++) col[i] = sunRad[i] * overcast;
  const keyVis = useMoon ? M.smoothstep(-0.02, -0.12, h) : M.smoothstep(-0.02, 0.05, h);
  const dir = e.sunDir;
  const kd = useMoon ? moon : sun;
  dir[0] = kd[0]; dir[1] = kd[1]; dir[2] = kd[2];

  // overcast: flatter, greyer ambient that partly replaces the lost sunlight; rain darkens
  const flat = cloud * 0.65 + wet * 0.3;
  greyish(sky, flat * 0.6, (1 + cloud * 0.35 * (1 - night)) * (1 - wet * 0.22));
  greyish(gnd, flat * 0.4, 1 - wet * 0.3);
  greyish(fog, cloud * 0.55 + wet * 0.35, (1 - wet * 0.25) * (1 - cloud * 0.12));
  // snow cover: bright, cool ground bounce
  if (snow > 0) {
    const sl = lum3(sky) * 0.95 + lum3(col) * keyVis * 0.12;
    gnd[0] += (sl * 0.92 - gnd[0]) * snow * 0.7;
    gnd[1] += (sl * 0.96 - gnd[1]) * snow * 0.7;
    gnd[2] += (sl * 1.05 - gnd[2]) * snow * 0.7;
    exposure *= 1 - snow * 0.08 * (1 - night);
  }
  // weather: darker scenes get a bit more exposure
  exposure *= 1 + cloud * 0.12 + wet * 0.1;

  // Fog density: thin, relative to the camera distance so overviews stay crisp; weather fog is thick.
  const camD = (VC.camera && VC.camera.dist) || 45;
  const baseDen = 0.0042 * Math.pow(45 / Math.max(20, camD), 0.7);
  const fogDensity = baseDen * (1 + cloud * 0.4) + wfog * 0.028 + wet * 0.006;

  const wa = wx.windDir || 0;
  e.tod = tod; e.sunAngle = a; e.sunUp = h;
  e.keyVis = keyVis; e.night = night; e.dusk = dusk; e.golden = golden; e.blueHour = blueHour;
  for (let i = 0; i < 3; i++) { e.skyAmb[i] = sky[i]; e.groundAmb[i] = gnd[i]; e.fog[i] = fog[i]; }
  e.fogDensity = fogDensity; e.season = season; e.snow = snow;
  e.wet = wet; e.cloud = cloud; e.fogWeather = wfog;
  e.wind[0] = Math.cos(wa); e.wind[1] = Math.sin(wa);
  e.windStrength = wx.wind == null ? 0.5 : wx.wind;
  e.lightning = wx.lightning || 0;
  e.exposure = exposure;
  e.weather = (S && S.weather && S.weather.type) || 'clear';
  return e;
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
  // uPad: far shadow cascade mapping (k, offset) relative to the near cascade, and the sun path angle
  const sf = G.shadowTex && G.shadowFar;
  v4(sf ? sf.k : 0, sf ? sf.ox : 0, sf ? sf.oy : 0, e.sunAngle || 0);
  gl.bindBuffer(gl.UNIFORM_BUFFER, G.ubo);
  gl.bufferSubData(gl.UNIFORM_BUFFER, 0, f);
};

/** Shadow module reports its result here. tex = depth texture (compare mode) or null. */
G.setShadow = function (tex, mat) {
  G.shadowTex = tex;
  G.shadowMat = mat;
  if (!tex) G.shadowFar = null;
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

  G.frustumPlanes(cam.viewProj, G.camFrustum);
  const ctx = { gl, pass: '', S, time: G.time, dt, rdt, cam, env: G.env, viewProj: cam.viewProj, frustum: G.camFrustum, cascade: -1 };

  // shared textures
  gl.activeTexture(gl.TEXTURE0 + U.NOISE);
  gl.bindTexture(gl.TEXTURE_2D, G.noiseTex);
  gl.activeTexture(gl.TEXTURE0 + U.TILE);
  gl.bindTexture(gl.TEXTURE_2D, G.tileTex || G.noiseTex);
  gl.activeTexture(gl.TEXTURE0 + U.SHADOW);
  gl.bindTexture(gl.TEXTURE_2D, G.dummyShadow);
  gl.activeTexture(gl.TEXTURE0);

  if (G._prof) profMark('setup');
  // ---- shadow pass ----
  G.shadowTex = null;
  G.shadowMat = null;
  G.shadowFar = null;
  const st = VC.settings || {};
  if (S && VC.shadows && VC.shadows.render && st.shadows !== false && G.quality().shadow > 0) {
    try {
      VC.shadows.render(ctx);
    } catch (e) {
      if (!G._shadowErr) console.error('[gfx] shadows failed', e);
      G._shadowErr = true;
      G.shadowTex = null;
      G.shadowFar = null;
    }
    ctx.viewProj = cam.viewProj;
    ctx.frustum = G.camFrustum;
    ctx.cascade = -1;
  }
  gl.activeTexture(gl.TEXTURE0 + U.SHADOW);
  gl.bindTexture(gl.TEXTURE_2D, G.shadowTex || G.dummyShadow);
  gl.activeTexture(gl.TEXTURE0);

  if (G._prof) profMark('shadow');
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
    if (G._prof) profMark('opaque');
    G.drawLayers('transparent', ctx);
    drawGizmos();
    if (G._prof) profMark('transparent');
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
    gl.uniform1f(G._tonemap.u.uExposure, G.env.exposure || 1);
    G.fullscreen();
  }
  gl.enable(gl.DEPTH_TEST);
  if (G._prof) profMark('post');
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
/* GPU-synchronous phase timing (debug only: stalls the pipeline). */
const _profPx = new Uint8Array(4);
function profMark(name) {
  const gl = G.gl, p = G._prof;
  const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, _profPx);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const t = performance.now();
  p[name] = +(t - p._t).toFixed(2);
  p._t = t;
}
/**
 * Renders one frame synchronously and returns per-phase GPU+CPU times in ms
 * {setup, shadow, opaque, transparent, post, total}. Debug/benchmark only (stalls the GPU).
 */
G.profile = function () {
  const gl = G.gl;
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, _profPx);
  const t0 = performance.now();
  G._prof = { _t: t0 };
  try { G.render(0, 1 / 60); } finally {
    const p = G._prof;
    G._prof = null;
    delete p._t;
    p.total = +(performance.now() - t0).toFixed(2);
    return p;
  }
};

G.capture = function (maxW = 320, type = 'image/jpeg') {
  return new Promise((resolve) => {
    (G._captures || (G._captures = [])).push({ maxW, type, resolve });
  });
};
