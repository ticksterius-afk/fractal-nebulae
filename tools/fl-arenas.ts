/**
 * First Light arena finder (design/60-first-light-build.md §L, design/10-platform.md §6.2):
 *
 *   npx tsx tools/fl-arenas.ts <nebula|all> [--clock 0] [--count 6] [--seed 1] [--radii 0.06,0.09,0.13,0.18]
 *                              [--yield]
 *   npx tsx tools/fl-arenas.ts curate <candidates.json…> [--per 5] [--write]
 *
 * Finds candidate puzzle arenas in a nebula's frozen fractal (LOCAL units, B = the fractal's bound):
 *  - centre: free (DE ∈ [0.02, 0.25] R) and close to structure; R = each `--radii` fraction × B;
 *  - placeable volume: the fraction of the ball where a medium mass may legally sit (DE ≥ 2ρ_medium =
 *    0.044 R) must lie in [35, 75] % (sparse fractals that never reach the band are reported with
 *    "band": false — Sierpiński, KIFS and the Lichtenberg tree are dusts/filaments: almost all of
 *    any ball is placeable);
 *  - blocking: the fraction of random chords of the ball that hit structure (are beams obstructed?);
 *  - enclosure: the fraction of directions from the centre that meet structure within R (a lone wall
 *    reads ≈ 50 %; preferred up to 85 %: structure on several sides);
 *  - DE reliability (platform §6.2): from 2000 random free points p (a stream seeded by the arena, so
 *    fl-check reaches the same verdict), march 16 fine steps inside the ball
 *    of radius 0.8·DE(p) the tracer trusts (half along −∇DE, half random): any contact there is a
 *    violation; the arena is rejected above 1e-3, or when more than 2 % of the samples see a Lipschitz
 *    ratio (DE(p) − DE(q))/|p − q| above 1.25 (the tracer's 0.8 safety factor); the worst ratio is
 *    reported;
 *  - a vantage in free space (DE ≥ 0.12 R; fl-check accepts ≥ 0.05 R) 1.25–1.45 R from the centre
 *    (the level sanitiser allows ≤ 1.5 R; the arena soft bounds fade out by 1.5 R), with a clear line
 *    of sight to the centre and 25–85 % structure in its 22° view cone;
 *  - accepted arenas do not overlap (centres ≥ R₁ + R₂ apart).
 * `--yield` also runs the generator in each accepted arena (one- and two-mass levels) and reports how
 * often it succeeds and how long it takes: what the runtime daily will experience.
 * Prints a summary to stderr and the JSON candidates to stdout. `curate` rescores candidate files
 * (fresh stats, generator yield for 1 / 2 / 3 masses), keeps the best 5 per nebula and prints (or with
 * --write regenerates) src/game/firstlight/dailyArenas.ts.
 *
 * Exports for the other tools: arenaStats(nebula, clock, arena), arenaReliability(...), deReliability(...),
 * checkVantage(...).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fnv1a, mulberry32, type Rng } from '../src/game/platform/prng';
import { frozenParams, nebulaFractal } from '../src/game/firstlight/world';
import { generateLevel } from '../src/game/firstlight/Generator';
import { NEBULAE } from '../src/universe/catalog';
import type { Vec3 } from '../src/core/types';
import type { ArenaDef, MassSize } from '../src/game/firstlight/types';

export type DE = (x: number, y: number, z: number) => number;

export const ARENA_RULES = {
  /** Placeable: DE ≥ this × R (= 2 × the default medium ρ of 2.2 % R). */
  placeableDE: 0.044,
  band: [0.35, 0.75] as readonly [number, number],
  centreDE: [0.02, 0.25] as readonly [number, number],
  vantageDist: [1.25, 1.35, 1.45] as readonly number[],
  vantageClear: 0.05,
  /** The finder only takes vantages with at least this clearance (× R); fl-check accepts vantageClear. */
  vantagePrefer: 0.12,
  /** Line of sight vantage → centre keeps DE ≥ this × R until 0.35 R from the centre. */
  sightClear: 0.02,
  maxViolations: 1e-3,
  /**
   * DE-reliability samples per arena (platform §6.2: 2k). Fewer cannot resolve the 1e-3 limit: at 400–600
   * one unlucky contact decides, so the verdict flipped with the sample seed.
   */
  reliabilitySamples: 2000,
  /** Reject arenas where more than this share of samples sees a Lipschitz ratio > 1.25. */
  maxLipBad: 0.02,
  /** The tracer's contact distance (× R): BeamTracer TRACE.eps. */
  eps: 3e-4,
} as const;

