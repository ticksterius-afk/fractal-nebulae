/**
 * First Light — the daily's runtime generation off the main thread (browser only; the Node tools call
 * DailyGen directly and never import this file).
 *
 * loadDaily(date, '', generateDailyAsync) generates when the month bundle cannot be used (a failed fetch,
 * or a day after the bundled window). A Saturday takes seconds (DailyGen header: p95 9.8 s on one core);
 * run on the main thread it would stop rendering, input and Tone's scheduling for that long. Here the same
 * DailyGen.generateDaily runs in a module worker (dailyWorker.ts): same engine, same code, and structured
 * clone keeps every double, so the level is bit-identical to the bundle's.
 *
 *  - One worker, created on first use and kept (its own generateDaily memo answers a repeat at once).
 *  - One promise per date, replies matched by date; a generated level is kept (copies are returned), a
 *    null or failed result is forgotten and retried next time, as DailyGen's month bundles are.
 *  - No Worker, a constructor that throws, or a worker 'error' / 'messageerror' (e.g. a browser without
 *    module workers): every pending date and every later call generates synchronously on the main
 *    thread (the old behaviour: correct, only blocking).
 *  - cancelDailyGeneration() (the mode's exit()) terminates a worker that is still generating, rejects
 *    its pending promises with an AbortError and forgets them, so the next call starts a fresh worker.
 *
 * Public API:
 *   generateDailyAsync(dateId) → Promise<LevelDef | null>   = generateDaily(dateId), off the main thread
 *   cancelDailyGeneration() → boolean                        true when a busy worker was stopped
 */
import { generateDaily } from './DailyGen';
import type { LevelDef } from './types';

/** Main thread → worker. */
export interface DailyRequest {
  dateId: string;
}

/** Worker → main thread: the level (null for an invalid or pre-launch date) or the generator's error. */
export interface DailyReply {
  dateId: string;
  level: LevelDef | null;
  error: string | null;
}

interface Pending {
  resolve: (level: LevelDef | null) => void;
  reject: (err: unknown) => void;
}

let worker: Worker | null = null;
/** Set once workers are unavailable or failed: every later call generates on the main thread. */
let broken = false;
/** Requests the worker has not answered yet, by date. */
const pending = new Map<string, Pending>();
/** One promise per date: in flight or generated (failures are removed). */
const memo = new Map<string, Promise<LevelDef | null>>();

/** A deep copy (levels are plain JSON data). */
const copyLevel = (l: LevelDef): LevelDef => JSON.parse(JSON.stringify(l)) as LevelDef;

/** Main-thread generation (the fallback), one macrotask later so a "preparing" state can paint. */
function generateHere(dateId: string): Promise<LevelDef | null> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(generateDaily(dateId));
      } catch (err) {
        reject(err);
      }
    }, 30);
  });
}

/** The worker failed: never use one again; every request it still owed is generated here. */
function fail(w: Worker, why: string): void {
  if (w !== worker) return;
  w.terminate();
  worker = null;
  broken = true;
  console.warn(`[firstlight] daily worker unavailable (${why}); generating on the main thread`);
  const owed = [...pending];
  pending.clear();
  for (const [dateId, p] of owed) generateHere(dateId).then(p.resolve, p.reject);
}

function getWorker(): Worker | null {
  if (worker || broken) return worker;
  if (typeof Worker !== 'function') {
    broken = true;
    return null;
  }
  try {
    // Written exactly like this so Vite finds and bundles the worker (works with base './').
    const w = new Worker(new URL('./dailyWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<DailyReply>) => {
      const r = e.data;
      const p = r && typeof r.dateId === 'string' ? pending.get(r.dateId) : undefined;
      if (!p) return;
      pending.delete(r.dateId);
      if (r.error !== null) p.reject(new Error(`daily generation failed in the worker: ${r.error}`));
      else p.resolve(r.level);
    };
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      fail(w, e.message || 'error');
    };
    w.onmessageerror = () => fail(w, 'messageerror');
    worker = w;
  } catch {
    broken = true;
  }
  return worker;
}

function generate(dateId: string): Promise<LevelDef | null> {
  const w = getWorker();
  if (!w) return generateHere(dateId);
  return new Promise((resolve, reject) => {
    pending.set(dateId, { resolve, reject });
    try {
      w.postMessage({ dateId } satisfies DailyRequest);
    } catch (err) {
      fail(w, String(err));
    }
  });
}

/**
 * generateDaily(dateId) without blocking the main thread: the same level (a fresh copy), null for an
 * invalid or pre-launch date. Rejects if the generator throws, or with an AbortError when cancelled.
 */
export function generateDailyAsync(dateId: string): Promise<LevelDef | null> {
  let p = memo.get(dateId);
  if (!p) {
    const job: Promise<LevelDef | null> = generate(dateId).then(
      (level) => {
        if (!level && memo.get(dateId) === job) memo.delete(dateId);
        return level;
      },
      (err: unknown) => {
        if (memo.get(dateId) === job) memo.delete(dateId);
        throw err;
      },
    );
    memo.set(dateId, job);
    p = job;
  }
  return p.then((level) => (level ? copyLevel(level) : null));
}

/**
 * Stops a worker that is still generating (the mode left First Light): its pending promises reject with
 * an AbortError and are forgotten, and the next request starts a fresh worker. An idle worker is kept.
 */
export function cancelDailyGeneration(): boolean {
  if (!worker || pending.size === 0) return false;
  worker.terminate();
  worker = null;
  const owed = [...pending];
  pending.clear();
  for (const [dateId, p] of owed) {
    memo.delete(dateId);
    p.reject(Object.assign(new Error('daily generation cancelled'), { name: 'AbortError' }));
  }
  return true;
}
