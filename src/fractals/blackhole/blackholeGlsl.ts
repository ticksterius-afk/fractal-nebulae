/**
 * GLSL for the black-hole pass: Schwarzschild null-geodesic lensing, a fractal
 * accretion disk, relativistic jets, a glowing gas halo and a lensed starfield.
 *
 * All geometry is in the black hole's LOCAL frame, in units of the Schwarzschild
 * radius (rs = 1): disk in the XZ plane, spin axis +Y. The fragment shader is
 * assembled by `buildBlackHoleFragment()` as
 *   COMMON_GLSL + CAMERA_UNIFORMS_GLSL + SKY_SAMPLE_GLSL + the chunks below.
 *
 * Compile-time defines (set by BlackHoleMaterial from the quality preset / def):
 *   BH_MAX_STEPS      hard cap of geodesic steps (uBhSteps <= this)
 *   BH_FRACTAL_ITER   escape-time iterations for the disk fractal
 *   BH_DISK_PHASES    1 or 2 (two crossfaded shear phases for differential rotation)
 *   BH_HALO_NOISE     0 or 1 (noise-modulated halo gas)
 *   BH_DISK_JULIA     defined → Julia-set disk, else Mandelbrot-set disk
 *   BH_JETS           defined → relativistic jets along ±Y
 */
import { COMMON_GLSL, CAMERA_UNIFORMS_GLSL } from '../../render/shaders/common';
import { SKY_SAMPLE_GLSL } from '../../render/sky/skyShared';

export const BH_UNIFORMS_GLSL = /* glsl */ `
uniform vec3  uBhCamLocal;     // camera position, local units (rs = 1)
uniform mat3  uBhRot;          // local -> world rotation
uniform float uBhScale;        // ly per local unit (= rs in ly)
uniform float uBhLensRadius;   // lensing sphere radius, local units
uniform vec2  uBhDisk;         // disk inner / outer radius (rs)
uniform float uBhSpin;         // 0..0.99
uniform int   uBhSteps;        // geodesic step budget
uniform float uBhStepK;        // spatial step = uBhStepK * r
uniform float uBhCamGrav;      // sqrt(1 - w/r_cam): static-observer redshift factor of the camera
uniform float uBhDiskAngle;    // rigid disk rotation angle (wrapped on the CPU)
uniform float uBhHaloAngle;    // slow rotation of the halo gas (wrapped on the CPU)
uniform float uBhJetFlow;      // jet knot phase 0..1 (wrapped on the CPU)
uniform vec3  uBhDiskHot;
uniform vec3  uBhDiskCool;
uniform vec3  uBhJetColor;
uniform vec3  uBhGlowFar;
uniform vec3  uBhGlowNear;
uniform vec4  uBhFrac0;        // fractal plane centre xy, rho at inner edge, rho at outer edge
uniform vec4  uBhFrac1;        // julia c xy, angular fold count, log-spiral winding
uniform vec4  uBhPulse;        // resonance pulse centre (local xyz), radius (local)
uniform vec2  uBhPulseParams;  // pulse shell width (local), strength 0..1
uniform float uFade;
in vec2 vUv;
`;

