/**
 * Keyboard / mouse input with pointer lock. Events are accumulated between polls and
 * delivered once per frame as an InputFrame (edges fire exactly once).
 *
 * Two cursor states feed the same frame:
 *  - pointer-locked flight (the Voyage; game modes in flight): mouse travel looks around;
 *  - free-cursor play (game modes only, `setFreeCursorActive(true)`): the pointer is visible and the
 *    canvas delivers pointer position, buttons, wheel and game keys WITHOUT the lock (lab view, menus).
 * mouseDX/DY, hyper and click keep their pointer-locked meaning in both (they are 0 / false when free).
 */
import { toggleFullscreen } from '../app/Fullscreen';
import { TUNING } from '../app/config';

/** Mouse button bits of InputFrame.buttons / pressed / released. */
export const MOUSE_LEFT = 1;
export const MOUSE_RIGHT = 2;
export const MOUSE_MIDDLE = 4;

export interface InputPointer {
  /** CSS px relative to the canvas. While pointer-locked: the canvas centre (the reticle). */
  x: number;
  y: number;
  /** The free cursor is over the canvas itself (not over a HUD control, not outside the window). Locked: true. */
  inside: boolean;
  /** Free-cursor travel since the last poll (CSS px); 0 while locked (use mouseDX/DY). */
  dx: number;
  dy: number;
}

export interface InputMods {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export interface InputFrame {
  mouseDX: number; mouseDY: number;   // raw px since last poll (0 when not pointer-locked)
  forward: number; strafe: number; lift: number; roll: number; // -1..1 (W/S, D/A, R/F, E/Q)
  precision: boolean;                 // Shift
  hyper: boolean;                     // right mouse held
  click: boolean;                     // left mouse pressed this frame (targeting)
  spaceTap: boolean;                  // Space released before hold threshold
  spaceHold: boolean;                 // Space held beyond TUNING.spaceHoldSeconds (edge: true once)
  wheel: number;                      // wheel notches since last poll (+ = up); free cursor: only over the canvas
  toggles: { hud: boolean; codex: boolean; mute: boolean; voyage: boolean }; // H, Tab|I, M, T pressed this frame
  anyMoveInput: boolean;              // any of WASD/QE/RF/mouse movement (cancels autopilot)
  // ---- game-mode additions (design/60-first-light-build.md §S). The Simulation never reads them: ----
  // ---- test harnesses that build InputFrames by hand may leave them out.                          ----
  /** Held mouse buttons (MOUSE_LEFT | MOUSE_RIGHT | MOUSE_MIDDLE). Locked: any press; free: presses that began on the canvas. */
  buttons: number;
  /** Button press edges this frame (same bits). */
  pressed: number;
  /** Button release edges this frame (same bits; every press gets one, also when focus or the lock is lost). */
  released: number;
  pointer: InputPointer;
  /** Key held (KeyboardEvent.code), e.g. 'KeyX'. */
  keyDown(code: string): boolean;
  /** Keydown edge this frame (no auto-repeat), any KeyboardEvent.code except Escape / F11. */
  keyPressed(code: string): boolean;
  mods: InputMods;
  /** Esc pressed while NOT pointer-locked and free-cursor play is active (the App pauses on it). */
  escape: boolean;
}

/** Keys whose held state matters. */
const HELD_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight',
]);
/** Keys whose browser default (focus navigation, quick find, page scroll) is suppressed in game modes. */
const MODE_KEYS = new Set(['Tab', 'Space', 'Backspace', 'Slash']);
/** Per-event clamp on mouse deltas (guards against spurious pointer-lock spikes). */
const MAX_MOUSE_DELTA = 400;
/**
 * Deliberate mouse movement (cancels autopilot): recent travel, leaky-integrated with time
 * constant MOUSE_MOVE_TAU (s), above MOUSE_MOVE_THRESHOLD px. Frame-rate independent: a slow,
 * steady move registers at 119 Hz just as at 60 Hz, while sensor jitter does not.
 */
