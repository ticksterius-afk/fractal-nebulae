/**
 * Music profiles: one per nebula id (see src/universe/catalog.ts `music`) plus 'void'.
 * ARCHITECTURE.md §5 holds the character briefs. Every profile is data only — the Deck
 * builds its instruments on demand and disposes them after the crossfade.
 *
 * Chords are written in degrees of the profile's harmony scale (0 = tonic, 7 = octave in a
 * seven-note mode); `alt` adds chromatic semitone offsets per tone (Locrian hints in bh-maw).
 * `next` lists the chords that may follow (repeat an index to weight it) — a small Markov
 * graph, so progressions wander instead of looping.
 */
import { MODES } from './scales';

export type PadVoice = 'warmPad' | 'softPad' | 'glassPad' | 'choirPad' | 'organPad' | 'darkPad' | 'brassPad';
export type BassVoice = 'sub' | 'bass';
export type MotifVoice = 'marimba' | 'glassPluck' | 'bell' | 'bellDeep' | 'celesta' | 'ePiano' | 'harp' | 'shimmer' | 'flute';
/** Voices used only by sound effects. */
export type SfxVoice = 'bloom' | 'glow' | 'sonar' | 'heart';
export type VoiceKind = PadVoice | BassVoice | MotifVoice | SfxVoice | 'membrane';

interface LayerBase {
  /** Layer output level in dB (mix position). */
  level: number;
  /** Reverb send 0..1 (linear). */
  rev: number;
  /** Tempo-synced ping-pong delay send 0..1. */
  dly?: number;
}

export interface PadSpec extends LayerBase {
  kind: 'pad';
  voice: PadVoice;
  register: [number, number];
  /** Voices per chord (≤ 4). */
  notes: number;
  vel: [number, number];
  /** Low-pass base cutoff (Hz) and LFO sweep range in octaves above it. */
  cutoff: number;
  cutoffOctaves: number;
  lfoHz: number;
  q?: number;
  /** Chorus wet 0..1 (0 = no chorus). */
  chorus?: number;
  /** Swirling auto-pan (bh-eye). */
  autopan?: { hz: number; depth: number };
  /** Mid-chord colour tone (top voice moves a step). */
  color?: boolean;
  /** Strum spread in beats. */
  strum?: number;
}

export interface DroneSpec extends LayerBase {
  kind: 'drone';
  voice: BassVoice;
  register: [number, number];
  /** 'root' follows the chord bass; 'pedal' holds the tonic. */
  mode: 'root' | 'pedal';
  fifth?: boolean;
  octaveBelow?: boolean;
  vel: number;
}

export interface TextureSpec extends LayerBase {
  kind: 'texture';
  noise: 'white' | 'pink' | 'brown';
  filter: BiquadFilterType;
  /** Filter frequency range explored by the swells (Hz). */
  range: [number, number];
  q: number;
  /** Bars between swell targets. */
  bars: [number, number];
  mode?: 'swell' | 'thunder';
}

export interface PulseSpec extends LayerBase {
  kind: 'pulse';
  /** MIDI note of the heartbeat. */
  note: number;
  /** Beats between beats of the heart. */
  every: number;
  vel: number;
}

export interface ShepardSpec extends LayerBase {
  kind: 'shepard';
  /** Lowest component (MIDI; must be a scale tone, an octave multiple below the root). */
  baseMidi: number;
  octaves: number;
  /** Beats per scale step. */
  stepBeats: number;
  /** Fraction of each step spent gliding. */
  glide: number;
  direction: 1 | -1;
}

export type MotifStyle =
  | 'arp8'
  | 'walk'
  | 'cantor'
  | 'halving'
  | 'golden'
  | 'canon'
  | 'fork'
  | 'crystal'
  | 'gliss'
  | 'bells'
  | 'toll'
  | 'sparkle';

export interface MotifSpec extends LayerBase {
  kind: 'motif';
  style: MotifStyle;
  voice: MotifVoice;
  /** Optional second instrument (canon follower / fork branch), panned opposite. */
  voice2?: MotifVoice;
  register: [number, number];
  vel: number;
  /** 0..1 activity (shorter rests when higher). */
  density: number;
  /** First bar the layer may play (lets pads establish the key first). */
  startBar?: number;
}

