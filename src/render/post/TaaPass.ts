/**
 * Temporal anti-aliasing with upsampling (TAAU).
 *
 * ── Pipeline order (Renderer.drawFrame) ──────────────────────────────────────────────────────
 *  1. Scene → sceneRT (HalfFloat RGBA + 32F DepthTexture, size = output × renderScale): sky, far
 *     stars, nebula / black-hole passes. Each frame the Renderer sets ctx.jitter to a Halton(2,3)
 *     offset J (scene-RT px, −0.5..0.5). Sky / nebula / black-hole passes trace
 *     cameraRay(gl_FragCoord.xy + uJitter, …), so scene pixel k holds the image at UNJITTERED
 *     scene-pixel position k + 0.5 + J. Far-star sprites are not jittered (their samples are
 *     treated as jittered: they gain ±0.5 scene px of blur, no shimmer).
 *     Passes write gl_FragDepth = logDepth(viewZ); 1.0 = nothing opaque → infinitely far.
 *  1b. Near stars / dust / nebula stars (StarSystem.renderNear) → Renderer.spriteRT, a separate
 *     layer sharing sceneRT's depth texture (depth-tested, no depth writes). They move with
 *     parallax or on their own and write no depth, so this resolve could not reproject them
 *     (accumulated, they fade to faint smears when the ship moves): they bypass the history.
 *  2. Bloom from sceneRT + spriteRT.
 *  3. TaaPass.render (this file), full OUTPUT resolution, one full-screen draw into an MRT
 *     ping-pong pair: history[cur] = f(sceneRT colour+depth, history[prev]).
 *  4. CompositePass samples the resolved history texture instead of sceneRT (mild sharpen) and
 *     adds spriteRT (bilinear upscale) on top.
 *
 * ── Per output pixel ─────────────────────────────────────────────────────────────────────────
 *  • Current: 3×3 scene samples around the one nearest the pixel centre (texelFetch). Two Gaussian
 *    reconstructions from the same taps: NARROW (σ ≈ 0.47–0.65 OUTPUT px: what gets accumulated →
 *    output-resolution detail) and WIDE (Blackman-Harris fit in scene px: a smooth prior for
 *    pixels with no history). They are averaged linearly and then encoded into a max-channel
 *    Reinhard space e = c/(1+max(c)) (exactly invertible) for the temporal blend; uSpatialLinear = 0
 *    averages the encoded samples instead (stronger firefly suppression, but steep HDR peaks such
 *    as star cores lose up to ~50 % energy). Neighbourhood mean/variance of the encoded samples in
 *    YCoCg for clipping.
 *  • Depth: closest log depth of the 3×3 (velocity dilation) → view Z → camera-relative position
 *    → previous view → previous uv. Infinite depth → rotation-only reprojection. Points inside the
 *    reference nebula's render sphere (the nearest one) reproject in THAT nebula's rotating frame,
 *    so spin and the sim's co-rotation carry are exact; everything else is world-static.
 *  • History: 5-tap Catmull-Rom at the previous uv (linear HDR rgb, a = accumulated weight H),
 *    variance-clipped toward the neighbourhood box in YCoCg. H is dropped when the previous uv is
 *    off-screen / behind the previous camera, faded on depth disocclusion (the stored previous
 *    closest depth, farthest of its 2×2 footprint, is in front of the expected previous depth),
 *    and capped with motion.
 *  • Blend (running weighted mean, encoded space): out = (H·hist + W·narrow + P·wide) / (H + W + P),
 *    W = Σ w_narrow,
 *    H' = min(H + Σ w_narrow + P, 2·Hmax). Samples landing near the pixel centre therefore count
 *    more (lower effective feedback), and history converges in a few frames after a reset.
 *    Hmax is set on the CPU so the steady-state feedback is ≈ `feedback` (0.9 native, 0.93 when
 *    upsampling ×2); a static camera lets H grow to 2·Hmax (cleaner stills).
 *  • Output: decoded linear HDR, sanitised (bit-level Inf/NaN test that fast-math can't remove),
 *    clamped to TAA_MAX_LIN. MRT attachment 1 (R16F) stores the dilated log depth for next frame.
 *
 * ── Uniforms ─────────────────────────────────────────────────────────────────────────────────
 *  uCurrent        sampler2D  scene colour (linear HDR, jittered)                 scene px
 *  uCurrentDepth   sampler2D  scene DepthTexture (log depth, 1 = far)             scene px
 *  uHistory        sampler2D  previous resolve: rgb linear HDR, a = weight H      output px
 *  uHistoryDepth   sampler2D  previous dilated log depth (r)                      output px
 *  uRtSize         vec2       scene RT size (px)
 *  uOutSize        vec2       output / history size (px)
 *  uJitter         vec2       this frame's jitter (scene px)
 *  uTanHalf        vec2       current (tan(fovY/2)·aspect, tan(fovY/2))
 *  uPrevTanHalf    vec2       previous frame's
 *  uCurToPrev      mat3       current view → previous view rotation, world-static frame (R_p^T R_c)
 *  uWorldOffset    vec3       R_p^T (shipPos_cur − shipPos_prev), ly (computed in doubles)
 *  uRefCurToPrev   mat3       R_p^T Q R_c, Q = nebRot_prev · nebRot_cur⁻¹ (reference nebula frame)
 *  uRefOffset      vec3       R_p^T (nebPos_prev − ship_prev + Q (ship_cur − nebPos_cur)), ly
 *  uRefSphere      vec4       xyz: reference nebula centre in current view space (ly), w: radius²
 *                             (w < 0: no reference frame)
 *  uAccum          vec4       x: 1/(2σ²) narrow kernel (output px⁻²), y: Hmax, z: prior weight P,
 *                             w: history valid (0 = reset)
 *  uReject         vec4       x: depth-disocclusion threshold in log-depth units (0 = off),
 *                             y: H cap falloff per output px of motion, z/w: clip γ static/moving
 *  uSpatialLinear  float      1: 3×3 reconstruction averaged linearly (default), 0: in the encoded
 *                             space (see `spatialLinear`)
 * Camera-relative maths: previous camera-relative position of a world-static point is
 *   P_prev = P_cur + (shipPos_cur − shipPos_prev); for a point static in a nebula's local frame
 *   P_prev = Q P_cur + (nebPos_prev − ship_prev) + Q (ship_cur − nebPos_cur).
 */
