/**
 * Instrument presets and a small voice pool.
 *
 * Tone.PolySynth exposes no shared detune signal, so pitch bends (time dilation, wormhole
 * swirl) would step at control rate. Instead each layer owns a small pool of monophonic
 * voices whose `detune` inputs are all driven by the deck's detune Signal (audio-rate,
 * glitch-free), with oldest-voice stealing and strictly increasing start times per voice
 * (Tone asserts on non-monotonic restarts).
 */
import * as Tone from 'tone';
import type { VoiceKind } from './profiles';
import { mtof } from './scales';

export type PoolVoice = Tone.Synth | Tone.FMSynth | Tone.AMSynth | Tone.MembraneSynth;

export interface VoicePreset {
  create(): PoolVoice;
  /** Tail (s) after note-off during which the voice is still audible / busy. */
  release: number;
  /** Self-decaying (sustain 0): never sent a note-off; busy for `release` seconds after the attack. */
  percussive?: boolean;
  /** Loudness calibration multiplier applied to velocity so presets sit at similar levels. */
  cal: number;
}

const SINE = { type: 'sine' } as const;

/**
 * Tone's ModulationSynth (FMSynth / AMSynth) builds its carrier at −10 dB; AM additionally
 * averages the carrier's gain to ½. These output trims bring them back to unity so `cal`
 * means the same thing for every preset (peak ≈ velocity × cal).
 */
const FM_MAKEUP_DB = 10;
const AM_MAKEUP_DB = 16;

/**
 * Natural exponential tail (≈ −24 dB at half-time, 0 at the end). Tone's built-in
 * 'exponential' release approaches zero ~3× faster than its nominal time, which makes
 * bells sound choked; this curve lets them ring for the full release.
 */
const RING: number[] = Array.from({ length: 24 }, (_, i) => {
  const x = i / 23;
  return Math.exp(-4.2 * x) * (1 - x);
});

function pad(
  osc: { type: 'fatsawtooth' | 'fattriangle'; count: number; spread: number } | { type: 'fatcustom'; partials: number[]; count: number; spread: number },
  attack: number,
  decay: number,
  sustain: number,
  release: number,
): () => PoolVoice {
  return () =>
    new Tone.Synth({
      oscillator: osc,
      envelope: { attack, decay, sustain, release, attackCurve: 'sine', releaseCurve: 'linear' },
    });
}

interface FmShape {
  h: number;
  index: number;
  a: number;
  d: number;
  s: number;
  r: number;
  md: number;
  ms: number;
  mr: number;
}

function fm(p: FmShape): () => PoolVoice {
  return () =>
    new Tone.FMSynth({
      volume: FM_MAKEUP_DB,
      harmonicity: p.h,
      modulationIndex: p.index,
      oscillator: SINE,
      modulation: SINE,
      envelope: p.s > 0
        ? { attack: p.a, decay: p.d, sustain: p.s, release: p.r, releaseCurve: RING }
        : { attack: p.a, decay: p.d, sustain: 0, release: p.r },
      modulationEnvelope: { attack: Math.max(0.001, p.a * 0.5), decay: p.md, sustain: p.ms, release: p.mr },
    });
}

