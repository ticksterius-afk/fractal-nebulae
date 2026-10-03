# 60 — First Light v1 "First Playable": build plan and work packages

*Written 2026-10-02 by the lead for the implementing agents. Read `design/README.md`,
`design/20-first-light.md` (the game) and `ARCHITECTURE.md` §0 first; this document says what v1
contains, which design-doc rules it adopts or changes (and why), the contracts, and who owns which
files. Contracts live in code: `src/game/platform/GameMode.ts`, `src/game/firstlight/types.ts`,
`src/game/firstlight/hud/hudTypes.ts`, `src/render/game/overlayTypes.ts`.*

---

> **Status (2026-10-03): built.** All packages in §3 are implemented and reviewed; ARCHITECTURE.md §10
> describes the result, and README.md has the player-facing guide. Changes after this plan was written:
> * **Click-reachability gate.** Playtests through the real input path showed that the gates measured
>   precision only at the authored depth. A click lands at the beam's depth instead, so a
>   click-reachability gate (the game's own placement code, run headless from the vantage) joined
>   `tools/fl-check.ts`.
> * **Click-aware dailies.** The Generator authors every mass where the click aimed beside its beam lands
>   from the vantage (view plane, beam-snap depth), and every daily passes the same reach rule
>   (`src/game/firstlight/Reach.ts`, shared with `tools/fl-reach.ts`).
> * **Snap reach** grew from 0.12 to 0.2 of the viewport height.
> * **Lab framing** may start below the arena, from the vantage's side.
> * **Pulse gain.** Pulses in arenas use a `gain` (0.3–0.35), so they don't wash out the gas.
> * **Accent-light gas halo** dropped to 0.06.
> * **Lens size.** The physical Einstein ring bent so much nebula that it hid the puzzle: θ_E is
>   0.55 × the physical value (`LENS_EINSTEIN_GAIN`), the shadow stays the exact capture radius on-axis,
>   the off-axis growth of both radii is capped at 1.5 (`LENS_OFFAXIS_MAX`), and the warp is windowed
>   to zero at 4 θ_E instead of ~5 (§P, #7). The tracer's physics are unchanged.
> * **Built-in physics tips** became practical rules of thumb; the levels' own tips carry the history.
> * **CI.** `npm run check:game` runs before every deploy, including a fast guard of the daily bundles
>   (`tools/fl-daily-check.ts --fast`: complete, valid, on schedule, ≥ 60 days ahead of today).

## 0. Scope of v1

v1 is milestone **M1 + M2** of the design README, playable in the browser:

* A **mode shell**: start-screen mode cards (Voyage / First Light), `?mode=firstlight`, free-cursor
  state without pausing, per-mode controls and pause actions. The Voyage is unchanged.
* **First Light** with **chapter 1 "Bend" (The Cauliflower, 6 levels)**, **chapter 2 "Thread"
  (The Menger Lattice, 6 levels)** and **chapter 3 "Reflect" (The Pearl Foam, 6 levels)** — all
  three open at once, as the design says. Each level passes the solver gates.
* The **free daily** (runtime-generated from the UTC date, validated for 400 days by a harness),
  with the Wordle-style share string and a local streak.
* An **Atlas** panel (level select with progress, ✦ marks, daily card), a 3-step opt-in **hint
  ladder**, the **ignition ceremony**, **audio cues**, local **save**.
* Rendering: beam ribbons, SDF glyphs, spiked star sprites for sources and lit seeds, a real-looking
  **point-mass gravitational lens** (screen-space warp + black shadow + photon rim) for every placed
  mass, and **accent lights** so lit seeds and the beam's endpoint light up the fractal around them.

Out of v1 (later): echo-chain chapters 4–5 content (the tracer supports echoes already), veils/hue
(ch. 6), kaleidoscope folds (ch. 7), aimable sources (ch. 8), black-hole chapters (10–11), Deep
variants, plate mode, Electron, achievements, lit stars persisting in the Voyage.

---

## 1. Decisions that refine the design docs (with reasons)

1. **Puppeted ship instead of `SimState.view`.** The lab-view orbit camera and the cinematic
   arena entry drive the *ship* pose directly (`Simulation.setPuppet/setPuppetPose`), with
   collisions and input suspended. Renderer, HUD markers, stars, dust, TAA and audio already follow
   `state.ship`, so nothing in the render path changes and the Voyage cannot regress. (Platform
   §3.1 proposed a separate view; this is the same behaviour with far less surface area.)
2. **Placement depth snaps to the beam.** Both in flight and in lab view, when the reticle/cursor
   ray passes within ~110 px of the beam, the default placement depth is the depth of the beam's
   closest point to that ray (the mass lands beside the beam, displaced by what the player sees on
   screen). Otherwise: flight = 0.5 × surface-hit distance, lab = plane through the arena centre.
   The wheel scales depth ×1.15 per notch. This makes placement feel 2-D ("decide on a point",
   research digest #6) and removes most depth fiddling (design §10 risk "depth placement fiddly").
3. **Controls avoid the flight keys.** R/F stay rise/sink, so **C = clear (reset)**; it is undoable.
   RMB in flight removes the hovered mass (hyper/ghost are off in arenas; Backspace is the escape
   hatch). Full table in §2.
4. **Tolerances are player-sized.** A 3-px placement window is not a puzzle. Seeds use radius
   4–6 % of the arena radius R; masses ρ ≈ 1–4 % of R (light ≈ 1.2 %, medium ≈ 2.2 %, heavy ≈ 3.5 %,
   per level). Deflection α = 2ρ/b, capture for b < (3√3/2)ρ ≈ 2.6ρ. The solver adds a
   **player-tolerance gate**: the authored solution must still solve when each mass moves by ±0.6 %
   of R in the view plane (≈ 3 px at a typical lab-view framing), in ≥ 70 % of 60 trials, besides the
   design's 5 %-of-ρ robustness. Shift while dragging = precision drag (×0.2).
5. **"Almost" connector.** When an unlit seed's closest approach is < 3r, a faint guide line joins
   the closest beam point to the seed, and the seed ring brightens: brightness, never numbers.
6. **The beam is visible through walls.** Lines and glyphs hidden behind structure are drawn at
   `occludedAlpha` (≈ 0.12 in flight, 0.3 in lab view), so the interface never disappears.
7. **Masses are real lenses.** Each placed mass renders as a black shadow of the capture radius with
   a thin photon rim, and warps the image behind it with the point-lens equation β = θ − θ_E²/θ,
   θ_E² = 2ρ(D_s − D)/(D·D_s) per pixel from the scene depth (sky = infinity). It shows the very
   physics the puzzle runs on (as built, with a ring 0.55 × the physical size so the puzzle stays
   readable; see Status). "Masses are the only pure blacks" (design §5.5).
8. **Daily generated at runtime** with the same deterministic code that the 400-day harness
   validates. Build-time JSON files are an optimisation for later (no backend either way).
9. **Frozen arenas are frozen at a defined clock.** A level names `clock` (default 0); the nebula's
   params are `animate(base, clock)` exactly, in the browser (Universe) and in Node (tools), so the
   tracer and the GPU agree with the authored solution.

---

## 2. Controls (First Light)

| Input | Flight (pointer locked) | Lab view (free cursor) |
|---|---|---|
| Mouse | Look | Pointer |
| W A S D, R F, Q E, Shift | Fly (slow; soft arena bounds) | — |
| Left mouse (press on empty) | Place the selected mass at the preview point | Place at the cursor's snapped depth, then keep dragging until release |
| Left mouse (press on a hovered mass) | Grab: it stays at its distance on the reticle ray while you look; release drops it | Drag in the view plane |
| Wheel | Placement depth (×1.15 / notch); while grabbing: grab distance | Dolly; while dragging: along the cursor ray |
| Right mouse | Remove the hovered mass | Drag = orbit; click on a mass = remove |
| Shift (while dragging) | Precision drag ×0.2 | Precision drag ×0.2 |
| 1 / 2 / 3 | Select light / medium / heavy | same |
| X | Remove hovered (else the last placed) | same |
| Z / Shift+Z (also Ctrl+Z / Ctrl+Y) | Undo / redo (50 deep) | same |
| C | Clear all masses (undoable) | same |
| Tab | → Lab view | → Flight |
| Backspace | Glide back to the vantage | Re-frame the orbit |
| Space (tap) | Pulse: reveals seeds + masses as HUD markers for 10 s | same |
| ? (Slash) | Hint ladder | same |
| I | Codex card of the level's nebula | same |
| H / M | Hide HUD / mute music | same |
| Esc | Pause (Levels, Restart, Voyage…) | same |
| Enter | Next level (on the solved card) | same |

Hover = the mass whose projected centre is nearest the reticle (flight) or cursor (lab), within
max(22 px, its on-screen shadow radius + 8 px).

---

## 3. Work packages, ownership, order

A module owner writes **only** the files listed for its package (plus new files it creates in
its own folder). If a contract is insufficient, extend it in the contract file *and* say so in the
final report. Other agents work in parallel: `npx tsc --noEmit` errors in files you do not own may
be someone else's work in progress — your files must be clean. Never start the Vite dev server in
Phase 1 (one shared port, constant HMR reloads); the lead does browser passes.

| Phase | WP | Owner files | Depends on |
|---|---|---|---|
| 1 | **S** Mode shell | `src/app/App.ts`, `src/ship/Input.ts`, `src/sim/Simulation.ts`, `src/universe/Universe.ts`, `src/hud/Hud.ts`, `src/hud/StartScreen.ts`, `src/hud/PauseScreen.ts`, `src/hud/controls.ts`, `src/styles/start.css`, `src/styles/panels.css`, `src/styles/flight.css`, `src/core/types.ts`, new `src/game/modes.ts`, stub `src/game/firstlight/FirstLightMode.ts`, new `tools/flight/*` | contracts |
| 1 | **T** Beam tracer | new `src/game/firstlight/{BeamTracer,Geodesic,Level,world}.ts`, `tools/fl-trace-check.ts` | contracts |
| 1 | **R** Overlay rendering | `src/render/Renderer.ts`, new `src/render/game/*` (except `overlayTypes.ts`, which it may extend), `tools/check-all-shaders.ts` | contracts |
| 1 | **P** Post effects | `src/render/post/CompositePass.ts`, `src/render/post/postShaders.ts`, `src/render/NebulaMaterial.ts` | contracts |
| 1 | **H** HUD | new `src/game/firstlight/hud/*` (except `hudTypes.ts`, which it may extend) | contracts |
| 1 | **A** Audio | new `src/audio/GameAudio.ts`, `src/audio/AudioEngine.ts`, `src/audio/Sfx.ts` | — |
| 1 | **G** Platform helpers | new `src/game/platform/{prng,OverviewCamera,save,daily,share}.ts`, `tools/platform-check.ts` | — |
| 1→2 | **L0** Generator + solver + preview | new `src/game/firstlight/{Generator,Solver}.ts`, `tools/fl-solve.ts`, `tools/fl-preview.ts`, `tools/fl-arenas.ts`, `tools/fl-check.ts`, `src/game/firstlight/dailyArenas.ts` | T, G(prng) |
| 2 | **M** FirstLightMode | `src/game/firstlight/{FirstLightMode,Placement,LabView,Ceremony,progress}.ts` (replaces the stub), `src/game/firstlight/chapters.ts` | S R P H A G T |
| 2 | **L1–L3** Chapters | `src/game/firstlight/levels/{bend,thread,reflect}.ts` | L0 |
| 2 | **D** Daily | `src/game/firstlight/DailyGen.ts`, `tools/fl-daily-check.ts` | L0 |
| 3 | **Q** Review, QA, docs | anything (lead-coordinated) | all |

---

## §S — Mode shell (WP S)

Implements `src/game/platform/GameMode.ts` in the App. Voyage = no mode, byte-for-byte behaviour.

**App.**
* Registry `src/game/modes.ts`: `export function createGameMode(id: GameModeId): GameMode` and
  `export const GAME_MODE_INFO: { id: ModeId; title: string; tagline: string }[]` (Voyage first).
* Mode choice: the start screen shows mode cards above the quality cards; `?mode=firstlight`
  pre-selects (and is kept in the URL on switch via `history.replaceState`); the last choice is
  remembered in `localStorage['fractal-nebulae.mode']` (sanitised). `VITE_MODES` (comma list, build
  env) may hide modes; default shows all.
* `cursorMode: 'locked' | 'free'`. `requestFreeCursor()` sets an "expected unlock" flag and calls
  `document.exitPointerLock()`: the resulting unlock must NOT pause. `requestFlight()` requests the
  lock (respecting the existing cooldown/timeout logic); a refusal while coming from 'free' keeps
  'free' and calls `mode.onCursorModeChange('free', true)` instead of pausing. A canvas click never
  auto-requests the lock while 'free'. Esc in 'free' (InputFrame.escape) pauses. Resume returns to
  the cursor mode that was active when the pause began (free → no lock request).
* Launch with a mode: as today (full screen, lock, audio inside the gesture), then
  `mode.enter(ctx, params)`. If `mode.initialCursor === 'free'`, don't request the lock.
* Frame order: `input.poll → sim.update → mode.update(dt, frame, state, paused) → audio → render → hud`.
  In a game mode the App still handles H (HUD) and M (mute) but **not** Tab/I (codex): the mode does.
* `ModeContext.layer`: a `div.fn-mode-layer` appended inside the flight HUD layer.
* `switchMode(id)`: `mode.exit()`, clear overlay (`renderer.setOverlay(null)`), restore sim policy,
  arena, puppet, frozen clocks; Hud back to Voyage; then enter the new mode (or none).
* Pause actions: PauseScreen renders `mode.pauseActions()` as buttons above the settings, plus a
  "Switch to Voyage / First Light" button. Per-mode controls table (mode rows first).
* `renderer.setOverlay(ctx.overlay)` while a mode is active (the overlay object is created by the
  App with `createOverlayFrame()` and handed to the mode through the context).
* Dev: `window.__app` stays; expose `__app.mode` for the console rig.

**Input** (`InputFrame` additions; existing fields unchanged in meaning):
```ts
buttons: number;   // held mouse buttons, bit 0 left, 1 right, 2 middle (locked: any press; free: presses that began on the canvas)
pressed: number;   // edges this frame
released: number;  // edges this frame
pointer: { x: number; y: number; inside: boolean; dx: number; dy: number }; // free cursor: CSS px rel. to canvas
keyDown(code: string): boolean;
keyPressed(code: string): boolean;   // keydown edge this frame (no auto-repeat), any KeyboardEvent.code
mods: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
escape: boolean;                      // Esc pressed while NOT pointer-locked and free-cursor flight is active
```
`Input.setFreeCursorActive(on)` (App calls it while flying in 'free'): pointer, buttons, wheel (only
when the wheel event targets the canvas) and game keys are delivered without the lock; Tab, Space,
Backspace and Slash are `preventDefault`ed; keys typed into INPUT/TEXTAREA/SELECT stay ignored
(BUTTON focus must not swallow game keys — blur it). `mouseDX/DY`, `hyper`, `click` keep their
locked-only semantics. Wheel in 'locked' unchanged. The existing harnesses build InputFrames by hand:
the Simulation must not *require* the new fields.

**Simulation** additions:
```ts
interface ControlPolicy { hyper: boolean; targeting: boolean; pulse: boolean; glide: boolean; voyage: boolean;
  wheelThrottle: boolean; throttle: number; }   // defaults = Voyage behaviour, throttle 1
setControlPolicy(p: Partial<ControlPolicy> | null): void;    // null = defaults
setArena(a: { nebulaId: string; centerLocal: Vec3; radiusLocal: number } | null): void;
setPuppet(on: boolean): void;
setPuppetPose(position: THREE.Vector3, orientation: THREE.Quaternion, ghostClip?: number): void;
teleport(position: THREE.Vector3, orientation: THREE.Quaternion): void;   // ship at rest there
```
* Policy off-switches: hyper/ghost (RMB ignored), targeting (LMB `click` ignored), pulse (Space tap),
  glide (Space hold), voyage (T), wheel→throttle (then `throttle` is fixed).
* **Arena soft bounds:** world centre/radius from the nebula runtime every step (spinning nebulae
  move it). Outward velocity fades between 1.0 R and 1.5 R (gone beyond); an idle ship beyond R
  drifts back toward the centre gently. No walls, no messages. Collision guarantees unchanged.
* **Puppet:** while on, `update()` skips steering, integration, hyper, ghost, co-rotation, autopilot
  and gravity, but still animates the universe, the pulse, the camera FOV (no hyper widening) and
  the environment. `setPuppetPose` applies immediately (position, orientation, forward/up/right,
  velocity = Δpos / state.dt (0 if dt = 0), `ghostClip`), then refreshes the universe, surface
  distance and environment for the new pose. `setPuppet(false)` re-syncs every internal attitude
  and look state (baseQ, bank, look stages, lastGood*), zeroes velocities and re-measures the speed
  scales, so flight resumes smoothly from the puppet pose. `teleport` = puppet on → pose → off.
* Run the collision-safety harnesses after the change (copy them from the previous session's
  scratchpad — see the WP prompt — into `tools/flight/`, fix their import paths to be relative to
  the repo, and keep them green: no "entered", "tunnel" or "pushThrough").

**Universe:** `setFrozenClock(id: string, clock: number | null)`: while set, that nebula's animation
clock is pinned and `params = animate(base, clock)` (base = `def.params ?? fractal.defaultParams`;
copied when the fractal has no `animate`), exactly as `frozenParams()` in
`src/game/firstlight/world.ts` (WP T) computes it.

**Hud:** `setGameMode(id: GameModeId | null)` adds `mode-<id>` on the root: hides the speed block,
location block, environment block, void facts, target brackets, first-minute Voyage hints and
region banners; suppresses codex auto-open (Tab/I toggling stays available through `toggleCodex`).
`flashMessage(text, kind?: 'info' | 'warn' | 'tip', label?)` (tip = physics-tip styling).
Keep the reticle, flash queue, pulse markers, perf readout, pause screen.

**Stub mode:** `FirstLightMode` stub that satisfies WP-0 acceptance (enter → flash "First Light —
coming online"; Tab toggles locked ⇄ free; Esc pauses and resumes into the same cursor mode). WP M
replaces it.

**Acceptance:** typecheck clean; flight harnesses green; Voyage unchanged by reading the diff (no
behavioural change when no mode is active); the stub cycles cursor modes and pause correctly.

---

## §T — Beam tracer (WP T)

Pure TypeScript (no three.js, no DOM) so the browser and Node share it.

* `world.ts`: `frozenParams(nebulaId: string, clock = 0): Float32Array` (catalogue + registry,
  formula in §S), `defaultMaterial(nebulaId): SurfaceMaterial` (apollonian, kleinian → reflect),
  `makeTraceWorld(level: LevelDef): TraceWorld` (`fractal.de(x, y, z, params, fractal.cpuIter)`),
  `localToWorld`-style helpers are NOT here (the mode owns three.js maths).
* `Level.ts`: `sanitizeLevel(raw: unknown): LevelDef | null` (hand-written, like settings: rejects
  out-of-range data: positions outside 1.25 R of the arena centre, ρ > 6 % R, > 16 seeds, > 6 budget
  items, non-finite numbers; normalises directions), plus `rhoOf(level, size)`, `budgetCount`.
* `Geodesic.ts`: `lensAccel(...)` — superposed point masses, `a = −1.5 · ρ · h² · p / |p|⁵`
  (h = |p × v|, unit-speed photon), the same Cartesian null geodesic as `blackholeGlsl.ts`.
  Document that superposition is an approximation. Capture radius `1.5 ρ` (photon sphere) with
  inward radial velocity; critical impact parameter (3√3/2) ρ.
* `BeamTracer.ts`: `traceLevel(level: LevelDef, world: TraceWorld, masses: PlacedMass[], opts?): TraceResult`
  (types in `types.ts`).
  * Queue of beams starting with the source; ≤ 16 beams, ≤ 6 reflections per beam, ≤ 6000 steps per
    beam, ≤ 30 000 total (coarse: step ×2, ≤ 10 000 total).
  * Step = clamp(min(0.8·DE, 0.15·(r_nearest − ρ_nearest)… , 0.02 R (coarse 0.04 R)), ≥ eps).
    Surface contact `DE < eps`, eps = 3e-4 R (tunable constant). Near masses (any within 200 ρ)
    integrate with RK2 midpoint and renormalise v; elsewhere straight.
  * Seeds: exact segment–sphere test every step (no tunnelling past small seeds), closest approach
    tracking (value + point). A lit seed does not block the beam. Echo seeds emit once (queue).
    Seeds light only with intensity ≥ 0.3.
  * Surface: absorb (end) or reflect (normal = DE gradient, tetrahedral, v −= 2(v·n)n, intensity ×0.7,
    push off the surface by 2 eps). Arena exit at 1.25 R. Capture → `captured` with the mass index.
  * Polyline decimation: keep a point when the direction turned > 0.4° since the last kept point, or
    every 0.04 R of length, plus every event point; arrays per Beam as in `types.ts`.
  * Determinism: quantise mass positions to 1e-6 local before tracing; identical results in Node
    and the browser for the same input.
* `tools/fl-trace-check.ts`: far-field deflection 2ρ/b within 2 % for b ∈ [10ρ, 200ρ] (free space);
  capture just inside / escape just outside b_c; two-mass symmetry; reflection angle-in = angle-out
  on a plane DE with ×0.7 intensity; seed hit/miss tunnelling cases; echo emission order; determinism
  (1000 random configs, two runs, byte-identical results); timing on a real Mandelbulb arena
  (report ms per full and coarse trace; target ≤ 8 ms / ≤ 3 ms).

---

## §R — Overlay rendering (WP R)

`src/render/game/` draws an `OverlayFrame` (contract in `overlayTypes.ts`):

* `LineSystem` (+ shader): one instanced quad per segment. Vertex: camera-relative endpoints
  (computed in doubles on the CPU every frame from local → world → minus ship position), clipped
  against the near plane in view space, expanded in screen space by `width × uPxScale` (reference px,
  like star sprites) with round-ish caps, `logDepth(viewZ)` per vertex. Fragment: beam style = hot
  core (Gaussian, ~0.35 of the width) + soft halo (~1.0 width), additive HDR, slow flowing pulses
  along `s` toward the travel direction (period ≈ 0.06 R, speed ≈ 0.12 R/s, ±20 % brightness);
  guide = thin, faint, no flow; dashed = guide with dashes.
* `GlyphSprites` (+ shader): instanced SDF markers (shapes in `GLYPH_SHAPE`), radius on screen =
  max(minPx·uPxScale, size/viewZ/pixelAngle), anti-aliased edges, fill/outline, breathing by phase.
* `GameStars`: spiked star sprites using the existing sprite pipeline (`createSpriteMaterial` +
  a vertex main like `NebulaStars`), fed from `StarBuffer`.
* **Two-pass occlusion:** visible pass (`depthFunc: LessEqual`) at full intensity, occluded pass
  (`depthFunc: Greater`) × `overlay.occludedAlpha`. Both depth-test against the shared scene depth
  and write no depth; additive.
* `GameOverlayRenderer`: owns the above, converts buffers every frame (allocation-free; dynamic
  attributes sized to capacity), renders right after `stars.renderNear` into the same bound target
  (sprite layer with TAA, scene otherwise). Fills `ctx.accents` from `overlay.accents` (local xyz +
  radius, colour) for the overlay's nebula. Projects `overlay.lenses` to `ScreenLens[]` (output uv,
  `einstein` = √(2ρ_w/D) and `shadow` = 2.598·ρ_w/D as fractions of the image height via the
  vertical FOV, `depth01` = logDepth(viewZ)) and calls `composite.setLenses(lenses, n, sceneRT.depthTexture)`
  every frame (n = 0 when there is no overlay).
* `Renderer.setOverlay` real implementation; precompile the overlay programs during `init()`
  (a "Game overlay" compile group) so entering First Light causes no shader hitch; context-restore
  recompile includes them. Register the new programs in `tools/check-all-shaders.ts`.
* Budget: ≤ 0.5 ms GPU for 2k segments + 300 glyphs; no per-frame allocation.

---

## §P — Post effects (WP P)

* **Lens warp** in the composite: implement `CompositePass.setLenses`. Uniform arrays (≤ 8):
  `uLensA[i] = (u, v, einstein, shadow)`, `uLensB[i] = (depth01, strength, glow, 0)`, `uLensCount`,
  `uDepthTex` (scene log depth at render resolution). Per output pixel, in a height-normalised space
  (x × aspect): for each lens in front of the pixel's scene depth, add the point-lens deflection
  `θ_E²(pixel)/θ` toward the lens, with `θ_E²(pixel) = einstein² · max(D_s − D, 0)/D_s` (D, D_s
  decoded from the log depths; sky = ∞), windowed smoothly to zero beyond ~5 θ_E and clamped so no
  pixel samples from further than ~3 θ_E. Sample scene and bloom at the warped uv (apply the warp
  before the sharpen taps). Inside the shadow radius: black (scene × 0) with a soft 1–2 px edge, plus a
  thin HDR photon rim (× glow, warm white) at the edge. The sprite layer is NOT warped (beams are
  already bent in world space). Zero cost when `uLensCount = 0`.
* **Accent lights** in `NebulaMaterial`: `uAccentPos[4]` (local xyz + radius), `uAccentCol[4]`,
  `uAccentCount`; filled in `updateNebulaUniforms` only when `ctx.accents.nebulaId === neb.def.id`.
  Surface: wrap-diffuse × albedo × colour × smooth falloff `(1 − (r/R)²)²`, plus a little rim/emission
  pickup; gas: a cheap per-ray analytic glow (closest approach of the view ray to each light) — never
  a per-step loop over lights. Works under the ghost x-ray. Cost ≤ 3 % of the nebula pass.
* Validate with `npx tsx tools/check-all-shaders.ts` (all presets) and report a GPU cost estimate.

---

## §H — First Light HUD (WP H)

`src/game/firstlight/hud/FirstLightHud.ts` + `firstlight.css`, DOM only, Voyage visual language
(Rajdhani caps for labels, JetBrains Mono for values, cyan accent `#7fe7ff`, glass cards, the
tokens in `src/styles/base.css`). Contract types in `hudTypes.ts`.

```ts
export class FirstLightHud {
  constructor(layer: HTMLElement, cb: FirstLightHudCallbacks);
  showAtlas(model: AtlasModel, canClose: boolean): void;   hideAtlas(): void;   readonly atlasOpen: boolean;
  setLevel(h: LevelHeader | null): void;          // top-left title block (null hides the play HUD)
  setPlay(s: PlayHudState): void;                 // cheap to call every frame: diff + write only on change
  showSolved(card: SolvedCard): void;  hideSolved(): void;  readonly solvedOpen: boolean;
  showHint(step: 1 | 2 | 3, text: string): void;   hideHint(): void;
  showTip(label: string, text: string): void;     // one-time physics tip card (bottom-left), auto-hides
  setCursorTip(x: number, y: number, text: string | null): void;   // small label near the cursor/reticle (legality reason, "remove")
  setLabView(on: boolean): void;                  // contextual control hint line (flight vs lab)
  update(dt: number): void;                       // animations / auto-hide timers
  dispose(): void;
}
```
* Play HUD: top-left level header (nebula · chapter N of M, level name), top-centre seed chips
  (◆ lit / ◇ unlit, "almost" brightening, echo chips smaller), bottom-centre mass orbs (filled =
  available, hollow = placed, grouped by size, the selected size highlighted; clicking selects:
  `onSelectSize`), a contextual control line (flight vs lab), the depth gauge beside the reticle, the
  hint chip (appears when `hintAvailable`), undo/redo affordances, daily timer.
* Atlas: a centred glass panel: header (✦ count), three chapter cards (nebula name, chapter name,
  rule, six level nodes with solved/✦/help states, the current one highlighted), the Daily card
  (label, streak, next in hh:mm, solved time). Keyboard: arrows + Enter, Esc closes when allowed.
* Solved card: title ("First light"), the teach line, masses used vs par (✦ when met), "with help"
  note, buttons Next (Enter) / Replay / Atlas; daily variant with the share string preview,
  "Copy" (shows "Copied" / "Copy failed — select the text"), streak and next-in.
* Hint panel: step label, text, "Next hint" button (step 3 warns: "Shows the designer's note — no ✦").
* Respect `prefers-reduced-motion`. Deck-readable (≥ 9 px at 1280×800). No game logic.

---

## §A — Audio (WP A)

`src/audio/GameAudio.ts`, built on the AudioEngine's SFX bus and the current harmony
(`HarmonySnapshot`), always in key, soft and reverberant (Voyage tone, no alarms):
```ts
export class GameAudio {
  constructor(engine: AudioEngine);
  place(size: MassSize): void;     remove(): void;     grab(): void;     drop(): void;   undo(): void;
  seedLit(order: number): void;    // the next scale degree (a chapter becomes a melody)
  seedUnlit(): void;               // soft falling tone when a configuration change unlights a seed
  capture(): void;                 // low swallow
  reflect(): void;                 // glassy chime
  ignition(): void;                // ceremony: the nebula's motif / a rising chord bloom (~3 s)
  ui(kind: 'select' | 'open' | 'close' | 'hint' | 'error'): void;
  setBeam(deflection: number, reflections: number, active: boolean): void;  // bowed hum; params ≤ 30 Hz
  dispose(): void;
}
```
Every call is a safe no-op before `engine.start()` resolved or after dispose. Add only the minimal
hooks to `AudioEngine` (e.g. a `game()` accessor exposing SFX in/out nodes and `harmony()`).
Respect the SFX volume and mute rules (music mute leaves SFX on).

---

## §G — Platform helpers (WP G)

* `prng.ts`: `mulberry32(seed): () => number`, `fnv1a(str): number`, `hash2/3` helpers, `pick`, `shuffle`.
* `OverviewCamera.ts` (pure maths on three.js vectors, no DOM): focus (world), distance (clamped
  `[0.3, 3] × radius`, log-scaled wheel), yaw/pitch (pitch ±80°), locked up vector, damped
  (`damp` time constants like the flight look), `orbit(dxPx, dyPx)`, `dolly(notches)`,
  `pan(dxPx, dyPx)` (optional), `frame(focus, radius, up, fromDir?)`, `update(dt)`,
  `pose(outPos, outQuat)`, `rayThrough(px, py, viewportW, viewportH, fovDeg, outOrigin, outDir)`.
* `save.ts`: `localStorage['fractal-nebulae.progress.v1']`, namespaced per mode, sanitised on load,
  `load<T>(ns, sanitize)`, `save(ns, data)`, `exportAll(): string`, `importAll(json): boolean`.
* `daily.ts`: `dailyId(date = new Date())` (UTC `YYYY-MM-DD`), `dailySeed(id, mode)` = fnv1a,
  `dailyNumber(id)` (#1 = 2026-10-02), `nextInText(date?)` "hh:mm", `parseDailyParam(str)`.
* `share.ts`: `buildShare({ number, nebula, seedsLit, seedsTotal, massesUsed, time, url })` →
  `First Light #42 · Menger · ◆◆◇  ⚬⚬  1:12\n<url>`; `copyText(text): Promise<boolean>` (Clipboard API
  with a textarea fallback); `formatTime(seconds)` "m:ss".
* `tools/platform-check.ts`: orbit maths (up lock, clamps, ray through the centre = forward),
  daily ids across a UTC midnight, share string format, save round-trip with corrupt input.

---

## §L — Generator, solver, levels (WP L0, L1–L3, D)

* `Solver.ts` (pure): objective = Σ over goal seeds of max(0, closest/r − 1) (+ capture/absorb
  penalties); search = beam-guided candidates (blue-noise points within 20 ρ of the current beam,
  in free space DE > 3 ρ_max, inside the arena) + random restarts + local optimisation (pattern
  search / annealing). API: `solve(level, budget, opts) → { solved, masses, evals }`,
  `gates(level) → { unlensedFails, solutionWorks, minimal (heuristic: no smaller multiset solves in
  N restarts), accidental (fraction of 500 random budget placements that solve, must be < 1 %),
  robust (5 %-ρ jitter, ≥ 90 %), tolerant (±0.6 % R view-plane jitter, ≥ 70 %), pathLength, bends }`.
* `Generator.ts` (pure, seeded): forward design (design §7.4) for an arena: place k masses in free
  space, aim the source to pass within ~4–10 ρ of the first mass, trace, place 1–3 seeds on the
  traced path after the first bend near structure, remove masses, verify gates; retry with sub-seeds.
* `tools/fl-arenas.ts`: find candidate arenas in a nebula (centre near structure; 35–75 % free
  volume inside R; DE-reliability check per platform §6.2; a vantage in free space with a clear view
  of the centre). `src/game/firstlight/dailyArenas.ts`: curated pool (≥ 4 per nebula for bulb,
  menger, apollonian, kleinian, sierpinski, tree, kifs, box, julia).
* `tools/fl-preview.ts`: CPU-raymarched PNG of a level from its vantage (and from a lab-view
  angle), with the beam, seeds, source and masses drawn on top (with / without the solution), so a
  designer can *see* a level. Reuse `tools/cpu-render.ts` ideas.
* `tools/fl-check.ts`: every authored level loads, sanitises, passes the gates, and its vantage is
  in free space; prints a table. CI-able (non-zero exit on failure).
* **Chapters** (`levels/bend.ts`, `thread.ts`, `reflect.ts`): six levels each, ordered show → use →
  use → combine → combine → surprise (design §6). Chapter 1's level 1 is the "almost" moment: the
  unlensed beam visibly misses the seed by about one floret; one mass fixes it. Chapter 1 level 4
  teaches capture by putting the seed where a naive mass would swallow the beam. Chapter 2 threads
  Menger tunnels (two masses in series). Chapter 3 uses reflection off pearls (a mass + a pearl =
  a corner). Every level: a name, a one-line `teach`, three hints (easier deduction → region →
  designer's note), `par` from the solver, and a first-time physics `tip` where the design asks
  (first bend, first capture, first reflection).
* `DailyGen.ts`: date → level via `dailyArenas` + Generator; weekday tiers (Mon–Tue 1 mass, Wed–Fri 2,
  Sat 3, Sun 2 in a harder arena); `tools/fl-daily-check.ts` validates 400 days (all generated,
  gates passed, generation time p95) and prints difficulty stats.

---

## §M — FirstLightMode (WP M)

The game: state machine `atlas → entering → playing ⇄ (lab) → ceremony → solved`, using every
package above. Key behaviours:

* **Enter level:** fade (0.35 s), `universe.setFrozenClock(nebula, level.clock ?? 0)`, puppet the
  ship to a point ~0.6 R behind the vantage (along vantage − lookAt), fade in, glide to the vantage
  in ~2.5 s (smoothstep), release the puppet; `sim.setArena(...)`, `sim.setControlPolicy({ hyper:
  false, targeting: false, glide: false, voyage: false, wheelThrottle: false, throttle: 0.6 })`.
  First-timers go straight into bend-1; returning players open the Atlas.
* **Retrace:** full trace on every committed change; while dragging, coarse traces at ≤ 20 Hz
  (keep the last result between). If a full trace exceeds 8 ms three times running, keep using it
  but log once (a worker is a later optimisation).
* **Overlay feed** each frame: beams (style beam, colour warm white-gold `(2.4, 1.9, 1.2)` core →
  the shader adds the cyan halo; intensity scales it), seeds (unlit ember ring `(1.4, 0.55, 0.25)`;
  "almost" brightening; lit teal `(0.4, 2.2, 1.9)` filled diamond + a small spiked star + accent
  light), echo seeds' emit arrows when lit, the source (spiked star + faint emit cone guide lines),
  masses (lenses with glow from `massClosest`; a faint ring glyph so they read at a distance), the
  placement preview (lens at strength ~0.45 + green/red ring glyph + drop line to the surface), the
  "almost" connector, beam endpoint glow (+ accent light), reflection flares, hint-2 sphere (dashed).
  `occludedAlpha` 0.12 in flight, 0.3 in lab view.
* **Lab view:** OverviewCamera framed on the arena (distance ≈ 2.2 R, up = arena up), puppet the
  ship to its pose every frame with `ghostClip ≈ max(0, d − 0.75 R)` so structure between the camera
  and the arena turns to glass; tween 0.6 s in and out; leaving restores the saved flight pose.
* **Placement/legality:** illegal when inside structure (DE < 2 ρ), outside the arena, within 3 ρ
  of another mass, within (seed r + 2 ρ) of a seed or 3 ρ of the source; reason words: "inside
  structure", "outside the arena", "too close to a mass", "too close to a seed", "too close to the
  star". Budget spent → no preview, the HUD shows the orbs hollow.
* **Win:** when a committed trace solves: ceremony (3 s: seeds swell, accent lights ramp, pulse
  from the last seed, `GameAudio.ignition()`), save `{ masses, help, par }`, solved card. Daily:
  timer, share string, streak.
* **Hints:** chip after 2 minutes (or immediately via `?`), steps per `level.hints`, step 2 shows the
  dashed sphere (radius 6 ρ) at `solution[hintMass]`, step 3 marks "with help".
* **Pulse** (Space) reveals seeds and masses as HUD markers for 10 s (reuse the sim pulse visual).
* **Physics tips** first time: bend, capture, reflection, Einstein ring (when a mass's rim glows hot).
* **Save:** `progress.firstlight = { solved: { [id]: { masses, help, par } }, current, daily:
  { streak, last, history: { [date]: { time, masses } } }, seenTips: string[] }` via `save.ts`.
* URL params: `level=<id>`, `daily=<YYYY-MM-DD>` (also `daily=today`).
* `exit()` restores everything (policy, arena, puppet, frozen clock, overlay cleared, HUD disposed).

---

## §Q — Quality gates (all packages)

* `npx tsc --noEmit` clean; `npx tsx tools/check-all-shaders.ts` clean (all presets).
* Headless harnesses green: `tools/fl-trace-check.ts`, `tools/platform-check.ts`, `tools/fl-check.ts`,
  `tools/fl-daily-check.ts`, `tools/flight/*`.
* Allocation-free per-frame render/HUD code; NaN guards on everything sent to the GPU.
* Browser pass by the lead: Voyage regression, every First Light level solvable by hand, lab view,
  lens and accent visuals, 60 fps on High with 8 masses and a 16-beam trace.