export type LayerSpec = PadSpec | DroneSpec | TextureSpec | PulseSpec | ShepardSpec | MotifSpec;

export interface ChordSpec {
  d: number[];
  alt?: number[];
  next: number[];
}

export interface ProfileDef {
  id: string;
  title: string;
  key: string;
  mode: string;
  description: string;
  bpm: number;
  beatsPerBar: number;
  /** MIDI note of the tonic (harmony scale degree 0). */
  root: number;
  scale: readonly number[];
  /** Scale used by melodic layers (defaults to `scale`). */
  melody?: readonly number[];
  chords: ChordSpec[];
  barsPerChord: [number, number];
  /** Ping-pong delay: time in beats and feedback. */
  echo: { beats: number; feedback: number };
  /** Output trim (dB) that levels the profile against the others (loudness-matched crossfades). */
  trim?: number;
  layers: LayerSpec[];
}

// ---------------------------------------------------------------------------------------------

const VOID: ProfileDef = {
  id: 'void',
  title: 'Interstellar Void',
  key: 'D',
  mode: 'Aeolian (sus2 / add9 colours)',
  description: 'Vast and sparse: a low evolving drone, slow suspended chord swells and rare distant bells.',
  bpm: 50,
  beatsPerBar: 4,
  root: 50,
  scale: MODES.aeolian,
  chords: [
    { d: [0, 4, 8, 11], next: [1, 2, 3, 4] }, // Dsus2 (open fifths)
    { d: [5, 9, 11, 14], next: [0, 4, 2] }, // Bbmaj7
    { d: [3, 5, 7, 11], next: [0, 1] }, // Gm(add9), 9th a major 7th above the third
    { d: [2, 6, 9, 10], next: [0, 4] }, // F(add9)
    { d: [6, 7, 10, 14], next: [0, 3] }, // Csus2
  ],
  barsPerChord: [3, 4],
  echo: { beats: 1.5, feedback: 0.35 },
  trim: 0.5,
  layers: [
    { kind: 'pad', voice: 'softPad', register: [50, 76], notes: 4, vel: [0.45, 0.6], cutoff: 700, cutoffOctaves: 1.3, lfoHz: 0.021, q: 0.7, chorus: 0.45, color: true, strum: 0.25, level: -18, rev: 0.75 },
    { kind: 'drone', voice: 'sub', register: [38, 50], mode: 'pedal', fifth: true, vel: 0.55, level: -17, rev: 0.25 },
    { kind: 'texture', noise: 'pink', filter: 'bandpass', range: [260, 1400], q: 1.4, bars: [2, 4], level: -14, rev: 0.7 },
    { kind: 'motif', style: 'bells', voice: 'bell', register: [69, 88], vel: 0.55, density: 0.45, startBar: 2, level: -12, rev: 0.9, dly: 0.4 },
  ],
};

const BULB: ProfileDef = {
  id: 'bulb',
  title: 'Organic Bloom',
  key: 'D',
  mode: 'Lydian',
  description: 'Warm analog pads and an 8-step marimba arpeggio (power 8) that mutates like growing florets.',
  bpm: 64,
  beatsPerBar: 4,
  root: 50,
  scale: MODES.lydian,
  chords: [
    { d: [0, 4, 6, 8, 9], next: [1, 1, 2, 3] }, // Dmaj9
    { d: [1, 3, 5, 9], next: [0, 0, 4] }, // E(add9) (the Lydian II)
    { d: [5, 7, 9, 11], next: [3, 1, 0] }, // Bm7
    { d: [2, 4, 6, 8], next: [4, 0] }, // F#m7
    { d: [4, 6, 8, 12], next: [0, 1] }, // A(add9)
  ],
  barsPerChord: [2, 4],
  echo: { beats: 0.75, feedback: 0.3 },
  trim: 0.5,
  layers: [
    { kind: 'pad', voice: 'warmPad', register: [50, 74], notes: 4, vel: [0.4, 0.6], cutoff: 650, cutoffOctaves: 1.6, lfoHz: 0.035, q: 1, chorus: 0.5, color: true, strum: 0.2, level: -10, rev: 0.55 },
    { kind: 'drone', voice: 'bass', register: [36, 50], mode: 'root', vel: 0.55, level: -14, rev: 0.2 },
    { kind: 'motif', style: 'arp8', voice: 'marimba', register: [62, 86], vel: 0.55, density: 0.7, startBar: 2, level: -10, rev: 0.35, dly: 0.25 },
    { kind: 'motif', style: 'walk', voice: 'flute', register: [67, 84], vel: 0.45, density: 0.35, startBar: 5, level: -15, rev: 0.55, dly: 0.3 },
    { kind: 'texture', noise: 'pink', filter: 'lowpass', range: [300, 1100], q: 0.6, bars: [2, 4], level: -20, rev: 0.5 },
  ],
};

