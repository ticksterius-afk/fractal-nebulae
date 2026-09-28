/**
 * Generative melodic layers. Each style plans a phrase (notes + trailing rest) against the
 * deck's chord timeline, then the scheduler plays it note by note. The rules echo the
 * mathematics of each fractal:
 *
 *  arp8     Mandelbulb   8-step chord arpeggio (power 8) that mutates cycle by cycle
 *  walk     —            call & response: a phrase, then its answer a step away, resolving home
 *  cantor   Menger       27 triplet steps with the middle thirds removed (Cantor set rhythm)
 *  halving  Sierpiński   Pascal's triangle mod 2 as a rhythm, replayed at 1, ½ and ¼ scale
 *  golden   Apollonian   Fibonacci-word timing (long = φ × short): quasi-periodic, never repeats
 *  canon    Kleinian     canon at the octave/third, then retrograde, then inversion (reflections)
 *  fork     Tree         a line that splits into two branches moving apart, then rejoins
 *  crystal  KIFS         six-note arpeggio mirrored back down (snowflake symmetry)
 *  gliss    Julia        harp glissandi through whole-tone steps
 *  bells / toll / sparkle   sparse distant bells, deep tolls, high shimmering glints
 */
import * as Tone from 'tone';
import { VoicePool } from './instruments';
import { type DeckBus, type DeckContext, Layer } from './layers';
import type { MotifSpec, MotifStyle } from './profiles';
import { foldInto, lowestWithPc, rubs, snapToChord, tonesInRange } from './scales';
import { PHI, chance, clamp, clamp01, human, lerp, pick, popcount, rand, randInt } from './util';

const CAP = 64;

/** Fixed-capacity note list (structure of arrays; no allocation while playing). */
class Phrase {
  readonly beat = new Float64Array(CAP);
  readonly midi = new Int16Array(CAP);
  readonly dur = new Float32Array(CAP);
  readonly vel = new Float32Array(CAP);
  readonly voice = new Uint8Array(CAP);
  count = 0;
  idx = 0;

  clear(): void {
    this.count = 0;
    this.idx = 0;
  }

  push(beat: number, midi: number, dur: number, vel: number, voice = 0): void {
    if (this.count >= CAP || !Number.isFinite(beat) || !Number.isFinite(midi)) return;
    const i = this.count++;
    this.beat[i] = beat;
    this.midi[i] = midi;
    this.dur[i] = dur;
    this.vel[i] = vel;
    this.voice[i] = voice;
  }

  /** Stable insertion sort by beat. */
  sort(): void {
    for (let i = 1; i < this.count; i++) {
      const b = this.beat[i];
      const m = this.midi[i];
      const d = this.dur[i];
      const v = this.vel[i];
      const vo = this.voice[i];
      let j = i - 1;
      while (j >= 0 && this.beat[j] > b) {
        this.beat[j + 1] = this.beat[j];
        this.midi[j + 1] = this.midi[j];
        this.dur[j + 1] = this.dur[j];
        this.vel[j + 1] = this.vel[j];
        this.voice[j + 1] = this.voice[j];
        j--;
      }
      this.beat[j + 1] = b;
      this.midi[j + 1] = m;
      this.dur[j + 1] = d;
      this.vel[j + 1] = v;
      this.voice[j + 1] = vo;
    }
  }
}

/**
 * Voice caps per style (pools grow on demand). The fast bell styles get room for their tails
 * to ring out under the next notes instead of being choked by voice stealing.
 */
const POOL_SIZE: Record<MotifStyle, number> = {
  arp8: 4,
  walk: 3,
  cantor: 4,
  halving: 7,
  golden: 5,
  canon: 3,
  fork: 4,
  crystal: 8,
  gliss: 8,
  bells: 3,
  toll: 3,
  sparkle: 3,
};

