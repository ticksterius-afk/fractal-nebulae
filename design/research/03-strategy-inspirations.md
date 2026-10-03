# 03 - Strategy-layer inspirations for Fractal Nebulae

Research brief for a light, elegant strategy layer that could sit on top of the existing Fractal Nebulae app (6-DoF flight, raymarched fractal nebulae, two lensing black holes with time dilation, resonance pulse, gravity glide, target-lock codex, generative music, ghost mode, infinite zoom, 11 nebulae over ~2,700 ly, 1 unit = 1 ly). The goal is explicitly *not* a heavy 4X. Sources are reviews, postmortems, developer interviews and player threads; URLs are inline and collected in section (e).

---

## (a) Per-game notes

### A1. Elegant, small-footprint strategy games

**Into the Breach (Subset Games, 2018).** Core loop: 8x8 grid, three mechs, enemies telegraph exactly where they will attack next turn; the player's job is to rearrange the board so the telegraphed damage lands somewhere harmless. Decision density is extremely high per turn (every action matters; undo and one full-turn reset per mission), but the run is short and *player-sized*: after FTL "overstayed its welcome," Subset let players choose how many islands to clear before the finale, so run length is adjustable ([Game Developer interview](https://www.gamedeveloper.com/business/how-subset-games-made-the-jump-from-i-ftl-i-to-i-into-the-breach-i-)). The design postmortem framed the key questions as what to cut, how much RNG to use and how to pick difficulty ([GDC Vault](https://www.gdcvault.com/play/1026333/contactUs); [80.lv summary](https://80.lv/articles/gdc-2019-an-inside-look-at-into-the-breach/)). Praise: perfect information "places the onus on the player"; the lesson is that you *cannot* get a perfect outcome and must prioritise ([Into the Spine](https://intothespine.com/2019/05/06/into-the-breach-and-imperfection/)). Criticism: puzzle-like rigidity; little narrative.

