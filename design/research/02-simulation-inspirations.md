# Simulation / Zen / Exploration Inspirations for Fractal Nebulae

Research date: 2026-10-02. Scope: what players and critics praise or reject in relaxing exploration sims, software toys, music-driven games, educational simulations, idle loops, and asynchronous sharing systems, and how each could map onto a browser-hosted (GitHub Pages, no heavy backend) 6-DOF fractal-nebula flight app.

All claims below are paraphrased from the cited pages; the sources list at the end gives every URL used.

---

## (a) Per-game notes

### 1. Space exploration and flight with a relaxing or scientific bent

**Outer Wilds.** Progression is purely knowledge: nothing is unlocked by items or stats, only by what the player has learned, and the ship log stores that knowledge as a web of "rumours" with an asterisk marking locations not yet fully explored. There are no quest markers; players go as far as curiosity takes them. A First Person Scholar essay frames the game as being about passing information on and leaving something behind. Steam-review aggregation shows exploration (54 mentions) and knowledge-based progression (20) as top praise, but also 20 complaints about ship/suit controls and 13 about lack of direction, with many players resorting to external guides. Lesson: knowledge progression works when the log itself tells you where loose threads remain. ([Edge via PressReader](https://www.pressreader.com/australia/edge/20190620/282278141843961), [First Person Scholar](https://www.firstpersonscholar.com/?p=6333), [GamingTrend](https://gamingtrend.com/feature/reviews/little-big-universe-outer-wilds-review), [VaporLens Outer Wilds](https://vaporlens.app/app/753640/outer_wilds))

**Elite Dangerous.** The first-discovery tag is the canonical "your name on a star" system: you must fully scan a system and sell the data back at a station before your name is attached; merely visiting does not count. The routine is honk (discovery scan), compare body count on the system map, FSS every body worth scanning, then optionally surface-map Earth-likes and water worlds. Remote routes raise the chance of a +50% first-discovery bonus. Unexplored bodies stay unexplored for new players so the first discoverer never loses the tag. Steam aggregation: 42 praise the 1:1 Milky Way, but 22 cite a steep learning curve, 19 insufficient tutorials, 17 grind. ([Engadget](https://www.engadget.com/2014-09-08-elite-dangerous-explores-the-path-of-exploring.html), [Steam discussion](https://steamcommunity.com/app/359320/discussions/0/1749023631425199965), [VaporLens Elite](https://vaporlens.app/app/359320/elite_dangerous))

**No Man's Sky.** Players name systems, planets, flora and fauna and must manually upload each discovery for credit; unuploaded finds can be claimed by someone else. Uploads pay nanites. A 2016 scare that discoveries were deleted after two weeks turned out to be server-sync lag, but the panic itself showed how central naming is to retention: commentators said without it exploration would feel meaningless. Aggregated reviews rank exploration and discovery as the top praise (34 mentions) and lack of planetary diversity as the top complaint (26), with repetitive missions (19) close behind. ([Shacknews naming guide](https://www.shacknews.com/article/96223/how-to-name-animals-and-plants-in-no-mans-sky), [Shacknews deletion story](https://www.shacknews.com/article/96530/no-mans-sky-appears-to-delete-your-discoveries-after-two-weeks-updated), [NMS wiki Discoveries](https://nomanssky.fandom.com/wiki/Discoveries), [VaporLens NMS](https://vaporlens.app/app/275850/no_mans_sky))

**Starfield.** The cautionary case. Players called it a loading-screen simulator (24 mentions), with empty procedurally generated planets and menu-driven fast travel undermining the fantasy of seamless exploration. Bethesda's reply that the Moon was also empty when astronauts landed was widely mocked. Ship-building (24) and faction content were praised; the exploration loop itself was not. ([80.lv](https://80.lv/articles/bethesda-continues-to-defend-starfield-by-replying-to-steam-reviews), [VaporLens Starfield](https://vaporlens.app/app/1716740/starfield), [Know Your Meme](https://trending.knowyourmeme.com/news/bethesda-is-telling-its-critics-on-steam-that-starfield-is-not-boring-actually))

**SpaceEngine.** A 1:1 planetarium, not a game, and its reviews read exactly that way: praise for educational information, freedom, and visuals; complaints about repetitive, boring, content-light play, and poor controls as the single largest churn driver (16.7% of negative mentions). Relevant because Fractal Nebulae is structurally closest to this product. ([GOG](https://gog.com/game/spaceengine), [VaporLens SpaceEngine](https://vaporlens.app/app/314650/space_engine/stats/analysis))

**Noctis IV (2000).** 78 billion procedural stars in a 2 MB DOS program. Its GUIDE system let players name stars and planets and write notes, e-mail them to the author, who compiled them into the next release's starmap; a community formed around this and competed for records such as the system with the most planets. Ghignola noted that a game made about solitude became about connecting with people. This is the lowest-infrastructure "shared discovery" model on record and fits a static-hosted app. ([Time Extension](https://timeextension.com/features/the-making-of-noctis-the-no-mans-sky-forerunner-whose-creator-retreated-from-the-world), [Wikipedia](https://en.wikipedia.org/wiki/Noctis_(video_game)), [Home of the Underdogs](https://homeoftheunderdogs.net/game.php?id=2950))

**Exo One.** A momentum game: dive with the gravity drive, release at a crest, glide. Reviewers describe a trance-like flow when chaining slingshots, but note the slow pace is divisive, one asteroid-belt level caused motion sickness, and the structure is linear. ([NME](https://www.nme.com/reviews/exo-one-review-a-melancholy-trip-through-the-lonely-cosmos-3096892), [TheXboxHub](https://www.thexboxhub.com/exo-one-review/), [FingerGuns](https://fingerguns.net/reviews/2021/11/27/exo-one-review-xbox-series-dancing-with-the-stars/))

**Everything (David OReilly).** You become any object smaller or larger than you, across scales from particles to galaxies; the first time you bond with a form it is added to an encyclopedia; an autoplay mode keeps the world going without you. Polygon called it a playpen of being rather than doing; critics found the Alan Watts audio heavy-handed. The encyclopedia-on-first-bond and scale-shifting are directly relevant to infinite zoom. ([Wikipedia](https://en.wikipedia.org/wiki/Everything_(video_game)), [EGM](https://egmnow.com/?p=343))

**Flower, Journey, Abzu.** Flower's team cut deeper mechanics because challenge, while fun, was not relaxing; the music is layered acoustic tracks that swell with player action. Abzu removed the air gauge and timers, added meditation pedestals to simply watch fish, and was criticised only for limited interaction. Journey's multiplayer is covered in section 5. ([Wikipedia Flower](https://en.wikipedia.org/wiki/Flower_(video_game)), [Wikipedia Abzu](https://en.wikipedia.org/wiki/Abz%C3%BB))

**Proteus.** No goals, no verbs beyond walking; the island's reactive music is triggered by your path (creatures, trees, rain each add parts). Critics loved the first 20 minutes and said the joy faded later; AV Club still called it uncommonly confident. The honest lesson: a reactive-music toy alone sustains roughly one session. ([PC Gamer](https://www.pcgamer.com/proteus-review), [AV Club](https://www.avclub.com/proteus-review-pcmac), [bit-tech](https://www.bit-tech.net/reviews/gaming/pc/proteus-review/1/))

**Sable.** No combat, cartographers sell maps, pure exploration. Praised for mood; recurring criticism is drifting aimlessly with too little to do moment-to-moment. ([Stuff](https://www.stuff.tv/game-reviews/sable/review), [WellPlayed](https://www.well-played.com.au/sable-review/), [Twinfinite](https://twinfinite.net/reviews/sable-review-style-over-substance/))

**Eastshade.** Painting is the core verb and is literally framing a screenshot; GameSpot praised it as a genuinely feel-good game for making a non-violent open world work. Shows a photo mode can be the main loop, not a side feature. ([Wikipedia](https://en.wikipedia.org/wiki/Eastshade))

**A Short Hike.** The designer's stated principles: a tiny open world where curiosity is rewarded by placing things off the obvious path; feathers as soft gating rather than hard locks; side activities (fishing, boating) to break up traversal; low-resolution art so the player's imagination fills in detail. ([PlayStation Blog](https://blog.playstation.com/2021/08/05/crafting-a-tiny-open-world-a-look-behind-the-scenes-at-the-creation-of-a-short-hike/))

**Jett: The Far Shore.** The anti-example for scanning. Reviewers found the loop of flying to points and scanning creatures repeatedly a chore, including one segment of 20 minutes of aimless scanning; the ship was sluggish in tight spaces with a camera that wandered. What was praised: long skims over open ocean and the score. ([CogConnected](https://cogconnected.com/review/jett-far-shore-review/), [Checkpoint](https://checkpointgaming.net/reviews/2021/10/jett-the-far-shore-review-lost-in-space/), [WayTooManyGames](https://waytoomany.games/2021/10/05/review-jett-the-far-shore/))

**Observation.** You are the station AI; every action is an interface action (connect to a system before you can open its hatch). BAFTA-winning; relevant as a model for a HUD-as-character and for making a "scan" feel like operating an instrument rather than pressing a button. ([Wikipedia](https://en.wikipedia.org/wiki/Observation_(video_game)))

**In Other Waters.** Exploration through a two-colour instrument panel; scanning fills a taxonomy log and enough sightings of one species unlock a detailed illustration. The reviewer argued the deliberately laborious scan-move-scan rhythm makes you think like a field scientist, and criticised the few timed oxygen sections for contradicting the game's own contemplative design. ([GameCritics](https://gamecritics.com/mike-suskie/in-other-waters-review/), [GameSpot](https://www.gamespot.com/reviews/in-other-waters-review/1900-6417449/))

**Mars First Logistics.** Build rovers from parts, deliver awkward cargo; failures read as a blooper reel rather than punishment. Best for patient tinkerers. ([Wikipedia](https://en.wikipedia.org/wiki/Mars_First_Logistics))

**Photo modes in general.** Bugnet's design piece: a photo mode is a creative verb beyond the core loop, every shared screenshot is authentic marketing, and the minimum viable set is pause, detached orbit camera, FOV, hide UI, clean hi-res export, ideally shipped as a mid-cycle update. Game Informer notes photo mode slows players down and changes how they look at a world. ([Bugnet](https://bugnet.io/blog/designing-photo-modes-players-actually-use), [Game Informer](https://www.gameinformer.com/b/features/archive/2017/11/22/opinion-photo-mode-matters-in-modern-gaming.aspx))

### 2. Cozy / zen simulation and software toys

**Townscaper.** By Stalberg's own description a toy, not a game: two verbs (add/remove block, pick colour) and a wave-function-collapse system that decides what architecture appears. Hidden "recipes" (special combinations) give discovery moments inside a toy. He expected 40-minute sessions and was surprised by the scale of what people built; the audience extended well beyond gamers via social media. ([Game Developer](https://gamedeveloper.com/blogs/how-townscaper-works-a-story-four-games-in-the-making), [Wikipedia](https://en.wikipedia.org/wiki/Townscaper))

**Tiny Glade.** 616k Steam sales in the first month, 34k daily players, median playtime just over an hour, which GameDiscoverCo calls good for a sandbox with no goals. Complaints: restricted build area, limited variety. Success attributed to two years of viral social clips and Next Fest demos. ([WN Hub](https://wnhub.io/news/investment/item-45983), [PC Gamer](https://pcgamer.com/games/city-builder/tiny-glade-review), [VaporLens](https://vaporlens.app/app/2198150/tiny_glade))

**Dorfromantik.** Tile placement with score and gentle quests; after unexpected popularity the devs added creative (unlimited tiles), quick, and challenge modes. Reviewers split on depth, with one describing a gap between pure relaxers and perfectionist scorers with nothing in between. ([Wikipedia](https://en.wikipedia.org/wiki/Dorfromantik), [Toukana](https://toukana.com/dorfromantik))

**Islanders.** Strips resources, timers and enemies; placement scores points, points unlock the next building pack, the run ends when you run out. A score is the only "game" layer over the toy, and it is enough. ([Into Indie Games](https://intoindiegames.com/reviews/islanders-review/), [Pixel Poppers](https://pixelpoppers.com/review/islanders/))

**Cloud Gardens.** Explicitly hovers between sandbox toy and game: a chapter campaign of small dioramas plus a free sandbox. Growth-and-decay theme. ([Nintendo Life](https://www.nintendolife.com/reviews/switch-eshop/cloud-gardens), [WayTooManyGames](https://waytoomany.games/2022/07/26/review-cloud-gardens-switch/))

**Mini Metro / Mini Motorways.** Postmortem: constraints (no hand-built levels, no art-heavy assets) drove the design; every sound is generated procedurally from game events (Disasterpeace); a free web-playable build is credited with the studio's survival. ([Game Developer postmortem](https://gamedeveloper.com/audio/postmortem-dinosaur-polo-club-s-i-mini-metro-i-), [Indieorama interview](https://www.indieorama.com/mini-metro-and-robert-curry-the-minimalism-was-one-of-the-things-that-made-the-game-hard-to-make))

**Sandspiel / The Powder Toy / Noita.** Bittker: single elements are simple, the interactions are where complexity lives; play is asking questions ("what does fungus do?"); low-fidelity pixels invite projection; the public gallery of the old Powder Game produced a micro-culture of toys, demos and art, and most Sandspiel users treat it as a paint program. Noita's engine simulates nearly every pixel and critics praised the emergent experimentation. ([Making Sandspiel](https://maxbittker.com/making-sandspiel), [Wikipedia Noita](https://en.wikipedia.org/wiki/Noita_(video_game)))

**Universe Sandbox.** No objectives, pure what-if physics. bit-tech's key criticism: the lack of scientific explanation is its most ironic flaw, so enjoyment plateaus once you stop knowing why things happen. Directly relevant to the codex: show the maths. ([bit-tech](https://bit-tech.net/reviews/gaming/pc/universe-sandbox-review/1/), [Common Sense Education](https://www.commonsense.org/education/game/universe-sandbox))

**Spore's Space stage.** Seamless zoom from galaxy to surface years before Elite or NMS, but every mechanic was diluted to a few clicks, there was no real goal, and the earlier stages ended up feeling like a long tutorial. ([bit-tech 10 Years On](https://bit-tech.net/features/gaming/pc/10-years-on-spore/1/), [Giant Bomb](https://giantbomb.com/reviews/spore-review))

**Oxygen Not Included / Timberborn.** Deep gas, liquid, heat and water simulations are the praised core; both are criticised for onboarding and complexity that deters casual players. ([Wikipedia ONI](https://en.wikipedia.org/wiki/Oxygen_Not_Included), [Wikipedia Timberborn](https://en.wikipedia.org/wiki/Timberborn))

**Terra Nil.** A comforting, repeatable rhythm per region (cleanse, green, rewild, recycle, leave no trace), with the only real tension being permanent placement. Reviewers describe it as an order-of-operations puzzle rather than a builder. ([Adele Chapline](https://adelechapline.substack.com/p/review-terra-nil-is-comfortingly), [PC Gamer](https://www.pcgamer.com/terra-nil-review), [Destructoid](https://destructoid.com/reviews/review-terra-nil-free-lives-devolver-pc))

**Unpacking.** No fail state, story told entirely through objects, 100k copies in ten days, two BAFTAs. ([Wikipedia](https://en.wikipedia.org/wiki/Unpacking_(video_game)))

**Toy vs game, in theory.** Will Wright calls himself a toymaker; his games let players choose among multiple possible goals, centre agency and imagination, and offer creative options for failure. Schell: a toy is an object you play with, a game is a problem-solving activity approached playfully. Crawford calls The Sims a software toy. The Northwestern summary puts it simply: a toy is something you can give an objective to, a game already has one. ([DiGRA paper](https://dl.digra.org/index.php/dl/article/view/2115), [Game V Toy](https://users.cs.northwestern.edu/~etm453/Game%20V%20Toy.htm))

### 3. Music-driven and generative-art games

**Rez / Lumines / Tetris Effect.** Mizuguchi's method: cut sounds and sync one to every action, then ask the team what they felt until each input yields a small "wow"; Tetris Effect's music is built from the game's own sound effects, with voices as texture. ([Wccftech interview](https://wccftech.com/interview-tetsuya-mizuguchi-synesthesia-tetris-effect-rez-lumines/amp/), [Time Extension](https://timeextension.com/features/the-making-of-rez-tetsuya-mizuguchis-timeless-masterpiece))

**Thumper.** One button and one stick; the composer built mechanics and levels first and then the music, so player impacts feed the percussion. Restraint is the stated principle. ([Game Developer Q&A](https://gamedeveloper.com/audio/q-a-the-rhythm-violence-of-i-thumper-i-), [Waypoint](https://waypoint.vice.com/en/article/5g998b/the-intense-thumper-is-equal-parts-horror-and-music-game))

**Panoramical.** Fifteen worlds, each with 18 independent audio-visual dimensions on sliders (MIDI controller supported). Ramallo: everything is modular and controls are independent, so simple behaviours combine into near-infinite results. Kanaga: the software is disinterested in what you choose and accepts all input unconditionally. ([Game Developer](https://gamedeveloper.com/audio/road-to-the-igf-ramallo-and-kanaga-s-i-panoramical-i-), [XLR8R](https://xlr8r.com/?p=52133), [Engadget](https://www.engadget.com/2015-09-18-panoramical-finji-polytron-indie-fund.html))

**Electroplankton.** Ten stylus instruments, explicitly not a game; reviewers warned most players would not stay long. ([Cubed3](https://cubed3.com/review/377/1/electroplankton-nintendo-ds.html), [Engadget](https://www.engadget.com/2006-01-24-joystiq-review-electroplankton-nintendo-ds.html))

**Fract OSC.** The most relevant title. The world is a dormant synthesizer; each path has its own puzzle type (sequencer patterns that move objects, beam-routing, pipe puzzles); solving one wakes a structure with light and a new voice that persists in the ambient score; progress unlocks a studio where you compose with the sounds you found. Every structure is its own sound, the pacing never repeats a puzzle, and the dominant emotion reported is beautiful isolation. ([Wikipedia](https://en.wikipedia.org/wiki/Fract_OSC), [Kritiqal](https://www.kritiqal.com/2015/06/02/fract-osc-review/), [Indie Game Reviewer](https://indiegamereviewer.com/review-fract-osc-phosfiend-systems/))

**Sound Shapes.** Levels start from a song, each collectible is a note; the community level editor was a selling point until the servers shut in 2018 and all shared levels vanished. ([Wikipedia](https://en.wikipedia.org/wiki/Sound_Shapes))

**PixelJunk Eden.** Baiyon's trance score evolves something every 4 or 8 bars while the player grows a garden; audio and visual were designed as one signature. ([CoreGamers](https://coregamers.substack.com/p/the-creation-of-eden-part-i), [Higher Plain Music](https://higherplainmusic.com/2009/01/29/baiyon-pixeljunk-eden-ost-review/))

**Hohokum.** Meandering, every action has a musical gesture, but mixed reviews: objectives too vague, drudgery by the end. Ambience without structure wears thin. ([GamesRadar](https://www.gamesradar.com/hohokum-review), [EGM](https://egmnow.com/egm-review-hohokum/))

**Mountain.** An ambient simulator meant to run in the background for about 50 hours; you can only rotate, zoom and play a few notes. Kill Screen called it a Rorschach test; many players called it a screensaver. ([Wikipedia](https://en.wikipedia.org/wiki/Mountain_(video_game)), [Kill Screen](https://killscreen.com/god-mode-enabled-review-david-oreillys-mountain))

**Sayonara Wild Hearts** is routinely grouped with Thumper as music-first level design (gameplay authored to the track rather than the reverse). ([Nodal](https://nodal.gg/game/thumper-356400))

### 4. Scientific / educational simulations and idle loops

**Kerbal Space Program.** Spaceflight is a discipline of failure; KSP keeps the real orbital mechanics and wraps the explosions in slapstick so failure is part of the saga, not a punishment. ([Gamegeeker](https://gamegeeker.com/de/games/kerbal-space-program/review), [Physics Forums](https://www.physicsforums.com/threads/kerbal-space-program-tutorial.754767/))

**SpaceChem.** Puzzles are deliberately open-ended; instead of leaderboards it shows a global histogram of other players' solution sizes so you can gauge yourself without intimidation; players share solutions on YouTube; UK schools adopted it. ([Wikipedia](https://en.wikipedia.org/wiki/SpaceChem))

**Eco.** Started as an educational project funded by the US Department of Education (~$900k); the collective goal is a meteor that must be stopped with technology without wrecking the ecosystem. ([Wikipedia](https://en.wikipedia.org/wiki/Eco_(2018_video_game)))

**Osmos.** Relaxation was not the goal; it emerged from the Newtonian mechanic and the team leaned into it. Time-warp lets players speed through long drifts and slow down for precise collisions. ([Game Developer](https://gamedeveloper.com/game-platforms/road-to-the-igf-hemisphere-s-i-osmos-i-), [AppSpy](https://www.appspy.com/reviews/osmos-review/))

**Eufloria / Auralux / flOw.** Ambient strategy reduced to one unit type and one order; relaxing presentation hiding real depth. ([Indie Game Reviewer](https://indiegamereviewer.com/indie-game-review-auralux-serves-up-a-little-elemental-magic/), [TouchArcade](https://toucharcade.com/2012/02/20/eufloria-review/))

**Astroneer.** Research items found in the world convert to "bytes" that buy schematics; the loop is gather, research, build, extend your radius with vehicles. Praised for a welcoming sense of progression. ([TechRaptor](https://techraptor.net/content/astroneer-review), [Astroneer wiki](https://astroneer.wiki.gg/wiki/Bytes))

**Spaceplan / Universal Paperclips / Melvor Idle.** Idle design principles: compounding growth, meaningful allocation choices, and layers that unlock just as the previous one is mastered; the next goal must feel reachable and worth reaching; focused beats sprawling. Spaceplan is notable for having an ending; Paperclips was written as a critique of the genre; Melvor sells itself on offline progress fitting a busy life. ([Bugnet idle design](https://bugnet.io/blog/how-to-design-an-idle-or-incremental-game), [Eludamos on Paperclips](https://eludamos.org/index.php/eludamos/article/view/vol10no1-7), [Melvor Steam](https://store.steampowered.com/app/1267910/Melvor_Idle/), [Dinogame](https://dinogame.gg/blog/psychology-of-idle-games/))

### 5. Sharing, naming, and asynchronous presence

**Journey.** No names, no chat, no lobby; only a chime. Chen removed anything that produced competition (single-pickup items were changed to respawn for both players) because research showed online strangers default to meanness; partner names appear only in the credits. ([MCV](https://www.mcvuk.com/jenova-chen-reveals-secrets-of-journey-design/), [Digital Citizen](https://www.digitalcitizen.life/world-of-warcraft-helped-inspire-journey-creators-wordless-multiplayer-design/))

**Dark Souls.** Preset-phrase messages, bloodstains replaying deaths, and ghostly phantoms; critics praised how online elements were woven into a single-player journey. ([Wikipedia](https://en.wikipedia.org/wiki/Dark_Souls_(video_game)))

**Death Stranding.** Structures (ladders, bridges, roads) left by others are functional gifts, not just hints; likes are the reward; Timefall erodes structures so the world does not clutter. Vice's discussion: the feeling of someone having your back is the hook, and completing a shared highway was a highlight of the year. ([Vice](https://www.vice.com/en/article/43ke5b/the-joy-of-helping-others-in-death-stranding), [Wikipedia](https://en.wikipedia.org/wiki/Death_Stranding))

**Elite / NMS / Noctis / Astroneer** are covered above: Elite's tag demands effort (full scan plus return), NMS demands an explicit upload step, Noctis ran on e-mail and a curated text file, Astroneer's research is a private crafting currency with no social layer.

**Sandspiel's gallery and Sound Shapes' editor** show both the upside (a micro-culture of riffing) and the risk (community content dies with the server).

---

## (b) Loop/system to Fractal Nebulae mapping

| Loop / system (source) | How it maps onto Fractal Nebulae |
|---|---|
| Knowledge-as-progression, rumour map with loose-thread markers (Outer Wilds) | Codex becomes a linked atlas: each fact unlocked by a pulse at a specific scale; unexhausted nebulae show a marker; links between fractals (Menger dimension, Julia/Mandelbulb kinship) form the web. |
| First-discovery tag requiring full scan plus return (Elite) | "First light" claim on a deterministic locus (nebula, octant, zoom band) requires N resonance pulses at distinct scales; claim stored in a tiny backend or exported JSON. |
| Name-on-upload, explicit upload step (NMS) | Pilot names a locus; names are visible only after upload, so offline play stays clean. |
| Community-curated starmap by e-mail (Noctis) | Static-site-friendly fallback: pilots export a signed JSON "survey" and submit via GitHub issue/form; a curated `atlas.json` ships with each release. |
| Taxonomy log, sightings unlock illustrations (In Other Waters) | Each fractal family has features (bulbs, tunnels, spires); enough pulses on a feature type unlock a drawn plate plus a music layer. |
| Scale-shift encyclopedia on first bond, autoplay mode (Everything) | Infinite zoom records deepest level per nebula; an observatory/autoplay mode lets the ship drift on gravity glide while you are away. |
| Dormant world awakened by sound puzzles, studio unlock (Fract OSC) | Each nebula hides a dormant voice; pulse structural nodes in the right order (hinted by the music's rules) to awaken it; a "studio" view lets you mix awakened voices. |
| Independent audio-visual sliders (Panoramical) | Expose fractal parameters (power, iterations, Julia constant, fold) as sliders that also drive Tone.js parameters; share as URL presets. |
| Every action makes a sound, music built from SFX (Rez, Tetris Effect, Mini Metro) | Thrust, pulse, lock-on, zoom-step each emit a note in the nebula's scale; the HUD is an instrument. |
| Momentum glide, time warp (Exo One, Osmos) | Gravity-glide "lines": chain slingshots between black holes and masses; optional time-warp for long drifts. |
| Photo mode MVP, clean export, URL share (Bugnet, Eastshade) | Plate mode: pause, orbit cam, FOV, hide HUD, hi-res PNG, plus a permalink encoding seed, camera, zoom and parameters. |
| Session-sized rhythm, leave no trace (Terra Nil, A Short Hike) | Ten-minute "lantern" expeditions: a daily seed picks 3-5 loci; no persistent clutter. |
| Toy + score + modes (Islanders, Dorfromantik, Cloud Gardens) | Modes: Drift (pure toy), Survey (catalogue goals), Expedition (routes and timing), covering relaxers and completionists. |
| Histogram instead of leaderboard (SpaceChem) | Show where your deepest zoom or glide distance sits in a distribution, never a top-10. |
| Preset-phrase beacons, decaying structures, likes (Dark Souls, Death Stranding, Journey) | Wordless beacons at coordinates with preset phrases; decay after days; "light" as the only reaction. |
| Idle unlock layering, offline progress (Melvor, Spaceplan) | Observatory accrues survey data while idle; unlocks arrive as codex entries, not numbers. |
| Show the science or enjoyment plateaus (Universe Sandbox) | Every codex card links the visual to the equation and the musical rule it drives. |

---

## (c) Concrete loop ideas, ranked by fit

1. **The Atlas (survey taxonomy plus rumour map).** Each fractal family gets a short feature taxonomy (bulb lobes, Menger tunnels, Apollonian cusps, Kleinian spirals, Lichtenberg branches); a resonance pulse that lights a feature at a new scale band logs a sighting, and enough sightings unlock a drawn plate, a science card, and a new voice in that nebula's generative score. An Outer-Wilds-style web links related entries across nebulae and marks any nebula with unexhausted threads. Nothing is physically gated (ghost mode stays), so this is motivation, not restriction. Fit: highest; it uses pulse, lock-on, codex, zoom and music that already exist.

2. **Plate mode and permalinks.** Pause, orbit camera, FOV, HUD hide, hi-res export, plus a URL that encodes nebula seed, camera pose, zoom depth and parameters so a friend can stand exactly where you stood. This is the single sharing primitive that works on GitHub Pages with zero backend, and Bugnet's data says it is days of work and the best marketing a small game ships. Eastshade shows framing a shot can be the loop itself.

3. **Resonance etudes (Fract OSC).** Each nebula has a dormant instrument; a short sequence of structural nodes, hinted by the existing mathematical music rules, must be pulsed in order to wake it, which permanently adds a voice to the score and colour to the structure. A studio screen lets pilots mix awakened voices. Fract's reviews prove that waking a world with sound is a complete, emotionally strong loop; keep each etude unique as Fract did.

4. **Dive log (infinite zoom as progression).** Record deepest zoom per nebula with milestones tied to self-similarity facts (how many iterations, what detail appears, Hausdorff dimension); show your depth against an anonymised histogram, SpaceChem-style, not a leaderboard. Everything's encyclopedia-on-first-bond pattern makes the first visit to each depth a small event.

5. **Daily lantern (ten-minute expedition).** A date-seeded route picks three to five loci across nebulae and black holes; finishing it is optional and leaves no trace, matching Terra Nil's comforting rhythm and A Short Hike's rewarded detours. Tiny Glade's median one-hour session and 34k dailies show short, goal-light sessions can retain if there is a reason to return.

6. **First light claims (Elite/NMS/Noctis).** Deterministic loci allow a very small backend (or a curated JSON compiled from submissions, Noctis-style) to record the first pilot to complete a full multi-scale survey of a locus and let them name it. Require effort (Elite's full-scan rule) and an explicit upload (NMS) so claims are meaningful and offline play stays clean. Moderation and name filters are mandatory.

7. **Signal beacons (async presence).** Pilots can drop a wordless beacon with a preset phrase ("pulse here", "look up", "go deeper") at a coordinate; others see a faint glow and can answer with light. Beacons decay after days like Timefall so the map stays uncluttered; Journey's rule applies: no names, no free text. Needs a light backend but degrades gracefully to local-only.

8. **Glide lines (momentum challenges).** Optional runs where you chain gravity slingshots between the two black holes and nebula masses, scored by distance travelled per unit of thrust, with Osmos-style time warp for long drifts. Exo One shows this produces a genuine flow state; its motion-sickness complaints argue for a comfort mode and no forced camera moves.

9. **Science fair (parameter sandbox with explanation).** Expose fractal and black-hole parameters as Panoramical-style sliders that simultaneously change geometry and the Tone.js rules, and show the equation and musical rule side by side. This addresses Universe Sandbox's biggest flaw (no explanation) and turns the app into a teaching instrument; presets are shared via permalinks.

10. **Observatory (idle survey).** Leave the tab open on gravity glide and the ship slowly accrues survey sightings, delivered as queued codex entries on return, not as numbers going up. Mountain and Everything's autoplay show this is a legitimate ambient use; Melvor shows offline progress fits busy lives. Must be throttled and never feel like a clicker.

11. **Mode dials (Drift / Survey / Expedition).** Dorfromantik's reviewers found a gap between pure relaxers and perfectionists; offering explicit modes closes it without forcing goals on anyone. Islanders shows a single score over a toy can be enough for the "game" mode.

12. **Silent companion (live presence).** Journey-style: another live pilot shown as a mote of light with a chime only. Highest infrastructure cost and least aligned with a static host; include only if a backend exists for beacons anyway.

---

## (d) Risks and anti-patterns players complain about

- **Wide as an ocean, deep as a puddle.** The phrase has no single traceable origin, but the pattern is well documented: NMS's top complaint is lack of planetary diversity (26 mentions), Starfield's empty procedural planets and loading screens drew the "loading screen simulator" label, and Spore's space stage diluted everything to a few clicks. Nine fractals are not infinite content; depth must come from scale bands, music and knowledge, not from more nebulae. ([VaporLens NMS](https://vaporlens.app/app/275850/no_mans_sky), [80.lv](https://80.lv/articles/bethesda-continues-to-defend-starfield-by-replying-to-steam-reviews), [bit-tech Spore](https://bit-tech.net/features/gaming/pc/10-years-on-spore/1/))
- **Busywork scanning.** Mass Effect 2's planet scanning was called a mandatory, tensionless chore; Jett's repeated creature scanning became a chore within hours. Even In Other Waters' positive review flagged that forced timers contradicted its contemplative design. Rule: every pulse must change something perceptible (light, voice, plate, map link); never a progress bar. ([Wikipedia ME2](https://en.wikipedia.org/wiki/Mass_Effect_2), [CogConnected Jett](https://cogconnected.com/review/jett-far-shore-review/), [GameCritics IOW](https://gamecritics.com/mike-suskie/in-other-waters-review/))
- **No goals at all.** SpaceEngine reviews call it repetitive and boring despite its beauty; Universe Sandbox plateaus without explanation; Proteus fades after 20 minutes; Hohokum's vague objectives became drudgery; Sable drifted; Mountain got called a screensaver. The toys that thrived (Townscaper, Tiny Glade, Sandspiel) offer creation and sharing; a viewer-only app needs discovery or creation to last. ([VaporLens SpaceEngine](https://vaporlens.app/app/314650/space_engine/stats/analysis), [bit-tech Universe Sandbox](https://bit-tech.net/reviews/gaming/pc/universe-sandbox-review/1/), [PC Gamer Proteus](https://www.pcgamer.com/proteus-review), [GamesRadar Hohokum](https://www.gamesradar.com/hohokum-review))
- **Too little guidance versus hand-holding.** Outer Wilds (13 mentions) and Elite (19) both lose players who do not know what to do next and end up on wikis; A Short Hike solves it with invisible guidance (paths, sightlines, soft gating). The atlas's loose-thread markers are the compromise. ([VaporLens Outer Wilds](https://vaporlens.app/app/753640/outer_wilds), [VaporLens Elite](https://vaporlens.app/app/359320/elite_dangerous), [PS Blog](https://blog.playstation.com/2021/08/05/crafting-a-tiny-open-world-a-look-behind-the-scenes-at-the-creation-of-a-short-hike/))
- **Controls as the top churn driver.** Poor controls are SpaceEngine's largest churn factor (16.7%), Outer Wilds has 20 control complaints, Jett's ship was sluggish, Exo One caused motion sickness. 6-DOF flight needs assist modes, comfort options and no forced camera motion.
- **Server-dependent community content.** Sound Shapes' community levels vanished when servers closed; NMS's discovery sync scare showed how fragile naming feels. Design every social feature to export/import and to degrade to local-only; Noctis's curated file model is the safest baseline. ([Wikipedia Sound Shapes](https://en.wikipedia.org/wiki/Sound_Shapes), [Shacknews](https://www.shacknews.com/article/96530/no-mans-sky-appears-to-delete-your-discoveries-after-two-weeks-updated))
- **Online toxicity.** Journey removed names, chat and contested pickups because strangers default to meanness; use preset phrases and filtered names only. ([MCV](https://www.mcvuk.com/jenova-chen-reveals-secrets-of-journey-design/))
- **Menus and loads between discoveries.** Starfield's core failure; keep every transition (zoom, wormhole, lock-on) seamless.
- **The mode gap.** Dorfromantik's split between relaxers and perfectionists; serve both explicitly rather than averaging.
- **Complexity cliffs.** ONI and Timberborn lose casual players at onboarding; introduce parameters and taxonomy one nebula at a time.
- **Science without explanation.** Universe Sandbox's ironic oversight; every unlock should show the maths and the musical rule it drives.
- **Scope creep.** Mini Metro's postmortem and Bugnet's idle guide both warn that a focused game beats a sprawling one; ship plate mode and the atlas before any backend.

---

## (e) Sources

Space exploration and flight
- https://www.pressreader.com/australia/edge/20190620/282278141843961
- https://www.firstpersonscholar.com/?p=6333
- https://gamingtrend.com/feature/reviews/little-big-universe-outer-wilds-review
- https://vaporlens.app/app/753640/outer_wilds
- https://www.engadget.com/2014-09-08-elite-dangerous-explores-the-path-of-exploring.html
- https://steamcommunity.com/app/359320/discussions/0/1749023631425199965
- https://vaporlens.app/app/359320/elite_dangerous
- https://www.shacknews.com/article/96223/how-to-name-animals-and-plants-in-no-mans-sky
- https://www.shacknews.com/article/96530/no-mans-sky-appears-to-delete-your-discoveries-after-two-weeks-updated
- https://nomanssky.fandom.com/wiki/Discoveries
- https://vaporlens.app/app/275850/no_mans_sky
- https://www.expertreviews.co.uk/ps4-games/1405030/no-mans-sky-review-to-infinity-and-beyond
- https://80.lv/articles/bethesda-continues-to-defend-starfield-by-replying-to-steam-reviews
- https://vaporlens.app/app/1716740/starfield
- https://trending.knowyourmeme.com/news/bethesda-is-telling-its-critics-on-steam-that-starfield-is-not-boring-actually
- https://gog.com/game/spaceengine
- https://vaporlens.app/app/314650/space_engine/stats/analysis
- https://timeextension.com/features/the-making-of-noctis-the-no-mans-sky-forerunner-whose-creator-retreated-from-the-world
- https://en.wikipedia.org/wiki/Noctis_(video_game)
- https://homeoftheunderdogs.net/game.php?id=2950
- https://www.nme.com/reviews/exo-one-review-a-melancholy-trip-through-the-lonely-cosmos-3096892
- https://www.thexboxhub.com/exo-one-review/
- https://fingerguns.net/reviews/2021/11/27/exo-one-review-xbox-series-dancing-with-the-stars/
- https://en.wikipedia.org/wiki/Everything_(video_game)
- https://egmnow.com/?p=343
- https://en.wikipedia.org/wiki/Flower_(video_game)
- https://en.wikipedia.org/wiki/Abz%C3%BB
- https://www.pcgamer.com/proteus-review
- https://www.avclub.com/proteus-review-pcmac
- https://www.bit-tech.net/reviews/gaming/pc/proteus-review/1/
- https://www.stuff.tv/game-reviews/sable/review
- https://www.well-played.com.au/sable-review/
- https://twinfinite.net/reviews/sable-review-style-over-substance/
- https://en.wikipedia.org/wiki/Eastshade
- https://blog.playstation.com/2021/08/05/crafting-a-tiny-open-world-a-look-behind-the-scenes-at-the-creation-of-a-short-hike/
- https://cogconnected.com/review/jett-far-shore-review/
- https://checkpointgaming.net/reviews/2021/10/jett-the-far-shore-review-lost-in-space/
- https://waytoomany.games/2021/10/05/review-jett-the-far-shore/
- https://en.wikipedia.org/wiki/Observation_(video_game)
- https://gamecritics.com/mike-suskie/in-other-waters-review/
- https://www.gamespot.com/reviews/in-other-waters-review/1900-6417449/
- https://en.wikipedia.org/wiki/Mars_First_Logistics
- https://bugnet.io/blog/designing-photo-modes-players-actually-use
- https://www.gameinformer.com/b/features/archive/2017/11/22/opinion-photo-mode-matters-in-modern-gaming.aspx

Cozy / zen toys
- https://gamedeveloper.com/blogs/how-townscaper-works-a-story-four-games-in-the-making
- https://en.wikipedia.org/wiki/Townscaper
- https://wnhub.io/news/investment/item-45983
- https://pcgamer.com/games/city-builder/tiny-glade-review
- https://vaporlens.app/app/2198150/tiny_glade
- https://en.wikipedia.org/wiki/Dorfromantik
- https://toukana.com/dorfromantik
- https://intoindiegames.com/reviews/islanders-review/
- https://pixelpoppers.com/review/islanders/
- https://www.nintendolife.com/reviews/switch-eshop/cloud-gardens
- https://waytoomany.games/2022/07/26/review-cloud-gardens-switch/
- https://gamedeveloper.com/audio/postmortem-dinosaur-polo-club-s-i-mini-metro-i-
- https://www.indieorama.com/mini-metro-and-robert-curry-the-minimalism-was-one-of-the-things-that-made-the-game-hard-to-make
- https://maxbittker.com/making-sandspiel
- https://en.wikipedia.org/wiki/Noita_(video_game)
- https://bit-tech.net/reviews/gaming/pc/universe-sandbox-review/1/
- https://www.commonsense.org/education/game/universe-sandbox
- https://bit-tech.net/features/gaming/pc/10-years-on-spore/1/
- https://giantbomb.com/reviews/spore-review
- https://en.wikipedia.org/wiki/Oxygen_Not_Included
- https://en.wikipedia.org/wiki/Timberborn
- https://adelechapline.substack.com/p/review-terra-nil-is-comfortingly
- https://www.pcgamer.com/terra-nil-review
- https://destructoid.com/reviews/review-terra-nil-free-lives-devolver-pc
- https://en.wikipedia.org/wiki/Unpacking_(video_game)
- https://dl.digra.org/index.php/dl/article/view/2115
- https://users.cs.northwestern.edu/~etm453/Game%20V%20Toy.htm

Music-driven and generative art
- https://wccftech.com/interview-tetsuya-mizuguchi-synesthesia-tetris-effect-rez-lumines/amp/
- https://timeextension.com/features/the-making-of-rez-tetsuya-mizuguchis-timeless-masterpiece
- https://gamedeveloper.com/audio/q-a-the-rhythm-violence-of-i-thumper-i-
- https://waypoint.vice.com/en/article/5g998b/the-intense-thumper-is-equal-parts-horror-and-music-game
- https://gamedeveloper.com/audio/road-to-the-igf-ramallo-and-kanaga-s-i-panoramical-i-
- https://xlr8r.com/?p=52133
- https://www.engadget.com/2015-09-18-panoramical-finji-polytron-indie-fund.html
- https://cubed3.com/review/377/1/electroplankton-nintendo-ds.html
- https://www.engadget.com/2006-01-24-joystiq-review-electroplankton-nintendo-ds.html
- https://en.wikipedia.org/wiki/Fract_OSC
- https://www.kritiqal.com/2015/06/02/fract-osc-review/
- https://indiegamereviewer.com/review-fract-osc-phosfiend-systems/
- https://en.wikipedia.org/wiki/Sound_Shapes
- https://coregamers.substack.com/p/the-creation-of-eden-part-i
- https://higherplainmusic.com/2009/01/29/baiyon-pixeljunk-eden-ost-review/
- https://www.gamesradar.com/hohokum-review
- https://egmnow.com/egm-review-hohokum/
- https://en.wikipedia.org/wiki/Mountain_(video_game)
- https://killscreen.com/god-mode-enabled-review-david-oreillys-mountain
- https://nodal.gg/game/thumper-356400

Scientific / educational / idle
- https://gamegeeker.com/de/games/kerbal-space-program/review
- https://www.physicsforums.com/threads/kerbal-space-program-tutorial.754767/
- https://en.wikipedia.org/wiki/SpaceChem
- https://en.wikipedia.org/wiki/Eco_(2018_video_game)
- https://gamedeveloper.com/game-platforms/road-to-the-igf-hemisphere-s-i-osmos-i-
- https://www.appspy.com/reviews/osmos-review/
- https://indiegamereviewer.com/indie-game-review-auralux-serves-up-a-little-elemental-magic/
- https://toucharcade.com/2012/02/20/eufloria-review/
- https://techraptor.net/content/astroneer-review
- https://astroneer.wiki.gg/wiki/Bytes
- https://bugnet.io/blog/how-to-design-an-idle-or-incremental-game
- https://eludamos.org/index.php/eludamos/article/view/vol10no1-7
- https://store.steampowered.com/app/1267910/Melvor_Idle/
- https://dinogame.gg/blog/psychology-of-idle-games/

Sharing and asynchronous presence
- https://www.mcvuk.com/jenova-chen-reveals-secrets-of-journey-design/
- https://www.digitalcitizen.life/world-of-warcraft-helped-inspire-journey-creators-wordless-multiplayer-design/
- https://en.wikipedia.org/wiki/Dark_Souls_(video_game)
- https://www.vice.com/en/article/43ke5b/the-joy-of-helping-others-in-death-stranding
- https://en.wikipedia.org/wiki/Death_Stranding
- https://en.wikipedia.org/wiki/Mass_Effect_2
