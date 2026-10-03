/**
 * First Light designer CLI: gates, solver and generator (design/60-first-light-build.md §L).
 *
 *   npx tsx tools/fl-solve.ts gates <levels> <levelId> [--seed N] [--minimal-evals N]
 *   npx tsx tools/fl-solve.ts solve <levels> <levelId> [--budget medium=2,light=1] [--evals N] [--seed N] [--exact]
 *   npx tsx tools/fl-solve.ts generate --nebula bulb --arena 0 --masses medium,medium --seed 7
 *                              [--seeds 2] [--almost 3,8] [--impact 4,10] [--attempts 80] [--no-reach]
 *                              [--id bulb-x] [--chapter bend] [--index 1] [--name "Almost"] [--json] [--out file.ts]
 *   npx tsx tools/fl-solve.ts arenas [nebula]
 *
 * <levels> is a .ts/.js module (every exported LevelDef, LevelDef[] or ChapterDef is collected) or a
 * .json file (a level or an array of levels). `--arena i` is the i-th DAILY_ARENAS entry of that
 * nebula (`arenas` lists them). `generate` prints a ready-to-paste LevelDef (TS literal; --json for
 * JSON) with its gate table; the numbers are exactly the ones the gates validated. It requires the quick
 * reach gate (every mass one-click reachable from the vantage, as the daily does) unless --no-reach.
 *
 * Exports for the other tools: loadLevels, formatLevel, gateLines, gateRow, GATE_HEADER, arenaOf.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeLevel } from '../src/game/firstlight/Level';
import { generateLevel } from '../src/game/firstlight/Generator';
import { GATES, gates, solve, type GateReport } from '../src/game/firstlight/Solver';
import { DAILY_ARENAS, type DailyArena } from '../src/game/firstlight/dailyArenas';
import { MASS_SIZES, type LevelDef, type MassSize } from '../src/game/firstlight/types';

// ---------------------------------------------------------------------------------------------
// Level loading
// ---------------------------------------------------------------------------------------------

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const looksLikeLevel = (v: unknown): boolean => isRec(v) && typeof v.id === 'string' && isRec(v.arena) && isRec(v.source);

/** Collects raw level objects from exported values (LevelDef, LevelDef[], ChapterDef, ChapterDef[]). */
function collect(v: unknown, out: unknown[], seen: Set<unknown>): void {
  if (seen.has(v)) return;
  seen.add(v);
  if (Array.isArray(v)) {
    for (const x of v) collect(x, out, seen);
  } else if (looksLikeLevel(v)) {
    out.push(v);
  } else if (isRec(v) && Array.isArray(v.levels)) {
    collect(v.levels, out, seen);
  }
}

/** Raw (unsanitised) levels of a module or JSON file, in export order. */
export async function loadLevels(spec: string): Promise<unknown[]> {
  const file = resolve(spec);
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  if (file.toLowerCase().endsWith('.json')) {
    collect(JSON.parse(readFileSync(file, 'utf8')) as unknown, out, seen);
  } else {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const k of Object.keys(mod)) collect(mod[k], out, seen);
  }
  return out;
}

/** Loads one level by id and sanitises it; exits with the reasons on failure. */
async function loadLevel(spec: string, id: string): Promise<LevelDef> {
  const raws = await loadLevels(spec);
  const raw = raws.find((r) => isRec(r) && r.id === id);
  if (!raw) fatal(`level "${id}" not found in ${spec} (has: ${raws.map((r) => (isRec(r) ? String(r.id) : '?')).join(', ') || 'none'})`);
  const errors: string[] = [];
  const level = sanitizeLevel(raw, errors);
  if (!level) fatal(`level "${id}" does not sanitise:\n  ${errors.join('\n  ')}`);
  return level;
}

