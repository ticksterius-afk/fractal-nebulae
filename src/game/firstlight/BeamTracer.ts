/**
 * First Light — the beam tracer (design/20-first-light.md §7.3, design/60-first-light-build.md §T).
 *
 * Pure TypeScript (no three.js, no DOM): the mode, the solver, the generator and the Node tools all
 * call the same `traceLevel`. Everything is in the LOCAL frame of the level's nebula.
 *
 *   traceLevel(level, world, masses, opts?) → TraceResult        (types in ./types.ts)
 *   TRACE                                                         tunable constants (fractions of R / ρ)
 *
 * Algorithm (R = arena radius, eps = TRACE.eps · R):
 *  - A queue of beams starts with the source (intensity 1). Lit echo seeds emit ONE new beam each from
 *    their centre along `emit`, at intensity 1 (a lit seed is a new light). Beams are processed in
 *    order of light-travel time (the path length from the source, through the echo chain), Dijkstra
 *    style, so `SeedState.order` is the order in which light really reaches the seeds (the ignition
 *    melody); seeds lit at equal times keep their level order. ≤ 16 beams.
 *  - Step = min(max(0.8·DE, eps), 0.15·min(r_i − ρ_i), 0.02 R). The ball of radius 0.8·DE around the
 *    point where the DE was evaluated is free, so several short steps (near masses) may share one
 *    evaluation until their total reaches 0.8·DE: the same safety margin as plain sphere tracing,
 *    with far fewer DE calls.
 *  - Masses (any within TRACE.lensRange · ρ): the superposed Schwarzschild point-lens acceleration
 *    (Geodesic.ts) integrated kick-drift-kick (velocity Verlet, as the black-hole shader does; second
 *    order like RK2 with the same two evaluations per step, but it conserves the angular momentum about
 *    a single mass exactly, which keeps the capture threshold within 0.5 % of b_c), v renormalised
 *    every step; elsewhere a straight step.
 *    Capture: r < 1.5ρ moving inward (or r < ρ) ends the beam ('captured', captureMass = its index).
 *  - Surface contact when DE < eps: 'absorb' ends the beam ('absorbed', endNormal); 'reflect' mirrors v
 *    about the DE-gradient normal (central differences), intensity × 0.7, pushes off by 2 eps.
 *    A beam whose intensity falls below 0.3 ends 'faded' (it could not light a seed any more);
 *    more than 6 reflections end it 'limit'. Contact while already moving away is not a reflection.
 *  - Seeds: an exact segment–sphere test on every step (small seeds cannot be tunnelled), closest
 *    approach (distance + point) tracked for every seed and every beam, a seed lights when a beam of
 *    intensity ≥ 0.3 enters it. Lit seeds do not block the beam.
 *  - Leaving the 1.25 R sphere (moving outward) ends the beam 'exited'; the endpoint is clipped onto it.
 *  - Budgets: 6000 steps per beam, 30 000 per trace (coarse: max step and mass step × 2, 10 000 per
 *    trace), 60 R of path; exhausting one ends the beam 'limit'.
 *  - Polylines are decimated: a point is kept when the direction turned > 0.4° since the last kept
 *    point, every 0.04 R of path, and at every event (reflection, seed lit, end). `intensity[i]`
 *    applies to the segment that STARTS at point i (a reflection point carries the outgoing value);
 *    `length` is the cumulative path length of each beam from its own start.
 *  - Determinism: mass positions are quantised to 1e-6 local before tracing; the tracer keeps no state
 *    between calls, so the same input gives bit-identical output. Node and Chromium share V8's maths;
 *    other engines may differ in the last bit of Math.pow / atan2 inside the fractal DEs.
 *  - massClosest[i]: the closest approach of any beam segment to mass i, in units of its ρ.
 *  - Beam.deflection: the sum of the per-step turning angles caused by masses (not reflections).
 */
