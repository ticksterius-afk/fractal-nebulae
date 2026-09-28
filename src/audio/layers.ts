/**
 * Deck layers: pad, drone, texture (noise swells / thunder), heartbeat pulse and the
 * stepped Shepard scale. Melodic motif layers live in motifs.ts.
 *
 * A layer is driven by its deck's lookahead scheduler: `step(beat, time)` plays whatever is
 * due at `beat` (already converted to audio `time`) and returns the beat of its next event.
 */
import * as Tone from 'tone';
import type { Harmony } from './Harmony';
import { type AudioClock, VoicePool } from './instruments';
import type { DroneSpec, LayerSpec, PadSpec, ProfileDef, PulseSpec, ShepardSpec, TextureSpec } from './profiles';
import { Scale, lowestWithPc, mtof, pc, pcDistance, rubs } from './scales';
import { chance, clamp, dbToGain, human, rand, randExp, randInt } from './util';

/** What a layer can see of its deck. */
export interface DeckContext {
  readonly clock: AudioClock;
  readonly profile: ProfileDef;
  /** Harmony scale (chords). */
  readonly scale: Scale;
  /** Melodic scale (motifs). */
  readonly melody: Scale;
  readonly harmony: Harmony;
  /** Deck-wide detune (cents) — connected to every voice. */
  readonly detune: Tone.Signal<'cents'>;
  /** Seconds per beat right now (tempo × time dilation). */
  readonly spb: number;
  /** 2^(detune/1200): pitch factor for things that are not voices (noise filters). */
  readonly pitchFactor: number;
  beatToTime(beat: number): number;
}

/** Deck-level destinations a layer's output feeds. */
export interface DeckBus {
  dry: Tone.InputNode;
  wet: Tone.InputNode;
  echo: Tone.InputNode;
}

export abstract class Layer {
  nextBeat = 0;
  protected readonly out: Tone.Gain;
  private readonly revSend: Tone.Gain;
  private readonly dlySend: Tone.Gain | null;

  constructor(
    protected readonly deck: DeckContext,
    spec: LayerSpec,
    bus: DeckBus,
  ) {
    this.out = new Tone.Gain(dbToGain(spec.level));
    this.out.connect(bus.dry);
    this.revSend = new Tone.Gain(clamp(spec.rev, 0, 1));
    this.out.connect(this.revSend);
    this.revSend.connect(bus.wet);
    if (spec.dly && spec.dly > 0) {
      this.dlySend = new Tone.Gain(clamp(spec.dly, 0, 1));
      this.out.connect(this.dlySend);
      this.dlySend.connect(bus.echo);
    } else {
      this.dlySend = null;
    }
  }

  /** Called once when the deck starts playing at `time`. */
  begin(_time: number): void {}

  /** Plays everything due at `beat` (audio `time`); returns the beat of the next event. */
  abstract step(beat: number, time: number): number;

  dispose(): void {
    this.disposeNodes();
    this.out.dispose();
    this.revSend.dispose();
    this.dlySend?.dispose();
  }

  protected abstract disposeNodes(): void;
}

// ---------------------------------------------------------------------------------------------
// Pad
// ---------------------------------------------------------------------------------------------

const MAX_PAD = 4;

/**
 * Voices `src` (authored chord, `n` notes) into `want` notes around `center`, trying
 * inversions to keep movement small and the register comfortable. Writes to `out`.
 */
function voiceChord(src: Int16Array, n: number, want: number, lo: number, hi: number, center: number, out: Int16Array): number {
  const tmp = out;
  let count = 0;
  for (let i = 0; i < n; i++) {
    // insertion sort, skipping duplicates
    const v = src[i];
    let j = count;
    let dup = false;
    for (let k = 0; k < count; k++) if (tmp[k] === v) dup = true;
    if (dup) continue;
    while (j > 0 && tmp[j - 1] > v) {
      tmp[j] = tmp[j - 1];
      j--;
    }
    tmp[j] = v;
    count++;
  }
  // Thin out: drop the fifth first, then inner voices (keep the root and the top colour tone).
  while (count > want && count > 1) {
    let drop = -1;
    for (let k = 1; k < count - 1; k++) if (((tmp[k] - tmp[0]) % 12 + 12) % 12 === 7) drop = k;
    if (drop < 0) drop = count > 2 ? 1 : count - 1;
    for (let k = drop; k < count - 1; k++) tmp[k] = tmp[k + 1];
    count--;
  }
  if (count === 0) return 0;
  // Move to the target register, then pick the best of five inversions.
  let mean = 0;
  for (let k = 0; k < count; k++) mean += tmp[k];
  mean /= count;
  const shift = Math.round((center - mean) / 12) * 12;
  for (let k = 0; k < count; k++) tmp[k] += shift;

  let bestInv = 0;
  let bestCost = Infinity;
  for (let inv = -2; inv <= 2; inv++) {
    const cost = inversionCost(tmp, count, inv, lo, hi, center);
    if (cost < bestCost) {
      bestCost = cost;
      bestInv = inv;
    }
  }
  applyInversion(tmp, count, bestInv);
  return count;
}

