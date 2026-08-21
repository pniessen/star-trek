import { Color, SRGBColorSpace, Vector3 } from "three";
import { makeRng } from "../chart/rng.js";

/**
 * The sector's star — `docs/environment.md` §3.1, "the single largest change
 * per unit of work" in the whole redesign. Everything a body's renderer draws
 * — a planet's terminator, a moon's crater field, the comet's own lit head —
 * is downstream of one question answered here: *where is the light, and how
 * bright is this point given that*. Get this file right once and every body
 * that calls it looks lit by the same star; get it wrong and no amount of
 * surface detail on any one body fixes it, because the scene was never a
 * place to begin with, only a pile of independently glowing outlines.
 *
 * Pure maths, deliberately. `Vector3` and `Color` are the only imports from
 * `three`, and both are used as plain data — no `Scene`, no `Object3D`, no
 * geometry. `shadeAt` is called once per stroke, every frame, on every body
 * in view — a gas giant alone is asked for hundreds of times a frame per
 * §3.3's density rule — so this file has to stay cheap enough to not notice:
 * no allocation inside `shadeAt`, no `.clone()`, no `new Vector3()`. Points
 * and normals go in and out as the plain numbers they are.
 *
 * Nothing here draws the star's own disc — that is a `bodies/` sun kind
 * (§5: "no surface — it *is* light"), not built yet and not this file's job.
 * This is only the physics every other body is lit *by*.
 */

/**
 * Every number the sector's star is. First-draft guesses of the same species
 * as `LOOM` and `COMET` — reasoned about, never flown — and candidates for
 * `docs/todo.md`'s tuning list once there is a body on screen to judge them
 * against.
 */
/**
 * The rig the sector's star is actually built as, and the one place its two
 * intensities are written down.
 *
 * `main.ts` constructs a `DirectionalLight` and an `AmbientLight` from these,
 * and `render/VectorObject.ts` divides by `ambient` to turn a caller's
 * requested occluder darkness back into an albedo — three.js's lighting path
 * resolves a Lambert surface to `albedo * (ambient + dotNL * directional) / PI`,
 * so the night side of every hull in the game is `albedo * ambient / PI`.
 *
 * They live here rather than in `main.ts` because two files now depend on the
 * *same* number and the second one cannot see the first. `VectorObject` shipped
 * with `0.12 / Math.PI` written out by hand and a staleness warning attached,
 * which is an honest way to describe a bug waiting to happen: move `ambient`
 * and every hull's night side moves with it, silently, with nothing failing.
 * A warning that a constant must be kept in step is worth less than not having
 * two of them.
 *
 * The light itself is still owned by the sector — `planLight` decides where it
 * is and what colour it is. This is only how brightly it is wired up.
 */
export const RIG = {
  /** The star. */
  directional: 1.4,
  /**
   * A low floor under it, so a real material's night side is dim rather than
   * literally zero — the job `STAR.floor` does for `shadeAt`'s own Lambertian
   * term. Low enough that the terminator still reads.
   */
  ambient: 0.12,
};

export const STAR = {
  /**
   * Distance from sector centre, in units. Far past anything it lights —
   * `PLANET.range` is 1700, the stage's far plane is 2000 — so the direction
   * from any point in the playable field to the star barely changes across
   * the whole sector: a planet on one side and a ship on the other read as
   * lit by the *same* star at the *same* angle, which is what "a place lit
   * by a star" (§3.1) actually requires. A nearer light would make two
   * bodies in one view visibly disagree about where the sun is.
   */
  distance: 20000,
  /**
   * Elevation above the horizontal, in degrees, fixed rather than seeded per
   * sector. `render/Backdrop.ts`'s own sun sits in a 4-20° band for exactly
   * this reason — `SKY.minElevation`/`maxElevation` — and this reuses the top
   * of that band rather than the whole spread, on purpose: randomising it
   * would occasionally land a sector's star nearly overhead, and a light
   * that high mostly illuminates the *tops* of things a level, downward-
   * pitched cockpit camera never sees (`PLANET.height`'s comment is the
   * fourth file to record that the camera cannot look up). Held low and
   * fixed, every sector's terminator falls across the flanks of a body
   * instead of its crown — the side the player is actually looking at.
   */
  elevationDeg: 18,
  /**
   * The floor `shadeAt` lifts the unlit side to, out of a 0-1 Lambertian
   * term that would otherwise reach true zero. Pure Lambertian takes the
   * dark side to black, and a body whose dark half vanishes against the
   * scene's own near-black background doesn't read as a sphere's night
   * side — it reads as a hole where geometry should be. The floor is what
   * keeps a silhouette on the unlit limb.
   *
   * The trade runs both directions. First guess was 0.15, the middle of it;
   * task 3's own review of the hero gas giant found the terminator
   * "provably there [by the maths], not obviously there [by eye]" at that
   * value — the lit/unlit ratio it gives (1.0 : 0.15, under 7:1) turned out
   * too narrow once dozens of overlapping, additively-blended belt strokes
   * pile brightness back up on the dark side regardless of any one stroke's
   * own dim multiplier. Lowered to 0.08 (over 12:1) to widen that gap. Much
   * lower and the dark hemisphere starts disappearing into the backdrop
   * again, which is the exact defect this constant exists to avoid; much
   * higher and the lit and unlit sides converge toward the same brightness,
   * which erases the terminator §3.1 was written to produce in the first
   * place. A floor that "fixes" the hole by flattening the whole body evenly
   * lit has just traded one failure for the other.
   */
  floor: 0.08,
  /**
   * Hue roll bounds, in two bands rather than the full circle. Black-body
   * colour temperature never produces cyan, green or magenta at *any*
   * temperature — the Planckian locus runs red through orange, yellow and
   * white, then off toward blue-white, and stops there — so shaping the
   * roll to that locus is physically motivated, not merely a narrower
   * guess. `warmHueMax` is the red-through-yellow half; `coolHueMin`/
   * `coolHueMax` is the blue-white half a hot star rolls into instead.
   *
   * The full-circle roll this replaced was the same defect class as
   * `GasGiant.ts`'s own `assertPaletteContract` exists to catch, one file
   * over: an unconstrained roll landing on a reserved hue. `uLightColor`
   * multiplies the giant's albedo (`GasGiant.ts` line ~811), so a star near
   * 300° turned the near-white zone stops pink-violet — the magenta this
   * game reserves for an unresolved contact (`palette.ts`) — and a star
   * near 90° did the same with Lance's acid green. Both are unreachable by
   * construction now; `assertPaletteContract` checks the bound, not the
   * roll, the way it already checks every fixed `GIANT` stop.
   */
  warmHueMax: 48,
  coolHueMin: 205,
  coolHueMax: 235,
  /** Real stellar populations skew redder than bluer — cooler stars are
   * simply more common — so this is that skew, not a coin flip between the
   * two bands. */
  warmChance: 0.7,
} as const;