import * as THREE from 'three';
import type { NebulaRuntime } from '../../core/types';
import { TUNING } from '../../app/config';
import { COMMON_GLSL } from '../shaders/common';
import { FullscreenPass, postMaterial } from './FullscreenPass';

export const TAA_FRAG = /* glsl */ `
${COMMON_GLSL}

uniform sampler2D uCurrent;
uniform sampler2D uCurrentDepth;
uniform sampler2D uHistory;
uniform sampler2D uHistoryDepth;
uniform vec2 uRtSize;
uniform vec2 uOutSize;
uniform vec2 uJitter;
uniform vec2 uTanHalf;
uniform vec2 uPrevTanHalf;
uniform mat3 uCurToPrev;
uniform vec3 uWorldOffset;
uniform mat3 uRefCurToPrev;
uniform vec3 uRefOffset;
uniform vec4 uRefSphere;
uniform vec4 uAccum;
uniform vec4 uReject;
uniform float uSpatialLinear;

// MRT attachment 1: dilated log depth for next frame's disocclusion test.
// (three declares pc_fragColor at location 0 = gl_FragColor.)
layout(location = 1) out highp vec4 taa_depthOut;

#define TAA_MAX_LIN 30000.0
#define TAA_INF_DEPTH 0.99999
#define TAA_LOG_RANGE log2(1.0 + LOG_DEPTH_FAR / LOG_DEPTH_NEAR)

// Inf/NaN test on the bit pattern: survives compilers that fold isnan()/isinf() under fast math.
bool taa_bad(vec4 v) {
  uvec4 e = floatBitsToUint(v) & uvec4(0x7f800000u);
  return any(equal(e, uvec4(0x7f800000u)));
}

float taa_max3(vec3 c) { return max(c.r, max(c.g, c.b)); }

vec3 taa_ycocg(vec3 c) {
  return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
vec3 taa_rgb(vec3 y) { return vec3(y.x + y.y - y.z, y.x + y.z, y.x - y.y - y.z); }

// Inverse of logDepth(): view Z (ly) from window depth.
float taa_viewZ(float d) { return LOG_DEPTH_NEAR * (exp2(d * TAA_LOG_RANGE) - 1.0); }

// Bicubic Catmull-Rom from 5 bilinear taps (corner taps dropped, weights renormalised).
vec4 taa_history(vec2 uv) {
  vec2 sp = uv * uOutSize;
  vec2 t1 = floor(sp - 0.5) + 0.5;
  vec2 f = sp - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 inv = 1.0 / uOutSize;
  vec2 t12 = (t1 + w2 / w12) * inv;
  vec2 t0 = (t1 - 1.0) * inv;
  vec2 t3 = (t1 + 2.0) * inv;
  float wa = w12.x * w0.y;
  float wb = w0.x * w12.y;
  float wc = w12.x * w12.y;
  float wd = w3.x * w12.y;
  float we = w12.x * w3.y;
  vec4 s = textureLod(uHistory, vec2(t12.x, t0.y), 0.0) * wa
         + textureLod(uHistory, vec2(t0.x, t12.y), 0.0) * wb
         + textureLod(uHistory, t12, 0.0) * wc
         + textureLod(uHistory, vec2(t3.x, t12.y), 0.0) * wd
         + textureLod(uHistory, vec2(t12.x, t3.y), 0.0) * we;
  return s / (wa + wb + wc + wd + we);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uOutSize;
  vec2 p = uv * uRtSize;               // output pixel centre in scene px
  vec2 toOut = uOutSize / uRtSize;     // output px per scene px
  ivec2 hiI = ivec2(uRtSize) - 1;
  ivec2 b = ivec2(floor(p - uJitter)); // scene sample nearest to p (its centre is k + 0.5 + J)

  // ---- current frame: 3x3 reconstruction + neighbourhood statistics + closest depth ----
  vec3 sumN = vec3(0.0);
  vec3 sumW = vec3(0.0);
  float wN = 0.0;
  float wW = 0.0;
  vec3 m1 = vec3(0.0);
  vec3 m2 = vec3(0.0);
  vec3 lo = vec3(1e30);
  vec3 hi = vec3(-1e30);
  float dmin = 1.0;
  vec3 sumNL = vec3(0.0);
  vec3 sumWL = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      ivec2 k = clamp(b + ivec2(i, j), ivec2(0), hiI);
      vec3 c = texelFetch(uCurrent, k, 0).rgb;
      c = taa_bad(vec4(c, 0.0)) ? vec3(0.0) : clamp(c, 0.0, TAA_MAX_LIN);
      vec3 e = c / (1.0 + taa_max3(c));
      vec2 d = vec2(k) + 0.5 + uJitter - p;
      vec2 dO = d * toOut;
      float wn = exp(-dot(dO, dO) * uAccum.x);
      float ww = exp(-2.29 * dot(d, d));
      sumN += e * wn;
      sumNL += c * wn;
      wN += wn;
      sumW += e * ww;
      sumWL += c * ww;
      wW += ww;
      vec3 y = taa_ycocg(e);
      m1 += y;
      m2 += y * y;
      lo = min(lo, y);
      hi = max(hi, y);
      dmin = min(dmin, texelFetch(uCurrentDepth, k, 0).r);
    }
  }
  dmin = taa_bad(vec4(dmin)) ? 1.0 : clamp(dmin, 0.0, 1.0);

  // ---- reprojection (camera at the origin in both frames) ----
  vec3 ray = vec3((uv * 2.0 - 1.0) * uTanHalf, -1.0); // current view space, z = -1
  vec3 vp;
  float dExp = 1.0;
  if (dmin >= TAA_INF_DEPTH) {
    vp = uCurToPrev * ray;                            // direction only
  } else {
    vec3 P = ray * taa_viewZ(dmin);                   // current view-space position (ly)
    vec3 q = P - uRefSphere.xyz;
    vp = dot(q, q) < uRefSphere.w ? uRefCurToPrev * P + uRefOffset : uCurToPrev * P + uWorldOffset;
    dExp = logDepth(-vp.z);
  }
  float pz = -vp.z;
  vec2 uvPrev = (vp.xy / max(pz, 1e-30)) / uPrevTanHalf * 0.5 + 0.5;
  bool valid = uAccum.w > 0.5 && pz > 0.0 && !taa_bad(vec4(uvPrev, 0.0, 0.0))
    && all(greaterThanEqual(uvPrev, vec2(0.0))) && all(lessThanEqual(uvPrev, vec2(1.0)));
  float motion = valid ? length((uvPrev - uv) * uOutSize) : 0.0;

  // ---- history ----
  vec4 hist = vec4(0.0);
  float H = 0.0;
  if (valid) {
    hist = taa_history(uvPrev);
    if (taa_bad(hist)) hist = vec4(0.0);
    else H = clamp(hist.a, 0.0, 2.0 * uAccum.y);
    if (uReject.x > 0.0) {
      // Something clearly in front of the expected surface last frame → disoccluded.
      // Farthest depth of the 2x2 footprint: no false rejections along edges from filtering.
      ivec2 hmax = ivec2(uOutSize) - 1;
      ivec2 h0 = ivec2(floor(uvPrev * uOutSize - 0.5));
      float s0 = texelFetch(uHistoryDepth, clamp(h0, ivec2(0), hmax), 0).r;
      float s1 = texelFetch(uHistoryDepth, clamp(h0 + ivec2(1, 0), ivec2(0), hmax), 0).r;
      float s2 = texelFetch(uHistoryDepth, clamp(h0 + ivec2(0, 1), ivec2(0), hmax), 0).r;
      float s3 = texelFetch(uHistoryDepth, clamp(h0 + ivec2(1, 1), ivec2(0), hmax), 0).r;
      float dS = max(max(s0, s1), max(s2, s3));
      H *= 1.0 - clamp((dExp - dS - uReject.x) / uReject.x, 0.0, 1.0);
    }
    // Still camera: let the history grow to 2·Hmax; moving: cap it (less resampling blur).
    H = min(H, uAccum.y * (2.0 - clamp(motion * 4.0, 0.0, 1.0)) / (1.0 + motion * uReject.y));
  }

  // ---- variance clipping in YCoCg (tonemapped space) ----
  vec3 mu = m1 * (1.0 / 9.0);
  vec3 sd = sqrt(max(m2 * (1.0 / 9.0) - mu * mu, 0.0));
  float g = mix(uReject.z, uReject.w, smoothstep(0.5, 8.0, motion));
  vec3 bmin = max(mu - g * sd, lo);
  vec3 bmax = min(mu + g * sd, hi);
  vec3 hc = max(hist.rgb, 0.0);
  vec3 hy = taa_ycocg(hc / (1.0 + taa_max3(hc)));
  vec3 cen = 0.5 * (bmax + bmin);
  vec3 ext = max(0.5 * (bmax - bmin), vec3(1e-6));
  vec3 off = hy - cen;
  vec3 a = abs(off) / ext;
  float m = max(a.x, max(a.y, a.z));
  if (m > 1.0) hy = cen + off / m;
  vec3 hEnc = clamp(taa_rgb(hy), 0.0, 1.0 - 1.0 / TAA_MAX_LIN);

  // ---- accumulate (running weighted mean in tonemapped space) ----
  // Spatial reconstruction of this frame's estimate: averaging the 3x3 in the tonemapped space
  // (uSpatialLinear = 0) crushes steep HDR peaks (a star core averaged with its darker neighbours
  // loses up to ~50 % of its energy); averaging linearly and encoding the result (= 1) keeps their
  // brightness and costs only some extra flicker on HDR fireflies. The temporal blend and the clip
  // stay in the tonemapped space either way (fireflies cannot ghost).
  float prior = uAccum.z;
  vec3 nLin = sumNL / max(wN, 1e-6);
  vec3 wLin = sumWL / max(wW, 1e-6);
  vec3 curE = mix(sumN / max(wN, 1e-6), nLin / (1.0 + taa_max3(nLin)), uSpatialLinear);
  vec3 wide = mix(sumW / max(wW, 1e-6), wLin / (1.0 + taa_max3(wLin)), uSpatialLinear);
  vec3 o = (hEnc * H + curE * wN + wide * prior) / (H + wN + prior);
  float Hn = min(H + wN + prior, 2.0 * uAccum.y);
  vec3 lin = min(o / max(1.0 - taa_max3(o), 1.0 / TAA_MAX_LIN), vec3(TAA_MAX_LIN));
  if (taa_bad(vec4(lin, Hn))) {
    lin = vec3(0.0);
    Hn = 0.0;
  }
  gl_FragColor = vec4(max(lin, 0.0), Hn);
  taa_depthOut = vec4(dmin, 0.0, 0.0, 1.0);
}
`;

