/**
 * Codex panel: a glass card on the right with the educational entry for the targeted nebula
 * (or the current region). Opens automatically — only on a target lock or the first entry into a
 * region, never at launch — and auto-hides after AUTO_HIDE_S; Tab/I pins it.
 * While the pointer is locked the panel cannot be scrolled by hand, so overflowing content
 * drifts slowly like a teleprompter (manual wheel scrolling pauses the drift).
 */
import type { CodexEntry, NebulaDef } from '../core/types';
import { formatDistance } from '../core/units';
import { el, TextSlot } from './dom';
import { nebulaTypeLine } from './format';
import { lightTimeText, targetDistanceText } from './Markers';

export type CodexContext = 'target' | 'region' | 'nearest';

/** An auto-opened (unpinned) card closes after this much flight time. */
const AUTO_HIDE_S = 12;
const FACT_ROTATE_S = 12;
const SCROLL_PX_PER_S = 15;
const HOLD_TOP_S = 7;
const HOLD_BOTTOM_S = 5;
const MANUAL_PAUSE_S = 20;

const CONTEXT_LABEL: Record<CodexContext, string> = {
  target: 'Target',
  region: 'Current region',
  nearest: 'Nearest nebula',
};

type ScrollPhase = 'top' | 'down' | 'bottom' | 'up';

export class CodexPanel {
  readonly root: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly body: HTMLElement;
  private readonly contextSlot: TextSlot;
  private readonly pinSlot: TextSlot;
  private readonly footSlot: TextSlot;
  private distSlot: TextSlot | null = null;
  private lightSlot: TextSlot | null = null;
  private facts: HTMLElement[] = [];
  private factIndex = 0;
  private factTimer = 0;

  private _open = false;
  private _pinned = false;
  private _id: string | null = null;
  private _context: CodexContext = 'region';
  private autoHideIn = 0;

  private phase: ScrollPhase = 'top';
  private phaseTime = 0;
  private scrollPos = 0;
  private overflow = 0;
  private needsMeasure = false;
  private manualPause = 0;

  constructor(
    parent: HTMLElement,
    private readonly codex: Record<string, CodexEntry>,
    private readonly defs: Map<string, NebulaDef>,
  ) {
    const root = (this.root = el('aside', 'fn-codex glass', parent));
    root.setAttribute('aria-label', 'Codex');
    root.setAttribute('aria-hidden', 'true');

    const head = el('div', 'cx-head', root);
    this.contextSlot = new TextSlot(el('span', 'cx-context', head), '');
    this.pinSlot = new TextSlot(el('span', 'cx-pin', head), '');

    this.scroller = el('div', 'cx-scroll', root);
    this.body = el('div', 'cx-body', this.scroller);
    this.footSlot = new TextSlot(el('div', 'cx-foot', root), '');

    this.scroller.addEventListener('wheel', () => {
      this.manualPause = MANUAL_PAUSE_S;
      this.scrollPos = this.scroller.scrollTop;
    }, { passive: true });
  }

  get open(): boolean {
    return this._open;
  }
  get pinned(): boolean {
    return this._pinned;
  }
  get id(): string | null {
    return this._id;
  }
  get context(): CodexContext {
    return this._context;
  }

  /** Show `id`; auto = opened by an event (auto-hides unless pinned). */
  show(id: string, context: CodexContext, auto: boolean): void {
    this.setContent(id, context);
    if (!this._open) {
      this._open = true;
      this._pinned = !auto;
      this.root.classList.add('is-open');
      this.root.setAttribute('aria-hidden', 'false');
    } else if (!auto) {
      this._pinned = true;
    }
    this.autoHideIn = AUTO_HIDE_S;
    this.refreshChrome();
  }

  /** Swap the displayed entry without changing open/pinned state. */
  setContent(id: string, context: CodexContext): void {
    this._context = context;
    this.contextSlot.set(CONTEXT_LABEL[context]);
    if (id === this._id) return;
    this._id = id;
    this.build(id);
  }

  /** Tab / I: closed → open pinned; open (auto) → pin; pinned → close. */
  toggle(fallback: { id: string; context: CodexContext } | null): boolean {
    if (this._open && this._pinned) {
      this.close();
      return true;
    }
    if (this._open) {
      this._pinned = true;
      this.refreshChrome();
      return true;
    }
    if (!fallback) return false;
    this.show(fallback.id, fallback.context, false);
    return true;
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this._pinned = false;
    this.root.classList.remove('is-open', 'is-pinned');
    this.root.setAttribute('aria-hidden', 'true');
  }

  /** Width in CSS px for layout avoidance (0 when closed). Reads layout — call in read phase. */
  measureWidth(): number {
    return this._open ? this.root.offsetWidth : 0;
  }

  /** Must be called before any DOM writes in the frame (it may read layout). */
  readPhase(): void {
    if (this.needsMeasure && this._open) {
      this.needsMeasure = false;
      this.overflow = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
    }
  }

  invalidateLayout(): void {
    this.needsMeasure = true;
  }

