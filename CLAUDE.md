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

Controls: arrows/WASD fly, **`Q` held climbs and `E` held dives; release
either and the ship returns to the plane**, Space
phasers, X torpedoes, `C` cracks a warhead for its charge when the reserve is
under half, **`Z` tapped strips the three after facings and stacks them into the
bow**, R restart. `G`
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
- **The play space is a shallow slab centred on `y = 0`, reached with two
  keys.** This is what replaced it, and it has itself been revised once: it was
  *floored* at `y = 0` and reached with one key, on the reasoning that descent
  should not be an input because it is what happens when you stop asking.
  That failed on a specific complaint — **the floor was the one thing you could
  be pinned against**, and "under" is a tactical verb no amount of extra ceiling
  supplies. `Q` climbs, `E` dives, and **releasing either returns the ship to the
  plane for free**: that free neutral is what made one key work and it is the
  only reason a second key is worth spending, because a signed slab you must
  power back to the middle makes holding level cost constant input. Both keys at
  once cancel. The hostiles get the negative half at the same per-class fraction,
  or "under" would be a pure escape rather than a trade. Elite settles the
  scanner question — it put its plane in the middle of the tube and drew stalks
  both ways in 1984 — so the old claim that one-way stalks were "worth more than
  symmetry" was citing the wrong half of its own source. **Leaving the plane
  draws on the one energy pool in either direction, and holding off it keeps
  drawing** — the drain was never gravity, it was the price of not being where
  everything else is, so free down would be free evasion. The ceiling is ~14
  units each way against engagement ranges of 14–78, which is what keeps it an
  evasive option rather than a 3D search problem — and what lets **the guns train
  in elevation while the hull does not**, since there is no pitch input and never
  will be. All of it is behind `flight.threeD` in `game/altitude.ts`, defaulting
  on; off, the game is exactly what it was.
  What is still true: the scanner is still trustworthy — now because of the
  stalk — and the facings are still four and still a ring. **Automatic elevation
  has now been flown and reads as the ship helping**, which is the answer that
  lets a shallow slab work with no pitch input; do not revisit it.
- **Occluded geometry, not pure wireframe.** Glowing edges over near-void opaque
  faces. Pure wireframe is unreadable the moment two ships overlap.
  **Scoped, owner's ruling (`docs/environment.md` §1.5): this governs hulls,
  not celestial bodies.** The justification above is about ships overlapping
  in combat, and a planet does not overlap a planet — the hero gas giant
  (`render/GasGiant.ts`) is a filled, lit mesh with no wireframe/occluded
  toggle at all. The hero body's first three rounds were built out of strokes
  anyway, on the unexamined assumption that this was a blanket house art
  style rather than an argument about combat legibility, and never produced
  a planet; only a filled mesh did, immediately, once the medium changed.
- **One energy pool** feeds thrust, shields and weapons.
- **Four shield facings**, depleting separately. Turning a fresh quarter toward
  the shooter is the defensive skill.
