/*
 * VOXELPOLIS — water (VC.water, TRANSPARENT layer order 500).
 *
 * SURFACE: one camera-centered quad at C.SEA_Y reaching the far plane (the ocean continues past the
 * map edges and dissolves into the sky's horizon color, so there is never a visible edge). Past the map
 * border the seabed keeps shelving off from the edge tile's depth (synthetic sand / silt bed with caustics),
 * so river mouths and shelves continue across the border without a seam; next to map-edge land the sea is
 * deep at once and the surf stripe along the border is suppressed.
 * VISIBILITY (CPU, per frame): water-tile counts per 16x16 cell vs the camera frustum + the frustum's
 * footprint on the sea plane vs the map rect -> no water in view = no scene copy and no draw; otherwise the
 * copy and the draw are scissored to the projected water rect (+ margin; SSR copies up to the top edge).
 *
 * VARIANTS (by quality, see chooseVariant):
 *   basic   (low)          alpha-blended; depth from BILINEAR terrain levels (4 uTileTex fetches)
 *   refract (medium)       the opaque scene (color + depth) is blitted into a copy first, so the water is
 *                          drawn opaque: true path length through water (absorption per channel, turquoise
 *                          shallows -> deep blue), refraction of the seabed through the waves, contact foam
 *                          around anything piercing the surface (bridge piers, boats, cliffs)
 *   ssr     (high/ultra)   + screen-space reflections of the city (lit windows at night!) over the sky
 * DEPTH + MARKER: water pixels get HDR alpha 0 (a mask post can read). The surface depth is written in
 * writeDepth 'auto' mode while SSAO is off, or when post skips AO on the marker (VC.post.waterMask): then
 * particles / effects below the surface are hidden and DOF focuses on the surface (a flat depth-written plane
 * at grazing angles makes screen-space AO band into stripes; without depth post sees the seabed instead).
 * SPECULAR AA: slope variance the pixel footprint cannot resolve widens the glint lobes (Toksvig, energy
 * conserving, capped HDR peak) -> a soft sun path far away instead of aliased blobs that bloom + DOF enlarge.
 * DATA OVERLAY: rivers / lakes / coast carry the map overlay like the land (VC.terrain.OVERLAY_GLSL).
 *
 * SHADING: wind-aligned analytic swells + 4 scrolling noise slope layers (roughness from uWind.z, choppy
 * storms with whitecaps), Fresnel reflection of the shared sky (VC.sky.GLSL: gradient, clouds, stars and
 * aurora on calm water), HDR sun/moon glints + twinkling sparkles (bloom), subsurface glow in backlit
 * crests, shoreline foam (breaking band + incoming wave lines + bubbly break-up), river flow (flow-map
 * advected ripples and foam streaks), rain ripple rings (WET), winter ice (shore ice / frozen ponds with
 * cracks and snow dust, SNOW), polluted water (murky, oily sheen, from S.maps.pollution), bioluminescent
 * surf on warm nights, build grid, fallback caustics (only when the terrain renderer draws none).
 * Texture units used while drawing: 0 scene color copy, 1 scene depth copy, 2 water field, 3 pollution,
 * 4 overlay relevance.
 *
 * WATER FIELD (CPU, texture uField 2 texels per tile, LINEAR): r signed distance to the shore in tiles
 * (+ water, - land, ±3), g lake class (1 small enclosed pond, 0.5 large lake, 0 sea-connected), ba flow
 * vector * speed (rivers flow toward the body's mouth on the map edge). Rebuilt on reset; terrain edits
 * that change water tiles update it debounced and incrementally: SDF for the rect, re-analysis of only the
 * bodies touching it, partial texture upload (identical to a full rebuild). Pollution uploads lazily.
 *
 * API: ocean (bool; false = diorama: water clipped to the map, translucent water walls at the map edges),
 *   mode ('auto' | 'basic' | 'refract' | 'ssr'), writeDepth ('auto' | true | false), freeze (0..1 current ice
 *   amount), depthAt(wx, wz), shoreDist(wx, wz) (tiles, + over water), iceAt(wx, wz) 0..1, flowAt(wx, wz) ->
 *   {x, z, speed}, bodies [{id, size, sea, lake}], stats {variant, visible, depth, copyPx, fieldMs, ...},
 *   rebuild(), variant(name) -> program, warmup() (compiles every water program), restore() (re-creates every
 *   GL object after a WebGL context restore). A failed scene copy falls back to 'basic' until the next resize.
 */
const M = VC.M, C = VC.C;
const RMAX = 3; // signed distance range (tiles)
const FR = 2; // field texels per tile
const POND = 350; // enclosed water bodies up to this many tiles freeze over completely
const OV_UNIT = 4; // overlay relevance texture unit (same as VC.terrain.OV_UNIT)
const WC = 16; // visibility cell size (tiles) of the water-tile counts

/* ------------------------------------------------------------------ */
/* Shader                                                               */
/* ------------------------------------------------------------------ */
const VS = `
uniform vec4 uRect; // xz min, xz max of the water quad
out vec3 vWp;
void main(){
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 xz = mix(uRect.xy, uRect.zw, c);
  vWp = vec3(xz.x, SEA_Y, xz.y);
  gl_Position = uViewProj * vec4(vWp, 1.0);
}`;

