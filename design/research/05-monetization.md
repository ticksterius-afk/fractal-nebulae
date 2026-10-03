# 05 — Monetization options for a Fractal Nebulae game (evidence review)

Researched 2026-10-02. Scope: a solo-developed, browser-first WebGL2/three.js app (0.6 MB, no backend, hosted on GitHub Pages) that may become a puzzle game, a simulation/exploration game, or a light strategy game, in the browser and/or wrapped for Steam.

Method note: the session's web-search budget ran out part-way through, so the second half of this report relies on direct fetches of primary pages (Steamworks docs, Poki/CrazyGames/itch docs, GitHub docs, store pages, developer blogs). Where a figure comes from a third-party sales estimator (Gamalytic, VG Insights, SteamPulse, raijin.gg) it is labelled "estimate"; those tools disagree with each other by 2-4x, so treat them as order-of-magnitude only. Items I could not verify this session are flagged "unverified".

---

## (a) Case studies with figures

### Browser-first games and apps

**Townscaper (Oskar Stålberg, solo).** Positioned as "a toy, not a game". Sold 380,000 Steam copies within about a year of its June 2020 Early Access launch (MCV/Develop, 19 May 2021). List price today is $5.99 on Steam. In December 2021 Stålberg released a free browser demo that is "almost identical" to the full game except for a smaller build grid; the paid version adds colour palettes, undo history and more tile variants. Third-party lifetime estimates range from 464k copies / $2.4M gross to 1.6M copies / $9.8M (estimates; raijin.gg and vaporlens). Lesson: a free, feature-limited web build plus a cheap premium build is a proven pattern for zen/toy software.

**Tiny Glade (Pounce Light, 2 people).** No-goals castle-doodling toy, $14.99 plus a $6.99 soundtrack. Its June 2024 Next Fest demo was the fourth most-played demo and it accumulated 800,000+ wishlists before release (Wikipedia). Critics flagged "limited gameplay and content" yet it sold strongly; evidence that beauty-first sandboxes can command mid-teens pricing if the demo goes viral.

**Vampire Survivors (poncle).** Built in Phaser (HTML5). Released free on itch.io in March 2021 "with close to no success at all", then put on Steam Early Access in December 2021 at a very low price; reached ~70,000 concurrent players by February 2022. Crucially for this project, the Phaser/web build was ported to Unity from v1.6 because the developer wanted "an industry-standard game engine to improve its overall performance" (Wikipedia). SteamPulse estimates 7.9M Steam units / $23.8M (estimate). Lesson: web tech can launch on Steam, but at scale the wrapper's performance ceiling became a real cost.

**Cookie Clicker (Orteil/DashNet).** Free web game since 2013, supported by ads and a Patreon that ran October 2018 to January 2026; the last public Graphtreon snapshot (25 Jan 2026) showed 201 paying members, $1,162/month, 20,618 total members — i.e. Patreon was a modest side income even for one of the most-played web games ever. The Steam version (1 Sep 2021, $4.99, publisher Playsaurus) added a C418 soundtrack (sold separately at $4.99), hit 60,000+ concurrent players at launch and sits at 96% positive on 92,000+ reviews. Lifetime estimates: 2.5M copies / $10.8M (VG Insights-style, "medium confidence") up to 6.75M / $33.7M (raijin.gg) — estimates. Lesson: the web version built the audience for free; Steam converted it into cash at a trivial price point.

**Universal Paperclips (Frank Lantz).** Free web (about 2 million players), then a $1.99 mobile app with "no ads, no in-app purchases, full gameplay" (App Store listing: 312 US ratings, 4.5 stars). Revenue has never been published (unverified).

**A Dark Room (Doublespeak Games / Amir Rajan).** Free web text game ported to iOS as a premium app. Published numbers (PocketGamer, 18 Apr 2016): 2.26M downloads in under two years, $697,270 gross, $191,810 net to Rajan; the prequel The Ensign netted $29,765 and A Noble Circle $3,064. Lesson: the follow-ups earned a small fraction of the hit; web-to-paid-port works once per audience.

**Melvor Idle (Games by Malcs).** JavaScript web game wrapped for Steam (18 Nov 2021, $9.99, published by Jagex); 8,611 reviews at 92% positive. A clean example of a JS game that sells on Steam without engine migration.

