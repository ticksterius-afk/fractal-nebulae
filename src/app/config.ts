import type { AppSettings, QualityName, QualityPreset } from '../core/types';

export const QUALITY_PRESETS: Record<QualityName, QualityPreset> = {
  low: {
    name: 'low',
    renderScaleMin: 0.3,
    renderScaleMax: 0.6,
    targetFrameMs: 16.7,
    marchSteps: 90,
    iterScale: 0.7,
    shadows: false,
    aoSamples: 0,
    skyCubeSize: 1024,
    farStarCount: 1200,
    localStarCount: 2500,
    dustCount: 1200,
    bloom: true,
  },
  medium: {
    name: 'medium',
    renderScaleMin: 0.4,
    renderScaleMax: 0.75,
    targetFrameMs: 16.7,
    marchSteps: 130,
    iterScale: 0.85,
    shadows: false,
    aoSamples: 3,
    skyCubeSize: 1536,
    farStarCount: 2000,
    localStarCount: 4000,
    dustCount: 2000,
    bloom: true,
  },
  high: {
    name: 'high',
    renderScaleMin: 0.5,
    renderScaleMax: 0.9,
    targetFrameMs: 16.7,
    marchSteps: 170,
    iterScale: 1.0,
    shadows: true,
    aoSamples: 4,
    skyCubeSize: 2048,
    farStarCount: 2800,
    localStarCount: 6000,
    dustCount: 3000,
    bloom: true,
  },
  ultra: {
    name: 'ultra',
    renderScaleMin: 0.65,
    renderScaleMax: 1.0,
    targetFrameMs: 16.7,
    marchSteps: 240,
    iterScale: 1.25,
    shadows: true,
    aoSamples: 5,
    skyCubeSize: 2048,
    farStarCount: 3600,
    localStarCount: 8000,
    dustCount: 4000,
    bloom: true,
  },
};

export const DEFAULT_SETTINGS: AppSettings = {
  quality: 'high',
  musicVolume: 0.8,
  sfxVolume: 0.7,
  mouseSensitivity: 1,
  invertY: false,
  fovDeg: 70,
  showHints: true,
  fullscreen: true,
};

const SETTINGS_KEY = 'fractal-nebulae.settings.v1';

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return sanitizeSettings(JSON.parse(raw));
  } catch {
    /* storage unavailable / corrupt JSON */
  }
  return { ...DEFAULT_SETTINGS };
}

/**
 * Stored settings are untrusted (older versions, manual edits): every field falls back to its
 * default unless it has the right type and range. An unknown quality name would otherwise hand
 * the renderer an undefined preset and the app would not start at all.
 */
export function sanitizeSettings(v: unknown): AppSettings {
  const d = DEFAULT_SETTINGS;
  if (typeof v !== 'object' || v === null) return { ...d };
  const o = v as Record<string, unknown>;
  const num = (x: unknown, min: number, max: number, def: number): number =>
    typeof x === 'number' && Number.isFinite(x) ? Math.min(Math.max(x, min), max) : def;
  const bool = (x: unknown, def: boolean): boolean => (typeof x === 'boolean' ? x : def);
  const quality =
    typeof o.quality === 'string' && Object.prototype.hasOwnProperty.call(QUALITY_PRESETS, o.quality)
      ? (o.quality as QualityName)
      : d.quality;
  return {
    quality,
    musicVolume: num(o.musicVolume, 0, 1, d.musicVolume),
    sfxVolume: num(o.sfxVolume, 0, 1, d.sfxVolume),
    mouseSensitivity: num(o.mouseSensitivity, 0.2, 3, d.mouseSensitivity),
    invertY: bool(o.invertY, d.invertY),
    fovDeg: num(o.fovDeg, 60, 100, d.fovDeg),
    showHints: bool(o.showHints, d.showHints),
    fullscreen: bool(o.fullscreen, d.fullscreen),
  };
}

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

/** Global tuning constants shared across modules. */
export const TUNING = {
  /** Logarithmic depth: near plane (ly) and far plane (ly). */
  depthNear: 1e-7,
  depthFar: 2e5,
  /** Ship starts here (world ly) looking toward -Z. */
  startPosition: [0, 18, 140] as [number, number, number],
  /** Fraction of surface distance travelled per second at throttle 1 (DE-adaptive cruise). */
  cruiseFactor: 0.6,
  /** Hyper acceleration: max multiplier on top of cruise, ramp time (s). */
  hyperMaxMultiplier: 40,
  hyperRampSeconds: 1.6,
  /** Pulse (Space tap). */
  pulseDuration: 4.5,
  pulseRevealSeconds: 10,
  /** Holding Space longer than this (s) engages autopilot instead of pulse. */
  spaceHoldSeconds: 0.35,
  /** Wormhole transit duration (s). */
  wormholeSeconds: 5,
};
