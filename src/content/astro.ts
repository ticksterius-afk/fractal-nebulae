/**
 * Small astrophysics helpers used to derive the numbers quoted in the codex from the live
 * catalog (sizes, black-hole masses, Kerr radii, Hawking temperatures), so the text stays
 * correct if the catalog is retuned. Pure functions; evaluated once at module load.
 */
import type { BlackHoleParams } from '../core/types';
import { NEBULA_BY_ID, NEBULAE } from '../universe/catalog';
import { getFractal } from '../fractals/registry';
import { C_LY_PER_S, KM_PER_LY, MPH_PER_KM_S, sci } from '../core/units';

/** Schwarzschild radius of the Sun, 2GM☉/c² (km). */
export const SUN_SCHWARZSCHILD_KM = 2.95325;
/** Length of the tallest Pillar of Creation (NASA: "about four light-years"). */
export const PILLAR_OF_CREATION_LY = 4;
/** Approximate diameter of the Orion Nebula (ly). */
export const ORION_NEBULA_LY = 24;
/** Hawking temperature of a one-solar-mass black hole (K); T ∝ 1/M. */
const HAWKING_T_SUN_K = 6.17e-8;
/** Evaporation time of a one-solar-mass black hole (years); t ∝ M³. */
const EVAPORATION_YEARS_SUN = 2.1e67;

const GROUPING = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** 2730 → "2,730". */
export function formatInt(n: number): string {
  return Number.isFinite(n) ? GROUPING.format(Math.round(n)) : '∞';
}

/** Round to a "nice" figure for prose: nearest 5 above 20, nearest integer below. */
export function roundNice(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 20 ? Math.max(20, Math.round(n / 5) * 5) : Math.max(1, Math.round(n));
}

/** 9.61e12 → "9.6 trillion", 1.6e13 → "16 trillion"; `digits` = significant digits. */
export function formatCount(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '∞';
  if (n >= 1e15) return sci(n, 2);
  const scales: [number, string][] = [
    [1e12, 'trillion'],
    [1e9, 'billion'],
    [1e6, 'million'],
  ];
  for (const [v, name] of scales) {
    if (n >= v) {
      const x = Number((n / v).toPrecision(Math.max(1, digits)));
      return `${x >= 1000 ? formatInt(x) : String(x)} ${name}`;
    }
  }
  return formatInt(n);
}

/** Two significant digits, trailing zeros trimmed: 0.7179 → "0.72", 1.1605 → "1.2". */
export function sig2(n: number): string {
  return Number.isFinite(n) ? String(Number(n.toPrecision(2))) : '∞';
}

/** Three significant digits, trailing zeros trimmed: 1.1605 → "1.16". */
export function sig3(n: number): string {
  return Number.isFinite(n) ? String(Number(n.toPrecision(3))) : '∞';
}

/**
 * Bounding-sphere diameter of a nebula in ly (2 · worldRadius), rounded for prose.
 * Falls back to `fallbackRadius` if the id is missing.
 */
export function spanLy(id: string, fallbackRadius = 45): number {
  const r = NEBULA_BY_ID[id]?.worldRadius;
  return roundNice(2 * (r !== undefined && Number.isFinite(r) && r > 0 ? r : fallbackRadius));
}

/**
 * Light-years per LOCAL fractal unit (types.ts: scale = worldRadius / fractal.boundRadius), read
 * from the live catalog and fractal registry so sizes track retuning. `fallback` if unavailable.
 */
export function lyPerLocal(id: string, fallback: number): number {
  const n = NEBULA_BY_ID[id];
  const b = n ? getFractal(n.fractal)?.boundRadius : undefined;
  if (!n || b === undefined || !(b > 0) || !(n.worldRadius > 0)) return fallback;
  const k = n.worldRadius / b;
  return Number.isFinite(k) ? k : fallback;
}

/** How many Pillars of Creation (≈ 4 ly) fit end to end along `ly`. */
export function pillars(ly: number): number {
  return Math.max(1, Math.round(ly / PILLAR_OF_CREATION_LY));
}

/** Black-hole parameters from the catalog, with sane fallbacks. */
export function blackHoleOf(
  id: string,
  fallbackRs: number,
  fallbackSpin: number,
  fallbackDiskInner: number,
): Pick<BlackHoleParams, 'rs' | 'spin' | 'diskInner'> {
  const bh = NEBULA_BY_ID[id]?.blackHole;
  const rs = bh && Number.isFinite(bh.rs) && bh.rs > 0 ? bh.rs : fallbackRs;
  const spin = bh && Number.isFinite(bh.spin) ? Math.min(Math.max(bh.spin, 0), 0.999) : fallbackSpin;
  const diskInner = bh && Number.isFinite(bh.diskInner) && bh.diskInner > 0 ? bh.diskInner : fallbackDiskInner;
  return { rs, spin, diskInner };
}

