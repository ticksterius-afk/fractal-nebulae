/**
 * Full-screen helpers. Entering must be called synchronously from a user gesture (click / key).
 *
 * Once full screen, the Escape key is claimed with the Keyboard Lock API (Chrome/Edge): Esc then
 * reaches the page — the app uses it to pause — instead of dropping out of full screen, so the
 * pause menu stays full screen too. Holding Esc (~2 s) still exits: the browser's own safeguard.
 * Where Keyboard Lock is unavailable (Firefox, Safari) Esc exits full screen as usual.
 */

interface KeyboardLockApi {
  lock(keys?: string[]): Promise<void>;
  unlock(): void;
}

function keyboardApi(): KeyboardLockApi | null {
  const kb = (navigator as unknown as { keyboard?: Partial<KeyboardLockApi> }).keyboard;
  return kb && typeof kb.lock === 'function' && typeof kb.unlock === 'function' ? (kb as KeyboardLockApi) : null;
}

export function fullscreenSupported(): boolean {
  return typeof document.documentElement.requestFullscreen === 'function' && document.fullscreenEnabled !== false;
}

export function isFullscreen(): boolean {
  return document.fullscreenElement != null;
}

/** Enter full screen (user gesture required). Resolves true when full screen was reached. */
export function enterFullscreen(): Promise<boolean> {
  if (isFullscreen()) {
    lockEscape();
    return Promise.resolve(true);
  }
  if (!fullscreenSupported()) return Promise.resolve(false);
  let request: Promise<void>;
  try {
    request = document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    return Promise.resolve(false);
  }
  return request.then(
    () => {
      lockEscape();
      return true;
    },
    () => false,
  );
}

export function exitFullscreen(): void {
  keyboardApi()?.unlock();
  if (!isFullscreen()) return;
  document.exitFullscreen().catch(() => undefined);
}

/** Toggle full screen (user gesture required to enter). */
export function toggleFullscreen(): void {
  if (isFullscreen()) exitFullscreen();
  else void enterFullscreen();
}

/** Subscribe to full-screen changes; returns an unsubscribe function. */
export function onFullscreenChange(cb: (fullscreen: boolean) => void): () => void {
  const handler = () => cb(isFullscreen());
  document.addEventListener('fullscreenchange', handler);
  return () => document.removeEventListener('fullscreenchange', handler);
}

function lockEscape(): void {
  const kb = keyboardApi();
  if (!kb || !isFullscreen()) return;
  kb.lock(['Escape']).catch(() => undefined);
}
