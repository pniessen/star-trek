# The Broken Invasion + Combat Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the campaign winnable and contested (the finite invasion), give the war a named opponent and a voice, give it an ending, and make combat's central skills legible in the world — per the two approved specs.

**Architecture:** The reserve mechanic graduates from `feedback.ts` into the shipped chart logic; a new seed-derived `commander.ts` reweights the enemy turn and feeds copy in `briefing.ts`/`dispatch.ts`/`ChartView.ts`; the ending reuses the `Briefing` crawl. Combat additions are `TraceBuffer` transients plus bounded steering/state changes in `hostiles.ts` and `session.ts`.

**Tech Stack:** TypeScript + three.js (Vite). Tests: `npm run campaigntest` (bare node via `tsc -p tsconfig.campaign.json`), `npm run audiotest`, `npm run playtest` (Playwright), `npm run campaignlength` (simulation instrument), `npm run typecheck`.

**Specs:** [2026-08-13-broken-invasion-design.md](../specs/2026-08-13-broken-invasion-design.md), [2026-08-13-combat-experience-design.md](../specs/2026-08-13-combat-experience-design.md).

## Global Constraints

- `src/chart/` modules must not import `three` or touch the DOM (`ChartView.ts` is the sole exception). Breaking this breaks `campaigntest`.
- `npm run typecheck` before every commit. No lint step exists.
- Colour is information: no new hue anywhere. Cyan is ours; each hostile class owns its hue; amber is alert. Bodies/effects never pulse — pulse stays reserved for hostiles' behaviour.
- Transient strokes go through `TraceBuffer` (combat buffer `trace` in `main.ts`, not the scenery `skyTrace`).
- Everything decays/accumulates on `dt`. Hit-stop is the only thing that scales game time, via the existing bounded `HitStop`.
- Audio: every cue goes through `Synth` via `sound.ts`, may never throw, never starts before a user gesture.
- No new keybindings, no new screens, no second currency, no persisted display settings. The only persisted object stays `kobayashi.campaign`.
- Copy is own-universe: no genre marks, uppercase clipped register, first person plural for our side.
- Save compatibility: `Campaign.reserve`/`Campaign.exhausted` stay optional, seeded on first read. Old saves must load unchanged.
- `Documents/` is iCloud-synced: a duplicate-symbol typecheck failure means a `* 2.ts` conflict copy — delete it, don't debug it.
- The working tree has an uncommitted `src/render/GasGiant.ts` change (the environment branch's in-flight work). Never `git add -A`; stage files by name.

---

## Phase A — the finite invasion (chart core)

### Task 1: Graduate the reserve; delete the candidate switch

**Files:**
- Modify: `src/chart/enemyTurn.ts` (move `RESERVE` in; unconditional reserve; floor fix; delete supply/entrench blocks)
- Modify: `src/chart/campaign.ts` (unconditional exhaustion win; drop `entrenched`; drop feedback import)
- Modify: `src/chart/economy.ts` (unconditional drain in `gainGround`; delete entrench block)
- Delete: `src/chart/feedback.ts`
- Modify: `tools/campaignlength.mjs` (retire `--feedback`; retarget `--tune`)
- Modify: `tools/campaigntest.mjs` (replace candidate-era tests)
- Test: `tools/campaigntest.mjs`

**Interfaces:**
- Produces: `RESERVE` exported from `src/chart/enemyTurn.ts` (same keys as today: `initial`, `regenFlat`, `regenPerSector`, `max`, `commit`, `costPerStep`, `brokenFor`), still a mutable object so the instrument can tune it. `reserveOf(campaign)` unchanged. `isWon(campaign)` now returns true when `(campaign.exhausted ?? 0) >= RESERVE.brokenFor` with no switch.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

In `tools/campaigntest.mjs`, find and delete the tests that call `setFeedback` (search for `setFeedback` and `feedback`), then add in their place (using the file's existing `check(name, condition, detail)` helper and its existing imports from `.campaign-build/`):

```js
// ── the finite invasion, shipped ──
import { RESERVE, pressureBudget, reserveOf, runEnemyTurn } from "./.campaign-build/chart/enemyTurn.js";
import { gainGround } from "./.campaign-build/chart/economy.js";

{
  const c = newCampaign(7);
  check("a fresh campaign reads a full reserve", reserveOf(c) === RESERVE.initial,
    `reserve=${reserveOf(c)}`);

  // Ground taken drains the reserve, unconditionally.
  const before = reserveOf(c);
  // front row of enemy ground: any sector with control "theirs"
  const target = c.sectors.findIndex((s) => s.control === "theirs");
  gainGround(c, target);
  check("gainGround drains the reserve", reserveOf(c) === before - RESERVE.costPerStep,
    `reserve=${reserveOf(c)} expected=${before - RESERVE.costPerStep}`);

  // The budget is clamped by the committed share of the reserve.
  c.reserve = 4;
  check("budget is clamped by the reserve",
    pressureBudget(c) <= Math.floor(4 * RESERVE.commit),
    `budget=${pressureBudget(c)}`);
}

{
  // Exhaustion, measured on arrival, wins the war.
  const c = newCampaign(11);
  c.reserve = 0;
  const rng = makeRng(11, 0);
  for (let i = 0; i < RESERVE.brokenFor; i++) {
    c.reserve = 0;                 // the player kept draining it between turns
    runEnemyTurn(c, rng);
  }
  check("an empty reserve for brokenFor turns wins the war", isWon(c),
    `exhausted=${c.exhausted}`);
}

{
  // Save compatibility: a campaign written before adoption has no reserve and
  // no exhausted field. It must read a full reserve and take a turn unharmed.
  const c = newCampaign(19);
  delete c.reserve;
  delete c.exhausted;
  check("an old-shape save reads a full reserve", reserveOf(c) === RESERVE.initial,
    `reserve=${reserveOf(c)}`);
  runEnemyTurn(c, makeRng(19, 0));
  check("an old-shape save survives a turn", typeof c.reserve === "number" && !isWon(c),
    `reserve=${c.reserve}`);
}

{
  // The floor is gone: pushing them below their opening depth lowers ambition
  // below base. With the reserve full this is visible as a smaller clamp input;
  // assert on the formula's own output with a huge reserve so ambition binds.
  const c = newCampaign(13);
  c.reserve = 10_000;
  for (const s of c.sectors) s.control = "ours";
  c.sectors[0].control = "theirs";           // one sector left of 24
  check("deep pushes lower ambition below base",
    pressureBudget(c) < 6,
    `budget=${pressureBudget(c)}`);
}
```

Note: `newCampaign`, `isWon`, `makeRng` are already imported at the top of `campaigntest.mjs` — extend the existing import lines rather than duplicating them.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run campaigntest
```

Expected: FAIL — `gainGround drains the reserve` fails (drain is behind `feedbackOn("reserve")`, off by default), and the exhaustion/floor checks fail similarly.

- [ ] **Step 3: Implement the graduation**

In `src/chart/enemyTurn.ts`:
1. Copy the `RESERVE` const (with its full docblocks) from `feedback.ts` and export it here.
2. `sectorsHeldBeyondStart`: change `Math.max(0, countControl(...) - ENEMY_START_DEPTH * GRID)` to `countControl(campaign, "theirs") - ENEMY_START_DEPTH * GRID` and update its docblock (it can now go negative; deep pushes reduce ambition — cite the spec).
3. `pressureBudget`: delete the `feedbackOn("supply")` block and the `SUPPLY` import; make the reserve clamp unconditional:
```ts
export function pressureBudget(campaign: Campaign): number {
  const clock = Math.floor(campaign.runsElapsed / PRESSURE.runsPerStep);
  const ambition = Math.max(0, PRESSURE.base + clock + sectorsHeldBeyondStart(campaign));
  return Math.min(ambition, Math.floor(reserveOf(campaign) * RESERVE.commit));
}
```
(The `Math.max(0, …)` moves *outside* the sum: ambition itself may not go negative, but the territory term inside it now can.)
4. `runEnemyTurn`: remove the `feedbackOn("reserve")` guards around the arrival/regen block and the closing deduction — the code inside stays exactly as it is, docblocks included.
5. `priceOf`/`apply`: delete the two `feedbackOn("entrench")` blocks and the `ENTRENCH` import.

In `src/chart/campaign.ts`: delete the `entrenched` field from `Sector`; `isWon` becomes:
```ts
export function isWon(campaign: Campaign): boolean {
  if (countControl(campaign, "theirs") === 0) return true;
  return (campaign.exhausted ?? 0) >= RESERVE.brokenFor;
}
```
importing `RESERVE` from `./enemyTurn.js` — **check for an import cycle**: `enemyTurn.ts` imports from `campaign.ts`, so `campaign.ts` must not import `enemyTurn.ts`. Instead move `isWon`'s exhaustion threshold to a re-exported constant: put `RESERVE` in a new tiny module `src/chart/reserve.ts` (constants only, no imports), import it from both `enemyTurn.ts` and `campaign.ts`. `reserveOf` stays in `enemyTurn.ts`.

In `src/chart/economy.ts`: `gainGround` — remove the `feedbackOn("reserve")` guard around the drain (keep the drain and its comment); delete the `feedbackOn("entrench")` block; fix imports (`RESERVE` now from `./reserve.js`).

Delete `src/chart/feedback.ts`. Fix every remaining import of it (`grep -rn "feedback" src/ tools/`).

In `tools/campaignlength.mjs`: delete the `--feedback` flag wiring and `setFeedback`/`describeFeedback` imports; reimplement `--tune` locally against the exported `RESERVE`:
```js
if (tuneSpec) {
  for (const clause of tuneSpec.split(",")) {
    const [path, raw] = clause.split("=");
    const key = path.replace(/^reserve\./, "");
    if (!(key in RESERVE)) throw new Error(`unknown tunable "${path}"`);
    RESERVE[key] = Number(raw);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run campaigntest && npm run typecheck
```

Expected: PASS, and `node tools/campaignlength.mjs 200 --sweep --vary` still runs (its numbers will have shifted — that is Task 3's business, not this one's).

- [ ] **Step 5: Commit**

```bash
git add src/chart/enemyTurn.ts src/chart/campaign.ts src/chart/economy.ts src/chart/reserve.ts tools/campaignlength.mjs tools/campaigntest.mjs
git rm src/chart/feedback.ts
git commit -m "Graduate the finite invasion from candidate to rule"
```

### Task 2: Uncap patrols — the salvage sink

**Files:**
- Modify: `src/chart/economy.ts:317-349` (delete capacity; keep one-per-sector and strength cap)
- Modify: `src/chart/command.ts:125-126` (refusal copy)
- Modify: `src/chart/ChartView.ts:780` (status line copy)
- Modify: `tools/campaignlength.mjs` (drop `--patrols`; model player deploys while salvage allows)
- Modify: `tools/campaigntest.mjs` (replace the two capacity assertions)
- Test: `tools/campaigntest.mjs`

**Interfaces:**
- Produces: `deployPatrol(campaign, index)` unchanged signature, no capacity refusal. `patrolCapacity` and `PATROL.baseCapacity` **deleted** — anything importing them must stop (Task 1 already listed the importers: `command.ts`, `ChartView.ts`, both tools).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

In `tools/campaigntest.mjs`, replace the two assertions at ~461 and ~501 (`"capacity"` checks) with:

```js
{
  const c = newCampaign(17);
  c.salvage = 1000;
  const home = c.sectors.findIndex((s) => s.structures.length > 0);
  const second = c.sectors.findIndex((s, i) => s.control === "ours" && i !== home);
  check("a second patrol deploys with no yard",
    deployPatrol(c, home) && deployPatrol(c, second),
    `salvage=${c.salvage}`);
  check("patrols still refuse enemy ground",
    !deployPatrol(c, c.sectors.findIndex((s) => s.control === "theirs")),
    "deployed into theirs");
  check("a full-strength patrol still refuses reinforcement",
    !deployPatrol(c, home),
    "reinforced past maxStrength");
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run campaigntest
```

Expected: FAIL — `a second patrol deploys with no yard` (capacity 1 refuses it). Note the *old* capacity tests must already be gone or the build fails on the deleted `patrolCapacity` import — deleting them is part of this step.

- [ ] **Step 3: Implement**

`economy.ts`: delete `patrolCapacity`, `patrolCount` stays; delete `baseCapacity` from `PATROL` and the line `if (!existing && patrolCount(...) >= patrolCapacity(...)) return false;` from `deployPatrol`. Update the `PATROL` docblock: repeatable by design, the sink `campaign-balance.md` §5 recommends.

`command.ts:125`: the capacity refusal branch is deleted outright (salvage refusal below it already covers "can't afford").

`ChartView.ts:780`: `` `PATROLS ${patrolCount(campaign)} IN THE FIELD   ${loadoutSummary(campaign)}` ``.

`campaignlength.mjs`: delete the `--patrols` flag and the `PATROL.baseCapacity` write; where the model player deploys (~line 184), the condition `patrolCount(campaign) < patrolCapacity(campaign)` becomes a salvage-and-frontage condition: deploy while `campaign.salvage >= PATROL.cost` and some owned front-line sector lacks a patrol (the surrounding loop already picks such sectors).

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run campaigntest && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chart/economy.ts src/chart/command.ts src/chart/ChartView.ts tools/campaignlength.mjs tools/campaigntest.mjs
git commit -m "Uncap patrols: the DEPLOY row becomes the salvage sink"
```

### Task 3: Retune for ~25-run wars; record the addendum

**Files:**
- Modify: `src/chart/reserve.ts` (the adopted constants)
- Modify: `docs/campaign-balance.md` (dated addendum)
- Test: the sweep itself

**Interfaces:**
- Produces: final `RESERVE` values, recorded.
- Consumes: Tasks 1–2 (the sweep must run on shipped rules with the sink in).

- [ ] **Step 1: Baseline sweep**

```bash
node tools/campaignlength.mjs 1000 --sweep --vary --ceiling=40
node tools/campaignlength.mjs 1000 --sweep --vary
```

Record both tables verbatim in a scratch file.

- [ ] **Step 2: Iterate `regenFlat` down (then `costPerStep` if needed)**

```bash
node tools/campaignlength.mjs 1000 --sweep --vary --ceiling=40 --tune=reserve.regenFlat=18
```

Try 18, 16, 14 …; hold the spec's acceptance criteria:
- (a) some reach row in 4–6 wins 30–70%;
- (b) at that row ≥ 60% resolve inside 40 runs, median contested campaign ≤ ~25 runs;
- (c) unresolved-at-200 near zero at every reach (verify with the un-ceilinged sweep).

If (a) and (b) conflict, (b) wins (owner's ruling 1) and the compromise is recorded.

- [ ] **Step 3: Adopt the numbers**

Write the winning values into `src/chart/reserve.ts`, updating the constants' docblocks with one line each: measured on this date, at these criteria.

- [ ] **Step 4: Record the addendum**

Append to `docs/campaign-balance.md` a dated section "Adopted, 2026-08-13" with: the constants chosen, the final sweep table (both ceilinged and not), which criteria bound, and the note that `--feedback` is retired because the reserve is now the game.

- [ ] **Step 5: Verify nothing regressed and commit**

```bash
npm run campaigntest && npm run typecheck
git add src/chart/reserve.ts docs/campaign-balance.md
git commit -m "Tune the reserve for ~25-run wars, and record the sweep"
```

---

## Phase B — the commander

### Task 4: `commander.ts` — name, doctrine, act

**Files:**
- Create: `src/chart/commander.ts`
- Modify: `tools/campaigntest.mjs`
- Test: `tools/campaigntest.mjs`

**Interfaces:**
- Produces:
```ts
export type Doctrine = "raider" | "hammer" | "anvil";
export interface Commander {
  readonly given: string;      // e.g. "SERRAX"
  readonly surname: string;    // e.g. "VOL" — what dispatches and labels use
  readonly pronoun: "SHE" | "HE" | "THEY";
  readonly doctrine: Doctrine;
}
export function commanderOf(seed: number): Commander;
export type WarAct = "surge" | "contested" | "failing";
export function warAct(campaign: Campaign): WarAct;
/** Which hostile class the doctrine's guard is. Plain strings, not
 *  HostileKind — chart modules cannot import from src/game/. The values are
 *  spelled to match HostileKind exactly; Session narrows them. */
export function guardClass(doctrine: Doctrine): "swarmer" | "brawler" | "sniper";
```
- Consumes: `hash` — copy `naming.ts`'s private `hash(seed, salt)` (it is 8 lines; export it from `naming.ts` instead and import it here, updating `naming.ts` to `export function hash`).

- [ ] **Step 1: Write the failing tests**

```js
import { commanderOf, warAct, guardClass } from "./.campaign-build/chart/commander.js";

{
  const a = commanderOf(42);
  const b = commanderOf(42);
  check("commander is deterministic per seed",
    a.given === b.given && a.surname === b.surname &&
    a.doctrine === b.doctrine && a.pronoun === b.pronoun,
    JSON.stringify(a));
  check("different seeds can differ",
    [1, 2, 3, 4, 5, 6, 7, 8].some((s) => commanderOf(s).surname !== a.surname),
    "eight seeds, one surname");
  check("guard class follows doctrine",
    guardClass("raider") === "swarmer" && guardClass("hammer") === "brawler" &&
    guardClass("anvil") === "sniper", "");
}

{
  const c = newCampaign(23);
  check("a fresh war is a surge", warAct(c) === "surge", warAct(c));
  c.exhausted = 1;
  check("a ticking exhaustion counter is failing", warAct(c) === "failing", warAct(c));
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run campaigntest
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commander.ts`**

Word lists (invented, own-universe — extend freely but keep them ours): given ~12 (`SERRAX, KAVEN, ODRA, THALEN, MIRECK, VOSSA, ARDIN, KELWE, SANDRIX, THURA, BELLAN, ORIS`), surnames ~12 (`VOL, KURR, DRACE, MHAL, TESSEK, ORVANE, KAETH, SULM, VARR, ENNIK, THAAL, RUVEN`). Draw with `hash(seed, salt)` at distinct salts (name 201, surname 202, pronoun 203, doctrine 204). Pronoun from `["SHE","HE","THEY"]`.

```ts
export function warAct(campaign: Campaign): WarAct {
  if ((campaign.exhausted ?? 0) > 0) return "failing";
  const reserve = reserveOf(campaign);
  if (reserve <= RESERVE.regenFlat) return "failing";
  const theirs = countControl(campaign, "theirs");
  if (theirs >= ENEMY_START_DEPTH * GRID && reserve >= RESERVE.max * 0.6) return "surge";
  return "contested";
}
```
(`reserveOf` from `./enemyTurn.js`, constants from `./reserve.js` and `./campaign.js`/`./sectors.js` — one-directional imports only, no cycle: `commander.ts` imports from `enemyTurn.ts`, never the reverse... **except Task 5 needs the doctrine inside `enemyTurn.ts`**, so put `Doctrine`, `commanderOf` and `guardClass` in `commander.ts` with **no import from `enemyTurn.ts`**, and put `warAct` in `commander.ts` importing `reserveOf` — then `enemyTurn.ts` may import `commanderOf` from `commander.ts` only if `commander.ts` does not import `enemyTurn.ts`. Resolve by moving `reserveOf` into `reserve.ts` (it reads only `campaign.reserve ?? RESERVE.initial`), re-exported from `enemyTurn.ts` for existing callers.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run campaigntest && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/chart/commander.ts src/chart/naming.ts src/chart/reserve.ts src/chart/enemyTurn.ts tools/campaigntest.mjs
git commit -m "Derive the enemy commander from the seed"
```

### Task 5: Doctrine reweights the enemy turn

**Files:**
- Modify: `src/chart/enemyTurn.ts` (weighted sort)
- Modify: `tools/campaignlength.mjs` (per-doctrine breakdown in the report)
- Modify: `tools/campaigntest.mjs`
- Test: `tools/campaigntest.mjs`, then the sweep

**Interfaces:**
- Produces: `runEnemyTurn` unchanged signature; ordering inside each phase becomes `cost × weight`. Exported for tests: `DOCTRINE_WEIGHTS: Record<Doctrine, Record<EnemyAction["kind"], number>>`.
- Consumes: `commanderOf(campaign.seed).doctrine` from Task 4.

- [ ] **Step 1: Write the failing test**

```js
{
  // Doctrine changes texture: over many seeds, hammer wars produce a higher
  // share of assault+push-ours actions than raider wars do.
  const share = (doctrine) => {
    let heavy = 0, total = 0;
    for (let seed = 1; seed <= 400; seed++) {
      if (commanderOf(seed).doctrine !== doctrine) continue;
      const c = newCampaign(seed);
      const rng = makeRng(seed, 0);
      for (let run = 0; run < 6; run++) {
        for (const a of runEnemyTurn(c, rng)) {
          total++;
          if (a.kind === "assault" || a.kind === "push-ours") heavy++;
        }
        c.runsElapsed++;
      }
    }
    return heavy / Math.max(1, total);
  };
  check("hammer fights heavier than raider", share("hammer") > share("raider"),
    `hammer=${share("hammer").toFixed(3)} raider=${share("raider").toFixed(3)}`);
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run campaigntest
```

Expected: FAIL (shares equal — no weighting yet). If it passes by luck, tighten to `> share("raider") + 0.03`.

- [ ] **Step 3: Implement**

In `enemyTurn.ts`:
```ts
export const DOCTRINE_WEIGHTS: Record<Doctrine, Record<EnemyAction["kind"], number>> = {
  raider: { "push-contested": 0.6, "push-ours": 1.2, assault: 1.4, consolidate: 1.0 },
  hammer: { "push-contested": 1.2, "push-ours": 0.7, assault: 0.6, consolidate: 1.1 },
  anvil:  { "push-contested": 1.1, "push-ours": 1.3, assault: 1.2, consolidate: 0.5 },
};
```
(A weight **below** 1 makes that action sort cheaper — preferred. Raider prefers spread pushes; Hammer prefers deep pushes and assaults; Anvil prefers consolidate.) In `runEnemyTurn`, resolve once: `const weights = DOCTRINE_WEIGHTS[commanderOf(campaign.seed).doctrine];` and change the sort to `.sort((a, b) => a.cost * weights[a.kind!] - b.cost * weights[b.kind!])`. The two-phase split (expansion first) is untouched — weights reorder *within* phases only.

In `campaignlength.mjs`, tag each simulated campaign with `commanderOf(seed).doctrine` and print a per-doctrine won/lost/unresolved line under each sweep row.

- [ ] **Step 4: Run tests, then the balance guard**

```bash
npm run campaigntest && npm run typecheck
node tools/campaignlength.mjs 1000 --sweep --vary --ceiling=40
```

Expected: campaigntest PASS; at the band row from Task 3, no doctrine outside 20–80% won. If one is, flatten its weights toward 1 and re-run (spec §2.2's guard).

- [ ] **Step 5: Commit**

```bash
git add src/chart/enemyTurn.ts tools/campaignlength.mjs tools/campaigntest.mjs
git commit -m "Let the commander's doctrine reweight the enemy turn"
```

---

## Phase C — the voice

### Task 6: Deck log — the commander stanza and the reserve line

**Files:**
- Modify: `src/game/briefing.ts` (`compose`)
- Test: `tools/playtest.mjs` (extend the existing briefing pacing assertion's expectations)

**Interfaces:**
- Consumes: `commanderOf`, `warAct` from `src/chart/commander.js`.
- Produces: nothing new — copy only.

- [ ] **Step 1: Extend the playtest expectation (write it failing)**

In `tools/playtest.mjs`, find the existing deck-log assertion (search `readable`). Add: on a fresh campaign's first run, the readable lines eventually include a line starting `THEIR COMMANDER IS`. Follow the harness's existing polling pattern for crawl content.

- [ ] **Step 2: Run to verify it fails**

```bash
npm run playtest
```

Expected: FAIL on the new expectation. (Needs a fresh dev server per the gotcha; if the harness is too slow to run here, `npm run typecheck` gates each step and the playtest run lands in Step 4.)

- [ ] **Step 3: Implement in `compose`**

After the `THEY HOLD N SECTORS` stanza (inside the `theirs > 0` block, before its `gap()`), add:

```ts
const commander = commanderOf(campaign.seed);
const act = warAct(campaign);
out.push([
  act === "surge" ? "THEIR SUPPLY RUNS DEEP"
  : act === "failing" ? "THEY ARE SPENDING THEIR LAST"
  : "THEIR RESERVE STRAINS",
  "note",
]);
```

And in the `teach` block (with the war rules), before `CLEAR A SECTOR TO TAKE IT`:

```ts
out.push([`THEIR COMMANDER IS ${commander.given} ${commander.surname}`, "body"]);
const DOCTRINE_LINE: Record<Doctrine, string> = {
  raider: "SPENDS SHIPS LIKE SHOT",
  hammer: "MASSES BEFORE MOVING",
  anvil: "PAYS FOR GROUND ONCE AND KEEPS IT",
};
out.push([`${commander.pronoun} ${DOCTRINE_LINE[commander.doctrine]}`, "note"]);
gap();
```

(`briefing.ts` is in `src/game/` and may import chart logic — it already imports `campaign.js` and `naming.js`.)

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm run playtest
```

Expected: PASS (fresh dev server; clear `node_modules/.vite` if `__stage` is undefined).

- [ ] **Step 5: Commit**

```bash
git add src/game/briefing.ts tools/playtest.mjs
git commit -m "Name the commander in the deck log, and let it read the reserve"
```

### Task 7: Dispatches — names and act-aware fallbacks

**Files:**
- Modify: `src/game/dispatch.ts` (`compose`)
- Test: `tools/campaigntest.mjs` is the wrong home (dispatch lives in `src/game/`); test by direct import in `tools/playtest.mjs`'s node-side, or simplest: a typecheck-gated implementation with the dedup keys asserted via `playtest`'s page probe if practical. Given cost, this task is copy-only and gates on typecheck + the existing dispatch behaviour tests if any exist (`grep -n dispatch tools/playtest.mjs`).

**Interfaces:**
- Consumes: `commanderOf`, `warAct`.
- Produces: dedup keys gain the act, so a band change re-arms the fallback topics.

- [ ] **Step 1: Implement in `compose`**

```ts
const commander = commanderOf(campaign.seed);
// hold topic:
text: `HQ: ${commander.surname} COMMITTED A STRIKE ON ${this.name(campaign, here)}. YOU ARE STANDING IN IT.`,
// intercept topic:
text: `HQ: ${commander.surname} MOVES ON ${this.name(campaign, elsewhere.sector)}. CLEAR IT AND THE STRIKE NEVER LANDS.`,
// fallbacks — act-aware, keyed on the act so a band change is news:
const act = warAct(campaign);
if (act === "failing") {
  return { key: `failing:${theirs}`,
    text: `HQ: THEIR RESERVE IS FAILING. EVERY WAVE YOU BREAK NOW STAYS BROKEN.` };
}
if (theirs > ours) {
  return { key: `losing:${act}:${theirs}`,
    text: `HQ: THEY HOLD ${theirs} SECTORS TO OUR ${ours}. TAKE GROUND WHERE YOU CAN.` };
}
return { key: `winning:${act}:${theirs}`,
  text: `HQ: THEY ARE DOWN TO ${theirs} SECTORS. KEEP PUSHING.` };
```

- [ ] **Step 2: Verify and commit**

```bash
npm run typecheck && npm run playtest
git add src/game/dispatch.ts
git commit -m "Put the commander's name on HQ's dispatches"
```

### Task 8: The reserve bar on the command view

**Files:**
- Modify: `src/chart/ChartView.ts` (~line 488, the header row)

**Interfaces:**
- Consumes: `reserveOf` (from `./reserve.js`), `RESERVE`, `commanderOf`.

- [ ] **Step 1: Implement**

Under the `HELD … THEIRS …` right-aligned line, add one row: the commander's surname and a segmented bar of `reserveOf(campaign) / RESERVE.max`, drawn with the file's existing `hud.segments`/`rule` helpers in `PALETTE.traceDim` with the filled portion `PALETTE.amber` (amber = the thing to act on; it never pulses). Ten ticks, filled left to right:

```ts
const fill = Math.round((reserveOf(campaign) / RESERVE.max) * 10);
hud.textRight(`${commanderOf(campaign.seed).surname}  ${"▮".repeat(fill)}${"▯".repeat(10 - fill)}`,
  right, height - 138, 1.6, PALETTE.traceDim);
```

**Check first** that the stroke font has the block glyphs (`grep -n "25AE\|▮" src/hud/strokeFont.ts`); if not, draw the ticks as ten short `hud.segments` strokes instead of glyphs — do not add glyphs to the font for this.

- [ ] **Step 2: Verify by eye and commit**

Run the dev server, die once (or `__presentation.enterCommand()` on localhost), screenshot the command view, confirm the bar reads and nothing collides.

```bash
npm run typecheck
git add src/chart/ChartView.ts
git commit -m "Show the invasion's reserve on the command view"
```

---

## Phase D — the ending

### Task 9: Victory and defeat deck logs

**Files:**
- Modify: `src/game/briefing.ts` (a `beginEpilogue`)
- Modify: `src/game/presentation.ts` (routing at the tally→command handoff)
- Test: `tools/playtest.mjs`

**Interfaces:**
- Produces: `Briefing.beginEpilogue(campaign: Campaign, won: boolean): void` — same crawl, different copy; obeys `enabled` (`L`) and any-key skip identically.
- Consumes: `commanderOf`, `countControl`, `isWon`, `isLost`.

- [ ] **Step 1: Write the failing test**

Playtest: force a nearly-won campaign on the page (`__session`/`__presentation` are exposed on localhost), flip the last enemy sector to `"ours"` via the probe, kill the player (the harness already has a die-and-tally path — reuse it), and assert the readable crawl contains `THE INVASION IS BROKEN` before the command view accepts input.

- [ ] **Step 2: Run to verify it fails**

```bash
npm run playtest
```

- [ ] **Step 3: Implement**

`briefing.ts`:
```ts
beginEpilogue(campaign: Campaign, won: boolean): void {
  if (!this.enabled) return;
  const commander = commanderOf(campaign.seed);
  const theirs = countControl(campaign, "theirs");
  const copy: [string, CrawlTone][] = won
    ? [
        ["DECK LOG   FINAL", "head"], ["", "note"],
        ["THE INVASION IS BROKEN", "body"],
        [`${commander.surname} WITHDRAWS`, "body"],
        [`${campaign.runsElapsed} RUNS. THEY STILL HELD ${theirs} ${theirs === 1 ? "SECTOR" : "SECTORS"}. IT DID NOT MATTER.`, "note"],
        ["", "note"],
        ["THE WAVES STOPPED", "body"],
        ["WE GO HOME", "flag"],
      ]
    : [
        ["DECK LOG   FINAL", "head"], ["", "note"],
        ["THE LAST STARBASE IS GONE", "body"],
        [`${commander.surname} TAKES THE CHART`, "body"],
        [`${campaign.runsElapsed} RUNS. IT WAS NOT ENOUGH.`, "note"],
        ["COMMAND LOST", "flag"],
      ];
  this.lines = layout(copy);
  // …then the same reset `begin` performs (travel/spoken/elapsed/holding/span/
  // active/service blip). Extract that tail of `begin` into a private
  // `start()` used by both, rather than duplicating it.
}
```

`presentation.ts`: in `update`'s `"run"` case, where `this.tallyTime >= TIMING.tally` currently calls `this.enter("command")`, and in `enterCommand()`, route through one private method:

```ts
private toCommand(): void {
  const over = isWon(this.campaign) || isLost(this.campaign);
  this.enter("command");                       // enter() skips any live briefing
  if (over) this.briefing.beginEpilogue(this.campaign, isWon(this.campaign));
}
```

While the epilogue is active, `update` already early-returns on `briefing.active`, so the command idle clock does not run under it — verify `main.ts` treats a briefing over the command view correctly (it reads `briefing.active` to gate stepping; the command view draws under the crawl, which is acceptable — check by eye).

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm run playtest
```

- [ ] **Step 5: Commit**

```bash
git add src/game/briefing.ts src/game/presentation.ts tools/playtest.mjs
git commit -m "Give the war an ending: the final deck log, both ways"
```

---

## Phase E — the combat feel pack

### Task 10: Near-miss streaks and the doppler cue

**Files:**
- Modify: `src/game/weapons.ts` (streak records in `Ordnance`; `noted` flag on `Projectile`)
- Modify: `src/game/session.ts` (detection in the projectile-vs-player pass, ~line 790–830)
- Modify: `src/audio/sound.ts` (a `nearMiss(x, z)` cue)
- Modify: `src/audio/selftest.mjs` (contract row for the new cue — follow the file's existing per-cue pattern)
- Test: `npm run audiotest`

**Interfaces:**
- Produces: `Ordnance.nearMiss(at: Vector3, along: Vector3): void` (records a streak: 6-unit line through `at` in direction `along`, life 0.35 s, drawn in `Ordnance.draw` at intensity `2.2 × (1 − t)` in `boltColor`); `Projectile.noted: boolean` (mutable, initialised false); `sound.nearMiss(x, z)`.
- Consumes: `sweepDistance(projectile, target)` — already exported from `weapons.ts`.

- [ ] **Step 1: Write the failing audiotest row**

In `src/audio/selftest.mjs`, add `nearMiss` to whatever cue table the file drives (read its pattern first — every cue is exercised against the mock context and asserted not to throw and to land on a bus). Expected new assertion: `nearMiss` plays on the `weapon` bus and respects the out-of-earshot early-out.

- [ ] **Step 2: Run to verify it fails**

```bash
npm run audiotest
```

Expected: FAIL — `sound.nearMiss` undefined.

- [ ] **Step 3: Implement**

`sound.ts`, beside `hostileFire` (same placement idiom):
```ts
/** A shot that went past, not into. Quieter than a hit, panned where it crossed. */
nearMiss(x: number, z: number): void {
  const { level, pan } = this.place(x, z);
  if (level < 0.06) return;
  this.synth.play({
    kind: "noise", bus: "weapon", filter: "bandpass", q: 2.2,
    freq: 1900, to: 420, level: 0.12 * level,
    attack: 0.002, decay: 0.22, pan,
  });
}
```

`weapons.ts`: add `noted` to the `Projectile` interface (mutable) and initialise it in `fire`; add to `Ordnance` a `streaks: { at: Vector3; along: Vector3; life: number }[]`, a `nearMiss(at, along)` push, aging in `update` on `dt`, and drawing in `draw` (one `trace.push` per streak, endpoints `at ± along×3`, `boltColor`, intensity `2.2 × (1 − life/0.35)`).

`session.ts`, in the hostile-projectile pass where a projectile that did **not** hit the player continues: with `NEAR_MISS = { inner: /* player hit radius, read from the existing hit test */, outer: 4.5, cooldown: 0.4 }`:
```ts
if (!projectile.noted) {
  const d = sweepDistance(projectile, player.position);
  if (d > hitRadius && d < NEAR_MISS.outer) {
    projectile.noted = true;
    if (this.nearMissTimer <= 0) {
      this.nearMissTimer = NEAR_MISS.cooldown;
      sound.nearMiss(projectile.position.x, projectile.position.z);
    }
    this.ordnance.nearMiss(projectile.position, projectile.velocity.clone().normalize());
  }
}
```
(`sweepDistance` is exported at `weapons.ts:183`; import it. `nearMissTimer` is a new private field decayed on `dt`. Player-fired projectiles are skipped — the pass already distinguishes owners; only hostile shots near the *player* qualify, torpedoes included.)

- [ ] **Step 4: Verify**

```bash
npm run audiotest && npm run typecheck
```

Then by eye: dev server, hold still until shot at, sidestep — streaks and whoosh.

- [ ] **Step 5: Commit**

```bash
git add src/game/weapons.ts src/game/session.ts src/audio/sound.ts src/audio/selftest.mjs
git commit -m "Say the near miss: a streak past the canopy and a doppler sweep"
```

### Task 11: World-space shield arcs — struck quarter and braced bow

**Files:**
- Modify: `src/game/Ship.ts` (two render-facing fields)
- Create: `src/game/shieldFx.ts` (`drawShieldFx(trace, player)`)
- Modify: `src/main.ts` (one call in the `trace.begin()`…`trace.end()` block, ~line 1019–1043)
- Test: `tools/playtest.mjs`

**Interfaces:**
- Produces: `Ship.struckFacing: ShieldFacing | null`, `Ship.struckFlash: number` (1 → 0, decayed at `× 3/s` in `Ship.update` beside the existing `impact` decay); `drawShieldFx(trace: TraceBuffer, player: Ship): void`.
- Consumes: `Ship.shields.fore` (>1 means braced surplus, ceiling `BRACE.ceiling`), `Ship.heading`, `PALETTE.trace` (cyan).

- [ ] **Step 1: Write the failing playtest assertion**

Via the localhost probe: deal the player a hit (`__player.takeHit(0.3, new __THREE.Vector3(0,0,50))` — check what the harness exposes; if no `Vector3` is reachable, drive it by letting wave one land a shot and polling), then assert `__player.struckFacing !== null && __player.struckFlash > 0`.

- [ ] **Step 2: Run to verify it fails** (`npm run playtest`) — field undefined.

- [ ] **Step 3: Implement**

`Ship.ts` — in `takeHit`, after `this.impact = 1`:
```ts
this.struckFacing = facing;
this.struckFlash = 1;
```
and in `update`, beside the impact decay: `this.struckFlash = Math.max(0, this.struckFlash - dt * 3);`

`src/game/shieldFx.ts`:
```ts
import type { TraceBuffer } from "../render/TraceBuffer.js";
import { PALETTE } from "../render/palette.js";
import { BRACE, type Ship, type ShieldFacing } from "./Ship.js";

/** Bearing offset of each quarter's centre from the ship's heading. */
const FACING_OFFSET: Record<ShieldFacing, number> = {
  fore: 0, starboard: Math.PI / 2, aft: Math.PI, port: -Math.PI / 2,
};
const RADIUS = 4.6;
const SEGMENTS = 10;          // per 90° arc
const HALF = Math.PI / 4;     // arc half-width

function arc(trace: TraceBuffer, player: Ship, facing: ShieldFacing, intensity: number): void {
  const centre = player.heading + FACING_OFFSET[facing];
  for (let i = 0; i < SEGMENTS; i++) {
    const a = centre - HALF + (i / SEGMENTS) * HALF * 2;
    const b = centre - HALF + ((i + 1) / SEGMENTS) * HALF * 2;
    trace.push(
      player.position.x + Math.sin(a) * RADIUS, player.position.y, player.position.z + Math.cos(a) * RADIUS,
      player.position.x + Math.sin(b) * RADIUS, player.position.y, player.position.z + Math.cos(b) * RADIUS,
      PALETTE.trace, intensity,
    );
  }
}

export function drawShieldFx(trace: TraceBuffer, player: Ship): void {
  const surplus = player.shields.fore - 1;
  if (surplus > 0) arc(trace, player, "fore", 0.5 + 1.1 * (surplus / (BRACE.ceiling - 1)));
  if (player.struckFacing && player.struckFlash > 0) {
    arc(trace, player, player.struckFacing, 2.4 * player.struckFlash);
  }
}
```
(Check `Ship.ts` for the actual `ShieldFacing` union member names and the exact facing→bearing convention `facingFrom` uses — mirror it exactly, and export `ShieldFacing`/`BRACE` if not already exported.) `main.ts`: `drawShieldFx(trace, player);` inside the trace block, after `session.docking.draw`.

- [ ] **Step 4: Verify** — `npm run typecheck && npm run playtest`; then by eye: get hit, watch the quarter flash; tap `Z`, watch the bow glow and drain over ~9 s.

- [ ] **Step 5: Commit**

```bash
git add src/game/Ship.ts src/game/shieldFx.ts src/main.ts tools/playtest.mjs
git commit -m "Draw the shields where the ship is: struck quarter and braced bow"
```

### Task 12: Kill punctuation by class

**Files:**
- Modify: `src/game/debris.ts` (a ring record + draw)
- Modify: `src/game/hitStop.ts` (`HIT_STOP.heavyKill`)
- Modify: `src/game/session.ts` (`destroy` and `destroyByAlly`)
- Test: typecheck + eye (a transient's look is not assertable headless with post off)

**Interfaces:**
- Produces: `Debris.ring(centre: Vector3, color: Color, size: number): void` — an expanding circle: radius `2 + 22 × t/0.7`, 24 segments, intensity `2.0 × (1 − t/0.7) × size`, dead at 0.7 s, aged on `dt` in the existing `update`, drawn in the existing `draw`.
- Consumes: `HOSTILE_COLORS[kind]`, the `size` scalar `destroy` already computes (1 / 1.25 / 1.4).

- [ ] **Step 1: Implement**

`hitStop.ts`: add `heavyKill` to `HIT_STOP`, value = `kill × 1.5`, with a one-line comment (a bigger hull earns a longer beat; still bounded by `max`).

`debris.ts`: rings array `{ centre: Vector3; color: Color; size: number; age: number }`, `ring()` pushes, `update(dt)` ages and culls at 0.7, `draw(trace)` pushes 24 chords of the circle at the current radius on the XZ plane at `centre.y`.

`session.ts` `destroy`: after `this.debris.burst(...)`:
```ts
this.debris.ring(hostile.position, HOSTILE_COLORS[hostile.kind], size);
this.hitStop.strike(size > 1 ? HIT_STOP.heavyKill : HIT_STOP.kill);
```
(replacing the existing unconditional `HIT_STOP.kill` strike). `destroyByAlly`: add the same `ring` call, **no** hit-stop (its ledger stays empty of feel rewards beyond the world-facing look, per its docblock).

- [ ] **Step 2: Verify** — `npm run typecheck`; dev server, kill a Raider then survive to a Bastion; the rings scale, the Bastion beat lands harder. Record the measured worst-case segment count (`rings × 24 + streaks + arcs`) in `docs/todo.md`'s tuning section, the way the comet's 779 is recorded.

- [ ] **Step 3: Commit**

```bash
git add src/game/debris.ts src/game/hitStop.ts src/game/session.ts docs/todo.md
git commit -m "Punctuate kills by class: a ring that scales, a beat that lands"
```

---

## Phase F — the hostile doctrine pack

### Task 13: Facing-aware flanking

**Files:**
- Modify: `src/game/hostiles.ts` (`Fleet` computes the gate; swarmer steering reads it)
- Test: `tools/playtest.mjs`

**Interfaces:**
- Produces: `Fleet.brawlerEngaged: boolean` (set each update: any live brawler within its own `fireRange` of the player); swarmer tangent sign steers sternward while it is true.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing playtest assertion**

Seed a controlled fight via the probe (spawn or wait for a wave containing a brawler + swarmers — check what `__fleet` exposes; if spawning isn't scriptable, assert the pure geometry instead: export a `sternSign(hostileBearing, playerHeading)` helper from `hostiles.ts` and assert its sign flips correctly for hostiles on either beam — this is the honest testable core).

```js
// sternSign: which tangent direction moves this hostile toward the player's stern.
// bearing/heading in radians; returns -1 or 1.
assert(sternSign(0, 0) !== 0);
assert(sternSign(Math.PI * 0.4, 0) === -sternSign(-Math.PI * 0.4, 0));
```

- [ ] **Step 2: Run to verify it fails** — helper undefined.

- [ ] **Step 3: Implement**

`hostiles.ts`:
```ts
/** Which way around the player carries a hostile toward the stern. */
export function sternSign(bearingFromPlayer: number, playerHeading: number): number {
  // The stern sits at playerHeading + π. Steer around the shorter way.
  const toStern = angleDelta(bearingFromPlayer, playerHeading + Math.PI);
  return toStern >= 0 ? 1 : -1;
}
```
(reuse the file's existing `angleDelta`; add one if it lives elsewhere). In `Fleet.update`, before the per-hostile loop: `this.brawlerEngaged = this.hostiles.some((h) => h.kind === "brawler" && h.position.distanceTo(player.position) < h.spec.fireRange);` and pass it (or set a field the hostile reads). In `Hostile.update`, the tangent sign — currently the positional hash at line ~296 — becomes, **for swarmers only and only while the gate is true**:
```ts
const sign = flank && this.kind === "swarmer"
  ? sternSign(Math.atan2(this.position.x - player.position.x, this.position.z - player.position.z), player.heading)
  : (Math.sign(Math.sin(this.position.x * 0.7 + this.position.z * 0.3)) || 1);
const tangent = new Vector3(-toPlayer.z, 0, toPlayer.x).multiplyScalar(this.spec.orbit * sign);
```
No range-hold change, no turn-rate change: the bias is the orbit direction only, bounded by `orbit` exactly as before, and inert with no brawler up (wave one is untouched).

- [ ] **Step 4: Verify** — `npm run campaigntest` untouched, `npm run playtest`, `npm run typecheck`; by eye at escalation 4+: with a Bastion on the nose, Raiders visibly work the rear quarters on the scanner.

- [ ] **Step 5: Commit**

```bash
git add src/game/hostiles.ts tools/playtest.mjs
git commit -m "Swarmers flank the stern while a brawler holds the bow"
```

### Task 14: Withdrawal

**Files:**
- Modify: `src/game/hostiles.ts` (`WITHDRAW` const, flag, steering/fire changes, roll on damage)
- Modify: `src/game/session.ts` (retire the escaped, no pay)
- Modify: `src/audio/sound.ts` + `src/audio/selftest.mjs` (`withdraw(x, z)` cue)
- Modify: `src/hud/draw.ts:1503-1505` (the lead-pip label)
- Test: `tools/playtest.mjs`, `npm run audiotest`

**Interfaces:**
- Produces: on `Hostile`: `withdrawing = false` (public, read by HUD and Session). `WITHDRAW = { threshold: 0.2, exitRange: 130, chance: { swarmer: 0.75, sniper: 0.5, brawler: 0.15, miner: 0.5, stalker: 0 } }` exported from `hostiles.ts`. `sound.withdraw(x, z)`.
- Consumes: `Hostile.damage(amount)` (the existing hull-reduction method — the roll happens where `hull` crosses the threshold), `Fleet.retire`.

- [ ] **Step 1: Write the failing playtest assertion**

Via the probe: take a live hostile, set `hull` low and call its damage path (or set `withdrawing = true` directly if damage isn't reachable), teleport it past `WITHDRAW.exitRange`, step a frame, then assert: it is gone from `__fleet.hostiles`, and `__session.kills`, `__session.pending` and `__session.multiplier` are unchanged from before, and the wave still ends (state leaves `"fighting"` once nothing else is alive).

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

`hostiles.ts`: in the `damage` method, on the crossing (`was > threshold*maxHull && now <= threshold*maxHull`), roll once: `if (Math.random() < WITHDRAW.chance[this.kind]) this.withdrawing = true;` (Shroud's 0 makes it exempt by table rather than by branch). In `update`: when `withdrawing`, the desired direction is straight away from the player (`desired.copy(toPlayer).negate()`, no tangent, no range hold), the fire block is skipped, and the cloak strike cycle is skipped.

`session.ts`: in the loop that steps hostiles (after `fleet.update`), retire the escaped:
```ts
for (const hostile of [...this.fleet.hostiles]) {
  if (!hostile.withdrawing) continue;
  if (hostile.position.distanceTo(player.position) < WITHDRAW.exitRange) continue;
  sound.withdraw(hostile.position.x, hostile.position.z);
  this.fleet.retire(hostile);   // no kills++, no pending, no multiplier, no tally
}
```
The exit flash: before retiring, `hostile.reveal = 1.5` does nothing once retired — instead push one bright streak through `this.ordnance.nearMiss(hostile.position, hostile.velocity.clone().normalize())` reusing Task 10's streak at the exit point (the reverse-reveal grammar, one line, no new machinery).

`sound.ts` `withdraw`: `hostileFire`'s shape, rising instead of falling (`freq: 300, to: 640, decay: 0.3, level: 0.09 * level`) — a departure, not a threat. Add the selftest row.

`draw.ts:1503`: 
```ts
const label = best.hostile.withdrawing
  ? `${HOSTILE_NAMES[best.hostile.kind]} WITHDRAWING`
  : HOSTILE_NAMES[best.hostile.kind];
```

- [ ] **Step 4: Verify** — `npm run audiotest && npm run typecheck && npm run playtest`.

- [ ] **Step 5: Commit**

```bash
git add src/game/hostiles.ts src/game/session.ts src/audio/sound.ts src/audio/selftest.mjs src/hud/draw.ts tools/playtest.mjs
git commit -m "Cripples run: withdrawal that pays nothing and ends the wave clean"
```

### Task 15: The commander's guard

**Files:**
- Modify: `src/game/session.ts` (`spawnWave` roll; guard spec override)
- Modify: `src/game/hostiles.ts` (`Fleet.spawn` accepts a spec override + `guardName`)
- Modify: `src/hud/draw.ts:1503` (label)
- Test: `tools/campaigntest.mjs` (mapping determinism — already in Task 4), `tools/playtest.mjs` (appearance under a forced failing act)

**Interfaces:**
- Produces: `Hostile.guardName: string | null` (e.g. `"VOL"`); `GUARD = { chance: 0.3, hull: 1.6, speed: 1.25, damage: 1.35, value: 2.5 }` in `session.ts` — one axis per doctrine: raider guard gets `speed`, hammer guard `hull`, anvil guard `damage`; every guard gets `value`.
- Consumes: `warAct`, `commanderOf`, `guardClass` from `src/chart/commander.js` (Session already imports chart logic); `Fleet`'s spawn path (find the exact factory — `HOSTILE_SPECS[kind]` is read at `hostiles.ts:529`; the override threads there).

- [ ] **Step 1: Write the failing playtest assertion**

Force the campaign into the failing act via the probe (`__session.campaign.exhausted = 1`), force the wave roll (expose the roll through a seam: make `spawnWave`'s guard roll read `Math.random()` but let the test set `__session.forceGuard = true` — a localhost-probe field like `arrivedByJump`'s pattern), spawn the next wave, and assert some hostile has `guardName` set and its `spec.value` is above its class's book value.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

`hostiles.ts`: the spawn factory gains an optional `override?: { spec: HostileSpec; guardName: string }`; when present, the `Hostile` is constructed with `override.spec` and gets `guardName` set.

`session.ts` `spawnWave`, after the roster is built:
```ts
const act = warAct(this.campaign);
if (act === "failing" && (this.forceGuard || Math.random() < GUARD.chance) && !this.guardSpawnedThisRun) {
  this.guardSpawnedThisRun = true;
  this.forceGuard = false;
  const commander = commanderOf(this.campaign.seed);
  const kind = guardClass(commander.doctrine) as HostileKind;
  const base = HOSTILE_SPECS[kind];
  const spec: HostileSpec = {
    ...base,
    value: Math.round(base.value * GUARD.value),
    ...(commander.doctrine === "raider" ? { maxSpeed: base.maxSpeed * GUARD.speed } : {}),
    ...(commander.doctrine === "hammer" ? { hull: base.hull * GUARD.hull } : {}),
    ...(commander.doctrine === "anvil" ? { damageScale: base.damageScale * GUARD.damage } : {}),
  };
  // spawn it into the ring alongside the roster with the override
}
```
(`guardSpawnedThisRun` resets in `restart`. The act gate is the attract firewall: the demo's fresh throwaway campaign is never in the failing act.)

`draw.ts:1503`: guard outranks withdrawal in the label:
```ts
const label = best.hostile.guardName
  ? `${best.hostile.guardName}'S GUARD`
  : best.hostile.withdrawing
    ? `${HOSTILE_NAMES[best.hostile.kind]} WITHDRAWING`
    : HOSTILE_NAMES[best.hostile.kind];
```
Same class hue — the name is the distinction, per the spec.

- [ ] **Step 4: Verify** — `npm run typecheck && npm run playtest && npm run campaigntest`.

- [ ] **Step 5: Commit**

```bash
git add src/game/session.ts src/game/hostiles.ts src/hud/draw.ts tools/playtest.mjs
git commit -m "The commander fields a guard when the reserve is failing"
```

---

## Phase G — the record

### Task 16: Amend the standing documents

**Files:**
- Modify: `CLAUDE.md`, `docs/strategy-layer.md`, `docs/todo.md`

- [ ] **Step 1: `CLAUDE.md`** — State section: the campaign is winnable by exhaustion as well as by territory; the commander, the guard, withdrawal, and the shield/near-miss/kill feel work exist. "Next, in order": remove item 2 (campaign balance — closed by this work), note the surviving sink question instead.

- [ ] **Step 2: `strategy-layer.md`** — document `gainGround` beside the enemy's action table (the standing ruling in `campaign-balance.md` §6: same two-step ladder, same price, the mirror of `resolveIncoming`), plus the reserve, the drain, and the exhaustion win.

- [ ] **Step 3: `todo.md`** — close §3.1/§3.2; add the surviving question (a salvage sink that scales with the war, not the front); add the new feel constants (`NEAR_MISS`, `WITHDRAW`, `GUARD`, the ring's timings, the doctrine weights) to the §2 tuning list — they are first-draft guesses like everything else there; record the measured combat-transient segment count from Task 12.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/strategy-layer.md docs/todo.md
git commit -m "Record the broken invasion and the combat work in the standing docs"
```

---

## Sequencing note

Tasks 1→5 are strictly ordered (each consumes the last). Tasks 6–8 depend on 4 and can run in any order among themselves. Task 9 depends on 4 only. Tasks 10–12 are independent of everything (start any time). Task 13 is independent; Task 14 depends on 10 (reuses the streak); Task 15 depends on 4 and 14 (label precedence). Task 16 is last. The in-flight environment work (`docs/environment.md` stages 2–8, and the uncommitted `GasGiant.ts`) continues on its own plan and is untouched by every task here — the one contact point is that combat transients stay in the combat `trace` buffer, which `main.ts` already separates from `skyTrace`.
