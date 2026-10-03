/**
 * Flight & simulation: the invisible gravity-drive ship, DE-adaptive cruise, hyper, gentle
 * nebula gravity, black-hole physics & wormholes, targeting, resonance pulse, autopilot and
 * voyage. Owns SimState (the single source of truth read by HUD, audio and renderer) and
 * emits AppEvents on the shared bus.
 *
 * Feel first: every control input goes through smoothing with time constants chosen to be
 * weighty and silky, never twitchy; every translation goes through a sphere-traced,
 * collision-safe integrator so the ship can never tunnel through fractal surfaces.
 *
 * Game modes (design/60-first-light-build.md §S) add three knobs, all inert by default (the Voyage):
 * a control policy (which Voyage controls are live), soft arena bounds, and a puppet mode in which
 * the mode drives the ship pose directly (lab-view orbit camera, cinematic glides).
 */
import * as THREE from 'three';
import type { AppEvents, AppSettings, NebulaDef, NebulaRuntime, SimState, Vec3 } from '../core/types';
import type { InputFrame } from '../ship/Input';
import { TUNING } from '../app/config';
import { bus } from '../core/events';
import { clamp, damp, smoothstep } from '../core/math';
import { Universe, type FractalResolver } from '../universe/Universe';
import { Autopilot, type PilotContext } from '../ship/Autopilot';
import { finiteQuat, finiteVec, lookRotation, quatErrorVector, rotationVectorToQuat } from './quat';

/** Flight-model tuning (feel). */
export const FLIGHT = {
  /** Look rotation per raw mouse count at sensitivity 1 (rad): ~0.063°/count, i.e. a full turn
   *  per ~18 cm of travel at 800 dpi (~9 cm at 1600 dpi) with raw (unadjusted) movement —
   *  unhurried, cinematic. The settings slider scales it 0.2–3×. */
  mouseRadPerPx: 0.0011,
  /** Two cascaded look smoothing stages (s) → ~0.1 s of silky, integral-preserving lag. */
  lookTau1: 0.04,
  lookTau2: 0.055,
  /** Turn-rate reduction at full hyper (steadier at warp). */
  hyperTurnDamping: 0.25,
  rollRate: 1.1, // rad/s at full Q/E
  rollTau: 0.3,
  /** Banking: roll = gain × yaw rate (rad per rad/s), capped, auto-returning. */
  bankGain: 0.1,
  bankMax: 0.075,
  bankTau: 0.45,
  /** Velocity smoothing toward the desired velocity (s): thrusting / coasting (inertial dampeners). */
  accelTau: 0.38,
  coastTau: 0.55,
  precisionFactor: 0.2,
  /** Approach limiter: speed toward the nearest surface ≤ slack × cruise × min(mult, maxMult) × distance. */
  approachSlack: 1.3,
  approachMaxMult: 8,
  /**
   * Directional speed (manual flight). Speed scales with the FREE PATH along the thrust direction
   * (sphere-traced probe until something comes within half the current wall distance), not only
   * with the distance to the nearest surface in any direction — otherwise lace-like fractals
   * (Kleinian, Apollonian, tree, Menger halls) crawl even when the way ahead is wide open, and
   * backing away from a wall is as slow as approaching it.
   *   target = max(nearest-surface distance, freeGain × free path), free path probed up to
   *   maxRatio × nearest distance.
   * Head-on approaches are unchanged: the free path is then the surface distance itself.
   *
   * UNIFORM CRUISE: the speed scale follows that target in LOG space with ~1 s time constants
   * instead of snapping to it (it used to fall instantly and rise in 0.25 s, so every floret,
   * pillar or gas pocket the probe saw made the ship lurch). Diving deeper still slows you — just
   * smoothly. Braking adapts to the time to contact along the thrust (tau = ttcFraction × ttc,
   * clamped): gentle for distant structure, firm for a wall right ahead. Collision safety does not
   * depend on this (approach limiter + guarded trace + slide + push-out do that).
   */
  dirScaleFreeGain: 0.5,
  dirScaleMaxRatio: 25,
  cruiseRiseTau: 0.6,
  cruiseFallTau: 1.1,
  cruiseFallMinTau: 0.18,
  cruiseBrakeTtcFraction: 0.3,
  /**
   * Hard brake along the thrust: speed (hyper included) never exceeds the free path ahead / this
   * many seconds. The smoothed scale can lag above the target while approaching structure; without
   * this cap the approach limiter clipped only the into-wall part and the ship skidded sideways
   * along the surface instead of flying where it points. Only binds when the path ahead is short.
   */
  brakeTtc: 1.5,
  /**
   * Near the clearance floor the smoothing must not keep speed up (grazing at a few clearances
   * outruns the tracer's guarantees): instant rule within inner × clearance, fully smoothed beyond
   * outer × clearance. Normal flight is far above this.
   */
  cruiseSafeInner: 8,
  cruiseSafeOuter: 60,
  /**
   * GHOST MODE (right mouse held, alongside hyper): fractal collisions are off — no approach
   * limiter, slide, push-out or brake cap — so the ship phases through structure: the way out of
   * any stuck spot. In contact with / inside a solid (raw DE < ghostContact × clearance) hyper is
   * suppressed and the ship slows to the ghost scale (drag time constant ghostDragTau): the wall
   * thickness ahead × ghostExitGain, so any wall takes ~2–3 s to cross, never below
   * ghostMinClearances × clearance, capped at ghostMaxFraction × the nebula's bound. It only rises
   * during one crossing (no crawl toward the exit), eased in over ghostRiseTau, and a spool (the
   * floor × e^(ghostGrowth·t)) guarantees progress when the probe finds no exit. Releasing RMB
   * inside a solid keeps ghost on and carries the ship along its last direction until it is clear
   * (raw DE > ghostClear × clearance). Black-hole gravity and capture are unaffected.
   */
  ghostContact: 4,
  ghostClear: 8,
  ghostGrowth: Math.log(3),
  ghostMaxFraction: 0.5,
  ghostMinClearances: 20,
  ghostExitGain: 0.6,
  ghostRiseTau: 0.3,
  ghostDragTau: 0.18,
  /** Hyper fades this fast (s, full → none) while phasing. */
  ghostHyperDecaySeconds: 0.35,
  /** Out of contact this long (s) ends a pass: the next contact restarts the spool. */
  ghostPassGap: 0.5,
  /** Outside structure the ghost scale relaxes back to the local scale with this time constant (s). */
  ghostRelaxTau: 0.6,
  /** Exit probes reach this × the nebula's bound radius. */
  ghostProbeFraction: 2,
  /**
   * X-ray radius (× the ghost floor) while in contact: the renderer sees through any solid a view
   * ray starts in or runs into within it, until the ray is back in open space — so the wall being
   * phased (and the rest of that body along the ray) is transparent, and the way out shows.
   */
  ghostClipFactor: 3,
  /** Log-smoothing time constant (s) of the motion-cue scale (dust motes, engine sound). */
  cueTau: 0.8,
  /**
   * Near black holes the directional boost fades out (x = r/rs): none inside inner × zoneRadius
   * (the escape rules: pointing away from a hole always "sees" open space, which would make every
   * horizon escapable at plain cruise), full beyond outer × zoneRadius. A hard switch at one radius
   * braked a tangential pass 6–10× the moment it crossed it.
   */
  dirScaleHoleInner: 1,
  dirScaleHoleOuter: 2,
  /**
   * Pinned against a wall (within this × clearance, fully at 1.5×) with the thrust pointing into it
   * at an angle, the free path is also probed along the wall (the thrust with its into-wall part
   * removed): pressing into a pearl or pillar otherwise kills the along-wall speed too, and the ship
   * crawls at ~0.5 wall distances per second around whatever it touches. Further out the ship is
   * still approaching and flies where the nose points. ≤ 1.5 disables.
   */
  dirScaleSlideFloor: 6,
  /** Sphere-traced movement: iterations per substep and fraction of the DE per step. */
  traceIterations: 12,
  traceFraction: 0.8,
  hyperDecaySeconds: 1.0,
  fovHyperDeg: 18,
  shakeMax: 0.004,
  /** Decay of leftover autopilot spin after the pilot takes over (s). */
  residualSpinTau: 0.3,
  maxAutopilotSpin: 2.0, // rad/s
  /** Idle drift toward a nebula centre as a fraction of the local cruise speed (× def.gravity). */
  driftGain: 0.12,
  /** Idle drift stops at this × boundRadiusWorld from the centre (fades in by driftFadeOuter). */
  driftStopInner: 1.25,
  driftFadeOuter: 1.8,
  /**
   * DE-adaptive speed uses min(surface distance, this) (ly): without a cap, flying away from
   * everything would grow the speed exponentially.
   */
  maxSpeedScale: 800,
  /** Soft edge of the universe (× catalog radius from its centroid): outward motion fades out
   *  between inner and outer, and an idle ship is gently drawn home. */
  boundaryInner: 1.5,
  boundaryOuter: 2.5,
  homeDriftGain: 0.08,
  /** Resonance pulse radius × surface distance, width fraction and floor. */
  pulseRadiusFactor: 6,
  pulseWidthFraction: 0.08,
  pulseMinRadius: 1e-6,
};

/** Black-hole physics tuning (radii in units of rs). */
export const BLACK_HOLE = {
  /** Pull a = pullK · rs / x² (ly/s²), x = r/rs. With gravTau this gives a terminal drift of
   *  pullK·gravTau/x² rs/s: gentle at 10 rs, beats throttle-1 cruise at ~3 rs, beats full hyper
   *  only inside ~1.3 rs. */
  pullK: 4.4,
  /** Gravity-velocity bleed time constant (s): the drive's dampeners slowly fight the pull. */
  gravTau: 2.5,
  /** Frame dragging: tangential a = k · spin · rs / x³. */
  frameDragK: 3.0,
  /** Frame dragging twisting the view: ω = k · spin / x³ (rad/s). */
  viewDragK: 0.3,
  captureRadius: 1.02,
  warnRadius: 2.5,
  rearmRadius: 4,
  tidalOuter: 4,
  /** env.blackHoleId is set inside this radius. */
  zoneRadius: 10,
  /** After a transit, the black hole at the exit (only if the exit IS a black hole) cannot
   *  capture the ship for this long. Other holes always capture: a time-based global immunity
   *  lasted 5× longer in wall-clock time at low frame rates and let the ship fall straight
   *  through a hole it was placed next to shortly after a transit. */
  immunitySeconds: 6,
  substepHz: 240,
  maxSubsteps: 12,
  /** Wormhole exit distance × renderRadiusWorld (fractal) or × worldRadius (black hole), clamped
   *  to exitInfluenceCap × influenceRadius so the exit glide carries you into the region. */
  exitFactor: 2.2,
  exitFactorBlackHole: 4,
  exitInfluenceCap: 0.75,
  /** Exit glide speed as a fraction of local cruise. */
  exitGlide: 0.1,
};

const REGION_ENTER = 0.35;
const REGION_EXIT = 0.15;
const REGION_SWITCH_MARGIN = 0.15;
const MAX_DT = 0.1;
/**
 * Longest physics step (s). Longer frames (low frame rates, e.g. the 2 fps preview pane where dt
 * is clamped to MAX_DT) are split into equal substeps of at most this length, so steering, the
 * approach limiter, the sphere-traced move, push-out and black-hole gravity see the same step
 * sizes as at 60 Hz and the flight is identical at any frame rate. Slightly above 1/60 so that
 * jittery 60 Hz frames stay single-step; frames of 1/30 s and longer get exact 1/60 s substeps.
 */
const PHYSICS_STEP = 1 / 55;
const MAX_PHYSICS_STEPS = Math.ceil(MAX_DT / PHYSICS_STEP);
/** Smallest length scale (ly) used when scaling speeds. */
const TINY = 1e-9;
/** Fallback surface distance when the universe is empty. */
const EMPTY_SCALE = 1000;
const THROTTLE_MIN = 0.05;
const THROTTLE_MAX = 4;
const THROTTLE_STEP = 1.25;
/** Autopilot collision probe budget (see probeFreeDistance). */
/** Approach limiter soft knee (fraction of the limit below which approach speed is untouched). */
const APPROACH_KNEE = 0.6;
const PROBE_MAX_STEPS = 40;
const PROBE_MIN_STRIDES = 32;
const PROBE_MARGIN = 0.02;

