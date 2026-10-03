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
 *
 * Game modes (src/game/platform/GameMode.ts, design/60-first-light-build.md §S) plug into the same
 * shell. The Voyage is the app with NO mode and behaves exactly as described above. A mode adds a
 * cursor mode: 'locked' (pointer-locked flight, as in the Voyage) or 'free' (visible pointer, the
 * canvas takes pointer input, NOT paused):
 *  - requestFreeCursor() releases the lock on purpose: that unlock is expected and does not pause.
 *  - requestFlight() from 'free' asks for the lock (waiting out Chrome's cooldown if the user just
 *    escaped one); the cursor stays 'free' until it is granted, and a refusal keeps it 'free'
 *    (mode.onCursorModeChange('free', true)) instead of pausing.
 *  - Esc in 'free' reaches the page (InputFrame.escape) and pauses; Resume returns to the cursor
 *    mode that was active when the pause began ('free' → no lock request).
 *  - A canvas click never requests the lock while the cursor is 'free'.
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
import { Hud, type PauseButton } from '../hud/Hud';
import { enterFullscreen, exitFullscreen, isFullscreen, onFullscreenChange } from './Fullscreen';
import { createOverlayFrame } from '../render/game/overlayTypes';
import type { CursorMode, GameMode, GameModeId, ModeContext, ModeId } from '../game/platform/GameMode';
import {
  availableModes,
  createGameMode,
  initialModeId,
  isModeId,
  rememberMode,
  writeModeParam,
  type GameModeInfo,
} from '../game/modes';

type Phase = 'loading' | 'start' | 'flying' | 'paused';

