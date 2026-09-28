/**
 * Render core: camera-relative HDR scene (sky → far stars → nebula raymarch passes far→near →
 * near stars) into a dynamically-scaled half-float target (+ log-depth texture), then bloom,
 * the TAAU resolve to output resolution (see post/TaaPass.ts) and the final composite.
 * With TAA the near stars go to a separate sprite layer that bypasses the history (see spriteRT).
 */
import * as THREE from 'three';
import type { NebulaRuntime, QualityName, QualityPreset, SimState } from '../core/types';
import { TUNING } from '../app/config';
import { clamp, damp } from '../core/math';
import { fullscreenTriangle, type RenderContext } from './RenderContext';
import { SkySystem } from './sky/SkySystem';
import { StarSystem } from './stars/StarSystem';
import { createBlackHoleMaterial, updateBlackHoleUniforms } from '../fractals/blackhole/BlackHoleMaterial';
import {
  createNebulaMaterial,
  disposeNebulaShared,
  nebulaMaterialKey,
  prepareNebulaShared,
  updateNebulaUniforms,
} from './NebulaMaterial';
import { BloomPass } from './post/BloomPass';
import { CompositePass, type CompositeParams } from './post/CompositePass';
import { FULLSCREEN_CAMERA, makeSceneTarget, makeSpriteTarget } from './post/FullscreenPass';
import { TaaPass, taaJitter, type TaaFrame } from './post/TaaPass';

interface NebulaPass {
  neb: NebulaRuntime;
  isBlackHole: boolean;
  material: THREE.ShaderMaterial;
  mesh: THREE.Mesh;
  /** Program signature (quality-dependent defines). */
  key: string;
  /** Progress label shown while compiling. */
  label: string;
  // ---- per frame ----
  dist: number;
  full: boolean;
  rect: THREE.Vector4;
}

export interface RenderStats {
  fps: number;
  frameMs: number;
  renderScale: number;
}

const SCALE_QUANTUM = 0.025;
const RESIZE_INTERVAL_MS = 400;
const RAISE_AFTER_MS = 750;
/**
 * With a GPU timer, also raise the resolution while the GPU needs less than this fraction of the
 * frame budget. Frame intervals alone can never show headroom on a display whose refresh interval
 * is ≥ 0.8 × target (a 60 Hz panel pins them at 16.7 ms), so the scale could only ever go down.
 */
const GPU_RAISE_FRACTION = 0.62;
/** three's compileAsync polls forever if the context is lost mid-compile: stop waiting after this. */
const COMPILE_TIMEOUT_MS = 20000;
const HALF_PI = Math.PI / 2 - 1e-6;
/** TAAU on by default per preset (low stays on the simplest path). */
const TAA_DEFAULT: Record<QualityName, boolean> = { low: false, medium: true, high: true, ultra: true };
/** With TAAU the dynamic resolution may drop this much below the preset minimum. */
const TAA_SCALE_MIN_DROP = 0.05;
/** Composite unsharp amount on the resolved image: base + slope × (upscale factor − 1). */
const TAA_SHARPEN_BASE = 0.18;
const TAA_SHARPEN_SLOPE = 0.22;
const TAA_SHARPEN_MAX = 0.4;

const quantize = (s: number) => Math.round(s / SCALE_QUANTUM) * SCALE_QUANTUM;
const finite3 = (v: { x: number; y: number; z: number }) => Number.isFinite(v.x + v.y + v.z);
const yieldToBrowser = () => new Promise<void>((res) => setTimeout(res, 0));

interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/**
 * GPU time of whole frames via EXT_disjoint_timer_query_webgl2 (results arrive a few frames late).
 * Inert when the extension is unavailable. three.js issues no queries of its own.
 */
class GpuFrameTimer {
  private ext: TimerQueryExt | null = null;
  private readonly free: WebGLQuery[] = [];
  private readonly inFlight: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.reset();
  }

  dispose(): void {
    if (this.active && this.ext) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    for (const q of this.free) this.gl.deleteQuery(q);
    for (const q of this.inFlight) this.gl.deleteQuery(q);
    if (this.active) this.gl.deleteQuery(this.active);
    this.free.length = 0;
    this.inFlight.length = 0;
    this.active = null;
    this.ext = null;
  }

  /** (Re)acquire the extension, e.g. after a context restore invalidated every query object. */
  reset(): void {
    this.free.length = 0;
    this.inFlight.length = 0;
    this.active = null;
    try {
      this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
    } catch {
      this.ext = null;
    }
  }

  begin(): void {
    if (!this.ext || this.active || this.inFlight.length >= 4) return;
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.inFlight.push(this.active);
    this.active = null;
  }

  /** Most recent completed frame's GPU time in ms, or −1 if none completed (or it was disjoint). */
  poll(): number {
    const ext = this.ext;
    if (!ext || this.inFlight.length === 0) return -1;
    const gl = this.gl;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) === true;
    let ms = -1;
    while (this.inFlight.length > 0) {
      const q = this.inFlight[0];
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) !== true) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      if (!disjoint && Number.isFinite(ns) && ns > 0) ms = ns * 1e-6;
      this.inFlight.shift();
      this.free.push(q);
    }
    return ms;
  }
}

/**
 * Projected extent of a sphere along one screen axis, in NDC, from the 2D circle (u = view-space
 * axis coordinate, w = forward depth). Exact tangent-line bounds (Mara & McGuire 2013), valid
 * when the sphere straddles the camera plane. Returns false if the sphere is outside this axis'
 * frustum wedge.
 */
