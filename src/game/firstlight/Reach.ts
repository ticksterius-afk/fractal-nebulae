/**
 * First Light — click reachability (design/60-first-light-build.md §1 decision #2, §2, §L): where the game's
 * own click puts a mass, and whether a player can actually CLICK each solution mass into place.
 *
 * Shared by tools/fl-reach.ts (the `reach` gate of tools/fl-check.ts and the bundle audit) and the Generator
 * (its click-aware construction and the quick reach gate every daily passes), so there is one model of the
 * click and it is the game's: Placement.flightPlacementPoint / labPlacementPoint / hoveredMass, LabView's
 * framing and Solver.placementIssue, the very functions the mode calls, on a simulated 1280×720 canvas
 * with the default 70° vertical FOV (AppSettings fovDeg 70; Simulation adds hyper widening only, which is
 * off in arenas). three.js maths only (already in the app bundle; runs in Node), no DOM. Deterministic: no
 * randomness, budgets are trace counts.
 *
 * Why: the solver gates measure precision in the view plane at the AUTHORED depth, but a click puts the
 * mass on the reticle / cursor ray at the depth of the beam's closest point to that ray (Placement.beamSnap,
 * within 0.2 of the viewport height), else halfway to the surface (flight) or on the plane through the
 * arena centre (lab), and the wheel scales the depth. A mass authored off that depth cannot be clicked;
 * where two beam legs cross on screen (a bounce coming back) the snap can pick the other leg.
 *
 *  - Flight: the ship stands at the vantage. The reticle is the screen centre, so "a click at P" means the
 *    ship turned to look through P (lookRotation(dir, arena up), as the entry glide poses it). The aims form
 *    a grid of ±half px at `spacing` px around the direction of the step's authored mass, measured in the
 *    screen of a camera looking at that mass (reticle pixels). The mass hovered by the reticle (Placement.
 *    hoveredMass) would be grabbed instead: such aims fail. Wheel notch n multiplies the depth by 1.15ⁿ
 *    before the click (the mode's depthMul).
 *  - Lab: the default framing (LabView.enter from the vantage pose → OverviewCamera.frame, snapped), the
 *    cursor on a grid around the authored mass's projection, clipped to the canvas. Notch n = click, then the
 *    wheel while the fresh mass is held: its view depth × 1.15ⁿ along the same cursor ray; it only moves
 *    there when that point is legal (the mode's dragTo), else it stays where the click put it.
 *  - Legality is Solver.placementIssue against the masses placed so far (as Placement.issueAt).
 *  - A click SOLVES its step when the level solves with it, the earlier masses where they were placed and the
 *    later masses at their authored positions. Steps run in light-travel order along the authored solution
 *    (the order a player builds the path in); the snap sees the beams of the masses placed so far. Each step's
 *    mass is then placed at its best click (the solving aim deepest inside the solving region: largest
 *    Chebyshev margin, ties to the aim nearest the authored mass), at the best notch when notch 0 has none,
 *    at the authored position when no click solves. Flight and lab keep separate chains; the lab chain uses
 *    plain clicks only (what the depth clause asks of the lab), so --fast and a full scan give the same verdict.
 *  - Area = solving aims × spacing² (px²). "aim" = the click aimed exactly at the authored mass (wheel 0):
 *    solves or not, and how far from the authored point the click put the mass (× R).
 *
 * GATE (REACH.minArea, tools/fl-check.ts): every step needs ≥ 400 px² of one-click solving area in flight
 * at wheel 0, or — the depth clause, for the rare step whose design needs the wheel — ≥ 400 px² at some
 * notch within ±2 AND ≥ 400 px² with a plain click in the default lab framing; and the click aimed at the
 * authored mass must solve (at wheel 0, or at the depth-clause notch). The aim rule is the playtest that
 * found the problem, and hint 2 draws its sphere around the authored mass, so a click there has to work —
 * also at the ends of the pause menu's FOV range (REACH.aimFovs, 60° and 100°, same chain): the snap reach
 * is a fraction of the viewport HEIGHT, so a narrower FOV shrinks it in angle, and a mass ~0.17 viewport
 * heights beside the beam at 70° is out of reach at 60° (the click then drops to half the surface distance).
 * The areas barely depend on the FOV once converted to angle; the aim does.
 * 400 px² is a 20 × 20 px window (≈ 2.2° across at the reticle); see REACH for the measured spread.
 *
 * QUICK GATE (quickReach, the Generator's `reach` option; every daily passes it): the same rule with plain
 * flight clicks only (no depth clause), on the gate's own 4 px grid but flood-filled from the aim at the
 * authored mass instead of scanned: the aim must solve (at 70°, 60° and 100°), the solving region CONNECTED
 * to it must reach the area, and the chain places each mass at that region's best click, as above. So it
 * is the full gate restricted to plain clicks and the aim's own region (stricter; only the chain can differ,
 * when a region apart from the aim's holds the grid's best click — R-D2 review, 48 dailies of every tier
 * and 147 generator candidates: every quick pass (96) passed reachLevel, 12 of 99 quick fails passed it on
 * area away from the aim, e.g. 16 px² around the aim and 1 712 px² elsewhere), at a cost
 * that grows with the region instead of the grid (the last step stops counting at the threshold): on the
 * 400 bundled dailies 35 traces per level (tier 1 median) to 848 (worst Saturday), 2–54 ms, where a scan
 * traces ~10 000 aims per step. An 8 px grid would be cheaper still but accepted thin regions the 4 px gate
 * rejects (2 of 40 sampled dailies: 7 coarse cells = 448 px², 224–352 px² at 4 px).
 *
 * Public API:
 *   REACH                                                        canvas, scan and gate constants
 *   reachLevel(level, opts?) → ReachReport                       the full measurement (fl-reach, fl-check)
 *   quickReach(level, opts?) → QuickReachReport                  the generator's gate
 *   vantageClick(level, world, placed, beams, target, size, fov?) → Click   one aimed click from the vantage
 *   lightOrder(level, trace) → solution indices in light-travel order
 */