/** Shared helpers: tapers, forces, flow phases. */
export const BH_CORE_GLSL = /* glsl */ `
#define BH_OMEGA_K 1.5          // Keplerian angular speed scale: omega = K * r^-1.5 (rad/s, rs units)
#define BH_DRAG_K 0.9           // gravitomagnetic (frame-dragging) strength per unit spin
#define BH_TWIST_K 1.4          // extra sky swirl per unit spin
#define BH_FLOW_PERIOD 7.0      // s, crossfade period of the Keplerian turbulence
#define BH_SHEAR_PERIOD 22.0    // s, crossfade period of the fractal's differential rotation

float bhSq(float x) { return x * x; }

// Gravity fades out toward the lensing sphere so the lensed sky meets the unlensed sky seamlessly.
float bhTaper(float r, float R) { return 1.0 - smoothstep(0.4 * R, 0.95 * R, r); }

// Photon "acceleration" in Cartesian Schwarzschild form (Binet equation u'' + u = 1.5 u^2, rs = 1),
// plus a gravitomagnetic dipole term that mimics Kerr frame dragging (prograde rays pulled in,
// retrograde pushed out → asymmetric, D-shaped shadow; rays over the poles get twisted).
vec3 bhAccel(vec3 p, vec3 v, float h2, float R) {
  float r2 = max(dot(p, p), 1e-6);
  float r = sqrt(r2);
  vec3 a = p * (-1.5 * h2 / (r2 * r2 * r));
  vec3 rh = p / r;
  vec3 B = (3.0 * rh.y * rh - vec3(0.0, 1.0, 0.0)) / (r2 * r);
  a += (uBhSpin * BH_DRAG_K) * cross(v, B);
  return a * bhTaper(r, R);
}

// Jet radius (rs) at height |y| above the disk: narrow, slowly widening cone.
float bhJetRadius(float ay) { return 0.18 + 0.035 * ay; }

// Two crossfaded phases (x, y in 0..1) and the weight of phase x. Keeps flowing textures
// bounded in time (no float drift) and hides the phase resets.
vec3 bhPhases(float t, float period) {
  float fa = fract(t / period);
  float fb = fract(t / period + 0.5);
  return vec3(fa, fb, 1.0 - abs(2.0 * fa - 1.0));
}

// Rotate v about local +Y by angle a (right-handed).
vec3 bhRotY(vec3 v, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}

// Robust ray/sphere intersection (no catastrophic cancellation when |ro| >> R).
vec2 bhSphere(vec3 ro, vec3 rd, float R) {
  float b = dot(ro, rd);
  vec3 perp = ro - b * rd;
  float h = R * R - dot(perp, perp);
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// Direction remap for a static observer deep in the potential: the local sky is aberrated
// toward the outward radial direction (escape cone shrinks to ~33 deg half-angle at r = 1.05).
vec3 bhStaticObserver(vec3 ro, vec3 rd, float rc, float R) {
  float w = bhTaper(rc, R);
  vec3 rh = ro / rc;
  float cr = dot(rd, rh);
  vec3 tv = rd - rh * cr;
  float st = length(tv);
  if (st < 1e-5 || w < 1e-4) return rd;
  float denom = max(1.0 - w * (1.0 - st * st) / rc, 1e-4);
  float sc = min(st / sqrt(denom), 1.0);
  float cc = (cr >= 0.0 ? 1.0 : -1.0) * sqrt(max(0.0, 1.0 - sc * sc));
  return normalize(rh * cc + (tv / st) * sc);
}
`;

