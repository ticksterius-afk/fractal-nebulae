/**
 * The Lichtenberg Nebula — a kaleidoscopic dendrite: lightning, Lichtenberg figures, neurons,
 * river deltas and coral share this branching law.
 *
 * The tree rises from a discharge point near the bottom of the bound. Each level draws one tapered
 * capsule along the local +Y axis, moves to its tip, twists by a golden-ish angle and then either
 *   F  fans out into four channels   (mirror folds x → |x|, z → |z|, rotated 45°),
 *   B  forks into two                (mirror fold x → |x|),
 *   K  kinks without forking         (no fold: the zig-zag of a lightning channel),
 * then tilts the child away from the parent axis (angle varies per level) and scales down.
 * Junction pattern along every path: K (bent trunk), F, then B B K repeating. Only mirror folds, rotations, translations and
 * uniform scaling are used, so the DE is exactly 1-Lipschitz (no fudge needed beyond the safety factor).
 * Sparse "electric" knots (trap.w) glow at the tips of a hashed subset of the finer branches.
 *
 * GPU cost notes: the point is never rescaled — every level works in tree units with its segment
 * length / radius / glow radius scaled instead (no divisions per level), the junction kind is fixed
 * at compile time (trunk and fan levels peeled, then the B B K period unrolled), so a level is just
 * a capsule, a twist, an optional |x| and a tilt.
 *
 * Params (uP[i] = params[4i .. 4i+3]):
 *   uP[0] = (scale S (local units per tree unit), trunk base y (local), trunk length, DE safety factor)
 *   uP[1] = (fork tilt, kink tilt, per-level tilt variation, twist per level) [rad]
 *   uP[2] = (fork scale ratio, kink scale ratio, branch radius (tree units), colour offset)
 *   uP[3] = (tip glow density 0..1, tip glow radius (tree units), glow from level, cavity gain)
 */
import type { FractalDef } from '../core/types';

const MAX_ITER = 18;
const C45 = Math.SQRT1_2;
const COLOUR_LEVELS = 15;

const GLSL = /* glsl */ `
#define FRACTAL_MAX_ITER ${MAX_ITER}
#define TREE_COLOUR_LEVELS ${COLOUR_LEVELS.toFixed(1)}
#define TREE_C45 ${C45.toFixed(9)}

// One level, in tree units. Its segment runs from the frame origin along +Y for len (= sc for every
// level but the trunk); the capsule radius is br*sc at the base and tapers by tp per unit of height.
// Then: move to the tip, twist (tw), fold (0 = kink, 1 = fork, 2 = fan), tilt by th and shrink the
// scale by r (ir = 1/r). fi = level index (float): colour depth, glow gate and tilt jitter.
void treeLevel(inout vec3 q, inout vec2 tw, vec2 twStep, inout float sc, inout float gs, inout float d,
               inout float lvl, inout float addr, inout float glow, float fi, float len, float tp, float r,
               float ir, float th0, int fold) {
  float cy = clamp(q.y, 0.0, len);
  float cap = length(vec3(q.x, q.y - cy, q.z)) - (uP[2].z * sc - tp * cy);
  if (cap < d) { d = cap; lvl = fi; }
  q.y -= len; // the tip is now the origin
  if (fi >= floor(uP[3].z + 0.5)) {
    // knot at the tip: 1 - smoothstep(0, glow radius * sc, |q|), gs = 1 / (glow radius * sc)
    float gate = step(hash11(addr * 0.618 + fi * 7.31), uP[3].x);
    float t = clamp(length(q) * gs, 0.0, 1.0);
    float g = 1.0 - t * t * (3.0 - 2.0 * t);
    glow = max(glow, gate * g * g);
  }
  q.xz = vec2(tw.x * q.x - tw.y * q.z, tw.y * q.x + tw.x * q.z);
  tw = vec2(tw.x * twStep.x - tw.y * twStep.y, tw.y * twStep.x + tw.x * twStep.y);
  if (fold == 2) {
    addr = addr * 4.0 + (q.x < 0.0 ? 1.0 : 0.0) + (q.z < 0.0 ? 2.0 : 0.0);
    q.xz = abs(q.xz);
    q.xz = vec2(TREE_C45 * (q.x + q.z), TREE_C45 * (q.z - q.x));
  } else if (fold == 1) {
    addr = addr * 2.0 + (q.x < 0.0 ? 1.0 : 0.0);
    q.x = abs(q.x);
  }
  if (addr > 65536.0) addr -= 65536.0 * floor(addr / 65536.0);
  float th = th0 + uP[1].z * sin(fi * 2.399 + 0.7);
  float c2 = cos(th), s2 = sin(th);
  q.xy = vec2(c2 * q.x - s2 * q.y, s2 * q.x + c2 * q.y);
  sc *= r;
  gs *= ir;
}

float fractalDE(vec3 p, out vec4 trap) {
  float S = uP[0].x;
  vec3 q = vec3(p.x, p.y - uP[0].y, p.z) / S;
  float rf = uP[2].x, rk = uP[2].y;
  float irf = 1.0 / rf, irk = 1.0 / rk;
  float tpf = uP[2].z * (1.0 - rf), tpk = uP[2].z * (1.0 - rk);
  float sc = 1.0;
  float gs = 1.0 / uP[3].y;
  float d = 1e10;
  float lvl = 0.0;
  float addr = 0.0;
  float glow = 0.0;
  // twist angle at level i is twist·(i+1): advance it by complex multiplication
  vec2 twStep = vec2(cos(uP[1].w), sin(uP[1].w));
  vec2 tw = twStep;
  int n = min(uIter, FRACTAL_MAX_ITER);
  // junctions along every path: K (trunk) F, then (B B K) repeating
  if (n > 0) treeLevel(q, tw, twStep, sc, gs, d, lvl, addr, glow, 0.0, uP[0].z, tpk / uP[0].z, rk, irk, uP[1].y, 0);
  if (n > 1) treeLevel(q, tw, twStep, sc, gs, d, lvl, addr, glow, 1.0, sc, tpf, rf, irf, uP[1].x * 1.25, 2);
  float fi = 2.0;
  for (int i = 2; i < FRACTAL_MAX_ITER; i += 3) {
    if (i >= n) break;
    treeLevel(q, tw, twStep, sc, gs, d, lvl, addr, glow, fi, sc, tpf, rf, irf, uP[1].x, 1);
    if (i + 1 >= n) break;
    treeLevel(q, tw, twStep, sc, gs, d, lvl, addr, glow, fi + 1.0, sc, tpf, rf, irf, uP[1].x, 1);
    if (i + 2 >= n) break;
    treeLevel(q, tw, twStep, sc, gs, d, lvl, addr, glow, fi + 2.0, sc, tpk, rk, irk, uP[1].y, 0);
    fi += 3.0;
  }
  // fixed normalisation so colours don't shift when the renderer changes the iteration budget
  trap.x = fract(uP[2].w + 0.3 * lvl / TREE_COLOUR_LEVELS + 0.08 * hash11(addr * 0.37 + 0.5));
  trap.y = clamp(uP[3].w * (1.0 - lvl / TREE_COLOUR_LEVELS), 0.0, 1.0);
  trap.z = clamp(0.5 + 0.35 * p.y, 0.0, 1.0);
  trap.w = glow;
  return d * S * uP[0].w;
}
`;