/**
 * Arena soft bounds (game modes): outward velocity fades between ARENA_FADE_INNER and
 * ARENA_FADE_OUTER × the arena radius (none beyond), and an idle ship beyond the radius drifts
 * back toward the centre at up to ARENA_DRIFT_RATE × radius per second (fully at the outer edge).
 */
const ARENA_FADE_INNER = 1.0;
const ARENA_FADE_OUTER = 1.5;
const ARENA_DRIFT_RATE = 0.06;

/** Which Voyage controls are live (game modes switch some off). */
export interface ControlPolicy {
  /** Right mouse: hyper + ghost. */
  hyper: boolean;
  /** Left mouse: target the nebula under the reticle. */
  targeting: boolean;
  /** Space tap: resonance pulse. */
  pulse: boolean;
  /** Space hold: gravity-glide autopilot. */
  glide: boolean;
  /** T: voyage autopilot. */
  voyage: boolean;
  /** Mouse wheel sets the cruise throttle; when false the throttle is fixed at `throttle`. */
  wheelThrottle: boolean;
  /** Fixed throttle while wheelThrottle is off (clamped to the wheel's range). */
  throttle: number;
}

/** The Voyage: everything on. */
export const DEFAULT_CONTROL_POLICY: Readonly<ControlPolicy> = Object.freeze({
  hyper: true,
  targeting: true,
  pulse: true,
  glide: true,
  voyage: true,
  wheelThrottle: true,
  throttle: 1,
});

