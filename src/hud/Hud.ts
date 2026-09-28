/**
 * HUD / UI entry point (ARCHITECTURE.md §3.8): start screen, in-flight instruments, target
 * brackets, pulse markers, codex, banners & messages, pause/settings overlay.
 *
 * Performance model: DOM is built up-front (marker pools included); per frame only transforms
 * and opacities are written, and only when they change; text refreshes at ~15 Hz. Layout reads
 * happen at the very start of update() (before any writes) so they never force a sync layout.
 */
import '@fontsource/rajdhani/300.css';
import '@fontsource/rajdhani/400.css';
import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/inter/wght-italic.css';
import '../styles/base.css';
import '../styles/start.css';
import '../styles/flight.css';
import '../styles/panels.css';

import * as THREE from 'three';
import { bus } from '../core/events';
import { clamp } from '../core/math';
import type {
  AppSettings,
  CodexEntry,
  NebulaDef,
  NebulaRuntime,
  QualityName,
  SimState,
} from '../core/types';
import { PHYSICS_TIPS, VOID_FACTS } from '../content/codex';
import { CodexPanel, type CodexContext } from './Codex';
import { ClassSlot, el } from './dom';
import { nebulaTypeLine } from './format';
import { TargetTracker, PulseMarkers, type Viewport } from './Markers';
import { FlashQueue, HintsOverlay, RegionBanner, VoidFacts } from './Messages';
import { PauseScreen, type ResumeState } from './PauseScreen';
import { EnvBlock, LocationBlock, PerfReadout, SpeedBlock, WormholeOverlay, zoomDepth } from './Readouts';
import { Reticle } from './Reticle';
import { StartScreen } from './StartScreen';

export interface HudOptions {
  nebulae: NebulaDef[];
  codex: Record<string, CodexEntry>;
  settings: AppSettings;
  onLaunch: (quality: QualityName) => void;
  onResume: () => void;
  onSettingsChange: (s: AppSettings) => void;
}

type TipKey = 'hyper' | 'aberration' | 'lensing' | 'timeDilation' | 'wormhole' | 'pulse' | 'scale';

const TIP_LABELS: Record<TipKey, string> = {
  hyper: 'Relativity',
  aberration: 'Relativistic aberration',
  lensing: 'Gravitational lensing',
  timeDilation: 'Time dilation',
  wormhole: 'Einstein–Rosen bridge',
  pulse: 'Resonance pulse',
  scale: 'Self-similarity',
};

/** Text refresh interval (s). */
const TEXT_INTERVAL = 1 / 15;
/** Zoom depth (decades) that triggers the "scale" tip. */
const SCALE_TIP_DEPTH = 2.5;
/** Wall-clock seconds after launch during which a region entry never opens the codex by itself. */
const LAUNCH_QUIET_S = 4;

export class Hud {
  private readonly root: HTMLElement;
  private readonly flight: HTMLElement;
  private readonly flightLive: ClassSlot;
  private readonly flightHidden: ClassSlot;
  private readonly flightWormhole: ClassSlot;
  private readonly opts: HudOptions;
  private settings: AppSettings;
  private readonly defs = new Map<string, NebulaDef>();
  private readonly byId = new Map<string, NebulaRuntime>();
  private runtimes: NebulaRuntime[] | null = null;

  private readonly start: StartScreen;
  private readonly pause: PauseScreen;
  private readonly reticle: Reticle;
  private readonly location: LocationBlock;
  private readonly speed: SpeedBlock;
  private readonly env: EnvBlock;
  private readonly wormhole: WormholeOverlay;
  private readonly perf: PerfReadout;
  private readonly target: TargetTracker;
  private readonly pulseMarkers: PulseMarkers;
  private readonly codex: CodexPanel;
  private readonly banner: RegionBanner;
  private readonly flash: FlashQueue;
  private readonly voidFacts: VoidFacts;
  private readonly hints: HintsOverlay;

  private readonly projCam = new THREE.PerspectiveCamera(70, 16 / 9, 1e-6, 1e6);
  private readonly shakeEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly shakeQuat = new THREE.Quaternion();
  private readonly vp: Viewport = { w: 1, h: 1, margin: 40, rightInset: 0 };
  private vpDirty = true;
  private codexMeasuredOpen = false;

