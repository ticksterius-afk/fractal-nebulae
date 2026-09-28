/**
 * Procedural sky generator (rest frame) rendered once into an HDR cubemap.
 *
 * Content, from back to front: a nearly black floor, very faint large-scale nebulosity
 * (red Hα, blue reflection, grey cirrus), the Milky Way (tilted great circle with a warm
 * bulge, pink-violet inner disk, blue-violet outer disk, mottled star clouds, domain-warped
 * dust rifts), four layers of crisp faint stars whose density climbs steeply in the band,
 * and a sprinkle of tiny distant galaxies avoiding the plane (the "zone of avoidance").
 *
 * Point-like features are placed on a jittered 3D grid restricted to a one-cell-thick
 * spherical shell, which gives a uniform density per steradian with no cube-face seams.
 * All colours are linear HDR; the cubemap is HalfFloat so gradients never band.
 */
import { COMMON_GLSL } from '../shaders/common';

/** Brightness of the diffuse Milky Way light. */
export const SKY_MILKY_WAY_GAIN = 0.085;
/** Brightness of the faint large-scale nebulosity. */
export const SKY_NEBULOSITY_GAIN = 0.008;

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

/** Vertex shader for the BackSide generator box (camera sits at its centre). */
export const SKY_GEN_VERT = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const SKY_GEN_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform float uTexelAngle;   // angular size of one texel at a face centre (radians)
uniform vec3 uGalNorth;      // galactic north pole
uniform vec3 uGalCentre;     // direction of the galactic centre
uniform vec3 uGalEast;       // north x centre
in vec3 vDir;

#define MW_GAIN ${f(SKY_MILKY_WAY_GAIN)}
#define NEB_GAIN ${f(SKY_NEBULOSITY_GAIN)}
#define REF_TEXEL 0.000976562  // texel angle at a face centre of a 2048² cube (tuning reference)

// Noise coordinates squashed across the galactic plane: structures stretch along the band.
vec3 bandCoords(vec3 d, float squash) {
  return d + uGalNorth * (dot(d, uGalNorth) * (squash - 1.0));
}

// Diffuse Milky Way light. Outputs the stellar density (drives the star layers), the dust
// transmission (also dims the stars behind the rifts) and |galactic latitude|.
vec3 milkyWay(vec3 d, out float dens, out vec3 trans, out float absLat) {
  float lon = atan(dot(d, uGalEast), dot(d, uGalCentre));   // 0 toward the centre
  float b = asin(clamp(dot(d, uGalNorth), -1.0, 1.0));
  // gentle warp so the disk is not a ruler-straight great circle (integer harmonics: seamless at ±π)
  float bw = b - 0.030 * sin(lon + 0.6) - 0.018 * sin(2.0 * lon + 1.9) - 0.010 * sin(3.0 * lon + 0.3);
  float ab = abs(bw);
  absLat = ab;
  float lonW = exp(-lon * lon / 1.3);         // brightening toward the centre
  float cosL = cos(lon);

  vec3 q = bandCoords(d, 2.6);
  float clouds = fbm3(q * 5.0 + vec3(1.3, 7.1, -2.4), 5);
  float fine = fbm3(q * 22.0 + vec3(-4.2, 2.2, 8.8), 3);
  float cloudMod = (0.35 + 1.3 * smoothstep(0.32, 0.78, clouds)) * (0.75 + 0.5 * fine);

  float hThin = mix(0.05, 0.085, lonW);
  float thin = exp(-ab / hThin) * (0.45 + 0.55 * lonW + 0.1 * cosL);
  float thick = exp(-ab / 0.2) * (0.18 + 0.3 * lonW);
  float bulge = exp(-(lon * lon) / (2.0 * 0.26 * 0.26) - (bw * bw) / (2.0 * 0.17 * 0.17));
  float bulgeCore = exp(-(lon * lon) / (2.0 * 0.08 * 0.08) - (bw * bw) / (2.0 * 0.06 * 0.06));

  // dust: domain-warped fbm; the Great Rift runs just off the mid-plane
  vec3 wq = q * 2.2;
  vec3 warp = vec3(fbm3(wq + vec3(3.1, 0.0, 1.7), 4),
                   fbm3(wq + vec3(-5.3, 9.4, 2.2), 4),
                   fbm3(wq + vec3(8.8, -2.6, 15.2), 4));
  float dn = fbm3(q * 6.0 + (warp - 0.5) * 3.0, 6);
  float riftC = 0.012 * sin(2.0 * lon + 0.4) + 0.006 * sin(5.0 * lon + 2.0);
  float riftW = 0.02 + 0.025 * lonW;
  // the rift is prominent toward the inner galaxy only (as in Cygnus → Sagittarius)
  float riftK = 0.25 + 0.75 * smoothstep(1.4, 0.3, abs(lon));
  float rz = (bw - riftC) / riftW;
  float rift = exp(-rz * rz);
  float lanes = rift * riftK * smoothstep(0.38, 0.66, dn);
  float patches = exp(-ab / 0.10) * smoothstep(0.52, 0.78, dn) * 0.8;
  float wisps = exp(-ab / 0.28) * smoothstep(0.62, 0.86, dn) * 0.5;
  float tau = 2.6 * lanes + 1.4 * patches + 0.8 * wisps;
  trans = exp(-tau * vec3(0.88, 1.0, 1.16));   // blue is absorbed more: reddened rift edges

  dens = clamp(thin * cloudMod + 0.5 * thick + 1.5 * bulge, 0.0, 2.0);

  vec3 cOuter = vec3(0.42, 0.52, 1.00);   // blue-violet outer disk
  vec3 cInner = vec3(1.00, 0.55, 0.95);   // pink-violet inner disk
  vec3 cBulge = vec3(1.00, 0.76, 0.58);   // warm cream core
  vec3 disk = mix(cOuter, cInner, lonW) * (thin * cloudMod + thick * 0.6);
  vec3 core = cBulge * (bulge * 1.3 * (0.7 + 0.5 * clouds) + bulgeCore * 1.2);
  vec3 light = (disk + core) * trans;

  // Hα star-forming knots strung along the plane
  float ha = smoothstep(0.64, 0.86, fbm3(q * 11.0 + vec3(7.7, -1.1, 3.3), 4)) * exp(-ab / 0.035);
  light += vec3(1.0, 0.2, 0.34) * (ha * 0.55 * (0.4 + 0.6 * trans.g));
  return light;
}