const MENGER: ProfileDef = {
  id: 'menger',
  title: 'Ternary Lattice',
  key: 'C♯',
  mode: 'minor pentatonic in 3/4',
  description: 'Glassy plucks on a Cantor-set rhythm (27 steps, the middle thirds removed), over a resonant low pedal.',
  bpm: 72,
  beatsPerBar: 3,
  root: 49,
  scale: MODES.aeolian,
  melody: MODES.minorPentatonic,
  chords: [
    { d: [0, 2, 4, 6], next: [1, 4, 3] }, // C#m7
    { d: [5, 7, 9, 11], next: [2, 3, 0] }, // Amaj7
    { d: [2, 4, 6, 7], next: [0, 4] }, // E6
    { d: [6, 8, 10, 14], next: [0, 0, 1] }, // B(add9)
    { d: [3, 5, 7, 9], next: [3, 0] }, // F#m7
  ],
  barsPerChord: [4, 6],
  echo: { beats: 1, feedback: 0.3 },
  layers: [
    { kind: 'pad', voice: 'softPad', register: [49, 73], notes: 4, vel: [0.4, 0.55], cutoff: 600, cutoffOctaves: 1.2, lfoHz: 0.028, q: 1.8, chorus: 0.35, level: -16, rev: 0.6 },
    { kind: 'drone', voice: 'bass', register: [37, 49], mode: 'pedal', vel: 0.6, level: -15, rev: 0.2 },
    { kind: 'motif', style: 'cantor', voice: 'glassPluck', register: [61, 85], vel: 0.55, density: 0.75, startBar: 2, level: -8, rev: 0.45, dly: 0.3 },
    { kind: 'motif', style: 'sparkle', voice: 'shimmer', register: [80, 97], vel: 0.3, density: 0.3, startBar: 4, level: -20, rev: 0.9 },
    { kind: 'texture', noise: 'brown', filter: 'lowpass', range: [120, 420], q: 0.8, bars: [2, 3], level: -22, rev: 0.4 },
  ],
};

const BOX: ProfileDef = {
  id: 'box',
  title: 'Vaulted Cathedral',
  key: 'A',
  mode: 'Dorian',
  description: 'Organ and choir pads over a pedal bass, rare deep bell tolls ringing through a vast space.',
  bpm: 56,
  beatsPerBar: 4,
  root: 45,
  scale: MODES.dorian,
  chords: [
    { d: [0, 2, 4, 8], next: [1, 1, 2, 4] }, // Am(add9)
    { d: [3, 5, 7, 10], next: [0, 3, 2] }, // D (the Dorian IV)
    { d: [6, 8, 10, 11], next: [0, 4] }, // G6
    { d: [4, 6, 8, 10], next: [0, 1] }, // Em7
    { d: [2, 4, 6, 8], next: [1, 3] }, // Cmaj7
  ],
  barsPerChord: [2, 3],
  echo: { beats: 1.5, feedback: 0.25 },
  layers: [
    { kind: 'pad', voice: 'organPad', register: [45, 69], notes: 4, vel: [0.4, 0.5], cutoff: 1400, cutoffOctaves: 0.6, lfoHz: 0.02, q: 0.5, chorus: 0.2, level: -13, rev: 0.85 },
    { kind: 'pad', voice: 'choirPad', register: [60, 81], notes: 3, vel: [0.35, 0.5], cutoff: 1100, cutoffOctaves: 0.8, lfoHz: 0.045, q: 2.2, chorus: 0.5, color: true, level: -17, rev: 0.9 },
    { kind: 'drone', voice: 'sub', register: [33, 45], mode: 'pedal', vel: 0.6, level: -17, rev: 0.35 },
    { kind: 'motif', style: 'toll', voice: 'bellDeep', register: [45, 62], vel: 0.5, density: 0.4, startBar: 3, level: -8, rev: 0.9, dly: 0.15 },
  ],
};