const FS = `
in vec3 vWp;
out vec4 fragColor;
uniform sampler2D uScene;      // unit 0: opaque scene color copy (refract variants)
uniform sampler2D uSceneDepth; // unit 1: opaque scene depth copy
uniform sampler2D uField;      // unit 2: water field
uniform sampler2D uPoll;       // unit 3: pollution (tile res)
uniform vec4 uWt;   // x foam strength, y freeze 0..1, z fallback caustics 0..1, w ocean (1) or map-clipped (0)
uniform vec4 uWt2;  // x storm 0..1, y rain ripples 0..1, z far plane, w reflection boost

float linZ(float d){ return uProj[3][2] / ((d * 2.0 - 1.0) + uProj[2][2]); }

/* ---- waves: analytic swells (height-field gradients) + scrolling noise slopes ---- */
// fp = world size of one pixel footprint along the view: each swell fades out before it can alias.
vec3 waveNormal(vec2 p, float lodFine, float lodSwell, float amp, float storm, vec2 flow, float fp, out float crest){
  float t = TIME;
  vec2 w = uWind.xy;
  vec2 wn = vec2(-w.y, w.x);
  vec2 d1 = w, d2 = normalize(w + wn * 0.65), d3 = normalize(w - wn * 0.8);
  vec2 n1 = tnoise(p * 0.09 + w * (t * 0.016)).rg - 0.5;
  // swells: phases warped and amplitudes grouped by the coarse noise, so crests never form straight stripes
  vec2 warp = n1 * 7.0;
  float s1 = dot(p, d1) * 1.3 - t * 1.25 + warp.x;
  float s2 = dot(p, d2) * 2.1 - t * 1.6 + warp.y;
  float s3 = dot(p, d3) * 3.3 - t * 2.05 + warp.x - warp.y;
  float grp = 0.4 + 1.2 * clamp(n1.y + 0.5, 0.0, 1.0);
  float c1 = cos(s1), c2 = cos(s2), c3 = cos(s3);
  crest = (sin(s1) * 0.5 + sin(s2) * 0.3 + sin(s3) * 0.2) * grp;
  float a1 = 1.0 - smoothstep(0.6, 1.6, fp), a2 = 1.0 - smoothstep(0.38, 1.0, fp), a3 = 1.0 - smoothstep(0.24, 0.64, fp);
  crest *= mix(a3, a1, 0.5);
  vec2 g = (d1 * (0.65 * c1 * a1) + d2 * (0.63 * c2 * a2) + d3 * (0.66 * c3 * a3)) * ((0.035 + storm * 0.1) * lodSwell * grp);
  vec2 n2 = tnoise(p * 0.21 - d2 * (t * 0.025) + 0.37).ba - 0.5;
  vec2 n3 = tnoise(p * 0.57 + d3 * (t * 0.045) + 0.61).gr - 0.5;
  vec2 slope = g + (n1 * 1.0 + n2 * 0.75 + n3 * 0.55 * lodFine) * amp;
  if (lodFine > 0.01) slope += (tnoise(p * 1.45 - w * (t * 0.08) + 0.13).ab - 0.5) * (0.4 * amp * lodFine);
  // rivers: two-phase flow-map advection of a ripple layer along the flow
  float fs = length(flow);
  if (fs > 0.03) {
    float ph0 = fract(t * 0.3), ph1 = fract(t * 0.3 + 0.5);
    float wgt = abs(ph0 - 0.5) * 2.0;
    vec2 a = tnoise((p - flow * (ph0 * 2.2)) * 0.7).rg;
    vec2 b = tnoise((p - flow * (ph1 * 2.2)) * 0.7 + 0.5).rg;
    slope += (mix(a, b, wgt) - 0.5) * (1.1 * min(fs, 1.0));
  }
  crest += (n1.x + n2.x) * 1.2;
  return normalize(vec3(-slope.x, 1.0, -slope.y));
}

/* ---- seabed depth below SEA_Y, bilinear between the 4 surrounding tile centers (land clamped) ---- */
float bedDepth(vec2 p){
  vec2 tc = p - 0.5;
  vec2 fc = fract(tc);
  ivec2 i0 = ivec2(floor(tc));
  ivec2 mx = ivec2(uMap.xy) - 1;
  const float LAND = ${(C.SEA / 255).toFixed(6)};
  float l00 = min(texelFetch(uTileTex, clamp(i0, ivec2(0), mx), 0).r, LAND);
  float l10 = min(texelFetch(uTileTex, clamp(i0 + ivec2(1, 0), ivec2(0), mx), 0).r, LAND);
  float l01 = min(texelFetch(uTileTex, clamp(i0 + ivec2(0, 1), ivec2(0), mx), 0).r, LAND);
  float l11 = min(texelFetch(uTileTex, clamp(i0 + ivec2(1, 1), ivec2(0), mx), 0).r, LAND);
  float lv = mix(mix(l00, l10, fc.x), mix(l01, l11, fc.x), fc.y) * ${(255 * C.STEP).toFixed(4)};
  return max(SEA_Y - lv, 0.0);
}

/* ---- rain rings: one expanding ring per cell, two offset layers ---- */
vec2 rippleCell(vec2 p, float t){
  vec2 c = floor(p);
  vec2 h = hash22(c);
  vec2 f = fract(p) - 0.5 - (h - 0.5) * 0.5;
  float ph = fract(t * (0.8 + h.x * 0.5) + h.y);
  float r = length(f);
  float rr = ph * 0.42;
  float ring = sin((r - rr) * 42.0) * smoothstep(0.07, 0.0, abs(r - rr)) * (1.0 - ph);
  return f / max(r, 1e-3) * ring;
}

/* ---- ice cracks: distance to cellular (voronoi) borders ---- */
float iceCracks(vec2 p){
  vec2 c = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(x, y);
    vec2 q = o + hash22(c + o) - f;
    float d = dot(q, q);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return sqrt(d2) - sqrt(d1);
}

/* ---- fallback caustics (the diorama terrain draws its own) ---- */
float wtCaustic(vec2 p){
  float t = TIME * 0.7;
  vec2 q = p * 2.6;
  float w = sin(q.x * 1.1 + sin(q.y * 1.4 - t) * 1.1 + t) + sin(q.y * 0.9 + sin(q.x * 1.2 + t * 0.8) - t * 0.6);
  return pow(1.0 - smoothstep(0.0, 0.5, abs(w)), 3.0);
}

#ifdef SSR
/* ---- screen-space reflection march against the scene depth copy ---- */
vec4 ssrTrace(vec3 p0, vec3 R, float dist){
  float t = 0.2 + dist * 0.005, tPrev = 0.0;
  for (int i = 0; i < SSR_STEPS; i++) {
    vec4 c = uViewProj * vec4(p0 + R * t, 1.0);
    if (c.w < 0.05) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    float dz = c.w - linZ(texture(uSceneDepth, uv).r);
    if (dz > 0.0 && dz < (t - tPrev) * 2.5 + 0.25) {
      float a = tPrev, b = t;
      for (int j = 0; j < 4; j++) {
        float m = (a + b) * 0.5;
        vec4 cm = uViewProj * vec4(p0 + R * m, 1.0);
        vec2 um = cm.xy / cm.w * 0.5 + 0.5;
        if (cm.w > linZ(texture(uSceneDepth, um).r)) b = m; else a = m;
      }
      vec4 cb = uViewProj * vec4(p0 + R * b, 1.0);
      vec2 ub = cb.xy / cb.w * 0.5 + 0.5;
      vec2 e = smoothstep(vec2(0.0), vec2(0.06), ub) * smoothstep(vec2(1.0), vec2(0.94), ub);
      return vec4(texture(uScene, ub).rgb, e.x * e.y * (1.0 - float(i) / float(SSR_STEPS)));
    }
    tPrev = t;
    t = t * 1.42 + 0.05;
  }
  return vec4(0.0);
}
#endif

void main(){
  vec3 ray = vWp - uCamPos.xyz;
  float dist = length(ray);
  vec3 rd = ray / dist;
  vec3 v = -rd;
  vec2 p = vWp.xz;
  float outD = length(max(max(-p, p - uMap.xy), vec2(0.0)));   // distance outside the map (0 inside)
  // beyond the map the in-map values fade out over a few tiles instead of stopping dead at the border
  float outF = smoothstep(0.0, 4.0, outD);

  // ---- water field ----
  vec4 fd = texture(uField, clamp(p, vec2(0.0), uMap.xy) / uMap.xy);
  float sd = (fd.r - 0.5) * ${(RMAX * 2).toFixed(1)};
  float lake = fd.g * (1.0 - outF);
  vec2 flow = (fd.ba - 0.5) * 2.0 * (1.0 - outF);
  float sdEdge = sd;                                              // (+ water / - land at the nearest map point)
  if (outD > 0.0) sd = max(sd, 0.0) + outD;
  float poll = texture(uPoll, clamp(p, vec2(0.0), uMap.xy) / uMap.xy).r * (1.0 - outF);

  // ---- level of detail & sea state ----
  float lodFine = 1.0 - smoothstep(25.0, 110.0, dist);
  float lodSwell = 1.0 - smoothstep(80.0, 320.0, dist);
  float storm = uWt2.x;
  float open = smoothstep(0.8, 4.0, sd);                        // open water gets the bigger seas
  float amp = (0.42 + uWind.z * 0.45 + storm * 1.3 * open) * mix(0.55, 1.0, open) * (1.0 - poll * 0.5);
  float crest;
  // pixel footprint on the water (world units along the view): grows with distance and at grazing angles
  float fp = dist * (2.0 / (uProj[1][1] * uScreen.y)) / max(-rd.y, 0.02);
  vec3 n = waveNormal(p, lodFine, lodSwell * mix(0.35, 1.0, open), amp, storm * open, flow, fp, crest);
  // rain rings
  float rain = uWt2.y * lodFine * (1.0 - smoothstep(0.04, 0.12, fp));
  if (rain > 0.01) {
    vec2 rp = (rippleCell(p * 5.0, TIME) + rippleCell(p * 5.0 + vec2(0.5, 0.27), TIME + 0.43)) * (0.55 * rain);
    n = normalize(n + vec3(-rp.x, 0.0, -rp.y));
  }
  float rough = clamp(amp * 0.9 + rain * 0.4, 0.0, 1.0);

  // ---- lighting terms ----
  vec3 L = uSunDir.xyz;
  vec3 sunL = uSunColor.rgb * (uSunDir.w * max(L.y, 0.0));
  vec3 ambL = uSkyAmb.rgb;

  // ---- depth below the surface ----
  float sh = shadowAt(vWp, vec3(0.0, 1.0, 0.0)) * cloudShadow(vWp);
  float vdep, thick, vdepC;
  float bedS = bedDepth(p);                                       // smooth (bilinear) seabed depth; edge tile off the map
  vec3 scene = vec3(0.0);
#ifdef REFRACT
  vec2 suv = gl_FragCoord.xy * uScreen.zw;
  float linS = linZ(gl_FragCoord.z);
  float cosT = max(linS / dist, 0.05);
  float dB0 = linZ(texture(uSceneDepth, suv).r);
  float thick0 = max(dB0 - linS, 0.0) / cosT;
  vec2 ruv = suv + n.xz * (0.045 * min(thick0, 1.0)) / (1.0 + dist * 0.03);
  float dB = linZ(texture(uSceneDepth, ruv).r);
  if (dB < linS + 0.01) { ruv = suv; dB = dB0; }                 // never refract what floats above the water
  thick = max(dB - linS, 0.0) / cosT;
  vdep = SEA_Y - (uCamPos.y + rd.y * dB / cosT);
  vdepC = SEA_Y - (uCamPos.y + rd.y * dB0 / cosT);               // unrefracted: contact foam
  scene = texture(uScene, ruv).rgb;
  if (thick < 0.6) {
    // shallows: a small blur across the waves softens the per-tile seabed steps (no tile checkerboard)
    vec2 bo = vec2(n.z, -n.x) * (0.012 / (1.0 + dist * 0.03)) + uScreen.zw * 1.5;
    scene = (scene * 2.0 + texture(uScene, ruv + bo).rgb + texture(uScene, ruv - bo).rgb) * 0.25;
  }
#else
  vdep = bedS;
  thick = vdep / max(-rd.y, 0.12);
  vdepC = 9.0;
#endif
  float vdepB = mix(vdep, bedS, 0.65);                            // body tint follows the smooth seabed
  // beyond the map: the seabed keeps shelving off from the edge tile's depth into the open deep, so river
  // mouths and shelves continue past the border (same depth, colour, caustics) instead of a hard seam
  float wOut = smoothstep(0.0, 0.35, outD);
  if (outD > 0.0) {
    // (shelving continues only where the edge tile is water: past map-edge land the sea is deep at once)
    float od = mix(mix(1.35, bedS, smoothstep(-0.2, 0.4, sdEdge)), 1.35 + outD * 0.35, outF);
    vdep = mix(vdep, od, wOut);
    vdepB = mix(vdepB, od, wOut);
    thick = mix(thick, od / max(-rd.y, 0.1), wOut);
    vdepC = 9.0;
#ifdef REFRACT
    // no geometry out here: a synthetic seabed (sand at the shelf, dark silt in the deep) with caustics
    vec3 bedA = srgb2lin(mix(vec3(0.62, 0.6, 0.42), vec3(0.19, 0.22, 0.14), smoothstep(0.2, 1.1, od)) * vec3(0.84, 0.97, 0.92));
    vec3 bedL = bedA * (ambL * 0.9 + sunL * (0.85 * sh + 0.05));
    bedL += bedA * sunL * (wtCaustic(p + n.xz * 0.3) * 0.55 * sh * exp(-od * 1.1));
    scene = mix(scene, bedL, wOut);
#endif
  }

  // ---- body color: absorption along the path + in-scattering ----
  vec3 sigma = mix(vec3(2.3, 0.92, 0.7), vec3(3.4, 2.3, 2.9), poll);
  vec3 T = exp(-sigma * thick);
  vec3 shallowC = vec3(0.04, 0.46, 0.56), deepC = vec3(0.01, 0.06, 0.14);
  vec3 body = mix(shallowC, deepC, smoothstep(0.05, 1.25, vdepB));
  body = mix(body, vec3(0.12, 0.13, 0.05), poll * 0.85);
  body *= 1.0 - WET * 0.3 - storm * 0.2;                           // rain & storms: dark, leaden water
  vec3 bodyLit = body * (ambL * 0.95 + sunL * (0.3 * sh + 0.06));
  // subsurface glow through backlit crests
  float back = pow(max(dot(rd, L), 0.0), 3.0);
  bodyLit += vec3(0.05, 0.42, 0.36) * (sunL * (back * max(crest, 0.0) * 0.18 * sh)) * (1.0 - poll);
#ifdef REFRACT
  vec3 filt = mix(vec3(0.62, 0.95, 1.12), vec3(1.0), poll);          // stylized cyan cast on the seabed
  if (uWt.z > 0.001 && vdep < 1.4) scene += scene * sunL * (wtCaustic(p + n.xz * 0.3) * uWt.z * 0.5 * sh * (1.0 - smoothstep(0.2, 1.4, vdep)));
  // the seabed's own hue fades with depth (keeps shallows turquoise over sand, weeds or rock alike)
  float sl = dot(scene, vec3(0.2126, 0.7152, 0.0722));
  scene = mix(scene, vec3(sl), mix(0.4, 0.65, smoothstep(0.05, 0.9, thick)) * (1.0 - poll));
  vec3 refr = scene * T * filt + bodyLit * max(1.0 - T, vec3(0.3));
#else
  vec3 refr = bodyLit;
#endif

  // ---- reflection ----
  float nv = max(dot(n, v), 0.0);
  float fres = 0.025 + 0.975 * pow(1.0 - nv, 5.0);
  fres = min(fres * uWt2.w, 1.0);
  vec3 R = reflect(rd, n);
  R.y = abs(R.y);
  vec3 refl = skyReflect(R, rough);
#ifdef SSR
  // city reflections: objects mirror more strongly than the sky (stylized "wet mirror" look)
  if (dist < 320.0 && R.y < 0.9) {                               // near-vertical reflections hit nothing: skip
    vec4 hit = ssrTrace(vWp, normalize(R + vec3(0.0, 0.03, 0.0)), dist);
    refl = mix(refl, hit.rgb, hit.a);
    fres = mix(fres, min(fres * 2.2 + 0.1, 0.75), hit.a * (1.0 - rough * 0.5));
  }
#endif
  vec3 col = mix(refr, refl, fres);

  // polluted water: drifting oil slicks with a faint thin-film rainbow
  if (poll > 0.05) {
    float slick = smoothstep(0.56, 0.68, tnoise(p * 0.11 + vec2(TIME * 0.003, -TIME * 0.002)).a) * smoothstep(0.2, 0.7, poll);
    if (slick > 0.001) {
      float fl = tnoise(p * 0.45 + vec2(TIME * 0.006, 0.0)).r * 2.5 + nv * 1.5;
      vec3 rb = 0.5 + 0.5 * cos(6.2831853 * (fl + vec3(0.0, 0.33, 0.67)));
      col = mix(col, col * 0.8 + rb * (ambL + sunL * 0.25) * 0.08, slick * 0.6);
    }
  }

  // ---- sun / moon glints (HDR, bloom) + sparkles ----
  vec3 H = normalize(L + v);
  float nh = max(dot(n, H), 0.0);
  float night = NIGHT;
  // Specular anti-aliasing (Toksvig): wave detail finer than the pixel footprint is filtered out of the
  // normal, so its slope variance widens the lobes instead; a wider lobe is dimmer (energy conserving).
  // Far / grazing water turns into a soft sun path instead of aliased single-pixel glints that bloom +
  // DOF would blow up into discs; the HDR peak is capped for the same reason.
  // unresolved slope variance: capillary ripples (never rendered) + the faded fine layers + whatever the
  // mip-filtered noise loses at this footprint
  float sv = 0.004 + (1.0 - lodFine) * 0.006 * amp + (0.012 + 0.03 * amp) * smoothstep(0.02, 0.5, fp);
  float gT0 = mix(1800.0, 380.0, rough);
  float gT = gT0 / (1.0 + gT0 * sv);
  float gB0 = mix(140.0, 26.0, rough) * mix(1.0, 0.45, night);       // moon path is long and soft
  float gB = gB0 / (1.0 + gB0 * sv);
  float fresL = 0.3 + 0.7 * pow(1.0 - max(dot(H, v), 0.0), 5.0);
  float spec = (min(pow(nh, gT) * 7.0 * (gT + 2.0) / (gT0 + 2.0), 2.0) + pow(nh, gB) * (mix(0.4, 1.6, night) * (gB + 2.0) / (gB0 + 2.0))) * fresL;
  // sparkles: sparse twinkling cells, only inside the glitter path around the glint
  vec2 sc = floor(p * 10.0);
  float hs = hash12(sc + floor(TIME * 0.5) * 7.0);
  float tw = sin(TIME * (4.0 + 9.0 * hs) + hs * 40.0);
  spec += smoothstep(0.96, 1.0, tw) * step(0.8, hs) * pow(nh, gB * 1.6 + 40.0) * 22.0 * lodFine * (1.0 - night * 0.75) * (1.0 - smoothstep(0.05, 0.15, fp));
  col += uSunColor.rgb * (uSunDir.w * spec * sh * smoothstep(-0.02, 0.1, L.y) * (1.0 - poll * 0.6));

  // ---- foam ----
  float fsp = length(flow);
  float surf = (1.0 - smoothstep(0.05, 0.3, fsp)) * (1.0 - lake * 0.75);   // no surf on rivers, little on lakes
  float fn1 = tnoise(p * 0.8 + vec2(TIME * 0.02, -TIME * 0.013)).g;
  // breaking band hugging the shore; it breathes with the swell
  float breathe = sin(TIME * 1.1 + fn1 * 7.0 + p.x * 0.35 + p.y * 0.23);
  float bw = (0.24 + 0.24 * fn1 + 0.08 * breathe) * mix(0.55, 1.0, surf);
  // (off the map the only "shore" is the map-edge cliff: no dead-straight surf stripe along the border)
  float offShore = 1.0 - 0.85 * smoothstep(0.0, 0.08, outD);
  float band = (1.0 - smoothstep(bw * 0.12, bw, sd)) * offShore;
  // incoming wave lines: travel shoreward, thin out and die before they reach the band
  float wave = sd * 1.25 + TIME * 0.28 + fn1 * 1.7;
  float lines = smoothstep(0.72, 0.97, sin(wave * 6.2831853)) * smoothstep(1.9, 0.6, sd) * smoothstep(bw * 0.9, bw * 1.6, sd) * 0.8 * surf * offShore;
  float fm = max(band, lines);
#ifdef REFRACT
  fm = max(fm, (1.0 - smoothstep(0.01, 0.06, vdepC)) * 0.7);     // contact foam: piers, boats, walls
#endif
  if (storm > 0.01) {
    // whitecaps: lacy caps on the crests, streaked across the wind, drifting downwind
    vec2 wq = vec2(dot(p, uWind.xy), dot(p, vec2(-uWind.y, uWind.x)));
    float wc = tnoise(wq * vec2(0.35, 1.1) - vec2(TIME * 0.09, 0.0)).g + tnoise(wq * vec2(0.9, 2.6) - vec2(TIME * 0.16, 0.3)).b * 0.5;
    fm = max(fm, smoothstep(1.05, 1.35, wc + crest * 0.12) * storm * open * 0.75);
  }
  if (fsp > 0.05) {
    vec2 fdir = flow / fsp;
    vec2 fq = vec2(dot(p, fdir), dot(p, vec2(-fdir.y, fdir.x)));
    float st = tnoise(vec2(fq.x * 0.25 - TIME * 0.35 * fsp, fq.y * 1.6)).r;
    fm = max(fm, smoothstep(0.66, 0.86, st) * fsp * 0.45);
  }
  fm *= uWt.x * lodSwell;
  // bubbly break-up: coverage fm thresholds a foam texture (full inside, lacy toward the edges)
  float ft = tnoise(p * 2.3 + flow * TIME * 0.6 - vec2(0.0, TIME * 0.015)).b * 0.65 + tnoise(p * 5.3 + TIME * 0.02).r * 0.35;
  float foam = smoothstep(0.34, 0.5, fm * (0.45 + ft));
  vec3 foamAlb = mix(vec3(0.93, 0.96, 0.98), vec3(0.62, 0.58, 0.4), poll);
  vec3 foamCol = foamAlb * (ambL * 1.05 + sunL * (0.9 * sh + 0.1)) + vec3(0.8, 0.85, 1.0) * uMisc.z;
  // warm-season nights: the breaking surf glows with bioluminescent plankton
  float warm = 1.0 - smoothstep(0.35, 0.85, abs(uMisc.y - 1.1));
  foamCol += vec3(0.05, 0.55, 1.0) * (NIGHT * warm * (0.35 + 0.65 * ft) * band * 0.9 * (1.0 - poll));
  col = mix(col, foamCol, foam * 0.92);

  // ---- winter ice: shallow shelves, shore rims and ponds freeze; moving water stays open ----
  float frz = uWt.y;
  float alphaIce = 0.0;
  if (frz > 0.005 && outD <= 0.0) {
    float bed = bedS;
    float en = (tnoise(p * 0.3 + 0.21).r - 0.5) * 0.8;
    float shoreW = frz * mix(1.1, 7.5, lake) - fsp * 1.5;
    float byShore = 1.0 - smoothstep(shoreW - 0.08, shoreW + 0.08, sd + en);
    float byDepth = (1.0 - smoothstep(frz * 0.5 - 0.04, frz * 0.5 + 0.04, bed + en * 0.25)) * (1.0 - smoothstep(0.1, 0.4, fsp));
    float ice = max(byShore, byDepth);
    // drifting floes just off the edge
    vec2 fc = floor(p * 1.7);
    float fh = hash12(fc);
    vec2 fo = fract(p * 1.7) - 0.5;
    float floe = step(0.55, fh) * (1.0 - smoothstep(0.26, 0.3, max(abs(fo.x), abs(fo.y)) + (fh - 0.5) * 0.2));
    float near = 1.0 - smoothstep(0.0, 0.9, sd + en - shoreW);
    ice = max(ice, floe * near * frz * step(ice, 0.5));
    if (ice > 0.001) {
      float cr = iceCracks(p * 1.2);
      float crk = (1.0 - smoothstep(0.0, 0.045, cr)) * (1.0 - smoothstep(0.08, 0.25, fp));
      float cr2 = (1.0 - smoothstep(0.0, 0.03, iceCracks(p * 3.1 + 4.1))) * (1.0 - smoothstep(0.03, 0.1, fp));
      float clear = tnoise(p * 0.45 + 0.4).g;
      vec3 alb = mix(vec3(0.3, 0.52, 0.72), vec3(0.62, 0.8, 0.92), smoothstep(0.35, 0.65, clear));
      float dust = smoothstep(0.66, 0.86, tnoise(p * 0.8 + 0.4).b + SNOW * 0.1) * 0.7;
      alb = mix(alb, vec3(0.93, 0.96, 0.99), dust);
      alb = mix(alb, vec3(0.93, 0.97, 1.0), crk * 0.6 + cr2 * 0.25);          // white fractures
      float rim = smoothstep(0.35, 0.95, ice) * (1.0 - smoothstep(0.95, 1.0, ice));
      alb = mix(alb, vec3(0.95, 0.98, 1.0), rim * 0.6);
      vec3 ic = shade(alb, vec3(0.0, 1.0, 0.0), vWp, 1.0);
      vec3 Ri = reflect(rd, normalize(vec3(n.x * 0.05, 1.0, n.z * 0.05)));
      ic += skyReflect(Ri, 0.3) * (0.2 * (1.0 - dust));
      float hi = pow(max(dot(normalize(L + v), vec3(0.0, 1.0, 0.0)), 0.0), 220.0);
      ic += uSunColor.rgb * (uSunDir.w * hi * 3.0 * sh * (1.0 - dust));
      float a = smoothstep(0.35, 0.55, ice);
      col = mix(col, ic, a);
      alphaIce = a;
    }
  }

  // ---- build grid over water (derivative taken outside the per-pixel branch) ----
  vec2 gf = abs(fract(p) - 0.5);
  float gm = max(gf.x, gf.y);
  float gaa = fwidth(gm) * 1.2;
  if (uMisc.w > 0.001 && outD <= 0.0) {
    float gl = smoothstep(0.5 - 0.018 - gaa, 0.5 - 0.018, gm);
    col = mix(col, vec3(0.85, 0.95, 1.0) * (ambL + sunL * 0.5) * 1.2, gl * uMisc.w * 0.35);
  }

#ifdef HAS_OV
  // ---- data overlay: rivers / lakes / coast carry it like the land (the whole sea goes grey with the map) ----
  if (uMap.w > 0.0) {
    col = ovBase(col);
    if (outD <= 0.0) {
      float edgeIn = min(min(p.x, p.y), min(uMap.x - p.x, uMap.y - p.y));
      col = ovTint(col, p, vec3(0.0, 1.0, 0.0), 0.85 * smoothstep(0.0, 2.0, edgeIn) * (1.0 - foam * 0.5));
    }
  }
#endif

  col = applyFog(col, vWp);
  // dissolve into the sky's horizon before the far plane (the sky shows past it)
  float ff = smoothstep(uWt2.z * 0.5, uWt2.z * 0.93, dist);
  if (ff > 0.0) col = mix(col, skBase(rd), ff);
#ifdef REFRACT
  // alpha 0 marks water pixels in the HDR target (post can skip SSAO there; blending is off here)
  fragColor = vec4(col, 0.0);
#else
  float tA = dot(T, vec3(0.3, 0.4, 0.3));
  float a = clamp(1.0 - tA * 0.85, 0.0, 1.0);
  a = max(a, max(max(fres, foam * 0.92), alphaIce));
  a = max(a, ff);
  fragColor = vec4(col, a);
#endif
}`;

