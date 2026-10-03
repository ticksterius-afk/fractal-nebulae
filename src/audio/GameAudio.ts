/**
 * GameAudio — First Light's sound (design/20-first-light.md §5.6, design/60-first-light-build.md §A).
 *
 * Built on the engine's SFX buses (AudioEngine.game()): every cue shares the space reverb, follows
 * the SFX volume (music mute leaves it on) and the score's detune, and is voiced from the chord
 * sounding now, so the puzzle plays in the Voyage's key and calm voice — no alarms, no beeps.
 *
 *  place / drop   soft membrane thump on the chord root (heavier = lower) + a dark glass pluck
 *  remove         a falling glass-pluck pair
 *  grab           a two-note celesta lift
 *  undo           a short rewind swish settling on a celesta tone
 *  seed lit       the next scale degree of the nebula's melody scale on a bell (order 0, 1, 2 …
 *                 climbs two octaves from the tonic, so a chapter becomes a melody); a degree that
 *                 rubs the sounding chord resolves a semitone onto a chord tone (appoggiatura)
 *  seed unlit     a soft sine sliding down to the chord tone below
 *  capture        low swallow: a triangle sinking an octave + a brown-noise gulp; the hum dips an octave
 *  reflect        glassy chime; a quick burst climbs the chord like a sparkle
 *  ignition       ~3 s bloom: a low sonar root, the chord rising on the glow pad as its filter opens,
 *                 the nebula's own motif instrument playing a rising phrase in its style (arp8,
 *                 cantor, golden …, see motifs.ts), a high celesta sparkle and an airy swell
 *  ui             select tick, open / close dyads, hint bells, a soft low double knock (error)
 *  beam hum       a very quiet bowed tone (detuned saw pair, vibrato, slow bow breath) on the
 *                 tonic; total deflection climbs it through the melody-scale tones that sit well
 *                 over the chord, and each reflection opens its filter and adds an octave partial
 *
 * Safety: every call is a no-op (never a throw) before engine.start() resolved, while the audio
 * context is not running and after dispose(). Polyphony is bounded by voice pools with stealing
 * plus per-cue spacing, so rapid clicks never pile up; the hum touches AudioParams ≤ 30 Hz through
 * dead-banded ramps (control.ts); idle voices are handed back like the Voyage SFX. Nodes are built
 * on first use (a few ms, once; setBeam() builds them early) and torn down when the engine's graph
 * goes away or on dispose().
 */
import * as Tone from 'tone';
import type { MassSize } from '../game/firstlight/types';
import type { AudioEngine, GameAudioBus } from './AudioEngine';
import { Glide } from './control';
import { type AudioClock, VoicePool } from './instruments';
import type { HarmonySnapshot } from './MusicDirector';
import { type MotifSpec, type MotifStyle, type VoiceKind, getProfile } from './profiles';
import { Scale, consonantSubset, hasPc, lowestWithPc, mtof, pc, rubs, snapToChord, tonesInRange } from './scales';
import { DetuneSignal, Out, nativeInput } from './Sfx';
import { clamp, finite } from './util';

export type GameUiCue = 'select' | 'open' | 'close' | 'hint' | 'error';

const CONTROL_INTERVAL = 1 / 30; // s between beam-hum AudioParam updates
const HARMONY_EVERY = 0.5; // s between harmony refreshes for the hum
/** One-shot voices silent this long (s) are disposed (see Sfx VOICE_IDLE). */
const VOICE_IDLE = 30;
const RECLAIM_EVERY = 2; // s
/** Cues scheduled further ahead than this (bursts) are dropped instead of queued. */
const QUEUE_MAX = 0.6; // s
/** dispose(): what still sounds (hum, ringing tails) fades this long before the nodes go (a cut clicks). */
const DISPOSE_FADE = 0.12; // s

// ---- beam hum ----
const HUM_LEVEL = 0.04;
const HUM_REVERB = 0.6;
/** MIDI floor of the hum: the tonic at or above C3. */
const HUM_LOW = 48;
/** Scale tones the hum climbs at most, and the deflection (rad) of the saturating climb. */
const HUM_STEPS = 9;
const HUM_DEFLECT = 0.6;
/** A new step is taken only when the deflection moves this far (in steps) from the current one. */
const HUM_HYST = 0.65;
/** Filter cutoff as a multiple of the hum's pitch (key tracking), its gain per reflection, its ceiling (Hz). */
const HUM_CUTOFF_RATIO = 4.5;
const HUM_BRIGHTEN = 1.3;
const HUM_CUTOFF_MAX = 4500;
const HUM_MAX_REFLECT = 6;
const HUM_PARTIAL = 0.09; // octave-partial gain per reflection (up to 4)
/**
 * Level fade (s), the same both ways: a Glide queues each ramp after the one in flight, so a shorter
 * release issued during a longer attack would be squeezed into 2 ms (a click).
 */
const HUM_FADE = 0.6;
const HUM_GLIDE = 0.24; // s portamento between steps
const HUM_PAUSE_DUCK = 0.3;
/** Seconds of silence after which the hum's nodes are released (rebuilt on demand). */
const HUM_IDLE = 12;

