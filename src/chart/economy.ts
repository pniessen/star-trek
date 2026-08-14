import { DEFAULT_ERA, type EraId, eraSpec } from "./eras.js";
import {
  hasStructure,
  newCampaign,
  spendSalvage,
  type Campaign,
  type Sector,
  type StructureKind,
} from "./campaign.js";
import { reserveOf, runEnemyTurn, type EnemyAction } from "./enemyTurn.js";
import { RESERVE } from "./reserve.js";
import { neighbours } from "./sectors.js";
import type { Rng } from "./rng.js";

/**
 * What salvage buys, what it costs to keep, and the tick that happens between
 * one run and the next.
 *
 * Logic only — no `three`, no DOM — so `tools/campaigntest.mjs` can import it
 * in bare node through `tsconfig.campaign.json`. Everything that draws lives in
 * `ChartView.ts`, which is the one file that config excludes.
 *
 * One currency: salvage. Costs and build times are `strategy-layer.md`'s table
 * verbatim; where that document leaves a number open it is marked below.
 */

// ── structures ──────────────────────────────────────────────────────────────

export interface StructureSpec {
  readonly kind: StructureKind;
  readonly label: string;
  readonly cost: number;
  /** Runs to complete. Time is the cost; it cannot be bought out. */
  readonly runs: number;
  readonly effect: string;
}

export const STRUCTURES: readonly StructureSpec[] = [
  {
    kind: "listening-post",
    label: "LISTENING POST",
    cost: 250,
    runs: 1,
    effect: "READS ADJACENT SECTORS",
  },
  { kind: "outpost", label: "OUTPOST", cost: 600, runs: 2, effect: "DOCK  REFUEL AND REARM" },
  { kind: "starbase", label: "STARBASE", cost: 1600, runs: 4, effect: "DOCK  REPAIR AND REFIT" },
  { kind: "yard", label: "YARD", cost: 2400, runs: 5, effect: "A SECOND PATROL  REBUILDS LOSSES" },
];

export function structureSpec(kind: StructureKind): StructureSpec {
  // Non-null: STRUCTURES covers every member of the StructureKind union, and
  // the compiler checks that by construction of the literal above.
  return STRUCTURES.find((spec) => spec.kind === kind)!;
}

/** Complete or not. Duplicates are refused, so a half-built one still blocks. */
export function hasAnyStructure(sector: Sector, kind: StructureKind): boolean {
  return sector.structures.some((structure) => structure.kind === kind);
}

/**
 * Places a structure and debits immediately. Refuses rather than overdrawing,
 * the same way `spendSalvage` does, so no caller has to remember to check.
 *
 * Nothing is refunded if the enemy breaks it mid-build — `enemyTurn.ts`'s
 * assault pops the structure whatever its `runsRemaining`. Building on the
 * front is meant to be a gamble; a refund would make it a free one.
 */
export function build(campaign: Campaign, index: number, kind: StructureKind): boolean {
  const sector = campaign.sectors[index];
  if (sector.control !== "ours") return false;
  if (hasAnyStructure(sector, kind)) return false;
  const spec = structureSpec(kind);
  if (!spendSalvage(campaign, spec.cost)) return false;
  sector.structures.push({ kind, runsRemaining: spec.runs });
  return true;
}

// ── refits ──────────────────────────────────────────────────────────────────

export type RefitId =
  | "reinforced-facings"
  | "torpedo-racks"
  | "capacitor-bank"
  | "focusing-coils"
  | "ablative-plating"
  | "impulse-tuning"
  | "dilithium-matrix";

export interface RefitSpec {
  readonly id: RefitId;
  readonly label: string;
  readonly cost: number;
  /** What it buys, and what it costs you. Both are shown; neither is optional. */
  readonly gain: string;
  readonly price: string;
}

/**
 * Every one is a tradeoff, never an upgrade — if the ship simply got better,
 * early runs would be a tax you pay for having started. Straight from
 * `strategy-layer.md`; the wording is compressed to fit the panel, the
 * numbers are not.
 */
export const REFITS: readonly RefitSpec[] = [
  {
    id: "reinforced-facings",
    label: "REINFORCED FACINGS",
    cost: 400,
    gain: "+40% SHIELD CAPACITY",
    price: "-15% REGENERATION",
  },
  {
    id: "torpedo-racks",
    label: "TORPEDO RACKS",
    cost: 350,
    gain: "+6 TORPEDOES",
    price: "-10% TURN RATE",
  },
  {
    id: "capacitor-bank",
    label: "CAPACITOR BANK",
    cost: 500,
    gain: "+25% ENERGY RESERVE",
    price: "PHASER FALLOFF STEEPENS",
  },
  {
    id: "focusing-coils",
    label: "FOCUSING COILS",
    cost: 550,
    gain: "PHASER HOLDS FULL DAMAGE",
    price: "+30% ENERGY PER SHOT",
  },
  {
    id: "ablative-plating",
    label: "ABLATIVE PLATING",
    cost: 700,
    gain: "FIRST HULL HIT ABSORBED",
    price: "NO SHIELD REGEN WHEN HULLED",
  },
  {
    id: "dilithium-matrix",
    label: "DILITHIUM MATRIX",
    cost: 1200,
    gain: "+60% ENERGY RESERVE",
    price: "-35% RESERVE REGEN",
  },
  {
    id: "impulse-tuning",
    label: "IMPULSE TUNING",
    cost: 450,
    gain: "+20% ACCELERATION",
    price: "-15% MAXIMUM SHIELDS",
  },
];