/** Halton(2,3) jitter table, 16 phases, in −0.5..0.5 (index 1..16: skips the (0,0) sample). */
export const TAA_JITTER_PHASES = 16;
const HALTON = (() => {
  const halton = (i: number, base: number) => {
    let f = 1;
    let r = 0;
    while (i > 0) {
      f /= base;
      r += f * (i % base);
      i = Math.floor(i / base);
    }
    return r;
  };
  const t = new Float32Array(TAA_JITTER_PHASES * 2);
  for (let i = 0; i < TAA_JITTER_PHASES; i++) {
    t[i * 2] = halton(i + 1, 2) - 0.5;
    t[i * 2 + 1] = halton(i + 1, 3) - 0.5;
  }
  return t;
})();

/** Sub-pixel jitter for frame `index` (scene-RT px, each component in −0.5..0.5). */
export function taaJitter(index: number, out: THREE.Vector2): THREE.Vector2 {
  const i = ((Math.floor(index) % TAA_JITTER_PHASES) + TAA_JITTER_PHASES) % TAA_JITTER_PHASES;
  return out.set(HALTON[i * 2], HALTON[i * 2 + 1]);
}

/** Everything the resolve needs about the current frame (all references, nothing copied). */
export interface TaaFrame {
  /** Scene target: colour + depthTexture (log depth). */
  scene: THREE.WebGLRenderTarget;
  rtW: number;
  rtH: number;
  /** Current camera local→world rotation (incl. shake). */
  camQuat: THREE.Quaternion;
  /** (tan(fovY/2)·aspect, tan(fovY/2)) */
  tanHalf: THREE.Vector2;
  /** Jitter used by this frame's scene passes (scene px). */
  jitter: THREE.Vector2;
  /** Ship world position (doubles). */
  shipPos: THREE.Vector3;
  nebulae: readonly NebulaRuntime[];
  /** Largest plausible camera travel since the last frame (ly); farther = teleport → reset. */
  maxTravel: number;
}