/** Soft play sphere in a nebula's LOCAL frame (see Simulation.setArena). */
export interface ArenaBounds {
  nebulaId: string;
  centerLocal: Vec3;
  radiusLocal: number;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
/** 26 lattice directions (axes, face and body diagonals). */
const LATTICE: THREE.Vector3[] = [];
for (let x = -1; x <= 1; x++) {
  for (let y = -1; y <= 1; y++) {
    for (let z = -1; z <= 1; z++) if (x || y || z) LATTICE.push(new THREE.Vector3(x, y, z).normalize());
  }
}

const NO_INPUT: InputFrame = {
  mouseDX: 0, mouseDY: 0,
  forward: 0, strafe: 0, lift: 0, roll: 0,
  precision: false, hyper: false, click: false, spaceTap: false, spaceHold: false,
  wheel: 0,
  toggles: { hud: false, codex: false, mute: false, voyage: false },
  anyMoveInput: false,
  // Game-mode fields: never read here (hand-built frames in the test harnesses omit them).
  buttons: 0, pressed: 0, released: 0,
  pointer: { x: 0, y: 0, inside: false, dx: 0, dy: 0 },
  keyDown: () => false,
  keyPressed: () => false,
  mods: { shift: false, ctrl: false, alt: false, meta: false },
  escape: false,
};

/** Scratch frame for physics substeps after the first: held controls only, no edges / deltas. */
const HELD_ONLY: InputFrame = {
  ...NO_INPUT,
  toggles: { hud: false, codex: false, mute: false, voyage: false },
};

/** Copy the held (continuous) controls of `src` into HELD_ONLY; one-shot inputs stay zero. */
function heldOnly(src: InputFrame): InputFrame {
  const f = HELD_ONLY;
  f.forward = src.forward;
  f.strafe = src.strafe;
  f.lift = src.lift;
  f.roll = src.roll;
  f.precision = src.precision;
  f.hyper = src.hyper;
  // Only held keys count as movement here: the frame's mouse travel was delivered with the first
  // substep, and re-applying Input's "mouse is moving" flag to later substeps would cancel an
  // autopilot engaged (T / Space-hold) in that same frame whenever the mouse twitched — at low
  // frame rates every frame carries some mouse travel.
  f.anyMoveInput = src.forward !== 0 || src.strafe !== 0 || src.lift !== 0 || src.roll !== 0;
  return f;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _n = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _e = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _tracePrev = new THREE.Vector3();
const _thrustDir = new THREE.Vector3();
const _slideDir = new THREE.Vector3();
/** updateTarget() only (it also runs inside setTarget, mid-step). */
const _tgt = new THREE.Vector3();
/** Arena world centre (refreshed every substep by updateArena). */
const _arenaC = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export interface SimulationOptions {
  nebulae: NebulaDef[];
  settings: AppSettings;
  /** Test hook: override the fractal registry. */
  resolveFractal?: FractalResolver;
}

export class Simulation {
  readonly state: SimState;
  readonly universe: Universe;
  readonly nebulae: NebulaRuntime[];

  private settings: AppSettings;
  private paused = false;
  private attract = false;
  private readonly pilot: Autopilot;
  private readonly pilotCtx: PilotContext;

  // Orientation: baseQ is the unbanked attitude; the visual bank is layered on top.
  private readonly baseQ = new THREE.Quaternion();
  private readonly baseUp = new THREE.Vector3(0, 1, 0);
  private readonly baseRight = new THREE.Vector3(1, 0, 0);
  private bank = 0;
  private yawPending = 0;
  private pitchPending = 0;
  private yawStage = 0;
  private pitchStage = 0;
  private rollRate = 0;
  private yawRate = 0;
  /** World angular velocity (autopilot spring; decays as residual spin in manual mode). */
  private readonly angVel = new THREE.Vector3();

  // Translation: control velocity (drive) + gravity velocity (black holes).
  private readonly vCtrl = new THREE.Vector3();
  private readonly vGrav = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private hasThrustInput = false;
  private speedMultiplier = 1;
  // Ghost mode (see FLIGHT.ghost*).
  private ghostActive = false;
  private ghostInside = false;
  /** World ly: speed scale inside solids / floor while ghosting. */
  private ghostScale = 0;
  /** Last ghost travel direction (carries the ship through a solid after RMB is released). */
  private readonly ghostDir = new THREE.Vector3(0, 0, -1);
  /** Progress guarantee inside a solid: multiplies the ghost floor, grows while inside. */
  private ghostSpool = 1;
  /** World ly: x-ray radius (see FLIGHT.ghostClipFactor); kept while it fades out after contact. */
  private ghostClip = 0;
  /** Seconds since the ship was last in contact while ghosting (grazing flickers are one pass). */
  private ghostOutTime = Infinity;
  private thrustTarget = 0;
  private driftAccel = 0;
  private gravAccel = 0;
  /** Nearest surface distance (clamped ≥ clearance) and that nebula's clearance. */
  private surf = EMPTY_SCALE;
  private surfClear = 0;
  /** Length scale for DE-adaptive speeds: min(surf, FLIGHT.maxSpeedScale). */
  private speedScale = EMPTY_SCALE;
  /** Directional speed scale for manual flight (see FLIGHT.dirScale*). */
  private dirScale = EMPTY_SCALE;
  /** Log-smoothed flight scale for motion cues (SimState.env.flightScale). */
  private flightScale = EMPTY_SCALE;
  private readonly homeCentre = new THREE.Vector3();
  private homeRadius = EMPTY_SCALE;

  private hyperHeld = false;
  private hyperRamp = 0;

  private regionIndex = -1;
  private readonly horizonArmed: boolean[];
  private immunity = 0;
  /** Black hole the post-transit immunity applies to (−1: none). */
  private immuneHole = -1;

  private wormholeTime = 0;
  private wormholeTo = -1;
  private wormholeTeleported = false;
  private glideSpeed = 0;

  private pulseTime = 0;
  private pulseMaxRadius = 0;

  private readonly lastGoodPos = new THREE.Vector3();
  private readonly lastGoodQ = new THREE.Quaternion();

  // Game-mode knobs (see setControlPolicy / setArena / setPuppet).
  private readonly policy: ControlPolicy = { ...DEFAULT_CONTROL_POLICY };
  /** Throttle the wheel had set before a policy fixed it (restored when the wheel is live again). */
  private wheelThrottle = 1;
  private arena: ArenaBounds | null = null;
  /** Arena world radius this substep (0: no arena). Centre in _arenaC. */
  private arenaRadius = 0;
  private puppet = false;
  /** The next setPuppetPose is a cut (no velocity from the jump). */
  private puppetCut = false;

  constructor(opts: SimulationOptions) {
    this.settings = { ...opts.settings };
    this.universe = new Universe(opts.nebulae, opts.resolveFractal);
    this.nebulae = this.universe.runtimes;
    this.pilot = new Autopilot(this.nebulae);
    this.horizonArmed = this.nebulae.map(() => true);
    if (this.nebulae.length > 0) {
      for (const rt of this.nebulae) this.homeCentre.add(rt.position);
      this.homeCentre.multiplyScalar(1 / this.nebulae.length);
      let radius = 0;
      for (const rt of this.nebulae) {
        radius = Math.max(radius, rt.position.distanceTo(this.homeCentre) + rt.def.influenceRadius);
      }
      this.homeRadius = Math.max(radius, 1);
    }

    const weights: Record<string, number> = {};
    for (const rt of this.nebulae) weights[rt.def.id] = 0;
    const [sx, sy, sz] = TUNING.startPosition;
    this.state = {
      time: 0,
      dt: 0,
      paused: false,
      ship: {
        position: new THREE.Vector3(sx, sy, sz),
        velocity: new THREE.Vector3(),
        orientation: new THREE.Quaternion(),
        forward: new THREE.Vector3(0, 0, -1),
        up: new THREE.Vector3(0, 1, 0),
        right: new THREE.Vector3(1, 0, 0),
        speed: 0,
        thrust: 0,
        hyper: 0,
        betaVis: 0,
        velocityDir: new THREE.Vector3(0, 0, -1),
        throttle: 1,
        precision: false,
        autopilot: 'off',
        ghost: 0,
        ghostInside: 0,
        ghostClip: 0,
      },
      camera: { fovDeg: this.baseFov(), shake: new THREE.Vector3() },
      env: {
        regionId: null,
        weights,
        nearestId: null,
        surfaceDistance: Infinity,
        flightScale: EMPTY_SCALE,
        gravity: 0,
        timeDilation: 1,
        tidal: 0,
        blackHoleId: null,
      },
      target: { id: null, distance: 0, eta: Infinity, lightYears: 0 },
      pulse: { active: false, origin: new THREE.Vector3(), radius: 0, width: 0, age: 0, revealTime: 0, gain: 1 },
      wormhole: { active: false, progress: 0, fromId: null, toId: null },
    };
    this.pilotCtx = {
      dt: 0,
      time: 0,
      pos: this.state.ship.position,
      velocity: this.state.ship.velocity,
      forward: this.state.ship.forward,
      up: this.baseUp,
      right: this.baseRight,
      surfaceDistance: EMPTY_SCALE,
      throttle: 1,
      probe: (dir, maxDist) => this.probeFreeDistance(dir, maxDist),
    };
    this.resetToStart();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  update(dtIn: number, input: InputFrame): void {
    const dt = Number.isFinite(dtIn) ? clamp(dtIn, 0, MAX_DT) : 0;
    const s = this.state;
    const ship = s.ship;
    s.dt = dt;
    if (this.puppet) {
      this.updatePuppet(dt);
      return;
    }

    // Physics in substeps of ≤ PHYSICS_STEP (identical flight at 2 fps and at 144 fps). One-shot
    // inputs (clicks, taps, toggles, wheel, mouse travel) are delivered with the first substep.
    const n = dt > PHYSICS_STEP ? Math.min(Math.ceil(dt / PHYSICS_STEP - 1e-9), MAX_PHYSICS_STEPS) : 1;
    const h = dt / n;
    for (let k = 0; k < n; k++) this.step(h, k === 0 ? input : heldOnly(input));

    this.universe.refresh(ship.position);
    this.measureSurface();
    this.finalizeShip(dt);
    this.updateEnvironment();
    this.updateTarget();
    this.updatePulse(dt);
    this.updateCamera(dt);
  }

  /** One physics substep (dt ≤ PHYSICS_STEP). */
  private step(dt: number, input: InputFrame): void {
    const s = this.state;
    const ship = s.ship;
    s.time += dt;

    const controllable = !this.paused && !this.attract && !s.wormhole.active;
    const inp = controllable ? input : NO_INPUT;

    const pol = this.policy;
    if (!pol.wheelThrottle) {
      ship.throttle = pol.throttle;
    } else if (inp.wheel !== 0 && Number.isFinite(inp.wheel)) {
      ship.throttle = clamp(ship.throttle * Math.pow(THROTTLE_STEP, inp.wheel), THROTTLE_MIN, THROTTLE_MAX);
    }
    ship.precision = inp.precision;

    this.universe.update(s.time, ship.position);
    this.measureSurface();
    if (this.arena) this.updateArena();
    this.immunity = Math.max(0, this.immunity - dt);
    if (dt > 0) this.applyCoRotation(dt);

    this.driftAccel = 0;
    this.gravAccel = 0;
    if (s.wormhole.active) {
      this.updateHyper(dt, false);
      this.ghostActive = false;
      this.ghostInside = false;
      this.ghostOutTime = Infinity;
      this.updateWormhole(dt);
    } else {
      const hyperPressed = this.updateHyper(dt, inp.hyper && pol.hyper);
      this.updateGhost(dt);
      if (this.pilot.active && (inp.anyMoveInput || hyperPressed)) this.cancelAutopilot();
      if (inp.toggles.voyage && pol.voyage) this.toggleVoyage();
      if (inp.click && pol.targeting) this.handleClick();
      if (inp.spaceTap && pol.pulse) this.firePulse();
      if (inp.spaceHold && pol.glide) this.engageTargetAutopilot();
      if (dt > 0) {
        this.steer(dt, inp);
        this.integrate(dt);
      }
    }
    if (dt > 0) this.updateBank(dt);
    this.sanitize();
    // Keep the kinematics the next substep (autopilot, banking, glide) reads up to date.
    this.writeOrientation();
    ship.velocity.copy(this.vCtrl).add(this.vGrav);
    ship.speed = ship.velocity.length();
  }

  /**
   * Settings apply immediately: sensitivity and invert-Y are read on every look update and the
   * FOV on every camera update (update() keeps running while paused, so the pause-menu sliders
   * take effect live behind the overlay).
   */
  setSettings(s: AppSettings): void {
    this.settings = { ...s };
  }

  setPaused(p: boolean): void {
    if (p === this.paused) return;
    this.paused = p;
    this.state.paused = p;
    this.clearLook();
    if (p && this.hyperHeld) {
      this.hyperHeld = false;
      this.emit('hyperEnd', {});
    }
  }

  /** Voyage autopilot from the start pose with input ignored (behind the start screen). Turning it
   *  off resets the ship to the start pose so every launch begins with the designed first view. */
  setAttractMode(on: boolean): void {
    if (on) {
      // Close every open event pair while listeners can still hear it; attract mode is silent.
      this.closeOpenPairs();
      this.attract = true;
      this.resetToStart();
      const first = this.pilot.startVoyage(this.state.ship.position);
      if (first >= 0) this.state.target.id = this.nebulae[first].def.id;
      this.state.ship.autopilot = this.pilot.mode;
    } else if (this.attract) {
      // Reset while still silent (nothing the attract voyage did was ever announced), then
      // forget the region so the first flying frame announces it if the start lies inside one.
      this.resetToStart();
      this.attract = false;
      this.regionIndex = -1;
      this.state.env.regionId = null;
    }
  }

  /** Lock (or clear with null) the target; emits targetLock / targetClear. */
  setTarget(id: string | null): void {
    const t = this.state.target;
    if (id === null) {
      if (t.id !== null) {
        t.id = null;
        this.emit('targetClear', {});
      }
      t.distance = 0;
      t.eta = Infinity;
      t.lightYears = 0;
      return;
    }
    const idx = this.universe.indexOf(id);
    if (idx < 0) return;
    t.id = id;
    this.updateTarget(); // never expose the previous target's distance / ETA under the new id
    this.emit('targetLock', { id });
    // A new lock while gliding to a target re-routes the glide.
    if (this.pilot.mode === 'target' && this.pilot.targetIndex !== idx && this.pilot.startTarget(idx)) {
      this.emit('autopilotStart', { mode: 'target', id });
    }
  }

  // ---------------------------------------------------------------------------
  // Game-mode knobs (design/60-first-light-build.md §S). All inert in the Voyage.
  // ---------------------------------------------------------------------------

  /**
   * Switch Voyage controls off for a game mode: hyper/ghost (RMB ignored), targeting (LMB click
   * ignored; the current target is dropped), pulse (Space tap), glide (Space hold), voyage (T),
   * wheel → throttle (then the throttle is fixed at `throttle`). Unspecified fields take their
   * DEFAULT_CONTROL_POLICY value (each call states the whole policy); null restores the Voyage, and
   * with it the throttle the wheel had set. A running autopilot of a disabled kind is cancelled. A
   * ghost pass already under way still finishes (ghost ends only once the ship is clear of structure).
   */
  setControlPolicy(p: Partial<ControlPolicy> | null): void {
    const d = DEFAULT_CONTROL_POLICY;
    const pol = this.policy;
    const ship = this.state.ship;
    const wasWheel = pol.wheelThrottle;
    const flag = (v: boolean | undefined, def: boolean): boolean => (typeof v === 'boolean' ? v : def);
    pol.hyper = flag(p?.hyper, d.hyper);
    pol.targeting = flag(p?.targeting, d.targeting);
    pol.pulse = flag(p?.pulse, d.pulse);
    pol.glide = flag(p?.glide, d.glide);
    pol.voyage = flag(p?.voyage, d.voyage);
    pol.wheelThrottle = flag(p?.wheelThrottle, d.wheelThrottle);
    const t = p?.throttle;
    pol.throttle = typeof t === 'number' && Number.isFinite(t) ? clamp(t, THROTTLE_MIN, THROTTLE_MAX) : d.throttle;
    if (!pol.wheelThrottle) {
      if (wasWheel) this.wheelThrottle = ship.throttle;
      ship.throttle = pol.throttle;
    } else if (!wasWheel) {
      ship.throttle = Number.isFinite(this.wheelThrottle) ? clamp(this.wheelThrottle, THROTTLE_MIN, THROTTLE_MAX) : 1;
    }
    if (!pol.hyper && this.hyperHeld) {
      this.hyperHeld = false;
      this.emit('hyperEnd', {});
    }
    if ((!pol.voyage && this.pilot.mode === 'voyage') || (!pol.glide && this.pilot.mode === 'target')) {
      this.cancelAutopilot();
    }
    if (!pol.targeting) this.setTarget(null);
  }

  /** The control policy in effect (read-only view; change it with setControlPolicy). */
  get controlPolicy(): Readonly<ControlPolicy> {
    return this.policy;
  }

  /**
   * Soft play sphere for a game mode, in the LOCAL frame of `nebulaId`. Its world centre and radius
   * are re-derived from the nebula runtime every substep, so a spinning nebula carries the arena.
   * Outward velocity fades between 1.0 and 1.5 × the radius (none beyond); an idle ship outside the
   * radius drifts gently back toward the centre. No walls, no messages; collision safety unchanged.
   * null (or an unknown nebula / invalid sphere) removes the bounds.
   */
  setArena(a: ArenaBounds | null): void {
    const c = a?.centerLocal;
    if (
      !a ||
      !c ||
      this.universe.indexOf(a.nebulaId) < 0 ||
      !(a.radiusLocal > 0) ||
      !Number.isFinite(a.radiusLocal) ||
      !Number.isFinite(c[0] + c[1] + c[2])
    ) {
      this.arena = null;
      this.arenaRadius = 0;
      return;
    }
    this.arena = { nebulaId: a.nebulaId, centerLocal: [c[0], c[1], c[2]], radiusLocal: a.radiusLocal };
    this.updateArena();
  }

  /** True while the ship is puppeted (setPuppet). */
  get puppeted(): boolean {
    return this.puppet;
  }

  /**
   * Puppet mode: the game mode drives the ship pose itself through setPuppetPose (lab-view orbit
   * camera, cinematic glides). While on, update() skips steering, integration, collisions, hyper,
   * ghost, co-rotation, autopilot and gravity, but still animates the universe, the pulse, the camera
   * (no hyper widening) and the environment. Turning it on cancels the autopilot, hyper and ghost and
   * completes a wormhole transit in progress. Turning it off re-syncs the attitude and look state to
   * the puppet pose, zeroes the velocity and re-measures the speed scales, so flight resumes smoothly
   * from there. Release it at a free-space pose: the ship is not pushed out of structure until it moves.
   */
  setPuppet(on: boolean): void {
    if (on === this.puppet) return;
    const s = this.state;
    const ship = s.ship;
    if (on) {
      this.cancelAutopilot();
      this.pilot.cmd.boost = 0;
      if (this.hyperHeld) {
        this.hyperHeld = false;
        this.emit('hyperEnd', {});
      }
      if (s.wormhole.active) this.endWormholeNow();
      this.puppet = true;
      this.puppetCut = true;
    } else {
      this.puppet = false;
      this.puppetCut = false;
      // The unbanked attitude becomes the puppet pose (puppet poses carry no bank).
      if (finiteQuat(ship.orientation) && ship.orientation.lengthSq() > 1e-12) this.baseQ.copy(ship.orientation);
      this.bank = 0;
      this.rollRate = 0;
      this.yawRate = 0;
      this.angVel.set(0, 0, 0);
      this.vCtrl.set(0, 0, 0);
      this.vGrav.set(0, 0, 0);
      this.desired.set(0, 0, 0);
      this.writeOrientation();
      this.universe.refresh(ship.position);
      this.measureSurface();
      this.dirScale = this.speedScale;
      this.flightScale = this.speedScale;
      this.lastGoodPos.copy(ship.position);
      this.lastGoodQ.copy(this.baseQ);
      ship.velocity.set(0, 0, 0);
      ship.speed = 0;
      ship.velocityDir.copy(ship.forward);
    }
    // Both ways: nothing carried over from before (look lag, hyper ramp, ghost pass, thrust).
    this.clearLook();
    this.hasThrustInput = false;
    this.thrustTarget = 0;
    this.hyperRamp = 0;
    ship.hyper = 0;
    this.ghostActive = false;
    this.ghostInside = false;
    this.ghostOutTime = Infinity;
    this.ghostClip = 0;
    if (!on) this.updateEnvironment();
  }

  /**
   * Puppet pose (world position, camera orientation), applied immediately: forward / up / right,
   * velocity = Δposition / state.dt (0 when dt = 0, and for the first pose after setPuppet(true): a
   * cut), and the renderer's x-ray radius `ghostClip` (world ly, 0 = off) so structure between an
   * orbit camera and its focus turns to glass. The universe, surface distance and environment are
   * refreshed for the new pose. Ignored unless puppeted, and for non-finite input.
   */
  setPuppetPose(position: THREE.Vector3, orientation: THREE.Quaternion, ghostClip = 0): void {
    if (!this.puppet || !finiteVec(position) || !finiteQuat(orientation) || orientation.lengthSq() < 1e-12) return;
    const ship = this.state.ship;
    const dt = this.state.dt;
    if (!this.puppetCut && dt > 0) ship.velocity.subVectors(position, ship.position).multiplyScalar(1 / dt);
    else ship.velocity.set(0, 0, 0);
    if (!finiteVec(ship.velocity)) ship.velocity.set(0, 0, 0);
    this.puppetCut = false;
    ship.position.copy(position);
    this.baseQ.copy(orientation);
    this.bank = 0;
    this.writeOrientation();
    ship.speed = ship.velocity.length();
    if (ship.speed > TINY) ship.velocityDir.copy(ship.velocity).multiplyScalar(1 / ship.speed);
    else ship.velocityDir.copy(ship.forward);
    ship.ghostClip = ghostClip > 0 && Number.isFinite(ghostClip) ? ghostClip : 0;
    this.lastGoodPos.copy(ship.position);
    this.lastGoodQ.copy(this.baseQ);
    this.universe.refresh(ship.position);
    this.measureSurface();
    this.updateEnvironment();
  }

  /**
   * Game modes: roll the resonance-pulse wavefront out of a world point to `maxRadius` ly (First
   * Light's ignition ceremony, its Space pulse). Visual only: no bus event, so the HUD reveals no
   * nebula markers. Ignored for non-finite input. `gain` (0..1) softens the wavefront's brightness.
   */
  firePulseAt(origin: THREE.Vector3, maxRadius: number, gain = 1): void {
    if (!finiteVec(origin) || !(maxRadius > 0) || !Number.isFinite(maxRadius)) return;
    const p = this.state.pulse;
    p.active = true;
    p.gain = Number.isFinite(gain) ? Math.min(Math.max(gain, 0), 1) : 1;
    p.origin.copy(origin);
    p.age = 0;
    p.radius = 0;
    this.pulseTime = 0;
    this.pulseMaxRadius = maxRadius;
    p.width = 0.01 * maxRadius;
  }

  /** Put the ship at rest at a pose (puppet on → pose → off). Ends puppet mode if it was on. */
  teleport(position: THREE.Vector3, orientation: THREE.Quaternion): void {
    this.setPuppet(false);
    this.setPuppet(true);
    this.setPuppetPose(position, orientation);
    this.setPuppet(false);
  }

  /**
   * Reset the ship to TUNING.startPosition looking −Z, throttle 1, everything calm. Every open
   * event pair (wormhole, autopilot, hyper, target, region) is closed on the bus first, so
   * listeners never keep a stale status.
   */
  resetToStart(): void {
    this.closeOpenPairs();
    const s = this.state;
    const ship = s.ship;
    this.puppet = false;
    this.puppetCut = false;
    const [x, y, z] = TUNING.startPosition;
    ship.position.set(x, y, z);
    this.baseQ.identity();
    this.bank = 0;
    this.clearLook();
    this.rollRate = 0;
    this.yawRate = 0;
    this.angVel.set(0, 0, 0);
    this.vCtrl.set(0, 0, 0);
    this.vGrav.set(0, 0, 0);
    this.desired.set(0, 0, 0);
    this.hyperHeld = false;
    this.hyperRamp = 0;
    ship.hyper = 0;
    ship.betaVis = 0;
    ship.thrust = 0;
    ship.throttle = 1;
    ship.precision = false;
    this.thrustTarget = 0;
    this.pilot.stop();
    this.pilot.cmd.boost = 0;
    ship.autopilot = 'off';

    s.target.id = null;
    s.target.distance = 0;
    s.target.eta = Infinity;
    s.target.lightYears = 0;
    s.pulse.active = false;
    s.pulse.radius = 0;
    s.pulse.width = 0;
    s.pulse.age = 0;
    s.pulse.revealTime = 0;
    s.wormhole.active = false;
    s.wormhole.progress = 0;
    s.wormhole.fromId = null;
    s.wormhole.toId = null;
    this.wormholeTeleported = false;
    this.regionIndex = -1;
    s.env.regionId = null;
    this.horizonArmed.fill(true);
    this.immunity = 0;
    this.immuneHole = -1;

    this.universe.update(s.time, ship.position);
    this.measureSurface();
    this.dirScale = this.speedScale;
    this.flightScale = this.speedScale;
    this.ghostActive = false;
    this.ghostInside = false;
    this.ghostOutTime = Infinity;
    this.lastGoodPos.copy(ship.position);
    this.lastGoodQ.copy(this.baseQ);
    this.finalizeShip(0);
    this.updateEnvironment();
    this.updateCamera(0);
  }

  // ---------------------------------------------------------------------------
  // Controls: targeting, pulse, autopilot, hyper
  // ---------------------------------------------------------------------------

  private handleClick(): void {
    const ship = this.state.ship;
    const id = this.universe.pick(ship.position, ship.forward);
    if (id) this.setTarget(id);
    else this.setTarget(null);
  }

  private firePulse(): void {
    const p = this.state.pulse;
    p.active = true;
    p.origin.copy(this.state.ship.position);
    p.age = 0;
    p.radius = 0;
    this.pulseTime = 0;
    this.pulseMaxRadius = FLIGHT.pulseRadiusFactor * Math.max(this.surf, FLIGHT.pulseMinRadius);
    p.width = 0.01 * this.pulseMaxRadius;
    p.revealTime = TUNING.pulseRevealSeconds;
    p.gain = 1;
    this.emit('pulse', { origin: p.origin.clone() });
  }

  private engageTargetAutopilot(): void {
    const ship = this.state.ship;
    let idx = this.universe.indexOf(this.state.target.id);
    if (idx < 0) idx = this.universe.indexOf(this.universe.pick(ship.position, ship.forward));
    if (idx < 0) idx = this.nearestIndex();
    if (idx < 0) return;
    const id = this.nebulae[idx].def.id;
    if (this.state.target.id !== id) this.setTarget(id);
    if (this.pilot.startTarget(idx)) this.emit('autopilotStart', { mode: 'target', id });
  }

  private toggleVoyage(): void {
    if (this.pilot.mode === 'voyage') {
      this.cancelAutopilot();
      return;
    }
    const first = this.pilot.startVoyage(this.state.ship.position);
    if (first < 0) return;
    const id = this.nebulae[first].def.id;
    this.emit('autopilotStart', { mode: 'voyage', id });
    this.setTarget(id);
  }

  private cancelAutopilot(): void {
    if (!this.pilot.active) return;
    this.pilot.stop();
    this.emit('autopilotEnd', { reason: 'cancelled' });
  }

  /**
   * Emit the closing event of every pair that is currently open (before a reset that clears
   * the underlying state silently). Only emits; the caller resets the state.
   */
  private closeOpenPairs(): void {
    const s = this.state;
    if (s.wormhole.active) this.emit('wormholeEnd', { toId: s.wormhole.toId ?? s.wormhole.fromId ?? '' });
    if (this.pilot.active) this.emit('autopilotEnd', { reason: 'cancelled' });
    if (this.hyperHeld) this.emit('hyperEnd', {});
    if (s.target.id !== null) this.emit('targetClear', {});
    if (this.regionIndex >= 0) this.emit('regionExit', { id: this.nebulae[this.regionIndex].def.id });
  }

  /** Returns true on the frame hyper was engaged. */
  private updateHyper(dt: number, want: boolean): boolean {
    let pressed = false;
    if (want && !this.hyperHeld) {
      this.hyperHeld = true;
      pressed = true;
      this.emit('hyperStart', {});
    } else if (!want && this.hyperHeld) {
      this.hyperHeld = false;
      this.emit('hyperEnd', {});
    }
    // Phasing through a solid suppresses hyper (it spools up again once out).
    const rate =
      this.hyperHeld && !this.ghostInside
        ? 1 / Math.max(TUNING.hyperRampSeconds, 0.05)
        : -1 / (this.ghostInside ? FLIGHT.ghostHyperDecaySeconds : FLIGHT.hyperDecaySeconds);
    this.hyperRamp = clamp(this.hyperRamp + rate * dt, 0, 1);
    this.state.ship.hyper = smoothstep(0, 1, this.hyperRamp);
    return pressed;
  }

  /**
   * Ghost mode state (see FLIGHT.ghost*): on while RMB is held, and afterwards until the ship is
   * clear of structure; in contact with a solid the ghost scale follows the wall thickness ahead.
   */
  private updateGhost(dt: number): void {
    const ship = this.state.ship;
    const r = this.universe.distance(ship.position);
    const d = r.dist;
    const id = r.id;
    const clr = this.universe.clearance(id);
    const contact = clr > 0 && Number.isFinite(d) && d < FLIGHT.ghostContact * clr;
    const clear = !(clr > 0) || !Number.isFinite(d) || d > FLIGHT.ghostClear * clr;
    const floor = clr > 0 ? FLIGHT.ghostMinClearances * clr : TINY;
    const local = Math.max(this.speedScale, floor);
    if (this.hyperHeld && !this.paused) {
      if (!this.ghostActive) {
        this.ghostActive = true;
        this.ghostScale = local;
        if (ship.speed > TINY) this.ghostDir.copy(ship.velocity).normalize();
        else this.ghostDir.copy(ship.forward);
      }
    } else if (this.ghostActive && clear) {
      this.ghostActive = false;
    }
    this.ghostInside = this.ghostActive && contact;
    // A new pass only after a moment in the open: grazing along a face flickers in and out of
    // contact, and must not keep restarting the spool.
    const entering = this.ghostInside && this.ghostOutTime > FLIGHT.ghostPassGap;
    this.ghostOutTime = this.ghostInside ? 0 : this.ghostOutTime + dt;
    if (!this.ghostActive) return;
    if (!(this.ghostScale > 0) || !Number.isFinite(this.ghostScale)) this.ghostScale = local;
    if (!this.ghostInside) {
      // Outside: relax back to the local scale (the ghost scale is a floor for outside flight, so
      // the ship leaves a wall at its phasing speed and eases down from there).
      if (this.ghostScale > local) {
        const k = damp(dt, FLIGHT.ghostRelaxTau);
        this.ghostScale = Math.exp(Math.log(this.ghostScale) + (Math.log(local) - Math.log(this.ghostScale)) * k);
      } else {
        this.ghostScale = local;
      }
      return;
    }

    const rt = id ? this.universe.get(id) : undefined;
    const bound = rt ? rt.boundRadiusWorld : FLIGHT.maxSpeedScale;
    const cap = Math.max(FLIGHT.ghostMaxFraction * bound, floor);
    const probe = FLIGHT.ghostProbeFraction * bound;
    if (entering) {
      this.ghostSpool = 1;
      this.ghostScale = Math.min(this.ghostScale, cap);
    } else {
      this.ghostSpool = Math.min(this.ghostSpool * Math.exp(FLIGHT.ghostGrowth * dt), 1e9);
    }
    // Speed: the wall thickness along the travel direction sets the pace (a crossing takes about
    // the same time for any wall); the spool keeps going where the probe finds no way out.
    const exitMove = this.universe.exitDistance(id, ship.position, this.ghostDir, probe, 0.25 * floor);
    const byExit = Number.isFinite(exitMove) ? FLIGHT.ghostExitGain * exitMove : cap;
    const target = clamp(Math.max(byExit, floor * this.ghostSpool), floor, cap);
    if (target > this.ghostScale) {
      const k = damp(dt, FLIGHT.ghostRiseTau);
      this.ghostScale = Math.exp(Math.log(this.ghostScale) + (Math.log(target) - Math.log(this.ghostScale)) * k);
    }
    this.ghostClip = FLIGHT.ghostClipFactor * floor;
  }

  // ---------------------------------------------------------------------------
  // Orientation
  // ---------------------------------------------------------------------------

  private steer(dt: number, inp: InputFrame): void {
    if (this.pilot.active && !this.paused) this.steerAutopilot(dt);
    else this.steerManual(dt, inp);
  }

  private steerManual(dt: number, inp: InputFrame): void {
    const ship = this.state.ship;
    const st = this.settings;
    this.pilot.idle(dt);

    // Mouse → two cascaded exponential stages: the total rotation always equals the mouse
    // travel, delivered with a smooth ~0.1 s S-curve (inertia without mush).
    const sens =
      FLIGHT.mouseRadPerPx * clamp(Number.isFinite(st.mouseSensitivity) ? st.mouseSensitivity : 1, 0.05, 5) *
      (1 - FLIGHT.hyperTurnDamping * ship.hyper);
    this.yawPending -= inp.mouseDX * sens;
    this.pitchPending -= inp.mouseDY * sens * (st.invertY ? -1 : 1);
    const a1 = damp(dt, FLIGHT.lookTau1);
    const a2 = damp(dt, FLIGHT.lookTau2);
    let m = this.yawPending * a1;
    this.yawPending -= m;
    this.yawStage += m;
    m = this.pitchPending * a1;
    this.pitchPending -= m;
    this.pitchStage += m;
    const yaw = this.yawStage * a2;
    this.yawStage -= yaw;
    const pitch = this.pitchStage * a2;
    this.pitchStage -= pitch;
    // Roll: E rolls right (clockwise from the pilot's view) = negative about local +Z.
    this.rollRate += (-inp.roll * FLIGHT.rollRate - this.rollRate) * damp(dt, FLIGHT.rollTau);
    const roll = this.rollRate * dt;
    this.baseQ.multiply(rotationVectorToQuat(pitch, yaw, roll, _q1));

    // Leftover autopilot spin fades out instead of stopping dead.
    this.angVel.multiplyScalar(Math.exp(-dt / FLIGHT.residualSpinTau));
    if (this.angVel.lengthSq() > 1e-12) {
      this.baseQ.premultiply(rotationVectorToQuat(this.angVel.x * dt, this.angVel.y * dt, this.angVel.z * dt, _q1));
    }
    this.yawRate = yaw / dt + this.angVel.dot(this.baseUp);

    // Translation intent in ship space.
    let lx = inp.strafe;
    let ly = inp.lift;
    let lz = -inp.forward;
    if (lx === 0 && ly === 0 && lz === 0 && this.hyperHeld) lz = -1; // hyper means "go"
    const len = Math.sqrt(lx * lx + ly * ly + lz * lz);
    if (len > 1) {
      lx /= len;
      ly /= len;
      lz /= len;
    }
    this.hasThrustInput = len > 0;
    this.thrustTarget = Math.min(1, len);
    const precision = ship.precision ? FLIGHT.precisionFactor : 1;
    // Ghost inside a solid, or RMB released while not yet clear (ghost ends only once clear): no
    // hyper boost — the spooling ghost scale sets the pace. Without input the ship keeps phasing
    // along its last direction until it is clear, so it can never be left inside structure.
    if (this.ghostActive && (this.ghostInside || !this.hyperHeld)) {
      this.speedMultiplier = precision;
      const speed = TUNING.cruiseFactor * ship.throttle * precision * this.ghostScale;
      if (len > 0) {
        this.desired.set(lx, ly, lz).applyQuaternion(this.baseQ).multiplyScalar(speed);
        this.ghostDir.copy(this.desired).normalize();
      } else if (!this.paused) {
        this.desired.copy(this.ghostDir).multiplyScalar(speed);
        this.hasThrustInput = true;
        this.thrustTarget = 1;
      } else {
        this.desired.set(0, 0, 0);
      }
      this.dirScale = this.ghostScale; // leaving the solid, cruise picks up from the phasing pace
      this.updateFlightScale(this.ghostScale, dt);
      return;
    }
    const hyperMult = Math.exp(Math.log(TUNING.hyperMaxMultiplier) * ship.hyper);
    this.speedMultiplier = precision * Math.min(hyperMult, FLIGHT.approachMaxMult);
    const perScale = TUNING.cruiseFactor * ship.throttle * precision * hyperMult;
    const scale = this.directionalScale(lx, ly, lz, dt, perScale, this.ghostActive);
    let maxSpeed = perScale * scale;
    // Ghost, outside: no braking toward structure — never slower than the phasing speed (a floor
    // on the speed, not the scale: hyper does not multiply it, so gaps between walls stay calm).
    const ghostSpeed = this.ghostActive ? TUNING.cruiseFactor * ship.throttle * precision * this.ghostScale : 0;
    if (ghostSpeed > maxSpeed) maxSpeed = ghostSpeed;
    this.updateFlightScale(Math.max(scale, this.ghostActive ? this.ghostScale : 0), dt);
    this.desired.set(lx, ly, lz).applyQuaternion(this.baseQ).multiplyScalar(maxSpeed);
    if (this.ghostActive && len > 0) this.ghostDir.copy(this.desired).normalize();
    if (!this.hasThrustInput && !this.paused) {
      this.addNebulaDrift();
      this.addHomeDrift();
      if (this.arenaRadius > 0) this.addArenaDrift();
    }
  }

  /**
   * Speed scale for manual flight along the (ship-space) thrust direction: the nearest-surface
   * distance, raised toward the free path ahead (see FLIGHT.dirScale*), then smoothed in log space
   * (FLIGHT.cruise*) so the cruise stays uniform inside structure. The approach limiter and the
   * guarded sphere-traced move keep every direction collision-safe regardless of this scale.
   */
  private directionalScale(lx: number, ly: number, lz: number, dt: number, perScale: number, ghost = false): number {
    const iso = this.speedScale;
    // Black holes keep the isotropic, instant rule (see FLIGHT.dirScaleHole*: the danger is part
    // of the design); the smoothing fades out with the directional boost.
    const zone = BLACK_HOLE.zoneRadius;
    const holeWeight = smoothstep(FLIGHT.dirScaleHoleInner * zone, FLIGHT.dirScaleHoleOuter * zone, this.minBlackHoleX());
    const thrusting = !(lx === 0 && ly === 0 && lz === 0);
    let target = iso;
    let free = Infinity;
    const maxProbe = Math.min(FLIGHT.maxSpeedScale, FLIGHT.dirScaleMaxRatio * iso);
    if (thrusting && holeWeight > 0 && maxProbe > iso * 1.05) {
      _thrustDir.set(lx, ly, lz).normalize().applyQuaternion(this.baseQ);
      free = this.probeFreeDistance(_thrustDir, maxProbe);
      const clr = this.surfClear;
      const floor = FLIGHT.dirScaleSlideFloor;
      const slide = clr > 0 && floor > 1.5 ? 1 - smoothstep(1.5 * clr, floor * clr, this.surf) : 0;
      if (slide > 0) {
        this.universe.gradient(this.state.ship.position, Math.max(0.25 * this.surf, clr), _n);
        const into = -_thrustDir.dot(_n);
        if (_n.lengthSq() > 0.5 && into > 0) {
          _slideDir.copy(_thrustDir).addScaledVector(_n, into);
          const along = _slideDir.length();
          if (along > 0.05) {
            const freeAlong = this.probeFreeDistance(_slideDir.multiplyScalar(1 / along), maxProbe);
            if (Number.isFinite(freeAlong)) free = Math.max(free, slide * freeAlong);
          }
        }
      }
      if (Number.isFinite(free)) target = iso + holeWeight * Math.max(0, FLIGHT.dirScaleFreeGain * free - iso);
    }
    if (!(target > 0) || !Number.isFinite(target)) target = iso;
    const prev = this.dirScale > 0 && Number.isFinite(this.dirScale) ? this.dirScale : target;
    let tau: number;
    if (target >= prev) {
      tau = FLIGHT.cruiseRiseTau;
    } else {
      // Brake by time to contact along the thrust: gentle for distant structure, firm up close.
      const speed = this.state.ship.speed;
      const ttc = Number.isFinite(free) && speed > TINY ? free / speed : Infinity;
      tau = clamp(FLIGHT.cruiseBrakeTtcFraction * ttc, FLIGHT.cruiseFallMinTau, FLIGHT.cruiseFallTau);
    }
    tau *= holeWeight; // inside a black hole's zone: the old instant rule (escape physics unchanged)
    const k = tau > 1e-6 ? damp(dt, tau) : 1;
    let next = Math.exp(Math.log(prev) + (Math.log(target) - Math.log(prev)) * k);
    // Near the clearance floor: no lag above the target (see FLIGHT.cruiseSafe*).
    const clr = this.surfClear;
    if (!ghost && clr > 0 && next > target) {
      const w = smoothstep(FLIGHT.cruiseSafeInner * clr, FLIGHT.cruiseSafeOuter * clr, this.surf);
      next = Math.exp(Math.log(target) + w * (Math.log(next) - Math.log(target)));
    }
    // Brake along the thrust (see FLIGHT.brakeTtc): stored, so recovery afterwards is smooth too.
    if (!ghost && thrusting && Number.isFinite(free) && free > 0 && perScale > 0) {
      const cap = free / (FLIGHT.brakeTtc * perScale);
      if (next > cap) next = Math.max(cap, TINY);
    }
    this.dirScale = next;
    return next;
  }

  /** Motion-cue scale: log-smoothed toward the scale the ship is currently flying at. */
  private updateFlightScale(target: number, dt: number): void {
    if (!(target > 0) || !Number.isFinite(target)) return;
    const prev = this.flightScale > 0 && Number.isFinite(this.flightScale) ? this.flightScale : target;
    const k = damp(dt, FLIGHT.cueTau);
    this.flightScale = Math.exp(Math.log(prev) + (Math.log(target) - Math.log(prev)) * k);
  }

  /**
   * Cruise scale that reproduces the ship's current speed at the current throttle, so taking over
   * from the autopilot (or leaving a pause) continues smoothly instead of snapping to the local
   * surface distance.
   */
  private cruiseFromMotion(): number {
    const ship = this.state.ship;
    const per = TUNING.cruiseFactor * Math.max(ship.throttle, TINY);
    const s = ship.speed / per;
    return Number.isFinite(s) && s > this.speedScale ? Math.min(s, FLIGHT.maxSpeedScale) : this.speedScale;
  }

  private steerAutopilot(dt: number): void {
    const ship = this.state.ship;
    const ctx = this.pilotCtx;
    ctx.dt = dt;
    ctx.time = this.state.time;
    ctx.surfaceDistance = this.speedScale;
    ctx.throttle = ship.throttle;
    // The directional boost is manual-only: the pilot takes over at the speed the autopilot flew.
    this.dirScale = this.cruiseFromMotion();
    this.updateFlightScale(this.speedScale, dt);
    const cmd = this.pilot.update(ctx);
    if (cmd.arrivedNow) this.emit('autopilotEnd', { reason: 'arrived' });
    if (cmd.legStarted >= 0) this.setTarget(this.nebulae[cmd.legStarted].def.id);

    // Critically damped spring toward the commanded look rotation (implicit damping: stable at any dt).
    lookRotation(cmd.lookDir, cmd.upHint, _q2.copy(this.baseQ));
    quatErrorVector(this.baseQ, _q2, _e);
    const k = cmd.stiffness;
    this.angVel.addScaledVector(_e, k * k * dt).multiplyScalar(1 / (1 + 2 * k * dt));
    const spin = this.angVel.length();
    const maxSpin = Math.min(FLIGHT.maxAutopilotSpin, cmd.maxSpin > 0 ? cmd.maxSpin : FLIGHT.maxAutopilotSpin);
    if (spin > maxSpin) this.angVel.multiplyScalar(maxSpin / spin);
    this.baseQ.premultiply(rotationVectorToQuat(this.angVel.x * dt, this.angVel.y * dt, this.angVel.z * dt, _q1));
    this.yawRate = this.angVel.dot(this.baseUp);
    this.clearLook();

    this.desired.copy(cmd.velocity);
    this.hasThrustInput = true;
    this.thrustTarget = cmd.thrust;
    this.speedMultiplier = Math.min(cmd.speedMultiplier, FLIGHT.approachMaxMult);
  }

  private updateBank(dt: number): void {
    const ship = this.state.ship;
    let target = 0;
    if (!this.state.wormhole.active) {
      const cruise = TUNING.cruiseFactor * ship.throttle * this.speedScale;
      const speedRatio = clamp(ship.speed / Math.max(cruise, TINY), 0, 1);
      target = clamp(FLIGHT.bankGain * this.yawRate, -FLIGHT.bankMax, FLIGHT.bankMax) * (0.35 + 0.65 * speedRatio);
    }
    if (!Number.isFinite(target)) target = 0;
    this.bank += (target - this.bank) * damp(dt, FLIGHT.bankTau);
  }

  private clearLook(): void {
    this.yawPending = 0;
    this.pitchPending = 0;
    this.yawStage = 0;
    this.pitchStage = 0;
  }

  private writeOrientation(): void {
    const ship = this.state.ship;
    this.baseQ.normalize();
    ship.orientation.copy(this.baseQ).multiply(_q1.setFromAxisAngle(AXIS_Z, this.bank));
    ship.forward.set(0, 0, -1).applyQuaternion(ship.orientation);
    ship.up.set(0, 1, 0).applyQuaternion(ship.orientation);
    ship.right.set(1, 0, 0).applyQuaternion(ship.orientation);
    this.baseUp.set(0, 1, 0).applyQuaternion(this.baseQ);
    this.baseRight.set(1, 0, 0).applyQuaternion(this.baseQ);
  }

  // ---------------------------------------------------------------------------
  // Translation & physics
  // ---------------------------------------------------------------------------

  /** Idle "inviting" drift toward nearby nebulae; stops at a comfortable distance. */
  private addNebulaDrift(): void {
    const pos = this.state.ship.position;
    for (const rt of this.nebulae) {
      if (!rt.fractal || rt.influence <= 0 || rt.def.gravity <= 0) continue;
      const stop = smoothstep(FLIGHT.driftStopInner, FLIGHT.driftFadeOuter, rt.distance / rt.boundRadiusWorld);
      if (stop <= 0) continue;
      const speed =
        FLIGHT.driftGain * TUNING.cruiseFactor * rt.def.gravity * rt.influence * stop * Math.max(rt.surfaceDistance, 0);
      if (!(speed > 0)) continue;
      _v1.subVectors(rt.position, pos).multiplyScalar(1 / rt.distance);
      this.desired.addScaledVector(_v1, speed);
      this.driftAccel += speed / FLIGHT.coastTau;
    }
  }

  /** Beyond the soft edge of the universe an idle ship is gently drawn back toward home. */
  private addHomeDrift(): void {
    const edge = this.boundaryFactor();
    if (edge <= 0) return;
    _v1.subVectors(this.homeCentre, this.state.ship.position).normalize();
    const speed = FLIGHT.homeDriftGain * TUNING.cruiseFactor * this.speedScale * edge;
    this.desired.addScaledVector(_v1, speed);
    this.driftAccel += speed / FLIGHT.coastTau;
  }

  /** 0 inside the universe, → 1 at its soft outer edge. */
  private boundaryFactor(): number {
    const r = this.state.ship.position.distanceTo(this.homeCentre);
    return smoothstep(this.homeRadius * FLIGHT.boundaryInner, this.homeRadius * FLIGHT.boundaryOuter, r);
  }

  /** Arena world centre (_arenaC) and radius from the nebula runtime as of this substep (spin included). */
  private updateArena(): void {
    const a = this.arena;
    const rt = a ? this.universe.get(a.nebulaId) : undefined;
    if (!a || !rt) {
      this.arenaRadius = 0;
      return;
    }
    const c = a.centerLocal;
    _arenaC.set(c[0], c[1], c[2]).multiplyScalar(rt.scale).applyQuaternion(rt.rotation).add(rt.position);
    const R = a.radiusLocal * rt.scale;
    this.arenaRadius = Number.isFinite(R) && finiteVec(_arenaC) ? R : 0;
  }

  /** 0 inside the arena radius, → 1 at ARENA_FADE_OUTER × radius; 0 without an arena. */
  private arenaFactor(): number {
    const R = this.arenaRadius;
    if (!(R > 0)) return 0;
    const r = this.state.ship.position.distanceTo(_arenaC);
    return smoothstep(ARENA_FADE_INNER * R, ARENA_FADE_OUTER * R, r);
  }

  /** Outside the arena radius an idle ship drifts gently back toward the arena centre. */
  private addArenaDrift(): void {
    const edge = this.arenaFactor();
    if (edge <= 0) return;
    _v1.subVectors(_arenaC, this.state.ship.position).normalize();
    const speed = ARENA_DRIFT_RATE * this.arenaRadius * edge;
    this.desired.addScaledVector(_v1, speed);
    this.driftAccel += speed / FLIGHT.coastTau;
  }

  private integrate(dt: number): void {
    const ship = this.state.ship;
    const pos = ship.position;

    // Inertial dampeners: control velocity eases toward the desired velocity.
    // Phasing through a solid is viscous: the ship sheds its approach speed quickly.
    const tau = this.ghostInside ? FLIGHT.ghostDragTau : this.hasThrustInput ? FLIGHT.accelTau : FLIGHT.coastTau;
    this.vCtrl.lerp(this.desired, damp(dt, tau));

    // Soft edge of the universe: outward motion fades away (you are never walled in, just held).
    const edge = this.boundaryFactor();
    if (edge > 0) {
      _v1.subVectors(pos, this.homeCentre).normalize();
      const out = this.vCtrl.dot(_v1);
      const allowed = Math.max(this.desired.dot(_v1), 0) * (1 - edge);
      if (out > allowed) this.vCtrl.addScaledVector(_v1, allowed - out);
    }
    // Arena soft bounds (game modes): the same rule around the play sphere.
    const arenaEdge = this.arenaFactor();
    if (arenaEdge > 0) {
      _v1.subVectors(pos, _arenaC).normalize();
      const out = this.vCtrl.dot(_v1);
      const allowed = Math.max(this.desired.dot(_v1), 0) * (1 - arenaEdge);
      if (out > allowed) this.vCtrl.addScaledVector(_v1, allowed - out);
    }

    // Approach limiter: the component toward the nearest surface is capped relative to the
    // distance, so even hyper approaches asymptotically (you dive into detail, never clip).
    // (Off in ghost mode: phasing through structure is the point.)
    const r0 = this.universe.distance(pos);
    const d0 = r0.dist;
    if (!this.ghostActive && Number.isFinite(d0)) {
      const clr = this.universe.clearance(r0.id);
      const dRef = Math.max(d0, clr, TINY);
      this.universe.gradient(pos, Math.max(0.25 * Math.abs(d0), clr, TINY), _n);
      if (_n.lengthSq() > 0.5) {
        const lim = FLIGHT.approachSlack * TUNING.cruiseFactor * ship.throttle * this.speedMultiplier * dRef;
        // Soft knee instead of a hard clamp: untouched below APPROACH_KNEE × lim, then eased
        // smoothly (tanh, matched slope) toward lim — braking toward a wall never jolts.
        const vn = this.vCtrl.dot(_n);
        const x = lim > 0 ? -vn / lim : 0;
        if (x > APPROACH_KNEE) {
          const r = 1 - APPROACH_KNEE;
          const soft = APPROACH_KNEE + r * Math.tanh((x - APPROACH_KNEE) / r);
          this.vCtrl.addScaledVector(_n, -vn - soft * lim);
        }
      }
    }

    const nearBH = this.minBlackHoleX() < BLACK_HOLE.zoneRadius * 1.5;
    const steps = nearBH
      ? clamp(Math.ceil(dt * BLACK_HOLE.substepHz), 1, BLACK_HOLE.maxSubsteps)
      : clamp(Math.ceil(dt * 60), 1, 4);
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      if (!this.paused) this.applyBlackHoleGravity(h);
      // Paused: the fall bleeds off like any other coasting motion (gentle stop behind the menu).
      this.vGrav.multiplyScalar(Math.exp(-h / (this.paused ? FLIGHT.coastTau : BLACK_HOLE.gravTau)));
      _v1.copy(this.vCtrl).add(this.vGrav).multiplyScalar(h);
      if (this.ghostActive) {
        pos.add(_v1); // ghost: straight through structure
      } else {
        const achieved = this.trace(_v1);
        if (achieved < 0.999) this.slideAlongSurface(achieved <= 0);
      }
      if (this.checkCapture()) return;
    }
    if (!this.ghostActive) this.pushOut();
  }

  /**
   * The move fell short (structure ahead, or the trace ran out of iterations at speed): drop only
   * the velocity heading INTO the surfaces there, so the ship slides along walls and keeps its
   * speed along corridors. (Scaling the whole velocity by the achieved fraction made the ship
   * grind to a halt wherever structure was close — the "can't move" feeling in lacy fractals.)
   * Two normals: the nearest surface's, and that of the surface just ahead along the move (in a
   * crease or corner the wall that stopped the move is not the nearest one, and velocity left
   * pointing into it pinned the ship for seconds — Menger's finest holes).
   */
  private slideAlongSurface(stopped: boolean): void {
    const pos = this.state.ship.position;
    if (stopped) {
      // No progress at all (clearance-scale holes where the gradients are noise): whatever the
      // normals say, stop pushing along the blocked direction, or the ship stays pinned.
      _v2.copy(_dir).negate();
      this.clipInward(_v2);
    }
    const r = this.universe.distance(pos);
    const d = Math.abs(r.dist);
    if (!Number.isFinite(d)) return;
    const clr = this.universe.clearance(r.id);
    this.universe.gradient(pos, Math.max(0.25 * d, clr, TINY), _n);
    _probe.copy(pos).addScaledVector(_dir, Math.max(d, 0.5 * clr, TINY)); // _dir: the move's direction
    this.universe.gradient(_probe, Math.max(0.25 * d, 0.25 * clr, TINY), _n2);
    for (let k = 0; k < 2; k++) {
      this.clipInward(_n);
      this.clipInward(_n2);
    }
  }

  /** Remove the velocity heading into a surface with (unit, or zero) outward normal n. */
  private clipInward(n: THREE.Vector3): void {
    if (n.lengthSq() < 0.5) return;
    const vn = this.vCtrl.dot(n);
    if (vn < 0) this.vCtrl.addScaledVector(n, -vn);
    const vg = this.vGrav.dot(n);
    if (vg < 0) this.vGrav.addScaledVector(n, -vg);
  }

  /**
   * Sphere-traced move along `disp`; returns the fraction of the displacement achieved. Steps are
   * a fraction of the DE, so a (conservative) DE can never be crossed. Closer than half the
   * clearance (pressed against a surface, in a hole thinner than the clearance, or inside a surface
   * the structure breathed into) DE steps would stall, so a short fixed step is tried instead and
   * taken only if it provably stays outside — a straight step that crossed a surface would need
   * d + dNext ≤ its length — without hugging the surface, or (from inside) if it leads out. (The
   * former blind 0.4-clearance step walked into walls and, with 12 iterations and the slide keeping
   * the speed, straight through clearance-thin ones: Menger's finest walls, bulb and KIFS crevices.)
   * A DE step from outside that still lands inside can only come from a DE that is not
   * conservative at this scale (the Mandelbulb's log-based DE near its surface): that step is undone.
   */
  private trace(disp: THREE.Vector3): number {
    const L = disp.length();
    if (!(L > 0) || !Number.isFinite(L)) return 1;
    _dir.copy(disp).multiplyScalar(1 / L);
    const pos = this.state.ship.position;
    let remaining = L;
    /** Length of the last DE step (0 after a verified fixed step); _tracePrev is where it began. */
    let lastStep = 0;
    for (let i = 0; i < FLIGHT.traceIterations && remaining > 0; i++) {
      const r = this.universe.distance(pos);
      const d = r.dist;
      if (lastStep > 0 && !(d > 0)) break; // undone below
      const clr = this.universe.clearance(r.id);
      if (d >= 0.5 * clr) {
        const step = Math.min(remaining, FLIGHT.traceFraction * Math.max(d, TINY));
        _tracePrev.copy(pos);
        lastStep = step;
        pos.addScaledVector(_dir, step);
        remaining -= step;
        continue;
      }
      const step = Math.min(remaining, FLIGHT.traceFraction * 0.5 * clr, d > 0 ? 1.6 * d : Infinity);
      _probe.copy(pos).addScaledVector(_dir, step);
      const dNext = this.universe.distanceValue(_probe);
      const ok = d > 0 ? d + dNext > step && (dNext > 0.1 * clr || dNext > d) : dNext > d;
      if (!ok) break;
      pos.copy(_probe);
      remaining -= step;
      lastStep = 0;
    }
    // A DE step from outside that landed inside: the DE overestimated here. Undo that step only.
    if (lastStep > 0 && !(this.universe.distanceValue(pos) > 0)) {
      pos.copy(_tracePrev);
      remaining += lastStep;
    }
    return (L - remaining) / L;
  }

  /**
   * Autopilot collision probe: free distance from the ship along unit `dir` (≤ maxDist) before
   * the path comes closer to structure than a margin (PROBE_MARGIN × maxDist, but never more than
   * half the ship's own current clearance), so only passages wide enough to fly through at speed
   * count as open. Sphere-traced with a minimum stride of maxDist/PROBE_MIN_STRIDES so grazing
   * rays still finish; a wall thinner than a stride can be missed, which only costs the navigator
   * a re-plan on its next check.
   */
  private probeFreeDistance(dir: THREE.Vector3, maxDist: number): number {
    if (!(maxDist > 0) || !finiteVec(dir)) return 0;
    const pos = this.state.ship.position;
    const minStride = maxDist / PROBE_MIN_STRIDES;
    let t = 0;
    let limit = 0;
    for (let i = 0; i < PROBE_MAX_STEPS; i++) {
      const r = this.universe.distance(_probe.copy(pos).addScaledVector(dir, t));
      if (i === 0) {
        limit = Math.max(this.universe.clearance(r.id), Math.min(PROBE_MARGIN * maxDist, 0.5 * r.dist));
      } else if (!(r.dist >= limit)) {
        return t;
      }
      if (t >= maxDist) return maxDist;
      t = Math.min(maxDist, t + Math.max(0.9 * r.dist, minStride));
    }
    return t;
  }

  /** Keep a minimum clearance from fractal surfaces (push out along the DE gradient). */
  private pushOut(): void {
    const pos = this.state.ship.position;
    for (let iter = 0; iter < 3; iter++) {
      const r = this.universe.distance(pos);
      const d = r.dist;
      const id = r.id;
      const clr = this.universe.clearance(id);
      if (!(clr > 0) || !(d < clr)) return;
      this.universe.gradient(pos, clr, _n);
      if (_n.lengthSq() < 0.5) {
        const rt = id ? this.universe.get(id) : undefined;
        if (rt) _n.subVectors(pos, rt.position);
        if (_n.lengthSq() < 1e-24) _n.copy(WORLD_UP);
        _n.normalize();
      }
      const vn = this.vCtrl.dot(_n);
      if (vn < 0) this.vCtrl.addScaledVector(_n, -vn);
      const vg = this.vGrav.dot(_n);
      if (vg < 0) this.vGrav.addScaledVector(_n, -vg);
      // Only accept a push that gets further out without crossing a surface on the way (from
      // outside, a straight push that crossed one would need d + dNew ≤ its length): where the DE
      // is not a true distance (inside the Mandelbulb) its gradient is noise, and pushing by
      // 1.5·clr − d along it compounded every iteration — down to ~1000 clearances inside. In a hole
      // thinner than the clearance the full push overshoots into the far wall: shorter pushes are
      // tried (they centre the ship), then a small local search.
      let push = clr * 1.5 - d;
      let k = 0;
      for (; k < 4; k++, push *= 0.5) {
        _probe.copy(pos).addScaledVector(_n, push);
        const dNew = this.universe.distanceValue(_probe);
        if (dNew > d && (d <= 0 || d + dNew > push)) break;
      }
      if (k < 4) pos.copy(_probe);
      else if (!this.escapeLocally(d, clr)) return;
    }
  }

  /**
   * Push-out's last resort where the DE gradient is noise (clearance-scale holes, e.g. Menger's
   * finest): move to the best of 26 lattice directions at ¼, ½ or 1 clearance that is further out
   * and provably not across a surface (d + dNew > step). Only runs when push-out is failing.
   */
  private escapeLocally(d: number, clr: number): boolean {
    const pos = this.state.ship.position;
    let best = d;
    let bestStep = 0;
    for (let f = 0.25; f <= 1; f *= 2) {
      const step = f * clr;
      for (const u of LATTICE) {
        _probe.copy(pos).addScaledVector(u, step);
        const dNew = this.universe.distanceValue(_probe);
        if (dNew > best && (d <= 0 || d + dNew > step)) {
          best = dNew;
          bestStep = step;
          _e.copy(u);
        }
      }
      if (best >= 0.5 * clr) break;
    }
    if (!(bestStep > 0)) return false;
    pos.addScaledVector(_e, bestStep);
    return true;
  }

  /** Smallest r/rs over all black holes (Infinity if none). */
  private minBlackHoleX(): number {
    let best = Infinity;
    for (const rt of this.nebulae) {
      if (rt.fractal) continue;
      const x = rt.position.distanceTo(this.state.ship.position) / rt.scale;
      if (x < best) best = x;
    }
    return best;
  }

  private applyBlackHoleGravity(h: number): void {
    const pos = this.state.ship.position;
    for (const rt of this.nebulae) {
      const bh = rt.def.blackHole;
      if (rt.fractal || !bh) continue;
      _v2.subVectors(rt.position, pos);
      const r = _v2.length();
      const influence = rt.def.influenceRadius;
      if (r >= influence || r < 1e-12) continue;
      const rs = rt.scale;
      const x = Math.max(r / rs, 0.5);
      const fade = 1 - smoothstep(0.7 * influence, influence, r);
      const aPull = ((BLACK_HOLE.pullK * rs) / (x * x)) * fade;
      this.vGrav.addScaledVector(_v2, (aPull * h) / r);
      let aTotal = aPull;
      if (bh.spin > 0) {
        _v3.set(0, 1, 0).applyQuaternion(rt.rotation); // spin axis = local +Y (jets)
        _v4.copy(_v2).multiplyScalar(-1 / r); // outward radial
        _v5.crossVectors(_v3, _v4); // prograde tangent, |·| = sin θ
        const aDrag = ((BLACK_HOLE.frameDragK * bh.spin * rs) / (x * x * x)) * fade;
        this.vGrav.addScaledVector(_v5, aDrag * h);
        aTotal += aDrag * _v5.length();
        // Spacetime itself is dragged around: the view slowly twists with the hole.
        const w = ((BLACK_HOLE.viewDragK * bh.spin) / (x * x * x)) * fade;
        this.baseQ.premultiply(_q1.setFromAxisAngle(_v3, w * h));
      }
      if (aTotal > this.gravAccel) this.gravAccel = aTotal;
    }
  }

  /** Horizon crossing → wormhole. Returns true if a transit started. */
  private checkCapture(): boolean {
    if (this.state.wormhole.active) return false;
    const pos = this.state.ship.position;
    for (const rt of this.nebulae) {
      if (rt.fractal || !rt.def.blackHole) continue;
      if (this.immunity > 0 && rt.index === this.immuneHole) continue;
      if (rt.position.distanceTo(pos) < BLACK_HOLE.captureRadius * rt.scale) {
        if (this.paused) {
          // Never start a transit behind the pause menu: hold at the horizon; it begins on resume.
          this.vCtrl.set(0, 0, 0);
          this.vGrav.set(0, 0, 0);
          return false;
        }
        this.startWormhole(rt.index);
        return true;
      }
    }
    return false;
  }

  /** Carry the ship with the rotation of a spinning nebula it is inside. */
  private applyCoRotation(dt: number): void {
    const pos = this.state.ship.position;
    for (const rt of this.nebulae) {
      const rate = rt.def.spinRate;
      if (rate === 0) continue;
      const w = 1 - smoothstep(rt.boundRadiusWorld, rt.boundRadiusWorld * 1.3, rt.distance);
      if (w <= 0) continue;
      const a = rt.def.spinAxis;
      _v1.set(a[0], a[1], a[2]);
      if (_v1.lengthSq() < 1e-12) _v1.set(0, 1, 0);
      _v1.normalize().applyQuaternion(rt.rotation); // world spin axis
      _q1.setFromAxisAngle(_v1, rate * dt * w);
      _v2.subVectors(pos, rt.position).applyQuaternion(_q1);
      pos.copy(rt.position).add(_v2);
      this.baseQ.premultiply(_q1);
      this.vCtrl.applyQuaternion(_q1);
    }
  }

  // ---------------------------------------------------------------------------
  // Wormhole
  // ---------------------------------------------------------------------------

  private startWormhole(bhIndex: number): void {
    const s = this.state;
    const from = this.nebulae[bhIndex];
    let to = this.universe.indexOf(from.def.blackHole?.wormholeTo ?? null);
    if (to < 0 || to === bhIndex) to = this.fallbackExit(bhIndex);
    if (this.pilot.active) this.cancelAutopilot();
    if (this.hyperHeld) {
      this.hyperHeld = false;
      this.emit('hyperEnd', {});
    }
    this.vCtrl.set(0, 0, 0);
    this.vGrav.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.desired.set(0, 0, 0);
    this.clearLook();
    this.wormholeTime = 0;
    this.wormholeTo = to;
    this.wormholeTeleported = false;
    s.wormhole.active = true;
    s.wormhole.progress = 0;
    s.wormhole.fromId = from.def.id;
    s.wormhole.toId = this.nebulae[to].def.id;
    this.emit('wormholeStart', { fromId: from.def.id, toId: s.wormhole.toId });
  }

  /** Nearest fractal nebula to a black hole (or the hole itself if there is none). */
  private fallbackExit(bhIndex: number): number {
    const c = this.nebulae[bhIndex].position;
    let best = bhIndex;
    let bestD = Infinity;
    for (const rt of this.nebulae) {
      if (!rt.fractal) continue;
      const d = rt.position.distanceToSquared(c);
      if (d < bestD) {
        bestD = d;
        best = rt.index;
      }
    }
    return best;
  }

  private updateWormhole(dt: number): void {
    const w = this.state.wormhole;
    // The transit is the ship's journey, not an ambient animation: it waits while paused.
    if (!this.paused) this.wormholeTime += dt / Math.max(TUNING.wormholeSeconds, 0.1);
    w.progress = Math.min(1, this.wormholeTime);
    this.yawRate = 0;
    if (!this.wormholeTeleported && w.progress >= 0.5) this.teleportToExit();
    if (this.wormholeTeleported && dt > 0) {
      // Glide gently out of the exit mouth (controls are still locked).
      if (this.paused) this.desired.set(0, 0, 0);
      else this.desired.copy(this.state.ship.forward).multiplyScalar(this.glideSpeed);
      this.hasThrustInput = !this.paused;
      this.speedMultiplier = 1;
      this.thrustTarget = this.paused ? 0 : 0.3;
      this.integrate(dt);
    } else {
      this.thrustTarget = 0;
    }
    if (w.progress >= 1) {
      const toId = w.toId ?? '';
      w.active = false;
      w.progress = 0;
      w.fromId = null;
      w.toId = null;
      this.immunity = BLACK_HOLE.immunitySeconds;
      this.emit('wormholeEnd', { toId });
    }
  }

  private teleportToExit(): void {
    const ship = this.state.ship;
    const T = this.nebulae[this.wormholeTo];
    const R = Math.max(
      Math.min(
        T.fractal ? BLACK_HOLE.exitFactor * T.renderRadiusWorld : BLACK_HOLE.exitFactorBlackHole * T.def.worldRadius,
        BLACK_HOLE.exitInfluenceCap * T.def.influenceRadius,
      ),
      T.boundRadiusWorld * 1.3,
    );

    // Pleasant side: between the nebula's key light and the way back toward home, a little above.
    const dir = _v1.set(0, 0, 0);
    const light = T.def.lights[0];
    if (light) {
      _v2.set(light.local[0], light.local[1], light.local[2]).applyQuaternion(T.rotation);
      if (_v2.lengthSq() > 1e-8) dir.addScaledVector(_v2.normalize(), 0.6);
    }
    const [hx, hy, hz] = TUNING.startPosition;
    _v2.set(hx, hy, hz).sub(T.position);
    if (_v2.lengthSq() > 1e-8) dir.addScaledVector(_v2.normalize(), 0.6);
    dir.y += 0.3;
    if (dir.lengthSq() < 1e-8) dir.set(0, 0.3, 1);
    dir.normalize();
    _q1.setFromAxisAngle(WORLD_UP, Math.PI / 4);
    for (let k = 0; k < 8; k++) {
      _v3.copy(T.position).addScaledVector(dir, R);
      if (!this.overlapsOther(_v3, T.index)) break;
      dir.applyQuaternion(_q1);
    }
    ship.position.copy(_v3);

    _v4.subVectors(T.position, ship.position);
    if (_v4.lengthSq() > 1e-18) lookRotation(_v4.normalize(), WORLD_UP, this.baseQ);
    this.bank = 0;
    this.clearLook();
    this.angVel.set(0, 0, 0);
    this.vGrav.set(0, 0, 0);
    this.writeOrientation();

    this.universe.refresh(ship.position);
    this.measureSurface();
    this.dirScale = this.speedScale;
    this.flightScale = this.speedScale;
    this.ghostActive = false;
    this.ghostInside = false;
    this.ghostOutTime = Infinity;
    this.glideSpeed = BLACK_HOLE.exitGlide * TUNING.cruiseFactor * this.speedScale;
    this.vCtrl.copy(ship.forward).multiplyScalar(this.glideSpeed);
    this.setTarget(null);
    this.state.pulse.active = false;
    this.immunity = BLACK_HOLE.immunitySeconds + TUNING.wormholeSeconds;
    this.immuneHole = T.fractal ? -1 : T.index;
    this.wormholeTeleported = true;
    this.lastGoodPos.copy(ship.position);
    this.lastGoodQ.copy(this.baseQ);
  }

  private overlapsOther(p: THREE.Vector3, except: number): boolean {
    for (const rt of this.nebulae) {
      if (rt.index === except) continue;
      const keepOut = rt.fractal ? rt.renderRadiusWorld * 1.2 : Math.max(rt.renderRadiusWorld, 10 * rt.scale);
      if (p.distanceTo(rt.position) < keepOut) return true;
    }
    return false;
  }

  /** Complete a wormhole transit at once (puppet takeover); the ship stays where it is. */
  private endWormholeNow(): void {
    const w = this.state.wormhole;
    const toId = w.toId ?? w.fromId ?? '';
    // Still at the entry horizon (before the jump): that hole must not swallow the ship again.
    if (!this.wormholeTeleported) this.immuneHole = this.universe.indexOf(w.fromId);
    w.active = false;
    w.progress = 0;
    w.fromId = null;
    w.toId = null;
    this.wormholeTeleported = false;
    this.immunity = BLACK_HOLE.immunitySeconds;
    this.emit('wormholeEnd', { toId });
  }

  // ---------------------------------------------------------------------------
  // Puppet frame
  // ---------------------------------------------------------------------------

  /**
   * One frame while puppeted (setPuppet): the pose belongs to the game mode. The universe keeps
   * breathing and spinning, the pulse and the camera keep animating and the environment follows the
   * pose; nothing moves the ship. The velocity lasts one frame: setPuppetPose sets it again.
   */
  private updatePuppet(dt: number): void {
    const s = this.state;
    const ship = s.ship;
    s.time += dt;
    ship.velocity.set(0, 0, 0);
    ship.speed = 0;
    ship.velocityDir.copy(ship.forward);
    this.universe.update(s.time, ship.position);
    this.measureSurface();
    if (this.arena) this.updateArena();
    this.updateFlightScale(this.speedScale, dt);
    // Motion cues settle: no thrust, hyper or ghost while puppeted.
    ship.thrust = clamp(ship.thrust * (1 - damp(dt, 0.25)), 0, 1);
    ship.ghost *= 1 - damp(dt, 0.15);
    ship.ghostInside *= 1 - damp(dt, 0.12);
    ship.autopilot = this.pilot.mode;
    this.updateEnvironment();
    this.updateTarget();
    this.updatePulse(dt);
    this.updateCamera(dt);
  }

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  private measureSurface(): void {
    let best = Infinity;
    let bi = -1;
    for (const rt of this.nebulae) {
      if (rt.surfaceDistance < best) {
        best = rt.surfaceDistance;
        bi = rt.index;
      }
    }
    this.surfClear = bi >= 0 ? this.universe.clearance(this.nebulae[bi].def.id) : 0;
    this.surf = Number.isFinite(best) ? Math.max(best, this.surfClear, TINY) : EMPTY_SCALE;
    this.speedScale = Math.min(this.surf, FLIGHT.maxSpeedScale);
  }

  private nearestIndex(): number {
    let best = Infinity;
    let bi = -1;
    for (const rt of this.nebulae) {
      if (rt.surfaceDistance < best) {
        best = rt.surfaceDistance;
        bi = rt.index;
      }
    }
    return bi;
  }

  /** Recover from any numerical blow-up (never let NaN reach the renderer). */
  private sanitize(): void {
    const ship = this.state.ship;
    if (!finiteVec(ship.position)) {
      ship.position.copy(this.lastGoodPos);
      this.vCtrl.set(0, 0, 0);
      this.vGrav.set(0, 0, 0);
    }
    if (!finiteQuat(this.baseQ) || this.baseQ.lengthSq() < 1e-12) {
      this.baseQ.copy(this.lastGoodQ);
      this.angVel.set(0, 0, 0);
      this.clearLook();
    }
    if (!finiteVec(this.vCtrl)) this.vCtrl.set(0, 0, 0);
    if (!finiteVec(this.vGrav)) this.vGrav.set(0, 0, 0);
    if (!finiteVec(this.angVel)) this.angVel.set(0, 0, 0);
    if (!Number.isFinite(this.bank)) this.bank = 0;
    if (!Number.isFinite(this.rollRate)) this.rollRate = 0;
    this.lastGoodPos.copy(ship.position);
    this.lastGoodQ.copy(this.baseQ);
  }

  private finalizeShip(dt: number): void {
    const ship = this.state.ship;
    this.writeOrientation();
    ship.velocity.copy(this.vCtrl).add(this.vGrav);
    ship.speed = ship.velocity.length();
    // Zero-safe direction: blends to forward when speed is negligible for the local scale.
    const eps = 1e-3 * TUNING.cruiseFactor * this.speedScale;
    ship.velocityDir.copy(ship.velocity).addScaledVector(ship.forward, eps);
    if (ship.velocityDir.lengthSq() > 1e-300) ship.velocityDir.normalize();
    else ship.velocityDir.copy(ship.forward);
    ship.thrust = clamp(ship.thrust + (this.thrustTarget - ship.thrust) * damp(dt, 0.25), 0, 1);
    ship.autopilot = this.pilot.mode;
    ship.ghost += ((this.ghostActive ? 1 : 0) - ship.ghost) * damp(dt, 0.15);
    ship.ghostInside += ((this.ghostInside ? 1 : 0) - ship.ghostInside) * damp(dt, 0.12);
    // X-ray radius: on at contact (the phase-in shimmer covers the switch), fades after it.
    if (this.ghostInside) ship.ghostClip = this.ghostClip;
    else ship.ghostClip = ship.ghostInside > 1e-3 ? this.ghostClip * smoothstep(0, 1, ship.ghostInside) : 0;
    if (!this.ghostActive && ship.ghostInside < 1e-3) this.ghostClip = 0;
  }

  private updateEnvironment(): void {
    const s = this.state;
    const env = s.env;
    let maxInfl = 0;
    let maxIdx = -1;
    let td = 1;
    let tidal = 0;
    let bhIdx = -1;
    let bhX = Infinity;
    for (let i = 0; i < this.nebulae.length; i++) {
      const rt = this.nebulae[i];
      env.weights[rt.def.id] = rt.influence;
      if (rt.influence > maxInfl) {
        maxInfl = rt.influence;
        maxIdx = i;
      }
      if (rt.fractal) continue;
      const x = rt.distance / rt.scale;
      if (rt.influence > 0) {
        const tdHere = Math.sqrt(Math.max(0, 1 - 1 / Math.max(x, 1e-9)));
        td = Math.min(td, 1 - rt.influence * (1 - tdHere));
      }
      tidal = Math.max(tidal, 1 - smoothstep(1, BLACK_HOLE.tidalOuter, x));
      if (x < BLACK_HOLE.zoneRadius && x < bhX) {
        bhX = x;
        bhIdx = i;
      }
      if (this.horizonArmed[i]) {
        if (x < BLACK_HOLE.warnRadius && !s.wormhole.active) {
          this.horizonArmed[i] = false;
          this.emit('horizonWarning', { id: rt.def.id });
        }
      } else if (x > BLACK_HOLE.rearmRadius) {
        this.horizonArmed[i] = true;
      }
    }

    // Region with hysteresis.
    const cur = this.regionIndex;
    if (cur >= 0) {
      const ci = this.nebulae[cur].influence;
      const switchTo = maxIdx >= 0 && maxIdx !== cur && maxInfl > REGION_ENTER && maxInfl > ci + REGION_SWITCH_MARGIN;
      if (ci < REGION_EXIT || switchTo) {
        this.regionIndex = -1;
        this.emit('regionExit', { id: this.nebulae[cur].def.id });
      }
    }
    if (this.regionIndex < 0 && maxIdx >= 0 && maxInfl > REGION_ENTER) {
      this.regionIndex = maxIdx;
      this.emit('regionEnter', { id: this.nebulae[maxIdx].def.id });
    }
    env.regionId = this.regionIndex >= 0 ? this.nebulae[this.regionIndex].def.id : null;

    const near = this.nearestIndex();
    env.nearestId = near >= 0 ? this.nebulae[near].def.id : null;
    env.surfaceDistance = near >= 0 ? this.surf : Infinity;
    env.flightScale = this.flightScale;
    env.gravity = this.gravAccel + this.driftAccel;
    env.timeDilation = td;
    env.tidal = tidal;
    env.blackHoleId = bhIdx >= 0 ? this.nebulae[bhIdx].def.id : null;
  }

  private updateTarget(): void {
    const t = this.state.target;
    if (t.id === null) return;
    const rt = this.universe.get(t.id);
    if (!rt) {
      this.setTarget(null);
      return;
    }
    const ship = this.state.ship;
    _tgt.subVectors(rt.position, ship.position);
    const d = _tgt.length();
    t.distance = d;
    t.lightYears = d;
    const closing = d > 1e-12 ? ship.velocity.dot(_tgt) / d : 0;
    t.eta = closing > 1e-12 ? d / closing : Infinity;
  }

  private updatePulse(dt: number): void {
    const p = this.state.pulse;
    p.revealTime = Math.max(0, p.revealTime - dt);
    if (!p.active) return;
    this.pulseTime += dt / Math.max(TUNING.pulseDuration, 0.1);
    if (this.pulseTime >= 1) {
      p.active = false;
      p.radius = 0;
      p.width = 0;
      p.age = 0;
      return;
    }
    const a = this.pulseTime;
    const eased = 1 - (1 - a) * (1 - a) * (1 - a); // ease-out cubic
    p.age = a;
    p.radius = this.pulseMaxRadius * eased;
    p.width = FLIGHT.pulseWidthFraction * p.radius + 0.01 * this.pulseMaxRadius;
  }

  private updateCamera(dt: number): void {
    const s = this.state;
    const ship = s.ship;
    const boost = this.pilot.cmd.boost;
    const warp = Math.max(ship.hyper, 0.75 * boost);
    const betaTarget = s.wormhole.active ? 0 : 0.9 * warp;
    ship.betaVis = clamp(ship.betaVis + (betaTarget - ship.betaVis) * damp(dt, 0.2), 0, 0.92);
    s.camera.fovDeg = this.baseFov() + FLIGHT.fovHyperDeg * Math.max(ship.hyper * ship.hyper, 0.5 * boost * boost);
    const amp = FLIGHT.shakeMax * clamp(0.6 * ship.hyper * ship.hyper + 0.9 * s.env.tidal, 0, 1);
    const t = s.time;
    s.camera.shake.set(
      amp * (0.55 * Math.sin(t * 41.3) + 0.3 * Math.sin(t * 67.9 + 1.1) + 0.15 * Math.sin(t * 13.7 + 2.3)),
      amp * (0.55 * Math.sin(t * 37.1 + 0.7) + 0.3 * Math.sin(t * 71.3 + 2.9) + 0.15 * Math.sin(t * 11.9 + 0.4)),
      amp * 0.6 * (0.6 * Math.sin(t * 29.3 + 1.9) + 0.4 * Math.sin(t * 53.1 + 0.2)),
    );
  }

  private baseFov(): number {
    const f = this.settings.fovDeg;
    return Number.isFinite(f) ? clamp(f, 30, 120) : 70;
  }

  private emit<K extends keyof AppEvents>(type: K, payload: AppEvents[K]): void {
    if (!this.attract) bus.emit(type, payload);
  }
}