// Scale-degree step tables for the random walks (repeats = weight).
const WALK_STEPS = [1, -1, 1, -1, 2, -2, 1, -1, 3, -2] as const;
const GOLDEN_STEPS = [5, -5, 5, -5, 2, -2, 1, -1, 3, -3] as const;
const CANON_STEPS = [1, -1, 2, -2, 1, -1, 3, -3] as const;
const FORK_STEPS = [1, -1, 2, -2, 1, -1] as const;
const NEIGHBOURS = [1, -1, 2, -2] as const;
// Rhythm / choice tables (repeats = weight).
const RESPONSE_SHIFT = [-2, 2, -1] as const;
const WALK_DUR = [1, 0.5, 1, 1.5, 0.5] as const;
const WALK_END_DUR = [2, 1.5, 2] as const;
const ONE_OR_TWO = [1, 2] as const;
const HALF_OR_ONE = [0.5, 1] as const;
/** Pascal-triangle rows used by the halving rhythm (their odd entries form the pattern). */
const PASCAL_ROWS = [3, 5, 6, 7, 5, 3, 4, 6] as const;
const HALVING_INTERVALS = [0, 7, 12, 19, 24] as const;
const FIB_LENGTHS = [5, 8, 5, 8, 13] as const;
const GOLDEN_RESTS = [2 * PHI, 3 * PHI, 2 * PHI * PHI] as const;
const CANON_DUR = [1, 1, 0.5, 1.5, 2, 0.5] as const;
const CANON_DELAY = [2, 2, 3, 4] as const;
const FORK_TRUNK_DUR = [1, 0.5, 1, 1.5] as const;
const FORK_BRANCH_DUR = [0.5, 1, 0.5] as const;
const FORK_SPREAD = [1, 2, 1] as const;
const BELL_ANSWER = [1.5, 2, 3] as const;
const SPARKLE_GAPS = [0.25, 0.5, 0.75] as const;
/** Mandelbulb arpeggio: chord-tone indices of the 8 steps (power 8). */
const ARP8_BASE = [0, 2, 1, 3, 2, 4, 3, 5] as const;

/** Fibonacci word: 1 = long, 0 = short (Sturmian sequence with slope 1/φ). */
const fibWord = (n: number): number => Math.floor((n + 2) / PHI) - Math.floor((n + 1) / PHI);

/** True if `i`'s base-3 digits contain no 1 (i survives the Cantor construction). */
function cantorOn(i: number): boolean {
  for (let x = i; x > 0; x = Math.floor(x / 3)) if (x % 3 === 1) return false;
  return true;
}
function countTwos(i: number): number {
  let c = 0;
  for (let x = i; x > 0; x = Math.floor(x / 3)) if (x % 3 === 2) c++;
  return c;
}

export class MotifLayer extends Layer {
  private readonly pools: VoicePool[] = [];
  private readonly panners: Tone.Panner[] = [];
  private readonly phrase = new Phrase();
  private readonly tones = new Int16Array(48);
  private readonly lo: number;
  private readonly hi: number;
  private readonly restScale: number;
  private phraseEnd: number;
  private lastDeg = Number.NaN;
  // arp8
  private readonly arp = new Int8Array(8);
  private arpReady = false;
  private arpRun = 0;
  private arpRunLen = 3;
  // walk (call & response)
  private readonly callDeg = new Int16Array(12);
  private readonly callDur = new Float32Array(12);
  private callLen = 0;
  private responseDue = false;
  // halving
  private level = 0;
  private row = 5;
  // golden
  private fib = 0;
  // canon
  private readonly canonDeg = new Int16Array(12);
  private readonly canonDur = new Float32Array(12);
  private canonLen = 0;
  private canonPhase = 0;

  constructor(
    deck: DeckContext,
    private readonly spec: MotifSpec,
    bus: DeckBus,
  ) {
    super(deck, spec, bus);
    this.lo = spec.register[0];
    this.hi = Math.max(spec.register[1], spec.register[0] + 12);
    const size = POOL_SIZE[spec.style];
    if (spec.voice2) {
      const a = new Tone.Panner(-0.35);
      const b = new Tone.Panner(0.35);
      a.connect(this.out);
      b.connect(this.out);
      this.panners.push(a, b);
      this.pools.push(new VoicePool(spec.voice, size, a, deck.clock, deck.detune));
      this.pools.push(new VoicePool(spec.voice2, size, b, deck.clock, deck.detune));
    } else {
      this.pools.push(new VoicePool(spec.voice, size, this.out, deck.clock, deck.detune));
    }
    this.restScale = lerp(1.8, 0.6, clamp01(spec.density));
    this.phraseEnd = Math.max(0, ((spec.startBar ?? 1) - 1) * deck.profile.beatsPerBar);
    this.nextBeat = this.phraseEnd;
  }

