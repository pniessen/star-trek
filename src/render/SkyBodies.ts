import {
  Color,
  Euler,
  Group,
  Matrix4,
  Mesh,
  type Object3D,
  Quaternion,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
} from "three";
import { makeRng } from "../chart/rng.js";
import { GasGiant, GIANT } from "./GasGiant.js";
import { planLight, type SectorLight } from "./light.js";
import { Moon } from "./Moon.js";
import { Planet, PLANET } from "./Planet.js";
import { SunHero, SUN_HERO } from "./SunHero.js";

/**
 * The sky's bodies, drawn with the *hero* bodies' own shaders.
 *
 * ---
 *
 * ## Why this file exists
 *
 * A gas giant existed twice in this codebase. `render/GasGiant.ts` is the one
 * `docs/environment.md` §8.1 records taking four rebuilds — domain-warped flow
 * noise, a light-aware terminator, differential band shear, storms that turn,
 * aurorae — and its own header is blunt about what the first three had in
 * common: they were **built out of strokes and never produced a planet**. Only
 * a filled, lit mesh did, immediately, once the medium changed.
 *
 * `render/Backdrop.ts` then went on drawing gas giants out of strokes, in every
 * sector where `planSky` cast one, which is roughly half of them. The version
 * of a gas giant most players saw was the version §8.1 had already written off.
 * The same is true one body at a time down the whole list: a ringed planet made
 * of ellipse arcs beside `Planet.ts`'s analytic ring-shadow-on-body and
 * body-shadow-on-rings; a moon made of one rim stroke and one terminator arc
 * beside `Moon.ts`'s Worley crater field; a sun made of two hoops beside
 * `SunHero.ts`'s core, halo and corona.
 *
 * **So the sky does not get its own bodies. It gets the hero bodies.** Every
 * class in the table below is instantiated, unmodified, and hung on the
 * celestial sphere:
 *
 *   | plan kind             | class      | what it brings                        |
 *   |-----------------------|------------|---------------------------------------|
 *   | `gas-giant`           | `GasGiant` | flow bands, storms, aurorae, limb     |
 *   | `companion`           | `GasGiant` | the same, small and heavily tempered  |
 *   | `ringed`              | `Planet`   | both Cassini shadows, the ring profile|
 *   | `moon`                | `Moon`     | Worley craters, hard terminator       |
 *   | `sun`                 | `SunHero`  | bloom-fed core, halo discs, corona    |
 *
 * The alternative — lifting the shader source into a shared module and
 * re-parameterising it for sky distances — was rejected for the reason the
 * duplication existed in the first place. Two copies of a gas giant diverge;
 * that is not a prediction, it is what already happened here over four
 * rebuilds, and a third copy calling itself "shared" would only move the seam.
 * There is now exactly one gas giant, one ringed planet, one moon and one sun
 * in this project, and this file is a *placement* layer over them.
 *
 * A cubemap bake — the shape `render/NebulaBake.ts` uses, one job a frame into
 * a per-sector cube — was the other candidate and is genuinely attractive here,
 * because a sky body never translates and so never needs re-rendering from a
 * new angle. It is not taken, for two reasons and one blocker. The blocker:
 * baking needs a `WebGLRenderer`, `Backdrop`'s public surface is
 * `show`/`follow`/`update`/`warp` and none of them is handed one, and `main.ts`
 * is out of scope. The two reasons it is not worth asking for: every one of
 * these bodies is *alive* — the giant's jets shear against each other, its
 * storms turn, the moon's craters roll under a sweeping terminator — and a bake
 * freezes exactly that; and the measured cost of drawing them live turned out
 * to be affordable (see `docs`-facing numbers in the task report), which is the
 * only thing that would have justified the complexity.
 *
 * ---
 *
 * ## What the sky costs the hero bodies: nothing
 *
 * `Backdrop`'s composition rule now refuses to cast a sky body of the same kind
 * as the sector's own hero (see `planSky`). That is not tidiness. Two gas
 * giants in one frame is the one thing that would make both read as wallpaper,
 * and it is also what keeps the fill budget bounded: the expensive shader can
 * only ever be on screen once at hero scale.
 *
 * ---
 *
 * ## Three attitudes, one per problem
 *
 * A sky body is parented under `Backdrop.object`, which is pinned to the
 * camera's *position* and wheels slowly about the galactic pole. What each body
 * does about that wheel is decided per kind, because the three kinds want three
 * different things and one of them is a correctness requirement rather than a
 * preference:
 *
 *  - **Giants, companions and moons ride the wheel.** Their shaders take the
 *    star's direction in *world* space and compare it against a view-space
 *    normal (`GasGiant.ts`'s `BODY_VERTEX`, `Moon.ts`'s), so a rotating mesh is
 *    handled for free by `normalMatrix` — and riding the wheel means their
 *    attitude turns under a fixed star, which sweeps the terminator across the
 *    disc over a run. That is the single best thing the drift buys and it costs
 *    nothing.
 *  - **The ringed planet is counter-rotated** — `holder.quaternion` is set to
 *    the inverse of the sky's own every frame, so its world attitude is fixed.
 *    This is not taste. `Planet.ts`'s `BODY_FRAGMENT` traces the ring's shadow
 *    from an *object-space* surface point against `uLightDirWorld`, and its own
 *    comment says why that is legal: "only the same vector in both spaces while
 *    the mesh carries no rotation of its own." Let it wheel and the Cassini
 *    division would drift out of its own shadow — the exact tell that file
 *    exists to avoid. It loses the terminator sweep and keeps the better
 *    motion: its *direction* from the eye still wheels, so the ring genuinely
 *    opens and closes over a run, which is what the flat version had to fake
 *    with an animated Y scale and what sent this body into world space in the
 *    first place.
 *  - **The sun is a billboard in sky space.** `SunHero`'s halo discs and corona
 *    are flat geometry that `main.ts` keeps facing the player with `lookAt`;
 *    here the eye is at the sky group's own origin and never moves relative to
 *    it, so the facing is a constant of the composition and is baked once. Its
 *    `follow` is deliberately never called — that method re-anchors the whole
 *    group on the player every frame, which is the right answer for the
 *    sector's own star and the wrong one for a body pinned to the sky.
 *
 * ---
 *
 * ## The apparent-size threshold, at last
 *
 * `CLAUDE.md` carries a requirement with no enforcement mechanism anywhere in
 * the code: bodies are exempt from "colour is information" and may be saturated
 * and bright, **but "small and distant should stay desaturated"** — a
 * frame-filling planet cannot be mistaken for a contact, a small bright disc at
 * range can. The note says outright that no apparent-size threshold exists and
 * that `docs/todo.md` is to close the gap "before a moon or the comet's head —
 * both far smaller on screen — inherits it silently."
 *
 * This is the natural place for it, because this is the first file in the
 * project that draws hero-grade bodies at *every* size from half a degree to
 * ten. `temper` below is that threshold: a body's saturation and its light both
 * ramp with apparent radius, full above `TEMPER.fullAt` and floored below
 * `TEMPER.mutedAt`. It is applied by walking uniform *names* — anything ending
 * `Saturation`, plus `uLightColor` — rather than by knowing each body's
 * palette, which is what lets a body added later inherit it for free instead of
 * silently opting out. Suns are exempt and say so where that is decided: a star
 * is the one thing up there that genuinely emits, and `Backdrop`'s own previous
 * build already carried that exception.
 *
 * The same walk carries `TEMPER.distanceDim`, which is the other half of the
 * old sky's colour rule kept rather than discarded. That rule capped the sky's
 * luminance so it never crossed the bloom threshold and never washed out stroke
 * text drawn through the same glow. Hero materials are authored for a body a
 * few hundred units away and would blow straight through it. Dimming the
 * sector light every sky body reads is the physically honest form of the same
 * restraint — these bodies are further away than any hero body — and it leaves
 * the *shading* untouched, which is what the old luminance cap could not do
 * (see `Backdrop`'s own note on why squeezing brightness legislated away the
 * sphere).
 */

