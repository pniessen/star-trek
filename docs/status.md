# Kobayashi — status and roadmap

Written August 2026, after three working sessions. Covers what exists, why each
decision was made the way it was, what is deliberately not built, and what comes
next.

---

## 1. Where this came from

The brief was a Star Trek–style game with first-person battle, a navigation and
strategy layer, and a futuristic vectorized feel. The first session surveyed
fifty-five years of prior art — see [prior-art.md](./prior-art.md) — and found
that the genre has been solved in pieces, repeatedly, by people working under
severe constraints, and the pieces have never been assembled with modern
rendering:

- **Star Trek (1971, BASIC)** contributed the strategy skeleton — an 8×8 grid, a
  stardate deadline, energy as scarce currency, phasers that weaken with range.
- **Star Raiders (1979)** is the closest ancestor: first-person cockpit combat
  welded to a live galactic chart, with enemy fleets advancing while you fight.
  No modern version of it exists.
- **Sega's Strategic Operations Simulator (1982)** contributed the split display:
  a forward view for shooting and an overhead scanner for knowing where you are.
- **Battlezone, Tempest, Star Wars (1980–83)** and Tempest 4000 (2018) set the
  visual bar and established that the look is a post-processing recipe, not a
  modelling one.
- **Starfleet Command and Bridge Commander (1999–2002)** contributed the combat
  verbs: energy allocation and per-facing shields.
- **FTL, Duskers, NEBULOUS** contributed diegetic instruments — everything the
  player reads is something the ship is drawing.

Four concepts came out of that ([concept-options.md](./concept-options.md)).
The chosen path was **B → A**: build *Kobayashi*, the pure vector arcade run,
then grow it into *Deep Black*, the strategic layer, because B is A's cockpit
with the chart removed and shares a renderer, a flight model and a combat model.

---

## 2. Decisions that are locked

These are settled and everything else is built on them. Recorded here because
the reasoning matters more than the conclusions.

| Decision | Why |
|---|---|
| **The play space is a plane** | The overhead scanner is only trustworthy if the world is flat. In 3D the map has to lie about altitude and the player learns to distrust it. Planar means every contact is exactly where the scanner says, and the skill becomes rotational. |
| **Occluded geometry, not pure wireframe** | Pure wireframe is authentic and unreadable the moment two ships overlap — you cannot tell which is in front. Same glowing strokes over near-void opaque faces gives unambiguous depth and loses nothing of the look. |
| **One energy pool** | Thrust, shields and weapons all draw from one reserve. Every burn is a shot you cannot take later; that tension is the combat design. |
| **Four separate shield facings** | Turning a fresh quarter toward whatever is shooting is the defensive skill. Without it this is *Asteroids* with glow. |
| **Phasers vs torpedoes** | Instant, energy-draining, weaker with distance versus limited, slow, must-be-led. Opposite characters make "which do I use" a question rather than a preference. |
| **No win state within a run** | The Kobayashi Maru is the unwinnable test. Runs escalate until you die; the *campaign* is what can be won. This is what lets an arcade game carry an empire layer. |
| **The multiplier is the currency** | It climbs while you stay undocked and untouched, halves when something reaches the hull, and is only realised as score when you dock. The arcade question and the strategic question are then the same question. |
| **Vector, with a hybrid** | Not a literal 1982 XY monitor. Glowing stroked edges, opaque black faces, depth-faded lines — nostalgic in recipe, current in execution. |
| **Web, no engine** | TypeScript, Vite, Three.js, WebGL2. Instant playability, shareable by link, and this look is cheap in WebGL because it is lines and post-processing rather than models and lightmaps. |
| **Our own universe** | The genre is not protectable; the marks are. No LCARS, no delta, no familiar species. |

---

## 3. What is built

~3,200 lines of TypeScript across three commits.

### Rendering

The look is entirely in the pass order:

```
scene → bloom → phosphor persistence → CRT glass → output encode → screen
```

- **`VectorObject`** builds one solid and draws it two ways — pure wireframe, or
  identical edges over near-void opaque faces. `G` toggles live, so the
  comparison is honest rather than two builds.
- **`PhosphorPass`** is a feedback buffer with per-channel decay, so the
  blue-green trace outlives the red. Decay is per *second*, not per frame.
