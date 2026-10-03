/**
 * GLSL for post-processing: dual-filter mip-chain bloom (Jimenez 2014, "Next Generation Post
 * Processing in Call of Duty: Advanced Warfare") and the final composite.
 * Helper names are prefixed `pp_` so they can't collide with functions in WORMHOLE_GLSL.
 */
import { COMMON_GLSL } from '../shaders/common';

/**
 * 13-tap downsample. With FIRST defined: adds a second source of the same size (uSrc2: the sprite
 * layer kept out of the TAA history; black when unused), NaN/Inf scrub, firefly clamp, Karis
 * average, soft-knee threshold.
 */
export const BLOOM_DOWN_FRAG = /* glsl */ `
uniform sampler2D uSrc;
#ifdef FIRST
uniform sampler2D uSrc2;
#endif
uniform vec2 uSrcTexel;
uniform vec3 uThreshold; // x: threshold, y: knee, z: input clamp
in vec2 vUv;

float pp_luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 pp_fetch(vec2 uv) {
  vec3 c = texture(uSrc, uv).rgb;
#ifdef FIRST
  c += texture(uSrc2, uv).rgb;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  c = clamp(c, vec3(0.0), vec3(uThreshold.z));
#endif
  return c;
}

void main() {
  vec2 t = uSrcTexel;
  vec3 a = pp_fetch(vUv + t * vec2(-2.0, 2.0));
  vec3 b = pp_fetch(vUv + t * vec2(0.0, 2.0));
  vec3 c = pp_fetch(vUv + t * vec2(2.0, 2.0));
  vec3 d = pp_fetch(vUv + t * vec2(-2.0, 0.0));
  vec3 e = pp_fetch(vUv);
  vec3 f = pp_fetch(vUv + t * vec2(2.0, 0.0));
  vec3 g = pp_fetch(vUv + t * vec2(-2.0, -2.0));
  vec3 h = pp_fetch(vUv + t * vec2(0.0, -2.0));
  vec3 i = pp_fetch(vUv + t * vec2(2.0, -2.0));
  vec3 j = pp_fetch(vUv + t * vec2(-1.0, 1.0));
  vec3 k = pp_fetch(vUv + t * vec2(1.0, 1.0));
  vec3 l = pp_fetch(vUv + t * vec2(-1.0, -1.0));
  vec3 m = pp_fetch(vUv + t * vec2(1.0, -1.0));

  vec3 g0 = (j + k + l + m) * 0.25;
  vec3 g1 = (a + b + d + e) * 0.25;
  vec3 g2 = (b + c + e + f) * 0.25;
  vec3 g3 = (d + e + g + h) * 0.25;
  vec3 g4 = (e + f + h + i) * 0.25;
#ifdef FIRST
  // Karis average: weight each 2x2 group by 1/(1+luma) → no firefly flicker.
  float w0 = 0.5 / (1.0 + pp_luma(g0));
  float w1 = 0.125 / (1.0 + pp_luma(g1));
  float w2 = 0.125 / (1.0 + pp_luma(g2));
  float w3 = 0.125 / (1.0 + pp_luma(g3));
  float w4 = 0.125 / (1.0 + pp_luma(g4));
  vec3 col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  // Soft-knee threshold.
  float br = max(col.r, max(col.g, col.b));
  float knee = max(uThreshold.y, 1e-4);
  float rq = clamp(br - uThreshold.x + knee, 0.0, 2.0 * knee);
  rq = rq * rq / (4.0 * knee);
  col *= max(rq, br - uThreshold.x) / max(br, 1e-5);
#else
  vec3 col = g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
#endif
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

/** 3x3 tent upsample, additively blended onto the next larger mip. */
export const BLOOM_UP_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform float uRadius;
uniform float uWeight;
in vec2 vUv;
void main() {
  vec2 t = uSrcTexel * uRadius;
  vec3 s = texture(uSrc, vUv).rgb * 4.0;
  s += (texture(uSrc, vUv + vec2(-t.x, 0.0)).rgb + texture(uSrc, vUv + vec2(t.x, 0.0)).rgb
      + texture(uSrc, vUv + vec2(0.0, -t.y)).rgb + texture(uSrc, vUv + vec2(0.0, t.y)).rgb) * 2.0;
  s += texture(uSrc, vUv + vec2(-t.x, -t.y)).rgb + texture(uSrc, vUv + vec2(t.x, -t.y)).rgb
     + texture(uSrc, vUv + vec2(-t.x, t.y)).rgb + texture(uSrc, vUv + vec2(t.x, t.y)).rgb;
  gl_FragColor = vec4(s * (uWeight / 16.0), 1.0);
}
`;