import * as THREE from 'three';
import type { Vec3 } from '../../core/types';
import { lookRotation } from '../../sim/quat';
import { traceLevel } from './BeamTracer';
import { LabView, LocalView } from './LabView';
import { createPlacementPoint, flightPlacementPoint, hoveredMass, labPlacementPoint, PLACEMENT } from './Placement';
import { placementIssue } from './Solver';
import { makeTraceWorld } from './world';
import type { LevelDef, MassSize, PlacedMass, TraceResult, TraceWorld } from './types';

/** Simulated canvas, scan and gate. */
export const REACH = {
  /** Canvas CSS size and vertical FOV (AppSettings default). */
  width: 1280,
  height: 720,
  fovDeg: 70,
  /** Scan: ± this many px around the authored mass, at this spacing. */
  half: 200,
  spacing: 4,
  /** Wheel notches scanned: −notches … +notches. */
  notches: 2,
  /**
   * Gate: one-click solving area (px²) per step — flight at wheel 0, or (depth clause) at a notch within
   * ±notches AND in the lab framing. Measured 2026-10-03 on the 24 steps of the 18 chapter levels (after
   * WP L4 re-aimed reflect-2…5): flight wheel 0 spans 416 … 16 448 px², median ≈ 2 800; the tightest are
   * the first steps of two-mass levels (thread-4 416, thread-6 592, thread-5 624, bend-6 752: lower bounds,
   * the later mass stays at its authored point) and reflect-4 (768, two bounces). Before the fix reflect-2
   * had 16 px² and reflect-5's first step 336; reflect-3 (8 320) and reflect-4 (528) passed only away from
   * the authored point (the aim rule fails them).
   */
  minArea: 400,
  /**
   * The aim rule also runs at these vertical FOVs (the pause menu's 60…100° ends; same canvas, same chain).
   * Measured 2026-10-03 (R4 review): at 60° the WP L4 reflect-2 mass and reflect-5's second mass were out of
   * snap reach (aim 0.155 R / 0.378 R off, no snap); both were moved toward the beam into the 60° region.
   */
  aimFovs: [60, 100],
  /** Quick gate (quickReach): grid spacing (px; the full gate's, see the header). */
  quickSpacing: 4,
} as const;