/** Frozen DE of a nebula at a clock (the same params the tracer uses). */
export function nebulaDE(nebula: string, clock: number): DE {
  const f = nebulaFractal(nebula);
  const params = frozenParams(nebula, clock);
  return (x, y, z) => {
    const d = f.de(x, y, z, params, f.cpuIter);
    return d === d ? d : 0;
  };
}

function randBall(rng: Rng, c: Readonly<Vec3>, R: number): Vec3 {
  for (;;) {
    const x = 2 * rng() - 1;
    const y = 2 * rng() - 1;
    const z = 2 * rng() - 1;
    if (x * x + y * y + z * z <= 1) return [c[0] + x * R, c[1] + y * R, c[2] + z * R];
  }
}

function randUnit(rng: Rng): Vec3 {
  const z = 2 * rng() - 1;
  const a = 2 * Math.PI * rng();
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  return [s * Math.cos(a), s * Math.sin(a), z];
}

/** Fraction of the ball that is placeable (DE ≥ placeableDE·R) and empty (DE > eps). */
export function volumeFractions(de: DE, c: Readonly<Vec3>, R: number, rng: Rng, n: number): { placeable: number; empty: number } {
  let p = 0;
  let e = 0;
  for (let i = 0; i < n; i++) {
    const q = randBall(rng, c, R);
    const d = de(q[0], q[1], q[2]);
    if (d >= ARENA_RULES.placeableDE * R) p++;
    if (d > ARENA_RULES.eps * R) e++;
  }
  return { placeable: p / n, empty: e / n };
}

/** Sphere-traces a → b; returns the first contact distance (Infinity if clear) and the min DE seen. */
export function march(de: DE, a: Readonly<Vec3>, b: Readonly<Vec3>, eps: number, ignoreFrom = Infinity): { hit: number; minDE: number } {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const dx = (b[0] - a[0]) / L;
  const dy = (b[1] - a[1]) / L;
  const dz = (b[2] - a[2]) / L;
  let t = 0;
  let minDE = Infinity;
  for (let i = 0; i < 4000 && t < L; i++) {
    const d = de(a[0] + dx * t, a[1] + dy * t, a[2] + dz * t);
    if (t < ignoreFrom && d < minDE) minDE = d;
    if (!(d > eps)) return { hit: t, minDE };
    t += Math.max(0.8 * d, eps);
  }
  return { hit: t >= L ? Infinity : t, minDE };
}

/** Fraction of random chords (uniform pairs of points on the sphere) that hit structure. */
export function chordBlocking(de: DE, c: Readonly<Vec3>, R: number, rng: Rng, n: number): number {
  let blocked = 0;
  for (let i = 0; i < n; i++) {
    const u = randUnit(rng);
    const v = randUnit(rng);
    const a: Vec3 = [c[0] + u[0] * R, c[1] + u[1] * R, c[2] + u[2] * R];
    const b: Vec3 = [c[0] + v[0] * R, c[1] + v[1] * R, c[2] + v[2] * R];
    if (march(de, a, b, ARENA_RULES.eps * R).hit < Infinity) blocked++;
  }
  return blocked / n;
}

/**
 * Enclosure: the fraction of directions from the centre that meet structure within R (64 rays on a
 * Fibonacci sphere). A flat wall beside the centre reads ≈ 0.5; structure on several sides (a valley
 * between florets, a lattice cell) reads higher — the arenas where a beam has to thread something.
 */
export function enclosure(de: DE, c: Readonly<Vec3>, R: number, n = 64): number {
  let hits = 0;
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const a = ga * i;
    const end: Vec3 = [c[0] + Math.cos(a) * r * R, c[1] + y * R, c[2] + Math.sin(a) * r * R];
    if (march(de, c, end, ARENA_RULES.eps * R).hit < Infinity) hits++;
  }
  return hits / n;
}

