import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  type Mesh,
  Points,
  PointsMaterial,
  type Object3D,
  SRGBColorSpace,
  Vector3,
} from "three";
import { makeRng, type Rng } from "../chart/rng.js";
import { ASTERISMS, brightnessOf } from "./constellations.js";
import { planLight } from "./light.js";
import { planHero, type HeroKind } from "./scenery.js";
import { SkyBodies, type SkyBodyKind, type SkyBodySpec } from "./SkyBodies.js";
import { SUN_HERO } from "./SunHero.js";

export type { SkyBodyKind } from "./SkyBodies.js";

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
 *    than "do not add a hue". See `SKY_COLOUR`, and note that the *bodies* have
 *    since been taken out from under it: `render/SkyBodies.ts` carries the
 *    replacement, which is an apparent-size threshold rather than a flat cap.
 *  - **It does not move.** There is no `update(dt)` here on purpose. A sky that
 *    drifts on its own clock is a lie about a fixed star field, it would be the
 *    only per-frame cost this feature has, and the one thing that *should* move
 *    the sky — turning the ship — already does. The whole composition is built
 *    once per sector and then only ever translated.
 *
 * **Two of those four have since been overruled, deliberately, and both are
 * recorded where they were overruled rather than quietly patched out.** The
 * last one went first: `SKY.driftRate` gives the whole sky a slow wheel about
 * the galactic pole, and `update` says why. The third went with this file's
 * bodies.
 *
 * ---
 *
 * ## What this file draws, and what it no longer does
 *
 * It draws the *field*: the galactic band, the dust lane cut through it, a
 * nebula's filaments, and one or two of Earth's asterisms hidden among them.
 * All four are strokes and points, all four are things a stroke renderer is
 * genuinely the right medium for, and none of them is in question.
 *
 * **It no longer draws bodies.** It used to, out of strokes and flat discs, and
 * that was the last place in this project standing on an argument
 * `docs/environment.md` §1.5 had already voided: "occluded geometry, not pure
 * wireframe" is justified in its own sentence by *ships overlapping in combat*,
 * and a planet does not overlap a planet. The hero gas giant took four rebuilds
 * to learn that (§8.1) — three of them stroke-built, none of them producing a
 * planet — and the sky went on shipping rebuild one to roughly half of all
 * sectors, which meant the gas giant most players ever saw was the one that had
 * been written off. `render/SkyBodies.ts` is the answer: the sky's bodies are
 * now *the hero bodies*, instantiated and hung on the celestial sphere. That
 * file carries the whole argument, the placement rules, and the apparent-size
 * threshold that replaces this file's old flat colour cap.
 *
 * `planSky` below is still the source of truth for what a sector's sky contains
 * and where — it just hands the answer to a builder now instead of drawing it.
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
  /**
   * The galactic plane, and it is the cheapest thing in this file by a wide
   * margin.
   *
   * The starfield the game already had is *uniform*, and a uniform starfield
   * reads as noise rather than as a place — there is no direction in it, so
   * there is nothing to recognise. Real skies have a plane: you are inside a
   * disc of stars, so they crowd toward a great circle and thin away from it.
   * Weighting a scatter toward one is a few lines, and because the pole comes
   * off the sector seed, **every sector gets a different sky for no extra
   * content at all** — which does more for "this square is somewhere" than
   * another planet would.
   */
  bandCandidates: 20000,
  /** Degrees of latitude off the plane at which density has fallen by 1/e. */
  bandWidth: 11,
  /** Nothing below this elevation; the cameras cannot see it and it costs draw. */
  bandFloor: -46,
  /**
   * The dust lane: a strip through the band where stars are simply *not placed*.
   *
   * Pure negative space, and therefore free — no geometry, no material, no draw
   * call. It is also the only way a stroke renderer can draw a dark thing on a
   * dark ground, and it only works because the band exists to be interrupted.
   */
  laneHalfWidth: 1.9,
  /**
   * Nebula filaments.
   *
   * A nebula is diffuse and diffuse is the one thing strokes cannot do — that
   * is exactly the trap the limb fell into. But the *interesting* part of a real
   * nebula is not the haze, it is the structure: long curved threads following a
   * flow field. Those are strokes. So this draws the threads and lets the haze
   * be somebody else's problem.
   */
  filaments: [7, 15] as const,
  filamentSteps: 20,
  /**
   * How fast the sky wheels, degrees per second.
   *
   * The module shipped with no `update` at all and an argument for it: nothing
   * in a real sky moves on the timescale of a run, so drift is a lie about a
   * fixed star field. That argument is still *true* and has been overruled
   * deliberately, by the owner, for the same reason the plane came unlocked —
   * the game is not a planetarium, and a sky that is provably static is a sky
   * the eye stops reading after the first second.
   *
   * The compromise is the axis. This wheels about the galactic pole rather than
   * drifting in some arbitrary direction, so the star band stays where it is and
   * everything turns around it. That is the one rotation a real sky does have.
   * At this rate a three-minute run sweeps about twenty-seven degrees.
   */
  driftRate: 0.15,
  /**
   * What a jump does to it, as a multiplier on the drift.
   *
   * The one piece of sky motion that needs no apology: during a hyperwarp you
   * genuinely are moving between sectors, so the sky tearing past is truthful
   * rather than decorative. It is also staged at a moment the game already owns
   * and already charges for.
   */
  warpSpin: 220,
  orderFirst: -1.95,
  orderStep: 0.02,
  orderLast: -1.05,
} as const;