const MOUSE_MOVE_THRESHOLD = 6;
const MOUSE_MOVE_TAU = 0.12;
/**
 * A lock request younger than this (ms) is still in flight: a second requestPointerLock() while
 * one is pending can be rejected by the browser and would be misreported as a failure.
 */
const LOCK_PENDING_MS = 1500;
/** Pixels per wheel notch in DOM_DELTA_PIXEL mode. */
const PIXELS_PER_NOTCH = 100;
const LINES_PER_NOTCH = 3;
const MAX_NOTCHES_PER_EVENT = 3;

type Listener = [target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions];
/**
 * `failed` is true when a lock *request* was refused (cooldown after Esc, missing gesture,
 * unsupported options with no fallback) — as opposed to an existing lock being released.
 */
export type LockChangeCallback = (locked: boolean, failed: boolean) => void;

function isNotSupported(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotSupportedError';
}

function isFormTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON';
}

/** MouseEvent.button → InputFrame button bit (0 for back / forward buttons). */
function buttonBit(button: number): number {
  return button === 0 ? MOUSE_LEFT : button === 2 ? MOUSE_RIGHT : button === 1 ? MOUSE_MIDDLE : 0;
}

/** Wheel event → notches (+ = up), clamped per event; NaN when unusable. */
function wheelNotches(e: WheelEvent): number {
  let notches: number;
  switch (e.deltaMode) {
    case WheelEvent.DOM_DELTA_LINE:
      notches = -e.deltaY / LINES_PER_NOTCH;
      break;
    case WheelEvent.DOM_DELTA_PAGE:
      notches = -e.deltaY;
      break;
    default:
      notches = -e.deltaY / PIXELS_PER_NOTCH;
  }
  if (!Number.isFinite(notches)) return NaN;
  return Math.max(-MAX_NOTCHES_PER_EVENT, Math.min(MAX_NOTCHES_PER_EVENT, notches));
}

export class Input {
  private readonly el: HTMLElement;
  private _locked = false;
  private lockPending = false;
  private lockRequestedAt = -1e9;
  private lockGen = 0;
  /** When the browser returns a promise from requestPointerLock it is authoritative for errors. */
  private lockViaPromise = false;
  /** Every key held outside form fields (KeyboardEvent.code). */
  private readonly held = new Set<string>();
  private readonly lockCallbacks: LockChangeCallback[] = [];
  private readonly listeners: Listener[] = [];

  private mouseDX = 0;
  private mouseDY = 0;
  private wheelAcc = 0;
  private moveAcc = 0;
  private lastPollAt = -1;
  private clickPending = false;
  private hyperHeld = false;

  private spaceDown = false;
  private spaceDownAt = 0;
  private spaceHoldFired = false;
  private spaceTapPending = false;
  private spaceHoldPending = false;

  private toggleHud = false;
  private toggleCodex = false;
  private toggleMute = false;
  private toggleVoyage = false;

  // ---- game-mode input (free cursor, buttons, key edges) ----
  /** Free-cursor play: pointer / buttons / wheel / game keys are delivered without the lock. */
  private freeActive = false;
  /** A game mode is active: Backspace and Slash lose their browser defaults in locked flight too. */
  private modeKeys = false;
  private buttonsHeld = 0;
  private pressedBits = 0;
  private releasedBits = 0;
  /** Keydown edges since the last poll, and the ones delivered by the last poll (swapped, never reallocated). */
  private pressedAcc = new Set<string>();
  private pressedFrame = new Set<string>();
  private escapePending = false;
  private clientX = 0;
  private clientY = 0;
  private pointerKnown = false;
  private overCanvas = false;
  private ptrDX = 0;
  private ptrDY = 0;
  private modShift = false;
  private modCtrl = false;
  private modAlt = false;
  private modMeta = false;
  /** Canvas client rect, refreshed lazily after a resize (getBoundingClientRect allocates). */
  private rectLeft = 0;
  private rectTop = 0;
  private rectW = 1;
  private rectH = 1;
  private rectDirty = true;