export interface Reliability {
  samples: number;
  violations: number;
  /** violations / samples. */
  rate: number;
  worstLipschitz: number;
  /**
   * Share of samples whose march saw a Lipschitz ratio above 1.25 (the tracer's 0.8 safety factor
   * covers up to 1.25): where the DE overestimates enough that a thin feature could be stepped over.
   */
  lipBad: number;
}

/** DE reliability inside the arena ball (see the header). */
export function deReliability(de: DE, c: Readonly<Vec3>, R: number, rng: Rng, n: number = ARENA_RULES.reliabilitySamples): Reliability {
  const eps = ARENA_RULES.eps * R;
  let samples = 0;
  let violations = 0;
  let worst = 0;
  let lipBad = 0;
  for (let i = 0; i < n * 4 && samples < n; i++) {
    const p = randBall(rng, c, R);
    const d = de(p[0], p[1], p[2]);
    if (!(d > 4 * eps)) continue;
    samples++;
    let dir: Vec3;
    if (samples % 2 === 0) {
      const h = eps;
      const gx = de(p[0] + h, p[1], p[2]) - de(p[0] - h, p[1], p[2]);
      const gy = de(p[0], p[1] + h, p[2]) - de(p[0], p[1] - h, p[2]);
      const gz = de(p[0], p[1], p[2] + h) - de(p[0], p[1], p[2] - h);
      const gl = Math.hypot(gx, gy, gz);
      dir = gl > 0 ? [-gx / gl, -gy / gl, -gz / gl] : randUnit(rng);
    } else dir = randUnit(rng);
    const ball = 0.8 * d;
    let bad = false;
    let steep = false;
    for (let k = 1; k <= 16; k++) {
      const t = (ball * k) / 16;
      const dq = de(p[0] + dir[0] * t, p[1] + dir[1] * t, p[2] + dir[2] * t);
      const lip = (d - dq) / t;
      if (lip > worst) worst = lip;
      if (lip > 1.25) steep = true;
      if (dq <= 0.25 * eps) bad = true;
    }
    if (bad) violations++;
    if (steep) lipBad++;
  }
  return { samples, violations, rate: samples > 0 ? violations / samples : 1, worstLipschitz: worst, lipBad: samples > 0 ? lipBad / samples : 1 };
}

/**
 * The reliability verdict of an arena: ARENA_RULES.reliabilitySamples samples from a stream seeded by the
 * arena itself (nebula, clock, centre, R), so the finder, curation, fl-check and every level sharing an
 * arena reach the same verdict.
 */
export function arenaReliability(nebula: string, clock: number, c: Readonly<Vec3>, R: number, de: DE = nebulaDE(nebula, clock)): Reliability {
  return deReliability(de, c, R, mulberry32(fnv1a(`${nebula}:${clock}:${c.join(',')}:${R}:rel`)), ARENA_RULES.reliabilitySamples);
}

export interface VantageCheck {
  ok: boolean;
  clearance: number;
  /** First contact on the line vantage → centre (Infinity: clear). */
  sightHit: number;
  /** Min DE along the line of sight (× R), away from the centre. */
  sightClear: number;
  reasons: string[];
}

/** Is the vantage in free space with clearance and a clear line of sight to the arena centre? */
export function checkVantage(de: DE, arena: ArenaDef): VantageCheck {
  const R = arena.radiusLocal;
  const c = arena.centerLocal;
  const v = arena.vantage.pos;
  const clearance = de(v[0], v[1], v[2]);
  const D = Math.hypot(v[0] - c[0], v[1] - c[1], v[2] - c[2]);
  const reasons: string[] = [];
  if (!(clearance >= ARENA_RULES.vantageClear * R)) reasons.push(`vantage clearance ${(clearance / R).toFixed(3)} R < ${ARENA_RULES.vantageClear} R`);
  // Stop short of the centre by its own clearance (the centre may sit close to structure).
  const dc = de(c[0], c[1], c[2]);
  const stop = Math.max(0, D - Math.max(0.5 * dc, ARENA_RULES.eps * R * 4));
  const end: Vec3 = [v[0] + ((c[0] - v[0]) * stop) / D, v[1] + ((c[1] - v[1]) * stop) / D, v[2] + ((c[2] - v[2]) * stop) / D];
  const m = march(de, v, end, ARENA_RULES.eps * R, Math.max(0, D - 0.35 * R));
  if (m.hit < Infinity) reasons.push(`line of sight blocked at ${(m.hit / R).toFixed(2)} R`);
  else if (m.minDE < ARENA_RULES.sightClear * R) reasons.push(`line of sight grazes structure (${(m.minDE / R).toFixed(3)} R)`);
  return { ok: reasons.length === 0, clearance, sightHit: m.hit, sightClear: m.minDE / R, reasons };
}

