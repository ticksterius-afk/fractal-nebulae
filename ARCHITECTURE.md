# Fractal Nebulae — Architecture & Module Contracts

An immersive, relaxing, educational web voyage through a universe where the nebulae are
**raymarched 3D fractals**. You ride an invisible gravity-drive ship (no cockpit), with a
small, slick HUD, generative music that expresses each fractal's character, black-hole
fractals with gravitational lensing, time dilation and wormholes.

This document began as the build spec the module owners coded against in parallel. It now
describes the app **as built**. Where the implementation departed from the original spec, a
**Changed:** note says how and why. §9 collects those changes in one list.

Stack: **Vite 8 + TypeScript (strict) + three.js r186 (WebGL2, GLSL ES 3.00) + Tone.js 15**.
Fonts are bundled via @fontsource (Rajdhani, JetBrains Mono, Inter Variable). No network assets.
The Node.js requirement comes from Vite 8: `^20.19.0 || >=22.12.0`.

Target machine for tuning: **GTX 1080, 2560×1440 @ 119 Hz, i7-7700K, Chrome/Edge on Windows (ANGLE/D3D11)**.

---------------------------------------------------------------------------------------------

## 0. Ground rules for every module

* World unit = **1 light-year (ly)**. Speeds are ly/s. See `src/core/units.ts` for conversions
  (km/s, AU/s, mph, multiples of c) and formatting helpers.
* **Camera-relative rendering.** World positions are JS doubles on the CPU. The render camera
  sits at the **origin** with the ship's orientation. Anything sent to the GPU is either
  camera-relative (`worldPos − shipPos`, computed in doubles, then cast) or nebula-LOCAL.
* **Logarithmic depth everywhere** depth is written or tested: `logDepth(viewZ)` from
  `COMMON_GLSL`, where `viewZ = dot(cameraRelativePos, camForward)` in ly (near 1e-7 ly, far 2e5 ly,
  `TUNING.depthNear/Far`).
  - Full-screen raymarch passes write `gl_FragDepth = logDepth(viewZ)` (1.0 where nothing opaque was hit).
  - Sprite/point/streak vertex shaders place their quads at `logDepth(viewZ)` window depth.
* **ShaderMaterial WITHOUT `glslVersion`.** **Changed:** the first draft of this spec said
  `THREE.GLSL3`. In three r186 a ShaderMaterial with no `glslVersion` is still compiled as GLSL
  ES 3.00 (`#version 300 es` is prepended), and three declares
  `layout(location = 0) out vec4 pc_fragColor` plus `#define gl_FragColor pc_fragColor`. Setting
  GLSL3 removes that output declaration. So write fragment output to `gl_FragColor`. Extra MRT
  attachments declare `layout(location = 1…) out` themselves, as the TAA resolve does. Use
  `out`/`in` varyings. three injects `position`, `uv`, `projectionMatrix`,
  `modelViewMatrix`, `viewMatrix` and `cameraPosition`.
  **Validate every shader you touch** with `tools/glsl-check.ts`, which emulates exactly this
  prefix (`checkShader`, `checkMaterial`; run scripts with `npx tsx`).
  `npx tsx tools/check-all-shaders.ts` validates every program the app builds for all four
  presets and enforces this rule.
* **Sub-pixel jitter (TAAU).** Every full-screen pass that draws into the scene target (sky,
  nebulae, black holes) must trace `cameraRay(gl_FragCoord.xy + uJitter, uResolution, uCamRot,
  uTanHalf)`. `uJitter` is part of `CAMERA_UNIFORMS_GLSL` (`makeCameraUniforms` /
  `applyCameraUniforms`) and is (0,0) when TAA is off. A pass that ignores it shimmers under TAAU.
  Sprites are not jittered.
* Full-screen passes use `fullscreenTriangle()` + `FULLSCREEN_VERT` from `src/render/RenderContext.ts`,
  drawn with `FULLSCREEN_CAMERA` (the vertex shader ignores the camera), `frustumCulled = false`.
* **ANGLE-friendly GLSL**: loops have constant upper bounds with an early `break`
  (`for (int i = 0; i < MAX; i++) { if (i >= uIter) break; ... }`). No recursion, and no dynamic
  indexing of uniform arrays in hot loops. Sample textures inside loops or branches with
  `textureLod`/`texelFetch`, because FXC rejects gradient operations in flow control. Prefer
  branch-free folds in hot DEs (FXC flattens `if`s anyway; see `apollonian.ts`). Keep programs
  reasonably small: ANGLE compiles GLSL → HLSL → DXBC, and huge shaders take seconds.
* Colours are **linear HDR** until the final composite (tone mapping happens only there).
* Rendering is premultiplied-alpha: nebula and black-hole passes output
  `vec4(emission + T*surface, 1 − T)`, blended with `ONE, ONE_MINUS_SRC_ALPHA`.
* TypeScript strict; no `any` across module boundaries; no external network requests;
  per-frame code is allocation-free (reuse vectors and objects) and NaN-guarded.
* Performance is a feature: the experience must stay smooth. Dynamic resolution and TAAU
  handle the rest (§3.1).
* Aesthetic north star: JWST *Pillars of Creation*, Hubble *Mystic Mountain*, the Milky Way
  core, NGC 3603. That means dusty pillars with luminous rims, glowing ionised gas (Hubble
  palette: SII red, Hα orange/green, OIII teal-blue), sharp stars with **JWST 6(+2) point
  diffraction spikes**, deep blacks, gentle film grain, and no banding (dither before 8-bit output).

---------------------------------------------------------------------------------------------

## 1. File map

| Area | Files |
|---|---|
| Contracts | `src/core/types.ts`, `src/core/events.ts`, `src/core/units.ts`, `src/core/math.ts`, `src/app/config.ts`, `src/render/shaders/common.ts`, `src/render/sky/skyShared.ts`, `src/render/RenderContext.ts`, `src/universe/catalog.ts`, `src/fractals/registry.ts` |
| Integration | `src/main.ts` (entry; exposes `window.__app` in dev only), `src/app/App.ts` (shell, frame loop, pointer-lock lifecycle) |
| Render core | `src/render/Renderer.ts`, `src/render/NebulaMaterial.ts`, `src/render/post/` (`FullscreenPass.ts` targets and helpers, `BloomPass.ts`, `TaaPass.ts`, `CompositePass.ts`, `postShaders.ts`) |
| Sky & stars | `src/render/sky/` (`SkySystem.ts`, `skyGenerator.ts`, `skyParams.ts`, `precompile.ts`, `uniformGuards.ts`), `src/render/stars/` (`StarSystem.ts`, `FarStars.ts`, `NearStars.ts`, `DustMotes.ts`, `NebulaStars.ts`, `sprites.ts`, `spriteShader.ts`, `starData.ts`) |
| Fractals | `src/fractals/mandelbulb.ts`, `mandelbox.ts`, `menger.ts`, `julia.ts`, `sierpinski.ts`, `apollonian.ts`, `kleinian.ts`, `kifs.ts`, `tree.ts` |
| Black holes | `src/fractals/blackhole/BlackHoleMaterial.ts`, `blackholeGlsl.ts`, `src/render/shaders/wormhole.ts` |
| Flight & sim | `src/ship/Input.ts`, `src/ship/Autopilot.ts`, `src/sim/Simulation.ts`, `src/sim/quat.ts`, `src/universe/Universe.ts` |
| Audio | `src/audio/` (`AudioEngine.ts`, `MusicDirector.ts`, `Deck.ts`, `Harmony.ts`, `profiles.ts`, `layers.ts`, `motifs.ts`, `instruments.ts`, `Sfx.ts`, `reverb.ts`, `control.ts`, `scales.ts`, `util.ts`) |
| HUD / UI | `src/hud/` (`Hud.ts`, `StartScreen.ts`, `PauseScreen.ts`, `Codex.ts`, `Readouts.ts`, `Markers.ts`, `Messages.ts`, `Reticle.ts`, `controls.ts`, `format.ts`, `dom.ts`), `src/styles/*.css`, `index.html` |
| Content | `src/content/codex.ts` (CODEX), `facts.ts` (VOID_FACTS, PHYSICS_TIPS), `astro.ts` (derived figures) |
| Game modes (§10) | `src/game/modes.ts`, `src/game/platform/` (`GameMode.ts` contract, `OverviewCamera.ts`, `save.ts`, `daily.ts`, `share.ts`, `prng.ts`), `src/game/firstlight/` (`types.ts` contract, `world.ts`, `Level.ts`, `Geodesic.ts`, `BeamTracer.ts`, `Solver.ts`, `Reach.ts`, `Generator.ts`, `DailyGen.ts`, `dailyArenas.ts`, `FirstLightMode.ts`, `Placement.ts`, `LabView.ts`, `OverlayFeed.ts`, `Ceremony.ts`, `progress.ts`, `chapters.ts`, `levels/*.ts`, `hud/*`), `src/audio/GameAudio.ts`, `public/daily/firstlight/*.json` |
| Game overlay (§10.3) | `src/render/game/` (`overlayTypes.ts` contract, `GameOverlayRenderer.ts`, `LineSystem.ts` + `lineShader.ts`, `GlyphSprites.ts` + `glyphShader.ts`, `GameStars.ts`, `LocalFrame.ts`, `overlayMesh.ts`) |
| Tools (not shipped) | `tools/glsl-check.ts`, `tools/check-all-shaders.ts`, `tools/check-contracts.ts`, `tools/_lead_check.ts`, `tools/cpu-render.ts`, `tools/devtools.js`, `tools/shot-receiver.mjs` (for `devtools.js` `__shot`); First Light: `tools/fl-trace-check.ts`, `fl-check.ts`, `fl-reach.ts` (click-reachability gate used by fl-check; bundled-daily audit `--dailies`, `--bundle YYYY-MM`), `fl-solve.ts`, `fl-preview.ts`, `fl-arenas.ts`, `fl-daily-build.ts`, `fl-daily-check.ts`, `platform-check.ts`, `fl-hud-preview.html/.ts`, `tools/flight/*.mts` |
| Packaging | `package.json`, `vite.config.ts`, `tsconfig.json`, `start.bat` |

