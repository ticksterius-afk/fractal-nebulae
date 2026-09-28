/**
 * Nebula material: the full-screen raymarch template that turns a distance-estimated fractal
 * into a glowing, dusty nebula (JWST "Pillars of Creation" look).
 *
 * Everything inside the shader is computed in nebula-LOCAL units, so the look is identical for a
 * nebula of any world size and stable at any zoom: emission/absorption are integrated per unit of
 * local length, the near-surface gas shell thickness follows the camera's local surface distance,
 * and the ray epsilon is cone-based (pixel angle × distance).
 *
 * Output is premultiplied (`vec4(emission + T·surface, 1 − T)`), blended ONE / ONE_MINUS_SRC_ALPHA.
 */
import * as THREE from 'three';
import type { FractalDef, NebulaRuntime, QualityPreset } from '../core/types';
import { clamp, lerp, smoothstep } from '../core/math';
import { COMMON_GLSL, CAMERA_UNIFORMS_GLSL } from './shaders/common';
import { FULLSCREEN_VERT, applyCameraUniforms, makeCameraUniforms, type RenderContext } from './RenderContext';

// ---------------------------------------------------------------------------------------------
// Look tuning (baked into the shader as #defines). All gains are dimensionless; lengths are
// relative to the fractal bound radius or to the adaptive glow length.
// ---------------------------------------------------------------------------------------------
export const NEBULA_LOOK = {
  /** Near-surface glowing gas: emission gain (integrates to ≈ gain × glowNear across the shell). */
  nearEmit: 0.018,
  /** Near-surface gas absorption: makes long grazing paths saturate instead of blowing out. */
  nearAbsorb: 0.1,
  /** Hot knots (trap.w) glowing in the gas right above the surface. */
  hotGas: 0.2,
  /** Hot knots (trap.w) emitting on the surface itself. */
  hotSurface: 0.55,
  /** Outer envelope emission gain (per render radius of path). */
  envEmit: 8.0,
  /** Envelope density far from the fractal structure (0..1); the rest hugs the structure. */
  envBase: 0.6,
  /** Length (× bound) over which the envelope concentrates around the fractal. */
  envHug: 0.55,
  /** Envelope noise frequency (noise periods per bound radius). */
  envFreq: 0.42,
  /** Dust-lane optical depth gain (per render radius of path). */
  dust: 2.4,
  /** Photo-ionised glow boost of the envelope near the key star, and its radius (× bound). */
  ionGain: 2.2,
  ionRadius: 0.55,
  /** Forward scattering of starlight by the envelope when looking toward the star. */
  scatter: 0.9,
  /** Fine drifting wisps near surfaces (scale-aware). */
  wispEmit: 0.05,
  wispAbsorb: 0.04,
  /** Wisp noise period in units of the glow length. */
  wispScale: 20,
  /** Surface lighting. */
  diffuse: 0.42,
  wrap: 0.45,
  lightFalloff: 0.9,
  rim: 1.6,
  ambient: 0.95,
  aoStrength: 1.35,
  shadowK: 9.0,
  /** Minimum light reaching shadowed dust (scattered light never fully vanishes). */
  shadowFloor: 0.22,
  /**
   * Shadow rays stop this far (× bound) short of the key star. Lights may sit inside the fractal
   * (a young star in a pillar tip) or on its surface; without a clearance the star's own cocoon
   * would shadow the entire nebula.
   */
  lightClearance: 0.1,
  /** Resonance pulse emission on surfaces, near-surface gas, and envelope gas. */
  pulseSurface: 2.6,
  pulseNear: 1.1,
  pulseEnv: 0.45,
  /** Glow length: fraction of the bound when far away, fraction of camera surface distance up close. */
  glowLenFar: 0.011,
  glowLenCam: 0.04,
  /** Firefly clamp on the pass output (linear HDR). */
  maxOut: 48,
  /** Static per-pixel jitter of the first step (0..0.9): trades gas banding for fine noise. */
  jitter: 0.9,
} as const;

/** Per-quality epsilon multiplier (larger = coarser, cheaper). */
const QUALITY_DETAIL: Record<QualityPreset['name'], number> = { low: 1.5, medium: 1.2, high: 1.0, ultra: 0.85 };
/**
 * Per-fractal epsilon multiplier for fractals whose sub-pixel detail is expensive to trace. The
 * Apollonian foam's countless tiny pearls cost ~25 % of its frame at 1.0 with no visible gain.
 */
const KIND_DETAIL: Partial<Record<FractalDef['kind'], number>> = { apollonian: 1.6 };
const SHADOW_STEPS: Record<QualityPreset['name'], number> = { low: 8, medium: 10, high: 11, ultra: 16 };
/** Log-smoothing time constant (s) of the camera distance that sets the glow-shell length. */
const GLOW_SMOOTH_TAU = 0.8;
/** Nebulae beyond this distance (ly) fade out entirely. */
const FADE_FAR_LY = 30000;

const f = (x: number): string => {
  const s = x.toPrecision(7);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};