export interface ScanResult {
  notch: number;
  /** Solving aims × spacing² (px²). */
  area: number;
  /** Best click: offset (px) from the authored mass on the scan grid, Chebyshev margin (px), placed point. */
  best: { dx: number; dy: number; margin: number; pos: Vec3 } | null;
  /** The click aimed exactly at the authored mass solves at this notch. */
  aim: boolean;
}

export interface AimResult {
  solves: boolean;
  /** Distance of the placed mass from the authored one (× R); NaN when no point / not placeable. */
  miss: number;
  snapped: boolean;
  /** Why the click could not place ('hover' = a placed mass under the reticle grabs instead). */
  issue: string | null;
}

export interface StepReach {
  /** Index into level.solution. */
  index: number;
  size: MassSize;
  /** Per scanned notch (absent notches were skipped by --fast). */
  flight: ScanResult[];
  lab: ScanResult[];
  flight0: number;
  flightBest: number;
  flightBestNotch: number;
  lab0: number;
  labBest: number;
  aim: AimResult | null;
  aimLab: AimResult | null;
  /** The same aim at each of REACH.aimFovs (flight, the gate's notch, the same chain). */
  aimFovs: (AimResult & { fov: number })[];
  /** The aim at the authored mass solves (flight; wheel 0, or the best notch for a depth-clause step; at 70° and every aimFov). */
  aimOk: boolean;
  pass: boolean;
  /** Passed through the depth clause only (wheel + lab), not with a plain flight click. */
  depth: boolean;
}

export interface ReachReport {
  id: string;
  /** Light-travel order of the solution indices. */
  order: number[];
  steps: StepReach[];
  pass: boolean;
  /** Smallest flight wheel-0 area over the steps (px²). */
  minFlight0: number;
  traces: number;
  ms: number;
}

export interface ReachOptions {
  half?: number;
  spacing?: number;
  /** Gate order: flight wheel 0 first, the notches and the lab only where a step needs them. */
  fast?: boolean;
  world?: TraceWorld;
}

// ---------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _f = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pt = createPlacementPoint();

const dist3 = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function arenaUp(level: LevelDef, out: THREE.Vector3): THREE.Vector3 {
  const u = level.arena.up;
  out.set(u ? u[0] : 0, u ? u[1] : 1, u ? u[2] : 0);
  if (!(out.lengthSq() > 1e-12)) out.set(0, 1, 0);
  return out.normalize();
}

/** Solution indices in light-travel order: by the beam, then the path length, of each mass's closest approach. */
export function lightOrder(level: LevelDef, r: TraceResult): number[] {
  const key = level.solution.map((m, i) => {
    let best = Infinity;
    let k = Infinity;
    r.beams.forEach((b, bi) => {
      const P = b.points;
      for (let j = 0; 3 * j < P.length; j++) {
        const d = Math.hypot(P[3 * j] - m.pos[0], P[3 * j + 1] - m.pos[1], P[3 * j + 2] - m.pos[2]);
        if (d < best) {
          best = d;
          k = bi * 1e6 + b.length[j];
        }
      }
    });
    return { i, k };
  });
  return key.sort((a, b) => a.k - b.k || a.i - b.i).map((e) => e.i);
}

interface Cell {
  /** Grid offsets (px) from the authored mass. */
  dx: number;
  dy: number;
  /** Placed point per notch (null = no point / illegal / grabbed). */
  pts: (Vec3 | null)[];
  issue: string | null;
  snapped: boolean;
}

/**
 * One step, one view: the placement point of the aim (dx, dy) px from the target at every notch, with the
 * game's code. aimGrid scans a whole grid with it; quickReach floods from the centre; vantageClick is (0, 0).
 */