/**
 * The colour rule, **now scoped to the field alone** — the band, the nebula's
 * filaments, the asterisms. It no longer governs bodies, and the paragraph
 * below is kept because a rule that changed scope is worth more with its
 * reasoning attached than replaced by its own conclusion.
 *
 * What broke it: the ceilings here are a single flat cap, and a flat cap cannot
 * tell a frame-filling planet from a small bright disc at range —
 * `docs/environment.md` §4.1 says exactly that, exempts bodies from "colour is
 * information", and attaches three conditions, of which "small and distant
 * should stay desaturated" is the one that had never been implemented anywhere
 * in this codebase. `CLAUDE.md` records the gap as a requirement without an
 * enforcement mechanism. `render/SkyBodies.ts`'s `tempering` is now that
 * mechanism, and it is a ramp on apparent size rather than a cap on everything,
 * which is what the ruling actually asked for.
 *
 * The second dividend below — that the sky never reaches the bloom threshold,
 * so a large dim disc behind the HUD cannot wash out stroke text drawn through
 * the same glow — is kept rather than dropped: `SKY_BODY.distanceDim` is that
 * property restated as a fact about distance instead of a cap on palette.
 *
 * ---
 *
 * The original rule, for the field:
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
   * Cyan is *ours* and is forbidden outright — the player and the Warden both
   * wear it, and it is the one hue in this game that means "not a target".
   * Enforced here rather than only in the families below, so a future family
   * cannot quietly walk into it.
   */
  cyanFrom: 150,
  cyanTo: 214,
} as const;

/**
 * The three registers the *field* may be painted in — deep dim blues, dusty
 * ochres and near-monochrome greys, the safe end of the wheel, and between them
 * enough variety that two sectors' nebulae do not look alike.
 *
 * `ochre` sits in the same quadrant as raider gold (35) and within sight of
 * lance (78), and that is fine and deliberate: at a tenth of the saturation and
 * half the luminance an ochre is a brown, not a gold. Saturation is doing the
 * work here, which is exactly what the rule above says it must.
 *
 * Two registers are gone with the bodies that wore them. `bone` was the dim
 * warm white a stroke sun was drawn from; `jovian` was the one hot register,
 * granted to gas giants alone on the argument that at a tenth of anyone's
 * saturation a giant was "a grey arc that happened to be curved". Both are now
 * answered by the hero classes' own palettes — `GIANT`'s six Hubble-anchored
 * stops, `planLight`'s black-body star bands — which is a better answer to the
 * same complaint than a fifth swatch would have been.
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
} as const;

type FamilyName = keyof typeof FAMILIES;

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

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

/**
 * A body's plan is generated in full before anything is built, so the
 * composition rules below can reason about a sky as a set of placements rather
 * than as a pile of half-constructed geometry.
 *
 * **It is much shorter than it was**, and the missing fields are the point. It
 * used to carry `bands`, `tilt`, `ringInner`, `ringOuter`, `rays`, `spikes`,
 * `curvature` and a `light` angle — every one of them a parameter of a *drawing*
 * this file was about to make. None of that is this file's business any more:
 * the hero classes roll their own banding, tilt, ring extents, storms and crater
 * fields off a seed, and every one of those rolls is better argued than the
 * number it replaced. What survives is the composition — where a body is, how
 * big it looks, and which seed it is — plus `colour`, which is written back
 * after the build so `describe()` reports what is actually on screen rather than
 * what was intended.
 */
type BodyPlan = SkyBodySpec & {
  /**
   * Filled in by `show` from the built body's own materials. Before the first
   * build this is a placeholder, which matters only to `sunAzimuthOf` — the one
   * caller that reads a plan without building it, and which reads azimuth alone.
   */
  colour: Color;
};

interface BandPlan {
  /** Pole of the galactic plane, in the sky's own frame. */
  pole: Vector3;
  /** Latitude offset of the dust lane from the plane, degrees. */
  lane: number;
  /**
   * Its own seed, rather than a stored list of positions. Six hundred stars is
   * eighteen hundred floats to carry around a plan object whose whole job is to
   * be small and printable; a seed rebuilds them identically for one number.
   */
  seed: number;
}

interface AsterismPlan {
  /** Index into `ASTERISMS`. */
  which: number;
  azimuth: number;
  elevation: number;
  /** Radians the whole shape is turned in its own plane. */
  roll: number;
  /** Scales the catalogued separations. Slightly under or over life size. */
  spread: number;
}

interface NebulaPlan {
  azimuth: number;
  elevation: number;
  /** Angular half-extent, degrees. */
  extent: number;
  filaments: number;
  colour: Color;
  /** Seeds the flow field, so two nebulae never thread the same way. */
  phase: number;
}

