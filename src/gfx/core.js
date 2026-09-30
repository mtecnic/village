/*
 * VOXELPOLIS — WebGL2 core: context, shader programs, buffers, textures, render targets,
 * the Frame UBO, environment lighting (time of day / season / weather), render-layer
 * orchestration, the shared tile-data texture, and an immediate-mode gizmo renderer.
 *
 * RENDER LAYERS register with VC.gfx.addLayer(layer):
 *   layer = { name, order, shadow(ctx)?, opaque(ctx)?, transparent(ctx)?, late(ctx)?, restore()? }
 *   Lower order draws first. Before EVERY layer call the core resets GL state to:
 *     depth test LEQUAL on, cull BACK on (CCW front faces), blend off, depthMask true   (opaque)
 *     same, but cull FRONT + slope-scaled polygon offset, color writes off               (shadow)
 *     depth test LEQUAL on, cull BACK on, blend SRC_ALPHA/ONE_MINUS_SRC_ALPHA on, depthMask false (transparent)
 *     'late' = transparent state, drawn AFTER the gizmos (e.g. a ghost hologram with a depth pre-pass that
 *     must not hide the tools' footprint slabs)
 *   so layers may change state freely without restoring it.
 * HDR ALPHA CONVENTION (read by post): opaque layers write alpha 1. A layer may mark "data" pixels that must
 *   skip the night grade (scotopic blue shift / night white balance), e.g. terrain under an active overlay:
 *   alpha = 1 - 0.25 * strength (0.75 .. 1). Alpha < 0.4 marks the water surface (post then skips SSAO there
 *   and uses the sea plane for the tilt-shift depth); post also detects underwater pixels from depth alone.
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
 *
 * ENVIRONMENT (G.env, recomputed every frame by computeEnv from time of day, season and S.weather):
 *   tod, sunDir (KEY light: sun by day, moon by night), sun (true sun dir), moon, sunColor (key radiance),
 *   keyVis, night, dusk, golden, blueHour, sunUp (sun elevation), sunAngle (path angle, = UBO uPad.w),
 *   skyAmb, groundAmb, fog (horizon color), fogDensity (already scaled for the camera distance), season,
 *   snow, wet, cloud, fogWeather, wind [x,z], windStrength, lightning, exposure (base exposure for post),
 *   weather (type string). Arrays are reused between frames (copy them if you keep them).
 *   The palette is the TOD_KEYS table below (keyed by sun elevation) + weather modifiers.
 *
 * EXTRA HELPERS: G.frustumPlanes(m, out), G.boxVisible(planes, x0,y0,z0,x1,y1,z1), G.sphereVisible(planes,
 *   x,y,z,r), G.depthProgram(name, vsBody, opts) (empty-FS program for shadow casters), G.sunDirection(a,
 *   season, out), G.profile() -> per-phase GPU ms (debug; stalls), G.camFrustum (camera planes this frame),
 *   G.FIXED_TOD (settings.dayNight presets), G.aq (dynamic-resolution controller state, debug).
 * DYNAMIC RESOLUTION: autoQuality() scales the internal resolution (settings.autoQuality) from GPU-bound
 *   frames only (GPU timer queries when available; CPU-bound frames — sim ticks, autosave — never lower it).
 *
 * SHADER PROGRAMS: G.program(name, vs, fs, opts) returns {name, prog, u, use()}. Requesting the same name with
 *   identical sources returns the cached program. Programs link asynchronously where possible
 *   (KHR_parallel_shader_compile): the LINK_STATUS check is deferred until first use (P.use() or P.u).
 * SHADER WARMUP — G.warmup(...) queues work that runs spread over frames (bigger budget while no city runs,
 *   e.g. on the title screen), so the first shower / overlay / vehicle never freezes the game:
 *     G.warmup(name, vsBody, fsBody, opts)  pre-compile exactly what a later G.program(...) call will request
 *     G.warmup(fn)                          run fn later; every G.program() call inside it compiles in the
 *                                           background and returns a program that finalizes on first use
 *   G.warmup.stats() -> {queued, compiling, tasks, ready, parallel}; G.warmup.flush() finalizes everything now.
 *   The core itself queues VC.terrain.warmup(true) (all terrain feature variants).
 *
 * WEBGL CONTEXT LOSS: while lost, render() does nothing (no GL calls). On 'webglcontextrestored' the core
 *   rebuilds its own resources (UBO, noise/dummy textures, tile texture, quad index buffer, HDR target, gizmos),
 *   marks every program for recompilation (handles stay valid: they relink on next use), then calls every
 *   G.onRestore(fn, owner) callback and every layer.restore(), and emits bus 'glRestored'. Layers must recreate
 *   their buffers / VAOs / textures there (and redo per-program uniform setup such as sampler units). A layer
 *   that neither implements restore() nor registered G.onRestore(fn, layer) cannot be recovered: the core then
 *   autosaves (VC.save.autosaveSync) and reloads the page (G.restoreFallback = false disables that).
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
  initCaps(gl);
  G.caps.renderer = (() => {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  })();
  // CPU rasterizers (SwiftShader, llvmpipe, WARP): shaders get `#define LIB_SOFT` (layers may skip costly
  // extras) and the shadow map is smaller / refreshed less often, so headless tests stay responsive.
  // URL ?soft=0 / ?soft=1 overrides the detection (e.g. full-quality screenshots in headless tests).
  const softParam = new URLSearchParams(location.search).get('soft');
  G.caps.cpuRenderer = /swiftshader|llvmpipe|softpipe|software|basic render|warp/i.test(String(G.caps.renderer || '')); // (ignores ?soft)
  G.caps.software = softParam != null ? softParam === '1' : G.caps.cpuRenderer;

  initResources(gl);
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

  // tile texture: incremental updates (see updateTileTex)
  VC.bus.on('dirty', (d) => tileRect(d));
  VC.bus.on('mapsUpdated', () => (TT.maps = true));
  VC.bus.on('flagsUpdated', () => (TT.flags = true));
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); // required for 'webglcontextrestored' to fire
    onContextLost();
  });
  canvas.addEventListener('webglcontextrestored', () => onContextRestored());
  // Main-thread frame start (this callback runs before main.js' frame callback): lets the resolution
  // controller tell CPU-bound frames (simulation ticks, autosave) from GPU-bound ones.
  const tick = () => {
    G._rafStart = performance.now();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // pre-compile every terrain feature variant (rain / snow / overlay) in the background
  G.warmup(() => VC.terrain && VC.terrain.warmup && VC.terrain.warmup(true));
  G.resize();
  window.addEventListener('resize', () => G.resize());
  return true;
};

/** Extensions / capabilities (called again after a context restore: extensions must be re-enabled). */
function initCaps(gl) {
  G.caps.floatRT = !!gl.getExtension('EXT_color_buffer_float');
  G.caps.floatLinear = !!gl.getExtension('OES_texture_float_linear');
  G.caps.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  G.caps.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  PG.ext = gl.getExtension('KHR_parallel_shader_compile');
  G.caps.parallelCompile = !!PG.ext;
  GT.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  G.caps.gpuTimer = !!GT.ext;
}

