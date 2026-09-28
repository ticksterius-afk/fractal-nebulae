/**
 * Gravity-Glide autopilot and Voyage (zen tour). Pure guidance: produces a desired look
 * direction, up hint, velocity and boost; the Simulation applies them through the same
 * inertial / collision-safe flight model the pilot uses.
 */
import * as THREE from 'three';
import type { NebulaRuntime } from '../core/types';
import { TUNING } from '../app/config';
import { damp, smoothstep } from '../core/math';

export type PilotMode = 'off' | 'target' | 'voyage';

export const PILOT = {
  /** Target autopilot arrival radius × renderRadiusWorld. */
  targetArriveFactor: 2.5,
  /** Voyage orbit radius × renderRadiusWorld (fractal nebulae). */
  voyageArriveFactor: 2.0,
  /** Voyage orbit radius × worldRadius for black holes (well clear of the horizon). */
  voyageBlackHoleFactor: 4.0,
  /**
   * Arrival / orbit radii are also clamped to these fractions of the nebula's influenceRadius so
   * that arriving actually enters the region (music, codex, "Entering…" banner).
   */
  targetInfluenceCap: 0.72,
  voyageInfluenceCap: 0.62,
  /** |distance − arriveR| below this × arriveR counts as arrived. */
  arriveTolerance: 0.04,
  /** Exponential approach rate (1/s) toward the arrival shell. */
  arriveRate: 0.7,
  /** Ease-in time (s) of the glide once the ship faces its heading. */
  travelRampSeconds: 2.2,
  /** Minimum approach speed (× arriveR per second) so arrival actually happens. */
  arriveMinSpeed: 0.02,
  /** Max cruise multiplier of the long-distance glide boost. */
  boostMultiplier: 10,
  boostTau: 1.2,
  /** Orientation spring natural frequencies (rad/s). */
  travelStiffness: 1.8,
  voyageTravelStiffness: 1.1,
  orbitStiffness: 1.1,
  /** Turn-rate caps (rad/s): brisk for a requested glide, languid for the zen voyage. */
  travelMaxSpin: 1.2,
  voyageMaxSpin: 0.55,
  /** Momentum carried into a new leg while the nose swings around (decay time constant, s). */
  carryTau: 3.0,
  /** Orbit angular speeds (rad/s). */
  orbitRateTarget: 0.045,
  orbitRateVoyage: 0.055,
  voyageOrbitSeconds: 40,
  /** Voyage soft auto-level time constant (s). */
  levelTau: 4,
  /** Obstacle safety radius × boundRadiusWorld (fractals). */
  obstacleFactor: 1.35,
  /**
   * Navigating out of fractal structure (the ship is inside a fractal's bound sphere and its
   * heading is blocked): probe length × remembered local scale, re-check interval (s), probes
   * evaluated per frame while scanning, and the decay (s) of the local-scale memory (so being
   * pressed against a wall does not shrink the probes to nothing).
   */
  navProbeFactor: 10,
  /** Cruise multiplier while threading structure (DE-adaptive cruise alone crawls through
   *  tunnels; the collision limiter keeps this safe). */
  navSpeedMultiplier: 4,
  navInterval: 0.35,
  navProbesPerFrame: 7,
  navScaleTau: 4,
};

/** 26 lattice directions (axes, face and body diagonals) scanned in the fractal's local frame. */
const LATTICE: THREE.Vector3[] = [];
for (let x = -1; x <= 1; x++) {
  for (let y = -1; y <= 1; y++) {
    for (let z = -1; z <= 1; z++) if (x || y || z) LATTICE.push(new THREE.Vector3(x, y, z).normalize());
  }
}

export interface PilotContext {
  dt: number;
  time: number;
  pos: THREE.Vector3;
  velocity: THREE.Vector3;
  forward: THREE.Vector3;
  up: THREE.Vector3;
  right: THREE.Vector3;
  /** World distance to the nearest surface (ly). */
  surfaceDistance: number;
  throttle: number;
  /** Collision probe: free distance (ly, ≤ maxDist) from `pos` along unit `dir` before structure. */
  probe: (dir: THREE.Vector3, maxDist: number) => number;
}

