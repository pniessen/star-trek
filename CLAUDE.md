# Kobayashi

A vector-arcade starship game: first-person combat on a plane, a greed loop
built on docking, and a strategy layer — both halves built, the in-run
tactical chart and the between-runs command view. Working title; the eventual
larger game is *Deep Black*.

Full background in `docs/` — [todo.md](docs/todo.md) is what to pick up next,
[status.md](docs/status.md) is how it got here, then
[prior-art.md](docs/prior-art.md), [concept-options.md](docs/concept-options.md),
[strategy-layer.md](docs/strategy-layer.md), and
[audio-prior-art.md](docs/audio-prior-art.md), which the audio layer was built
*before* rather than from, and which contradicts it in several places.

## Run it

```
npm run dev            # http://127.0.0.1:5173
npm run typecheck      # tsc --noEmit — run before every commit
npm run standalone     # dist/kobayashi.html, one self-contained file
npm run playtest       # headless run + assertions (needs a Playwright browser)
npm run audiotest      # audio contracts against a mock context, bare node
npm run campaigntest   # chart logic assertions, bare node, no browser
npm run campaignlength # simulates thousands of campaigns, reports the length distribution
```

A fresh load lands on the title; any key that is not a display toggle launches a
run, and an idle cabinet falls through to an attract demo and back. **Every run
opens on the deck log** — a briefing built from the board it describes, legible
from the frame it appears, which any key skips and `L` switches off. The first
run of a war teaches the rules with it; every run after that is the situation
alone. It never plays for the demo.

Controls: arrows/WASD fly, **`Q` held climbs and released sinks**, Space
phasers, X torpedoes, `C` cracks a warhead for its charge when the reserve is
under half, `Z` pours the reserve into the thinnest facing, R restart. `G`
toggles wireframe vs occluded, `B`/`F`/`V` toggle bloom/phosphor/CRT, `M` mutes,
**`L` turns the deck log off and back on**, **`Y` switches the altitude slab off
and back on**, `1`/`2`/`3` switch cockpit/chase/orbit, `H` hides diagnostics.

**WASD moves the sector cursor on every screen that has a grid**, and nothing
else ever does. `Tab` raises the chart without pausing the game; WASD moves its
cursor while it is up and the arrows keep flying; `Shift` charges a hyperwarp
jump whose length is the distance it covers, halving the multiplier on arrival.
Between runs the command view uses the same WASD on the same map, up/down
arrows for the decision list, `Space` to commit and `Enter` to launch.

## Decisions that are locked

Do not quietly revisit these; they are load-bearing and each closed off
alternatives deliberately.

- ~~**The play space is a plane.** The scanner is only trustworthy if the world
  is flat. Everything else follows from this.~~ **Unlocked, deliberately, with
  the owner's approval.** Neither load path survived scrutiny. *The scanner*:
  Elite solved a 2D tube over a 3D world in 1984 with a vertical stalk from each
  blip down to the plane, and Elite is in our own `prior-art.md` — height reads
  instantly and nothing is misplaced. *The facings*: `Ship.facingFrom` has always
  resolved a hit with `atan2(x, z)` and never looked at `y`, so **the four
  shields are a ring, not a sphere** — a shot from above at bearing 40° already
  hit the same quarter a level one did. A cylinder was always the model.
  The old reasoning is kept because a decision that changed is worth more with
  its history attached.
- **The play space is a shallow slab, floored at `y = 0`, reached with one
  key.** This is what replaced it. `Q` held climbs, released sinks; descent is
  not an input, which is the whole reason it costs one binding rather than two —
  and there were no fingers for a second held axis. Nothing ever goes below the
  floor, so every scanner stalk points the same way. Climbing draws on the one
  energy pool, and holding altitude keeps drawing on it. The ceiling is ~14
  units against engagement ranges of 14–78, which is what keeps it an evasive
  option rather than a 3D search problem — and what lets **the guns train in
  elevation while the hull does not**, since there is no pitch input and never
  will be. The hostiles get the slab too, at a per-class fraction, or altitude
  would be a pure escape. All of it is behind `flight.threeD` in
  `game/altitude.ts`, defaulting on; off, the game is exactly what it was.
  What is still true: the scanner is still trustworthy — now because of the
  stalk — and the facings are still four and still a ring.
- **Occluded geometry, not pure wireframe.** Glowing edges over near-void opaque
  faces. Pure wireframe is unreadable the moment two ships overlap.
- **One energy pool** feeds thrust, shields and weapons.
- **Four shield facings**, depleting separately. Turning a fresh quarter toward
  the shooter is the defensive skill.
- **Phasers vs torpedoes**: instant/energy-draining/weaker with distance, versus
  limited/slow/must-be-led.
- **No win state within a run.** Runs escalate until you die. The *campaign*
  is what can be won — that is what lets an arcade game carry an empire layer.