- **`CrtPass`** is barrel distortion, scanlines, vignette and corner
  convergence error — deliberately under-driven and fully toggleable, because
  this is the effect most likely to tip the look into "emulator screenshot".
- **`TraceBuffer`** is one preallocated world-space stroke buffer that beams,
  torpedo streaks and explosion debris all share.
- Hulls are low-segment primitives merged into solids, so crease edges read as
  facets. The player's cruiser is about 40 strokes.
- **The HUD contains no DOM text.** Every glyph is drawn from a hand-authored
  stroke font through the same bloom as the ships, in a fixed design space that
  scales to the window.

### Combat

- Five hostiles, each punishing one habit and each with its own silhouette and
  hue: **Raider** (gold, a stooping raptor) punishes tunnel vision, **Lance**
  (acid green, a horseshoe open at the bow) punishes standing still, **Bastion**
  (red-orange, a command bulb between swept engine wings) punishes a neglected
  shield facing. They hold a preferred range, strafe rather than driving straight
  in, lead their shots, and cannot fire when out-turned. The archetypes are the
  genre's shared visual grammar; the hulls are our own geometry.
- The last two do not duel at all, which is the point of them. **Harrow**
  (violet, a flat-decked tender with the ordnance visibly on its rails) never
  fires: it leads mines onto the course you are already flying, and they persist
  across waves until they burn out, so the sector you have been circling becomes
  the sector you can no longer circle. Mines are shootable, chain-detonate, and
  cost you the shots you would rather have spent on something shooting back.
  **Shroud** (magenta, a blade) is invisible and unhittable until it commits;
  it materialises over 0.45s, empties a burst, and fades. Killing one means
  being pointed at it before it arrives, which is a scanner problem.
- Hits route to the quarter facing the shooter; only the remainder reaches the
  hull.
- **Ships explode into the line segments that drew them** — the hull's own edge
  list, pushed outward and tumbled. No particles, no sprites.
- Waves escalate and ring the player rather than clustering ahead.
- **Docking is a sequence**, not a proximity check: a marked corridor with rails
  and travelling chevrons, a gate you fly through, a tractor that takes the helm
  and pulls you in, systems restored one at a time, an itemised tally with the
  score odometer rolling, and a deliberate departure under thrust. An approach
  instrument shows lateral offset and speed so lining up is something you do.
  Waves keep coming while you are moored — you can turn and shoot, but not move.

### Feel

- **Hit-stop** on torpedo impact, on kills, on a hull breach and on death. It is
  an explicitly bounded multiplier on game seconds, never a freeze, refreshed
  rather than accumulated, and drained on wall-clock seconds so dilation can
  never slow its own recovery — see the last entry in §4 for why that was worth
  spelling out in a class comment rather than a constant.
- **Dying is a sequence too.** The hull comes apart into its own edge segments,
  through the same debris field every hostile goes through; a shock ring runs
  out across the plane; hit-stop holds the moment; the camera lets go of the
  ship, holds low and close, then rises and pulls back into a tilted orbit of
  the wreck; the instruments brown out as one failing supply rather than
  blinking off; and the run is added up on emergency power, with what it was
  worth one dock short of home as the number that lands hardest.

### The arcade shell

A title screen, a demonstration, and the game. The title is one of the ship's
own instruments — brackets, a rule, dim labels against bright values, the same
stroke font as every other readout, over a slow orbit of the cruiser. Attract
mode is not a canned animation: it is the real session with a demo pilot on the
stick, so everything the demo shows is something the game genuinely does,
including flying the docking corridor home once the pot is worth banking. Any
key that is not a display toggle takes the controls, and an abandoned death
tally falls back to attracting the way a cabinet does.

This is a shell *around* the session rather than a state inside it:
`Session.state` is still only `clear`/`fighting`/`dead`, because a title screen
is not a phase of combat and pretending it was would put a fourth case into
every rule that reads the run. The shell is `__probe.mode`.

### Sound

Synthesised, never sampled — a sample would be the only asset in a project that
is otherwise procedural geometry and stroke fonts, and the look and the sound
should come off the same bench. So the whole bank is built from two voices: a
pitched oscillator that can glide, and filtered noise whose filter can sweep.
A phaser, the clamps engaging, a mine going off and the Shroud materialising are
all those two with different envelopes. It is the `TraceBuffer` argument in the
other medium.

