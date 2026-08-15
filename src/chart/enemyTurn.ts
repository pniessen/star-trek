import { countControl, hasStructure, ENEMY_START_DEPTH, type Campaign, type Sector } from "./campaign.js";
import { GRID, neighbours } from "./sectors.js";
import { RESERVE, reserveOf } from "./reserve.js";
import { commanderOf, type Doctrine } from "./commander.js";
import type { Rng } from "./rng.js";

export { RESERVE, reserveOf };

/**
 * Retuned from strategy-layer.md's `3 + floor(runs / 4) + lost * 0.5`.
 * Campaign length is shortened mostly by ENEMY_START_DEPTH — moving less
 * ground — because raising pressure alone only makes the player lose faster.
 * Both constants are first-draft guesses; see the length simulation.
 *
 * A fresh board offers eight cost-1 consolidate targets (one per column on
 * the enemy's own border row) before a single push is ever affordable at
 * ACTION_COST.pushOurs — at base 6 that's enough on its own to eat the whole
 * opening budget. See `runEnemyTurn`'s docblock for why that is handled by
 * spending in two phases rather than one flat cheapest-first pass.
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

/**
 * The commander's doctrine (Task 4's `commanderOf`) is a bias on which of a
 * turn's priced options gets funded first, not a second budget: it multiplies
 * `cost` before the sort in `runEnemyTurn`, so a weight below 1 makes that
 * action sort cheaper — preferred — and a weight above 1 makes it sort more
 * expensive, spent only once cheaper options run out. Raider spreads its
 * budget over contested ground; Hammer commits deep, into the player's own
 * sectors and dug-in positions; Anvil holds what it has taken. The two-phase
 * split in `runEnemyTurn` (expansion before consolidate) is untouched —
 * weights reorder *within* each phase, they do not move consolidate ahead of
 * expansion or the reverse.
 *
 * These are the design table's values, unflattened. §2.2's per-doctrine
 * balance guard (`node tools/campaignlength.mjs 1000 --sweep=4 --vary
 * --ceiling=40`, checked against the per-doctrine breakdown in
 * `campaignlength.mjs`) found Hammer running noticeably hot at Task 3's band
 * row — 88–91% won at reach 4 against Raider/Anvil's 81–85%, because weighted
 * `push-ours` (base 3 × 0.7) undercuts weighted `push-contested` (base 2 ×
 * 1.2) at every defence level, so Hammer always opens a fresh front rather
 * than closing one it has already pushed into.
 *
 * It was flattened toward 1 and put back. A weighting that flips that
 * ordering (`push-ours`/`push-contested` ≳ 0.9) does bring Hammer's won%
 * down among the other two, but only by erasing the same push-ours
 * preference this file's own TDD test (`tools/campaigntest.mjs`, "hammer
 * fights heavier than raider") measures — flattened enough to move the
 * guard, Hammer's assault+push-ours share collapses to Raider's and that
 * test goes from GREEN to a tie. It doesn't even clear the guard's original
 * line: weight 1 on every kind (no doctrine effect at all) still won 82.9%
 * at this band row.
 *
 * That is because the guard's absolute 20–80% was written against
 * `campaign-balance.md`'s criterion (a) — reach 4 landing in the 30–70%
 * pooled band. (a) was waived 2026-08-14: criterion (b) wins the conflict
 * between them (`campaign-balance.md`'s addendum), and reach 4's ~83%
 * pooled win rate is the adopted result of that ruling, not a bug this
 * module inherited. A doctrine guard bounded against a criterion the owner
 * has already waived can't be met by any weight table — 80% sits below the
 * unweighted baseline itself.
 *
 * Resolved the same day: the guard is **relative**, not absolute — no
 * doctrine may deviate more than ±10 points won from the no-weights
 * baseline at the band row, which keeps its actual intent (doctrine changes
 * texture, not difficulty) without inheriting a bound the owner has already
 * moved past. 2026-08-14 measurement, `node tools/campaignlength.mjs 1000
 * --sweep=4 --vary --ceiling=40`, reach 4: baseline (weight 1 throughout)
 * 82.9%; raider 84.3% (+1.4), hammer 90.9% (+8.0), anvil 82.2% (+0.7) — all
 * inside ±10, Hammer nearest the edge. Weights below are the design table's
 * exact values, unflattened.
 */
