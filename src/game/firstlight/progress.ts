/**
 * First Light — local progress and the Atlas view-model (design/60-first-light-build.md §M "Save",
 * design/20-first-light.md §7.6).
 *
 * Stored through platform/save.ts under the "firstlight" namespace:
 *
 *   { solved:   { [levelId]: { masses, help, par } },      best result per authored level
 *     current:  levelId | null,                            the level to resume
 *     daily:    { streak, last, history: { [date]: { time, masses } } },
 *     seenTips: string[] }                                 physics tips already shown
 *
 * Everything read back is sanitised (ids must be save-key safe, counts clamped, sizes capped), so a
 * corrupt or hand-edited store can never break the mode. Pure data + the Atlas builder: no DOM.
 */
import type { AtlasChapter, AtlasModel } from './hud/hudTypes';
import type { ChapterDef } from './types';
import { bool, int, isRecord, load, num, save, strArray } from '../platform/save';
import { addDays, isDailyId, nextInText } from '../platform/daily';
import { formatTime } from '../platform/share';
import { NEBULA_BY_ID } from '../../universe/catalog';
import { chapterUnlocked, UNLOCK_TEXT } from './chapters';

export const PROGRESS_NS = 'firstlight';

export interface SolvedEntry {
  /** Fewest masses used in a solve. */
  masses: number;
  /** Only ever solved after opening hint 3 ("with help"). */
  help: boolean;
  /** Solved at least once with ≤ par masses and without hint 3 (the ✦). */
  par: boolean;
}

export interface DailyEntry {
  /** Solve time (s) of the first solve that day. */
  time: number;
  masses: number;
}