**Balatro (LocalThunk / Playstack).** Not web-first, but the canonical demo-led launch: 43 wishlists in May 2023, 28,661 by end of July 2023 after a Northernlion stream, 208,401 on launch day (20 Feb 2024); 119,000 Steam units on day one; price $14.99 with a $2.99 soundtrack. The developer switched the demo from "round-limited" to "content-limited" so players could replay freely.

**GeoGuessr (subscription).** About €21M annual revenue at a 45-50% margin, 85-90% from subscriptions, after moving nearly everything behind a paywall on 1 February 2024; 85M registered, 15M monthly active (OMR, 11 Oct 2024). Pro is $2.99/month billed annually in 2026. Lesson: subscription works at tens of millions of users with daily-habit content; not a model for a solo single-player project.

**NYT Games.** Passed 1M Games subscriptions by late 2021 and has not broken the figure out since; Games bundle is $6.99/month. Same lesson as GeoGuessr: subscriptions require a daily content treadmill.

**Lichess (donations).** Costs about $720,000/year, average donation €5, three full-time staff (OSFY, 24 Nov 2025); record month of $80,000+ in December 2025 (Lichess blog). Donation-funded operation is viable only at enormous scale and with a non-profit identity.

**Bloxd.io.** Browser voxel game, 6M+ monthly players, team of 2-10 in London (Hitmarker); revenue not public (unverified). Monetises through ads and in-game purchases on a self-hosted site, i.e. the "own-site plus portals" pattern.

**Sandspiel (Max Bittker).** MIT-licensed, free, no monetization visible in the repository. It is an audience and reputation builder, not an income source.

### What the web portals actually pay