/* Diorama mode (ocean = false): translucent water-volume walls where water tiles meet the map edge. */
const WALL_VS = `
uniform float uBottom;
out vec3 vWp;
void main(){
  int wi = gl_VertexID / 6, ci = gl_VertexID % 6;
  vec2 q = ci == 0 ? vec2(0.0) : ci == 1 ? vec2(1.0, 0.0) : ci == 2 || ci == 4 ? vec2(1.0) : ci == 3 ? vec2(0.0) : vec2(0.0, 1.0);
  vec2 W = uMap.xy;
  vec2 a = wi == 0 ? vec2(0.0) : wi == 1 ? vec2(W.x, 0.0) : wi == 2 ? W : vec2(0.0, W.y);
  vec2 b = wi == 0 ? vec2(W.x, 0.0) : wi == 1 ? W : wi == 2 ? vec2(0.0, W.y) : vec2(0.0);
  vec2 xz = mix(a, b, q.x);
  vWp = vec3(xz.x, mix(uBottom, SEA_Y, q.y), xz.y);
  gl_Position = uViewProj * vec4(vWp, 1.0);
}`;
const WALL_FS = `
in vec3 vWp; out vec4 fragColor;
void main(){
  vec2 p = clamp(vWp.xz, vec2(0.01), uMap.xy - 0.01);
  float lv = tileData(p).r * 255.0;
  if (lv >= ${C.SEA.toFixed(1)} - 0.5) discard;                 // land: the terrain skirt shows
  float depth = SEA_Y - vWp.y;
  if (vWp.y < lv * ${C.STEP.toFixed(4)}) discard;               // below the seabed: terrain skirt
  vec3 light = uSkyAmb.rgb + uSunColor.rgb * (uSunDir.w * max(uSunDir.y, 0.0) * 0.35);
  vec3 c = mix(vec3(0.06, 0.5, 0.56), vec3(0.01, 0.07, 0.15), smoothstep(0.0, 1.3, depth)) * light;
  // wavering light shafts from the surface
  float along = vWp.x + vWp.z;
  float shaft = tnoise(vec2(along * 0.35 + TIME * 0.03, depth * 0.15)).r;
  c += light * vec3(0.05, 0.25, 0.25) * smoothstep(0.55, 0.8, shaft) * exp(-depth * 1.5);
  // bright meniscus at the surface
  float top = 1.0 - smoothstep(0.0, 0.035, depth);
  c = mix(c, vec3(0.85, 0.95, 1.0) * light * 1.3, top);
  c = applyFog(c, vWp);
  fragColor = vec4(c, mix(0.84, 0.95, smoothstep(0.0, 1.0, depth)));
}`;