  /** Call early in the frame's write phase: scrollTop writes want a clean layout. */
  update(dt: number, liveDistance: number): void {
    if (!this._open) return;
    if (!this._pinned) {
      this.autoHideIn -= dt;
      if (this.autoHideIn <= 0) {
        this.close();
        return;
      }
    }

    this.autoScroll(dt);

    if (this.facts.length > 1) {
      this.factTimer += dt;
      if (this.factTimer >= FACT_ROTATE_S) {
        this.factTimer = 0;
        this.facts[this.factIndex].classList.remove('is-on');
        this.factIndex = (this.factIndex + 1) % this.facts.length;
        this.facts[this.factIndex].classList.add('is-on');
      }
    }

    if (this.distSlot && Number.isFinite(liveDistance)) {
      this.distSlot.set(targetDistanceText(liveDistance));
      this.lightSlot?.set(lightTimeText(liveDistance));
    }
  }

  private autoScroll(dt: number): void {
    if (this.manualPause > 0) {
      this.manualPause -= dt;
      return;
    }
    if (this.overflow < 6) return;
    this.phaseTime += dt;
    switch (this.phase) {
      case 'top':
        if (this.phaseTime >= HOLD_TOP_S) this.setPhase('down');
        break;
      case 'down':
        this.scrollPos = Math.min(this.overflow, this.scrollPos + SCROLL_PX_PER_S * dt);
        this.scroller.scrollTop = this.scrollPos;
        if (this.scrollPos >= this.overflow) this.setPhase('bottom');
        break;
      case 'bottom':
        if (this.phaseTime >= HOLD_BOTTOM_S) {
          this.scroller.scrollTo({ top: 0, behavior: 'smooth' });
          this.setPhase('up');
        }
        break;
      case 'up':
        if (this.phaseTime >= 1.2) {
          this.scrollPos = 0;
          this.setPhase('top');
        }
        break;
    }
  }

  private setPhase(p: ScrollPhase): void {
    this.phase = p;
    this.phaseTime = 0;
  }

  private refreshChrome(): void {
    this.pinSlot.set(this._pinned ? 'Pinned' : '');
    this.root.classList.toggle('is-pinned', this._pinned);
    this.footSlot.set(this._pinned ? 'Tab · close' : 'Tab · keep open');
  }

  private build(id: string): void {
    const def = this.defs.get(id);
    const entry: CodexEntry = this.codex[id] ?? {
      id,
      title: def?.name ?? id,
      fractalName: def ? nebulaTypeLine(def) : '',
      formula: '',
      dimension: '',
      discovered: '',
      summary: def?.tagline ?? '',
      nature: [],
      facts: [],
      musicNote: '',
    };

    const b = this.body;
    b.replaceChildren();
    this.facts = [];
    this.factIndex = 0;
    this.factTimer = 0;
    this.distSlot = null;
    this.lightSlot = null;

    const hdr = el('header', 'cx-titleblock', b);
    if (def) el('div', 'cx-catalog', hdr, def.catalog);
    el('h3', 'cx-title', hdr, entry.title || def?.name || id);
    if (entry.fractalName) el('div', 'cx-fractal', hdr, entry.fractalName);

    if (entry.formula) el('div', 'cx-formula mono', b, entry.formula);

    const stats = el('div', 'cx-stats', b);
    if (def) {
      this.stat(stats, def.fractal === 'blackhole' ? 'Lensing radius' : 'Radius', formatDistance(def.worldRadius));
    }
    this.distSlot = this.stat(stats, 'Distance', '—');
    this.lightSlot = this.stat(stats, 'Light-time', '—');

    if (entry.dimension || entry.discovered) {
      const meta = el('dl', 'cx-meta', b);
      if (entry.dimension) this.meta(meta, 'Dimension', entry.dimension);
      if (entry.discovered) this.meta(meta, 'Discovered', entry.discovered);
    }

    if (entry.summary) el('p', 'cx-summary', b, entry.summary);

    if (entry.nature.length) {
      const sec = this.section(b, 'Seen in nature', 'cx-nature');
      const ul = el('ul', 'cx-list', sec);
      for (const n of entry.nature) el('li', '', ul, n);
    }

    if (entry.facts.length) {
      const sec = this.section(b, 'Did you know', 'cx-facts');
      const ul = el('ul', 'cx-list cx-list--facts', sec);
      for (const f of entry.facts) this.facts.push(el('li', '', ul, f));
      this.facts[0].classList.add('is-on');
    }

    if (entry.physics && entry.physics.length) {
      const sec = this.section(b, 'Physics', 'cx-physics');
      const ul = el('ul', 'cx-list', sec);
      for (const p of entry.physics) el('li', '', ul, p);
    }

    if (entry.musicNote) {
      const m = el('p', 'cx-music', b);
      el('span', 'cx-note', m, '♪');
      el('span', '', m, entry.musicNote);
    }

    this.scroller.scrollTop = 0;
    this.scrollPos = 0;
    this.setPhase('top');
    this.needsMeasure = true;
    this.body.animate(
      [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
      { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  }

  private section(parent: HTMLElement, title: string, cls: string): HTMLElement {
    const sec = el('section', `cx-sec ${cls}`, parent);
    el('div', 'cx-sec-title', sec, title);
    return sec;
  }

  private meta(parent: HTMLElement, k: string, v: string): void {
    el('dt', 'cx-k', parent, k);
    el('dd', '', parent, v);
  }

  private stat(parent: HTMLElement, k: string, v: string): TextSlot {
    const s = el('div', 'cx-stat', parent);
    el('span', 'cx-k', s, k);
    return new TextSlot(el('span', 'cx-v mono', s), v);
  }
}
