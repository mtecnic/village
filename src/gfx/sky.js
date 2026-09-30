/*
 * VOXELPOLIS — procedural sky (VC.sky, OPAQUE layer order 900: a fullscreen triangle at the far plane,
 * drawn after all opaque geometry so it only shades empty pixels; writes no depth).
 *
 * LOOK: shaderlib skyColor() gradient (so reflections / fog match everywhere) + HDR sun disc with limb
 * darkening + phased moon (maria, earthshine, halo) + twinkling multi-colored stars rotating around the
 * pole with a faint milky-way band + two drifting cloud layers (puffy cumulus lit by the key light with
 * bright tops, dark bases, silver linings and sunset/afterglow tints; wind-stretched cirrus that catch the
 * last light) + overcast / rain deck + lightning glowing inside clouds + city light-pollution glow at
 * night + milky sky in fog + rare aurora curtains on clear winter nights + occasional shooting stars +
 * a double rainbow when the sun breaks through after rain. Cloud cover tracks S.weather.cloud.
 *
 * SHARED GLSL: VC.sky.GLSL declares the `SkyFrame` uniform block (binding VC.sky.UBO_BINDING = 3,
 * refreshed once per frame by sky.update()) and these fragment-shader helpers (prefix `sk`):
 *   vec3 skFog(v)             horizon/fog color seen along v (libFogColor when available, else uFog)
 *   float skFoggy()           0..1 weather fog
 *   vec3 skBase(d)            gradient sky without celestial bodies / clouds (what lies past the far plane)
 *   vec4 skClouds(d, hq)      both cloud layers: rgb = premultiplied radiance, a = coverage (hq: lit)
 *   vec3 skStars(d, px)       stars + milky way (px = pixel angular size, use uSkMisc.x)
 *   vec4 skMoon(d, px)        moon disc + halo (a = disc coverage); vec3 skSunDisc(d, px)
 *   vec3 skAurora(d)          aurora curtains (0 when inactive)
 *   vec3 skRainbow(d)         rainbow after rain (0 when inactive)
 *   vec3 skyReflect(d, rough) cheap full sky for reflections (clouds, stars/moon on calm water, aurora,
 *                             rainbow; no sun disc — add your own specular)
 * Any program that includes VC.sky.GLSL must be passed once to VC.sky.attach(program) after creation.
 * Include it AFTER the shaderlib (it uses tnoise, skyColor, NIGHT ...). Fragment shaders only.
 *
 * JS API: GLSL, UBO_BINDING, ubo, attach(prog), moonPhase (0 new .. 0.5 full .. 1, from S.time.day),
 * moonIllum (0..1 lit fraction), cover (smoothed cloud cover), cityGlow (0..1 from the population),
 * auroraLevel (0..1 current), forceAurora(v|null), forceRainbow(v|null), shootingStar() (spawns one now,
 * e.g. for celebrations), restore() (re-creates the UBO + program after a WebGL context restore).
 * Reads VC.fx.lastBolt {x, z} (optional) to light the clouds above a strike.
 */
const M = VC.M;

/** Shaderlib generation: the render-core rewrite adds libFogColor/libSunDir (fog color depends on view dir). */
const LIB2 = /libFogColor/.test((VC.shaderlib && VC.shaderlib.lighting) || '');
const UBO_BINDING = 3;
const UBO_VEC4 = 11;