/* ------------------------------------------------------------------ */
/* Module                                                               */
/* ------------------------------------------------------------------ */
const F = { W: 0, H: 0 }; // water field state
const Wt = (VC.water = {
  name: 'water',
  order: 500,
  ocean: true,
  mode: 'auto',
  writeDepth: 'auto',
  freeze: 0,
  bodies: [],
  stats: { variant: '', fieldMs: 0, sdfMs: 0, bodyMs: 0, copy: false },
  progs: {},

  init() {
    Wt.caps = { copy: true };
    Wt.variant(chooseVariant()); // compile the likely variant up front
    VC.gfx.addLayer(Wt);
    VC.bus.on('dirty', (d) => onDirty(d));
    VC.bus.on('mapsUpdated', () => (F.pollDirty = true));
    // a quality change picks another variant: compile it right away (while the settings UI is open)
    VC.bus.on('settings', () => { try { Wt.variant(chooseVariant()); } catch (e) { /* logged by gfx */ } });
  },
  /** Compiles every water program now (loading screens / benchmarks). Returns the number cached. */
  warmup() {
    for (const n of ['basic', 'refract', 'ssr']) Wt.variant(n);
    if (!Wt.wallProg) Wt.wallProg = VC.gfx.program('water_wall', WALL_VS, WALL_FS);
    return Object.keys(Wt.progs).length + 1;
  },

  /** Returns (compiling on first use) the program for a variant: 'basic' | 'refract' | 'ssr'. */
  variant(name) {
    const steps = name === 'ssr' ? ((VC.settings && VC.settings.quality) === 'ultra' ? 18 : 12) : 0;
    const key = steps ? name + steps : name;
    if (Wt.progs[key]) return Wt.progs[key];
    let defs = '';
    if (name !== 'basic') defs += '#define REFRACT 1\n';
    if (steps) defs += '#define SSR 1\n#define SSR_STEPS ' + steps + '\n';
    const skyGlsl = (VC.sky && VC.sky.GLSL) || FALLBACK_SKY;
    // data overlay code shared with the terrain (same ramps, relevance and night floor)
    const ovGlsl = VC.terrain && VC.terrain.OVERLAY_GLSL ? '#define HAS_OV 1\n' + VC.terrain.OVERLAY_GLSL : '';
    const P = VC.gfx.program('water_' + key, VS, defs + skyGlsl + ovGlsl + FS);
    if (VC.sky && VC.sky.attach) VC.sky.attach(P);
    const gl = VC.gfx.gl;
    gl.useProgram(P.prog);
    if (P.u.uScene) gl.uniform1i(P.u.uScene, 0);
    if (P.u.uSceneDepth) gl.uniform1i(P.u.uSceneDepth, 1);
    if (P.u.uField) gl.uniform1i(P.u.uField, 2);
    if (P.u.uPoll) gl.uniform1i(P.u.uPoll, 3);
    if (P.u.uOvRel) gl.uniform1i(P.u.uOvRel, OV_UNIT);
    Wt.progs[key] = P;
    return P;
  },

  reset(S) {
    allocField(S);
    Wt.rebuild();
    F.pollDirty = true;
    Wt.freeze = iceTarget();
    F.snapIce = 3; // env is one frame stale at reset: snap the ice to the season for the first frames
  },

  /** Full recompute of the water field (SDF, bodies, flow) + upload. */
  rebuild() {
    const S = VC.state;
    if (!S || !F.tex) return;
    const t0 = performance.now();
    snapshot(S, 0, 0, S.W - 1, S.H - 1);
    buildSat();
    sdfRect(0, 0, F.W - 1, F.H - 1);
    const t1 = performance.now();
    analyzeBodies();
    writeBodyChannels(0, 0, F.W - 1, F.H - 1);
    uploadField();
    const t2 = performance.now();
    Wt.stats.sdfMs = +(t1 - t0).toFixed(2);
    Wt.stats.bodyMs = +(t2 - t1).toFixed(2);
    Wt.stats.fieldMs = +(t2 - t0).toFixed(2);
    F.pending = null;
  },

  update(dt, rdt) {
    const S = VC.state;
    if (!S || !F.tex) return;
    // debounced incremental field update after terrain edits
    if (F.pending) {
      F.pendingAge += rdt;
      if (F.pendingAge > 0.12 || F.pendingAge > 1.0) applyPending(S);
    }
    // (pollution uploads lazily from transparent(), only while water is actually in view)
    // idle warmup: the fallback 'basic' variant and the diorama walls compile ahead of need, one per frame
    const G = VC.gfx;
    if (!Wt._warm && G.frameCount > 150 && G.frameCount % 7 === 3) {
      if (!Wt.progs.basic) Wt.variant('basic');
      else if (!Wt.wallProg) Wt.wallProg = G.program('water_wall', WALL_VS, WALL_FS);
      else Wt._warm = true;
    }
    // ice grows slowly and thaws a little faster (snaps right after a reset / load)
    const target = iceTarget();
    if (F.snapIce > 0) { F.snapIce--; Wt.freeze = target; }
    const rate = target > Wt.freeze ? 0.12 : 0.2;
    Wt.freeze += (target - Wt.freeze) * (1 - Math.exp(-rate * rdt * (1 + (S.time.speed || 0))));
    if (Math.abs(target - Wt.freeze) < 0.002) Wt.freeze = target;
  },

  transparent(ctx) {
    const S = ctx.S;
    if (!S || !F.tex) return;
    const gl = ctx.gl, G = VC.gfx, cam = ctx.cam, env = ctx.env;
    // CPU visibility: no water in the view frustum -> no scene copy, no far-plane quad
    const rect = waterRect(ctx, S);
    Wt.stats.visible = !!rect;
    if (!rect) { Wt.stats.copy = false; Wt.stats.skipped = (Wt.stats.skipped || 0) + 1; return; }
    if (F.pollDirty) uploadPollution(S);
    const ov = VC.terrain && VC.terrain.overlayInfo ? VC.terrain.overlayInfo() : null;
    let name = chooseVariant();
    if (name !== 'basic' && !copyScene(gl, G, rect, name === 'ssr')) name = 'basic';
    const P = Wt.variant(name);
    Wt.stats.variant = name;
    P.use();
    if (VC.sky && VC.sky.ubo) gl.bindBufferBase(gl.UNIFORM_BUFFER, VC.sky.UBO_BINDING, VC.sky.ubo);
    const u = P.u;
    // only the screen area that can contain water is shaded
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
    if (ov && u.uOvCfg) {
      gl.activeTexture(gl.TEXTURE0 + OV_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, ov.tex);
      gl.uniform4fv(u.uOvCfg, ov.cfg);
    }
    // textures
    if (name !== 'basic') {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, F.copy.color);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, F.copy.depth);
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, F.glTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, F.glPoll);
    gl.activeTexture(gl.TEXTURE0);
    const far = cam.far || 1500;
    const wx = env.windStrength == null ? 0.5 : env.windStrength;
    const storm = M.smoothstep(0.45, 1.0, wx) * (0.35 + 0.65 * M.sat(env.cloud || 0));
    const causticsFallback = VC.terrain && (VC.terrain.hasCaustics || VC.terrain.SKIRT_Y != null) ? 0 : 1;
    gl.uniform4f(u.uWt, 1.0, Wt.freeze, causticsFallback, Wt.ocean ? 1 : 0);
    gl.uniform4f(u.uWt2, storm, M.sat(env.wet || 0) * (1 - Wt.freeze * 0.5), far, 1.35);
    gl.disable(gl.CULL_FACE);
    if (name !== 'basic') gl.disable(gl.BLEND);
    // HDR alpha 0 marks water pixels (refract variants write it directly; basic blends colour only)
    else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ZERO);
    gl.bindVertexArray(G.emptyVao);
    // Depth: with the surface in the depth buffer, particles / effects below it are hidden and DOF focuses on
    // the surface. A flat depth-written plane makes screen-space AO band into stripes toward the horizon,
    // so in 'auto' mode depth is written only while SSAO is off, or when post skips AO on the water marker
    // (VC.post.waterMask). Post effects otherwise see the seabed through the water.
    const wd = Wt.writeDepth;
    const aoOn = !!(VC.post && VC.post.feat && VC.post.feat.ssao);
    Wt.stats.depth = wd === true || ((wd == null || wd === 'auto') && (!aoOn || !!(VC.post && VC.post.waterMask)));
    gl.depthMask(Wt.stats.depth);
    try {
      if (Wt.ocean) {
        // camera-centered quad reaching the far plane
        const cx = cam.pos[0], cz = cam.pos[2], r = far * 1.02;
        quad(gl, u, cx - r, cz - r, cx + r, cz + r);
      } else {
        quad(gl, u, 0, 0, S.W, S.H);
        drawWalls(gl, G);
      }
    } finally {
      gl.disable(gl.SCISSOR_TEST);
    }
    gl.bindVertexArray(null);
    if (ov) {
      gl.activeTexture(gl.TEXTURE0 + OV_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    }
  },

  /** Re-creates every GL object after a WebGL context restore (programs, field textures, scene copy), then rebuilds. */
  restore() {
    Wt.progs = {};
    Wt.wallProg = null;
    F.copy = null;
    F.tex = null;
    F.glTex = F.glPoll = null;
    F.W = F.H = 0;
    F.copyFail = null;
    Wt.caps = { copy: true };
    Wt.variant(chooseVariant());
    if (VC.state) Wt.reset(VC.state);
  },

  /* ---------------- queries (CPU) ---------------- */
  /** Water depth (world units) at world (wx, wz); 0 on land; deep ocean off the map. */
  depthAt(wx, wz) {
    const S = VC.state;
    if (!S) return 0;
    const x = Math.floor(wx), z = Math.floor(wz);
    if (x < 0 || z < 0 || x >= S.W || z >= S.H) return 3;
    return Math.max(0, C.SEA_Y - S.height[z * S.W + x] * C.STEP);
  },
  /** Signed distance to the shore in tiles (+ in water, - on land), clamped to ±3. */
  shoreDist(wx, wz) {
    if (!F.tex) return 0;
    if (wx < 0 || wz < 0 || wx >= F.W || wz >= F.H) {
      const o = Math.hypot(Math.max(-wx, wx - F.W, 0), Math.max(-wz, wz - F.H, 0));
      return Math.max(0, sampleField(M.clamp(wx, 0, F.W - 1e-3), M.clamp(wz, 0, F.H - 1e-3), 0)) + o;
    }
    return sampleField(wx, wz, 0);
  },
  /** Ice cover 0..1 at world (wx, wz) (same rule as the shader, without the edge noise). */
  iceAt(wx, wz) {
    if (!F.tex || Wt.freeze < 0.005) return 0;
    if (wx < 0 || wz < 0 || wx >= F.W || wz >= F.H) return 0;
    const sd = sampleField(wx, wz, 0);
    if (sd <= 0) return 0;
    const lake = sampleField(wx, wz, 1);
    const speed = Math.min(1, Math.hypot(sampleField(wx, wz, 2), sampleField(wx, wz, 3)));
    const width = Wt.freeze * M.lerp(0.8, 7.5, lake) - speed * 1.2;
    return 1 - M.smoothstep(width - 0.12, width + 0.12, sd);
  },
  /** River flow at world (wx, wz): unit direction {x, z} and speed 0..1 (0 in still water). */
  flowAt(wx, wz) {
    if (!F.tex || wx < 0 || wz < 0 || wx >= F.W || wz >= F.H) return { x: 0, z: 0, speed: 0 };
    const fx = sampleField(wx, wz, 2), fz = sampleField(wx, wz, 3);
    const s = Math.hypot(fx, fz);
    return s > 1e-4 ? { x: fx / s, z: fz / s, speed: Math.min(1, s) } : { x: 0, z: 0, speed: 0 };
  },
});