// ---- seeds / chimes ----
/** Degree 0 of the seed melody: the tonic at or above E4; it climbs MELODY_OCTAVES, then restarts. */
const MELODY_LOW = 64;
const MELODY_OCTAVES = 2;
const SEED_GAP = 0.14; // s between seeds lit in one go (an arpeggio, not a cluster)
const SHIMMER_TOP = 100; // highest MIDI note for the shimmer overtone
const REFLECT_GAP = 0.07; // s
const REFLECT_RUN = 1.2; // s of quiet after which a reflection burst restarts at the bottom
const CAPTURE_DIP = 1.8; // s the hum spends an octave down after a capture

// Per-cue minimum spacing (s): repeats inside it are dropped (rapid clicks never pile up).
const C_PLACE = 0;
const C_REMOVE = 1;
const C_GRAB = 2;
const C_DROP = 3;
const C_UNDO = 4;
const C_UNLIT = 5;
const C_CAPTURE = 6;
const C_IGNITE = 7;
const C_UI = 8; // + index of the UI cue (5 slots)
const CUE_SLOTS = 13;
// Mono-synth cues (unlit, capture, undo) stay longer apart than their note so a release is never
// scheduled inside the next note.
const MIN_GAP = [0.06, 0.06, 0.05, 0.05, 0.15, 0.45, 0.75, 2.5, 0.05, 0.12, 0.12, 0.25, 0.2] as const;
const UI_INDEX: Record<GameUiCue, number> = { select: 0, open: 1, close: 2, hint: 3, error: 4 };

/** Place cue per mass size (light, medium, heavy): thump floor, thump velocity, pluck floor. */
const THUMP_LOW = [46, 41, 36] as const;
const THUMP_VEL = [0.32, 0.4, 0.48] as const;
const PLUCK_LOW = [65, 60, 55] as const;

/**
 * Ignition phrase per motif style: onsets (s) of the nebula instrument's rising line, echoing the
 * mathematics of its score (motifs.ts): power-8 arpeggio, Cantor-set rhythm (27 slots, middle
 * thirds removed), halving gaps, Fibonacci-word timing (long = φ × short), a canon, a forking line,
 * a mirrored snowflake, a glissando, and the sparse bells / tolls / glints.
 */
const IGNITE_ONSETS: Record<MotifStyle, readonly number[]> = {
  arp8: [0, 0.13, 0.26, 0.39, 0.52, 0.65, 0.78, 0.91],
  walk: [0, 0.3, 0.45, 0.75, 1.2],
  cantor: [0, 0.15, 0.45, 0.6, 1.35, 1.5, 1.8, 1.95],
  halving: [0, 0.8, 1.2, 1.4, 1.5, 1.55],
  golden: [0, 0.259, 0.419, 0.678, 0.937, 1.097, 1.356, 1.516],
  canon: [0, 0.22, 0.44, 0.66, 0.88],
  fork: [0, 0.2, 0.4, 0.6, 0.8, 1.0],
  crystal: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 0.95, 1.1, 1.25],
  gliss: [0, 0.045, 0.09, 0.135, 0.18, 0.225, 0.27, 0.315, 0.36, 0.405, 0.45, 0.495],
  bells: [0, 0.7, 1.4],
  toll: [0, 1.1],
  sparkle: [0, 0.18, 0.42, 0.55, 0.8],
};

let warned = false;
function warnOnce(what: string, err: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(`[audio] game ${what} failed`, err);
}

// ---------------------------------------------------------------------------------------------
// Pure pitch helpers (exported for the headless checks)
// ---------------------------------------------------------------------------------------------

/**
 * MIDI note of the seed melody for `order` (0, 1, 2 …): scale degree `order` above the tonic at or
 * above MELODY_LOW, wrapping back to the tonic after MELODY_OCTAVES octaves.
 */
export function seedMelodyMidi(melody: Scale, order: number): number {
  const k = Number.isFinite(order) && order > 0 ? Math.floor(order) : 0;
  const span = Math.max(1, melody.size * MELODY_OCTAVES);
  const d0 = melody.degreeNear(lowestWithPc(pc(melody.root), MELODY_LOW));
  return melody.midi(d0 + (k % span));
}

/** Hum step (0..HUM_STEPS) for a total deflection (rad), with hysteresis around `current`. */
export function humStepFor(deflection: number, current: number): number {
  const d = clamp(finite(deflection, 0), 0, 50);
  const x = HUM_STEPS * (1 - Math.exp(-d / HUM_DEFLECT));
  if (x > current + HUM_HYST || x < current - HUM_HYST) return clamp(Math.round(x), 0, HUM_STEPS);
  return current;
}

/**
 * MIDI note of hum step `step`: the `step`-th tone of `safeMask` above the lowest one at or above
 * the tonic (≥ HUM_LOW). `safeMask` must be non-zero.
 */
export function humMidi(safeMask: number, tonicPc: number, step: number): number {
  let m = lowestWithPc(tonicPc, HUM_LOW);
  let guard = 0;
  while (!hasPc(safeMask, m) && guard < 12) {
    m++;
    guard++;
  }
  let k = Math.max(0, Math.floor(step));
  while (k > 0 && guard < 72) {
    m++;
    guard++;
    if (hasPc(safeMask, m)) k--;
  }
  return m;
}

/** Highest tone of `mask` strictly below `midi` (within an octave), else a third below. */
function chordBelow(mask: number, midi: number): number {
  for (let m = midi - 1; m >= midi - 12; m--) if (hasPc(mask, m)) return m;
  return midi - 3;
}

