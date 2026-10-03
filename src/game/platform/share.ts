/**
 * Wordle-style, spoiler-free share strings and clipboard copy (design/10-platform.md §9,
 * design/20-first-light.md §3.3):
 *
 *   First Light #42 · Menger · ◆◆◇  ⚬⚬  1:12
 *   https://ticksterius-afk.github.io/fractal-nebulae/?mode=firstlight&daily=2026-10-02
 *
 * ◆ = seed lit, ◇ = seed unlit, ⚬ = one mass used, then the solve time. No positions, no spoilers.
 */

export interface ShareInput {
  /** Daily number (#42). */
  number: number;
  /** Short nebula name, e.g. "Menger". Empty omits the field. */
  nebula: string;
  seedsLit: number;
  seedsTotal: number;
  massesUsed: number;
  /** Solve time in seconds. */
  time: number;
  /** Link to the same daily; empty omits the second line. */
  url?: string;
  /** Game title (default "First Light"); lets the later modes reuse the format. */
  title?: string;
}

const LIT = '◆'; // ◆
const UNLIT = '◇'; // ◇
const MASS = '⚬'; // ⚬
const DOT = '·'; // ·

const count = (x: number, max: number) => (Number.isFinite(x) ? Math.min(Math.max(Math.floor(x), 0), max) : 0);
/** One line of plain text: no newlines or control characters, collapsed spaces, capped length. */
const oneLine = (s: unknown, max: number) =>
  typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Seconds → "m:ss" ("h:mm:ss" from an hour on). Negative or non-finite → "0:00". */
export function formatTime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const sec = ss < 10 ? `0${ss}` : String(ss);
  if (h > 0) return `${h}:${m < 10 ? `0${m}` : m}:${sec}`;
  return `${m}:${sec}`;
}

/** The share text (one line, plus the URL on a second line when given). */
export function buildShare(p: ShareInput): string {
  const total = count(p.seedsTotal, 16);
  const lit = Math.min(count(p.seedsLit, 16), total);
  const title = oneLine(p.title, 32) || 'First Light';
  const num = count(p.number, 999_999);
  const nebula = oneLine(p.nebula, 32);
  const groups = [LIT.repeat(lit) + UNLIT.repeat(total - lit), MASS.repeat(count(p.massesUsed, 16)), formatTime(p.time)];
  let line = `${title} #${num}`;
  if (nebula) line += ` ${DOT} ${nebula}`;
  line += ` ${DOT} ${groups.filter((g) => g.length > 0).join('  ')}`;
  const url = oneLine(p.url, 512);
  return url ? `${line}\n${url}` : line;
}

/**
 * Link that opens a mode's daily: `<base>?mode=<mode>&daily=<id>`. `base` defaults to this page
 * (origin + path, no query or hash); without a page (Node) the link is relative ("?mode=…").
 */
export function dailyShareUrl(id: string, mode: string, base?: string): string {
  let b = base;
  if (b === undefined) b = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '';
  b = b.replace(/[?#].*$/, '');
  return `${b}?mode=${encodeURIComponent(mode)}&daily=${encodeURIComponent(id)}`;
}

/**
 * Copy text to the clipboard. Tries the async Clipboard API (secure contexts), then the legacy
 * hidden-textarea `execCommand('copy')`. Call it from a user gesture (a click). Never throws;
 * resolves false when nothing worked (or outside a browser).
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof window !== 'undefined' && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* permission denied / document not focused: fall back below */
    }
  }
  return copyWithTextarea(text);
}

function copyWithTextarea(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  // Hand focus back (the Copy button), so keyboard shortcuts keep working as before.
  if (prevFocus) {
    try {
      prevFocus.focus({ preventScroll: true });
    } catch {
      /* element gone */
    }
  }
  return ok;
}