/** What a sector's sky may contain. Defined here rather than in `Backdrop`
 * because this file is what turns a kind into geometry, and `Backdrop` would
 * otherwise be importing a type from the module that imports it. */
export type SkyBodyKind = "gas-giant" | "ringed" | "sun" | "companion" | "moon";

/**
 * One placement, as `Backdrop`'s `planSky` hands it over. Everything here is a
 * fact about the *composition*; nothing is a fact about the body's own look,
 * which is the hero class's business and is rolled from `variant`.
 */
export interface SkyBodySpec {
  readonly kind: SkyBodyKind;
  /** Degrees clockwise from +Z, measured the way `Ship.heading` is. */
  readonly azimuth: number;
  /** Degrees above the floor. */
  readonly elevation: number;
  /**
   * Apparent radius of the *body* in degrees — not of its halo, not of its
   * rings. Both of those are fixed multiples in the hero class's own
   * constants, so quoting the body is the one figure that means the same thing
   * across all five kinds.
   */
  readonly size: number;
  /**
   * The seed handed to the hero class in place of the campaign's. Two sky
   * giants in neighbouring sectors must not be the same giant, and the hero
   * classes key their whole look off `(seed, sector)` — so the composition
   * rolls one number per body and lets each class hash it its own way.
   */
  readonly variant: number;
}