function aimRig(
  level: LevelDef,
  world: TraceWorld,
  placed: readonly PlacedMass[],
  beams: TraceResult['beams'],
  target: Readonly<Vec3>,
  size: MassSize,
  mode: 'flight' | 'lab',
  notches: readonly number[],
  fov: number = REACH.fovDeg,
): (dx: number, dy: number) => Cell {
  const C = level.arena.centerLocal;
  const R = level.arena.radiusLocal;
  const rho = level.masses[size];
  const W = REACH.width;
  const H = REACH.height;
  const up = arenaUp(level, new THREE.Vector3());
  const vp = level.arena.vantage.pos;
  // The camera the grid is measured in: flight = at the vantage looking at the authored mass (reticle
  // pixels); lab = the default framing (screen pixels around the mass's projection).
  const base = new LocalView();
  let cx = W * 0.5;
  let cy = H * 0.5;
  if (mode === 'flight') {
    _pos.set(vp[0], vp[1], vp[2]);
    _f.set(target[0] - vp[0], target[1] - vp[1], target[2] - vp[2]).normalize();
    base.setLocal(_pos, lookRotation(_f, up, _q), fov, W, H);
  } else {
    const lab = new LabView();
    const look = level.arena.vantage.lookAt;
    _pos.set(vp[0], vp[1], vp[2]);
    _f.set(look[0] - vp[0], look[1] - vp[1], look[2] - vp[2]).normalize();
    lab.enter(level.arena, _pos, lookRotation(_f, up, new THREE.Quaternion()));
    base.setLocal(lab.cam.position, lab.cam.quaternion, fov, W, H);
    const sp = { x: 0, y: 0, depth: 0 };
    base.project(target[0], target[1], target[2], sp);
    cx = sp.x;
    cy = sp.y;
  }
  const view = mode === 'flight' ? new LocalView() : base;
  const ray = new THREE.Vector3();
  return (dx: number, dy: number): Cell => {
    const cell: Cell = { dx, dy, pts: notches.map(() => null), issue: null, snapped: false };
    let px = cx + dx;
    let py = cy + dy;
    if (mode === 'flight') {
      // Turn the ship so the reticle (screen centre) looks through this aim.
      base.ray(px, py, _o, ray);
      view.setLocal(_o, lookRotation(ray, up, _q), fov, W, H);
      px = W * 0.5;
      py = H * 0.5;
    } else if (px < 0 || px >= W || py < 0 || py >= H) {
      cell.issue = 'off screen';
      return cell;
    }
    view.ray(px, py, _o, _d);
    if (hoveredMass(placed, view, px, py) >= 0) {
      cell.issue = 'hover';
      return cell;
    }
    const ok =
      mode === 'flight'
        ? flightPlacementPoint(world, beams, view, _o, _d, C, R, 1, _pt)
        : labPlacementPoint(beams, view, _o, _d, C, R, _pt);
    if (!ok) {
      cell.issue = 'no point';
      return cell;
    }
    cell.snapped = _pt.snapped;
    const p0: Vec3 = [_pt.x, _pt.y, _pt.z];
    const issue0 = placementIssue(level, world, rho, p0, placed);
    if (mode === 'lab' && issue0 !== null) {
      // The click itself must place before the wheel can move the held mass.
      cell.issue = issue0;
      return cell;
    }
    const t0 = _pt.t;
    const dDotF = _d.dot(view.forward);
    notches.forEach((notch, k) => {
      let p: Vec3;
      if (notch === 0) p = p0;
      else if (mode === 'flight') {
        // depthMul before the click (t·1·m is bitwise t·m: the shared function's own product).
        const m = Math.min(Math.max(Math.pow(PLACEMENT.depthStep, notch), PLACEMENT.depthMulMin), PLACEMENT.depthMulMax);
        const t = t0 * m;
        p = [_o.x + _d.x * t, _o.y + _d.y * t, _o.z + _d.z * t];
      } else {
        // Lab: the held mass's view depth × 1.15ⁿ (clamped like the mode), along the same cursor ray.
        const depth0 = (p0[0] - _o.x) * view.forward.x + (p0[1] - _o.y) * view.forward.y + (p0[2] - _o.z) * view.forward.z;
        const depth = Math.min(Math.max(depth0 * Math.pow(PLACEMENT.depthStep, notch), 0.05 * R), 6 * R);
        const t = depth / dDotF;
        const q: Vec3 = [_o.x + _d.x * t, _o.y + _d.y * t, _o.z + _d.z * t];
        p = placementIssue(level, world, rho, q, placed) === null ? q : p0;
      }
      if (mode === 'flight' && (notch === 0 ? issue0 : placementIssue(level, world, rho, p, placed)) !== null) {
        if (notch === 0) cell.issue = issue0;
        return;
      }
      cell.pts[k] = p;
    });
    return cell;
  };
}

