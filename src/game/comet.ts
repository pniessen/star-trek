import { BufferAttribute, Color, Group, IcosahedronGeometry, SRGBColorSpace, Vector3 } from "three";
import { makeRng, type Rng } from "../chart/rng.js";
import type { TraceBuffer } from "../render/TraceBuffer.js";
import { VectorObject } from "../render/VectorObject.js";

/**
 * The comet — *Balance of Terror* (TOS, 1966), where an ionised tail is the
 * only reason a cloaked enemy is ever findable. This game already owns both
 * halves of that scene: the Shroud is a cloaker whose whole identity is
 * *never resolves*, and until now nowhere on the board was worth fighting in.
 * See `docs/comet.md` for the full design; this file is §2, §4 and §7 of it.
 *
 * **The rule, in one sentence: inside the tail, no instrument works.** Every
 * later consequence — cloaks failing, locks refusing to cross the boundary,
 * the scanner degrading contacts to unresolved returns — is downstream of
 * this file answering one question: *how jammed is this point in space*, as
 * a single number from 0 to 1. `interferenceAt` is that question and nothing
 * else lives here yet; the hostile-facing rules, the drain and the renderer
 * are Tasks 2 through 4.
 *
 * **Two schedules, one class.** A *fixture* is seeded per sector exactly the
 * way `Planet.ts` places the ringed giant — same technique, different hash,
 * so the two are not correlated — and is terrain a run is planned around: a
 * sector worth choosing to intercept in, which is the first time the chart
 * has had a reason to care what a square contains beyond threat and yield. A
 * *wanderer* is a rare, short-lived crossing rolled at a wave break, the way
 * a Loom is: an opportunity taken or missed rather than terrain held. They
 * share this file's constants, its tail-volume test and its type, because
 * anything else would be the same feature built twice.
 *
 * **Why `interferenceAt` is 2D.** The slab is ±14 units either side of
 * `y = 0`; a tail is hundreds of units long. A cylinder that tested height
 * would be indistinguishable from one that did not at any range a player
 * could tell the difference from the cockpit, so the honest version is also
 * the cheap one: a test on `x, z` alone, exactly as `Ship.facingFrom` treats
 * the four shield facings as a ring rather than a sphere for the same reason.
 */

export type CometKind = "fixture" | "wanderer";

/**
 * One comet, wherever it came from. `kind` is carried on the plan rather than
 * inferred from which function built it, because the renderer and the session
 * rules (Tasks 2-4) read a plan without caring which scheduler produced it —
 * a fixture and a wanderer are the same object at different scale.
 */
export interface CometPlan {
  kind: CometKind;
  /** World position of the nucleus, on the floor (`y = 0`) like everything
   * else that is a place rather than a ship — see `CLAUDE.md`'s conventions. */
  nucleus: Vector3;
  /** Unit vector the tail streams along, away from the sector's sun. */
  direction: Vector3;
  /** Tail length along `direction`, in world units. */
  length: number;
  /** Tail radius at the nucleus end of the cone. */
  nearRadius: number;
  /** Tail radius at the far end of the cone. */
  farRadius: number;
  /** Radius of the coma — the sphere of interference around the nucleus
   * itself, so the head is not a hole in the middle of its own tail. */
  nucleusRadius: number;
  /** World units per second the nucleus moves. Zero for a fixture that has
   * not been given one yet is a valid plan; both schedulers below set it. */
  drift: Vector3;
}

/**
 * Every number the comet is. First-draft guesses of exactly the same species
 * as `LOOM`'s — reasoned about, never flown, and on the tuning list in
 * `docs/todo.md` once one exists for this feature. All of them are defined
 * here even though this task's code only reads the first four, because one
 * constant block that Tasks 2-4 read without adding a second export is the
 * point of writing it this way.
 */
