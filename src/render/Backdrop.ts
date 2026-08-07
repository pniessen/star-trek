import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  type Object3D,
  SRGBColorSpace,
  Vector3,
} from "three";
import { makeRng, type Rng } from "../chart/rng.js";

/**
 * The sky a sector is fought under.
 *
 * The complaint this answers is the same one `chart/naming.ts` answers one
 * layer up: a square you warp to is "not here" until something about it is
 * memorable, and a grid reference is not memorable. Names fixed that for the
 * chart. This fixes it for the *view* — you drop into a sector and there is a
 * banded giant hanging off the port bow, and it is the same giant in the same
 * place the next time you drop there, for the life of the war. The empty
 * low-yield squares are the ones that need this most: they have nothing else
 * going on, and "the one with the two suns" is the cheapest possible reason to
 * remember one of them.
 *
 * Four things this is not, each of them load-bearing:
 *
 *  - **It is not terrain.** Nothing here is reachable, collidable, shootable, or
 *    on the scanner. It is not registered with the session, the fleet or the
 *    minefield, and nothing in this file knows the player's position. Engagement
 *    happens between 14 and 78 units inside a slab fourteen units deep; the sky
 *    sits at `SKY.radius` and is pinned to the camera, so its distance from the
 *    eye is a constant that no amount of flying can close.
 *  - **It does not translate.** `follow` copies the camera's *position* into the
 *    sky's, so the direction from the eye to every body is fixed forever and only
 *    the camera's rotation moves across it. That single property is the whole
 *    illusion of distance in a renderer with no atmospheric perspective, and it
 *    is also what makes each body's near and far side knowable at build time —
 *    see the ring, below.
 *  - **It is not information.** Colour is information in this game, so a
 *    backdrop — which is decoration by definition — lives under a stricter rule
 *    than "do not add a hue". See `SKY_COLOUR`.
 *  - **It does not move.** There is no `update(dt)` here on purpose. A sky that
 *    drifts on its own clock is a lie about a fixed star field, it would be the
 *    only per-frame cost this feature has, and the one thing that *should* move
 *    the sky — turning the ship — already does. The whole composition is built
 *    once per sector and then only ever translated.
 */

/**
 * The switch, in the shape `flight.threeD` established in `game/altitude.ts`.
 *
 * Deliberately not a key: the control surface is documented as full, and a
 * sixteenth binding for a thing you look at rather than use is a bad trade. It
 * is a module-level field so the debug hook, a harness, or a future settings
 * screen can flip it, and it defaults on.
 *
 * **Off, the game is exactly what it was.** `Backdrop.show` reads it every
 * frame and disposes the whole composition when it goes false, so with the sky
 * off there is no geometry, no material and no draw call — a structural
 * guarantee rather than an arithmetic one, the same way the slab's switch works.
 */
export const backdrop = {
  enabled: true,
};

export const SKY = {
  /**
   * How far out the bodies sit. Nothing depends on this being any particular
   * number — the sky is camera-pinned and depth-ordered by hand — so it is
   * chosen only to sit inside the camera's 2000-unit far plane with room to
   * spare and outside anything the game will ever draw.
   */
  radius: 620,
  /**
   * The band of the sky bodies are allowed into, in degrees above the floor.
   *
   * The top of this was 38 until it was flown, and 38 was wrong for a reason
   * worth writing down: **the game's cameras do not look level.** Chase sits
   * 4.6 units above the deck and aims at 0.4, which is about nine degrees of
   * downward pitch, and orbit is steeper again. So the horizon already sits
   * *above* centre screen and a body's apparent height is its elevation plus
   * that pitch — which put everything generated above roughly twenty degrees
   * off the top of a 62-degree frame entirely. A sky nobody can see is not a
   * cheaper sky, it is a bug that looks like restraint.
   *
   * The floor is the other half of the same argument: below about four degrees
   * a body straddles the grid's horizon and the row of contact labels, which is
   * the one part of the frame the player is genuinely reading.
   *
   * A body's own angular radius comes off the top of the band as well — see
   * `bandElevation` — so it is the *limb* that stays in frame and not merely
   * the centre.
   */
  minElevation: 4,
  maxElevation: 20,
  /**
   * Minimum great-circle separation between two independent bodies, degrees.
   * Moons are exempt — a moon is *supposed* to crowd its parent, that is what
   * makes it read as a moon rather than as a third planet.
   */
  separation: 40,
  /**
   * The draw-order band the sky is allowed to occupy.
   *
   * The two neighbours are what fix it: the starfield is `renderOrder -2` and
   * the grid is `-1` (see `scene/environment.ts`). The sky has to land between
   * them — after the stars, so a planet's face properly blanks the stars behind
   * it, and before everything else, so nothing the game draws can ever be
   * hidden by scenery. Every layer of every body claims one step, back to front.
   */
  orderFirst: -1.95,
  orderStep: 0.02,
  orderLast: -1.05,
} as const;

/**
 * The colour rule, and it is stricter than the rest of the game's.
 *
 * "Colour is information" and "never introduce a decorative colour" are both
 * project rules, and a backdrop is decoration by construction — so it does not
 * get to opt out, it gets a tighter constraint instead: **the sky may carry
 * hue, but never at anything approaching an information colour's saturation or
 * luminance.** Against the palette wheel, every colour that means something
 * runs S 0.54-0.88 and L 0.37-0.68 (cyan 177/0.76/0.62, raider gold
 * 35/0.88/0.59, lance 78/0.66/0.58, bastion 13/0.79/0.57, harrow 260/0.82/0.68,
 * magenta 330/0.72/0.63). The ceilings below sit well under the *floor* of that
 * range on both axes at once, so no sky body can be read as a contact even by
 * someone glancing at the edge of frame — a magenta gas giant that could be
 * mistaken for an unresolved return is a bug, not a look.
 *
 * There is a second dividend. The bloom pass thresholds at 0.5 luminance (see
 * `Stage`), and a body capped at 0.30 in sRGB is roughly 0.07 in the linear
 * light bloom actually measures. **The sky never reaches the bloom threshold at
 * all**, which is what stops a large bright disc behind the HUD from washing
 * out stroke text that draws through the same glow. The number that keeps the
 * sky out of the information palette is the same number that keeps it out of
 * the bloom, and neither is a coincidence — they are both "this is scenery".
 *
 * Nothing in the sky is additive-over-itself, either: bands do not cross bands,
 * rays radiate rather than intersect, and the fills are opaque rather than
 * additive. So there is no stacking path back up to the threshold.
 */