- **The multiplier is the currency.** Climbs on kills, halves when something
  reaches the hull, only realised as score when you dock.
- **Our own universe.** The genre is not protectable; the marks are. No LCARS,
  no delta, no familiar species or ship names. Hostile hulls use the genre's
  shared silhouette grammar, not anyone's specific designs.
- **Hyperwarp is an escape valve priced at half the multiplier** — the same
  cost as letting something reach the hull, so the game has already taught
  the price before the player ever charges a jump.
- **Refits persist through death.** Every run ends in death by design, so
  losing refits on death would mean losing them always, which makes them a
  tax on a guaranteed event rather than a loadout choice.
- **The chart does not pause the game.** Pulling it up while something is
  shooting at you is where the hyperwarp escape valve costs something, and it
  keeps the chart an instrument the ship draws rather than a screen the game
  switches to.
- **Synthesised audio, no samples.** Every sound is oscillators and filtered
  noise built at runtime. A sample would be the only asset in a project that is
  otherwise entirely procedural geometry and stroke fonts.
- **One currency: salvage.** Never a second one. Two currencies is a
  spreadsheet.
- **Four decisions per chart visit, on one screen, with no submenus.** Into
  the Breach, not Stellaris. If a chart visit takes longer than a run, the
  layer has failed and gets cut back rather than reorganised.
- **Attract mode never touches the player's campaign.** The demo pilot flies
  the real session, and the real session banks salvage, so the demonstration
  runs on a throwaway campaign — `campaignFor` in `chart/economy.ts` is the
  one place that decides which. The symptom of getting this wrong is silent:
  an unattended cabinet spending the player's savings.

## Architecture

```
src/render/   Stage (post chain), VectorObject (the two draw modes),
              PhosphorPass, CrtPass, TraceBuffer, palette, Backdrop (the
              per-sector sky, derived from the campaign seed, camera-pinned)
src/geometry/ hulls.ts — every ship, built from merged low-poly primitives
src/game/     Ship, altitude (the slab, its constants and its switch), session
              (rules), docking, death, hostiles, allies (the Warden), weapons,
              debris, hitStop, presentation (the title/attract/run shell)
src/chart/    campaign state, the enemy turn, the economy and the four
              decisions, persistence, and the chart renderer (both modes)
src/hud/      Hud (stroke buffer), draw.ts (layout), strokeFont.ts
src/audio/    Synth (two voices, four buses, a capped pool), sound.ts (the
              bank of cues, and the `sound` singleton everything calls)
```

Post chain order matters: `scene → bloom → phosphor → CRT → output encode`.
The output encode is not optional — without it the composer writes linear light
to an sRGB display and every dim trace is crushed to black.

## Conventions

- **+Z is forward, +Y is up, the XZ plane is the floor.** `y = 0` is where
  everything rests and nothing goes below it. Mines, the docking corridor, the
  gate and the starbase stay on it always — having to come down to bank is a
  feature.
- **Aim is a bearing.** Nothing in this game has a pitch axis, so every "am I
  pointed at it" test is `atan2(x, z)` — the hostiles always did it that way and
  the player's weapons now do too, through `bearingOffset` in `weapons.ts`.
  Elevation is the guns' problem, and a shallow slab is what makes that
  solvable. Do not add a pitch input; the controls were the reason the plane
  survived as long as it did.
- **No DOM text over the scene.** Every glyph is stroke-drawn through the same
  bloom as the ships. The HUD draws in a fixed 800-unit-tall design space.
- **Colour is information**: cyan is *ours* — the player and the Warden both —
  magenta is unresolved or tractor, and each hostile class owns a hue (Raider
  gold, Lance acid green, Bastion red-orange, Harrow violet, Shroud magenta
  because it never resolves). Never introduce a decorative colour, and note
  that the ally deliberately did not get one: an ally needs to say "not a
  target", which cyan already says, not "another class".
- **Transient strokes go through `TraceBuffer`** — beams, debris, corridor
  guides — not new objects and materials.
- **Every sound goes through the same two voices** — a pitched oscillator that
  glides and filtered noise that sweeps — for the same reason. The audio layer
  may never throw and may never start before a user gesture; see the header of
  `audio/Synth.ts`.
- **Time-based, not frame-based.** Anything that decays or accumulates must use
  `dt`. A trail that lengthens on a slow machine is a bug.
- **Hit-stop is the only thing allowed to scale game time**, through
  `Session.timeScale`. It is bounded, it never freezes, and it drains on real
  seconds. Do not add a second time scale and do not touch the frame clamp — a
  clamped `dt` already looks exactly like slow motion and has cost an hour once.
- Typecheck before committing. There is no lint step.

## State

