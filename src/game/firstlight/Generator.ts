/**
 * First Light — the seeded level generator (design/20-first-light.md §7.4 "forward design",
 * design/60-first-light-build.md §L). Shared by the designer tools (tools/fl-solve.ts generate) and the
 * runtime daily (DailyGen).
 *
 * No DOM; three.js maths only through Reach.ts (the game's own placement code). Deterministic: attempt i
 * draws from mulberry32(hash2(seed, i)) and the gates use evaluation counts, never wall time, so a seed
 * names one level on every machine. Never Math.random.
 *
 * Click-aware: every mass is authored where the click aimed beside its beam lands. From the arena's
 * vantage, with the reticle on a point b beside beam point p in p's VIEW PLANE (side ±normalize(t × view
 * ray): ⟂ the beam and the vantage ray), Reach.vantageClick runs Placement.flightPlacementPoint, whose beam
 * snap picks the depth. So the authored mass sits at the snap depth exactly, every bend reads as a sideways
 * turn from the vantage, and the click aimed at it lands on it at the 60° and 100° ends of the FOV range
 * too (b stays within 0.85 of the snap's reach at 60°; the construction checks both). There is no
 * out-of-plane tilt: at wheel 0 the snap puts every click at its beam point's depth, so a tilted aim lands
 * in the view plane anyway. Option `reach`: the quick reach gate (Reach.quickReach) before the solver gates.
 *
 * One attempt, in the arena's LOCAL frame (R = arena radius, ρ_i = the i-th mass's radius):
 *  1. The source at a random free point (DE ≥ 0.04 R) 0.55–0.95 R from the centre, aimed at a pass point
 *     inside a cone (0.6 rad) toward the centre, 0.25–0.6 R away (0.3–0.9 R for one-mass levels), with a
 *     clear line to it and not seen end-on (|sin| ≥ 0.3 against the vantage ray). Mass 1 is clicked beside
 *     the pass point, on a random side, at an impact parameter of 4–10 ρ (6–10 ρ with ≥ 3 masses: two later
 *     bends amplify its error) and ≥ 0.06 R; when that spot is walled off (DE < 2.5 ρ) nearer the beam
 *     (down to the range's floor), then on the other side. Up to 8 such candidates are traced; of those that
 *     bend the beam ≥ 0.1 rad without capture (with ≥ 2 masses: passing it at ≥ 4 ρ), the best scores the
 *     room its bent beam leaves inside 0.9 R (for the next bend or the seeds) plus how much its legs run
 *     across the vantage's view rather than along it. A source in a closed pocket is replaced (≤ 4).
 *  2. Mass i ≥ 2 clicked beside the traced beam 0.3–0.5 R of path after the previous bend (same spot rules,
 *     ≥ 0.22 R from the other masses; up to 80 spots drawn, 8 traced), chosen the same way; it must turn the
 *     beam ≥ 0.1 rad more, keep every pass ≥ 4 ρ and the earlier bends (≤ 20 ρ). In two-mass levels the
 *     second bend usually turns the other way (an S: no single mass bends one way and then the other);
 *     other bends turn toward the arena centre (the path curls inward and keeps its room).
 *  3. Seeds ON the final path: the last one after the last bend, the others between bends (one per
 *     leg, up to 3, at least min(k, 2)), ≥ 0.12 R of path from any bend; each fully in free space
 *     (DE ≥ 1.15 r), legal for the solution masses, ≥ 1.6 r from the unlensed beam (it must miss every
 *     goal seed), preferring points close to structure and right after a bend (short lever arms keep the
 *     clicks forgiving). With k ≥ 2 the second seed must not share one straight leg from the unlensed beam
 *     with the last (oneLegReach ≥ 1): the cheap stand-in for the minimal gate; the best of up to 6 final
 *     seeds beside which the others fit. Optional "almost" window: the unlensed beam passes the last seed
 *     within [lo, hi] × r.
 *  4. Round every coordinate to 1e-6 (the tracer's mass grid), sanitise, then (option `reach`) the quick
 *     reach gate, then the solver gates (early exit, cheap gates first). The first attempt that passes is
 *     the level.
 *
 * Measured 2026-10-03 with the reach gate, 64 arena × seed runs cycling through the 43 curated daily arenas
 * (success within 80 attempts unless noted, mean time per call, one core):
 *   [medium] (almost 3–8 r) 64/64, 27 ms · [medium], two seeds 64/64, 27 ms · [medium ×2] 55/64, 0.19 s ·
 *   [heavy ×2] 58/64, 0.19 s · [light, heavy] 52/64, 0.26 s ([heavy, light] 35/64: its weak second bend
 *   leaves no second seed off the last one's straight leg) · [medium ×2], three seeds (120) 61/64, 0.23 s ·
 *   [heavy ×3], seeds 4 % R (300) 54/64, 3.2 s · [medium ×3], seeds 4 % R (300) 53/64, 2.9 s.
 *   Bends confined to the view plane make three-mass paths near-planar, where two masses can often reach
 *   the same seeds (the minimal gate) and two later bends amplify the first click's error; the old
 *   free-direction Generator built [heavy ×3] in 28 of 32 runs within 120 attempts, but none of its 57
 *   bundled Saturdays could be clicked. [light, medium, heavy]: a budget whose bigger masses can do the
 *   light one's job fails the minimal gate almost always — give three-mass levels equal sizes.
 *
 * Public API:
 *   GENERATOR                                   tunables
 *   generateLevel(opts: GenerateOptions) → GenerateResult
 */
import type { Vec3 } from '../../core/types';
import { hash2, mulberry32, pick, type Rng } from '../platform/prng';
import { traceLevel } from './BeamTracer';
import { LEVEL_LIMITS, sanitizeLevel } from './Level';
import { PLACEMENT } from './Placement';
import { quickReach, REACH, vantageClick, type QuickReachOptions, type QuickReachReport } from './Reach';
import { gates, type GateOptions, type GateReport } from './Solver';
import { makeTraceWorld } from './world';
import type { ArenaDef, Beam, LevelDef, MassSize, PlacedMass, SeedDef, SurfaceMaterial, TraceResult, TraceWorld } from './types';

