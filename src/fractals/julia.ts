/**
 * The Julia Veil — quaternion Julia set z ← z² + c (Norton 1982; DE after Hart/Sandin/Kauffman 1989),
 * shown as a 3-D slice (x, y, z, w = slice) of the 4-D set.
 *
 * Quaternion square: (a, v)² = (a² − |v|², 2a·v). DE = ½·|z|·log|z| / |z'| with |z'| ← 2|z|·|z'|.
 *
 * Writing c = a + b·u (u a unit imaginary direction), the set's connectivity follows the complex
 * Julia set of a + b·i, while u and the slice w decide how the 4-D object is cut. The default
 * sits near the dendritic tip of the Mandelbrot set (a + bi ≈ −0.06 + 0.95i), where the slice
 * becomes thin wrapped curtains with torn holes — veils you can fly between and through.
 *
 * Params (uP[i] = params[4i .. 4i+3]):
 *   uP[0] = c quaternion (real, i, j, k)
 *   uP[1] = (slice w, coordinate scale K (fractal units per local unit), unused, unused)
 *   uP[2] = (colour-x gain, colour-x bias, cavity gain, cavity bias) — from min |orbit|
 *   uP[3] = (colour-z gain, colour-z bias, filament half-width, unused)
 *
 * Emission: points whose orbit grazes the real hyperplane (min |Re z| small) — thin luminous
 * threads running along the veils.
 *
 * Iterations: FRACTAL_MAX_ITER = gpuIter = cpuIter. Near the dendritic tip orbits escape slowly:
 * with 12 iterations the veils melted into smooth sheets from ~1e-2 local inward, while 16 keeps
 * the layered curtains. The DE of a not-yet-escaped orbit is not monotone in the count, so CPU and
 * GPU agree only at equal counts; capping the loop means the renderer's iterScale > 1 cannot push
 * the GPU past the CPU.
 */
import type { FractalDef } from '../core/types';

const MAX_ITER = 16;
const BAILOUT = 256;
const TAU = Math.PI * 2;
/** One full cycle of the c path (s); every component uses an integer harmonic of it, so the path closes. */
const CYCLE = 1200;

const GLSL = /* glsl */ `
#define FRACTAL_MAX_ITER ${MAX_ITER}

float fractalDE(vec3 p, out vec4 trap) {
  float K = uP[1].y;
  vec4 z = vec4(p * K, uP[1].x);
  vec4 c = uP[0];
  float md2 = 1.0;
  float mz2 = dot(z, z);
  float rMin2 = 1e10;
  float yMin = 1e10;
  float reMin = 1e10;
  for (int i = 0; i < FRACTAL_MAX_ITER; i++) {
    if (i >= uIter) break;
    md2 *= 4.0 * mz2;
    z = vec4(z.x * z.x - dot(z.yzw, z.yzw), 2.0 * z.x * z.yzw) + c;
    mz2 = dot(z, z);
    rMin2 = min(rMin2, mz2);
    yMin = min(yMin, abs(z.y));
    reMin = min(reMin, abs(z.x));
    if (mz2 > ${BAILOUT}.0) break;
  }
  float rMin = sqrt(rMin2);
  trap.x = clamp(rMin * uP[2].x + uP[2].y, 0.0, 1.0);
  trap.y = clamp(rMin * uP[2].z + uP[2].w, 0.0, 1.0);
  trap.z = clamp(yMin * uP[3].x + uP[3].y, 0.0, 1.0);
  trap.w = 1.0 - smoothstep(0.0, uP[3].z, reMin);
  return 0.25 * sqrt(mz2 / max(md2, 1e-30)) * log(max(mz2, 1e-30)) / K;
}
`;

function de(x: number, y: number, z: number, params: Float32Array, iter: number): number {
  const K = params[5];
  const cx = params[0];
  const cy = params[1];
  const cz = params[2];
  const cw = params[3];
  let zx = x * K;
  let zy = y * K;
  let zz = z * K;
  let zw = params[4];
  let md2 = 1;
  let mz2 = zx * zx + zy * zy + zz * zz + zw * zw;
  const n = iter < MAX_ITER ? iter : MAX_ITER;
  for (let i = 0; i < n; i++) {
    md2 *= 4 * mz2;
    const x2 = 2 * zx;
    const nx = zx * zx - zy * zy - zz * zz - zw * zw + cx;
    zy = x2 * zy + cy;
    zz = x2 * zz + cz;
    zw = x2 * zw + cw;
    zx = nx;
    mz2 = zx * zx + zy * zy + zz * zz + zw * zw;
    if (mz2 > BAILOUT) break;
  }
  return (0.25 * Math.sqrt(mz2 / (md2 > 1e-30 ? md2 : 1e-30)) * Math.log(mz2 > 1e-30 ? mz2 : 1e-30)) / K;
}

/**
 * c = a + b·u drifts on a small closed loop through the base value: (a, b) circles with radius
 * 0.05 (period 240 s), u sways in its j/k components (200 s / 300 s) and the slice w breathes
 * (150 s). All periods divide CYCLE, so the morph repeats exactly every 20 minutes; t = 0 gives
 * the base params.
 */
function animate(base: readonly number[], t: number, out: Float32Array): void {
  for (let i = 0; i < 16; i++) out[i] = base[i] ?? 0;
  const w = TAU / CYCLE;
  const vx = base[1];
  const vy = base[2];
  const vz = base[3];
  const b0 = Math.sqrt(vx * vx + vy * vy + vz * vz);
  let ux = 1;
  let uy = 0;
  let uz = 0;
  if (b0 > 1e-6) {
    ux = vx / b0;
    uy = vy / b0;
    uz = vz / b0;
  }
  uy += 0.22 * Math.sin(6 * w * t);
  uz += 0.22 * Math.sin(4 * w * t);
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const b = b0 + 0.05 * (1 - Math.cos(5 * w * t));
  out[0] = base[0] + 0.05 * Math.sin(5 * w * t);
  out[1] = (b * ux) / ul;
  out[2] = (b * uy) / ul;
  out[3] = (b * uz) / ul;
  out[4] = base[4] + 0.08 * Math.sin(8 * w * t);
}

export const julia: FractalDef = {
  kind: 'julia',
  label: 'Quaternion Julia set',
  glsl: GLSL,
  de,
  defaultParams: [
    -0.06, 0.7916, 0.3562, 0.2375,
    0.1, 1.1, 0, 0,
    1.0, -0.2, -1.2, 1.0,
    1.3, 0, 0.006, 0,
  ],
  animate,
  boundRadius: 1.5,
  cpuIter: MAX_ITER,
  gpuIter: MAX_ITER,
  dimension: NaN, // depends on c; this c lies outside the Mandelbrot set (a dust) — not known
};
