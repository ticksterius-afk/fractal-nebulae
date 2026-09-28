/**
 * Black-hole material: a full-screen pass (scissored by the Renderer to the lensing sphere)
 * that integrates Schwarzschild null geodesics and renders the fractal accretion disk,
 * jets, halo gas and the lensed sky. See blackholeGlsl.ts for the shader.
 *
 * Conventions for a black-hole NebulaRuntime (agreed with the flight module):
 *   runtime.fractal === null, runtime.scale === blackHole.rs (LOCAL unit = 1 rs),
 *   runtime.boundRadiusWorld === def.worldRadius (lensing sphere),
 *   runtime.rotation = local→world (disk in local XZ, spin axis local +Y).
 */
import * as THREE from 'three';
import type { BlackHoleParams, NebulaRuntime, QualityName, QualityPreset, RGB } from '../../core/types';
import {
  FULLSCREEN_VERT,
  applyCameraUniforms,
  applySkyUniforms,
  makeCameraUniforms,
  makeSkyUniforms,
  type RenderContext,
} from '../../render/RenderContext';
import { buildBlackHoleFragment } from './blackholeGlsl';

/** Hard cap compiled into the shader; the per-frame budget (uBhSteps) never exceeds it. */
const MAX_GEODESIC_STEPS = 320;
/** Must match BH_OMEGA_K in the shader (Keplerian angular speed scale, rad/s in rs units). */
const OMEGA_K = 1.5;
/** Must match BH_JET_PERIOD in the shader. */
const JET_PERIOD = 8;
/** Halo gas turns at this fraction of the disk pattern's rigid angular speed. */
const HALO_SPEED = 0.3;
const TAU = Math.PI * 2;

const FRACTAL_ITER: Record<QualityName, number> = { low: 28, medium: 36, high: 44, ultra: 56 };

/** How the escape-time fractal is mapped onto the disk (warped log-polar → complex plane). */
interface DiskFractalStyle {
  /** Complex-plane centre of the mapping. */
  center: [number, number];
  /** Radius in the complex plane at the disk's inner / outer edge. */
  rho0: number;
  rho1: number;
  /** Angular repetitions around the disk (integer → seamless). */
  folds: number;
  /** Log-spiral winding (radians across the disk) → trailing spiral filaments. */
  spiral: number;
  /** Julia constant (ignored by the Mandelbrot style). */
  juliaC: [number, number];
  /** Slow breathing of the Julia constant: amplitude in the complex plane. */
  juliaWobble: number;
}

const STYLES: Record<BlackHoleParams['diskStyle'], DiskFractalStyle> = {
  // Three flaming arms of Mandelbrot boundary "hair" around a hot cardioid core.
  mandelbrot: { center: [-0.75, 0], rho0: 0.35, rho1: 1.6, folds: 3, spiral: 3.0, juliaC: [0, 0], juliaWobble: 0 },
  // A dendritic Julia set (c near the Mandelbrot boundary) → four feathered filament arms.
  julia: { center: [0, 0], rho0: 0.25, rho1: 1.6, folds: 2, spiral: 3.0, juliaC: [-0.1, 0.651], juliaWobble: 0.012 },
};

interface BhState {
  style: DiskFractalStyle;
  /** Rigid angular speed of the fractal pattern (rad/s): Keplerian at 1.8 × diskInner. */
  omegaMid: number;
}

const states = new WeakMap<THREE.ShaderMaterial, BhState>();

// Scratch objects (allocation-free per-frame updates).
const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();

