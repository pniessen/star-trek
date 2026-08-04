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
| ~~**The play space is a plane**~~ **— unlocked, see below** | *The original reasoning, kept:* the overhead scanner is only trustworthy if the world is flat. In 3D the map has to lie about altitude and the player learns to distrust it. Planar means every contact is exactly where the scanner says, and the skill becomes rotational. |
| **The play space is a shallow slab, floored at `y = 0`** | What replaced it, with the owner's approval. One key: hold to rise, release to sink, so descent is not an input and the whole thing costs one binding — there were no fingers for a second held axis. Ceiling ~14 units against engagement ranges of 14–78. Climbing draws on the one energy pool and holding altitude keeps drawing on it. Hostiles use it too, at a per-class fraction. Behind a switch (`Y`), defaulting on. |
| **Occluded geometry, not pure wireframe** | Pure wireframe is authentic and unreadable the moment two ships overlap — you cannot tell which is in front. Same glowing strokes over near-void opaque faces gives unambiguous depth and loses nothing of the look. |
| **One energy pool** | Thrust, shields and weapons all draw from one reserve. Every burn is a shot you cannot take later; that tension is the combat design. |
| **Four separate shield facings** | Turning a fresh quarter toward whatever is shooting is the defensive skill. Without it this is *Asteroids* with glow. |
| **Phasers vs torpedoes** | Instant, energy-draining, weaker with distance versus limited, slow, must-be-led. Opposite characters make "which do I use" a question rather than a preference. |
| **No win state within a run** | The Kobayashi Maru is the unwinnable test. Runs escalate until you die; the *campaign* is what can be won. This is what lets an arcade game carry an empire layer. |
| **The multiplier is the currency** | It climbs while you stay undocked and untouched, halves when something reaches the hull, and is only realised as score when you dock. The arcade question and the strategic question are then the same question. |
| **Vector, with a hybrid** | Not a literal 1982 XY monitor. Glowing stroked edges, opaque black faces, depth-faded lines — nostalgic in recipe, current in execution. |
| **Web, no engine** | TypeScript, Vite, Three.js, WebGL2. Instant playability, shareable by link, and this look is cheap in WebGL because it is lines and post-processing rather than models and lightmaps. |
| **Our own universe** | The genre is not protectable; the marks are. No LCARS, no delta, no familiar species. |

### Why the plane was unlocked

Recorded at length because a decision that changed is more useful with its
history attached than without, and because this one was load-bearing for three
years of reasoning in this document.

**It carried two loads and neither survived scrutiny.**

*The scanner.* "A 2D tube cannot honestly describe a 3D world" is simply not
true and has not been since 1984: **Elite** drew a vertical stalk from every
blip down to the plane, and Elite is in this project's own
[prior-art.md](./prior-art.md). Height reads instantly — you draw a line under
it. The *base* of the stalk is still exactly where the contact is, so nothing is
misplaced and the promise this instrument was built on is kept intact. What the
top of the stalk costs is that an elevated contact reads slightly further
"ahead" than it is, which is the trade Elite took and the reason the stalk is
drawn at all rather than the mark simply being moved.

*The shield facings.* This one was never even at risk. `Ship.facingFrom`
resolves a hit with `atan2(x, z)` and has never looked at `y` — **the four
facings are a ring, not a sphere.** A shot from above at bearing 40° already hit
the same quarter a level shot from 40° would. A cylinder is the correct model
and it is precisely what lets four facings survive a third dimension without
becoming six. Turning a fresh quarter toward the shooter is exactly the skill it
was.

**The objection that did land was the controls**, and it came from the owner.
Left/right yaw, up/down throttle, `Space`, `X`, `C`, `Z`, `Shift`, `Tab`, `R` —
both hands are full, and WASD has to stay identical to the arrows. A second held
axis had no fingers available. So the design has no second axis: **one key, hold
to rise, release to sink.** The plane became the floor rather than the middle,
descent stopped being an input, and the binding count went from two to one.

Three consequences follow and each is doing real work:

- **Nothing ever goes below `y = 0`**, so every stalk on the scanner points the
  same way and the tube reads as a bar chart rather than as a set of signed
  offsets. Own ship gets a stalk at the centre, so "am I above that Raider" is a
  comparison of two lengths sitting next to each other.
- **The guns train in elevation; the hull does not.** There is no pitch input
  and there is never going to be one, so a shot fired dead level could not reach
  anything that was not at exactly the player's own height. Every aim test is
  therefore a *bearing* — which is what the hostiles have always used, since
  `aimError` in `hostiles.ts` is `atan2(x, z)`. This is why the slab has to be
  shallow: a turret can only train so far.
- **Altitude is not free.** It is drawn from the one energy pool for as long as
  the key is held, ceiling included, and a starved reserve cannot hold you up at
  all — run the pool dry and you sink back onto whatever you were flying over.

What is still true, stated plainly: the scanner is still trustworthy, now
because of the stalk rather than because of the flatness; and the facings are
still four and still a ring.

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

### Altitude — a third dimension, shallow

The unlocked decision, built. `src/game/altitude.ts` holds every number and the
switch; §2 holds the argument. What exists in the running game:

- **One key.** `Q` held climbs at 9 units a second; released, the ship falls
  back at 11. `Q` because it is free, because it sits directly above `A` for a
  WASD flyer's little finger, and because an arrows flyer's left hand is already
  parked one row down on `Z`/`X`/`C`. It is deliberately *not* remapped while the
  chart is up, exactly as the arrows are not — pulling the chart up over a
  minefield is precisely when you want to still be able to climb.
- **A ceiling of 14 units**, drawn against `preferredRange` of 14–62 and
  `PHASER.falloffEnd` of 78. Every one of those four numbers is a first-draft
  guess of the same species as `Ship.TURN_ACCEL`.
- **It costs the reserve**, at 0.055 a second against thrust's 0.035 at full
  burn — so a full pool buys about eighteen seconds of being upstairs, and the
  cost continues while you merely *hold* altitude, because a lid you can park
  under for free is a lid everybody parks under.
- **Hostiles use it too**, because a slab the player alone could reach would
  make altitude a pure escape and probably strictly dominant. Each class gets a
  fraction of the ceiling and a preferred altitude that drifts on its own slow
  sine — 7 to 13 seconds a cycle, its own phase, so a wave arrives at assorted
  heights rather than breathing in formation. It is explicitly *not* a 3D
  pursuit brain: horizontal steering is untouched, every hostile still holds its
  range and strafes exactly as it did, and none of them chase you upward.
  Raider 0.9 — "comes from anywhere" is the whole brief of the class and
  anywhere now includes above. Shroud 1.0 — it commits from nowhere and the full
  slab is more nowhere. Lance 0.65 — it takes a perch, and at its 62-unit
  station height barely changes the duel. Bastion 0.15 — the anvil stays on the
  anvil, which also makes it the class you can reliably out-climb. Harrow 0.1 —
  its ordnance goes on the floor and stays there.
- **The scanner grew stalks**, and own ship grew one too. See "The scanner"
  below.
- **The tape.** A vertical ladder beside the shield cluster, mirroring the
  `SHIELDS` label across the ship glyph: the whole slab, three ticks, a bar
  where you are with a tail back down to the deck, and a number once there is
  one worth reading. Vertical because this is the one quantity in the game whose
  direction on screen can be the direction it means. It goes amber on exactly
  one condition — a reserve too thin to hold you up — which is the same hue and
  the same rule the energy gauge already uses.
- **The floor keeps its furniture.** Mines, the docking corridor, the gate and
  the starbase are all still at `y = 0`. Having to come down to bank is a
  feature. The corridor enforced it for free — `inGate` is a 3D range against a
  7-unit radius — but *silently*, so the approach panel now leads its status
  ladder with `DESCEND TO PLANE`: a ship holding the centreline fourteen units
  up reads as perfectly lined up on every needle and simply never captures,
  which is indistinguishable from a bug.