/** Ramps an output (dry and reverb send) to silence from its current gain. */
function fadeOut(o: Out, now: number, seconds: number): void {
  const g = o.node.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.getValueAtTime(now), now);
  g.linearRampToValueAtTime(0, now + seconds);
}

/** `idx`-th of `n` ascending tones, continuing by octaves past either end (capped at MIDI 103). */
function toneAt(tones: Int16Array, n: number, idx: number): number {
  const oct = Math.floor(idx / n);
  return Math.min(103, tones[idx - oct * n] + 12 * oct);
}

// ---------------------------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------------------------

/** One-shot instruments, built once per engine graph. */
class CueKit {
  readonly pluck: VoicePool;
  readonly celesta: VoicePool;
  readonly bell: VoicePool;
  readonly shimmer: VoicePool;
  readonly thump: VoicePool;
  readonly glow: VoicePool;
  readonly glowLP: Tone.Filter;
  readonly sonar: VoicePool;
  readonly swallow: Tone.Synth;
  readonly gulp: Tone.NoiseSynth;
  readonly gulpLP: Tone.Filter;
  readonly fall: Tone.Synth;
  readonly swish: Tone.NoiseSynth;
  readonly swishBP: Tone.Filter;
  readonly swell: Tone.NoiseSynth;
  /** Last start per monophonic synth: Tone needs strictly increasing start times. */
  lastSwallow = 0;
  lastGulp = 0;
  lastFall = 0;
  lastSwish = 0;
  lastSwell = 0;
  private readonly motifOut: Out;
  private readonly motifPools = new Map<VoiceKind, VoicePool>();
  private readonly pools: VoicePool[] = [];
  private readonly outs: Out[] = [];
  private readonly nodes: { dispose(): unknown }[] = [];
  private readonly detuned: Tone.Signal<'cents'>[] = [];

  constructor(
    bus: GameAudioBus,
    private readonly clock: AudioClock,
    private readonly detune: DetuneSignal,
  ) {
    const out = (level: number, reverb: number): Out => {
      const o = new Out(level, reverb, bus.dry, bus.wet);
      this.outs.push(o);
      return o;
    };
    const keep = <T extends { dispose(): unknown }>(n: T): T => {
      this.nodes.push(n);
      return n;
    };
    const pool = (kind: VoiceKind, size: number, dest: Tone.InputNode): VoicePool => {
      const p = new VoicePool(kind, size, dest, clock, detune);
      this.pools.push(p);
      return p;
    };

    this.pluck = pool('glassPluck', 4, out(0.5, 0.6).node);
    this.celesta = pool('celesta', 4, out(0.4, 0.65).node);
    this.bell = pool('bell', 4, out(0.5, 0.7).node);
    this.shimmer = pool('shimmer', 3, out(0.3, 0.9).node);
    this.thump = pool('membrane', 2, out(0.4, 0.35).node);
    this.sonar = pool('sonar', 1, out(0.25, 0.9).node);
    const glowOut = out(0.3, 0.8);
    this.glowLP = keep(new Tone.Filter({ type: 'lowpass', frequency: 2400, Q: 0.5, rolloff: -12 }));
    this.glowLP.connect(glowOut.node);
    this.glow = pool('glow', 5, this.glowLP);
    this.motifOut = out(0.42, 0.7);

    const swallowOut = out(0.32, 0.55);
    this.swallow = keep(
      new Tone.Synth({
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.04, decay: 0.5, sustain: 0.35, release: 1.4, releaseCurve: 'linear' },
      }),
    );
    this.swallow.connect(swallowOut.node);
    const gulpOut = out(0.22, 0.5);
    this.gulp = keep(new Tone.NoiseSynth({ noise: { type: 'brown' }, envelope: { attack: 0.02, decay: 0.35, sustain: 0, release: 0.3 } }));
    this.gulpLP = keep(new Tone.Filter({ type: 'lowpass', frequency: 1100, Q: 0.9, rolloff: -12 }));
    this.gulp.chain(this.gulpLP, gulpOut.node);

    const fallOut = out(0.16, 0.8);
    const fallLP = keep(new Tone.Filter({ type: 'lowpass', frequency: 2400, Q: 0.5, rolloff: -12 }));
    fallLP.connect(fallOut.node);
    this.fall = keep(
      new Tone.Synth({
        oscillator: { type: 'sine' },
        envelope: { attack: 0.05, decay: 0.4, sustain: 0.4, release: 1.2, releaseCurve: 'linear' },
      }),
    );
    this.fall.connect(fallLP);

