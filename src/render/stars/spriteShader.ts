/**
 * Shared GLSL for every star-like sprite (far stars, near stars, dust motes, nebula stars).
 *
 * Each sprite is an instanced screen-space quad (corner = `position.xy` in {-1,1}²) built
 * around a Gaussian core that is energy-conserving across render resolutions and streak
 * lengths, with optional JWST-style diffraction spikes (6 long spikes at 60° + 2 faint
 * horizontal ones, chromatic: longer wavelengths reach further) and soft PSF wings.
 *
 * Units: "reference px" are pixels of a render target whose pixel subtends REF_PIXEL_ANGLE;
 * uPxScale = REF_PIXEL_ANGLE / ctx.pixelAngle converts them to real render-target px, so a
 * star carries the same energy and angular size at every dynamic resolution. Fluxes are
 * the integrated radiance of a sprite in (reference px)².
 */
import { CAMERA_UNIFORMS_GLSL, COMMON_GLSL } from '../shaders/common';
import { SKY_SAMPLE_GLSL } from '../sky/skyShared';

/** Angle subtended by one reference pixel (≈ one pixel at 1440p with a 70° vertical FOV). */
export const REF_PIXEL_ANGLE = 1e-3;
/** Core Gaussian sigma in reference px, and the floor in real px (FWHM ≈ 1.7 px: no shimmer). */
export const SPRITE_REF_SIGMA = 0.8;
export const SPRITE_MIN_SIGMA = 0.72;
/** Fraction of a fully spiked star's flux that goes into its diffraction spikes. */
export const SPIKE_FRACTION = 0.3;
/**
 * Energy of the spike pattern per unit amplitude, length and width:
 * √(2π) · Σ(half-spike falloff integrals) = 2.5066 · (6·0.1302 + 2·0.3·0.6·0.1302) ≈ 2.08.
 */
const SPIKE_NORM = 2.08;

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

/**
 * Forward relativistic aberration (rest-frame direction → observed direction): the exact
 * inverse of SKY_SAMPLE_GLSL's aberrate(). The Doppler factor is taken from aberrate() itself
 * at the observed direction, so point stars always shift colour exactly like the sky pixel
 * behind them, whatever Doppler convention skyShared.ts uses.
 */
const STAR_RELATIVITY_GLSL = /* glsl */ `
vec3 aberrateForward(vec3 dRest, out float doppler) {
  float b = clamp(uBeta, 0.0, 0.95);
  if (b < 1e-4) { doppler = 1.0; return dRest; }
  float cosR = clamp(dot(dRest, uVelDir), -1.0, 1.0);
  float cosO = (cosR + b) / (1.0 + b * cosR);
  vec3 perp = dRest - uVelDir * cosR;
  float pl = length(perp);
  vec3 pn = pl > 1e-6 ? perp / pl : vec3(0.0);
  float sinO = sqrt(max(0.0, 1.0 - cosO * cosO));
  vec3 dObs = normalize(uVelDir * cosO + pn * sinO);
  aberrate(dObs, doppler);
  return dObs;
}
`;

