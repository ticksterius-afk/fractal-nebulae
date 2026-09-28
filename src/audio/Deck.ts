/**
 * One of the MusicDirector's two decks. A deck plays one profile: it owns the profile's
 * instruments (built on load, disposed on unload), its chord timeline, a tempo-synced
 * ping-pong echo and a private musical clock.
 *
 * Clock: beat ↔ audio-time is a linear map around an anchor. Tempo changes (time dilation)
 * re-anchor at the furthest time already scheduled, so the map stays continuous and nothing
 * already queued moves. Each deck keeps its own tempo, so two profiles with different bpm can
 * crossfade without either drifting.
 */
import * as Tone from 'tone';
import { Harmony } from './Harmony';
import { Glide } from './control';
import type { AudioClock } from './instruments';
import { type DeckBus, type DeckContext, DroneLayer, Layer, PadLayer, PulseLayer, ShepardLayer, TextureLayer } from './layers';
import { MotifLayer } from './motifs';
import type { LayerSpec, ProfileDef } from './profiles';
import { Scale } from './scales';
import { clamp, dbToGain, eqPower, finite } from './util';

const HARMONY_AHEAD = 24; // beats of chords decided beyond the scheduling horizon
const MAX_EVENTS_PER_TICK = 48;

let warned = false;
function warnOnce(what: string, err: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(`[audio] ${what}`, err);
}

function createLayer(spec: LayerSpec, deck: DeckContext, bus: DeckBus): Layer {
  switch (spec.kind) {
    case 'pad':
      return new PadLayer(deck, spec, bus);
    case 'drone':
      return new DroneLayer(deck, spec, bus);
    case 'texture':
      return new TextureLayer(deck, spec, bus);
    case 'pulse':
      return new PulseLayer(deck, spec, bus);
    case 'shepard':
      return new ShepardLayer(deck, spec, bus);
    case 'motif':
      return new MotifLayer(deck, spec, bus);
  }
}

interface DeckNodes {
  dry: Tone.Gain;
  wet: Tone.Gain;
  echo: Tone.PingPongDelay;
  echoTone: Tone.Filter;
  echoRet: Tone.Gain;
  echoWet: Tone.Gain;
  detune: Tone.Signal<'cents'>;
  /** Anchored ramps: a bare linearRamp after a long hold would start from the last event. */
  echoTime: Glide;
  pitch: Glide;
}

export class Deck implements DeckContext {
  // DeckContext (valid while loaded)
  profile!: ProfileDef;
  scale!: Scale;
  melody!: Scale;
  harmony!: Harmony;
  detune!: Tone.Signal<'cents'>;
  spb = 1;
  pitchFactor = 1;

  loaded = false;
  /** 0..1 crossfade position (gain = sin(fade·π/2)). */
  fade = 0;
  /** +1 fading in, −1 fading out, 0 holding. */
  fadeDir = 0;
  fadeRate = 1 / 7;

  private nodes: DeckNodes | null = null;
  private layers: Layer[] = [];
  private anchorTime = 0;
  private anchorBeat = 0;
  private scheduledUntil = 0;
  private zeroAt = -1;
  private detuneSent = 0;
  private trim = 1;

  constructor(
    readonly clock: AudioClock,
    private readonly dryOut: Tone.InputNode,
    private readonly wetOut: Tone.InputNode,
  ) {}

  get profileId(): string | null {
    return this.loaded ? this.profile.id : null;
  }

  beatToTime(beat: number): number {
    return this.anchorTime + (beat - this.anchorBeat) * this.spb;
  }

  timeToBeat(time: number): number {
    return this.anchorBeat + (time - this.anchorTime) / this.spb;
  }