  private launched = false;
  /** performance.now() / 1000 at launch. */
  private launchAt = 0;
  private readonly timers: number[] = [];
  private visible = true;
  private lastNow = 0;
  private textAcc = 0;
  private lastState: SimState | null = null;
  private readonly visited = new Set<string>();
  private readonly tipsShown = new Set<TipKey>();
  private hyperCount = 0;
  /** Autopilot session as announced on the bus (only used to word the end message). */
  private autopilotMode: 'target' | 'voyage' | null = null;
  /** Target the glide arrived at and now orbits; the chip says "Orbit" while it still does. */
  private orbitId: string | null = null;
  /**
   * Destination of the current target glide (autopilotStart payload). The glide keeps going when
   * the lock is cleared (a click on empty space), so the chip falls back to it instead of reading
   * "Gravity-glide → target" while the ship still flies to / orbits a named nebula.
   */
  private glideId: string | null = null;
  /** Region entered mid-wormhole (the sim teleports at 50 %): revealed when the transit ends. */
  private pendingRegion: string | null = null;
  private readonly unsubs: (() => void)[] = [];

  constructor(root: HTMLElement, opts: HudOptions) {
    this.root = root;
    this.opts = opts;
    this.settings = { ...opts.settings };
    for (const d of opts.nebulae) this.defs.set(d.id, d);

    root.classList.add('fn-hud');
    root.replaceChildren();

    // In-flight layer (pointer-events: none throughout, except the codex scroller).
    const flight = (this.flight = el('div', 'fn-flight', root));
    this.flightLive = new ClassSlot(flight, 'is-live');
    this.flightHidden = new ClassSlot(flight, 'is-hidden');
    this.flightWormhole = new ClassSlot(flight, 'in-wormhole');
    this.pulseMarkers = new PulseMarkers(flight);
    this.target = new TargetTracker(flight);
    this.reticle = new Reticle(flight);
    this.banner = new RegionBanner(flight);
    this.location = new LocationBlock(flight);
    const bottomLeft = el('div', 'fn-bl', flight);
    this.voidFacts = new VoidFacts(bottomLeft, Array.isArray(VOID_FACTS) ? VOID_FACTS : []);
    this.env = new EnvBlock(bottomLeft);
    this.speed = new SpeedBlock(flight);
    this.flash = new FlashQueue(flight);
    this.wormhole = new WormholeOverlay(flight);
    this.hints = new HintsOverlay(flight, this.settings.showHints);
    this.perf = new PerfReadout(flight);
    this.codex = new CodexPanel(flight, opts.codex, this.defs);

    this.pause = new PauseScreen(root, this.settings, () => opts.onResume(), (s) => this.onPauseSettings(s));
    this.start = new StartScreen(root, this.settings.quality, (q) => opts.onLaunch(q), this.settings.fullscreen, (on) =>
      this.onPauseSettings({ ...this.settings, fullscreen: on }),
    );

    this.subscribe();
    window.addEventListener('resize', this.onResize);
    document.addEventListener('mousedown', this.onMouseDown);
  }

  // -------------------------------------------------------------------------------------------
  // Public API (§3.8)
  // -------------------------------------------------------------------------------------------

