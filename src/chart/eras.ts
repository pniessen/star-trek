/**
 * Which ship you fly, and what it costs you.
 *
 * Four hulls from four eras. They differ in outline *and* in behaviour, and the
 * second half is the part that needed a rule, because a purely cosmetic choice
 * is free and a purely powerful one is not a choice at all.
 *
 * **The rule is the refits' rule: a tradeoff, never an upgrade.** `economy.ts`
 * states it for refits — "if the ship simply got better, early runs would be a
 * tax you pay for having started" — and it applies with more force here, since a
 * hull is picked once and flown for a whole war. If one era dominated, picking a
 * ship would collapse into remembering which one is correct. So every era pays
 * for what it is given, and the baseline pays nothing and gets nothing.
 *
 * The four were chosen for **silhouette** before behaviour, because that is the
 * binding constraint in this renderer. A hull is read at two or three units on
 * screen, often overlapping something else, so eras separated by surface detail
 * cannot be told apart — which is why the movie-era refit is deliberately absent.
 * It is the same topology as the Constitution, and everything that distinguishes
 * the two is shading this game does not have. These four differ in *proportion*:
 * how big the saucer is relative to everything, where the nacelles sit, and
 * whether there is a neck at all.
 *
 * Logic only — no `three`, no DOM — like the rest of `src/chart/`, so the hull
 * profiles can be asserted in bare node. The geometry lives in
 * `geometry/hulls.ts` and is keyed by the same ids.
 */

export type EraId = "constitution" | "nx" | "galaxy" | "defiant";

export interface EraSpec {
  readonly id: EraId;
  readonly label: string;
  /** The year it enters service, for the panel. Flavour, not a rule. */
  readonly era: string;
  /** One line on how it flies. Shown beside the label. */
  readonly gain: string;
  /** And what it gives up. Never empty except for the baseline. */
  readonly price: string;
  /** Multipliers folded into the loadout. Absent keys mean 1. */
  readonly mods: Readonly<Partial<EraMods>>;
}

export interface EraMods {
  shieldCapacity: number;
  energyReserve: number;
  reserveRegen: number;
  turnRate: number;
  acceleration: number;
  phaserCost: number;
  /** Scales the sphere that projectiles test against. Above one is a bigger target. */
  hullRadius: number;
  /** Scales damage that gets past the shields. Below one is a tougher skin. */
  hullArmour: number;
}

/**
 * The baseline is deliberately first and deliberately unmodified.
 *
 * Every other era is read as a departure from this one, which is also why it is
 * the ship a new campaign starts in: the first war anyone fights should be the
 * one the rest of the game's numbers were tuned against.
 */
export const ERAS: readonly EraSpec[] = [
  {
    id: "constitution",
    label: "CONSTITUTION",
    era: "2245",
    gain: "BALANCED",
    price: "NO SPECIALISATION",
    mods: {},
  },
  {
    /**
     * The oldest hull, and the one with no real shields.
     *
     * Its whole character is that the facings cannot be relied on, which inverts
     * the defensive skill the game is built around rather than merely weakening
     * it: you are going to be hit, so the question stops being "which quarter do
     * I present" and becomes "can I take it". The tough skin is what makes that
     * a strategy instead of a punishment.
     */
    id: "nx",
    label: "NX PATHFINDER",
    era: "2151",
    gain: "ARMOURED HULL  QUICK HELM",
    price: "SHIELDS BARELY WORTH THE NAME",
    mods: { shieldCapacity: 0.55, hullArmour: 0.6, turnRate: 1.12, energyReserve: 0.9 },
  },
  {
    /**
     * The largest hull, and the only one whose size is a liability the physics
     * can actually see.
     *
     * Reserve and shields both go up, which would be a straight upgrade if the
     * cost were only handling — so the cost is `hullRadius`. A bigger ship is a
     * bigger target, tested against the same projectiles, and that is a price
     * paid every second rather than one you notice in a turn.
     */
    id: "galaxy",
    label: "GALAXY EXPLORER",
    era: "2363",
    gain: "DEEP RESERVE  HEAVY SHIELDS",
    price: "SLOW HELM  A MUCH BIGGER TARGET",
    mods: {
      energyReserve: 1.4,
      shieldCapacity: 1.25,
      turnRate: 0.78,
      acceleration: 0.85,
      hullRadius: 1.35,
    },
  },
  {
    /**
     * The warship: everything spent on the pass and nothing on the campaign.
     *
     * Fast, small, and cheap on the trigger, against a reserve and facings that
     * cannot sustain anything. It is the era that most rewards the greed loop and
     * punishes it hardest — a fat multiplier on this hull is one mistake from
     * halving.
     */
    id: "defiant",
    label: "DEFIANT ESCORT",
    era: "2371",
    gain: "FAST  SMALL  EFFICIENT GUNS",
    price: "THIN SHIELDS  SHALLOW RESERVE",
    mods: {
      acceleration: 1.35,
      turnRate: 1.28,
      phaserCost: 0.8,
      energyReserve: 0.7,
      shieldCapacity: 0.72,
      hullRadius: 0.82,
    },
  },
];

export function eraSpec(id: EraId): EraSpec {
  return ERAS.find((spec) => spec.id === id) ?? ERAS[0];
}

/** The era a campaign with nothing recorded is flying. */
export const DEFAULT_ERA: EraId = "constitution";
