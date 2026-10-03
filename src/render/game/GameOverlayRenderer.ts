/**
 * Draws a game mode's OverlayFrame (overlayTypes.ts; design/60-first-light-build.md §R):
 *
 *   prepare()  every frame, before the nebula passes: LOCAL → camera-relative conversion of lines,
 *              glyphs and stars (doubles, into capacity-sized Float32 instance buffers), accent
 *              lights into RenderContext.accents, lenses projected to ScreenLens[] for the composite.
 *   render()   right after stars.renderNear, into the sprite layer (the Renderer binds it even with
 *              TAA off, so the composite's lens warp never touches the overlay; with TAA and lenses
 *              on screen the near stars move to their own, lensed layer and the overlay is alone
 *              in it): the visible pass (LessEqual, full intensity) and the
 *              occluded pass (Greater, × occludedAlpha), both tested against the shared scene log
 *              depth, additive, no depth writes.
 *
 * Allocation-free per frame; every value bound for the GPU is NaN-guarded.
 */
import * as THREE from 'three';
import type { NebulaRuntime } from '../../core/types';
import { TUNING } from '../../app/config';
import type { RenderContext } from '../RenderContext';
import { precompileScenes } from '../sky/precompile';
import { applySharedSpriteUniforms, makeSharedSpriteUniforms, fract, type UniformMap } from '../stars/sprites';
import { AccentBuffer, LensBuffer, type AccentLights, type OverlayFrame, type ScreenLens } from './overlayTypes';
import { LocalFrame } from './LocalFrame';
import { LineSystem } from './LineSystem';
import { GlyphSprites } from './GlyphSprites';
import { GameStars } from './GameStars';
import { GLYPH_BREATH_HZ } from './glyphShader';

/** Beam flow (design §R): pulse period and speed in units of the overlay's flow scale R. */
const FLOW_PERIOD = 0.06;
const FLOW_SPEED = 0.12;
/** Dash + gap length of dashed guides, in units of R. */
const DASH_PERIOD = 0.03;
/** Without overlay.flowScale: R = this × the nebula's bound radius (LOCAL). */
const FLOW_SCALE_FALLBACK = 0.3;
/** Capture cross-section radius b_c = (3√3/2)·ρ (photon-sphere impact parameter). */
const SHADOW_K = (3 * Math.sqrt(3)) / 2;
/**
 * Einstein radius as a fraction of the physical one (√(2ρ/D) for a background at infinity). The full
 * value bends ~4.7 shadow radii of nebula around every mass, which reads as spectacle but hides the
 * puzzle; 0.55 keeps the ring clearly lensed (~2.6 shadow radii) while the shadow stays exact.
 */
const LENS_EINSTEIN_GAIN = 0.55;
/** Cap on the off-axis growth D/viewZ of a lens's screen size. */
const LENS_OFFAXIS_MAX = 1.5;
/** Lens radii are clamped to this many image heights (a camera right beside a mass). */
const LENS_RADIUS_MAX = 4;
/** Below this (fraction of the image height, ≈ 0.15 px at 1440p) a lens is invisible: skipped. */
const LENS_RADIUS_MIN = 1e-4;
/** A lens whose screen position is farther off-image than this × its radius warps nothing visible. */
const LENS_REACH = 6;

