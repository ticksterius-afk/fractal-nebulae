/**
 * Overlay ribbons (beams, guides, dashed outlines): one instanced screen-space quad per segment.
 *
 * Vertex: the camera-relative endpoints go to view space and are clipped (Liang–Barsky) against
 * the near plane AND a frustum widened by LINE_FRUSTUM_MARGIN — so projected coordinates stay
 * within ±1.3 NDC and keep full float precision even when a beam passes right by the camera. The
 * clipped segment is expanded in screen space by its profile radius (width × uPxScale: reference
 * px, like star sprites) on both sides and beyond both ends, at logDepth(viewZ) per vertex — viewZ
 * pulled toward the camera by the ribbon's screen radius (a tube of that radius), so a beam ending
 * on a surface does not z-fight with it. The fragment writes the perspective-correct depth (1/viewZ
 * interpolated along the segment): the rasterizer would interpolate the log depth linearly in
 * screen space, which puts the middle of a segment receding in depth too far away (the geometric
 * instead of the harmonic mean of its end depths) and misclassifies it as occluded near surfaces.
 *
 * Fragment: distance to the segment axis → Gaussian profiles. Beam = hot core (FWHM ≈ 0.35 width)
 * + cyan halo (FWHM ≈ 1.2 width) with slow pulses flowing along s; guide = one thin Gaussian;
 * dashed = guide × anti-aliased dashes along s. Thin lines dim instead of aliasing (the core sigma
 * is floored at LINE_MIN_SIGMA px with the peak scaled to keep the energy per unit length).
 *
 * Joints: polyline ends (cap bits from the CPU) get round caps. Interior ends get a smooth
 * cross-fade over ±h px instead, w = F(t/h) − F((t − L)/h) with F = smoothstep(−1, 1, ·): along a
 * polyline these telescope to exactly 1, so additive segments show no beads at their joints.
 */
import { CAMERA_UNIFORMS_GLSL, COMMON_GLSL } from '../shaders/common';

/** Halo tint of beams (the Voyage cyan accent, design §7.5) and its luminance. */
const BEAM_HALO_TINT = [0.5, 1.6, 1.8] as const;
const BEAM_HALO_LUM = 0.2126 * BEAM_HALO_TINT[0] + 0.7152 * BEAM_HALO_TINT[1] + 0.0722 * BEAM_HALO_TINT[2];

const f = (x: number) => {
  const s = x.toPrecision(7);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};

/** GLSL helpers shared by the overlay vertex shaders (lines + glyphs). */
export const OVERLAY_VERT_LIB = /* glsl */ `
uniform float uPxScale;
uniform float uAlpha;   // pass intensity: 1 (visible pass) or overlay.occludedAlpha (occluded pass)
// Camera-relative world vector → view space (camera at the origin, looking down −Z).
vec3 ovToView(vec3 rel) { return rel * uCamRot; }
vec2 ovViewToNdc(vec3 v) { return (v.xy / -v.z) / uTanHalf; }
`;

