# Prior art: what's already been made

Research notes for a Star Trek–style game with (1) first-person battle, (2) navigation /
adventure / strategy, and (3) a futuristic vectorized look. Organised by what each
ancestor solved, and what's worth stealing.

## 1. The strategy layer — grid galaxy, resource pressure

**Star Trek (Mike Mayfield, 1971, BASIC).** The original. An 8×8 galaxy of quadrants,
each an 8×8 grid of sectors. Klingons to kill, a stardate deadline, energy and torpedoes
as scarce resources, starbases to dock at, long-range scanners revealing neighbours as a
three-digit code. Phasers weaken with distance; stars block torpedoes.

*Steal:* the deadline. Every decision costs energy **and** time, so exploring is a
genuine gamble against the clock. This is the cleanest strategy skeleton ever built for
this fantasy, and it's ~500 lines of logic.

**Star Fleet I: The War Begins (1985), Trek73, Netrek (1988).** Descendants that added
rank progression, multi-ship fleets, and — in Netrek's case — 16-player team warfare over
a persistent galaxy. Netrek is arguably the first online team sports game.

**Star Trek: Infinite (2023, Paramount/Nimble Giant, on Paradox's Stellaris engine)** and
**Star Trek: Fleet Command** (mobile 4X). Both prove the grand-strategy end of the range
sells, and both are far from the "sit in the chair" fantasy. Not our lane, but useful as
a boundary marker.

## 2. The fusion — first-person cockpit *plus* a map

**Star Raiders (Doug Neubauer, Atari 8-bit, 1979).** The single most important reference
for this project. First-person 3D cockpit view for flight and combat; a 2D Galactic Chart
for strategic movement; hyperwarp between sectors; energy as the universal currency;
damage to individual subsystems (shields, computer, engines); starbases that must be
docked with to repair and refuel; and an enemy (the Zylons) that *moves on the map while
you're elsewhere* — starbases fall if you ignore them.

It directly inspired Elite, Wing Commander, and most of the genre. It is, essentially,
exactly the design the brief describes — which is good news: the shape is proven, and the
2026 version of it doesn't really exist.

*Steal:* the whole loop. Chart → hyperwarp → cockpit fight → dock → repeat, with the
strategic situation degrading in real time while you're heads-down in a dogfight.

**Elite (1984).** Wireframe 3D trading and combat across 8 galaxies, procedurally
generated. Established that a vector look can carry an enormous game world on almost no
memory, and that docking can be a skill test in itself.

**Star Trek: Bridge Commander (2002, Totally Games).** From the X-Wing / TIE Fighter team.
You command from the bridge and delegate — order helm to attack pattern, order tactical
to target the enemy's warp nacelle — rather than flying a fighter. Subsystem targeting is
its best idea: shooting a specific component produces a specific tactical outcome.

**Star Trek: Starfleet Command (1999–2002)** and **Klingon Academy (2000).** Adaptations
of the *Star Fleet Battles* tabletop. Heavy, top-down-ish tactical combat: energy
allocation across shields/weapons/engines each turn, shield facings, overloaded photons,
hit-and-run raids. The deepest combat math in the franchise's history.

*Steal:* energy allocation as the core combat verb, and shield **facings** — turning your
undamaged flank toward the enemy is a real decision every few seconds.

## 3. The arcade end — vector graphics, short sessions

**Star Trek: Strategic Operations Simulator (Sega, 1982).** The first licensed Trek
arcade game, true vector display, sold in an upright and a "Captain's Chair" sit-down
cabinet modelled on the refit *Enterprise* bridge. Split screen: a 3D forward view at the
bottom for aiming and shooting, a 2D overhead scanner at the top for situational
awareness. Waves of Klingons, occasional Nomad probe, docking with starbases to refuel.
Inspired by the Kobayashi Maru scene in *The Wrath of Khan*.

*Steal:* the split display. Forward view + overhead scanner simultaneously is a genuinely
good solution to "first-person combat needs spatial awareness", and it looks fantastic in
vector.

**Battlezone (1980), Star Wars (1983), Tempest (1981), Asteroids (1979).** The vector
canon. Battlezone: first-person wireframe tank combat with a radar. Star Wars: colour
vector, the trench run, and voice samples. Tempest: a wireframe web with a colour XY
monitor — the aesthetic Jeff Minter has been refining ever since through Tempest 2000 and
**Tempest 4000** (2018), which renders the vector look with modern shaders and bloom at
4K/60.

*Steal:* the phosphor bloom itself. Real vector monitors overdrove bright lines into a
glow with visible beam overshoot at corners; that's the "futuristic vectorized feel" and
it's a post-processing recipe, not a modelling one.

## 4. The bridge-crew / systems-management branch

**FTL: Faster Than Light (2012).** Not first-person at all, but the best example of the
"your ship is a set of systems under pressure" fantasy: reroute power from life support
to shields, crew fight fires, a jump map with a pursuing fleet forcing forward motion.

**Artemis Spaceship Bridge Simulator (2010)** and **EmptyEpsilon** (open source, C++/SFML,
the Artemis successor with a Game Master mode). Six players, one ship: Captain, Helm,
Weapons, Relay, Science, Engineering, each at their own screen. The purest "be the bridge
crew" implementation, and EmptyEpsilon is MIT-ish open source and readable if we want to
study station design.

**Star Trek: Bridge Crew (2017, VR).** Ubisoft's take — four players, one bridge,
voice-driven. Proved the fantasy has real pull; also proved it dies without other people
online.

**Duskers, Objects in Space, NEBULOUS: Fleet Command.** The modern "diegetic instruments"
school — you interact with the ship through its own readouts (terminals, radar,
switchboards) rather than a game HUD. NEBULOUS in particular does radar/EW as the core
skill: you're fighting contacts, not ships.

*Steal:* diegetic UI. Everything the player reads should be something the ship is
displaying, which happens to be exactly what a vector aesthetic wants to draw anyway.

## 5. The adventure branch

**Star Trek: 25th Anniversary (1992)** and **Judgment Rites (1993)**, Interplay.
Episodic: a point-and-click away mission bookended by ship combat, scored at the end of
each episode on how diplomatically you behaved. Shooting your way through cost you points.

**Star Trek: Resurgence (2023, Dramatic Labs)** — Telltale-style branching narrative, made
by ex-Telltale staff. **Star Trek Online** (2010–present) — still running, still the
biggest live Trek game.

*Steal:* the scoring stance. Rewarding restraint and curiosity over kills is the single
most Trek-shaped mechanic anyone has shipped, and almost nobody does it.

## Where the gap is

- Nobody has made a **modern Star Raiders**: real-time first-person vector combat welded
  to a live strategic map, in a browser, with 2026 rendering.
- The vector-arcade look has had a revival in tunnel shooters (Tempest 4000, Polybius) but
  not in a game with a *strategy layer* underneath it.
- Trek-flavoured games are mostly either narrative adventures or grand strategy. The
  captain-of-one-ship-under-pressure fantasy is underserved outside of licensed titles
  from 20+ years ago.

## Legal note

Paramount's published fan-content guidelines cover **fan films** (under 15 minutes,
under $50k raised, non-commercial) and have no games equivalent. Fan *games* have
historically been shut down by C&D when they use the marks. Practical position: build the
genre, not the licence. No "Star Trek", "Starfleet", "Enterprise", "Klingon", no LCARS
layout, no delta insignia, no character or actor likeness. Everything above is mechanics
and aesthetics, none of which is protectable. Ship it under our own name and universe.