- **Poki**: "If a user comes to your game directly, through bookmarks, search, social media or through your own community, you get 100% of the revenue for that user. If a user comes to your game through Poki.com, or through a marketing effort from Poki, then Poki splits the revenue 50/50 with you." Requires web exclusivity (Steam/app stores/consoles remain allowed); a Sept 2026 comparison says the default term is five years. Poki reports 100M monthly players and top studios earning up to about €1M/year, up from $50k before its developer-first model (Dealroom/PocketGamer.biz coverage).
- **CrazyGames**: no exclusivity ("Publishing your game on other platforms doesn't affect your eligibility"); IAP supported through the SDK; monthly payout once the balance clears €100 via Tipalti. The ad split is not published in the docs; the 2026 GameMaker jam terms cite 60% of ad revenue and 70% of IAP to developers.
- **GameDistribution**: 33% to developers (the only portal that publishes its split).
- **itch.io**: default 10% platform share, seller-adjustable from 0-100% (itch.io blog, 4 Mar 2015); "30% of all money spent on itch.io is 'extra' money that is paid above the minimum" (itch pricing docs). A 2026 earnings-distribution estimate puts ~80% of paid itch games at $0-50/month and under 1% above $2,000/month (cinevva guide; methodology not shown).
- **eCPM**: rewarded video roughly $15-28 in the US, $8-15 in the EU, $1-3 in India/Brazil; rewarded pays ~2x interstitial, banners are negligible (Playgama figures quoted in cinevva's 2026 guide). A "well-performing casual game on a major portal typically clears $200 to $2,000 a month".
- **Ad-block exposure**: 29.5% of internet users worldwide use ad blockers (GWI Q2 2025 via DataReportal); US desktop 37%; age 18-24 about 41% (Backlinko compilation). A desktop-only, tech-literate astronomy audience will block ads at the high end of those ranges.

### Steam baseline for small indies (2025-2026)

- About 20,000 games released on Steam in 2025; 65.9% grossed under $1,000, roughly 40% never reached the $100 Steam Direct recoup threshold, 8% grossed over $100,000 (Gamalytic data summarised by game-developers.org, 21 Aug 2026). Indie games as a whole took ~$4.4-4.5B of Steam's record $17.7B in 2025.
- Of January 2026 paid releases, 1.3% have grossed over $1M and 6.5% over $100k lifetime (GameDiscoverCo, 15 Sep 2026).
- Chris Zukowski's tiers: Bronze $0-10k, Silver $10-149k, Gold $150-999k, Diamond $1M+. Only 5.7% of Bronze games ship any DLC; he advises "for games that will earn at least $10,000+ it is probably worth doing some minor supporter-style DLC in time for the launch" (3 Mar 2026).
- Wishlist conversion is wildly variable (1% to 40%); Zukowski's worked example is 7,000 wishlists x 3% x $19 = ~$3,990. He suggests 7,000-10,000 wishlists before launch to reach Popular Upcoming (29 Jan 2024). Secondary compilations of his data put median day-one conversion near 12% and week-one at 15-20%, with games over 25,000 wishlists converting around 0.15x in week one (steampageanalyzer.com; secondary).
- Demos: median launch peak CCU is 3.01x the demo's peak CCU across 2,569 games (GameDiscoverCo, 8 Sep 2026); a 200-CCU demo "very roughly" implies ~12,000 first-week units. Parcel Simulator's demo took wishlist velocity from 11/day to 362/day and the game sold 50,000 units in two weeks (Zukowski, 26 Aug 2025).

---

## (b) Comparison of models

| Model | Expected revenue (solo, modest audience) | Effort | Player sentiment | Puzzle | Sim/exploration | Strategy |
|---|---|---|---|---|---|---|
| Portal ads (Poki/CrazyGames) | $200-2,000/mo for a "well-performing" casual game; most games far less; heavy ad-block on desktop | Low-medium (SDK, exclusivity terms) | Tolerated on portals, hated on an "art" site | Weak (short sessions needed) | Weak (ads break the mood) | Medium |
| Free web + paid Steam build | Bronze/Silver tiers realistic ($1k-50k); Townscaper/Cookie Clicker/Melvor show upside | Medium (wrapper, Deck, store page, demo) | Very positive if the web version stays free | Strong | Strong | Strong |
| In-browser unlock (Paddle/Lemon Squeezy/itch keys) | Low thousands; itch's 10% cut beats Steam's 30% but discovery is near zero | Low (no backend needed if licence check is client-side) | Positive if the free tier is generous | Medium | Medium | Medium |
| Soundtrack / "album mode" DLC | Attach 0.1-3% of base buyers at $3-8 (Zukowski); counts toward base-game revenue | Low (generative music already exists) | Positive; expected | Yes | Yes | Yes |
| Supporter pack (cosmetics, wallpapers, codex extras) | Attach 2-7% of buyers at $4-7; $94k median for $1M+ games, $3.7k for Gold | Low | Positive when purely optional | Yes | Yes | Yes |
| Expansion DLC | Highest absolute DLC return (14-36% attach) but only for games that already sold | High | Positive if substantial | Later | Later | Later |
| Season pass | No evidence of success for small puzzle games; attach data is for big titles | High | Negative for single-player indies | No | No | Weak |
| Vanity naming ("name a nebula") | One-off $5-15 purchases; RimWorld's Name in Game Access is $14.99 | Low-medium (needs a registry; without a backend it's a shipped JSON) | Fine if clearly "in-game only" (IAU precedent) | Weak | Strong | Medium |
| Patreon / Ko-fi / GitHub Sponsors | Cookie Clicker's Patreon: ~$1.2k/mo at its end; most creators far below | Low | Positive, low friction | Weak | Medium | Weak |
| Subscription | Needs daily content and millions of users (GeoGuessr, NYT) | Very high | Negative for a solo indie | No | No | No |
| Education/site licences | Per-seat/site annual deals; lumpy; requires outreach | Medium | N/A | Weak | Strong | Weak |
| Prints/merch | Pocket money; print-on-demand margins are 10-50% of a $20-40 print | Low | Neutral | Weak | Medium | Weak |

---

## (c) Web-to-Steam technical pathway

**Wrapper choice.** Electron is the de-facto path for WebGL games on Steam: `steam-electron-build` (extracted from the shipped Steam game DICEPTION) packages PixiJS/Phaser/three.js games for Windows, macOS (Intel + ARM) and Linux, uses `steamworks-ffi-node` (SDK 1.64) for achievements/stats/cloud-style JSON saves/lobbies, and documents the Steam Deck fixes it needed: Electron switches `--no-sandbox --no-zygote --in-process-gpu --disable-dev-shm-usage`, correct `libsteam_api.so` library-path ordering, and a clean process exit so Steam notices the game closed. Its stated caveat: on macOS the overlay mirror "often sits offset under the Electron window and Shift+Tab does not reliably open the injected overlay". `steamworks.js` (ceifa) is the maintained alternative to Greenworks for Electron/NW.js and needs `electronEnableSteamOverlay()` in the main process; Greenworks itself is "maintained on a best-effort basis" at SDK 1.62. NW.js shipped CrossCode (JavaScript; the publisher had to compile the JS for consoles and Switch reviewers noted framerate dips). Tauri is a poor fit for this project: it uses WebView2 (Chromium) on Windows but WKWebView on macOS and webkit2gtk on Linux — the latter is exactly what runs on Steam Deck, and Tauri's own docs call Linux WebKitGTK support "very hard to compile accurate information about". A raymarched WebGL2 renderer needs one known Chromium build, so Electron (or NW.js) it is.

