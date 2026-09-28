/**
 * AudioEngine — public entry of the audio module (ARCHITECTURE.md §3.7).
 *
 * Signal flow
 *   decks (MusicDirector) ─ dry ─▶ musicDry ▸ low-pass ▸ swirl-panner ▸ musicOut ─┐
 *                        └ wet ─▶ musicWet ▸ low-pass ▸ musicWetOut ─▶ reverb ─┤
 *   Sfx ──────────────── dry ─▶ sfxOut ────────────────────────────────────────┤
 *                        └ wet ─▶ sfxWetOut ─────────────────────▶ reverb ─┤
 *   master: high-shelf (warmth) ▸ 22 Hz high-pass ▸ glue compressor ▸ limiter(−1 dB) ▸ out
 *
 * The limiter is a hard-knee, 20:1 Tone.Compressor at −1 dBFS rather than Tone.Limiter:
 * Tone.Limiter inherits Tone.Compressor's 30 dB default knee, and a Web Audio compressor's
 * knee extends *above* the threshold, so it would only reach 20:1 near +29 dBFS.
 *
 * Mute and pause act on musicOut/musicWetOut only, so SFX and the reverb tails carry on.
 * update() does only arithmetic per frame and touches AudioParams at ≤ 30 Hz.
 */
import * as Tone from 'tone';
import { TUNING } from '../app/config';
import { bus } from '../core/events';
import type { SimState } from '../core/types';
import { NEBULA_BY_ID } from '../universe/catalog';
import { Glide } from './control';
import { type HarmonySnapshot, MusicDirector } from './MusicDirector';
import { getProfile } from './profiles';
import { createImpulseResponse } from './reverb';
import { Sfx, type SfxDrive } from './Sfx';
import { clamp, clamp01, damp, expLerp, finite } from './util';

export { MUSIC_PROFILES, type MusicProfileInfo } from './profiles';

/** Fixed DSP rate: the browser resamples to the device (192 kHz interfaces would need 4× CPU). */
const AUDIO_SAMPLE_RATE = 48000;
/** Tone's lookahead on our context (Tone ticks every lookAhead / 2 s; decks schedule 0.4 s ahead). */
const LOOK_AHEAD = 0.08;
const CONTROL_INTERVAL = 1 / 30; // s between AudioParam updates
const REGION_ENTER = 0.22; // influence needed to switch the score to a nebula
const REGION_HOLD = 0.12; // influence below which we fall back to the void
const DWELL = 1.0; // s a new region must persist before the score follows
const CROSSFADE = 7; // s
const WORMHOLE_CROSSFADE = 3.5; // s
const PAUSE_DUCK = 0.35;
const PAUSE_CUTOFF = 1100; // Hz
/** Shared reverb return: the convolver normalises its IR, this sets how wet the space is. */
const REVERB_RETURN = 1.4;
const MUSIC_OPEN_HZ = 11000;
const DILATION_DETUNE = -700; // cents at the horizon
const MIN_TEMPO = 0.4;

interface MasterNodes {
  musicDry: Tone.Gain;
  musicLP: Tone.Filter;
  musicSwirl: Tone.AutoPanner;
  musicOut: Tone.Gain;
  musicWet: Tone.Gain;
  musicWetLP: Tone.Filter;
  musicWetOut: Tone.Gain;
  sfxDry: Tone.Gain;
  sfxOut: Tone.Gain;
  sfxWet: Tone.Gain;
  sfxWetOut: Tone.Gain;
  reverbIn: Tone.Gain;
  reverbHP: Tone.Filter;
  reverb: Tone.Convolver;
  reverbOut: Tone.Gain;
  masterIn: Tone.Gain;
  shelf: Tone.Filter;
  lowCut: Tone.Filter;
  comp: Tone.Compressor;
  limiter: Tone.Compressor;
}

/** Control-rate handles on the master parameters (see control.ts). */
interface MasterControls {
  lp: Glide;
  lpWet: Glide;
  swirlDepth: Glide;
  swirlRate: Glide;
  music: Glide;
  musicWet: Glide;
  sfx: Glide;
  sfxWet: Glide;
}