**FTL (Subset Games, 2012).** Core loop: jump node to node across a sector map while a rebel fleet advances behind you; each node is an event or fight; scrap is the only currency. Runs are 1-2 hours ([Steam thread comparing to StS](https://steamcommunity.com/app/646570/discussions/0/3277925755435724330)). What works: power-allocation decisions under pressure, discovery, scrap arriving "less often but in bigger lumps," and the fleet as a *spatial* timer. The sharpest critique is that "luck" complaints are really an information problem: the map tells you almost nothing about what a node contains, so choices are blind; the proposed fix is to show store types and sector biases on the map ([howell.seattle.wa.us critique](https://howell.seattle.wa.us/ggggd/ftl.html)). Subset themselves later reacted to FTL's final-boss difficulty spike by making ItB's finale "apply familiar mechanics" rather than new punishment.

**Slipways (Beetlewing / Jakub Wasilewski, 2021).** A 4X with the war removed: probe to reveal planets, decide what each planet produces, and connect planets with straight-line slipways so needs and products match. Unexported labour causes unemployment; unimported resources cause shortages; the game ends if happiness or money collapses. Sessions are about one hour / 25 in-game years; weekly ranked seeds exist ([Wikipedia](https://en.wikipedia.org/wiki/Slipways_(video_game)); [Indie Game Reviewer](https://indiegamereviewer.com/slipways-review-outer-space-grand-strategy-at-its-most-simplified/)). Praise: "a phenomenally smart piece of design," elegant iconography, pocket-sized 4X that still has depth. Criticism: without conflict it can "feel more like a game of snap than a carefully plotted empire." Lesson: graph constraints (straight lines, range limits, no crossings) *are* the strategy; nothing else is needed.

**Slay the Spire (Mega Crit, 2019).** Core loop: branching node map, card draft after each fight, three acts. Runs are typically 45-60+ minutes; "the vast majority of players have never completed a run in under 40 minutes" ([Steam thread](https://steamcommunity.com/app/646570/discussions/0/3277925755435724330)). Meta-progression is deliberately thin and functions as a tutorial: five unlock levels per character, then 20 Ascension difficulty levels that keep the loop identical while extending it ([Hamatti notes](https://notes.hamatti.org/Gaming/Video-games/Meta-progression-with-gradual-tutorial-in-roguelike-games)). Lesson: unlocks should be fast, mechanically justified and designer-ordered.

**Balatro (LocalThunk, 2024).** Poker hands as the only verb; no health bars or combat verbs; the designer disliked "gamery" fantasy language ([Rogueliker interview](https://rogueliker.com/balatro-interview/)). Runs under 20 minutes ([Two Average Gamers](https://www.twoaveragegamers.com/short-roguelikes-finish-run-before-bedtime/)). The "cursed problem": the score preview is hidden so you "set up your Rube Goldberg machine and watch it go," but the maths is fully calculable, so hardcore players use external calculators; hiding information only changes the feel if players cooperate ([GMTK](https://gmtk.substack.com/p/balatros-cursed-design-problem)). Lesson: suspense comes from *watching the machine run*, not from hidden rules.

**Inscryption (Daniel Mullins, 2021).** Began as a 48-hour jam entry on "sacrifices must be made"; the core rules received "not much planning." UI is physical: cards carry no text but the name, the scale and bell sit on the table, and "much of what continues to draw the player into Inscryption exists outside of the rules of the game" ([Game Developer](https://www.gamedeveloper.com/design/how-game-jam-sacrifices-became-inscryption)). Lesson: a diegetic table plus mystery can carry a modest ruleset.

**Islanders (Grizzly Games, 2019).** One resource: points. Buildings score by adjacency (windmill near fields, circus near houses but not mansions); thresholds grant new building packs; when the island is done you abandon it for a new one. 10-20 minutes per island; no timers, disasters or money ([Nintendo World Report](https://www.nintendoworldreport.com/review/58076); [GOG](https://www.gog.com/en/game/islanders)). Criticism: not enough guidance on where buildings may go. Lesson: *abandoning* progress keeps it fresh and keeps sessions short.

**Mini Metro / Mini Motorways (Dinosaur Polo Club).** Born from a Ludum Dare "minimalism" jam and the pleasure of planning a London commute; hard constraints ("no hand-built levels, nothing art-heavy, no reliance on audio content") made the project finishable, and the everyday subway premise "sells itself" ([Game Developer postmortem](https://gamedeveloper.com/audio/postmortem-dinosaur-polo-club-s-i-mini-metro-i-); [MCV](https://www.mcvuk.com/business-news/going-underground-the-story-of-dinosaur-polo-clubs-mini-metro/)). Mini Motorways made road tiles a scarce weekly resource and added roundabouts, bridges and motorways; it is less abstract than Metro ([TouchArcade](https://toucharcade.com/2019/09/30/apple-arcade-mini-motorways-review/)). Lesson: demand grows, capacity is rationed, failure is a gentle overflow.

**Bad North (Plausible Concept, 2018).** "A micro RTS. Everything is boiled down to the most minimal of components, making everything a visual cue"; the audio brief was that "you should be able to close your eyes and still understand what is going on" ([PocketGamer.biz](https://www.pocketgamer.biz/interview/68638/indie-spotlight-plausible-concept-on-bad-north/); [Gaming Audio News](https://gamingaudionews.com/2018/04/26/bad-norths-developers-talk-about-inspiration-behind-audio-and-gameplay/)). Lesson: tiny islands as self-contained encounters, a roguelite map between them.

**Kingdom Two Crowns (Noio/Coatsink, 2018).** Two verbs: ride and drop coins. "Coins and your steed are the only two ways you interact with the world," yet build/upgrade systems and secrets unfold through experimentation and failure ([Pocket Tactics](https://www.pockettactics.com/kingdom-two-crowns/micro-strategy)). Night attacks give a rhythm. Lesson: one input, world-as-interface.

**Northgard (Shiro, 2018).** Region tiles with their own features and a hard building cap per tile; six clans with unique trees; ~1 hour sessions. Criticism: "painfully slow pace" while waiting for resources ([God is a Geek](https://godisageek.com/reviews/northgard-review/); [Meeple Mountain on the board game](https://www.meeplemountain.com/reviews/northgard-uncharted-lands)). Lesson: territory as discrete regions with caps is readable; idle waiting is not.

**Dorfromantik (Toukana, 2022).** Carcassonne-style hex tiles drawn one at a time; perfect placements "jiggle" with a sound and the word Perfect; playable as pure relaxation or as a high-score puzzle ([Film Stories](https://filmstories.co.uk/?p=83460); [Nintendo Life](https://www.nintendolife.com/games/switch-eshop/dorfromantik)). Lesson: one tile per decision, feedback through animation and sound, quests ("connect six forests") as soft goals.

**Against the Storm (Eremite, 2023).** Roguelite city builder: the Queen sends you out repeatedly; each settlement ends at a reputation threshold; blueprints are drafted per run; the storm is a cycle timer ([PC Gamer](https://www.pcgamer.com/against-the-storm-review/); [Checkpoint](https://checkpointgaming.net/reviews/2025/07/against-the-storm-review-rogue-settlements/); [TechRaptor](https://techraptor.net/gaming/reviews/against-storm-ambient-roguelite-city-builder)). Lesson: settlements are disposable runs on a persistent meta-map; the draft is the strategy.

**Dune: Spice Wars (Shiro, 2023).** Hex-region 4X/RTS hybrid; 1-3 hours per match; praised for the CHOAM market and clear 4X communication; criticised because combat is "a numbers game," factions play alike and matches become repetitive ([Game Chronicles](https://gamechronicles.com/dune-spice-wars-early-access-review-pc/); [TechRadar](https://www.techradar.com/gaming/consoles-pc/dune-spice-wars-review)). Lesson: "lighter 4X" still inherits the 4X session length unless the map is small.

**Stellaris (Paradox) - what is too heavy.** Mid/late game "devolves to constantly being called back to respond to unemployed or unhappy pops"; pops are the main cause of endgame lag, with a single day taking 20-30 s during big fleet battles ([Steam](https://steamcommunity.com/app/281990/discussions/0/2448217320143034452); [Paradox forum](https://admin-forum.paradoxplaza.com/forum/threads/some-observations-on-late-game-lag.1773613)). The 2.0 hyperlane decision (see A2) is its most relevant *good* lesson.

**Endless Space 2 (Amplitude, 2017).** Best assets are writing, faction quests and art; weaknesses are undercooked systems and a UI "too efficient for its own good" through shorthand symbols that confuse new players ([PC Gamer](https://www.pcgamer.com/uk/endless-space-2-review/); [PCWorld](https://www.pcworld.com/article/406919/endless-space-2-review-mood-meets-4x-strategy.html)). Lesson: iconography must be learnable in minutes.

**Sins of a Solar Empire II (Ironclad, 2024).** Planets and asteroids ("gravity wells") now orbit: "build up a fleet on an asteroid, wait until it swings behind the enemy line, and then attack." Criticised for generic world-building and because the first interesting moment "may not occur until an hour into a game" ([PCGamesN](https://www.pcgamesn.com/sins-of-a-solar-empire-2/review); [PC Gamer](https://pcgamer.com/games/strategy/sins-of-a-solar-empire-2-review)). Lesson: orbital *timing* is a strategic resource; the "gravity well" as a discrete arena is a good abstraction.

**Homeworld (Relic, 1999 / Blackbird, 2024).** See A2.

**Offworld Trading Company (Mohawk, 2016).** An RTS with no units: 13 resources on a live market, hex claims, hostile takeovers via stock, black-market sabotage, and the half-hour RTS format kept intact. Players are warned when a rival can afford to buy them out, producing "tense, desperate races" ([Wikipedia](https://en.wikipedia.org/wiki/Offworld_Trading_Company); [Designer Notes postmortem](https://designer-notes.com/offworld-trading-company-gdc-postmortem)). Lesson: a price curve is a legible, UI-light antagonist.

**Spacebase Startopia (Realmforge, 2021).** Three-deck torus station; reviewers found "little to do after the initial station setup" and "no meaningful challenge, or ability to plan ahead" ([Prima](https://primagames.com/?p=315014); [TheSixthAxis](https://www.thesixthaxis.com/2021/03/29/spacebase-startopia-review/)). Anti-lesson: a cool topology is not a game without pressure.

**Dyson Sphere Program (Youthcat, 2021).** Overwhelmingly positive; the megastructure is the goal; players complain of unclear objectives, missing milestones and grind-heavy late game ([bit-tech](https://bit-tech.net/reviews/gaming/pc/dyson-sphere-program-review/1/); [Vaporlens summary](https://vaporlens.app/app/1366540/dyson_sphere_program)). Lesson: a visible megastructure that fills in is a powerful progress bar; give milestones.

**Factorio / Satisfactory.** "You will never find an equilibrium... if you're waiting on one thing, you have 10 more things that need done" ([Hamatti review](https://notes.hamatti.org/Gaming/Video-games/Reviews/Factorio)); trains are "the veins and arteries" of the factory. Satisfactory moves the same loop into first-person 3D with verticality and exploration, 97% positive ([Steam](https://store.steampowered.com/app/526870/Satisfactory/)). Lesson: logistics in first person works, but it is a long-session genre.

**Opus Magnum (Zachtronics, 2017).** After each solution, three histograms (cost, cycles, area) place you against everyone and your friends; "it's unlikely, if not impossible, for a machine to top all three charts," so optimisation is self-directed ([Engadget](https://www.engadget.com/2018-07-09-opus-magnum-zachtronics-irl.html); [biggieblog records](https://biggieblog.com/?p=836)). Lesson: multi-axis scoring plus shareable replays beats a single leaderboard.

**shapez (tobspr, 2020).** Abstract shapes instead of resources; no combat, time pressure or scarcity; infinite map; 96% positive, "won't let me stop making my lines more efficient" ([Steam](https://store.steampowered.com/app/1318690/shapez/)). Lesson: abstraction keeps a factory game calm.

### A2. 3-D space strategy specifically

**Homeworld's solution.** The camera is "always locked to a ship (or group of ships)"; you orbit it on a sphere, and ships keep a common "right way up" to avoid "a mind-twisting set of controls" ([Force For Good](https://forceforgood.co.uk/strategy/homeworld/)). Erin Daly found that players with *less* top-down RTS experience learned it faster; the article's verdict is that full 3D was "primarily an aesthetic choice carrying significant gameplay trade-offs," confined to "a tiny niche," partly because empty space offers few obstacles and partly because publishers preferred to clone StarCraft ([The Digital Antiquarian](https://www.filfre.net/2026/01/homeworld/)). Homeworld 3's added terrain "mostly just make[s] a hard job even harder"; tunnels and cover were rarely used and AI got stuck ([Aftermath](https://aftermath.site/homeworld-3-pc-review-impressions-blackbird-steam-rts/); [TheSixthAxis](https://www.thesixthaxis.com/2024/05/10/homeworld-3-review/)).

**Nebulous: Fleet Command (Eridanus, EA 2022).** Hard-sim 3D fleet game. Players: "I do find it quite difficult to steer the ships in 3D"; ships ordered at "a 45 degree downward angle" when up was intended; "most people SAY they want 3D until they have to DEAL with 3D"; tutorial takes ~3 hours; EW and radar jamming are the beloved parts ([Quarter to Three](https://forum.quartertothree.com/t/simulation-heavy-tactical-space-game-nebulous-fleet-command-now-in-early-access/154976); [Steam suggestions](https://steamcommunity.com/app/887570/discussions/0/3780246883322475750)). Requested fixes: persistent draggable waypoints, vertical depth markers "like Homeworld," elevation readouts.

**Battlestar Galactica Deadlock (Black Lab, 2017).** WEGO: both sides plan, then turns execute simultaneously in 3D with altitude; praised tactics, criticised strategy-layer interface and finicky tutorial ([Wikipedia](https://en.wikipedia.org/wiki/Battlestar_Galactica_Deadlock)). Lesson: planning phases make 3D tolerable because nobody has to steer in real time.

**Falling Frontier (Stutter Fox, 2025).** Passive recon stations vs. active probes that reveal you; combat is "who sees who first"; every unit of fuel and ore is physically shipped so blockades are a "primary strategic weapon" ([Captain Collins](https://captaincollins.tv/preview/falling-frontier-briefing-is-this-the-hard-sci-fi-wake-up-call-the-genre-needs/); [PC Gamer](https://www.pcgamer.com/games/rts/falling-frontiers-new-trailer-makes-me-want-to-hibernate-until-the-rts-appears-in-2025/)). Lesson: active sensing with a cost is a one-button strategy verb.

**Stellaris hyperlanes.** 2.0 removed warp and wormhole because mobility "was just too high compared to galaxy and empires size," encouraged doomstacks and "rendered any sort of defense pointless"; hyperlanes created "galactic terrain" and chokepoints ([Steam thread summarising the dev diary](https://steamcommunity.com/app/281990/discussions/0/2650805212056016308); [Dev Diary 92](https://admin-forum.paradoxplaza.com/forum/developer-diary/stellaris-dev-diary-92-ftl-rework-and-galactic-terrain.1052958/page-31)). Lesson: a graph of lanes turns a volume into a readable board.

**Sins II orbits and Slipways graphs.** Both reduce 3D volumes to 2D decision structures (gravity-well arenas; straight-line edges). Nothing in the research found a *successful* light strategy game that makes players reason in true 3D; everything that worked projected the decision onto a surface, a graph or a locked-camera orbit.

### A3. Run-based structure

Run-length norms from the sources: Balatro and Brotato under 20-25 min; Dead Cells 20-45; Slay the Spire 45-60+; FTL and Risk of Rain 2 about an hour ([Two Average Gamers](https://www.twoaveragegamers.com/short-roguelikes-finish-run-before-bedtime/); [RoR2 thread](https://steamcommunity.com/app/632360/discussions/0/1639790664937280264)). Subset's own correction after FTL was to let players *choose* run length.

Meta-progression: Hades turned every death into story, with "multiplicative design content and story that adapts to player progression" ([Quarter to Three](https://forum.quartertothree.com/t/hades-supergiant-games/139167?page=47)); Slay the Spire uses sparse unlocks as a tutorial and Ascension as an infinite difficulty ladder ([Hamatti](https://notes.hamatti.org/Gaming/Video-games/Meta-progression-with-gradual-tutorial-in-roguelike-games)); purists want everything winnable from run one.

Daily seeds: Spelunky's one-attempt daily with per-day leaderboards created "excitement to boot up the game each day" ([Spelunky wiki](https://spelunky.fandom.com/wiki/Daily_Challenge_Mode_(HD)); [GamingTrend](https://gamingtrend.com/news/spelunkys-daily-challenge-system-will-provide-competition-rage-on-steam)). Variants: Caveblazers one attempt plus modifiers; Dead Cells unlimited attempts (~7,000 runs/day, "opens the mode to those who just want to better themselves"); OlliOlli practice-then-commit; implementation took Rupeck "a single weekend" ([Game Developer, "The 24-hour ticket"](https://www.gamedeveloper.com/design/the-24-hour-ticket-examining-daily-runs-)). Pitfall: money-based scoring in Spelunky forced maximal risk every run, encouraging seed-hunting and suicide-runs; proposed fixes are "average of ten" and 1v1 same-seed duels ([The Ludite](https://theludite.com/2014/06/23/spelunky-when-scoring-goes-bad/)).

### A4. Graph / network and logistics

Mini Metro (lines as scarce, demand as stations), Mini Motorways (road tiles as a weekly budget), Slipways (straight-line edges with matching needs), Railway Empire and Transport Fever (bottlenecks at unloading, path signals, "things start to slow down around 50% track usage") ([Railway Empire thread](https://steamcommunity.com/app/503940/discussions/0/1742231069944422003); [Transport Fever signalling](https://lr.psf.lt/r/TransportFever/comments/1e2zrr3/signaling)), Factorio trains, Northgard's capped regions, Dorfromantik's hex adjacency, Terra Nil's order-of-operations puzzle that ends only when "you've packed up after yourself" ([Kotaku](https://kotaku.com/terra-nil-review-city-builder-devolver-digital-pc-ios-1850267414)), and DSP's megastructure-as-progress-bar.

Fractal surfaces: **Marble Marcher** (CodeParade) is "entirely ray-marched... played on the surface of evolving fractals," with collisions from signed distance fields and level parameters animating mid-level ([itch.io](https://codeparade.itch.io/marblemarcher)). **Manifold Garden** builds puzzles on world-wrapping infinite architecture and avoided disorientation with unique per-level visuals, windows as gravity reference points, and ~2,000 hours of playtesting ([Wikipedia](https://en.wikipedia.org/wiki/Manifold_Garden)). Both prove the SDF can be a game board, and that orientation cues are the cost.

### A5. Minimalist strategy UX

Mini Metro: information *is* the map; Islanders: score popups and placement rings only, criticised for not showing where a building is allowed; Slipways: "clear iconography" praised; Into the Breach: every consequence drawn on the grid before you commit; Inscryption: text-free cards, the table as the HUD; Bad North: everything a visual/audio cue. Diegetic UI pros: faster than opening a menu, stronger worldbuilding (Dead Space spine bar, Elite's cockpit, Outer Wilds' 3D lever); cons: cognitive overload if used everywhere; Dead Space keeps it to 3-4 pieces of information ([Indieklem](https://indieklem.substack.com/p/19-the-diegetic-dilemma-benefits); [Game Developer](https://www.gamedeveloper.com/design/game-ui-discoveries-what-players-want)). Radial menus: selection by direction, equidistant, exit through the centre, four or eight items map to cursor/numpad keys; best for weapon/ability wheels and contextual commands ([Wikipedia](https://en.wikipedia.org/wiki/Pie_menu); [300mind](https://300mind.studio/blog/radial-menus-in-game-design/)).

### A6. Time, relativity and gravity as mechanics

**Outer Wilds**: 22-minute loop; "knowledge is progress"; nothing but knowledge persists, so the strategy is *where to spend the loop* ([Steam discussion](https://steamcommunity.com/app/753640/discussions/0/2518023667588821798)). **Braid / The Gardens Between / Timelie**: time scrubbing as a predictive tool - Timelie lets you "freely progress or reverse time in order to predict the movements of enemies" before committing ([Wikipedia](https://en.wikipedia.org/wiki/Timelie); [Geeky Hobbies](https://www.geekyhobbies.com/the-gardens-between-indie-game-review/)). **Achron**: real time-travel RTS, chronoenergy budget, chronocloning; "stunningly inventive" but buried under pathfinding and polish problems ([bit-tech](https://bit-tech.net/reviews/gaming/pc/achron-review/1/); [Shacknews](https://shacknews.com/article/70050/achron-review)). **Children of a Dead Earth**: n-body orbits, plan manoeuvres then advance time in chunks; "skews much more towards simulator than game" ([Quarter to Three](https://forum.quartertothree.com/t/children-of-a-dead-earth/126112)). **Delta-V: Rings of Saturn**: Newtonian mining where "your thrust is a potent weapon" and ore must be velocity-matched ([Steam](https://store.steampowered.com/app/846030/V/)). **Elite Dangerous**: scoopable KGBFOAM stars and neutron-star x4 jumps turn route planning into a graph-with-refuelling puzzle; a dashed route line means you will run dry ([Frontier forum](https://forums.frontier.co.uk/threads/neutron-highway-long-range-route-planner.308674/)). **A Slower Speed of Light** (MIT Game Lab): each orb lowers c until walking speed shows Doppler shift, searchlight brightening, Lorentz contraction and time dilation ([Wikipedia](https://en.wikipedia.org/wiki/A_Slower_Speed_of_Light)); the "Relativity for games" paper shows how to keep causality with worldlines and light cones ([arXiv 1703.07063](https://arxiv.org/abs/1703.07063)). A board-game design note proposes relativistic farming: decide when to send ships and how fast so they return with a full harvest, accounting for dilation ([Oopart Games](https://oopartgames.com/blogs/cultural-insights/exploring-time-dilation-mechanics-in-a-board-game-design)). **Sins II** orbits make *when* a strategic variable.

What makes relativity strategic rather than gimmicky, from these cases: (1) the effect must change a *schedule* the player cares about (harvest, return, rendezvous), not just visuals; (2) it must be predictable and previewable (Timelie, ItB) rather than surprising (Achron's paradoxes); (3) it needs a budget (chronoenergy, delta-v, fuel) so there is a trade; (4) it should be local and optional (near a horizon) so the baseline game stays calm.

---

## (b) System -> how it maps onto Fractal Nebulae

| Source system | Mapping onto Fractal Nebulae |
|---|---|
| Slipways straight-line edges with range limits | Beacon threads between anchor points; validity tested by raymarching the SDF (a thread cannot pass through solid fractal); range scales with local structure size |
| Stellaris hyperlanes / galactic terrain | The 11 nebulae become nodes of a sparse lane graph across 2,700 ly; black holes are chokepoints or shortcuts (wormholes) |
| Mini Metro lines and station demand | Resonance relay lines; "passengers" are pulses that must reach codex features; line count rationed |
| Into the Breach telegraphing | Anomalies (storms, tidal fronts, shock waves) show next-turn paths in the HUD; player repositions probes with 2-3 actions |
| Islanders adjacency scoring | Outposts scored by fractal metrics: iteration depth, distance-to-fold, curvature, proximity to lensing caustics |
| Dorfromantik tile draw | Draw an IFS transform "tile" and attach it to the structure; quests like "join three Sierpinski faces" |
| Against the Storm settlements on a meta-map | Each nebula is a 15-25 min expedition; the galaxy map is the persistent meta layer |
| Sins II orbit timing | Objects orbiting the black holes; you wait for the swing-by rather than fly against it |
| Falling Frontier active vs. passive sensing | Resonance pulse = active (reveals you to anomalies, costs charge); passive listening = slow safe reveal |
| Offworld price curve | A shared "coherence" market: lighting a feature nobody has lit pays more; prices decay |
| Opus Magnum histograms | Per-nebula optimisation challenges with three axes (pulses used, path length, elapsed proper time) and global histograms |
| Outer Wilds loop | A fixed-length loop; codex knowledge persists; dilation near a horizon stretches what you can do in loop time |
| Relativistic farming (board-game note) | Probes "mature" in proper time; park near the horizon to delay, or far away to hurry; schedule returns |
| Elite fuel scooping / neutron boosts | Gravity glide as free delta-v; black holes as x4 boosts with a risk band |
| Homeworld locked-orbit camera | Strategy mode orbits a selected node; a common "up" is kept; no free-flying camera in planning |
| BSG Deadlock WEGO | Plan, then advance time in chunks (also matches CoaDE); flight stays real-time for the relaxing layer |
| Terra Nil leave-no-trace | A run ends by retrieving every beacon; the nebula returns to pristine |
| Dead Cells unlimited-attempt daily | Daily seed with unlimited attempts and an "average of ten" board |
| Hades death-as-story | Each failed expedition unlocks a codex fragment or a music rule |
| Kingdom coins | A single resource (resonance charge) dropped at structures to grow them |

---

## (c) Concrete strategy-layer ideas, ranked by fit

1. **Expedition runs on the galaxy graph (FTL x Slipways x Against the Storm).** A 15-25 minute run: choose a route through a hyperlane-style graph of the 11 nebulae; each node is a short objective inside the existing flight (light N features, reach a depth, survive a tidal front); a slow "decoherence front" sweeps behind you like FTL's rebel fleet. Nodes show what they contain (fixing FTL's information flaw). Everything reuses the existing world; only the graph, a timer and a results card are new.

2. **Beacon threads: Slipways in a raymarched volume.** Place beacons on fractal surfaces and connect them with straight threads that must not intersect solid; the SDF test is literally one raymarch. Threads carry a demand/supply match (a Mandelbulb exports "turbulence", a Menger sponge needs "order"). Score is network size and happiness; the game ends gently when coherence collapses. This is the most unique thing the engine can do that no other game can.

3. **Proper-time scheduling at the black holes (relativistic farming).** Probes ripen in their own proper time. Park one in the dilation band to slow it (bank it for later), or send it far out to hurry it; retrieve them in the right order before a deadline measured in *your* clock. The existing time-dilation code becomes a planning puzzle; the HUD shows two clocks and a predicted return, Timelie-style.

4. **Outposts on fractal surfaces (Islanders on a Menger sponge).** Drop outposts on a nebula's surface; adjacency scoring uses fractal metrics (depth, fold distance, symmetry axes) that the shader already knows. Infinite zoom subdivides the "island" so one nebula is many levels; when you abandon it you fly to the next. 10-20 minutes per nebula, no timers.

5. **Telegraphed anomalies, Into-the-Breach style.** A turn-based "storm watch" mode: three anomalies drift along telegraphed paths through a nebula; you have three actions (pulse to deflect, glide to pull, ghost to pass through) to protect lit features. Perfect information, undo, five turns. Uses existing verbs as the action set.

6. **Resonance optimisation challenges with histograms (Opus Magnum).** Per-nebula puzzles: light 80% of structure with the fewest pulses / shortest path / least proper time. Three histograms against all players; replays shared as short GIF-like flight logs. Zero new world content; pure scoring.

7. **Orbit timing around the black holes (Sins II).** Several resource nodes orbit each black hole; you plan when to intercept so the swing-by does the work. A planning overlay shows future positions (WEGO-style advance in chunks), then real-time flight executes.

8. **Mini Metro relays.** Codex features emit "requests" at growing rates; you draw a limited number of relay lines; overflow ends the session. The minimal HUD stays, lines are drawn as light.

9. **Daily seed expedition with an average-of-ten board.** One seeded route per day, unlimited attempts (Dead Cells model), ranked by average of last ten rather than peak (Ludite model) so risk management stays intact.

10. **Terra Nil-style "leave it pristine".** Any run ends with retrieval: you must collect every beacon and thread you placed; the nebula fades back to its original generative music. A soothing closing phase that doubles as a score multiplier.

11. **Codex-as-progression (Hades/Outer Wilds).** Nothing mechanical unlocks between runs; only codex entries and music rules do, and a few entries gate new routes (a wormhole route only appears once you have read about it).

12. **Active vs. passive sensing (Falling Frontier).** The pulse becomes a cost: it lights structure but wakes anomalies; passive listening reveals slowly. A single binary choice per node that turns the existing pulse into a strategic decision.

---

## (d) Risks and anti-patterns players complain about

- **True 3D decision-making.** Nebulous players ordered ships 45 degrees the wrong way; "most people SAY they want 3D until they have to DEAL with 3D." Homeworld only worked by locking the camera to a ship and keeping a shared up; Homeworld 3's terrain made things worse. Project every *decision* onto a surface, a graph or a locked orbit; keep free 6-DoF only for the flying.
- **Snowballing and late-game drag.** "The stronger get stronger"; outcomes known by mid-game; designers call it the hardest 4X pacing problem ([PCGamesN](https://pcgamesn.com/civilization-vi/strategy-game-endgame-design); [CivFanatics](https://forums.civfanatics.com/threads/the-4x-problem-of-snowballing.621076); [Bugnet](https://bugnet.io/blog/how-to-design-a-4x-games-pacing)). Keep runs short and end them when the outcome is certain.
- **Micro and babysitting.** Stellaris pops, Nebulous micro. Never require attention to more than a handful of objects.
- **Too much UI / too little UI.** Endless Space 2's symbol shorthand confused newcomers; Islanders failed to show where placement is legal. Rule: show consequences before commitment (ItB), keep diegetic elements to 3-4 (Dead Space), and preview legality.
- **Blind randomness.** FTL's "luck" is really missing information; show node contents and costs.
- **Hidden-score "cursed problems."** If a score is calculable, players will compute it externally; prefer transparent scoring with suspense in the *execution*.
- **Leaderboard distortion.** Peak-score dailies force maximum-risk play and seed hunting; use average-of-N or unlimited-attempt boards.
- **No goals / nothing to do after setup.** DSP (no milestones), Startopia (no challenge, no planning), Terra Nil (four-mission campaign). Provide milestones and a visible megastructure.
- **Sameness and numbers-game combat.** Spice Wars' factions and combat. If nebulae are the "factions," their fractal rules must change decisions, not just visuals.
- **Breaking the relaxation contract.** Islanders and Dorfromantik succeed with no timers; Northgard is criticised for idle waiting. Pressure should be gentle (a slow front, a soft overflow), never a frantic timer, and idle time should always have a flight to enjoy.
- **Gimmick relativity.** Achron was "stunningly inventive" and still failed on legibility and execution. Dilation must be previewable, budgeted, local and optional.
- **Session creep.** Slipways is an hour, Spice Wars 1-3 hours; a "light" layer on a relaxation app should target 15-25 minutes with a player-chosen length (Subset's fix).
- **Performance.** Any strategy sim must not touch the raymarch frame budget; keep the layer sparse (dozens of objects, not thousands), simulate on the CPU, and reuse the SDF for tests rather than adding geometry.

---

## (e) Sources

- https://www.gamedeveloper.com/business/how-subset-games-made-the-jump-from-i-ftl-i-to-i-into-the-breach-i-
- https://www.gdcvault.com/play/1026333/contactUs
- https://80.lv/articles/gdc-2019-an-inside-look-at-into-the-breach/
- https://intothespine.com/2019/05/06/into-the-breach-and-imperfection/
- https://howell.seattle.wa.us/ggggd/ftl.html
- https://steamcommunity.com/app/646570/discussions/0/3277925755435724330
- https://en.wikipedia.org/wiki/Slipways_(video_game)
- https://indiegamereviewer.com/slipways-review-outer-space-grand-strategy-at-its-most-simplified/
- https://notes.hamatti.org/Gaming/Video-games/Meta-progression-with-gradual-tutorial-in-roguelike-games
- https://rogueliker.com/balatro-interview/
- https://gmtk.substack.com/p/balatros-cursed-design-problem
- https://www.twoaveragegamers.com/short-roguelikes-finish-run-before-bedtime/
- https://www.gamedeveloper.com/design/how-game-jam-sacrifices-became-inscryption
- https://www.nintendoworldreport.com/review/58076
- https://www.gog.com/en/game/islanders
- https://gamedeveloper.com/audio/postmortem-dinosaur-polo-club-s-i-mini-metro-i-
- https://www.mcvuk.com/business-news/going-underground-the-story-of-dinosaur-polo-clubs-mini-metro/
- https://toucharcade.com/2019/09/30/apple-arcade-mini-motorways-review/
- https://www.pocketgamer.biz/interview/68638/indie-spotlight-plausible-concept-on-bad-north/
- https://gamingaudionews.com/2018/04/26/bad-norths-developers-talk-about-inspiration-behind-audio-and-gameplay/
- https://www.pockettactics.com/kingdom-two-crowns/micro-strategy
- https://godisageek.com/reviews/northgard-review/
- https://www.meeplemountain.com/reviews/northgard-uncharted-lands
- https://filmstories.co.uk/?p=83460
- https://www.nintendolife.com/games/switch-eshop/dorfromantik
- https://www.pcgamer.com/against-the-storm-review/
- https://checkpointgaming.net/reviews/2025/07/against-the-storm-review-rogue-settlements/
- https://techraptor.net/gaming/reviews/against-storm-ambient-roguelite-city-builder
- https://gamechronicles.com/dune-spice-wars-early-access-review-pc/
- https://www.techradar.com/gaming/consoles-pc/dune-spice-wars-review
- https://steamcommunity.com/app/281990/discussions/0/2448217320143034452
- https://admin-forum.paradoxplaza.com/forum/threads/some-observations-on-late-game-lag.1773613
- https://steamcommunity.com/app/281990/discussions/0/2650805212056016308
- https://admin-forum.paradoxplaza.com/forum/developer-diary/stellaris-dev-diary-92-ftl-rework-and-galactic-terrain.1052958/page-31
- https://www.pcgamer.com/uk/endless-space-2-review/
- https://www.pcworld.com/article/406919/endless-space-2-review-mood-meets-4x-strategy.html
- https://www.pcgamesn.com/sins-of-a-solar-empire-2/review
- https://pcgamer.com/games/strategy/sins-of-a-solar-empire-2-review
- https://forceforgood.co.uk/strategy/homeworld/
- https://www.filfre.net/2026/01/homeworld/
- https://aftermath.site/homeworld-3-pc-review-impressions-blackbird-steam-rts/
- https://www.thesixthaxis.com/2024/05/10/homeworld-3-review/
- https://forum.quartertothree.com/t/simulation-heavy-tactical-space-game-nebulous-fleet-command-now-in-early-access/154976
- https://steamcommunity.com/app/887570/discussions/0/3780246883322475750
- https://en.wikipedia.org/wiki/Battlestar_Galactica_Deadlock
- https://captaincollins.tv/preview/falling-frontier-briefing-is-this-the-hard-sci-fi-wake-up-call-the-genre-needs/
- https://www.pcgamer.com/games/rts/falling-frontiers-new-trailer-makes-me-want-to-hibernate-until-the-rts-appears-in-2025/
- https://en.wikipedia.org/wiki/Offworld_Trading_Company
- https://designer-notes.com/offworld-trading-company-gdc-postmortem
- https://primagames.com/?p=315014
- https://www.thesixthaxis.com/2021/03/29/spacebase-startopia-review/
- https://bit-tech.net/reviews/gaming/pc/dyson-sphere-program-review/1/
- https://vaporlens.app/app/1366540/dyson_sphere_program
- https://notes.hamatti.org/Gaming/Video-games/Reviews/Factorio
- https://store.steampowered.com/app/526870/Satisfactory/
- https://www.engadget.com/2018-07-09-opus-magnum-zachtronics-irl.html
- https://biggieblog.com/?p=836
- https://store.steampowered.com/app/1318690/shapez/
- https://forum.quartertothree.com/t/hades-supergiant-games/139167?page=47
- https://steamcommunity.com/app/632360/discussions/0/1639790664937280264
- https://spelunky.fandom.com/wiki/Daily_Challenge_Mode_(HD)
- https://gamingtrend.com/news/spelunkys-daily-challenge-system-will-provide-competition-rage-on-steam
- https://www.gamedeveloper.com/design/the-24-hour-ticket-examining-daily-runs-
- https://theludite.com/2014/06/23/spelunky-when-scoring-goes-bad/
- https://steamcommunity.com/app/503940/discussions/0/1742231069944422003
- https://lr.psf.lt/r/TransportFever/comments/1e2zrr3/signaling
- https://kotaku.com/terra-nil-review-city-builder-devolver-digital-pc-ios-1850267414
- https://codeparade.itch.io/marblemarcher
- https://en.wikipedia.org/wiki/Manifold_Garden
- https://indieklem.substack.com/p/19-the-diegetic-dilemma-benefits
- https://www.gamedeveloper.com/design/game-ui-discoveries-what-players-want
- https://en.wikipedia.org/wiki/Pie_menu
- https://300mind.studio/blog/radial-menus-in-game-design/
- https://steamcommunity.com/app/753640/discussions/0/2518023667588821798
- https://en.wikipedia.org/wiki/Timelie
- https://www.geekyhobbies.com/the-gardens-between-indie-game-review/
- https://bit-tech.net/reviews/gaming/pc/achron-review/1/
- https://shacknews.com/article/70050/achron-review
- https://forum.quartertothree.com/t/children-of-a-dead-earth/126112
- https://store.steampowered.com/app/846030/V/
- https://forums.frontier.co.uk/threads/neutron-highway-long-range-route-planner.308674/
- https://en.wikipedia.org/wiki/A_Slower_Speed_of_Light
- https://arxiv.org/abs/1703.07063
- https://oopartgames.com/blogs/cultural-insights/exploring-time-dilation-mechanics-in-a-board-game-design
- https://pcgamesn.com/civilization-vi/strategy-game-endgame-design
- https://forums.civfanatics.com/threads/the-4x-problem-of-snowballing.621076
- https://bugnet.io/blog/how-to-design-a-4x-games-pacing
