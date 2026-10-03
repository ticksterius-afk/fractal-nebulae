# 10 — Game Platform: shared systems for First Light, Nursery and Relay

*Hand-off for the platform work packages WP-0 … WP-10. Read `ARCHITECTURE.md` first; this
document only describes what changes or is added.*

The three games share one shell, one way of looking at a nebula from outside, one way of
choosing a point in it, one way of sampling and testing the fractal, one way of drawing lines
and glyphs, and one way of saving, sharing and teaching. Build each of these once, headless
first, then wire the UI. Nothing here touches the flight model's collision guarantees.

---

## 0. Principles

- **The Voyage must not regress.** `mode = 'voyage'` is the current app, byte for byte in
  behaviour. Every platform change is additive and gated by the active mode.
- **Fly in 6-DoF, decide on a point.** Decisions are a point on the view ray, a snapped site or
  a graph edge. The overview camera is for comprehension, not for free-form 3-D editing.
- **Headless before visual.** Every system below has a `tools/*.ts` harness runnable with
  `npx tsx`, because the browser pane cannot be trusted for timing or input.
- **Local coordinates for everything persistent.** Arenas, sites, levels and saves use
  nebula-local units (world = `position + rotation · (local × scale)`), so content survives
  catalogue retuning and nebula spin, and float precision stays sane deep inside structure.
- **Deterministic from a seed.** `mulberry32(seed)` everywhere; never `Math.random()` in
  generation or simulation. Quantise positions (e.g. to 1e-5 local) before any threshold
  decision so cross-browser `Math.sin` differences cannot flip an outcome.

---

## 1. File map (new)

| Area | Files |
|---|---|
| Mode shell | `src/game/platform/GameMode.ts` (interface, registry), `src/game/platform/ModeContext.ts`, changes in `src/app/App.ts`, `src/hud/StartScreen.ts` (mode cards), `src/hud/controls.ts` (per-mode control tables) |
| Cursor & input | `src/ship/Input.ts` (free-cursor pointer frame, `keyDown`), `src/app/App.ts` (`cursorMode`) |
| View / overview camera | `src/game/platform/OverviewCamera.ts`, `SimState.view` in `src/core/types.ts`, small changes in `src/render/Renderer.ts`, `src/hud/Markers.ts`, `src/sim/Simulation.ts` |
| Arena | `src/game/platform/Arena.ts` |
| Placement | `src/game/platform/Placement.ts`, `src/game/platform/hud/PlacementReticle.ts` |
| Sampling | `src/game/platform/SiteSampler.ts`, `src/game/platform/sites.worker.ts`, `src/game/platform/prng.ts`, `deTrap` additions in every `src/fractals/*.ts` |
| Tracing | `src/game/platform/Tracer.ts` (segment LOS, gradient), `src/game/platform/Geodesic.ts` (Schwarzschild/spin deflection shared with First Light and Relay) |
| Rendering | `src/render/lines/LineSystem.ts` (+ `lineShader.ts`), `src/render/stars/GlyphSprites.ts` (new sprite kind), accent lights in `src/render/NebulaMaterial.ts` |
| Persistence & sharing | `src/game/platform/save.ts`, `daily.ts`, `share.ts`, `permalink.ts`, `PlateMode.ts` |
| Teaching | `src/game/platform/Atlas.ts`, `Hints.ts`, `src/content/atlas/*.ts` |
| Audio hooks | `src/audio/GameAudio.ts` (notes in key, add/remove voices, stingers) |
| Tools | `tools/sites-check.ts`, `tools/trace-check.ts`, `tools/daily-build.ts`, `tools/game-check.ts` |

---

## 2. Mode shell (WP-0)

### 2.1 Interface

```ts
export type ModeId = 'voyage' | 'firstlight' | 'nursery' | 'relay';

export interface ModeContext {
  sim: Simulation; renderer: Renderer; hud: Hud; audio: AudioEngine; input: Input;
  bus: EventBus; settings: AppSettings; universe: Universe;
  requestFlight(): void;           // pointer lock (call inside a user gesture)
  requestFreeCursor(): void;       // release lock, keep the mode running (not paused)
  setView(v: ViewOverride | null): void;   // overview camera or null = ship
  save: SaveStore;                 // namespaced persistence
}

export interface GameMode {
  readonly id: ModeId;
  readonly title: string;                 // start-screen card
  readonly controls: ControlRow[];        // pause-screen table + first-minute hints
  enter(ctx: ModeContext, params: URLSearchParams): Promise<void>;
  update(dt: number, input: InputFrame, state: SimState): void;   // after sim.update, before render
  renderExtra?(ctx: RenderContext, target: 'scene' | 'sprite'): void; // lines / glyphs
  exit(): void;
}
```

