import { type Campaign, type StructureKind } from "./campaign.js";
import {
  build,
  deployPatrol,
  hasAnyStructure,
  isFitted,
  isRefitYard,
  loadoutOf,
  patrolCapacity,
  patrolCount,
  PATROL,
  REFITS,
  STRUCTURES,
  structureSpec,
  toggleRefit,
  type RefitId,
} from "./economy.js";
import { colOf, rowOf } from "./sectors.js";

/**
 * The four decisions, as one flat list.
 *
 * Deliberately flat: `strategy-layer.md`'s rule is four decisions on one
 * screen with no submenus, and the cheapest way to be certain of that is for
 * there to be nothing to descend into. Everything the player can do between
 * runs is a row here, in the order the design states as a sentence — spend,
 * equip, position, go. `front` is last because it is the commitment.
 *
 * Logic only; `ChartView.ts` draws this list and `main.ts` moves through it.
 */

export type DecisionKind = "build" | "refit" | "deploy" | "front";

export interface Decision {
  readonly kind: DecisionKind;
  /** Structure kind, refit id, or the literal "patrol" / "front". */
  readonly id: string;
  readonly label: string;
  /** Salvage. Zero means free, which is only ever the front. */
  readonly cost: number;
  /** The second column: build time, or the tradeoff, or the effect. */
  readonly detail: string;
}

export const HEADINGS: Record<DecisionKind, string> = {
  build: "BUILD",
  refit: "REFIT",
  deploy: "DEPLOY",
  front: "FRONT",
};

export const DECISIONS: readonly Decision[] = [
  ...STRUCTURES.map(
    (spec): Decision => ({
      kind: "build",
      id: spec.kind,
      label: spec.label,
      cost: spec.cost,
      detail: `${spec.runs} RUN${spec.runs === 1 ? "" : "S"}   ${spec.effect}`,
    }),
  ),
  ...REFITS.map(
    (spec): Decision => ({
      kind: "refit",
      id: spec.id,
      label: spec.label,
      cost: spec.cost,
      detail: `${spec.gain}   ${spec.price}`,
    }),
  ),
  {
    kind: "deploy",
    id: "patrol",
    label: "PATROL",
    cost: PATROL.cost,
    detail: "HOLDS A SECTOR   TAKES ATTRITION",
  },
  {
    kind: "front",
    id: "front",
    label: "DROP HERE NEXT RUN",
    cost: 0,
    detail: "THREAT SETS THE WAVES   YIELD PAYS",
  },
];

/** Sector name as it reads on the chart: column letter, row number. */
export function sectorName(index: number): string {
  return `${String.fromCharCode(65 + colOf(index))}${rowOf(index) + 1}`;
}

/**
 * Why this decision cannot be taken at this sector right now, or null if it
 * can. Returned as the line the panel shows rather than a boolean, because a
 * greyed-out row that will not say why is the thing that makes a strategy
 * screen feel like a form.
 */
export function refusal(campaign: Campaign, decision: Decision, sector: number): string | null {
  const target = campaign.sectors[sector];

  switch (decision.kind) {
    case "build": {
      if (target.control !== "ours") return `${sectorName(sector)} IS NOT YOURS TO BUILD IN`;
      if (hasAnyStructure(target, decision.id as StructureKind)) {
        return `${sectorName(sector)} ALREADY HAS ONE`;
      }
      return afford(campaign, decision.cost);
    }
    case "refit": {
      // Removing what is already fitted is free, and free is never refused.
      if (isFitted(campaign, decision.id as RefitId)) return null;
      if (!isRefitYard(target)) return "REFIT NEEDS A STARBASE  MOVE THE CURSOR TO ONE";
      return afford(campaign, decision.cost);
    }
    case "deploy": {
      if (target.control === "theirs") return "A PATROL HOLDS GROUND  IT CANNOT TAKE IT";
      const patrol = target.patrol;
      if (patrol && patrol.strength >= PATROL.maxStrength) {
        return `${sectorName(sector)} PATROL IS AT FULL STRENGTH`;
      }
      if (!patrol && patrolCount(campaign) >= patrolCapacity(campaign)) {
        return `NO SPARE PATROLS  ${patrolCount(campaign)} OF ${patrolCapacity(campaign)} IN THE FIELD`;
      }
      return afford(campaign, decision.cost);
    }
    case "front":
      // Never refused, ever. Any sector is a legal drop even holding none of
      // them, which is the guarantee that no chart decision can leave a player
      // with nowhere to fly.
      return null;
  }
}

function afford(campaign: Campaign, cost: number): string | null {
  return campaign.salvage >= cost ? null : `NEEDS ${cost}  YOU HAVE ${Math.round(campaign.salvage)}`;
}

/**
 * Takes the decision, or explains why it was not taken. Changes nothing on
 * refusal — every mutator underneath refuses rather than overdrawing, so this
 * is belt and braces rather than the only guard.
 */
export function decide(campaign: Campaign, decision: Decision, sector: number): string {
  const no = refusal(campaign, decision, sector);
  if (no) return no;

  switch (decision.kind) {
    case "build": {
      const kind = decision.id as StructureKind;
      if (!build(campaign, sector, kind)) return "REFUSED";
      const spec = structureSpec(kind);
      return `${spec.label} LAID DOWN AT ${sectorName(sector)}  ${spec.runs} RUN${spec.runs === 1 ? "" : "S"}`;
    }
    case "refit": {
      const id = decision.id as RefitId;
      const removing = isFitted(campaign, id);
      if (!toggleRefit(campaign, id)) return "REFUSED";
      return `${decision.label} ${removing ? "STRIPPED" : "FITTED"}`;
    }
    case "deploy": {
      const reinforcing = campaign.sectors[sector].patrol !== undefined;
      if (!deployPatrol(campaign, sector)) return "REFUSED";
      return `PATROL ${reinforcing ? "REINFORCED" : "FIELDED"} AT ${sectorName(sector)}`;
    }
    case "front":
      campaign.front = sector;
      return `NEXT RUN DROPS AT ${sectorName(sector)}`;
  }
}

/**
 * A one-line loadout summary for the panel header. Reads the same fold the
 * ship reads, so the screen can never claim a loadout the ship is not flying.
 */
export function loadoutSummary(campaign: Campaign): string {
  if (campaign.refits.length === 0) return "STANDARD HULL";
  const loadout = loadoutOf(campaign.refits);
  return [
    `SHIELDS ${percent(loadout.shieldCapacity)}`,
    `TURN ${percent(loadout.turnRate)}`,
    `RESERVE ${percent(loadout.energyReserve)}`,
    // The beam's two refits are range and shape, so both are reported: a
    // summary that only showed capacities would say nothing at all about the
    // pair of refits that cost the most.
    `BEAM ${percent(loadout.phaserRange)}${loadout.phaserFlat ? " FLAT" : ""}`,
    `TORP +${loadout.torpedoCapacity}`,
  ].join("   ");
}

function percent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