A module owner writes only their own files. If a contract is insufficient, change it here and in
`types.ts` together, and don't work around it locally.

---------------------------------------------------------------------------------------------

## 2. Frame loop (`src/app/App.ts`)

```
boot():   WebGL2 probe → Hud → Simulation (attract mode) → Renderer → Input → rAF loop starts
          → await renderer.init(nebulae, progress)  (shader compilation, start-screen progress bar)
          → hud.setReady()                           (Launch enabled; Enter also launches)

frame():  const f = input.poll();
          if (phase === 'flying') dispatch f.toggles: H → hud.toggleVisible, Tab/I → hud.toggleCodex,
                                                      M → audio.toggleMute (+ flash message)
          sim.update(dt, f);                         // T (voyage) is handled inside the sim
          audio.update(sim.state);                   // try/catch: a failing subsystem never stops the loop
          renderer.render(state, nebulae)            // or renderer.syncCamera(state) until init resolves
          hud.update(state, nebulae, renderer.camera, renderer.stats);   // after render: markers use this frame's camera
```

* `dt` is clamped to 0.1 s. The simulation splits long frames into ≤ 1/55 s physics substeps,
  so the flight is identical at any frame rate.
* **Phases:** `loading → start → flying ⇄ paused`. Before launch the sim runs in **attract
  mode**: a silent voyage autopilot behind the start screen, with input ignored. Leaving it
  resets the ship to `TUNING.startPosition`, looking toward −Z.
* **Launch** (click or Enter) requests pointer lock and starts audio synchronously inside the
  user gesture. Audio volumes are set before `audio.start()` so the score fades in at the
  saved level.
* **Pointer-lock lifecycle.** Losing the lock (Esc, focus loss) → pause
  (`sim.setPaused`, `audio.setPaused`, `hud.showPause`, `pause` event). Resume re-requests the
  lock. Chrome refuses a re-lock for ~1.25 s after Esc, so Resume waits out a 1.4 s cooldown,
  still inside the gesture's activation window. A refused or unanswered request (2.5 s timeout)
  keeps or returns the app to the pause screen with a "click Resume to try again" note, so the
  user never ends up in flight with a free cursor. While flying without a lock, a click on the
  canvas re-requests it. `Input.requestLock` asks for `unadjustedMovement` (raw mouse) and falls
  back when that is unsupported.
* Settings (`AppSettings`) are persisted in `localStorage` (`fractal-nebulae.settings.v1`) and
  sanitised on load (`sanitizeSettings`: unknown or out-of-range values fall back to defaults).
  Changes apply live. A quality change calls `renderer.setQuality`, which compiles the new
  programs while the old ones keep rendering.

---------------------------------------------------------------------------------------------

## 3. Module APIs (as implemented)

### 3.1 Render core — `src/render/Renderer.ts`

```ts
export class Renderer {
  constructor(canvas: HTMLCanvasElement, quality: QualityPreset);
  readonly three: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;        // at origin; orientation × shake, fov from SimState
  readonly stats: { fps: number; frameMs: number; renderScale: number };
  exposure: number; bloomStrength: number; grain: number; chromaticAberration: number; // composite tunables
  taaEnabled: boolean;                             // get/set; defaults per preset (off on Low)
  init(nebulae: NebulaRuntime[], onProgress?: (p: number, label: string) => void): Promise<void>;
  setQuality(q: QualityPreset): Promise<void>;     // overlapping calls: the last one wins
  resize(cssWidth: number, cssHeight: number, dpr: number): void;   // output = css × dpr (dpr clamped 0.5–2)
  syncCamera(state: SimState): void;               // camera only (used before init resolves)
  render(state: SimState, nebulae: NebulaRuntime[]): void;
  dispose(): void;
}
```

**Frame pipeline** (`drawFrame`):

1. Build the `RenderContext`: camera at the origin, `camera.quaternion = ship.orientation × shake`,
   `fov = state.camera.fovDeg`, `beta = ship.betaVis` (≤ 0.92), `velDir = ship.velocityDir`, and
   `jitter` = a Halton(2,3) sub-pixel offset when TAA is on.
2. **Scene target** `sceneRT`: HalfFloat RGBA with a 32F depth texture, size = output × renderScale.
3. `sky.render()` (no depth) → `stars.renderFar()` (no depth test) → nebula and black-hole passes
   sorted **far → near**. A pass is culled if its render sphere is outside the frustum. Otherwise
   it is **scissored** to the sphere's exact projected rectangle, or drawn full-screen when the
   camera is inside or the rectangle covers ≥ 85 % of the view.
4. **Sprite layer.** With TAA on, `stars.renderNear()` (parallax stars, dust motes, nebula stars)
   draws into `spriteRT` instead of `sceneRT`. `spriteRT` has the same size and **shares
   sceneRT's depth texture**: it is depth-tested against the fractal surfaces but writes no
   depth. These sprites move with parallax or on their own, so the resolve could not reproject
   them. They bypass the TAA history and are added back in bloom and the composite. With TAA off
   they draw straight into `sceneRT`.
5. **Bloom** (`BloomPass`): dual-filter mip chain (Jimenez 2014) over sceneRT + spriteRT. It
   uses a 13-tap Karis-average downsample with a soft-knee threshold, up to 6 half-resolution
   levels, and a tent upsample.
6. **TAAU resolve** (`TaaPass`, full output resolution, MRT ping-pong history). It reconstructs
   the jittered scene samples, reprojects using the log depth (in the nearest nebula's rotating
   frame when inside its render sphere, world-static otherwise, rotation-only for sky), applies
   variance clipping in YCoCg and depth-disocclusion rejection, and blends in a Reinhard-encoded
   space. It resets on teleports and output-size changes. It self-disables with a single
   warning if the program or MRT target fails on a device. Details are in the header of
   `TaaPass.ts`.
7. **Composite** (`CompositePass`) to the canvas at output resolution: bilinear upscale plus a
   clamped unsharp mask (mild with TAAU: 0.18 + 0.22 × (upscale − 1), max 0.4), sprite layer,
   chromatic aberration (stronger with hyper and tidal stress), hyper radial zoom blur and speed
   tunnel, bloom, black-hole tidal swirl, wormhole transit (`WORMHOLE_GLSL`), exposure,
   hue-preserving ACES-fitted tone map, gentle grading, vignette, film grain, TPDF dither and
   linear → sRGB.
   While the wormhole tunnel fully covers the screen (progress 0.17–0.84), the scene passes are
   skipped.

**Dynamic resolution** (`tick`/`adaptResolution`):

* It keeps an EMA of the frame interval (~300 ms time constant) and a GPU frame time from
  `EXT_disjoint_timer_query_webgl2` where available.
* It lowers the scale by ×0.93 (at least one 0.025 quantum) when the EMA exceeds
  `targetFrameMs × 1.08`. It raises it by ×1.03 after 750 ms below `× 0.8`, or while the GPU
  timer shows it needs < 62 % of the budget. The GPU check lets the scale rise on displays whose
  refresh interval pins the frame interval.
* Resizes are at least 400 ms apart. Hitches, tab switches and the wormhole tunnel put
  adaptation on hold.
* Bounds are the preset's `renderScaleMin..Max`. With TAAU the minimum may drop 0.05 lower
  (floor 0.25). All presets target 16.7 ms.

**Per-nebula LOD** (`updateNebulaUniforms`): steps interpolate from 40 to `marchSteps` with the
projected angular radius (20–380 px). The cone epsilon is coarser when small. Envelope samples
scale with steps. Iterations drop to ~60 % far away, but **near structure the GPU always runs at
least `max(gpuIter, cpuIter)`**, so the drawn surface never lies outside the collision surface.
Nebulae fade in by projected size (0.75–3 px) and fade out beyond 21,000–30,000 ly.

**Shader compilation** (`init`): one compile group per distinct program. `compileAsync` uses
`KHR_parallel_shader_compile` and a 20 s timeout guard (three polls forever on context loss). The
start-screen progress label names each group. The context-lost and context-restored events are
handled.

