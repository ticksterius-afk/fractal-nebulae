import * as THREE from 'three';
import { FULLSCREEN_VERT, fullscreenTriangle } from '../RenderContext';

/** Any camera works for full-screen passes (the vertex shader ignores it). */
export const FULLSCREEN_CAMERA = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/** A single full-screen triangle drawn with one material. */
export class FullscreenPass {
  readonly mesh: THREE.Mesh;

  constructor(readonly material: THREE.ShaderMaterial) {
    this.mesh = new THREE.Mesh(fullscreenTriangle(), material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  /** Draw into `target` (null = canvas). Does not clear. */
  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, FULLSCREEN_CAMERA);
  }

  dispose(): void {
    this.material.dispose();
  }
}

/**
 * ShaderMaterial preset for post passes: full-screen vertex shader, no depth, no blending. Like every
 * material here it leaves glslVersion unset (three r186 still compiles GLSL ES 3.00 and declares
 * pc_fragColor for gl_FragColor; setting THREE.GLSL3 would remove that output).
 */
export function postMaterial(
  name: string,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
  defines?: Record<string, number | string | boolean>,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    defines: defines ?? {},
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    fog: false,
    lights: false,
  });
}

/** HalfFloat RGBA linear-filtered render target without depth (post intermediates). */
export function makeHdrTarget(w: number, h: number, depth = false): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
    depthBuffer: depth,
    stencilBuffer: false,
    colorSpace: THREE.LinearSRGBColorSpace,
  });
  return rt;
}

/**
 * Scene target: HalfFloat RGBA colour + a sampleable 32-bit float DepthTexture (the log depth the
 * passes write, read back by the TAA resolve). Depth testing works exactly like a renderbuffer;
 * three resizes the depth texture together with the target.
 */
export function makeSceneTarget(w: number, h: number): THREE.WebGLRenderTarget {
  const rt = makeHdrTarget(w, h, true);
  const depth = new THREE.DepthTexture(
    Math.max(1, w),
    Math.max(1, h),
    THREE.FloatType,
    undefined,
    THREE.ClampToEdgeWrapping,
    THREE.ClampToEdgeWrapping,
    THREE.NearestFilter,
    THREE.NearestFilter,
  );
  depth.format = THREE.DepthFormat;
  depth.generateMipmaps = false;
  depth.compareFunction = null; // plain sampler2D reads (no shadow comparison)
  rt.depthTexture = depth;
  return rt;
}

/**
 * Scene-resolution HDR layer sharing `scene`'s DepthTexture (three r186 supports one depth texture
 * attached to several targets; `scene` stays its owner). Sprites drawn into it are depth-tested
 * against everything already in the scene. MUST always have the same size as `scene` (three
 * throws on a size mismatch): resize both together.
 */
export function makeSpriteTarget(scene: THREE.WebGLRenderTarget): THREE.WebGLRenderTarget {
  const rt = makeHdrTarget(scene.width, scene.height, true);
  rt.depthTexture = scene.depthTexture;
  return rt;
}