/** One water quad over the world rect (skipped when empty). */
function quad(gl, u, x0, z0, x1, z1) {
  if (x1 - x0 < 1e-3 || z1 - z0 < 1e-3) return;
  gl.uniform4f(u.uRect, x0, z0, x1, z1);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/** Diorama walls (blended, no depth writes). */
function drawWalls(gl, G) {
  if (!Wt.wallProg) Wt.wallProg = G.program('water_wall', WALL_VS, WALL_FS);
  const P = Wt.wallProg;
  P.use();
  const sk = VC.terrain && VC.terrain.SKIRT_Y != null ? VC.terrain.SKIRT_Y : -1;
  gl.uniform1f(P.u.uBottom, sk);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);
  gl.disable(gl.CULL_FACE);
  gl.bindVertexArray(G.emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 24);
}

/** Minimal sky stand-ins (used only if the sky module is missing). */
const FALLBACK_SKY = `
vec3 skBase(vec3 d){ return skyColor(d); }
vec3 skyReflect(vec3 d, float rough){ return skyColor(d); }
`;

/* ------------------------------------------------------------------ */
/* Variant choice + scene copy                                          */
/* ------------------------------------------------------------------ */
function chooseVariant() {
  const ok = copyOk();
  if (Wt.mode === 'basic' || Wt.mode === 'refract' || Wt.mode === 'ssr') return ok ? Wt.mode : 'basic';
  if (!ok) return 'basic';
  const q = (VC.settings && VC.settings.quality) || 'high';
  return q === 'low' ? 'basic' : q === 'medium' ? 'refract' : 'ssr';
}
/** False while the scene copy failed at the current render size (retried after the next resize). */
function copyOk() {
  const f = F.copyFail, h = VC.gfx.hdr;
  if (f && h && (f.w !== h.w || f.h !== h.h)) F.copyFail = null;
  if (Wt.caps) Wt.caps.copy = !F.copyFail;
  return !F.copyFail;
}
function dropCopy(gl, reason) {
  const cp = F.copy, h = VC.gfx.hdr;
  if (cp) { gl.deleteFramebuffer(cp.fbo); gl.deleteTexture(cp.color); gl.deleteTexture(cp.depth); }
  F.copy = null;
  F.copyFail = { w: h ? h.w : 0, h: h ? h.h : 0 };
  if (Wt.caps) Wt.caps.copy = false;
  console.warn('[water] scene copy unavailable (' + reason + '), using basic water until the next resize');
}

/**
 * Copies the opaque scene (color + depth) so the water can sample it — only the screen rect that can hold
 * water (+ margin for refraction; up to the top edge for screen-space reflections). False if not possible.
 */