/**
 * Sum of two same-size layers (texel-centred lookups: exact). Bloom input while the near stars have
 * their own layer (lenses on screen with TAA on): near stars + the overlay's sprite layer.
 */
export const LAYER_SUM_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform sampler2D uSrc2;
in vec2 vUv;
void main() {
  gl_FragColor = vec4(texture(uSrc, vUv).rgb + texture(uSrc2, vUv).rgb, 1.0);
}
`;

/** Size of the composite's lens uniform arrays (≥ LensBuffer.MAX). */
export const COMPOSITE_MAX_LENSES = 8;

/**
 * Point-mass gravitational lenses (First Light masses), applied to the scene + bloom lookup uv.
 * Thin-lens model in a height-normalised image space (x × aspect, radii as fractions of the image
 * height): the image at offset θ from a lens shows the scene at β = θ − θ_E²/|θ| · θ̂, with the
 * per-pixel θ_E² = θ_E∞² · (D_s − D)/D_s from the scene's log depth (sky: D_s = ∞ → factor 1).
 * A lens behind the pixel's scene depth does nothing at that pixel (structure in front hides it).
 * The deflection is windowed smoothly to zero between 2 and 4 θ_E∞ and the sample offset is
 * clamped to 3 per-pixel θ_E (the inner, mirrored image would otherwise sample from anywhere).
 * Inside the shadow radius (capture cross-section) the scene goes black with a ~2 px soft edge,
 * and a thin warm-white HDR photon rim (× glow) sits on the edge.
 */
const LENS_GLSL = /* glsl */ `
#define PP_MAX_LENSES ${COMPOSITE_MAX_LENSES}
uniform vec4 uLensA[PP_MAX_LENSES]; // (u, v, θ_E, shadow radius): output uv (y up), radii in image heights
uniform vec4 uLensB[PP_MAX_LENSES]; // (lens log depth 0..1, strength 0..1, rim glow 0..1, 0)
uniform int uLensCount;             // 0 → the lens code is skipped (uniform branch)
uniform sampler2D uDepthTex;        // scene log depth (render resolution; 1 = sky / nothing opaque)
uniform float uOutTexelH;           // 1 / output height: the shadow's soft edge and the rim width

#define PP_INF_DEPTH 0.99999
#define PP_LOG_RANGE log2(1.0 + LOG_DEPTH_FAR / LOG_DEPTH_NEAR)
#define PP_LENS_WIN_IN 2.0     // deflection exact inside this many θ_E…
#define PP_LENS_WIN_OUT 4.0    // …windowed smoothly to zero here
#define PP_LENS_CLAMP 3.0      // max sample offset in per-pixel θ_E
#define PP_RIM_COL vec3(1.0, 0.86, 0.66)
#define PP_RIM_BASE 0.3        // photon rim with no beam nearby (the mass still reads as an object)
#define PP_RIM_GLOW 3.2        // added at glow = 1 (beam grazing the capture radius)