/** One step, one view: the placement point of every aim on the grid at every notch (row-major, n × n). */
function aimGrid(
  level: LevelDef,
  world: TraceWorld,
  placed: readonly PlacedMass[],
  beams: TraceResult['beams'],
  target: Readonly<Vec3>,
  size: MassSize,
  mode: 'flight' | 'lab',
  notches: readonly number[],
  half: number,
  spacing: number,
  fov: number = REACH.fovDeg,
): Cell[] {
  const aim = aimRig(level, world, placed, beams, target, size, mode, notches, fov);
  const n = 2 * Math.round(half / spacing) + 1;
  const mid = (n - 1) / 2;
  const cells: Cell[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) cells.push(aim((i - mid) * spacing, (j - mid) * spacing));
  }
  return cells;
}

/** Chebyshev margin (cells) of every solving cell to the nearest non-solving / outside cell. */
function margins(ok: boolean[], n: number): number[] {
  const m = ok.map((v) => (v ? Infinity : 0));
  const at = (i: number, j: number): number => (i < 0 || j < 0 || i >= n || j >= n ? 0 : m[j * n + i]);
  for (let pass = 0; pass < 2; pass++) {
    for (let jj = 0; jj < n; jj++) {
      for (let ii = 0; ii < n; ii++) {
        const i = pass === 0 ? ii : n - 1 - ii;
        const j = pass === 0 ? jj : n - 1 - jj;
        const k = j * n + i;
        if (m[k] === 0) continue;
        const s = pass === 0 ? -1 : 1;
        m[k] = Math.min(m[k], at(i + s, j) + 1, at(i, j + s) + 1, at(i + s, j + s) + 1, at(i - s, j + s) + 1);
      }
    }
  }
  return m;
}

/** The best click of a grid: the solving cell with the largest margin, ties to the one nearest the centre; −1 if none. */
function bestCell(cells: readonly Cell[], ok: readonly boolean[], m: readonly number[]): number {
  let best = -1;
  for (let c = 0; c < cells.length; c++) {
    if (!ok[c]) continue;
    if (best < 0 || m[c] > m[best] || (m[c] === m[best] && Math.hypot(cells[c].dx, cells[c].dy) < Math.hypot(cells[best].dx, cells[best].dy))) best = c;
  }
  return best;
}

interface ScanOut {
  scans: ScanResult[];
  aim: AimResult;
}

