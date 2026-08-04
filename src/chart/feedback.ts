/**
 * Candidate feedback terms, behind a switch that is off.
 *
 * The campaign has no feedback in it. The enemy's pressure budget grows with
 * the clock and with the ground it has taken; the player's rate of taking
 * ground back is whatever their flying is worth and does not change. Two rates
 * race, one of them accelerating, so the war is decided by their ratio on the
 * first run and the remaining twenty are a formality — measurably so: nothing
 * between five steps of ground a run (every campaign lost) and six (nearly
 * every campaign won). See `docs/campaign-balance.md`.
 *
 * This module holds the terms proposed to fix that, each one behind a name.
 * **Nothing in `src/` ever calls `setFeedback`**, so the shipped game runs with
 * every term off and behaves exactly as it did before this file existed. Only
 * `tools/campaignlength.mjs` turns them on, via `--feedback=`, and the point of
 * that is to measure them against thousands of seeds before anyone commits to
 * one. Adopting a candidate means moving its rule into `enemyTurn.ts` or
 * `economy.ts` unconditionally and deleting this file, not shipping the switch.
 *
 * Logic only — no `three`, no DOM — like the rest of `src/chart/` bar
 * `ChartView.ts`, so `tools/campaigntest.mjs` can import it in bare node.
 */

/**
 * Every term this file knows about. A name outside this list is a typo, and a
 * typo that silently measures the unmodified game as though it were a
 * candidate is the one failure mode worth spending eight lines to prevent.
 */
export const TERMS: readonly string[] = [];

const active = new Set<string>();

/**
 * Turns on a plus-joined set of terms — `"supply+entrench"`, or `"none"`.
 * Throws on an unknown name rather than ignoring it, for the reason above.
 */
export function setFeedback(spec: string): void {
  active.clear();
  for (const raw of spec.split("+")) {
    const name = raw.trim().toLowerCase();
    if (name === "" || name === "none") continue;
    if (!TERMS.includes(name)) {
      throw new Error(`unknown feedback term "${name}" — known: ${TERMS.join(", ") || "(none yet)"}`);
    }
    active.add(name);
  }
}

export function feedbackOn(term: string): boolean {
  return active.has(term);
}

/** What is on, for the instrument to print beside its numbers. */
export function describeFeedback(): string {
  return active.size === 0 ? "none" : [...active].sort().join("+");
}
