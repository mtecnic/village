/*
 * VOXELPOLIS — water renderer (BASIC FOUNDATION VERSION — to be replaced/extended).
 * One large translucent plane at the sea surface, extending beyond the map edges.
 */
const Wt = (VC.water = {
  name: 'water',
  order: 500,
  init() {
    Wt.prog = VC.gfx.program(
      'water_basic',
      `layout(location=0) in vec2 aXZ; out vec3 vWp;
       void main(){ vWp = vec3(aXZ.x, SEA_Y, aXZ.y); gl_Position = uViewProj * vec4(vWp, 1.0); }`,
      `in vec3 vWp; out vec4 fragColor;
       void main(){
         vec4 td = tileData(vWp.xz);
         float depth = max(SEA_Y - td.r * 255.0 * 0.25, 0.0);
         bool inMap = vWp.x >= 0.0 && vWp.z >= 0.0 && vWp.x < uMap.x && vWp.z < uMap.y;
         if (!inMap) depth = 3.0;
         vec3 v = normalize(uCamPos.xyz - vWp);
         vec2 w = vWp.xz * 0.9 + TIME * 0.15;
         vec3 n = normalize(vec3((vnoise(w) - 0.5) * 0.25, 1.0, (vnoise(w + 7.3) - 0.5) * 0.25));
         float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
         vec3 deep = srgb2lin(vec3(0.05, 0.22, 0.35)), shallow = srgb2lin(vec3(0.2, 0.6, 0.62));
         vec3 base = mix(shallow, deep, clamp(depth * 0.8, 0.0, 1.0));
         vec3 col = shade(base, vec3(0,1,0), vWp, 1.0);
         col = mix(col, skyColor(reflect(-v, n)), fres * 0.7);
         col += specular(n, vWp, 180.0, 2.0);
         col = applyFog(col, vWp);
         float a = clamp(0.55 + depth * 0.4 + fres * 0.3, 0.0, 0.94);
         fragColor = vec4(col, a);
       }`
    );
    const gl = VC.gfx.gl;
    Wt.vao = gl.createVertexArray();
    Wt.vbo = gl.createBuffer();
    VC.gfx.addLayer(Wt);
  },
  reset(S) {
    const gl = VC.gfx.gl;
    const m = 600;
    const d = new Float32Array([-m, -m, -m, S.H + m, S.W + m, S.H + m, -m, -m, S.W + m, S.H + m, S.W + m, -m]);
    gl.bindVertexArray(Wt.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, Wt.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
  },
  transparent(ctx) {
    const gl = ctx.gl;
    gl.disable(gl.CULL_FACE);
    Wt.prog.use();
    gl.bindVertexArray(Wt.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  },
});
