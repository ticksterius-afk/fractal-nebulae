/**
 * First Light — the game mode (design/20-first-light.md §4–§5, design/60-first-light-build.md §M).
 *
 * State machine:  atlas → (loading) → entering → playing (flight ⇄ lab) → ceremony → solved
 *  - atlas     level select (FirstLightHud.showAtlas), free cursor, the ship held still;
 *  - loading   the daily is being generated;
 *  - entering  fade, frozen clock set while the ship is puppeted, a 2.5 s glide to the vantage while
 *              the beam draws itself and a pulse reveals the seeds, then the puppet is released;
 *  - playing   placement in flight (reticle ray, pointer-locked) or in the lab view (orbit camera,
 *              free cursor). The view follows the cursor mode: locked ⇔ flight, free ⇔ lab;
 *  - ceremony  ~3 s ignition: seeds swell, accent lights ramp, a pulse leaves the last seed;
 *  - solved    the solved card (Next / Replay / Atlas; the HUD owns Enter on it).
 * First-timers go straight into the first level of Bend; returning players open the Atlas; URL
 * params `level=<id>` and `daily=<YYYY-MM-DD|today>` start a level / the daily directly.
 *
 * Everything spatial runs in the LOCAL frame of the level's nebula (see LabView.ts): the tracer,
 * legality (the solver's placementIssue, so the gates and the game agree), the lab camera and the
 * overlay. Retrace: full on every committed change, coarse at ≤ 20 Hz while dragging.
 *
 * Wiring: Simulation (puppet, arena, policy, pulse), Universe (frozen clock), OverlayFrame (OverlayFeed),
 * FirstLightHud, GameAudio, OverviewCamera (LabView), save / daily / share (progress.ts).
 * Per-frame code is allocation-free; traces, history snapshots and HUD panels allocate on events only.
 */
import * as THREE from 'three';
import type { NebulaRuntime, SimState, Vec3 } from '../../core/types';
import type { ControlDef } from '../../hud/controls';
import { MOUSE_LEFT, MOUSE_RIGHT, type InputFrame } from '../../ship/Input';
import { GameAudio } from '../../audio/GameAudio';
import { lookRotation } from '../../sim/quat';
import type { CursorMode, GameMode, ModeContext, PauseAction } from '../platform/GameMode';
import { dailyId, nextInText, parseDailyParam } from '../platform/daily';
import { buildShare, copyText, dailyShareUrl, formatTime } from '../platform/share';
import { FirstLightHud } from './hud/FirstLightHud';
import type { FirstLightHudCallbacks, LevelHeader, MassChip, PlayHudState, SeedChip, SolvedCard } from './hud/hudTypes';
import { MASS_SIZES, type ChapterDef, type LevelDef, type MassSize, type TraceResult, type TraceWorld } from './types';
import { budgetCount, rhoOf, sanitizeLevel } from './Level';
import { makeTraceWorld } from './world';
import { traceLevel } from './BeamTracer';
import { CHAPTERS, chapterSeedBase, findLevel, nextLevelAfter } from './chapters';
import { dailyInfo, loadDaily, type DailyInfo } from './DailyGen';
import { cancelDailyGeneration, generateDailyAsync } from './dailyClient';
import {
  buildAtlasModel,
  currentStreak,
  isFirstTime,
  loadProgress,
  markTip,
  nebulaName,
  recordDaily,
  recordSolve,
  saveProgress,
  syncProgress,
  type FirstLightProgress,
} from './progress';
import { PROGRESS_KEY } from '../platform/save';
import { LabView, LocalView, localToWorld, quatLocalToWorld, quatWorldToLocal, worldToLocal, type ScreenPos } from './LabView';
import { createPlacementPoint, dropToSurface, flightPlacementPoint, hoveredMass, labPlacementPoint, Placement, PLACEMENT } from './Placement';
import { Ceremony } from './Ceremony';
import { createFeedState, FEED, OverlayFeed, type FeedState } from './OverlayFeed';

// ---------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------

export const FL = {
  /** Entry: fade out, glide, fade in (s); the glide starts up to `glideBack` × R behind the vantage. */
  fadeOut: 0.35,
  glide: 2.5,
  fadeIn: 0.6,
  glideBack: 0.6,
  /** Backspace in flight: glide back to the vantage (s). */
  returnGlide: 1.4,
  /**
   * Fixed cruise throttle in arenas (wheel → placement depth instead). Tuned headlessly with the
   * flight model (vantage → freest direction): 1 R of open arena takes ~3–5 s, so crossing an arena
   * takes ~6–10 s; 0.6 (the plan's first guess) took 9–27 s.
   */
  throttle: 1,
  /** Arena soft bounds reach at least this × the vantage's distance from the centre (no idle drift there). */
  boundsVantage: 1.08,
  /** Hint chip after this long on a level (s). */
  hintAfter: 120,
  /** Space pulse: in-world markers for this long (s); the wavefront radius (× R). */
  pulseSeconds: 10,
  pulseRadius: 1.6,
  /** Space-pulse wavefront brightness: the arena sits in dense gas, where a full Voyage pulse washes out the view. */
  pulseGain: 0.35,
  /** Ceremony pulse radius (× R) and brightness. */
  ceremonyPulse: 1.4,
  ceremonyPulseGain: 0.3,
  /** Coarse retrace interval while dragging (s). */
  coarseEvery: 0.05,
  /** A full trace slower than this (ms) three times running is logged once. */
  slowTraceMs: 8,
  /** Physics tips: one at a time, at least this far apart (s). */
  tipGap: 12,
  /** Lab RMB: a press that travels less than this (px) is a click (remove). */
  clickPx: 5,
} as const;

/**
 * Rules of thumb shown the first time each thing happens in play. The levels carry the history (Eddington,
 * the photon sphere, Hero, Ibn al-Haytham) in their own tips; these say how to use the physics.
 */
const TIPS: Record<string, { label: string; text: string }> = {
  bend: {
    label: 'Bending light',
    text: 'A pass at distance b turns light by α ≈ 2 rₛ / b: halve the distance and the bend doubles. A mass pulls light toward itself, never away.',
  },
  capture: {
    label: 'Swallowed',
    text: 'Light that passes closer than about 2.6 rₛ falls in instead of turning. Give the beam more room, or use a second, gentler bend.',
  },
  reflection: {
    label: 'Bounces',
    text: 'Each bounce keeps 70 % of the light and a seed needs 30 %: three bounces is the most a beam can afford.',
  },
  ring: {
    label: 'Einstein ring',
    text: 'Grazing a mass, light bends so hard that the image behind it smears into a ring: the Einstein ring (Chwolson 1924, Einstein 1936).',
  },
};

const CONTROLS: ControlDef[] = [
  { keys: ['LMB'], action: 'Place the selected mass · grab / drag a placed one', short: 'Place · drag', hint: true },
  { keys: ['RMB'], action: 'Remove the hovered mass (flight) · orbit, click a mass to remove (lab view)', short: 'Remove · orbit', hint: true },
  { keys: ['WHEEL'], action: 'Placement depth · grab distance (flight) · dolly (lab view)', short: 'Depth · dolly', hint: true },
  { keys: ['1', '2', '3'], action: 'Select a light / medium / heavy mass', short: 'Mass size', hint: true },
  { keys: ['X'], action: 'Remove the hovered mass, else the last placed', short: 'Remove', hint: false },
  { keys: ['Z'], action: 'Undo · Shift+Z redo (also Ctrl+Z / Ctrl+Y)', short: 'Undo / redo', hint: true },
  { keys: ['C'], action: 'Clear every mass (undoable)', short: 'Clear', hint: false },
  { keys: ['Tab'], action: 'Lab view (free cursor) ⇄ flight', short: 'Lab view', hint: true },
  { keys: ['Backspace'], action: 'Glide back to the vantage · re-frame the lab view', short: 'Vantage', hint: false },
  { keys: ['Space'], action: 'Pulse: light up every seed and mass for 10 s', short: 'Pulse', hint: false },
  { keys: ['?'], action: 'Hint (three steps, opt-in)', short: 'Hint', hint: true },
  { keys: ['I'], action: 'Codex card of the nebula', short: 'Codex', hint: false },
  { keys: ['W', 'A', 'S', 'D'], action: 'Fly (slow) · R / F rise / sink · Shift precise', short: 'Fly', hint: true },
];

type Phase = 'atlas' | 'loading' | 'entering' | 'playing' | 'ceremony' | 'solved';
type DragKind = 'none' | 'grab' | 'lab';

interface FlDevHook {
  load(id: string): boolean;
  daily(date?: string): void;
  solve(): boolean;
  place(size: MassSize, localPos: Vec3): string | null;
  clear(): void;
  state(): Record<string, unknown>;
  lab(on: boolean): void;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);

// Scratch (allocation-free frames).
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _foot = new THREE.Vector3();
const _pt = createPlacementPoint();
const _sp: ScreenPos = { x: 0, y: 0, depth: 0 };

export class FirstLightMode implements GameMode {
  readonly id = 'firstlight' as const;
  readonly title = 'First Light';
  readonly tagline = 'Bend starlight with gravity to wake the dark seeds';
  readonly controls: ControlDef[] = CONTROLS;

  /** Returning players start in the Atlas (free cursor); first-timers and URL levels fly in. */
  get initialCursor(): CursorMode {
    return this.startPlan().kind === 'atlas' ? 'free' : 'locked';
  }