export interface PilotCommand {
  readonly lookDir: THREE.Vector3;
  readonly upHint: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  /** 0..1 smoothed glide boost (drives speed cap and relativistic visuals). */
  boost: number;
  /** 0..1 engine thrust for audio / FX. */
  thrust: number;
  /** Orientation spring natural frequency (rad/s). */
  stiffness: number;
  /** Maximum turn rate (rad/s). */
  maxSpin: number;
  /** Speed multiplier the collision limiter may allow (≥ 1). */
  speedMultiplier: number;
  /** True on the frame a 'target' autopilot reaches its arrival shell. */
  arrivedNow: boolean;
  /** Voyage: index of the nebula a new leg heads to this frame, else −1. */
  legStarted: number;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const TWO_PI = Math.PI * 2;

const _toC = new THREE.Vector3();
const _dirC = new THREE.Vector3();
const _move = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _radH = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _cand = new THREE.Vector3();
const _end = new THREE.Vector3();

export class Autopilot {
  mode: PilotMode = 'off';
  targetIndex = -1;
  phase: 'travel' | 'orbit' = 'travel';

  readonly cmd: PilotCommand = {
    lookDir: new THREE.Vector3(0, 0, -1),
    upHint: new THREE.Vector3(0, 1, 0),
    velocity: new THREE.Vector3(),
    boost: 0,
    thrust: 0,
    stiffness: PILOT.travelStiffness,
    maxSpin: PILOT.travelMaxSpin,
    speedMultiplier: 1,
    arrivedNow: false,
    legStarted: -1,
  };

  private orbitTime = 0;
  private travelRamp = 0;
  private readonly orbitAxis = new THREE.Vector3(0, 1, 0);
  private orbitSign = 1;
  private orbitHeight = 0;
  /** Speed carried from before a leg began (decays while the ship turns onto its heading). */
  private carry = 0;
  private carryArmed = false;
  // Structure navigation (see PILOT.nav*).
  private navActive = false;
  /** Speed multiplier granted by the current travel mode (> 1 while threading structure). */
  private navSpeed = 1;
  private navScan = -1;
  private navTimer = 0;
  private navScale = 0;
  private navBest = -Infinity;
  private navFractal = -1;
  private readonly navDir = new THREE.Vector3();
  private readonly navBestDir = new THREE.Vector3();
  private readonly visited: Uint8Array;

  constructor(private readonly runtimes: NebulaRuntime[]) {
    this.visited = new Uint8Array(runtimes.length);
  }

  get active(): boolean {
    return this.mode !== 'off';
  }

  /** Glide to nebula `index`. Returns false if that glide is already under way (no restart). */
  startTarget(index: number): boolean {
    if (index < 0 || index >= this.runtimes.length) return false;
    if (this.mode === 'target' && this.targetIndex === index) return false;
    this.mode = 'target';
    this.targetIndex = index;
    this.phase = 'travel';
    this.beginLeg();
    return true;
  }

  /** Begin the tour from `pos`; returns the first destination index (−1 if none). */
  startVoyage(pos: THREE.Vector3): number {
    this.visited.fill(0);
    const first = this.nextStop(pos, -1);
    if (first < 0) return -1;
    this.mode = 'voyage';
    this.targetIndex = first;
    this.phase = 'travel';
    this.beginLeg();
    return first;
  }

  stop(): void {
    this.mode = 'off';
    this.targetIndex = -1;
    this.phase = 'travel';
  }

  /** Decay the boost while the pilot is off (keeps visuals continuous). */
  idle(dt: number): void {
    this.cmd.boost += (0 - this.cmd.boost) * damp(dt, 0.8);
  }

  arriveRadius(rt: NebulaRuntime): number {
    const influence = rt.def.influenceRadius;
    if (this.mode === 'voyage') {
      const r = rt.fractal ? rt.renderRadiusWorld * PILOT.voyageArriveFactor : rt.def.worldRadius * PILOT.voyageBlackHoleFactor;
      return Math.max(Math.min(r, influence * PILOT.voyageInfluenceCap), rt.boundRadiusWorld * 1.3);
    }
    const r = rt.renderRadiusWorld * PILOT.targetArriveFactor;
    return Math.max(Math.min(r, influence * PILOT.targetInfluenceCap), rt.boundRadiusWorld * 1.3);
  }

