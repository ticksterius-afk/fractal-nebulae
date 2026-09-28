/**
 * Shared contracts for the whole app. Every module codes against these types.
 * World unit = 1 light-year (ly). World positions are JS doubles (THREE.Vector3 on CPU).
 * The GPU only ever sees camera-relative or nebula-local float32 values.
 */
import type * as THREE from 'three';

export type Vec3 = [number, number, number];
export type RGB = [number, number, number]; // linear 0..1 (may exceed 1 for HDR emission)
export type Quat = [number, number, number, number]; // x, y, z, w

// ---------------------------------------------------------------------------
// Fractals
// ---------------------------------------------------------------------------

export type FractalKind =
  | 'mandelbulb'
  | 'mandelbox'
  | 'menger'
  | 'julia'
  | 'sierpinski'
  | 'apollonian'
  | 'kleinian'
  | 'kifs'
  | 'tree'
  | 'blackhole';

/**
 * A distance-estimated fractal. `glsl` and `de` MUST be exact mirrors of each other:
 * same math, same params layout, same iteration semantics, so the CPU (flight speed,
 * collision, targeting) agrees with what the GPU draws.
 *
 * GLSL contract (see src/render/shaders/common.ts and ARCHITECTURE.md §Fractal GLSL):
 *   The template provides before the include:
 *     uniform vec4 uP[4];   // 16 params (animated values already applied on CPU)
 *     uniform int  uIter;   // iteration budget chosen by the renderer (<= FRACTAL_MAX_ITER)
 *     uniform float uTime;  // seconds; ONLY for shading embellishment, never inside fractalDE
 *     + all helpers from COMMON_GLSL
 *   The fractal source must define:
 *     #define FRACTAL_MAX_ITER <int constant>
 *     float fractalDE(vec3 p, out vec4 trap);
 *   and may optionally define (guarded by #define FRACTAL_HAS_ALBEDO):
 *     vec3 fractalAlbedo(vec3 p, vec4 trap, vec3 n, vec3 palA, vec3 palB, vec3 palC, vec3 palD);
 *
 *   trap semantics (all in 0..1):
 *     x = primary colour coordinate (orbit trap), fed into the nebula cosine palette
 *     y = "depth/age" (iteration fraction or cavity measure) → darkens crevices / AO hint
 *     z = secondary colour coordinate (mixed in lightly)
 *     w = emission mask: 1 = hot glowing region (star-forming knots, bright filaments)
 */
export interface FractalDef {
  kind: Exclude<FractalKind, 'blackhole'>;
  /** Human label, e.g. "Mandelbulb (power 8)". */
  label: string;
  /** GLSL source (see contract above). */
  glsl: string;
  /** CPU mirror of fractalDE (distance only), p in LOCAL units. Returns LOCAL distance. */
  de: (x: number, y: number, z: number, params: Float32Array, iter: number) => number;
  /** 16 floats; layout documented in the fractal's file. */
  defaultParams: number[];
  /**
   * Optional per-frame animation. Returns the params to use at time t (seconds).
   * Must write into `out` (length 16). Used for BOTH the GPU uniforms and the CPU DE.
   * Keep motion slow and hypnotic (the fractals use periods of ~100–1200 s).
   */
  animate?: (base: readonly number[], t: number, out: Float32Array) => void;
  /** Bounding sphere radius in LOCAL units that fully contains the fractal surface. */
  boundRadius: number;
  /** Iterations to use on the CPU for de() (flight). */
  cpuIter: number;
  /** Suggested GPU iterations at quality "high" (renderer scales it). */
  gpuIter: number;
  /** Hausdorff / box-counting dimension (for HUD), e.g. 2.727. NaN when not known (the HUD omits it). */
  dimension: number;
}

// ---------------------------------------------------------------------------
// Nebula catalog
// ---------------------------------------------------------------------------

export interface PaletteDef {
  /** IQ cosine palette for surface albedo: col = a + b*cos(2π(c*t + d)), t from trap.x */
  a: RGB;
  b: RGB;
  c: RGB;
  d: RGB;
  /** Emission of hot regions (trap.w) and of gas hugging the surface. HDR allowed. */
  glowNear: RGB;
  /** Colour of the wide outer gas envelope / halo. */
  glowFar: RGB;
  /** Rim / back-light colour on silhouette edges (the bright pillar edges in JWST images). */
  rim: RGB;
  /** Ambient light tint inside the nebula. */
  ambient: RGB;
}

export interface NebulaLight {
  /** Position in LOCAL fractal units (may lie inside the fractal: a young star in a pillar tip). */
  local: Vec3;
  /** Linear colour × intensity (HDR). */
  color: RGB;
  /** Rendered sprite size multiplier (1 = normal bright star). */
  size: number;
}