export const COMET = {
  // ── the tail-volume test (this file, `interferenceAt`) ──────────────────

  /**
   * Fraction of the tail's length that stays at full strength before the
   * far-end fade begins. A comet's tail is dense through most of its body and
   * only thins near the tip, so this is closer to 1 than to 0.5 — the fade is
   * the last third of the cone, not half of it.
   */
  solidFraction: 0.65,
  /**
   * The far-end fade never multiplies interference below this, even right at
   * the tip. Without a floor the last few units before `length` would carry a
   * reading so faint it is indistinguishable from open space, and the
   * boundary has to *look* interfered with — a quiet scanner reading as an
   * empty sector is the lie §3 of the design rules out.
   */
  tipFloor: 0.2,
  /**
   * Ceiling multiplier at the densest point of the tail. Kept at 1 so the
   * core reaches the same top of the 0-1 range `hostiles.ts`'s `cloak` field
   * already uses — the two are meant to converge on one scanner grammar (see
   * `docs/comet.md` §7), and a comet that could not reach what a cloak
   * reaches would never fully mask a contact standing in it.
   */
  strength: 1,
  /**
   * The interference value above which fire-control and cloaks are treated
   * as *inside*, not merely degraded — the boundary consequences in §2 of the
   * design key off. Set at the halfway point of the 0-1 range `interferenceAt`
   * returns — a plain midpoint guess, not derived from `hostiles.ts`'s own
   * `HIDDEN_AT` threshold on `cloak` (0.4), which is a different number for a
   * different question and is not meant to match this one. Unused until
   * Task 2 wires the hostile side of the rule.
   */
  stripAt: 0.5,

  // ── the fixture — seeded per sector, `planFixture` ───────────────────────

  /**
   * Chance a given sector's seed produces a fixture. Roughly one in four per
   * the design (§4): common enough that a run meets one, rare enough that a
   * comet in every sector would be furniture rather than a place worth
   * choosing. Same shape as `Planet.ts`'s inline roll, pulled out here
   * because this constant is the one later tasks and `docs/todo.md` need to
   * find without reading the function.
   */
  fixtureChance: 0.25,
  /**
   * Tail length for a fixture. Was 420 — "hundreds long" per the design —
   * until code review caught what that number actually does against
   * `Stage.ts`'s scene fog, which runs 45..260: a 420-unit tail has its
   * outer 40% fogged to pure black no matter how it is drawn, so most of the
   * length was never visible from any distance a player would stand at. 170
   * (with `fixtureScaleJitter` this ranges 119-221) keeps the whole cone
   * substantially inside the fog range with margin to spare, so the tail has
   * a visible end a player can actually judge. It is still an enormous
   * region against the game's own engagement ranges (14-78, `PHASER
   * .falloffEnd` at 78) — a shorter tail here is not a smaller encounter.
   */
  fixtureLength: 170,
  /** Tail radius at the nucleus, for a fixture. */
  fixtureNearRadius: 26,
  /** Tail radius at the far end, for a fixture. Wide: this is the large,
   * planned-around instance of the class, not the one you stumble across. */
  fixtureFarRadius: 105,
  /** Coma radius for a fixture's nucleus. */
  fixtureNucleusRadius: 11,
  /**
   * How far a fixture's scale is allowed to jitter off 1, seeded per sector —
   * the same reason `Planet.ts` varies its own `scale`: identical instances
   * in every sector that rolls one would be furniture twice over.
   */
  fixtureScaleJitter: 0.3,
  /**
   * Distance band from sector centre a fixture's nucleus is placed at. The
   * floor is past a wave's own spawn ring (`LOOM.radius` reasons about the
   * same 95-140 unit band) so the comet is never simply where the fight
   * already is; the ceiling keeps it inside the distance a run's own pacing
   * makes reachable in the couple of minutes a wave lasts.
   */
  fixtureRangeMin: 150,
  fixtureRangeMax: 340,
  /**
   * World units per second a fixture's nucleus drifts. Slow, on purpose —
   * "terrain you plan around" (design §4) means the tail should still be
   * roughly where it was found a wave later, sweeping the sector over the
   * course of a whole run rather than crossing it in one.
   */
  fixtureDrift: 1.6,

  // ── the wanderer — rolled at a wave break, `planWanderer` ────────────────

  /**
   * Chance at a wave break that a wanderer crosses, checked the way
   * `LOOM.chance` is. Rarer than the Loom's 0.1: the design (§4) flags the
   * wanderer as the half of this feature at risk of reading as a second Loom,
   * and the cheapest way to keep the two from competing for the same "rare
   * thing arrived" moment is to make this one arrive less often.
   */
  wandererChance: 0.06,
  /**
   * Escalation index — `wave + threat - 1`, same number `LOOM.earliest`
   * reads — below which a wanderer never rolls. Lower than the Loom's 4: this
   * is an opportunity rather than a hazard, so there is less reason to wait
   * for a flying habit before offering it.
   */
  earliest: 3,
  /** Seconds a wanderer takes to cross the sector and leave — "within a
   * couple of minutes" per the design. */
  wandererDuration: 110,
  /** How far out on each side of its crossing point a wanderer starts and
   * ends, in world units. Half of `wandererDuration` times its implied speed
   * is what a player actually has to reach it inside. */
  wandererEntry: 260,
  /** Tail length for a wanderer. Shorter than a fixture's — "smaller, denser,
   * shorter" per the design (§4). */
  wandererLength: 190,
  /** Tail radius at the nucleus, for a wanderer. */
  wandererNearRadius: 14,
  /** Tail radius at the far end, for a wanderer. */
  wandererFarRadius: 46,
  /** Coma radius for a wanderer's nucleus. */
  wandererNucleusRadius: 6,

  // ── the cost and the render (§5, §6 of the design; Tasks 2 and 4) ────────

  /**
   * Reserve drained per second while inside the tail. Priced well under
   * `ALTITUDE.drain` (0.038) on purpose — altitude is a burst you hold for a
   * few seconds of a pass, and the tail is a place a player might hold for a
   * whole engagement, so the per-second cost has to be an order more
   * forgiving or camping it is never a real trade. Unused until Task 3 wires
   * the drain into `Session`.
   */
  drain: 0.015,
  /**
   * Range inside the tail a hostile must close to before it may fire once
   * long-range lock fails — §2's second consequence. Set below
   * `PHASER.falloffStart` (26) so a fight inside the tail is visibly closer
   * and more dangerous than the open-sector norm, not merely blinder. Unused
   * until Task 2.
   */
  visualRange: 22,
  /** Units per second the tail's streaming strokes drift along its axis, for
   * the renderer. Purely cosmetic; unused until Task 4. */
  flow: 18,
  /**
   * Streaming strokes drawn per frame for one tail. Was 40 — about one
   * stroke per ten units of a 420-unit cone — until code review's
   * screenshots showed exactly what this repo already has on record for the
   * same mistake: the backdrop's star band went from 2,600 candidates to
   * 20,000 for the same reason a sparse point field reads as noise, not a
   * body. 500 is still a tenth of `TraceBuffer`'s 5000-segment ceiling, and
   * only one comet is ever standing at once.
   */
  strokes: 500,
} as const;

