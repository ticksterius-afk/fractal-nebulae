/**
 * First Light — placing masses (design/60-first-light-build.md §M "Placement/legality", decision #2).
 *
 *  - Placement: the player's masses with a 50-deep undo / redo history. Every committed change (place,
 *    remove, clear, a finished drag, undo / redo) bumps `version` and `committed`; live drag moves
 *    bump only `version` (the mode retraces coarsely while dragging and fully on commit).
 *    Legality is the solver's placementIssue(), so the game and the level gates agree exactly.
 *  - Geometry helpers in LOCAL units: the beam-depth snap (the default placement depth is the depth of
 *    the beam's closest point to the pointer ray when the beam passes within ~0.2 of the viewport
 *    height of the pointer), surface hits by sphere tracing the frozen DE, the drop line to the
 *    nearest surface, and the hovered mass (nearest projected centre within max(22 px, shadow + 8 px)).
 *  - The placement point itself (flightPlacementPoint, labPlacementPoint): where a click puts a mass
 *    along the reticle / cursor ray. The mode and tools/fl-reach.ts (the `reach` gate of fl-check) call
 *    the very same functions, so the gate measures exactly what a click does in the game.
 *
 * Per-frame helpers are allocation-free; history snapshots are allocated on commits only.
 */
import * as THREE from 'three';
import type { Vec3 } from '../../core/types';
import { placementIssue, type PlacementIssue } from './Solver';
import { budgetCount, rhoOf } from './Level';
import { CRITICAL_IMPACT } from './Geodesic';
import type { Beam, LevelDef, MassSize, PlacedMass, TraceWorld } from './types';
import type { LocalView, ScreenPos } from './LabView';

export const PLACEMENT = {
  /** Undo depth. */
  history: 50,
  /**
   * Beam snap: the beam must pass within this fraction of the viewport height of the pointer ray.
   * Authored solutions sit up to ~0.18 viewport heights beside the beam from the vantage (heavy masses
   * at large impact parameters), so a narrower reach dropped those clicks to the wrong depth.
   */
  snapFrac: 0.2,
  /** Wheel: placement depth / grab distance × this per notch. */
  depthStep: 1.15,
  /** Placement depth multiplier range. */
  depthMulMin: 0.15,
  depthMulMax: 6,
  /** Hover radius: max(minPx, shadow radius + padPx). */
  hoverMinPx: 22,
  hoverPadPx: 8,
  /** Precision drag factor (Shift). */
  precision: 0.2,
  /** Sphere tracing: steps, surface epsilon (× R). */
  traceSteps: 96,
  traceEps: 3e-4,
} as const;

function cloneMasses(src: readonly PlacedMass[]): PlacedMass[] {
  return src.map((m) => ({ size: m.size, pos: [m.pos[0], m.pos[1], m.pos[2]] as Vec3, rho: m.rho }));
}

export class Placement {
  /** Current configuration (the tracer reads it directly). */
  readonly masses: PlacedMass[] = [];
  /** Bumped on every change, live drag moves included. */
  version = 0;
  /** Bumped on committed changes only. */
  committed = 0;
  private readonly undoStack: PlacedMass[][] = [];
  private readonly redoStack: PlacedMass[][] = [];
  /** Snapshot taken when a drag began (null when not dragging). */
  private moveBase: PlacedMass[] | null = null;
  private moveIndex = -1;
  /** The dragged mass was placed by this very gesture (its undo step already exists). */
  private moveFresh = false;
  private readonly scratch: Vec3 = [0, 0, 0];

  constructor(
    private level: LevelDef,
    private world: TraceWorld,
  ) {}

  /** A new level (or a restart): no masses, no history. */
  reset(level: LevelDef, world: TraceWorld): void {
    this.level = level;
    this.world = world;
    this.masses.length = 0;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.moveBase = null;
    this.moveIndex = -1;
    this.version++;
    this.committed++;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 && this.moveBase === null;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0 && this.moveBase === null;
  }
  get moving(): number {
    return this.moveIndex;
  }

  placedCount(size: MassSize): number {
    let n = 0;
    for (let i = 0; i < this.masses.length; i++) if (this.masses[i].size === size) n++;
    return n;
  }

  available(size: MassSize): number {
    return Math.max(0, budgetCount(this.level, size) - this.placedCount(size));
  }

  rho(size: MassSize): number {
    return rhoOf(this.level, size);
  }

  /** Legality of a mass of `rho` at a local point (`skip` = the mass being moved). */
  issueAt(x: number, y: number, z: number, rho: number, skip = -1): PlacementIssue | null {
    const p = this.scratch;
    p[0] = x;
    p[1] = y;
    p[2] = z;
    return placementIssue(this.level, this.world, rho, p, this.masses, skip);
  }