/** Core GL objects (Frame UBO, shared VAO / textures). Called at init and after a context restore. */
function initResources(gl) {
  G.ubo = gl.createBuffer();
  gl.bindBuffer(gl.UNIFORM_BUFFER, G.ubo);
  gl.bufferData(gl.UNIFORM_BUFFER, G.frameData.byteLength, gl.DYNAMIC_DRAW);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, G.ubo);
  G.emptyVao = gl.createVertexArray();
  G.noiseTex = makeNoiseTexture(gl);
  G.dummyShadow = G.texture({ w: 1, h: 1, internal: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT, filter: gl.LINEAR, compare: true, data: new Uint32Array([0xffffffff]) });
  G.tileTex = null;
  G.tileTexDirty = true;
}

/* ------------------------------------------------------------------ */
/* Programs                                                             */
/* ------------------------------------------------------------------ */
/*
 * Program life cycle: 0 new (sources only) -> 1 issued (compileShader / linkProgram sent, nothing queried)
 * -> 2 ready (link checked, uniforms introspected) | 3 failed. finalize() walks the remaining steps
 * synchronously; the warmup scheduler (warmStep) issues queued programs and finalizes finished ones in the
 * background, so a status query never waits for the driver.
 */
const PG = { ext: null, queue: [], pending: [], tasks: [], lazy: 0 };

/**
 * Compiles a program. vs/fs are BODIES (no #version); the shaderlib header is prepended.
 * Returns { prog, u: {uniformName: location}, name, use() }. The same name with identical sources returns
 * the cached program (e.g. one pre-compiled by G.warmup).
 * Samplers uShadowMap/uTileTex/uNoiseTex are auto-bound to their units; the Frame block to binding 0.
 * opts.defines: string of #define lines. opts.attribs: {name: location} bound before link.
 * opts.lazy: compile in the background and return at once (finalized on first use() / P.u access).
 * Throws (after logging the compiler output) on compile / link errors when the program is finalized.
 */
G.program = function (name, vsBody, fsBody, opts = {}) {
  const defs = opts.defines || '';
  const vsSrc = VC.shaderlib.build('vs', vsBody, defs);
  const fsSrc = VC.shaderlib.build('fs', fsBody, defs);
  const attribs = opts.attribs ? JSON.stringify(opts.attribs) : '';
  let P = G.programs[name];
  if (!P || P.vsSrc !== vsSrc || P.fsSrc !== fsSrc || P.attribs !== attribs) {
    P = makeProgram(name, vsSrc, fsSrc, attribs, opts.attribs || null);
    G.programs[name] = P;
  }
  if (PG.lazy > 0 || opts.lazy) {
    if (P.state === 0 && !P.queued) { P.queued = true; PG.queue.push(P); }
    return P;
  }
  finalize(P);
  return P;
};

function makeProgram(name, vsSrc, fsSrc, attribs, attribMap) {
  const P = {
    name, vsSrc, fsSrc, attribs, attribMap,
    state: 0, err: null, queued: false, issuedAt: 0, _prog: null, _vs: null, _fs: null,
    /** The WebGLProgram (compile is issued on first access; its status is checked by use() / u). */
    get prog() {
      if (P.state === 0 && !G.lost) issue(P);
      return P._prog;
    },
    use() {
      if (P.state !== 2) finalize(P);
      G.gl.useProgram(P._prog);
    },
  };
  lazyUniforms(P);
  return P;
}
/** P.u is a getter that finalizes the program until it is ready, then a plain property. */
function lazyUniforms(P) {
  Object.defineProperty(P, 'u', {
    configurable: true,
    enumerable: true,
    get() {
      finalize(P);
      return P.u;
    },
  });
}

function issue(P) {
  const gl = G.gl;
  const vs = gl.createShader(gl.VERTEX_SHADER), fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(vs, P.vsSrc);
  gl.compileShader(vs);
  gl.shaderSource(fs, P.fsSrc);
  gl.compileShader(fs);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  if (P.attribMap) for (const k in P.attribMap) gl.bindAttribLocation(prog, P.attribMap[k], k);
  gl.linkProgram(prog);
  P._prog = prog;
  P._vs = vs;
  P._fs = fs;
  P.state = 1;
  P.issuedAt = G.frameCount;
  PG.pending.push(P);
}

function shaderError(gl, sh, src, name) {
  const log = gl.getShaderInfoLog(sh) || '';
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
  return new Error('Shader compile failed: ' + name + ' ' + log);
}

/** Completes a program: link check (waits only if the driver is still compiling), uniforms, samplers. */
function finalize(P) {
  if (P.state === 2) return;
  if (P.state === 3) throw P.err;
  const gl = G.gl;
  if (G.lost || gl.isContextLost()) throw new Error('WebGL context lost'); // (state kept: relinks after restore)
  if (P.state === 0) issue(P);
  const prog = P._prog;
  const i = PG.pending.indexOf(P);
  if (i >= 0) PG.pending.splice(i, 1);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    let err;
    if (!gl.getShaderParameter(P._vs, gl.COMPILE_STATUS)) err = shaderError(gl, P._vs, P.vsSrc, P.name + '.vs');
    else if (!gl.getShaderParameter(P._fs, gl.COMPILE_STATUS)) err = shaderError(gl, P._fs, P.fsSrc, P.name + '.fs');
    else {
      console.error(`[gfx] link error in program "${P.name}":\n${gl.getProgramInfoLog(prog)}`);
      err = new Error('Program link failed: ' + P.name);
    }
    gl.deleteShader(P._vs);
    gl.deleteShader(P._fs);
    gl.deleteProgram(prog);
    P._vs = P._fs = null;
    P.state = 3;
    P.err = err;
    throw err;
  }
  gl.deleteShader(P._vs);
  gl.deleteShader(P._fs);
  P._vs = P._fs = null;
  const blk = gl.getUniformBlockIndex(prog, 'Frame');
  if (blk !== gl.INVALID_INDEX) gl.uniformBlockBinding(prog, blk, 0);
  const u = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let k = 0; k < n; k++) {
    const info = gl.getActiveUniform(prog, k);
    const nm = info.name.replace(/\[0\]$/, '');
    const loc = gl.getUniformLocation(prog, info.name);
    if (loc) u[nm] = loc;
  }
  gl.useProgram(prog);
  if (u.uShadowMap) gl.uniform1i(u.uShadowMap, U.SHADOW);
  if (u.uTileTex) gl.uniform1i(u.uTileTex, U.TILE);
  if (u.uNoiseTex) gl.uniform1i(u.uNoiseTex, U.NOISE);
  Object.defineProperty(P, 'u', { value: u, writable: true, configurable: true, enumerable: true });
  P.state = 2;
}