export const SKY_BODY = {
  /**
   * How far out a sky body's centre sits, and it is deliberately *inside*
   * `SKY.radius` where the star field is.
   *
   * The distance is meaningless on its own — the sky is camera-pinned, so only
   * angular size is ever seen, and every world radius here is derived back from
   * an angle at this number. What the gap buys is depth ordering that needs no
   * arguing about: a sky body now writes depth (hero materials are opaque
   * meshes, unlike the strokes they replaced), and sitting a chunk nearer than
   * the star shell means every star behind a body is correctly eaten by it and
   * no additive halo ever z-fights one. The old build got the same result from
   * hand-assigned draw order because nothing it drew wrote depth at all.
   */
  radius: 560,

  // ── the apparent-size threshold (`CLAUDE.md`, `docs/environment.md` §4.1) ──

  /**
   * At and above this apparent radius in degrees, a body wears its hero
   * palette untouched. Ten degrees of sky is a body that fills a quarter of the
   * frame's height; nothing at that size is ever read as a contact, which is
   * the entire condition §4.1 attaches to the exemption.
   */
  fullAt: 6.0,
  /**
   * At and below this, the temper is at its floor. Under about a degree and a
   * half a body is a bright dot a few dozen pixels across — which is exactly
   * what an unresolved return looks like, and exactly the case the rule was
   * written for.
   */
  mutedAt: 1.5,
  /** Saturation multiplier at the floor. */
  minSaturation: 0.34,
  /** Light multiplier at the floor, on top of `distanceDim`. */
  minBrightness: 0.55,
  /**
   * What every sky body's light is scaled by regardless of size.
   *
   * The old sky capped its own luminance at 0.72 sRGB explicitly so it would
   * sit under the bloom pass's threshold and never wash out the stroke text
   * drawn through the same glow. Hero materials are authored for a body a few
   * hundred units out and carry no such cap. This is that restraint restated
   * as the thing it always physically was — a sky body is further away than any
   * hero body — applied to the light rather than to the palette, so the
   * *shading* survives it. `Backdrop`'s own note records what happened the one
   * time this was done by squeezing brightness instead: the terminator and the
   * limb falloff had nowhere to go and the sphere disappeared.
   */
  distanceDim: 0.72,

  // ── the sun ────────────────────────────────────────────────────────────────

  /**
   * Whether a sun escapes the temper. It does, and the old build already said
   * why where it drew one: a star is the only thing in the sky that emits, and
   * it is small enough that letting it through the bloom threshold buys a halo
   * rather than a washed-out frame. `SunHero`'s core is deliberately built past
   * that threshold; dimming it here would be undoing the one thing that makes
   * it a star.
   */
  sunExempt: true,

  // ── time ───────────────────────────────────────────────────────────────────

  /**
   * How much a hyperwarp charge multiplies every sky body's own clock.
   *
   * The sky already tears during a jump — `SKY.warpSpin` — on the argument that
   * you genuinely are moving between sectors, so it is truthful rather than
   * decorative. The same argument covers the bodies' own weather: their clocks
   * run on the same wind-up and settle the instant the drive lets go. Carried
   * over unchanged from the number the flat build used for its faked aspect
   * animation, which is the one thing this replaces.
   */
  warpTimeScale: 8,
} as const;

const DEG = Math.PI / 180;

