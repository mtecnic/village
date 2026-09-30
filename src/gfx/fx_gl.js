/*
 * VOXELPOLIS — shared GPU helpers for the agents / particles / fx modules (VC.fxgl).
 *
 *   VC.fxgl.frustum          view-frustum planes of the current camera: update(viewProj), sphere(x,y,z,r)
 *   VC.fxgl.pose(T, model, x, y, z, heading, pitch, roll, scale)
 *                            fills a 3x4 instance transform T (Float32Array(12)) for a voxel model.
 *                            heading: the model's FRONT (+Z in model space) points along (cos h, 0, sin h);
 *                            pitch > 0 = nose up; roll > 0 = bank right. The model origin is its
 *                            bottom centre (sx/2, 0, sz/2), exactly like buildings (VC.models.localToWorld).
 *   VC.fxgl.poseV(T, model, V)  same, arguments in V = Float32Array [x, y, z, heading, pitch, roll, scale]
 *                            (hot loops: no boxed double arguments)
 *   VC.fxgl.poseBuilding(T, b, model, lift, spin)  transform of building b's model (+ Y lift, extra yaw)
 *   VC.fxgl.xfPoint(T, lx, ly, lz, out)            model-voxel point -> world (out = [x,y,z])
 *   VC.fxgl.modelBatch(cap)  instanced voxel-model renderer (see ModelBatch below)
 *   VC.fxgl.glowBatch(cap)   additive glow sprites (see GlowBatch below)
 *   VC.fxgl.F                ModelBatch instance flags
 *   VC.fxgl.cells            building registry bucketed per 8x8-tile cell (see BUILDING CELLS below)
 *   VC.fxgl.cachedModel(b)   building b's model ONLY if VC.models already built it (never builds), else null
 *   VC.fxgl.warmup()         compiles the lazily created programs (fx_voxel, fx_voxel_sh, fx_glow) now
 *   VC.fxgl.lost()           true while the WebGL context is lost (update() code must then make no GL calls)
 *   VC.fxgl.glGen()          GL context generation (from VC.gfx.lostCount / lost): changes at every loss and restore
 *   VC.fxgl.restoreModels()  after a context restore: re-uploads every cached VC.models mesh IN PLACE (see below)
 *
 * WEBGL CONTEXT LOSS / RESTORE: after a restore every GL object of the old context is dead (never deleted:
 * deleting a dead handle is an INVALID_OPERATION). Batches, the glow VAO and the private model VAOs remember the
 * glGen() they were created in and are re-created lazily on their next draw; the programs relink by themselves
 * (render core). restoreModels() (called by every restore() that draws models; once per generation) uses
 * VC.models.restore() when voxel.js offers it, else re-meshes each cached model from model.grid and uploads it
 * into the SAME model object (vao / vbo, lod, winter), so every reference held by renderers stays valid; it also
 * drops the palette texture (re-created on the next VC.voxel.paletteTexture()).
 *
 * INSTANCE TRANSFORM T: world = R * voxelPos + t, with R = T[0..8] (3 columns, includes the voxel
 * size and scale) and t = T[9..11]. Parts (def.parts of VC.models) are composed with partPose().
 *
 * SHADOW CONTRACT (ModelBatch.draw): every pass culls each instance's bounding sphere against ctx.frustum
 * (the light frustum in the shadow pass, so off-screen casters still cast into the view); the shadow pass
 * uses a depth-only program, skips F.UNLIT instances and, in the far cascade (ctx.cascade 1), tiny casters.
 * Callers therefore add everything near the camera (not only what is on screen).
 */
const M = VC.M;
/** Vector length without Math.hypot (V8's hypot allocates its argument list; this is on per-frame paths). */
const hyp = (x, z) => Math.sqrt(x * x + z * z);
const FX = (VC.fxgl = {});

/* ------------------------------------------------------------------ */
/* Context loss                                                          */
/* ------------------------------------------------------------------ */
/**
 * GL context generation: 2 * VC.gfx.lostCount, + 1 while lost (0 until the first loss). GL objects of another
 * generation are dead — including ones created while the context was lost (browsers return invalid objects then).
 */
const glGen = (FX.glGen = () => { const G = VC.gfx; return G ? ((G.lostCount | 0) << 1) + (G.lost ? 1 : 0) : 0; });
/**
 * True while the WebGL context is lost. isContextLost() also covers the gap before the (asynchronous)
 * 'webglcontextlost' event sets VC.gfx.lost.
 */
FX.lost = function () {
  const G = VC.gfx;
  return !G || !G.gl || !!G.lost || G.gl.isContextLost();
};
let modelsGen = 0;
/**
 * Re-uploads every cached VC.models mesh after a context restore, keeping each model object (and its lod / winter
 * objects) so renderers' references stay valid. Idempotent per context generation (every layer that draws models
 * may call it from its restore()). Returns the number of models re-uploaded (-1: done by VC.models.restore()).
 */
FX.restoreModels = function () {
  const gen = glGen();
  if (modelsGen === gen || FX.lost()) return 0;
  modelsGen = gen;
  const Ms = VC.models;
  if (typeof Ms.restore === 'function') {
    Ms.restore();
    return -1;
  }
  const V = VC.voxel;
  if (V) { V._palTex = null; V._palDirty = false; } // palette texture: re-created on the next paletteTexture()
  let n = 0;
  const t0 = performance.now();
  for (const m of Ms.cached().values()) {
    try {
      reuploadModel(m);
      n++;
    } catch (e) {
      console.error('[fxgl] model re-upload failed', m && m.key, e);
    }
  }
  FX.restoreStats = { models: n, ms: Math.round(performance.now() - t0) };
  return n;
};
/** Meshes model m again from its grid (exactly as VC.models.get does) and uploads it into the same objects. */
function reuploadModel(m) {
  const g = m.grid, V = VC.voxel;
  if (!g) {
    // (no voxels kept: cannot be rebuilt; renderers skip meshes without a VAO)
    m.vao = m.vbo = null;
    if (m.lod) m.lod.vao = m.lod.vbo = null;
    return;
  }
  const def = VC.models.defs[m.key] || {};
  Object.assign(m, V.upload(V.mesh(g, 1)));
  const lodGrid = V.downsample(g, 2, def.lodMinFill || 3);
  const lod = V.upload(V.mesh(lodGrid, 2));
  if (m.lod) Object.assign(m.lod, lod);
  else m.lod = lod;
  const w = m.winter;
  if (w) {
    const open = V.foliageLUT();
    Object.assign(w, V.upload(V.mesh(g, 1, open)));
    const wl = V.upload(V.mesh(lodGrid, 2, open));
    if (w.lod) Object.assign(w.lod, wl);
    else w.lod = wl;
  }
}

