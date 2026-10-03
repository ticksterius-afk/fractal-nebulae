/**
 * First Light — level validation and small level helpers (design/20-first-light.md §7.2,
 * design/60-first-light-build.md §T).
 *
 * Pure TypeScript (catalogue lookup only; no three.js, no DOM). `sanitizeLevel` is hand-written like
 * `sanitizeSettings`: it never trusts its input, returns a fresh normalised copy, and REJECTS (returns
 * null) anything out of range instead of clamping it — a silently clamped puzzle would be a different
 * puzzle. Pass an `errors` array to learn why a level was rejected (tools print it).
 *
 * Rules (R = arena radius):
 *  - ids (level, chapter, seeds) match [A-Za-z0-9][A-Za-z0-9_-]*; name non-empty; nebula must be a
 *    catalogue fractal nebula
 *  - arena: finite centre, 0 < R; vantage within 1.5 R of the centre (the soft bounds keep the ship
 *    inside 1.5 R) and distinct from lookAt; `up` non-zero (normalised)
 *  - source, seeds and solution masses within 1.25 R of the centre (the tracer's exit sphere)
 *  - source.dir and echo `emit` non-zero (normalised); `emit` is dropped from plain seeds
 *  - 1–16 seeds with unique ids, at least one goal; 0 < seed radius ≤ 0.2 R
 *  - ρ per size: 0 < ρ ≤ 6 % R; a missing size gets the build plan's default (1.2 / 2.2 / 3.5 % R)
 *  - budget: integer counts ≥ 0, at most 6 in total; the solution fits the budget
 *  - hints: three strings; teach / name / tip lengths capped (HUD safety); par integer 0–6
 *    (default: the solution's size); hintMass a valid solution index (default 0)
 *  - every number finite (clock defaults to absent = 0)
 *
 * Public API:
 *   sanitizeLevel(raw, errors?) → LevelDef | null
 *   rhoOf(level, size) → ρ (local)           budgetCount(level, size) → count
 *   totalBudget(level) → total masses        placedMass(level, size, pos) → PlacedMass
 *   LEVEL_LIMITS                             the numeric limits above
 */
import type { Vec3 } from '../../core/types';
import { NEBULA_BY_ID } from '../../universe/catalog';
import {
  MASS_SIZES,
  type ArenaDef,
  type LevelDef,
  type MassSize,
  type PlacedMass,
  type SeedDef,
  type SurfaceMaterial,
} from './types';

export const LEVEL_LIMITS = {
  /** Source, seeds and solution masses must lie within this × R of the arena centre. */
  positionRadius: 1.25,
  /** The vantage must lie within this × R of the arena centre. */
  vantageRadius: 1.5,
  /** ρ ≤ this × R. */
  maxRho: 0.06,
  /** Seed radius ≤ this × R. */
  maxSeedRadius: 0.2,
  maxSeeds: 16,
  /** Total placeable masses. */
  maxBudget: 6,
  /** Default ρ per size (× R) when a level omits one. */
  defaultRho: { light: 0.012, medium: 0.022, heavy: 0.035 } as Readonly<Record<MassSize, number>>,
  maxIdLength: 64,
  maxNameLength: 60,
  maxTeachLength: 200,
  maxHintLength: 400,
  maxTipLength: 400,
} as const;

/** Schwarzschild radius (local) of a mass size in this level. */
export function rhoOf(level: LevelDef, size: MassSize): number {
  return level.masses[size];
}

/** How many masses of `size` the player may place (0 when the budget omits the size). */
export function budgetCount(level: LevelDef, size: MassSize): number {
  return level.budget[size] ?? 0;
}

/** Total number of masses the player may place. */
export function totalBudget(level: LevelDef): number {
  let n = 0;
  for (const s of MASS_SIZES) n += budgetCount(level, s);
  return n;
}

