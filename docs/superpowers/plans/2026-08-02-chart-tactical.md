# The Chart (Tactical) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the campaign state, the enemy turn, and the in-run tactical chart with hyperwarp — steps 1–3 of [the chart design](../specs/2026-08-02-chart-design.md), ending at something playable.

**Architecture:** A new `src/chart/` owns campaign state, grid geometry, the seeded RNG, persistence and the enemy turn — all of it pure logic with no renderer. A separate `ChartView` draws it through the existing HUD stroke buffer, and `Hyperwarp` adds the in-run jump. The campaign is the only thing that outlives a run.

**Tech Stack:** TypeScript, Three.js, Vite. No new runtime dependencies. Tests are plain node scripts in the style of `tools/playtest.mjs` — hand-rolled assertions, no test framework.

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements implicitly include these.

- **`src/chart/` logic modules must not import `three` and must not touch the DOM or `localStorage` directly.** They are tested in bare node; a `three` import or a `window` reference breaks the test cycle. `ChartView.ts` is the single exception and is not node-tested.
- **`+Z` is forward, `+Y` is up, play happens on the XZ plane.** The world is flat.
- **No DOM text.** Every glyph is stroke-drawn through `Hud`/`strokeFont` in the fixed 800-unit-tall design space.
- **Transient strokes go through `TraceBuffer`**, not new objects and materials.
- **Time-based, not frame-based.** Anything that decays or accumulates uses `dt`.
- **One currency: salvage.** No second resource, ever.
- **Colour is information.** Sector control uses cyan (ours) / magenta (contested) / amber (theirs), per `strategy-layer.md`. No decorative colours.
- **`npm run typecheck` must pass before every commit.** There is no lint step.
- Match the surrounding code's style, comment density and naming. Comments explain *why*, not *what*.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/chart/rng.ts` | Seeded PRNG carrying a cursor, so a reload does not re-roll |
| `src/chart/sectors.ts` | Grid geometry: index ↔ coordinate, adjacency, bounds |
| `src/chart/campaign.ts` | Campaign state, its invariants, and the only mutators |
| `src/chart/enemyTurn.ts` | Pressure budget and spending |
| `src/chart/persistence.ts` | Serialise / restore against injectable storage |
| `src/chart/ChartView.ts` | Draws the chart in tactical mode |
| `src/game/hyperwarp.ts` | The charge-and-jump state machine |
| `tools/campaigntest.mjs` | Node assertions for all of the above logic |
| `tsconfig.campaign.json` | Emits `src/chart` to a scratch dir so node can import it |

**Modified:**

| File | Change |
|---|---|
| `package.json` | `campaigntest` script |
| `.gitignore` | Ignore the campaign build dir |
| `src/game/session.ts` | Hold a `Hyperwarp`; apply jump consequences |
| `src/main.ts` | Own the chart overlay toggle; expose `__campaign` on the probe |
| `src/hud/draw.ts` | Call `ChartView` when the overlay is up |
| `tools/playtest.mjs` | Assertions for hyperwarp and the overlay |

---

### Task 1: The test cycle, the RNG, and grid geometry

Nothing can be tested until node can import the chart modules. This task builds that road and lays the two dependency-free modules on it.

**Files:**
- Create: `tsconfig.campaign.json`, `tools/campaigntest.mjs`, `src/chart/rng.ts`, `src/chart/sectors.ts`
- Modify: `package.json`, `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `makeRng(seed: number, cursor?: number): Rng` where `interface Rng { next(): number; readonly cursor: number }`
  - `GRID: 8`, `SECTOR_COUNT: 64`
  - `indexOf(col: number, row: number): number`, `colOf(i: number): number`, `rowOf(i: number): number`
  - `inBounds(col: number, row: number): boolean`
  - `neighbours(index: number): number[]` — orthogonal, 4-way

- [ ] **Step 1: Create the build config and npm script**

`tsconfig.campaign.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "./.campaign-build",
    "rootDir": "./src"
  },
  "include": ["src/chart"],
  "exclude": ["src/chart/ChartView.ts"]
}
```

`ChartView.ts` is excluded because it imports `three` and is not node-tested.

In `package.json`, add to `scripts`:

```json
"campaigntest": "tsc -p tsconfig.campaign.json && node tools/campaigntest.mjs"
```

Append to `.gitignore`:

```
# Emitted so node can import the chart logic for tests. Never committed.
.campaign-build/
```

- [ ] **Step 2: Write the failing test**

`tools/campaigntest.mjs`:

```js
/**
 * Asserts the campaign rules outside a browser. The chart is pure logic —
 * no renderer, no DOM — so unlike the combat harness this needs neither.
 *
 *   npm run campaigntest
 */
const problems = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) problems.push(`assertion failed: ${label} (${detail})`);
};

const { makeRng } = await import("../.campaign-build/chart/rng.js");
const { GRID, SECTOR_COUNT, indexOf, colOf, rowOf, inBounds, neighbours } =
  await import("../.campaign-build/chart/sectors.js");

// ── rng ─────────────────────────────────────────────────────────────────────
const a = makeRng(12345);
const firstFive = [a.next(), a.next(), a.next(), a.next(), a.next()];
check("rng is in range", firstFive.every((n) => n >= 0 && n < 1), firstFive[0].toFixed(4));

const b = makeRng(12345);
check(
  "same seed replays identically",
  [b.next(), b.next(), b.next(), b.next(), b.next()].every((n, i) => n === firstFive[i]),
  "5 draws",
);

// The cursor is the whole reason this exists: a campaign reloaded mid-way
// must not re-roll the enemy's turn.
const resumed = makeRng(12345, 3);
check("cursor resumes the sequence", resumed.next() === firstFive[3], `cursor=3`);
check("cursor advances with draws", a.cursor === 5, `cursor=${a.cursor}`);

// ── grid ────────────────────────────────────────────────────────────────────
check("grid is 8x8", GRID === 8 && SECTOR_COUNT === 64, `${GRID}x${GRID}`);
check("index round-trips", indexOf(colOf(37), rowOf(37)) === 37, "sector 37");
check("bounds reject off-grid", !inBounds(-1, 0) && !inBounds(0, 8) && inBounds(7, 7), "corners");

const middle = neighbours(indexOf(3, 3));
check("a middle sector has four neighbours", middle.length === 4, `n=${middle.length}`);
const corner = neighbours(indexOf(0, 0));
check("a corner sector has two", corner.length === 2, `n=${corner.length}`);
check(
  "neighbours are orthogonal only",
  !neighbours(indexOf(3, 3)).includes(indexOf(4, 4)),
  "no diagonals",
);

console.log(problems.length ? `\nPROBLEMS:\n${problems.join("\n")}` : "\nno problems");
process.exit(problems.length ? 1 : 0);
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npm run campaigntest`
Expected: FAIL — `tsc` errors that `src/chart` matches no inputs, or the import throws `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement `src/chart/rng.ts`**

```ts
/**
 * A seeded generator that carries its own cursor. The cursor is not a
 * convenience: a campaign is only reproducible if a reload resumes the
 * sequence rather than restarting it, and a restarted sequence silently
 * re-rolls the enemy's turn.
 */
export interface Rng {
  next(): number;
  readonly cursor: number;
}

/** mulberry32 — small, fast, and good enough for a strategy layer. */
export function makeRng(seed: number, cursor = 0): Rng {
  let drawn = 0;
  let state = seed >>> 0;

  const draw = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Fast-forward to where the save left off.
  for (let i = 0; i < cursor; i++) draw();

  return {
    next(): number {
      drawn++;
      return draw();
    },
    get cursor(): number {
      return cursor + drawn;
    },
  };
}
```

