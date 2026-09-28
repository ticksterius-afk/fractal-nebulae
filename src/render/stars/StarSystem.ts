/**
 * Every star-like thing in the scene:
 *   renderFar  → stars at infinity (after the sky, before the nebulae; no depth test)
 *   renderNear → parallax star field, dust motes and nebula stars (after the nebulae;
 *                log-depth tested against fractal surfaces, additive, no depth writes)
 * Both draw into the currently bound render target and restore renderer.autoClear.
 */
import * as THREE from 'three';
import type { NebulaRuntime, QualityPreset, RGB } from '../../core/types';
import type { RenderContext } from '../RenderContext';
import { precompileScenes } from '../sky/precompile';
import { DustMotes } from './DustMotes';
import { FarStars } from './FarStars';
import { NearStars } from './NearStars';
import { NebulaStars } from './NebulaStars';
import { applySharedSpriteUniforms, makeSharedSpriteUniforms, type UniformMap } from './sprites';

/**
 * Exposure time of the streaks (s): a streak spans velocity × shutter, so its length does
 * not depend on the frame rate. At cruise it is a subtle smear; under hyper, warp lines.
 */
const SHUTTER_SECONDS = 1 / 75;
/** Longest streak as a fraction of the render-target height. */
const MAX_STREAK_FRACTION = 0.22;
/** Dust tint in the void (cool neutral grey-blue), luminance ≈ 1. */
const VOID_TINT = new THREE.Vector3(0.78, 0.98, 1.35);

const _tint = new THREE.Vector3();
const _near = new THREE.Vector3();
const _far = new THREE.Vector3();

function setRGB(v: THREE.Vector3, c: RGB): THREE.Vector3 {
  return v.set(c[0], c[1], c[2]);
}

export class StarSystem {
  private quality: QualityPreset;
  private readonly byId = new Map<string, NebulaRuntime>();
  private readonly shared: UniformMap = makeSharedSpriteUniforms();
  private readonly farScene = new THREE.Scene();
  private readonly nearScene = new THREE.Scene();
  private far: FarStars;
  private near: NearStars;
  private dust: DustMotes;
  private readonly nebulaStars: NebulaStars;
  private readonly streak = new THREE.Vector3();
  private readonly dustTint = new THREE.Vector3().copy(VOID_TINT);

  constructor(quality: QualityPreset, nebulae: NebulaRuntime[]) {
    this.quality = quality;
    for (const n of nebulae) this.byId.set(n.def.id, n);
    for (const s of [this.farScene, this.nearScene]) s.matrixWorldAutoUpdate = false;

    this.far = new FarStars(quality.farStarCount, this.shared);
    this.near = new NearStars(quality.localStarCount, this.shared);
    this.dust = new DustMotes(quality.dustCount, this.shared);
    this.nebulaStars = new NebulaStars(nebulae, this.shared);
    this.farScene.add(this.far.mesh);
    this.nearScene.add(this.near.mesh, ...this.dust.meshes, this.nebulaStars.mesh);
  }

  /** Stars at infinity, drawn right after the sky. */
  renderFar(renderer: THREE.WebGLRenderer, ctx: RenderContext): void {
    applySharedSpriteUniforms(this.shared, ctx);
    this.draw(renderer, this.farScene, ctx.camera);
  }

  /** Parallax stars, dust motes and nebula stars, drawn after the nebula passes. */
  renderNear(renderer: THREE.WebGLRenderer, ctx: RenderContext): void {
    applySharedSpriteUniforms(this.shared, ctx);
    const state = ctx.state;
    const ship = state.ship.position;
    if (Number.isFinite(ship.x) && Number.isFinite(ship.y) && Number.isFinite(ship.z)) {
      const dt = Number.isFinite(state.dt) ? Math.min(Math.max(state.dt, 0), 0.25) : 0;
      const v = state.ship.velocity;
      const shutter = state.paused ? 0 : SHUTTER_SECONDS;
      this.streak.set(v.x * shutter, v.y * shutter, v.z * shutter);
      if (!Number.isFinite(this.streak.x + this.streak.y + this.streak.z)) this.streak.set(0, 0, 0);
      const maxStreakPx = Math.max(4, MAX_STREAK_FRACTION * ctx.resolution.y);

      const weight = this.regionTint(state.env.regionId, state.env.weights, this.dustTint);
      this.near.update(ctx, this.streak, maxStreakPx);
      this.dust.update(ctx, dt, this.streak, maxStreakPx, this.dustTint, weight);
      this.nebulaStars.update(ctx, this.streak, maxStreakPx);
    }
    this.draw(renderer, this.nearScene, ctx.camera);
  }

  /** Rebuilds only the groups whose counts changed. */
  setQuality(q: QualityPreset): void {
    const prev = this.quality;
    this.quality = q;
    if (q.farStarCount !== prev.farStarCount) {
      this.farScene.remove(this.far.mesh);
      this.far.dispose();
      this.far = new FarStars(q.farStarCount, this.shared);
      this.farScene.add(this.far.mesh);
    }
    if (q.localStarCount !== prev.localStarCount) {
      this.nearScene.remove(this.near.mesh);
      this.near.dispose();
      this.near = new NearStars(q.localStarCount, this.shared);
      this.nearScene.add(this.near.mesh);
    }
    if (q.dustCount !== prev.dustCount) {
      this.nearScene.remove(...this.dust.meshes);
      this.dust.dispose();
      this.dust = new DustMotes(q.dustCount, this.shared);
      this.nearScene.add(...this.dust.meshes);
    }
  }

  /**
   * Optional: compile all sprite programs without blocking (call during loading). `target`
   * should be the scene render target (HalfFloat); a 1×1 stand-in is used when omitted.
   */
  async compile(renderer: THREE.WebGLRenderer, camera: THREE.Camera, target?: THREE.WebGLRenderTarget): Promise<void> {
    const temp = target ? null : new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    try {
      await precompileScenes(renderer, [this.farScene, this.nearScene], camera, target ?? temp);
    } finally {
      temp?.dispose();
    }
  }

  dispose(): void {
    this.far.dispose();
    this.near.dispose();
    this.dust.dispose();
    this.nebulaStars.dispose();
    this.farScene.clear();
    this.nearScene.clear();
  }

  // -------------------------------------------------------------------------------------------

  private draw(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(scene, camera);
    renderer.autoClear = autoClear;
  }

  /**
   * Dust tint for the current region: its gas colours (mostly the wide envelope, some of the
   * surface glow), luminance-normalized and softened, blended toward the void tint by the
   * region's influence. Returns that influence (0 in the void).
   */
  private regionTint(regionId: string | null, weights: Record<string, number>, out: THREE.Vector3): number {
    const neb = regionId ? this.byId.get(regionId) : undefined;
    if (!neb || !regionId) {
      out.copy(VOID_TINT);
      return 0;
    }
    const wRaw = weights[regionId];
    const w = Math.min(Math.max(Number.isFinite(wRaw) ? wRaw : neb.influence, 0), 1);
    const p = neb.def.palette;
    _tint.copy(setRGB(_far, p.glowFar)).multiplyScalar(0.65).addScaledVector(setRGB(_near, p.glowNear), 0.35);
    const lum = 0.2126 * _tint.x + 0.7152 * _tint.y + 0.0722 * _tint.z;
    if (lum > 1e-6) _tint.multiplyScalar(1 / lum);
    else _tint.set(1, 1, 1);
    _tint.lerp(_near.set(1, 1, 1), 0.2);
    const s = w * w * (3 - 2 * w);
    out.copy(VOID_TINT).lerp(_tint, s);
    return w;
  }
}
