/**
 * Chord timeline for one deck, generated ahead of the scheduler so melodic layers can
 * plan whole phrases against the chords they will actually sound over.
 * Beats are the deck's musical time; chords last `barsPerChord` bars (random within range)
 * and follow the profile's Markov graph.
 */
import type { ProfileDef } from './profiles';
import { Scale, pc, pcBit } from './scales';
import { pick, randInt } from './util';

const SLOTS = 12;

export class Harmony {
  private readonly start = new Float64Array(SLOTS);
  private readonly end = new Float64Array(SLOTS);
  private readonly chord = new Int16Array(SLOTS);
  private readonly masks = new Int32Array(SLOTS);
  private readonly bass = new Int8Array(SLOTS);
  private head = -1;
  private count = 0;
  private until = 0;
  private current = 0;

  constructor(
    private readonly profile: ProfileDef,
    private readonly scale: Scale,
  ) {}

  /** MIDI notes of chord `index` as authored (scale degrees + alterations). */
  chordMidis(index: number, out: Int16Array): number {
    const c = this.profile.chords[index];
    if (!c) return 0;
    const n = Math.min(out.length, c.d.length);
    for (let i = 0; i < n; i++) out[i] = this.scale.midi(c.d[i]) + (c.alt?.[i] ?? 0);
    return n;
  }

  /** Pitch-class mask of chord `index`. */
  chordMask(index: number): number {
    const c = this.profile.chords[index];
    if (!c) return this.scale.mask;
    let m = 0;
    for (let i = 0; i < c.d.length; i++) m |= pcBit(this.scale.midi(c.d[i]) + (c.alt?.[i] ?? 0));
    return m;
  }

  /** Makes sure chords are decided up to (and past) `beat`. */
  ensure(beat: number): void {
    let guard = 0;
    while (this.until <= beat && guard++ < SLOTS) this.push();
  }

  private push(): void {
    const chords = this.profile.chords;
    let idx = 0;
    if (this.count > 0) {
      const next = chords[this.current]?.next;
      idx = next && next.length > 0 ? pick(next) : 0;
      if (idx < 0 || idx >= chords.length) idx = 0;
    }
    const [minBars, maxBars] = this.profile.barsPerChord;
    const len = Math.max(1, randInt(minBars, maxBars)) * this.profile.beatsPerBar;
    const s = (this.head = (this.head + 1) % SLOTS);
    this.start[s] = this.until;
    this.end[s] = this.until + len;
    this.chord[s] = idx;
    this.masks[s] = this.chordMask(idx);
    const c = chords[idx];
    this.bass[s] = c ? pc(this.scale.midi(c.d[0]) + (c.alt?.[0] ?? 0)) : pc(this.scale.root);
    this.until += len;
    this.current = idx;
    if (this.count < SLOTS) this.count++;
  }

  /** Slot containing `beat` (the oldest known slot if the beat predates the ring). */
  slotAt(beat: number): number {
    if (this.count === 0) this.ensure(beat);
    let s = this.head;
    for (let k = 0; k < this.count; k++) {
      s = (this.head - k + SLOTS) % SLOTS;
      if (this.start[s] <= beat + 1e-6) return s;
    }
    return s;
  }

  slotStart(slot: number): number {
    return this.start[slot];
  }
  slotEnd(slot: number): number {
    return this.end[slot];
  }
  slotChord(slot: number): number {
    return this.chord[slot];
  }
  slotMask(slot: number): number {
    return this.masks[slot];
  }
  slotBassPc(slot: number): number {
    return this.bass[slot];
  }

  maskAt(beat: number): number {
    return this.masks[this.slotAt(beat)];
  }
  bassPcAt(beat: number): number {
    return this.bass[this.slotAt(beat)];
  }
}