### 2.2 App changes

- `App.phase` stays `loading → start → flying ⇄ paused`. Add `cursorMode: 'locked' | 'free'`.
  In `free`, the pointer is not locked, mouse look is off, the canvas receives pointer events,
  **Esc still pauses**. Clicking the canvas does not auto-request lock in `free`; the mode
  decides (`requestFlight()` from a click or key handler: both count as user activation).
- Frame order: `input.poll()` → `sim.update()` → `mode.update()` (may set `state.view`,
  may call `universe.refresh(viewPos)`) → `audio.update()` → `renderer.render()` →
  `mode.renderExtra()` is called by the renderer at the sprite-layer stage → `hud.update()`.
- Start screen: mode cards (Voyage, First Light, Nursery, Relay) above the quality cards;
  `?mode=` pre-selects; a mode can be hidden behind a build flag (`VITE_MODES`) so the free web
  build exposes only Voyage + First Light daily while the Steam build exposes everything.
- `controls.ts` becomes per-mode: the pause-screen table shows the active mode's rows after the
  shared flight rows.

### 2.3 Input additions

```ts
interface InputFrame {
  // existing fields unchanged …
  pointer: { x: number; y: number; inside: boolean;         // CSS px, free cursor only
             down: boolean; pressed: boolean; released: boolean; dx: number; dy: number;
             button: 0 | 2 | -1 };
  keyDown(code: string): boolean;        // physical code, e.g. 'KeyX'
  keyPressed(code: string): boolean;     // edge, this frame
}
```

Wheel events are delivered in both cursor modes. Tab is `preventDefault`ed whenever a mode is
active (not only when locked). Keys typed into form controls stay ignored.

**Acceptance (WP-0):** Voyage unchanged (manual regression: launch, pause, resume, wormhole,
ghost). A stub mode `firstlight` launches into free-cursor state, draws its own HUD root,
toggles to flight on Tab and back, pauses on Esc, resumes into the same cursor mode.

---

## 3. View and overview camera (WP-1)

### 3.1 `SimState.view`

```ts
view: { position: THREE.Vector3; orientation: THREE.Quaternion; fovDeg: number; fromShip: boolean };
```

`Simulation.update` copies ship → view every frame. A mode may overwrite it afterwards. The
renderer, `Markers`, `Readouts` (distance labels) and the audio engine's spatial cues read
`state.view`, not `state.ship`. The HUD "location" block keeps reading the ship.

### 3.2 OverviewCamera

