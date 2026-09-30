/*
 * VOXELPOLIS — instanced voxel renderer for buildings and trees
 * (BASIC FOUNDATION VERSION — to be replaced/extended).
 *
 * Every model is drawn with drawElementsInstanced. Per-instance attributes:
 *   loc 2 aI0 = (centerX, baseY, centerZ, rot quarter-turns)
 *   loc 3 aI1 = (built 0..1, flags, seed 0..1, scale)
 * flags bits: 1 abandoned, 2 on fire, 4 unpowered, 8 selected, 16 ghost ok, 32 ghost bad
 */
const B = (VC.bldgfx = {
  name: 'buildings',
  order: 100,
  groups: new Map(), // model -> { model, data: number[], count, offset }
  instBuf: null,
  seenVer: -1,
  seenTreeVer: -1,
  animating: false,

  init() {
    const gl = VC.gfx.gl;
    B.prog = VC.gfx.program('bld_basic', VS, FS);
    B.instBuf = gl.createBuffer();
    VC.gfx.addLayer(B);
  },
  reset() {
    B.seenVer = -1;
    B.seenTreeVer = -1;
  },
  update() {
    const S = VC.state;
    if (!S) return;
    if (S.ver.bld !== B.seenVer || S.ver.trees !== B.seenTreeVer || B.animating) rebuild(S);
  },
  shadow(ctx) {
    draw(ctx, true);
  },
  opaque(ctx) {
    draw(ctx, false);
  },
});

const TREE_KINDS = ['tree_oak', 'tree_pine', 'tree_birch', 'tree_bush'];

function rebuild(S) {
  const gl = VC.gfx.gl;
  B.seenVer = S.ver.bld;
  B.seenTreeVer = S.ver.trees;
  B.groups.clear();
  let anim = false;
  const add = (model, cx, y, cz, rot, built, flags, seed, scale) => {
    let g = B.groups.get(model);
    if (!g) B.groups.set(model, (g = { model, data: [], count: 0, offset: 0 }));
    g.data.push(cx, y, cz, rot, built, flags, seed, scale);
    g.count++;
  };
  for (const b of S.buildings.values()) {
    const m = VC.models.forBuilding(b);
    if (!m) continue;
    b.hgt = m.height;
    if (b.built < 1) anim = true;
    const flags = (b.abandoned ? 1 : 0) | (b.fire > 0 ? 2 : 0) | (!b.powered ? 4 : 0);
    add(m, b.x + b.w / 2, VC.world.topY(b.x, b.z), b.z + b.d / 2, b.rot, Math.min(1, b.built), flags, (b.variant % 997) / 997, 1);
  }
  // trees
  const STEP = VC.C.STEP;
  for (let i = 0; i < S.N; i++) {
    const n = S.trees[i];
    if (!n) continue;
    const x = i % S.W, z = (i / S.W) | 0;
    for (let k = 0; k < n; k++) {
      const h = VC.M.hashU(x, z, k + 11);
      let kind = TREE_KINDS[h % TREE_KINDS.length];
      if (S.terr[i] === VC.TERR.SAND && VC.models.has('tree_palm')) kind = 'tree_palm';
      if (S.height[i] > 24 && VC.models.has('tree_pine')) kind = 'tree_pine';
      if (!VC.models.has(kind)) continue;
      const m = VC.models.get(kind, h >> 8);
      const ox = n === 1 ? 0.5 : 0.25 + ((h >> 4) & 15) / 30;
      const oz = n === 1 ? 0.5 : 0.25 + ((h >> 12) & 15) / 30;
      add(m, x + ox, S.height[i] * STEP, z + oz, (h >> 20) & 3, 1, 0, ((h >> 16) & 255) / 255, 0.55 + ((h >> 24) & 63) / 150);
    }
  }
  B.animating = anim;
  // pack into one buffer
  let total = 0;
  for (const g of B.groups.values()) { g.offset = total; total += g.count; }
  const arr = new Float32Array(total * 8);
  for (const g of B.groups.values()) arr.set(g.data, g.offset * 8);
  gl.bindBuffer(gl.ARRAY_BUFFER, B.instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
}

function draw(ctx, shadow) {
  const gl = ctx.gl;
  if (!B.groups.size) return;
  B.prog.use();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, VC.voxel.paletteTexture());
  gl.uniform1i(B.prog.u.uPal, 0);
  gl.uniform1f(B.prog.u.uShadowPass, shadow ? 1 : 0);
  for (const g of B.groups.values()) {
    const m = g.model;
    const useLod = shadow && m.lod && m.lod.quads > 0;
    const vao = useLod ? m.lod.vao : m.vao;
    const quads = useLod ? m.lod.quads : m.quads;
    if (!vao || !quads) continue;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, B.instBuf);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, g.offset * 32);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 32, g.offset * 32 + 16);
    gl.vertexAttribDivisor(3, 1);
    gl.uniform3f(B.prog.u.uCenter, m.sx / 2, 0, m.sz / 2);
    gl.uniform1f(B.prog.u.uVox, m.vox);
    gl.uniform1f(B.prog.u.uHeight, Math.max(m.sy, 1));
    gl.drawElementsInstanced(gl.TRIANGLES, quads * 6, gl.UNSIGNED_INT, 0, g.count);
  }
  gl.bindVertexArray(null);
}