const SKY_COLOUR = {
  maxSaturation: 0.22,
  /** What a `jovian` giant is allowed, and nothing else. See the family's note. */
  maxGiantSaturation: 0.44,
  /**
   * The ceiling on a *stroke*, and it was 0.30 in the first draft, which was the
   * single mistake that made the sky read as a diagram.
   *
   * The rule above is about hue, and the first draft enforced it on brightness
   * as well — the whole sky was squeezed into 0.15-0.30, half a stop of range
   * with a hard floor under it. But **shading is luminance**: a terminator, a
   * lit limb, limb darkening are all differences in brightness, and legislating
   * the brightness differences away legislates away the sphere. The module had a
   * `terminator()` and a limb falloff the entire time and neither could be seen,
   * because there was nowhere for them to go.
   *
   * Information colour is *hue*, not brightness. A body at a fifth of any
   * class's saturation cannot be read as a contact however bright its rim gets,
   * so the edge is free to climb — and it must, because the edge is the only
   * thing carrying form.
   *
   * 0.72 sRGB is roughly 0.48 in the linear light the bloom pass measures, which
   * lands just under its 0.5 threshold. So the property the old number bought by
   * accident — the sky never blooms, and never washes out stroke text drawn
   * through the same glow — is kept deliberately instead, with 4.4x the range.
   * Suns are the one exception and say so where they are built: a star is
   * supposed to be a light source, and it is small enough that letting it bloom
   * costs a halo rather than a washed-out HUD.
   */
  maxLuminance: 0.72,
  /**
   * And the ceiling on a body's *face*, which goes the other way.
   *
   * The fill is a mass, not a light. This is `VectorObject`'s occluded mode —
   * the locked decision the whole game's look rests on — restated for the sky:
   * glowing edges over near-void opaque faces. The first draft had these two
   * numbers within a whisker of each other, so every body was a flat grey coin.
   * Pulling them apart is what makes it a body.
   */
  maxFillLuminance: 0.09,
  /**
   * Cyan is *ours* and is forbidden outright — the player and the Warden both
   * wear it, and it is the one hue in this game that means "not a target".
   * Enforced here rather than only in the families below, so a future family
   * cannot quietly walk into it.
   */
  cyanFrom: 150,
  cyanTo: 214,
} as const;

/**
 * The four registers a sky body may be painted in. Deep dim blues, dusty
 * ochres, near-monochrome greys and dim warm whites — the safe end of the wheel,
 * and between them enough variety that two sectors do not look alike.
 *
 * `ochre` and `bone` both sit in the same quadrant as raider gold (35) and
 * within sight of lance (78), and that is fine and deliberate: at a tenth of
 * the saturation and half the luminance an ochre is a brown and a bone is a
 * dirty white, and neither is a gold. Saturation is doing the work here, which
 * is exactly what the rule above says it must.
 */
const FAMILIES = {
  /**
   * Deep dim blue. Starts at 220 rather than at the edge of the forbidden band,
   * so the cyan guard below is a backstop that never actually fires: 220 is 43
   * degrees clear of the player's cyan and 22 clear of harrow violet, at a fifth
   * of either one's saturation. The margin is wider than it looks like it needs
   * to be on purpose — a colour this dark has only a handful of 8-bit levels
   * between its channels, and measuring the hue back off the quantised pixel can
   * move it several degrees. Six degrees of headroom is what makes "no cyan in
   * the sky" true of the pixels and not merely of the arithmetic.
   */
  slate: { hue: [220, 242], saturation: [0.1, 0.2], luminance: [0.44, 0.62] },
  /** Dusty ochre — a brown body, not a gold one. */
  ochre: { hue: [28, 46], saturation: [0.09, 0.18], luminance: [0.46, 0.66] },
  /** Near-monochrome. The hue is inert at this saturation and is only here so the maths has one. */
  ash: { hue: [220, 228], saturation: [0.0, 0.04], luminance: [0.42, 0.6] },
  /** Dim warm white — what a star is made of here. */
  bone: { hue: [38, 52], saturation: [0.04, 0.12], luminance: [0.55, 0.72] },
  /**
   * The one hot register, and it exists for gas giants alone.
   *
   * Everything else up there is a body in reflected light seen from a very long
   * way off, and dusty is the truthful answer for those. A giant is different:
   * it is the closest thing in the sky, it fills a third of the frame, and at a
   * tenth of anyone's saturation it was a grey arc that happened to be curved.
   *
   * The ceiling is still doing its job. Raider gold sits at hue 35 saturation
   * 0.88; this tops out at 0.44 — half of it — and lives on an object that is
   * enormous, motionless, behind everything, and never on the scanner. The two
   * cannot be confused by anything except a colour picker. Cyan remains banned
   * outright, and this register is not offered to any other kind of body.
   */
  jovian: { hue: [20, 46], saturation: [0.3, 0.44], luminance: [0.5, 0.68] },
} as const;

type FamilyName = keyof typeof FAMILIES;

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

export type SkyBodyKind = "gas-giant" | "ringed" | "sun" | "companion" | "moon";
/** What the sky *is*, as one word — the thing a player would call it. */
export type SkyComposition = "gas-giant" | "ringed" | "sun" | "dual-sun";

/** One body, as the debug hook and a headless harness see it. */
export interface SkyBodyReport {
  readonly kind: SkyBodyKind;
  /**
   * Degrees clockwise from +Z, measured exactly the way `Ship.heading` is —
   * `atan2(x, z)` — so a body at azimuth 0 hangs dead ahead at heading 0.
   */
  readonly azimuth: number;
  /** Degrees above the floor. */
  readonly elevation: number;
  /** Apparent radius in degrees, which is the only size that means anything here. */
  readonly size: number;
  /** sRGB hex, so the palette rule can be eyeballed from a console. */
  readonly colour: string;
}

export interface SkyReport {
  readonly seed: number;
  readonly sector: number;
  readonly composition: SkyComposition;
  readonly bodies: readonly SkyBodyReport[];
}

interface Common {
  azimuth: number;
  elevation: number;
  /** Apparent radius, degrees. */
  size: number;
  colour: Color;
  /** Which way the body is lit, radians in its own billboard plane. */
  light: number;
}

