# Kobayashi

A vector-arcade starship game: first-person combat on a plane, a greed loop
built on docking, and a strategy layer designed but not yet built. Working
title; the eventual larger game is *Deep Black*.

Full background in `docs/` — [status.md](docs/status.md) first, then
[prior-art.md](docs/prior-art.md), [concept-options.md](docs/concept-options.md),
[strategy-layer.md](docs/strategy-layer.md).

## Run it

```
npm run dev          # http://127.0.0.1:5173
npm run typecheck    # tsc --noEmit — run before every commit
npm run standalone   # dist/kobayashi.html, one self-contained file
npm run playtest     # headless run + assertions (needs a Playwright browser)
```

A fresh load lands on the title; any key that is not a display toggle launches a
run, and an idle cabinet falls through to an attract demo and back.

Controls: arrows/WASD fly, Space phasers, X torpedoes, R restart. `G` toggles
wireframe vs occluded, `B`/`F`/`V` toggle bloom/phosphor/CRT, `M` mutes,
`1`/`2`/`3` switch cockpit/chase/orbit, `H` hides diagnostics.

## Decisions that are locked

Do not quietly revisit these; they are load-bearing and each closed off
alternatives deliberately.

- **The play space is a plane.** The scanner is only trustworthy if the world is
  flat. Everything else follows from this.
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
- **Synthesised audio, no samples.** Every sound is oscillators and filtered
  noise built at runtime. A sample would be the only asset in a project that is
  otherwise entirely procedural geometry and stroke fonts.

## Architecture

```
src/render/   Stage (post chain), VectorObject (the two draw modes),
              PhosphorPass, CrtPass, TraceBuffer, palette
src/geometry/ hulls.ts — every ship, built from merged low-poly primitives
src/game/     Ship, session (rules), docking, death, hostiles, weapons,
              debris, hitStop, presentation (title/attract/run shell)
src/hud/      Hud (stroke buffer), draw.ts (layout), strokeFont.ts
src/audio/    Synth (two voices, four buses, a capped pool), sound.ts (the
              bank of cues, and the `sound` singleton everything calls)
```

Post chain order matters: `scene → bloom → phosphor → CRT → output encode`.
The output encode is not optional — without it the composer writes linear light
to an sRGB display and every dim trace is crushed to black.

## Conventions

- **+Z is forward, +Y is up, play happens on the XZ plane.**
- **No DOM text over the scene.** Every glyph is stroke-drawn through the same
  bloom as the ships. The HUD draws in a fixed 800-unit-tall design space.
- **Colour is information**: cyan is the player, magenta is unresolved or
  tractor, and each hostile class owns a hue (Raider gold, Lance acid green,
  Bastion red-orange, Harrow violet, Shroud magenta because it never resolves).
  Never introduce a decorative colour.
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
debris that is the ship's own edge segments), a persistent minefield, the
overhead scanner with sweep-painted unresolved returns, a full docking
sequence — corridor, tractor capture, staged resupply, itemised tally,
deliberate departure — hit-stop on impact, a staged death sequence, the arcade
shell of title screen and attract demo, and synthesised audio across all of it.

Not built: mouse aim, leaderboards, persistence, and the entire strategy layer.

## Next, in order

1. **Tuning, now including the mix.** Every audio level and envelope was chosen
   by reasoning about it rather than by hearing it, so `BUS_LEVELS`, the phaser's
   cadence and pitch pair, and the alert drone's `FULL_THREAT` are first-draft
   guesses in exactly the way the flight model is: `Ship.TURN_ACCEL/TURN_DAMP/
   MAX_TURN/DRAG`, `PHASER.falloffStart/End`, `WAVE_BREAK`, multiplier gain,
   `HIT_STOP`, the death sequence's `TIMING`, the attract loop's dwell times.
   Needs a human at the keyboard with the speakers on.
2. **The chart** (weeks 6–8): 8×8 sectors, hyperwarp, fleets advancing on a
   clock. Turns this into Deep Black and doubles as the empire screen.
3. **The campaign** (weeks 9–12): build, refit, deploy, choose the front.

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