// ---------------------------------------------------------------------------------------------
// Shared 3D noise texture (tileable, 2 channels, histogram-equalised gradient noise).
// Sampled with textureLod inside loops (no gradients → ANGLE/FXC-friendly, no forced unrolls).
// ---------------------------------------------------------------------------------------------
const NOISE_SIZE = 64;
const NOISE_PERIOD = 8;
let _noiseTex: THREE.Data3DTexture | null = null;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildNoiseChannel(seed: number): Float32Array {
  const P = NOISE_PERIOD;
  const N = NOISE_SIZE;
  const S = N / P; // texels per lattice cell
  const rnd = mulberry32(seed);
  const grads = new Float32Array(P * P * P * 3);
  for (let i = 0; i < P * P * P; i++) {
    // Uniform random unit vector.
    const z = rnd() * 2 - 1;
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    grads[i * 3] = r * Math.cos(a);
    grads[i * 3 + 1] = r * Math.sin(a);
    grads[i * 3 + 2] = z;
  }
  // Texel-centre offsets inside a cell and their quintic fade weights are the same for every cell.
  const fr = new Float32Array(S);
  const wt = new Float32Array(S);
  for (let k = 0; k < S; k++) {
    const t = (k + 0.5) / S;
    fr[k] = t;
    wt[k] = t * t * t * (t * (t * 6 - 15) + 10);
  }
  const out = new Float32Array(N * N * N);
  const g = new Float32Array(24); // 8 corner gradients of the current cell
  const yz = new Float32Array(8); // per-row partial dot products (y,z terms)
  for (let cz = 0; cz < P; cz++) {
    for (let cy = 0; cy < P; cy++) {
      for (let cx = 0; cx < P; cx++) {
        for (let c = 0; c < 8; c++) {
          const gi = (((cz + ((c >> 2) & 1)) % P) * P * P + ((cy + ((c >> 1) & 1)) % P) * P + ((cx + (c & 1)) % P)) * 3;
          g[c * 3] = grads[gi];
          g[c * 3 + 1] = grads[gi + 1];
          g[c * 3 + 2] = grads[gi + 2];
        }
        for (let kz = 0; kz < S; kz++) {
          const fz = fr[kz];
          const wz = wt[kz];
          for (let ky = 0; ky < S; ky++) {
            const fy = fr[ky];
            const wy = wt[ky];
            for (let c = 0; c < 8; c++) {
              const ry = fy - ((c >> 1) & 1);
              const rz = fz - ((c >> 2) & 1);
              yz[c] = g[c * 3 + 1] * ry + g[c * 3 + 2] * rz;
            }
            let idx = ((cz * S + kz) * N + (cy * S + ky)) * N + cx * S;
            for (let kx = 0; kx < S; kx++) {
              const fx = fr[kx];
              const fx1 = fx - 1;
              const wx = wt[kx];
              const n000 = g[0] * fx + yz[0];
              const n100 = g[3] * fx1 + yz[1];
              const n010 = g[6] * fx + yz[2];
              const n110 = g[9] * fx1 + yz[3];
              const n001 = g[12] * fx + yz[4];
              const n101 = g[15] * fx1 + yz[5];
              const n011 = g[18] * fx + yz[6];
              const n111 = g[21] * fx1 + yz[7];
              const x00 = n000 + (n100 - n000) * wx;
              const x10 = n010 + (n110 - n010) * wx;
              const x01 = n001 + (n101 - n001) * wx;
              const x11 = n011 + (n111 - n011) * wx;
              const y0 = x00 + (x10 - x00) * wy;
              const y1 = x01 + (x11 - x01) * wy;
              out[idx++] = y0 + (y1 - y0) * wz;
            }
          }
        }
      }
    }
  }
  // Histogram equalisation → values uniformly distributed in [0,1] (thresholds become quantiles).
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < out.length; i++) {
    if (out[i] < mn) mn = out[i];
    if (out[i] > mx) mx = out[i];
  }
  const BINS = 2048;
  const hist = new Float64Array(BINS + 1);
  const inv = BINS / Math.max(mx - mn, 1e-9);
  for (let i = 0; i < out.length; i++) hist[Math.min(BINS, Math.floor((out[i] - mn) * inv))]++;
  const cdf = new Float64Array(BINS + 1);
  let run = 0;
  for (let b = 0; b <= BINS; b++) {
    run += hist[b];
    cdf[b] = run / out.length;
  }
  for (let i = 0; i < out.length; i++) {
    const x = (out[i] - mn) * inv;
    const b = Math.min(BINS - 1, Math.floor(x));
    const fr = x - b;
    const lo = b > 0 ? cdf[b - 1] : 0;
    out[i] = lo + (cdf[b] - lo) * fr;
  }
  return out;
}

const NOISE_SEEDS = [0x9e3779b1, 0x85ebca6b] as const;
const _noiseChannels: (Float32Array | null)[] = [null, null];

function noiseChannel(i: 0 | 1): Float32Array {
  return (_noiseChannels[i] ??= buildNoiseChannel(NOISE_SEEDS[i]));
}

/** The shared RG8 3D noise texture used by every nebula material. */
export function getNebulaNoiseTexture(): THREE.Data3DTexture {
  if (_noiseTex) return _noiseTex;
  const a = noiseChannel(0);
  const b = noiseChannel(1);
  const n = NOISE_SIZE * NOISE_SIZE * NOISE_SIZE;
  const data = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    data[i * 2] = Math.round(clamp(a[i], 0, 1) * 255);
    data[i * 2 + 1] = Math.round(clamp(b[i], 0, 1) * 255);
  }
  _noiseChannels[0] = null;
  _noiseChannels[1] = null;
  const tex = new THREE.Data3DTexture(data, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
  tex.format = THREE.RGFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  _noiseTex = tex;
  return tex;
}

/**
 * Build the shared noise texture in slices, yielding to the browser in between (~50 ms each on
 * a cold JIT) so a loading screen stays responsive. Optional: materials build it on demand.
 */
export async function prepareNebulaShared(): Promise<void> {
  const pause = () => new Promise<void>((res) => setTimeout(res, 0));
  if (_noiseTex) return;
  noiseChannel(0);
  await pause();
  noiseChannel(1);
  await pause();
  getNebulaNoiseTexture();
}

/** Dispose resources shared by all nebula materials (call once on app teardown). */
export function disposeNebulaShared(): void {
  _noiseTex?.dispose();
  _noiseTex = null;
}

// ---------------------------------------------------------------------------------------------
// Shader source
// ---------------------------------------------------------------------------------------------
const L = NEBULA_LOOK;