/** Profile id for a nebula id (catalog `music`, falling back to the id itself). */
function profileFor(nebulaId: string | null): string {
  if (!nebulaId) return 'void';
  return getProfile(NEBULA_BY_ID[nebulaId]?.music ?? nebulaId).id;
}

/**
 * Makes Tone's global context a fresh one at a FIXED 48 kHz, created inside the user gesture (so
 * it starts running). Tone's default context (created suspended when 'tone' is imported) runs at
 * the device rate; on 192 kHz interfaces the score needed 4× the DSP and the audio thread fell to
 * ~60 % of real time → silence and dropouts. The browser resamples 48 kHz to the device cheaply.
 * 'playback' = larger, glitch-proof buffers (latency is irrelevant for an ambient score and small
 * for the sound effects).
 *
 * Must run before any Tone object exists: everything the engine builds binds to the global context
 * at construction. Only use Tone.getContext()/getDestination() afterwards — never the deprecated
 * Tone.context / Tone.Destination / Tone.Transport / Tone.Draw constants, which are bound to the
 * default context disposed here.
 *
 * If the browser refuses (a context limit, a rate it will not honour …) Tone's default context is
 * kept and the caller's Tone.start() resumes it: heavier on high-rate devices, but never silent.
 */
function installFixedRateContext(): void {
  const current = Tone.getContext();
  if (current.state === 'running' && current.sampleRate === AUDIO_SAMPLE_RATE) return;
  const raw = openFixedRateContext(current);
  if (!raw) return;
  let next: Tone.Context;
  try {
    next = new Tone.Context({ context: raw, lookAhead: LOOK_AHEAD });
  } catch (err) {
    console.warn('[audio] could not wrap the 48 kHz audio context; using the default one', err);
    void raw.close().catch(() => undefined);
    return;
  }
  // Switch first, then dispose the old default (closes its suspended AudioContext): a failure
  // while disposing must not leave the disposed context installed.
  Tone.setContext(next);
  try {
    current.dispose();
  } catch {
    /* best effort */
  }
}

type AudioContextClass = new (options: AudioContextOptions) => AudioContext;

/**
 * A new 48 kHz AudioContext, or null to keep the default one.
 *
 * Where the browser has everything Tone calls on native nodes (Chromium, Safari) this is the bare
 * native AudioContext. Firefox lacks AudioParam.cancelAndHoldAtTime(), which Tone's ramps call
 * whenever a ramp starts exactly on the last scheduled event (e.g. a note released at its decay
 * end): on a bare native context that throws from note scheduling and the deck silences the layer
 * for good. There the context is built with the class Tone built its default one with,
 * standardized-audio-context's AudioContext, which polyfills it (and throws, instead of returning
 * a device-rate context, if the requested rate is ignored).
 */
function openFixedRateContext(current: Tone.BaseContext): AudioContext | null {
  let Ctor: AudioContextClass | null = null;
  const nativeComplete =
    typeof AudioContext === 'function' &&
    typeof AudioParam === 'function' &&
    typeof AudioParam.prototype.cancelAndHoldAtTime === 'function';
  if (nativeComplete) {
    Ctor = AudioContext;
  } else if (current instanceof Tone.Context) {
    const c = (current.rawContext as { constructor?: unknown }).constructor;
    if (typeof c === 'function' && c !== Object) Ctor = c as AudioContextClass;
  }
  if (!Ctor) return null;
  try {
    const raw = new Ctor({ sampleRate: AUDIO_SAMPLE_RATE, latencyHint: 'playback' });
    if (raw.sampleRate !== AUDIO_SAMPLE_RATE) {
      console.warn(`[audio] the browser ignored the 48 kHz request (${raw.sampleRate} Hz)`);
    }
    return raw;
  } catch (err) {
    console.warn('[audio] no 48 kHz audio context; using the default one', err);
    return null;
  }
}

