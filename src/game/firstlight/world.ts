/**
 * First Light — the frozen fractal a level is played in (design/60-first-light-build.md §1.9, §T).
 *
 * Pure TypeScript (catalogue + fractal registry only; no three.js, no DOM), shared by the browser and
 * the Node tools so the tracer, the solver and the GPU agree on the very same surface.
 *
 * A level names a `clock` (default 0). Its nebula is frozen at exactly `animate(base, clock)`, with
 * base = `def.params ?? fractal.defaultParams` — the same formula Universe.setFrozenClock uses — or a
 * plain copy of base when the fractal has no `animate`. The CPU DE runs at `fractal.cpuIter` (the
 * fractal modules keep cpuIter = gpuIter where the surfaces would otherwise disagree).
 *
 * Public API:
 *   nebulaFractal(nebulaId) → FractalDef                 throws for unknown ids and black holes
 *   frozenParams(nebulaId, clock = 0) → Float32Array(16) the nebula's params frozen at `clock`
 *   defaultMaterial(nebulaId) → SurfaceMaterial          'reflect' for apollonian / kleinian, else 'absorb'
 *   makeTraceWorld(level) → TraceWorld                   DE of the frozen nebula (LOCAL units) + material
 *
 * World/local transforms are NOT here: the mode owns the three.js maths.
 */
import type { FractalDef } from '../../core/types';
import { NEBULA_BY_ID } from '../../universe/catalog';
import { getFractal } from '../../fractals/registry';
import type { LevelDef, SurfaceMaterial, TraceWorld } from './types';

/** The fractal of a catalogue nebula. Throws for unknown ids and for black holes (not traceable). */
export function nebulaFractal(nebulaId: string): FractalDef {
  const def = Object.prototype.hasOwnProperty.call(NEBULA_BY_ID, nebulaId) ? NEBULA_BY_ID[nebulaId] : undefined;
  if (!def) throw new Error(`[firstlight] unknown nebula "${nebulaId}"`);
  const fractal = getFractal(def.fractal);
  if (!fractal) throw new Error(`[firstlight] nebula "${nebulaId}" has no fractal DE (black hole)`);
  return fractal;
}

/**
 * The nebula's 16 params frozen at animation clock `clock` (s): exactly what Universe uses while
 * `setFrozenClock(nebulaId, clock)` is active. Returns a new array (call it once per level).
 */
export function frozenParams(nebulaId: string, clock = 0): Float32Array {
  const fractal = nebulaFractal(nebulaId);
  const def = NEBULA_BY_ID[nebulaId];
  const base: readonly number[] = def.params ?? fractal.defaultParams;
  const params = new Float32Array(16);
  for (let k = 0; k < 16 && k < base.length; k++) params[k] = base[k];
  if (fractal.animate) fractal.animate(base, Number.isFinite(clock) ? clock : 0, params);
  return params;
}

/** Default surface behaviour of a nebula: the Pearl Foam (apollonian) and Indra's Web (kleinian) reflect. */
export function defaultMaterial(nebulaId: string): SurfaceMaterial {
  const kind = Object.prototype.hasOwnProperty.call(NEBULA_BY_ID, nebulaId) ? NEBULA_BY_ID[nebulaId].fractal : null;
  return kind === 'apollonian' || kind === 'kleinian' ? 'reflect' : 'absorb';
}

/**
 * The trace world of a level: `fractal.de(x, y, z, frozenParams, fractal.cpuIter)` in LOCAL units, and
 * the level's material (or the nebula's default). A NaN distance reads as 0 (solid): an unknown point
 * stops a beam and forbids a placement rather than letting either pass through structure.
 */
export function makeTraceWorld(level: LevelDef): TraceWorld {
  const fractal = nebulaFractal(level.nebula);
  const params = frozenParams(level.nebula, level.clock ?? 0);
  const iter = fractal.cpuIter;
  const de = fractal.de;
  return {
    de(x: number, y: number, z: number): number {
      const d = de(x, y, z, params, iter);
      return d === d ? d : 0;
    },
    material: level.material ?? defaultMaterial(level.nebula),
  };
}
