/**
 * The Atlas (design/60-first-light-build.md §H, design/20-first-light.md §5.3): a centred glass
 * panel over a soft veil. Header with the ✦ count; one constellation strip per chapter (nebula,
 * chapter name, the rule it teaches, its level nodes joined by a hairline that lights up as the
 * levels are solved); the Daily strip.
 *
 * Keyboard: arrows move between nodes (left / right inside a chapter, up / down between chapters
 * and the Daily button, the column is remembered), Home / End jump inside a row, Enter / Space
 * open, Esc returns to the level when `canClose`. Roving tabindex; focus never scrolls the HUD.
 * The DOM is rebuilt on every show() (never per frame); focus survives a refresh.
 */
import { keyChips } from '../../../hud/controls';
import { el, markup, TextSlot } from '../../../hud/dom';
import type { AtlasChapter, AtlasDaily, AtlasLevel, AtlasModel, FirstLightHudCallbacks } from './hudTypes';
import { blurWithin, button, ICON_CLOSE } from './hudDom';

/** Vertical zigzag of the constellation nodes (px from the strip's mid-line). */
const NODE_OFFSETS = [5, -7, 2, -5, 7, -2, 4, -6];
/** Constellation box height (px); must match `.flh-cons` in firstlight.css. */
const CONS_H = 64;
const DAILY_KEY = '\u0000daily';

interface NodeRef {
  btn: HTMLButtonElement;
  /** Level id, or DAILY_KEY for the Daily button. */
  key: string;
  caption: string;
  strip: StripRef | null;
}

interface StripRef {
  cap: TextSlot;
  defaultCap: string;
  hover: NodeRef | null;
  focus: NodeRef | null;
}

export class AtlasPanel {
  readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private _open = false;
  private canClose = false;
  private hideTimer = 0;
  private rafId = 0;
  /** Enabled rows of buttons (unlocked chapters, then the Daily button). */
  private grid: NodeRef[][] = [];
  private row = 0;
  private col = 0;
  /** Column kept while moving up / down through shorter rows. */
  private wantCol = 0;

