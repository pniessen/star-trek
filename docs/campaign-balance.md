# Campaign balance — why the cliff is a cliff

The campaign is not winnable at plausible rates and it was never a tuning
problem. `npm run campaignlength` found a threshold between five steps of
ground gained per run (0% of campaigns won) and six (93%), with nothing in
between, and capping the pressure formula was measured to turn 83% losses into
83% deadlocks rather than into wins.

This document is the investigation that followed: what makes the outcome
bimodal, what the instrument was hiding, three candidate feedback terms built
and measured across thousands of seeds, and a recommendation. Everything here is
reproducible from `tools/campaignlength.mjs` and the switch in
`src/chart/feedback.ts`; **every candidate is off in the shipped game**, and
`--feedback=none` reports the same numbers to the digit that it did before any
of this landed.

---

## 1. The mechanism

**In one paragraph.** The enemy's pressure budget is
`6 + floor(runsElapsed / 2) + max(0, theirs − 24)`. The first term is constant,
the second grows without bound and has nothing to do with the war, and the third
is a positive feedback on the enemy's own success that is *floored at zero* — so
taking ground back below the depth the enemy opened at buys the player nothing
at all, while losing ground charges them immediately. The player's rate of
taking ground is whatever their flying is worth and does not change. So two
rates race, one of them accelerating and self-reinforcing, and the crossing
point between them is an **unstable equilibrium**: above it the enemy's
territory term and its widening frontier compound into a runaway loss, below it
the enemy's frontier shrinks until it cannot place its budget at all — at reach
6 the trace shows eleven of thirteen points going unspent for want of a target —
which compounds into a runaway win. Both sides of the threshold are runaways, so
the outcome is decided in the first handful of runs and everything after it is a
formality. That repellor is what any feedback term has to act on.

Two traces, same seed, one step of reach apart. `budget` is the pressure spent
that turn; `moved` is the steps of ground the run took.

```
reach 5                                   reach 6
run theirs budget push moved              run theirs budget push moved
  1     21      6    2     5                1     21      6    2     6
  5     15      8    3     5                5     11      8    3     6
 10     11     11    5     5               10      4     11    4     6
 13      9     12    5     5               13      2     12    4     6
 15      9     13    6     5               15      0     13    0     5   WON
 20     13     16    7     5
 25     19     18    8     5
 30     26     22   10     5
 35     41     36    9     5   LOST
```

At reach 5 the player reduces the enemy from twenty-four sectors to nine by run
thirteen — 62% of the way to winning — and then the clock term overtakes them
and the collapse is monotone from there. It is not a close war that goes badly.
It is a war whose result was fixed on run one and took another twenty-two runs
to be announced.

**So the docs' diagnosis is half right.** "What's missing is a feedback term" is
true; what is also true, and matters more, is that the feedback that already
exists points the wrong way. `sectorsHeldBeyondStart` is a *destabilising* term,
and every candidate below that adds another territory-proportional term makes
the war more decided rather than less.

---

## 2. What the instrument was hiding

A length distribution was the right reading while the question was "how long".
It cannot answer "is the outcome ever in doubt" — a war decided on run one and a
war that swings look identical in a median. `campaignlength.mjs` now also
reports the trajectory (enemy-held sectors at fixed runs, over campaigns still
running), where a losing campaign turned and how far it had got first,
`--sweep` (the whole reach ladder in one command, with an explicit
contested-band verdict), `--trace=SEED`, `--economy`, and `--tune`.

Improving it produced two findings before a single rule was changed.

### 2a. Some of the cliff was the instrument

`--reach` was a flat figure per run and a real player's is nothing of the kind:
a run that dies on wave two takes no ground and a run that goes deep takes
several sectors. Reach is a distribution with a mean. `--vary` draws each run's
from a Poisson about that mean, on a generator of its own so that varying the
player cannot shift the enemy's draws.

