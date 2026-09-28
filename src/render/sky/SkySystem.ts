/**
 * The procedural sky: generated once into an HDR cubemap (rest frame), then drawn every
 * frame as a full-screen pass through SKY_SAMPLE_GLSL, which applies relativistic
 * aberration + Doppler shift when the ship is at hyper speed.
 */
import * as THREE from 'three';
import type { QualityPreset } from '../../core/types';
import { CAMERA_UNIFORMS_GLSL, COMMON_GLSL } from '../shaders/common';
import {
  FULLSCREEN_VERT,
  applyCameraUniforms,
  applySkyUniforms,
  fullscreenTriangle,
  makeCameraUniforms,
  makeSkyUniforms,
  type RenderContext,
} from '../RenderContext';
import { SKY_SAMPLE_GLSL } from './skyShared';
import { SKY_GEN_FRAG, SKY_GEN_VERT } from './skyGenerator';
import { GALACTIC_CENTRE, GALACTIC_EAST, GALACTIC_NORTH } from './skyParams';
import { precompileScenes } from './precompile';
import { sanitizeSkyUniforms } from './uniformGuards';

const SKY_PASS_FRAG = /* glsl */ `
${COMMON_GLSL}
${CAMERA_UNIFORMS_GLSL}
${SKY_SAMPLE_GLSL}
in vec2 vUv;
void main() {
  vec3 rd = cameraRay(gl_FragCoord.xy + uJitter, uResolution, uCamRot, uTanHalf);
  gl_FragColor = vec4(sampleSky(rd), 1.0);
}
`;

/** Largest generator tile edge (px): keeps every GPU submission far below driver watchdogs. */
const MAX_TILE = 1024;

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Cube face size from a preset: a sane integer, so a bad value never creates a broken target. */
function cubeSize(q: QualityPreset): number {
  const s = Math.round(q.skyCubeSize);
  return Number.isFinite(s) ? Math.min(Math.max(s, 128), 4096) : 1024;
}

function createCubeTarget(size: number): THREE.WebGLCubeRenderTarget {
  const target = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.name = 'SkyCube';
  return target;
}

export class SkySystem {
  private readonly renderer: THREE.WebGLRenderer;
  private target: THREE.WebGLCubeRenderTarget;
  /** Bumped whenever an in-flight generation must be abandoned. */
  private generationToken = 0;
  private initPromise: Promise<void> | null = null;
  private disposed = false;
  /** The current target's content is incomplete (its regeneration was abandoned). */
  private stale = false;
  /** Canvas whose 'webglcontextrestored' we listen to (null outside a browser). */
  private readonly canvas: HTMLCanvasElement | null = null;

  private readonly genScene = new THREE.Scene();
  private readonly genGeometry = new THREE.BoxGeometry(2, 2, 2);
  private readonly genMaterial: THREE.ShaderMaterial;
  private readonly cubeCamera: THREE.CubeCamera;

  private readonly passScene = new THREE.Scene();
  private readonly passMaterial: THREE.ShaderMaterial;
  private readonly passUniforms: Record<string, THREE.IUniform>;

  constructor(renderer: THREE.WebGLRenderer, quality: QualityPreset) {
    this.renderer = renderer;
    const size = cubeSize(quality);
    this.target = createCubeTarget(size);

    this.genMaterial = new THREE.ShaderMaterial({
      name: 'SkyGenerator',
      vertexShader: SKY_GEN_VERT,
      fragmentShader: SKY_GEN_FRAG,
      uniforms: {
        uTexelAngle: { value: 2 * Math.atan(1 / size) },
        uGalNorth: { value: new THREE.Vector3(...GALACTIC_NORTH) },
        uGalCentre: { value: new THREE.Vector3(...GALACTIC_CENTRE) },
        uGalEast: { value: new THREE.Vector3(...GALACTIC_EAST) },
      },
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    const genMesh = new THREE.Mesh(this.genGeometry, this.genMaterial);
    genMesh.frustumCulled = false;
    this.genScene.add(genMesh);
    this.genScene.matrixWorldAutoUpdate = false;
    genMesh.updateMatrixWorld(true);

    // Only its six face cameras are used (orientation per renderer coordinate system).
    this.cubeCamera = new THREE.CubeCamera(0.1, 10, this.target);
    this.cubeCamera.updateMatrixWorld(true);

    this.passUniforms = { ...makeCameraUniforms(), ...makeSkyUniforms() };
    this.passMaterial = new THREE.ShaderMaterial({
      name: 'SkyPass',
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: SKY_PASS_FRAG,
      uniforms: this.passUniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    const passMesh = new THREE.Mesh(fullscreenTriangle(), this.passMaterial);
    passMesh.frustumCulled = false;
    this.passScene.add(passMesh);
    this.passScene.matrixWorldAutoUpdate = false;
    passMesh.updateMatrixWorld(true);

    // A lost context takes the cubemap contents with it (three re-creates the render target
    // empty): regenerate on restore. three's own restore handler was registered first.
    const canvas = (renderer as Partial<THREE.WebGLRenderer>).domElement;
    if (canvas && typeof canvas.addEventListener === 'function') {
      canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
      this.canvas = canvas;
    }
  }

  /** The HDR sky cubemap. Replaced when setQuality changes the face size: re-read it each frame. */
  get cubeTexture(): THREE.Texture {
    return this.target.texture;
  }

  /** Compile both programs, then generate the cubemap tile by tile. Idempotent. */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const faces = this.faceCameras();
        await precompileScenes(this.renderer, [this.genScene, this.passScene], faces[0], this.target);
        await this.generate(this.target, this.generationToken);
      })();
    }
    return this.initPromise;
  }

