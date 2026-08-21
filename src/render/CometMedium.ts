import { Color, Object3D, SRGBColorSpace, Vector3 } from "three";
import { MediaVolume, type MediaLightSource, mediaMaterial, mediaQuality } from "./shaders/media.js";

/**
 * The comet as a real volume — the raymarched half of `game/comet.ts`.
 *
 * ## Why this is not in `comet.ts`
 *
 * The comet's one gameplay rule is sacred: *inside the tail, no instrument
 * works*, and `interferenceAt` is the single function that decides how jammed a
 * point is. That rule and this file must agree about the tail's shape and must
 * never share a line of code that could let one drift into the other by
 * accident, so the taper is written twice on purpose — once in TypeScript for
 * the rule, once in GLSL for the picture — and the GLSL restates
 * `interferenceAt`'s own arithmetic term for term, with the same
 * `solidFraction` and `tipFloor` handed in as uniforms rather than baked. A
 * renderer living inside the gameplay file is a renderer one refactor away from
 * being asked to answer a gameplay question.
 *
 * ## What the march buys that eighty-four filaments could not
 *
 * `COMET.filaments`' own comment is a good argument that ends one step early.
 * It records the right finding — five hundred loose motes read as "a collection
 * of vector lines", and connected strands read as gas — and it could not reach
 * the property that actually separates a comet from a drawing of one: **the
 * tail has an inside, and things inside it are in front of or behind each
 * other.** An additive stroke adds. Eighty-four of them add eighty-four times,
 * in any order, so a dense knot of dust is exactly as bright standing in front
 * of the coma as behind it. The whole visual grammar of a real comet — a dark
 * lane cutting across a bright head, the head shining *through* the near dust
 * rather than beside it — is a statement about depth order inside a medium, and
 * strokes cannot make it.
 *
 * A front-to-back march can, and gets three more things on the way:
 *
 * - **The coma is scattering rather than drawn.** It was a brightness ramp on
 *   the filaments (`COMA_GLOW`), which is a painting of a halo. Here it is a
 *   genuinely dense ball with its own emission that the tail's own gas both
 *   lights and occludes.
 * - **The tail knows where its sun is.** The plan already says so and nobody
 *   ever read it: `direction` is *away from the star* by construction
 *   (`tailDirection`), so `-direction` is the light, for free, with no
 *   `SectorLight` to thread through `show`. Looking down-sun through the tail
 *   brightens it — the forward-scattering lobe every real cometary photograph
 *   is built on.
 * - **A warhead inside the tail lights the tail.** See `MediaVolume
 *   .injectLights`.
 *
 * ## What it does not do
 *
 * `G` (wireframe vs occluded) does not reach it, and should not: that toggle is
 * about hulls having faces to occlude with, and a medium has no faces. `Comet
 * .setMode` still drives the nucleus rock, which is the only thing in this
 * encounter that is geometry.
 */

/**
 * Every number the comet's medium is. First-draft guesses of exactly the same
 * species as `COMET`'s own — reasoned about, never flown. The three worth
 * flying first are `sigma`, `keyGain` and `comaDensity`: between them they
 * decide whether the tail is a haze you fly through or a wall you cannot see
 * past, which is the one question this feature can get wrong in a way that
 * touches play rather than looks.
 */