/** Unit vector for a placement, in the sky's own frame. `atan2(x, z)`, the way
 * every bearing in this game is measured. */
function direction(azimuth: number, elevation: number, out: Vector3): Vector3 {
  const a = azimuth * DEG;
  const e = elevation * DEG;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}

/** Apparent radius in degrees to a world radius at `SKY_BODY.radius`. */
export function bodyWorldSize(size: number): number {
  return Math.tan(size * DEG) * SKY_BODY.radius;
}

/**
 * The structural contract all four hero classes already satisfy without being
 * asked to — an `object` to hang, a `dt` clock, and a teardown. Declared
 * rather than imported because no one of them declares it, and writing it here
 * is what makes "the sky draws the hero bodies" a type-checked claim instead of
 * four near-identical branches.
 */
interface HeroBody {
  readonly object: Group;
  update(dt: number): void;
  hide(): void;
}

interface Entry {
  /** The oriented, scaled group the hero body hangs in. */
  readonly holder: Group;
  readonly body: HeroBody;
  /**
   * The attitude this body wants in the sky's own frame, before the wheel is
   * accounted for. See the header's three-attitudes note.
   */
  readonly attitude: Quaternion;
  /**
   * Whether the sky's wheel is cancelled out of that attitude every frame.
   * True for the ringed planet alone, and for a correctness reason rather than
   * a stylistic one — `Planet.ts` computes its ring shadow in object space.
   */
  readonly fixed: boolean;
  /** What `describe()` should report. Read off the built material, not guessed. */
  readonly colour: Color;
}

const _dir = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _toward = new Vector3();
const _basis = new Matrix4();
const _inverse = new Quaternion();
const _hsl = { h: 0, s: 0, l: 0 };

/**
 * The sky's bodies for one sector.
 *
 * Built whole in the constructor and thrown away whole on a sector change,
 * which is the same lifecycle `Backdrop` has always had for everything it
 * draws — and the reason nothing here caches per body: a sky is rebuilt twice
 * in a war, on the two frames `campaign.current` can move.
 */
export class SkyBodies {
  readonly object = Object.assign(new Group(), { name: "sky-bodies" });

  private readonly entries: Entry[] = [];

  /**
   * `light` is the *sector's* own star — `planLight(seed, sector)`, the same
   * object `main.ts` hands the hero giant and the same one `Asteroids` picks up
   * through the scene's `DirectionalLight`.
   *
   * Handing sky bodies the sector's light rather than one of their own is a
   * choice worth stating, because the literal-minded answer is the opposite: a
   * body on the celestial sphere is another star system entirely and has no
   * business obeying this one's sun. It obeys anyway, because
   * `docs/environment.md` §3.1 is about the *frame* rather than about
   * astronomy — "the sector's one light, every body obeys it" — and a sky giant
   * lit from the left above a hero giant lit from the right is the single
   * fastest way to make both look pasted on. The old flat build rolled a
   * private `light` angle per body and had exactly that problem; it just could
   * not be seen, because a stroke rim cannot express a terminator.
   */
  constructor(specs: readonly SkyBodySpec[], light: SectorLight) {
    specs.forEach((spec, index) => this.build(spec, index, light));
  }