/**
 * Depth-only variant of a layer program for the SHADOW pass: same vertex body (same attributes and
 * uniforms, e.g. uViewProj from the Frame UBO), empty fragment shader. Shadow maps have many more pixels
 * than the screen (up to 6144x3072), so layers should never run their full lighting shader there.
 * (Use your own FS instead only if you need `discard`, e.g. construction clipping or alpha-tested leaves.)
 */
G.depthProgram = function (name, vsBody, opts = {}) {
  return G.program(name, vsBody, 'void main(){}', opts);
};

/** Shader warmup (see the header): G.warmup(name, vsBody, fsBody, opts) or G.warmup(fn). */
G.warmup = function (a, vsBody, fsBody, opts) {
  if (typeof a === 'function') PG.tasks.push(a);
  else if (typeof a === 'string') PG.tasks.push(() => G.program(a, vsBody, fsBody, Object.assign({}, opts, { lazy: true })));
};
G.warmup.stats = function () {
  let ready = 0, failed = 0;
  for (const k in G.programs) {
    const st = G.programs[k].state;
    if (st === 2) ready++;
    else if (st === 3) failed++;
  }
  return { queued: PG.queue.length, compiling: PG.pending.length, tasks: PG.tasks.length, ready, failed, parallel: !!PG.ext };
};
/** Runs every queued warmup task and finalizes every program now (tests / loading screens). */
G.warmup.flush = function () {
  for (let guard = 0; (PG.tasks.length || PG.queue.length || PG.pending.length) && guard < 10000; guard++) warmStep(1e9, 1e9, true);
  return G.warmup.stats();
};

/*
 * One scheduler step (start of every rendered frame). With KHR_parallel_shader_compile the driver compiles
 * on worker threads: programs whose COMPLETION_STATUS is true are finalized for free. Without it, drivers
 * (ANGLE) compile lazily at the first status query, so issued programs are finalized proactively instead:
 * one per frame while no city runs (title screen), one every 30 frames in game — a predictable small cost
 * early on instead of a freeze at the first shower / overlay (not in game on CPU rasterizers, where one
 * compile takes seconds). Then queued programs are issued (maxIssue) and queued tasks run within the budget.
 */
function warmStep(budgetMs, maxIssue, all, idle) {
  if (!PG.queue.length && !PG.pending.length && !PG.tasks.length) return;
  const gl = G.gl, t0 = performance.now();
  if (PG.ext || all) {
    for (let i = 0; i < PG.pending.length; ) {
      const P = PG.pending[i];
      if (!all && !gl.getProgramParameter(P._prog, PG.ext.COMPLETION_STATUS_KHR)) { i++; continue; }
      try { finalize(P); } catch (e) { /* logged by finalize; the owner gets the error on first use */ }
      if (PG.pending[i] === P) PG.pending.splice(i, 1);
      if (performance.now() - t0 > budgetMs) return;
    }
  } else if (PG.pending.length && (idle || (G.frameCount % 30 === 0 && !G.caps.cpuRenderer))) {
    const P = PG.pending[0];
    if (G.frameCount - P.issuedAt >= 2) {
      try { finalize(P); } catch (e) { /* logged by finalize */ }
      if (PG.pending[0] === P) PG.pending.shift();
      if (performance.now() - t0 > budgetMs) return;
    }
  }
  let issued = 0;
  while (issued < maxIssue && performance.now() - t0 < budgetMs) {
    if (PG.queue.length) {
      const P = PG.queue.shift();
      P.queued = false;
      if (P.state === 0) { issue(P); issued++; }
      continue;
    }
    if (!PG.tasks.length) break;
    const task = PG.tasks.shift();
    PG.lazy++;
    try { task(); } catch (e) { console.warn('[gfx] warmup task failed', e); } finally { PG.lazy--; }
  }
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
    gl.deleteFramebuffer(fb); // never leak (callers may retry)
    // one log per distinct status (a failing target retried every frame must not flood the console)
    const key = 'fb' + st;
    if (!G._fbErr || !G._fbErr[key]) {
      (G._fbErr || (G._fbErr = {}))[key] = 1;
      if (!G.lost) console.error('[gfx] framebuffer incomplete', st.toString(16));
    }
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
    G._postFail = 0; // post gets another chance at the new size
    createHDR();
    if (VC.post && VC.post.resize) {
      try { VC.post.resize(rw, rh); } catch (e) { console.error('[post.resize]', e); }
    }
  }
};

function createHDR() {
  const gl = G.gl;
  if (G.hdr) {
    if (G.hdr.fbo) gl.deleteFramebuffer(G.hdr.fbo);
    gl.deleteTexture(G.hdr.color);
    gl.deleteTexture(G.hdr.depth);
  }
  const float = G.caps.floatRT;
  const color = G.texture({ w: G.rw, h: G.rh, internal: float ? gl.RGBA16F : gl.RGBA8, format: gl.RGBA, type: float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE });
  const depth = G.texture({ w: G.rw, h: G.rh, internal: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT, filter: gl.NEAREST });
  const fbo = G.framebuffer(color, depth);
  G.hdr = { fbo, color, depth, w: G.rw, h: G.rh, float };
}

/*
 * DYNAMIC RESOLUTION: adapts G.autoScale (0.5..1, steps of 0.05) so GPU-bound scenes hold ~50+ fps.
 * Per rendered frame it records the frame interval, the main-thread time of the frame (rAF start -> end of
 * render: simulation, module updates, draw submission) and, with EXT_disjoint_timer_query_webgl2, the GPU
 * time. Every ~1 s window uses MEDIANS (a single hitch — month tick, autosave — cannot trigger anything):
 *   - slow window (> 24 ms): counts only when the GPU is the bottleneck (GPU timer > 80 % of the budget, or,
 *     without a timer, the main thread was idle for > 40 % of the frame). CPU-bound windows never lower the
 *     resolution: fewer pixels would not help.
 *   - 2 slow windows -> step down: proportional to the measured GPU time when known, else a fixed 0.05 /
 *     0.1 step (the frame interval is vsync-quantized, 33.3 ms at "30 fps" says nothing about how much
 *     too slow the GPU is, so proportional steps overshoot).
 *   - 4 fast windows (< 18.5 ms) -> probe up by 0.05 (with a GPU timer only if the predicted cost fits).
 *   - a level the controller had to leave for being slow is blocked, with exponential backoff per level
 *     (30, 60, 120, 240 s), so a level that failed is not retried every half minute (no saw-tooth).
 *     With a GPU timer, a probe whose predicted cost clearly fits ignores the block (scene got lighter).
 *   - every change is followed by a 1.5 s settle period (reallocation hitches are ignored).
 * G.aq exposes the state (debug).
 */
