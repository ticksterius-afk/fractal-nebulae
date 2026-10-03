/**
 * First Light daily check (design/60-first-light-build.md §L, §Q). Headless, CI-able:
 *
 *   npx tsx tools/fl-daily-check.ts [--all | --sample N | --fast] [--jobs N] [--days 400] [--dir public/daily/firstlight]
 *                                   [--today YYYY-MM-DD]
 *
 * 1. Bundles: loads every YYYY-MM.json in the bundle folder (tools/fl-daily-build.ts writes them):
 *    valid JSON objects, valid date keys filed under their month, exactly the DAILY_WINDOW_DAYS days
 *    from DAILY_EPOCH with no gap (days outside the window are a warning).
 * 2. Every entry: sanitises, is canonical (sanitising its JSON returns it unchanged), id `daily-<date>`,
 *    chapter "daily", index = the daily number, name "Daily #N", nebula = dailyInfo(date).nebula, budget =
 *    the weekday's recipe (else a fallback warning), texts within the HUD limits (teach ≤ 90 chars, three
 *    non-empty hints, no seed letters), consecutive days on different nebulae.
 * 3. A sample (default: the first 14 days, every 5th day and the last 7, ≈ 95 days; --sample N: every
 *    Nth; --all: every day) runs fl-check's gates (Solver.gates with the default seed and trial counts)
 *    and is regenerated at runtime (DailyGen.generateDailyReport): the result must be byte-identical to
 *    the bundle (determinism across processes). Arena checks (fl-check style, once per arena): vantage
 *    in free space with a clear line of sight, DE reliability (fl-arenas arenaReliability).
 * 4. Loader (Node): loadDaily without a document/relative URL generates (= bundle); with a fake fetch
 *    it reads the bundle, fetches each month once, and falls back to generation on a 404, an HTML page
 *    (Vite's dev fallback), another month's file, a tampered entry, a stale entry (another nebula than
 *    dailyInfo's), a throwing fetch or no fetch at all; invalid / pre-launch ids give null. Beyond the window: the first day after it
 *    generates at runtime and passes the gates (the fallback once the bundles run out).
 * Runway: the bundles must cover at least RUNWAY_DAYS consecutive days from today (UTC; --today overrides),
 *    so CI fails well before the runtime starts generating every daily on the main thread (seconds per
 *    day, tier 3 up to ~17 s). Raise DAILY_WINDOW_DAYS and rerun tools/fl-daily-build.ts before then.
 * 5. Prints difficulty stats per tier (budget, seeds, path length, bends, accidental %, tolerant %,
 *    robust, unlensed "almost" distance, generation time p50/p95/max, teach lines) and the nebula
 *    rotation. Generation times are honest with --jobs 1 (the default); parallel jobs share CPU cores.
 * --fast (the CI guard in `npm run check:game`, a few seconds): steps 1–2, the runway and step 4 with the
 *    window's first two tier-1 days as the loader's sample, so its runtime generations double as a cheap
 *    determinism spot check (a Generator change without rebuilt bundles fails); no gates, arenas, stats
 *    or beyond-the-window generation.
 * Exits 1 on any error.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DAILY_RECIPES, DAILY_WINDOW_DAYS, dailyInfo, dailyPlan, loadDaily, NEBULA_CYCLE } from '../src/game/firstlight/DailyGen';
import { DAILY_ARENAS } from '../src/game/firstlight/dailyArenas';
import { sanitizeLevel } from '../src/game/firstlight/Level';
import { DAILY_EPOCH, addDays, dailyId, isDailyId } from '../src/game/platform/daily';
import { MASS_SIZES, type LevelDef } from '../src/game/firstlight/types';
import { arenaReliability, ARENA_RULES, checkVantage, nebulaDE } from './fl-arenas';
import { BUNDLE_DIR, evaluateDay, monthOf, pct, quantile, runDays, serveWorker, windowDates, type DayResult } from './fl-daily-build';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Bundled days that must remain ahead of today before CI fails (the window ends 2027-11-05 for 400 days). */
const RUNWAY_DAYS = 60;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Every bundle entry by date, plus problems found while reading the files. */
function loadBundles(dir: string, errors: string[], warnings: string[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!existsSync(dir)) {
    errors.push(`no bundle folder ${dir} (run npx tsx tools/fl-daily-build.ts)`);
    return out;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of files) {
    const m = /^(\d{4}-\d{2})\.json$/.exec(f);
    if (!m) {
      warnings.push(`${f}: not a YYYY-MM.json bundle (ignored)`);
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
    } catch (e) {
      errors.push(`${f}: invalid JSON (${(e as Error).message})`);
      continue;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      errors.push(`${f}: not an object`);
      continue;
    }
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (!isDailyId(k)) errors.push(`${f}: key "${k}" is not a date`);
      else if (monthOf(k) !== m[1]) errors.push(`${f}: ${k} is filed under the wrong month`);
      else if (out.has(k)) errors.push(`${f}: ${k} appears twice`);
      else out.set(k, v);
    }
  }
  return out;
}

