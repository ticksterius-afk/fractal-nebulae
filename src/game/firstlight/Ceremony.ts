/**
 * First Light — the ignition ceremony (design/20-first-light.md §1 "the ignition of each seed is a
 * small ceremony", design/60-first-light-build.md §M "Win").
 *
 * A 3 s timeline the mode samples every frame: the lit seeds swell and settle, the accent lights ramp
 * up (and stay brighter behind the solved card), the beam flares once, a resonance pulse rolls out of
 * the last seed shortly after the start, and the card appears at the end. Pure numbers, no DOM.
 */

export const CEREMONY = {
  /** Total length (s); the solved card opens at the end. */
  duration: 3,
  /** When the pulse leaves the last seed (s). */
  pulseAt: 0.15,
  /** Accent light gain: ramps 1 → peak over rampS, settles to `after` by the end. */
  accentPeak: 2.6,
  accentAfter: 1.7,
  rampS: 1.2,
  /** Seed swell: peak scale at peakS, settling to `after`. */
  swellPeak: 1.9,
  swellAfter: 1.25,
  peakS: 0.55,
  /** Beam flare. */
  beamPeak: 1.8,
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

export class Ceremony {
  /** Seconds since the start; < 0 = not running. */
  private t = -1;
  private pulsed = false;
  /** Solved and settled (the card is up): the "after" values hold. */
  private settled = false;

  get running(): boolean {
    return this.t >= 0 && !this.settled;
  }

  start(): void {
    this.t = 0;
    this.pulsed = false;
    this.settled = false;
  }

  /** Back to the unlit look (new level, replay, an edit after solving). */
  reset(): void {
    this.t = -1;
    this.pulsed = false;
    this.settled = false;
  }

  /**
   * Advance; returns 'pulse' once at pulseAt, 'done' once at the end, else null.
   */
  update(dt: number): 'pulse' | 'done' | null {
    if (this.t < 0 || this.settled) return null;
    this.t += Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (!this.pulsed && this.t >= CEREMONY.pulseAt) {
      this.pulsed = true;
      return 'pulse';
    }
    if (this.t >= CEREMONY.duration) {
      this.settled = true;
      return 'done';
    }
    return null;
  }

  /** Accent-light gain for lit seeds and the endpoint (1 = the playing look). */
  get accentGain(): number {
    if (this.t < 0) return 1;
    if (this.settled) return CEREMONY.accentAfter;
    const C = CEREMONY;
    const up = smooth(0, C.rampS, this.t);
    const down = smooth(C.rampS, C.duration, this.t);
    return 1 + (C.accentPeak - 1) * up - (C.accentPeak - C.accentAfter) * down;
  }

  /** Scale of lit seed glyphs / stars. */
  get swell(): number {
    if (this.t < 0) return 1;
    if (this.settled) return CEREMONY.swellAfter;
    const C = CEREMONY;
    const up = smooth(0, C.peakS, this.t);
    const down = smooth(C.peakS, C.duration * 0.8, this.t);
    return 1 + (C.swellPeak - 1) * up - (C.swellPeak - C.swellAfter) * down;
  }

  /** Beam brightness multiplier (one flare, back to 1.15 when settled). */
  get beamGain(): number {
    if (this.t < 0) return 1;
    if (this.settled) return 1.15;
    const C = CEREMONY;
    const up = smooth(0, 0.35, this.t);
    const down = smooth(0.35, 1.8, this.t);
    return 1 + (C.beamPeak - 1) * up - (C.beamPeak - 1.15) * down;
  }
}
