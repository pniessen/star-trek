import { colOf, rowOf } from "./sectors.js";

/**
 * Names for the things a campaign contains.
 *
 * A sector called "D4" is a coordinate; a sector with a starbase called
 * "PELLAS STATION" in it is a place, and the difference is most of why anyone
 * cares which square they jump to. None of this changes a rule — it is all
 * derived, deterministically, from a seed and an index, so nothing has to be
 * stored and a campaign always names itself the same way twice.
 *
 * The vocabulary is deliberately ours. `CLAUDE.md` locks "our own universe":
 * the genre is not protectable but the marks are, so these are plausible
 * astronomical-catalogue words rather than anything anyone would recognise.
 */

/** Cheap deterministic hash: same seed and index, same name, every time. */
function pick<T>(list: readonly T[], seed: number, index: number, salt: number): T {
  let h = (seed ^ (index * 2654435761) ^ (salt * 40503)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  return list[h % list.length];
}

const STATION_NAMES = [
  "PELLAS", "VORN", "ASHKELT", "MERIDIAN", "TALLOW", "CASSEN", "DRIFT", "HOLLOW",
  "KESTREL", "MARROW", "OBEL", "SABLE", "THRACE", "VANTAGE", "WREN", "YARROW",
  "BRACK", "CORMEL", "DELVE", "EIDOS", "FEN", "GALLOW", "HESPER", "IRON",
] as const;

const REGION_NAMES = [
  "THE SHALLOWS", "COLD MARCH", "THE TEETH", "LONG DARK", "EMBER REACH",
  "THE SPINE", "QUIET FIELDS", "BLACK ANNEX", "THE FURROW", "SALT REACH",
  "GRAVE SHOALS", "THE APPROACHES",
] as const;

/** `D4`, the coordinate. Kept separate from the name, because both get used. */
export function sectorCode(index: number): string {
  return `${String.fromCharCode(65 + colOf(index))}${rowOf(index) + 1}`;
}

/**
 * The region a sector belongs to. Blocks of the grid share one, so the chart
 * reads as a place with parts rather than sixty-four unrelated squares.
 */
export function regionName(seed: number, index: number): string {
  const block = Math.floor(colOf(index) / 3) + Math.floor(rowOf(index) / 3) * 3;
  return pick(REGION_NAMES, seed, block, 7);
}

/**
 * What the station in this sector is called. Derived from the sector rather
 * than stored on the structure, so a starbase built here is always the same
 * station and rebuilding it does not rename it.
 */
export function stationName(seed: number, index: number): string {
  const name = pick(STATION_NAMES, seed, index, 3);
  // A catalogue number, so it reads as one of many rather than as a landmark.
  const number = 10 + ((seed ^ (index * 7919)) >>> 0) % 89;
  return `${name} ${number}`;
}
