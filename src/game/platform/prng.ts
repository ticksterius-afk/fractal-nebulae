/**
 * Deterministic randomness for generation and simulation (design/10-platform.md §0: "mulberry32
 * everywhere; never Math.random()"). Pure functions: identical results in Node and every browser.
 *
 *   const rng = mulberry32(fnv1a('2026-10-02:firstlight'));
 *   const arena = pick(rng, pool);
 *
 * Hash inputs are 32-bit integers: quantise floats yourself before hashing (e.g. Math.round(x * 1e5))
 * so a cross-browser last-bit difference cannot flip an outcome.
 */

/** A seeded generator: uniform floats in [0, 1). */
export type Rng = () => number;

/**
 * mulberry32 (Tommy Ettinger): 32-bit state, period 2³², fast and well distributed for game use.
 * Non-finite seeds count as 0; floats are truncated to their uint32 bits.
 */
export function mulberry32(seed: number): Rng {
  let a = Number.isFinite(seed) ? seed >>> 0 : 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard 32-bit FNV-1a over the string's UTF-8 bytes (lone surrogates encode as U+FFFD, like
 * TextEncoder). Returns an unsigned 32-bit integer: fnv1a('') = 0x811c9dc5, fnv1a('a') = 0xe40c292c.
 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  const n = str.length;
  for (let i = 0; i < n; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      h = Math.imul(h ^ c, 0x01000193);
      continue;
    }
    // Decode a code point (surrogate pairs), then feed its UTF-8 bytes.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else c = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x800) {
      h = Math.imul(h ^ (0xc0 | (c >> 6)), 0x01000193);
    } else if (c < 0x10000) {
      h = Math.imul(h ^ (0xe0 | (c >> 12)), 0x01000193);
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 0x3f)), 0x01000193);
    } else {
      h = Math.imul(h ^ (0xf0 | (c >> 18)), 0x01000193);
      h = Math.imul(h ^ (0x80 | ((c >> 12) & 0x3f)), 0x01000193);
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 0x3f)), 0x01000193);
    }
    h = Math.imul(h ^ (0x80 | (c & 0x3f)), 0x01000193);
  }
  return h >>> 0;
}

// MurmurHash3 (x86, 32-bit) block mix and finaliser: good avalanche for small integer tuples.
function mixIn(h: number, k: number): number {
  k = Math.imul(k | 0, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Order-sensitive hash of two 32-bit integers → uint32 (e.g. a grid cell). */
export function hash2(a: number, b: number, seed = 0): number {
  return fmix32(mixIn(mixIn(seed | 0, a), b) ^ 8);
}

/** Order-sensitive hash of three 32-bit integers → uint32 (e.g. a lattice point). */
export function hash3(a: number, b: number, c: number, seed = 0): number {
  return fmix32(mixIn(mixIn(mixIn(seed | 0, a), b), c) ^ 12);
}

/** A uint32 hash as a float in [0, 1). */
export function toUnit(h: number): number {
  return (h >>> 0) / 4294967296;
}

/** Uniform float in [lo, hi). */
export function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/** Uniform integer in [lo, hi] (both inclusive). */
export function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** One element, uniformly. Throws on an empty array (a generator bug, not a runtime condition). */
export function pick<T>(rng: Rng, arr: readonly T[]): T {
  if (arr.length === 0) throw new RangeError('pick: empty array');
  return arr[Math.floor(rng() * arr.length)];
}

/** In-place Fisher–Yates shuffle; returns `arr`. The same seed gives the same permutation. */
export function shuffle<T>(rng: Rng, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}