const TEMPLATE_UNIFORMS_GLSL = /* glsl */ `
uniform vec4 uP[4];
uniform int uIter;
uniform mat3 uWorldToLocal;
uniform vec3 uCamLocal;
uniform float uScale;
uniform float uBound;
uniform float uRenderBound;
uniform int uSteps;
uniform float uDetail;
uniform vec3 uPalA;
uniform vec3 uPalB;
uniform vec3 uPalC;
uniform vec3 uPalD;
uniform vec3 uGlowNear;
uniform vec3 uGlowFar;
uniform vec3 uRim;
uniform vec3 uAmbient;
uniform vec3 uLightPos;
uniform vec3 uLightCol;
uniform float uFade;
uniform vec4 uPulse;
uniform vec2 uPulseParams;
uniform float uGasDensity;
// Ghost mode x-ray: solid structure a ray runs into within this radius (local units) of the
// camera — or starts inside — turns transparent until the ray is back in open space; 0 = off.
uniform float uGhostClip;
// Open space: clear by this fraction of the distance travelled inside (so the pits of a rough
// skin don't end the transparency); step growth / minimum step (× radius) while inside.
#define NEB_GHOST_OPEN 0.2
#define NEB_GHOST_GROWTH 0.1
#define NEB_GHOST_MINSTEP 0.05
// Glassy sheet where the ray leaves the solid: flat tint, rim at grazing angles, opacity.
#define NEB_GHOST_SHEET 0.025
#define NEB_GHOST_RIM 0.3
#define NEB_GHOST_SHEET_A 0.1
uniform float uGlowLen;
uniform vec3 uWisp;
uniform vec3 uWispOrigin;
uniform float uEnvSamples;
uniform float uSeed;
uniform sampler3D uNoise;

#define NEB_NEAR_EMIT ${f(L.nearEmit)}
#define NEB_NEAR_ABS ${f(L.nearAbsorb)}
#define NEB_HOT_GAS ${f(L.hotGas)}
#define NEB_HOT_SURF ${f(L.hotSurface)}
#define NEB_ENV_EMIT ${f(L.envEmit)}
#define NEB_ENV_BASE ${f(L.envBase)}
#define NEB_ENV_HUG ${f(L.envHug)}
#define NEB_ENV_FREQ ${f(L.envFreq)}
#define NEB_DUST ${f(L.dust)}
#define NEB_ION_GAIN ${f(L.ionGain)}
#define NEB_ION_R ${f(L.ionRadius)}
#define NEB_SCATTER ${f(L.scatter)}
#define NEB_WISP_EMIT ${f(L.wispEmit)}
#define NEB_WISP_ABS ${f(L.wispAbsorb)}
#define NEB_DIFFUSE ${f(L.diffuse)}
#define NEB_WRAP ${f(L.wrap)}
#define NEB_LIGHT_FALLOFF ${f(L.lightFalloff)}
#define NEB_RIM ${f(L.rim)}
#define NEB_AMBIENT ${f(L.ambient)}
#define NEB_AO_STRENGTH ${f(L.aoStrength)}
#define NEB_SHADOW_K ${f(L.shadowK)}
#define NEB_SHADOW_FLOOR ${f(L.shadowFloor)}
#define NEB_LIGHT_CLEAR ${f(L.lightClearance)}
#define NEB_PULSE_SURF ${f(L.pulseSurface)}
#define NEB_PULSE_NEAR ${f(L.pulseNear)}
#define NEB_PULSE_ENV ${f(L.pulseEnv)}
#define NEB_MAX_OUT ${f(L.maxOut)}
#define NEB_JITTER ${f(L.jitter)}
`;

