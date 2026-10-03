/**
 * Overlay glyphs: converts a GlyphBuffer (LOCAL, doubles) into camera-relative instanced SDF
 * markers every frame (see glyphShader.ts), and owns the two occlusion-pass meshes.
 */
import * as THREE from 'three';
import { GLYPH_SHAPE, GlyphBuffer } from './overlayTypes';
import type { UniformMap } from '../stars/sprites';
import type { LocalFrame } from './LocalFrame';
import { GLYPH_FRAG, GLYPH_VERT } from './glyphShader';
import { InstancedLayer, PASS_DEPTH, createOverlayMaterial } from './overlayMesh';

/** Instance layout (Float32, interleaved). */
const ATTRIBS = [
  { name: 'aPos', size: 3 },
  { name: 'aGlyph', size: 4 },
  { name: 'aColor', size: 4 },
  { name: 'aLine', size: 1 },
] as const;
const MAX_SHAPE = Math.max(...Object.values(GLYPH_SHAPE));

export class GlyphSprites {
  readonly materials: [THREE.ShaderMaterial, THREE.ShaderMaterial];
  readonly layer: InstancedLayer;

  constructor(shared: UniformMap, capacity = 1) {
    this.materials = [
      createOverlayMaterial('OverlayGlyphs', GLYPH_VERT, GLYPH_FRAG, { ...shared, uAlpha: { value: 1 } }, PASS_DEPTH[0]),
      createOverlayMaterial('OverlayGlyphsOccluded', GLYPH_VERT, GLYPH_FRAG, { ...shared, uAlpha: { value: 0 } }, PASS_DEPTH[1]),
    ];
    this.layer = new InstancedLayer(ATTRIBS, this.materials, capacity);
  }

  get meshes(): [THREE.Mesh, THREE.Mesh] {
    return this.layer.meshes;
  }

  setOccludedAlpha(a: number): void {
    this.materials[1].uniforms.uAlpha.value = a;
  }

  /** Convert this frame's glyphs; returns the number of instances to draw. */
  update(glyphs: GlyphBuffer, frame: LocalFrame): number {
    const layer = this.layer;
    if (glyphs.count > layer.capacity) layer.ensureCapacity(glyphs.capacity);
    const n = Math.min(glyphs.count, layer.capacity);
    const src = glyphs.data;
    const dst = layer.data;
    const S = GlyphBuffer.STRIDE;
    const D = layer.stride;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const o = i * S;
      let sum = 0;
      for (let j = 0; j < S; j++) sum += src[o + j];
      const size = src[o + 3];
      const minPx = src[o + 4];
      if (!Number.isFinite(sum) || !(size > 0 || minPx > 0)) continue;
      const d = k * D;
      frame.apply(src[o], src[o + 1], src[o + 2]);
      dst[d] = frame.rx;
      dst[d + 1] = frame.ry;
      dst[d + 2] = frame.rz;
      dst[d + 3] = Math.max(size, 0) * frame.scale; // world radius (ly)
      dst[d + 4] = Math.min(Math.max(minPx, 0), 512);
      dst[d + 5] = Math.min(Math.max(Math.round(src[o + 5]), 0), MAX_SHAPE);
      dst[d + 6] = Math.max(src[o + 11], 0); // phase
      dst[d + 7] = Math.max(src[o + 6], 0);
      dst[d + 8] = Math.max(src[o + 7], 0);
      dst[d + 9] = Math.max(src[o + 8], 0);
      dst[d + 10] = src[o + 9]; // fill (clamped in the shader)
      dst[d + 11] = src[o + 10]; // outline thickness (clamped in the shader)
      k++;
    }
    layer.commit(k);
    return k;
  }

  dispose(): void {
    this.layer.dispose();
    this.materials[0].dispose();
    this.materials[1].dispose();
  }
}