export function refitSpec(id: RefitId): RefitSpec {
  return REFITS.find((spec) => spec.id === id)!;
}

/**
 * The ship the refits describe, as multipliers the combat model already has
 * variables for. Kept as one flat object rather than a list of behaviours so
 * that `Ship` and `Session` read numbers rather than re-deriving the table.
 */
export interface Loadout {
  /** Scales the trickle that refills the reserve. Below one is a bigger tank filling slower. */
  reserveRegen: number;
  /** Scales the sphere projectiles test against. The era sets it; refits do not. */
  hullRadius: number;
  /** Scales damage that gets past the shields. Below one is a tougher skin. */
  hullArmour: number;
  /** Scales what a full facing absorbs. Shields stay 0-1 so the gauge stays honest. */
  shieldCapacity: number;
  shieldRegen: number;
  torpedoCapacity: number;
  turnRate: number;
  /** Scales the reserve by making everything drawn from it proportionally cheaper. */
  energyReserve: number;
  /** Multiplies the range at which phaser damage reaches zero. */
  phaserRange: number;
  /** Focusing coils: full damage all the way out to that range. */
  phaserFlat: boolean;
  phaserCost: number;
  acceleration: number;
  ablative: boolean;
  regenStopsWhenHulled: boolean;
}

export const NO_REFITS: Loadout = {
  shieldCapacity: 1,
  shieldRegen: 1,
  torpedoCapacity: 0,
  turnRate: 1,
  energyReserve: 1,
  reserveRegen: 1,
  hullRadius: 1,
  hullArmour: 1,
  phaserRange: 1,
  phaserFlat: false,
  phaserCost: 1,
  acceleration: 1,
  ablative: false,
  regenStopsWhenHulled: false,
};

/**
 * Folds the fitted refits into one loadout. Multipliers compound, which is why
 * the two that touch shield capacity — reinforced facings and impulse tuning —
 * partly cancel rather than one silently winning.
 *
 * Note the deliberate interaction between the two phaser refits: the capacitor
 * bank shortens the range at which the beam dies, and the focusing coils flatten
 * damage out to whatever that range now is. Fit both and you hold full damage to
 * a *shorter* distance — so the capacitor's price survives the coils rather than
 * being erased by them, which is what would have turned the pair into a pure
 * upgrade.
 */
export function loadoutOf(refits: readonly string[], era: EraId = DEFAULT_ERA): Loadout {
  const loadout: Loadout = { ...NO_REFITS };
  /**
   * The era goes on first, and the refits multiply on top of it.
   *
   * Order does not matter arithmetically — these are all products — but it
   * matters for reading: the hull is what you are flying and the refits are what
   * you bolted to it, so a loadout is "a Defiant with focusing coils" rather than
   * "coils, on a Defiant". Every era key is optional and absent means one, so the
   * baseline hull is genuinely a no-op rather than a table of 1.0s.
   */
  for (const [key, value] of Object.entries(eraSpec(era).mods)) {
    (loadout as unknown as Record<string, number>)[key] *= value as number;
  }
  for (const id of refits) {
    switch (id as RefitId) {
      case "reinforced-facings":
        loadout.shieldCapacity *= 1.4;
        loadout.shieldRegen *= 0.85;
        break;
      case "torpedo-racks":
        loadout.torpedoCapacity += 6;
        loadout.turnRate *= 0.9;
        break;
      case "capacitor-bank":
        loadout.energyReserve *= 1.25;
        loadout.phaserRange *= 0.75;
        break;
      case "focusing-coils":
        loadout.phaserFlat = true;
        loadout.phaserCost *= 1.3;
        break;
      case "ablative-plating":
        loadout.ablative = true;
        loadout.regenStopsWhenHulled = true;
        break;
      /**
       * The capacitor bank's bigger sibling, and its price is the honest one for
       * a bigger store: it takes longer to fill.
       *
       * Every refit here is a tradeoff and not an upgrade, because a ship that
       * simply got better would make early runs a tax for having started. So
       * this is not "more energy" — it is *more energy at once, less energy over
       * time*, which is a real choice against the bank rather than a strictly
       * better version of it. Take the bank to keep your rhythm; take the matrix
       * to buy one long engagement and accept the lull after it.
       */
      case "dilithium-matrix":
        loadout.energyReserve *= 1.6;
        loadout.reserveRegen *= 0.65;
        break;
      case "impulse-tuning":
        loadout.acceleration *= 1.2;
        loadout.shieldCapacity *= 0.85;
        break;
    }
  }
  return loadout;
}