  update(ctx: PilotContext): PilotCommand {
    const cmd = this.cmd;
    cmd.arrivedNow = false;
    cmd.legStarted = -1;
    const T = this.runtimes[this.targetIndex];
    if (this.mode === 'off' || !T) {
      cmd.velocity.set(0, 0, 0);
      cmd.lookDir.copy(ctx.forward);
      cmd.upHint.copy(ctx.up);
      cmd.thrust = 0;
      cmd.speedMultiplier = 1;
      this.idle(ctx.dt);
      return cmd;
    }

    const arriveR = this.arriveRadius(T);
    _toC.subVectors(T.position, ctx.pos);
    const dist = _toC.length();
    if (dist > 1e-9) _dirC.copy(_toC).multiplyScalar(1 / dist);
    else _dirC.copy(ctx.forward);

    let boostTarget = 0;
    this.navSpeed = 1;
    if (this.phase === 'travel') {
      const s = dist - arriveR;
      if (Math.abs(s) <= PILOT.arriveTolerance * arriveR) {
        this.enterOrbit(ctx, T);
        if (this.mode === 'target') cmd.arrivedNow = true;
      } else {
        boostTarget = this.travel(ctx, T, dist, arriveR, s);
      }
    }
    if (this.phase === 'orbit') this.orbit(ctx, T, arriveR);

    // Up hint: voyage softly levels to the galactic "up"; target mode keeps the pilot's roll.
    if (this.mode === 'voyage') {
      const a = damp(ctx.dt, PILOT.levelTau);
      cmd.upHint.copy(ctx.up).addScaledVector(_tmp.subVectors(WORLD_UP, ctx.up), a);
      if (ctx.up.dot(WORLD_UP) < -0.95) cmd.upHint.addScaledVector(ctx.right, 0.02); // escape inverted equilibrium
      cmd.upHint.normalize();
    } else {
      cmd.upHint.copy(ctx.up);
    }

    cmd.boost += (boostTarget - cmd.boost) * damp(ctx.dt, PILOT.boostTau);
    cmd.speedMultiplier = Math.max(1 + (PILOT.boostMultiplier - 1) * cmd.boost, this.navSpeed);

    if (this.mode === 'voyage' && this.phase === 'orbit') {
      this.orbitTime += ctx.dt;
      if (this.orbitTime >= PILOT.voyageOrbitSeconds) {
        const next = this.nextStop(ctx.pos, this.targetIndex);
        if (next >= 0 && next !== this.targetIndex) {
          this.targetIndex = next;
          this.phase = 'travel';
          this.beginLeg();
          cmd.legStarted = next;
        } else {
          this.orbitTime = 0;
        }
      }
    }
    return cmd;
  }

  // ---------------------------------------------------------------------------