/** ModelBatch per-instance flags. */
FX.F = {
  SIREN: 1, // NEON_RED / NEON_BLUE voxels flash alternately (emergency light bar)
  LIGHTS: 2, // NIGHTLIGHT voxels lit even by day (headlights on)
  HOT: 4, // glow value = incandescent heat (meteor), not an albedo boost
  BEACON: 8, // BEACON_RED voxels blink (aircraft)
  UNLIT: 16, // skip shadows / sun (for glowing things)
};

/* ------------------------------------------------------------------ */
/* Frustum                                                              */
/* ------------------------------------------------------------------ */
const planes = new Float32Array(24);
FX.frustum = {
  planes,
  /** Extracts the 6 planes (left, right, bottom, top, near, far) from a column-major view-projection matrix. */
  update(m) {
    for (let p = 0; p < 6; p++) {
      const r = p >> 1, sg = p & 1 ? -1 : 1;
      const a = m[3] + sg * m[r], b = m[7] + sg * m[4 + r], c = m[11] + sg * m[8 + r], d = m[15] + sg * m[12 + r];
      const l = Math.sqrt(a * a + b * b + c * c) || 1;
      planes[p * 4] = a / l;
      planes[p * 4 + 1] = b / l;
      planes[p * 4 + 2] = c / l;
      planes[p * 4 + 3] = d / l;
    }
  },
  /** True if the sphere (x,y,z,r) intersects the frustum. */
  sphere(x, y, z, r) {
    for (let i = 0; i < 24; i += 4) if (planes[i] * x + planes[i + 1] * y + planes[i + 2] * z + planes[i + 3] < -r) return false;
    return true;
  },
};

/* ------------------------------------------------------------------ */
/* Transforms                                                            */
/* ------------------------------------------------------------------ */
const PV = new Float32Array(7);
FX.pose = function (T, m, x, y, z, h, p, r, scale) {
  PV[0] = x; PV[1] = y; PV[2] = z; PV[3] = h; PV[4] = p || 0; PV[5] = r || 0; PV[6] = scale == null ? 1 : scale;
  return FX.poseV(T, m, PV);
};
FX.poseV = function (T, m, V) {
  const x = V[0], y = V[1], z = V[2], h = V[3], p = V[4], r = V[5];
  const s = (m ? m.vox : VC.C.VOX) * V[6];
  const ch = Math.cos(h), sh = Math.sin(h);
  const cp = Math.cos(p), sp = Math.sin(p);
  const cr = Math.cos(r), sr = Math.sin(r);
  // model axes after roll then pitch (model space), then yaw (x,y,z) -> (x*sh + z*ch, y, -x*ch + z*sh)
  const exx = cr, exy = sr * cp, exz = -sr * sp;
  const eyx = -sr, eyy = cr * cp, eyz = -cr * sp;
  const ezy = sp, ezz = cp;
  T[0] = (exx * sh + exz * ch) * s; T[1] = exy * s; T[2] = (-exx * ch + exz * sh) * s;
  T[3] = (eyx * sh + eyz * ch) * s; T[4] = eyy * s; T[5] = (-eyx * ch + eyz * sh) * s;
  T[6] = ezz * ch * s; T[7] = ezy * s; T[8] = ezz * sh * s;
  const cx = m ? m.sx * 0.5 : 4, cz = m ? m.sz * 0.5 : 4;
  T[9] = x - T[0] * cx - T[6] * cz;
  T[10] = y - T[1] * cx - T[7] * cz;
  T[11] = z - T[2] * cx - T[8] * cz;
  return T;
};

/** Transform for building b's model (same placement as the building renderer), lifted by `lift`, extra yaw `spin`. */
FX.poseBuilding = function (T, b, m, lift = 0, spin = 0) {
  const gy = VC.world.topY(b.x, b.z);
  return FX.pose(T, m, b.x + b.w / 2, gy + lift, b.z + b.d / 2, Math.PI * 0.5 - (b.rot | 0) * Math.PI * 0.5 + spin, 0, 0, 1);
};

/** Model voxel coordinate -> world. */
FX.xfPoint = function (T, lx, ly, lz, out) {
  out[0] = T[0] * lx + T[3] * ly + T[6] * lz + T[9];
  out[1] = T[1] * lx + T[4] * ly + T[7] * lz + T[10];
  out[2] = T[2] * lx + T[5] * ly + T[8] * lz + T[11];
  return out;
};

