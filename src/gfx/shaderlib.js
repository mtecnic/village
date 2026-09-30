/*
 * VOXELPOLIS — shared GLSL. Every program compiled through VC.gfx.program() gets:
 *   #version 300 es, precision, the Frame UBO, common helpers, and (fragment only)
 *   lighting / fog / sky / overlay helpers.
 *
 * FRAME UBO (std140, binding 0) — filled once per pass by gfx core:
 *   uViewProj   camera view-projection (during SHADOW pass: the light's view-projection)
 *   uView, uProj
 *   uShadowMat  world -> shadow map texture space [0,1]^3 (includes bias matrix)
 *   uCamPos     xyz camera position,           w = time (seconds, wraps every 3600)
 *   uSunDir     xyz unit vector TOWARD the key light (sun, or moon at night), w = key light visibility 0..1
 *   uSunColor   rgb key light radiance (HDR),  w = night factor 0 (day) .. 1 (deep night)
 *   uSkyAmb     rgb sky ambient,               w = snow cover 0..1
 *   uGroundAmb  rgb ground bounce ambient,     w = wetness 0..1 (rain)
 *   uFog        rgb fog color,                 w = fog density
 *   uWind       xy wind direction, z = strength 0..1, w = cloud cover 0..1
 *   uMap        x = map W, y = map H, z = sea surface Y, w = overlay alpha (0 = overlay off)
 *   uScreen     xy = render target size px, zw = 1/size
 *   uMisc       x = shadows on (0/1), y = season 0..4 (0 spring,1 summer,2 autumn,3 winter; fractional blends; 4 wraps to spring),
 *               z = lightning flash 0..1, w = grid alpha (build grid lines)
 *   uHover      xy = hovered tile (or -1), z = selected building id (or 0), w = overlay ramp (0 good,1 bad,2 value,3 net)
 *
 * Shared samplers (bound by core every frame):
 *   unit 7  uShadowMap  (sampler2DShadow, hardware compare)   — fragment only
 *   unit 6  uTileTex    (RGBA8, W x H): r = terrain level, g = overlay value 0..255,
 *                        b = flags (bit0 power, bit1 water, bit2 road, bit3 building, bit4 water tile, bit5 zoned),
 *                        a = zone code
 *   unit 5  uNoiseTex   (RGBA8 256x256 tileable value noise, 4 independent channels, REPEAT, linear)
 *
 * Output convention: fragment shaders write LINEAR HDR color to `out vec4 fragColor`
 * (tonemapping happens in post). Emissive surfaces may exceed 1.0 to bloom.
 */
VC.shaderlib = {};

VC.shaderlib.FRAME_FLOATS = 112; // 4 mat4 (64) + 12 vec4 (48)

VC.shaderlib.header = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DShadow;
precision highp usampler2D;
layout(std140) uniform Frame {
  mat4 uViewProj;
  mat4 uView;
  mat4 uProj;
  mat4 uShadowMat;
  vec4 uCamPos;
  vec4 uSunDir;
  vec4 uSunColor;
  vec4 uSkyAmb;
  vec4 uGroundAmb;
  vec4 uFog;
  vec4 uWind;
  vec4 uMap;
  vec4 uScreen;
  vec4 uMisc;
  vec4 uHover;
  vec4 uPad;
};
uniform sampler2D uTileTex;
uniform sampler2D uNoiseTex;
#define TIME (uCamPos.w)
#define NIGHT (uSunColor.w)
#define SNOW (uSkyAmb.w)
#define WET (uGroundAmb.w)
#define SEA_Y (uMap.z)
`;

VC.shaderlib.common = `
float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float fbm2(vec2 p){ float s = 0.0, a = 0.5; for(int i=0;i<5;i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= 0.5; } return s; }
/** Fast texture noise: 4 channels of tileable value noise. */
vec4 tnoise(vec2 p){ return texture(uNoiseTex, p); }
vec4 tileData(vec2 xz){ ivec2 t = ivec2(clamp(floor(xz), vec2(0.0), uMap.xy - 1.0)); return texelFetch(uTileTex, t, 0); }
vec3 srgb2lin(vec3 c){ return pow(c, vec3(2.2)); }
/** Rotation of a point around Y by rot quarter-turns. */
vec2 rotQ(vec2 p, float q){ float a = q * 1.5707963; float c = cos(a), s = sin(a); return vec2(c*p.x + s*p.y, -s*p.x + c*p.y); }
`;

VC.shaderlib.lighting = `
uniform sampler2DShadow uShadowMap;

/** Shadow visibility 0..1 at world position wp with surface normal n. */
float shadowAt(vec3 wp, vec3 n){
  if (uMisc.x < 0.5) return 1.0;
  vec4 sc = uShadowMat * vec4(wp + n * 0.04, 1.0);
  vec3 p = sc.xyz / sc.w;
  if (p.x <= 0.001 || p.y <= 0.001 || p.x >= 0.999 || p.y >= 0.999 || p.z >= 1.0) return 1.0;
  vec2 ts = 1.0 / vec2(textureSize(uShadowMap, 0));
  float s = 0.0;
  // 3x3 PCF with hardware bilinear compare = smooth 4x4 footprint
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++)
    s += texture(uShadowMap, vec3(p.xy + vec2(x, y) * ts * 1.25, p.z - 0.0008));
  return s / 9.0;
}

