/**
 * First Light — placement legality, the solver and the level gates (design/20-first-light.md §2.3,
 * §7.4; design/60-first-light-build.md §L, §M "Placement/legality").
 *
 * Pure TypeScript (no three.js, no DOM): the Node tools, the generator and the runtime daily share it.
 * Everything is in the LOCAL frame of the level's nebula. Deterministic: all randomness comes from
 * mulberry32 streams derived from `opts.seed`, and every budget is an evaluation COUNT (never wall
 * time), so the same input gives the same answer on every machine. One evaluation = one full
 * `traceLevel` call.
 *
 * Legality (exactly the game's rules, build plan §M; R = arena radius, ρ = the mass's Schwarzschild
 * radius). A mass may not be placed
 *   - outside the arena                  |p − centre| > R                  "outside the arena"
 *   - near the source                    |p − source| < 3ρ                 "too close to the star"
 *   - near a seed                        |p − seed| < r_seed + 2ρ          "too close to a seed"
 *   - near another mass                  |p − q| < 3·max(ρ, ρ_q)           "too close to a mass"
 *   - inside structure                   DE(p) < 2ρ                        "inside structure"
 * (the mass–mass rule uses the larger ρ so a pair's legality does not depend on which came last).
 *
 * Objective (0 ⇔ solved): Σ over goal seeds of max(0, closest/r − 1); a seed the beam enters too dim
 * to light (after reflections) costs `SOLVE.dimPenalty`; any captured beam adds `SOLVE.capturePenalty`.
 *
 * Search (solve): per mass multiset, restarts of
 *   1. a beam-guided construction — a small beam search that adds one mass at a time at candidates
 *      within [2.8, 20] ρ of the CURRENT beam (log-uniform distance, random side), plus a share of
 *      uniformly random legal points anywhere in the arena (far-field bends);
 *   2. local optimisation — a (1+1) evolution strategy per mass (Gaussian steps, σ ×1.6 on success,
 *      ×0.85 on failure, from 1.5ρ down to 0.02ρ), illegal proposals rejected without a trace.
 * Any configuration with objective 0 ends the search (a partial one solves with fewer masses).
 *
 * Gates (gates): unlensedFails, solutionWorks, solutionLegal, par (solution ≤ par masses), minimal
 * (heuristic: no sub-multiset of the budget with fewer than `par` masses solves within
 * `minimalEvals` × its size evaluations each), accidental (< 1 % of random legal full-budget placements solve),
 * robust (≥ 90 % solve with every mass moved 5 % of ρ in a random direction), tolerant (≥ 70 % solve
 * with every mass moved up to 0.6 % R in the plane ⟂ vantage → mass, uniform in the disc), pathLength
 * (light-travel distance to the last goal seed ∈ [0.5, 4] R) and bends (masses passed within 20ρ plus
 * reflections, ≥ 1). They run cheap first (GATE_ORDER); with `earlyExit` (the generator) the first
 * failure ends the run and the rest are listed in `skipped`. Cost: ~600 traces (≈ 50 ms) without the
 * minimal gate, plus ≤ minimalEvals traces per smaller multiset tried.
 *
 * Public API:
 *   LEGALITY, SOLVE, GATES, GATE_ORDER                             tunables
 *   placementIssue(level, world, rho, pos, others, skip?) → PlacementIssue | null
 *   objectiveOf(level, result) → number
 *   solve(level, budget, opts?) → SolveResult
 *   gates(level, opts?) → GateReport
 *   multisetKey(sizes), budgetSizes(budget), subMultisets(budget, maxTotal)
 */
import type { Vec3 } from '../../core/types';
import { fnv1a, hash2, mulberry32, shuffle, type Rng } from '../platform/prng';
import { traceLevel } from './BeamTracer';
import { totalBudget } from './Level';
import { makeTraceWorld } from './world';
import { MASS_SIZES, type LevelDef, type MassSize, type PlacedMass, type TraceResult, type TraceWorld } from './types';

/** Placement rules (build plan §M), in units of the placed mass's ρ. */
export const LEGALITY = {
  /** DE ≥ this × ρ. */
  structure: 2,
  /** Mass–mass distance ≥ this × max(ρ_a, ρ_b). */
  mass: 3,
  /** Seed distance ≥ seed radius + this × ρ. */
  seed: 2,
  /** Source distance ≥ this × ρ. */
  source: 3,
} as const;