  /** Full-screen sky into the currently bound render target (no depth, opaque). */
  render(renderer: THREE.WebGLRenderer, ctx: RenderContext): void {
    const u = this.passUniforms;
    applyCameraUniforms(u, ctx);
    applySkyUniforms(u, ctx);
    sanitizeSkyUniforms(u);
    u.uSkyCube.value = this.target.texture; // always our own cube, even before ctx.skyCube is set
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.passScene, ctx.camera);
    renderer.autoClear = autoClear;
  }

  /** Regenerates the cubemap only when the face size changes; the old sky stays live meanwhile. */
  async setQuality(q: QualityPreset): Promise<void> {
    await this.init();
    if (this.disposed) return;
    const size = cubeSize(q);
    // Abandons any in-flight regeneration (its own call disposes its target).
    const token = ++this.generationToken;
    if (size === this.target.width) {
      // a regeneration of the current target abandoned just now must still be completed
      if (this.stale && (await this.generate(this.target, token))) this.stale = false;
      return;
    }

    const next = createCubeTarget(size);
    const done = await this.generate(next, token);
    if (!done || this.disposed || token !== this.generationToken) {
      next.dispose();
      return;
    }
    const old = this.target;
    this.target = next;
    this.stale = false;
    old.dispose();
  }

  /**
   * Re-render the cubemap into the current target (done automatically after a WebGL context
   * restore, which leaves the texture empty). Abandons any in-flight generation.
   */
  async regenerate(): Promise<void> {
    if (this.disposed) return;
    const token = ++this.generationToken;
    this.stale = true;
    // after a context restore every program is gone: compile without blocking first
    await precompileScenes(this.renderer, [this.genScene, this.passScene], this.faceCameras()[0], this.target);
    if (this.disposed || token !== this.generationToken) return;
    if (await this.generate(this.target, token)) this.stale = false;
  }

  dispose(): void {
    this.disposed = true;
    this.generationToken++;
    this.canvas?.removeEventListener('webglcontextrestored', this.onContextRestored, false);
    this.target.dispose();
    this.genMaterial.dispose();
    this.genGeometry.dispose();
    this.passMaterial.dispose();
    // fullscreenTriangle() is shared by every full-screen pass: never dispose it here.
  }

  // -------------------------------------------------------------------------------------------

  private readonly onContextRestored = (): void => {
    // before init() there is nothing to restore: init generates the cube itself
    if (!this.initPromise || this.disposed) return;
    this.regenerate().catch(() => {
      /* the next restore or quality change retries; the sky stays dark meanwhile */
    });
  };

  private faceCameras(): THREE.PerspectiveCamera[] {
    const cc = this.cubeCamera;
    if (cc.coordinateSystem !== this.renderer.coordinateSystem) {
      cc.coordinateSystem = this.renderer.coordinateSystem;
      cc.updateCoordinateSystem();
    }
    return cc.children as THREE.PerspectiveCamera[];
  }

  /**
   * Render all six faces in scissored tiles, yielding to the browser after each face so the
   * loading screen stays responsive. Mipmaps are generated once, by the final tile's draw.
   * Returns false if abandoned (quality changed again or disposed).
   */
  private async generate(target: THREE.WebGLCubeRenderTarget, token: number): Promise<boolean> {
    const size = target.width;
    const tiles = Math.max(1, Math.ceil(size / MAX_TILE));
    const step = Math.ceil(size / tiles);
    const faces = this.faceCameras();
    const texture = target.texture;
    this.genMaterial.uniforms.uTexelAngle.value = 2 * Math.atan(1 / size);

    texture.generateMipmaps = false;
    try {
      for (let face = 0; face < 6; face++) {
        for (let ty = 0; ty < tiles; ty++) {
          for (let tx = 0; tx < tiles; tx++) {
            if (this.disposed || token !== this.generationToken) return false;
            const last = face === 5 && ty === tiles - 1 && tx === tiles - 1;
            if (last) texture.generateMipmaps = true;
            const x = tx * step;
            const y = ty * step;
            target.scissor.set(x, y, Math.min(step, size - x), Math.min(step, size - y));
            target.scissorTest = tiles > 1;
            this.drawFace(target, face, faces[face]);
          }
        }
        this.renderer.getContext().flush();
        if (face < 5) await yieldToBrowser();
      }
    } finally {
      texture.generateMipmaps = true;
      target.scissor.set(0, 0, size, size);
      target.scissorTest = false;
    }
    return true;
  }

  private drawFace(target: THREE.WebGLCubeRenderTarget, face: number, camera: THREE.Camera): void {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevFace = r.getActiveCubeFace();
    const prevMip = r.getActiveMipmapLevel();
    const prevAutoClear = r.autoClear;
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.autoClear = false;
    try {
      r.setRenderTarget(target, face);
      r.render(this.genScene, camera);
    } finally {
      r.setRenderTarget(prevTarget, prevFace, prevMip);
      r.autoClear = prevAutoClear;
      r.xr.enabled = prevXr;
    }
  }
}
