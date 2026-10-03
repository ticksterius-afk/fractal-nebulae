/**
 * First Light daily bundles (design/20-first-light.md §3.3, §7.4; design/60-first-light-build.md §L).
 *
 *   npx tsx tools/fl-daily-build.ts [--days 400] [--from 2026-10-02] [--out public/daily/firstlight]
 *                                    [--jobs N] [--no-recheck] [--dry]
 *
 * Generates the daily of every day in the window with `generateDaily`'s own code path
 * (DailyGen.generateDailyReport) and, per day, asserts:
 *  - a level came out, with id `daily-<date>`, chapter "daily", index = the daily number, and the nebula
 *    dailyInfo() announces (labels and share strings are computed without generating);
 *  - JSON round trip: sanitizeLevel(JSON.parse(JSON.stringify(level))) is the very same level;
 *  - the full gates pass on that round-tripped level (Solver.gates, default trial counts, no early exit,
 *    the default seed fnv1a(id) — the verdict the generator reached and fl-check reproduces);
 *  - recheck (default on): a second, fresh generation of the same date gives the identical level — what
 *    the runtime fallback computes when a bundle cannot be fetched;
 *  - consecutive days use different nebulae (also against the bundled days just before and after the run).
 * Only when every day passes, writes `<out>/YYYY-MM.json` = { [dateId]: LevelDef } with one level per
 * line in date order (values exactly as generated: positions on the 1e-6 grid, unit directions at full
 * precision). A month file that already exists is merged: its entries for days outside this run are kept
 * as they are, so `--from 2027-11-06` extends 2027-11.json instead of dropping 11-01 … 11-05 (an existing
 * file that is not a JSON object is an error, and nothing is written). Files whose content is unchanged
 * are not rewritten. --dry checks without writing. Exit 1 on failure. After extending the window, check
 * it with `npx tsx tools/fl-daily-check.ts --days N` (N = days from 2026-10-02 to the new last day, inclusive).
 *
 * Work runs in --jobs child processes (default: CPU count − 1, ≤ 7) fed one date at a time; --jobs 1
 * runs in-process. Prints per-tier generation times and every fallback day.
 *
 * Exports for tools/fl-daily-check.ts: windowDates, evaluateDay, runDays, DayResult, monthOf, BUNDLE_DIR,
 * pct, quantile.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { DAILY_WINDOW_DAYS, dailyInfo, dailyPlan, generateDailyReport, type DailyFeatures } from '../src/game/firstlight/DailyGen';
import { sanitizeLevel } from '../src/game/firstlight/Level';
import { gates } from '../src/game/firstlight/Solver';
import { addDays, DAILY_EPOCH, dailyNumber, isDailyId } from '../src/game/platform/daily';
import { MASS_SIZES, type LevelDef } from '../src/game/firstlight/types';

export const BUNDLE_DIR = resolve('public/daily/firstlight');

/** `days` consecutive date ids from `from`. */
export function windowDates(from: string, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const id = addDays(from, i);
    if (id) out.push(id);
  }
  return out;
}

export const monthOf = (dateId: string): string => dateId.slice(0, 7);

export const quantile = (xs: readonly number[], q: number): number => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};

export const pct = (x: number, digits = 1): string => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : '—');

const budgetKey = (l: LevelDef): string =>
  MASS_SIZES.filter((s) => (l.budget[s] ?? 0) > 0)
    .map((s) => ((l.budget[s] ?? 0) > 1 ? `${s}×${l.budget[s]}` : s))
    .join('+');

export interface DayGates {
  pass: boolean;
  failures: string[];
  accidental: number;
  robust: number;
  tolerant: number;
  pathLength: number;
  bends: number;
  unlensedClosest: number;
  evals: number;
  ms: number;
}

/** Everything one day's evaluation found (JSON-friendly: it crosses the worker pipe). */
export interface DayResult {
  date: string;
  /** The level under test: the bundled entry (check) or the generated one (build); null if none. */
  level: LevelDef | null;
  /** Planned tier (weekday) and the tier of the recipe that produced the level (lower = fallback). */
  tier: number;
  usedTier: number;
  /** Budget, e.g. "heavy+light". */
  budget: string;
  /** Generator call that succeeded (0 = planned recipe in the scheduled arena); −1 when not generated. */
  step: number;
  arena: number;
  /** Generation (when run). */
  genMs: number;
  attempts: number;
  features: DailyFeatures | null;
  gates: DayGates | null;
  /** The stored level is canonical: sanitising its JSON gives it back unchanged. */
  roundTrip: boolean;
  /** A (re)generation equals the level under test; null when not run. */
  identical: boolean | null;
  errors: string[];
}