interface SkyPlan {
  composition: SkyComposition;
  bodies: BodyPlan[];
  band: BandPlan;
  nebula: NebulaPlan | null;
  asterisms: AsterismPlan[];
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
    Math.min(range(rng, spec.saturation[0], spec.saturation[1]), SKY_COLOUR.maxSaturation),
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
 *  6. **The sky never casts the same kind of body the sector's hero already
 *     is.** See `compositionFor`.
 *
 * The ceiling those come to is four bodies. That is the number, and it is low
 * on purpose: this is a backdrop for a game about reading three contacts at
 * once, and it has to lose that fight every time.
 */
/**
 * Which composition a roll buys — **and `ringed` is back**, after two rounds
 * out.
 *
 * The reason it left is worth keeping, because it was right at the time: a
 * ringed planet's whole identity is a 3D relationship, and a picture pinned to
 * the sky could not sell one. Both of its attempts on this backdrop proved
 * that, and `render/Planet.ts` was built in world space precisely because of
 * it. Keeping a flat one here as well would have put two ringed planets in one
 * sector and let the fake one undercut the real one.
 *
 * What changed is that the sky's ringed planet **is** `render/Planet.ts` now —
 * the same class, the same analytic ring shadows, the same ring density profile
 * shared between the ring and its own shadow. There is no fake one left to
 * undercut anything. And the second half of the old objection is answered by
 * the sky's own wheel rather than by geometry: the body's *direction* from the
 * eye moves as the sky turns about the galactic pole while its attitude is held
 * fixed, so the rings genuinely open and close over a run. That is the thing
 * the flat version had to fake with an animated Y scale, and it is now simply
 * true. See `render/SkyBodies.ts`'s note on the three attitudes.
 *
 * **The duplication guard is what makes this safe**, and it generalises the old
 * objection instead of repeating it per body. `planHero` casts the sector's own
 * hero — giant, ringed, moon, sun, rocks or bare — and if the sky's roll lands
 * on the same kind, it is deflected. Two gas giants in one frame is the single
 * thing that would make both read as wallpaper, and it is also the one case
 * where the expensive fragment shader could appear twice at hero scale. `moon`
 * is deliberately *not* guarded: a hero moon fills a quarter of the frame and a
 * sky moon is a degree across, so the two are not the same image and never
 * compete. `rocks` and `bare` guard nothing, having no body to collide with.
 *
 * Deflection is to a fixed alternative rather than a re-roll, so the function
 * stays pure in its two inputs and one roll — a re-roll would consume a
 * variable number of draws and make every downstream placement in `planSky`
 * depend on how the guard fell.
 *
 * **A deflected band is split rather than dumped**, and that was measured
 * rather than reasoned. Sending the giant's whole 0.34 into `ringed` put the
 * ringed planet in 41% of sixty-four sectors — one composition in every two and
 * a half skies, and the most expensive one this file can draw, since a
 * transparent annulus with a density profile and a shadow test covers roughly
 * five times its own body's area. Splitting each deflected band across two
 * destinations lands the four compositions at 32/27/24/17 instead, which is
 * both a better sky and a cheaper one.
 *
 * A function rather than a ternary because TypeScript narrows a `const` by its
 * initialiser, and every `composition === "ringed"` test below would then be
 * flagged as comparing types with no overlap.
 */
function compositionFor(roll: number, hero: HeroKind): SkyComposition {
  let composition: SkyComposition =
    roll < 0.34 ? "gas-giant" : roll < 0.58 ? "ringed" : roll < 0.8 ? "sun" : "dual-sun";
  if (hero === "giant" && composition === "gas-giant") {
    // Split down the middle of the band the roll came from, so the two halves
    // of "the sector already has a giant" do not both become ringed planets.
    composition = roll < 0.17 ? "ringed" : "sun";
  } else if (hero === "ringed" && composition === "ringed") composition = "gas-giant";
  else if (hero === "sun" && (composition === "sun" || composition === "dual-sun")) {
    // A sun hero *is* the sector's light, drawn at the exact bearing every body
    // in the sector is shaded from. A second star in the sky would be the one
    // thing on screen contradicting where the shadows fall, which is a much
    // worse collision than two planets — so this is the one deflection that
    // exists for a lighting reason rather than a compositional one. Split the
    // same way: the single sun becomes a giant, the pair becomes a ringed
    // planet, and neither leaves a sun-hero sector with three quarters of its
    // skies showing the same thing.
    composition = composition === "sun" ? "gas-giant" : "ringed";
  }
  return composition;
}

function planSky(seed: number, sector: number): SkyPlan {
  const rng = makeRng(hash(seed, sector * 2 + 7));
  const bodies: BodyPlan[] = [];

  const roll = rng.next();
  // `planHero` is pure in the same two numbers this function is, so consulting
  // it costs nothing and keeps `planSky` deterministic in `(seed, sector)`
  // alone — which `sunAzimuthOf` depends on and `__sky.pin` relies on.
  const composition = compositionFor(roll, planHero(seed, sector));

  const primaryAzimuth = range(rng, 0, 360);
  // Size is drawn before elevation everywhere here, and that ordering is the
  // point rather than an accident: how high a body may hang depends on how big
  // it is, or a nine-degree giant centred at the top of the band puts half of
  // itself off the screen. See `bandElevation`.
  if (composition === "dual-sun") {
    // Two stars, not one star and a rendering fault. What sells the pair is
    // that they disagree: the companion is between a half and two thirds the
    // size, and each rolls its own star through `planLight` — whose two hue
    // bands are a black body's, so a warm one beside a cool one is the common
    // case rather than something this file has to arrange. A matched pair reads
    // as a double image. The old build reached the same place by hand, drawing
    // one from the `bone` family and the other from `slate`.
    const size = range(rng, 0.75, 1.35);
    // The pair is placed as a pair: one elevation for both, with the companion
    // nudged off it, so they read as two bodies at one distance rather than as
    // two independent things that happen to be near each other.
    const elevation = bandElevation(rng, size * SUN_REACH);
    const big = sun(rng, primaryAzimuth, elevation, size);
    const companionSize = size * range(rng, 0.42, 0.62);
    const small = sun(
      rng,
      // Spaced off the sum of the two radii rather than off a flat number of
      // degrees, so the pair is never a big star with a small one welded to its
      // limb. A flat spacing was tried and produced exactly that, because the
      // sizes are drawn independently of it.
      primaryAzimuth + (size + companionSize) * range(rng, 3.5, 6.0),
      // Clamped like every other placement: the companion is the one body
      // positioned relative to another rather than drawn into the band
      // directly, and without this it can be nudged three degrees under the
      // floor and end up sitting on the horizon with the contacts.
      clampElevation(elevation + range(rng, -3, 3)),
      companionSize,
    );
    bodies.push(big, small);
  } else if (composition === "sun") {
    const size = range(rng, 0.7, 1.3);
    // A star's corona reaches well past its core, so it is held lower than its
    // own radius would ask for — the halo is part of the silhouette.
    bodies.push(sun(rng, primaryAzimuth, bandElevation(rng, size * SUN_REACH), size));
  } else if (composition === "ringed") {
    /**
     * Whole, and at a distance — the one body that must never be cropped.
     *
     * A ringed planet's interest is its outline: disc, then a gap, then an
     * ellipse passing behind on one side and in front on the other. An outline
     * is the one thing that cannot survive being cut by the frame edge, which
     * is what killed the limb-scale attempt — the rings became arcs parallel
     * to the edge, indistinguishable from the atmospheric layers a few degrees
     * inside them.
     *
     * Smaller than the flat version was, deliberately. That one was drawn at 5
     * to 8.5 degrees because at anything less its ellipse arcs collapsed into
     * one another; a real annulus with a real division sweeping through it
     * survives being small in a way twelve hand-placed strands never could,
     * and the ring's outer edge at 2.25 times the body still reaches 12 degrees
     * at the top of this range. It also has to: the ring is the most expensive
     * thing this file can put on screen, since a transparent annulus with a
     * noise profile and a sphere-shadow test covers roughly five times the
     * body's own area.
     */
    const size = range(rng, 3.2, 5.5);
    // The ring is half again as wide as its planet in both directions, and all
    // of it has to stay in frame or the silhouette is broken anyway.
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
     * screen — leaving a set of nested arcs that read as arcs.
     *
     * Smaller than the flat build's 9-14 degrees, and for a reason the flat
     * build could not have had: the sector's own hero giant subtends about
     * 12.7 degrees of radius (`GIANT.radius` against `GIANT.range`), and a sky
     * giant that outgrew it would invert the one hierarchy the scene has —
     * near things are big. A stroke coin could get away with that because it
     * never read as an object at all. This one does.
     */
    const size = range(rng, 6, 10.5);
    bodies.push(giant(rng, primaryAzimuth, bandElevation(rng, size), size));
  }

  // Rule 2: a pair of suns has already spent the second slot.
  if (composition !== "dual-sun" && rng.next() < 0.45) {
    // A sky whose primary is a sun gets a planet for its secondary, and a sky
    // whose primary is a planet usually does too. A distant second sun is the
    // rarer answer and it has to stay rare, or it becomes a dual-sun sky with
    // the wrong spacing — which is the one thing rule 2 exists to prevent.
    const secondSun = composition !== "sun" && rng.next() < 0.4;
    const size = secondSun ? range(rng, 0.5, 0.9) : range(rng, 2.0, 3.6);
    const placement = placeApart(rng, bodies, secondSun ? size * SUN_REACH : size);
    bodies.push(
      secondSun
        ? sun(rng, placement.azimuth, placement.elevation, size)
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
        // A shade larger than the flat build's 0.7-1.6. That range was set by
        // what a rim stroke and one terminator arc could still describe at
        // small sizes; `render/Moon.ts`'s crater field wants a few dozen pixels
        // of radius before its Worley cells resolve into pits rather than
        // dither, and at the bottom of this range it gets them.
        range(rng, 0.9, 2.2),
      ),
    );
  }

