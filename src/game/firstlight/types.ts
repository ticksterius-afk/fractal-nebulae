/**
 * First Light — shared data contracts (design/20-first-light.md §2, §7; design/60-first-light-build.md §T).
 *
 * Everything here is plain, JSON-friendly data in the LOCAL frame of the level's nebula
 * (world = nebula.position + nebula.rotation · (local × nebula.scale)). The tracer, solver, generator
 * and the Node tools import only these types plus pure functions: no three.js, no DOM.
 */
import type { Vec3 } from '../../core/types';

export type MassSize = 'light' | 'medium' | 'heavy';
export const MASS_SIZES: readonly MassSize[] = ['light', 'medium', 'heavy'];

/** What a fractal surface does to a beam. Pearl Foam (apollonian) and Indra's Web (kleinian) reflect. */
export type SurfaceMaterial = 'absorb' | 'reflect';

export type SeedKind = 'seed' | 'echo';

export interface SeedDef {
  id: string;
  pos: Vec3;
  /** Hit radius (local). Recommended 4–6 % of the arena radius (see build plan §L). */
  radius: number;
  kind: SeedKind;
  /** Must be lit to solve the level. Echo seeds are usually means, not goals. */
  goal: boolean;
  /** Echo seeds: direction of the beam they emit once lit (normalised by the sanitiser). */
  emit?: Vec3;
}

export interface ArenaDef {
  centerLocal: Vec3;
  radiusLocal: number;
  /** First-person entry pose (free space, validated by tools/fl-check.ts). */
  vantage: { pos: Vec3; lookAt: Vec3 };
  /** Lab-view "up" (default: local +Y). */
  up?: Vec3;
}

export interface LevelDef {
  /** Unique id, e.g. "bulb-1"; also the save key. */
  id: string;
  /** Chapter id, e.g. "bend". */
  chapter: string;
  /** 1-based index inside the chapter. */
  index: number;
  /** Player-facing name, e.g. "Almost". */
  name: string;
  /** Catalogue nebula id (src/universe/catalog.ts), e.g. "bulb". */
  nebula: string;
  /** Animation clock (s) at which the nebula is frozen while the level is played. Default 0. */
  clock?: number;
  /** Surface behaviour; default from the nebula (reflect for apollonian/kleinian, else absorb). */
  material?: SurfaceMaterial;
  arena: ArenaDef;
  source: { pos: Vec3; dir: Vec3 };
  seeds: SeedDef[];
  /** Schwarzschild radius ρ per mass size (local units). */
  masses: Record<MassSize, number>;
  /** How many masses of each size the player may place. */
  budget: Partial<Record<MassSize, number>>;
  /** A known solution (validated by the solver; used by hint 2 and the tests). */
  solution: { size: MassSize; pos: Vec3 }[];
  /** [easier deduction, region hint text, designer's note]. */
  hints: [string, string, string];
  /** Index into `solution` whose position hint 2 reveals (default 0). */
  hintMass?: number;
  /** The one true thing this level shows, revealed on solve (≤ 90 chars). */
  teach: string;
  /** Optional physics tip shown the first time this level is played. */
  tip?: { label: string; text: string };
  /** Minimum number of masses that solves it (solver result); fewer-or-equal earns ✦. */
  par: number;
}

export interface ChapterDef {
  id: string;
  /** Display name, e.g. "Bend". */
  name: string;
  nebula: string;
  /** The rule it teaches, one line. */
  rule: string;
  levels: LevelDef[];
}

// ---------------------------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------------------------

/** The frozen fractal the beam travels through (LOCAL units). */
export interface TraceWorld {
  /** Distance estimate of the frozen fractal at a local point (fractal.de with the frozen params). */
  de(x: number, y: number, z: number): number;
  material: SurfaceMaterial;
}

export interface PlacedMass {
  size: MassSize;
  pos: Vec3;
  /** Schwarzschild radius (local). */
  rho: number;
}

export interface TraceOptions {
  /** Drag preview: coarser steps and a smaller step budget (see BeamTracer). */
  coarse?: boolean;
}

export type BeamEnd =
  | 'absorbed'   // hit an absorbing fractal surface
  | 'captured'   // fell inside a mass's photon sphere
  | 'exited'     // left the arena (1.25 × radius)
  | 'faded'      // intensity dropped below the seed threshold after reflections
  | 'limit';     // step / length / reflection budget exhausted

export interface Beam {
  /** Decimated polyline, flat xyz (local); at least two points. */
  points: number[];
  /** Intensity per point (1 at the source, ×0.7 per reflection). */
  intensity: number[];
  /** Cumulative path length per point (local units). */
  length: number[];
  end: BeamEnd;
  /** Where it ended (local). */
  endPos: Vec3;
  /** Surface normal at the end (absorbed / reflections), else null. */
  endNormal: Vec3 | null;
  /** Index into the masses array of the capturing mass ('captured' only), else −1. */
  captureMass: number;
  /** Reflection points (flat xyz), for flares and chimes. */
  reflections: number[];
  /** Seed id that emitted this beam (echo), or null for the source beam. */
  from: string | null;
  /** Total deflection angle accumulated from masses (radians), for the audio hum. */
  deflection: number;
}

export interface SeedState {
  lit: boolean;
  /** Closest approach of any beam to the seed centre (local); Infinity if no beam came near. */
  closest: number;
  /** Beam point (flat xyz) of that closest approach, for the "almost" connector; null if none. */
  closestPoint: Vec3 | null;
  /** Intensity of the beam that lit it (0 if unlit). */
  intensity: number;
  /** Order in which seeds lit (0, 1, 2…); −1 if unlit. */
  order: number;
}

export interface TraceResult {
  beams: Beam[];
  /** By seed id. */
  seeds: Record<string, SeedState>;
  /** Per placed mass: closest approach of any beam in units of rho (Infinity if none came near). */
  massClosest: number[];
  /** Every goal seed lit. */
  solved: boolean;
  /** Integration steps taken (diagnostics / budget tests). */
  steps: number;
}
