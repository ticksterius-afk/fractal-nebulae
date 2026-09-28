/**
 * Shared sky sampling with special-relativistic effects. Included by the sky pass
 * AND by the black-hole shader (which samples the sky along lensed rays).
 *
 * Uniforms (filled by SkySystem / renderer for every material that includes this):
 *   uniform samplerCube uSkyCube;   // pre-rendered procedural sky (HDR, linear)
 *   uniform float uBeta;            // visual beta 0..0.92 (SimState.ship.betaVis)
 *   uniform vec3  uVelDir;          // world unit direction of motion
 *   uniform float uSkyExposure;     // overall sky brightness multiplier
 *
 * Physics (educational, and also correct):
 *   Aberration: an observer moving at β sees a source whose rest-frame angle from the
 *   direction of motion is θ at cos θ' = (cos θ + β)/(1 + β cos θ) — the sky bunches forward.
 *   For rendering we invert it: given the observed pixel direction θ', sample the sky at
 *   cos θ = (cos θ' − β)/(1 − β cos θ').
 *   Doppler factor D = 1/(γ(1 − β cos θ')): >1 ahead (blueshift, brighter), <1 to the sides and behind.
 */
export const SKY_SAMPLE_GLSL = /* glsl */ `
uniform samplerCube uSkyCube;
uniform float uBeta;
uniform vec3 uVelDir;
uniform float uSkyExposure;

// Rest-frame direction for an observed direction (inverse aberration).
vec3 aberrate(vec3 dObs, out float doppler) {
  float b = clamp(uBeta, 0.0, 0.95);
  if (b < 1e-4) { doppler = 1.0; return dObs; }
  float cosO = clamp(dot(dObs, uVelDir), -1.0, 1.0);
  float cosR = (cosO - b) / (1.0 - b * cosO);
  vec3 perp = dObs - uVelDir * cosO;
  float pl = length(perp);
  vec3 pn = pl > 1e-6 ? perp / pl : vec3(0.0);
  float sinR = sqrt(max(0.0, 1.0 - cosR * cosR));
  float gamma = 1.0 / sqrt(1.0 - b * b);
  doppler = 1.0 / (gamma * (1.0 - b * cosO));
  return normalize(uVelDir * cosR + pn * sinR);
}

// Approximate spectral shift of an RGB colour by Doppler factor D, plus tamed beaming.
vec3 dopplerShift(vec3 c, float D) {
  float s = log2(max(D, 1e-3));
  vec3 toBlue = vec3(c.r * 0.08, c.r * 0.55 + c.g * 0.35, c.g * 0.65 + c.b);
  vec3 toRed  = vec3(c.r + c.g * 0.65, c.g * 0.35 + c.b * 0.55, c.b * 0.08);
  vec3 sh = s > 0.0 ? mix(c, toBlue, clamp(s * 0.9, 0.0, 1.0)) : mix(c, toRed, clamp(-s * 0.9, 0.0, 1.0));
  return sh * clamp(pow(D, 2.2), 0.02, 12.0);
}

// Raw sky (no relativistic effects) — rest-frame direction.
vec3 sampleSkyRest(vec3 dirRest) {
  return texture(uSkyCube, dirRest).rgb * uSkyExposure;
}

// Sky as seen from the moving ship, for an observed WORLD direction.
vec3 sampleSky(vec3 dirObs) {
  float D;
  vec3 dRest = aberrate(dirObs, D);
  vec3 c = sampleSkyRest(dRest);
  return D == 1.0 ? c : dopplerShift(c, D);
}
`;