  /** Place a mass (caller checked budget and legality). Returns its index. */
  add(size: MassSize, x: number, y: number, z: number): number {
    this.pushUndo();
    this.masses.push({ size, pos: [x, y, z], rho: this.rho(size) });
    this.bump(true);
    return this.masses.length - 1;
  }

  remove(index: number): boolean {
    if (index < 0 || index >= this.masses.length || this.moveBase !== null) return false;
    this.pushUndo();
    this.masses.splice(index, 1);
    this.bump(true);
    return true;
  }

  /** Remove every mass (undoable). False when there was nothing to clear. */
  clear(): boolean {
    if (this.masses.length === 0 || this.moveBase !== null) return false;
    this.pushUndo();
    this.masses.length = 0;
    this.bump(true);
    return true;
  }

  /** Replace the configuration (dev solve hook, restore), as one undoable step. */
  setAll(list: readonly { size: MassSize; pos: Readonly<Vec3> }[]): void {
    this.cancelMove();
    this.pushUndo();
    this.masses.length = 0;
    for (const m of list) this.masses.push({ size: m.size, pos: [m.pos[0], m.pos[1], m.pos[2]], rho: this.rho(m.size) });
    this.bump(true);
  }

  /**
   * Begin dragging mass `index` (snapshot for undo). `fresh`: the mass was just placed by the same
   * gesture (lab place-and-drag), so add() already took the undo step and the drag adds none.
   */
  beginMove(index: number, fresh = false): boolean {
    if (index < 0 || index >= this.masses.length) return false;
    if (this.moveBase === null) this.moveBase = cloneMasses(this.masses);
    this.moveIndex = index;
    this.moveFresh = fresh;
    return true;
  }

  /** Live move during a drag (no history entry). */
  moveTo(x: number, y: number, z: number): void {
    const m = this.masses[this.moveIndex];
    if (!m || !Number.isFinite(x + y + z)) return;
    if (m.pos[0] === x && m.pos[1] === y && m.pos[2] === z) return;
    m.pos[0] = x;
    m.pos[1] = y;
    m.pos[2] = z;
    this.bump(false);
  }

