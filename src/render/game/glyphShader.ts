/**
 * Overlay glyphs: instanced SDF markers (GLYPH_SHAPE: ring, disc, diamond, dot, cross, glow).
 *
 * Vertex: on-screen radius = max(minPx · uPxScale, worldRadius / (viewZ · pixelAngle)) — a
 * world-sized marker that never shrinks below minPx reference px — placed at the log depth of the
 * FRONT of the sphere it marks (centre depth minus its on-screen radius in world units, at most
 * half the depth): a beam-endpoint glow lying on a surface stays in front of it instead of
 * z-fighting with the (TAA-jittered) scene depth. A positive phase adds a soft breathing (±18 % brightness, ±5 % size at
 * GLYPH_BREATH_HZ, offset by the phase so markers don't breathe in unison). Markers that grow to
 * fill the view or surround the camera fade out instead of washing over it.
 *
 * Fragment: signed distances in glyph radii, converted to px for a 1-px anti-aliased edge;
 * outlines stay ≥ 1.2 px wide (thinner ones dim instead of breaking up).
 */
import { CAMERA_UNIFORMS_GLSL, COMMON_GLSL } from '../shaders/common';
import { OVERLAY_VERT_LIB } from './lineShader';

/** Breathing frequency of glyphs with phase > 0 (Hz; the CPU wraps uBreath = fract(time × this)). */
export const GLYPH_BREATH_HZ = 0.4;

export const GLYPH_VERT = /* glsl */ `
${COMMON_GLSL}
${CAMERA_UNIFORMS_GLSL}
${OVERLAY_VERT_LIB}
uniform float uBreath;   // breathing clock in cycles (wrapped on the CPU)

in vec3 aPos;     // centre, camera-relative world (ly)
in vec4 aGlyph;   // world radius (ly), minimum radius (ref px), shape, phase
in vec4 aColor;   // linear HDR rgb, fill
in float aLine;   // outline thickness (fraction of the radius)

out vec2 vLocal;  // position in the quad, in glyph radii
out vec4 vShape;  // shape, fill, outline thickness (radii), radius (px)
out vec3 vColor;

void cullGlyph() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  vLocal = vec2(0.0);
  vShape = vec4(0.0, 0.0, 0.1, 1.0);
  vColor = vec3(0.0);
}

void main() {
  vec3 v = ovToView(aPos);
  float z = -v.z;
  float dist = length(aPos);
  float size = max(aGlyph.x, 0.0);
  if (!(z > 1e-4 * dist) || !(dist > 0.0)) { cullGlyph(); return; }   // behind the camera (or NaN)
  float rPx = max(aGlyph.y * uPxScale, size / max(z * uPixelAngle, 1e-30));
  float bright = uAlpha;
  if (aGlyph.w > 0.0) {
    float b = sin(6.2831853 * (aGlyph.w + uBreath));
    rPx *= 1.0 + 0.05 * b;
    bright *= 1.0 + 0.18 * b;
  }
  bright *= 1.0 - smoothstep(0.3, 0.6, rPx / uResolution.y);
  if (size > 0.0) bright *= smoothstep(1.0, 2.0, dist / size);
  rPx = min(rPx, 0.6 * uResolution.y);
  if (!(bright > 0.0) || !(rPx > 0.0) || !(aColor.r + aColor.g + aColor.b > 0.0)) { cullGlyph(); return; }
  float shape = floor(aGlyph.z + 0.5);
  // disc and glow reach past their radius (outer glow); the others end at it
  float ext = (shape == 1.0 || shape == 5.0) ? 2.2 : 1.0;
  float Q = rPx * ext + 1.5;
  float zFront = max(z * (1.0 - rPx * uPixelAngle), 0.5 * z);
  gl_Position = vec4(ovViewToNdc(v) + position.xy * (2.0 * Q) / uResolution, logDepth(zFront) * 2.0 - 1.0, 1.0);
  vLocal = position.xy * (Q / rPx);
  vShape = vec4(shape, clamp(aColor.a, 0.0, 1.0), clamp(aLine, 0.02, 0.5), rPx);
  vColor = max(aColor.rgb, vec3(0.0)) * bright;
}
`;

export const GLYPH_FRAG = /* glsl */ `
in vec2 vLocal;
in vec4 vShape;
in vec3 vColor;

// Coverage of a signed distance given in px (1-px anti-aliased edge).
float ovCover(float dPx) { return clamp(0.5 - dPx, 0.0, 1.0); }
float ovBox(vec2 p, vec2 b) {
  vec2 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

void main() {
  float shape = vShape.x;
  float fill = vShape.y;
  float rPx = vShape.w;
  vec2 p = vLocal;
  float r = length(p);
  float lw = max(vShape.z, 1.2 / rPx);
  float lineGain = vShape.z / lw;
  float a;
  if (shape < 0.5) {
    // ring; fill blends toward a filled disc
    float band = abs(r - 1.0 + 0.5 * lw) - 0.5 * lw;
    a = max(ovCover(band * rPx) * lineGain, fill * ovCover((r - 1.0) * rPx));
  } else if (shape < 1.5) {
    // disc: soft body brightening outward, bright rim, short outer glow (0 at the quad edge, r = 2.2)
    float inside = ovCover((r - 1.0) * rPx);
    float band = abs(r - 1.0 + 0.5 * lw) - 0.5 * lw;
    float glow = max(exp(-5.0 * max(r - 1.0, 0.0)) - 0.0024788, 0.0);
    a = inside * (0.3 + 0.3 * r * r) * mix(0.6, 1.0, fill) + ovCover(band * rPx) * lineGain + (1.0 - inside) * 0.3 * glow;
  } else if (shape < 2.5) {
    // diamond: filled ◆ (fill = 1) or outline ◇ (fill = 0)
    float dd = (abs(p.x) + abs(p.y) - 1.0) * 0.70710678;
    float band = abs(dd + 0.5 * lw) - 0.5 * lw;
    a = max(ovCover(band * rPx) * lineGain, fill * 0.85 * ovCover(dd * rPx));
  } else if (shape < 3.5) {
    // small hard dot
    a = ovCover((r - 1.0) * rPx);
  } else if (shape < 4.5) {
    // plus-shaped cross
    float hw = 0.5 * lw;
    a = ovCover(min(ovBox(p, vec2(1.0, hw)), ovBox(p, vec2(hw, 1.0))) * rPx) * lineGain;
  } else {
    // soft Gaussian glow (sigma ≈ 0.41 radii; ≈ 0 at the quad edge)
    a = exp(-3.0 * r * r);
  }
  gl_FragColor = vec4(vColor * a, 0.0);
}
`;