  /** Reused every poll: consumers must not keep references across frames. */
  private readonly frame: InputFrame = {
    mouseDX: 0, mouseDY: 0,
    forward: 0, strafe: 0, lift: 0, roll: 0,
    precision: false, hyper: false, click: false, spaceTap: false, spaceHold: false,
    wheel: 0,
    toggles: { hud: false, codex: false, mute: false, voyage: false },
    anyMoveInput: false,
    buttons: 0, pressed: 0, released: 0,
    pointer: { x: 0, y: 0, inside: false, dx: 0, dy: 0 },
    keyDown: (code: string): boolean => this.held.has(code),
    keyPressed: (code: string): boolean => this.pressedFrame.has(code),
    mods: { shift: false, ctrl: false, alt: false, meta: false },
    escape: false,
  };

  constructor(lockTarget: HTMLElement) {
    this.el = lockTarget;
    this.listen(document, 'pointerlockchange', this.onLockChangeEvent);
    this.listen(document, 'pointerlockerror', this.onLockError);
    this.listen(window, 'keydown', this.onKeyDown as EventListener);
    this.listen(window, 'keyup', this.onKeyUp as EventListener);
    this.listen(document, 'mousemove', this.onMouseMove as EventListener);
    this.listen(document, 'mousedown', this.onMouseDown as EventListener);
    this.listen(window, 'mouseup', this.onMouseUp as EventListener);
    this.listen(document, 'mouseout', this.onMouseOut as EventListener);
    this.listen(document, 'contextmenu', this.onContextMenu);
    this.listen(window, 'wheel', this.onWheel as EventListener, { passive: false });
    this.listen(window, 'blur', this.onBlur);
    this.listen(window, 'resize', this.onResize);
    this.listen(document, 'visibilitychange', this.onVisibility);
  }

  get locked(): boolean {
    return this._locked;
  }

  /** A lock request is in flight (neither granted nor refused yet). */
  get pending(): boolean {
    return this.lockPending && !this._locked;
  }

  /**
   * Request pointer lock. Must be called from a user gesture (click / key), or within the few
   * seconds of transient activation that follow one. Failure (e.g. Chrome's 1.25 s re-lock
   * cooldown after Esc) is reported once through onLockChange(false, true). A call while a
   * recent request is still pending is ignored (the pending one decides).
   */
  requestLock(): void {
    if (this._locked) return;
    const now = performance.now();
    if (this.lockPending && now - this.lockRequestedAt < LOCK_PENDING_MS) return;
    this.lockPending = true;
    this.lockRequestedAt = now;
    this.lockViaPromise = false;
    // A late rejection of a superseded request must not be reported against the current one.
    const gen = ++this.lockGen;
    const el = this.el;
    const fail = (): void => {
      if (gen === this.lockGen) this.failLock();
    };
    const attempt = (opts?: PointerLockOptions): void => {
      let p: Promise<void> | undefined;
      try {
        p = opts ? el.requestPointerLock(opts) : el.requestPointerLock();
      } catch (err) {
        if (opts && isNotSupported(err)) attempt();
        else fail();
        return;
      }
      if (p && typeof p.then === 'function') {
        this.lockViaPromise = true;
        p.then(undefined, (err: unknown) => {
          if (gen !== this.lockGen) return;
          if (opts && isNotSupported(err)) attempt();
          else fail();
        });
      } else {
        this.lockViaPromise = false;
      }
    };
    // Raw (unadjusted) movement where supported: consistent feel and no Chrome delta spikes.
    attempt({ unadjustedMovement: true });
  }

  /** Release the pointer lock (if held). The change is reported through onLockChange(false, false). */
  releaseLock(): void {
    if (document.pointerLockElement === this.el) document.exitPointerLock();
  }

