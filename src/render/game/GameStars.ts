/**
 * Spiked star sprites of the overlay (sources, ignited seeds): the JWST look of NebulaStars through
 * the shared sprite pipeline (stars/sprites.ts + spriteShader.ts), fed from a StarBuffer (LOCAL)
 * converted to camera-relative positions every frame. Drawn in both occlusion passes like lines and
 * glyphs (uAlpha scales the flux).
 */
import * as THREE from 'three';
import { StarBuffer } from './overlayTypes';
import { createSpriteMaterial, type UniformMap } from '../stars/sprites';
import type { LocalFrame } from './LocalFrame';
import { InstancedLayer, PASS_DEPTH } from './overlayMesh';

/** PSF wing (halo) amplitude relative to the core peak (as NebulaStars). */
const HALO = 0.02;
/** Sanity caps (ref px² / ref px). */
const FLUX_MAX = 4000;
const SPIKE_MAX = 1500;

const GAME_STAR_MAIN = /* glsl */ `
uniform float uAlpha;
in vec3 aRel;      // camera-relative position (ly), updated every frame
in vec3 aColour;   // luminance-normalised colour
in vec3 aStar;     // flux (ref px²), spike length (ref px), halo amplitude
void main() {
  float r = length(aRel);
  vec3 head = toView(aRel);
  if (!(aStar.x > 0.0) || r < 1e-9 || -head.z < 1e-4 * r) { cullSprite(); return; }
  emitSprite(viewToNdc(head), vec2(0.0), aColour, aStar.x * uPxScale * uPxScale * uAlpha, spriteSigma(),
             aStar.y > 0.0 ? 1.0 : 0.0, min(aStar.y * uPxScale, 0.35 * uResolution.y), aStar.z,
             logDepth(-head.z));
}
`;

const ATTRIBS = [
  { name: 'aRel', size: 3 },
  { name: 'aColour', size: 3 },
  { name: 'aStar', size: 3 },
] as const;

export class GameStars {
  readonly materials: [THREE.ShaderMaterial, THREE.ShaderMaterial];
  readonly layer: InstancedLayer;

  constructor(shared: UniformMap, capacity = 1) {
    const visible = createSpriteMaterial('OverlayStars', GAME_STAR_MAIN, { ...shared, uAlpha: { value: 1 } }, true);
    const occluded = createSpriteMaterial('OverlayStarsOccluded', GAME_STAR_MAIN, { ...shared, uAlpha: { value: 0 } }, true);
    visible.depthFunc = PASS_DEPTH[0];
    occluded.depthFunc = PASS_DEPTH[1];
    this.materials = [visible, occluded];
    this.layer = new InstancedLayer(ATTRIBS, this.materials, capacity);
  }

  get meshes(): [THREE.Mesh, THREE.Mesh] {
    return this.layer.meshes;
  }

  setOccludedAlpha(a: number): void {
    this.materials[1].uniforms.uAlpha.value = a;
  }

  /** Convert this frame's stars; returns the number of instances to draw. */
  update(stars: StarBuffer, frame: LocalFrame): number {
    const layer = this.layer;
    if (stars.count > layer.capacity) layer.ensureCapacity(stars.capacity);
    const n = Math.min(stars.count, layer.capacity);
    const src = stars.data;
    const dst = layer.data;
    const S = StarBuffer.STRIDE;
    const D = layer.stride;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const o = i * S;
      let sum = 0;
      for (let j = 0; j < S; j++) sum += src[o + j];
      const flux = src[o + 6];
      if (!Number.isFinite(sum) || !(flux > 0)) continue;
      const d = k * D;
      frame.apply(src[o], src[o + 1], src[o + 2]);
      dst[d] = frame.rx;
      dst[d + 1] = frame.ry;
      dst[d + 2] = frame.rz;
      dst[d + 3] = Math.max(src[o + 3], 0);
      dst[d + 4] = Math.max(src[o + 4], 0);
      dst[d + 5] = Math.max(src[o + 5], 0);
      dst[d + 6] = Math.min(flux, FLUX_MAX);
      dst[d + 7] = Math.min(Math.max(src[o + 7], 0), SPIKE_MAX);
      dst[d + 8] = HALO;
      k++;
    }
    layer.commit(k);
    return k;
  }

  dispose(): void {
    this.layer.dispose();
    this.materials[0].dispose();
    this.materials[1].dispose();
  }
}