/** A PlacedMass of `size` at `pos` with the level's ρ (pos is copied). */
export function placedMass(level: LevelDef, size: MassSize, pos: Readonly<Vec3>): PlacedMass {
  return { size, pos: [pos[0], pos[1], pos[2]], rho: rhoOf(level, size) };
}

// ---------------------------------------------------------------------------------------------
// Sanitiser
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function vec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [x, y, z] = v as unknown[];
  return isNum(x) && isNum(y) && isNum(z) ? [x, y, z] : null;
}

function unit(v: Vec3 | null): Vec3 | null {
  if (!v) return null;
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 && Number.isFinite(l) ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Ids (level, chapter, seed): save keys, URL params and object keys — no "__proto__" and friends. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
function ident(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length <= max && ID_RE.test(v) ? v : null;
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function str(v: unknown, max: number, allowEmpty = false): string | null {
  if (typeof v !== 'string') return null;
  if (!allowEmpty && v.trim().length === 0) return null;
  return v.length <= max ? v : null;
}

const isSize = (v: unknown): v is MassSize => typeof v === 'string' && (MASS_SIZES as readonly string[]).includes(v);

/**
 * Validates and normalises an untrusted level (JSON, URL, generator output). Returns a fresh LevelDef
 * or null; when `errors` is given, the reasons are appended to it.
 */
export function sanitizeLevel(raw: unknown, errors?: string[]): LevelDef | null {
  const errs: string[] = errors ?? [];
  const before = errs.length;
  const fail = (msg: string): null => {
    errs.push(msg);
    return null;
  };
  if (!isRec(raw)) return fail('level is not an object');
  const L = LEVEL_LIMITS;

  const id = ident(raw.id, L.maxIdLength);
  if (id === null) fail('id: [A-Za-z0-9_-] string required');
  const chapter = ident(raw.chapter, L.maxIdLength);
  if (chapter === null) fail('chapter: [A-Za-z0-9_-] string required');
  const name = str(raw.name, L.maxNameLength);
  if (name === null) fail(`name: non-empty string ≤ ${L.maxNameLength} chars required`);
  const index = raw.index;
  if (!isNum(index) || !Number.isInteger(index) || index < 1) fail('index: integer ≥ 1 required');
  const nebula = str(raw.nebula, L.maxIdLength);
  const neb = nebula !== null && hasOwn(NEBULA_BY_ID, nebula) ? NEBULA_BY_ID[nebula] : undefined;
  if (!neb) fail(`nebula: unknown catalogue id "${String(raw.nebula)}"`);
  else if (neb.fractal === 'blackhole') fail(`nebula: "${nebula}" is a black hole (not traceable yet)`);

  let clock: number | undefined;
  if (raw.clock !== undefined) {
    if (isNum(raw.clock)) clock = raw.clock;
    else fail('clock: finite number required');
  }
  let material: SurfaceMaterial | undefined;
  if (raw.material !== undefined) {
    if (raw.material === 'absorb' || raw.material === 'reflect') material = raw.material;
    else fail('material: "absorb" or "reflect" required');
  }

  // ---- arena ----
  const ra = raw.arena;
  let arena: ArenaDef | null = null;
  if (!isRec(ra)) fail('arena: object required');
  else {
    const center = vec3(ra.centerLocal);
    const R = ra.radiusLocal;
    const van = isRec(ra.vantage) ? ra.vantage : null;
    const vPos = van ? vec3(van.pos) : null;
    const vLook = van ? vec3(van.lookAt) : null;
    if (!center) fail('arena.centerLocal: finite [x, y, z] required');
    if (!isNum(R) || R <= 0) fail('arena.radiusLocal: finite number > 0 required');
    if (!vPos || !vLook) fail('arena.vantage: { pos, lookAt } finite vectors required');
    let up: Vec3 | undefined;
    if (ra.up !== undefined) {
      const u = unit(vec3(ra.up));
      if (u) up = u;
      else fail('arena.up: non-zero finite vector required');
    }
    if (center && isNum(R) && R > 0 && vPos && vLook) {
      if (dist(vPos, center) > L.vantageRadius * R) fail(`arena.vantage.pos: outside ${L.vantageRadius} R`);
      if (dist(vPos, vLook) < 1e-9 * R) fail('arena.vantage: pos and lookAt coincide');
      arena = { centerLocal: center, radiusLocal: R, vantage: { pos: vPos, lookAt: vLook } };
      if (up) arena.up = up;
    }
  }
  const R = arena ? arena.radiusLocal : NaN;
  const inside = (p: Vec3): boolean => arena !== null && dist(p, arena.centerLocal) <= L.positionRadius * R;

  // ---- source ----
  let source: LevelDef['source'] | null = null;
  if (!isRec(raw.source)) fail('source: object required');
  else {
    const pos = vec3(raw.source.pos);
    const dir = unit(vec3(raw.source.dir));
    if (!pos) fail('source.pos: finite [x, y, z] required');
    else if (arena && !inside(pos)) fail(`source.pos: outside ${L.positionRadius} R`);
    if (!dir) fail('source.dir: non-zero finite vector required');
    if (pos && dir) source = { pos, dir };
  }

  // ---- seeds ----
  const seeds: SeedDef[] = [];
  if (!Array.isArray(raw.seeds) || raw.seeds.length < 1 || raw.seeds.length > L.maxSeeds) {
    fail(`seeds: array of 1–${L.maxSeeds} required`);
  } else {
    const ids = new Set<string>();
    let goals = 0;
    const list = raw.seeds as unknown[];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const tag = `seeds[${i}]`;
      if (!isRec(s)) {
        fail(`${tag}: object required`);
        continue;
      }
      let ok = true;
      const bad = (msg: string): void => {
        fail(`${tag}.${msg}`);
        ok = false;
      };
      const sid = ident(s.id, L.maxIdLength);
      const pos = vec3(s.pos);
      const radius = s.radius;
      const kind = s.kind;
      if (sid === null) bad('id: [A-Za-z0-9_-] string required');
      else if (ids.has(sid)) bad(`id: duplicate "${sid}"`);
      if (!pos) bad('pos: finite [x, y, z] required');
      else if (arena && !inside(pos)) bad(`pos: outside ${L.positionRadius} R`);
      if (!isNum(radius) || radius <= 0 || (arena !== null && radius > L.maxSeedRadius * R)) {
        bad(`radius: 0 < r ≤ ${L.maxSeedRadius} R required`);
      }
      if (kind !== 'seed' && kind !== 'echo') bad('kind: "seed" or "echo" required');
      if (typeof s.goal !== 'boolean') bad('goal: boolean required');
      const emit = kind === 'echo' ? unit(vec3(s.emit)) : null;
      if (kind === 'echo' && !emit) bad('emit: non-zero finite vector required for an echo seed');
      if (!ok || sid === null || !pos || !isNum(radius) || (kind !== 'seed' && kind !== 'echo')) continue;
      ids.add(sid);
      if (s.goal === true) goals++;
      const seed: SeedDef = { id: sid, pos, radius, kind, goal: s.goal === true };
      if (emit) seed.emit = emit;
      seeds.push(seed);
    }
    if (goals === 0 && seeds.length === raw.seeds.length) fail('seeds: at least one goal seed required');
  }

  // ---- masses (ρ per size) ----
  const masses = { light: NaN, medium: NaN, heavy: NaN } as Record<MassSize, number>;
  const rm = raw.masses;
  if (rm !== undefined && !isRec(rm)) fail('masses: object required');
  for (const s of MASS_SIZES) {
    const v = isRec(rm) ? rm[s] : undefined;
    if (v === undefined) {
      masses[s] = L.defaultRho[s] * R;
    } else if (!isNum(v) || v <= 0 || (arena !== null && v > L.maxRho * R)) {
      fail(`masses.${s}: 0 < ρ ≤ ${L.maxRho} R required`);
    } else {
      masses[s] = v;
    }
  }

  // ---- budget ----
  const budget: Partial<Record<MassSize, number>> = {};
  let total = 0;
  if (!isRec(raw.budget)) fail('budget: object required');
  else {
    for (const s of MASS_SIZES) {
      const v = raw.budget[s];
      if (v === undefined) continue;
      if (!isNum(v) || !Number.isInteger(v) || v < 0) {
        fail(`budget.${s}: integer ≥ 0 required`);
        continue;
      }
      budget[s] = v;
      total += v;
    }
    if (total > L.maxBudget) fail(`budget: at most ${L.maxBudget} masses in total`);
  }

  // ---- solution ----
  const solution: LevelDef['solution'] = [];
  if (!Array.isArray(raw.solution) || raw.solution.length > L.maxBudget) {
    fail(`solution: array of ≤ ${L.maxBudget} required`);
  } else {
    const used: Record<MassSize, number> = { light: 0, medium: 0, heavy: 0 };
    const list = raw.solution as unknown[];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const tag = `solution[${i}]`;
      if (!isRec(m)) {
        fail(`${tag}: object required`);
        continue;
      }
      const pos = vec3(m.pos);
      if (!isSize(m.size)) fail(`${tag}.size: light | medium | heavy required`);
      else if (!pos) fail(`${tag}.pos: finite [x, y, z] required`);
      else if (arena && !inside(pos)) fail(`${tag}.pos: outside ${L.positionRadius} R`);
      else {
        used[m.size]++;
        solution.push({ size: m.size, pos });
      }
    }
    for (const s of MASS_SIZES) {
      if (used[s] > (budget[s] ?? 0)) fail(`solution: uses ${used[s]} ${s} but the budget allows ${budget[s] ?? 0}`);
    }
  }

  // ---- texts ----
  let hints: [string, string, string] | null = null;
  if (!Array.isArray(raw.hints) || raw.hints.length !== 3) fail('hints: array of three strings required');
  else {
    const h = (raw.hints as unknown[]).map((x) => str(x, L.maxHintLength, true));
    if (h[0] === null || h[1] === null || h[2] === null) fail(`hints: strings ≤ ${L.maxHintLength} chars required`);
    else hints = [h[0], h[1], h[2]];
  }
  const teach = str(raw.teach, L.maxTeachLength, true);
  if (teach === null) fail(`teach: string ≤ ${L.maxTeachLength} chars required`);
  let tip: LevelDef['tip'];
  if (raw.tip !== undefined) {
    const t = isRec(raw.tip) ? raw.tip : null;
    const label = t ? str(t.label, L.maxNameLength) : null;
    const text = t ? str(t.text, L.maxTipLength) : null;
    if (label === null || text === null) fail('tip: { label, text } non-empty strings required');
    else tip = { label, text };
  }

  // ---- par / hintMass ----
  let par = solution.length > 0 ? solution.length : total;
  if (raw.par !== undefined) {
    if (isNum(raw.par) && Number.isInteger(raw.par) && raw.par >= 0 && raw.par <= L.maxBudget) par = raw.par;
    else fail(`par: integer 0–${L.maxBudget} required`);
  }
  let hintMass: number | undefined;
  if (raw.hintMass !== undefined) {
    const hm = raw.hintMass;
    if (isNum(hm) && Number.isInteger(hm) && hm >= 0 && hm < solution.length) hintMass = hm;
    else fail('hintMass: index into solution required');
  }

  if (errs.length > before) return null;
  if (id === null || chapter === null || name === null || !isNum(index) || nebula === null) return null;
  if (!arena || !source || !hints || teach === null) return null;

  const level: LevelDef = {
    id,
    chapter,
    index,
    name,
    nebula,
    arena,
    source,
    seeds,
    masses,
    budget,
    solution,
    hints,
    teach,
    par,
  };
  if (clock !== undefined) level.clock = clock;
  if (material !== undefined) level.material = material;
  if (hintMass !== undefined) level.hintMass = hintMass;
  if (tip !== undefined) level.tip = tip;
  return level;
}
