/**
 * First Light level check (design/60-first-light-build.md §L, §Q). Headless, CI-able:
 *
 *   npx tsx tools/fl-check.ts [--selftest] [--quick] [--only <levelId>] [--levels <module>] [--no-reach]
 *
 * Loads every level exported by src/game/firstlight/levels/*.ts (LevelDef, LevelDef[] or ChapterDef),
 * and for each: sanitises it, checks ids are unique, checks the vantage is in free space with
 * clearance and a clear line of sight to the arena centre, checks the arena's DE reliability
 * (platform §6.2: 2000 samples seeded by the arena, fl-arenas arenaReliability), and runs every solver gate (Solver.gates: unlensed fails, solution works and is
 * legal, par, minimal, accidental, robust, tolerant, path length, bends) and the click-reachability gate
 * `reach` (Reach.ts via tools/fl-reach.ts: the game's own placement code from the vantage at 1280×720, 70° FOV; every
 * solution step needs ≥ REACH.minArea px² of one-click solving area in flight at wheel 0 — or, for a step
 * that needs the wheel, at a notch within ±2 AND with a plain click in the lab framing — and the click
 * aimed at the authored mass must solve, at 70° and at the 60° / 100° ends of the FOV setting; column
 * "reach" = the smallest flight wheel-0 area in px², "dN" = N steps that pass through the wheel clause).
 * Prints a table, the details of every failure and warnings (empty hints / teach, teach > 90 chars,
 * duplicate chapter indices).
 * Exits 1 when anything fails. An empty level folder is fine (exit 0).
 *
 * --selftest adds a level built by the Generator (bulb daily arena 0, two medium masses, with its quick reach
 * gate on, as the daily uses it), checks generation and gates are deterministic, and checks that broken
 * copies of it (seed moved onto the unlensed beam; a solution mass moved into structure; par lowered) are
 * caught.
 * --quick lowers the trial counts (accidental 150, minimal 800 evaluations per multiset) for iteration.
 * --no-reach skips the reach gate (the selftest's generated level must pass it too: the Generator authors every
 * mass where its aimed click lands; `npx tsx tools/fl-reach.ts --dailies` audits the bundled dailies).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mulberry32 } from '../src/game/platform/prng';
import { sanitizeLevel } from '../src/game/firstlight/Level';
import { generateLevel } from '../src/game/firstlight/Generator';
import { gates, type GateOptions, type GateReport } from '../src/game/firstlight/Solver';
import { traceLevel } from '../src/game/firstlight/BeamTracer';
import { makeTraceWorld } from '../src/game/firstlight/world';
import { arenaReliability, checkVantage, nebulaDE, ARENA_RULES } from './fl-arenas';
import { arenaOf, gateLines, gateRow, GATE_HEADER, loadLevels } from './fl-solve';
import { REACH, reachLevel, reachSummary, type ReachReport } from './fl-reach';
import type { LevelDef } from '../src/game/firstlight/types';

const LEVEL_DIR = resolve('src/game/firstlight/levels');

interface Row {
  id: string;
  file: string;
  level: LevelDef | null;
  errors: string[];
  warnings: string[];
  report: GateReport | null;
  reach: ReachReport | null;
  vantage: string;
  reliability: string;
  ok: boolean;
}

/** The reach gate's failures, one line per failing step. */
function reachErrors(r: ReachReport): string[] {
  const out: string[] = [];
  r.steps.forEach((s, k) => {
    if (s.pass) return;
    const a = s.aim;
    const fovs = s.aimFovs
      .filter((f) => !f.solves)
      .map((f) => `${f.fov}° (${Number.isFinite(f.miss) ? `${f.miss.toFixed(3)} R off${f.snapped ? '' : ', no beam snap'}` : (f.issue ?? 'no point')})`);
    const aim =
      (a && Number.isFinite(a.miss)
        ? `the click aimed at it ${a.solves ? 'solves' : 'fails'} (lands ${a.miss.toFixed(3)} R off${a.snapped ? '' : ', no beam snap'})`
        : `the click aimed at it places nothing (${a?.issue ?? '?'})`) + (fovs.length ? `; aimed at it with a ${fovs.join(' / ')} FOV it fails` : '');
    out.push(
      `reach: step ${k + 1} (solution[${s.index}], ${s.size}): one-click solving area ${s.flight0} px² in flight at wheel 0 ` +
        `(best ${s.flightBest} px² at notch ${s.flightBestNotch}), ${s.lab.length ? `${s.lab0} px² in the lab framing` : 'lab not scanned'} ` +
        `(need ${REACH.minArea}); ${aim}`,
    );
  });
  return out;
}

