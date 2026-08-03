# The chart — design

How Kobayashi becomes Deep Black. Companion to
[strategy-layer.md](../../strategy-layer.md), which specifies the economy this
builds; this document specifies the parts that one leaves open, and resolves
its three open questions.

Written 2 August 2026, after the mine-layer, cloaker, hit-stop, death sequence
and arcade shell landed.

---

## 1. Scope

Both halves, in one project: the **tactical chart** that exists during a run,
and the **command view** between runs where salvage is spent. The sequencing
doc treats these as weeks 6–8 and weeks 9–12; here they are one design because
they are one screen drawn twice.

They are still *built* in that order. The command view prices an economy against
a run structure, and the run structure changes the moment hyperwarp exists. The
tactical chart therefore lands complete and playable first, and the command view
is built on top of a run that has actually been flown.

## 2. Decisions taken

These resolve the open questions in `status.md` §7 and `strategy-layer.md` §Open
questions. Recorded with reasoning, because the reasoning is what stops them
being relitigated.

| Decision | Reasoning |
|---|---|
| **Hyperwarp is an escape valve, priced in multiplier** | A jump halves the multiplier — the same cost as letting something reach the hull, so the game already teaches it and it needs no explanation. Fleeing saves your ship and costs you what you came for. "No win state within a run" survives intact: runs still escalate until you die, and what you gamble is still earnings. |
| **8×8 grid, retuned pressure** | The 1971 geometry is kept. Campaign length is shortened by two constants rather than one — see §6. |
| **Refits persist through death** | Every run ends in death by design, so losing refits on death means losing them always, which makes them a tax on a guaranteed event rather than a choice. Matches the doc's stated lean. Refits are loadout, not progress. |
| **Patrols are visible in-run** | Cheap, and it sells the map. Drop into a sector holding a patrol and you fly alongside it. |
| **The chart does not pause the game** | Pulling up a map while something is shooting at you is where the escape valve costs something. It also keeps the chart an instrument the ship draws rather than a screen the game switches to, which is what keeps the no-submenus rule honest. |
| **One currency, still** | Salvage. No second resource. Restated here because building the whole layer at once is exactly when a second one creeps in. |

## 3. Architecture

```
src/chart/
  campaign.ts     state, invariants, and the only mutators
  sectors.ts      grid geometry, adjacency, index <-> coordinate
  enemyTurn.ts    pressure spending
  ChartView.ts    one renderer, two modes (tactical / command)
  persistence.ts  localStorage, versioned, migration-tolerant
  rng.ts          seeded PRNG, cursor included in the save
```

One renderer in two modes, because `strategy-layer.md` already promises the
chart "doubles as the empire screen's renderer" and this makes that literal.
Two drawing paths would drift — the in-run map would get a legibility fix the
command view never received.

`campaign.ts` exposes mutators rather than a mutable object. Three separate
things write to a campaign — the enemy turn, the four decisions, and the run
tally — and a bare object shared three ways is how invariants rot.

### State

```ts
type Control = "ours" | "contested" | "theirs";

interface Sector {
  control: Control;
  threat: number;          // 1-5, ticks on the sector edge
  yield: number;           // 0-3, salvage multiplier
  structures: Structure[]; // each carries runsRemaining while building
  patrol?: Patrol;         // strength, attrition
}

interface Campaign {
  version: number;         // persistence migrations
  seed: number;            // reproducible campaign
  rngCursor: number;       // draws taken — see §7
  runsElapsed: number;     // drives the pressure formula
  salvage: number;         // the one currency
  refits: RefitId[];       // persist through death
  sectors: Sector[];       // 64, row-major
  front: number;           // sector index the next run drops into
}
```

`Campaign` is the only thing that outlives a run and the only thing persisted.

### Integration points

Three, all narrow:

- **`session.ts`** reads the drop sector's `threat` and `yield` at run start.
  Threat sets wave escalation, yield scales salvage. It never writes to the
  campaign.
- **`docking.ts`** already banks the multiplier at the salvage-transfer stage;
  banking now also credits `campaign.salvage`. One line at the existing tally.
- **`main.ts`** owns the mode switch between flying, the tactical overlay and
  the command view — alongside the title/attract shell, which already owns the
  lifecycle.

The chart draws through `Hud`'s stroke buffer in the existing 800-unit design
space. No DOM text, no second font, and it inherits the bloom for free.

## 4. The tactical chart, in-run

Expands out of the scanner's corner into the play area at reduced opacity, so
it reads as the same instrument zooming out rather than a different screen.
Time keeps running.

**Hyperwarp is a commitment, not a button.** Hold to spin up over roughly two
seconds: you can still turn, you cannot fire, and energy drains as it charges.
Release early and the energy is spent for nothing. That window is what makes
fleeing a gamble rather than an exit.

On arrival: multiplier halved, energy low, and the destination's hostiles
already present rather than fading in.

**Fleets on a clock.** Two enemy-motion systems would double-count, so they are
one system seen twice: the between-runs pressure spend *commits* fleet
movements, and those movements *resolve* on a clock during the next run. You
watch markers cross the chart toward their targets while you fly. Reach one and
kill it and that pressure never lands.

This stays an opportunity, never an objective. Ignoring every fleet costs
territory on the campaign and never costs you the run — no fail state is added
inside a run.

**Two consequences that make the map matter:**

- **Docking is per-sector.** Outposts and Starbases exist in specific sectors,
  so a sector with neither has nowhere to bank. Flying somewhere rich and
  undeveloped means carrying a fat multiplier with no way to realise it. The
  greed loop, one level up.