import { lensAccel, PHOTON_SPHERE } from './Geodesic';
import type { Vec3 } from '../../core/types';
import type { Beam, BeamEnd, LevelDef, PlacedMass, SeedState, TraceOptions, TraceResult, TraceWorld } from './types';

export const TRACE = {
  maxBeams: 16,
  maxReflections: 6,
  maxStepsPerBeam: 6000,
  maxSteps: 30000,
  maxStepsCoarse: 10000,
  /** Path length guard per beam (× R). */
  maxLength: 60,
  /** Surface contact distance (× R). */
  eps: 3e-4,
  /** Sphere-tracing safety factor on the DE. */
  deFactor: 0.8,
  /** Step ≤ this × (r − ρ) of the nearest mass. */
  massFactor: 0.15,
  /** Step cap (× R). */
  maxStep: 0.02,
  /** Coarse traces multiply maxStep and massFactor by this. */
  coarseScale: 2,
  /** Masses further than this × ρ from the beam leave it straight (an exact no-op inside any arena). */
  lensRange: 4000,
  /** Beams end when they leave this × R. */
  exitRadius: 1.25,
  /** Intensity factor per reflection. */
  reflectLoss: 0.7,
  /** Minimum intensity that lights a seed (and keeps a beam alive). */
  seedThreshold: 0.3,
  /** Push-off after a reflection (× eps). */
  pushOff: 2,
  /** Polyline decimation: keep a point after this turn (degrees) or this path length (× R). */
  keepTurnDeg: 0.4,
  keepLength: 0.04,
  /** Mass positions are rounded to this grid (local units). */
  quantum: 1e-6,
} as const;

const COS_KEEP = Math.cos((TRACE.keepTurnDeg * Math.PI) / 180);
/** 1 / quantum as an exact integer (1 / 1e-6 is 999999.9999999999 in doubles). */
const INV_QUANTUM = Math.round(1 / TRACE.quantum);
/** DE values above this × R are clamped (keeps the Lipschitz bound finite for "empty" worlds). */
const DE_CAP = 4;
/** Floor of (r − ρ) in the mass step limit (× ρ); only beams born inside a photon sphere reach it. */
const MIN_GAP = 0.1;

/** Scratch for lensAccel (single-threaded; a worker has its own module instance). */
const _acc = new Float64Array(3);

const quantise = (x: number): number => Math.round(x * INV_QUANTUM) / INV_QUANTUM;
/** NaN → 0 (an unknown DE reads as solid, as in makeTraceWorld). */
const num0 = (d: number): number => (d === d ? d : 0);

/** One traceLevel() call: per-trace scratch, seed and mass bookkeeping. */
class TraceRun {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly eps: number;
  readonly maxStep: number;
  readonly massK: number;
  readonly budget: number;
  readonly exitR2: number;
  readonly keepLen: number;
  readonly maxLen: number;
  readonly deCap: number;
  readonly de: (x: number, y: number, z: number) => number;
  readonly reflect: boolean;

  // Masses, packed [x, y, z, ρ] (quantised, valid ones only) + their index in the input array.
  readonly nm: number;
  readonly mp: Float64Array;
  readonly mIndex: Int32Array;
  readonly massClosest: Float64Array;

  // Seeds.
  readonly ns: number;
  readonly sx: Float64Array;
  readonly sy: Float64Array;
  readonly sz: Float64Array;
  readonly sr: Float64Array;
  readonly sClosest: Float64Array;
  readonly scx: Float64Array;
  readonly scy: Float64Array;
  readonly scz: Float64Array;
  /** Light-travel time (path length from the source) at which each seed lit; Infinity = unlit. */
  readonly sLitAt: Float64Array;
  readonly sIntensity: Float64Array;
  readonly sEmitted: Uint8Array;

  steps = 0;
  readonly beams: Beam[] = [];

  // Last computed surface normal.
  nx = 0;
  ny = 0;
  nz = 1;