const DEG = Math.PI / 180;

/** One star, wherever it is. */
export interface SectorLight {
  /** World position of the star. Always `STAR.distance` out; see there for
   * why that number, not this field, is what keeps every body agreeing on
   * where the light comes from. */
  position: Vector3;
  /**
   * The star's own colour. `shadeAt` never reads this — it returns a bare
   * 0-1 brightness so it stays a single cheap multiply — this is for a
   * body's renderer to tint its lit strokes with, the way a real star's
   * colour temperature tints what it lights. `docs/environment.md` §4.1 is
   * an explicit, owner-approved exemption: bodies (and, by the same
   * ruling, what lights them) are free of "colour is information" and may
   * carry saturated, full-luminance hue — its own example is "a red sun" —
   * unlike the desaturated, decoration-only colour the comet's tail was
   * held to.
   */
  colour: Color;
}

/**
 * One sector's star, from the seed. Deterministic in `seed` and `sector`
 * alone, the same contract `planPlanet` (`render/Planet.ts`) and
 * `planFixture` (`game/comet.ts`) already keep.
 *
 * The hash mix is its own — not `planPlanet`'s (`seed * 2654435761 +
 * sector * 40503 + 977`) and not `planFixture`'s (`sector * 2246822519 +
 * seed * 3266489917 + 668265263`). Reusing either would correlate a
 * sector's star with its planet or its comet, so the same seed would
 * always roll the same combination of the three — exactly the furniture
 * problem `planPlanet`'s and `planFixture`'s own comments already warn
 * against, one level up: not "the same square always has the same planet"
 * but "the same square's planet, comet and star always relate to each
 * other the same way".
 */
export function planLight(seed: number, sector: number): SectorLight {
  const rng = makeRng((seed * 1274126177 + sector * 741103597 + 1013904223) >>> 0);

  const azimuth = rng.next() * Math.PI * 2;
  const elevation = STAR.elevationDeg * DEG;
  const horizontal = Math.cos(elevation) * STAR.distance;
  const height = Math.sin(elevation) * STAR.distance;

  // Two bands, not the full circle — see STAR's own comment on
  // warmHueMax/coolHueMin/coolHueMax for why the shape is a black body's,
  // not an arbitrary narrowing. §4.1 still licenses full saturation and
  // luminance within that shape; this is meant to look like a light
  // source, not a pigment.
  const warm = rng.next() < STAR.warmChance;
  const hue = warm ? rng.next() * STAR.warmHueMax : STAR.coolHueMin + rng.next() * (STAR.coolHueMax - STAR.coolHueMin);
  const saturation = 0.25 + rng.next() * 0.45;
  const luminance = 0.65 + rng.next() * 0.2;

  return {
    position: new Vector3(Math.sin(azimuth) * horizontal, height, Math.cos(azimuth) * horizontal),
    colour: new Color().setHSL(hue / 360, saturation, luminance, SRGBColorSpace),
  };
}

/**
 * Brightness multiplier for a stroke at `point` with surface `normal`,
 * 0-1. Lambertian — the dot product of the surface normal and the
 * direction toward the light — with the floor `STAR.floor` lifts the
 * unlit side to; see that constant for the trade.
 *
 * Cheap on purpose: this runs per stroke per frame, on every body in view.
 * No allocation, no `Vector3` methods that would allocate one — `point`
 * and `normal` are read as plain `x`/`y`/`z` and the direction to the
 * light is normalised inline via a single division of the dot product,
 * not three divisions of a separately-normalised vector.
 */
export function shadeAt(light: SectorLight, point: Vector3, normal: Vector3): number {
  const dx = light.position.x - point.x;
  const dy = light.position.y - point.y;
  const dz = light.position.z - point.z;
  const len = Math.hypot(dx, dy, dz) || 1;

  const lambert = Math.max(0, (dx * normal.x + dy * normal.y + dz * normal.z) / len);
  return STAR.floor + (1 - STAR.floor) * lambert;
}