const NEB_STRIDE = 7; // pos xyz, quat xyzw

function quatToMat3(q: THREE.Quaternion, m: THREE.Matrix3): THREE.Matrix3 {
  const { x, y, z, w } = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return m.set(
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
  );
}

const finiteV3 = (v: THREE.Vector3) => Number.isFinite(v.x + v.y + v.z);
const finiteQ = (q: THREE.Quaternion) => Number.isFinite(q.x + q.y + q.z + q.w) && q.lengthSq() > 1e-12;

function makeHistoryTarget(w: number, h: number): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: THREE.LinearSRGBColorSpace,
    count: 2,
  });
  // Attachment 1: dilated log depth (R16F, read with texelFetch).
  const d = rt.textures[1];
  d.format = THREE.RedFormat;
  d.minFilter = THREE.NearestFilter;
  d.magFilter = THREE.NearestFilter;
  return rt;
}

export class TaaPass {
  /** Steady-state history feedback at native resolution and when upsampling ×2 or more. */
  feedback = 0.9;
  upsampleFeedback = 0.93;
  /** Weight of the smooth (wide-kernel) prior: the look of pixels without history. */
  prior = 0.1;
  /** Relative view-Z tolerance of the depth disocclusion test (≤ 0 disables it). */
  depthTolerance = 0.25;
  /** History weight halves at this many output px of motion per frame. */
  motionHalfPx = 25;
  /** Variance-clip box size (σ multiples) for a still and a fast-moving pixel. */
  gammaStill = 1.25;
  gammaMoving = 0.9;
  /**
   * 0..1: how this frame's 3x3 reconstruction is averaged. 1 = linearly (energy-preserving: star
   * cores and HDR highlights keep their brightness), 0 = in the tonemapped space (strongest
   * suppression of HDR fireflies, but bright peaks lose up to ~50 % energy). Console A/B:
   * `__app.renderer.taa.spatialLinear = 0`.
   */
  spatialLinear = 1;