/** Accretion disk: escape-time fractal in warped log-polar coordinates + Keplerian turbulence. */
export const BH_DISK_GLSL = /* glsl */ `
// Density of the escape-time fractal at complex coordinate q.
// fp: pixel footprint in fractal-plane units (widens filaments and trims iterations → no aliasing).
// Returns (density, hot-knot mask).
vec2 bhFractal(vec2 q, float fp) {
#ifdef BH_DISK_JULIA
  vec2 z = q;
  vec2 c = uBhFrac1.xy;
  vec2 dz = vec2(1.0, 0.0);
  float dzAdd = 0.0;
#else
  vec2 z = vec2(0.0);
  vec2 c = q;
  vec2 dz = vec2(0.0);
  float dzAdd = 1.0;
#endif
  int itLim = int(clamp(12.0 + 5.0 * log2(1.0 / max(fp, 1e-5)), 14.0, float(BH_FRACTAL_ITER)));
  float trap = 1e9;
  float m2 = 0.0;
  int n = 0;
  for (int i = 0; i < BH_FRACTAL_ITER; i++) {
    if (i >= itLim) break;
    dz = 2.0 * vec2(z.x * dz.x - z.y * dz.y, z.x * dz.y + z.y * dz.x) + vec2(dzAdd, 0.0);
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    m2 = dot(z, z);
    trap = min(trap, abs(m2 - 0.25));
    if (m2 > 1024.0) break;
    n++;
  }
  if (n >= itLim) {
    // Bounded orbit: dense, hot interior with cellular orbit-trap structure.
    float cell = exp(-trap * 7.0);
    return vec2(0.5 + 0.5 * cell, 0.25 * cell * cell);
  }
  float nu = clamp((float(n) + 1.0 - log2(max(log2(m2) * 0.5, 1e-6))) / float(itLim), 0.0, 1.0);
  float de = 0.25 * sqrt(m2) * log(m2) / max(length(dz), 1e-12);
  float w = max(0.0045, fp);
  float fil = exp(-de / w) * sqrt(0.0045 / w);
  float dens = 0.85 * pow(nu, 1.25) + 0.95 * fil;
  return vec2(min(dens, 1.3), fil * fil * nu);
}

// Keplerian turbulence (fine streaks along the orbits), 0..1.
float bhTurbulence(vec2 xz, float r) {
  float om = BH_OMEGA_K * pow(r, -1.5) + uBhSpin * 0.5 / (r * r * r);
  vec3 ph = bhPhases(uTime, BH_FLOW_PERIOD);
  vec2 qa = rot2(om * ph.x * BH_FLOW_PERIOD) * xz;
  vec2 qb = rot2(om * ph.y * BH_FLOW_PERIOD) * xz;
  float na = 0.5 * noise3(vec3(qa * 0.9, r * 3.1)) + 0.3 * noise3(vec3(qa * 2.6, r * 8.3 + 11.0))
           + 0.2 * noise3(vec3(qa * 7.0, r * 22.0 + 3.0));
  float nb = 0.5 * noise3(vec3(qb * 0.9 + 37.0, r * 3.1)) + 0.3 * noise3(vec3(qb * 2.6 - 19.0, r * 8.3 + 5.0))
           + 0.2 * noise3(vec3(qb * 7.0 - 5.0, r * 22.0 + 17.0));
  return mix(nb, na, ph.z);
}

// Emission (premultiplied rgb) and opacity of the disk at crossing point pc (local, y≈0).
// dirPhoton: unit direction the light travels (toward the camera). fpLocal: pixel footprint (rs).
vec4 bhDisk(vec3 pc, vec3 dirPhoton, float fpLocal) {
  float r = length(pc.xz);
  float rin = uBhDisk.x, rout = uBhDisk.y;
  float env = smoothstep(rin * 0.86, rin * 1.2, r) * (1.0 - smoothstep(rout * 0.58, rout * 1.03, r));
  if (env < 1e-3) return vec4(0.0);

  float L = log(rout / rin);
  float u = log(r / rin) / L;
  float x = min(rin / r, 1.0);
  float heat = pow(x, 0.75);
  float phi = atan(-pc.z, pc.x); // increases along the orbital motion

  // ---- fractal filaments: warped log-polar map into the fractal plane ----
  float folds = uBhFrac1.z;
  float rho = mix(uBhFrac0.z, uBhFrac0.w, clamp(u, 0.0, 1.0));
  float jac = max((uBhFrac0.w - uBhFrac0.z) / L, folds * rho) / r;
  float fp = fpLocal * jac;
  float swirl = uBhSpin * 1.8 * x * x;                       // frame-dragging twist near the hole
  float rMid = 1.8 * rin;
  float dOm = BH_OMEGA_K * pow(rMid, -1.5) * (pow(r / rMid, -0.5) - 1.0); // bounded differential shear
  float th0 = folds * (phi - uBhDiskAngle - swirl) + uBhFrac1.w * u;
#if BH_DISK_PHASES > 1
  vec3 ph = bhPhases(uTime, BH_SHEAR_PERIOD);
  float thA = th0 - folds * dOm * (ph.x - 0.5) * BH_SHEAR_PERIOD;
  float thB = th0 - folds * dOm * (ph.y - 0.5) * BH_SHEAR_PERIOD;
  vec2 fA = bhFractal(uBhFrac0.xy + rho * vec2(cos(thA), sin(thA)), fp);
  vec2 fB = bhFractal(uBhFrac0.xy + rho * vec2(cos(thB), sin(thB)), fp);
  vec2 fr = mix(fB, fA, ph.z);
#else
  vec2 fr = bhFractal(uBhFrac0.xy + rho * vec2(cos(th0), sin(th0)), fp);
#endif

  float turb = bhTurbulence(pc.xz, r);
  float dens = fr.x * (0.5 + 0.95 * turb) + 0.22 * turb;

  // ---- relativistic Doppler beaming + gravitational redshift ----
  float beta = min(sqrt(0.5 / max(r - 1.0, 0.3)), 0.7);          // circular-orbit speed (c)
  vec3 uOrb = normalize(vec3(pc.z, 0.0, -pc.x) + 1e-6);
  float gDop = sqrt(1.0 - beta * beta) / (1.0 - beta * dot(uOrb, dirPhoton));
  float gGrav = sqrt(max(1.0 - 1.0 / r, 0.02)) / uBhCamGrav;
  float g = clamp(gDop * gGrav, 0.25, 2.2);
  float beam = pow(g, 1.8);

  // Colour temperature: steeper than the brightness profile and nudged by the filament density
  // (dense filaments hotter, voids cooler). Hue and luminance are mixed separately: a plain RGB
  // mix lets the much brighter diskHot swamp the hue, washing the whole disk out to one pale tone.
  float heatD = max(pow(x, 1.35) + 0.2 * (fr.x - 0.55), 0.0) * pow(g, 0.55);
  float wT = clamp(heatD, 0.0, 1.0);
  float lumC = max(luminance(uBhDiskCool), 1e-4);
  float lumH = max(luminance(uBhDiskHot), 1e-4);
  vec3 col = mix(uBhDiskCool / lumC, uBhDiskHot / lumH, wT) * mix(lumC, lumH, wT);
  col = mix(col, vec3(luminance(col)) * vec3(0.8, 0.93, 1.25), clamp(heatD - 1.0, 0.0, 0.7));
  float lg = log2(g);
  col *= mix(vec3(1.0), lg > 0.0 ? vec3(0.82, 0.96, 1.3) : vec3(1.25, 0.8, 0.55), clamp(abs(lg) * 0.45, 0.0, 0.75));

  float bright = 0.1 + 0.9 * pow(heat, 2.2);
  float innerRim = exp(-bhSq((r - rin * 1.12) / (0.2 * rin)));   // luminous crown at the inner edge
  vec3 emis = col * (bright * dens * env * beam * 0.35) + uBhDiskHot * (innerRim * env * (0.35 + 0.4 * turb) * sqrt(beam) * 0.3);
  emis += (uBhDiskHot + vec3(1.0)) * (fr.y * env * heat * beam * 0.6);   // white-hot knots on filaments
  float alpha = env * clamp(0.12 + 0.8 * dens, 0.0, 0.96);

  // Resonance pulse lights up the disk as it sweeps through.
  if (uBhPulseParams.y > 0.0) {
    float sh = exp(-bhSq((length(pc - uBhPulse.xyz) - uBhPulse.w) / max(uBhPulseParams.x, 1e-3)));
    emis += vec3(0.7, 1.0, 1.35) * (sh * uBhPulseParams.y * env * (0.4 + dens) * 2.5);
  }
  return vec4(emis, alpha);
}

// Analytic glow of the disk's thin gas layer crossed at incidence |vy| (limb-brightened edge-on).
vec3 bhDiskHaze(vec3 pc, float vyAbs) {
  float r = length(pc.xz);
  float rin = uBhDisk.x, rout = uBhDisk.y;
  float env = smoothstep(rin * 0.7, rin * 1.3, r) * (1.0 - smoothstep(rout * 0.5, rout * 1.15, r));
  float heat = pow(min(rin / r, 1.0), 0.75);
  return mix(uBhDiskCool, uBhDiskHot, heat) * (env * heat * heat * 0.03 / max(vyAbs, 0.2));
}
`;