/**
 * A body's plan is generated in full before anything is built, so the
 * composition rules below can reason about a sky as a set of placements rather
 * than as a pile of half-constructed geometry.
 */
type BodyPlan =
  | (Common & { kind: "gas-giant" | "companion"; bands: number; tilt: number })
  | (Common & { kind: "ringed"; bands: number; tilt: number; ringInner: number; ringOuter: number })
  | (Common & { kind: "sun"; rays: number; spikes: boolean })
  | (Common & { kind: "moon"; curvature: number });

interface SkyPlan {
  composition: SkyComposition;
  bodies: BodyPlan[];
}

/**
 * The same cheap avalanche mix `chart/naming.ts` uses, and here for the same
 * reason: adjacent sectors must not draw adjacent skies. A plain `seed + index`
 * handed to the generator would give neighbouring squares visibly related
 * compositions, which is the one thing that would make a derived sky read as
 * arithmetic rather than as a place. Not cryptographic and not trying to be.
 */
function hash(seed: number, salt: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ salt, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function range(rng: Rng, low: number, high: number): number {
  return low + rng.next() * (high - low);
}

function pick<T>(rng: Rng, list: readonly T[]): T {
  return list[Math.min(list.length - 1, Math.floor(rng.next() * list.length))];
}

/**
 * Every colour in the sky is minted here and nowhere else, so the ceilings in
 * `SKY_COLOUR` cannot be walked around. The clamps are not assertions about the
 * families — the families are already inside them — they are a guarantee about
 * whatever gets added later.
 *
 * `setHSL` defaults to the renderer's *working* (linear) space, while the
 * palette's hexes are read as sRGB. Passing the colour space explicitly is what
 * makes "saturation 0.2" here mean the same thing as "saturation 0.2" measured
 * off `palette.ts`; without it the sky would be quietly darker and duller than
 * the numbers claim, and the comparison the rule rests on would be nonsense.
 *
 * The luminance *floors* in the families are as load-bearing as the ceiling and
 * were raised once, after looking at it: the first draft bottomed out near 0.10
 * and the bodies came through the phosphor and the CRT glass technically
 * present and practically invisible. There is a floor under "dim" below which
 * the feature simply does not exist, and it is higher than the arithmetic
 * suggests because two full-screen passes are standing between the sky and the
 * eye.
 */
function skyColour(rng: Rng, family: FamilyName): Color {
  const spec = FAMILIES[family];
  let hue = range(rng, spec.hue[0], spec.hue[1]);
  // Cyan means ours. Push out to whichever edge of the band is nearer rather
  // than rejecting and redrawing, which would consume a variable number of
  // draws and make the stream depend on how unlucky it got.
  if (hue > SKY_COLOUR.cyanFrom && hue < SKY_COLOUR.cyanTo) {
    const middle = (SKY_COLOUR.cyanFrom + SKY_COLOUR.cyanTo) / 2;
    hue = hue < middle ? SKY_COLOUR.cyanFrom : SKY_COLOUR.cyanTo;
  }
  return new Color().setHSL(
    (((hue % 360) + 360) % 360) / 360,
    Math.min(
      range(rng, spec.saturation[0], spec.saturation[1]),
      family === "jovian" ? SKY_COLOUR.maxGiantSaturation : SKY_COLOUR.maxSaturation,
    ),
    Math.min(range(rng, spec.luminance[0], spec.luminance[1]), SKY_COLOUR.maxLuminance),
    SRGBColorSpace,
  );
}

/** Unit vector for a placement, in the sky's own frame. `atan2(x, z)` again. */
function direction(azimuth: number, elevation: number, out: Vector3): Vector3 {
  const a = azimuth * DEG;
  const e = elevation * DEG;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}

const _a = new Vector3();
const _b = new Vector3();

interface Placement {
  readonly azimuth: number;
  readonly elevation: number;
}

/** Great-circle angle between two placements, degrees. */
function separation(one: Placement, two: Placement): number {
  direction(one.azimuth, one.elevation, _a);
  direction(two.azimuth, two.elevation, _b);
  return Math.acos(Math.max(-1, Math.min(1, _a.dot(_b)))) / DEG;
}

// ── composition ────────────────────────────────────────────────────────────

/**
 * **The composition rule.** A generated sky is never cluttered and never empty,
 * and both halves of that are enforced here rather than left to the dice:
 *
 *  1. **Exactly one primary**, always — a gas giant, a ringed planet, a single
 *     sun, or a pair of suns. That is what makes "never empty" a fact rather
 *     than a probability. A sector with nothing in its sky would be the one
 *     sector this whole feature failed to do anything for.
 *  2. **At most one secondary**, and never alongside a pair of suns: two suns
 *     have already spent the sky's second slot, and three independent bodies
 *     plus their moons is a solar system diagram rather than a view out of a
 *     canopy.
 *  3. **Zero to two moons**, and a moon is always placed close to a parent —
 *     within twelve degrees of its limb. A small disc alone in empty sky is a
 *     dot, not a moon; it only reads as a moon next to something to be a moon
 *     *of*.
 *  4. **Independent bodies stay `SKY.separation` apart**, so two never crowd
 *     into one smear. Moons are exempt, by rule 3.
 *  5. **Everything lives in the `SKY` elevation band**, off the horizon and
 *     inside the frame — limb included, not merely centre. See `bandElevation`.
 *
 * The ceiling those come to is four bodies. That is the number, and it is low
 * on purpose: this is a backdrop for a game about reading three contacts at
 * once, and it has to lose that fight every time.
 */
function planSky(seed: number, sector: number): SkyPlan {
  const rng = makeRng(hash(seed, sector * 2 + 7));
  const bodies: BodyPlan[] = [];

  const roll = rng.next();
  const composition: SkyComposition =
    roll < 0.34 ? "gas-giant" : roll < 0.56 ? "ringed" : roll < 0.82 ? "sun" : "dual-sun";

  const primaryAzimuth = range(rng, 0, 360);
  // Size is drawn before elevation everywhere here, and that ordering is the
  // point rather than an accident: how high a body may hang depends on how big
  // it is, or a nine-degree giant centred at the top of the band puts half of
  // itself off the screen. See `bandElevation`.
  if (composition === "dual-sun") {
    // Two stars, not one star and a rendering fault. What sells the pair is
    // that they disagree: the companion is between a half and two thirds the
    // size, and it is drawn from a different family, so one is warm and one is
    // cold. A matched pair reads as a double image.
    const warmFirst = rng.next() < 0.5;
    const size = range(rng, 0.75, 1.35);
    // The pair is placed as a pair: one elevation for both, with the companion
    // nudged off it, so they read as two bodies at one distance rather than as
    // two independent things that happen to be near each other.
    const elevation = bandElevation(rng, size * 1.6);
    const big = sun(rng, primaryAzimuth, elevation, size, warmFirst ? "bone" : "slate");
    const companionSize = size * range(rng, 0.42, 0.62);
    const small = sun(
      rng,
      // Spaced off the sum of the two radii rather than off a flat number of
      // degrees, so the pair is never a big star with a small one welded to its
      // limb. A flat spacing was tried and produced exactly that, because the
      // sizes are drawn independently of it.
      primaryAzimuth + (size + companionSize) * range(rng, 1.7, 3.0),
      // Clamped like every other placement: the companion is the one body
      // positioned relative to another rather than drawn into the band
      // directly, and without this it can be nudged three degrees under the
      // floor and end up sitting on the horizon with the contacts.
      clampElevation(elevation + range(rng, -3, 3)),
      companionSize,
      warmFirst ? "slate" : "bone",
    );
    bodies.push(big, small);
  } else if (composition === "sun") {
    const size = range(rng, 0.7, 1.3);
    // A sun's rays reach well past its disc, so it is held lower than its own
    // radius would ask for — the spikes are part of the silhouette.
    bodies.push(sun(rng, primaryAzimuth, bandElevation(rng, size * 2.2), size, "bone"));
  } else if (composition === "ringed") {
    /**
     * The one body that is deliberately *not* a limb.
     *
     * Giants became limbs because a giant's interest is its surface, and the
     * closer you are the more of it there is. A ringed planet's interest is its
     * outline — disc, then a gap, then an ellipse passing behind on one side and
     * in front on the other — and an outline is the one thing that cannot
     * survive being cropped. Built at limb scale it lost its rings entirely:
     * they became arcs parallel to the edge, indistinguishable from the
     * atmospheric layers a few degrees inside them.
     *
     * So it stays far away and stays whole. Two vocabularies, because these are
     * two different distances rather than one rule applied badly to both.
     */
    const size = range(rng, 5.0, 8.5);
    // A ring is half again as wide as its planet in both directions, and all of
    // it has to stay in frame or the silhouette is broken anyway.
    bodies.push(ringed(rng, primaryAzimuth, bandElevation(rng, size * 2.4), size));
  } else {
    /**
     * A whole disc, at a distance — the limb vocabulary was tried here and
     * dropped.
     *
     * The argument for it was sound and the result was not: a body cropped by
     * both frame edges reads as scale, so bring the giant close enough that you
     * only see its edge. What actually happened is that the interesting part of
     * a giant *is* its banding, and cropping threw most of the banding off
     * screen — leaving a set of nested arcs that read as arcs. The ringed planet
     * failed the same way for a related reason and is a distance body now too.
     *
     * What survived the experiment is the colour. Each band carries its own hue
     * rather than the body's one hue, and that lands harder here than it ever
     * did on a limb, because on a whole disc you see every band at once and the
     * chromatic banding is the entire read.
     */
    const size = range(rng, 9, 14);
    bodies.push(giant(rng, primaryAzimuth, bandElevation(rng, size), size));
  }

  // Rule 2: a pair of suns has already spent the second slot.
  if (composition !== "dual-sun" && rng.next() < 0.45) {
    // A sky whose primary is a sun gets a planet for its secondary, and a sky
    // whose primary is a planet usually does too. A distant second sun is the
    // rarer answer and it has to stay rare, or it becomes a dual-sun sky with
    // the wrong spacing — which is the one thing rule 2 exists to prevent.
    const secondSun = composition !== "sun" && rng.next() < 0.4;
    const size = secondSun ? range(rng, 0.5, 0.9) : range(rng, 2.6, 4.6);
    const placement = placeApart(rng, bodies, secondSun ? size * 2.2 : size);
    bodies.push(
      secondSun
        ? sun(rng, placement.azimuth, placement.elevation, size, "bone")
        : giant(rng, placement.azimuth, placement.elevation, size, "companion"),
    );
  }

  // Rule 3. Weighted rather than uniform: no moon is the commonest sky, and
  // two is a treat rather than the average.
  const moonRoll = rng.next();
  const moons = moonRoll < 0.35 ? 0 : moonRoll < 0.8 ? 1 : 2;
  for (let i = 0; i < moons; i++) {
    const parent = bodies[Math.floor(rng.next() * bodies.length)];
    const angle = range(rng, 0, TAU);
    // Far enough off the parent's limb that it is never touching it, close
    // enough that it is obviously with it.
    const gap = parent.size + range(rng, 2.0, 12.0);
    bodies.push(
      moon(
        rng,
        parent.azimuth + (Math.cos(angle) * gap) / Math.cos(parent.elevation * DEG),
        clampElevation(parent.elevation + Math.sin(angle) * gap),
        range(rng, 0.7, 1.6),
      ),
    );
  }

  return { composition, bodies };
}

function clampElevation(elevation: number): number {
  return Math.max(SKY.minElevation, Math.min(SKY.maxElevation, elevation));
}

/**
 * An elevation for a body of a given apparent radius.
 *
 * The radius comes off the top of the band rather than off the centre, because
 * what has to stay inside the frame is the *limb*: a nine-degree giant centred
 * at twenty degrees has its top edge at twenty-nine, which the chase camera's
 * downward pitch then pushes off the screen. Bodies whose visible extent is
 * wider than their disc — a sun's rays, a planet's rings — pass an inflated
 * radius rather than their own.
 *
 * The floor always wins if the two limits cross, since a body that is too big
 * to fit anywhere should sit as low as it is allowed to and be cropped at the
 * top, not be pushed down through the horizon.
 */
function bandElevation(rng: Rng, size: number): number {
  return range(rng, SKY.minElevation, Math.max(SKY.minElevation + 1, SKY.maxElevation - size));
}

/**
 * A placement at least `SKY.separation` from everything already planned.
 *
 * Rejection sampling with a bounded budget, then a deterministic fallback: a
 * generator that can loop is a generator that can hang a frame, and a sky is
 * not worth that. Twelve tries against at most two existing bodies fails
 * essentially never, and when it does the fallback is a good answer anyway —
 * straight across the sky from the primary.
 */
function placeApart(rng: Rng, existing: readonly BodyPlan[], size: number): Placement {
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate: Placement = {
      azimuth: range(rng, 0, 360),
      elevation: bandElevation(rng, size),
    };
    if (existing.every((body) => separation(body, candidate) >= SKY.separation)) return candidate;
  }
  return {
    azimuth: existing[0].azimuth + 180,
    // Mirrored about the middle of the band, then held inside the same
    // size-aware limit a drawn placement would have obeyed.
    elevation: Math.max(
      SKY.minElevation,
      Math.min(SKY.maxElevation - size, SKY.maxElevation + SKY.minElevation - existing[0].elevation),
    ),
  };
}

