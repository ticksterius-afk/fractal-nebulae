/**
 * HDR bloom: dual-filter mip chain (Jimenez 2014). 13-tap downsample (Karis average + soft-knee
 * threshold on the first level) into up to 6 half-resolution levels, then 3x3 tent upsample with
 * additive blending back up the chain. The result (level 0, half the scene resolution) holds the
 * sum of all levels; `normalization` converts it to an average for the composite.
 */
import * as THREE from 'three';
import { BLOOM_DOWN_FRAG, BLOOM_UP_FRAG } from './postShaders';
import { FullscreenPass, makeHdrTarget, postMaterial } from './FullscreenPass';

export class BloomPass {
  /** Soft-knee threshold in linear HDR scene units. */
  threshold = 0.85;
  knee = 0.6;
  /** Clamp applied to scene values entering the chain (firefly guard). */
  inputClamp = 300;
  /** Tent radius in source texels. */
  radius = 1.0;

  private readonly maxLevels: number;
  private mips: THREE.WebGLRenderTarget[] = [];
  private readonly downFirst: FullscreenPass;
  private readonly down: FullscreenPass;
  private readonly up: FullscreenPass;
  private width = 0;
  private height = 0;
  private readonly black: THREE.DataTexture;

  constructor(maxLevels = 6) {
    this.maxLevels = Math.max(1, Math.min(8, Math.floor(maxLevels)));
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    this.black.needsUpdate = true;
    const downUniforms = (): Record<string, THREE.IUniform> => ({
      uSrc: { value: null },
      uSrcTexel: { value: new THREE.Vector2(1, 1) },
      uThreshold: { value: new THREE.Vector3(this.threshold, this.knee, this.inputClamp) },
    });
    this.downFirst = new FullscreenPass(
      postMaterial('bloom:downFirst', BLOOM_DOWN_FRAG, { ...downUniforms(), uSrc2: { value: this.black } }, { FIRST: 1 }),
    );
    this.down = new FullscreenPass(postMaterial('bloom:down', BLOOM_DOWN_FRAG, downUniforms()));
    const upMat = postMaterial('bloom:up', BLOOM_UP_FRAG, {
      uSrc: { value: null },
      uSrcTexel: { value: new THREE.Vector2(1, 1) },
      uRadius: { value: 1 },
      uWeight: { value: 1 },
    });
    upMat.blending = THREE.CustomBlending;
    upMat.blendEquation = THREE.AddEquation;
    upMat.blendSrc = THREE.OneFactor;
    upMat.blendDst = THREE.OneFactor;
    upMat.blendEquationAlpha = THREE.AddEquation;
    upMat.blendSrcAlpha = THREE.OneFactor;
    upMat.blendDstAlpha = THREE.OneFactor;
    upMat.transparent = true;
    this.up = new FullscreenPass(upMat);
  }

  /** Number of mip levels currently in use. */
  get levels(): number {
    return this.mips.length;
  }

  /** Divide the chain's summed output by this to get an energy-normalised bloom. */
  get normalization(): number {
    return 1 / Math.max(1, this.mips.length);
  }

  /** The bloom result (valid after render()). */
  get texture(): THREE.Texture | null {
    return this.mips.length > 0 ? this.mips[0].texture : null;
  }

  /** Size the chain from the scene render-target size. */
  setSize(sceneW: number, sceneH: number): void {
    const w = Math.max(1, Math.floor(sceneW));
    const h = Math.max(1, Math.floor(sceneH));
    if (w === this.width && h === this.height && this.mips.length > 0) return;
    this.width = w;
    this.height = h;
    // The level count must not follow the dynamic resolution: `normalization` and the glow radius
    // depend on it, so a drop from 6 to 5 levels (it used to happen below 512 px scene height,
    // inside the low/medium scale range at 1440p) made the bloom jump ~20 % brighter and narrower.
    // Full chain down to 256 px scene height (smallest level ≥ 4 px).
    const levels = Math.max(1, Math.min(this.maxLevels, Math.floor(Math.log2(Math.max(2, Math.min(w, h)))) - 2));
    while (this.mips.length > levels) this.mips.pop()?.dispose();
    for (let i = 0; i < levels; i++) {
      const lw = Math.max(1, Math.round(w / Math.pow(2, i + 1)));
      const lh = Math.max(1, Math.round(h / Math.pow(2, i + 1)));
      if (i < this.mips.length) this.mips[i].setSize(lw, lh);
      else this.mips.push(makeHdrTarget(lw, lh));
    }
  }

  /**
   * Run the chain on `src` (+ `add`, same size: the sprite layer drawn outside the scene target)
   * — HDR textures of the size given to setSize. Leaves the level-0 target bound.
   */
  render(renderer: THREE.WebGLRenderer, src: THREE.Texture, add: THREE.Texture | null = null): THREE.Texture | null {
    const n = this.mips.length;
    if (n === 0) return null;

    const fu = this.downFirst.material.uniforms;
    fu.uSrc.value = src;
    fu.uSrc2.value = add ?? this.black;
    (fu.uSrcTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    (fu.uThreshold.value as THREE.Vector3).set(this.threshold, Math.max(1e-3, this.knee), this.inputClamp);
    this.downFirst.render(renderer, this.mips[0]);

    const du = this.down.material.uniforms;
    for (let i = 1; i < n; i++) {
      const s = this.mips[i - 1];
      du.uSrc.value = s.texture;
      (du.uSrcTexel.value as THREE.Vector2).set(1 / s.width, 1 / s.height);
      this.down.render(renderer, this.mips[i]);
    }

    const uu = this.up.material.uniforms;
    uu.uRadius.value = this.radius;
    for (let i = n - 1; i >= 1; i--) {
      const s = this.mips[i];
      uu.uSrc.value = s.texture;
      (uu.uSrcTexel.value as THREE.Vector2).set(1 / s.width, 1 / s.height);
      uu.uWeight.value = 1;
      this.up.render(renderer, this.mips[i - 1]);
    }
    return this.mips[0].texture;
  }

  /** Meshes for shader precompilation. */
  compileObjects(): THREE.Object3D[] {
    return [this.downFirst.mesh, this.down.mesh, this.up.mesh];
  }

  dispose(): void {
    for (const m of this.mips) m.dispose();
    this.mips = [];
    this.downFirst.dispose();
    this.down.dispose();
    this.up.dispose();
    this.black.dispose();
  }
}