/** Volumetric emitters: jets, halo gas, inner corona, photon-ring glow. */
export const BH_VOLUME_GLSL = /* glsl */ `
#define BH_JET_BETA 0.8
#define BH_JET_SPEED 2.6          // knot speed along the jet (rs/s)
#define BH_JET_PERIOD 8.0

#ifdef BH_JETS
vec3 bhJet(vec3 p, vec3 dirPhoton, float R) {
  float ay = abs(p.y);
  float rho = length(p.xz);
  float Rj = bhJetRadius(ay);
  float q = rho / Rj;
  if (q > 3.2 || ay < 0.9) return vec3(0.0);
  float along = smoothstep(0.9, 2.6, ay) * (1.0 - smoothstep(0.5 * R, 0.9 * R, ay)) / (1.0 + 0.07 * ay);
  // Knots stream outward (two crossfaded phases keep coordinates bounded).
  float wphase = 1.0 - abs(2.0 * uBhJetFlow - 1.0);
  float fb = fract(uBhJetFlow + 0.5);
  float side = p.y >= 0.0 ? 1.0 : -1.0;
  vec2 xz = rot2(ay * 0.35) * (p.xz / Rj);
  float sa = ay * 0.5 - uBhJetFlow * BH_JET_PERIOD * BH_JET_SPEED * 0.5;
  float sb = ay * 0.5 - fb * BH_JET_PERIOD * BH_JET_SPEED * 0.5;
  float ka = noise3(vec3(xz * 0.8, sa + side * 13.0)) * 0.7 + noise3(vec3(xz * 2.1, sa * 2.3)) * 0.3;
  float kb = noise3(vec3(xz * 0.8 + 7.0, sb - side * 29.0)) * 0.7 + noise3(vec3(xz * 2.1 - 3.0, sb * 2.3)) * 0.3;
  float kn = mix(kb, ka, wphase);
  float core = exp(-q * q * 1.8);
  float sheath = exp(-q * q * 0.45) * 0.22;
  float cosT = side * dirPhoton.y;
  float D = sqrt(1.0 - BH_JET_BETA * BH_JET_BETA) / (1.0 - BH_JET_BETA * cosT);
  float boost = clamp(D * D, 0.06, 7.0);
  float kn2 = kn * kn;
  return uBhJetColor * ((core * (0.05 + 4.0 * kn2 * kn2) + sheath * kn) * along * boost * 0.9);
}
#endif

// Faint glowing gas around the disk (palette.glowFar) + hot corona near the inner edge (glowNear).
vec3 bhHalo(vec3 p, float r, float R) {
  float ay = abs(p.y);
  float flatten = exp(-ay / (0.22 * r + 0.4));
  float edge = 1.0 - smoothstep(0.45 * R, 0.97 * R, r);
  float d = exp(-r * 4.5 / R) * (0.06 + 0.94 * flatten) * edge * smoothstep(1.5, 5.0, r); // keep the shadow dark
#if BH_HALO_NOISE
  if (d > 2e-3) {
    vec3 q = bhRotY(p, -uBhHaloAngle);
    d *= 0.3 + 1.2 * noise3(q * 0.42 + vec3(3.1, 7.7, 1.3));
  }
#endif
  float rc = length(p.xz);
  float rin = uBhDisk.x;
  float corona = exp(-bhSq((rc - rin * 1.1) / (0.45 * rin))) * exp(-ay / (0.1 * rin + 0.12)) * smoothstep(1.1, 1.8, r);
  return uBhGlowFar * (d * 0.075) + uBhGlowNear * (corona * 0.035);
}
`;