// Returns the lensed scene uv. vis: scene transmission (0 inside shadows), rim: HDR rim light.
vec2 pp_lenses(vec2 uv, vec2 asp, out float vis, out vec3 rim) {
  vis = 1.0;
  rim = vec3(0.0);
  // Scene depth at this pixel decides which lenses are in front of it, and how far behind them
  // the source is. textureLod: no gradient ops inside flow control (FXC).
  float ds = textureLod(uDepthTex, uv, 0.0).r;
  bool sky = ds >= PP_INF_DEPTH;
  float px = uOutTexelH;
  vec2 off = vec2(0.0);
  float mBest = 0.0; // strongest deflection at this pixel, and the depth of its lens
  float dRef = 1.0;
  for (int i = 0; i < PP_MAX_LENSES; i++) {
    if (i >= uLensCount) break;
    vec4 A = uLensA[i];
    vec4 B = uLensB[i];
    if (B.x >= ds) continue; // the scene at this pixel is in front of the lens: unaffected
    vec2 d = (A.xy - uv) * asp; // pixel → lens, image heights
    float r = length(d);
    float E = A.z;
    float S = A.w;
    float rCut = max(PP_LENS_WIN_OUT * E, 1.6 * S + 6.0 * px);
    if (r >= rCut) continue;
    // (D_s − D)/D_s from the log depths: D/D_s = 2^((d_lens − d_scene)·range) — exact to < 0.1 % once
    // both are beyond 1000 × the depth near plane (1e-4 ly), i.e. always in practice.
    float F = sky ? 1.0 : max(1.0 - exp2((B.x - ds) * PP_LOG_RANGE), 0.0);
    float e2 = E * E * F * B.y;
    float ir = 1.0 / max(r, 1e-6);
    float win = 1.0 - smoothstep(PP_LENS_WIN_IN * E, PP_LENS_WIN_OUT * E + 1e-6, r); // E may be 0
    float m = min(e2 * ir, PP_LENS_CLAMP * sqrt(e2)) * win;
    off += d * (m * ir);
    if (m > mBest) { mBest = m; dRef = B.x; }
    // Shadow (black, ~2 px soft edge) and the photon rim: sharp inside, softer outside, a faint halo.
    float edge = r - S;
    vis *= 1.0 - B.y * (1.0 - smoothstep(-px, px, edge));
    float w = max(1.3 * px, 0.07 * S);
    float x = edge / (edge < 0.0 ? 0.45 * w : w);
    float xh = edge < 0.0 ? x : 0.25 * x;
    // Faded to 0 by rCut: for lenses ≲ 3 px wide the wide halo is still 1–3 % up there, and the
    // early-out above would cut it as a hard-edged disc (no effect on larger lenses).
    float rimWin = 1.0 - smoothstep(0.5 * rCut, rCut, r);
    rim += PP_RIM_COL * (B.y * (PP_RIM_BASE + PP_RIM_GLOW * B.z) * rimWin * (exp(-x * x) + 0.12 * exp(-xh * xh)));
  }
  off /= asp;
  // Structure in front of the lens plane can never appear in its lensed image (screen space only
  // knows what the camera sees, and that would smear the occluder into the warp). When the lensed
  // lookup lands on something in front of the strongest lens, bisect the offset back toward the
  // pixel (whose own scene is behind the lens) until the lookup is behind it again.
  if (mBest > 0.0 && textureLod(uDepthTex, uv + off, 0.0).r <= dRef) {
    float lo = 0.0;
    float hi = 1.0;
    // 5 steps (1/32 of the offset): with 3, the offsets snapped to eighths and occluder edges inside
    // the warp turned into visible steps.
    for (int k = 0; k < 5; k++) {
      float mid = 0.5 * (lo + hi);
      if (textureLod(uDepthTex, uv + off * mid, 0.0).r > dRef) lo = mid;
      else hi = mid;
    }
    off *= lo;
  }
  return uv + off;
}
`;

/**
 * Final composite: upscale (+ clamped sharpening), point-mass lenses (warp, shadow, photon rim),
 * chromatic aberration, hyper zoom blur and speed tunnel, bloom, black-hole tidal swirl, wormhole
 * transit, exposure, hue-preserving filmic tone map, grading, vignette, film grain, TPDF dither,
 * linear → sRGB.
 */
export function buildCompositeFragment(wormholeGlsl: string): string {
  return /* glsl */ `