/** Static checks of one entry that need no tracing (texts, recipe, identity). */
function entryChecks(date: string, level: LevelDef, warnings: string[], errors: string[]): void {
  const plan = dailyPlan(date);
  if (!plan) return;
  const want = new Map<string, number>();
  for (const s of plan.recipe.masses) want.set(s, (want.get(s) ?? 0) + 1);
  const same = MASS_SIZES.every((s) => (level.budget[s] ?? 0) === (want.get(s) ?? 0));
  if (!same) warnings.push(`${date} (${WEEKDAY[plan.weekday]}): fallback budget ${JSON.stringify(level.budget)} instead of [${plan.recipe.masses.join(', ')}]`);
  if (level.teach.trim().length === 0 || level.teach.length > 90) errors.push(`${date}: teach line "${level.teach}" (${level.teach.length} chars; 1–90 wanted)`);
  for (let i = 0; i < 3; i++) {
    const h = level.hints[i];
    if (h.trim().length === 0) errors.push(`${date}: hint ${i + 1} is empty`);
    // Seeds have no visible labels in the game: hints name them by path order, never "seed A".
    if (/\bseeds?\s+["'‘“]?[A-P]\b|\b[A-P]\s+and\s+[A-P]\b/.test(h)) errors.push(`${date}: hint ${i + 1} names a seed by letter: "${h}"`);
  }
  // Hint 3 is the designer's note: one "turns it" sentence per solution mass (only a length overflow
  // may drop the later ones).
  const turns = (level.hints[2].match(/\bturns it\b/g) ?? []).length;
  if (turns !== level.solution.length) warnings.push(`${date}: hint 3 describes ${turns} of ${level.solution.length} masses`);
}

/**
 * loadDaily in Node: plain (generation) and with a fake fetch (bundle, caching, fallbacks). `cheap`: day
 * a (generated once) and day b (the fallback day) are the first two tier-1 days instead of the first two.
 */
async function loaderChecks(bundles: Map<string, unknown>, dir: string, errors: string[], log: (s: string) => void, cheap = false): Promise<void> {
  const dates = [...bundles.keys()].sort();
  if (dates.length < 2) return;
  const tier1 = cheap ? dates.filter((d) => dailyPlan(d)?.tier === 1) : [];
  const [a, b] = tier1.length >= 2 ? tier1 : dates;
  const sameMonth = dates.find((d) => d !== a && monthOf(d) === monthOf(a)) ?? b;
  const canon = (x: unknown): string => JSON.stringify(x);
  const expect = (ok: boolean, what: string): void => {
    log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) errors.push(`loader: ${what}`);
  };
  type FetchFn = typeof globalThis.fetch;
  const g = globalThis as { fetch?: FetchFn };
  const realFetch = g.fetch;
  try {
    // No document, relative URL: generation, identical to the bundle.
    const t0 = performance.now();
    const plain = await loadDaily(a);
    expect(canon(plain) === canon(bundles.get(a)), `no fetch path (Node): runtime generation of ${a} equals the bundle (${(performance.now() - t0).toFixed(0)} ms)`);
    // Fake fetch serving the bundle folder.
    let calls = 0;
    const serve = (mode: 'ok' | '404' | 'html' | 'month' | 'tamper' | 'stale' | 'throw'): FetchFn =>
      (async (input: unknown) => {
        calls++;
        if (mode === 'throw') throw new TypeError('network down');
        const url = String(input);
        const m = /daily\/firstlight\/(\d{4}-\d{2})\.json$/.exec(url);
        // month: a valid bundle of another month (a stale cache or a misrouted request).
        const other = m ? dates.map(monthOf).find((x) => x !== m[1]) : undefined;
        const file = m ? join(dir, `${mode === 'month' && other ? other : m[1]}.json`) : '';
        if (mode === '404' || !file || !existsSync(file)) return new Response('not found', { status: 404 });
        if (mode === 'html') return new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
        let text = readFileSync(file, 'utf8');
        if (mode === 'tamper' || mode === 'stale') {
          // tamper: a foreign id; stale: a valid entry on a nebula other than dailyInfo's.
          const data = JSON.parse(text) as Record<string, Record<string, unknown>>;
          for (const k of Object.keys(data)) {
            const other = NEBULA_CYCLE.find((n) => n !== dailyInfo(k).nebula) ?? 'bulb';
            data[k] = mode === 'tamper' ? { ...data[k], id: 'daily-1999-01-01' } : { ...data[k], nebula: other };
          }
          text = JSON.stringify(data);
        }
        return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
      }) as FetchFn;
    g.fetch = serve('ok');
    calls = 0;
    const la = await loadDaily(a, 'http://bundle.test/');
    const lb = await loadDaily(sameMonth, 'http://bundle.test/');
    expect(canon(la) === canon(bundles.get(a)) && canon(lb) === canon(bundles.get(sameMonth)), `bundle path: ${a} and ${sameMonth} come from the bundle`);
    expect(calls === 1, `one fetch per month (${calls} for two days of ${monthOf(a)})`);
    for (const mode of ['404', 'html', 'month', 'tamper', 'stale', 'throw'] as const) {
      g.fetch = serve(mode);
      calls = 0;
      const t = performance.now();
      const l = await loadDaily(b, `http://${mode}.test/`);
      expect(canon(l) === canon(bundles.get(b)) && calls === 1, `${mode} → runtime generation of ${b} (= bundle, ${(performance.now() - t).toFixed(0)} ms)`);
    }
    g.fetch = serve('404');
    calls = 0;
    await loadDaily(b, 'http://404.test/');
    expect(calls === 1, 'a failed month is retried on the next call (not cached)');
    // A runtime without fetch (old Node): generation even with an absolute URL.
    g.fetch = undefined;
    expect(canon(await loadDaily(b, 'http://nofetch.test/')) === canon(bundles.get(b)), `no fetch function → runtime generation of ${b} (= bundle)`);
    expect((await loadDaily('2026-02-30')) === null && (await loadDaily(addDays(DAILY_EPOCH, -1) ?? '')) === null && (await loadDaily('nope')) === null, 'invalid / pre-launch ids → null');
  } finally {
    g.fetch = realFetch;
  }
}

/** Default sample: the first 14 days, every 5th day, the last 7. */
function sampleOf(dates: readonly string[], every: number | null): string[] {
  if (every !== null) return dates.filter((_, i) => i % every === 0);
  return dates.filter((_, i) => i < 14 || i % 5 === 0 || i >= dates.length - 7);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = resolve(arg(args, '--dir') ?? BUNDLE_DIR);
  const regenWork = (bundles: Map<string, unknown>) => (d: string): DayResult => evaluateDay(d, { bundled: bundles.get(d), gates: true, regenerate: true });
  if (args.includes('--worker')) {
    serveWorker(regenWork(loadBundles(dir, [], [])));
    return;
  }
  const t0 = performance.now();
  const errors: string[] = [];
  const warnings: string[] = [];
  const days = Number(arg(args, '--days') ?? DAILY_WINDOW_DAYS);
  const window = windowDates(DAILY_EPOCH, days);
  const bundles = loadBundles(dir, errors, warnings);
  const fast = args.includes('--fast');

  // ---- 1. coverage ----
  const missing = window.filter((d) => !bundles.has(d));
  if (missing.length) errors.push(`${missing.length} day(s) missing: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}`);
  const inWindow = new Set(window);
  const extra = [...bundles.keys()].filter((d) => !inWindow.has(d)).sort();
  if (extra.length) warnings.push(`${extra.length} day(s) outside the ${days}-day window: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ', …' : ''}`);
  console.log(`fl-daily-check: ${bundles.size} bundled day(s) in ${dir}; window ${window[0]} … ${window[window.length - 1]} (${days} days), ${missing.length} missing`);

  // ---- 2. every entry ----
  const levels = new Map<string, LevelDef>();
  for (const d of window) {
    const raw = bundles.get(d);
    if (raw === undefined) continue;
    const errs: string[] = [];
    const level = sanitizeLevel(raw, errs);
    if (!level) {
      errors.push(`${d}: does not sanitise (${errs.slice(0, 3).join('; ')})`);
      continue;
    }
    levels.set(d, level);
    if (JSON.stringify(level) !== JSON.stringify(raw)) errors.push(`${d}: not canonical (sanitising changes it)`);
    if (level.id !== `daily-${d}` || level.chapter !== 'daily') errors.push(`${d}: id "${level.id}", chapter "${level.chapter}"`);
    const info = dailyInfo(d);
    if (level.index !== info.number || level.name !== `Daily #${info.number}`) errors.push(`${d}: index ${level.index} / name "${level.name}" (want #${info.number})`);
    if (level.nebula !== info.nebula) errors.push(`${d}: nebula ${level.nebula} but dailyInfo says ${info.nebula}`);
    entryChecks(d, level, warnings, errors);
  }
  for (let i = 1; i < window.length; i++) {
    const x = levels.get(window[i - 1]);
    const y = levels.get(window[i]);
    if (x && y && x.nebula === y.nebula) errors.push(`${window[i]}: same nebula as the day before (${y.nebula})`);
  }
  console.log(`entries: ${levels.size} sanitised and canonical-checked`);

  // ---- runway: bundled days ahead of today (after them every daily is generated at runtime) ----
  const todayArg = arg(args, '--today') ?? dailyId();
  const today = isDailyId(todayArg) ? todayArg : dailyId();
  const from = today < DAILY_EPOCH ? DAILY_EPOCH : today;
  let ahead = 0;
  let last = '';
  for (let d: string | null = from; d !== null && bundles.has(d); d = addDays(d, 1)) {
    ahead++;
    last = d;
  }
  console.log(`runway: ${ahead} bundled day(s) from ${from}${last ? ` (through ${last})` : ''}; at least ${RUNWAY_DAYS} required`);
  if (ahead < RUNWAY_DAYS) {
    errors.push(
      `only ${ahead} bundled day(s) left from ${from} (< ${RUNWAY_DAYS}): extend the window (raise DAILY_WINDOW_DAYS and rerun ` +
        `npx tsx tools/fl-daily-build.ts) before every daily falls back to main-thread generation`,
    );
  }

  if (fast) {
    console.log('\nloader (Node, tier-1 sample):');
    await loaderChecks(bundles, dir, errors, (s) => console.log(s), true);
    for (const w of warnings) console.log(`warn  ${w}`);
    for (const e of errors) console.log(`ERROR ${e}`);
    console.log(`\nfl-daily-check --fast: ${errors.length ? `${errors.length} error(s)` : 'OK'}, ${warnings.length} warning(s) — ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    process.exit(errors.length ? 1 : 0);
  }

  // ---- arenas (fl-check style), once per arena used ----
  const arenaKeys = new Map<string, LevelDef>();
  for (const l of levels.values()) arenaKeys.set(`${l.nebula}@${l.arena.centerLocal.join(',')}`, l);
  let arenaBad = 0;
  for (const [key, l] of arenaKeys) {
    const de = nebulaDE(l.nebula, l.clock ?? 0);
    const v = checkVantage(de, l.arena);
    const rel = arenaReliability(l.nebula, l.clock ?? 0, l.arena.centerLocal, l.arena.radiusLocal, de);
    if (!v.ok) errors.push(`arena ${key}: vantage ${v.reasons.join('; ')}`);
    if (rel.rate > ARENA_RULES.maxViolations) errors.push(`arena ${key}: DE reliability ${rel.violations}/${rel.samples}`);
    if (!v.ok || rel.rate > ARENA_RULES.maxViolations) arenaBad++;
  }
  console.log(`arenas: ${arenaKeys.size} of ${DAILY_ARENAS.length} used; vantage + DE reliability ${arenaBad ? `${arenaBad} FAILED` : 'ok'}`);

  // ---- 3. gates + determinism on a sample ----
  const all = args.includes('--all');
  const every = arg(args, '--sample') !== undefined ? Math.max(1, Math.floor(Number(arg(args, '--sample')))) : null;
  const sample = (all ? window : sampleOf(window, every)).filter((d) => bundles.has(d));
  const jobs = Number.isInteger(Number(arg(args, '--jobs'))) && Number(arg(args, '--jobs')) >= 1 ? Number(arg(args, '--jobs')) : 1;
  const ts = performance.now();
  console.log(`\ngates + regeneration on ${sample.length} day(s) (${all ? 'all' : every ? `every ${every}th` : 'default sample'}), ${jobs} job(s)…`);
  const results = await runDays(sample, jobs, process.argv[1], ['--worker', '--dir', dir], regenWork(bundles), (r, n) => {
    if (r.errors.length) process.stderr.write(`  [${n}/${sample.length}] ${r.date} FAIL ${r.errors.join('; ')}\n`);
    else if (n % 10 === 0 || n === sample.length) process.stderr.write(`  [${n}/${sample.length}] …\n`);
  });
  results.sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const r of results) for (const e of r.errors) errors.push(`${r.date}: ${e}`);
  const sampleSec = (performance.now() - ts) / 1000;
  console.log(`  ${results.length} day(s): ${results.filter((r) => r.gates?.pass).length} pass the gates, ${results.filter((r) => r.identical).length} regenerate identically — ${sampleSec.toFixed(1)} s`);

  // ---- 5. stats per tier ----
  console.log(`\nDifficulty per tier (${all ? 'all' : 'sampled'} days; generation time = runtime fallback cost)`);
  console.log('tier            days  budget(s)                    seeds  path R (p50 range)   bends  acc% mean/max  tol% mean/min  rob% min  almost r p50  gen ms p50/p95/max');
  const label: Record<number, string> = { 1: '1 Mon-Tue', 2: '2 Wed-Fri', 3: '3 Sat', 4: '4 Sun' };
  for (const t of [1, 2, 3, 4]) {
    const rs = results.filter((r) => r.tier === t && r.level && r.gates);
    if (!rs.length) continue;
    const budgets = new Map<string, number>();
    for (const r of rs) budgets.set(r.budget, (budgets.get(r.budget) ?? 0) + 1);
    const g = rs.map((r) => r.gates as NonNullable<DayResult['gates']>);
    const path = g.map((x) => x.pathLength);
    const seeds = rs.map((r) => (r.level as LevelDef).seeds.length);
    const ms = rs.map((r) => r.genMs);
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
    console.log(
      [
        label[t].padEnd(15),
        String(rs.length).padStart(4),
        ' ' + [...budgets].map(([k, v]) => `${k} (${v})`).join(', ').padEnd(28),
        `${Math.min(...seeds)}-${Math.max(...seeds)}`.padStart(5),
        `  ${quantile(path, 0.5).toFixed(2)} (${Math.min(...path).toFixed(2)}–${Math.max(...path).toFixed(2)})`.padEnd(21),
        `${mean(g.map((x) => x.bends)).toFixed(1)}`.padStart(6),
        `  ${pct(mean(g.map((x) => x.accidental)), 2)}/${pct(Math.max(...g.map((x) => x.accidental)), 1)}`.padEnd(15),
        `  ${pct(mean(g.map((x) => x.tolerant)), 0)}/${pct(Math.min(...g.map((x) => x.tolerant)), 0)}`.padEnd(14),
        `  ${pct(Math.min(...g.map((x) => x.robust)), 0)}`.padEnd(9),
        `  ${quantile(g.map((x) => x.unlensedClosest), 0.5).toFixed(1)}`.padEnd(13),
        `  ${quantile(ms, 0.5).toFixed(0)}/${quantile(ms, 0.95).toFixed(0)}/${Math.max(...ms).toFixed(0)}`,
      ].join(' '),
    );
  }
  const feats = results.filter((r) => r.features);
  const share = (f: (r: DayResult) => boolean): string => pct(feats.filter(f).length / Math.max(1, feats.length), 0);
  console.log(
    `features (${all ? 'all' : 'sampled'} days): S-turns ${share((r) => (r.features?.sBends ?? 0) > 0)}, reflections ${share((r) => (r.features?.reflections ?? 0) > 0)}, ` +
      `close passes ≤ 3.6 ρ ${share((r) => (r.features?.closest ?? Infinity) <= 3.6)}, fallback recipe ${share((r) => r.step > 0)}`,
  );
  const teach = new Map<string, number>();
  for (const l of levels.values()) teach.set(l.teach, (teach.get(l.teach) ?? 0) + 1);
  console.log('teach lines (all days):');
  for (const [t, n] of [...teach].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(4)}  ${t}`);

  // ---- nebula rotation ----
  const byNeb = new Map<string, number[]>();
  for (const [d, l] of levels) {
    const p = dailyPlan(d);
    const row = byNeb.get(l.nebula) ?? [0, 0, 0, 0, 0, 0, 0, 0];
    row[p ? p.weekday : 7]++;
    byNeb.set(l.nebula, row);
  }
  console.log(`\nnebula rotation (cycle ${NEBULA_CYCLE.join(' → ')}; Sundays swap in a dense nebula)`);
  console.log(`  ${'nebula'.padEnd(11)} total  ${WEEKDAY.map((w) => w.padStart(4)).join('')}`);
  for (const n of [...byNeb.keys()].sort((x, y) => NEBULA_CYCLE.indexOf(x) - NEBULA_CYCLE.indexOf(y))) {
    const row = byNeb.get(n) as number[];
    console.log(`  ${n.padEnd(11)} ${String(row.slice(0, 7).reduce((s, x) => s + x, 0)).padStart(5)}  ${row.slice(0, 7).map((x) => String(x).padStart(4)).join('')}`);
  }
  const strip = window.slice(0, 14).map((d) => {
    const l = levels.get(d);
    const p = dailyPlan(d);
    return `${WEEKDAY[p?.weekday ?? 0]} ${l?.nebula ?? '?'} ${l ? MASS_SIZES.map((s) => s[0].repeat(l.budget[s] ?? 0)).join('') : ''}`;
  });
  console.log(`  first two weeks: ${strip.join(' · ')}`);
  console.log(`  recipes: ${DAILY_RECIPES.map((r, i) => `${WEEKDAY[i]} [${r.recipe.masses.join(',')}${r.recipe.seedCount ? `, ${r.recipe.seedCount} seeds` : ''}${r.recipe.almost ? ', almost' : ''}]`).join(' ')}`);

  // ---- 4. loader ----
  console.log('\nloader (Node):');
  await loaderChecks(bundles, dir, errors, (s) => console.log(s));

  // ---- beyond the window: what the runtime falls back to once the bundles run out ----
  const after = window.length ? addDays(window[window.length - 1], 1) : null;
  if (after) {
    const r = evaluateDay(after, { gates: true, regenerate: false });
    console.log(
      `\nbeyond the window: ${after} (${WEEKDAY[dailyPlan(after)?.weekday ?? 0]}, tier ${r.tier}) generates at runtime in ${r.genMs.toFixed(0)} ms: ` +
        `${r.level ? `${r.level.nebula} ${r.budget}${r.step > 0 ? ` (fallback step ${r.step})` : ''}` : 'null'}, gates ${r.gates?.pass ? 'pass' : 'FAIL'}`,
    );
    for (const e of r.errors) errors.push(`${after} (beyond the window): ${e}`);
  }

  for (const w of warnings) console.log(`warn  ${w}`);
  for (const e of errors) console.log(`ERROR ${e}`);
  console.log(`\nfl-daily-check: ${errors.length ? `${errors.length} error(s)` : 'OK'}, ${warnings.length} warning(s) — ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(errors.length ? 1 : 0);
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) await main();