function applyInversion(a: Int16Array, n: number, inv: number): void {
  for (let s = 0; s < Math.abs(inv); s++) {
    if (inv > 0) {
      const low = a[0] + 12;
      for (let k = 0; k < n - 1; k++) a[k] = a[k + 1];
      a[n - 1] = low;
    } else {
      const high = a[n - 1] - 12;
      for (let k = n - 1; k > 0; k--) a[k] = a[k - 1];
      a[0] = high;
    }
  }
}

const invScratch = new Int16Array(8);
function inversionCost(a: Int16Array, n: number, inv: number, lo: number, hi: number, center: number): number {
  for (let k = 0; k < n; k++) invScratch[k] = a[k];
  applyInversion(invScratch, n, inv);
  let mean = 0;
  let cost = 0;
  for (let k = 0; k < n; k++) {
    const m = invScratch[k];
    mean += m;
    if (m < lo) cost += (lo - m) * 3;
    if (m > hi) cost += (m - hi) * 3;
    // Close intervals get muddy low down.
    if (k > 0 && m < 57 && m - invScratch[k - 1] < 4) cost += 4;
    // Minor seconds / ninths (e.g. a maj7 inverted below its root) are never pretty in a pad.
    for (let j = 0; j < k; j++) {
      const iv = m - invScratch[j];
      if (iv === 1 || iv === 13) cost += 14;
    }
  }
  mean /= n;
  return cost + Math.abs(mean - center) + Math.random() * 1.5;
}

export class PadLayer extends Layer {
  private readonly pool: VoicePool;
  private readonly filter: Tone.Filter;
  private readonly lfo: Tone.LFO;
  private readonly chorus: Tone.Chorus | null;
  private readonly panner: Tone.AutoPanner | null;
  private readonly handles = new Int32Array(MAX_PAD).fill(-1);
  private readonly notes = new Int16Array(MAX_PAD);
  private readonly src = new Int16Array(8);
  private readonly voiced = new Int16Array(8);
  private count = 0;
  private center: number;
  private colorAt = -1;
  private chordStart = -1;
  private chordMask = 0;

  constructor(
    deck: DeckContext,
    private readonly spec: PadSpec,
    bus: DeckBus,
  ) {
    super(deck, spec, bus);
    this.center = (spec.register[0] + spec.register[1]) / 2;
    this.filter = new Tone.Filter({ type: 'lowpass', frequency: spec.cutoff, Q: spec.q ?? 0.8, rolloff: -12 });
    this.lfo = new Tone.LFO({
      frequency: spec.lfoHz,
      min: spec.cutoff,
      max: spec.cutoff * Math.pow(2, spec.cutoffOctaves),
      phase: Math.random() * 360,
    });
    this.lfo.connect(this.filter.frequency);
    let node: Tone.ToneAudioNode = this.filter;
    if (spec.autopan) {
      this.panner = new Tone.AutoPanner({ frequency: spec.autopan.hz, depth: spec.autopan.depth, wet: 1, channelCount: 2 });
      node.connect(this.panner);
      node = this.panner;
    } else {
      this.panner = null;
    }
    if (spec.chorus && spec.chorus > 0) {
      this.chorus = new Tone.Chorus({ frequency: 0.25 + Math.random() * 0.2, delayTime: 4.5, depth: 0.55, spread: 180, wet: spec.chorus });
      node.connect(this.chorus);
      node = this.chorus;
    } else {
      this.chorus = null;
    }
    node.connect(this.out);
    // Up to three chords' worth: with short chords (2 bars at 76–80 bpm ≈ 6 s) the release tails
    // of the previous two chords (7–9 s) still ring when the next one starts, and stealing a
    // ringing pad voice is an audible pitch jump under a slow attack. The pool grows on demand.
    this.pool = new VoicePool(spec.voice, clamp(spec.notes, 1, MAX_PAD) * 3, this.filter, deck.clock, deck.detune);
  }