/** Searches a vantage for an arena centre (see the header); null when none is found. */
function findVantage(de: DE, c: Vec3, R: number, rng: Rng): { pos: Vec3; view: number; clearance: number } | null {
  let best: { pos: Vec3; view: number; clearance: number } | null = null;
  let bestScore = -Infinity;
  for (let t = 0; t < 240; t++) {
    const u = randUnit(rng);
    if (Math.abs(u[1]) > 0.8) continue; // not straight above/below: keeps the flight view upright
    const dist = ARENA_RULES.vantageDist[t % ARENA_RULES.vantageDist.length] * R;
    const pos: Vec3 = [c[0] + u[0] * dist, c[1] + u[1] * dist, c[2] + u[2] * dist];
    const chk = checkVantage(de, { centerLocal: c, radiusLocal: R, vantage: { pos, lookAt: c } });
    if (!chk.ok || chk.clearance < ARENA_RULES.vantagePrefer * R) continue;
    // View cone (22°): some structure in frame, not a wall.
    const fw: Vec3 = [-u[0], -u[1], -u[2]];
    let hits = 0;
    const N = 20;
    for (let k = 0; k < N; k++) {
      const r = randUnit(rng);
      const s = Math.tan((22 * Math.PI) / 180) * Math.sqrt(rng());
      const dx = fw[0] + r[0] * s;
      const dy = fw[1] + r[1] * s;
      const dz = fw[2] + r[2] * s;
      const l = Math.hypot(dx, dy, dz);
      const far: Vec3 = [pos[0] + (dx / l) * 3 * R, pos[1] + (dy / l) * 3 * R, pos[2] + (dz / l) * 3 * R];
      if (march(de, pos, far, ARENA_RULES.eps * R).hit < Infinity) hits++;
    }
    const view = hits / N;
    if (view < 0.25 || view > 0.85) continue;
    const score = Math.min(chk.clearance / R, 0.25) + 0.6 * (1 - Math.abs(view - 0.55) * 2) + 0.05 * rng();
    if (score > bestScore) {
      bestScore = score;
      best = { pos, view, clearance: chk.clearance };
    }
  }
  return best;
}

export interface ArenaStats {
  placeable: number;
  empty: number;
  blocking: number;
  enclosure: number;
  centreDE: number;
  reliability: Reliability;
  vantage: VantageCheck;
  inBand: boolean;
}

/** Every metric of an arena (fl-check and the curation comments use it). */
export function arenaStats(nebula: string, clock: number, arena: ArenaDef, seed = 1): ArenaStats {
  const de = nebulaDE(nebula, clock);
  const rng = mulberry32(fnv1a(`${nebula}:${clock}:stats:${seed}`));
  const c = arena.centerLocal;
  const R = arena.radiusLocal;
  const v = volumeFractions(de, c, R, rng, 1200);
  return {
    placeable: v.placeable,
    empty: v.empty,
    blocking: chordBlocking(de, c, R, rng, 96),
    enclosure: enclosure(de, c, R),
    centreDE: de(c[0], c[1], c[2]) / R,
    reliability: arenaReliability(nebula, clock, c, R, de),
    vantage: checkVantage(de, arena),
    inBand: v.placeable >= ARENA_RULES.band[0] && v.placeable <= ARENA_RULES.band[1],
  };
}

