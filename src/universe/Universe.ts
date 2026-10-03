/**
 * Universe: runtime state of every nebula (animated params, spin, ship-relative distances)
 * plus the world-space distance estimator used for flight speed, collision and targeting.
 *
 * Units: world = light-years. Fractal nebulae use LOCAL fractal units scaled by
 * `scale = worldRadius / fractal.boundRadius`; black holes use Schwarzschild radii
 * (`scale = rs`), as agreed with the black-hole shader.
 */
import * as THREE from 'three';
import type { FractalDef, FractalKind, NebulaDef, NebulaRuntime } from '../core/types';
import { smoothstep } from '../core/math';
import { getFractal } from '../fractals/registry';

/**
 * Black-hole distance floor in units of rs. The black-hole "surface" for flight purposes is
 * the horizon (`r − rs`), floored so DE-adaptive cruise never stalls near the horizon and
 * gravity can carry the ship across it into the wormhole.
 */
export const BLACK_HOLE_DE_FLOOR = 0.25;

/**
 * Closest the ship may get to a fractal surface, in LOCAL fractal units. Roughly the limit
 * where float32 raymarching still resolves surface detail cleanly.
 */
export const SURFACE_CLEARANCE_LOCAL = 5e-5;

/**
 * Fractal DE shell (× boundRadiusWorld). Inside SHELL_INNER the distance is max(fractal DE,
 * bound-sphere distance); beyond SHELL_OUTER it is the analytic bound-sphere distance; in between
 * the fractal DE blends into it. Both terms are lower bounds of the true distance (the fractal DEs
 * were verified conservative within ~5 % out to 2.2× bound), so the result stays conservative —
 * and, unlike a hard switch at the bound sphere, it is continuous: the analytic distance collapses
 * to ~0 at the (invisible) bound sphere while the real surface is typically 0.1–0.3 bound further
 * in, which made DE-adaptive cruise crawl at the sphere and then lurch forward inside it.
 */
const DE_SHELL_INNER = 1.3;
const DE_SHELL_OUTER = 2.0;
/** Influence is 1 inside `boundRadiusWorld × INFLUENCE_CORE`. */
const INFLUENCE_CORE = 1.1;
/**
 * Each nebula breathes on its own animation clock, which slows down when the ship is deep in its
 * structure: rate = clamp(local surface distance / ANIM_SLOW_LOCAL, ANIM_MIN_RATE, 1). Otherwise
 * the breathing surfaces sweep past a ship hovering 1e-3 local units away many times faster than it
 * can move, and the push-out shoves it around (it feels stuck). Params stay continuous.
 */
const ANIM_SLOW_LOCAL = 0.05;
const ANIM_MIN_RATE = 0.02;
/** Extra angular tolerance for picking (radians, ≈2°). */
const PICK_TOLERANCE = (2 * Math.PI) / 180;
/** Reticle-ray march through the fractal the ship is inside (pick only). */
const PICK_MARCH_STEPS = 96;
/** Ray counts as touching structure when DE < this × distance along the ray (cone ≈ 0.1°). */
const PICK_HIT_CONE = 2e-3;
/** From inside a halo, a ray passing this close (× bound) to the centre looks into the nebula's heart. */
const PICK_CORE_FRACTION = 0.6;
/** exitDistance(): step budget and minimum step growth (fraction of the distance travelled). */
const EXIT_PROBE_STEPS = 96;
const EXIT_PROBE_GROWTH = 0.12;
const EXIT_OPEN_FRACTION = 0.2;

export interface DistanceResult {
  /** World distance estimate (ly). May be negative just inside a surface. */
  dist: number;
  /** Nebula the estimate came from (null if there are no nebulae). */
  id: string | null;
}

export type FractalResolver = (kind: FractalKind) => FractalDef | null;

const _rel = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _dirN = new THREE.Vector3();
const _c = new THREE.Vector3();
const _ray = new THREE.Vector3();

export class Universe {
  readonly runtimes: NebulaRuntime[];

  private readonly byId = new Map<string, NebulaRuntime>();
  private readonly baseRotation: THREE.Quaternion[] = [];
  private readonly spinAxisLocal: THREE.Vector3[] = [];
  private readonly baseParams: (readonly number[])[] = [];
  /** Per-nebula animation clocks (s) and the time of the previous update (NaN before the first). */
  private animClock: Float64Array = new Float64Array(0);
  /** Per-nebula pinned animation clock (setFrozenClock); NaN = animating normally. */
  private frozenClock: Float64Array;
  private lastTime = NaN;
  private readonly clearanceWorld: number[] = [];
  /** Result object reused by distance() (valid until the next call). */
  private readonly result: DistanceResult = { dist: Infinity, id: null };
  private lastIndex = -1;