| reach | flat: won | Poisson: won |
|---:|---:|---:|
| 4 | 0.0% | 0.0% |
| 5 | 0.0% | **13.2%** |
| 6 | 93.3% | **84.7%** |
| 7 | 99.2% | 99.6% |

The same rules with the same mean produce a two-row band once the player is
modelled as a distribution, with deadlock near zero and losses turning around
run fifteen rather than run three. **Every threshold this instrument reports at
a flat rate is sharper than the game's would be**, and the "no contested band"
finding was partly an artefact. Not entirely, though: one reach-step from 13% to
85% is a cliff with a wobble on it, and it is still `--reach` deciding the war
rather than anything the player does at the chart. Every measurement below uses
`--vary`.

### 2b. The chart does not participate in the war

`--economy` sweeps salvage banked per run at a fixed reach. At reach 6, 500
seeds a row, shipped rules:

| take/run | 0 | 300 | 600 | 1200 | 2400 | 6000 |
|---|---:|---:|---:|---:|---:|---:|
| won | 78.2% | 85.2% | 83.6% | 83.0% | 83.8% | 83.8% |
| structures at the end | 0.8 | 5.9 | 5.8 | 5.8 | 5.8 | 5.8 |

Twenty times the income is worth nothing, because the model player has already
bought everything there is to buy at three hundred a run. Patrol capacity is one
plus a yard; structures are one to a sector; the list runs out. **Salvage has no
sink**, so the four decisions the command view offers cannot change the outcome
of the war they are about, and the war has exactly one input: how much ground a
run takes.

This reframes the whole problem. No feedback term acting on the enemy can make
the chart matter, because the term is on the wrong side of the ledger.

`--patrols=N` overrides the capacity so the obvious reply can be tested
directly: **give salvage a sink and does the chart start deciding wars?** Under
the shipped rules, barely. At reach 5 with capacity raised to eight, wins go from
11.0% at `take=0` to 18.6% at 300 and then flat again — because the model player
only garrisons the front line, the front line is eight sectors wide, and eight
patrols cost 1600 salvage, which three hundred a run affords inside a week.
Uncapping the patrol does not uncap the sink; the front's width does that. A sink
is necessary and, on its own, nowhere near sufficient.

---

## 3. The candidates

Three terms, genuinely different in kind: one acting on the enemy's rate, one on
the player's rate, one giving the war a stock rather than a flow. Each lives in
`src/chart/feedback.ts` behind a name, is entirely contained in blocks guarded
by `feedbackOn("…")`, and is off unless `tools/campaignlength.mjs` turns it on.

### A — Supply lines

**Mechanism.** The invasion is supplied from the space it occupies, so
everything it spends — escalation included — scales with the ground it holds.
No floor at the depth it opened with and no free clock:
`round((base + clock) × theirs / 24)`.

**Fiction.** The plainest of the three, and the player can read it off the chart
they already have: the command view reports what the enemy bought, so "they did
less this turn because I took PELLAS 47 last run" is a sentence the screen can
nearly say already.

**Cost.** Four lines. The cheapest candidate by a distance.

**Measured**, 1000 seeds a row:

| reach | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---:|---:|---:|---:|---:|---:|
| won | 0.0% | 6.9% | **84.3%** | 99.7% | 100% | 100% |
| unresolved | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

**Verdict: it moves the cliff and narrows the band**, from two rows to one. This
is the failure the brief names, and it is worth having measured rather than
argued: scaling the enemy's budget with its territory is still an *increasing*
function of its territory, so it accelerates a winning invasion and decelerates a
losing one and both runaways get faster.

It is not worthless. Deadlocks fall to zero at every reach, and it fixes a real
asymmetry on its own terms — under the shipped formula, pushing the enemy below
its starting depth is literally free for them, because the territory term is
floored there. **Whichever candidate is adopted, that floor should go.**

### B — Entrenchment