export const COMET_MEDIA = {
  /**
   * Samples per march, and **the whole cost of this feature is here**.
   *
   * **Was 14, and the lever that moved it was the one this file's old comment
   * predicted.** That comment ended by naming the thing that would change the
   * curve — "a baked 3D noise texture, which trades sixteen hash evaluations
   * per sample for two texture fetches" — and `render/shaders/media.ts`'s
   * `mediaNoise` is now that. Measured on an M2 Max at 3024x1964, a maximum-size
   * fixture (221 long, 136 radius) with the camera inside it and the medium
   * covering every pixel:
   *
   * | steps | analytic `fbm3` | `mediaNoise` texture |
   * |------:|----------------:|---------------------:|
   * |     8 |         2.88 ms |              1.15 ms |
   * |    20 |         7.57 ms |              3.75 ms |
   *
   * which is **0.391 ms per step before and 0.216 ms per step after** — the
   * per-step price of the cone cut by 1.8x, and the old 14-step configuration
   * (5.2 ms) now buying 22 steps for less (4.5 ms).
   *
   * 22 rather than 26 or 32, and the reason is not the budget. It is that
   * `MEDIA.growth` compounds: at 1.11 across 22 samples the last step is
   * already nine times the first, and adding samples at the near end — which is
   * where the growth puts them — buys resolution the eye has stopped asking for
   * long before the far end stops shedding it. Past about 24 the picture stopped
   * changing in the poses that matter (a wanderer at combat range, a fixture
   * seen from outside) while the bill kept rising. **This is a case where the
   * money ran out of things to buy before it ran out.** The rest of the winnings
   * are banked against the case that actually has to fit: a comet and a shoal
   * standing in the same sector, both filling the frame.
   */
  steps: 22,
  /**
   * Rows of the `mediaNoise` ladder. **Three, up from two, and the third row is
   * the *coarse* one rather than a third harmonic** — see `NOISE_LADDER`, which
   * is ordered by importance rather than by frequency precisely so that a
   * caller asking for one more octave gets the row that matters most next.
   *
   * What the third row buys here is specific: the field tiles every six base
   * cells, which at `noiseScale` 0.11 is 54 world units, against a fixture's
   * 273-unit width. Two rows put the largest feature in the picture at exactly
   * the period of the repeat. The coarse row sits at a 127-unit period and
   * carries a third of the amplitude, so the streamers the eye follows are no
   * longer the thing that repeats — and a tail gains the large-scale structure
   * a real one has, which two harmonics of one small cell could not produce at
   * any octave count.
   *
   * The old comment's measurement — "dropping from two octaves to one saved 2.6
   * ms of 8.7, so the noise is only about a third of the bill" — was true of the
   * analytic ladder and is the reason this number could rise: a row is now one
   * texture fetch rather than eight hash evaluations, so the third row costs a
   * few percent instead of a third. Four rows was flown and rejected, not on
   * cost: row 3 sits at 4.13 base cells, which is ~2 world units of feature
   * against a march step of ~10, so it arrives below the sample spacing and
   * reads as a slight softening rather than as detail. `mediaNoise`'s own header
   * records the hard ceiling behind that — the field is 64 voxels across six
   * cells, and a fifth row would be sampling a grid.
   */
  octaves: 3,
  /**
   * How far along a single march may run, in world units, before it stops
   * caring. A fixture's tail is up to 221 units and can be looked at end-on,
   * which would stretch fourteen samples across the whole of it and lose every
   * feature the noise has. Capping the span keeps the sample spacing near the
   * eye tight and throws away the far end — which the fog
   * (`MEDIA.fogFar` = 260) had already taken most of.
   */
  maxSpan: 190,
  /**
   * Extinction per unit density per world unit — **the number that decides
   * whether the tail is playable**, and the one most worth a human at the
   * keyboard.
   *
   * Flown rather than derived, in three passes. 0.016 (the first draft, priced
   * off an optical-depth-of-1.5 estimate) was invisible: the tail accumulated
   * so little opacity that the medium neither lit nor occluded anything and the
   * whole feature read as absent. 0.05 was a wall — flying into it whited out
   * the frame and a hostile at `COMET.visualRange` was gone. 0.032 is where a
   * sight line across the widest part of a fixture veils the far side without
   * hiding a contact at the range the comet's own firing rule already says a
   * fight happens at.
   */
  sigma: 0.032,
  /** Density on the tail's own axis, before the noise modulates it. 1 keeps
   * the shape term reading exactly as `interferenceAt`'s does. */
  tailDensity: 1,
  /**
   * Density at the centre of the coma. Nine, so a sight line straight through
   * the head (about 22 units at a fixture's `nucleusRadius`) reaches an optical
   * depth near three and the head is genuinely opaque at its middle — which is
   * what makes the rock inside it a silhouette rather than a decoration.
   */
  comaDensity: 9,
  /**
   * Self-emission at the centre of the coma, in the same linear light the rest
   * of the chain works in. The head of a comet is not merely lit dust — it is
   * outgassing, fluorescing, producing light of its own — so this is the one
   * term in the file that does not go through the phase function or the albedo.
   * Above `Stage`'s 0.5 bloom threshold on purpose: the head should glare.
   */
  comaGlow: 2.2,
  /**
   * How hard the coma falls off from the nucleus — **fixed at 2 and no longer
   * a uniform**. It was one, and the exponent it always carried was 2, which
   * meant a `pow()` with a non-constant base *and* a non-constant exponent —
   * a log/exp pair — running once per step per fragment across a body that
   * fills the frame. Squaring is two instructions. The constant is kept here
   * rather than deleted because it is still the shape's own statement about
   * itself; it is simply spelled out in the GLSL now. Changing it means
   * editing `DENSITY`, which is the honest cost of the arithmetic it saves.
   */
  comaFalloff: 2,
  /**
   * World units per noise unit. Smaller means larger features. 0.11 puts the
   * base octave's cell near 9 world units and the second octave's near 4.5,
   * which against a 14-unit wanderer head is structure you can fly past. The
   * first draft was 0.05 and was wrong in a way only the small end showed: a
   * wanderer's tail is 28 units across at the nucleus, so a 20-unit cell gave
   * it barely one feature across its whole width and it read as a smooth cone.
   */
  noiseScale: 0.11,
  /**
   * How far the noise is stretched along the tail's axis. A comet's dust is
   * combed into streamers by the same pressure that makes the tail point where
   * it does, so the field has to be anisotropic or it reads as a cloud that
   * happens to be cone-shaped. 4.5 is nearly five times longer than wide.
   */
  streak: 4.5,
  /**
   * How much the noise is allowed to swing the density either side of the
   * shape term. At 1 the field reaches zero in its thin places, which is what
   * opens the gaps that let the coma show through the near dust — the whole
   * point of the exercise — and it cannot go above 1 without the dense places
   * becoming denser than the shape says the tail is.
   */
  contrast: 0.95,
  /**
   * Single-scattering albedo in the dustiest places, against 1 in the gassiest.
   * **This is the "dark" in "dark dust in front of bright gas."** 0.18 means a
   * dust lane still absorbs at full strength and scatters back barely a fifth
   * as much, so it reads as a shadow cast across the head rather than as a
   * lighter patch of the same stuff.
   */
  dustAlbedo: 0.18,
  /** Where in the noise's own 0-1 range dust begins and where it is total.
   * A wide band rather than a threshold, or the lanes have edges. */
  dustFrom: 0.45,
  dustTo: 0.95,
  /**
   * How hard the star lights the medium, in the same units as `main.ts`'s own
   * `sun` intensity (1.4). Well over it, and paired with a deliberately low
   * `ambient`: that ratio is the whole reason the tail looks different from
   * different headings. An early build had them the other way round (ambient
   * 0.9, key 2.2) and the tail was a uniform milky wash from every bearing —
   * lit *evenly* is the same as not lit at all. Pushing the light into the
   * directional term and starving the floor is what makes turning toward the
   * star through the tail a thing that happens.
   */
  keyGain: 3.6,
  /** How hard an event light — a warhead, a kill — lights the medium, against
   * the star's own gain. Over 1 on purpose: a detonation inside a comet's tail
   * is the shot this whole layer exists for, and inverse square has already
   * taken most of it back by the time the flash is a hull's length away. */
  lightGain: 1.1,
  /** Overall output gain, in linear light. The one knob that moves everything
   * at once, kept separate from `sigma` so brightness and opacity can be
   * argued with independently. */
  gain: 1,
  /** The floor the unlit side sits at. Deliberately small — see `keyGain` for
   * why this being *small* is the point — but never zero: gas with no ambient
   * at all reads as a hole punched in the starfield rather than as a cloud. */
  ambient: 0.12,
  /**
   * Henyey-Greenstein asymmetry for this medium, overriding `MEDIA.anisotropy`
   * (0.55) downward. Measured against the thing itself rather than reasoned
   * about: at 0.55 the ratio between looking straight down-sun through the
   * tail and looking straight up-sun is forty to one, which is physically
   * defensible for real cometary dust and unusable in a game where a comet is
   * a place you fight in — the same tail read as a searchlight from one
   * heading and as nothing from the opposite one. 0.45 keeps the ratio near
   * four, which is still unmistakably a scattering medium and never a
   * lighting bug.
   */
  anisotropy: 0.45,
} as const;

