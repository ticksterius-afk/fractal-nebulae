/** Small numeric / random helpers shared by the audio module (no allocations). */

export const TAU = Math.PI * 2;
export const PHI = (1 + Math.sqrt(5)) / 2;

export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** `x` if it is a finite number, otherwise `fallback` (NaN / ±Infinity guard). */
export const finite = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback);

/** Frame-rate independent smoothing factor for time constant `tau` seconds. */
export const damp = (dt: number, tau: number): number => 1 - Math.exp(-dt / Math.max(1e-4, tau));

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

/** Exponential interpolation (for frequencies): a·(b/a)^t, a,b > 0. */
export const expLerp = (a: number, b: number, t: number): number => a * Math.pow(b / a, t);

/** Equal-power fade curve: 0 → 0, 1 → 1, and sin²+cos² = 1 across a crossfade. */
export const eqPower = (x: number): number => Math.sin(clamp01(x) * Math.PI * 0.5);

export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
export const randInt = (a: number, b: number): number => a + Math.floor(Math.random() * (b - a + 1));
export const chance = (p: number): boolean => Math.random() < p;
export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
/** Log-uniform random value in [a, b] (a, b > 0) — natural for frequencies. */
export const randExp = (a: number, b: number): number => a * Math.pow(b / a, Math.random());
/** Velocity humanisation: ±`amount` relative jitter, clamped to a sane MIDI-like range. */
export const human = (v: number, amount = 0.1): number => clamp(v * (1 + (Math.random() * 2 - 1) * amount), 0.02, 1);

/** Number of set bits in a small non-negative integer. */
export function popcount(n: number): number {
  let c = 0;
  let x = n | 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}