Three things follow from that and are worth stating separately:

- **Timbre is information, the way colour is.** Yours are clean and centred —
  triangle and sine — because you are always at the middle of the tube. Theirs
  are sawtooth and square, and they are *placed*: distance attenuates and bearing
  pans, off one listener updated once a frame. A bolt fired from your port
  quarter arrives on your left. That is the scanner's job done by ear.
- **The Shroud's decloak is the most important sound in the game.** The class is
  only fair because it materialises over 0.45s before it fires, and that tell
  used to be a flare somewhere off screen — useless if you were not already
  looking at it. Now it is a rising, detuned, panned warning with a floor under
  its attenuation, and the crack lands three hundredths of a second before the
  first bolt. Rising, because everything else that matters falls; detuned,
  because that is the timbre reserved for what will not resolve, exactly as
  magenta is the colour of it.
- **The tally pitches with the multiplier.** Root, arpeggio length and a sub note
  all climb together, so banking 9x is audibly a bigger event than banking 1x.
  The greed loop's payoff had a rolling odometer and no sound; now the number
  going up has a shape.

The mix is four buses and a compressor, and the voice pool is capped at eighteen
with oldest-first stealing — a wave-eight fight with a mine chain going off will
ask for more than that, and the eleventh explosion in a second is not information
anyone is listening for. Everything is scheduled against the audio clock rather
than the frame clock, so a stuttering frame under software GL cannot stretch an
arpeggio.

Two constraints are load-bearing rather than defensive. The audio layer may
never throw: the headless harness runs in a Chromium with no audio device, and
an exception inside the frame loop kills `requestAnimationFrame` and freezes the
game on its last frame, so the first failure retires the machine permanently and
silently. And nothing may start before a user gesture, because browsers will not
run an `AudioContext` until the page has been touched — the keypress that
launches a run off the title is the gesture, which is why the title screen is
silent on a fresh load and correct to be.

### The scanner

Heading-up, contacts glyphed by class, off-range contacts pinned to the rim.
This is the reason the play space is planar, so it is not optional dressing —
it is half the interface, exactly as it was on the 1982 cabinet.

It is now an instrument rather than a readout, in two tiers. Anything with a
hull you could shoot is still drawn at its true position — a planar world is
supposed to make this tube trustworthy and a scanner that misplaces a Bastion
breaks that for nothing. What degrades is *confidence*: a contact dims between
sweeps and flares as the arm repaints it. A cloaked hull gets the other tier —
it exists only when the arm crosses it, is placed with a real positional error,
and decays away over three seconds. The error is drawn as the circle it actually
is and the offset is always smaller than the circle, so the true contact is
genuinely somewhere inside the mark. Three returns in a row with each ring
tighter than the last is a Shroud closing, and reading that before it
materialises is the whole skill of the class. No false returns: ambiguity from
staleness and error teaches you something, a phantom would only teach you to
distrust the one instrument the game has promised is honest.

### The chart

The tactical half of the strategy layer designed in §5 and detailed in
[the chart design doc](superpowers/specs/2026-08-02-chart-design.md) is now
built. `src/chart/` holds it, deliberately free of `three` and the DOM:
`rng.ts` (a seeded PRNG carrying its own cursor, so a save is reproducible),
`sectors.ts` (the 8×8 grid and orthogonal adjacency), `campaign.ts` (state
and its mutators — nothing else is allowed to write to a campaign),
`enemyTurn.ts` (the pressure budget, spent as committed moves that resolve a
run later and can be intercepted), and `persistence.ts` (a versioned
`localStorage` blob that never throws — a corrupt or absent save starts a
fresh campaign). `ChartView.ts` is the one module in the directory allowed to
touch a renderer, and it is excluded from the bare-node build accordingly
(see the gotcha in `CLAUDE.md`).

In-run, `Tab` raises the chart at reduced opacity without pausing the game,
WASD moves the cursor while it is up, and `Shift` charges a two-second
hyperwarp — you can still turn, you cannot fire, energy drains whether or not
you release early, and arrival halves the multiplier and costs you your
energy. `src/game/hyperwarp.ts` is the state machine. A committed fleet push
can be intercepted mid-run: reach the threatened sector, clear the wave that
greets you there, and the attack never lands.