function checkLevel(raw: unknown, file: string, gateOpts: GateOptions, reach: boolean): Row {
  const errors: string[] = [];
  const warnings: string[] = [];
  const id = typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : '?';
  const sanErr: string[] = [];
  const level = sanitizeLevel(raw, sanErr);
  if (!level) {
    errors.push(...sanErr.map((e) => `sanitize: ${e}`));
    return { id, file, level: null, errors, warnings, report: null, reach: null, vantage: '—', reliability: '—', ok: false };
  }
  const de = nebulaDE(level.nebula, level.clock ?? 0);
  const v = checkVantage(de, level.arena);
  if (!v.ok) errors.push(...v.reasons.map((r) => `vantage: ${r}`));
  // Seeded by the arena (not the level id): the verdict curation reached, the same for every level in it.
  const rel = arenaReliability(level.nebula, level.clock ?? 0, level.arena.centerLocal, level.arena.radiusLocal, de);
  if (rel.rate > ARENA_RULES.maxViolations) errors.push(`arena DE reliability: ${rel.violations}/${rel.samples} contacts inside the trusted 0.8·DE ball`);
  if (rel.lipBad > ARENA_RULES.maxLipBad) warnings.push(`arena DE overestimates: ${(rel.lipBad * 100).toFixed(1)} % of samples steeper than Lipschitz 1.25`);
  if (level.hints.some((h) => h.trim().length === 0)) warnings.push('a hint is empty');
  if (level.teach.trim().length === 0) warnings.push('teach is empty');
  else if (level.teach.length > 90) warnings.push(`teach is ${level.teach.length} chars (> 90)`);
  const world = makeTraceWorld(level);
  const report = gates(level, { ...gateOpts, world });
  if (!report.pass) errors.push(`gates: ${report.failures.join(', ')}`);
  // Click reachability judges clicks by whether the level solves, so it needs a working solution.
  const rr = reach && report.solutionWorks ? reachLevel(level, { fast: true, world }) : null;
  if (rr && !rr.pass) errors.push(...reachErrors(rr));
  return {
    id: level.id,
    file,
    level,
    errors,
    warnings,
    report,
    reach: rr,
    vantage: v.ok ? `ok ${(v.clearance / level.arena.radiusLocal).toFixed(2)}R` : 'FAIL',
    reliability: `${rel.violations}/${rel.samples} ${(rel.lipBad * 100).toFixed(1)}%`,
    ok: errors.length === 0,
  };
}