  constructor(level: LevelDef, world: TraceWorld, masses: readonly PlacedMass[], coarse: boolean) {
    const a = level.arena;
    this.cx = a.centerLocal[0];
    this.cy = a.centerLocal[1];
    this.cz = a.centerLocal[2];
    const R = a.radiusLocal > 0 && Number.isFinite(a.radiusLocal) ? a.radiusLocal : 1;
    this.eps = TRACE.eps * R;
    const k = coarse ? TRACE.coarseScale : 1;
    this.maxStep = TRACE.maxStep * R * k;
    this.massK = TRACE.massFactor * k;
    this.budget = coarse ? TRACE.maxStepsCoarse : TRACE.maxSteps;
    const xr = TRACE.exitRadius * R;
    this.exitR2 = xr * xr;
    this.keepLen = TRACE.keepLength * R;
    this.maxLen = TRACE.maxLength * R;
    this.deCap = DE_CAP * R;
    // Bound: `de` is called detached below, and a class-based TraceWorld may use `this` in it.
    this.de = world.de.bind(world);
    this.reflect = world.material === 'reflect';

    const n = masses.length;
    this.mp = new Float64Array(4 * n);
    this.mIndex = new Int32Array(n);
    this.massClosest = new Float64Array(n).fill(Infinity);
    let nm = 0;
    for (let i = 0; i < n; i++) {
      const m = masses[i];
      const x = quantise(m.pos[0]);
      const y = quantise(m.pos[1]);
      const z = quantise(m.pos[2]);
      const rho = m.rho;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      if (!(rho > 0) || !Number.isFinite(rho)) continue;
      this.mp[4 * nm] = x;
      this.mp[4 * nm + 1] = y;
      this.mp[4 * nm + 2] = z;
      this.mp[4 * nm + 3] = rho;
      this.mIndex[nm] = i;
      nm++;
    }
    this.nm = nm;

    const ns = level.seeds.length;
    this.ns = ns;
    this.sx = new Float64Array(ns);
    this.sy = new Float64Array(ns);
    this.sz = new Float64Array(ns);
    this.sr = new Float64Array(ns);
    for (let i = 0; i < ns; i++) {
      const s = level.seeds[i];
      this.sx[i] = s.pos[0];
      this.sy[i] = s.pos[1];
      this.sz[i] = s.pos[2];
      this.sr[i] = s.radius > 0 ? s.radius : 0;
    }
    this.sClosest = new Float64Array(ns).fill(Infinity);
    this.scx = new Float64Array(ns).fill(NaN);
    this.scy = new Float64Array(ns).fill(NaN);
    this.scz = new Float64Array(ns).fill(NaN);
    this.sLitAt = new Float64Array(ns).fill(Infinity);
    this.sIntensity = new Float64Array(ns);
    this.sEmitted = new Uint8Array(ns);
  }

