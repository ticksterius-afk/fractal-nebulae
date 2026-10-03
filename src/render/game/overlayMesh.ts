/**
 * Plumbing shared by the overlay layers (LineSystem, GlyphSprites, GameStars):
 *
 *  - InstancedLayer: one instanced unit quad whose per-instance data lives in a single interleaved
 *    Float32 buffer sized to a capacity (one bufferSubData of the used range per frame, no per-frame
 *    allocation), drawn by two meshes that share the geometry — the visible pass and the occluded pass.
 *  - Two-pass occlusion materials: identical shaders (so three links ONE program for both) with
 *    depthFunc LessEqual (in front of structure, full intensity) and Greater (behind it, × uAlpha =
 *    overlay.occludedAlpha). Both test against the shared scene log depth and write none; additive,
 *    destination alpha untouched (the sprite-layer contract of stars/sprites.ts).
 */
import * as THREE from 'three';
import { createSpriteGeometry, createSpriteMesh, type UniformMap } from '../stars/sprites';

export interface AttribSpec {
  name: string;
  size: number;
}

/** Visible-pass and occluded-pass depth functions. */
export const PASS_DEPTH = [THREE.LessEqualDepth, THREE.GreaterDepth] as const;

/** Additive overlay material (one of the two occlusion passes). `uniforms` must hold its own uAlpha. */
export function createOverlayMaterial(
  name: string,
  vertexShader: string,
  fragmentShader: string,
  uniforms: UniformMap,
  depthFunc: THREE.DepthModes,
): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    name,
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    premultipliedAlpha: false,
    toneMapped: false,
  });
  m.depthFunc = depthFunc;
  return m;
}

export class InstancedLayer {
  readonly stride: number;
  /** [visible pass, occluded pass]; both share `geometry`. */
  readonly meshes: [THREE.Mesh, THREE.Mesh];
  capacity = 0;
  /** Instances written this frame. */
  count = 0;
  data: Float32Array = new Float32Array(0);
  private geometry: THREE.InstancedBufferGeometry | null = null;
  private buffer: THREE.InstancedInterleavedBuffer | null = null;
  private readonly range = { start: 0, count: 0 };

  constructor(
    private readonly specs: readonly AttribSpec[],
    materials: [THREE.Material, THREE.Material],
    capacity: number,
  ) {
    let stride = 0;
    for (const s of specs) stride += s.size;
    this.stride = stride;
    const g = this.build(Math.max(1, capacity));
    this.meshes = [createSpriteMesh(g, materials[0]), createSpriteMesh(g, materials[1])];
    this.setCount(0);
  }

  /** Grow (never shrink) to hold `n` instances. Allocates: call from setup, not per frame. */
  ensureCapacity(n: number): void {
    if (!(n > this.capacity)) return;
    const old = this.geometry;
    const g = this.build(Math.ceil(n));
    this.meshes[0].geometry = g;
    this.meshes[1].geometry = g;
    old?.dispose();
    this.setCount(0);
  }

  /** Publish `n` instances written into `data` this frame (uploads only that range). */
  commit(n: number): void {
    const buf = this.buffer;
    if (buf && n > 0) {
      // One persistent range object instead of addUpdateRange() (which allocates one per call);
      // three empties updateRanges (length = 0) after each upload.
      const ranges = buf.updateRanges;
      if (ranges.length !== 1 || ranges[0] !== this.range) {
        ranges.length = 0;
        ranges.push(this.range);
      }
      this.range.count = n * this.stride;
      buf.needsUpdate = true;
    }
    this.setCount(n);
  }

  setCount(n: number): void {
    this.count = n;
    if (this.geometry) this.geometry.instanceCount = n;
    this.meshes[0].visible = n > 0;
    this.meshes[1].visible = n > 0;
  }

  dispose(): void {
    this.geometry?.dispose();
    this.geometry = null;
    this.buffer = null;
  }

  private build(capacity: number): THREE.InstancedBufferGeometry {
    const data = new Float32Array(capacity * this.stride);
    const buf = new THREE.InstancedInterleavedBuffer(data, this.stride, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    const g = createSpriteGeometry(0);
    let offset = 0;
    for (const s of this.specs) {
      g.setAttribute(s.name, new THREE.InterleavedBufferAttribute(buf, s.size, offset));
      offset += s.size;
    }
    this.data = data;
    this.buffer = buf;
    this.geometry = g;
    this.capacity = capacity;
    return g;
  }
}