const AQ_BUDGET = 20, AQ_SLOW = 24, AQ_FAST = 18.5;
const AQ = (G.aq = { t: 0, iv: [], cpu: [], gpu: [], slow: 0, fast: 0, settle: 0, time: 0, fails: new Uint8Array(21), until: new Float64Array(21), last: null });
function aqReset() {
  AQ.t = 0; AQ.iv.length = AQ.cpu.length = AQ.gpu.length = 0; AQ.slow = AQ.fast = 0;
}
function median(a) {
  if (!a.length) return NaN;
  const b = a.slice().sort((x, y) => x - y);
  return b[b.length >> 1];
}
/** One rendered frame: interval rdt (s), main-thread ms. Returns the new scale or 0 (no change). */
function aqFrame(rdt, cpuMs) {
  if (AQ.settle > 0) { AQ.settle -= rdt; if (AQ.settle > 0) { AQ.gpu.length = 0; return 0; } }
  AQ.t += rdt;
  AQ.iv.push(rdt * 1000);
  AQ.cpu.push(cpuMs);
  if (AQ.t < 1.0) return 0;
  const win = AQ.t, fm = median(AQ.iv), cm = median(AQ.cpu), gm = median(AQ.gpu);
  AQ.t = 0; AQ.iv.length = AQ.cpu.length = AQ.gpu.length = 0;
  AQ.time += win;
  const hasGpu = gm === gm; // not NaN
  const s = G.autoScale, lv = Math.round(s * 20);
  let gpuBound;
  if (hasGpu) gpuBound = gm > AQ_BUDGET * 0.8 || gm > fm * 0.7;
  else gpuBound = cm < fm * 0.6;
  AQ.last = { fm: +fm.toFixed(1), cpu: +cm.toFixed(1), gpu: hasGpu ? +gm.toFixed(1) : null, gpuBound, scale: s };
  if (fm > AQ_SLOW) {
    AQ.fast = 0;
    AQ.slow = gpuBound ? AQ.slow + 1 : 0;
  } else if (fm < AQ_FAST) {
    AQ.slow = 0;
    AQ.fast++;
  } else AQ.slow = AQ.fast = 0;
  let n = s;
  if (AQ.slow >= 2) {
    AQ.slow = 0;
    // this level is too slow: block it (exponential backoff per level)
    AQ.fails[lv] = Math.min(AQ.fails[lv] + 1, 4);
    AQ.until[lv] = AQ.time + 30 * Math.pow(2, AQ.fails[lv] - 1);
    const target = hasGpu ? s * Math.sqrt((AQ_BUDGET * 0.9) / gm) : s - (fm > 40 ? 0.1 : 0.05);
    n = M.clamp(target, s - 0.15, s - 0.05);
  } else if (AQ.fast >= 4 && s < 1) {
    AQ.fast = 0;
    const up = s + 0.05, ul = lv + 1;
    const pred = hasGpu ? (gm * (up * up)) / (s * s) : 0;
    const blocked = AQ.time < AQ.until[ul] && !(hasGpu && pred < AQ_BUDGET * 0.6);
    if (!blocked && (!hasGpu || pred < AQ_BUDGET * 0.85)) n = up;
  }
  // a level that has not failed for a long time is forgiven one failure
  for (let i = 10; i <= 20; i++) if (AQ.fails[i] && AQ.time > AQ.until[i] + 240) { AQ.fails[i]--; AQ.until[i] = AQ.time - 1; }
  n = Math.round(M.clamp(n, 0.5, 1) * 20) / 20;
  return n !== s ? n : 0;
}
function autoQuality(rdt, cpuMs) {
  if (!VC.settings || !VC.settings.autoQuality) {
    if (G.autoScale !== 1) { G.autoScale = 1; G.resize(); }
    aqReset();
    return;
  }
  if (typeof document !== 'undefined' && document.hidden) return;
  const n = aqFrame(rdt, cpuMs);
  if (n) {
    G.autoScale = n;
    AQ.settle = 1.5;
    aqReset();
    G.resize();
  }
}