  private ctx: ModeContext | null = null;
  private hud: FirstLightHud | null = null;
  private audio: GameAudio | null = null;
  private feed: OverlayFeed | null = null;
  private progress: FirstLightProgress = loadProgress();
  private fade: HTMLElement | null = null;
  private fadeShown = -1;

  private phase: Phase = 'atlas';
  /** Phase to return to when the Atlas closes. */
  private atlasReturn: Phase = 'playing';

  // ---- level ----
  private level: LevelDef | null = null;
  private chapter: ChapterDef | null = null;
  private daily: string | null = null;
  private dailyMeta: DailyInfo | null = null;
  private world: TraceWorld | null = null;
  private placement: Placement | null = null;
  private result: TraceResult | null = null;
  private committed: TraceResult | null = null;
  private fullVersion = -1;
  private tracedVersion = -1;
  private lastCoarse = -1;
  private slowCount = 0;
  private slowLogged = false;
  private seedBase = 0;
  private pending: { level: LevelDef; daily: string | null } | null = null;
  private loadToken = 0;

  // ---- time ----
  private clock = 0;
  private levelTime = 0;
  private dailyElapsed = 0;
  private timerSecond = -1;
  private timerText = '0:00';

  // ---- camera ----
  private readonly view = new LocalView();
  private readonly lab = new LabView();
  private puppetOn = false;
  /** Entry / Backspace glide (LOCAL): t in seconds, from → to. */
  private glideT = -1;
  private glideDur = 1;
  private readonly glideFrom = new THREE.Vector3();
  private readonly glideTo = new THREE.Vector3();
  private readonly glideQFrom = new THREE.Quaternion();
  private readonly glideQTo = new THREE.Quaternion();
  private glideClip = 0;
  private glideIsEntry = false;
  private entryT = 0;
  private entryReady = false;
  private entryPulsed = false;
  private fadeOutDur: number = FL.fadeOut;
  /** Hold the ship still (atlas, card, ceremony in flight view): LOCAL pose (or world when no level). */
  private hold = false;
  private readonly holdPos = new THREE.Vector3();
  private readonly holdQuat = new THREE.Quaternion();
  private holdLocal = false;
  /** requestFlight() is out: don't fall back to the lab view until the App answers (or 4 s pass). */
  private lockPending = false;
  private lockPendingAt = 0;
  private wasLab = false;
  private cssW = 1280;
  private cssH = 720;

  // ---- placement interaction ----
  private selected: MassSize = 'medium';
  private depthMul = 1;
  private hover = -1;
  private drag: DragKind = 'none';
  private grabDist = 0;
  private readonly grabOffset = new THREE.Vector3();
  private readonly lastTarget = new THREE.Vector3();
  private labDepth = 0;
  /** Lab drag: the cursor (precision-scaled), the mass's screen offset from it, and whether it moved yet. */
  private dragX = 0;
  private dragY = 0;
  private dragOffX = 0;
  private dragOffY = 0;
  private dragLive = false;
  private rmbDown = false;
  private rmbTravel = 0;
  private rmbHover = -1;
  private placementIssue: string | null = null;
  private gauge: number | null = null;
  private previewOk = false;

  // ---- hints, tips, pulse, ceremony ----
  private hintLevel = 0;
  private help = false;
  private pulseLeft = 0;
  private readonly tipQueue: string[] = [];
  private tipCooldown = 0;
  private readonly ceremony = new Ceremony();
  private shareText = '';
  private lastSeed: Vec3 | null = null;

  // ---- view-models (mutated in place) ----
  private readonly feedState: FeedState = createFeedState(this.view);
  private readonly play: PlayHudState = {
    view: 'flight',
    seeds: [],
    masses: [],
    selected: 'medium',
    placement: null,
    depth: null,
    hintAvailable: false,
    hintLevel: 0,
    timer: null,
    canUndo: false,
    canRedo: false,
    dragging: false,
  };
  private readonly placementView: { legal: boolean; reason: string | null } = { legal: true, reason: null };
  private readonly seedIndex: number[] = [];

  // -------------------------------------------------------------------------------------------
  // GameMode
  // -------------------------------------------------------------------------------------------

  enter(ctx: ModeContext, params: URLSearchParams): void {
    this.ctx = ctx;
    this.progress = loadProgress();
    this.audio = new GameAudio(ctx.audio);
    this.feed = new OverlayFeed(ctx.overlay);
    this.feed.clear();
    ctx.overlay.visible = true;
    const fade = (this.fade = document.createElement('div'));
    fade.className = 'flm-fade';
    ctx.layer.appendChild(fade);
    this.hud = new FirstLightHud(ctx.layer, this.callbacks());
    this.measureCanvas();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('storage', this.onStorage);
    this.installDevHook();

    // Hold the ship where it is until a level takes over (the Atlas, a daily being generated).
    this.setHold(true);
    const plan = this.startPlan(params);
    if (plan.kind === 'level' && plan.level) {
      this.fadeOutDur = 0;
      this.startLevel(plan.level, null);
    } else if (plan.kind === 'daily' && plan.daily) {
      this.fadeOutDur = 0;
      this.startDaily(plan.daily);
    } else {
      if (plan.bad) ctx.hud.flashMessage('That puzzle link is not valid · pick one from the Atlas', 'warn');
      this.openAtlas();
    }
  }

  update(dt: number, input: InputFrame, state: SimState, paused: boolean): void {
    const ctx = this.ctx;
    const hud = this.hud;
    if (!ctx || !hud) return;
    const h = paused || !Number.isFinite(dt) ? 0 : Math.max(0, dt);
    this.clock += h;
    ctx.overlay.time = this.clock;

    if (paused && this.drag !== 'none') this.endDrag();
    // A lock request the App never answered must not keep the free cursor out of the lab view.
    if (this.lockPending && performance.now() - this.lockPendingAt > 4000) this.lockPending = false;
    if (!paused) this.handleGlobalKeys(input);

    switch (this.phase) {
      case 'entering':
        this.updateEntry(h);
        break;
      case 'playing':
        this.levelTime += h;
        if (this.daily && !(typeof document !== 'undefined' && document.hidden)) this.dailyElapsed += h;
        this.syncViewToCursor();
        break;
      case 'ceremony': {
        const ev = this.ceremony.update(h);
        if (ev === 'pulse') this.ceremonyPulse();
        else if (ev === 'done') this.showSolvedCard();
        break;
      }
      default:
        break;
    }

    this.updateCamera(h, state);
    const rt = this.runtime();
    if (rt) this.view.setFromWorld(rt, state.ship.position, state.ship.orientation, state.camera.fovDeg, this.cssW, this.cssH);

    this.placementIssue = null;
    this.gauge = null;
    this.previewOk = false;
    this.feedState.preview.active = false;
    if (this.phase === 'playing' && !paused && rt && this.level && this.placement) this.interact(input);
    else if (this.lab.engaged && !paused && (this.phase === 'solved' || this.phase === 'ceremony')) this.labCameraInput(input, false);
    // Not while paused: a drag the pause just ended may solve, and the ceremony's requestFreeCursor()
    // would resume the game from under the pause screen. The commit is traced on resume instead.
    if (!paused && (this.phase === 'playing' || this.phase === 'entering')) this.retrace();

    this.pulseLeft = Math.max(0, this.pulseLeft - h);
    this.updateTips(h);
    this.fillOverlay();
    this.fillHud(paused);
    this.updateAudio(paused);
    hud.update(h);
    this.syncLayerClasses();
  }

  /**
   * Ask the App for pointer-locked flight (within a user gesture). The flag is set first: a refusal
   * may call onCursorModeChange synchronously.
   */
  private askFlight(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.lockPending = true;
    this.lockPendingAt = performance.now();
    ctx.requestFlight();
  }

  onCursorModeChange(mode: CursorMode, failed: boolean): void {
    this.lockPending = false;
    if (failed && this.ctx && this.phase === 'playing') {
      this.ctx.hud.flashMessage('The browser kept the cursor free · lab view · Tab to try flight again', 'warn');
    }
    void mode;
  }

  onEscape(): boolean {
    // Esc in the lab while dragging puts the mass back instead of pausing.
    if (this.drag !== 'none' && this.placement) {
      this.placement.cancelMove();
      this.drag = 'none';
      return true;
    }
    return false;
  }

  onPause(paused: boolean): void {
    if (paused && this.drag !== 'none') this.endDrag();
    // The pause eats the RMB release too: a held lab click must not remove a mass on resume.
    if (paused) this.resetRmb();
  }

  pauseActions(): PauseAction[] {
    const actions: PauseAction[] = [{ id: 'atlas', label: 'Atlas · levels', run: () => this.openAtlas() }];
    if (this.level && (this.phase === 'playing' || this.phase === 'solved')) {
      actions.push({ id: 'restart', label: 'Restart level', run: () => this.restartLevel() });
    }
    return actions;
  }

  exit(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.loadToken++;
    cancelDailyGeneration(); // a Saturday still generating in the worker is of no use any more
    // Never leave the ship inside structure: the lab camera and glides may sit in walls.
    const rt = this.runtime();
    if (rt && this.puppetOn) {
      if (this.lab.active) {
        this.lab.returnPose(_p, _q);
        this.applyPose(rt, _p, _q, 0);
      } else if (this.glideT >= 0) {
        this.applyPose(rt, this.glideTo, this.glideQTo, 0);
      }
    }
    this.lab.reset();
    this.setPuppet(false);
    ctx.sim.setControlPolicy(null);
    ctx.sim.setArena(null);
    if (this.level) ctx.sim.universe.setFrozenClock(this.level.nebula, null);
    this.feed?.clear();
    this.hud?.dispose();
    this.audio?.dispose();
    this.fade?.remove();
    ctx.layer.classList.remove('flm-no-reticle');
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('storage', this.onStorage);
    this.removeDevHook();
    this.hud = null;
    this.audio = null;
    this.feed = null;
    this.fade = null;
    this.level = null;
    this.ctx = null;
  }