**Steam Deck.** Deck Verified requires a default controller configuration giving "access to all content", on-screen glyphs that match the input, text readable at 30 cm (minimum 9 px character height at 1280x800), no unsupported-hardware warnings, and text entry through Steamworks APIs. A mouse+keyboard 6-DoF flight app will need a controller scheme and larger UI to get past "Playable". A native Linux Electron build inside the Steam Linux Runtime avoids Proton entirely.

**Costs and alternatives.** Steam Direct is "$100 USD (or equivalent) fee for each new app", recoupable once the app reaches $1,000 adjusted gross. Epic takes 12% (88% to the developer), also charges $100 to list, and from June 2025 takes 0% until a game passes $1M in sales — but discovery on Epic for a tiny indie is minimal. itch.io's default is 10%. Playdate (about 70,000 units sold by Feb 2024, 1-bit screen) is irrelevant to a WebGL renderer.

**Performance risk.** Vampire Survivors left Phaser for Unity specifically for performance, and CrossCode's console ports struggled. For a fragment-shader-bound raymarcher the wrapper overhead is small (the GPU is the bottleneck either way), but expect Steam reviews to mention "it's just a website in a window" if the build is large, slow to start, or lacks Steam features. Ship achievements, cloud saves and overlay support via steamworks.js to counter that.

---

## (d) Pricing guidance

**Observed list prices (Steam US, fetched 2 Oct 2026):**

- Zen/toy: Townscaper $5.99; ISLANDERS $4.99 and New Shores $9.99 (+$4.99 OST); Mini Motorways $9.99; Dorfromantik $13.99 (+two $5.99 soundtracks, +$4.99 Medieval Biome Pack); Tiny Glade $14.99 (+$6.99 OST); Cloud Gardens $17.99.
- 2-6 hour puzzle: Stacklands $7.99; A Little to the Left $14.99 (+$5.99 and $8.99 DLC); Baba Is You $14.99 (+$2.99 OST); Chants of Sennaar $19.99 (+$7.99 OST); Manifold Garden $19.99 (+$7.99 OST); COCOON $24.99 (+$7.99 OST).
- Space exploration: Exo One $16.99 (+$6.99 OST); Outer Wilds $24.99 (+$14.99 expansion, +$9.99 OST); SpaceEngine $29.99 (+$69.99 PRO); Universe Sandbox $29.99.
- Roguelike/light strategy: Luck be a Landlord $9.99 (+$7.99 OST); Thronefall $12.99; Balatro $14.99 (+$2.99 OST); Slipways $16.99 (+$4.99 OST); Cookie Clicker $4.99 (+$4.99 OST).
- Supporter packs cluster at $4-7 (range $1-13 in the first 20 search results); RimWorld Name in Game Access is $14.99.

**Rules of thumb (Zukowski, 23 Aug 2022):** pick ten comparable games from the last three years, then price 20% above the ones that match your quality; "nobody buys at full price on Steam", so build the inevitable discounts into the list price; "if nobody complains about your price, you priced it too low". For this project that maps to: zen/exploration toy $9.99-14.99; puzzle game with 3-6 hours of authored content $12.99-19.99; roguelike-strategy $12.99-16.99. Going below $9.99 only makes sense for a Townscaper-style "tiny toy" that leans on volume.

**Launch and regional mechanics (Steamworks docs):** launch discounts run 7-14 days, maximum 40%, "around 10% to 15%" is typical; a standard discount triggers a 30-day cooldown and there is also a 30-day cooldown after release and after any base-price increase; seasonal sales are exempt. Prices must be entered in all 37 currencies; Valve's Multi-Variable Conversion (purchasing power + local entertainment costs + FX) is the recommended default. The minimum price tier is $0.99.