export const GENERATOR = {
  maxAttempts: 80,
  /** Impact parameter of the planned pass by each mass (× ρ). */
  impact: [4, 10] as readonly [number, number],
  /**
   * Levels with ≥ 3 masses: the first mass's planned pass (× ρ). Its click region is the chain's tightest
   * (two later bends amplify its error): of 836 constructed three-heavy levels, 57 % with a first pass of
   * 7–10 ρ had ≥ 400 px² for the first click, 3–17 % below 5 ρ.
   */
  firstImpact: [6, 10] as readonly [number, number],
  /** …but at least this × R (× 1–1.5): keeps light-mass bends inside the player tolerance. */
  minImpact: 0.06,
  /** Seed radius (× R). */
  seedRadius: 0.05,
  /**
   * Generated masses keep DE ≥ this × ρ (legality needs 2: a margin for the jitter gates, ≥ 0.5 ρ against
   * their ≤ 0.6 % R). Beside the beam in the view plane there are only two sides; in the box arenas the
   * beam runs within 3 ρ (heavy) of a wall nearly everywhere, and 3 ρ left most of them without a spot.
   */
  massClearance: 2.5,
  /** Generated masses lie within this × R of the centre. */
  massRadius: 0.8,
  /** Generated masses are at least this × R apart (distinct bends). */
  massSpacing: 0.22,
  /** Source: DE ≥ this × R, and between these × R from the centre. */
  sourceClearance: 0.04,
  sourceRadius: [0.55, 0.95] as readonly [number, number],
  /** Path distance (× R) after the previous bend where the next mass goes (short legs: small lever arms). */
  bendGap: [0.3, 0.5] as readonly [number, number],
  /** Mass 1: within this half-angle (rad) of the source → centre direction, at these × R from the source. */
  firstCone: 0.6,
  firstReach: [0.25, 0.6] as readonly [number, number],
  firstReachSingle: [0.3, 0.9] as readonly [number, number],
  /** Traced candidates per bend (scored by the room left after the bend and acrossWeight). */
  bendCandidates: 8,
  /** Candidate spots drawn per later bend (most fail the cheap tests before any trace). */
  bendDraws: 80,
  /** Weight (× R) of a leg running across the vantage's view rather than along it. */
  acrossWeight: 0.5,
  /**
   * Levels with ≥ 2 masses: every mass's closest pass ≥ this × ρ. A near-capture pass makes the chain
   * fragile: three-heavy levels with a pass < 3 ρ left a 400 px² first click 3 % of the time, ≥ 4.5 ρ 54 %.
   */
  minPass: 4,
  /** Seed score weight of sitting right after its bend: short lever arms (a last seed ≥ 0.6 R past its bend never left the first click 400 px²). */
  freshWeight: 1.5,
  /** Final-seed candidates tried (best score first) until the other seeds fit beside one of them. */
  finalTries: 6,
  /**
   * Two-mass levels: probability that the second bend turns the other way (an S rather than an arc).
   * Not for three masses: wiggles there bring the last leg back near the unlensed line (yield 3/15 vs
   * 10/15 in the daily arenas).
   */
  zigzag: 0.85,
  /** Seeds sit at least this × R of path after a bend (and before the next one). */
  seedGap: 0.12,
  /** Seeds lie within this × R of the centre. */
  seedRadiusMax: 0.9,
  /** DE ≥ this × r at a seed centre (the whole seed in free space). */
  seedClearance: 1.15,
  /** The unlensed beam passes every goal seed at ≥ this × r. */
  unlensedMiss: 1.6,
  /** Every mass must turn the beam by at least this (rad). */
  minDeflection: 0.1,
  /**
   * No mass beside a leg seen within this of end-on from the vantage (|sin| of the angle between the leg
   * and the vantage ray): its bend would not read as a turn, and the view-plane side is ill-defined.
   */
  endOnSin: 0.3,
  /**
   * Planned impact parameters stay within this share of the beam snap's reach at the narrowest FOV the
   * aim rule tests (REACH: 60°), seen from the vantage: farther out, the click drops off the beam's depth.
   */
  snapUse: 0.85,
  /** The aimed click must land this × the planned impact parameter from the beam point it aimed beside. */
  clickBand: [0.7, 1.3] as readonly [number, number],
  /** Two-mass S: the second side must point at least this much away from the first (cosine). */
  zigzagMin: 0.3,
  /**
   * Bends after the first that are not an S: probability of the view-plane side facing the arena centre
   * (else either side). The path curls inward and keeps room for the next bend and the seeds.
   */
  inwardBias: 1,
  /** Seed candidates every this × R of path. */
  seedStep: 0.015,
  /** k ≥ 2: a second seed with oneLegReach below this is dropped; above it, larger is preferred (× weight). */
  oneLegMin: 1.0,
  oneLegWeight: 0.8,
} as const;