  private build(spec: SkyBodySpec, index: number, light: SectorLight): void {
    const holder = new Group();
    const world = bodyWorldSize(spec.size);

    let body: HeroBody;
    let scale: number;
    let fixed = false;
    let colour: Color;

    if (spec.kind === "gas-giant" || spec.kind === "companion") {
      const giant = new GasGiant();
      giant.show(spec.variant, index, light);
      body = giant;
      scale = world / GIANT.radius;
      // The disc's mid-tone stop, which is what the eye actually averages a
      // banded body to. Read off the built uniform rather than re-rolled, so
      // `describe()` cannot disagree with what is on screen.
      const hue = (giant.body?.material as ShaderMaterial | undefined)?.uniforms.uHue.value ?? GIANT.baseHueMin;
      colour = new Color().setHSL(
        wrapHue(hue + GIANT.midHueOffset),
        GIANT.midSaturation,
        GIANT.midLightness,
        SRGBColorSpace,
      );
    } else if (spec.kind === "ringed") {
      const planet = new Planet();
      planet.show(spec.variant, index);
      // `Planet` is the one hero class that fetches its own `SectorLight`
      // instead of taking one — its header says so, and says the alternative
      // is a one-line change in `main.ts`, which this task may not make. So
      // the sector's light is written over the top of the one it rolled. Three
      // materials, and the ring's own `uLightDirLocal` has to be re-derived
      // rather than copied: it is the light carried into the ring plane's
      // frame, and that frame is `ring.rotation.x` — the only rotation this
      // body carries.
      relight(planet, light);
      body = planet;
      // Read back rather than recomputed: `PLANET.radius` is scaled by a
      // per-sector roll this class keeps private, and the geometry is the one
      // place the answer is not a guess.
      const built = (planet.body?.geometry as { parameters?: { radius?: number } } | undefined)?.parameters?.radius;
      scale = world / (built ?? PLANET.radius);
      // Fixed attitude: the ring shadow is traced in object space. See header.
      fixed = true;
      const hue = (planet.body?.material as ShaderMaterial | undefined)?.uniforms.uHue.value ?? 0;
      colour = new Color().setHSL(
        wrapHue(hue + PLANET.beltHueOffset),
        PLANET.beltSaturation,
        PLANET.beltLightness,
        SRGBColorSpace,
      );
    } else if (spec.kind === "moon") {
      const moon = new Moon();
      moon.show(spec.variant, index, light);
      body = moon;
      const built = (moon.body?.geometry as { parameters?: { radius?: number } } | undefined)?.parameters?.radius;
      scale = world / (built ?? GIANT.radius * 0.6);
      // `Moon.ts`'s albedo is two hardcoded near-neutral greys mixed by its
      // maria term; the midpoint is the honest single answer and there is no
      // uniform to read it off.
      colour = new Color(0x7b766f);
    } else {
      /**
       * A sun, and the one body whose *own* colour is the point.
       *
       * `SunHero` takes a `SectorLight` and paints itself the star's colour —
       * it is the only hero body that draws the light rather than obeying it.
       * So this passes a star of its own, rolled off the body's variant
       * through the same `planLight` the sector's star comes from, which is
       * what keeps a binary pair honest: two stars drawn from the black-body
       * bands `STAR` already defines are a warm one and a cool one far more
       * often than not, and a matched pair reads as a double image rather
       * than as a system. The old build reached the same place by hand,
       * drawing one sun from `bone` and the other from `slate`.
       */
      const own: SectorLight = planLight(spec.variant, index);
      const sun = new SunHero();
      sun.show(spec.variant, index, own);
      body = sun;
      // `size` is the *core*'s apparent radius. The halo discs and the corona
      // are fixed multiples of it in `SUN_HERO`, so quoting the core is what
      // keeps `size` meaning the same thing here as it does on a planet.
      scale = world / SUN_HERO.coreRadius;
      colour = own.colour.clone();
    }

    /**
     * Every hero class parks its group at its own world anchor at the end of
     * `show` — `GIANT.range` dead ahead, `PLANET.range` on a seeded bearing,
     * the sun's own offset along the light. None of that survives here: the
     * placement is the sky's, and `follow` — the method that would keep
     * re-applying the anchor — is deliberately never called on any of them.
     */
    body.object.position.set(0, 0, 0);
    body.object.scale.setScalar(scale);
    holder.add(body.object);

    direction(spec.azimuth, spec.elevation, _dir);
    holder.position.copy(_dir).multiplyScalar(SKY_BODY.radius);

    const attitude = attitudeFor(spec, index);
    holder.quaternion.copy(attitude);

    const temper = tempering(spec);
    applyTemper(body.object, temper.saturation, temper.brightness);
    colour.multiplyScalar(temper.brightness);
    // Saturation is a palette property, not a light one, so the reported
    // colour has to lose it the same way the material does or `describe()`
    // would over-report exactly the axis the threshold exists to hold down.
    colour.getHSL(_hsl, SRGBColorSpace);
    colour.setHSL(_hsl.h, _hsl.s * temper.saturation, _hsl.l, SRGBColorSpace);

    this.object.add(holder);
    this.entries.push({ holder, body, attitude, fixed, colour });
  }

  /** The colour each body actually came out, in plan order, for `describe()`. */
  get colours(): readonly Color[] {
    return this.entries.map((entry) => entry.colour);
  }

