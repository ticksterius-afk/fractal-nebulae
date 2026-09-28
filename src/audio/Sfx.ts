/**
 * Sound effects: soft, reverberant, always in the current key.
 *
 *  engine hum     brown noise → low-pass (follows drive) + two low sines (42 / 56 Hz, a pure
 *                 fourth that beats very slowly) + a faint harmonic whine that climbs with hyper
 *  hyper          band-pass whoosh up on press, Shepard–Risset riser while held, falling whoosh
 *  target lock    three-note FM bell arpeggio from the sounding chord
 *  pulse          deep sonar ping (sine with pitch drop) + harmonic bloom timed to the wavefront
 *  region enter   airy shimmer swell and a few celesta notes of the new key
 *  horizon        slowing heartbeat over a low swell — no alarm beeps
 *  wormhole       rising noise sweep, sinking drones, then a luminous chord in the new key
 *  autopilot      soft two-note confirmation (and its mirror on arrival)
 */
import * as Tone from 'tone';
import { Glide } from './control';
import { type AudioClock, VoicePool } from './instruments';
import type { HarmonySnapshot } from './MusicDirector';
import { hasPc, lowestWithPc, snapToChord, tonesInRange } from './scales';
import { clamp, clamp01, finite } from './util';

export interface SfxDrive {
  /** 0..1 thrust input. */
  thrust: number;
  /** 0..1 perceived motion (log of speed relative to local scale). */
  motion: number;
  /** 0..1 hyper intensity. */
  hyper: number;
  paused: boolean;
  /** Global pitch shift (cents) from time dilation. */
  detune: number;
}

const HUM_LEVEL = 0.06;
const RISER_LEVEL = 0.025;
const RISER_OCTAVES = 6;
const RISER_LOW = 80; // Hz
const RISER_RATE = 0.06; // spectral cycles per second at hyper = 0.5
/** Horizon warning: a heartbeat that slows down (onsets in s, velocities). */
const HEART_AT = [0, 1.15, 2.4, 3.8] as const;
const HEART_VEL = [0.9, 0.8, 0.65, 0.5] as const;
/**
 * One-shot voices silent this long (s) are disposed (see VoicePool.reclaim): after a few minutes
 * of play every pool would otherwise keep its peak voice count for good (~25 voices, ~1.1k native
 * nodes the audio thread keeps processing, ≈ +50 % render cost over a lone score offline).
 * Regrowing a pool costs a few ms of main thread on its next event.
 */
const VOICE_IDLE = 30;
const RECLAIM_EVERY = 2; // s

/** A send-equipped output: dry to the sfx bus, a fixed amount to the shared reverb. */
class Out {
  readonly node: Tone.Gain;
  private readonly send: Tone.Gain;
  constructor(level: number, reverb: number, dry: Tone.InputNode, wet: Tone.InputNode) {
    this.node = new Tone.Gain(level);
    this.send = new Tone.Gain(reverb);
    this.node.connect(dry);
    this.node.connect(this.send);
    this.send.connect(wet);
  }
  dispose(): void {
    this.node.dispose();
    this.send.dispose();
  }
}

export class Sfx {
  private readonly clock: AudioClock = { now: 0 };
  private readonly ctx = Tone.getContext();
  private readonly outs: Out[] = [];
  private readonly disposables: { dispose(): unknown }[] = [];
  private readonly tones = new Int16Array(48);
  /**
   * Pitch of every tonal one-shot, following the music's detune (time dilation, wormhole
   * swirl): a chime in concert pitch over a score bent 300 cents flat would be badly out of tune.
   */
  private readonly detune: Tone.Signal<'cents'>;
  private readonly gDetune: Glide;

