/**
 * Adds two same-size HDR layers into a target. The bloom chain takes one extra layer next to the
 * scene; while the near stars have their own (lensed) layer, this merges them with the overlay's
 * sprite layer into that input, so both keep their glow.
 */
import * as THREE from 'three';
import { LAYER_SUM_FRAG } from './postShaders';
import { FullscreenPass, postMaterial } from './FullscreenPass';

export class LayerSumPass {
  private readonly pass = new FullscreenPass(
    postMaterial('post:layerSum', LAYER_SUM_FRAG, { uSrc: { value: null }, uSrc2: { value: null } }),
  );

  get material(): THREE.ShaderMaterial {
    return this.pass.material;
  }

  /** `target` = a + b (all three the same size). Leaves `target` bound. */
  render(renderer: THREE.WebGLRenderer, a: THREE.Texture, b: THREE.Texture, target: THREE.WebGLRenderTarget): void {
    const u = this.pass.material.uniforms;
    u.uSrc.value = a;
    u.uSrc2.value = b;
    target.scissorTest = false;
    this.pass.render(renderer, target);
  }

  compileObjects(): THREE.Object3D[] {
    return [this.pass.mesh];
  }

  dispose(): void {
    this.pass.dispose();
  }
}