${COMMON_GLSL}
${wormholeGlsl}
${LENS_GLSL}

uniform sampler2D uSceneTex;
uniform sampler2D uBloomTex;
// Sprite layer (near stars, dust, nebula stars; the game overlay) kept out of the TAA history, scene
// resolution; uSpriteOn = 0 when the sprites are already inside uSceneTex (TAA off, no overlay).
uniform sampler2D uSpriteTex;
uniform float uSpriteOn;
// Near-star layer (near stars, dust, nebula stars), split off the sprite layer while lenses are on
// screen with TAA on: lensed and shadowed like the scene (the sprite layer then holds only the
// overlay, never lensed). uNearOn = 0 otherwise (the near stars are in uSceneTex or uSpriteTex).
uniform sampler2D uNearTex;
uniform float uNearOn;
uniform vec2 uSceneTexel;
uniform float uAspect;
uniform float uFxTime;
uniform float uFrame;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uSharpen;
uniform float uCABase;
uniform float uHyper;
uniform vec2 uFoe;
uniform float uTidal;
uniform vec2 uTidalCenter;
uniform vec2 uWormhole; // x: active (0/1), y: progress 0..1
uniform vec2 uGhost;    // x: ghost mode 0..1, y: inside a solid 0..1
uniform float uVignette;
uniform float uGrain;
in vec2 vUv;