export interface ArenaCandidate {
  nebula: string;
  clock: number;
  arena: ArenaDef;
  stats: {
    placeable: number;
    empty: number;
    blocking: number;
    enclosure: number;
    centreDE: number;
    deViolations: number;
    worstLipschitz: number;
    lipBad: number;
    vantageClear: number;
    view: number;
    band: boolean;
    radiusOfBound: number;
    yield?: string;
  };
}

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** Candidate arenas of one nebula (see the header). */
export function findArenas(nebula: string, clock: number, opts: { count: number; seed: number; radii: number[]; log?: (s: string) => void }): ArenaCandidate[] {
  const f = nebulaFractal(nebula);
  const B = f.boundRadius;
  const de = nebulaDE(nebula, clock);
  const rng = mulberry32(fnv1a(`${nebula}:${clock}:${opts.seed}`));
  const log = opts.log ?? (() => {});
  interface Pre {
    c: Vec3;
    R: number;
    fr: number;
    placeable: number;
    empty: number;
    blocking: number;
    enclosure: number;
    score: number;
  }
  const pool: Pre[] = [];
  for (const fr of opts.radii) {
    const R = fr * B;
    let kept = 0;
    for (let i = 0; i < 6000 && kept < 50; i++) {
      const c = randBall(rng, [0, 0, 0], 0.95 * B);
      const d = de(c[0], c[1], c[2]);
      if (!(d >= ARENA_RULES.centreDE[0] * R && d <= ARENA_RULES.centreDE[1] * R)) continue;
      const quick = volumeFractions(de, c, R, rng, 40).placeable;
      if (quick < 0.2 || quick > 0.92) continue;
      kept++;
      const v = volumeFractions(de, c, R, rng, 400);
      const blocking = chordBlocking(de, c, R, rng, 40);
      const enc = enclosure(de, c, R, 48);
      const band = Math.max(0, ARENA_RULES.band[0] - v.placeable, v.placeable - ARENA_RULES.band[1]);
      // In band first; then structure around the centre (not a lone wall), beams that get blocked.
      const score = -4 * band - Math.abs(v.placeable - 0.55) + 0.4 * Math.min(blocking, 0.8) + Math.min(enc, 0.85) + 0.05 * rng();
      pool.push({ c, R, fr, placeable: v.placeable, empty: v.empty, blocking, enclosure: enc, score });
    }
    log(`  ${nebula} R=${fr}B: ${kept} candidates`);
  }
  pool.sort((a, b) => b.score - a.score);
  const out: ArenaCandidate[] = [];
  for (const p of pool) {
    if (out.length >= opts.count) break;
    if (out.some((o) => Math.hypot(o.arena.centerLocal[0] - p.c[0], o.arena.centerLocal[1] - p.c[1], o.arena.centerLocal[2] - p.c[2]) < o.arena.radiusLocal + p.R)) continue;
    // On the rounded centre / R that get written out: the same verdict fl-check reaches later.
    const c: Vec3 = [r6(p.c[0]), r6(p.c[1]), r6(p.c[2])];
    const rel = arenaReliability(nebula, clock, c, r6(p.R), de);
    if (rel.rate > ARENA_RULES.maxViolations) {
      log(`  reject (DE reliability ${rel.violations}/${rel.samples}) at R=${p.fr}B`);
      continue;
    }
    if (rel.lipBad > ARENA_RULES.maxLipBad) {
      log(`  reject (DE overestimates: ${(rel.lipBad * 100).toFixed(1)} % of samples steeper than 1.25) at R=${p.fr}B`);
      continue;
    }
    const van = findVantage(de, p.c, p.R, rng);
    if (!van) {
      log(`  reject (no vantage) at R=${p.fr}B`);
      continue;
    }
    out.push({
      nebula,
      clock,
      arena: { centerLocal: c, radiusLocal: r6(p.R), vantage: { pos: [r6(van.pos[0]), r6(van.pos[1]), r6(van.pos[2])], lookAt: c } },
      stats: {
        placeable: +p.placeable.toFixed(3),
        empty: +p.empty.toFixed(3),
        blocking: +p.blocking.toFixed(3),
        enclosure: +enclosure(de, p.c, p.R).toFixed(3),
        centreDE: +(de(c[0], c[1], c[2]) / p.R).toFixed(3),
        deViolations: rel.violations,
        worstLipschitz: +rel.worstLipschitz.toFixed(3),
        lipBad: +rel.lipBad.toFixed(3),
        vantageClear: +(van.clearance / p.R).toFixed(3),
        view: +van.view.toFixed(2),
        band: p.placeable >= ARENA_RULES.band[0] && p.placeable <= ARENA_RULES.band[1],
        radiusOfBound: p.fr,
      },
    });
  }
  return out;
}

