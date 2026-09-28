/**
 * Galactic reference frame of the procedural sky, shared by the sky cubemap generator
 * (SkySystem) and the far-star catalogue (StarSystem) so bright stars crowd the Milky Way.
 *
 * The ship starts looking toward −Z: the galactic centre sits ~37° to the left of that
 * view, slightly above the horizon, and the band arches across the sky at a tilt.
 */
import type { Vec3 } from '../../core/types';

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Galactic north pole (unit normal of the Milky Way plane), world space. */
export const GALACTIC_NORTH: Vec3 = normalize([0.3, 0.9, -0.2]);

/** Direction toward the galactic centre (unit, orthogonal to GALACTIC_NORTH). */
export const GALACTIC_CENTRE: Vec3 = (() => {
  const guess: Vec3 = [-0.6, 0.05, -0.8];
  const n = GALACTIC_NORTH;
  const k = guess[0] * n[0] + guess[1] * n[1] + guess[2] * n[2];
  return normalize([guess[0] - n[0] * k, guess[1] - n[1] * k, guess[2] - n[2] * k]);
})();

/** Completes the right-handed frame: east = north × centre (galactic longitude +90°). */
export const GALACTIC_EAST: Vec3 = normalize(cross(GALACTIC_NORTH, GALACTIC_CENTRE));

/** Galactic latitude (radians) of a unit world direction. */
export function galacticLatitude(x: number, y: number, z: number): number {
  const n = GALACTIC_NORTH;
  const s = x * n[0] + y * n[1] + z * n[2];
  return Math.asin(s < -1 ? -1 : s > 1 ? 1 : s);
}

/** Galactic longitude (radians, 0 toward the centre, −π..π) of a unit world direction. */
export function galacticLongitude(x: number, y: number, z: number): number {
  const c = GALACTIC_CENTRE;
  const e = GALACTIC_EAST;
  return Math.atan2(x * e[0] + y * e[1] + z * e[2], x * c[0] + y * c[1] + z * c[2]);
}