export class AudioEngine {
  private startPromise: Promise<void> | null = null;
  private started = false;
  private disposed = false;
  private nodes: MasterNodes | null = null;
  private ctl: MasterControls | null = null;
  private director: MusicDirector | null = null;
  private sfx: Sfx | null = null;
  private unsubscribers: (() => void)[] = [];

  // user state
  private musicVolume = 0.8;
  private sfxVolume = 0.7;
  private muted = false;
  private paused = false;

  // smoothed simulation state
  private tdSmooth = 1;
  private tidalSmooth = 0;
  /** 0..1 smoothed: phasing through a solid in ghost mode (music heard "through rock"). */
  private ghostSmooth = 0;
  private hyperSmooth = 0;
  private swirl = 0;
  private recoverFor = 0;
  private lastControl = -1;
  private wormholeActive = false;
  private wormholeProgress = 0;

  // region → profile selection
  private targetProfile: string | null = null;
  private currentNebula: string | null = null;
  private candidate = 'void';
  private candidateNebula: string | null = null;
  private candidateTime = 0;

  private readonly harmony: HarmonySnapshot = { mask: 0, bassPc: 0, tonic: 50, scaleMask: 0, profileId: 'void' };
  private readonly drive: SfxDrive = { thrust: 0, motion: 0, hyper: 0, paused: false, detune: 0 };

  /** Music profile the score is heading to (see MUSIC_PROFILES), or null before start(). */
  get musicProfile(): string | null {
    return this.started ? this.targetProfile : null;
  }

  /** Call from a user gesture. Idempotent; safe to call again after it resolved. */
  start(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    // Everything up to the first await runs synchronously inside the gesture.
    let resume: Promise<void>;
    try {
      installFixedRateContext();
      // Resumes whichever context is now global (the new one, or Tone's default as fallback).
      resume = Tone.start();
    } catch (err) {
      resume = Promise.reject(err);
    }
    this.startPromise = this.boot(resume);
    return this.startPromise;
  }

  private async boot(resume: Promise<void>): Promise<void> {
    // Build once the context runs (a few ms): the gesture is only needed to create and resume it,
    // and sources started on a context that still reports 'suspended' (standardized-audio-context
    // does so until the first statechange) make Tone log a "suspended" warning each. Don't hang
    // forever if the browser withholds the context (e.g. no gesture).
    await Promise.race([resume.catch(() => undefined), new Promise<void>((r) => setTimeout(r, 1500))]);
    if (this.disposed) return;
    try {
      this.build();
    } catch (err) {
      console.warn('[audio] failed to initialise', err);
      this.teardown();
    }
  }

