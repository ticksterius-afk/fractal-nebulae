// Adversarial collision-safety test for the directional-speed nav fix.
// Hyper + throttle 4, thrust tangential / shallow / toward, optional mouse weave, dt 1/60 and 1/10.
// Instruments every sphere-traced move (trace) and push-out: samples each straight segment densely
// with a conservative march and reports any point with DE <= 0 ("entered"), traces that walked
// through a wall and came out the other side ("tunnel"), push-outs that pushed forward along the
// motion out of the far side ("pushThrough"), and the frame-end min distance / clearance.
// Repo root from this file's location (tools/flight/ → ../../), so the harness runs from any checkout.
const REPO = new URL('../../', import.meta.url).href;
const THREE: any = await import('three');
const ROOT = `${REPO}src`;
const { Simulation, FLIGHT } = await import(`${ROOT}/sim/Simulation.ts`);
const { NEBULAE } = await import(`${ROOT}/universe/catalog.ts`);
const { DEFAULT_SETTINGS } = await import(`${ROOT}/app/config.ts`);

const variant = process.argv[2] ?? 'new';
if (variant === 'old') { FLIGHT.dirScaleFreeGain = 0; FLIGHT.traceIterations = 6; }
const only = process.argv[3];
const TRIALS = Number(process.argv[4] ?? 24);

let seed = 777;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
// RMB (`hyper: true`) also engages GHOST mode since 2026-09-28: collisions off, so the instrumented trace
// never runs (segs 0). The dive therefore starts at full pre-ramped hyper (see run()) with RMB up: the
// worst case for the collision guarantees, which ghost mode deliberately suspends.
const mk = (o: any = {}) => ({ mouseDX: 0, mouseDY: 0, forward: 1, strafe: 0, lift: 0, roll: 0, precision: false, hyper: false,
  click: false, spaceTap: false, spaceHold: false, wheel: 0, toggles: { hud: false, codex: false, mute: false, voyage: false }, anyMoveInput: true, ...o });

const sim = new Simulation({ nebulae: NEBULAE, settings: { ...DEFAULT_SETTINGS } });
sim.setAttractMode(false);
const s: any = sim;
const U = sim.universe;
if (variant === 'noguard') (U as any).guardedAnimStep = (_i: number, step: number) => step;