  /**
   * Free-cursor play on / off (the App turns it on while a game mode flies with the cursor free).
   * Turning it off releases every button that is held without the lock (each with a release edge).
   */
  setFreeCursorActive(on: boolean): void {
    if (on === this.freeActive) return;
    this.freeActive = on;
    this.ptrDX = 0;
    this.ptrDY = 0;
    this.escapePending = false;
    if (!on && !this._locked) this.releaseButtons();
  }

  /** A game mode is active: Tab / Space / Backspace / Slash never reach the browser while flying. */
  setModeKeys(on: boolean): void {
    this.modeKeys = on;
  }

  onLockChange(cb: LockChangeCallback): void {
    this.lockCallbacks.push(cb);
  }

  poll(): InputFrame {
    const now = performance.now();
    if (this.spaceDown && !this.spaceHoldFired && now - this.spaceDownAt >= TUNING.spaceHoldSeconds * 1000) {
      this.spaceHoldFired = true;
      this.spaceHoldPending = true;
    }

    const f = this.frame;
    const k = this.held;
    const locked = this._locked;
    f.forward = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    f.strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    f.lift = (k.has('KeyR') ? 1 : 0) - (k.has('KeyF') ? 1 : 0);
    f.roll = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    f.precision = k.has('ShiftLeft') || k.has('ShiftRight');
    f.mouseDX = locked ? this.mouseDX : 0;
    f.mouseDY = locked ? this.mouseDY : 0;
    f.hyper = locked && this.hyperHeld;
    f.click = locked && this.clickPending;
    f.spaceTap = this.spaceTapPending;
    f.spaceHold = this.spaceHoldPending;
    f.wheel = locked || this.freeActive ? this.wheelAcc : 0;
    f.toggles.hud = this.toggleHud;
    f.toggles.codex = this.toggleCodex;
    f.toggles.mute = this.toggleMute;
    f.toggles.voyage = this.toggleVoyage;
    const since = this.lastPollAt < 0 ? 0 : Math.min(Math.max((now - this.lastPollAt) / 1000, 0), 0.25);
    this.lastPollAt = now;
    const moved = Math.abs(f.mouseDX) + Math.abs(f.mouseDY);
    this.moveAcc = this.moveAcc * Math.exp(-since / MOUSE_MOVE_TAU) + moved;
    f.anyMoveInput =
      f.forward !== 0 || f.strafe !== 0 || f.lift !== 0 || f.roll !== 0 ||
      (moved > 0 && this.moveAcc > MOUSE_MOVE_THRESHOLD); // only while the mouse is actually moving

    // ---- game-mode fields ----
    f.buttons = this.buttonsHeld;
    f.pressed = this.pressedBits;
    f.released = this.releasedBits;
    if (this.rectDirty) this.measureRect();
    const p = f.pointer;
    if (locked) {
      p.x = 0.5 * this.rectW;
      p.y = 0.5 * this.rectH;
      p.inside = true;
      p.dx = 0;
      p.dy = 0;
    } else {
      p.x = this.clientX - this.rectLeft;
      p.y = this.clientY - this.rectTop;
      p.inside = this.freeActive && this.pointerKnown && this.overCanvas;
      p.dx = this.freeActive ? this.ptrDX : 0;
      p.dy = this.freeActive ? this.ptrDY : 0;
    }
    const swap = this.pressedFrame;
    this.pressedFrame = this.pressedAcc;
    this.pressedAcc = swap;
    this.pressedAcc.clear();
    f.mods.shift = this.modShift;
    f.mods.ctrl = this.modCtrl;
    f.mods.alt = this.modAlt;
    f.mods.meta = this.modMeta;
    f.escape = this.escapePending;

    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelAcc = 0;
    this.clickPending = false;
    this.spaceTapPending = false;
    this.spaceHoldPending = false;
    this.toggleHud = false;
    this.toggleCodex = false;
    this.toggleMute = false;
    this.toggleVoyage = false;
    this.pressedBits = 0;
    this.releasedBits = 0;
    this.ptrDX = 0;
    this.ptrDY = 0;
    this.escapePending = false;
    return f;
  }

