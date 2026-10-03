/**
 * First Light beam-tracer check (design/60-first-light-build.md §T). Headless, CI-able:
 *
 *   npx tsx tools/fl-trace-check.ts            exits 1 when any check fails
 *
 * Covers: far-field deflection against the exact Schwarzschild value (and 2ρ/b where the first-order
 * formula is meant to hold), capture / escape around b_c = 2.598ρ, two-mass symmetry, plane and corridor
 * reflection (angle in = angle out, ×0.7 per bounce, fading, the 0.3 lighting threshold), seed
 * tunnelling, echo emission order (light-travel time, emit-once, the 16-beam cap), the result contract,
 * determinism (1000 random configurations traced twice in opposite orders, byte-identical; quantisation
 * invariance), level sanitising, frozen params vs Universe, and timing on a real Mandelbulb arena.
 */
import { traceLevel, TRACE } from '../src/game/firstlight/BeamTracer';
import { CRITICAL_IMPACT, exactDeflection, weakDeflection } from '../src/game/firstlight/Geodesic';
import { budgetCount, rhoOf, sanitizeLevel, totalBudget } from '../src/game/firstlight/Level';
import { frozenParams, makeTraceWorld, nebulaFractal, defaultMaterial } from '../src/game/firstlight/world';
import type { Vec3 } from '../src/core/types';
import type { LevelDef, MassSize, PlacedMass, SeedDef, TraceResult, TraceWorld } from '../src/game/firstlight/types';

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

let failures = 0;
const rows: [string, string, string][] = [];
function check(name: string, ok: boolean, detail: string): void {
  rows.push([ok ? 'ok' : 'FAIL', name, detail]);
  if (!ok) failures++;
}
const fx = (x: number, d = 4): string => (Number.isFinite(x) ? x.toFixed(d) : String(x));
const ex = (x: number, d = 3): string => (Number.isFinite(x) ? x.toExponential(d) : String(x));

/** Local mulberry32 (keeps the check independent of other packages). */
function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

function seed(id: string, pos: Vec3, radius: number, extra: Partial<SeedDef> = {}): SeedDef {
  return { id, pos, radius, kind: 'seed', goal: true, ...extra };
}

/** A synthetic level (not sanitised: test worlds use ρ and sizes far outside the play ranges). */
function testLevel(R: number, src: Vec3, dir: Vec3, seeds: SeedDef[], center: Vec3 = [0, 0, 0]): LevelDef {
  return {
    id: 'test',
    chapter: 'test',
    index: 1,
    name: 'Test',
    nebula: 'bulb',
    arena: { centerLocal: center, radiusLocal: R, vantage: { pos: [0, 0, R], lookAt: center } },
    source: { pos: src, dir: norm(dir) },
    seeds: seeds.length ? seeds : [seed('far', [0, 0, 1.2 * R], 1e-9 * R)],
    masses: { light: 1, medium: 2, heavy: 3 },
    budget: { light: 2, medium: 2, heavy: 2 },
    solution: [],
    hints: ['', '', ''],
    teach: '',
    par: 1,
  };
}

const FREE: TraceWorld = { de: () => 1e30, material: 'absorb' };
const mass = (pos: Vec3, rho = 1, size: MassSize = 'light'): PlacedMass => ({ size, pos, rho });

const serialiseBeam = (b: TraceResult['beams'][number]): string => JSON.stringify(b);

/** Direction of the last polyline segment of a beam. */
function lastDir(r: TraceResult, beam = 0): Vec3 {
  const p = r.beams[beam].points;
  const n = p.length;
  return norm([p[n - 3] - p[n - 6], p[n - 2] - p[n - 5], p[n - 1] - p[n - 4]]);
}

// ---------------------------------------------------------------------------------------------
// 1. Far-field deflection (free space)
// ---------------------------------------------------------------------------------------------

function deflectionChecks(): void {
  const R = 2e4; // ρ = 1; the beam runs ±1.2 R past the mass, so the truncated tails are < 1e-5 relative
  const table: string[] = [];
  let worstExact = 0;
  let worstExactCoarse = 0;
  let worstWeak = 0;
  let worstDirMismatch = 0;
  for (const b of [10, 15, 20, 30, 50, 75, 100, 150, 200]) {
    const exact = exactDeflection(1, b);
    const weak = weakDeflection(1, b);
    const lv = testLevel(R, [-1.2 * R, b, 0], [1, 0, 0], []);
    const full = traceLevel(lv, FREE, [mass([0, 0, 0])]);
    const coarse = traceLevel(lv, FREE, [mass([0, 0, 0])], { coarse: true });
    const a = full.beams[0].deflection;
    const ac = coarse.beams[0].deflection;
    const d = lastDir(full);
    const aDir = Math.atan2(-d[1], d[0]);
    worstDirMismatch = Math.max(worstDirMismatch, Math.abs(aDir - a) / a);
    const eFull = Math.abs(a / exact - 1);
    const eCoarse = Math.abs(ac / exact - 1);
    worstExact = Math.max(worstExact, eFull);
    worstExactCoarse = Math.max(worstExactCoarse, eCoarse);
    if (b >= 100) worstWeak = Math.max(worstWeak, Math.abs(a / weak - 1));
    table.push(
      `    b=${String(b).padStart(3)}ρ  α=${ex(a, 4)}  exact=${ex(exact, 4)}  α/exact=${fx(a / exact, 4)}  ` +
        `coarse/exact=${fx(ac / exact, 4)}  α/(2ρ/b)=${fx(a / weak, 4)}  steps=${full.steps}/${coarse.steps}  ${full.beams[0].end}`,
    );
  }
  console.log('Far-field deflection (free space, ρ = 1):');
  for (const t of table) console.log(t);
  check('deflection vs exact Schwarzschild, b∈[10,200]ρ', worstExact < 0.02, `worst ${fx(worstExact * 100, 2)} % (full)`);
  check('deflection vs exact, coarse', worstExactCoarse < 0.02, `worst ${fx(worstExactCoarse * 100, 2)} %`);
  check('deflection vs 2ρ/b, b∈[100,200]ρ', worstWeak < 0.02, `worst ${fx(worstWeak * 100, 2)} %`);
  check('exit direction = accumulated deflection', worstDirMismatch < 1e-3, `worst rel. ${ex(worstDirMismatch)}`);
}