  /**
   * Advance every body's own clock, and hold the ringed planet's attitude
   * against the sky's wheel.
   *
   * `skyRotation` is `Backdrop.object.quaternion` — the wheel about the
   * galactic pole. Only the fixed entries read it, and they read it as an
   * inverse: cancelling it here is cheaper and far less surprising than
   * counter-rotating the sky's whole graph, and it is the one thing standing
   * between `Planet`'s ring shadow and a Cassini division that drifts out of
   * its own gap.
   */
  update(dt: number, skyRotation: Quaternion, warp = 0): void {
    const scaled = dt * (1 + warp * SKY_BODY.warpTimeScale);
    let anyFixed = false;
    for (const entry of this.entries) {
      entry.body.update(scaled);
      anyFixed = anyFixed || entry.fixed;
    }
    if (!anyFixed) return;
    _inverse.copy(skyRotation).invert();
    for (const entry of this.entries) {
      if (entry.fixed) entry.holder.quaternion.multiplyQuaternions(_inverse, entry.attitude);
    }
  }

  /**
   * Hand every body back to its own teardown rather than disposing the meshes
   * from out here.
   *
   * `Backdrop.clear` walks its tagged children disposing geometry and material,
   * and would do a correct job of it — but a hero class that has been emptied
   * behind its own back still believes it has a sector built (`key` is a
   * private string on each) and its next `show` would be a no-op returning
   * disposed resources. These instances are thrown away rather than reused, so
   * that could not actually bite; calling `hide()` costs one string assignment
   * and removes the trap rather than documenting it.
   */
  dispose(): void {
    for (const entry of this.entries) {
      entry.body.hide();
      entry.holder.clear();
    }
    this.entries.length = 0;
    this.object.clear();
  }
}

function wrapHue(degrees: number): number {
  return ((((degrees % 360) + 360) % 360) / 360);
}

/**
 * The attitude a body wants in the sky's own frame.
 *
 * Three answers, one per kind, and the header carries the argument. A sun is
 * turned to face the eye because half of it is flat geometry; a ringed planet
 * is left upright because its shader works in object space; everything else
 * gets a seeded axial tilt, which is the one thing that stops every giant in
 * the game presenting its bands as perfectly horizontal stripes — the hero
 * giant does exactly that, and gets away with it by being the only body in
 * frame.
 */
function attitudeFor(spec: SkyBodySpec, index: number): Quaternion {
  const quaternion = new Quaternion();
  if (spec.kind === "sun") {
    // Local +Z back at the eye, which sits at the sky group's origin. Built
    // from an explicit basis rather than with `lookAt`, for the reason
    // `Backdrop.orient` already gives: `lookAt` resolves against the parent's
    // world matrix and this group's parent moves every frame, so the
    // orientation has to be a fact about the composition rather than about
    // where the ship happened to be standing when it was built.
    direction(spec.azimuth, spec.elevation, _toward).negate();
    _right.set(0, 1, 0).cross(_toward).normalize();
    _up.copy(_toward).cross(_right).normalize();
    return quaternion.setFromRotationMatrix(_basis.makeBasis(_right, _up, _toward));
  }
  if (spec.kind === "ringed") return quaternion;

  // A tilt off the vertical, seeded so a sector always tilts the same way, and
  // held well short of edge-on: past about a third of a right angle the bands
  // stop reading as latitude and start reading as a pattern printed on a ball.
  const rng = makeRng((spec.variant * 2654435761 + index * 2246822519 + 374761393) >>> 0);
  const tilt = (rng.next() * 2 - 1) * TILT_LIMIT;
  // The tilt is applied about the axis the eye is looking down first, then
  // swung round the vertical — so the same tilt magnitude presents as anything
  // from a body leaning across the frame to one leaning away from it, rather
  // than every giant in the game leaning the same way.
  const swing = rng.next() * Math.PI * 2;
  return quaternion.setFromEuler(new Euler(tilt, swing, 0, "YXZ"));
}

/** Radians of axial tilt a body may be given, either way. Past about a third
 * of a right angle a banded disc stops reading as latitude and starts reading
 * as a pattern printed on a ball. */
const TILT_LIMIT = 0.52;

