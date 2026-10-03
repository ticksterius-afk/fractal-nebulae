// Ghost-mode test v2: pressed against structure (and arriving from cruise), aimed into it, RMB (+W).
// Checks: gets through, time inside, x-ray radius / bound, and inside speed vs local scale.
// Repo root from this file's location (tools/flight/ → ../../), so the harness runs from any checkout.
const ROOT = new URL('../../', import.meta.url).href.replace(/\/$/, '');
const THREE: any = await import('three');
const { Simulation } = await import(`${ROOT}/src/sim/Simulation.ts`);
const { NEBULAE } = await import(`${ROOT}/src/universe/catalog.ts`);
const { DEFAULT_SETTINGS } = await import(`${ROOT}/src/app/config.ts`);
let seed = 4242;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const mk = (o: any) => ({ mouseDX: 0, mouseDY: 0, forward: 0, strafe: 0, lift: 0, roll: 0, precision: false, hyper: false,
  click: false, spaceTap: false, spaceHold: false, wheel: 0, toggles: { hud: false, codex: false, mute: false, voyage: false }, anyMoveInput: false, ...o });
const sim = new Simulation({ nebulae: NEBULAE, settings: { ...DEFAULT_SETTINGS } });
sim.setAttractMode(false);
const s: any = sim; const U = sim.universe;
function place(p: any, dir: any, cruise: number) {
  sim.state.ship.position.copy(p);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir.clone().normalize());
  s.baseQ.copy(q); s.lastGoodQ?.copy(q); s.bank = 0; s.vCtrl.set(0, 0, 0); s.vGrav.set(0, 0, 0);
  s.ghostActive = false; s.ghostInside = false; s.ghostClip = 0;
  U.update(sim.state.time, p); s.measureSurface(); s.dirScale = s.speedScale; s.flightScale = s.speedScale;
  if (cruise > 0) { s.flightScale = cruise; s.dirScale = cruise; s.vCtrl.copy(dir).normalize().multiplyScalar(0.6 * cruise); }
}
const dt = 1 / 60;
const only = process.argv[2];
for (const rt of sim.nebulae) {
  if (!rt.fractal) continue;
  if (only && rt.def.id !== only) continue;
  const B = rt.boundRadiusWorld, clr = U.clearance(rt.def.id);
  const modes = ['held', 'release', 'cruise'] as const;
  const res: any = {}; for (const m of modes) res[m] = { n: 0, entered: 0, exited: 0, t: [] as number[], clipB: 0, nan: 0 };
  for (let k = 0, a = 0; k < 12 && a < 20000; a++) {
    const p = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1); if (p.lengthSq() > 1) continue;
    p.multiplyScalar(0.9 * B).add(rt.position);
    const d = U.distanceValue(p); if (!(d > 1.5 * clr && d < 6 * clr)) continue;
    const g = new THREE.Vector3(); U.gradient(p, Math.max(0.25 * d, clr), g); if (g.lengthSq() < 0.5) continue;
    k++;
    const into = g.clone().negate();
    for (const mode of modes) {
      place(p, into, mode === 'cruise' ? 0.5 * B : 0);
      const r = res[mode]; r.n++;
      let wasIn = false, tIn = 0, exitedAt = -1; const trace: string[] = [];
      const total = mode === 'release' ? 40 : 20;
      for (let f = 0; f < total / dt; f++) {
        const t = f * dt;
        const holding = mode !== 'release' || t < 1.0;
        sim.update(dt, mk({ hyper: holding, forward: holding ? 1 : 0, anyMoveInput: holding }));
        const pos = sim.state.ship.position;
        if (!Number.isFinite(pos.x)) { r.nan++; break; }
        const dd = U.distanceValue(pos);
        const inside = dd < 4 * clr;
        if (f % 30 === 0) trace.push(`t ${t.toFixed(1)} d/clr ${(dd / clr).toFixed(0)} act ${+s.ghostActive}${+s.ghostInside} gs/clr ${(s.ghostScale / clr).toFixed(0)} v/clr ${(sim.state.ship.speed / clr).toFixed(0)} spool ${s.ghostSpool.toFixed(1)} hyp ${sim.state.ship.hyper.toFixed(2)} r/B ${(pos.distanceTo(rt.position) / B).toFixed(3)} gd ${s.ghostDir.x.toFixed(2)},${s.ghostDir.y.toFixed(2)},${s.ghostDir.z.toFixed(2)}`);
        if (inside) { wasIn = true; tIn += dt; r.clipB = Math.max(r.clipB, sim.state.ship.ghostClip / B); }
        if (mode === 'release' ? (wasIn && !s.ghostActive && dd > 8 * clr) : (wasIn && dd > 8 * clr)) { exitedAt = t; break; }
      }
      if (wasIn) r.entered++;
      if (exitedAt >= 0) { r.exited++; r.t.push(mode === "release" ? exitedAt : tIn); } else if (wasIn) { console.log(`  FAIL ${rt.def.id} ${mode} k=${k - 1}`); console.log(trace.slice(0, 40).map((x) => "    " + x).join("\n")); }
    }
  }
  const med = (a: number[]) => a.length ? (a.sort((x, y) => x - y)[Math.floor(a.length / 2)]).toFixed(2) : '-';
  const mx = (a: number[]) => a.length ? Math.max(...a).toFixed(2) : '-';
  const line = modes.map((m) => { const r = res[m]; return `${m}: in ${r.entered}/${r.n} out ${r.exited}/${r.entered} t med ${med(r.t)} max ${mx(r.t)} clip/B ${r.clipB.toFixed(3)}${r.nan ? ' NaN ' + r.nan : ''}`; }).join(' | ');
  console.log(`${rt.def.id.padEnd(11)} ${line}`);
}
process.exit(0);
