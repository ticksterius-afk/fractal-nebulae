/**
 * Small DOM helpers for the First Light HUD, in the spirit of src/hud/dom.ts: every writer
 * remembers its last value so per-frame callers only touch the DOM when something changed.
 */
import { el } from '../../../hud/dom';

/** A CSS custom property (number), quantised to `step`, written only when the rounded value changes. */
export class VarSlot {
  private last = NaN;

  constructor(
    private readonly target: HTMLElement,
    private readonly name: string,
    private readonly step = 1 / 64,
  ) {}

  set(v: number): void {
    const q = Number.isFinite(v) ? Math.round(v / this.step) * this.step : 0;
    if (q === this.last) return;
    this.last = q;
    this.target.style.setProperty(this.name, q.toFixed(4));
  }
}

/** A boolean applied through a callback (hidden, disabled, aria-*), only on change. */
export class FlagSlot {
  private state: boolean | null = null;

  constructor(private readonly apply: (on: boolean) => void) {}

  set(on: boolean): void {
    if (on === this.state) return;
    this.state = on;
    this.apply(on);
  }

  get on(): boolean {
    return this.state === true;
  }
}

/** `hidden` attribute writer (the HUD stylesheet maps `[hidden]` to display: none). */
export function hiddenSlot(target: HTMLElement): FlagSlot {
  return new FlagSlot((on) => {
    target.hidden = on;
  });
}

/** An attribute that is only written when its string value changes. */
export class AttrSlot {
  private last: string | null | undefined = undefined;

  constructor(
    private readonly target: Element,
    private readonly name: string,
  ) {}

  set(v: string | null): void {
    if (v === this.last) return;
    this.last = v;
    if (v === null) this.target.removeAttribute(this.name);
    else this.target.setAttribute(this.name, v);
  }
}

/**
 * A real `<button type="button">`. A mouse click (detail > 0) drops focus again, so a focused
 * HUD button never sits between the player and the game keys (Enter / Space would re-fire it);
 * keyboard activation keeps focus for keyboard users.
 */
export function button(
  cls: string,
  parent: Node,
  ariaLabel: string | null,
  onClick: (e: MouseEvent) => void,
): HTMLButtonElement {
  const b = el('button', cls, parent);
  b.type = 'button';
  if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
  b.addEventListener('click', (e) => {
    if (e.detail > 0) b.blur();
    onClick(e);
  });
  return b;
}

/** Blur the focused element if it lives inside `root` (panels closing must not keep focus). */
export function blurWithin(root: HTMLElement): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && root.contains(active)) active.blur();
}

/** Text fields keep their keys (the HUD never steals typing). */
export function isTextField(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}

// ---------------------------------------------------------------------------------------------
// Icons (static, trusted markup; stroke = currentColor so CSS sets the colour)
// ---------------------------------------------------------------------------------------------

export const ICON_UNDO = `<svg class="flh-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 3.4 2.4 6.2 5.2 9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.8 6.2h6.4a3.6 3.6 0 0 1 0 7.2H6.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;

export const ICON_REDO = `<svg class="flh-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 3.4 13.6 6.2 10.8 9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.2 6.2H6.8a3.6 3.6 0 0 0 0 7.2h2.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;

export const ICON_CLOSE = `<svg class="flh-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;

/** Three linked stars: the Atlas. */
export const ICON_ATLAS = `<svg class="flh-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11.5 7.2 5.5 12.6 8.6" fill="none" stroke="currentColor" stroke-width="0.9" opacity="0.6"/><circle cx="3" cy="11.5" r="1.5" fill="currentColor"/><circle cx="7.2" cy="5.5" r="1.9" fill="currentColor"/><circle cx="12.6" cy="8.6" r="1.4" fill="currentColor"/></svg>`;

/**
 * A star with JWST-style diffraction spikes (six long, two short horizontal), for the solved
 * card. The spikes and the core are separate groups so CSS can bloom them one after the other.
 */
export const SPIKED_STAR = `
<svg class="flh-star" viewBox="-60 -60 120 120" aria-hidden="true">
  <defs>
    <radialGradient id="flh-star-core" cx="0" cy="0" r="26" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="0.18" stop-color="#e8fff8" stop-opacity="0.95"/>
      <stop offset="0.45" stop-color="#74f4d4" stop-opacity="0.38"/>
      <stop offset="1" stop-color="#74f4d4" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="flh-spike" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.95"/>
      <stop offset="0.35" stop-color="#bff9ea" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#74f4d4" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <g class="flh-star-spikes">
    <path d="M-1.3 0 0 -56 1.3 0Z" fill="url(#flh-spike)" transform="rotate(0)"/>
    <path d="M-1.3 0 0 -56 1.3 0Z" fill="url(#flh-spike)" transform="rotate(60)"/>
    <path d="M-1.3 0 0 -56 1.3 0Z" fill="url(#flh-spike)" transform="rotate(120)"/>
    <path d="M-1.3 0 0 -56 1.3 0Z" fill="url(#flh-spike)" transform="rotate(180)"/>
    <path d="M-1.3 0 0 -56 1.3 0Z" fill="url(#flh-spike)" transform="rotate(240)"/>
    <path d="M-1.3 0 0 -56 1.3 0Z" fill="url(#flh-spike)" transform="rotate(300)"/>
    <path d="M-0.9 0 0 -30 0.9 0Z" fill="url(#flh-spike)" transform="rotate(90)" opacity="0.7"/>
    <path d="M-0.9 0 0 -30 0.9 0Z" fill="url(#flh-spike)" transform="rotate(270)" opacity="0.7"/>
  </g>
  <circle class="flh-star-halo" r="26" fill="url(#flh-star-core)"/>
  <circle class="flh-star-core" r="3.2" fill="#ffffff"/>
</svg>`;
