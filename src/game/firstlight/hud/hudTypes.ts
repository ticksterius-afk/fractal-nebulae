/**
 * First Light HUD view-model contract (design/60-first-light-build.md §H).
 * FirstLightMode fills these plain objects; FirstLightHud renders them (DOM only, no game logic).
 */
import type { MassSize } from '../types';

export interface AtlasLevel {
  id: string;
  index: number;
  name: string;
  solved: boolean;
  /** Solved with ≤ par masses and no hint 3. */
  par: boolean;
  /** Solved after opening hint 3 ("with help"). */
  help: boolean;
  /** The level the player would resume. */
  current: boolean;
}

export interface AtlasChapter {
  id: string;
  /** e.g. "Bend". */
  name: string;
  /** e.g. "The Cauliflower Nebula". */
  nebulaName: string;
  /** The rule it teaches, one line. */
  rule: string;
  levels: AtlasLevel[];
  solvedCount: number;
  locked: boolean;
  /** Shown when locked, e.g. "Solve 4 puzzles in two chapters". */
  lockText?: string;
}

export interface AtlasDaily {
  /** e.g. "2026-10-02". */
  date: string;
  /** e.g. "First Light #42 · Menger". */
  label: string;
  solved: boolean;
  streak: number;
  /** "hh:mm" until the next daily (UTC midnight). */
  nextIn: string;
  /** Solve time "m:ss" when solved today. */
  time?: string;
}

export interface AtlasModel {
  chapters: AtlasChapter[];
  daily: AtlasDaily;
  /** Total ✦ earned / available, for the header. */
  stars: number;
  starsTotal: number;
}

export interface LevelHeader {
  nebulaName: string;
  /** e.g. "Bend" (or "Daily"). */
  chapterName: string;
  index: number;
  total: number;
  /** e.g. "Almost". */
  name: string;
  isDaily: boolean;
}

export interface SeedChip {
  /** Goal seeds count toward the win; echo chips are drawn smaller. */
  goal: boolean;
  lit: boolean;
  /** 0..1 "almost" closeness (1 = the beam grazes it), drives a brightening, never a number. */
  almost: number;
}

export interface MassChip {
  size: MassSize;
  total: number;
  placed: number;
}

export interface PlayHudState {
  view: 'flight' | 'lab';
  seeds: SeedChip[];
  masses: MassChip[];
  selected: MassSize;
  /** Placement legality under the reticle / cursor; null when not placing (e.g. budget spent, hovering a mass). */
  placement: { legal: boolean; reason: string | null } | null;
  /** Depth gauge beside the reticle: placement depth as a fraction 0..1 of the surface-hit distance; null hides it. */
  depth: number | null;
  /** True once the hint chip may show (≥ 2 min on the level, or the player asked before). */
  hintAvailable: boolean;
  /** Hint steps already revealed (0..3). */
  hintLevel: number;
  /** Daily elapsed time "m:ss", else null. */
  timer: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Something is being dragged (hides the placement reason). */
  dragging: boolean;
}

export interface SolvedCard {
  /** e.g. "First light" / "Daily solved". */
  title: string;
  /** The level's teaching line. */
  teach: string;
  massesUsed: number;
  par: number;
  parMet: boolean;
  help: boolean;
  /** Label of the next level button, e.g. "Next · Two Florets", or null at chapter end. */
  nextLabel: string | null;
  isDaily: boolean;
  /** Daily only. */
  share?: string;
  streak?: number;
  time?: string;
  nextIn?: string;
}

export interface FirstLightHudCallbacks {
  onSelectLevel(id: string): void;
  onDaily(): void;
  /** Close the atlas and return to the current level (only offered when one is loaded). */
  onCloseAtlas(): void;
  onNext(): void;
  onReplay(): void;
  onOpenAtlas(): void;
  /**
   * Reveal the next hint step (hint chip with no hint open yet, the panel's "Next hint" button).
   * A hint the player closed with × is reopened by the chip inside the HUD without this call.
   */
  onHint(): void;
  onSelectSize(size: MassSize): void;
  /** Copy the daily share string (the HUD shows "Copied" feedback from the promise). */
  onCopyShare(): Promise<boolean>;
  /** Undo / redo buttons beside the mass orbs (free cursor). Optional: without them the buttons are indicators only. */
  onUndo?(): void;
  onRedo?(): void;
}
