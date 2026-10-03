/**
 * LOCAL → camera-relative world transform of one nebula for the current frame, in doubles
 * (ARCHITECTURE.md §0: camera-relative rendering):
 *
 *   rel = (nebula.position − ship.position) + nebula.rotation · (local × nebula.scale)
 *
 * `set` once per frame, then `apply` per point (results in rx/ry/rz, nothing allocated). The
 * subtraction happens before any float cast, so content deep inside a nebula hundreds of ly from
 * the origin stays precise on the GPU.
 */
import type { NebulaRuntime } from '../../core/types';

export class LocalFrame {
  /** rotation × scale, row-major. */
  private m00 = 1;
  private m01 = 0;
  private m02 = 0;
  private m10 = 0;
  private m11 = 1;
  private m12 = 0;
  private m20 = 0;
  private m21 = 0;
  private m22 = 1;
  /** nebula.position − ship.position */
  private ox = 0;
  private oy = 0;
  private oz = 0;
  /** World ly per local unit. */
  scale = 1;
  /** Result of the last apply(): camera-relative world position (ly). */
  rx = 0;
  ry = 0;
  rz = 0;

  /** Returns false (and leaves the frame unusable) when the nebula pose or ship position is not finite. */
  set(neb: NebulaRuntime, ship: { x: number; y: number; z: number }): boolean {
    const q = neb.rotation;
    const s = neb.scale;
    const p = neb.position;
    const ql = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    if (!(ql > 1e-12) || !Number.isFinite(ql) || !(s > 0) || !Number.isFinite(s)) return false;
    const ox = p.x - ship.x;
    const oy = p.y - ship.y;
    const oz = p.z - ship.z;
    if (!Number.isFinite(ox + oy + oz)) return false;
    const x = q.x / ql;
    const y = q.y / ql;
    const z = q.z / ql;
    const w = q.w / ql;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    // Same matrix as THREE.Matrix4.makeRotationFromQuaternion, times the scale.
    this.m00 = (1 - (yy + zz)) * s;
    this.m01 = (xy - wz) * s;
    this.m02 = (xz + wy) * s;
    this.m10 = (xy + wz) * s;
    this.m11 = (1 - (xx + zz)) * s;
    this.m12 = (yz - wx) * s;
    this.m20 = (xz - wy) * s;
    this.m21 = (yz + wx) * s;
    this.m22 = (1 - (xx + yy)) * s;
    this.ox = ox;
    this.oy = oy;
    this.oz = oz;
    this.scale = s;
    return true;
  }

  /** Transform a LOCAL point; the camera-relative world result lands in rx/ry/rz. */
  apply(x: number, y: number, z: number): void {
    this.rx = this.ox + this.m00 * x + this.m01 * y + this.m02 * z;
    this.ry = this.oy + this.m10 * x + this.m11 * y + this.m12 * z;
    this.rz = this.oz + this.m20 * x + this.m21 * y + this.m22 * z;
  }
}
