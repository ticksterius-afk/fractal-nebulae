/**
 * Procedural stereo impulse response for the shared "space" reverb.
 *
 * Tone.Reverb renders plain white noise under Tone's exponential approach (its "decay 12"
 * is really an RT60 of ~3 s, and the tail stays bright and hissy). Here the tail is
 * decorrelated noise through a gentle low-pass whose cutoff falls over time, so highs die
 * much sooner than lows — the dark, blooming decay of a huge hall — plus a soft onset and a
 * short pre-delay. Generated synchronously in ~10 ms; the ConvolverNode's own
 * normalisation calibrates loudness.
 */

export interface ReverbShape {
  /** Low-frequency RT60 (s). */
  rt60: number;
  /** IR length (s); ≈ rt60 gives a −60 dB tail. */
  length: number;
  preDelay: number;
  /** Onset bloom time constant (s). */
  bloom: number;
  /** Damping cutoff at the start and at the end of the tail (Hz). */
  brightStart: number;
  brightEnd: number;
}

export const SPACE_REVERB: ReverbShape = {
  rt60: 9,
  length: 9.5,
  preDelay: 0.025,
  bloom: 0.06,
  brightStart: 11000,
  brightEnd: 700,
};

export function createImpulseResponse(
  createBuffer: (channels: number, length: number, sampleRate: number) => AudioBuffer,
  sampleRate: number,
  shape: ReverbShape = SPACE_REVERB,
): AudioBuffer {
  const sr = Math.max(8000, sampleRate || 48000);
  const pre = Math.floor(shape.preDelay * sr);
  const len = pre + Math.floor(shape.length * sr);
  const buffer = createBuffer(2, len, sr);
  const decayPerSample = Math.exp(-6.907755 / (shape.rt60 * sr)); // −60 dB after rt60
  const bloomPerSample = Math.exp(-1 / (shape.bloom * sr));
  const fcRatio = Math.pow(shape.brightEnd / shape.brightStart, 1 / (len - pre));
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    // xorshift32 noise, inlined (a closure per sample costs more than the filtering)
    let seed = (0x1234567 + ch * 0x7654321) >>> 0 || 0x9e3779b9;
    let env = 1;
    let bloom = 1;
    let fc = shape.brightStart;
    let lp = 0;
    let lp2 = 0;
    let a = 0;
    for (let i = 0; i < pre; i++) data[i] = 0;
    for (let i = pre; i < len; i++) {
      // Two cascaded one-poles (12 dB/oct) for a smooth, woolly high-frequency decay. The cutoff
      // moves < 0.02 % per 32 samples, so its coefficient is refreshed per block (this runs
      // inside the launch click; per-sample exp() cost ~30 ms).
      if (((i - pre) & 31) === 0) a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      lp += a * (seed / 2147483648 - 1 - lp);
      lp2 += a * (lp - lp2);
      data[i] = lp2 * env * (1 - bloom);
      env *= decayPerSample;
      bloom *= bloomPerSample;
      fc *= fcRatio;
    }
    // Fade the last 150 ms so the tail never ends in a click.
    const fade = Math.min(len - pre, Math.floor(0.15 * sr));
    for (let i = 0; i < fade; i++) data[len - 1 - i] *= i / fade;
  }
  return buffer;
}