- [ ] **Step 5: Implement `src/chart/sectors.ts`**

```ts
/**
 * Grid geometry, kept free of anything that renders. The 8x8 is the 1971
 * geometry, reused.
 */
export const GRID = 8;
export const SECTOR_COUNT = GRID * GRID;

export function indexOf(col: number, row: number): number {
  return row * GRID + col;
}

export function colOf(index: number): number {
  return index % GRID;
}

export function rowOf(index: number): number {
  return Math.floor(index / GRID);
}

export function inBounds(col: number, row: number): boolean {
  return col >= 0 && col < GRID && row >= 0 && row < GRID;
}

/**
 * Orthogonal only. Diagonal adjacency would let the enemy advance on a
 * front twice as wide for the same pressure, which makes holding a line
 * impossible rather than hard.
 */
export function neighbours(index: number): number[] {
  const col = colOf(index);
  const row = rowOf(index);
  const out: number[] = [];
  for (const [dc, dr] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
    if (inBounds(col + dc, row + dr)) out.push(indexOf(col + dc, row + dr));
  }
  return out;
}
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `npm run campaigntest`
Expected: PASS on all 10 assertions, ending `no problems`.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add tsconfig.campaign.json tools/campaigntest.mjs src/chart/rng.ts src/chart/sectors.ts package.json .gitignore
git commit -m "Give the chart a test cycle, a seeded RNG and a grid

The campaign is pure logic, so it is tested in bare node rather than
through a browser. tsc emits src/chart to a scratch directory the tests
import; that is why the chart modules may not import three.

The RNG carries a cursor because a seed alone does not make a campaign
reproducible — a reload would resume a fresh sequence and quietly re-roll
the enemy's turn."
```

---

### Task 2: Campaign state and its mutators

**Files:**
- Create: `src/chart/campaign.ts`
- Modify: `tools/campaigntest.mjs`

**Interfaces:**
- Consumes: `GRID`, `SECTOR_COUNT`, `indexOf`, `rowOf` from `sectors.js`.
- Produces:
  - `type Control = "ours" | "contested" | "theirs"`
  - `type StructureKind = "listening-post" | "outpost" | "starbase" | "yard"`
  - `interface Structure { kind: StructureKind; runsRemaining: number }`
  - `interface Patrol { strength: number }`
  - `interface Sector { control: Control; threat: number; yield: number; structures: Structure[]; patrol?: Patrol }`
  - `interface IncomingMove { sector: number; runsUntil: number }`
  - `interface Campaign { version, seed, rngCursor, runsElapsed, salvage, sectorsLost, refits, sectors, front, current, incoming }`
  - `CAMPAIGN_VERSION: number`, `ENEMY_START_DEPTH: number`
  - `newCampaign(seed: number): Campaign`
  - `creditSalvage(c: Campaign, amount: number): void`
  - `spendSalvage(c: Campaign, amount: number): boolean`
  - `countControl(c: Campaign, control: Control): number`
  - `hasStructure(sector: Sector, kind: StructureKind): boolean`
  - `canDock(sector: Sector): boolean`
  - `isWon(c: Campaign): boolean`, `isLost(c: Campaign): boolean`

> **Note — a deviation from the spec.** The spec's `Campaign` omits `sectorsLost`, but `strategy-layer.md`'s pressure formula depends on it. It is added here as a counter incremented whenever a sector flips to `theirs`.

- [ ] **Step 1: Write the failing test**

Append to `tools/campaigntest.mjs`, before the final `console.log`:

```js
const {
  CAMPAIGN_VERSION, ENEMY_START_DEPTH, newCampaign, creditSalvage,
  spendSalvage, countControl, hasStructure, canDock, isWon, isLost,
} = await import("../.campaign-build/chart/campaign.js");

// ── a fresh campaign ────────────────────────────────────────────────────────
const c = newCampaign(99);
check("a campaign has 64 sectors", c.sectors.length === SECTOR_COUNT, `n=${c.sectors.length}`);
check("it is stamped with a version", c.version === CAMPAIGN_VERSION, `v${c.version}`);
check("it starts with no salvage", c.salvage === 0, `salvage=${c.salvage}`);
check("it starts at run zero", c.runsElapsed === 0 && c.sectorsLost === 0, "counters clear");

const theirs = countControl(c, "theirs");
check(
  "the enemy opens holding ENEMY_START_DEPTH rows",
  theirs === ENEMY_START_DEPTH * GRID,
  `theirs=${theirs}, expected=${ENEMY_START_DEPTH * GRID}`,
);

// You must always have somewhere to launch from, or the first run is
// unplayable — the one thing the design forbids outright.
const starbases = c.sectors.filter((s) => hasStructure(s, "starbase")).length;
check("you open with exactly one starbase", starbases === 1, `n=${starbases}`);
check("the front is a sector you hold", c.sectors[c.front].control === "ours", `front=${c.front}`);
check("you start where you launch from", c.current === c.front, `current=${c.current}`);
check("nothing is inbound yet", c.incoming.length === 0, "clear");
check("a starbase is a dock", canDock(c.sectors.find((s) => hasStructure(s, "starbase"))), "starbase");
check("empty space is not", !canDock(c.sectors[c.front === 0 ? 1 : 0]) || c.front === 0, "bare sector");

// ── salvage ─────────────────────────────────────────────────────────────────
creditSalvage(c, 500);
check("salvage credits", c.salvage === 500, `salvage=${c.salvage}`);
check("affordable spending succeeds", spendSalvage(c, 200) === true, `salvage=${c.salvage}`);
check("...and debits", c.salvage === 300, `salvage=${c.salvage}`);
check("unaffordable spending is refused", spendSalvage(c, 9999) === false, "refused");
check("...and changes nothing", c.salvage === 300, `salvage=${c.salvage}`);
// Drive it well past zero: a clamp that is never crossed is not tested.
creditSalvage(c, -500);
check("salvage never goes negative", c.salvage === 0, `salvage=${c.salvage}`);

// ── win and loss ────────────────────────────────────────────────────────────
check("a fresh campaign is neither won nor lost", !isWon(c) && !isLost(c), "in progress");

const cleared = newCampaign(1);
for (const s of cleared.sectors) if (s.control === "theirs") s.control = "ours";
check("no enemy sectors is a win", isWon(cleared), "front pushed off");

const doomed = newCampaign(2);
for (const s of doomed.sectors) s.structures = s.structures.filter((x) => x.kind !== "starbase");
check("no starbase is a loss", isLost(doomed), "last starbase fell");
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run campaigntest`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `campaign.js`.

- [ ] **Step 3: Implement `src/chart/campaign.ts`**