Between runs, `src/chart/economy.ts` and `src/chart/command.ts` hold the
command view's rules, and `ChartView.ts` draws the same grid a second time,
zoomed to fill. Twelve rows, four headings, no submenus: four structures
priced from `strategy-layer.md`, the six refits, one patrol row, and the
front. Arrows move the sector cursor, `W`/`S` move down the list, `Space`
commits, `Enter` launches. Every row explains its own refusal rather than
greying out silently.

**The loop is closed.** Docking credits `campaign.salvage` — the one place
the arcade layer pays the strategy layer. Reaching the epitaph resolves the
run exactly once: construction ticks, `runEnemyTurn()` spends the enemy's
pressure, patrols take attrition, and the campaign is saved with its RNG
cursor so a reload resumes the same war rather than re-rolling it. Launching
drops you at `campaign.front` with whatever refits are fitted.

**The dock ring is still aspirational.** `ChartView` draws a ring on any
sector `canDock` returns true for, but the starbase sits at one fixed world
position regardless of `campaign.current`, so the running game still lets you
dock from anywhere. Per-sector docking remains out of scope; this is a note,
not a fix.

**One mechanic was added that neither design document specifies.** Nothing in
the game could move a sector back toward the player, so `isWon` — zero enemy
sectors — was unreachable from play: build, refit, deploy and front spend,
equip, position and commit, and not one of them takes ground. `gainGround` in
`economy.ts` is the fix, and it is deliberately the mirror image of
`resolveIncoming`: clearing a wave in the sector you are standing in moves it
one step your way, theirs → contested → yours, the same ladder the enemy
climbs at the same price. Flag it for review; the war being winnable is a
promise both documents make and this is the only thing keeping it.

Two of `strategy-layer.md`'s constants were retuned rather than reused: the
enemy opens holding the far three rows of eight rather than half the board,
and the pressure formula is `6 + floor(runsElapsed / 2) + sectorsLost`
against the original `3 + floor(runsElapsed / 4) + sectorsLost × 0.5`. The
patrol's own cost, strength and capacity (200 salvage, strength 3, one in the
field plus one per yard) are invented — `strategy-layer.md` prices everything
else and leaves those open.

**One deviation from the design doc, found while implementing salvage.**
Salvage earned in a sector is scaled by `1 + yield`, not by `yield` as
written: yield runs 0–3 and the home sector — where every fresh campaign
starts — is yield 0, and a bare multiply would zero every kill's salvage
there. The consequence is that a yield-3 sector now pays 4× rather than the
documented 3×. Flag this for the tuning pass; it is a balance decision, not
a bug, but it was made mid-implementation rather than in the design doc and
deserves a second look with a human at the keyboard.

**`tools/campaigntest.mjs`** is 109 assertions in bare node, no browser. The
first 54 cover the tactical half — pressure spend, adjacency, a neglected
sector falling within four runs, interception, round-trip serialisation, a
truncated save falling back to a fresh campaign, and that retaking ground
lowers the pressure budget rather than only ever accumulating. The 55 added
with the command view cover construction completing over runs and not before,
a structure destroyed mid-build refunding nothing (driven through a real
enemy assault), every refit costing the ship something, refits surviving the
runs in between, patrols wearing out on the front in three runs and not at
all behind the line, a yard rebuilding them, salvage holding its floor across
400 starved decisions, a reloaded campaign resuming the same war, and the
attract demo's firewall.

### Campaign length, re-measured with an economy

`tools/campaignlength.mjs` now runs a model player with the tools the command
view gives a real one: it banks salvage, takes ground, fields and reinforces
patrols, builds outposts, starbases and yards, and picks its front, all
through the same functions the game calls. Two knobs describe it — `--take`,
salvage banked per run, and `--reach`, steps of ground a run moves, where one
step is one wave cleared where you stand.

```
trials      2000
model       take=1200/run  reach=3 steps/run  refits=not modelled
won         0  (0.0%)
lost        1721  (86.1%)
unresolved  279  (14.0%)
runs        p10=25  median=26  p90=200
economy     4.1 structures standing, 2.1 of 64 sectors held at the end
```

