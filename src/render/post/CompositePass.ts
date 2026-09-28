/**
 * Final composite to the canvas at full output resolution (see buildCompositeFragment).
 * The canvas framebuffer receives display-encoded sRGB values (the renderer's outputColorSpace is
 * linear so three.js performs no conversion of its own).
 */
import * as THREE from 'three';
import { WORMHOLE_GLSL } from '../shaders/wormhole';
import { buildCompositeFragment } from './postShaders';
import { FullscreenPass, postMaterial } from './FullscreenPass';

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

  constructor() {
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    this.black.needsUpdate = true;
    const mat = postMaterial('post:composite', buildCompositeFragment(WORMHOLE_GLSL), {
      uSceneTex: { value: null },
      uBloomTex: { value: this.black },
      uSpriteTex: { value: this.black },
      uSpriteOn: { value: 0 },
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
    });
    this.pass = new FullscreenPass(mat);
  }

  get material(): THREE.ShaderMaterial {
    return this.pass.material;
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
  ): void {
    const u = this.pass.material.uniforms;
    u.uSceneTex.value = scene;
    u.uBloomTex.value = bloom ?? this.black;
    u.uSpriteTex.value = sprites ?? this.black;
    u.uSpriteOn.value = sprites ? 1 : 0;
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
    this.pass.render(renderer, null);
  }

  compileObjects(): THREE.Object3D[] {
    return [this.pass.mesh];
  }

  dispose(): void {
    this.pass.dispose();
    this.black.dispose();
  }
}
