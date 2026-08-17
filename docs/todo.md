# Kobayashi — to do

A carry-into-the-next-session list. Ordered by what unblocks the most, not by
size. Everything here is either a known defect, a decision waiting on a human,
or a piece of scope that was deliberately left out.

Background is in [status.md](status.md); the locked decisions in `CLAUDE.md`
are not up for revisiting here.

---

## 1. Defects — known, reproducible, unfixed

### 1.1 The first WASD press in the command view is swallowed

**Reproduce:** enter the command view (die, wait for the epitaph to hand off),
press `d` — the sector cursor does not move. Press `d` again — it moves. Every
press after the first works.

Measured exactly:

```
press 1 of d: 60 -> 60   FAIL
press 2 of d: 60 -> 61   OK
press 3 of d: 61 -> 62   OK
```

The cursor snaps to `campaign.current` on that first press, which is what a
cursor *reset* looks like, not what a dropped keypress looks like.

**Disproven:** that the `previousPresentationMode` watcher in `src/main.ts` is
re-firing on the frame the key lands. A guard skipping the cursor reset while
`presentation.mode === "command"` did not change the symptom, so the reset is
happening somewhere else or for another reason. That guard was reverted rather
than left in with a comment asserting a cause that had just been falsified.

**Next diagnostic:** instrument the keydown handler to log, on the first press
only, what `handleCommandKey` receives and what `presentation.mode` and
`chartCursor` are at that instant. The dispatch to walk is:

```ts
if (DISPLAY_KEYS.has(key)) return;
if (presentation.mode === "command") { handleCommandKey(key); }
else if (presentation.mode === "run") { … }
else { presentation.startRun(); }
```

This is worth doing first. The player's repeated report that the command view
is unusable is partly this: their first input into the screen is eaten, which
reads as "the keys don't work" long before it reads as "off-by-one frame".

### 1.2 `NO DOCK HERE` is a lie

The chart and the arrival card both say it, and the world does not agree — the
starbase sits at one fixed world position however the chart is drawn. Either
make per-sector docking real or stop claiming it. Listed again under §3 because
making it true is a design decision, not a bug fix.

### 1.3 "Small and distant stays desaturated" has no implementation

`CLAUDE.md`'s colour-is-information amendment (`docs/environment.md` §4.1)
names three requirements a body's colour exemption holds only if all three are
true, and the third — a body below an apparent-size threshold keeps the old,
muted rule — was never built. No such threshold exists anywhere in the code.
The hero giant has never exposed the gap because `GIANT.range`/`radius` keep
it frame-filling by construction, so nothing has forced the question yet, but
a small moon at range or the comet's own head (both stroke-built, both
candidates for `light.ts`'s still-unused `shadeAt`) would sit exactly in the
case the ruling was written for and currently gets no muting at all. Either
implement the threshold or fold it into the ruling's own text as aspirational
rather than built.

---

## 2. Tuning — needs a human at the keyboard, not more reasoning

Every constant below was chosen by reasoning about it. None has been played or
heard. This is the one block of work that cannot be done by thinking harder.

**Flight and combat**
`Ship.TURN_ACCEL / TURN_DAMP / MAX_TURN / DRAG`, `PHASER.falloffStart/End`,
`WAVE_BREAK`, multiplier gain, `HIT_STOP` (now including `heavyKill = kill ×
1.5`, the Brawler/Miner beat), the death sequence's `TIMING`, the attract
loop's dwell times, the scanner sweep rate.

**Kill rings** — `DebrisField.ring` in `src/game/debris.ts`, drawn at 24
segments per ring, radius `2 + 22t` over 0.7s, dead by the end. Reasoned, not
flown: whether a 1.4×-scaled Bastion ring actually reads as heavier than a
1×-scaled Raider's, or whether the difference only shows up in the hit-stop
beat, is a keyboard question. Worth the same sitting as `HIT_STOP.heavyKill`
above, since the two are meant to read as one punctuation, not two.

Segment budget, arithmetic rather than measured (no live capture was taken
for this pass — worth confirming against a real machine the way the comet's
779 was): the comet's tail alone already spends **779 of `TraceBuffer`'s
shared 5000** (§2 below). On top of that, a busy wave adds kill rings (24
segments each; a torpedo blast catching a cluster of swarmers plus a couple
of trailing phaser kills inside one ring's 0.7s life is a reasonable worst
case at 5 concurrent rings, 120 segments), near-miss streaks (1 segment each,
live for 0.35s; call it 8 concurrent in the same dense wave), and shield arcs
(10 segments per arc, up to 2 at once — the bow's brace aura plus a flash on
a different struck facing — so ≤20). That totals roughly 779 + 120 + 8 + 20 ≈
927 segments in a worst-case combat frame, well under a fifth of the 5000
budget — but it stacks with the debris shards a multi-kill wave is also
bursting at the same moment, which this arithmetic does not include, so it is
a floor on the worst case rather than the whole of it.

**The combat feel pass** — four small, independent constants, all new and
all unflown in the same sense as everything else here.

- **`NEAR_MISS`** (`session.ts`) — `outer = 4.5`, `cooldown = 0.4`. What
  decides whether it works: whether the cue reads as "that one was close"
  once per dense pass, or wears the cooldown down into a rattle nobody
  notices any more.
- **The shield arc's `RADIUS = 4.6`** (`game/shieldFx.ts`) — not tied to the
  player hull's own geometry; the review that shipped it measured the
  hull's own half-width in `hulls.ts` at closer to 2–3 units, so the aura
  and flash sit visibly outside the hull rather than flush against it, most
  noticeable on a lateral hit in chase view. What decides whether it works:
  whether that gap reads as "the shields, not the hull" — plausible, since
  shields are meant to extend past the hull — or simply as misaligned.
