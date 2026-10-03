/**
 * Game progress persistence (design/10-platform.md §9).
 *
 * One localStorage entry, `fractal-nebulae.progress.v1`, holding `{ [namespace]: data }` with one
 * namespace per mode ("firstlight", later "nursery", "relay"). Stored data is untrusted (older
 * versions, manual edits, another tab): every `load` passes it through the caller's sanitiser,
 * exactly like `sanitizeSettings` does for the settings.
 *
 * Never throws. When localStorage is unavailable (Node, privacy modes, blocked storage) the store
 * falls back to memory for the session; writes it refuses (quota full) are kept in memory while what
 * it holds still loads. `setSaveBackend` swaps the backend (tests, a future Electron/Steam Cloud build).
 */

export const PROGRESS_KEY = 'fractal-nebulae.progress.v1';
/** A root that failed to parse is copied here (once per corruption) before it is overwritten. */
const CORRUPT_KEY = `${PROGRESS_KEY}.corrupt`;
/** Namespaces: short lowercase identifiers (no "__proto__" tricks). */
const NS_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Refuse absurd payloads (localStorage quotas are ~5 MB per origin, shared with the settings). */
const MAX_BYTES = 1_000_000;

/** The subset of the Storage API the store needs. */
export interface SaveBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Turns stored JSON (or `undefined` when nothing is stored) into valid data, defaults included. */
export type Sanitizer<T> = (raw: unknown) => T;

class MemoryBackend implements SaveBackend {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/**
 * localStorage with a session overlay: a write the storage refuses (quota full, quota 0) is kept in
 * memory and still throws, so `save` reports false; reads prefer a value kept that way. Saved
 * progress therefore loads even when the origin's storage is full (the origin is shared with other
 * pages), and the session's own progress survives re-entering the mode.
 */
class LocalBackend implements SaveBackend {
  private readonly kept = new Map<string, string>();
  private readonly ls: SaveBackend;
  constructor(ls: SaveBackend) {
    this.ls = ls;
  }
  getItem(key: string): string | null {
    const v = this.kept.get(key);
    return v !== undefined ? v : this.ls.getItem(key);
  }
  setItem(key: string, value: string): void {
    try {
      this.ls.setItem(key, value);
    } catch (err) {
      this.kept.set(key, value);
      throw err;
    }
    this.kept.delete(key);
  }
  removeItem(key: string): void {
    this.kept.delete(key);
    this.ls.removeItem(key);
  }
}

let backend: SaveBackend | null = null;
let backendKind: 'local' | 'memory' | 'custom' = 'memory';

/**
 * localStorage if it exists and can be read (also when it refuses writes: what is saved must still
 * load, see LocalBackend), else a session-long memory store.
 */
function store(): SaveBackend {
  if (backend) return backend;
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      ls.getItem(PROGRESS_KEY);
      backend = new LocalBackend(ls);
      backendKind = 'local';
      return backend;
    }
  } catch {
    /* no storage (Node), disabled cookies / blocked storage */
  }
  backend = new MemoryBackend();
  backendKind = 'memory';
  return backend;
}

/** Replace the storage backend (null = auto-detect again). */
export function setSaveBackend(b: SaveBackend | null): void {
  backend = b;
  backendKind = b ? 'custom' : 'memory';
}