  /**
   * The plane's pole is held *low*, which is the whole trick.
   *
   * A pole near the zenith puts its great circle around the horizon, where the
   * grid and the contact labels already are and where nobody is looking. A pole
   * near the horizon throws the band up over the top of the sky at a steep
   * angle, so it crosses the frame diagonally — which is both what the Milky Way
   * actually does from most of the year and the only placement that puts it
   * where the player is looking.
   */
  const band: BandPlan = {
    pole: direction(range(rng, 0, 360), range(rng, -18, 30), new Vector3()),
    lane: range(rng, -4.5, 4.5),
    seed: Math.floor(rng.next() * 0xffffff),
  };

  // Not every sky gets one. A nebula in every sector is wallpaper.
  const nebula: NebulaPlan | null =
    rng.next() < 0.42
      ? {
          ...placeApart(rng, bodies, 16),
          extent: range(rng, 11, 21),
          filaments: SKY.filaments[0] + Math.floor(rng.next() * (SKY.filaments[1] - SKY.filaments[0])),
          colour: skyColour(rng, pick(rng, ["slate", "ochre", "ash"] as const)),
          phase: range(rng, 0, TAU),
        }
      : null;

  /**
   * One or two of Earth's asterisms, hidden in the field. See
   * `constellations.ts` for why they are unjoined and why the geometry is real.
   *
   * Placed inside `SKY`'s own elevation band, and the first attempt was not — it
   * put them between twelve and thirty-four degrees on the reasoning that high is
   * where the sky is emptiest. Most of them were then invisible. **You cannot look
   * up in this game**: the cameras pitch about nine degrees down against a
   * thirty-one degree half-frame, so the sky runs out somewhere near twenty
   * degrees of elevation, which is precisely the number `SKY.maxElevation` already
   * records and the reason it is 20 rather than 38. Third feature this has caught,
   * after the backdrop's own bodies and a decal nobody could have seen.
   *
   * So: inside the band, and off its floor, where a body would go. Low enough to
   * be looked at, high enough to clear the grid's horizon and the contact labels.
   */
  const asterismCount = rng.next() < 0.55 ? 1 : rng.next() < 0.75 ? 2 : 0;
  const asterisms: AsterismPlan[] = [];
  for (let i = 0; i < asterismCount; i++) {
    asterisms.push({
      which: Math.floor(rng.next() * ASTERISMS.length),
      azimuth: range(rng, 0, 360),
      elevation: range(rng, SKY.minElevation + 2, SKY.maxElevation - 1),
      roll: range(rng, 0, TAU),
      spread: range(rng, 0.85, 1.25),
    });
  }