**Mechanism.** Budget the enemy cannot spend advancing, it spends digging in,
and dug-in ground has to be broken before it will move. The board was already
almost running this: `runEnemyTurn` spends expansion first and consolidate with
what is left, consolidate raises threat, threat caps at five, and the enemy's own
two back rows open at five — so a losing invasion currently throws most of its
budget away. Here it puts it into the ground instead, capped at three clears a
sector.

**Fiction.** They are dug in. The feedback runs the right way by construction:
the further the player pushes, the fewer targets the enemy has, the more surplus
it has to fortify with, and the more each remaining sector costs. It slows the
player exactly when they are winning and does nothing while they are losing —
which is the sign the shipped formula has backwards.

**Cost.** One optional field on `Sector`, two hunks in `enemyTurn`, one in
`gainGround`. It is perceivable on a channel the chart already owns: a second
row of ticks on the sector edge, and in the run, waves you clear that do not move
the sector yet. **It needs a third line in `Session`** — "SECTOR TAKEN" fires on
any truthy `gainGround` and would otherwise claim ground that was not taken.

**Measured:**

| reach | 4 | 5 | 6 | 7 | 8 |
|---|---:|---:|---:|---:|---:|
| won | 0.0% | 0.2% | **17.7%** | **81.4%** | 99.0% |
| unresolved | 0.0% | 0.0% | 3.2% | 6.5% | 0.8% |
| loss turned at run | 7.7 | 11.2 | 14.9 | **23.1** | 20.8 |

**Verdict: it moves the cliff up a step and makes contested wars last twice as
long** — losses inside the band now turn around run 23 rather than run 18, and
the median campaign at reach 6 is 60 runs — but the band is the same two rows
wide. It buys liveness, not doubt.

### C — The invasion is finite

**Mechanism.** The enemy has a reserve rather than an allowance. It is
resupplied at a **flat** rate from beyond the chart, it never commits more than
half of what it holds, everything it spends comes out of it, and — the part
neither other candidate has an equivalent of — **fighting drains it**: every step
of ground a run takes costs the invasion strength it has to make back. An
invasion with nothing left for three consecutive turns is *broken*, and that is a
win whether or not the last square has changed colour.

**Fiction.** An invasion fleet with a rear, not a spawner. It surges, you weather
the surge, and then it is quiet — and the quiet is the window. `strategy-layer.md`
already writes the win as "push the front off the chart entirely. **The invasion
is broken**"; this makes the second half of that sentence a rule rather than a
gloss on the first.

**Cost.** The most of the three: two optional fields on `Campaign`, a second
clause in `isWon`, and replenishment and drain in `runEnemyTurn` and
`gainGround`. It also wants one bar of enemy strength on the chart, which is a
new thing on a screen whose whole discipline is that nothing new goes on it.

Three things it cost to get right, each measured, each wrong in its first draft:

- **Replenishment proportional to held ground reproduces exactly the amplifier
  that makes the shipped campaign bimodal.** It is flat for that reason, and
  `regenPerSector` is left in place at zero as the knob that demonstrates it.
- **Spending everything every turn** degenerates the stock into the flat cap
  that was already rejected, and makes "empty" stop meaning beaten — an invasion
  overrunning you empties itself doing it, and the first build declared victory
  on run twelve of a campaign the player was losing. Hence `commit = 0.5`.
- The threshold sits at `regenFlat / (2.4 + costPerStep)` steps of ground a run,
  which is how 22 and 2 were arrived at rather than guessed.

**Measured:**

| reach | 3 | 4 | 5 | 6 | 7 |
|---|---:|---:|---:|---:|---:|
| won | 0.0% | 0.0% | **41.8%** | 99.9% | 100% |
| lost | 100% | 79.3% | 0.3% | 0.0% | 0.0% |
| unresolved | 0.0% | **20.7%** | **57.9%** | 0.1% | 0.0% |
| loss turned at run | 5.2 | 10.0 | 31.0 | 33.0 | — |