export type PlacementIssue =
  | 'outside the arena'
  | 'too close to the star'
  | 'too close to a seed'
  | 'too close to a mass'
  | 'inside structure';

/** Solver tunables (distances × ρ of the mass being placed unless noted). */
export const SOLVE = {
  /** Default evaluation budget of solve(). */
  maxEvals: 3000,
  /** Beam-guided candidates: distance from the current beam, log-uniform in [near, far]. */
  near: 2.8,
  far: 20,
  /** Share of construction candidates drawn uniformly from the whole legal arena. */
  globalShare: 0.25,
  /** Construction beam search: candidates per node, nodes kept per depth. */
  branch: 18,
  width: 3,
  /** Local optimisation evaluations per mass per restart. */
  optimiseEvals: 90,
  /** (1+1)-ES step size: start, floor, cap. */
  sigma0: 1.5,
  sigmaMin: 0.02,
  sigmaMax: 6,
  /** Objective penalties. */
  capturePenalty: 0.3,
  dimPenalty: 0.25,
} as const;

/** Gate thresholds and trial counts. */
export const GATES = {
  accidentalMax: 0.01,
  accidentalTrials: 500,
  robustMin: 0.9,
  robustTrials: 50,
  /** Robustness jitter: every mass moves this × ρ in a random direction. */
  robustJitter: 0.05,
  tolerantMin: 0.7,
  tolerantTrials: 60,
  /** Player tolerance: up to this × R in the view plane (uniform in the disc). */
  tolerantJitter: 0.006,
  /** Minimal gate budget per sub-multiset: this × its number of masses (two-mass solutions take longer to find). */
  minimalEvals: 2500,
  /** Light-travel distance to the last goal seed, × R. */
  pathMin: 0.5,
  pathMax: 4,
  bendsMin: 1,
  /** A mass counts as a bend when a beam passes within this × ρ (deflection ≳ 0.1 rad). */
  bendRange: 20,
} as const;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const SIZE_ORDER: Record<MassSize, number> = { light: 0, medium: 1, heavy: 2 };

/** The budget as a list of sizes, heaviest first (e.g. { light: 1, medium: 2 } → medium, medium, light). */
export function budgetSizes(budget: Partial<Record<MassSize, number>>): MassSize[] {
  const out: MassSize[] = [];
  for (let k = MASS_SIZES.length - 1; k >= 0; k--) {
    const s = MASS_SIZES[k];
    const n = budget[s] ?? 0;
    for (let i = 0; i < n; i++) out.push(s);
  }
  return out;
}

/** Stable printable key of a multiset, e.g. "medium×2+light". */
export function multisetKey(sizes: readonly MassSize[]): string {
  if (sizes.length === 0) return '∅';
  const parts: string[] = [];
  for (let k = MASS_SIZES.length - 1; k >= 0; k--) {
    const s = MASS_SIZES[k];
    let n = 0;
    for (const x of sizes) if (x === s) n++;
    if (n > 0) parts.push(n > 1 ? `${s}×${n}` : s);
  }
  return parts.join('+');
}

/**
 * Every non-empty sub-multiset of the budget with at most `maxTotal` masses, smallest first (then
 * lighter first): the order in which the minimal gate and solve({ subsets }) try them.
 */
export function subMultisets(budget: Partial<Record<MassSize, number>>, maxTotal: number): MassSize[][] {
  const out: MassSize[][] = [];
  const nl = budget.light ?? 0;
  const nm = budget.medium ?? 0;
  const nh = budget.heavy ?? 0;
  for (let h = 0; h <= nh; h++) {
    for (let m = 0; m <= nm; m++) {
      for (let l = 0; l <= nl; l++) {
        const n = h + m + l;
        if (n === 0 || n > maxTotal) continue;
        out.push(budgetSizes({ light: l, medium: m, heavy: h }));
      }
    }
  }
  const weight = (s: MassSize[]): number => s.reduce((a, x) => a + SIZE_ORDER[x], 0);
  out.sort((a, b) => a.length - b.length || weight(a) - weight(b));
  return out;
}