- **The minefield is what altitude is actually for**, and this needed no code at
  all: the trigger and the blast are both `distanceTo`, which has always been
  three-dimensional, so 6.5 units of height clears the trigger and 13 clears the
  damage. A field you could no longer circle is a field you can now fly over,
  paid for out of the reserve. It is the one place in the game where the trade
  is unambiguous.
- **Behind a switch.** `Y`, in `DISPLAY_KEYS` so it does not launch a run off
  the title, defaulting on. With it off the ship, every hostile and every
  projectile are pinned to `y = 0` structurally rather than arithmetically, the
  altitude tape is not drawn, and the scanner's stalks fall below their
  half-pixel threshold. Nobody has flown either version, which is why it is a
  switch rather than a fact.

Three things turned out to need nothing, which is the pleasing part of the
change and is recorded so nobody re-derives it:

- **Swept collision** (`sweepDistance` / `sweepHits`) is a point-to-segment
  distance written in `Vector3` arithmetic and has been correct in three
  dimensions since the day it replaced point sampling.
- **The torpedo lead pip's intercept solve.** `|r + vt| = st` is a quadratic in
  `t` written in `lengthSq` and `dot`; it has been solving the 3D intercept all
  along and simply never saw a non-zero `y`. Exactly one line in that function
  was planar — it flattened the *finished* answer onto the deck before
  projecting it, so the mark would have sat under the ship it belonged to.
- **Hostile fire.** The lead is a plain vector subtraction, so a climbing player
  is led upward without a line changing; and `aimError` was already a bearing,
  so hostiles have been training their guns in elevation since before there was
  any elevation to train them in. The player's weapons now copy that precedent
  rather than inventing one.

Two things did change under combat and both are design decisions rather than
plumbing. The **phaser's assist cone is measured in bearing** — the beam still
runs to the hull's true position and the falloff is still charged on the true
range, so height costs a distant target damage; what it does not cost is the
ability to point at it at all, which no amount of turning could have bought back
on a ship that cannot pitch. And **the torpedo tube elevates**, onto the nearest
hull within a generous 0.7-radian bearing window, taking only that hull's
elevation and passing the player's bearing through untouched. Leading the shot
is still entirely the player's, which is the whole of what distinguishes a
torpedo from a phaser; what the ship does for them is the one axis they cannot
fly. Point at where a crossing Raider *is* and the torpedo still sails behind
it, exactly as it always did.

The demo pilot stays on the floor. It has no `climb` and nothing asks for one on
its behalf: a demo that climbed would need a *reason* to, and a wrong reason
reads as a ship wandering vertically for no cause, which is worse than one that
never does. The hostiles are using the slab around it either way, so the
demonstration still shows a sector with height in it — what it does not show is
the key, and that is an honest gap rather than a hidden one.

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

### The Warden

Until this, the sector held exactly two kinds of object: you, and things trying
to kill you. The Warden is the third — an allied hull that turns up for one of
two reasons, and the difference between them is the design.

A **patrol** is a thing the command view has let you buy since it was built, at
200 salvage, and the only evidence you had ever bought one was a number on a
chart between runs. Drop into a garrisoned sector now, or hyperwarp into one,
and the ship you paid for is in it, for the whole run. That is the "patrols
visible during a run" line from the chart design doc, which was designed,
priced and never built, and it is the cheapest thing on the list that makes the
map feel like it is describing somewhere. Everywhere else, once in a long
while, one crosses the sector, says something, and leaves — a sector somebody
else is also flying in is a sector; a sector nobody else has ever been seen in
is a shooting gallery.

Four decisions carry the weight:

- **It gets no colour of its own.** Cyan already means *ours*; the palette
  called it "friendly hull, player" and the starbase, the only other friendly
  object, is drawn in its dim variant. A sixth hue would say "another class"
  when the only thing an ally has to say is "not a target", and there is no gap
  left on the wheel that is clear of five hostile hues and still reads as
  friendly. What tells the two cyan ships apart is the outline — the Warden is
  squat, level and symmetrical with nothing reaching forward, against five
  hostile silhouettes that are all asymmetric or leaning at you — and the fact
  that the camera is welded to the other one.