/**
 * How jammed a point in space is, 0 outside the tail rising to `COMET.strength`
 * on the axis. A 2D test on `x, z` alone — see the header for why height is
 * deliberately never read.
 *
 * `plan` is nullable so callers can pass a sector's comet straight through
 * without a guard at every call site, the same convenience `Loom.aim` and
 * the minefield's own queries take.
 */
export function interferenceAt(plan: CometPlan | null, x: number, z: number): number {
  if (!plan) return 0;
  const vx = x - plan.nucleus.x;
  const vz = z - plan.nucleus.z;
  // Along the tail. Negative is sunward of the nucleus, where there is no tail.
  const t = vx * plan.direction.x + vz * plan.direction.z;
  if (t < -plan.nucleusRadius || t > plan.length) return 0;

  const px = vx - plan.direction.x * t;
  const pz = vz - plan.direction.z * t;
  const perp = Math.hypot(px, pz);

  // The coma: a sphere of interference around the nucleus itself, so the head is
  // not a hole in the middle of its own tail.
  if (t < 0) return perp < plan.nucleusRadius ? 1 : 0;

  const along = t / plan.length;
  const radius = plan.nearRadius + (plan.farRadius - plan.nearRadius) * along;
  if (perp > radius) return 0;

  // Falls off toward the edge and toward the far end, so the boundary is a
  // gradient rather than a wall the player can stand one unit outside of.
  const across = 1 - perp / radius;
  const fade = 1 - Math.max(0, (along - COMET.solidFraction) / (1 - COMET.solidFraction));
  return Math.min(1, across * Math.max(COMET.tipFloor, fade) * COMET.strength);
}

/**
 * Degrees to radians, matching `Backdrop.ts`'s own `DEG` — needed because
 * `sunAzimuth` below is degrees (see `tailDirection`) while every bearing this
 * file computes for itself (`planFixture`'s placement and drift, a seeded
 * fallback) is radians, the same mix `Backdrop.ts` lives with throughout.
 */
const DEG = Math.PI / 180;