  private readonly pass: FullscreenPass;
  private readonly hist: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private cur = 0;
  private outW = 1;
  private outH = 1;
  /** History holds a resolved frame whose camera state is in prev*. */
  private valid = false;

  private readonly prevQuat = new THREE.Quaternion();
  private readonly prevTanHalf = new THREE.Vector2(1, 1);
  private readonly prevShip = new THREE.Vector3();
  private nebPrev = new Float64Array(0);
  private nebPrevOk = new Uint8Array(0);

  // scratch
  private readonly qInvPrev = new THREE.Quaternion();
  private readonly qInvCur = new THREE.Quaternion();
  private readonly qA = new THREE.Quaternion();
  private readonly qB = new THREE.Quaternion();
  private readonly qNebPrev = new THREE.Quaternion();
  private readonly vA = new THREE.Vector3();
  private readonly vB = new THREE.Vector3();
  private readonly logRange = Math.log2(1 + TUNING.depthFar / TUNING.depthNear);

  constructor() {
    this.hist = [makeHistoryTarget(1, 1), makeHistoryTarget(1, 1)];
    const mat = postMaterial('post:taa', TAA_FRAG, {
      uCurrent: { value: null },
      uCurrentDepth: { value: null },
      uHistory: { value: null },
      uHistoryDepth: { value: null },
      uRtSize: { value: new THREE.Vector2(1, 1) },
      uOutSize: { value: new THREE.Vector2(1, 1) },
      uJitter: { value: new THREE.Vector2() },
      uTanHalf: { value: new THREE.Vector2(1, 1) },
      uPrevTanHalf: { value: new THREE.Vector2(1, 1) },
      uCurToPrev: { value: new THREE.Matrix3() },
      uWorldOffset: { value: new THREE.Vector3() },
      uRefCurToPrev: { value: new THREE.Matrix3() },
      uRefOffset: { value: new THREE.Vector3() },
      uRefSphere: { value: new THREE.Vector4(0, 0, 0, -1) },
      uAccum: { value: new THREE.Vector4(2.26, 12, 0.1, 0) },
      uReject: { value: new THREE.Vector4(0, 0.04, 1.25, 0.9) },
      uSpatialLinear: { value: 1 },
    });
    this.pass = new FullscreenPass(mat);
  }

