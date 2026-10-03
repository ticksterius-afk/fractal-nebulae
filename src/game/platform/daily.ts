/**
 * Daily puzzles (design/10-platform.md §9, design/20-first-light.md §3.3).
 *
 * One puzzle per UTC day for everyone: the id is the UTC date `YYYY-MM-DD`, the generator seed is
 * `fnv1a(id + ':' + mode)`, and the public number counts days from launch (#1 = 2026-10-02).
 * Everything works on whole UTC days, so the local time zone never changes an id.
 */
import { fnv1a } from './prng';

const DAY_MS = 86_400_000;
/** The first daily (#1). */
export const DAILY_EPOCH = '2026-10-02';
const ID_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/** UTC day index (days since 1970-01-01) of a valid `YYYY-MM-DD`, else NaN. Rejects 2026-02-30. */
function dayIndex(id: string): number {
  const m = ID_RE.exec(id);
  if (!m) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN;
  return Math.round(t / DAY_MS);
}

const EPOCH_INDEX = dayIndex(DAILY_EPOCH);

/** UTC date id `YYYY-MM-DD` of `date` (default: now). */
export function dailyId(date: Date = new Date()): string {
  const t = date.getTime();
  const d = Number.isFinite(t) ? date : new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** True for a real calendar date in `YYYY-MM-DD` form. */
export function isDailyId(id: string): boolean {
  return Number.isFinite(dayIndex(id));
}

/** Generator seed (uint32) for a day and a mode: fnv1a(`${id}:${mode}`). */
export function dailySeed(id: string, mode: string): number {
  return fnv1a(`${id}:${mode}`);
}

/** Public puzzle number: 2026-10-02 → 1, 2026-10-03 → 2. Invalid ids (or days before #1) → 0. */
export function dailyNumber(id: string): number {
  const i = dayIndex(id);
  return Number.isFinite(i) && i >= EPOCH_INDEX ? i - EPOCH_INDEX + 1 : 0;
}

/** Whole UTC days from id `a` to id `b` (b − a; 1 = consecutive days, for streaks). NaN if invalid. */
export function daysBetween(a: string, b: string): number {
  return dayIndex(b) - dayIndex(a);
}

/** The id `n` days after `id` (negative = before), or null if `id` is invalid. */
export function addDays(id: string, n: number): string | null {
  const i = dayIndex(id);
  if (!Number.isFinite(i) || !Number.isFinite(n)) return null;
  const d = new Date((i + Math.trunc(n)) * DAY_MS);
  return Number.isFinite(d.getTime()) ? dailyId(d) : null; // beyond the Date range: not today's id
}

/** Milliseconds until the next daily (the next UTC midnight); in (0, 86 400 000]. */
export function msUntilNextDaily(date: Date = new Date()): number {
  const t = Number.isFinite(date.getTime()) ? date.getTime() : Date.now();
  return (Math.floor(t / DAY_MS) + 1) * DAY_MS - t;
}

/** Countdown to the next daily as "hh:mm" (whole minutes remaining, 00:00 in the last minute). */
export function nextInText(date: Date = new Date()): string {
  const min = Math.min(1439, Math.floor(msUntilNextDaily(date) / 60_000));
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

/**
 * `?daily=` value → a playable daily id, or null. Accepts "today" and `YYYY-MM-DD` between #1 and
 * today (UTC) inclusive: future days are not out yet, and nothing exists before launch.
 */
export function parseDailyParam(str: string | null | undefined, now: Date = new Date()): string | null {
  if (typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  if (s.length === 0 || s.length > 16) return null;
  const today = dailyId(now);
  if (s === 'today') return today;
  const i = dayIndex(s);
  if (!Number.isFinite(i) || i < EPOCH_INDEX || i > dayIndex(today)) return null;
  return s;
}