/** Unit vector for a world bearing in radians, matching `Planet.ts`'s own `sin`/`cos` pairing. */
function bearingVector(bearingRadians: number): Vector3 {
  return new Vector3(Math.sin(bearingRadians), 0, Math.cos(bearingRadians));
}

/**
 * The tail's own axis: away from the sun.
 *
 * `sunAzimuth`, when given, is **degrees**, not radians — it is only ever
 * going to be `SkyBodyReport.azimuth` (`render/Backdrop.ts`), which is
 * documented there as degrees clockwise from +Z (`atan2(x, z)`, azimuth 0 is
 * dead ahead at heading 0) and is converted through that file's own `DEG`
 * at every use. Taking degrees here means Task 4 can pass
 * `sunAzimuthOf(sky)` straight through with nothing to convert and nothing
 * to get wrong; taking radians would have made every wired-up tail point at
 * a wrong bearing with nothing to throw and catch it.
 *
 * Pointing the tail at the sun's opposite bearing is pointing it away from
 * the sun. A sky with no sun (`sunAzimuth === null`) has nothing to point
 * away from, so a seeded bearing (already radians — this file's own, not
 * the sky's) stands in. Nothing calls this with a real azimuth yet; that
 * wiring is Task 4.
 */
function tailDirection(rng: { next(): number }, sunAzimuth: number | null): Vector3 {
  if (sunAzimuth === null) return bearingVector(rng.next() * Math.PI * 2);
  return bearingVector((sunAzimuth + 180) * DEG);
}

/**
 * One sector's comet, or none. Deterministic in `seed` and `sector` alone —
 * the same sector gives the same comet twice, which is what lets a run's
 * chart and its combat agree on where the terrain is.
 *
 * The hash mix is deliberately not `Planet.ts`'s (`seed * 2654435761 +
 * sector * 40503 + 977`): reusing it would correlate a sector's comet with
 * its ringed planet, so the same square always paired the same two things,
 * which is exactly the furniture problem `planPlanet`'s own comment warns
 * against for a planet alone.
 *
 * `sunAzimuth` is degrees, not radians — see `tailDirection` for why that is
 * the unit and not a stylistic choice.
 */
export function planFixture(seed: number, sector: number, sunAzimuth: number | null): CometPlan | null {
  const rng = makeRng((sector * 2246822519 + seed * 3266489917 + 668265263) >>> 0);
  if (rng.next() > COMET.fixtureChance) return null;

  const scale = 1 + (rng.next() * 2 - 1) * COMET.fixtureScaleJitter;
  const placeBearing = rng.next() * Math.PI * 2;
  const distance = COMET.fixtureRangeMin + rng.next() * (COMET.fixtureRangeMax - COMET.fixtureRangeMin);
  const driftBearing = rng.next() * Math.PI * 2;

  return {
    kind: "fixture",
    nucleus: bearingVector(placeBearing).multiplyScalar(distance),
    direction: tailDirection(rng, sunAzimuth),
    length: COMET.fixtureLength * scale,
    nearRadius: COMET.fixtureNearRadius * scale,
    farRadius: COMET.fixtureFarRadius * scale,
    nucleusRadius: COMET.fixtureNucleusRadius * scale,
    drift: bearingVector(driftBearing).multiplyScalar(COMET.fixtureDrift),
  };
}

/**
 * A wanderer, crossing near `around` — the same "wherever the player was
 * standing" placement `Loom.open` uses, and for the same reason: an
 * opportunity that opens somewhere the player already is not is not an
 * opportunity. Always returns a plan; whether one is rolled at all is
 * `COMET.wandererChance` and `COMET.earliest`, checked by the caller the way
 * `Loom.open` checks `LOOM.chance` before ever constructing a `Loom`.
 *
 * It enters on one side of `around`, drifts straight through, and exits the
 * other — `wandererEntry` out on each side, covered in `wandererDuration`
 * seconds, which is what makes `drift` a constant velocity rather than
 * something a caller has to re-aim mid-flight.
 *
 * `sunAzimuth` is degrees, not radians — see `tailDirection` for why that is
 * the unit and not a stylistic choice.
 */