- **Threat drives waves, yield scales salvage.** The difficulty dial is in the
  player's hands and honestly priced.

## 5. The command view

Reached as a run's aftermath: death → tally → chart → next run. It attaches to
whatever lifecycle the arcade shell established; it does not invent a parallel
one.

Same renderer, zoomed to fill, now interactive. Four decisions, one screen, no
submenus, in an order that reads as a sentence — spend, equip, position, go:

1. **Build** — select a sector, place a structure. Cost debits immediately;
   `runsRemaining` ticks per run. A structure under construction can be
   destroyed, and refunds nothing.
2. **Refit** — the six tradeoffs from `strategy-layer.md`, swappable, persisting
   through death. Only at a Starbase, which is what makes a Starbase worth
   1,600.
3. **Deploy** — field or reinforce a patrol. Takes attrition; gone for good
   without a Yard.
4. **Front** — pick the drop sector. Last, because it is the commitment.

## 6. The enemy turn, retuned

Doubling the pressure formula is the obvious response to "make the campaign
shorter" and it is wrong: pressure is the rate the enemy *gains*, so doubling it
mostly makes the player lose faster, which is not the same as resolving faster.
Campaign length is set by how much ground has to move.

So two constants, in one clearly-marked block:

- **`ENEMY_START_DEPTH`** — the enemy opens holding the far *N* rows rather than
  half the board. First draft: **N = 3** of 8, so 24 sectors have to be pushed
  off the edge rather than 32. Less ground to move is a shorter campaign, and
  the 8×8 geometry is preserved.
- **The pressure formula** — `6 + floor(runsElapsed / 2) + sectorsLost`,
  against the doc's `3 + floor(runsElapsed / 4) + sectorsLost × 0.5`.

Spending rules, costs, and the +2 patrol / +3 starbase modifiers are unchanged
from `strategy-layer.md`.

**Both numbers are first-draft guesses at a 15–25 run campaign.** They belong to
the same category as the flight-model constants — they cannot be validated by
reasoning. They can, however, be validated by simulation before they are tuned
by hand; see §8.

## 7. Persistence

One JSON blob in `localStorage`, versioned.

- A corrupt or absent save starts a fresh campaign rather than throwing. A
  player whose save fails to parse gets a new campaign, not a black screen.
- A version mismatch migrates if it can and resets if it cannot, saying so on
  the chart rather than silently.
- **The RNG cursor is saved with the seed.** A seeded RNG makes a campaign
  reproducible only if the draw count persists too; without it, a reload
  silently re-rolls the enemy's turn and the campaign stops being
  deterministic.

Save-scumming is possible and we are not going to fight it, per the doc.

## 8. Testing

The campaign is pure logic — the enemy turn, pressure spending, adjacency and
serialisation are functions of state with no renderer involved. They do not need
a browser.

`tools/campaigntest.mjs`, in the style of `tools/playtest.mjs`: plain node,
hand-rolled assertions, no new dependency. It asserts that pressure never
overspends its budget; that the enemy never targets a non-adjacent sector; that
a sector ignored for four runs falls; that salvage never goes negative; and that
a campaign round-trips through serialisation unchanged.

**Campaign length is validated by simulation, not by faith.** The same harness
runs a few thousand campaigns against a crude model player and reports the
distribution of campaign lengths. This does not say whether the chart is fun. It
does say whether the two constants in §6 produce the 15–25 runs they are
supposed to, which is otherwise a discovery that costs an evening.

The in-run half is covered by `tools/playtest.mjs` as usual: that hyperwarp
charges and cannot fire while charging, that arrival halves the multiplier, and
that the tactical overlay does not stop the wave clock.

## 9. Failure modes

- **No run is made unwinnable by a chart decision.** The doc's hard rule. You
  must always be able to drop somewhere and fight, holding zero sectors. Losing
  the last starbase ends the campaign cleanly rather than leaving an unplayable
  one.
- **Attract mode must never touch a campaign.** Title and attract own the
  lifecycle now, and the demo pilot runs on a throwaway campaign, never the
  player's save. The symptom of getting this wrong is an attract demo quietly
  spending the player's salvage.
- **Hyperwarp is refused while docked, dying, or already charging.** Each is a
  state where the helm is not the player's.
- **Salvage is clamped at zero by the mutators**, not by callers.

## 10. Sequencing

1. `campaign.ts`, `sectors.ts`, `rng.ts`, `persistence.ts` — state and its
   tests, no rendering.
2. `enemyTurn.ts` and `tools/campaigntest.mjs`, including the length
   simulation. Tune §6's constants against it.
3. `ChartView.ts` in tactical mode; hyperwarp; fleets on the clock. Playable,
   and flown before anything below this line is built.
4. `ChartView.ts` in command mode; the four decisions; the death → tally →
   chart handoff.

Steps 1–3 are one implementation plan and step 4 is a second. The break is
where it is because step 3 ends at something playable, and the economy in step
4 should be priced against a run that has been flown rather than one that has
been designed.

## 11. Open, deliberately

- Whether hyperwarp's two-second charge is right. A keyboard question.
- Whether the tactical overlay is legible over combat at speed, or whether it
  needs to dim the world behind it more than planned.
- Whether interception reads as an opportunity or starts to feel like an
  obligation. If the latter, the fleet markers get quieter rather than the
  mechanic getting removed.
