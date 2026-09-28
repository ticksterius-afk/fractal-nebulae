// Entry point — wired up by the integration step (see src/app/App.ts).
import { App } from './app/App';

const app = new App(
  document.getElementById('gl') as HTMLCanvasElement,
  document.getElementById('hud-root') as HTMLElement,
);
// Dev-only handle for debugging / visual tuning from the console.
if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app;
app.boot().catch((err: unknown) => {
  console.error(err);
  // Above the HUD layer (z-index 10 → start screen 60 / pause 50), as text: stack traces contain
  // "<anonymous>" and friends, which HTML parsing would swallow.
  const pre = document.createElement('pre');
  pre.style.cssText =
    'position:fixed;inset:auto 16px 16px 16px;z-index:1000;margin:0;padding:10px 12px;max-height:40vh;overflow:auto;' +
    'background:rgba(20,4,8,0.85);border:1px solid rgba(255,107,122,0.4);border-radius:6px;' +
    'color:#ff8a8a;font:12px/1.45 monospace;white-space:pre-wrap;user-select:text';
  pre.textContent = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  if (err instanceof Error && err.stack && !err.stack.includes(err.message)) pre.textContent = `${err.message}\n${err.stack}`;
  document.body.appendChild(pre);
});