/** Where saves currently go: 'local' (localStorage; refused writes kept for the session), 'memory' (lost on reload) or 'custom'. */
export function saveBackendKind(): 'local' | 'memory' | 'custom' {
  store();
  return backendKind;
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

interface Root {
  data: Record<string, unknown>;
  /** The stored text was present but unreadable (corrupt JSON or not an object). */
  corrupt: boolean;
  raw: string | null;
  /** The backend refused the read: never write over what we could not see. */
  failed: boolean;
}

function readRoot(): Root {
  let raw: string | null = null;
  try {
    raw = store().getItem(PROGRESS_KEY);
  } catch {
    return { data: {}, corrupt: false, raw: null, failed: true };
  }
  if (raw === null || raw === '') return { data: {}, corrupt: false, raw, failed: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return { data: parsed, corrupt: false, raw, failed: false };
  } catch {
    /* corrupt JSON */
  }
  return { data: {}, corrupt: true, raw, failed: false };
}

function writeRoot(root: Root, data: Record<string, unknown>): boolean {
  if (root.failed) return false;
  let text: string;
  try {
    text = JSON.stringify(data);
  } catch {
    return false; // cycles, BigInt
  }
  if (text.length > MAX_BYTES) return false;
  try {
    const s = store();
    if (root.corrupt && root.raw !== null) {
      try {
        s.setItem(CORRUPT_KEY, root.raw.slice(0, MAX_BYTES));
      } catch {
        /* best effort */
      }
    }
    s.setItem(PROGRESS_KEY, text);
    return true;
  } catch {
    return false; // quota exceeded, storage revoked
  }
}

/**
 * A mode's saved data, sanitised. The sanitiser receives the stored value, or `undefined` when there
 * is none (or the namespace is invalid, or the store is corrupt); if it throws it is called again
 * with `undefined`.
 */
export function load<T>(ns: string, sanitize: Sanitizer<T>): T {
  let raw: unknown = undefined;
  if (NS_RE.test(ns)) {
    const root = readRoot().data;
    if (hasOwn(root, ns)) raw = root[ns];
  }
  try {
    return sanitize(raw);
  } catch {
    return sanitize(undefined);
  }
}

/** Store a mode's data (JSON-serialisable). Other namespaces are kept. False if it could not be written. */
export function save(ns: string, data: unknown): boolean {
  if (!NS_RE.test(ns) || data === undefined) return false;
  const root = readRoot();
  const next: Record<string, unknown> = { ...root.data, [ns]: data };
  return writeRoot(root, next);
}

/** Remove one namespace (e.g. "reset progress"). */
export function clear(ns: string): boolean {
  if (!NS_RE.test(ns)) return false;
  const root = readRoot();
  if (!hasOwn(root.data, ns)) return true;
  const next: Record<string, unknown> = { ...root.data };
  delete next[ns];
  return writeRoot(root, next);
}

interface ExportFile {
  app: 'fractal-nebulae';
  kind: 'progress';
  version: 1;
  exported: string;
  data: Record<string, unknown>;
}

/** Every namespace as a self-describing JSON document (a backup the player can keep). */
export function exportAll(): string {
  const file: ExportFile = {
    app: 'fractal-nebulae',
    kind: 'progress',
    version: 1,
    exported: new Date().toISOString(),
    data: readRoot().data,
  };
  return JSON.stringify(file);
}

/**
 * Replace ALL saved progress with an `exportAll()` document (a bare `{ namespace: data }` object is
 * accepted too). Invalid namespaces are dropped; each mode's data is sanitised again on its next
 * `load`. Returns false, changing nothing, for anything that is not such a document.
 */
export function importAll(json: string): boolean {
  if (typeof json !== 'string' || json.length === 0 || json.length > MAX_BYTES) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  let src: Record<string, unknown>;
  if (hasOwn(parsed, 'app') || hasOwn(parsed, 'kind') || hasOwn(parsed, 'data')) {
    if (parsed.app !== 'fractal-nebulae' || parsed.kind !== 'progress' || parsed.version !== 1) return false;
    if (!isRecord(parsed.data)) return false;
    src = parsed.data;
  } else src = parsed;
  const next: Record<string, unknown> = {};
  let n = 0;
  for (const k of Object.keys(src)) {
    if (!NS_RE.test(k) || src[k] === undefined) continue;
    next[k] = src[k];
    n++;
  }
  if (n === 0 && Object.keys(src).length > 0) return false; // nothing usable: refuse rather than wipe
  return writeRoot(readRoot(), next);
}

// ---------------------------------------------------------------------------------------------
// Sanitiser helpers (the same idiom as sanitizeSettings in src/app/config.ts)
// ---------------------------------------------------------------------------------------------

/** A finite number clamped to [min, max], else `def`. */
export function num(x: unknown, min: number, max: number, def: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? Math.min(Math.max(x, min), max) : def;
}

/** A finite number rounded to an integer and clamped to [min, max], else `def`. */
export function int(x: unknown, min: number, max: number, def: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? Math.min(Math.max(Math.round(x), min), max) : def;
}

export function bool(x: unknown, def: boolean): boolean {
  return typeof x === 'boolean' ? x : def;
}

/** A string of at most `maxLen` characters, else `def`. */
export function str(x: unknown, maxLen: number, def: string): string {
  return typeof x === 'string' && x.length <= maxLen ? x : def;
}

/** The strings of an array (each ≤ maxLen), at most `maxItems`, duplicates removed. */
export function strArray(x: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const v of x) {
    if (out.length >= maxItems) break;
    if (typeof v === 'string' && v.length <= maxLen && !out.includes(v)) out.push(v);
  }
  return out;
}