  private build(): void {
    const ctx = Tone.getContext();
    const now = ctx.currentTime;
    const n: MasterNodes = {
      musicDry: new Tone.Gain(1),
      musicLP: new Tone.Filter({ type: 'lowpass', frequency: MUSIC_OPEN_HZ, Q: 0.5, rolloff: -12 }),
      musicSwirl: new Tone.AutoPanner({ frequency: 0.25, depth: 0, wet: 1, channelCount: 2 }),
      musicOut: new Tone.Gain(0),
      musicWet: new Tone.Gain(1),
      musicWetLP: new Tone.Filter({ type: 'lowpass', frequency: MUSIC_OPEN_HZ, Q: 0.5, rolloff: -12 }),
      musicWetOut: new Tone.Gain(0),
      sfxDry: new Tone.Gain(1),
      sfxOut: new Tone.Gain(0),
      sfxWet: new Tone.Gain(1),
      sfxWetOut: new Tone.Gain(0),
      reverbIn: new Tone.Gain(1),
      reverbHP: new Tone.Filter({ type: 'highpass', frequency: 150, Q: 0.5, rolloff: -12 }),
      reverb: new Tone.Convolver(createImpulseResponse((c, l, sr) => ctx.createBuffer(c, l, sr), ctx.sampleRate)),
      reverbOut: new Tone.Gain(REVERB_RETURN),
      masterIn: new Tone.Gain(1),
      shelf: new Tone.Filter({ type: 'highshelf', frequency: 5500, gain: -3.5, Q: 0.6 }),
      lowCut: new Tone.Filter({ type: 'highpass', frequency: 22, Q: 0.6, rolloff: -12 }),
      comp: new Tone.Compressor({ threshold: -16, ratio: 2, knee: 10, attack: 0.04, release: 0.35 }),
      limiter: new Tone.Compressor({ threshold: -1, ratio: 20, knee: 0, attack: 0.002, release: 0.12 }),
    };
    n.musicDry.chain(n.musicLP, n.musicSwirl, n.musicOut, n.masterIn);
    n.musicWet.chain(n.musicWetLP, n.musicWetOut, n.reverbIn);
    n.sfxDry.chain(n.sfxOut, n.masterIn);
    n.sfxWet.chain(n.sfxWetOut, n.reverbIn);
    n.reverbIn.chain(n.reverbHP, n.reverb, n.reverbOut, n.masterIn);
    n.masterIn.chain(n.shelf, n.lowCut, n.comp, n.limiter, Tone.getDestination());
    n.musicSwirl.start(now);
    this.nodes = n;
    this.ctl = {
      lp: new Glide(n.musicLP.frequency, MUSIC_OPEN_HZ, 0.01, true),
      lpWet: new Glide(n.musicWetLP.frequency, MUSIC_OPEN_HZ, 0.01, true),
      swirlDepth: new Glide(n.musicSwirl.depth, 0, 0.002),
      swirlRate: new Glide(n.musicSwirl.frequency, 0.25, 0.01, true),
      music: new Glide(n.musicOut.gain, 0, 1e-4),
      musicWet: new Glide(n.musicWetOut.gain, 0, 1e-4),
      sfx: new Glide(n.sfxOut.gain, 0, 1e-4),
      sfxWet: new Glide(n.sfxWetOut.gain, 0, 1e-4),
    };
    this.ctl.lp.jump(MUSIC_OPEN_HZ, now);
    this.ctl.lpWet.jump(MUSIC_OPEN_HZ, now);

    this.sfx = new Sfx(n.sfxDry, n.sfxWet);
    this.director = new MusicDirector(n.musicDry, n.musicWet);
    if (this.targetProfile) this.director.setDesired(this.targetProfile, CROSSFADE);
    this.director.start();
    this.subscribe();
    this.started = true;
    this.applyGains(1.2);
  }

  private subscribe(): void {
    const u = this.unsubscribers;
    u.push(
      bus.on('regionEnter', ({ id }) => this.withHarmony(profileFor(id), (h) => this.sfx?.regionEnter(h))),
      bus.on('targetLock', () => this.withCurrentHarmony((h) => this.sfx?.targetLock(h))),
      bus.on('pulse', () => this.withCurrentHarmony((h) => this.sfx?.pulse(h))),
      bus.on('autopilotStart', () => this.withCurrentHarmony((h) => this.sfx?.autopilotStart(h))),
      bus.on('autopilotEnd', ({ reason }) => {
        if (reason === 'arrived') this.withCurrentHarmony((h) => this.sfx?.autopilotArrived(h));
      }),
      bus.on('hyperStart', () => this.sfx?.hyperStart()),
      bus.on('hyperEnd', () => this.sfx?.hyperEnd()),
      bus.on('horizonWarning', () => this.withCurrentHarmony((h) => this.sfx?.horizonWarning(h))),
      bus.on('wormholeStart', ({ toId }) => {
        this.wormholeActive = true;
        this.wormholeProgress = 0;
        this.sfx?.wormholeStart(TUNING.wormholeSeconds);
        // Change key inside the swirl, so the exit chord lands on the destination's music
        // instead of over the black hole's score.
        this.commitProfile(profileFor(toId), toId || null, clamp(0.8 * TUNING.wormholeSeconds, 2, 10));
      }),
      bus.on('wormholeEnd', ({ toId }) => {
        this.wormholeActive = false;
        this.recoverFor = 2;
        const profile = profileFor(toId);
        this.commitProfile(profile, toId || null, WORMHOLE_CROSSFADE);
        this.withHarmony(profile, (h) => this.sfx?.wormholeEnd(h));
      }),
    );
  }