const VS = `
layout(location=0) in vec3 aPos;
layout(location=1) in uvec2 aInfo;
layout(location=2) in vec4 aI0;
layout(location=3) in vec4 aI1;
uniform vec3 uCenter; uniform float uVox; uniform sampler2D uPal;
out vec3 vWp; out vec3 vVox; out float vAo; flat out uint vPal; flat out vec3 vN; flat out vec4 vI1;
const vec3 NRM[6] = vec3[6](vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1));
void main(){
  uint pal = aInfo.x;
  uint ni = aInfo.y & 7u;
  vAo = float(aInfo.y >> 3u) / 3.0;
  vec3 p = (aPos - uCenter) * uVox * aI1.w;
  uint mat = uint(texelFetch(uPal, ivec2(int(pal), 0), 0).a * 255.0 + 0.5);
  if ((mat & 8u) != 0u) {
    float sway = sin(TIME * 1.6 + aI0.x * 0.7 + aI0.z * 0.9 + aPos.y * 0.15) * 0.018 * max(p.y, 0.0) * (0.3 + uWind.z);
    p.xz += uWind.xy * sway;
  }
  vec2 r = rotQ(p.xz, aI0.w);
  vec3 wp = vec3(aI0.x + r.x, aI0.y + p.y, aI0.z + r.y);
  vec3 n = NRM[ni];
  vN = vec3(rotQ(n.xz, aI0.w).x, n.y, rotQ(n.xz, aI0.w).y);
  vWp = wp;
  vVox = aPos - NRM[ni] * 0.5;
  vPal = pal;
  vI1 = aI1;
  gl_Position = uViewProj * vec4(wp, 1.0);
}`;

const FS = `
in vec3 vWp; in vec3 vVox; in float vAo; flat in uint vPal; flat in vec3 vN; flat in vec4 vI1;
uniform sampler2D uPal; uniform float uHeight; uniform float uShadowPass;
out vec4 fragColor;
void main(){
  float built = vI1.x;
  if (built < 0.999 && vVox.y > built * uHeight) discard;
  if (uShadowPass > 0.5) { fragColor = vec4(1.0); return; }
  vec4 pe = texelFetch(uPal, ivec2(int(vPal), 0), 0);
  uint mat = uint(pe.a * 255.0 + 0.5);
  uint flags = uint(vI1.y + 0.5);
  vec3 alb = srgb2lin(pe.rgb);
  vec3 n = normalize(vN);
  if (n.y > 0.5 && (mat & 128u) == 0u) alb = mix(alb, vec3(0.85, 0.88, 0.94), SNOW * 0.9);
  if ((flags & 1u) != 0u) alb = mix(alb, vec3(dot(alb, vec3(0.33))), 0.7) * 0.55;
  float ao = 0.3 + 0.7 * vAo;
  vec3 c = shade(alb, n, vWp, ao);
  if ((mat & 18u) != 0u) c += specular(n, vWp, 64.0, 0.6);
  vec3 em = vec3(0.0);
  if ((mat & 4u) != 0u) em += srgb2lin(pe.rgb) * 2.5;
  if ((mat & 64u) != 0u) em += srgb2lin(pe.rgb) * 3.0 * NIGHT;
  if ((mat & 1u) != 0u && (flags & 5u) == 0u) {
    float h = hash13(floor(vVox) + vec3(vI1.z * 91.0));
    float lit = step(0.42, h) * NIGHT;
    vec3 wc = mix(vec3(1.0, 0.72, 0.4), vec3(0.75, 0.85, 1.0), step(0.8, h));
    em += wc * lit * 2.2;
  }
  if ((flags & 2u) != 0u) em += vec3(1.0, 0.35, 0.05) * (0.8 + 0.6 * sin(TIME * 13.0 + vWp.y * 4.0));
  if (built < 0.999 && vVox.y > built * uHeight - 1.0) em += vec3(0.3, 0.9, 1.0) * 2.0;
  c += em;
  c = applyFog(c, vWp);
  fragColor = vec4(c, 1.0);
}`;
