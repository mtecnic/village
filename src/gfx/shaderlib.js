/*
 * VOXELPOLIS — shared GLSL. Every program compiled through VC.gfx.program() gets:
 *   #version 300 es, precision, the Frame UBO, common helpers, and (fragment only)
 *   lighting / shadow / fog / sky / overlay helpers.
 *
 * FRAME UBO (std140, binding 0) — filled once per pass by gfx core:
 *   uViewProj   camera view-projection (during SHADOW pass: the light's view-projection)
 *   uView, uProj
 *   uShadowMat  world -> shadow map texture space [0,1]^3 of the NEAR cascade (includes bias matrix;
 *               when the map is a 2-cascade atlas, x covers [0, 0.5]). Use shadowAt(), not this directly.
 *   uCamPos     xyz camera position,           w = time (seconds, wraps every 3600)
 *   uSunDir     xyz unit vector TOWARD the key light (sun, or moon at night), w = key light visibility 0..1
 *   uSunColor   rgb key light radiance (HDR),  w = night factor 0 (day) .. 1 (deep night)
 *   uSkyAmb     rgb sky ambient,               w = snow cover 0..1
 *   uGroundAmb  rgb ground bounce ambient,     w = wetness 0..1 (rain)
 *   uFog        rgb fog color (= horizon sky color), w = fog density (already scaled for camera distance)
 *   uWind       xy wind direction, z = strength 0..1, w = cloud cover 0..1
 *   uMap        x = map W, y = map H, z = sea surface Y, w = overlay alpha (0 = overlay off)
 *   uScreen     xy = render target size px, zw = 1/size
 *   uMisc       x = shadows on (0/1), y = season 0..4 (0 spring,1 summer,2 autumn,3 winter; fractional blends; 4 wraps to spring),
 *               z = lightning flash 0..1, w = grid alpha (build grid lines)
 *   uHover      xy = hovered tile (or -1), z = selected building id (or 0), w = overlay ramp (0 good,1 bad,2 value,3 net)
 *   uPad        RESERVED for the lighting library: x = far-cascade scale (0 = single cascade),
 *               yz = far-cascade offset, w = sun path angle (see libSunDir()). Do not read directly.
 *
 * Shared samplers (bound by core every frame):
 *   unit 7  uShadowMap  (sampler2DShadow, hardware compare)   — fragment only
 *   unit 6  uTileTex    (RGBA8, W x H): r = terrain level, g = overlay value 0..255,
 *                        b = flags (bit0 power, bit1 water, bit2 road, bit3 building, bit4 water tile, bit5 zoned),
 *                        a = zone code
 *   unit 5  uNoiseTex   (RGBA8 256x256 tileable value noise, 4 independent channels, REPEAT, linear)
 *
 * HELPERS (all stages): hash11/12/13, hash22, vnoise, fbm2, tnoise, tileData, srgb2lin, rotQ,
 *   libLuma(c), libIgn(px) (interleaved gradient noise), libSunDir() (TRUE sun direction — also valid
 *   below the horizon; uSunDir is the key light, i.e. the moon at night), libMoonDir().
 * FRAGMENT ONLY: shadowAt(wp, n), cloudShadow(wp), shade(albedo, n, wp, ao), specular(n, wp, gloss, strength),
 *   skyColor(dir), applyFog(col, wp), libFogColor(viewDir), libFogAmount(wp), overlayRamp(v, kind).
 *
 * Output convention: fragment shaders write LINEAR HDR color to `out vec4 fragColor`
 * (tonemapping + exposure happen in post). Emissive surfaces may exceed 1.0 to bloom.
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
/** Rec.709 luminance. */
float libLuma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
/** Interleaved gradient noise (Jimenez 2014): stable per-pixel dither in [0,1). */
float libIgn(vec2 px){ return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
/** TRUE sun direction (toward the sun; below the horizon at night). Mirrors gfx core computeEnv(). */
vec3 libSunDir(){ float a = uPad.w; float s = cos((uMisc.y - 1.0) * 1.5707963); return normalize(vec3(cos(a) * 0.85, sin(a), -(0.42 - 0.12 * s))); }
/** Moon direction (always above the horizon when it is the key light). */
vec3 libMoonDir(){ float a = uPad.w; return normalize(vec3(-cos(a) * 0.7, max(0.35, -sin(a)), 0.5)); }
`;

// 12-tap Vogel (golden angle) disk, unit radius — used for shadow PCF.
const DISK12 =
  'vec2(0.2041, 0.0000), vec2(-0.2607, 0.2388), vec2(0.0399, -0.4547), vec2(0.3286, 0.4286), vec2(-0.6030, -0.1067), vec2(0.5712, -0.3634), ' +
  'vec2(-0.1911, 0.7107), vec2(-0.3644, -0.7016), vec2(0.7906, 0.2887), vec2(-0.8224, 0.3395), vec2(0.3965, -0.8472), vec2(0.2930, 0.9341)';

VC.shaderlib.lighting = `
uniform sampler2DShadow uShadowMap;

const vec2 _LIB_DISK[12] = vec2[12](${DISK12});
// shade() caches its shadow term so a following specular() at the same point is free.
float _libShadowVal = 1.0;
vec3 _libShadowWp = vec3(-1.0e9);

/* ---------------------------------------------------------------- shadows */
// Cascade-local shadow coords [0,1]^3 of world point p. cw = atlas width fraction per cascade.
vec3 _libShadowLocal(vec3 p, float far, float cw){
  vec4 s = uShadowMat * vec4(p, 1.0);
  vec3 q = vec3(s.x / cw, s.y, s.z);
  if (far > 0.5) q.xy = q.xy * uPad.x + uPad.yz;
  return q;
}
// Rotated Vogel-disk PCF; every tap is a hardware bilinear depth compare (smooth penumbrae).
// grad = receiver-plane depth gradient per atlas uv: each tap compares against the receiver's own plane,
// so wide kernels cause no acne on sloped faces. The 4 outermost taps go first: fully lit or fully
// shadowed pixels stop there.
float _libPcf(vec3 q, float far, float cw, float radius, vec2 cs, vec2 texel, vec2 grad){
  vec2 base = vec2((q.x + far) * cw, q.y);
  mat2 R = mat2(cs.x, cs.y, -cs.y, cs.x) * radius;
  float s = 0.0;
  // the reference is clamped to 1: an empty (cleared) texel must read as lit even for receivers beyond the far plane
  for (int i = 8; i < 12; i++) { vec2 o = (R * _LIB_DISK[i]) * texel; s += texture(uShadowMap, vec3(base + o, min(q.z + dot(grad, o), 1.0))); }
  if (s < 0.002 || s > 3.998) return s * 0.25;
  for (int i = 0; i < 8; i++) { vec2 o = (R * _LIB_DISK[i]) * texel; s += texture(uShadowMap, vec3(base + o, min(q.z + dot(grad, o), 1.0))); }
  return s * (1.0 / 12.0);
}

/** Sun/moon shadow visibility 0..1 at world position wp with surface normal n. */
float shadowAt(vec3 wp, vec3 n){
  if (uMisc.x < 0.5) return 1.0;
  vec2 tsz = vec2(textureSize(uShadowMap, 0));
  float cw = tsz.x > tsz.y * 1.5 ? 0.5 : 1.0;         // 2-cascade atlas (side by side) or single map
  vec2 texel = 1.0 / tsz;
  // matrix rows: u, v, depth per world unit (near cascade, local coords)
  vec3 r0 = vec3(uShadowMat[0][0], uShadowMat[1][0], uShadowMat[2][0]) / cw;
  vec3 r1 = vec3(uShadowMat[0][1], uShadowMat[1][1], uShadowMat[2][1]);
  vec3 r2 = vec3(uShadowMat[0][2], uShadowMat[1][2], uShadowMat[2][2]);
  float s2 = dot(r0, r0), zpw = length(r2);
  float wpt = 1.0 / (sqrt(s2) * tsz.y);                // world size of one near-cascade texel
  // receiver plane (normal n): depth change per local uv step inside the plane (orthographic light)
  float nz = dot(n, r2);
  nz = (nz < 0.0 ? -1.0 : 1.0) * max(abs(nz), zpw * 0.08);  // avoid the singularity for faces parallel to the light
  vec2 grad = -vec2(dot(n, r0), dot(n, r1)) * (zpw * zpw) / (s2 * nz);
  float glim = zpw * wpt * tsz.y * 4.0;                // clamp: <= 4 world units of depth per uv at grazing angles
  grad = clamp(grad, -glim, glim) * vec2(1.0 / cw, 1.0);
  vec3 q0 = _libShadowLocal(wp, 0.0, cw);
  float e0 = max(abs(q0.x - 0.5), abs(q0.y - 0.5));
  float blend = smoothstep(0.41, 0.47, e0);            // near -> far cascade (or -> unshadowed) transition
  float ndl = clamp(dot(n, uSunDir.xyz), 0.0, 1.0);
  float nOff = 0.5 + 1.0 * sqrt(1.0 - ndl * ndl);      // small normal offset (plane bias does the rest)
  float ang = libIgn(gl_FragCoord.xy) * 6.2831853;
  vec2 cs = vec2(cos(ang), sin(ang));
  float soft = 1.35 + NIGHT * 1.4 + uWind.w * 0.9;     // PCF radius (texels): softer at night / overcast
  float s0 = 1.0, s1 = 1.0;
  if (blend < 1.0) {
    vec3 q = _libShadowLocal(wp + n * (wpt * nOff), 0.0, cw);
    q.z -= zpw * wpt * 0.3;
    s0 = _libPcf(q, 0.0, cw, soft, cs, texel, grad);
  }
  if (blend > 0.0 && uPad.x > 0.0) {
    float wpt1 = wpt / uPad.x;
    vec3 q = _libShadowLocal(wp + n * (wpt1 * nOff), 1.0, cw);
    float e1 = max(abs(q.x - 0.5), abs(q.y - 0.5));
    q.z -= zpw * wpt1 * 0.3;
    s1 = e1 < 0.5 ? mix(_libPcf(q, 1.0, cw, soft, cs, texel, grad / uPad.x), 1.0, smoothstep(0.42, 0.48, e1)) : 1.0;
  }
  return mix(s0, s1, blend);
}

/** Soft drifting cloud shadows (0 = shadowed, 1 = lit). Stronger with cloud cover. */
float cloudShadow(vec3 wp){
  float cover = uWind.w;
  if (cover < 0.03) return 1.0;
  vec2 drift = uWind.xy * TIME * (0.0012 + 0.0022 * uWind.z);
  vec2 p = wp.xz * 0.0045 + drift;
  float n = tnoise(p).r * 0.62 + tnoise(p * 2.7 + drift * 0.8 + 0.37).g * 0.28 + tnoise(p * 6.3 - drift).b * 0.1;
  float th = 0.8 - cover * 0.58;
  float c = smoothstep(th, th + 0.16, n);
  return 1.0 - c * (0.42 + 0.3 * cover);
}

/* ---------------------------------------------------------------- sky + fog */
// Zenith color for sun elevation h (linear HDR): night, blue hour, dusk, golden, day.
vec3 _libSkyZenith(float h){
  vec3 c = mix(vec3(0.0035, 0.006, 0.02), vec3(0.018, 0.036, 0.12), smoothstep(-0.32, -0.14, h));
  c = mix(c, vec3(0.07, 0.07, 0.2), smoothstep(-0.14, -0.04, h));
  c = mix(c, vec3(0.13, 0.22, 0.48), smoothstep(-0.04, 0.12, h));
  c = mix(c, vec3(0.1, 0.29, 0.74), smoothstep(0.12, 0.45, h));
  return c;
}
// Direction-dependent horizon light around sunrise/sunset: orange toward the sun, pink "belt of Venus" opposite.
vec3 _libHorizonGlow(vec3 d, vec3 sd){
  float h = sd.y;
  float amt = smoothstep(0.34, 0.02, h) * smoothstep(-0.2, -0.03, h) * (1.0 - uWind.w * 0.75);
  if (amt <= 0.001) return vec3(0.0);
  float t = dot(normalize(d.xz + vec2(1e-5)), normalize(sd.xz + vec2(1e-5))) * 0.5 + 0.5;
  float low = 1.0 - smoothstep(-0.05, 0.38, d.y);
  float t2 = t * t;
  vec3 toward = vec3(1.0, 0.42, 0.14) * (0.75 * t2 * t2) * smoothstep(-0.12, 0.02, h);
  vec3 away = vec3(0.34, 0.2, 0.38) * (0.3 * (1.0 - t));
  return (toward + away) * amt * low;
}
/** Fog / horizon color seen along view direction v (base fog + sunset glow + key light scattering). */
vec3 libFogColor(vec3 v){
  vec3 sd = libSunDir();
  vec3 c = uFog.rgb + _libHorizonGlow(v, sd);
  float mu = max(dot(v, uSunDir.xyz), 0.0);
  float mu2 = mu * mu, mu4 = mu2 * mu2;
  c += uSunColor.rgb * uSunDir.w * (mu4 * mu4 * 0.06) * (1.0 - uWind.w * 0.6);
  return c;
}

/** Procedural sky radiance for direction d (world space, y up). Used by sky + reflections. */
vec3 skyColor(vec3 d){
  vec3 sd = libSunDir();
  float h = sd.y;
  vec3 hor = libFogColor(d);
  float y = clamp(d.y, 0.0, 1.0);
  vec3 zen = _libSkyZenith(h);
  vec3 col = mix(hor, zen, pow(y, 0.42));
  // Mie glow around the sun (not the disc — the sky renderer draws that)
  float sunVis = smoothstep(-0.12, 0.02, h);
  vec3 sunTint = mix(vec3(1.0, 0.86, 0.66), vec3(1.0, 0.45, 0.16), smoothstep(0.3, 0.0, h));
  float mu = max(dot(d, sd), 0.0);
  col += sunTint * (pow(mu, 10.0) * 0.32 + pow(mu, 80.0) * 0.9) * sunVis * (1.0 - uWind.w * 0.7);
  // soft halo around the moon at night
  float mm = max(dot(d, libMoonDir()), 0.0);
  col += vec3(0.6, 0.7, 1.0) * (pow(mm, 40.0) * 0.12) * NIGHT * (1.0 - uWind.w * 0.8);
  // overcast / rain: grey, flat sky above the horizon
  float gr = uWind.w * 0.7 * smoothstep(0.0, 0.3, y);
  col = mix(col, vec3(libLuma(col)) * vec3(0.95, 0.98, 1.04) * (1.0 - WET * 0.3), gr);
  // below the horizon: ground haze
  if (d.y < 0.0) col = mix(col, hor * 0.85, smoothstep(0.0, -0.15, d.y));
  return col;
}

/** Fog amount 0..1 at world position wp. Starts beyond the view-center ground distance, so overviews stay crisp. */
float libFogAmount(vec3 wp){
  vec3 dv = wp - uCamPos.xyz;
  float d = length(dv);
  vec3 fwd = -vec3(uView[0][2], uView[1][2], uView[2][2]);
  float subject = max(uCamPos.y - SEA_Y, 1.0) / max(-fwd.y, 0.22);
  float thick = clamp((uFog.w - 0.006) * 45.0, 0.0, 1.0);   // weather fog pulls the start closer
  float fd = max(d - subject * mix(0.82, 0.12, thick), 0.0);
  float hf = exp(-max(wp.y - SEA_Y, 0.0) * 0.1);          // denser near water / valley floors
  return 1.0 - exp(-fd * uFog.w * (0.6 + 0.4 * hf));
}

/** Aerial perspective: distance + height fog tinted toward the sun. */
vec3 applyFog(vec3 col, vec3 wp){
  float f = libFogAmount(wp);
  if (f <= 0.0005) return col;
  return mix(col, libFogColor(normalize(wp - uCamPos.xyz)), f);
}

/* ---------------------------------------------------------------- surface lighting */
/**
 * Key light (sun/moon) with wrap diffuse, shadows and cloud shadows; hemisphere ambient with
 * street-canyon sky occlusion; wet darkening + sky sheen in rain; lightning; golden rim light.
 * albedo in linear space, ao 0..1.
 */
vec3 shade(vec3 albedo, vec3 n, vec3 wp, float ao){
  vec3 L = uSunDir.xyz;
  float ndl = dot(n, L);
  float up = clamp(n.y, 0.0, 1.0);
  float wetTop = WET * smoothstep(0.35, 0.9, n.y);
  albedo *= 1.0 - wetTop * 0.38;
  // direct light
  float diff = clamp((ndl + 0.03) / 1.03, 0.0, 1.0);
  float sh = 0.0;
  if (diff > 0.0 && uSunDir.w > 0.001) sh = shadowAt(wp, n) * cloudShadow(wp);
  _libShadowVal = sh; _libShadowWp = wp;
  vec3 direct = uSunColor.rgb * (uSunDir.w * diff * sh);
  // ambient: sky/ground hemisphere; vertical faces near the ground see less sky (street canyons)
  vec3 amb = mix(uGroundAmb.rgb, uSkyAmb.rgb, n.y * 0.5 + 0.5);
  float ground = max(tileData(wp.xz).r * 63.75, SEA_Y);
  float occ = mix(0.68, 1.0, smoothstep(0.0, 2.8, wp.y - ground));
  amb *= mix(occ, 1.0, abs(n.y));
  vec3 col = albedo * (amb * ao + direct * mix(1.0, ao, 0.3));
  // lightning flash
  col += albedo * vec3(0.8, 0.85, 1.0) * (uMisc.z * 2.0 * ao);
  vec3 v = normalize(uCamPos.xyz - wp);
  float nv = max(dot(n, v), 0.0);
  // golden rim on sun-facing-away silhouettes at low sun (backlight)
  float back = max(dot(-v, L), 0.0);
  float rim = pow(1.0 - nv, 4.0) * back * back * (1.0 - up) * (1.0 - NIGHT);
  col += uSunColor.rgb * (rim * 0.22 * uSunDir.w * max(sh, 0.35)) * albedo;
  // wet surfaces mirror the sky
  if (wetTop > 0.0) {
    float fr = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    col += skyColor(reflect(-v, n)) * (fr * wetTop * 0.7);
  }
  return col;
}

/** Blinn specular term from the key light (shadowed), for glass / water / metal. */
vec3 specular(vec3 n, vec3 wp, float gloss, float strength){
  vec3 L = uSunDir.xyz;
  float ndl = dot(n, L);
  if (ndl <= 0.0 || uSunDir.w <= 0.001) return vec3(0.0);
  vec3 dw = wp - _libShadowWp;
  float sh = dot(dw, dw) < 1e-8 ? _libShadowVal : shadowAt(wp, n) * cloudShadow(wp);
  vec3 v = normalize(uCamPos.xyz - wp);
  vec3 h = normalize(v + L);
  float fr = 0.7 + 0.6 * pow(1.0 - max(dot(h, v), 0.0), 5.0);
  float s = pow(max(dot(n, h), 0.0), gloss) * strength * fr * smoothstep(0.0, 0.12, ndl) * (1.0 + WET * 0.5);
  return uSunColor.rgb * (s * uSunDir.w * sh);
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
  const soft = VC.gfx && VC.gfx.caps && VC.gfx.caps.software ? '#define LIB_SOFT 1\n' : '';
  return L.header + soft + defines + '\n' + L.common + (stage === 'fs' ? L.lighting : '') + '\n#line 1\n' + body;
};