export const LINE_VERT = /* glsl */ `
${COMMON_GLSL}
${CAMERA_UNIFORMS_GLSL}
${OVERLAY_VERT_LIB}
#define LINE_MIN_SIGMA 0.6
#define LINE_HALO_AMP 0.4
#define LINE_FRUSTUM_MARGIN 1.3
#define BEAM_HALO_TINT vec3(${f(BEAM_HALO_TINT[0])}, ${f(BEAM_HALO_TINT[1])}, ${f(BEAM_HALO_TINT[2])})
#define BEAM_HALO_LUM ${f(BEAM_HALO_LUM)}

in vec3 aP0;     // segment start, camera-relative world (ly)
in vec3 aP1;     // segment end
in vec4 aColor;  // linear HDR rgb, cap bits (1 = round cap at the start, 2 = at the end)
in vec4 aLine;   // width (ref px), s0, s1 (LOCAL distance along the polyline), style (LINE_STYLE)

// Per-segment constants are identical at all four corners: plain varyings ('flat' would make
// ANGLE/D3D11 emulate the provoking vertex with a geometry shader).
out vec4 vSeg;   // along (px from the start), across (px), screen length L (px), cross-fade half-length h (px)
out vec4 vProf;  // core sigma (px), halo sigma (px), core peak, halo peak
out vec3 vCore;  // core colour (pass alpha applied)
out vec3 vHalo;  // halo colour
out vec4 vS;     // s at the start, s at the end × w1, w1 (perspective weights, w0 = 1), style
out float vCaps;
out vec2 vInvZ;  // 1 / biased viewZ at the (clipped) start and end: linear in screen space

void cullLine() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  vSeg = vec4(0.0, 0.0, 0.0, 1.0);
  vProf = vec4(1.0, 1.0, 0.0, 0.0);
  vCore = vec3(0.0);
  vHalo = vec3(0.0);
  vS = vec4(0.0, 0.0, 1.0, 0.0);
  vCaps = 0.0;
  vInvZ = vec2(1.0);
}

// Liang–Barsky step: keep the part of [t0, t1] where the linear function f (fa at t = 0, fb at
// t = 1) is ≥ 0. Returns false when nothing is left.
bool clipLine(float fa, float fb, inout float t0, inout float t1) {
  if (fa < 0.0 && fb < 0.0) return false;
  if (fa < 0.0) t0 = max(t0, fa / (fa - fb));
  else if (fb < 0.0) t1 = min(t1, fa / (fa - fb));
  return t0 < t1;
}

void main() {
  float width = aLine.x;
  float style = aLine.w;
  if (!(width > 0.0) || !(aColor.r + aColor.g + aColor.b > 0.0)) { cullLine(); return; }   // also rejects NaN
  vec3 a = ovToView(aP0);
  vec3 b = ovToView(aP1);
  float za = -a.z;
  float zb = -b.z;
  float kx = uTanHalf.x * LINE_FRUSTUM_MARGIN;
  float ky = uTanHalf.y * LINE_FRUSTUM_MARGIN;
  float t0 = 0.0;
  float t1 = 1.0;
  bool keep = clipLine(za - LOG_DEPTH_NEAR, zb - LOG_DEPTH_NEAR, t0, t1);
  if (keep) keep = clipLine(kx * za - a.x, kx * zb - b.x, t0, t1);
  if (keep) keep = clipLine(kx * za + a.x, kx * zb + b.x, t0, t1);
  if (keep) keep = clipLine(ky * za - a.y, ky * zb - b.y, t0, t1);
  if (keep) keep = clipLine(ky * za + a.y, ky * zb + b.y, t0, t1);
  if (!keep) { cullLine(); return; }
  vec3 ca = mix(a, b, t0);
  vec3 cb = mix(a, b, t1);
  float zA = -ca.z;
  float zB = -cb.z;
  // A clipped end lies outside the widened frustum or on the near plane: whatever profile it gets
  // there is off-screen, so the cap bits can stay as they are.
  vec2 pa = ovViewToNdc(ca) * 0.5 * uResolution;   // px from the image centre
  vec2 pb = ovViewToNdc(cb) * 0.5 * uResolution;
  vec2 d = pb - pa;
  float L = length(d);
  vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);

  float wPx = width * uPxScale;
  bool beam = style < 0.5;
  float coreRef = (beam ? 0.35 : 1.0) * wPx / 2.3548;
  float coreSig = max(LINE_MIN_SIGMA, coreRef);
  float haloSig = max(1.2, 0.5 * wPx);
  float corePeak = coreRef / coreSig;
  float haloPeak = beam ? LINE_HALO_AMP * min(1.0, 0.5 * wPx / haloSig) : 0.0;
  float R = (beam ? 3.0 * haloSig : 3.0 * coreSig) + 1.0;

  vec2 c = position.xy;
  bool startEnd = c.x < 0.0;
  vec2 px = (startEnd ? pa - dir * R : pb + dir * R) + nrm * (c.y * R);
  float zBias = max(1.0 - R * uPixelAngle, 0.5);
  gl_Position = vec4(px * 2.0 / uResolution, logDepth((startEnd ? zA : zB) * zBias) * 2.0 - 1.0, 1.0);

  vSeg = vec4(startEnd ? -R : L + R, c.y * R, L, 0.5 * R);
  vProf = vec4(coreSig, haloSig, corePeak, haloPeak);
  vec3 col = max(aColor.rgb, vec3(0.0)) * uAlpha;
  vCore = col;
  vHalo = beam ? mix(col, BEAM_HALO_TINT * (luminance(col) / BEAM_HALO_LUM), 0.8) : vec3(0.0);
  float sa = mix(aLine.y, aLine.z, t0);
  float sb = mix(aLine.y, aLine.z, t1);
  float w1 = clamp(zA / max(zB, 1e-30), 1e-4, 1e4);
  vS = vec4(sa, sb * w1, w1, style);
  vCaps = aColor.a;
  vInvZ = vec2(1.0 / max(zA * zBias, 0.5 * LOG_DEPTH_NEAR), 1.0 / max(zB * zBias, 0.5 * LOG_DEPTH_NEAR));
}
`;