**Verdict: it removes the amplifier and pays for it in deadlock.** Reach 5 is
genuinely undecided — and it is undecided for thirty-one runs, by far the
liveliest row anything here produced — but 58% of those campaigns never resolve
inside two hundred runs, which is the cap's failure mode returning in a new coat.
By the strict test it produces no contested band at all.

Combining it with entrenchment (`--feedback=reserve+entrench`) moves the whole
picture up two reach steps and makes the deadlock worse: 96.8% unresolved at
reach 5, 51.7% at reach 6.

---

## 4. Why none of them widened the band, and why that is a finding

Three candidates, three kinds of mechanism, and the contested band is one or two
rows wide in every one of them. That is too consistent to be three coincidences.

**First: the reach axis cannot carry a wide band, for a reason no design change
can touch.** A campaign resolves in fifteen to forty runs, and its outcome
depends on the *mean* reach over all of them. With reach Poisson about 6 over
seventeen runs, the standard error of that mean is `sqrt(6/17) ≈ 0.6` — so the
realised average concentrates within about ±0.6 of the nominal, and a band one
integer step wide is exactly what the law of large numbers permits. **Sweeping
reach measures how good a player has to be, not how uncertain a war is.** A
2-row band means "a player at 5.5 has a real contest and a player at 4 or 7 does
not", which is a narrow but not absurd answer, and it is not the thing the
original complaint was actually about.

**Second, and this is the real trap: the three properties wanted are in tension,
two at a time.**

- Remove the enemy's escalation and you remove the *ratchet that makes wars end*.
  Measured three separate ways now — the original pressure cap (83% deadlock),
  the reserve with flat resupply (58% at the balance row), and reserve plus
  entrenchment (97%). A war with no drift sits at the balance point forever.
- Make the enemy's rate depend on its territory and you get an amplifier that
  narrows the band (supply, measured).
- Slow the player at the endgame and wars get longer but no less predetermined
  (entrenchment, measured).

The clock term `floor(runs / 2)` is simultaneously the cause of the cliff and the
only reason any campaign resolves. That is the actual shape of the problem, and
no single constant and no single feedback term is going to satisfy both.

**Third — and this is where the answer is.** All three candidates act on the
enemy, and §2b showed the enemy is not the part that is broken. The war has one
input: `reach`. Salvage above three hundred a run buys nothing, so the command
view is decoration and the campaign is a pure skill threshold with a threshold's
shape. **A war with one input cannot be contested; it can only be passed or
failed.** Give the player a second input that they control at the chart, and the
outcome at a fixed reach stops being determined — which is the only thing that
ever produces genuine doubt, and it is a change to the player's side of the
ledger, not the enemy's.

---

## 5. Recommendation

**Adopt candidate C, the finite invasion — but not on its own, and not yet.**

Its case is not the band width, which is bad. Its case is that it is the only
one of the three that changes what the war is *about*:

1. **It makes the run the weapon.** `strategy-layer.md` promises that what you
   do in a run moves the war, and the only thing in the game that does is
   `gainGround`. Under C, every wave you clear costs the invasion something
   whether or not the sector changes colour, so holding a line you cannot
   advance is still winning the war.
2. **It supplies the victory that a cap lacked.** The measured objection to
   capping pressure was that losses became deadlocks; a cap removes the defeat
   and offers no win. Exhaustion is the win, and the design document already
   uses those words.
3. **It is the only one under which salvage does anything, and that is
   measured.** A patrol adds +2 to a push. Against a budget that regrows next
   turn regardless, that is a one-turn delay — O(1) defence against O(runs)
   pressure, exactly as `status.md` §3 says. Against a *finite stock*, the same
   +2 is permanent attrition. At reach 5 with patrol capacity raised to eight:

   | take/run | 0 | 300 | 600 | 1200 | 6000 |
   |---|---:|---:|---:|---:|---:|
   | shipped rules, won | 11.0% | 18.6% | 19.2% | 18.4% | 20.0% |
   | finite invasion, won | 34.8% | 43.8% | **51.0%** | 52.0% | 49.6% |

   Under C the economy is worth sixteen points of win rate and keeps paying up
   to six hundred a run; under the shipped rules it is worth seven and stops at
   three hundred. Defence stops being a delay and becomes damage. **This is the
   only route found here by which the four decisions come to matter at all**,
   and it is the strongest argument for C by some distance — stronger than
   anything in its own win-rate table.