function giant(
  rng: Rng,
  azimuth: number,
  elevation: number,
  size: number,
  kind: "gas-giant" | "companion" = "gas-giant",
): BodyPlan {
  return {
    kind,
    azimuth,
    elevation,
    size,
    colour: skyColour(rng, kind === "gas-giant" ? "jovian" : pick(rng, ["slate", "ochre", "ash"] as const)),
    light: range(rng, 0, TAU),
    // Three bands is the fewest that reads as banding rather than as a line
    // across a circle; seven is where a disc this size turns into hatching.
    bands: kind === "gas-giant" ? 3 + Math.floor(rng.next() * 5) : 2 + Math.floor(rng.next() * 3),
    tilt: range(rng, -0.42, 0.42),
  };
}

function ringed(rng: Rng, azimuth: number, elevation: number, size: number): BodyPlan {
  return {
    kind: "ringed",
    azimuth,
    elevation,
    size,
    colour: skyColour(rng, pick(rng, ["ochre", "ash", "slate"] as const)),
    light: range(rng, 0, TAU),
    bands: 2 + Math.floor(rng.next() * 3),
    // The ring's tilt *is* the planet's tilt — the bands bow the same way the
    // ring opens, or the body reads as two objects photographed separately.
    tilt: range(rng, 0.14, 0.5) * (rng.next() < 0.5 ? -1 : 1),
    ringInner: range(rng, 1.32, 1.46),
    ringOuter: range(rng, 1.95, 2.35),
  };
}