// ---------------------------------------------------------------------------------------------
// 2. Capture / escape around b_c
// ---------------------------------------------------------------------------------------------

function captureChecks(): void {
  const R = 300;
  const run = (f: number, coarse: boolean): TraceResult =>
    traceLevel(testLevel(R, [-1.2 * R, f * CRITICAL_IMPACT, 0], [1, 0, 0], []), FREE, [mass([0, 0, 0])], { coarse });
  for (const coarse of [false, true]) {
    const tag = coarse ? 'coarse' : 'full';
    const inside = run(0.97, coarse);
    const outside = run(1.03, coarse);
    check(
      `capture at 0.97 b_c (${tag})`,
      inside.beams[0].end === 'captured' && inside.beams[0].captureMass === 0,
      `${inside.beams[0].end}, mass ${inside.beams[0].captureMass}`,
    );
    check(
      `escape at 1.03 b_c (${tag})`,
      outside.beams[0].end === 'exited' && outside.beams[0].captureMass === -1,
      `${outside.beams[0].end}, α=${fx(outside.beams[0].deflection, 3)} rad`,
    );
    // Numerical threshold by bisection.
    let lo = 0.9;
    let hi = 1.1;
    for (let i = 0; i < 30; i++) {
      const m = 0.5 * (lo + hi);
      if (run(m, coarse).beams[0].end === 'captured') lo = m;
      else hi = m;
    }
    check(`capture threshold (${tag})`, Math.abs(lo - 1) < 0.01, `b*/b_c = ${fx(lo, 5)}`);
  }
  // Capture index with two masses: aim straight at the second one.
  const lv = testLevel(R, [-1.2 * R, 0, 0], [1, 0, 0], []);
  const two = traceLevel(lv, FREE, [mass([0, 40, 0]), mass([20, 0, 0], 2)]);
  check('captureMass indexes the input array', two.beams[0].end === 'captured' && two.beams[0].captureMass === 1, `${two.beams[0].end} → ${two.beams[0].captureMass}`);
  // Photon-sphere grazing: massClosest just above 1.5 for b slightly above b_c.
  const graze = run(1.03, false);
  check('massClosest near the photon sphere', graze.massClosest[0] > 1.5 && graze.massClosest[0] < 1.9, `${fx(graze.massClosest[0], 4)} ρ`);
}

// ---------------------------------------------------------------------------------------------
// 3. Two-mass symmetry
// ---------------------------------------------------------------------------------------------

function symmetryChecks(): void {
  const R = 400;
  const s = 8;
  const pair = [mass([0, s, 0]), mass([0, -s, 0])];
  const mid = traceLevel(testLevel(R, [-1.2 * R, 0, 0], [1, 0, 0], []), FREE, pair);
  const e = mid.beams[0].endPos;
  check('beam between equal masses stays straight', mid.beams[0].end === 'exited' && e[1] === 0 && e[2] === 0, `end y=${ex(e[1])} z=${ex(e[2])}`);

  const up = traceLevel(testLevel(R, [-1.2 * R, 3, 0.5], [1, 0, 0], []), FREE, pair);
  const down = traceLevel(testLevel(R, [-1.2 * R, -3, 0.5], [1, 0, 0], []), FREE, pair);
  let maxDiff = 0;
  const pu = up.beams[0].points;
  const pd = down.beams[0].points;
  const sameLen = pu.length === pd.length;
  if (sameLen) {
    for (let i = 0; i < pu.length; i += 3) {
      maxDiff = Math.max(maxDiff, Math.abs(pu[i] - pd[i]), Math.abs(pu[i + 1] + pd[i + 1]), Math.abs(pu[i + 2] - pd[i + 2]));
    }
  }
  check(
    'mirrored beam ↔ mirrored path',
    sameLen && maxDiff <= 1e-12 * R && Math.abs(up.beams[0].deflection - down.beams[0].deflection) < 1e-12,
    `points ${pu.length / 3}/${pd.length / 3}, max |Δ| ${ex(maxDiff)}, α=${fx(up.beams[0].deflection, 5)}`,
  );
  const swapped = traceLevel(testLevel(R, [-1.2 * R, 3, 0.5], [1, 0, 0], []), FREE, [pair[1], pair[0]]);
  check(
    'mass order does not change the path',
    JSON.stringify(swapped.beams[0].points) === JSON.stringify(up.beams[0].points) &&
      swapped.massClosest[0] === up.massClosest[1] && swapped.massClosest[1] === up.massClosest[0],
    `massClosest ${fx(up.massClosest[0], 3)} / ${fx(up.massClosest[1], 3)} ρ`,
  );
}

// ---------------------------------------------------------------------------------------------
// 4. Reflection
// ---------------------------------------------------------------------------------------------