/** Mass (in Suns) of a black hole whose Schwarzschild radius is `rsLy` light-years. */
export function solarMassesForRs(rsLy: number): number {
  return (rsLy * KM_PER_LY) / SUN_SCHWARZSCHILD_KM;
}

/** Outer (event) horizon of a Kerr black hole with dimensionless spin χ, in units of rₛ. */
export function kerrHorizonRs(chi: number): number {
  const c = Math.min(Math.abs(chi), 1);
  return 0.5 * (1 + Math.sqrt(1 - c * c));
}

/**
 * Innermost stable circular orbit (Bardeen, Press & Teukolsky 1972) for spin χ, in units of rₛ.
 * χ = 0 → 3 rₛ; prograde χ → 1 → 0.5 rₛ; retrograde χ → 1 → 4.5 rₛ.
 */
export function kerrIscoRs(chi: number, prograde = true): number {
  const a = Math.min(Math.abs(chi), 1);
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  const root = Math.sqrt(Math.max(0, (3 - z1) * (3 + z1 + 2 * z2)));
  const rM = 3 + z2 + (prograde ? -root : root); // in units of GM/c²
  return rM / 2;
}

/**
 * Radiative efficiency of a thin accretion disk ending at the prograde ISCO: the fraction of
 * infalling rest mass radiated, 1 − E_isco with E_isco = √(1 − 2M/(3 r_isco)).
 * χ = 0 → ≈ 5.7 %; χ = 0.9 → ≈ 15.6 %; χ → 1 → ≈ 42.3 %.
 */
export function kerrEfficiency(chi: number): number {
  const rM = 2 * kerrIscoRs(chi, true); // in units of GM/c²
  return 1 - Math.sqrt(Math.max(0, 1 - 2 / (3 * rM)));
}

/** Whether c = a + bi lies in the Mandelbrot set (the orbit of 0 stays within |z| ≤ 2 for `maxIter` steps). */
export function inMandelbrot(a: number, b: number, maxIter = 4000): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  let x = 0;
  let y = 0;
  for (let i = 0; i < maxIter; i++) {
    const nx = x * x - y * y + a;
    y = 2 * x * y + b;
    x = nx;
    if (x * x + y * y > 4) return false;
  }
  return true;
}

/** Hawking temperature (K) of a black hole of `solarMasses` Suns. */
export function hawkingTemperatureK(solarMasses: number): number {
  return HAWKING_T_SUN_K / Math.max(solarMasses, 1e-30);
}

/** Order of magnitude (log₁₀ years) of the Hawking evaporation time. */
export function evaporationLog10Years(solarMasses: number): number {
  return Math.round(Math.log10(EVAPORATION_YEARS_SUN) + 3 * Math.log10(Math.max(solarMasses, 1e-30)));
}

/** Integer → Unicode superscript digits ("107" → "¹⁰⁷"). */
export function superscript(n: number): string {
  const map: Record<string, string> = {
    '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  };
  return String(Math.round(n))
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('');
}

/** Light speed multiple of 1 ly/s (≈ 31.6 million). */
export const C_MULTIPLE_PER_LY_S = 1 / C_LY_PER_S;
/** Miles per hour of 1 ly/s (≈ 2.1 × 10¹⁶). */
export const MPH_PER_LY_S = KM_PER_LY * MPH_PER_KM_S;

/** Diameter range (ly, rounded) over all non-black-hole nebulae in the catalog. */
export function nebulaDiameterRange(): { min: number; max: number } {
  let min = Infinity;
  let max = 0;
  for (const n of NEBULAE) {
    if (n.fractal === 'blackhole') continue;
    const d = 2 * n.worldRadius;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  if (!Number.isFinite(min)) return { min: 80, max: 120 };
  return { min: roundNice(min), max: roundNice(max) };
}

/** Largest centre-to-centre distance between any two catalog nebulae (ly, rounded to 100). */
export function voyageExtentLy(): number {
  let best = 0;
  for (let i = 0; i < NEBULAE.length; i++) {
    const a = NEBULAE[i].position;
    for (let j = i + 1; j < NEBULAE.length; j++) {
      const b = NEBULAE[j].position;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d > best) best = d;
    }
  }
  return best > 0 ? Math.round(best / 100) * 100 : 2000;
}
