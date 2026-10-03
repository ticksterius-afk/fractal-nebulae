/**
 * Point-mass light bending for First Light (design/60-first-light-build.md §T, design/10-platform.md §7.2).
 *
 * Pure maths, no three.js, no DOM: the browser and the Node tools share it.
 *
 * A placed mass is a Schwarzschild point lens with Schwarzschild radius ρ. A photon at p (relative to
 * the mass) moving with UNIT direction v follows the Cartesian null geodesic of `blackholeGlsl.ts`
 * (`bhAccel`, there with rs = 1), scaled to any ρ:
 *
 *     a = −1.5 · ρ · h² · p / |p|⁵,     h = |p × v|
 *
 * For a central "force" of this form the orbit obeys the Binet equation u'' + u = 1.5 ρ u² (u = 1/r),
 * which is the EXACT Schwarzschild photon orbit equation. The shader integrates the unnormalised
 * system kick-drift-kick with h fixed per ray; the beam tracer uses the same scheme but takes each h
 * from the current velocity (masses are superposed, so no single h is conserved) and renormalises v
 * after every step. Both trace the same curve: the force scales with |v|², so the path does not
 * depend on the speed.
 *
 * Several masses are SUPERPOSED (accelerations summed). That is an approximation — general relativity
 * is not linear — but it is the standard thin-lens practice, exact in the weak field and harmless at
 * the separations the legality rules allow (masses ≥ 3ρ apart).
 *
 * Reference numbers (all in units of ρ):
 *  - photon sphere / capture radius   r = 1.5ρ   (a photon inside it moving inward never escapes)
 *  - critical impact parameter        b_c = (3√3/2) ρ ≈ 2.598ρ   (b < b_c → captured)
 *  - weak-field deflection            α ≈ 2ρ/b   (first order; at b = 10ρ the exact value is 18 %
 *                                                 larger: α = 2ρ/b + (15π/16)(ρ/b)² + …)
 *
 * Public API:
 *   PHOTON_SPHERE, CRITICAL_IMPACT              constants in units of ρ
 *   lensAccel(px…vz, packed, count, out)        superposed acceleration (allocation-free)
 *   weakDeflection(rho, b)                      2ρ/b
 *   exactDeflection(rho, b)                     exact Schwarzschild deflection by quadrature (tools)
 */
/** Capture radius in units of ρ: the photon sphere. */
export const PHOTON_SPHERE = 1.5;

/** Critical impact parameter in units of ρ: (3√3/2). Rays with b < b_c fall in. */
export const CRITICAL_IMPACT = 1.5 * Math.sqrt(3);

/** Floor on r² in lensAccel (local units²) so a degenerate p = mass never produces Infinity/NaN. */
const R2_FLOOR = 1e-30;

/**
 * Superposed lens acceleration of a photon at (px, py, pz) with velocity (vx, vy, vz) (unit or not: the
 * result scales with |v|²). `packed` holds `count` masses as [x, y, z, ρ]. Writes into out[0..2].
 * Allocation-free; called twice per kick-drift-kick step by the tracer.
 */
export function lensAccel(
  px: number,
  py: number,
  pz: number,
  vx: number,
  vy: number,
  vz: number,
  packed: ArrayLike<number>,
  count: number,
  out: Float64Array,
): void {
  let ax = 0;
  let ay = 0;
  let az = 0;
  for (let i = 0; i < count; i++) {
    const k = 4 * i;
    const dx = px - packed[k];
    const dy = py - packed[k + 1];
    const dz = pz - packed[k + 2];
    const rho = packed[k + 3];
    // h = |p × v|
    const cx = dy * vz - dz * vy;
    const cy = dz * vx - dx * vz;
    const cz = dx * vy - dy * vx;
    const h2 = cx * cx + cy * cy + cz * cz;
    let r2 = dx * dx + dy * dy + dz * dz;
    if (r2 < R2_FLOOR) r2 = R2_FLOOR;
    const r = Math.sqrt(r2);
    const s = (-1.5 * rho * h2) / (r2 * r2 * r);
    ax += s * dx;
    ay += s * dy;
    az += s * dz;
  }
  out[0] = ax;
  out[1] = ay;
  out[2] = az;
}

/** First-order (weak-field) deflection angle 2ρ/b (radians). */
export function weakDeflection(rho: number, b: number): number {
  return (2 * rho) / b;
}

/**
 * Exact Schwarzschild deflection angle (radians) of a photon with impact parameter b > b_c past a mass of
 * Schwarzschild radius ρ, from the orbit integral
 *     α = 2 ∫₀^{u₀} du / √(1/b² − u² + ρu³) − π,   u₀ = 1/r₀ (closest approach).
 * Substituting u = u₀(1 − t²) removes the endpoint singularity; the smooth remainder is integrated with
 * composite Simpson. Returns Infinity for b ≤ b_c (captured). For tools and tests, not per-frame code.
 */
export function exactDeflection(rho: number, b: number, intervals = 2000): number {
  if (!(rho > 0) || !(b > CRITICAL_IMPACT * rho)) return Infinity;
  // Closest approach: largest root of r³ − b² r + b² ρ = 0 (Newton from r = b, which lies above it).
  let r0 = b;
  for (let i = 0; i < 100; i++) {
    const f = r0 * r0 * r0 - b * b * r0 + b * b * rho;
    const df = 3 * r0 * r0 - b * b;
    const step = f / df;
    r0 -= step;
    if (Math.abs(step) < 1e-15 * r0) break;
  }
  const u0 = 1 / r0;
  const su0 = Math.sqrt(u0);
  // After the substitution the integrand is 2√u₀ / √g(u), g(u) = (u + u₀) − ρ(u² + u·u₀ + u₀²).
  const integrand = (t: number): number => {
    const u = u0 * (1 - t * t);
    const g = u + u0 - rho * (u * u + u * u0 + u0 * u0);
    return (2 * su0) / Math.sqrt(g);
  };
  const n = intervals % 2 === 0 ? intervals : intervals + 1;
  const dt = 1 / n;
  let sum = integrand(0) + integrand(1);
  for (let i = 1; i < n; i++) sum += (i % 2 === 1 ? 4 : 2) * integrand(i * dt);
  return 2 * ((sum * dt) / 3) - Math.PI;
}
