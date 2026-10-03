/**
 * First Light click reachability (design/60-first-light-build.md §1 decision #2, §2, §L): can a player
 * actually CLICK each solution mass into place, with the game's own placement code?
 *
 *   npx tsx tools/fl-reach.ts [<levels>] [--only <id>] [--json <file>] [--jobs N] [--spacing 4] [--half 200] [--fast]
 *   npx tsx tools/fl-reach.ts --bundle 2026-10 [...]        one month of bundled dailies (public/daily/firstlight)
 *   npx tsx tools/fl-reach.ts --dailies [...]               every bundled daily (per-tier summary, failing dates)
 *
 * <levels>: a .ts/.js module or .json file (see tools/fl-solve.ts); default: every module in
 * src/game/firstlight/levels. The measurement and the GATE (REACH.minArea, used by tools/fl-check.ts) live in
 * src/game/firstlight/Reach.ts, shared with the Generator (its click-aware construction and the quick gate
 * every daily passes): flight from the vantage at 1280×720 and a 70° FOV, the reticle on a ±half px grid at
 * `spacing` px around each authored mass, wheel notches ±2, the default lab framing, the chain in light
 * order, and the aim rule at 70°, 60° and 100°. Its header documents every rule.
 *
 * --fast: the gate's own order (flight wheel 0; the notches and the lab only where the step needs them).
 * --dailies / --bundle: per-tier pass rate (tier from DailyGen.dailyPlan) and the worst days.
 * Work runs in --jobs child processes (default CPU count − 1, ≤ 7); --jobs 1 runs in-process. Exit 1 when a
 * level fails the gate.
 *
 * Exports for tools/fl-check.ts: REACH, reachLevel (re-exported from Reach.ts), reachSummary, reachRows,
 * REACH_HEADER and the report types.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { dailyPlan } from '../src/game/firstlight/DailyGen';
import { sanitizeLevel } from '../src/game/firstlight/Level';
import { REACH, reachLevel, type AimResult, type ReachOptions, type ReachReport, type StepReach } from '../src/game/firstlight/Reach';
import type { LevelDef } from '../src/game/firstlight/types';
import { loadLevels } from './fl-solve';

export { REACH, reachLevel } from '../src/game/firstlight/Reach';
export type { AimResult, ReachOptions, ReachReport, ScanResult, StepReach } from '../src/game/firstlight/Reach';

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

const px2 = (a: number): string => (a >= 100000 ? `${(a / 1000).toFixed(0)}k` : String(Math.round(a)));
const aimText = (a: AimResult | null): string => {
  if (!a) return '—';
  if (!Number.isFinite(a.miss)) return `${a.issue ?? 'no point'}`;
  return `${a.solves ? 'ok' : 'NO'} ${a.miss.toFixed(3)}R${a.snapped ? '' : ' (no snap)'}`;
};
/** The FOVs (REACH.aimFovs) at which the aim at the authored mass fails, e.g. " NO@60°". */
const aimFovFails = (s: StepReach): string =>
  s.aimFovs
    .filter((a) => !a.solves)
    .map((a) => ` NO@${a.fov}°`)
    .join('');

export const REACH_HEADER = 'level            step size     flight w0   best@n    lab w0    best    aim (flight)          aim (lab)             verdict';

export function reachRows(r: ReachReport): string[] {
  return r.steps.map((s, k) => {
    const verdict = s.pass ? (s.depth ? 'pass (depth)' : 'pass') : s.flight0 >= REACH.minArea || s.depth ? 'FAIL (aim)' : 'FAIL';
    const best = `${px2(s.flightBest)}@${s.flightBestNotch > 0 ? '+' : ''}${s.flightBestNotch}`;
    return (
      `${(k === 0 ? r.id : '').padEnd(16)} ${`${k + 1}/${s.index + 1}`.padEnd(4)} ${s.size.padEnd(7)}  ${px2(s.flight0).padStart(9)}  ${best.padStart(8)}  ` +
      `${(s.lab.length ? px2(s.lab0) : '—').padStart(7)}  ${(s.lab.length ? px2(s.labBest) : '—').padStart(6)}    ${(aimText(s.aim) + aimFovFails(s)).padEnd(20)}  ${aimText(s.aimLab).padEnd(20)}  ${verdict}`
    );
  });
}