export function isFitted(campaign: Campaign, id: RefitId): boolean {
  return campaign.refits.includes(id);
}

/** Somewhere to swap a loadout. `strategy-layer.md`: at a starbase, not anywhere. */
export function isRefitYard(sector: Sector): boolean {
  return hasStructure(sector, "starbase");
}

/**
 * Fits or removes a refit. Fitting costs; removing is free and refunds nothing,
 * so churning a loadout every run is possible and expensive — which is the
 * shape "swappable, not permanent" needs to have if salvage is to keep meaning
 * anything after the first few runs.
 *
 * @returns whether the loadout changed.
 */
export function toggleRefit(campaign: Campaign, id: RefitId): boolean {
  const at = campaign.refits.indexOf(id);
  if (at >= 0) {
    campaign.refits.splice(at, 1);
    return true;
  }
  if (!spendSalvage(campaign, refitSpec(id).cost)) return false;
  campaign.refits.push(id);
  return true;
}

// ── patrols ─────────────────────────────────────────────────────────────────

/**
 * `strategy-layer.md` prices every structure and every refit and leaves the
 * patrol's own cost open, so these two numbers are first-draft guesses in the
 * same category as the flight-model constants — the cheapest thing on the
 * list, priced under a listening post, at a strength that makes the
 * document's "an unsupported patrol on the front dies in ~3 runs" literally
 * true.
 *
 * Deliberately repeatable rather than capped: `campaign-balance.md` §5 found
 * that a finite invasion is the only candidate under which salvage does
 * anything, and only if it has a sink — patrol capacity at "one plus a yard"
 * saturates a player's spending inside a week, so the DEPLOY row stopped
 * mattering once it did. Uncapping it is the cheapest sink that respects "one
 * currency, four decisions, no submenus": no new row, no new screen, the
 * player just keeps taking the decision they already had. One-per-sector and
 * the strength ceiling still bound it, so it converts salvage into attrition
 * rather than into an unbounded wall.
 */
export const PATROL = {
  cost: 200,
  /** Fielded at full strength; reinforcing tops it back up to here. */
  maxStrength: 3,
} as const;

export function patrolCount(campaign: Campaign): number {
  return campaign.sectors.filter((sector) => sector.patrol).length;
}

/**
 * Fields a new patrol, or reinforces one already there. Refuses in enemy-held
 * space — a patrol holds ground, it does not take it — and refuses to
 * reinforce one already at full strength. No cap on how many can be fielded:
 * one to a sector is the only ceiling, so salvage is the limit.
 */
export function deployPatrol(campaign: Campaign, index: number): boolean {
  const sector = campaign.sectors[index];
  if (sector.control === "theirs") return false;
  const existing = sector.patrol;
  if (existing && existing.strength >= PATROL.maxStrength) return false;
  if (!spendSalvage(campaign, PATROL.cost)) return false;
  if (existing) existing.strength = Math.min(PATROL.maxStrength, existing.strength + 1);
  else sector.patrol = { strength: PATROL.maxStrength };
  return true;
}

// ── taking ground ───────────────────────────────────────────────────────────

/**
 * The only thing in the game that moves a sector back toward you.
 *
 * `resolveIncoming` in `enemyTurn.ts` steps a sector one place toward the enemy
 * when a committed push lands; this is that same step in the other direction,
 * and clearing a wave in the sector you are standing in is what spends it. It
 * exists because without it `isWon` — zero enemy sectors — is unreachable from
 * play: build, refit, deploy and front spend, equip, position and commit, and
 * not one of them takes ground. A war the design says can be won had no way of
 * being won.
 *
 * Deliberately the same two-step ladder the enemy climbs, so retaking ground
 * costs exactly what losing it did and neither side has a cheaper gear.
 */
export function gainGround(campaign: Campaign, index: number): boolean {
  const sector = campaign.sectors[index];
  if (sector.control === "ours") return false;

  // The invasion is finite: ground taken costs it strength it has to make
  // back, so a run is the weapon and not only the bookkeeping — and holding a
  // line you cannot advance still wins the war eventually.
  campaign.reserve = Math.max(0, reserveOf(campaign) - RESERVE.costPerStep);

  if (sector.control === "theirs") {
    sector.control = "contested";
    return true;
  }
  if (sector.control === "contested") {
    sector.control = "ours";
    return true;
  }
  return false;
}