  /** The resolved image of the last render() (linear HDR at output resolution). */
  get texture(): THREE.Texture {
    return this.hist[this.cur].textures[0];
  }

  /** History size = output size. Reallocates (and resets) only when it changes. */
  setSize(outW: number, outH: number): void {
    const w = Math.max(1, Math.floor(outW));
    const h = Math.max(1, Math.floor(outH));
    if (w === this.outW && h === this.outH) return;
    this.outW = w;
    this.outH = h;
    this.hist[0].setSize(w, h);
    this.hist[1].setSize(w, h);
    this.valid = false;
  }

  /** Forget the history (teleport, hidden scene, context restore, TAA toggled…). */
  invalidate(): void {
    this.valid = false;
  }

  /** Resolve this frame. Returns the resolved texture (valid until the next render()). */
  render(renderer: THREE.WebGLRenderer, f: TaaFrame): THREE.Texture {
    const u = this.pass.material.uniforms;
    const depthTex = f.scene.depthTexture;
    let reset = !this.valid || !depthTex;

    const camQ = f.camQuat;
    const S = f.shipPos;
    if (!finiteQ(camQ) || !finiteV3(S)) reset = true;

    // ---- world-static frame: R_p^T R_c and R_p^T (S_c − S_p) ----
    this.qInvPrev.copy(this.prevQuat).invert();
    this.qInvCur.copy(camQ).invert();
    quatToMat3(this.qA.copy(this.qInvPrev).multiply(camQ), u.uCurToPrev.value as THREE.Matrix3);
    const dWorld = this.vA.subVectors(S, this.prevShip);
    const travelWorld = dWorld.length();
    (u.uWorldOffset.value as THREE.Vector3).copy(dWorld.applyQuaternion(this.qInvPrev));

    // ---- reference frame: the nebula whose render sphere is nearest (contains the ship) ----
    this.ensureNebCapacity(f.nebulae);
    let ref: NebulaRuntime | null = null;
    let best = Infinity;
    for (let i = 0; i < f.nebulae.length; i++) {
      const n = f.nebulae[i];
      const idx = n.index;
      if (idx < 0 || this.nebPrevOk[idx] !== 1) continue;
      if (!finiteV3(n.position) || !finiteQ(n.rotation) || !(n.renderRadiusWorld > 0)) continue;
      const d = Math.hypot(n.position.x - S.x, n.position.y - S.y, n.position.z - S.z) - n.renderRadiusWorld;
      if (d < best) {
        best = d;
        ref = n;
      }
    }
    const sphere = u.uRefSphere.value as THREE.Vector4;
    let travelRef = Infinity;
    if (ref) {
      const o = ref.index * NEB_STRIDE;
      const np = this.nebPrev;
      const qNp = this.qNebPrev.set(np[o + 3], np[o + 4], np[o + 5], np[o + 6]);
      // Q = nebRot_prev · nebRot_cur⁻¹ (maps a nebula-static point's current world offset to its previous one)
      const Q = this.qB.copy(ref.rotation).invert().premultiply(qNp);
      quatToMat3(this.qA.copy(this.qInvPrev).multiply(Q).multiply(camQ), u.uRefCurToPrev.value as THREE.Matrix3);
      // t = (nebPos_prev − S_p) + Q (S_c − nebPos_cur)   [doubles]
      const t = this.vB.subVectors(S, ref.position).applyQuaternion(Q);
      t.x += np[o] - this.prevShip.x;
      t.y += np[o + 1] - this.prevShip.y;
      t.z += np[o + 2] - this.prevShip.z;
      travelRef = t.length();
      (u.uRefOffset.value as THREE.Vector3).copy(t.applyQuaternion(this.qInvPrev));
      const c = this.vB.subVectors(ref.position, S).applyQuaternion(this.qInvCur);
      const r = ref.renderRadiusWorld * 1.02;
      sphere.set(c.x, c.y, c.z, r * r);
      if (!Number.isFinite(c.x + c.y + c.z + sphere.w)) sphere.set(0, 0, 0, -1);
    } else {
      sphere.set(0, 0, 0, -1);
    }

    // Teleport: the camera moved farther than any real motion could explain in either frame.
    if (!(Math.min(travelWorld, travelRef) <= Math.max(f.maxTravel, 0))) reset = true;
    if (!this.uniformsFinite(u)) reset = true;

    // ---- accumulation parameters ----
    const rtW = Math.max(1, f.rtW);
    const rtH = Math.max(1, f.rtH);
    const ux = this.outW / rtW;
    const uy = this.outH / rtH;
    const up = Math.sqrt(Math.max(1, ux * uy));
    const sigma = 0.47 + 0.18 * (up - 1); // narrow kernel σ in output px
    const wBar = (2 * Math.PI * sigma * sigma) / Math.max(1, ux * uy); // mean Σ w_narrow per frame
    const fb = THREE.MathUtils.clamp(
      THREE.MathUtils.lerp(this.feedback, this.upsampleFeedback, THREE.MathUtils.clamp(up - 1, 0, 1)),
      0.5,
      0.99,
    );
    const alpha = 1 - fb;
    const prior = Math.max(1e-3, this.prior);
    const hMax = ((wBar + prior) * (1 - alpha)) / alpha;
    (u.uAccum.value as THREE.Vector4).set(1 / (2 * sigma * sigma), hMax, prior, reset ? 0 : 1);
    const thr = this.depthTolerance > 0 ? Math.log2(1 + this.depthTolerance) / this.logRange : 0;
    (u.uReject.value as THREE.Vector4).set(thr, 1 / Math.max(1, this.motionHalfPx), this.gammaStill, this.gammaMoving);
    u.uSpatialLinear.value = Number.isFinite(this.spatialLinear) ? THREE.MathUtils.clamp(this.spatialLinear, 0, 1) : 1;

    (u.uRtSize.value as THREE.Vector2).set(rtW, rtH);
    (u.uOutSize.value as THREE.Vector2).set(this.outW, this.outH);
    (u.uJitter.value as THREE.Vector2).copy(f.jitter);
    (u.uTanHalf.value as THREE.Vector2).copy(f.tanHalf);
    (u.uPrevTanHalf.value as THREE.Vector2).copy(reset ? f.tanHalf : this.prevTanHalf);
    if (reset) {
      (u.uCurToPrev.value as THREE.Matrix3).identity();
      (u.uRefCurToPrev.value as THREE.Matrix3).identity();
      (u.uWorldOffset.value as THREE.Vector3).set(0, 0, 0);
      (u.uRefOffset.value as THREE.Vector3).set(0, 0, 0);
      sphere.set(0, 0, 0, -1);
    }

    const src = this.hist[this.cur];
    const dst = this.hist[1 - this.cur];
    u.uCurrent.value = f.scene.texture;
    u.uCurrentDepth.value = depthTex;
    u.uHistory.value = src.textures[0];
    u.uHistoryDepth.value = src.textures[1];
    this.pass.render(renderer, dst);
    this.cur = 1 - this.cur;

    // ---- remember this frame ----
    if (finiteQ(camQ) && finiteV3(S)) {
      this.prevQuat.copy(camQ);
      this.prevTanHalf.copy(f.tanHalf);
      this.prevShip.copy(S);
      this.valid = !!depthTex;
    } else {
      this.valid = false;
    }
    const np = this.nebPrev;
    for (let i = 0; i < f.nebulae.length; i++) {
      const n = f.nebulae[i];
      const idx = n.index;
      if (idx < 0 || idx >= this.nebPrevOk.length) continue;
      const ok = finiteV3(n.position) && finiteQ(n.rotation);
      this.nebPrevOk[idx] = ok ? 1 : 0;
      if (!ok) continue;
      const o = idx * NEB_STRIDE;
      np[o] = n.position.x;
      np[o + 1] = n.position.y;
      np[o + 2] = n.position.z;
      np[o + 3] = n.rotation.x;
      np[o + 4] = n.rotation.y;
      np[o + 5] = n.rotation.z;
      np[o + 6] = n.rotation.w;
    }
    return this.hist[this.cur].textures[0];
  }