function copyScene(gl, G, rect, upward) {
  const hdr = G.hdr;
  if (!hdr || !hdr.fbo || !copyOk()) return false;
  if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== hdr.fbo) return false; // drawn into something else
  const w = hdr.w, h = hdr.h;
  let cp = F.copy;
  if (!cp || cp.w !== w || cp.h !== h || cp.float !== hdr.float) {
    if (cp) { gl.deleteFramebuffer(cp.fbo); gl.deleteTexture(cp.color); gl.deleteTexture(cp.depth); }
    F.copy = null;
    const color = G.texture({ w, h, internal: hdr.float ? gl.RGBA16F : gl.RGBA8, format: gl.RGBA, type: hdr.float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE });
    const depth = G.texture({ w, h, internal: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT, filter: gl.NEAREST });
    const fbo = G.framebuffer(color, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fbo);
    if (!fbo) {
      gl.deleteTexture(color);
      gl.deleteTexture(depth);
      dropCopy(gl, 'framebuffer incomplete');
      return false;
    }
    cp = F.copy = { fbo, color, depth, w, h, float: hdr.float, checked: false };
  }
  let x0 = 0, y0 = 0, x1 = w, y1 = h;
  if (rect) {
    const mx = upward ? Math.round(w * 0.12) : 0;
    x0 = Math.max(0, rect[0] - mx); x1 = Math.min(w, rect[2] + mx);
    y0 = rect[1]; y1 = upward ? h : rect[3];
  }
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, hdr.fbo);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, cp.fbo);
  gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fbo);
  if (!cp.checked) {
    // validate once per allocation (getError stalls, so never per frame)
    cp.checked = true;
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      dropCopy(gl, 'GL error ' + err);
      return false;
    }
  }
  Wt.stats.copy = true;
  Wt.stats.copyPx = (x1 - x0) * (y1 - y0);
  return true;
}

/* ------------------------------------------------------------------ */
/* Visibility: which part of the screen can show water                  */
/* ------------------------------------------------------------------ */
const _rect = [0, 0, 0, 0];
/** Clip-space x, y, w of world point (x, y, z) under column-major matrix m into out[0..2]. */
function clip(m, x, y, z, out) {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[3] * x + m[7] * y + m[11] * z + m[15];
}
const _c = [0, 0, 0];
/**
 * Screen rect [x0, y0, x1, y1] (render-target px, GL origin bottom-left) that can contain water this
 * frame, or null when no water is in view: in-map water cells (16x16 tiles, counted on the CPU) tested
 * against the camera frustum and projected; the open ocean is in view unless the frustum's footprint on
 * the sea plane lies inside the map rectangle.
 */
