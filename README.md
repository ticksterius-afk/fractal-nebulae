# Fractal Nebulae

*A voyage through infinite structure.*

Ride an invisible gravity-drive ship through a universe where the nebulae are **raymarched 3-D
fractals**: the Mandelbulb, the Mandelbox, the Menger sponge, a quaternion Julia set,
Sierpiński's pyramid, an Apollonian pearl foam, a Kleinian web, a kaleidoscopic snow crystal and
a Lichtenberg lightning tree. There are also two **black holes** whose accretion disks are the
Mandelbrot set and a Julia set. Every nebula has its own generative score and a codex entry that
explains what the shape is, where it turns up in nature, and a few surprising facts. You can fly
into any of them and keep diving: there is always finer detail.

It is also the home of **First Light**, a calm puzzle game played inside the same nebulae: one star
shines, dark seeds wait in the structure, and you place gravitational lenses (point masses that bend
light exactly as general relativity says) to steer the beam around fractal walls, through tunnels and
off reflecting pearls until every seed ignites. Pick **Voyage** or **First Light** on the start screen.

## ▶ Play it in your browser

**<https://ticksterius-afk.github.io/fractal-nebulae/>**

Nothing to install: open the link in **Chrome or Edge** on a computer with a mouse and
keyboard, wait for the shaders to compile, press **Launch**, and put on headphones. The page
loads about 0.6 MB. A dedicated graphics card makes a big difference; on a laptop, pick **Low**
or **Medium** quality on the start screen. Phones and tablets aren't supported (the controls
need a mouse and keyboard).

The site is rebuilt and republished automatically on every push to `main`
(`.github/workflows/deploy.yml`: validate shaders → validate First Light → type-check → build → GitHub Pages).

## Run it locally

You need:

* **Node.js 20.19+ or 22.12+** (the current LTS from <https://nodejs.org> is the easy choice).
* A **WebGL2 browser**. Chrome or Edge are recommended; the look and performance were tuned on
  a GTX 1080 at 2560×1440. A discrete GPU helps a lot.
* **Headphones.** The music is generated live and follows where you fly.

**Windows:** double-click **`start.bat`**. It checks Node.js, runs `npm install` the first
time, starts the dev server and opens <http://localhost:5190> in your default browser as soon as
it is ready. Keep its window open while you fly and press Ctrl+C there to stop. If port 5190 is
already taken, it tells you. If the program on that port is Fractal Nebulae itself (for example
because you started it twice), it just opens the page.

**Any system:**

```bash
npm install
npm run dev        # → http://localhost:5190
```

The port is fixed. If something else already uses it, Vite stops with "Port 5190 is already in
use"; close that program or change `server.port` in `vite.config.ts`.

| Script | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload on <http://localhost:5190> |
| `npm run build` | Type-check, then a production bundle in `dist/` |
| `npm run preview` | Serve `dist/` on <http://localhost:5191> |
| `npm run typecheck` | TypeScript only |
| `npm run check:shaders` | Validate every GLSL program offline (also runs before each deploy) |
| `npm run check:game` | First Light: beam-tracer physics, platform helpers, every authored level, the daily bundles, puppet flight (also runs before each deploy) |

`dist/` uses relative paths, so any static web server can host it, from any folder.
Opening `dist/index.html` straight from disk doesn't work, because browsers block ES modules on
`file://`.

## Your first flight

1. **Loading.** Behind the start screen the universe is already drifting past in attract mode,
   while every nebula's shader compiles. The progress bar names each program as it goes. The
   first load can take a little while, because on Windows each raymarcher is translated to
   Direct3D. Later loads are usually quicker thanks to the browser's shader cache.
2. **Launch.** Pick a render quality (you can change it at any time), then click **Launch** or
   press **Enter**. That click or key press captures the mouse pointer and starts the music.
   Browsers allow both only after you interact with the page.
3. **Pause.** **Esc** releases the mouse and pauses. The pause screen holds the settings and the
   full list of controls. **Resume** (the button or Enter) captures the pointer again. Chrome
   refuses a new capture for about a second after Esc, so a quick Resume waits that moment out.
   If a capture is ever refused, the pause screen says so; click Resume again.
4. **Hints.** A small controls card stays up for your first minute of flight. You can switch it
   off in the settings.

## Controls

| Input | Action |
|---|---|
| Mouse | Look around (raw, unaccelerated movement where the browser supports it) |
| W / S | Thrust forward / reverse |
| A / D | Strafe left / right |
| R / F | Rise / sink |
| Q / E | Roll |
| Shift (hold) | Precision: one-fifth speed, for delicate dives |
| Mouse wheel | Cruise throttle (×1.25 per notch, from ×0.05 to ×4) |
| **Left mouse** | Target the nebula under the reticle: name, distance, ETA, light-time and its codex card. Clicking empty space clears the target. |
| **Right mouse (hold)** | Hyper: up to 40× faster, with relativistic aberration, Doppler colours and star streaks. Held on its own, it drives you forward. It also turns on **ghost mode**: collisions are off, so you can fly into and through structure — the way out of any tight spot. Inside a solid the hyper boost fades and you slow to a phasing pace set by how thick the wall ahead is, so any wall takes about 2–3 seconds. The structure you are inside turns to translucent glass, with glowing edges, so you can see where you will come out. The music is muffled while you phase. Let go mid-wall and ghost stays on, carrying you along your last direction until you are back in open space. |
| **Space (tap)** | Resonance pulse: a wavefront sweeps outward, lights up the structure and reveals every nebula on the HUD for 10 s |
| **Space (hold)** | Gravity-glide: autopilot to your target (or the nebula under the reticle, or the nearest one), then a slow orbit |
| T | Voyage: a zen tour of every nebula, orbiting each for about 40 s. Press T again to stop. |
| Tab / I | Codex card: open and pin, then close |
| H | Hide or show the HUD (cinematic mode) |
| M | Mute or unmute the music (sound effects stay on) |
| Esc | Pause & settings. In full screen the app keeps full screen while paused; **hold** Esc to leave full screen. |
| F11 or Alt+Enter | Full screen on / off (Launch enters full screen when the start-screen switch is on) |
| Enter | Launch (start screen) · Resume (pause screen) |

Any movement key, deliberate mouse movement or hyper hands control back from the autopilot.
Keys are read by position, so WASD sits in the same place on every layout; the letters shown are
US-QWERTY. The pause settings cover render quality (applies live), music and effects volume,
mouse sensitivity (0.2–3×), field of view (60–100°), invert mouse Y and control hints. They are
saved in your browser.

## First Light (puzzle)

Choose the **First Light** card on the start screen (or open the page with `?mode=firstlight`) and
press **Launch**. A first visit starts the first puzzle straight away; after that the **Atlas** opens,
with the chapters, your progress and the daily puzzle.

**The idea.** Each puzzle is a small arena inside a nebula. One star sends out a beam. Dark seeds
(ember rings) wait in the structure, and you have a few masses to place. A mass bends light toward
itself, by α ≈ 2rₛ/b for a pass at distance b (the deflection Eddington measured in 1919), and the
closer the pass, the harder the bend. Too close, inside about 2.6 rₛ, and the light falls in. Light
passes through lit seeds, dies on ordinary fractal surfaces, and bounces off the pearls of the Pearl
Foam and the walls of Indra's Web, losing 30 % at each bounce. Light every seed and they ignite.
Nothing can go wrong: no timer, no failure. A captured or blocked beam just shows you where the light
went.

**What you see.**
* **Beam:** a warm thread with slow pulses flowing away from the star. It stays faintly visible behind walls.
* **Seeds:** an ember ring brightens as the beam comes close ("almost"); a faint line joins it to the beam's nearest point.
* **Masses:** lenses that follow the real point-lens equation (with a smaller ring, so the puzzle stays readable): a black shadow with a thin photon rim, and the nebula visibly bent around it.
* **Lit seeds:** become teal stars and light up the fractal around them.

| Input | Flight (default) | Lab view (Tab) |
|---|---|---|
| Mouse | Look | Pointer |
| W A S D, R F, Q E, Shift | Fly slowly inside the arena | — |
| Left mouse | Place the selected mass at the preview point; press on a mass to grab it | Place at the cursor and keep dragging; drag a mass in the view plane |
| Right mouse | Remove the mass under the reticle | Drag to orbit; click a mass to remove it |
| Wheel | Placement depth (or grab distance) | Zoom; while dragging, move along the cursor ray |
| Shift while dragging | Precision ×0.2 | Precision ×0.2 |
| 1 / 2 / 3 | Light / medium / heavy mass | same |
| X · Z · Shift+Z · C | Remove · undo · redo · clear all (undoable) | same |
| Tab | Lab view: an orbit camera around the arena, structure in front turns to glass | Back to flight |
| Backspace | Glide back to the vantage point | Re-frame the arena |
| Space | Pulse: seeds and masses glow for 10 s | same |
| ? | Hints, opt-in, in three steps: what to notice, where, the designer's note | same |
| I · H · M · Esc | Codex card · hide HUD · mute music · pause (Atlas, restart, switch to Voyage) | same |

Placement depth snaps to the beam: when the reticle or cursor passes near the beam, a new mass lands
beside it at the beam's own depth, so most placements are as simple as pointing at the spot next to
the light.

**Content.** Three chapters of six puzzles, all open from the start:
* **Bend** (The Cauliflower): bending, close passes, capture, bends in series.
* **Thread** (The Menger Lattice): threading tunnels; the last puzzle repeats an earlier junction at one third the scale.
* **Reflect** (The Pearl Foam): bounces off pearls, mixed with bends.

Solving with the fewest masses earns ✦.

**The daily.** A new puzzle every day at 00:00 UTC, the same for everyone. Mondays and Tuesdays use
one mass; later in the week brings two, Saturday three, and Sunday a harder arena. Unlimited attempts,
no score. When you solve it, the result card makes a spoiler-free share line, e.g.
`First Light #42 · Menger · ◆◆◇  ⚬⚬  1:12`, and counts your streak. The next 400 days are
pre-generated in `public/daily/firstlight/` (with a runtime fallback), so the site needs no server.
Progress, streak and seen tips are saved in your browser (`localStorage`).

## The HUD

* **Top left:** where you are. It shows the nebula's name and catalogue number (or "Interstellar
  Void" and the nearest nebula), its fractal type and dimension, the distance to the nearest
  surface, and a zoom gauge when you dive deep into structure.
* **Bottom centre:** speed. The headline switches from km/s to AU/s to ly/s as you accelerate,
  with multiples of *c*, mph and AU/s underneath. Below that are the throttle, the precision and
  hyper indicators (with the visual β), and the autopilot status.
* **Bottom left:** gravity, time dilation, tidal stress and wormhole progress, shown only when
  they matter. Between nebulae, short facts drift by here.
* **Centre:** the reticle. A locked target gets brackets with distance, ETA and light-time, or an
  arrow at the screen edge while it is off-screen. After a pulse, every nebula is marked.
* **Right:** the codex card. It opens by itself when you lock a target or first enter a nebula,
  and hides again after 12 s unless you pin it with Tab or I. The mouse is captured in flight, so
  long entries scroll themselves slowly.
* A banner greets every nebula you enter. The first time you meet each effect (hyper and its
  relativistic aberration, lensing, time dilation, the wormhole, the pulse, deep zoom), a
  one-line physics tip explains it.
* **Bottom right corner:** a faint readout of fps and the current internal resolution.

## Quality presets

| | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Internal resolution (dynamic) | 30–60 % | 35–75 % | 45–90 % | 60–100 % |
| Temporal upscaling (TAAU) | off | on | on | on |
| Raymarch steps per nebula | 90 | 130 | 170 | 240 |
| Fractal iterations | ×0.7 | ×0.85 | ×1 | ×1.25 (capped per fractal) |
| Soft shadows | – | – | ✓ | ✓ |
| Ambient-occlusion samples | 0 | 3 | 4 | 5 |
| Sky cubemap face | 1024 | 1536 | 2048 | 2048 |
| Far stars / near stars / dust | 1.2k / 2.5k / 1.2k | 2k / 4k / 2k | 2.8k / 6k / 3k | 3.6k / 8k / 4k |

Every preset aims for 60 fps. If frames run slow, the internal resolution drops in small steps.
When there is headroom (measured with a GPU timer where available), it climbs back. TAAU renders
at the lower resolution with sub-pixel jitter and accumulates the result at full screen
resolution, so a 45 % internal resolution still looks crisp. Nebulae far away get fewer steps
and iterations, so distant ones are cheap. The output resolution is the window size × the
display's pixel ratio (capped at 2).

## What you're seeing

* **Speed follows the scale of the structure, smoothly.** Your cruise speed scales with how
  much room there is: the distance to the nearest surface, raised toward the free path along your
  thrust (so corridors and backing away are fast). That scale is smoothed over about a second, so
  the speed stays uniform while you pass florets and pillars; diving into finer detail still slows
  you gradually, and a wall straight ahead brakes you in proportion to how soon you would reach it.
  Blocked moves slide along surfaces. Every move is sphere-traced against the same distance
  estimator the GPU draws with (mirrored exactly in JavaScript), so you never clip a wall.
* **Real scale.** One world unit is one light-year. The fractal structures are 80–120 ly across,
  like real star-forming regions, and each is wrapped in a glowing gas halo 2.5× wider. The whole
  catalogue spans about 2,700 ly. The speed readouts are honest arithmetic, but the drive itself
  is fiction: 1 ly/s is about 31.6 million times the speed of light.
* **Relativity.** At hyper speed the sky crowds toward your direction of travel and turns bluer
  ahead, redder to the sides and behind. The effect uses the exact aberration and Doppler
  formulas, with a visual β up to 0.9.
* **Black holes.** Light paths are integrated per pixel through Schwarzschild spacetime: the
  Milky Way is lensed, with an Einstein ring and a photon ring, and the fractal accretion disk is
  Doppler-beamed and redshifted. *Ouroboros* spins (χ = 0.9): it has jets and a frame-dragging
  swirl, a visual stand-in for the full Kerr geometry. *The Maw* is the simplest kind, with no
  spin at all. Near a horizon, time dilation √(1 − rₛ/r) slows and deepens the music and tidal
  stress rises. Hyper can pull you out until about 1.3 rₛ. Cross a horizon and a five-second
  Einstein–Rosen bridge carries you to another nebula (poetic licence: real ones pinch shut).
* **Music.** Each nebula has a profile with its own key, tempo and instruments, and melodic
  rules that echo its mathematics. The Menger lattice plays a Cantor-set rhythm, Sierpiński's
  pyramid reads Pascal's triangle, the pearl foam keeps Fibonacci time, and Indra's web answers
  itself in canons and mirror images. Two decks crossfade (about 7 s) as you move between
  regions.

| Nebula | Fractal | Size | Music |
|---|---|---|---|
| The Cauliflower Nebula | Mandelbulb, power 8 | ~90 ly | D Lydian · 64 bpm |
| The Menger Lattice | Menger sponge | ~55 ly cube | C♯ minor pentatonic · 3/4 · 72 bpm |
| The Cathedral Nebula | Mandelbox, scale 2.75 | ~60 ly cube | A Dorian · 56 bpm |
| The Julia Veil | Quaternion Julia set (3-D slice) | up to ~85 ly | E♭ Lydian augmented · 60 bpm |
| Sierpiński's Pyramid | Sierpiński tetrahedron | ~60 ly tall | A major pentatonic · 80 bpm |
| The Pearl Foam | Apollonian sphere packing | ~90 ly ball | F Dorian · 66 bpm |
| Indra's Web | Pseudo-Kleinian limit set | ~120 ly | B Dorian · 58 bpm |
| The Frost Kaleidoscope | Kaleidoscopic IFS snow crystal | up to ~80 ly | E Lydian · 76 bpm |
| The Lichtenberg Nebula | Branching dendrite | up to ~110 ly | G Mixolydian · 70 bpm |
| Ouroboros | Kerr black hole · Julia-set disk · jets | rₛ = 3 ly | B Phrygian · 48 bpm |
| The Maw | Schwarzschild black hole · Mandelbrot disk | rₛ = 5 ly | C minor, Locrian hints · 40 bpm |

The codex computes its sizes and black-hole figures (mass, horizon, ISCO, Hawking temperature)
from the live catalogue, so they stay right if the universe is retuned.

## Troubleshooting

* **"WebGL2 is not available":** update the browser and make sure hardware acceleration is on
  (Chrome: Settings → System; Edge: Settings → System and performance; then "Use graphics
  acceleration when available").
* **Laptop with two GPUs:** in Windows Settings → System → Display → Graphics, set Chrome or
  Edge to *High performance*.
* **The cursor is visible in flight:** click Resume, or click the scene. The browser has to
  capture the pointer again, and Chrome waits about a second after Esc before it allows that.
* **No sound:** sound starts with Launch. Check that the music isn't muted (M), the volume
  sliders in the pause screen, and that the browser tab itself isn't muted.
* **Low frame rate:** choose a lower quality. Dynamic resolution handles moderate dips on its
  own.

## Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module contracts, the frame pipeline and the
design notes. In short:

| Folder | What lives there |
|---|---|
| `src/app/` | App shell and frame loop, quality presets, settings, global tuning |
| `src/core/` | Shared types (the contracts), event bus, units & formatting, math |
| `src/universe/` | The nebula catalogue and the Universe (runtime state, world distance estimator, picking) |
| `src/fractals/` | One file per fractal: GLSL distance estimator plus an exact JavaScript mirror used by flight |
| `src/fractals/blackhole/` | Geodesic-raymarched black holes: fractal accretion disks, jets, lensed sky |
| `src/render/` | Renderer, nebula raymarch template, sky cubemap, stars/dust sprites, bloom, TAAU, composite, wormhole |
| `src/sim/`, `src/ship/` | Flight model and simulation state, input and pointer lock, autopilot and voyage |
| `src/audio/` | Tone.js generative score (profiles, two-deck director, motifs) and sound effects |
| `src/hud/`, `src/styles/` | DOM HUD, codex card, start and pause screens |
| `src/content/` | Codex texts, void facts, physics tips (figures derived from the catalogue) |
| `src/game/` | Game modes: `modes.ts` (registry), `platform/` (mode contract, orbit camera, save, daily, share, PRNG), `firstlight/` (the puzzle: tracer, solver, generator, mode, HUD, levels) |
| `src/render/game/` | The game overlay: beam ribbons, SDF glyphs, star sprites (lenses and accent lights feed the composite and the nebula shader) |
| `public/daily/` | Pre-generated First Light dailies (one JSON per month) |
| `tools/` | Developer tools (not part of the app, see below) |

**Developer tools** (run TypeScript ones with `npx tsx`):

* `tools/glsl-check.ts`: offline GLSL ES 3.00 validation with glslangValidator (the bundled
  Windows build). It emulates the prefix three.js r186 adds to a ShaderMaterial and exports
  `checkShader` / `checkMaterial`.
* `tools/check-all-shaders.ts`: runs that check on every shader program the app builds, for all
  four quality presets, and asserts the no-`glslVersion` rule: `npx tsx tools/check-all-shaders.ts`
  (add a word such as `nebula` to check only matching programs). `tools/check-contracts.ts`
  checks just the shared GLSL; `tools/_lead_check.ts` just the nebula materials at High.
* `tools/cpu-render.ts`: `renderFractalPNG()`, a CPU raymarch preview of a fractal's JavaScript
  distance estimator written to a PNG (import it from a script).
* **First Light tools:**
  * `tools/fl-trace-check.ts`: beam-tracer physics tests. It checks deflection against exact Schwarzschild, the capture threshold, reflection, seed hits and determinism.
  * `tools/fl-check.ts`: runs the gates on every authored level. A level must be solvable, minimal and click-reachable, with no accidental solutions, player-sized tolerance, and a free vantage.
  * `tools/fl-solve.ts`: `generate` / `gates` / `solve` / `arenas` for designing levels.
  * `tools/fl-preview.ts`: CPU-rendered PNGs of a level from its vantage and a lab angle, with or without the solution.
  * `tools/fl-arenas.ts`: finds and curates arenas.
  * `tools/fl-reach.ts`: the click-reachability gate (used by fl-check) and the bundled-daily audit (`--dailies`, `--bundle YYYY-MM`).
  * `tools/fl-daily-build.ts` and `tools/fl-daily-check.ts`: build and validate the daily bundles. `fl-daily-check --fast` (part of `check:game`) checks that every day of the window is bundled, valid and on schedule, that at least 60 bundled days remain ahead of today, and the loader paths (two quick runtime regenerations must match the bundle).
  * `tools/platform-check.ts`: tests the orbit camera, daily ids, share string and save.
  * `tools/flight/*.mts`: the collision-safety and puppet flight harnesses.
  * `/tools/fl-hud-preview.html` (dev server): the First Light HUD with mock data, every state.
* `tools/devtools.js`: a console helper for visual tuning, dev server only. `fakeLock()` stands in for
  pointer lock, which embedded browser panes refuse. `flRig()` adds First Light playtest helpers:
  `__playLevel(id)`, `__aim`, `__click`, `__key`, `__run`, and `__shot(name)`, which posts a canvas
  JPEG to `tools/shot-receiver.mjs` (start it with `npm run shots`; it writes to a temp folder). Load it with
  `await import('/tools/devtools.js').then(m => m.setup())`. It relies on `window.__app`, which
  exists only in dev builds.
