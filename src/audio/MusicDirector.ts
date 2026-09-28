/**
 * Two-deck music director. The engine tells it which profile the ship is in; it crossfades
 * the decks (equal power), builds the incoming profile's instruments on demand and disposes
 * the outgoing ones once silent — at most two profiles ever exist at once.
 *
 * Scheduling runs on Tone's context "tick" (a worker-driven timer, so music keeps flowing in
 * background tabs and during render hitches) with a 0.4 s lookahead; each deck keeps its own
 * tempo so profiles with different bpm never fight over the Transport.
 */
import * as Tone from 'tone';
import { Deck } from './Deck';
import { Harmony } from './Harmony';
import type { AudioClock } from './instruments';
import { getProfile } from './profiles';
import { Scale, consonantSubset } from './scales';
import { clamp, eqPower, finite, popcount } from './util';

const LOOKAHEAD = 0.4;
const FIRST_FADE = 4;
const HURRY = 1.5; // s — fade-out of a deck that must make room for a third profile
/** Crossfade gain above which a deck's chord counts as audible for SFX consonance. */
const AUDIBLE = 0.3;

/** Harmonic context for SFX (chimes, pulse bloom, luminous chords stay in key). */
export interface HarmonySnapshot {
  /** 12-bit pitch-class mask of the sounding chord. */
  mask: number;
  bassPc: number;
  /** MIDI tonic of the profile. */
  tonic: number;
  /** Pitch-class mask of the profile's scale. */
  scaleMask: number;
  profileId: string;
}

let warned = false;

export class MusicDirector {
  private readonly clock: AudioClock = { now: 0 };
  private readonly decks: [Deck, Deck];
  private readonly ctx = Tone.getContext();
  private active = 0;
  private desired = 'void';
  /** Nothing is built until the engine has said where the ship is. */
  private hasDesired = false;
  private desiredFade = 7;
  private firstLoad = true;
  private tempoScale = 1;
  private detune = 0;
  private lastTick = -1;
  private running = false;
  private readonly chordScratch = { mask: 0, bassPc: 0 };

  constructor(dry: Tone.InputNode, wet: Tone.InputNode) {
    this.decks = [new Deck(this.clock, dry, wet), new Deck(this.clock, dry, wet)];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.now = this.ctx.currentTime;
    this.ctx.on('tick', this.onTick);
  }

  /** Requests a profile; crossfades over `fadeSeconds` once a deck is free. */
  setDesired(profileId: string, fadeSeconds = 7): void {
    this.desired = getProfile(profileId).id;
    this.desiredFade = clamp(finite(fadeSeconds, 7), 1, 20);
    this.hasDesired = true;
  }

  get desiredProfile(): string {
    return this.desired;
  }

  /** Tempo multiplier (time dilation) and global detune in cents, already smoothed by the caller. */
  setModulation(tempoScale: number, detuneCents: number): void {
    this.tempoScale = clamp(finite(tempoScale, 1), 0.3, 1.5);
    this.detune = clamp(finite(detuneCents, 0), -2400, 1200);
  }

  /**
   * Fills `out` with the chord currently sounding (falls back to the desired profile's tonic
   * chord). During a crossfade the incoming deck's chord is used, thinned to the tones that
   * don't rub against the outgoing deck while that one is still clearly audible.
   */
  harmony(out: HarmonySnapshot): void {
    const now = this.ctx.currentTime;
    const deck = this.decks[this.active].loaded ? this.decks[this.active] : this.decks[1 - this.active];
    if (deck.loaded && deck.chordAt(now, out)) {
      out.tonic = deck.profile.root;
      out.scaleMask = deck.scale.mask;
      out.profileId = deck.profile.id;
    } else {
      tonicHarmony(this.desired, out);
    }
    this.fitToAudible(out, now);
  }

  /** Tonic chord of `profileId` (a region's key), made consonant with whatever is sounding now. */
  harmonyFor(profileId: string, out: HarmonySnapshot): void {
    tonicHarmony(profileId, out);
    this.fitToAudible(out, this.ctx.currentTime);
  }