/* GPU frame timer (EXT_disjoint_timer_query_webgl2): feeds the resolution controller when available. */
const GT = { ext: null, pool: [], inflight: [], active: null };
function gpuTimerBegin(gl) {
  if (!GT.ext || GT.active || GT.inflight.length >= 4 || !VC.settings || !VC.settings.autoQuality) return;
  const q = GT.pool.pop() || gl.createQuery();
  gl.beginQuery(GT.ext.TIME_ELAPSED_EXT, q);
  GT.active = q;
}
function gpuTimerEnd(gl) {
  if (!GT.active) return;
  gl.endQuery(GT.ext.TIME_ELAPSED_EXT);
  GT.inflight.push(GT.active);
  GT.active = null;
}
function gpuTimerPoll(gl) {
  // Query availability / results are cached on the client (no GPU round trip). GPU_DISJOINT_EXT is NOT
  // queried: getParameter() is a synchronous round trip that would drain the pipeline every frame; a rare
  // disjoint (bogus) sample is an outlier that the per-window median ignores.
  while (GT.inflight.length) {
    const q = GT.inflight[0];
    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
    GT.inflight.shift();
    if (AQ.settle <= 0) AQ.gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
    GT.pool.push(q);
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
  if (pass === 'transparent' || pass === 'late') {
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
    if (G._unrestored && G._unrestored.has(L)) continue; // stale GL objects after a context restore
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
 * violet twilight, pink sunset, deep golden hour, golden hour, afternoon, noon. Every key: sun radiance
 * (rgb * intensity), sky ambient, ground bounce, fog/horizon color, exposure. Smoothstep-interpolated.
 * Low sun: flat ground (the dominant surface seen from above) receives only sun * h of direct light, so the
 * warm look must also come from the ambient terms (warm sky/ground keys) and a brighter exposure; walls
 * facing the sun get the full golden key. Below the horizon: no key light for a while (twilight is lit by
 * the sky dome only), then a long blue hour before the moonlit night.
 */
const TOD_KEYS = [
  // h      sun (radiance)          sky ambient            ground bounce          fog / horizon           exposure
  [-1.0, [0, 0, 0], [0.03, 0.045, 0.1], [0.014, 0.013, 0.018], [0.01, 0.017, 0.04], 1.6],
  [-0.3, [0, 0, 0], [0.03, 0.045, 0.1], [0.014, 0.013, 0.018], [0.01, 0.017, 0.04], 1.6],
  [-0.17, [0, 0, 0], [0.07, 0.1, 0.24], [0.026, 0.028, 0.045], [0.06, 0.1, 0.24], 1.55], // blue hour
  [-0.075, [0, 0, 0], [0.19, 0.17, 0.34], [0.07, 0.055, 0.07], [0.36, 0.25, 0.4], 1.42], // violet twilight
  [0.0, [0.9, 0.3, 0.08], [0.36, 0.25, 0.3], [0.2, 0.12, 0.08], [0.85, 0.46, 0.36], 1.3], // pink sunset
  [0.07, [3.2, 1.45, 0.45], [0.44, 0.33, 0.3], [0.34, 0.2, 0.1], [0.95, 0.62, 0.4], 1.3], // deep golden
  [0.18, [3.4, 2.2, 1.0], [0.42, 0.4, 0.44], [0.34, 0.25, 0.15], [0.86, 0.72, 0.6], 1.12], // golden hour
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

/** Fixed times of day for settings.dayNight (the 'sunset' still sits inside the golden window). */
G.FIXED_TOD = { day: 0.42, sunset: 0.735, night: 0.93 };
G.computeEnv = function (S) {
  const st = VC.settings || {};
  let tod = S ? S.time.tod : 0.35;
  if (G.FIXED_TOD[st.dayNight] != null) tod = G.FIXED_TOD[st.dayNight];
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
  // night starts at sunset (city lights come on) and is complete at the end of the blue hour
  const night = M.smoothstep(0.0, -0.22, h); // 0 day .. 1 night
  const dusk = M.smoothstep(0.45, 0.02, Math.abs(h)) * (1 - night);
  const golden = M.smoothstep(0.42, 0.12, h) * M.smoothstep(-0.04, 0.03, h);
  const blueHour = M.smoothstep(-0.02, -0.09, h) * M.smoothstep(-0.3, -0.16, h);

  const P = todLookup(h, _tod);
  const sunRad = P[0], sky = P[1], gnd = P[2], fog = P[3];
  let exposure = P[4];

  // key light: sun by day, moon by night. Twilight (h -0.02 .. -0.06) has no key at all (sky light only);
  // the moon fades in over the blue hour (keyVis crossfades through 0 at the switch)
  const useMoon = h < -0.02;
  const overcast = 1 - cloud * 0.62 - wet * 0.22; // clouds + rain dim and flatten the direct light
  const col = e.sunColor;
  if (useMoon) {
    const mi = 0.3 * M.smoothstep(-0.07, -0.26, h) * (1 - cloud * 0.7);
    col[0] = 0.5 * mi; col[1] = 0.64 * mi; col[2] = 1.0 * mi;
  } else for (let i = 0; i < 3; i++) col[i] = sunRad[i] * overcast;
  const keyVis = useMoon ? M.smoothstep(-0.06, -0.16, h) : M.smoothstep(-0.02, 0.05, h);
  const dir = e.sunDir;
  const kd = useMoon ? moon : sun;
  dir[0] = kd[0]; dir[1] = kd[1]; dir[2] = kd[2];

  // overcast: flatter, greyer ambient that partly replaces the lost sunlight; rain darkens
  const flat = cloud * 0.65 + wet * 0.3;
  greyish(sky, flat * 0.6, (1 + cloud * 0.35 * (1 - night)) * (1 - wet * 0.22));
  greyish(gnd, flat * 0.4, 1 - wet * 0.3);
  greyish(fog, cloud * 0.55 + wet * 0.35, (1 - wet * 0.25) * (1 - cloud * 0.12));
  // overcast / rainy nights: the cloud deck reflects the city's sodium glow (orange-grey), so the
  // scene never crushes to black under rain (stronger with a bigger city)
  const glow = night * cloud * (0.4 + 0.6 * M.sat((VC.sky && VC.sky.cityGlow) || 0));
  if (glow > 0) {
    sky[0] += 0.05 * glow; sky[1] += 0.042 * glow; sky[2] += 0.036 * glow;
    gnd[0] += 0.02 * glow; gnd[1] += 0.016 * glow; gnd[2] += 0.012 * glow;
    fog[0] += 0.03 * glow; fog[1] += 0.024 * glow; fog[2] += 0.02 * glow;
  }
  // snow cover: bright, cool ground bounce (partial: full white bounce washes every wall out)
  if (snow > 0) {
    const sl = lum3(sky) * 0.95 + lum3(col) * keyVis * 0.12;
    gnd[0] += (sl * 0.9 - gnd[0]) * snow * 0.45;
    gnd[1] += (sl * 0.95 - gnd[1]) * snow * 0.45;
    gnd[2] += (sl * 1.06 - gnd[2]) * snow * 0.45;
    exposure *= 1 - snow * 0.22 * (1 - night);
  }
  // weather: darker scenes get a bit more exposure (much more at night: rain must not go black)
  exposure *= (1 + cloud * 0.12 + wet * 0.1) * (1 + night * (cloud * 0.35 + wet * 0.2));

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
const RAMP = { good: 0, bad: 1, value: 2, net: 3 };
function v4(f, o, a, b, c, d) { f[o] = a; f[o + 1] = b; f[o + 2] = c; f[o + 3] = d; }
G.writeFrame = function (vp) {
  const gl = G.gl, f = G.frameData, cam = VC.camera, e = G.env, S = VC.state;
  f.set(vp || cam.viewProj, 0);
  f.set(cam.view, 16);
  f.set(cam.proj, 32);
  f.set(G.shadowMat || cam.viewProj, 48);
  v4(f, 64, cam.pos[0], cam.pos[1], cam.pos[2], G.time % 3600);
  v4(f, 68, e.sunDir[0], e.sunDir[1], e.sunDir[2], e.keyVis);
  v4(f, 72, e.sunColor[0], e.sunColor[1], e.sunColor[2], e.night);
  v4(f, 76, e.skyAmb[0], e.skyAmb[1], e.skyAmb[2], e.snow);
  v4(f, 80, e.groundAmb[0], e.groundAmb[1], e.groundAmb[2], e.wet);
  v4(f, 84, e.fog[0], e.fog[1], e.fog[2], e.fogDensity);
  v4(f, 88, e.wind[0], e.wind[1], e.windStrength, e.cloud);
  if (G._ovKey !== G.overlay) { G._ovKey = G.overlay; G._ov = VC.OVERLAYS.find((x) => x.key === G.overlay); }
  const ov = G._ov;
  v4(f, 92, S ? S.W : 1, S ? S.H : 1, VC.C.SEA_Y, G.overlay !== 'none' ? 0.75 : 0);
  v4(f, 96, G.rw, G.rh, 1 / G.rw, 1 / G.rh);
  const grid = VC.tools && VC.tools.gridAlpha ? VC.tools.gridAlpha() : 0;
  v4(f, 100, G.shadowTex ? 1 : 0, e.season, e.lightning, grid);
  const hov = (VC.tools && VC.tools.hover) || null;
  const sel = (VC.tools && VC.tools.selectedId) || 0;
  v4(f, 104, hov ? hov.x : -1, hov ? hov.z : -1, sel, ov ? RAMP[ov.ramp] || 0 : 0);
  // uPad: far shadow cascade mapping (k, offset) relative to the near cascade, and the sun path angle
  const sf = G.shadowTex && G.shadowFar;
  v4(f, 108, sf ? sf.k : 0, sf ? sf.ox : 0, sf ? sf.oy : 0, e.sunAngle || 0);
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
  if (key !== G.overlay) TT.ov = true; // only the G channel (overlay value) changes
  G.overlay = key;
  VC.bus.emit('overlay', key);
};

/*
 * Incremental tile texture updates. Shaders read r (level), g (overlay value), a (zone) and b (flags), so:
 *   'dirty' rect          -> rebuild + upload only those rows (all channels)
 *   'mapsUpdated'         -> only when the active overlay shows a sim map: rewrite the G channel
 *   'flagsUpdated'        -> refresh the power / water bits (+ G for 'net' overlays); rows upload only if a
 *                            texel actually changed
 *   overlay switch        -> G channel only
 *   G.tileTexDirty = true -> full rebuild (new map, size change, context restore)
 */
const TT = { rect: null, maps: false, flags: false, ov: false };
function tileRect(d) {
  const r = TT.rect;
  if (!r) TT.rect = { x0: d.x0, z0: d.z0, x1: d.x1, z1: d.z1 };
  else {
    r.x0 = Math.min(r.x0, d.x0); r.z0 = Math.min(r.z0, d.z0);
    r.x1 = Math.max(r.x1, d.x1); r.z1 = Math.max(r.z1, d.z1);
  }
}
function tileOverlay() {
  const ov = G._ovDef && G._ovDef.key === G.overlay ? G._ovDef : (G._ovDef = VC.OVERLAYS.find((o) => o.key === G.overlay) || VC.OVERLAYS[0]);
  return ov;
}
/** Flags byte (b channel) of tile i. */
function tileFlags(S, i, F) {
  const fl = S.flags[i];
  return (fl & F.POWER ? 1 : 0) | (fl & F.WATER ? 2 : 0) | (S.road[i] ? 4 : 0) | (S.bld[i] ? 8 : 0) | (S.height[i] < VC.C.SEA ? 16 : 0) | (S.zone[i] ? 32 : 0);
}
/** Overlay value (g channel) of tile i. */
function tileValue(S, i, ov, map, F) {
  if (map) return map[i];
  if (ov.ramp === 'net') {
    const fl = S.flags[i];
    if (S.bld[i] || S.zone[i]) return fl & ov.flag ? 255 : 64;
    if (fl & (ov.flag === F.POWER ? F.POWERNET : F.WATERNET)) return 200;
  }
  return 0;
}
function uploadRows(gl, S, z0, z1) {
  gl.bindTexture(gl.TEXTURE_2D, G.tileTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, z0, S.W, z1 - z0 + 1, gl.RGBA, gl.UNSIGNED_BYTE, G._tileData.subarray(z0 * S.W * 4, (z1 + 1) * S.W * 4));
  G.tileStats.uploads++;
  G.tileStats.rows += z1 - z0 + 1;
}
G.tileStats = { full: 0, rects: 0, gpass: 0, flagPass: 0, uploads: 0, rows: 0, ms: 0, lastMs: 0 };

function updateTileTex(S) {
  const gl = G.gl, F = VC.F;
  let full = G.tileTexDirty || !G.tileTex;
  if (!G.tileTex || G.tileTex.w !== S.W || G.tileTex.h !== S.H) {
    if (G.tileTex) gl.deleteTexture(G.tileTex);
    G.tileTex = G.texture({ w: S.W, h: S.H, filter: gl.NEAREST });
    G._tileData = new Uint8Array(S.W * S.H * 4);
    full = true;
  }
  const d = G._tileData, W = S.W;
  const ov = tileOverlay();
  const map = ov.map ? S.maps[ov.map] : null;
  if (full) {
    for (let i = 0, j = 0; i < S.N; i++, j += 4) {
      d[j] = S.height[i];
      d[j + 1] = tileValue(S, i, ov, map, F);
      d[j + 2] = tileFlags(S, i, F);
      d[j + 3] = S.zone[i];
    }
    uploadRows(gl, S, 0, S.H - 1);
    G.tileStats.full++;
    G.tileTexDirty = false;
    TT.rect = null;
    TT.maps = TT.flags = TT.ov = false;
    return;
  }
  let z0 = S.H, z1 = -1;
  // G channel: overlay switched, or the sim refreshed the map the overlay shows / the networks
  const gAll = TT.ov || (TT.maps && !!map) || (TT.flags && ov.ramp === 'net');
  if (gAll) {
    for (let i = 0, j = 1; i < S.N; i++, j += 4) d[j] = tileValue(S, i, ov, map, F);
    z0 = 0; z1 = S.H - 1;
    G.tileStats.gpass++;
  }
  // power / water bits (b bits 0-1 = VC.F.POWER / WATER): upload only the rows where something changed
  if (TT.flags) {
    const direct = F.POWER === 1 && F.WATER === 2, fl = S.flags;
    for (let z = 0; z < S.H; z++) {
      let changed = false;
      for (let x = 0, i = z * W, j = i * 4 + 2; x < W; x++, i++, j += 4) {
        const b = direct ? (d[j] & 0xfc) | (fl[i] & 3) : tileFlags(S, i, F);
        if (d[j] !== b) { d[j] = b; changed = true; }
      }
      if (changed) { if (z < z0) z0 = z; if (z > z1) z1 = z; }
    }
    G.tileStats.flagPass++;
  }
  // edited rect: every channel
  const r = TT.rect;
  if (r) {
    const x0 = Math.max(0, r.x0), x1 = Math.min(W - 1, r.x1), rz0 = Math.max(0, r.z0), rz1 = Math.min(S.H - 1, r.z1);
    for (let z = rz0; z <= rz1; z++)
      for (let x = x0, i = z * W + x0, j = i * 4; x <= x1; x++, i++, j += 4) {
        d[j] = S.height[i];
        d[j + 1] = tileValue(S, i, ov, map, F);
        d[j + 2] = tileFlags(S, i, F);
        d[j + 3] = S.zone[i];
      }
    if (rz0 <= rz1) { z0 = Math.min(z0, rz0); z1 = Math.max(z1, rz1); }
    G.tileStats.rects++;
  }
  TT.rect = null;
  TT.maps = TT.flags = TT.ov = false;
  if (z1 >= z0) uploadRows(gl, S, z0, z1);
}
const tileWork = () => G.tileTexDirty || !G.tileTex || TT.rect || TT.ov || TT.flags || (TT.maps && !!tileOverlay().map);

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
  /** Axis-aligned box. color [r,g,b,a] (linear HDR: > 1 glows / blooms). wire: also draw edges. */
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
      // edges are brighter than the faces; HDR (> 1) colors stay HDR so previews glow / bloom consistently
      const lc = [Math.min(4, c[0] * 1.4 + 0.2), Math.min(4, c[1] * 1.4 + 0.2), Math.min(4, c[2] * 1.4 + 0.2), 0.9];
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
  const n = GZ.tris.length + GZ.lines.length;
  if (!GZ.buf || GZ.buf.length < n) GZ.buf = new Float32Array(Math.max(n, 4096) * 2); // grows, reused
  const all = GZ.buf;
  all.set(GZ.tris, 0);
  all.set(GZ.lines, GZ.tris.length);
  gl.bufferData(gl.ARRAY_BUFFER, all.subarray(0, n), gl.STREAM_DRAW);
  const nt = GZ.tris.length / 7, nl = GZ.lines.length / 7;
  if (nt) gl.drawArrays(gl.TRIANGLES, 0, nt);
  if (nl) gl.drawArrays(gl.LINES, nt, nl);
  gl.bindVertexArray(null);
  G.gizmo.clear();
}

/* ------------------------------------------------------------------ */
/* Frame                                                                */
/* ------------------------------------------------------------------ */
/*
 * FRAME PACING: a fence is inserted after every rendered frame and at most FP.max (3) frames may be in flight
 * on the GPU (fence status only updates between tasks and can lag a frame, hence 3). While the GPU is behind,
 * render() skips the frame (the canvas keeps the previous image, game logic keeps running), which bounds input
 * latency on slow GPUs and lets the resolution controller see the real frame rate (the requestAnimationFrame
 * interval alone does not reflect GPU cost everywhere). A generous timeout guards against a fence that never
 * reports.
 */
const FP = { fences: [], times: [], lagMs: 16, max: 3 };
function gpuReady(gl, now) {
  while (FP.fences.length) {
    if (gl.getSyncParameter(FP.fences[0], gl.SYNC_STATUS) !== gl.SIGNALED) break;
    FP.lagMs = M.lerp(FP.lagMs, now - FP.times[0], 0.3);
    gl.deleteSync(FP.fences.shift());
    FP.times.shift();
  }
  if (FP.fences.length < FP.max) return true;
  if (now - FP.times[0] > Math.max(1000, FP.lagMs * 3)) { // never wait forever
    gl.deleteSync(FP.fences.shift());
    FP.times.shift();
    return true;
  }
  return false;
}
function gpuFence(gl, now) {
  const f = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!f) return;
  FP.fences.push(f);
  FP.times.push(now);
  while (FP.fences.length > FP.max + 1) { gl.deleteSync(FP.fences.shift()); FP.times.shift(); }
  gl.flush();
}
G.framesSkipped = 0;

/**
 * Renders one frame (shadows -> layers -> post). dt/rdt as in main.js. force = render even if the GPU is
 * behind (used by capture/profiling code that needs a frame now).
 */
G.render = function (dt, rdt, force) {
  const gl = G.gl;
  if (!gl) return;
  G.time += rdt;
  // no GL calls while the context is lost (they would only produce errors); isContextLost() also covers
  // the gap before the (asynchronous) 'webglcontextlost' event arrives
  if (G.lost || gl.isContextLost()) return;
  G._accDt = (G._accDt || 0) + dt;
  G._accRdt = (G._accRdt || 0) + rdt;
  const now = performance.now();
  if (!force && !gpuReady(gl, now)) {
    G.framesSkipped++;
    return;
  }
  dt = Math.min(G._accDt, 0.25);
  rdt = Math.min(G._accRdt, 0.25);
  G._accDt = G._accRdt = 0;
  G.frameCount++;
  G.frameMs = M.lerp(G.frameMs, rdt * 1000, 0.05);
  G.fps = 1000 / Math.max(1, G.frameMs);
  if (GT.ext) gpuTimerPoll(gl);
  // shader warmup: small budget in game, larger while no city runs (title screen / demo)
  const S = VC.state;
  const idle = !S || S.demo || !VC.running;
  // Without KHR_parallel_shader_compile the GPU process links in line with rendering (a visible hitch per
  // program), so in game programs are only trickled in (one a second; never on CPU rasterizers, where one
  // link takes seconds — those compile on first use as before).
  const trickle = !G.caps.cpuRenderer && G.frameCount % 60 === 0 ? 1 : 0;
  warmStep(idle ? 10 : 2.5, idle ? (PG.ext ? 4 : 1) : PG.ext ? 2 : trickle, false, idle);
  if (S && tileWork()) {
    const t = performance.now();
    updateTileTex(S);
    G.tileStats.lastMs = performance.now() - t;
    G.tileStats.ms += G.tileStats.lastMs;
  }
  G.computeEnv(S);
  const cam = VC.camera;
  cam.aspect = G.rw / G.rh;
  cam.computeMatrices();
  if (!G.hdr || !G.hdr.fbo) {
    // render target unavailable (allocation failed): retry once a second, keep the old image meanwhile
    if (now - (G._hdrRetry || 0) > 1000) { G._hdrRetry = now; createHDR(); }
    if (!G.hdr || !G.hdr.fbo) return;
  }
  if (!force) gpuTimerBegin(gl);

  G.frustumPlanes(cam.viewProj, G.camFrustum);
  const ctx = G._ctx || (G._ctx = {});
  ctx.gl = gl; ctx.pass = ''; ctx.S = S; ctx.time = G.time; ctx.dt = dt; ctx.rdt = rdt; ctx.cam = cam; ctx.env = G.env;
  ctx.viewProj = cam.viewProj; ctx.frustum = G.camFrustum; ctx.cascade = -1;

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
    G.drawLayers('late', ctx);
    if (G._prof) profMark('transparent');
  }

  // ---- post ----
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(true);
  let posted = false;
  // after 3 consecutive failures post is skipped until the next resize / restore (no per-frame retries)
  if (VC.post && VC.post.render && (G._postFail || 0) < 3) {
    try {
      VC.post.render(ctx);
      posted = true;
      G._postFail = 0;
    } catch (e) {
      if (!G._postErr) console.error('[gfx] post failed, using basic tonemap', e);
      G._postErr = true;
      G._postFail = (G._postFail || 0) + 1;
    }
  }
  if (!posted) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, G.W, G.H);
    gl.disable(gl.SCISSOR_TEST);
    G._tonemap.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, G.hdr.color);
    gl.uniform1i(G._tonemap.u.uSrc, 0);
    gl.uniform1f(G._tonemap.u.uExposure, G.env.exposure || 1);
    G.fullscreen();
  }
  gl.enable(gl.DEPTH_TEST);
  if (!force) gpuTimerEnd(gl);
  if (CAP.queue.length) captureNow(gl);
  gpuFence(gl, now);
  if (G._prof) profMark('post');
  if (!force) {
    const t = performance.now();
    // main-thread time of this frame: rAF start (core tick) -> now, or this render call alone
    const start = G._rafStart && t - G._rafStart < 1000 ? G._rafStart : now;
    autoQuality(rdt, t - start);
  }
  if (CAP.jobs.length) capturePoll();
};

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
  try { G.render(0, 1 / 60, true); } finally {
    const p = G._prof;
    G._prof = null;
    delete p._t;
    p.total = +(performance.now() - t0).toFixed(2);
    return p;
  }
};