/** Soft moving cloud shadows on the ground (0 = shadowed, 1 = lit). */
float cloudShadow(vec3 wp){
  float cover = uWind.w;
  if (cover < 0.02) return 1.0;
  vec2 p = wp.xz * 0.012 + uWind.xy * TIME * 0.004;
  float n = tnoise(p).r * 0.6 + tnoise(p * 2.7 + 0.37).g * 0.4;
  float c = smoothstep(1.0 - cover, 1.0 - cover + 0.25, n);
  return 1.0 - c * 0.55;
}

/** Hemispheric ambient + sun/moon diffuse with shadows. albedo in linear space. ao 0..1. */
vec3 shade(vec3 albedo, vec3 n, vec3 wp, float ao){
  float ndl = dot(n, uSunDir.xyz);
  float sh = 0.0;
  if (ndl > 0.0) sh = shadowAt(wp, n) * cloudShadow(wp);
  vec3 amb = mix(uGroundAmb.rgb, uSkyAmb.rgb, n.y * 0.5 + 0.5);
  float lightning = uMisc.z;
  vec3 col = albedo * (amb * ao + uSunColor.rgb * max(ndl, 0.0) * sh * uSunDir.w + vec3(0.8, 0.85, 1.0) * lightning * 2.0 * ao);
  return col;
}

/** Blinn specular term from the key light, for glass / water / metal. */
vec3 specular(vec3 n, vec3 wp, float gloss, float strength){
  vec3 v = normalize(uCamPos.xyz - wp);
  vec3 h = normalize(v + uSunDir.xyz);
  float s = pow(max(dot(n, h), 0.0), gloss) * strength;
  return uSunColor.rgb * s * uSunDir.w;
}

/** Procedural sky radiance for direction d (world space, y up). Used by sky + reflections. */
vec3 skyColor(vec3 d){
  float night = NIGHT;
  float y = max(d.y, 0.0);
  vec3 dayZen = vec3(0.16, 0.36, 0.78), dayHor = vec3(0.62, 0.78, 0.95);
  vec3 nZen = vec3(0.004, 0.008, 0.028), nHor = vec3(0.02, 0.035, 0.08);
  vec3 zen = mix(dayZen, nZen, night), hor = mix(dayHor, nHor, night);
  vec3 col = mix(hor, zen, pow(y, 0.55));
  // sunset glow near the horizon around the sun
  vec3 sd = uSunDir.xyz;
  float sunH = sd.y;
  float dusk = smoothstep(0.35, 0.0, abs(sunH)) * (1.0 - night * 0.6);
  float toward = pow(max(dot(normalize(vec3(d.x, 0.0, d.z) + 1e-5), normalize(vec3(sd.x, 0.0, sd.z) + 1e-5)), 0.0), 3.0);
  col = mix(col, vec3(1.0, 0.45, 0.18), dusk * toward * pow(1.0 - y, 4.0) * 0.85);
  // below-horizon: fade to fog color
  if (d.y < 0.0) col = mix(col, uFog.rgb, smoothstep(0.0, -0.2, d.y));
  return col;
}

/** Distance + height fog. */
vec3 applyFog(vec3 col, vec3 wp){
  float d = length(wp - uCamPos.xyz);
  float f = 1.0 - exp(-d * uFog.w);
  float hf = exp(-max(wp.y - SEA_Y, 0.0) * 0.35);
  f = clamp(f * (0.7 + 0.3 * hf), 0.0, 1.0);
  return mix(col, uFog.rgb, f);
}

/** Overlay color ramp. v 0..1. kind: 0 good, 1 bad, 2 value, 3 net. */
vec3 overlayRamp(float v, float kind){
  if (kind < 0.5) return mix(mix(vec3(0.9, 0.15, 0.1), vec3(1.0, 0.85, 0.1), smoothstep(0.0, 0.5, v)), vec3(0.15, 0.9, 0.35), smoothstep(0.5, 1.0, v));
  if (kind < 1.5) return v < 0.02 ? vec3(0.2, 0.7, 0.35) : mix(mix(vec3(1.0, 0.9, 0.2), vec3(1.0, 0.35, 0.1), smoothstep(0.0, 0.5, v)), vec3(0.6, 0.05, 0.4), smoothstep(0.5, 1.0, v));
  if (kind < 2.5) return mix(mix(vec3(0.1, 0.1, 0.45), vec3(0.1, 0.75, 0.9), smoothstep(0.0, 0.5, v)), vec3(1.0, 0.8, 0.2), smoothstep(0.5, 1.0, v));
  return v > 0.5 ? vec3(0.2, 0.85, 1.0) : vec3(0.95, 0.2, 0.15);
}
`;

/** Returns the full source for a stage. stage: 'vs' | 'fs'. */
VC.shaderlib.build = function (stage, body, defines = '') {
  const L = VC.shaderlib;
  return L.header + defines + '\n' + L.common + (stage === 'fs' ? L.lighting : '') + '\n#line 1\n' + body;
};