const TEMPLATE_BODY_GLSL = /* glsl */ `
in vec2 vUv;

// The fractal DE is evaluated out to NEB_DE_SHELL × bound so the gas distance (neb_gasDist) can
// blend continuously into its analytic form outside; beyond it the bound-sphere distance is used.
#define NEB_DE_SHELL 1.2

// Distance to the scene in local units. Both terms are lower bounds of the true distance (the
// fractal lies inside its bound sphere), so their max is too — and never steps shorter than the
// analytic distance alone.
float neb_de(vec3 p, out vec4 trap) {
  float r = length(p);
  if (r > uBound * NEB_DE_SHELL) {
    trap = vec4(0.5, 0.0, 0.5, 0.0);
    return r - uBound;
  }
  return max(fractalDE(p, trap), r - uBound);
}

// Distance used for gas shading. Outside the bound the DE only measures the distance to the
// fractal loosely and would let the near-surface glow outline the (invisible) bound sphere, so it
// is inflated there — blended in across the DE shell, because a hard switch leaves a spherical
// step in the envelope density (the gas cavity around the structure ending abruptly).
float neb_gasDist(vec3 p, float d) {
  float dc = max(d, 0.0);
  float rb = length(p) / uBound;
  if (rb > 1.0) {
    float dOut = (3.0 * (rb - 1.0) + 0.15) * uBound;
    dc = mix(dc, max(dc, dOut), smoothstep(1.0, NEB_DE_SHELL, rb));
  }
  return dc;
}

// Tetrahedral normal. The loop (with a non-constant start) keeps the compiler from inlining the
// DE four times — important for ANGLE's GLSL→HLSL→DXBC compile times.
vec3 neb_normal(vec3 p, float h, int zero) {
  vec3 n = vec3(0.0);
  for (int i = zero; i < 4; i++) {
    vec3 e = 0.5773 * (2.0 * vec3(float(((i + 3) >> 1) & 1), float((i >> 1) & 1), float(i & 1)) - 1.0);
    vec4 tr;
    n += e * neb_de(p + e * h, tr);
  }
  float l = length(n);
  return l > 1e-20 ? n / l : normalize(p + vec3(1e-7));
}

#if AO_SAMPLES > 0
float neb_ao(vec3 p, vec3 n, float s, int zero) {
  float occ = 0.0;
  float wsum = 0.0;
  float w = 1.0;
  for (int i = zero; i < AO_SAMPLES; i++) {
    float h = s * (0.12 + 0.88 * float(i + 1) / float(AO_SAMPLES));
    vec4 tr;
    float dd = neb_de(p + n * h, tr);
    occ += w * clamp((h - dd) / h, 0.0, 1.0);
    wsum += w;
    w *= 0.72;
  }
  return clamp(1.0 - NEB_AO_STRENGTH * occ / wsum, 0.0, 1.0);
}
#endif

#ifdef SHADOWS
// Soft shadow toward the key star (penumbra ratio h/t is scale-free).
float neb_shadow(vec3 ro, vec3 rd, float tmin, float tmax, int zero) {
  float res = 1.0;
  float t = tmin;
  float maxStep = 0.2 * uBound;
  float bb = uBound * uBound * 1.21;
  for (int i = zero; i < SHADOW_STEPS; i++) {
    vec3 p = ro + rd * t;
    vec4 tr;
    float h = neb_de(p, tr);
    if (h < tmin * 0.2) return 0.0;
    res = min(res, NEB_SHADOW_K * h / t);
    if (res < 0.01) break;
    t += clamp(h, tmin, maxStep);
    if (t >= tmax) break;
    if (dot(p, p) > bb && dot(p, rd) > 0.0) break; // left the fractal: nothing else can occlude
  }
  res = clamp(res, 0.0, 1.0);
  return res * res * (3.0 - 2.0 * res);
}
#endif

// Participating media at p (local), EXCLUDING the near-surface glow (integrated analytically per
// segment in neb_segment). Outputs emission and absorption per unit LOCAL length, the near-glow
// photo-ionisation gain at p, and a normalised gas measure used by the resonance pulse.
void neb_media(vec3 p, vec3 rd, float d, out vec3 emit, out float sigma, out float glowGain, out float gasN) {
  float dpos = max(d, 0.0);
  float invL = 1.0 / uGlowLen;
  float dn = dpos * invL;
  emit = vec3(0.0);
  sigma = 0.0;
  float g = max(1.0 - 0.25 * dn, 0.0);
  gasN = g * g * g;

  vec3 toL = uLightPos - p;
  float dl2 = dot(toL, toL);
  float invB2 = 1.0 / (uBound * uBound);
  float prox = 1.0 / (1.0 + dl2 * invB2 * NEB_LIGHT_FALLOFF);
  glowGain = 0.35 + 1.3 * prox;

  // Fine wisps hugging surfaces: two noise octaves anchored in local space, cross-faded by scale
  // (uWisp.z) so they never swim while the viewing scale changes.
  if (dn < 6.0) {
    vec3 drift = vec3(0.021, -0.013, 0.017) * uTime + uSeed;
    vec3 q = p - uWispOrigin;
    float w0 = textureLod(uNoise, q / uWisp.x + drift, 0.0).g;
    float w1 = textureLod(uNoise, q / uWisp.y + drift, 0.0).g;
    float wn = mix(w0, w1, uWisp.z);
    float ridge = 1.0 - abs(2.0 * wn - 1.0); // thin gauzy sheets along the noise mid-level
    float wisp = smoothstep(0.86, 0.98, ridge) * max(exp(-0.7 * dn) - 0.015, 0.0) * invL;
    emit += mix(uGlowNear, uGlowFar, 0.55) * (wisp * NEB_WISP_EMIT);
    sigma += wisp * NEB_WISP_ABS * uGasDensity;
  }

  // Outer envelope: diffuse + filamentary drifting gas and dark dust lanes around the structure.
  // Stellar winds carve a cavity: little gas right at the surfaces, most a little way out, so the
  // cloud is limb-brightened and never veils the structure (or clogs crevices when zoomed in).
  // The outer edge is noise-perturbed so the cloud never reads as a sphere.
  float rN = length(p) / uRenderBound;
  vec3 q = p * (NEB_ENV_FREQ / uBound);
  vec3 drift = vec3(0.0041, 0.0023, -0.0031) * uTime + uSeed * 0.37;
  vec2 n1 = textureLod(uNoise, q + drift, 0.0).rg;
  // Large-scale, per-nebula noise warps the outline so the cloud reads as an irregular nebula,
  // never as a sphere; the finer n1 term adds lumpy detail to the edge.
  vec3 sq = p * (0.16 / uBound) + vec3(uSeed * 0.071, uSeed * 0.113, -uSeed * 0.057);
  float shapeN = textureLod(uNoise, sq, 0.0).r * 0.65 + textureLod(uNoise, sq * 2.1 + 0.31, 0.0).g * 0.35;
  float rn = rN + (shapeN - 0.5) * 1.15 + (n1.x - 0.5) * 0.3;
  // The noise can push gas out to the render sphere; the second factor takes it to exactly zero
  // there so the pass never shows a faint circular edge against the sky.
  float radial = (1.0 - smoothstep(0.25, 0.95, rn)) * (1.0 - smoothstep(0.88, 1.0, rN));
  if (radial > 0.0) {
    radial *= radial;
    float n2 = textureLod(uNoise, q * 2.63 - drift * 1.7 + 0.37, 0.0).r;
    float fb = n1.x * 0.62 + n2 * 0.38;
    float ridge = 1.0 - abs(2.0 * fb - 1.0);
    float gas = 0.4 * smoothstep(0.35, 0.85, fb) + 0.6 * smoothstep(0.55, 0.96, ridge);
    float db = dpos / uBound;
    float structure = exp(-db / NEB_ENV_HUG);
    float cavity = smoothstep(0.08, 0.45, db);
    float invR = 1.0 / uRenderBound;
    float envD = radial * cavity * (NEB_ENV_BASE + (1.0 - NEB_ENV_BASE) * structure) * gas;

    float ion = exp(-dl2 * invB2 / (NEB_ION_R * NEB_ION_R));
    float cosL = dot(rd, toL) * inversesqrt(dl2 + 1e-12);
    float fwd = pow(max(cosL, 0.0), 8.0);
    vec3 lightTint = uLightCol / max(max(uLightCol.r, max(uLightCol.g, uLightCol.b)), 1e-4);
    // Warm (glowNear-tinted) gas close to the structure, cool glowFar further out.
    vec3 envCol = mix(uGlowFar, uGlowNear * 0.35, 0.25 * structure * structure) * (1.0 + NEB_ION_GAIN * ion)
                + lightTint * (NEB_SCATTER * fwd * (0.25 + ion));
    emit += envCol * (envD * NEB_ENV_EMIT * invR);

    // Dust lanes: thin ridges of a second noise channel, strongest around the structure.
    float lane = 1.0 - abs(2.0 * n1.y - 1.0);
    float dust = radial * (0.25 + 0.75 * structure) * smoothstep(0.72, 0.96, lane);
    sigma += dust * NEB_DUST * invR * uGasDensity;
    gasN += envD * 0.6;
  }
}

// Integrate one march segment of length dt whose surface distance goes d0 → d1. The near-surface
// glow has the compact profile g(d) = (1 − d/S)³₊ with S = 4L (normalised: ∫g dd / L = 1), hot
// knots use S = 2L. Both are integrated in closed form assuming d varies linearly along the
// segment (exact for head-on and planar approaches → stable for any step length); the other media
// are constant per segment. glowGain scales the near glow (photo-ionisation by the key star).
// Energy-conserving emission/absorption update of (C, T).
void neb_segment(float d0, float d1, float dt, vec3 emitO, float sigmaO, vec4 trap, float glowGain,
                 inout vec3 C, inout float T) {
  float invL = 1.0 / uGlowLen;
  float g0 = max(1.0 - 0.25 * d0 * invL, 0.0);
  float g1 = max(1.0 - 0.25 * d1 * invL, 0.0);
  float h0 = max(1.0 - 0.5 * d0 * invL, 0.0);
  float h1 = max(1.0 - 0.5 * d1 * invL, 0.0);
  float dd = d1 - d0;
  float iNear, iHot;
  if (abs(dd) > 1e-3 * uGlowLen) {
    float k = dt / dd;
    float g02 = g0 * g0, g12 = g1 * g1, h02 = h0 * h0, h12 = h1 * h1;
    iNear = k * (g02 * g02 - g12 * g12);
    iHot = 0.5 * k * (h02 * h02 - h12 * h12);
  } else {
    iNear = dt * g0 * g0 * g0 * invL;
    iHot = dt * h0 * h0 * h0 * invL;
  }
  vec3 nearCol = uGlowNear * (mix(0.3, 1.0, clamp(trap.z, 0.0, 1.0)) * glowGain);
  vec3 E = emitO * dt + nearCol * (iNear * NEB_NEAR_EMIT) + uGlowNear * (iHot * clamp(trap.w, 0.0, 1.0) * NEB_HOT_GAS);
  float tau = sigmaO * dt + iNear * NEB_NEAR_ABS * uGasDensity;
  float Ts = exp(-tau);
  C += T * E * (tau > 1e-5 ? (1.0 - Ts) / tau : 1.0);
  T *= Ts;
}

vec3 neb_shade(vec3 p, vec3 n, vec3 rd, vec4 trap, float t, float eps, int zero) {
#ifdef FRACTAL_HAS_ALBEDO
  vec3 alb = fractalAlbedo(p, trap, n, uPalA, uPalB, uPalC, uPalD);
#else
  vec3 alb = cosPalette(trap.x + 0.12 * trap.z, uPalA, uPalB, uPalC, uPalD);
#endif
  alb = clamp(alb, 0.0, 1.0);

  float ao = 1.0 - 0.6 * clamp(trap.y, 0.0, 1.0);
#if AO_SAMPLES > 0
  float aoScale = min(max(t * 0.05, eps * 6.0), uBound * 0.15); // clamp() is undefined if lo > hi
  ao *= neb_ao(p, n, aoScale, zero);
#endif

  vec3 toL = uLightPos - p;
  float dl2 = dot(toL, toL);
  float dl = sqrt(dl2);
  vec3 l = toL / max(dl, 1e-9);
  float atten = 1.0 / (1.0 + dl2 * NEB_LIGHT_FALLOFF / (uBound * uBound));
  float ndl = dot(n, l);
  float wrapD = clamp((ndl + NEB_WRAP) / (1.0 + NEB_WRAP), 0.0, 1.0);
  float sh = 1.0;
#ifdef SHADOWS
  float shadowLen = dl - NEB_LIGHT_CLEAR * uBound;
  if (ndl > -NEB_WRAP && shadowLen > eps * 8.0) sh = neb_shadow(p + n * (eps * 2.0), l, eps * 4.0, shadowLen, zero);
#endif
  vec3 lc = uLightCol * atten;
  vec3 col = alb * lc * (wrapD * mix(NEB_SHADOW_FLOOR, 1.0, sh) * NEB_DIFFUSE);

  // Luminous rim: silhouette edges glow, most strongly when back-lit (the JWST pillar edges) and
  // on star-facing ionisation fronts.
  float vdl = dot(rd, l);
  float fwd = pow(clamp(vdl, 0.0, 1.0), 6.0);
  float rimF = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
  col += uRim * (rimF * (0.22 + 1.6 * fwd + 0.6 * max(ndl, 0.0) * sh) * atten * NEB_RIM * (0.4 + 0.6 * ao));

  // Dusty forward scatter: thin dust glows faintly when the star is behind it.
  col += alb * lc * (fwd * 0.18 * (1.0 - 0.5 * sh) * ao);

  // Nebular ambient + light bounced from the surrounding glowing gas.
  float outward = 0.65 + 0.35 * dot(n, p / max(length(p), 1e-9));
  col += (uAmbient * outward + uGlowNear * 0.05 + uGlowFar * 0.12) * alb * (ao * NEB_AMBIENT);

  // Hot knots: star-forming tips.
  col += uGlowNear * (smoothstep(0.08, 0.9, clamp(trap.w, 0.0, 1.0)) * NEB_HOT_SURF);
  return col;
}

vec3 neb_pulseColor() {
  vec3 g = uGlowNear / max(max(uGlowNear.r, max(uGlowNear.g, uGlowNear.b)), 1e-4);
  return mix(vec3(0.75, 0.97, 1.3), g * 1.2, 0.3);
}

float neb_ign(vec2 fc) {
  return fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715))));
}

void main() {
  vec3 rdW = cameraRay(gl_FragCoord.xy + uJitter, uResolution, uCamRot, uTanHalf);
  vec3 rd = normalize(uWorldToLocal * rdW);
  vec3 ro = uCamLocal;

  vec2 seg = sphereIntersect(ro, rd, uRenderBound);
  if (seg.y <= 0.0 || seg.x >= seg.y) discard;
  float t0 = max(seg.x, 0.0);
  float t1 = seg.y;
  float envStep = (t1 - t0) / max(uEnvSamples, 1.0);
  float pixA = uPixelAngle * uDetail;
  // Animated with the TAA jitter phase so the accumulated history averages the gas sampling
  // (identical to a static pattern when TAA is off and uJitter is zero).
  float jitter = fract(neb_ign(gl_FragCoord.xy) + uJitter.x);
  int zero = min(uIter, 0);

  bool pulseOn = uPulseParams.y > 0.0;
  vec3 pulseCol = neb_pulseColor();

  float T = 1.0;
  vec3 C = vec3(0.0);
  float t = t0;
  float tHalf = -1.0;
  bool hit = false;
  bool exhausted = true;
  vec4 trap = vec4(0.0);
  float d = 1e10;
  float eps = 1e-6;

  // Pending segment [t - segDt, t]: media sampled at its start, closed once d at its end is known.
  float segDt = 0.0;
  float segD0 = 0.0;
  vec3 segEmit = vec3(0.0);
  float segSigma = 0.0;
  vec4 segTrap = vec4(0.0);
  float segGain = 1.0;
  bool ghostRun = false; // ghost x-ray: inside solid structure that is being seen through
  float ghostT0 = 0.0;   // where that run began
  float ghostTOut = -1.0; // first sample back outside after the run's last inside sample
  float ghostDOut = 0.0;
  vec4 ghostTrap = vec4(0.0);

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= uSteps) break;
    if (t > t1) { exhausted = false; break; }
    vec3 p = ro + rd * t;
    eps = max(t * pixA, 1e-6);
    d = neb_de(p, trap);
    float dc = neb_gasDist(p, d);

    if (segDt > 0.0) {
      neb_segment(segD0, dc, segDt, segEmit, segSigma, dc < segD0 ? trap : segTrap, segGain, C, T);
      segDt = 0.0;
      if (tHalf < 0.0 && T < 0.5) tHalf = t;
      if (T < 0.004) { exhausted = false; break; }
    }
    if (ghostRun) {
      // Ghost x-ray: the solid being phased is transparent until the ray is out in the open;
      // everything beyond (the structure's other lobes included) renders as usual.
      float run = t - ghostT0;
      if (d <= 0.0) ghostTOut = -1.0;
      else if (ghostTOut < 0.0) {
        ghostTOut = t;
        ghostDOut = d;
        ghostTrap = trap;
      }
      if (d > max(eps, NEB_GHOST_OPEN * run)) {
        ghostRun = false;
        // A faint glassy sheet at the solid's boundary where the ray left it (known to within a
        // step, so its normal is taken at that step's scale — smoother too, which keeps the rim
        // from sparkling): rim-bright where it grazes the edge, so the body being phased keeps a
        // glowing silhouette.
        vec3 n = neb_normal(ro + rd * ghostTOut, max(eps, max(ghostDOut, 0.05 * run)), zero);
        float rimF = 1.0 - abs(dot(n, rd));
        vec3 alb = clamp(cosPalette(ghostTrap.x + 0.12 * ghostTrap.z, uPalA, uPalB, uPalC, uPalD), 0.0, 1.0);
        vec3 sheet = mix(alb, uRim, 0.4) + uGlowNear * 0.2;
        C += T * sheet * (NEB_GHOST_SHEET + NEB_GHOST_RIM * rimF * rimF);
        T *= 1.0 - NEB_GHOST_SHEET_A;
      } else {
        t += max(max(abs(d), eps), max(uGhostClip * NEB_GHOST_MINSTEP, NEB_GHOST_GROWTH * run));
        continue;
      }
    } else if (d < eps) {
      if (t < uGhostClip) {
        ghostRun = true;
        ghostT0 = t;
        ghostTOut = -1.0;
        t += max(max(abs(d), eps), uGhostClip * NEB_GHOST_MINSTEP) * (0.5 + jitter);
        continue;
      }
      hit = true;
      exhausted = false;
      break;
    }

    float gasN;
    neb_media(p, rd, dc, segEmit, segSigma, segGain, gasN);

    // Sphere tracing, but inside the glow shell (d < 4L) steps are capped at ~2L so the analytic
    // linear-distance integration stays accurate over curved surfaces; also capped by the
    // envelope sampling interval.
    float dt = min(min(d, max(2.0 * uGlowLen, d - 2.0 * uGlowLen)), envStep);

    if (pulseOn) {
      float w = max(uPulseParams.x, eps * 1.5);
      float pd = abs(length(p - uPulse.xyz) - uPulse.w);
      float x = pd / w;
      float shell = exp(-x * x) * uPulseParams.y;
      float gs = max(1.0 - 0.25 * dc / uGlowLen, 0.0);
      float nearS = gs * gs * gs;
      segEmit += pulseCol * (shell * (nearS * NEB_PULSE_NEAR + (gasN - nearS) * NEB_PULSE_ENV) / w);
      dt = min(dt, max(pd - w, 0.5 * w)); // never step over the shell
    }

    if (i == 0) dt *= 1.0 - NEB_JITTER * jitter; // decorrelates envelope sampling between pixels
    dt = max(dt, eps * 0.5);
    segD0 = dc;
    segDt = dt;
    segTrap = trap;
    t += dt;
  }
  // Close a segment left open (end not evaluated): assume constant distance, and don't integrate
  // past the render sphere when the last step overshot it.
  if (segDt > 0.0) {
    segDt = max(segDt - max(t - t1, 0.0), 0.0);
    neb_segment(segD0, segD0, segDt, segEmit, segSigma, segTrap, segGain, C, T);
  }

  // Ran out of steps: hugging a surface → shade it; deep inside the structure → close the ray
  // with dim glowing haze instead of letting the sky show through a long tunnel.
  bool haze = false;
  if (!hit && exhausted) {
    if (ghostRun) haze = length(ro + rd * t) < uBound; // still seeing through: never shade the inside
    else if (d < eps * 8.0) hit = true;
    else if (length(ro + rd * t) < uBound) haze = true;
  }

  vec3 col = C;
  float alpha = 1.0 - T;
  float depth = 1.0;
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = neb_normal(p, eps * 0.75, zero);
    vec3 surf = neb_shade(p, n, rd, trap, t, eps, zero);
    if (pulseOn) {
      float w = max(uPulseParams.x, eps * 1.5);
      float x = abs(length(p - uPulse.xyz) - uPulse.w) / w;
      surf += pulseCol * (exp(-x * x) * uPulseParams.y * NEB_PULSE_SURF);
    }
    col += T * surf;
    alpha = 1.0;
    depth = logDepth(t * uScale * dot(rdW, uCamForward));
  } else if (haze) {
    col += T * (uGlowNear * 0.05 + uGlowFar * 0.12 + uAmbient * 0.06);
    alpha = 1.0;
    depth = logDepth(t * uScale * dot(rdW, uCamForward));
  } else if (tHalf > 0.0) {
    // Dense gas: occlude depth-tested sprites behind its half-opacity point.
    depth = logDepth(tHalf * uScale * dot(rdW, uCamForward));
  }

  col = min(col, vec3(NEB_MAX_OUT));
  if (any(isnan(col)) || isnan(alpha)) { col = vec3(0.0); alpha = 0.0; }
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0)) * uFade;
  gl_FragDepth = uFade > 0.5 ? depth : 1.0;
}
`;