function waterRect(ctx, S) {
  const G = VC.gfx, cam = ctx.cam, pl = G.camFrustum, vp = cam.viewProj, rw = G.rw, rh = G.rh;
  const y = C.SEA_Y;
  let full = false, any = false, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  // open ocean: frustum corner rays against the sea plane
  if (Wt.ocean) {
    const inv = cam.invViewProj;
    let inside = !!inv;
    for (let k = 0; k < 4 && inside; k++) {
      const nx = k & 1 ? 1 : -1, ny = k & 2 ? 1 : -1;
      const a = unproject(inv, nx, ny, -1), ax = a[0], ay = a[1], az = a[2];
      const b = unproject(inv, nx, ny, 1);
      if (b[1] >= y) { inside = false; break; }                 // corner ray reaches the far plane above the sea
      const t = ay <= y ? 0 : (ay - y) / (ay - b[1]);
      const px = ax + (b[0] - ax) * t, pz = az + (b[2] - az) * t;
      if (px < 0 || pz < 0 || px > S.W || pz > S.H) inside = false;
    }
    if (!inside) { any = true; full = true; }
  }
  // in-map water cells
  if (!full && F.wcnt) {
    for (let cz = 0, k = 0; cz < F.cwh; cz++)
      for (let cx = 0; cx < F.cww; cx++, k++) {
        if (!F.wcnt[k]) continue;
        const bx0 = cx * WC, bz0 = cz * WC, bx1 = Math.min(S.W, bx0 + WC), bz1 = Math.min(S.H, bz0 + WC);
        const edge = !Wt.ocean && (bx0 === 0 || bz0 === 0 || bx1 === S.W || bz1 === S.H);
        const yb = edge ? (VC.terrain && VC.terrain.SKIRT_Y != null ? VC.terrain.SKIRT_Y : -1) : y - 0.02;
        if (!G.boxVisible(pl, bx0, yb, bz0, bx1, y + 0.02, bz1)) continue;
        any = true;
        for (let j = 0; j < 8 && !full; j++) {
          clip(vp, j & 1 ? bx1 : bx0, j & 4 ? yb : y, j & 2 ? bz1 : bz0, _c);
          if (_c[2] < 1e-3) { full = true; break; }
          const sx = (_c[0] / _c[2] * 0.5 + 0.5) * rw, sy = (_c[1] / _c[2] * 0.5 + 0.5) * rh;
          if (sx < x0) x0 = sx;
          if (sx > x1) x1 = sx;
          if (sy < y0) y0 = sy;
          if (sy > y1) y1 = sy;
          if (!edge && j === 3) break; // flat cell: 4 corners are enough
        }
        if (full) break;
      }
  }
  if (!any) return null;
  if (full) { _rect[0] = 0; _rect[1] = 0; _rect[2] = rw; _rect[3] = rh; return _rect; }
  // margin: refraction offsets + the shallow-water blur sample a little around the surface
  const m = Math.round(Math.max(rw, rh) * 0.05) + 4;
  _rect[0] = Math.max(0, Math.floor(x0) - m);
  _rect[1] = Math.max(0, Math.floor(y0) - m);
  _rect[2] = Math.min(rw, Math.ceil(x1) + m);
  _rect[3] = Math.min(rh, Math.ceil(y1) + m);
  if (_rect[2] <= _rect[0] || _rect[3] <= _rect[1]) return null;
  return _rect;
}
const _up = [0, 0, 0];
/** World point of NDC (x, y, z) through the inverse view-projection (reused array). */
function unproject(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  _up[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  _up[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  _up[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  return _up;
}

/* ------------------------------------------------------------------ */
/* Water field (CPU)                                                    */
/* ------------------------------------------------------------------ */
function allocField(S) {
  const gl = VC.gfx.gl, G = VC.gfx;
  const W = S.W, H = S.H, N = W * H;
  if (F.W !== W || F.H !== H || !F.tex) {
    F.W = W; F.H = H;
    F.fw = W * FR; F.fh = H * FR;
    F.wm = new Uint8Array(N);
    F.lake = new Float32Array(N);
    F.fx = new Float32Array(N);
    F.fz = new Float32Array(N);
    F.tmpx = new Float32Array(N);
    F.tmpz = new Float32Array(N);
    F.comp = new Int32Array(N);
    F.dist = new Int32Array(N);
    F.queue = new Int32Array(N);
    F.PW = W + 2 * RMAX + 1;
    F.sat = new Int32Array(F.PW * (H + 2 * RMAX + 1));
    F.tex = new Uint8Array(F.fw * F.fh * 4);
    F.poll = new Uint8Array(N);
    F.rfx = new Float32Array(N); // raw (unsmoothed) flow, kept for incremental re-smoothing
    F.rfz = new Float32Array(N);
    F.cww = Math.ceil(W / WC);
    F.cwh = Math.ceil(H / WC);
    F.wcnt = new Int32Array(F.cww * F.cwh); // water tiles per visibility cell
    if (F.glTex) gl.deleteTexture(F.glTex);
    if (F.glPoll) gl.deleteTexture(F.glPoll);
    F.glTex = G.texture({ w: F.fw, h: F.fh, filter: gl.LINEAR });
    F.glPoll = G.texture({ w: W, h: H, internal: gl.R8, format: gl.RED, filter: gl.LINEAR });
  }
  F.pending = null;
}

/** Copies the water mask for the rect; returns true if it changed (depths come from uTileTex). */
function snapshot(S, x0, z0, x1, z1) {
  let changed = false;
  const W = S.W, hg = S.height, SEA = C.SEA, wm = F.wm, cnt = F.wcnt, cww = F.cww;
  for (let z = z0; z <= z1; z++)
    for (let x = x0, i = z * W + x0; x <= x1; x++, i++) {
      const w = hg[i] < SEA ? 1 : 0;
      if (wm[i] !== w) {
        wm[i] = w;
        changed = true;
        cnt[((z / WC) | 0) * cww + ((x / WC) | 0)] += w ? 1 : -1;
      }
    }
  return changed;
}

/** Summed-area table of the water mask, padded by RMAX with water (the ocean beyond the map). */
function buildSat() {
  const W = F.W, H = F.H, P = RMAX, PW = F.PW, sat = F.sat, wm = F.wm;
  const PH = H + 2 * P;
  for (let x = 0; x < PW; x++) sat[x] = 0;
  for (let z = 1; z <= PH; z++) {
    let row = 0;
    const tz = z - 1 - P;
    sat[z * PW] = 0;
    for (let x = 1; x < PW; x++) {
      const tx = x - 1 - P;
      row += tx < 0 || tz < 0 || tx >= W || tz >= H ? 1 : wm[tz * W + tx];
      sat[z * PW + x] = sat[(z - 1) * PW + x] + row;
    }
  }
}

/** Signed distance to the shore for all field texels of the inclusive tile rect. */
function sdfRect(x0, z0, x1, z1) {
  const W = F.W, H = F.H, P = RMAX, PW = F.PW, sat = F.sat, wm = F.wm, tex = F.tex, fw = F.fw;
  const area = (2 * RMAX + 1) * (2 * RMAX + 1);
  const R2 = RMAX * RMAX;
  const scale = 255 / (2 * RMAX);
  const best = [0, 0, 0, 0];
  for (let tz = z0; tz <= z1; tz++)
    for (let tx = x0; tx <= x1; tx++) {
      const self = wm[tz * W + tx];
      const ax = tx + P - RMAX, az = tz + P - RMAX, bx = tx + P + RMAX + 1, bz = tz + P + RMAX + 1;
      const cnt = sat[bz * PW + bx] - sat[az * PW + bx] - sat[bz * PW + ax] + sat[az * PW + ax];
      const uniform = self ? cnt === area : cnt === 0;
      best[0] = best[1] = best[2] = best[3] = R2;
      if (!uniform) {
        // exact distance from each sub-texel center to the nearest tile square of the other kind, searched
        // ring by ring; a ring r+1 tile is at least r + 0.25 away from every sub-texel, so stop early
        const p0 = tx + 0.5 / FR, p1 = tx + 1.5 / FR, q0 = tz + 0.5 / FR, q1 = tz + 1.5 / FR;
        for (let r = 1; r <= RMAX; r++) {
          for (let dz = -r; dz <= r; dz++) {
            const z = tz + dz, edgeRow = dz === -r || dz === r, step = edgeRow ? 1 : 2 * r;
            for (let dx = -r; dx <= r; dx += step) {
              const x = tx + dx;
              const other = x < 0 || z < 0 || x >= W || z >= H ? 1 : wm[z * W + x];
              if (other === self) continue;
              const ax0 = x > p0 ? x - p0 : p0 > x + 1 ? p0 - x - 1 : 0;
              const ax1 = x > p1 ? x - p1 : p1 > x + 1 ? p1 - x - 1 : 0;
              const az0 = z > q0 ? z - q0 : q0 > z + 1 ? q0 - z - 1 : 0;
              const az1 = z > q1 ? z - q1 : q1 > z + 1 ? q1 - z - 1 : 0;
              let d = ax0 * ax0 + az0 * az0; if (d < best[0]) best[0] = d;
              d = ax1 * ax1 + az0 * az0; if (d < best[1]) best[1] = d;
              d = ax0 * ax0 + az1 * az1; if (d < best[2]) best[2] = d;
              d = ax1 * ax1 + az1 * az1; if (d < best[3]) best[3] = d;
            }
          }
          const lim = (r + 0.25) * (r + 0.25);
          if (best[0] <= lim && best[1] <= lim && best[2] <= lim && best[3] <= lim) break;
        }
      }
      for (let s = 0; s < 4; s++) {
        const d = Math.sqrt(best[s]) * (self ? 1 : -1);
        const i = ((tz * FR + (s >> 1)) * fw + tx * FR + (s & 1)) * 4;
        tex[i] = M.clamp(Math.round(127.5 + d * scale), 0, 255);
      }
    }
}

/**
 * Water bodies (4-connected): size, touches-the-edge (sea), lake class; river flow: BFS distance from the
 * body's mouth (its longest map-edge side) -> downhill direction, speed from the local channel width.
 * Full analysis on reset; terrain edits re-analyse only the bodies that touch the edited rect (see relabel()).
 * F.comp holds indices into F.bodies (dead entries stay until the next full analysis).
 */
function analyzeBodies() {
  const t0 = performance.now();
  const W = F.W, H = F.H, N = W * H, wm = F.wm, comp = F.comp;
  comp.fill(-1);
  F.dist.fill(-1);
  F.bodies = [];
  const made = [];
  for (let s = 0; s < N; s++) if (wm[s] && comp[s] < 0) made.push(floodBody(s));
  const tA = performance.now();
  bodyDist(made);
  const tB = performance.now();
  flowRect(0, 0, W - 1, H - 1);
  const tC = performance.now();
  smoothRect(0, 0, W - 1, H - 1);
  lakeRect(0, 0, W - 1, H - 1);
  publishBodies();
  const tD = performance.now();
  Wt.stats.prof = { comps: +(tA - t0).toFixed(2), bfs: +(tB - tA).toFixed(2), flow: +(tC - tB).toFixed(2), smooth: +(tD - tC).toFixed(2) };
}

/** Labels the water component containing tile s (every tile of it gets the new id); absorbs other ids it meets. */
function floodBody(s) {
  const W = F.W, H = F.H, wm = F.wm, comp = F.comp, q = F.queue, bodies = F.bodies;
  const id = bodies.length;
  const b = { id, size: 0, sea: false, lake: 0, sides: [0, 0, 0, 0], x0: W, z0: H, x1: -1, z1: -1, dead: false };
  bodies.push(b);
  const absorb = (j) => { const o = comp[j]; if (o >= 0 && o !== id && !bodies[o].dead) bodies[o].dead = true; comp[j] = id; q[qt++] = j; };
  let qh = 0, qt = 0;
  absorb(s);
  while (qh < qt) {
    const i = q[qh++];
    const x = i % W, z = (i / W) | 0;
    b.size++;
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (z < b.z0) b.z0 = z;
    if (z > b.z1) b.z1 = z;
    if (x === 0) b.sides[0]++;
    if (x === W - 1) b.sides[1]++;
    if (z === 0) b.sides[2]++;
    if (z === H - 1) b.sides[3]++;
    if (x > 0 && wm[i - 1] && comp[i - 1] !== id) absorb(i - 1);
    if (x < W - 1 && wm[i + 1] && comp[i + 1] !== id) absorb(i + 1);
    if (z > 0 && wm[i - W] && comp[i - W] !== id) absorb(i - W);
    if (z < H - 1 && wm[i + W] && comp[i + W] !== id) absorb(i + W);
  }
  b.sea = b.sides[0] + b.sides[1] + b.sides[2] + b.sides[3] > 0;
  b.lake = b.sea ? 0 : b.size <= POND ? 1 : 0.5;
  return b;
}

/** BFS distance from the mouth side (longest map-edge side) of each sea-connected body in the list. */
function bodyDist(list) {
  const W = F.W, H = F.H, wm = F.wm, comp = F.comp, q = F.queue, dist = F.dist;
  let qh = 0, qt = 0;
  for (const b of list) {
    if (b.dead || !b.sea || b.size < 6) continue;
    let side = 0;
    for (let k = 1; k < 4; k++) if (b.sides[k] > b.sides[side]) side = k;
    if (side < 2) {
      const x = side === 0 ? 0 : W - 1;
      for (let z = b.z0; z <= b.z1; z++) { const i = z * W + x; if (comp[i] === b.id) { dist[i] = 0; q[qt++] = i; } }
    } else {
      const z = side === 2 ? 0 : H - 1;
      for (let x = b.x0; x <= b.x1; x++) { const i = z * W + x; if (comp[i] === b.id) { dist[i] = 0; q[qt++] = i; } }
    }
  }
  while (qh < qt) {
    const i = q[qh++], d = dist[i] + 1;
    const x = i % W, z = (i / W) | 0;
    if (x > 0 && wm[i - 1] && dist[i - 1] < 0) { dist[i - 1] = d; q[qt++] = i - 1; }
    if (x < W - 1 && wm[i + 1] && dist[i + 1] < 0) { dist[i + 1] = d; q[qt++] = i + 1; }
    if (z > 0 && wm[i - W] && dist[i - W] < 0) { dist[i - W] = d; q[qt++] = i - W; }
    if (z < H - 1 && wm[i + W] && dist[i + W] < 0) { dist[i + W] = d; q[qt++] = i + W; }
  }
}

/**
 * Raw flow for the inclusive tile rect: downhill direction of the BFS distance, speed from the channel
 * half-width (~ the largest shore distance within +-2 tiles, separable max filter, off-map = open).
 */
function flowRect(x0, z0, x1, z1) {
  const W = F.W, H = F.H, dist = F.dist, tex = F.tex, fw = F.fw, hr = F.tmpx, rfx = F.rfx, rfz = F.rfz;
  const sdScale = (2 * RMAX) / 255;
  const za = Math.max(0, z0 - 2), zb = Math.min(H - 1, z1 + 2);
  for (let z = za; z <= zb; z++)
    for (let x = x0; x <= x1; x++) {
      let m = x < 2 || x >= W - 2 ? RMAX : -RMAX;
      for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        const v = (tex[(z * FR * fw + xx * FR) * 4] - 127.5) * sdScale;
        if (v > m) m = v;
      }
      hr[z * W + x] = m;
    }
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const i = z * W + x;
      rfx[i] = rfz[i] = 0;
      if (dist[i] < 0) continue;
      let hw = z < 2 || z >= H - 2 ? RMAX : -RMAX;
      for (let dz = -2; dz <= 2; dz++) {
        const zz = z + dz;
        if (zz >= 0 && zz < H && hr[zz * W + x] > hw) hw = hr[zz * W + x];
      }
      const c = dist[i];
      const l = x > 0 && dist[i - 1] >= 0 ? dist[i - 1] : c, r = x < W - 1 && dist[i + 1] >= 0 ? dist[i + 1] : c;
      const u = z > 0 && dist[i - W] >= 0 ? dist[i - W] : c, dn = z < H - 1 && dist[i + W] >= 0 ? dist[i + W] : c;
      const gx = l - r, gz = u - dn;
      const gl = Math.hypot(gx, gz);
      if (gl < 1e-6) continue;
      const speed = M.smoothstep(2.9, 1.1, hw);
      rfx[i] = (gx / gl) * speed;
      rfz[i] = (gz / gl) * speed;
    }
}

/**
 * Smoothed flow for the inclusive rect: two 3x3 box passes over water tiles (land takes the water average
 * for clean bilinear edges). Reads the raw flow of the rect + 2 tiles.
 */
function smoothRect(x0, z0, x1, z1) {
  const W = F.W, H = F.H, wm = F.wm, rfx = F.rfx, rfz = F.rfz, ax = F.tmpx, az = F.tmpz, fx = F.fx, fz = F.fz;
  const box = (sx, sz, ox, oz, a0, b0, a1, b1) => {
    for (let z = b0; z <= b1; z++)
      for (let x = a0; x <= a1; x++) {
        let tx = 0, tz = 0, n = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const zz = z + dz;
          if (zz < 0 || zz >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            const j = zz * W + xx;
            if (!wm[j]) continue;
            tx += sx[j]; tz += sz[j]; n++;
          }
        }
        const i = z * W + x;
        ox[i] = n ? tx / n : 0;
        oz[i] = n ? tz / n : 0;
      }
  };
  box(rfx, rfz, ax, az, Math.max(0, x0 - 1), Math.max(0, z0 - 1), Math.min(W - 1, x1 + 1), Math.min(H - 1, z1 + 1));
  box(ax, az, fx, fz, x0, z0, x1, z1);
}

/** Lake class per tile for the inclusive rect; land next to water inherits it (clean bilinear shore edges). */
function lakeRect(x0, z0, x1, z1) {
  const W = F.W, H = F.H, wm = F.wm, comp = F.comp, lk = F.lake, bodies = F.bodies;
  for (let z = z0; z <= z1; z++)
    for (let x = x0, i = z * W + x0; x <= x1; x++, i++) lk[i] = comp[i] >= 0 ? bodies[comp[i]].lake : 0;
  for (let z = z0; z <= z1; z++)
    for (let x = x0, i = z * W + x0; x <= x1; x++, i++) {
      if (wm[i]) continue;
      let m = 0;
      if (x > 0 && wm[i - 1]) m = Math.max(m, bodies[comp[i - 1]].lake);
      if (x < W - 1 && wm[i + 1]) m = Math.max(m, bodies[comp[i + 1]].lake);
      if (z > 0 && wm[i - W]) m = Math.max(m, bodies[comp[i - W]].lake);
      if (z < H - 1 && wm[i + W]) m = Math.max(m, bodies[comp[i + W]].lake);
      lk[i] = m;
    }
}