  return { composition, bodies, band, nebula, asterisms };
}

/**
 * The sun's azimuth for a sector, planned fresh rather than read off whatever
 * sky happens to be built right now.
 *
 * `Backdrop.describe()` reports the sky the *instance* currently has up, and
 * that is a real trap for a caller asking about a sector that instance has not
 * rebuilt for yet. `campaign.current` moves at exactly two moments —
 * `Session.restart` and a hyperwarp `arrive` — and both are the same frame the
 * comet's fixture has to be planned for the sector just moved *to*; `show()`
 * for that sector does not run until later in that same frame's `main.ts`
 * loop. A live instance would hand back the *previous* sector's sun, silently,
 * every single time — the tail pointing wrong forever, not just for a frame.
 * Attract mode compounds it: the rendered `Backdrop` always shows the
 * *player's* sector regardless of which campaign the session is bound to (see
 * `main.ts`'s own reasoning for why `sky.show` reads `campaign` and not the
 * session's), so a demo's comet would be planned off a sun that is not even in
 * its sector. Going straight to `planSky` sidesteps both: it is pure in `seed`
 * and `sector` alone, so it always answers for the sector actually asked
 * about, whatever the live sky is currently showing.
 *
 * Degrees, matching `SkyBodyReport.azimuth` — the one unit `comet.ts`'s
 * `tailDirection` accepts, with nothing to convert. Null when the sector's sky
 * has no sun (a gas-giant or ringed-planet composition, most of the time),
 * which is `planFixture`'s own cue to fall back to a seeded bearing instead.
 */