  /**
   * Surface normal (DE gradient, central differences) at p into nx/ny/nz; falls back to −v.
   * Not the 4-tap tetrahedral stencil: its error is FIRST order in h (h·∂²DE/∂x∂y terms), which tilts
   * reflections off small pearls by up to ~1° and breaks mirror-symmetric levels. Central differences
   * are second order and exactly symmetric; the 2 extra DE calls happen only at contacts.
   */
  private normal(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const h = this.eps;
    const de = this.de;
    const nx = num0(de(x + h, y, z)) - num0(de(x - h, y, z));
    const ny = num0(de(x, y + h, z)) - num0(de(x, y - h, z));
    const nz = num0(de(x, y, z + h)) - num0(de(x, y, z - h));
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 1e-300 && l < Infinity) {
      this.nx = nx / l;
      this.ny = ny / l;
      this.nz = nz / l;
    } else {
      this.nx = -vx;
      this.ny = -vy;
      this.nz = -vz;
    }
  }

  /**
   * Seed and mass bookkeeping for the step a → b (chord of an arc of length `arc`, starting at
   * light-travel time `tBase`). Returns true when a seed lit (or lit earlier than before).
   */
  private testSegment(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    arc: number,
    tBase: number,
    intensity: number,
  ): boolean {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const uu = ux * ux + uy * uy + uz * uz;
    const inv = uu > 0 ? 1 / uu : 0;
    const canLight = intensity >= TRACE.seedThreshold;
    let lit = false;
    for (let i = 0; i < this.ns; i++) {
      const wx = this.sx[i] - ax;
      const wy = this.sy[i] - ay;
      const wz = this.sz[i] - az;
      const tl = (wx * ux + wy * uy + wz * uz) * inv; // closest point on the infinite line
      const t = tl < 0 ? 0 : tl > 1 ? 1 : tl;
      const qx = ax + t * ux;
      const qy = ay + t * uy;
      const qz = az + t * uz;
      const dx = this.sx[i] - qx;
      const dy = this.sy[i] - qy;
      const dz = this.sz[i] - qz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const d = Math.sqrt(d2);
      if (d < this.sClosest[i]) {
        this.sClosest[i] = d;
        this.scx[i] = qx;
        this.scy[i] = qy;
        this.scz[i] = qz;
      }
      const r = this.sr[i];
      if (canLight && d2 <= r * r) {
        // Entry parameter of the chord into the seed sphere (0 when a starts inside it).
        const line2 = wx * wx + wy * wy + wz * wz - tl * tl * uu;
        const half = Math.sqrt(Math.max(r * r - line2, 0) * inv);
        let te = tl - half;
        te = te < 0 ? 0 : te > 1 ? 1 : te;
        const time = tBase + te * arc;
        if (time < this.sLitAt[i]) {
          this.sLitAt[i] = time;
          this.sIntensity[i] = intensity;
          lit = true;
        }
      }
    }
    const mp = this.mp;
    for (let j = 0; j < this.nm; j++) {
      const k = 4 * j;
      const wx = mp[k] - ax;
      const wy = mp[k + 1] - ay;
      const wz = mp[k + 2] - az;
      let t = (wx * ux + wy * uy + wz * uz) * inv;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = wx - t * ux;
      const dy = wy - t * uy;
      const dz = wz - t * uz;
      const q = Math.sqrt(dx * dx + dy * dy + dz * dz) / mp[k + 3];
      const mi = this.mIndex[j];
      if (q < this.massClosest[mi]) this.massClosest[mi] = q;
    }
    return lit;
  }

  /**
   * Capture test at p moving along v: inside a photon sphere moving inward, or inside a horizon.
   * Returns the INPUT index of the capturing mass, or −1.
   */
  private captureAt(px: number, py: number, pz: number, vx: number, vy: number, vz: number): number {
    const mp = this.mp;
    for (let j = 0; j < this.nm; j++) {
      const k = 4 * j;
      const ex = px - mp[k];
      const ey = py - mp[k + 1];
      const ez = pz - mp[k + 2];
      const r2 = ex * ex + ey * ey + ez * ez;
      const rho = mp[k + 3];
      const rc = PHOTON_SPHERE * rho;
      if (r2 < rho * rho || (r2 < rc * rc && ex * vx + ey * vy + ez * vz < 0)) return this.mIndex[j];
    }
    return -1;
  }

  /** Traces one beam from o along d (normalised here), starting at light-travel time t0. */
  traceBeam(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, from: string | null, t0: number): Beam {
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let vx = dl > 0 ? dx / dl : 0;
    let vy = dl > 0 ? dy / dl : 0;
    let vz = dl > 0 ? dz / dl : 1;
    let px = ox;
    let py = oy;
    let pz = oz;
    let intensity = 1;
    let len = 0;
    const points: number[] = [px, py, pz];
    const inten: number[] = [intensity];
    const lens: number[] = [0];
    const refl: number[] = [];
    // Direction and length at the last kept polyline point.
    let kvx = vx;
    let kvy = vy;
    let kvz = vz;
    let keptLen = 0;
    let deflection = 0;
    let reflections = 0;
    let end: BeamEnd = 'limit';
    let endNormal: Vec3 | null = null;
    let captureMass = -1;
    let steps = 0;
    /**
     * Path still covered by the last DE evaluation: 0.8·DE minus the distance travelled since (≤ 0:
     * evaluate). Sphere tracing within that one 0.8·DE ball is as safe as re-evaluating every step.
     */
    let safe = 0;

    const eps = this.eps;
    const maxStep = this.maxStep;
    const massK = this.massK;
    const deFactor = TRACE.deFactor;
    const lensRange = TRACE.lensRange;
    const mp = this.mp;
    const nm = this.nm;
    const de = this.de;
    const acc = _acc;

    const pushPoint = (x: number, y: number, z: number): void => {
      const n = points.length;
      if (points[n - 3] === x && points[n - 2] === y && points[n - 1] === z) {
        inten[inten.length - 1] = intensity;
        return;
      }
      points.push(x, y, z);
      inten.push(intensity);
      lens.push(len);
    };

    this.testSegment(px, py, pz, px, py, pz, 0, t0, intensity);
    // Born inside a photon sphere moving inward (the legality rules prevent it, tools may not).
    captureMass = this.captureAt(px, py, pz, vx, vy, vz);
    if (captureMass >= 0) end = 'captured';

    while (captureMass < 0) {
      if (steps >= TRACE.maxStepsPerBeam || this.steps >= this.budget || len >= this.maxLen) {
        end = 'limit';
        break;
      }

      // Nearest-mass step limit and whether lensing is on.
      let massStep = Infinity;
      let lensOn = false;
      for (let j = 0; j < nm; j++) {
        const k = 4 * j;
        const ex = px - mp[k];
        const ey = py - mp[k + 1];
        const ez = pz - mp[k + 2];
        const r = Math.sqrt(ex * ex + ey * ey + ez * ez);
        const rho = mp[k + 3];
        // Floored so a beam starting between horizon and photon sphere (moving out) still advances.
        const s = massK * (r - rho > MIN_GAP * rho ? r - rho : MIN_GAP * rho);
        if (s < massStep) massStep = s;
        if (r < lensRange * rho) lensOn = true;
      }
      const cap = maxStep < massStep ? maxStep : massStep;

      // Distance to structure: re-evaluate only when the remaining safe budget cannot cover the step.
      let d: number;
      if (safe > eps && safe >= cap) {
        d = safe / deFactor; // only feeds the step below, which comes out as `cap`
      } else {
        d = de(px, py, pz);
        if (d !== d) d = 0;
        if (d > this.deCap) d = this.deCap;
        safe = deFactor * d;
      }

      if (d < eps) {
        this.normal(px, py, pz, vx, vy, vz);
        const nx = this.nx;
        const ny = this.ny;
        const nz = this.nz;
        if (!this.reflect) {
          endNormal = [nx, ny, nz];
          end = 'absorbed';
          break;
        }
        const vn = vx * nx + vy * ny + vz * nz;
        if (vn < 0) {
          vx -= 2 * vn * nx;
          vy -= 2 * vn * ny;
          vz -= 2 * vn * nz;
          const il = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
          vx *= il;
          vy *= il;
          vz *= il;
          intensity *= TRACE.reflectLoss;
          reflections++;
          refl.push(px, py, pz);
          pushPoint(px, py, pz);
          kvx = vx;
          kvy = vy;
          kvz = vz;
          keptLen = len;
          steps++;
          this.steps++;
          if (reflections > TRACE.maxReflections) {
            endNormal = [nx, ny, nz];
            end = 'limit';
            break;
          }
          if (intensity < TRACE.seedThreshold) {
            endNormal = [nx, ny, nz];
            end = 'faded';
            break;
          }
          const push = TRACE.pushOff * eps;
          px += push * nx;
          py += push * ny;
          pz += push * nz;
          len += push;
          safe = 0;
          continue;
        }
        // Already moving away from the surface: the minimum step below carries it out.
      }

      // The eps floor (no crawling along surfaces) never overrides the mass limit: for a small ρ
      // eps can exceed 0.15·(r − ρ), and flooring there would skip the bend.
      let h = deFactor * d;
      if (h < eps) h = eps;
      if (h > cap) h = cap;

      const ax = px;
      const ay = py;
      const az = pz;
      /** Length of this step's chord (the drift of a lensed step is |u|·h, not h). */
      let seg = h;
      if (lensOn) {
        // Kick-drift-kick (velocity Verlet: the shader's integrator) on the unit direction with dt = h.
        // The step is scale-invariant in |v| for this force law, so renormalising v afterwards leaves the
        // path exactly that of the unnormalised system — whose angular momentum about a single mass the
        // central kicks and the drift both conserve. With the mass step limit a single kick changes |u|
        // by < 3 % (6 % coarse), so the drift |u|·h stays inside the 0.8·DE sphere.
        const hh = 0.5 * h;
        lensAccel(px, py, pz, vx, vy, vz, mp, nm, acc);
        const ux = vx + acc[0] * hh;
        const uy = vy + acc[1] * hh;
        const uz = vz + acc[2] * hh;
        px += ux * h;
        py += uy * h;
        pz += uz * h;
        lensAccel(px, py, pz, ux, uy, uz, mp, nm, acc);
        let nvx = ux + acc[0] * hh;
        let nvy = uy + acc[1] * hh;
        let nvz = uz + acc[2] * hh;
        const nl2 = nvx * nvx + nvy * nvy + nvz * nvz;
        seg = Math.sqrt(ux * ux + uy * uy + uz * uz) * h;
        if (!(nl2 > 0) || nl2 === Infinity || !(seg < Infinity)) {
          // Unreachable with the capture rule in place; a broken state must not poison the result.
          px = ax;
          py = ay;
          pz = az;
          end = 'limit';
          break;
        }
        const nl = 1 / Math.sqrt(nl2);
        nvx *= nl;
        nvy *= nl;
        nvz *= nl;
        const tx = vy * nvz - vz * nvy;
        const ty = vz * nvx - vx * nvz;
        const tz = vx * nvy - vy * nvx;
        deflection += Math.atan2(Math.sqrt(tx * tx + ty * ty + tz * tz), vx * nvx + vy * nvy + vz * nvz);
        vx = nvx;
        vy = nvy;
        vz = nvz;
      } else {
        px += vx * h;
        py += vy * h;
        pz += vz * h;
      }
      steps++;
      this.steps++;
      const lenBefore = len;
      len += seg;
      safe -= seg;

      // Leaving the arena: clip the step onto the exit sphere (outgoing root).
      let exited = false;
      {
        const ex = px - this.cx;
        const ey = py - this.cy;
        const ez = pz - this.cz;
        if (ex * ex + ey * ey + ez * ez > this.exitR2 && ex * vx + ey * vy + ez * vz > 0) {
          const ux = px - ax;
          const uy = py - ay;
          const uz = pz - az;
          const wx = ax - this.cx;
          const wy = ay - this.cy;
          const wz = az - this.cz;
          const qa = ux * ux + uy * uy + uz * uz;
          const qb = wx * ux + wy * uy + wz * uz;
          const qc = wx * wx + wy * wy + wz * wz - this.exitR2;
          let t = qa > 0 ? (-qb + Math.sqrt(Math.max(qb * qb - qa * qc, 0))) / qa : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          px = ax + t * ux;
          py = ay + t * uy;
          pz = az + t * uz;
          len = lenBefore + t * seg;
          exited = true;
        }
      }

      const seedLit = this.testSegment(ax, ay, az, px, py, pz, len - lenBefore, t0 + lenBefore, intensity);

      captureMass = this.captureAt(px, py, pz, vx, vy, vz);
      if (captureMass >= 0) {
        end = 'captured';
        break;
      }
      if (exited) {
        end = 'exited';
        break;
      }
      if (seedLit || kvx * vx + kvy * vy + kvz * vz < COS_KEEP || len - keptLen >= this.keepLen) {
        pushPoint(px, py, pz);
        kvx = vx;
        kvy = vy;
        kvz = vz;
        keptLen = len;
      }
    }

    pushPoint(px, py, pz);
    if (points.length < 6) {
      // A beam that never moved (e.g. born inside structure) still has two points.
      points.push(px, py, pz);
      inten.push(intensity);
      lens.push(len);
    }
    const beam: Beam = {
      points,
      intensity: inten,
      length: lens,
      end,
      endPos: [px, py, pz],
      endNormal,
      captureMass,
      reflections: refl,
      from,
      deflection,
    };
    this.beams.push(beam);
    return beam;
  }
}