    const swishOut = out(0.1, 0.6);
    this.swish = keep(new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.12, decay: 0.15, sustain: 0, release: 0.2 } }));
    this.swishBP = keep(new Tone.Filter({ type: 'bandpass', frequency: 1200, Q: 1.2 }));
    this.swish.chain(this.swishBP, swishOut.node);

    const swellOut = out(0.1, 0.8);
    this.swell = keep(
      new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 1.4, decay: 0.3, sustain: 0.5, release: 2.2 } }),
    );
    const swellHP = keep(new Tone.Filter({ type: 'highpass', frequency: 4500, Q: 0.5 }));
    this.swell.chain(swellHP, swellOut.node);

    // Pitched synths follow the score's detune like every pooled voice.
    for (const s of [this.swallow, this.fall]) {
      detune.connect(s.detune);
      this.detuned.push(s.detune);
    }
  }

  /** Pool for a nebula's motif instrument (built on the first ignition in that nebula). */
  motif(kind: VoiceKind): VoicePool {
    let p = this.motifPools.get(kind);
    if (!p) {
      p = new VoicePool(kind, 6, this.motifOut.node, this.clock, this.detune);
      this.motifPools.set(kind, p);
      this.pools.push(p);
    }
    return p;
  }

  reclaim(idle: number): void {
    for (const p of this.pools) p.reclaim(idle);
  }

  fadeOut(now: number, seconds: number): void {
    for (const o of this.outs) fadeOut(o, now, seconds);
  }

  dispose(): void {
    for (const p of this.pools) p.dispose();
    for (const d of this.detuned) {
      try {
        this.detune.disconnect(d);
      } catch {
        /* already disconnected */
      }
    }
    for (const n of this.nodes) {
      try {
        n.dispose();
      } catch {
        /* already disposed */
      }
    }
    for (const o of this.outs) {
      try {
        o.dispose();
      } catch {
        /* already disposed */
      }
    }
  }
}

/** The beam hum: a soft bowed tone (built while a beam sounds, released after HUM_IDLE s of silence). */
class BeamHum {
  private readonly out: Out;
  private readonly level: Tone.Gain;
  private readonly mix: Tone.Gain;
  private readonly breath: Tone.LFO;
  private readonly lp: Tone.Filter;
  private readonly osc: Tone.FatOscillator;
  private readonly partial: Tone.Oscillator;
  private readonly partialGain: Tone.Gain;
  private readonly vibrato: Tone.LFO;
  private readonly gLevel: Glide;
  private readonly gFreq: Glide;
  private readonly gPartialFreq: Glide;
  private readonly gPartial: Glide;
  private readonly gCutoff: Glide;
  /** Seconds the level target has been 0. */
  silentFor = 0;

  constructor(
    bus: GameAudioBus,
    private readonly detune: DetuneSignal,
    now: number,
    freq: number,
  ) {
    this.out = new Out(1, HUM_REVERB, bus.dry, bus.wet);
    this.level = new Tone.Gain(0);
    this.level.connect(this.out.node);
    this.mix = new Tone.Gain(1);
    this.mix.connect(this.level);
    // Slow bow pressure: the tone breathes instead of droning.
    this.breath = new Tone.LFO({ frequency: 0.17, min: 0.7, max: 1 });
    this.breath.connect(this.mix.gain);
    const cutoff = freq * HUM_CUTOFF_RATIO;
    this.lp = new Tone.Filter({ type: 'lowpass', frequency: cutoff, Q: 0.8, rolloff: -12 });
    this.lp.connect(this.mix);
    this.osc = new Tone.FatOscillator({ frequency: freq, type: 'sawtooth', count: 2, spread: 9 });
    this.osc.connect(this.lp);
    this.partial = new Tone.Oscillator({ frequency: 2 * freq, type: 'sine' });
    this.partialGain = new Tone.Gain(0);
    this.partial.chain(this.partialGain, this.mix);
    // Bowed vibrato (±7 cents, 4.7 Hz) on top of the score's detune.
    this.vibrato = new Tone.LFO({ frequency: 4.7, min: -7, max: 7 });
    this.vibrato.connect(this.osc.detune);
    this.vibrato.connect(this.partial.detune);
    detune.connect(this.osc.detune);
    detune.connect(this.partial.detune);
    this.breath.start(now);
    this.vibrato.start(now);
    this.osc.start(now);
    this.partial.start(now);
    this.gLevel = new Glide(this.level.gain, 0, 1e-4);
    this.gFreq = new Glide(this.osc.frequency, freq, 0.002, true);
    this.gPartialFreq = new Glide(this.partial.frequency, 2 * freq, 0.002, true);
    this.gPartial = new Glide(this.partialGain.gain, 0, 0.005);
    this.gCutoff = new Glide(this.lp.frequency, cutoff, 0.02, true);
    this.gLevel.jump(0, now);
  }

  apply(now: number, level: number, freq: number, cutoff: number, partial: number): void {
    const lvl = clamp(finite(level, 0), 0, 0.2);
    this.gLevel.to(lvl, now, HUM_FADE);
    const f = clamp(finite(freq, 110), 30, 2000);
    this.gFreq.to(f, now, HUM_GLIDE);
    this.gPartialFreq.to(2 * f, now, HUM_GLIDE);
    this.gCutoff.to(clamp(finite(cutoff, 600), 150, HUM_CUTOFF_MAX), now, 0.3);
    this.gPartial.to(clamp(finite(partial, 0), 0, 0.5), now, 0.3);
  }

  fadeOut(now: number, seconds: number): void {
    fadeOut(this.out, now, seconds);
  }

