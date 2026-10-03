/**
 * Game-mode registry (design/60-first-light-build.md §S): start-screen cards, the `?mode=` URL
 * parameter, the remembered choice, and the factory the App uses. The Voyage is the app with no
 * game mode, so it has a card here but no GameMode class.
 *
 * `VITE_MODES` (build env, comma list of mode ids, e.g. "voyage,firstlight") may hide modes;
 * unset or empty shows all of them.
 */
import type { ControlSummary } from '../hud/controls';
import { VOYAGE_SUMMARY } from '../hud/controls';
import { FirstLightMode } from './firstlight/FirstLightMode';
import type { GameMode, GameModeId, ModeId } from './platform/GameMode';

export interface GameModeInfo {
  id: ModeId;
  title: string;
  tagline: string;
  /** Start-screen footer controls summary while this card is selected. */
  summary: readonly ControlSummary[];
}

/** Every mode, the Voyage first (start-screen card order). */
export const GAME_MODE_INFO: readonly GameModeInfo[] = [
  {
    id: 'voyage',
    title: 'Voyage',
    tagline: 'Drift freely through the fractal nebulae · no goals, no clock',
    summary: VOYAGE_SUMMARY,
  },
  {
    id: 'firstlight',
    title: 'First Light',
    tagline: 'Bend starlight with gravity to wake the dark seeds · a puzzle',
    summary: [
      { keys: ['MOUSE'], text: 'look' },
      { keys: ['W', 'A', 'S', 'D'], text: 'fly' },
      { keys: ['LMB'], text: 'place mass' },
      { keys: ['RMB'], text: 'remove' },
      { keys: ['Tab'], text: 'lab view' },
      { keys: ['Z'], text: 'undo' },
      { keys: ['Esc'], text: 'pause' },
    ],
  },
];

/** localStorage key of the last chosen mode. */
const MODE_KEY = 'fractal-nebulae.mode';

export function createGameMode(id: GameModeId): GameMode {
  switch (id) {
    case 'firstlight':
      return new FirstLightMode();
  }
}

/** Modes this build offers (VITE_MODES filter; a filter that matches nothing offers all). */
export function availableModes(): GameModeInfo[] {
  // `?.`: import.meta.env only exists under Vite (a Node tool importing this module gets all modes).
  const raw: unknown = import.meta.env?.VITE_MODES;
  if (typeof raw !== 'string' || raw.trim() === '') return GAME_MODE_INFO.slice();
  const wanted = new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  const list = GAME_MODE_INFO.filter((m) => wanted.has(m.id));
  return list.length > 0 ? list : GAME_MODE_INFO.slice();
}

/** `id` names one of `modes`. */
export function isModeId(modes: readonly GameModeInfo[], id: unknown): id is ModeId {
  return typeof id === 'string' && modes.some((m) => m.id === id);
}

/** Pre-selected mode: `?mode=` if valid, else the remembered choice if valid, else the first mode. */
export function initialModeId(modes: readonly GameModeInfo[], search: string = window.location.search): ModeId {
  let param: string | null = null;
  try {
    param = new URLSearchParams(search).get('mode');
  } catch {
    /* malformed query */
  }
  const fromUrl = param?.trim().toLowerCase();
  if (isModeId(modes, fromUrl)) return fromUrl;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(MODE_KEY);
  } catch {
    /* storage unavailable */
  }
  if (isModeId(modes, stored)) return stored;
  return modes[0]?.id ?? 'voyage';
}

/** Remember the chosen mode for the next visit. */
export function rememberMode(id: ModeId): void {
  try {
    localStorage.setItem(MODE_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Keep the URL in step with the mode (`?mode=firstlight`; the Voyage removes the parameter) without
 * a navigation or a history entry. Other parameters (level, daily…) are left alone.
 */
/** URL parameters that belong to a game mode (cleared when the Voyage takes over). */
const MODE_PARAMS = ['level', 'daily'] as const;

export function writeModeParam(id: ModeId): void {
  try {
    const url = new URL(window.location.href);
    const cur = url.searchParams.get('mode');
    if (id === 'voyage') {
      // Mode-specific parameters (First Light's level / daily) must not outlive the mode: a reload
      // after switching to the Voyage would otherwise jump straight back into that level.
      const stale = MODE_PARAMS.filter((k) => url.searchParams.has(k));
      if (cur === null && stale.length === 0) return;
      url.searchParams.delete('mode');
      for (const k of stale) url.searchParams.delete(k);
    } else {
      if (cur === id) return;
      url.searchParams.set('mode', id);
    }
    window.history.replaceState(window.history.state, '', url);
  } catch {
    /* history unavailable (sandboxed frame) */
  }
}
