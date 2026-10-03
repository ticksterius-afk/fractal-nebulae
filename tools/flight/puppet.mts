// Headless test of the game-mode knobs on Simulation / Universe (design/60-first-light-build.md §S):
// puppet pose + release, teleport, arena soft bounds, control policy, frozen nebula clocks.
// InputFrames are built by hand WITHOUT the game-mode fields (buttons, pointer, keyDown…): the
// Simulation must never need them. Run: npx tsx tools/flight/puppet.mts  (exit code 1 on failure)
// Repo root from this file's location (tools/flight/ → ../../), so the harness runs from any checkout.
const ROOT = new URL('../../', import.meta.url).href.replace(/\/$/, '');
const THREE: any = await import('three');
const { Simulation } = await import(`${ROOT}/src/sim/Simulation.ts`);
const { NEBULAE } = await import(`${ROOT}/src/universe/catalog.ts`);
const { DEFAULT_SETTINGS } = await import(`${ROOT}/src/app/config.ts`);

const mk = (o: any = {}) => ({ mouseDX: 0, mouseDY: 0, forward: 0, strafe: 0, lift: 0, roll: 0, precision: false, hyper: false,
  click: false, spaceTap: false, spaceHold: false, wheel: 0, toggles: { hud: false, codex: false, mute: false, voyage: false }, anyMoveInput: false, ...o });
const DT = 1 / 60;