export const LINE_FRAG = /* glsl */ `
${COMMON_GLSL}
in vec4 vSeg;
in vec4 vProf;
in vec3 vCore;
in vec3 vHalo;
in vec4 vS;
in float vCaps;
in vec2 vInvZ;
uniform float uFlowPeriod;   // LOCAL length of one beam pulse
uniform float uFlowPhase;    // cycles, wrapped on the CPU (pulses travel toward +s)
uniform float uDashPeriod;   // LOCAL length of one dash + gap

void main() {
  float t = vSeg.x;
  float L = vSeg.z;
  float h = vSeg.w;
  // perspective-correct distance along the polyline
  float u = L > 1e-4 ? clamp(t / L, 0.0, 1.0) : 0.0;
  float s = mix(vS.x, vS.y, u) / mix(1.0, vS.z, u);
  float fs = fwidth(s);   // at top level: FXC rejects derivatives in divergent flow control

  bool capStart = mod(vCaps, 2.0) > 0.5;
  bool capEnd = vCaps > 1.5;
  float r = abs(vSeg.y);
  if (t < 0.0 && capStart) r = length(vec2(t, vSeg.y));
  if (t > L && capEnd) r = length(vec2(t - L, vSeg.y));
  float w = (capStart ? 1.0 : smoothstep(-h, h, t)) - (capEnd ? 0.0 : smoothstep(-h, h, t - L));

  float core = vProf.z * exp(-0.5 * r * r / (vProf.x * vProf.x));
  vec3 col;
  if (vS.w < 0.5) {
    // beam: pulses (±20 %) flowing toward the travel direction; averaged out where they would alias
    float halo = vProf.w * exp(-0.5 * r * r / (vProf.y * vProf.y));
    float wave = 0.5 + 0.5 * cos(6.2831853 * (s / uFlowPeriod - uFlowPhase));
    wave = mix(wave * wave, 0.375, clamp(2.0 * fs / uFlowPeriod - 0.5, 0.0, 1.0));
    float flow = 0.8 + 0.4 * wave;
    col = vCore * (core * flow) + vHalo * (halo * (0.85 + 0.15 * flow));
  } else {
    col = vCore * core;
    if (vS.w > 1.5) {
      // dashes (50 % duty), 1-px anti-aliased, fading to an even 50 % once they get sub-pixel
      float q = s / uDashPeriod;
      float fq = max(fs / uDashPeriod, 1e-6);
      float dash = clamp(0.5 - (abs(fract(q) - 0.5) - 0.25) / fq, 0.0, 1.0);
      col *= mix(dash, 0.5, clamp(2.0 * fq - 0.5, 0.0, 1.0));
    }
  }
  gl_FragColor = vec4(col * max(w, 0.0), 0.0);
  // perspective-correct depth along the segment (ends beyond it keep the end depth)
  gl_FragDepth = logDepth(1.0 / max(mix(vInvZ.x, vInvZ.y, u), 1e-30));
}
`;