/** Generator yield in an arena: one- and two-mass levels over a few seeds. */
export function generatorYield(nebula: string, clock: number, arena: ArenaDef, seeds = 4): string {
  const parts: string[] = [];
  for (const masses of [['medium'], ['medium', 'medium']] as const) {
    let ok = 0;
    let ms = 0;
    for (let s = 0; s < seeds; s++) {
      const r = generateLevel({ nebula, clock, arena, masses: [...masses], seed: 1000 + s, maxAttempts: 40 });
      if (r.level) ok++;
      ms += r.ms;
    }
    parts.push(`${masses.length}m ${ok}/${seeds} ${(ms / seeds).toFixed(0)}ms`);
  }
  return parts.join(', ');
}

// ---------------------------------------------------------------------------------------------
// Curation: candidates → src/game/firstlight/dailyArenas.ts
// ---------------------------------------------------------------------------------------------

interface Yield {
  ok: number;
  of: number;
  ms: number;
}

function yieldOf(nebula: string, clock: number, arena: ArenaDef, masses: MassSize[], seeds: number, attempts: number): Yield {
  let ok = 0;
  let ms = 0;
  for (let s = 0; s < seeds; s++) {
    const r = generateLevel({ nebula, clock, arena, masses, seed: 2000 + s, maxAttempts: attempts });
    if (r.level) ok++;
    ms += r.ms;
  }
  return { ok, of: seeds, ms: ms / seeds };
}

interface Curated {
  cand: ArenaCandidate;
  stats: ArenaStats;
  y1: Yield;
  y2: Yield;
  y3: Yield;
  score: number;
}

/**
 * Rescores candidate arenas (fresh stats with fixed seeds, generator yield for one, two and three
 * medium masses) and keeps the best `per` of each nebula that do not overlap. Hard rules: DE
 * reliability, vantage, and two-mass yield ≥ 50 %. Score: two-mass yield ×2, three-mass ×1, one-mass
 * ×0.5, enclosure (≤ 0.85) ×0.8, blocking (≤ 0.8) ×0.3, minus the distance outside the placeable band ×2.
 */
export function curate(cands: ArenaCandidate[], per: number, log: (s: string) => void): Curated[] {
  const byNebula = new Map<string, Curated[]>();
  for (const cand of cands) {
    const list = byNebula.get(cand.nebula) ?? [];
    byNebula.set(cand.nebula, list);
    const a = cand.arena;
    const dup = list.some(
      (o) =>
        o.cand.clock === cand.clock &&
        Math.hypot(o.cand.arena.centerLocal[0] - a.centerLocal[0], o.cand.arena.centerLocal[1] - a.centerLocal[1], o.cand.arena.centerLocal[2] - a.centerLocal[2]) <
          0.5 * (o.cand.arena.radiusLocal + a.radiusLocal),
    );
    if (dup) continue;
    const stats = arenaStats(cand.nebula, cand.clock, a);
    const tag = `${cand.nebula} R=${a.radiusLocal} @ ${a.centerLocal.join(',')}`;
    if (stats.reliability.rate > ARENA_RULES.maxViolations || stats.reliability.lipBad > ARENA_RULES.maxLipBad || !stats.vantage.ok) {
      log(`  drop ${tag}: DE ${stats.reliability.violations}/${stats.reliability.samples}, steep ${(stats.reliability.lipBad * 100).toFixed(1)} %, vantage ${stats.vantage.ok ? 'ok' : stats.vantage.reasons.join('; ')}`);
      continue;
    }
    const y2 = yieldOf(cand.nebula, cand.clock, a, ['medium', 'medium'], 6, 40);
    if (y2.ok / y2.of < 0.5) {
      log(`  drop ${tag}: two-mass yield ${y2.ok}/${y2.of}`);
      continue;
    }
    const y1 = yieldOf(cand.nebula, cand.clock, a, ['medium'], 6, 40);
    const y3 = yieldOf(cand.nebula, cand.clock, a, ['medium', 'medium', 'medium'], 2, 60);
    const band = Math.max(0, ARENA_RULES.band[0] - stats.placeable, stats.placeable - ARENA_RULES.band[1]);
    const score =
      (2 * y2.ok) / y2.of + y3.ok / y3.of + (0.5 * y1.ok) / y1.of + 0.8 * Math.min(stats.enclosure, 0.85) + 0.3 * Math.min(stats.blocking, 0.8) - 2 * band;
    list.push({ cand, stats, y1, y2, y3, score });
    log(`  ${tag}: score ${score.toFixed(2)} (yield ${y1.ok}/${y1.of} ${y2.ok}/${y2.of} ${y3.ok}/${y3.of}, enclosure ${(stats.enclosure * 100).toFixed(0)} %)`);
  }
  const out: Curated[] = [];
  for (const id of NEBULAE.map((n) => n.id)) {
    const list = (byNebula.get(id) ?? []).sort((a, b) => b.score - a.score);
    const kept: Curated[] = [];
    for (const c of list) {
      if (kept.length >= per) break;
      const a = c.cand.arena;
      if (kept.some((o) => Math.hypot(o.cand.arena.centerLocal[0] - a.centerLocal[0], o.cand.arena.centerLocal[1] - a.centerLocal[1], o.cand.arena.centerLocal[2] - a.centerLocal[2]) < o.cand.arena.radiusLocal + a.radiusLocal)) continue;
      kept.push(c);
    }
    out.push(...kept);
  }
  return out;
}