const GLSL_CHUNK = `
layout(std140) uniform SkyFrame {
  vec4 uSkSun;    // xyz TRUE sun direction (below the horizon at night), w = sun disc radiance
  vec4 uSkMoon;   // xyz moon direction, w = moon phase 0..1 (0 new, 0.5 full)
  vec4 uSkSunCol; // rgb sun disc tint, w = moon disc radiance
  vec4 uSkCloud;  // xy cumulus drift, zw cirrus drift (cloud-plane units)
  vec4 uSkWx;     // x cumulus cover, y rain darkness, z cirrus amount, w overcast deck amount
  vec4 uSkNight;  // x star visibility, y star-sphere rotation (rad), z aurora 0..1, w city glow 0..1
  vec4 uSkMisc;   // x pixel angular size (rad), y time (s), z lightning flash, w afterglow (sun just set)
  vec4 uSkShootA; // xyz shooting-star head direction, w brightness (0 = none)
  vec4 uSkShootB; // xyz shooting-star tail direction, w = rainbow 0..1
  vec4 uSkBolt;   // xyz lightning direction, w aurora hue shift
  vec4 uSkWind;   // xy smoothed wind direction, z strength, w true sun elevation
};

vec3 skFog(vec3 v){
#ifdef SK_LIB2
  return libFogColor(v);
#else
  return uFog.rgb;
#endif
}

/** 0..1 how foggy the weather is (fog density well above the clear-air baseline). */
float skFoggy(){ return smoothstep(0.009, 0.028, uFog.w); }

/** Gradient sky + glows, no disc / stars / clouds. */
vec3 skBase(vec3 d){
  vec3 c = skyColor(d);
#ifndef SK_LIB2
  // the foundation skyColor has no sun glow and a horizon that differs from the fog: add both
  float mu = max(dot(d, uSkSun.xyz), 0.0);
  float mu2 = mu * mu, mu8 = mu2 * mu2; mu8 *= mu8;
  c += uSkSunCol.rgb * (mu8 * 0.14 + pow(mu, 90.0) * 0.6) * smoothstep(-0.12, 0.03, uSkSun.y) * (1.0 - uSkWx.x * 0.75);
  c = mix(skFog(d), c, smoothstep(-0.01, 0.16, d.y));
#endif
  // city light pollution: warm haze low above the horizon at night
  c += vec3(1.0, 0.52, 0.22) * (uSkNight.w * NIGHT * 0.045) * exp(-max(d.y, 0.0) * 6.0);
  // weather fog: a milky sky
  return mix(c, skFog(d), skFoggy() * 0.8);
}

/* ---------------------------------------------------------------- clouds */
// Flattened-dome projection of direction d onto the cloud plane (k: horizon compression).
vec2 skCloudUV(vec3 d, float k){ return d.xz / (max(d.y, 0.0) + k); }

// Cumulus: x = density 0..1 (threshold from cover), y = raw noise (keeps growing inside: thickness / relief).
vec2 skCumulus(vec2 p, float th){
  float n = tnoise(p).a * 0.55 + tnoise(p * 2.3 + vec2(0.31, 0.77)).r * 0.33 + tnoise(p * 7.1 - vec2(0.53, 0.21)).g * 0.12;
  return vec2(smoothstep(th, th + 0.12, n), n);
}

/** Both cloud layers composited: rgb = premultiplied radiance, a = coverage. hq = lighting sample + detail. */
vec4 skClouds(vec3 d, bool hq){
  if (d.y <= 0.0 || (uSkWx.x < 0.01 && uSkWx.z < 0.01)) return vec4(0.0);
  float cover = uSkWx.x;
  float hfade = smoothstep(0.0, 0.14, d.y);
  vec3 L = uSunDir.xyz;                              // key light (sun by day, moon by night)
  vec3 keyL = uSunColor.rgb * uSunDir.w;
  vec3 amb = uSkyAmb.rgb;
  float night = NIGHT;
  float mu = max(dot(d, uSkSun.xyz), 0.0);           // toward the true sun (silver lining, afterglow side)
  float glow = uSkMisc.w;
  vec3 afterCol = mix(vec3(1.0, 0.36, 0.28), vec3(0.72, 0.3, 0.52), smoothstep(-0.05, -0.18, uSkWind.w));
  vec4 acc = vec4(0.0);

  // ---- cirrus (high, wispy, wind-stretched; catches sunset colors) ----
  float ci = uSkWx.z * (1.0 - uSkWx.w);
  if (ci > 0.01) {
    vec2 cu = skCloudUV(d, 0.05);
    vec2 w = uSkWind.xy;
    // (coarse channels only: the finest noise octave turns into scratches when stretched)
    vec2 q = vec2(dot(cu, w), dot(cu, vec2(-w.y, w.x))) * vec2(0.045, 0.14) + uSkCloud.zw;
    float c = tnoise(q).a * 0.6 + tnoise(q * vec2(1.6, 2.4) + 0.41).r * 0.4;
    float a = smoothstep(0.56, 0.8, c) * ci * 0.6 * hfade;
    vec3 col = amb * 1.05 + keyL * 0.34 + afterCol * (glow * 0.9) + uSunColor.rgb * (pow(mu, 6.0) * 0.5 * uSunDir.w);
    col = mix(col, vec3(libLumaSk(col)), uSkWx.y * 0.7) * (1.0 - uSkWx.y * 0.4);
    acc = vec4(col * a, a);
  }

  // ---- cumulus / overcast deck ----
  float th = 0.54 - 0.25 * cover;                     // coverage ~ cover (fitted to the noise distribution)
  vec2 uv = skCloudUV(d, 0.1);
  vec2 p = uv * 0.34 + uSkCloud.xy;
  vec2 cd = skCumulus(p, th);
  float dens = cd.x;
  float deck = uSkWx.w;
  // overcast: a continuous deck with soft darker rolls
  float deckN = tnoise(p * 0.7 + 0.13).r;
  dens = max(dens, deck * (0.82 + 0.18 * deckN));
  if (dens > 0.002) {
    // relief lighting from the raw noise: brighter where the cloud thins toward the key light
    float lit = 0.6;
    float thick = smoothstep(th + 0.04, th + 0.3, cd.y);
    if (hq) {
      vec2 ld = normalize(L.xz + vec2(1e-4)) * (0.03 + 0.05 * (1.0 - clamp(L.y, 0.0, 1.0)));
      float nl = skCumulus(p + ld, th).y;
      lit = clamp(0.55 + (cd.y - nl) * 7.0 + (0.5 - thick) * 0.3, 0.0, 1.0);
    }
    // under an overcast deck the relief flattens into soft, slowly rolling grey
    lit = mix(lit, 0.45 + deckN * 0.2, deck * 0.8);
    thick = mix(thick, 0.55 + deckN * 0.2, deck * 0.8);
    vec3 shadowCol = amb * mix(0.95, 0.55, thick) * mix(1.0, 0.85, clamp(d.y, 0.0, 1.0)) + vec3(0.04, 0.045, 0.06) * (1.0 - night);
    vec3 litCol = amb * 0.75 + keyL * 0.4;
    vec3 col = mix(shadowCol, litCol, lit);
    // silver lining: thin edges glow when looking toward the sun
    float edge = dens * (1.0 - dens) * 4.0;
    col += uSunColor.rgb * uSunDir.w * (1.0 - night) * (pow(mu, 7.0) * 1.1 + pow(mu, 40.0) * 2.5) * edge;
    // after sunset / before sunrise the bases catch pink-orange light from below the horizon
    col += afterCol * glow * (0.35 + 0.65 * pow(mu, 2.0)) * (0.45 + 0.55 * (1.0 - lit));
    // city lights warm the cloud bases at night
    col += vec3(1.0, 0.55, 0.28) * (uSkNight.w * night * 0.07) * (0.5 + thick);
    // rain: dark, flat grey
    float rain = uSkWx.y;
    col = mix(col, vec3(libLumaSk(col)) * vec3(0.9, 0.93, 1.0), rain * 0.75 + deck * 0.3) * (1.0 - rain * 0.45);
    // lightning lights the clouds from inside
    float fl = uSkMisc.z;
    if (fl > 0.001) {
      float bd = max(dot(d, uSkBolt.xyz), 0.0);
      col += vec3(0.75, 0.8, 1.0) * fl * (0.6 + 6.0 * pow(bd, 16.0)) * (0.4 + thick);
    }
    float a = min(dens * 1.15, 1.0) * mix(hfade, 1.0, deck * 0.8);
    acc.rgb = acc.rgb * (1.0 - a) + col * a;
    acc.a = acc.a + a * (1.0 - acc.a);
  }
  return acc;
}

/* ---------------------------------------------------------------- stars */
// World direction -> slowly rotating star sphere (celestial pole tilted toward -Z = north).
vec3 skStarDir(vec3 d){
  const vec3 P = vec3(0.0, 0.7071068, -0.7071068);
  float c = cos(uSkNight.y), s = sin(uSkNight.y);
  return d * c + cross(P, d) * s + P * (dot(P, d) * (1.0 - c));
}

/** Stars + milky way. px = angular size of one pixel. */
vec3 skStars(vec3 d, float px){
  float vis = uSkNight.x * smoothstep(0.0, 0.22, d.y);
  if (vis < 0.003) return vec3(0.0);
  vec3 s = skStarDir(d);
  // milky way: a tilted great-circle band with dust lanes
  const vec3 GN = vec3(0.34, 0.24, 0.91);
  float band = exp(-pow(dot(s, GN) / 0.2, 2.0));
  vec3 col = vec3(0.0);
  if (band > 0.02) {
    vec3 a = abs(s);
    float n = tnoise(s.xy * 1.7 + 0.2).g * a.z + tnoise(s.yz * 1.7 + 0.5).g * a.x + tnoise(s.xz * 1.7 + 0.8).g * a.y;
    float dust = smoothstep(0.42, 0.62, n);
    col += mix(vec3(0.5, 0.55, 0.75), vec3(0.8, 0.7, 0.6), band) * (band * (0.35 + 0.65 * dust) * 0.05);
  }
  // cube-face grid: one candidate star per cell
  vec3 a = abs(s);
  vec2 uv; float face;
  if (a.x >= a.y && a.x >= a.z) { uv = s.yz / a.x; face = s.x > 0.0 ? 1.0 : 2.0; }
  else if (a.y >= a.z) { uv = s.xz / a.y; face = s.y > 0.0 ? 3.0 : 4.0; }
  else { uv = s.xy / a.z; face = s.z > 0.0 ? 5.0 : 6.0; }
  const float G = 70.0;
  vec2 g = (uv * 0.5 + 0.5) * G;
  vec2 cell = floor(g);
  vec2 h = hash22(cell + face * 97.13);
  float hb = hash12(cell * 1.731 + face * 13.7);
  float exist = step(0.62 - band * 0.4, hb);
  vec2 sp = cell + 0.15 + 0.7 * h;
  float cellAng = 2.0 / (G * (1.0 + dot(uv, uv)));     // angular size of one cell
  float r = length(g - sp) * cellAng / px;              // distance in pixels
  float u = fract(hb * 7.31);
  float mag = u * u * u;
  mag *= mag * mag;                                     // u^9: heavy tail, few bright stars
  float bri = (0.012 + u * 0.05 + mag * 3.2) * exist;
  float tw = 0.7 + 0.3 * sin(uSkMisc.y * (2.0 + 5.0 * h.x) + h.y * 60.0);
  float t = fract(hb * 3.17);
  vec3 tint = t < 0.2 ? vec3(0.72, 0.82, 1.25) : t < 0.8 ? vec3(1.0, 0.97, 0.94) : t < 0.93 ? vec3(1.2, 0.95, 0.72) : vec3(1.25, 0.7, 0.55);
  float sz = 1.6 - mag * 0.9;                           // bright stars look a little bigger
  col += tint * (bri * tw * exp(-r * r * sz));
  return col * vis;
}

/* ---------------------------------------------------------------- moon + sun */
/** Moon disc (phase, maria, earthshine) + halo. a = disc coverage. */
vec4 skMoon(vec3 d, float px){
  vec3 md = uSkMoon.xyz;
  float mb = uSkSunCol.w;
  if (mb <= 0.001) return vec4(0.0);
  float cosA = dot(d, md);
  const float R = 0.03;
  float chord = sqrt(max(2.0 - 2.0 * cosA, 0.0));
  float illum = 0.5 - 0.5 * cos(uSkMoon.w * 6.2831853);
  vec3 halo = vec3(0.55, 0.65, 0.9) * (exp(-chord * 9.0) * 0.085 + exp(-chord * 40.0) * 0.2) * mb * (0.15 + 0.85 * illum) * (1.0 - uSkWx.x * 0.6);
  if (chord > R * 1.6) return vec4(halo, 0.0);
  vec3 right = normalize(cross(md, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, md);
  vec2 q = vec2(dot(d, right), dot(d, up)) / R;
  float r = length(q);
  float aa = px / R * 1.5;
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
  vec3 nrm = vec3(q, sqrt(max(1.0 - r * r, 0.0)));
  float ph = uSkMoon.w * 6.2831853;
  vec3 Ld = vec3(sin(ph), 0.12, -cos(ph));
  float lit = smoothstep(-0.06, 0.1, dot(nrm, normalize(Ld)));
  float mar = tnoise(q * 0.21 + vec2(0.3, 0.6)).r;
  float cr = tnoise(q * 0.6 + vec2(0.7, 0.1)).b;
  vec3 alb = vec3(0.95, 0.93, 0.88) * (0.5 + 0.5 * smoothstep(0.36, 0.6, mar)) * (0.82 + 0.3 * cr);
  vec3 col = alb * (lit * (0.8 + 0.2 * nrm.z) * 1.0 + 0.035) * mb;
  return vec4(col * disc + halo, disc);
}

/** Sun disc with limb darkening (HDR; blooms). Only above the horizon. */
vec3 skSunDisc(vec3 d, float px){
  float mu = dot(d, uSkSun.xyz);
  const float R = 0.0135;
  float chord = sqrt(max(2.0 - 2.0 * mu, 0.0));
  if (chord > R * 2.0 || uSkSun.w <= 0.0) return vec3(0.0);
  float r = chord / R;
  float aa = max(px / R, 0.02) * 1.5;
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
  float limb = 0.55 + 0.45 * sqrt(max(1.0 - r * r, 0.0));
  return uSkSunCol.rgb * (uSkSun.w * disc * limb * smoothstep(-0.004, 0.004, d.y));
}

/* ---------------------------------------------------------------- aurora */
// Curtains in sky space (azimuth / elevation): a wavy lower edge per curtain, glow fading upward from green
// through blue to magenta, vertical rays shimmering along the azimuth. North (-Z) only.
vec3 skAurora(vec3 d){
  float amt = uSkNight.z;
  if (amt < 0.004 || d.y < 0.0) return vec3(0.0);
  float az = atan(d.x, -d.z);                          // 0 = north
  float north = 1.0 - smoothstep(0.7, 1.9, abs(az));
  if (north <= 0.0) return vec3(0.0);
  float e = d.y, t = uSkMisc.y;
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float base = 0.06 + fk * 0.055 + 0.03 * sin(az * (2.0 + fk) + t * (0.05 + fk * 0.02) + fk * 2.1)
               + (tnoise(vec2(az * 0.3 + fk * 0.37, t * 0.004 + fk * 0.21)).r - 0.5) * 0.14;
    float h = e - base;
    if (h < -0.03) continue;
    float edge = smoothstep(-0.02, 0.006, h);
    float fall = exp(-max(h, 0.0) * (9.0 + fk * 4.0));
    float patchy = smoothstep(0.3, 0.72, tnoise(vec2(az * 0.7 + fk * 0.41, t * 0.003 + fk * 0.17)).a);
    float rays = tnoise(vec2(az * 5.0 + fk * 0.53, t * 0.008 + fk * 0.3)).b;
    rays = 0.3 + 0.7 * smoothstep(0.35, 0.75, rays);
    float wave = 0.65 + 0.35 * sin(az * 9.0 - t * 0.25 + fk * 1.7);
    vec3 c = mix(vec3(0.12, 1.0, 0.45), vec3(0.25, 0.55, 1.0), smoothstep(0.04, 0.18, h + uSkBolt.w * 0.1));
    c = mix(c, vec3(0.85, 0.2, 0.62), smoothstep(0.14, 0.34, h));
    acc += c * (edge * fall * rays * wave * patchy * (1.0 - fk * 0.28));
  }
  return acc * (amt * north * 0.75);
}

/* ---------------------------------------------------------------- rainbow */
// Spectral color for x in 0 (violet, inner edge) .. 1 (red, outer edge), smooth band profile.
vec3 skSpectrum(float x){
  float h = (1.0 - clamp(x, 0.0, 1.0)) * 0.78;          // hue: 0 red .. 0.78 violet
  vec3 c = clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  float band = sin(3.14159265 * clamp(x, 0.0, 1.0));
  return c * band * band;
}
// Primary bow at ~42 deg around the anti-solar point (red outside), faint reversed secondary at ~51 deg,
// a brighter sky inside the primary and Alexander's darker band between the two.
vec3 skRainbow(vec3 d){
  float amt = uSkShootB.w;
  if (amt < 0.004 || d.y < 0.0) return vec3(0.0);
  float a = acos(clamp(dot(d, -uSkSun.xyz), -1.0, 1.0));
  if (a > 0.98) return vec3(0.0);
  vec3 c = skSpectrum((a - 0.705) / 0.038);
  c += skSpectrum((0.93 - a) / 0.055) * 0.22;
  vec3 sky = uSkyAmb.rgb;
  c += sky * (0.12 * smoothstep(0.73, 0.5, a) - 0.06 * smoothstep(0.74, 0.77, a) * smoothstep(0.9, 0.87, a));
  return c * (amt * 0.55 * smoothstep(0.0, 0.25, d.y)) * (0.35 + 0.65 * uSunDir.w) * (uSunColor.rgb / max(max(uSunColor.r, uSunColor.g), 0.2));
}

/* ---------------------------------------------------------------- composites */
/** Sky radiance for reflections (no sun disc — water adds its own specular). rough 0..1 hides stars. */
vec3 skyReflect(vec3 d, float rough){
  d.y = max(d.y, 0.002);
  vec3 c = skBase(d);
  float calm = 1.0 - clamp(rough, 0.0, 1.0);
  if (uSkNight.x > 0.01 && calm > 0.05) c += skStars(d, uSkMisc.x * 2.5) * calm;
  if (uSkNight.z > 0.004) c += skAurora(d);
  vec4 m = skMoon(d, uSkMisc.x * 2.0);
  c = c * (1.0 - m.a * 0.9) + m.rgb * calm;
  if (uSkShootB.w > 0.004) c += skRainbow(d) * calm;
  // reflected clouds: softer (waves blur them), fading with roughness, in fog, and toward the horizon where
  // a mirror-flat far sea would squash them into horizontal bands
  vec4 cl = skClouds(d, false) * (mix(0.8, 0.5, clamp(rough, 0.0, 1.0)) * smoothstep(0.08, 0.35, d.y) * (1.0 - skFoggy() * 0.85));
  return c * (1.0 - cl.a) + cl.rgb;
}
`;