function reflectionChecks(): void {
  const R = 1;
  // Tilted plane through c with unit normal n: DE = n·(p − c).
  const n = norm([0.2, 1, -0.15]);
  const c: Vec3 = [0.05, -0.02, 0.01];
  const plane: TraceWorld = {
    de: (x, y, z) => n[0] * (x - c[0]) + n[1] * (y - c[1]) + n[2] * (z - c[2]),
    material: 'reflect',
  };
  const vin = norm([1, -0.6, 0.2]);
  const src: Vec3 = [-0.5, 0.35, -0.1];
  const r = traceLevel(testLevel(R, src, vin, []), plane, []);
  const b = r.beams[0];
  const vout = lastDir(r);
  const cosIn = -(vin[0] * n[0] + vin[1] * n[1] + vin[2] * n[2]);
  const cosOut = vout[0] * n[0] + vout[1] * n[1] + vout[2] * n[2];
  const expect = norm([vin[0] + 2 * cosIn * n[0], vin[1] + 2 * cosIn * n[1], vin[2] + 2 * cosIn * n[2]]);
  const dev = Math.hypot(vout[0] - expect[0], vout[1] - expect[1], vout[2] - expect[2]);
  const ri = b.intensity.indexOf(0.7);
  check(
    'plane: angle in = angle out',
    b.reflections.length === 3 && Math.abs(Math.acos(cosIn) - Math.acos(cosOut)) < 1e-9 && dev < 1e-9 && b.end === 'exited',
    `${b.reflections.length / 3} refl, |θin−θout| ${ex(Math.abs(Math.acos(cosIn) - Math.acos(cosOut)))}, |Δv| ${ex(dev)}`,
  );
  check(
    'plane: intensity ×0.7 from the reflection point on',
    ri > 0 && b.intensity.slice(0, ri).every((v) => v === 1) && b.intensity.slice(ri).every((v) => v === 0.7),
    `intensity ${b.intensity[0]} → ${b.intensity[b.intensity.length - 1]}`,
  );
  const rp = b.reflections;
  const contact = plane.de(rp[0], rp[1], rp[2]);
  check('plane: reflection point on the surface', contact >= 0 && contact < TRACE.eps * R, `DE at contact ${ex(contact)}`);

  // Absorbing version of the same plane.
  const absorbing: TraceWorld = { de: plane.de, material: 'absorb' };
  const ab = traceLevel(testLevel(R, src, vin, []), absorbing, []).beams[0];
  const en = ab.endNormal;
  check(
    'plane: absorb ends with the surface normal',
    ab.end === 'absorbed' && en !== null && Math.hypot(en[0] - n[0], en[1] - n[1], en[2] - n[2]) < 1e-6,
    `${ab.end}, |n−n₀| ${en ? ex(Math.hypot(en[0] - n[0], en[1] - n[1], en[2] - n[2])) : 'null'}`,
  );

  // Curved mirror (a plane has no second derivatives, so it cannot catch a biased normal stencil): ball of
  // radius 0.3 at the origin, beam in the z = 0 plane. The reflection must follow the analytic normal p/|p|
  // and the path must stay in z = 0 exactly (mirror symmetry).
  const ball: TraceWorld = { de: (x, y, z) => Math.hypot(x, y, z) - 0.3, material: 'reflect' };
  const vb: Vec3 = [1, 0, 0];
  const br = traceLevel(testLevel(R, [-1, 0.1, 0], vb, []), ball, []);
  const bb = br.beams[0];
  const bp = bb.reflections;
  let ballDev = Infinity;
  if (bp.length === 3) {
    const nb = norm([bp[0], bp[1], bp[2]]);
    const vn = vb[0] * nb[0] + vb[1] * nb[1] + vb[2] * nb[2];
    const want = norm([vb[0] - 2 * vn * nb[0], vb[1] - 2 * vn * nb[1], vb[2] - 2 * vn * nb[2]]);
    const got = lastDir(br);
    ballDev = Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]);
  }
  const zMax = Math.max(...bb.points.filter((_, i) => i % 3 === 2).map(Math.abs));
  check(
    'sphere: reflection follows the true normal, stays in plane',
    bb.end === 'exited' && bp.length === 3 && ballDev < 1e-5 && zMax === 0,
    `${bp.length / 3} refl, |Δv| ${ex(ballDev)}, max |z| ${ex(zMax)}`,
  );

  // A class-based world whose de() uses `this` (the tracer calls de detached).
  class ThisPlane implements TraceWorld {
    readonly material = 'reflect' as const;
    private readonly off = c;
    de(x: number, y: number, z: number): number {
      return n[0] * (x - this.off[0]) + n[1] * (y - this.off[1]) + n[2] * (z - this.off[2]);
    }
  }
  let thisOk = false;
  try {
    thisOk = serialiseBeam(traceLevel(testLevel(R, src, vin, []), new ThisPlane(), []).beams[0]) === serialiseBeam(b);
  } catch {
    thisOk = false;
  }
  check('class-based TraceWorld (de uses this)', thisOk, thisOk ? 'same beam as the closure world' : 'differs or throws');

  // Corridor between y = 0 and y = 0.2: 45° zigzag. Bounces 1–3 keep ≥ 0.3 (0.343 after three);
  // the fourth fades the beam. A seed after the third bounce lights at 0.343; one after the fourth never.
  const H = 0.2;
  const corridor: TraceWorld = { de: (_x, y) => Math.min(y, H - y), material: 'reflect' };
  const seeds = [seed('after3', [-0.4, 0.1, 0], 0.01), seed('after4', [-0.2, 0.1, 0], 0.01)];
  const cr = traceLevel(testLevel(R, [-1, 0.1, 0], [1, -1, 0], seeds), corridor, []);
  const cb = cr.beams[0];
  check(
    'corridor: fades at the 4th bounce',
    cb.end === 'faded' && cb.reflections.length === 12 && cb.endNormal !== null,
    `${cb.end} after ${cb.reflections.length / 3} reflections`,
  );
  const s3 = cr.seeds.after3;
  const s4 = cr.seeds.after4;
  check(
    'corridor: 0.343 lights, faded beam does not',
    s3.lit && Math.abs(s3.intensity - 0.343) < 1e-12 && !s4.lit && s4.intensity === 0,
    `after3 lit=${s3.lit} I=${fx(s3.intensity, 3)}; after4 lit=${s4.lit} closest=${fx(s4.closest, 3)}`,
  );
}