// ACES filmic curve (Narkowicz fit): gentle toe keeps blacks deep, soft shoulder.
float pp_curve1(float x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 pp_curve3(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

// Hue-preserving tone map: the curve is applied to the peak channel (keeps saturated nebula hues),
// blended toward the per-channel curve as highlights get very bright so star cores roll to white.
vec3 pp_tonemap(vec3 c) {
  float peak = max(c.r, max(c.g, c.b));
  if (peak <= 1e-7) return vec3(0.0);
  vec3 hue = c * (pp_curve1(peak) / peak);
  vec3 chan = pp_curve3(c);
  float w = 0.15 + 0.85 * smoothstep(1.5, 10.0, peak);
  return mix(hue, chan, w);
}

vec3 pp_oetf(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

vec2 pp_swirl(vec2 uv, vec2 center, float angle, float barrel) {
  vec2 asp = vec2(uAspect, 1.0);
  vec2 d = (uv - center) * asp;
  float r = length(d);
  d = rot2(angle) * d;
  // Bounded: with the centre near or beyond the screen edge, r reaches ~2.5 at the far side and an
  // unbounded r² term would pull that edge in by a third of the screen.
  d *= 1.0 - barrel * min(r * r, 1.0);
  return center + d / asp;
}

void main() {
  vec2 asp = vec2(uAspect, 1.0);
  vec2 uv = vUv;
  bool wormOn = uWormhole.x > 0.5;
  float wp = clamp(uWormhole.y, 0.0, 1.0);

  // ---- black-hole tidal distortion: gentle breathing swirl + barrel around the hole ----
  if (uTidal > 0.001) {
    float r = length((uv - uTidalCenter) * asp);
    float breathe = 0.85 + 0.15 * sin(uFxTime * 0.6);
    uv = pp_swirl(uv, uTidalCenter, uTidal * 0.24 * breathe * exp(-1.6 * r), uTidal * 0.07);
  }

  // ---- wormhole entry: the scene swirls into the throat ----
  if (wormOn && wp < 0.2) {
    float s = smoothstep(0.0, 0.15, wp);
    float r = length((uv - 0.5) * asp);
    uv = pp_swirl(uv, vec2(0.5), s * 3.2 * (1.0 - smoothstep(0.0, 0.95, r)), 0.0);
    uv = 0.5 + (uv - 0.5) * (1.0 - 0.3 * s);
  }

  // ---- point-mass lenses: lensed scene/bloom uv, shadow transmission, photon rims ----
  // The sprite layer keeps the unlensed uv (beams are bent in world space already).
  vec2 uvS = uv;
  float lensVis = 1.0;
  vec3 lensRim = vec3(0.0);
  if (uLensCount > 0) uv = pp_lenses(uvS, asp, lensVis, lensRim);

  // ---- scene: bilinear upscale + clamped unsharp mask, chromatic aberration ----
  vec3 c0 = texture(uSceneTex, uv).rgb;
  vec3 col = c0;
  if (uSharpen > 0.001) {
    vec3 n = texture(uSceneTex, uv + vec2(0.0, uSceneTexel.y)).rgb;
    vec3 s = texture(uSceneTex, uv - vec2(0.0, uSceneTexel.y)).rgb;
    vec3 e = texture(uSceneTex, uv + vec2(uSceneTexel.x, 0.0)).rgb;
    vec3 w = texture(uSceneTex, uv - vec2(uSceneTexel.x, 0.0)).rgb;
    vec3 mn = min(c0, min(min(n, s), min(e, w)));
    vec3 mx = max(c0, max(max(n, s), max(e, w)));
    col = clamp(c0 + (c0 - 0.25 * (n + s + e + w)) * uSharpen, mn, mx);
  }
  float ca = uCABase + uHyper * 0.0045 + uTidal * 0.007;
  vec2 caOff = (uvS - 0.5) * ca; // a property of the screen position, not of the lensed lookup
  col.r += texture(uSceneTex, uv + caOff).r - c0.r;
  col.b += texture(uSceneTex, uv - caOff).b - c0.b;
  col *= lensVis;
  // Sprite layers: added after the sharpen (its neighbour clamp would clip the sprites away), bilinear
  // upscale (smooth Gaussian sprites need no sharpening), same chromatic aberration.
  // The near-star layer takes the lensed uv and the shadow. Approximation: near sprites write no
  // depth, so each lens is applied by the depth behind the sprite — one in front of the mass (a
  // close dust mote) is warped and shadowed too, exactly as when it is drawn into the scene (TAA off).
  bool nearL = uNearOn > 0.5;
  if (nearL) {
    col += vec3(textureLod(uNearTex, uv + caOff, 0.0).r, textureLod(uNearTex, uv, 0.0).g,
                textureLod(uNearTex, uv - caOff, 0.0).b) * lensVis;
  }
  bool sprites = uSpriteOn > 0.5;
  if (sprites) {
    // textureLod: no gradient ops inside flow control (FXC); the layer has no mipmaps anyway.
    col += vec3(textureLod(uSpriteTex, uvS + caOff, 0.0).r, textureLod(uSpriteTex, uvS, 0.0).g,
                textureLod(uSpriteTex, uvS - caOff, 0.0).b);
  }

  // ---- hyper: radial zoom blur toward the focus of expansion ----
  if (uHyper > 0.002) {
    vec2 toF = uFoe - uvS;
    float len = uHyper * 0.16;
    float j = hash12(gl_FragCoord.xy + vec2(mod(uFrame, 97.0) * 13.7, mod(uFrame, 89.0) * 7.3));
    vec3 acc = col;
    float wsum = 1.0;
    for (int i = 1; i <= 10; i++) {
      float fi = (float(i) - j) / 10.0;
      float wt = 1.0 - 0.6 * fi;
      vec2 zo = toF * (len * fi);
      vec3 zs = textureLod(uSceneTex, uv + zo, 0.0).rgb * lensVis;
      if (nearL) zs += textureLod(uNearTex, uv + zo, 0.0).rgb * lensVis;
      if (sprites) zs += textureLod(uSpriteTex, uvS + zo, 0.0).rgb;
      acc += zs * wt;
      wsum += wt;
    }
    float edge = smoothstep(0.04, 0.55, length((uvS - uFoe) * asp));
    col = mix(col, acc / wsum, edge * smoothstep(0.0, 0.25, uHyper));
  }

  // ---- bloom (lensed and shadowed like the scene it came from), then the photon rims ----
  col += texture(uBloomTex, uv).rgb * (uBloomStrength * lensVis);
  col += lensRim;

  // ---- hyper: faint cyan-violet speed tunnel at the edges ----
  if (uHyper > 0.002) {
    vec2 d = (vUv - uFoe) * asp;
    float r = length(d);
    vec2 dir = d / max(r, 1e-5);
    float streak = noise3(vec3(dir * 9.0, r * 3.0 - uFxTime * 6.5));
    streak *= streak;
    float mask = smoothstep(0.35, 1.1, r) * uHyper;
    float hueMix = 0.5 + 0.5 * sin(atan(dir.y, dir.x) * 2.0 + uFxTime * 0.7);
    vec3 tint = mix(vec3(0.25, 0.85, 1.2), vec3(0.75, 0.35, 1.25), hueMix);
    col += tint * (mask * (0.12 + 0.88 * streak) * 0.3);
  }

  // ---- wormhole transit: tunnel 0.15–0.85, white flash ~0.9, back to the scene by 1.0 ----
  if (wormOn) {
    vec3 tunnel = wormholeTunnel(vUv, uAspect, wp, uFxTime);
    float m = smoothstep(0.0, 0.15, wp) * (1.0 - smoothstep(0.86, 0.97, wp));
    col = mix(col, max(tunnel, 0.0), m);
    float fx = (wp - 0.9) / 0.04;
    col += vec3(1.0, 0.97, 0.94) * (8.0 * exp(-fx * fx));
  }

  // ---- exposure + tone map ----
  col = max(col, 0.0) * uExposure;
  if (any(isnan(col))) col = vec3(0.0);
  col = pp_tonemap(col);

  // ---- grading: faint deep-blue lift in the shadows (true black stays black), warm highlights ----
  float lum = luminance(col);
  col += vec3(0.0, 0.0022, 0.0085) * smoothstep(0.0, 0.06, lum) * (1.0 - smoothstep(0.06, 0.35, lum));
  col *= mix(vec3(1.0), vec3(1.02, 1.0, 0.975), smoothstep(0.45, 1.0, lum));
  col = max(mix(vec3(lum), col, 1.06), 0.0);

  // ---- ghost mode (collisions off): cool phase-shift look, stronger inside a solid ----
  if (uGhost.x > 0.002) {
    float gl = luminance(col);
    col = mix(col, vec3(gl) * vec3(0.74, 0.96, 1.12), 0.2 * uGhost.x + 0.22 * uGhost.y);
    vec2 gd = (vUv - 0.5) * asp;
    float gr = length(gd);
    float bands = 0.5 + 0.5 * sin(gr * 34.0 - uFxTime * 2.6 + 4.0 * noise3(vec3(gd * 4.0, uFxTime * 0.25)));
    col += vec3(0.32, 0.8, 1.0) * (smoothstep(0.42, 1.05, gr) * bands * (0.045 * uGhost.x + 0.07 * uGhost.y));
  }

  // ---- vignette ----
  vec2 vd = (vUv - 0.5) * asp / (0.5 * sqrt(uAspect * uAspect + 1.0));
  col *= 1.0 - uVignette * smoothstep(0.35, 1.05, length(vd));

  // ---- display encoding, film grain, TPDF dither ----
  col = pp_oetf(col);
  float fr = mod(uFrame, 1024.0);
  float ls = luminance(col);
  float grain = hash12(gl_FragCoord.xy * 1.0137 + vec2(fr * 17.31, fr * 5.77)) - 0.5;
  col += grain * uGrain * (4.0 * ls * (1.0 - ls));
  vec3 r1 = hash33(vec3(gl_FragCoord.xy, fr));
  vec3 r2 = hash33(vec3(gl_FragCoord.xy + 71.3, fr + 0.37));
  // Fade the dither out at true black so the void stays pure black.
  col += (r1 + r2 - 1.0) * smoothstep(vec3(0.0), vec3(2.0 / 255.0), col) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;
}