  dispose(): void {
    for (const [target, type, fn, opts] of this.listeners) target.removeEventListener(type, fn, opts);
    this.listeners.length = 0;
    this.lockCallbacks.length = 0;
    if (document.pointerLockElement === this.el) document.exitPointerLock();
    this.releaseAll();
  }

  // ---------------------------------------------------------------------------

  private listen(target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }

  private notify(locked: boolean, failed: boolean): void {
    for (const cb of this.lockCallbacks) cb(locked, failed);
  }

  private failLock(): void {
    if (!this.lockPending || this._locked) return;
    this.lockPending = false;
    this.releaseAll();
    this.notify(false, true);
  }

  /** Forget everything held (focus loss, lock loss): nothing may stay stuck "on". */
  private releaseAll(): void {
    this.held.clear();
    this.hyperHeld = false;
    this.clickPending = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelAcc = 0;
    this.moveAcc = 0;
    this.spaceDown = false;
    this.spaceHoldFired = false;
    this.releaseButtons();
    this.modShift = false;
    this.modCtrl = false;
    this.modAlt = false;
    this.modMeta = false;
  }

  /** Release every held mouse button, each with a release edge (a drag always ends). */
  private releaseButtons(): void {
    this.releasedBits |= this.buttonsHeld;
    this.buttonsHeld = 0;
  }

  private readMods(e: KeyboardEvent | MouseEvent): void {
    this.modShift = e.shiftKey;
    this.modCtrl = e.ctrlKey;
    this.modAlt = e.altKey;
    this.modMeta = e.metaKey;
  }

  private measureRect(): void {
    this.rectDirty = false;
    const r = this.el.getBoundingClientRect();
    this.rectLeft = Number.isFinite(r.left) ? r.left : 0;
    this.rectTop = Number.isFinite(r.top) ? r.top : 0;
    this.rectW = r.width > 0 ? r.width : Math.max(1, window.innerWidth || 1);
    this.rectH = r.height > 0 ? r.height : Math.max(1, window.innerHeight || 1);
  }

  /** Free-cursor position (client px) and whether it is over the canvas itself. */
  private trackPointer(e: MouseEvent): void {
    const x = e.clientX;
    const y = e.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (this.pointerKnown) {
      this.ptrDX += x - this.clientX;
      this.ptrDY += y - this.clientY;
    }
    this.clientX = x;
    this.clientY = y;
    this.pointerKnown = true;
    this.overCanvas = e.target === this.el;
  }