export interface EvalOptions {
  /** The bundled entry to test (check); absent = test a fresh generation (build). */
  bundled?: unknown;
  /** Run the full gates. */
  gates: boolean;
  /** Generate (again) and compare with the level under test. */
  regenerate: boolean;
}

const canon = (l: LevelDef | null): string => (l ? JSON.stringify(l) : 'null');

/** Evaluates one day (see the header of this file and of fl-daily-check.ts). */
export function evaluateDay(date: string, opts: EvalOptions): DayResult {
  const errors: string[] = [];
  const plan = dailyPlan(date);
  const res: DayResult = {
    date,
    level: null,
    tier: plan?.tier ?? 0,
    usedTier: 0,
    budget: '',
    step: -1,
    arena: -1,
    genMs: NaN,
    attempts: 0,
    features: null,
    gates: null,
    roundTrip: false,
    identical: null,
    errors,
  };
  if (!plan) {
    errors.push('not a daily date');
    return res;
  }
  let level: LevelDef | null = null;
  const bundledMode = opts.bundled !== undefined;
  if (bundledMode) {
    const errs: string[] = [];
    level = sanitizeLevel(opts.bundled, errs);
    if (!level) errors.push(`bundle entry does not sanitise: ${errs.slice(0, 3).join('; ')}`);
    else res.roundTrip = JSON.stringify(opts.bundled) === canon(level);
  }
  if (!bundledMode || opts.regenerate) {
    const rep = generateDailyReport(date);
    res.genMs = rep.ms;
    res.attempts = rep.attempts;
    res.step = rep.step;
    res.arena = rep.arena;
    res.usedTier = rep.recipe?.tier ?? 0;
    res.features = rep.features;
    if (!rep.level) errors.push('generation returned null');
    if (bundledMode) {
      res.identical = canon(rep.level) === canon(level);
      if (!res.identical) errors.push('runtime generation differs from the bundle');
    } else {
      level = rep.level;
      if (level) {
        const back = sanitizeLevel(JSON.parse(JSON.stringify(level)) as unknown);
        res.roundTrip = canon(back) === canon(level);
      }
      if (opts.regenerate) {
        res.identical = canon(generateDailyReport(date).level) === canon(level);
        if (!res.identical) errors.push('a second generation differs');
      }
    }
  }
  res.level = level;
  if (!level) return res;
  if (!res.roundTrip) errors.push('JSON round trip changes the level');
  res.budget = budgetKey(level);
  if (level.id !== `daily-${date}`) errors.push(`id "${level.id}"`);
  if (level.chapter !== 'daily') errors.push(`chapter "${level.chapter}"`);
  if (level.index !== dailyNumber(date)) errors.push(`index ${level.index} ≠ #${dailyNumber(date)}`);
  if (level.name !== `Daily #${dailyNumber(date)}`) errors.push(`name "${level.name}"`);
  if (level.nebula !== dailyInfo(date).nebula) errors.push(`nebula ${level.nebula} ≠ dailyInfo ${dailyInfo(date).nebula}`);
  if (opts.gates) {
    const g = gates(level);
    res.gates = {
      pass: g.pass,
      failures: g.failures,
      accidental: g.accidental,
      robust: g.robust,
      tolerant: g.tolerant,
      pathLength: g.pathLength,
      bends: g.bends,
      unlensedClosest: g.unlensedClosest,
      evals: g.evals,
      ms: g.ms,
    };
    if (!g.pass) errors.push(`gates: ${g.failures.join(', ')}`);
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Parallel runner: child processes fed one date at a time over stdin, results as "@@DAY {json}" lines.
// ---------------------------------------------------------------------------------------------

const TAG = '@@DAY ';

/**
 * Runs `work(date)` for every date, in `jobs` child processes of `script` (started with `workerArgs`;
 * the script must call `serveWorker(work)` when it sees them) or in-process when jobs ≤ 1.
 */
export async function runDays(
  dates: readonly string[],
  jobs: number,
  script: string,
  workerArgs: readonly string[],
  work: (date: string) => DayResult,
  onDone: (r: DayResult, done: number) => void,
): Promise<DayResult[]> {
  const out: DayResult[] = [];
  if (jobs <= 1) {
    for (const d of dates) {
      const r = work(d);
      out.push(r);
      onDone(r, out.length);
    }
    return out;
  }
  const queue = dates.slice();
  await Promise.all(
    Array.from({ length: Math.min(jobs, dates.length) }, () => {
      return new Promise<void>((resolveRun, reject) => {
        const child = spawn(process.execPath, [...process.execArgv, script, ...workerArgs], { stdio: ['pipe', 'pipe', 'inherit'] });
        const feed = (): void => {
          const next = queue.shift();
          child.stdin.write(next === undefined ? 'END\n' : `${next}\n`);
        };
        const rl = createInterface({ input: child.stdout });
        rl.on('line', (line: string) => {
          if (!line.startsWith(TAG)) {
            if (line.trim()) console.log(`[worker] ${line}`);
            return;
          }
          const r = JSON.parse(line.slice(TAG.length)) as DayResult;
          out.push(r);
          onDone(r, out.length);
          feed();
        });
        child.on('error', reject);
        child.on('exit', (code: number | null) => (code === 0 ? resolveRun() : reject(new Error(`worker exited with ${code}`))));
        feed();
      });
    }),
  );
  return out;
}

/** Worker side of runDays: reads dates from stdin until END, prints one result line per date. */
export function serveWorker(work: (date: string) => DayResult): void {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line: string) => {
    const d = line.trim();
    if (d === 'END') {
      rl.close();
      process.exit(0);
    }
    if (!d) return;
    let r: DayResult;
    try {
      r = work(d);
    } catch (e) {
      r = { ...evaluateDay('invalid', { gates: false, regenerate: false }), date: d, errors: [`threw: ${(e as Error).message}`] };
    }
    process.stdout.write(`${TAG}${JSON.stringify(r)}\n`);
  });
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export function jobsArg(args: string[]): number {
  const j = Number(arg(args, '--jobs'));
  return Number.isInteger(j) && j >= 1 ? j : Math.max(1, Math.min(7, cpus().length - 1));
}

/** The month file text: one `"date":{level}` per line, in date order. */
function monthText(entries: ReadonlyMap<string, unknown>): string {
  const dates = [...entries.keys()].sort();
  return `{\n${dates.map((d) => `${JSON.stringify(d)}:${JSON.stringify(entries.get(d))}`).join(',\n')}\n}\n`;
}

/** The entries of an existing month file (empty when there is none); throws when it is not a JSON object. */
function readMonth(file: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!existsSync(file)) return out;
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('not a JSON object');
  for (const [k, v] of Object.entries(data)) out.set(k, v);
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const recheck = !args.includes('--no-recheck');
  const work = (d: string): DayResult => evaluateDay(d, { gates: true, regenerate: recheck });
  if (args.includes('--worker')) {
    serveWorker(work);
    return;
  }
  const days = Number(arg(args, '--days') ?? DAILY_WINDOW_DAYS);
  const from = arg(args, '--from') ?? DAILY_EPOCH;
  const outDir = resolve(arg(args, '--out') ?? BUNDLE_DIR);
  if (!Number.isInteger(days) || days < 1 || !isDailyId(from) || dailyNumber(from) < 1) {
    console.error('usage: npx tsx tools/fl-daily-build.ts [--days N] [--from YYYY-MM-DD (≥ 2026-10-02)] [--out dir] [--jobs N] [--no-recheck] [--dry]');
    process.exit(2);
  }
  const jobs = jobsArg(args);
  const dates = windowDates(from, days);
  const t0 = performance.now();
  console.log(`fl-daily-build: ${dates.length} days ${dates[0]} … ${dates[dates.length - 1]}, ${jobs} job(s), recheck ${recheck ? 'on' : 'off'}`);
  const results = await runDays(dates, jobs, process.argv[1], ['--worker', ...(recheck ? [] : ['--no-recheck'])], work, (r, n) => {
    const mark = r.errors.length ? `FAIL ${r.errors.join('; ')}` : r.step > 0 ? `fallback step ${r.step} (tier ${r.usedTier})` : 'ok';
    process.stderr.write(`  [${String(n).padStart(3)}/${dates.length}] ${r.date} tier ${r.tier} ${(r.level?.nebula ?? '?').padEnd(10)} ${r.budget.padEnd(18)} ${r.genMs.toFixed(0).padStart(5)} ms  ${mark}\n`);
  });
  results.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const failures: string[] = [];
  for (const r of results) for (const e of r.errors) failures.push(`${r.date}: ${e}`);
  for (let i = 1; i < results.length; i++) {
    const a = results[i - 1].level;
    const b = results[i].level;
    if (a && b && a.nebula === b.nebula) failures.push(`${results[i].date}: same nebula as the day before (${b.nebula})`);
  }
  if (results.length !== dates.length) failures.push(`${dates.length - results.length} day(s) missing from the results`);

  // The month files as they are now: merged below (days outside this run are kept); the bundled days
  // just before and after the run must be on other nebulae too.
  const existing = new Map<string, Map<string, unknown>>();
  const month = (m: string): Map<string, unknown> => {
    let e = existing.get(m);
    if (!e) {
      try {
        e = readMonth(join(outDir, `${m}.json`));
      } catch (err) {
        failures.push(`${m}.json: the existing bundle does not read as a JSON object (${(err as Error).message}); fix or delete it first`);
        e = new Map();
      }
      existing.set(m, e);
    }
    return e;
  };
  for (const r of results) month(monthOf(r.date));
  const seams = [
    [results[0], addDays(dates[0], -1)],
    [results[results.length - 1], addDays(dates[dates.length - 1], 1)],
  ] as const;
  for (const [r, d] of seams) {
    if (!r?.level || !d) continue;
    const kept = month(monthOf(d)).get(d);
    const nebula = typeof kept === 'object' && kept !== null ? (kept as { nebula?: unknown }).nebula : undefined;
    if (nebula === r.level.nebula) failures.push(`${r.date}: same nebula as the bundled ${d} (${r.level.nebula})`);
  }

  // Summary per tier.
  console.log('\ntier  days  fallback  gen p50   p95    max     gates p50  budgets');
  for (const t of [1, 2, 3, 4]) {
    const rs = results.filter((r) => r.tier === t);
    if (!rs.length) continue;
    const ms = rs.map((r) => r.genMs);
    const budgets = new Map<string, number>();
    for (const r of rs) budgets.set(r.budget, (budgets.get(r.budget) ?? 0) + 1);
    console.log(
      `${String(t).padEnd(5)} ${String(rs.length).padStart(4)}  ${String(rs.filter((r) => r.step > 0).length).padStart(8)}  ` +
        `${quantile(ms, 0.5).toFixed(0).padStart(6)} ${quantile(ms, 0.95).toFixed(0).padStart(6)} ${Math.max(...ms).toFixed(0).padStart(6)}  ` +
        `${quantile(rs.map((r) => r.gates?.ms ?? NaN), 0.5).toFixed(0).padStart(9)}  ${[...budgets].map(([k, v]) => `${k} ×${v}`).join(', ')}`,
    );
  }
  const fb = results.filter((r) => r.step > 0);
  if (fb.length) console.log(`\nfallback days: ${fb.map((r) => `${r.date} (step ${r.step}, tier ${r.tier} → ${r.usedTier}, ${r.budget})`).join(', ')}`);

  if (failures.length) {
    for (const f of failures) console.log(`ERROR ${f}`);
    console.log(`\nfl-daily-build: ${failures.length} failure(s); nothing written — ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    process.exit(1);
  }

  // Write the month files: the existing entries, with this run's days added or replaced.
  const months = new Map<string, Map<string, unknown>>();
  for (const r of results) {
    const m = monthOf(r.date);
    let entries = months.get(m);
    if (!entries) months.set(m, (entries = new Map(month(m))));
    entries.set(r.date, r.level);
  }
  let written = 0;
  let bytes = 0;
  if (!args.includes('--dry')) mkdirSync(outDir, { recursive: true });
  for (const [m, entries] of months) {
    const file = join(outDir, `${m}.json`);
    const text = monthText(entries);
    bytes += text.length;
    if (args.includes('--dry')) continue;
    if (existsSync(file) && readFileSync(file, 'utf8') === text) continue;
    writeFileSync(file, text);
    written++;
  }
  console.log(
    `\nfl-daily-build: ${results.length} days OK (gates passed, round trip exact, ${recheck ? 'regeneration identical' : 'no recheck'}); ` +
      `${months.size} month file(s), ${(bytes / 1024).toFixed(0)} KB, ${args.includes('--dry') ? 'dry run (nothing written)' : `${written} written to ${outDir}`} — ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) await main();