/* ------------------------------------------------------------------ */
/* Capture (thumbnails, screenshots)                                    */
/* ------------------------------------------------------------------ */
/*
 * The finished frame is downscaled on the GPU (a chain of halving blits from the canvas back buffer) and read
 * back ASYNCHRONOUSLY (readPixels into a pixel-pack buffer + fence, collected a frame or two later), so a
 * capture never drains the pipeline on the main thread (the old drawImage(canvas) path forced a full GPU
 * sync). The encode to a data URL runs on a small 2D canvas. Falls back to drawImage if anything fails.
 */
const CAP = { queue: [], jobs: [], fbos: [] };
/** Captures the next rendered frame as a data URL (scaled to maxW px wide). Returns a Promise (null on failure). */
G.capture = function (maxW = 320, type = 'image/jpeg') {
  return new Promise((resolve) => {
    if (G.lost || !G.gl) return resolve(null);
    CAP.queue.push({ maxW, type, resolve });
  });
};
function capTarget(gl, i, w, h) {
  let t = CAP.fbos[i];
  if (t && t.w === w && t.h === h) return t;
  if (t) { gl.deleteFramebuffer(t.fbo); gl.deleteRenderbuffer(t.rb); }
  const rb = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  t = CAP.fbos[i] = { fbo, rb, w, h };
  return t;
}
function captureSync(c) {
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
function captureNow(gl) {
  const list = CAP.queue;
  CAP.queue = [];
  for (const c of list) {
    try {
      const s = Math.min(1, c.maxW / G.W);
      const tw = Math.max(1, Math.round(G.W * s)), th = Math.max(1, Math.round(G.H * s));
      // halving blits from the back buffer (READ = default framebuffer) down to <= 2x the target, then the target
      let sw = G.W, sh = G.H, src = null, k = 0;
      gl.disable(gl.SCISSOR_TEST);
      for (;;) {
        const last = sw <= tw * 2 && sh <= th * 2;
        const w = last ? tw : Math.max(tw, Math.ceil(sw / 2)), h = last ? th : Math.max(th, Math.ceil(sh / 2));
        const dst = capTarget(gl, k++, w, h);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src ? src.fbo : null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
        gl.blitFramebuffer(0, 0, sw, sh, 0, 0, w, h, gl.COLOR_BUFFER_BIT, w === sw && h === sh ? gl.NEAREST : gl.LINEAR);
        src = dst; sw = w; sh = h;
        if (last) break;
      }
      const pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, tw * th * 4, gl.STREAM_READ);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!sync) throw new Error('fence');
      CAP.jobs.push({ c, pbo, sync, w: tw, h: th, t: performance.now() });
    } catch (e) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      captureSync(c); // back buffer still holds this frame
    }
  }
  if (CAP.jobs.length && !CAP.timer) CAP.timer = setTimeout(capturePoll, 4);
}
function capturePoll() {
  CAP.timer = 0;
  const gl = G.gl;
  for (let i = 0; i < CAP.jobs.length; ) {
    const j = CAP.jobs[i];
    if (G.lost) { j.c.resolve(null); CAP.jobs.splice(i, 1); continue; }
    // non-blocking poll (timeout 0); the readback below then never stalls the pipeline
    const st = gl.clientWaitSync(j.sync, 0, 0);
    const done = st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED;
    if (!done && st !== gl.WAIT_FAILED && performance.now() - j.t < 20000) { i++; continue; }
    CAP.jobs.splice(i, 1);
    gl.deleteSync(j.sync);
    try {
      const px = new Uint8Array(j.w * j.h * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, j.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(j.pbo);
      const cv = document.createElement('canvas');
      cv.width = j.w;
      cv.height = j.h;
      const g2 = cv.getContext('2d');
      const img = g2.createImageData(j.w, j.h);
      const row = j.w * 4;
      for (let y = 0; y < j.h; y++) {
        const s0 = (j.h - 1 - y) * row; // GL rows are bottom-up
        img.data.set(px.subarray(s0, s0 + row), y * row);
      }
      for (let k = 3; k < img.data.length; k += 4) img.data[k] = 255;
      g2.putImageData(img, 0, 0);
      j.c.resolve(cv.toDataURL(j.c.type || 'image/jpeg', 0.8));
    } catch (e) {
      j.c.resolve(null);
    }
  }
  if (CAP.jobs.length && !CAP.timer) CAP.timer = setTimeout(capturePoll, 8);
}

/* ------------------------------------------------------------------ */
/* WebGL context loss / restore                                         */
/* ------------------------------------------------------------------ */
G.lost = false;
G.restoreFallback = true;
const RESTORE = { fns: [], owners: new Set() };
/**
 * Registers fn() to run after the WebGL context was restored (after the core rebuilt its own resources).
 * owner (optional): the layer / module object fn restores, so the core knows that layer can recover.
 */
G.onRestore = function (fn, owner) {
  if (typeof fn === 'function') RESTORE.fns.push(fn);
  if (owner) RESTORE.owners.add(owner);
};

function onContextLost() {
  G.lost = true;
  G.lostCount = (G.lostCount || 0) + 1;
  FP.fences.length = FP.times.length = 0;
  GT.inflight.length = GT.pool.length = 0;
  GT.active = null;
  for (const c of CAP.queue) c.resolve(null);
  CAP.queue = [];
  for (const j of CAP.jobs) j.c.resolve(null);
  CAP.jobs = [];
  CAP.fbos = [];
  VC.bus.emit('toast', { text: 'Graphics context lost — recovering…', type: 'warn', icon: '⚠️' });
  VC.bus.emit('glLost');
}

function onContextRestored() {
  const gl = G.gl;
  G.lost = false;
  try {
    initCaps(gl);
    // every program relinks on next use (handles held by layers stay valid); background re-issue
    PG.queue.length = PG.pending.length = 0;
    for (const k in G.programs) {
      const P = G.programs[k];
      P.state = 0; P.err = null; P._prog = P._vs = P._fs = null; P.queued = true;
      lazyUniforms(P);
      PG.queue.push(P);
    }
    initResources(gl);
    G._qib = null;
    G._qibQuads = 0;
    initGizmos();
    G.hdr = null;
    G.rw = G.rh = 0;
    G._postFail = 0;
    G._fbErr = null;
    TT.rect = null;
    TT.maps = TT.flags = TT.ov = false;
    aqReset();
    AQ.settle = 2;
    G.resize();
  } catch (e) {
    console.error('[gfx] context restore failed', e);
  }
  for (const fn of RESTORE.fns) {
    try { fn(); } catch (e) { console.error('[gfx] restore callback failed', e); }
  }
  const stale = new Set();
  for (const L of G.layers) {
    if (typeof L.restore === 'function') {
      try { L.restore(); } catch (e) { console.error(`[gfx] layer "${L.name}" restore failed`, e); stale.add(L); }
    } else if (!RESTORE.owners.has(L)) stale.add(L);
  }
  VC.bus.emit('glRestored');
  G._unrestored = stale.size ? stale : null;
  if (stale.size) {
    const names = [...stale].map((L) => L.name).join(', ');
    console.warn('[gfx] WebGL context restored; layers without restore support: ' + names);
    if (G.restoreFallback) {
      // cannot rebuild those layers' GL objects: keep the city safe and reload
      try { if (VC.save && VC.save.autosaveSync) VC.save.autosaveSync(); } catch (e) { /* ignore */ }
      VC.bus.emit('toast', { text: 'Graphics restarted — reloading (your city was autosaved)…', type: 'warn', icon: '⚠️' });
      setTimeout(() => location.reload(), 600);
    }
  } else VC.bus.emit('toast', { text: 'Graphics recovered', type: 'good', icon: '✅' });
}
