import * as THREE from 'three';

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential smoothing factor for a time constant (s). */
export const damp = (dt: number, tau: number) => 1 - Math.exp(-dt / Math.max(1e-6, tau));

export interface ScreenPoint {
  /** CSS pixels from the top-left of the viewport. */
  x: number;
  y: number;
  /** True if the point is in front of the camera and inside the viewport. */
  onScreen: boolean;
  /** True if the point is behind the camera. */
  behind: boolean;
  /** Angular radius → approximate on-screen radius in CSS px for a sphere of radius r (0 if r=0). */
  radiusPx: number;
}

const _v = new THREE.Vector3();

/**
 * Project a CAMERA-RELATIVE world position (worldPos − shipPos) to CSS pixels.
 * The render camera sits at the origin with the ship orientation.
 */
export function projectToScreen(
  rel: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  viewportW: number,
  viewportH: number,
  sphereRadius = 0,
): ScreenPoint {
  camera.updateMatrixWorld();
  _v.copy(rel).applyMatrix4(camera.matrixWorldInverse); // view space
  const behind = _v.z > 0;
  const dist = _v.length();
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const radiusPx = sphereRadius > 0 && dist > 0
    ? (Math.atan(sphereRadius / Math.max(dist, 1e-9)) / Math.atan(tanHalf)) * (viewportH / 2)
    : 0;
  const zc = Math.min(_v.z, -1e-9);
  const ndcX = (_v.x / -zc) / (tanHalf * camera.aspect);
  const ndcY = (_v.y / -zc) / tanHalf;
  const x = (ndcX * 0.5 + 0.5) * viewportW;
  const y = (1 - (ndcY * 0.5 + 0.5)) * viewportH;
  const onScreen = !behind && ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1;
  return { x, y, onScreen, behind, radiusPx };
}