export interface BlackHoleParams {
  /** Schwarzschild radius in world ly. */
  rs: number;
  /** Dimensionless spin 0..0.99 (visual: disk asymmetry + frame dragging). */
  spin: number;
  /** Accretion disk inner/outer radius in units of rs. */
  diskInner: number;
  diskOuter: number;
  /**
   * Fractal texture of the accretion disk (disk lies in the nebula's LOCAL XZ plane;
   * tilt it through NebulaDef.rotation).
   */
  diskStyle: 'mandelbrot' | 'julia';
  /** Disk base colours: inner (hot) → outer (cool). HDR. */
  diskHot: RGB;
  diskCool: RGB;
  /** Relativistic jets along local ±Y. */
  jets: boolean;
  jetColor: RGB;
  /** Where the event horizon leads (wormhole exit): nebula id. */
  wormholeTo: string;
}

export interface NebulaDef {
  id: string;
  /** Poetic name shown in HUD, e.g. "The Cauliflower Nebula". */
  name: string;
  /** Catalog designation, e.g. "FN-0008". */
  catalog: string;
  fractal: FractalKind;
  /** World position of the centre (ly). */
  position: Vec3;
  /** Orientation local→world (normalized quaternion). */
  rotation: Quat;
  /** Slow spin: axis (local) and angular speed (rad/s). */
  spinAxis: Vec3;
  spinRate: number;
  /**
   * Desired world radius (ly) of the fractal's bounding sphere.
   * scale (ly per local unit) = worldRadius / fractal.boundRadius.
   * For black holes this is the lensing sphere radius.
   */
  worldRadius: number;
  /** Gas halo extends to worldRadius * haloFactor (render bound). 2.5 for fractals, 1.0 for black holes (= lensing sphere). */
  haloFactor: number;
  /** Region boundary (ly from centre) for HUD "entering…" and music crossfade. */
  influenceRadius: number;
  /** Optional param overrides (16 floats) replacing fractal.defaultParams. */
  params?: number[];
  palette: PaletteDef;
  lights: NebulaLight[];
  /**
   * Dimensionless 0..1 strength of the gentle "inviting" pull toward the nebula centre
   * felt inside its influence radius (the flight model maps it to a drift proportional to
   * the local cruise speed). Black holes additionally use real Schwarzschild physics via rs.
   */
  gravity: number;
  /** Black hole specifics (only when fractal === 'blackhole'). */
  blackHole?: BlackHoleParams;
  /** Music profile id (see src/audio/profiles.ts). */
  music: string;
  /** Short tagline for the "Entering…" banner. */
  tagline: string;
}

/** Per-frame runtime state of a nebula (owned/updated by Universe). */
export interface NebulaRuntime {
  def: NebulaDef;
  index: number;
  /** null for black holes. */
  fractal: FractalDef | null;
  position: THREE.Vector3; // world (double)
  rotation: THREE.Quaternion; // local→world, animated (spin applied)
  rotationInv: THREE.Quaternion; // world→local
  scale: number; // world ly per local unit
  boundRadiusWorld: number; // fractal bound (ly)
  renderRadiusWorld: number; // bound × haloFactor (ly)
  params: Float32Array; // current animated params (16)
  // ---- updated each frame relative to the ship ----
  distance: number; // ship → centre (ly)
  /** 0..1 region influence (1 deep inside, 0 outside influenceRadius). */
  influence: number;
  /** Rough world-space distance from ship to the fractal surface (ly). */
  surfaceDistance: number;
}

// ---------------------------------------------------------------------------
// Codex (educational content)
// ---------------------------------------------------------------------------

export interface CodexEntry {
  id: string; // nebula id
  title: string; // same as nebula name
  fractalName: string; // e.g. "Mandelbulb"
  formula: string; // Unicode formula, e.g. "zₙ₊₁ = zₙ⁸ + c  (spherical coordinates)"
  dimension: string; // e.g. "≈ 3 (boundary)"
  discovered: string; // e.g. "Daniel White & Paul Nylander, 2009"
  summary: string; // 2–3 sentences: what it is
  nature: string[]; // where it appears in nature
  facts: string[]; // surprising / inspiring facts
  physics?: string[]; // physics notes (esp. black holes)
  musicNote: string; // one line about how the music expresses it
}

// ---------------------------------------------------------------------------
// Simulation state (single source of truth read by HUD / audio / renderer)
// ---------------------------------------------------------------------------

