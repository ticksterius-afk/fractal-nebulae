/**
 * The Frost Kaleidoscope — a kaleidoscopic IFS snow crystal: a "capped column".
 *
 * Capped columns are a real snow-crystal habit: a short hexagonal column with a stellar plate
 * growing from each end. Here both plates are fractal stellar dendrites and the column is an open
 * lantern of six ice needles, so the star at the centre lights the inner faces of both plates.
 *
 * Every level applies the D6h kaleidoscope (mirrors every 30° about Y, plus y → |y|), draws one
 * ridged, tapering arm along +x, then moves to a branch point on that arm, twists about the arm
 * (out-of-plane frost) and scales up. Because the fold repeats around every branch point, each
 * side branch is itself a small snowflake — the self-similarity of real dendrites.
 * Only folds, rotations and uniform scaling are used, so the DE is strictly 1-Lipschitz.
 *
 * Params (uP[i] = params[4i .. 4i+3]):
 *   uP[0] = (scale S (local units per crystal unit), branch scale s, branch point a, arm length L)
 *   uP[1] = (arm half-width, arm half-height, taper 0..1, twist about the arm (rad/level))
 *   uP[2] = (plate offset H, hub apothem, hub half-thickness, lantern rib distance)
 *   uP[3] = (lantern rib radius, tip glint radius, colour offset, DE safety factor)
 */
import type { FractalDef } from '../core/types';

const MAX_ITER = 9;
const C30 = Math.cos(Math.PI / 6);
const COLOUR_LEVELS = 8;

const f = (x: number) => x.toPrecision(9);

const GLSL = /* glsl */ `
#define FRACTAL_MAX_ITER ${MAX_ITER}
#define KIFS_C30 ${f(C30)}
#define KIFS_COLOUR_LEVELS ${COLOUR_LEVELS.toFixed(1)}

// D6 kaleidoscope about Y: fold xz into the 30° wedge [0°, 30°]
void kifsFold(inout vec3 q) {
  q.xz = abs(q.xz);
  vec2 n60 = vec2(-KIFS_C30, 0.5);
  float d = dot(q.xz, n60);
  if (d > 0.0) q.xz -= 2.0 * d * n60;
  vec2 n30 = vec2(-0.5, KIFS_C30);
  d = dot(q.xz, n30);
  if (d > 0.0) q.xz -= 2.0 * d * n30;
}

float fractalDE(vec3 p, out vec4 trap) {
  float S = uP[0].x, s = uP[0].y, a = uP[0].z, L = uP[0].w;
  float H = uP[2].x;
  vec3 q = p / S;
  q.y = abs(q.y);
  kifsFold(q);
  float radial = length(q.xz);
  // lantern: six vertical ice needles, thinnest at the waist
  float rib = max(length(q.xz - vec2(uP[2].w, 0.0)) - uP[3].x * (0.45 + 0.55 * clamp(q.y / H, 0.0, 1.0)), q.y - H);
  q.y -= H;
  // hexagonal hub plate (vertices along the arms)
  float hub = max(dot(q.xz, vec2(KIFS_C30, 0.5)) - uP[2].y, abs(q.y) - uP[2].z);
  float d = min(hub, rib);

  float ct = cos(uP[1].w), st = sin(uP[1].w);
  float scl = 1.0;
  float lvl = 0.0;
  float glint = 0.0;
  for (int i = 0; i < FRACTAL_MAX_ITER; i++) {
    if (i >= uIter) break;
    if (i > 0) { kifsFold(q); q.y = abs(q.y); }
    float k = 1.0 - uP[1].z * clamp(q.x / L, 0.0, 1.0);
    float tt = uP[1].x * k, hh = uP[1].y * k;
    float rh = (abs(q.y) * tt + abs(q.z) * hh - hh * tt) / sqrt(hh * hh + tt * tt);
    float arm = max(rh, abs(q.x - 0.5 * L) - 0.5 * L) / scl;
    if (arm < d) { d = arm; lvl = float(i + 1); }
    if (i >= 1 && i <= 3) {
      float g = 1.0 - smoothstep(0.0, uP[3].y, length(q - vec3(L, 0.0, 0.0)));
      glint = max(glint, g * g);
    }
    q.x -= a;
    q.yz = vec2(ct * q.y - st * q.z, st * q.y + ct * q.z);
    q *= s;
    scl *= s;
  }
  // fixed normalisation so colours don't shift when the renderer changes the iteration budget
  trap.x = fract(0.08 + 0.3 * lvl / KIFS_COLOUR_LEVELS + 0.22 * radial + uP[3].z);
  trap.y = clamp(0.55 * lvl / KIFS_COLOUR_LEVELS, 0.0, 1.0);
  trap.z = clamp(radial / (L * 1.1), 0.0, 1.0);
  trap.w = glint;
  return d * S * uP[3].w;
}
`;

