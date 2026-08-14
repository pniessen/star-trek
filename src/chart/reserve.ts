/**
 * The finite invasion's reserve constants, split into their own module for
 * one reason: `campaign.ts`'s `isWon` needs `RESERVE.brokenFor` to name a win,
 * and `enemyTurn.ts` already imports from `campaign.ts` (for `Campaign`,
 * `countControl`, `ENEMY_START_DEPTH`), so `campaign.ts` importing back from
 * `enemyTurn.ts` would be a cycle. This module has no imports of its own, so
 * both sides can read it without one.
 *
 * `enemyTurn.ts` re-exports `RESERVE` from here, so everything that reads the
 * invasion's numbers — `reserveOf`, the chart, the instrument — still gets
 * them from `enemyTurn.js`, the same place it always has.
 */

/**
 * **The invasion is finite.** The enemy has a reserve rather than an
 * allowance. It replenishes from the ground it holds, everything it spends
 * comes out of it, and — this is the part a rate-only formula has no
 * equivalent of — **fighting drains it**. Every step of ground a run takes
 * costs the invasion strength it has to make back.
 *
 * That last clause is why this is a different kind of term rather than a
 * third flavour of escalation. Both of those act on the enemy's *rate*; this
 * one gives the war a *stock*, which does three things nothing else here
 * does:
 *
 *  - **A stalemate stops being a draw.** Holding the line while clearing
 *    waves drains them even if the front never moves, so a war that is going
 *    nowhere still resolves. The measured objection to capping the pressure
 *    formula was that it turned losses into deadlocks; a cap removes the
 *    defeat without supplying a victory, and this is the victory.
 *  - **The clock stops being the whole war.** `floor(runs / 2)` grows for
 *    ever and nothing answers it. Here it is retained as the enemy's
 *    *ambition* and the reserve is its *means*, so escalation is something
 *    the invasion has to be able to afford.
 *  - **It pays the arcade layer's debt to the strategy layer.** `strategy-
 *    layer.md` promises that what you do in a run is what moves the war, and
 *    the only thing in the game that does is `gainGround`. Under this term
 *    the run itself is the weapon.
 *
 * Fiction: an invasion fleet with a rear, not a spawner. It surges, you
 * weather the surge, and then it is quiet — and the quiet is the window.
 * Perceivable: the command view already reports what the enemy bought, and
 * the chart has room for one bar of enemy strength.
 *
 * `regenPerSector` is set so the opening board — twenty-four sectors — very
 * nearly funds the opening budget of six, which makes the first few runs feel
 * like the game always played and the escalation after them something the
 * enemy is paying for.
 */
export const RESERVE = {
  initial: 30,
  /**
   * Resupply from beyond the chart, a flat rate a turn. This is the term that
   * carries the whole rule, and it is flat on purpose: an invasion is fed
   * from where it came from, not from the space it is standing on. Every
   * territory-proportional term measured here — the shipped
   * `sectorsHeldBeyondStart` and this reserve's first draft, which
   * replenished per held sector — makes the war *more* decided rather than
   * less, because the enemy's rate rising with its territory amplifies
   * whatever happened in the first few runs. Flat resupply is the only
   * version with no amplifier in it.
   *
   * Retuned from 22 to 24 on 2026-08-14, after the territory floor in
   * `enemyTurn.ts`'s `sectorsHeldBeyondStart` was restored (see that
   * function's own docblock). At 24, reach 4 — the low end of a competent
   * player's plausible steps-per-run, per `campaign-balance.md` §6 — wins
   * 83.4% of 1000 seeds inside 40 runs (median 26) and 100% inside 200
   * (`--sweep --vary`, `--ceiling=40` and uncapped). That is a recorded
   * compromise, not a clean hit on the 30–70% band: criterion (b) (median
   * ≤~25, ≥60% resolved) was held as the tie-breaker per the owner's ruling,
   * and every regenFlat that puts reach 4's win rate inside 30–70% pushes its
   * median past 30. See `docs/campaign-balance.md`'s "Adopted, 2026-08-14"
   * section for the full sweep.
   */
  regenFlat: 24,
  /** Kept at zero. Non-zero reintroduces exactly the amplifier described above. */
  regenPerSector: 0,
  max: 40,
  /**
   * The share of what it has that the invasion will commit in one turn.
   *
   * Under one it never spends its last reserves, which is what makes running
   * out mean something. Spending everything every turn was measured first and
   * is wrong twice over: the stock collapses to whatever came in that turn —
   * so the reserve degenerates into the flat cap that was already rejected —
   * and "empty" stops meaning beaten, because an invasion overrunning you
   * empties itself doing it. Held back, the stock settles at twice the
   * surplus of resupply over what the player is destroying, so it falls to
   * nothing exactly when the player is killing faster than they are being
   * reinforced.
   */
  commit: 0.5,
  /**
   * What one step of ground taken costs the invasion, and it is the number
   * the whole rule turns on.
   *
   * Measured, not chosen. The reserve has a hard floor built into it by the
   * two mechanisms above: resupply lands before the spend, and `commit` stops
   * the enemy spending more than a fraction of what it holds, so a turn
   * closes with at least about half of `regenFlat` in the pot. A run
   * therefore has to destroy roughly eleven to arrive at an empty reserve,
   * which at three a step is four steps and at two a step is unreachable — 2
   * was the first draft and the term measured as a pure deadlock generator at
   * it, for that reason and no other.
   *
   * At 3, against a player whose reach varies run to run, reach 3 comes out
   * 62/38 won to lost with the war still resolving, reach 2 is nearly always
   * lost and reach 4 nearly always won. That was the first contested band
   * this campaign ever produced, measured before patrols were uncapped and
   * before the territory floor below was restored — the band has since moved
   * (see `regenFlat`), but the number this constant turns on has not.
   *
   * Re-measured on 2026-08-14, alongside the `regenFlat` retune: raising it
   * does not widen the contested band, it erases it. At `costPerStep=4` or
   * above, reach 4 jumps to 94%+ won regardless of `regenFlat`, because the
   * exhaustion win starts firing before the territorial one has time to be
   * in doubt. Left at 3.
   */
  costPerStep: 3,
  /**
   * Turns at nothing left before the invasion counts as broken.
   *
   * This is the clause that separates this rule from capping the pressure
   * formula, which was measured and rejected because it turned losses into
   * deadlocks. A cap removes the defeat and supplies no victory: neither side
   * can finish, so the war has no length rather than a long one. Exhaustion
   * is the victory. `strategy-layer.md` already writes the win as "push the
   * front off the chart entirely — **the invasion is broken**", and this
   * makes the second half of that sentence a rule rather than a gloss on the
   * first.
   *
   * Three turns rather than one so that a single expensive turn is a lull and
   * not a surrender.
   */
  brokenFor: 3,
};
