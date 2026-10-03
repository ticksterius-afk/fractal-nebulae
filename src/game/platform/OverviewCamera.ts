/**
 * Overview ("lab view") orbit camera (design/10-platform.md §3.2, design/60-first-light-build.md §G).
 *
 * Pure maths on three.js vectors: no DOM, no renderer. The mode feeds it pointer deltas and wheel
 * notches, calls `update(dt)` every frame and puppets the ship to `pose()` (a puppeted ship IS the
 * camera). Conventions match the ship: the camera looks down its local −Z with local +Y up, and
 * `rayThrough` matches the renderer's PerspectiveCamera (vertical FOV, aspect = width / height).
 *
 * Homeworld's rule: the "up" vector is LOCKED (the arena's up), so the horizon never rolls. The camera
 * sits on a sphere around the focus:
 *   dir = cos(pitch)·(cos(yaw)·A + sin(yaw)·B) + sin(pitch)·U,   position = focus + distance · dir
 * with U = up and A, B a fixed basis of the horizontal plane (yaw 0 = the +Z side for U = +Y, like the
 * ship's start pose). Pitch is clamped to ±80°, distance to [0.3, 3] × radius; the wheel dollies in log
 * space. Every channel follows its target through two cascaded exponential stages (the S-curve the
 * flight look uses), integrated exactly per step, so the motion is identical at any frame rate.
 *
 * Frame-agnostic: run it in world space, or in a nebula's LOCAL space and transform `pose()` by the
 * nebula's position/rotation/scale when the arena co-rotates with a spinning nebula.
 * Allocation-free after construction.
 */
import * as THREE from 'three';
import { clamp } from '../../core/math';
import { lookRotation } from '../../sim/quat';

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/** Feel tuning (angles in degrees, time constants in seconds). */
export const OVERVIEW = {
  /** Distance limits and the default framing distance, × arena radius. */
  minFactor: 0.3,
  maxFactor: 3,
  frameFactor: 2.2,
  /** Pitch limit (±). */
  pitchLimitDeg: 80,
  /** Default elevation of a fresh framing ("slightly above"), and the range a `fromDir` is clamped to. */
  framePitchDeg: 22,
  framePitchMinDeg: 8,
  framePitchMaxDeg: 50,
  /** Orbit drag: radians per CSS pixel (a 600 px drag ≈ 170°). */
  radPerPx: 0.005,
  /** Distance factor per wheel notch (the same ×1.15 the placement depth uses). */
  dollyPerNotch: 1.15,
  /** The focus may be panned at most this far from the framed centre (× radius). */
  panLimit: 1,
  /** Two-stage smoothing time constants (flight look: 0.04 / 0.055). */
  orbitTau1: 0.045,
  orbitTau2: 0.06,
  dollyTau1: 0.08,
  dollyTau2: 0.1,
  focusTau1: 0.1,
  focusTau2: 0.14,
};

/**
 * Two cascaded first-order lags toward a target, solved in closed form for a target held constant
 * over the step: exactly frame-rate independent, and (non-negative impulse response) it never
 * overshoots, so a clamped target keeps the value inside the clamp.
 */
class Smooth2 {
  mid = 0;
  value = 0;
  snap(v: number): void {
    this.mid = v;
    this.value = v;
  }
  shift(d: number): void {
    this.mid += d;
    this.value += d;
  }
  step(target: number, dt: number, tau1: number, tau2: number): void {
    if (!(dt > 0)) return;
    const t1 = Math.max(1e-6, tau1);
    const t2 = Math.max(1e-6, tau2);
    const e1 = this.mid - target;
    const e2 = this.value - target;
    const E1 = Math.exp(-dt / t1);
    const E2 = Math.exp(-dt / t2);
    // e2(t) = e2·E2 + e1·τ1/(τ1−τ2)·(E1 − E2); the limit τ1 → τ2 is e1·(t/τ)·E.
    const c = Math.abs(t1 - t2) > 1e-6 ? (t1 / (t1 - t2)) * (E1 - E2) : (dt / t2) * E2;
    this.mid = target + e1 * E1;
    this.value = target + e2 * E2 + e1 * c;
  }
}