/** Chrome: no re-lock for 1250 ms after the user escaped a lock (+ margin for event latency). */
const RELOCK_COOLDOWN_MS = 1400;
/** A lock request that is neither granted nor refused within this time is treated as refused. */
const LOCK_TIMEOUT_MS = 2500;
/** A deliberate exitPointerLock() is answered well within this time (ms); later unlocks are the user's. */
const EXPECTED_UNLOCK_MS = 1000;
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

  // ---- game modes (all idle in the Voyage) ----
  /** Modes this build offers (start-screen cards, pause-screen switch). */
  private readonly modes: GameModeInfo[] = availableModes();
  private activeMode: GameMode | null = null;
  /** enter() has returned: the mode's hooks may be called. */
  private modeEntered = false;
  /** Bumped on every mode change: a stale ModeContext's calls become no-ops. */
  private modeGen = 0;
  private modeLayer: HTMLElement | null = null;
  private cursorMode: CursorMode = 'locked';
  /** A deliberate exitPointerLock() is in flight until this time: its unlock must not pause. */
  private expectUnlockUntil = 0;
  /** In a mode: the App currently wants the pointer lock (a grant that arrives otherwise is handed back). */
  private lockWanted = false;
  /** The outstanding lock request came from free-cursor play (a refusal keeps the cursor free). */
  private lockFromFree = false;
  /** requestFlight() arrived while the release of an earlier lock was still in flight. */
  private relockAfterUnlock = false;
  /** A pause action (or a context call from it) already decided how the pause ends. */
  private pauseHandled = false;
  /** mode.update() is running: switchMode() is deferred until it returns. */
  private inModeUpdate = false;
  private pendingSwitch: ModeId | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly hudRoot: HTMLElement,
  ) {}

  /** Dev console handle (`__app.mode`): the active game mode, or null in the Voyage. */
  get mode(): GameMode | null {
    return this.activeMode;
  }

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
      onLaunch: (q, mode) => this.launch(q, mode),
      onResume: () => this.resume(),
      onSettingsChange: (s) => this.applySettings(s),
      modes: { options: this.modes, initial: initialModeId(this.modes) },
    });
    this.refreshPauseExtras();

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
      // In a game mode Tab / I belong to the mode (it opens the codex itself).
      if (frame.toggles.codex && this.activeMode === null) this.hud.toggleCodex();
      if (frame.toggles.mute) {
        const muted = this.audio.toggleMute();
        this.hud.flashMessage(muted ? 'Music muted · M to restore' : 'Music on');
      }
      // Esc in free-cursor play reaches the page (no lock for the browser to release): pause.
      if (frame.escape && this.activeMode !== null && this.cursorMode === 'free' && !this.modeTakesEscape()) {
        this.pauseFromMode();
      }
    }

    this.sim.update(dt, frame);
    const mode = this.activeMode;
    if (mode !== null && this.modeEntered) {
      this.inModeUpdate = true;
      try {
        mode.update(dt, frame, this.sim.state, this.phase !== 'flying');
      } catch (err) {
        this.warnOnce('mode', err);
      } finally {
        this.inModeUpdate = false;
      }
      if (this.pendingSwitch !== null) {
        const next = this.pendingSwitch;
        this.pendingSwitch = null;
        this.switchMode(next);
      }
    }
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

  private launch(quality: QualityName, modeChoice: string): void {
    if (this.phase !== 'start' || !this.rendererReady) return;
    const modeId: ModeId = isModeId(this.modes, modeChoice) ? modeChoice : 'voyage';
    // Enter flight first, so a refused lock (even one refused synchronously) lands on the pause
    // screen and nothing below un-pauses it again.
    this.phase = 'flying';
    // A game mode is set up before the start screen goes (the HUD must not greet the Voyage) and
    // before the lock request (its initial cursor decides whether there is one).
    const pending = modeId !== 'voyage' ? this.prepareMode(modeId) : null;
    this.hud.hideStartScreen();
    this.sim.setAttractMode(false);
    this.sim.setPaused(false);

    // All three must be initiated synchronously inside the user gesture (click / Enter): full
    // screen (if chosen), the pointer lock, then audio (its graph takes a few ms to build).
    if (this.settings.fullscreen) void enterFullscreen();
    if (this.cursorMode === 'locked') this.requestLock();
    else this.syncFreeCursor();
    // Volumes first so the score fades in at the saved level (not the engine default).
    this.audio.setVolumes(this.settings.musicVolume, this.settings.sfxVolume);
    this.audio.start().catch((err) => console.warn('[app] audio failed to start', err));

    rememberMode(modeId);
    // The URL names the mode actually running (a mode that could not be created leaves the Voyage).
    writeModeParam(pending ? modeId : 'voyage');
    if (pending) this.startMode(pending);
    this.refreshPauseExtras();

    if (quality !== this.settings.quality) this.applySettings({ ...this.settings, quality });
  }

  private resume(): void {
    if (this.phase !== 'paused' || this.resumeTimer !== 0) return;
    if (this.activeMode !== null && this.cursorMode === 'free') {
      this.resumeFree();
      return;
    }
    this.resumeWithLock();
  }

  /** Resume by re-capturing the pointer (Voyage Resume; game modes paused in locked flight). */
  private resumeWithLock(): void {
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
    this.lockWanted = true;
    if (this.input.locked) {
      // A deliberate release (game modes) is still landing: ask again as soon as it has.
      if (performance.now() < this.expectUnlockUntil) this.relockAfterUnlock = true;
      return;
    }
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
      this.expectUnlockUntil = 0;
      this.relockAfterUnlock = false;
      if (this.activeMode !== null && !this.lockWanted) {
        // Granted after the mode moved on (free cursor, or paused meanwhile): hand the pointer back.
        this.lockFromFree = false;
        this.releaseLockQuietly();
        return;
      }
      if (this.phase === 'paused' || this.phase === 'flying') {
        const wasPaused = this.phase === 'paused';
        const wasFree = this.cursorMode === 'free';
        this.phase = 'flying';
        this.cursorMode = 'locked';
        this.lockFromFree = false;
        this.syncFreeCursor();
        this.sim.setPaused(false);
        this.audio.setPaused(false);
        this.hud.showPause(false);
        this.hud.setResumeState('idle');
        if (wasPaused) {
          bus.emit('resume', {});
          this.modeHook((m) => m.onPause?.(false));
        }
        if (wasFree) this.modeHook((m) => m.onCursorModeChange?.('locked', false));
      }
      return;
    }
    if (!failed && performance.now() < this.expectUnlockUntil) {
      // Released on purpose (free cursor, ctx.pause()): no pause, and no Esc cooldown to wait out.
      this.expectUnlockUntil = 0;
      if (this.relockAfterUnlock) {
        this.relockAfterUnlock = false;
        this.requestLock();
      }
      return;
    }
    if (!failed) this.lastUnlockAt = performance.now();
    if (failed && this.activeMode !== null && this.phase === 'flying' && this.cursorMode === 'free') {
      // A lock request made from free-cursor play was refused: the play goes on with the cursor free.
      const fromFree = this.lockFromFree;
      this.lockFromFree = false;
      this.relockAfterUnlock = false;
      if (fromFree) this.modeHook((m) => m.onCursorModeChange?.('free', true));
      return;
    }
    if (this.phase === 'flying') this.enterPause();
    if (failed && this.phase === 'paused') this.hud.setResumeState('failed');
  }

  /** flying → paused (lock lost, Esc in free-cursor play, ctx.pause()). */
  private enterPause(): void {
    this.phase = 'paused';
    this.syncFreeCursor();
    this.sim.setPaused(true);
    this.audio.setPaused(true);
    if (this.activeMode !== null) {
      this.refreshPauseExtras();
      this.hud.setPauseFooter(this.cursorMode === 'free' ? 'Resume returns to the free cursor' : null);
    }
    this.hud.showPause(true);
    bus.emit('pause', {});
    this.modeHook((m) => m.onPause?.(true));
  }

  /** paused → flying with the cursor free (no lock request). */
  private resumeFree(): void {
    window.clearTimeout(this.resumeTimer);
    this.resumeTimer = 0;
    this.lockWanted = false;
    if (this.input.locked) this.releaseLockQuietly();
    this.phase = 'flying';
    this.syncFreeCursor();
    this.sim.setPaused(false);
    this.audio.setPaused(false);
    this.hud.showPause(false);
    this.hud.setResumeState('idle');
    bus.emit('resume', {});
    this.modeHook((m) => m.onPause?.(false));
  }

  /** Release the pointer without the unlock counting as the user leaving (no pause, no cooldown). */
  private releaseLockQuietly(): void {
    this.expectUnlockUntil = performance.now() + EXPECTED_UNLOCK_MS;
    this.input.releaseLock();
  }

  /** Free-cursor input is live only while a game mode flies with the cursor free. */
  private syncFreeCursor(): void {
    this.input.setFreeCursorActive(this.activeMode !== null && this.phase === 'flying' && this.cursorMode === 'free');
  }

  // -------------------------------------------------------------------------------------------
  // Game modes
  // -------------------------------------------------------------------------------------------

  /** Instantiate a mode and give it its context (HUD layer, overlay); enter() follows in startMode. */
  private prepareMode(id: GameModeId): { mode: GameMode; ctx: ModeContext } | null {
    let mode: GameMode;
    try {
      mode = createGameMode(id);
    } catch (err) {
      console.error(`[app] game mode "${id}" could not be created`, err);
      this.hud.flashMessage('That mode could not start · details in the console', 'warn');
      return null;
    }
    const gen = ++this.modeGen;
    this.activeMode = mode;
    this.modeEntered = false;
    this.cursorMode = mode.initialCursor === 'free' ? 'free' : 'locked';
    this.hud.setGameMode(id);
    this.input.setModeKeys(true);
    const layer = (this.modeLayer = this.hud.createModeLayer());
    // Room for long, strongly bent beams (≈ 450 points each near a photon sphere, up to 16 beams).
    const overlay = createOverlayFrame(16384, 1024, 64);
    this.renderer.setOverlay(overlay);
    const app = this;
    const live = (): boolean => gen === app.modeGen;
    const ctx: ModeContext = {
      sim: this.sim,
      audio: this.audio,
      hud: this.hud,
      layer,
      canvas: this.canvas,
      overlay,
      settings: () => app.settings,
      get cursorMode(): CursorMode {
        return app.cursorMode;
      },
      requestFlight: () => {
        if (live()) app.modeRequestFlight();
      },
      requestFreeCursor: () => {
        if (live()) app.modeRequestFreeCursor();
      },
      pause: () => {
        if (live()) app.pauseFromMode();
      },
      switchMode: (to: ModeId) => {
        if (live()) app.switchMode(to);
      },
    };
    return { mode, ctx };
  }

  /** mode.enter(); a mode that throws is torn down and the app carries on as the Voyage. */
  private startMode(p: { mode: GameMode; ctx: ModeContext }): void {
    const { mode, ctx } = p;
    try {
      mode.enter(ctx, new URLSearchParams(window.location.search));
    } catch (err) {
      console.error(`[app] game mode "${mode.id}" failed to start`, err);
      if (this.activeMode === mode) {
        this.modeEntered = true; // let exit() undo whatever enter() did
        this.exitMode();
        this.alignCursorAfterSwitch();
        writeModeParam('voyage');
      }
      this.hud.flashMessage(`${mode.title} could not start · details in the console`, 'warn');
      return;
    }
    if (this.activeMode !== mode) return; // it switched away during enter()
    this.modeEntered = true;
    if (this.phase === 'paused') {
      this.refreshPauseExtras();
      this.modeHook((m) => m.onPause?.(true));
    }
  }

  /** Leave the active mode and restore everything it may have changed. */
  private exitMode(): void {
    const mode = this.activeMode;
    if (mode === null) return;
    this.modeGen++;
    if (this.modeEntered) {
      try {
        mode.exit();
      } catch (err) {
        console.error(`[app] game mode "${mode.id}" failed to exit cleanly`, err);
      }
    }
    this.activeMode = null;
    this.modeEntered = false;
    this.pendingSwitch = null;
    this.renderer.setOverlay(null);
    this.sim.setPuppet(false);
    this.sim.setControlPolicy(null);
    this.sim.setArena(null);
    this.sim.universe.clearFrozenClocks();
    this.modeLayer?.remove();
    this.modeLayer = null;
    this.hud.setGameMode(null);
    this.hud.setPauseFooter(null);
    this.input.setModeKeys(false);
    this.lockFromFree = false;
    this.relockAfterUnlock = false;
    this.cursorMode = 'locked';
    this.syncFreeCursor();
  }

  /** Switch to another mode ('voyage' = none) in place. Deferred while mode.update() runs. */
  private switchMode(id: ModeId): void {
    if (this.phase !== 'flying' && this.phase !== 'paused') return;
    if (this.inModeUpdate) {
      this.pendingSwitch = id;
      return;
    }
    const current: ModeId = this.activeMode ? this.activeMode.id : 'voyage';
    if (id === current || !isModeId(this.modes, id)) return;
    this.exitMode();
    const pending = id !== 'voyage' ? this.prepareMode(id) : null;
    rememberMode(id);
    writeModeParam(pending ? id : 'voyage');
    this.alignCursorAfterSwitch();
    if (pending) this.startMode(pending);
    this.refreshPauseExtras();
  }

  /** In flight, bring the pointer in line with the (new) cursor mode. Paused: Resume does it. */
  private alignCursorAfterSwitch(): void {
    if (this.resumeTimer !== 0) {
      // A Resume waiting out the cooldown was for the old mode's cursor.
      window.clearTimeout(this.resumeTimer);
      this.resumeTimer = 0;
      this.hud.setResumeState('idle');
    }
    if (this.phase === 'flying') {
      if (this.cursorMode === 'locked') {
        // requestLock() is a no-op while locked, and re-asks after a quiet release still in flight.
        this.requestLock();
      } else {
        this.lockWanted = false;
        if (this.input.locked) this.releaseLockQuietly();
      }
    }
    this.syncFreeCursor();
  }

  /** ctx.requestFlight(). */
  private modeRequestFlight(): void {
    if (this.activeMode === null) return;
    if (this.phase === 'paused') {
      // From a pause action: resume into locked flight, exactly like Resume (the cursor mode
      // becomes 'locked' when the lock is granted; a refusal stays on the pause screen).
      this.pauseHandled = true;
      if (this.resumeTimer === 0) this.resumeWithLock();
      return;
    }
    if (this.phase !== 'flying') return;
    if (this.cursorMode === 'locked') {
      if (!this.input.locked) this.requestLock();
      return;
    }
    // free → locked: the cursor stays free until the lock is granted; a refusal keeps it free.
    this.lockFromFree = true;
    this.lockWanted = true;
    if (this.input.locked) {
      // The release of an earlier lock has not landed yet: ask again right after it does.
      this.relockAfterUnlock = true;
      return;
    }
    const wait = RELOCK_COOLDOWN_MS - (performance.now() - this.lastUnlockAt);
    if (wait > 0) {
      window.clearTimeout(this.resumeTimer);
      this.resumeTimer = window.setTimeout(() => {
        this.resumeTimer = 0;
        if (this.phase === 'flying' && this.cursorMode === 'free' && this.lockFromFree) this.requestLock();
      }, wait);
    } else {
      this.requestLock();
    }
  }

  /** ctx.requestFreeCursor(). */
  private modeRequestFreeCursor(): void {
    if (this.activeMode === null) return;
    window.clearTimeout(this.resumeTimer);
    this.resumeTimer = 0;
    this.lockWanted = false;
    this.lockFromFree = false;
    this.relockAfterUnlock = false;
    if (this.phase === 'paused') {
      // From a pause action: resume into free-cursor play.
      this.pauseHandled = true;
      const changed = this.cursorMode !== 'free';
      this.cursorMode = 'free';
      this.hud.setResumeState('idle');
      this.resumeFree();
      if (changed) this.modeHook((m) => m.onCursorModeChange?.('free', false));
      return;
    }
    if (this.phase !== 'flying' || this.cursorMode === 'free') return;
    this.cursorMode = 'free';
    if (this.input.locked) this.releaseLockQuietly();
    this.syncFreeCursor();
    this.modeHook((m) => m.onCursorModeChange?.('free', false));
  }

  /** ctx.pause() and Esc in free-cursor play: open the pause screen. */
  private pauseFromMode(): void {
    if (this.phase !== 'flying') return;
    window.clearTimeout(this.resumeTimer);
    this.resumeTimer = 0;
    // A lock still in the air must not end this pause when it lands.
    this.lockWanted = false;
    this.lockFromFree = false;
    this.relockAfterUnlock = false;
    if (this.input.locked) this.releaseLockQuietly();
    this.enterPause();
  }

  /** Esc in free-cursor play: the mode may consume it (close a panel) instead of pausing. */
  private modeTakesEscape(): boolean {
    const mode = this.activeMode;
    if (mode === null || !this.modeEntered || !mode.onEscape) return false;
    try {
      return mode.onEscape() === true;
    } catch (err) {
      this.warnOnce('mode-escape', err);
      return false;
    }
  }

  /** Call a mode hook (only once enter() has returned); a throwing hook never breaks the shell. */
  private modeHook(fn: (m: GameMode) => void): void {
    const mode = this.activeMode;
    if (mode === null || !this.modeEntered) return;
    try {
      fn(mode);
    } catch (err) {
      this.warnOnce('mode-hook', err);
    }
  }

  /** Pause-screen extras: the mode's actions, the mode switch, and the controls table. */
  private refreshPauseExtras(): void {
    const mode = this.activeMode;
    const buttons: PauseButton[] = [];
    if (mode !== null && this.modeEntered && mode.pauseActions) {
      try {
        for (const a of mode.pauseActions()) {
          buttons.push({ id: a.id, label: a.label, run: () => this.runPauseAction(() => a.run()) });
        }
      } catch (err) {
        this.warnOnce('pause-actions', err);
      }
    }
    const current: ModeId = mode ? mode.id : 'voyage';
    for (const m of this.modes) {
      if (m.id === current) continue;
      buttons.push({
        id: `switch-${m.id}`,
        label: `Switch to ${m.title}`,
        kind: 'switch',
        run: () => this.runPauseAction(() => this.switchMode(m.id)),
      });
    }
    this.hud.setPauseMode(buttons, mode ? mode.controls : null);
  }

  /**
   * A pause-screen button: run it, then close the pause screen the way Resume would (into the
   * cursor mode active when the pause began — or the new mode's) unless it already decided.
   */
  private runPauseAction(fn: () => void): void {
    if (this.phase !== 'paused') return;
    this.pauseHandled = false;
    try {
      fn();
    } catch (err) {
      console.error('[app] pause action failed', err);
    }
    if (this.phase === 'paused' && !this.pauseHandled && this.resumeTimer === 0) this.resume();
    this.pauseHandled = false;
  }

  // -------------------------------------------------------------------------------------------

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

  /**
   * In flight without the lock (a request still in the air or silently dropped): click to engage.
   * Never in free-cursor play (the canvas is the mode's pointer surface then).
   */
  private onCanvasClick = (): void => {
    if (this.phase === 'flying' && !this.input.locked && this.cursorMode === 'locked') this.requestLock();
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
    if (this.sim && this.renderer && this.input && this.hud) this.exitMode();
    this.input?.dispose();
    this.audio.dispose();
    this.renderer?.dispose();
    this.hud?.dispose();
  }
}
