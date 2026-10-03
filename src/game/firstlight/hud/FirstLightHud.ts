/**
 * First Light HUD (design/60-first-light-build.md §H): DOM only, no game logic. FirstLightMode
 * fills the plain view-model objects of hudTypes.ts; this class renders them in the Voyage's
 * visual language (Rajdhani caps labels, JetBrains Mono values, cyan accent, glass cards).
 *
 * It mounts into ModeContext.layer, a child of the in-flight HUD layer (pointer-events: none
 * throughout, hidden with H); interactive parts opt back in with pointer-events: auto.
 *
 * Keyboard ownership: while the Atlas or the solved card is open, this class listens on the
 * document in the capture phase (before the game's Input on window) and keeps the keys it uses
 * from the game: arrows / Home / End / Enter / Space (Atlas), Enter / Space (solved card), and Esc
 * when the Atlas may close. Everything else (H, M, Esc to pause, …) passes through. Nothing is
 * handled while the pause screen is open (`.is-paused` on the HUD root) or the HUD is hidden with H
 * (`.is-hidden` on the in-flight layer).
 *
 * Mode integration notes:
 *  - Open the Atlas and the solved card with a free cursor (requestFreeCursor): their buttons need
 *    a visible pointer. The play HUD's buttons (orbs, hint chip, Atlas, undo / redo) only work in
 *    lab view for the same reason; in flight the keys do the same jobs.
 *  - In flight the placement reason is printed under the reticle from PlayHudState.placement; in
 *    lab view show it at the pointer with setCursorTip (an identical cursor-tip text suppresses
 *    the reticle copy, so sending both is harmless).
 */
import './firstlight.css';
import { el } from '../../../hud/dom';
import type { AtlasModel, FirstLightHudCallbacks, LevelHeader, PlayHudState, SolvedCard } from './hudTypes';
import { AtlasPanel } from './AtlasPanel';
import { isTextField } from './hudDom';
import { PlayHud } from './PlayHud';
import { SolvedPanel } from './SolvedPanel';

export class FirstLightHud {
  private readonly root: HTMLElement;
  private readonly play: PlayHud;
  private readonly atlas: AtlasPanel;
  private readonly solved: SolvedPanel;
  private disposed = false;
  private motionQuery: MediaQueryList | null = null;

  constructor(layer: HTMLElement, cb: FirstLightHudCallbacks) {
    const root = (this.root = el('div', 'flh', layer));
    this.play = new PlayHud(root, cb);
    this.solved = new SolvedPanel(root, cb);
    this.atlas = new AtlasPanel(root, cb);
    this.play.setLevel(null);
    this.play.setViewportWidth(window.innerWidth);

    document.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('resize', this.onResize);
    try {
      this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.motionQuery.addEventListener('change', this.onMotionChange);
    } catch {
      this.motionQuery = null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Atlas
  // -------------------------------------------------------------------------------------------

  /** Open (or refresh, keeping focus) the Atlas. `canClose`: a level is loaded to return to. */
  showAtlas(model: AtlasModel, canClose: boolean): void {
    if (this.disposed) return;
    this.atlas.show(model, canClose);
    this.root.classList.add('is-atlas');
  }

  hideAtlas(): void {
    this.atlas.hide();
    this.root.classList.remove('is-atlas');
  }

  get atlasOpen(): boolean {
    return this.atlas.open;
  }

  // -------------------------------------------------------------------------------------------
  // Play HUD
  // -------------------------------------------------------------------------------------------

  /** Top-left title block; null hides the whole play HUD (header, chips, orbs, gauge). */
  setLevel(h: LevelHeader | null): void {
    if (this.disposed) return;
    this.play.setLevel(h);
  }

  /** Cheap to call every frame: diffs against the last state and writes the DOM only on change. */
  setPlay(s: PlayHudState): void {
    if (this.disposed) return;
    this.play.setPlay(s);
  }

  /** Contextual control line (flight vs lab). PlayHudState.view drives the same switch. */
  setLabView(on: boolean): void {
    this.play.setLabView(on);
  }

  // -------------------------------------------------------------------------------------------
  // Solved card
  // -------------------------------------------------------------------------------------------

  showSolved(card: SolvedCard): void {
    if (this.disposed) return;
    this.play.hideHint();
    this.solved.show(card);
    this.root.classList.add('is-solved');
  }

  hideSolved(): void {
    this.solved.hide();
    this.root.classList.remove('is-solved');
  }

  get solvedOpen(): boolean {
    return this.solved.open;
  }

  // -------------------------------------------------------------------------------------------
  // Hints, tips, cursor
  // -------------------------------------------------------------------------------------------

  /**
   * Hint panel under the level header; step 2 warns that step 3 is the designer's note.
   * Call it when a step is revealed (or the player asks to see it again), NOT every frame: the
   * panel's × closes it locally and every showHint() call opens it again.
   */
  showHint(step: 1 | 2 | 3, text: string): void {
    if (this.disposed) return;
    this.play.showHint(step, text);
  }

  hideHint(): void {
    this.play.hideHint();
  }

  /** The hint panel is open (closed by hideHint() or the panel's ×). Additive, for WP M's `?` key. */
  get hintOpen(): boolean {
    return !this.disposed && this.play.hintVisible;
  }

  /** One-time physics tip card (bottom-left); hides itself after a reading time (see update). */
  showTip(label: string, text: string): void {
    if (this.disposed) return;
    this.play.showTip(label, text);
  }

  /** Small label near the pointer / reticle (CSS px relative to the canvas); null hides it. */
  setCursorTip(x: number, y: number, text: string | null): void {
    if (this.disposed) return;
    this.play.setCursorTip(x, y, text);
  }

  /** Animations and auto-hide timers; call every frame (dt in s; 0 while paused freezes them). */
  update(dt: number): void {
    if (this.disposed) return;
    const t = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0;
    this.play.update(t);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('resize', this.onResize);
    this.motionQuery?.removeEventListener('change', this.onMotionChange);
    this.atlas.dispose();
    this.solved.dispose();
    this.root.remove();
  }

  // -------------------------------------------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed || (!this.atlas.open && !this.solved.open)) return;
    // The pause screen sits above everything and owns the keyboard while open; a HUD hidden with H
    // (`.is-hidden` on the in-flight layer) must not act on keys behind the player's back.
    if (this.root.closest('.is-paused, .is-hidden')) return;
    if (isTextField(e.target) && !this.root.contains(e.target as Node)) return;
    if (e.ctrlKey || e.metaKey) return;
    const keep = this.atlas.open ? this.atlas.onKey(e) : this.solved.onKey(e);
    if (keep) e.stopPropagation();
  };

  private readonly onResize = (): void => {
    this.play.setViewportWidth(window.innerWidth);
  };

  private readonly onMotionChange = (): void => {
    this.play.refreshMotionPreference();
  };
}
