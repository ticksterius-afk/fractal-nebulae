/**
 * Units & formatting. World unit = 1 light-year (ly); simulation speeds are ly/s.
 */
export const KM_PER_LY = 9.4607304725808e12;
export const KM_PER_AU = 1.495978707e8;
export const AU_PER_LY = KM_PER_LY / KM_PER_AU; // ≈ 63241
export const C_KM_S = 299792.458;
export const SECONDS_PER_YEAR = 31557600; // Julian year
export const C_LY_PER_S = 1 / SECONDS_PER_YEAR; // light speed in ly/s
export const MPH_PER_KM_S = 2236.9362920544;

const SUP: Record<string, string> = {
  '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
};

/** 1234567 → "1.23 × 10⁶"; small magnitudes print plainly. */
export function sci(value: number, digits = 3): string {
  if (!isFinite(value)) return '∞';
  const a = Math.abs(value);
  if (a === 0) return '0';
  if (a >= 0.01 && a < 1e5) {
    const decimals = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 1 : 2;
    return value.toFixed(decimals);
  }
  const exp = Math.floor(Math.log10(a));
  const mant = value / Math.pow(10, exp);
  const e = String(exp).split('').map((ch) => SUP[ch] ?? ch).join('');
  return `${mant.toFixed(Math.max(0, digits - 1))} × 10${e}`;
}

export interface SpeedReadout {
  /** Best human unit for the headline number. */
  primaryValue: string;
  primaryUnit: string;
  /** Multiples of light speed, e.g. "1.58 × 10⁵ c" */
  c: string;
  lyPerS: string;
  auPerS: string;
  kmPerS: string;
  mph: string;
}

export function formatSpeed(lyPerS: number): SpeedReadout {
  const kms = lyPerS * KM_PER_LY;
  const aus = lyPerS * AU_PER_LY;
  const cMult = lyPerS / C_LY_PER_S;
  let primaryValue: string;
  let primaryUnit: string;
  if (lyPerS >= 0.1) {
    primaryValue = sci(lyPerS);
    primaryUnit = 'ly/s';
  } else if (aus >= 1) {
    primaryValue = sci(aus);
    primaryUnit = 'AU/s';
  } else {
    primaryValue = sci(kms);
    primaryUnit = 'km/s';
  }
  return {
    primaryValue,
    primaryUnit,
    c: `${sci(cMult)} c`,
    lyPerS: `${sci(lyPerS)} ly/s`,
    auPerS: `${sci(aus)} AU/s`,
    kmPerS: `${sci(kms)} km/s`,
    mph: `${sci(kms * MPH_PER_KM_S)} mph`,
  };
}

/** Distance in ly → best unit string ("312 ly", "4,210 AU", "2.1 × 10⁶ km"). */
export function formatDistance(ly: number): string {
  if (!isFinite(ly)) return '∞';
  if (ly >= 0.05) return `${sci(ly)} ly`;
  const au = ly * AU_PER_LY;
  if (au >= 0.5) return `${sci(au)} AU`;
  return `${sci(ly * KM_PER_LY)} km`;
}

/** Seconds → "12 s", "3 min 20 s", "2 h 5 min". */
export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min ${Math.floor(seconds % 60)} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** Years → "312 years", "4.2 × 10³ years", "37 days". */
export function formatYears(years: number): string {
  if (years < 1 / 12) return `${(years * 365.25).toFixed(1)} days`;
  if (years < 1) return `${(years * 12).toFixed(1)} months`;
  return `${sci(years)} years`;
}