const DAILY_HEADER = `/**
 * First Light — the curated arena pool of the free daily puzzle (design/20-first-light.md §3.3,
 * design/60-first-light-build.md §L), in nebula LOCAL units, frozen at \`clock\` (world.ts
 * frozenParams). DailyGen picks one by date and runs the Generator in it.
 *
 * GENERATED by \`npx tsx tools/fl-arenas.ts curate <candidates.json…> --write\` from the candidates of
 * \`npx tsx tools/fl-arenas.ts all\` (see that tool for every metric). Every arena here passed the DE
 * reliability check (≤ 1e-3 of 2000 samples with a contact inside the 0.8·DE ball the tracer trusts,
 * ≤ 2 % steeper than Lipschitz 1.25), has a vantage in free space 1.25–1.45 R from the centre with a clear line of
 * sight to it, and lets the generator build levels. The comment above each entry gives:
 *  - R as a fraction of the fractal's bound B (0.06 B: intimate; 0.18–0.22 B: halls);
 *  - placeable: the share of the ball where a medium mass may sit (DE ≥ 2ρ); the build plan's band is
 *    35–75 %. Sierpiński, KIFS (partly) and the Lichtenberg tree are dusts / thin filaments that never
 *    reach it at any scale: their entries are the densest regions found;
 *  - blocked: the share of random chords of the ball that hit structure; enclosure: the share of
 *    directions from the centre that meet structure within R (a lone wall ≈ 50 %);
 *  - yield: generator successes for 1 / 2 / 3 medium masses (6 / 6 / 2 seeds, ≤ 40 / 40 / 60 attempts)
 *    and the mean time per two-mass level.
 * Look at one with \`npx tsx tools/fl-preview.ts --arena <nebula>:<i> <outDir>\` (i = index among that
 * nebula's entries; \`npx tsx tools/fl-solve.ts arenas\` lists them) and try it with
 * \`npx tsx tools/fl-solve.ts generate --nebula <nebula> --arena <i> --masses medium,medium --seed 1\`.
 */
import type { ArenaDef } from './types';

export interface DailyArena {
  nebula: string;
  /** Animation clock (s) the nebula is frozen at. */
  clock: number;
  arena: ArenaDef;
}

export const DAILY_ARENAS: DailyArena[] = [
`;