// ---------------------------------------------------------------------------------------------
// 5. Seed tunnelling
// ---------------------------------------------------------------------------------------------

function tunnellingChecks(): void {
  // R = 1: max step 0.02, seeds of radius 1e-3 (20× smaller than a step), centred between two steps.
  const r = 1e-3;
  const xs = -1 + 0.02 * 50.5;
  const seeds = [
    seed('centre', [xs, 0, 0], r),
    seed('in', [xs, 0.999 * r, 0], r),
    seed('out', [xs, 1.001 * r, 0], r),
    seed('in-z', [xs + 0.005, 0, -0.7 * r], r),
    seed('behind', [-1.1, 0, 0], r),
    seed('tiny', [0.3, 0, 0], 1e-7),
  ];
  const res = traceLevel(testLevel(1, [-1, 0, 0], [1, 0, 0], seeds), FREE, []);
  const s = res.seeds;
  const cp = s.out.closestPoint;
  check(
    'seed hits between steps',
    s.centre.lit && s.in.lit && s['in-z'].lit && s.tiny.lit,
    `centre ${s.centre.lit}, 0.999r ${s.in.lit}, z ${s['in-z'].lit}, r=1e-7 ${s.tiny.lit}`,
  );
  check(
    'seed misses just outside',
    !s.out.lit && Math.abs(s.out.closest - 1.001 * r) < 1e-12 && cp !== null && Math.abs(cp[0] - xs) < 1e-12 && cp[1] === 0,
    `closest ${ex(s.out.closest, 6)} (1.001r), point x=${cp ? fx(cp[0], 6) : 'null'}`,
  );
  check('seed behind the source', !s.behind.lit && Math.abs(s.behind.closest - 0.1) < 1e-12, `closest ${fx(s.behind.closest, 6)}`);
}

// ---------------------------------------------------------------------------------------------
// 6. Echo order
// ---------------------------------------------------------------------------------------------

function echoChecks(): void {
  // Corridor zigzag (see reflectionChecks). The source lights echo A early; A shoots straight down the
  // corridor and reaches echo X sooner than the zigzagging source does, so X's time, intensity and
  // place in the order come from A's beam (Dijkstra decrease-key). X emits up and lights Z.
  const H = 0.2;
  const corridor: TraceWorld = { de: (_x, y) => Math.min(y, H - y), material: 'reflect' };
  const r = 0.01;
  const seeds = [
    seed('G', [-0.6, 0.1, 0], r),
    seed('X', [-0.55, 0.05, 0], r, { kind: 'echo', goal: false, emit: [0, 1, 0] }),
    seed('Z', [-0.55, 0.12, 0], r),
    seed('A', [-0.95, 0.05, 0], r, { kind: 'echo', goal: false, emit: [1, 0, 0] }),
  ];
  const res = traceLevel(testLevel(1, [-1, 0.1, 0], [1, -1, 0], seeds), corridor, []);
  const o = (id: string): number => res.seeds[id].order;
  const from = res.beams.map((b) => b.from ?? 'source').join(',');
  check(
    'echo order = light-travel time',
    o('A') === 0 && o('X') === 1 && o('Z') === 2 && o('G') === 3 && from === 'source,A,X' && res.solved,
    `order A${o('A')} X${o('X')} Z${o('Z')} G${o('G')}; beams ${from}`,
  );
  check('echo lit by the earlier beam', res.seeds.X.intensity === 1, `X intensity ${fx(res.seeds.X.intensity, 3)} (0.49 via the source)`);

  // Two echoes facing each other: each emits once.
  const ping = [
    seed('E1', [0, 0, 0], 0.01, { kind: 'echo', goal: false, emit: [0, 1, 0] }),
    seed('E2', [0, 0.5, 0], 0.01, { kind: 'echo', goal: true, emit: [0, -1, 0] }),
  ];
  const pr = traceLevel(testLevel(1, [-1, 0, 0], [1, 0, 0], ping), FREE, []);
  check('echoes emit once', pr.beams.length === 3 && pr.solved, `${pr.beams.length} beams`);

  // Sixteen echoes on the source line: 1 + 15 beams (cap 16).
  const chain: SeedDef[] = [];
  for (let i = 0; i < 16; i++) chain.push(seed(`e${i}`, [-0.8 + 0.1 * i, 0, 0], 0.01, { kind: 'echo', goal: i === 0, emit: [0, 0, 1] }));
  const cr = traceLevel(testLevel(1, [-1, 0, 0], [1, 0, 0], chain), FREE, []);
  check('beam cap', cr.beams.length === TRACE.maxBeams, `${cr.beams.length} beams, ${Object.values(cr.seeds).filter((s) => s.lit).length} lit`);
}

// ---------------------------------------------------------------------------------------------
// 7. Mandelbulb arena: contract, determinism, timing
// ---------------------------------------------------------------------------------------------