  /** Travel toward the arrival shell; returns the desired boost. */
  private travel(ctx: PilotContext, T: NebulaRuntime, dist: number, arriveR: number, s: number): number {
    const cmd = this.cmd;
    const cruiseBase = TUNING.cruiseFactor * ctx.throttle * Math.max(ctx.surfaceDistance, 1e-9);
    const voyage = this.mode === 'voyage';
    cmd.stiffness = voyage ? PILOT.voyageTravelStiffness : PILOT.travelStiffness;
    cmd.maxSpin = voyage ? PILOT.voyageMaxSpin : PILOT.travelMaxSpin;
    const vLen = ctx.velocity.length();
    if (this.carryArmed) {
      this.carry = Number.isFinite(vLen) ? vLen : 0;
      this.navScale = Math.max(ctx.surfaceDistance, 0);
      this.carryArmed = false;
    } else {
      this.carry *= Math.exp(-ctx.dt / PILOT.carryTau);
    }
    const outward = s <= 0;
    if (outward) _move.copy(_dirC).negate();
    else this.avoid(ctx.pos, dist, _move);
    const detour = this.navigate(ctx, _move);

    if (outward && !detour) {
      // Inside the arrival shell (e.g. autopilot engaged deep inside the nebula) with a clear way
      // out: pull back outward while looking at it — a cinematic reveal.
      cmd.lookDir.copy(_dirC);
      const want = PILOT.arriveRate * -s + PILOT.arriveMinSpeed * arriveR;
      const speed = Math.min(want, cruiseBase);
      cmd.velocity.copy(_dirC).multiplyScalar(-speed);
      cmd.thrust = Math.min(1, speed / Math.max(cruiseBase, 1e-12));
      return 0;
    }

    // Nose-first flight along _move: toward the destination, or out through the structure.
    const faceBlend = detour ? 0 : smoothstep(arriveR * 4, arriveR * 1.5, dist);
    cmd.lookDir.copy(_move).lerp(_dirC, faceBlend);
    if (cmd.lookDir.lengthSq() < 1e-12) cmd.lookDir.copy(_move);
    cmd.lookDir.normalize();
    const align = smoothstep(0.55, 0.95, ctx.forward.dot(cmd.lookDir));
    if (align > 0.5) this.travelRamp = Math.min(1, this.travelRamp + ctx.dt / PILOT.travelRampSeconds);
    const ease = smoothstep(0, 1, this.travelRamp);
    const want = PILOT.arriveRate * Math.abs(s) + PILOT.arriveMinSpeed * arriveR;
    this.navSpeed = detour ? PILOT.navSpeedMultiplier : 1;
    const cap = detour ? cruiseBase * this.navSpeed : cruiseBase * (1 + (PILOT.boostMultiplier - 1) * cmd.boost);
    // Momentum from before the leg keeps the ship gliding (along its current motion) while the
    // nose swings around; the path then bends onto the heading as alignment grows. Only momentum
    // that is not heading away from the destination is worth keeping.
    const heading = vLen > 1e-12 ? ctx.velocity.dot(_move) / vLen : 0;
    const carried = Math.min(this.carry, want, cruiseBase) * Math.min(Math.max(0.5 + 0.5 * heading, 0), 1);
    const speed = Math.max(Math.min(want, cap) * align * (0.08 + 0.92 * ease), carried);
    if (vLen > 1e-12 && align < 1) {
      _tmp.copy(ctx.velocity).multiplyScalar(1 / vLen).lerp(_move, align);
      if (_tmp.lengthSq() < 1e-12) _tmp.copy(_move);
      cmd.velocity.copy(_tmp.normalize()).multiplyScalar(speed);
    } else {
      cmd.velocity.copy(_move).multiplyScalar(speed);
    }
    cmd.thrust = Math.min(1, speed / Math.max(cruiseBase, 1e-12));
    return outward || detour ? 0 : smoothstep(arriveR * 0.8, arriveR * 6, s) * align * ease;
  }

  /** Reset per-leg state (ramp, carried momentum, structure navigation). */
  private beginLeg(): void {
    this.orbitTime = 0;
    this.travelRamp = 0;
    this.carryArmed = true;
    this.navActive = false;
    this.navScan = -1;
    this.navTimer = 0;
    this.navFractal = -1;
  }

  /** The fractal nebula whose bound sphere contains `pos` most deeply, or null. */
  private enclosingFractal(pos: THREE.Vector3): NebulaRuntime | null {
    let best: NebulaRuntime | null = null;
    let bestRatio = 1;
    for (const rt of this.runtimes) {
      if (!rt.fractal) continue;
      const ratio = rt.position.distanceTo(pos) / rt.boundRadiusWorld;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = rt;
      }
    }
    return best;
  }