export function sunAzimuthOf(seed: number, sector: number): number | null {
  const sun = planSky(seed, sector).bodies.find((body) => body.kind === "sun");
  return sun ? sun.azimuth : null;
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

/**
 * How far a star's visible extent reaches past its own core, as a multiple of
 * it — the number `bandElevation` has to be told about so a sun's *halo*, not
 * merely its disc, stays inside the frame.
 *
 * It is `SUN_HERO.haloInnerScale + streamerLengthMax`, which is where the
 * longest corona spoke ends, rounded up. Derived rather than guessed because
 * the flat build's own equivalent (2.2, for hand-drawn rays) is the sort of
 * number that quietly stops matching the thing it describes; if the corona is
 * ever lengthened, this is where the frame budget notices.
 */
const SUN_REACH = Math.ceil(SUN_HERO.haloInnerScale + SUN_HERO.streamerLengthMax);

/**
 * A per-body seed for the hero class that will draw it.
 *
 * Every hero class keys its entire look off `(seed, sector)` through a hash mix
 * of its own, and `render/SkyBodies.ts` hands them this in place of the
 * campaign's seed. Drawn from the sky's own stream, so it is deterministic in
 * `(seed, sector)` like everything else here, and wide enough that two sectors'
 * giants are never the same giant.
 */
function variant(rng: Rng): number {
  return Math.floor(rng.next() * 0xffffff) + 1;
}

/**
 * The body factories, and there is almost nothing left in them.
 *
 * Each used to carry the parameters of a drawing — how many bands, how far the
 * terminator bows, how many rays, where the ring's inner and outer edges sit.
 * Every one of those questions now has a better-argued answer inside the hero
 * class that draws the body, rolled from `variant` alone. What is left is the
 * composition: where, how big, and which seed.
 *
 * `colour` is a placeholder here and is written back by `Backdrop.show` from
 * the built material. That inversion is deliberate — the old code decided a
 * body's colour and then drew it, so `describe()` could only ever report an
 * intention; now the body is built and then asked what colour it came out, so
 * the report is evidence.
 */
function giant(
  rng: Rng,
  azimuth: number,
  elevation: number,
  size: number,
  kind: "gas-giant" | "companion" = "gas-giant",
): BodyPlan {
  return { kind, azimuth, elevation, size, variant: variant(rng), colour: new Color() };
}

function ringed(rng: Rng, azimuth: number, elevation: number, size: number): BodyPlan {
  return { kind: "ringed", azimuth, elevation, size, variant: variant(rng), colour: new Color() };
}

function sun(rng: Rng, azimuth: number, elevation: number, size: number): BodyPlan {
  return { kind: "sun", azimuth, elevation, size, variant: variant(rng), colour: new Color() };
}

function moon(rng: Rng, azimuth: number, elevation: number, size: number): BodyPlan {
  return { kind: "moon", azimuth, elevation, size, variant: variant(rng), colour: new Color() };
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


// ── building ───────────────────────────────────────────────────────────────

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


/**
 * The galactic plane, and the dust lane cut through it.
 *
 * Rejection sampling against a Gaussian in galactic latitude: throw darts at the
 * whole sphere and keep the ones near the plane. That is more candidates than
 * keeps, which would matter if this ran per frame — it runs once per sector, so
 * the simple version is the right version.
 *
 * The lane is the interesting half. It is not drawn: it is a strip where stars
 * are *not placed*. A stroke renderer over a black ground has no way to draw a
 * dark thing — there is no darker than black — so the only honest dust lane is
 * an absence, and an absence is only visible against something dense. The band
 * and the lane are one feature; neither works without the other.
 */
function buildStarBand(plan: BandPlan, order: number): Points {
  const rng = makeRng(plan.seed);
  const points: number[] = [];
  const colours: number[] = [];
  const dir = new Vector3();
  const tint = new Color();

  for (let i = 0; i < SKY.bandCandidates; i++) {
    // Uniform on the sphere: z uniform, angle uniform. Sampling latitude
    // directly would crowd the poles and the crowding would be a bug.
    const z = range(rng, -1, 1);
    const a = range(rng, 0, TAU);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    dir.set(Math.cos(a) * r, z, Math.sin(a) * r);

    const elevation = Math.asin(MathClamp(dir.y, -1, 1)) / DEG;
    if (elevation < SKY.bandFloor) continue;

    const latitude = Math.asin(MathClamp(dir.dot(plan.pole), -1, 1)) / DEG;
    if (Math.abs(latitude - plan.lane) < SKY.laneHalfWidth) continue;
    if (rng.next() > Math.exp(-((latitude / SKY.bandWidth) ** 2))) continue;

    points.push(dir.x * SKY.radius, dir.y * SKY.radius, dir.z * SKY.radius);
    // Dim, near-monochrome and varied. Bright enough to read as a field, never
    // bright enough to be mistaken for a contact at the edge of vision.
    tint.setHSL(range(rng, 34, 54) / 360, range(rng, 0.02, 0.1), range(rng, 0.16, 0.44), SRGBColorSpace);
    colours.push(tint.r, tint.g, tint.b);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(points), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colours), 3));
  const stars = new Points(
    geometry,
    new PointsMaterial({
      size: 1.7,
      sizeAttenuation: false,
      vertexColors: true,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    }),
  );
  stars.renderOrder = order;
  return stars;
}


/**
 * An asterism, as points in the field rather than as a diagram.
 *
 * The offsets are angular separations in the shape's own tangent plane, so they
 * are turned into directions through a basis built at the placement — right and
 * up at that bearing — and then normalised. Small-angle territory: the widest
 * star here is twenty-four degrees out, where treating the plane as flat costs
 * less than a pixel, and paying for exact spherical placement would buy nothing
 * anybody could see.
 *
 * `roll` turns the shape in that plane before projection, which is what stops the
 * Plough always lying the same way up and is the reason a familiar shape reads as
 * a discovery rather than as wallpaper.
 */
function buildAsterism(plan: AsterismPlan, order: number): Points {
  const shape = ASTERISMS[plan.which];
  const points: number[] = [];
  const colours: number[] = [];
  const tint = new Color();

  const centre = direction(plan.azimuth, plan.elevation, new Vector3());
  const right = new Vector3(0, 1, 0).cross(centre).normalize();
  const up = new Vector3().copy(centre).cross(right).normalize();
  const at = new Vector3();

  const cos = Math.cos(plan.roll);
  const sin = Math.sin(plan.roll);

  for (const star of shape.stars) {
    const dx = (star.dx * cos - star.dy * sin) * plan.spread * DEG;
    const dy = (star.dx * sin + star.dy * cos) * plan.spread * DEG;
    at.copy(centre)
      .addScaledVector(right, Math.tan(dx))
      .addScaledVector(up, Math.tan(dy))
      .normalize()
      .multiplyScalar(SKY.radius);
    points.push(at.x, at.y, at.z);

    // Warm white, and the only thing separating one star from the next is how
    // bright it is — which is the whole mechanism by which the shape is legible.
    tint.setHSL(44 / 360, 0.05, brightnessOf(star.mag), SRGBColorSpace);
    colours.push(tint.r, tint.g, tint.b);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(points), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colours), 3));
  const stars = new Points(
    geometry,
    new PointsMaterial({
      // A shade larger than the field's 1.7, which is the other half of "brighter
      // than its neighbours" and is how a named star has always been drawn.
      size: 2.3,
      sizeAttenuation: false,
      vertexColors: true,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    }),
  );
  stars.renderOrder = order;
  return stars;
}

