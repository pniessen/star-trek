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
