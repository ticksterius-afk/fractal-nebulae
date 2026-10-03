/**
 * First Light — views in the level nebula's LOCAL frame (design/60-first-light-build.md §M "Lab view").
 *
 * The whole game runs in the LOCAL frame of the level's nebula (world = position + rotation ·
 * local × scale): the tracer, the solver, the overlay and the saved levels all use it, so the mode
 * converts the camera into it instead of converting every object out of it.
 *
 *  - LocalView: the render camera (the ship pose — a puppeted ship IS the camera) expressed in
 *    local units, with the projection the renderer uses (vertical FOV, aspect = canvas CSS size):
 *    screen positions of local points, pixel sizes at a depth, and rays through CSS pixels.
 *  - LabView: the Tab overview. An OverviewCamera framed on the arena runs in LOCAL space, so it is
 *    carried by a spinning nebula for free (The Pearl Foam spins at 0.002 rad/s: its arena moves
 *    about one radius per minute in world space) and its rays come out in the frame placement needs.
 *    It tweens 0.6 s from the flight pose to the orbit and back, and reports the ghost x-ray radius
 *    (camera distance − 0.75 R) that turns the structure in front of the arena to glass.
 *
 * Allocation-free per frame.
 */
import * as THREE from 'three';
import type { NebulaRuntime } from '../../core/types';
import { OverviewCamera } from '../platform/OverviewCamera';
import type { ArenaDef } from './types';

const DEG = Math.PI / 180;
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** World point → nebula-local point. */
export function worldToLocal(rt: NebulaRuntime, w: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.subVectors(w, rt.position).applyQuaternion(rt.rotationInv).multiplyScalar(1 / rt.scale);
}

/** Nebula-local point → world point. */
export function localToWorld(rt: NebulaRuntime, l: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(l).multiplyScalar(rt.scale).applyQuaternion(rt.rotation).add(rt.position);
}

/** World orientation → local orientation (and back). */
export function quatWorldToLocal(rt: NebulaRuntime, q: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  return out.copy(rt.rotationInv).multiply(q);
}
export function quatLocalToWorld(rt: NebulaRuntime, q: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  return out.copy(rt.rotation).multiply(q);
}

export interface ScreenPos {
  /** CSS px from the canvas top-left. */
  x: number;
  y: number;
  /** View depth along the camera forward (local units); ≤ 0 = behind the camera. */
  depth: number;
}

/** The render camera in LOCAL units. */
export class LocalView {
  readonly origin = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly forward = new THREE.Vector3(0, 0, -1);
  readonly right = new THREE.Vector3(1, 0, 0);
  readonly up = new THREE.Vector3(0, 1, 0);
  tanHalf = Math.tan(35 * DEG);
  width = 1280;
  height = 720;

  /** From a world camera pose (the ship), the vertical FOV and the canvas CSS size. */
  setFromWorld(rt: NebulaRuntime, pos: THREE.Vector3, q: THREE.Quaternion, fovDeg: number, w: number, h: number): void {
    worldToLocal(rt, pos, _v);
    quatWorldToLocal(rt, q, _q);
    this.setLocal(_v, _q, fovDeg, w, h);
  }

  /**
   * From a LOCAL camera pose, the vertical FOV and the canvas CSS size (tools/fl-reach.ts poses the
   * vantage and the lab framing with it). Non-finite parts keep the last good value.
   */
  setLocal(pos: THREE.Vector3, q: THREE.Quaternion, fovDeg: number, w: number, h: number): void {
    if (Number.isFinite(pos.x + pos.y + pos.z)) this.origin.copy(pos);
    if (Number.isFinite(q.x + q.y + q.z + q.w) && q.lengthSq() > 1e-12) this.quat.copy(q).normalize();
    this.forward.set(0, 0, -1).applyQuaternion(this.quat);
    this.right.set(1, 0, 0).applyQuaternion(this.quat);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    const fov = Number.isFinite(fovDeg) ? Math.min(Math.max(fovDeg, 15), 150) : 70;
    this.tanHalf = Math.tan(fov * 0.5 * DEG);
    if (w > 0 && Number.isFinite(w)) this.width = w;
    if (h > 0 && Number.isFinite(h)) this.height = h;
  }

  /** Local length of one CSS pixel at view depth `depth`. */
  pixelSize(depth: number): number {
    return (2 * Math.max(depth, 1e-12) * this.tanHalf) / this.height;
  }

  /** Project a local point; false when it is behind the camera (out is still written). */
  project(x: number, y: number, z: number, out: ScreenPos): boolean {
    const dx = x - this.origin.x;
    const dy = y - this.origin.y;
    const dz = z - this.origin.z;
    const depth = dx * this.forward.x + dy * this.forward.y + dz * this.forward.z;
    out.depth = depth;
    if (!(depth > 1e-12)) {
      out.x = -1e6;
      out.y = -1e6;
      return false;
    }
    const sx = (dx * this.right.x + dy * this.right.y + dz * this.right.z) / (depth * this.tanHalf);
    const sy = (dx * this.up.x + dy * this.up.y + dz * this.up.z) / (depth * this.tanHalf);
    const aspect = this.width / this.height;
    out.x = (sx / aspect + 1) * 0.5 * this.width;
    out.y = (1 - sy) * 0.5 * this.height;
    return true;
  }