/** GLSL gets its own luma (the foundation shaderlib has no libLuma). */
const GLSL = (LIB2 ? '#define SK_LIB2\n' : '') + 'float libLumaSk(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }\n' + GLSL_CHUNK;

const SKY_FS = `
in vec2 vNdc; uniform mat4 uInvVP; out vec4 fragColor;
void main(){
  vec4 a = uInvVP * vec4(vNdc, -1.0, 1.0), b = uInvVP * vec4(vNdc, 1.0, 1.0);
  vec3 d = normalize(b.xyz / b.w - a.xyz / a.w);
  float px = uSkMisc.x;
  vec3 col;
  if (d.y < -0.004) {
    col = skBase(d);                                   // the thin sliver between far geometry and the horizon
  } else {
    col = skBase(d);
    float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (uSkNight.x > 0.003) col += skStars(d, px);
    if (uSkNight.z > 0.004) col += skAurora(d);
    vec4 m = skMoon(d, px);
    col = col * (1.0 - m.a) + m.rgb;
    col += skSunDisc(d, px);
    if (uSkShootB.w > 0.004) col += skRainbow(d);
    // shooting star: bright streak fading toward the tail
    if (uSkShootA.w > 0.0) {
      vec3 hd = uSkShootA.xyz, tl = uSkShootB.xyz, ab = hd - tl;
      float t = clamp(dot(d - tl, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
      float dist = length(d - (tl + ab * t)) / (px * 1.1);
      col += vec3(1.0, 0.93, 0.82) * (exp(-dist * dist) * t * t * uSkShootA.w * 4.0);
    }
    vec4 cl = skClouds(d, true) * (1.0 - skFoggy() * 0.75);
    col = col * (1.0 - cl.a) + cl.rgb;
    // tiny dither against gradient banding after tonemapping
    col *= 1.0 + (jit - 0.5) * 0.012;
  }
  fragColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

/* ------------------------------------------------------------------ */
/* Module                                                               */
/* ------------------------------------------------------------------ */
const Sk = (VC.sky = {
  name: 'sky',
  order: 900,
  GLSL,
  UBO_BINDING,
  moonPhase: 0.5,
  moonIllum: 1,
  cover: 0.25,
  auroraLevel: 0,
  cityGlow: 0,
  _forceAurora: null,
  _forceBow: null,

  init() {
    Sk.data = new Float32Array(UBO_VEC4 * 4);
    initGL();
    // simulation state (real-time, independent of the sim speed)
    Sk.st = {
      cu: [0.13, 0.57], ci: [0.71, 0.29], wind: [1, 0], windS: 0.5, cover: 0.25, rain: 0, cirrus: 0.5,
      glow: 0, aurora: 0, bow: 0, auroraRoll: -1, nightCount: 0, lastTod: 0,
      shoot: null, shootWait: 6, boltDir: [0, 1, 0], lastLightning: 0, rng: M.rng(90731),
    };
    VC.gfx.addLayer(Sk);
  },

  /** Re-creates the GL objects (SkyFrame UBO, sky program) after a WebGL context restore. */
  restore() {
    Sk._err = false;
    initGL();
  },

  /** Binds the SkyFrame uniform block of a program that includes VC.sky.GLSL. */
  attach(P) {
    const gl = VC.gfx.gl;
    const prog = P && P.prog ? P.prog : P;
    if (!gl || !prog) return;
    const bi = gl.getUniformBlockIndex(prog, 'SkyFrame');
    if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(prog, bi, UBO_BINDING);
  },

  reset(S) {
    const st = Sk.st;
    if (!st) return;
    st.shoot = null;
    st.auroraRoll = -1;
    st.aurora = 0;
    st.rng = M.rng(((S && S.seed) || 1) ^ 0x5eed);
    const w = (S && S.weather) || {};
    st.cover = w.cloud == null ? 0.25 : w.cloud;
    st.rain = w.wet || 0;
    const a = w.windDir || 0;
    st.wind[0] = Math.cos(a);
    st.wind[1] = Math.sin(a);
  },

  /** Forces the rainbow (0..1) or back to automatic (null). */
  forceRainbow(v) {
    Sk._forceBow = v == null ? null : M.sat(+v);
  },

  /** Forces the aurora on (0..1) or back to automatic (null). */
  forceAurora(v) {
    Sk._forceAurora = v == null ? null : M.sat(+v);
  },

  /** Spawns a shooting star right now (visible at night). */
  shootingStar() {
    if (!Sk.st) return;
    const st = Sk.st, r = st.rng;
    const az = r() * M.PI2, el = 0.35 + r() * 0.55;
    const head = [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)];
    // travel mostly downward and sideways, 10..22 degrees long
    const len = (10 + r() * 12) * M.DEG;
    const side = r() < 0.5 ? -1 : 1;
    const t = VC.V3.norm([-Math.sin(az) * side, -0.55 - r() * 0.4, Math.cos(az) * side]);
    const end = VC.V3.norm([head[0] + t[0] * len, head[1] + t[1] * len, head[2] + t[2] * len]);
    st.shoot = { a: head, b: end, t: 0, dur: 0.45 + r() * 0.6, bri: 0.6 + r() * 0.8 };
  },

  update(dt, rdt) {
    if (!Sk.st) return;
    try {
      simulate(rdt || 0);
      upload();
    } catch (e) {
      if (!Sk._err) console.error('[sky] update failed', e);
      Sk._err = true;
    }
  },

  opaque(ctx) {
    const gl = ctx.gl;
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, UBO_BINDING, Sk.ubo);
    Sk.prog.use();
    gl.uniformMatrix4fv(Sk.prog.u.uInvVP, false, ctx.cam.invViewProj);
    VC.gfx.fullscreen();
  },
});

/** (Re)creates the SkyFrame UBO and the sky program. */
function initGL() {
  const G = VC.gfx, gl = G.gl;
  Sk.ubo = gl.createBuffer();
  gl.bindBuffer(gl.UNIFORM_BUFFER, Sk.ubo);
  gl.bufferData(gl.UNIFORM_BUFFER, Sk.data.byteLength, gl.DYNAMIC_DRAW);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, UBO_BINDING, Sk.ubo);
  Sk.prog = G.program(
    'sky',
    `out vec2 vNdc; void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0; vNdc = p; gl_Position = vec4(p, 1.0, 1.0); }`,
    GLSL + SKY_FS
  );
  Sk.attach(Sk.prog);
}

/* ------------------------------------------------------------------ */
/* Per-frame sky simulation (clouds drift, weather smoothing, events)   */
/* ------------------------------------------------------------------ */
function simulate(rdt) {
  const st = Sk.st, S = VC.state, env = VC.gfx.env;
  const w = (S && S.weather) || { cloud: 0.25, wet: 0, wind: 0.5, windDir: 0.6, lightning: 0 };
  const k = 1 - Math.exp(-rdt * 2.5); // fx already eases weather over ~15 s; this only guards against jumps
  // smoothed wind vector (direction changes never make the clouds jump)
  const a = w.windDir || 0;
  st.wind[0] += (Math.cos(a) - st.wind[0]) * k;
  st.wind[1] += (Math.sin(a) - st.wind[1]) * k;
  const wl = Math.hypot(st.wind[0], st.wind[1]) || 1;
  const wx = st.wind[0] / wl, wz = st.wind[1] / wl;
  st.windS += ((w.wind == null ? 0.5 : w.wind) - st.windS) * k;
  st.cover += (M.sat(w.cloud == null ? 0.25 : w.cloud) - st.cover) * k;
  st.rain += (M.sat(w.wet || 0) - st.rain) * k;
  // drift: cumulus with the wind, cirrus slower and veered
  const sp = 0.0035 + 0.011 * st.windS;
  st.cu[0] = (st.cu[0] + wx * sp * rdt) % 64;
  st.cu[1] = (st.cu[1] + wz * sp * rdt) % 64;
  st.ci[0] = (st.ci[0] + sp * 0.6 * rdt) % 64;
  st.ci[1] = (st.ci[1] + sp * 0.12 * rdt) % 64;
  // cirrus come and go with the (sim) days; fewer under a thick deck
  const day = S ? S.time.day : 0;
  const ciT = 0.25 + 0.75 * M.smoothstep(0.25, 0.75, 0.5 + 0.5 * Math.sin(day * 0.21 + 1.3)) * (1 - st.rain);
  st.cirrus += (ciT - st.cirrus) * k * 0.3;
  // city glow from the population (log scale)
  const pop = (S && S.stats && S.stats.pop) || 0;
  const glowT = M.sat(Math.log10(1 + pop) / 6.2);
  st.glow += (glowT - st.glow) * (1 - Math.exp(-rdt * 0.3));
  Sk.cityGlow = st.glow;
  Sk.cover = st.cover;

  // moon phase from the sim day (~29.5 day cycle)
  const ph = M.fract((day + 7.4) / 29.53);
  Sk.moonPhase = ph;
  Sk.moonIllum = 0.5 - 0.5 * Math.cos(ph * M.PI2);

  const night = env ? env.night : 0;
  const tod = env ? env.tod : 0.5;
  // count visual nights (tod passes midnight) — each night rolls its own aurora chance
  if (tod < st.lastTod - 0.5) st.nightCount++;
  st.lastTod = tod;
  const winter = env ? Math.max(env.snow || 0, M.smoothstep(2.6, 3.0, env.season || 0) * (1 - M.smoothstep(3.7, 3.95, env.season || 0))) : 0;
  let aT = 0;
  if (winter > 0.5 && night > 0.6 && st.cover < 0.6) {
    const nightId = st.nightCount * 7 + Math.floor(day / 90);
    if (st.auroraRoll !== nightId) {
      st.auroraRoll = nightId;
      st.auroraOn = M.hash(nightId, (S && S.seed) || 0, 77) < 0.45;
      st.auroraHue = M.hash(nightId, 3, 91) * 0.3 - 0.1;
    }
    if (st.auroraOn) aT = M.smoothstep(0.6, 0.95, night) * (1 - M.smoothstep(0.3, 0.6, st.cover)) * winter;
  }
  if (Sk._forceAurora != null) aT = Sk._forceAurora * M.smoothstep(0.3, 0.8, night);
  st.aurora += (aT - st.aurora) * (1 - Math.exp(-rdt * 0.25));
  if (Sk._forceAurora != null && rdt === 0) st.aurora = aT;
  Sk.auroraLevel = st.aurora;

  // rainbow: sun out (fairly low, behind the viewer) while the air is still wet after rain
  const hS = env && env.sun ? env.sun[1] : 0.5;
  const bowT = M.smoothstep(0.62, 0.35, st.cover) * M.smoothstep(0.15, 0.45, st.rain) * M.smoothstep(0.03, 0.12, hS) * (1 - M.smoothstep(0.5, 0.72, hS));
  st.bow += ((Sk._forceBow != null ? Sk._forceBow : bowT) - st.bow) * (1 - Math.exp(-rdt * 0.4));
  if (Sk._forceBow != null && rdt === 0) st.bow = Sk._forceBow;

  // shooting stars on clear nights
  if (st.shoot) {
    st.shoot.t += rdt / st.shoot.dur;
    if (st.shoot.t >= 1) st.shoot = null;
  } else if (night > 0.75 && st.cover < 0.65) {
    st.shootWait -= rdt;
    if (st.shootWait <= 0) {
      st.shootWait = 3 + st.rng() * 12;
      Sk.shootingStar();
    }
  }

  // lightning: pick a fresh direction for every new flash
  const lf = w.lightning || 0;
  if (lf > 0.05 && st.lastLightning <= 0.05) {
    // light the clouds above the actual bolt when fx reports it ({x, z} world), else somewhere random
    const lb = VC.fx && VC.fx.lastBolt, cp = VC.camera && VC.camera.pos;
    if (lb && cp && lb.x != null && lb.z != null) {
      st.boltDir = VC.V3.norm([lb.x - cp[0], Math.max(8, 60 - cp[1]), lb.z - cp[2]]);
    } else {
      const az = st.rng() * M.PI2, el = 0.12 + st.rng() * 0.5;
      st.boltDir = [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)];
    }
  }
  st.lastLightning = lf;
}

/** Writes one vec4 of the SkyFrame block. */
function put(i, a, b, c, d) {
  const f = Sk.data;
  f[i * 4] = a; f[i * 4 + 1] = b; f[i * 4 + 2] = c; f[i * 4 + 3] = d;
}
/** Normalized lerp of unit vectors a -> b into out. */
function nlerp(out, a, b, t) {
  const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}
const _hd = [0, 1, 0], _tl = [0, 1, 0];

/** Fills and uploads the SkyFrame uniform block (allocation free). */
function upload() {
  const G = VC.gfx, gl = G.gl, env = G.env, st = Sk.st, cam = VC.camera;
  if (!gl || !env || G.lost || gl.isContextLost()) return;
  const sun = env.sun || env.sunDir, moon = env.moon || _hd;
  const h = sun[1];
  // sun disc: warm and dimmer near the horizon, hidden below it
  const warm = M.smoothstep(0.32, 0.0, h);
  const discI = 26 * M.smoothstep(-0.02, 0.05, h) * (1 - 0.55 * warm) * (1 - st.rain * 0.9);
  const night = env.night || 0;
  put(0, sun[0], sun[1], sun[2], discI);
  put(1, moon[0], moon[1], moon[2], Sk.moonPhase);
  put(2, 1.0, M.lerp(0.93, 0.5, warm), M.lerp(0.82, 0.2, warm), 0.75 * M.smoothstep(0.15, 0.8, night));
  put(3, st.cu[0], st.cu[1], st.ci[0], st.ci[1]);
  put(4, st.cover, st.rain, st.cirrus * (1 - M.smoothstep(0.5, 0.9, st.cover)), M.smoothstep(0.62, 0.95, st.cover));
  // stars: fade in after dusk; rain, fog and a bright full moon wash the faint ones out
  const starVis = M.smoothstep(0.45, 0.95, night) * (1 - st.rain) * (1 - (env.fogWeather || 0) * 0.8) * (1 - Sk.moonIllum * 0.3);
  put(5, starVis, ((env.tod || 0) - 0.5) * M.PI2 * 0.9, st.aurora, st.glow);
  const px = (2 * Math.tan(((cam && cam.fov) || 0.6) / 2)) / Math.max(1, G.rh || 1);
  const after = M.smoothstep(-0.22, -0.03, h) * (1 - M.smoothstep(-0.03, 0.08, h)) * (1 - st.cover * 0.5);
  put(6, px, G.time % 3600, env.lightning || 0, after);
  const sh = st.shoot;
  if (sh) {
    const t = sh.t;
    nlerp(_hd, sh.a, sh.b, t);
    nlerp(_tl, sh.a, sh.b, Math.max(0, t - 0.35));
    put(7, _hd[0], _hd[1], _hd[2], Math.sin(Math.PI * M.sat(t)) * sh.bri * M.smoothstep(0.6, 0.9, night));
    put(8, _tl[0], _tl[1], _tl[2], st.bow);
  } else {
    put(7, 0, 1, 0, 0);
    put(8, 0, 1, 0, st.bow);
  }
  put(9, st.boltDir[0], st.boltDir[1], st.boltDir[2], st.auroraHue || 0);
  const wl = Math.hypot(st.wind[0], st.wind[1]) || 1;
  put(10, st.wind[0] / wl, st.wind[1] / wl, st.windS, h);
  gl.bindBuffer(gl.UNIFORM_BUFFER, Sk.ubo);
  gl.bufferSubData(gl.UNIFORM_BUFFER, 0, Sk.data);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, UBO_BINDING, Sk.ubo);
}