  update(
    state: SimState,
    nebulae: NebulaRuntime[],
    camera: THREE.PerspectiveCamera,
    stats: { fps: number; renderScale: number },
  ): void {
    this.lastState = state;
    const now = performance.now() / 1000;
    // HUD timers (messages, codex auto-hide, hints) are for human reading, so they follow the wall
    // clock even at low frame rates (the sim clamps its dt to 0.1 s); 0.5 s caps tab-switch jumps.
    const rdt = this.lastNow > 0 ? clamp(now - this.lastNow, 0, 0.5) : 0;
    this.lastNow = now;
    if (nebulae !== this.runtimes) this.bind(nebulae);
    if (!this.launched) return;

    // ---- read phase (layout reads before any writes this frame) ----
    if (this.vpDirty) {
      this.vpDirty = false;
      const w = Math.max(1, window.innerWidth || 1);
      const h = Math.max(1, window.innerHeight || 1);
      this.vp.w = w;
      this.vp.h = h;
      this.vp.margin = Math.round(clamp(0.022 * Math.min(w, h * (16 / 9)), 16, 56)) + 22;
      this.codex.invalidateLayout();
      this.codexMeasuredOpen = !this.codex.open; // force a width re-measure below
    }
    this.codex.readPhase();
    if (this.codex.open !== this.codexMeasuredOpen) {
      this.codexMeasuredOpen = this.codex.open;
      const cw = this.codex.measureWidth();
      this.vp.rightInset = cw > 0 ? cw + 12 : 0;
    }

    // ---- SimState is the source of truth; bus events only make changes feel immediate ----
    this.reconcile(state);

    // ---- timers (flight time freezes while paused) ----
    const fdt = state.paused ? 0 : rdt;
    this.textAcc += rdt;
    const textTick = this.textAcc >= TEXT_INTERVAL;
    if (textTick) this.textAcc = Math.min(this.textAcc - TEXT_INTERVAL, TEXT_INTERVAL);

    const codexRt = this.codex.id ? this.byId.get(this.codex.id) : undefined;
    this.codex.update(fdt, textTick && codexRt ? codexRt.distance : NaN);
    if (textTick) this.syncCodexSubject(state);

    this.perf.update(rdt, stats);
    this.flash.update(fdt);
    this.hints.update(fdt, this.codex.open);
    const inVoid = state.env.regionId === null && !state.wormhole.active && state.env.blackHoleId === null;
    this.voidFacts.update(fdt, inVoid);

    if (state.paused || !this.visible) return;

    // ---- per-frame positioning ----
    this.syncCamera(state, camera);
    this.flightWormhole.set(state.wormhole.active);
    this.reticle.setHyper(state.ship.hyper);
    this.speed.frame(state);
    this.wormhole.frame(state);
    const tid = this.target.targetId;
    this.target.update(state, tid ? this.byId.get(tid) : undefined, this.projCam, this.vp, textTick);
    this.pulseMarkers.update(state, this.projCam, this.vp, textTick, tid);

    if (textTick) {
      const region = state.env.regionId ? this.byId.get(state.env.regionId) ?? null : null;
      const nearest = state.env.nearestId ? this.byId.get(state.env.nearestId) ?? null : null;
      this.location.update(state, region, nearest);
      // In target mode the sim keeps state.target.id on the glide's destination (a new lock
      // re-routes the glide); only a cleared lock leaves the glide without a target id.
      const glide = state.ship.autopilot === 'target' ? state.target.id ?? this.glideId : null;
      const orbiting = glide !== null && glide === this.orbitId;
      this.speed.text(state, this.nameOf, orbiting, glide);
      this.env.update(state, this.nameOf);
      this.wormhole.text(state, this.nameOf);
      this.watchFirsts(state, nearest);
    }
  }

  setLoadingProgress(p: number, label: string): void {
    this.start.setProgress(p, label);
  }

  setReady(): void {
    this.start.setReady();
  }

  /** Loading failed: say so on the start screen instead of leaving a frozen progress bar. */
  setLoadError(message: string): void {
    this.start.setError(message);
  }

  hideStartScreen(): void {
    if (this.launched) return;
    this.launched = true;
    this.launchAt = performance.now() / 1000;
    this.start.hide();
    this.vpDirty = true;
    this.hints.restart();
    // Let the start screen begin its exit before the instruments fade in.
    this.timers.push(
      window.setTimeout(() => this.flightLive.set(true), 450),
      window.setTimeout(() => this.flash.push('Gravity drive online · the universe is yours to drift', 'info'), 1600),
    );
  }

  showPause(show: boolean): void {
    this.pause.show(show);
    this.root.classList.toggle('is-paused', show);
  }

  /** Pointer re-capture feedback on the pause card ('pending' while engaging, 'failed' if refused). */
  setResumeState(state: ResumeState): void {
    this.pause.setResumeState(state);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.flightHidden.set(!v);
  }

  toggleVisible(): void {
    this.setVisible(!this.visible);
  }

  toggleCodex(): void {
    const subject = this.lastState ? this.codexSubject(this.lastState) : null;
    if (!this.codex.toggle(subject)) {
      this.flash.push('No nebula in range · left-click one to open its codex', 'info');
    }
  }

  flashMessage(text: string, kind: 'info' | 'warn' = 'info'): void {
    this.flash.push(text, kind);
  }