// Very faint large-scale nebulosity: red Hα clouds (mostly near the plane), blue reflection
// nebulae and grey-brown galactic cirrus at high latitude.
vec3 faintNebulosity(vec3 d, float ab) {
  float n1 = fbm3(d * 2.3 + vec3(21.0, 3.0, -7.0), 5);
  float n2 = fbm3(d * 3.4 + vec3(-5.0, 11.0, 2.0), 5);
  float n3 = fbm3(d * 1.6 + vec3(2.0, -13.0, 5.0), 4);
  vec3 ha = vec3(1.0, 0.16, 0.26) * smoothstep(0.56, 0.82, n1) * (0.3 + 1.2 * exp(-ab / 0.2));
  vec3 refl = vec3(0.28, 0.45, 1.0) * smoothstep(0.60, 0.86, n2) * 0.6;
  vec3 cirrus = vec3(0.6, 0.52, 0.46) * smoothstep(0.55, 0.90, n3) * 0.35 * smoothstep(0.1, 0.5, ab);
  return ha + refl + cirrus;
}

// Star colour from a uniform random number: mostly K/G, some M, F and A, a few blue B/O.
vec3 starColor(float t) {
  float T = t < 0.10 ? mix(2700.0, 3600.0, t / 0.10)
          : t < 0.55 ? mix(3600.0, 5200.0, (t - 0.10) / 0.45)
          : t < 0.85 ? mix(5200.0, 7000.0, (t - 0.55) / 0.30)
          : t < 0.97 ? mix(7000.0, 10500.0, (t - 0.85) / 0.12)
          :            mix(10500.0, 28000.0, (t - 0.97) / 0.03);
  vec3 c = blackbody(T);
  c /= max(luminance(c), 1e-3);
  return mix(c, vec3(1.0), 0.3);
}

// Point-star layers on jittered grids (angular cell size SL_CELL). The probability that a cell
// holds a star climbs with the Milky Way density (soft threshold keeps stars whole); peak
// brightness follows a power law. One loop over layers keeps the program small for ANGLE.
const float SL_CELL[4]  = float[4](0.0042, 0.0085, 0.017, 0.036);
const float SL_PBASE[4] = float[4](0.015, 0.10, 0.22, 0.30);
const float SL_PBAND[4] = float[4](0.55, 0.35, 0.25, 0.20);
const float SL_PMIN[4]  = float[4](0.010, 0.025, 0.05, 0.10);
const float SL_PMAX[4]  = float[4](0.06, 0.25, 0.9, 1.8);
const float SL_SLOPE[4] = float[4](1.4, 1.3, 1.2, 1.1);
const float SL_SEED[4]  = float[4](17.0, 43.0, 71.0, 97.0);