  begin(time: number): void {
    this.lfo.start(time);
    this.chorus?.start(time);
    this.panner?.start(time);
  }

  step(beat: number, time: number): number {
    const h = this.deck.harmony;
    const slot = h.slotAt(beat);
    const start = h.slotStart(slot);
    const end = h.slotEnd(slot);
    if (this.count === 0 || start !== this.chordStart) {
      this.chordStart = start;
      this.chordMask = h.slotMask(slot);
      this.playChord(h.slotChord(slot), time);
      if (this.spec.color && end - start >= 8 && chance(0.6)) {
        this.colorAt = start + Math.round((end - start) / 2);
        return this.colorAt;
      }
      this.colorAt = -1;
      return end;
    }
    if (this.colorAt >= 0 && beat >= this.colorAt - 1e-3) {
      this.colorAt = -1;
      this.colorMove(time);
    }
    return end;
  }

  private playChord(chordIndex: number, time: number): void {
    const [lo, hi] = this.spec.register;
    const n = this.deck.harmony.chordMidis(chordIndex, this.src);
    this.center = clamp(this.center + rand(-3, 3), lo + 6, hi - 6);
    const count = voiceChord(this.src, n, Math.min(MAX_PAD, this.spec.notes), lo, hi, this.center, this.voiced);
    // Release the old chord a touch after the new one begins (slow attacks crossfade).
    for (let i = 0; i < this.count; i++) this.pool.release(this.handles[i], time + 0.15);
    const vel = rand(this.spec.vel[0], this.spec.vel[1]);
    const strum = (this.spec.strum ?? 0.12) * this.deck.spb;
    for (let i = 0; i < count; i++) {
      this.notes[i] = this.voiced[i];
      this.handles[i] = this.pool.attack(this.voiced[i], time + i * strum * rand(0.5, 1), human(vel, 0.12));
    }
    this.count = count;
  }

  /** Moves the top voice one scale step to a consonant neighbour (a slowly blooming colour). */
  private colorMove(time: number): void {
    if (this.count < 2) return;
    const top = this.count - 1;
    const m = this.notes[top];
    const scale = this.deck.scale;
    const deg = scale.degreeNear(m);
    const a = scale.midi(deg + 1);
    const b = scale.midi(deg - 1);
    const okA = this.consonant(a, top);
    const okB = b > this.notes[top - 1] && this.consonant(b, top);
    const next = okA && okB ? (chance(0.6) ? a : b) : okA ? a : okB ? b : -1;
    if (next < 0) return;
    this.pool.release(this.handles[top], time);
    this.handles[top] = this.pool.attack(next, time + 0.05, human(this.spec.vel[0], 0.1));
    this.notes[top] = next;
  }

  /** No semitone against the other pad voices nor against any tone of the full chord. */
  private consonant(m: number, skip: number): boolean {
    if (rubs(this.chordMask, m)) return false;
    for (let i = 0; i < this.count; i++) if (i !== skip && pcDistance(m, this.notes[i]) < 2) return false;
    return true;
  }