let fails = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`);
};
const fmt = (x: number) => (Number.isFinite(x) ? x.toExponential(3) : String(x));

const sim = new Simulation({ nebulae: NEBULAE, settings: { ...DEFAULT_SETTINGS } });
sim.setAttractMode(false);
const s: any = sim;
const U = sim.universe;
const ship = sim.state.ship;

// A free-space spot: far outside every fractal (the start position is in open space).
const start = ship.position.clone();
const qLook = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.7, 0, 'YXZ'));
const fwdOf = (q: any) => new THREE.Vector3(0, 0, -1).applyQuaternion(q);

// ---- 1. puppet pose applies immediately; the first pose is a cut (no velocity) ----
sim.update(DT, mk());
sim.setPuppet(true);
const p1 = start.clone().add(new THREE.Vector3(3, -2, 5));
sim.setPuppetPose(p1, qLook, 0.25);
check('pose position applied immediately', ship.position.distanceTo(p1) < 1e-12);
check('pose orientation applied immediately', Math.abs(Math.abs(ship.orientation.dot(qLook)) - 1) < 1e-9);
check('forward follows the pose', ship.forward.distanceTo(fwdOf(qLook)) < 1e-9);
check('first pose after setPuppet(true) is a cut (velocity 0)', ship.speed === 0 && ship.velocity.lengthSq() === 0);
check('ghostClip handed to the renderer', ship.ghostClip === 0.25);

// ---- 2. while puppeted, input and physics do not move the ship; the universe keeps animating ----
const t0 = sim.state.time;
for (let i = 0; i < 30; i++) sim.update(DT, mk({ forward: 1, anyMoveInput: true, mouseDX: 50, hyper: true }));
check('puppet ignores thrust / look / hyper input', ship.position.distanceTo(p1) < 1e-12 && Math.abs(Math.abs(ship.orientation.dot(qLook)) - 1) < 1e-9,
  `moved ${fmt(ship.position.distanceTo(p1))}`);
check('no hyper while puppeted (no FOV widening)', ship.hyper === 0 && Math.abs(sim.state.camera.fovDeg - DEFAULT_SETTINGS.fovDeg) < 1e-9,
  `hyper ${ship.hyper} fov ${sim.state.camera.fovDeg}`);
check('sim clock keeps running while puppeted', Math.abs(sim.state.time - t0 - 30 * DT) < 1e-9);

// ---- 3. velocity = Δpos / dt for consecutive poses ----
const d = new THREE.Vector3(0.01, 0.002, -0.004);
sim.update(DT, mk());
sim.setPuppetPose(p1.clone().add(d), qLook);
const vExp = d.clone().multiplyScalar(1 / DT);
check('velocity = Δpos / dt', ship.velocity.distanceTo(vExp) < 1e-9 * vExp.length() + 1e-12, `v ${fmt(ship.velocity.length())} expected ${fmt(vExp.length())}`);
sim.update(DT, mk());
check('velocity lasts one frame (no pose → at rest)', ship.speed === 0);
check('non-finite pose ignored', (() => { const before = ship.position.clone(); sim.setPuppetPose(new THREE.Vector3(NaN, 0, 0), qLook); return ship.position.equals(before); })());

// ---- 4. setPuppet(false): flight resumes from the pose, at rest, attitude in sync ----
const pRel = ship.position.clone();
sim.setPuppet(false);
check('release: velocity zeroed', ship.speed === 0 && ship.velocity.lengthSq() === 0 && s.vCtrl.lengthSq() === 0 && s.vGrav.lengthSq() === 0);
check('release: internal attitude = pose', Math.abs(Math.abs(s.baseQ.dot(qLook)) - 1) < 1e-9 && s.bank === 0);
sim.update(DT, mk());
check('release: no lurch on the first idle frame', ship.position.distanceTo(pRel) < 1e-3 * Math.max(s.speedScale, 1e-9) && Math.abs(Math.abs(ship.orientation.dot(qLook)) - 1) < 1e-6,
  `moved ${fmt(ship.position.distanceTo(pRel))} (speed scale ${fmt(s.speedScale)}), dot ${ship.orientation.dot(qLook).toFixed(9)}`);
const before = ship.position.clone();
for (let i = 0; i < 60; i++) sim.update(DT, mk({ forward: 1, anyMoveInput: true }));
const moved = ship.position.clone().sub(before);
check('release: thrust flies along the pose forward', moved.length() > 0 && moved.clone().normalize().dot(fwdOf(qLook)) > 0.99,
  `|moved| ${fmt(moved.length())} cos ${moved.clone().normalize().dot(fwdOf(qLook)).toFixed(4)}`);

// ---- 5. teleport: at rest at the pose, not puppeted ----
for (let i = 0; i < 20; i++) sim.update(DT, mk({ forward: 1, anyMoveInput: true }));
const pT = start.clone().add(new THREE.Vector3(-4, 1, 2));
sim.teleport(pT, qLook);
check('teleport: pose applied, at rest, not puppeted', ship.position.distanceTo(pT) < 1e-12 && ship.speed === 0 && !sim.puppeted);
sim.update(DT, mk());
check('teleport: stays put when idle', ship.position.distanceTo(pT) < 1e-3 * Math.max(s.speedScale, 1e-9), `moved ${fmt(ship.position.distanceTo(pT))}`);

// ---- 6. control policy ----
// A wheel-set throttle that is not the default, so "null restores the wheel's throttle" is a real test.
sim.update(DT, mk({ wheel: 2 }));
const thrWheel = ship.throttle;
sim.setControlPolicy({ hyper: false, targeting: false, glide: false, voyage: false, pulse: false, wheelThrottle: false, throttle: 0.6 });
for (let i = 0; i < 120; i++) sim.update(DT, mk({ hyper: true, forward: 1, anyMoveInput: true, wheel: i === 5 ? 3 : 0 }));
check('policy.hyper=false: RMB ignored (no hyper, no ghost)', ship.hyper === 0 && ship.ghost < 1e-6 && !s.ghostActive, `hyper ${ship.hyper} ghost ${ship.ghost}`);
check('policy.wheelThrottle=false: throttle fixed', ship.throttle === 0.6, `throttle ${ship.throttle}`);
sim.update(DT, mk({ click: true }));
check('policy.targeting=false: click ignored', sim.state.target.id === null);
sim.update(DT, mk({ spaceTap: true }));
check('policy.pulse=false: Space tap ignored', !sim.state.pulse.active);
sim.update(DT, mk({ toggles: { hud: false, codex: false, mute: false, voyage: true } }));
check('policy.voyage=false: T ignored', ship.autopilot === 'off');
sim.update(DT, mk({ spaceHold: true }));
check('policy.glide=false: Space hold ignored', ship.autopilot === 'off');
sim.setControlPolicy(null);
check('policy null: wheel throttle restored', thrWheel !== 1 && ship.throttle === thrWheel, `throttle ${ship.throttle} (wheel had set ${thrWheel})`);
ship.throttle = 1; // back to the default so the sections below fly as before
for (let i = 0; i < 60; i++) sim.update(DT, mk({ hyper: true, forward: 1, anyMoveInput: true }));
check('policy null: hyper works again', ship.hyper > 0.2, `hyper ${ship.hyper.toFixed(3)}`);
sim.update(DT, mk());
// Voyage autopilot starts with T when allowed, and a policy that disables it cancels it.
sim.update(DT, mk({ toggles: { hud: false, codex: false, mute: false, voyage: true } }));
const voyOn = ship.autopilot === 'voyage';
sim.setControlPolicy({ voyage: false });
sim.update(DT, mk());
check('policy: T works by default; disabling voyage cancels a running tour', voyOn && ship.autopilot === 'off', `on ${voyOn} now ${ship.autopilot}`);
sim.setControlPolicy(null);
for (let i = 0; i < 90; i++) sim.update(DT, mk()); // let hyper decay

// ---- 7. arena soft bounds ----
const rt = sim.nebulae.find((r: any) => r.def.id === 'bulb') ?? sim.nebulae.find((r: any) => r.fractal);
const bound = rt.fractal.boundRadius;
// A sphere in free space beside the nebula (local frame), so structure does not interfere.
const cLocal: [number, number, number] = [0, 0, 4 * bound];
const RL = 0.6 * bound;
sim.setArena({ nebulaId: rt.def.id, centerLocal: cLocal, radiusLocal: RL });
const arenaC = () => new THREE.Vector3(...cLocal).multiplyScalar(rt.scale).applyQuaternion(rt.rotation).add(rt.position);
const R = RL * rt.scale;
const dirOut = new THREE.Vector3(1, 0.3, -0.2).normalize();
{
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dirOut);
  sim.teleport(arenaC().addScaledVector(dirOut, 0.8 * R), q);
  let maxR = 0;
  for (let i = 0; i < 60 * 40; i++) {
    sim.update(DT, mk({ forward: 1, anyMoveInput: true }));
    maxR = Math.max(maxR, ship.position.distanceTo(arenaC()) / R);
  }
  const rEnd = ship.position.distanceTo(arenaC()) / R;
  const vOut = ship.velocity.dot(ship.position.clone().sub(arenaC()).normalize());
  check('arena: flying outward is held inside 1.5 R', maxR <= 1.505 && maxR > 1.0, `max r/R ${maxR.toFixed(3)} end ${rEnd.toFixed(3)} outward v/R ${fmt(vOut / R)}`);
  for (let i = 0; i < 60 * 30; i++) sim.update(DT, mk());
  const rIdle = ship.position.distanceTo(arenaC()) / R;
  check('arena: an idle ship beyond R drifts back toward the centre', rIdle < rEnd - 0.05, `r/R ${rEnd.toFixed(3)} → ${rIdle.toFixed(3)} after 30 s idle`);
  sim.setArena(null);
  const q2 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dirOut);
  sim.teleport(arenaC().addScaledVector(dirOut, 1.2 * R), q2);
  for (let i = 0; i < 60 * 20; i++) sim.update(DT, mk({ forward: 1, anyMoveInput: true }));
  check('arena null: no bounds', ship.position.distanceTo(arenaC()) / R > 1.6, `r/R ${(ship.position.distanceTo(arenaC()) / R).toFixed(3)}`);
  sim.setArena({ nebulaId: 'no-such-nebula', centerLocal: [0, 0, 0], radiusLocal: 1 });
  check('arena: unknown nebula ignored', s.arena === null && s.arenaRadius === 0);
}

// ---- 8. frozen clocks: params = animate(base, clock) exactly (world.ts frozenParams) ----
{
  const animated = sim.nebulae.find((r: any) => r.fractal?.animate);
  const id = animated.def.id;
  const clock = 37.25;
  const base: number[] = animated.def.params ?? animated.fractal.defaultParams;
  const expect = new Float32Array(16);
  for (let k = 0; k < 16 && k < base.length; k++) expect[k] = base[k];
  animated.fractal.animate(base, clock, expect);
  let world: any = null;
  try {
    world = await import(`${ROOT}/src/game/firstlight/world.ts`);
  } catch {
    /* WP T not present: compare with the formula only */
  }
  const ref: Float32Array = world?.frozenParams ? world.frozenParams(id, clock) : expect;
  U.setFrozenClock(id, clock);
  const same = (a: Float32Array, b: Float32Array) => a.every((v, k) => Object.is(v, b[k]));
  check(`frozen ${id}: params applied at once (= world.ts frozenParams${world?.frozenParams ? '' : ' [absent: formula]'})`, same(animated.params, ref) && same(ref, expect));
  for (let i = 0; i < 120; i++) sim.update(DT, mk({ forward: 1, anyMoveInput: true }));
  check(`frozen ${id}: params stay pinned while the sim runs`, same(animated.params, ref));
  check('frozenClockOf reports the pin', U.frozenClockOf(id) === clock);
  U.setFrozenClock(id, null);
  sim.update(DT, mk());
  const after = Float32Array.from(animated.params);
  let maxStep = 0;
  for (let k = 0; k < 16; k++) maxStep = Math.max(maxStep, Math.abs(after[k] - ref[k]));
  for (let i = 0; i < 600; i++) sim.update(DT, mk());
  let drift = 0;
  for (let k = 0; k < 16; k++) drift = Math.max(drift, Math.abs(animated.params[k] - ref[k]));
  check(`unfrozen ${id}: resumes from the pinned clock (no jump) and animates again`, maxStep < 1e-3 && drift > maxStep, `first step ${fmt(maxStep)} after 10 s ${fmt(drift)}`);
  U.setFrozenClock(id, 5);
  U.clearFrozenClocks();
  check('clearFrozenClocks releases every pin', U.frozenClockOf(id) === null);
}

// ---- 9. NaN guards ----
{
  sim.setPuppet(true);
  sim.setPuppetPose(start, new THREE.Quaternion(0, 0, 0, 0));
  sim.update(DT, mk());
  sim.setPuppet(false);
  const ok = [ship.position.x, ship.position.y, ship.position.z, ship.orientation.x, ship.orientation.w, ship.velocity.x].every(Number.isFinite);
  check('degenerate puppet pose ignored, state stays finite', ok);
}

console.log(fails === 0 ? 'puppet: CLEAN' : `puppet: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