/** Clamp without importing MathUtils for one call. */
function MathClamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A nebula, as threads rather than as haze.
 *
 * Each filament starts near the centre and walks a flow field — the heading
 * turns by an amount that depends on where it is, so neighbouring threads curve
 * together and the whole patch reads as one structure being pushed by one force.
 * That coherence is the entire effect; a scatter of unrelated squiggles reads as
 * damage to the screen.
 *
 * Brightness peaks in the middle of a thread and dies at both ends, so nothing
 * has a visible start or stop. A filament with square ends looks drawn.
 */
function buildNebula(plan: NebulaPlan, order: number): Group {
  const group = new Group();
  orient(group, plan.azimuth, plan.elevation);
  const rng = makeRng(Math.floor(plan.phase * 100000) + 17);
  const reach = worldSize(plan.extent);
  const strokes = newStrokes();

  for (let f = 0; f < plan.filaments; f++) {
    let x = range(rng, -reach * 0.55, reach * 0.55);
    let y = range(rng, -reach * 0.4, reach * 0.4);
    let heading = range(rng, 0, TAU);
    const step = (reach * 1.5) / SKY.filamentSteps;
    // The field has to vary over the *length of a filament*, not over the whole
    // patch. The first attempt used 2.4/reach, which changes by about a fifth of
    // a radian across twenty steps — near-constant turning, and constant turning
    // draws a circle. Every thread came out a closed loop. This is fast enough
    // that a thread meets several different pushes on its way across.
    const scale = 16 / reach;
    const bias = range(rng, -0.5, 0.5);

    for (let i = 0; i < SKY.filamentSteps; i++) {
      const px = x;
      const py = y;
      // The field: a smooth function of position, shared by every filament in
      // this nebula, which is what makes them curve as a family.
      heading +=
        Math.sin(x * scale + y * scale * 0.6 + plan.phase) * 0.34 +
        Math.cos(y * scale * 1.37 - x * scale * 0.4 - plan.phase) * 0.26 +
        bias * 0.08;
      x += Math.cos(heading) * step;
      y += Math.sin(heading) * step;
      // Fade in and out, and fade with distance from the centre so the patch
      // has an edge without anything drawing one.
      const along = Math.sin((Math.PI * (i + 1)) / SKY.filamentSteps);
      const out = Math.max(0, 1 - Math.hypot(x, y) / (reach * 1.15));
      segment(strokes, px, py, x, y, plan.colour, along * out * 0.5, along * out * 0.5);
    }
  }
  group.add(strokeLines(strokes, order));
  return group;
}

// ── the sky ────────────────────────────────────────────────────────────────

