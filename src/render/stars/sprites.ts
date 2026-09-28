import * as THREE from 'three';
import {
  applyCameraUniforms,
  applySkyUniforms,
  makeCameraUniforms,
  makeSkyUniforms,
  type RenderContext,
} from '../RenderContext';
import { sanitizeSkyUniforms } from '../sky/uniformGuards';
import { REF_PIXEL_ANGLE, SPRITE_FRAG, SPRITE_VERT_PREFIX } from './spriteShader';

export type UniformMap = Record<string, THREE.IUniform>;

/**
 * Uniform objects shared (by reference) between every sprite material, so one update per
 * frame reaches all of them: camera + sky uniforms and the reference-pixel scale.
 */
export function makeSharedSpriteUniforms(): UniformMap {
  return { ...makeCameraUniforms(), ...makeSkyUniforms(), uPxScale: { value: 1 } };
}

export function applySharedSpriteUniforms(u: UniformMap, ctx: RenderContext): void {
  applyCameraUniforms(u, ctx);
  applySkyUniforms(u, ctx); // uSkyCube is declared by SKY_SAMPLE_GLSL but never sampled here
  sanitizeSkyUniforms(u);
  const pa = ctx.pixelAngle > 1e-9 && Number.isFinite(ctx.pixelAngle) ? ctx.pixelAngle : REF_PIXEL_ANGLE;
  u.uPxScale.value = REF_PIXEL_ANGLE / pa;
}

/** A unit quad (corners in {-1,1}², two triangles) instanced `count` times. */
export function createSpriteGeometry(count: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = count;
  // Sprites are placed in the vertex shader; bounds are irrelevant (meshes are never culled).
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Number.POSITIVE_INFINITY);
  return g;
}

export function addInstanced(
  g: THREE.InstancedBufferGeometry,
  name: string,
  data: Float32Array,
  itemSize: number,
  dynamic = false,
): THREE.InstancedBufferAttribute {
  const attr = new THREE.InstancedBufferAttribute(data, itemSize);
  if (dynamic) attr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute(name, attr);
  return attr;
}

/** Additive sprite material: out = src + dst for colour, destination alpha untouched. */
export function createSpriteMaterial(
  name: string,
  vertexMain: string,
  uniforms: UniformMap,
  depthTest: boolean,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name,
    vertexShader: `${SPRITE_VERT_PREFIX}\n${vertexMain}`,
    fragmentShader: SPRITE_FRAG,
    uniforms,
    transparent: true,
    depthTest,
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
}

export function createSpriteMesh(g: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** fract() for doubles (always in [0, 1)). */
export function fract(x: number): number {
  const r = x - Math.floor(x);
  return r >= 1 ? 0 : r;
}