An orbit camera with a **locked up vector** (Homeworld's rule: a shared "right way up"):

- Focus point `F` (world), distance `d` (log-scaled wheel, clamped to `[0.3, 3] × arena radius`),
  yaw/pitch (pitch clamped ±80°), up = the arena's `up` (nebula-local +Y by default).
- Drag with the right mouse button (left is for placement), wheel = dolly, middle/Shift-drag =
  pan the focus along the view plane (optional, off by default to keep the focus meaningful).
- Smoothed with the same `damp` time constants as the flight look (silky, never twitchy).
- **Seeing into structure.** The camera will often sit inside fractal walls. Set
  `state.ship.ghostClip` to `0.9 × d` while the overview is active so the renderer's existing
  x-ray cuts away anything between the camera and the focus (ARCHITECTURE §9 ghost mode). No
  collision, no new shader work.
- `universe.refresh(view.position)` every frame so LOD and `surfaceDistance` follow the camera.
- Entering/leaving the overview tweens over 0.6 s between ship pose and orbit pose; the TAA
  history resets on the switch (teleport rule).

**Acceptance (WP-1):** `tools/overview-check.ts` verifies the orbit maths (up lock, clamps);
visual pass: orbit around an arena inside the Menger sponge with no clipping artefacts and the
ghost x-ray revealing the interior; markers project correctly from the overview pose.

---

## 4. Arena (WP-2a)

```ts
interface ArenaDef {
  nebulaId: string;
  centerLocal: Vec3; radiusLocal: number;      // play sphere, local units
  up?: Vec3;                                   // overview "up" (default local +Y)
  vantageLocal?: { pos: Vec3; lookAt: Vec3 };  // first-person entry pose
  freezeAnimation?: boolean;                   // default true for puzzles
  showOthers?: boolean;                        // render other nebulae (default true, far)
}
```

- `Arena.enter(def)`: glide the ship to the vantage (reuse `Autopilot.startTarget` with an
  explicit pose), set `universe.setAnimationScale(nebulaId, 0)` when frozen (new: a per-nebula
  clock multiplier; the Universe already slows breathing near structure, so expose that knob).
- **Soft bounds:** reuse the soft-universe-edge rule (outward motion fades beyond 1.0 ×
  radius, gone by 1.5 ×, idle ship drifts back to the vantage). No walls, no messages.
- `Arena.toWorld(local)`, `toLocal(world)` helpers (allocation-free, doubles).

---

## 5. Placement (WP-2b)

The single interaction primitive. Returns a candidate `{ pointLocal, pointWorld, site?, legal, reason? }`.

- **Flight placement:** ray = ship forward. Depth = `depthScale × surfaceHitDistance`, where
  the wheel scales depth by ×1.15 per notch (log), default 0.5 of the hit distance (or 0.25 of
  the arena radius if nothing is hit). A ghost preview (sprite) sits at the point; a thin
  **drop line** to the nearest surface point (gradient direction) shows depth at a glance.
- **Overview placement:** ray from the orbit camera through the pointer. Depth: snapped site if
  the mode asks for snapping (nearest site within 12 px of the ray, projected), else the plane
  through the focus perpendicular to the view, adjusted by the wheel along the ray.
- **Drag:** hold the left button on an existing object: move in the view plane; wheel moves it
  along the view ray. Release commits. Modes get `onPreview(candidate)` every frame while
  dragging and `onCommit(candidate)` once.
- **Legality** is a mode callback evaluated every preview frame and shown before commit:
  green ring = legal, red ring + one-word reason ("inside structure", "outside arena",
  "no line of sight"). Islanders' complaint ("where may I place?") is the thing to avoid.
- Keys (shared default): `X` remove hovered/last, `Z` undo, `Shift+Z` redo, `R` reset,
  `Tab` overview ⇄ flight, `Backspace` return to vantage, `H` hide HUD, `Space` pulse (reveals
  mode markers for 10 s, as it does nebulae).

**Acceptance (WP-2):** a test mode places, drags, removes and undoes spheres in flight and
overview; legality rings update within one frame; 60 fps maintained on High with 32 placed objects.

---

## 6. Site sampler (WP-3)

### 6.1 CPU orbit traps

Every `FractalDef` gains an optional `deTrap(x, y, z, params, iter, outTrap: Float32Array): number`
mirroring the GLSL `fractalDE(p, out trap)` **exactly** (same iteration count, same trap
formulas, same hash for `trap.w`). Fractals without it fall back to `de` and a cavity estimate
from DE curvature. Validate each mirror with `tools/sites-check.ts`: sample 10k points, compare
CPU traps against a GPU readback of the same points (render a 100×100 point grid into a float
target with a tiny debug material) with tolerance 1e-3.

### 6.2 Sampling

```ts
interface SiteRequest { nebulaId: string; seed: number; arena?: ArenaDef;
  band: 'surface' | 'shell' | 'knots'; count: number; minSpacing: number; k: number; }
interface SiteSet { nebulaId; seed; band; n: number;
  pos: Float32Array /* n×3 local */; normal: Float32Array /* n×3 */; trap: Float32Array /* n×4 */;
  clearance: Float32Array /* DE at site */; knn: Int32Array /* n×k */; knnDist: Float32Array; }
```

- `surface`: random point in the sphere → 8 steps of `p -= DE(p)·∇DE(p)` → accept if
  `|DE| < 1e-4 × bound`; `shell`: accept points with `0 < DE < 0.15 × bound` (gas region);
  `knots`: surface points with `trap.w > 0.6`, boosted by rejection sampling (knots are sparse).
- Poisson thinning by `minSpacing` (grid hash); kNN by the same grid. Deterministic order.
- Runs in a worker (`sites.worker.ts`); 20k sites ≈ 0.3–1 s. Authored content ships
  precomputed `SiteSet` JSON (gzip ~100–300 KB each) under `public/sites/`; dailies compute live.
- The DE is only reliable in hand-picked regions (CodeParade's warning). `tools/sites-check.ts`
  also verifies `DE(p) ≤ true distance` on 2k random pairs per arena (march from p toward a
  surface point and confirm no early contact) and prints the worst ratio; reject arenas with
  violations > 1e-3.

**Acceptance (WP-3):** sampler produces identical `SiteSet`s for a seed across Node and the
browser; the six campaign arenas of First Light chapter 1–3 pass the DE-reliability check;
worker time logged.

---

## 7. Tracer and geodesics (WP-4)

### 7.1 Segment trace

`Tracer.segment(aWorld, bWorld, opts): { clear: boolean; t: number; hit?: Vector3 }` —
sphere-trace with `Universe.distanceValue`, step = `0.8·DE`, clearance `eps` (default
`2 × SURFACE_CLEARANCE_LOCAL × scale`), max 512 steps, early out when `DE > remaining`.
Allocation-free; ~5–50 µs per call.

### 7.2 Geodesic deflection (shared with First Light and Relay's lens)

Mirror of the renderer's Schwarzschild null geodesic in Cartesian form (`blackholeGlsl.ts`):
for a point mass with Schwarzschild radius ρ at `m`, with `p = x − m`, unit velocity `v`,
`h = |p × v|`:

```
a = −1.5 · ρ · h² · p / |p|⁵          (exact for ρ = 1; scaled to any ρ)
```

Superpose over masses (document that superposition is an approximation). For a spinning mass
add the renderer's gravitomagnetic dipole term with the same sign convention (read
`blackholeGlsl.ts`; the mirror must be exact so First Light's beams match what the sky shows).
Integrate with RK2 (midpoint) at step `min(0.8·DE, 0.15·r_nearest, maxStep)`, renormalise `v`
each step. **Capture:** `r < 1.5ρ` with inward radial velocity ends the ray (photon sphere).
Far-field check in `tools/trace-check.ts`: deflection at impact parameter `b` must equal
`2ρ/b` within 2 % for `b ≥ 10ρ`.

---

## 8. Lines, glyphs and accent lights (WP-5, WP-6)

- **LineSystem:** camera-facing ribbons, one instanced quad per segment, vertex shader places
  endpoints at `logDepth(viewZ)`, width in reference px (scaled like star sprites), additive
  HDR colour with a soft core/halo profile, optional travelling-pulse parameter `uPhase` for
  Relay's messages. Draws into `spriteRT` (shares `sceneRT`'s depth texture, so fractal
  structure occludes lines, and lines bypass TAA history). Dynamic buffers sized by capacity;
  no per-frame allocation. Validate with `tools/check-all-shaders.ts` (new program registered).
- **GlyphSprites:** a new sprite kind in `spriteShader.ts`: SDF shapes (ring, diamond, dot,
  cross) with fill/outline and a "pulse" uniform; same depth test; used for seeds, sites,
  relays, masses' Einstein rims, remnants. Instanced; 4k glyphs ≪ 1 ms.
- **Accent lights:** `uniform vec4 uAccentPos[4]; uniform vec4 uAccentCol[4]` (local position
  + radius, HDR colour + 0) in `NebulaMaterial`; wrap-diffuse with smooth radial falloff added
  to the surface shading and a small boost to near-surface gas; selected per frame by distance
  to the camera. Cost ≈ +3 % per lit pixel; off when unused via `#define ACCENT_LIGHTS 0`.

---

## 9. Save, daily, share, permalink, plate (WP-7, WP-10)

- `save.ts`: `localStorage['fractal-nebulae.progress.v1']`, namespaced per mode, sanitised on
  load like settings, export/import JSON (the Electron build maps this to Steam Cloud).
- `daily.ts`: `dailyId = YYYY-MM-DD` in **UTC**; `seed = fnv1a(dailyId + ':' + mode)`. The HUD
  shows "next in hh:mm". Dailies are **pre-generated at build time** (`tools/daily-build.ts`,
  400 days ahead, ~2–5 KB each, `public/daily/<mode>/<date>.json`) by the same JS code; the
  runtime generator is the fallback when a file is missing (and is used in dev).
- `share.ts`: Wordle-style, spoiler-free, copy-to-clipboard; e.g.
  `First Light #42 ◆◆◇ ⚬⚬ 1:12` + URL. Streak counter stored locally.
- `permalink.ts`: `?mode=voyage&at=<base64url>` encoding `nebulaId`, local position (3×f32),
  orientation (4×f16), fov (u8), optional zoom band. "Stand where I stood" works with no server.
- `PlateMode.ts`: `P` pauses the sim, opens the overview camera on the current view, hides the
  HUD, exposes FOV and exposure sliders, renders at 2× output resolution to an offscreen target
  and downloads a PNG with the permalink in a text chunk. Days of work, best marketing (Bugnet).

---

## 10. Atlas and hints (WP-8)

- **Atlas** extends the codex: entries carry `threads: { id; label; done: boolean }[]`.
  A nebula with unexhausted threads shows an asterisk on its codex card and on the start
  screen's constellation map (Outer Wilds' rumour map). Threads are completed by in-game events
  (First Light: chapter puzzles; Nursery: phenomena; Relay: twists). Each completed thread
  reveals one paragraph that **shows the maths or the musical rule** it demonstrates.