// ---- JS mirror ------------------------------------------------------------------------------

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const fract = (v: number) => v - Math.floor(v);
/** Mirror of COMMON_GLSL hash11. */
function hash11(v: number): number {
  v = fract(v * 0.1031);
  v *= v + 33.33;
  v *= v + v;
  return fract(v);
}

// Per-level tilt cos/sin (and the twist step) depend only on uP[1]; flight evaluates the DE many
// times per frame with the same params, so they are cached (identical values → still an exact mirror).
const tiltCS = new Float64Array(2 * MAX_ITER);
const tiltKey = new Float64Array([NaN, NaN, NaN, NaN]);
let twCos = 1, twSin = 0;
function updateTilts(P: Float32Array): void {
  if (P[4] === tiltKey[0] && P[5] === tiltKey[1] && P[6] === tiltKey[2] && P[7] === tiltKey[3]) return;
  tiltKey[0] = P[4]; tiltKey[1] = P[5]; tiltKey[2] = P[6]; tiltKey[3] = P[7];
  for (let i = 0; i < MAX_ITER; i++) {
    const fold = i === 0 ? 0 : i === 1 ? 2 : (i - 2) % 3 === 2 ? 0 : 1;
    const th = (fold === 2 ? P[4] * 1.25 : fold === 1 ? P[4] : P[5]) + P[6] * Math.sin(i * 2.399 + 0.7);
    tiltCS[2 * i] = Math.cos(th);
    tiltCS[2 * i + 1] = Math.sin(th);
  }
  twCos = Math.cos(P[7]);
  twSin = Math.sin(P[7]);
}

/**
 * Distance (and optionally the trap vector) — exact mirror of the GLSL fractalDE (treeLevel per
 * level; the kind sequence K F (B B K)… is selected per level here). All state lives in locals.
 * Exported for tooling; the flight code uses `tree.de`.
 */