export interface GenerateOptions {
  nebula: string;
  /** Frozen animation clock (default 0). */
  clock?: number;
  arena: ArenaDef;
  /** Surface behaviour override (default: the nebula's). */
  material?: SurfaceMaterial;
  /** The budget, one entry per mass, e.g. ['medium', 'medium']. Order = the order the bends are designed in. */
  masses: readonly MassSize[];
  seed: number;
  /**
   * Goal seeds, exactly (never more than masses + 1). Default: one per mass up to 3 where the path has
   * room, at least min(masses, 2) — one seed per leg is what makes every bend necessary.
   */
  seedCount?: number;
  /** Seed radius × R (default GENERATOR.seedRadius). */
  seedRadius?: number;
  /** ρ per size × R (default LEVEL_LIMITS.defaultRho). */
  rho?: Partial<Record<MassSize, number>>;
  /** Impact parameter range × ρ (default GENERATOR.impact). */
  impact?: readonly [number, number];
  /** Require the unlensed beam to pass some goal seed within [lo, hi] × r (the "almost" moment). */
  almost?: readonly [number, number];
  maxAttempts?: number;
  /** Forwarded to gates() (e.g. lighter trial counts at runtime); earlyExit is always on. */
  gates?: Omit<GateOptions, 'world' | 'earlyExit' | 'seed'>;
  /**
   * Require the quick reach gate (Reach.quickReach: every solution mass one-click reachable from the
   * vantage with the game's own placement code; true = its defaults), checked before the solver gates.
   * The construction already authors every mass where its aimed click lands; the gate adds the area, the
   * chain of best clicks and the hover / snap checks of the full fl-reach rule.
   */
  reach?: boolean | Omit<QuickReachOptions, 'world'>;
  /** Level metadata (defaults: id `gen-<nebula>-<seed>`, chapter "gen", index 1, name "First Light"). */
  id?: string;
  chapter?: string;
  index?: number;
  name?: string;
}

export interface GenerateResult {
  /** The level (sanitised, gates passed), or null when every attempt failed. */
  level: LevelDef | null;
  /** Gate report of the returned level (or of the last gated attempt when none passed). */
  report: GateReport | null;
  /** Quick reach report of the returned level (or of the last attempt it judged); null without `reach`. */
  reach: QuickReachReport | null;
  attempts: number;
  /** Trace evaluations over all attempts (construction + gates). */
  evals: number;
  /** Wall time (diagnostics only). */
  ms: number;
  /** Why attempts were rejected: reason → count. */
  rejects: Record<string, number>;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const q6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const qv = (v: Readonly<Vec3>): Vec3 => [q6(v[0]), q6(v[1]), q6(v[2])];
const dist3 = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function unitOf(v: Readonly<Vec3>): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1];
}

const isFixedUnit = (u: Readonly<Vec3>): boolean => {
  const w = unitOf(u);
  return w[0] === u[0] && w[1] === u[1] && w[2] === u[2];
};

/**
 * A unit vector that normalising leaves bit-identical: sanitizeLevel re-normalises source.dir the same
 * way, and a vector whose length reads 1 ± 1 ulp moves in its last bits each time (or oscillates). The
 * level the construction traced, the gates validated and any later sanitise (save, fl-check of a pasted
 * level) then hold the same bits. Re-normalises, then nudges one component by a few ulps (≤ 1e-15;
 * ~1e-5 of vectors keep a 1-ulp wobble).
 */
function stableUnit(v: Readonly<Vec3>): Vec3 {
  let u = unitOf(v);
  for (let i = 0; i < 3 && !isFixedUnit(u); i++) u = unitOf(u);
  if (isFixedUnit(u)) return u;
  for (let s = 1; s <= 8; s++) {
    for (let k = 0; k < 3; k++) {
      for (const sg of [1, -1]) {
        const w: Vec3 = [u[0], u[1], u[2]];
        w[k] = u[k] * (1 + sg * s * Number.EPSILON * 0.5);
        if (isFixedUnit(w)) return w;
      }
    }
  }
  return u;
}

/** Random unit vector ⟂ d. */
function randomPerp(rng: Rng, d: Readonly<Vec3>): Vec3 {
  const u = unitOf(d);
  for (;;) {
    const z = 2 * rng() - 1;
    const a = 2 * Math.PI * rng();
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    const r: Vec3 = [s * Math.cos(a), s * Math.sin(a), z];
    const k = r[0] * u[0] + r[1] * u[1] + r[2] * u[2];
    const p: Vec3 = [r[0] - k * u[0], r[1] - k * u[1], r[2] - k * u[2]];
    const l = Math.hypot(p[0], p[1], p[2]);
    if (l > 0.2) return [p[0] / l, p[1] / l, p[2] / l];
  }
}

/** Point and unit tangent of a beam polyline at path length s (clamped to the polyline). */
function pointAt(b: Beam, s: number): { p: Vec3; t: Vec3 } {
  const L = b.length;
  const P = b.points;
  const n = L.length;
  let i = 0;
  while (i < n - 2 && L[i + 1] < s) i++;
  const seg = L[i + 1] - L[i];
  const f = seg > 0 ? Math.min(Math.max((s - L[i]) / seg, 0), 1) : 0;
  const a: Vec3 = [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
  const d: Vec3 = [P[3 * i + 3] - a[0], P[3 * i + 4] - a[1], P[3 * i + 5] - a[2]];
  return { p: [a[0] + f * d[0], a[1] + f * d[1], a[2] + f * d[2]], t: unitOf(d) };
}

/** Path length along the beam of its closest approach to q, and that distance. */
function closestAlong(b: Beam, q: Readonly<Vec3>): { s: number; d: number } {
  const P = b.points;
  const n = P.length / 3;
  let best = Infinity;
  let bestS = 0;
  for (let i = 0; i + 1 < n; i++) {
    const ax = P[3 * i];
    const ay = P[3 * i + 1];
    const az = P[3 * i + 2];
    const ux = P[3 * i + 3] - ax;
    const uy = P[3 * i + 4] - ay;
    const uz = P[3 * i + 5] - az;
    const uu = ux * ux + uy * uy + uz * uz;
    let t = uu > 0 ? ((q[0] - ax) * ux + (q[1] - ay) * uy + (q[2] - az) * uz) / uu : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + t * ux - q[0], ay + t * uy - q[1], az + t * uz - q[2]);
    if (d < best) {
      best = d;
      bestS = lerp(b.length[i], b.length[i + 1], t);
    }
  }
  return { s: bestS, d: best };
}

const endLength = (b: Beam): number => b.length[b.length.length - 1];