interface Arena {
  tag: string;
  level: LevelDef;
  world: TraceWorld;
  /** The same arena with reflecting surfaces (exercises fractal normals). */
  mirror: TraceWorld;
  free: (p: Vec3, clearance: number) => boolean;
  rand: (rng: () => number, clearance: number) => Vec3;
}

/**
 * A Mandelbulb arena of radius 0.12 local whose centre sits at k × the surface radius along the direction
 * of local (0.55, 0.45, 0.35): k = 1.02 is an open arena (≈ 83 % free), k = 0.94 a dense one (≈ 57 %
 * free, inside the build plan's 35–75 % band).
 */
function bulbArena(k: number, tag: string): Arena {
  const fractal = nebulaFractal('bulb');
  const params = frozenParams('bulb', 0);
  const de = (p: Vec3): number => fractal.de(p[0], p[1], p[2], params, fractal.cpuIter);
  // Surface along the direction of local (0.55, 0.45, 0.35): sphere-trace inward from outside the bound.
  const u = norm([0.55, 0.45, 0.35]);
  let rs = fractal.boundRadius * 1.1;
  for (let i = 0; i < 4000; i++) {
    const d = de([u[0] * rs, u[1] * rs, u[2] * rs]);
    if (d < 1e-6) break;
    rs -= Math.max(0.9 * d, 1e-6);
  }
  const R = 0.12;
  const C: Vec3 = [u[0] * rs * k, u[1] * rs * k, u[2] * rs * k];
  const inArena = (p: Vec3, k: number): boolean => Math.hypot(p[0] - C[0], p[1] - C[1], p[2] - C[2]) <= k * R;
  const free = (p: Vec3, clearance: number): boolean => de(p) > clearance;
  const rand = (rng: () => number, clearance: number): Vec3 => {
    for (let i = 0; i < 10000; i++) {
      const p: Vec3 = [C[0] + (2 * rng() - 1) * R, C[1] + (2 * rng() - 1) * R, C[2] + (2 * rng() - 1) * R];
      if (inArena(p, 0.95) && free(p, clearance)) return p;
    }
    throw new Error('no free point found');
  };
  // Fixed source and seeds: free points chosen by a seeded search. The source sits on the open side
  // (away from the bulb centre) and aims at the free point closest to structure, so the beam grazes.
  const rng = rng32(0x5eed);
  let srcPos: Vec3 = C;
  let best = -Infinity;
  for (let i = 0; i < 400; i++) {
    const p = rand(rng, 0.1 * R);
    const outward = (p[0] - C[0]) * u[0] + (p[1] - C[1]) * u[1] + (p[2] - C[2]) * u[2];
    if (outward > best) {
      best = outward;
      srcPos = p;
    }
  }
  let target: Vec3 = C;
  let nearest = Infinity;
  for (let i = 0; i < 400; i++) {
    const p = rand(rng, 0.02 * R);
    const d = de(p);
    if (d < nearest) {
      nearest = d;
      target = p;
    }
  }
  const seeds: SeedDef[] = [];
  for (let i = 0; i < 3; i++) seeds.push(seed(`s${i}`, rand(rng, 0.12 * R), 0.05 * R));
  seeds.push({ ...seed('echo', rand(rng, 0.12 * R), 0.05 * R), kind: 'echo', goal: false, emit: norm([rng() - 0.5, rng() - 0.5, rng() - 0.5]) });
  const raw = {
    id: 'bulb-check',
    chapter: 'check',
    index: 1,
    name: 'Check',
    nebula: 'bulb',
    clock: 0,
    arena: { centerLocal: C, radiusLocal: R, vantage: { pos: srcPos, lookAt: C } },
    source: { pos: srcPos, dir: [target[0] - srcPos[0], target[1] - srcPos[1], target[2] - srcPos[2]] },
    seeds,
    masses: { light: 0.012 * R, medium: 0.022 * R, heavy: 0.035 * R },
    budget: { light: 2, medium: 1, heavy: 1 },
    solution: [],
    hints: ['a', 'b', 'c'],
    teach: 'check',
    par: 2,
  };
  const errors: string[] = [];
  const level = sanitizeLevel(raw, errors);
  if (!level) throw new Error(`bulb arena does not sanitise: ${errors.join('; ')}`);
  let freeCount = 0;
  const frng = rng32(7);
  for (let i = 0; i < 2000; i++) {
    const p: Vec3 = [C[0] + (2 * frng() - 1) * R, C[1] + (2 * frng() - 1) * R, C[2] + (2 * frng() - 1) * R];
    if (!inArena(p, 1)) {
      i--;
      continue;
    }
    if (de(p) > 0) freeCount++;
  }
  const sourceClear = de(level.source.pos);
  const seedClear = Math.min(...level.seeds.map((s) => de(s.pos) / s.radius));
  check(
    `${tag} bulb arena: source and seeds free`,
    sourceClear > 0.1 * R && seedClear > 2,
    `centre ${C.map((v) => fx(v, 4)).join(',')} (surface r=${fx(rs, 4)}), R=${R}, free ${fx((freeCount / 2000) * 100, 0)} %, ` +
      `source DE ${fx(sourceClear / R, 2)} R, seeds DE ≥ ${fx(seedClear, 1)} r`,
  );
  return { tag, level, world: makeTraceWorld(level), mirror: makeTraceWorld({ ...level, material: 'reflect' }), free, rand };
}