/**
 * The gas. Deliberately the same pale ice-blue argument `COMET_COLOR` makes in
 * `game/comet.ts` — saturation is what keeps a colour out of the information
 * vocabulary, luminance is free — and a shade brighter than the stroke version,
 * because a stroke was the light itself and this is a medium that has to be
 * *lit* to be seen at all.
 */
export const COMET_GAS = new Color().setHSL(203 / 360, 0.22, 0.68, SRGBColorSpace);
/**
 * The dust. Darker, barely saturated, a touch warmer than the gas so the lanes
 * are separable from it by hue as well as by brightness — which matters because
 * the whole read depends on telling one from the other at a glance, and
 * `docs/environment.md` §4.1 exempts a body from "colour is information"
 * precisely so a body may say something with colour.
 */
export const COMET_DUST = new Color().setHSL(215 / 360, 0.12, 0.19, SRGBColorSpace);
/** The ambient floor's colour — cold, because the only other thing lighting
 * this medium is a starfield. */
const COMET_AMBIENT = new Color().setHSL(212 / 360, 0.42, 0.66, SRGBColorSpace);

/**
 * The shape, restated in GLSL.
 *
 * Every term here is `interferenceAt`'s, in the same order, with the same
 * constants arriving as uniforms: the axial test, the linear `radiusAt` taper,
 * the `across` falloff toward the envelope, the `tipFloor`-clamped far-end
 * fade, and the coma as a sphere around the nucleus so the head is not a hole
 * in the middle of its own tail. The one difference is that `across` is squared
 * here — the rule wants a linear ramp so a player can feel the boundary
 * approaching, and the picture wants a soft edge, and those are genuinely
 * different questions about the same cone.
 *
 * The vacuum test before the noise is the file's whole performance story: a
 * fragment marching past the cone's shoulder pays a dot product and a length
 * for each step it wastes, and never touches the `fbm3`.
 */