- **Its kills pay nothing.** No salvage, no multiplier, no entry in the run's
  kill count, no hit-stop. The multiplier is the currency and the greed loop is
  locked, so income the player did not earn is a hole cut in the one rule
  everything else hangs off, and an escort that banked for you would make the
  best play "stay behind the Warden". What it pays instead is the only thing
  worth paying: the hostile is gone and the shot is still in your reserve. Help,
  priced as breathing room rather than as income. Its gun is set to match — one
  phaser shot's damage every 2.4 seconds, which thins Raiders and merely annoys
  a Bastion, and can never clear a wave for you.
- **On the scanner it is the only glyph with a front.** An open cyan chevron
  pointing where the ship is actually going. Every hostile glyph is a closed
  symmetric outline and every unresolved return is a broken magenta ring, so it
  cannot be misread as either; the one mark it resembles is the player's own
  arrowhead, which is the family resemblance wanted and which never leaves the
  centre of the tube.
- **It can be lost, and nothing replaces it.** Nothing aims at a Warden —
  hostiles lead the player and always have — so what kills one is the volume of
  ordnance in the air around a fight it flew into. It comes apart into its own
  edge segments like everything else. The campaign's `patrol` is deliberately
  *not* cleared when it dies: attrition is already modelled between runs in
  `wearPatrols`, and charging the same loss twice would price a patrol once on
  the chart and again in the cockpit. The player cannot hurt it at all —
  friendly fire would turn a gift into a trap.

It talks, on the same comms row the panel uses, in the same terse uppercase:
`TIDEMARK: ON STATION`, `SALTIRE: PASSING THROUGH`, `MIND YOUR SIX`,
`GOING DOWN`. Its own class name and eight hull names — nouns of watchkeeping
and navigation, a lodestar and a tidemark and a cairn all being things left out
for somebody else to steer by. No prefix, no rank, no registry. In the forward
view it carries a two-line datablock off a leader line, class and name over
`ALLY nnn KM`, which is the lead pip's argument spent on identification rather
than on a firing solution.

Audio: a squelch — a very short, very tight band of noise, the one gesture
nothing else in the bank makes — and then two clean triangle notes, rising for
a hail and falling for a loss. It is the first cue in the game that is a thing
happening in the *panel* rather than in the world, and it needed to be
identifiable as that before the first note.

### The scanner

Heading-up, contacts glyphed by class, off-range contacts pinned to the rim.
This used to be *the* reason the play space was planar; it is not any more, and
it did not have to be. It is still half the interface, exactly as it was on the
1982 cabinet.

**Height is a stalk.** Every mark that can leave the floor is lifted off its
true position and a line is drawn back down to it, with a two-pixel foot on the
deck so the base reads as a position rather than as the end of a line. Read the
base for where, the length for how high. Own ship gets one at the centre, which
is half the answer to "how does the player read their own altitude" — the half
that works in a fight, because it is in the instrument the eyes are already on
and because it is *comparative*. Three details are deliberate. The lift is
measured from the **floor**, not from the player, so every stalk points the same
way and the tube reads as a bar chart; that is worth more than the symmetry a
signed measure would buy. The vertical scale is 1.4 px per unit against the
horizontal's 0.69 — at true scale the whole slab would be ten pixels and a
Raider at the ceiling would be indistinguishable from one on the deck. And
**unresolved returns get no stalk at all**: a return the tube could not resolve
into a contact could not have resolved its height either, and inventing one
would be the first lie this instrument has ever told. The Shroud uses the whole
slab, so which way it is coming from vertically is genuinely unknown until it
materialises, which is the class working as designed rather than a gap.

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
front. **WASD moves the sector cursor, here exactly as it does in flight** —
the two screens draw the same 8×8 map and used to bind the same keys to
opposite jobs, which is most of why this screen failed its first player three
times. Up/down arrows move the decision list, `Space` commits, `Enter`
launches. The selected row states what `Space` would do and to which sector
*before* it is pressed, and carries its own refusal rather than only producing
one after the fact.

