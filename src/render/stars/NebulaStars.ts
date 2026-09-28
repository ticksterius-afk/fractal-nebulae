/**
 * The illuminating stars of each nebula (NebulaDef.lights): bright spiked sprites at their
 * world positions, depth-tested so fractal structure in front of them occludes them.
 */
import * as THREE from 'three';
import type { NebulaRuntime } from '../../core/types';
import type { RenderContext } from '../RenderContext';
import {
  addInstanced,
  createSpriteGeometry,
  createSpriteMaterial,
  createSpriteMesh,
  type UniformMap,
} from './sprites';

/** Apparent flux (ref px²) = K · intensity · size² / (1 + (r / R0)^FALL), capped. */
const FLUX_K = 22;
const FLUX_FALL = 1.3;
/** R0 as a fraction of the nebula's bound radius (ly). */
const R0_FRACTION = 0.6;
const FLUX_MAX = 400;
/** Spike length (ref px) = SPIKE_BASE + SPIKE_GAIN · √(flux / 10) · size. */
const SPIKE_BASE = 12;
const SPIKE_GAIN = 18;
/** PSF wing (halo) amplitude relative to the core peak. */
const HALO = 0.02;

const NEBULA_STAR_MAIN = /* glsl */ `
in vec3 aRel;      // camera-relative position (ly), updated every frame
in vec3 aColour;   // luminance-normalized colour
in vec3 aStar;     // flux (ref px²), spike length (ref px), halo amplitude
uniform vec3 uStreak;
uniform float uMaxStreakPx;
void main() {
  float r = length(aRel);
  vec3 head = toView(aRel);
  if (aStar.x <= 0.0 || r < 1e-9 || -head.z < 1e-4 * r) { cullSprite(); return; }
  vec2 hN = viewToNdc(head);
  vec2 s = streakPx(hN, head, toView(aRel + uStreak), uMaxStreakPx);
  float still = 1.0 - smoothstep(1.5, 6.0, length(s));
  emitSprite(hN, s, aColour, aStar.x * uPxScale * uPxScale, spriteSigma(),
             still, min(aStar.y * uPxScale, 0.35 * uResolution.y), aStar.z,
             logDepth(dot(aRel, uCamForward)));
}
`;

interface LightRef {
  neb: NebulaRuntime;
  local: THREE.Vector3;
  intensity: number;
  size: number;
}

const _p = new THREE.Vector3();

export class NebulaStars {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly lights: LightRef[] = [];
  private readonly rel: Float32Array;
  private readonly star: Float32Array;
  private readonly relAttr: THREE.InstancedBufferAttribute;
  private readonly starAttr: THREE.InstancedBufferAttribute;
  private readonly u: UniformMap;

  constructor(nebulae: NebulaRuntime[], shared: UniformMap) {
    const colours: number[] = [];
    for (const neb of nebulae) {
      for (const light of neb.def.lights) {
        const [r, g, b] = light.color;
        const intensity = Math.max(0.2126 * r + 0.7152 * g + 0.0722 * b, 1e-6);
        colours.push(r / intensity, g / intensity, b / intensity);
        this.lights.push({
          neb,
          local: new THREE.Vector3(light.local[0], light.local[1], light.local[2]),
          intensity,
          size: Math.max(0, light.size),
        });
      }
    }
    const n = this.lights.length;
    this.rel = new Float32Array(Math.max(1, n) * 3);
    this.star = new Float32Array(Math.max(1, n) * 3);
    this.geometry = createSpriteGeometry(n);
    this.relAttr = addInstanced(this.geometry, 'aRel', this.rel, 3, true);
    addInstanced(this.geometry, 'aColour', new Float32Array(colours.length ? colours : [1, 1, 1]), 3);
    this.starAttr = addInstanced(this.geometry, 'aStar', this.star, 3, true);
    this.u = { uStreak: { value: new THREE.Vector3() }, uMaxStreakPx: { value: 200 } };
    this.material = createSpriteMaterial('NebulaStars', NEBULA_STAR_MAIN, { ...shared, ...this.u }, true);
    this.mesh = createSpriteMesh(this.geometry, this.material);
    this.mesh.visible = n > 0;
  }

  update(ctx: RenderContext, streakWorld: THREE.Vector3, maxStreakPx: number): void {
    const n = this.lights.length;
    if (n === 0) return;
    const ship = ctx.state.ship.position;
    for (let i = 0; i < n; i++) {
      const L = this.lights[i];
      const neb = L.neb;
      // world = position + rotation·(local·scale); camera-relative in doubles, then cast
      _p.copy(L.local).multiplyScalar(neb.scale).applyQuaternion(neb.rotation);
      const x = neb.position.x + _p.x - ship.x;
      const y = neb.position.y + _p.y - ship.y;
      const z = neb.position.z + _p.z - ship.z;
      const r = Math.sqrt(x * x + y * y + z * z);
      const r0 = Math.max(R0_FRACTION * neb.boundRadiusWorld, 1e-6);
      let flux = (FLUX_K * L.intensity * L.size * L.size) / (1 + Math.pow(r / r0, FLUX_FALL));
      if (!Number.isFinite(flux) || !Number.isFinite(r)) flux = 0;
      flux = Math.min(flux, FLUX_MAX);
      this.rel[i * 3] = x;
      this.rel[i * 3 + 1] = y;
      this.rel[i * 3 + 2] = z;
      this.star[i * 3] = flux;
      this.star[i * 3 + 1] = (SPIKE_BASE + SPIKE_GAIN * Math.sqrt(flux / 10)) * L.size;
      this.star[i * 3 + 2] = HALO;
    }
    this.relAttr.needsUpdate = true;
    this.starAttr.needsUpdate = true;
    (this.u.uStreak.value as THREE.Vector3).copy(streakWorld);
    this.u.uMaxStreakPx.value = maxStreakPx;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
