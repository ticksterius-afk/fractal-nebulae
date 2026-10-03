# 50 — Release and monetization plan

*Evidence in [`research/05-monetization.md`](research/05-monetization.md) and
[`research/04-player-trends.md`](research/04-player-trends.md). Decisions in the README.*

## 1. The shape of it

```
free web (GitHub Pages)                      premium (Steam + itch, Electron)
┌──────────────────────────────┐             ┌──────────────────────────────────────┐
│ Voyage (as today)            │  links to   │ First Light  $12.99  (64 puzzles, Deep,│
│ First Light daily + chapter 1│ ──────────▶ │   atlas, plate mode, achievements, cloud)│
│ Relay daily board            │             │ Relay        $12.99  (11 boards, endless)│
│ Nursery: commissions 1–3,    │             │ Nursery      $12.99–14.99 (+ Name a star)│
│   one sandbox nebula         │             │ Soundtrack apps $4.99 · Supporter $4.99  │
└──────────────────────────────┘             └──────────────────────────────────────┘
```

The web build is the demo and the funnel (Townscaper, Cookie Clicker, Melvor Idle, Roottrees).
It never carries commerce: GitHub Pages disallows sites "primarily directed at facilitating
commercial transactions", and 100 GB/month of bandwidth at 0.6 MB per load is ~160k loads, so
a viral day could exceed the soft limit. If that happens, mirror to Cloudflare Pages (same
static output) and keep the GitHub URL as a redirect.

No ads anywhere: portal ads pay $200–2,000/month at best, 37 % of US desktop users block them,
and they break the one thing the product sells (calm). No subscription: it needs a daily
content treadmill and millions of users.

## 2. Pricing

| Product | Price (USD) | Anchor | Launch discount |
|---|---|---|---|
| First Light | 12.99 | Baba Is You / A Little to the Left 14.99; Stacklands 7.99; 5–8 h authored | 10 % for 7 days |
| Relay | 12.99 | Thronefall 12.99, Balatro 14.99, Slipways 16.99 | 10 % |
| Nursery | 12.99–14.99 | Exo One 16.99, Tiny Glade 14.99, Cloud Gardens 17.99 | 10 % |
| Soundtrack / Album Mode (each) | 4.99 | Baba 2.99, Dorfromantik 5.99, Tiny Glade 6.99 | bundle with the game at +$2 |
| Supporter pack (each) | 4.99 | Supporter packs cluster at $4–7 | none |
| Name a star (Nursery) | 9.99 | RimWorld Name in Game 14.99 | none |
| Dome/Pro (later) | 29–79 | SpaceEngine PRO 69.99 | none |

Zukowski's rules: price 20 % above the comparables that match your quality; build discounts
into the list price; if nobody complains, it is too low. Enter all 37 currencies with Valve's
multi-variable conversion. Steam Direct: $100 per app, recoupable at $1,000; soundtracks are
associated apps (no separate fee). Expectation without an audience: Bronze (< $10k). The free
web app and the daily are the lever toward Silver ($10–149k).

## 3. Products in detail

- **Soundtrack apps.** The music is generative, so each "album" is fixed-seed renders
  (40–60 min, FLAC depot + MP3), one track per chapter/board/commission, plus the finale with
  every voice the player can unlock. Also on Bandcamp (15 %, 10 % after $5k). Attach rate
  0.1–3 %; cheap to make with a Node render script using Tone.js offline rendering.
- **Supporter packs.** 4K plates (eleven ignition moments / finale networks / clusters),
  dome/fisheye plate export, a name in the credits, HUD accent palettes. Purely optional,
  2–7 % attach.
- **Name a star.** Nursery only. Names are filtered (profanity, impersonation), stored in a
  signed `registry.json` shipped with updates, shown in the codex of that nebula. Framed as
  in-game flavour (the IAU names real things; we do not claim to).