export interface FirstLightProgress {
  solved: Record<string, SolvedEntry>;
  current: string | null;
  daily: { streak: number; last: string | null; history: Record<string, DailyEntry> };
  seenTips: string[];
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_SOLVED = 512;
const MAX_HISTORY = 400;
const MAX_TIPS = 64;

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function emptyProgress(): FirstLightProgress {
  return { solved: {}, current: null, daily: { streak: 0, last: null, history: {} }, seenTips: [] };
}

/** Untrusted store contents → a valid progress object (never throws). */
export function sanitizeProgress(raw: unknown): FirstLightProgress {
  const p = emptyProgress();
  if (!isRecord(raw)) return p;
  if (isRecord(raw.solved)) {
    let n = 0;
    for (const id of Object.keys(raw.solved)) {
      if (n >= MAX_SOLVED) break;
      const e = raw.solved[id];
      if (!ID_RE.test(id) || !isRecord(e)) continue;
      p.solved[id] = { masses: int(e.masses, 0, 99, 0), help: bool(e.help, false), par: bool(e.par, false) };
      n++;
    }
  }
  if (typeof raw.current === 'string' && ID_RE.test(raw.current)) p.current = raw.current;
  const d = raw.daily;
  if (isRecord(d)) {
    p.daily.streak = int(d.streak, 0, 100000, 0);
    p.daily.last = typeof d.last === 'string' && isDailyId(d.last) ? d.last : null;
    if (isRecord(d.history)) {
      // Newest first, so the cap keeps the recent days.
      const dates = Object.keys(d.history)
        .filter((k) => isDailyId(k))
        .sort()
        .reverse()
        .slice(0, MAX_HISTORY);
      for (const date of dates) {
        const e = d.history[date];
        if (!isRecord(e)) continue;
        p.daily.history[date] = { time: num(e.time, 0, 360000, 0), masses: int(e.masses, 0, 99, 0) };
      }
    }
  }
  p.seenTips = strArray(raw.seenTips, MAX_TIPS, 80);
  return p;
}

export function loadProgress(): FirstLightProgress {
  return load(PROGRESS_NS, sanitizeProgress);
}

/**
 * Fold `stored` into `into` in place, keeping the best of both (another tab may have saved since
 * `into` was loaded): solves are united (fewest masses, ✦ once earned stays, "with help" only when
 * both say so); daily history is united, the stored entry winning a shared date (it was saved first);
 * the streak comes from the copy whose last solved daily is later (the longer streak on a tie); seen
 * tips are united. `current` stays this tab's own unless it has none. Idempotent.
 */
export function mergeProgress(into: FirstLightProgress, stored: FirstLightProgress): FirstLightProgress {
  let n = Object.keys(into.solved).length;
  for (const id of Object.keys(stored.solved)) {
    const s = stored.solved[id];
    if (hasOwn(into.solved, id)) {
      const o = into.solved[id];
      into.solved[id] = { masses: Math.min(o.masses, s.masses), help: o.help && s.help, par: o.par || s.par };
    } else if (n < MAX_SOLVED) {
      into.solved[id] = { masses: s.masses, help: s.help, par: s.par };
      n++;
    }
  }
  const h = into.daily.history;
  for (const date of Object.keys(stored.daily.history)) {
    const e = stored.daily.history[date];
    h[date] = { time: e.time, masses: e.masses };
  }
  const dates = Object.keys(h);
  if (dates.length > MAX_HISTORY) {
    dates.sort();
    for (let i = 0; i < dates.length - MAX_HISTORY; i++) delete h[dates[i]];
  }
  const a = into.daily.last;
  const b = stored.daily.last;
  if (b !== null && (a === null || b > a || (b === a && stored.daily.streak > into.daily.streak))) {
    into.daily.last = b;
    into.daily.streak = stored.daily.streak;
  }
  for (const t of stored.seenTips) if (!into.seenTips.includes(t)) into.seenTips.push(t);
  if (into.seenTips.length > MAX_TIPS) into.seenTips.splice(0, into.seenTips.length - MAX_TIPS);
  if (into.current === null) into.current = stored.current;
  return into;
}

/**
 * Bring `p` up to date with the store (mergeProgress). Call it right before changing `p` (a solve, a
 * tip, the current level), so streaks and first solves are computed from what every tab saved.
 */
export function syncProgress(p: FirstLightProgress): FirstLightProgress {
  return mergeProgress(p, loadProgress());
}

/**
 * Store `p`, merged with what is stored first (syncProgress), so a second tab's stale copy never
 * erases what another tab saved. Hence a save can never remove progress: a future "reset progress"
 * or import must use clear() / importAll() and then reload the mode's copy.
 */
export function saveProgress(p: FirstLightProgress): boolean {
  syncProgress(p);
  return save(PROGRESS_NS, p);
}

/** True when nothing was ever played (first-timers skip the Atlas and start the first level). */
export function isFirstTime(p: FirstLightProgress): boolean {
  return p.current === null && Object.keys(p.solved).length === 0 && Object.keys(p.daily.history).length === 0;
}

export function isSolved(p: FirstLightProgress, id: string): boolean {
  return hasOwn(p.solved, id);
}

/**
 * Record a solve, keeping the best: fewest masses, ✦ once earned stays, "with help" only while the
 * level was never solved without it. Returns true for the first solve of that level.
 */
export function recordSolve(p: FirstLightProgress, id: string, masses: number, help: boolean, par: boolean): boolean {
  if (!ID_RE.test(id)) return false;
  const old = hasOwn(p.solved, id) ? p.solved[id] : null;
  const m = Math.max(0, Math.min(99, Math.round(Number.isFinite(masses) ? masses : 0)));
  p.solved[id] = old
    ? { masses: Math.min(old.masses, m), help: old.help && help, par: old.par || par }
    : { masses: m, help, par };
  return old === null;
}

/**
 * Record a daily solve. The first solve of a date fixes its time; the streak grows when the date
 * follows the last solved daily, restarts at 1 after a gap, and is untouched by older dates
 * (replaying a past daily from a link never breaks a streak). Returns true for the first solve.
 */
export function recordDaily(p: FirstLightProgress, date: string, time: number, masses: number): boolean {
  if (!isDailyId(date)) return false;
  const first = !hasOwn(p.daily.history, date);
  if (first) {
    p.daily.history[date] = {
      time: Math.max(0, Math.min(360000, Number.isFinite(time) ? time : 0)),
      masses: Math.max(0, Math.min(99, Math.round(Number.isFinite(masses) ? masses : 0))),
    };
    const last = p.daily.last;
    if (last === null || date > last) {
      p.daily.streak = last !== null && addDays(last, 1) === date ? p.daily.streak + 1 : 1;
      p.daily.last = date;
    }
  }
  return first;
}

/** The streak as it stands today: it survives until the end of the day after the last solve. */
export function currentStreak(p: FirstLightProgress, today: string): number {
  const last = p.daily.last;
  if (last === null) return 0;
  return last === today || addDays(last, 1) === today ? p.daily.streak : 0;
}

/** Remember a physics tip; true when it had not been shown before. */
export function markTip(p: FirstLightProgress, key: string): boolean {
  if (p.seenTips.includes(key)) return false;
  p.seenTips.push(key);
  if (p.seenTips.length > MAX_TIPS) p.seenTips.splice(0, p.seenTips.length - MAX_TIPS);
  return true;
}

/** Display name of a catalogue nebula ("The Cauliflower Nebula"). */
export function nebulaName(id: string): string {
  return hasOwn(NEBULA_BY_ID, id) ? NEBULA_BY_ID[id].name : id;
}

/**
 * The Atlas view-model: chapters with their level nodes (solved / ✦ / with help / current), the
 * lock state (chapters 1–3 open; later ones per chapterUnlocked), the daily card and the ✦ count.
 */
export function buildAtlasModel(
  p: FirstLightProgress,
  chapters: readonly ChapterDef[],
  currentId: string | null,
  today: string,
  dailyLabel: string,
): AtlasModel {
  let stars = 0;
  let starsTotal = 0;
  const out: AtlasChapter[] = [];
  const solvedIds = (id: string) => isSolved(p, id);
  for (let ci = 0; ci < chapters.length; ci++) {
    const ch = chapters[ci];
    let solvedCount = 0;
    const levels = ch.levels.map((l) => {
      const e = hasOwn(p.solved, l.id) ? p.solved[l.id] : null;
      if (e) solvedCount++;
      if (e?.par) stars++;
      starsTotal++;
      return {
        id: l.id,
        index: l.index,
        name: l.name,
        solved: e !== null,
        par: e?.par ?? false,
        help: e?.help ?? false,
        current: l.id === currentId,
      };
    });
    const locked = !chapterUnlocked(chapters, ci, solvedIds);
    out.push({
      id: ch.id,
      name: ch.name,
      nebulaName: nebulaName(ch.nebula),
      rule: ch.rule,
      levels,
      solvedCount,
      locked,
      lockText: locked ? UNLOCK_TEXT : undefined,
    });
  }
  const todayEntry = hasOwn(p.daily.history, today) ? p.daily.history[today] : null;
  return {
    chapters: out,
    daily: {
      date: today,
      label: dailyLabel,
      solved: todayEntry !== null,
      streak: currentStreak(p, today),
      nextIn: nextInText(),
      time: todayEntry ? formatTime(todayEntry.time) : undefined,
    },
    stars,
    starsTotal,
  };
}