/** The i-th daily arena of a nebula. */
export function arenaOf(nebula: string, index: number): DailyArena | null {
  const list = DAILY_ARENAS.filter((a) => a.nebula === nebula);
  return index >= 0 && index < list.length ? list[index] : null;
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

// JSON.stringify for anything a single-quoted literal cannot hold verbatim (quotes, line breaks, controls).
const quote = (s: string): string => (/['\x00-\x1f\u2028\u2029]/.test(s) ? JSON.stringify(s) : `'${s.replace(/\\/g, '\\\\')}'`);
const numText = (n: number): string => (Object.is(n, -0) ? '0' : String(n));

/** A value as a TS literal: vectors and small records inline, the rest indented. */
function lit(v: unknown, indent: string): string {
  if (typeof v === 'number') return numText(v);
  if (typeof v === 'string') return quote(v);
  if (typeof v === 'boolean' || v === null) return String(v);
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'number')) return `[${v.map((x) => lit(x, indent)).join(', ')}]`;
    const inner = indent + '  ';
    const items = v.map((x) => lit(x, inner));
    const flat = `[${items.join(', ')}]`;
    if (flat.length + indent.length < 100 && !flat.includes('\n')) return flat;
    return `[\n${items.map((x) => `${inner}${x},`).join('\n')}\n${indent}]`;
  }
  if (isRec(v)) {
    const inner = indent + '  ';
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    const items = keys.map((k) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k)}: ${lit(v[k], inner)}`);
    const flat = `{ ${items.join(', ')} }`;
    if (flat.length + indent.length < 100 && !flat.includes('\n')) return flat;
    return `{\n${items.map((x) => `${inner}${x},`).join('\n')}\n${indent}}`;
  }
  return 'undefined';
}

/** Key order of a printed level (the schema order of types.ts); unknown keys follow. */
const LEVEL_KEYS = ['id', 'chapter', 'index', 'name', 'nebula', 'clock', 'material', 'arena', 'source', 'seeds', 'masses', 'budget', 'solution', 'hints', 'hintMass', 'teach', 'tip', 'par'];

/** A LevelDef as a ready-to-paste TS object literal. */
export function formatLevel(level: LevelDef, indent = ''): string {
  const src = level as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const k of LEVEL_KEYS) if (src[k] !== undefined) ordered[k] = src[k];
  for (const k of Object.keys(src)) if (!(k in ordered)) ordered[k] = src[k];
  return lit(ordered, indent);
}

const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—');

/** Human-readable gate report (one line per gate). */
export function gateLines(rep: GateReport): string[] {
  /** "ok", "FAIL", or "--" for a gate earlyExit never reached. */
  const mark = (gate: string, ok: boolean): string => (rep.skipped.includes(gate) ? '--  ' : ok ? 'ok  ' : 'FAIL');
  const lines = [
    `${mark('solutionLegal', rep.solutionLegal)} solution legal${rep.solutionIssues.length ? `: ${rep.solutionIssues.join('; ')}` : ''}`,
    `${mark('par', rep.parOk)} par consistent`,
    `${mark('solutionWorks', rep.solutionWorks)} solution works`,
    `${mark('unlensedFails', rep.unlensedFails)} unlensed beam fails (closest goal approach ${rep.unlensedClosest.toFixed(2)} r)`,
    `${mark('pathLength', rep.pathLength >= GATES.pathMin && rep.pathLength <= GATES.pathMax)} path length ${rep.pathLength.toFixed(2)} R (${GATES.pathMin}–${GATES.pathMax})`,
    `${mark('bends', rep.bends >= GATES.bendsMin)} bends ${rep.bends}`,
    `${mark('robust', rep.robust >= GATES.robustMin)} robust ${pct(rep.robust)} (≥ ${GATES.robustMin * 100}%, ${GATES.robustJitter * 100}% ρ jitter)`,
    `${mark('tolerant', rep.tolerant >= GATES.tolerantMin)} tolerant ${pct(rep.tolerant)} (≥ ${GATES.tolerantMin * 100}%, ±${GATES.tolerantJitter * 100}% R view-plane jitter)`,
    `${mark('accidental', rep.accidental < GATES.accidentalMax)} accidental ${pct(rep.accidental)} of ${rep.accidentalTrials} random placements (< ${GATES.accidentalMax * 100}%)`,
    `${mark('minimal', rep.minimal)} minimal: ${rep.minimalTried.length ? rep.minimalTried.map((m) => `${m.masses} ${m.solved ? 'SOLVES' : 'no'} (${m.evals} evals)`).join(', ') : rep.skipped.includes('minimal') ? 'not run' : 'no smaller multiset to try'}`,
  ];
  for (const m of rep.minimalTried) {
    if (m.solution) lines.push(`      smaller solution: ${lit(m.solution, '      ')}`);
  }
  lines.push(
    `     ${rep.pass ? 'PASS' : `FAILED: ${rep.failures.join(', ')}${rep.skipped.length ? ` (not run: ${rep.skipped.join(', ')})` : ''}`} — ${rep.evals} traces, ${rep.ms.toFixed(0)} ms ` +
      `(robust ${rep.timing.robust.toFixed(0)}, tolerant ${rep.timing.tolerant.toFixed(0)}, accidental ${rep.timing.accidental.toFixed(0)}, minimal ${rep.timing.minimal.toFixed(0)})`,
  );
  return lines;
}

export const GATE_HEADER = 'level            nebula      budget            pass  unl  sol  legal min  acc%   rob%  tol%   path  bends  evals    ms';

/** One table row (fl-check). */
export function gateRow(level: LevelDef, rep: GateReport): string {
  const b = MASS_SIZES.filter((s) => (level.budget[s] ?? 0) > 0)
    .map((s) => `${s[0]}${level.budget[s]}`)
    .join(' ');
  const yn = (x: boolean): string => (x ? 'y' : 'N');
  return [
    level.id.padEnd(16),
    level.nebula.padEnd(11),
    b.padEnd(17),
    (rep.pass ? 'PASS' : 'FAIL').padEnd(5),
    yn(rep.unlensedFails).padEnd(4),
    yn(rep.solutionWorks).padEnd(4),
    yn(rep.solutionLegal).padEnd(5),
    yn(rep.minimal).padEnd(4),
    (Number.isFinite(rep.accidental) ? (rep.accidental * 100).toFixed(1) : '—').padStart(5),
    (Number.isFinite(rep.robust) ? (rep.robust * 100).toFixed(0) : '—').padStart(6),
    (Number.isFinite(rep.tolerant) ? (rep.tolerant * 100).toFixed(0) : '—').padStart(5),
    (Number.isFinite(rep.pathLength) ? rep.pathLength.toFixed(2) : '—').padStart(6),
    String(rep.bends).padStart(6),
    String(rep.evals).padStart(7),
    rep.ms.toFixed(0).padStart(6),
  ].join(' ');
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function fatal(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function numArg(args: string[], name: string, def: number): number {
  const v = arg(args, name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) fatal(`${name}: number expected, got "${v}"`);
  return n;
}

function pairArg(args: string[], name: string): [number, number] | undefined {
  const v = arg(args, name);
  if (v === undefined) return undefined;
  const p = v.split(',').map(Number);
  if (p.length !== 2 || !p.every(Number.isFinite)) fatal(`${name}: "lo,hi" expected`);
  return [p[0], p[1]];
}

function parseBudget(s: string): Partial<Record<MassSize, number>> {
  const out: Partial<Record<MassSize, number>> = {};
  for (const part of s.split(',')) {
    const [k, v] = part.split('=');
    if (!(MASS_SIZES as readonly string[]).includes(k) || !Number.isInteger(Number(v))) fatal(`--budget: "light=1,medium=2" expected`);
    out[k as MassSize] = Number(v);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === 'gates') {
    const level = await loadLevel(args[1], args[2]);
    const rep = gates(level, { seed: arg(args, '--seed') !== undefined ? numArg(args, '--seed', 0) : undefined, minimalEvals: numArg(args, '--minimal-evals', GATES.minimalEvals) });
    console.log(`${level.id} (${level.nebula}, budget ${JSON.stringify(level.budget)}, par ${level.par})`);
    for (const l of gateLines(rep)) console.log(`  ${l}`);
    process.exit(rep.pass ? 0 : 1);
  } else if (cmd === 'solve') {
    const level = await loadLevel(args[1], args[2]);
    const b = arg(args, '--budget');
    const budget = b ? parseBudget(b) : level.budget;
    const r = solve(level, budget, {
      seed: arg(args, '--seed') !== undefined ? numArg(args, '--seed', 0) : undefined,
      maxEvals: numArg(args, '--evals', 6000),
      subsets: !args.includes('--exact'),
    });
    console.log(`${level.id}: ${r.solved ? 'SOLVED' : 'not solved'} with ${r.masses.length} mass(es), objective ${r.objective.toFixed(3)}, ${r.evals} traces, ${r.ms.toFixed(0)} ms (tried ${r.tried.join(', ')})`);
    // Rounded to the tracer's 1e-6 mass grid: paste-ready, and the trace is the one the solver saw.
    const q6 = (x: number): number => Math.round(x * 1e6) / 1e6;
    console.log(`solution: ${lit(r.masses.map((m) => ({ size: m.size, pos: m.pos.map(q6) })), '')}`);
    process.exit(r.solved ? 0 : 1);
  } else if (cmd === 'generate') {
    const nebula = arg(args, '--nebula') ?? fatal('--nebula required');
    const ai = numArg(args, '--arena', 0);
    const da = arenaOf(nebula, ai) ?? fatal(`no daily arena ${ai} for "${nebula}" (see: npx tsx tools/fl-solve.ts arenas ${nebula})`);
    const masses = (arg(args, '--masses') ?? 'medium').split(',') as MassSize[];
    if (!masses.every((m) => (MASS_SIZES as readonly string[]).includes(m))) fatal('--masses: light | medium | heavy list expected');
    const seed = numArg(args, '--seed', 1);
    const r = generateLevel({
      nebula,
      clock: da.clock,
      arena: da.arena,
      masses,
      seed,
      seedCount: arg(args, '--seeds') !== undefined ? numArg(args, '--seeds', 1) : undefined,
      almost: pairArg(args, '--almost'),
      impact: pairArg(args, '--impact'),
      maxAttempts: numArg(args, '--attempts', 80),
      reach: !args.includes('--no-reach'),
      id: arg(args, '--id'),
      chapter: arg(args, '--chapter'),
      index: arg(args, '--index') !== undefined ? numArg(args, '--index', 1) : undefined,
      name: arg(args, '--name'),
    });
    const rejects = Object.entries(r.rejects)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ×${v}`)
      .join(', ');
    console.error(`generate ${nebula} arena ${ai} [${masses.join(', ')}] seed ${seed}: ${r.level ? 'OK' : 'FAILED'} after ${r.attempts} attempt(s), ${r.evals} traces, ${r.ms.toFixed(0)} ms`);
    if (rejects) console.error(`  rejected attempts: ${rejects}`);
    if (r.report) for (const l of gateLines(r.report)) console.error(`  ${l}`);
    // The last step stops counting at the threshold, so its area reads as a lower bound.
    if (r.reach) console.error(`  reach (quick): ${r.reach.pass ? 'ok' : `FAIL ${r.reach.failure}`}, one-click areas ${r.reach.steps.map((s) => `${s.area}`).join(' / ')} px²`);
    if (!r.level) process.exit(1);
    const text = args.includes('--json')
      ? JSON.stringify(r.level, null, 2)
      : `// Generated: npx tsx tools/fl-solve.ts generate --nebula ${nebula} --arena ${ai} --masses ${masses.join(',')} --seed ${seed}\n` +
        `// Gates: ${r.report?.pass ? 'pass' : '?'} — accidental ${pct(r.report?.accidental ?? NaN)}, robust ${pct(r.report?.robust ?? NaN)}, ` +
        `tolerant ${pct(r.report?.tolerant ?? NaN)}, path ${r.report?.pathLength.toFixed(2)} R, bends ${r.report?.bends}\n` +
        `${formatLevel(r.level)}\n`;
    const out = arg(args, '--out');
    if (out) {
      // A module exporting `level` (the type import is erased by tsx; fix its path when moving the file).
      const body = `${text.replace(/^(\/\/.*\n)+/, '').trimEnd()};\n`;
      writeFileSync(out, args.includes('--json') ? text : `import type { LevelDef } from '../src/game/firstlight/types';\n\n${text.match(/^(\/\/.*\n)+/)?.[0] ?? ''}export const level: LevelDef = ${body}`);
      console.error(`  written to ${out}`);
    }
    console.log(text);
  } else if (cmd === 'arenas') {
    const nebula = args[1];
    const counters: Record<string, number> = {};
    for (const a of DAILY_ARENAS) {
      const i = (counters[a.nebula] = (counters[a.nebula] ?? -1) + 1);
      if (nebula && a.nebula !== nebula) continue;
      console.log(`${a.nebula.padEnd(11)} --arena ${String(i).padEnd(2)} clock ${a.clock}  R ${a.arena.radiusLocal}  centre ${a.arena.centerLocal.join(', ')}`);
    }
  } else {
    console.error(
      'usage:\n' +
        '  npx tsx tools/fl-solve.ts gates <levels> <levelId> [--seed N]\n' +
        '  npx tsx tools/fl-solve.ts solve <levels> <levelId> [--budget medium=2] [--evals N] [--exact]\n' +
        '  npx tsx tools/fl-solve.ts generate --nebula bulb --arena 0 --masses medium,medium --seed 7 [--seeds 2] [--almost 3,8] [--no-reach] [--json] [--out f]\n' +
        '  npx tsx tools/fl-solve.ts arenas [nebula]',
    );
    process.exit(2);
  }
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) await main();