function randomMasses(a: Arena, rng: () => number, count: number, nearBeam: TraceResult | null): PlacedMass[] {
  const sizes: MassSize[] = ['light', 'medium', 'heavy'];
  const out: PlacedMass[] = [];
  for (let i = 0; i < count; i++) {
    const size = sizes[Math.floor(rng() * 3)];
    const rho = rhoOf(a.level, size);
    let pos: Vec3;
    if (nearBeam && rng() < 0.6) {
      // Beside the unlensed beam (2–15 ρ off it): strong bends, captures, near-mass stepping.
      const pts = nearBeam.beams[0].points;
      const k = 3 * Math.floor(rng() * (pts.length / 3));
      let tries = 0;
      do {
        const off = norm([rng() - 0.5, rng() - 0.5, rng() - 0.5]);
        const dist = (2 + 13 * rng()) * rho;
        pos = [pts[k] + off[0] * dist, pts[k + 1] + off[1] * dist, pts[k + 2] + off[2] * dist];
      } while (!a.free(pos, 2 * rho) && ++tries < 50);
      if (tries >= 50) pos = a.rand(rng, 3 * rho);
    } else {
      pos = a.rand(rng, 3 * rho);
    }
    out.push({ size, pos, rho });
  }
  return out;
}

/** Full-precision, order-stable serialisation (Infinity / NaN spelled out). */
function serialise(r: TraceResult): string {
  return JSON.stringify(r, (_k, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? `#${String(v)}` : v));
}

function contractViolations(r: TraceResult, level: LevelDef, nMasses: number, coarse: boolean): string[] {
  const bad: string[] = [];
  if (r.massClosest.length !== nMasses) bad.push('massClosest length');
  if (r.steps > (coarse ? TRACE.maxStepsCoarse : TRACE.maxSteps) + TRACE.maxBeams) bad.push(`steps ${r.steps}`);
  if (r.beams.length < 1 || r.beams.length > TRACE.maxBeams) bad.push('beam count');
  for (const b of r.beams) {
    const n = b.points.length / 3;
    if (n < 2 || b.intensity.length !== n || b.length.length !== n) bad.push('array lengths');
    if (!b.points.every(Number.isFinite) || !b.length.every(Number.isFinite) || !b.intensity.every(Number.isFinite)) bad.push('non-finite');
    for (let i = 1; i < n; i++) if (b.length[i] < b.length[i - 1]) bad.push('length decreasing');
    if ((b.end === 'captured') !== b.captureMass >= 0) bad.push('captureMass');
    if (b.end === 'absorbed' && !b.endNormal) bad.push('absorbed without normal');
    if (b.reflections.length > 0 && level.material !== 'reflect') bad.push('reflection on absorbing world');
    if (!b.endPos.every(Number.isFinite)) bad.push('endPos');
    if (!(b.deflection >= 0)) bad.push('deflection');
    const last = 3 * (n - 1);
    if (b.points[last] !== b.endPos[0] || b.points[last + 1] !== b.endPos[1] || b.points[last + 2] !== b.endPos[2]) bad.push('endPos ≠ last point');
  }
  let goalsLit = true;
  for (const s of level.seeds) {
    const st = r.seeds[s.id];
    if (!st) {
      bad.push(`seed ${s.id} missing`);
      continue;
    }
    if (st.lit !== st.order >= 0 || (st.lit && st.intensity < TRACE.seedThreshold)) bad.push('seed state');
    if (st.lit && st.closest > s.radius) bad.push('lit seed beyond radius');
    if (s.goal && !st.lit) goalsLit = false;
  }
  if (r.solved !== goalsLit) bad.push('solved');
  return bad;
}

function unlensedOf(a: Arena, world: TraceWorld): TraceResult {
  const r = traceLevel(a.level, world, []);
  const b = r.beams[0];
  console.log(
    `${a.tag} bulb arena (${world.material}): unlensed beam ${b.end} after ${fx(b.length[b.length.length - 1] / a.level.arena.radiusLocal, 2)} R, ` +
      `${r.steps} steps, ${b.reflections.length / 3} reflections, ${r.beams.length} beam(s)`,
  );
  return r;
}

/** Contract + determinism over 1000 random configurations (half coarse, a third reflecting). */
function arenaChecks(a: Arena): void {
  const lv = a.level;
  const unlensed = unlensedOf(a, a.world);
  unlensedOf(a, a.mirror);
  const N = 1000;
  const rng = rng32(0xc0ffee);
  const configs: { masses: PlacedMass[]; coarse: boolean; world: TraceWorld; level: LevelDef }[] = [];
  const mirrorLevel: LevelDef = { ...lv, material: 'reflect' };
  for (let i = 0; i < N; i++) {
    const reflect = i % 3 === 2;
    configs.push({
      masses: randomMasses(a, rng, 1 + Math.floor(rng() * 4), unlensed),
      coarse: i % 2 === 1,
      world: reflect ? a.mirror : a.world,
      level: reflect ? mirrorLevel : lv,
    });
  }
  const first: string[] = new Array(N);
  const violations = new Map<string, number>();
  const ends: Record<string, number> = {};
  let solvedCount = 0;
  let maxSteps = 0;
  let reflections = 0;
  for (let i = 0; i < N; i++) {
    const c = configs[i];
    const r = traceLevel(c.level, c.world, c.masses, { coarse: c.coarse });
    first[i] = serialise(r);
    for (const v of contractViolations(r, c.level, c.masses.length, c.coarse)) violations.set(v, (violations.get(v) ?? 0) + 1);
    for (const b of r.beams) {
      ends[b.end] = (ends[b.end] ?? 0) + 1;
      reflections += b.reflections.length / 3;
    }
    if (r.solved) solvedCount++;
    maxSteps = Math.max(maxSteps, r.steps);
  }
  let mismatches = 0;
  for (let i = N - 1; i >= 0; i--) {
    const c = configs[i];
    if (serialise(traceLevel(c.level, c.world, c.masses, { coarse: c.coarse })) !== first[i]) mismatches++;
  }
  check(
    'result contract (1000 configs)',
    violations.size === 0,
    violations.size
      ? [...violations].map(([k, v]) => `${k}×${v}`).join(', ')
      : `beam ends ${JSON.stringify(ends)}, ${reflections} reflections, solved ${solvedCount}, max steps ${maxSteps}`,
  );
  check('determinism: 1000 configs, two runs', mismatches === 0, `${mismatches} mismatches (reverse order)`);

  // Quantisation: positions moved by < half a quantum (from grid points) trace bit-identically.
  let qMismatch = 0;
  for (let i = 0; i < 200; i++) {
    const base = configs[i].masses.map((m) => ({ ...m, pos: m.pos.map((v) => Math.round(v * 1e6) / 1e6) as Vec3 }));
    const jitter = base.map((m) => ({ ...m, pos: m.pos.map((v) => v + (rng() - 0.5) * 0.6e-6) as Vec3 }));
    if (serialise(traceLevel(lv, a.world, base)) !== serialise(traceLevel(lv, a.world, jitter))) qMismatch++;
  }
  check('quantisation: sub-quantum jitter is invisible', qMismatch === 0, `${qMismatch}/200 differ`);
}