**Still 0% wins — but the reason has changed, and that is the finding.** The
economy is not what decides these campaigns. Running the same model with
`--take=0` (no salvage, no structures, no patrols, ever) barely moves it:
100% lost, median 24 instead of 26. Running it at `--take=6000` does not
produce a single win either. Patrols and starbases raise the enemy's cost by
+2 and +3 in *one sector each*, while the pressure budget grows by +1 every
two runs across the whole board — defence scales O(1) against pressure that
scales O(runs), so salvage buys a delay and never a reversal.

What decides them is `--reach`, and it decides them absolutely:

| reach | won | lost | unresolved | median |
|---:|---:|---:|---:|---:|
| 1 | 0% | 100% | 0% | 19 |
| 2 | 0% | 83.3% | 16.8% | 21 |
| 3 | 0% | 86.1% | 14.0% | 26 |
| 4 | 0% | 94.4% | 5.6% | 31 |
| 5 | 0% | 95.4% | 4.6% | 36 |
| 6 | **93.3%** | 0% | 6.7% | 15 |
| 10 | 100% | 0% | 0% | 5 |

There is no contested band. Below six steps a run the player always loses;
at six they win 93% of the time in a median of fifteen runs. The campaign is
two fixed linear rates racing, with nothing that makes the enemy slow down as
it loses or the player speed up as they win, so the ratio decides the whole
war on the first run and the remaining twenty are a formality.

**And capping the pressure formula is not the fix.** Measured directly, by
patching `pressureBudget` to `min(cap, …)` in the bare-node build and
re-running: at cap 12 and reach 2, losses fall from 83% to 17% — and the
other 83% become deadlocks that never resolve inside 200 runs. At cap 10 and
reach 3, 100% unresolved. Capping removes the defeat without producing a
victory, which answers §7's open question in the negative: the campaign does
not need a smaller number, it needs a feedback term it currently has none of.
That is a design decision for a human, not a constant to nudge, and no
constant was changed on the strength of this measurement.

`tools/playtest.mjs` is unchanged at 34 assertions. The lifecycle it drives
did change — see §7's note on the command view — so it wants re-running
before this is merged.

### Verification

`tools/playtest.mjs` drives a whole run headlessly and has grown, feature by
feature, to thirty-four assertions: waves spawn and escalate, phasers draw
energy and torpedoes deplete, kills bank salvage and climb the multiplier,
docking banks and resupplies and resets, hit-stop dilates time and always lets
go, death breaks the player up and reaches the tally, restart is clean, the
minelayer and cloaker classes behave as designed, and — the in-run half of
the chart, covered in §3 above — hyperwarp charges, locks weapons, and costs
what it should, the overlay itself raises and steps the cursor without
walking it off the grid, WASD hands off between the ship and the cursor
correctly, and a committed fleet move can be intercepted.

**The harness now has to launch its own run.** A fresh load lands on the title
screen and nothing spawns behind it, so the first assertion needs a keypress —
`await page.keyboard.press("Enter")` after `goto`, or
`window.__presentation.startRun()` — before waiting on wave one. Without it the
page sits on the title for thirteen seconds and then starts a demonstration
that fights the harness for the keyboard.

---

## 4. Bugs found, and what they teach

Worth recording because each one was invisible until something forced it into
the open.

**No output colour-space encode.** The composer was writing linear light
straight to an sRGB display. Bright bloomed strokes looked fine because they
clip white anyway, but everything dim was crushed to black — the starfield and
grid appeared to be missing entirely. The HUD looked correct throughout because
it renders direct to the canvas and *was* encoded, which is what gave it away.
This would have quietly poisoned every colour judgement made afterwards.

**Phosphor decay was per-frame, not per-second.** The trail lengthened on slower
machines. The feedback buffer also held unclamped HDR values, so a bright stroke
sat above the clipping point for ~40 frames and then vanished all at once — it
read as burn-in, not as a trail.

**Tapped keys were dropped.** A key pressed and released between two frames was
never observed as held. At 60fps that is a 16ms window a fast player will find,
and the shot simply never happened. Presses are now latched and consumed by the
next frame.