const UNIFORMS = /* glsl */ `
uniform vec3 uNucleus;
uniform vec3 uAxis;
uniform vec3 uRight;
uniform float uLength;
uniform float uR0;
uniform float uR1;
uniform float uComaR;
uniform float uSolid;
uniform float uTipFloor;
uniform float uFlow;
uniform float uNoiseScale;
uniform float uStreak;
uniform float uContrast;
uniform float uDustAlbedo;
uniform float uDustFrom;
uniform float uDustTo;
uniform vec3 uGasColor;
uniform vec3 uDustColor;
uniform float uComaDensity;
uniform float uComaGlow;
uniform float uTailDensity;
`;

/**
 * Entry and exit, analytically, against the tail's own cone.
 *
 * The axial range runs from `-uComaR` rather than from 0, which is what folds
 * the coma into the same hull as the tail instead of needing a second volume
 * and a second march: the cone's linear radius extended backwards past the
 * nucleus is wider than the coma sphere is at every point (26 against 11 for a
 * fixture, 13 against 6 for a wanderer), so one interval covers both and the
 * density function decides which of the two a sample is actually in.
 */
const BOUNDS = /* glsl */ `
bool mediaBounds(vec3 ro, vec3 rd, out float t0, out float t1) {
  float k = (uR1 - uR0) / max(uLength, 1e-3);
  return coneSpan(ro, rd, uNucleus, uAxis, uR0, k, -uComaR, uLength, t0, t1);
}
`;

