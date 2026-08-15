import { colOf, rowOf } from "./sectors.js";

/**
 * Places have names, and the names are derived rather than stored.
 *
 * The complaint this exists to answer was "make me care about a square to warp
 * to, right now they are all just 'not here'". A grid reference is a
 * coordinate, not a place — nobody has ever been homesick for D4. So every
 * sector belongs to a named region, and every dock carries a station name, and
 * both fall out of the campaign seed by arithmetic.
 *
 * Nothing here is persisted, and deliberately so. A name held in the save is a
 * migration and a save-size problem and a thing that can disagree with the
 * board it describes; a name computed from `(seed, index)` is none of those and
 * is stable for the life of a campaign by construction. A new war gets a new
 * seed and therefore a new map of names, which is worth more than any one list
 * of good ones.
 *
 * Our own universe, per the locked decision: these words are invented, and no
 * species, ship or place from the genre appears in them.
 */

/**
 * Sectors per side of a region. Three of eight leaves nine regions — the last
 * column and row of each axis being two wide rather than three — which is
 * enough for a name to mean "this corner of the war" rather than "this square".
 */
export const REGION_BLOCK = 3;

/**
 * Region stems. A station in a region borrows its region's stem, so
 * "PELLAS 47" is audibly somewhere in the PELLAS REACH; that link is what makes
 * a name carry information rather than being flavour text.
 */
const STEMS = [
  "PELLAS", "CORVUS", "TARSIS", "VEDRA", "MORRAN", "ISKA", "HALDEN", "OBRIS",
  "KETH", "DRACHE", "ANNUR", "THESSA", "VARN", "EIDOL", "NORVA", "SELKA",
  "ULVAR", "CASSEN",
] as const;

/** What kind of place the region is. Second half of every region name. */
const KINDS = [
  "REACH", "DRIFT", "SPUR", "EXPANSE", "SHOALS", "GAP", "VEIL", "MARCH", "DEEP",
] as const;

/**
 * A cheap avalanche mix. Not cryptographic and not trying to be — it only has
 * to spread adjacent salts across the word lists so two neighbouring regions do
 * not draw the same stem, which a plain modulo of the index would do constantly.
 *
 * Exported so `commander.ts` can draw the enemy commander's name, doctrine and
 * pronoun the same arithmetic-not-storage way this module draws every place
 * name — one function, one register, rather than a second copy drifting from
 * this one.
 */
export function hash(seed: number, salt: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ salt, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Sector reference as it reads on the chart: column letter, row number. */
export function sectorCode(index: number): string {
  return `${String.fromCharCode(65 + colOf(index))}${rowOf(index) + 1}`;
}

/** Which region block a sector falls in, 0-8, row-major over the blocks. */
export function regionOf(index: number): number {
  return (
    Math.floor(rowOf(index) / REGION_BLOCK) * REGION_BLOCK +
    Math.floor(colOf(index) / REGION_BLOCK)
  );
}

/** The stem a region's name and its stations' names are both built from. */
export function regionStem(seed: number, index: number): string {
  return STEMS[hash(seed, regionOf(index) * 2 + 1) % STEMS.length];
}

/** e.g. "PELLAS REACH". Shared by every sector in the same block. */
export function regionName(seed: number, index: number): string {
  const kind = KINDS[hash(seed, regionOf(index) * 2 + 2) % KINDS.length];
  return `${regionStem(seed, index)} ${kind}`;
}

/**
 * e.g. "PELLAS 47". Per sector, not per region, so the outpost you built in
 * C4 and the starbase in C6 are different places with names you can hold in
 * your head — which is the whole point of docking somewhere rather than at
 * "the station".
 *
 * Two-digit, always: a designation with a leading zero reads as a number and
 * one without reads as a name, and this is meant to read as a name.
 */
export function stationName(seed: number, index: number): string {
  const designation = 10 + (hash(seed, index + 101) % 90);
  return `${regionStem(seed, index)} ${designation}`;
}