/** Trace every placeable aim of a grid and summarise the solving region per notch. */
function scanStep(
  level: LevelDef,
  world: TraceWorld,
  placed: readonly PlacedMass[],
  rest: readonly PlacedMass[],
  target: Readonly<Vec3>,
  size: MassSize,
  mode: 'flight' | 'lab',
  notches: readonly number[],
  half: number,
  spacing: number,
  count: { traces: number },
  fov: number = REACH.fovDeg,
  aimNotch = 0,
): ScanOut {
  const beams = traceLevel(level, world, placed).beams;
  count.traces++;
  const cells = aimGrid(level, world, placed, beams, target, size, mode, notches, half, spacing, fov);
  const n = Math.round(Math.sqrt(cells.length));
  const rho = level.masses[size];
  const R = level.arena.radiusLocal;
  const centre = (n * n - 1) / 2;
  const scans: ScanResult[] = [];
  let aim: AimResult = { solves: false, miss: NaN, snapped: false, issue: 'no point' };
  notches.forEach((notch, k) => {
    const ok = cells.map((c) => {
      const p = c.pts[k];
      if (!p) return false;
      count.traces++;
      return traceLevel(level, world, [...placed, { size, pos: p, rho }, ...rest]).solved;
    });
    const m = margins(ok, n);
    const best = bestCell(cells, ok, m);
    const count1 = ok.filter(Boolean).length;
    scans.push({
      notch,
      area: count1 * spacing * spacing,
      best: best >= 0 ? { dx: cells[best].dx, dy: cells[best].dy, margin: m[best] * spacing, pos: cells[best].pts[k] as Vec3 } : null,
      aim: ok[centre],
    });
    if (notch === aimNotch) {
      const c = cells[centre];
      const p = c.pts[k];
      aim = { solves: ok[centre], miss: p ? dist3(p, target) / R : NaN, snapped: c.snapped, issue: p ? null : c.issue };
    }
  });
  return { scans, aim };
}

const area = (scans: readonly ScanResult[], notch: number): number => scans.find((s) => s.notch === notch)?.area ?? 0;
const bestScan = (scans: readonly ScanResult[]): ScanResult | null => scans.reduce<ScanResult | null>((b, s) => (!b || s.area > b.area ? s : b), null);
/** Where the chain puts a step's mass: the best click at notch 0, else at the best notch, else null (authored). */
const chainPos = (scans: readonly ScanResult[]): Vec3 | null => {
  const s0 = scans.find((s) => s.notch === 0);
  if (s0?.best) return s0.best.pos;
  const b = bestScan(scans);
  return b?.best ? b.best.pos : null;
};

/** The click-reachability report of a (sanitised) level. */
export function reachLevel(level: LevelDef, opts: ReachOptions = {}): ReachReport {
  const t0 = performance.now();
  const world = opts.world ?? makeTraceWorld(level);
  const half = opts.half ?? REACH.half;
  const spacing = opts.spacing ?? REACH.spacing;
  const allNotches: number[] = [];
  for (let k = -REACH.notches; k <= REACH.notches; k++) allNotches.push(k);
  const sideNotches = allNotches.filter((k) => k !== 0);
  const count = { traces: 0 };
  const sol: PlacedMass[] = level.solution.map((m) => ({ size: m.size, pos: [m.pos[0], m.pos[1], m.pos[2]], rho: level.masses[m.size] }));
  count.traces++;
  const order = lightOrder(level, traceLevel(level, world, sol));
  const restOf = (k: number): PlacedMass[] => order.slice(k + 1).map((i) => sol[i]);

  // Flight chain (wheel 0 first; the other notches now, or with --fast only for steps that need them).
  const steps: StepReach[] = [];
  const placedF: PlacedMass[] = [];
  /** The flight chain before each step (for the aim at the other FOVs). */
  const beforeF: PlacedMass[][] = [];
  order.forEach((idx, k) => {
    const m = sol[idx];
    beforeF.push(placedF.slice());
    const first = scanStep(level, world, placedF, restOf(k), m.pos, m.size, 'flight', opts.fast ? [0] : allNotches, half, spacing, count);
    let flight = first.scans;
    if (opts.fast && area(flight, 0) < REACH.minArea) {
      flight = [...flight, ...scanStep(level, world, placedF, restOf(k), m.pos, m.size, 'flight', sideNotches, half, spacing, count).scans].sort((a, b) => a.notch - b.notch);
    }
    const b = bestScan(flight);
    steps.push({
      index: idx,
      size: m.size,
      flight,
      lab: [],
      flight0: area(flight, 0),
      flightBest: b ? b.area : 0,
      flightBestNotch: b ? b.notch : 0,
      lab0: 0,
      labBest: 0,
      aim: first.aim,
      aimLab: null,
      aimFovs: [],
      aimOk: false,
      pass: false,
      depth: false,
    });
    placedF.push({ size: m.size, pos: chainPos(flight) ?? m.pos, rho: m.rho });
  });

  // Lab chain (all steps, unless --fast and every step passes in flight at wheel 0).
  const needLab = !opts.fast || steps.some((s) => s.flight0 < REACH.minArea);
  if (needLab) {
    const placedL: PlacedMass[] = [];
    order.forEach((idx, k) => {
      const m = sol[idx];
      const out = scanStep(level, world, placedL, restOf(k), m.pos, m.size, 'lab', opts.fast ? [0] : allNotches, half, spacing, count);
      const st = steps[k];
      st.lab = out.scans;
      st.aimLab = out.aim;
      st.lab0 = area(out.scans, 0);
      st.labBest = bestScan(out.scans)?.area ?? 0;
      placedL.push({ size: m.size, pos: out.scans.find((sc) => sc.notch === 0)?.best?.pos ?? m.pos, rho: m.rho });
    });
  }
  steps.forEach((s, k) => {
    const plain = s.flight0 >= REACH.minArea;
    s.depth = !plain && s.flightBest >= REACH.minArea && s.lab0 >= REACH.minArea;
    const notch = s.depth ? s.flightBestNotch : 0;
    // The same aim at the ends of the FOV range: one click each (a 1 × 1 grid), same chain, same notch.
    const m = sol[s.index];
    for (const fov of REACH.aimFovs) {
      const out = scanStep(level, world, beforeF[k], restOf(k), m.pos, m.size, 'flight', [notch], 0, spacing, count, fov, notch);
      s.aimFovs.push({ fov, ...out.aim });
    }
    s.aimOk = (s.flight.find((f) => f.notch === notch)?.aim ?? false) && s.aimFovs.every((a) => a.solves);
    s.pass = (plain || s.depth) && s.aimOk;
  });
  return {
    id: level.id,
    order,
    steps,
    pass: steps.every((s) => s.pass),
    minFlight0: steps.reduce((a, s) => Math.min(a, s.flight0), Infinity),
    traces: count.traces,
    ms: performance.now() - t0,
  };
}