  /** Finish a drag: one undo step when the mass moved (none for a fresh place-and-drag). Returns true when it moved. */
  endMove(): boolean {
    const base = this.moveBase;
    const i = this.moveIndex;
    const fresh = this.moveFresh;
    this.moveBase = null;
    this.moveIndex = -1;
    this.moveFresh = false;
    if (!base) return false;
    const m = this.masses[i];
    const b = base[i];
    const moved = !m || !b || m.pos[0] !== b.pos[0] || m.pos[1] !== b.pos[1] || m.pos[2] !== b.pos[2];
    if (moved && !fresh) {
      this.undoStack.push(base);
      if (this.undoStack.length > PLACEMENT.history) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    this.bump(true);
    return moved;
  }

  /** Abort a drag: the mass returns to where it was picked up. */
  cancelMove(): void {
    const base = this.moveBase;
    this.moveBase = null;
    this.moveIndex = -1;
    this.moveFresh = false;
    if (!base) return;
    this.restore(base);
    this.bump(true);
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(cloneMasses(this.masses));
    if (this.redoStack.length > PLACEMENT.history) this.redoStack.shift();
    this.restore(prev);
    this.bump(true);
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(cloneMasses(this.masses));
    if (this.undoStack.length > PLACEMENT.history) this.undoStack.shift();
    this.restore(next);
    this.bump(true);
    return true;
  }

  private restore(list: PlacedMass[]): void {
    this.masses.length = 0;
    for (const m of list) this.masses.push({ size: m.size, pos: [m.pos[0], m.pos[1], m.pos[2]], rho: this.rho(m.size) });
  }

  private pushUndo(): void {
    this.undoStack.push(cloneMasses(this.masses));
    if (this.undoStack.length > PLACEMENT.history) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private bump(commit: boolean): void {
    this.version++;
    if (commit) this.committed++;
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry (LOCAL units, allocation-free)
// ---------------------------------------------------------------------------------------------

export interface SnapHit {
  /** Distance along the ray (unit direction) of the point beside the beam. */
  t: number;
  /** Pointer-to-beam distance in CSS px. */
  px: number;
}

/**
 * Beam-depth snap: the beam point closest (on screen) to the ray, if within `maxPx`. The returned
 * `t` puts the placement point on the ray in the view plane of that beam point, i.e. beside the beam
 * exactly where the player points. Only beam parts inside 1.25 R of the arena centre count.
 */
export function beamSnap(
  beams: readonly Beam[],
  view: LocalView,
  o: THREE.Vector3,
  d: THREE.Vector3,
  centre: Readonly<Vec3>,
  R: number,
  maxPx: number,
  out: SnapHit,
): boolean {
  let best = maxPx;
  let bestT = -1;
  const fx = view.forward.x;
  const fy = view.forward.y;
  const fz = view.forward.z;
  const dDotF = d.x * fx + d.y * fy + d.z * fz;
  if (!(dDotF > 1e-6)) return false;
  const lim2 = 1.25 * R * 1.25 * R;
  for (let b = 0; b < beams.length; b++) {
    const pts = beams[b].points;
    for (let i = 0; i + 5 < pts.length; i += 3) {
      const ax = pts[i];
      const ay = pts[i + 1];
      const az = pts[i + 2];
      const ux = pts[i + 3] - ax;
      const uy = pts[i + 4] - ay;
      const uz = pts[i + 5] - az;
      const uu = ux * ux + uy * uy + uz * uz;
      if (!(uu > 1e-24)) continue;
      // Closest points between the ray o + s·d (|d| = 1) and the segment a + τ·u, τ ∈ [0, 1].
      const wx = o.x - ax;
      const wy = o.y - ay;
      const wz = o.z - az;
      const bq = d.x * ux + d.y * uy + d.z * uz;
      const dq = d.x * wx + d.y * wy + d.z * wz;
      const eq = ux * wx + uy * wy + uz * wz;
      const den = uu - bq * bq;
      let tau = den > 1e-18 ? (eq - bq * dq) / den : 0;
      tau = tau < 0 ? 0 : tau > 1 ? 1 : tau;
      const qx = ax + ux * tau;
      const qy = ay + uy * tau;
      const qz = az + uz * tau;
      const cx = qx - centre[0];
      const cy = qy - centre[1];
      const cz = qz - centre[2];
      if (cx * cx + cy * cy + cz * cz > lim2) continue;
      const depth = (qx - o.x) * fx + (qy - o.y) * fy + (qz - o.z) * fz;
      if (!(depth > 1e-9)) continue;
      // Distance from Q to the ray, in pixels at Q's depth.
      const s = (qx - o.x) * d.x + (qy - o.y) * d.y + (qz - o.z) * d.z;
      if (!(s > 0)) continue;
      const px0 = o.x + d.x * s - qx;
      const py0 = o.y + d.y * s - qy;
      const pz0 = o.z + d.z * s - qz;
      const px = Math.sqrt(px0 * px0 + py0 * py0 + pz0 * pz0) / view.pixelSize(depth);
      if (px < best) {
        best = px;
        bestT = depth / dDotF;
      }
    }
  }
  if (bestT <= 0 || !Number.isFinite(bestT)) return false;
  out.t = bestT;
  out.px = best;
  return true;
}

/** Where a click would place a mass along a pointer ray (LOCAL units). */
export interface PlacementPoint {
  x: number;
  y: number;
  z: number;
  /** Distance along the ray (unit direction). */
  t: number;
  /** Flight: the unscaled reference distance the depth gauge reads against (surface hit, else the arena exit); 0 in the lab view. */
  ref: number;
  /** The beam snap chose the depth. */
  snapped: boolean;
}

export function createPlacementPoint(): PlacementPoint {
  return { x: 0, y: 0, z: 0, t: 0, ref: 0, snapped: false };
}

const _snapHit: SnapHit = { t: 0, px: 0 };

function placeOnRay(o: THREE.Vector3, d: THREE.Vector3, t: number, ref: number, snapped: boolean, out: PlacementPoint): boolean {
  if (!Number.isFinite(t) || t <= 0) return false;
  out.x = o.x + d.x * t;
  out.y = o.y + d.y * t;
  out.z = o.z + d.z * t;
  out.t = t;
  out.ref = ref;
  out.snapped = snapped;
  return true;
}

/**
 * Flight preview point (build plan decision #2): on the reticle ray (o, d; in flight d is the view's
 * forward) at the depth of the beam's closest point to the ray when a beam passes within
 * snapFrac × the viewport height of it (view.height px; pixel sizes from the view's vertical FOV),
 * else halfway to the first surface (or to where the ray leaves 1.25 R); times the wheel's depth
 * multiplier. `beams` null (no trace yet) disables the snap. False when there is no point.
 */
export function flightPlacementPoint(
  world: TraceWorld,
  beams: readonly Beam[] | null,
  view: LocalView,
  o: THREE.Vector3,
  d: THREE.Vector3,
  centre: Readonly<Vec3>,
  R: number,
  depthMul: number,
  out: PlacementPoint,
): boolean {
  const snapped = beams ? beamSnap(beams, view, o, d, centre, R, PLACEMENT.snapFrac * view.height, _snapHit) : false;
  const exitT = sphereExit(o, d, centre, 1.25 * R);
  const maxT = exitT > 0 ? exitT : 2.5 * R;
  const hit = surfaceHit(world, o, d, maxT, PLACEMENT.traceEps * R);
  const ref = Number.isFinite(hit) ? hit : maxT;
  return placeOnRay(o, d, (snapped ? _snapHit.t : 0.5 * ref) * depthMul, ref, snapped, out);
}

/**
 * Lab-view placement point: on the cursor ray (o, d) at the beam-snap depth (as in flight), else on
 * the plane through the arena centre facing the camera. No wheel factor (the wheel dollies; while a
 * fresh mass is held it moves the mass along the cursor ray instead). False when there is no point.
 */
export function labPlacementPoint(
  beams: readonly Beam[] | null,
  view: LocalView,
  o: THREE.Vector3,
  d: THREE.Vector3,
  centre: Readonly<Vec3>,
  R: number,
  out: PlacementPoint,
): boolean {
  if (beams && beamSnap(beams, view, o, d, centre, R, PLACEMENT.snapFrac * view.height, _snapHit)) {
    return placeOnRay(o, d, _snapHit.t, 0, true, out);
  }
  const f = view.forward;
  const dDotF = d.dot(f);
  if (!(dDotF > 1e-6)) return false;
  const t = ((centre[0] - o.x) * f.x + (centre[1] - o.y) * f.y + (centre[2] - o.z) * f.z) / dDotF;
  if (!(t > 0)) return false;
  return placeOnRay(o, d, t, 0, false, out);
}

/**
 * Sphere-trace the frozen DE along a ray: distance to the first surface contact, or Infinity when
 * nothing is hit within maxT.
 */
export function surfaceHit(world: TraceWorld, o: THREE.Vector3, d: THREE.Vector3, maxT: number, eps: number): number {
  let t = 0;
  for (let i = 0; i < PLACEMENT.traceSteps; i++) {
    const de = world.de(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
    if (!(de > eps)) return t;
    t += Math.max(de * 0.9, eps);
    if (t > maxT) return Infinity;
  }
  return Infinity;
}

/** Distance along a ray (|d| = 1, origin inside or outside) to where it leaves a sphere; 0 if it never enters. */
export function sphereExit(o: THREE.Vector3, d: THREE.Vector3, c: Readonly<Vec3>, r: number): number {
  const ox = o.x - c[0];
  const oy = o.y - c[1];
  const oz = o.z - c[2];
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (!(disc > 0)) return 0;
  const t = -b + Math.sqrt(disc);
  return t > 0 ? t : 0;
}

/**
 * Foot of the drop line from p to the nearest surface (central-difference DE gradient). Returns the
 * distance (the DE at p), writing the foot to `out`; Infinity when the gradient is unusable.
 */
export function dropToSurface(world: TraceWorld, x: number, y: number, z: number, h: number, out: THREE.Vector3): number {
  const d = world.de(x, y, z);
  const gx = world.de(x + h, y, z) - world.de(x - h, y, z);
  const gy = world.de(x, y + h, z) - world.de(x, y - h, z);
  const gz = world.de(x, y, z + h) - world.de(x, y, z - h);
  const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
  if (!(gl > 1e-20) || !(d > 0) || !Number.isFinite(d)) return Infinity;
  out.set(x - (gx / gl) * d, y - (gy / gl) * d, z - (gz / gl) * d);
  return d;
}

const _sp: ScreenPos = { x: 0, y: 0, depth: 0 };

/** Index of the mass under the pointer (nearest projected centre within its hover radius), or −1. */
export function hoveredMass(masses: readonly PlacedMass[], view: LocalView, px: number, py: number, skip = -1): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < masses.length; i++) {
    if (i === skip) continue;
    const m = masses[i];
    if (!view.project(m.pos[0], m.pos[1], m.pos[2], _sp)) continue;
    const shadowPx = (CRITICAL_IMPACT * m.rho) / view.pixelSize(_sp.depth);
    const r = Math.max(PLACEMENT.hoverMinPx, shadowPx + PLACEMENT.hoverPadPx);
    const dx = _sp.x - px;
    const dy = _sp.y - py;
    const dd = Math.sqrt(dx * dx + dy * dy);
    if (dd <= r && dd < bestD) {
      bestD = dd;
      best = i;
    }
  }
  return best;
}
