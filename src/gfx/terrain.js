/*
 * VOXELPOLIS — terrain renderer (BASIC FOUNDATION VERSION — to be replaced/extended).
 * Chunked meshes of stepped voxel columns: tile tops + cliff sides. Roads/zones/overlays
 * are drawn procedurally in the fragment shader from per-vertex tile attributes.
 *
 * Vertex format (20 bytes):
 *   loc 0 aPos   float32 x3
 *   loc 1 aA     uint8 x4 : normal index (0 +X,1 -X,2 +Y,3 -Y,4 +Z,5 -Z), terr, road type, zone code
 *   loc 2 aB     uint8 x4 : road connection mask (bit0 +X, bit1 -X, bit2 +Z, bit3 -Z), pline, isSide, reserved
 */
const C = VC.C;
const T = (VC.terrain = {
  name: 'terrain',
  order: 0,
  chunks: [],
  prog: null,

  init() {
    const gl = VC.gfx.gl;
    T.prog = VC.gfx.program('terrain_basic', VS, FS);
    VC.gfx.addLayer(T);
    VC.bus.on('dirty', (d) => T.markDirty(d.x0, d.z0, d.x1, d.z1));
  },
  reset(S) {
    const gl = VC.gfx.gl;
    for (const c of T.chunks) if (c.vao) { gl.deleteVertexArray(c.vao); gl.deleteBuffer(c.vbo); }
    T.chunks = [];
    T.cw = Math.ceil(S.W / C.CHUNK);
    T.ch = Math.ceil(S.H / C.CHUNK);
    for (let cz = 0; cz < T.ch; cz++) for (let cx = 0; cx < T.cw; cx++) T.chunks.push({ cx, cz, dirty: true, vao: null, vbo: null, quads: 0 });
  },
  markDirty(x0, z0, x1, z1) {
    if (!T.chunks.length) return;
    const c0x = Math.max(0, Math.floor((x0 - 1) / C.CHUNK)), c1x = Math.min(T.cw - 1, Math.floor((x1 + 1) / C.CHUNK));
    const c0z = Math.max(0, Math.floor((z0 - 1) / C.CHUNK)), c1z = Math.min(T.ch - 1, Math.floor((z1 + 1) / C.CHUNK));
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) T.chunks[cz * T.cw + cx].dirty = true;
  },
  update() {
    const S = VC.state;
    if (!S) return;
    let budget = 6; // chunks rebuilt per frame
    for (const c of T.chunks) {
      if (!c.dirty) continue;
      buildChunk(S, c);
      if (--budget <= 0) break;
    }
  },
  shadow(ctx) {
    draw(ctx);
  },
  opaque(ctx) {
    draw(ctx);
  },
});

function draw(ctx) {
  const gl = ctx.gl;
  T.prog.use();
  for (const c of T.chunks) {
    if (!c.vao || !c.quads) continue;
    gl.bindVertexArray(c.vao);
    gl.drawElements(gl.TRIANGLES, c.quads * 6, gl.UNSIGNED_INT, 0);
  }
}