**And it must ship with a salvage sink**, or the deadlock rows stay and the
chart stays half-decorative. The cheapest sink that respects "one currency, four
decisions, no submenus" is to make **patrols repeatable rather than capped** —
lift `patrolCapacity` from "one plus a yard" to something salvage buys, so the
existing DEPLOY row absorbs income and converts it into enemy attrition. No new
row, no new screen, no second currency: one decision the player already has,
given a reason to keep taking it. Note the measured caveat from §2b, though —
uncapping the patrol does not uncap the sink, because the front's width bounds
how many are worth fielding. Something that scales with the *war* rather than
with the front is still wanted, and I do not have a candidate for it that
survives "no submenus".

Two smaller things to take regardless of which candidate wins:

- **Delete the `max(0, …)` floor in `sectorsHeldBeyondStart`.** Retaking ground
  below the enemy's opening depth is currently free for them, which is
  indefensible on its own terms.
- **Keep `--vary` on in every future measurement.** A flat-reach model
  overstates every threshold it reports.

### What would make me wrong

- **If the real distribution of steps-per-run turns out to be tight.** The whole
  case rests on reach being a distribution. If flying the game shows a
  competent player reliably takes 5–6 steps every run with little spread, the
  band narrows again and none of this helps. Nobody has measured it (see §6).
- ~~**If the deadlock rows are not actually deadlocks in play.**~~ **Measured,
  and it goes the other way.** A campaign "unresolved at 200 runs" looked like a
  modelling artefact for a player who would have stopped at 40, so I expected
  `--ceiling=40` to convert deadlocks into honest defeats and flatter C. It
  does the opposite: at forty runs C reports 100% unresolved at reach 4 and
  74% at reach 5, because the wars it produces are genuinely slow rather than
  genuinely stuck. **C's cost is campaign length, and it is a real cost, not an
  artefact.** If a campaign has to fit in twenty-five runs, C as tuned does not
  fit and `regenFlat` has to come down until it does — which reopens the
  threshold question rather than settling it.
- ~~**If a salvage sink alone fixes it.**~~ **Measured: it does not.** Shipped
  rules with patrol capacity at eight move reach 5 from 11% to 20% and saturate
  at three hundred salvage a run. The economy is not the whole answer either;
  it is the half of the answer nobody had looked at.
- **If the owner wants the campaign decided by skill.** "You have to fly at this
  standard to win the war" is a legitimate arcade position, and it is what the
  game currently implements. If that is the intent, the only defect is that the
  threshold sits at an unknown place relative to real play, and this whole
  document reduces to §6.

---

## 6. Ruling on `gainGround`

**It stays, and it goes in the design documents.** Both `strategy-layer.md` and
`status.md` promise a winnable war and neither specifies the one function that
makes `isWon` reachable. A promise kept by an undocumented mechanic invented
mid-implementation is the most load-bearing thing in the strategy layer sitting
in the one place nobody will look. It belongs in `strategy-layer.md` beside the
enemy's action table, described as what it is: the mirror of `resolveIncoming`,
the same two-step ladder in the other direction, at the same price.

**It should not become a constant, and it is not one now.** "One step per wave
cleared in the sector you are standing in" is a rule; the resulting *rate* is
emergent, and the instrument's `--reach` is a model of it, not a setting. Fixing
a number here would be replacing the only place where flying well pays into the
war with a payout that flying cannot change — which would be worse than the
current problem, not better.