- **Hints** are opt-in and escalating (never auto-popping): level 1 points to an easier
  deduction, level 2 narrows the space, level 3 is the designer's note; the ladder is a service
  the modes fill. Research: concise, implicit hints beat abstract ones, and pointing at an
  easier deduction feels less like cheating (St Andrews, UW).

---

## 11. Audio hooks (WP-9)

```ts
GameAudio.note(degree: number, octave?: number, articulation?: 'pluck' | 'bell' | 'pad');  // in current key/mode
GameAudio.stinger(kind: 'ignite' | 'capture' | 'deliver' | 'expire' | 'collapse' | 'supernova');
GameAudio.addVoice(id, spec: VoiceSpec): void; removeVoice(id): void;   // persistent layers
GameAudio.setTension(0..1): void;   // low-pass / detune for overload states (Relay)
```

Built on `Sfx.ts` and `MusicDirector` (two decks; profiles per nebula). Every cue has a visual
twin. Voices added by games persist in the Voyage profile for that nebula (lit seeds, born
stars, built networks are heard later when flying through).

---

## 12. Performance budget (High preset, GTX 1080, 2560×1440 dynamic res)

| Item | Budget |
|---|---|
| Mode `update()` (CPU, main thread) | ≤ 3 ms average, ≤ 8 ms peak (tracing bursts go to a worker or are time-sliced) |
| Lines + glyphs | ≤ 0.5 ms GPU for 2k segments + 4k glyphs |
| Accent lights | ≤ 3 % of nebula pass |
| Gas mask (Nursery) | ≤ 8 % of nebula pass; Low preset may disable |
| Worker jobs | sites ≤ 1 s, LOS matrix ≤ 6 s (progress shown) |
| Memory | +50 MB max (site sets, LOS matrices, masks) |

