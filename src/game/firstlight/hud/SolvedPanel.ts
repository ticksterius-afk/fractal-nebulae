/**
 * The solved card (design/60-first-light-build.md §H): the quiet peak after the ignition
 * ceremony. No box: a spiked star blooms, the title arrives letter by letter, a hairline draws
 * outward, then the teaching line, the numbers and the actions, staged with CSS delays only (so
 * prefers-reduced-motion collapses the whole reveal). Bottom-anchored, so the lit nebula above
 * stays in view. The daily variant adds the share string with Copy feedback, streak and next-in.
 *
 * Keyboard: Enter = the primary action (Next, or the Atlas at a chapter's end) unless a card
 * button has focus (then that button); Space activates a focused card button. The game does not
 * see these keys while the card is open.
 */
import { keyChips } from '../../../hud/controls';
import { el, markup, TextSlot } from '../../../hud/dom';
import type { FirstLightHudCallbacks, SolvedCard } from './hudTypes';
import { blurWithin, button, SPIKED_STAR } from './hudDom';

/** Two activations closer than this are one (a double Enter must never skip a level). */
const ACTION_DEBOUNCE_MS = 450;
const COPY_STATUS_MS = 4500;

export class SolvedPanel {
  readonly root: HTMLElement;
  private readonly inner: HTMLElement;
  private _open = false;
  private hideTimer = 0;
  private copyTimer = 0;
  private lastAction = -Infinity;
  /** Bumped on every show(): a late clipboard result for an older card is ignored. */
  private token = 0;
  private primary: (() => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly cb: FirstLightHudCallbacks,
  ) {
    const root = (this.root = el('section', 'flh-solved', parent));
    root.hidden = true;
    root.tabIndex = -1;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-labelledby', 'flh-sv-title');
    el('div', 'flh-sv-glow', root).setAttribute('aria-hidden', 'true');
    this.inner = el('div', 'flh-sv-inner', root);
  }

  get open(): boolean {
    return this._open;
  }

  show(card: SolvedCard): void {
    this.token++;
    window.clearTimeout(this.hideTimer);
    window.clearTimeout(this.copyTimer);
    this.render(card);
    this._open = true;
    this.root.hidden = false;
    this.root.classList.remove('is-out');
    this.root.classList.toggle('is-daily', card.isDaily);
    // Focus the card itself (not a button): screen readers announce it; Enter goes through onKey.
    this.root.focus({ preventScroll: true });
  }

  hide(): void {
    if (!this._open) return;
    this._open = false;
    this.token++;
    blurWithin(this.root);
    if (document.activeElement === this.root) this.root.blur();
    this.root.classList.add('is-out');
    window.clearTimeout(this.hideTimer);
    window.clearTimeout(this.copyTimer);
    this.hideTimer = window.setTimeout(() => {
      if (!this._open) this.root.hidden = true;
    }, 650);
  }

  /** Keyboard while open. Returns true when the game must not see the key. */
  onKey(e: KeyboardEvent): boolean {
    const code = e.code;
    if (code !== 'Enter' && code !== 'NumpadEnter' && code !== 'Space') return false;
    if (e.altKey) return false; // Alt+Enter = full screen
    const active = document.activeElement;
    const onButton = active instanceof HTMLButtonElement && this.root.contains(active);
    if (e.repeat) {
      e.preventDefault();
      return true;
    }
    if (onButton && code !== 'Space') return true; // the button's own Enter activation runs
    e.preventDefault();
    if (onButton) {
      if (!active.disabled) active.click();
    } else if (code !== 'Space') {
      this.primary?.();
    }
    return true;
  }

  dispose(): void {
    this.token++;
    window.clearTimeout(this.hideTimer);
    window.clearTimeout(this.copyTimer);
    this.root.remove();
  }

  // -------------------------------------------------------------------------------------------

  private act(fn: () => void): () => void {
    return () => {
      if (!this._open) return;
      const now = performance.now();
      if (now - this.lastAction < ACTION_DEBOUNCE_MS) return;
      this.lastAction = now;
      fn();
    };
  }