  compileObjects(): THREE.Object3D[] {
    return [this.pass.mesh];
  }

  /** Target to compile against (same attachment layout as the per-frame draw). */
  compileTarget(): THREE.WebGLRenderTarget {
    return this.hist[1 - this.cur];
  }

  /**
   * True if the resolve program failed to link (call after compiling or drawing it). The renderer
   * then falls back to the plain upscale instead of compositing an empty history.
   * three only fills `program.diagnostics` on the program's first use (first draw), which
   * compileAsync never triggers, so the link status is queried directly (non-blocking once
   * compileAsync has resolved).
   */
  programFailed(renderer: THREE.WebGLRenderer): boolean {
    const gl = renderer.getContext();
    if (gl.isContextLost()) return false;
    const props = renderer.properties.get(this.pass.material) as
      | { currentProgram?: { program?: WebGLProgram; diagnostics?: { runnable?: boolean } } }
      | undefined;
    const prog = props?.currentProgram;
    if (!prog) return false;
    if (prog.diagnostics && prog.diagnostics.runnable === false) return true;
    return !!prog.program && gl.getProgramParameter(prog.program, gl.LINK_STATUS) === false;
  }

  /**
   * Call once right after a render(): false if the two-attachment history target just drawn is
   * not a complete framebuffer on this device (e.g. R16F / RGBA16F not colour-renderable), in
   * which case nothing was drawn and the composite would show black.
   */
  targetComplete(renderer: THREE.WebGLRenderer): boolean {
    const gl = renderer.getContext();
    if (gl.isContextLost()) return true;
    renderer.setRenderTarget(this.hist[this.cur]);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  }

