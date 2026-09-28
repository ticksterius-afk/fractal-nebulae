/**
 * The Cathedral Nebula — Tom Lowe's Mandelbox (2010).
 *
 * Iteration on z (starting at c = p·K):
 *   box fold:    z ← clamp(z, −L, L)·2 − z
 *   sphere fold: r² < m² → z ← z/m²;  m² ≤ r² < 1 → z ← z/r²
 *   z ← S·z + c
 * DE = |z| / |dz| (running derivative dz ← dz·fold·|S| + 1), divided by K for local units.
 *
 * Scale S = 2.75 opens the interior into vaulted halls and deep corridors (~80 % of the cube's
 * volume is open space at 0.002 clearance) while the facade keeps its ornate rose windows.
 * (Scales 2.0 and −1.77 leave only ~9 % open: beautiful from outside, but not flyable.)
 * The raw fractal fills a cube of half-side 2(S+1)/(S−1); K maps its corners to ≈1.5 local.
 *
 * Params (uP[i] = params[4i .. 4i+3]):
 *   uP[0] = (scale S, min radius² m², fold limit L, coordinate scale K)
 *   uP[1] = (colour-x gain, colour-x bias, cavity gain, cavity bias)
 *   uP[2] = (colour-z gain, colour-z bias, emission threshold, emission softness)
 *   uP[3] = unused
 *
 * Emission: points whose orbit dives deep inside the inner sphere-fold ball (min r² below a
 * small threshold) — glowing orbs set into the rose windows and lanterns deep in the halls.
 *
 * Iterations: FRACTAL_MAX_ITER = gpuIter = cpuIter. Points inside the solid never escape, so their
 * DE is only as small as |z|/|dz| gets: ≈1.5e-5 local after 9 iterations (the order of the ship's
 * 5e-5 clearance) but ≈2e-7 after 14. Too few iterations make thin walls porous: at 9 iterations
 * the CPU surface lay behind the 14-iteration GPU surface on ~95 % of rays, so the ship could fly
 * through walls the GPU draws. With the loop capped at gpuIter, the renderer's iterScale can only
 * lower uIter, never push it past the CPU count (fewer GPU iterations are the safe direction here).
 */
import type { FractalDef } from '../core/types';

const MAX_ITER = 14;
const BAIL_R2 = 1000;
const TAU = Math.PI * 2;

const GLSL = /* glsl */ `
#define FRACTAL_MAX_ITER ${MAX_ITER}

float fractalDE(vec3 p, out vec4 trap) {
  float S = uP[0].x;
  float mr2 = uP[0].y;
  float lim = uP[0].z;
  float K = uP[0].w;
  vec3 c = p * K;
  vec3 z = c;
  float dr = 1.0;
  float innerMin = 1e10;
  float orbMin = 1e10;
  float planeMin = 1e10;
  for (int i = 0; i < FRACTAL_MAX_ITER; i++) {
    if (i >= uIter) break;
    z = clamp(z, -lim, lim) * 2.0 - z;
    float r2 = dot(z, z);
    innerMin = min(innerMin, r2);
    float k = clamp(1.0 / max(r2, 1e-20), 1.0, 1.0 / mr2);
    z = z * (k * S) + c;
    dr = dr * (k * abs(S)) + 1.0;
    float m = dot(z, z);
    orbMin = min(orbMin, m);
    planeMin = min(planeMin, abs(z.y));
    if (m > ${BAIL_R2}.0) break;
  }
  trap.x = clamp(sqrt(orbMin) * uP[1].x + uP[1].y, 0.0, 1.0);
  trap.y = clamp(sqrt(orbMin) * uP[1].z + uP[1].w, 0.0, 1.0);
  trap.z = clamp(planeMin * uP[2].x + uP[2].y, 0.0, 1.0);
  trap.w = 1.0 - smoothstep(uP[2].z, uP[2].z + uP[2].w, innerMin);
  return length(z) / abs(dr) / K;
}
`;

function de(x: number, y: number, z: number, params: Float32Array, iter: number): number {
  const S = params[0];
  const mr2 = params[1];
  const lim = params[2];
  const K = params[3];
  const aS = Math.abs(S);
  const kMax = 1 / mr2;
  const n = iter < MAX_ITER ? iter : MAX_ITER;
  const cx = x * K;
  const cy = y * K;
  const cz = z * K;
  let zx = cx;
  let zy = cy;
  let zz = cz;
  let dr = 1;
  for (let i = 0; i < n; i++) {
    zx = (zx > lim ? lim : zx < -lim ? -lim : zx) * 2 - zx;
    zy = (zy > lim ? lim : zy < -lim ? -lim : zy) * 2 - zy;
    zz = (zz > lim ? lim : zz < -lim ? -lim : zz) * 2 - zz;
    const r2 = zx * zx + zy * zy + zz * zz;
    let k = 1 / (r2 > 1e-20 ? r2 : 1e-20);
    k = k < 1 ? 1 : k > kMax ? kMax : k;
    const ks = k * S;
    zx = zx * ks + cx;
    zy = zy * ks + cy;
    zz = zz * ks + cz;
    dr = dr * k * aS + 1;
    if (zx * zx + zy * zy + zz * zz > BAIL_R2) break;
  }
  return Math.sqrt(zx * zx + zy * zy + zz * zz) / Math.abs(dr) / K;
}

/** Geometry stays still (the Mandelbox is chaotic under parameter changes); only the windows glow and fade. */
function animate(base: readonly number[], t: number, out: Float32Array): void {
  for (let i = 0; i < 16; i++) out[i] = base[i] ?? 0;
  out[10] *= 1 + 0.35 * Math.sin((TAU * t) / 97);
}

export const mandelbox: FractalDef = {
  kind: 'mandelbox',
  label: 'Mandelbox (scale 2.75)',
  glsl: GLSL,
  de,
  defaultParams: [
    2.75, 0.25, 1, 4.8,
    0.35, -0.8, -0.3, 1.2,
    0.35, 0, 0.05, 0.04,
    0, 0, 0, 0,
  ],
  animate,
  boundRadius: 1.6,
  cpuIter: MAX_ITER,
  gpuIter: MAX_ITER,
  dimension: NaN, // not known rigorously at scale 2.75
};