Built: the renderer, combat (five hostile classes, waves, shield facings,
debris that is the ship's own edge segments), **a shallow third dimension —
one key, a floor at `y = 0`, a ~14-unit ceiling, hostiles that use it too, and
Elite's stalks on the scanner** — a persistent minefield you can now fly over,
the overhead scanner with sweep-painted unresolved returns, a full docking
sequence — corridor, tractor capture, staged resupply, itemised tally,
deliberate departure — hit-stop on impact, a staged death sequence, the
arcade shell of title screen, attract demo and deck log, synthesised audio
across all of it, and the whole strategy layer: campaign state and mutators, the enemy turn
(pressure budget, committed moves, interception), persistence, the in-run
tactical overlay, hyperwarp, and the command view — build, refit, deploy,
front, with the run-to-run loop closed through docking (which credits salvage)
and the epitaph (which runs the enemy's turn and saves).

Also built: **the Warden**, the one thing in the sector that is neither you nor
trying to kill you. A patrol deployed in the sector you drop into flies in it
for the whole run; anywhere else, one crosses the sector once in a long while,
says something, and leaves. It shoots, weakly and slowly, and **its kills pay
the player nothing** — no salvage, no multiplier, no entry on the tally, so
hiding behind it can never be a strategy. See `game/allies.ts`.

Not built: mouse aim, leaderboards, and per-sector docking (the starbase still
sits at one fixed world position however the chart is drawn).

## Next, in order

1. **Tuning, now including the mix.** Every audio level and envelope was chosen
   by reasoning about it rather than by hearing it, so `BUS_LEVELS`, the phaser's
   cadence and pitch pair, and the alert's `FULL_THREAT` are first-draft
   guesses in exactly the way the flight model is: `Ship.TURN_ACCEL/TURN_DAMP/
   MAX_TURN/DRAG`, `PHASER.falloffStart/End`, `WAVE_BREAK`, multiplier gain,
   `HIT_STOP`, the death sequence's `TIMING`, the attract loop's dwell times,
   the scanner sweep rate, and the `1 + yield` salvage curve. **The whole of
   `ALTITUDE` joins that list** — ceiling, climb rate, fall rate, drain — along
   with `SCANNER.altitudeScale`, `TUBE_WINDOW` and the five `slab` fractions,
   and it is the block most worth flying first: it is the newest thing here and
   `Y` makes the A/B free. Needs a human at the keyboard with the speakers on.
2. **Campaign balance.** The command view is built and the campaign is not
   yet winnable at plausible rates — `npm run campaignlength` finds a cliff
   between five steps of ground per run (0% wins) and six (93%), with no
   contested band, and capping the pressure formula turns losses into
   deadlocks rather than into wins. See `docs/status.md` §3. This wants a
   design answer, not a constant.
3. **Revise the audio against the research.** `docs/audio-prior-art.md` landed
   after the audio layer was built and disagrees with it: the alert should be a
   pulse rather than a bed, escalation should add partials rather than raise
   level (CHI 2024, n=1,699 — amplification alone hurt perceived competence),
   and the compressor's 6 ms costs impact sync in a game full of hit-stop.

## Gotchas

- `Documents/` is iCloud-synced, which has already produced a `"draw 2.ts"`
  conflict copy that broke the typecheck. If a build fails with duplicate
  symbols, look for `* 2.ts` files.
- Headless Chromium on software GL takes ~0.5s per frame for the post chain at
  1280×800, and the `dt` clamp then puts game logic into slow motion. The
  playtest harness therefore runs at 640×400 with post disabled. Not a bug.
- **Nothing makes a sound until a key has been pressed.** Browsers will not run
  an `AudioContext` before a user gesture, so `sound.start()` hangs off the same
  keypress that launches a run. A page that has only been loaded is silent by
  design, and so is one with no audio device — the first failure retires the
  whole audio layer rather than raising in the frame loop.
- `window.__probe`, `__session`, `__player`, `__fleet`, `__stage`,
  `__presentation`, `__sound` are exposed on localhost only, for headless
  inspection.
  `__probe.state` is still only `clear`/`fighting`/`dead`; the title and attract
  screens are `__probe.mode`, which is the shell around a run, not a combat
  phase. **A headless run must launch itself** — the page now lands on the
  title, so a harness has to press a key (or call
  `window.__presentation.startRun()`) before anything spawns.
- **No display setting persists**, the deck log switch included. The shape
  mode, the three post passes, the diagnostics, the mute, the slab and `L` are
  all plain in-memory fields that reset on reload; `kobayashi.campaign` is the
  only thing this game writes to storage. Adding persistence is a decision to
  make once, for all of them, not a second key beside the campaign's.
- `src/chart/` logic modules must not import `three` or touch the DOM.
  `tools/campaigntest.mjs` imports them in bare node, via a `tsc` emit to
  `.campaign-build/` driven by `tsconfig.campaign.json`. `ChartView.ts` is the
  one exception, and that config excludes it explicitly. Breaking this
  breaks the whole campaign test cycle, not just the browser build.