  /** Not part of the frame contract; releases listeners and DOM. */
  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const t of this.timers) window.clearTimeout(t);
    this.timers.length = 0;
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('mousedown', this.onMouseDown);
    this.target.dispose();
    this.banner.dispose();
    this.start.dispose();
    this.pause.dispose();
    this.root.replaceChildren();
    this.root.classList.remove('fn-hud', 'is-paused');
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private bind(nebulae: NebulaRuntime[]): void {
    this.runtimes = nebulae;
    this.byId.clear();
    for (const rt of nebulae) {
      this.byId.set(rt.def.id, rt);
      if (!this.defs.has(rt.def.id)) this.defs.set(rt.def.id, rt.def);
    }
    this.pulseMarkers.bind(nebulae);
  }

  private readonly nameOf = (id: string | null): string | null =>
    id === null ? null : this.defs.get(id)?.name ?? null;

  private typeLine(id: string): string {
    const def = this.defs.get(id);
    return def ? nebulaTypeLine(def, this.byId.get(id)) : '';
  }

  /** Mirror the render camera for THIS frame's state (the renderer updates its camera later). */
  private syncCamera(state: SimState, fallback: THREE.PerspectiveCamera): void {
    const cam = this.projCam;
    const o = state.ship.orientation;
    if (Number.isFinite(o.x + o.y + o.z + o.w) && o.lengthSq() > 1e-12) cam.quaternion.copy(o);
    else cam.quaternion.copy(fallback.quaternion);
    const s = state.camera.shake;
    if (Number.isFinite(s.x + s.y + s.z)) {
      this.shakeEuler.set(s.x, s.y, s.z, 'YXZ');
      this.shakeQuat.setFromEuler(this.shakeEuler);
      cam.quaternion.multiply(this.shakeQuat);
    }
    cam.quaternion.normalize();
    cam.position.set(0, 0, 0);
    const fov = state.camera.fovDeg;
    cam.fov = Number.isFinite(fov) ? clamp(fov, 15, 150) : fallback.fov;
    cam.aspect = this.vp.w / this.vp.h;
  }

  private codexSubject(state: SimState): { id: string; context: CodexContext } | null {
    if (state.target.id && this.defs.has(state.target.id)) return { id: state.target.id, context: 'target' };
    if (state.env.regionId && this.defs.has(state.env.regionId)) return { id: state.env.regionId, context: 'region' };
    if (state.env.nearestId && this.defs.has(state.env.nearestId)) return { id: state.env.nearestId, context: 'nearest' };
    return null;
  }

  private syncCodexSubject(state: SimState): void {
    if (!this.codex.open) return;
    const s = this.codexSubject(state);
    if (s) this.codex.setContent(s.id, s.context);
  }

  /** Show a physics tip once. While the HUD is hidden (H) it is not consumed: it fires next time. */
  private tip(key: TipKey): void {
    if (this.tipsShown.has(key) || !this.visible) return;
    const text = (PHYSICS_TIPS as Partial<Record<TipKey, string>> | undefined)?.[key];
    if (!text) return;
    this.tipsShown.add(key);
    this.flash.push(text, 'tip', TIP_LABELS[key]);
  }

  private watchFirsts(state: SimState, nearest: NebulaRuntime | null): void {
    const td = state.env.timeDilation;
    if (Number.isFinite(td) && td < 0.98) this.tip('timeDilation');
    if (state.env.regionId !== null && zoomDepth(nearest, state.env.surfaceDistance) >= SCALE_TIP_DEPTH) this.tip('scale');
  }

  private onPauseSettings(s: AppSettings): void {
    this.applySettings(s);
    this.opts.onSettingsChange({ ...s });
  }

  private applySettings(s: AppSettings): void {
    this.settings = { ...s };
    this.hints.setEnabled(s.showHints);
  }

  /**
   * Flight events. Nothing is shown before launch (the attract-mode sim is silent anyway, but a
   * stray event must never queue a banner, tip or codex card behind the start screen). Statuses
   * that must never get stuck are additionally reconciled from SimState every frame (reconcile).
   */
  private subscribe(): void {
    const on = this.unsubs;
    const flying = <T>(fn: (payload: T) => void) => (payload: T): void => {
      if (this.launched) fn(payload);
    };
    on.push(bus.on('regionEnter', flying(({ id }) => {
      if (this.lastState?.wormhole.active) this.pendingRegion = id;
      else this.onRegionEnter(id);
    })));
    on.push(bus.on('regionExit', flying(({ id }) => {
      if (this.pendingRegion === id) this.pendingRegion = null;
      if (this.lastState?.wormhole.active) return; // the tunnel itself says we left
      const name = this.nameOf(id);
      if (name) this.banner.exit(name);
    })));
    on.push(bus.on('targetLock', flying(({ id }) => this.onTargetLock(id))));
    on.push(bus.on('targetClear', flying(() => this.onTargetClear())));
    on.push(bus.on('pulse', flying(() => {
      this.reticle.pulseRings();
      this.pulseMarkers.reveal();
      this.tip('pulse');
    })));
    on.push(bus.on('autopilotStart', flying(({ mode, id }) => {
      this.autopilotMode = mode;
      this.orbitId = null;
      this.glideId = mode === 'target' ? id : null;
      if (mode === 'target') this.flash.push(`Gravity-glide → ${this.nameOf(id) ?? 'target'}`, 'info');
      else this.flash.push('Voyage mode · sit back and drift', 'info');
    })));
    on.push(bus.on('autopilotEnd', flying(({ reason }) => {
      const mode = this.autopilotMode;
      this.autopilotMode = null;
      if (mode === null) return;
      if (reason === 'arrived' && mode === 'target') {
        this.orbitId = this.lastState?.target.id ?? this.glideId;
        const name = this.nameOf(this.orbitId);
        this.flash.push(name ? `Arrived · ${name}` : 'Arrived', 'info');
      } else if (reason === 'cancelled') {
        this.flash.push('Autopilot disengaged · manual flight', 'info');
      }
    })));
    on.push(bus.on('hyperStart', flying(() => {
      this.hyperCount++;
      if (!this.tipsShown.has('aberration')) this.tip('aberration');
      else if (this.hyperCount >= 3) this.tip('hyper');
    })));
    on.push(bus.on('horizonWarning', flying(() => {
      this.flash.push('Event horizon proximity — hold right mouse to escape', 'warn');
    })));
    on.push(bus.on('wormholeStart', flying(() => {
      this.flash.clearStatus();
      this.flash.push('Wormhole transit · Einstein–Rosen bridge', 'info');
    })));
    on.push(bus.on('wormholeEnd', flying(({ toId }) => {
      const name = this.nameOf(toId);
      if (name) this.flash.push(`Emerged near ${name}`, 'info');
      this.flushPendingRegion();
      this.tip('wormhole');
    })));
    on.push(bus.on('settingsChanged', ({ settings }) => {
      this.applySettings(settings);
      this.pause.sync(settings);
      this.start.setFullscreen(settings.fullscreen);
    }));
  }

  /**
   * Per-frame reconciliation with SimState (after launch), so a missed or never-emitted event
   * can't leave a stale status: the target tracker follows state.target.id (lock / unlock /
   * switch with the same animations as the events), autopilot bookkeeping ends when the sim's
   * pilot is off, and a region entered mid-wormhole is revealed once the transit is over.
   * Cheap: a few comparisons; DOM is only touched on an actual change.
   */
  private reconcile(state: SimState): void {
    const sid = state.target.id;
    const want = sid !== null && this.defs.has(sid) ? sid : null;
    if (want !== this.target.targetId) {
      if (want === null) this.onTargetClear();
      else this.onTargetLock(want);
    }
    if (state.ship.autopilot !== 'target') {
      this.orbitId = null;
      this.glideId = null;
      if (state.ship.autopilot === 'off') this.autopilotMode = null;
    }
    if (this.pendingRegion !== null && !state.wormhole.active) this.flushPendingRegion();
  }

  private onTargetLock(id: string): void {
    const def = this.defs.get(id);
    if (!def) return;
    const kind = this.opts.codex[id]?.fractalName || this.typeLine(id);
    this.target.lock(id, def.name, kind);
    // A lock is always a deliberate act (click, Space-hold, T, a voyage leg) — the sim clears the
    // target silently at launch — so its card opens even right after launch; only region entries
    // observe the post-launch quiet window.
    if (this.launched) this.codex.show(id, 'target', true);
  }

  private onTargetClear(): void {
    this.target.clear();
    // Only an auto-opened *target* card goes with the target; a region card stays (and auto-hides).
    if (this.codex.open && !this.codex.pinned && this.codex.context === 'target') this.codex.close();
  }

  private flushPendingRegion(): void {
    const pending = this.pendingRegion;
    this.pendingRegion = null;
    if (pending !== null && this.lastState?.env.regionId === pending) this.onRegionEnter(pending);
  }

  /** A region card opens by itself only in flight, and never in the first seconds after launch. */
  private autoCodexAllowed(): boolean {
    return this.launched && performance.now() / 1000 - this.launchAt >= LAUNCH_QUIET_S;
  }

  private onRegionEnter(id: string): void {
    const def = this.defs.get(id);
    if (!def) return;
    this.voidFacts.hide();
    this.banner.enter({
      catalog: def.catalog,
      name: def.name,
      typeLine: this.typeLine(id),
      tagline: def.tagline,
      blackHole: def.fractal === 'blackhole',
    });
    if (!this.visited.has(id)) {
      // A region you start in (entered at launch) counts as visited: its card is not forced on you.
      this.visited.add(id);
      const tid = this.lastState?.target.id ?? null;
      if (this.autoCodexAllowed() && (tid === null || tid === id)) {
        this.codex.show(id, tid === id ? 'target' : 'region', true);
      }
    }
    if (def.fractal === 'blackhole') this.tip('lensing');
  }

  private onResize = (): void => {
    this.vpDirty = true;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0 && this.launched && document.pointerLockElement) this.reticle.clickPulse();
  };
}