  dispose(): void {
    for (const d of [this.osc.detune, this.partial.detune]) {
      try {
        this.detune.disconnect(d);
      } catch {
        /* already disconnected */
      }
    }
    for (const n of [this.osc, this.partial, this.vibrato, this.breath, this.partialGain, this.lp, this.mix, this.level]) {
      try {
        n.dispose();
      } catch {
        /* already disposed */
      }
    }
    this.out.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// GameAudio
// ---------------------------------------------------------------------------------------------

export class GameAudio {
  private readonly clock: AudioClock = { now: 0 };
  private readonly h: HarmonySnapshot = { mask: 0, bassPc: 0, tonic: 50, scaleMask: 0, profileId: 'void' };
  private readonly tones = new Int16Array(48);
  private readonly lastAt = new Float64Array(CUE_SLOTS).fill(-1e9);
  private bus: GameAudioBus | null = null;
  private ctx: Tone.BaseContext | null = null;
  private kit: CueKit | null = null;
  private hum: BeamHum | null = null;
  /**
   * Our own detune, fed from the engine's: every game voice hangs off it, so nothing we connect or
   * disconnect can ever touch the Voyage SFX voices on the engine's signal.
   */
  private detune: DetuneSignal | null = null;
  private disposed = false;
  private nextReclaim = 0;
  // melody scale cache (per profile)
  private scaleId = '';
  private scale: Scale | null = null;
  // seeds / reflections
  private lastSeedAt = -1e9;
  private lastSeedMidi = -1;
  private lastReflectAt = -1e9;
  private reflectRun = 0;
  // beam hum state (latest setBeam() arguments and derived control values)
  private beamDefl = 0;
  private beamRefl = 0;
  private beamOn = false;
  private humStep = 0;
  private humSafeMask = 0;
  private humTonicPc = 2;
  private nextHarmony = 0;
  private lastControl = -1;
  private dipUntil = 0;

  /** Takes the app's AudioEngine (only its game() hooks are used). */
  constructor(private readonly engine: Pick<AudioEngine, 'game'>) {}

  // ---- mass handling ----------------------------------------------------------------------

  place(size: MassSize): void {
    const k = this.ready(C_PLACE);
    if (!k) return;
    try {
      const h = this.harmony();
      const t = this.clock.now + 0.02;
      const si = size === 'light' ? 0 : size === 'heavy' ? 2 : 1;
      k.thump.play(lowestWithPc(h.bassPc, THUMP_LOW[si]), t, 0.1, THUMP_VEL[si]);
      const n = tonesInRange(h.mask, PLUCK_LOW[si], PLUCK_LOW[si] + 12, this.tones);
      if (n > 0) k.pluck.play(this.tones[0], t + 0.015, 0.25, 0.22);
    } catch (err) {
      warnOnce('place', err);
    }
  }

  remove(): void {
    const k = this.ready(C_REMOVE);
    if (!k) return;
    try {
      const h = this.harmony();
      const t = this.clock.now + 0.02;
      const a = chordBelow(h.mask, 80);
      k.pluck.play(a, t, 0.15, 0.26);
      k.pluck.play(chordBelow(h.mask, a), t + 0.1, 0.3, 0.2);
    } catch (err) {
      warnOnce('remove', err);
    }
  }

  grab(): void {
    const k = this.ready(C_GRAB);
    if (!k) return;
    try {
      const h = this.harmony();
      const t = this.clock.now + 0.02;
      const top = snapToChord(h.mask, 84);
      k.celesta.play(chordBelow(h.mask, top), t, 0.06, 0.16);
      k.celesta.play(top, t + 0.06, 0.25, 0.2);
    } catch (err) {
      warnOnce('grab', err);
    }
  }

  drop(): void {
    const k = this.ready(C_DROP);
    if (!k) return;
    try {
      const h = this.harmony();
      const t = this.clock.now + 0.02;
      const top = snapToChord(h.mask, 84);
      k.celesta.play(top, t, 0.06, 0.18);
      k.celesta.play(chordBelow(h.mask, top), t + 0.06, 0.3, 0.16);
      k.thump.play(lowestWithPc(h.bassPc, THUMP_LOW[1]), t + 0.04, 0.1, 0.26);
    } catch (err) {
      warnOnce('drop', err);
    }
  }

  undo(): void {
    const k = this.ready(C_UNDO);
    if (!k) return;
    try {
      const h = this.harmony();
      const t = Math.max(this.clock.now + 0.02, k.lastSwish + 0.01);
      k.lastSwish = t;
      k.swish.triggerAttackRelease(0.12, t, 0.6);
      const f = k.swishBP.frequency;
      f.cancelScheduledValues(t);
      f.setValueAtTime(2600, t);
      f.exponentialRampToValueAtTime(450, t + 0.3);
      const n = tonesInRange(h.mask, 72, 84, this.tones);
      if (n > 0) k.celesta.play(this.tones[0], t + 0.16, 0.3, 0.16);
    } catch (err) {
      warnOnce('undo', err);
    }
  }

  // ---- beam events ------------------------------------------------------------------------

  /**
   * A seed lit. `order` = its place in the chapter's melody (0, 1, 2 …; the mode decides whether it
   * counts per level or across the chapter). Several seeds lit at once play as a quick arpeggio.
   */
  seedLit(order: number): void {
    const k = this.ready(-1);
    if (!k) return;
    try {
      const h = this.harmony();
      const now = this.clock.now;
      const m = seedMelodyMidi(this.melody(), order);
      if (m === this.lastSeedMidi && now < this.lastSeedAt + 0.35) return; // flicker guard
      const t = Math.max(now + 0.02, this.lastSeedAt + SEED_GAP);
      if (t > now + QUEUE_MAX) return;
      this.lastSeedAt = t;
      this.lastSeedMidi = m;
      if (rubs(h.mask, m)) {
        // Appoggiatura: the melody note leans on its chord-tone neighbour and resolves onto it.
        const res = hasPc(h.mask, m - 1) ? m - 1 : m + 1;
        k.bell.play(m, t, 0.22, 0.5);
        k.bell.play(res, t + 0.3, 1.2, 0.42);
        if (res + 12 <= SHIMMER_TOP) k.shimmer.play(res + 12, t + 0.32, 0.9, 0.16);
      } else {
        k.bell.play(m, t, 1.2, 0.52);
        if (m + 12 <= SHIMMER_TOP) k.shimmer.play(m + 12, t + 0.02, 0.9, 0.16);
      }
    } catch (err) {
      warnOnce('seedLit', err);
    }
  }

  /** A configuration change unlit a seed: a soft sine sliding down to the chord tone below. */
  seedUnlit(): void {
    const k = this.ready(C_UNLIT);
    if (!k) return;
    try {
      const h = this.harmony();
      const from = snapToChord(h.mask, 76);
      const to = chordBelow(h.mask, from);
      const t = Math.max(this.clock.now + 0.02, k.lastFall + 0.01);
      k.lastFall = t;
      k.fall.frequency.cancelScheduledValues(t);
      k.fall.triggerAttack(mtof(from), t, 0.5);
      k.fall.frequency.exponentialRampToValueAtTime(mtof(to), t + 0.45);
      k.fall.triggerRelease(t + 0.4);
    } catch (err) {
      warnOnce('seedUnlit', err);
    }
  }

  /** The beam fell into a mass: a low swallow, and the hum sinks an octave for a moment. */
  capture(): void {
    const k = this.ready(C_CAPTURE);
    if (!k) return;
    try {
      const h = this.harmony();
      const now = this.clock.now;
      const f0 = mtof(lowestWithPc(h.bassPc, 45));
      const t = Math.max(now + 0.02, k.lastSwallow + 0.01);
      k.lastSwallow = t;
      k.swallow.frequency.cancelScheduledValues(t);
      k.swallow.triggerAttack(f0, t, 0.5);
      k.swallow.frequency.exponentialRampToValueAtTime(f0 * 0.5, t + 0.9);
      k.swallow.triggerRelease(t + 0.7);
      const tg = Math.max(now + 0.02, k.lastGulp + 0.01);
      k.lastGulp = tg;
      k.gulp.triggerAttackRelease(0.2, tg, 0.6);
      const f = k.gulpLP.frequency;
      f.cancelScheduledValues(tg);
      f.setValueAtTime(1100, tg);
      f.exponentialRampToValueAtTime(90, tg + 0.6);
      // The hum follows on its next control tick (≤ 1/30 s). Forcing a tick now could land on the
      // same currentTime as the last one, and the Glide would squeeze that ramp into 2 ms.
      this.dipUntil = t + CAPTURE_DIP;
    } catch (err) {
      warnOnce('capture', err);
    }
  }

  /** A reflection off a pearl: a glassy chime; a quick burst climbs the chord. */
  reflect(): void {
    const k = this.ready(-1);
    if (!k) return;
    try {
      const h = this.harmony();
      const now = this.clock.now;
      const t = Math.max(now + 0.02, this.lastReflectAt + REFLECT_GAP);
      if (t > now + QUEUE_MAX * 0.75) return;
      this.reflectRun = now > this.lastReflectAt + REFLECT_RUN ? 0 : this.reflectRun + 1;
      this.lastReflectAt = t;
      const n = tonesInRange(h.mask, 84, 98, this.tones);
      if (n === 0) return;
      const m = this.tones[this.reflectRun % n];
      k.pluck.play(m, t, 0.2, 0.34);
      k.shimmer.play(m + 12 <= SHIMMER_TOP ? m + 12 : m, t + 0.01, 0.5, 0.12);
    } catch (err) {
      warnOnce('reflect', err);
    }
  }

  /** The level is solved: a ~3 s bloom in the nebula's key and voice. */
  ignition(): void {
    const k = this.ready(C_IGNITE);
    if (!k) return;
    try {
      const h = this.harmony();
      const t = this.clock.now + 0.03;
      k.sonar.play(lowestWithPc(h.bassPc, 38), t, 0.1, 0.5);
      // The chord rises on the glow pad while its filter opens.
      let n = tonesInRange(h.mask, 52, 84, this.tones);
      const step = n > 5 ? 2 : 1;
      for (let i = 0, j = 0; i < n && j < 5; i += step, j++) {
        k.glow.play(this.tones[i], t + 0.1 + j * 0.14, 2.4 - j * 0.1, 0.38);
      }
      const f = k.glowLP.frequency;
      f.cancelScheduledValues(t);
      f.setValueAtTime(900, t);
      f.exponentialRampToValueAtTime(5200, t + 1.6);
      f.exponentialRampToValueAtTime(2400, t + 5);
      this.motifPhrase(k, h, t + 0.25);
      // High celesta sparkle as the bloom crests, and an airy swell under it all.
      n = tonesInRange(h.mask, 84, 100, this.tones);
      for (let i = 0; i < Math.min(3, n); i++) k.celesta.play(this.tones[i], t + 2.0 + i * 0.12, 0.7, 0.22 - i * 0.03);
      const ts = Math.max(t, k.lastSwell + 0.01);
      k.lastSwell = ts;
      k.swell.triggerAttack(ts, 0.6);
      k.swell.triggerRelease(ts + 2.2);
    } catch (err) {
      warnOnce('ignition', err);
    }
  }

  // ---- interface --------------------------------------------------------------------------

  ui(kind: GameUiCue): void {
    const idx = UI_INDEX[kind];
    if (idx === undefined) return;
    const k = this.ready(C_UI + idx);
    if (!k) return;
    try {
      const h = this.harmony();
      const t = this.clock.now + 0.02;
      switch (kind) {
        case 'select':
          k.celesta.play(snapToChord(h.mask, 88), t, 0.1, 0.14);
          break;
        case 'open':
        case 'close': {
          const lo = snapToChord(h.mask, lowestWithPc(pc(h.tonic), 72));
          let hi = lo + 7;
          if (!hasPc(h.scaleMask, hi)) hi = snapToChord(h.mask, lo + 5);
          if (hi <= lo) hi = lo + 12;
          const first = kind === 'open' ? lo : hi;
          const second = kind === 'open' ? hi : lo;
          k.celesta.play(first, t, 0.3, 0.2);
          k.celesta.play(second, t + 0.14, 0.5, 0.17);
          break;
        }
        case 'hint': {
          const n = tonesInRange(h.mask, 76, 92, this.tones);
          for (let i = 0; i < Math.min(3, n); i++) k.bell.play(this.tones[i], t + i * 0.11, 0.4, 0.3 - 0.04 * i);
          break;
        }
        case 'error': {
          // A soft low double knock — never a beep.
          const low = lowestWithPc(h.bassPc, 40);
          k.thump.play(low, t, 0.1, 0.3);
          k.thump.play(low, t + 0.15, 0.1, 0.22);
          break;
        }
      }
    } catch (err) {
      warnOnce('ui', err);
    }
  }

  // ---- beam hum ---------------------------------------------------------------------------

  /**
   * Beam hum state; cheap to call every frame (AudioParams are touched ≤ 30 Hz, with ramps).
   * `deflection` = total bend from masses (rad, TraceResult beams' `deflection` summed),
   * `reflections` = reflections along the beam(s), `active` = a beam is on screen.
   */
  setBeam(deflection: number, reflections: number, active: boolean): void {
    if (this.disposed) return;
    this.beamDefl = clamp(finite(deflection, 0), 0, 50);
    this.beamRefl = clamp(Math.floor(finite(reflections, 0)), 0, HUM_MAX_REFLECT);
    this.beamOn = active === true;
    try {
      const k = this.ready(-1); // also builds the cue instruments early, off the first click
      const ctx = this.ctx;
      if (!k || !ctx || !this.bus) return;
      const now = ctx.currentTime;
      if (this.lastControl >= 0 && now >= this.lastControl && now - this.lastControl < CONTROL_INTERVAL) return;
      const ctlDt = this.lastControl < 0 || now < this.lastControl ? 0 : Math.min(0.25, now - this.lastControl);
      this.lastControl = now;
      this.controlHum(now, ctlDt, this.bus);
    } catch (err) {
      warnOnce('beam hum', err);
    }
  }

  private controlHum(now: number, dt: number, bus: GameAudioBus): void {
    if (!this.beamOn && !this.hum) return;
    if (now >= this.nextHarmony || this.humSafeMask === 0) {
      this.nextHarmony = now + HARMONY_EVERY;
      const h = this.harmony();
      const melodyMask = this.melody().mask;
      let safe = consonantSubset(melodyMask, h.mask);
      if ((safe & ~(1 << pc(h.tonic))) === 0) safe = h.mask | (1 << pc(h.tonic));
      this.humSafeMask = safe !== 0 ? safe : 1 << pc(h.tonic);
      this.humTonicPc = pc(h.tonic);
    }
    this.humStep = humStepFor(this.beamDefl, this.humStep);
    const dip = now < this.dipUntil;
    let freq = mtof(humMidi(this.humSafeMask, this.humTonicPc, this.humStep));
    if (dip) freq *= 0.5;
    let level = this.beamOn ? HUM_LEVEL : 0;
    if (bus.paused) level *= HUM_PAUSE_DUCK;
    if (dip) level *= 0.45;
    const r = this.beamRefl;
    const cutoff = freq * HUM_CUTOFF_RATIO * Math.pow(HUM_BRIGHTEN, r) * (dip ? 0.6 : 1);
    const partial = HUM_PARTIAL * Math.min(r, 4);
    if (!this.hum) {
      if (level <= 0 || !this.detune) return;
      this.hum = new BeamHum(bus, this.detune, now, freq);
    }
    this.hum.apply(now, level, freq, cutoff, partial);
    if (level > 0) {
      this.hum.silentFor = 0;
    } else {
      this.hum.silentFor += dt;
      if (this.hum.silentFor > HUM_IDLE) {
        this.hum.dispose();
        this.hum = null;
      }
    }
  }

  // ---- lifecycle --------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Mode exit usually happens mid-level with the hum sounding: fade, then drop the nodes. Straight
    // away when the engine's graph is gone or the context is not running (nothing can click).
    const ctx = this.ctx;
    if (ctx && this.bus && (this.kit || this.hum) && this.engine.game() === this.bus && ctx.state === 'running') {
      try {
        const now = ctx.currentTime;
        this.kit?.fadeOut(now, DISPOSE_FADE);
        this.hum?.fadeOut(now, DISPOSE_FADE);
        setTimeout(() => this.finish(), (DISPOSE_FADE + 0.08) * 1000);
        return;
      } catch (err) {
        warnOnce('dispose fade', err);
      }
    }
    this.finish();
  }

  private finish(): void {
    this.release();
    this.bus = null;
    this.ctx = null;
  }

  /**
   * The cue instruments if sound can be made now (engine started, context running, not disposed)
   * and cue `slot` is outside its minimum spacing (slot −1 = no spacing); otherwise null.
   * Rebinds (dropping every node) when the engine's graph changed.
   */
  private ready(slot: number): CueKit | null {
    if (this.disposed) return null;
    const bus = this.engine.game();
    if (bus !== this.bus) {
      this.release();
      this.bus = bus;
      this.ctx = bus ? Tone.getContext() : null;
    }
    const ctx = this.ctx;
    if (!bus || !ctx || ctx.state !== 'running') return null;
    const now = ctx.currentTime;
    this.clock.now = now;
    if (slot >= 0) {
      if (now < this.lastAt[slot] + MIN_GAP[slot] && now >= this.lastAt[slot]) return null;
      this.lastAt[slot] = now;
    }
    try {
      if (!this.kit) {
        if (!this.detune) {
          this.detune = new DetuneSignal(0);
          bus.detune.connect(this.detune);
        }
        this.kit = new CueKit(bus, this.clock, this.detune);
      }
      if (now >= this.nextReclaim) {
        this.nextReclaim = now + RECLAIM_EVERY;
        this.kit.reclaim(VOICE_IDLE);
      }
    } catch (err) {
      warnOnce('setup', err);
      return null;
    }
    return this.kit;
  }

  /** Drops every node and per-graph state (engine rebuilt / torn down, or dispose()). */
  private release(): void {
    try {
      this.hum?.dispose();
      this.kit?.dispose();
    } catch {
      /* best effort */
    }
    const det = this.detune;
    if (det) {
      try {
        // Native-resolved: a plain Tone disconnect from a Signal would cut the engine's signal off
        // every Voyage SFX voice (see nativeInput).
        this.bus?.detune.disconnect(nativeInput(det));
      } catch {
        /* the engine's graph is already gone */
      }
      try {
        det.dispose();
      } catch {
        /* already disposed */
      }
    }
    this.detune = null;
    this.hum = null;
    this.kit = null;
    this.lastAt.fill(-1e9);
    this.lastSeedAt = -1e9;
    this.lastSeedMidi = -1;
    this.lastReflectAt = -1e9;
    this.reflectRun = 0;
    this.lastControl = -1;
    this.nextHarmony = 0;
    this.nextReclaim = 0;
    this.humSafeMask = 0;
    this.dipUntil = 0;
  }

  private harmony(): HarmonySnapshot {
    const h = this.h;
    this.bus?.harmony(h);
    h.bassPc = ((Math.round(finite(h.bassPc, 0)) % 12) + 12) % 12;
    if (!Number.isFinite(h.tonic)) h.tonic = 50;
    return h;
  }

  /** Melody scale of the sounding profile (cached per profile). */
  private melody(): Scale {
    const id = this.h.profileId;
    if (!this.scale || id !== this.scaleId) {
      const p = getProfile(id);
      this.scale = new Scale(p.root, p.melody ?? p.scale);
      this.scaleId = id;
    }
    return this.scale;
  }

  /** The nebula's motif instrument plays a short rising phrase in its style (IGNITE_ONSETS). */
  private motifPhrase(k: CueKit, h: HarmonySnapshot, t: number): void {
    const p = getProfile(h.profileId);
    let spec: MotifSpec | null = null;
    for (const l of p.layers) {
      if (l.kind === 'motif') {
        spec = l;
        break;
      }
    }
    const style: MotifStyle = spec ? spec.style : 'bells';
    const lo = clamp(spec ? spec.register[0] : 69, 55, 84);
    const hi = clamp(spec ? spec.register[1] : 88, lo + 12, 100);
    let n = tonesInRange(h.mask, lo, hi, this.tones);
    if (n < 3) n = tonesInRange(h.mask, lo - 12, hi, this.tones);
    if (n === 0) return;
    const pool = k.motif(spec ? spec.voice : 'bell');
    const pool2 = spec?.voice2 ? k.motif(spec.voice2) : pool;
    const vel = clamp(spec ? spec.vel : 0.5, 0.2, 0.7);
    const onsets = IGNITE_ONSETS[style];
    const last = onsets.length - 1;
    for (let i = 0; i <= last; i++) {
      const at = t + onsets[i];
      const v = vel * (0.75 + 0.35 * (i / Math.max(1, last)));
      const hold = i === last ? 1.2 : 0.45;
      if (style === 'fork' && i >= 3) {
        // The line forks: two branches moving apart from the trunk's last note.
        const d = i - 2;
        pool.play(toneAt(this.tones, n, 2 + d), at, hold, v);
        pool2.play(toneAt(this.tones, n, 2 - d), at, hold, v * 0.85);
        continue;
      }
      const idx = style === 'crystal' && i >= 6 ? 10 - i : i; // snowflake: up six, mirrored down
      pool.play(toneAt(this.tones, n, idx), at, hold, v);
      if (style === 'canon') pool2.play(toneAt(this.tones, n, idx + 2), at + 0.33, hold, v * 0.8);
    }
  }
}