const JULIA: ProfileDef = {
  id: 'julia',
  title: 'Four-Dimensional Veil',
  key: 'E♭',
  mode: 'Lydian augmented (whole-tone colour)',
  description: 'Shimmering detuned choir, harp glissandi through whole-tone steps, augmented dream harmonies.',
  bpm: 60,
  beatsPerBar: 4,
  root: 51,
  scale: MODES.lydianAugmented,
  chords: [
    { d: [0, 2, 4, 6], next: [1, 1, 2, 4] }, // Ebmaj7#5
    { d: [1, 3, 5, 9], next: [0, 3] }, // F(add9)
    { d: [2, 4, 7, 9], next: [0, 4] }, // G augmented
    { d: [3, 5, 7, 9], next: [1, 0] }, // Aø7
    { d: [5, 7, 9, 13], next: [0, 2] }, // Cm(add9)
  ],
  barsPerChord: [2, 3],
  echo: { beats: 0.75, feedback: 0.4 },
  layers: [
    { kind: 'pad', voice: 'choirPad', register: [51, 77], notes: 4, vel: [0.4, 0.55], cutoff: 900, cutoffOctaves: 1.2, lfoHz: 0.03, q: 1.5, chorus: 0.6, level: -17, rev: 0.75 },
    { kind: 'drone', voice: 'sub', register: [39, 51], mode: 'root', vel: 0.5, level: -17, rev: 0.3 },
    { kind: 'motif', style: 'gliss', voice: 'harp', register: [63, 93], vel: 0.45, density: 0.55, startBar: 2, level: -12, rev: 0.6, dly: 0.3 },
    { kind: 'motif', style: 'sparkle', voice: 'shimmer', register: [79, 98], vel: 0.3, density: 0.4, startBar: 3, level: -13, rev: 0.9, dly: 0.4 },
    { kind: 'texture', noise: 'white', filter: 'bandpass', range: [2500, 7000], q: 0.9, bars: [2, 4], level: -31, rev: 0.8 },
  ],
};

const SIERPINSKI: ProfileDef = {
  id: 'sierpinski',
  title: 'Golden Pyramid',
  key: 'A',
  mode: 'major pentatonic',
  description: 'FM bells in fifths and octaves; rhythms from Pascal’s triangle mod 2, replayed at ½ and ¼ scale.',
  bpm: 80,
  beatsPerBar: 4,
  root: 45,
  scale: MODES.ionian,
  melody: MODES.majorPentatonic,
  chords: [
    { d: [0, 4, 8, 9], next: [1, 2, 2, 3] }, // A(add9)
    { d: [5, 7, 9, 11], next: [2, 4] }, // F#m7
    { d: [3, 5, 7, 9], next: [0, 3, 4] }, // Dmaj7
    { d: [4, 5, 8], next: [0, 0] }, // Esus2
    { d: [1, 3, 5, 7], next: [3, 0] }, // Bm7
  ],
  barsPerChord: [2, 4],
  echo: { beats: 0.5, feedback: 0.3 },
  trim: -1,
  layers: [
    { kind: 'pad', voice: 'softPad', register: [52, 76], notes: 4, vel: [0.35, 0.5], cutoff: 1100, cutoffOctaves: 1.0, lfoHz: 0.04, q: 0.8, chorus: 0.4, color: true, level: -13, rev: 0.6 },
    { kind: 'drone', voice: 'bass', register: [33, 45], mode: 'root', fifth: true, vel: 0.5, level: -14, rev: 0.2 },
    { kind: 'motif', style: 'halving', voice: 'bell', register: [57, 93], vel: 0.5, density: 0.8, startBar: 2, level: -8, rev: 0.55, dly: 0.35 },
    { kind: 'texture', noise: 'pink', filter: 'bandpass', range: [1500, 4500], q: 1.0, bars: [2, 3], level: -16, rev: 0.6 },
  ],
};