export function planWanderer(around: Vector3, sunAzimuth: number | null, rng: () => number): CometPlan {
  const travelBearing = rng() * Math.PI * 2;
  const travel = bearingVector(travelBearing);
  const speed = (COMET.wandererEntry * 2) / COMET.wandererDuration;

  return {
    kind: "wanderer",
    nucleus: travel.clone().multiplyScalar(-COMET.wandererEntry).add(around),
    direction: tailDirection({ next: rng }, sunAzimuth),
    length: COMET.wandererLength,
    nearRadius: COMET.wandererNearRadius,
    farRadius: COMET.wandererFarRadius,
    nucleusRadius: COMET.wandererNucleusRadius,
    drift: travel.multiplyScalar(speed),
  };
}

/**
 * Pale, heavily desaturated ice-blue — defined here rather than added to
 * `PALETTE` because *colour is information* and this is explicitly outside
 * that vocabulary (see the file header, and `docs/comet.md` §6). The tempting
 * mistake — magenta, because the tail is what unresolves things — is rejected
 * there too: magenta is the Shroud's own colour, and a magenta field would be
 * the worst possible background to hunt a magenta contact against.
 *
 * `encounters.md`'s rule for decoration is strictly lower saturation *and*
 * lower luminance than any information colour. `PALETTE.traceDim` is the
 * dimmest one on the wheel (structure, grid, distant detail), so it is the
 * bar to clear: in sRGB HSL it sits at s≈0.54, l≈0.37. This sits at s=0.20,
 * l=0.30 — comfortably under both, and blue enough (hue 205°) to read as
 * "ice" rather than as a paler version of the cyan every information colour
 * on the wheel already leans toward.
 */
export const COMET_COLOR = new Color().setHSL(205 / 360, 0.2, 0.3, SRGBColorSpace);

/** The visible rock's radius, as a fraction of `CometPlan.nucleusRadius` —
 * the coma's own interference sphere, which the rock has to sit well inside
 * of. A rock the same size as the coma would leave no room for the
 * near-nucleus glow (see `COMA_BIAS`) to read as a halo around it. */
const ROCK_FRACTION = 0.4;
/**
 * How far each corner of the rock is allowed to move, as a fraction of its
 * radius, independently on each axis. Was a radial scale — each corner
 * pushed in or out along the direction it already had — and that was the
 * bug code review caught: an icosahedron's silhouette is carried by its
 * *vertex directions*, twelve points in a rigid five-fold arrangement, and
 * scaling their distance from the centre leaves every one of those
 * directions untouched, so it still reads as exactly the die it is. Moving
 * each corner by an independent random offset on X, Y and Z displaces the
 * *directions* too, which is what actually breaks the shape's symmetry. 0.5
 * is deliberately aggressive — up to half the radius on each axis,
 * compounding to well past it on the diagonal — because the design's bar
 * ("a perfectly round comet reads as a moon", §6) turned out to have a
 * sharper failure mode on the other side: a recognisable Platonic solid.
 */
const ROCK_JITTER = 0.5;

/** World units a tail streak trails behind its own leading point, nearest the
 * nucleus. It grows toward the tip (`STREAK_FAR`) so the stream reads as
 * material stretching outward rather than as a field of static dots — the
 * same reason a phaser beam is drawn as a line and not a dash. */
const STREAK_NEAR = 4;
const STREAK_FAR = 9;

/**
 * Skews a mote's seeded `along` toward the nucleus, so the tail's own
 * density stands in for the coma instead of a second, separate stroke set.
 *
 * The first version of this file drew twelve short spokes radiating from the
 * rock in a full sphere — the design doc's "halo of short strokes" (§6) read
 * literally. Code review caught what that actually looks like: radiating
 * lines from a bright centre is the exact shape `Backdrop.ts` already uses
 * for a sun (`kind: "sun"; rays: number`), so two unrelated objects were
 * drawing the same silhouette, one level up from the hue collision *colour
 * is information* already exists to prevent. The fix folds the coma into the
 * tail field instead: squaring a uniform `[0, 1)` draw pushes it toward 0, so
 * roughly 40% of every tail's motes seed within the nearest tenth of its
 * length. That cluster reads as a dense glow around the head — a halo, not
 * spikes — and it costs nothing extra, because `draw`'s own brightness
 * falloff (dimmer with `along`) was already making that same region the
 * brightest part of the tail; this just makes it the densest part too.
 *
 * `update` only ever adds a constant `step` to `along` and wraps it, the same
 * amount for every mote every frame — a rigid rotation through the [0, 1)
 * cycle — so the shape of the distribution this seeds is exactly the shape
 * it keeps for the comet's whole lifetime, not just at the moment `show` is
 * called.
 */