const DENSITY = /* glsl */ `
Media mediaSample(vec3 p) {
  Media m;
  m.density = 0.0;
  m.tint = uGasColor;
  m.scatter = 1.0;
  m.glow = 0.0;

  vec3 v = p - uNucleus;
  float s = dot(v, uAxis);
  vec3 perp = v - uAxis * s;
  float across = length(perp);

  float shape = 0.0;
  if (s > 0.0 && s < uLength) {
    float along = s / uLength;
    float r = mix(uR0, uR1, along);
    float edge = clamp(1.0 - across / r, 0.0, 1.0);
    float fade = 1.0 - max(0.0, (along - uSolid) / max(1.0 - uSolid, 1e-3));
    shape = edge * edge * max(uTipFloor, fade) * uTailDensity;
  }

  // Squared on both sides so the coma costs one dot product and no square root
  // for the overwhelming majority of samples, which are nowhere near it — and
  // then squared again for the falloff rather than raised to a uniform power.
  // A pow() with a non-constant exponent is a log/exp pair on most hardware and
  // this ran once per step per fragment; the exponent it was reading was 2.
  float dn2 = dot(v, v);
  float comaR2 = max(uComaR * uComaR, 1e-6);
  float coma = 0.0;
  if (dn2 < comaR2) {
    float k = 1.0 - sqrt(dn2 / comaR2);
    coma = k * k;
  }

  // Vacuum, and the fast path: no noise, no lights, no phase function.
  if (shape <= 0.0 && coma <= 0.0) return m;

  // The noise frame: two perpendicular world axes at true scale, and the axial
  // one squashed by uStreak and scrolled by uFlow. Scrolling the *coordinate*
  // rather than animating the field is what makes the flow time-based (the
  // caller integrates uFlow with dt) and free.
  vec3 q = vec3(dot(perp, uRight), v.y, (s - uFlow) / uStreak) * uNoiseScale;
  // Two decorrelated fields out of one fetch per octave — see mediaNoise.
  // n.x is the density mottle; n.y is the dust, and it being a *different*
  // field is the point. Both used to come off one fbm3, which meant the
  // dustiest place was always the densest place and every thick knot in the
  // tail was therefore a dark one by construction. The medium exists to show
  // dark dust in front of bright gas; it could not, because it had no bright
  // gas — the bright places were the thin ones. Now a knot may be either.
  vec2 n = mediaNoise(q);
  float g = clamp(0.5 + 0.5 * n.x, 0.0, 1.0);

  float mottle = mix(1.0 - uContrast, 1.0 + uContrast, g);
  float dust = smoothstep(uDustFrom, uDustTo, clamp(0.5 + 0.5 * n.y, 0.0, 1.0));

  m.density = shape * mottle + coma * uComaDensity;
  m.tint = mix(uGasColor, uDustColor, dust);
  m.scatter = mix(1.0, uDustAlbedo, dust);
  m.glow = coma * uComaGlow;
  return m;
}
`;

/** What the volume needs to know about the comet it is drawing. Deliberately
 * the fields of `CometPlan` and nothing else — this file never sees a
 * `CometPlan`, so it cannot be tempted to read one of the gameplay fields off
 * it. */
export interface CometShape {
  nucleus: Vector3;
  direction: Vector3;
  length: number;
  nearRadius: number;
  farRadius: number;
  nucleusRadius: number;
}

/**
 * One comet's medium. Built by `Comet.show` when a plan stands and disposed
 * with it.
 *
 * Returns `null` from `build` on a machine that cannot afford a march — see
 * `mediaQuality`. A caller that gets `null` keeps whatever it drew before,
 * which is what makes this a strict addition rather than a replacement the
 * harness has to know about.
 */
export class CometMedium {
  private readonly volume: MediaVolume;
  /** Scrolled by `COMET.flow * dt`, in world units along the axis. Time-based
   * per the house rule, and the only thing about this medium that moves. */
  private flow = 0;
  private readonly centre = new Vector3();
  private readonly toStar = new Vector3();

  static build(shape: CometShape, solidFraction: number, tipFloor: number): CometMedium | null {
    if (mediaQuality() <= 0) return null;
    return new CometMedium(shape, solidFraction, tipFloor);
  }

  private constructor(shape: CometShape, solidFraction: number, tipFloor: number) {
    const material = mediaMaterial({
      steps: COMET_MEDIA.steps,
      octaves: COMET_MEDIA.octaves,
      // The uniform block goes in the prelude because both halves read it,
      // and GLSL ES has no forward declarations — the same ordering
      // requirement `render/shaders/noise.ts`'s own header records.
      prelude: UNIFORMS,
      bounds: BOUNDS,
      density: DENSITY,
      uniforms: {
        uNucleus: { value: new Vector3() },
        uAxis: { value: new Vector3(0, 0, 1) },
        uRight: { value: new Vector3(1, 0, 0) },
        uLength: { value: shape.length },
        uR0: { value: shape.nearRadius },
        uR1: { value: shape.farRadius },
        uComaR: { value: shape.nucleusRadius },
        uSolid: { value: solidFraction },
        uTipFloor: { value: tipFloor },
        uFlow: { value: 0 },
        uNoiseScale: { value: COMET_MEDIA.noiseScale },
        uStreak: { value: COMET_MEDIA.streak },
        uContrast: { value: COMET_MEDIA.contrast },
        uDustAlbedo: { value: COMET_MEDIA.dustAlbedo },
        uDustFrom: { value: COMET_MEDIA.dustFrom },
        uDustTo: { value: COMET_MEDIA.dustTo },
        uGasColor: { value: COMET_GAS.clone() },
        uDustColor: { value: COMET_DUST.clone() },
        uComaDensity: { value: COMET_MEDIA.comaDensity },
        uComaGlow: { value: COMET_MEDIA.comaGlow },
        uTailDensity: { value: COMET_MEDIA.tailDensity },
        uSigma: { value: COMET_MEDIA.sigma },
        uGain: { value: COMET_MEDIA.gain },
        uAmbient: { value: COMET_MEDIA.ambient },
        uAmbientColor: { value: COMET_AMBIENT.clone() },
        uAnisotropy: { value: COMET_MEDIA.anisotropy },
        uMaxSpan: { value: COMET_MEDIA.maxSpan },
        uLightGain: { value: COMET_MEDIA.lightGain },
      },
    });

    this.volume = new MediaVolume(material);
    this.fitHull(shape);
  }