  step(beat: number, _time: number): number {
    const ph = this.phrase;
    for (let guard = 0; guard < 4; guard++) {
      while (ph.idx < ph.count && ph.beat[ph.idx] <= beat + 1e-6) {
        const i = ph.idx++;
        const pool = this.pools[Math.min(ph.voice[i], this.pools.length - 1)];
        const t = this.deck.beatToTime(ph.beat[i]) + (Math.random() - 0.5) * 0.012;
        pool.play(ph.midi[i], t, ph.dur[i] * this.deck.spb, ph.vel[i]);
      }
      if (ph.idx < ph.count) return ph.beat[ph.idx];
      if (this.phraseEnd > beat + 1e-6) return this.phraseEnd;
      const start = Math.max(this.phraseEnd, beat);
      ph.clear();
      this.phraseEnd = Math.max(start + 0.5, this.generate(start));
      ph.sort();
    }
    return beat + 1;
  }

  private generate(start: number): number {
    switch (this.spec.style) {
      case 'arp8':
        return this.genArp8(start);
      case 'walk':
        return this.genWalk(start);
      case 'cantor':
        return this.genCantor(start);
      case 'halving':
        return this.genHalving(start);
      case 'golden':
        return this.genGolden(start);
      case 'canon':
        return this.genCanon(start);
      case 'fork':
        return this.genFork(start);
      case 'crystal':
        return this.genCrystal(start);
      case 'gliss':
        return this.genGliss(start);
      case 'bells':
        return this.genBells(start);
      case 'toll':
        return this.genToll(start);
      case 'sparkle':
        return this.genSparkle(start);
    }
  }

  // ---- helpers ------------------------------------------------------------------------------

  private chordTones(beat: number, lo = this.lo, hi = this.hi): number {
    return tonesInRange(this.deck.harmony.maskAt(beat), lo, hi, this.tones);
  }

  private fold(m: number): number {
    return foldInto(m, this.lo, this.hi);
  }

  /** Keeps a melodic note consonant with the chord sounding at `beat`. */
  private resolve(midi: number, beat: number, strong: boolean): number {
    const mask = this.deck.harmony.maskAt(beat);
    let m = midi;
    if (strong) {
      m = snapToChord(mask, m);
    } else if (rubs(mask, m) || !this.deck.scale.contains(m)) {
      const mel = this.deck.melody;
      const d = mel.degreeNear(m);
      let found = false;
      for (const off of NEIGHBOURS) {
        const c = mel.midi(d + off);
        if (!rubs(mask, c) && this.deck.scale.contains(c)) {
          m = c;
          found = true;
          break;
        }
      }
      if (!found) m = snapToChord(mask, m);
    }
    return this.fold(m);
  }

  /** One step of a contour-shaped random walk in melody degrees, kept inside the register. */
  private walk(deg: number, i: number, n: number, table: readonly number[]): number {
    const mel = this.deck.melody;
    let s = pick(table);
    const rising = i < n / 2;
    if (rising && s < 0 && chance(0.35)) s = -s;
    if (!rising && s > 0 && chance(0.35)) s = -s;
    const m = mel.midi(deg + s);
    if (m > this.hi - 1) s = -Math.abs(s);
    else if (m < this.lo + 1) s = Math.abs(s);
    return deg + s;
  }

  private startDeg(fraction: number): number {
    const mel = this.deck.melody;
    if (Number.isFinite(this.lastDeg)) {
      const m = mel.midi(this.lastDeg);
      if (m >= this.lo && m <= this.hi) return this.lastDeg;
    }
    return mel.degreeNear(lerp(this.lo, this.hi, fraction));
  }