export const VOICES: Record<VoiceKind, VoicePreset> = {
  // ---- pads (slow, wide, warm) --------------------------------------------------------------
  warmPad: { create: pad({ type: 'fatsawtooth', count: 3, spread: 22 }, 3.5, 2.5, 0.75, 7), release: 7, cal: 0.5 },
  softPad: { create: pad({ type: 'fattriangle', count: 3, spread: 28 }, 4, 2, 0.8, 8), release: 8, cal: 0.8 },
  glassPad: {
    create: pad({ type: 'fatcustom', partials: [1, 0, 0.35, 0, 0.12, 0, 0.05], count: 2, spread: 14 }, 3, 2, 0.8, 7.5),
    release: 7.5,
    cal: 0.7,
  },
  choirPad: { create: pad({ type: 'fattriangle', count: 4, spread: 34 }, 3.2, 1.5, 0.85, 7), release: 7, cal: 0.7 },
  organPad: {
    create: pad({ type: 'fatcustom', partials: [1, 0.55, 0.3, 0.2, 0, 0.12, 0, 0.08], count: 2, spread: 6 }, 1.8, 1, 0.9, 5),
    release: 5,
    cal: 0.45,
  },
  darkPad: { create: pad({ type: 'fatsawtooth', count: 3, spread: 30 }, 5, 3, 0.7, 9), release: 9, cal: 0.5 },
  brassPad: { create: pad({ type: 'fatsawtooth', count: 2, spread: 12 }, 3, 2, 0.8, 6), release: 6, cal: 0.55 },
  // ---- bass / drone -------------------------------------------------------------------------
  sub: {
    create: () =>
      new Tone.Synth({
        oscillator: SINE,
        envelope: { attack: 3, decay: 1, sustain: 1, release: 6, attackCurve: 'sine', releaseCurve: 'linear' },
      }),
    release: 6,
    cal: 0.8,
  },
  bass: {
    create: () =>
      new Tone.Synth({
        oscillator: { type: 'triangle' },
        envelope: { attack: 2, decay: 1, sustain: 0.9, release: 5, attackCurve: 'sine', releaseCurve: 'linear' },
      }),
    release: 5,
    cal: 0.7,
  },
  // ---- melodic / percussive (FM) ------------------------------------------------------------
  marimba: { create: fm({ h: 4, index: 1.6, a: 0.003, d: 1.6, s: 0, r: 0.5, md: 0.18, ms: 0, mr: 0.2 }), release: 1.7, percussive: true, cal: 0.55 },
  glassPluck: { create: fm({ h: 3.01, index: 2.4, a: 0.002, d: 1.2, s: 0.14, r: 3.5, md: 0.9, ms: 0.05, mr: 3 }), release: 3.5, cal: 0.45 },
  bell: { create: fm({ h: 3.5, index: 2.2, a: 0.002, d: 1.6, s: 0.2, r: 5, md: 2.5, ms: 0.08, mr: 4 }), release: 5, cal: 0.4 },
  bellDeep: { create: fm({ h: 1.4, index: 3.2, a: 0.004, d: 2.5, s: 0.3, r: 7, md: 4, ms: 0.1, mr: 6 }), release: 7, cal: 0.45 },
  celesta: { create: fm({ h: 7, index: 1.3, a: 0.001, d: 0.8, s: 0.1, r: 3, md: 0.12, ms: 0, mr: 0.3 }), release: 3, cal: 0.45 },
  ePiano: { create: fm({ h: 1, index: 2.2, a: 0.004, d: 2.2, s: 0.18, r: 1.8, md: 1.0, ms: 0.15, mr: 1.5 }), release: 1.8, cal: 0.45 },
  harp: { create: fm({ h: 2, index: 1.4, a: 0.002, d: 1.4, s: 0.1, r: 3, md: 0.3, ms: 0, mr: 0.3 }), release: 3, cal: 0.5 },
  shimmer: {
    create: () =>
      new Tone.Synth({
        oscillator: SINE,
        envelope: { attack: 0.35, decay: 0.6, sustain: 0.5, release: 2.8, releaseCurve: 'linear' },
      }),
    release: 2.8,
    cal: 0.5,
  },
  flute: {
    create: () =>
      new Tone.AMSynth({
        volume: AM_MAKEUP_DB,
        harmonicity: 2,
        oscillator: SINE,
        modulation: SINE,
        envelope: { attack: 0.18, decay: 0.6, sustain: 0.6, release: 2.2, releaseCurve: 'linear' },
        modulationEnvelope: { attack: 0.5, decay: 0, sustain: 1, release: 0.5 },
      }),
    release: 2.2,
    cal: 0.5,
  },
  // ---- sound-effect voices -------------------------------------------------------------------
  bloom: { create: pad({ type: 'fattriangle', count: 3, spread: 20 }, 1.4, 0.8, 0.8, 2.6), release: 2.6, cal: 0.6 },
  glow: { create: pad({ type: 'fatsawtooth', count: 3, spread: 18 }, 1.0, 1.2, 0.7, 4), release: 4, cal: 0.4 },
  sonar: {
    create: () =>
      new Tone.MembraneSynth({
        pitchDecay: 0.5,
        octaves: 2,
        oscillator: SINE,
        envelope: { attack: 0.004, decay: 3.2, sustain: 0, release: 1 },
      }),
    release: 3.2,
    percussive: true,
    cal: 0.8,
  },
  heart: {
    create: () =>
      new Tone.MembraneSynth({
        pitchDecay: 0.07,
        octaves: 1.8,
        oscillator: SINE,
        envelope: { attack: 0.003, decay: 0.45, sustain: 0, release: 0.3, attackCurve: 'exponential' },
      }),
    release: 0.5,
    percussive: true,
    cal: 0.85,
  },
  membrane: {
    create: () =>
      new Tone.MembraneSynth({
        pitchDecay: 0.09,
        octaves: 2.2,
        oscillator: SINE,
        envelope: { attack: 0.003, decay: 0.55, sustain: 0, release: 0.4, attackCurve: 'exponential' },
      }),
    release: 0.6,
    percussive: true,
    cal: 0.8,
  },
};

/** Shared "what time is it" for pools: the scheduler updates `now` every tick. */
export interface AudioClock {
  now: number;
}

/** Handle to a sounding pool note: voice index + token so a stolen voice is not released twice. */
export type NoteHandle = number;

const LATE_DROP = 0.06; // s — notes this late are skipped rather than bunched
const MIN_LEAD = 0.004; // s — minimum scheduling lead

/**
 * Pool of up to `size` monophonic voices with oldest-voice stealing.
 *
 * Voices are built on first need rather than up front: a Tone voice is 20–70 native nodes
 * (a dozen always-running ConstantSources among them), so building a whole profile's pools at
 * once stalls the main thread when a deck loads, and pools sized for the worst case would keep
 * idle voices alive for nothing. Growth happens inside the lookahead scheduler, ahead of time.
 */