/** Transform of a model part: parent * T(pivot) * Rot(axis, angle) * scale(voxC/voxP) * T(-partPivot). */
const _rot = new Float32Array(9);
FX.partPose = function (out, Tp, part, pm, parentVox, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const k = pm && parentVox ? pm.vox / parentVox : 1;
  const R = _rot;
  // columns of the axis rotation (same handedness as rotQ for 'y')
  if (part.axis === 'x') { R[0] = 1; R[1] = 0; R[2] = 0; R[3] = 0; R[4] = c; R[5] = s; R[6] = 0; R[7] = -s; R[8] = c; }
  else if (part.axis === 'z') { R[0] = c; R[1] = s; R[2] = 0; R[3] = -s; R[4] = c; R[5] = 0; R[6] = 0; R[7] = 0; R[8] = 1; }
  else { R[0] = c; R[1] = 0; R[2] = -s; R[3] = 0; R[4] = 1; R[5] = 0; R[6] = s; R[7] = 0; R[8] = c; }
  for (let j = 0; j < 3; j++) {
    const a = R[j * 3] * k, b = R[j * 3 + 1] * k, d = R[j * 3 + 2] * k;
    out[j * 3] = Tp[0] * a + Tp[3] * b + Tp[6] * d;
    out[j * 3 + 1] = Tp[1] * a + Tp[4] * b + Tp[7] * d;
    out[j * 3 + 2] = Tp[2] * a + Tp[5] * b + Tp[8] * d;
  }
  const pv = part.pivot || [0, 0, 0], pp = part.partPivot || [0, 0, 0];
  for (let r = 0; r < 3; r++) {
    out[9 + r] = Tp[9 + r] + Tp[r] * pv[0] + Tp[3 + r] * pv[1] + Tp[6 + r] * pv[2] - (out[r] * pp[0] + out[3 + r] * pp[1] + out[6 + r] * pp[2]);
  }
  return out;
};

/**
 * Seeded PRNG -> float in [0, 1): the same mulberry32 sequence as VC.M.rng(seed), but its state lives in an
 * Int32Array (a closure variable holding a full 32-bit int is a boxed HeapNumber on every call).
 */
