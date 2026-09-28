/**
 * Sierpiński's Pyramid — the Sierpiński tetrahedron ("tetrix") as a folding IFS.
 *
 * The local frame puts one vertex straight up (+Y) and the opposite face flat at the bottom.
 * Internally the point is mapped into the canonical tetrahedron with vertices
 * v1=(1,1,1), v2=(−1,−1,1), v3=(1,−1,−1), v4=(−1,1,−1) (circumradius √3), then per level:
 *   fold into the v1 corner (3 mirror folds), rotate (twist about v1, tilt about the x′ axis),
 *   z ← s·z − (s−1)·v1
 * and the final DE is the plane-SDF of the canonical tetrahedron divided by the total scale.
 * Every step is a reflection, rotation or uniform scale, so the DE is 1-Lipschitz for any
 * twist/tilt, and the attractor always stays inside the circumsphere (|w(x)| ≤ (|x| + √3)/2).
 * With s = 2 and no rotation this is the classic tetrix: Hausdorff dimension log 4 / log 2 = 2.
 *
 * Params (uP[i] = params[4i .. 4i+3]):
 *   uP[0] = (scale s, twist rad/level about the apex axis, tilt rad/level, size = circumradius)
 *   uP[1] = (knot level, knot density 0..1, knot radius (canonical units), fine-knot density 0..1)
 *   uP[2] = (cavity gain, colour-x spread, colour-x offset, unused)
 *   uP[3] = unused
 * Hot knots (trap.w) sit on the edge-midpoint junctions of the level-L sub-pyramids, where two
 * sibling pyramids touch; the gate hashes the parent's address so a knot is lit on both sides.
 */
import type { FractalDef } from '../core/types';

const MAX_ITER = 14;

const GLSL = /* glsl */ `
#define FRACTAL_MAX_ITER ${MAX_ITER}

void sierpinskiAxisAngle(vec3 k, float a, out vec3 r0, out vec3 r1, out vec3 r2) {
  float c = cos(a), s = sin(a), t = 1.0 - c;
  r0 = vec3(c + t * k.x * k.x, t * k.x * k.y - s * k.z, t * k.x * k.z + s * k.y);
  r1 = vec3(t * k.y * k.x + s * k.z, c + t * k.y * k.y, t * k.y * k.z - s * k.x);
  r2 = vec3(t * k.z * k.x - s * k.y, t * k.z * k.y + s * k.x, c + t * k.z * k.z);
}

float fractalDE(vec3 p, out vec4 trap) {
  float s = uP[0].x;
  float kIn = 1.7320508 / uP[0].w;
  // local (apex = +Y) -> canonical tetrahedron frame (apex = v1 = (1,1,1))
  vec3 z = (p.x * vec3(0.70710678, -0.70710678, 0.0)
          + p.y * vec3(0.57735027)
          + p.z * vec3(-0.40824829, -0.40824829, 0.81649658)) * kIn;

  vec3 a0, a1, a2, b0, b1, b2;
  sierpinskiAxisAngle(vec3(0.57735027), uP[0].y, a0, a1, a2);
  sierpinskiAxisAngle(vec3(0.70710678, -0.70710678, 0.0), uP[0].z, b0, b1, b2);
  vec3 r0 = b0.x * a0 + b0.y * a1 + b0.z * a2;
  vec3 r1 = b1.x * a0 + b1.y * a1 + b1.z * a2;
  vec3 r2 = b2.x * a0 + b2.y * a1 + b2.z * a2;

  // cavity: depth inside the level-0 pyramid (0 on the outer faces)
  float d0 = max(max(-z.x - z.y - z.z, z.x + z.y - z.z), max(-z.x + z.y + z.z, z.x - z.y + z.z)) - 1.0;
  float cav = clamp(-d0 * uP[2].x, 0.0, 1.0);

  int kl = int(uP[1].x + 0.5);
  float addrId = 0.0;
  float colour = 0.0, cw = 0.5;
  float knot = 0.0;
  float scl = 1.0;
  for (int i = 0; i < FRACTAL_MAX_ITER; i++) {
    if (i >= uIter) break;
    float code = 0.0;
    if (z.x + z.y < 0.0) { z.xy = -z.yx; code += 1.0; }
    if (z.x + z.z < 0.0) { z.xz = -z.zx; code += 2.0; }
    if (z.y + z.z < 0.0) { z.zy = -z.yz; code += 4.0; }
    if (i == kl || i == kl + 2) {
      // junctions with the sibling sub-pyramids: edge midpoints (1,0,0), (0,1,0), (0,0,1)
      float dm = min(min(length(z - vec3(1.0, 0.0, 0.0)), length(z - vec3(0.0, 1.0, 0.0))), length(z - vec3(0.0, 0.0, 1.0)));
      float dens = i == kl ? uP[1].y : uP[1].w;
      float gate = step(hash11(addrId + float(i) * 7.0), dens);
      float g = 1.0 - smoothstep(0.0, uP[1].z, dm);
      knot = max(knot, gate * g * g);
    }
    addrId = addrId * 8.0 + code;
    if (addrId > 1048576.0) addrId -= 1048576.0 * floor(addrId / 1048576.0);
    colour += cw * fract(code * 0.381966 + 0.13);
    cw *= 0.5;
    z = vec3(dot(r0, z), dot(r1, z), dot(r2, z));
    z = z * s - vec3(s - 1.0);
    scl *= s;
  }
  float dT = max(max(-z.x - z.y - z.z, z.x + z.y - z.z), max(-z.x + z.y + z.z, z.x - z.y + z.z)) - 1.0;
  trap.x = fract(colour * uP[2].y + uP[2].z);
  trap.y = cav;
  trap.z = clamp(0.5 + 0.5 * p.y / uP[0].w, 0.0, 1.0);
  trap.w = knot;
  return dT * 0.57735027 / (scl * kIn);
}
`;