export const DOCTRINE_WEIGHTS: Record<Doctrine, Record<EnemyAction["kind"], number>> = {
  raider: { "push-contested": 0.6, "push-ours": 1.2, assault: 1.4, consolidate: 1.0 },
  hammer: { "push-contested": 1.2, "push-ours": 0.7, assault: 0.6, consolidate: 1.1 },
  anvil: { "push-contested": 1.1, "push-ours": 1.3, assault: 1.2, consolidate: 0.5 },
};

/**
 * Sectors the enemy holds beyond the depth it opened with. This is what
 * `campaign.sectorsLost` was trying to be, read live off the board instead of
 * accumulated: `sectorsLost` only ever increments, so a campaign that lost
 * ground and then retook it stayed charged for ground it no longer holds.
 * Deriving it from the board means retaking a sector lowers this — and the
 * pressure budget with it — the instant control flips back.
 *
 * Floored at zero, and that floor has a history worth keeping.
 *
 * The floor was deleted 2026-08-13 on `campaign-balance.md` §5's own
 * recommendation: it called the old behaviour "indefensible on its own
 * terms", because retaking ground below the enemy's opening depth was free
 * for them — the term bottomed out at zero going either direction, so a
 * deep advance bought the player nothing the formula could pay out.
 *
 * Measurement falsified the combination the same day. Candidate C's
 * contested band — the one `campaign-balance.md` §3 measured and
 * recommended — was measured *with* this floor intact. Unfloored, this term
 * goes sharply negative the instant the player leads at all, and it
 * collapses `ambition` (and with it the enemy's entire spend) to zero within
 * two to four runs of that lead opening — independent of any `RESERVE`
 * constant, because `pressureBudget` clamps to `min(ambition, reserve ×
 * commit)` and no reserve value can raise a term that is stuck at zero. A
 * traced campaign at reach 4 showed the budget go 4 → 2 → 1 → 0 by run four
 * and never recover; every reach from 3 upward then resolves as pure
 * territorial arithmetic, with the invasion paralysed and the whole reserve
 * mechanic this module exists for never once exercised.
 *
 * Restored 2026-08-14 by the owner's ruling. The unfairness the deletion was
 * answering is real, but it is now paid through the correct ledger: every
 * step of ground the player retakes drains the reserve directly, via
 * `costPerStep` in `gainGround`. A deep push already costs the invasion
 * something under this term — in *stock*, which this module tracks, rather
 * than in *ambition*, which this function computes fresh every turn and has
 * no memory. The floor stays; the drain is where "the enemy pays for lost
 * ground" now actually lives.
 */
function sectorsHeldBeyondStart(campaign: Campaign): number {
  return Math.max(0, countControl(campaign, "theirs") - ENEMY_START_DEPTH * GRID);
}

