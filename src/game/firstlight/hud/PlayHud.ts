/**
 * First Light play HUD (design/60-first-light-build.md §H): level header (top-left) with the
 * hint panel under it, seed chips (top-centre), hint chip + Atlas (top-right), mass orbs with
 * undo / redo and the contextual control line (bottom-centre), the depth gauge and placement
 * reason beside the reticle, the one-time physics tip (bottom-left) and the cursor tip.
 *
 * setPlay() may run every frame: it compares primitives with the last state and writes the DOM
 * only on change. It allocates nothing unless the level's seed or mass layout changes (then the
 * chips are rebuilt once). "Almost" is smoothed in update() so a jittery closest approach reads
 * as a glow, never as flicker.
 */
import { MASS_SIZES, type MassSize } from '../types';
import { keyChips, type KeyGlyph } from '../../../hud/controls';
import { ClassSlot, el, markup, prefersReducedMotion, TextSlot, TransformSlot } from '../../../hud/dom';
import type { FirstLightHudCallbacks, LevelHeader, MassChip, PlayHudState, SeedChip } from './hudTypes';
import {
  AttrSlot,
  button,
  clamp01,
  FlagSlot,
  hiddenSlot,
  ICON_ATLAS,
  ICON_CLOSE,
  ICON_REDO,
  ICON_UNDO,
  VarSlot,
} from './hudDom';

const SIZE_NAME: Record<MassSize, string> = { light: 'Light', medium: 'Medium', heavy: 'Heavy' };
const HINT_STEP_LABEL = ['Hint 1 of 3', 'Hint 2 of 3', 'Hint 3 of 3'] as const;

/** Orbs drawn for a mass group (sanitised; also the layout key, so a bad total cannot force a rebuild every frame). */
function orbCount(total: number): number {
  return Math.max(0, Math.min(12, Math.floor(Number.isFinite(total) ? total : 0)));
}

/** "Almost" glow smoothing time constant (s). */
const ALMOST_TAU = 0.12;
/** Physics tip reading time: base + per character, clamped (s); then a 0.7 s fade. */
const TIP_BASE_S = 6;
const TIP_PER_CHAR_S = 0.05;
const TIP_MAX_S = 16;
const TIP_FADE_S = 0.7;
/** The cursor tip flips to the left of the pointer this close to the right edge (px). */
const CURSOR_FLIP_PX = 260;

type CtlRow = [KeyGlyph[], string];

/** Contextual control lines: flight / lab, idle / dragging (design §2 controls table). */
const CTL_FLIGHT: CtlRow[] = [
  [['LMB'], 'Place · grab'],
  [['RMB'], 'Remove'],
  [['WHEEL'], 'Depth'],
  [['1', '2', '3'], 'Size'],
  [['Z'], 'Undo'],
  [['Tab'], 'Lab view'],
  [['?'], 'Hint'],
];
const CTL_LAB: CtlRow[] = [
  [['LMB'], 'Place · drag'],
  [['RMB'], 'Orbit · remove'],
  [['WHEEL'], 'Dolly'],
  [['1', '2', '3'], 'Size'],
  [['Z'], 'Undo'],
  [['Tab'], 'Fly'],
  [['Backspace'], 'Re-frame'],
];
const CTL_FLIGHT_DRAG: CtlRow[] = [
  [['LMB'], 'Release to drop'],
  [['WHEEL'], 'Distance'],
  [['Shift'], 'Precision'],
];
const CTL_LAB_DRAG: CtlRow[] = [
  [['LMB'], 'Release to drop'],
  [['WHEEL'], 'Along the ray'],
  [['Shift'], 'Precision'],
];

interface SeedView {
  lit: ClassSlot;
  almost: VarSlot;
  goal: boolean;
  /** Target and displayed closeness (0..1); the displayed one eases toward the target. */
  target: number;
  shown: number;
  isLit: boolean;
}

interface MassGroupView {
  size: MassSize;
  total: number;
  placed: number;
  orbs: ClassSlot[];
  selected: ClassSlot;
  spent: ClassSlot;
  pressed: AttrSlot;
  label: AttrSlot;
}

export class PlayHud {
  readonly root: HTMLElement;
  /** `hidden` writer of the whole play HUD (set(true) hides it). */
  private readonly playHidden: FlagSlot;
  private readonly labCls: ClassSlot;
  private readonly dragCls: ClassSlot;