**Soundtrack economics.** Steam soundtracks are a separate app type: they can be bought without owning the game, require MP3 (FLAC/WAV optional in a separate depot), count toward the parent game's revenue total, and "sell particularly well as a component of a bundle including the base game and the soundtrack for a slight price increase". Attach rates are small — 0.12% (Bronze) to 2.8% (Diamond) of buyers, with one Silver-tier outlier at 16.9% (Zukowski, 3 Mar 2026). Comparable OST prices are $2.99-9.99; $4.99-6.99 is the sweet spot. Because Fractal Nebulae's music is generative, an "album mode" product (fixed-seed renders of the generator, 40-60 minutes, FLAC) can be produced cheaply and also sold on Bandcamp (15% cut, dropping to 10% after $5,000 in sales).

---

## (e) Educational and institutional channels

- **Universe Sandbox** sells education licences as "yearly recurring subscriptions tailored to individual needs (per-seat, per-classroom, or site-wide)" to "primary and secondary schools, universities, museums, homeschool organizations, and libraries", bundled with "an offline, DRM-free copy"; pricing is quote-based on seat count. Public venues (VR arcades etc.) go through Steam's Site Licensing / PC Café program, which explicitly covers a "café, school, museum, showroom, or other public performance venue". The retail game is $29.99 and teachers can get roughly a third off via education resellers.
- **SpaceEngine PRO** ($69.99 DLC) is the cleanest analogue for a planetarium product: it "changes the SpaceEngine license to allow for personal commercial use", unlocks unlimited-resolution fisheye/dome and equirectangular output, a camera-path editor, and transparent-background exports, while forbidding stock-site resale. A "Dome/Pro" tier for Fractal Nebulae (fisheye render, 4K+ stills, commercial screening rights) at $29-79 is the obvious copy.
- **Minecraft Education** is sold per user per year through Microsoft education licensing; commonly cited figures are ~$5/user/year academic and ~$12 non-academic (the licensing page timed out twice; unverified). **KerbalEdu** was launched with TeacherGaming in 2014; Universe Sandbox now refers to "legacy TeacherGaming" licences, which implies that channel no longer sells (current status unverified).
- **Grants.** NSF's Advancing Informal STEM Learning solicitation (NSF 24-601) is archived as of May 2026 and targeted institutions (museums, observatories, societies). NASA Science Activation funds "a competitively-selected network of collaborative projects" via ROSES cooperative agreements to organisational teams, not individuals. Simons Science Sandbox, Sloan's Public Understanding of Science and the Creative Europe MEDIA video-games pages were unreachable this session (unverified). Practical path: a solo developer applies as a subcontractor or partner of a planetarium/university, not as the lead.
- **Prints and merchandise.** Print-on-demand margins are modest: Society6 and Redbubble pay a 10-20% default margin (pages blocked this session; unverified), INPRNT about 50% of the print price (unverified). Chaotica, a commercial fractal renderer, is a useful precedent for tiered licensing rather than merch: free up to 1.23 MP non-commercial, HD up to 4 MP (~€25), Studio unlimited (~€89). Treat prints as marketing with a tip jar, not revenue.

---

## (f) Legal and licensing notes