**The loop is closed.** Docking credits `campaign.salvage` — the one place
the arcade layer pays the strategy layer. Reaching the epitaph resolves the
run exactly once: construction ticks, `runEnemyTurn()` spends the enemy's
pressure, patrols take attrition, and the campaign is saved with its RNG
cursor so a reload resumes the same war rather than re-rolling it. Launching
drops you at `campaign.front` with whatever refits are fitted.

**The sectors now say what they are.** The first player to fly the chart
reported that every square read as "not here", that the cursor got lost, that
the ring in a square meant nothing, and that a long warp appeared to cost the
same as a short one. All four were true, and none of them were rendering bugs
in isolation — the map had the information and never said any of it out loud.

- **Places have names**, derived from the seed and never stored
  (`chart/naming.ts`). Every sector belongs to a region shared by a 3×3 block —
  "the PELLAS REACH" — and every dock carries a designation built from its
  region's stem, so `PELLAS 47` is audibly somewhere in the PELLAS REACH. A new
  war reseeds the whole map of names. The docking sequence welcomes you to the
  station by name, and the panel carries it through every phase.
- **The in-run overlay is an instrument rather than a picture.** The cursor is
  drawn with rules running the full width and height of the grid — a fix in
  kind, not in degree, because a brighter box is still a box you have to find
  among sixty-four — plus a pulse on real seconds. Under the grid: the sector's
  name and region, `THREAT / PAYS / BANK AT <station>`, whatever is worth
  acting on (an attack inbound, ground that can be taken, a patrol, something
  building), the price of the jump, the key, and the controls. Structures and
  patrols are drawn in flight now; they were the reason to prefer one square
  over another and were only ever shown between runs.
- **Arriving is an event.** `Session.arrivalCard` puts the sector, its region,
  its threat and yield, its dock or lack of one, and any committed attack on
  screen for 2.4 seconds after a jump. It does not pause the game — the same
  reasoning as the chart — and it clears before the destination's first wave
  announces itself.

**The dock ring is still aspirational, and now says so louder.** `ChartView`
draws a ring on any sector `canDock` returns true for, and the readout and the
arrival card now spell that out as `NO DOCK HERE` — but the starbase still sits
at one fixed world position regardless of `campaign.current`, so the running
game lets you dock from anywhere. The chart and the card agree with each other
and both disagree with the world. Per-sector docking remains out of scope;
this is a louder note, not a fix, and it is the strongest argument yet for
building it.

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

**Distance now prices a jump, and that is a combat-balance change a human
should confirm.** Hyperwarp charged for a flat two seconds however far it went,
so the honest answer to "how hard is a long warp" was "no harder", and the map
lost the one axis that would have made a far corner feel far. `chart/jump.ts`
sets the charge from the Manhattan distance: `1.4s + 0.35s` per extra sector.
Everything else follows from that one number — the guns are cold for longer,
and the reserve drains at `HYPERWARP.drainPerSecond` for longer, so a charge
that outlasts the reserve dies unarrived and the reserve becomes a range limit
that tightens as a fight goes badly. The multiplier is still halved flat,
because "a jump costs the same as taking a hit" is locked.

The curve is deliberately not a uniform increase. A one-step hop is now
**cheaper** than the old flat rate (1.4s against 2.0s) because that hop is the
escape valve and the escape valve should be reachable. A full reserve reaches
eight steps against a board whose far corners are fourteen apart, so crossing
the whole map in one jump is impossible by construction and the rich far edge
is somewhere you close on over a run. Both constants are first-draft guesses in
the same category as the flight model, and the whole shape wants a human at the
keyboard: the numbers that matter are whether 1.4s is short enough to flee
with and whether an eight-step ceiling reads as a rule or as a wall.

**One deviation from the design doc, found while implementing salvage.**
Salvage earned in a sector is scaled by `1 + yield`, not by `yield` as
written: yield runs 0–3 and the home sector — where every fresh campaign
starts — is yield 0, and a bare multiply would zero every kill's salvage
there. The consequence is that a yield-3 sector now pays 4× rather than the
documented 3×. Flag this for the tuning pass; it is a balance decision, not
a bug, but it was made mid-implementation rather than in the design doc and
deserves a second look with a human at the keyboard.