### 3.2 Nebula material — `src/render/NebulaMaterial.ts`

```ts
export const NEBULA_LOOK: { ... };   // art-directed look constants (baked as #defines) — tuned by the lead
export function createNebulaMaterial(fractal: FractalDef, quality: QualityPreset): THREE.ShaderMaterial;
export function updateNebulaUniforms(mat: THREE.ShaderMaterial, neb: NebulaRuntime, ctx: RenderContext): void;
export function nebulaMaterialKey(fractal: FractalDef, q: QualityPreset): string;   // program signature
export function prepareNebulaShared(): Promise<void>;   // builds the shared 64³ RG8 noise texture in slices
export function disposeNebulaShared(): void;
```
Shader = `COMMON_GLSL` + `CAMERA_UNIFORMS_GLSL` + template uniforms + `fractal.glsl` + template body.
Template uniforms available to the fractal include `uniform vec4 uP[4]; uniform int uIter;` and
`uTime` (camera uniforms). The fractal source defines `FRACTAL_MAX_ITER` and
`float fractalDE(vec3 p, out vec4 trap)`, and optionally `FRACTAL_HAS_ALBEDO` + `fractalAlbedo(...)`
(used by the Apollonian foam). Quality selects `MAX_STEPS`, `AO_SAMPLES` and
`SHADOWS`/`SHADOW_STEPS` (11 on High, 16 on Ultra) as defines.

Template behaviour (everything in nebula-LOCAL units, so the look is identical at any world
size and stable at any zoom):
* Transform the ray to local space: `ro = rotInv*(camPos − nebPos)/scale`, `rd = rotInv*rdWorld`.
* Intersect the render sphere (`renderRadiusWorld/scale` = bound × haloFactor) and march only
  inside it. The fractal DE is evaluated out to 1.2 × bound, with the analytic bound-sphere
  distance beyond.
* Adaptive cone epsilon: `eps = t · uPixelAngle · detail`. Detail is per quality
  (1.5/1.2/1.0/0.85), per kind (Apollonian ×1.6: sub-pixel pearls cost much and show nothing),
  and per LOD. Detail below a pixel is not traced.
* **Nebular gas.** The ray integrates near-surface glow (`glowNear`, modulated by the traps),
  hot knots from `trap.w`, a wispy outer envelope (`glowFar`, radial falloff × drifting noise,
  photo-ionised brightening near the key star, forward scattering toward it), scale-aware fine
  wisps near surfaces, and dust absorption (transmittance `T`) for dark lanes. The glow length
  follows the camera's local surface distance, so the gas reads the same at every zoom.
* **Surface.** Tetrahedral normal, cosine-palette albedo from `trap.x/z` (or `fractalAlbedo`),
  AO from `aoSamples` DE probes × cavity (`trap.y`), wrap-diffuse key light from `lights[0]`
  (a default direction when a nebula has no light), optional soft shadow that stops short of the
  star, a shadow floor, **luminous rim** on silhouettes (`palette.rim`, strongest back-lit),
  and hot emission from `trap.w`.
* **Resonance pulse.** A spherical shell (`state.pulse`, converted to local units) adds emission
  where surfaces and gas cross it.
* Output is premultiplied, `× uFade`, firefly-clamped and NaN-scrubbed.
  `gl_FragDepth = logDepth(viewZ)` at a surface hit, at the haze point on exhausted rays, or
  at the gas's half-opacity point (so dense gas occludes the depth-tested sprites); 1.0 otherwise.
  Blending is `ONE, ONE_MINUS_SRC_ALPHA` with `depthFunc: Always` (the passes are ordered
  far→near on the CPU).

### 3.3 Sky & stars — `src/render/sky/SkySystem.ts`, `src/render/stars/StarSystem.ts`

```ts
export class SkySystem {
  constructor(renderer: THREE.WebGLRenderer, quality: QualityPreset);
  init(): Promise<void>;                        // renders the HDR (HalfFloat) cubemap once
  readonly cubeTexture: THREE.Texture;          // valid after init(); sampled via SKY_SAMPLE_GLSL
  render(renderer: THREE.WebGLRenderer, ctx: RenderContext): void; // full-screen sky, no depth
  setQuality(q: QualityPreset): Promise<void>;  // regenerates when skyCubeSize changes
  dispose(): void;
}
export class StarSystem {
  constructor(quality: QualityPreset, nebulae: NebulaRuntime[]);
  renderFar(renderer: THREE.WebGLRenderer, ctx: RenderContext): void;   // stars at infinity (no depth)
  renderNear(renderer: THREE.WebGLRenderer, ctx: RenderContext): void;  // parallax stars, dust, nebula stars
  setQuality(q: QualityPreset): void;
  compile(renderer, camera, target?): Promise<void>;
  dispose(): void;
}
```
* **Sky cubemap** (rest frame, `skyGenerator.ts`): a near-black floor, faint large-scale
  nebulosity, a tilted Milky Way with a warm bulge, pink-violet and blue-violet disk, star
  clouds and domain-warped dust rifts, four layers of faint stars that crowd the band, and tiny
  distant galaxies that avoid the plane. The galactic frame (`skyParams.ts`) is shared with the
  far-star catalogue. The galactic centre sits ~37° left of the starting view.
* The sky pass samples through `SKY_SAMPLE_GLSL` (`sampleSky(dir)`), which applies exact
  **relativistic aberration** `cos θ = (cos θ' − β)/(1 − β cos θ')` and a **Doppler** shift of
  colour and brightness `D = 1/(γ(1 − β cos θ'))`. `uniformGuards.ts` repairs NaN or zero
  relativistic uniforms before they can poison the frame.
* **Sprites** (`spriteShader.ts`, shared by all four kinds): instanced screen-space quads around
  an energy-conserving Gaussian core, with optional **JWST 6 + 2 diffraction spikes** (longer for
  red) and soft PSF wings. Sizes are in "reference px" scaled by `REF_PIXEL_ANGLE / pixelAngle`,
  so stars keep their energy and angular size at every dynamic resolution. No twinkle, because
  space doesn't twinkle.
* **Far stars:** a blackbody-coloured magnitude distribution on the celestial sphere that crowds
  the Milky Way. They get the same aberration and Doppler as the sky, and the brightest get spikes.
* **Near stars:** a camera-wrapped repeating box (offset = shipPos mod box, in doubles) for true
  parallax. They fade before the box edge, so wrapping never pops, and become energy-conserving
  **streaks** at speed.
* **Dust motes:** two octave levels of a camera-wrapped box sized from
  `floor(log2(surfaceDistance·3))` and crossfaded, so motion is legible at every zoom without
  visible rescaling. They are tinted by the region and flare as the pulse passes.
* **Nebula stars:** each `NebulaDef.lights[i]` becomes a bright spiked sprite at its world
  position, depth-tested so structure in front hides it.

### 3.4 Fractals — `src/fractals/<name>.ts` (the fractal GLSL contract; template side in §3.2)

Each exports `export const <name>: FractalDef` (full contract in `types.ts`). GLSL and the JS
`de` **are exact mirrors**: same parameter layout, same iteration semantics, same bail-outs. The
CPU drives flight speed, collision and targeting from what the GPU draws. Each fractal is
normalised to a bounding sphere of radius ≈ 1.2–1.8 local units and reports `boundRadius`
(verified numerically). Traps: `x`/`z` colour, `y` cavity, `w` sparse hot emission. `animate`
is slow (periods of 97–1200 s), small in amplitude, and applied on the CPU to both the uniforms
and the CPU DE. The CPU `de` is allocation-free.

**Iteration rule (learned the hard way).** For escape-time fractals (Mandelbulb, Mandelbox,
Julia, Menger) the DE of a not-yet-escaped orbit is not monotone in the iteration count, so the
CPU and GPU surfaces only coincide at equal counts. These set `FRACTAL_MAX_ITER = gpuIter =
cpuIter`, which caps the loop so a quality `iterScale > 1` can never push the GPU past the CPU.
For fractals that only gain structure with more folds (Apollonian, Kleinian, KIFS, tree), the
CPU runs the full `FRACTAL_MAX_ITER` and stays conservative against any GPU budget.