- **GitHub Pages.** GitHub's limits page states: "GitHub Pages is not intended for or allowed to be used as a free web-hosting service to run your online business, e-commerce site, or any other website that is primarily directed at either facilitating commercial transactions or providing commercial software as a service (SaaS)." Soft limits: 100 GB bandwidth/month, 1 GB site, 10 builds/hour. The Acceptable Use Policy adds that "the primary focus of the Content ... should not be advertising or promotional marketing". Reading: a free game that links out to Steam/itch is fine; running the checkout, ad stack or a paid SaaS tier on Pages is not. Move to Cloudflare Pages/Netlify (or your own domain) before adding ads or an unlock flow. At 0.6 MB per load, 100 GB is roughly 160,000 page loads/month, so a viral spike could also exceed the soft limit.
- **Repository licence.** A public repo with no LICENSE file is all-rights-reserved: "Nobody else can copy, distribute, or modify your work without being at risk of take-downs, shake-downs, or litigation" (choosealicense.com). GitHub's ToS section D.5 only grants other users a licence "to use, display, perform and reproduce (by forking) Your Content through the Service". So a public, unlicensed repo does not block commercialisation; it just leaves contributors' rights ambiguous. Options used by sold games: GPL-3 with the game sold on Steam for convenience and assets (shapez, Mindustry — both GPL-3 code; shapez keeps assets in a separate repo), a source-available non-commercial licence (PolyForm Noncommercial or similar), or closing the repo before launch. Add a CLA or keep contributions out if you plan to relicense later.
- **Dependencies.** three.js and Tone.js are MIT: "Permission is hereby granted, free of charge ... to deal in the Software without restriction", provided "the above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software" — ship a THIRD-PARTY-NOTICES file. @fontsource fonts are OFL; the OFL FAQ says bundling is allowed in "games and entertainment software" and selling the bundle is fine, but fonts "cannot be sold standalone" and modified fonts must drop Reserved Font Names (converting to WOFF can count as modification unless functionally equivalent).
- **Payments without a backend.** Merchant-of-record services handle global VAT: Paddle "5% + 50¢ per Checkout transaction"; Lemon Squeezy 5% + $0.50 and "we take on tax collection and calculation liability across all jurisdictions". itch.io can sell keys at 10%. Patreon takes "10% of the income you earn on Patreon" plus processing; GitHub Sponsors "does not charge any fees for sponsorships from personal accounts".
- **Vanity naming.** The International Star Registry has sold 2M+ names; the IAU is "the only internationally recognized authority for naming celestial bodies" and New York's consumer agency filed a deceptive-advertising complaint in 1998. An in-game "name a nebula" feature is safe as long as it is framed as in-world flavour (RimWorld's $14.99 Name in Game Access, or Elite Dangerous' free "first discovered by" credit — the latter is well known but was not verified this session).

---

## (g) Recommended monetization stack per direction

**Shared base for all three.** Keep the current app free on the web as the demo and funnel (move hosting off GitHub Pages before any commerce). Ship a Steam build via Electron + steamworks.js with achievements, cloud saves and a controller scheme that can reach Deck Verified. Launch with a soundtrack/"album mode" app ($4.99-6.99, FLAC depot, also on Bandcamp) and a $4.99-6.99 supporter pack (4K wallpaper renders, codex extras, dome/fisheye export, a name in the credits). Budget $100 Steam Direct per app (game, soundtrack is an associated app). Collect wishlists for at least six months and run a content-limited demo through Next Fest before launch — the demo CCU x3 rule gives an early read on launch size. Do not run portal ads on the art-first version.

**Puzzle game.** Premium only: $12.99-14.99 for 3-6 hours of authored levels, 10-15% launch discount, OST and supporter pack at launch, a $4.99-8.99 level-pack DLC only if the base game clears Silver. Keep a free 6-10 level web demo (Townscaper pattern). Skip Patreon and vanity items; puzzle buyers want a complete, finite product.

**Simulation/exploration game.** Highest ceiling for ancillary revenue: $9.99-14.99 base (Exo One / Tiny Glade band), supporter pack with "name a nebula" ($9.99-14.99, name stored in a signed registry file shipped with updates, clearly in-game only), album mode, and a $29-79 "Dome/Pro" tier modelled on SpaceEngine PRO (fisheye/4K/commercial screening). Pursue one or two planetarium pilots and quote site licences through Steam Site Licensing or direct invoices like Universe Sandbox. Patreon/Ko-fi is viable here because exploration players follow ongoing content.

