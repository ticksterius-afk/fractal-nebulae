/** Allocation-free orientation helpers for the flight model. */
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

/**
 * Camera-convention look rotation (looks down local −Z, local +Y up) facing `forward` with
 * roll chosen to keep local up as close to `upHint` as possible. Leaves `out` untouched if
 * `forward` is degenerate.
 */
export function lookRotation(forward: THREE.Vector3, upHint: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _z.copy(forward).negate();
  const zl = _z.length();
  if (!(zl > 1e-12)) return out;
  _z.multiplyScalar(1 / zl);
  _x.crossVectors(upHint, _z);
  if (_x.lengthSq() < 1e-10) _x.crossVectors(Math.abs(_z.y) < 0.9 ? AXIS_Y : AXIS_X, _z);
  _x.normalize();
  _y.crossVectors(_z, _x);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

/** Quaternion for a rotation vector (axis × angle, radians). */
export function rotationVectorToQuat(vx: number, vy: number, vz: number, out: THREE.Quaternion): THREE.Quaternion {
  const angle = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (angle < 1e-9) return out.set(vx * 0.5, vy * 0.5, vz * 0.5, 1).normalize();
  const s = Math.sin(angle * 0.5) / angle;
  return out.set(vx * s, vy * s, vz * s, Math.cos(angle * 0.5));
}

/** Rotation vector (world frame, shortest path) that takes `from` to `to`: to = exp(out) · from. */
export function quatErrorVector(from: THREE.Quaternion, to: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  _qa.copy(from).invert().premultiply(to); // to · from⁻¹
  let { x, y, z, w } = _qa;
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-9) return out.set(2 * x, 2 * y, 2 * z);
  const k = (2 * Math.atan2(s, w)) / s;
  return out.set(x * k, y * k, z * k);
}

/** True if every component is a finite number. */
export function finiteVec(v: THREE.Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export function finiteQuat(q: THREE.Quaternion): boolean {
  return Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w);
}