  // engine hum
  private readonly humNoise: Tone.Noise;
  private readonly humLP: Tone.Filter;
  private readonly humLevel: Out;
  private readonly sub1: Tone.Oscillator;
  private readonly sub2: Tone.Oscillator;
  private readonly whine: Tone.Oscillator;
  private readonly whineOut: Out;
  // hyper
  private readonly whoosh: Tone.NoiseSynth;
  private readonly whooshBP: Tone.Filter;
  private lastWhoosh = 0;
  private readonly riserOut: Out;
  private readonly riserU = new Float64Array(RISER_OCTAVES);
  private readonly riserFreq: Glide[] = [];
  private readonly riserGain: Glide[] = [];
  private readonly riserLevel: Glide;
  // control-rate handles (engine hum)
  private readonly gHum: Glide;
  private readonly gHumLP: Glide;
  private readonly gSub1: Glide;
  private readonly gSub2: Glide;
  private readonly gWhine: Glide;
  private readonly gWhineF: Glide;
  private readonly gWhineDetune: Glide;
  private riserPhase = 0;
  private riserOn = false;
  private riserAmp = 0;
  // tonal one-shots
  private readonly bell: VoicePool;
  private readonly celesta: VoicePool;
  private readonly sonar: VoicePool;
  private readonly bloom: VoicePool;
  private readonly bloomLP: Tone.Filter;
  private readonly heart: VoicePool;
  private readonly low: VoicePool;
  private readonly glow: VoicePool;
  private readonly glowLP: Tone.Filter;
  private readonly voicePools: VoicePool[];
  // noise one-shots
  private readonly swell: Tone.NoiseSynth;
  private lastSwell = 0;
  private readonly sweep: Tone.NoiseSynth;
  private readonly sweepBP: Tone.Filter;
  private lastSweep = 0;
  private readonly droneA: Tone.Synth;
  private readonly droneB: Tone.Synth;
  private readonly droneLP: Tone.Filter;
  private wormholeUntil = 0;
  private nextReclaim = 0;
  private disposed = false;