// ---- instrumentation ----
const stats = { segs: 0, entered: 0, tunnel: 0, pushThrough: 0, endInside: 0, startInside: 0, startBelowClr: 0, pushFail: 0, pushFailInside: 0, minSegRatio: Infinity, minStartRatio: Infinity };
let curClr = 1;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3(), _d = new THREE.Vector3();
/** Min DE along segment a→b (conservative march, floor step = tiny fraction of clearance). */
function segMin(a: any, b: any): { min: number; firstInsideT: number } {
  _d.subVectors(b, a); const L = _d.length(); if (!(L > 0)) { const v = U.distanceValue(a); return { min: v, firstInsideT: v <= 0 ? 0 : -1 }; }
  _d.multiplyScalar(1 / L);
  let t = 0, min = Infinity, first = -1;
  const floor = Math.max(curClr * 0.02, L / 20000);
  for (let k = 0; k < 40000; k++) {
    const v = U.distanceValue(_p.copy(a).addScaledVector(_d, Math.min(t, L)));
    if (v < min) min = v;
    if (v <= 0 && first < 0) first = t;
    if (t >= L) break;
    t += Math.max(Math.abs(v) * 0.9, floor);
  }
  return { min, firstInsideT: first };
}
// 'leadtrace': the lead's trace (blind 0.4-clearance floor steps) for A/B comparison.
function leadTrace(disp: any): number {
  const L = disp.length();
  if (!(L > 0) || !Number.isFinite(L)) return 1;
  const dir = disp.clone().multiplyScalar(1 / L);
  const pos = sim.state.ship.position;
  let remaining = L;
  for (let i = 0; i < FLIGHT.traceIterations && remaining > 0; i++) {
    const r = U.distance(pos);
    const clr = U.clearance(r.id);
    const maxStep = FLIGHT.traceFraction * Math.max(r.dist, 0.5 * clr, 1e-9);
    const step = Math.min(remaining, maxStep);
    pos.addScaledVector(dir, step);
    remaining -= step;
  }
  return (L - remaining) / L;
}
const origTrace = variant === 'leadtrace' || variant === 'old' ? leadTrace : s.trace.bind(sim);
s.trace = (disp: any) => {
  _a.copy(sim.state.ship.position);
  const dir = disp.clone().normalize();
  const f = origTrace(disp);
  _b.copy(sim.state.ship.position);
  const r = segMin(_a, _b);
  stats.segs++;
  const d0 = U.distanceValue(_a);
  stats.minStartRatio = Math.min(stats.minStartRatio, d0 / curClr);
  if (d0 < curClr) stats.startBelowClr++;
  if (d0 <= 0) {
    stats.startInside++; s.__lastTraceDir = dir;
    if (process.env.DIAG2 && (s.__diag2 = (s.__diag2 ?? 0) + 1) <= Number(process.env.DIAG2)) console.log(`  [start-inside] d0/clr ${(d0 / curClr).toFixed(2)} prevEnd/clr ${((s.__prevEnd ?? NaN) / curClr).toFixed(2)} prevPushIn/clr ${((s.__prevPushIn ?? NaN) / curClr).toFixed(2)} moved/clr ${(_a.distanceTo(s.__prevEndPos ?? _a) / curClr).toFixed(2)} time ${sim.state.time.toFixed(3)}`);
    return f;
  }
  stats.minSegRatio = Math.min(stats.minSegRatio, r.min / curClr);
  if (r.min <= 0) {
    stats.entered++;
    const endD = U.distanceValue(_b);
    if (endD > 0) stats.tunnel++; else stats.endInside++;
    if (process.env.DIAG && (s.__diag = (s.__diag ?? 0) + 1) <= Number(process.env.DIAG)) {
      const L = _b.distanceTo(_a);
      console.log(`  [diag] ${endD > 0 ? 'TUNNEL' : 'endInside'} start/clr ${(d0 / curClr).toFixed(2)} L/clr ${(L / curClr).toFixed(2)} disp/clr ${(disp.length() / curClr).toFixed(2)} achieved ${f.toFixed(3)} firstInside at ${(r.firstInsideT / curClr).toFixed(2)} clr  end/clr ${(endD / curClr).toFixed(2)}  speed/clr ${(sim.state.ship.speed / curClr).toFixed(1)} hyper ${sim.state.ship.hyper.toFixed(2)} dirScale/clr ${(s.dirScale / curClr).toFixed(1)} iso/clr ${(s.speedScale / curClr).toFixed(1)}`);
    }
  }
  s.__lastTraceDir = dir;
  return f;
};
const mvLen = (a: any, b: any) => a.distanceTo(b);
const origPush = s.pushOut.bind(sim);
s.pushOut = () => {
  const a = sim.state.ship.position.clone();
  const d0 = U.distanceValue(a);
  origPush();
  const b = sim.state.ship.position;
  const d1 = U.distanceValue(b);
  s.__prevEnd = d1; s.__prevPushIn = d0; s.__prevEndPos = b.clone();
  if (process.env.DIAG3 && d1 < curClr && (s.__diag3 = (s.__diag3 ?? 0) + 1) <= Number(process.env.DIAG3)) console.log(`  [pushFail] before/clr ${(d0 / curClr).toFixed(2)} after/clr ${(d1 / curClr).toFixed(2)} moved/clr ${(mvLen(a, b) / curClr).toFixed(2)}`);
  if (d1 < curClr) { stats.pushFail++; if (d1 <= 0) stats.pushFailInside++; }
  if (d0 <= 0 && s.__lastTraceDir) {
    const mv = b.clone().sub(a);
    // Pushed out FORWARD (along the motion) by more than the penetration depth: out the far side.
    if (mv.dot(s.__lastTraceDir) > 0 && mv.length() > 2 * Math.abs(d0) + curClr) stats.pushThrough++;
  }
};

// ---- scenarios ----
type Res = { frames: number; minEnd: number; nan: number; path: number };
const U_: any = U;
function pinClock(k: number) {
  if (U_.animClock && U_.animClock.length) U_.animClock.fill(50 + 3.7 * k);
  U.update(sim.state.time, sim.state.ship.position); // dt = 0: params = animate(pinned clock)
}
let trialK = 0;
function run(rt: any, pL: any, dirL: any, dt: number, seconds: number, weave: number): Res | null {
  sim.resetToStart();
  pinClock(trialK);
  // The nebula may have spun / breathed since the point was chosen: map from its local frame.
  const p = pL.clone().applyQuaternion(rt.rotation).add(rt.position);
  const dir = dirL.clone().applyQuaternion(rt.rotation);
  if (!(U.distanceValue(p) > 3 * curClr)) return null;
  sim.state.ship.position.copy(p); s.lastGoodPos.copy(p);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
  s.baseQ.copy(q); s.lastGoodQ.copy(q); s.bank = 0; s.writeOrientation();
  s.vCtrl.set(0, 0, 0); s.vGrav.set(0, 0, 0);
  U.refresh(p); s.measureSurface();
  sim.state.ship.throttle = 4;
  // Pre-ramp hyper to full so the dive starts at full speed (the worst case).
  s.hyperHeld = true; s.hyperRamp = 1; sim.state.ship.hyper = 1;
  let minEnd = Infinity, nan = 0, path = 0;
  const prevP = sim.state.ship.position.clone();
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    const ph = i * dt;
    const inp = mk(weave ? { mouseDX: weave * dt * Math.sin(ph * 5.3), mouseDY: weave * 0.6 * dt * Math.cos(ph * 3.7) } : {});
    sim.update(dt, inp);
    const pos = sim.state.ship.position;
    path += pos.distanceTo(prevP); prevP.copy(pos);
    if (![pos.x, pos.y, pos.z].every(Number.isFinite)) nan++;
    const d = U.distanceValue(pos);
    if (d / curClr < minEnd) minEnd = d / curClr;
  }
  return { frames: n, minEnd, nan, path: path / curClr };
}

