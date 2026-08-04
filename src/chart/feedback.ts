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
export const TERMS: readonly string[] = ["supply", "entrench", "reserve"];

/**
 * **Supply lines.** The invasion is supplied from the space it occupies, so
 * everything it spends scales with the ground it holds — including the
 * escalation. Today the clock term `floor(runs / 2)` grows for ever whatever
 * the board looks like, and the territory term is floored at zero, so pushing
 * the enemy below the depth it started at buys nothing at all. Under this term
 * there is no floor and no free clock: reduce them to half their ground and
 * their whole war effort halves.
 *
 * The fiction is the plainest of the three and the player can read it straight
 * off the chart — the command view already reports what the enemy bought, so
 * "they did less this turn because I took CASSEN 12 last run" is a sentence the
 * screen can already almost say.
 *
 * `floor` exists because a budget of zero reads as a bug rather than as a
 * broken invasion; one point still buys a consolidate.
 */
export const SUPPLY = {
  floor: 1,
};

/**
 * **Entrenchment.** Budget the enemy cannot spend advancing, it spends digging
 * in, and dug-in ground has to be broken before it will move.
 *
 * This is the term the board is already almost running. `runEnemyTurn` spends
 * expansion first and consolidate with whatever is left, and consolidate is
 * very nearly a no-op — it raises threat, threat caps at five, and the enemy's
 * own two back rows open at five already. So a losing invasion, whose frontier
 * has shrunk until there is nothing left to push into, currently throws most of
 * its budget away. Here it puts it into the ground instead.
 *
 * The feedback runs the right way by construction: the further the player
 * pushes, the fewer targets the enemy has, the more surplus it has to fortify
 * with, and the more each remaining sector costs to take. It slows the player
 * down exactly when they are winning and does nothing at all while they are
 * losing — which is the sign the shipped formula has backwards.
 *
 * Perceivable, and on a channel the chart already owns: entrenchment is a
 * second row of ticks on the sector edge, and in the run it is waves you clear
 * that do not move the sector yet. Note that `Session` currently says "SECTOR
 * TAKEN" on any truthy `gainGround`, so adopting this wants a third line —
 * something like "DEFENCES BREACHED" — or it will claim ground it did not take.
 *
 * `max` is what stops the endgame becoming a wall: three is the most any one
 * sector can be dug into, so the last row costs five clears rather than two and
 * never costs infinity.
 */
export const ENTRENCH = {
  max: 3,
};

/**
 * **The invasion is finite.** The enemy has a reserve rather than an
 * allowance. It replenishes from the ground it holds, everything it spends
 * comes out of it, and — this is the part the other two candidates have no
 * equivalent of — **fighting drains it**. Every step of ground a run takes
 * costs the invasion strength it has to make back.
 *
 * That last clause is why this is a different kind of term rather than a third
 * flavour of the first two. Both of those act on the enemy's *rate*; this one
 * gives the war a *stock*, which does three things nothing else here does:
 *
 *  - **A stalemate stops being a draw.** Holding the line while clearing waves
 *    drains them even if the front never moves, so a war that is going nowhere
 *    still resolves. The measured objection to capping the pressure formula was
 *    that it turned losses into deadlocks; a cap removes the defeat without
 *    supplying a victory, and this is the victory.
 *  - **The clock stops being the whole war.** `floor(runs / 2)` grows for ever
 *    and nothing answers it. Here it is retained as the enemy's *ambition* and
 *    the reserve is its *means*, so escalation is something the invasion has to
 *    be able to afford.
 *  - **It pays the arcade layer's debt to the strategy layer.** `strategy-
 *    layer.md` promises that what you do in a run is what moves the war, and
 *    the only thing in the game that does is `gainGround`. Under this term the
 *    run itself is the weapon.
 *
 * Fiction: an invasion fleet with a rear, not a spawner. It surges, you weather
 * the surge, and then it is quiet — and the quiet is the window. Perceivable:
 * the command view already reports what the enemy bought, and the chart has
 * room for one bar of enemy strength.
 *
 * `regenPerSector` is set so the opening board — twenty-four sectors — very
 * nearly funds the opening budget of six, which makes the first few runs feel
 * like the shipped game and the escalation after them something the enemy is
 * paying for.
 */
export const RESERVE = {
  initial: 30,
  /**
   * Resupply from beyond the chart, a flat rate a turn. This is the term that
   * carries the candidate, and it is flat on purpose: an invasion is fed from
   * where it came from, not from the space it is standing on. Every
   * territory-proportional term measured here — the shipped
   * `sectorsHeldBeyondStart`, `supply`, and this reserve's first draft, which
   * replenished per held sector — makes the war *more* decided rather than
   * less, because the enemy's rate rising with its territory amplifies whatever
   * happened in the first few runs. Flat resupply is the only version with no
   * amplifier in it.
   */
  regenFlat: 22,
  /** Kept at zero. Non-zero reintroduces exactly the amplifier described above. */
  regenPerSector: 0,
  max: 40,
  /**
   * The share of what it has that the invasion will commit in one turn.
   *
   * Under one it never spends its last reserves, which is what makes running
   * out mean something. Spending everything every turn was measured first and
   * is wrong twice over: the stock collapses to whatever came in that turn — so
   * the reserve degenerates into the flat cap that was already rejected — and
   * "empty" stops meaning beaten, because an invasion overrunning you empties
   * itself doing it. Held back, the stock settles at twice the surplus of
   * resupply over what the player is destroying, so it falls to nothing exactly
   * when the player is killing faster than they are being reinforced.
   */
  commit: 0.5,
  /** What one step of ground taken costs the invasion. */
  costPerStep: 2,
  /**
   * Turns at nothing left before the invasion counts as broken.
   *
   * This is the clause that separates this candidate from capping the pressure
   * formula, which was measured and rejected because it turned losses into
   * deadlocks. A cap removes the defeat and supplies no victory: neither side
   * can finish, so the war has no length rather than a long one. Exhaustion is
   * the victory. `strategy-layer.md` already writes the win as "push the front
   * off the chart entirely — **the invasion is broken**", and this makes the
   * second half of that sentence a rule rather than a gloss on the first.
   *
   * Three turns rather than one so that a single expensive turn is a lull and
   * not a surrender.
   */
  brokenFor: 3,
};

/**
 * Every candidate's constants in one place, so the instrument can sweep them.
 *
 * A candidate is only worth a verdict once it has been tried at more than the
 * first numbers somebody wrote down — the reserve looked like a runaway win
 * until its replenishment was set against the opening board rather than
 * guessed. Deliberately not readonly for that reason, and deliberately only
 * ever written by `tune`, which refuses a key it does not recognise.
 */
const TUNABLE: Record<string, Record<string, number>> = {
  supply: SUPPLY,
  entrench: ENTRENCH,
  reserve: RESERVE,
};

/** `tune("reserve.regenPerSector=0.5,entrench.max=2")`. Throws on a name it does not know. */
export function tune(spec: string): void {
  for (const clause of spec.split(",")) {
    const trimmed = clause.trim();
    if (trimmed === "") continue;
    const [path, raw] = trimmed.split("=");
    const [group, key] = (path ?? "").split(".");
    const target = TUNABLE[group];
    if (!target || !(key in target)) throw new Error(`unknown tunable "${path}"`);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`"${trimmed}" is not a number`);
    target[key] = value;
  }
}

/** What the tunables are set to, for the instrument to print beside its numbers. */
export function describeTuning(): string {
  return [...active]
    .sort()
    .map((term) => Object.entries(TUNABLE[term]).map(([k, v]) => `${term}.${k}=${v}`).join(" "))
    .join("  ");
}

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