  // -------------------------------------------------------------------------------------------
  // Flow
  // -------------------------------------------------------------------------------------------

  private startPlan(params?: URLSearchParams): { kind: 'atlas' | 'level' | 'daily'; level?: LevelDef; daily?: string; bad?: boolean } {
    let p = params;
    if (!p) {
      try {
        p = new URLSearchParams(window.location.search);
      } catch {
        p = new URLSearchParams();
      }
    }
    const lv = p.get('level');
    if (lv) {
      const f = findLevel(lv.trim());
      if (f) return { kind: 'level', level: f.level };
    }
    const dl = p.get('daily');
    if (dl) {
      const d = parseDailyParam(dl);
      if (d) return { kind: 'daily', daily: d };
    }
    const bad = !!lv || !!dl;
    if (isFirstTime(this.progress) && !bad) {
      const first = CHAPTERS[0]?.levels[0];
      if (first) return { kind: 'level', level: first };
    }
    return { kind: 'atlas', bad };
  }

  private callbacks(): FirstLightHudCallbacks {
    return {
      onSelectLevel: (id) => {
        const f = findLevel(id);
        if (!f) return;
        if (this.level && this.level.id === id && !this.daily && this.atlasReturn === 'playing') {
          this.closeAtlas();
          return;
        }
        this.askFlight();
        this.startLevel(f.level, null);
      },
      onDaily: () => {
        this.askFlight();
        this.startDaily(dailyId());
      },
      onCloseAtlas: () => this.closeAtlas(),
      onNext: () => {
        const next = this.level && !this.daily ? nextLevelAfter(this.level.id) : null;
        if (next) {
          this.askFlight();
          this.startLevel(next, null);
        } else this.openAtlas();
      },
      onReplay: () => this.replay(),
      onOpenAtlas: () => this.openAtlas(),
      onHint: () => this.nextHint(),
      onSelectSize: (size) => this.select(size, true),
      onCopyShare: () => copyText(this.shareText),
      onUndo: () => this.undo(),
      onRedo: () => this.redo(),
    };
  }

  private openAtlas(): void {
    const ctx = this.ctx;
    const hud = this.hud;
    if (!ctx || !hud) return;
    if (this.drag !== 'none') this.endDrag();
    if (this.phase === 'entering') this.completeEntryNow();
    // The Atlas cancels a daily still being prepared (it would otherwise start behind the player's back).
    if (this.phase === 'loading') this.loadToken++;
    // A daily being prepared keeps the return phase recorded when it started (startDaily).
    if (this.phase !== 'atlas' && this.phase !== 'loading') this.atlasReturn = this.phase;
    this.phase = 'atlas';
    hud.hideSolved();
    ctx.requestFreeCursor();
    if (!this.lab.active) this.setHold(true);
    ctx.hud.setVisible(true); // never an invisible dialog that takes the keys (H, then Esc → Atlas)
    hud.showAtlas(this.atlasModel(), this.level !== null);
    this.audio?.ui('open');
  }

  private closeAtlas(): void {
    const ctx = this.ctx;
    const hud = this.hud;
    if (!ctx || !hud || this.phase !== 'atlas') return;
    hud.hideAtlas();
    this.audio?.ui('close');
    if (!this.level) return;
    this.phase = this.atlasReturn;
    if (this.phase === 'solved') {
      hud.showSolved(this.solvedCard());
      return;
    }
    if (this.phase === 'playing' && !this.wasLab) {
      this.askFlight();
    }
  }

  private atlasModel() {
    const today = dailyId();
    const info = dailyInfo(today);
    return buildAtlasModel(
      this.progress,
      CHAPTERS,
      this.level && !this.daily ? this.level.id : this.progress.current,
      today,
      `First Light #${info.number} · ${info.nebulaShort}`,
    );
  }

