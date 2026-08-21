import {
  AdditiveBlending,
  DoubleSide,
  FrontSide,
  Group,
  Matrix4,
  Mesh,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import { makeRng } from "../chart/rng.js";
import { planLight, type SectorLight } from "./light.js";
import { celestialLadderAfterFlow, LIMB_FRAGMENT, LIMB_VERTEX } from "./shaders/celestial.js";
import { flowLadder } from "./shaders/noise.js";
import type { ShapeMode } from "./VectorObject.js";

/**
 * The ringed planet, as an actual object in the world rather than a picture of
 * one on the sky.
 *
 * It has been through three vocabularies now and this is the fourth. As a flat
 * disc on the camera-pinned backdrop it read as a diagram; rebuilt at limb scale
 * it lost its rings entirely. Test play named the real problem: it "just looks fake,
 * as it's plastered there and doesn't really change". Both attempts shared one
 * cause — `Backdrop` deliberately never translates, so no amount of drawing skill
 * could make a body shift against its neighbours, and *shifting* is what tells
 * an eye that something is a solid object at a distance rather than paint.
 *
 * So this one is not on the backdrop at all. It is a sphere and a ring in world
 * space, at a fixed point in the sector, and everything about how it looks falls
 * out of where the camera happens to be. Fly across the sector and its bearing
 * changes, its rings open and close, the far half of the ring passes behind it.
 * None of that is animated; it is just true.
 *
 * **The camera's far plane is the whole design constraint.** It is 2000 units
 * (`Stage`), so a planet has to live inside that, and a run covers many thousands
 * of units — which means a real object at a real distance would be something you
 * fly past and eventually into. Two answers, and the second is the one taken:
 *
 *  - Raise the far plane and add a logarithmic depth buffer. Correct, and not
 *    worth introducing blind into a renderer whose every line is a fat-line
 *    shader.
 *  - Leash it. The planet sits at a real point and behaves like a real object
 *    right up until you get closer than `minRange`, at which point it holds that
 *    distance. Approaching one for half a minute makes it visibly larger, which is
 *    the payoff; it just never lets you arrive. That is a lie, and a smaller one
 *    than a sky that never moves at all.
 *
 * ---
 *
 * ## The fourth vocabulary: strokes out, shadows in
 *
 * Everything above survives unchanged. What changed is the *medium* and, with
 * it, the one thing this body exists to be.
 *
 * The previous build drew the sphere through `VectorObject` — glowing edges over
 * near-void faces — and the ring as concentric additive `LineSegments`, and its
 * own comment defended that as "the locked decision every hull already obeys."
 * `docs/environment.md` §1.5 voided exactly that reasoning while this file was
 * still standing on it: "occluded geometry, not pure wireframe" is justified in
 * its own sentence by *ships overlapping in combat*, and a planet does not
 * overlap a planet. §1.5 was written after the hero gas giant went three rounds
 * as strokes and never became a planet; only a filled, lit mesh did, immediately.
 * This file is the last body in the project that had not caught up.
 *
 * **And the medium was not a matter of taste here — it was blocking the image.**
 * The one picture that says "an enormous object in real sunlight" faster than
 * any amount of surface detail is Cassini's: **the ring's shadow lying across the
 * planet's cloud tops, and the planet's shadow cut out of the rings.** Both are a
 * question of *how much of the star is blocked at this point*, and additive
 * strokes cannot answer it — additive blending has no way to make something
 * darker, so a shadow is not merely hard in that vocabulary, it is unrepresentable.
 * Two filled, shaded meshes make both shadows a handful of dot products
 * (`render/shaders/celestial.ts`'s `ringShadow`/`sphereShadow`), computed
 * analytically against the *same* ring density function the ring itself is drawn
 * with — which is the property that keeps the Cassini division visible in the
 * shadow as well as in the ring, and the tell that separates a cast shadow from a
 * painted one.
 *
 * What survives from the stroke build, deliberately: the leash, the seeded
 * bearing and tilt, the ring's own gaps (now procedural rather than a skipped
 * strand), and the "tested but not written" depth trick the ring always used —
 * the body writes depth and occludes the far half of the ring, which is still
 * the entire reason this is real geometry.
 *
 * **The sector's `SectorLight` is fetched here rather than passed in.**
 * `render/GasGiant.ts` takes it as an argument because `main.ts` had already
 * computed it for the scene's own `DirectionalLight`; this file is called with
 * `(seed, sector)` alone and `planLight` is pure and deterministic in exactly
 * those two, so calling it is not a second source of truth — it is the same
 * source, asked twice, once per sector change. Threading it through `main.ts`'s
 * call would be tidier and is a one-line change in a file this task may not
 * touch; nothing about the result differs either way.
 */
export const PLANET = {
  /**
   * Where it sits, in units. Well inside the 2000 far plane with room for the
   * ring's outer edge, and far enough that the leash rarely engages.
   */
  range: 1700,
  /**
   * How close the player may get before it starts holding station.
   *
   * 520, not 1150. The first figure left barely five hundred units of genuine
   * approach before the leash took over, so almost all of the payoff — a planet
   * that visibly grows because you flew at it — was clamped away. At 520 the body
   * closes to about twenty degrees across and its rings span more than the frame,
   * and every bit of that is real perspective rather than a tween.
   */
  minRange: 520,
  /** World radius of the body. About seven degrees across at `range`. */
  radius: 190,
  /** Ring extent, as multiples of the body's radius. */
  ringInner: 1.42,
  ringOuter: 2.25,
  /**
   * Latitude/longitude divisions on the body.
   *
   * Raised from the stroke build's 26×16 — that count was sized by "this is a
   * stroke renderer", where every extra division is another *drawn line*, and
   * the trade ran the other way entirely. On a filled mesh whose whole pattern
   * is computed per fragment, tessellation buys exactly two things: a round
   * silhouette and a smooth normal for the limb shell's grazing-angle term.
   * Both want more than 26 at a body that can close to twenty degrees across,
   * and neither costs anything on the fill-bound axis this game actually pays
   * on (`docs/environment.md` §1: "fill rate, not geometry").
   */
  segments: 72,
  rings: 44,
  /**
   * Divisions around and across the ring annulus.
   *
   * `thetaSegments` is what keeps the ring's *circle* from reading as a
   * polygon, and it is the only count here that has to be generous: at a
   * ring that can span more than the frame, 96 segments put a visible corner
   * every few degrees along the outer edge. `phiSegments` is nearly free to
   * keep small for the opposite reason — the radial direction carries no
   * silhouette at all, and every bit of the ring's structure (the Cassini
   * division included) is computed per fragment from the true radius rather
   * than interpolated between rings of vertices.
   */
  ringSegments: 256,
  ringBands: 6,
  /**
   * How high above the plane it sits, in units. Positive so it clears the grid
   * rather than sitting behind it, and modest so it is not overhead — the cameras
   * pitch down and cannot look up, which this file is the fourth thing to learn.
   */
  height: 210,

  // ── the two shadows ───────────────────────────────────────────────────────

  /**
   * Penumbra width of the planet's shadow on its rings, as a fraction of the
   * body's radius.
   *
   * A hard-edged bite out of the ring reads as a rendering artefact rather
   * than as a shadow — the eye has no reference for an umbra with no penumbra
   * — and the *true* penumbra here is a few pixels wide, because
   * `render/light.ts` puts the star 20000 units out where its angular size is
   * negligible. So this is an honest exaggeration and is labelled as one: it
   * buys the read at the cost of a physically wrong softness, the same trade
   * `GIANT.ambientFloor` makes for the terminator.
   */
  shadowSoft: 0.06,
  /**
   * How brightly the sunlit rings bounce light back onto the planet's night
   * side, 0-1.
   *
   * "Ringshine" is real and it is the reason Saturn's dark hemisphere is not
   * black in any photograph of it — the rings are an enormous reflector
   * hanging over the night side. It matters here for a reason beyond accuracy:
   * this shader's night hemisphere is otherwise carried by `ambientFloor`
   * alone, a flat lift with no shape to it, and ringshine is *shaped* — it
   * falls off toward the equator, where the rings are edge-on and reflect
   * nothing, and it appears only on the hemisphere the lit ring face is
   * pointing at. A night side with structure is worth more than a night side
   * that is merely visible.
   */
  ringshine: 0.22,

  // ── the surface ───────────────────────────────────────────────────────────

  /** Radians per second the cloud pattern advances. Slower than the giant's:
   * this is a smaller, calmer body in the frame and matching the giant's rate
   * would make the two read as the same object twice. */
  rotationRate: 0.022,
  /** The polar rate as a fraction of the equator's — the same differential
   * mechanism `GasGiant.ts` documents at length, at a gentler setting. A ringed
   * body's bands are its second-most-looked-at feature; the rings are the
   * first, and a surface that churns as hard as the giant's would compete with
   * them. */
  diffPole: 0.82,
  /** Frequency and amplitude of the latitude shear that produces the bands.
   * Fewer, wider bands than the giant's `jetFreqMin`/`Max` — Saturn's belts are
   * famously softer-edged than Jupiter's, and a second body with the same band
   * count at a different colour is the "same actor in different makeup"
   * failure `render/scenery.ts` exists to avoid. */
  jetFreq: 3.4,
  shearAmp: 0.6,
  /** The flow field's own scale, latitude stretch and warp. Same mechanism as
   * the giant's; a lower warp because this body wants smooth belts rather than
   * festoons. */
  flowScale: 2.0,
  latStretch: 7.0,
  warpStrength: 0.75,
  flowContrast: 1.45,

  /** Hue roll for the body, degrees — the pale gold band the stroke build
   * already used (24-50), kept because it was never the problem. */
  hueMin: 24,
  hueMax: 50,
  /** Four stops the flow value is ramped across, offsets from the rolled hue.
   * The same lightness-spans-wide, saturation-contrasts shape
   * `GasGiant.assertPaletteContract` enforces one file over, at four stops
   * rather than six: this body is smaller in the frame and a six-stop ramp
   * would put detail into it that the screen size cannot keep. */
  brightHueOffset: 8,
  brightSaturation: 0.14,
  brightLightness: 0.88,
  zoneHueOffset: 4,
  zoneSaturation: 0.22,
  zoneLightness: 0.72,
  beltHueOffset: -6,
  beltSaturation: 0.34,
  beltLightness: 0.54,
  deepHueOffset: -12,
  deepSaturation: 0.32,
  deepLightness: 0.35,
  /** The polar cap: cool, near-neutral, against the warm bands — the same
   * complementary-contrast argument `GIANT.poleHue` makes, and the same
   * flowPoint-degrades-at-the-pole problem it hides. */
  poleThreshold: 0.78,
  poleBlendWidth: 0.14,
  poleHue: 205,
  poleSaturation: 0.1,
  poleLightness: 0.44,

  /**
   * Lambertian floor and the view-angle limb darkening, both the same trade
   * `GIANT.ambientFloor`/`limbDarkFloor` record — with one extra claimant here
   * that the giant does not have.
   *
   * 0.20 rather than the giant's 0.32, because on this body the floor is what
   * sets a hard ceiling on how dark the ring's shadow can ever be: a shadowed
   * point still receives the floor, so a high floor makes an eclipse into a
   * dimming. Measured, dropping 0.26 → 0.20 took the deepest point of the ring
   * shadow from 28% darker to 42% darker while costing almost nothing on the
   * night side, because this body has `ringshine` to carry the dark hemisphere
   * and the giant has nothing but the floor.
   */
  ambientFloor: 0.2,
  limbDarkFloor: 0.4,
  limbDarkPower: 1.5,

  /** Terminator scattering — see `GIANT.terminatorGlow`. Weaker here: an icy
   * ringed body has a thinner atmosphere than a gas giant and a full-strength
   * sunset on it would look borrowed. */
  terminatorGlow: 0.4,
  terminatorWidth: 0.26,
  sunsetR: 1.0,
  sunsetG: 0.58,
  sunsetB: 0.34,

  // ── the ring's own look ───────────────────────────────────────────────────

  /**
   * Peak optical depth of the ring — what `ringProfile`'s 0-1 output is
   * multiplied by before it becomes either opacity (in the ring's own shader)
   * or blocked starlight (in `ringShadow`). One number for both, which is what
   * keeps the Cassini division a hole in the shadow as well as in the ring.
   *
   * 1.6, raised from a first draft of 0.82 on a measurement rather than a
   * feeling. At 0.82 the deepest point of the ring's shadow removed only 28% of
   * the surface's brightness — visible in a pixel diff, easy to miss by eye,
   * which is exactly the failure this whole rebuild exists to avoid. The
   * profile is a *product* of two noise terms and so spends most of its range
   * well under its own peak, and the shadow is Beer's law over that, so the
   * curve from τ to darkness is shallow: 0.82 → 1.4 → 2.2 → 3.0 measured 28%,
   * 35%, 39%, 41% at the deepest point. 1.6 sits at the knee, and it is also
   * the more honest number — Saturn's B ring runs τ ≈ 1-3 and is genuinely
   * opaque, while the A and C rings are translucent, and a peak of 1.6 over a
   * varying profile reproduces that split instead of making the whole annulus
   * uniformly see-through.
   */
  ringDepth: 1.6,
  /** Brightness of light scattered back toward a viewer on the sunlit side —
   * the ordinary "the rings are lit" term. */
  ringBackscatter: 0.85,
  /** Gain on the ring's forward-scattering lobe, and its asymmetry. This is
   * why a backlit ring system glows: ice grains throw light forward far more
   * strongly than back, so the *unlit* face of the rings is brighter than the
   * lit one wherever the ring is thin. It is the single most striking thing
   * Cassini photographed and it costs one `henyeyGreenstein` call. */
  ringForward: 0.55,
  ringAsymmetry: 0.62,
  /** The ice's own colour, inner and outer. Inner ringlets are dirtier and
   * warmer, outer ones cleaner and colder; the gradient is subtle and it is
   * what stops the ring reading as one flat grey band. */
  ringInnerR: 0.86,
  ringInnerG: 0.74,
  ringInnerB: 0.58,
  ringOuterR: 0.82,
  ringOuterG: 0.86,
  ringOuterB: 0.95,

  // ── the atmosphere shell ──────────────────────────────────────────────────

  limbScale: 1.025,
  limbPower: 2.8,
  limbIntensity: 1.15,
  limbForward: 0.45,
  limbAsymmetry: 0.74,
  limbSunsetWidth: 0.38,
  limbDayR: 0.66,
  limbDayG: 0.8,
  limbDayB: 1.0,
} as const;

/** One turn, for the phase wrap in `update`. */
const TAU = Math.PI * 2;

/**
 * One planet, per sector, from the seed.
 *
 * Not every sector gets one — `render/scenery.ts`'s `planHero` decides that
 * now. The placement is a bearing rather than a coordinate, so the planet is
 * always the same distance out whichever way the sector is entered.
 */
interface PlanetPlan {
  bearing: number;
  /** Radians the ring plane is tilted from the ecliptic. Never near zero. */
  tilt: number;
  scale: number;
  /** Hue anchor in degrees. Was a `Color`; it is a number now because the
   * shader ramps six stops off it rather than tinting one stroke colour. */
  hue: number;
  /** Shifts every noise slice in `ringProfile`, so two sectors' rings are not
   * the same ring at a different tilt. */
  ringSeed: number;
  /** Starting cloud longitude, so the same sector does not always present the
   * same face — the same job `GasGiant`'s own `rotation0` does. */
  rotation0: number;
}

function planPlanet(seed: number, sector: number): PlanetPlan {
  // A different mix from the backdrop's, so a sector's sky and its planet are not
  // correlated — the same square should not always pair the same two things.
  const rng = makeRng((seed * 2654435761 + sector * 40503 + 977) >>> 0);
  // The allocator (`render/scenery.ts`'s `planHero`) decides whether this sector
  // gets a ringed planet at all now, not this roll — but the draw stays, discarded,
  // so every value below it is unchanged for every sector that used to pass the
  // old `> 0.38` cutoff. Deleting the roll without keeping its draw would shift
  // bearing/tilt/scale/hue for every one of them.
  rng.next();

  const hue = PLANET.hueMin + rng.next() * (PLANET.hueMax - PLANET.hueMin);
  return {
    bearing: rng.next() * Math.PI * 2,
    // Kept clear of edge-on: a ring seen exactly side-on is a line, and a player
    // who happens to arrive at that bearing would see a planet with no rings.
    // It matters twice over now — the ring's shadow on the body collapses to a
    // line at zero tilt too, so this bound protects the headline image as well
    // as the ring itself.
    tilt: (0.28 + rng.next() * 0.5) * (rng.next() < 0.5 ? -1 : 1),
    // Promoted from furniture to hero: the frame's owner, so it reads as the
    // thing the sector is about rather than something passed on the way to it.
    // First-draft constant, tuning list like all the rest.
    scale: 1.5 + rng.next() * 0.7,
    hue,
    ringSeed: rng.next() * 97,
    rotation0: rng.next() * TAU,
  };
}

/**
 * The body's vertex stage. `vObjectPos` is the one addition over
 * `GasGiant.ts`'s otherwise identical stage, and it is what the ring shadow
 * needs: `ringShadow` traces a ray from an actual *point* on the surface
 * toward the star, which a normal alone cannot supply. Passing the untransformed
 * `position` keeps that point in the body's own object space — where the body
 * centre is the origin and the ring plane passes through it — which is the
 * space both shadow functions are written in.
 *
 * That the body mesh carries no rotation of its own is load-bearing here: it
 * makes object space and world space differ by a translation only, so a light
 * *direction* is the same vector in both and `uLightDirWorld` can be used
 * directly. The clouds advance through `uRotation` in the fragment stage
 * instead, the same mechanism and for the same reason `GasGiant.update`
 * records — and keeping the mesh still is now a second requirement rather than
 * an optimisation.
 */
const BODY_VERTEX = /* glsl */ `
uniform vec3 uLightDirWorld;
varying vec3 vObjectNormal;
varying vec3 vObjectPos;
varying vec3 vViewNormal;
varying vec3 vViewDir;
varying vec3 vLightDirView;
void main() {
  vObjectNormal = normal;
  vObjectPos = position;
  vViewNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewDir = normalize(-mvPosition.xyz);
  vLightDirView = normalize((viewMatrix * vec4(uLightDirWorld, 0.0)).xyz);
  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * The body's fragment stage.
 *
 * The banding half is `GasGiant.ts`'s technique at this body's own settings —
 * domain-warped flow noise sheared by latitude, ramped across colour stops —
 * and the argument for why that beats a band lookup lives there rather than
 * being restated here. Four stops instead of six, a gentler warp, and a
 * gentler differential rate, all for the reason `PLANET`'s own constants
 * record: this body's job in the frame is to hold up the rings, and a surface
 * that churns as hard as the giant's would fight them for the eye.
 *
 * The half that is *this* file's is the shadow, and it is four lines. A ring
 * shadow is not a decal and not a projected texture — it is the answer to "is
 * anything between this square metre of cloud and the star", asked per
 * fragment, and because the occluder is a flat annulus the answer is one plane
 * intersection. That it reads the *same* `ringProfile` the ring's own shader
 * reads is what puts the Cassini division into the shadow, and a division
 * visible in the ring but not in its shadow is exactly how an eye catches a
 * fake.
 */
const BODY_FRAGMENT = /* glsl */ `
uniform float uHue;
uniform float uRotation;
uniform float uFlowScale;
uniform float uLatStretch;
uniform float uWarpStrength;
uniform float uFlowContrast;
uniform float uJetFreq;
uniform float uJetPhase;
uniform float uShearAmp;
uniform float uDiffPole;
uniform float uBrightHue;
uniform float uBrightSaturation;
uniform float uBrightLightness;
uniform float uZoneHue;
uniform float uZoneSaturation;
uniform float uZoneLightness;
uniform float uBeltHue;
uniform float uBeltSaturation;
uniform float uBeltLightness;
uniform float uDeepHue;
uniform float uDeepSaturation;
uniform float uDeepLightness;
uniform float uPoleThreshold;
uniform float uPoleBlendWidth;
uniform float uPoleHue;
uniform float uPoleSaturation;
uniform float uPoleLightness;
uniform vec3 uLightColor;
uniform float uAmbientFloor;
uniform float uLimbDarkFloor;
uniform float uLimbDarkPower;
uniform float uTerminatorGlow;
uniform float uTerminatorWidth;
uniform vec3 uSunsetColor;
uniform float uLimbAsymmetry;
uniform vec3 uLightDirWorld;
uniform vec3 uRingNormal;
uniform float uRingInnerR;
uniform float uRingOuterR;
uniform float uRingSeed;
uniform float uRingDepth;
uniform float uRingshine;

varying vec3 vObjectNormal;
varying vec3 vObjectPos;
varying vec3 vViewNormal;
varying vec3 vViewDir;
varying vec3 vLightDirView;

${flowLadder(3)}
${celestialLadderAfterFlow()}

vec3 flowPoint(float lon, float lat) {
  return vec3(cos(lon), lat * uLatStretch, sin(lon)) * uFlowScale;
}

void main() {
  vec3 n = normalize(vObjectNormal);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  // +1e-6, for the reason GasGiant's own copy of this line gives: GLSL's
  // two-arg atan is undefined at (0, 0), which is exactly what an interpolated
  // normal rounds to at a pole, and a NaN there would propagate through the
  // whole flow field.
  float lon0 = atan(n.x, n.z + 1e-6);
  float absLat = abs(clamp(lat / 1.5707963, -0.9999, 0.9999));

  float jet = sin(lat * uJetFreq + uJetPhase);
  float cl = cos(lat);
  float lon = lon0 + uRotation * mix(uDiffPole, 1.0, cl * cl);
  vec3 p = flowPoint(lon + jet * uShearAmp, lat);
  float f = flow(p, uWarpStrength);

  float t = clamp(f * uFlowContrast * 0.5 + 0.5, 0.0, 1.0);
  vec3 stopBright = hsl2rgb(hueFrac(uHue + uBrightHue), uBrightSaturation, uBrightLightness);
  vec3 stopZone = hsl2rgb(hueFrac(uHue + uZoneHue), uZoneSaturation, uZoneLightness);
  vec3 stopBelt = hsl2rgb(hueFrac(uHue + uBeltHue), uBeltSaturation, uBeltLightness);
  vec3 stopDeep = hsl2rgb(hueFrac(uHue + uDeepHue), uDeepSaturation, uDeepLightness);
  vec3 albedo;
  if (t < 0.34) albedo = mix(stopBright, stopZone, smoothstepc(0.0, 0.34, t));
  else if (t < 0.67) albedo = mix(stopZone, stopBelt, smoothstepc(0.34, 0.67, t));
  else albedo = mix(stopBelt, stopDeep, smoothstepc(0.67, 1.0, t));

  float poleT = smoothstepc(uPoleThreshold, uPoleThreshold + uPoleBlendWidth, absLat);
  if (poleT > 0.0) {
    vec3 poleColor = hsl2rgb(hueFrac(uPoleHue), uPoleSaturation, uPoleLightness + f * 0.05);
    albedo = mix(albedo, poleColor, poleT);
  }

  vec3 wn = normalize(vViewNormal);
  vec3 ld = normalize(vLightDirView);
  float ndlRaw = dot(wn, ld);
  float ndotl = max(ndlRaw, 0.0);

  // The headline. One plane intersection per fragment: trace toward the star
  // from this point on the surface and ask whether the ray crosses the ring
  // annulus on the way out. Everything that makes the result look right is
  // inherited rather than authored — the shadow's shape comes from the ring's
  // real tilt and the star's real bearing, and its *texture* comes from the
  // same ringProfile the ring's own shader is drawn with, so the Cassini
  // division appears in the shadow because it is genuinely a hole rather than
  // because anything drew it there twice.
  //
  // Multiplied into the direct term only, never into uAmbientFloor: a
  // shadowed point still receives skylight and ringshine, and a shadow that
  // takes a surface to true black is the tell of a shadow map with no ambient
  // term rather than of an eclipse.
  float shade = ringShadow(
    vObjectPos,
    normalize(uLightDirWorld),
    normalize(uRingNormal),
    uRingInnerR,
    uRingOuterR,
    uRingSeed,
    uRingDepth
  );
  float direct = ndotl * (1.0 - shade);

  // Ringshine: the sunlit face of the rings is an enormous reflector hanging
  // over one hemisphere, and this is what it puts back. Strongest where the
  // surface tips toward the lit ring face, nothing at all at the equator where
  // the rings are edge-on, and gated to the night side so it never brightens a
  // hemisphere the star is already handling.
  vec3 ringN = normalize(uRingNormal);
  float litFace = dot(normalize(uLightDirWorld), ringN) >= 0.0 ? 1.0 : -1.0;
  float facesRing = max(dot(n, ringN) * litFace, 0.0);
  float shine = facesRing * uRingshine * smoothstepc(0.25, -0.2, ndlRaw);

  float lit = uAmbientFloor + (1.0 - uAmbientFloor) * direct + shine;

  vec3 vd = normalize(vViewDir);
  float facing = max(dot(wn, vd), 0.0);
  float limbDark = mix(uLimbDarkFloor, 1.0, pow(facing, uLimbDarkPower));

  vec3 color = albedo * uLightColor * lit * limbDark;

  // Terminator scattering — see GasGiant's own copy for the argument. Damped
  // by the ring shadow as well: a sunset inside an eclipse is not a sunset.
  float mu = clamp(-dot(vd, ld), -1.0, 1.0);
  float forward = henyeyGreenstein(mu, uLimbAsymmetry);
  float band = exp(-(ndlRaw * ndlRaw) / (uTerminatorWidth * uTerminatorWidth));
  float bandWeight = band * uTerminatorGlow * (0.35 + 0.65 * (1.0 - facing)) * (1.0 - shade);
  color = mix(color, uSunsetColor * uLightColor * (0.45 + forward * 0.45), bandWeight);

  gl_FragColor = vec4(color, 1.0);
}
`;

/**
 * The ring's vertex stage.
 *
 * **Two spaces, on purpose, and each one is the cheap space for its own job.**
 * `vLocal` is the untransformed ring vertex — the ring lies in its own XY
 * plane with the body's centre at the origin, so `vLocal` is exactly the `q`
 * that `sphereShadow` wants, and the light direction is handed in already
 * rotated into that frame (`uLightDirLocal`) so the shadow test needs no
 * matrix work per fragment. The lighting terms, meanwhile, want a normal, an
 * eye vector and a light vector in one common space, and view space is the one
 * three.js hands over for free through `normalMatrix`/`modelViewMatrix`/
 * `viewMatrix`.
 *
 * Mixing the two is safe because a rotation preserves every quantity either
 * side uses — lengths, and the dot products between vectors carried through
 * the *same* transform. Doing it all in one space would mean either
 * transforming the ring's position into view space and the body's centre with
 * it (an extra uniform that moves every frame), or transforming the view
 * vector back into ring space (an extra matrix). This costs one CPU-side
 * vector per sector change instead.
 */
const RING_VERTEX = /* glsl */ `
uniform vec3 uLightDirWorld;
varying vec3 vLocal;
varying vec3 vViewNormal;
varying vec3 vViewDir;
varying vec3 vLightDirView;
void main() {
  vLocal = position;
  vViewNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewDir = normalize(-mvPosition.xyz);
  vLightDirView = normalize((viewMatrix * vec4(uLightDirWorld, 0.0)).xyz);
  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * The ring's fragment stage.
 *
 * **Alpha-blended, not additive, and that is the whole reason the ring could
 * be rebuilt at all.** The stroke build's ring was `AdditiveBlending`, which
 * can only ever make what is behind it brighter — so a ring passing in front
 * of the lit planet could not darken it, and the planet's shadow falling
 * across the ring could not be drawn, because "less added light" over black
 * space is invisible and over the planet is nothing at all. With ordinary
 * alpha blending the ring has a *colour* and an *opacity*: shadowed ring in
 * front of the planet lays a dark band across the cloud tops, shadowed ring
 * against space simply disappears, and both are correct without a special
 * case.
 *
 * Three physical terms, each doing something a flat tint cannot:
 *
 *  - **Opacity grows at grazing view.** A ring is a slab a few metres thick
 *    and a hundred thousand kilometres wide; how much of it a pixel looks
 *    through is the density divided by how square-on you are to it. This is
 *    why a ring system fades to a translucent haze when it is wide open and
 *    thickens to a hard line as it closes, and it is one `exp` of Beer's law.
 *  - **Forward scattering.** Ice throws light forward far more strongly than
 *    back, so the *unlit* face of a ring system is brighter than the lit one
 *    wherever the ring is thin — the single most striking thing Cassini
 *    photographed, and the reason `uForwardGain` exists.
 *  - **The body's shadow**, `sphereShadow`, cut out of both of the above.
 */
const RING_FRAGMENT = /* glsl */ `
uniform vec3 uLightColor;
uniform vec3 uLightDirLocal;
uniform float uInner;
uniform float uOuter;
uniform float uSeed;
uniform float uBodyRadius;
uniform float uShadowSoft;
uniform float uDepth;
uniform float uBackscatter;
uniform float uForwardGain;
uniform float uAsymmetry;
uniform vec3 uIce0;
uniform vec3 uIce1;

varying vec3 vLocal;
varying vec3 vViewNormal;
varying vec3 vViewDir;
varying vec3 vLightDirView;

${flowLadder(2)}
${celestialLadderAfterFlow()}

void main() {
  float r = length(vLocal.xy);
  float u = (r - uInner) / (uOuter - uInner);
  float tau = ringProfile(u, uSeed) * uDepth;
  // Nothing at all rather than a near-zero contribution: the divisions have to
  // be genuinely empty, and a discarded fragment also skips the blend, which
  // is most of the ring's own fill cost given how much of the annulus is gap.
  if (tau <= 0.001) discard;

  vec3 n = normalize(vViewNormal);
  vec3 v = normalize(vViewDir);
  vec3 l = normalize(vLightDirView);

  // abs() throughout: the ring is a two-sided slab with no meaningful "up",
  // and DoubleSide hands this shader a flipped normal on the far face. Every
  // term below is symmetric in that flip except the forward-scattering lobe,
  // which is a function of the light and view directions alone and does not
  // involve the normal at all.
  float squareOn = max(abs(dot(n, v)), 0.12);
  // Beer's law along the line of sight. The 0.12 floor above is what stops a
  // perfectly edge-on ring dividing by zero and flashing to opaque white
  // across a single frame as the aspect passes through it.
  float alpha = 1.0 - exp(-tau / squareOn);

  float onFace = abs(dot(n, l));
  float mu = clamp(-dot(v, l), -1.0, 1.0);
  float forward = henyeyGreenstein(mu, uAsymmetry) * uForwardGain;

  float shade = sphereShadow(vLocal, normalize(uLightDirLocal), uBodyRadius, uShadowSoft);
  float brightness = onFace * (uBackscatter + forward) * (1.0 - shade);

  // Dirty and warm at the inner edge, clean and cold at the outer — a subtle
  // gradient, and the thing that stops the annulus reading as one flat band.
  vec3 ice = mix(uIce0, uIce1, clamp(u, 0.0, 1.0));
  vec3 color = ice * uLightColor * brightness;

  gl_FragColor = vec4(color, alpha);
}
`;

export class Planet {
  readonly object = Object.assign(new Group(), { name: "planet" });

  private key = "";
  private plan: PlanetPlan | null = null;
  /** The lit body. Public for the same reason `GasGiant.body` is: a harness
   * reading a mesh and its uniforms directly beats an indirection invented
   * only to be testable. */
  body: Mesh | null = null;
  /** The ring annulus. */
  ring: Mesh | null = null;
  /** The atmosphere shell. */
  limb: Mesh | null = null;
  /** Where it would be if nothing were leashing it. */
  private readonly anchor = new Vector3();

  /** Rebuild for a sector, if it is not already the one standing. */
  show(seed: number, sector: number, star?: SectorLight): void {
    const key = `${seed}:${sector}`;
    if (key === this.key) return;
    this.key = key;
    this.clear();
    const plan = planPlanet(seed, sector);
    this.plan = plan;

    /**
     * Taken if given, computed if not.
     *
     * This file used to always fetch its own, on the sound-looking argument
     * that `planLight` is pure in `(seed, sector)` so the answer cannot differ
     * from the one `main.ts` already holds. True, and still beside the point:
     * `render/light.ts`'s own header says the light is a property of the
     * *sector*, one physical thing a second lit body picks up rather than
     * carrying its own — and `GasGiant`, `Moon` and `SunHero` are all handed
     * it. Being the one body that reaches for its own made this the one body
     * `SkyBodies` has to overwrite after the fact, which is exactly the shape
     * that goes stale when a fourth material appears.
     *
     * Optional rather than required so the sky's own instance, which has a
     * different light to give, keeps working unchanged.
     */
    const light: SectorLight = star ?? planLight(seed, sector);
    // `sun.target` in `main.ts` is always the origin, so a directional light's
    // illumination direction is its position alone, normalised.
    const lightDir = light.position.clone().normalize();

    const radius = PLANET.radius * plan.scale;
    const innerR = radius * PLANET.ringInner;
    const outerR = radius * PLANET.ringOuter;

    // The ring plane's own rotation, and the two derived quantities the
    // shaders need from it. Computed once here rather than per frame: nothing
    // in this body rotates in world space (the clouds advance in the shader
    // instead), so neither the plane's normal nor the light's direction in the
    // ring's frame ever changes for the life of the sector.
    const tilted = new Matrix4().makeRotationX(Math.PI / 2 - plan.tilt);
    const ringNormal = new Vector3(0, 0, 1).applyMatrix4(tilted).normalize();
    // The inverse rotation, for carrying the world light direction into the
    // ring's own local frame. A pure rotation's inverse is its transpose,
    // which is what `Matrix4.invert` reduces to here — written as an explicit
    // invert rather than a hand-rolled transpose because the saving is
    // nothing and the second form is a footgun the day the matrix stops
    // being a pure rotation.
    const lightDirLocal = lightDir.clone().applyMatrix4(new Matrix4().copy(tilted).invert()).normalize();

    // ── the body ────────────────────────────────────────────────────────────
    this.body = new Mesh(
      new SphereGeometry(radius, PLANET.segments, PLANET.rings),
      new ShaderMaterial({
        uniforms: {
          uHue: { value: plan.hue },
          uRotation: { value: plan.rotation0 },
          uFlowScale: { value: PLANET.flowScale },
          uLatStretch: { value: PLANET.latStretch },
          uWarpStrength: { value: PLANET.warpStrength },
          uFlowContrast: { value: PLANET.flowContrast },
          uJetFreq: { value: PLANET.jetFreq },
          uJetPhase: { value: plan.rotation0 * 0.5 },
          uShearAmp: { value: PLANET.shearAmp },
          uDiffPole: { value: PLANET.diffPole },
          uBrightHue: { value: PLANET.brightHueOffset },
          uBrightSaturation: { value: PLANET.brightSaturation },
          uBrightLightness: { value: PLANET.brightLightness },
          uZoneHue: { value: PLANET.zoneHueOffset },
          uZoneSaturation: { value: PLANET.zoneSaturation },
          uZoneLightness: { value: PLANET.zoneLightness },
          uBeltHue: { value: PLANET.beltHueOffset },
          uBeltSaturation: { value: PLANET.beltSaturation },
          uBeltLightness: { value: PLANET.beltLightness },
          uDeepHue: { value: PLANET.deepHueOffset },
          uDeepSaturation: { value: PLANET.deepSaturation },
          uDeepLightness: { value: PLANET.deepLightness },
          uPoleThreshold: { value: PLANET.poleThreshold },
          uPoleBlendWidth: { value: PLANET.poleBlendWidth },
          uPoleHue: { value: PLANET.poleHue },
          uPoleSaturation: { value: PLANET.poleSaturation },
          uPoleLightness: { value: PLANET.poleLightness },
          uLightColor: { value: light.colour.clone() },
          uAmbientFloor: { value: PLANET.ambientFloor },
          uLimbDarkFloor: { value: PLANET.limbDarkFloor },
          uLimbDarkPower: { value: PLANET.limbDarkPower },
          uTerminatorGlow: { value: PLANET.terminatorGlow },
          uTerminatorWidth: { value: PLANET.terminatorWidth },
          uSunsetColor: { value: new Vector3(PLANET.sunsetR, PLANET.sunsetG, PLANET.sunsetB) },
          uLimbAsymmetry: { value: PLANET.limbAsymmetry },
          uLightDirWorld: { value: lightDir },
          uRingNormal: { value: ringNormal },
          uRingInnerR: { value: innerR },
          uRingOuterR: { value: outerR },
          uRingSeed: { value: plan.ringSeed },
          uRingDepth: { value: PLANET.ringDepth },
          uRingshine: { value: PLANET.ringshine },
        },
        vertexShader: BODY_VERTEX,
        fragmentShader: BODY_FRAGMENT,
        side: FrontSide,
        // Past `Stage`'s 260-unit fog far plane, like every other hero body —
        // and a hand-written shader gets no automatic fog unless it opts in,
        // so this property is doing both jobs at once. `VectorObject`'s header
        // records the same trap.
        fog: false,
      }),
    );
    // Before the camera-pinned sky in draw order, so the sky's own bodies — which
    // are nearer, at 620 — depth-test against the depth this writes and correctly
    // draw over it. Ships and the grid are nearer still and do the same.
    this.body.renderOrder = -1.97;
    this.object.add(this.body);

    // ── the atmosphere shell ────────────────────────────────────────────────
    this.limb = new Mesh(
      new SphereGeometry(radius * PLANET.limbScale, Math.max(24, PLANET.segments / 2), Math.max(16, PLANET.rings / 2)),
      new ShaderMaterial({
        uniforms: {
          uGlowColor: { value: new Vector3(PLANET.limbDayR, PLANET.limbDayG, PLANET.limbDayB) },
          uSunsetColor: { value: new Vector3(PLANET.sunsetR, PLANET.sunsetG, PLANET.sunsetB) },
          uLightColor: { value: light.colour.clone() },
          uLightDirWorld: { value: lightDir },
          uPower: { value: PLANET.limbPower },
          uIntensity: { value: PLANET.limbIntensity },
          uForward: { value: PLANET.limbForward },
          uAsymmetry: { value: PLANET.limbAsymmetry },
          uSunsetWidth: { value: PLANET.limbSunsetWidth },
        },
        vertexShader: LIMB_VERTEX,
        fragmentShader: LIMB_FRAGMENT,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        // Tested and load-bearing, the same way `GasGiant`'s is: without it the
        // shell draws its whole disc instead of only the sliver past the body's
        // silhouette that depth-testing against the body produces.
        depthTest: true,
        side: FrontSide,
        fog: false,
      }),
    );
    this.limb.renderOrder = -1.965;
    this.object.add(this.limb);

    // ── the ring ────────────────────────────────────────────────────────────
    const ringGeometry = new RingGeometry(innerR, outerR, PLANET.ringSegments, PLANET.ringBands);
    this.ring = new Mesh(
      ringGeometry,
      new ShaderMaterial({
        uniforms: {
          uLightColor: { value: light.colour.clone() },
          uLightDirWorld: { value: lightDir },
          uLightDirLocal: { value: lightDirLocal },
          uInner: { value: innerR },
          uOuter: { value: outerR },
          uSeed: { value: plan.ringSeed },
          uBodyRadius: { value: radius },
          uShadowSoft: { value: PLANET.shadowSoft },
          uDepth: { value: PLANET.ringDepth },
          uBackscatter: { value: PLANET.ringBackscatter },
          uForwardGain: { value: PLANET.ringForward },
          uAsymmetry: { value: PLANET.ringAsymmetry },
          uIce0: { value: new Vector3(PLANET.ringInnerR, PLANET.ringInnerG, PLANET.ringInnerB) },
          uIce1: { value: new Vector3(PLANET.ringOuterR, PLANET.ringOuterG, PLANET.ringOuterB) },
        },
        vertexShader: RING_VERTEX,
        fragmentShader: RING_FRAGMENT,
        transparent: true,
        // Ordinary alpha blending, not additive — see `RING_FRAGMENT`'s own
        // header. This is the property the whole rebuild turns on.
        side: DoubleSide,
        // Tested but not written: the body writes depth and occludes the far half of
        // the ring, which is the entire reason this is real geometry. The ring
        // occluding itself would only produce seams.
        depthTest: true,
        depthWrite: false,
        fog: false,
      }),
    );
    this.ring.rotation.x = Math.PI / 2 - plan.tilt;
    // After the body, so alpha blending has the body's own pixels to composite
    // over. This is not a tie-break: a ring in front of the planet is *meant*
    // to darken it where it is dense and shadowed, and that only happens if
    // the body is already there when the ring draws.
    this.ring.renderOrder = -1.96;
    this.object.add(this.ring);

    this.anchor.set(Math.sin(plan.bearing) * PLANET.range, PLANET.height, Math.cos(plan.bearing) * PLANET.range);
    this.object.position.copy(this.anchor);
  }

  /**
   * Hold station if the player has come too close, and otherwise stand still.
   *
   * The leash is the one dishonest thing here and it is bounded: outside
   * `minRange` this does nothing at all, so every bit of parallax, every change of
   * ring aspect and every change of apparent size on the way in is real. It only
   * engages at the point where the alternative is flying through a planet.
   */
  follow(player: Vector3): void {
    if (!this.plan) return;
    const dx = this.anchor.x - player.x;
    const dz = this.anchor.z - player.z;
    const flat = Math.hypot(dx, dz);
    if (flat >= PLANET.minRange || flat < 1e-3) {
      this.object.position.copy(this.anchor);
      return;
    }
    const push = PLANET.minRange / flat;
    this.object.position.set(
      player.x + dx * push,
      PLANET.height,
      player.z + dz * push,
    );
  }

  /**
   * Advance the cloud pattern. Same mechanism as `GasGiant.update` — the mesh
   * never turns, the sample coordinate does — and here that is a *requirement*
   * rather than a preference: `BODY_VERTEX` hands the fragment stage an
   * object-space surface point and `BODY_FRAGMENT` traces the ring shadow from
   * it using a world-space light direction, which is only the same vector in
   * both spaces while the mesh carries no rotation of its own.
   *
   * **`main.ts` does not call this yet.** It calls `show`/`follow` and nothing
   * else, and that file is out of scope for the task this method arrived with;
   * uncalled, the planet is simply static, which costs the cloud drift and
   * costs the shadows nothing at all — they are a function of the light and
   * the tilt, neither of which moves. One line beside `planet.follow(...)`
   * turns it on.
   */
  update(dt: number): void {
    if (!this.body) return;
    const material = this.body.material as ShaderMaterial;
    material.uniforms.uRotation.value += PLANET.rotationRate * dt;
  }

  /**
   * Kept for `main.ts`'s `applyShapeMode`, and deliberately a no-op.
   *
   * `G` toggles wireframe against occluded hulls, and `docs/environment.md`
   * §1.5 rules that decision governs hulls rather than celestial bodies — the
   * hero gas giant has had no wireframe mode since its own rebuild for exactly
   * this reason, and `main.ts` already carries the comment saying so. This body
   * had one only because it was made of strokes; there is nothing left for the
   * key to toggle. The method stays because deleting it would mean editing a
   * call site in a file this rebuild is not touching, and a no-op with a reason
   * attached is cheaper than a silent signature change.
   */
  setMode(_mode: ShapeMode): void {}

  /** Empty the group and forget the sector, so the next `show` rebuilds. */
  hide(): void {
    if (this.key === "") return;
    this.key = "";
    this.clear();
  }

  private clear(): void {
    for (const mesh of [this.body, this.limb, this.ring]) {
      if (!mesh) continue;
      mesh.geometry.dispose();
      (mesh.material as ShaderMaterial).dispose();
    }
    this.body = null;
    this.limb = null;
    this.ring = null;
    this.plan = null;
    for (const child of [...this.object.children]) this.object.remove(child);
  }
}