function axisRange(u: number, w: number, r: number, tanHalf: number, out: Float64Array): boolean {
  const d2 = u * u + w * w;
  if (d2 <= r * r) {
    out[0] = -1;
    out[1] = 1;
    return true;
  }
  const d = Math.sqrt(d2);
  const phi = Math.atan2(u, w);
  const alpha = Math.asin(Math.min(1, r / d));
  const lo = phi - alpha;
  const hi = phi + alpha;
  if (lo >= HALF_PI || hi <= -HALF_PI) return false;
  const mn = lo <= -HALF_PI ? -Infinity : Math.tan(lo) / tanHalf;
  const mx = hi >= HALF_PI ? Infinity : Math.tan(hi) / tanHalf;
  out[0] = Math.max(-1, mn);
  out[1] = Math.min(1, mx);
  return out[0] < 1 && out[1] > -1;
}

export class Renderer {
  readonly three: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly stats: RenderStats = { fps: 0, frameMs: 0, renderScale: 1 };

  /** Final composite tunables. */
  exposure = 1.0;
  bloomStrength = 0.68;
  grain = 0.028;
  chromaticAberration = 0.0012;

  private readonly canvas: HTMLCanvasElement;
  private quality: QualityPreset;
  private sky: SkySystem | null = null;
  private stars: StarSystem | null = null;
  private skyReady = false;
  private ready = false;
  /** init() completed (ready may drop again while programs are recompiled after a context restore). */
  private initDone = false;
  private contextLost = false;
  private disposed = false;

  private readonly sceneRT: THREE.WebGLRenderTarget;
  /**
   * With TAA: near stars / dust / nebula stars (renderNear) are drawn here instead of into
   * sceneRT, depth-tested against sceneRT's depth texture (shared). They move with parallax or on
   * their own but write no depth, so the resolve cannot reproject them: accumulated, they would fade
   * to faint smears whenever the ship moves. This layer bypasses the history and is added back in
   * bloom and the composite (the sprites are smooth Gaussians: no anti-aliasing needed).
   * Always the same size as sceneRT.
   */
  private readonly spriteRT: THREE.WebGLRenderTarget;
  private readonly bloom = new BloomPass(6);
  private readonly taa = new TaaPass();
  private readonly composite = new CompositePass();
  private taaOn: boolean;
  /** The resolve cannot run on this device (link failure, incomplete MRT target, exception): TAA stays off. */
  private taaBroken = false;
  /** Link status + history framebuffer completeness checked after the first real resolve. */
  private taaVerified = false;
  /** Jitter phase counter (advances only on frames resolved by TAA). */
  private taaFrame = 0;
  private readonly passes = new Map<string, NebulaPass>();
  /** Nebula ids whose material could not be created (not retried every frame). */
  private readonly failed = new Set<string>();
  private visible: NebulaPass[] = [];

  private outW = 1;
  private outH = 1;
  private rtW = 1;
  private rtH = 1;
  private renderScale: number;
  private readonly rtSize = new THREE.Vector2(1, 1);
  private readonly outSize = new THREE.Vector2(1, 1);

  // timing / dynamic resolution
  private lastNow = 0;
  private emaMs: number;
  private readonly gpuTimer: GpuFrameTimer | null;
  /** EMA of GPU frame time (ms); −1 until the first sample. */
  private gpuEmaMs = -1;
  private lowTimeMs = 0;
  private lastResizeAt = 0;
  private holdUntil = 0;
  private frame = 0;
  private qualityGen = 0;
  /** Bumped by every context restore: only the latest background recompile may set `ready`. */
  private restoreGen = 0;
  /** The context was restored while init() was still compiling: init() recompiles before it finishes. */
  private restoredDuringInit = false;

  // scratch (allocation-free per frame)
  private readonly ctx: RenderContext;
  /** Last valid ship orientation (shake is applied on top of it every frame, never compounded). */
  private readonly baseQuat = new THREE.Quaternion();
  private readonly camQuatInv = new THREE.Quaternion();
  /** Smoothed 0..1: is the tidal black hole in front of the camera? */
  private tidalFacing = 1;
  private readonly shakeEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly shakeQuat = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly uvTmp = new THREE.Vector2();
  private readonly uvTarget = new THREE.Vector2();
  private readonly rangeX = new Float64Array(2);
  private readonly rangeY = new Float64Array(2);
  private readonly post: CompositeParams;
  private readonly warned = new Set<string>();
  /** Reused TAA per-frame input (fields re-pointed every frame, nothing allocated). */
  private readonly taaFrameInfo: TaaFrame;