  private isStrong(beat: number): boolean {
    const r = Math.round(beat);
    return Math.abs(beat - r) < 1e-6 && r % 2 === 0;
  }

  private get vel(): number {
    return this.spec.vel;
  }

  // ---- styles -------------------------------------------------------------------------------

  private genArp8(start: number): number {
    const stepB = 0.5;
    const ph = this.phrase;
    if (!this.arpReady) {
      for (let j = 0; j < 8; j++) this.arp[j] = j === 0 || chance(0.35 + 0.6 * this.spec.density) ? ARP8_BASE[j] : -1;
      this.arpReady = true;
    } else if (chance(0.45)) {
      const j = randInt(1, 7);
      this.arp[j] = chance(0.3) ? -1 : randInt(0, 6);
    }
    // Cycles come in runs (a phrase that swells and fades) separated by breaths.
    if (this.arpRun >= this.arpRunLen) {
      this.arpRun = 0;
      this.arpRunLen = randInt(2, 3 + Math.round(2 * this.spec.density));
      return start + rand(4, 8) * this.restScale;
    }
    const shape = 0.78 + 0.28 * Math.sin((Math.PI * (this.arpRun + 0.5)) / this.arpRunLen);
    this.arpRun++;
    const lift = chance(0.2) ? 2 : 0;
    for (let j = 0; j < 8; j++) {
      if (this.arp[j] < 0) continue;
      const b = start + j * stepB;
      const n = this.chordTones(b);
      if (n === 0) continue;
      const idx = Math.min(n - 1, this.arp[j] + lift);
      ph.push(b, this.tones[idx], j % 2 === 0 ? 1.2 : 0.8, human(this.vel * shape * (j % 4 === 0 ? 1 : 0.72)));
    }
    return start + 8 * stepB;
  }