**The HUD was laid out in raw pixels**, so instruments collided at small window
sizes. It now draws in a fixed design space.

**A sustained turn held ~50° of roll**, tipping the horizon over. Bank is now a
transient lean.

**The wave clock stopped while docked.** Any dock state short-circuited wave
spawning, so the station was somewhere to hide and lingering cost nothing —
exactly backwards for a loop about whether to bank or push on. Combat phase and
dock phase are now tracked separately, because they are genuinely independent.

**Departure shoved you back into the clamps.** Thrust is how you ask to leave,
and thrust points at the station. There is now a short window after release
where forward thrust is ignored.

**One non-bug worth knowing about:** roughly an hour went into what looked like
a 100× performance regression. It is an artifact of headless SwiftShader, which
needs about half a second per frame for ~15 full-screen post passes at
1280×800; the loop's `dt` clamp then puts game logic into slow motion, which is
why waves appeared not to spawn at all. Confirmed by A/B against the previous
commit. Real GPUs run the same chain in under 2ms, but it will bite anyone who
puts this in CI.

---

## 5. The strategy layer — tactical half built, command half designed

[strategy-layer.md](./strategy-layer.md) has the original design; the
tactical chart it describes is now built — see §3's "The chart" — against the
retuned constants and resolved open questions in
[the chart design doc](superpowers/specs/2026-08-02-chart-design.md). What
remains designed but not built is the **command view**: an 8×8 chart between
runs where salvage buys structures (with build times measured in runs, not
rushable with money), refits that are all genuine tradeoffs, and patrols that
buy turns rather than safety. The enemy spends pressure points after every
run, so ignore a sector for four runs and it falls — and stays fallen; that
part of the enemy turn is built and tested, only nothing in the running game
calls it yet.

The rule that keeps it an arcade game: **Into the Breach, not Stellaris.** Four
decisions per chart visit, no submenus, one currency. If the chart visit ever
takes longer than the run, the layer has failed and we cut it back.

---

## 6. What is deliberately not built

- **Mouse aim.** Aiming is currently the nose, which is the Sega model and
  correct for a planar game. Mouse aim is worth testing but may make it too easy.
- **Leaderboards, and run-level persistence.** `localStorage` and a seeded RNG
  now exist for the campaign (§3, "The chart") but nothing analogous covers a
  run or a high-score table; no backend, no accounts. The title screen shows
  a best-of-this-sitting and says so, rather than implying a record it does
  not keep.
- **Saving the campaign.** The persistence module can round-trip a campaign
  through `localStorage`, but nothing calls `save()` — the game loads
  whatever campaign exists at boot and then never writes to it, so a reload
  starts fresh regardless of what was won or lost.
- **The command view and the four decisions.** Build, refit, deploy, choose
  the front — designed in `strategy-layer.md`, not yet built.
- **Mobile and touch.**

---

## 7. Roadmap

**Now — tuning, and the mix is part of it.** The flight model and wave pacing
are first-draft numbers and want a human on the keyboard: turn rate and drag,
phaser falloff curve, how fast the multiplier climbs, whether the wave break is
too long. Audio joins that list rather than sitting above it, because every
level and envelope in it was arrived at by reasoning rather than by listening.
The three to sit down with first are the phaser at a held 6.25 shots a second,
which is the only sound in the game with a real chance of becoming fatiguing;
the alert drone's threat scaling, which is either tension or a nuisance and
there is no way to tell from the source; and the decloak, which has to cut
through a firefight without being the loudest thing in the game. This is the one
item on the list that cannot be done by reasoning about it.

**Next — game feel.** Hit-stop, the death sequence, the attract mode and the
sound are all built, and every one of their constants is a first-draft guess.
Feel is most of what an arcade game is, and it is cheap to iterate now that both
the renderer and the sound bank exist.

**Weeks 6–8 — the chart, in-run. Built.** An 8×8 sector map, hyperwarp between
sectors, fleets that advance on a clock while you fight — see §3, "The
chart". This is the step that turns Kobayashi into Deep Black, and the same
renderer is now the empire screen's, not just a promise that it would be.