  constructor(canvas: HTMLCanvasElement, quality: QualityPreset) {
    this.canvas = canvas;
    this.quality = quality;
    this.three = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
    });
    // Tone mapping + sRGB encoding happen in our composite shader. A linear output colour space
    // also makes program cache keys identical for canvas and render-target draws.
    this.three.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.three.toneMapping = THREE.NoToneMapping;
    this.three.autoClear = false;
    this.three.sortObjects = false;
    this.three.setPixelRatio(1);
    this.three.setClearColor(0x000000, 1);

    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, TUNING.depthNear, TUNING.depthFar);
    this.camera.position.set(0, 0, 0);

    this.taaOn = TAA_DEFAULT[quality.name] ?? true;
    this.renderScale = clamp(quantize(quality.renderScaleMax * 0.85), this.scaleMin(quality), quality.renderScaleMax);
    this.stats.renderScale = this.renderScale;
    this.emaMs = quality.targetFrameMs;
    const gl = this.three.getContext();
    this.gpuTimer = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
      ? new GpuFrameTimer(gl)
      : null;
    this.sceneRT = makeSceneTarget(1, 1);
    this.spriteRT = makeSpriteTarget(this.sceneRT);

    this.ctx = {
      state: null as unknown as SimState, // assigned every frame before use
      camera: this.camera,
      camRot: new THREE.Matrix3(),
      camForward: new THREE.Vector3(0, 0, -1),
      tanHalf: new THREE.Vector2(1, 1),
      resolution: new THREE.Vector2(1, 1),
      pixelAngle: 1e-3,
      jitter: new THREE.Vector2(0, 0),
      time: 0,
      quality,
      skyCube: null,
      beta: 0,
      velDir: new THREE.Vector3(0, 0, -1),
      skyExposure: 1,
    };
    this.taaFrameInfo = {
      scene: this.sceneRT,
      rtW: 1,
      rtH: 1,
      camQuat: this.camera.quaternion,
      tanHalf: this.ctx.tanHalf,
      jitter: this.ctx.jitter,
      shipPos: new THREE.Vector3(),
      nebulae: [],
      maxTravel: 0,
    };
    this.post = {
      exposure: 1,
      bloomStrength: 0,
      sharpen: 0,
      caBase: this.chromaticAberration,
      hyper: 0,
      foe: new THREE.Vector2(0.5, 0.5),
      tidal: 0,
      tidalCenter: new THREE.Vector2(0.5, 0.5),
      wormholeActive: false,
      wormholeProgress: 0,
      ghost: 0,
      ghostInside: 0,
      vignette: 0.28,
      grain: this.grain,
      time: 0,
      frame: 0,
    };

    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

    const cssW = canvas.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1280);
    const cssH = canvas.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 720);
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.resize(cssW, cssH, dpr);
  }

  /**
   * Temporal anti-aliasing with upsampling (jittered scene + full-resolution history, see
   * post/TaaPass.ts). Defaults per preset (setQuality re-applies the default); toggle any time.
   */
  get taaEnabled(): boolean {
    return this.taaOn;
  }

  set taaEnabled(value: boolean) {
    const on = value && !this.taaBroken;
    if (on === this.taaOn) return;
    this.taaOn = on;
    this.taa.invalidate();
    if (!on) this.ctx.jitter.set(0, 0);
    const q = this.quality;
    this.setRenderScale(clamp(this.renderScale, this.scaleMin(q), q.renderScaleMax), performance.now(), true);
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  async init(nebulae: NebulaRuntime[], onProgress?: (p: number, label: string) => void): Promise<void> {
    const report = (p: number, label: string) => {
      try {
        onProgress?.(clamp(p, 0, 1), label);
      } catch {
        /* UI callback errors must not break loading */
      }
    };
    report(0.01, 'Igniting renderer');
    await yieldToBrowser();
    await prepareNebulaShared();
    if (this.disposed) return;
    this.sky = new SkySystem(this.three, this.quality);
    this.stars = new StarSystem(this.quality, nebulae);
    for (const neb of nebulae) this.ensurePass(neb);

    // One compile group per distinct program, so progress can name what is compiling.
    const groups = new Map<string, { label: string; objects: THREE.Object3D[] }>();
    for (const pass of this.passes.values()) {
      const g = groups.get(pass.key);
      if (g) g.objects.push(pass.mesh);
      else groups.set(pass.key, { label: pass.label, objects: [pass.mesh] });
    }
    const total = groups.size + 3;
    let done = 0;
    const progress = () => 0.03 + 0.95 * (done / total);

    report(progress(), 'Procedural sky');
    await yieldToBrowser();
    try {
      await this.sky.init();
      this.skyReady = true;
    } catch (err) {
      this.warnOnce('sky-init', 'sky generation failed', err);
    }
    done++;

    for (const g of groups.values()) {
      if (this.disposed) return;
      report(progress(), g.label);
      await this.compileObjects(g.objects, this.sceneRT);
      done++;
      await yieldToBrowser();
    }

    if (this.disposed) return;
    report(progress(), 'Starfields');
    await this.compileStars();
    done++;

    if (this.disposed) return;
    report(progress(), 'Optics');
    await this.compileObjects(this.bloom.compileObjects(), this.sceneRT);
    await this.compileObjects(this.taa.compileObjects(), this.taa.compileTarget());
    if (this.taa.programFailed(this.three)) {
      this.taaBroken = true;
      this.taaEnabled = false;
      this.warnOnce('taa-program', 'TAA resolve program failed to link; using the plain upscale');
    }
    await this.compileObjects(this.composite.compileObjects(), null);
    done++;

    if (this.disposed) return;
    this.initDone = true;
    if (this.restoredDuringInit) {
      // Programs compiled before a mid-load context loss died with it: recompile them in the
      // background too (the ones compiled after the restore are cached and cost nothing).
      this.restoredDuringInit = false;
      await this.recompileAfterRestore(); // sets `ready` (unless a newer restore took over)
      if (this.disposed) return;
    } else {
      this.ready = true;
    }
    this.holdUntil = performance.now() + 1500;
    report(1, 'Ready');
  }

  async setQuality(q: QualityPreset): Promise<void> {
    const gen = ++this.qualityGen;
    this.quality = q;
    this.ctx.quality = q;
    this.emaMs = q.targetFrameMs;
    const taa = (TAA_DEFAULT[q.name] ?? true) && !this.taaBroken;
    if (taa !== this.taaOn) {
      this.taaOn = taa;
      this.taa.invalidate();
      if (!taa) this.ctx.jitter.set(0, 0);
    }
    this.setRenderScale(clamp(this.renderScale, this.scaleMin(q), q.renderScaleMax), performance.now(), true);

    // Build replacements for materials whose program changes, compile them, then swap, so the
    // old ones keep rendering while the new programs compile.
    const pending: { pass: NebulaPass; material: THREE.ShaderMaterial; key: string; mesh: THREE.Mesh }[] = [];
    for (const pass of this.passes.values()) {
      const key = this.keyFor(pass.neb, q);
      if (key === pass.key) continue;
      let material: THREE.ShaderMaterial;
      try {
        material = this.createMaterial(pass.neb, q);
      } catch (err) {
        this.warnOnce(`create-${pass.neb.def.id}-${q.name}`, `could not rebuild material for ${pass.neb.def.id}`, err);
        continue; // keep rendering with the current material
      }
      const mesh = new THREE.Mesh(fullscreenTriangle(), material);
      mesh.frustumCulled = false;
      pending.push({ pass, material, key, mesh });
    }

    try {
      this.stars?.setQuality(q);
    } catch (err) {
      this.warnOnce('stars-quality', 'star quality change failed', err);
    }
    await this.compileStars(); // rebuilt star groups would otherwise compile on their first draw
    try {
      await this.sky?.setQuality(q);
    } catch (err) {
      this.warnOnce('sky-quality', 'sky quality change failed', err);
    }
    if (pending.length > 0) await this.compileObjects(pending.map((p) => p.mesh), this.sceneRT);

    if (gen !== this.qualityGen || this.disposed) {
      for (const p of pending) p.material.dispose();
      return;
    }
    for (const p of pending) {
      const old = p.pass.material;
      p.pass.material = p.material;
      p.pass.mesh.material = p.material;
      p.pass.key = p.key;
      old.dispose();
    }
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const cw = Math.max(1, Number.isFinite(cssWidth) ? cssWidth : 1);
    const ch = Math.max(1, Number.isFinite(cssHeight) ? cssHeight : 1);
    const pr = clamp(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, 0.5, 2);
    this.outW = Math.max(1, Math.round(cw * pr));
    this.outH = Math.max(1, Math.round(ch * pr));
    this.three.setPixelRatio(1);
    this.three.setSize(this.outW, this.outH, false);
    this.canvas.style.width = `${cw}px`;
    this.canvas.style.height = `${ch}px`;
    this.camera.aspect = this.outW / this.outH;
    this.camera.updateProjectionMatrix();
    this.resizeTargets();
  }

  dispose(): void {
    this.disposed = true;
    this.ready = false;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored, false);
    for (const pass of this.passes.values()) pass.material.dispose();
    this.passes.clear();
    this.visible = [];
    this.sky?.dispose();
    this.stars?.dispose();
    this.sky = null;
    this.stars = null;
    this.bloom.dispose();
    this.taa.dispose();
    this.composite.dispose();
    this.spriteRT.dispose();
    this.sceneRT.dispose();
    disposeNebulaShared();
    this.gpuTimer?.dispose();
    this.three.dispose();
  }

  // -------------------------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------------------------

  /**
   * Point `camera` at the ship's current orientation / FOV (render() does this too). Call it
   * before projecting HUD markers with `camera` so they don't trail the image by one frame.
   */
  syncCamera(state: SimState): void {
    this.updateCamera(state);
  }

  render(state: SimState, nebulae: NebulaRuntime[]): void {
    const now = performance.now();
    const dt = this.tick(now);
    if (!this.ready || this.contextLost || this.disposed) {
      // Nothing is drawn (context lost / programs recompiling after a restore), but HUD markers
      // still project with `camera`: keep it on the ship.
      if (!this.disposed) this.updateCamera(state);
      return;
    }
    this.frame++;

    // While the wormhole tunnel fully covers the screen the scene is invisible: skip it (and
    // don't let the momentarily cheap frames raise the resolution).
    const wh = state.wormhole;
    const sceneHidden = wh.active && wh.progress > 0.17 && wh.progress < 0.84;
    if (sceneHidden) this.holdUntil = Math.max(this.holdUntil, now + 500);

    const gpuMs = this.gpuTimer ? this.gpuTimer.poll() : -1;
    if (gpuMs > 0) this.gpuEmaMs = this.gpuEmaMs < 0 ? gpuMs : this.gpuEmaMs + (gpuMs - this.gpuEmaMs) * 0.1;
    this.gpuTimer?.begin();
    try {
      this.drawFrame(state, nebulae, sceneHidden, dt, now);
    } finally {
      this.gpuTimer?.end(); // a query left open would block every later begin()
    }
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private drawFrame(state: SimState, nebulae: NebulaRuntime[], sceneHidden: boolean, dt: number, now: number): void {
    // A resolve failure detected last frame: switch TAA off (jitter, scale bounds) before drawing.
    if (this.taaBroken && this.taaOn) this.taaEnabled = false;
    this.updateCamera(state);
    const useTaa = this.taaOn && !sceneHidden;
    const ctx = this.buildContext(state, useTaa);
    const r = this.three;
    const rt = this.sceneRT;
    r.autoClear = false;

    rt.scissorTest = false;
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);

    if (!sceneHidden) {
      try {
        this.sky?.render(r, ctx);
      } catch (err) {
        this.warnOnce('sky-render', 'sky render failed', err);
      }
      this.bindScene();
      try {
        this.stars?.renderFar(r, ctx);
      } catch (err) {
        this.warnOnce('stars-far', 'far stars render failed', err);
      }
      this.renderNebulae(state, nebulae, ctx);
      if (useTaa) this.bindSprites();
      else this.bindScene();
      try {
        this.stars?.renderNear(r, ctx);
      } catch (err) {
        this.warnOnce('stars-near', 'near stars render failed', err);
      }
    }
    // useTaa implies the scene (and so the sprite layer) was drawn this frame.
    const spriteTex = useTaa ? this.spriteRT.texture : null;

    const bloomTex = this.quality.bloom ? this.bloom.render(r, rt.texture, spriteTex) : null;
    this.updatePostParams(state, nebulae, dt, now);

    // TAAU resolve to output resolution; the composite then only needs a mild sharpen.
    let sceneTex: THREE.Texture = rt.texture;
    let sceneSize = this.rtSize;
    const resolved = useTaa ? this.resolveTaa(state, nebulae, ctx) : null;
    if (resolved) {
      sceneTex = resolved;
      sceneSize = this.outSize;
      const up = Math.sqrt((this.outW / this.rtW) * (this.outH / this.rtH));
      this.post.sharpen = clamp(TAA_SHARPEN_BASE + TAA_SHARPEN_SLOPE * (up - 1), 0, TAA_SHARPEN_MAX);
    } else {
      this.taa.invalidate(); // hidden scene / TAA off / failure: nothing valid to reproject next frame
    }
    this.composite.render(r, sceneTex, sceneSize, bloomTex, this.outW / this.outH, this.post, spriteTex);
  }

  /** Run the TAAU resolve for this frame; null (and a warning once) if it failed. */
  private resolveTaa(state: SimState, nebulae: NebulaRuntime[], ctx: RenderContext): THREE.Texture | null {
    const ship = state.ship;
    const v = ship.velocity;
    const speed = finite3(v) ? Math.hypot(v.x, v.y, v.z) : 0;
    const simDt = Number.isFinite(state.dt) ? clamp(state.dt, 0, 0.25) : 0;
    const sd = Number.isFinite(state.env.surfaceDistance) ? Math.max(0, state.env.surfaceDistance) : 0;
    const f = this.taaFrameInfo;
    f.rtW = this.rtW;
    f.rtH = this.rtH;
    f.camQuat = this.camera.quaternion;
    f.tanHalf = ctx.tanHalf;
    f.jitter = ctx.jitter;
    f.shipPos = ship.position;
    f.nebulae = nebulae;
    // Generous bound on real travel (velocity × a few frames, plus push-outs near surfaces):
    // anything farther is a teleport (wormhole exit, reset to start) → start a fresh history.
    f.maxTravel = 4 * speed * Math.max(simDt, 1 / 30) + 0.5 * sd + 1e-9;
    try {
      const tex = this.taa.render(this.three, f);
      if (!this.taaVerified) {
        // First real draw: three has now checked the program, and the MRT target exists on the GPU.
        this.taaVerified = true;
        if (this.taa.programFailed(this.three) || !this.taa.targetComplete(this.three)) {
          this.taaBroken = true; // disabled at the start of the next frame
          this.warnOnce('taa-program', 'TAA resolve cannot run on this device; using the plain upscale');
          return null;
        }
      }
      this.taaFrame++;
      return tex;
    } catch (err) {
      // It would fail again every frame while the scene keeps being jittered: turn TAA off.
      this.taaBroken = true;
      this.warnOnce('taa', 'TAA resolve failed; falling back to the plain upscale', err);
      return null;
    }
  }

  private bindScene(): void {
    this.sceneRT.scissorTest = false;
    this.three.setRenderTarget(this.sceneRT);
  }

  /** Bind the sprite layer and clear its colour only (the depth it shares holds the scene's). */
  private bindSprites(): void {
    const rt = this.spriteRT;
    rt.scissorTest = false;
    this.three.setRenderTarget(rt);
    this.three.setClearColor(0x000000, 1);
    this.three.clear(true, false, false);
  }

  private renderNebulae(state: SimState, nebulae: NebulaRuntime[], ctx: RenderContext): void {
    const r = this.three;
    const rt = this.sceneRT;
    let count = 0;
    for (let i = 0; i < nebulae.length; i++) {
      const pass = this.ensurePass(nebulae[i]);
      if (!pass || !this.cull(pass, state)) continue;
      this.visible[count++] = pass;
    }
    // Insertion sort far → near (tiny list, allocation-free).
    const vis = this.visible;
    for (let i = 1; i < count; i++) {
      const p = vis[i];
      let j = i - 1;
      while (j >= 0 && vis[j].dist < p.dist) {
        vis[j + 1] = vis[j];
        j--;
      }
      vis[j + 1] = p;
    }

    for (let i = 0; i < count; i++) {
      const pass = vis[i];
      try {
        if (pass.isBlackHole) {
          updateBlackHoleUniforms(pass.material, pass.neb, ctx);
        } else {
          updateNebulaUniforms(pass.material, pass.neb, ctx);
          const fade = pass.material.uniforms.uFade.value as number;
          if (!(fade > 0.002)) continue;
        }
      } catch (err) {
        this.warnOnce(`uniforms-${pass.neb.def.id}`, `uniform update failed for ${pass.neb.def.id}`, err);
        continue;
      }
      if (pass.full) {
        rt.scissorTest = false;
      } else {
        rt.scissor.copy(pass.rect);
        rt.scissorTest = true;
      }
      r.setRenderTarget(rt); // re-apply: three only picks up RT scissor state here
      r.render(pass.mesh, FULLSCREEN_CAMERA);
    }
    rt.scissorTest = false;
  }

  /** Frustum-cull a nebula's render sphere and compute its conservative scissor rect. */
  private cull(pass: NebulaPass, state: SimState): boolean {
    const neb = pass.neb;
    const R = neb.renderRadiusWorld;
    if (!(R > 0) || !Number.isFinite(R)) return false;
    const sp = state.ship.position;
    const v = this.v.set(neb.position.x - sp.x, neb.position.y - sp.y, neb.position.z - sp.z);
    const dist = v.length();
    if (!Number.isFinite(dist)) return false;
    pass.dist = dist;
    if (dist <= R * 1.05) {
      pass.full = true;
      return true;
    }
    v.applyQuaternion(this.camQuatInv); // view space: camera looks down −Z
    const w = -v.z;
    if (w < -R) return false; // entirely behind the camera
    const th = this.ctx.tanHalf;
    if (!axisRange(v.x, w, R, th.x, this.rangeX)) return false;
    if (!axisRange(v.y, w, R, th.y, this.rangeY)) return false;

    const W = this.rtW;
    const H = this.rtH;
    const x0 = clamp(Math.floor((this.rangeX[0] * 0.5 + 0.5) * W) - 2, 0, W);
    const x1 = clamp(Math.ceil((this.rangeX[1] * 0.5 + 0.5) * W) + 2, 0, W);
    const y0 = clamp(Math.floor((this.rangeY[0] * 0.5 + 0.5) * H) - 2, 0, H);
    const y1 = clamp(Math.ceil((this.rangeY[1] * 0.5 + 0.5) * H) + 2, 0, H);
    if (x1 <= x0 || y1 <= y0) return false;
    pass.full = (x1 - x0) * (y1 - y0) >= 0.85 * W * H;
    pass.rect.set(x0, y0, x1 - x0, y1 - y0);
    return true;
  }

  private updateCamera(state: SimState): void {
    const cam = this.camera;
    const o = state.ship.orientation;
    if (Number.isFinite(o.x + o.y + o.z + o.w) && o.lengthSq() > 1e-12) this.baseQuat.copy(o).normalize();
    cam.quaternion.copy(this.baseQuat);
    const s = state.camera.shake;
    if (finite3(s)) {
      this.shakeEuler.set(s.x, s.y, s.z, 'YXZ');
      this.shakeQuat.setFromEuler(this.shakeEuler);
      cam.quaternion.multiply(this.shakeQuat);
    }
    cam.quaternion.normalize();
    cam.position.set(0, 0, 0);
    const fov = Number.isFinite(state.camera.fovDeg) ? clamp(state.camera.fovDeg, 15, 150) : cam.fov;
    const aspect = this.outW / this.outH;
    if (fov !== cam.fov || aspect !== cam.aspect) {
      cam.fov = fov;
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
    this.camQuatInv.copy(cam.quaternion).invert();
  }

  private buildContext(state: SimState, jitter: boolean): RenderContext {
    const ctx = this.ctx;
    const cam = this.camera;
    ctx.state = state;
    ctx.camRot.setFromMatrix4(cam.matrixWorld);
    ctx.camForward.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const th = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    ctx.tanHalf.set(th * cam.aspect, th);
    ctx.resolution.set(this.rtW, this.rtH);
    ctx.pixelAngle = (2 * th) / this.rtH;
    ctx.time = Number.isFinite(state.time) ? state.time : 0;
    ctx.quality = this.quality;
    ctx.skyCube = this.skyReady && this.sky ? this.sky.cubeTexture : null;
    const beta = state.ship.betaVis;
    ctx.beta = Number.isFinite(beta) ? clamp(beta, 0, 0.92) : 0;
    const vd = state.ship.velocityDir;
    if (finite3(vd) && vd.lengthSq() > 1e-12) ctx.velDir.copy(vd).normalize();
    else ctx.velDir.copy(ctx.camForward);
    ctx.skyExposure = 1;
    // Halton(2,3) sub-pixel jitter consumed by the sky / nebula / black-hole passes (uJitter).
    if (jitter) taaJitter(this.taaFrame, ctx.jitter);
    else ctx.jitter.set(0, 0);
    return ctx;
  }

  private updatePostParams(state: SimState, nebulae: NebulaRuntime[], dt: number, now: number): void {
    const p = this.post;
    const hyper = Number.isFinite(state.ship.hyper) ? clamp(state.ship.hyper, 0, 1) : 0;
    const tidal = Number.isFinite(state.env.tidal) ? clamp(state.env.tidal, 0, 1) : 0;
    p.exposure = this.exposure;
    p.bloomStrength = this.bloomStrength * this.bloom.normalization;
    p.sharpen = clamp((1 - this.renderScale) * 0.9, 0, 0.45);
    p.caBase = this.chromaticAberration;
    p.hyper = hyper;
    p.wormholeActive = state.wormhole.active;
    p.wormholeProgress = clamp(Number.isFinite(state.wormhole.progress) ? state.wormhole.progress : 0, 0, 1);
    const gh = Number.isFinite(state.ship.ghost) ? clamp(state.ship.ghost, 0, 1) : 0;
    const ghIn = Number.isFinite(state.ship.ghostInside) ? clamp(state.ship.ghostInside, 0, 1) : 0;
    p.ghost = gh;
    p.ghostInside = ghIn;
    p.vignette = 0.28 + 0.18 * hyper + 0.2 * tidal + 0.12 * ghIn;
    p.grain = this.grain;
    p.time = now * 0.001;
    p.frame = this.frame;

    // Focus of expansion for the zoom blur: where the velocity points on screen.
    const k = damp(dt, 0.18);
    this.uvTarget.set(0.5, 0.5);
    if (this.projectDir(state.ship.velocityDir, this.uvTmp)) {
      this.uvTmp.set(clamp(this.uvTmp.x, 0.12, 0.88), clamp(this.uvTmp.y, 0.12, 0.88));
      this.uvTarget.lerp(this.uvTmp, 0.8);
    }
    p.foe.lerp(this.uvTarget, k);

    // Tidal swirl centre: the black hole's screen position when it is in front of us. When it is
    // behind, the swirl moves off-screen on the side the hole lies and weakens, instead of
    // twisting the middle of a view that contains no black hole.
    this.uvTarget.set(0.5, 0.5);
    let facing = 1;
    const bhId = state.env.blackHoleId;
    if (bhId && tidal > 0) {
      for (let i = 0; i < nebulae.length; i++) {
        const n = nebulae[i];
        if (n.def.id !== bhId) continue;
        const sp = state.ship.position;
        this.v.set(n.position.x - sp.x, n.position.y - sp.y, n.position.z - sp.z);
        if (this.projectDir(this.v, this.uvTmp)) {
          this.uvTarget.set(clamp(this.uvTmp.x, -0.25, 1.25), clamp(this.uvTmp.y, -0.25, 1.25));
        } else if (finite3(this.v)) {
          const v = this.v.applyQuaternion(this.camQuatInv); // view space
          const l = Math.hypot(v.x, v.y);
          if (l > 1e-9) this.uvTarget.set(0.5 + (0.75 * v.x) / l, 0.5 + (0.75 * v.y) / l);
          facing = 0;
        }
        break;
      }
    }
    p.tidalCenter.lerp(this.uvTarget, k);
    this.tidalFacing += (facing - this.tidalFacing) * k;
    p.tidal = tidal * (0.4 + 0.6 * this.tidalFacing);
  }

  /** Screen uv (0..1, y up) of a camera-relative direction/position; false if behind. */
  private projectDir(dir: THREE.Vector3, out: THREE.Vector2): boolean {
    if (!finite3(dir)) return false;
    const v = this.v.copy(dir).applyQuaternion(this.camQuatInv);
    if (v.z > -1e-9 || v.lengthSq() < 1e-24) return false;
    const th = this.ctx.tanHalf;
    out.set(((v.x / -v.z) / th.x) * 0.5 + 0.5, ((v.y / -v.z) / th.y) * 0.5 + 0.5);
    return Number.isFinite(out.x + out.y);
  }

  /** Frame timing, stats and dynamic resolution. Returns the frame interval in seconds. */
  private tick(now: number): number {
    const dtMs = this.lastNow > 0 ? now - this.lastNow : 0;
    this.lastNow = now;
    if (!(dtMs > 0) || dtMs > 250) {
      // First frame, tab switch or a hitch: don't let it steer the resolution.
      this.holdUntil = Math.max(this.holdUntil, now + 600);
      this.lowTimeMs = 0;
      return clamp(dtMs, 0, 100) * 0.001;
    }
    this.emaMs += (dtMs - this.emaMs) * (1 - Math.exp(-dtMs / 300));
    this.stats.frameMs = this.emaMs;
    this.stats.fps = 1000 / Math.max(this.emaMs, 1e-3);
    if (this.ready && now >= this.holdUntil) this.adaptResolution(dtMs, now);
    return dtMs * 0.001;
  }

  private adaptResolution(dtMs: number, now: number): void {
    const q = this.quality;
    const target = q.targetFrameMs;
    const canResize = now - this.lastResizeAt >= RESIZE_INTERVAL_MS;
    const gpuHeadroom = this.gpuEmaMs > 0 && this.gpuEmaMs < target * GPU_RAISE_FRACTION && this.emaMs < target * 1.04;
    if (this.emaMs > target * 1.08) {
      this.lowTimeMs = 0;
      if (canResize && this.renderScale > this.scaleMin(q)) {
        this.setRenderScale(Math.min(quantize(this.renderScale * 0.93), this.renderScale - SCALE_QUANTUM), now);
      }
    } else if (this.emaMs < target * 0.8 || gpuHeadroom) {
      this.lowTimeMs += dtMs;
      if (this.lowTimeMs >= RAISE_AFTER_MS && canResize && this.renderScale < q.renderScaleMax) {
        this.setRenderScale(Math.max(quantize(this.renderScale * 1.03), this.renderScale + SCALE_QUANTUM), now);
        this.lowTimeMs = 0;
      }
    } else {
      this.lowTimeMs = 0;
    }
  }

  /** Lower dynamic-resolution bound: TAAU recovers detail, so it may go a little lower. */
  private scaleMin(q: QualityPreset): number {
    return this.taaOn ? Math.max(0.25, q.renderScaleMin - TAA_SCALE_MIN_DROP) : q.renderScaleMin;
  }

  private setRenderScale(s: number, now: number, force = false): void {
    const q = this.quality;
    const next = clamp(quantize(s), this.scaleMin(q), q.renderScaleMax);
    if (!force && Math.abs(next - this.renderScale) < 1e-6) return;
    this.renderScale = next;
    this.stats.renderScale = next;
    this.lastResizeAt = now;
    this.resizeTargets();
  }

  private resizeTargets(): void {
    const w = Math.max(1, Math.round(this.outW * this.renderScale));
    const h = Math.max(1, Math.round(this.outH * this.renderScale));
    this.rtW = w;
    this.rtH = h;
    this.rtSize.set(w, h);
    if (this.sceneRT.width !== w || this.sceneRT.height !== h) this.sceneRT.setSize(w, h);
    // Shares sceneRT's depth texture: three throws if the sizes ever differ.
    if (this.spriteRT.width !== w || this.spriteRT.height !== h) this.spriteRT.setSize(w, h);
    this.bloom.setSize(w, h);
    this.outSize.set(this.outW, this.outH);
    this.taa.setSize(this.outW, this.outH); // resets the history only when the OUTPUT size changes
  }

  private keyFor(neb: NebulaRuntime, q: QualityPreset): string {
    return neb.fractal ? nebulaMaterialKey(neb.fractal, q) : `blackhole|${q.name}`;
  }

  private createMaterial(neb: NebulaRuntime, q: QualityPreset): THREE.ShaderMaterial {
    if (neb.fractal) return createNebulaMaterial(neb.fractal, q);
    const mat = createBlackHoleMaterial(neb, q);
    // Enforce the shared compositing contract (premultiplied output + gl_FragDepth, sorted far→near).
    mat.transparent = true;
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.blendEquationAlpha = THREE.AddEquation;
    mat.blendSrcAlpha = THREE.OneFactor;
    mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    mat.depthTest = true;
    mat.depthWrite = true;
    mat.depthFunc = THREE.AlwaysDepth;
    return mat;
  }

  private ensurePass(neb: NebulaRuntime): NebulaPass | null {
    const existing = this.passes.get(neb.def.id);
    if (existing) {
      existing.neb = neb;
      return existing;
    }
    if (this.failed.has(neb.def.id)) return null;
    let material: THREE.ShaderMaterial;
    try {
      material = this.createMaterial(neb, this.quality);
    } catch (err) {
      this.failed.add(neb.def.id);
      this.warnOnce(`create-${neb.def.id}`, `could not create material for ${neb.def.id}`, err);
      return null;
    }
    const mesh = new THREE.Mesh(fullscreenTriangle(), material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    const pass: NebulaPass = {
      neb,
      isBlackHole: neb.fractal === null,
      material,
      mesh,
      key: this.keyFor(neb, this.quality),
      label: neb.fractal ? neb.fractal.label : 'Black hole',
      dist: 0,
      full: true,
      rect: new THREE.Vector4(),
    };
    this.passes.set(neb.def.id, pass);
    this.visible.push(pass);
    return pass;
  }

  /**
   * Compile the programs of `objects` without blocking (KHR_parallel_shader_compile when
   * available). Gives up waiting after COMPILE_TIMEOUT_MS: three's readiness polling never ends if
   * the context is lost mid-compile, which would otherwise hang init() forever.
   */
  private async compileObjects(objects: THREE.Object3D[], target: THREE.WebGLRenderTarget | null): Promise<void> {
    if (objects.length === 0 || this.contextLost) return;
    const scene = new THREE.Scene();
    for (const o of objects) scene.add(o);
    const prev = this.three.getRenderTarget();
    let pending: Promise<unknown> = Promise.resolve();
    try {
      // Program parameters are captured from the bound target during the synchronous part.
      this.three.setRenderTarget(target);
      pending = this.three.compileAsync(scene, FULLSCREEN_CAMERA);
    } catch (err) {
      this.warnOnce('compile', 'shader precompilation failed', err);
    } finally {
      this.three.setRenderTarget(prev);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((res) => {
      timer = setTimeout(res, COMPILE_TIMEOUT_MS);
    });
    try {
      await Promise.race([pending, timeout]);
    } catch (err) {
      this.warnOnce('compile', 'shader precompilation failed', err);
    } finally {
      clearTimeout(timer);
      scene.clear();
    }
  }

  /** Precompile the star/dust sprite programs against the scene target. */
  private async compileStars(): Promise<void> {
    if (!this.stars || this.contextLost) return;
    try {
      await this.stars.compile(this.three, this.camera, this.sceneRT);
    } catch (err) {
      this.warnOnce('compile-stars', 'star shader precompilation failed', err);
    }
  }

  private warnOnce(key: string, message: string, err?: unknown): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[Renderer] ${message}`, err ?? '');
  }

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
    this.warnOnce('context-lost', 'WebGL context lost; waiting for restore');
  };

  private readonly onContextRestored = (): void => {
    // three.js re-creates its GL resources lazily (textures, targets); SkySystem regenerates its
    // cubemap on its own restore listener. Query objects died with the context.
    this.contextLost = false;
    this.taa.invalidate(); // history textures come back empty
    this.taaVerified = false; // programs and targets are re-created: check them again
    this.gpuTimer?.reset();
    this.gpuEmaMs = -1;
    this.holdUntil = performance.now() + 1500;
    // Every program died with the context too. Left to the next frame, all of them (nebulae,
    // black holes, stars, post) would compile synchronously inside one draw — seconds of frozen
    // page on ANGLE/D3D11 with a cold shader cache. Recompile in the background as init() does
    // and skip frames until done. Before init() finished, init() does it at its end (its groups
    // compiled before the loss are dead too).
    if (this.initDone) void this.recompileAfterRestore();
    else this.restoredDuringInit = true;
  };

  private async recompileAfterRestore(): Promise<void> {
    const gen = ++this.restoreGen;
    this.ready = false;
    const meshes: THREE.Object3D[] = [];
    for (const pass of this.passes.values()) meshes.push(pass.mesh);
    const stages: (() => Promise<void>)[] = [
      () => this.compileObjects(meshes, this.sceneRT),
      () => this.compileStars(),
      () => this.compileObjects(this.bloom.compileObjects(), this.sceneRT),
      () => this.compileObjects(this.taa.compileObjects(), this.taa.compileTarget()),
      () => this.compileObjects(this.composite.compileObjects(), null),
    ];
    try {
      for (const stage of stages) {
        if (gen !== this.restoreGen || this.disposed) return; // superseded by a newer restore
        await stage();
      }
    } finally {
      if (gen === this.restoreGen && !this.disposed) {
        this.ready = true;
        this.holdUntil = performance.now() + 1500;
      }
    }
  }
}
