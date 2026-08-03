# Kobayashi

A vector-arcade starship game: first-person combat on a plane, a greed loop
built on docking, and a strategy layer whose tactical chart is built and
whose command layer is not yet. Working title; the eventual larger game is
*Deep Black*.

Full background in `docs/` — [status.md](docs/status.md) first, then
[prior-art.md](docs/prior-art.md), [concept-options.md](docs/concept-options.md),
[strategy-layer.md](docs/strategy-layer.md).

## Run it

```
npm run dev            # http://127.0.0.1:5173
npm run typecheck      # tsc --noEmit — run before every commit
npm run standalone     # dist/kobayashi.html, one self-contained file
npm run playtest       # headless run + assertions (needs a Playwright browser)
npm run campaigntest   # chart logic assertions, bare node, no browser
npm run campaignlength # simulates thousands of campaigns, reports the length distribution
```

A fresh load lands on the title; any key that is not a display toggle launches a
run, and an idle cabinet falls through to an attract demo and back.

Controls: arrows/WASD fly, Space phasers, X torpedoes, R restart. `G` toggles
wireframe vs occluded, `B`/`F`/`V` toggle bloom/phosphor/CRT, `1`/`2`/`3` switch
cockpit/chase/orbit, `H` hides diagnostics. `Tab` raises the chart without
pausing the game; WASD moves the chart cursor while it is up (arrows still
fly); `Shift` charges a two-second hyperwarp jump that halves the multiplier
on arrival.

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

## Architecture

```
src/render/   Stage (post chain), VectorObject (the two draw modes),
              PhosphorPass, CrtPass, TraceBuffer, palette
src/geometry/ hulls.ts — every ship, built from merged low-poly primitives
src/game/     Ship, session (rules), docking, death, hostiles, weapons,
              debris, hitStop, presentation (title/attract/run shell)
src/chart/    campaign state, the enemy turn, persistence, and the chart
              renderer
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
  Bastion red-orange, Harrow violet, Shroud magenta because it never resolves).
  Never introduce a decorative colour.
- **Transient strokes go through `TraceBuffer`** — beams, debris, corridor
  guides — not new objects and materials.
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
deliberate departure — hit-stop on impact, a staged death sequence, the
arcade shell of title screen and attract demo, and the tactical chart layer:
campaign state and mutators, the enemy turn (pressure budget, committed
moves, interception), persistence (load-only — nothing calls `save()` yet,
so a reload starts a fresh campaign), the in-run tactical overlay, and
hyperwarp.

Not built: audio (nothing at all yet), mouse aim, leaderboards, the command
view and its four decisions (build, refit, deploy, front), and the
death → tally → chart handoff that would actually advance a campaign from
one run to the next.

## Next, in order

1. **Audio.** Synthesised WebAudio, no samples. The docking sequence is
   currently silent, which is why it still feels slightly thin. Biggest
   remaining win per hour.
2. **Tuning.** Flight and pacing constants are first-draft guesses:
   `Ship.TURN_ACCEL/TURN_DAMP/MAX_TURN/DRAG`, `PHASER.falloffStart/End`,
   `WAVE_BREAK`, multiplier gain, and now `HIT_STOP`, the death sequence's
   `TIMING`, and the attract loop's dwell times. Needs a human at the keyboard.
3. **The command view.** Build, refit, deploy, choose the front — the four
   decisions, on the same renderer the tactical chart already uses — plus the
   death → tally → chart handoff that wires `runEnemyTurn()` into actual play.
   Nothing calls it yet; a run does not currently lead to another run.

## Gotchas

- `Documents/` is iCloud-synced, which has already produced a `"draw 2.ts"`
  conflict copy that broke the typecheck. If a build fails with duplicate
  symbols, look for `* 2.ts` files.
- Headless Chromium on software GL takes ~0.5s per frame for the post chain at
  1280×800, and the `dt` clamp then puts game logic into slow motion. The
  playtest harness therefore runs at 640×400 with post disabled. Not a bug.
- `window.__probe`, `__session`, `__player`, `__fleet`, `__stage`,
  `__presentation` are exposed on localhost only, for headless inspection.
  `__probe.state` is still only `clear`/`fighting`/`dead`; the title and attract
  screens are `__probe.mode`, which is the shell around a run, not a combat
  phase. **A headless run must launch itself** — the page now lands on the
  title, so a harness has to press a key (or call
  `window.__presentation.startRun()`) before anything spawns.
- `src/chart/` logic modules must not import `three` or touch the DOM.
  `tools/campaigntest.mjs` imports them in bare node, via a `tsc` emit to
  `.campaign-build/` driven by `tsconfig.campaign.json`. `ChartView.ts` is the
  one exception, and that config excludes it explicitly. Breaking this
  breaks the whole campaign test cycle, not just the browser build.