**Weeks 9–12 — the command view. Built.** Build, refit, deploy, choose the
front, on one screen with no submenus, plus the death → tally → chart
handoff that advances `runsElapsed`, runs `runEnemyTurn()`, ticks
construction, wears patrols down and saves the campaign with its RNG cursor.
A run now leads to another run. Two things this pass added that the design
documents do not specify and that want a second look: `gainGround` (§3),
without which the war cannot be won at all, and the patrol's own price and
strength.

**The lifecycle changed, and `playtest.mjs` has not been re-run against it.**
`PresentationMode` gained a fourth value, `"command"`; the epitaph now leads
to it after ~3 seconds or on any key that is not `R`; `R` still restarts
immediately, which is the path the harness takes. `Session` gained
`bindCampaign`, and the probe gained `salvage`, `runsElapsed`, `front`,
`refits`, `structures`, `patrols`, `ours` and `commandSelection`. Nothing
existing was removed or renamed, but the harness should be run before this
merges.

**Later.** Territorial control *during* a run, if the between-runs version earns
it. The exploration encounters from concept D, seeded into empty sectors.

### Resolved

Three open questions from this section and from `strategy-layer.md`'s own
"Open questions" are now resolved, in
[the chart design doc](superpowers/specs/2026-08-02-chart-design.md):

- **Does the campaign need to be shorter?** The 8×8 grid is kept — shrinking
  the board was rejected in favour of retuning pressure. The enemy now opens
  holding the far three rows of eight rather than half the board, and the
  pressure formula is `6 + floor(runsElapsed / 2) + sectorsLost`. Less
  ground to move, not a faster loss. Simulated at median 15 runs (§3);
  see that section's caveat before reading this as validated.
- **Do refits persist through death?** Yes. Every run ends in death by
  design, so losing refits on death would mean losing them always — a tax on
  a guaranteed event, not a choice. Built as designed.
- **Do patrols need to be visible during a run?** Yes, designed as such — a
  sector holding a patrol is meant to show it during a run you drop into.
  Not yet built; belongs with the rest of the command view.

### Open questions

- Is mouse aim an improvement or does it remove the reason to turn the ship?
- **Does the pressure formula need a cap? Measured: no — a cap is the wrong
  fix.** With the command view's economy on the board, capping the budget
  turns 83% losses into 83% deadlocks rather than into wins (§3). The
  campaign is decided almost entirely by how much ground a run takes, with a
  cliff between five steps (0% wins) and six (93% wins) and no contested band
  between them. What is missing is a feedback term — something that slows the
  enemy as it loses ground or speeds the player up as they gain it — not a
  smaller number. Open, and a design question rather than a tuning one.
- **How much ground should a run actually take?** `gainGround` gives one step
  per wave cleared in the sector you are standing in, so a run's reach is
  however many sectors a player can clear and hyperwarp between before dying.
  Nobody has flown enough runs to know what that number is, and per the table
  in §3 it is the number the entire campaign hangs on.
- **Is the patrol priced right?** 200 salvage, strength 3, one in the field
  plus one per yard. All invented; `strategy-layer.md` leaves them open.
- **Should fitted refits be capped?** They are not, so a rich player
  eventually flies all six. Each is individually a tradeoff and the downsides
  do stack, but "what am I building for this run" becomes "everything" once
  3,050 salvage is affordable.
- **Is `1 + yield` the right salvage curve?** Implemented to avoid zeroing
  salvage in the yield-0 home sector, but it means yield-3 sectors pay 4×
  rather than the documented 3× (§3). Worth a look in the tuning pass
  alongside the flight-model constants.

---

## 8. Repository

Everything lives on the branch `claude/star-trek-game-research-vyae7o` in
`pniessen/star-trek`, fully pushed. `main` still holds only the initial commit —
nothing has been merged, and no pull request has been opened.

| Commit | Contents |
|---|---|
| `54faabc` | Prior-art research, four concept options, visual dossier |
| `11eb866` | Vector renderer, wireframe/occluded toggle, post chain, stroke HUD |
| `45b824e` | Combat, hostiles, waves, docking, the multiplier, the scanner, strategy-layer design |

```
npm install
npm run dev                  # http://127.0.0.1:5173
npm run typecheck
node tools/playtest.mjs      # headless run + assertions + screenshots
```