function sun(
  rng: Rng,
  azimuth: number,
  elevation: number,
  size: number,
  family: FamilyName,
): BodyPlan {
  return {
    kind: "sun",
    azimuth,
    elevation,
    size,
    // Hue from the family, luminance from the fact that this one is a *source*.
    // The families' own ranges are built for bodies in reflected light, and a
    // slate sun drawn at slate's luminance came out a dark blue coin — a hole in
    // the sky rather than a star. So the hue still separates a warm star from a
    // cold one, and both of them are bright.
    colour: starColour(skyColour(rng, family)),
    light: range(rng, 0, TAU),
    rays: 14 + Math.floor(rng.next() * 12),
    spikes: rng.next() < 0.6,
  };
}

/**
 * Lift a family colour to a star's brightness, keeping its hue and its
 * saturation ceiling. The one place in this file that is allowed past
 * `SKY_COLOUR.maxLuminance`, for the reason given where suns are drawn: a star
 * is the only thing in the sky that emits, and it is small enough that letting
 * it through the bloom threshold costs a halo rather than a washed-out frame.
 */
const _hsl = { h: 0, s: 0, l: 0 };
function starColour(base: Color): Color {
  base.getHSL(_hsl);
  return base.setHSL(_hsl.h, Math.min(SKY_COLOUR.maxSaturation, _hsl.s), 0.95);
}

function moon(rng: Rng, azimuth: number, elevation: number, size: number): BodyPlan {
  return {
    kind: "moon",
    azimuth,
    elevation,
    size,
    colour: skyColour(rng, pick(rng, ["ash", "slate", "ochre"] as const)),
    light: range(rng, 0, TAU),
    // How far the terminator bows. Near zero is a half moon; near one is a
    // crescent or a nearly full disc, depending on the sign.
    curvature: range(rng, -0.85, 0.85),
  };
}

// ── strokes ────────────────────────────────────────────────────────────────

/**
 * Every body is built flat, in its own XY plane, and then turned to face the
 * eye. It can be built flat because the sky never translates: the direction
 * from the camera to a body is a constant of the composition, so a body is
 * always seen from exactly one angle and there is nothing for a third dimension
 * to reveal. That is the same property that makes the ring's near and far
 * halves knowable at build time.
 */
interface Strokes {
  readonly points: number[];
  readonly colours: number[];
}

function newStrokes(): Strokes {
  return { points: [], colours: [] };
}

const _tint = new Color();

function segment(
  strokes: Strokes,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  colour: Color,
  fromScale = 1,
  toScale = fromScale,
): void {
  strokes.points.push(ax, ay, 0, bx, by, 0);
  _tint.copy(colour).multiplyScalar(fromScale);
  strokes.colours.push(_tint.r, _tint.g, _tint.b);
  _tint.copy(colour).multiplyScalar(toScale);
  strokes.colours.push(_tint.r, _tint.g, _tint.b);
}

/**
 * A body's rim, brightest where it is lit and falling away to a floor rather
 * than to nothing. The falloff is the only lighting model in here and it is
 * worth its handful of lines: an evenly bright circle is a hoop, and a rim that
 * fades around the limb is a sphere. No shading, no faces, no normals — the
 * stroke's own brightness is doing all of it, which is how everything else in
 * this renderer works too.
 */
function rim(strokes: Strokes, radius: number, steps: number, colour: Color, light: number, floor: number): void {
  const lit = (angle: number): number =>
    floor + (1 - floor) * Math.max(0, Math.cos(angle - light)) ** 0.55;
  for (let i = 0; i < steps; i++) {
    const t0 = (i / steps) * TAU;
    const t1 = ((i + 1) / steps) * TAU;
    segment(
      strokes,
      Math.cos(t0) * radius,
      Math.sin(t0) * radius,
      Math.cos(t1) * radius,
      Math.sin(t1) * radius,
      colour,
      lit(t0),
      lit(t1),
    );
  }
}