- **`WITHDRAW`** (`hostiles.ts`) — `threshold = 0.2`, `exitRange = 130`, and
  a per-class `chance` (Raider 0.75, Sniper/Miner 0.5, Brawler 0.15, Shroud
  0). What decides whether it works: whether a fleeing hull reads as a
  class behaving in character — disposable Raiders running, the Bastion
  standing — or as an arbitrary coin flip nobody can see the pattern in.
- **`Fleet.brawlerEngaged`** (`hostiles.ts`) — the gate for the swarmer's
  stern-flanking bias, recomputed once a step with no hysteresis: a Brawler
  crossing in and out of its own `fireRange` at the boundary could in
  principle flip the bias frame to frame. Self-dampened in practice by the
  turn-rate clamp and the roughly 2× gap between the class's own
  `preferredRange` and `fireRange`, so no chatter has actually been
  observed — a tuning-pass candidate rather than a known defect.

**The altitude slab — the newest block, and the one to fly first.** Everything
in `src/game/altitude.ts` was reasoned about and none of it has been flown.
`Y` toggles the whole mechanic off, so the A/B costs nothing and there is no
excuse for guessing twice.

- **`ALTITUDE.ceiling = 14`.** The load-bearing number. Set against
  `preferredRange` of 14–62 and `PHASER.falloffEnd = 78`, so it should be a real
  evasive option without making a fight a 3D search problem. Too low and the
  key is decoration; too high and the guns' automatic elevation starts doing
  more of the aiming than the player is.
- **`climbRate = 9` / `fallRate = 11`.** About 1.6s up and 1.3s down. Falling
  is faster than climbing on purpose — letting go should feel like letting go —
  but whether that reads as responsive or as being dropped is not decidable from
  the source.
- **`drain = 0.055` a second**, against thrust's 0.035 at full burn, charged for
  as long as the key is held. A full reserve buys about eighteen seconds
  upstairs. This is the number that decides whether altitude is a tactic or a
  habit.
- **The five `slab` fractions** in `HOSTILE_SPECS` — Raider 0.9, Shroud 1.0,
  Lance 0.65, Bastion 0.15, Harrow 0.1 — and the 7–13 second wander period.
  Watch for whether a Raider at the ceiling reads as a threat or as clutter.
- **`SCANNER.altitudeScale = 1.4`** px per world unit, deliberately double the
  horizontal 0.69 so the slab is legible at all. Too high and an elevated
  contact appears to be somewhere it is not; too low and the stalks vanish.
- **`TUBE_WINDOW = 0.7`** rad, the bearing window the torpedo tube looks in for
  something to take an elevation from. Wide because a player leading a crossing
  Raider is pointed twenty degrees off it. Too wide and the tube elevates onto
  the wrong hull.

The two questions no constant answers, both for the same sitting: does one key
with no descent actually read as flying, and does the automatic elevation feel
like the ship helping or like the ship aiming?

**Flown, 2026-08-07. One of the two is answered.** The slab "makes a
difference" and the game is "getting fun" — the first human evidence for
unlocking "the play space is a plane", which until now was an argument on paper.

- **Automatic elevation reads as the ship helping.** This is the load-bearing
  answer: it is what lets a shallow slab work with no pitch input, so
  `TUBE_WINDOW = 0.7` and the guns solving elevation while the hull does not are
  both confirmed rather than merely defensible. Do not revisit.
- **Whether one key with no descent reads as flying is still open** — not
  contradicted, just not yet decidable at the keyboard. `climbRate = 9` against
  `fallRate = 11` is the pair to A/B when it is, and `Y` makes that free.

Still entirely unflown: the five `slab` fractions, `SCANNER.altitudeScale`, and
every number in `LOOM` — see the gotcha below about why the Loom in particular
cannot be tuned on a deployed build.

**The brace** — `BRACE` in `src/game/Ship.ts`, and this one has an unusually
sharp question attached because the mechanic has exactly one dial that decides
whether it is interesting.

- **`ceiling = 2.5`.** What one quarter may hold. It sets how strong "armoured in
  front" actually is, and therefore whether the three empty facings are a real
  price or a formality. Low and the brace is not worth the strip; high and facing
  your attacker becomes the answer to everything.
- **`decay = 0.16`** a second, about nine seconds from the ceiling back to full.
  This is the length of the window, and the window is the mechanic: it should be
  long enough to cover a pass and short enough that you cannot brace at the start
  of a wave and forget about it. Measured at 0.156/s in the harness, so the
  constant is doing what it says.
- **`yield = 0.7`.** The conversion loss. It matters least of the three — a brace
  leaves the donors at zero, so re-stacking is naturally starved — and it exists
  as a backstop rather than as the brake.
- **`minimum = 0.25`.** The refusal threshold. Too high and the key declines when
  a player wanted it; too low and it lets them throw three facings away for
  nothing.

The question no constant answers: **does bracing and then having to keep the
shooter on your nose read as a decision or as a straitjacket?** The whole design
rests on that being a tactic rather than a punishment, and it cannot be settled
from the source. Fly it against a Bastion, which is the one class slow enough to
stay in front of you, and then against a pair of Raiders, which are the two that
will not.

**HQ's cadence** — `DISPATCH.first = 11`, `cooldown = 24`, `chance = 0.55`,
`hold = 6.2`, all in combat seconds. Aimed at one or two a run. The two failure
modes are opposite and both obvious at the keyboard: too rare and a player never
learns the channel exists, too often and it becomes a ticker they stop reading.
`hold` is its own question — six seconds is long for a HUD line, and it is long
because these have to be read *while dodging*; whether that is enough or already
too much is the sort of thing one sitting settles.

Only one task type behind it, and that is a design gap rather than a constant:
every dispatch is some version of *go there, clear a wave, break the strike*,
because that is the only verb the campaign has to point at. A Warden in trouble
(the state already exists) or a Loom sighting (which would also fix §6.1) would
each add a second.