function buildChunk(S, c) {
  const gl = VC.gfx.gl;
  c.dirty = false;
  const STEP = C.STEP;
  const x0 = c.cx * C.CHUNK, z0 = c.cz * C.CHUNK;
  const x1 = Math.min(S.W, x0 + C.CHUNK), z1 = Math.min(S.H, z0 + C.CHUNK);
  const f = [];
  const b = [];
  let quads = 0;
  const H = (x, z) => (x < 0 || z < 0 || x >= S.W || z >= S.H ? -4 : S.height[z * S.W + x]);
  const quad = (p0, p1, p2, p3, n, i, side) => {
    const terr = S.terr[i], road = S.road[i], zone = S.zone[i];
    let mask = 0;
    if (road) {
      const x = i % S.W, z = (i / S.W) | 0;
      if (x + 1 < S.W && S.road[i + 1]) mask |= 1;
      if (x > 0 && S.road[i - 1]) mask |= 2;
      if (z + 1 < S.H && S.road[i + S.W]) mask |= 4;
      if (z > 0 && S.road[i - S.W]) mask |= 8;
    }
    for (const p of [p0, p1, p2, p3]) {
      f.push(p[0], p[1], p[2]);
      b.push(n, terr, road, zone, mask, S.pline[i], side, 0);
    }
    quads++;
  };
  for (let z = z0; z < z1; z++)
    for (let x = x0; x < x1; x++) {
      const i = z * S.W + x;
      const h = S.height[i];
      const y = h * STEP;
      // top (+Y), CCW seen from above: (x,z+1) -> (x+1,z+1) -> (x+1,z) -> (x,z)
      quad([x, y, z + 1], [x + 1, y, z + 1], [x + 1, y, z], [x, y, z], 2, i, 0);
      // sides toward lower neighbours
      const nb = [
        [1, 0, 0], // +X
        [-1, 0, 1], // -X
        [0, 1, 4], // +Z
        [0, -1, 5], // -Z
      ];
      for (const [dx, dz, n] of nb) {
        const nh = H(x + dx, z + dz);
        if (nh >= h) continue;
        const yb = nh * STEP;
        if (n === 0) quad([x + 1, yb, z + 1], [x + 1, yb, z], [x + 1, y, z], [x + 1, y, z + 1], 0, i, 1);
        else if (n === 1) quad([x, yb, z], [x, yb, z + 1], [x, y, z + 1], [x, y, z], 1, i, 1);
        else if (n === 4) quad([x, yb, z + 1], [x + 1, yb, z + 1], [x + 1, y, z + 1], [x, y, z + 1], 4, i, 1);
        else quad([x + 1, yb, z], [x, yb, z], [x, y, z], [x + 1, y, z], 5, i, 1);
      }
    }
  if (!c.vao) {
    c.vao = gl.createVertexArray();
    c.vbo = gl.createBuffer();
  }
  const buf = new ArrayBuffer(quads * 4 * 20);
  const fv = new Float32Array(buf), bv = new Uint8Array(buf);
  for (let v = 0; v < quads * 4; v++) {
    fv[v * 5] = f[v * 3];
    fv[v * 5 + 1] = f[v * 3 + 1];
    fv[v * 5 + 2] = f[v * 3 + 2];
    for (let k = 0; k < 8; k++) bv[v * 20 + 12 + k] = b[v * 8 + k];
  }
  const ib = VC.gfx.quadIndexBuffer(quads);
  gl.bindVertexArray(c.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, c.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribIPointer(1, 4, gl.UNSIGNED_BYTE, 20, 12);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribIPointer(2, 4, gl.UNSIGNED_BYTE, 20, 16);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bindVertexArray(null);
  c.quads = quads;
}

const VS = `
layout(location=0) in vec3 aPos;
layout(location=1) in uvec4 aA;
layout(location=2) in uvec4 aB;
out vec3 vWp; flat out uvec4 vA; flat out uvec4 vB;
void main(){ vWp = aPos; vA = aA; vB = aB; gl_Position = uViewProj * vec4(aPos, 1.0); }`;

const FS = `
in vec3 vWp; flat in uvec4 vA; flat in uvec4 vB; out vec4 fragColor;
const vec3 NRM[6] = vec3[6](vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1));
void main(){
  vec3 n = NRM[vA.x];
  uint terr = vA.y, road = vA.z, zone = vA.w;
  vec3 col;
  if (terr == 1u) col = vec3(0.86, 0.78, 0.55);
  else if (terr == 2u) col = vec3(0.45, 0.33, 0.22);
  else if (terr == 3u) col = vec3(0.5, 0.49, 0.47);
  else if (terr == 4u) col = vec3(0.95, 0.97, 1.0);
  else if (terr == 5u) col = vec3(0.45, 0.66, 0.28);
  else col = vec3(0.36, 0.6, 0.24);
  if (vB.z == 1u) { col = mix(vec3(0.42, 0.3, 0.2), vec3(0.5, 0.48, 0.45), step(0.5, fract(vWp.y * 2.0)) * 0.5); }
  vec2 f = fract(vWp.xz);
  if (vB.z == 0u) {
    col *= 0.92 + 0.16 * hash12(floor(vWp.xz * 8.0));
    if (road > 0u) {
      col = vec3(0.16, 0.165, 0.18);
      float e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
      if (e < 0.1) col = vec3(0.55, 0.53, 0.5);
    } else if (zone > 0u) {
      uint zt = zone >> 2;
      vec3 zc = zt == 1u ? vec3(0.2, 0.85, 0.45) : zt == 2u ? vec3(0.2, 0.6, 1.0) : vec3(1.0, 0.75, 0.2);
      float e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
      col = mix(col, zc, e < 0.06 ? 0.7 : 0.18);
    }
    if (vB.y > 0u) { float d = abs(f.x - 0.5); if (d < 0.03) col = vec3(0.3); }
  }
  col = srgb2lin(col);
  vec3 c = shade(col, n, vWp, 1.0);
  if (uMap.w > 0.0 && vB.z == 0u) {
    vec4 td = tileData(vWp.xz);
    float v = td.g;
    if (uHover.w < 2.5 || v > 0.0) c = mix(c, srgb2lin(overlayRamp(v, uHover.w)) * (0.6 + 0.4 * max(dot(n, uSunDir.xyz), 0.0)), uMap.w * (uHover.w > 2.5 && v == 0.0 ? 0.0 : 1.0));
  }
  c = applyFog(c, vWp);
  fragColor = vec4(c, 1.0);
}`;
