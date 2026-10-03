/**
 * Per-frame render context built by the Renderer and handed to every render subsystem
 * (sky, stars, nebula materials, black holes, post). Contract owner: architecture.
 */
import * as THREE from 'three';
import type { QualityPreset, SimState } from '../core/types';
import type { AccentLights, OverlayFrame } from './game/overlayTypes';

export interface RenderContext {
  state: SimState;
  /** Render camera: sits at the ORIGIN (camera-relative rendering) with ship orientation + shake. */
  camera: THREE.PerspectiveCamera;
  /** Camera local→world rotation. */
  camRot: THREE.Matrix3;
  /** World unit forward vector of the camera. */
  camForward: THREE.Vector3;
  /** (tan(fovY/2)*aspect, tan(fovY/2)) */
  tanHalf: THREE.Vector2;
  /** Current scene render-target size in px (dynamic resolution applied). */
  resolution: THREE.Vector2;
  /** Radians per render-target pixel (vertical). */
  pixelAngle: number;
  /** Sub-pixel jitter (render-target px, each in -0.5..0.5) for temporal anti-aliasing; (0,0) when off. */
  jitter: THREE.Vector2;
  /** Seconds since launch. */
  time: number;
  quality: QualityPreset;
  /** Procedural sky cubemap (for lensing / reflections); set once SkySystem.init resolved. */
  skyCube: THREE.Texture | null;
  /** Relativistic sky parameters (see SKY_SAMPLE_GLSL). */
  beta: number;
  velDir: THREE.Vector3;
  skyExposure: number;
  /** Game overlay of the active mode (null in the Voyage). Set through Renderer.setOverlay. */
  overlay: OverlayFrame | null;
  /**
   * Accent lights for one nebula pass (resolved by the Renderer from the overlay each frame;
   * count 0 / nebulaId null when there are none). Read by updateNebulaUniforms.
   */
  accents: AccentLights;
}

/** Uniform objects expected by CAMERA_UNIFORMS_GLSL. */
export function makeCameraUniforms(): Record<string, THREE.IUniform> {
  return {
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCamRot: { value: new THREE.Matrix3() },
    uCamForward: { value: new THREE.Vector3(0, 0, -1) },
    uTanHalf: { value: new THREE.Vector2(1, 1) },
    uPixelAngle: { value: 0.001 },
    uTime: { value: 0 },
    uJitter: { value: new THREE.Vector2(0, 0) },
  };
}

export function applyCameraUniforms(u: Record<string, THREE.IUniform>, ctx: RenderContext): void {
  (u.uResolution.value as THREE.Vector2).copy(ctx.resolution);
  (u.uCamRot.value as THREE.Matrix3).copy(ctx.camRot);
  (u.uCamForward.value as THREE.Vector3).copy(ctx.camForward);
  (u.uTanHalf.value as THREE.Vector2).copy(ctx.tanHalf);
  u.uPixelAngle.value = ctx.pixelAngle;
  u.uTime.value = ctx.time;
  if (u.uJitter) (u.uJitter.value as THREE.Vector2).copy(ctx.jitter);
}

/** Uniform objects expected by SKY_SAMPLE_GLSL. */
export function makeSkyUniforms(): Record<string, THREE.IUniform> {
  return {
    uSkyCube: { value: null },
    uBeta: { value: 0 },
    uVelDir: { value: new THREE.Vector3(0, 0, -1) },
    uSkyExposure: { value: 1 },
  };
}

export function applySkyUniforms(u: Record<string, THREE.IUniform>, ctx: RenderContext): void {
  u.uSkyCube.value = ctx.skyCube;
  u.uBeta.value = ctx.beta;
  (u.uVelDir.value as THREE.Vector3).copy(ctx.velDir);
  u.uSkyExposure.value = ctx.skyExposure;
}

/** Full-screen triangle geometry shared by all full-screen passes (positions in clip space). */
let _fsTri: THREE.BufferGeometry | null = null;
export function fullscreenTriangle(): THREE.BufferGeometry {
  if (!_fsTri) {
    _fsTri = new THREE.BufferGeometry();
    _fsTri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    _fsTri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  }
  return _fsTri;
}

/** Vertex shader for full-screen passes using fullscreenTriangle(): no camera transform. */
export const FULLSCREEN_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