/** Lensed sky: cubemap + procedural bright stars (so star images form arcs / Einstein rings). */
export const BH_SKY_GLSL = /* glsl */ `
#define BH_STAR_CELLS 110.0

// Bright stars on the (rest-frame) celestial sphere. fp: pixel footprint in radians in the
// SOURCE plane (from derivatives of the lensed direction) → energy-conserving splats that
// stretch into arcs where the lens magnifies and fade smoothly where it demagnifies.
vec3 bhStars(vec3 d, float fp) {
  vec3 q = d * BH_STAR_CELLS;
  vec3 base = floor(q - 0.5);
  float s0 = max(uPixelAngle * 0.7, 2e-4);
  float sig2 = s0 * s0 + fp * fp;
  float norm = (s0 * s0) / sig2;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    vec3 cell = base + vec3(float(i & 1), float((i >> 1) & 1), float((i >> 2) & 1));
    vec3 h = hash33(cell);
    if (h.x > 0.1) continue;
    vec3 jp = cell + 0.2 + 0.6 * hash33(cell + 17.31);
    float lj = length(jp);
    // Only stars whose jitter point lies near the sphere; with the window below every star
    // is fully contained in the 2x2x2 cell block → no clipped (square) stars.
    if (abs(lj - BH_STAR_CELLS) > 0.12) continue;
    vec3 dv = d - jp / lj;
    float d2 = dot(dv, dv);
    float win = 1.0 - smoothstep(0.2, 0.36, sqrt(d2) * BH_STAR_CELLS);
    float mag = 0.02 + 4.0 * pow(h.y, 10.0);
    vec3 tint = blackbody(mix(3000.0, 14000.0, h.z * h.z));
    acc += tint * (mag * norm * win * exp(-d2 / (2.0 * sig2)));
  }
  return acc;
}
`;

