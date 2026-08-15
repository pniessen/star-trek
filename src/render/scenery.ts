import { makeRng } from "../chart/rng.js";

/**
 * The sector's hero body — the casting call environment.md's staging
 * deferred. One draw per (seed, sector), weighted so the giant is an event
 * rather than a constant, and "bare" is a place: deep space where the
 * nebula sky carries the frame.
 *
 * Three-free on purpose: the deck log (game side) and the playtest read
 * this too, and a pure function is the only kind all three can share.
 */
export type HeroKind = "giant" | "ringed" | "moon" | "sun" | "rocks" | "bare";

/** Cumulative weights, in declaration order. Tuning candidates like all else. */
const ROSTER: readonly [HeroKind, number][] = [
  ["giant", 0.3],
  ["ringed", 0.2],
  ["moon", 0.15],
  ["sun", 0.15],
  ["rocks", 0.1],
  ["bare", 0.1],
];

export function planHero(seed: number, sector: number): HeroKind {
  // A hash mix of its own — distinct from planPlanet's, planFixture's,
  // planLight's and the giant's, so the hero never correlates with the
  // sky, the comet or the star.
  const rng = makeRng((seed * 1103515245 + sector * 12820163 + 53231) >>> 0);
  let roll = rng.next();
  for (const [kind, weight] of ROSTER) {
    roll -= weight;
    if (roll <= 0) return kind;
  }
  return "bare"; // float dust; unreachable in practice
}