**`tools/campaigntest.mjs`** is 135 assertions in bare node, no browser. The
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
attract demo's firewall. The 26 added with the naming and jump pass cover the
derivation of names — stable for a seed, shared across a region's block,
distinct between seeds across the whole board, a station borrowing its
region's stem while staying distinct from its neighbours — the jump curve
(orthogonal, symmetric, monotonic in distance, and a reach that agrees with
the energy it is derived from), and that every decision states what `Space`
would do and why it would be refused *before* the key is pressed, with the
statement and the act agreeing.

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

`tools/playtest.mjs` is at 47 assertions and green — see "Verification" below.
Nothing in the slab touches `src/chart/`, so `campaigntest` (135) and
`audiotest` (73) are untouched and green too.

### Verification

`tools/playtest.mjs` drives a whole run headlessly and has grown, feature by
feature, to forty-seven assertions: waves spawn and escalate, phasers draw
energy and torpedoes deplete, kills bank salvage and climb the multiplier,
docking banks and resupplies and resets, hit-stop dilates time and always lets
go, death breaks the player up and reaches the tally, restart is clean, the
minelayer and cloaker classes behave as designed, and — the in-run half of
the chart, covered in §3 above — hyperwarp charges, locks weapons, and costs
what it should, the overlay itself raises and steps the cursor without
walking it off the grid, WASD hands off between the ship and the cursor
correctly, and a committed fleet move can be intercepted.

The nine added with the slab are written so each would fail outright if the
feature were absent, which for a toggleable mechanic takes a little care.
Holding the key gains altitude and stops at the ceiling rather than continuing.
The reserve pays for it — checked against a known 0.9 with the facings full and
nothing being fired, because passive regeneration would otherwise push that
number *up*, so a missing drain cannot pass. Releasing returns the ship to the
floor, checked promptly, before the drain can starve the reserve: a starved ship
sinks on its own and a check taken later would pass whether or not releasing
does anything. A hostile leaves the floor. And `Y` flips the switch, after which
holding the key does nothing to the player *or* to the fleet — the hostile count
is asserted alongside the height, since a max over an empty list is zero and an
empty sector would otherwise satisfy it.

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

- **Mouse aim.** Aiming is the nose, which is the Sega model. It is now more
  load-bearing than it was: with a slab overhead, "point the hull" is the only
  aiming the player does at all, since the guns train in elevation on their own.
  Mouse aim is still worth testing and is now a bigger change than it looked.
- **A pitch input.** Never. The controls are the reason the plane survived as
  long as it did, and one held key is the whole of what the slab could afford.
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

**Also wanting a human at the keyboard: the Warden's numbers.** How often a
passer should turn up (55–95 seconds to the first, 115–195 to the next), how
long it stays (32 seconds), how hard it shoots (0.3 every 2.4 seconds) and how
close it keeps station (34 units) are all reasoned rather than played. The two
that will show first are the visit rate — too often and it stops being an
event, too rarely and most runs never see one — and whether an escort holding
station 34 units off your quarter is company or clutter in a wave-eight fight.
Its comms lines land on the same row as `WAVE 8` and `HULL BREACH` and will
sometimes step on one; whether that reads as a busy channel or as a bug is not
something reasoning can settle.

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
- **Do patrols need to be visible during a run?** Yes, and now built — see
  §3, "The Warden". A sector holding a patrol is met by one when you drop
  into it or jump into it.

### Open questions

- **Does the slab earn its key?** `ALTITUDE.ceiling = 14`, `climbRate = 9`,
  `fallRate = 11`, `drain = 0.055`, the five per-class `slab` fractions,
  `SCANNER.altitudeScale = 1.4` and `TUBE_WINDOW = 0.7` are all first-draft
  guesses and nobody has flown any of them. `Y` toggles the whole mechanic, so
  the A/B is free. The two questions no constant answers: does one key with no
  descent read as *flying*, and does the guns' automatic elevation feel like the
  ship helping or like the ship aiming? See §3, "Altitude", and
  [todo.md](todo.md) §2.