/**
 * One latitude band on a sphere, which is what makes a gas giant a gas giant
 * rather than a circle.
 *
 * A band has to *bow* — a straight chord across the disc reads as a line drawn
 * on a coin. So each band is a real latitude circle on a unit sphere whose axis
 * is tilted `tilt` toward or away from the eye, projected straight down the
 * view axis. The visible half is longitudes within ninety degrees of the
 * meridian facing us; the ends are pulled a hair short of that so a band stops
 * just inside the limb instead of colliding with the rim stroke.
 */
function band(
  strokes: Strokes,
  radius: number,
  latitude: number,
  tilt: number,
  colour: Color,
  light: number,
  scale: number,
): void {
  const steps = 20;
  const span = (Math.PI / 2) * 0.94;
  let previousX = 0;
  let previousY = 0;
  for (let i = 0; i <= steps; i++) {
    const longitude = -span + (i / steps) * span * 2;
    const x = radius * Math.cos(latitude) * Math.sin(longitude);
    const y =
      radius * (Math.sin(latitude) * Math.cos(tilt) - Math.cos(latitude) * Math.cos(longitude) * Math.sin(tilt));
    if (i > 0) {
      // Bands take the same limb falloff the rim does, so the lit side of the
      // body stays the lit side all the way across it.
      const shade = (px: number, py: number): number =>
        0.06 + 0.94 * Math.max(0, Math.cos(Math.atan2(py, px) - light)) ** 0.6;
      segment(strokes, previousX, previousY, x, y, colour, scale * shade(previousX, previousY), scale * shade(x, y));
    }
    previousX = x;
    previousY = y;
  }
}


/**
 * The layers stacked just inside a limb, which is what a limb has instead of
 * banding.
 *
 * `band` draws a latitude circle across a whole disc, and that is the right
 * answer for a body you can see all of. It is the wrong answer here: at a
 * limb's scale the centre of the sphere is off the top of the frame, so a
 * latitude circle is off screen for almost its entire length and what little
 * survives is a nearly straight line in the corner.
 *
 * What you actually see approaching a world is the opposite — everything
 * *crowds* toward the edge. Equal steps of latitude compress into nothing at the
 * limb, so the visible strip is a stack of arcs parallel to the edge, dense
 * against it and opening out inward. That is the `t ** 1.9`: depth grows
 * non-linearly so the arcs pile up where the eye is already looking.
 *
 * The wobble is not decoration either. Perfectly even spacing at a single stroke
 * weight is the one thing that reads as a technical drawing rather than a place
 * — it is what made the first ring system look like a diagram of Saturn. Real
 * layers are uneven and some are brighter than their neighbours, so the spacing
 * and the brightness both ride an irrational-period sine: deterministic, seeded
 * by the body's own tilt, and never repeating a visible pattern.
 */
/**
 * The colour of one band, and this is what a banded giant actually is.
 *
 * Every band shared the body's one colour before, and that is most of why a
 * giant read as a tinted circle no matter what was done to its brightness:
 * Jupiter is not one hue at several lightnesses, it is *cream next to tan next
 * to rust*. The banding is chromatic before it is anything else.
 *
 * So each band swings its own hue, saturation and lightness off the body's base
 * on an irrational period — never repeating, always deterministic, and still
 * bounded by the giant ceiling so the whole thing cannot walk into an
 * information colour. Hue swings about fourteen degrees either way, roughly the
 * spread between Jupiter's own belts and zones.
 *
 * This outlived the limb experiment it was written for, and lands harder now
 * than it did then: on a whole disc you see every band at once.
 */
const _stratum = new Color();
function stratumColour(base: Color, i: number, phase: number): Color {
  _stratum.copy(base).getHSL(_hsl);
  const swing = Math.sin(i * 2.7 + phase);
  const warm = Math.sin(i * 1.31 + phase * 1.7);
  return _stratum.setHSL(
    (((_hsl.h + swing * 0.038) % 1) + 1) % 1,
    Math.max(0, Math.min(SKY_COLOUR.maxGiantSaturation, _hsl.s * (1 + warm * 0.45))),
    Math.max(0, Math.min(SKY_COLOUR.maxLuminance, _hsl.l * (0.82 + 0.34 * Math.abs(swing)))),
    SRGBColorSpace,
  );
}

/** The lit/unlit boundary across a small body: an arc, not a chord. */
function terminator(
  strokes: Strokes,
  radius: number,
  curvature: number,
  light: number,
  colour: Color,
  scale: number,
): void {
  const steps = 14;
  const axis = light + Math.PI / 2;
  const cos = Math.cos(axis);
  const sin = Math.sin(axis);
  let previousX = 0;
  let previousY = 0;
  for (let i = 0; i <= steps; i++) {
    const t = -Math.PI / 2 + (i / steps) * Math.PI;
    // An ellipse arc squashed across the light axis, then rotated onto it.
    const u = Math.cos(t) * curvature * radius;
    const v = Math.sin(t) * radius;
    const x = u * cos - v * sin;
    const y = u * sin + v * cos;
    if (i > 0) segment(strokes, previousX, previousY, x, y, colour, scale);
    previousX = x;
    previousY = y;
  }
}

/** Half a ring, as an ellipse arc. `from`/`to` in radians of the ellipse's own parameter. */
function ringArc(
  strokes: Strokes,
  major: number,
  minor: number,
  from: number,
  to: number,
  colour: Color,
  scale: number,
): void {
  const steps = 26;
  let previousX = 0;
  let previousY = 0;
  for (let i = 0; i <= steps; i++) {
    const t = from + ((to - from) * i) / steps;
    const x = Math.cos(t) * major;
    const y = Math.sin(t) * minor;
    if (i > 0) segment(strokes, previousX, previousY, x, y, colour, scale);
    previousX = x;
    previousY = y;
  }
}

// ── building ───────────────────────────────────────────────────────────────

/**
 * A single dim, opaque disc. Not additive and not transparent: this is the
 * occluder, and it exists to *replace* what is behind it.
 *
 * The idiom is `VectorObject`'s occluded mode, which is the locked decision this
 * project's whole look rests on — glowing edges over near-void opaque faces,
 * because pure wireframe is unreadable the moment two things overlap, and a
 * ring passing behind a planet is exactly two things overlapping. The one
 * difference is that `VectorObject` occludes with the depth buffer and this
 * occludes with draw order, for the reason given at the top of the file: the sky
 * is seen from a fixed direction, so what is in front of what is known when it
 * is built and does not need to be worked out again sixty times a second.
 */
