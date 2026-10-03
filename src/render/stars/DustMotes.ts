/**
 * Dust motes: a sense of motion and scale at every zoom level inside the fractals.
 *
 * Two octave levels of a camera-wrapped box are drawn: box = 2^L and 2^(L+1) with
 * L = floor(log2(surfaceDistance·3)), crossfaded by the fractional part. A level's layout is
 * a pure function of its octave (size + per-octave seed), so as the ship dives deeper the
 * outgoing level fades while the incoming one is already in place: no visible rescaling.
 * Motes flare as the resonance pulse wavefront sweeps through them.
 */
import * as THREE from 'three';
import { damp } from '../../core/math';
import type { RenderContext } from '../RenderContext';
import { generateDust } from './starData';
import {
  addInstanced,
  createSpriteGeometry,
  createSpriteMaterial,
  createSpriteMesh,
  fract,
  type UniformMap,
} from './sprites';

/** Box edge = surfaceDistance × this (before octave snapping). */
const BOX_PER_SURFACE_DISTANCE = 3;
/** Surface distance clamp (ly) for the dust scale: tiny near surfaces, bounded in the void. */
const SD_MIN = 1e-7;
const SD_MAX = 40;
/** Base mote flux (ref px²); multiplied by the region gain (void → nebula). */
const DUST_FLUX = 0.15;
const VOID_GAIN = 0.45;
const NEBULA_GAIN = 1.0;
/** Log-space smoothing of the dust scale (s): avoids flicker when the surface distance jumps. */
const SCALE_TAU = 0.6;

const DUST_MAIN = /* glsl */ `
in vec3 aPos;
in vec3 aColour;
in float aLum;
uniform vec3 uOffset;      // fract(shipPos / box) + per-octave seed
uniform float uBox;        // ly
uniform float uGain;       // level weight × region gain × base flux
uniform vec3 uTint;
uniform vec3 uStreak;
uniform float uMaxStreakPx;
uniform vec4 uPulse;       // wavefront centre (camera-relative ly), radius (ly)
uniform vec2 uPulseW;      // wavefront half-width (ly), strength 0..1
void main() {
  vec3 rel = (fract(aPos - uOffset + 0.5) - 0.5) * uBox;
  float r = length(rel);
  float rn = r / uBox;
  float fade = smoothstep(0.004, 0.03, rn) * (1.0 - smoothstep(0.3, 0.47, rn));
  float fluxRef = aLum * uGain * fade * mix(1.8, 0.4, smoothstep(0.0, 0.45, rn));
  float pd = (length(rel - uPulse.xyz) - uPulse.w) / max(uPulseW.x, 1e-20);
  float flare = uPulseW.y * exp(-pd * pd);
  fluxRef *= 1.0 + 8.0 * flare;
  if (fluxRef < 1e-4) { cullSprite(); return; }
  vec3 head = toView(rel);
  if (-head.z < 1e-3 * r) { cullSprite(); return; }
  vec2 hN = viewToNdc(head);
  vec2 s = streakPx(hN, head, toView(rel + uStreak), uMaxStreakPx);
  vec3 col = mix(uTint * aColour, vec3(0.75, 0.95, 1.0), min(flare, 1.0) * 0.7);
  emitSprite(hN, s, col, fluxRef * uPxScale * uPxScale, spriteSigma(), 0.0, 0.0, 0.0,
             logDepth(dot(rel, uCamForward)));
}
`;

interface Level {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  u: UniformMap;
}

export class DustMotes {
  readonly meshes: THREE.Mesh[];
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly levels: [Level, Level];
  private readonly tint = new THREE.Vector3(0.62, 0.72, 0.95);
  private readonly pulse = new THREE.Vector4(0, 0, 0, 0);
  private readonly pulseW = new THREE.Vector2(1, 0);
  private logBox = Number.NaN;
  private regionGain = VOID_GAIN;