**The commander and the war's voice** — new with the finite invasion,
first-draft guesses in the same sense as everything above.

- **`DOCTRINE_WEIGHTS`** (`chart/enemyTurn.ts`) — the per-action multiplier
  each doctrine applies to the enemy's own cost-sorted target list. What
  decides whether it works: whether a raider's war actually reads as
  raiding — weak-sector pushes, few assaults — rather than reading like any
  other commander with different flavour text on the deck log.
- **`GUARD`** (`session.ts`) — `chance = 0.3`, `hull = 1.6`, `speed = 1.25`,
  `cadence = 1.35`, `value = 2.5`. What decides whether it works: whether
  the commander's guard reads as a named, doctrine-flavoured veteran the
  first time a player meets one in the failing act, or as an ordinary hull
  with a bigger number attached.
- **`DISPATCH`'s act-aware fallback** — when nothing is inbound, HQ now
  names the war's own band (failing/losing/winning, per `warAct`) instead
  of staying silent. What decides whether it works: whether a player who
  never raises the chart still gets a true sense of how the war is going
  from the HUD row alone, or the three fallback lines read as interchangeable
  noise once the novelty wears off.

**The mix** — `BUS_LEVELS`, the phaser's cadence and pitch pair, the alert's
`FULL_THREAT`. Three to sit with first:

- the phaser at a held 6.25 shots a second — the only sound with a real chance
  of becoming fatiguing
- the alert's threat scaling — tension or nuisance, undecidable from source
- the decloak, which has to cut through a firefight without being the loudest
  thing in the game
- `hardDock`'s fm layer's `indexDecay = 0.05` — a guess at "short" against its
  own 0.3s decay, unflown like the rest; too short and the clunk loses the
  bell character entirely, too long and it drifts back toward `shieldHit`'s
  ring

**Impulse power** — `Ship.IMPULSE = 0.32` and `IMPULSE_FLOOR = 0.02`. Is
limping home at a third of thrust a mercy or a punishment?

**The jump's distance curve** — `JUMP.baseCharge = 1.4`, `JUMP.perStep = 0.35`.
This one changes combat: a hop next door is now cheaper than it was and a long
jump is dearer, with an eight-step ceiling on a full reserve. It is the change
most likely to want reverting, and nobody has flown it.

**The Warden's numbers** — visit rate (55–95s to the first, 115–195s to the
next), dwell (32s), fire rate (0.3 every 2.4s), station-keeping distance (34
units). The two that will show first are the visit rate — too often and it
stops being an event, too rarely and most runs never see one — and whether an
escort holding station 34 units off your quarter is company or clutter in a
wave-eight fight. Its comms land on the same HUD row as `WAVE 8` and
`HULL BREACH` and will sometimes step on one.

**The comet** — every constant in `COMET` (`src/game/comet.ts`), and like the
Loom's and the brace's own blocks, this is entirely reasoned about and none of
it has been flown. Led with the ones that decide whether the encounter *works
at all*, not merely how it looks:

- **`drain = 0.02`** a second, scaled by the reserve. This is the whole brake
  on camping the tail now that fire-control and cloaks are also suppressed
  there — §5 of `docs/comet.md` originally priced this alone against
  `ALTITUDE.drain`, then had to be revised once (see `comet.ts`'s own comment)
  when a deep-reserve, slow-regen refit stack made a single drain constant
  net-positive. The regen suppression added alongside it (`Ship.updateEnergy`)
  closes that at the root, but whether the *combined* cost still reads as a
  real brake rather than either a non-event or a room nobody can afford to
  enter is exactly risk 1 below, unmeasured until someone sits in the tail
  with the clock running.
- **`stripAt = 0.5`** — the interference level above which fire-control and
  cloaks treat a contact as fully *inside* rather than merely degraded. A
  plain midpoint guess (see its own comment in `comet.ts`), not derived from
  `HIDDEN_AT` (0.4) on `cloak`, which answers a different question. Too low
  and the tail strips a cloak from the doorway; too high and a player who
  looks jammed on the scanner is not actually getting the payoff yet.
- **`visualRange = 22`**, the range a hostile must close to once its lock
  fails inside the tail. Set below `PHASER.falloffStart` (26) so a fight in
  the tail reads as visibly closer than the open-sector norm — too close and
  nothing inside the tail can ever actually shoot back, which would make
  "drawn, and huntable" (§2 of the design) one-sided.
- **`fixtureChance = 0.25`** and **`wandererChance = 0.06`** — how often a run
  meets either schedule at all. These decide whether the comet is furniture
  (too common) or a curiosity nobody plans around (too rare), and they are the
  two numbers hardest to judge from a single sitting because the sample size
  *is* the number of runs played.
- **`earliest = 3`**, the escalation floor below which a wanderer never rolls.
  Lower than the Loom's 4 on the reasoning that this is an opportunity rather
  than a hazard — untested against an actual early run.
- **`fixtureLength = 170`** (`fixtureScaleJitter` ranges it 119–221) against
  **`fixtureNearRadius = 26`** / **`fixtureFarRadius = 105`**, which stayed put
  when the length came down from an original 420 (see `comet.ts`: the longer
  tail sat mostly in `Stage.ts`'s own fog range and was never visible from any
  distance a player would stand at). The radii were never re-derived against
  the new length, so the cone's own half-angle went from about 10.6° to about
  24.9° — still readable, but visibly stubbier than the design's "hundreds
  long" shape implies. Worth a look together with `fixtureLength` rather than
  assuming the length was the only number the fog range constrained.
  **`fixtureNucleusRadius = 11`** sets how big the rock itself reads at a
  distance, but it is not only cosmetic: `interferenceAt` treats the region
  sunward of the nucleus as a coma sphere of exactly this radius, so it is
  also the only part of the jamming volume that sits *ahead* of the tail —
  too small and the coma is invisible against the cone it sits in front of,
  too large and a comet jams a sphere well before the tail proper begins.
- **`fixtureRangeMin/Max` (150–230, brought in from 150–340 by the final-fix
  pass — see `comet.ts`'s own comment)** and **`fixtureDrift = 1.6`** — how far
  out a fixture sits and how fast it sweeps the sector over a run.
  **Discoverability itself is still unverified.** 230 is closer to
  `SCANNER.range` (150) than 340 was and sits inside the fog far plane with
  margin, but whether it is actually *close enough* — as opposed to merely
  closer — depends on how near the player tends to be to sector centre when
  a fixture might be found, and nothing in this codebase tracks that:
  `Session.spawnWave` recentres each wave's own spawn ring on the player's
  *current* position, not on the origin, so the player is not bounded near
  centre by anything the game enforces. A playtest assertion claiming to
  check this was cut from `tools/playtest.mjs` in the same fix pass — it
  compared `fixtureRangeMax` against `SCANNER.range` plus a hand-picked
  "combat radius" constant it defined itself, which is an arithmetic
  identity among its own numbers and could not have failed. This wants a
  human at the keyboard, flying fixtures near both ends of the band and
  judging whether they are actually found, not a further code change.
  **`wandererDuration
  = 110`**, **`wandererEntry = 260`** (together fixing the wanderer's ~4.7
  units/s crossing speed) and **`wandererLength/nearRadius/farRadius`** (190 /
  14 / 46) — all "smaller, denser, shorter" by the design's own words (§4),
  none checked against a stopwatch. **`wandererNucleusRadius = 6`** is the same
  trade as the fixture's own nucleus radius above, scaled down to match: how
  big the rock reads, and how far the coma's sphere of full interference
  reaches ahead of a tail that is itself already the shorter of the two.
- **`solidFraction = 0.65`**, **`tipFloor = 0.2`**, **`strength = 1`** — the
  shape of the fade along the tail. Reasoned against the boundary having to
  *look* interfered with (§3 of the design) rather than measured against a
  screen.
- **The plume** — `flow = 18`, `filaments = 84`, `filamentSegments = 13`,
  `filamentSpan = 0.34`, `swirl = 0.5`, `coreBias = 1.9`, and the `COMA_GLOW` /
  `COMA_REACH` pair. Cosmetic, but the block with the most flown evidence behind
  it, because two rounds of test play landed on it directly.

  The tail was 500 loose motes and read as *"a collection of vector lines"* with
  none of "the visual effect one expects from a comet". Density was never the
  problem — it had already been raised from 40 to 500 for exactly that mistaken
  reason. **Continuity was.** A mote is an isolated dash; sixty connected
  filaments streaming down the axis read as gas, which is what
  `Backdrop.buildNebula` had already concluded for the same reason.

  Two things fell out of that and both are worth knowing before touching these:
  **the coma cannot be seeded into the flow** — a density cluster near the head
  is carried down the tail by `update` and wraps, so the glow migrated instead of
  sitting on the rock; it is now computed from `along` at draw time. And the
  filament *end fades* (`FILAMENT_FADE_IN/OUT`) matter more than the count: 84
  strands with hard ends are 84 visible line-ends, which is the scatter the whole
  change was meant to remove.

  Measured at **779 segments a frame** against `TraceBuffer`'s shared 5000.
- **`COMET_COLOR`'s luminance, now 0.62, was 0.30.** Not on this list as a
  preference — it is a correction. The original obeyed `encounters.md`'s rule for
  *decoration*: lower saturation **and** lower luminance than any information
  colour. That rule was written for the sky, which nothing flies through, and
  applying it to a world object at fighting range made the plume invisible once
  `Stage.ts`'s 45..260 fog took its third. Saturation (0.20) is what actually
  keeps a colour out of the information vocabulary, since every information hue
  here is a committed one; luminance was the wrong half to borrow. The HUD wedge
  now scales the same colour *down* by 0.42, because a panel glyph is unfogged
  and has the opposite problem — if either number moves, check the other.

Three more came out of building and reviewing it, not out of the original
design, and are recorded here rather than only in code comments because they
are exactly the kind of thing a tuning session would otherwise rediscover by
surprise:

- **A frozen Shroud can sit outside its own suppressed reach.** `updateCloak`
  freezes the strike-cycle phase clock while `interference > COMET.stripAt`
  rather than letting it keep running, so a Shroud caught mid-veil at its 3.4×
  "veiling" standoff (`preferredRange * 3.4`, ~74.8 units for the class's own
  22-unit `preferredRange`) can be pinned there — outside `COMET.visualRange`
  (22), the range its own fire-control is clamped to while jammed. Whether
  that reads as "the tail parks the Shroud somewhere safe to approach" or as a
  dead zone is unflown.
- **One frame of stale `hostile.interference` on the frame a wanderer
  expires.** `Session.stepComet` zeroes the player's own reading the instant a
  wanderer's duration runs out, but a hostile's `interference` is left holding
  whatever it last read rather than corrected in the same frame — a known,
  deferred minor (see the comment in `session.ts`), imperceptible at 60fps
  but worth confirming it stays that way once the tail is actually watched
  closely at a wanderer's exit.
- **The half-angle drift** noted under `fixtureLength` above — not a bug, but
  a mismatch between two numbers that used to agree and now do not.

**The hero gas giant** — `GIANT` in `src/render/GasGiant.ts`, unflown like
`ALTITUDE`/`LOOM`/`COMET` and on the same footing, but with a wrinkle those
three don't have: it was rebuilt from scratch mid-task (`docs/environment.md`
§1.5, §8.1), so these numbers belong to the second build, not the abandoned
stroke one.

**Measured, on the machine of the day:** the shipped body draws through **2
draw calls** — the `body` mesh and the `limb` mesh — unchanged, by
coincidence rather than design, from the abandoned stroke build's own 2 (a
`VectorObject` shell's face+edge pair). `body`'s geometry is
`widthSegments: 48` × `heightSegments: 32`, down from an initial 96×64 once
colour moved into the fragment shader and tessellation only had to keep the
silhouette round. No stroke-buffer count applies to the giant's own body —
the flow band is a fragment shader, not strokes. The scratch-pad
`TraceBuffer` it once would have pushed into (`skyTrace`) was deleted from
`main.ts` for having no producer at the time this was written; **it has
since been revived** by the scenery variety pass below, for the gas
shoal, so "no stroke-buffer count" now describes only the giant and not the
sky as a whole.
**No frame-time figure was captured** on the machine of the
day; only draw calls and geometry counts were measured, which is short of
§4.4's own ask and worth closing before a detail-tier decision is made.

The levers that decide whether it works, first:

- **`flowScale: 2.2`, `latStretch: 8.0`, `flowContrast: 1.7`.** The texture
  is domain-warped noise sheared by latitude; these three decide whether
  that reads as bands at all or reverts to "one muddy mid-tone," a failure
  already found and fixed once. `flowContrast` is the late add and does the
  most single load-bearing job of the three — summed noise octaves cluster
  near the middle of their own range, and this is the only thing pushing
  values back out toward the ends.
- **`jetFreqMin`/`Max` (3-6), `shearAmpMin`/`Max` (0.5-1.0).** The shear
  that turns latitude bands into flow instead of stripes. Never flown
  against a reference beyond the report's own three fixed camera angles.
- **`ambientFloor: 0.32`**, a body-local floor replacing the borrowed
  `STAR.floor` (0.08) because a correct band pattern needs a flatter
  terminator to survive multiplication by the lit/dark swing — every other
  body in `light.ts` still uses the shared, steeper one. Worth flying
  against a real terminator sweep, not just fixed angles.
- **`limbIntensity: 1.1`, `limbDarkFloor: 0.35`, `limbDarkPower: 1.6`,
  `scatterStrength: 0.14`, `scatterPower: 3.0`.** Bloom-as-atmosphere (§3.2)
  lives entirely here; two earlier values (1.6, then 1.7) each blew the limb
  into a solid ring eating the silhouette, so this has already cost two
  rounds and is worth checking past the three seeds captured so far.
- **`rotationRate: 0.035`** rad/s — unflown, same species as `LOOM`/
  `COMET`'s own rotation constants, now driving a `uRotation` uniform rather
  than mesh rotation.
- **`range: 950`, `radius: 215`, `minRange: 550`.** Scale and leash, pulled
  back once already (from 900/260, which swallowed the HUD) — the number
  that decides whether "dominates the frame" reads as spectacle or as
  obstruction.
- **The eight palette stops** (`brightLightness` 0.9 down to
  `deepLightness` 0.28, `baseHueMin`/`Max` 27°-35°), locked to
  `assertPaletteContract()` (lightness spans at least 0.30-0.90, zone
  saturation ≤0.20, belt saturation ≥0.25, the storm alone ≥0.65) so a
  tuning pass cannot silently flatten it back to mud. **Known softness, not
  a defect:** in practice the disc reads mid-tan rather than near-white —
  `zoneLightness` (0.8) is what most pixels land on, and `brightLightness`
  (0.9), the contract's own top bound, is rarely reached, because summed
  noise octaves cluster near the middle of the flow field's own range even
  after `flowContrast`'s gain. The lightness range the eye actually sees is
  narrower than the 0.30-0.90 the contract guarantees exists in the stop
  table — the contract bounds what the palette *can* express, not what
  fraction of the disc a given seed's noise actually visits. Worth flying
  `flowContrast` next against this specifically.

**Scenery variety** — the roster, the two new bodies, the rocks field and
the shoal, all from
`docs/superpowers/specs/2026-08-14-scenery-variety-design.md`, unflown in
the same sense as everything else in this section: reasoned about, none of
it heard or played.

- **`ROSTER`** (`render/scenery.ts`) — giant 0.30, ringed 0.20, moon 0.15,
  sun 0.15, rocks 0.10, bare 0.10. The question no constant answers: **does
  the giant feel like an event yet**, at 30% and no longer an independent
  38% roll stacked on top of everything else, or does a six-way deck still
  deal the same face too often to read as a draw rather than a default?
- **`ROCKS`** (`game/session.ts`) — `grace = 7`, `damagePerSpeed = 0.02`,
  `ceiling = 0.45`, `restitution = 0.25`. The question no constant answers:
  **is a field a place you fight, or a place you die** — whether threading
  rocks under fire while trading shots reads as a hazard worth flying
  through, or a single bad line through a dense field costs more shield
  than the wave around it does.
- **`AVOID_MARGIN = 8` / `AVOID_GAIN = 2.2`** (`game/hostiles.ts`) — the
  bounded shove that keeps a hostile from clipping through a rock the
  player has to dodge. Too small and the clip still happens, which reads as
  a cheat; too large and the shove itself becomes visible, a pilot flinching
  off scenery rather than avoiding it. Steering only — hostiles never take
  rock damage, so this is entirely a legibility question, not a balance one.
- **`MOON.craterScale = 9.0`** (`render/Moon.ts`) — the Worley frequency the
  crater field reads pole to pole. What decides whether it works: whether
  nine feels like a cratered world at the moon's own screen radius (55-70%
  of the giant's, per `radiusMin`/`radiusMax`), or reads as either a smooth
  ball or a peppered one at the range the leash holds it.
- **`SUN_HERO`'s radii** (`render/SunHero.ts`) — `coreRadius = 26` against
  `range = 850`, `haloInnerScale`/`haloOuterScale` 2.2/4, streamer length
  2-5× `coreRadius`. The core is deliberately small so the halo does the
  dominating, not the sphere — the opposite emphasis from the giant's
  genuinely-scaled body — and whether that trade reads as a star or as a dim
  ball with a glow stuck on it is a keyboard question, not a geometry one.
- **Shoal density and drift** (`SHOAL` in `render/Shoals.ts`) — `chance =
  0.2`, `filaments = 120`, `filamentSegments = 9`, `driftMin`/`driftMax` =
  2/4.5. The question no constant answers: **does the curtain read as gas at
  fighting range**, the way the comet's own filament rework finally did
  after two rounds of test play, or does 120 strands at this density read as
  scatter the way the comet's first 500 loose motes did before continuity —
  not count — turned out to be the fix.

**Measured, on the machine of the day (2026-08-15)**, through
`window.__stage.renderer.info` read live against a throwaway Playwright
script (uncommitted, workspace-only) driving the dev server — the comet's
own "779 of 5000" style, but measured rather than arithmetic this time, per
§4.4's own ask:

- A `rocks`-hero sector with no shoal draws through **62 draw calls**,
  stable to the call across six sampled frames within a run and across two
  independently-seeded rocks fields, and **~12,000 triangles** (11,978 and
  12,162 measured on two seeds — the triangle swing is the field's own rock
  count varying by seed, not measurement noise; the call count does not
  move with it, which is the merged-geometry decision in §4.3 of
  `environment.md` doing its job).
- A shoal costs **exactly one more draw call**, and this one is by
  construction rather than by a clean A/B: `TraceBuffer` — the class
  `skyTrace` is an instance of — draws its entire live contents as a single
  `LineSegments` mesh regardless of segment count, the same guarantee the
  comet's own tail already relies on, so a shoal's presence can only ever
  cost one call. The live segment count behind that one call is **1080 of
  `skyTrace`'s 20000** — 120 filaments × 9 segments, by construction (no
  live counter is exposed on `Shoals` or `TraceBuffer` to read instead;
  `filaments` × `filamentSegments` is the entire computation, and it is the
  number `Shoals.ts`'s own header comment already carries).
- **Furniture noise dominates any attempt to isolate the shoal's own delta
  further.** 0-2 rock clusters plus a hulk at a 0.15 chance are rolled per
  sector independent of both the hero and the shoal, and two bare-hero,
  no-shoal sectors measured in the same run landed at 56 and 72 draw calls
  (7,082 and 11,530 triangles) purely from that roll. A single sector's
  total is not a budget on its own; the rocks-hero number above is stable
  because it was checked against six repeated frames of the *same* sector,
  not because rocks sectors are quieter than bare ones.

**Positional echo** — `ECHO`/`C_GAME` in `src/audio/sound.ts`. `range = 120`,
`maxRocks = 3`, `levelMul = 0.35`, `cutoffMul = 0.6`, `C_GAME = 340` are all
first-draft, unflown in the same sense as everything else in this section —
chosen so a 30-unit rock answers about 0.18s later, quiet and dull enough to
read as a reflection rather than a second explosion, but nobody has heard it
yet. The question no constant answers: **does a rocks field's own echo read
as "that place has texture" or as a stutter on top of an already-busy mix**
— and if it is the second, `levelMul` (quieter) and `cutoffMul` (duller) are
the two to soften before touching `range`/`maxRocks`, which are the budget
knobs rather than the character ones.

**Measured, on the machine of the day (2026-08-17)** — the budget gate the
task plan required before and after wiring the feature in, run against a
real Chromium tab (not the SwiftShader playtest harness) on the dev server,
with a genuine `AudioContext` (confirmed running, not merely constructed:
`baseLatency` 5.33ms, `outputLatency` 16ms, `sampleRate` 48000, unchanged
across every reading below). A wave-8-equivalent roster (8 hostiles spawned
via `__fleet.spawn`) stood in a forced `rocks` sector (`sound.room.name ===
"rocks"`, 36 live rocks, `sound.echoRocks` wired from the same array), and
the burst was a tight loop of `kill`/`hostileFire`/`phaser`/`torpedo`/
`impact`/`mineBlast`/`breach`/`shieldHit`/`nearMiss`/`say` calls fired
synchronously through `window.__sound` — the plan's own recipe, run for
real rather than only reasoned about:

| reading | live voices | busiest buses | fps | ctx state |
|---|---|---|---|---|
| before the burst (pre-echo) | 0 | — | 50–51 | running |
| during the burst (pre-echo, no `echoRocks`) | 29 | impact 12, weapon 7, hostile 5, radio 3, panel 2 | 50 | running |
| after (pre-echo, ~2s later) | 0 (fully reaped) | — | 50 | running |
| before the burst (post-echo) | 0 | — | 47 | running |
| during the burst (post-echo, `echoRocks` live, 36 rocks) | 36 | impact 10, **echo 9**, weapon 7, hostile 5, radio 3, panel 2 | 47 | running |
| after (post-echo, ~2s later) | 0 (fully reaped) | — | 47 | running |
| 5× repeated burst, back to back (post-echo, stress) | 26 | — | 47 | running |

Every bus held its static cap exactly (`echo` topped out at 9 voices — three
concurrent echoed events × up to three rocks each, `BUS_CAPS.echo`'s own 3
slots, fully spent and never exceeded); nothing accumulated across five
repeated bursts; every voice reaped back to 0 within two seconds; fps and
both latency figures never moved before/during/after in either the pre- or
post-echo reading; no console errors in either pass. **The ladder the plan
asked for is decided from these numbers: stay at `ECHO.maxRocks = 3`
(rung 1) — the numbers show no reason to fall back to nearest-1 or to
disable the bus outright (`ECHO.enabled`, never built, was not needed).**

This covers only what an agent can measure. **The dropout/listening half of
this gate — whether a wave-8 fight in a rocks sector actually sounds clean
on real hardware, mixer maxed, ears on — is UNMEASURED by an agent and is
the owner's to run.** The numbers above rule out the failure modes a budget
gate exists to catch (unbounded voice growth, a stuck `AudioContext`, a
starved frame rate); they cannot rule out an echo that is technically
bounded and still sounds bad.

---

## 3. Design questions — open, and not answerable by a constant

### 3.1 ~~Campaign balance: the cliff~~ Resolved, 2026-08-14

`npm run campaignlength` finds no contested band. Five steps of ground per run
gives 0% wins; six gives 93%. Capping the pressure formula turns losses into
deadlocks rather than into wins — measured, so a cap is the wrong fix.

What is missing is a **feedback term**: something that slows the enemy as it
loses ground, or speeds the player up as they gain it. That is a design answer.
See status.md §3 for the measurements before proposing one.

**Resolved.** Investigated at length in `docs/campaign-balance.md`: the
missing feedback term was real but not sufficient on its own — three
candidates were built and measured, and all three narrowed rather than
widened the contested band, for a structural reason (§4 of that document): a
war with one input, `gainGround`, can only be passed or failed, never
contested. **Candidate C, the finite invasion (`RESERVE` in
`src/chart/reserve.ts`), was adopted** — it is the only one of the three
under which the campaign's four decisions do anything at all, because a
patrol becomes permanent attrition against a finite stock rather than a
one-turn delay against a self-refilling one — and it shipped together with
its own required salvage sink, uncapped patrols. Retuned to
`regenFlat = 24`: reach 4 wins 83.4% of 1000 seeds inside 40 runs at a
median of 26, the recorded compromise between (a) a clean 30–70% contested
band, which no `regenFlat` value reaches without pushing the median past 30,
and (b) a war that mostly resolves inside a reasonable length. See
`docs/campaign-balance.md`'s "Adopted, 2026-08-14" section, including the
floor episode: the `sectorsHeldBeyondStart` zero floor that this document's
own §5 recommended deleting was restored by the owner's ruling after the
deletion was measured to collapse the enemy's whole spend to zero within two
to four runs of any player lead.

### 3.2 ~~`gainGround` wants a ruling~~ Resolved, 2026-08-14

One step per wave cleared in the sector you are standing in. It appears in
neither design document, and without it `isWon` is unreachable — so it was
invented to close the loop. Per §3.1 it is the single number the whole campaign
hangs on. It deserves a deliberate decision rather than continued inheritance.

**Resolved.** Ruled on in `docs/campaign-balance.md` §6: it stays, and it is
now documented in `strategy-layer.md` beside the enemy's own action table,
described as what it is — the mirror of `resolveIncoming`, the same
two-step ladder in the other direction, at the same price. It stays
emergent rather than becoming a constant, because fixing a number here would
replace the only place flying well pays into the war with a payout flying
cannot change. The ruling's real teeth, though: `gainGround` had to stop
being the war's *only* input, which is what candidate C's drain (§3.1 above)
and the uncapped patrol sink both now are.

### 3.3 Should a bare sector really have nowhere to bank?

The design doc's own "greed loop, one level up". It is also the one change that
could leave a player carrying a fat multiplier with nowhere to realise it —
which is either the entire point or a trap. Decide, then make §1.2 true or
delete the claim.

### 3.4 Is the patrol priced right?

200 salvage, strength 3, one in the field plus one per yard. All invented;
`strategy-layer.md` leaves them open.

### 3.5 Should fitted refits be capped?

They are not, so a rich player eventually flies all six. Each is individually a
tradeoff and the downsides do stack, but "what am I building for this run"
collapses into "everything" once 3,050 salvage is affordable.

### 3.6 Is `1 + yield` the right salvage curve?

Implemented to avoid zeroing salvage in the yield-0 home sector, but it means a
yield-3 sector pays 4× rather than the documented 3×.

### 3.7 Is mouse aim an improvement, or does it remove the reason to turn?

Turning the ship is currently how you present a fresh shield quarter. Mouse aim
decouples those, and might hollow out the defensive skill the four facings
exist to create.

### 3.8 The comet's own open risks

Carried across from `docs/comet.md` §8, written before implementation and not
yet resolved by it:

1. **The tail may be strictly better than the open sector.** The drain (§2
   above) is the brake and it is a first-draft guess like every other constant
   here. If it is too cheap, the answer to every wave becomes "go to the
   comet", and the encounter has eaten the game rather than enriched it.
2. **The wanderer may read as a second Loom.** Both are "rare thing that
   arrives at a wave break"; the wanderer is differentiated on paper by being
   an opportunity rather than a clock, but that distinction is unflown. If it
   reads as the same event, it is the half of this feature to cut.
3. **Hunting by eye may simply not be fun** with no pitch input and a 31°
   half-FOV. This is the assumption the whole design rests on and it cannot be
   settled from the source — it is the first thing to fly.
4. **Draw cost.** The tail is a per-frame stroke field on top of a post chain
   that already costs half a second a frame under software GL (see the
   headless-Chromium gotcha in §6). The playtest harness runs post disabled
   for exactly this reason, and `COMET.filaments` × `filamentSegments` has to be
   set against a real machine, not the harness. Measured at 779 segments a frame
   against a shared 5000 on a real one, so there is headroom — but the harness
   cannot tell you what that costs under post.

### 3.9 A salvage sink that scales with the war, not the front

Patrols are uncapped now, and that closes most of the gap
`campaign-balance.md` found — but only within a bound the front's own width
sets, not the reserve's: at reach 5 with patrol capacity raised to eight,
income above three hundred a run still saturates, because eight patrols
garrison an eight-sector line and cost 1,600 salvage, affordable inside a
week regardless of how much comes in (`campaign-balance.md` §5). **The
front is what bounds the sink, not the war.** Something that scales with the
war itself — its length, its reserve, the commander's own doctrine — rather
than with the chart's fixed geometry is still wanted, and it has to fit "one
currency, four decisions, no submenus" the way the patrol row already does.
No candidate proposed yet; this is the recorded gap `campaign-balance.md` §5
leaves open.

### 3.10 `HostileSpec.damageScale` is dead code game-wide

Every entry in `HOSTILE_SPECS` sets it (0.7 to 1.6, the Shroud at 0), and
nothing in the weapons pipeline reads it — `Ordnance.fire` deals the flat
module-level `BOLT` damage regardless of the firing hull's class. Found
while wiring the commander's guard (`GUARD` in §2 below): boosting
`damageScale` on a guard would have been a no-op dressed up as a buff, which
is why the guard's anvil axis boosts fire rate (`GUARD.cadence`) instead.
Wire it live — every hostile's differing `damageScale` starts actually
applying, which is a game-wide balance change, not a small one — or delete
the field and stop implying a per-class damage curve that does not exist.
Either is fine; leaving it half-declared is not a decision, it is an
oversight with a name.

---

## 4. Audio revision against the research

`docs/audio-prior-art.md` landed *after* the audio layer was built and
disagrees with it in three places. The alert pulse was partially reworked
already; these remain:

- **Escalation should add partials, not raise level.** CHI 2024, n=1,699 —
  amplification alone measurably hurt perceived competence.
- ~~**The compressor's 6 ms lookahead costs impact sync** in a game built
  around hit-stop. Either shorten it or accept the smear deliberately.~~
  **Resolved, 2026-08-16.** Already done, and done before this bullet was
  ever revisited: `Synth.build()`'s master chain has no
  `DynamicsCompressorNode` at all — a `tanh` `WaveShaperNode` limiter took its
  place, zero-latency and unable to clip, exactly the alternative
  `docs/audio-prior-art.md` §5 names. `selftest.mjs` §2 asserts it directly
  (`ok("no compressor: the 6 ms lookahead is gone", compressors === 0)`) and
  checks the shaper's transfer function against `tanh` to within `1e-3`. The
  smear this bullet worried about is gone with the node that caused it.
- **Verify the autoplay gesture path end to end.** The contract is that nothing
  sounds until a key is pressed and that the first failure retires the whole
  audio layer rather than raising in the frame loop. It has not been exercised
  against a machine with no audio device.

---

## 5. Not built, and deliberately so — revisit only if earned

- **Mouse aim** — see §3.7.
- **Leaderboards.**
- **Per-sector docking** — see §1.2 / §3.3.
- **Territorial control *during* a run** — only if the between-runs version
  earns it.
- **The exploration encounters from concept D**, seeded into empty sectors.

---

## 6. Housekeeping

### 6.1 The debug hooks are localhost-only, and it has cost real time twice

`DEBUG_PROBE` is `location.hostname === "127.0.0.1" || "localhost"`, so on the
deployed build `__probe`, `__player`, `__loom` and `__sky` do not exist at all.
Two consequences, both already paid for:

- **A live bug cannot be inspected.** When the keyboard appeared dead on the
  deployed build there was no way for either side to read the state, and the
  session was reconstructed from three local approximations instead.
- **The Loom cannot be summoned on the build being played.** It appears at a
  wave break with a one-in-ten chance from escalation index four, and
  `__loom.seed()` — the only way to see one on demand — is not there. A feature
  that rare, on a build where it cannot be forced, will never be tuned.

Two candidate answers, and this wants a decision rather than a workaround:
expose a deliberately narrow probe on the deployed build, or make the Loom a
scheduled event at a known escalation index so a run that gets far enough is
guaranteed to meet one.

### 6.2 Known flakes in `tools/playtest.mjs`

Three pre-existing checks have each been observed to fail independently,
against unmodified code, on otherwise-clean runs — recorded rather than
fixed, since none reproduces from a cold isolated run and none touches
anything any task here actually changed:

- **The brace-energy threshold** — `brace.energy >= 0.6`, missed by as
  little as 0.0003 on one observed run. Reads as timing/scheduling
  sensitivity under the harness's software-GL setup, not a logic bug.
  Documented in `task-9-report.md`.
- **The Shroud-in-comet-tail chain** — three assertions that all depend on
  the harness locating a Shroud on the board within a fixed search budget;
  when the search comes back empty, all three fail together, which is one
  flake wearing three names rather than three separate bugs. Documented in
  `task-9-report.md`.
- **"The forced win still reaches the tally," phase = `drift`** — a
  five-check cascade at the very end of the death-handoff test. Diagnosed
  in `task-9-report.md` as a timing race against a fixed ms budget under
  SwiftShader's software-GL cost, which grows as a long-lived test tab
  accumulates state over ~150 prior assertions; the wait for this one check
  was already widened there, from 20000ms to 45000ms. `task-13-report.md`
  observed it recur twice regardless, under extra load from a concurrent
  browser tab, and confirmed the same diagnosis on a clean, uncontended
  retry.

Worth a maintainer's attention if any starts failing CI intermittently, but
these are known rather than new defects, and out of scope for a docs pass to
chase down.

- `npm run typecheck` before every commit. There is no lint step.
- `npm run playtest` needs a Playwright browser and a **fresh** dev server — a
  stale one predating new files fails with `__stage` undefined. Kill it and
  clear `node_modules/.vite`.
- `src/chart/` logic modules must not import `three` or touch the DOM.
  `ChartView.ts` is the sole exception and `tsconfig.campaign.json` excludes it.
  Breaking this breaks the whole campaign test cycle.
- `Documents/` is iCloud-synced. A duplicate-symbol typecheck failure means a
  `* 2.ts` conflict copy.