/** dailyArenas.ts source for curated arenas (a comment per entry). */
export function dailyArenasSource(list: Curated[]): string {
  const v = (a: readonly number[]): string => `[${a.join(', ')}]`;
  let out = DAILY_HEADER;
  let last = '';
  for (const c of list) {
    const a = c.cand.arena;
    const s = c.stats;
    if (c.cand.nebula !== last) {
      out += `${last ? '\n' : ''}  // ---- ${c.cand.nebula} ----\n`;
      last = c.cand.nebula;
    }
    const B = nebulaFractal(c.cand.nebula).boundRadius;
    out +=
      `  // R ${(a.radiusLocal / B).toFixed(2)} B · placeable ${(s.placeable * 100).toFixed(0)} %${s.inBand ? '' : ' (sparse)'} · ` +
      `blocked ${(s.blocking * 100).toFixed(0)} % · enclosure ${(s.enclosure * 100).toFixed(0)} % · ` +
      `yield ${c.y1.ok}/${c.y1.of} ${c.y2.ok}/${c.y2.of} ${c.y3.ok}/${c.y3.of}, ${c.y2.ms.toFixed(0)} ms · vantage clear ${(s.vantage.clearance / a.radiusLocal).toFixed(2)} R\n`;
    out += `  {\n    nebula: '${c.cand.nebula}',\n    clock: ${c.cand.clock},\n    arena: {\n      centerLocal: ${v(a.centerLocal)},\n      radiusLocal: ${a.radiusLocal},\n`;
    out += `      vantage: { pos: ${v(a.vantage.pos)}, lookAt: ${v(a.vantage.lookAt)} },\n    },\n  },\n`;
  }
  return `${out}];\n`;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function arg(args: string[], name: string, def: string): string {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

function main(): void {
  const args = process.argv.slice(2);
  const which = args[0];
  if (!which || which.startsWith('--')) {
    console.error(
      'usage: npx tsx tools/fl-arenas.ts <nebula|all> [--clock 0] [--count 6] [--seed 1] [--radii 0.06,0.09,0.13,0.18] [--yield]\n' +
        '       npx tsx tools/fl-arenas.ts curate <candidates.json…> [--per 5] [--write]',
    );
    process.exit(2);
  }
  if (which === 'curate') {
    const files = args.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i] !== undefined && all[i - 1] !== '--per');
    const cands: ArenaCandidate[] = [];
    for (const f of files) cands.push(...(JSON.parse(readFileSync(f, 'utf8')) as ArenaCandidate[]));
    const t0 = performance.now();
    const list = curate(cands, Number(arg(args, '--per', '5')), (s) => process.stderr.write(`${s}\n`));
    const src = dailyArenasSource(list);
    if (args.includes('--write')) {
      writeFileSync(resolve('src/game/firstlight/dailyArenas.ts'), src);
      process.stderr.write(`wrote src/game/firstlight/dailyArenas.ts: ${list.length} arenas in ${((performance.now() - t0) / 1000).toFixed(0)} s\n`);
    } else console.log(src);
    return;
  }
  const clock = Number(arg(args, '--clock', '0'));
  const count = Number(arg(args, '--count', '6'));
  const seed = Number(arg(args, '--seed', '1'));
  const radii = arg(args, '--radii', '0.06,0.09,0.13,0.18').split(',').map(Number);
  const ids = which === 'all' ? NEBULAE.filter((n) => n.fractal !== 'blackhole').map((n) => n.id) : [which];
  const log = (s: string): void => {
    process.stderr.write(`${s}\n`);
  };
  const all: ArenaCandidate[] = [];
  for (const id of ids) {
    const t0 = performance.now();
    const found = findArenas(id, clock, { count, seed, radii, log });
    if (args.includes('--yield')) for (const a of found) a.stats.yield = generatorYield(id, clock, a.arena);
    log(`${id}: ${found.length} arenas in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    for (const a of found) {
      const s = a.stats;
      log(
        `  R=${a.arena.radiusLocal} (${s.radiusOfBound}B) centre ${a.arena.centerLocal.join(', ')}  placeable ${(s.placeable * 100).toFixed(0)} %${s.band ? '' : ' (out of band)'}` +
          `  blocking ${(s.blocking * 100).toFixed(0)} %  enclosure ${(s.enclosure * 100).toFixed(0)} %  DE viol ${s.deViolations}  Lip ${s.worstLipschitz} (>1.25: ${(s.lipBad * 100).toFixed(1)} %)  vantage clear ${s.vantageClear} R  view ${s.view}${s.yield ? `  yield ${s.yield}` : ''}`,
      );
    }
    all.push(...found);
  }
  console.log(JSON.stringify(all, null, 1));
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) main();