**Light strategy game.** $12.99-16.99 (Thronefall / Slipways band) with a replayable content-limited demo (Balatro's lesson), OST and supporter pack at launch, and expansion DLC only after proven sales; if a free browser version exists it should be a deliberately smaller map/ruleset, published via CrazyGames (non-exclusive, allows Steam) rather than Poki (web-exclusive) to keep the funnel open.

Realistic expectations: with no existing audience the central outcome on Steam is Bronze (<$10k gross). The free web app is the lever that moves this toward Silver; everything above (DLC, Pro tier, licences) only pays once the base game sells.

---

## (h) Sources

- Poki developer guide, "Working with Poki" (revenue split, exclusivity) — https://developers.poki.com/guide/working-with-poki
- Poki payouts and billing — https://developers.poki.com/guide/payouts-billing
- Playgama, "Poki vs CrazyGames vs GameDistribution: revenue share compared", 9 Sep 2026 — https://playgama.com/blog/business-faqs/poki-vs-crazygames-vs-gamedistribution-revenue-share/
- Cinevva, "Web Game Monetization: What the Data Actually Says (2026)" (eCPM, splits, itch distribution) — https://app.cinevva.com/guides/web-game-monetization
- Cinevva, "CrazyGames Developer Guide" (2026) — https://app.cinevva.com/guides/publish-game-crazygames
- CrazyGames FAQ (payouts, non-exclusivity, IAP) — https://docs.crazygames.com/faq/
- Dealroom / PocketGamer.biz coverage of Poki's 1B monthly plays and developer revenues — https://app.dealroom.co/news/feed/poki-hits-1b-monthly-plays-as-developer-first-model-boosts-top-studio-revenues-tenfold-1 ; https://www.pocketgamer.biz/inside-pokis-vision-for-the-future-of-browser-gaming/
- itch.io, "Open revenue sharing", 4 Mar 2015 — https://itch.io/updates/open-revenue-sharing ; pricing docs — https://itch.io/docs/creators/pricing
- Backlinko ad-blocker statistics (GWI Q2 2025 via DataReportal) — https://backlinko.com/ad-blockers-users
- MCV/Develop, "When we made... Townscaper", 19 May 2021 — https://mcvuk.com/business-news/when-we-made-townscaper
- Townscaper browser demo coverage, Dec 2021 — https://gigazine.net/gsc_news/en/20211202-townscaper-demo-browser
- Wikipedia: Tiny Glade — https://en.wikipedia.org/wiki/Tiny_Glade ; Vampire Survivors — https://en.wikipedia.org/wiki/Vampire_Survivors ; Cookie Clicker — https://en.wikipedia.org/wiki/Cookie_Clicker ; CrossCode — https://en.wikipedia.org/wiki/CrossCode ; Epic Games Store — https://en.wikipedia.org/wiki/Epic_Games_Store ; Playdate — https://en.wikipedia.org/wiki/Playdate_(console) ; International Star Registry — https://en.wikipedia.org/wiki/International_Star_Registry ; Bandcamp — https://en.wikipedia.org/wiki/Bandcamp ; Kerbal Space Program — https://en.wikipedia.org/wiki/Kerbal_Space_Program
- SteamPulse estimate for Vampire Survivors — https://steampulse.org/game/1794680
- Graphtreon snapshot of DashNet Patreon, 25 Jan 2026 — https://graphtreon.com/creator/dashnet
- Universal Paperclips App Store listing — https://apps.apple.com/us/app/universal-paperclips/id1300634274 ; IF50 essay — https://if50.substack.com/p/2017-universal-paperclips
- PocketGamer, A Dark Room sales numbers, 18 Apr 2016 — https://www.pocketgamer.com/a-dark-room/the-co-creator-of-top-selling-ios-game-a-dark-room-shares-its-sales-numbers-and/
- Melvor Idle Steam page — https://store.steampowered.com/app/1267910/Melvor_Idle/
- OP Game Marketing, "Do Great Games Actually Sell Themselves? The Balatro Story" — https://opgamemarketing.substack.com/p/do-great-games-actually-sell-themselves
- OMR, GeoGuessr growth and revenue, 11 Oct 2024 — https://omr.com/de/daily/geoguessr-world-cup-wachstum
- Bloomberg/BQ on NYT Games subscribers — https://www.bloombergquint.com/onweb/n-y-times-credits-wordle-for-record-growth-of-games-subscribers
- Open Source For You on Lichess costs, 24 Nov 2025 — https://www.opensourceforu.com/?p=92564 ; Lichess end-of-year update 2025 — https://lichess.org/@/Lichess/blog/lichess-end-of-year-update-2025/YRiNKoaQ
- Hitmarker company page for Bloxd — https://hitmarker.net/companies/bloxd
- Sandspiel repository — https://github.com/MaxBittker/sandspiel
- game-developers.org, "2025 Steam Game Revenue Distribution", 21 Aug 2026 (Gamalytic) — https://game-developers.org/2025-steam-game-revenue-distribution
- WN Hub, indie share of Steam revenue 2025 — https://wnhub.io/news/analytics/item-49645
- GameDiscoverCo, "Is the game biz sustainable for the average indie dev?", 15 Sep 2026 — https://newsletter.gamediscover.co/p/is-the-game-biz-sustainable-for-the ; "Does your Steam demo CCU 'predict' your game's success?", 8 Sep 2026 — https://newsletter.gamediscover.co/p/does-your-steam-demo-ccu-predict
- Chris Zukowski: "Benchmark: How much money can you make from DLC?", 3 Mar 2026 — https://howtomarketagame.com/2026/03/03/benchmark-how-much-money-can-you-make-from-dlc/ ; "4 tips to help you price your indie game", 23 Aug 2022 — https://howtomarketagame.com/2022/08/23/4-tips-to-help-you-price-your-indie-game/ ; "Do wishlists matter any more?", 29 Jan 2024 — https://howtomarketagame.com/2024/01/29/do-wishlists-matter-any-more/ ; "The demo effect: From 7000 wishlists to 42,000", 26 Aug 2025 — https://howtomarketagame.com/2025/08/26/the-demo-effect-from-7000-wishlists-to-42000/
- Secondary wishlist-conversion compilations — https://www.steampageanalyzer.com/blog/how-many-wishlists-before-launch ; https://www.steampageanalyzer.com/blog/do-steam-demos-increase-sales
- Steamworks docs: Steam Direct fee — https://partner.steamgames.com/doc/gettingstarted/appfee ; pricing — https://partner.steamgames.com/doc/store/pricing ; discounts — https://partner.steamgames.com/doc/marketing/discounts ; soundtracks — https://partner.steamgames.com/doc/store/application/soundtrackapp ; Steam Deck compatibility — https://partner.steamgames.com/doc/steamdeck/compat ; Site Licensing / PC Café — https://partner.steamgames.com/doc/sitelicense
- Steam store search pages (prices fetched 2 Oct 2026 with cc=us) for Townscaper, Tiny Glade, Dorfromantik, ISLANDERS, Mini Motorways, Cloud Gardens, COCOON, Chants of Sennaar, A Little to the Left, Baba Is You, Manifold Garden, Outer Wilds, Exo One, SpaceEngine, Universe Sandbox, Balatro, Slipways, Thronefall, Luck be a Landlord, Stacklands, Cookie Clicker, "supporter pack", "name in game" — https://store.steampowered.com/search/
- SpaceEngine PRO Steam page — https://store.steampowered.com/app/1026970/
- Universe Sandbox education page — https://universesandbox.com/education/ ; FAQ — https://universesandbox.com/faq/
- Chaotica download/licence tiers — https://www.chaoticafractals.com/download
- NSF AISL (NSF 24-601, archived) — https://www.nsf.gov/funding/opportunities/aisl-advancing-informal-stem-learning ; NASA Science Activation — https://science.nasa.gov/learn/about-science-activation/
- steam-electron-build (Electron + Steam Deck fixes, from DICEPTION) — https://github.com/alexanderthurn/steam-electron-build ; steamworks.js — https://github.com/ceifa/steamworks.js ; Greenworks — https://github.com/greenheartgames/greenworks ; Phaser, "Publishing Web Games on Steam with Electron", Mar 2025 — https://phaser.io/news/2025/03/publishing-web-games-on-steam-with-electron ; Tauri webview versions — https://v2.tauri.app/reference/webview-versions/
- GitHub Pages limits (commercial-use clause) — https://docs.github.com/pages/getting-started-with-github-pages/github-pages-limits ; GitHub Terms of Service (D.4/D.5) — https://docs.github.com/en/site-policy/github-terms/github-terms-of-service ; Acceptable Use Policies — https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies ; choosealicense "No License" — https://choosealicense.com/no-permission/
- three.js LICENSE (MIT) — https://raw.githubusercontent.com/mrdoob/three.js/dev/LICENSE ; Tone.js LICENSE (MIT) — https://raw.githubusercontent.com/Tonejs/Tone.js/dev/LICENSE.md ; SIL OFL FAQ — https://openfontlicense.org/ofl-faq/
- shapez.io (GPL-3) — https://github.com/tobspr-games/shapez.io ; Mindustry (GPL-3) — https://github.com/Anuken/Mindustry
- Paddle pricing — https://www.paddle.com/pricing ; Lemon Squeezy pricing — https://www.lemonsqueezy.com/pricing ; Patreon pricing — https://www.patreon.com/pricing ; GitHub Sponsors fees — https://docs.github.com/en/sponsors/getting-started-with-github-sponsors/about-github-sponsors