  private fitToAudible(out: HarmonySnapshot, now: number): void {
    let audible = 0;
    let loudest: Deck | null = null;
    let loudestGain = 0;
    for (const d of this.decks) {
      const g = d.loaded ? eqPower(d.fade) : 0;
      if (g < AUDIBLE || !d.chordAt(now, this.chordScratch)) continue;
      audible |= this.chordScratch.mask;
      if (g > loudestGain) {
        loudestGain = g;
        loudest = d;
      }
    }
    if (audible === 0 || loudest === null) return;
    const safe = consonantSubset(out.mask, audible);
    if (popcount(safe) >= 2) {
      out.mask = safe;
      return;
    }
    // Too little in common: sound the chord the listener is actually hearing.
    loudest.chordAt(now, out);
    out.tonic = loudest.profile.root;
    out.scaleMask = loudest.scale.mask;
    out.profileId = loudest.profile.id;
  }

  dispose(): void {
    if (this.running) this.ctx.off('tick', this.onTick);
    this.running = false;
    for (const d of this.decks) d.unload();
  }

  private readonly onTick = (): void => {
    try {
      this.tick();
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn('[audio] music scheduler error', err);
      }
    }
  };

  private tick(): void {
    const now = this.ctx.currentTime;
    this.clock.now = now;
    const dt = this.lastTick < 0 ? 0 : clamp(now - this.lastTick, 0, 0.5);
    this.lastTick = now;
    if (this.hasDesired) this.route(now);
    const horizon = now + LOOKAHEAD;
    for (const deck of this.decks) {
      if (deck.loaded && deck.tick(dt, now, horizon, this.tempoScale, this.detune)) deck.unload();
    }
  }

  private route(now: number): void {
    const a = this.decks[this.active];
    const b = this.decks[1 - this.active];
    const fade = this.desiredFade;
    if (a.loaded && a.profileId === this.desired) {
      if (a.fadeDir < 0 || (a.fadeDir === 0 && a.fade < 1)) a.fadeTo(1, fade);
      return;
    }
    if (b.loaded && b.profileId === this.desired) {
      // Changed our mind mid-crossfade: bring the outgoing deck back.
      b.fadeTo(1, fade);
      if (a.loaded) a.fadeTo(-1, outFade(a, fade));
      this.active = 1 - this.active;
      return;
    }
    if (!a.loaded) {
      a.load(getProfile(this.desired), now + 0.12, this.tempoScale, this.detune);
      a.fadeTo(1, this.firstLoad ? FIRST_FADE : fade);
      this.firstLoad = false;
      return;
    }
    if (!b.loaded) {
      b.load(getProfile(this.desired), now + 0.12, this.tempoScale, this.detune);
      b.fadeTo(1, fade);
      a.fadeTo(-1, outFade(a, fade));
      this.active = 1 - this.active;
      return;
    }
    // Both decks busy (the idle one still fading out another profile): hurry it along; the
    // desired profile loads into it as soon as it is silent and unloaded.
    if (!b.leaving || b.fadeRate < 1 / HURRY) b.fadeTo(-1, HURRY);
  }
}

/**
 * Seconds to pass to fadeTo(-1) so a deck that is only partly up leaves over the same span
 * as the incoming deck rises (a full-rate fade from a lower level would dip the mix).
 */
function outFade(deck: Deck, seconds: number): number {
  return seconds / Math.max(deck.fade, 0.1);
}

/** Tonic chord of a profile (used before any deck plays and for the wormhole-exit chord). */
export function tonicHarmony(profileId: string, out: HarmonySnapshot): void {
  const p = getProfile(profileId);
  const scale = new Scale(p.root, p.scale);
  const h = new Harmony(p, scale);
  out.mask = h.chordMask(0);
  out.bassPc = ((p.root % 12) + 12) % 12;
  out.tonic = p.root;
  out.scaleMask = scale.mask;
  out.profileId = p.id;
}
