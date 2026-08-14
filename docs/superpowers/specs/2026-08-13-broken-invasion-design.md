# The Broken Invasion — design

*Written 2026-08-13, approved in conversation before implementation. War story
and campaign feedback term, designed as one change because they are one change:
the finite-invasion mechanic is what makes every sentence the war story wants
to say true.*

Background: [campaign-balance.md](../../campaign-balance.md) is the measured
investigation this design adopts the recommendation of — three candidate
feedback terms built behind a switch and swept across thousands of seeds.
[strategy-layer.md](../../strategy-layer.md) holds the promises this pays:
"what you do in a run moves the war" and "the invasion is broken."
[todo.md](../../todo.md) §3.1–3.2 are the open questions this closes.

---

## 0. The owner's rulings

Taken in conversation, recorded so no section below silently reopens them.

1. **Adopt candidate C — the finite invasion — tuned for shorter wars.** Not
   as measured (contested campaigns ran 30+ runs); `regenFlat` comes down
   until a campaign fits in roughly 25 runs, accepting that the threshold
   question reopens and must be re-swept.
2. **Commanders bias the enemy turn's spending.** Not flavor-only names, not
   campaign bosses with flagships. Same budget, different texture.
3. **Victory is a deck log and epilogue.** The epitaph's mirror image, then
   the command view's existing "INVASION BROKEN" resting state.
4. **No reach instrumentation.** The Poisson model from `campaign-balance.md`
   §2a is trusted; real-play measurement waits until the shipped war feels
   wrong, if it ever does.

---

## 1. The finite invasion, adopted

### 1.1 What moves where

The `reserve` rule graduates from `src/chart/feedback.ts` into
`enemyTurn.ts` unconditionally — the exact path `feedback.ts`'s own header
prescribes: "adopting a candidate means moving its rule into `enemyTurn.ts` or
`economy.ts` unconditionally and deleting this file, not shipping the switch."

- `pressureBudget` keeps computing ambition (`base + clock + territory term`)
  and always clamps it to `floor(reserve × commit)`.
- `runEnemyTurn` always measures exhaustion on arrival, always replenishes at
  the flat rate, always deducts what was spent.
- The drain in `economy.ts` (`costPerStep` per step of ground taken) becomes
  unconditional.
- `isWon` always accepts the exhaustion clause: `exhausted >= brokenFor` wins
  the war whether or not the last square has changed colour.
- `feedback.ts` is deleted, together with the rejected `supply` and
  `entrench` candidate blocks in `enemyTurn.ts`, `campaign.ts` and
  `economy.ts`. The `Sector.entrenched` field goes with it (it was optional
  and absent in every save written by the shipped game, so nothing loads it).
  `campaign-balance.md` remains as the history of why they were rejected.
- `tools/campaignlength.mjs` retires `--feedback` (reserve is now the game;
  the other two are gone) and keeps `--tune`, retargeted at the shipped
  `RESERVE` constants — the sweep instrument must survive adoption, because
  §1.3 depends on it.

`RESERVE` itself moves to `enemyTurn.ts` beside `PRESSURE`, keeping its
docblocks — they are the record of three measured mistakes.

### 1.2 Two corrections that ride along

**The floor goes, then comes back.** Deleted 2026-08-13 on
`campaign-balance.md` §5's recommendation ("indefensible on its own terms").
Falsified by measurement the same day: unfloored, the term collapses ambition
to zero within two to four runs of any player lead, independent of any
`RESERVE` constant, so the reserve mechanic this document is about never gets
exercised. Restored 2026-08-14 by the owner's ruling — the fairness is
answered instead by `costPerStep` in `gainGround`, which already charges
retaken ground to the reserve directly, in stock rather than in ambition.

**Patrols become the salvage sink.** `patrolCapacity` stops being "one plus a
yard": the capacity check in `deployPatrol` is removed, so patrols are
repeatable at `PATROL.cost` apiece, still one per sector, still worn down by
front exposure in `wearPatrols`. The DEPLOY row the command view already has
absorbs income; no new row, no new screen, no second currency. A yard's value
shifts entirely to its existing rebuild behaviour; `patrolCapacity` and
`PATROL.baseCapacity` are deleted rather than left as dead code. That
deletion ripples, and the ripple is in scope: `command.ts`'s "NO SPARE
PATROLS" refusal and `ChartView.ts`'s "PATROLS N OF M" status line both read
the capacity and get replacement copy ("PATROLS N IN THE FIELD");
`campaignlength.mjs` retires `--patrols` (its model player deploys while
salvage allows); `campaigntest`'s two capacity assertions are replaced per
§5.

Measured honesty, carried forward from §2b of the investigation: the front's
width still bounds how many patrols are *worth* fielding, so this sink
saturates around 600 salvage a run. That residual — a sink that scales with
the war rather than the front — remains open, and this design does not
pretend to close it. It goes to `todo.md` §3 as the surviving question.