  private render(c: SolvedCard): void {
    const inner = this.inner;
    inner.replaceChildren();

    markup(SPIKED_STAR, el('div', 'flh-sv-star', inner));
    el('div', 'flh-sv-kicker', inner, c.isDaily ? 'Daily puzzle' : 'Every seed is burning');

    // Title: letter-by-letter soft reveal; words never break; the heading keeps its plain label.
    const title = el('h2', 'flh-sv-title', inner);
    title.id = 'flh-sv-title';
    title.setAttribute('aria-label', c.title);
    let i = 0;
    for (const word of c.title.split(' ')) {
      if (i > 0) el('span', 'flh-sv-space', title, ' ').setAttribute('aria-hidden', 'true');
      const w = el('span', 'flh-sv-word', title);
      w.setAttribute('aria-hidden', 'true');
      for (const ch of word) {
        const s = el('span', 'flh-sv-ch', w, ch);
        s.style.setProperty('--i', String(i));
        i++;
      }
      i++;
    }
    inner.style.setProperty('--n', String(i));

    el('div', 'flh-sv-rule', inner).setAttribute('aria-hidden', 'true');
    if (c.teach) el('p', 'flh-sv-teach', inner, c.teach);

    // Numbers.
    const stats = el('div', 'flh-sv-stats', inner);
    const used = Number.isFinite(c.massesUsed) ? Math.max(0, Math.floor(c.massesUsed)) : 0;
    const par = Number.isFinite(c.par) ? Math.max(0, Math.floor(c.par)) : 0;
    if (c.isDaily && c.time) this.stat(stats, 'Time', c.time);
    this.stat(stats, used === 1 ? 'Mass' : 'Masses', String(used));
    if (!c.isDaily) this.stat(stats, 'Par', String(par));
    if (c.isDaily && c.streak !== undefined && Number.isFinite(c.streak)) this.stat(stats, 'Streak', String(Math.max(0, Math.floor(c.streak))));
    if (c.parMet && !c.help) {
      const m = el('span', 'flh-sv-mark', stats);
      m.setAttribute('aria-label', 'Mark earned: solved at par');
      el('span', 'flh-mark', m, '✦').setAttribute('aria-hidden', 'true');
      el('span', 'flh-k', m, 'At par').setAttribute('aria-hidden', 'true');
    }
    if (c.help) el('div', 'flh-sv-note', inner, 'Solved with help · replay it without the note to earn ✦');

    // Daily: the share string, Copy with feedback, next in.
    if (c.isDaily && c.share) {
      const wrap = el('div', 'flh-sv-share-wrap', inner);
      const pre = el('pre', 'flh-sv-share mono', wrap, c.share);
      pre.setAttribute('aria-label', 'Share text');
      const row = el('div', 'flh-sv-copy-row', wrap);
      const copy = button('flh-pill flh-pill--small', row, 'Copy the share text', () => this.copy(pre, status, statusEl));
      el('span', 'flh-pill-t', copy, 'Copy');
      const statusEl = el('span', 'flh-sv-copy-status', row);
      statusEl.setAttribute('role', 'status');
      statusEl.setAttribute('aria-live', 'polite');
      const status = new TextSlot(statusEl);
      if (c.nextIn) el('span', 'flh-sv-next', row, `Next daily in ${c.nextIn}`);
    }

    // Actions.
    const actions = el('div', 'flh-sv-actions', inner);
    const next = c.nextLabel;
    this.primary = this.act(next ? () => this.cb.onNext() : () => this.cb.onOpenAtlas());
    const prim = button('flh-btn flh-btn--primary', actions, null, this.primary);
    el('span', '', prim, next ?? 'Atlas');
    keyChips(prim, ['Enter']);
    const replay = button('flh-btn', actions, null, this.act(() => this.cb.onReplay()));
    el('span', '', replay, 'Replay');
    if (next) {
      const atlas = button('flh-btn', actions, null, this.act(() => this.cb.onOpenAtlas()));
      el('span', '', atlas, 'Atlas');
    }
  }

  private stat(parent: HTMLElement, k: string, v: string): void {
    const s = el('span', 'flh-stat', parent);
    el('span', 'flh-k', s, k);
    el('span', 'flh-sv-v mono', s, v);
  }

  private copy(pre: HTMLElement, status: TextSlot, statusEl: HTMLElement): void {
    const token = this.token;
    window.clearTimeout(this.copyTimer);
    status.set('Copying…');
    statusEl.removeAttribute('data-state');
    let p: Promise<boolean>;
    try {
      p = this.cb.onCopyShare();
    } catch {
      p = Promise.resolve(false);
    }
    p.catch(() => false).then((ok) => {
      if (token !== this.token) return;
      status.set(ok ? 'Copied' : 'Copy failed — select the text');
      statusEl.setAttribute('data-state', ok ? 'ok' : 'failed');
      if (!ok) this.selectText(pre);
      this.copyTimer = window.setTimeout(() => {
        if (token !== this.token) return;
        status.set('');
        statusEl.removeAttribute('data-state');
      }, ok ? COPY_STATUS_MS : COPY_STATUS_MS * 2);
    });
  }

  /** Select the share text so Ctrl+C works when the clipboard API refused. */
  private selectText(node: HTMLElement): void {
    try {
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      /* selection is a convenience only */
    }
  }
}