  constructor(
    parent: HTMLElement,
    private readonly cb: FirstLightHudCallbacks,
  ) {
    const root = (this.root = el('section', 'flh-atlas', parent));
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'flh-atlas-title');
    this.card = el('div', 'flh-at-card glass', root);
  }

  get open(): boolean {
    return this._open;
  }

  show(model: AtlasModel, canClose: boolean): void {
    const active = document.activeElement;
    const hadFocus = this._open && active instanceof HTMLElement && this.root.contains(active);
    const keepKey = this._open ? this.grid[this.row]?.[this.col]?.key ?? null : null;
    this.canClose = canClose;
    this.render(model);
    this.pickFocus(keepKey);

    window.clearTimeout(this.hideTimer);
    if (!this._open) {
      this._open = true;
      this.root.hidden = false;
      this.card.scrollTop = 0;
      // Next frame, so the opening transition runs from the hidden state.
      cancelAnimationFrame(this.rafId);
      this.rafId = requestAnimationFrame(() => {
        if (!this._open) return;
        this.root.classList.add('is-open');
        this.focusCurrent();
      });
    } else if (hadFocus) {
      this.focusCurrent();
    }
  }

  hide(): void {
    if (!this._open) return;
    this._open = false;
    cancelAnimationFrame(this.rafId);
    this.root.classList.remove('is-open');
    blurWithin(this.root);
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (!this._open) this.root.hidden = true;
    }, 520);
  }

  /** Keyboard while open. Returns true when the game must not see the key. */
  onKey(e: KeyboardEvent): boolean {
    const code = e.code;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown':
      case 'Home':
      case 'End':
        e.preventDefault();
        this.move(e.key);
        return true;
      case 'Escape':
        if (!this.canClose || e.repeat) return false;
        e.preventDefault();
        this.cb.onCloseAtlas();
        return true;
    }
    if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') {
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
      } else {
        this.grid[this.row]?.[this.col]?.btn.click();
      }
      return true;
    }
    return false;
  }

  dispose(): void {
    window.clearTimeout(this.hideTimer);
    cancelAnimationFrame(this.rafId);
    this.root.remove();
  }

  // -------------------------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------------------------

  private render(model: AtlasModel): void {
    const card = this.card;
    card.replaceChildren();
    this.grid = [];

    const head = el('header', 'flh-at-head', card);
    const titles = el('div', 'flh-at-titles', head);
    el('div', 'flh-at-kicker', titles, 'First Light');
    const h = el('h2', 'flh-at-title', titles, 'Atlas');
    h.id = 'flh-atlas-title';
    el('p', 'flh-at-sub', titles, 'One star in each nebula. Bend its light until every seed burns.');

    const side = el('div', 'flh-at-side', head);
    const marks = el('div', 'flh-at-marks', side);
    const stars = Number.isFinite(model.stars) ? Math.max(0, Math.floor(model.stars)) : 0;
    const total = Number.isFinite(model.starsTotal) ? Math.max(0, Math.floor(model.starsTotal)) : 0;
    marks.setAttribute('aria-label', `${stars} of ${total} marks earned`);
    el('span', 'flh-mark', marks, '✦').setAttribute('aria-hidden', 'true');
    el('span', 'flh-at-marks-v mono', marks, `${stars} / ${total}`).setAttribute('aria-hidden', 'true');
    el('span', 'flh-k', marks, 'Marks').setAttribute('aria-hidden', 'true');
    if (this.canClose) {
      const close = button('flh-pill flh-at-close', side, 'Return to the level (Esc)', () => {
        if (this._open) this.cb.onCloseAtlas();
      });
      markup(ICON_CLOSE, close);
      el('span', 'flh-pill-t', close, 'Return');
      keyChips(close, ['Esc']);
    }

    const list = el('div', 'flh-at-list', card);
    for (const ch of model.chapters) this.renderChapter(list, ch);
    this.renderDaily(list, model.daily);

    const foot = el('footer', 'flh-at-foot', card);
    foot.setAttribute('aria-hidden', 'true');
    const nav = el('span', 'flh-at-hint', foot);
    keyChips(nav, ['←', '→', '↑', '↓']);
    el('span', 'flh-ctl-t', nav, 'Choose');
    const go = el('span', 'flh-at-hint', foot);
    keyChips(go, ['Enter']);
    el('span', 'flh-ctl-t', go, 'Open');
    if (this.canClose) {
      const back = el('span', 'flh-at-hint', foot);
      keyChips(back, ['Esc']);
      el('span', 'flh-ctl-t', back, 'Return');
    }
  }

  private renderChapter(list: HTMLElement, ch: AtlasChapter): void {
    const n = ch.levels.length;
    const solved = Number.isFinite(ch.solvedCount) ? Math.max(0, Math.floor(ch.solvedCount)) : 0;
    const strip = el('section', `flh-ch${ch.locked ? ' is-locked' : ''}${n > 0 && solved >= n ? ' is-complete' : ''}`, list);
    strip.setAttribute('aria-label', `${ch.name}, ${ch.nebulaName}, ${solved} of ${n} solved${ch.locked ? ', locked' : ''}`);

    const info = el('div', 'flh-ch-info', strip);
    el('div', 'flh-ch-neb', info, ch.nebulaName);
    el('div', 'flh-ch-name', info, ch.name);
    el('div', 'flh-ch-rule', info, ch.rule);

    const map = el('div', 'flh-ch-map', strip);
    const top = el('div', 'flh-ch-top', map);
    el('span', 'flh-k', top, ch.locked ? 'Locked' : 'Lit');
    el('span', 'flh-v mono', top, `${solved} / ${n}`);

    const cons = el('div', 'flh-cons', map);
    // Hairline constellation (static numbers only → safe markup); lit where both ends are solved.
    const mid = CONS_H / 2;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i++) {
      xs.push(((i + 0.5) / n) * 600);
      ys.push(mid + NODE_OFFSETS[i % NODE_OFFSETS.length]);
    }
    let lines = '';
    for (let i = 0; i + 1 < n; i++) {
      const lit = ch.levels[i].solved && ch.levels[i + 1].solved;
      lines += `<line x1="${xs[i].toFixed(1)}" y1="${ys[i]}" x2="${xs[i + 1].toFixed(1)}" y2="${ys[i + 1]}"${lit ? ' class="is-lit"' : ''}/>`;
    }
    markup(`<svg class="flh-cons-lines" viewBox="0 0 600 ${CONS_H}" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>`, cons);

    const capEl = el('div', 'flh-ch-cap', map);
    const ref: StripRef = { cap: new TextSlot(capEl), defaultCap: this.defaultCaption(ch), hover: null, focus: null };
    ref.cap.set(ref.defaultCap);

    const row: NodeRef[] = [];
    for (let i = 0; i < n; i++) {
      const lv = ch.levels[i];
      const cls = ['flh-node'];
      if (lv.solved) cls.push('is-solved');
      if (lv.solved && lv.par) cls.push('is-par');
      if (lv.solved && lv.help) cls.push('is-help');
      if (lv.current) cls.push('is-current');
      const id = lv.id;
      // Guarded by _open: a double click must not select again while the panel fades out.
      const btn = button(cls.join(' '), cons, this.levelAria(lv), () => {
        if (this._open && !ch.locked) this.cb.onSelectLevel(id);
      });
      btn.style.left = `${(((i + 0.5) / n) * 100).toFixed(3)}%`;
      btn.style.top = `${ys[i]}px`;
      btn.tabIndex = -1;
      btn.disabled = ch.locked;
      el('i', 'flh-node-g', btn);
      if (lv.solved && lv.par) el('span', 'flh-node-star', btn, '✦');
      el('span', 'flh-node-n mono', btn, String(lv.index));
      const node: NodeRef = { btn, key: id, caption: this.levelCaption(lv), strip: ref };
      this.wireCaption(node);
      row.push(node);
    }
    if (!ch.locked && row.length > 0) this.grid.push(row);
  }

  private renderDaily(list: HTMLElement, d: AtlasDaily): void {
    const strip = el('section', `flh-ch flh-daily${d.solved ? ' is-complete' : ''}`, list);
    strip.setAttribute('aria-label', `Daily puzzle, ${d.label}`);
    const info = el('div', 'flh-ch-info', strip);
    const k = el('div', 'flh-ch-neb flh-daily-k', info);
    el('span', '', k, 'Daily');
    el('span', 'flh-daily-date mono', k, d.date);
    el('div', 'flh-ch-name flh-daily-name', info, d.label);
    el('div', 'flh-ch-rule', info, 'A new arena every day at 00:00 UTC. Time is shown, never scored.');

    const side = el('div', 'flh-daily-side', strip);
    const stats = el('div', 'flh-daily-stats', side);
    const streak = Number.isFinite(d.streak) ? Math.max(0, Math.floor(d.streak)) : 0;
    this.stat(stats, 'Streak', String(streak));
    if (d.solved && d.time) this.stat(stats, 'Solved', d.time);
    this.stat(stats, 'Next in', d.nextIn);

    const btn = button('flh-pill flh-pill--accent flh-daily-play', side, d.solved ? "Replay today's puzzle" : "Play today's puzzle", () => {
      if (this._open) this.cb.onDaily();
    });
    btn.tabIndex = -1;
    el('span', 'flh-pill-t', btn, d.solved ? 'Replay' : 'Play');
    this.grid.push([{ btn, key: DAILY_KEY, caption: '', strip: null }]);
  }

  private stat(parent: HTMLElement, k: string, v: string): void {
    const s = el('span', 'flh-stat', parent);
    el('span', 'flh-k', s, k);
    el('span', 'flh-v mono', s, v);
  }

  private defaultCaption(ch: AtlasChapter): string {
    if (ch.locked) return ch.lockText ?? 'Not yet open';
    const cur = ch.levels.find((l) => l.current);
    if (cur) return `Resume · ${cur.index} · ${cur.name}`;
    const next = ch.levels.find((l) => !l.solved);
    if (next) return `Next · ${next.index} · ${next.name}`;
    return 'Every seed in this nebula is lit';
  }

  private levelCaption(lv: AtlasLevel): string {
    const base = `${lv.index} · ${lv.name}`;
    if (lv.solved) return lv.par ? `${base} · ✦` : lv.help ? `${base} · solved with help` : `${base} · solved`;
    return lv.current ? `${base} · in progress` : base;
  }

  private levelAria(lv: AtlasLevel): string {
    let s = `Level ${lv.index}, ${lv.name}`;
    if (lv.solved) s += lv.par ? ', solved, mark earned' : lv.help ? ', solved with help' : ', solved';
    else s += ', not yet solved';
    if (lv.current) s += ', current';
    return s;
  }

  /** Hover and focus both write the strip caption; leaving restores focus or the default. */
  private wireCaption(node: NodeRef): void {
    const s = node.strip;
    if (!s) return;
    const sync = (): void => s.cap.set((s.hover ?? s.focus)?.caption ?? s.defaultCap);
    node.btn.addEventListener('pointerenter', () => {
      s.hover = node;
      sync();
    });
    node.btn.addEventListener('pointerleave', () => {
      if (s.hover === node) s.hover = null;
      sync();
    });
    node.btn.addEventListener('focus', () => {
      s.focus = node;
      this.syncRoving(node);
      sync();
    });
    node.btn.addEventListener('blur', () => {
      if (s.focus === node) s.focus = null;
      sync();
    });
  }

  // -------------------------------------------------------------------------------------------
  // Focus
  // -------------------------------------------------------------------------------------------

  /** Choose the roving focus: the kept key, else the current level, else the next unsolved one, else Daily. */
  private pickFocus(keepKey: string | null): void {
    const find = (pred: (n: NodeRef) => boolean): boolean => {
      for (let r = 0; r < this.grid.length; r++) {
        for (let c = 0; c < this.grid[r].length; c++) {
          if (pred(this.grid[r][c])) {
            this.row = r;
            this.col = c;
            this.wantCol = c;
            return true;
          }
        }
      }
      return false;
    };
    const ok =
      (keepKey !== null && find((n) => n.key === keepKey)) ||
      find((n) => n.btn.classList.contains('is-current')) ||
      find((n) => n.key !== DAILY_KEY && !n.btn.classList.contains('is-solved')) ||
      find(() => true);
    if (!ok) {
      this.row = 0;
      this.col = 0;
    }
    for (const r of this.grid) for (const n of r) n.btn.tabIndex = -1;
    const cur = this.grid[this.row]?.[this.col];
    if (cur) cur.btn.tabIndex = 0;
  }

  private syncRoving(node: NodeRef): void {
    for (let r = 0; r < this.grid.length; r++) {
      const c = this.grid[r].indexOf(node);
      if (c < 0) continue;
      const prev = this.grid[this.row]?.[this.col];
      if (prev && prev !== node) prev.btn.tabIndex = -1;
      this.row = r;
      this.col = c;
      node.btn.tabIndex = 0;
      return;
    }
  }

  private move(key: string): void {
    if (this.grid.length === 0) return;
    const active = document.activeElement;
    // First arrow press while focus is elsewhere: just land on the remembered node.
    if (!(active instanceof HTMLElement && this.card.contains(active) && active.classList.contains('flh-node')) && !this.dailyFocused()) {
      this.focusCurrent();
      return;
    }
    let r = this.row;
    let c = this.col;
    const len = (i: number): number => this.grid[i].length;
    switch (key) {
      case 'ArrowLeft':
        c = Math.max(0, c - 1);
        this.wantCol = c;
        break;
      case 'ArrowRight':
        c = Math.min(len(r) - 1, c + 1);
        this.wantCol = c;
        break;
      case 'Home':
        c = 0;
        this.wantCol = c;
        break;
      case 'End':
        c = len(r) - 1;
        this.wantCol = c;
        break;
      case 'ArrowUp':
        r = Math.max(0, r - 1);
        c = Math.min(len(r) - 1, this.wantCol);
        break;
      case 'ArrowDown':
        r = Math.min(this.grid.length - 1, r + 1);
        c = Math.min(len(r) - 1, this.wantCol);
        break;
    }
    const prev = this.grid[this.row]?.[this.col];
    if (prev) prev.btn.tabIndex = -1;
    this.row = r;
    this.col = c;
    this.focusCurrent();
  }

  private dailyFocused(): boolean {
    const d = this.grid[this.grid.length - 1]?.[0];
    return !!d && d.key === DAILY_KEY && document.activeElement === d.btn;
  }

  private focusCurrent(): void {
    const node = this.grid[this.row]?.[this.col];
    if (!node) return;
    node.btn.tabIndex = 0;
    node.btn.focus({ preventScroll: true });
    this.ensureVisible(node.btn);
  }

  /** Scroll the card (only) so the focused node is visible; never scroll the HUD layer itself. */
  private ensureVisible(btn: HTMLElement): void {
    const card = this.card;
    if (card.scrollHeight <= card.clientHeight + 1) return;
    const cr = card.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const pad = 28;
    if (br.top < cr.top + pad) card.scrollTop -= cr.top + pad - br.top;
    else if (br.bottom > cr.bottom - pad) card.scrollTop += br.bottom - (cr.bottom - pad);
  }
}