  protected disposeNodes(): void {
    this.pool.dispose();
    this.lfo.dispose();
    this.filter.dispose();
    this.chorus?.dispose();
    this.panner?.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Drone / bass
// ---------------------------------------------------------------------------------------------

export class DroneLayer extends Layer {
  private readonly pool: VoicePool;
  private readonly handles = new Int32Array(3).fill(-1);
  private held = 0;
  private chords = 0;
  private chordStart = -1;
  private lastPc = -1;

  constructor(
    deck: DeckContext,
    private readonly spec: DroneSpec,
    bus: DeckBus,
  ) {
    super(deck, spec, bus);
    const notes = 1 + (spec.octaveBelow ? 1 : 0) + (spec.fifth ? 1 : 0);
    this.pool = new VoicePool(spec.voice, notes * 2, this.out, deck.clock, deck.detune);
  }

  step(beat: number, time: number): number {
    const h = this.deck.harmony;
    const slot = h.slotAt(beat);
    const end = h.slotEnd(slot);
    if (h.slotStart(slot) === this.chordStart && this.held > 0) return end;
    this.chordStart = h.slotStart(slot);
    const mask = h.slotMask(slot);
    const pitchClass = this.spec.mode === 'pedal' ? pc(this.deck.scale.root) : h.slotBassPc(slot);
    // A pedal re-articulates every other chord; a moving bass only when the root changes.
    const rearticulate = this.held === 0 || pitchClass !== this.lastPc || (this.spec.mode === 'pedal' && this.chords % 2 === 0);
    this.chords++;
    if (!rearticulate) return end;
    this.lastPc = pitchClass;

    const [lo, hi] = this.spec.register;
    let root = lowestWithPc(pitchClass, lo);
    if (root > hi) root -= 12;
    for (let i = 0; i < this.held; i++) this.pool.release(this.handles[i], time + 0.3);
    let n = 0;
    const vel = this.spec.vel;
    this.handles[n++] = this.pool.attack(root, time, human(vel, 0.08));
    if (this.spec.octaveBelow && root - 12 >= 23) this.handles[n++] = this.pool.attack(root - 12, time + 0.05, vel * 0.5);
    const fifth = root + 7;
    if (this.spec.fifth && this.deck.scale.contains(fifth) && !rubs(mask, fifth)) {
      this.handles[n++] = this.pool.attack(fifth, time + 0.4, vel * 0.4);
    }
    this.held = n;
    return end;
  }

  protected disposeNodes(): void {
    this.pool.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Noise texture: slow breathing swells, or distant thunder
// ---------------------------------------------------------------------------------------------

export class TextureLayer extends Layer {
  private readonly noise: Tone.Noise;
  private readonly filter: Tone.Filter;
  private readonly swell: Tone.Gain;
  private busyUntil = 0;

  constructor(
    deck: DeckContext,
    private readonly spec: TextureSpec,
    bus: DeckBus,
  ) {
    super(deck, spec, bus);
    const [a, b] = spec.range;
    this.noise = new Tone.Noise(spec.noise);
    this.filter = new Tone.Filter({ type: spec.filter, frequency: Math.sqrt(a * b), Q: spec.q, rolloff: -12 });
    this.swell = new Tone.Gain(0);
    this.noise.chain(this.filter, this.swell, this.out);
  }

  begin(time: number): void {
    this.noise.start(time);
    this.swell.gain.setValueAtTime(0, time);
    this.filter.frequency.setValueAtTime(this.freq(Math.sqrt(this.spec.range[0] * this.spec.range[1])), time);
  }

  private freq(f: number): number {
    return clamp(f * this.deck.pitchFactor, 20, 16000);
  }

  step(beat: number, time: number): number {
    const bars = randInt(this.spec.bars[0], this.spec.bars[1]);
    const lenBeats = bars * this.deck.profile.beatsPerBar;
    const lenSec = lenBeats * this.deck.spb;
    if (time < this.busyUntil) return beat + lenBeats;
    if (this.spec.mode === 'thunder') {
      if (lenSec > 9.5 && chance(0.55)) this.thunder(time);
      return beat + lenBeats;
    }
    const [a, b] = this.spec.range;
    const target = chance(0.2) ? rand(0.05, 0.2) : rand(0.35, 1);
    const end = time + lenSec * 0.9;
    this.swell.gain.linearRampToValueAtTime(target, end);
    this.filter.frequency.exponentialRampToValueAtTime(this.freq(randExp(a, b)), end);
    this.busyUntil = end;
    return beat + lenBeats;
  }

  /** A distant roll of thunder: two or three rumbles, then a long dark decay. */
  private thunder(t: number): void {
    const g = this.swell.gain;
    const f = this.filter.frequency;
    const [a, b] = this.spec.range;
    const peak = rand(0.55, 1);
    const roll = rand(0, 0.7);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(peak * 0.5, t + rand(0.4, 0.9));
    g.linearRampToValueAtTime(peak * 0.28, t + 1.5);
    g.linearRampToValueAtTime(peak, t + 2.1 + roll);
    g.linearRampToValueAtTime(peak * 0.45, t + 3.3 + roll);
    g.linearRampToValueAtTime(peak * 0.2, t + 5.2 + roll);
    g.linearRampToValueAtTime(peak * 0.05, t + 7.2 + roll);
    g.linearRampToValueAtTime(0, t + 9 + roll);
    f.setValueAtTime(this.freq(b), t);
    f.exponentialRampToValueAtTime(this.freq(a), t + 8.5 + roll);
    this.busyUntil = t + 9.2 + roll;
  }

  protected disposeNodes(): void {
    try {
      this.noise.stop();
    } catch {
      /* not started */
    }
    this.noise.dispose();
    this.filter.dispose();
    this.swell.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Heartbeat pulse (bh-maw)
// ---------------------------------------------------------------------------------------------

export class PulseLayer extends Layer {
  private readonly pool: VoicePool;
  private restIn = 0;

  constructor(
    deck: DeckContext,
    private readonly spec: PulseSpec,
    bus: DeckBus,
  ) {
    super(deck, spec, bus);
    this.pool = new VoicePool('membrane', 3, this.out, deck.clock, deck.detune);
    this.restIn = randInt(6, 14);
  }

  step(beat: number, time: number): number {
    const every = Math.max(0.5, this.spec.every);
    if (--this.restIn <= 0) {
      // A breath: skip a beat now and then so the pulse never feels mechanical.
      this.restIn = randInt(6, 16);
      return beat + every;
    }
    const v = human(this.spec.vel, 0.1);
    this.pool.play(this.spec.note, time, 0.2, v);
    this.pool.play(this.spec.note, time + 0.2 * this.deck.spb, 0.2, v * 0.6);
    return beat + every;
  }

  protected disposeNodes(): void {
    this.pool.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Stepped Shepard scale (bh-eye): octave-spaced sines under a bell-shaped spectral envelope,
// stepping through the mode forever in one direction.
// ---------------------------------------------------------------------------------------------

export class ShepardLayer extends Layer {
  private readonly oscs: Tone.Oscillator[] = [];
  private readonly gains: Tone.Gain[] = [];
  private readonly pos: Int32Array;
  private readonly curF: Float64Array;
  private readonly curG: Float64Array;
  private readonly span: number;
  private readonly offset: number;
  private s = 0;

  constructor(
    deck: DeckContext,
    private readonly spec: ShepardSpec,
    bus: DeckBus,
  ) {
    super(deck, spec, bus);
    const n = clamp(Math.round(spec.octaves), 2, 8);
    this.span = n * deck.scale.size;
    this.offset = Math.round((spec.baseMidi - deck.scale.root) / 12) * 12;
    this.pos = new Int32Array(n);
    this.curF = new Float64Array(n);
    this.curG = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const osc = new Tone.Oscillator({ frequency: 110, type: 'sine' });
      const g = new Tone.Gain(0);
      osc.chain(g, this.out);
      deck.detune.connect(osc.detune);
      this.oscs.push(osc);
      this.gains.push(g);
    }
    this.nextBeat = spec.stepBeats * 2;
  }

  private bell(p: number): number {
    const x = Math.sin((Math.PI * (p + 0.5)) / this.span);
    return x * x;
  }

  private freqOf(p: number): number {
    return mtof(this.deck.scale.midi(p) + this.offset);
  }

  begin(time: number): void {
    const size = this.deck.scale.size;
    for (let k = 0; k < this.oscs.length; k++) {
      const p = (k * size) % this.span;
      this.pos[k] = p;
      this.curF[k] = this.freqOf(p);
      this.curG[k] = this.bell(p);
      this.oscs[k].frequency.setValueAtTime(this.curF[k], time);
      this.gains[k].gain.setValueAtTime(0, time);
      this.gains[k].gain.linearRampToValueAtTime(this.curG[k], time + 4);
      this.oscs[k].start(time);
    }
  }

  step(_beat: number, time: number): number {
    this.s += this.spec.direction;
    const size = this.deck.scale.size;
    const glide = Math.max(0.05, this.spec.stepBeats * this.deck.spb * this.spec.glide);
    for (let k = 0; k < this.oscs.length; k++) {
      const p = (((this.s + k * size) % this.span) + this.span) % this.span;
      const f = this.freqOf(p);
      const g = this.bell(p);
      const osc = this.oscs[k].frequency;
      const gain = this.gains[k].gain;
      if (Math.abs(p - this.pos[k]) > this.span / 2) {
        // Wrap-around happens where the bell is ~silent: jump instead of gliding across the spectrum.
        osc.setValueAtTime(f, time);
        gain.setValueAtTime(g, time);
      } else {
        osc.setValueAtTime(this.curF[k], time);
        osc.exponentialRampToValueAtTime(f, time + glide);
        gain.setValueAtTime(this.curG[k], time);
        gain.linearRampToValueAtTime(g, time + glide);
      }
      this.pos[k] = p;
      this.curF[k] = f;
      this.curG[k] = g;
    }
    return _beat + this.spec.stepBeats;
  }

  protected disposeNodes(): void {
    for (let k = 0; k < this.oscs.length; k++) {
      try {
        this.deck.detune.disconnect(this.oscs[k].detune);
      } catch {
        /* already gone */
      }
      this.oscs[k].dispose();
      this.gains[k].dispose();
    }
  }
}

