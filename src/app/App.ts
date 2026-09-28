/**
 * Application shell: wires Simulation, Renderer, HUD, Audio and Input together and runs
 * the frame loop. Before launch the simulation runs in attract mode behind the start screen.
 *
 * Pointer-lock lifecycle (the part a real mouse user feels):
 *  - LAUNCH / Enter and Resume / Enter request the lock synchronously inside the gesture.
 *  - Chrome refuses a new lock for 1.25 s after the user pressed Esc; Resume within that window
 *    waits it out (transient activation lasts ~5 s, so the delayed request still counts as a
 *    gesture) and the pause card says the drive is engaging.
 *  - A refused request (or one the browser never answers) keeps / puts the app on the pause
 *    screen with a "click Resume to try again" note — the user can never end up in flight with
 *    a free cursor and no way back. A click on the canvas in that state also re-requests.
 */
import { bus } from '../core/events';
import type { AppSettings, QualityName } from '../core/types';
import { QUALITY_PRESETS, loadSettings, saveSettings } from './config';
import { NEBULAE } from '../universe/catalog';
import { CODEX } from '../content/codex';
import { Simulation } from '../sim/Simulation';
import { Renderer } from '../render/Renderer';
import { Input } from '../ship/Input';
import { AudioEngine } from '../audio/AudioEngine';
import { Hud } from '../hud/Hud';
import { enterFullscreen, exitFullscreen, isFullscreen, onFullscreenChange } from './Fullscreen';

type Phase = 'loading' | 'start' | 'flying' | 'paused';

/** Chrome: no re-lock for 1250 ms after the user escaped a lock (+ margin for event latency). */
const RELOCK_COOLDOWN_MS = 1400;
/** A lock request that is neither granted nor refused within this time is treated as refused. */
const LOCK_TIMEOUT_MS = 2500;
/**
 * Frame pacing target. On high-refresh displays (e.g. 119/144 Hz) a raymarcher that can't hold the
 * full refresh rate would alternate between 1 and 2 refreshes per frame and judder; instead we
 * render on every Nth vsync (N = round(target / vsync)), which gives an even ~60–72 fps, while the
 * renderer's dynamic resolution spends the headroom on sharpness.
 */
const PACING_TARGET_MS = 1000 / 60;

