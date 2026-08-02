# The strategy layer

How empire building attaches to an arcade game without turning it into homework.
Companion to [concept-options.md](./concept-options.md); assumes the Kobayashi
run described there.

## The premise

A run is 5–10 minutes and always ends in death. An empire accretes across
sessions. Those pull in opposite directions, and the join has to be a single
mechanic rather than a bridge between two games.

That mechanic already exists: **the greed multiplier is the empire's currency.**
It climbs while you stay undocked and untouched, and it banks when you dock. So
the arcade question — *dock now at 40% shields, or push one more wave?* — is
already the strategic question, because what you're gambling is next session's
construction budget.

Nothing else gets bolted on. The strategy layer spends what the arcade layer
earns, and that is the whole integration.

## The loop

```
     ┌──────────── run ────────────┐
     │  fight → bank at starbase   │
     │  → die (always)             │
     └──────────────┬──────────────┘
                    ↓  salvage
             ┌──── chart ────┐
             │  build        │
             │  refit        │      ← four decisions, ~30 seconds
             │  deploy       │
             │  choose front │
             └──────┬────────┘
                    ↓  enemy takes its turn
                 next run
```

## Win and loss

The **run** has no win state — that stays true, and the name still means what it
means. The **campaign** does:

- **Win:** push the front off the chart entirely. The invasion is broken.
- **Lose:** your last starbase falls. Everything built is gone; the score stands.

The unwinnable test is the run. The war is winnable. That distinction is the
whole reason the two layers can coexist.

## The chart

An 8×8 grid of sectors — the 1971 geometry, reused. Each sector holds three
things and nothing else:

| Property | Values | Read as |
|---|---|---|
| Control | yours · contested · theirs | stroke colour: cyan · magenta · amber |
| Threat | 1–5 | number of ticks on the sector edge |
| Yield | 0–3 | salvage multiplier when you run there |

Threat and yield correlate: the dangerous sectors pay. That is the greed loop
again, one level up, which is the point — the same decision at three scales is
what makes a design feel coherent rather than assembled.

## Decision 1 — Build

One currency: **salvage**. No second resource, ever; two currencies means a
spreadsheet.

| Structure | Cost | Runs to complete | Effect |
|---|---:|---:|---|
| Listening post | 250 | 1 | Reveals threat and enemy movement in adjacent sectors |
| Outpost | 600 | 2 | Dock point. Refuel and rearm only — no repair |
| Starbase | 1 600 | 4 | Full dock: repair, rearm, refit. Extends your deployable range |
| Yard | 2 400 | 5 | Lets you field a second patrol, and rebuilds losses |

Construction continues while you run. It cannot be rushed with salvage — time is
the cost, and buying your way out of a wait is how build queues become the game.

A structure under construction can be destroyed. Building on the front is a
gamble; building behind the line is slow but safe. That is a real decision every
few runs and it costs us nothing to implement.

## Decision 2 — Refit

Every refit is a **tradeoff, never an upgrade**. If the ship simply gets better,
early runs become a tax you pay for having started.

| Refit | Cost | Gain | Cost to you |
|---|---:|---|---|
| Reinforced facings | 400 | +40% shield capacity | −15% regeneration |
| Torpedo racks | 350 | +6 torpedoes | −10% turn rate |
| Capacitor bank | 500 | +25% energy reserve | Phaser falloff steepens |
| Focusing coils | 550 | Phaser holds full damage to long range | +30% energy per shot |
| Ablative plating | 700 | First hull hit each run is absorbed entirely | No shield regen while hull is damaged |
| Impulse tuning | 450 | +20% acceleration | −15% maximum shields |

Refits are swappable at a starbase, not permanent. The interesting question is
*what am I building for this run*, given where I've chosen to drop — not *what
have I unlocked*.

All six map onto variables the combat model already exposes, so this table is
implementable the day the refit screen exists.

## Decision 3 — Deploy

Patrols hold sectors you are not in. Each costs salvage to field and fights
autonomously between runs, reporting back as a line of text.

- A patrol in a sector **slows enemy expansion into it** and **cannot stop a
  determined push**. It buys turns, not safety.
- Patrols take attrition. An unsupported patrol on the front dies in ~3 runs.
- A destroyed patrol is gone unless you have a Yard.

This is the cheapest thing on the list to build and does the most work: it makes
the map feel like it has other people in it without adding a single system to
the run itself.

## Decision 4 — Choose the front

Where you drop next. Higher threat pays more yield and spawns harder waves
sooner. This is the difficulty dial, in the player's hands, priced honestly.

## The enemy takes its turn

The map has to degrade when you look away, or it is a menu rather than a war.

After every run the enemy spends **pressure points**:

```
pressure = 3 + floor(runsElapsed / 4) + (sectorsLost × 0.5)
```

Spent adjacent to territory they already hold:

| Action | Cost | Notes |
|---|---:|---|
| Raise threat in a held sector | 1 | Consolidation |
| Push into a contested sector | 2 | Contested → theirs |
| Push into one of yours | 3 | Yours → contested |
| Assault a structure | 4 | Only if the sector is already theirs |

A patrol in the target sector adds +2 to the cost. A starbase adds +3.

The consequence that matters: **ignore a sector for four runs and it falls, and
it stays fallen.** Retaking ground costs more than holding it, so the map
punishes drift rather than punishing mistakes.

## The rule that keeps this an arcade game

**Into the Breach, not Stellaris.** Enforced, not aspirational:

- Four decisions per chart visit. Not four *screens* — four decisions.
- No submenus. Everything on one screen at once.
- No build queue longer than the screen.
- One currency.
- If the chart visit ever takes longer than the run, the layer has failed and we
  cut it back.

And two things it must never do: gate competence behind progression, or make a
run unwinnable because of a chart decision made twenty minutes ago.

## What this costs us to build

Cheaper than it looks, because it is a map:

- **Rendering** — reuses the whole vector pipeline unchanged. Strokes, additive
  glow, the stroke font, occluded shapes. In two dimensions the chart is the
  cheapest screen in the game and will be the best-looking.
- **Persistence** — `localStorage`, one JSON blob, a seeded RNG. No backend, no
  accounts.
- **Simulation** — the enemy turn is the table above. It is perhaps 150 lines.

Save-scumming is possible and we are not going to fight it. The run is the game;
anyone editing their save to skip it has already opted out.

## Sequencing

Combat first. An empire built on a fight that does not feel good is a strategy
layer with nothing underneath it.

1. Weeks 3–5 — combat, waves, docking, the multiplier. *(in progress)*
2. Weeks 6–8 — the chart as a tactical map, in-run.
3. Weeks 9–12 — the same chart between runs: build, refit, deploy, front.
4. Later — territorial control *during* a run, if the between-runs version earns
   it.

## Open questions

- Does the campaign need a length? An 8×8 chart at ~3 pressure per run implies
  roughly 30–50 runs to resolve, which may be too long for a first campaign.
  A 6×6 opening chart is worth testing.
- Should refits be lost on death, or persist? Losing them makes each run matter
  more and makes a bad run feel expensive. Leaning persist, test both.
- Do patrols need to be visible during a run if you drop into their sector?
  Cheap to do, and it would sell the map hard.