vec3 pointStars(vec3 d, float dens, float sigma, float energy) {
  float inv2s2 = 0.5 / (sigma * sigma);
  float cut = 16.0 * sigma * sigma;
  vec3 acc = vec3(0.0);
  for (int layer = 0; layer < 4; layer++) {
    float R = 1.0 / SL_CELL[layer];
    float prob = SL_PBASE[layer] + SL_PBAND[layer] * dens;
    float seed = SL_SEED[layer];
    vec3 c0 = floor(d * R);
    for (int k = 0; k < 27; k++) {
      vec3 c = c0 + vec3(float(k % 3), float((k / 3) % 3), float(k / 9)) - 1.0;
      vec3 s = c + hash33(c + seed);
      float rs = length(s);
      if (abs(rs - R) > 0.5) continue;          // one-cell shell: uniform per steradian
      vec3 dv = d - s / rs;
      float a2 = dot(dv, dv);
      if (a2 > cut) continue;
      vec3 h = hash33(c.zxy * 1.618 + seed * 3.7 + 11.0);
      float pr = clamp((prob - h.x) * 40.0 + 0.5, 0.0, 1.0);
      if (pr <= 0.0) continue;
      float peak = min(SL_PMIN[layer] * pow(max(h.y, 1e-4), -1.0 / SL_SLOPE[layer]), SL_PMAX[layer]);
      acc += starColor(h.z) * (peak * pr * energy * exp(-a2 * inv2s2));
    }
  }
  return acc;
}

// Tiny, faint, distant galaxies: elliptical smudges with a warm nucleus; spirals get a bluish disk.
vec3 galaxyLayer(vec3 d, float avoid) {
  const float cellAng = 0.07;
  float R = 1.0 / cellAng;
  vec3 c0 = floor(d * R);
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 27; k++) {
    vec3 c = c0 + vec3(float(k % 3), float((k / 3) % 3), float(k / 9)) - 1.0;
    vec3 s = c + hash33(c + 101.0);
    float rs = length(s);
    if (abs(rs - R) > 0.5) continue;
    vec3 h2 = hash33(c.yzx * 1.31 + 57.0);
    if (h2.x > 0.22 * avoid) continue;
    vec3 sd = s / rs;
    vec3 dv = d - sd;
    float sizeRef = REF_TEXEL * mix(0.9, 3.8, h2.y * h2.y);
    float sizeA = max(sizeRef, 0.8 * uTexelAngle);   // angle-fixed, never below a texel
    if (dot(dv, dv) > 49.0 * sizeA * sizeA) continue;
    vec3 t1 = normalize(cross(sd, abs(sd.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(sd, t1);
    vec2 lp = rot2(h2.z * TAU) * vec2(dot(dv, t1), dot(dv, t2));
    vec3 h3 = hash33(c.zyx * 0.77 + 5.0);
    float axisRatio = mix(0.18, 1.0, h3.x);
    float r = length(vec2(lp.x, lp.y / axisRatio)) / sizeA;
    float bright = mix(0.02, 0.1, h3.y * h3.y) * (sizeRef * sizeRef) / (sizeA * sizeA);
    float spiral = step(0.35, h3.z);
    vec3 cCore = vec3(1.0, 0.84, 0.64);
    vec3 cDisk = mix(cCore, vec3(0.72, 0.8, 1.0), spiral);
    acc += bright * (cCore * 0.9 * exp(-r * r * 8.0) + cDisk * exp(-r * mix(2.4, 1.6, spiral)));
  }
  return acc;
}

void main() {
  vec3 d = normalize(vDir);
  float dens, ab;
  vec3 trans;
  vec3 mw = milkyWay(d, dens, trans, ab);

  vec3 col = vec3(0.00035, 0.0004, 0.0007);          // deep space floor (never pure black)
  col += faintNebulosity(d, ab) * (NEB_GAIN * trans);
  col += mw * MW_GAIN;

  // crisp stars: sigma is a fixed angle (≈0.75 texel at a face centre, ≈1.6 texels at corners);
  // peak scaled so each star carries the same energy at every cube size
  float sig = 0.75 * uTexelAngle;
  float energy = (REF_TEXEL * REF_TEXEL) / (uTexelAngle * uTexelAngle);
  col += pointStars(d, dens, sig, energy) * mix(vec3(1.0), trans, 0.85);

  col += galaxyLayer(d, 1.0 - smoothstep(0.1, 0.8, dens)) * trans;
  gl_FragColor = vec4(col, 1.0);
}
`;
