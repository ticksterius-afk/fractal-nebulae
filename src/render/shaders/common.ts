/**
 * GLSL shared by every custom shader (WebGL2 / GLSL ES 3.00; materials never set glslVersion,
 * see ARCHITECTURE.md §0).
 * Contract owner: architecture. Do not rename functions — fractal, black-hole,
 * sky, star and nebula shaders all depend on these names.
 */
import { TUNING } from '../../app/config';

const f = (x: number) => {
  const s = x.toPrecision(9);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};

export const COMMON_GLSL = /* glsl */ `
#ifndef COMMON_GLSL_INCLUDED
#define COMMON_GLSL_INCLUDED

#define PI 3.14159265358979
#define TAU 6.28318530717959

// ---- logarithmic depth (shared by every pass that writes or tests depth) ----
// viewZ = distance along the camera forward axis in light-years (positive in front).
#define LOG_DEPTH_NEAR ${f(TUNING.depthNear)}
#define LOG_DEPTH_FAR ${f(TUNING.depthFar)}
float logDepth(float viewZ) {
  float z = max(viewZ, LOG_DEPTH_NEAR);
  return clamp(log2(1.0 + z / LOG_DEPTH_NEAR) / log2(1.0 + LOG_DEPTH_FAR / LOG_DEPTH_NEAR), 0.0, 1.0);
}

// ---- hashing / noise ----
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }

// Value noise in [0,1], smooth (quintic).
float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 fr = fract(p);
  vec3 u = fr * fr * fr * (fr * (fr * 6.0 - 15.0) + 10.0);
  float n000 = hash13(i + vec3(0, 0, 0));
  float n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0));
  float n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1));
  float n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1));
  float n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

// Fractal Brownian motion, octaves 1..8, result roughly [0,1].
float fbm3(vec3 p, int octaves) {
  float a = 0.5, s = 0.0, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    s += a * noise3(p);
    norm += a;
    p = p * 2.03 + vec3(17.1, -3.7, 9.2);
    a *= 0.5;
  }
  return s / norm;
}

// ---- colour ----
vec3 cosPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(TAU * (c * t + d)); }

// three.js already prepends a luminance() to every ShaderMaterial fragment shader (not the vertex
// stage), so ours has a private name and a macro alias that works in both stages.
float fnLuminance709(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
#define luminance fnLuminance709

// Approximate blackbody colour (normalized, linear) for temperature in Kelvin (1000..40000).
vec3 blackbody(float t) {
  t = clamp(t, 1000.0, 40000.0) / 100.0;
  vec3 c;
  c.r = t <= 66.0 ? 1.0 : clamp(1.29293618606 * pow(t - 60.0, -0.1332047592), 0.0, 1.0);
  c.g = t <= 66.0 ? clamp(0.39008157876 * log(t) - 0.63184144378, 0.0, 1.0)
                  : clamp(1.12989086089 * pow(t - 60.0, -0.0755148492), 0.0, 1.0);
  c.b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.54320678911 * log(t - 10.0) - 1.19625408914, 0.0, 1.0));
  return pow(c, vec3(2.2)); // to linear
}

// ---- geometry ----
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

// Ray/sphere (centre at origin). Returns (tNear, tFar); tFar < 0 or tNear > tFar => miss.
vec2 sphereIntersect(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// Camera ray in WORLD orientation (camera sits at the origin of camera-relative space).
// fragCoord: gl_FragCoord.xy, resolution: render target size in px,
// camRot: camera local→world rotation, tanHalf: (tan(fovY/2)*aspect, tan(fovY/2)).
vec3 cameraRay(vec2 fragCoord, vec2 resolution, mat3 camRot, vec2 tanHalf) {
  vec2 ndc = (fragCoord / resolution) * 2.0 - 1.0;
  return normalize(camRot * vec3(ndc * tanHalf, -1.0));
}

#endif
`;

/**
 * Uniforms every full-screen raymarch pass receives (the renderer fills them):
 *   uniform vec2  uResolution;   // render target px
 *   uniform mat3  uCamRot;       // camera local→world rotation
 *   uniform vec3  uCamForward;   // world unit forward (= uCamRot * vec3(0,0,-1))
 *   uniform vec2  uTanHalf;      // tan(fovY/2)*aspect, tan(fovY/2)
 *   uniform float uPixelAngle;   // radians per render-target pixel (vertical)
 *   uniform float uTime;
 *   uniform vec2  uJitter;       // sub-pixel TAA jitter in px (add to gl_FragCoord.xy for cameraRay)
 * Depth written by a pass for a camera-relative world hit point h:
 *   gl_FragDepth = logDepth(dot(h, uCamForward));
 */
export const CAMERA_UNIFORMS_GLSL = /* glsl */ `
uniform vec2 uResolution;
uniform mat3 uCamRot;
uniform vec3 uCamForward;
uniform vec2 uTanHalf;
uniform float uPixelAngle;
uniform float uTime;
uniform vec2 uJitter;
`;