/** Defines that select a distinct shader program for a quality preset. */
function nebulaDefines(q: QualityPreset): Record<string, number | string | boolean> {
  const defs: Record<string, number | string | boolean> = {
    MAX_STEPS: Math.max(16, Math.round(q.marchSteps)),
    AO_SAMPLES: Math.max(0, Math.round(q.aoSamples)),
  };
  if (q.shadows) {
    defs.SHADOWS = 1;
    defs.SHADOW_STEPS = SHADOW_STEPS[q.name];
  }
  return defs;
}

/** Program signature; the renderer rebuilds a material when this changes with quality. */
export function nebulaMaterialKey(fractal: FractalDef, q: QualityPreset): string {
  const d = nebulaDefines(q);
  return `${fractal.kind}|${d.MAX_STEPS}|${d.AO_SAMPLES}|${d.SHADOWS ?? 0}|${d.SHADOW_STEPS ?? 0}`;
}

/** Assemble the fragment shader for a fractal (exported for offline validation). */
export function buildNebulaFragment(fractal: FractalDef): string {
  return [COMMON_GLSL, CAMERA_UNIFORMS_GLSL, TEMPLATE_UNIFORMS_GLSL, fractal.glsl, TEMPLATE_BODY_GLSL].join('\n');
}

interface NebulaMaterialData {
  fractalKind: string;
  qualityName: QualityPreset['name'];
  nebId: string | null;
  /** Log-smoothed camera surface distance (local units) driving the glow length, and its clock. */
  glowSd: number;
  glowTime: number;
}

