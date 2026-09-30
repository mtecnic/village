/*
 * VOXELPOLIS — sky renderer (BASIC FOUNDATION VERSION — to be replaced/extended).
 * Fullscreen triangle at the far plane, drawn after opaque geometry.
 */
const Sk = (VC.sky = {
  name: 'sky',
  order: 900,
  init() {
    Sk.prog = VC.gfx.program(
      'sky_basic',
      `out vec2 vNdc; void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0; vNdc = p; gl_Position = vec4(p, 1.0, 1.0); }`,
      `in vec2 vNdc; uniform mat4 uInvVP; out vec4 fragColor;
       void main(){
         vec4 a = uInvVP * vec4(vNdc, -1.0, 1.0), b = uInvVP * vec4(vNdc, 1.0, 1.0);
         vec3 d = normalize(b.xyz / b.w - a.xyz / a.w);
         vec3 col = skyColor(d);
         float sd = max(dot(d, uSunDir.xyz), 0.0);
         col += uSunColor.rgb * (pow(sd, 900.0) * 30.0 + pow(sd, 12.0) * 0.12) * (1.0 - NIGHT);
         fragColor = vec4(col, 1.0);
       }`
    );
    VC.gfx.addLayer(Sk);
  },
  opaque(ctx) {
    const gl = ctx.gl;
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    Sk.prog.use();
    gl.uniformMatrix4fv(Sk.prog.u.uInvVP, false, ctx.cam.invViewProj);
    VC.gfx.fullscreen();
  },
});
