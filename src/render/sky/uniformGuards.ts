import type * as THREE from 'three';

/**
 * Repairs relativistic sky uniforms after applySkyUniforms(): a zero/NaN velocity direction
 * or NaN beta/exposure would otherwise turn the whole sky (and every star) into NaNs.
 */
export function sanitizeSkyUniforms(u: Record<string, THREE.IUniform>): void {
  const v = u.uVelDir.value as THREE.Vector3;
  const l = v.length();
  if (!(l > 1e-6) || !Number.isFinite(l)) {
    v.set(0, 0, -1);
    u.uBeta.value = 0;
  } else if (Math.abs(l - 1) > 1e-4) {
    v.multiplyScalar(1 / l);
  }
  const beta = u.uBeta.value as number;
  u.uBeta.value = Number.isFinite(beta) ? Math.min(Math.max(beta, 0), 0.95) : 0;
  const exposure = u.uSkyExposure.value as number;
  if (!Number.isFinite(exposure) || exposure < 0) u.uSkyExposure.value = 1;
}