function publishBodies() {
  const out = [];
  for (const b of F.bodies) if (!b.dead) out.push({ id: b.id, size: b.size, sea: b.sea, lake: b.lake });
  Wt.bodies = out;
}

/**
 * Incremental re-analysis after the water mask changed inside rect p (already snapshotted; F.comp still
 * holds the old labels): the bodies touching the rect are dissolved and re-flooded (absorbing any body a
 * new channel connects to), then distance / flow / smoothing / lake classes are recomputed only over the
 * union box of the old and new bodies. Returns that box {x0, z0, x1, z1} (inclusive).
 */
function relabel(p) {
  const W = F.W, H = F.H, wm = F.wm, comp = F.comp, dist = F.dist, bodies = F.bodies;
  const rx0 = Math.max(0, p.x0 - 1), rz0 = Math.max(0, p.z0 - 1), rx1 = Math.min(W - 1, p.x1 + 1), rz1 = Math.min(H - 1, p.z1 + 1);
  const U = { x0: rx0, z0: rz0, x1: rx1, z1: rz1 };
  const grow = (b) => { U.x0 = Math.min(U.x0, b.x0); U.z0 = Math.min(U.z0, b.z0); U.x1 = Math.max(U.x1, b.x1); U.z1 = Math.max(U.z1, b.z1); };
  // 1. dissolve the old bodies that touch the rect (+1)
  const old = [];
  for (let z = rz0; z <= rz1; z++)
    for (let i = z * W + rx0, e = z * W + rx1; i <= e; i++) {
      const c = comp[i];
      if (c >= 0 && !bodies[c].dead) { bodies[c].dead = true; old.push(bodies[c]); grow(bodies[c]); }
    }
  for (const b of old)
    for (let z = b.z0; z <= b.z1; z++)
      for (let i = z * W + b.x0, e = z * W + b.x1; i <= e; i++) if (comp[i] === b.id) { comp[i] = -1; dist[i] = -1; }
  for (let z = rz0; z <= rz1; z++) for (let i = z * W + rx0, e = z * W + rx1; i <= e; i++) if (!wm[i]) { comp[i] = -1; dist[i] = -1; }
  // 2. re-flood from every unlabeled water tile of the dissolved area (new channels may absorb other bodies)
  const made = [];
  const seed = (x0, z0, x1, z1) => {
    for (let z = z0; z <= z1; z++)
      for (let i = z * W + x0, e = z * W + x1; i <= e; i++)
        if (wm[i] && comp[i] < 0) made.push(floodBody(i));
  };
  seed(rx0, rz0, rx1, rz1);
  for (const b of old) seed(b.x0, b.z0, b.x1, b.z1);
  for (const b of made) grow(b);
  // bodies absorbed by a new one were dead-marked in floodBody: their tiles now carry the new id; clear their
  // distances too (the union box covers them since the absorbing body's box contains all of their tiles)
  for (const b of made)
    for (let z = b.z0; z <= b.z1; z++)
      for (let i = z * W + b.x0, e = z * W + b.x1; i <= e; i++) if (comp[i] === b.id) dist[i] = -1;
  // 3. distance field of the new bodies, then flow / smoothing / lakes over the union box
  bodyDist(made);
  flowRect(U.x0, U.z0, U.x1, U.z1);
  const s0x = Math.max(0, U.x0 - 2), s0z = Math.max(0, U.z0 - 2), s1x = Math.min(W - 1, U.x1 + 2), s1z = Math.min(H - 1, U.z1 + 2);
  smoothRect(s0x, s0z, s1x, s1z);
  lakeRect(Math.max(0, U.x0 - 1), Math.max(0, U.z0 - 1), Math.min(W - 1, U.x1 + 1), Math.min(H - 1, U.z1 + 1));
  publishBodies();
  U.x0 = s0x; U.z0 = s0z; U.x1 = s1x; U.z1 = s1z;
  return U;
}

/** Writes lake + flow channels for the rect. */
function writeBodyChannels(x0, z0, x1, z1) {
  const W = F.W, tex = F.tex, fw = F.fw;
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const i = z * W + x;
      const g = Math.round(F.lake[i] * 255);
      const b = M.clamp(Math.round(127.5 + F.fx[i] * 127.5), 0, 255);
      const a = M.clamp(Math.round(127.5 + F.fz[i] * 127.5), 0, 255);
      for (let s = 0; s < 4; s++) {
        const k = ((z * FR + (s >> 1)) * fw + x * FR + (s & 1)) * 4;
        tex[k + 1] = g;
        tex[k + 2] = b;
        tex[k + 3] = a;
      }
    }
}

/** Uploads the field texels of the inclusive tile rect (whole field when called without arguments). */
function uploadField(x0 = 0, z0 = 0, x1 = F.W - 1, z1 = F.H - 1) {
  const gl = VC.gfx.gl;
  gl.bindTexture(gl.TEXTURE_2D, F.glTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const full = x0 === 0 && z0 === 0 && x1 === F.W - 1 && z1 === F.H - 1;
  if (full) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, F.fw, F.fh, gl.RGBA, gl.UNSIGNED_BYTE, F.tex);
  else {
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, F.fw);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0 * FR);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, z0 * FR);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0 * FR, z0 * FR, (x1 - x0 + 1) * FR, (z1 - z0 + 1) * FR, gl.RGBA, gl.UNSIGNED_BYTE, F.tex);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  }
}

function uploadPollution(S) {
  F.pollDirty = false;
  const src = S.maps && S.maps.pollution;
  const d = F.poll;
  if (src && src.length === d.length) {
    // water carries pollution only where it is (dampened: faint smog should not tint the sea)
    for (let i = 0; i < d.length; i++) {
      const v = src[i];
      d[i] = v < 40 ? 0 : Math.min(255, (v - 40) * 1.5);
    }
  } else d.fill(0);
  const gl = VC.gfx.gl;
  gl.bindTexture(gl.TEXTURE_2D, F.glPoll);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, F.W, F.H, gl.RED, gl.UNSIGNED_BYTE, d);
}

/** Terrain edits: remember the rect if water tiles actually changed (roads/zones/buildings don't matter). */
function onDirty(d) {
  const S = VC.state;
  if (!S || !F.tex || S.W !== F.W || S.H !== F.H) return;
  const x0 = M.clamp(d.x0, 0, S.W - 1), z0 = M.clamp(d.z0, 0, S.H - 1), x1 = M.clamp(d.x1, 0, S.W - 1), z1 = M.clamp(d.z1, 0, S.H - 1);
  let changed = false;
  const W = S.W, SEA = C.SEA, hg = S.height;
  for (let z = z0; z <= z1 && !changed; z++)
    for (let i = z * W + x0, e = z * W + x1; i <= e; i++) {
      if (F.wm[i] !== (hg[i] < SEA ? 1 : 0)) { changed = true; break; }
    }
  if (!changed) return; // roads, zones, buildings or depth-only edits don't touch the field
  const p = F.pending;
  if (p) { p.x0 = Math.min(p.x0, x0); p.z0 = Math.min(p.z0, z0); p.x1 = Math.max(p.x1, x1); p.z1 = Math.max(p.z1, z1); }
  else F.pending = { x0, z0, x1, z1 };
  F.pendingAge = 0;
}

/**
 * Debounced terrain-edit update: water mask + SDF for the rect (+RMAX), then only the water bodies that
 * touch it are re-analysed (relabel), and only the changed box of the field texture is rewritten + uploaded.
 */
function applyPending(S) {
  const p = F.pending;
  F.pending = null;
  const t0 = performance.now();
  if (!snapshot(S, p.x0, p.z0, p.x1, p.z1)) return; // edited back before the debounce ran out
  buildSat();
  const x0 = Math.max(0, p.x0 - RMAX), z0 = Math.max(0, p.z0 - RMAX), x1 = Math.min(F.W - 1, p.x1 + RMAX), z1 = Math.min(F.H - 1, p.z1 + RMAX);
  sdfRect(x0, z0, x1, z1);
  const t1 = performance.now();
  let U;
  if (!F.bodies || F.bodies.length > 256 + 2 * Wt.bodies.length) {
    analyzeBodies(); // (compacts the dead body entries now and then)
    U = { x0: 0, z0: 0, x1: F.W - 1, z1: F.H - 1 };
  } else U = relabel(p);
  writeBodyChannels(U.x0, U.z0, U.x1, U.z1);
  uploadField(Math.min(U.x0, x0), Math.min(U.z0, z0), Math.max(U.x1, x1), Math.max(U.z1, z1));
  const t2 = performance.now();
  Wt.stats.sdfMs = +(t1 - t0).toFixed(2);
  Wt.stats.bodyMs = +(t2 - t1).toFixed(2);
  Wt.stats.fieldMs = +(t2 - t0).toFixed(2);
  Wt.stats.fieldRect = [U.x0, U.z0, U.x1, U.z1];
}

/** Bilinear sample of field channel c (0 sd in tiles, 1 lake, 2/3 flow) at world (wx, wz). */
function sampleField(wx, wz, c) {
  const fx = wx * FR - 0.5, fz = wz * FR - 0.5;
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  const x0 = M.clamp(ix, 0, F.fw - 1), x1 = M.clamp(ix + 1, 0, F.fw - 1);
  const r0 = M.clamp(iz, 0, F.fh - 1) * F.fw, r1 = M.clamp(iz + 1, 0, F.fh - 1) * F.fw;
  const t = F.tex;
  const a = t[(r0 + x0) * 4 + c], b = t[(r0 + x1) * 4 + c], d = t[(r1 + x0) * 4 + c], e = t[(r1 + x1) * 4 + c];
  const v = M.lerp(M.lerp(a, b, tx), M.lerp(d, e, tx), tz);
  if (c === 0) return (v - 127.5) / (255 / (2 * RMAX));
  if (c === 1) return v / 255;
  return (v - 127.5) / 127.5;
}

/** Freeze target from the season's snow cover. */
function iceTarget() {
  const env = VC.gfx.env;
  const snow = env ? env.snow || 0 : 0;
  return M.smoothstep(0.35, 0.95, snow);
}
