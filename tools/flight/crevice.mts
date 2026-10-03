// Headless flight test: spawn near structure, thrust in a random direction, measure progress & safety.
// Repo root from this file's location (tools/flight/ → ../../), so the harness runs from any checkout.
const REPO = new URL('../../', import.meta.url).href;
const THREE: any = await import('three');
const ROOT = `${REPO}src`;
const { Simulation, FLIGHT } = await import(`${ROOT}/sim/Simulation.ts`);
const { NEBULAE } = await import(`${ROOT}/universe/catalog.ts`);
const { DEFAULT_SETTINGS } = await import(`${ROOT}/app/config.ts`);

const variant = process.argv[2] ?? 'new';
if (variant === 'old') { FLIGHT.dirScaleFreeGain = 0; FLIGHT.traceIterations = 6; }

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const input = () => ({ mouseDX: 0, mouseDY: 0, forward: 1, strafe: 0, lift: 0, roll: 0, precision: false, hyper: false,
  click: false, spaceTap: false, spaceHold: false, wheel: 0, toggles: { hud: false, codex: false, mute: false, voyage: false }, anyMoveInput: true });

const sim = new Simulation({ nebulae: NEBULAE, settings: { ...DEFAULT_SETTINGS } });
sim.setAttractMode(false);
const s: any = sim;
const U = sim.universe;
const out: Record<string, any> = {};
for (const rt of sim.nebulae) {
  if (!rt.fractal) continue;
  const bound = rt.boundRadiusWorld;
  const cat: Record<string, number[]> = { toward: [], tangent: [], away: [] }; let trials = 0, stalls = 0, minClrRatio = Infinity, sumProgress = 0, med: number[] = [];
  let attempts = 0;
  while (trials < 60 && attempts < 20000) {
    attempts++;
    // random point in the bound sphere, keep those 0.002–0.02 bound from a surface
    const p = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (p.lengthSq() > 1) continue;
    p.multiplyScalar(bound).add(rt.position);
    const d = U.distance(p).dist;
    if (!(d > 0.002 * bound && d < 0.02 * bound)) continue;
    trials++;
    sim.state.ship.position.copy(p);
    const dir = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
    s.baseQ.copy(q); s.lastGoodQ?.copy(q); s.bank = 0;
    s.vCtrl.set(0, 0, 0); s.vGrav.set(0, 0, 0); s.dirScale = d;
    const start = p.clone(); const gn = new THREE.Vector3(); U.gradient(p, 0.25 * d, gn); const dn = dir.dot(gn); const c = dn < -0.4 ? 'toward' : dn > 0.4 ? 'away' : 'tangent';
    let path = 0, prev = p.clone(), minD = Infinity;
    for (let f = 0; f < 300; f++) { // 5 s at 60 Hz
      sim.update(1 / 60, input());
      const pos = sim.state.ship.position;
      path += pos.distanceTo(prev); prev.copy(pos);
      const dd = U.distance(pos).dist; if (dd < minD) minD = dd;
    }
    const progress = path / d; // in units of the starting wall distance
    med.push(progress); cat[c].push(progress);
    sumProgress += progress;
    if (progress < 3) stalls++;
    const clr = U.clearance(rt.def.id);
    minClrRatio = Math.min(minClrRatio, minD / clr);
  }
  med.sort((a, b) => a - b);
  const st = (a: number[]) => { if (!a.length) return '-'; a.sort((x, y) => x - y); return `n${a.length} med ${a[Math.floor(a.length / 2)].toFixed(1)} stall<3:${a.filter((x) => x < 3).length}`; };
  out[rt.def.id] = { toward: st(cat.toward), tangent: st(cat.tangent), away: st(cat.away), trials, stalls, medianProgress: +med[Math.floor(med.length / 2)].toFixed(1), p10: +med[Math.floor(med.length * 0.1)].toFixed(1), minDist_over_clearance: +minClrRatio.toFixed(2) };
}
console.log(variant, JSON.stringify(out, null, 1));
process.exit(0);