/** World size of one CSS pixel at view depth `depth` (vertical FOV, viewport height in CSS px). */
export function pixelSize(depth: number, viewportH: number, fovDeg: number): number {
  const h = viewportH > 0 ? viewportH : 1;
  const fov = Number.isFinite(fovDeg) ? clamp(fovDeg, 1, 179) : 70;
  return (2 * Math.max(depth, 0) * Math.tan(fov * 0.5 * DEG)) / h;
}

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

const finite3 = (v: THREE.Vector3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
/** Wrap an angle to (−π, π]. */
const wrapPi = (a: number) => a - TWO_PI * Math.round(a / TWO_PI);

export class OverviewCamera {
  /** Locked up vector U (unit). */
  readonly up = new THREE.Vector3(0, 1, 0);
  /** Smoothed focus (what the camera looks at). */
  readonly focus = new THREE.Vector3();
  /** Current camera pose (valid after the first `frame`). */
  readonly position = new THREE.Vector3(0, 0, 1);
  readonly quaternion = new THREE.Quaternion();
  /** Current camera axes (unit, world): forward = local −Z, right = local +X, screenUp = local +Y. */
  readonly forward = new THREE.Vector3(0, 0, -1);
  readonly right = new THREE.Vector3(1, 0, 0);
  readonly screenUp = new THREE.Vector3(0, 1, 0);

  private readonly tuning: typeof OVERVIEW;
  private readonly basisA = new THREE.Vector3(0, 0, 1);
  private readonly basisB = new THREE.Vector3(1, 0, 0);
  /** Framed centre (the arena) and the pan offset from it: target focus = center + panOffset. */
  private readonly center = new THREE.Vector3();
  private readonly panOffset = new THREE.Vector3();
  private _radius = 1;
  private _framed = false;
  private yawT = 0;
  private pitchT = OVERVIEW.framePitchDeg * DEG;
  private distT = OVERVIEW.frameFactor;
  private readonly sYaw = new Smooth2();
  private readonly sPitch = new Smooth2();
  private readonly sLogD = new Smooth2();
  private readonly sFx = new Smooth2();
  private readonly sFy = new Smooth2();
  private readonly sFz = new Smooth2();

  constructor(tuning: Partial<typeof OVERVIEW> = {}) {
    this.tuning = { ...OVERVIEW, ...tuning };
    this.pitchT = this.tuning.framePitchDeg * DEG;
    this.distT = this.tuning.frameFactor;
    this.snap();
  }

  /** Arena radius the distance limits refer to. */
  get radius(): number {
    return this._radius;
  }
  /** True once `frame` has been called. */
  get framed(): boolean {
    return this._framed;
  }
  /** Current (smoothed) distance from the focus. */
  get distance(): number {
    return Math.exp(this.sLogD.value);
  }
  /** Distance the camera is heading to (after dolly clamps). */
  get targetDistance(): number {
    return this.distT;
  }
  /**
   * Current (smoothed) yaw / pitch in radians. Yaw is unwrapped, but `update` re-centres it by whole
   * turns once the target passes ±4π (compare yaws with a wrap, not a plain difference).
   */
  get yaw(): number {
    return this.sYaw.value;
  }
  get pitch(): number {
    return this.sPitch.value;
  }

  /**
   * Frame a sphere: focus on `focus`, distance frameFactor (2.2) × radius, slightly above, horizon
   * level with `up`. `fromDir` (from the focus toward where the camera should be, e.g. the current
   * ship position) keeps that side: its yaw is used and its elevation is clamped to 8°–50°. Without
   * it the current yaw is kept (a re-frame does not whip around) and the pitch returns to 22°.
   * The first framing, one with a different up vector, or one whose centre moved more than
   * maxFactor × radius (a new arena) jumps there (`snap`); later ones glide.
   */
  frame(focus: THREE.Vector3, radius: number, up: THREE.Vector3, fromDir?: THREE.Vector3): void {
    const T = this.tuning;
    if (Number.isFinite(radius) && radius > 0) this._radius = radius;
    let newBasis = !this._framed;
    if (finite3(up) && up.lengthSq() > 1e-20) {
      _v.copy(up).normalize();
      if (_v.dot(this.up) < 0.99999) newBasis = true;
      this.up.copy(_v);
    }
    if (newBasis) this.rebuildBasis();
    else {
      // A tiny up change (e.g. a slowly spinning nebula): keep A for yaw continuity but re-project it
      // ⟂ U, else A/B drift off the horizontal plane and distance, pitch and rays go wrong.
      this.basisA.addScaledVector(this.up, -this.basisA.dot(this.up)).normalize();
      this.basisB.crossVectors(this.up, this.basisA).normalize();
    }
    let jump = false;
    if (finite3(focus)) {
      const far = T.maxFactor * this._radius;
      jump = this._framed && focus.distanceToSquared(this.center) > far * far;
      this.center.copy(focus);
    }
    this.panOffset.set(0, 0, 0);

    let yaw = newBasis ? 0 : this.yawT;
    let pitch = T.framePitchDeg * DEG;
    if (fromDir && finite3(fromDir) && fromDir.lengthSq() > 1e-20) {
      _v.copy(fromDir).normalize();
      const h = Math.hypot(_v.dot(this.basisA), _v.dot(this.basisB));
      if (h > 1e-6) yaw = Math.atan2(_v.dot(this.basisB), _v.dot(this.basisA));
      pitch = clamp(Math.asin(clamp(_v.dot(this.up), -1, 1)), T.framePitchMinDeg * DEG, T.framePitchMaxDeg * DEG);
    }
    // Nearest representative of the new yaw, so a glide never takes the long way round.
    this.yawT = this.sYaw.value + wrapPi(yaw - this.sYaw.value);
    this.pitchT = clamp(pitch, -T.pitchLimitDeg * DEG, T.pitchLimitDeg * DEG);
    this.distT = clamp(T.frameFactor * this._radius, T.minFactor * this._radius, T.maxFactor * this._radius);
    const first = !this._framed;
    this._framed = true;
    if (first || newBasis || jump) this.snap();
  }

  /** Move the framed centre rigidly (no lag), e.g. to follow an arena carried by a moving nebula. */
  follow(center: THREE.Vector3): void {
    if (!finite3(center)) return;
    _v.subVectors(center, this.center);
    this.center.copy(center);
    this.sFx.shift(_v.x);
    this.sFy.shift(_v.y);
    this.sFz.shift(_v.z);
    this.recompute();
  }

  /** Orbit drag in CSS px, "grab the world": the near side follows the pointer. */
  orbit(dxPx: number, dyPx: number): void {
    if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return;
    const T = this.tuning;
    const lim = T.pitchLimitDeg * DEG;
    this.yawT -= dxPx * T.radPerPx;
    this.pitchT = clamp(this.pitchT + dyPx * T.radPerPx, -lim, lim);
  }

  /** Dolly by wheel notches (InputFrame.wheel convention: + = wheel up = closer), log-scaled, clamped. */
  dolly(notches: number): void {
    if (!Number.isFinite(notches)) return;
    const T = this.tuning;
    const d = this.distT * Math.pow(T.dollyPerNotch, -clamp(notches, -50, 50));
    this.distT = clamp(d, T.minFactor * this._radius, T.maxFactor * this._radius);
  }

  /**
   * Pan the focus in the view plane by a pointer drag (CSS px): the point at the focus depth follows
   * the pointer. Limited to panLimit × radius from the framed centre (keeps the focus meaningful).
   */
  pan(dxPx: number, dyPx: number, viewportH = 800, fovDeg = 70): void {
    if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return;
    const k = pixelSize(this.distance, viewportH, fovDeg);
    this.panOffset.addScaledVector(this.right, -dxPx * k).addScaledVector(this.screenUp, dyPx * k);
    const lim = this.tuning.panLimit * this._radius;
    if (this.panOffset.lengthSq() > lim * lim) this.panOffset.setLength(lim);
  }

  /** Jump every channel to its target (entering the view, teleports: reset TAA history alongside). */
  snap(): void {
    _w.addVectors(this.center, this.panOffset);
    this.sYaw.snap(this.yawT);
    this.sPitch.snap(this.pitchT);
    this.sLogD.snap(Math.log(Math.max(this.distT, 1e-12)));
    this.sFx.snap(_w.x);
    this.sFy.snap(_w.y);
    this.sFz.snap(_w.z);
    this.recompute();
  }

  /** Advance the smoothing by `dt` seconds (non-finite or ≤ 0 = no motion; long frames clamped). */
  update(dt: number): void {
    const h = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.5) : 0;
    if (h > 0) {
      const T = this.tuning;
      _w.addVectors(this.center, this.panOffset);
      this.sYaw.step(this.yawT, h, T.orbitTau1, T.orbitTau2);
      this.sPitch.step(this.pitchT, h, T.orbitTau1, T.orbitTau2);
      this.sLogD.step(Math.log(Math.max(this.distT, 1e-12)), h, T.dollyTau1, T.dollyTau2);
      this.sFx.step(_w.x, h, T.focusTau1, T.focusTau2);
      this.sFy.step(_w.y, h, T.focusTau1, T.focusTau2);
      this.sFz.step(_w.z, h, T.focusTau1, T.focusTau2);
      // Keep the continuous yaw small (target and both stages move together: no visible change).
      if (Math.abs(this.yawT) > 4 * Math.PI) {
        const k = TWO_PI * Math.round(this.yawT / TWO_PI);
        this.yawT -= k;
        this.sYaw.shift(-k);
      }
    }
    this.recompute();
  }

  /** Copy the current camera pose (camera convention: looks down local −Z, +Y up). */
  pose(outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    outPos.copy(this.position);
    outQuat.copy(this.quaternion);
  }

  /**
   * World ray through a viewport pixel for the current pose, consistent with a PerspectiveCamera at
   * `pose()` with vertical FOV `fovDeg` and aspect viewportW / viewportH. (px, py) are CSS px from the
   * viewport's top-left (InputFrame.pointer). Writes the camera position and a unit direction.
   */
  rayThrough(
    px: number,
    py: number,
    viewportW: number,
    viewportH: number,
    fovDeg: number,
    outOrigin: THREE.Vector3,
    outDir: THREE.Vector3,
  ): void {
    const w = viewportW > 0 ? viewportW : 1;
    const h = viewportH > 0 ? viewportH : 1;
    const fov = Number.isFinite(fovDeg) ? clamp(fovDeg, 1, 179) : 70;
    const ndcX = Number.isFinite(px) ? (px / w) * 2 - 1 : 0;
    const ndcY = Number.isFinite(py) ? 1 - (py / h) * 2 : 0;
    const t = Math.tan(fov * 0.5 * DEG);
    const x = ndcX * t * (w / h);
    const y = ndcY * t;
    outOrigin.copy(this.position);
    outDir.copy(this.forward).addScaledVector(this.right, x).addScaledVector(this.screenUp, y).normalize();
  }

  /** A, B: an orthonormal basis of the plane ⟂ U, from the world axis least aligned with U. */
  private rebuildBasis(): void {
    const ref = Math.abs(this.up.z) < 0.9 ? AXIS_Z : AXIS_X;
    this.basisA.copy(ref).addScaledVector(this.up, -ref.dot(this.up)).normalize();
    this.basisB.crossVectors(this.up, this.basisA).normalize();
  }

  private recompute(): void {
    const lim = this.tuning.pitchLimitDeg * DEG;
    const yaw = this.sYaw.value;
    const pitch = clamp(this.sPitch.value, -lim, lim);
    const dist = Math.exp(this.sLogD.value);
    const cp = Math.cos(pitch);
    // dir = from the focus toward the camera.
    _v.copy(this.basisA)
      .multiplyScalar(cp * Math.cos(yaw))
      .addScaledVector(this.basisB, cp * Math.sin(yaw))
      .addScaledVector(this.up, Math.sin(pitch));
    _w.set(this.sFx.value, this.sFy.value, this.sFz.value);
    if (!finite3(_v) || !finite3(_w) || !Number.isFinite(dist)) return; // keep the last good pose
    this.focus.copy(_w);
    this.position.copy(this.focus).addScaledVector(_v, dist);
    this.forward.copy(_v).negate();
    lookRotation(this.forward, this.up, this.quaternion);
    this.right.crossVectors(this.forward, this.up).normalize();
    this.screenUp.crossVectors(this.right, this.forward);
  }
}