  /**
   * Inside fractal structure, keep the heading `dir` (unit, in/out) if the way ahead is open;
   * otherwise scan the 26 lattice directions of the fractal's frame with collision probes
   * (amortized over a few frames) and pick the passage that gains the most ground outward.
   * Once a detour has begun it stays in charge (nose-first) until the ship leaves the fractal,
   * so it never flip-flops between facing in and out. Returns true while detouring.
   */
  private navigate(ctx: PilotContext, dir: THREE.Vector3): boolean {
    const A = this.enclosingFractal(ctx.pos);
    if (!A) {
      this.navActive = false;
      this.navScan = -1;
      this.navFractal = -1;
      return false;
    }
    if (A.index !== this.navFractal) {
      this.navFractal = A.index;
      this.navActive = false;
      this.navScan = -1;
      this.navTimer = 0;
    }
    this.navScale = Math.max(ctx.surfaceDistance, this.navScale * Math.exp(-ctx.dt / PILOT.navScaleTau));
    const L = Math.min(PILOT.navProbeFactor * this.navScale, 0.6 * A.boundRadiusWorld);
    if (!(L > 0)) return this.navActive;

    if (this.navScan < 0) {
      this.navTimer -= ctx.dt;
      if (this.navTimer <= 0) {
        this.navTimer = PILOT.navInterval;
        if (ctx.probe(dir, L) >= 0.9 * L) {
          if (this.navActive) this.navDir.copy(dir); // way ahead is open again: resume the heading
        } else {
          this.navScan = 0;
          this.navBest = -Infinity;
        }
      }
    }
    if (this.navScan >= 0) {
      const count = LATTICE.length + (this.navActive ? 1 : 0);
      const rA = ctx.pos.distanceTo(A.position);
      for (let k = 0; k < PILOT.navProbesPerFrame && this.navScan < count; k++, this.navScan++) {
        if (this.navScan < LATTICE.length) _cand.copy(LATTICE[this.navScan]).applyQuaternion(A.rotation);
        else _cand.copy(this.navDir);
        const reach = ctx.probe(_cand, L);
        _end.copy(ctx.pos).addScaledVector(_cand, reach);
        let score = (_end.distanceTo(A.position) - rA) / L + 0.35 * (reach / L) + 0.25 * _cand.dot(dir);
        if (this.navActive) score += 0.2 * _cand.dot(this.navDir);
        if (score > this.navBest) {
          this.navBest = score;
          this.navBestDir.copy(_cand);
        }
      }
      if (this.navScan >= count) {
        this.navScan = -1;
        this.navDir.copy(this.navBestDir);
        this.navActive = true;
      }
    }
    if (!this.navActive) return false;
    dir.copy(this.navDir);
    return true;
  }

  /** Direction toward the target that steers around the nearest nebula in the way. */
  private avoid(pos: THREE.Vector3, dist: number, out: THREE.Vector3): THREE.Vector3 {
    out.copy(_dirC);
    const T = this.runtimes[this.targetIndex];
    let best: NebulaRuntime | null = null;
    let bestT = Infinity;
    let bestSafe = 0;
    for (const O of this.runtimes) {
      if (O === T) continue;
      const safeR = O.fractal
        ? O.boundRadiusWorld * PILOT.obstacleFactor
        : Math.max(8 * O.scale, 0.6 * O.def.worldRadius);
      if (O.position.distanceTo(T.position) < safeR) continue; // overlapping: can't avoid, don't fight arrival
      _rel.subVectors(O.position, pos);
      const tca = _rel.dot(_dirC);
      if (tca <= 0 || tca >= dist) continue;
      const perpSq = _rel.lengthSq() - tca * tca;
      const lim = 1.6 * safeR;
      if (perpSq >= lim * lim) continue;
      if (tca < bestT) {
        bestT = tca;
        best = O;
        bestSafe = safeR;
      }
    }
    if (!best) return out;
    _rel.subVectors(best.position, pos);
    const perp = _tmp.copy(_rel).addScaledVector(_dirC, -bestT); // ray closest point → obstacle centre
    const dp = perp.length();
    if (dp > 1e-6 * bestSafe) perp.multiplyScalar(-1 / dp);
    else {
      perp.crossVectors(_dirC, WORLD_UP);
      if (perp.lengthSq() < 1e-10) perp.set(1, 0, 0);
      perp.normalize();
    }
    const waypoint = _tmp2.copy(best.position).addScaledVector(perp, bestSafe * 1.9);
    const dirW = waypoint.sub(pos).normalize();
    const w = 1 - smoothstep(bestSafe * 1.2, bestSafe * 1.6, dp);
    out.multiplyScalar(1 - w).addScaledVector(dirW, w);
    if (out.lengthSq() < 1e-12) out.copy(dirW);
    return out.normalize();
  }

