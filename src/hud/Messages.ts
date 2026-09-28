/**
 * Transient text: the cinematic region banner, flash messages / physics tips, void facts and
 * the first-minute controls hints. DOM is only created when a message appears (never per frame).
 */
import { controlsList } from './controls';
import { el, shuffled } from './dom';

// ---------------------------------------------------------------------------------------------
// Region banner
// ---------------------------------------------------------------------------------------------

const BANNER_HOLD_MS = 6000;
const EXIT_HOLD_MS = 3600;

export interface BannerInfo {
  catalog: string;
  name: string;
  typeLine: string;
  tagline: string;
  blackHole: boolean;
}

export class RegionBanner {
  readonly root: HTMLElement;
  private timer = 0;
  private clearTimer = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'fn-banner', parent);
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
  }

  enter(info: BannerInfo): void {
    const card = this.fresh(`bn-card bn-enter${info.blackHole ? ' bn--bh' : ''}`);
    el('div', 'bn-catalog', card, `${info.catalog} · entering`);
    const name = el('div', 'bn-name', card);
    name.setAttribute('aria-label', info.name);
    // Letter-by-letter soft reveal; words stay unbreakable.
    let i = 0;
    for (const word of info.name.split(' ')) {
      if (i > 0) el('span', 'bn-space', name, ' ');
      const w = el('span', 'bn-word', name);
      for (const ch of word) {
        const s = el('span', 'bn-ch', w, ch);
        s.style.animationDelay = `${180 + i * 42}ms`;
        s.setAttribute('aria-hidden', 'true');
        i++;
      }
      i++;
    }
    el('div', 'bn-rule', card);
    el('div', 'bn-type', card, info.typeLine);
    if (info.tagline) el('div', 'bn-tag', card, info.tagline);
    this.schedule(card, BANNER_HOLD_MS + i * 42);
  }

  exit(name: string): void {
    // Never cut an arrival banner short with a departure note.
    if (this.root.querySelector('.bn-enter:not(.is-out)')) return;
    const card = this.fresh('bn-card bn-exit');
    el('span', 'bn-exit-k', card, 'Leaving');
    el('span', 'bn-exit-name', card, name);
    el('span', 'bn-exit-sep', card, '·');
    el('span', 'bn-exit-k', card, 'interstellar space');
    this.schedule(card, EXIT_HOLD_MS);
  }

  dispose(): void {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.clearTimer);
  }

  private fresh(cls: string): HTMLElement {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.clearTimer);
    for (const old of Array.from(this.root.children)) {
      old.classList.add('is-out');
      window.setTimeout(() => old.remove(), 900);
    }
    return el('div', cls, this.root);
  }

  private schedule(card: HTMLElement, holdMs: number): void {
    this.timer = window.setTimeout(() => {
      card.classList.add('is-out');
      this.clearTimer = window.setTimeout(() => card.remove(), 1600);
    }, holdMs);
  }
}

// ---------------------------------------------------------------------------------------------
// Flash messages & physics tips
// ---------------------------------------------------------------------------------------------

export type FlashKind = 'info' | 'warn' | 'tip';

interface FlashItem {
  text: string;
  kind: FlashKind;
  label: string;
  duration: number;
  /** Seconds it may wait in the queue before it is stale and dropped. */
  maxWait: number;
  waited: number;
}

const MAX_QUEUE = 4;
/** A newer tip may cut the current one short, but only after it has been readable this long (s). */
const TIP_MIN_SHOW_S = 7;

/**
 * One lane shows one message at a time. Status lines (info/warn) and tips use separate lanes
 * so a long physics tip never delays a timely status line.
 */
class FlashLane {
  readonly root: HTMLElement;
  private readonly queue: FlashItem[] = [];
  private current: { item: FlashItem; node: HTMLElement; left: number; age: number } | null = null;

  constructor(parent: HTMLElement, cls: string) {
    this.root = el('div', `fl-lane ${cls}`, parent);
  }

  has(text: string): boolean {
    return this.current?.item.text === text || this.queue.some((q) => q.text === text);
  }

  push(item: FlashItem): void {
    if (item.kind === 'warn') {
      // Warnings pre-empt whatever is showing.
      this.queue.unshift(item);
      if (this.current && this.current.item.kind !== 'warn') this.current.left = Math.min(this.current.left, 0.01);
      return;
    }
    if (this.queue.length >= MAX_QUEUE) {
      // Drop the oldest non-warning (a queued warning must never be evicted by chatter).
      const i = this.queue.findIndex((q) => q.kind !== 'warn');
      this.queue.splice(i >= 0 ? i : 0, 1);
    }
    this.queue.push(item);
    const cur = this.current;
    if (!cur) return;
    // A fresh status line cuts a lingering one short (keeps the lane responsive); a fresh tip
    // does the same once the current tip has had time to be read, so tips stay in context.
    if (item.kind === 'info' && cur.item.kind === 'info') cur.left = Math.min(cur.left, 0.9);
    else if (item.kind === 'tip' && cur.item.kind === 'tip') cur.left = Math.min(cur.left, Math.max(0.5, TIP_MIN_SHOW_S - cur.age));
  }