  // ---- header (top-left) ----
  private readonly kicker: TextSlot;
  private readonly name: TextSlot;
  private readonly dailyCls: ClassSlot;
  private readonly timerRow: FlagSlot;
  private readonly timer: TextSlot;

  // ---- seeds (top-centre) ----
  private readonly seedRow: HTMLElement;
  private readonly seedLabel: TextSlot;
  private readonly seedsDone: ClassSlot;
  private readonly seedAria: AttrSlot;
  private readonly seeds: SeedView[] = [];
  private seedsLit = -1;
  private seedsGoal = -1;

  // ---- top-right ----
  private readonly hintChip: FlagSlot;
  private readonly hintDots: ClassSlot[] = [];
  private readonly hintChipAria: AttrSlot;

  // ---- masses (bottom-centre) ----
  private readonly massRow: HTMLElement;
  private readonly groups: MassGroupView[] = [];
  private readonly undoOff: FlagSlot;
  private readonly redoOff: FlagSlot;
  private readonly ctlLines: FlagSlot[] = [];
  private ctlIndex = -1;

  // ---- depth gauge + placement reason (beside the reticle) ----
  private readonly gauge: FlagSlot;
  private readonly gaugeDepth: VarSlot;
  private readonly gaugeIllegal: ClassSlot;
  private readonly gaugeOver: ClassSlot;
  private readonly reason: TextSlot;
  private readonly reasonShown: FlagSlot;

  // ---- hint panel ----
  private readonly hintPanel: HTMLElement;
  private readonly hintShown: FlagSlot;
  private readonly hintStep: TextSlot;
  private readonly hintStepDots: ClassSlot[] = [];
  private readonly hintText: TextSlot;
  private readonly hintTextEl: HTMLElement;
  private readonly hintNext: FlagSlot;
  private readonly hintWarn: FlagSlot;
  private hintOpen = false;
  /** The player closed the panel with ×: the hint chip reopens it instead of asking for the next step. */
  private hintDismissed = false;

  // ---- physics tip ----
  private readonly tipEl: HTMLElement;
  private readonly tipShown: FlagSlot;
  private readonly tipOut: ClassSlot;
  private readonly tipLabel: TextSlot;
  private readonly tipText: TextSlot;
  private tipLeft = 0;
  private tipFade = 0;

  // ---- cursor tip ----
  private readonly cursorShown: FlagSlot;
  private readonly cursorPos: TransformSlot;
  private readonly cursorText: TextSlot;
  private cursorTip: string | null = null;
  private viewportW = 1280;

  // ---- last state (diffing) ----
  private lab = false;
  private dragging = false;
  private selected: MassSize | null = null;
  private hintAvailable = false;
  private hintLevel = -1;
  private placementReason: string | null = null;
  private placementLegal = true;
  private reducedMotion = prefersReducedMotion();

  constructor(
    parent: HTMLElement,
    private readonly cb: FirstLightHudCallbacks,
  ) {
    const root = (this.root = el('div', 'flh-play', parent));
    this.playHidden = hiddenSlot(root);
    this.playHidden.set(true);
    this.labCls = new ClassSlot(root, 'is-lab');
    this.dragCls = new ClassSlot(root, 'is-drag');

    // ---- top-left: header + hint panel ----
    const tl = el('div', 'flh-tl', root);
    const head = el('div', 'flh-head', tl);
    this.dailyCls = new ClassSlot(head, 'is-daily');
    this.kicker = new TextSlot(el('div', 'flh-kicker', head));
    this.name = new TextSlot(el('div', 'flh-name', head));
    const trow = el('div', 'flh-row', head);
    this.timerRow = hiddenSlot(trow);
    this.timerRow.set(true);
    el('span', 'flh-k', trow, 'Time');
    this.timer = new TextSlot(el('span', 'flh-v mono', trow), '0:00');

    const hint = (this.hintPanel = el('section', 'flh-hint glass', tl));
    hint.setAttribute('aria-label', 'Hint');
    hint.setAttribute('aria-live', 'polite');
    this.hintShown = hiddenSlot(hint);
    this.hintShown.set(true);
    const hh = el('div', 'flh-hint-head', hint);
    this.hintStep = new TextSlot(el('span', 'flh-hint-k', hh), 'Hint');
    const steps = el('span', 'flh-steps', hh);
    steps.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) this.hintStepDots.push(new ClassSlot(el('i', '', steps), 'is-on'));
    const close = button('flh-x', hh, 'Close hint', () => this.dismissHint());
    markup(ICON_CLOSE, close);
    this.hintTextEl = el('p', 'flh-hint-text', hint);
    this.hintText = new TextSlot(this.hintTextEl);
    const foot = el('div', 'flh-hint-foot', hint);
    const next = button('flh-pill flh-pill--small', foot, null, () => this.cb.onHint());
    el('span', '', next, 'Next hint');
    keyChips(next, ['?']);
    this.hintNext = hiddenSlot(next);
    const warn = el('span', 'flh-hint-warn', foot, 'Shows the designer’s note — no ✦');
    this.hintWarn = hiddenSlot(warn);
    this.hintWarn.set(true);