// ---------------------------------------------------------------------------------------------
// The generator's side: one aimed click, and the quick gate
// ---------------------------------------------------------------------------------------------

/** What the click aimed at a point does. */
export interface Click {
  /** Where the mass lands (LOCAL), or null when the click places nothing. */
  pos: Vec3 | null;
  /** The beam snap chose the depth. */
  snapped: boolean;
  /** Why nothing was placed: a legality issue, 'hover' (a placed mass under the reticle is grabbed instead) or 'no point'. */
  issue: string | null;
}

/**
 * The click aimed exactly at `target` from the level's vantage (flight, wheel 0, the reticle on it; the
 * snap sees `beams`, legality and hover test `placed`), with the game's code at a vertical FOV of `fov`.
 * The Generator places every mass with it, so an authored mass is where its aimed click lands.
 */
export function vantageClick(
  level: LevelDef,
  world: TraceWorld,
  placed: readonly PlacedMass[],
  beams: TraceResult['beams'],
  target: Readonly<Vec3>,
  size: MassSize,
  fov: number = REACH.fovDeg,
): Click {
  const c = aimRig(level, world, placed, beams, target, size, 'flight', [0], fov)(0, 0);
  return { pos: c.pts[0], snapped: c.snapped, issue: c.pts[0] ? null : c.issue };
}

export interface QuickReachOptions {
  /** Grid spacing (px, default REACH.quickSpacing) and half-size (px, default REACH.half). */
  spacing?: number;
  half?: number;
  /** One-click area each step needs (px², default REACH.minArea). */
  minArea?: number;
  world?: TraceWorld;
}

export interface QuickStep {
  /** Index into level.solution. */
  index: number;
  /** Solving area connected to the aim (px²; the last step stops counting once it has enough). */
  area: number;
  /** The aim at the authored mass solves at 70° / at every REACH.aimFovs. */
  aim: boolean;
  aimFovs: boolean;
}