function setRGB(target: THREE.Vector3, c: RGB): void {
  target.set(c[0], c[1], c[2]);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Mirrors bhTaper() in the shader. */
function taper(r: number, R: number): number {
  return 1 - smoothstep(0.4 * R, 0.95 * R, r);
}

/** Geodesic step budget and spatial step factor (step = k·r) from the preset's march steps. */
function stepCount(q: QualityPreset): number {
  const ms = Math.max(30, q.marchSteps || 170);
  return Math.round(Math.min(MAX_GEODESIC_STEPS, Math.max(120, ms * 1.45)));
}
function stepFactor(q: QualityPreset): number {
  const ms = Math.max(30, q.marchSteps || 170);
  return Math.min(0.12, Math.max(0.04, 10.5 / ms));
}

function lensRadiusLocal(neb: NebulaRuntime, rs: number): number {
  const world = neb.boundRadiusWorld > 0 ? neb.boundRadiusWorld : neb.def.worldRadius;
  return Math.max(world / rs, 4);
}

function schwarzschildRadius(neb: NebulaRuntime, bh: BlackHoleParams): number {
  const rs = neb.scale > 0 && isFinite(neb.scale) ? neb.scale : bh.rs;
  return Math.max(rs, 1e-12);
}

export function createBlackHoleMaterial(neb: NebulaRuntime, quality: QualityPreset): THREE.ShaderMaterial {
  const bh = neb.def.blackHole;
  if (!bh) throw new Error(`createBlackHoleMaterial: nebula "${neb.def.id}" has no blackHole parameters`);
  const style = STYLES[bh.diskStyle] ?? STYLES.mandelbrot;
  const rs = schwarzschildRadius(neb, bh);
  const lensR = lensRadiusLocal(neb, rs);
  const diskInner = Math.min(Math.max(1.05, bh.diskInner), 0.4 * lensR);
  // Keep the disk inside the lensing sphere (nothing outside it is drawn by this pass).
  const diskOuter = Math.min(Math.max(diskInner * 1.5, bh.diskOuter), 0.9 * lensR);

  const uniforms: Record<string, THREE.IUniform> = {
    ...makeCameraUniforms(),
    ...makeSkyUniforms(),
    uBhCamLocal: { value: new THREE.Vector3(0, 0, 1e4) },
    uBhRot: { value: new THREE.Matrix3() },
    uBhScale: { value: rs },
    uBhLensRadius: { value: lensR },
    uBhDisk: { value: new THREE.Vector2(diskInner, diskOuter) },
    uBhSpin: { value: Math.min(0.99, Math.max(0, bh.spin)) },
    uBhSteps: { value: stepCount(quality) },
    uBhStepK: { value: stepFactor(quality) },
    uBhCamGrav: { value: 1 },
    uBhDiskAngle: { value: 0 },
    uBhHaloAngle: { value: 0 },
    uBhJetFlow: { value: 0 },
    uBhDiskHot: { value: new THREE.Vector3() },
    uBhDiskCool: { value: new THREE.Vector3() },
    uBhJetColor: { value: new THREE.Vector3() },
    uBhGlowFar: { value: new THREE.Vector3() },
    uBhGlowNear: { value: new THREE.Vector3() },
    uBhFrac0: { value: new THREE.Vector4(style.center[0], style.center[1], style.rho0, style.rho1) },
    uBhFrac1: { value: new THREE.Vector4(style.juliaC[0], style.juliaC[1], style.folds, style.spiral) },
    uBhPulse: { value: new THREE.Vector4(0, 0, 0, 0) },
    uBhPulseParams: { value: new THREE.Vector2(1, 0) },
    uFade: { value: 1 },
  };
  setRGB(uniforms.uBhDiskHot.value as THREE.Vector3, bh.diskHot);
  setRGB(uniforms.uBhDiskCool.value as THREE.Vector3, bh.diskCool);
  setRGB(uniforms.uBhJetColor.value as THREE.Vector3, bh.jetColor);
  setRGB(uniforms.uBhGlowFar.value as THREE.Vector3, neb.def.palette.glowFar);
  setRGB(uniforms.uBhGlowNear.value as THREE.Vector3, neb.def.palette.glowNear);

  const defines: Record<string, string | number> = {
    BH_MAX_STEPS: MAX_GEODESIC_STEPS,
    BH_FRACTAL_ITER: FRACTAL_ITER[quality.name] ?? 44,
    BH_DISK_PHASES: quality.name === 'low' ? 1 : 2,
    BH_HALO_NOISE: quality.name === 'high' || quality.name === 'ultra' ? 1 : 0,
  };
  if (bh.diskStyle === 'julia') defines.BH_DISK_JULIA = '';
  if (bh.jets) defines.BH_JETS = '';

  const mat = new THREE.ShaderMaterial({
    name: `blackhole:${neb.def.id}`,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: buildBlackHoleFragment(),
    uniforms,
    defines,
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    depthTest: true,
    depthFunc: THREE.AlwaysDepth,
    depthWrite: true,
  });

  states.set(mat, { style, omegaMid: OMEGA_K * Math.pow(1.8 * diskInner, -1.5) });
  updateStatic(mat, neb);
  return mat;
}

/** Orientation-independent uniforms that only change with the runtime transform. */
function updateStatic(mat: THREE.ShaderMaterial, neb: NebulaRuntime): void {
  const u = mat.uniforms;
  _m4.makeRotationFromQuaternion(neb.rotation);
  (u.uBhRot.value as THREE.Matrix3).setFromMatrix4(_m4);
}

export function updateBlackHoleUniforms(mat: THREE.ShaderMaterial, neb: NebulaRuntime, ctx: RenderContext): void {
  const u = mat.uniforms;
  const bh = neb.def.blackHole;
  const st = states.get(mat);
  if (!bh || !st) return;

  applyCameraUniforms(u, ctx);
  applySkyUniforms(u, ctx);
  updateStatic(mat, neb);

  const rs = schwarzschildRadius(neb, bh);
  const R = lensRadiusLocal(neb, rs);
  u.uBhScale.value = rs;
  u.uBhLensRadius.value = R;

  // Camera in LOCAL units, computed in doubles: rotationInv * (shipPos - pos) / rs.
  const cam = _v.copy(ctx.state.ship.position).sub(neb.position).applyQuaternion(neb.rotationInv).multiplyScalar(1 / rs);
  if (!isFinite(cam.x) || !isFinite(cam.y) || !isFinite(cam.z)) cam.set(0, 0, 1e4);
  (u.uBhCamLocal.value as THREE.Vector3).copy(cam);

  // Static-observer gravitational factor of the camera (tapered like the lensing force).
  const rc = cam.length();
  const w = taper(rc, R);
  u.uBhCamGrav.value = rc > 1 ? Math.min(1, Math.max(0.05, Math.sqrt(Math.max(1 - w / rc, 0)))) : 0.05;

  u.uBhSteps.value = stepCount(ctx.quality);
  u.uBhStepK.value = stepFactor(ctx.quality);

  // Time-based phases wrapped in doubles so the GPU never sees large arguments.
  // (Clamped to >= 0: JS % keeps the sign, and the shader's crossfade weights assume phases in 0..1.)
  const t = isFinite(ctx.time) ? Math.max(0, ctx.time) : 0;
  u.uBhDiskAngle.value = (st.omegaMid * t) % TAU;
  u.uBhHaloAngle.value = (st.omegaMid * HALO_SPEED * t) % TAU;
  u.uBhJetFlow.value = (t / JET_PERIOD) % 1;

  const f1 = u.uBhFrac1.value as THREE.Vector4;
  if (st.style.juliaWobble > 0) {
    f1.x = st.style.juliaC[0] + st.style.juliaWobble * Math.cos(((t * 0.021) % 1) * TAU);
    f1.y = st.style.juliaC[1] + st.style.juliaWobble * Math.sin(((t * 0.013) % 1) * TAU);
  }

  // Resonance pulse (world → local).
  const pulse = ctx.state.pulse;
  const pp = u.uBhPulseParams.value as THREE.Vector2;
  if (pulse.active && pulse.radius > 0) {
    const c = _v.copy(pulse.origin).sub(neb.position).applyQuaternion(neb.rotationInv).multiplyScalar(1 / rs);
    (u.uBhPulse.value as THREE.Vector4).set(c.x, c.y, c.z, pulse.radius / rs);
    const fade = Number.isFinite(pulse.age) ? 1 - Math.min(1, Math.max(0, pulse.age)) : 0; // NaN age → off
    const w = pulse.width / rs;
    pp.set(w > 0.08 ? w : 0.08, fade * fade);
  } else {
    pp.y = 0;
  }
}