export interface SimState {
  time: number; // seconds since launch (real time)
  dt: number;
  paused: boolean;
  ship: {
    position: THREE.Vector3; // world ly (double)
    velocity: THREE.Vector3; // ly/s
    orientation: THREE.Quaternion; // ship/camera local→world. Camera looks down local -Z, up = +Y.
    forward: THREE.Vector3; // unit, world
    up: THREE.Vector3; // unit, world
    right: THREE.Vector3; // unit, world
    speed: number; // ly/s
    /** 0..1 current thrust input magnitude (for engine sound / FX). */
    thrust: number;
    /** 0..1 hyper-acceleration intensity (ramps while RMB held). */
    hyper: number;
    /** Visual relativistic beta 0..0.92 used for aberration/Doppler FX (driven by hyper). */
    betaVis: number;
    /** Unit direction of velocity (world). Zero-safe: equals forward when speed≈0. */
    velocityDir: THREE.Vector3;
    /** Cruise multiplier set by mouse wheel (0.05..4, default 1). */
    throttle: number;
    precision: boolean; // Shift held
    autopilot: 'off' | 'target' | 'voyage';
    /** Ghost (phase) mode, smoothed 0..1: collisions off while right mouse is held (and until clear). */
    ghost: number;
    /** 0..1 smoothed: the ship is phasing through a solid right now. */
    ghostInside: number;
    /** World radius (ly) of the see-through sphere the renderer cuts around the camera; 0 = off. */
    ghostClip: number;
  };
  camera: {
    fovDeg: number; // vertical FOV incl. hyper widening
    /** small shake offsets (radians) applied on top of orientation: pitch, yaw, roll */
    shake: THREE.Vector3;
  };
  env: {
    /** Nebula with highest influence (null in the void). */
    regionId: string | null;
    /** Influence 0..1 per nebula id (for music crossfade). */
    weights: Record<string, number>;
    /** Nearest nebula by surface distance. */
    nearestId: string | null;
    /** World distance to nearest fractal surface / bound (ly). */
    surfaceDistance: number;
    /**
     * Smoothed length scale of the current flight (ly): the (log-smoothed) cruise scale the ship
     * speed is proportional to. Use it for motion cues (dust motes, engine sound) so perceived speed
     * stays uniform instead of pulsing with the raw surface distance.
     */
    flightScale: number;
    /** Magnitude of gravitational acceleration currently felt (ly/s²). */
    gravity: number;
    /** dτ/dt: 1 = none, → 0 near a black-hole horizon. */
    timeDilation: number;
    /** 0..1 tidal danger (black hole proximity). */
    tidal: number;
    /** Id of black hole whose tidal zone we're in, or null. */
    blackHoleId: string | null;
  };
  target: {
    id: string | null;
    distance: number; // ly to centre
    /** ETA in seconds at current closing speed (Infinity if not closing). */
    eta: number;
    /** Light travel time to target in years (= distance in ly). */
    lightYears: number;
  };
  pulse: {
    active: boolean;
    /** Origin in world ly (where Space was pressed). */
    origin: THREE.Vector3;
    /** Current wavefront radius (ly). */
    radius: number;
    /** Wavefront thickness (ly). */
    width: number;
    /** 0..1 normalized age (fades out towards 1). */
    age: number;
    /** HUD reveal timer: seconds remaining to show all nebula markers. */
    revealTime: number;
  };
  wormhole: {
    active: boolean;
    progress: number; // 0..1 over the transit
    fromId: string | null;
    toId: string | null;
  };
}

// ---------------------------------------------------------------------------
// Settings & quality
// ---------------------------------------------------------------------------

export type QualityName = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  name: QualityName;
  /** Dynamic resolution bounds (fraction of output resolution). */
  renderScaleMin: number;
  renderScaleMax: number;
  /** Target frame time in ms for dynamic resolution. */
  targetFrameMs: number;
  /** Max raymarch steps per nebula pass. */
  marchSteps: number;
  /** Multiplier applied to FractalDef.gpuIter. */
  iterScale: number;
  /** Soft shadows toward the nebula's key light. */
  shadows: boolean;
  /** Ambient-occlusion samples (0 = use trap.y only). */
  aoSamples: number;
  /** Sky cubemap face size. */
  skyCubeSize: number;
  farStarCount: number;
  localStarCount: number;
  dustCount: number;
  bloom: boolean;
}

export interface AppSettings {
  quality: QualityName;
  musicVolume: number; // 0..1
  sfxVolume: number; // 0..1
  mouseSensitivity: number; // 0.2..3, default 1
  invertY: boolean;
  fovDeg: number; // base vertical FOV, default 70
  showHints: boolean;
  /** Launch (and stay) full screen; F11 / Alt+Enter and the pause toggle change it. */
  fullscreen: boolean;
}

// ---------------------------------------------------------------------------
// Events (see src/core/events.ts)
// ---------------------------------------------------------------------------

export interface AppEvents {
  regionEnter: { id: string };
  regionExit: { id: string };
  targetLock: { id: string };
  targetClear: {};
  pulse: { origin: THREE.Vector3 };
  autopilotStart: { mode: 'target' | 'voyage'; id: string | null };
  autopilotEnd: { reason: 'arrived' | 'cancelled' };
  hyperStart: {};
  hyperEnd: {};
  horizonWarning: { id: string };
  wormholeStart: { fromId: string; toId: string };
  wormholeEnd: { toId: string };
  settingsChanged: { settings: AppSettings };
  pause: {};
  resume: {};
}