    // ---- top-centre: seed chips ----
    const tc = el('div', 'flh-seeds', root);
    this.seedRow = el('div', 'flh-seed-row', tc);
    this.seedRow.setAttribute('role', 'img');
    this.seedAria = new AttrSlot(this.seedRow, 'aria-label');
    const sl = el('div', 'flh-seed-label', tc);
    this.seedsDone = new ClassSlot(sl, 'is-done');
    this.seedLabel = new TextSlot(sl, 'Seeds');

    // ---- top-right: hint chip + Atlas ----
    const tr = el('div', 'flh-tr', root);
    const chip = button('flh-pill flh-hintchip', tr, 'Hint', () => this.onHintChip());
    keyChips(chip, ['?']);
    el('span', 'flh-pill-t', chip, 'Hint');
    const dots = el('span', 'flh-steps', chip);
    dots.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) this.hintDots.push(new ClassSlot(el('i', '', dots), 'is-on'));
    this.hintChip = hiddenSlot(chip);
    this.hintChip.set(true);
    this.hintChipAria = new AttrSlot(chip, 'aria-label');
    const atlas = button('flh-pill', tr, 'Open the Atlas', () => this.cb.onOpenAtlas());
    markup(ICON_ATLAS, atlas);
    el('span', 'flh-pill-t', atlas, 'Atlas');

    // ---- bottom-centre: undo · orbs · redo, control line ----
    const bc = el('div', 'flh-bc', root);
    const masses = el('div', 'flh-masses', bc);
    const undo = button('flh-ur', masses, 'Undo (Z)', () => this.cb.onUndo?.());
    undo.title = 'Undo · Z';
    markup(ICON_UNDO, undo);
    this.undoOff = new FlagSlot((off) => (undo.disabled = off));
    this.massRow = el('div', 'flh-mass-row', masses);
    this.massRow.setAttribute('role', 'group');
    this.massRow.setAttribute('aria-label', 'Masses');
    const redo = button('flh-ur', masses, 'Redo (Shift+Z)', () => this.cb.onRedo?.());
    redo.title = 'Redo · Shift+Z';
    markup(ICON_REDO, redo);
    this.redoOff = new FlagSlot((off) => (redo.disabled = off));
    this.undoOff.set(true);
    this.redoOff.set(true);

    const ctl = el('div', 'flh-ctl-wrap', bc);
    ctl.setAttribute('aria-hidden', 'true');
    for (const rows of [CTL_FLIGHT, CTL_LAB, CTL_FLIGHT_DRAG, CTL_LAB_DRAG]) {
      const line = el('div', 'flh-ctl', ctl);
      for (const [keys, text] of rows) {
        const item = el('span', 'flh-ctl-i', line);
        keyChips(item, keys);
        el('span', 'flh-ctl-t', item, text);
      }
      const slot = hiddenSlot(line);
      slot.set(true);
      this.ctlLines.push(slot);
    }
    this.setCtlLine();

    // ---- depth gauge + placement reason ----
    const g = el('div', 'flh-gauge', root);
    g.setAttribute('aria-hidden', 'true');
    this.gauge = hiddenSlot(g);
    this.gauge.set(true);
    this.gaugeDepth = new VarSlot(g, '--d', 1 / 200);
    this.gaugeIllegal = new ClassSlot(g, 'is-illegal');
    this.gaugeOver = new ClassSlot(g, 'is-over');
    const track = el('div', 'flh-gauge-track', g);
    el('div', 'flh-gauge-fill', track);
    for (const t of ['top', 'mid', 'bot']) el('i', `flh-gauge-tick flh-gauge-tick--${t}`, g);
    el('div', 'flh-gauge-mark', g);
    el('span', 'flh-gauge-k flh-gauge-k--top', g, 'Surface');
    el('span', 'flh-gauge-k flh-gauge-k--bot', g, 'Depth');
    const reason = el('div', 'flh-reason', root);
    reason.setAttribute('role', 'status');
    this.reason = new TextSlot(reason);
    this.reasonShown = hiddenSlot(reason);
    this.reasonShown.set(true);

    // ---- physics tip (bottom-left) ----
    const tip = (this.tipEl = el('aside', 'flh-tip', root));
    tip.setAttribute('aria-live', 'polite');
    this.tipShown = hiddenSlot(tip);
    this.tipShown.set(true);
    this.tipOut = new ClassSlot(tip, 'is-out');
    this.tipLabel = new TextSlot(el('div', 'flh-tip-label', tip));
    this.tipText = new TextSlot(el('div', 'flh-tip-text', tip));

    // ---- cursor tip ----
    const ct = el('div', 'flh-ctip', root);
    ct.setAttribute('aria-hidden', 'true');
    this.cursorShown = hiddenSlot(ct);
    this.cursorShown.set(true);
    this.cursorPos = new TransformSlot(ct, 1);
    this.cursorText = new TextSlot(ct);
  }

  // -------------------------------------------------------------------------------------------

  setLevel(h: LevelHeader | null): void {
    this.playHidden.set(h === null);
    if (!h) {
      this.hideHint();
      return;
    }
    const kicker = h.isDaily ? `${h.nebulaName} · Daily` : `${h.nebulaName} · ${h.chapterName} ${h.index} of ${h.total}`;
    // Another level: a hint closed with × belonged to the previous one (the chip asks the mode again).
    if (kicker !== this.kicker.get() || h.name !== this.name.get()) this.hintDismissed = false;
    this.dailyCls.set(h.isDaily);
    this.kicker.set(kicker);
    this.name.set(h.name);
  }

  setPlay(s: PlayHudState): void {
    this.setLab(s.view === 'lab');
    if (s.dragging !== this.dragging) {
      this.dragging = s.dragging;
      this.dragCls.set(s.dragging);
      this.setCtlLine();
    }
    this.syncSeeds(s.seeds);
    this.syncMasses(s.masses, s.selected);

    // Depth gauge: fraction of the surface-hit distance (1 = at the surface).
    const d = s.depth;
    const showGauge = d !== null && Number.isFinite(d);
    this.gauge.set(!showGauge);
    if (showGauge) {
      this.gaugeDepth.set(clamp01(d));
      this.gaugeOver.set(d > 1.001);
    }
    const p = s.placement;
    this.placementLegal = p === null || p.legal;
    this.placementReason = p !== null && !p.legal ? p.reason : null;
    this.gaugeIllegal.set(!this.placementLegal);
    this.syncReason();

    // Hint chip (the panel replaces it while open).
    const hl = Math.max(0, Math.min(3, Math.floor(Number.isFinite(s.hintLevel) ? s.hintLevel : 0)));
    if (s.hintAvailable !== this.hintAvailable || hl !== this.hintLevel) {
      this.hintAvailable = s.hintAvailable;
      this.hintLevel = hl;
      for (let i = 0; i < 3; i++) this.hintDots[i].set(i < hl);
      this.hintChipAria.set(hl > 0 ? `Hint (${hl} of 3 shown)` : 'Hint');
      this.syncHintChip();
    }

    this.timerRow.set(s.timer === null);
    if (s.timer !== null) this.timer.set(s.timer);
    this.undoOff.set(!s.canUndo);
    this.redoOff.set(!s.canRedo);
  }

  setLabView(on: boolean): void {
    this.setLab(on);
  }

  showHint(step: 1 | 2 | 3, text: string): void {
    const n = step === 1 || step === 2 || step === 3 ? step : 1;
    const label = HINT_STEP_LABEL[n - 1];
    const changed = this.hintStep.get() !== label || this.hintText.get() !== text;
    this.hintStep.set(label);
    for (let i = 0; i < 3; i++) this.hintStepDots[i].set(i < n);
    this.hintText.set(text);
    this.hintNext.set(n >= 3);
    this.hintWarn.set(n !== 2);
    const wasOpen = this.hintOpen;
    this.hintOpen = true;
    this.hintDismissed = false;
    this.hintShown.set(false);
    // A new step while the panel is open: a soft cross-fade of the text only.
    if (wasOpen && changed && !this.reducedMotion) {
      this.hintTextEl.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], {
        duration: 520,
        easing: 'cubic-bezier(.2,.8,.2,1)',
      });
    }
    this.syncHintChip();
  }

  /** The hint panel is showing (WP M: `?` re-opens a closed step before advancing). */
  get hintVisible(): boolean {
    return this.hintOpen;
  }

  hideHint(): void {
    this.hintDismissed = false;
    if (!this.hintOpen) return;
    this.hintOpen = false;
    this.hintShown.set(true);
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.hintPanel.contains(active)) active.blur();
    this.syncHintChip();
  }

  showTip(label: string, text: string): void {
    const t = text.trim();
    if (!t) return;
    this.tipLabel.set(label.trim());
    this.tipText.set(t);
    this.tipLeft = Math.min(TIP_BASE_S + t.length * TIP_PER_CHAR_S, TIP_MAX_S);
    this.tipFade = 0;
    this.tipOut.set(false);
    this.tipShown.set(false);
  }

  setCursorTip(x: number, y: number, text: string | null): void {
    const t = text !== null && text.trim() !== '' && Number.isFinite(x) && Number.isFinite(y) ? text : null;
    this.cursorTip = t;
    this.cursorShown.set(t === null);
    if (t !== null) {
      this.cursorText.set(t);
      const flip = x > this.viewportW - CURSOR_FLIP_PX;
      this.cursorPos.moveAnchored(flip ? x - 16 : x + 16, y + 14, flip ? -100 : 0, 0);
    }
    this.syncReason();
  }

  setViewportWidth(w: number): void {
    if (Number.isFinite(w) && w > 0) this.viewportW = w;
  }

  /** Smoothing and timers; dt in seconds. */
  update(dt: number): void {
    const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt / ALMOST_TAU);
    for (let i = 0; i < this.seeds.length; i++) {
      const v = this.seeds[i];
      const target = v.isLit ? 0 : v.target;
      v.shown += (target - v.shown) * k;
      if (Math.abs(target - v.shown) < 0.004) v.shown = target;
      v.almost.set(v.shown);
    }
    if (this.tipLeft > 0) {
      this.tipLeft -= dt;
      if (this.tipLeft <= 0) {
        this.tipOut.set(true);
        this.tipFade = TIP_FADE_S;
      }
    } else if (this.tipFade > 0) {
      this.tipFade -= dt;
      if (this.tipFade <= 0) this.tipShown.set(true);
    }
  }

  refreshMotionPreference(): void {
    this.reducedMotion = prefersReducedMotion();
  }

  // -------------------------------------------------------------------------------------------

  private setLab(on: boolean): void {
    if (on === this.lab) return;
    this.lab = on;
    this.labCls.set(on);
    this.setCtlLine();
  }

  private setCtlLine(): void {
    const i = (this.lab ? 1 : 0) + (this.dragging ? 2 : 0);
    if (i === this.ctlIndex) return;
    this.ctlIndex = i;
    for (let j = 0; j < this.ctlLines.length; j++) this.ctlLines[j].set(j !== i);
  }

  /** × on the panel: close it locally; the hint chip brings the same step back. */
  private dismissHint(): void {
    if (!this.hintOpen) return;
    this.hideHint();
    this.hintDismissed = true;
  }

  /**
   * Hint chip: reopen a hint the player closed with ×; otherwise ask the mode for the next step.
   * Only the panel's "Next hint" button (which carries the designer's-note warning) advances past
   * a step the player has already seen.
   */
  private onHintChip(): void {
    if (this.hintDismissed && this.hintLevel > 0) {
      this.hintDismissed = false;
      this.hintOpen = true;
      this.hintShown.set(false);
      this.syncHintChip();
      return;
    }
    this.cb.onHint();
  }

  private syncHintChip(): void {
    this.hintChip.set(!(this.hintAvailable && !this.hintOpen));
  }

  /** The placement reason sits under the reticle unless the cursor tip already says the same thing. */
  private syncReason(): void {
    const r = this.placementReason;
    const show = r !== null && r !== '' && !this.dragging && r !== this.cursorTip;
    if (show) this.reason.set(r);
    this.reasonShown.set(!show);
  }

  private syncSeeds(seeds: readonly SeedChip[]): void {
    let same = seeds.length === this.seeds.length;
    for (let i = 0; same && i < seeds.length; i++) same = seeds[i].goal === this.seeds[i].goal;
    if (!same) this.buildSeeds(seeds);

    let lit = 0;
    let goals = 0;
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i];
      const v = this.seeds[i];
      v.isLit = s.lit;
      v.lit.set(s.lit);
      v.target = clamp01(s.almost);
      if (s.goal) {
        goals++;
        if (s.lit) lit++;
      }
    }
    if (lit !== this.seedsLit || goals !== this.seedsGoal) {
      this.seedsLit = lit;
      this.seedsGoal = goals;
      const done = goals > 0 && lit === goals;
      this.seedsDone.set(done);
      this.seedLabel.set(done ? 'Every seed lit' : 'Seeds');
      this.seedAria.set(`Seeds: ${lit} of ${goals} lit`);
    }
  }

  private buildSeeds(seeds: readonly SeedChip[]): void {
    this.seedRow.replaceChildren();
    this.seeds.length = 0;
    this.seedsLit = -1;
    let prevGoal = true;
    for (const s of seeds) {
      // A thin gap separates relay (echo) chips from the goal chips.
      if (!s.goal && prevGoal && this.seeds.length > 0) el('i', 'flh-seed-gap', this.seedRow);
      prevGoal = s.goal;
      const chip = el('span', `flh-seed${s.goal ? '' : ' is-echo'}`, this.seedRow);
      el('i', 'flh-seed-d', chip);
      const a = clamp01(s.almost);
      const v: SeedView = {
        lit: new ClassSlot(chip, 'is-lit'),
        almost: new VarSlot(chip, '--a', 1 / 48),
        goal: s.goal,
        target: a,
        shown: s.lit ? 0 : a,
        isLit: s.lit,
      };
      v.almost.set(v.shown);
      this.seeds.push(v);
    }
  }

  private syncMasses(chips: readonly MassChip[], selected: MassSize): void {
    let same = chips.length === this.groups.length;
    for (let i = 0; same && i < chips.length; i++) {
      same = chips[i].size === this.groups[i].size && orbCount(chips[i].total) === this.groups[i].total;
    }
    if (!same) this.buildMasses(chips);

    const selChanged = selected !== this.selected;
    this.selected = selected;
    for (let i = 0; i < chips.length; i++) {
      const c = chips[i];
      const g = this.groups[i];
      const placed = Math.max(0, Math.min(g.total, Math.floor(Number.isFinite(c.placed) ? c.placed : 0)));
      if (placed !== g.placed) {
        g.placed = placed;
        const avail = g.total - placed;
        // Available orbs first (filled), placed ones after them (hollow).
        for (let j = 0; j < g.orbs.length; j++) g.orbs[j].set(j >= avail);
        g.spent.set(avail === 0);
        g.label.set(this.groupLabel(g.size, avail, g.total));
      }
      if (selChanged || !same) {
        const on = g.size === selected;
        g.selected.set(on);
        g.pressed.set(on ? 'true' : 'false');
      }
    }
  }

  private buildMasses(chips: readonly MassChip[]): void {
    this.massRow.replaceChildren();
    this.groups.length = 0;
    for (const c of chips) {
      const total = orbCount(c.total);
      const size = c.size;
      const btn = button(`flh-mg flh-mg--${size}`, this.massRow, null, () => this.cb.onSelectSize(size));
      const orbs = el('span', 'flh-orbs', btn);
      orbs.setAttribute('aria-hidden', 'true');
      const slots: ClassSlot[] = [];
      for (let j = 0; j < total; j++) slots.push(new ClassSlot(el('i', 'flh-orb', orbs), 'is-used'));
      const lab = el('span', 'flh-mg-label', btn);
      lab.setAttribute('aria-hidden', 'true');
      keyChips(lab, [String(MASS_SIZES.indexOf(size) + 1)]);
      el('span', '', lab, SIZE_NAME[size] ?? size);
      const g: MassGroupView = {
        size,
        total,
        placed: -1,
        orbs: slots,
        selected: new ClassSlot(btn, 'is-selected'),
        spent: new ClassSlot(btn, 'is-spent'),
        pressed: new AttrSlot(btn, 'aria-pressed'),
        label: new AttrSlot(btn, 'aria-label'),
      };
      this.groups.push(g);
    }
  }

  private groupLabel(size: MassSize, avail: number, total: number): string {
    return `${SIZE_NAME[size] ?? size} mass, ${avail} of ${total} available, key ${MASS_SIZES.indexOf(size) + 1}`;
  }
}