export const BH_MAIN_GLSL = /* glsl */ `
void main() {
  vec3 rdW = cameraRay(gl_FragCoord.xy + uJitter, uResolution, uCamRot, uTanHalf);
  mat3 w2l = transpose(uBhRot);
  vec3 rd = normalize(w2l * rdW);
  vec3 ro = uBhCamLocal;
  float R = uBhLensRadius;
  float rCam = length(ro);
  bool inside = rCam < R;
  vec2 hit = bhSphere(ro, rd, R);
  bool onLens = inside || (hit.y > 0.0 && hit.x <= hit.y);

  vec3 p = ro;
  float pathLen = 0.0;
  if (!inside) {
    float t0 = max(hit.x, 0.0);
    p = ro + rd * t0;
    pathLen = t0;
  } else if (rCam > 1.0) {
    rd = bhStaticObserver(ro, rd, rCam, R);
  }

  vec3 col = vec3(0.0);
  vec3 gas = vec3(0.0);   // halo gas + photon-ring glow, kept apart so the shadow stays an abyss
  vec3 ring = vec3(0.0);
  float T = 1.0;
  float rMin = inside ? rCam : R;
  float hitPath = -1.0;
  float absorbed = 0.0;
  float twist = 0.0;
  vec3 v = rd;

  if (onLens) {
    if (rCam <= 1.0) { absorbed = 1.0; hitPath = 0.0; rMin = 0.0; }
    vec3 Lv = cross(p, v);
    float h2 = dot(Lv, Lv);
    vec3 a = bhAccel(p, v, h2, R);
    // Jitter only WHERE volumetrics are sampled inside each step (kills banding). The geodesic
    // itself stays deterministic per pixel: near the photon ring ray directions are chaotic, and a
    // per-frame step jitter would make the lensed sky there flicker.
    float jit = hash12(gl_FragCoord.xy + fract(uTime * 7.13) * 97.0);
    for (int i = 0; i < BH_MAX_STEPS; i++) {
      if (i >= uBhSteps || absorbed > 0.5) break;
      float r = length(p);
      if (r <= 1.0) { absorbed = 1.0; if (hitPath < 0.0) hitPath = pathLen; break; }
      if (r > R && dot(p, v) > 0.0) break;
      float ds = clamp(uBhStepK * r, 0.015, 0.2 * R);
      float vl = max(length(v), 1e-4);
#ifdef BH_JETS
      float ay0 = abs(p.y);
      if (ay0 > 0.8) {
        // Resolve the narrow jet across its width; along the axis it varies slowly, so rays
        // running down the jet (blazar view) may take longer steps instead of exhausting the budget.
        float Rj = bhJetRadius(ay0);
        ds = min(ds, max(length(p.xz) - 2.5 * Rj, 0.45 * Rj) / max(length(v.xz) / vl, 0.4));
      }
#endif
      float dt = ds / vl;
      vec3 pPrev = p;
      v += (0.5 * dt) * a;
      p += dt * v;
      a = bhAccel(p, v, h2, R);
      v += (0.5 * dt) * a;
      float rN = length(p);
      rMin = min(rMin, rN);
      twist += uBhSpin * BH_TWIST_K * bhTaper(rN, R) * ds / (rN * rN * rN);

      vec3 dirPhoton = -normalize(v);
      vec3 pm = mix(pPrev, p, jit);
      float rm = length(pm);

      // Volumetric emission along the step.
      gas += (T * ds) * bhHalo(pm, rm, R);
      ring += (T * ds * 0.018 * exp(-bhSq((rm - 1.5) * 4.0))) * (uBhDiskHot * 0.5 + vec3(0.5 * luminance(uBhDiskHot)));
      vec3 e = vec3(0.0);
#ifdef BH_JETS
      e += bhJet(pm, dirPhoton, R);
#endif
      if (uBhPulseParams.y > 0.0) {
        float sh = exp(-bhSq((length(pm - uBhPulse.xyz) - uBhPulse.w) / max(uBhPulseParams.x, 1e-3)));
        e += vec3(0.5, 0.85, 1.3) * (sh * uBhPulseParams.y * 0.06 * bhTaper(rm, R));
      }
      col += T * e * ds;

      // Thin-disk crossing (exact, independent of step size).
      if ((pPrev.y > 0.0) != (p.y > 0.0)) {
        float f = pPrev.y / (pPrev.y - p.y);
        vec3 pc = mix(pPrev, p, f);
        float vyAbs = abs(dirPhoton.y);
        float dc = pathLen + f * ds;   // path length camera -> crossing
        // Near-field transparency: crossings closer to the camera than a fraction of the local
        // radius fade out. Without it the zero-thickness disk flips from filling the lower half
        // of the view to the upper half the instant the ship passes through the disk plane (and
        // shows a hugely magnified, featureless smear just before). With it, the disk opens up
        // under the ship like a thin cloud layer, and from inside the plane it reads edge-on.
        float nearF = smoothstep(0.0, 1.0, dc / (0.25 * length(pc.xz) + 0.15));
        if (nearF > 1e-3) {
          float fpLocal = dc * uPixelAngle / max(vyAbs, 0.12);
          vec4 dk = bhDisk(pc, dirPhoton, fpLocal);
          col += (T * nearF) * (dk.rgb + bhDiskHaze(pc, vyAbs));
          T *= 1.0 - dk.a * nearF;
          if (hitPath < 0.0 && T < 0.5) hitPath = dc;
        }
      }
      pathLen += ds;
      if (T < 0.01) break;
    }
  }

  // Lensed sky along the bent ray (with the ship's relativistic aberration from sampleSky).
  vec3 skyDir = uBhRot * normalize(bhRotY(v, twist));
  float D;
  vec3 dR = aberrate(skyDir, D);
  float fp = max(length(dFdx(dR)), length(dFdy(dR)));
  vec3 sky = sampleSkyRest(dR) + bhStars(dR, fp) * uSkyExposure;
  if (D != 1.0) sky = dopplerShift(sky, D);
  if (uBhCamGrav < 0.999) sky = dopplerShift(sky, pow(1.0 / uBhCamGrav, 0.6)); // gravitational blueshift
  col += (sky * T + ring) * (1.0 - absorbed) + gas * (1.0 - 0.85 * absorbed);

  float edge = 1.0 - smoothstep(0.75 * R, 0.985 * R, rMin);
  float alpha = (onLens ? edge : 0.0) * uFade;
  if (alpha < 1e-3) discard;
  // Scrub NaN/Inf (min/max drop NaN on D3D11): one bad texel would be smeared across the screen
  // by the bloom mip chain. 6e4 stays below the HalfFloat maximum of the scene target.
  col = clamp(col, vec3(0.0), vec3(6.0e4));
  gl_FragColor = vec4(col * alpha, alpha);
  float cosF = max(dot(rdW, uCamForward), 1e-3);
  gl_FragDepth = hitPath >= 0.0 ? logDepth(hitPath * uBhScale * cosF) : 1.0;
}
`;

/** Full fragment shader source for the black-hole pass. */
export function buildBlackHoleFragment(): string {
  return [
    COMMON_GLSL,
    CAMERA_UNIFORMS_GLSL,
    SKY_SAMPLE_GLSL,
    BH_UNIFORMS_GLSL,
    BH_CORE_GLSL,
    BH_DISK_GLSL,
    BH_VOLUME_GLSL,
    BH_SKY_GLSL,
    BH_MAIN_GLSL,
  ].join('\n');
}