| Kind | Nebula | boundRadius | Iterations (max · GPU · CPU) | D (HUD) | Hot emission (`trap.w`) | Motion |
|---|---|---|---|---|---|---|
| `mandelbulb` | The Cauliflower Nebula | 1.2 | 11 · 11 · 11 | 3 | orbit passes near a trap point → sparse glowing **knots** on the florets (**Changed:** was a plane trap that drew lava-like filaments) | power 8 ± 0.45 (radius and polar angle only; the azimuthal multiplier stays exactly 8 to avoid a seam), phase drift |
| `mandelbox` | The Cathedral Nebula | 1.6 | 14 · 14 · 14 | 3 | orbit dives deep into the inner sphere-fold ball → glowing orbs (catalogue lowers the threshold) | emission threshold breathes (97 s) |
| `menger` | The Menger Lattice | 1.8 (cube [−1,1]³) | 10 · 10 · 10 | log 20/log 3 | a hashed subset of tunnels glows like furnace windows | carve threshold breathes slightly above 1 |
| `julia` | The Julia Veil | 1.5 | 16 · 16 · 16 | 3 | orbit grazes the real hyperplane → thin threads along the veils | c wanders near the Mandelbrot boundary, 1200 s loop |
| `sierpinski` | Sierpiński's Pyramid | 1.56 (circumradius 1.5) | 14 · 11 · 10 | 2 | knots at edge-midpoint junctions of level-3 sub-pyramids | tiny twist and tilt drift |
| `apollonian` | The Pearl Foam | 1.53 (ball 1.5) | 24 · 20 · 24 | 2.4739 | a hashed fraction of pearls within a size band | ball-preserving Möbius breathing |
| `kleinian` | Indra's Web | 1.53 (ball 1.5) | 16 · 13 · 16 | 2.6 | the smaller corner "jewels" glow | box size and disc radius breathe |
| `kifs` | The Frost Kaleidoscope | 1.53 | 9 · 8 · 9 | 1.89 | tip glints on the dendrite arms | twist and branch point drift |
| `tree` | The Lichtenberg Nebula | 1.7 | 18 · 15 · 18 | 2.3 | electric knots at hashed branch tips | fork and kink tilts drift |

### 3.5 Black holes — `src/fractals/blackhole/BlackHoleMaterial.ts`, `src/render/shaders/wormhole.ts`

```ts
export function createBlackHoleMaterial(neb: NebulaRuntime, quality: QualityPreset): THREE.ShaderMaterial;
export function updateBlackHoleUniforms(mat: THREE.ShaderMaterial, neb: NebulaRuntime, ctx: RenderContext): void;
export const WORMHOLE_GLSL: string; // defines: vec3 wormholeTunnel(vec2 uv, float aspect, float progress, float time)
```
Runtime conventions for a black hole: `fractal === null`, `scale === blackHole.rs` (local unit =
1 rₛ), `boundRadiusWorld === renderRadiusWorld === def.worldRadius` (the lensing sphere,
`haloFactor` 1). The disk lies in the local XZ plane and the spin axis is local +Y.

This is a full-screen pass scissored to the lensing sphere. It integrates bent light rays with
the Schwarzschild null geodesic in Cartesian form, `a = −1.5·h²·p/|p|⁵` (rₛ = 1, h = |p × v|), using adaptive
steps `k·r` and a step budget of 1.45 × `marchSteps` (120–320). Around it are a black shadow
(≈ 2.6 rₛ), the photon ring and a **fractal accretion disk**: a Mandelbrot (three flaming arms)
or Julia (c ≈ −0.10 + 0.65i, breathing slightly) escape-time structure in warped log-polar
coordinates. The disk has Keplerian differential rotation (two crossfaded shear phases),
Keplerian turbulence, a temperature gradient `diskHot → diskCool`, **relativistic Doppler
beaming**, gravitational redshift and a pixel-footprint filter against aliasing. Optional
volumetric **jets** along ±Y carry streaming knots and Doppler boost. There is also halo gas and
an inner corona, and the resonance pulse is supported. Spin adds a gravitomagnetic dipole term
(prograde rays pulled in, retrograde pushed out → a D-shaped shadow) and a frame-dragging sky
swirl. This is a visual stand-in for the full Kerr geometry, and the codex says so. Escaping rays
sample `sampleSky()` in the bent direction, which makes the Einstein ring. The camera's
static-observer blueshift is applied to the sky. Alpha fades to 0 at the sphere edge.
Output is premultiplied, with `gl_FragDepth` written. Quality sets the fractal iterations
(28/36/44/56), shear phases (1 on Low) and halo noise (High and Ultra).

`wormholeTunnel` renders the Einstein–Rosen transit in the composite. It is a spiralling throat
with volumetric Kali-set walls, spiral ribs and streaming light, shifting from the black hole's
warm tones to cool cyan-white. An exit disc grows from progress 0.5, and a white flash near 1.0
returns you to the scene.

### 3.6 Flight & simulation — `src/ship/Input.ts`, `src/sim/Simulation.ts`, `src/universe/Universe.ts`, `src/ship/Autopilot.ts`

```ts
export interface InputFrame {
  mouseDX: number; mouseDY: number;   // raw px since last poll (0 when not pointer-locked; ±400 px/event clamp)
  forward: number; strafe: number; lift: number; roll: number; // -1..1 (W/S, D/A, R/F, E/Q)
  precision: boolean;                 // Shift (either)
  hyper: boolean;                     // right mouse held (locked only)
  click: boolean;                     // left mouse pressed this frame (locked only)
  spaceTap: boolean;                  // Space released before TUNING.spaceHoldSeconds (0.35 s)
  spaceHold: boolean;                 // Space held beyond it (edge: true once)
  wheel: number;                      // wheel notches since last poll (+ = up; locked only; ±3/event)
  toggles: { hud: boolean; codex: boolean; mute: boolean; voyage: boolean }; // H, Tab|I, M, T pressed this frame
  anyMoveInput: boolean;              // WASD/QE/RF held, or deliberate mouse travel (leaky-integrated > 6 px)
}
export class Input {
  constructor(lockTarget: HTMLElement);
  readonly locked: boolean;
  requestLock(): void;                // must be called from a user gesture
  onLockChange(cb: (locked: boolean, failed: boolean) => void): void;  // failed = a request was refused
  poll(): InputFrame;                 // reused object: don't keep references across frames
  dispose(): void;
}
export class Universe {
  constructor(defs: NebulaDef[], resolveFractal?: FractalResolver);
  readonly runtimes: NebulaRuntime[];
  get(id: string): NebulaRuntime | undefined;
  indexOf(id: string | null): number;
  update(time: number, shipPos: THREE.Vector3): void;       // animate params/spin, distances, influence, surfaceDistance
  distance(p: THREE.Vector3): { dist: number; id: string | null }; // world DE (ly), conservative
  gradient(p: THREE.Vector3, eps: number, out: THREE.Vector3): THREE.Vector3;
  pick(origin: THREE.Vector3, dir: THREE.Vector3): string | null; // nebula under the reticle
}
export class Simulation {
  constructor(opts: { nebulae: NebulaDef[]; settings: AppSettings });
  readonly state: SimState;
  readonly universe: Universe;
  readonly nebulae: NebulaRuntime[];
  update(dt: number, input: InputFrame): void;
  setSettings(s: AppSettings): void;
  setPaused(p: boolean): void;
  setAttractMode(on: boolean): void;  // silent voyage autopilot, input ignored; off → reset to start
  setTarget(id: string | null): void;
  resetToStart(): void;
}
```
**Input details.** Keys are matched by `KeyboardEvent.code`, that is by physical position.
Toggles ignore key repeat and Ctrl/Alt/Meta. Tab calls `preventDefault` only while locked (with
a free pointer it keeps its focus-navigation role). Space never activates a focused button in
flight, and keys typed into form controls are ignored while unlocked. Blur, visibility change
and lock loss release every held key.