function fillDisc(radius: number, colour: Color, order: number, scale = 0.022): Mesh {
  const material = new MeshBasicMaterial({
    // A hint of the body rather than a hole in the sky, the same argument
    // `VectorObject`'s `fill` makes. A star passes a higher `scale` than a
    // planet does: it is the one thing up there that is supposed to be its own
    // light source, and giving its face a lift is the only way to say so
    // without reaching for brightness the colour rule has already spent.
    color: colour.clone().multiplyScalar(scale),
    blending: NormalBlending,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    fog: false,
  });
  // 128, not the 40 this started with. A limb fills the frame edge to edge, and
  // at that size a 40-gon's flats are plainly visible as a faceted horizon —
  // the one artefact that would give away that a world is a polygon.
  const mesh = new Mesh(new CircleGeometry(radius, 128), material);
  mesh.renderOrder = order;
  return mesh;
}

function strokeLines(strokes: Strokes, order: number): LineSegments {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(strokes.points), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(strokes.colours), 3));

  const lines = new LineSegments(
    geometry,
    new LineBasicMaterial({
      vertexColors: true,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      // Fogged toward black at 45-260 units, a sky at 620 would simply not
      // exist. The starfield opts out for the same reason and says so.
      fog: false,
    }),
  );
  lines.renderOrder = order;
  return lines;
}

/**
 * Turn a body's flat plane to face the eye.
 *
 * Built by hand from a basis rather than with `lookAt`, because `lookAt`
 * resolves against the parent's world matrix and this group's parent moves
 * every frame — the orientation must be a fact about the composition, not about
 * where the ship happened to be when it was built. World up is safe as the
 * reference because the elevation band tops out at 38 degrees and can never
 * approach the pole where the basis would degenerate.
 */
const _right = new Vector3();
const _up = new Vector3();
const _toward = new Vector3();
const _basis = new Matrix4();

function orient(group: Group, azimuth: number, elevation: number): void {
  direction(azimuth, elevation, _toward);
  group.position.copy(_toward).multiplyScalar(SKY.radius);
  // Local +Z points back at the eye, which sits at the sky group's origin.
  _toward.negate();
  _right.set(0, 1, 0).cross(_toward).normalize();
  _up.copy(_toward).cross(_right).normalize();
  group.quaternion.setFromRotationMatrix(_basis.makeBasis(_right, _up, _toward));
}

/** Apparent radius in degrees to a world radius at `SKY.radius`. */
function worldSize(size: number): number {
  return Math.tan(size * DEG) * SKY.radius;
}

function buildBody(plan: BodyPlan, nextOrder: () => number): Group {
  const group = new Group();
  orient(group, plan.azimuth, plan.elevation);
  const radius = worldSize(plan.size);

  if (plan.kind === "ringed") {
    // How far the ring is open. `sin(tilt)` is the honest projection of a
    // circle seen from `tilt` off its own plane, and using the same tilt the
    // bands use is what keeps the two agreeing.
    const flatten = Math.max(0.1, Math.abs(Math.sin(plan.tilt)));
    const far = newStrokes();
    const near = newStrokes();
    // Not three hoops. Three evenly spaced ellipses at one stroke weight is
    // precisely what made the first version read as a diagram of Saturn out of
    // a schoolbook: the eye reads even spacing as notation, not as matter.
    //
    // A ring system is a *band* — many fine strands of uneven brightness, with
    // divisions swept clear through it. So: a dozen strands across the span, the
    // brightness riding an irrational period so no rhythm ever establishes
    // itself, and two gaps punched at fixed fractions of the width where the
    // strands are simply skipped. The gaps are what sell it. A real ring is
    // known by its divisions, not by its edges.
    const STRANDS = 12;
    const edges: Array<[number, number]> = [];
    for (let i = 0; i < STRANDS; i++) {
      const t = i / (STRANDS - 1);
      // Two divisions. Skipping strands leaves a true gap rather than a dim
      // one, which is the difference between a division and a smudge.
      if ((t > 0.34 && t < 0.44) || (t > 0.72 && t < 0.78)) continue;
      const scale = plan.ringInner + (plan.ringOuter - plan.ringInner) * t;
      // Brightest just outside the inner edge, as a real system is, and never
      // uniform: the sine is what stops twelve strands reading as hatching.
      const brightness = (0.34 + 0.46 * Math.abs(Math.sin(i * 1.911 + plan.tilt * 4))) * (1 - 0.35 * t);
      edges.push([scale, brightness]);
    }
    // The far half is the one the tilt lifts *behind* the planet — which side
    // that is follows the sign of the tilt, exactly as the bands' bow does.
    const farFrom = plan.tilt >= 0 ? 0 : Math.PI;
    for (const [scale, brightness] of edges) {
      const major = radius * scale;
      ringArc(far, major, major * flatten, farFrom, farFrom + Math.PI, plan.colour, brightness);
      ringArc(near, major, major * flatten, farFrom + Math.PI, farFrom + TAU, plan.colour, brightness);
    }

    // Back to front, and this is the whole trick: far ring, then the planet as
    // an opaque near-void disc that eats the middle of it, then the planet's own
    // glowing rim and bands, then the near ring over the top. Three draw orders
    // and no sorting.
    group.add(strokeLines(far, nextOrder()));
    group.add(fillDisc(radius, plan.colour, nextOrder()));
    const face = newStrokes();
    rim(face, radius, 72, plan.colour, plan.light, 0.0);
    for (let i = 0; i < plan.bands; i++) {
      const latitude = (-0.55 + ((i + 0.5) / plan.bands) * 1.1) * (Math.PI / 2);
      band(face, radius, latitude, plan.tilt, plan.colour, plan.light, 0.7 + (i % 2) * 0.3);
    }
    group.add(strokeLines(face, nextOrder()));
    group.add(strokeLines(near, nextOrder()));
    return group;
  }

  if (plan.kind === "sun") {
    /**
     * A star is a point, and the bloom pass is what makes it a star.
     *
     * This used to draw fourteen to twenty-six rays and four diffraction spikes
     * by hand, at a brightness deliberately held below the bloom threshold —
     * a sun "by its form, not by being brighter than everything else". That was
     * the most childish thing in the sky, and it was solving a problem the
     * renderer had already solved: `Stage` runs an UnrealBloom pass over the
     * whole scene, and a small enough source above its 0.5 linear threshold
     * *becomes* a halo with no rays drawn at all.
     *
     * So the rays are gone and the disc goes bright instead — the one place the
     * sky is allowed above the threshold, because a star is the only thing up
     * there that is genuinely a light source. It stays safe for the HUD because
     * it is tiny: a degree of sky is about a dozen pixels, so what blooms is a
     * halo rather than a field.
     */
    const strokes = newStrokes();
    rim(strokes, radius, 40, plan.colour, plan.light, 1.0);
    // A second rim just outside the first, dimmer: the corona's inner edge, and
    // the only structure a star gets.
    rim(strokes, radius * 1.22, 40, plan.colour, plan.light, 0.22);
    group.add(fillDisc(radius, plan.colour, nextOrder(), 1.15));
    group.add(strokeLines(strokes, nextOrder()));
    return group;
  }

  if (plan.kind === "moon") {
    const strokes = newStrokes();
    rim(strokes, radius, 18, plan.colour, plan.light, 0.3);
    terminator(strokes, radius, plan.curvature, plan.light, plan.colour, 0.45);
    group.add(fillDisc(radius, plan.colour, nextOrder()));
    group.add(strokeLines(strokes, nextOrder()));
    return group;
  }

  const strokes = newStrokes();
  rim(strokes, radius, plan.kind === "gas-giant" ? 84 : 40, plan.colour, plan.light, 0.0);
  // A giant gets many bands, each its own colour; a small companion gets a few
  // in the body's own, because at that size chromatic banding is three pixels
  // of hue nobody can resolve.
  const count = plan.kind === "gas-giant" ? 5 + plan.bands : plan.bands;
  for (let i = 0; i < count; i++) {
    const latitude = (-0.62 + ((i + 0.5) / count) * 1.24) * (Math.PI / 2);
    const tint = plan.kind === "gas-giant" ? stratumColour(plan.colour, i, plan.tilt * 5) : plan.colour;
    band(strokes, radius, latitude, plan.tilt, tint, plan.light, 0.7 + (i % 2) * 0.3);
  }
  group.add(fillDisc(radius, plan.colour, nextOrder()));
  group.add(strokeLines(strokes, nextOrder()));
  return group;
}

