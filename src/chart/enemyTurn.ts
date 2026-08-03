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
  base: 9,
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

  // Expansion (pushes and assaults) spends first, cheapest-first; consolidate
  // spends only what expansion leaves behind. A single global cheapest-first
  // pass lets consolidate — cheap, and always available in bulk on the
  // enemy's own border row — buy out the whole budget before a single push
  // is ever affordable, so the front never moves. Consolidation is what the
  // enemy does with what's left over, not what it does first.
  const expansion = priced.filter((option) => option.kind !== "consolidate");
  const reinforcement = priced.filter((option) => option.kind === "consolidate");

  for (const option of [...expansion, ...reinforcement]) {
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