  /** Ray (unit direction) through a CSS pixel, local units. */
  ray(px: number, py: number, outO: THREE.Vector3, outD: THREE.Vector3): void {
    const ndcX = (px / this.width) * 2 - 1;
    const ndcY = 1 - (py / this.height) * 2;
    const aspect = this.width / this.height;
    outO.copy(this.origin);
    outD.copy(this.forward)
      .addScaledVector(this.right, (Number.isFinite(ndcX) ? ndcX : 0) * this.tanHalf * aspect)
      .addScaledVector(this.up, (Number.isFinite(ndcY) ? ndcY : 0) * this.tanHalf)
      .normalize();
  }
}

/** Lab-view tuning. */
export const LAB = {
  /** Tween between the flight pose and the orbit (s). */
  tween: 0.6,
  /** Structure closer to the camera than (distance − this × R) is x-rayed. */
  clipKeep: 0.75,
};

const ease = (t: number) => t * t * (3 - 2 * t);

/** The Tab overview: an orbit camera around the arena, in LOCAL space. */
export class LabView {
  /**
   * Framed from the side the player came from, also from below (a vantage under the arena would
   * otherwise flip the view to the top, away from the plane the level's bends face).
   */
  readonly cam = new OverviewCamera({ framePitchMinDeg: -78, framePitchMaxDeg: 78 });
  /** Direction (LOCAL, from the centre) the current framing was entered from; reused by reframe(). */
  private readonly frameDir = new THREE.Vector3();
  /** 0 = the flight pose … 1 = the orbit camera (linear tween progress). */
  private t = 0;
  /** +1 entering, −1 leaving, 0 settled. */
  private dir = 0;
  private readonly fromPos = new THREE.Vector3();
  private readonly fromQuat = new THREE.Quaternion();
  private readonly centre = new THREE.Vector3();
  private readonly upV = new THREE.Vector3(0, 1, 0);
  private radius = 1;

  /** The lab owns the camera (entering, in, or leaving). */
  get active(): boolean {
    return this.t > 0 || this.dir > 0;
  }
  /** Entering or in the lab view (not leaving). */
  get engaged(): boolean {
    return this.dir > 0 || (this.t >= 1 && this.dir === 0);
  }
  /** Eased blend 0..1 (occlusion alpha, HUD). */
  get amount(): number {
    return ease(Math.min(Math.max(this.t, 0), 1));
  }
  /** The leave tween finished on the last update (the caller releases the puppet). */
  justLeft = false;

  /**
   * Enter from a flight pose (LOCAL position / orientation, remembered for the way back). The orbit
   * keeps the player's side of the arena and snaps (no glide from an older lab pose).
   */
  enter(arena: ArenaDef, fromLocalPos: THREE.Vector3, fromLocalQuat: THREE.Quaternion): void {
    const c = arena.centerLocal;
    this.centre.set(c[0], c[1], c[2]);
    this.radius = arena.radiusLocal;
    const u = arena.up;
    this.upV.set(u ? u[0] : 0, u ? u[1] : 1, u ? u[2] : 0);
    if (!(this.upV.lengthSq() > 1e-12)) this.upV.set(0, 1, 0);
    this.upV.normalize();
    if (this.t <= 0) {
      this.fromPos.copy(fromLocalPos);
      this.fromQuat.copy(fromLocalQuat);
    }
    _v.subVectors(fromLocalPos, this.centre);
    this.frameDir.copy(_v);
    this.cam.frame(this.centre, this.radius, this.upV, _v.lengthSq() > 1e-20 ? _v : undefined);
    if (this.t <= 0) this.cam.snap();
    this.dir = 1;
    this.justLeft = false;
  }

  /**
   * Tween back to the remembered flight pose. Left before the first tween step (t = 0): nothing to
   * undo, the view is simply out (a lock granted on the frame the lab engaged).
   */
  leave(): void {
    if (this.t <= 0) {
      this.dir = 0;
      return;
    }
    this.dir = -1;
  }

  /** Drop the view at once (level change, exit). */
  reset(): void {
    this.t = 0;
    this.dir = 0;
    this.justLeft = false;
  }

  /** Backspace in the lab: glide back to the default framing. */
  reframe(): void {
    this.cam.frame(this.centre, this.radius, this.upV, this.frameDir.lengthSq() > 1e-20 ? this.frameDir : undefined);
  }

  /** The flight pose the lab returns to (LOCAL). */
  returnPose(outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    outPos.copy(this.fromPos);
    outQuat.copy(this.fromQuat);
  }

  update(dt: number): void {
    this.justLeft = false;
    const h = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (this.dir !== 0 && h > 0) {
      this.t += (this.dir * h) / LAB.tween;
      if (this.t >= 1) {
        this.t = 1;
        this.dir = 0;
      } else if (this.t <= 0) {
        this.t = 0;
        this.dir = 0;
        this.justLeft = true;
      }
    }
    this.cam.update(h);
  }

  /** Current camera pose (LOCAL) and the x-ray radius (LOCAL units). Returns the ghost clip. */
  pose(outPos: THREE.Vector3, outQuat: THREE.Quaternion): number {
    const e = this.amount;
    outPos.copy(this.fromPos).lerp(this.cam.position, e);
    outQuat.copy(this.fromQuat).slerp(this.cam.quaternion, e);
    const d = this.cam.position.distanceTo(this.centre);
    const clip = Math.max(0, d - LAB.clipKeep * this.radius);
    return Number.isFinite(clip) ? clip * e : 0;
  }
}