/** True when the straight segment a → b never comes within `eps` of structure (sphere tracing). */
function clearLine(world: TraceWorld, a: Readonly<Vec3>, b: Readonly<Vec3>, eps: number): boolean {
  const L = dist3(a, b);
  if (!(L > 0)) return true;
  const dx = (b[0] - a[0]) / L;
  const dy = (b[1] - a[1]) / L;
  const dz = (b[2] - a[2]) / L;
  let t = 0;
  for (let i = 0; i < 2000 && t < L; i++) {
    const d = world.de(a[0] + dx * t, a[1] + dy * t, a[2] + dz * t);
    if (!(d > eps)) return false;
    t += 0.8 * d;
  }
  return t >= L;
}

/**
 * Can ONE straight leg from the beam pass within r of both a and c? Lines through two balls of radius r
 * a distance D apart fan out beyond them: x beyond the nearer ball they reach r·(1 + 2x/D) off the
 * line ac. Returns min over the beam's points of (distance from the line) / (that reach), counting only
 * points beyond a or c (a leg cannot turn between the two seeds). < 1: one bend could light both.
 */
function oneLegReach(b: Beam, a: Readonly<Vec3>, c: Readonly<Vec3>, r: number): number {
  const ux = c[0] - a[0];
  const uy = c[1] - a[1];
  const uz = c[2] - a[2];
  const uu = ux * ux + uy * uy + uz * uz;
  if (!(uu > 0)) return 0;
  const D = Math.sqrt(uu);
  const P = b.points;
  let best = Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const wx = P[i] - a[0];
    const wy = P[i + 1] - a[1];
    const wz = P[i + 2] - a[2];
    const t = (wx * ux + wy * uy + wz * uz) / uu;
    if (t > 0 && t < 1) continue;
    const x = (t <= 0 ? -t : t - 1) * D;
    const d = Math.hypot(wx - t * ux, wy - t * uy, wz - t * uz);
    const q = d / (r * (1 + (2 * x) / D));
    if (q < best) best = q;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------------------------

interface Ctx {
  opts: GenerateOptions;
  /** Skeleton level: arena, source (per attempt), ρ, no seeds — what the construction traces use. */
  base: LevelDef;
  world: TraceWorld;
  R: number;
  C: Vec3;
  rho: Record<MassSize, number>;
  impact: readonly [number, number];
  seedR: number;
  /** Seeds wanted, and the fewest accepted. */
  seedCount: number;
  seedMin: number;
}

type Attempt = { level: LevelDef; evals: number } | { reject: string; evals: number };

/** A random point of the arena ball scaled by `k`, with DE ≥ `clear`, or null. */
function freePoint(ctx: Ctx, rng: Rng, k: number, clear: number, ok?: (p: Vec3) => boolean): Vec3 | null {
  const { C, R, world } = ctx;
  for (let i = 0; i < 300; i++) {
    const x = 2 * rng() - 1;
    const y = 2 * rng() - 1;
    const z = 2 * rng() - 1;
    if (x * x + y * y + z * z > 1) continue;
    const p: Vec3 = qv([C[0] + x * k * R, C[1] + y * k * R, C[2] + z * k * R]);
    if (ok && !ok(p)) continue;
    if (world.de(p[0], p[1], p[2]) >= clear) return p;
  }
  return null;
}

function attempt(ctx: Ctx, rng: Rng): Attempt {
  const { opts, R, C, world, rho, impact } = ctx;
  const G = GENERATOR;
  const sizes = opts.masses;
  let evals = 0;
  const level: LevelDef = { ...ctx.base, source: { pos: [0, 0, 0], dir: [0, 0, 1] } };
  const trace = (masses: readonly PlacedMass[]) => {
    evals++;
    return traceLevel(level, world, masses);
  };
  const reject = (reason: string): Attempt => ({ reject: reason, evals });
  const inside = (p: Readonly<Vec3>, k: number): boolean => dist3(p, C) <= k * R;

  // Room a bend leaves: path after the closest approach to m that stays within 0.9 R of the centre.
  const roomAfter = (b: Beam, m: Readonly<Vec3>): number => {
    const s0 = closestAlong(b, m).s;
    const P = b.points;
    for (let i = 0; i < b.length.length; i++) {
      if (b.length[i] <= s0) continue;
      if (Math.hypot(P[3 * i] - C[0], P[3 * i + 1] - C[1], P[3 * i + 2] - C[2]) > 0.9 * R) return b.length[i] - s0;
    }
    return endLength(b) - s0;
  };
  // Planned impact parameter: [lo, hi] × ρ, but never below minImpact × R (player tolerance: a light
  // mass passed at 4ρ ≈ 0.05 R turns 12 % harder or softer for a 0.6 % R placement error).
  const impactOf = (rho: number, range: readonly [number, number] = impact): number => Math.max(lerp(range[0], range[1], rng()) * rho, G.minImpact * R * lerp(1, 1.5, rng()));
  // Readability: a leg seen end-on from the vantage is hard to read and to place beside, so candidates
  // score by the room they leave (capped) plus how much the leg after their bend runs across the view.
  const view = unitOf([C[0] - opts.arena.vantage.pos[0], C[1] - opts.arena.vantage.pos[1], C[2] - opts.arena.vantage.pos[2]]);
  const across = (d: Readonly<Vec3>): number => 1 - Math.abs(d[0] * view[0] + d[1] * view[1] + d[2] * view[2]);
  const scoreOf = (room: number, b: Beam, m: Readonly<Vec3>): number =>
    Math.min(room, 1.2 * R) + G.acrossWeight * R * across(pointAt(b, closestAlong(b, m).s + 0.15 * R).t) + 0.1 * R * rng();
  // What the bend after mass i must leave: the next bend, or the seeds.
  const roomNeeded = (i: number): number => (i + 1 < sizes.length ? G.bendGap[0] + G.seedGap : G.seedGap) * R + 2 * ctx.seedR;
  // Click-aware placement: every mass sits beside the beam in the vantage's view plane, exactly where the
  // click aimed there lands (the beam snap puts it at the depth of the beam point), so each bend reads as
  // a sideways turn from the vantage and the authored point is the one a player can click.
  const V = opts.arena.vantage.pos;
  const tanMin = Math.tan((Math.min(REACH.fovDeg, ...REACH.aimFovs) * Math.PI) / 360);
  /** The impact parameter b capped to the snap's reach beside beam point p (snapFrac × the viewport height at p's distance). */
  const inReach = (b: number, p: Readonly<Vec3>): number => Math.min(b, G.snapUse * PLACEMENT.snapFrac * 2 * dist3(p, V) * tanMin);
  const scaled = (n: Readonly<Vec3>, k: number): Vec3 => [k * n[0], k * n[1], k * n[2]];
  const offset = (p: Readonly<Vec3>, n: Readonly<Vec3>, b: number): Vec3 => [p[0] + b * n[0], p[1] + b * n[1], p[2] + b * n[2]];
  /** normalize(t × view ray) at beam point p (⟂ the beam and the vantage ray), or null for a leg seen end-on. */
  const viewSide = (p: Readonly<Vec3>, t: Readonly<Vec3>): Vec3 | null => {
    const v = unitOf([p[0] - V[0], p[1] - V[1], p[2] - V[2]]);
    const c: Vec3 = [t[1] * v[2] - t[2] * v[1], t[2] * v[0] - t[0] * v[2], t[0] * v[1] - t[1] * v[0]];
    const l = Math.hypot(c[0], c[1], c[2]);
    return l >= G.endOnSin ? [c[0] / l, c[1] / l, c[2] / l] : null;
  };
  /**
   * Where the click aimed `b` beside beam point p along side n (from the vantage, wheel 0; the snap sees
   * `beams`) puts a mass — Reach.vantageClick, the game's placement code — or why no mass can be authored
   * there: nothing placed (illegal, a placed mass grabbed), no snap, snapped onto another part of the beam,
   * or a different point at the other ends of the FOV range (out of snap reach at 60°, hover at 100°).
   */
  const clickBeside = (beams: Beam[], placed: readonly PlacedMass[], p: Readonly<Vec3>, n: Readonly<Vec3>, b: number, size: MassSize): Vec3 | string => {
    const aimAt = offset(p, n, b);
    const c = vantageClick(level, world, placed, beams, aimAt, size);
    if (!c.pos) return `click: ${c.issue ?? 'no point'}`;
    if (!c.snapped) return 'click: no snap';
    const off = dist3(c.pos, p);
    if (off < G.clickBand[0] * b || off > G.clickBand[1] * b) return 'click: snapped elsewhere';
    for (const fov of REACH.aimFovs) {
      const o = vantageClick(level, world, placed, beams, aimAt, size, fov);
      if (!o.pos || !o.snapped || dist3(o.pos, c.pos) > 1e-6 * R) return `click: not at ${fov}°`;
    }
    return qv(c.pos);
  };
  /**
   * The planned spot beside beam point p: side sg·nv at b, else nearer the beam (×0.8 per step, down to
   * bMin), else — when `flip` allows — the same on the other side; the first that passes `ok` (cheap tests),
   * or null. Dense arenas often wall off one side, or the far part of it.
   */
  const freeSpot = (p: Readonly<Vec3>, nv: Readonly<Vec3>, sg: number, b: number, bMin: number, flip: boolean, ok: (q: Vec3) => boolean): { n: Vec3; b: number } | null => {
    for (const side of flip ? [sg, -sg] : [sg]) {
      for (let bb = b; ; bb *= 0.8) {
        const q = Math.max(bb, Math.min(bMin, b));
        if (ok(offset(p, nv, side * q))) return { n: scaled(nv, side), b: q };
        if (q <= bMin) break;
      }
    }
    return null;
  };

  // ---- 1. the source, its beam aimed inward, the first mass clicked beside it ----
  const masses: PlacedMass[] = [];
  const r0 = rho[sizes[0]];
  // The beam's pass point inside a cone toward the centre, so the bent beam still crosses the arena, with a
  // clear line from the source; mass 1 beside it in the view plane (either side); of the candidates that
  // bend well, the one leaving most room. A source in a closed pocket gets replaced (up to 4 per attempt).
  const reach = sizes.length > 1 ? G.firstReach : G.firstReachSingle;
  const range1 = sizes.length >= 3 && G.firstImpact ? G.firstImpact : impact;
  const floor1 = Math.max(range1[0] * r0, G.minImpact * R);
  let src: Vec3 = [0, 0, 0];
  let inward: Vec3 = [0, 0, 1];
  let tr: TraceResult | null = null;
  let bestDir: Vec3 = [0, 0, 1];
  let bestScore = -Infinity;
  let why = 'no free spot for mass 1';
  for (let t = 0, tried = 0; t < 120 && tried < G.bendCandidates; t++) {
    if (t % 30 === 0) {
      if (tr) break;
      tried = 0;
      const s = freePoint(ctx, rng, G.sourceRadius[1], G.sourceClearance * R, (p) => dist3(p, C) >= G.sourceRadius[0] * R);
      if (!s) return reject('no free point for the source');
      src = s;
      inward = unitOf([C[0] - src[0], C[1] - src[1], C[2] - src[2]]);
    }
    const side = randomPerp(rng, inward);
    const ang = G.firstCone * Math.sqrt(rng());
    const w: Vec3 = unitOf([
      inward[0] * Math.cos(ang) + side[0] * Math.sin(ang),
      inward[1] * Math.cos(ang) + side[1] * Math.sin(ang),
      inward[2] * Math.cos(ang) + side[2] * Math.sin(ang),
    ]);
    const L = lerp(reach[0], reach[1], rng()) * R;
    const a = qv([src[0] + L * w[0], src[1] + L * w[1], src[2] + L * w[2]]);
    const dir = stableUnit([a[0] - src[0], a[1] - src[1], a[2] - src[2]]);
    const nv = viewSide(a, dir);
    const sg = rng() < 0.5 ? 1 : -1;
    const b0 = inReach(impactOf(r0, range1), a);
    if (!nv) {
      why = 'leg end-on';
      continue;
    }
    // The planned spot first (cheap; the other side when it is blocked), then the beam the snap sees before
    // any mass, and the click itself.
    const spot1 = freeSpot(a, nv, sg, b0, inReach(floor1, a), true, (q) => inside(q, G.massRadius) && world.de(q[0], q[1], q[2]) >= G.massClearance * r0);
    if (!spot1) continue;
    const n1 = spot1.n;
    const b1 = spot1.b;
    if (!clearLine(world, src, a, 1e-3 * R)) continue;
    level.source = { pos: src, dir };
    const m = clickBeside(trace([]).beams, [], a, n1, b1, sizes[0]);
    if (typeof m === 'string') {
      why = m;
      continue;
    }
    if (!inside(m, G.massRadius) || !(world.de(m[0], m[1], m[2]) >= G.massClearance * r0)) continue;
    tried++;
    const mass: PlacedMass = { size: sizes[0], pos: m, rho: r0 };
    const nt = trace([mass]);
    const b = nt.beams[0];
    const room = b.end === 'captured' ? -1 : roomAfter(b, m);
    if (b.end === 'captured') why = 'captured';
    else if (!(nt.massClosest[0] <= 1.5 * impact[1])) why = 'beam misses mass 1';
    else if (b.deflection < G.minDeflection) why = 'weak bend';
    else if (sizes.length > 1 && nt.massClosest[0] < G.minPass) why = 'close pass';
    else if (room < roomNeeded(0)) why = 'no room after bend 1';
    else {
      // The source leg counts half: it is the first thing the player sees.
      const sc = scoreOf(room, b, m) + 0.5 * G.acrossWeight * R * across(dir);
      if (sc > bestScore) {
        bestScore = sc;
        tr = nt;
        bestDir = dir;
        masses[0] = mass;
      }
    }
  }
  if (!tr) return reject(why);
  level.source = { pos: src, dir: bestDir };

  // ---- 2. further masses beside the beam after the previous bend ----
  for (let i = 1; i < sizes.length; i++) {
    const ri = rho[sizes[i]];
    const prev = masses[i - 1];
    const cur: TraceResult = tr;
    const beam = cur.beams[0];
    const sPrev = closestAlong(beam, prev.pos).s;
    const sMax = Math.min(sPrev + G.bendGap[1] * R, sPrev + roomAfter(beam, prev.pos) - G.seedGap * R);
    if (sMax <= sPrev + G.bendGap[0] * R) return reject(`beam ends after bend ${i}`);
    let pickT: TraceResult | null = null;
    let pickM: PlacedMass | null = null;
    bestScore = -Infinity;
    why = 'spacing';
    // Side the previous bend pulled toward (beam → mass). Bending the other way makes an S, which no
    // single mass can mimic (one mass bends in one plane, one way); same-way bends merge into one arc
    // that one stronger mass reproduces, and the minimal gate rejects them.
    const pp = pointAt(beam, sPrev);
    const prevSide = unitOf([prev.pos[0] - pp.p[0], prev.pos[1] - pp.p[1], prev.pos[2] - pp.p[2]]);
    const zigzag = sizes.length === 2 && rng() < G.zigzag;
    const spaced = (p: Readonly<Vec3>): boolean => inside(p, G.massRadius) && dist3(p, src) >= 0.2 * R && !masses.some((o) => dist3(o.pos, p) < G.massSpacing * R);
    const floor = Math.max(impact[0] * ri, G.minImpact * R);
    for (let t = 0, tried = 0; t < G.bendDraws && tried < G.bendCandidates; t++) {
      const at = pointAt(beam, lerp(sPrev + G.bendGap[0] * R, sMax, rng()));
      const nv = viewSide(at.p, at.t);
      let sg = rng() < 0.5 ? 1 : -1;
      const b0 = inReach(impactOf(ri), at.p);
      if (!nv) {
        why = 'leg end-on';
        continue;
      }
      if (zigzag) {
        // The previous side, made ⟂ to the beam here; the new side must point away from it.
        const k = prevSide[0] * at.t[0] + prevSide[1] * at.t[1] + prevSide[2] * at.t[2];
        const ps = unitOf([prevSide[0] - k * at.t[0], prevSide[1] - k * at.t[1], prevSide[2] - k * at.t[2]]);
        const c = nv[0] * ps[0] + nv[1] * ps[1] + nv[2] * ps[2];
        sg = c > 0 ? -1 : 1;
        if (Math.abs(c) < G.zigzagMin) {
          why = 'no S in view';
          continue;
        }
      }
      if (!zigzag && rng() < G.inwardBias) sg = nv[0] * (C[0] - at.p[0]) + nv[1] * (C[1] - at.p[1]) + nv[2] * (C[2] - at.p[2]) >= 0 ? 1 : -1;
      // The planned spot first (cheap; the other side when it is blocked and the S does not fix the side).
      const spot = freeSpot(at.p, nv, sg, b0, inReach(floor, at.p), !zigzag, (q) => spaced(q) && world.de(q[0], q[1], q[2]) >= G.massClearance * ri);
      if (!spot) {
        why = 'structure or spacing';
        continue;
      }
      const n = spot.n;
      const b = spot.b;
      const m = clickBeside(cur.beams, masses, at.p, n, b, sizes[i]);
      if (typeof m === 'string') {
        why = m;
        continue;
      }
      if (!spaced(m)) {
        why = 'spacing';
        continue;
      }
      if (!(world.de(m[0], m[1], m[2]) >= G.massClearance * ri)) {
        why = 'structure';
        continue;
      }
      tried++;
      const mass: PlacedMass = { size: sizes[i], pos: m, rho: ri };
      const nt = trace([...masses, mass]);
      const nb = nt.beams[0];
      const room = nb.end === 'captured' ? -1 : roomAfter(nb, m);
      if (nb.end === 'captured') why = 'captured';
      else if (!(nt.massClosest[i] <= 1.5 * impact[1])) why = 'missed';
      else if (nt.massClosest.some((q, j) => j < i && !(q <= 2 * impact[1]))) why = 'earlier bend lost';
      else if (nb.deflection - beam.deflection < G.minDeflection) why = 'weak bend';
      else if (nt.massClosest.some((q) => q < G.minPass)) why = 'close pass';
      else if (room < roomNeeded(i)) why = 'no room after';
      else {
        const sc = scoreOf(room, nb, m);
        if (sc > bestScore) {
          bestScore = sc;
          pickT = nt;
          pickM = mass;
        }
      }
    }
    if (!pickT || !pickM) return reject(`no place for mass ${i + 1} (${why})`);
    masses.push(pickM);
    tr = pickT;
  }

  // ---- 3. seeds on the final path ----
  const beam = tr.beams[0];
  const total = endLength(beam);
  const bendS = masses.map((m) => closestAlong(beam, m.pos).s).sort((a, b) => a - b);
  const unlensed = trace([]).beams[0];
  const r = ctx.seedR;
  const maxRho = Math.max(...masses.map((m) => m.rho));
  interface Cand {
    p: Vec3;
    s: number;
    slot: number;
    score: number;
    miss: number;
  }
  const cands: Cand[] = [];
  for (let s = bendS[0] + G.seedGap * R; s < total; s += G.seedStep * R) {
    // Slot j: between bend j and bend j+1 (the last slot runs to the end of the beam).
    let slot = -1;
    for (let j = 0; j < bendS.length; j++) {
      const lo = bendS[j] + G.seedGap * R;
      const hi = j + 1 < bendS.length ? bendS[j + 1] - G.seedGap * R : Infinity;
      if (s >= lo && s <= hi) slot = j;
    }
    if (slot < 0) continue;
    const p = qv(pointAt(beam, s).p);
    if (!inside(p, G.seedRadiusMax)) continue;
    if (dist3(p, src) < 2 * r + 3 * maxRho) continue;
    if (masses.some((m) => dist3(p, m.pos) < r + 2.5 * m.rho)) continue;
    const de = world.de(p[0], p[1], p[2]);
    if (!(de >= G.seedClearance * r)) continue;
    const miss = closestAlong(unlensed, p).d / r;
    if (miss < G.unlensedMiss) continue;
    const near = Math.exp(-(de - r) / (0.1 * R));
    const fresh = Math.exp(-(s - bendS[slot] - G.seedGap * R) / (0.35 * R));
    cands.push({ p, s, slot, miss, score: near + G.freshWeight * fresh + 0.35 * rng() });
  }
  const lastSlot = bendS.length - 1;
  const chosen: Cand[] = [];
  const spaced = (c: Cand): boolean => chosen.every((o) => dist3(o.p, c.p) >= 3 * r && Math.abs(o.s - c.s) >= 3 * r);
  // With k ≥ 2 the seeds must not be reachable by ONE bend: a single mass leaves the beam (nearly)
  // straight after its bend, so the second seed must not share a straight leg from the unlensed beam
  // with the final one (oneLegReach ≥ 1; measured: two-mass levels then pass the minimal gate ~80 %
  // of the time instead of ~25 %). One such pair suffices, so later seeds are free. Larger margins
  // are preferred; structure may also block that single leg, and the minimal gate is the judge.
  const legScore = (c: Cand): number => {
    if (sizes.length < 2 || chosen.length !== 1) return 0;
    return oneLegReach(unlensed, chosen[0].p, c.p, r);
  };
  const oneBend = (c: Cand): boolean => sizes.length > 1 && chosen.length === 1 && legScore(c) < G.oneLegMin;
  const best = (list: Cand[], withLeg = false): Cand | null => {
    let out: Cand | null = null;
    let top = -Infinity;
    for (const c of list) {
      const v = c.score + (withLeg ? G.oneLegWeight * Math.min(legScore(c), 2) : 0);
      if (v > top) {
        top = v;
        out = c;
      }
    }
    return out;
  };
  // The final seed (after the last bend), honouring the "almost" window when asked; the best-scored first,
  // the next ones when the others do not fit beside it (a final seed can leave every other spot on one
  // straight leg with it).
  const almost = opts.almost;
  const finals = cands.filter((c) => c.slot === lastSlot && (!almost || (c.miss >= almost[0] && c.miss <= almost[1])));
  if (finals.length === 0) return reject(almost ? 'no seed in the almost window' : 'no seed spot after the last bend');
  let fallback: Cand[] | null = null;
  for (let f = 0; f < G.finalTries && finals.length > 0; f++) {
    const fin = best(finals) as Cand;
    finals.splice(finals.indexOf(fin), 1);
    chosen.length = 0;
    chosen.push(fin);
    // The others: earlier slots first (one per slot, random order), then anywhere spaced.
    const slots: number[] = [];
    for (let j = 0; j < lastSlot; j++) slots.push(j);
    while (chosen.length < ctx.seedCount && slots.length > 0) {
      const j = pick(rng, slots);
      slots.splice(slots.indexOf(j), 1);
      const c = best(cands.filter((x) => x.slot === j && spaced(x) && !oneBend(x)), true);
      if (c) chosen.push(c);
    }
    while (chosen.length < ctx.seedCount) {
      const c = best(cands.filter((x) => spaced(x) && !oneBend(x)), true);
      if (!c) break;
      chosen.push(c);
    }
    if (chosen.length >= ctx.seedCount) break;
    if (!fallback && chosen.length >= ctx.seedMin) fallback = chosen.slice();
  }
  if (chosen.length < ctx.seedCount && fallback) chosen.splice(0, chosen.length, ...fallback);
  if (chosen.length < ctx.seedMin) return reject('not enough seed spots');
  // Every bend before the last must be needed: with k ≥ 2 masses and fewer seeds than bends the gates
  // (minimal) decide; ids follow the path order.
  chosen.sort((a, b) => a.s - b.s);
  const seeds: SeedDef[] = chosen.map((c, i) => ({ id: String.fromCharCode(97 + i), pos: c.p, radius: r, kind: 'seed', goal: true }));

  // ---- 4. the level ----
  const k = sizes.length;
  const budget: Partial<Record<MassSize, number>> = {};
  for (const s of sizes) budget[s] = (budget[s] ?? 0) + 1;
  const sol = masses.map((m) => ({ size: m.size, pos: m.pos }));
  const first = masses[0];
  const along = Math.max(10, Math.round((closestAlong(tr.beams[0], first.pos).s / Math.max(total, 1e-9)) * 10) * 10);
  const offRho = Math.round(tr.massClosest[0]);
  // Seeds carry no visible labels in the game (SeedChip has none), so hints name them by path order.
  const many = seeds.length > 1;
  const raw = {
    ...ctx.base,
    source: { pos: level.source.pos, dir: level.source.dir },
    seeds,
    budget,
    solution: sol,
    par: k,
    hintMass: 0,
    hints: [
      k === 1 ? 'One mass is enough: light bends toward it.' : `The beam must turn ${k} times: one mass for each turn.`,
      `${many ? 'Light the seeds in the order the light reaches them. ' : ''}` +
        `The first turn happens about ${along} % of the way along the star's beam.`,
      `A ${first.size} mass about ${offRho} ρ beside the beam there turns it onto the ${many ? 'first ' : ''}seed` +
        (k > 1 ? '; each further mass sits beside the new beam and turns it once more.' : '.'),
    ] as [string, string, string],
    teach: k === 1 ? 'A mass bends light toward itself.' : k === 2 ? 'Two bends in series add up.' : 'Bends compose: each mass turns the beam once more.',
  };
  const errors: string[] = [];
  const out = sanitizeLevel(raw, errors);
  if (!out) return reject(`sanitize: ${errors[0] ?? '?'}`);
  return { level: out, evals };
}

/** Generates a level for the arena; see the header. Deterministic per (opts, seed). */
export function generateLevel(opts: GenerateOptions): GenerateResult {
  const t0 = performance.now();
  const R = opts.arena.radiusLocal;
  const k = opts.masses.length;
  const rho = { ...LEVEL_LIMITS.defaultRho, ...(opts.rho ?? {}) } as Record<MassSize, number>;
  const rhoLocal: Record<MassSize, number> = { light: q6(rho.light * R), medium: q6(rho.medium * R), heavy: q6(rho.heavy * R) };
  const seedCount = Math.max(1, Math.min(opts.seedCount ?? Math.min(k, 3), k + 1, LEVEL_LIMITS.maxSeeds));
  const seedMin = opts.seedCount !== undefined ? seedCount : Math.min(k, 2);
  const seedR = q6((opts.seedRadius ?? GENERATOR.seedRadius) * R);
  const base: LevelDef = {
    id: opts.id ?? `gen-${opts.nebula}-${opts.seed >>> 0}`,
    chapter: opts.chapter ?? 'gen',
    index: opts.index ?? 1,
    name: opts.name ?? 'First Light',
    nebula: opts.nebula,
    arena: opts.arena,
    source: { pos: [0, 0, 0], dir: [0, 0, 1] },
    seeds: [],
    masses: rhoLocal,
    budget: {},
    solution: [],
    hints: ['', '', ''],
    teach: '',
    par: k,
  };
  if (opts.clock !== undefined) base.clock = opts.clock;
  if (opts.material !== undefined) base.material = opts.material;
  const ctx: Ctx = {
    opts,
    base,
    world: makeTraceWorld(base),
    R,
    C: opts.arena.centerLocal,
    rho: rhoLocal,
    impact: opts.impact ?? GENERATOR.impact,
    seedR,
    seedCount,
    seedMin,
  };
  const result: GenerateResult = { level: null, report: null, reach: null, attempts: 0, evals: 0, ms: 0, rejects: {} };
  const reachOpts: QuickReachOptions | null = opts.reach === true ? {} : opts.reach ? { ...opts.reach } : null;
  const count = (reason: string): void => {
    result.rejects[reason] = (result.rejects[reason] ?? 0) + 1;
  };
  if (k < 1 || k > LEVEL_LIMITS.maxBudget || !(R > 0)) {
    count('bad request');
    result.ms = performance.now() - t0;
    return result;
  }
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? GENERATOR.maxAttempts));
  for (let a = 0; a < maxAttempts; a++) {
    result.attempts = a + 1;
    const sub = hash2(opts.seed >>> 0, a);
    const at = attempt(ctx, mulberry32(sub));
    result.evals += at.evals;
    if ('reject' in at) {
      count(at.reject);
      continue;
    }
    // Click reachability first: tens to a few hundred traces, against thousands for the minimal gate.
    if (reachOpts) {
      const rr = quickReach(at.level, { ...reachOpts, world: ctx.world });
      result.evals += rr.traces;
      result.reach = rr;
      if (!rr.pass) {
        count(`reach: ${rr.failure}`);
        continue;
      }
    }
    // Default gate seed (fnv1a(level.id)): tools/fl-check.ts and fl-solve gates then reproduce this
    // exact verdict (the minimal gate is a heuristic search; another seed could disagree, rarely).
    const rep = gates(at.level, { ...(opts.gates ?? {}), world: ctx.world, earlyExit: true });
    result.evals += rep.evals;
    result.report = rep;
    if (!rep.pass) {
      count(`gate: ${rep.failures[0]}`);
      continue;
    }
    result.level = at.level;
    break;
  }
  result.ms = performance.now() - t0;
  return result;
}