FX.rng = function (seed) {
  const st = new Int32Array(1);
  st[0] = seed >>> 0 || 0x9e3779b9;
  return function () {
    const a = (st[0] = (st[0] + 0x6d2b79f5) | 0);
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Packs an sRGB-ish tint [0..1]^3 into one float (exact in float32). */
FX.tint = (r, g, b) => Math.round(M.sat(r) * 255) * 65536 + Math.round(M.sat(g) * 255) * 256 + Math.round(M.sat(b) * 255);
FX.WHITE = FX.tint(1, 1, 1);

/* ------------------------------------------------------------------ */
/* ModelBatch: instanced voxel models with arbitrary transforms          */
/* ------------------------------------------------------------------ */
/*
 * Usage per frame:  mb.begin(); mb.add(model, useLod, T, flags, glow, tint, seed); ... ; mb.draw(ctx, shadow)
 * (or mb.addX(model, useLod, T16) with flags, glow, tint, seed in T16[12..15])
 * Every draw (camera pass, each shadow cascade) culls the instances' bounding spheres against ctx.frustum
 * and buckets the survivors per (model, lod) with a counting sort into one instance buffer (no allocations).
 * Shadow passes use a depth-only program, skip F.UNLIT instances and, in the far cascade, tiny casters.
 * glow: emissive boost (albedo * glow, or incandescent heat with F.HOT). seed: 0..1 per-instance phase.
 */
const SMALL_CASTER = 0.45; // bounding radius (world units) below which the far shadow cascade skips a caster
const MVS = `
layout(location=0) in vec3 aPos;
layout(location=1) in uvec2 aInfo;
layout(location=2) in vec4 aM0;
layout(location=3) in vec4 aM1;
layout(location=4) in vec4 aM2;
layout(location=5) in vec4 aX;
out vec3 vWp; out vec3 vVox; out float vAo; flat out uint vPal; flat out vec3 vN; flat out vec4 vX;
const vec3 NRM[6] = vec3[6](vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1));
void main(){
  mat3 R = mat3(aM0.xyz, aM1.xyz, aM2.xyz);
  vec3 wp = R * aPos + vec3(aM0.w, aM1.w, aM2.w);
  uint ni = aInfo.y & 7u;
  vN = normalize(R * NRM[ni]);
  vAo = float(aInfo.y >> 3u) / 3.0;
  vPal = aInfo.x;
  vX = aX;
  vWp = wp;
  vVox = aPos - NRM[ni] * 0.5;
  gl_Position = uViewProj * vec4(wp, 1.0);
}`;
const MFS = `
in vec3 vWp; in vec3 vVox; in float vAo; flat in uint vPal; flat in vec3 vN; flat in vec4 vX;
uniform sampler2D uPal; uniform vec3 uSpecial; // palette idx: NEON_RED, NEON_BLUE, BEACON_RED
out vec4 fragColor;
void main(){
  vec4 pe = texelFetch(uPal, ivec2(int(vPal), 0), 0);
  uint mat = uint(pe.a * 255.0 + 0.5);
  uint flags = uint(vX.x + 0.5);
  vec3 alb = srgb2lin(pe.rgb);
  float tp = vX.z;
  vec3 tint = vec3(floor(tp / 65536.0), mod(floor(tp / 256.0), 256.0), mod(tp, 256.0)) / 255.0;
  if ((mat & 4u) == 0u) alb *= srgb2lin(tint);
  vec3 n = normalize(vN);
  float ao = 0.35 + 0.65 * vAo;
  vec3 c;
  if ((flags & 16u) != 0u) c = alb * (uSkyAmb.rgb + uSunColor.rgb * 0.3);
  else c = shade(alb, n, vWp, ao);
  if ((mat & 18u) != 0u) c += specular(n, vWp, 90.0, 0.7);
  vec3 em = vec3(0.0);
  float pi = float(vPal);
  if ((mat & 4u) != 0u) {
    float k = 2.6;
    bool red = abs(pi - uSpecial.x) < 0.5, blue = abs(pi - uSpecial.y) < 0.5;
    if (red || blue) {
      if ((flags & 1u) != 0u) {
        float ph = fract(TIME * 2.4 + vX.w);
        float on = red ? step(ph, 0.5) : step(0.5, ph);
        // double strobe within each half period
        on *= step(0.2, fract(ph * 4.0));
        k = 0.5 + on * 12.0;
      } else k = 0.7;
    }
    if (abs(pi - uSpecial.z) < 0.5 && (flags & 8u) != 0u) k = 0.4 + step(0.88, fract(TIME * 0.8 + vX.w)) * 14.0;
    em += srgb2lin(pe.rgb) * k;
  }
  if ((mat & 64u) != 0u) em += srgb2lin(pe.rgb) * 4.0 * max(NIGHT, (flags & 2u) != 0u ? 0.8 : 0.0);
  if ((mat & 1u) != 0u) {
    float h = hash13(floor(vVox) + vec3(vX.w * 91.0));
    em += mix(vec3(1.0, 0.75, 0.42), vec3(0.8, 0.88, 1.0), step(0.75, h)) * step(0.3, h) * NIGHT * 2.0;
  }
  if ((flags & 4u) != 0u) {
    float nz = hash13(floor(vVox * 0.5) + floor(TIME * 8.0));
    em += mix(vec3(1.0, 0.25, 0.04), vec3(1.0, 0.75, 0.3), nz) * vX.y;
  } else em += alb * vX.y;
  c += em;
  c = applyFog(c, vWp);
  fragColor = vec4(c, 1.0);
}`;

/* depth-only shadow variant: position only, empty fragment shader (G.depthProgram) */
const MVS_SH = `
layout(location=0) in vec3 aPos;
layout(location=2) in vec4 aM0;
layout(location=3) in vec4 aM1;
layout(location=4) in vec4 aM2;
void main(){
  mat3 R = mat3(aM0.xyz, aM1.xyz, aM2.xyz);
  gl_Position = uViewProj * vec4(R * aPos + vec3(aM0.w, aM1.w, aM2.w), 1.0);
}`;

let modelProg = null, shadowProg = null;
function modelProgram() {
  if (!modelProg) modelProg = VC.gfx.program('fx_voxel', MVS, MFS);
  return modelProg;
}
function shadowProgram() {
  if (!shadowProg) {
    const G = VC.gfx;
    shadowProg = G.depthProgram ? G.depthProgram('fx_voxel_sh', MVS_SH) : G.program('fx_voxel_sh', MVS_SH, 'out vec4 fragColor; void main(){ fragColor = vec4(1.0); }');
  }
  return shadowProg;
}

/*
 * Private VAOs per model mesh (full / LOD): the mesh VBO on locations 0-1 + the shared quad index buffer.
 * The model's own VAO belongs to the building renderer; never touching it keeps both renderers independent.
 * Memo entry {vao, vbo, gen}: re-created when the mesh was re-uploaded (context restore) or the context changed.
 */
const vaoMemo = new WeakMap();
function privateVao(gl, g) {
  const gen = glGen();
  let e = vaoMemo.get(g);
  if (e && e.vbo === g.vbo && e.gen === gen) return e.vao;
  // same context but a new mesh buffer: the old VAO is still a live object
  if (e && e.gen === gen && e.vao) gl.deleteVertexArray(e.vao);
  const ib = VC.gfx.quadIndexBuffer(g.quads); // (unbinds any VAO: call before binding ours)
  const v = gl.createVertexArray();
  gl.bindVertexArray(v);
  gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.SHORT, false, 8, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribIPointer(1, 2, gl.UNSIGNED_BYTE, 8, 6);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  for (let k = 2; k < 6; k++) {
    gl.enableVertexAttribArray(k);
    gl.vertexAttribDivisor(k, 1);
  }
  gl.bindVertexArray(null);
  if (e) { e.vao = v; e.vbo = g.vbo; e.gen = gen; }
  else vaoMemo.set(g, { vao: v, vbo: g.vbo, gen });
  return v;
}

/** Part model of a def.parts entry (memoized: no cache-key strings per frame). */
const partMemo = new WeakMap();
function partModel(p) {
  let m = partMemo.get(p);
  if (m === undefined) {
    m = VC.models.get(p.model) || null;
    partMemo.set(p, m);
  }
  return m;
}

class ModelBatch {
  constructor(cap) {
    this.cap = cap;
    this.stage = new Float32Array(cap * 16); // instances in add() order: 3x4 transform, flags, glow, tint, seed
    this.bsph = new Float32Array(cap * 4); // bounding sphere per instance (x, y, z, r)
    this.data = new Float32Array(cap * 16); // culled + bucketed copy uploaded for one pass
    this.slotOf = new Int32Array(cap);
    this.pick = new Uint8Array(cap);
    this.n = 0;
    this.slots = [];
    this.slotMap = new Map();
    this.buf = null;
    this.bufGen = -1; // glGen() of buf
    this.T = new Float32Array(12); // scratch for parts
    this.stats = { n: 0, cam: 0, sh0: 0, sh1: 0 };
  }
  begin() {
    this.n = 0;
  }
  _grow() {
    const cap = this.cap * 2;
    const st = new Float32Array(cap * 16);
    st.set(this.stage);
    const bs = new Float32Array(cap * 4);
    bs.set(this.bsph);
    const so = new Int32Array(cap);
    so.set(this.slotOf);
    this.stage = st;
    this.bsph = bs;
    this.slotOf = so;
    this.pick = new Uint8Array(cap);
    this.data = new Float32Array(cap * 16);
    this.cap = cap;
  }
  _slot(m, lod) {
    let e = this.slotMap.get(m);
    if (!e) this.slotMap.set(m, (e = [-1, -1]));
    const w = lod ? 1 : 0;
    let k = e[w];
    if (k < 0) {
      k = this.slots.length;
      this.slots.push({ model: m, lod, count: 0, offset: 0, cur: 0 });
      e[w] = k;
    }
    return k;
  }
  /** Adds one instance. Returns false if the model has no geometry. */
  add(m, lod, T, flags = 0, glow = 0, tint = FX.WHITE, seed = 0) {
    const o = this._addT(m, lod, T);
    if (o < 0) return false;
    const s = this.stage;
    s[o + 12] = flags; s[o + 13] = glow; s[o + 14] = tint; s[o + 15] = seed;
    return true;
  }
  /** add() with flags, glow, tint, seed in T[12..15] of a Float32Array(16) (hot loops: no boxed arguments). */
  addX(m, lod, T) {
    const o = this._addT(m, lod, T);
    if (o < 0) return false;
    const s = this.stage;
    s[o + 12] = T[12]; s[o + 13] = T[13]; s[o + 14] = T[14]; s[o + 15] = T[15];
    return true;
  }
  /** Stages the transform + bounding sphere of a new instance; returns its stage offset or -1. */
  _addT(m, lod, T) {
    if (!m || !m.quads) return -1;
    const useLod = !!(lod && m.lod && m.lod.quads > 0);
    if (this.n >= this.cap) this._grow();
    const k = this._slot(m, useLod);
    const i = this.n++;
    const o = i * 16, s = this.stage;
    s[o] = T[0]; s[o + 1] = T[1]; s[o + 2] = T[2]; s[o + 3] = T[9];
    s[o + 4] = T[3]; s[o + 5] = T[4]; s[o + 6] = T[5]; s[o + 7] = T[10];
    s[o + 8] = T[6]; s[o + 9] = T[7]; s[o + 10] = T[8]; s[o + 11] = T[11];
    // bounding sphere: model box centre through T, half diagonal * the largest axis scale
    const hx = m.sx * 0.5, hy = m.sy * 0.5, hz = m.sz * 0.5;
    const b = this.bsph, q = i * 4;
    b[q] = T[0] * hx + T[3] * hy + T[6] * hz + T[9];
    b[q + 1] = T[1] * hx + T[4] * hy + T[7] * hz + T[10];
    b[q + 2] = T[2] * hx + T[5] * hy + T[8] * hz + T[11];
    const s0 = T[0] * T[0] + T[1] * T[1] + T[2] * T[2], s1 = T[3] * T[3] + T[4] * T[4] + T[5] * T[5], s2 = T[6] * T[6] + T[7] * T[7] + T[8] * T[8];
    b[q + 3] = Math.sqrt((hx * hx + hy * hy + hz * hz) * Math.max(s0, s1, s2));
    this.slotOf[i] = k;
    return o;
  }
  /** Adds a model plus its animated parts (def.parts), rotating parts by time * speed (* spinMul). */
  addWithParts(m, lod, T, flags, glow, tint, seed, time, spinMul = 1) {
    if (!this.add(m, lod, T, flags, glow, tint, seed)) return;
    const parts = m.parts;
    if (!parts) return;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const pm = partModel(p);
      if (!pm) continue;
      FX.partPose(this.T, T, p, pm, m.vox, time * (p.speed || 1) * spinMul);
      this.add(pm, lod, this.T, flags, glow, tint, seed);
    }
  }
  /**
   * Selects the instances for one pass (frustum pl, or all when null; shadow passes also drop UNLIT and,
   * in cascade >= 1, small casters), buckets them per slot into this.data and returns their number.
   */
  _select(pl, shadow, cascade) {
    const slots = this.slots, ns = slots.length, n = this.n;
    for (let k = 0; k < ns; k++) slots[k].count = 0;
    const s = this.stage, bs = this.bsph, so = this.slotOf, pick = this.pick;
    const minR = shadow && cascade >= 1 ? SMALL_CASTER : 0;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      let ok = 1;
      const q = i * 4, r = bs[q + 3];
      if (shadow && (s[i * 16 + 12] & FX.F.UNLIT) !== 0) ok = 0;
      else if (r < minR) ok = 0;
      else if (pl) {
        const x = bs[q], y = bs[q + 1], z = bs[q + 2];
        for (let p = 0; p < 24; p += 4) {
          if (pl[p] * x + pl[p + 1] * y + pl[p + 2] * z + pl[p + 3] < -r) { ok = 0; break; }
        }
      }
      pick[i] = ok;
      if (ok) { slots[so[i]].count++; cnt++; }
    }
    if (!cnt) return 0;
    let off = 0;
    for (let k = 0; k < ns; k++) {
      const sl = slots[k];
      sl.offset = off;
      sl.cur = off;
      off += sl.count;
    }
    const d = this.data;
    for (let i = 0; i < n; i++) {
      if (!pick[i]) continue;
      const sl = slots[so[i]];
      const dst = sl.cur++ * 16, src = i * 16;
      for (let c = 0; c < 16; c++) d[dst + c] = s[src + c];
    }
    return cnt;
  }
  /** Draws the instances visible in ctx.frustum (camera pass, or one shadow cascade). */
  draw(ctx, shadow) {
    const gl = ctx.gl;
    this.stats.n = this.n;
    if (!this.n) return;
    const cascade = shadow ? ctx.cascade | 0 : -1;
    const cnt = this._select(ctx.frustum || null, shadow, cascade);
    if (shadow) this.stats[cascade >= 1 ? 'sh1' : 'sh0'] = cnt;
    else this.stats.cam = cnt;
    if (!cnt) return;
    const gen = glGen();
    if (!this.buf || this.bufGen !== gen) { this.buf = gl.createBuffer(); this.bufGen = gen; } // (old one died with its context)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data, gl.DYNAMIC_DRAW, 0, cnt * 16); // (WebGL2 offset/length: no subarray per draw)
    let P;
    if (shadow) {
      P = shadowProgram();
      P.use();
    } else {
      P = modelProgram();
      P.use();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, VC.voxel.paletteTexture());
      gl.uniform1i(P.u.uPal, 0);
      gl.uniform3f(P.u.uSpecial, VC.P.NEON_RED, VC.P.NEON_BLUE, VC.P.BEACON_RED);
    }
    const slots = this.slots;
    for (let k = 0; k < slots.length; k++) {
      const sl = slots[k];
      if (!sl.count) continue;
      const m = sl.model;
      const g = sl.lod ? m.lod : m;
      if (!g || !g.vbo || !g.quads) continue;
      gl.bindVertexArray(privateVao(gl, g));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      const base = sl.offset * 64;
      for (let a = 0; a < 4; a++) gl.vertexAttribPointer(2 + a, 4, gl.FLOAT, false, 64, base + a * 16);
      gl.drawElementsInstanced(gl.TRIANGLES, g.quads * 6, gl.UNSIGNED_INT, 0, sl.count);
    }
    gl.bindVertexArray(null);
  }
}
FX.modelBatch = (cap = 256) => new ModelBatch(cap);

