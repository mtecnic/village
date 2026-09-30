/*
 * VOXELPOLIS — shared GPU helpers for the agents / particles / fx modules (VC.fxgl).
 *
 *   VC.fxgl.frustum          view-frustum planes of the current camera: update(viewProj), sphere(x,y,z,r)
 *   VC.fxgl.pose(T, model, x, y, z, heading, pitch, roll, scale)
 *                            fills a 3x4 instance transform T (Float32Array(12)) for a voxel model.
 *                            heading: the model's FRONT (+Z in model space) points along (cos h, 0, sin h);
 *                            pitch > 0 = nose up; roll > 0 = bank right. The model origin is its
 *                            bottom centre (sx/2, 0, sz/2), exactly like buildings (VC.models.localToWorld).
 *   VC.fxgl.poseBuilding(T, b, model, lift, spin)  transform of building b's model (+ Y lift, extra yaw)
 *   VC.fxgl.xfPoint(T, lx, ly, lz, out)            model-voxel point -> world (out = [x,y,z])
 *   VC.fxgl.modelBatch(cap)  instanced voxel-model renderer (see ModelBatch below)
 *   VC.fxgl.glowBatch(cap)   additive glow sprites (see GlowBatch below)
 *   VC.fxgl.F                ModelBatch instance flags
 *
 * INSTANCE TRANSFORM T: world = R * voxelPos + t, with R = T[0..8] (3 columns, includes the voxel
 * size and scale) and t = T[9..11]. Parts (def.parts of VC.models) are composed with partPose().
 */