const summary: string[] = [];
let anyBad = false;
for (const rt of sim.nebulae) {
  if (!rt.fractal || (only && rt.def.id !== only)) continue;
  const B = rt.boundRadiusWorld;
  curClr = U.clearance(rt.def.id);
  for (const k of Object.keys(stats)) (stats as any)[k] = k.startsWith('min') ? Infinity : 0;
  let minEnd = Infinity, nan = 0, trials = 0, attempts = 0, skipped = 0; const paths: number[] = [];
  const t0 = performance.now();
  while (trials < TRIALS && attempts < 50000) {
    attempts++;
    trialK = trials + 1000 * rt.index;
    pinClock(trialK);
    const p = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (p.lengthSq() > 1) continue;
    p.multiplyScalar(B).add(rt.position);
    const d = U.distanceValue(p);
    // Two bands: close (5–200 clearances) and mid (0.2–2 % of the bound).
    const close = trials % 2 === 0;
    if (close ? !(d > 5 * curClr && d < 200 * curClr) : !(d > 0.002 * B && d < 0.02 * B)) continue;
    trials++;
    const g = new THREE.Vector3(); U.gradient(p, Math.max(0.25 * d, curClr), g);
    if (g.lengthSq() < 0.5) continue;
    // Tangent basis.
    const t1 = new THREE.Vector3().crossVectors(g, Math.abs(g.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const kind = trials % 4; // 0 tangential, 1 shallow 5°, 2 shallow 20°, 3 toward
    const ang = [0, 5, 20, 80][kind] * Math.PI / 180;
    const dir = t1.clone().multiplyScalar(Math.cos(ang)).addScaledVector(g, -Math.sin(ang)).normalize();
    for (const dt of [1 / 60, 1 / 10]) {
      for (const weave of [0, 900]) {
        const pL = p.clone().sub(rt.position).applyQuaternion(rt.rotationInv);
        const dL = dir.clone().applyQuaternion(rt.rotationInv);
        const r = run(rt, pL, dL, dt, 3, weave);
        if (!r) { skipped++; continue; }
        minEnd = Math.min(minEnd, r.minEnd); nan += r.nan; paths.push(r.path);
      }
    }
  }
  const ms = performance.now() - t0;
  paths.sort((a, b) => a - b);
  const pq = (f: number) => paths[Math.floor(f * (paths.length - 1))];
  const pathStr = `path/clr p10 ${pq(0.1).toExponential(1)} med ${pq(0.5).toExponential(1)} stuck(<30clr) ${paths.filter((x) => x < 30).length}/${paths.length}`;
  const bad = stats.entered > 0 || stats.tunnel > 0 || stats.pushThrough > 0 || minEnd < 1 || nan > 0;
  anyBad ||= bad;
  summary.push(`${bad ? '!!' : '  '} ${rt.def.id.padEnd(10)} trials ${trials} segs ${stats.segs} entered ${stats.entered} (endInside ${stats.endInside}, tunnel ${stats.tunnel}, pushThrough ${stats.pushThrough}) startInside ${stats.startInside} startBelowClr ${stats.startBelowClr} minStart/clr ${stats.minStartRatio.toFixed(2)} pushFail ${stats.pushFail}/${stats.pushFailInside}  minSeg/clr ${stats.minSegRatio.toFixed(2)}  minFrameEnd/clr ${minEnd.toFixed(2)}  nan ${nan} skipped ${skipped} ${pathStr} (${(ms / 1000).toFixed(1)} s)`);
  console.log(summary[summary.length - 1]);
}
console.log(variant, anyBad ? 'DEFECTS' : 'CLEAN');
process.exit(0);