- **Should the demo pilot use the slab?** It does not, and the demonstration
  therefore never shows the key. Giving it a reason to climb — over a field, off
  a Bastion — is a small piece of work; giving it a *wrong* reason reads as a
  ship wandering vertically for no cause. Deferred until a human has flown it
  and knows what the right reason is.
- Is mouse aim an improvement or does it remove the reason to turn the ship?
- **Is the jump's distance curve right?** `JUMP.baseCharge = 1.4` and
  `JUMP.perStep = 0.35` are first-draft guesses and they change combat: a hop
  next door is cheaper than it used to be and a long jump is dearer, with an
  eight-step ceiling on a full reserve. Nobody has flown it. See §3.
- **Should a bare sector actually have nowhere to bank?** The chart and the
  arrival card both now say `NO DOCK HERE` and the world does not agree — the
  starbase is at one fixed position however the chart is drawn. Making it true
  is the design doc's own "the greed loop, one level up", and it is also the
  one change that could leave a player carrying a fat multiplier with nowhere
  to realise it, which is either the whole point or a trap.
- **Does the pressure formula need a cap? Measured: no — a cap is the wrong
  fix.** With the command view's economy on the board, capping the budget
  turns 83% losses into 83% deadlocks rather than into wins (§3). The
  campaign is decided almost entirely by how much ground a run takes, with a
  cliff between five steps (0% wins) and six (93% wins) and no contested band
  between them. What is missing is a feedback term — something that slows the
  enemy as it loses ground or speeds the player up as they gain it — not a
  smaller number. Open, and a design question rather than a tuning one.
  **Investigated in [campaign-balance.md](./campaign-balance.md)**: three
  candidate terms built behind a switch and measured, the mechanism behind the
  cliff identified as a destabilising term already present rather than a
  missing one, and two findings that change the question — some of the cliff
  was the instrument modelling the player's reach as a constant, and salvage
  above three hundred a run buys nothing, so the command view cannot decide a
  war whatever the enemy's formula says. A recommendation is on the table and
  nothing has been adopted.
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

Everything is on `main` in `pniessen/star-trek`, and every push to `main`
deploys the build to GitHub Pages (`.github/workflows/pages.yml`, gated on
`npm run campaigntest`). Feature work happens on branches off `main` and is
merged back; no long-lived development branch survives.

The milestones, oldest first:

| Commit | Contents |
|---|---|
| `54faabc` | Prior-art research, four concept options, visual dossier |
| `11eb866` | Vector renderer, wireframe/occluded toggle, post chain, stroke HUD |
| `45b824e` | Combat, hostiles, waves, docking, the multiplier, the scanner |
| `f90ac72` | The enemy's turn — pressure budget, committed moves, interception |
| `dab239c` | Hyperwarp, priced at half the multiplier |
| `10ca379` | The in-run tactical chart, drawn over the run without pausing it |
| `cce677e` | The command view, closing run → tally → chart → run |
| `e5e5b79` | The audio layer: two oscillators and some noise |
| `469efab` | The audio prior-art research, which the layer predates and contradicts |
| `af6a8b4` | Pages deployment on every push to `main` |
| `8f3747d` | Swept projectile collision, replacing point sampling |
| `589b49c` | Alert conditions, and shields worth managing |
| `ed22402` | The Warden — the one thing that is neither you nor hostile |
| `435f187` | Sector names, prices, and a cursor you can find |

What to do next lives in [todo.md](todo.md), not here.

```
npm install
npm run dev                  # http://127.0.0.1:5173
npm run typecheck            # before every commit
npm run playtest             # headless run + assertions (needs a Playwright browser)
npm run campaigntest         # chart logic assertions, bare node
npm run campaignlength       # campaign length distribution over many seeds
npm run standalone           # dist/kobayashi.html, one self-contained file
```
