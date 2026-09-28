/**
 * Stars at infinity: point sprites on the celestial sphere (directions only), with the same
 * relativistic aberration + Doppler shift as the sky cubemap, JWST spikes on the brightest.
 */
import * as THREE from 'three';
import { generateFarStars } from './starData';
import { addInstanced, createSpriteGeometry, createSpriteMaterial, createSpriteMesh, type UniformMap } from './sprites';

const FAR_MAIN = /* glsl */ `
in vec3 aDir;     // rest-frame unit direction
in vec3 aColour;  // luminance-normalized colour
in vec3 aStar;    // flux (ref px²), spike amount, spike length (ref px)
uniform float uGain;
void main() {
  float D;
  vec3 v = toView(aberrateForward(aDir, D));
  if (v.z > -1e-4) { cullSprite(); return; }
  vec3 col = D == 1.0 ? aColour : dopplerShift(aColour, D);
  float flux = aStar.x * uPxScale * uPxScale * uGain * uSkyExposure;
  // depth irrelevant (no depth test); keep it at the far plane
  emitSprite(viewToNdc(v), vec2(0.0), col, flux, spriteSigma(),
             aStar.y, aStar.z * uPxScale, aStar.y * 0.006, 0.99999);
}
`;

export class FarStars {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.InstancedBufferGeometry;

  constructor(count: number, shared: UniformMap) {
    const data = generateFarStars(Math.max(0, Math.floor(count)));
    this.geometry = createSpriteGeometry(data.count);
    addInstanced(this.geometry, 'aDir', data.dir, 3);
    addInstanced(this.geometry, 'aColour', data.colour, 3);
    addInstanced(this.geometry, 'aStar', data.star, 3);
    this.material = createSpriteMaterial('FarStars', FAR_MAIN, { ...shared, uGain: { value: 1 } }, false);
    this.mesh = createSpriteMesh(this.geometry, this.material);
    this.mesh.visible = data.count > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

