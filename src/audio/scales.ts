/**
 * Pitch helpers: modes, scale-degree ↔ MIDI mapping and 12-bit pitch-class masks
 * (bit n set = pitch class n, C = 0) used for fast, allocation-free consonance checks.
 */

export const MODES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  lydianAugmented: [0, 2, 4, 6, 8, 9, 11],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
} as const satisfies Record<string, readonly number[]>;

export const mtof = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);
export const pc = (midi: number): number => ((Math.round(midi) % 12) + 12) % 12;
export const pcBit = (midi: number): number => 1 << pc(midi);
export const hasPc = (mask: number, midi: number): boolean => (mask & pcBit(midi)) !== 0;

/** True when `midi` is not a chord tone but sits a semitone from one (a harsh minor-second rub). */
export function rubs(mask: number, midi: number): boolean {
  if (hasPc(mask, midi)) return false;
  return hasPc(mask, midi + 1) || hasPc(mask, midi - 1);
}

/**
 * Pitch classes of `mask` that sit comfortably over `against`: shared tones, plus tones with
 * no semitone neighbour in `against`. Used to keep one-shots consonant during a crossfade,
 * when two keys sound at once.
 */
export function consonantSubset(mask: number, against: number): number {
  let out = 0;
  for (let p = 0; p < 12; p++) {
    const bit = 1 << p;
    if ((mask & bit) === 0) continue;
    const near = (1 << ((p + 1) % 12)) | (1 << ((p + 11) % 12));
    if ((against & bit) !== 0 || (against & near) === 0) out |= bit;
  }
  return out;
}

/** Smallest pitch-class distance (0..6) between two MIDI notes. */
export function pcDistance(a: number, b: number): number {
  const d = Math.abs(pc(a) - pc(b));
  return d > 6 ? 12 - d : d;
}

/** Writes the chord tones of `mask` inside [lo, hi] into `out` (ascending); returns the count. */
export function tonesInRange(mask: number, lo: number, hi: number, out: Int16Array): number {
  let n = 0;
  if (mask === 0) return 0;
  for (let m = Math.ceil(lo); m <= hi && n < out.length; m++) {
    if (hasPc(mask, m)) out[n++] = m;
  }
  return n;
}

/** Lowest MIDI note ≥ lo with the pitch class of `pitchClass` (0..11). */
export function lowestWithPc(pitchClass: number, lo: number): number {
  const base = Math.ceil(lo);
  return base + ((((pitchClass - base) % 12) + 12) % 12);
}

/** Nearest chord tone to `midi` (searches outward; returns midi itself if the mask is empty). */
export function snapToChord(mask: number, midi: number): number {
  if (mask === 0) return midi;
  for (let d = 0; d <= 6; d++) {
    if (hasPc(mask, midi + d)) return midi + d;
    if (hasPc(mask, midi - d)) return midi - d;
  }
  return midi;
}

/** Folds `midi` by octaves into [lo, hi] (assumes hi − lo ≥ 12). */
export function foldInto(midi: number, lo: number, hi: number): number {
  let m = midi;
  while (m < lo) m += 12;
  while (m > hi) m -= 12;
  return m < lo ? m + 12 : m;
}

export class Scale {
  readonly size: number;
  /** Pitch-class mask of the whole scale. */
  readonly mask: number;

  constructor(
    /** MIDI note of degree 0. */
    readonly root: number,
    readonly steps: readonly number[],
  ) {
    this.size = steps.length;
    let m = 0;
    for (const s of steps) m |= 1 << pc(root + s);
    this.mask = m;
  }

  /** MIDI note of an integer scale degree; degrees wrap into octaves in both directions. */
  midi(degree: number): number {
    const d = Math.round(degree);
    const oct = Math.floor(d / this.size);
    return this.root + 12 * oct + this.steps[d - oct * this.size];
  }

  /** Degree whose pitch is nearest to `midi` (ties resolve downward). */
  degreeNear(midi: number): number {
    const approx = Math.floor(((midi - this.root) / 12) * this.size);
    let best = approx;
    let bestErr = Infinity;
    for (let d = approx - 2; d <= approx + 3; d++) {
      const e = Math.abs(this.midi(d) - midi);
      if (e < bestErr) {
        bestErr = e;
        best = d;
      }
    }
    return best;
  }

  contains(midi: number): boolean {
    return hasPc(this.mask, midi);
  }
}