---

## 13. Work packages (ordered)

| WP | Deliverable | Acceptance |
|---|---|---|
| WP-0 Mode shell | `GameMode`, registry, start-screen cards, `cursorMode`, input additions, per-mode controls | Voyage unchanged; stub mode cycles cursor modes and pause correctly |
| WP-1 Overview camera | `SimState.view`, renderer/markers read view, `OverviewCamera`, ghost-clip reuse | Orbit inside Menger with x-ray; markers correct; tween + TAA reset |
| WP-2 Arena + Placement | `Arena`, soft bounds, animation freeze, `Placement` with preview/legality/drag/undo | Test mode passes; 60 fps with 32 objects |
| WP-3 Site sampler | `deTrap` mirrors for all 9 fractals, worker sampler, kNN, DE-reliability check | Node/browser identical; chapter 1–3 arenas pass |
| WP-4 Tracer + Geodesic | segment trace, beam integrator with deflection/spin/capture | far-field deflection within 2 %; determinism test |
| WP-5 LineSystem + GlyphSprites | ribbons in sprite layer, SDF glyphs | shader check passes; occlusion by structure correct |
| WP-6 Accent lights | 4 point lights in nebula material | shader check; ≤ 3 % cost |
| WP-7 Save/daily/share/permalink | persistence, UTC dailies, build-time generator skeleton, share strings, permalinks | round-trip tests; 400 daily files produced by a stub generator |
| WP-8 Atlas + hints | threads, asterisks, hint ladder service | codex card shows threads; hints never auto-open |
| WP-9 Audio hooks | notes in key, stingers, voices, tension | audible on the dev rig; no AudioParam spam (≤ 30 Hz) |
| WP-10 Plate mode | pause, orbit, hide HUD, 2× PNG with permalink chunk | PNG opens; permalink restores pose |

---

## 14. Risks

- **Pointer-lock lifecycle.** The free-cursor state must not break the Chrome re-lock cooldown
  logic in `App.ts`. Keep `lastUnlockAt` semantics; a mode-triggered `requestFreeCursor()` is
  a deliberate unlock, not a pause.
- **Universe refresh from a non-ship position** changes `surfaceDistance` and therefore the
  dust-mote and engine-sound cues; in overview, mute the engine hum and freeze the motes.
- **CPU trap mirrors** are the biggest single chunk of careful work (nine fractals, hashes
  included). Do them one at a time with the readback comparison; the Mandelbulb and Julia
  mirrors already exist for distance and are the template.
- **Worker + GitHub Pages**: no `SharedArrayBuffer` (no COOP/COEP headers). Transfer typed
  arrays; never assume shared memory.