export function createNebulaMaterial(fractal: FractalDef, quality: QualityPreset): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    ...makeCameraUniforms(),
    uP: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uIter: { value: Math.max(1, Math.round(fractal.gpuIter)) },
    uWorldToLocal: { value: new THREE.Matrix3() },
    uCamLocal: { value: new THREE.Vector3(0, 0, 10) },
    uScale: { value: 1 },
    uBound: { value: fractal.boundRadius },
    uRenderBound: { value: fractal.boundRadius * 1.6 },
    uSteps: { value: quality.marchSteps },
    uDetail: { value: 1 },
    uPalA: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
    uPalB: { value: new THREE.Vector3(0.3, 0.3, 0.3) },
    uPalC: { value: new THREE.Vector3(1, 1, 1) },
    uPalD: { value: new THREE.Vector3(0, 0.1, 0.2) },
    uGlowNear: { value: new THREE.Vector3(2, 0.8, 0.3) },
    uGlowFar: { value: new THREE.Vector3(0.1, 0.2, 0.5) },
    uRim: { value: new THREE.Vector3(1.5, 1.2, 1.0) },
    uAmbient: { value: new THREE.Vector3(0.2, 0.2, 0.3) },
    uLightPos: { value: new THREE.Vector3(1.5, 1.5, 1.0) },
    uLightCol: { value: new THREE.Vector3(6, 6, 7) },
    uFade: { value: 1 },
    uPulse: { value: new THREE.Vector4(0, 0, 0, 0) },
    uPulseParams: { value: new THREE.Vector2(1, 0) },
    uGasDensity: { value: 1 },
    uGhostClip: { value: 0 },
    uGlowLen: { value: 0.06 * fractal.boundRadius },
    uWisp: { value: new THREE.Vector3(1, 2, 0) },
    uWispOrigin: { value: new THREE.Vector3() },
    uEnvSamples: { value: 28 },
    uSeed: { value: 0 },
    uNoise: { value: getNebulaNoiseTexture() },
  };
  const mat = new THREE.ShaderMaterial({
    name: `nebula:${fractal.kind}`,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: buildNebulaFragment(fractal),
    uniforms,
    defines: nebulaDefines(quality),
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.AlwaysDepth,
    toneMapped: false,
    fog: false,
    lights: false,
  });
  const data: NebulaMaterialData = { fractalKind: fractal.kind, qualityName: quality.name, nebId: null, glowSd: NaN, glowTime: NaN };
  mat.userData.nebula = data;
  return mat;
}

