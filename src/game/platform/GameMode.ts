/**
 * Game-mode shell contract (design/10-platform.md §2, design/60-first-light-build.md §S).
 *
 * The Voyage is the app with NO game mode (App.mode === null) and must behave exactly as before.
 * A game mode plugs into the existing `loading → start → flying ⇄ paused` shell:
 *
 *   frame:  input.poll() → sim.update() → mode.update() → audio.update() → renderer.render() → hud.update()
 *
 * `mode.update()` runs every frame after Launch, also while paused (with `paused = true`), so the mode
 * can keep its overlay and HUD consistent. It may drive the ship as a camera through
 * `sim.setPuppet / setPuppetPose` (lab view, cinematic glides): the renderer, HUD markers, stars and
 * TAA all follow `state.ship`, so a puppeted ship IS the camera.
 *
 * Cursor modes: 'locked' = pointer-locked flight (mouse looks), 'free' = the pointer is visible and
 * the canvas receives pointer events (lab view, menus) WITHOUT pausing. Esc pauses in both. The App
 * never auto-requests the lock from a canvas click while the cursor mode is 'free'.
 */
import type { AppSettings, SimState } from '../../core/types';
import type { InputFrame } from '../../ship/Input';
import type { Simulation } from '../../sim/Simulation';
import type { AudioEngine } from '../../audio/AudioEngine';
import type { Hud } from '../../hud/Hud';
import type { ControlDef } from '../../hud/controls';
import type { OverlayFrame } from '../../render/game/overlayTypes';

export type ModeId = 'voyage' | 'firstlight';
export type GameModeId = Exclude<ModeId, 'voyage'>;
export type CursorMode = 'locked' | 'free';

export interface PauseAction {
  id: string;
  label: string;
  /**
   * Runs from the pause-screen button click (a user gesture: it may call requestFlight()). The pause
   * screen then closes: unless run() itself called requestFlight() / requestFreeCursor() /
   * switchMode(), the App resumes into the cursor mode that was active when the pause began.
   */
  run(): void;
}

export interface ModeContext {
  readonly sim: Simulation;
  readonly audio: AudioEngine;
  readonly hud: Hud;
  /**
   * DOM layer reserved for the mode's HUD: a child of the in-flight HUD layer (so H hides it and it
   * fades in with the instruments), above the flight HUD, below the pause and start screens. It has
   * `pointer-events: none`; interactive children set `pointer-events: auto` themselves.
   */
  readonly layer: HTMLElement;
  /** The WebGL canvas; InputFrame.pointer coordinates are CSS px relative to its client rect. */
  readonly canvas: HTMLCanvasElement;
  /** Current settings (read every time: the object is replaced on change). */
  settings(): AppSettings;
  /** The overlay the renderer draws every frame. The mode mutates it in place. */
  readonly overlay: OverlayFrame;
  /** Current cursor mode. */
  readonly cursorMode: CursorMode;
  /**
   * Engage pointer-locked flight. Must run within a few seconds of a user gesture (keydown, mousedown,
   * click): calling it from update() on the frame that delivered the key press is fine. On failure the
   * App stays in (or returns to) 'free' and calls mode.onCursorModeChange('free', true). The cursor
   * mode stays 'free' until the lock is granted. From the pause screen (a PauseAction) it resumes
   * into locked flight, exactly like Resume.
   */
  requestFlight(): void;
  /**
   * Release the pointer WITHOUT pausing (lab view, menus); takes effect at once (cursorMode = 'free',
   * onCursorModeChange('free', false)). From the pause screen it resumes into free-cursor play.
   */
  requestFreeCursor(): void;
  /** Open the pause screen, exactly like Esc. */
  pause(): void;
  /** Leave this mode for another one ('voyage' = no game mode), in place, without reloading. */
  switchMode(id: ModeId): void;
}

export interface GameMode {
  readonly id: GameModeId;
  /** Start-screen card title, e.g. "First Light". */
  readonly title: string;
  /** One line under the title on the start-screen card. */
  readonly tagline: string;
  /** Mode control rows: pause-screen table (before the shared rows), start-screen summary, hints. */
  readonly controls: ControlDef[];
  /** Cursor mode the App should use right after Launch / Resume-from-start (usually 'locked'). */
  readonly initialCursor: CursorMode;
  /**
   * Called once when the mode becomes active: at Launch (inside the launch gesture, after the start
   * screen hides and the sim left attract mode) or via switchMode. `params` are the page's URL params
   * (`?mode=firstlight&level=bulb-1`, `&daily=2026-10-02`, …).
   */
  enter(ctx: ModeContext, params: URLSearchParams): void;
  /** Every frame after sim.update(), before rendering; also while paused. */
  update(dt: number, input: InputFrame, state: SimState, paused: boolean): void;
  /** The cursor mode changed: granted, released on purpose, or a lock request failed (failed = true). */
  onCursorModeChange?(mode: CursorMode, failed: boolean): void;
  /**
   * Esc in free-cursor play (InputFrame.escape): return true to consume it (e.g. close a panel)
   * instead of pausing. Not called in pointer-locked flight, where the browser releases the lock and
   * the App pauses.
   */
  onEscape?(): boolean;
  /** Pause screen opened / closed. */
  onPause?(paused: boolean): void;
  /** Extra pause-screen buttons, read each time the pause screen opens. */
  pauseActions?(): PauseAction[];
  /** Restore everything the mode changed (sim policy, arena, puppet, frozen clocks, overlay, HUD layer). */
  exit(): void;
}
