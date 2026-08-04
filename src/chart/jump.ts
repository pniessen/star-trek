import { colOf, rowOf } from "./sectors.js";

/**
 * What a jump costs, as a function of how far it goes.
 *
 * **This is a combat-balance change and wants a human at the keyboard.** Until
 * now every hyperwarp charged for a flat two seconds however far it went, so a
 * player who asked "is a long warp harder than a short one" was told, honestly,
 * no — and the map lost the one axis that would have made a far corner feel
 * far. Distance now sets the charge, and the charge is the whole price:
 *
 * - **Seconds of held commitment.** You can turn, you cannot fire, and the
 *   fight you are fleeing gets those seconds for free. This is the cost that
 *   is actually felt.
 * - **Energy, at `HYPERWARP.drainPerSecond`.** A longer charge drains more, and
 *   a charge that empties the reserve dies without arriving — so the reserve is
 *   a range limit, and one that tightens as a fight goes badly.
 *
 * The multiplier is *not* charged by distance. Halving it stays flat, because
 * "a jump costs the same as taking a hit" is a locked decision and the whole
 * reason the price needs no explanation.
 *
 * The shape of the curve is deliberate: a one-step hop is now *cheaper* than
 * the old flat rate (1.4s against 2.0s), because that hop is the escape valve
 * and the escape valve should be reachable. Crossing the board is dearer than
 * the old flat rate and eventually unaffordable — at a full reserve the ship
 * reaches eight steps, against a board whose far corners are fourteen apart.
 * So the rich, dangerous far edge is somewhere you close on over a run rather
 * than somewhere you teleport to from home, which is what makes the front a
 * place you approach.
 *
 * Distance is Manhattan, not straight-line, because `neighbours` in
 * `sectors.ts` is orthogonal: the number of steps here is the number of jumps
 * the same trip would take one sector at a time, so a long jump is priced
 * against the short ones it replaces.
 *
 * Logic only, so `tools/campaigntest.mjs` can assert the curve in bare node.
 */
export const JUMP = {
  /** Seconds for a jump to an adjacent sector. The escape valve's price. */
  baseCharge: 1.4,
  /** Added seconds per extra sector crossed. */
  perStep: 0.35,
} as const;

/** Sectors crossed, counted the way the enemy advances: orthogonally. */
export function jumpSteps(from: number, to: number): number {
  return Math.abs(colOf(from) - colOf(to)) + Math.abs(rowOf(from) - rowOf(to));
}

/**
 * Seconds of charge. Zero for a jump to where you already are, which
 * `Session.beginHyperwarp` refuses outright — this returning zero rather than
 * a base charge is what keeps that refusal and this curve agreeing.
 */
export function jumpCharge(from: number, to: number): number {
  const steps = jumpSteps(from, to);
  if (steps === 0) return 0;
  return JUMP.baseCharge + (steps - 1) * JUMP.perStep;
}

/**
 * Reserve consumed by a completed charge, as a fraction of a full one.
 *
 * The drain rate is passed rather than imported: `src/chart/` may not depend on
 * `src/game/`, and `HYPERWARP.drainPerSecond` is a combat constant that lives
 * with the rest of the flight model.
 */
export function jumpEnergy(from: number, to: number, drainPerSecond: number): number {
  return jumpCharge(from, to) * drainPerSecond;
}

/**
 * How many sectors the ship could cross right now, on the reserve it is
 * holding. Zero means not even the sector next door — which is a real state
 * and one the chart has to say out loud, because a charge that dies silently
 * for want of energy is indistinguishable from a dead key.
 */
export function jumpReach(energy: number, drainPerSecond: number): number {
  if (drainPerSecond <= 0) return 0;
  const seconds = energy / drainPerSecond;
  if (seconds < JUMP.baseCharge) return 0;
  return 1 + Math.floor((seconds - JUMP.baseCharge) / JUMP.perStep);
}
