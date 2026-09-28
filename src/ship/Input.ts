/**
 * Keyboard / mouse input with pointer lock. Events are accumulated between polls and
 * delivered once per frame as an InputFrame (edges fire exactly once).
 */
import { toggleFullscreen } from '../app/Fullscreen';
import { TUNING } from '../app/config';

export interface InputFrame {
  mouseDX: number; mouseDY: number;   // raw px since last poll (0 when not pointer-locked)
  forward: number; strafe: number; lift: number; roll: number; // -1..1 (W/S, D/A, R/F, E/Q)
  precision: boolean;                 // Shift
  hyper: boolean;                     // right mouse held
  click: boolean;                     // left mouse pressed this frame (targeting)
  spaceTap: boolean;                  // Space released before hold threshold
  spaceHold: boolean;                 // Space held beyond TUNING.spaceHoldSeconds (edge: true once)
  wheel: number;                      // wheel notches since last poll (+ = up)
  toggles: { hud: boolean; codex: boolean; mute: boolean; voyage: boolean }; // H, Tab|I, M, T pressed this frame
  anyMoveInput: boolean;              // any of WASD/QE/RF/mouse movement (cancels autopilot)
}

/** Keys whose held state matters. */
const HELD_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight',
]);
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

export class Input {
  private readonly el: HTMLElement;
  private _locked = false;
  private lockPending = false;
  private lockRequestedAt = -1e9;
  private lockGen = 0;
  /** When the browser returns a promise from requestPointerLock it is authoritative for errors. */
  private lockViaPromise = false;
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

  /** Reused every poll: consumers must not keep references across frames. */
  private readonly frame: InputFrame = {
    mouseDX: 0, mouseDY: 0,
    forward: 0, strafe: 0, lift: 0, roll: 0,
    precision: false, hyper: false, click: false, spaceTap: false, spaceHold: false,
    wheel: 0,
    toggles: { hud: false, codex: false, mute: false, voyage: false },
    anyMoveInput: false,
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
    this.listen(document, 'contextmenu', this.onContextMenu);
    this.listen(window, 'wheel', this.onWheel as EventListener, { passive: false });
    this.listen(window, 'blur', this.onBlur);
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
    // Raw (unaccelerated) movement where supported: consistent feel and no Chrome delta spikes.
    attempt({ unadjustedMovement: true });
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
    f.wheel = locked ? this.wheelAcc : 0;
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
    if (code === 'Escape') {
      if (this._locked) document.exitPointerLock();
      return;
    }
    if (!this._locked && isFormTarget(e.target)) return;
    if (HELD_KEYS.has(code)) {
      this.held.add(code);
      return;
    }
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
    // Buttons activate on Space *release*: never let a focused control fire while flying.
    if (code === 'Space' && (this._locked || !isFormTarget(e.target))) e.preventDefault();
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
    if (!this._locked) return;
    const dx = e.movementX;
    const dy = e.movementY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.mouseDX += Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, dx));
    this.mouseDY += Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, dy));
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this._locked) return;
    if (e.button === 0) this.clickPending = true;
    else if (e.button === 2) {
      this.hyperHeld = true;
      e.preventDefault();
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 2) this.hyperHeld = false;
  };

  private onContextMenu = (e: Event): void => {
    if (this._locked || e.target === this.el) e.preventDefault();
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this._locked) return;
    e.preventDefault();
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
    if (!Number.isFinite(notches)) return;
    this.wheelAcc += Math.max(-MAX_NOTCHES_PER_EVENT, Math.min(MAX_NOTCHES_PER_EVENT, notches));
  };

  private onBlur = (): void => {
    this.releaseAll();
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.releaseAll();
  };
}
