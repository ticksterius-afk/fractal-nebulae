/**
 * Final composite to the canvas at full output resolution (see buildCompositeFragment).
 * The canvas framebuffer receives display-encoded sRGB values (the renderer's outputColorSpace is
 * linear so three.js performs no conversion of its own).
 * Game modes add point-mass gravitational lenses through setLenses (screen-space warp of the scene
 * and bloom, black shadow, photon rim; the sprite layer is never lensed, the near-star layer split
 * off it while lenses are on screen is).
 */
import * as THREE from 'three';
import { WORMHOLE_GLSL } from '../shaders/wormhole';
import { COMPOSITE_MAX_LENSES, buildCompositeFragment } from './postShaders';
import { FullscreenPass, postMaterial } from './FullscreenPass';
import type { ScreenLens } from '../game/overlayTypes';

const LENS_FIELDS = 4;
/**
 * Sanity bounds for lens values sent to the GPU (uv may lie off-screen; radii in image heights).
 * The uv bound must exceed the off-screen reach the projector keeps (6 × a 4-height radius, more in
 * portrait): clamping a kept lens's position moves its whole warp onto the screen.
 */
const LENS_UV_RANGE = 64;
const LENS_RADIUS_MAX = 4;

function finiteOr(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

function clampTo(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export interface CompositeParams {
  exposure: number;
  /** Already includes the bloom chain normalisation. */
  bloomStrength: number;
  /** 0..1 unsharp amount (strong for a bilinear upscale, mild on the TAAU-resolved image). */
  sharpen: number;
  /** Base chromatic aberration (uv offset at the screen edge per unit radius). */
  caBase: number;
  hyper: number;
  /** Focus of expansion in uv (0..1, y up). */
  foe: THREE.Vector2;
  tidal: number;
  tidalCenter: THREE.Vector2;
  wormholeActive: boolean;
  wormholeProgress: number;
  /** Ghost mode 0..1 and "inside a solid" 0..1 (phase-shift look). */
  ghost: number;
  ghostInside: number;
  vignette: number;
  grain: number;
  time: number;
  frame: number;
}

export class CompositePass {
  private readonly pass: FullscreenPass;
  private readonly black: THREE.DataTexture;
  /** 1×1 "far" depth (r = 1 → sky) bound when no scene depth texture is available. */
  private readonly farDepth: THREE.DataTexture;
  /** uLensA / uLensB backing stores (vec4 × COMPOSITE_MAX_LENSES each; uploaded as-is, no flatten). */
  private readonly lensA = new Float32Array(COMPOSITE_MAX_LENSES * LENS_FIELDS);
  private readonly lensB = new Float32Array(COMPOSITE_MAX_LENSES * LENS_FIELDS);
  private readonly bufSize = new THREE.Vector2();
  /** Lenses kept by the last setLenses (after validation). */
  private lensN = 0;

  constructor() {
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    this.black.needsUpdate = true;
    this.farDepth = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    this.farDepth.needsUpdate = true;
    const mat = postMaterial('post:composite', buildCompositeFragment(WORMHOLE_GLSL), {
      uSceneTex: { value: null },
      uBloomTex: { value: this.black },
      uSpriteTex: { value: this.black },
      uSpriteOn: { value: 0 },
      uNearTex: { value: this.black },
      uNearOn: { value: 0 },
      uSceneTexel: { value: new THREE.Vector2(1, 1) },
      uAspect: { value: 16 / 9 },
      uFxTime: { value: 0 },
      uFrame: { value: 0 },
      uExposure: { value: 1 },
      uBloomStrength: { value: 0 },
      uSharpen: { value: 0 },
      uCABase: { value: 0.0012 },
      uHyper: { value: 0 },
      uFoe: { value: new THREE.Vector2(0.5, 0.5) },
      uTidal: { value: 0 },
      uTidalCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uWormhole: { value: new THREE.Vector2(0, 0) },
      uGhost: { value: new THREE.Vector2(0, 0) },
      uVignette: { value: 0.3 },
      uGrain: { value: 0.03 },
      uLensA: { value: this.lensA },
      uLensB: { value: this.lensB },
      uLensCount: { value: 0 },
      uDepthTex: { value: this.farDepth },
      uOutTexelH: { value: 1 / 1080 },
    });
    this.pass = new FullscreenPass(mat);
  }

  get material(): THREE.ShaderMaterial {
    return this.pass.material;
  }

  /** Lenses the composite applies this frame (valid ones from the last setLenses). */
  get lensCount(): number {
    return this.lensN;
  }

  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Texture,
    sceneSize: THREE.Vector2,
    bloom: THREE.Texture | null,
    outAspect: number,
    p: CompositeParams,
    /** Sprite layer drawn outside `scene` (TAA on), added on top; null when it is inside `scene`. */
    sprites: THREE.Texture | null = null,
    /** Near-star layer split off `sprites` (lenses on screen), lensed and shadowed like `scene`; or null. */
    near: THREE.Texture | null = null,
  ): void {
    const u = this.pass.material.uniforms;
    u.uSceneTex.value = scene;
    u.uBloomTex.value = bloom ?? this.black;
    u.uSpriteTex.value = sprites ?? this.black;
    u.uSpriteOn.value = sprites ? 1 : 0;
    u.uNearTex.value = near ?? this.black;
    u.uNearOn.value = near ? 1 : 0;
    (u.uSceneTexel.value as THREE.Vector2).set(1 / Math.max(1, sceneSize.x), 1 / Math.max(1, sceneSize.y));
    u.uAspect.value = outAspect > 0 && Number.isFinite(outAspect) ? outAspect : 1;
    u.uFxTime.value = p.time % 3600;
    u.uFrame.value = p.frame % 65536;
    u.uExposure.value = p.exposure;
    u.uBloomStrength.value = bloom ? p.bloomStrength : 0;
    u.uSharpen.value = p.sharpen;
    u.uCABase.value = p.caBase;
    u.uHyper.value = p.hyper;
    (u.uFoe.value as THREE.Vector2).copy(p.foe);
    u.uTidal.value = p.tidal;
    (u.uTidalCenter.value as THREE.Vector2).copy(p.tidalCenter);
    (u.uWormhole.value as THREE.Vector2).set(p.wormholeActive ? 1 : 0, p.wormholeProgress);
    (u.uGhost.value as THREE.Vector2).set(p.ghost, p.ghostInside);
    u.uVignette.value = p.vignette;
    u.uGrain.value = p.grain;
    renderer.getDrawingBufferSize(this.bufSize);
    u.uOutTexelH.value = 1 / Math.max(1, this.bufSize.y);
    this.pass.render(renderer, null);
  }

  /**
   * Point-mass lenses for this frame (≤ LensBuffer.MAX), and the scene's log-depth texture (render
   * resolution) used to apply each lens only to pixels behind it. count 0 disables the warp (the
   * shader skips the lens code entirely). Call every frame before render(); the values persist.
   * Non-finite or empty lenses (strength ≤ 0, no radius) are dropped; a null depth texture binds a
   * 1×1 "far" fallback (every pixel counts as sky: each lens is in front, full θ_E).
   */
  setLenses(lenses: readonly ScreenLens[], count: number, depth: THREE.Texture | null): void {
    const u = this.pass.material.uniforms;
    const a = this.lensA;
    const b = this.lensB;
    const m = Math.min(Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0, lenses.length, COMPOSITE_MAX_LENSES);
    let n = 0;
    for (let i = 0; i < m; i++) {
      const l = lenses[i];
      if (!l) continue;
      const strength = clampTo(finiteOr(l.strength, 0), 0, 1);
      const einstein = clampTo(finiteOr(l.einstein, 0), 0, LENS_RADIUS_MAX);
      const shadow = clampTo(finiteOr(l.shadow, 0), 0, LENS_RADIUS_MAX);
      if (!(strength > 0) || !(einstein > 0 || shadow > 0)) continue;
      if (!Number.isFinite(l.u) || !Number.isFinite(l.v) || !Number.isFinite(l.depth01)) continue;
      const o = n * LENS_FIELDS;
      a[o] = clampTo(l.u, -LENS_UV_RANGE, 1 + LENS_UV_RANGE);
      a[o + 1] = clampTo(l.v, -LENS_UV_RANGE, 1 + LENS_UV_RANGE);
      a[o + 2] = einstein;
      a[o + 3] = shadow;
      b[o] = clampTo(l.depth01, 0, 1);
      b[o + 1] = strength;
      b[o + 2] = clampTo(finiteOr(l.glow, 0), 0, 1);
      b[o + 3] = 0;
      n++;
    }
    u.uLensCount.value = n;
    this.lensN = n;
    u.uDepthTex.value = n > 0 && depth ? depth : this.farDepth;
  }

  compileObjects(): THREE.Object3D[] {
    return [this.pass.mesh];
  }

  dispose(): void {
    this.pass.dispose();
    this.black.dispose();
    this.farDepth.dispose();
  }
}