// ---------------------------------------------------------------------------------------------
// Per-frame uniforms (all derived quantities computed in doubles on the CPU)
// ---------------------------------------------------------------------------------------------
const _rel = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const DEFAULT_LIGHT_DIR = new THREE.Vector3(1.2, 1.6, 0.9).normalize();

function setVec3(v: THREE.Vector3, a: readonly number[], scale = 1): void {
  v.set((a[0] ?? 0) * scale, (a[1] ?? 0) * scale, (a[2] ?? 0) * scale);
}

function applyNebulaConstants(u: Record<string, THREE.IUniform>, neb: NebulaRuntime, bound: number): void {
  const pal = neb.def.palette;
  setVec3(u.uPalA.value as THREE.Vector3, pal.a);
  setVec3(u.uPalB.value as THREE.Vector3, pal.b);
  setVec3(u.uPalC.value as THREE.Vector3, pal.c);
  setVec3(u.uPalD.value as THREE.Vector3, pal.d);
  setVec3(u.uGlowNear.value as THREE.Vector3, pal.glowNear);
  setVec3(u.uGlowFar.value as THREE.Vector3, pal.glowFar);
  setVec3(u.uRim.value as THREE.Vector3, pal.rim);
  setVec3(u.uAmbient.value as THREE.Vector3, pal.ambient);
  const light = neb.def.lights[0];
  if (light) {
    setVec3(u.uLightPos.value as THREE.Vector3, light.local);
    setVec3(u.uLightCol.value as THREE.Vector3, light.color);
  } else {
    (u.uLightPos.value as THREE.Vector3).copy(DEFAULT_LIGHT_DIR).multiplyScalar(bound * 1.8);
    setVec3(u.uLightCol.value as THREE.Vector3, pal.rim, 2.5);
  }
  // Golden-ratio sequence → each nebula gets its own gas pattern.
  u.uSeed.value = ((neb.index * 0.6180339887) % 1) * 23.0;
}

