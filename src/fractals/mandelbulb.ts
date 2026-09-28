/**
 * The Cauliflower Nebula — White/Nylander power-8 Mandelbulb.
 *
 * Iteration (spherical "triplex" power, y is the polar axis):
 *   r = |w|, θ = acos(w.y/r)·n + θ₀, φ = atan(w.x, w.z)·8 + φ₀
 *   w ← p + rⁿ · (sin θ sin φ, cos θ, sin θ cos φ)
 * DE = ½·log(r)·r / |dw|, with |dw| ← n·rⁿ⁻¹·|dw| + 1.
 *
 * The radial/polar power n breathes around 8 but the azimuthal multiplier stays exactly 8:
 * a non-integer azimuthal power would tear a visible seam plane along the atan branch cut.
 *
 * Params (uP[i] = params[4i .. 4i+3]):
 *   uP[0] = (power n, polar phase θ₀, azimuthal phase φ₀, unused)
 *   uP[1] = (emission trap point xyz, trap radius)               → trap.w
 *   uP[2] = (colour-x gain, colour-x bias, cavity gain, cavity bias) — both from min |orbit|
 *   uP[3] = (colour-z gain, colour-z bias, unused, unused)          — from min |orbit.y|
 *
 * Emission: points whose orbit passes close to a trap point — sparse glowing knots on the florets,
 * like the star-forming tips of the Pillars of Creation. (A plane trap drew thin "lava" filaments
 * everywhere, which read as a molten asteroid rather than a nebula.) trap.w is shading-only, so
 * the CPU mirror below is unaffected.
 *
 * Iterations: FRACTAL_MAX_ITER = gpuIter = cpuIter. The log-based DE of an orbit that has not
 * escaped yet is not monotone in the iteration count, so the CPU and GPU surfaces only coincide
 * at equal counts. Capping the loop means the renderer's iterScale > 1 cannot push the GPU past the
 * CPU (at 14 vs 11, a few near-surface CPU distances exceeded the GPU ones by up to ~5·10⁴×;
 * 14 iterations add no visible detail over 11, even 1e-4 local from the surface).
 */
import type { FractalDef } from '../core/types';

const MAX_ITER = 11;
const BAILOUT = 256;
const PHI_POWER = 8;
const TAU = Math.PI * 2;

const GLSL = /* glsl */ `
#define FRACTAL_MAX_ITER ${MAX_ITER}

float fractalDE(vec3 p, out vec4 trap) {
  float power = uP[0].x;
  vec3 fil = uP[1].xyz;
  vec3 w = p;
  float m = dot(w, w);
  float dz = 1.0;
  float rMin2 = 1e10;
  float yMin = 1e10;
  float filD = 1e10;
  for (int i = 0; i < FRACTAL_MAX_ITER; i++) {
    if (i >= uIter) break;
    float r = sqrt(m);
    float rn1 = pow(r, power - 1.0);
    dz = power * rn1 * dz + 1.0;
    float th = acos(clamp(w.y / max(r, 1e-12), -1.0, 1.0)) * power + uP[0].y;
    float ph = atan(w.x, w.z) * ${PHI_POWER}.0 + uP[0].z;
    float st = sin(th);
    w = p + (rn1 * r) * vec3(st * sin(ph), cos(th), st * cos(ph));
    m = dot(w, w);
    rMin2 = min(rMin2, m);
    yMin = min(yMin, abs(w.y));
    filD = min(filD, length(w - fil));
    if (m > ${BAILOUT}.0) break;
  }
  float rMin = sqrt(rMin2);
  trap.x = clamp(rMin * uP[2].x + uP[2].y, 0.0, 1.0);
  trap.y = clamp(rMin * uP[2].z + uP[2].w, 0.0, 1.0);
  trap.z = clamp(yMin * uP[3].x + uP[3].y, 0.0, 1.0);
  trap.w = 1.0 - smoothstep(0.0, uP[1].w, filD);
  return 0.25 * log(max(m, 1e-30)) * sqrt(m) / dz;
}
`;

function de(x: number, y: number, z: number, params: Float32Array, iter: number): number {
  const power = params[0];
  const phT = params[1];
  const phP = params[2];
  const n = iter < MAX_ITER ? iter : MAX_ITER;
  let wx = x;
  let wy = y;
  let wz = z;
  let m = wx * wx + wy * wy + wz * wz;
  let dz = 1;
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(m);
    const rn1 = Math.pow(r, power - 1);
    dz = power * rn1 * dz + 1;
    let c = wy / (r > 1e-12 ? r : 1e-12);
    c = c < -1 ? -1 : c > 1 ? 1 : c;
    const th = Math.acos(c) * power + phT;
    const ph = Math.atan2(wx, wz) * PHI_POWER + phP;
    const st = Math.sin(th);
    const rn = rn1 * r;
    wx = x + rn * st * Math.sin(ph);
    wy = y + rn * Math.cos(th);
    wz = z + rn * st * Math.cos(ph);
    m = wx * wx + wy * wy + wz * wz;
    if (m > BAILOUT) break;
  }
  return (0.25 * Math.log(m > 1e-30 ? m : 1e-30) * Math.sqrt(m)) / dz;
}

/** Blooming morph: power breathes 8 ± 0.45, polar/azimuthal phases drift (incommensurate periods). */
function animate(base: readonly number[], t: number, out: Float32Array): void {
  for (let i = 0; i < 16; i++) out[i] = base[i] ?? 0;
  out[0] += 0.45 * Math.sin((TAU * t) / 173);
  out[1] += 0.22 * Math.sin((TAU * t) / 229 + 1.3);
  out[2] += 0.35 * Math.sin((TAU * t) / 131 + 0.4);
}

export const mandelbulb: FractalDef = {
  kind: 'mandelbulb',
  label: 'Mandelbulb (power 8)',
  glsl: GLSL,
  de,
  defaultParams: [
    8, 0, 0, 0,
    0.25, 0.45, 0.2, 0.1,
    2.2, -1.96, -3.0, 3.1,
    1.1, 0, 0, 0,
  ],
  animate,
  boundRadius: 1.2,
  cpuIter: MAX_ITER,
  gpuIter: MAX_ITER,
  dimension: 3,
};