/** Self-test: a generated level must pass; broken copies must fail; everything deterministic. */
function selftest(gateOpts: GateOptions): { raws: { raw: unknown; file: string }[]; failures: string[] } {
  const failures: string[] = [];
  const da = arenaOf('bulb', 0);
  if (!da) return { raws: [], failures: ['selftest: DAILY_ARENAS has no bulb arena'] };
  const req = { nebula: 'bulb', clock: da.clock, arena: da.arena, masses: ['medium', 'medium'] as const, seed: 7, id: 'selftest-gen', chapter: 'selftest', name: 'Selftest', reach: true };
  const t0 = performance.now();
  const a = generateLevel({ ...req, masses: [...req.masses] });
  const ms = performance.now() - t0;
  const b = generateLevel({ ...req, masses: [...req.masses] });
  console.log(`selftest: generated ${a.level ? 'a level' : 'NOTHING'} in ${a.attempts} attempt(s), ${a.evals} traces, ${ms.toFixed(0)} ms`);
  if (!a.level) return { raws: [], failures: ['selftest: the generator found no level'] };
  if (JSON.stringify(a.level) !== JSON.stringify(b.level)) failures.push('selftest: generation is not deterministic');
  const g1 = gates(a.level, gateOpts);
  const g2 = gates(a.level, gateOpts);
  const strip = (r: GateReport): string => JSON.stringify({ ...r, ms: 0, timing: null });
  if (strip(g1) !== strip(g2)) failures.push('selftest: gates are not deterministic');
  const raws: { raw: unknown; file: string }[] = [{ raw: a.level, file: '(selftest)' }];

  // Broken copies: each must be caught.
  const lv = a.level;
  const world = makeTraceWorld(lv);
  const unl = traceLevel(lv, world, []).beams[0];
  // Every goal seed moved onto the unlensed beam (spread along it): the level solves itself.
  const n = unl.points.length / 3;
  const at = (i: number): number[] => {
    const k = 3 * Math.min(n - 1, Math.max(0, Math.round(((i + 1) * (n - 1)) / (lv.seeds.length + 1))));
    return [unl.points[k], unl.points[k + 1], unl.points[k + 2]];
  };
  const onBeam = { ...lv, id: 'selftest-free-seed', seeds: lv.seeds.map((s, i) => ({ ...s, pos: at(i) })) };
  // The first solution mass moved to a point inside structure (a seeded search in the arena).
  const rng = mulberry32(7);
  const C = lv.arena.centerLocal;
  const R = lv.arena.radiusLocal;
  let wall: number[] = [C[0], C[1], C[2]];
  for (let i = 0; i < 20000; i++) {
    const p = [C[0] + (2 * rng() - 1) * 0.9 * R, C[1] + (2 * rng() - 1) * 0.9 * R, C[2] + (2 * rng() - 1) * 0.9 * R];
    if (Math.hypot(p[0] - C[0], p[1] - C[1], p[2] - C[2]) <= 0.9 * R && world.de(p[0], p[1], p[2]) < 0.5 * lv.masses.medium) {
      wall = p;
      break;
    }
  }
  const inWall = { ...lv, id: 'selftest-illegal', solution: lv.solution.map((m, i) => (i === 0 ? { ...m, pos: wall } : m)) };
  const lowPar = { ...lv, id: 'selftest-par', par: 1 };
  for (const [bad, gate, expect] of [
    [onBeam, 'unlensedFails', 'every goal seed on the unlensed beam'],
    [inWall, 'solutionLegal', 'a solution mass inside structure'],
    [lowPar, 'par', 'par below the solution size'],
  ] as const) {
    const s = sanitizeLevel(bad);
    const rep = s ? gates(s, { ...gateOpts, minimalEvals: 0 }) : null;
    const caught = rep !== null && rep.failures.includes(gate);
    console.log(`selftest: broken copy (${expect}) ${caught ? 'caught' : 'NOT CAUGHT'}: ${rep ? rep.failures.join(', ') || 'passed' : 'rejected by the sanitizer'}`);
    if (!caught) failures.push(`selftest: ${expect} was not caught by the ${gate} gate`);
  }
  return { raws, failures };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const reachOn = !args.includes('--no-reach');
  const oi = args.indexOf('--only');
  const only = oi >= 0 ? args[oi + 1] : null;
  const gateOpts: GateOptions = quick ? { accidentalTrials: 150, minimalEvals: 800 } : {};
  const t0 = performance.now();

  const sources: { raw: unknown; file: string }[] = [];
  // --levels <file> checks one module instead of the level folder (drafts, generated samples).
  const li = args.indexOf('--levels');
  const dir = li >= 0 ? null : LEVEL_DIR;
  const files = li >= 0 ? [resolve(args[li + 1] ?? '')] : existsSync(LEVEL_DIR) ? readdirSync(LEVEL_DIR).filter((f) => /\.(ts|js|json)$/.test(f) && !f.endsWith('.d.ts')).sort() : [];
  for (const f of files) {
    try {
      for (const raw of await loadLevels(dir ? join(dir, f) : f)) sources.push({ raw, file: dir ? f : f.replace(/^.*[\\/]/, '') });
    } catch (e) {
      sources.push({ raw: null, file: `${f} (load error: ${(e as Error).message})` });
    }
  }
  const failures: string[] = [];
  if (args.includes('--selftest')) {
    const st = selftest(gateOpts);
    failures.push(...st.failures);
    sources.push(...st.raws);
  }
  if (sources.length === 0) {
    if (only) failures.push(`--only ${only}: no such level`);
    for (const f of failures) console.log(`ERROR ${f}`);
    console.log(`fl-check: no levels in ${LEVEL_DIR} yet (nothing to check). ${failures.length ? 'FAILED' : 'OK'}`);
    process.exit(failures.length ? 1 : 0);
  }

  const rows: Row[] = [];
  const seen = new Map<string, string>();
  const chapterIdx = new Map<string, string>();
  for (const s of sources) {
    const id = typeof s.raw === 'object' && s.raw !== null ? String((s.raw as { id?: unknown }).id) : '?';
    if (only && id !== only) continue;
    const row = checkLevel(s.raw, s.file, gateOpts, reachOn);
    if (row.level) {
      const prev = seen.get(row.level.id);
      if (prev) row.errors.push(`duplicate id (also in ${prev})`);
      seen.set(row.level.id, s.file);
      const key = `${row.level.chapter}#${row.level.index}`;
      const pc = chapterIdx.get(key);
      if (pc) row.warnings.push(`chapter "${row.level.chapter}" index ${row.level.index} also used by ${pc}`);
      chapterIdx.set(key, row.level.id);
    }
    row.ok = row.errors.length === 0;
    rows.push(row);
  }
  // A mistyped --only must not read as a green run.
  if (only && rows.length === 0) failures.push(`--only ${only}: no such level`);

  console.log(`\n${GATE_HEADER}  vantage     DE c/n steep   reach      file`);
  for (const r of rows) {
    const base = r.level && r.report ? gateRow(r.level, r.report) : `${r.id.padEnd(16)} ${'—'.padEnd(11)} ${''.padEnd(17)} FAIL `.padEnd(GATE_HEADER.length);
    console.log(`${base}  ${r.vantage.padEnd(10)}  ${r.reliability.padEnd(13)}  ${(r.reach ? reachSummary(r.reach) : '—').padEnd(9)}  ${r.file}`);
  }
  for (const r of rows) {
    if (r.errors.length === 0 && r.warnings.length === 0) continue;
    console.log(`\n${r.id} (${r.file}):`);
    for (const e of r.errors) console.log(`  ERROR ${e}`);
    for (const w of r.warnings) console.log(`  warn  ${w}`);
    if (r.report && !r.report.pass) for (const l of gateLines(r.report)) console.log(`    ${l}`);
  }
  for (const f of failures) console.log(`\nERROR ${f}`);
  const bad = rows.filter((r) => !r.ok).length + failures.length;
  console.log(`\nfl-check: ${rows.length} level(s), ${rows.length - rows.filter((r) => !r.ok).length} ok, ${bad} failure(s) — ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(bad ? 1 : 0);
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) await main();
