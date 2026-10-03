// Speed-smoothness test: straight flights through / inside each fractal nebula at throttle 1.
// Repo root from this file's location (tools/flight/ → ../../), so the harness runs from any checkout.
const ROOT = new URL('../../', import.meta.url).href.replace(/\/$/, '');
const THREE: any = await import('three');
const { Simulation, FLIGHT } = await import(`${ROOT}/src/sim/Simulation.ts`);
const { NEBULAE } = await import(`${ROOT}/src/universe/catalog.ts`);
const { DEFAULT_SETTINGS } = await import(`${ROOT}/src/app/config.ts`);
const variant = process.argv[2] ?? 'new';
if (variant.startsWith('rise')) FLIGHT.cruiseRiseTau = Number(variant.slice(4)) / 100;
if (variant === 'instant') { FLIGHT.cruiseRiseTau = 1e-9; FLIGHT.cruiseFallTau = 1e-9; FLIGHT.cruiseFallMinTau = 0; }
let seed = 777;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const inp = () => ({ mouseDX: 0, mouseDY: 0, forward: 1, strafe: 0, lift: 0, roll: 0, precision: false, hyper: false,
  click: false, spaceTap: false, spaceHold: false, wheel: 0, toggles: { hud: false, codex: false, mute: false, voyage: false }, anyMoveInput: true });
const sim = new Simulation({ nebulae: NEBULAE, settings: { ...DEFAULT_SETTINGS } });
sim.setAttractMode(false);
const s: any = sim; const U = sim.universe;
function place(p: any, dir: any) {
  sim.state.ship.position.copy(p);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir.clone().normalize());
  s.baseQ.copy(q); s.lastGoodQ?.copy(q); s.bank = 0; s.vCtrl.set(0, 0, 0); s.vGrav.set(0, 0, 0);
  U.update(sim.state.time, p); s.measureSurface(); s.dirScale = s.speedScale;
}
function fly(secs: number, clr: number) {
  const dt = 1 / 60, n = Math.round(secs / dt); const sp: number[] = []; let minD = Infinity, path = 0; const prev = sim.state.ship.position.clone();
  for (let i = 0; i < n; i++) { sim.update(dt, inp()); const pos = sim.state.ship.position; path += pos.distanceTo(prev); prev.copy(pos); sp.push(sim.state.ship.speed); const d = U.distance(pos).dist; if (d < minD) minD = d; }
  // lurches: 15-frame windows (0.25 s) after 1.5 s where max/min speed > 1.5
  let lurch = 0; const rates: number[] = [];
  for (let i = 90; i + 15 < sp.length; i += 15) { let mn = Infinity, mx = 0; for (let j = i; j < i + 15; j++) { mn = Math.min(mn, sp[j]); mx = Math.max(mx, sp[j]); } if (mn > 0 && mx / mn > 1.5) lurch++; }
  for (let i = 91; i < sp.length; i++) if (sp[i] > 0 && sp[i - 1] > 0) rates.push(Math.abs(Math.log(sp[i] / sp[i - 1])) / dt);
  rates.sort((a, b) => a - b);
  return { lurch, windows: Math.max(1, Math.floor((sp.length - 105) / 15)), p95: rates[Math.floor(rates.length * 0.95)] ?? 0, minClr: minD / clr, path };
}
const out: Record<string, string> = {};
for (const rt of sim.nebulae) {
  if (!rt.fractal) continue;
  const B = rt.boundRadiusWorld, clr = U.clearance(rt.def.id);
  let lur = 0, win = 0, p95s: number[] = [], minC = Infinity, prog: number[] = [];
  for (let k = 0; k < 8; k++) { // through-flights from outside
    const dir = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    const start = rt.position.clone().addScaledVector(dir, 2.2 * B);
    const aim = rt.position.clone().add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(1.2 * B));
    place(start, aim.sub(start)); const r = fly(25, clr); lur += r.lurch; win += r.windows; p95s.push(r.p95); minC = Math.min(minC, r.minClr); prog.push(r.path / B);
  }
  let lurIn = 0, winIn = 0, p95In: number[] = [], progIn: number[] = [];
  for (let k = 0, a = 0; k < 8 && a < 5000; a++) { // inside the structure
    const p = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1); if (p.lengthSq() > 1) continue;
    p.multiplyScalar(B).add(rt.position); const d = U.distance(p).dist; if (!(d > 0.01 * B && d < 0.1 * B)) continue; k++;
    place(p, new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1)); const r = fly(10, clr);
    lurIn += r.lurch; winIn += r.windows; p95In.push(r.p95); minC = Math.min(minC, r.minClr); progIn.push(r.path / d);
  }
  const med = (a: number[]) => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  out[rt.def.id] = `through: lurch ${(100 * lur / win).toFixed(1)}% p95|dlnv/dt| ${med(p95s).toFixed(2)} path ${med(prog).toFixed(2)}B | inside: lurch ${(100 * lurIn / winIn).toFixed(1)}% p95 ${med(p95In).toFixed(2)} path ${med(progIn).toFixed(1)}d | minClr ${minC.toFixed(2)}`;
}
console.log(variant); for (const k in out) console.log(k.padEnd(11), out[k]);
process.exit(0);