  private enterOrbit(ctx: PilotContext, T: NebulaRuntime): void {
    this.phase = 'orbit';
    this.orbitTime = 0;
    if (this.mode === 'voyage') this.visited[this.targetIndex] = 1;
    const radial = _tmp.subVectors(ctx.pos, T.position);
    if (radial.lengthSq() < 1e-18) radial.copy(ctx.forward).negate();
    radial.normalize();
    if (this.mode === 'voyage') {
      this.orbitAxis.copy(WORLD_UP);
    } else {
      // Orbit around the pilot's own "up" so the motion starts as a sideways dolly.
      this.orbitAxis.copy(ctx.up).addScaledVector(radial, -ctx.up.dot(radial));
      if (this.orbitAxis.lengthSq() < 1e-8) this.orbitAxis.crossVectors(radial, ctx.right);
      if (this.orbitAxis.lengthSq() < 1e-8) this.orbitAxis.copy(WORLD_UP);
      this.orbitAxis.normalize();
    }
    this.orbitHeight = _rel.subVectors(ctx.pos, T.position).dot(this.orbitAxis);
    _tan.crossVectors(this.orbitAxis, radial);
    this.orbitSign = _tan.dot(ctx.velocity) < 0 ? -1 : 1;
  }

  private orbit(ctx: PilotContext, T: NebulaRuntime, arriveR: number): void {
    const cmd = this.cmd;
    const voyage = this.mode === 'voyage';
    const t = this.orbitTime;
    const axis = this.orbitAxis;

    _rel.subVectors(ctx.pos, T.position);
    const h = _rel.dot(axis);
    _radH.copy(_rel).addScaledVector(axis, -h);
    let rh = _radH.length();
    if (rh > 1e-9) _radH.multiplyScalar(1 / rh);
    else {
      _radH.crossVectors(axis, ctx.right);
      if (_radH.lengthSq() < 1e-10) _radH.set(1, 0, 0);
      _radH.normalize();
      rh = 0;
    }
    _tan.crossVectors(axis, _radH).multiplyScalar(this.orbitSign);

    const R = arriveR * (voyage ? 1 + 0.1 * Math.sin((TWO_PI * t) / 47) : 1);
    let hTarget: number;
    if (voyage) {
      // Slow crane move toward a gentle elevation above the equator.
      hTarget = R * (0.2 + 0.1 * Math.sin((TWO_PI * t) / 71 + 0.5));
    } else {
      hTarget = this.orbitHeight;
    }
    hTarget = Math.max(-0.8 * R, Math.min(0.8 * R, hTarget));
    const rhTarget = Math.sqrt(Math.max(R * R - hTarget * hTarget, 0.04 * R * R));
    const omega = voyage ? PILOT.orbitRateVoyage : PILOT.orbitRateTarget;

    cmd.velocity
      .copy(_tan)
      .multiplyScalar(omega * R)
      .addScaledVector(_radH, (rhTarget - rh) * 0.3)
      .addScaledVector(axis, (hTarget - h) * (voyage ? 0.08 : 0.3));

    // Look at the nebula with a slow wandering gaze.
    const a = (voyage ? 0.22 : 0.08) * T.boundRadiusWorld;
    const time = ctx.time;
    _tmp
      .copy(T.position)
      .add(
        _tmp2.set(
          a * Math.sin((TWO_PI * time) / 23),
          a * 0.6 * Math.sin((TWO_PI * time) / 31 + 1.3),
          a * Math.sin((TWO_PI * time) / 37 + 2.1),
        ),
      )
      .sub(ctx.pos);
    if (_tmp.lengthSq() > 1e-18) cmd.lookDir.copy(_tmp).normalize();
    else cmd.lookDir.copy(ctx.forward);
    cmd.stiffness = PILOT.orbitStiffness;
    cmd.maxSpin = voyage ? PILOT.voyageMaxSpin : PILOT.travelMaxSpin;
    cmd.thrust = 0.12;
  }

  /** Nearest unvisited nebula (by centre distance) other than `current`; resets the tour when done. */
  private nextStop(pos: THREE.Vector3, current: number): number {
    for (let pass = 0; pass < 2; pass++) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < this.runtimes.length; i++) {
        if (i === current || this.visited[i]) continue;
        const d = pos.distanceToSquared(this.runtimes[i].position);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0) return best;
      this.visited.fill(0);
      if (current >= 0) this.visited[current] = 1;
    }
    return current;
  }
}