```ts
import { GRID, SECTOR_COUNT, indexOf, rowOf } from "./sectors.js";

export type Control = "ours" | "contested" | "theirs";
export type StructureKind = "listening-post" | "outpost" | "starbase" | "yard";

export interface Structure {
  kind: StructureKind;
  /** Zero once complete. Construction is paid for in runs, not salvage. */
  runsRemaining: number;
}

export interface Patrol {
  strength: number;
}

export interface Sector {
  control: Control;
  /** 1-5. Drives wave escalation for a run dropped here. */
  threat: number;
  /** 0-3. Multiplies salvage earned here. Correlates with threat by design. */
  yield: number;
  structures: Structure[];
  patrol?: Patrol;
}

/**
 * A committed attack in flight. Pressure buys these; they land a run later.
 * The gap is the whole point — it is what the player can fly out and stop.
 */
export interface IncomingMove {
  sector: number;
  runsUntil: number;
}

export interface Campaign {
  version: number;
  seed: number;
  /** Draws taken. Saved, or a reload re-rolls the enemy's turn. */
  rngCursor: number;
  runsElapsed: number;
  salvage: number;
  /** Feeds the pressure formula: losing ground makes the enemy stronger. */
  sectorsLost: number;
  refits: string[];
  sectors: Sector[];
  /** Index of the sector the next run drops into. */
  front: number;
  /** Index of the sector the player is in right now. Hyperwarp moves it. */
  current: number;
  incoming: IncomingMove[];
}

export const CAMPAIGN_VERSION = 1;

/**
 * Rows the enemy opens holding, counted from the far edge. Three of eight
 * leaves 24 sectors to push off rather than 32 — this is the constant that
 * sets campaign length, and it is tuned by simulation, not by argument.
 */
export const ENEMY_START_DEPTH = 3;

export function newCampaign(seed: number): Campaign {
  const sectors: Sector[] = [];
  for (let i = 0; i < SECTOR_COUNT; i++) {
    const row = rowOf(i);
    const enemy = row < ENEMY_START_DEPTH;
    sectors.push({
      control: enemy ? "theirs" : "ours",
      // Threat and yield both climb toward the enemy edge: the dangerous
      // sectors pay. That is the greed loop, one level up.
      threat: Math.max(1, Math.min(5, GRID - row - 2)),
      yield: Math.max(0, Math.min(3, GRID - row - 4)),
      structures: [],
    });
  }

  // The home starbase. Without one there is nowhere to launch from and the
  // campaign is lost before it begins.
  const home = indexOf(Math.floor(GRID / 2), GRID - 1);
  sectors[home].structures.push({ kind: "starbase", runsRemaining: 0 });

  return {
    version: CAMPAIGN_VERSION,
    seed,
    rngCursor: 0,
    runsElapsed: 0,
    salvage: 0,
    sectorsLost: 0,
    refits: [],
    sectors,
    front: home,
    current: home,
    incoming: [],
  };
}

/** Clamped here rather than at the callers, so no caller can forget. */
export function creditSalvage(campaign: Campaign, amount: number): void {
  campaign.salvage = Math.max(0, campaign.salvage + amount);
}

/** Refuses rather than overdrawing. Returns whether the spend happened. */
export function spendSalvage(campaign: Campaign, amount: number): boolean {
  if (amount > campaign.salvage) return false;
  campaign.salvage -= amount;
  return true;
}

export function countControl(campaign: Campaign, control: Control): number {
  return campaign.sectors.filter((sector) => sector.control === control).length;
}

export function hasStructure(sector: Sector, kind: StructureKind): boolean {
  return sector.structures.some((s) => s.kind === kind && s.runsRemaining === 0);
}

/** Where the multiplier can be realised. Bare sectors have nowhere to bank. */
export function canDock(sector: Sector): boolean {
  return hasStructure(sector, "starbase") || hasStructure(sector, "outpost");
}

/** The war is winnable even though the run is not: push the front off. */
export function isWon(campaign: Campaign): boolean {
  return countControl(campaign, "theirs") === 0;
}

/** Lose the last starbase and everything built is gone. */
export function isLost(campaign: Campaign): boolean {
  return !campaign.sectors.some((sector) => hasStructure(sector, "starbase"));
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npm run campaigntest`
Expected: PASS on every assertion, ending `no problems`.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/chart/campaign.ts tools/campaigntest.mjs
git commit -m "Add the campaign state and its mutators

Salvage is clamped and spending is refused inside the mutators rather
than at the callers, because three separate things write to a campaign —
the enemy turn, the four decisions, and the run tally — and an invariant
enforced at call sites is an invariant that rots.

sectorsLost is not in the design doc but the pressure formula needs it."
```

---

### Task 3: Persistence

**Files:**
- Create: `src/chart/persistence.ts`
- Modify: `tools/campaigntest.mjs`

**Interfaces:**
- Consumes: `Campaign`, `CAMPAIGN_VERSION`, `newCampaign` from `campaign.js`.
- Produces:
  - `SAVE_KEY: string`
  - `interface CampaignStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }`
  - `save(campaign: Campaign, storage: CampaignStorage): void`
  - `load(storage: CampaignStorage, freshSeed: number): Campaign`

- [ ] **Step 1: Write the failing test**

Append to `tools/campaigntest.mjs`, before the final `console.log`:

```js
const { SAVE_KEY, save, load } = await import("../.campaign-build/chart/persistence.js");

/** Stands in for localStorage, which does not exist in node. */
const fakeStorage = (seed = {}) => {
  const data = { ...seed };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    raw: data,
  };
};

const store = fakeStorage();
const original = newCampaign(4242);
original.salvage = 750;
original.runsElapsed = 6;
original.rngCursor = 31;
save(original, store);
const restored = load(store, 1);

check("a save round-trips salvage", restored.salvage === 750, `salvage=${restored.salvage}`);
check("...and the run counter", restored.runsElapsed === 6, `runs=${restored.runsElapsed}`);
check("...and the seed", restored.seed === 4242, `seed=${restored.seed}`);
// The subtle one. Without the cursor a reload re-rolls the enemy's turn.
check("...and the RNG cursor", restored.rngCursor === 31, `cursor=${restored.rngCursor}`);
check(
  "...and the board exactly",
  JSON.stringify(restored.sectors) === JSON.stringify(original.sectors),
  "64 sectors",
);

// A player whose save fails to parse gets a new campaign, not a black screen.
const corrupt = load(fakeStorage({ [SAVE_KEY]: "{not json" }), 7);
check("corrupt saves start fresh", corrupt.seed === 7 && corrupt.salvage === 0, "recovered");

const absent = load(fakeStorage(), 8);
check("absent saves start fresh", absent.seed === 8, "recovered");

const stale = fakeStorage({
  [SAVE_KEY]: JSON.stringify({ ...original, version: CAMPAIGN_VERSION + 99 }),
});
const migrated = load(stale, 9);
check("a future version resets rather than crashing", migrated.seed === 9, "reset");
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run campaigntest`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `persistence.js`.

- [ ] **Step 3: Implement `src/chart/persistence.ts`**

```ts
import { CAMPAIGN_VERSION, newCampaign, type Campaign } from "./campaign.js";

export const SAVE_KEY = "kobayashi.campaign";

/**
 * Injected rather than reaching for localStorage, so the campaign rules stay
 * testable in bare node and the chart modules stay free of the DOM.
 */
export interface CampaignStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function save(campaign: Campaign, storage: CampaignStorage): void {
  storage.setItem(SAVE_KEY, JSON.stringify(campaign));
}

/**
 * Never throws. A player whose save is corrupt, absent, or written by a newer
 * build gets a fresh campaign — a black screen is a worse outcome than a lost
 * campaign, and we do not fight save-scumming anyway.
 */
