/**
 * The Menger Lattice — Menger sponge (Karl Menger, 1926), distance-estimated after Íñigo Quílez.
 *
 * Start from the cube [−1, 1]³ and, at every generation, carve the central cross out of each
 * of the 27 sub-cubes. In IQ's formulation each generation is a domain-repeated cross whose
 * distance is max-combined with the solid so far, so the DE is an exact-ish, 1-Lipschitz bound.
 *
 * The first cross leaves a central chamber and three perpendicular tunnels of width 2/3:
 * plenty of room to fly inside (the catalog places the nebula's star at the very centre, so
 * its light pours out through every tunnel).
 *
 * The carve threshold H (1 = classic sponge) narrows every hole's half-width by the fraction
 * H − 1; animating it slightly above 1 makes the lattice breathe without changing its topology
 * (H < 1 would open hairline slits between all sub-cubes).
 *
 * Params (uP[i] = params[4i .. 4i+3]):
 *   uP[0] = (carve threshold H, unused, unused, unused)
 *   uP[1] = (glowing-cell probability, first glowing generation, unused, unused) → trap.w
 *   uP[2] = (colour-x gain per generation, colour-x bias, cavity gain, cavity bias)
 *   uP[3] = (colour-z gain, colour-z bias, unused, unused)
 *
 * Emission: a sparse random subset of tunnels (hash of the carving cell) glows like furnace
 * windows. trap.x follows the generation (hole size) plus a per-cell hash and a soft weathering
 * mottle (value noise), mirrored (ping-pong) instead of clamped so deep generations keep cycling
 * through the palette; trap.y is the depth below the outer cube faces; trap.z the product of the
 * cross distances (bright along tunnel corners).
 *
 * Iterations: FRACTAL_MAX_ITER = gpuIter = cpuIter = 10. Generation g carves holes 2/3^g wide, so
 * with 7 generations the walls were already featureless from 3e-3 local — far outside the ship's
 * 5e-5 clearance. Ten generations (holes down to 3.4e-5) keep the dive detailed all the way down;
 * a float32 emulation of the GLSL stays within 1e-7 local of the double-precision DE (0.3 % of the
 * finest hole). Carving only removes material, so the DE grows with the count: the CPU is
 * conservative whenever uIter ≥ cpuIter.
 */
import type { FractalDef } from '../core/types';

const MAX_ITER = 10;
const TAU = Math.PI * 2;

const GLSL = /* glsl */ `
#define FRACTAL_MAX_ITER ${MAX_ITER}

float fractalDE(vec3 p, out vec4 trap) {
  vec3 b = abs(p) - 1.0;
  float box = length(max(b, 0.0)) + min(max(b.x, max(b.y, b.z)), 0.0);
  float d = box;
  float H = uP[0].x;
  float s = 1.0;
  float lvl = 0.0;
  float cellH = 0.5;
  float occ = 1.0;
  for (int m = 0; m < FRACTAL_MAX_ITER; m++) {
    if (m >= uIter) break;
    vec3 a = mod(p * s, 2.0) - 1.0;
    vec3 cell = floor(p * s * 0.5 + 0.5);
    s *= 3.0;
    vec3 r = abs(1.0 - 3.0 * abs(a));
    float da = max(r.x, r.y);
    float db = max(r.y, r.z);
    float dc = max(r.z, r.x);
    float c = (min(da, min(db, dc)) - H) / s;
    if (c > d) {
      d = c;
      lvl = float(m);
      cellH = hash13(cell + float(m) * 31.7);
      occ = da * db * dc;
    }
  }
  float glow = step(cellH, uP[1].x) * step(uP[1].y, lvl);
  float tx = lvl * uP[2].x + cellH * 0.15 + noise3(p * 5.0) * 0.35 + uP[2].y;
  trap.x = 1.0 - abs(1.0 - mod(max(tx, 0.0), 2.0));
  trap.y = clamp(-box * uP[2].z + uP[2].w, 0.0, 1.0);
  trap.z = clamp(occ * uP[3].x + uP[3].y, 0.0, 1.0);
  trap.w = glow * (0.55 + 0.45 * fract(cellH * 97.0));
  return d;
}
`;

/** GLSL mod(v, 2.0) = v − 2·floor(v/2) (differs from JS % for negative v). */
const mod2 = (v: number) => v - 2 * Math.floor(v * 0.5);

function de(x: number, y: number, z: number, params: Float32Array, iter: number): number {
  const bx = Math.abs(x) - 1;
  const by = Math.abs(y) - 1;
  const bz = Math.abs(z) - 1;
  const ox = bx > 0 ? bx : 0;
  const oy = by > 0 ? by : 0;
  const oz = bz > 0 ? bz : 0;
  const inside = Math.max(bx, by, bz);
  let d = Math.sqrt(ox * ox + oy * oy + oz * oz) + (inside < 0 ? inside : 0);

  const H = params[0];
  const n = iter < MAX_ITER ? iter : MAX_ITER;
  let s = 1;
  for (let m = 0; m < n; m++) {
    const aX = mod2(x * s) - 1;
    const aY = mod2(y * s) - 1;
    const aZ = mod2(z * s) - 1;
    s *= 3;
    const rx = Math.abs(1 - 3 * Math.abs(aX));
    const ry = Math.abs(1 - 3 * Math.abs(aY));
    const rz = Math.abs(1 - 3 * Math.abs(aZ));
    const da = rx > ry ? rx : ry;
    const db = ry > rz ? ry : rz;
    const dc = rz > rx ? rz : rx;
    const c = (Math.min(da, db, dc) - H) / s;
    if (c > d) d = c;
  }
  return d;
}

/** The lattice breathes: every hole narrows by up to ~6 % and reopens over four minutes. */
function animate(base: readonly number[], t: number, out: Float32Array): void {
  for (let i = 0; i < 16; i++) out[i] = base[i] ?? 0;
  out[0] += 0.03 * (1 - Math.cos((TAU * t) / 241));
}

export const menger: FractalDef = {
  kind: 'menger',
  label: 'Menger sponge',
  glsl: GLSL,
  de,
  defaultParams: [
    1, 0, 0, 0,
    0.12, 1, 0, 0,
    0.14, 0.08, 1.2, 0,
    0.25, 0, 0, 0,
  ],
  animate,
  boundRadius: 1.8,
  cpuIter: MAX_ITER,
  gpuIter: MAX_ITER,
  dimension: Math.log(20) / Math.log(3),
};
