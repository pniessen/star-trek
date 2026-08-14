import { hash } from "./naming.js";
import { countControl, ENEMY_START_DEPTH, type Campaign } from "./campaign.js";
import { GRID } from "./sectors.js";
import { RESERVE, reserveOf } from "./reserve.js";

/**
 * The war has a face. One commander per war, derived from the campaign seed
 * the same arithmetic-not-storage way `naming.ts` derives every sector and
 * station name — nothing here is persisted, and a new war gets a new
 * commander by construction, with no migration to write and nothing that can
 * disagree with the seed it came from.
 *
 * Own-universe, per the locked decision: every word below is invented, and
 * none of them are borrowed from the genre.
 */

const GIVEN = [
  "SERRAX", "KAVEN", "ODRA", "THALEN", "MIRECK", "VOSSA", "ARDIN", "KELWE",
  "SANDRIX", "THURA", "BELLAN", "ORIS",
] as const;

const SURNAME = [
  "VOL", "KURR", "DRACE", "MHAL", "TESSEK", "ORVANE", "KAETH", "SULM",
  "VARR", "ENNIK", "THAAL", "RUVEN",
] as const;

const PRONOUN = ["SHE", "HE", "THEY"] as const;

/**
 * The three shapes a war can be commanded in. Each is a bias on the enemy
 * turn's spending (Task 5) and names which hostile class stands guard over
 * the commander (`guardClass`, and Task 15's spawn). The doctrine is not
 * flavour text sitting beside the numbers — it is read by both.
 */
export type Doctrine = "raider" | "hammer" | "anvil";

const DOCTRINES: readonly Doctrine[] = ["raider", "hammer", "anvil"];

export interface Commander {
  readonly given: string;
  readonly surname: string; // what dispatches and labels use
  readonly pronoun: "SHE" | "HE" | "THEY";
  readonly doctrine: Doctrine;
}

/**
 * Distinct salts per field (201–204) so that, say, two commanders who share a
 * given name are not thereby forced to share a doctrine too — each draw is
 * independent of the others even though all four come from the same seed.
 */
export function commanderOf(seed: number): Commander {
  return {
    given: GIVEN[hash(seed, 201) % GIVEN.length],
    surname: SURNAME[hash(seed, 202) % SURNAME.length],
    pronoun: PRONOUN[hash(seed, 203) % PRONOUN.length],
    doctrine: DOCTRINES[hash(seed, 204) % DOCTRINES.length],
  };
}

/**
 * Which hostile class the doctrine's guard is. Plain strings, not
 * HostileKind — chart modules cannot import from src/game/. The values are
 * spelled to match HostileKind exactly; Session narrows them.
 */
export function guardClass(doctrine: Doctrine): "swarmer" | "brawler" | "sniper" {
  switch (doctrine) {
    case "raider":
      return "swarmer";
    case "hammer":
      return "brawler";
    case "anvil":
      return "sniper";
  }
}

/** The war's current band, read live off the board rather than stored. */
export type WarAct = "surge" | "contested" | "failing";

export function warAct(campaign: Campaign): WarAct {
  if ((campaign.exhausted ?? 0) > 0) return "failing";
  const reserve = reserveOf(campaign);
  if (reserve <= RESERVE.regenFlat) return "failing";
  const theirs = countControl(campaign, "theirs");
  if (theirs >= ENEMY_START_DEPTH * GRID && reserve >= RESERVE.max * 0.6) return "surge";
  return "contested";
}