/** How hard the apparent-size threshold bites on one body. */
function tempering(spec: SkyBodySpec): { saturation: number; brightness: number } {
  if (spec.kind === "sun" && SKY_BODY.sunExempt) return { saturation: 1, brightness: 1 };
  const span = Math.max(1e-3, SKY_BODY.fullAt - SKY_BODY.mutedAt);
  const t = Math.max(0, Math.min(1, (spec.size - SKY_BODY.mutedAt) / span));
  // Smoothstep rather than a straight ramp: the visible threshold is the point
  // where a body stops being ambiguous, and a linear ramp puts most of its
  // change in the middle of the range where nothing is in question.
  const eased = t * t * (3 - 2 * t);
  return {
    saturation: SKY_BODY.minSaturation + (1 - SKY_BODY.minSaturation) * eased,
    brightness: SKY_BODY.distanceDim * (SKY_BODY.minBrightness + (1 - SKY_BODY.minBrightness) * eased),
  };
}

/**
 * Apply the threshold by walking uniform *names*.
 *
 * Every lit body in this project specifies its palette in HSL through uniforms
 * whose names end in `Saturation` — `GasGiant`'s six band stops plus its storm,
 * oval and pole, `Planet`'s four plus its pole — and every one of them takes
 * the star through `uLightColor`. That naming is a convention rather than an
 * interface, and leaning on it is a deliberate trade: a body added later
 * inherits the threshold for free instead of silently opting out of it, which
 * is the failure mode `CLAUDE.md` names directly when it says the gap has to be
 * closed "before a moon or the comet's head inherits it silently."
 *
 * The alternative was a per-class table of uniform names. That is the version
 * that goes stale the first time someone adds a seventh colour stop.
 */
function applyTemper(root: Object3D, saturation: number, brightness: number): void {
  root.traverse((node) => {
    const material = (node as Mesh).material;
    if (!material || Array.isArray(material)) return;
    const uniforms = (material as ShaderMaterial).uniforms;
    if (uniforms) {
      for (const name of Object.keys(uniforms)) {
        const uniform = uniforms[name];
        if (name.endsWith("Saturation") && typeof uniform.value === "number") uniform.value *= saturation;
      }
      const lit = uniforms.uLightColor?.value;
      if (lit instanceof Color || lit instanceof Vector3) lit.multiplyScalar(brightness);
      return;
    }
    // The unlit half — `SunHero`'s core, halo discs and corona, which carry
    // their colour on the material rather than in a uniform. Reached only by a
    // body the exemption above has already let through at 1.0, so this is a
    // no-op today and is written anyway: the next unlit body to appear in the
    // sky should not have to discover that the threshold skipped it.
    const colour = (material as { color?: Color }).color;
    if (colour instanceof Color) colour.multiplyScalar(brightness);
  });
}

/**
 * Write the sector's star over the one `Planet` rolled for itself.
 *
 * `Planet.show` takes `(seed, sector)` alone and calls `planLight` inside — its
 * header explains that this is the same source of truth asked twice, and notes
 * that threading the light through would be a one-line change in `main.ts`.
 * Here the seed handed in is a *variant*, so the light it rolls is a different
 * star from the sector's, and the body would be the one thing in frame lit from
 * somewhere else.
 *
 * Three materials carry it. Two want the world direction; the ring additionally
 * wants that direction in its own plane's frame, which is `ring.rotation.x` —
 * the single rotation this body carries, set by `Planet` from its own tilt.
 * Re-derived rather than copied, because the tilt itself is private and the
 * rotation is the same number by construction.
 */
function relight(planet: Planet, light: SectorLight): void {
  const direction = light.position.clone().normalize();
  const local = planet.ring
    ? direction.clone().applyMatrix4(new Matrix4().makeRotationX(planet.ring.rotation.x).invert()).normalize()
    : direction.clone();
  for (const mesh of [planet.body, planet.limb, planet.ring]) {
    const uniforms = (mesh?.material as ShaderMaterial | undefined)?.uniforms;
    if (!uniforms) continue;
    if (uniforms.uLightDirWorld) (uniforms.uLightDirWorld.value as Vector3).copy(direction);
    if (uniforms.uLightDirLocal) (uniforms.uLightDirLocal.value as Vector3).copy(local);
    if (uniforms.uLightColor) (uniforms.uLightColor.value as Color).copy(light.colour);
  }
}