export function load(storage: CampaignStorage, freshSeed: number): Campaign {
  const raw = storage.getItem(SAVE_KEY);
  if (raw === null) return newCampaign(freshSeed);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return newCampaign(freshSeed);
  }

  if (!isCampaign(parsed) || parsed.version !== CAMPAIGN_VERSION) {
    return newCampaign(freshSeed);
  }
  return parsed;
}

function isCampaign(value: unknown): value is Campaign {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<Campaign>;
  return (
    typeof c.version === "number" &&
    typeof c.seed === "number" &&
    typeof c.rngCursor === "number" &&
    typeof c.salvage === "number" &&
    typeof c.front === "number" &&
    Array.isArray(c.sectors)
  );
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npm run campaigntest`
Expected: PASS, ending `no problems`.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/chart/persistence.ts tools/campaigntest.mjs
git commit -m "Persist a campaign, and never throw doing it

Storage is injected so the rules stay testable in bare node. A corrupt,
absent or future-versioned save starts a new campaign: a black screen is
a worse outcome than a lost campaign.

The RNG cursor is saved with the seed, without which a reload would
resume a fresh sequence and silently re-roll the enemy's turn."
```

---

### Task 4: The enemy turn

**Files:**
- Create: `src/chart/enemyTurn.ts`
- Modify: `tools/campaigntest.mjs`

**Interfaces:**
- Consumes: `Campaign`, `Sector`, `hasStructure` from `campaign.js`; `neighbours` from `sectors.js`; `Rng` from `rng.js`.
- Produces:
  - `PRESSURE: { base: number; perRuns: number; runsPerStep: number }`
  - `ACTION_COST: { consolidate: 1; pushContested: 2; pushOurs: 3; assault: 4 }`
  - `DEFENCE_COST: { patrol: 2; starbase: 3 }`
  - `interface EnemyAction { kind: "consolidate" | "push-contested" | "push-ours" | "assault"; sector: number; cost: number }`
  - `pressureBudget(campaign: Campaign): number`
  - `runEnemyTurn(campaign: Campaign, rng: Rng): EnemyAction[]` — resolves last turn's committed moves, then spends this turn's budget
  - `intercept(campaign: Campaign, sector: number): boolean`

- [ ] **Step 1: Write the failing test**

Append to `tools/campaigntest.mjs`, before the final `console.log`:

```js
const { PRESSURE, ACTION_COST, pressureBudget, runEnemyTurn, intercept } =
  await import("../.campaign-build/chart/enemyTurn.js");

// ── the budget ──────────────────────────────────────────────────────────────
const fresh = newCampaign(11);
check("opening pressure is the base", pressureBudget(fresh) === PRESSURE.base, `p=${pressureBudget(fresh)}`);

const later = newCampaign(11);
later.runsElapsed = 10;
later.sectorsLost = 2;
check(
  "pressure climbs with runs and losses",
  pressureBudget(later) === PRESSURE.base + Math.floor(10 / PRESSURE.runsPerStep) + 2,
  `p=${pressureBudget(later)}`,
);

// ── spending ────────────────────────────────────────────────────────────────
const turn = newCampaign(12);
const rng = makeRng(turn.seed, turn.rngCursor);
const actions = runEnemyTurn(turn, rng);
const spent = actions.reduce((sum, a) => sum + a.cost, 0);
check("the enemy spends something", actions.length > 0, `${actions.length} actions`);
check("...and never overspends", spent <= pressureBudget(newCampaign(12)), `spent=${spent}`);

// The enemy may only act next to ground it already holds. Without this the
// front is meaningless and sectors fall at random.
const startedTheirs = newCampaign(12).sectors.map((s) => s.control === "theirs");
check(
  "the enemy only acts adjacent to itself",
  actions.every(
    (a) => startedTheirs[a.sector] || neighbours(a.sector).some((n) => startedTheirs[n]),
  ),
  "adjacency",
);

// ── the promise that matters ────────────────────────────────────────────────
// "Ignore a sector for four runs and it falls, and it stays fallen."
const neglected = newCampaign(13);
let fellWithin = 0;
const watch = neglected.sectors.findIndex(
  (s, i) => s.control === "ours" && neighbours(i).some((n) => neglected.sectors[n].control === "theirs"),
);
for (let run = 1; run <= 4; run++) {
  neglected.runsElapsed = run;
  const r = makeRng(neglected.seed, neglected.rngCursor);
  runEnemyTurn(neglected, r);
  neglected.rngCursor = r.cursor;
  if (neglected.sectors[watch].control === "theirs" && !fellWithin) fellWithin = run;
}
check("a neglected front sector falls within four runs", fellWithin > 0 && fellWithin <= 4, `run ${fellWithin}`);

// Losses are counted, because the budget depends on them.
check("losing ground is recorded", neglected.sectorsLost > 0, `lost=${neglected.sectorsLost}`);

// ── committed, not instant ──────────────────────────────────────────────────
// Pressure buys a move that lands a run later. The gap is what the player
// can fly out and stop.
const commits = newCampaign(15);
const beforeControl = commits.sectors.map((s) => s.control);
runEnemyTurn(commits, makeRng(15, 0));
check("a push is committed, not applied", commits.incoming.length > 0, `${commits.incoming.length} inbound`);
check(
  "...and nothing has flipped yet",
  commits.sectors.every((s, i) => s.control === beforeControl[i]),
  "board unchanged",
);

const landed = commits.incoming[0].sector;
commits.runsElapsed = 1;
runEnemyTurn(commits, makeRng(15, commits.rngCursor));
check(
  "an unopposed move lands next turn",
  commits.sectors[landed].control !== beforeControl[landed],
  `sector ${landed}`,
);

// Interception: reach it and clear it and the attack never arrives.
const stopped = newCampaign(16);
runEnemyTurn(stopped, makeRng(16, 0));
const doomedSector = stopped.incoming[0].sector;
const controlBefore = stopped.sectors[doomedSector].control;
check("interception reports a hit", intercept(stopped, doomedSector) === true, `sector ${doomedSector}`);
check("intercepting an empty sector reports nothing", intercept(stopped, doomedSector) === false, "already clear");
stopped.runsElapsed = 1;
runEnemyTurn(stopped, makeRng(16, stopped.rngCursor));
check(
  "an intercepted move never lands",
  stopped.sectors[doomedSector].control === controlBefore,
  `sector ${doomedSector} held`,
);

// Determinism: same seed, same war.
const runA = newCampaign(14);
const runB = newCampaign(14);
runEnemyTurn(runA, makeRng(14, 0));
runEnemyTurn(runB, makeRng(14, 0));
check(
  "the same seed produces the same turn",
  JSON.stringify(runA.sectors) === JSON.stringify(runB.sectors),
  "deterministic",
);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run campaigntest`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `enemyTurn.js`.

> **Correction, recorded after execution.** The reference code below had three
> defects, found during implementation and review. The committed source in
> `src/chart/enemyTurn.ts` is authoritative; this block is kept for the
> reasoning, not to be copied.
>
> 1. **The allocation could not pass its own tests.** A fresh board offers eight
>    cost-1 `consolidate` targets, which consume the entire opening budget of 6
>    before any push is affordable — so `incoming` stayed empty and the test
>    block threw. Allocation is now two-phase: expansion is funded before
>    consolidation.
> 2. **Off-by-one in `resolveIncoming`.** `move.runsUntil > 0` made a committed
>    push take two turns to land, contradicting "they land a run later". It is
>    `> 1`.
> 3. **The four-run assertion was a lottery.** It pinned one `findIndex`-picked
>    sector and demanded that one fall. All eight candidates cost 3, so shuffle
>    position alone decided which were funded. It now asserts the promise as the
>    design states it — that neglected ground falls — which holds for 5000/5000
>    seeds at `base: 6`. An earlier attempt to fix this by raising `base` to 9
>    was reverted: it passed only 106/200 seeds and was fitted to one seed.
>
> The determinism assertion also could not fail, because it compared only
> `campaign.sectors` while the whole budget lands in `campaign.incoming`. It now
> compares both.

- [ ] **Step 3: Implement `src/chart/enemyTurn.ts`**

```ts
import { hasStructure, type Campaign, type Sector } from "./campaign.js";
import { neighbours } from "./sectors.js";
import type { Rng } from "./rng.js";

/**
 * Retuned from strategy-layer.md's `3 + floor(runs / 4) + lost * 0.5`.
 * Campaign length is shortened mostly by ENEMY_START_DEPTH — moving less
 * ground — because raising pressure alone only makes the player lose faster.
 * Both constants are first-draft guesses; see the length simulation.
 */
export const PRESSURE = {
  base: 6,
  runsPerStep: 2,
} as const;

export const ACTION_COST = {
  consolidate: 1,
  pushContested: 2,
  pushOurs: 3,
  assault: 4,
} as const;

/** A defended sector costs more to take. Patrols buy turns, not safety. */
export const DEFENCE_COST = {
  patrol: 2,
  starbase: 3,
} as const;

export interface EnemyAction {
  kind: "consolidate" | "push-contested" | "push-ours" | "assault";
  sector: number;
  cost: number;
}

export function pressureBudget(campaign: Campaign): number {
  return (
    PRESSURE.base +
    Math.floor(campaign.runsElapsed / PRESSURE.runsPerStep) +
    campaign.sectorsLost
  );
}

function defenceOf(sector: Sector): number {
  let extra = 0;
  if (sector.patrol) extra += DEFENCE_COST.patrol;
  if (hasStructure(sector, "starbase")) extra += DEFENCE_COST.starbase;
  return extra;
}

/**
 * Spends the budget adjacent to ground already held. Mutates the campaign and
 * returns what it did, so the chart can show the player where the war moved.
 *
 * Cheapest-first: the enemy takes the ground it can afford before the ground
 * it would like. That is what makes an unwatched flank fall while a defended
 * one holds, which is the behaviour the whole layer promises.
 */
export function runEnemyTurn(campaign: Campaign, rng: Rng): EnemyAction[] {
  resolveIncoming(campaign);

  let budget = pressureBudget(campaign);
  const actions: EnemyAction[] = [];

  // Frozen up front: acting on a snapshot stops a sector taken this turn from
  // immediately becoming the springboard for the next one.
  const held = campaign.sectors.map((s) => s.control === "theirs");

  const targets: number[] = [];
  for (let i = 0; i < campaign.sectors.length; i++) {
    if (held[i] || neighbours(i).some((n) => held[n])) targets.push(i);
  }

  // Shuffled so a tie between equally-priced sectors is not always broken the
  // same way. Draws come from the campaign's own generator, so it replays.
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [targets[i], targets[j]] = [targets[j], targets[i]];
  }

  const priced = targets
    .map((index) => ({ index, ...priceOf(campaign.sectors[index], held[index]) }))
    .filter((option) => option.kind !== null)
    .sort((a, b) => a.cost - b.cost);

  for (const option of priced) {
    if (option.cost > budget) continue;
    budget -= option.cost;
    apply(campaign, option.index, option.kind!);
    actions.push({ kind: option.kind!, sector: option.index, cost: option.cost });
  }
  return actions;
}

function priceOf(
  sector: Sector,
  isHeld: boolean,
): { kind: EnemyAction["kind"] | null; cost: number } {
  if (isHeld) {
    // Assault only lands on ground already theirs, per the design table.
    if (sector.structures.length > 0) {
      return { kind: "assault", cost: ACTION_COST.assault };
    }
    if (sector.threat < 5) return { kind: "consolidate", cost: ACTION_COST.consolidate };
    return { kind: null, cost: 0 };
  }
  if (sector.control === "contested") {
    return { kind: "push-contested", cost: ACTION_COST.pushContested + defenceOf(sector) };
  }
  return { kind: "push-ours", cost: ACTION_COST.pushOurs + defenceOf(sector) };
}

function apply(campaign: Campaign, index: number, kind: EnemyAction["kind"]): void {
  const sector = campaign.sectors[index];
  switch (kind) {
    case "consolidate":
      sector.threat = Math.min(5, sector.threat + 1);
      break;
    case "assault":
      // Retaking ground costs more than holding it: what they break is gone.
      sector.structures.pop();
      break;
    case "push-contested":
    case "push-ours":
      // Pushes are committed, not applied. Pressure buys a move; the move
      // lands a run later. That gap is what the player can fly out and stop,
      // and it is why the chart is worth looking at during a run.
      if (!campaign.incoming.some((move) => move.sector === index)) {
        campaign.incoming.push({ sector: index, runsUntil: 1 });
      }
      break;
  }
}

/**
 * Lands whatever the player did not intercept, and brings the rest a run
 * closer. Runs at the start of the enemy's turn so an attack committed last
 * turn resolves before this turn's budget is spent.
 */
function resolveIncoming(campaign: Campaign): void {
  const surviving: typeof campaign.incoming = [];
  for (const move of campaign.incoming) {
    if (move.runsUntil > 0) {
      surviving.push({ sector: move.sector, runsUntil: move.runsUntil - 1 });
      continue;
    }
    const sector = campaign.sectors[move.sector];
    if (sector.control === "ours") {
      sector.control = "contested";
    } else if (sector.control === "contested") {
      sector.control = "theirs";
      campaign.sectorsLost++;
    }
  }
  campaign.incoming = surviving;
}

/**
 * Interception. Reach the target and clear it and the attack never lands —
 * an opportunity, never an objective: ignoring every one of these costs
 * territory on the campaign and never costs you the run.
 */
export function intercept(campaign: Campaign, sector: number): boolean {
  const before = campaign.incoming.length;
  campaign.incoming = campaign.incoming.filter((move) => move.sector !== sector);
  return campaign.incoming.length < before;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npm run campaigntest`
Expected: PASS, ending `no problems`.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/chart/enemyTurn.ts tools/campaigntest.mjs
git commit -m "Let the enemy take its turn

Cheapest-first spending adjacent to ground already held. That ordering is
the whole behaviour: an unwatched flank falls while a defended one holds,
which is what makes patrols buy turns rather than safety.

Targets come from a snapshot taken before any of it is spent, so a sector
taken this turn cannot be the springboard for the next one in the same
turn."
```

---

### Task 5: Campaign length, validated by simulation

The two constants that set campaign length cannot be validated by reasoning. This task measures them.

**Files:**
- Create: `tools/campaignlength.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: no source API. A number you tune against.

- [ ] **Step 1: Write the simulation**

`tools/campaignlength.mjs`:

```js
/**
 * Runs many campaigns against a crude model player and reports how long they
 * take to resolve. This does not say whether the chart is fun. It says
 * whether ENEMY_START_DEPTH and the pressure formula produce the 15-25 run
 * campaign they are supposed to, which is otherwise a discovery that costs an
 * evening.
 *
 *   npm run campaignlength [runs]
 */
const { newCampaign, countControl, isWon, isLost } =
  await import("../.campaign-build/chart/campaign.js");
const { runEnemyTurn } = await import("../.campaign-build/chart/enemyTurn.js");
const { makeRng } = await import("../.campaign-build/chart/rng.js");
const { neighbours } = await import("../.campaign-build/chart/sectors.js");

const TRIALS = Number(process.argv[2] ?? 2000);
const CEILING = 200;

/**
 * The model player retakes one contested or lost sector per run — roughly
 * what a competent run's salvage buys. Deliberately crude: it is a yardstick
 * for the enemy's rate, not a simulation of play.
 */
function modelPlayerTurn(campaign) {
  const retakeable = campaign.sectors
    .map((sector, index) => ({ sector, index }))
    .filter(({ sector }) => sector.control !== "ours")
    .filter(({ index }) =>
      neighbours(index).some((n) => campaign.sectors[n].control === "ours"),
    );
  if (!retakeable.length) return;
  const target = retakeable[0];
  target.sector.control = target.sector.control === "theirs" ? "contested" : "ours";
}

const lengths = [];
let won = 0;
let lost = 0;
let stalled = 0;

for (let trial = 0; trial < TRIALS; trial++) {
  const campaign = newCampaign(trial + 1);
  let run = 0;
  for (; run < CEILING; run++) {
    campaign.runsElapsed = run;
    modelPlayerTurn(campaign);
    const rng = makeRng(campaign.seed, campaign.rngCursor);
    runEnemyTurn(campaign, rng);
    campaign.rngCursor = rng.cursor;
    if (isWon(campaign)) { won++; break; }
    if (isLost(campaign)) { lost++; break; }
  }
  if (run >= CEILING) stalled++;
  lengths.push(run);
}

lengths.sort((a, b) => a - b);
const at = (q) => lengths[Math.floor(lengths.length * q)];
console.log(`trials      ${TRIALS}`);
console.log(`won         ${won}  (${((won / TRIALS) * 100).toFixed(1)}%)`);
console.log(`lost        ${lost}  (${((lost / TRIALS) * 100).toFixed(1)}%)`);
console.log(`unresolved  ${stalled}  (${((stalled / TRIALS) * 100).toFixed(1)}%)`);
console.log(`runs        p10=${at(0.1)}  median=${at(0.5)}  p90=${at(0.9)}`);
console.log(`\ntarget: median within 15-25, unresolved at 0%`);
```

In `package.json`, add to `scripts`:

```json
"campaignlength": "tsc -p tsconfig.campaign.json && node tools/campaignlength.mjs"
```

- [ ] **Step 2: Run it and read the distribution**

Run: `npm run campaignlength`
Expected: it prints a distribution. It does **not** assert — this is a measuring instrument, not a test.

> **Expect longer campaigns than the spec's arithmetic suggests.** Pushes are committed and land a run later, so every sector takes two enemy turns to change hands rather than one. That is the mechanic working, not a bug — but it roughly halves the enemy's effective rate, and `ENEMY_START_DEPTH` is the constant to move first if the median lands high.

- [ ] **Step 3: Tune the two constants against it**

If the median is well outside 15–25, or anything is unresolved:

- Median **too high** → lower `ENEMY_START_DEPTH` in `src/chart/campaign.ts` first. Less ground to move is the cleanest shortener.
- Median **too low** and losses dominate → lower `PRESSURE.base` in `src/chart/enemyTurn.ts`.
- **Unresolved above 0%** → the campaign can deadlock. Report this rather than papering over it; it means neither side can finish, which is a design problem and not a tuning one.

Re-run after each change. Record the final numbers in the commit message.

- [ ] **Step 4: Confirm the rule tests still pass**

Run: `npm run campaigntest`
Expected: PASS. Retuning must not break the four-run promise from Task 4.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add tools/campaignlength.mjs package.json src/chart/campaign.ts src/chart/enemyTurn.ts
git commit -m "Measure campaign length instead of guessing it

ENEMY_START_DEPTH and the pressure formula set how long a campaign runs,
and neither can be validated by argument. This simulates a few thousand
campaigns against a crude model player and reports the distribution.

Record the measured median here when tuning."
```

---

### Task 6: Draw the chart

**Files:**
- Create: `src/chart/ChartView.ts`
- Modify: `src/hud/draw.ts`, `src/main.ts`

**Interfaces:**
- Consumes: `Campaign`, `Control` from `campaign.js`; `GRID`, `colOf`, `rowOf` from `sectors.js`; the `Hud` stroke API.
- Produces:
  - `CHART: { size: number; margin: number }`
  - `drawChart(hud: Hud, campaign: Campaign, opacity: number, cursor: number): void` — `campaign.current` is drawn as where you are, `cursor` as where you are pointing

**Read first:** `src/hud/draw.ts` and `src/hud/Hud.ts` to match the existing stroke-drawing idiom exactly, and `src/render/palette.ts` for the colours. Do not invent a new drawing path.

- [ ] **Step 1: Implement `src/chart/ChartView.ts`**

This is the one chart module that may import `three` (for `Color`) — it is excluded from `tsconfig.campaign.json` for exactly that reason.

```ts
import { Color } from "three";
import { PALETTE } from "../render/palette.js";
import type { Hud } from "../hud/Hud.js";
import { colOf, rowOf, GRID } from "./sectors.js";
import { canDock, type Campaign, type Control } from "./campaign.js";

/** Laid out in the HUD's fixed 800-unit design space, like everything else. */
export const CHART = {
  size: 460,
  margin: 24,
} as const;

/**
 * Control is read as colour, per the design: cyan ours, magenta contested,
 * amber theirs. Threat is ticks on the sector edge, not a number to read.
 */
const CONTROL_COLOR: Record<Control, Color> = {
  ours: PALETTE.player,
  contested: PALETTE.unresolved,
  theirs: new Color(0xffa63d),
};

export function drawChart(
  hud: Hud,
  campaign: Campaign,
  opacity: number,
  cursor: number,
): void {
  if (opacity <= 0) return;

  const cell = CHART.size / GRID;
  const originX = -CHART.size / 2;
  const originY = -CHART.size / 2;

  for (let i = 0; i < campaign.sectors.length; i++) {
    const sector = campaign.sectors[i];
    const x = originX + colOf(i) * cell;
    const y = originY + rowOf(i) * cell;
    const color = CONTROL_COLOR[sector.control];

    hud.rect(x + 2, y + 2, cell - 4, cell - 4, fade(color, opacity * 0.5));

    // Threat as ticks along the bottom edge. A digit would be one more thing
    // to read; ticks are countable at a glance under fire.
    const ticks: number[] = [];
    for (let t = 0; t < sector.threat; t++) {
      const tx = x + 5 + t * 4;
      ticks.push(tx, y + 4, tx, y + 9);
    }
    hud.segments(ticks, fade(color, opacity * 0.8));

    // Somewhere to bank is the single most decision-relevant fact on the map.
    if (canDock(sector)) {
      ring(hud, x + cell / 2, y + cell / 2, cell * 0.18, fade(color, opacity));
    }

    // An attack already committed against this sector. This is the whole
    // reason to look at the chart mid-run rather than only between runs.
    if (campaign.incoming.some((move) => move.sector === i)) {
      ring(hud, x + cell / 2, y + cell / 2, cell * 0.34, fade(CONTROL_COLOR.theirs, opacity));
    }

    // Where you are, versus where you are pointing. Two different marks:
    // confusing them is how a player jumps somewhere they did not mean to.
    if (i === campaign.current) {
      ring(hud, x + cell / 2, y + cell / 2, cell * 0.42, fade(PALETTE.player, opacity));
    }
    if (i === cursor) {
      hud.rect(x, y, cell, cell, fade(PALETTE.player, opacity));
    }
  }
}

/**
 * The HUD has no opacity channel — every stroke's brightness is its colour,
 * which is also how the death sequence browns the whole panel out. Fading is
 * therefore scaling, not blending.
 */
function fade(color: Color, opacity: number): Color {
  return SCRATCH.copy(color).multiplyScalar(opacity);
}
const SCRATCH = new Color();

/** The HUD draws segments; a circle is a closed polygon of them. */
function ring(hud: Hud, cx: number, cy: number, radius: number, color: Color): void {
  const SIDES = 12;
  const flat: number[] = [];
  for (let i = 0; i < SIDES; i++) {
    const a = (i / SIDES) * Math.PI * 2;
    const b = ((i + 1) / SIDES) * Math.PI * 2;
    flat.push(
      cx + Math.cos(a) * radius, cy + Math.sin(a) * radius,
      cx + Math.cos(b) * radius, cy + Math.sin(b) * radius,
    );
  }
  hud.segments(flat, color);
}
```

> **The HUD API, confirmed:** `Hud` exposes `segments(flat: readonly number[], color: Color)` as its primitive — flat `(x0,y0,x1,y1)` quads, origin bottom-left — plus `text`, `textRight`, `rect(x, y, w, h, color)` and `gauge`. There is **no opacity parameter and no circle**, which is why the code above fades by scaling the colour and builds rings from segments. Do not add a new primitive to `Hud`.
>
> `SCRATCH` is reused deliberately to avoid allocating a `Color` per sector per frame. It is safe only because `segments()` copies the colour into its buffer immediately — do not hold the returned `Color` past the call.

- [ ] **Step 2: Wire the overlay into `src/hud/draw.ts` and `src/main.ts`**

In `main.ts`: hold a `campaign` (loaded via `load(window.localStorage, Date.now())`), hold `chartOpacity` eased toward 1 while `Tab` is held and 0 otherwise using `dt`, and pass both through the existing `HudView`. In `draw.ts`, call `drawChart` after the rest of the HUD so it sits on top.

Bind the overlay to **`Tab`**, and add `"tab"` to `DISPLAY_KEYS` in `main.ts` so opening the chart on the title screen does not launch a run. Call `event.preventDefault()` for it alongside the existing space/arrow handling, or the browser moves focus.

Also hold a `chartCursor`, initialised to `campaign.current`. While the overlay is up, `WASD` moves it one sector at a time using `inBounds` so it cannot leave the grid — and while the overlay is up those keys must **not** also fly the ship, or the player banks into a wall while choosing a destination. Route them to the cursor when `chartOpacity > 0.5` and to the flight model otherwise. The arrow keys keep flying the ship either way, so a player who wants to keep manoeuvring while reading the chart still can.

- [ ] **Step 3: Verify by eye**

Run: `npm run dev`, open http://127.0.0.1:5173, press a key to launch, hold `Tab`.
Expected: an 8×8 grid fades up over the play area, three colours, ticks on each cell, a ring on the sector holding your starbase. The game keeps running behind it — hostiles keep moving.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/chart/ChartView.ts src/hud/draw.ts src/main.ts
git commit -m "Draw the chart over the run

Control is colour, threat is ticks rather than a digit — countable at a
glance is what matters when it is drawn over a fight. It fades up out of
the scanner corner and does not pause the game, because pulling up a map
while something is shooting at you is where the escape valve costs
something."
```

---

### Task 7: Hyperwarp

**Files:**
- Create: `src/game/hyperwarp.ts`
- Modify: `src/game/session.ts`, `src/main.ts`

**Interfaces:**
- Consumes: `Ship` from `./Ship.js`.
- Produces:
  - `HYPERWARP: { charge: number; drainPerSecond: number; arrivalEnergy: number }`
  - `type HyperwarpPhase = "idle" | "charging"`
  - `class Hyperwarp { readonly phase: HyperwarpPhase; readonly progress: number; begin(): void; cancel(): void; update(dt: number, player: Ship): boolean }`

- [ ] **Step 1: Implement `src/game/hyperwarp.ts`**

```ts
import type { Ship } from "./Ship.js";

export const HYPERWARP = {
  /** Seconds of held commitment before the jump fires. */
  charge: 2,
  /** Energy per second while charging. Spent whether or not you arrive. */
  drainPerSecond: 0.25,
  /** You arrive cold. Fleeing saves the ship, not the situation. */
  arrivalEnergy: 0.25,
} as const;

export type HyperwarpPhase = "idle" | "charging";

/**
 * The jump is a commitment rather than a button. You can still turn while it
 * spins up and you cannot fire, which is what makes fleeing a fight you are
 * losing a gamble instead of an exit.
 */
export class Hyperwarp {
  phase: HyperwarpPhase = "idle";
  /** 0-1 through the charge. Drawn as a ring on the HUD. */
  progress = 0;

  begin(): void {
    if (this.phase === "idle") this.phase = "charging";
  }

  /** Releasing early spends the energy for nothing. That is the price. */
  cancel(): void {
    this.phase = "idle";
    this.progress = 0;
  }

  get charging(): boolean {
    return this.phase === "charging";
  }

  /** Returns true on the frame the jump fires. */
  update(dt: number, player: Ship): boolean {
    if (this.phase !== "charging") return false;

    player.energy = Math.max(0, player.energy - HYPERWARP.drainPerSecond * dt);
    if (player.energy <= 0) {
      this.cancel();
      return false;
    }

    this.progress += dt / HYPERWARP.charge;
    if (this.progress < 1) return false;

    this.cancel();
    return true;
  }
}
```

- [ ] **Step 2: Wire it into `session.ts`**

Hold a `Hyperwarp`. In the session update, call `update(dt, player)` and on `true`:

```ts
// A jump costs the same as taking a hit, so the game already teaches the
// price. Fleeing saves the ship and costs what you came for.
this.multiplier = Math.max(1, this.multiplier * 0.5);
this.fleet.clear();
this.mines.clear();
player.energy = HYPERWARP.arrivalEnergy;
this.wave = Math.max(0, this.wave - 1); // the destination spawns its own wave

// Arriving somewhere is the point. Without this the jump is a reset button
// and threat and yield never come from anywhere.
this.campaign.current = destination;
this.say("HYPERWARP");
```

`destination` is the chart cursor, passed in from `main.ts` when the jump fires. Wave escalation then reads `this.campaign.sectors[this.campaign.current].threat` instead of using a fixed rate, and salvage earned is scaled by that sector's `yield`.

Clearing a wave while sitting in a sector with a committed attack against it is the interception: call `intercept(this.campaign, this.campaign.current)` where the session already detects a cleared field, and `say("ATTACK BROKEN")` when it returns `true`.

Refuse `begin()` while docked, dying, or already charging — each is a state where the helm is not the player's:

```ts
if (this.state === "dead" || this.docking.phase !== "none") return;
```

Block firing while charging, in whichever method handles weapons.

> If `this.mines.clear()` does not exist, add it to `Minefield` mirroring `Fleet.clear()` — a jump must not carry the old sector's minefield to the new one.

- [ ] **Step 3: Bind it in `main.ts`**

Hold `Shift` to charge; release cancels. The jump's destination is `chartCursor` from Task 6. Refuse `begin()` when the cursor is the sector you are already in — a jump to where you are would cost half the multiplier for nothing, which reads as a bug rather than a price.

Publish on `__probe`: `hyperwarp: session.hyperwarp.phase`, `hyperwarpProgress`, `sector: campaign.current`, and `inbound: campaign.incoming.length`.

Alongside the existing localhost-only globals, also expose `__campaign` (the campaign object), `__chart` (`{ neighbours, indexOf, colOf, rowOf }` re-exported from `sectors.js`), and `__chartCursor` (`{ get(): number; set(i: number): void }`). The harness needs to point the cursor without simulating a keyboard walk across the grid, and these follow the same localhost-only rule as `__probe`.

- [ ] **Step 4: Verify by hand**

Run `npm run dev`, launch a run, build the multiplier above 1 by killing something, hold `Tab` and move the cursor with `WASD` to a different sector, then hold `Shift`.
Expected: energy drains, you cannot fire, and after ~2s the field clears, the multiplier halves, and the chart shows you in the new sector. Release early and nothing happens except lost energy. Jumping into a higher-threat sector should visibly escalate the waves.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/game/hyperwarp.ts src/game/session.ts src/main.ts
git commit -m "Add hyperwarp as an escape valve with a price

Halving the multiplier is the same cost as letting something reach the
hull, so it needs no explaining. Runs still escalate until you die; what
a jump saves is the ship, and what it costs is what you came for.

The two-second charge is what makes it a gamble — you cannot fire while
it spins up, and releasing early spends the energy for nothing."
```

---

### Task 8: Cover it in the combat harness

**Files:**
- Modify: `tools/playtest.mjs`

**Interfaces:**
- Consumes: the `__probe` fields added in Task 7.

- [ ] **Step 1: Write the failing assertions**

Add to `tools/playtest.mjs` after the existing late-classes section, before the beauty shots:

```js
// ── hyperwarp ───────────────────────────────────────────────────────────────
await page.evaluate(() => {
  window.__session.wave = 1;
  window.__fleet.clear();
  window.__player.energy = 1;
});
state = await waitFor((s) => s.hostiles > 0, 20000);

// Build a multiplier worth losing, so halving it is observable.
await page.evaluate(() => { window.__session.multiplier = 4; });

// A jump to the sector you are already in is refused, so point somewhere
// else first — the same thing a player does with Tab and WASD.
await page.evaluate(() => {
  const { neighbours } = window.__chart;
  window.__chartCursor.set(neighbours(window.__campaign.current)[0]);
});

await page.keyboard.down("Shift");
state = await waitFor((s) => s.hyperwarp === "charging", 5000);
check("hyperwarp charges", state.hyperwarp === "charging", `phase=${state.hyperwarp}`);

// The charge is the commitment. Firing through it would make fleeing free.
const torpsBefore = (await probe()).torpedoes;
await page.keyboard.press("x");
await page.waitForTimeout(300);
check(
  "weapons are locked while charging",
  (await probe()).torpedoes === torpsBefore,
  `torpedoes=${torpsBefore}`,
);

const sectorBefore = (await probe()).sector;
state = await waitFor((s) => s.multiplier <= 2, 15000);
await page.keyboard.up("Shift");
check("arriving halves the multiplier", state.multiplier <= 2, `x${state.multiplier}`);
check("...and you arrive cold", state.energy < 0.6, `energy=${state.energy}`);
// Without this the jump is a reset button rather than travel.
check("...and somewhere else", state.sector !== sectorBefore, `${sectorBefore} → ${state.sector}`);

// ── the overlay does not pause the game ─────────────────────────────────────
const waveBefore = (await probe()).wave;
await page.keyboard.down("Tab");
await waitFor((s) => s.wave > waveBefore, 30000);
await page.keyboard.up("Tab");
check("the chart does not stop the wave clock", (await probe()).wave > waveBefore, `wave>${waveBefore}`);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run dev` in one shell, then `npm run playtest`.
Expected: FAIL on `hyperwarp charges` if Task 7's probe fields are missing.

- [ ] **Step 3: Fix whatever it catches, then run until green**

Run: `npm run playtest`
Expected: PASS on all assertions, ending `no problems`.

- [ ] **Step 4: Run it twice**

Run: `npm run playtest` again.
Expected: identical result. A harness that passes once is not a harness — this file's own comments say a flaky check is worse than no check.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add tools/playtest.mjs
git commit -m "Assert hyperwarp and the overlay in the harness

The weapons lock during the charge is the assertion that matters: firing
through a jump would make fleeing free, which is the one thing the
pricing is supposed to prevent.

The overlay check proves the chart does not pause the game — a paused
chart turns the escape valve into a safe one."
```

---

### Task 9: Bring the documentation back in line

**Files:**
- Modify: `CLAUDE.md`, `docs/status.md`

- [ ] **Step 1: Update `CLAUDE.md`**

- Add `src/chart/` to the Architecture block: "campaign state, the enemy turn, persistence, and the chart renderer".
- In **State**, move the chart out of "Not built" and record what exists: campaign state, the enemy turn, persistence, the tactical overlay and hyperwarp. The *command view* and the four decisions remain unbuilt.
- In **Next, in order**, replace item 3 with the command view.
- Add to **Run it**: `npm run campaigntest` and `npm run campaignlength`.
- Add to **Decisions that are locked**: hyperwarp is an escape valve priced at half the multiplier, and refits persist through death.
- Add to **Gotchas**: chart logic modules must not import `three` or touch the DOM, because `tools/campaigntest.mjs` imports them in bare node.

- [ ] **Step 2: Update `docs/status.md`**

Add a section covering what the chart layer now does, the measured campaign-length distribution from Task 5, and move the three resolved open questions out of §7 into the record, noting how each was resolved.

- [ ] **Step 3: Verify everything still passes**

```bash
npm run typecheck
npm run campaigntest
npm run playtest
```
Expected: all three clean.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/status.md
git commit -m "Bring the docs in line with the chart

Records the three open questions as resolved and why, and notes the
constraint that the chart logic modules stay free of three and the DOM
so they can be tested in bare node."
```

---

## Out of scope

Deliberately not in this plan — they are the second plan, per the spec's §10:

- The command view and the four decisions (build, refit, deploy, front).
- Structure construction, patrols as a fielded unit, and the refit table.
- The death → tally → chart handoff, and with it the between-runs cycle that actually advances `runsElapsed` and calls `runEnemyTurn`. **This plan builds the enemy turn and tests it directly, but nothing in the running game calls it yet** — a run does not yet lead to another run. That wiring is the first thing the second plan does.
- Patrols drawn in-sector during a run.

Note that committed attacks and interception *are* in this plan, because §4 of the spec puts fleets-on-a-clock in the tactical half. What is missing until plan two is only the loop that would generate them during real play.