const APOLLONIAN: ProfileDef = {
  id: 'apollonian',
  title: 'Pearl Foam',
  key: 'F',
  mode: 'Dorian',
  description: 'Glassy bells on golden-ratio timing (a Fibonacci word — quasi-periodic, never repeating) with pearly bubbles.',
  bpm: 66,
  beatsPerBar: 4,
  root: 41,
  scale: MODES.dorian,
  chords: [
    { d: [0, 2, 4, 8], next: [1, 1, 3, 4] }, // Fm(add9)
    { d: [3, 5, 7, 11], next: [0, 2] }, // Bb(add9)
    { d: [6, 8, 10, 12], next: [0, 3] }, // Ebmaj7
    { d: [2, 4, 6, 8], next: [4, 1, 0] }, // Abmaj7
    { d: [4, 6, 8, 10], next: [0, 1] }, // Cm7
  ],
  barsPerChord: [2, 4],
  echo: { beats: 1.618, feedback: 0.35 },
  trim: -1.5,
  layers: [
    { kind: 'pad', voice: 'glassPad', register: [53, 77], notes: 4, vel: [0.4, 0.55], cutoff: 1000, cutoffOctaves: 1.2, lfoHz: 0.033, q: 1.2, chorus: 0.45, color: true, level: -16, rev: 0.65 },
    { kind: 'drone', voice: 'sub', register: [36, 48], mode: 'root', vel: 0.5, level: -17, rev: 0.25 },
    { kind: 'motif', style: 'golden', voice: 'bell', register: [65, 96], vel: 0.45, density: 0.65, startBar: 2, level: -8, rev: 0.6, dly: 0.3 },
    { kind: 'motif', style: 'sparkle', voice: 'shimmer', register: [82, 100], vel: 0.28, density: 0.35, startBar: 4, level: -16, rev: 0.9, dly: 0.3 },
    { kind: 'texture', noise: 'pink', filter: 'bandpass', range: [700, 2600], q: 1.3, bars: [2, 4], level: -13, rev: 0.7 },
  ],
};

const KLEINIAN: ProfileDef = {
  id: 'kleinian',
  title: 'Indra’s Net',
  key: 'B',
  mode: 'Dorian',
  description: 'Canons and mirrored (retrograde, inverted) phrases bouncing between two bells through ping-pong echoes.',
  bpm: 58,
  beatsPerBar: 4,
  root: 47,
  scale: MODES.dorian,
  chords: [
    { d: [0, 2, 4, 8], next: [1, 1, 4, 5] }, // Bm(add9)
    { d: [3, 5, 7, 11], next: [0, 2] }, // E(add9)
    { d: [6, 8, 10, 11], next: [0, 4] }, // A6
    { d: [5, 7, 9, 11], next: [5, 1] }, // G#ø7
    { d: [2, 4, 6, 8], next: [3, 1, 0] }, // Dmaj7
    { d: [4, 6, 8, 10], next: [0] }, // F#m7
  ],
  barsPerChord: [2, 3],
  echo: { beats: 1.5, feedback: 0.45 },
  trim: 1,
  layers: [
    { kind: 'pad', voice: 'choirPad', register: [50, 74], notes: 4, vel: [0.4, 0.55], cutoff: 850, cutoffOctaves: 1.1, lfoHz: 0.025, q: 1.6, chorus: 0.55, level: -16, rev: 0.7 },
    { kind: 'drone', voice: 'sub', register: [35, 47], mode: 'root', vel: 0.5, level: -17, rev: 0.3 },
    { kind: 'motif', style: 'canon', voice: 'bell', voice2: 'celesta', register: [62, 86], vel: 0.45, density: 0.7, startBar: 2, level: -8, rev: 0.55, dly: 0.5 },
    { kind: 'texture', noise: 'pink', filter: 'bandpass', range: [400, 1800], q: 1.2, bars: [2, 4], level: -13, rev: 0.7 },
  ],
};