/* ------------------------------------------------------------------ */
/* GlowBatch: additive HDR sprites                                       */
/* ------------------------------------------------------------------ */
/*
 * add(x, y, z, size, r, g, b, intensity, kind, yaw, stretch, soft)   (or addv(Float32Array(12)) in hot loops)
 * kinds:
 *   0 GLOW   camera-facing soft glow (core + halo). soft 0..1 = core share
 *   1 POOL   ground-aligned light pool, long axis along heading yaw, length = size * stretch
 *   2 BEAM   vertical beam from (x,y,z) upward: bottom width size, height stretch, top width = size * soft
 *   3 STAR   camera-facing 4-point glint
 *   4 RING   ground-aligned ring of radius size, soft = relative thickness
 *   5 BEAMD  like BEAM but hanging DOWN from (x,y,z) (tractor beams, searchlights)
 * Colors are linear HDR (values > 1 bloom). Fades with fog.
 */
FX.GLOW = 0; FX.POOL = 1; FX.BEAM = 2; FX.STAR = 3; FX.RING = 4; FX.BEAMD = 5;
const GVS = `
layout(location=0) in vec4 aG0;
layout(location=1) in vec4 aG1;
layout(location=2) in vec4 aG2;
out vec2 vUv; flat out vec4 vCol; flat out vec4 vP; out vec3 vWp;
void main(){
  vec2 q = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vUv = q;
  int kind = int(aG2.x + 0.5);
  vec3 p = aG0.xyz; float s = aG0.w;
  vec3 wp;
  if (kind == 1 || kind == 4) {
    vec2 f = vec2(cos(aG2.y), sin(aG2.y)); vec2 r = vec2(-f.y, f.x);
    float len = kind == 1 ? s * aG2.z : s;
    vec2 o = f * q.y * len + r * q.x * s;
    wp = p + vec3(o.x, 0.0, o.y);
  } else if (kind == 2 || kind == 5) {
    vec3 toCam = uCamPos.xyz - p;
    vec3 rt = normalize(vec3(-toCam.z, 0.0, toCam.x) + vec3(1e-4, 0.0, 0.0));
    float h = q.y * 0.5 + 0.5;
    float w = s * mix(1.0, aG2.w, h);
    wp = p + rt * q.x * w + vec3(0.0, (kind == 2 ? h : -h) * aG2.z, 0.0);
  } else {
    vec3 camR = vec3(uView[0][0], uView[1][0], uView[2][0]);
    vec3 camU = vec3(uView[0][1], uView[1][1], uView[2][1]);
    wp = p + (camR * q.x + camU * q.y) * s;
  }
  vWp = wp; vCol = aG1; vP = aG2;
  gl_Position = uViewProj * vec4(wp, 1.0);
}`;
const GFS = `
in vec2 vUv; flat in vec4 vCol; flat in vec4 vP; in vec3 vWp;
out vec4 fragColor;
void main(){
  int kind = int(vP.x + 0.5);
  float r = length(vUv);
  float a = 0.0;
  if (kind == 0) {
    float h = max(0.0, 1.0 - r);
    a = h * h * (1.0 - vP.w) + exp(-r * r * 26.0) * (0.4 + vP.w * 2.0);
  } else if (kind == 1) {
    float h = max(0.0, 1.0 - r);
    a = h * h * (1.0 - vP.w * 0.6 * (vUv.y * 0.5 + 0.5));
  } else if (kind == 2 || kind == 5) {
    float x = abs(vUv.x);
    float t = vUv.y * 0.5 + 0.5;
    float n = tnoise(vec2(vUv.x * 0.15 + vWp.x * 0.02, t * 0.4 - TIME * 0.25)).r;
    a = pow(max(0.0, 1.0 - x), 1.6) * (0.55 + 0.9 * n) * smoothstep(0.0, 0.08, t) * smoothstep(1.0, 0.6, t);
  } else if (kind == 3) {
    float cx = exp(-abs(vUv.x) * 18.0) * max(0.0, 1.0 - abs(vUv.y));
    float cy = exp(-abs(vUv.y) * 18.0) * max(0.0, 1.0 - abs(vUv.x));
    a = exp(-r * r * 30.0) * 1.5 + (cx + cy) * 0.9;
  } else if (kind == 4) {
    float w = max(vP.w, 0.02);
    float d = (r - (1.0 - w)) / w; // (never pow() a negative base: undefined in GLSL)
    a = exp(-d * d) * step(r, 1.0);
  }
  float fogK = exp(-length(vWp - uCamPos.xyz) * uFog.w * 0.8);
  fragColor = vec4(vCol.rgb * (vCol.a * a * fogK), 0.0);
}`;
let glowProg = null, glowVao = null, glowVaoGen = -1;
function glowProgram() {
  if (!glowProg) glowProg = VC.gfx.program('fx_glow', GVS, GFS);
  return glowProg;
}
/** The shared (attribute-less until bound) glow VAO of the current context. */
function glowVertexArray(gl) {
  const gen = glGen();
  if (!glowVao || glowVaoGen !== gen) {
    glowVao = gl.createVertexArray();
    glowVaoGen = gen;
  }
  return glowVao;
}