  private withCurrentHarmony(fn: (h: HarmonySnapshot) => void): void {
    if (!this.director) return;
    this.director.harmony(this.harmony);
    fn(this.harmony);
  }

  /** A region's tonic chord, kept consonant with whatever is sounding right now. */
  private withHarmony(profileId: string, fn: (h: HarmonySnapshot) => void): void {
    if (!this.director) return;
    this.director.harmonyFor(profileId, this.harmony);
    fn(this.harmony);
  }

  // ---------------------------------------------------------------------------------------------
  // Per frame
  // ---------------------------------------------------------------------------------------------

  update(state: SimState): void {
    if (!this.started || this.disposed) return;
    try {
      this.frame(state);
    } catch (err) {
      if (!this.frameWarned) {
        this.frameWarned = true;
        console.warn('[audio] update failed', err);
      }
    }
  }
  private frameWarned = false;

  private frame(state: SimState): void {
    const dt = clamp(finite(state.dt, 0), 0, 0.1);
    const env = state.env;
    const td = clamp01(finite(env.timeDilation, 1));
    this.recoverFor = Math.max(0, this.recoverFor - dt);
    this.tdSmooth += (td - this.tdSmooth) * damp(dt, this.recoverFor > 0 ? 0.15 : 0.6);
    this.tidalSmooth += (clamp01(finite(env.tidal, 0)) - this.tidalSmooth) * damp(dt, 0.5);
    this.ghostSmooth += (clamp01(finite(state.ship.ghostInside, 0)) - this.ghostSmooth) * damp(dt, 0.25);
    const hyper = clamp01(finite(state.ship.hyper, 0));
    this.hyperSmooth += (hyper - this.hyperSmooth) * damp(dt, 0.3);
    if (state.wormhole.active) {
      this.wormholeActive = true;
      this.wormholeProgress = clamp01(finite(state.wormhole.progress, 0));
    } else if (this.wormholeActive && !state.wormhole.active) {
      this.wormholeActive = false;
    }
    const swirlTarget = this.wormholeActive ? Math.sin(Math.PI * this.wormholeProgress) : 0;
    this.swirl += (swirlTarget - this.swirl) * damp(dt, 0.25);

    this.selectProfile(state, dt);

    const now = Tone.getContext().currentTime;
    if (now - this.lastControl < CONTROL_INTERVAL && this.lastControl >= 0) return;
    const ctlDt = this.lastControl < 0 ? dt : clamp(now - this.lastControl, 0, 0.25);
    this.lastControl = now;

    // Time dilation: slower and lower toward the horizon; the wormhole bends pitch further.
    const tempo = clamp(this.tdSmooth, MIN_TEMPO, 1);
    const detune = DILATION_DETUNE * (1 - this.tdSmooth) - 450 * this.swirl;
    this.director?.setModulation(tempo, clamp(detune, -1100, 0));

    this.applyTone(now, CONTROL_INTERVAL * 2);

    const speed = finite(state.ship.speed, 0);
    // Smoothed flight scale (not the raw surface distance) so the engine's motion sound stays steady.
    const surf = finite(env.flightScale, finite(env.surfaceDistance, Infinity));
    const rel = surf > 1e-12 && Number.isFinite(surf) ? speed / surf : 0;
    const d = this.drive;
    d.thrust = clamp01(finite(state.ship.thrust, 0));
    d.motion = clamp01(Math.log(1 + rel / 0.6) / Math.log(41));
    d.hyper = hyper;
    d.paused = this.paused;
    d.detune = detune;
    this.sfx?.update(d, ctlDt);
  }