  private genWalk(start: number): number {
    const mel = this.deck.melody;
    const ph = this.phrase;
    if (this.responseDue && this.callLen > 0) {
      this.responseDue = false;
      const shift = pick(RESPONSE_SHIFT);
      let b = start;
      for (let i = 0; i < this.callLen; i++) {
        const last = i === this.callLen - 1;
        let m = mel.midi(this.callDeg[i] + shift);
        if (last) {
          const bass = this.deck.harmony.bassPcAt(b);
          const home = lowestWithPc(bass, m - 6);
          m = this.fold(home);
        } else {
          m = this.resolve(m, b, this.callDur[i] >= 1);
        }
        ph.push(b, m, this.callDur[i] * 1.1, human(this.vel * (last ? 0.8 : 0.9)));
        b += this.callDur[i];
      }
      return b + rand(4, 8) * this.restScale;
    }
    const n = randInt(4, 6);
    let deg = this.startDeg(0.45);
    let b = start;
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      const dur = last ? pick(WALK_END_DUR) : pick(WALK_DUR);
      deg = this.walk(deg, i, n, WALK_STEPS);
      const m = this.resolve(mel.midi(deg), b, last || this.isStrong(b));
      deg = mel.degreeNear(m);
      this.callDeg[i] = deg;
      this.callDur[i] = dur;
      ph.push(b, m, dur * 1.1, human(this.vel));
      b += dur;
    }
    this.callLen = n;
    this.lastDeg = deg;
    this.responseDue = chance(0.75);
    return b + (this.responseDue ? rand(1, 2) : rand(4, 8) * this.restScale);
  }

  private genCantor(start: number): number {
    const mel = this.deck.melody;
    const ph = this.phrase;
    const steps = chance(0.35) ? 9 : 27;
    const stepB = 1 / 3;
    const n = this.chordTones(start, this.lo, lerp(this.lo, this.hi, 0.6));
    const base = n > 0 ? this.tones[randInt(0, n - 1)] : this.lo + 5;
    const d0 = mel.degreeNear(base);
    const dir = chance(0.7) ? 1 : -1;
    const lift = chance(0.4) ? 12 : 0;
    for (let i = 0; i < steps; i++) {
      if (!cantorOn(i)) continue;
      const twos = countTwos(i);
      const b = start + i * stepB;
      let m = mel.midi(d0 + dir * (twos % 3));
      if (i >= 18) m += lift;
      ph.push(b, this.resolve(m, b, i === 0), 0.9, human(this.vel * (1 - 0.1 * twos)));
    }
    const bars = Math.max(1, Math.round(pick(ONE_OR_TWO) * this.restScale));
    return start + steps * stepB + bars * this.deck.profile.beatsPerBar;
  }

  private genHalving(start: number): number {
    const ph = this.phrase;
    const level = this.level;
    const stepB = level === 0 ? 1 : level === 1 ? 0.5 : 0.25;
    if (level === 0) this.row = pick(PASCAL_ROWS);
    for (let j = 0; j < 8; j++) {
      if ((j & this.row) !== j) continue; // Lucas: C(row, j) is odd
      const b = start + j * stepB;
      const h = this.deck.harmony;
      const mask = h.maskAt(b);
      const root = lowestWithPc(h.bassPcAt(b), this.lo);
      const k = Math.min(HALVING_INTERVALS.length - 1, popcount(j) + (level === 2 ? 1 : 0));
      let m = root + HALVING_INTERVALS[k];
      if (HALVING_INTERVALS[k] % 12 === 7 && (!this.deck.scale.contains(m) || rubs(mask, m))) m += 5; // fifth → octave
      const v = this.vel * (0.95 - 0.12 * popcount(j)) * (level === 2 ? 0.75 : 1);
      ph.push(b, this.fold(m), Math.max(stepB * 1.6, 0.75), human(v));
    }
    const end = start + 8 * stepB;
    this.level = (level + 1) % 3;
    return end + (this.level === 0 ? rand(4, 8) * this.restScale : 0);
  }

  private genGolden(start: number): number {
    const mel = this.deck.melody;
    const ph = this.phrase;
    const U = 0.5;
    const n = pick(FIB_LENGTHS);
    let deg = this.startDeg(0.4);
    let b = start;
    let lastMidi = mel.midi(deg);
    for (let i = 0; i < n; i++) {
      const long = fibWord(this.fib++) === 1;
      const ioi = long ? U * PHI : U;
      deg = this.walk(deg, i, n, GOLDEN_STEPS);
      const m = this.resolve(mel.midi(deg), b, long);
      deg = mel.degreeNear(m);
      lastMidi = m;
      ph.push(b, m, ioi * 1.8, human(this.vel * (long ? 1 : 0.72)));
      b += ioi;
    }
    this.lastDeg = deg;
    if (chance(0.25 + 0.35 * this.spec.density)) {
      // Pearly bubbles: a quick rising figure above the last note.
      const nt = this.chordTones(b, lastMidi + 3, this.hi + 7);
      let bb = b;
      for (let k = 0; k < Math.min(3, nt); k++) {
        ph.push(bb, this.tones[k], 0.6, human(this.vel * (0.45 - 0.08 * k)));
        bb += U / (PHI * PHI);
      }
      b = bb;
    }
    return b + pick(GOLDEN_RESTS) * this.restScale;
  }

  private genCanon(start: number): number {
    const mel = this.deck.melody;
    const ph = this.phrase;
    const phase = this.canonPhase % 3;
    this.canonPhase++;
    if (phase === 0 || this.canonLen === 0) {
      const n = randInt(5, 7);
      let deg = mel.degreeNear(lerp(this.lo, this.hi, 0.3));
      for (let i = 0; i < n; i++) {
        deg = this.walk(deg, i, n, CANON_STEPS);
        this.canonDeg[i] = deg;
        this.canonDur[i] = pick(CANON_DUR);
      }
      this.canonLen = n;
    } else if (phase === 1) {
      // Retrograde: the phrase seen in a mirror of time.
      for (let i = 0, j = this.canonLen - 1; i < j; i++, j--) {
        const d = this.canonDeg[i];
        this.canonDeg[i] = this.canonDeg[j];
        this.canonDeg[j] = d;
        const t = this.canonDur[i];
        this.canonDur[i] = this.canonDur[j];
        this.canonDur[j] = t;
      }
    } else {
      // Inversion: mirrored in pitch around the first note.
      const d0 = this.canonDeg[0];
      for (let i = 0; i < this.canonLen; i++) this.canonDeg[i] = 2 * d0 - this.canonDeg[i];
    }
    const delay = pick(CANON_DELAY);
    const trans = (chance(2 / 3) ? mel.size : 2);
    let b = start;
    for (let i = 0; i < this.canonLen; i++) {
      const strong = i === 0 || i === this.canonLen - 1 || this.canonDur[i] >= 1.5;
      const dur = this.canonDur[i];
      ph.push(b, this.resolve(mel.midi(this.canonDeg[i]), b, strong), dur * 1.2, human(this.vel), 0);
      const bf = b + delay;
      ph.push(bf, this.resolve(mel.midi(this.canonDeg[i] + trans), bf, strong), dur * 1.2, human(this.vel * 0.75), 1);
      b += dur;
    }
    return b + delay * 0.5 + rand(2, 4) * this.restScale;
  }

  private genFork(start: number): number {
    const mel = this.deck.melody;
    const ph = this.phrase;
    let deg = this.startDeg(0.5);
    let b = start;
    const trunk = randInt(2, 4);
    for (let i = 0; i < trunk; i++) {
      const dur = pick(FORK_TRUNK_DUR);
      deg = this.walk(deg, i, trunk + 4, FORK_STEPS);
      const m = this.resolve(mel.midi(deg), b, dur >= 1);
      deg = mel.degreeNear(m);
      ph.push(b, m, dur * 1.1, human(this.vel), 0);
      b += dur;
    }
    // The branch: two voices moving apart (contrary motion), landing on chord tones.
    const m = randInt(3, 4);
    const dur = pick(FORK_BRANCH_DUR);
    const offset = chance(0.5) ? dur / 2 : 0;
    let dA = deg;
    let dB = deg;
    for (let i = 0; i < m; i++) {
      const last = i === m - 1;
      dA += pick(FORK_SPREAD);
      dB -= pick(FORK_SPREAD);
      const hold = last ? 2.5 : dur * 1.3;
      ph.push(b, this.resolve(mel.midi(dA), b, last), hold, human(this.vel * 0.85), 0);
      ph.push(b + offset, this.resolve(mel.midi(dB), b + offset, last), hold, human(this.vel * 0.75), 1);
      b += dur;
    }
    b += 1.5;
    let next = chance(0.5) ? dA : dB;
    if (chance(0.4)) {
      // The lightning keeps going from one branch.
      const k = randInt(2, 3);
      for (let i = 0; i < k; i++) {
        const d2 = pick(HALF_OR_ONE);
        next = this.walk(next, i, k, FORK_STEPS);
        ph.push(b, this.resolve(mel.midi(next), b, i === k - 1), d2 * 1.2, human(this.vel * 0.7), chance(0.5) ? 0 : 1);
        b += d2;
      }
    }
    this.lastDeg = next;
    return b + rand(2, 5) * this.restScale;
  }

  private genCrystal(start: number): number {
    const ph = this.phrase;
    const n = this.chordTones(start);
    if (n < 3) return start + 4;
    const chordEnd = this.deck.harmony.slotEnd(this.deck.harmony.slotAt(start));
    const step = chance(0.3) ? 1 / 3 : 1 / 4;
    const len = Math.min(6, n);
    const first = randInt(0, Math.max(0, Math.min(n - len, Math.floor(n / 2))));
    let b = start;
    for (let i = 0; i < len && b < chordEnd; i++) {
      ph.push(b, this.tones[first + i], 1.5, human(this.vel * (0.65 + (0.35 * i) / (len - 1))));
      b += step;
    }
    for (let i = len - 2; i >= 0 && b < chordEnd; i--) {
      ph.push(b, this.tones[first + i], 1.2, human(this.vel * (0.55 + (0.3 * i) / (len - 1))));
      b += step;
    }
    if (chance(0.55) && b + step < chordEnd) {
      const top = this.tones[first + len - 1] + 12;
      if (top <= this.hi + 7) ph.push(b + step, top, 2.5, human(this.vel * 0.5));
      b += step * 2;
    }
    return b + rand(3, 8) * this.restScale;
  }

  private genGliss(start: number): number {
    const mel = this.deck.melody;
    const ph = this.phrase;
    const up = chance(0.72);
    const n = randInt(7, 12);
    const step = chance(0.5) ? 1 / 8 : 1 / 6;
    const nt = this.chordTones(start);
    if (nt === 0) return start + 4;
    const startMidi = up ? this.tones[randInt(0, Math.min(2, nt - 1))] : this.tones[Math.max(0, nt - 1 - randInt(0, 2))];
    const mask = this.deck.harmony.maskAt(start);
    let deg = mel.degreeNear(startMidi);
    let b = start;
    let lastMidi = startMidi;
    for (let i = 0; i < n; i++) {
      const m = mel.midi(deg);
      if (m > this.hi + 2 || m < this.lo - 2) break;
      if (!rubs(mask, m)) {
        const env = Math.sin((Math.PI * (i + 0.5)) / n);
        ph.push(b, m, 1.6, human(this.vel * (0.35 + 0.65 * env)));
        lastMidi = m;
      }
      deg += up ? 1 : -1;
      b += step;
    }
    const land = this.fold(snapToChord(mask, lastMidi + (up ? 2 : -2)));
    ph.push(b + step, land, 3, human(this.vel * 0.6));
    b += 1;
    if (chance(0.35)) {
      // Two slow high notes answer the glissando.
      const n2 = this.chordTones(b + 2, (this.lo + this.hi) / 2, this.hi);
      if (n2 >= 2) {
        ph.push(b + 2, this.tones[randInt(0, n2 - 1)], 2.5, human(this.vel * 0.45));
        ph.push(b + 3.5, this.tones[randInt(0, n2 - 1)], 3, human(this.vel * 0.4));
        b += 3.5;
      }
    }
    return b + rand(4, 10) * this.restScale;
  }

  private genBells(start: number): number {
    const ph = this.phrase;
    if (!chance(clamp(0.35 + this.spec.density * 0.6, 0, 0.95))) return start + rand(4, 10);
    const n = this.chordTones(start);
    if (n === 0) return start + 4;
    const a = randInt(0, n - 1);
    ph.push(start, this.tones[a], 4, human(this.vel, 0.15));
    if (n > 1 && chance(0.5)) {
      const second = this.tones[(a + randInt(1, 2)) % n];
      const b = start + pick(BELL_ANSWER);
      ph.push(b, this.resolve(second, b, true), 4, human(this.vel * 0.7, 0.15));
    }
    return start + rand(6, 14) * this.restScale;
  }

  private genToll(start: number): number {
    const ph = this.phrase;
    let m = lowestWithPc(this.deck.harmony.bassPcAt(start), this.lo);
    if (m > this.hi) m -= 12;
    const k = chance(0.5) ? 1 : chance(0.6) ? 2 : 3;
    for (let i = 0; i < k; i++) ph.push(start + i * 2, m, 3, human(this.vel * (1 - 0.18 * i), 0.06));
    return start + rand(10, 22) * this.restScale;
  }

  private genSparkle(start: number): number {
    const ph = this.phrase;
    const k = randInt(1, 3);
    let b = start;
    for (let i = 0; i < k; i++) {
      const n = this.chordTones(b);
      if (n === 0) break;
      ph.push(b, this.tones[randInt(0, n - 1)], rand(1, 2), this.vel * rand(0.6, 1));
      b += pick(SPARKLE_GAPS);
    }
    return b + clamp(-Math.log(1 - Math.random()) * 5 * this.restScale, 2, 14);
  }

  protected disposeNodes(): void {
    for (const p of this.pools) p.dispose();
    for (const p of this.panners) p.dispose();
  }
}
