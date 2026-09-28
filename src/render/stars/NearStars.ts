/**
 * Local stars in a repeating box wrapped around the camera (offset = shipPos mod box, in
 * doubles) → true parallax. Brightness falls with distance and fades out before the box
 * edge, so wrapping never pops. At speed they stretch into energy-conserving streaks.
 */
import * as THREE from 'three';
import type { RenderContext } from '../RenderContext';
import { generateNearStars } from './starData';
import {
  addInstanced,
  createSpriteGeometry,
  createSpriteMaterial,
  createSpriteMesh,
  fract,
  type UniformMap,
} from './sprites';

/** Edge of the repeating box (ly). */
export const NEAR_STAR_BOX = 600;
/** Distance (ly) inside which a star shows its full intrinsic brightness. */
const NEAR_R0 = 15;
const FADE_START = 0.36 * NEAR_STAR_BOX;
const FADE_END = 0.48 * NEAR_STAR_BOX;
/** Apparent flux range (ref px²) over which diffraction spikes fade in. */
const SPIKE_FLUX_MIN = 6;
const SPIKE_FLUX_MAX = 20;

const NEAR_MAIN = /* glsl */ `
in vec3 aPos;      // unit-box position
in vec3 aColour;   // luminance-normalized colour
in float aLum;     // flux (ref px²) at distance r0
uniform vec3 uOffset;      // fract(shipPos / box)
uniform float uBox;        // ly
uniform vec3 uStreak;      // world displacement drawn as a streak
uniform float uMaxStreakPx;
uniform vec4 uNear;        // r0, fade start, fade end, gain
uniform vec2 uSpikeFlux;   // spikes fade in over this apparent flux range
void main() {
  vec3 rel = (fract(aPos - uOffset + 0.5) - 0.5) * uBox;
  float r = length(rel);
  float r0 = uNear.x;
  float fluxRef = aLum * uNear.w * (1.0 - smoothstep(uNear.y, uNear.z, r)) * (r0 * r0) / (r * r + r0 * r0);
  if (fluxRef < 2e-3 || r < 1e-9) { cullSprite(); return; }
  float D, Dt;
  vec3 head = toView(aberrateForward(rel / r, D) * r);
  if (-head.z < 1e-4 * r) { cullSprite(); return; }
  vec3 tailRel = rel + uStreak;
  float rt = length(tailRel);
  vec3 tail = rt > 1e-9 ? toView(aberrateForward(tailRel / rt, Dt) * rt) : head;
  vec2 hN = viewToNdc(head);
  vec2 s = streakPx(hN, head, tail, uMaxStreakPx);
  float sl = length(s);
  vec3 col = D == 1.0 ? aColour : dopplerShift(aColour, D);
  float spike = smoothstep(uSpikeFlux.x, uSpikeFlux.y, fluxRef) * (1.0 - smoothstep(1.5, 6.0, sl));
  float spikeLen = min((8.0 + 9.0 * sqrt(fluxRef / uSpikeFlux.x)) * uPxScale, 0.3 * uResolution.y);
  // depth of the aberrated position actually drawn: a star pulled forward from behind the
  // camera at hyper speed must not get depth 0 and show through nebula surfaces
  emitSprite(hN, s, col, fluxRef * uPxScale * uPxScale * uSkyExposure, spriteSigma(),
             spike, spikeLen, spike * 0.006, logDepth(-head.z));
}
`;

export class NearStars {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly u: UniformMap;

  constructor(count: number, shared: UniformMap) {
    const data = generateNearStars(Math.max(0, Math.floor(count)));
    this.geometry = createSpriteGeometry(data.count);
    addInstanced(this.geometry, 'aPos', data.pos, 3);
    addInstanced(this.geometry, 'aColour', data.colour, 3);
    addInstanced(this.geometry, 'aLum', data.lum, 1);
    this.u = {
      uOffset: { value: new THREE.Vector3() },
      uBox: { value: NEAR_STAR_BOX },
      uStreak: { value: new THREE.Vector3() },
      uMaxStreakPx: { value: 200 },
      uNear: { value: new THREE.Vector4(NEAR_R0, FADE_START, FADE_END, 1) },
      uSpikeFlux: { value: new THREE.Vector2(SPIKE_FLUX_MIN, SPIKE_FLUX_MAX) },
    };
    this.material = createSpriteMaterial('NearStars', NEAR_MAIN, { ...shared, ...this.u }, true);
    this.mesh = createSpriteMesh(this.geometry, this.material);
    this.mesh.visible = data.count > 0;
  }

  update(ctx: RenderContext, streakWorld: THREE.Vector3, maxStreakPx: number): void {
    const p = ctx.state.ship.position;
    (this.u.uOffset.value as THREE.Vector3).set(
      fract(p.x / NEAR_STAR_BOX),
      fract(p.y / NEAR_STAR_BOX),
      fract(p.z / NEAR_STAR_BOX),
    );
    (this.u.uStreak.value as THREE.Vector3).copy(streakWorld);
    this.u.uMaxStreakPx.value = maxStreakPx;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