  /**
   * @param defs nebula catalog
   * @param resolveFractal fractal lookup (defaults to the registry; injectable for tests)
   */
  constructor(defs: NebulaDef[], resolveFractal: FractalResolver = getFractal) {
    this.runtimes = defs.map((def, index) => {
      const fractal = resolveFractal(def.fractal);
      let scale: number;
      let baseParams: readonly number[];
      if (def.fractal === 'blackhole') {
        if (!def.blackHole) throw new Error(`[universe] black hole "${def.id}" has no blackHole params`);
        scale = def.blackHole.rs;
        baseParams = def.params ?? [];
      } else {
        if (!fractal) throw new Error(`[universe] fractal "${def.fractal}" for nebula "${def.id}" is not registered`);
        scale = def.worldRadius / fractal.boundRadius;
        baseParams = def.params ?? fractal.defaultParams;
      }
      const params = new Float32Array(16);
      for (let k = 0; k < 16 && k < baseParams.length; k++) params[k] = baseParams[k];

      const rotation = new THREE.Quaternion(def.rotation[0], def.rotation[1], def.rotation[2], def.rotation[3]);
      if (rotation.lengthSq() < 1e-12) rotation.identity();
      rotation.normalize();
      const axis = new THREE.Vector3(def.spinAxis[0], def.spinAxis[1], def.spinAxis[2]);
      if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0);
      axis.normalize();

      this.baseRotation.push(rotation.clone());
      this.spinAxisLocal.push(axis);
      this.baseParams.push(baseParams);
      this.clearanceWorld.push(fractal ? SURFACE_CLEARANCE_LOCAL * scale : 0);

      const rt: NebulaRuntime = {
        def,
        index,
        fractal: def.fractal === 'blackhole' ? null : fractal,
        position: new THREE.Vector3(def.position[0], def.position[1], def.position[2]),
        rotation,
        rotationInv: rotation.clone().invert(),
        scale,
        boundRadiusWorld: def.worldRadius,
        renderRadiusWorld: def.worldRadius * def.haloFactor,
        params,
        distance: Infinity,
        influence: 0,
        surfaceDistance: Infinity,
      };
      this.byId.set(def.id, rt);
      return rt;
    });
    this.frozenClock = new Float64Array(this.runtimes.length).fill(NaN);
  }

  get(id: string): NebulaRuntime | undefined {
    return this.byId.get(id);
  }

  /** Index of a nebula by id, or −1. */
  indexOf(id: string | null): number {
    if (id === null) return -1;
    const rt = this.byId.get(id);
    return rt ? rt.index : -1;
  }

  /** World-space surface clearance (ly) for a nebula; 0 for black holes / unknown ids. */
  clearance(id: string | null): number {
    const i = this.indexOf(id);
    return i >= 0 ? this.clearanceWorld[i] : 0;
  }

  /**
   * Pin nebula `id`'s animation clock at `clock` (s), or release it with null. While pinned its params
   * are exactly `animate(base, clock)` (base = def.params ?? fractal.defaultParams, copied into the
   * 16 floats first; just the copy for fractals without `animate`): the same numbers
   * `frozenParams()` in src/game/firstlight/world.ts computes in Node, so a frozen puzzle arena on the
   * GPU, the flight DE and the beam tracer all agree. The params change immediately (the ship-relative
   * fields follow on the next update / refresh). A released clock resumes from the pinned value, so the
   * breathing continues without a jump. Spin is not affected (it follows the sim clock).
   */
  setFrozenClock(id: string, clock: number | null): void {
    const i = this.indexOf(id);
    if (i < 0) return;
    if (clock === null) {
      this.frozenClock[i] = NaN;
      return;
    }
    const c = Number.isFinite(clock) ? clock : 0;
    this.frozenClock[i] = c;
    if (this.animClock.length === this.runtimes.length) this.animClock[i] = c;
    this.applyFrozenParams(i, c);
  }

  /** Release every pinned clock (mode exit). */
  clearFrozenClocks(): void {
    this.frozenClock.fill(NaN);
  }

  /** Pinned clock of nebula `id`, or null when it animates normally. */
  frozenClockOf(id: string): number | null {
    const i = this.indexOf(id);
    return i >= 0 && Number.isFinite(this.frozenClock[i]) ? this.frozenClock[i] : null;
  }

  /** Animate params & spin for `time`, then refresh ship-relative fields. */
  update(time: number, shipPos: THREE.Vector3): void {
    const n = this.runtimes.length;
    if (this.animClock.length !== n) this.animClock = new Float64Array(n);
    const first = !Number.isFinite(this.lastTime);
    const dt = first ? 0 : Math.min(Math.max(time - this.lastTime, 0), 0.25);
    this.lastTime = time;
    for (let i = 0; i < n; i++) {
      const rt = this.runtimes[i];
      const def = rt.def;
      const animate = rt.fractal?.animate;
      const frozen = this.frozenClock[i];
      if (Number.isFinite(frozen)) {
        // Pinned (setFrozenClock): the clock stays put; params are rewritten from base every update.
        this.animClock[i] = frozen;
        this.applyFrozenParams(i, frozen);
      } else {
        if (first) {
          this.animClock[i] = time;
        } else if (animate && dt > 0) {
          const sdLocal = rt.scale > 0 ? rt.surfaceDistance / rt.scale : Infinity;
          const rate = Number.isFinite(sdLocal) ? Math.min(1, Math.max(ANIM_MIN_RATE, sdLocal / ANIM_SLOW_LOCAL)) : 1;
          const step = dt * rate;
          this.animClock[i] += sdLocal < ANIM_SLOW_LOCAL ? this.guardedAnimStep(i, step, shipPos) : step;
        }
        if (animate) animate(this.baseParams[i], this.animClock[i], rt.params);
      }
      if (def.spinRate !== 0) {
        _q.setFromAxisAngle(this.spinAxisLocal[i], def.spinRate * time);
        rt.rotation.copy(this.baseRotation[i]).multiply(_q);
        rt.rotationInv.copy(rt.rotation).invert();
      }
    }
    this.refresh(shipPos);
  }

  /** params = base (16 floats, zero-padded) then animate(base, clock) — mirrors world.ts frozenParams(). */
  private applyFrozenParams(i: number, clock: number): void {
    const rt = this.runtimes[i];
    const base = this.baseParams[i];
    const params = rt.params;
    for (let k = 0; k < 16; k++) params[k] = k < base.length ? base[k] : 0;
    rt.fractal?.animate?.(base, clock, params);
  }

  /**
   * Clock step for nebula i while the ship is deep in its structure: the full step, unless the
   * breathing would sweep the surface toward the ship by more than half its distance or to within
   * half a clearance (fine detail can move several clearances per frame even at ANIM_MIN_RATE — the
   * Mandelbulb's power animation swallowed a ship resting 1.1 clearances out, and its interior DE
   * gives push-out no way back); then a quarter, a sixteenth, or nothing: the breathing pauses while
   * the ship is pressed against it. Expects rt.params at the current clock; leaves them at some
   * trial clock (the caller re-animates at the accepted one).
   */
  private guardedAnimStep(i: number, step: number, shipPos: THREE.Vector3): number {
    const rt = this.runtimes[i];
    const animate = rt.fractal?.animate;
    if (!animate) return step;
    const dOld = this.nebulaDistance(i, shipPos);
    if (!Number.isFinite(dOld)) return step;
    // Halve the distance at most, never below half a clearance, never deeper once there.
    const minOk = Math.min(dOld, Math.max(0.5 * dOld, 0.5 * this.clearanceWorld[i]));
    const base = this.baseParams[i];
    const clock = this.animClock[i];
    let s = step;
    for (let k = 0; k < 3; k++, s *= 0.25) {
      animate(base, clock + s, rt.params);
      if (this.nebulaDistance(i, shipPos) >= minOk) return s;
    }
    return 0;
  }

  /** Recompute distance / influence / surfaceDistance for a (moved) ship position. */
  refresh(shipPos: THREE.Vector3): void {
    for (let i = 0; i < this.runtimes.length; i++) {
      const rt = this.runtimes[i];
      const d = shipPos.distanceTo(rt.position);
      rt.distance = d;
      const core = rt.boundRadiusWorld * INFLUENCE_CORE;
      const outer = rt.def.influenceRadius;
      rt.influence = outer > core ? 1 - smoothstep(core, outer, d) : d <= core ? 1 : 0;
      rt.surfaceDistance = this.nebulaDistance(i, shipPos);
    }
  }

  /**
   * Conservative world distance estimate (ly) to the nearest fractal surface / bound sphere /
   * black-hole horizon. Returns a shared object that is overwritten on the next call.
   */
  distance(p: THREE.Vector3): DistanceResult {
    const d = this.distanceValue(p);
    this.result.dist = d;
    this.result.id = this.lastIndex >= 0 ? this.runtimes[this.lastIndex].def.id : null;
    return this.result;
  }

  /** Same as distance() but returns only the number (no id lookup). */
  distanceValue(p: THREE.Vector3): number {
    let best = Infinity;
    let bestIndex = -1;
    for (let i = 0; i < this.runtimes.length; i++) {
      const d = this.nebulaDistance(i, p);
      if (d < best) {
        best = d;
        bestIndex = i;
      }
    }
    this.lastIndex = bestIndex;
    return best;
  }

  /**
   * Unit outward gradient of the world DE (tetrahedral differences, step `eps` ly).
   * Writes (0,0,0) if the gradient is degenerate.
   */
  gradient(p: THREE.Vector3, eps: number, out: THREE.Vector3): THREE.Vector3 {
    const e = Math.max(eps, 1e-12);
    const x = p.x;
    const y = p.y;
    const z = p.z;
    const a = this.distanceValue(_p.set(x + e, y - e, z - e));
    const b = this.distanceValue(_p.set(x - e, y - e, z + e));
    const c = this.distanceValue(_p.set(x - e, y + e, z - e));
    const d = this.distanceValue(_p.set(x + e, y + e, z + e));
    out.set(a - b - c + d, -a - b + c + d, -a + b - c + d);
    const len = out.length();
    if (!(len > 1e-300) || !Number.isFinite(len)) return out.set(0, 0, 0);
    return out.multiplyScalar(1 / len);
  }

  /**
   * Nebula under the reticle: the one whose disc (angular radius atan(renderRadius/dist))
   * contains `dir`, preferring the closest; otherwise the angularly nearest within ≈2° of its
   * disc. A nebula whose halo encloses the ship is under the reticle when the reticle ray runs
   * into its structure (or its heart / black-hole disk); looking out through a gap lets you pick
   * the nebulae beyond, and the enclosing one only wins as a last resort.
   */
  pick(origin: THREE.Vector3, dir: THREE.Vector3): string | null {
    const dl = dir.length();
    if (!(dl > 1e-12)) return null;
    _dirN.copy(dir).multiplyScalar(1 / dl);
    let hitId: string | null = null;
    let hitDist = Infinity;
    let nearId: string | null = null;
    let nearExcess = Infinity;
    let insideId: string | null = null;
    let insideDist = Infinity;
    for (let i = 0; i < this.runtimes.length; i++) {
      const rt = this.runtimes[i];
      _rel.subVectors(rt.position, origin);
      const dist = _rel.length();
      const rr = rt.renderRadiusWorld;
      if (dist <= rr) {
        const t = this.insideHit(i, origin, _dirN, _rel.dot(_dirN), dist);
        if (t >= 0) {
          if (t < hitDist) {
            hitDist = t;
            hitId = rt.def.id;
          }
        } else if (dist < insideDist) {
          insideDist = dist;
          insideId = rt.def.id;
        }
        continue;
      }
      const cosA = _rel.dot(_dirN) / dist;
      const angle = Math.acos(Math.max(-1, Math.min(1, cosA)));
      const angRadius = Math.atan(rr / dist);
      if (angle <= angRadius) {
        if (dist < hitDist) {
          hitDist = dist;
          hitId = rt.def.id;
        }
      } else {
        const excess = angle - angRadius;
        if (excess <= PICK_TOLERANCE && excess < nearExcess) {
          nearExcess = excess;
          nearId = rt.def.id;
        }
      }
    }
    return hitId ?? nearId ?? insideId;
  }

  /**
   * The ship is inside nebula i's halo: distance along the (unit) reticle ray at which the
   * nebula's core is hit, or −1 if the ray looks past it. `tca` = (centre − origin)·dir.
   */
  private insideHit(i: number, origin: THREE.Vector3, dir: THREE.Vector3, tca: number, dist: number): number {
    const rt = this.runtimes[i];
    const perp2 = Math.max(dist * dist - tca * tca, 0);
    if (!rt.fractal) {
      // Black hole: looking toward the shadow / accretion disk.
      const core = rt.scale * Math.max(rt.def.blackHole?.diskOuter ?? 0, 3);
      if (tca <= 0 || perp2 > core * core) return -1;
      return Math.max(tca - Math.sqrt(core * core - perp2), 0);
    }
    const B = rt.boundRadiusWorld;
    if (perp2 >= B * B) return -1;
    const half = Math.sqrt(B * B - perp2);
    const tExit = tca + half;
    if (tExit <= 0) return -1;
    const tEnter = Math.max(tca - half, 0);
    let t = tEnter;
    const clr = this.clearanceWorld[i];
    let hitD = 2 * clr;
    for (let k = 0; k < PICK_MARCH_STEPS && t < tExit; k++) {
      const d = this.nebulaDistance(i, _ray.copy(origin).addScaledVector(dir, t));
      // Starting right against a wall (t = 0): only a ray that closes in further counts as a hit.
      if (k === 0 && t === 0) hitD = Math.min(hitD, 0.5 * d);
      else if (d < Math.max(PICK_HIT_CONE * t, hitD)) return t;
      t += Math.max(0.9 * d, 0.5 * PICK_HIT_CONE * t, clr);
    }
    // No structure met (sparse fractal / grazing ray): still "in" it when looking into its heart
    // from outside the fractal's bound sphere.
    const cr = PICK_CORE_FRACTION * B;
    return dist > B && tca > 0 && perp2 < cr * cr ? tEnter : -1;
  }

  /**
   * Ghost x-ray probe: distance (ly) along the unit `dir` from p to where the ray comes out of the
   * solid structure of nebula `id` into open space (first into the solid ahead, if p is outside).
   * "Open" means clear by EXIT_OPEN_FRACTION × the distance travelled, so the pits and bumps of a
   * rough surface don't count as a way out (the result overshoots a clean exit by up to ~25 %).
   * 0 if no solid is met within `maxDist`; Infinity if the ray is still inside at `maxDist`. Steps
   * are at least `minStep` and EXIT_PROBE_GROWTH × the distance travelled.
   */
  exitDistance(id: string | null, p: THREE.Vector3, dir: THREE.Vector3, maxDist: number, minStep: number): number {
    const i = this.indexOf(id);
    if (i < 0 || !this.runtimes[i].fractal || !(maxDist > 0)) return 0;
    const floor = Math.max(minStep, maxDist * 1e-4);
    let t = 0;
    let inside = false;
    for (let k = 0; k < EXIT_PROBE_STEPS && t <= maxDist; k++) {
      const d = this.nebulaDistance(i, _ray.copy(p).addScaledVector(dir, t));
      const step = Math.max(Math.abs(d), floor, EXIT_PROBE_GROWTH * t);
      if (!inside) {
        if (d <= 0) inside = true;
        else {
          t += step;
          continue;
        }
      }
      if (d > Math.max(floor, EXIT_OPEN_FRACTION * t)) return t;
      t += step;
    }
    return inside ? Infinity : 0;
  }

  /** Distance estimate (ly) from p to nebula i (see DE_SHELL_INNER / DE_SHELL_OUTER). */
  private nebulaDistance(i: number, p: THREE.Vector3): number {
    const rt = this.runtimes[i];
    const dx = p.x - rt.position.x;
    const dy = p.y - rt.position.y;
    const dz = p.z - rt.position.z;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const fractal = rt.fractal;
    if (!fractal) {
      const rs = rt.scale;
      return Math.max(r - rs, BLACK_HOLE_DE_FLOOR * rs);
    }
    const bound = rt.boundRadiusWorld;
    const dBound = r - bound;
    const outer = bound * DE_SHELL_OUTER;
    if (r >= outer) return dBound;
    _c.set(dx, dy, dz).applyQuaternion(rt.rotationInv);
    const inv = 1 / rt.scale;
    let d = fractal.de(_c.x * inv, _c.y * inv, _c.z * inv, rt.params, fractal.cpuIter) * rt.scale;
    // A broken DE must never trap the ship: treat it as slow free space.
    if (!Number.isFinite(d)) return Math.max(dBound, this.clearanceWorld[i] * 4);
    if (r <= bound) return d;
    const inner = bound * DE_SHELL_INNER;
    if (r > inner) d += (dBound - d) * smoothstep(inner, outer, r);
    return d > dBound ? d : dBound;
  }
}
