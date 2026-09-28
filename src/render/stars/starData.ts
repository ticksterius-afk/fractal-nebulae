/**
 * Deterministic CPU generation of star catalogues (directions/positions, colours, fluxes).
 */
import { GALACTIC_NORTH } from '../sky/skyParams';

/** Small, fast, seedable PRNG (mulberry32): uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Mirror of COMMON_GLSL blackbody(): linear RGB for a temperature (K), then normalized to
 * luminance 1 with a saturation factor (1 = physical tint). Writes into out[offset..+2].
 */
export function starColour(tempK: number, saturation: number, out: Float32Array, offset: number): void {
  const t = Math.min(Math.max(tempK, 1000), 40000) / 100;
  const r = t <= 66 ? 1 : clamp01(1.29293618606 * Math.pow(t - 60, -0.1332047592));
  const g = t <= 66
    ? clamp01(0.39008157876 * Math.log(t) - 0.63184144378)
    : clamp01(1.12989086089 * Math.pow(t - 60, -0.0755148492));
  const b = t >= 66 ? 1 : t <= 19 ? 0 : clamp01(0.54320678911 * Math.log(t - 10) - 1.19625408914);
  let lr = Math.pow(r, 2.2);
  let lg = Math.pow(g, 2.2);
  let lb = Math.pow(b, 2.2);
  const l = Math.max(0.2126 * lr + 0.7152 * lg + 0.0722 * lb, 1e-3);
  lr /= l;
  lg /= l;
  lb /= l;
  out[offset] = Math.max(0, lerp(1, lr, saturation));
  out[offset + 1] = Math.max(0, lerp(1, lg, saturation));
  out[offset + 2] = Math.max(0, lerp(1, lb, saturation));
}

/**
 * Stellar temperature for a star of relative brightness b01 (0 = faintest, 1 = brightest):
 * mostly K/G/F with some M; luminous stars are more often hot blue giants or red giants.
 */
export function sampleTemperature(rng: () => number, b01: number): number {
  const u = rng();
  const hot = 0.05 + 0.22 * b01;
  const red = 0.1 + 0.1 * b01;
  if (u < hot * 0.35) return lerp(10500, 28000, Math.pow(rng(), 1.5)); // B / O
  if (u < hot) return lerp(7200, 10500, rng()); // A
  if (u < hot + red) return lerp(2800, 3900, rng()); // M, K giants
  if (u < hot + red + 0.45) return lerp(3900, 5300, rng()); // K
  return lerp(5300, 7200, rng()); // G / F
}

// ---------------------------------------------------------------------------------------------
// Far stars (celestial sphere)
// ---------------------------------------------------------------------------------------------

/** Faint/bright magnitude limits, slope of the counts and the flux at the faint limit. */
const M_FAINT = 6.5;
const M_BRIGHT = -1.5;
const COUNT_SLOPE = 0.35; // N(<m) ∝ 10^(0.35 m)
const FLUX_FAINT = 0.3; // reference px² at M_FAINT
const FLUX_GAMMA = 0.8; // dynamic-range compression (a tone curve for the catalogue)
/** Fraction of the brightest stars that get diffraction spikes. */
const SPIKED_FRACTION = 0.04;

export interface FarStarData {
  count: number;
  /** Unit rest-frame directions (xyz). */
  dir: Float32Array;
  /** Colours normalized to luminance ≈ 1 (rgb). */
  colour: Float32Array;
  /** flux (ref px²), spike amount 0..1, spike length (ref px). */
  star: Float32Array;
}

export function generateFarStars(count: number, seed = 0x5eed): FarStarData {
  const rng = mulberry32(seed);
  const n = GALACTIC_NORTH;
  const dir = new Float32Array(count * 3);
  const colour = new Float32Array(count * 3);
  const star = new Float32Array(count * 3);
  const mags = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // uniform on the sphere, thinned away from the galactic plane (≈3× denser in the band)
    let x = 0, y = 0, z = 1;
    for (let tries = 0; tries < 32; tries++) {
      z = rng() * 2 - 1;
      const phi = rng() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      x = s * Math.cos(phi);
      y = s * Math.sin(phi);
      const b = Math.abs(x * n[0] + y * n[1] + z * n[2]);
      if (rng() < 0.33 + 0.67 * Math.exp(-b / 0.3)) break;
    }
    dir[i * 3] = x;
    dir[i * 3 + 1] = y;
    dir[i * 3 + 2] = z;
    const m = Math.max(M_BRIGHT, M_FAINT + Math.log10(Math.max(rng(), 1e-9)) / COUNT_SLOPE);
    mags[i] = m;
    star[i * 3] = FLUX_FAINT * Math.pow(10, 0.4 * FLUX_GAMMA * (M_FAINT - m));
    const b01 = (M_FAINT - m) / (M_FAINT - M_BRIGHT);
    starColour(sampleTemperature(rng, b01), 1.1, colour, i * 3);
  }

  // Spikes for the brightest SPIKED_FRACTION, fading in so there is no visible threshold.
  const sorted = Array.from(mags).sort((a, b) => a - b);
  const mSpike = sorted[Math.min(count - 1, Math.floor(count * SPIKED_FRACTION))] ?? M_BRIGHT;
  const fSpike = FLUX_FAINT * Math.pow(10, 0.4 * FLUX_GAMMA * (M_FAINT - mSpike));
  for (let i = 0; i < count; i++) {
    const flux = star[i * 3];
    star[i * 3 + 1] = smoothstep(fSpike * 0.9, fSpike * 2.5, flux);
    star[i * 3 + 2] = 10 + 14 * Math.sqrt(flux / fSpike);
  }
  return { count, dir, colour, star };
}

// ---------------------------------------------------------------------------------------------
// Local stars (camera-wrapped box) and dust motes
// ---------------------------------------------------------------------------------------------

export interface FieldData {
  count: number;
  /** Positions in the unit box [0,1)³. */
  pos: Float32Array;
  colour: Float32Array;
  /** Intrinsic brightness (flux in ref px² at the reference distance). */
  lum: Float32Array;
}

/** Near stars: luminosity power law (few luminous giants), colours by luminosity. */
export function generateNearStars(count: number, seed = 0x10ca1): FieldData {
  const rng = mulberry32(seed);
  const pos = new Float32Array(count * 3);
  const colour = new Float32Array(count * 3);
  const lum = new Float32Array(count);
  const LUM0 = 20;
  const LUM_MAX = 400;
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rng();
    pos[i * 3 + 1] = rng();
    pos[i * 3 + 2] = rng();
    const L = Math.min(LUM_MAX, LUM0 * Math.pow(Math.max(rng(), 1e-9), -1 / 1.5));
    lum[i] = L;
    const b01 = Math.log(L / LUM0) / Math.log(LUM_MAX / LUM0);
    starColour(sampleTemperature(rng, b01), 1.1, colour, i * 3);
  }
  return { count, pos, colour, lum };
}

/** Dust motes: near-uniform brightness, tiny colour variation around white. */
export function generateDust(count: number, seed = 0xd057): FieldData {
  const rng = mulberry32(seed);
  const pos = new Float32Array(count * 3);
  const colour = new Float32Array(count * 3);
  const lum = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rng();
    pos[i * 3 + 1] = rng();
    pos[i * 3 + 2] = rng();
    const warm = rng() * 2 - 1;
    colour[i * 3] = 1 + 0.12 * warm;
    colour[i * 3 + 1] = 1;
    colour[i * 3 + 2] = 1 - 0.12 * warm;
    lum[i] = 0.4 + 1.2 * rng() * rng();
  }
  return { count, pos, colour, lum };
}