// ── between runs ────────────────────────────────────────────────────────────

export interface RunReport {
  /** What the enemy bought with its pressure, for the command view to report. */
  readonly actions: readonly EnemyAction[];
  readonly completed: readonly StructureKind[];
  readonly patrolsLost: number;
  readonly patrolsRebuilt: number;
}

/**
 * One run's worth of clock, applied to the campaign. Called once when a run
 * ends and never during one.
 *
 * The order is load-bearing. Construction ticks first so a structure that
 * finished this run is standing when the enemy spends — a starbase completing
 * on the same turn it is attacked should defend itself. The enemy turn comes
 * next, resolving last turn's committed pushes before buying this turn's.
 * Attrition comes last so a patrol fielded a moment ago raises the enemy's
 * cost for one full turn before it starts reporting losses; the other order
 * would make the first run of a patrol's life free for the enemy.
 *
 * `rngCursor` is written here rather than by the caller, for the same reason
 * `creditSalvage` clamps here: a caller that forgets silently re-rolls the
 * enemy's next turn on reload, and that is invisible until someone tries to
 * reproduce a campaign.
 */
export function advanceCampaign(campaign: Campaign, rng: Rng): RunReport {
  campaign.runsElapsed++;
  const completed = tickConstruction(campaign);
  const actions = runEnemyTurn(campaign, rng);
  const { lost, rebuilt } = wearPatrols(campaign);
  campaign.rngCursor = rng.cursor;
  return { actions, completed, patrolsLost: lost, patrolsRebuilt: rebuilt };
}

function tickConstruction(campaign: Campaign): StructureKind[] {
  const completed: StructureKind[] = [];
  for (const sector of campaign.sectors) {
    for (const structure of sector.structures) {
      if (structure.runsRemaining <= 0) continue;
      structure.runsRemaining--;
      if (structure.runsRemaining === 0) completed.push(structure.kind);
    }
  }
  return completed;
}

/**
 * Attrition is exposure, not time. A patrol parked behind the line keeps its
 * strength indefinitely; one on the front loses a point a run, so an
 * unsupported patrol there is gone in three — the figure `strategy-layer.md`
 * promises. A Yard rebuilds what is lost rather than preventing the loss, so
 * the front still grinds a patrol down, it just never finishes the job.
 */
function wearPatrols(campaign: Campaign): { lost: number; rebuilt: number } {
  const yard = campaign.sectors.some((sector) => hasStructure(sector, "yard"));
  let lost = 0;
  let rebuilt = 0;

  for (let i = 0; i < campaign.sectors.length; i++) {
    const sector = campaign.sectors[i];
    const patrol = sector.patrol;
    if (!patrol) continue;

    const exposed =
      sector.control !== "ours" ||
      neighbours(i).some((n) => campaign.sectors[n].control === "theirs");
    if (!exposed) continue;

    patrol.strength--;
    if (patrol.strength > 0) continue;
    if (yard) {
      patrol.strength = 1;
      rebuilt++;
    } else {
      sector.patrol = undefined;
      lost++;
    }
  }
  return { lost, rebuilt };
}

// ── the attract demo's firewall ─────────────────────────────────────────────

/** The shell around a run. Structurally identical to `PresentationMode`. */
export type ShellMode = "title" | "attract" | "run" | "command";

/**
 * Which campaign a given shell mode is allowed to write to.
 *
 * The demo pilot flies the real session — that is the whole point of the
 * attract loop — and the session banks salvage into whatever campaign it holds.
 * So the moment banking credits a campaign at all, an unattended cabinet starts
 * spending the player's salvage and moving the player's front. The chart design
 * doc names this failure mode outright, and the symptom is quiet: nothing
 * crashes, the save simply drifts while nobody is playing.
 *
 * The split is attended versus unattended, not run versus not-run: the command
 * view is between runs and writes to the player's campaign on purpose, while
 * the title screen sits behind a live session that could still bank.
 *
 * Stated as a function rather than an `if` at the one call site so it can be
 * asserted in bare node, and so a second call site cannot get it wrong.
 */
export function campaignFor(mode: ShellMode, player: Campaign, demo: Campaign): Campaign {
  return mode === "title" || mode === "attract" ? demo : player;
}

/**
 * Starts a fresh war inside the existing object.
 *
 * Every part of the game holds a reference to one campaign — the session, the
 * HUD, the debug probe — so a campaign that has been won or lost is replaced in
 * place rather than swapped out. Rebinding would leave whichever holder was
 * missed playing against the board that no longer exists, and that holder would
 * be found by a player, not by a compiler.
 */
export function restartCampaign(campaign: Campaign, seed: number): void {
  Object.assign(campaign, newCampaign(seed));
}