export function pressureBudget(campaign: Campaign): number {
  const clock = Math.floor(campaign.runsElapsed / PRESSURE.runsPerStep);
  // No outer floor needed: `sectorsHeldBeyondStart` is floored at zero on its
  // own, and `PRESSURE.base` is always positive, so the sum never goes
  // negative.
  const ambition = PRESSURE.base + clock + sectorsHeldBeyondStart(campaign);

  // The formula above is what the enemy would like to spend; what it can
  // spend is whatever is left in the reserve. Replenishment and the player's
  // drain are applied in `runEnemyTurn`, which is the only thing that takes a
  // turn.
  return Math.min(ambition, Math.floor(reserveOf(campaign) * RESERVE.commit));
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
 * Spent in two phases, cheapest-first within each: expansion (pushes and
 * assaults) first, consolidate only with whatever is left over. A single
 * flat cheapest-first pass would let consolidate — cheap, and always
 * available in bulk on the enemy's own border row — buy out the entire
 * budget before a single push is ever affordable, so the front would never
 * move at all. Splitting the phases is what makes an unwatched flank fall
 * while a defended one holds, which is the behaviour the whole layer
 * promises.
 */
export function runEnemyTurn(campaign: Campaign, rng: Rng): EnemyAction[] {
  resolveIncoming(campaign);

  /**
   * Replenishment happens before the spend and from the board as it stands
   * after last turn's pushes landed, so ground taken during the run is
   * ground that does not pay for this turn's attack.
   *
   * Exhaustion is measured on *arrival*, before the resupply lands, and it has
   * to be — measured after, it is unreachable arithmetic.
   *
   * The first version counted an empty reserve at the end of the turn, after
   * regen and after the spend. That can never happen. Regen puts at least
   * `regenFlat` in the pot before anything is spent, and `commit` caps a turn's
   * spending at a fraction of what is held, so the closing balance has a hard
   * floor of about half the resupply. The counter never incremented, `isWon`
   * never fired, and every measured campaign under this term ran to the turn
   * cap unresolved — the exact "removes the defeat, supplies no victory"
   * failure the term was written to avoid, arrived at by an off-by-one-phase
   * rather than by the design being wrong.
   *
   * The player's fighting *was* draining it to nothing all along, in
   * `economy.ts` as ground is taken. What was missing is that the drain was
   * only ever observed one instant after being refilled.
   *
   * Arrival is also the reading that means something. "The invasion began this
   * turn with nothing left" is what broken looks like from the board; "it spent
   * down to nothing and was immediately resupplied" is just a busy turn.
   */
  const arrived = reserveOf(campaign);
  campaign.exhausted = arrived < 1 ? (campaign.exhausted ?? 0) + 1 : 0;

  campaign.reserve = Math.min(
    RESERVE.max,
    arrived + RESERVE.regenFlat + RESERVE.regenPerSector * countControl(campaign, "theirs"),
  );

  let budget = pressureBudget(campaign);
  const spendable = budget;
  const actions: EnemyAction[] = [];

  // Frozen up front as defence-in-depth: nothing in this turn's spending
  // currently flips control directly (a push only lands via resolveIncoming,
  // on a later turn), so this snapshot and a live read agree today. If that
  // ever changes, acting on the snapshot rather than live sectors is what
  // stops a sector taken this turn from becoming this same turn's springboard.
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

  const weights = DOCTRINE_WEIGHTS[commanderOf(campaign.seed).doctrine];
  const priced = targets
    .map((index) => ({ index, ...priceOf(campaign.sectors[index], held[index]) }))
    .filter((option) => option.kind !== null)
    .sort((a, b) => a.cost * weights[a.kind!] - b.cost * weights[b.kind!]);

  // Expansion first, consolidate only with what's left — see the docblock
  // above for why the order matters.
  const expansion = priced.filter((option) => option.kind !== "consolidate");
  const reinforcement = priced.filter((option) => option.kind === "consolidate");

  for (const option of [...expansion, ...reinforcement]) {
    if (option.cost > budget) continue;
    budget -= option.cost;
    apply(campaign, option.index, option.kind!);
    actions.push({ kind: option.kind!, sector: option.index, cost: option.cost });
  }

  // Only what was actually spent comes out — budget the enemy could not place
  // for want of a target stays in the reserve, which is what lets a compressed
  // invasion bank for one hard counter-attack instead of evaporating.
  campaign.reserve = reserveOf(campaign) - (spendable - budget);
  // The exhaustion counter is *not* touched here. It is measured on arrival,
  // at the top of this function, for the reason given there: a closing balance
  // has a floor built into it by regen and `commit`, so counting it here can
  // never see zero and the victory can never fire.

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
    if (move.runsUntil > 1) {
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
