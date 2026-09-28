/**
 * Einstein–Rosen bridge transit, drawn by the final compositor while `state.wormhole.active`.
 *
 *   vec3 wormholeTunnel(vec2 uv, float aspect, float progress, float time)
 *     uv       screen coordinate 0..1
 *     aspect   width / height
 *     progress transit progress 0..1 (SimState.wormhole.progress)
 *     time     seconds, any continuous clock (only drives periodic shimmer, so it may be large)
 *   Returns linear HDR colour.
 *
 * Look: a spiralling throat whose walls are a volumetric Kali-set fractal (a few layers behind
 * the surface), spiral ribs, light streaming past ever faster, colour shifting from the source
 * black hole's warm tones through violet to cool cyan-white, and a bright exit disc that grows
 * from progress 0.5 to fill the view at 1.0. The compositor owns the blend: fade the tunnel in
 * over the first ~10 % of progress and add the final white flash near 1.0.
 *
 * Requires COMMON_GLSL (hash11, PI, TAU) to be included before it. Helpers are prefixed `wh`.
 */
export const WORMHOLE_GLSL = /* glsl */ `
// Kali-set orbit accumulation: intricate filament density, bounded for bounded input.
float whKali(vec3 p) {
  float acc = 0.0, prev = 0.0;
  for (int i = 0; i < 9; i++) {
    p = abs(p) / max(dot(p, p), 1e-4) - vec3(0.59, 0.55, 0.49);
    float l = length(p);
    acc += abs(l - prev);
    prev = l;
  }
  return acc;
}

// Warm (source black hole) -> violet -> cool cyan-white along the transit; t adds local hue play.
vec3 whPalette(float t, float pr) {
  float x = clamp(pr * 2.1 + (t - 0.5) * 0.6, 0.0, 2.0);
  vec3 warm = mix(vec3(1.0, 0.42, 0.14), vec3(0.95, 0.22, 0.38), 0.5 + 0.5 * sin(t * 9.0));
  vec3 violet = vec3(0.5, 0.28, 1.05);
  vec3 cyan = mix(vec3(0.25, 0.8, 1.1), vec3(0.85, 1.0, 1.15), 0.5 + 0.5 * sin(t * 7.0));
  return x < 1.0 ? mix(warm, violet, smoothstep(0.0, 1.0, x)) : mix(violet, cyan, smoothstep(0.0, 1.0, x - 1.0));
}

vec3 wormholeTunnel(vec2 uv, float aspect, float progress, float time) {
  float pr = clamp(progress, 0.0, 1.0);
  // Motion is driven by progress only (a wrapped clock would make the tunnel jump at the wrap,
  // and an unwrapped one loses float precision); time only feeds 2π-periodic shimmer.
  float shimmer = fract(max(time, 0.0) / PI) * TAU;   // = 2·time mod 2π
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 2.0;
  float lp = length(p);
  float rr = max(lp, 1e-3);
  float ang = lp > 1e-6 ? atan(p.y, p.x) : 0.0;   // atan(0, 0) is undefined (NaN on some GPUs)

  // Distance travelled down the throat: accelerates with progress.
  float travel = 5.0 * pr + 22.0 * pr * pr * pr;
  float speed = 2.5 + 66.0 * pr * pr;
  float roll = 0.6 * pr;
  float zWall = min(0.85 / rr, 40.0);   // tunnel depth of the wall seen at this pixel (radius 1)
  float twist = 0.3 + 0.15 * pr;
  vec3 col = vec3(0.0);

  // Volumetric fractal wall: the surface plus two translucent layers behind it.
  for (int j = 0; j < 3; j++) {
    float fj = float(j);
    float rad = 1.0 + 0.22 * fj;
    float z = zWall * rad + travel;
    float a = ang + z * twist + roll;
    float qz = abs(3.0 - mod(z * 0.3, 6.0));             // mirror-tiled along the axis
    float k = min(whKali(vec3(cos(3.0 * a) * rad * 0.7, sin(3.0 * a) * rad * 0.7, qz)) * 0.1, 2.2);
    float rib = pow(0.5 + 0.5 * cos(a * 6.0 - z * 1.3), 8.0);
    float layer = j == 0 ? 1.0 : (j == 1 ? 0.55 : 0.3);
    float fog = exp(-zWall * rad * 0.16) * layer;
    float k2 = k * k;
    col += whPalette(fj * 0.07 + k * 0.25 + pr * 0.25, pr) * ((k2 * k2 * 0.08 + rib * 0.035) * fog);
  }

  // Streaming light: 36 angular lanes, segments rushing past at lane-dependent speeds.
  float a0 = ang + (zWall + travel) * twist + roll;
  float sa = a0 * 36.0 / TAU;
  float lane = mod(floor(sa), 36.0);                     // periodic → no seam at the atan wrap
  float fl = fract(sa) - 0.5;
  float h = hash11(lane * 7.13 + 3.1);
  float seg = fract((zWall + travel * (0.8 + 0.8 * h)) * 0.07 + h * 13.0);
  float len = clamp(0.1 + speed * 0.004, 0.1, 0.55);
  float streak = exp(-fl * fl * 90.0) * smoothstep(0.0, 0.03, seg) * (1.0 - smoothstep(0.03, 0.03 + len, seg)) * step(0.45, h);
  col += (whPalette(0.5, pr) + 0.4) * (streak * exp(-zWall * 0.12) * (0.4 + 0.05 * speed));

  // Light at the end of the throat → exit disc with a lensed, rippling rim.
  float open = smoothstep(0.5, 1.0, pr);
  float exitR = 0.015 + 0.95 * open * open;
  float rim = exitR * (1.0 + 0.06 * open * sin(ang * 7.0 + shimmer));
  float disc = smoothstep(rim * 1.2, rim * 0.65, rr) * open;
  vec3 exitCol = mix(vec3(1.25, 0.85, 0.7), vec3(0.85, 1.05, 1.35), smoothstep(0.3, 0.9, pr));
  float glow = exp(-rr / (0.06 + 0.45 * exitR)) * (0.25 + 2.2 * open);
  float rq = (rr - rim * 1.12) / (0.02 + 0.05 * exitR);   // no pow(): base is negative inside the rim
  float ring = exp(-rq * rq) * open * 1.5;
  col = mix(col, exitCol * 4.0, disc) + exitCol * (glow + ring);
  return col;
}
`;
