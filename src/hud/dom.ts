/**
 * Tiny DOM helpers for the HUD. Everything here is written so per-frame callers only touch
 * the DOM when a value actually changes (no layout thrash, minimal style invalidation).
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  parent?: Node | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** Parse a trusted, static markup snippet (icons) into an element. */
export function markup<T extends Element = Element>(html: string, parent?: Node | null): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  const node = t.content.firstElementChild as T | null;
  if (!node) throw new Error('[hud] empty markup');
  if (parent) parent.appendChild(node);
  return node;
}

/** A text node that is only written when its value changes. */
export class TextSlot {
  private readonly node: Text;
  private value: string;

  constructor(parent: Node, initial = '') {
    this.value = initial;
    this.node = document.createTextNode(initial);
    parent.appendChild(this.node);
  }

  set(v: string): void {
    if (v === this.value) return;
    this.value = v;
    this.node.data = v;
  }

  get(): string {
    return this.value;
  }
}

/** Element + TextSlot in one call. */
export function textEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: Node,
  initial = '',
): TextSlot {
  return new TextSlot(el(tag, className, parent), initial);
}

/** Opacity writer with change threshold (exact 0 and 1 are always honoured). */
export class OpacitySlot {
  private last = -1;
  constructor(private readonly target: HTMLElement | SVGElement) {}

  set(v: number): void {
    const o = v <= 0.002 ? 0 : v >= 0.998 ? 1 : v;
    if (o === this.last) return;
    if (Math.abs(o - this.last) < 0.006 && o !== 0 && o !== 1) return;
    this.last = o;
    this.target.style.opacity = o === 1 ? '' : o.toFixed(3);
  }
}

/**
 * Position writer: translate3d (+ optional rotation / anchor) only when the rounded values
 * change. Text-bearing elements should snap to whole pixels (`step = 1`) to stay crisp.
 */
export class TransformSlot {
  private lx = NaN;
  private ly = NaN;
  private la = NaN;
  private lb = NaN;
  private readonly inv: number;

  constructor(
    private readonly target: HTMLElement,
    step = 0.1,
  ) {
    this.inv = 1 / step;
  }

  private r(v: number): number {
    return Math.round(v * this.inv) / this.inv;
  }

  move(x: number, y: number): void {
    const rx = this.r(x);
    const ry = this.r(y);
    if (rx === this.lx && ry === this.ly && Number.isNaN(this.la)) return;
    this.lx = rx;
    this.ly = ry;
    this.la = NaN;
    this.target.style.transform = `translate3d(${rx}px,${ry}px,0)`;
  }

  /** translate3d(x, y) then rotate(a rad). */
  moveRotate(x: number, y: number, a: number): void {
    const rx = this.r(x);
    const ry = this.r(y);
    const ra = Math.round(a * 500) / 500;
    if (rx === this.lx && ry === this.ly && ra === this.la) return;
    this.lx = rx;
    this.ly = ry;
    this.la = ra;
    this.target.style.transform = `translate3d(${rx}px,${ry}px,0) rotate(${ra}rad)`;
  }

  /** translate3d(x, y) then a self-relative anchor translate(ax %, ay %). */
  moveAnchored(x: number, y: number, ax: number, ay: number): void {
    const rx = this.r(x);
    const ry = this.r(y);
    const rax = Math.round(ax);
    const ray = Math.round(ay);
    if (rx === this.lx && ry === this.ly && rax === this.la && ray === this.lb) return;
    this.lx = rx;
    this.ly = ry;
    this.la = rax;
    this.lb = ray;
    this.target.style.transform = `translate3d(${rx}px,${ry}px,0) translate(${rax}%,${ray}%)`;
  }

  /** scaleX(s) for bars (0..1), rounded to 1/1000. */
  scaleX(s: number): void {
    const v = Math.round(Math.min(Math.max(Number.isFinite(s) ? s : 0, 0), 1) * 1000) / 1000;
    if (v === this.lx) return;
    this.lx = v;
    this.target.style.transform = `scaleX(${v})`;
  }

  reset(): void {
    this.lx = this.ly = this.la = this.lb = NaN;
    this.target.style.transform = '';
  }
}

/** classList.toggle that remembers the last state so it never touches the DOM needlessly. */
export class ClassSlot {
  private state: boolean | null = null;
  constructor(
    private readonly target: Element,
    private readonly cls: string,
  ) {}

  set(on: boolean): void {
    if (on === this.state) return;
    this.state = on;
    this.target.classList.toggle(this.cls, on);
  }

  get on(): boolean {
    return this.state === true;
  }
}

/** Fisher–Yates shuffle into a new array. */
export function shuffled<T>(items: readonly T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

export const prefersReducedMotion = (): boolean => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};
