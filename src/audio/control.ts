/**
 * Control-rate parameter steering.
 *
 * Continuous controls (filters that follow tidal stress, hum level, riser partials …) are
 * updated ~30 times a second. Instead of stacking a `setTargetAtTime` per update, a Glide
 * schedules short piecewise-linear ramps that trail the target by `lag` seconds:
 *  - a dead-band skips updates that would not be audible, so idle frames schedule nothing;
 *  - ramp end times are kept strictly increasing, so a long ramp followed by a short one
 *    never inserts an event before one still in flight;
 *  - after a pause in updates (hidden tab, idle dead-band) the ramp is re-anchored at the
 *    last value first, so the parameter never jumps back to a stale automation point.
 * This is sample-accurate, glitch-free and behaves identically across Web Audio engines.
 */

/** The subset of Tone.Param / Tone.Signal / AudioParam a Glide drives. */
export interface RampTarget {
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

export class Glide {
  private value: number;
  private end = -1;

  /**
   * @param eps dead-band: absolute, or relative to the current value when `relative`
   *            (use relative for frequencies, absolute for gains / cents).
   */
  constructor(
    private readonly param: RampTarget,
    initial: number,
    private readonly eps: number,
    private readonly relative = false,
  ) {
    this.value = initial;
  }

  /** Last value sent (what the parameter settles at once the current ramp ends). */
  get current(): number {
    return this.value;
  }

  /** Ramps toward `target`, arriving `lag` seconds after `now` (or right after the ramp in flight). */
  to(target: number, now: number, lag: number): void {
    if (!Number.isFinite(target) || !Number.isFinite(now)) return;
    const threshold = this.relative ? this.eps * Math.abs(this.value) : this.eps;
    if (Math.abs(target - this.value) <= threshold) return;
    if (now >= this.end) this.param.setValueAtTime(this.value, now);
    const end = Math.max(now + Math.max(0.005, lag), this.end + 0.002);
    this.param.linearRampToValueAtTime(target, end);
    this.value = target;
    this.end = end;
  }

  /** Jumps to `value` at `time`, discarding any ramp still in flight. */
  jump(value: number, time: number): void {
    if (!Number.isFinite(value) || !Number.isFinite(time)) return;
    this.param.cancelScheduledValues(time);
    this.param.setValueAtTime(value, time);
    this.value = value;
    this.end = time;
  }
}