const COMA_BIAS = 2;

/** One streaming mote in the tail. `angle` and `radial` are fixed at
 * construction — only `along` moves — so a particle spirals slightly outward
 * as it flows and snaps back to a tight radius when it wraps, which is
 * exactly the shape a cone's own cross-section implies for something moving
 * along its axis at a constant fraction of the local radius. */
interface TailMote {
  along: number;
  angle: number;
  radial: number;
}

/**
 * A seed for this comet's own rock jitter and tail field, derived from the
 * plan rather than carried on it. `CometPlan` has no seed field of its own —
 * adding one would duplicate state the plan's numbers already are — and
 * `planFixture`/`planWanderer` are themselves deterministic, so hashing the
 * placement is enough: the same comet always produces the same plan values
 * and therefore the same hash, which is what makes the particle field (and
 * incidentally the rock) look the same on a second visit.
 */
function seedFrom(plan: CometPlan): number {
  const mix = (n: number): number => {
    let h = Math.imul(Math.floor(n * 1024) ^ 0x9e3779b9, 2654435761) >>> 0;
    h ^= h >>> 15;
    return h >>> 0;
  };
  return (mix(plan.nucleus.x) ^ mix(plan.nucleus.z) ^ mix(plan.length) ^ mix(plan.nearRadius)) >>> 0;
}

/**
 * An icosahedron with each corner shoved sideways by an independent offset
 * on every axis, not merely pushed in or out along its own radius.
 *
 * Subdivided once (`detail = 1`: 42 corners, 80 faces) rather than left at
 * the bare 12-vertex base — more corners to displace independently means
 * more chances for two adjacent faces to end up at genuinely different
 * angles, which is what "hard to name the underlying primitive" actually
 * requires. Still low-poly against `PLANET.segments`' own "this is a stroke
 * renderer" ceiling.
 *
 * `IcosahedronGeometry` is non-indexed — every face owns three private copies
 * of its corners rather than sharing forty-two — so jittering by vertex index
 * would tear the faces apart at every shared edge. Corners are keyed by their
 * un-jittered position instead (normalised by `radius`, so the key's
 * precision does not depend on how big this particular rock is), so every
 * face that meets at a given corner moves it by the same offset and the rock
 * stays watertight.
 */
function buildRockGeometry(radius: number, rng: Rng): IcosahedronGeometry {
  const geometry = new IcosahedronGeometry(radius, 1);
  const position = geometry.getAttribute("position") as BufferAttribute;
  const offsetByCorner = new Map<string, Vector3>();
  const v = new Vector3();

  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const key = `${(v.x / radius).toFixed(4)}:${(v.y / radius).toFixed(4)}:${(v.z / radius).toFixed(4)}`;
    let offset = offsetByCorner.get(key);
    if (!offset) {
      offset = new Vector3(
        (rng.next() * 2 - 1) * radius * ROCK_JITTER,
        (rng.next() * 2 - 1) * radius * ROCK_JITTER,
        (rng.next() * 2 - 1) * radius * ROCK_JITTER,
      );
      offsetByCorner.set(key, offset);
    }
    v.add(offset);
    position.setXYZ(i, v.x, v.y, v.z);
  }
  position.needsUpdate = true;
  return geometry;
}

/**
 * The comet as drawn: a nucleus and a tail whose own density stands in for
 * the coma — `docs/comet.md` §6, though §6 describes the coma as a separate
 * halo and code review is why it is not one; see `COMA_BIAS`.
 *
 * Everything obeys the locked idiom. The nucleus is real occluded geometry
 * through `VectorObject`, exactly the argument `Planet.ts` records for why the
 * ringed planet stopped being a picture: a solid body has to be able to hide
 * what is behind it. The tail is not — it is strokes through `TraceBuffer`,
 * regenerated in full every frame and never accumulated, the same contract
 * every other transient in this game keeps.
 *
 * `object` holds only the nucleus. The tail is pushed straight into the
 * shared `TraceBuffer` in world space, exactly as `Loom.draw` pushes the
 * weave rather than moving a `Group` — a comet drifting slowly across a
 * whole run is not worth a second transform to keep in step with `plan`'s own
 * numbers when `draw` can simply read them.
 */
export class Comet {
  readonly object = Object.assign(new Group(), { name: "comet" });

  plan: CometPlan | null = null;