### 1.3 Tuning, stated as acceptance criteria

Constants are not specified here; the sweep finds them. Starting from the
measured `regenFlat = 22`, `costPerStep = 3`, `commit = 0.5`,
`brokenFor = 3`, adjust `regenFlat` first (down) and `costPerStep` second,
re-running `node tools/campaignlength.mjs 1000 --sweep --vary --ceiling=40`
until all three hold:

- **(a) A contested band exists at plausible skill:** some reach row between
  4 and 6 wins between 30% and 70%.
- **(b) Wars fit the owner's ceiling:** at that row, ≥ 60% of campaigns
  resolve inside 40 runs, median contested campaign ≤ ~25 runs.
- **(c) No deadlock regression:** unresolved-at-200 near zero at every reach.

The final table is recorded as a dated addendum to `campaign-balance.md`,
beside the tables it supersedes. If (a) and (b) prove incompatible — the
investigation warns lowering `regenFlat` reopens the threshold shape — (b)
wins and the compromise on (a) is recorded with the table, because ruling 1
chose shorter wars knowingly.

### 1.4 Save compatibility

`Campaign.reserve` and `Campaign.exhausted` stay optional and seeded on first
read (`reserveOf`), exactly as the candidate already does — a save written
before adoption loads unchanged and the invasion simply starts with a full
reserve. No version bump, no migration.

---

## 2. The commander

New module `src/chart/commander.ts` — logic-only, no `three`, no DOM, like
the rest of `src/chart/`, so `campaigntest` can import it in bare node.

### 2.1 Derived, never stored

One commander per war, derived from the campaign seed by the same
arithmetic-not-storage principle as `naming.ts`, using its hash: a name and a
doctrine, stable for the life of a campaign by construction, persisted
nowhere. Names come from two invented word-lists (given + family, own
universe, no genre marks — the locked decision `naming.ts` already obeys).
One commander per war; succession and flagships are future sparkle,
deliberately out of scope, and the doctrine machinery does not preclude them.

### 2.2 Three doctrines

A doctrine is a set of static weights applied inside `runEnemyTurn`'s
existing price-sort — the same budget, the same action table, the same
two-phase spend, a different preference order among affordable options:

- **The Raider** — favours cheap spread: many `push-contested`, a wide
  front, rarely masses on one square.
- **The Hammer** — favours mass: weights `push-ours` and `assault` up,
  hits structures, narrow and deep.
- **The Anvil** — favours ground held: consolidates aggressively, gives
  ground dearly, pushes late.

Mechanically: each doctrine maps action kinds to a sort-key multiplier, and
the priced list orders by `cost × weight` instead of `cost` (within each of
the two existing phases — the expansion-first split is load-bearing and
untouched). Replay safety: weights are constant per seed and the shuffle
still draws from the campaign's own generator, so `rngCursor` semantics are
unchanged.

**Balance guard:** doctrine must change texture, not difficulty. The seed
selects the doctrine, so a 1000-seed sweep already samples all three;
`campaignlength.mjs` gains a per-doctrine breakdown in its report so the
guard is checkable. Acceptance criterion (a) must hold for the pooled
result, and no single doctrine may sit outside 20–80% at the band row. A
doctrine that flunks this gets its weights flattened toward 1 until it
passes.

---

## 3. The war finds its voice

Three surfaces, all reading facts off the board, all in the house register
(clipped, uppercase, first person plural). Nothing here writes to the
campaign; every sentence is derivable from state the chart already reads —
the same contract `dispatch.ts` already keeps, which is also what keeps all
of it attract-safe.

### 3.1 Acts, derived

A pure function in `commander.ts` — `warAct(campaign)` — returns one of
three bands read off the live reserve and territory: **surge** (reserve
healthy, enemy at or beyond opening depth), **contested** (between), and
**failing** (reserve arriving low / enemy pushed well back). Derived fresh
every read, never latched, no persisted state: the copy built on it is
phrased as observation ("THEIR RESERVE STRAINS"), so a band that flickers at
a boundary is two true sentences on two evenings, not a lie. Exact
thresholds are implementation's choice, asserted in `campaigntest` at the
obvious extremes (full reserve + full territory = surge; exhausted counter
ticking = failing).

### 3.2 Deck log

`briefing.ts`'s `compose` gains:

- **Teach run only:** one stanza introducing the commander — name and
  doctrine, the doctrine stated as behaviour, not as a label: "THEIR
  COMMANDER IS <NAME>" / a per-doctrine second line in the house voice
  (Raider: "SHE SPENDS SHIPS LIKE SHOT"; Hammer: "HE MASSES BEFORE HE
  MOVES"; Anvil: "THEY PAY FOR GROUND ONCE AND KEEP IT"). Pronouns drawn
  from the seed alongside the name.
- **Every run:** one reserve-informed line in the situation stanza, by act:
  surge "THEIR SUPPLY RUNS DEEP", contested "THEIR RESERVE STRAINS", failing
  "THEY ARE SPENDING THEIR LAST". Placed with the existing "THEY HOLD N
  SECTORS" lines; the won-board guard already skips the stanza entirely.

### 3.3 Dispatches

`dispatch.ts` gains the commander's name in the committed-strike topics —
"HQ: <SURNAME> COMMITTED A STRIKE ON MORRAN 85 (D6). YOU ARE STANDING IN
IT." — and the winning/losing fallbacks become act-aware, with the failing
band saying the mechanic out loud: "HQ: THEIR RESERVE IS FAILING. EVERY WAVE
YOU BREAK NOW STAYS BROKEN." The three no-noise rules (only while engaged,
never twice on the same key, read-only) are untouched; act changes fold into
the dedup key so a change of band is news.

### 3.4 Chart

One bar of enemy strength on the command view, drawn by `ChartView.ts` from
`reserveOf(campaign) / RESERVE.max`, labelled with the commander's surname.
This is the one new element on a screen whose discipline is that nothing new
goes on it, and it is required rather than decorative: a stock the player is
supposed to be draining must be visible draining, or the whole feedback loop
is illegible. (`campaign-balance.md` names this as C's known UI cost.) It
uses committed colours only and never pulses — pulse stays reserved for
hostiles.

---

## 4. The ending

### 4.1 Victory

At the epitaph handoff in `presentation.ts`, where `isWon` already routes to
the command view: a final deck log first, played through the existing
`Briefing` class given a second compose function (`composeEpilogue`), reusing
the crawl untouched — same speed, same tones, same any-key skip, same `L`
switch. Copy read off facts the campaign actually keeps (`runsElapsed`,
sectors they still held when it broke, structures standing, the commander's
name), closing on the war's own teaching inverted:

    DECK LOG   FINAL
    THE INVASION IS BROKEN
    <SURNAME> WITHDRAWS
    <N> RUNS. THEY STILL HELD <M> SECTORS. IT DID NOT MATTER.
    THE WAVES STOPPED
    WE GO HOME

(Exact copy is implementation's, in the house voice; the shape — head,
the fact, the commander, the numbers, the inversion — is the design.) Then
the command view with its existing "INVASION BROKEN" header as the resting
state, where starting a new war already lives.

### 4.2 Defeat

`isLost` gets the four-line mirror through the same machinery — the last
starbase gone, the commander's name, the numbers — because it costs one
compose function once the victory path exists. Same routing, then the
existing "COMMAND LOST" resting state.

---

## 5. Testing

- **`campaigntest`:** commander determinism (same seed → same name, doctrine,
  pronouns); doctrine shifts the spend distribution (over many seeds, Raider
  commits more distinct push targets than Hammer, Hammer more assaults than
  Raider); reserve drains on `gainGround`, replenishes flat, exhaustion
  counts on arrival and `isWon` fires at `brokenFor`; the floor fix (enemy
  below opening depth yields ambition below base); uncapped `deployPatrol`
  accepts a second patrol with no yard and still refuses in enemy space and
  over `maxStrength`; old-shape saves (no `reserve`/`exhausted`) load and
  play; `warAct` extremes.
- **The sweep** (§1.3) is the balance evidence, recorded in
  `campaign-balance.md`.
- **`playtest`:** one assertion that the teach-run deck log contains the
  commander stanza, via `Briefing.readable()`'s existing contract.
- **`npm run typecheck`** before every commit; `src/chart/` stays free of
  `three` and the DOM.

## 6. Out of scope, explicitly

- Commander succession and flagships. The commander's one in-run appearance —
  the guard, a stat-and-name wave variant in the failing act — is specified in
  [2026-08-13-combat-experience-design.md](2026-08-13-combat-experience-design.md)
  §2.3 rather than here.
- A war-scaled salvage sink beyond uncapped patrols (open question, to
  `todo.md`).
- Backdrop/sky mood coupled to the war's act.
- Reach instrumentation (ruling 4).
- New-game-plus. Victory rests at the command view like defeat does.

## 7. Documentation to amend on landing

- `CLAUDE.md`: State section (campaign now winnable by exhaustion; the
  commander exists) and the "Next, in order" §2 entry, which this closes.
- `strategy-layer.md`: `gainGround` documented beside the enemy's action
  table (the standing ruling in `campaign-balance.md` §6), plus the reserve
  and exhaustion win.
- `campaign-balance.md`: dated addendum with the adopted constants and final
  sweep table.
- `todo.md`: close §3.1/§3.2, add the surviving sink question.
