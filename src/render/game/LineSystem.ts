/**
 * Overlay ribbons: converts a LineBuffer (LOCAL, doubles) into camera-relative instanced segments
 * every frame (see lineShader.ts for the drawing), and owns the two occlusion-pass meshes.
 */
import * as THREE from 'three';
import { LINE_STYLE, LineBuffer } from './overlayTypes';
import type { UniformMap } from '../stars/sprites';
import type { LocalFrame } from './LocalFrame';
import { LINE_FRAG, LINE_VERT } from './lineShader';
import { InstancedLayer, PASS_DEPTH, createOverlayMaterial } from './overlayMesh';

/** Instance layout (Float32, interleaved). */
const ATTRIBS = [
  { name: 'aP0', size: 3 },
  { name: 'aP1', size: 3 },
  { name: 'aColor', size: 4 },
  { name: 'aLine', size: 4 },
] as const;
const MAX_STYLE = Math.max(LINE_STYLE.beam, LINE_STYLE.guide, LINE_STYLE.dashed);
/** Endpoints closer than this (LOCAL units) are the same polyline joint. */
const JOINT_EPS = 1e-9;

export class LineSystem {
  readonly materials: [THREE.ShaderMaterial, THREE.ShaderMaterial];
  readonly layer: InstancedLayer;

  constructor(shared: UniformMap, capacity = 1) {
    this.materials = [
      createOverlayMaterial('OverlayLines', LINE_VERT, LINE_FRAG, { ...shared, uAlpha: { value: 1 } }, PASS_DEPTH[0]),
      createOverlayMaterial('OverlayLinesOccluded', LINE_VERT, LINE_FRAG, { ...shared, uAlpha: { value: 0 } }, PASS_DEPTH[1]),
    ];
    this.layer = new InstancedLayer(ATTRIBS, this.materials, capacity);
  }

  get meshes(): [THREE.Mesh, THREE.Mesh] {
    return this.layer.meshes;
  }

  setOccludedAlpha(a: number): void {
    this.materials[1].uniforms.uAlpha.value = a;
  }

  /** Convert this frame's segments; returns the number of instances to draw. */
  update(lines: LineBuffer, frame: LocalFrame): number {
    const layer = this.layer;
    if (lines.count > layer.capacity) layer.ensureCapacity(lines.capacity); // once per larger buffer
    const n = Math.min(lines.count, layer.capacity);
    const src = lines.data;
    const dst = layer.data;
    const S = LineBuffer.STRIDE;
    const D = layer.stride;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const o = i * S;
      if (!segmentValid(src, o)) continue;
      const x0 = src[o];
      const y0 = src[o + 1];
      const z0 = src[o + 2];
      const x1 = src[o + 3];
      const y1 = src[o + 4];
      const z1 = src[o + 5];
      const style = Math.min(Math.max(Math.round(src[o + 11]), 0), MAX_STYLE);
      // Round caps only at polyline ends: a neighbour that continues this segment gets a cross-fade.
      const capStart = i === 0 || !continues(src, o - S, o);
      const capEnd = i === n - 1 || !continues(src, o, o + S);
      const d = k * D;
      frame.apply(x0, y0, z0);
      dst[d] = frame.rx;
      dst[d + 1] = frame.ry;
      dst[d + 2] = frame.rz;
      frame.apply(x1, y1, z1);
      dst[d + 3] = frame.rx;
      dst[d + 4] = frame.ry;
      dst[d + 5] = frame.rz;
      dst[d + 6] = Math.max(src[o + 6], 0);
      dst[d + 7] = Math.max(src[o + 7], 0);
      dst[d + 8] = Math.max(src[o + 8], 0);
      dst[d + 9] = (capStart ? 1 : 0) + (capEnd ? 2 : 0);
      const s0 = src[o + 10];
      dst[d + 10] = Math.min(src[o + 9], 256);
      dst[d + 11] = s0;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dz = z1 - z0;
      dst[d + 12] = s0 + Math.sqrt(dx * dx + dy * dy + dz * dz);
      dst[d + 13] = style;
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

function segmentValid(src: Float64Array, o: number): boolean {
  let sum = 0;
  for (let j = 0; j < LineBuffer.STRIDE; j++) sum += src[o + j];
  return Number.isFinite(sum) && src[o + 9] > 0;
}

/** Does segment `b` (offset) start where segment `a` ends, with the same style (and both valid)? */
function continues(src: Float64Array, a: number, b: number): boolean {
  if (!segmentValid(src, a) || !segmentValid(src, b)) return false;
  if (Math.round(src[a + 11]) !== Math.round(src[b + 11])) return false;
  return (
    Math.abs(src[a + 3] - src[b]) <= JOINT_EPS &&
    Math.abs(src[a + 4] - src[b + 1]) <= JOINT_EPS &&
    Math.abs(src[a + 5] - src[b + 2]) <= JOINT_EPS
  );
}