/**
 * Traces the level's light: the source beam plus every echo beam, against the frozen fractal `world`
 * and the placed `masses` (their order defines `massClosest` and `captureMass` indices).
 */
export function traceLevel(level: LevelDef, world: TraceWorld, masses: readonly PlacedMass[], opts?: TraceOptions): TraceResult {
  const run = new TraceRun(level, world, masses, opts?.coarse === true);
  const src = level.source;
  run.traceBeam(src.pos[0], src.pos[1], src.pos[2], src.dir[0], src.dir[1], src.dir[2], null, 0);

  // Echo seeds emit once, in order of the time light reached them (Dijkstra: a beam can only light
  // seeds at times after its own start, so a seed's time is final when it is dequeued).
  const seeds = level.seeds;
  while (run.beams.length < TRACE.maxBeams && run.steps < run.budget) {
    let next = -1;
    let best = Infinity;
    for (let i = 0; i < run.ns; i++) {
      const s = seeds[i];
      if (s.kind !== 'echo' || !s.emit || run.sEmitted[i] !== 0) continue;
      if (run.sLitAt[i] < best) {
        best = run.sLitAt[i];
        next = i;
      }
    }
    if (next < 0) break;
    run.sEmitted[next] = 1;
    const s = seeds[next];
    const e = s.emit as Vec3;
    run.traceBeam(s.pos[0], s.pos[1], s.pos[2], e[0], e[1], e[2], s.id, best);
  }

  // Ignition order: by light-travel time, ties by level order.
  const litIdx: number[] = [];
  for (let i = 0; i < run.ns; i++) if (run.sLitAt[i] < Infinity) litIdx.push(i);
  litIdx.sort((a, b) => run.sLitAt[a] - run.sLitAt[b] || a - b);
  const order = new Int32Array(run.ns).fill(-1);
  for (let k = 0; k < litIdx.length; k++) order[litIdx[k]] = k;

  const out: Record<string, SeedState> = {};
  let goals = 0;
  let goalsLit = 0;
  for (let i = 0; i < run.ns; i++) {
    const s = seeds[i];
    const lit = run.sLitAt[i] < Infinity;
    const c = run.sClosest[i];
    out[s.id] = {
      lit,
      closest: c,
      closestPoint: c < Infinity ? [run.scx[i], run.scy[i], run.scz[i]] : null,
      intensity: lit ? run.sIntensity[i] : 0,
      order: order[i],
    };
    if (s.goal) {
      goals++;
      if (lit) goalsLit++;
    }
  }

  return {
    beams: run.beams,
    seeds: out,
    massClosest: Array.from(run.massClosest),
    solved: goals > 0 && goalsLit === goals,
    steps: run.steps,
  };
}