- **Dome/Pro.** Only after a planetarium pilot: fisheye/equirectangular export at any
  resolution, commercial screening rights, camera-path editor. Quote-based site licences for
  museums and schools via direct invoice or Steam Site Licensing (Universe Sandbox's model).
  Grants (NASA SciAct, foundations) fund institutions: partner with a planetarium, do not apply solo.

## 4. The Steam build

- **Wrapper:** Electron + `steamworks.js` (Greenworks is best-effort only; Tauri uses
  WebKitGTK on Linux/Deck and is wrong for a WebGL2 raymarcher). Follow `steam-electron-build`
  for the Deck switches (`--no-sandbox --no-zygote --in-process-gpu --disable-dev-shm-usage`),
  library-path ordering and clean exit. Known caveat: the macOS overlay misbehaves; ship Windows
  and Linux first, macOS when verified.
- **Steam features that stop "it's just a website in a window":** achievements (one per
  chapter/board/commission, streaks, Deep levels), Steam Cloud (the JSON save), overlay,
  rich presence ("lighting the Menger Lattice"), a controller scheme.
- **Steam Deck:** Deck Verified needs a default controller config with access to everything,
  matching glyphs, text ≥ 9 px at 1280×800, no unsupported-hardware warnings. The placement
  primitive maps to left stick + trigger (depth on the right trigger axis), the overview camera
  to the right stick; the Voyage's 6-DoF to the two sticks + bumpers. Target 40 fps on Deck at
  the Low preset (dynamic resolution does the rest).
- **Build:** `VITE_MODES` whitelist per product; `dist/` packaged by `electron-builder`;
  one repo, three app ids (plus soundtracks). Size target < 150 MB.
- **itch.io:** same build, 10 % cut, keys for Steam; the web demo embedded via itch's HTML
  player for discovery; "pay what you want" is not used (Steam parity).

## 5. Launch sequence (per product)

1. **M1 Magic test** (playtests) → go/no-go.
2. **M2 Daily live** on the free site. Post once each to r/space, r/fractals, Hacker News
   (Marble Marcher got 345 points there), Fractal Forums, the three.js community. Plate-mode
   images and permalinks are the share currency. Watch referrals; no analytics in the app.
3. **Steam page** with a 40-second trailer (the Einstein-ring shot / a pillar surviving / a
   network lighting up), six screenshots, the "space", "physics", "puzzle"/"strategy"/
   "simulation", "relaxing", "education", "exploration" tags. **Never "cozy".** Wishlist goal
   7–10k before launch (Popular Upcoming threshold).
4. **Demo** that is content-limited and replayable (Balatro), entered into a Next Fest; demo
   peak CCU × 3 predicts launch (median); 70 CCU implies a Silver launch.
5. **Launch** on a Tuesday–Thursday, 10 % discount for 7 days, soundtrack and supporter pack
   day one (worth it above ~$10k expected), review keys to the astronomy/maths YouTube space
   (Kurzgesagt 25.6 M, 3Blue1Brown 8.4 M, Numberphile 4.7 M subscribers; aim for the long tail
   around them, not the channels themselves).
6. **Post-launch:** the editor (Marble Marcher's community asked first), monthly dailies
   themes, then the next product reusing the same funnel.

## 6. Legal and licensing checklist

- Add `LICENSE` (PolyForm Noncommercial 1.0.0) and `THIRD-PARTY-NOTICES.md` (three.js MIT,
  Tone.js MIT, @fontsource Rajdhani / JetBrains Mono / Inter under the SIL OFL: bundling and
  selling the game is allowed; fonts may not be sold standalone). Keep contributions out or add
  a CLA if relicensing later is a possibility.
- Trademark search for the product names before the Steam page ("First Light" has prior uses).
- Name-a-star: terms of service clause ("in-game only; no claim over real objects"), filtering,
  refunds within 14 days.
- Privacy: no telemetry, no accounts; the Electron build stores saves locally and in Steam
  Cloud only. A one-page privacy note on the site.
- Education licences: Steam Site Licensing for venues; direct invoices for schools; DRM-free
  copy on request (Universe Sandbox's practice).

## 7. What success looks like (and when to stop)

| Signal | Bronze (expected) | Silver (goal) |
|---|---|---|
| Daily players (web, estimated from bandwidth) | hundreds | thousands |
| Wishlists at launch | < 3k | 7–10k |
| Demo peak CCU | < 25 | ≥ 70 |
| First-month gross | < $10k | $10–50k |
| Reviews at 90 days | < 100 | 300+ at ≥ 90 % |

If First Light lands Bronze with poor reviews, stop at one product and keep the free site. If
it lands Bronze with strong reviews, Relay reuses the funnel at low cost. Silver funds Nursery.
