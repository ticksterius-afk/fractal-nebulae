/**
 * Fractal registry. Each fractal module exports a named FractalDef constant whose name
 * matches its file (e.g. src/fractals/mandelbulb.ts → `export const mandelbulb`).
 */
import type { FractalDef, FractalKind } from '../core/types';
import { mandelbulb } from './mandelbulb';
import { mandelbox } from './mandelbox';
import { menger } from './menger';
import { julia } from './julia';
import { sierpinski } from './sierpinski';
import { apollonian } from './apollonian';
import { kleinian } from './kleinian';
import { kifs } from './kifs';
import { tree } from './tree';

export const FRACTALS: Record<Exclude<FractalKind, 'blackhole'>, FractalDef> = {
  mandelbulb,
  mandelbox,
  menger,
  julia,
  sierpinski,
  apollonian,
  kleinian,
  kifs,
  tree,
};

export function getFractal(kind: FractalKind): FractalDef | null {
  return kind === 'blackhole' ? null : FRACTALS[kind];
}