export class App {
  private settings: AppSettings = loadSettings();
  private sim!: Simulation;
  private renderer!: Renderer;
  private input!: Input;
  private audio = new AudioEngine();
  private hud!: Hud;
  private phase: Phase = 'loading';
  private rendererReady = false;
  private lastFrame = 0;
  private rafId = 0;
  // Frame pacing (see PACING_TARGET_MS): raw rAF intervals → vsync estimate → render every Nth.
  private lastRaf = 0;
  private rafTick = 0;
  private renderEvery = 1;
  private readonly vsyncSamples = new Float32Array(32);
  private readonly vsyncScratch = new Float32Array(32);
  private vsyncCount = 0;
  /** When the user last left pointer lock (Esc, focus loss) — not when a request failed. */
  private lastUnlockAt = -1e9;
  /** performance.now() of the outstanding lock request (−1: none outstanding). */
  private lockRequestedAt = -1;
  private resumeTimer = 0;
  private readonly warned = new Set<string>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly hudRoot: HTMLElement,
  ) {}

  async boot(): Promise<void> {
    // Probe on a throwaway canvas so the real canvas gets three's own context attributes.
    const probe = document.createElement('canvas').getContext('webgl2');
    if (!probe) {
      throw new Error('WebGL2 is not available in this browser. Please use a recent Chrome, Edge or Firefox.');
    }
    probe.getExtension('WEBGL_lose_context')?.loseContext();

    this.hud = new Hud(this.hudRoot, {
      nebulae: NEBULAE,
      codex: CODEX,
      settings: this.settings,
      onLaunch: (q) => this.launch(q),
      onResume: () => this.resume(),
      onSettingsChange: (s) => this.applySettings(s),
    });

    // Any failure from here on is reported on the start screen too (not only by main.ts), so the
    // progress bar never just freezes — e.g. `new WebGLRenderer` throws when context creation fails.
    let stage = 'Startup failed';
    try {
      this.sim = new Simulation({ nebulae: NEBULAE, settings: this.settings });
      this.sim.setAttractMode(true);

      stage = 'Renderer failed to start';
      this.renderer = new Renderer(this.canvas, QUALITY_PRESETS[this.settings.quality]);
      this.input = new Input(this.canvas);
      this.input.onLockChange((locked, failed) => this.onLockChange(locked, failed));

      window.addEventListener('resize', this.onResize);
      this.unsubFullscreen = onFullscreenChange(this.onFullscreen);
      this.canvas.addEventListener('click', this.onCanvasClick);
      this.onResize();

      this.phase = 'start';
      this.lastFrame = performance.now();
      this.rafId = requestAnimationFrame(this.frame);

      await this.renderer.init(this.sim.nebulae, (p, label) => this.hud.setLoadingProgress(p, label));
    } catch (err) {
      this.hud.setLoadError(`${stage} · details below`);
      throw err;
    }
    this.rendererReady = true;
    this.hud.setReady();
  }

  private frame = (now: number) => {
    this.rafId = requestAnimationFrame(this.frame);
    if (this.skipForPacing(now)) return;
    const dt = Math.min(Math.max((now - this.lastFrame) / 1000, 0), 0.1);
    this.lastFrame = now;

    // A lock request the browser never answered must not leave the pilot with a free cursor.
    if (this.lockRequestedAt >= 0 && !this.input.locked && now - this.lockRequestedAt > LOCK_TIMEOUT_MS) {
      this.onLockChange(false, true);
    }

    const frame = this.input.poll();
    if (this.phase === 'flying') {
      if (frame.toggles.hud) this.hud.toggleVisible();
      if (frame.toggles.codex) this.hud.toggleCodex();
      if (frame.toggles.mute) {
        const muted = this.audio.toggleMute();
        this.hud.flashMessage(muted ? 'Music muted · M to restore' : 'Music on');
      }
    }

    this.sim.update(dt, frame);
    // A failing subsystem must not take the HUD / pause flow down with it.
    try {
      this.audio.update(this.sim.state);
    } catch (err) {
      this.warnOnce('audio', err);
    }
    try {
      // Render first so the HUD projects markers with this frame's camera.
      if (this.rendererReady) this.renderer.render(this.sim.state, this.sim.nebulae);
      else this.renderer.syncCamera(this.sim.state);
    } catch (err) {
      this.warnOnce('render', err);
    }
    this.hud.update(this.sim.state, this.sim.nebulae, this.renderer.camera, this.renderer.stats);
  };

  /**
   * True when this vsync should be skipped. The vsync interval is the 10th-percentile raw rAF
   * interval over the last 32 callbacks (skipped callbacks still arrive every vsync, so the
   * estimate stays stable while pacing; GPU-bound stretches only lengthen the upper samples).
   */
  private skipForPacing(now: number): boolean {
    const raw = now - this.lastRaf;
    this.lastRaf = now;
    if (raw > 1 && raw < 100) {
      this.vsyncSamples[this.vsyncCount % this.vsyncSamples.length] = raw;
      this.vsyncCount++;
      if (this.vsyncCount % this.vsyncSamples.length === 0) {
        const s = this.vsyncScratch;
        s.set(this.vsyncSamples);
        s.sort();
        const vsync = s[3];
        this.renderEvery = Math.min(4, Math.max(1, Math.round(PACING_TARGET_MS / vsync)));
      }
    }
    this.rafTick++;
    return this.renderEvery > 1 && this.rafTick % this.renderEvery !== 0;
  }

  private launch(quality: QualityName): void {
    if (this.phase !== 'start' || !this.rendererReady) return;
    // Enter flight first, so a refused lock (even one refused synchronously) lands on the pause
    // screen and nothing below un-pauses it again.
    this.phase = 'flying';
    this.hud.hideStartScreen();
    this.sim.setAttractMode(false);
    this.sim.setPaused(false);

    // All three must be initiated synchronously inside the user gesture (click / Enter): full
    // screen (if chosen), the pointer lock, then audio (its graph takes a few ms to build).
    if (this.settings.fullscreen) void enterFullscreen();
    this.requestLock();
    // Volumes first so the score fades in at the saved level (not the engine default).
    this.audio.setVolumes(this.settings.musicVolume, this.settings.sfxVolume);
    this.audio.start().catch((err) => console.warn('[app] audio failed to start', err));

    if (quality !== this.settings.quality) this.applySettings({ ...this.settings, quality });
  }

  private resume(): void {
    if (this.phase !== 'paused' || this.resumeTimer !== 0) return;
    this.hud.setResumeState('pending');
    const wait = RELOCK_COOLDOWN_MS - (performance.now() - this.lastUnlockAt);
    if (wait > 0) {
      this.resumeTimer = window.setTimeout(() => {
        this.resumeTimer = 0;
        if (this.phase === 'paused') this.requestLock();
      }, wait);
    } else {
      this.requestLock();
    }
  }

  private requestLock(): void {
    window.clearTimeout(this.resumeTimer);
    this.resumeTimer = 0;
    if (this.input.locked) return;
    this.lockRequestedAt = performance.now();
    this.input.requestLock();
  }

  /**
   * `failed`: a lock request was refused (or timed out) — the user did not leave the lock, so
   * there is no browser cooldown to respect before the next try.
   */
  private onLockChange(locked: boolean, failed: boolean): void {
    this.lockRequestedAt = -1;
    if (locked) {
      window.clearTimeout(this.resumeTimer);
      this.resumeTimer = 0;
      if (this.phase === 'paused' || this.phase === 'flying') {
        const wasPaused = this.phase === 'paused';
        this.phase = 'flying';
        this.sim.setPaused(false);
        this.audio.setPaused(false);
        this.hud.showPause(false);
        this.hud.setResumeState('idle');
        if (wasPaused) bus.emit('resume', {});
      }
      return;
    }
    if (!failed) this.lastUnlockAt = performance.now();
    if (this.phase === 'flying') {
      this.phase = 'paused';
      this.sim.setPaused(true);
      this.audio.setPaused(true);
      this.hud.showPause(true);
      bus.emit('pause', {});
    }
    if (failed && this.phase === 'paused') this.hud.setResumeState('failed');
  }

  private applySettings(next: AppSettings, fromFullscreenChange = false): void {
    const qualityChanged = next.quality !== this.settings.quality;
    // A toggle in the menus is a user gesture (this runs synchronously inside its change event).
    // Before launch the start-screen switch is only the preference Launch will use.
    if (!fromFullscreenChange && next.fullscreen !== this.settings.fullscreen && this.phase !== 'start') {
      if (next.fullscreen) void enterFullscreen();
      else exitFullscreen();
    }
    this.settings = { ...next };
    saveSettings(this.settings);
    this.sim.setSettings(this.settings);
    this.audio.setVolumes(this.settings.musicVolume, this.settings.sfxVolume);
    // Renderer.setQuality tolerates overlapping calls (the last one wins).
    if (qualityChanged) {
      this.renderer
        .setQuality(QUALITY_PRESETS[this.settings.quality])
        .catch((err) => console.error('[app] quality change failed', err));
    }
    bus.emit('settingsChanged', { settings: this.settings });
  }

  /** Full screen changed outside the menus (F11 / Alt+Enter, or holding Esc): remember it. */
  private onFullscreen = (fs: boolean): void => {
    if (fs !== this.settings.fullscreen) this.applySettings({ ...this.settings, fullscreen: fs }, true);
  };
  private unsubFullscreen: (() => void) | null = null;

  private onResize = (): void => {
    this.renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  };

  /** In flight without the lock (a request still in the air or silently dropped): click to engage. */
  private onCanvasClick = (): void => {
    if (this.phase === 'flying' && !this.input.locked) this.requestLock();
  };

  private warnOnce(key: string, err: unknown): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.error(`[app] ${key} failed (further errors suppressed)`, err);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    window.clearTimeout(this.resumeTimer);
    window.removeEventListener('resize', this.onResize);
    this.unsubFullscreen?.();
    if (isFullscreen()) exitFullscreen();
    this.canvas.removeEventListener('click', this.onCanvasClick);
    // After a failed boot some subsystems were never constructed.
    this.input?.dispose();
    this.audio.dispose();
    this.renderer?.dispose();
    this.hud?.dispose();
  }
}