/** Marks a child of the backdrop's group as this file's to dispose. See `Backdrop.clear`. */
const OWNED = "backdropOwned";

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
  /** Radians wheeled about the galactic pole since this sky was built. */
  private drift = 0;
  /**
   * The sector's bodies, or null when the sky is off or nothing is built.
   *
   * This field replaces a `tilting` list of groups whose Y scale was animated
   * toward edge-on and back, which was the flat build's way of giving a ringed
   * planet an aspect that changed. Nothing here is faked any more: the bodies
   * carry their own clocks — the giant's jets shear, its storms turn, the
   * moon's craters roll under a terminator that sweeps as the sky wheels — and
   * the ringed planet's rings open and close because its *direction* from the
   * eye genuinely moves. See `render/SkyBodies.ts`.
   */
  private bodies: SkyBodies | null = null;
  /** 0 at rest, 1 at the top of a hyperwarp charge. Set by `warp`. */
  private warpIntensity = 0;
  private readonly axis = new Vector3(0, 1, 0);

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
    // Furthest first: the star band is the ground everything else stands on,
    // then the nebula, then the asterisms.
    this.add(buildStarBand(this.plan.band, nextOrder()));
    if (this.plan.nebula) this.add(buildNebula(this.plan.nebula, nextOrder()));
    // After the field so a named star is never dimmed by a plain one drawn over
    // it.
    for (const shape of this.plan.asterisms) this.add(buildAsterism(shape, nextOrder()));

    /**
     * The bodies, and they are the one thing here that no longer takes a draw
     * order from `nextOrder`.
     *
     * Everything above is a stroke or a point: additive, depth-writing nothing,
     * and therefore ordered entirely by hand — which is exactly why this file
     * could get away with a hand-assigned draw order for its bodies too. The
     * hero bodies are opaque meshes that write depth, so they sort themselves,
     * and they carry the render orders their own files assign (`GasGiant.body`
     * at -1.98, `Planet`'s ring at -1.96, and so on) — every one of them ahead
     * of `SKY.orderFirst`, so a body draws before the star field and the field
     * then depth-tests against it. Stars behind a planet are eaten by the
     * planet, which is the first time that has ever been true here rather than
     * arranged.
     *
     * The sector's own star is fetched rather than passed for the same reason
     * `render/Planet.ts` fetches it: `planLight` is pure in `(seed, sector)`, so
     * this is the same answer `main.ts` already holds, not a second roll of it.
     */
    this.bodies = new SkyBodies(this.plan.bodies, planLight(seed, sector));
    this.add(this.bodies.object);
    // What each body actually came out, written back over the plan's
    // placeholders so `describe()` reports evidence rather than intent.
    const colours = this.bodies.colours;
    this.plan.bodies.forEach((body, index) => {
      if (colours[index]) body.colour.copy(colours[index]);
    });

    this.drift = 0;
    this.object.quaternion.identity();
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

  /**
   * Wheel the sky, and tear it during a jump.
   *
   * The module shipped with no `update` and a good argument for it: nothing in a
   * real sky moves fast enough to see inside a three-minute run, so drift is a
   * lie about a fixed star field. That argument has been overruled deliberately
   * — recorded in `SKY.driftRate` — on the grounds that a provably static sky is
   * one the eye stops reading. The concession is the *axis*: this turns about
   * the galactic pole, so the star band holds its place and everything wheels
   * around it, which is the one rotation a real sky genuinely has.
   *
   * The jump term needs no such apology. During a hyperwarp you are actually
   * travelling between sectors, so the sky tearing past is the truthful thing to
   * draw, and it is staged at a moment the game already owns and already charges
   * half a multiplier for.
   *
   * Time-based, like everything else that accumulates here. A sky that wheels
   * faster on a faster machine would be the same bug as a lengthening trail.
   *
   * **The wheel now does real work rather than only moving the field around.**
   * A sky body's attitude rides it, so a fixed star sweeps a terminator across
   * a giant's disc over the course of a run — and a ringed planet, whose
   * attitude is deliberately held against the wheel, has its own direction from
   * the eye move instead, which opens and closes its rings. Both are what the
   * flat build faked with an animated Y scale and a "breath" on the group's
   * scale, and both are now consequences of the one rotation this file already
   * had rather than a second animation beside it.
   */
  update(dt: number): void {
    if (!backdrop.enabled || !this.plan) return;
    this.axis.copy(this.plan.band.pole);
    this.drift += (SKY.driftRate * DEG) * (1 + this.warpIntensity * SKY.warpSpin) * dt;
    this.object.quaternion.setFromAxisAngle(this.axis, this.drift);
    this.bodies?.update(dt, this.object.quaternion, this.warpIntensity);
  }

  /**
   * How hard the jump is pulling, 0 to 1. Fed the charge's own progress, so the
   * sky accelerates as the drive winds up and stops the instant it lets go.
   */
  warp(intensity: number): void {
    this.warpIntensity = MathClamp(intensity, 0, 1);
  }

  /** What is up, for the debug hook and for a headless harness. */
  /**
   * The galactic plane this sector's sky is built around, or `null` before the
   * first `show`.
   *
   * Exposed for one reason: `render/Nebula.ts` draws the *haze* that fills the
   * same band this file's starfield is weighted toward, and the two have to be
   * the same plane or the sky reads as two skies. Rolling a second pole from
   * the same seed would look like it worked and would not — a second hash of
   * the same number is a different number. So the plan hands over the one it
   * already made.
   *
   * `lane` is the dust lane's own latitude offset, in radians here rather than
   * the degrees the plan stores, because every consumer of it is a shader.
   */
  get plane(): { pole: Vector3; lane: number } | null {
    if (!this.plan) return null;
    return { pole: this.plan.band.pole, lane: this.plan.band.lane * DEG };
  }

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

  /**
   * Tear down what `show` built — and *only* what `show` built.
   *
   * This walked every child of the group and disposed it, which was correct
   * for exactly as long as this file was the group's only contributor. It
   * stopped being correct the moment `main.ts` parented the volumetric nebula
   * here (deliberately, so the haze inherits the sky's pinning, its slow wheel
   * about the pole and its hyperwarp tear rather than running a second clock).
   * The next sector change then removed that nebula from the scene graph and
   * disposed its material — so the haze silently stopped being drawn at all,
   * and a shader recompile was paid for the privilege.
   *
   * A group is not a licence to destroy things you did not make. Everything
   * `show` adds is tagged, and only tagged children are collected; anything
   * else parented here is left strictly alone.
   */
  /**
   * Add something this file owns and may later destroy. See `clear`.
   *
   * A method rather than a convention, because the convention is exactly what
   * failed: four call sites in `show` each wrote `this.object.add(...)`, and
   * nothing distinguished them from the one call site in `main.ts` that also
   * writes to this group and must survive.
   */
  private add(child: Object3D): void {
    child.userData[OWNED] = true;
    this.object.add(child);
  }

  private clear(): void {
    // Bodies first, and through their own teardown rather than through the
    // traverse below. Each is an instance of a hero class that keys its whole
    // lifecycle off a private `key` string; emptying one behind its back would
    // leave it believing it still has a sector built. The traverse then finds
    // an empty group, which is the correct amount of work to do on it.
    this.bodies?.dispose();
    this.bodies = null;
    for (const child of [...this.object.children]) {
      if (child.userData[OWNED] !== true) continue;
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