  private startDaily(date: string): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.hud?.hideAtlas();
    this.hud?.hideSolved();
    // From the Atlas, its return phase stands; otherwise (mode start, dev hook) remember where we were.
    if (this.phase !== 'atlas' && this.phase !== 'loading') this.atlasReturn = this.phase === 'entering' ? 'playing' : this.phase;
    this.phase = 'loading';
    this.setHold(true);
    const token = ++this.loadToken;
    ctx.hud.flashMessage('Preparing the daily puzzle…', 'info');
    // The month bundle normally answers at once; when it cannot (offline, or a day past the bundled
    // window) the generator runs in a worker, so the nebula keeps rendering while a Saturday takes seconds.
    loadDaily(date, '', generateDailyAsync)
      .then((raw) => {
        if (token !== this.loadToken || !this.ctx) return;
        if (!raw) {
          this.ctx.hud.flashMessage('The daily could not be generated · try a chapter puzzle', 'warn');
          this.openAtlas();
          return;
        }
        this.startLevel(raw, date);
      })
      .catch((err: unknown) => {
        // A load superseded by the Atlas, another level or exit() (an AbortError from the worker) is silent.
        if (token !== this.loadToken || !this.ctx) return;
        console.error('[firstlight] daily failed', err);
        this.openAtlas();
      });
  }

  /** Begin a level: fade out, then the entry (setup happens at black). */
  private startLevel(raw: LevelDef, daily: string | null): void {
    const ctx = this.ctx;
    const hud = this.hud;
    if (!ctx || !hud) return;
    const level = sanitizeLevel(raw);
    if (!level) {
      console.error(`[firstlight] level "${raw.id}" failed validation`);
      ctx.hud.flashMessage('That puzzle could not be loaded · details in the console', 'warn');
      this.openAtlas();
      return;
    }
    this.loadToken++;
    if (this.drag !== 'none') this.endDrag();
    hud.hideAtlas();
    hud.hideSolved();
    hud.hideHint();
    this.pending = { level, daily };
    this.phase = 'entering';
    this.entryT = 0;
    this.entryReady = false;
    this.entryPulsed = false;
    this.glideT = -1;
    // A first entry (mode start) begins at black; later ones fade the old view out.
    if (this.level === null) this.fadeOutDur = 0;
    if (this.fadeOutDur <= 0) this.setupLevel();
  }

  /** At black: swap the world to the new level and put the ship at the glide start. */
  private setupLevel(): void {
    const ctx = this.ctx;
    const hud = this.hud;
    const pend = this.pending;
    if (!ctx || !hud || !pend) return;
    this.pending = null;
    const level = pend.level;
    const prev = this.level;
    const world = makeTraceWorld(level);

    // The lab / hold / previous glide end here; the entry glide takes the puppet.
    this.lab.reset();
    this.wasLab = false;
    this.hold = false;
    this.setPuppet(true);
    hud.setLabView(false);
    if (prev && prev.nebula !== level.nebula) ctx.sim.universe.setFrozenClock(prev.nebula, null);
    ctx.sim.universe.setFrozenClock(level.nebula, level.clock ?? 0);

    this.level = level;
    this.world = world;
    this.daily = pend.daily;
    this.dailyMeta = pend.daily ? dailyInfo(pend.daily) : null;
    const f = pend.daily ? null : findLevel(level.id);
    this.chapter = f ? f.chapter : null;
    this.seedBase = pend.daily ? 0 : chapterSeedBase(level.id);
    if (!this.placement) this.placement = new Placement(level, world);
    else this.placement.reset(level, world);
    this.resetAttempt();
    if (!pend.daily) {
      syncProgress(this.progress);
      this.progress.current = level.id;
      saveProgress(this.progress);
    }

    // The unlensed beam (the "almost" the player starts from).
    this.result = traceLevel(level, world, this.placement.masses);
    this.committed = this.result;
    this.fullVersion = this.placement.version;
    this.tracedVersion = this.placement.version;

    // Soft bounds around the play sphere. Vantages stand outside it (1.25–1.45 R), and an idle ship
    // beyond the bounds radius drifts inward, so the radius grows to take the vantage in: the player
    // can stand still at the vantage and think.
    const vc = level.arena.centerLocal;
    const vp = level.arena.vantage.pos;
    const vd = Math.hypot(vp[0] - vc[0], vp[1] - vc[1], vp[2] - vc[2]);
    const boundsR = Math.max(level.arena.radiusLocal, Number.isFinite(vd) ? FL.boundsVantage * vd : 0);
    ctx.sim.setArena({ nebulaId: level.nebula, centerLocal: vc, radiusLocal: boundsR });
    ctx.sim.setControlPolicy({
      hyper: false,
      targeting: false,
      pulse: false,
      glide: false,
      voyage: false,
      wheelThrottle: false,
      throttle: FL.throttle,
    });

    // Glide: from up to 0.6 R behind the vantage (free space only) to the vantage, looking at lookAt.
    const v = level.arena.vantage;
    const R = level.arena.radiusLocal;
    this.glideTo.set(v.pos[0], v.pos[1], v.pos[2]);
    _fwd.set(v.lookAt[0] - v.pos[0], v.lookAt[1] - v.pos[1], v.lookAt[2] - v.pos[2]).normalize();
    this.arenaUp(_up);
    lookRotation(_fwd, _up, this.glideQTo);
    const back = this.freeBack(this.glideTo, _fwd, R);
    this.glideFrom.copy(this.glideTo).addScaledVector(_fwd, -back);
    this.glideQFrom.copy(this.glideQTo);
    this.glideDur = FL.glide;
    this.glideT = 0;
    this.glideClip = 0;
    this.glideIsEntry = true;

    // Seed chips (goals first, then relays) and mass chips.
    this.buildChips(level);
    hud.setLevel(this.header());
    hud.hideHint();
    this.entryReady = true;
    this.entryT = Math.max(this.entryT, this.fadeOutDur);
    this.fadeOutDur = FL.fadeOut;

    // Physics tip of the level, the first time it is played (another level's pending tip is dropped).
    for (let i = this.tipQueue.length - 1; i >= 0; i--) if (this.tipQueue[i].startsWith('level:')) this.tipQueue.splice(i, 1);
    const tipKey = `level:${level.id}`;
    if (level.tip && !this.progress.seenTips.includes(tipKey)) {
      this.tipQueue.unshift(tipKey);
      this.tipCooldown = Math.max(this.tipCooldown, FL.glide + 0.5);
    }
  }

  private resetAttempt(): void {
    this.levelTime = 0;
    this.dailyElapsed = 0;
    this.timerSecond = -1;
    this.hintLevel = 0;
    this.help = false;
    this.pulseLeft = 0;
    this.depthMul = 1;
    this.drag = 'none';
    this.hover = -1;
    this.resetRmb();
    this.ceremony.reset();
    this.shareText = '';
    this.lastSeed = null;
    this.feedState.hint.active = false;
    this.slowCount = 0;
    const level = this.level;
    if (level) {
      let sel: MassSize | null = null;
      for (const s of MASS_SIZES) if (budgetCount(level, s) > 0 && sel === null) sel = s;
      this.selected = sel ?? 'medium';
    }
  }

  private updateEntry(h: number): void {
    this.entryT += h;
    if (!this.entryReady) {
      this.setFade(this.fadeOutDur > 0 ? this.entryT / this.fadeOutDur : 1);
      if (this.entryT >= this.fadeOutDur) this.setupLevel();
      return;
    }
    const level = this.level;
    if (!level) return;
    const g = this.glideT >= 0 ? this.glideT / this.glideDur : 1;
    this.setFade(1 - smooth(0, FL.fadeIn, this.glideT));
    this.feedState.beamReveal = smooth(0.3, 0.85, g);
    this.feedState.seedReveal = smooth(0.55, 0.95, g);
    if (!this.entryPulsed && g >= 0.5) {
      this.entryPulsed = true;
      const rt = this.runtime();
      if (rt) {
        _p.set(level.source.pos[0], level.source.pos[1], level.source.pos[2]);
        localToWorld(rt, _p, _w);
        this.ctx?.sim.firePulseAt(_w, FL.ceremonyPulse * level.arena.radiusLocal * rt.scale, FL.ceremonyPulseGain);
      }
    }
  }

  /** Skip the rest of the entry (the Atlas opened mid-glide): the ship lands at the vantage now. */
  private completeEntryNow(): void {
    if (this.phase !== 'entering') return;
    if (!this.entryReady) this.setupLevel();
    const rt = this.runtime();
    if (rt && this.glideT >= 0 && this.glideIsEntry) this.applyPose(rt, this.glideTo, this.glideQTo, 0);
    this.glideT = -1;
    this.finishEntry();
  }

  /** The entry glide reached the vantage: release the ship and play. */
  private finishEntry(): void {
    this.setFade(0);
    this.feedState.beamReveal = 1;
    this.feedState.seedReveal = 1;
    this.phase = 'playing';
    this.levelTime = 0;
    this.dailyElapsed = 0;
    this.setPuppet(false);
    this.syncViewToCursor();
  }

  private replay(): void {
    const ctx = this.ctx;
    const level = this.level;
    if (!ctx || !level || !this.placement || !this.world) return;
    this.hud?.hideSolved();
    this.hud?.hideHint();
    this.placement.reset(level, this.world);
    this.resetAttempt();
    this.retraceNow();
    this.phase = 'playing';
    if (!this.lab.active) {
      this.setHold(false);
      this.askFlight();
    }
  }

  /** Pause action: clear the masses (undoable); on the solved card it replays. */
  private restartLevel(): void {
    if (this.phase === 'solved') {
      this.replay();
      return;
    }
    if (this.placement?.clear()) this.audio?.remove();
  }

  // -------------------------------------------------------------------------------------------
  // Camera: entry glide, Backspace glide, lab view, hold
  // -------------------------------------------------------------------------------------------

  private runtime(): NebulaRuntime | null {
    const ctx = this.ctx;
    const level = this.level;
    if (!ctx || !level) return null;
    return ctx.sim.universe.get(level.nebula) ?? null;
  }

  private arenaUp(out: THREE.Vector3): THREE.Vector3 {
    const u = this.level?.arena.up;
    out.set(u ? u[0] : 0, u ? u[1] : 1, u ? u[2] : 0);
    if (!(out.lengthSq() > 1e-12)) out.set(0, 1, 0);
    return out.normalize();
  }

  /** How far behind the vantage (≤ glideBack × R) the glide may start in free space. */
  private freeBack(from: THREE.Vector3, fwd: THREE.Vector3, R: number): number {
    const world = this.world;
    if (!world) return 0;
    const step = 0.05 * R;
    let good = 0;
    for (let s = step; s <= FL.glideBack * R + 1e-12; s += step) {
      const de = world.de(from.x - fwd.x * s, from.y - fwd.y * s, from.z - fwd.z * s);
      if (!(de > 0.04 * R)) break;
      good = s;
    }
    return good;
  }

  private setPuppet(on: boolean): void {
    if (on === this.puppetOn) return;
    this.puppetOn = on;
    this.ctx?.sim.setPuppet(on);
  }

  /** LOCAL pose → world → puppet. */
  private applyPose(rt: NebulaRuntime, pos: THREE.Vector3, quat: THREE.Quaternion, clipLocal: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    localToWorld(rt, pos, _w);
    quatLocalToWorld(rt, quat, _qw);
    ctx.sim.setPuppetPose(_w, _qw, clipLocal > 0 ? clipLocal * rt.scale : 0);
  }

  /** Hold the ship still at its current pose (carried by the nebula's spin when a level is loaded). */
  private setHold(on: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (on) {
      if (this.hold) return;
      const ship = ctx.sim.state.ship;
      const rt = this.runtime();
      if (rt && this.glideT >= 0 && !this.glideIsEntry) {
        // A Backspace glide lands now: holding its mid-glide pose would snap the view back once the glide ended.
        this.applyPose(rt, this.glideTo, this.glideQTo, 0);
        this.holdPos.copy(this.glideTo);
        this.holdQuat.copy(this.glideQTo);
        this.holdLocal = true;
        this.glideT = -1;
      } else if (rt) {
        worldToLocal(rt, ship.position, this.holdPos);
        quatWorldToLocal(rt, ship.orientation, this.holdQuat);
        this.holdLocal = true;
      } else {
        this.holdPos.copy(ship.position);
        this.holdQuat.copy(ship.orientation);
        this.holdLocal = false;
      }
      this.hold = true;
      this.setPuppet(true);
    } else {
      if (!this.hold) return;
      this.hold = false;
      if (!this.lab.active && this.glideT < 0) this.setPuppet(false);
    }
  }

  private updateCamera(h: number, state: SimState): void {
    const rt = this.runtime();
    if (this.glideT >= 0 && rt) {
      // Glides (entry, Backspace).
      this.glideT = Math.min(this.glideT + h, this.glideDur);
      const e = smooth(0, 1, this.glideT / this.glideDur);
      _p.copy(this.glideFrom).lerp(this.glideTo, e);
      _q.copy(this.glideQFrom).slerp(this.glideQTo, e);
      this.applyPose(rt, _p, _q, this.glideClip * (1 - e));
      if (this.glideT >= this.glideDur) {
        this.glideT = -1;
        if (this.glideIsEntry && this.phase === 'entering') this.finishEntry();
      }
    } else if (this.lab.active && rt) {
      // Lab view (and its tweens).
      this.lab.update(h);
      const clip = this.lab.pose(_p, _q);
      this.applyPose(rt, _p, _q, clip);
      // A leave tween that ends under the ceremony / card (solved during it): hold the landed pose.
      if (this.lab.justLeft && this.phase !== 'playing') this.setHold(true);
    } else if (this.hold) {
      // Held still (atlas, card in flight view).
      if (this.holdLocal && rt) this.applyPose(rt, this.holdPos, this.holdQuat, 0);
    }
    // One rule for the puppet, every frame: the mode owns the ship while it glides, looks through the
    // lab camera, holds still or changes level; otherwise the player flies. (Separate release paths
    // could miss a case — e.g. a lock granted on the very frame the lab view engaged — and leave the
    // ship frozen.)
    this.setPuppet(this.glideT >= 0 || this.lab.active || this.hold || this.phase === 'entering');
    void state;
  }

  /** Playing: locked cursor ⇔ flight, free cursor ⇔ lab view. */
  private syncViewToCursor(): void {
    const ctx = this.ctx;
    const level = this.level;
    if (!ctx || !level || this.phase !== 'playing' || this.glideT >= 0) return;
    const free = ctx.cursorMode === 'free';
    if (free && !this.lab.engaged && !this.lockPending) this.enterLab();
    else if (!free && this.lab.engaged) this.leaveLab();
    if (this.hold && !free && !this.lab.active) this.setHold(false);
  }

  private enterLab(): void {
    const ctx = this.ctx;
    const rt = this.runtime();
    const level = this.level;
    if (!ctx || !rt || !level) return;
    if (this.drag !== 'none') this.endDrag();
    this.resetRmb();
    if (this.hold) {
      // The held pose is where the flight would resume.
      _p.copy(this.holdPos);
      _q.copy(this.holdQuat);
      if (!this.holdLocal) {
        worldToLocal(rt, this.holdPos, _p);
        quatWorldToLocal(rt, this.holdQuat, _q);
      }
      this.hold = false;
    } else {
      worldToLocal(rt, ctx.sim.state.ship.position, _p);
      quatWorldToLocal(rt, ctx.sim.state.ship.orientation, _q);
    }
    this.lab.enter(level.arena, _p, _q);
    this.setPuppet(true);
    this.wasLab = true;
    this.hud?.setLabView(true);
  }

  private leaveLab(): void {
    if (this.drag !== 'none') this.endDrag();
    // An RMB released in flight never reaches labCameraInput: drop the gesture so it can't remove a mass later.
    this.resetRmb();
    this.lab.leave();
    this.wasLab = false;
    this.hud?.setLabView(false);
  }

  /** Backspace in flight: glide back to the vantage. */
  private returnToVantage(): void {
    const ctx = this.ctx;
    const rt = this.runtime();
    const level = this.level;
    if (!ctx || !rt || !level) return;
    if (this.drag !== 'none') this.endDrag();
    worldToLocal(rt, ctx.sim.state.ship.position, this.glideFrom);
    quatWorldToLocal(rt, ctx.sim.state.ship.orientation, this.glideQFrom);
    const v = level.arena.vantage;
    this.glideTo.set(v.pos[0], v.pos[1], v.pos[2]);
    _fwd.set(v.lookAt[0] - v.pos[0], v.lookAt[1] - v.pos[1], v.lookAt[2] - v.pos[2]).normalize();
    lookRotation(_fwd, this.arenaUp(_up), this.glideQTo);
    // X-ray what the straight path crosses.
    const R = level.arena.radiusLocal;
    let blocked = false;
    const world = this.world;
    if (world) {
      for (let i = 1; i < 16 && !blocked; i++) {
        _p.copy(this.glideFrom).lerp(this.glideTo, i / 16);
        if (!(world.de(_p.x, _p.y, _p.z) > 0.02 * R)) blocked = true;
      }
    }
    this.glideClip = blocked ? 0.15 * R : 0;
    this.glideDur = FL.returnGlide;
    this.glideT = 0;
    this.glideIsEntry = false;
    this.setPuppet(true);
  }

  // -------------------------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------------------------

  /** Keys that work in several phases. */
  private handleGlobalKeys(input: InputFrame): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (input.keyPressed('KeyI') && this.phase !== 'atlas') ctx.hud.toggleCodex();
    if (this.phase !== 'playing') return;
    const ctrl = input.mods.ctrl || input.mods.meta;
    if (input.keyPressed('Tab')) {
      if (this.glideT < 0) {
        if (ctx.cursorMode === 'locked') ctx.requestFreeCursor();
        else {
          this.askFlight();
        }
      }
    }
    if (input.keyPressed('Backspace')) {
      if (this.lab.engaged) this.lab.reframe();
      else if (this.glideT < 0) this.returnToVantage();
    }
    if (input.keyPressed('Space')) this.firePulse();
    if (input.keyPressed('Slash')) this.hintKey();
    if (input.keyPressed('Digit1') || input.keyPressed('Numpad1')) this.select('light', true);
    if (input.keyPressed('Digit2') || input.keyPressed('Numpad2')) this.select('medium', true);
    if (input.keyPressed('Digit3') || input.keyPressed('Numpad3')) this.select('heavy', true);
    if (input.keyPressed('KeyZ')) {
      if (input.mods.shift) this.redo();
      else this.undo();
    }
    if (ctrl && input.keyPressed('KeyY')) this.redo();
    if (input.keyPressed('KeyX') && !ctrl) this.removeHoveredOrLast();
    if (input.keyPressed('KeyC') && !ctrl && !(this.hud?.solvedOpen ?? false)) this.clearAll();
  }

  /** Placement, hover and drags (playing phase, both views). */
  private interact(input: InputFrame): void {
    const placement = this.placement;
    const level = this.level;
    if (!placement || !level) return;
    const lab = this.lab.engaged;
    const tweening = this.lab.active && this.lab.amount < 0.999 && this.lab.amount > 0.001;
    if (this.glideT >= 0 || tweening) {
      this.hover = -1;
      return;
    }
    if (lab) this.interactLab(input, placement, level);
    else this.interactFlight(input, placement, level);
  }

  private interactFlight(input: InputFrame, placement: Placement, level: LevelDef): void {
    const ctx = this.ctx;
    if (!ctx || ctx.cursorMode !== 'locked') {
      this.hover = -1;
      return;
    }
    const px = this.cssW * 0.5;
    const py = this.cssH * 0.5;
    this.view.ray(px, py, _o, _d);
    const wheel = Number.isFinite(input.wheel) ? input.wheel : 0;

    if (this.drag === 'grab') {
      if (wheel !== 0) this.grabDist *= Math.pow(PLACEMENT.depthStep, wheel);
      const R = level.arena.radiusLocal;
      this.grabDist = Math.min(Math.max(this.grabDist, 0.02 * R), 4 * R);
      _p.copy(_o).addScaledVector(_d, this.grabDist);
      // Precision: the mass follows 20 % of the reticle's motion while Shift is held.
      if (input.mods.shift) {
        _w.subVectors(_p, this.lastTarget).multiplyScalar(1 - PLACEMENT.precision);
        this.grabOffset.sub(_w);
      }
      this.lastTarget.copy(_p);
      _p.add(this.grabOffset);
      this.dragTo(_p, placement);
      if (input.released & MOUSE_LEFT || !(input.buttons & MOUSE_LEFT)) this.endDrag();
      return;
    }

    this.hover = hoveredMass(placement.masses, this.view, px, py);
    if (wheel !== 0) {
      this.depthMul = Math.min(Math.max(this.depthMul * Math.pow(PLACEMENT.depthStep, wheel), PLACEMENT.depthMulMin), PLACEMENT.depthMulMax);
    }
    if (this.hover < 0) this.computePreview(placement, level, true);

    if (input.pressed & MOUSE_LEFT) {
      if (this.hover >= 0) this.beginGrab(this.hover, placement);
      else this.placeAtPreview(placement, false);
    }
    if (input.pressed & MOUSE_RIGHT && this.hover >= 0) this.removeMass(this.hover);
  }

  private interactLab(input: InputFrame, placement: Placement, level: LevelDef): void {
    const pt = input.pointer;
    const wheel = Number.isFinite(input.wheel) ? input.wheel : 0;
    this.lastPointerX = pt.x;
    this.lastPointerY = pt.y;
    this.labCameraInput(input, this.drag === 'lab');

    if (this.drag === 'lab') {
      const k = input.mods.shift ? PLACEMENT.precision : 1;
      const dx = Number.isFinite(pt.dx) ? pt.dx : 0;
      const dy = Number.isFinite(pt.dy) ? pt.dy : 0;
      // A plain click leaves the mass exactly where it was; the first motion anchors the drag.
      if (!this.dragLive && (dx !== 0 || dy !== 0 || wheel !== 0)) this.anchorLabDrag(placement);
      this.dragX += dx * k;
      this.dragY += dy * k;
      if (wheel !== 0) {
        const R = level.arena.radiusLocal;
        this.labDepth = Math.min(Math.max(this.labDepth * Math.pow(PLACEMENT.depthStep, wheel), 0.05 * R), 6 * R);
      }
      this.lastPointerX = this.dragX;
      this.lastPointerY = this.dragY;
      if (this.dragLive) {
        this.view.ray(this.dragX + this.dragOffX, this.dragY + this.dragOffY, _o, _d);
        const dDotF = _d.dot(this.view.forward);
        if (dDotF > 1e-6) {
          _p.copy(_o).addScaledVector(_d, this.labDepth / dDotF);
          this.dragTo(_p, placement);
        }
      }
      if (input.released & MOUSE_LEFT || !(input.buttons & MOUSE_LEFT)) this.endDrag();
      this.hover = -1;
      return;
    }

    if (!pt.inside || this.rmbDown) {
      this.hover = -1;
      this.hud?.setCursorTip(pt.x, pt.y, null);
      return;
    }
    this.view.ray(pt.x, pt.y, _o, _d);
    this.hover = hoveredMass(placement.masses, this.view, pt.x, pt.y);
    if (this.hover < 0) this.computePreview(placement, level, false);

    if (input.pressed & MOUSE_LEFT) {
      if (this.hover >= 0) {
        this.beginLabDrag(this.hover, placement, pt.x, pt.y, false);
      } else if (this.previewOk) {
        const i = this.placeAtPreview(placement, true);
        if (i >= 0) this.beginLabDrag(i, placement, pt.x, pt.y, true);
      } else if (this.placementIssue || placement.available(this.selected) <= 0) this.audio?.ui('error');
    }
  }

  /** Lab camera: RMB drag orbits (a short RMB click on a mass removes it), wheel dollies. */
  private labCameraInput(input: InputFrame, dragging: boolean): void {
    const pt = input.pointer;
    if (input.pressed & MOUSE_RIGHT) {
      this.rmbDown = true;
      this.rmbTravel = 0;
      // Hover under the press itself (last frame's hover is stale when move + click land in one frame).
      const placement = this.placement;
      this.rmbHover = this.phase === 'playing' && placement && pt.inside ? hoveredMass(placement.masses, this.view, pt.x, pt.y) : -1;
    }
    if (this.rmbDown && input.buttons & MOUSE_RIGHT) {
      const dx = Number.isFinite(pt.dx) ? pt.dx : 0;
      const dy = Number.isFinite(pt.dy) ? pt.dy : 0;
      this.rmbTravel += Math.abs(dx) + Math.abs(dy);
      if (this.rmbTravel >= FL.clickPx) this.lab.cam.orbit(dx, dy);
    }
    if (this.rmbDown && (input.released & MOUSE_RIGHT || !(input.buttons & MOUSE_RIGHT))) {
      this.rmbDown = false;
      if (this.rmbTravel < FL.clickPx && this.rmbHover >= 0 && this.phase === 'playing' && this.drag === 'none') {
        this.removeMass(this.rmbHover);
      }
      this.rmbHover = -1;
    }
    const wheel = Number.isFinite(input.wheel) ? input.wheel : 0;
    if (!dragging && wheel !== 0 && pt.inside) this.lab.cam.dolly(wheel);
  }

  /** Forget a lab RMB gesture (its release may never reach labCameraInput). */
  private resetRmb(): void {
    this.rmbDown = false;
    this.rmbTravel = 0;
    this.rmbHover = -1;
  }

  /** Where a mass of the selected size would go along the current ray (_o, _d); sets the preview. */
  private computePreview(placement: Placement, level: LevelDef, flight: boolean): void {
    const world = this.world;
    const res = this.result;
    if (!world) return;
    if (placement.available(this.selected) <= 0) return;
    const R = level.arena.radiusLocal;
    const c = level.arena.centerLocal;
    const rho = rhoOf(level, this.selected);
    // The shared rule (Placement.ts; tools/fl-reach.ts gates the levels with the same code). The view's
    // height is this.cssH (setFromWorld ran this frame), so the snap reach is snapFrac × the canvas height.
    const beams = res ? res.beams : null;
    const pt = _pt;
    const ok = flight
      ? flightPlacementPoint(world, beams, this.view, _o, _d, c, R, this.depthMul, pt)
      : labPlacementPoint(beams, this.view, _o, _d, c, R, pt);
    if (!ok) return;
    const t = pt.t;
    const ref = pt.ref;
    _p.set(pt.x, pt.y, pt.z);
    const issue = placement.issueAt(_p.x, _p.y, _p.z, rho);
    const pv = this.feedState.preview;
    pv.active = true;
    pv.x = _p.x;
    pv.y = _p.y;
    pv.z = _p.z;
    pv.rho = rho;
    pv.legal = issue === null;
    const dd = dropToSurface(world, _p.x, _p.y, _p.z, 2e-3 * R, _foot);
    pv.drop = dd > 0 && dd < 0.9 * R && Number.isFinite(dd);
    pv.dx = _foot.x;
    pv.dy = _foot.y;
    pv.dz = _foot.z;
    this.placementIssue = issue;
    this.previewOk = issue === null;
    this.gauge = flight && ref > 0 ? t / ref : null;
  }

  /** Place the selected mass at the preview point; returns its index or −1. */
  private placeAtPreview(placement: Placement, quiet: boolean): number {
    const pv = this.feedState.preview;
    if (!pv.active) return -1;
    if (!pv.legal) {
      this.audio?.ui('error');
      return -1;
    }
    const size = this.selected;
    if (placement.available(size) <= 0) return -1;
    const i = placement.add(size, pv.x, pv.y, pv.z);
    this.audio?.place(size);
    this.depthMul = 1;
    if (placement.available(size) <= 0) {
      for (const s of MASS_SIZES) {
        if (placement.available(s) > 0) {
          this.selected = s;
          break;
        }
      }
    }
    void quiet;
    return i;
  }

  private beginGrab(index: number, placement: Placement): void {
    const m = placement.masses[index];
    if (!m || !placement.beginMove(index)) return;
    _w.set(m.pos[0], m.pos[1], m.pos[2]);
    this.grabDist = Math.max(_w.distanceTo(_o), 1e-9);
    _p.copy(_o).addScaledVector(_d, this.grabDist);
    this.lastTarget.copy(_p);
    this.grabOffset.subVectors(_w, _p);
    this.drag = 'grab';
    this.audio?.grab();
  }

  private beginLabDrag(index: number, placement: Placement, x: number, y: number, fresh: boolean): void {
    const m = placement.masses[index];
    if (!m || !placement.beginMove(index, fresh)) return;
    this.dragX = x;
    this.dragY = y;
    this.dragOffX = 0;
    this.dragOffY = 0;
    this.dragLive = false;
    this.drag = 'lab';
    if (!fresh) this.audio?.grab();
  }

  /**
   * The lab drag's first motion: from now on the mass keeps its view depth and its screen offset from
   * the cursor (a grab rarely lands on the centre), both measured in the current view.
   */
  private anchorLabDrag(placement: Placement): void {
    this.dragLive = true;
    const m = placement.masses[placement.moving];
    if (!m) return;
    const f = this.view.forward;
    const o = this.view.origin;
    this.labDepth = (m.pos[0] - o.x) * f.x + (m.pos[1] - o.y) * f.y + (m.pos[2] - o.z) * f.z;
    if (!(this.labDepth > 1e-9)) this.labDepth = 1e-3;
    if (this.view.project(m.pos[0], m.pos[1], m.pos[2], _sp)) {
      this.dragOffX = _sp.x - this.dragX;
      this.dragOffY = _sp.y - this.dragY;
    }
  }

  /** Move the dragged mass to p when legal there; otherwise it waits and a red ring shows why. */
  private dragTo(p: THREE.Vector3, placement: Placement): void {
    const i = placement.moving;
    const m = placement.masses[i];
    if (!m) return;
    const issue = placement.issueAt(p.x, p.y, p.z, m.rho, i);
    if (issue === null) placement.moveTo(p.x, p.y, p.z);
    else {
      const pv = this.feedState.preview;
      pv.active = true;
      pv.x = p.x;
      pv.y = p.y;
      pv.z = p.z;
      pv.rho = m.rho;
      pv.legal = false;
      pv.drop = false;
      this.placementIssue = issue;
    }
  }

  private endDrag(): void {
    const placement = this.placement;
    if (this.drag === 'none' || !placement) {
      this.drag = 'none';
      return;
    }
    this.drag = 'none';
    placement.endMove();
    this.audio?.drop();
  }

  private removeMass(index: number): void {
    const placement = this.placement;
    if (!placement || this.drag !== 'none') return;
    if (placement.remove(index)) {
      this.audio?.remove();
      if (this.hover === index) this.hover = -1;
    }
  }

  private removeHoveredOrLast(): void {
    const placement = this.placement;
    if (!placement || this.drag !== 'none') return;
    const i = this.hover >= 0 ? this.hover : placement.masses.length - 1;
    if (i >= 0) this.removeMass(i);
  }

  private clearAll(): void {
    if (this.drag !== 'none') return;
    if (this.placement?.clear()) this.audio?.remove();
  }

  private undo(): void {
    if (this.phase !== 'playing' || this.drag !== 'none') return;
    if (this.placement?.undo()) this.audio?.undo();
  }

  private redo(): void {
    if (this.phase !== 'playing' || this.drag !== 'none') return;
    if (this.placement?.redo()) this.audio?.undo();
  }

  private select(size: MassSize, sound: boolean): void {
    const level = this.level;
    if (!level) return;
    if (budgetCount(level, size) <= 0) {
      if (sound) this.audio?.ui('error');
      return;
    }
    if (this.selected !== size && sound) this.audio?.ui('select');
    this.selected = size;
  }

  private firePulse(): void {
    const ctx = this.ctx;
    const rt = this.runtime();
    const level = this.level;
    if (!ctx || !rt || !level) return;
    this.pulseLeft = FL.pulseSeconds;
    ctx.sim.firePulseAt(ctx.sim.state.ship.position, FL.pulseRadius * level.arena.radiusLocal * rt.scale, FL.pulseGain);
  }

  // -------------------------------------------------------------------------------------------
  // Hints and tips
  // -------------------------------------------------------------------------------------------

  /**
   * `?`: the first press opens hint 1; a step the player closed (×) comes back before anything
   * advances; with the panel open it moves on (step 2's panel already warns that step 3 costs the ✦).
   */
  private hintKey(): void {
    const level = this.level;
    const hud = this.hud;
    if (!level || !hud || this.phase !== 'playing') return;
    if (this.hintLevel > 0 && !hud.hintOpen) {
      hud.showHint(this.hintLevel as 1 | 2 | 3, this.hintText(this.hintLevel));
      this.audio?.ui('open');
      return;
    }
    if (this.hintLevel >= 3) return;
    this.nextHint();
  }

  private hintText(step: number): string {
    const level = this.level;
    if (!level) return '…';
    let text = level.hints[step - 1]?.trim() ?? '';
    if (!text && step === 2) text = 'The dashed sphere marks where one of the masses belongs.';
    return text || '…';
  }

  private nextHint(): void {
    const level = this.level;
    const hud = this.hud;
    if (!level || !hud || this.phase !== 'playing') return;
    const step = Math.min(3, this.hintLevel + 1) as 1 | 2 | 3;
    this.hintLevel = step;
    const text = this.hintText(step);
    if (step === 2) {
      const sol = level.solution[level.hintMass ?? 0] ?? level.solution[0];
      if (sol) {
        const h = this.feedState.hint;
        h.active = true;
        h.x = sol.pos[0];
        h.y = sol.pos[1];
        h.z = sol.pos[2];
        h.radius = FEED.hintRho * rhoOf(level, sol.size);
      }
    }
    if (step === 3) this.help = true;
    hud.showHint(step, text);
    this.audio?.ui('hint');
  }

  /** Queue a first-time physics tip; it is remembered in the save only once it was shown. */
  private queueTip(key: string): void {
    if (this.progress.seenTips.includes(key) || this.tipQueue.includes(key)) return;
    this.tipQueue.push(key);
  }

  /** One tip at a time (FL.tipGap apart), while playing or under the solved card. */
  private updateTips(h: number): void {
    this.tipCooldown = Math.max(0, this.tipCooldown - h);
    if (this.tipCooldown > 0 || this.tipQueue.length === 0) return;
    if (this.phase !== 'playing' && this.phase !== 'solved') return;
    const key = this.tipQueue.shift();
    if (!key) return;
    let tip: { label: string; text: string } | undefined;
    if (key.startsWith('level:')) tip = this.level && key === `level:${this.level.id}` ? this.level.tip : undefined;
    else tip = TIPS[key];
    if (!tip) return;
    syncProgress(this.progress);
    if (!markTip(this.progress, key)) return;
    saveProgress(this.progress);
    this.hud?.showTip(tip.label, tip.text);
    this.tipCooldown = FL.tipGap;
  }

  // -------------------------------------------------------------------------------------------
  // Tracing, audio events, win
  // -------------------------------------------------------------------------------------------

  private retrace(): void {
    const level = this.level;
    const world = this.world;
    const placement = this.placement;
    if (!level || !world || !placement) return;
    const v = placement.version;
    if (this.drag !== 'none') {
      if (v === this.tracedVersion || this.clock - this.lastCoarse < FL.coarseEvery) return;
      this.lastCoarse = this.clock;
      this.result = traceLevel(level, world, placement.masses, { coarse: true });
      this.tracedVersion = v;
      return;
    }
    if (v === this.fullVersion) return;
    this.retraceNow();
  }

  private retraceNow(): void {
    const level = this.level;
    const world = this.world;
    const placement = this.placement;
    if (!level || !world || !placement) return;
    const t0 = performance.now();
    const r = traceLevel(level, world, placement.masses);
    const ms = performance.now() - t0;
    if (ms > FL.slowTraceMs) {
      if (++this.slowCount >= 3 && !this.slowLogged) {
        this.slowLogged = true;
        console.warn(`[firstlight] full traces take ${ms.toFixed(1)} ms (> ${FL.slowTraceMs} ms three times running) on ${level.id}`);
      }
    } else this.slowCount = 0;
    this.result = r;
    this.fullVersion = placement.version;
    this.tracedVersion = placement.version;
    const prev = this.committed;
    this.committed = r;
    this.onCommitted(prev, r);
  }

  /** Audio cues, physics tips and the win check for a committed configuration. */
  private onCommitted(prev: TraceResult | null, r: TraceResult): void {
    const level = this.level;
    const audio = this.audio;
    if (!level || this.phase !== 'playing') return;
    // Newly lit seeds chime in light-travel order (the note climbs across the chapter); seeds that went dark.
    const newly: number[] = [];
    for (const s of level.seeds) {
      const st = r.seeds[s.id];
      const was = prev ? prev.seeds[s.id]?.lit ?? false : false;
      if (st && st.lit && !was) newly.push(Math.max(0, st.order));
    }
    newly.sort((a, b) => a - b);
    for (const o of newly) audio?.seedLit(this.seedBase + o);
    let unlit = false;
    if (prev) {
      for (const s of level.seeds) {
        const was = prev.seeds[s.id]?.lit ?? false;
        const now = r.seeds[s.id]?.lit ?? false;
        if (was && !now) unlit = true;
      }
    }
    if (unlit) audio?.seedUnlit();
    let captured = false;
    let refl = 0;
    let deflection = 0;
    for (const b of r.beams) {
      if (b.end === 'captured') captured = true;
      refl += b.reflections.length / 3;
      deflection += Math.abs(b.deflection);
    }
    let prevCaptured = false;
    let prevRefl = 0;
    if (prev) {
      for (const b of prev.beams) {
        if (b.end === 'captured') prevCaptured = true;
        prevRefl += b.reflections.length / 3;
      }
    }
    if (captured && !prevCaptured) audio?.capture();
    if (refl > prevRefl) audio?.reflect();

    // First-time physics tips.
    const n = this.placement?.masses.length ?? 0;
    if (n > 0 && deflection > 0.02) this.queueTip('bend');
    if (captured) this.queueTip('capture');
    if (refl > 0) this.queueTip('reflection');
    for (let i = 0; i < r.massClosest.length; i++) {
      const mc = r.massClosest[i];
      if (mc < 4.5 && mc > 2.7) this.queueTip('ring');
    }

    if (r.solved && n > 0) this.startCeremony(r);
  }

  private startCeremony(r: TraceResult): void {
    const ctx = this.ctx;
    const level = this.level;
    const placement = this.placement;
    if (!ctx || !level || !placement) return;
    this.phase = 'ceremony';
    this.ceremony.start();
    this.audio?.ignition();
    this.hud?.hideHint();
    this.feedState.hint.active = false;
    // The last seed the light reached sends the pulse.
    let lastOrder = -1;
    this.lastSeed = null;
    for (const s of level.seeds) {
      const st = r.seeds[s.id];
      if (st && st.lit && st.order > lastOrder) {
        lastOrder = st.order;
        this.lastSeed = s.pos;
      }
    }
    // Save now: leaving during the ceremony still counts. Synced first: another tab may have solved
    // dailies (the streak, the day's first solve) or levels since this copy was loaded.
    const masses = placement.masses.length;
    const par = masses <= level.par && !this.help;
    syncProgress(this.progress);
    if (this.daily) {
      recordDaily(this.progress, this.daily, this.dailyElapsed, masses);
      // The share string is the day's official result: the first solve (a replay never changes it).
      const first = this.progress.daily.history[this.daily];
      const info = this.dailyMeta ?? dailyInfo(this.daily);
      let lit = 0;
      let goals = 0;
      for (const s of level.seeds) {
        if (!s.goal) continue;
        goals++;
        if (r.seeds[s.id]?.lit) lit++;
      }
      this.shareText = buildShare({
        number: info.number,
        nebula: info.nebulaShort,
        seedsLit: lit,
        seedsTotal: goals,
        massesUsed: first ? first.masses : masses,
        time: first ? first.time : this.dailyElapsed,
        url: dailyShareUrl(this.daily, 'firstlight'),
      });
    } else {
      recordSolve(this.progress, level.id, masses, this.help, par);
      const next = nextLevelAfter(level.id);
      if (next) this.progress.current = next.id;
    }
    saveProgress(this.progress);
    // The card needs a pointer; a flight view holds the ship still meanwhile.
    if (!this.lab.active) this.setHold(true);
    ctx.requestFreeCursor();
  }

  private ceremonyPulse(): void {
    const ctx = this.ctx;
    const rt = this.runtime();
    const level = this.level;
    if (!ctx || !rt || !level) return;
    const sp = this.lastSeed ?? level.source.pos;
    _p.set(sp[0], sp[1], sp[2]);
    localToWorld(rt, _p, _w);
    ctx.sim.firePulseAt(_w, FL.ceremonyPulse * level.arena.radiusLocal * rt.scale, FL.ceremonyPulseGain);
  }

  private showSolvedCard(): void {
    this.phase = 'solved';
    this.ctx?.hud.setVisible(true); // a ceremony that ended with the HUD hidden still shows its card
    this.hud?.showSolved(this.solvedCard());
  }

  private solvedCard(): SolvedCard {
    const level = this.level;
    const masses = this.placement?.masses.length ?? 0;
    if (!level) {
      return { title: 'First light', teach: '', massesUsed: 0, par: 0, parMet: false, help: false, nextLabel: null, isDaily: false };
    }
    const parMet = masses <= level.par && !this.help;
    if (this.daily) {
      const today = dailyId();
      return {
        title: 'Daily solved',
        teach: level.teach,
        massesUsed: masses,
        par: level.par,
        parMet,
        help: this.help,
        nextLabel: null,
        isDaily: true,
        share: this.shareText,
        streak: currentStreak(this.progress, today),
        time: formatTime(this.progress.daily.history[this.daily]?.time ?? this.dailyElapsed),
        nextIn: nextInText(),
      };
    }
    const next = nextLevelAfter(level.id);
    return {
      title: 'First light',
      teach: level.teach,
      massesUsed: masses,
      par: level.par,
      parMet,
      help: this.help,
      nextLabel: next ? `Next · ${next.name}` : null,
      isDaily: false,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Output: overlay, HUD, audio
  // -------------------------------------------------------------------------------------------

  private fillOverlay(): void {
    const feed = this.feed;
    if (!feed) return;
    const s = this.feedState;
    // The old level stays on screen while the curtain falls (its state is swapped at black).
    if (this.level === null) {
      feed.clear();
      return;
    }
    s.level = this.level;
    s.result = this.result;
    s.masses = this.placement ? this.placement.masses : [];
    s.hover = this.phase === 'playing' ? this.hover : -1;
    s.active = this.placement ? this.placement.moving : -1;
    s.lab = this.lab.amount;
    s.pulse = clamp01(this.pulseLeft / 2);
    s.accentGain = this.ceremony.accentGain;
    s.swell = this.ceremony.swell;
    s.beamGain = this.ceremony.beamGain;
    if (this.phase !== 'playing') s.preview.active = false;
    if (this.phase !== 'entering') {
      s.beamReveal = 1;
      s.seedReveal = 1;
    }
    feed.fill(s);
  }

  private buildChips(level: LevelDef): void {
    const seeds: SeedChip[] = [];
    this.seedIndex.length = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < level.seeds.length; i++) {
        const s = level.seeds[i];
        if (s.goal !== (pass === 0)) continue;
        seeds.push({ goal: s.goal, lit: false, almost: 0 });
        this.seedIndex.push(i);
      }
    }
    const masses: MassChip[] = [];
    for (const size of MASS_SIZES) {
      const total = budgetCount(level, size);
      if (total > 0) masses.push({ size, total, placed: 0 });
    }
    this.play.seeds = seeds;
    this.play.masses = masses;
  }

  private header(): LevelHeader {
    const level = this.level;
    if (!level) return { nebulaName: '', chapterName: '', index: 0, total: 0, name: '', isDaily: false };
    if (this.daily) {
      return {
        nebulaName: nebulaName(level.nebula),
        chapterName: 'Daily',
        index: this.dailyMeta?.number ?? 0,
        total: 0,
        name: level.name,
        isDaily: true,
      };
    }
    const ch = this.chapter;
    return {
      nebulaName: nebulaName(level.nebula),
      chapterName: ch ? ch.name : level.chapter,
      index: level.index,
      total: ch ? ch.levels.length : level.index,
      name: level.name,
      isDaily: false,
    };
  }

  private fillHud(paused: boolean): void {
    const hud = this.hud;
    const level = this.level;
    const placement = this.placement;
    if (!hud || !level || !placement) return;
    const ps = this.play;
    const res = this.result;
    const lab = this.lab.engaged;
    ps.view = lab ? 'lab' : 'flight';
    for (let i = 0; i < ps.seeds.length; i++) {
      const s = level.seeds[this.seedIndex[i]];
      const st = res ? res.seeds[s.id] : undefined;
      const chip = ps.seeds[i];
      chip.lit = st !== undefined && st.lit;
      const c = st ? st.closest : Infinity;
      chip.almost = chip.lit || !Number.isFinite(c) ? 0 : clamp01(1 - (c - s.radius) / (2 * s.radius));
    }
    for (let i = 0; i < ps.masses.length; i++) ps.masses[i].placed = placement.placedCount(ps.masses[i].size);
    ps.selected = this.selected;
    const playing = this.phase === 'playing';
    if (playing && (this.feedState.preview.active || this.placementIssue !== null)) {
      this.placementView.legal = this.placementIssue === null;
      this.placementView.reason = this.placementIssue;
      ps.placement = this.placementView;
    } else ps.placement = null;
    ps.depth = playing && !lab && this.drag === 'none' ? this.gauge : null;
    ps.hintAvailable = this.hintLevel > 0 || this.levelTime >= FL.hintAfter;
    ps.hintLevel = this.hintLevel;
    if (this.daily) {
      const sec = Math.floor(this.dailyElapsed);
      if (sec !== this.timerSecond) {
        this.timerSecond = sec;
        this.timerText = formatTime(sec);
      }
      ps.timer = this.timerText;
    } else ps.timer = null;
    ps.canUndo = playing && placement.canUndo;
    ps.canRedo = playing && placement.canRedo;
    ps.dragging = this.drag !== 'none';
    hud.setPlay(ps);

    // Cursor tip: the legality reason at the pointer (lab), "grab / remove" over a mass.
    if (!paused) {
      if (playing && lab && this.drag === 'none' && this.hover >= 0) {
        hud.setCursorTip(this.lastPointerX, this.lastPointerY, 'Drag · right-click removes');
      } else if (playing && lab && this.placementIssue !== null) {
        hud.setCursorTip(this.lastPointerX, this.lastPointerY, this.placementIssue);
      } else if (playing && !lab && this.drag === 'none' && this.hover >= 0) {
        hud.setCursorTip(this.cssW * 0.5, this.cssH * 0.5 + 8, 'LMB grab · RMB remove');
      } else hud.setCursorTip(0, 0, null);
    }
  }

  private lastPointerX = 0;
  private lastPointerY = 0;

  private updateAudio(paused: boolean): void {
    const audio = this.audio;
    if (!audio) return;
    const res = this.result;
    const active =
      !paused &&
      res !== null &&
      this.level !== null &&
      (this.phase === 'playing' || this.phase === 'ceremony' || this.phase === 'solved' || (this.phase === 'entering' && this.feedState.beamReveal > 0.3));
    let deflection = 0;
    let refl = 0;
    if (res) {
      for (const b of res.beams) {
        deflection += Math.abs(b.deflection);
        refl += b.reflections.length / 3;
      }
    }
    audio.setBeam(deflection, refl, active);
  }

  private setFade(a: number): void {
    const el = this.fade;
    if (!el) return;
    const v = Math.round(clamp01(a) * 100) / 100;
    if (v === this.fadeShown) return;
    this.fadeShown = v;
    el.style.opacity = String(v);
  }

  private syncLayerClasses(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const noReticle = this.phase !== 'playing' || this.lab.active || this.glideT >= 0;
    if (noReticle !== this.noReticle) {
      this.noReticle = noReticle;
      ctx.layer.classList.toggle('flm-no-reticle', noReticle);
    }
  }
  private noReticle = false;

  private measureCanvas(): void {
    const c = this.ctx?.canvas;
    if (!c) return;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (w > 0 && h > 0) {
      this.cssW = w;
      this.cssH = h;
    }
  }

  private readonly onResize = (): void => this.measureCanvas();

  /** Another tab saved progress: fold it in (nothing it earned is lost) and refresh an open Atlas. */
  private readonly onStorage = (e: StorageEvent): void => {
    if (e.key !== null && e.key !== PROGRESS_KEY) return;
    syncProgress(this.progress);
    if (this.phase === 'atlas' && this.hud?.atlasOpen) this.hud.showAtlas(this.atlasModel(), this.level !== null);
  };

  // -------------------------------------------------------------------------------------------
  // Dev hook (dev builds only): window.__fl
  // -------------------------------------------------------------------------------------------

  private installDevHook(): void {
    const env = import.meta.env as { DEV?: boolean } | undefined;
    if (!env?.DEV || typeof window === 'undefined') return;
    const hook: FlDevHook = {
      load: (id) => {
        const f = findLevel(id);
        if (!f) return false;
        this.startLevel(f.level, null);
        return true;
      },
      daily: (date) => {
        const d = date ? parseDailyParam(date) : dailyId();
        if (d) this.startDaily(d);
      },
      solve: () => {
        const level = this.level;
        const placement = this.placement;
        if (!level || !placement || this.phase !== 'playing') return false;
        if (this.drag !== 'none') this.endDrag();
        placement.setAll(level.solution);
        this.retraceNow();
        return this.result?.solved ?? false;
      },
      place: (size, pos) => {
        const level = this.level;
        const placement = this.placement;
        if (!level || !placement || this.phase !== 'playing') return 'not playing';
        if (placement.available(size) <= 0) return 'no mass of that size left';
        const issue = placement.issueAt(pos[0], pos[1], pos[2], rhoOf(level, size));
        if (issue) return issue;
        placement.add(size, pos[0], pos[1], pos[2]);
        this.audio?.place(size);
        this.retraceNow();
        return null;
      },
      clear: () => this.clearAll(),
      state: () => {
        const r = this.result;
        const seeds: Record<string, unknown> = {};
        if (r && this.level) for (const s of this.level.seeds) seeds[s.id] = { lit: r.seeds[s.id]?.lit, closest: r.seeds[s.id]?.closest };
        return {
          phase: this.phase,
          view: this.lab.engaged ? 'lab' : 'flight',
          cursor: this.ctx?.cursorMode,
          level: this.level?.id ?? null,
          daily: this.daily,
          masses: this.placement?.masses.map((m) => ({ size: m.size, pos: m.pos.slice() })) ?? [],
          solved: r?.solved ?? false,
          seeds,
          beams: r?.beams.map((b) => ({ end: b.end, points: b.points.length / 3, length: b.length[b.length.length - 1] })) ?? [],
          hintLevel: this.hintLevel,
          selected: this.selected,
          hover: this.hover,
          drag: this.drag,
          share: this.shareText,
          progress: this.progress,
        };
      },
      lab: (on) => {
        const ctx = this.ctx;
        if (!ctx) return;
        if (on) ctx.requestFreeCursor();
        else {
          this.askFlight();
        }
      },
    };
    (window as unknown as { __fl?: FlDevHook }).__fl = hook;
  }

  private removeDevHook(): void {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __fl?: FlDevHook };
    if (w.__fl) delete w.__fl;
  }
}