**Universe.** Fractal nebulae use `scale = worldRadius / fractal.boundRadius`. The world DE uses
the fractal DE inside 1.3 × bound and blends into the analytic bound-sphere distance by 2.0 ×
bound, which keeps it continuous and conservative. A black hole's "surface" is the horizon
`r − rₛ`, floored at 0.25 rₛ so gravity can carry you in. Influence is 1 inside 1.1 × bound and
0 beyond `influenceRadius`. Picking takes the closest nebula whose render-sphere disc contains
the reticle direction, else the angularly nearest within ≈ 2°. From inside a halo, the
enclosing nebula counts only when the reticle ray runs into its structure (or its heart, or a
black hole's disk), so you can pick the nebulae beyond through a gap. `SURFACE_CLEARANCE_LOCAL = 5e-5` local units is the closest approach to any surface.

**Flight model** (`FLIGHT` in `Simulation.ts`; the feel is what matters):
* Mouse → yaw and pitch through two cascaded smoothing stages (0.04 s + 0.055 s),
  0.0011 rad/px × sensitivity, with optional invert Y. Q/E roll runs at 1.1 rad/s. Banking into
  turns is gentle (≤ 0.075 rad). Flight is 6-DOF, with a soft auto-level only in voyage.
* **DE-adaptive cruise:** max speed = `cruiseFactor (0.6) × throttle × min(surfaceDistance, 800 ly)`,
  with Shift × 0.2. Accel/coast time constants are 0.38 / 0.55 s. An approach limiter keeps the
  speed toward the nearest surface below `1.3 × cruise × min(multiplier, 8) × distance`. Every
  translation is **sphere-traced** (6 iterations × 0.8 DE per substep), and a push-out along the
  DE gradient enforces the clearance. You can dive into ever finer detail, fly into holes and
  out again, and never clip.
* **Hyper** (RMB): `hyper` ramps 0 → 1 over 1.6 s (decays in 1 s). The speed multiplier grows up
  to ×40, still collision-safe. On its own, RMB means "go forward". `betaVis = 0.9 × hyper`; FOV
  widens up to +18°; a tiny shake is added.
* **Gentle nebula gravity:** an idle ship inside a nebula's influence drifts toward it
  (`def.gravity × 0.12 × local cruise`), stopping at 1.25 × bound. **Soft universe edge:**
  beyond 1.5 × the catalogue radius, outward motion fades out (gone by 2.5×), and an idle ship
  drifts home.
* **Co-rotation:** inside a spinning nebula's bound sphere, the ship is carried with the rotation.
* **Black holes** (`BLACK_HOLE`): pull `4.4 · rₛ / x²` (x = r/rₛ) bled by a 2.5 s dampener. That
  is gentle at 10 rₛ, beats throttle-1 cruise at ~3 rₛ, and beats full hyper only inside ~1.3 rₛ.
  Spin adds frame-dragging acceleration and a slow twist of the view. `timeDilation` is
  `1 − influence·(1 − √(1 − rₛ/r))`. `tidal` rises from 4 rₛ to 1 rₛ. `blackHoleId` is set
  within 10 rₛ. `horizonWarning` fires once when you enter 2.5 rₛ and re-arms beyond 4 rₛ.
* **Capture** at r < 1.02 rₛ → **wormhole** (`TUNING.wormholeSeconds` = 5 s). Controls lock and
  `progress` runs 0 → 1. At 0.5 the ship teleports to `blackHole.wormholeTo`: 2.2 × render
  radius from a fractal nebula (4 × worldRadius for a black hole), capped at 0.75 ×
  influenceRadius, on the side between its key light and home. It faces the nebula and glides
  out gently. Events `wormholeStart` and `wormholeEnd` fire. The exit hole cannot recapture you
  for 6 s. A transit never starts behind the pause menu, and it waits while paused.
* **Targeting** (LMB): `universe.pick` from the reticle → `targetLock`; empty space → `targetClear`.
  A new lock during a target glide re-routes the glide.
* **Space tap = Resonance Pulse.** A spherical wavefront expands from the ship (ease-out) to
  6 × surfaceDistance over 4.5 s, so it is visible at any zoom. It lights structure and gas as it
  passes, and HUD markers reveal every nebula for 10 s. Emits `pulse`.
* **Space hold = Gravity-Glide** to the locked target (else the nebula under the reticle, else the
  nearest). The glide turns, eases in (with a long-distance boost up to ×10), decelerates, and
  arrives at 2.5 × render radius (capped at 0.72 × influence, so arrival enters the region) for a
  slow cinematic orbit. **T = Voyage:** a tour through every nebula, black holes included
  (orbit 2 × render radius, black holes 4 × worldRadius), ~40 s each, always heading for the
  nearest unvisited stop. The glide detours around obstacles and threads its way out of
  structure. Movement input or hyper cancels the autopilot, and T toggles voyage off.
* Regions use hysteresis (enter > 0.35 influence, exit < 0.15, switch margin 0.15) →
  `regionEnter` / `regionExit`.
* The wheel scales the throttle ×1.25 per notch, clamped to 0.05..4.
* All events are silent in attract mode. Resets close every open event pair first
  (`wormholeEnd`, `autopilotEnd`, `hyperEnd`, `targetClear`, `regionExit`), so listeners never
  keep a stale status.

### 3.7 Audio — `src/audio/AudioEngine.ts` (+ `MusicDirector.ts`, `Deck.ts`, `profiles.ts`, `motifs.ts`, `layers.ts`, `Sfx.ts`, …)

```ts
export class AudioEngine {
  start(): Promise<void>;        // from a user gesture: Tone.start(), build the graph, subscribe to bus events
  update(state: SimState): void; // per frame; arithmetic only, AudioParams touched ≤ 30 Hz
  setVolumes(music: number, sfx: number): void;   // perceptual (power 1.5) curves
  toggleMute(): boolean;         // music only; returns muted
  setPaused(p: boolean): void;   // duck music ×0.35 and darken it (low-pass 1.1 kHz); SFX carry on
  readonly musicProfile: string | null;
  dispose(): void;
}
```
Signal flow: decks → music dry/wet → low-pass → swirl auto-panner → out, plus a shared
**procedural convolution reverb** (dark, low-pass-decaying tail, RT60 ≈ 9 s). Sfx dry/wet go to
the same reverb. The master chain is a warmth high-shelf → 22 Hz high-pass → glue compressor →
hard-knee limiter at −1 dBFS.

* **Score.** A generative, never-repeating profile per nebula id plus `void` (§5). Each profile
  holds a key, mode, tempo, meter, a Markov chord graph and layers (pads, drone, noise textures,
  heartbeat, Shepard scale, and melodic motifs whose rules echo the fractal's mathematics:
  `arp8`, `cantor`, `halving`, `golden`, `canon`, `fork`, `crystal`, `gliss`, plus the
  call-and-response `walk`, bells, tolls and sparkles).
* **MusicDirector:** two decks with an equal-power crossfade. Instruments are built on demand
  and disposed once silent, so at most two profiles exist at a time. Each deck keeps its own
  tempo and clock. Scheduling runs on Tone's worker-driven context tick with a 0.4 s lookahead,
  so music survives background tabs and render hitches.
* **Profile choice.** **Changed** from "cross-faded by `state.env.weights`". The dominant nebula
  (influence > 0.22, held down to 0.12) must persist for 1 s, then the score crossfades over
  7 s. During a wormhole the key changes inside the swirl, and the exit uses a 3.5 s crossfade.
* **Time dilation:** tempo × `timeDilation` (≥ 0.4) and up to −700 cents of detune at the
  horizon. The wormhole bends pitch further. Tidal stress closes the music low-pass and hyper
  opens it slightly.
* **SFX** (always in the current key, soft and reverberant): engine hum (brown noise + two low
  sines + a whine that rises with hyper), hyper whoosh and Shepard–Risset riser, target-lock FM
  bell arpeggio, pulse sonar ping + harmonic bloom, region-enter shimmer, horizon heartbeat
  swell (no alarm beeps), wormhole sweep → arrival chord, autopilot confirmations.

### 3.8 HUD — `src/hud/Hud.ts` (+ CSS in `src/styles/`)

```ts
export interface HudOptions {
  nebulae: NebulaDef[];
  codex: Record<string, CodexEntry>;
  settings: AppSettings;
  onLaunch: (quality: QualityName) => void;
  onResume: () => void;
  onSettingsChange: (s: AppSettings) => void;
}
export class Hud {
  constructor(root: HTMLElement, opts: HudOptions);
  update(state: SimState, nebulae: NebulaRuntime[], camera: THREE.PerspectiveCamera,
         stats: { fps: number; renderScale: number }): void;
  setLoadingProgress(p: number, label: string): void;  // start screen (shader compilation)
  setLoadError(message: string): void;                  // renderer failed to start
  setReady(): void;                                     // enable Launch
  hideStartScreen(): void;
  showPause(show: boolean): void;
  setResumeState(state: 'idle' | 'pending' | 'failed'): void;   // pointer re-capture feedback
  setVisible(v: boolean): void; toggleVisible(): void;
  toggleCodex(): void;
  flashMessage(text: string, kind?: 'info' | 'warn'): void;
  dispose(): void;
}
```
* **Performance model.** All DOM is built up front, including the marker pools. Per frame only
  transforms and opacities are written, and only on change. Text refreshes at ~15 Hz. Layout
  reads happen first in `update()`, so they never force a synchronous layout.
* **SimState is the source of truth.** Bus events only make changes feel immediate.
  `reconcile()` re-syncs the target, autopilot and pending-region status every frame, so a missed
  event can't leave a stale display. Nothing is shown before launch.
* **Elements:**
  * Location (top-left): region or void, catalogue number, type line `label · D≈…`, surface or
    horizon distance, zoom gauge.
  * Speed (bottom-centre): the headline switches km/s → AU/s → ly/s, with c, mph and AU/s below,
    a log throttle bar, precision, hyper and β, and an autopilot chip.
  * Environment (bottom-left): gravity, time dilation, tidal stress and wormhole progress.
  * Reticle, target brackets with distance, ETA and light-time (an edge chevron when
    off-screen), and pulse markers.
  * Codex card (right): auto-opens on a target lock or the first entry into a region (never in
    the first 4 s after launch) and auto-hides after 12 s. Tab or I pins it, then closes it.
    Long entries scroll themselves like a teleprompter, and the facts rotate.
  * Region banner, flash queue, one-time physics tips, void facts (every ~50 s in the void),
    first-minute controls hints, and a faint fps / resolution readout.
* Start screen: title over the live attract render, quality cards, a progress bar naming each
  compile group, and Launch (Enter). Pause screen: Resume (Enter), live settings and the full
  controls table from `controls.ts`.

### 3.9 Content — `src/content/`

```ts
export const CODEX: Record<string, CodexEntry>;  // one per catalogue id; title = catalogue name
export const VOID_FACTS: string[];               // 41 short facts, each ≤ 180 characters (void ticker)
export const PHYSICS_TIPS: Record<'hyper'|'aberration'|'lensing'|'timeDilation'|'wormhole'|'pulse'|'scale', string>;
```
Figures are **derived from the live catalogue and fractal registry** at module load (`astro.ts`),
so the text stays true when the universe is retuned:
* Sizes use `worldRadius / boundRadius` × each shape's local extent. The Menger cube side,
  Mandelbox cube side, Sierpiński height and the Apollonian/Kleinian ball width are exact; the
  bulb, Julia, KIFS and tree give their bounding diameter ("up to"). The gas halo
  (`haloFactor`) is deliberately **not** counted as nebula size.
* Black-hole figures come from `rs` and `spin`: mass (rₛ = 2GM/c²), Kerr horizon, prograde ISCO
  (Bardeen–Press–Teukolsky), radiative efficiency, shadow size, Hawking temperature and
  evaporation time.
* The Julia veil's position relative to the Mandelbrot set is found by sampling its animation
  loop, and the Mandelbulb's power range the same way.
* The catalogue diameter range and voyage extent feed the void facts.

Anything uncertain is phrased "about", "roughly" or "reported". The music notes describe what
`src/audio/profiles.ts` and `motifs.ts` actually play; keep them in sync when a profile changes.

---------------------------------------------------------------------------------------------

## 4. Controls (as bound in `src/ship/Input.ts`)

| Input | Action |
|---|---|
| Mouse | Look (pointer lock, raw movement where supported) |
| W / S | Thrust forward / reverse |
| A / D | Strafe |
| R / F | Rise / sink |
| Q / E | Roll |
| Shift | Precision (×0.2) |
| Wheel | Cruise throttle (×1.25 per notch, 0.05–4) |
| **Left mouse** | Target the nebula under the reticle → name, distance, ETA, light-time, codex; empty space clears |
| **Right mouse (hold)** | Hyper acceleration (aberration, Doppler, star streaks); alone it drives forward |
| **Space (tap)** | Resonance Pulse: the wave lights up structure and reveals all nebulae for 10 s |
| **Space (hold ≥ 0.35 s)** | Gravity-Glide autopilot to the target (or the nebula under the reticle, or the nearest) |
| T | Voyage (zen auto-tour); T again stops it |
| Tab / I | Codex card: open and pin → close |
| H | Hide / show HUD (cinematic) |
| M | Mute / unmute music |
| Esc | Pause & settings (the browser releases pointer lock) |
| Enter | Launch (start screen) · Resume (pause screen) |

The same list drives the HUD (`src/hud/controls.ts`: start-screen summary, first-minute hints,
pause-screen table). Any change here must be mirrored there and in the README.

---------------------------------------------------------------------------------------------

## 5. Music profiles (`src/audio/profiles.ts`)

| id | Title · character | Key · mode · tempo | Signature layers |
|---|---|---|---|
| void | Interstellar Void · vast, sparse | D Aeolian (sus2/add9 colours) · 50 bpm | soft pad, sub drone with fifth, band-passed noise, rare distant bells |
| bulb | Organic Bloom · warm, blooming | D Lydian · 64 bpm | warm analog pads, 8-step marimba arpeggio (power 8) that mutates, flute call & response |
| menger | Ternary Lattice · crystalline, the number three | C♯ minor pentatonic · 3/4 · 72 bpm | glassy plucks on a Cantor-set rhythm (27 triplet steps, middle thirds removed), resonant pedal |
| box | Vaulted Cathedral · architectural | A Dorian · 56 bpm | organ + choir pads, pedal sub, rare deep bell tolls, heavy hall reverb sends |
| julia | Four-Dimensional Veil · ethereal | E♭ Lydian augmented · 60 bpm | detuned choir, harp glissandi through whole-tone steps, shimmer |
| sierpinski | Golden Pyramid · self-similar | A major pentatonic · 80 bpm | FM bells in fifths/octaves; Pascal's triangle mod 2 as rhythm at 1, ½, ¼ scale |
| apollonian | Pearl Foam · bubbly, pearly | F Dorian · 66 bpm | glass pad, FM bells on Fibonacci-word (golden-ratio) timing, pearly bubbles |
| kleinian | Indra's Net · reflections | B Dorian · 58 bpm | canon → retrograde → inversion between bell and celesta, ping-pong echoes |
| kifs | Frost Kaleidoscope · cold, symmetric | E Lydian (maj9) · 76 bpm | celesta arpeggios six up, mirrored back down; high shimmer; icy hiss |
| tree | Branching Lightning · electric | G Mixolydian · 70 bpm | electric-piano lines that fork into two voices and rejoin; distant thunder |
| bh-eye | Frame Dragging · being pulled | B Phrygian · 48 bpm | auto-panned dark pads, endlessly descending Shepard scale, pedal sub |
| bh-maw | Schwarzschild Abyss · deep fire | C minor, Locrian hints (Neapolitan D♭) · 40 bpm | octave-doubled sub drone, low brass swells, slow heartbeat, sparse bells |

---------------------------------------------------------------------------------------------

## 6. Catalogue (`src/universe/catalog.ts`)

Eleven nebulae; `scale = worldRadius / boundRadius`. **Changed:** every fractal nebula uses
`haloFactor` **2.5** (the gas envelope extends to 2.5 × the fractal bound). The types.ts comment
"typically 1.4–2.0" predates the art pass. Black holes use `haloFactor` 1, because their
`worldRadius` already is the lensing sphere.

| id | Name | Catalogue | Fractal | worldRadius (ly) | influenceRadius (ly) | Notes |
|---|---|---|---|---|---|---|
| bulb | The Cauliflower Nebula | FN-0008 | mandelbulb | 45 | 150 | nearest to the start |
| menger | The Menger Lattice | FN-0020 | menger | 50 | 160 | star at the centre of the lattice |
| box | The Cathedral Nebula | FN-0177 | mandelbox | 55 | 170 | param override: lower emission threshold |
| julia | The Julia Veil | FN-0411 | julia | 42 | 140 | exit of The Maw's wormhole |
| sierpinski | Sierpiński's Pyramid | FN-1915 | sierpinski | 48 | 150 | |
| apollonian | The Pearl Foam | FN-0270 | apollonian | 45 | 150 | spins (0.002 rad/s) |
| kleinian | Indra's Web | FN-1897 | kleinian | 60 | 180 | |
| kifs | The Frost Kaleidoscope | FN-0006 | kifs | 40 | 140 | spins (0.003 rad/s); the one behind the start |
| tree | The Lichtenberg Nebula | FN-1618 | tree | 55 | 170 | |
| bh-eye | Ouroboros | FN-∞2 | Kerr, χ = 0.9, Julia disk, jets | 60 (rₛ = 3) | 200 | wormhole → bulb |
| bh-maw | The Maw | FN-∞1 | Schwarzschild, Mandelbrot disk | 90 (rₛ = 5) | 260 | wormhole → julia |

Palettes, lights and look constants (`NEBULA_LOOK`) are art-directed. Change them only on purpose.

---------------------------------------------------------------------------------------------

## 7. Quality presets (`src/app/config.ts`)

| | Low | Medium | High (default) | Ultra |
|---|---|---|---|---|
| renderScale min–max | 0.30–0.60 | 0.40–0.75 (0.35 with TAAU) | 0.50–0.90 (0.45) | 0.65–1.00 (0.60) |
| TAAU | off | on | on | on |
| targetFrameMs | 16.7 | 16.7 | 16.7 | 16.7 |
| marchSteps | 90 | 130 | 170 | 240 |
| iterScale | 0.7 | 0.85 | 1.0 | 1.25 (capped by `FRACTAL_MAX_ITER`) |
| shadows / shadow steps | – | – | ✓ / 11 | ✓ / 16 |
| aoSamples | 0 | 3 | 4 | 5 |
| skyCubeSize | 1024 | 1536 | 2048 | 2048 |
| far / local stars / dust | 1200 / 2500 / 1200 | 2000 / 4000 / 2000 | 2800 / 6000 / 3000 | 3600 / 8000 / 4000 |
| black-hole disk iterations | 28 | 36 | 44 | 56 |

---------------------------------------------------------------------------------------------

## 8. Tooling & packaging

* `npm run dev`: Vite on **port 5190 with `strictPort`** (a busy port is an error, not a silent
  move). `npm run build` runs `tsc --noEmit` and then `vite build` (target ES2022, `base: './'`
  so `dist/` works from any path). `npm run preview` serves on port 5191.
* `tsconfig.json` type-checks `src/` and `vite.config.ts` with `noEmit`. A stray `tsc` must never
  write `.js` next to the sources, because Vite would resolve those before the `.ts` files.
  `tools/` runs through `tsx` (Node types are not installed, so it is not type-checked).
* `start.bat` (Windows): runs from its own folder (any path, including spaces and parentheses)
  and checks for Node.js ≥ 20.19 / 22.12 and npm. It installs dependencies on the first run (or
  again when npm's `node_modules/.package-lock.json` completion marker is missing) and checks
  port 5190. If Fractal Nebulae is already running there, it just opens the page;
  otherwise it explains how to find the process. Then it starts `vite --open`, so the browser
  opens once the server is ready. Every failure path pauses so the message stays readable.
* `tools/glsl-check.ts` validates GLSL offline (three r186 prefix emulation, glslangValidator).
  `tools/check-all-shaders.ts` runs it over every program built by the real factories (nebulae,
  black holes, sky, star sprites, bloom, TAA, composite) for all four presets, optionally
  filtered by a name fragment, and fails on a `glslVersion`, a hand-declared location-0 output
  or a `#version` line. `tools/check-contracts.ts` covers only the shared GLSL contracts and
  `tools/_lead_check.ts` only the nebula materials at High. `tools/cpu-render.ts` makes CPU
  previews of the JavaScript DEs.
  `tools/devtools.js` is a dev-only console helper
  (`await import('/tools/devtools.js').then(m => m.setup())`, needs `window.__app`).

---------------------------------------------------------------------------------------------

## 9. Changes from the original spec

* **GLSL version:** no `glslVersion` on any ShaderMaterial (§0). `tools/glsl-check.ts` emulates
  the r186 prefix.
* **TAAU added:** jittered scene (`uJitter` in the camera uniforms, used by every full-screen
  scene pass), a full-resolution temporal resolve with reprojection by log depth and nebula
  frame, a sprite layer outside the history, and a lower dynamic-resolution floor with TAAU. It
  is on by default except on Low.
* **Dynamic resolution** also listens to a GPU timer, because frame intervals alone cannot show
  headroom on a display that pins them.
* **Contract additions:** `Renderer.syncCamera`, `Renderer.taaEnabled`; `Input.onLockChange(locked,
  failed)`; `Simulation.setTarget` and `resetToStart`; `Universe.indexOf`;
  `Hud.setLoadError`, `Hud.setResumeState`, `Hud.dispose`; `AudioEngine.musicProfile`.
* **Pointer lock** gets a cooldown-aware Resume, a refused/timeout path back to the pause
  screen, and a click-to-recapture fallback. Settings are sanitised on load.
* **Catalogue:** `haloFactor` 2.5 for all fractal nebulae, art-directed palettes and lights. The
  Mandelbulb's emission is now sparse orbit-trap **knots** instead of plane-trap filaments.
* **Fractal iterations:** `FRACTAL_MAX_ITER = gpuIter = cpuIter` for escape-time fractals, and
  the GPU never runs fewer than `max(gpuIter, cpuIter)` near structure (§3.4, §3.1).
* **Music:** a dominant-region choice with dwell and a 7 s two-deck crossfade replaces weight
  blending. Motifs encode each fractal's mathematics (§5). The Mandelbox profile's
  "~14 s cathedral reverb" became heavy sends into one shared ~9 s procedural hall.
* **Black holes:** Schwarzschild geodesics plus a gravitomagnetic spin term instead of full Kerr
  (stated in the codex). Exit placement is capped by influence so the exit glide enters the
  region.
* **Flight:** fixed-step physics substeps (≤ 1/55 s), a sphere-traced integrator with an
  approach limiter, a soft universe edge with home drift, a wormhole exit immunity limited to
  the exit hole, and autopilot obstacle avoidance and structure navigation.
* **Audio at a fixed 48 kHz** (2026-09-28 bug fix): the context is created inside the launch
  gesture as `AudioContext({ sampleRate: 48000, latencyHint: 'playback' })`. At the device rate
  (192 kHz on the target machine) the score needed 4× the DSP and the audio thread fell to ~60 %
  of real time → silence.
* **Navigation rework** (user feedback): manual-flight speed scales with the free path along the
  thrust (not only the nearest-surface distance); blocked moves slide along surfaces; nebula
  breathing slows near structure (`Universe` animation clocks, guarded near the ship). The
  resulting cruise scale is **log-smoothed** (~0.6 s rise, time-to-contact braking) so speed is
  uniform inside structure, with a hard brake cap along the thrust (`FLIGHT.brakeTtc`: never
  faster than covering the free path in 1.5 s → no sideways skid) and the instant rule restored
  within a few clearances of a surface (`FLIGHT.cruiseSafe*`). The wall approach limiter has a
  soft knee. `SimState.env.flightScale` (the smoothed scale) drives the dust motes and the engine
  sound; the nebula glow length follows a log-smoothed camera distance — so perceived speed is
  steady too.
* **Ghost mode** (user request): holding right mouse (with hyper) turns collisions off —
  no approach limiter, trace, slide, push-out or brake cap — so the ship phases through
  structure. In contact with a solid (raw DE < `FLIGHT.ghostContact` × clearance) hyper fades out
  (`ghostHyperDecaySeconds`), the ship sheds speed quickly (`ghostDragTau`) and the ghost scale
  follows the wall thickness ahead (`Universe.exitDistance`: along the travel direction until the
  ray is out in open space, clear by 20 % of the distance travelled, so a rough skin's pits don't
  count) × `ghostExitGain` — any wall takes ~2–3 s — floored at 20 clearances, capped at 0.5 ×
  bound, rising only during a pass, with a ×3/s spool as the progress guarantee. Contact flickers
  shorter than `ghostPassGap` are one pass. Outside, the ghost speed is a floor under the
  (brake-free) directional speed, not multiplied by hyper. Releasing RMB mid-wall keeps ghost on
  and carries the ship along its last direction until clear (`ghostClear` × clearance).
  `SimState.ship.ghost / ghostInside / ghostClip` drive the nebula x-ray (`uGhostClip`, 3 × the
  ghost floor): a ray that starts inside a solid, or runs into one within that radius, sees
  through it until it is back in open space (same criterion as the probe); a faint glassy sheet,
  rim-bright at grazing angles, marks where it left the solid, so the body keeps a glowing
  silhouette; everything beyond renders normally. Plus the composite phase-shift look
  (`uGhost`), the HUD ghost line and a music low-pass. Normal flight (no RMB) keeps every
  collision guarantee.
* **Full screen** (`src/app/Fullscreen.ts`): `AppSettings.fullscreen` (default on) → Launch enters
  full screen with the pointer lock and audio in the same gesture; F11 / Alt+Enter and the start /
  pause switches toggle it. In full screen Esc is claimed with the Keyboard Lock API, so it only
  pauses (Input releases the pointer itself) and the pause menu stays full screen; holding Esc
  exits (browser safeguard).

---------------------------------------------------------------------------------------------

## 10. Game modes and First Light (added 2026-10-02/03)

The design hand-offs are in `design/` (README, `10-platform.md`, `20-first-light.md`); the build plan,
ownership and the decisions that refined them are in `design/60-first-light-build.md`. This section
describes what was built.

### 10.1 Mode shell

* **Contract** `src/game/platform/GameMode.ts`: `GameMode` (`enter`, `update(dt, input, state, paused)`,
  `exit`, optional `onCursorModeChange`, `onPause`, `pauseActions`, `onEscape`) and `ModeContext` (sim,
  audio, hud, a DOM `layer`, the canvas, `settings()`, the `overlay`, `cursorMode`, `requestFlight()`,
  `requestFreeCursor()`, `pause()`, `switchMode()`). Registry and URL / `localStorage` choice:
  `src/game/modes.ts` (`?mode=firstlight`; `VITE_MODES` can hide modes in a build; switching to the
  Voyage drops the mode's `level` / `daily` parameters).
* **The Voyage is "no mode"** (`App.mode === null`); every shell addition is inert then (verified with
  the flight harnesses, byte-identical output).
* **Frame order:** `input.poll → sim.update → mode.update → audio → render → hud`. In a mode the App
  still handles H and M, but not Tab / I.
* **Cursor modes.** `requestFreeCursor()` releases pointer lock *without* pausing (an "expected unlock"
  window), Esc in free-cursor flight pauses (`InputFrame.escape`), Resume returns to the cursor mode
  the pause began in, and a refused lock coming from free stays free and tells the mode. A lock granted
  after the mode already went free or paused is handed back.
* **Input additions:** `buttons / pressed / released` bitmasks, `pointer` (free cursor, CSS px),
  `keyDown / keyPressed(code)`, `mods`, `escape`; `setFreeCursorActive`, `setModeKeys`, `releaseLock`.
* **Simulation additions:** `setControlPolicy` (hyper, targeting, pulse, glide, voyage, wheel → throttle,
  fixed throttle), `setArena` (soft bounds in a nebula's local frame: outward motion fades between
  1.0 and 1.5 R, idle drift home), **puppet mode** (`setPuppet`, `setPuppetPose(pos, quat, ghostClip)`,
  `teleport`) and `firePulseAt(origin, radius, gain)`. The pulse has a `gain` (`SimState.pulse.gain`,
  1 in the Voyage) that First Light lowers: a full-strength wavefront inside dense arena gas washes out
  the whole view.
* **Puppet instead of a separate view.** The lab-view orbit camera and the cinematic arena entry move
  the *ship* (collisions and input suspended, velocity derived from the pose change). Renderer, HUD
  markers, stars, dust, TAA and audio already follow the ship, so the render path did not change.
  `ghostClip` gives the overview camera the existing x-ray into structure.
* **Universe:** `setFrozenClock(id, clock)` pins a nebula's animation (params = `animate(base, clock)`,
  bit-identical to `world.ts frozenParams`, which the Node tools use), so arenas hold still and the
  tracer, the GPU and the authored solutions agree.
* **HUD:** `setGameMode(id)` hides the Voyage instruments (speed, location, environment, void facts,
  target brackets, first-minute hints, banners) and the codex auto-open; `createModeLayer()`,
  `setPauseMode(actions, controls)`, `flashMessage(text, kind, label)`. The start screen has mode cards;
  the pause screen shows mode actions, a mode switch and per-mode controls.

### 10.2 First Light

* **Physics** (`Geodesic.ts`, `BeamTracer.ts`, pure TS, no three.js, shared by the browser and Node):
  the Cartesian Schwarzschild null geodesic of the black-hole shader, `a = −1.5 ρ h² p/|p|⁵`, superposed
  over point masses (an approximation, documented), integrated kick-drift-kick near masses. Capture
  inside the photon sphere (1.5 ρ, moving inward), DE-gradient reflection off Pearl Foam / Indra's Web
  surfaces (×0.7 per bounce; seeds need 0.3), absorption elsewhere, exact segment–sphere seed tests,
  echo seeds, decimated polylines. Deflection matches the exact Schwarzschild value within 0.4 % for
  b = 10–200 ρ; the capture threshold lands at 1.0004 b_c. A trace takes ~0.1–0.5 ms.
  The results are deterministic (positions are quantised to 1e-6 local).
* **Levels** (`types.ts`, `Level.ts`, `levels/*.ts`, `chapters.ts`): JSON-friendly data in a nebula's
  local frame (arena, vantage, source, seeds, ρ per size, budget, a known solution, hints, teach line,
  tip, par). There are three chapters, Bend (bulb), Thread (menger) and Reflect (apollonian), with six
  levels each.
* **Gates** (`Solver.ts`, `tools/fl-check.ts`). Every level must pass all of these:
  * the unlensed beam fails;
  * the solution works and is legal;
  * it is minimal (heuristic search over smaller budgets);
  * accidental solutions are under 1 %;
  * robust under 5 %-ρ jitter (≥ 90 %);
  * tolerant under ±0.6 % R view-plane jitter (≥ 70 %);
  * click-reachable: the game's own placement code run from the vantage (`Reach.ts`, shared by `tools/fl-reach.ts` and the Generator);
  * path length and bends are in range;
  * the arena's DE is reliable;
  * the vantage is in free space.

  `placementIssue()` is the single legality rule for the game and the gates.
* **Generator / daily** (`Generator.ts`, `Reach.ts`, `DailyGen.ts`, `dailyArenas.ts`):
  * **Generation:** seeded forward design inside 43 curated arenas across all nine fractal nebulae. It is click-aware: every mass is authored where the click aimed beside its beam lands from the vantage (in the view plane, at the beam-snap depth), so each bend reads as a sideways turn. Every daily then passes the quick reach gate (`Reach.quickReach`: the full gate's plain clicks, flood-filled from the aim) and the solver gates.
  * **Schedule:** UTC weekday tiers (Mon–Tue one mass … Sat three, Sun a harder arena).
  * **Delivery:** the next 400 days ship pre-generated as monthly JSON bundles in `public/daily/firstlight/`, and `loadDaily` falls back to identical runtime generation. In the browser that fallback runs in a module worker (`dailyClient.ts` → `dailyWorker.ts`), so a Saturday's seconds of generation never stall rendering, input or the score; without `Worker` support it generates on the main thread.
* **The mode** (`FirstLightMode.ts` with `Placement.ts`, `LabView.ts`, `OverlayFeed.ts`, `Ceremony.ts`,
  `progress.ts`):
  * **States:** Atlas → entering (fade, frozen clock, puppet glide to the vantage) → playing (flight ⇄ lab view) → ceremony → solved.
  * **Placement:** beam-depth snap (`PLACEMENT.snapFrac`), wheel depth, grab / drag, 50-deep undo.
  * **Retrace:** full on commit, coarse at ≤ 20 Hz while dragging.
  * **Saving and helpers:** progress, daily streak and seen tips via `platform/save.ts`; hints in three steps; first-time physics tips.
  * **Dev hook:** `window.__fl` in dev builds.
* **HUD** (`hud/FirstLightHud.ts`, `PlayHud.ts`, `AtlasPanel.ts`, `SolvedPanel.ts`, `firstlight.css`):
  * DOM only, in the Voyage's visual language.
  * `setPlay` diffs its input, so per-frame calls cost no DOM writes.
  * The Atlas is keyboard-navigable.
* **Audio** (`src/audio/GameAudio.ts`), always in the current key:
  * place, grab and remove cues;
  * seed notes that climb the scale through a chapter;
  * capture, reflection, and a ~3 s ignition built from the nebula's motif;
  * a quiet beam hum, with parameters updated at ≤ 30 Hz.

  Fixed along the way: Tone's `disconnect` from a Param cut every Voyage SFX voice off the score's detune (`DetuneSignal` in `Sfx.ts`).

### 10.3 Game overlay rendering

* **Contract** `src/render/game/overlayTypes.ts`: an `OverlayFrame` of plain buffers in one nebula's
  LOCAL frame: lines, glyphs, stars, lenses (≤ 8) and accents (≤ 4). The mode mutates it in place;
  `Renderer.setOverlay()` hands it to the renderer.
* **Sprite stage:** `GameOverlayRenderer` converts local → world → camera-relative in doubles every
  frame (allocation-free), then draws:
  * camera-facing beam ribbons with exact per-fragment log depth and flowing pulses;
  * SDF glyphs;
  * spiked star sprites.

  Everything is drawn twice: visible parts (`LessEqual`) at full strength, parts behind structure
  (`Greater`) × `occludedAlpha`, so the beam reads through walls. The overlay always goes to the
  separate sprite layer (`spriteRT`), even with TAA off, so the lens warp never bends or blacks out
  beams. Its programs compile during loading (a "Game overlay" group). On frames with lenses and TAA,
  the near stars, dust and nebula key stars go to their own layer (`nearRT`, sharing the scene depth),
  which the composite samples at the lensed position and blacks out inside shadows like the scene;
  `LayerSumPass` adds `nearRT` + `spriteRT` into one texture so bloom keeps a single sprite input. Frames
  without lenses (the whole Voyage) take the old path.
* **Point-mass lenses** (composite, `postShaders.ts`):
  * **Projection:** the renderer projects each lens to a `ScreenLens`, and `CompositePass.setLenses` uploads `uLensA/B[8]` plus the scene depth texture.
  * **Warp:** each output pixel behind a lens samples the scene and bloom at β = θ − θ_E²/θ, with θ_E² ∝ (D_s − D)/D_s from the pixel's own depth (sky = ∞), times the lens strength (a placed mass 1 once the arena is revealed, the placement preview 0.45; it fades as the camera nears the capture sphere). The warp is exact inside 2 θ_E and windowed to zero at 4 θ_E (`PP_LENS_WIN_IN/OUT`); the sample offset is clamped to 3 θ_E.
  * **Einstein radius:** θ_E is 0.55 × the physical √(2ρ/D) (`LENS_EINSTEIN_GAIN` in `GameOverlayRenderer.ts`): the full ring bends ~4.7 shadow radii of nebula around every mass and hides the puzzle, 0.55 keeps it clearly lensed (~2.6). The tracer's physics are unchanged.
  * **Shadow:** inside the capture radius (2.598 ρ) the pixel is black, with a thin warm photon rim. Both radii are exact on-axis; their off-axis growth D/viewZ is capped at 1.5 (`LENS_OFFAXIS_MAX`, ≈ 48° off-axis), so a mass beside the camera cannot warp the whole view.
  * **Cost:** zero when no lenses are present.
* **Accent lights** (`NebulaMaterial`): `uAccentPos/uAccentCol[4]` for the overlay's nebula only.
  * **Surfaces:** wrap-diffuse with a smooth falloff and a little rim pickup.
  * **Gas:** a closed-form glow integrated along the visible part of each view ray, never a per-step light loop. `NEBULA_LOOK.accentGas` is 0.06 (a subtle halo; the glow glyph carries the rest).
  * **Cost:** ≤ 1 % of the nebula pass.

### 10.4 Testing

`npm run check:game` (tracer, platform, all levels, the daily bundles, puppet) and `npm run check:shaders`
run before every deploy. The bundle guard is `tools/fl-daily-check.ts --fast`: all window days present,
canonical and on `dailyInfo`'s nebula (a schedule change would otherwise send every visitor to the
runtime generator, seconds per day), at least 60 bundled days ahead of today (the 400-day
window ends 2027-11-05), and the loader paths with two tier-1 runtime regenerations that must equal the
bundle. The full `fl-daily-check` (gates and regeneration of a sample) and `fl-reach --dailies` stay
manual after a Generator change. The built-in browser pane refuses pointer lock and throttles rAF;
`tools/devtools.js` `fakeLock()` + `flRig()` (`__playLevel`, `__aim`, `__click`, `__key`, `__run`) drive
the real input path there; `__shot(name)` saves a canvas JPEG through the local receiver
`tools/shot-receiver.mjs` (`npm run shots`).