class GlowBatch {
  constructor(cap) {
    this.cap = cap;
    this.data = new Float32Array(cap * 12);
    this.n = 0;
    this.buf = null;
    this.bufGen = -1; // glGen() of buf
  }
  begin() {
    this.n = 0;
  }
  _grow() {
    if (this.cap >= 65536) return false;
    const d = new Float32Array(this.cap * 24);
    d.set(this.data);
    this.data = d;
    this.cap *= 2;
    return true;
  }
  add(x, y, z, size, r, g, b, a, kind = 0, yaw = 0, stretch = 1, soft = 0.3) {
    if (a <= 0.001 || size <= 0) return;
    if (this.n >= this.cap && !this._grow()) return;
    const o = this.n++ * 12, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = size;
    d[o + 4] = r; d[o + 5] = g; d[o + 6] = b; d[o + 7] = a;
    d[o + 8] = kind; d[o + 9] = yaw; d[o + 10] = stretch; d[o + 11] = soft;
  }
  /**
   * Same as add() with the 12 values in a Float32Array v (x, y, z, size, r, g, b, intensity, kind, yaw,
   * stretch, soft). Hot loops fill one scratch array and change only what differs between sprites, so no
   * double is ever boxed into a call argument.
   */
  addv(v) {
    if (v[7] <= 0.001 || v[3] <= 0) return;
    if (this.n >= this.cap && !this._grow()) return;
    const o = this.n++ * 12, d = this.data;
    for (let k = 0; k < 12; k++) d[o + k] = v[k];
  }
  /** Draws with additive blending (call from a transparent pass). */
  draw(ctx) {
    if (!this.n) return;
    const gl = ctx.gl;
    const P = glowProgram();
    P.use();
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    gl.bindVertexArray(glowVertexArray(gl));
    const gen = glGen();
    if (!this.buf || this.bufGen !== gen) { this.buf = gl.createBuffer(); this.bufGen = gen; } // (old one died with its context)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data, gl.DYNAMIC_DRAW, 0, this.n * 12);
    for (let k = 0; k < 3; k++) {
      gl.enableVertexAttribArray(k);
      gl.vertexAttribPointer(k, 4, gl.FLOAT, false, 48, k * 16);
      gl.vertexAttribDivisor(k, 1);
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
    gl.bindVertexArray(null);
  }
}
FX.glowBatch = (cap = 256) => new GlowBatch(cap);

/* ------------------------------------------------------------------ */
/* Shader warmup                                                        */
/* ------------------------------------------------------------------ */
/** Compiles the lazily created programs now (the first vehicle / glow / shadow never compiles mid-game). */
FX.warmup = function () {
  if (!VC.gfx || !VC.gfx.gl || FX.lost()) return false;
  modelProgram();
  shadowProgram();
  glowProgram();
  glowVertexArray(VC.gfx.gl);
  return true;
};
/**
 * Registers fn with the render core's shader warmup when it offers one (VC.gfx.warmup.register / .add(name, fn),
 * VC.gfx.registerWarmup(name, fn) or a VC.gfx.warmups list). fn must be idempotent. Returns true if registered.
 */
FX.registerWarmup = function (name, fn) {
  const G = VC.gfx;
  if (!G) return false;
  try {
    const w = G.warmup;
    if (w && typeof w.register === 'function') { w.register(name, fn); return true; }
    if (w && typeof w.add === 'function') { w.add(name, fn); return true; }
    if (typeof G.registerWarmup === 'function') { G.registerWarmup(name, fn); return true; }
    if (Array.isArray(G.warmups)) { G.warmups.push(fn); return true; }
  } catch (e) { /* unknown warmup API: callers compile eagerly anyway */ }
  return false;
};

/* ------------------------------------------------------------------ */
/* Building models without synchronous builds                           */
/* ------------------------------------------------------------------ */
const fwOf = (b) => (b.rot & 1 ? b.d : b.w);
const fdOf = (b) => (b.rot & 1 ? b.w : b.d);
/**
 * Signature of the building fields that select its model (a small int: no boxed double per call); the
 * variant (uint16) and the key are compared separately.
 */
const modelSig = (b) => ((b.level & 3) | ((b.den & 3) << 2) | ((b.zt & 3) << 4) | ((b.wealth & 3) << 6) | ((b.rot & 3) << 8) | ((b.w & 31) << 10) | ((b.d & 31) << 15)) + (((b.level | 0) > 3 || (b.w | 0) > 31 || (b.d | 0) > 31) ? 1 << 22 : 0);
/** VC.models cache key of building b's model (mirrors VC.models.forBuilding), or null for unknown keys. */
FX.modelKey = function (b) {
  const Ms = VC.models, defs = Ms.defs;
  let key, params = null;
  if (b.key === 'grow') {
    const zk = (VC.ZONES[b.zt] || VC.ZONES[1]).key;
    key = 'grow_' + zk + b.den;
    params = { fw: fwOf(b), fd: fdOf(b), level: b.level, wealth: b.wealth || 0 };
  } else {
    key = b.key;
    const d = defs[key];
    if (d && d.sized) params = { fw: fwOf(b), fd: fdOf(b) };
  }
  const def = defs[key];
  if (!def) return null;
  const nv = def.variants || 1;
  return Ms.cacheKey(key, (((b.variant | 0) % nv) + nv) % nv, params);
};
const keyMemo = new WeakMap(); // building -> {sig, key, ck} (for buildings outside the cell registry)
/**
 * Building b's model if VC.models has already built it, else null. Never generates / meshes / uploads a
 * model (the building renderer builds them within its frame budget; callers retry later).
 */
FX.cachedModel = function (b) {
  if (!b || !VC.models.cached) return null;
  const e = cells.byId.get(b.id);
  if (e && e.b === b) return cells.model(e);
  const sig = modelSig(b);
  let k = keyMemo.get(b);
  if (!k || k.sig !== sig || k.key !== b.key || k.v !== (b.variant | 0)) keyMemo.set(b, (k = { sig, key: b.key, v: b.variant | 0, ck: FX.modelKey(b) }));
  return k.ck ? VC.models.cached().get(k.ck) || null : null;
};

/* ------------------------------------------------------------------ */
/* BUILDING CELLS                                                       */
/* ------------------------------------------------------------------ */
/*
 * Every building of the current state bucketed by the 8x8-tile cell of its footprint centre, maintained
 * incrementally from bus bldAdd / bldRemove / bldChange (shared by particles and fx, which only look at the
 * cells around the camera instead of rescanning S.buildings). Entry: { b, id, cell, k (index in its cell),
 * sig/key/ck/m (model resolution, see model(e)) }; modules may hang their own fields on entries (prefixed).
 *   init()                 subscribes to the bus (idempotent; called from the users' init)
 *   sync()                 (re)builds for VC.state when the state object changed; returns it
 *   near(x, z, R, out)     entries of the cells overlapping the square |dx|,|dz| <= R -> out; returns count
 *   model(e)               cached model of the entry's building or null (see FX.cachedModel)
 *   ver                    bumped on every add / remove / change
 */
const CELL = 8;
const cells = (FX.cells = {
  CS: CELL, S: null, cw: 0, ch: 0, list: [], byId: new Map(), ver: 0, _bound: false,
  init() {
    if (cells._bound || !VC.bus) return;
    cells._bound = true;
    VC.bus.on('bldAdd', cellAdd);
    VC.bus.on('bldRemove', cellRemove);
    VC.bus.on('bldChange', cellChange);
  },
  sync() {
    const S = VC.state;
    if (S && cells.S !== S) {
      cells.S = S;
      cells.cw = Math.ceil(S.W / CELL);
      cells.ch = Math.ceil(S.H / CELL);
      cells.list = [];
      for (let k = 0; k < cells.cw * cells.ch; k++) cells.list.push([]);
      cells.byId = new Map();
      for (const b of S.buildings.values()) insert(b);
      cells.ver++;
    }
    return cells.S;
  },
  near(x, z, R, out) {
    out.length = 0;
    if (!cells.S) return 0;
    const c0 = Math.max(0, Math.floor((x - R) / CELL)), c1 = Math.min(cells.cw - 1, Math.floor((x + R) / CELL));
    const r0 = Math.max(0, Math.floor((z - R) / CELL)), r1 = Math.min(cells.ch - 1, Math.floor((z + R) / CELL));
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const L = cells.list[r * cells.cw + c];
        for (let k = 0; k < L.length; k++) out.push(L[k]);
      }
    return out.length;
  },
  model(e) {
    const b = e.b, sig = modelSig(b);
    if (sig !== e.sig || e.key !== b.key || e.v !== (b.variant | 0)) {
      e.sig = sig;
      e.key = b.key;
      e.v = b.variant | 0;
      e.ck = FX.modelKey(b);
      e.m = null;
      e.mBuilt = -1;
    }
    // not built yet: look again only after VC.models built something (no string-keyed lookups per scan)
    if (!e.m && e.ck && VC.models.cached) {
      const nb = VC.models.stats.built;
      if (nb !== e.mBuilt) {
        e.mBuilt = nb;
        e.m = VC.models.cached().get(e.ck) || null;
      }
    }
    return e.m;
  },
});
function cellOf(b) {
  const cx = M.clamp(Math.floor((b.x + b.w * 0.5) / CELL), 0, cells.cw - 1);
  const cz = M.clamp(Math.floor((b.z + b.d * 0.5) / CELL), 0, cells.ch - 1);
  return cz * cells.cw + cx;
}
function insert(b) {
  const cell = cellOf(b), L = cells.list[cell];
  const e = { b, id: b.id, cell, k: L.length, sig: -1, key: '', v: -1, ck: null, m: null, mBuilt: -1 };
  L.push(e);
  cells.byId.set(b.id, e);
  return e;
}
function cellAdd(b) {
  if (cells.S !== VC.state) { cells.sync(); return; } // a new state: rebuilt from S.buildings (includes b)
  const old = cells.byId.get(b.id);
  if (old) cellRemove(old.b);
  insert(b);
  cells.ver++;
}
function cellRemove(b) {
  if (cells.S !== VC.state) { cells.sync(); return; }
  const e = cells.byId.get(b.id);
  if (!e || e.b !== b) return;
  const L = cells.list[e.cell], last = L.pop();
  if (last !== e) { L[e.k] = last; last.k = e.k; }
  cells.byId.delete(b.id);
  cells.ver++;
}
function cellChange(b) {
  if (cells.S !== VC.state) { cells.sync(); return; }
  const e = cells.byId.get(b.id);
  if (!e || e.b !== b) { cellAdd(b); return; }
  e.sig = -1;
  cells.ver++;
}