/** One line for fl-check: the smallest flight wheel-0 area (and the depth-clause steps). */
export function reachSummary(r: ReachReport): string {
  const depth = r.steps.filter((s) => s.depth).length;
  return `${r.pass ? 'ok' : 'FAIL'} ${px2(r.minFlight0)}${depth ? ` d${depth}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// CLI (parallel: child processes fed one task at a time, results as "@@REACH {json}" lines)
// ---------------------------------------------------------------------------------------------

const TAG = '@@REACH ';
const LEVEL_DIR = resolve('src/game/firstlight/levels');
const BUNDLE_DIR = resolve('public/daily/firstlight');

interface Task {
  file: string;
  id: string;
}

interface TaskResult {
  task: Task;
  report: ReachReport | null;
  error: string | null;
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Raw levels of a file: a module / level JSON (fl-solve loadLevels) or a month bundle { date: level }. */
async function rawLevels(file: string): Promise<unknown[]> {
  if (file.startsWith(BUNDLE_DIR) || /[\\/]\d{4}-\d{2}\.json$/.test(file)) {
    return Object.values(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>);
  }
  return loadLevels(file);
}

const levelCache = new Map<string, Map<string, unknown>>();
async function levelFor(task: Task): Promise<LevelDef> {
  let m = levelCache.get(task.file);
  if (!m) {
    m = new Map();
    for (const raw of await rawLevels(task.file)) {
      const id = typeof raw === 'object' && raw !== null ? String((raw as { id?: unknown }).id) : '?';
      m.set(id, raw);
    }
    levelCache.set(task.file, m);
  }
  const errs: string[] = [];
  const level = sanitizeLevel(m.get(task.id), errs);
  if (!level) throw new Error(`${task.id} does not sanitise: ${errs.slice(0, 3).join('; ')}`);
  return level;
}

async function runTask(task: Task, opts: ReachOptions): Promise<TaskResult> {
  try {
    return { task, report: reachLevel(await levelFor(task), opts), error: null };
  } catch (e) {
    return { task, report: null, error: (e as Error).message };
  }
}

async function runAll(tasks: readonly Task[], jobs: number, workerArgs: readonly string[], opts: ReachOptions, onDone: (r: TaskResult, n: number) => void): Promise<TaskResult[]> {
  const out: TaskResult[] = [];
  if (jobs <= 1) {
    for (const t of tasks) {
      const r = await runTask(t, opts);
      out.push(r);
      onDone(r, out.length);
    }
    return out;
  }
  const queue = tasks.slice();
  await Promise.all(
    Array.from({ length: Math.min(jobs, tasks.length) }, () => {
      return new Promise<void>((resolveRun, reject) => {
        const child = spawn(process.execPath, [...process.execArgv, process.argv[1], '--worker', ...workerArgs], { stdio: ['pipe', 'pipe', 'inherit'] });
        const feed = (): void => {
          const next = queue.shift();
          child.stdin.write(next === undefined ? 'END\n' : `${JSON.stringify(next)}\n`);
        };
        const rl = createInterface({ input: child.stdout });
        rl.on('line', (line: string) => {
          if (!line.startsWith(TAG)) {
            if (line.trim()) console.log(`[worker] ${line}`);
            return;
          }
          const r = JSON.parse(line.slice(TAG.length)) as TaskResult;
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

function serveWorker(opts: ReachOptions): void {
  const rl = createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on('line', (line: string) => {
    const s = line.trim();
    if (!s) return;
    chain = chain.then(async () => {
      if (s === 'END') {
        rl.close();
        process.exit(0);
      }
      const r = await runTask(JSON.parse(s) as Task, opts);
      process.stdout.write(`${TAG}${JSON.stringify(r)}\n`);
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const spacing = Number(arg(args, '--spacing') ?? REACH.spacing);
  const half = Number(arg(args, '--half') ?? REACH.half);
  const fast = args.includes('--fast');
  const opts: ReachOptions = { spacing, half, fast };
  const workerArgs = ['--spacing', String(spacing), '--half', String(half), ...(fast ? ['--fast'] : [])];
  if (args.includes('--worker')) {
    serveWorker(opts);
    return;
  }
  if (!(spacing > 0) || !(half >= spacing)) {
    console.error('usage: npx tsx tools/fl-reach.ts [<levels> | --bundle YYYY-MM | --dailies] [--only id] [--json file] [--jobs N] [--spacing px] [--half px] [--fast]');
    process.exit(2);
  }
  const t0 = performance.now();
  const bundle = arg(args, '--bundle');
  const dailies = args.includes('--dailies') || bundle !== undefined;
  const only = arg(args, '--only');
  const jsonOut = arg(args, '--json');
  const jobsN = Number(arg(args, '--jobs'));
  const jobs = Number.isInteger(jobsN) && jobsN >= 1 ? jobsN : Math.max(1, Math.min(7, cpus().length - 1));

  let files: string[];
  if (dailies) {
    files = existsSync(BUNDLE_DIR)
      ? readdirSync(BUNDLE_DIR)
          .filter((f) => /^\d{4}-\d{2}\.json$/.test(f) && (!bundle || f === `${bundle}.json`))
          .sort()
          .map((f) => join(BUNDLE_DIR, f))
      : [];
  } else {
    const spec = args.find((a, i) => !a.startsWith('--') && !['--only', '--json', '--jobs', '--spacing', '--half', '--bundle'].includes(args[i - 1] ?? ''));
    files = spec ? [resolve(spec)] : existsSync(LEVEL_DIR) ? readdirSync(LEVEL_DIR).filter((f) => /\.(ts|js|json)$/.test(f) && !f.endsWith('.d.ts')).sort().map((f) => join(LEVEL_DIR, f)) : [];
  }
  const tasks: Task[] = [];
  for (const file of files) {
    for (const raw of await rawLevels(file)) {
      const id = typeof raw === 'object' && raw !== null ? String((raw as { id?: unknown }).id) : '?';
      if (!only || id === only) tasks.push({ file, id });
    }
  }
  if (tasks.length === 0) {
    console.error(`fl-reach: no levels${only ? ` with id ${only}` : ''}`);
    process.exit(1);
  }
  console.log(`fl-reach: ${tasks.length} level(s), ${REACH.width}×${REACH.height} ${REACH.fovDeg}° FOV, ±${half} px at ${spacing} px, notches ±${REACH.notches}${fast ? ', fast' : ''}, ${jobs} job(s)`);
  const results = await runAll(tasks, jobs, workerArgs, opts, (r, n) => {
    if (dailies) {
      const rep = r.report;
      process.stderr.write(`  [${String(n).padStart(3)}/${tasks.length}] ${r.task.id} ${rep ? `${reachSummary(rep)} (${(rep.ms / 1000).toFixed(1)} s)` : `ERROR ${r.error}`}\n`);
    }
  });
  const index = new Map(tasks.map((t, i) => [`${t.file}|${t.id}`, i]));
  results.sort((a, b) => (index.get(`${a.task.file}|${a.task.id}`) ?? 0) - (index.get(`${b.task.file}|${b.task.id}`) ?? 0));

  const errors = results.filter((r) => !r.report);
  const reports = results.map((r) => r.report).filter((r): r is ReachReport => r !== null);
  if (!dailies || args.includes('--table')) {
    console.log(`\n${REACH_HEADER}`);
    for (const r of reports) for (const line of reachRows(r)) console.log(line);
  }
  if (dailies) {
    const dateOf = (id: string): string => id.replace(/^daily-/, '');
    console.log('\ntier  days  pass   rate    depth-clause  min flight w0 p10   p50');
    for (const t of [1, 2, 3, 4]) {
      const rs = reports.filter((r) => dailyPlan(dateOf(r.id))?.tier === t);
      if (!rs.length) continue;
      const mins = rs.map((r) => r.minFlight0).sort((a, b) => a - b);
      const q = (p: number): number => mins[Math.min(mins.length - 1, Math.floor(p * mins.length))];
      console.log(
        `${String(t).padEnd(5)} ${String(rs.length).padStart(4)}  ${String(rs.filter((r) => r.pass).length).padStart(4)}  ${((100 * rs.filter((r) => r.pass).length) / rs.length).toFixed(1).padStart(5)}%  ` +
          `${String(rs.filter((r) => r.steps.some((s) => s.depth)).length).padStart(12)}  ${px2(q(0.1)).padStart(17)}  ${px2(q(0.5)).padStart(5)}`,
      );
    }
    const worst = reports.slice().sort((a, b) => a.minFlight0 - b.minFlight0).slice(0, 15);
    console.log(`\nworst days (smallest flight wheel-0 area of any step):`);
    for (const r of worst) console.log(`  ${dateOf(r.id)} tier ${dailyPlan(dateOf(r.id))?.tier ?? '?'} ${r.pass ? 'pass' : 'FAIL'}  ${r.steps.map((s) => `${s.size} ${px2(s.flight0)}/${px2(s.flightBest)}/${s.lab.length ? px2(s.lab0) : '—'}`).join('  ')}`);
    const failing = reports.filter((r) => !r.pass).map((r) => dateOf(r.id));
    console.log(`\nfailing dates (${failing.length}): ${failing.join(' ') || 'none'}`);
  }
  for (const e of errors) console.log(`ERROR ${e.task.id}: ${e.error}`);
  if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify(reports, null, 1));
  const failed = reports.filter((r) => !r.pass).length + errors.length;
  console.log(`\nfl-reach: ${reports.length} level(s), ${reports.length - reports.filter((r) => !r.pass).length} pass, ${failed} failure(s) — ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(failed ? 1 : 0);
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) await main();