// ---- JS mirror ------------------------------------------------------------------------------

const SQRT3 = Math.sqrt(3);
const INV_SQRT3 = 1 / SQRT3;
const INV_SQRT2 = Math.SQRT1_2;
const INV_SQRT6 = 1 / Math.sqrt(6);

// cached combined rotation rows (recomputed only when twist/tilt change)
let cTwist = NaN;
let cTilt = NaN;
let r00 = 1, r01 = 0, r02 = 0, r10 = 0, r11 = 1, r12 = 0, r20 = 0, r21 = 0, r22 = 1;

function updateRotation(twist: number, tilt: number): void {
  if (twist === cTwist && tilt === cTilt) return;
  cTwist = twist;
  cTilt = tilt;
  // A = rotation about (1,1,1)/√3 by twist
  let k0 = INV_SQRT3, k1 = INV_SQRT3, k2 = INV_SQRT3;
  let c = Math.cos(twist), s = Math.sin(twist), t = 1 - c;
  const a00 = c + t * k0 * k0, a01 = t * k0 * k1 - s * k2, a02 = t * k0 * k2 + s * k1;
  const a10 = t * k1 * k0 + s * k2, a11 = c + t * k1 * k1, a12 = t * k1 * k2 - s * k0;
  const a20 = t * k2 * k0 - s * k1, a21 = t * k2 * k1 + s * k0, a22 = c + t * k2 * k2;
  // B = rotation about (1,−1,0)/√2 by tilt
  k0 = INV_SQRT2; k1 = -INV_SQRT2; k2 = 0;
  c = Math.cos(tilt); s = Math.sin(tilt); t = 1 - c;
  const b00 = c + t * k0 * k0, b01 = t * k0 * k1 - s * k2, b02 = t * k0 * k2 + s * k1;
  const b10 = t * k1 * k0 + s * k2, b11 = c + t * k1 * k1, b12 = t * k1 * k2 - s * k0;
  const b20 = t * k2 * k0 - s * k1, b21 = t * k2 * k1 + s * k0, b22 = c + t * k2 * k2;
  // R = B·A (rows)
  r00 = b00 * a00 + b01 * a10 + b02 * a20; r01 = b00 * a01 + b01 * a11 + b02 * a21; r02 = b00 * a02 + b01 * a12 + b02 * a22;
  r10 = b10 * a00 + b11 * a10 + b12 * a20; r11 = b10 * a01 + b11 * a11 + b12 * a21; r12 = b10 * a02 + b11 * a12 + b12 * a22;
  r20 = b20 * a00 + b21 * a10 + b22 * a20; r21 = b20 * a01 + b21 * a11 + b22 * a21; r22 = b20 * a02 + b21 * a12 + b22 * a22;
}