export interface QuickReachReport {
  pass: boolean;
  /** The first failure: "step k: aim", "step k: aim at 60°", "step k: area" (null when it passes). */
  failure: string | null;
  /** The steps evaluated (light order; evaluation stops at the first failure). */
  steps: QuickStep[];
  /** Smallest step area (px²; Infinity before any step was measured). */
  minArea: number;
  traces: number;
}

/**
 * The quick reach gate (see the header): plain flight clicks at wheel 0 on a coarse grid, flood-filled
 * (8-connected) from the aim at each authored mass, in light-travel order with fl-reach's chain rule.
 * Deterministic; stops at the first failing step.
 */
export function quickReach(level: LevelDef, opts: QuickReachOptions = {}): QuickReachReport {
  const world = opts.world ?? makeTraceWorld(level);
  const spacing = opts.spacing ?? REACH.quickSpacing;
  const half = opts.half ?? REACH.half;
  const need = opts.minArea ?? REACH.minArea;
  const out: QuickReachReport = { pass: false, failure: null, steps: [], minArea: Infinity, traces: 0 };
  const sol: PlacedMass[] = level.solution.map((m) => ({ size: m.size, pos: [m.pos[0], m.pos[1], m.pos[2]], rho: level.masses[m.size] }));
  out.traces++;
  const order = lightOrder(level, traceLevel(level, world, sol));
  const n = 2 * Math.round(half / spacing) + 1;
  const mid = (n - 1) / 2;
  const centre = mid * n + mid;
  const placed: PlacedMass[] = [];
  for (let k = 0; k < order.length; k++) {
    const m = sol[order[k]];
    const rest = order.slice(k + 1).map((i) => sol[i]);
    const beams = traceLevel(level, world, placed).beams;
    out.traces++;
    const solves = (c: Cell): boolean => {
      const p = c.pts[0];
      if (!p) return false;
      out.traces++;
      return traceLevel(level, world, [...placed, { size: m.size, pos: p, rho: m.rho }, ...rest]).solved;
    };
    const fail = (why: string): QuickReachReport => {
      out.failure = `step ${k + 1}: ${why}`;
      return out;
    };
    const aim = aimRig(level, world, placed, beams, m.pos, m.size, 'flight', [0]);
    // 0 = not visited, 1 = solves, 2 = does not.
    const state = new Uint8Array(n * n);
    const cells: Cell[] = new Array<Cell>(n * n);
    cells[centre] = aim(0, 0);
    const step: QuickStep = { index: order[k], area: 0, aim: solves(cells[centre]), aimFovs: false };
    out.steps.push(step);
    if (!step.aim) return fail('aim');
    state[centre] = 1;
    // Flood fill: the whole region for the chain's best click; the last step only needs enough of it.
    const last = k === order.length - 1;
    const queue = [centre];
    let found = 1;
    for (let qi = 0; qi < queue.length && !(last && found * spacing * spacing >= need); qi++) {
      const c = queue[qi];
      const ci = c % n;
      const cj = (c - ci) / n;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= n || j >= n || state[j * n + i] !== 0) continue;
          const q = j * n + i;
          cells[q] = aim((i - mid) * spacing, (j - mid) * spacing);
          if (solves(cells[q])) {
            state[q] = 1;
            found++;
            queue.push(q);
          } else state[q] = 2;
        }
      }
    }
    step.area = found * spacing * spacing;
    out.minArea = Math.min(out.minArea, step.area);
    if (step.area < need) return fail('area');
    // The same aim at the ends of the FOV range (same chain).
    for (const fov of REACH.aimFovs) {
      if (!solves(aimRig(level, world, placed, beams, m.pos, m.size, 'flight', [0], fov)(0, 0))) return fail(`aim at ${fov}°`);
    }
    step.aimFovs = true;
    if (!last) {
      // The chain: this step's mass at its best click (unvisited cells count as not solving; bestCell
      // reads only solving cells, all visited).
      const ok = Array.from(state, (s) => s === 1);
      const best = bestCell(cells, ok, margins(ok, n));
      placed.push({ size: m.size, pos: cells[best].pts[0] as Vec3, rho: m.rho });
    }
  }
  out.pass = true;
  return out;
}