export class VoicePool {
  private readonly voices: PoolVoice[] = [];
  private readonly busyUntil: Float64Array;
  private readonly lastStart: Float64Array;
  private readonly tokens: Uint16Array;
  private readonly preset: VoicePreset;
  private readonly cap: number;
  private disposed = false;

  constructor(
    kind: VoiceKind,
    size: number,
    private readonly output: Tone.InputNode,
    private readonly clock: AudioClock,
    private readonly detune: Tone.Signal<'cents'> | null,
  ) {
    this.preset = VOICES[kind];
    this.cap = Math.max(1, Math.min(12, size | 0));
    this.busyUntil = new Float64Array(this.cap);
    this.lastStart = new Float64Array(this.cap).fill(-1);
    this.tokens = new Uint16Array(this.cap);
  }

  /** Builds voice `voices.length`; returns its index. */
  private grow(): number {
    const v = this.preset.create();
    v.connect(this.output);
    if (this.detune) this.detune.connect(v.detune);
    this.voices.push(v);
    return this.voices.length - 1;
  }

  /** Clamp a requested start time; returns -1 if the note is too late to play. */
  private admit(time: number): number {
    const now = this.clock.now;
    if (!(time >= now - LATE_DROP)) return -1;
    return time < now + MIN_LEAD ? now + MIN_LEAD : time;
  }

  private choose(time: number): number {
    let free = -1;
    let freeEnd = Infinity;
    let steal = -1;
    let stealEnd = Infinity;
    for (let i = 0; i < this.voices.length; i++) {
      if (this.lastStart[i] >= time - 1e-4) continue; // keep per-voice start times strictly increasing
      const end = this.busyUntil[i];
      if (end <= time) {
        if (end < freeEnd) {
          freeEnd = end;
          free = i;
        }
      } else if (end < stealEnd) {
        stealEnd = end;
        steal = i;
      }
    }
    if (free >= 0) return free;
    // Stealing a voice still ringing jumps its pitch audibly: prefer a fresh voice while allowed.
    if (this.voices.length < this.cap) return this.grow();
    return steal;
  }

  /**
   * Starts a note (MIDI) held until `release()`; returns a handle or -1. `holdMax` only bounds
   * how long the voice counts as busy — held notes are always released explicitly, and a
   * time-dilated pedal can legitimately last minutes.
   */
  attack(midi: number, time: number, velocity: number, holdMax = 600): NoteHandle {
    if (this.disposed || !Number.isFinite(midi)) return -1;
    const t = this.admit(time);
    if (t < 0) return -1;
    const i = this.choose(t);
    if (i < 0) return -1;
    this.voices[i].triggerAttack(mtof(midi), t, Math.min(1, Math.max(0, velocity) * this.preset.cal));
    this.lastStart[i] = t;
    this.busyUntil[i] = t + (this.preset.percussive ? 0 : holdMax) + this.preset.release;
    this.tokens[i] = (this.tokens[i] + 1) & 0xffff;
    return i | (this.tokens[i] << 8);
  }

  /** Releases a held note if its voice has not been stolen since. */
  release(handle: NoteHandle, time: number): void {
    if (this.disposed || handle < 0) return;
    const i = handle & 0xff;
    if (i >= this.voices.length || this.tokens[i] !== handle >>> 8) return;
    this.tokens[i] = (this.tokens[i] + 1) & 0xffff; // a second release on this handle is ignored
    if (this.preset.percussive) return;
    const t = Math.max(time, this.lastStart[i] + 0.01, this.clock.now + MIN_LEAD);
    this.voices[i].triggerRelease(t);
    this.busyUntil[i] = t + this.preset.release;
  }

  /**
   * Disposes voices at the end of the pool that have been silent for at least `idle` seconds.
   * A grown voice stays in the render graph (a dozen always-running signals, 20–70 native nodes)
   * even while silent, so pools that play only now and then (sound effects) hand theirs back and
   * regrow on the next use. Only trailing voices go, so every other index stays valid; a stale
   * handle to a reclaimed index is ignored by release() (index past the end, or an older token).
   */
  reclaim(idle: number): void {
    if (this.disposed) return;
    const now = this.clock.now;
    while (this.voices.length > 0) {
      const i = this.voices.length - 1;
      if (!(now >= this.busyUntil[i] + idle)) break;
      const v = this.voices.pop();
      if (!v) break;
      try {
        if (this.detune) this.detune.disconnect(v.detune);
      } catch {
        /* already disconnected */
      }
      v.dispose();
      this.lastStart[i] = -1;
      this.busyUntil[i] = 0;
      this.tokens[i] = (this.tokens[i] + 1) & 0xffff;
    }
  }

  /** Plays a note of `duration` seconds (hold before the release tail). Returns false if dropped. */
  play(midi: number, time: number, duration: number, velocity: number): boolean {
    const h = this.attack(midi, time, velocity, duration);
    if (h < 0) return false;
    this.release(h, this.lastStart[h & 0xff] + Math.max(0.02, duration));
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const v of this.voices) {
      try {
        if (this.detune) this.detune.disconnect(v.detune);
      } catch {
        /* already disconnected */
      }
      v.dispose();
    }
    this.voices.length = 0;
  }
}