const dist3 = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Standard normal from two uniforms (Box–Muller; deterministic given the stream). */
function gauss(rng: Rng): number {
  const u = 1 - rng(); // (0, 1]
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Uniform random unit vector into out. */
function randomUnit(rng: Rng, out: Vec3): Vec3 {
  const z = 2 * rng() - 1;
  const a = 2 * Math.PI * rng();
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  out[0] = s * Math.cos(a);
  out[1] = s * Math.sin(a);
  out[2] = z;
  return out;
}

/** Two unit vectors spanning the plane ⟂ d (d need not be normalised; falls back to any basis). */
function perpBasis(d: Readonly<Vec3>, e1: Vec3, e2: Vec3): void {
  const l = Math.hypot(d[0], d[1], d[2]);
  const x = l > 0 ? d[0] / l : 0;
  const y = l > 0 ? d[1] / l : 0;
  const z = l > 0 ? d[2] / l : 1;
  // Helper axis least aligned with d.
  const ax = Math.abs(x) < 0.6 ? 1 : 0;
  const ay = ax === 0 && Math.abs(y) < 0.6 ? 1 : 0;
  const az = ax === 0 && ay === 0 ? 1 : 0;
  let ux = ay * z - az * y;
  let uy = az * x - ax * z;
  let uz = ax * y - ay * x;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  e1[0] = ux;
  e1[1] = uy;
  e1[2] = uz;
  e2[0] = y * uz - z * uy;
  e2[1] = z * ux - x * uz;
  e2[2] = x * uy - y * ux;
}

// ---------------------------------------------------------------------------------------------
// Legality and objective
// ---------------------------------------------------------------------------------------------

/**
 * Why a mass of Schwarzschild radius `rho` may not sit at `pos`, or null when it may (build plan §M).
 * `others` are the masses already placed; `skip` excludes one of them (the mass being dragged).
 * Cheap tests first; the DE (the only expensive one) last.
 */
export function placementIssue(
  level: LevelDef,
  world: TraceWorld,
  rho: number,
  pos: Readonly<Vec3>,
  others: readonly PlacedMass[],
  skip = -1,
): PlacementIssue | null {
  const x = pos[0];
  const y = pos[1];
  const z = pos[2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !(rho > 0)) return 'outside the arena';
  const c = level.arena.centerLocal;
  const R = level.arena.radiusLocal;
  if (Math.hypot(x - c[0], y - c[1], z - c[2]) > R) return 'outside the arena';
  if (dist3(pos, level.source.pos) < LEGALITY.source * rho) return 'too close to the star';
  for (const s of level.seeds) {
    if (dist3(pos, s.pos) < s.radius + LEGALITY.seed * rho) return 'too close to a seed';
  }
  for (let i = 0; i < others.length; i++) {
    if (i === skip) continue;
    const o = others[i];
    if (dist3(pos, o.pos) < LEGALITY.mass * Math.max(rho, o.rho)) return 'too close to a mass';
  }
  const d = world.de(x, y, z);
  if (!(d >= LEGALITY.structure * rho)) return 'inside structure';
  return null;
}

/** 0 when solved; otherwise how far the goal seeds are from being lit (see the header). */
export function objectiveOf(level: LevelDef, r: TraceResult): number {
  if (r.solved) return 0;
  let f = 0;
  for (const s of level.seeds) {
    if (!s.goal) continue;
    const st = r.seeds[s.id];
    if (!st || st.lit) continue;
    const c = st.closest;
    if (!(c < Infinity)) {
      f += 1e3;
      continue;
    }
    f += c > s.radius ? c / s.radius - 1 : SOLVE.dimPenalty;
  }
  for (const b of r.beams) {
    if (b.end === 'captured') {
      f += SOLVE.capturePenalty;
      break;
    }
  }
  // An unsolved trace never reads as 0 (all goals lit but `solved` false cannot happen, but be safe).
  return f > 0 ? f : 1e-9;
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

interface Node {
  masses: PlacedMass[];
  trace: TraceResult;
  obj: number;
}

interface Outcome {
  solved: boolean;
  masses: PlacedMass[];
  obj: number;
}

/** One search context: level, world, random stream and the evaluation counter. */
class Search {
  evals = 0;
  private unlensed: Node | null = null;
  private readonly tmp: Vec3 = [0, 0, 0];
  private readonly e1: Vec3 = [0, 0, 0];
  private readonly e2: Vec3 = [0, 0, 0];

  constructor(
    readonly level: LevelDef,
    readonly world: TraceWorld,
    readonly rng: Rng,
  ) {}

  evaluate(masses: PlacedMass[]): Node {
    this.evals++;
    const trace = traceLevel(this.level, this.world, masses);
    return { masses, trace, obj: objectiveOf(this.level, trace) };
  }

  root(): Node {
    if (!this.unlensed) this.unlensed = this.evaluate([]);
    return this.unlensed;
  }

  rhoOf(size: MassSize): number {
    return this.level.masses[size];
  }

  legal(rho: number, pos: Readonly<Vec3>, others: readonly PlacedMass[], skip = -1): boolean {
    return placementIssue(this.level, this.world, rho, pos, others, skip) === null;
  }

  /** A uniformly random legal point of the arena ball, or null after `tries` rejections. */
  randomLegal(rho: number, others: readonly PlacedMass[], tries = 200): Vec3 | null {
    const c = this.level.arena.centerLocal;
    const R = this.level.arena.radiusLocal;
    const rng = this.rng;
    for (let i = 0; i < tries; i++) {
      const x = 2 * rng() - 1;
      const y = 2 * rng() - 1;
      const z = 2 * rng() - 1;
      if (x * x + y * y + z * z > 1) continue;
      const p: Vec3 = [c[0] + x * R, c[1] + y * R, c[2] + z * R];
      if (this.legal(rho, p, others)) return p;
    }
    return null;
  }

  /**
   * A legal point within [near, far] ρ of a beam of `trace` (log-uniform distance, random side, a
   * random point along the beam's path inside the arena), or null after `tries` rejections.
   */
  nearBeam(trace: TraceResult, rho: number, others: readonly PlacedMass[], tries = 24): Vec3 | null {
    const rng = this.rng;
    const c = this.level.arena.centerLocal;
    const R = this.level.arena.radiusLocal;
    const beams = trace.beams;
    let total = 0;
    for (const b of beams) total += b.length[b.length.length - 1];
    if (!(total > 0)) return null;
    const lnNear = Math.log(SOLVE.near);
    const lnFar = Math.log(SOLVE.far);
    for (let t = 0; t < tries; t++) {
      // Beam by length, then a point by arc length (binary search on the cumulative lengths).
      let s = rng() * total;
      let bi = 0;
      while (bi < beams.length - 1 && s > beams[bi].length[beams[bi].length.length - 1]) {
        s -= beams[bi].length[beams[bi].length.length - 1];
        bi++;
      }
      const b = beams[bi];
      const L = b.length;
      let lo = 0;
      let hi = L.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (L[mid] <= s) lo = mid;
        else hi = mid;
      }
      const P = b.points;
      const seg = L[hi] - L[lo];
      const f = seg > 0 ? Math.min(Math.max((s - L[lo]) / seg, 0), 1) : 0;
      const ax = P[3 * lo];
      const ay = P[3 * lo + 1];
      const az = P[3 * lo + 2];
      const dx = P[3 * hi] - ax;
      const dy = P[3 * hi + 1] - ay;
      const dz = P[3 * hi + 2] - az;
      const px = ax + f * dx;
      const py = ay + f * dy;
      const pz = az + f * dz;
      if (Math.hypot(px - c[0], py - c[1], pz - c[2]) > R * 1.05) continue;
      const tan = this.tmp;
      tan[0] = dx;
      tan[1] = dy;
      tan[2] = dz;
      perpBasis(tan, this.e1, this.e2);
      const a = 2 * Math.PI * rng();
      const d = rho * Math.exp(lnNear + rng() * (lnFar - lnNear));
      const ca = Math.cos(a) * d;
      const sa = Math.sin(a) * d;
      const p: Vec3 = [
        px + ca * this.e1[0] + sa * this.e2[0],
        py + ca * this.e1[1] + sa * this.e2[1],
        pz + ca * this.e1[2] + sa * this.e2[2],
      ];
      if (this.legal(rho, p, others)) return p;
    }
    return null;
  }

  /** Beam-guided construction (a small beam search over the placement order `sizes`). */
  construct(sizes: readonly MassSize[], end: number): Node {
    let frontier: Node[] = [this.root()];
    let best = frontier[0];
    for (let i = 0; i < sizes.length; i++) {
      const size = sizes[i];
      const rho = this.rhoOf(size);
      const children: Node[] = [];
      for (const node of frontier) {
        for (let j = 0; j < SOLVE.branch; j++) {
          if (this.evals >= end) break;
          const p =
            this.rng() < SOLVE.globalShare ? this.randomLegal(rho, node.masses) : this.nearBeam(node.trace, rho, node.masses);
          if (!p) continue;
          const child = this.evaluate([...node.masses, { size, pos: p, rho }]);
          if (child.obj === 0) return child;
          children.push(child);
          if (child.obj < best.obj || (best.masses.length < child.masses.length && child.obj <= best.obj)) best = child;
        }
      }
      if (children.length === 0) break;
      children.sort((a, b) => a.obj - b.obj);
      frontier = children.slice(0, SOLVE.width);
    }
    // Prefer the best complete configuration (the optimiser moves every mass).
    return frontier[0].masses.length === sizes.length ? frontier[0] : best;
  }

  /** (1+1)-ES local optimisation of every mass of `start` (see the header). */
  optimise(start: Node, end: number): Node {
    let cur = start;
    const n = cur.masses.length;
    if (n === 0) return cur;
    const sigma = cur.masses.map((m) => SOLVE.sigma0 * m.rho);
    let rejects = 0;
    let k = 0;
    while (this.evals < end && cur.obj > 0) {
      const i = k++ % n;
      const m = cur.masses[i];
      if (sigma[i] < SOLVE.sigmaMin * m.rho) {
        // Converged on this mass; stop when every mass has converged.
        if (sigma.every((s, j) => s < SOLVE.sigmaMin * cur.masses[j].rho)) break;
        continue;
      }
      const s = sigma[i];
      const p: Vec3 = [m.pos[0] + s * gauss(this.rng), m.pos[1] + s * gauss(this.rng), m.pos[2] + s * gauss(this.rng)];
      if (!this.legal(m.rho, p, cur.masses, i)) {
        sigma[i] *= 0.85;
        if (++rejects > 50 * n) break;
        continue;
      }
      const masses = cur.masses.slice();
      masses[i] = { size: m.size, pos: p, rho: m.rho };
      const next = this.evaluate(masses);
      if (next.obj < cur.obj) {
        cur = next;
        sigma[i] = Math.min(sigma[i] * 1.6, SOLVE.sigmaMax * m.rho);
      } else {
        sigma[i] *= 0.85;
      }
    }
    return cur;
  }

  /** Restarts of construct + optimise for one multiset until solved or `budget` evaluations. */
  run(sizes: readonly MassSize[], budget: number): Outcome {
    const end = this.evals + budget;
    let best: Node = this.root();
    if (best.obj === 0) return { solved: true, masses: [], obj: 0 };
    let restart = 0;
    while (this.evals < end && sizes.length > 0) {
      const before = this.evals;
      const order = restart === 0 ? sizes.slice() : shuffle(this.rng, sizes.slice());
      const built = this.construct(order, end);
      const opt = built.obj === 0 ? built : this.optimise(built, Math.min(end, this.evals + SOLVE.optimiseEvals * sizes.length));
      if (opt.obj < best.obj) best = opt;
      if (opt.obj === 0) return { solved: true, masses: opt.masses, obj: 0 };
      restart++;
      // No legal candidate anywhere (a crowded arena): more restarts cannot help.
      if (this.evals === before) break;
    }
    return { solved: false, masses: best.masses, obj: best.obj };
  }
}

// ---------------------------------------------------------------------------------------------
// solve()
// ---------------------------------------------------------------------------------------------

export interface SolveOptions {
  /** Random stream seed (default fnv1a(level.id)). */
  seed?: number;
  /** Evaluation (trace) budget (default SOLVE.maxEvals). */
  maxEvals?: number;
  /** Reuse a trace world (default makeTraceWorld(level)). */
  world?: TraceWorld;
  /**
   * Try the budget's sub-multisets smallest first, sharing the budget in proportion to their size
   * (default true): the result may use fewer masses than the budget. false = the full multiset only
   * (a partial configuration that happens to solve still counts).
   */
  subsets?: boolean;
}

export interface SolveResult {
  solved: boolean;
  /** The solution when solved, else the best configuration found. */
  masses: PlacedMass[];
  /** Objective of `masses` (0 when solved). */
  objective: number;
  /** Trace evaluations used. */
  evals: number;
  /** Wall time (diagnostics only; never steers the search). */
  ms: number;
  /** Multisets tried, in order (multisetKey). */
  tried: string[];
}

/** Searches for a placement of (at most) `budget` that solves the level. Deterministic per seed. */
export function solve(level: LevelDef, budget: Partial<Record<MassSize, number>>, opts: SolveOptions = {}): SolveResult {
  const t0 = performance.now();
  const world = opts.world ?? makeTraceWorld(level);
  const maxEvals = Math.max(1, Math.floor(opts.maxEvals ?? SOLVE.maxEvals));
  const seed = opts.seed ?? fnv1a(level.id);
  const full = budgetSizes(budget);
  const sets = opts.subsets === false ? (full.length > 0 ? [full] : []) : subMultisets(budget, full.length);
  const totalWeight = sets.reduce((a, s) => a + s.length, 0);
  const search = new Search(level, world, mulberry32(hash2(seed, 0x50)));
  const tried: string[] = [];
  let best: Outcome = { solved: false, masses: [], obj: search.root().obj };
  if (best.obj === 0) best = { solved: true, masses: [], obj: 0 };
  for (let i = 0; i < sets.length && !best.solved; i++) {
    const remaining = maxEvals - search.evals;
    if (remaining <= 0) break;
    // Proportional share; the last multiset gets whatever is left.
    const share = i === sets.length - 1 ? remaining : Math.max(1, Math.floor((maxEvals * sets[i].length) / totalWeight));
    tried.push(multisetKey(sets[i]));
    const o = search.run(sets[i], Math.min(share, remaining));
    if (o.solved || o.obj < best.obj) best = o;
  }
  return {
    solved: best.solved,
    masses: best.masses,
    objective: best.obj,
    evals: search.evals,
    ms: performance.now() - t0,
    tried,
  };
}

// ---------------------------------------------------------------------------------------------
// gates()
// ---------------------------------------------------------------------------------------------

export interface GateOptions {
  /** Random stream seed (default fnv1a(level.id)). */
  seed?: number;
  /** Reuse a trace world (default makeTraceWorld(level)). */
  world?: TraceWorld;
  accidentalTrials?: number;
  robustTrials?: number;
  tolerantTrials?: number;
  /** Minimal gate: evaluations per mass of each sub-multiset tried (0 skips the gate: minimal = true, untested). */
  minimalEvals?: number;
  /** Stop at the first failed gate (the generator's mode); later fields keep their defaults. */
  earlyExit?: boolean;
}

export interface MinimalTry {
  masses: string;
  solved: boolean;
  evals: number;
  /** The configuration that solved (when solved): what the designer should look at. */
  solution?: { size: MassSize; pos: Vec3 }[];
}

export interface GateReport {
  /** Every gate passed. */
  pass: boolean;
  /** Names of the failed gates (e.g. "accidental"), in GATE_ORDER. */
  failures: string[];
  /** Gates not evaluated (earlyExit stopped before them); their fields keep the defaults. */
  skipped: string[];
  unlensedFails: boolean;
  /** "Almost" measure: min over goal seeds of the unlensed beam's closest approach / r. */
  unlensedClosest: number;
  solutionWorks: boolean;
  solutionLegal: boolean;
  /** Legality problems of the authored solution ("solution[1]: too close to a seed"). */
  solutionIssues: string[];
  /** The authored solution uses ≤ par masses. */
  parOk: boolean;
  minimal: boolean;
  minimalTried: MinimalTry[];
  /** Fraction of random legal full-budget placements that solve. */
  accidental: number;
  accidentalTrials: number;
  robust: number;
  tolerant: number;
  /** Light-travel distance from the source to the last goal seed of the solution (× R; ≈ via the polyline). */
  pathLength: number;
  /** Masses of the solution passed within GATES.bendRange ρ, plus reflections. */
  bends: number;
  evals: number;
  ms: number;
  /** Wall time per stage (ms). */
  timing: { basic: number; robust: number; tolerant: number; accidental: number; minimal: number };
}

/** Every gate, in evaluation order (cheap first). */
export const GATE_ORDER = ['solutionLegal', 'par', 'solutionWorks', 'unlensedFails', 'pathLength', 'bends', 'robust', 'tolerant', 'accidental', 'minimal'] as const;

/** Light-travel distance to each lit seed (≈: nearest polyline point to the seed's closest point). */
function seedTimes(level: LevelDef, r: TraceResult): Map<string, number> {
  const times = new Map<string, number>();
  const pending = level.seeds.filter((s) => r.seeds[s.id]?.lit && r.seeds[s.id].closestPoint);
  // Beams are stored in processing order = light-travel order; an echo beam starts when its seed lit.
  for (const b of r.beams) {
    const t0 = b.from === null ? 0 : times.get(b.from) ?? 0;
    const P = b.points;
    const n = P.length / 3;
    for (const s of pending) {
      const q = r.seeds[s.id].closestPoint as Vec3;
      let bestD = Infinity;
      let bestT = 0;
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
        if (d < bestD) {
          bestD = d;
          bestT = b.length[i] + t * (b.length[i + 1] - b.length[i]);
        }
      }
      if (bestD <= s.radius) {
        const t = t0 + bestT;
        const prev = times.get(s.id);
        if (prev === undefined || t < prev) times.set(s.id, t);
      }
    }
  }
  return times;
}