/* ------------------------------------------------------------------ */
/* Misc                                                                 */
/* ------------------------------------------------------------------ */
/** Surface height used by moving things: road deck/ramp (terrain API if present), else ground / water. */
FX.surfaceY = function (wx, wz) {
  const T = VC.terrain;
  if (T && T.surfaceY) {
    try {
      const y = T.surfaceY(wx, wz);
      if (y != null && isFinite(y)) return y;
    } catch (e) { /* fall through */ }
  }
  const S = VC.state;
  if (!S) return 0;
  const x = M.clamp(Math.floor(wx), 0, S.W - 1), z = M.clamp(Math.floor(wz), 0, S.H - 1);
  return Math.max(S.height[z * S.W + x] * VC.C.STEP, VC.C.SEA_Y);
};

/** Linear RGB of a palette index (for particles picking model colors). */
FX.palRGB = function (i, out) {
  const p = VC.voxel.palette;
  for (let k = 0; k < 3; k++) {
    const v = p[i * 4 + k] / 255;
    out[k] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return out;
};

/** Current season index 0 spring, 1 summer, 2 autumn, 3 winter (from S.time.day). */
FX.season = function (S) {
  const m = Math.floor((S.time.day / VC.C.DAYS_PER_MONTH) % 12);
  return m >= 2 && m <= 4 ? 0 : m >= 5 && m <= 7 ? 1 : m >= 8 && m <= 10 ? 2 : 3;
};

/**
 * Emits an 'sfx' bus event at (x, z). The audio module spatializes it; the distance to the camera is
 * only used to skip sounds that would be inaudible anyway (range = world units beyond which to skip).
 */
FX.sfx = function (name, x, z, vol = 1, range = 80) {
  const cam = VC.camera;
  if (cam && x != null) {
    const d = hyp(cam.tx - x, cam.tz - z) + cam.dist * 0.3;
    if (d > range) return;
  }
  VC.bus.emit('sfx', { name, x, z, vol });
};