  /** Builds the profile's instruments and starts its clock at `startTime` (silent until faded in). */
  load(profile: ProfileDef, startTime: number, tempoScale: number, detuneCents: number): void {
    if (this.loaded) this.unload();
    this.profile = profile;
    this.scale = new Scale(profile.root, profile.scale);
    this.melody = new Scale(profile.root, profile.melody ?? profile.scale);
    this.harmony = new Harmony(profile, this.scale);
    this.spb = 60 / (profile.bpm * clamp(tempoScale, 0.2, 2));
    this.detuneSent = finite(detuneCents, 0);
    this.pitchFactor = Math.pow(2, this.detuneSent / 1200);
    this.trim = dbToGain(clamp(finite(profile.trim ?? 0, 0), -24, 12));

    const dry = new Tone.Gain(0);
    const wet = new Tone.Gain(0);
    dry.connect(this.dryOut);
    wet.connect(this.wetOut);
    const echo = new Tone.PingPongDelay({
      delayTime: this.echoTime(),
      feedback: clamp(profile.echo.feedback, 0, 0.7),
      wet: 1,
      maxDelay: 4,
    });
    const echoTone = new Tone.Filter({ type: 'lowpass', frequency: 3200, rolloff: -12, Q: 0.5 });
    const echoRet = new Tone.Gain(0.55);
    const echoWet = new Tone.Gain(0.6);
    echo.chain(echoTone, echoRet, dry);
    echoRet.connect(echoWet);
    echoWet.connect(wet);
    const detune = new Tone.Signal({ value: this.detuneSent, units: 'cents' });
    // Pin automation start points at "now" so the first ramps don't interpolate from t = 0.
    const now = this.clock.now;
    dry.gain.setValueAtTime(0, now);
    wet.gain.setValueAtTime(0, now);
    const echoTime = new Glide(echo.delayTime, this.echoTime(), 0);
    const pitch = new Glide(detune, this.detuneSent, 0);
    echoTime.jump(this.echoTime(), now);
    pitch.jump(this.detuneSent, now);
    this.detune = detune;
    this.nodes = { dry, wet, echo, echoTone, echoRet, echoWet, detune, echoTime, pitch };

    const bus: DeckBus = { dry, wet, echo };
    this.layers = [];
    for (const spec of profile.layers) {
      try {
        this.layers.push(createLayer(spec, this, bus));
      } catch (err) {
        warnOnce(`layer "${spec.kind}" of profile "${profile.id}" failed to build`, err);
      }
    }

    this.anchorTime = startTime;
    this.anchorBeat = 0;
    this.scheduledUntil = startTime;
    this.harmony.ensure(HARMONY_AHEAD);
    for (const layer of this.layers) {
      try {
        layer.begin(startTime);
      } catch (err) {
        warnOnce(`layer of profile "${profile.id}" failed to start`, err);
        layer.nextBeat = Infinity;
      }
    }

    this.fade = 0;
    this.fadeDir = 0;
    this.zeroAt = -1;
    this.loaded = true;
  }

  private echoTime(): number {
    return clamp(this.profile.echo.beats * this.spb, 0.05, 3.9);
  }

  fadeTo(dir: 1 | -1, seconds: number): void {
    if (!this.loaded) return;
    this.fadeRate = 1 / clamp(finite(seconds, 7), 0.2, 30);
    if (dir < 0 && this.fade <= 0) {
      // Already silent: keep (or start) the countdown to unload instead of restarting it.
      this.fadeDir = 0;
      if (this.zeroAt < 0) this.zeroAt = this.clock.now;
      return;
    }
    this.fadeDir = dir;
    this.zeroAt = -1;
  }

  /** True while the deck is on its way out (or silent, waiting to be unloaded). */
  get leaving(): boolean {
    return this.fadeDir < 0 || (this.fadeDir === 0 && this.zeroAt >= 0);
  }

