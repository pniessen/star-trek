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

Controls: arrows/WASD fly, Space phasers, X torpedoes, R restart. `G` toggles
wireframe vs occluded, `B`/`F`/`V` toggle bloom/phosphor/CRT, `1`/`2`/`3` switch
cockpit/chase/orbit, `H` hides diagnostics.

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

## Architecture

```
src/render/   Stage (post chain), VectorObject (the two draw modes),
              PhosphorPass, CrtPass, TraceBuffer, palette
src/geometry/ hulls.ts — every ship, built from merged low-poly primitives
src/game/     Ship, session (rules), docking, hostiles, weapons, debris
src/hud/      Hud (stroke buffer), draw.ts (layout), strokeFont.ts
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
  Bastion red-orange). Never introduce a decorative colour.
- **Transient strokes go through `TraceBuffer`** — beams, debris, corridor
  guides — not new objects and materials.
- **Time-based, not frame-based.** Anything that decays or accumulates must use
  `dt`. A trail that lengthens on a slow machine is a bug.
- Typecheck before committing. There is no lint step.

## State

Built: the renderer, combat (three hostile classes, waves, shield facings,
debris that is the ship's own edge segments), the overhead scanner, and a full
docking sequence — corridor, tractor capture, staged resupply, itemised tally,
deliberate departure.

Not built: audio (nothing at all yet), mouse aim, leaderboards, persistence,
title/attract mode, the mine-layer and cloaker classes, and the entire strategy
layer.

## Next, in order

1. **Audio.** Synthesised WebAudio, no samples. The docking sequence is
   currently silent, which is why it still feels slightly thin. Biggest
   remaining win per hour.
2. **Tuning.** Flight and pacing constants are first-draft guesses:
   `Ship.TURN_ACCEL/TURN_DAMP/MAX_TURN/DRAG`, `PHASER.falloffStart/End`,
   `WAVE_BREAK`, multiplier gain. Needs a human at the keyboard.
3. **The chart** (weeks 6–8): 8×8 sectors, hyperwarp, fleets advancing on a
   clock. Turns this into Deep Black and doubles as the empire screen.
4. **The campaign** (weeks 9–12): build, refit, deploy, choose the front.

## Gotchas

- `Documents/` is iCloud-synced, which has already produced a `"draw 2.ts"`
  conflict copy that broke the typecheck. If a build fails with duplicate
  symbols, look for `* 2.ts` files.
- Headless Chromium on software GL takes ~0.5s per frame for the post chain at
  1280×800, and the `dt` clamp then puts game logic into slow motion. The
  playtest harness therefore runs at 640×400 with post disabled. Not a bug.
- `window.__probe`, `__session`, `__player`, `__fleet`, `__stage` are exposed on
  localhost only, for headless inspection.