  /** The scene node to hang on whatever already tracks the nucleus. */
  get object(): Object3D {
    return this.volume.mesh;
  }

  /**
   * Size and orient the proxy hull so it covers the cone plus its coma.
   *
   * Called once per plan rather than per frame: a comet's *shape* never
   * changes, only where it stands, and that is the parent's business. The hull
   * is a unit cube under a scale — see `MediaVolume`'s own note on why nothing
   * about its transform is read except coverage.
   */
  private fitHull(shape: CometShape): void {
    const rmax = Math.max(shape.nearRadius, shape.farRadius);
    const span = shape.length + shape.nucleusRadius;
    const mesh = this.volume.mesh;
    mesh.quaternion.setFromUnitVectors(FORWARD, shape.direction);
    // Centred between the coma's own back edge and the tail's tip, in the
    // parent's frame — which is the nucleus, because that is what `Comet
    // .object` is.
    mesh.position.copy(shape.direction).multiplyScalar((shape.length - shape.nucleusRadius) / 2);
    mesh.scale.set(rmax * 2, rmax * 2, span);
  }

  /** Stream the field. Time-based; the flow is a coordinate offset, so nothing
   * here rebuilds anything. */
  update(dt: number, flowSpeed: number): void {
    this.flow += flowSpeed * dt;
    this.volume.uniform("uFlow").value = this.flow;
  }

  /**
   * Per-frame sync: where the nucleus actually is, which way its star is, and
   * what the world is currently lit by.
   *
   * The star direction is `-direction` and needs no `SectorLight`: the plan's
   * own `tailDirection` built it by pointing away from the sun, so the tail is
   * already a statement about where the light is. Nothing else in this game
   * gets its key light for free, and it is worth saying out loud that this one
   * does — a later reader looking for the missing `planLight` call should find
   * the reason rather than the omission.
   */
  sync(shape: CometShape, lights: MediaLightSource | null): void {
    const u = this.volume.uniform.bind(this.volume);
    (u("uNucleus").value as Vector3).copy(shape.nucleus);
    (u("uAxis").value as Vector3).copy(shape.direction);
    // The tail's own tangential axis, matching `Comet.draw`'s `rightX`/`rightZ`
    // construction exactly, so the noise frame and the stroke frame (where one
    // still runs) describe the same cone.
    (u("uRight").value as Vector3).set(-shape.direction.z, 0, shape.direction.x);

    this.toStar.copy(shape.direction).multiplyScalar(-1);
    this.volume.setKeyLight(this.toStar, STAR_TINT, COMET_MEDIA.keyGain);

    // Ranked against the head rather than the tail's centroid: the head is
    // where the rock is, where the coma glares, and where a fight in a comet
    // actually happens.
    this.centre.copy(shape.nucleus);
    this.volume.injectLights(lights, this.centre);
  }

  dispose(): void {
    this.volume.dispose();
  }
}

const FORWARD = new Vector3(0, 0, 1);
/**
 * The star's colour, as this medium sees it. A comet has no `SectorLight` to
 * read (see `sync`), so rather than invent a hue that could disagree with the
 * one `planLight` actually rolled for the sector, this is deliberately
 * near-neutral with the faintest warm bias — a light that says "a star" and
 * nothing more specific. The day `Comet.show` is handed a sector seed, this
 * becomes `planLight(seed, sector).colour` and the constant goes away.
 */
const STAR_TINT = new Color(1, 0.97, 0.92);