const SPRITE_VERT_LIB = /* glsl */ `
uniform float uPxScale;
// Per-sprite constants are identical at all four corners, so plain varyings suffice; 'flat'
// would make ANGLE/D3D11 emulate the GLES provoking vertex with a geometry shader.
out vec4 vShape;        // streak dir (xy), streak length px (z), core sigma px (w)
out vec3 vColor;         // core peak radiance
out vec4 vSpike;         // spike amplitude / peak, spike length px, spike width px, wing amplitude / peak
out float vRadius;       // quad half-extent px
out vec2 vLocal;         // offset from the head centre in px (screen axes)

#define SPRITE_MIN_SIGMA ${f(SPRITE_MIN_SIGMA)}
#define SPRITE_REF_SIGMA ${f(SPRITE_REF_SIGMA)}
#define SPIKE_FRACTION ${f(SPIKE_FRACTION)}
#define SPIKE_NORM ${f(SPIKE_NORM)}

float spriteSigma() { return max(SPRITE_MIN_SIGMA, SPRITE_REF_SIGMA * uPxScale); }

// Camera-relative world vector → view space (camera at the origin; uCamRot is local→world).
vec3 toView(vec3 rel) { return rel * uCamRot; }
vec2 viewToNdc(vec3 v) { return (v.xy / -v.z) / uTanHalf; }

// Drop the whole quad (every corner of an instance lands outside the clip volume).
void cullSprite() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  vShape = vec4(1.0, 0.0, 0.0, 1.0);
  vColor = vec3(0.0);
  vSpike = vec4(0.0);
  vRadius = 1.0;
  vLocal = vec2(0.0);
}

// Keep the streak tail in front of the camera (clip the view-space segment head→tail).
vec3 clipTail(vec3 head, vec3 tail) {
  float zh = -head.z;
  float zt = -tail.z;
  float zmin = zh * 0.05;
  if (zt >= zmin) return tail;
  return mix(head, tail, (zh - zmin) / max(zh - zt, 1e-20));
}

// Streak (px) from the head to the projected tail, clamped to maxPx.
vec2 streakPx(vec2 headNdc, vec3 headView, vec3 tailView, float maxPx) {
  vec2 s = (viewToNdc(clipTail(headView, tailView)) - headNdc) * 0.5 * uResolution;
  float l = length(s);
  return l > maxPx ? s * (maxPx / l) : s;
}

// Emit this vertex's corner of the sprite quad.
//   fluxPx: integrated radiance in real px²; colour: rgb multiplier (luminance ≈ 1 unless beamed);
//   tail: streak vector in px (head = current position, tail = where it appeared a shutter ago);
//   spikeAmt 0..1; spikeLenPx; wingAmt: PSF wing amplitude relative to the core peak;
//   depth01: window-space depth (logDepth for depth-tested sprites).
void emitSprite(vec2 headNdc, vec2 tail, vec3 colour, float fluxPx, float sigma,
                float spikeAmt, float spikeLenPx, float wingAmt, float depth01) {
  if (!(fluxPx > 0.0)) { cullSprite(); return; }   // also rejects NaN
  float len = length(tail);
  vec2 dir = len > 1e-3 ? tail / len : vec2(1.0, 0.0);
  len = len > 1e-3 ? len : 0.0;
  vec2 perp = vec2(-dir.y, dir.x);
  // blob energy 2πσ²; a streak adds len·√(2π)·σ, times 0.75 for the head→tail taper
  float peak = fluxPx / (6.2831853 * sigma * sigma + 1.8799712 * sigma * len);
  float R = 3.3 * sigma + 1.0;
  float spikeW = max(0.62, 0.5 * sigma);
  float spikeA = 0.0;
  if (spikeAmt > 0.002 && spikeLenPx > R) {
    R = spikeLenPx;
    spikeA = SPIKE_FRACTION * spikeAmt * fluxPx / (SPIKE_NORM * spikeLenPx * spikeW * peak);
  }
  if (wingAmt > 0.0) R = max(R, 24.0 * sigma);
  vec2 c = position.xy;
  vLocal = dir * (c.x < 0.0 ? -R : len + R) + perp * (c.y * R);
  gl_Position = vec4(headNdc + vLocal * 2.0 / uResolution, depth01 * 2.0 - 1.0, 1.0);
  vShape = vec4(dir, len, sigma);
  vColor = colour * peak;
  vSpike = vec4(spikeA, spikeLenPx, spikeW, wingAmt);
  vRadius = R;
}
`;

/** Prefix for every sprite vertex shader: common + camera + sky uniforms + helpers. */
export const SPRITE_VERT_PREFIX = `${COMMON_GLSL}
${CAMERA_UNIFORMS_GLSL}
${SKY_SAMPLE_GLSL}
${STAR_RELATIVITY_GLSL}
${SPRITE_VERT_LIB}`;

/** Fragment shader shared by every sprite material (additive, premultiplied: alpha = 0). */
export const SPRITE_FRAG = /* glsl */ `
in vec4 vShape;
in vec3 vColor;
in vec4 vSpike;
in float vRadius;
in vec2 vLocal;

float spikeFall(float x) {
  x = clamp(x, 0.0, 1.0);
  float o = 1.0 - x;
  return o * o / (1.0 + 10.0 * x);
}

// One diffraction line through the centre along d (covers two opposite spikes).
vec3 spikeLine(vec2 p, vec2 d, float w, float L) {
  float along = abs(dot(p, d));
  float across = dot(p, vec2(-d.y, d.x));
  float prof = exp(-0.5 * across * across / (w * w));
  const vec3 lambda = vec3(1.14, 1.0, 0.86);   // longer wavelengths diffract further
  vec3 x = along / (L * lambda);
  vec3 fall = vec3(spikeFall(x.r), spikeFall(x.g), spikeFall(x.b));
  // faint beading along the spike, period ∝ wavelength
  vec3 bead = 0.86 + 0.14 * cos(along * (57.12 / max(L, 8.0)) / lambda);
  return prof * fall * bead;
}

void main() {
  vec2 dir = vShape.xy;
  float len = vShape.z;
  float sigma = vShape.w;
  float a = clamp(dot(vLocal, dir), 0.0, len);
  vec2 q = vLocal - dir * a;
  float r2 = dot(q, q);
  float s2 = sigma * sigma;
  float taper = len > 0.0 ? 1.0 - 0.5 * a / len : 1.0;
  vec3 col = vColor * (exp(-0.5 * r2 / s2) * taper);
  if (vSpike.w > 0.0) {
    float wing = vSpike.w * pow(1.0 + r2 / (9.0 * s2), -1.5);
    col += vColor * (wing * (1.0 - smoothstep(0.6, 1.0, sqrt(r2) / vRadius)));
  }
  if (vSpike.x > 0.0) {
    float L = vSpike.y;
    float w = vSpike.z;
    vec3 s = spikeLine(vLocal, vec2(0.0, 1.0), w, L)
           + spikeLine(vLocal, vec2(0.8660254, 0.5), w, L)
           + spikeLine(vLocal, vec2(-0.8660254, 0.5), w, L)
           + 0.3 * spikeLine(vLocal, vec2(1.0, 0.0), w * 0.9, L * 0.6);
    col += vColor * (vSpike.x * s);
  }
  gl_FragColor = vec4(col, 0.0);
}
`;
