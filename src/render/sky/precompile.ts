import * as THREE from 'three';

/**
 * Upper bound on waiting for background compilation. three's compileAsync polls program
 * readiness forever, and never resolves if the context is lost mid-compile; after this long
 * we proceed anyway (at worst the first draw finishes the compile synchronously).
 */
const COMPILE_TIMEOUT_MS = 20000;

/**
 * Compile the programs of `scenes` without blocking (KHR_parallel_shader_compile when
 * available). three captures program parameters (output colour space etc.) from the render
 * target bound at compile time, so `target` should be a render target of the kind the scenes
 * will really draw into; otherwise the first real draw would compile a second variant.
 */
export async function precompileScenes(
  renderer: THREE.WebGLRenderer,
  scenes: THREE.Object3D[],
  camera: THREE.Camera,
  target: THREE.WebGLRenderTarget | null,
): Promise<void> {
  const prevTarget = renderer.getRenderTarget();
  const prevFace = renderer.getActiveCubeFace();
  const prevMip = renderer.getActiveMipmapLevel();
  let pending: Promise<unknown>[] = [];
  try {
    renderer.setRenderTarget(target);
    pending = scenes.map((s) => renderer.compileAsync(s, camera));
  } finally {
    renderer.setRenderTarget(prevTarget, prevFace, prevMip);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, COMPILE_TIMEOUT_MS);
  });
  try {
    await Promise.race([Promise.all(pending), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