## Sources

- [Star Trek (1971 video game) — Wikipedia](https://en.wikipedia.org/wiki/Star_Trek_(1971_video_game)) ·
  [meatfighter breakdown](https://meatfighter.com/startrek1971/)
- [Star Raiders — Wikipedia](https://en.wikipedia.org/wiki/Star_Raiders) ·
  [Video Games' First Space Opera — Game Developer](https://www.gamedeveloper.com/design/video-games-first-space-opera-exploring-atari-s-star-raiders)
- [Star Trek: Strategic Operations Simulator — Memory Alpha](https://memory-alpha.fandom.com/wiki/Star_Trek:_Strategic_Operations_Simulator) ·
  [Star Trek (arcade game) — Wikipedia](https://en.wikipedia.org/wiki/Star_Trek_(arcade_game))
- [Star Trek: Bridge Commander — TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/StarTrekBridgeCommander) ·
  [Klingon Academy](https://www.old-games.com/download/6613/star-trek-klingon-academy)
- [Tempest 4000 — Wikipedia](https://en.wikipedia.org/wiki/Tempest_4000) ·
  [Tempest 4000 review — GamesBeat](https://gamesbeat.com/tempest-4000-review-ataris-wireframe-shooter-glows-and-shrinks-in-4k/)
- [EmptyEpsilon — GitHub](https://github.com/daid/EmptyEpsilon) ·
  [EmptyEpsilon site](https://daid.github.io/EmptyEpsilon/)
- [FTL: Faster Than Light — Wikipedia](https://en.wikipedia.org/wiki/FTL:_Faster_Than_Light) ·
  [NEBULOUS: Fleet Command — Steam](https://store.steampowered.com/app/887570/NEBULOUS_Fleet_Command/) ·
  [Duskers — Steam](https://store.steampowered.com/app/254320/Duskers/)
- [CBS/Paramount fan film guidelines — Fast Company](https://www.fastcompany.com/3061242/cbs-and-paramount-have-official-guidelines-for-people-making-star-trek-fan-films)
- [three.js bloom / glow post-processing](https://discourse.threejs.org/t/add-glow-effect-on-line-of-my-shader/34682)