/** Timing: 300 configurations of 3 masses (60 % beside the unlensed beam), warm JIT, full and coarse. */
function timingChecks(a: Arena, world: TraceWorld): void {
  const lv: LevelDef = { ...a.level, material: world.material };
  const unlensed = traceLevel(lv, world, []);
  const trng = rng32(42);
  const tconf: PlacedMass[][] = [];
  for (let i = 0; i < 300; i++) tconf.push(randomMasses(a, trng, 3, unlensed));
  for (let i = 0; i < 60; i++) traceLevel(lv, world, tconf[i], { coarse: i % 2 === 1 });
  for (const coarse of [false, true]) {
    const times: number[] = [];
    let steps = 0;
    let maxSteps = 0;
    for (const m of tconf) {
      const t0 = performance.now();
      const r = traceLevel(lv, world, m, { coarse });
      times.push(performance.now() - t0);
      steps += r.steps;
      maxSteps = Math.max(maxSteps, r.steps);
    }
    times.sort((x, y) => x - y);
    const mean = times.reduce((s, t) => s + t, 0) / times.length;
    const p95 = times[Math.floor(times.length * 0.95)];
    const max = times[times.length - 1];
    const target = coarse ? 3 : 8;
    check(
      `timing ${a.tag} ${world.material} ${coarse ? 'coarse' : 'full'} (≤ ${target} ms)`,
      p95 <= target,
      `mean ${fx(mean, 3)} ms, p95 ${fx(p95, 3)}, max ${fx(max, 3)}; steps mean ${Math.round(steps / times.length)}, max ${maxSteps}`,
    );
  }
}

/**
 * Worst case: a beam crawling along a plane 1.05 eps above it takes eps-sized steps until the per-beam
 * budget ends it. The DE also evaluates the Mandelbulb (discarded) so each step costs what it costs in
 * a real arena. Informational: it bounds a full-budget (30 000-step) trace.
 */
function stressCheck(a: Arena): void {
  const lv = a.level;
  const R = lv.arena.radiusLocal;
  const C = lv.arena.centerLocal;
  const eps = TRACE.eps * R;
  const y0 = C[1] - 0.3 * R;
  let sink = 0;
  const crawl: TraceWorld = {
    de: (x, y, z) => {
      sink += a.world.de(x, y, z);
      return y - y0;
    },
    material: 'absorb',
  };
  const level = testLevel(R, [C[0] - R, y0 + 1.05 * eps, C[2]], [1, 0, 0], [seed('s', [C[0], C[1] + 0.5 * R, C[2]], 0.05 * R)], C);
  traceLevel(level, crawl, []);
  const t0 = performance.now();
  const reps = 5;
  let r: TraceResult | null = null;
  for (let i = 0; i < reps; i++) r = traceLevel(level, crawl, []);
  const ms = (performance.now() - t0) / reps;
  const steps = r ? r.steps : 0;
  const perStep = (ms / Math.max(steps, 1)) * 1000;
  rows.push([
    r && r.beams[0].end === 'limit' && steps === TRACE.maxStepsPerBeam ? 'info' : 'FAIL',
    'worst case: surface crawl to the beam budget',
    `${steps} steps in ${fx(ms, 2)} ms (${fx(perStep, 2)} µs/step) → a ${TRACE.maxSteps}-step trace ≈ ${fx((perStep * TRACE.maxSteps) / 1000, 1)} ms, ` +
      `coarse ${TRACE.maxStepsCoarse} ≈ ${fx((perStep * TRACE.maxStepsCoarse) / 1000, 1)} ms (bulb DE sum ${ex(sink, 2)})`,
  ]);
  if (!(r && r.beams[0].end === 'limit' && steps === TRACE.maxStepsPerBeam)) failures++;
}

// ---------------------------------------------------------------------------------------------
// 8. Level helpers, sanitiser, frozen params
// ---------------------------------------------------------------------------------------------