const M = VC.M;
const FX = (VC.fxgl = {});

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
  /** Extracts the 6 planes from a column-major view-projection matrix. */
  update(m) {
    const rows = [
      [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],
      [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],
      [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],
      [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
      [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],
      [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
    ];
    for (let i = 0; i < 6; i++) {
      const r = rows[i];
      const l = Math.hypot(r[0], r[1], r[2]) || 1;
      planes[i * 4] = r[0] / l;
      planes[i * 4 + 1] = r[1] / l;
      planes[i * 4 + 2] = r[2] / l;
      planes[i * 4 + 3] = r[3] / l;
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
FX.pose = function (T, m, x, y, z, h, p, r, scale) {
  const s = (m ? m.vox : VC.C.VOX) * (scale == null ? 1 : scale);
  const ch = Math.cos(h), sh = Math.sin(h);
  const cp = Math.cos(p || 0), sp = Math.sin(p || 0);
  const cr = Math.cos(r || 0), sr = Math.sin(r || 0);
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

/** Packs an sRGB-ish tint [0..1]^3 into one float (exact in float32). */
FX.tint = (r, g, b) => Math.round(M.sat(r) * 255) * 65536 + Math.round(M.sat(g) * 255) * 256 + Math.round(M.sat(b) * 255);
FX.WHITE = FX.tint(1, 1, 1);

/* ------------------------------------------------------------------ */
/* ModelBatch: instanced voxel models with arbitrary transforms          */
/* ------------------------------------------------------------------ */
/*
 * Usage per frame:  mb.begin(); mb.add(model, useLod, T, flags, glow, tint, seed); ... ; mb.draw(ctx, shadow)
 * Instances are bucketed per (model, lod) with a counting sort into one instance buffer (no allocations).
 * glow: emissive boost (albedo * glow, or incandescent heat with F.HOT). seed: 0..1 per-instance phase.
 */
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
uniform sampler2D uPal; uniform float uShadowPass; uniform vec3 uSpecial; // palette idx: NEON_RED, NEON_BLUE, BEACON_RED
out vec4 fragColor;
void main(){
  if (uShadowPass > 0.5) { fragColor = vec4(1.0); return; }
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

let modelProg = null;
function modelProgram() {
  if (!modelProg) modelProg = VC.gfx.program('fx_voxel', MVS, MFS);
  return modelProg;
}

class ModelBatch {
  constructor(cap) {
    this.cap = cap;
    this.stage = new Float32Array(cap * 16);
    this.data = new Float32Array(cap * 16);
    this.slotOf = new Int32Array(cap);
    this.n = 0;
    this.slots = [];
    this.slotMap = new Map();
    this.buf = null;
    this.dirty = true;
    this.T = new Float32Array(12); // scratch for parts
  }
  begin() {
    this.n = 0;
    for (let i = 0; i < this.slots.length; i++) this.slots[i].count = 0;
    this.dirty = true;
  }
  _grow() {
    const cap = this.cap * 2;
    const st = new Float32Array(cap * 16);
    st.set(this.stage);
    const so = new Int32Array(cap);
    so.set(this.slotOf);
    this.stage = st;
    this.slotOf = so;
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
    if (!m || !m.quads) return false;
    const useLod = !!(lod && m.lod && m.lod.quads > 0);
    if (this.n >= this.cap) this._grow();
    const k = this._slot(m, useLod);
    const o = this.n * 16, s = this.stage;
    s[o] = T[0]; s[o + 1] = T[1]; s[o + 2] = T[2]; s[o + 3] = T[9];
    s[o + 4] = T[3]; s[o + 5] = T[4]; s[o + 6] = T[5]; s[o + 7] = T[10];
    s[o + 8] = T[6]; s[o + 9] = T[7]; s[o + 10] = T[8]; s[o + 11] = T[11];
    s[o + 12] = flags; s[o + 13] = glow; s[o + 14] = tint; s[o + 15] = seed;
    this.slotOf[this.n++] = k;
    this.slots[k].count++;
    return true;
  }
  /** Adds a model plus its animated parts (def.parts), rotating parts by time * speed (* spinMul). */
  addWithParts(m, lod, T, flags, glow, tint, seed, time, spinMul = 1) {
    if (!this.add(m, lod, T, flags, glow, tint, seed)) return;
    const parts = m.parts;
    if (!parts) return;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const pm = VC.models.get(p.model);
      if (!pm) continue;
      FX.partPose(this.T, T, p, pm, m.vox, time * (p.speed || 1) * spinMul);
      this.add(pm, lod, this.T, flags, glow, tint, seed);
    }
  }
  _upload(gl) {
    if (!this.dirty) return;
    this.dirty = false;
    if (!this.n) return;
    let off = 0;
    for (const sl of this.slots) {
      sl.offset = off;
      sl.cur = off;
      off += sl.count;
    }
    const s = this.stage, d = this.data, so = this.slotOf;
    for (let i = 0; i < this.n; i++) {
      const sl = this.slots[so[i]];
      d.set(s.subarray(i * 16, i * 16 + 16), sl.cur * 16);
      sl.cur++;
    }
    if (!this.buf) this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, this.n * 16), gl.DYNAMIC_DRAW);
  }
  /** Draws all instances (opaque or shadow pass). */
  draw(ctx, shadow) {
    const gl = ctx.gl;
    if (!this.n) return;
    this._upload(gl);
    const P = modelProgram();
    P.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, VC.voxel.paletteTexture());
    gl.uniform1i(P.u.uPal, 0);
    gl.uniform1f(P.u.uShadowPass, shadow ? 1 : 0);
    gl.uniform3f(P.u.uSpecial, VC.P.NEON_RED, VC.P.NEON_BLUE, VC.P.BEACON_RED);
    for (const sl of this.slots) {
      if (!sl.count) continue;
      const m = sl.model;
      const g = sl.lod ? m.lod : m;
      if (!g || !g.vao || !g.quads) continue;
      gl.bindVertexArray(g.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      const base = sl.offset * 64;
      for (let k = 0; k < 4; k++) {
        gl.enableVertexAttribArray(2 + k);
        gl.vertexAttribPointer(2 + k, 4, gl.FLOAT, false, 64, base + k * 16);
        gl.vertexAttribDivisor(2 + k, 1);
      }
      gl.drawElementsInstanced(gl.TRIANGLES, g.quads * 6, gl.UNSIGNED_INT, 0, sl.count);
      // leave shared model VAOs clean for other renderers (they only use locations 0-3)
      gl.disableVertexAttribArray(4);
      gl.disableVertexAttribArray(5);
      gl.vertexAttribDivisor(4, 0);
      gl.vertexAttribDivisor(5, 0);
    }
    gl.bindVertexArray(null);
  }
}
FX.modelBatch = (cap = 256) => new ModelBatch(cap);

/* ------------------------------------------------------------------ */
/* GlowBatch: additive HDR sprites                                       */
/* ------------------------------------------------------------------ */
/*
 * add(x, y, z, size, r, g, b, intensity, kind, yaw, stretch, soft)
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
let glowProg = null, glowVao = null;
function glowProgram() {
  if (!glowProg) {
    glowProg = VC.gfx.program('fx_glow', GVS, GFS);
    glowVao = VC.gfx.gl.createVertexArray();
  }
  return glowProg;
}

class GlowBatch {
  constructor(cap) {
    this.cap = cap;
    this.data = new Float32Array(cap * 12);
    this.n = 0;
    this.buf = null;
  }
  begin() {
    this.n = 0;
  }
  add(x, y, z, size, r, g, b, a, kind = 0, yaw = 0, stretch = 1, soft = 0.3) {
    if (a <= 0.001 || size <= 0) return;
    if (this.n >= this.cap) {
      if (this.cap >= 65536) return;
      const d = new Float32Array(this.cap * 24);
      d.set(this.data);
      this.data = d;
      this.cap *= 2;
    }
    const o = this.n++ * 12, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = size;
    d[o + 4] = r; d[o + 5] = g; d[o + 6] = b; d[o + 7] = a;
    d[o + 8] = kind; d[o + 9] = yaw; d[o + 10] = stretch; d[o + 11] = soft;
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
    gl.bindVertexArray(glowVao);
    if (!this.buf) this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.n * 12), gl.DYNAMIC_DRAW);
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
    const d = Math.hypot(cam.tx - x, cam.tz - z) + cam.dist * 0.3;
    if (d > range) return;
  }
  VC.bus.emit('sfx', { name, x, z, vol });
};