**But it must stop being the war's only input, and that is the real ruling.**
Everything above traces back to one structural fact: `gainGround` is the sole
channel from play into the campaign, so the campaign's outcome is a threshold on
one variable and has a threshold's shape. Candidate C's drain is a second
channel from the same source; an uncapped patrol is a second channel from the
chart. The layer needs at least one of them.

**And the number nobody has measured is the number everything depends on.** The
plausible range is worth stating because it is alarming: `gainGround` moves a
sector two steps at most and refuses a third, so a run's reach is
`2 × sectors visited`, and a run visiting two to three sectors — which is what
the hyperwarp energy budget allows, per `status.md` §3 — yields **four to six
steps**. The measured threshold is between five and six. **The plausible range
straddles the cliff**, which is exactly why the campaign reads as "not winnable
at plausible rates" rather than as obviously broken in either direction.

So the highest-value next action is not a design change at all: **instrument
`Session` to count successful `gainGround` calls per run, play twenty runs, and
report the distribution.** It is an afternoon, it costs nothing, and every number
in this document is conditional on it.

---

## Reproducing everything here

```
npm run campaignlength                                   # shipped rules, as before
node tools/campaignlength.mjs 1000 --sweep --vary        # the ladder, and the band verdict
node tools/campaignlength.mjs 500 --economy --reach=6 --vary
node tools/campaignlength.mjs --trace=1 --reach=5        # one war, run by run
node tools/campaignlength.mjs 1000 --sweep --vary --feedback=supply
node tools/campaignlength.mjs 1000 --sweep --vary --feedback=entrench
node tools/campaignlength.mjs 1000 --sweep --vary --feedback=reserve
node tools/campaignlength.mjs 1000 --sweep --vary --feedback=reserve --tune=reserve.regenFlat=26
node tools/campaignlength.mjs 500 --economy --reach=5 --vary --patrols=8 --feedback=reserve
node tools/campaignlength.mjs 1000 --sweep --vary --feedback=reserve --ceiling=40
```

`--feedback=none` is the default and is the shipped game. Adopting a candidate
means moving its rule into `enemyTurn.ts` or `economy.ts` unconditionally and
deleting `feedback.ts` — the switch is scaffolding for this measurement and is
not something to ship.

---

## Adopted, 2026-08-14

`--feedback` is retired. Candidate C graduated to the shipped rule the day
after this document's §5 recommended it (`6f37cdf`), patrols were uncapped
into its salvage sink the same week (`8b0f11e`), and this section is the
retune that followed — the reserve is not a candidate being measured against
`--feedback=none` any more, it is the game, and every command below runs on
shipped code.

### The floor episode

§5's recommendation carried a second, smaller instruction along with
adopting candidate C: **delete the `max(0, …)` floor in
`sectorsHeldBeyondStart`**, on the grounds that retaking ground below the
enemy's opening depth was free for them and that was "indefensible on its
own terms." That deletion shipped 2026-08-13 in the same commit that
graduated the reserve to a rule.

Measurement falsified the combination before this retune got underway.
Unfloored, `sectorsHeldBeyondStart` goes sharply negative the instant the
player leads at all — and at reach ≥ 3 that is almost immediately — which
drives `ambition` (`PRESSURE.base + clock + sectorsHeldBeyondStart`) to zero
within two to four runs and keeps it there, independent of every `RESERVE`
constant:

| regenFlat | 0 | 10 | 22 (then-shipped) | 30 | 200 | 500, commit=1, max/initial=1000 |
|---:|---:|---:|---:|---:|---:|---:|
| reach 4 won | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| reach 4 median | 3 | — | 12 | — | — | 13 |