  dispose(): void {
    this.pass.dispose();
    this.hist[0].dispose();
    this.hist[1].dispose();
    this.valid = false;
  }

  private ensureNebCapacity(nebulae: readonly NebulaRuntime[]): void {
    let maxIdx = -1;
    for (let i = 0; i < nebulae.length; i++) maxIdx = Math.max(maxIdx, nebulae[i].index);
    const need = maxIdx + 1;
    if (need <= this.nebPrevOk.length) return;
    // Rare (catalog growth): reallocate, keeping what we know.
    const np = new Float64Array(need * NEB_STRIDE);
    np.set(this.nebPrev);
    const ok = new Uint8Array(need);
    ok.set(this.nebPrevOk);
    this.nebPrev = np;
    this.nebPrevOk = ok;
  }

  private uniformsFinite(u: Record<string, THREE.IUniform>): boolean {
    const a = (u.uCurToPrev.value as THREE.Matrix3).elements;
    const b = (u.uRefCurToPrev.value as THREE.Matrix3).elements;
    let s = 0;
    for (let i = 0; i < 9; i++) s += a[i] + b[i];
    const w = u.uWorldOffset.value as THREE.Vector3;
    const r = u.uRefOffset.value as THREE.Vector3;
    return Number.isFinite(s) && finiteV3(w) && finiteV3(r);
  }
}