async function levelChecks(a: Arena): Promise<void> {
  const lv = a.level;
  check(
    'level helpers',
    rhoOf(lv, 'medium') === lv.masses.medium && budgetCount(lv, 'heavy') === 1 && budgetCount({ ...lv, budget: { light: 1 } }, 'heavy') === 0 && totalBudget(lv) === 4,
    `ρ(medium)=${ex(rhoOf(lv, 'medium'))}, total budget ${totalBudget(lv)}`,
  );
  const R = lv.arena.radiusLocal;
  const C = lv.arena.centerLocal;
  const base = JSON.parse(JSON.stringify(lv)) as Record<string, unknown> & LevelDef;
  const mutate = (f: (l: LevelDef & Record<string, unknown>) => void): unknown => {
    const c = JSON.parse(JSON.stringify(base)) as LevelDef & Record<string, unknown>;
    f(c);
    return c;
  };
  const bad: [string, unknown][] = [
    ['seed outside 1.25 R', mutate((l) => (l.seeds[0].pos = [C[0] + 1.3 * R, C[1], C[2]]))],
    ['source outside 1.25 R', mutate((l) => (l.source.pos = [C[0], C[1] - 1.26 * R, C[2]]))],
    ['ρ > 6 % R', mutate((l) => (l.masses.heavy = 0.061 * R))],
    ['17 seeds', mutate((l) => (l.seeds = Array.from({ length: 17 }, (_, i) => ({ ...l.seeds[0], id: `s${i}` }))))],
    ['7 budget items', mutate((l) => (l.budget = { light: 3, medium: 2, heavy: 2 }))],
    ['NaN coordinate', mutate((l) => (l.seeds[1].pos[2] = NaN))],
    ['zero source dir', mutate((l) => (l.source.dir = [0, 0, 0]))],
    ['unknown nebula', mutate((l) => (l.nebula = 'nowhere'))],
    ['black hole nebula', mutate((l) => (l.nebula = 'bh-eye'))],
    ['prototype nebula', mutate((l) => (l.nebula = 'constructor'))],
    ['__proto__ seed id', mutate((l) => (l.seeds[0].id = '__proto__'))],
    ['no goal seed', mutate((l) => l.seeds.forEach((s) => (s.goal = false)))],
    ['duplicate seed id', mutate((l) => (l.seeds[1].id = l.seeds[0].id))],
    ['echo without emit', mutate((l) => delete l.seeds[3].emit)],
    ['solution over budget', mutate((l) => (l.solution = [{ size: 'heavy', pos: C }, { size: 'heavy', pos: C }]))],
    ['two hints', mutate((l) => (l.hints = ['a', 'b'] as unknown as [string, string, string]))],
  ];
  const accepted = bad.filter(([, raw]) => sanitizeLevel(raw) !== null).map(([n]) => n);
  check('sanitizeLevel rejects bad data', accepted.length === 0, accepted.length ? `accepted: ${accepted.join(', ')}` : `${bad.length} cases rejected`);
  const okLevel = sanitizeLevel(
    mutate((l) => {
      l.source.dir = [0, 0, 5];
      delete (l.masses as Partial<Record<MassSize, number>>).light;
      l.solution = [{ size: 'light', pos: C }];
    }),
  );
  check(
    'sanitizeLevel normalises',
    okLevel !== null && okLevel.source.dir[2] === 1 && okLevel.masses.light === 0.012 * R && okLevel.par === lv.par && okLevel.solution.length === 1,
    okLevel ? `dir ${okLevel.source.dir.join(',')}, default ρ(light) ${ex(okLevel.masses.light)}` : 'rejected',
  );

  // frozenParams = what Universe animates for the same clock (first update pins the clock to `time`).
  try {
    const { Universe } = await import('../src/universe/Universe');
    const { NEBULAE } = await import('../src/universe/catalog');
    const THREE = await import('three');
    const clock = 37.5;
    const u = new Universe(NEBULAE);
    u.update(clock, new THREE.Vector3(1e6, 1e6, 1e6));
    let worst = 0;
    let n = 0;
    for (const def of NEBULAE) {
      if (def.fractal === 'blackhole') continue;
      const p = frozenParams(def.id, clock);
      const q = u.get(def.id)!.params;
      for (let i = 0; i < 16; i++) worst = Math.max(worst, Math.abs(p[i] - q[i]));
      n++;
    }
    check('frozenParams = Universe params', worst === 0, `${n} nebulae at clock ${clock}, max |Δ| ${worst}`);
  } catch (e) {
    rows.push(['skip', 'frozenParams = Universe params', `Universe not loadable: ${(e as Error).message}`]);
  }
  check(
    'defaultMaterial',
    defaultMaterial('apollonian') === 'reflect' && defaultMaterial('kleinian') === 'reflect' && defaultMaterial('bulb') === 'absorb' && defaultMaterial('menger') === 'absorb',
    'apollonian/kleinian reflect, others absorb',
  );
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = performance.now();
  deflectionChecks();
  captureChecks();
  symmetryChecks();
  reflectionChecks();
  tunnellingChecks();
  echoChecks();
  const dense = bulbArena(0.94, 'dense');
  const open = bulbArena(1.02, 'open');
  arenaChecks(dense);
  timingChecks(dense, dense.world);
  timingChecks(dense, dense.mirror);
  timingChecks(open, open.world);
  stressCheck(dense);
  await levelChecks(dense);

  console.log('');
  const w = Math.max(...rows.map((r) => r[1].length));
  for (const [s, n, d] of rows) console.log(`${s.padEnd(4)}  ${n.padEnd(w)}  ${d}`);
  console.log(`\n${rows.length - failures}/${rows.length} passed in ${fx((performance.now() - t0) / 1000, 1)} s${failures ? ` — ${failures} FAILED` : ''}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