const KIFS: ProfileDef = {
  id: 'kifs',
  title: 'Frost Kaleidoscope',
  key: 'E',
  mode: 'Lydian (maj9)',
  description: 'Celesta arpeggios mirrored like snowflake arms (six up, five down), glittering in a cold reverb.',
  bpm: 76,
  beatsPerBar: 4,
  root: 52,
  scale: MODES.lydian,
  chords: [
    { d: [0, 2, 4, 6, 8], next: [1, 1, 2, 3] }, // Emaj9
    { d: [1, 3, 5, 9], next: [0, 4] }, // F#(add9) (the Lydian II)
    { d: [5, 7, 9, 11], next: [3, 1, 0] }, // C#m7
    { d: [2, 4, 6, 8], next: [4, 0] }, // G#m7
    { d: [4, 6, 8, 12], next: [0, 1] }, // B(add9)
  ],
  barsPerChord: [2, 4],
  echo: { beats: 0.75, feedback: 0.35 },
  trim: -1.5,
  layers: [
    { kind: 'pad', voice: 'glassPad', register: [52, 79], notes: 4, vel: [0.35, 0.5], cutoff: 1400, cutoffOctaves: 1.0, lfoHz: 0.04, q: 0.9, chorus: 0.55, level: -17, rev: 0.8 },
    { kind: 'drone', voice: 'sub', register: [40, 52], mode: 'root', vel: 0.45, level: -17, rev: 0.3 },
    { kind: 'motif', style: 'crystal', voice: 'celesta', register: [64, 100], vel: 0.5, density: 0.7, startBar: 2, level: -11, rev: 0.6, dly: 0.35 },
    { kind: 'motif', style: 'sparkle', voice: 'shimmer', register: [84, 103], vel: 0.28, density: 0.45, startBar: 3, level: -12, rev: 0.95 },
    { kind: 'texture', noise: 'white', filter: 'highpass', range: [5000, 9000], q: 0.7, bars: [2, 4], level: -32, rev: 0.9 },
  ],
};

const TREE: ProfileDef = {
  id: 'tree',
  title: 'Branching Lightning',
  key: 'G',
  mode: 'Mixolydian',
  description: 'Soft electric-piano melodies that fork into two voices and rejoin, with distant thunder swells.',
  bpm: 70,
  beatsPerBar: 4,
  root: 43,
  scale: MODES.mixolydian,
  chords: [
    { d: [0, 4, 8, 9], next: [1, 1, 2, 5] }, // G(add9)
    { d: [6, 7, 8, 10], next: [0, 2] }, // F(add9)
    { d: [3, 5, 7, 9], next: [0, 3, 5] }, // Cmaj7
    { d: [1, 3, 5, 7], next: [5, 1] }, // Am7
    { d: [5, 7, 9, 11], next: [1, 0] }, // Em7
    { d: [4, 6, 8, 10], next: [0, 4, 1] }, // Dm7 (the Mixolydian v)
  ],
  barsPerChord: [2, 3],
  echo: { beats: 0.75, feedback: 0.3 },
  layers: [
    { kind: 'pad', voice: 'warmPad', register: [50, 74], notes: 4, vel: [0.4, 0.55], cutoff: 600, cutoffOctaves: 1.4, lfoHz: 0.03, q: 1.0, chorus: 0.45, color: true, level: -10, rev: 0.6 },
    { kind: 'drone', voice: 'bass', register: [36, 48], mode: 'root', vel: 0.55, level: -14, rev: 0.2 },
    { kind: 'motif', style: 'fork', voice: 'ePiano', voice2: 'ePiano', register: [55, 84], vel: 0.5, density: 0.65, startBar: 2, level: -9, rev: 0.45, dly: 0.3 },
    { kind: 'texture', noise: 'brown', filter: 'lowpass', range: [70, 320], q: 0.7, bars: [4, 8], mode: 'thunder', level: -16, rev: 0.85 },
  ],
};