- **Positioning is the free skill; the brace is the one deliberate action.**
  `Z` tapped strips the three after facings and stacks what survives a 30%
  conversion loss into the **bow**, which may then hold up to 2.5 facings' worth
  and leaks back down to one. Four things about it are the decision, and each
  closed off something:
  **It costs no energy.** The single pool already arbitrates thrust, height,
  phasers and regen, and a fifth claimant would make the brace unaffordable at
  exactly the moment it is wanted. The price is a *position* — three empty
  facings — and a price paid in vulnerability cannot be out-competed by one paid
  in energy. This replaced a held trickle *out of* the reserve, which had the
  cost pointing the wrong way.
  **It stacks into the bow, never into "the threatened facing."** The old
  behaviour hunted for the thinnest quarter so the player would not have to work
  out which one the game thought was under fire — right about the problem, wrong
  about the answer, because a game that picks for you cannot be committed to.
  The bow needs no explanation and no target marker, and it fuses bracing with
  aiming: phasers fire forward, so brace and shoot are one posture and the tactic
  is *face the thing*. That is the four-facing skill sharpened, not replaced.
  **The stack overcharges and then leaks.** A ceiling of 1 would make bracing a
  fresh ship pure loss, so the surplus above full is the entire reward; `decay`
  bleeds it off in about nine seconds, which is what keeps this a panic button
  rather than a build. A commitment you can hold indefinitely is not one.
  **It refuses rather than half-works.** Stripping everything is what makes the
  *timing* of the tap a real decision, but a bow near the ceiling would spend all
  three for a sliver — a trap, not a decision. So it declines below
  `BRACE.minimum` and says which refusal it was, the way cracking a warhead
  declines above `SCRAM.ceiling`.
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
              per-sector sky, derived from the campaign seed, camera-pinned),
              GasGiant (the hero body — a filled, lit mesh, not strokes) and
              light (the sector's one real light: `planLight`, seeded and in
              use; `shadeAt`, its per-stroke shading term, written for a
              stroke-built body and not yet called by any — stage 2 wants it
              for the comet's head and the ringed planet)
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
  **Amended, owner's ruling (`docs/environment.md` §4.1): this now governs
  strokes, beams, contacts and hulls — celestial bodies are exempt** and may
  be saturated and bright, a genuinely orange gas giant or a red sun. The old
  rule was written for a HUD vocabulary where every hue is committed; a body
  is never read as a contact, so the exemption cannot be mistaken for a
  ship's own signal, but only if three things hold, and they are
  requirements, not hopes: **the scanner is the arbiter**, because a body
  never appears on it as a contact, so anything ambiguous in the canopy is
  resolved by the tube, which is already trustworthy; **pulse and flash stay
  reserved for hostiles** — a body may be any colour but must never blink,
  throb or flare; and **small and distant should stay desaturated** — a
  frame-filling planet cannot be mistaken for a ship, a small moon at range
  can, so a body below an apparent-size threshold would need to keep the
  old, muted rule. **Not yet implemented** — no apparent-size threshold
  exists anywhere in the code, only the ruling that one should. The hero
  giant has never exposed the gap because `GIANT.range`/`radius` keep it
  frame-filling by construction (see "Also built" below), but this is a
  requirement on record without an enforcement mechanism, and the gap is
  `docs/todo.md`'s to close before a moon or the comet's head — both far
  smaller on screen — inherits it silently.
  The luminance half of the old rule had already failed once in practice
  before this ruling: applied to the comet's plume it made the plume
  invisible until the luminance was raised (`docs/todo.md` §2, `COMET_COLOR`).
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

Built: the renderer, combat (five hostile classes, waves, shield facings **and
the brace that strips three of them into the bow**,
debris that is the ship's own edge segments), **a shallow third dimension —
two keys, a rest plane at `y = 0`, ~14 units of ceiling each way, hostiles that
use both halves, and
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

Also built: **the Loom**, the first encounter here that is a clock rather than a
fight. Two spinners orbit a common centre at opposite points and lay a vertical
filament at every bearing they pass; the strands accumulate into a picket fence
closing around where you were standing, and **the wall rises as it goes** — so
altitude buys *time*, not immunity, and the lid shuts about six seconds before
the ring does. They never fire, never chase and never target. Four ways out:
kill either spinner (pays salvage and the multiplier, in the house pattern),
leave through a gap or over the top, hyperwarp (no second price), or let it
close and be squeezed until you kill one. Behind `encounters.loom` in
`game/loom.ts`, defaulting on, with **no keyboard binding** — `window.__loom.seed()`
on localhost summons one. See `game/loom.ts`.

Also built: **HQ dispatches**, in `game/dispatch.ts`. The war has always been
happening while you fly — the enemy commits attacks between runs, they land on
named sectors, and reaching one and clearing it stops it — and none of it was
ever *said* to you: it lived on the chart, behind `Tab`, as a number called
`inbound`. Every line is a true statement about the board, read off the same
campaign the chart reads, and **they are opportunities, never orders**: HQ never
says go, and nothing anywhere checks compliance, because `intercept` is explicit
that ignoring these costs territory and never costs you the run.
**They arrive mid-wave, on their own clock and their own HUD row.** The first
version spoke only at wave breaks, to protect the message line that `HULL BREACH`
lives on — which threw the feature away, because a signal that only lands in the
quiet gap is scenery. The collision was solved instead of avoided: HQ has a row
of its own below the message line, smaller and dimmer, so both can be up at once.
The clock counts *combat* seconds, so docking does not bank a backlog.

Also built: **the Warden**, the one thing in the sector that is neither you nor
trying to kill you. A patrol deployed in the sector you drop into flies in it
for the whole run; anywhere else, one crosses the sector once in a long while,
says something, and leaves. It shoots, weakly and slowly, and **its kills pay
the player nothing** — no salvage, no multiplier, no entry on the tally, so
hiding behind it can never be a strategy. See `game/allies.ts`.

Also built: **the comet**, from *Balance of Terror* — an ionised tail that makes
the one rule "inside the tail, no instrument works" real as a place rather than
a sentence. A Shroud caught in it loses its cloak and cannot re-veil; nothing
can lock across the boundary, so a hostile safely outside still cannot resolve
a player standing inside, and the reverse; the scanner degrades every contact
to the unresolved return it already draws. A **fixture** is seeded per sector
the way the ringed planet is, roughly one sector in four, and drifts slowly
enough to plan around for a whole run; a **wanderer** is a rare, short-lived
crossing rolled at a wave break, the way a Loom is. The reserve pays for
standing in it — not only the small `COMET.drain`, but the tail's own
suppression of the reserve's passive regen, which is what makes the cost real
at every refit tier rather than only the baseline one. Behind
`encounters.comet` in `game/comet.ts`, defaulting on, with **no keyboard
binding** — the same reasoning `game/loom.ts` already gives: the control
surface is full, and a binding spent on something a run meets at most once is
a binding spent on nothing. See `game/comet.ts` and `docs/comet.md`.

Also built: **the hero gas giant**, answering `docs/environment.md`'s
complaint that "the planets, comets, and other non-ship related items just
look like wallpaper." One body per sector, real world-space geometry rather
than a `Backdrop` painting: a filled, lit `body` mesh shaded per-fragment by
domain-warped flow noise sheared by latitude — texture that happens to be
banded, not bands with texture painted on — plus a fresnel `limb` mesh for
bloom-as-atmosphere. **Neither is lit by a scene `DirectionalLight`**: `body`
reads `uLightColor`/`vLightDirView` uniforms set straight from
`render/light.ts`'s `planLight` (a hand-rolled Lambertian, because a
hand-written `ShaderMaterial` is never fed scene lights automatically), and
`limb` takes no light input at all — it is a view-space fresnel, dim to
bright at grazing angle regardless of where the star is. A real
`DirectionalLight` is still added to the scene, positioned from the same
seed, for a second lit body to pick up later; it currently lights nothing
`main.ts` draws. Scale and leash (`GIANT.range`/`radius`/`minRange`) let it
dominate roughly a third of the frame with real parallax on approach. **Took
four rebuilds to get here** — see `docs/environment.md` §1.5 and §8.1: the
first three rounds built it out of strokes and never produced a planet; only
a filled mesh did, immediately. Behind no flag and no key — one giant is
always seeded per sector, fixed at bearing 0 so it could be looked at
without hunting for it. See `render/GasGiant.ts` and `render/light.ts`.

Also built: **the finite invasion**, the answer to `campaign-balance.md`'s
finding that a war with one input — `gainGround` — can only be passed or
failed, never contested. The enemy now spends from a **reserve** rather than
an allowance (`RESERVE` in `chart/reserve.ts`, unconditional — the candidate
switch that measured it against the shipped rules is gone): flat resupply
from beyond the chart every turn (`regenFlat = 24`), never more than half
committed in a single turn (`commit = 0.5`), and every step of ground a run
retakes costs the invasion strength it has to make back (`costPerStep = 3`).
**Three consecutive turns at nothing left is exhaustion**, and exhaustion is
a second win condition (`brokenFor = 3`, read by `campaign.ts`'s `isWon`)
independent of whether the last sector has changed colour —
`strategy-layer.md`'s "the invasion is broken" is now a rule rather than a
phrase. `sectorsHeldBeyondStart`'s zero floor, briefly deleted on the same
recommendation that adopted the reserve, was restored by the owner's ruling
after the deletion was measured to collapse the enemy's whole spend to zero
within two to four runs of any player lead — see
`docs/campaign-balance.md`'s 2026-08-14 addendum for the full retune
(`regenFlat = 24` lands reach 4 at 83.4% won, median 26 runs inside a
40-run ceiling, the recorded compromise between a clean contested band and a
war that actually resolves). Patrols are uncapped, which is the salvage sink
this needed: the command view's four decisions now have somewhere to spend
beyond three hundred a run.

Also built: **the commander**, a face for the war, derived from the campaign
seed the same arithmetic-not-storage way every sector and station name are
(`chart/commander.ts`): given name, surname, pronoun, and a **doctrine** —
raider, hammer, or anvil — that reweights the enemy's own turn
(`DOCTRINE_WEIGHTS` in `chart/enemyTurn.ts`, a per-action multiplier on the
cost-sorted target list) and names which hostile class stands guard over it
(`guardClass`). `warAct` reads the war's current band live off the board —
surge, contested, or failing — rather than storing it, so nothing can
disagree with the campaign it describes. The war now has a voice: the deck
log gains a commander stanza and a reserve line, HQ dispatches
(`game/dispatch.ts`) are named to the commander and fall back to an
act-aware topic (failing/losing/winning) when nothing is inbound, and the
command view draws a reserve bar. Victory and defeat both end in a final
deck log.

Also built: **the combat feel pass** — near-miss streaks (a hostile shot
that sweeps past the hull leaves a trace and, once per `NEAR_MISS.cooldown`,
a doppler cue through `sound.nearMiss`), world-space shield arcs
(`game/shieldFx.ts`: a decaying flash on the facing struck and a steady aura
on the bow while the brace's overcharge holds, both drawn around the ship
rather than only on the HUD dial), class-scaled kill rings
(`HIT_STOP.heavyKill = 0.135`, a longer beat on a Brawler or Miner kill),
stern-flanking swarmers (`sternSign`, gated on `Fleet.brawlerEngaged` so the
bias only applies while a Brawler is holding the player in its own fire
range), and **withdrawal** — a hull that crosses `WITHDRAW.threshold` (a
fifth of its own hull) on the way down rolls, per class, to turn tail rather
than fight to the kill, and pays nothing once clear of `WITHDRAW.exitRange`,
the same precedent the Warden's kills already set. The commander's own guard
now spawns in the failing act (`GUARD` in `game/session.ts`): a
stat-and-name veteran of the commander's doctrine, boosted on the one axis
that doctrine already means for the enemy turn — a raider's guard is faster
(`GUARD.speed`), a hammer's tougher (`GUARD.hull`), and an anvil's fires
faster rather than harder (`GUARD.cadence` divides `fireInterval`, because
`HostileSpec.damageScale` is dead code game-wide — nothing in the weapons
pipeline reads it — and wiring a dead field live for one class would be a
game-wide balance change dressed up as a small one).

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
   `Y` makes the A/B free. **The whole of `LOOM` joins it too** — `rise` above
   all, which is the one number deciding whether the encounter is interesting or
   trivial, then `angularRate`, `radius`, `chance` and `minRadius`. **And `BRACE`,
   which is now the newest thing here** — `ceiling` and `decay` are the two that
   decide whether the brace is a tactic, and the question behind them is whether
   having to keep the shooter on your nose reads as a decision or a straitjacket.
   **The combat-feel pass joins the list now too** — `DOCTRINE_WEIGHTS`,
   `GUARD`, `WITHDRAW`, `NEAR_MISS` and the shield arc's `RADIUS` are
   first-draft guesses in exactly the same way; `docs/todo.md` §2 has the
   per-constant question for each. Needs a human at the keyboard with the
   speakers on.
2. **Revise the audio against the research.** `docs/audio-prior-art.md` landed
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
  `__presentation`, `__sound`, `__loom`, `__sky`, `__comet`, `__giant`,
  `__light` are exposed on localhost only, for headless inspection.
  **`__loom.seed()` opens a Loom on demand** — it appears at a wave break
  with a one-in-ten chance from escalation index four, so waiting for one is
  not a way to tune one. **`__comet.seed()` drops a wanderer on the player**
  for the same reason — `interferenceAt`, `plan(seed, sector)` and
  `constants` (`COMET`) stay reachable too, the pure half unwired from any
  run at all. **`__sky.next()` walks the backdrop from sector to sector**
  without playing a war, which is the only practical way to review what the
  generator makes. **`__giant` is the hero body's own instance**, unwrapped
  rather than boxed, so `.object`/`.body`/`.limb` are readable straight off
  it for a live position or material check. **`__light` exposes
  `planLight`/`shadeAt` directly** — `planLight` is what every body's
  shading reads its light from (the giant takes the `SectorLight` it
  returns straight into its own uniforms; `shadeAt` is not yet called by
  any body in a run) — so a sector's real light position and colour can be
  read without guessing them from a screenshot. None of the five has a key, for the same
  reason: the control surface is full, and a binding spent on something that
  appears once in fourteen waves — or that you only look at — is a binding
  spent on nothing.
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
