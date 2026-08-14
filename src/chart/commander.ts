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

/**
 * Reserve level at or below which `warAct`'s second leg calls the war
 * "failing", independent of `exhausted`.
 *
 * Measured 2026-08-14, the same day as the `regenFlat` retune this reads:
 * drove `.campaign-build`'s `newCampaign`/`gainGround`/`advanceCampaign`
 * through the `campaignlength.mjs` model player at reach 4 — the low end of
 * a competent player's plausible steps-per-run — across 1000 seeded
 * campaigns, and sampled `reserveOf(campaign)` at the *start* of every run
 * (before that run's own `gainGround` calls could drain it — the same
 * sampling `Session.actAtRunStart` performs; see `warAct`'s own docblock for
 * why that distinction is the whole fix). Fraction of run starts reading
 * failing, by candidate threshold (`exhausted > 0` always counts as failing
 * too, at every threshold, and never fired in this model — a reach-4 run
 * never drives the reserve to zero, per `RESERVE.costPerStep`'s own
 * docblock: a turn closes with at least about half of `regenFlat` in the
 * pot):
 *
 *   threshold                  all runs   first half   last 3 of a won war
 *   RESERVE.regenFlat (24)       19.8%        8.8%            99.6%
 *   regenFlat * 0.75 (18)        14.6%        6.1%            93.3%
 *   regenFlat * 0.5  (12)         0.0%        0.0%             0.0%
 *
 * `regenFlat * 0.5` never fires except through `exhausted`, so it fails
 * "common in the last few runs before a win" outright. `regenFlat` itself
 * clears "rare in the first half" (target: <10%) but only just, at 8.8% —
 * close enough that a rougher run of seeds could plausibly cross it.
 * `regenFlat * 0.75` clears the same bar with real margin (6.1%) while
 * staying just as reliably common in a won war's last few runs (93.3%), so
 * it is what is adopted.
 */
const FAILING_RESERVE = RESERVE.regenFlat * 0.75;

/**
 * The war's current band, read live off the board rather than stored.
 *
 * "Failing" has two legs: `exhausted > 0` (nothing left for
 * `RESERVE.brokenFor` turns straight, a fact about the whole war) and the
 * reserve alone at or below `FAILING_RESERVE`. Both are cheap to read live —
 * but reading the second one live *during* a run asks the wrong question.
 * `gainGround` drains `campaign.reserve` by `RESERVE.costPerStep` for every
 * step of ground the run currently in progress takes, so a fresh, healthy
 * war reads "failing" a couple of waves into any ordinary run, purely
 * because the run is doing what a run does. The rule is meant to describe
 * the reserve *arriving* low — a fact about the war between runs — not
 * being spent low by the run reading it.
 *
 * So a caller that holds its read for the length of a run (`Session`'s
 * commander's guard and its dispatch fallback) must call this once, at the
 * moment the run begins, and hold the result — `Session.actAtRunStart` is
 * that latch. A caller that is inherently a between-run read — the deck log,
 * composed before the run it describes has spent anything, and the command
 * view, which only ever runs between turns — is already correct calling
 * this fresh every time, and neither needs to change.
 */
export type WarAct = "surge" | "contested" | "failing";

export function warAct(campaign: Campaign): WarAct {
  if ((campaign.exhausted ?? 0) > 0) return "failing";
  const reserve = reserveOf(campaign);
  if (reserve <= FAILING_RESERVE) return "failing";
  const theirs = countControl(campaign, "theirs");
  if (theirs >= ENEMY_START_DEPTH * GRID && reserve >= RESERVE.max * 0.6) return "surge";
  return "contested";
}