  constructor(dry: Tone.InputNode, wet: Tone.InputNode) {
    const now = this.ctx.currentTime;
    this.clock.now = now;
    const out = (level: number, reverb: number): Out => {
      const o = new Out(level, reverb, dry, wet);
      this.outs.push(o);
      return o;
    };
    const keep = <T extends { dispose(): unknown }>(n: T): T => {
      this.disposables.push(n);
      return n;
    };

    // ---- engine hum ----
    this.humLevel = out(0, 0.12);
    const humMix = keep(new Tone.Gain(1));
    humMix.connect(this.humLevel.node);
    const breath = keep(new Tone.LFO({ frequency: 0.09, min: 0.75, max: 1 }));
    breath.connect(humMix.gain);
    breath.start(now);
    this.humNoise = keep(new Tone.Noise('brown'));
    this.humLP = keep(new Tone.Filter({ type: 'lowpass', frequency: 90, Q: 0.6, rolloff: -12 }));
    const humNoiseGain = keep(new Tone.Gain(0.5));
    this.humNoise.chain(this.humLP, humNoiseGain, humMix);
    this.sub1 = keep(new Tone.Oscillator({ frequency: 42, type: 'sine' }));
    this.sub2 = keep(new Tone.Oscillator({ frequency: 56.1, type: 'sine' }));
    const sub1Gain = keep(new Tone.Gain(0.45));
    const sub2Gain = keep(new Tone.Gain(0.3));
    this.sub1.chain(sub1Gain, humMix);
    this.sub2.chain(sub2Gain, humMix);
    this.whineOut = out(0, 0.3);
    this.whine = keep(new Tone.Oscillator({ frequency: 168, type: 'triangle' }));
    const whineLP = keep(new Tone.Filter({ type: 'lowpass', frequency: 1400, Q: 0.5, rolloff: -12 }));
    this.whine.chain(whineLP, this.whineOut.node);
    this.humNoise.start(now);
    this.sub1.start(now);
    this.sub2.start(now);
    this.whine.start(now);
    this.gHum = new Glide(this.humLevel.node.gain, 0, 2e-4);
    this.gHumLP = new Glide(this.humLP.frequency, 90, 0.01, true);
    this.gSub1 = new Glide(this.sub1.detune, 0, 1);
    this.gSub2 = new Glide(this.sub2.detune, 0, 1);
    this.gWhine = new Glide(this.whineOut.node.gain, 0, 2e-4);
    this.gWhineF = new Glide(this.whine.frequency, 168, 0.003, true);
    this.gWhineDetune = new Glide(this.whine.detune, 0, 1);

    // ---- hyper ----
    const whooshOut = out(0.8, 0.5);
    this.whoosh = keep(
      new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.6, decay: 0.8, sustain: 0.12, release: 2.2 } }),
    );
    this.whooshBP = keep(new Tone.Filter({ type: 'bandpass', frequency: 400, Q: 1.1 }));
    this.whoosh.chain(this.whooshBP, whooshOut.node);
    this.riserOut = out(0, 0.6);
    this.riserLevel = new Glide(this.riserOut.node.gain, 0, 1e-4);
    for (let k = 0; k < RISER_OCTAVES; k++) {
      const f0 = RISER_LOW * Math.pow(2, k);
      const osc = keep(new Tone.Oscillator({ frequency: f0, type: 'sine' }));
      const g = keep(new Tone.Gain(0));
      osc.chain(g, this.riserOut.node);
      osc.start(now);
      this.riserFreq.push(new Glide(osc.frequency, f0, 0.002, true));
      this.riserGain.push(new Glide(g.gain, 0, 0.002));
      this.riserU[k] = k / RISER_OCTAVES;
    }

    // ---- tonal one-shots (voices are built on first use) ----
    const det = (this.detune = new Tone.Signal({ value: 0, units: 'cents' }));
    this.gDetune = new Glide(det, 0, 0.5);
    this.gDetune.jump(0, now);
    this.bell = new VoicePool('bell', 3, out(0.5, 0.55).node, this.clock, det);
    this.celesta = new VoicePool('celesta', 5, out(0.45, 0.65).node, this.clock, det);
    this.sonar = new VoicePool('sonar', 2, out(0.28, 0.9).node, this.clock, det);
    const bloomOut = out(0.3, 0.7);
    this.bloomLP = keep(new Tone.Filter({ type: 'lowpass', frequency: 700, Q: 0.7, rolloff: -12 }));
    this.bloomLP.connect(bloomOut.node);
    this.bloom = new VoicePool('bloom', 5, this.bloomLP, this.clock, det);
    this.heart = new VoicePool('heart', 3, out(0.35, 0.4).node, this.clock, det);
    this.low = new VoicePool('bass', 2, out(0.18, 0.5).node, this.clock, det);
    const glowOut = out(0.35, 0.85);
    this.glowLP = keep(new Tone.Filter({ type: 'lowpass', frequency: 5200, Q: 0.5, rolloff: -12 }));
    this.glowLP.connect(glowOut.node);
    this.glow = new VoicePool('glow', 5, this.glowLP, this.clock, det);
    this.voicePools = [this.bell, this.celesta, this.sonar, this.bloom, this.heart, this.low, this.glow];

    // ---- noise one-shots ----
    const swellOut = out(0.12, 0.8);
    this.swell = keep(
      new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 1.6, decay: 0.3, sustain: 0.5, release: 2.4 } }),
    );
    const swellHP = keep(new Tone.Filter({ type: 'highpass', frequency: 4500, Q: 0.5 }));
    this.swell.chain(swellHP, swellOut.node);
    const sweepOut = out(0.45, 1);
    this.sweep = keep(
      new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 3.8, decay: 0.2, sustain: 0.9, release: 2 } }),
    );
    this.sweepBP = keep(new Tone.Filter({ type: 'bandpass', frequency: 200, Q: 0.8 }));
    this.sweep.chain(this.sweepBP, sweepOut.node);
    const droneOut = out(0.14, 0.9);
    this.droneLP = keep(new Tone.Filter({ type: 'lowpass', frequency: 1400, Q: 0.7, rolloff: -12 }));
    this.droneLP.connect(droneOut.node);
    const droneOpts = {
      oscillator: { type: 'fatsawtooth' as const, count: 3, spread: 30 },
      envelope: { attack: 0.8, decay: 0.5, sustain: 0.9, release: 3 },
    };
    this.droneA = keep(new Tone.Synth(droneOpts));
    this.droneB = keep(new Tone.Synth(droneOpts));
    this.droneA.connect(this.droneLP);
    this.droneB.connect(this.droneLP);
  }

  private t(lead = 0.02): number {
    const now = this.ctx.currentTime;
    this.clock.now = now;
    return now + lead;
  }

  // ---------------------------------------------------------------------------------------------
  // Continuous: engine hum + hyper riser (called at control rate)
  // ---------------------------------------------------------------------------------------------

  update(d: SfxDrive, dt: number): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    this.clock.now = now;
    const hyper = clamp01(finite(d.hyper, 0));
    const drive = clamp01(0.35 * clamp01(finite(d.thrust, 0)) + 0.45 * clamp01(finite(d.motion, 0)) + 0.4 * hyper);
    const duck = d.paused ? 0.3 : 1;
    const musicCents = clamp(finite(d.detune, 0), -1200, 600);
    const cents = musicCents * 0.5;
    const lag = clamp(dt, 0.02, 0.1) * 2;

    this.gDetune.to(musicCents, now, lag);
    if (now >= this.nextReclaim) {
      this.nextReclaim = now + RECLAIM_EVERY;
      for (const pool of this.voicePools) pool.reclaim(VOICE_IDLE);
    }

    this.gHum.to((0.35 + 0.65 * drive) * HUM_LEVEL * duck, now, lag * 3);
    this.gHumLP.to(70 * Math.pow(2, drive * 2.8), now, lag * 3);
    this.gSub1.to(cents, now, lag * 3);
    this.gSub2.to(cents, now, lag * 3);
    this.gWhine.to((0.004 + 0.03 * hyper * hyper) * duck, now, lag * 2);
    this.gWhineF.to(168 * (1 + 0.25 * drive) * Math.pow(2, 1.3 * hyper), now, lag * 2);
    this.gWhineDetune.to(cents, now, lag * 3);

    // Shepard–Risset riser: octave-spaced sines glide up under a fixed bell-shaped spectrum;
    // each wraps from top to bottom exactly where its weight is zero, so the rise never ends.
    const target = this.riserOn && !d.paused ? 0.4 + 0.6 * hyper : 0;
    this.riserAmp += (target - this.riserAmp) * clamp01(dt / (target > this.riserAmp ? 0.5 : 0.9));
    if (this.riserAmp < 0.002 && !this.riserOn) {
      this.riserAmp = 0;
      this.riserLevel.to(0, now, lag);
      return;
    }
    this.riserLevel.to(this.riserAmp * RISER_LEVEL, now, lag);
    this.riserPhase += clamp(dt, 0, 0.1) * RISER_RATE * (0.5 + hyper);
    this.riserPhase -= Math.floor(this.riserPhase);
    for (let k = 0; k < RISER_OCTAVES; k++) {
      let u = this.riserPhase + k / RISER_OCTAVES;
      u -= Math.floor(u);
      const f = RISER_LOW * Math.pow(2, u * RISER_OCTAVES);
      const w = Math.sin(Math.PI * u);
      if (u < this.riserU[k]) this.riserFreq[k].jump(f, now);
      else this.riserFreq[k].to(f, now, lag);
      this.riserGain[k].to(w * w, now, lag);
      this.riserU[k] = u;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------------------------

  hyperStart(): void {
    if (this.disposed) return;
    const t = Math.max(this.t(0.015), this.lastWhoosh + 0.01);
    this.lastWhoosh = t;
    this.whoosh.envelope.attack = 0.6;
    this.whoosh.triggerAttack(t, 0.8);
    const f = this.whooshBP.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(300, t);
    f.exponentialRampToValueAtTime(3200, t + 1.6);
    f.exponentialRampToValueAtTime(1300, t + 3.5);
    this.riserOn = true;
  }

  hyperEnd(): void {
    if (this.disposed) return;
    const t = Math.max(this.t(0.015), this.lastWhoosh + 0.01);
    this.lastWhoosh = t;
    this.whoosh.envelope.attack = 0.12;
    this.whoosh.triggerAttack(t, 0.55);
    this.whoosh.triggerRelease(t + 0.3);
    const f = this.whooshBP.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(2600, t);
    f.exponentialRampToValueAtTime(160, t + 2.4);
    this.riserOn = false;
  }

  targetLock(h: HarmonySnapshot): void {
    if (this.disposed) return;
    const t = this.t(0.02);
    const n = tonesInRange(h.mask, 76, 96, this.tones);
    if (n === 0) return;
    const start = Math.floor(Math.random() * Math.max(1, n - 2));
    for (let i = 0; i < 3 && start + i < n; i++) this.bell.play(this.tones[start + i], t + i * 0.085, 0.4, 0.45 - 0.065 * i);
  }

  pulse(h: HarmonySnapshot): void {
    if (this.disposed) return;
    const t = this.t(0.02);
    const root = lowestWithPc(h.bassPc, 45);
    this.sonar.play(root, t, 0.1, 0.7);
    // Harmonic bloom: the chord swells as the wavefront travels (~4.5 s), then lets go.
    const n = tonesInRange(h.mask, 55, 81, this.tones);
    const step = n > 5 ? 2 : 1;
    let k = 0;
    for (let i = 0; i < n && k < 5; i += step, k++) {
      this.bloom.play(this.tones[i], t + 0.35 + k * 0.12, 2.1 - k * 0.12, 0.35);
    }
    const f = this.bloomLP.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(600, t);
    f.exponentialRampToValueAtTime(3200, t + 2.2);
    f.exponentialRampToValueAtTime(900, t + 4.8);
  }

  regionEnter(h: HarmonySnapshot): void {
    if (this.disposed) return;
    const t = Math.max(this.t(0.02), this.lastSwell + 0.01);
    this.lastSwell = t;
    this.swell.triggerAttack(t, 0.7);
    this.swell.triggerRelease(t + 1.8);
    const n = tonesInRange(h.mask, 79, 96, this.tones);
    for (let i = 0; i < Math.min(4, n); i++) this.celesta.play(this.tones[i], t + 1.1 + i * 0.21, 0.6, 0.28 - i * 0.03);
  }

  horizonWarning(h: HarmonySnapshot): void {
    if (this.disposed) return;
    const t = this.t(0.03);
    const low = lowestWithPc(((h.tonic % 12) + 12) % 12, 33);
    this.low.play(low, t, 4, 0.55);
    const beat = lowestWithPc(((h.tonic % 12) + 12) % 12, 28);
    for (let i = 0; i < HEART_AT.length; i++) {
      this.heart.play(beat, t + HEART_AT[i], 0.1, HEART_VEL[i]);
      this.heart.play(beat, t + HEART_AT[i] + 0.3, 0.1, HEART_VEL[i] * 0.6);
    }
  }

  wormholeStart(duration: number): void {
    if (this.disposed) return;
    const dur = clamp(finite(duration, 5), 1, 20);
    const t = Math.max(this.t(0.02), this.lastSweep + 0.01);
    this.lastSweep = t;
    this.wormholeUntil = t + dur;
    this.sweep.triggerAttack(t, 0.8);
    const f = this.sweepBP.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(160, t);
    f.exponentialRampToValueAtTime(5200, t + dur * 0.92);
    this.droneA.frequency.cancelScheduledValues(t);
    this.droneB.frequency.cancelScheduledValues(t);
    this.droneA.triggerAttack(110, t, 0.6);
    this.droneA.frequency.exponentialRampToValueAtTime(27.5, t + dur);
    this.droneB.triggerAttack(164.8, t + 0.1, 0.5);
    this.droneB.frequency.exponentialRampToValueAtTime(41.2, t + dur);
    const lp = this.droneLP.frequency;
    lp.cancelScheduledValues(t);
    lp.setValueAtTime(1400, t);
    lp.exponentialRampToValueAtTime(220, t + dur);
    // Safety net in case the end event never arrives (a later release cancels this one).
    this.sweep.triggerRelease(t + dur + 1.5);
    this.droneA.triggerRelease(t + dur + 1.5);
    this.droneB.triggerRelease(t + dur + 1.5);
  }

  wormholeEnd(h: HarmonySnapshot): void {
    if (this.disposed) return;
    const t = this.t(0.02);
    if (t < this.wormholeUntil + 1.5) {
      this.sweep.triggerRelease(t);
      this.droneA.triggerRelease(t);
      this.droneB.triggerRelease(t);
    }
    this.wormholeUntil = 0;
    // Luminous chord in the destination key.
    const n = tonesInRange(h.mask, 52, 84, this.tones);
    const step = n > 5 ? 2 : 1;
    let k = 0;
    for (let i = 0; i < n && k < 5; i += step, k++) this.glow.play(this.tones[i], t + k * 0.05, 2.5, 0.4);
    const f = this.glowLP.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(2200, t);
    f.exponentialRampToValueAtTime(6000, t + 1.2);
    f.exponentialRampToValueAtTime(2500, t + 6);
    const m = tonesInRange(h.mask, 84, 100, this.tones);
    for (let i = 0; i < Math.min(4, m); i++) this.celesta.play(this.tones[i], t + 0.25 + i * 0.13, 0.8, 0.3 - i * 0.04);
  }

  autopilotStart(h: HarmonySnapshot): void {
    if (this.disposed) return;
    const t = this.t(0.02);
    const a = this.dyadLow(h);
    const b = this.dyadHigh(h, a);
    this.celesta.play(a, t, 0.5, 0.3);
    this.celesta.play(b, t + 0.18, 0.7, 0.26);
  }

  autopilotArrived(h: HarmonySnapshot): void {
    if (this.disposed) return;
    const t = this.t(0.02);
    const a = this.dyadLow(h);
    const b = this.dyadHigh(h, a);
    this.celesta.play(b, t, 0.5, 0.24);
    this.celesta.play(a, t + 0.22, 0.9, 0.22);
  }

  /** The tonic (snapped to the sounding chord) around C5–C6. */
  private dyadLow(h: HarmonySnapshot): number {
    return snapToChord(h.mask, lowestWithPc(((h.tonic % 12) + 12) % 12, 72));
  }

  /** A fifth above `root` (or the nearest chord tone above a fourth when the fifth is out of key). */
  private dyadHigh(h: HarmonySnapshot, root: number): number {
    let fifth = root + 7;
    if (!hasPc(h.scaleMask, fifth)) fifth = snapToChord(h.mask, root + 5);
    return fifth > root ? fifth : root + 12;
  }

  setPaused(p: boolean): void {
    if (p) this.riserOn = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pool of this.voicePools) pool.dispose();
    this.detune.dispose();
    for (const n of this.disposables) {
      try {
        n.dispose();
      } catch {
        /* already disposed */
      }
    }
    for (const o of this.outs) o.dispose();
  }
}