  private onLockChangeEvent = (): void => {
    const locked = document.pointerLockElement === this.el;
    if (locked) this.lockPending = false;
    if (locked === this._locked) return;
    this._locked = locked;
    if (locked) {
      // Drop focus from whatever overlay control launched us (Space/Enter must not re-trigger it).
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) active.blur();
    } else {
      this.releaseAll();
      // Where the cursor reappears is unknown until it moves.
      this.pointerKnown = false;
    }
    this.notify(locked, false);
  };

  private onLockError = (): void => {
    if (!this.lockViaPromise) this.failLock();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const code = e.code;
    // Full screen: F11 or Alt+Enter, handled synchronously inside the key event (user gesture).
    if (code === 'F11' || (e.altKey && (code === 'Enter' || code === 'NumpadEnter'))) {
      e.preventDefault();
      if (!e.repeat) toggleFullscreen();
      return;
    }
    // In full screen Esc is claimed with the Keyboard Lock API (see app/Fullscreen.ts), so it
    // reaches the page instead of the browser: release the mouse ourselves → the pause menu.
    // Free-cursor play has no lock to release: the App pauses on InputFrame.escape instead.
    if (code === 'Escape') {
      if (this._locked) document.exitPointerLock();
      else if (this.freeActive && !e.repeat) this.escapePending = true;
      return;
    }
    if (!this._locked && isFormTarget(e.target)) {
      // Free-cursor play: a focused HUD button must not swallow game keys (nor fire on Space /
      // Enter); text-entry fields keep their keys.
      if (!this.freeActive || !(e.target instanceof HTMLButtonElement)) return;
      e.target.blur();
    }
    this.readMods(e);
    if ((this.freeActive || (this._locked && this.modeKeys)) && MODE_KEYS.has(code)) e.preventDefault();
    if (!e.repeat) this.pressedAcc.add(code);
    this.held.add(code);
    if (HELD_KEYS.has(code)) return;
    if (code === 'Space') {
      e.preventDefault(); // no page scroll / focused-button activation
      if (!e.repeat && !this.spaceDown) {
        this.spaceDown = true;
        this.spaceDownAt = performance.now();
        this.spaceHoldFired = false;
      }
      return;
    }
    // In flight Tab is the codex key; with the pointer free (menus) it keeps its focus-navigation role.
    if (code === 'Tab' && this._locked) e.preventDefault();
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    switch (code) {
      case 'Tab':
      case 'KeyI':
        this.toggleCodex = true;
        break;
      case 'KeyH':
        this.toggleHud = true;
        break;
      case 'KeyM':
        this.toggleMute = true;
        break;
      case 'KeyT':
        this.toggleVoyage = true;
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const code = e.code;
    this.held.delete(code);
    this.readMods(e);
    // Buttons activate on Space *release*: never let a focused control fire while flying.
    if (code === 'Space' && (this._locked || this.freeActive || !isFormTarget(e.target))) e.preventDefault();
    if (code === 'Space' && this.spaceDown) {
      if (!this.spaceHoldFired) {
        const heldMs = performance.now() - this.spaceDownAt;
        if (heldMs >= TUNING.spaceHoldSeconds * 1000) this.spaceHoldPending = true;
        else this.spaceTapPending = true;
      }
      this.spaceDown = false;
      this.spaceHoldFired = false;
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this._locked) {
      this.trackPointer(e);
      if (this.freeActive) this.readMods(e);
      return;
    }
    const dx = e.movementX;
    const dy = e.movementY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.mouseDX += Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, dx));
    this.mouseDY += Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, dy));
  };

  private onMouseDown = (e: MouseEvent): void => {
    const bit = buttonBit(e.button);
    if (this._locked) {
      if (e.button === 0) this.clickPending = true;
      else if (e.button === 2) {
        this.hyperHeld = true;
        e.preventDefault();
      }
      this.readMods(e);
      this.buttonsHeld |= bit;
      this.pressedBits |= bit;
      return;
    }
    // Free cursor: only presses that begin on the canvas itself (HUD controls handle their own).
    if (!this.freeActive || e.target !== this.el || bit === 0) return;
    this.trackPointer(e);
    this.readMods(e);
    this.buttonsHeld |= bit;
    this.pressedBits |= bit;
    if (bit !== MOUSE_LEFT) e.preventDefault(); // no middle-button autoscroll
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 2) this.hyperHeld = false;
    const bit = buttonBit(e.button);
    if (bit !== 0 && (this.buttonsHeld & bit) !== 0) {
      this.buttonsHeld &= ~bit;
      this.releasedBits |= bit;
    }
  };

  /** The pointer left the window: it is no longer over the canvas. */
  private onMouseOut = (e: MouseEvent): void => {
    if (e.relatedTarget === null) this.overCanvas = false;
  };

  private onContextMenu = (e: Event): void => {
    if (this._locked || e.target === this.el) e.preventDefault();
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this._locked) {
      // Free-cursor play: the wheel only counts over the canvas (HUD panels may scroll).
      if (!this.freeActive || e.target !== this.el) return;
    }
    e.preventDefault();
    const notches = wheelNotches(e);
    if (!Number.isFinite(notches)) return;
    this.wheelAcc += notches;
  };

  private onBlur = (): void => {
    this.releaseAll();
  };

  private onResize = (): void => {
    this.rectDirty = true;
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.releaseAll();
  };
}
