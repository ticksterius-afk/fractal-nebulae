/**
 * HUD-specific formatting on top of src/core/units.ts.
 */
import type { NebulaDef, NebulaRuntime } from '../core/types';
import { sci } from '../core/units';

/** 3 → "3", 2.7268 → "2.73". */
export function fmtDimension(d: number): string {
  if (!Number.isFinite(d)) return '?';
  return String(Math.round(d * 100) / 100);
}

/**
 * Acceleration in ly/s², matching the ly/s speed readout. (Expressed in Earth g the gravity-drive
 * scale gives 10¹⁴–10¹⁵ g, which reads as "crushed" rather than as a gentle pull.)
 */
export function fmtAccel(lyPerS2: number): string {
  if (!Number.isFinite(lyPerS2) || lyPerS2 <= 0) return '0 ly/s²';
  return `${sci(lyPerS2)} ly/s²`;
}

/** dτ/dt → "1 s aboard = 2.31 s outside". */
export function fmtDilation(td: number): string {
  const f = 1 / Math.max(td, 1e-12);
  const v = f < 10 ? f.toFixed(2) : f < 1000 ? f.toFixed(1) : sci(f);
  return `1 s aboard = ${v} s outside`;
}

export function fmtPercent(x: number): string {
  if (!Number.isFinite(x)) return '—';
  return `${Math.round(Math.min(Math.max(x, 0), 1) * 100)}%`;
}

/** Magnification from a log10 depth: 3.2 → "×1585". */
export function fmtZoom(depth: number): string {
  if (!Number.isFinite(depth) || depth < 0) return '—';
  return `×${sci(Math.pow(10, depth))}`;
}

export function fmtThrottle(t: number): string {
  return `×${(Number.isFinite(t) ? t : 1).toFixed(2)}`;
}

/** "Mandelbulb (power 8) · D≈3" or "Kerr black hole · spin 0.9". */
export function nebulaTypeLine(def: NebulaDef, rt?: NebulaRuntime | null): string {
  if (def.fractal === 'blackhole') {
    const bh = def.blackHole;
    const spin = bh?.spin ?? 0;
    const kind = spin > 0.05 ? 'Kerr black hole' : 'Schwarzschild black hole';
    return spin > 0.05 ? `${kind} · spin ${spin.toFixed(2)}` : `${kind} · rₛ ${sci(bh?.rs ?? 0)} ly`;
  }
  const f = rt?.fractal;
  // NaN dimension = not known (e.g. the Julia dust, the Mandelbox): omit rather than guess.
  if (f) return Number.isFinite(f.dimension) ? `${f.label} · D≈${fmtDimension(f.dimension)}` : f.label;
  return def.fractal.charAt(0).toUpperCase() + def.fractal.slice(1);
}

/**
 * On-screen tracking radius (ly) for a nebula: the visible structure rather than the faint
 * outer halo (fractal bound × 1.2, or the accretion disk for black holes).
 */
export function trackRadius(rt: NebulaRuntime): number {
  const bh = rt.def.blackHole;
  if (bh) return Math.min(rt.renderRadiusWorld, bh.rs * Math.max(bh.diskOuter, 3) * 1.1);
  return Math.min(rt.renderRadiusWorld, rt.boundRadiusWorld * 1.2);
}