const LOG_DEPTH_SCALE = 1 / Math.log2(1 + TUNING.depthFar / TUNING.depthNear);
/** CPU mirror of COMMON_GLSL logDepth (window-space depth 0..1). */
function logDepth01(viewZ: number): number {
  const z = Math.max(viewZ, TUNING.depthNear);
  return Math.min(Math.max(Math.log2(1 + z / TUNING.depthNear) * LOG_DEPTH_SCALE, 0), 1);
}

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0); // NaN → 0
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export class GameOverlayRenderer {
  /** Screen-space lenses of this frame (first `lensCount` valid), for CompositePass.setLenses. */
  readonly lenses: ScreenLens[] = [];
  lensCount = 0;

  private frame: OverlayFrame | null = null;
  private readonly shared: UniformMap;
  private readonly lines: LineSystem;
  private readonly glyphs: GlyphSprites;
  private readonly stars: GameStars;
  private readonly visibleScene = new THREE.Scene();
  private readonly occludedScene = new THREE.Scene();
  private readonly local = new LocalFrame();
  /** Last resolved nebula (avoids a search per frame while the id is unchanged). */
  private neb: NebulaRuntime | null = null;
  private drawVisible = false;
  private drawOccluded = false;

  constructor() {
    this.shared = {
      ...makeSharedSpriteUniforms(),
      uFlowPeriod: { value: 1 },
      uFlowPhase: { value: 0 },
      uDashPeriod: { value: 1 },
      uBreath: { value: 0 },
    };
    this.lines = new LineSystem(this.shared);
    this.glyphs = new GlyphSprites(this.shared);
    this.stars = new GameStars(this.shared);
    for (const s of [this.visibleScene, this.occludedScene]) s.matrixWorldAutoUpdate = false;
    this.visibleScene.add(this.lines.meshes[0], this.glyphs.meshes[0], this.stars.meshes[0]);
    this.occludedScene.add(this.lines.meshes[1], this.glyphs.meshes[1], this.stars.meshes[1]);
    for (let i = 0; i < LensBuffer.MAX; i++) {
      this.lenses.push({ u: 0.5, v: 0.5, einstein: 0, shadow: 0, depth01: 1, strength: 0, glow: 0 });
    }
  }

  /** The overlay to draw (null = none). Sizes the instance buffers to its capacities (allocates). */
  setFrame(frame: OverlayFrame | null): void {
    this.frame = frame;
    this.neb = null;
    if (!frame) return;
    this.lines.layer.ensureCapacity(frame.lines.capacity);
    this.glyphs.layer.ensureCapacity(frame.glyphs.capacity);
    this.stars.layer.ensureCapacity(frame.stars.capacity);
  }

  /** Something will be drawn by render() this frame. */
  get active(): boolean {
    return this.drawVisible;
  }

  /**
   * Per frame, after the camera and context are built and before the nebula passes (which read
   * ctx.accents). `show` = false (no scene this frame) draws nothing and clears lenses/accents.
   */
  prepare(ctx: RenderContext, nebulae: readonly NebulaRuntime[], show: boolean): void {
    this.reset(ctx);
    const f = this.frame;
    if (!f || !show || !f.visible || !f.nebulaId) return;
    const neb = this.resolve(nebulae, f.nebulaId);
    if (!neb || !this.local.set(neb, ctx.state.ship.position)) return;

    this.fillAccents(f.accents, ctx.accents, f.nebulaId);
    this.projectLenses(f.lenses, ctx);

    applySharedSpriteUniforms(this.shared, ctx);
    const u = this.shared;
    const fs = f.flowScale;
    const boundLocal = neb.boundRadiusWorld / neb.scale;
    let R = fs !== undefined && fs > 0 && Number.isFinite(fs) ? fs : FLOW_SCALE_FALLBACK * boundLocal;
    if (!(R > 0) || !Number.isFinite(R)) R = 1;
    const time = Number.isFinite(f.time) ? f.time : 0;
    u.uFlowPeriod.value = FLOW_PERIOD * R;
    u.uFlowPhase.value = fract((time * FLOW_SPEED) / FLOW_PERIOD); // cycles: R cancels out
    u.uDashPeriod.value = DASH_PERIOD * R;
    u.uBreath.value = fract(time * GLYPH_BREATH_HZ);

    const nLines = this.lines.update(f.lines, this.local);
    const nGlyphs = this.glyphs.update(f.glyphs, this.local);
    const nStars = this.stars.update(f.stars, this.local);
    this.drawVisible = nLines + nGlyphs + nStars > 0;
    const occ = clamp01(f.occludedAlpha);
    this.lines.setOccludedAlpha(occ);
    this.glyphs.setOccludedAlpha(occ);
    this.stars.setOccludedAlpha(occ);
    this.drawOccluded = this.drawVisible && occ > 0.002;
  }

  /** Draw into the currently bound target (does not clear; restores renderer.autoClear). */
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    if (!this.drawVisible) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.render(this.visibleScene, camera);
      if (this.drawOccluded) renderer.render(this.occludedScene, camera);
    } finally {
      renderer.autoClear = autoClear;
    }
  }

  /** Compile both passes' programs without blocking (during loading / after a context restore). */
  async compile(renderer: THREE.WebGLRenderer, camera: THREE.Camera, target: THREE.WebGLRenderTarget): Promise<void> {
    await precompileScenes(renderer, [this.visibleScene, this.occludedScene], camera, target);
  }

  dispose(): void {
    this.lines.dispose();
    this.glyphs.dispose();
    this.stars.dispose();
    this.visibleScene.clear();
    this.occludedScene.clear();
    this.frame = null;
    this.neb = null;
  }

  /** Nothing to draw, no lenses, no accents (also the recovery path after an exception). */
  reset(ctx: RenderContext): void {
    this.drawVisible = false;
    this.drawOccluded = false;
    this.lensCount = 0;
    ctx.accents.count = 0;
    ctx.accents.nebulaId = null;
  }

  // -------------------------------------------------------------------------------------------

  private resolve(nebulae: readonly NebulaRuntime[], id: string): NebulaRuntime | null {
    const cached = this.neb;
    if (cached && cached.def.id === id && nebulae[cached.index] === cached) return cached;
    this.neb = null;
    for (let i = 0; i < nebulae.length; i++) {
      if (nebulae[i].def.id === id) {
        this.neb = nebulae[i];
        break;
      }
    }
    return this.neb;
  }

  /** Overlay accents → RenderContext.accents (LOCAL xyz + radius, linear HDR colour). */
  private fillAccents(src: AccentBuffer, out: AccentLights, nebulaId: string): void {
    const d = src.data;
    const n = Math.min(src.count, AccentBuffer.MAX, out.posRadius.length >> 2, out.colour.length >> 2);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const o = i * AccentBuffer.STRIDE;
      const rad = d[o + 3];
      const r = Math.max(d[o + 4], 0);
      const g = Math.max(d[o + 5], 0);
      const b = Math.max(d[o + 6], 0);
      if (!Number.isFinite(d[o] + d[o + 1] + d[o + 2] + rad + r + g + b) || !(rad > 0) || !(r + g + b > 0)) continue;
      const p = k * 4;
      out.posRadius[p] = d[o];
      out.posRadius[p + 1] = d[o + 1];
      out.posRadius[p + 2] = d[o + 2];
      out.posRadius[p + 3] = rad;
      out.colour[p] = r;
      out.colour[p + 1] = g;
      out.colour[p + 2] = b;
      out.colour[p + 3] = 0;
      k++;
    }
    out.count = k;
    out.nebulaId = k > 0 ? nebulaId : null;
  }

  /**
   * Overlay lenses → ScreenLens (uv of the output image, y up; radii as fractions of its height).
   * θ_E = 0.55·√(2ρ/D) (LENS_EINSTEIN_GAIN; source at infinity), shadow b_c/D = 2.598·ρ/D, both scaled by D/viewZ (capped at LENS_OFFAXIS_MAX) — the
   * tangential magnification of the projection, the same size rule as glyphs (size / viewZ).
   * Lenses behind the camera or far off-image are skipped; the camera inside a capture sphere
   * fades the lens out instead of blacking out the view.
   */
  private projectLenses(src: LensBuffer, ctx: RenderContext): void {
    const d = src.data;
    const L = this.local;
    const e = ctx.camRot.elements; // camera local→world, column-major: columns = right, up, back
    const tx = ctx.tanHalf.x;
    const ty = ctx.tanHalf.y;
    const aspect = tx / ty;
    const n = Math.min(src.count, LensBuffer.MAX);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const o = i * LensBuffer.STRIDE;
      const rho = d[o + 3] * L.scale;
      const strength0 = clamp01(d[o + 4]);
      if (!(rho > 0) || !Number.isFinite(rho) || !(strength0 > 0)) continue;
      L.apply(d[o], d[o + 1], d[o + 2]);
      const rx = L.rx;
      const ry = L.ry;
      const rz = L.rz;
      const vx = rx * e[0] + ry * e[1] + rz * e[2];
      const vy = rx * e[3] + ry * e[4] + rz * e[5];
      const viewZ = -(rx * e[6] + ry * e[7] + rz * e[8]);
      const D = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (!(D > 0) || !(viewZ > 1e-6 * D) || !Number.isFinite(D + vx + vy + viewZ)) continue;
      const strength = strength0 * smoothstep(SHADOW_K * rho, 2.5 * SHADOW_K * rho, D);
      if (!(strength > 0)) continue;
      // D/viewZ sizes a lens like a glyph; capped so a mass beside the camera cannot warp the whole view.
      const toHeight = Math.min(D / viewZ, LENS_OFFAXIS_MAX) / (2 * ty);
      const einstein = Math.min(LENS_EINSTEIN_GAIN * Math.sqrt((2 * rho) / D) * toHeight, LENS_RADIUS_MAX);
      const shadow = Math.min(((SHADOW_K * rho) / D) * toHeight, LENS_RADIUS_MAX);
      const reach = Math.max(einstein, shadow);
      if (!(reach > LENS_RADIUS_MIN)) continue;
      const u = 0.5 + (0.5 * vx) / (viewZ * tx);
      const v = 0.5 + (0.5 * vy) / (viewZ * ty);
      const offX = Math.max(Math.abs(u - 0.5) - 0.5, 0) * aspect;
      const offY = Math.max(Math.abs(v - 0.5) - 0.5, 0);
      if (!(Math.hypot(offX, offY) <= LENS_REACH * reach + 0.02)) continue; // also rejects NaN
      const s = this.lenses[k++];
      s.u = u;
      s.v = v;
      s.einstein = einstein;
      s.shadow = shadow;
      s.depth01 = logDepth01(viewZ);
      s.strength = strength;
      s.glow = clamp01(d[o + 5]);
    }
    this.lensCount = k;
  }
}