// ── the sky ────────────────────────────────────────────────────────────────

export class Backdrop {
  /**
   * Added to the scene once at boot and never removed; the contents change.
   *
   * Named, which nothing else in this scene bothers to be, so that a harness can
   * find it with `scene.getObjectByName` and prove the one property the whole
   * feature rests on — that this group's position is the camera's, every frame,
   * however far the ship has flown.
   */
  readonly object = Object.assign(new Group(), { name: "backdrop" });

  /** `seed:sector` of what is currently built, or "" for nothing at all. */
  private key = "";
  private plan: SkyPlan | null = null;
  /** Set by the debug hook to hold one sky up regardless of where the ship is. */
  private pinned: { seed: number; sector: number } | null = null;

  /**
   * Build the sky for a sector, if it is not already the sky that is up.
   *
   * Safe and cheap to call every frame, which is how `main.ts` calls it: the
   * key comparison is the whole cost on the overwhelming majority of frames,
   * and a rebuild only happens the two times `campaign.current` can move — a
   * run beginning and a hyperwarp arriving.
   */
  show(seed: number, sector: number): void {
    if (this.pinned) {
      seed = this.pinned.seed;
      sector = this.pinned.sector;
    }
    const key = backdrop.enabled ? `${seed}:${sector}` : "";
    if (key === this.key) return;
    this.clear();
    this.key = key;
    if (!key) return;

    this.plan = planSky(seed, sector);
    let layer = 0;
    const nextOrder = (): number =>
      Math.min(SKY.orderLast, SKY.orderFirst + layer++ * SKY.orderStep);
    for (const body of this.plan.bodies) this.object.add(buildBody(body, nextOrder));
  }

  /**
   * Pin the sky to the camera's position — and only its position.
   *
   * This one line is the feature. The camera's rotation is left alone, so
   * turning the ship sweeps the view across a sky that is standing still, while
   * flying at a body closes no distance on it at all. Called after the camera
   * has been placed for the frame, or the sky lags it by one.
   */
  follow(camera: Object3D): void {
    this.object.visible = backdrop.enabled;
    this.object.position.copy(camera.position);
  }

  /** What is up, for the debug hook and for a headless harness. */
  describe(): SkyReport | null {
    if (!this.plan) return null;
    const [seed, sector] = this.key.split(":");
    return {
      seed: Number(seed),
      sector: Number(sector),
      composition: this.plan.composition,
      bodies: this.plan.bodies.map((body) => ({
        kind: body.kind,
        azimuth: +(((body.azimuth % 360) + 360) % 360).toFixed(1),
        elevation: +body.elevation.toFixed(1),
        size: +body.size.toFixed(2),
        colour: `#${body.colour.getHexString(SRGBColorSpace)}`,
      })),
    };
  }

  /**
   * Hold one sky up, whatever sector the game thinks it is in. The point of the
   * hook: flipping through skies is otherwise a matter of playing the campaign,
   * and nobody is going to review sixty-four of them that way.
   */
  pin(seed: number, sector: number): SkyReport | null {
    this.pinned = { seed, sector };
    this.show(seed, sector);
    return this.describe();
  }

  /** Step the pinned sector, wrapping. Pins the current sky first if nothing is pinned. */
  cycle(step = 1): SkyReport | null {
    const [seed, sector] = this.key ? this.key.split(":").map(Number) : [0, 0];
    const from = this.pinned ?? { seed, sector };
    return this.pin(from.seed, (((from.sector + step) % 64) + 64) % 64);
  }

  /** Hand the sky back to the campaign. Takes effect on the next frame's `show`. */
  unpin(): void {
    this.pinned = null;
    // Forces the next `show` to rebuild whatever the game actually asks for.
    this.key = "";
  }

  private clear(): void {
    for (const child of [...this.object.children]) {
      this.object.remove(child);
      child.traverse((node) => {
        const drawable = node as Partial<Mesh>;
        drawable.geometry?.dispose();
        const material = drawable.material;
        if (material && !Array.isArray(material)) material.dispose();
      });
    }
    this.plan = null;
  }
}