  constructor(count: number, shared: UniformMap) {
    const data = generateDust(Math.max(0, Math.floor(count)));
    this.geometry = createSpriteGeometry(data.count);
    addInstanced(this.geometry, 'aPos', data.pos, 3);
    addInstanced(this.geometry, 'aColour', data.colour, 3);
    addInstanced(this.geometry, 'aLum', data.lum, 1);
    const make = (name: string): Level => {
      const u: UniformMap = {
        uOffset: { value: new THREE.Vector3() },
        uBox: { value: 1 },
        uGain: { value: 0 },
        uTint: { value: this.tint },
        uStreak: { value: new THREE.Vector3() },
        uMaxStreakPx: { value: 200 },
        uPulse: { value: this.pulse },
        uPulseW: { value: this.pulseW },
      };
      const material = createSpriteMaterial(name, DUST_MAIN, { ...shared, ...u }, true);
      const mesh = createSpriteMesh(this.geometry, material);
      mesh.visible = data.count > 0;
      return { mesh, material, u };
    };
    this.levels = [make('DustMotesA'), make('DustMotesB')];
    this.meshes = [this.levels[0].mesh, this.levels[1].mesh];
  }

  /**
   * @param targetTint luminance-normalized region tint (already blended toward the void tint)
   * @param regionWeight 0..1 influence of the current region
   */
  update(
    ctx: RenderContext,
    dt: number,
    streakWorld: THREE.Vector3,
    maxStreakPx: number,
    targetTint: THREE.Vector3,
    regionWeight: number,
  ): void {
    const state = ctx.state;
    const k = damp(dt, 1.5);
    this.tint.lerp(targetTint, Number.isNaN(this.logBox) ? 1 : k);
    const targetGain = VOID_GAIN + (NEBULA_GAIN - VOID_GAIN) * regionWeight;
    this.regionGain += (targetGain - this.regionGain) * (Number.isNaN(this.logBox) ? 1 : k);

    // The smoothed flight scale (what the speed is proportional to), not the raw surface distance:
    // motes then stream past at a steady rate for a steady throttle instead of pulsing near structure.
    let sd = Number.isFinite(state.env.flightScale) && state.env.flightScale > 0 ? state.env.flightScale : state.env.surfaceDistance;
    if (!Number.isFinite(sd)) sd = SD_MAX;
    sd = Math.min(Math.max(sd, SD_MIN), SD_MAX);
    const target = Math.log2(sd * BOX_PER_SURFACE_DISTANCE);
    this.logBox = Number.isNaN(this.logBox) ? target : this.logBox + (target - this.logBox) * damp(dt, SCALE_TAU);
    const L = Math.floor(this.logBox);
    const frac = this.logBox - L;

    const pulse = state.pulse;
    const ship = state.ship.position;
    if (pulse.active && pulse.width > 0) {
      this.pulse.set(pulse.origin.x - ship.x, pulse.origin.y - ship.y, pulse.origin.z - ship.z, pulse.radius);
      // gain: game modes soften pulses fired inside dense arena gas (1 in the Voyage); also keeps a NaN
      // age off the GPU.
      const s = 1 - pulse.age;
      const g = Number.isFinite(pulse.gain) ? Math.min(Math.max(pulse.gain, 0), 1) : 1;
      this.pulseW.set(pulse.width, s > 0 ? Math.min(s, 1) * g : 0);
    } else {
      this.pulseW.set(1, 0);
    }

    for (let i = 0; i < 2; i++) {
      const octave = L + i;
      const box = Math.pow(2, octave);
      const weight = i === 0 ? 1 - frac : frac;
      const u = this.levels[i].u;
      u.uBox.value = box;
      u.uGain.value = DUST_FLUX * this.regionGain * weight;
      // per-octave seed so consecutive octaves never line up (golden-ratio sequence)
      (u.uOffset.value as THREE.Vector3).set(
        fract(ship.x / box + octave * 0.6180339887),
        fract(ship.y / box + octave * 0.4142135624),
        fract(ship.z / box + octave * 0.7320508076),
      );
      (u.uStreak.value as THREE.Vector3).copy(streakWorld);
      u.uMaxStreakPx.value = maxStreakPx;
      this.levels[i].mesh.visible = weight > 1e-3 && this.geometry.instanceCount > 0;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    for (const l of this.levels) l.material.dispose();
  }
}