(300–1000 seeds per cell, `--vary --ceiling=40`; full sweep in the prior
BLOCKED section of this task's report.) A traced reach-4 campaign showed the
mechanism directly: budget went `4 → 2 → 1 → 0` by run four and never
recovered, and the rest of every such campaign was pure territorial
arithmetic — the reserve this whole document is about was never once
exercised at any reach a competent player produces. That is not a tuning
problem `regenFlat` can reach; `min(ambition, reserve × commit)` is bounded
by `ambition`, and no reserve constant raises a term that is stuck at zero.

The owner ruled 2026-08-14: **restore the floor.** The fairness argument
behind the deletion is answered a different way, one this document's own
mechanism section (§ "The invasion is finite") already names — `costPerStep`
in `gainGround` charges every retaken sector to the reserve directly, in
*stock*, whether or not the sector is below the enemy's opening depth.
Deep pushes already cost the invasion something; the floor and the drain
were never in tension, only the floor and the *ambition* term were, and
ambition has no memory between turns for the drain to compound against. The
floor is back in `enemyTurn.ts`; the outer `Math.max(0, …)` around the whole
ambition sum is now redundant (the term is floored on its own) and was
removed.

### Baseline, floor restored, before this retune (regenFlat=22, costPerStep=3)

`node tools/campaignlength.mjs 1000 --sweep --vary --ceiling=40`:

```
reach    won     lost   unres   median   deepest   turns at
    1    0.0%   58.8%   41.2%      39      22.4        2.4
    2    1.0%    0.0%   99.0%      40      19.6        6.3
    3   30.1%    0.0%   69.9%      40      13.2       17.7
    4   90.8%    0.0%    9.2%      23       3.3       31.5
    5   99.4%    0.0%    0.6%      14       1.0       19.2
    6   99.6%    0.0%    0.4%      10       1.3       15.0
    7  100.0%    0.0%    0.0%       7       0.0        0.0
    8   99.9%    0.0%    0.1%       5       1.0       11.0
   10  100.0%    0.0%    0.0%       4       0.0        0.0
```

With the floor back, the picture is unrecognisable from the pre-restoration
table above: `ambition` no longer collapses, so the clock's escalation is
felt for the whole war instead of the first three runs, and reach 4 lands at
90.8% — close to a contested band, not saturated at 100%.

### Iterating `regenFlat`

Reach 4 is the only row in the 4–6 window that moves at all across a
reasonable `regenFlat` range; 5 and 6 stay at 98–100% throughout (the board
is small enough, and reach 5–6 fast enough, that the clock never gets a
chance). Reach 4, 1000 seeds a row, `--vary --ceiling=40`, `costPerStep`
unchanged at 3:

| regenFlat | 22 | 23 | 23.5 | 24 | 24.5 | 25 | 26 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| won | 90.8% | 87.3% | 85.9% | 83.4% | 78.5% | 64.1% | 57.0%* |
| unresolved (≤40) | 9.2% | 12.7% | 14.1% | 16.6% | 21.5% | 35.9% | 43.0%* |
| median | 23 | 24 | 25 | 26 | 27 | 33 | 37* |
| won, uncapped (≤200) | — | — | — | 100.0% | — | 100.0% | — |

\* 300-seed triage figure; the row was not needed for the final adoption.

This is criterion (a) and (b) in direct conflict, not a case either side of
it: the moment `regenFlat` pushes reach 4's win rate into the 30–70% band
(around 25–26), the median jumps to 33+ — genuinely undecided wars are slow
ones, the same finding §3's candidate-C writeup made about its own balance
row ("undecided for thirty-one runs"). Below that, keeping the median at
~25 pins the win rate at 83–91%, comfortably outside the band. Raising
`commit` alongside `regenFlat` was tried as an escape (a bigger fraction
spent per turn should resolve wars faster) — it does, but only by making the
war easier at the same time (commit=0.65, regenFlat=25: 94.7% won, median
25) rather than by widening the band. `costPerStep` was tried too, in the
other direction: raising it does not widen the band, it erases it —
`costPerStep=4`+ pushes reach 4 to 94%+ won at every `regenFlat` tested,
because the exhaustion win starts firing before the territorial one is ever
in doubt.

**Criterion (b) wins per the owner's ruling.** `regenFlat=24` is adopted: it
is the value closest to the 30–70% band whose median does not clear it by
more than the criterion's own tolerance (26 against "≤~25"), and it is the
last point before the median starts climbing sharply. `costPerStep` is
unchanged at 3 — every value tried either did nothing (below 3, the
territorial win already dominates) or erased the band (above 3).

### Final sweep, adopted constants (regenFlat=24, costPerStep=3), 1000 seeds a row

`node tools/campaignlength.mjs 1000 --sweep --vary --ceiling=40`:

```
reach    won     lost   unres   median   deepest   turns at
    1    0.0%   77.8%   22.2%      38      22.4        2.4
    2    0.5%    0.0%   99.5%      40      19.6        6.3
    3   20.7%    0.0%   79.3%      40      13.8       14.2
    4   83.4%    0.0%   16.6%      26       4.2       28.8
    5   98.9%    0.0%    1.1%      15       1.0       21.5
    6   99.6%    0.0%    0.4%      11       1.5       13.8
    7  100.0%    0.0%    0.0%       8       0.0        0.0
    8   99.9%    0.0%    0.1%       7       1.0       11.0
   10  100.0%    0.0%    0.0%       4       0.0        0.0

CONTESTED BAND at reach 4 — 1 of 9 rows.
```

`node tools/campaignlength.mjs 1000 --sweep --vary` (uncapped, ceiling=200):

```
reach    won     lost   unres   median   deepest   turns at
    1    0.0%  100.0%    0.0%      38      22.4        2.4
    2    1.4%   98.6%    0.0%      73      19.6        6.2
    3   69.5%    3.7%   26.8%      92      13.5       19.7
    4  100.0%    0.0%    0.0%      26       0.0        0.0
    5  100.0%    0.0%    0.0%      15       0.0        0.0
    6   99.9%    0.0%    0.1%      11       1.0       17.0
    7  100.0%    0.0%    0.0%       8       0.0        0.0
    8  100.0%    0.0%    0.0%       7       0.0        0.0
   10  100.0%    0.0%    0.0%       4       0.0        0.0
```

Both tables reproduce exactly against the constants shipped in
`src/chart/reserve.ts` — run without `--tune`, they are the same numbers.

### Which criteria bound

- **(a) some reach row in 4–6 wins 30–70%: does not hold cleanly.** Reach 4
  is the closest row, at 83.4% — outside the band. No `regenFlat` value puts
  it inside the band without failing (b); see the iteration table. This is
  the recorded compromise the owner's ruling anticipated.
- **(b) ≥60% resolve inside 40 runs, median ≤~25: holds, at the edge of its
  own tolerance.** Reach 4 resolves 83.4% inside 40 runs (comfortably over
  60%) at a median of 26 — one run over the stated "~25", and the closest
  approach to the band that does not clear it further. This criterion is
  what regenFlat=24 was chosen to satisfy, per the owner's ruling that it
  wins conflicts with (a).
- **(c) unresolved-at-200 near zero: holds at every reach in the working
  range (4 and up — 0.0%, 0.0%, 0.1%, 0.0%, 0.0%, 0.0%), and does not hold at
  reach 2–3** (0.0%, 26.8%). Reach 3 sits just below the contested row and is
  itself a slow, marginal fight — a player flying worse than reach 4 can
  produce a campaign that neither side finishes for a long time. It is not
  the row this task tunes for, and is recorded here rather than chased,
  since narrowing it (§4 of this document already found) trades directly
  against (a) and (b) the same way reach 4 does.

### Reproducing this section

```
node tools/campaignlength.mjs 1000 --sweep --vary --ceiling=40
node tools/campaignlength.mjs 1000 --sweep --vary
node tools/campaignlength.mjs 1000 --sweep=4 --vary --ceiling=40 --tune=reserve.regenFlat=23.5
node tools/campaignlength.mjs 1000 --sweep=4 --vary --ceiling=40 --tune=reserve.regenFlat=25
node tools/campaignlength.mjs --trace=1 --reach=4 --ceiling=40
```