  update(dt: number): void {
    for (const q of this.queue) q.waited += dt;
    if (this.current) {
      this.current.left -= dt;
      this.current.age += dt;
      if (this.current.left > 0) return;
      const node = this.current.node;
      node.classList.add('is-out');
      window.setTimeout(() => node.remove(), 700);
      this.current = null;
      return; // one frame gap keeps exit and entry from overlapping visually
    }
    let next = this.queue.shift();
    while (next && next.waited > next.maxWait) next = this.queue.shift();
    if (!next) return;
    const node = el('div', `fl-msg fl-${next.kind}`, this.root);
    if (next.kind === 'warn') el('i', 'fl-warn-ico', node);
    if (next.label) el('div', 'fl-label', node, next.label);
    el('div', 'fl-text', node, next.text);
    this.current = { item: next, node, left: next.duration, age: 0 };
  }

  clear(): void {
    this.queue.length = 0;
    if (this.current) this.current.left = 0;
  }
}

export class FlashQueue {
  readonly root: HTMLElement;
  private readonly tips: FlashLane;
  private readonly status: FlashLane;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'fn-flash', parent);
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.tips = new FlashLane(this.root, 'fl-lane--tip');
    this.status = new FlashLane(this.root, 'fl-lane--status');
  }

  push(text: string, kind: FlashKind = 'info', label = ''): void {
    const t = text.trim();
    if (!t) return;
    const lane = kind === 'tip' ? this.tips : this.status;
    if (lane.has(t)) return;
    const base = kind === 'tip' ? 5 : kind === 'warn' ? 4.5 : 3.2;
    const duration = Math.min(base + t.length * 0.045, kind === 'tip' ? 12 : 7);
    const maxWait = kind === 'tip' ? 14 : kind === 'warn' ? 4 : 4.5;
    lane.push({ text: t, kind, label, duration, maxWait, waited: 0 });
  }

  update(dt: number): void {
    this.tips.update(dt);
    this.status.update(dt);
  }

  /** Drop pending and current status lines (e.g. a horizon warning made obsolete by transit). */
  clearStatus(): void {
    this.status.clear();
  }

  clear(): void {
    this.tips.clear();
    this.status.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Void facts
// ---------------------------------------------------------------------------------------------

const VOID_INTERVAL_S = 50;
const VOID_FIRST_S = 28;
const VOID_SHOW_S = 10;

export class VoidFacts {
  readonly root: HTMLElement;
  private readonly textEl: HTMLElement;
  private order: string[] = [];
  private cursor = 0;
  private acc = VOID_INTERVAL_S - VOID_FIRST_S;
  private showLeft = 0;
  private lastShown = '';

  constructor(parent: HTMLElement, private readonly facts: readonly string[]) {
    this.root = el('div', 'fn-voidfact', parent);
    this.root.setAttribute('aria-live', 'polite');
    el('div', 'vf-label', this.root, 'Deep-space log');
    this.textEl = el('div', 'vf-text', this.root);
  }

  /** dt is flight time; inVoid = no region and nothing else demanding attention. */
  update(dt: number, inVoid: boolean): void {
    if (this.showLeft > 0) {
      this.showLeft -= dt;
      if (this.showLeft <= 0 || !inVoid) this.hide();
      return;
    }
    if (!inVoid || this.facts.length === 0) return;
    this.acc += dt;
    if (this.acc >= VOID_INTERVAL_S) {
      this.acc = 0;
      this.show(this.next());
    }
  }

  hide(): void {
    this.showLeft = 0;
    this.root.classList.remove('is-on');
  }

  private show(text: string): void {
    this.textEl.textContent = text;
    this.showLeft = VOID_SHOW_S;
    this.root.classList.add('is-on');
  }

  /** Cycle through a shuffled order; reshuffle when exhausted, never repeating back-to-back. */
  private next(): string {
    if (this.cursor >= this.order.length) {
      this.order = shuffled(this.facts);
      this.cursor = 0;
      if (this.order.length > 1 && this.order[0] === this.lastShown) {
        const t = this.order[0];
        this.order[0] = this.order[1];
        this.order[1] = t;
      }
    }
    this.lastShown = this.order[this.cursor++];
    return this.lastShown;
  }
}

// ---------------------------------------------------------------------------------------------
// Controls hints (first minute)
// ---------------------------------------------------------------------------------------------

const HINTS_DELAY_S = 1.5;
/** Hints stay up for this much *visible* time... */
const HINTS_SHOW_S = 60;
/** ...but never linger past this long after (re)start, however often they were suppressed. */
const HINTS_MAX_S = 240;

export class HintsOverlay {
  readonly root: HTMLElement;
  private time = 0;
  private visibleTime = 0;
  private enabled: boolean;
  private shown = false;

  constructor(parent: HTMLElement, enabled: boolean) {
    this.enabled = enabled;
    this.root = el('div', 'fn-hints', parent);
    this.root.setAttribute('aria-hidden', 'true');
    el('div', 'hn-title', this.root, 'Controls');
    controlsList(this.root, true);
  }

  /** Restart the one-minute window (after launch, or when hints are re-enabled). */
  restart(): void {
    this.time = 0;
    this.visibleTime = 0;
  }

  setEnabled(on: boolean): void {
    if (on && !this.enabled) this.restart();
    this.enabled = on;
  }

  /**
   * `suppressed`: something else occupies the right side (the codex, which opens on its own on
   * the first region entry right after launch). Only unsuppressed time counts toward the minute.
   */
  update(dt: number, suppressed: boolean): void {
    this.time += dt;
    const on =
      this.enabled && !suppressed && this.time >= HINTS_DELAY_S && this.visibleTime < HINTS_SHOW_S && this.time < HINTS_MAX_S;
    if (on) this.visibleTime += dt;
    if (on !== this.shown) {
      this.shown = on;
      this.root.classList.toggle('is-on', on);
    }
  }
}