  /**
   * Advances fades and modulation and schedules every event up to `horizon`.
   * Returns true when the deck has faded out completely and can be unloaded.
   */
  tick(dt: number, now: number, horizon: number, tempoScale: number, detuneCents: number): boolean {
    const nodes = this.nodes;
    if (!this.loaded || !nodes) return false;

    // --- crossfade (equal power) ---
    if (this.fadeDir !== 0) {
      this.fade = clamp(this.fade + this.fadeDir * this.fadeRate * dt, 0, 1);
      if (this.fade >= 1 && this.fadeDir > 0) this.fadeDir = 0;
      if (this.fade <= 0 && this.fadeDir < 0) {
        this.fadeDir = 0;
        this.zeroAt = now;
      }
      const g = eqPower(this.fade) * this.trim;
      nodes.dry.gain.linearRampToValueAtTime(g, now + 0.06);
      nodes.wet.gain.linearRampToValueAtTime(g, now + 0.06);
    }

    // --- pitch (time dilation / wormhole) ---
    const cents = clamp(finite(detuneCents, 0), -2400, 1200);
    if (Math.abs(cents - this.detuneSent) > 0.4) {
      nodes.pitch.to(cents, now, 0.06);
      this.detuneSent = cents;
      this.pitchFactor = Math.pow(2, cents / 1200);
    }

    // --- stall recovery: if the main thread froze past our horizon, resume from now ---
    if (this.scheduledUntil < now) {
      this.anchorBeat = this.timeToBeat(this.scheduledUntil);
      this.anchorTime = now + 0.03;
      this.scheduledUntil = now + 0.03;
    }

    // --- tempo (re-anchor where scheduling stopped so the beat map stays continuous) ---
    const spb = 60 / (this.profile.bpm * clamp(finite(tempoScale, 1), 0.2, 2));
    if (Math.abs(spb - this.spb) / this.spb > 0.002) {
      this.anchorBeat = this.timeToBeat(this.scheduledUntil);
      this.anchorTime = this.scheduledUntil;
      this.spb = spb;
      // Glide slowly: a delay-time step is a jump in the delay line's read position (a click).
      nodes.echoTime.to(this.echoTime(), now, 0.3);
    }

    // --- schedule ---
    if (horizon > this.scheduledUntil) {
      const hb = this.timeToBeat(horizon);
      this.harmony.ensure(hb + HARMONY_AHEAD);
      for (const layer of this.layers) {
        let guard = 0;
        while (layer.nextBeat < hb && guard++ < MAX_EVENTS_PER_TICK) {
          const b = layer.nextBeat;
          let nb: number;
          try {
            nb = layer.step(b, this.beatToTime(b));
          } catch (err) {
            warnOnce(`layer step failed in "${this.profile.id}"`, err);
            nb = Infinity; // silence the faulty layer, keep the rest of the music alive
          }
          layer.nextBeat = nb > b + 1e-4 ? nb : b + 0.25;
        }
      }
      this.scheduledUntil = horizon;
    }

    return this.fadeDir === 0 && this.fade <= 0 && this.zeroAt >= 0 && now - this.zeroAt > 0.3;
  }

  /** Current chord info for SFX: returns false when not loaded. */
  chordAt(time: number, out: { mask: number; bassPc: number }): boolean {
    if (!this.loaded) return false;
    const slot = this.harmony.slotAt(this.timeToBeat(time));
    out.mask = this.harmony.slotMask(slot);
    out.bassPc = this.harmony.slotBassPc(slot);
    return true;
  }

  unload(): void {
    for (const layer of this.layers) {
      try {
        layer.dispose();
      } catch (err) {
        warnOnce('layer dispose failed', err);
      }
    }
    this.layers = [];
    const n = this.nodes;
    if (n) {
      n.echo.dispose();
      n.echoTone.dispose();
      n.echoRet.dispose();
      n.echoWet.dispose();
      n.dry.dispose();
      n.wet.dispose();
      n.detune.dispose();
    }
    this.nodes = null;
    this.loaded = false;
    this.fade = 0;
    this.fadeDir = 0;
    this.zeroAt = -1;
  }
}