export function updateNebulaUniforms(mat: THREE.ShaderMaterial, neb: NebulaRuntime, ctx: RenderContext): void {
  const u = mat.uniforms;
  const fractal = neb.fractal;
  if (!fractal) return;
  const data = mat.userData.nebula as NebulaMaterialData | undefined;
  const q = ctx.quality;
  const scale = neb.scale > 0 && Number.isFinite(neb.scale) ? neb.scale : 1;
  const invScale = 1 / scale;
  const bound = fractal.boundRadius;

  applyCameraUniforms(u, ctx);
  if (!data || data.nebId !== neb.def.id) {
    applyNebulaConstants(u, neb, bound);
    if (data) data.nebId = neb.def.id;
  }

  // Fractal params (animated on the CPU by Universe).
  const P = u.uP.value as THREE.Vector4[];
  const pa = neb.params;
  for (let i = 0; i < 4; i++) P[i].set(pa[i * 4] ?? 0, pa[i * 4 + 1] ?? 0, pa[i * 4 + 2] ?? 0, pa[i * 4 + 3] ?? 0);

  // Camera in local units: rotInv · (ship − nebula) / scale, in doubles.
  const ship = ctx.state.ship.position;
  _rel.set(ship.x - neb.position.x, ship.y - neb.position.y, ship.z - neb.position.z);
  const dist = _rel.length();
  _rel.applyQuaternion(neb.rotationInv).multiplyScalar(invScale);
  const camLocal = u.uCamLocal.value as THREE.Vector3;
  camLocal.copy(_rel);

  _m4.makeRotationFromQuaternion(neb.rotationInv);
  (u.uWorldToLocal.value as THREE.Matrix3).setFromMatrix4(_m4);

  const renderBoundLocal = neb.renderRadiusWorld > 0 ? neb.renderRadiusWorld * invScale : bound * neb.def.haloFactor;
  u.uScale.value = scale;
  u.uBound.value = bound;
  u.uRenderBound.value = renderBoundLocal;

  // ---- LOD from projected angular radius ----
  const Rw = renderBoundLocal * scale;
  const inside = dist <= Rw;
  const angR = inside ? Math.PI * 0.5 : Math.asin(clamp(Rw / Math.max(dist, 1e-12), 0, 1));
  const pixelAngle = ctx.pixelAngle > 0 ? ctx.pixelAngle : 1e-3;
  const rPx = angR / pixelAngle;
  const lod = inside ? 1 : smoothstep(20, 380, rPx);
  const maxSteps = Math.max(16, Math.round(q.marchSteps));
  const minSteps = Math.min(40, maxSteps);
  u.uSteps.value = Math.round(lerp(minSteps, maxSteps, lod));
  u.uDetail.value = QUALITY_DETAIL[q.name] * (KIND_DETAIL[fractal.kind] ?? 1) * lerp(1.5, 1.0, lod);
  u.uEnvSamples.value = clamp(lerp(8, 18, lod) * Math.sqrt(maxSteps / 170), 6, 24);
  const fadeNear = smoothstep(0.75, 3.0, rPx);
  const fadeFar = 1 - smoothstep(FADE_FAR_LY * 0.7, FADE_FAR_LY, dist);
  u.uFade.value = inside ? 1 : fadeNear * fadeFar;
  const clipW = ctx.state.ship.ghostClip;
  u.uGhostClip.value = clipW > 0 && Number.isFinite(clipW) ? clipW * invScale : 0;

  const sdRaw = neb.surfaceDistance;
  const sdWorld = Number.isFinite(sdRaw) ? Math.max(sdRaw, 0) : Math.max(dist - neb.boundRadiusWorld, 0);
  const camSurfLocal = sdWorld * invScale;

  // ---- iterations ----
  // Distant nebulae drop iterations (the lost detail is sub-pixel). Close to the structure the GPU
  // must run at least the counts the fractal was verified with against its CPU mirror: with fewer,
  // escape-time and carving fractals render fatter than the collision surface and the ship can end
  // up inside a rendered wall (full-screen solid). The ramp spreads the detail change over distance.
  const iterQ = Math.max(1, Math.round(fractal.gpuIter * q.iterScale));
  const iterFloor = Math.max(2, Math.ceil(fractal.gpuIter * 0.5));
  const iterFar = Math.max(Math.min(iterFloor, iterQ), Math.round(iterQ * lerp(0.6, 1.0, lod)));
  const iterNear = Math.max(iterQ, fractal.gpuIter, fractal.cpuIter);
  const closeness = 1 - smoothstep(0.5 * bound, 3 * bound, camSurfLocal);
  u.uIter.value = Math.round(lerp(iterFar, iterNear, closeness));

  // ---- scale-aware gas: glow length follows the camera's local surface distance ----
  // The glow shells follow a log-smoothed camera distance: the raw one swings as the camera passes
  // florets and pillars, which made the "fog" pulse and flight feel uneven. (Iterations above keep
  // the raw distance — collision parity needs it.)
  let glowSd = camSurfLocal;
  if (data) {
    const dtG = Number.isFinite(data.glowTime) ? clamp(ctx.time - data.glowTime, 0, 0.25) : 0;
    data.glowTime = ctx.time;
    if (Number.isFinite(data.glowSd) && data.glowSd > 0 && camSurfLocal > 0 && Number.isFinite(camSurfLocal)) {
      const k = 1 - Math.exp(-dtG / GLOW_SMOOTH_TAU);
      glowSd = Math.exp(Math.log(data.glowSd) + (Math.log(camSurfLocal) - Math.log(data.glowSd)) * k);
    }
    data.glowSd = glowSd;
  }
  const glowLen = clamp(NEBULA_LOOK.glowLenCam * glowSd, 2e-6, NEBULA_LOOK.glowLenFar * bound);
  u.uGlowLen.value = glowLen;

  const wispBase = Math.max(glowLen * NEBULA_LOOK.wispScale, 1e-6);
  const lvl = Math.log2(wispBase);
  const fl = Math.floor(lvl);
  const s0 = Math.pow(2, fl);
  const s1 = s0 * 2;
  (u.uWisp.value as THREE.Vector3).set(s0, s1, lvl - fl);
  // Anchor wisp noise near the camera (multiple of the larger period) to keep coordinates small.
  (u.uWispOrigin.value as THREE.Vector3).set(
    Math.floor(camLocal.x / s1) * s1,
    Math.floor(camLocal.y / s1) * s1,
    Math.floor(camLocal.z / s1) * s1,
  );

  // ---- resonance pulse in local units ----
  const pulse = ctx.state.pulse;
  const pulseVec = u.uPulse.value as THREE.Vector4;
  const pulseParams = u.uPulseParams.value as THREE.Vector2;
  let intensity = 0;
  if (pulse.active && pulse.radius > 0 && pulse.width > 0) {
    _rel.set(pulse.origin.x - neb.position.x, pulse.origin.y - neb.position.y, pulse.origin.z - neb.position.z);
    _rel.applyQuaternion(neb.rotationInv).multiplyScalar(invScale);
    const rLocal = pulse.radius * invScale;
    const wLocal = pulse.width * invScale;
    const shellGap = Math.abs(_rel.length() - rLocal);
    if (shellGap < renderBoundLocal + 3 * wLocal) {
      const age = clamp(pulse.age, 0, 1);
      intensity = smoothstep(0, 0.04, age) * Math.pow(1 - age, 1.5);
      pulseVec.set(_rel.x, _rel.y, _rel.z, rLocal);
      pulseParams.set(wLocal, intensity);
    }
  }
  if (!(intensity > 0)) pulseParams.set(1, 0); // also a NaN pulse age: never rely on GPU NaN compares
}