  /** Music tone: closes with tidal stress, opens a little under hyper, darkens while paused. */
  private applyTone(now: number, lag: number): void {
    const c = this.ctl;
    if (!c) return;
    let cutoff = expLerp(MUSIC_OPEN_HZ, 650, Math.pow(this.tidalSmooth, 0.8));
    cutoff *= 1 + 0.5 * this.hyperSmooth;
    cutoff *= 1 - 0.55 * this.swirl;
    cutoff *= 1 - 0.8 * this.ghostSmooth; // inside a solid (ghost mode): muffled
    if (this.paused) cutoff = Math.min(cutoff, PAUSE_CUTOFF);
    cutoff = clamp(cutoff, 200, 18000);
    c.lp.to(cutoff, now, lag);
    c.lpWet.to(cutoff, now, lag);
    c.swirlDepth.to(0.85 * this.swirl, now, lag);
    c.swirlRate.to(0.25 + 1.55 * this.swirl, now, lag * 3);
  }

  /** Dominant nebula (with hysteresis and a short dwell) → desired music profile. */
  private selectProfile(state: SimState, dt: number): void {
    if (this.wormholeActive) return;
    const weights = state.env.weights;
    let bestId: string | null = null;
    let best = 0;
    for (const id in weights) {
      const w = finite(weights[id], 0);
      if (w > best) {
        best = w;
        bestId = id;
      }
    }
    let nebula: string | null = null;
    if (bestId !== null && best > REGION_ENTER) nebula = bestId;
    else if (this.currentNebula !== null && finite(weights[this.currentNebula], 0) > REGION_HOLD) nebula = this.currentNebula;
    const profile = profileFor(nebula);

    if (this.targetProfile === null) {
      this.commitProfile(profile, nebula, CROSSFADE);
      return;
    }
    if (profile !== this.candidate) {
      this.candidate = profile;
      this.candidateNebula = nebula;
      this.candidateTime = 0;
    } else {
      this.candidateTime += dt;
    }
    if (profile === this.targetProfile) {
      this.currentNebula = nebula;
      return;
    }
    if (this.candidateTime >= DWELL) this.commitProfile(profile, this.candidateNebula, CROSSFADE);
  }

  private commitProfile(profile: string, nebula: string | null, fade: number): void {
    this.targetProfile = profile;
    this.currentNebula = nebula;
    this.candidate = profile;
    this.candidateNebula = nebula;
    this.candidateTime = 0;
    this.director?.setDesired(profile, fade);
  }

  // ---------------------------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------------------------

  setVolumes(music: number, sfx: number): void {
    this.musicVolume = clamp01(finite(music, this.musicVolume));
    this.sfxVolume = clamp01(finite(sfx, this.sfxVolume));
    this.applyGains(0.15);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.applyGains(0.6);
    return this.muted;
  }

  setPaused(p: boolean): void {
    const next = !!p;
    if (next === this.paused) return;
    this.paused = next;
    this.sfx?.setPaused(next);
    this.applyGains(0.8);
    if (!this.started) return;
    const ctx = Tone.getContext();
    this.applyTone(ctx.currentTime, 0.7);
    // Resuming is a user gesture: recover a context the browser suspended meanwhile.
    if (!next && ctx.state !== 'running') void Tone.start().catch(() => undefined);
  }

  /** Perceptual (≈ power-law) volume curves; music also carries mute and the pause duck. */
  private applyGains(ramp: number): void {
    const c = this.ctl;
    if (!c) return;
    const now = Tone.getContext().currentTime;
    const music = this.muted ? 0 : Math.pow(this.musicVolume, 1.5) * (this.paused ? PAUSE_DUCK : 1);
    const sfx = Math.pow(this.sfxVolume, 1.5);
    c.music.to(music, now, ramp);
    c.musicWet.to(music, now, ramp);
    c.sfx.to(sfx, now, ramp);
    c.sfxWet.to(sfx, now, ramp);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
  }

  private teardown(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    this.started = false;
    try {
      this.director?.dispose();
      this.sfx?.dispose();
    } catch {
      /* best effort */
    }
    this.director = null;
    this.sfx = null;
    const n = this.nodes;
    if (n) {
      for (const node of Object.values(n)) {
        try {
          node.dispose();
        } catch {
          /* already disposed */
        }
      }
    }
    this.nodes = null;
    this.ctl = null;
  }
}