/** Runs every gate of the build plan §L on a (sanitised) level. Deterministic per seed. */
export function gates(level: LevelDef, opts: GateOptions = {}): GateReport {
  const t0 = performance.now();
  const world = opts.world ?? makeTraceWorld(level);
  const seed = opts.seed ?? fnv1a(level.id);
  const R = level.arena.radiusLocal;
  const early = opts.earlyExit === true;
  let evals = 0;
  const trace = (masses: readonly PlacedMass[]): TraceResult => {
    evals++;
    return traceLevel(level, world, masses);
  };

  const rep: GateReport = {
    pass: false,
    failures: [],
    skipped: [],
    unlensedFails: false,
    unlensedClosest: NaN,
    solutionWorks: false,
    solutionLegal: false,
    solutionIssues: [],
    parOk: false,
    minimal: false,
    minimalTried: [],
    accidental: NaN,
    accidentalTrials: 0,
    robust: NaN,
    tolerant: NaN,
    pathLength: NaN,
    bends: 0,
    evals: 0,
    ms: 0,
    timing: { basic: 0, robust: 0, tolerant: 0, accidental: 0, minimal: 0 },
  };
  const done = new Set<string>();
  const finish = (): GateReport => {
    rep.skipped = GATE_ORDER.filter((g) => !done.has(g));
    rep.pass = rep.failures.length === 0 && rep.skipped.length === 0;
    rep.evals = evals;
    rep.ms = performance.now() - t0;
    return rep;
  };
  /** Records a gate result; true when the caller should stop (failed with earlyExit). */
  const check = (name: string, ok: boolean): boolean => {
    done.add(name);
    if (ok) return false;
    rep.failures.push(name);
    return early;
  };

  // ---- basic: legality, solution, unlensed, path, bends ----
  let ts = performance.now();
  const sol: PlacedMass[] = level.solution.map((m) => ({ size: m.size, pos: [m.pos[0], m.pos[1], m.pos[2]], rho: level.masses[m.size] }));
  for (let i = 0; i < sol.length; i++) {
    // Against the earlier masses only: the symmetric mass–mass rule then reports each pair once (on the
    // later mass) without hiding a mass's other problems.
    const issue = placementIssue(level, world, sol[i].rho, sol[i].pos, sol.slice(0, i));
    if (issue) rep.solutionIssues.push(`solution[${i}]: ${issue}`);
  }
  rep.solutionLegal = rep.solutionIssues.length === 0;
  rep.parOk = level.solution.length <= level.par && level.par <= totalBudget(level);
  if (check('solutionLegal', rep.solutionLegal)) return finish();
  if (check('par', rep.parOk)) return finish();

  const solved = trace(sol);
  rep.solutionWorks = solved.solved;
  if (check('solutionWorks', rep.solutionWorks)) return finish();

  const unlensed = trace([]);
  rep.unlensedFails = !unlensed.solved;
  let almost = Infinity;
  for (const s of level.seeds) {
    if (!s.goal) continue;
    const st = unlensed.seeds[s.id];
    if (st) almost = Math.min(almost, st.closest / s.radius);
  }
  rep.unlensedClosest = almost;
  if (check('unlensedFails', rep.unlensedFails)) return finish();

  if (solved.solved) {
    const times = seedTimes(level, solved);
    let last = 0;
    for (const s of level.seeds) if (s.goal) last = Math.max(last, times.get(s.id) ?? NaN);
    rep.pathLength = last / R;
  } else {
    let total = 0;
    for (const b of solved.beams) total += b.length[b.length.length - 1];
    rep.pathLength = total / R;
  }
  let bends = 0;
  for (const q of solved.massClosest) if (q <= GATES.bendRange) bends++;
  for (const b of solved.beams) bends += b.reflections.length / 3;
  rep.bends = bends;
  if (check('pathLength', rep.pathLength >= GATES.pathMin && rep.pathLength <= GATES.pathMax)) return finish();
  if (check('bends', rep.bends >= GATES.bendsMin)) return finish();
  rep.timing.basic = performance.now() - ts;

  // ---- robust: 5 % of ρ in a random direction ----
  ts = performance.now();
  {
    const rng = mulberry32(hash2(seed, 0x0b));
    const n = Math.max(1, Math.floor(opts.robustTrials ?? GATES.robustTrials));
    const dir: Vec3 = [0, 0, 0];
    let ok = 0;
    for (let t = 0; t < n; t++) {
      const masses = sol.map((m) => {
        randomUnit(rng, dir);
        const j = GATES.robustJitter * m.rho;
        return { size: m.size, rho: m.rho, pos: [m.pos[0] + j * dir[0], m.pos[1] + j * dir[1], m.pos[2] + j * dir[2]] as Vec3 };
      });
      if (trace(masses).solved) ok++;
    }
    rep.robust = ok / n;
  }
  rep.timing.robust = performance.now() - ts;
  if (check('robust', rep.robust >= GATES.robustMin)) return finish();

  // ---- tolerant: ≤ 0.6 % R in the view plane (⟂ vantage → mass), uniform in the disc ----
  ts = performance.now();
  {
    const rng = mulberry32(hash2(seed, 0x70));
    const n = Math.max(1, Math.floor(opts.tolerantTrials ?? GATES.tolerantTrials));
    const v = level.arena.vantage.pos;
    const e1: Vec3 = [0, 0, 0];
    const e2: Vec3 = [0, 0, 0];
    const view: Vec3 = [0, 0, 0];
    let ok = 0;
    for (let t = 0; t < n; t++) {
      const masses = sol.map((m) => {
        view[0] = m.pos[0] - v[0];
        view[1] = m.pos[1] - v[1];
        view[2] = m.pos[2] - v[2];
        perpBasis(view, e1, e2);
        const a = 2 * Math.PI * rng();
        const r = GATES.tolerantJitter * R * Math.sqrt(rng());
        const ca = r * Math.cos(a);
        const sa = r * Math.sin(a);
        return {
          size: m.size,
          rho: m.rho,
          pos: [m.pos[0] + ca * e1[0] + sa * e2[0], m.pos[1] + ca * e1[1] + sa * e2[1], m.pos[2] + ca * e1[2] + sa * e2[2]] as Vec3,
        };
      });
      if (trace(masses).solved) ok++;
    }
    rep.tolerant = ok / n;
  }
  rep.timing.tolerant = performance.now() - ts;
  if (check('tolerant', rep.tolerant >= GATES.tolerantMin)) return finish();

  // ---- accidental: random legal full-budget placements ----
  ts = performance.now();
  {
    const n = Math.max(1, Math.floor(opts.accidentalTrials ?? GATES.accidentalTrials));
    const sizes = budgetSizes(level.budget);
    const search = new Search(level, world, mulberry32(hash2(seed, 0xac)));
    const limit = GATES.accidentalMax * n;
    let hits = 0;
    let done = 0;
    for (let t = 0; t < n; t++) {
      const masses: PlacedMass[] = [];
      for (const size of sizes) {
        const rho = level.masses[size];
        const p = search.randomLegal(rho, masses, 400);
        if (p) masses.push({ size, pos: p, rho });
      }
      done++;
      if (trace(masses).solved) hits++;
      // Early exit: the threshold is already exceeded.
      if (early && hits >= limit) break;
    }
    rep.accidentalTrials = done;
    rep.accidental = hits / n;
  }
  rep.timing.accidental = performance.now() - ts;
  if (check('accidental', rep.accidental < GATES.accidentalMax)) return finish();

  // ---- minimal: no sub-multiset with fewer than par masses solves ----
  ts = performance.now();
  {
    const budgetEvals = Math.floor(opts.minimalEvals ?? GATES.minimalEvals);
    if (budgetEvals > 0) {
      const sets = subMultisets(level.budget, level.par - 1);
      let minimal = true;
      for (let i = 0; i < sets.length; i++) {
        const search = new Search(level, world, mulberry32(hash2(seed, 0x300 + i)));
        const o = search.run(sets[i], budgetEvals * sets[i].length);
        evals += search.evals;
        const tryRep: MinimalTry = { masses: multisetKey(sets[i]), solved: o.solved, evals: search.evals };
        if (o.solved) {
          tryRep.solution = o.masses.map((m) => ({ size: m.size, pos: [m.pos[0], m.pos[1], m.pos[2]] }));
          minimal = false;
        }
        rep.minimalTried.push(tryRep);
        if (!minimal) break;
      }
      rep.minimal = minimal;
    } else {
      rep.minimal = true;
    }
  }
  rep.timing.minimal = performance.now() - ts;
  check('minimal', rep.minimal);
  return finish();
}