  private rock: VectorObject | null = null;
  private readonly motes: TailMote[] = [];

  /**
   * Rebuild for a new plan, if it is not already the one standing.
   *
   * A reference check rather than a key string: unlike `Planet.show`, which is
   * handed a bare `seed`/`sector` pair every frame and has to build its own
   * identity for them, a caller here already holds the one `CometPlan` object
   * that answers "which comet" — passing `null` through is the same
   * convenience `interferenceAt` takes at every call site.
   */
  show(plan: CometPlan | null): void {
    if (plan === this.plan) return;
    this.clear();
    this.plan = plan;
    if (!plan) return;

    const rng = makeRng(seedFrom(plan));

    this.rock = new VectorObject(buildRockGeometry(plan.nucleusRadius * ROCK_FRACTION, rng), {
      color: COMET_COLOR,
      linewidth: 1.1,
    });
    this.object.add(this.rock.group);
    this.object.position.copy(plan.nucleus);

    for (let i = 0; i < COMET.strokes; i++) {
      this.motes.push({
        along: rng.next() ** COMA_BIAS,
        angle: rng.next() * Math.PI * 2,
        radial: rng.next(),
      });
    }
  }

  /**
   * Streams the tail forward and keeps the rock on station.
   *
   * `plan.nucleus` may have drifted since last frame — moving it is Task 3's
   * concern, wired into `Session`, not this one's — so this only ever reads
   * the position it is given rather than integrating `plan.drift` itself.
   */
  update(dt: number): void {
    if (!this.plan) return;
    this.object.position.copy(this.plan.nucleus);

    const step = (COMET.flow * dt) / this.plan.length;
    for (const mote of this.motes) {
      mote.along += step;
      if (mote.along >= 1) mote.along -= Math.floor(mote.along);
    }
  }

  /**
   * The tail, as strokes — its own near-nucleus density standing in for the
   * coma; see `COMA_BIAS`.
   *
   * Computed in world space from `plan` directly — never from `object`'s own
   * transform, which only the rock reads — so a comet that has drifted since
   * `update` last ran is drawn exactly where it now stands.
   *
   * Regenerated in full every call and nothing here persists between them:
   * this is what `TraceBuffer` is for, and `COMET.strokes` (500) is a tenth
   * of its 5000-segment ceiling for the one comet a sector ever has standing
   * at once.
   */
  draw(trace: TraceBuffer): void {
    if (!this.plan) return;
    const plan = this.plan;
    const { x: nx, y: ny, z: nz } = plan.nucleus;

    // Each mote drawn as a short streak along the flow direction,
    // at a radius that follows the cone `interferenceAt` itself tests —
    // `nearRadius` at the nucleus widening to `farRadius` at the tip — so the
    // strokes and the rule they are standing in for never disagree about the
    // tail's shape.
    const rightX = -plan.direction.z;
    const rightZ = plan.direction.x;
    for (const mote of this.motes) {
      const t = mote.along * plan.length;
      const radius = plan.nearRadius + (plan.farRadius - plan.nearRadius) * mote.along;
      const r = mote.radial * radius;
      const ox = Math.cos(mote.angle) * r;
      const oy = Math.sin(mote.angle) * r;

      const ax = nx + plan.direction.x * t + rightX * ox;
      const ay = ny + oy;
      const az = nz + plan.direction.z * t + rightZ * ox;

      const streak = STREAK_NEAR + (STREAK_FAR - STREAK_NEAR) * mote.along;
      const bx = ax - plan.direction.x * streak;
      const bz = az - plan.direction.z * streak;

      // Dims toward the tip and toward the edge of the cone — never toward
      // the axis, which is what keeps the tail reading as a diffuse stream
      // rather than a hollow shell.
      const level = (1 - mote.along * 0.85) * (1 - mote.radial * 0.7);
      trace.push(ax, ay, az, bx, ay, bz, COMET_COLOR, Math.max(0.08, level));
    }
  }

  setMode(mode: Parameters<VectorObject["setMode"]>[0]): void {
    this.rock?.setMode(mode);
  }

  /** Torn down on a sector change or a run restart — the same moment
   * `Planet.clear` and `Loom.clear` are. */
  clear(): void {
    this.rock?.dispose();
    this.rock = null;
    this.motes.length = 0;
    this.plan = null;
    for (const child of [...this.object.children]) this.object.remove(child);
  }
}
