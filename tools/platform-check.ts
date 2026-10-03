// Headless checks for the game-platform helpers (design/60-first-light-build.md §G):
// prng, OverviewCamera orbit maths, UTC daily ids, the share string, save round-trips.
// Run: npx tsx tools/platform-check.ts   (exit code 1 on any failure)
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { fnv1a, hash2, hash3, mulberry32, pick, randInt, shuffle, toUnit, uniform } from '../src/game/platform/prng';
import { OVERVIEW, OverviewCamera, pixelSize } from '../src/game/platform/OverviewCamera';
import {
  addDays, dailyId, dailyNumber, dailySeed, daysBetween, isDailyId, msUntilNextDaily, nextInText, parseDailyParam,
} from '../src/game/platform/daily';
import { buildShare, copyText, dailyShareUrl, formatTime } from '../src/game/platform/share';
import {
  PROGRESS_KEY, bool, clear, exportAll, importAll, int, isRecord, load, num, save, saveBackendKind, setSaveBackend,
  strArray, type SaveBackend,
} from '../src/game/platform/save';
import { projectToScreen } from '../src/core/math';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (process.env.VERBOSE && ok) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  if (ok) passes++;
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(name: string): void {
  console.log(`\n[${name}]`);
}
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
section('prng');
{
  check('fnv1a("") = 0x811c9dc5', fnv1a('') === 0x811c9dc5);
  check('fnv1a("a") = 0xe40c292c', fnv1a('a') === 0xe40c292c);
  check('fnv1a("foobar") = 0xbf9cf968', fnv1a('foobar') === 0xbf9cf968);
  // Reference: FNV-1a over TextEncoder's UTF-8 bytes.
  const enc = new TextEncoder();
  const ref = (s: string) => {
    let h = 0x811c9dc5;
    for (const b of enc.encode(s)) h = Math.imul(h ^ b, 0x01000193);
    return h >>> 0;
  };
  const rs = mulberry32(7);
  const samples = ['Menger ◆◇⚬', 'grüße', '😀 emoji', 'lone \ud800 high', 'lone \udc00 low', 'end \ud83d', '2026-10-02:firstlight'];
  for (let i = 0; i < 300; i++) {
    let s = '';
    const n = randInt(rs, 0, 12);
    for (let j = 0; j < n; j++) s += String.fromCharCode(randInt(rs, 0, 1) ? randInt(rs, 0, 0x7f) : randInt(rs, 0x80, 0xffff));
    samples.push(s);
  }
  let utfBad = 0;
  for (const s of samples) if (fnv1a(s) !== ref(s)) utfBad++;
  check('fnv1a = FNV-1a over UTF-8 bytes (307 strings incl. surrogates)', utfBad === 0, `${utfBad} mismatches`);

  // mulberry32 against the canonical reference implementation (bryc).
  const mref = (seed: number) => {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  let mBad = 0;
  for (const seed of [0, 1, 42, 0xdeadbeef, 2 ** 31, 123456789]) {
    const a = mulberry32(seed);
    const b = mref(seed);
    for (let i = 0; i < 2000; i++) if (a() !== b()) mBad++;
  }
  check('mulberry32 = reference implementation', mBad === 0, `${mBad} mismatches`);
  const r = mulberry32(12345);
  let sum = 0;
  let sum2 = 0;
  let lo = 1;
  let hi = 0;
  const N = 200_000;
  for (let i = 0; i < N; i++) {
    const x = r();
    sum += x;
    sum2 += x * x;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  const mean = sum / N;
  const variance = sum2 / N - mean * mean;
  check('mulberry32 in [0, 1)', lo >= 0 && hi < 1);
  check('mulberry32 mean ≈ 0.5', near(mean, 0.5, 0.004), mean.toFixed(5));
  check('mulberry32 variance ≈ 1/12', near(variance, 1 / 12, 0.002), variance.toFixed(5));
  check('mulberry32 NaN seed = seed 0', mulberry32(NaN)() === mulberry32(0)());
  check('different seeds differ', mulberry32(1)() !== mulberry32(2)());

  const base = Array.from({ length: 20 }, (_, i) => i);
  const s1 = shuffle(mulberry32(99), base.slice());
  const s2 = shuffle(mulberry32(99), base.slice());
  const s3 = shuffle(mulberry32(100), base.slice());
  check('shuffle deterministic', s1.join() === s2.join());
  check('shuffle is a permutation', s1.slice().sort((a, b) => a - b).join() === base.join());
  check('shuffle seed-dependent', s1.join() !== s3.join());
  const counts = new Map<string, number>();
  const rr = mulberry32(5);
  for (let i = 0; i < 60_000; i++) {
    const k = shuffle(rr, ['a', 'b', 'c']).join('');
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const cv = [...counts.values()];
  check('shuffle uniform over 3! perms', counts.size === 6 && cv.every((c) => near(c, 10_000, 450)), cv.join(' '));
  let threw = false;
  try {
    pick(rr, []);
  } catch {
    threw = true;
  }
  check('pick([]) throws', threw);
  const seen = new Set<number>();
  for (let i = 0; i < 500; i++) seen.add(pick(rr, [1, 2, 3, 4, 5]));
  check('pick covers all elements', seen.size === 5);
  let intOk = true;
  const ints = new Set<number>();
  for (let i = 0; i < 5000; i++) {
    const v = randInt(rr, -2, 3);
    ints.add(v);
    if (v < -2 || v > 3 || !Number.isInteger(v)) intOk = false;
    const u = uniform(rr, 5, 7);
    if (u < 5 || u >= 7) intOk = false;
  }
  check('randInt inclusive / uniform half-open', intOk && ints.size === 6);

  const hs = new Set<number>();
  for (let a = 0; a < 128; a++) for (let b = 0; b < 128; b++) hs.add(hash2(a, b));
  check('hash2 no collisions on a 128² grid', hs.size === 128 * 128, `${128 * 128 - hs.size} collisions`);
  check('hash2 order-sensitive', hash2(3, 7) !== hash2(7, 3));
  check('hash2/3 deterministic + seeded', hash3(1, 2, 3) === hash3(1, 2, 3) && hash3(1, 2, 3) !== hash3(1, 2, 3, 9));
  let flips = 0;
  let trials = 0;
  for (let i = 0; i < 2000; i++) {
    const a = randInt(rr, -1e9, 1e9);
    const b = randInt(rr, -1e9, 1e9);
    const c = randInt(rr, -1e9, 1e9);
    const bit = 1 << randInt(rr, 0, 31);
    let x = (hash3(a, b, c) ^ hash3(a, b ^ bit, c)) >>> 0;
    while (x) {
      flips += x & 1;
      x >>>= 1;
    }
    trials++;
  }
  const avg = flips / trials;
  check('hash3 avalanche ≈ 16 bits per input bit', near(avg, 16, 0.6), avg.toFixed(2));
  check('toUnit in [0,1)', toUnit(0xffffffff) < 1 && toUnit(0) === 0);
}

// ---------------------------------------------------------------------------------------------
section('OverviewCamera');
{
  const W = 1280;
  const H = 720;
  const FOV = 70;
  const R = 2;
  const focus = new THREE.Vector3(100, -50, 20);
  const up = new THREE.Vector3(0, 1, 0);
  const cam = new OverviewCamera();
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const o = new THREE.Vector3();
  const d = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();

  cam.frame(focus, R, up);
  cam.pose(pos, q);
  check('frame: distance = 2.2 R (snapped)', near(pos.distanceTo(focus), OVERVIEW.frameFactor * R, 1e-9), String(pos.distanceTo(focus)));
  check('frame: slightly above (22°)', near(cam.pitch, OVERVIEW.framePitchDeg * DEG, 1e-12) && tmp.subVectors(pos, focus).dot(up) > 0);
  check('frame: looks at the focus', tmp.copy(pos).addScaledVector(cam.forward, cam.distance).distanceTo(focus) < 1e-9);
  check('quaternion −Z = forward', tmp.set(0, 0, -1).applyQuaternion(q).distanceTo(cam.forward) < 1e-9);

  // Centre pixel = forward, origin = camera position.
  cam.rayThrough(W / 2, H / 2, W, H, FOV, o, d);
  check('ray through the centre = forward', d.dot(cam.forward) > 1 - 1e-12 && o.distanceTo(pos) < 1e-12);

  // Up lock: random drags, dollies, pans and up vectors; no roll ever, pitch within ±80°.
  const rng = mulberry32(2026);
  let rollMax = 0;
  let upMin = 1;
  let pitchMax = 0;
  let distOk = true;
  let lookErr = 0;
  for (let k = 0; k < 40; k++) {
    const u = new THREE.Vector3(uniform(rng, -1, 1), uniform(rng, -1, 1), uniform(rng, -1, 1)).normalize();
    const c = new THREE.Vector3(uniform(rng, -1e3, 1e3), uniform(rng, -1e3, 1e3), uniform(rng, -1e3, 1e3));
    const rad = uniform(rng, 0.01, 50);
    cam.frame(c, rad, u);
    for (let i = 0; i < 60; i++) {
      const a = rng();
      if (a < 0.5) cam.orbit(uniform(rng, -800, 800), uniform(rng, -2000, 2000));
      else if (a < 0.8) cam.dolly(uniform(rng, -12, 12));
      else cam.pan(uniform(rng, -300, 300), uniform(rng, -300, 300), H, FOV);
      cam.update(uniform(rng, 0.001, 0.05));
      cam.pose(pos, q);
      rollMax = Math.max(rollMax, Math.abs(tmp.set(1, 0, 0).applyQuaternion(q).dot(u)));
      upMin = Math.min(upMin, tmp.set(0, 1, 0).applyQuaternion(q).dot(u));
      pitchMax = Math.max(pitchMax, Math.abs(cam.pitch));
      const dd = cam.distance;
      if (dd < 0.3 * rad * (1 - 1e-9) || dd > 3 * rad * (1 + 1e-9)) distOk = false;
      lookErr = Math.max(lookErr, tmp.copy(pos).addScaledVector(cam.forward, dd).distanceTo(cam.focus) / rad);
    }
  }
  check('up lock: camera right ⟂ up (no roll)', rollMax < 1e-9, rollMax.toExponential(2));
  check('up lock: camera up · locked up ≥ cos 80°', upMin >= Math.cos(80 * DEG) - 1e-9, upMin.toFixed(4));
  check('pitch never beyond ±80° (also mid-glide)', pitchMax <= 80 * DEG + 1e-12, (pitchMax / DEG).toFixed(3));
  check('distance always inside [0.3, 3] R (also mid-glide)', distOk);
  check('always looks at the focus', lookErr < 1e-9, lookErr.toExponential(2));

  // Clamps reached exactly.
  cam.frame(focus, R, up);
  cam.orbit(0, 1e6);
  for (let i = 0; i < 200; i++) cam.update(1 / 60);
  check('pitch clamps at +80°', near(cam.pitch, 80 * DEG, 1e-9), (cam.pitch / DEG).toFixed(4));
  cam.orbit(0, -1e7);
  for (let i = 0; i < 200; i++) cam.update(1 / 60);
  check('pitch clamps at −80°', near(cam.pitch, -80 * DEG, 1e-9), (cam.pitch / DEG).toFixed(4));
  for (let i = 0; i < 20; i++) cam.dolly(10);
  check('dolly in clamps at 0.3 R', near(cam.targetDistance, 0.3 * R, 1e-12));
  for (let i = 0; i < 20; i++) cam.dolly(-10);
  check('dolly out clamps at 3 R', near(cam.targetDistance, 3 * R, 1e-12));
  cam.frame(focus, R, up);
  for (let i = 0; i < 200; i++) cam.update(1 / 60);
  const d0 = cam.targetDistance;
  cam.dolly(1);
  check('dolly is log-scaled (×1/1.15 per notch up)', near(cam.targetDistance, d0 / 1.15, 1e-12));
  let mono = true;
  let prev = cam.distance;
  for (let i = 0; i < 120; i++) {
    cam.update(1 / 60);
    if (cam.distance > prev + 1e-15) mono = false;
    prev = cam.distance;
  }
  check('dolly glide has no overshoot', mono && near(cam.distance, d0 / 1.15, 1e-6));

  // Orbit direction: "grab the world" — dragging right moves the near side right.
  cam.frame(focus, R, up);
  const nearPt = new THREE.Vector3().copy(focus).addScaledVector(tmp.subVectors(cam.position, focus).normalize(), R * 0.8);
  const before = projectAt(cam, nearPt);
  cam.orbit(40, 0);
  for (let i = 0; i < 120; i++) cam.update(1 / 60);
  const after = projectAt(cam, nearPt);
  check('orbit right: near side follows the pointer right', after.x > before.x + 1, `${before.x.toFixed(1)} → ${after.x.toFixed(1)}`);
  cam.orbit(0, 40);
  for (let i = 0; i < 120; i++) cam.update(1 / 60);
  const after2 = projectAt(cam, nearPt);
  check('orbit down: near side follows the pointer down', after2.y > after.y + 1, `${after.y.toFixed(1)} → ${after2.y.toFixed(1)}`);

  // rayThrough = three.js PerspectiveCamera unproject, and projectToScreen round-trips it.
  cam.frame(focus, R, new THREE.Vector3(0.3, 0.9, -0.2).normalize());
  cam.orbit(123, -77);
  for (let i = 0; i < 30; i++) cam.update(1 / 90);
  cam.pose(pos, q);
  const pc = new THREE.PerspectiveCamera(FOV, W / H, 0.01, 1e4);
  pc.position.copy(pos);
  pc.quaternion.copy(q);
  pc.updateMatrixWorld();
  pc.updateProjectionMatrix();
  const origin = new THREE.PerspectiveCamera(FOV, W / H, 1e-7, 2e5); // render camera at the origin (camera-relative)
  origin.quaternion.copy(q);
  let angErr = 0;
  let pxErr = 0;
  for (const [px, py] of [[0, 0], [W, H], [W / 2, H / 2], [17.5, 701.25], [1100, 40], [640, 0], [0, 360]]) {
    cam.rayThrough(px, py, W, H, FOV, o, d);
    tmp.set((px / W) * 2 - 1, 1 - (py / H) * 2, 0.5).unproject(pc).sub(pc.position).normalize();
    angErr = Math.max(angErr, Math.acos(Math.min(1, tmp.dot(d))));
    tmp2.copy(o).addScaledVector(d, 3.7).sub(pos);
    const sp = projectToScreen(tmp2, origin, W, H);
    pxErr = Math.max(pxErr, Math.hypot(sp.x - px, sp.y - py));
  }
  check('rayThrough = PerspectiveCamera.unproject', angErr < 1e-6, `${angErr.toExponential(2)} rad`);
  check('rayThrough round-trips projectToScreen (HUD)', pxErr < 1e-6, `${pxErr.toExponential(2)} px`);
  check('pixelSize at depth d = 2 d tan(fov/2) / H', near(pixelSize(10, H, FOV), (20 * Math.tan(35 * DEG)) / H, 1e-15));

  // Frame-rate independence: same inputs, 40 Hz vs 240 Hz vs irregular steps.
  const runAt = (steps: number[]) => {
    const c = new OverviewCamera();
    c.frame(focus, R, up);
    c.orbit(300, -150);
    c.dolly(4);
    c.pan(50, 20, H, FOV);
    for (const s of steps) c.update(s);
    return c.position.clone();
  };
  const pA = runAt(Array(10).fill(1 / 40));
  const pB = runAt(Array(60).fill(1 / 240));
  const irregular: number[] = [];
  let left = 0.25;
  const ri = mulberry32(3);
  while (left > 1e-12) {
    const s = Math.min(left, uniform(ri, 0.001, 0.03));
    irregular.push(s);
    left -= s;
  }
  const pC = runAt(irregular);
  check('frame-rate independent (40 Hz = 240 Hz)', pA.distanceTo(pB) < 1e-9 * R, pA.distanceTo(pB).toExponential(2));
  check('frame-rate independent (irregular steps)', pA.distanceTo(pC) < 1e-9 * R, pA.distanceTo(pC).toExponential(2));
  const pMid = runAt([0.05]);
  check('glide is smooth, not a jump (moved, not arrived after 50 ms)', pMid.distanceTo(runAt([])) > 1e-3 && pMid.distanceTo(runAt([5])) > 1e-3);

  // fromDir: keeps the side, clamps the elevation.
  cam.frame(focus, R, up, new THREE.Vector3(1, 0.2, 0));
  tmp.subVectors(cam.position, focus).normalize();
  check('frame(fromDir) keeps the side', tmp.x > 0.9 && near(Math.asin(tmp.y), Math.asin(0.2 / Math.hypot(1, 0.2)), 1e-9));
  const cam2 = new OverviewCamera();
  cam2.frame(focus, R, up, new THREE.Vector3(0, -1, 1));
  check('frame(fromDir below) clamps to 8° above', near(cam2.pitch, OVERVIEW.framePitchMinDeg * DEG, 1e-12));
  // Re-frame without fromDir keeps the yaw and glides.
  cam2.orbit(200, 0);
  for (let i = 0; i < 200; i++) cam2.update(1 / 60);
  const yawBefore = cam2.yaw;
  cam2.dolly(5);
  for (let i = 0; i < 200; i++) cam2.update(1 / 60);
  cam2.frame(focus, R, up);
  check('re-frame glides (no snap)', near(cam2.yaw, yawBefore, 1e-12) && !near(cam2.distance, 2.2 * R, 1e-3));
  for (let i = 0; i < 300; i++) cam2.update(1 / 60);
  check('re-frame keeps yaw, resets pitch + distance', near(cam2.yaw, yawBefore, 1e-9) &&
    near(cam2.pitch, OVERVIEW.framePitchDeg * DEG, 1e-9) && near(cam2.distance, 2.2 * R, 1e-9));
  // follow(): rigid, no lag.
  const pBefore = cam2.position.clone();
  const shift = new THREE.Vector3(5, -3, 2);
  cam2.follow(tmp.copy(focus).add(shift));
  check('follow moves the camera rigidly', cam2.position.distanceTo(pBefore.add(shift)) < 1e-9);
  // Pan limit.
  for (let i = 0; i < 50; i++) cam2.pan(1e4, 0, H, FOV);
  for (let i = 0; i < 400; i++) cam2.update(1 / 60);
  check('pan limited to 1 R from the centre', cam2.focus.distanceTo(tmp) <= OVERVIEW.panLimit * R + 1e-9, cam2.focus.distanceTo(tmp).toFixed(4));
  // Yaw re-wrap: a steady drag of 0.5 rad per frame for 3 turns. A wrong wrap would add a ±2π
  // spin (a jump far beyond one frame's arc); the end pose must equal the same net drag done small.
  const cw = new OverviewCamera();
  cw.frame(focus, R, up);
  const perFrame = 0.5 / OVERVIEW.radPerPx;
  let jump = 0;
  const last = cw.position.clone();
  for (let i = 0; i < 38; i++) {
    cw.orbit(-perFrame, 0);
    cw.update(1 / 60);
    jump = Math.max(jump, cw.position.distanceTo(last));
    last.copy(cw.position);
  }
  for (let i = 0; i < 300; i++) cw.update(1 / 60);
  const cs = new OverviewCamera();
  cs.frame(focus, R, up);
  cs.orbit(-(38 * 0.5 - 6 * Math.PI) / OVERVIEW.radPerPx, 0);
  for (let i = 0; i < 300; i++) cs.update(1 / 60);
  const arc = 0.5 * cw.distance * Math.cos(cw.pitch);
  check('long orbit: yaw re-wrapped without jumps', Math.abs(cw.yaw) <= 4 * Math.PI + 1e-9 && jump <= arc * 1.05,
    `yaw ${cw.yaw.toFixed(3)}, max step ${jump.toFixed(3)} vs arc ${arc.toFixed(3)}`);
  check('long orbit: same end pose as the net drag', cw.position.distanceTo(cs.position) < 1e-9, cw.position.distanceTo(cs.position).toExponential(2));

  // NaN robustness: garbage input never poisons the pose.
  const c3 = new OverviewCamera();
  c3.frame(focus, R, up);
  const good = c3.position.clone();
  c3.orbit(NaN, 3);
  c3.orbit(1, Infinity);
  c3.dolly(NaN);
  c3.pan(Infinity, 0, H, FOV);
  c3.update(NaN);
  c3.update(-1);
  c3.frame(new THREE.Vector3(NaN, 0, 0), NaN, new THREE.Vector3(0, 0, 0), new THREE.Vector3(NaN, 1, 0));
  c3.follow(new THREE.Vector3(Infinity, 0, 0));
  c3.update(1 / 60);
  c3.rayThrough(NaN, NaN, 0, 0, NaN, o, d);
  const finite = [c3.position.x, c3.position.y, c3.position.z, c3.quaternion.w, o.x, d.x, d.y, d.z].every(Number.isFinite);
  check('NaN inputs: pose stays finite and in place', finite && c3.position.distanceTo(good) < 1e-9);

  // Many tiny up changes (each below the re-basis threshold, e.g. a spinning nebula re-framed often):
  // the horizontal basis must stay ⟂ up, so distance, pitch and rays stay exact.
  const c4 = new OverviewCamera();
  c4.frame(focus, R, up);
  c4.orbit(-150, 0);
  for (let i = 0; i < 300; i++) c4.update(1 / 60);
  const u4 = up.clone();
  const ax4 = new THREE.Vector3(1, 0, 0);
  for (let k = 0; k < 200; k++) {
    u4.applyAxisAngle(ax4, 0.2 * DEG);
    c4.frame(focus, R, u4);
    c4.update(1 / 60);
  }
  for (let i = 0; i < 300; i++) c4.update(1 / 60);
  tmp.subVectors(c4.position, c4.focus);
  const elev = Math.asin(tmp.dot(c4.up) / tmp.length());
  check('tiny up changes: basis stays ⟂ up (distance, pitch exact)', near(tmp.length(), 2.2 * R, 1e-9) &&
    near(c4.forward.length(), 1, 1e-12) && near(elev, OVERVIEW.framePitchDeg * DEG, 1e-9) && c4.up.dot(u4) > 1 - 1e-12,
    `dist ${tmp.length().toFixed(6)}, |fwd| ${c4.forward.length().toFixed(6)}, elev ${(elev / DEG).toFixed(4)}°`);
  // A re-frame on a far centre (a new arena) jumps instead of gliding across the universe.
  const c5 = new OverviewCamera();
  c5.frame(focus, R, up);
  const far5 = tmp.copy(focus).add(new THREE.Vector3(1000, 0, 0)).clone();
  c5.frame(far5, R, up);
  check('re-frame on a far centre snaps', c5.focus.distanceTo(far5) < 1e-9 && near(c5.distance, 2.2 * R, 1e-9));
}

function projectAt(cam: OverviewCamera, p: THREE.Vector3): { x: number; y: number } {
  const pc = new THREE.PerspectiveCamera(70, 1280 / 720, 1e-7, 2e5);
  pc.quaternion.copy(cam.quaternion);
  const sp = projectToScreen(new THREE.Vector3().subVectors(p, cam.position), pc, 1280, 720);
  return { x: sp.x, y: sp.y };
}

// ---------------------------------------------------------------------------------------------
section('daily');
{
  const lastMs = new Date(Date.UTC(2026, 9, 2, 23, 59, 59, 999));
  const firstMs = new Date(Date.UTC(2026, 9, 3, 0, 0, 0, 0));
  const zones = ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles', 'Asia/Kolkata', 'Europe/Warsaw'];
  const savedTz = process.env.TZ;
  let tzOk = true;
  for (const tz of zones) {
    process.env.TZ = tz;
    if (dailyId(new Date(lastMs.getTime())) !== '2026-10-02') tzOk = false;
    if (dailyId(new Date(firstMs.getTime())) !== '2026-10-03') tzOk = false;
    if (nextInText(new Date(Date.UTC(2026, 9, 2, 12, 34, 56))) !== '11:25') tzOk = false;
  }
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
  check('dailyId flips exactly at UTC midnight, in every time zone', tzOk);
  check('dailyNumber(2026-10-02) = 1', dailyNumber('2026-10-02') === 1);
  check('dailyNumber(2026-10-03) = 2', dailyNumber('2026-10-03') === 2);
  check('dailyNumber(2027-10-02) = 366', dailyNumber('2027-10-02') === 366);
  check('dailyNumber(2028-10-02) = 732 (leap day)', dailyNumber('2028-10-02') === 732);
  check('dailyNumber before launch / invalid = 0', dailyNumber('2026-10-01') === 0 && dailyNumber('2026-02-30') === 0 && dailyNumber('nope') === 0);
  check('isDailyId', isDailyId('2028-02-29') && !isDailyId('2027-02-29') && !isDailyId('2026-1-02') && !isDailyId(' 2026-10-02'));
  check('daysBetween across a year end', daysBetween('2026-12-31', '2027-01-01') === 1 && Number.isNaN(daysBetween('x', '2027-01-01')));
  check('addDays across leap Feb', addDays('2028-02-28', 1) === '2028-02-29' && addDays('2027-02-28', 1) === '2027-03-01' && addDays('2026-10-02', -1) === '2026-10-01' &&
    addDays('2026-10-02', 1e12) === null && addDays('x', 1) === null);
  check('dailySeed = fnv1a(id:mode), per mode', dailySeed('2026-10-02', 'firstlight') === fnv1a('2026-10-02:firstlight') &&
    dailySeed('2026-10-02', 'firstlight') !== dailySeed('2026-10-02', 'nursery'));
  check('nextInText 23:59:30 → 00:00', nextInText(new Date(Date.UTC(2026, 9, 2, 23, 59, 30))) === '00:00');
  check('nextInText 00:00:00 → 23:59', nextInText(firstMs) === '23:59');
  check('nextInText 23:00 → 01:00', nextInText(new Date(Date.UTC(2026, 9, 2, 23, 0, 0))) === '01:00');
  check('msUntilNextDaily at midnight = 24 h', msUntilNextDaily(firstMs) === 86_400_000 && msUntilNextDaily(lastMs) === 1);
  const now = new Date(Date.UTC(2026, 9, 20, 10, 0, 0));
  check('parseDailyParam today', parseDailyParam('today', now) === '2026-10-20' && parseDailyParam(' TODAY ', now) === '2026-10-20');
  check('parseDailyParam valid past/today', parseDailyParam('2026-10-02', now) === '2026-10-02' && parseDailyParam('2026-10-20', now) === '2026-10-20');
  check('parseDailyParam rejects future / pre-launch / invalid', [
    '2026-10-21', '2026-10-01', '2026-02-30', '2026-1-2', '', 'x'.repeat(100), '2026-10-02T00:00',
  ].every((s) => parseDailyParam(s, now) === null) && parseDailyParam(null, now) === null && parseDailyParam(undefined, now) === null);
}

// ---------------------------------------------------------------------------------------------
section('share');
{
  const url = 'https://ticksterius-afk.github.io/fractal-nebulae/?mode=firstlight&daily=2026-10-02';
  const s = buildShare({ number: 42, nebula: 'Menger', seedsLit: 2, seedsTotal: 3, massesUsed: 2, time: 72, url });
  // The exact example from design/20-first-light.md §3.3: a code-vs-doc drift check, skipped in a
  // checkout without design/ (the build-plan assertion below pins the same bytes either way).
  const docUrl = new URL('../design/20-first-light.md', import.meta.url);
  if (existsSync(docUrl)) {
    const doc = readFileSync(docUrl, 'utf8').split(/\r?\n/);
    const at = doc.findIndex((l) => l.startsWith('First Light #42'));
    const expected = at >= 0 ? `${doc[at]}\n${doc[at + 1]}` : '';
    check('share = design doc example, byte for byte', s === expected, JSON.stringify(s));
  } else console.log('  skip share = design doc example (no design/20-first-light.md in this checkout)');
  check('share = build-plan format', s === `First Light #42 · Menger · ◆◆◇  ⚬⚬  1:12\n${url}`);
  check('share without url = one line', !buildShare({ number: 1, nebula: 'Bulb', seedsLit: 1, seedsTotal: 1, massesUsed: 1, time: 5 }).includes('\n'));
  check('share with 0 masses keeps double spacing', buildShare({ number: 3, nebula: 'Bulb', seedsLit: 1, seedsTotal: 1, massesUsed: 0, time: 45 }) ===
    'First Light #3 · Bulb · ◆  0:45');
  check('share clamps and sanitises', buildShare({ number: 7.9, nebula: 'Pearl\nFoam ', seedsLit: 9, seedsTotal: 2, massesUsed: -3, time: NaN }) ===
    'First Light #7 · Pearl Foam · ◆◆  0:00');
  check('share title override', buildShare({ title: 'Relay', number: 2, nebula: '', seedsLit: 0, seedsTotal: 2, massesUsed: 1, time: 61 }) ===
    'Relay #2 · ◇◇  ⚬  1:01');
  const times: [number, string][] = [[0, '0:00'], [59.9, '0:59'], [72, '1:12'], [600, '10:00'], [3599, '59:59'],
    [3600, '1:00:00'], [3725, '1:02:05'], [NaN, '0:00'], [-5, '0:00'], [Infinity, '0:00']];
  const badT = times.filter(([t, e]) => formatTime(t) !== e);
  check('formatTime m:ss', badT.length === 0, badT.map(([t]) => `${t}→${formatTime(t)}`).join(', '));
  check('dailyShareUrl', dailyShareUrl('2026-10-02', 'firstlight', 'https://ticksterius-afk.github.io/fractal-nebulae/?x=1#h') === url &&
    dailyShareUrl('2026-10-02', 'firstlight') === '?mode=firstlight&daily=2026-10-02');
  let ok = false;
  let threw = false;
  try {
    ok = await copyText('hello');
  } catch {
    threw = true;
  }
  check('copyText outside a browser resolves false, never throws', !ok && !threw);
}

// ---------------------------------------------------------------------------------------------
section('save');
{
  check('Node: falls back to memory storage', saveBackendKind() === 'memory');

  class MapBackend implements SaveBackend {
    map = new Map<string, string>();
    failGet = false;
    failSet = false;
    getItem(k: string): string | null {
      if (this.failGet) throw new Error('get blocked');
      return this.map.get(k) ?? null;
    }
    setItem(k: string, v: string): void {
      if (this.failSet) throw new Error('QuotaExceededError');
      this.map.set(k, v);
    }
    removeItem(k: string): void {
      this.map.delete(k);
    }
  }
  interface Prog { streak: number; best: number; tips: string[]; done: boolean }
  const DEF: Prog = { streak: 0, best: 0, tips: [], done: false };
  const san = (raw: unknown): Prog => {
    if (!isRecord(raw)) return { ...DEF, tips: [] };
    return {
      streak: int(raw.streak, 0, 10_000, 0),
      best: num(raw.best, 0, 3600, 0),
      tips: strArray(raw.tips, 8, 16),
      done: bool(raw.done, false),
    };
  };
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  const be = new MapBackend();
  setSaveBackend(be);
  check('custom backend in use', saveBackendKind() === 'custom');
  check('empty store → defaults', eq(load('firstlight', san), DEF));
  const p1: Prog = { streak: 3, best: 72.5, tips: ['bend', 'capture'], done: true };
  check('save ok', save('firstlight', p1));
  check('round-trip', eq(load('firstlight', san), p1));
  check('second namespace kept separately', save('nursery', { a: 1 }) && eq(load('firstlight', san), p1) &&
    eq(load('nursery', (r) => r), { a: 1 }));
  check('stored under fractal-nebulae.progress.v1', PROGRESS_KEY === 'fractal-nebulae.progress.v1' && be.map.has(PROGRESS_KEY));

  // Wrong types and ranges are sanitised on load.
  be.map.set(PROGRESS_KEY, JSON.stringify({ firstlight: { streak: 'x', best: 1e9, tips: ['a', 3, 'a', 'b', 'waytoolongtipname!!'], done: 1 } }));
  check('sanitised on load', eq(load('firstlight', san), { streak: 0, best: 3600, tips: ['a', 'b'], done: false }));

  // Corrupt JSON: defaults, the next save works, the old text is kept aside.
  be.map.set(PROGRESS_KEY, '{"firstlight": {"streak": 3,');
  check('corrupt JSON → defaults', eq(load('firstlight', san), DEF));
  check('save over corrupt root works', save('firstlight', p1) && eq(load('firstlight', san), p1));
  check('corrupt text backed up', be.map.get(`${PROGRESS_KEY}.corrupt`) === '{"firstlight": {"streak": 3,');
  for (const bad of ['42', '[]', 'null', '"str"', 'true', '']) {
    be.map.set(PROGRESS_KEY, bad);
    check(`non-object root ${JSON.stringify(bad)} → defaults`, eq(load('firstlight', san), DEF));
  }
  // A sanitiser that throws on the stored value is retried with undefined.
  save('firstlight', p1);
  let calls = 0;
  const v = load('firstlight', (raw) => {
    calls++;
    if (raw !== undefined) throw new Error('bad');
    return 'fallback';
  });
  check('throwing sanitiser → called again with undefined', v === 'fallback' && calls === 2);
  // Namespaces: no prototype tricks.
  check('invalid namespaces rejected', !save('__proto__', 1) && !save('', 1) && !save('Bad', 1) && !save('a'.repeat(40), 1));
  check('load("constructor") is not Object.prototype.constructor', load('constructor', (r) => r) === undefined);
  check('load(invalid ns) → defaults', eq(load('__proto__', san), DEF));
  check('prototype untouched', ({} as Record<string, unknown>).polluted === undefined);
  // Unserialisable data.
  const cyc: Record<string, unknown> = { a: 1 };
  cyc.self = cyc;
  check('cyclic data → false, old data intact', !save('firstlight', cyc) && eq(load('firstlight', san), p1));
  check('undefined data → false', !save('firstlight', undefined));
  // Failing storage.
  be.failSet = true;
  check('quota exceeded → false, no throw', !save('firstlight', { ...p1, streak: 9 }));
  be.failSet = false;
  be.failGet = true;
  check('unreadable storage → defaults', eq(load('firstlight', san), DEF));
  check('unreadable storage → refuses to write blind', !save('firstlight', p1));
  be.failGet = false;
  check('data intact after failures', eq(load('firstlight', san), p1));

  // Export / import.
  save('nursery', { sites: [1, 2, 3] });
  const backup = exportAll();
  const parsed: unknown = JSON.parse(backup);
  check('export is a self-describing document', isRecord(parsed) && parsed.app === 'fractal-nebulae' && parsed.kind === 'progress' && parsed.version === 1);
  const be2 = new MapBackend();
  setSaveBackend(be2);
  check('import into a fresh store', importAll(backup) && eq(load('firstlight', san), p1) && eq(load('nursery', (r) => r), { sites: [1, 2, 3] }));
  const snapshot = be2.map.get(PROGRESS_KEY);
  const rejects = ['garbage', '', '[]', 'null', '{"app":"other","kind":"progress","version":1,"data":{}}',
    '{"app":"fractal-nebulae","kind":"progress","version":2,"data":{}}', '{"app":"fractal-nebulae","kind":"progress","version":1,"data":[]}',
    '{"__proto__":{"polluted":1},"BAD":2}'];
  check('import rejects junk, changes nothing', rejects.every((j) => !importAll(j)) && be2.map.get(PROGRESS_KEY) === snapshot);
  check('import accepts a bare namespace record and replaces all', importAll('{"firstlight":{"streak":5},"Bad Key":1}') &&
    load('firstlight', san).streak === 5 && load('nursery', (r) => r) === undefined);
  check('prototype untouched after imports', ({} as Record<string, unknown>).polluted === undefined);
  check('clear(ns)', save('relay', { x: 1 }) && clear('relay') && load('relay', (r) => r) === undefined && load('firstlight', san).streak === 5);

  setSaveBackend(null);
  check('auto-detect again → memory in Node', saveBackendKind() === 'memory');
}

console.log(`\nplatform-check: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