const fract = (v: number) => v - Math.floor(v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Mirror of COMMON_GLSL hash11. */
function hash11(n: number): number {
  n = fract(n * 0.1031);
  n *= n + 33.33;
  n *= n + n;
  return fract(n);
}

/**
 * Distance (and optionally the trap vector) — exact mirror of the GLSL fractalDE.
 * Exported for tooling (colour previews); the flight code uses `sierpinski.de`.
 */
export function sierpinskiEval(
  x: number, y: number, z: number, P: Float32Array, iter: number, trap: Float64Array | null,
): number {
  const s = P[0];
  const kIn = SQRT3 / P[3];
  updateRotation(P[1], P[2]);
  let zx = (x * INV_SQRT2 + y * INV_SQRT3 - z * INV_SQRT6) * kIn;
  let zy = (-x * INV_SQRT2 + y * INV_SQRT3 - z * INV_SQRT6) * kIn;
  let zz = (y * INV_SQRT3 + z * 2 * INV_SQRT6) * kIn;

  let cav = 0;
  if (trap) {
    const d0 = Math.max(Math.max(-zx - zy - zz, zx + zy - zz), Math.max(-zx + zy + zz, zx - zy + zz)) - 1;
    cav = clamp01(-d0 * P[8]);
  }
  const kl = Math.floor(P[4] + 0.5);
  const n = Math.min(iter, MAX_ITER);
  let addrId = 0, colour = 0, cw = 0.5, knot = 0, scl = 1, tmp = 0;
  const off = s - 1;
  for (let i = 0; i < n; i++) {
    let code = 0;
    if (zx + zy < 0) { tmp = zx; zx = -zy; zy = -tmp; code += 1; }
    if (zx + zz < 0) { tmp = zx; zx = -zz; zz = -tmp; code += 2; }
    if (zy + zz < 0) { tmp = zy; zy = -zz; zz = -tmp; code += 4; }
    if (trap) {
      if (i === kl || i === kl + 2) {
        const dm = Math.min(
          Math.hypot(zx - 1, zy, zz), Math.hypot(zx, zy - 1, zz), Math.hypot(zx, zy, zz - 1));
        const dens = i === kl ? P[5] : P[7];
        const gate = hash11(addrId + i * 7) <= dens ? 1 : 0;
        const g = 1 - smoothstep(0, P[6], dm);
        knot = Math.max(knot, gate * g * g);
      }
      addrId = addrId * 8 + code;
      if (addrId > 1048576) addrId -= 1048576 * Math.floor(addrId / 1048576);
      colour += cw * fract(code * 0.381966 + 0.13);
      cw *= 0.5;
    }
    const nx = r00 * zx + r01 * zy + r02 * zz;
    const ny = r10 * zx + r11 * zy + r12 * zz;
    const nz = r20 * zx + r21 * zy + r22 * zz;
    zx = nx * s - off;
    zy = ny * s - off;
    zz = nz * s - off;
    scl *= s;
  }
  const dT = Math.max(Math.max(-zx - zy - zz, zx + zy - zz), Math.max(-zx + zy + zz, zx - zy + zz)) - 1;
  if (trap) {
    trap[0] = fract(colour * P[9] + P[10]);
    trap[1] = cav;
    trap[2] = clamp01(0.5 + (0.5 * y) / P[3]);
    trap[3] = knot;
  }
  return (dT * INV_SQRT3) / (scl * kIn);
}

const DEFAULT_PARAMS = [
  2.0, 0.0, 0.0, 1.5, // scale, twist, tilt, size
  3.0, 0.3, 0.5, 0.12, // knot level, density, radius, fine density
  3.0, 0.55, 0.85, 0.0, // cavity gain, colour spread, colour offset
  0.0, 0.0, 0.0, 0.0,
];

export const sierpinski: FractalDef = {
  kind: 'sierpinski',
  label: 'Sierpiński tetrahedron (tetrix)',
  glsl: GLSL,
  de: (x, y, z, params, iter) => sierpinskiEval(x, y, z, params, iter, null),
  defaultParams: DEFAULT_PARAMS,
  animate: (base, t, out) => {
    for (let i = 0; i < 16; i++) out[i] = base[i];
    out[1] = base[1] + 0.05 * Math.sin((t * Math.PI * 2) / 180);
    out[2] = base[2] + 0.03 * Math.sin((t * Math.PI * 2) / 240 + 1.3);
  },
  boundRadius: 1.56,
  cpuIter: 10,
  gpuIter: 11,
  dimension: 2,
};