const BH_EYE: ProfileDef = {
  id: 'bh-eye',
  title: 'Frame Dragging',
  key: 'B',
  mode: 'Phrygian',
  description: 'Auto-panned swirling pads around an endlessly descending Shepard scale — the feeling of being pulled in.',
  bpm: 48,
  beatsPerBar: 4,
  root: 47,
  scale: MODES.phrygian,
  chords: [
    { d: [0, 2, 4, 7], next: [1, 1, 2, 4] }, // Bm
    { d: [1, 3, 5, 7], next: [0, 2] }, // Cmaj7 (the Phrygian bII)
    { d: [5, 7, 9, 11], next: [3, 0] }, // Gmaj7
    { d: [6, 8, 10, 12], next: [1, 0] }, // Am7
    { d: [3, 5, 7, 9], next: [1, 0] }, // Em7
  ],
  barsPerChord: [2, 3],
  echo: { beats: 1, feedback: 0.4 },
  trim: -1,
  layers: [
    { kind: 'pad', voice: 'darkPad', register: [47, 71], notes: 4, vel: [0.4, 0.55], cutoff: 480, cutoffOctaves: 1.3, lfoHz: 0.025, q: 1.4, chorus: 0.35, autopan: { hz: 0.09, depth: 0.85 }, level: -12, rev: 0.7 },
    { kind: 'shepard', baseMidi: 35, octaves: 5, stepBeats: 2, glide: 0.6, direction: -1, level: -31, rev: 0.6 },
    { kind: 'drone', voice: 'sub', register: [35, 47], mode: 'pedal', vel: 0.55, level: -16, rev: 0.25 },
    { kind: 'texture', noise: 'pink', filter: 'bandpass', range: [200, 900], q: 1.5, bars: [2, 3], level: -10, rev: 0.6 },
  ],
};

const BH_MAW: ProfileDef = {
  id: 'bh-maw',
  title: 'Schwarzschild Abyss',
  key: 'C',
  mode: 'minor with Locrian hints',
  description: 'Deep sub drones, low brass-like swells and a slow heartbeat; a Neapolitan D♭ chord glows in the dark.',
  bpm: 40,
  beatsPerBar: 4,
  root: 36,
  scale: MODES.aeolian,
  chords: [
    { d: [0, 4, 7, 9], next: [1, 2, 3, 5] }, // Cm (open)
    { d: [5, 7, 9, 11], next: [0, 3] }, // Abmaj7
    { d: [3, 5, 7, 11], next: [0, 4] }, // Fm(add9)
    { d: [1, 3, 5, 7], alt: [-1, 0, 0, 0], next: [0, 0] }, // Dbmaj7 (Neapolitan)
    { d: [6, 7, 10], next: [0, 5] }, // Bbsus2
    { d: [2, 4, 6, 8], next: [2, 1] }, // Ebmaj7
  ],
  barsPerChord: [2, 3],
  echo: { beats: 0.5, feedback: 0.3 },
  layers: [
    { kind: 'drone', voice: 'sub', register: [36, 48], mode: 'pedal', octaveBelow: true, vel: 0.6, level: -15, rev: 0.2 },
    { kind: 'pad', voice: 'brassPad', register: [43, 67], notes: 4, vel: [0.4, 0.55], cutoff: 320, cutoffOctaves: 1.5, lfoHz: 0.018, q: 1.2, chorus: 0.3, level: -10, rev: 0.6 },
    { kind: 'pulse', note: 36, every: 1, vel: 0.6, level: -15, rev: 0.35 },
    { kind: 'texture', noise: 'brown', filter: 'lowpass', range: [90, 380], q: 0.9, bars: [2, 3], level: -20, rev: 0.5 },
    { kind: 'motif', style: 'bells', voice: 'bell', register: [72, 86], vel: 0.45, density: 0.4, startBar: 4, level: -14, rev: 0.95, dly: 0.3 },
  ],
};

const ALL: ProfileDef[] = [VOID, BULB, MENGER, BOX, JULIA, SIERPINSKI, APOLLONIAN, KLEINIAN, KIFS, TREE, BH_EYE, BH_MAW];

export const PROFILE_DEFS: Readonly<Record<string, ProfileDef>> = Object.fromEntries(ALL.map((p) => [p.id, p]));

/** Profile by id; unknown ids fall back to the void. */
export function getProfile(id: string | null | undefined): ProfileDef {
  return (id && PROFILE_DEFS[id]) || VOID;
}

/** Display summary of a profile (for the HUD / codex). */
export interface MusicProfileInfo {
  id: string;
  title: string;
  key: string;
  mode: string;
  bpm: number;
  meter: string;
  description: string;
}

export const MUSIC_PROFILES: Readonly<Record<string, MusicProfileInfo>> = Object.fromEntries(
  ALL.map((p) => [
    p.id,
    { id: p.id, title: p.title, key: p.key, mode: p.mode, bpm: p.bpm, meter: `${p.beatsPerBar}/4`, description: p.description },
  ]),
);