export function treeEval(
  px: number, py: number, pz: number, P: Float32Array, iter: number, trap: Float64Array | null,
): number {
  const S = P[0];
  let x = px / S, y = (py - P[1]) / S, z = pz / S;
  const rf = P[8], rk = P[9], br = P[10];
  const irf = 1 / rf, irk = 1 / rk;
  const tpf = br * (1 - rf), tpk = br * (1 - rk);
  const glowFrom = Math.floor(P[14] + 0.5);
  let sc = 1, gs = 1 / P[13];
  let d = 1e10, lvl = 0, addr = 0, glow = 0;
  updateTilts(P);
  const tsx = twCos, tsy = twSin;
  let twx = tsx, twy = tsy;
  const n = Math.min(iter, MAX_ITER);
  for (let i = 0; i < n; i++) {
    // junction at this segment's tip: 0 = kink, 1 = fork, 2 = fan. Pattern: K F (B B K)...
    const fold = i === 0 ? 0 : i === 1 ? 2 : (i - 2) % 3 === 2 ? 0 : 1;
    const kink = fold === 0;
    const len = i === 0 ? P[2] : sc;
    const tp = i === 0 ? tpk / P[2] : kink ? tpk : tpf;
    const cy = y < 0 ? 0 : y > len ? len : y;
    const dy = y - cy;
    const cap = Math.sqrt(x * x + dy * dy + z * z) - (br * sc - tp * cy);
    if (cap < d) { d = cap; lvl = i; }
    y -= len; // the tip is now the origin
    if (trap && i >= glowFrom) {
      const gate = hash11(addr * 0.618 + i * 7.31) <= P[12] ? 1 : 0;
      const t = clamp01(Math.sqrt(x * x + y * y + z * z) * gs);
      const g = 1 - t * t * (3 - 2 * t);
      glow = Math.max(glow, gate * g * g);
    }
    const rx = twx * x - twy * z, rz = twy * x + twx * z;
    x = rx; z = rz;
    const nwx = twx * tsx - twy * tsy;
    twy = twy * tsx + twx * tsy;
    twx = nwx;
    if (fold === 2) {
      addr = addr * 4 + (x < 0 ? 1 : 0) + (z < 0 ? 2 : 0);
      x = Math.abs(x); z = Math.abs(z);
      const fx = C45 * (x + z), fz = C45 * (z - x);
      x = fx; z = fz;
    } else if (fold === 1) {
      addr = addr * 2 + (x < 0 ? 1 : 0);
      x = Math.abs(x);
    }
    if (addr > 65536) addr -= 65536 * Math.floor(addr / 65536);
    const c2 = tiltCS[2 * i], s2 = tiltCS[2 * i + 1]; // tilt: th = base(kind) + P6·sin(i·2.399 + 0.7)
    const tx = c2 * x - s2 * y, ty = s2 * x + c2 * y;
    x = tx; y = ty;
    if (kink) { sc *= rk; gs *= irk; } else { sc *= rf; gs *= irf; }
  }
  if (trap) {
    trap[0] = fract(P[11] + (0.3 * lvl) / COLOUR_LEVELS + 0.08 * hash11(addr * 0.37 + 0.5));
    trap[1] = clamp01(P[15] * (1 - lvl / COLOUR_LEVELS));
    trap[2] = clamp01(0.5 + 0.35 * py);
    trap[3] = glow;
  }
  return d * S * P[3];
}

const DEFAULT_PARAMS = [
  // base + length·S = −0.68 fixes the crown; the root sits 0.16 above the catalog's discharge star at
  // (0, −1.2, 0) so its soft shadows don't pinch every light ray through a 0.04-wide penumbra.
  0.55, -1.0, 0.5818, 0.95, // S, trunk base y, trunk length, DE safety
  0.7, 0.45, 0.3, 1.9, // fork tilt, kink tilt, tilt variation, twist
  0.74, 0.86, 0.07, 0.05, // fork ratio, kink ratio, branch radius, colour offset
  0.3, 0.42, 5.0, 0.45, // tip glow density, glow radius, glow from level, cavity gain
];

export const tree: FractalDef = {
  kind: 'tree',
  label: 'Kaleidoscopic dendrite (Lichtenberg tree)',
  glsl: GLSL,
  de: (x, y, z, params, iter) => treeEval(x, y, z, params, iter, null),
  defaultParams: DEFAULT_PARAMS,
  animate: (base, t, out) => {
    for (let i = 0; i < 16; i++) out[i] = base[i];
    out[4] = base[4] + 0.035 * Math.sin((t * Math.PI * 2) / 150);
    out[5] = base[5] + 0.03 * Math.sin((t * Math.PI * 2) / 210 + 2.0);
    out[7] = base[7] + 0.025 * Math.sin((t * Math.PI * 2) / 270 + 4.0);
  },
  boundRadius: 1.7,
  cpuIter: MAX_ITER, // min over levels: fewer levels would miss twigs
  gpuIter: 15,
  dimension: 2.3,
};
