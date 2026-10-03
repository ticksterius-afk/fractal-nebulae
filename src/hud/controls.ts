/**
 * The control scheme (ARCHITECTURE.md §4) and a renderer for key "chips", shared by the start
 * screen, the in-flight hints overlay and the pause screen. Game modes bring their own rows
 * (GameMode.controls); the pause screen lists them first, then SHARED_CONTROLS.
 */
import { el, markup } from './dom';

export type KeyGlyph = string | 'LMB' | 'RMB' | 'MOUSE' | 'WHEEL';

export interface ControlDef {
  keys: KeyGlyph[];
  action: string;
  /** Short form for compact lists. */
  short: string;
  /** Include in the compact in-flight hints overlay. */
  hint: boolean;
}

/** One item of the start-screen footer summary. */
export interface ControlSummary {
  keys: KeyGlyph[];
  text: string;
}

/** Rows every mode shares: the pause screen appends them after a game mode's own rows. */
export const SHARED_CONTROLS: ControlDef[] = [
  { keys: ['H'], action: 'Hide HUD (cinematic)', short: 'Hide HUD', hint: true },
  { keys: ['M'], action: 'Mute music', short: 'Mute', hint: true },
  { keys: ['Esc'], action: 'Pause & settings (hold to leave full screen)', short: 'Pause', hint: true },
  { keys: ['F11'], action: 'Full screen on / off (also Alt+Enter)', short: 'Full screen', hint: false },
];

/** The Voyage (no game mode): flight rows, then the shared rows. */
export const CONTROLS: ControlDef[] = [
  { keys: ['MOUSE'], action: 'Look around', short: 'Look', hint: true },
  { keys: ['W', 'S'], action: 'Thrust forward / reverse', short: 'Thrust', hint: true },
  { keys: ['A', 'D'], action: 'Strafe left / right', short: 'Strafe', hint: true },
  { keys: ['Q', 'E'], action: 'Roll', short: 'Roll', hint: true },
  { keys: ['R', 'F'], action: 'Rise / sink', short: 'Rise / sink', hint: true },
  { keys: ['Shift'], action: 'Precision (slow, careful)', short: 'Precision', hint: true },
  { keys: ['WHEEL'], action: 'Cruise throttle', short: 'Throttle', hint: true },
  { keys: ['LMB'], action: 'Target the nebula under the reticle', short: 'Target', hint: true },
  { keys: ['RMB'], action: 'Hold · hyper + ghost (phase through structure, slower inside)', short: 'Hyper · ghost', hint: true },
  { keys: ['Space'], action: 'Tap · resonance pulse (reveals every nebula)', short: 'Pulse', hint: true },
  { keys: ['Space'], action: 'Hold · gravity-glide to target (or the nebula under the reticle)', short: 'Hold · glide', hint: true },
  { keys: ['T'], action: 'Voyage · zen auto-tour (T again to stop)', short: 'Voyage', hint: true },
  { keys: ['Tab', 'I'], action: 'Codex panel (pin / close)', short: 'Codex', hint: true },
  ...SHARED_CONTROLS,
];

/** Start-screen footer summary of the Voyage. */
export const VOYAGE_SUMMARY: ControlSummary[] = [
  { keys: ['MOUSE'], text: 'look' },
  { keys: ['W', 'A', 'S', 'D'], text: 'fly' },
  { keys: ['RMB'], text: 'hyper' },
  { keys: ['LMB'], text: 'target' },
  { keys: ['Space'], text: 'pulse · hold to glide' },
  { keys: ['T'], text: 'voyage' },
  { keys: ['Esc'], text: 'pause' },
];

const MOUSE_SVG = (fill: 'l' | 'r' | 'w' | 'none') => `
<svg class="kc-mouse" viewBox="0 0 12 16" aria-hidden="true">
  <rect x="0.75" y="0.75" width="10.5" height="14.5" rx="5.25" fill="none" stroke="currentColor" stroke-width="1"/>
  <line x1="6" y1="0.9" x2="6" y2="6.2" stroke="currentColor" stroke-width="1"/>
  <line x1="0.9" y1="6.2" x2="11.1" y2="6.2" stroke="currentColor" stroke-width="1"/>
  ${fill === 'l' ? '<path d="M1.2 6 V5.6 A4.8 4.8 0 0 1 5.6 1.2 H5.6 V6 Z" fill="currentColor" opacity="0.85"/>' : ''}
  ${fill === 'r' ? '<path d="M10.8 6 V5.6 A4.8 4.8 0 0 0 6.4 1.2 H6.4 V6 Z" fill="currentColor" opacity="0.85"/>' : ''}
  ${fill === 'w' ? '<rect x="5.1" y="2.2" width="1.8" height="3" rx="0.9" fill="currentColor"/>' : ''}
</svg>`;

const LABELS: Record<string, string> = { LMB: 'Left', RMB: 'Right', MOUSE: 'Mouse', WHEEL: 'Wheel' };

/** Append one key chip. */
export function keyChip(parent: HTMLElement, key: KeyGlyph): HTMLElement {
  const chip = el('span', 'kc', parent);
  if (key === 'LMB' || key === 'RMB' || key === 'MOUSE' || key === 'WHEEL') {
    chip.classList.add('kc--mouse');
    markup(MOUSE_SVG(key === 'LMB' ? 'l' : key === 'RMB' ? 'r' : key === 'WHEEL' ? 'w' : 'none'), chip);
    el('span', 'kc-t', chip, LABELS[key]);
  } else {
    if (key.length > 1) chip.classList.add('kc--wide');
    chip.textContent = key;
  }
  return chip;
}

/** Keys of one control as chips joined by thin separators. */
export function keyChips(parent: HTMLElement, keys: KeyGlyph[]): HTMLElement {
  const wrap = el('span', 'kcs', parent);
  keys.forEach((k, i) => {
    if (i > 0) el('span', 'kc-sep', wrap, '/');
    keyChip(wrap, k);
  });
  return wrap;
}

/** A two-column list of controls (keys | action); the Voyage table unless `rows` is given. */
export function controlsList(
  parent: HTMLElement,
  compact: boolean,
  className = '',
  rows: readonly ControlDef[] = CONTROLS,
): HTMLElement {
  const list = el('div', `ctl-list${compact ? ' ctl-list--compact' : ''}${className ? ' ' + className : ''}`, parent);
  for (const c of rows) {
    if (compact && !c.hint) continue;
    const row = el('div', 'ctl-row', list);
    keyChips(row, c.keys);
    el('span', 'ctl-action', row, compact ? c.short : c.action);
  }
  return list;
}