// ---- JS mirror ------------------------------------------------------------------------------

const N60X = -C30, N60Z = 0.5, N30X = -0.5, N30Z = C30;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const fract = (v: number) => v - Math.floor(v);
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// fold state (module scratch)
let qx = 0, qz = 0;
function fold(): void {
  qx = Math.abs(qx);
  qz = Math.abs(qz);
  let d = qx * N60X + qz * N60Z;
  if (d > 0) { qx -= 2 * d * N60X; qz -= 2 * d * N60Z; }
  d = qx * N30X + qz * N30Z;
  if (d > 0) { qx -= 2 * d * N30X; qz -= 2 * d * N30Z; }
}

/**
 * Distance (and optionally the trap vector) — exact mirror of the GLSL fractalDE.
 * Exported for tooling; the flight code uses `kifs.de`.
 */
export function kifsEval(
  px: number, py: number, pz: number, P: Float32Array, iter: number, trap: Float64Array | null,
): number {
  const S = P[0], s = P[1], a = P[2], L = P[3], H = P[8];
  qx = px / S; qz = pz / S;
  let qy = Math.abs(py / S);
  fold();
  const radial = Math.sqrt(qx * qx + qz * qz);
  const rib = Math.max(Math.hypot(qx - P[11], qz) - P[12] * (0.45 + 0.55 * clamp01(qy / H)), qy - H);
  qy -= H;
  const hub = Math.max(qx * C30 + qz * 0.5 - P[9], Math.abs(qy) - P[10]);
  let d = Math.min(hub, rib);

  const ct = Math.cos(P[7]), st = Math.sin(P[7]);
  let scl = 1, lvl = 0, glint = 0;
  const n = Math.min(iter, MAX_ITER);
  for (let i = 0; i < n; i++) {
    if (i > 0) { fold(); qy = Math.abs(qy); }
    const k = 1 - P[6] * clamp01(qx / L);
    const tt = P[4] * k, hh = P[5] * k;
    const rh = (Math.abs(qy) * tt + Math.abs(qz) * hh - hh * tt) / Math.sqrt(hh * hh + tt * tt);
    const arm = Math.max(rh, Math.abs(qx - 0.5 * L) - 0.5 * L) / scl;
    if (arm < d) { d = arm; lvl = i + 1; }
    if (trap && i >= 1 && i <= 3) {
      const g = 1 - smoothstep(0, P[13], Math.hypot(qx - L, qy, qz));
      glint = Math.max(glint, g * g);
    }
    qx -= a;
    const y1 = ct * qy - st * qz, z1 = st * qy + ct * qz;
    qy = y1; qz = z1;
    qx *= s; qy *= s; qz *= s;
    scl *= s;
  }
  if (trap) {
    trap[0] = fract(0.08 + (0.3 * lvl) / COLOUR_LEVELS + 0.22 * radial + P[14]);
    trap[1] = clamp01((0.55 * lvl) / COLOUR_LEVELS);
    trap[2] = clamp01(radial / (L * 1.1));
    trap[3] = glint;
  }
  return d * S * P[15];
}

const DEFAULT_PARAMS = [
  1.4, 3.0, 0.55, 1.0, // S, branch scale, branch point, arm length
  0.035, 0.02, 0.5, 0.15, // arm half-width, half-height, taper, twist
  0.3, 0.22, 0.012, 0.2, // plate offset H, hub apothem, hub half-thickness, rib distance
  0.018, 0.18, 0.0, 0.9, // rib radius, glint radius, colour offset, DE safety
];

export const kifs: FractalDef = {
  kind: 'kifs',
  label: 'Kaleidoscopic IFS snow crystal (D6h)',
  glsl: GLSL,
  de: (x, y, z, params, iter) => kifsEval(x, y, z, params, iter, null),
  defaultParams: DEFAULT_PARAMS,
  animate: (base, t, out) => {
    for (let i = 0; i < 16; i++) out[i] = base[i];
    out[7] = base[7] + 0.06 * Math.sin((t * Math.PI * 2) / 180);
    out[2] = base[2] + 0.015 * Math.sin((t * Math.PI * 2) / 240 + 1.9);
  },
  boundRadius: 1.53,
  cpuIter: MAX_ITER, // min over levels: fewer levels would miss twigs
  gpuIter: 8,
  dimension: 1.89,
};
