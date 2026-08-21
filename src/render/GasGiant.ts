import {
  AdditiveBlending,
  FrontSide,
  Group,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import { makeRng } from "../chart/rng.js";
import { STAR, type SectorLight } from "./light.js";
import { CELESTIAL_UTIL, LIMB_FRAGMENT, LIMB_VERTEX } from "./shaders/celestial.js";
import { flowLadder } from "./shaders/noise.js";

/**
 * The hero gas giant — `docs/environment.md` §1.5, the rebuild that replaced
 * the stroke version. That version went three rounds (a transparent balloon,
 * a ball of thread, a ball of straw) and never reached a planet, because it
 * applied "occluded geometry, not pure wireframe" to a domain the decision was
 * never argued for: `CLAUDE.md`'s own justification for that rule is a claim
 * about *ships in combat*, and a planet does not overlap another planet.
 * §1.5's own table is why this file looks the way it does — a solid mesh
 * closes the far-side-bleed problem the camera cull existed for, and a real
 * `DirectionalLight` closes the moving-terminator problem the whole
 * stroke-shading split existed for. Neither workaround survives; both are
 * gone from this file rather than left dormant.
 *
 * **A second rebuild, inside the same file, for a narrower reason.** The
 * first solid pass baked bands as *per-vertex colours* on this sphere and
 * lit them with `MeshStandardMaterial` — it read as a planet, but no band
 * edge was ever sharp, because a boundary interpolated across a 2.8°-tall
 * ring of triangles is a ramp by construction, and `MeshStandardMaterial`'s
 * PBR response flattened what little edge survived that ramp. No swatch
 * retune could have fixed it — the mechanism could not express a crisp band
 * no matter what colours it was handed. Banding now happens **per fragment**,
 * in `BODY_FRAGMENT` below: latitude is read from the interpolated object
 * normal (which still rotates with the mesh for free, the same free ride the
 * vertex-colour version got from baking), a band is looked up from it with a
 * controllable edge, and lighting is a hand-rolled `N·L` with a lifted floor
 * instead of a PBR response fighting for the same contrast this task exists
 * to add. `heightSegments`/`widthSegments` dropped accordingly — tessellation
 * now only has to keep the silhouette round, not carry the pattern.
 *
 * **Two meshes, not the two-mechanism split the stroke version needed.**
 * `body` is the lit, banded sphere above. `limb` is a second, slightly larger
 * sphere in the same idiom `render/Planet.ts`'s ring uses for "tested but not
 * written" depth reliance: additive, un-lit, fresnel-shaded, depth-tested
 * against `body` so it only survives past the true silhouette. That is
 * `docs/environment.md` §3.2's "bloom is the atmosphere" done as a shader
 * instead of as a scatter of radial strokes — the third and last place this
 * project drew a halo as spokes before catching that a halo is dense at the
 * edge, not radiating from it (`game/comet.ts`'s `COMA_GLOW` comment is the
 * first two).
 *
 * **A third rebuild, `body`'s fragment shader only, for the reason §3.3
 * names directly: "density, not outlines."** The per-fragment band lookup
 * above fixed the crispness problem but not the real one — four rounds of
 * swatch and boundary-wave tuning on top of it never stopped reading as
 * *stripes*, because a lookup keyed on latitude alone cannot produce
 * anything else: every pixel at a given latitude was still the same colour,
 * wobble and turbulence notwithstanding. Jupiter's belts are not stripes,
 * they are shear zones — adjacent jets moving at different rates, and all
 * the interesting shape (festoons, curls, wakes) lives at the boundary
 * between them, exactly where a boundary table has nothing to say. The band
 * index, the swatch-family table, the boundary-wave harmonics and the
 * three-octave `sin`-sum turbulence are gone; `flow` below replaces all of
 * it with domain-warped 3D value noise, sheared by latitude, with the
 * bands emerging from how that noise is *sampled* rather than being decided
 * first and decorated after. See `flowPoint`'s own comment for the one line
 * doing most of the work, and `flow`'s for the warp.
 *
 * **A fourth pass, and the first that is about *light and time* rather than
 * about surface pattern.** The three rebuilds above all argued over the same
 * question — what is painted on the sphere — and by the end of the third the
 * answer was good enough that continuing to refine it would have been the
 * mistake §8.1 records about the stroke build, one domain over: four of seven
 * rounds spent improving an approach instead of asking what the approach was
 * missing. What it was missing was everything a body does that a *texture*
 * cannot. Three things landed, each with its own constant block below:
 *
 *  - **The limb reads the light.** It was a uniform view-space fresnel — dim
 *    to bright at grazing angle, identical on the day side, the night side and
 *    the terminator. That is a real term (path length through a shell) and it
 *    is not an atmosphere: haze is *lit*, and it scatters forward, so a real
 *    limb is faint when the star is behind the camera and blinding when the
 *    star is behind the planet. `render/shaders/celestial.ts`'s `LIMB_FRAGMENT`
 *    is the replacement and carries the argument in full; the disc's own
 *    terminator now reddens to match, because the warm band at the day/night
 *    boundary is the first thing an eye looks for in a photograph of a planet.
 *  - **The bands shear.** `uRotation` used to be one number added to every
 *    longitude, which rotates the weather rigidly — a photograph on a
 *    turntable. Real jets run at different speeds by latitude, and the whole
 *    reason a gas giant looks alive is that adjacent jets *slide past each
 *    other* and tear the boundary between them differently every minute.
 *    `uDiffPole`/`uJetDrift` make the sample coordinate's advance a function of
 *    latitude, which costs one `mix` and buys a body that is never twice the
 *    same.
 *  - **The storms turn.** The vortex distortion was static: a fixed spiral
 *    that rotated with the body. `uVortexPhase` (and `uOvalPhase`, for the
 *    white oval this pass added beside the red one) advances on its own clock,
 *    so the eye of each storm turns over roughly a minute and a half — slow
 *    enough that it is never a signal, fast enough that a player who looks
 *    twice sees it has moved. `docs/environment.md` §4.1's "pulse and flash
 *    stay reserved for hostiles" is the constraint every motion constant here
 *    is sized against: continuous and slow is licensed, anything that reads as
 *    a blink is not.
 *
 * And a fourth, conditional on the first three: **aurorae**, additive rings at
 * both poles, tinted from the sector light's own colour and visible only where
 * the disc is unlit — which is the one thing that gives the night hemisphere
 * something to be rather than merely something that is dark.
 *
 * The sector's actual `DirectionalLight`/fill light are still owned by
 * `main.ts`, not this file — a light is a property of the *sector*, not of
 * one body in it (`docs/environment.md` §3.1: "every body obeys it") — but
 * `body`'s shader cannot sample scene lights the way `MeshStandardMaterial`
 * did (three.js never feeds a hand-written `ShaderMaterial` its lighting
 * uniforms unless it opts into the whole lighting chunk system, which would
 * drag the PBR response straight back in). `show` below takes the sector's
 * `SectorLight` directly and sets its direction/colour as plain uniforms, so
 * there is still exactly one place — `render/light.ts`'s `planLight` — that
 * decides where the light sits and what colour it is; this file only
 * consumes that answer, in a second form, never recomputes it.
 */
export const GIANT = {
  // ── placement and scale (§3.5) ────────────────────────────────────────────

  /** Distance from sector centre, dead ahead of spawn. Unchanged from the
   * stroke build's own tuning — `atan(radius/range)*2 ≈ 25°` against
   * `Stage.ts`'s ~88° horizontal FOV, reviewed once already as "frames the
   * ship" rather than "swallows the HUD". A rebuilt medium does not reopen a
   * framing number the medium had nothing to do with. */
  range: 950,
  /** How close the player may get before the body holds station — the same
   * bounded dishonesty `Planet.ts` names and accepts. */
  minRange: 550,
  /** World radius. */
  radius: 215,
  /** Height above the plane. 0: a body this large needs no lift to clear the
   * grid, and centring it on the horizon is what keeps the whole silhouette
   * inside a downward-pitched camera that cannot look up. */
  height: 0,
  /** Radians per second the body turns — the *equatorial* rate now that the
   * rotation is differential (see `diffPole`). First-draft, unflown, same
   * species as every other constant here — on the tuning list once there is
   * something on screen to judge it against. */
  rotationRate: 0.035,

  // ── differential rotation (the bands shear) ───────────────────────────────

  /**
   * The polar rotation rate as a fraction of `rotationRate`, the equator's.
   *
   * This one number is the difference between weather and a turntable. A
   * single `uRotation` added to every longitude moves the entire painted
   * field rigidly, so a player watching for a minute sees the same shapes
   * arrive again in the same order — which is exactly what a texture on a
   * spinning ball does and exactly what a gas giant does not. Jupiter's
   * equatorial jet laps its own mid-latitudes; the boundary between two jets
   * is therefore being continuously *torn along its length*, and that tearing
   * is the whole visual difference.
   *
   * 0.72 rather than something more dramatic because the tear has to stay a
   * tear. Push this far from 1 and adjacent latitudes decorrelate within
   * seconds: the field stops reading as bands sliding past each other and
   * starts reading as vertical smear, since `flowPoint`'s latitude stretch
   * means a small longitude offset between neighbouring rows is a *large*
   * step through the noise. The value is the point where a boundary visibly
   * evolves over a run without any single band losing its identity.
   */
  diffPole: 0.72,
  /**
   * How much each jet's own alternating direction adds to that rate, on top
   * of the smooth pole-to-equator profile above.
   *
   * The profile alone is monotonic — every band moves in the same direction,
   * just at different speeds — and monotonic shear only ever stretches a
   * boundary. Real jets *alternate*: adjacent belts run opposite ways, which
   * is what makes a boundary curl and roll rather than merely lengthen.
   * `sin(lat * jetFreq + jetPhase)` already supplies the alternation for the
   * static shear (`shearAmpMin`/`Max`); this spends the same signal on the
   * *rate*, so what was a fixed disagreement between neighbours becomes a
   * growing one.
   *
   * Held below `1 - diffPole` on purpose: larger, and a jet could run
   * backwards relative to the body, which is physically real on Jupiter but
   * reads on a 25°-wide disc as the texture coming apart.
   */
  jetDrift: 0.18,

  // ── the storms turn ───────────────────────────────────────────────────────

  /**
   * Radians per second the red storm's own interior turns, independent of the
   * body's rotation.
   *
   * A vortex that only rotates *with* the planet is a sticker with a spiral
   * printed on it — the distortion `vortexStrength` bends the sampling
   * coordinate through was fixed in the body's frame, so the storm presented
   * the same face forever. Advancing a phase into that rotation makes the eye
   * turn, and because the rotation is applied to the *coordinate* the
   * surrounding band's own texture is dragged around with it rather than
   * sliding underneath a decal.
   *
   * 0.055 rad/s is one turn in about 114 seconds — comfortably longer than a
   * glance and comfortably shorter than a run. The ceiling on this constant is
   * not aesthetic, it is `docs/environment.md` §4.1's rule that pulse and
   * flash stay reserved for hostiles: a storm turning fast enough to notice as
   * *motion* rather than as *change* would be a moving light on a body, which
   * is the one thing a body may not be.
   */
  vortexSpinRate: 0.055,

  /** The white oval — a second, much smaller vortex, in the other hemisphere
   * from the red storm. Jupiter's own white ovals are the reason to have one:
   * a single storm reads as a blemish, two at different scales read as a
   * weather system. It is built out of the same coordinate rotation the red
   * storm uses, at its own size, its own spin and its own colour, which is
   * what makes it a second instance of a mechanism rather than a second
   * mechanism. */
  ovalHalfLon: 0.17,
  ovalHalfLat: 0.075,
  /** How far from the equator the oval's centre is rolled — biased away from
   * the red storm's own `stormLatRange` band and kept clear of the polar
   * blend, so the two never overlap and neither has to fight the cap. */
  ovalLatMin: 0.34,
  ovalLatMax: 0.56,
  /** Peak coordinate rotation, smaller than the red storm's: a white oval is
   * a tighter, less violent feature and a large distortion at this size
   * would read as a hole. */
  ovalVortex: 1.6,
  /** Its own spin, faster than the red storm's because it is smaller — a
   * small vortex with a large one's angular rate looks frozen. Still an order
   * of magnitude below anything that could read as a flash. */
  ovalSpinRate: 0.11,
  /** Hue offset, saturation, lightness. Bright and *near-neutral*, which is
   * the whole character: the red storm is the disc's one saturated accent
   * (palette relationship 3) and a second saturated feature would split the
   * focal point, so this one is allowed to be the brightest thing on the body
   * and is not allowed to be the most colourful. `assertPaletteContract`
   * checks both halves of that. */
  ovalHueOffset: 6,
  ovalSaturation: 0.1,
  ovalLightness: 0.93,

  /**
   * Latitude/longitude divisions on `body`. Dropped hard from the vertex-
   * colour build's 96×64 — that count existed to keep a *baked* band edge
   * from faceting, and nothing here is baked any more: `BODY_FRAGMENT` reads
   * latitude fresh at every pixel, so a band edge is exactly as sharp at 32
   * rings as at 320. What tessellation still buys is a round silhouette and
   * a smooth normal for the limb's fresnel term, and both were already smooth
   * well below the old count.
   */
  widthSegments: 48,
  heightSegments: 32,

  // ── colour ─────────────────────────────────────────────────────────────
  // Unconstrained randomness has now produced a bad Jupiter twice — a
  // magenta roll, then a washed-out cream one — and both times the fix that
  // held was the same shape: the palette is not sampled per sector, it is
  // fixed, from a Hubble full-disc reference, and only rolled around a
  // narrow hue anchor plus band widths, turbulence detail and storm
  // placement. Lightness and saturation are the load-bearing axes and they
  // are hand-specified below, never randomised — the washed-out roll came
  // from an *averaged* pixel sample (mixing turbulent zones and belts to one
  // mid grey, the same mistake as reading a photograph of a forest as "the
  // colour of a forest"), and averaging a continuous field was always going
  // to erase exactly the contrast it was meant to capture. Four
  // relationships are the actual specification and hold for every seed —
  // see `assertPaletteContract` below, which throws rather than let a later
  // tuning pass quietly flatten them again:
  //  1. Lightness spans at least 0.30 to 0.90 across the disc — that range
  //     is what "pops".
  //  2. Saturation *contrasts*: zones near-neutral (~0.12-0.18), belts
  //     properly saturated (~0.35-0.45). One saturation everywhere is mud.
  //  3. Exactly one high-saturation accent — the storm, ~0.75 — and nothing
  //     else may approach it, or the focal point is lost.
  //  4. The poles are cool (h≈205) against warm bands; the complementary
  //     contrast is what makes the warm read warmer.

  /** The body's hue anchor, degrees, rolled per sector across a narrow band
   * — "a few degrees," not the 22-degree spread the mud roll came from.
   * Character varies; whether the planet has contrast never does. */
  baseHueMin: 27,
  baseHueMax: 35,
  /** Six colour stops the flow value `t` (see `flow` in `BODY_FRAGMENT`) is
   * ramped across, each an offset from `uHue` plus its own saturation and
   * lightness — warm near-white zone, pale cream zone, tan transition,
   * rust belt, dark rust-brown belt, deepest brown-red belt. Two more stops
   * than the previous build: that one topped out at the pale-zone stop
   * (l=0.8) and bottomed at one "deep" stop (l=0.22 but only s=0.36) — never
   * hitting the near-white top the brief's own lightness floor requires, and
   * never separating "belt" from "darkest belt" enough to read as two
   * different depths rather than one long fade. The ramp over a *continuous*
   * field, rather than a discrete lookup, is unchanged from the previous
   * build — that is what keeps bands from reading as stripes — only the
   * stops themselves are now anchored to the Hubble reference instead of
   * chosen freehand. */
  brightHueOffset: 10,
  brightSaturation: 0.12,
  brightLightness: 0.9,
  zoneHueOffset: 8,
  zoneSaturation: 0.18,
  zoneLightness: 0.8,
  midHueOffset: 2,
  midSaturation: 0.28,
  midLightness: 0.66,
  beltHueOffset: -10,
  beltSaturation: 0.4,
  beltLightness: 0.5,
  darkBeltHueOffset: -14,
  darkBeltSaturation: 0.42,
  darkBeltLightness: 0.36,
  deepHueOffset: -16,
  deepSaturation: 0.38,
  deepLightness: 0.28,
  /** The boundary streamer's own colour — pale grey-blue, fixed rather than
   * relative to `uHue`, matching the turbulent cloud tone the Galileo
   * close-up shows precisely at a belt/zone transition and nowhere else.
   * Mixed in by `edge` (see `BODY_FRAGMENT`), never by latitude, which is
   * what keeps it a boundary phenomenon rather than a third band family. */
  streamerHue: 205,
  streamerSaturation: 0.14,
  streamerLightness: 0.74,
  /** How much of the flow field's local gradient magnitude survives into
   * `edge` before it is used as a mix weight — see `flow`'s own comment on
   * why a gradient, not a value, is what marks a boundary. First-draft
   * tuning treated any nonzero gradient as a boundary and painted the
   * streamer almost everywhere, since four-octave noise has *some* slope
   * nearly every pixel it owns; `BODY_FRAGMENT`'s own `edge` now runs the
   * gain through a smoothstep threshold rather than a plain clamp, so a
   * gentle slope inside a band contributes nothing and only a genuine tear
   * crosses into visible streamer. */
  edgeEpsilon: 0.045,
  edgeGain: 3.2,
  edgeLow: 0.12,
  edgeHigh: 0.55,
  edgeMix: 0.42,

  // ── the flow field (item 1-4: the technique itself) ───────────────────

  /** Frequency the (lon, lat) pair is scaled to before it reaches the noise
   * — one knob shared by both axes; `latStretch` below is what makes the
   * two axes disagree. */
  flowScale: 2.2,
  /**
   * The multiplier applied to the latitude axis only, on top of
   * `flowScale` — the brief's own "stretch the sampling coordinates hard in
   * latitude" and the one number doing more than anything else in this
   * file. A noise field sampled at `vec3(cos(lon), lat * latStretch,
   * sin(lon)) * flowScale` fits far more noise cycles across the latitude
   * range than the longitude range for the same physical distance, which
   * stretches every feature into something wide and flat — texture that
   * happens to be banded, rather than a band that has texture painted on
   * it. Below about 4 the result reads as blobby weather with no belts at
   * all; the brief's own suggested value is 8.
   */
  latStretch: 8.0,
  /** Displacement strength in the domain warp — `flow`'s three nested `fbm3`
   * calls, in `render/shaders/noise.ts`, which take this as their `warp`
   * argument — the brief's own "displace the noise sample position by another
   * noise field," the mechanism that turns smooth gradients into curls and
   * festoons. Too high and the warp overwhelms the latitude stretch above
   * and the bands dissolve back into blobs; this sits just under that
   * point. */
  warpStrength: 1.1,
  /** Gain applied to the flow value before it is mapped to a colour stop.
   * Summing four octaves of warped noise clusters its output near the
   * middle of its own range far more often than at either extreme — a
   * central-limit effect, the same reason adding dice gets you more 7s than
   * 2s or 12s — so an untouched `flow` value spends most of its pixels near
   * `t = 0.5`, sitting in the zone-belt transition rather than in either
   * stop, and the disc reads as one muddy mid-tone with a bright rim
   * instead of alternating pale zones and dark belts. This is what stretches
   * the value back out so most pixels commit to a stop; without it, item
   * 2's latitude stretch was setting up bands that this flattening then
   * erased before they ever reached the colour ramp. */
  flowContrast: 1.7,
  /** Range the per-sector jet frequency (`uJetFreq`, how many alternating
   * shear bands fit pole to pole) is rolled from — the belt count's
   * replacement, now expressed as a rate rather than a count because there
   * is no discrete band list left to size. */
  jetFreqMin: 3,
  jetFreqMax: 6,
  /** Range the per-sector shear amplitude is rolled from, in the same
   * lon-radians units `uShearAmp` displaces the flow sample by — the
   * brief's item 3, "offset the longitude coordinate by a velocity that
   * varies with latitude, alternating direction between adjacent bands."
   * `sin(lat * jetFreq)` supplies the alternation; this supplies how hard
   * adjacent jets disagree, which is what tears the boundary between them
   * rather than merely bending it. */
  shearAmpMin: 0.5,
  shearAmpMax: 1.0,

  // ── the storm (item 5: vorticity, not a sticker) ──────────────────────

  /** Half-width of the storm's influence in longitude, radians — sized so
   * `2 * stormHalfLon` is roughly a sixth of the full circumference
   * (`stormHalfLon / π ≈ 0.16`), the brief's own "roughly a sixth of the
   * disc," a Great-Red-Spot-sized feature rather than a small eddy. */
  stormHalfLon: 0.5,
  /** Half-height in latitude — smaller than the longitude half-width on
   * purpose, an oval rather than a circle, because a circular storm reads as
   * a second small moon and an oval reads as weather. */
  stormHalfLat: 0.22,
  /** How far latitude the storm's centre is rolled from the equator —
   * kept well inside the polar-cap threshold below so it never has to
   * compete with the pole blend for the same pixels. */
  stormLatRange: 0.35,
  /** Peak rotation, radians, the storm bends the sampling coordinate through
   * at its own centre, fading to none past its own influence radius — see
   * `BODY_FRAGMENT`'s own comment on why this rotates the *coordinate*
   * rather than paints an ellipse: the surrounding flow spirals into the
   * distortion the way real weather wraps around a vortex, instead of
   * sitting on top of it. */
  vortexStrength: 2.6,
  /** The storm's own hue offset from `uHue`, saturation and lightness. The
   * Hubble reference's Great Red Spot is not a different *hue* from the
   * surrounding tan (it sits at the same offset as `midHueOffset`, both
   * roughly 32° absolute) — it is a much more saturated one, s=0.75 against
   * a belt ceiling of 0.42. That gap is relationship 3 of the palette
   * contract: the storm is the one accent the eye is allowed to land on, and
   * a second high-saturation feature anywhere else on the body would split
   * that focal point. `assertPaletteContract` enforces the margin. */
  stormHueOffset: 2,
  stormSaturation: 0.75,
  stormLightness: 0.55,

  // ── poles ──────────────────────────────────────────────────────────────

  /** Absolute latitude (0-1, fraction of a right angle) past which the flow
   * field's own colour blends into the mottled polar cap. Still needed with
   * a continuous noise field for the reason `flowPoint`'s own comment gives:
   * the cylindrical embedding that closes the longitude seam does not
   * shrink toward the pole the way a true spherical one would, so without
   * this blend the last few degrees would show noise sampled at an
   * effectively wrong scale rather than the calmer, more chaotic texture
   * the JunoCam polar reference actually shows. */
  poleThreshold: 0.74,
  /** How much further latitude the blend above takes to reach full strength. */
  poleBlendWidth: 0.16,
  /** The cap's own hue, fixed rather than relative to the body's base hue —
   * the reference's poles read grey-blue regardless of the warm hue family
   * the zones and belts are drawn from, so this is an absolute degree value,
   * the one hue constant in the file that is not an offset from `baseHue`. */
  poleHue: 205,
  /** The cap's own saturation and lightness once the blend above is complete
   * — muted, near-neutral like the zone stops rather than dark like the
   * belts, so the poles read as their own cool, low-drama region rather than
   * as one more (very dark) stripe. Relationship 4 of the palette contract
   * is `poleHue` against `baseHueMin`/`baseHueMax` above, not this pair —
   * see `assertPaletteContract`. */
  poleSaturation: 0.12,
  poleLightness: 0.46,

  // ── lighting (§3.1, done per fragment instead of by `MeshStandardMaterial`) ─

  /** The floor `body`'s own Lambertian term is lifted to, out of a 0-1
   * `N·L` that would otherwise reach true zero on the night side — the same
   * shape of trade `render/light.ts`'s `STAR.floor` makes, but a deliberately
   * higher number and its own constant rather than that one reused. `STAR`
   * was tuned for a single job — keep a lit body's dark hemisphere from
   * vanishing into the background — and nothing else in the scene consumes
   * it yet, so there was no real "single source of truth" being served by
   * sharing it, only the appearance of one. `STAR.floor`'s 12:1 lit-to-dark
   * ratio swings far wider across one hemisphere than the value contrast
   * the flow field itself produces, and unconstrained would let the
   * lighting term dominate the banding term by an order of magnitude. This
   * floor is what narrows that gap:
   * high enough that the dim side of the terminator still keeps most of a
   * band's own contrast, at some real cost to how dark the true night side
   * can get. That trade — a flatter terminator for a legible band pattern —
   * is the one this file exists to make; `STAR.floor`'s own trade, tuned for
   * a body with no competing pattern to protect, is not the same trade. */
  ambientFloor: 0.32,
  /** Brightness the silhouette edge is darkened to at its dimmest, separate
   * from the terminator — a view-angle falloff, not a light-angle one, which
   * is most of why the Cassini reference reads as a sphere rather than a lit
   * disc. 0 would black out the limb entirely and erase the swatch colour
   * that is supposed to still be visible there; this is a floor, the same
   * shape of trade `ambientFloor` above makes for the terminator itself. */
  limbDarkFloor: 0.35,
  /** Exponent shaping how fast the falloff above sets in — higher holds full
   * brightness closer to the centre of the disc and darkens only the last
   * sliver toward the edge. */
  limbDarkPower: 1.6,
  /** Strength of a second, tinted falloff layered on top of `limbDark` —
   * item 6's "thin scattering falloff toward the silhouette edge," a cool
   * highlight rather than a dimming, the way a real atmosphere's Rayleigh
   * scattering brightens and cools the limb instead of only darkening it.
   * Kept well below 1 — this rims the edge, it does not recolour it. */
  scatterStrength: 0.14,
  /** Exponent shaping the scattering falloff — steep, so it stays a thin rim
   * rather than washing the tinted colour across the whole lit hemisphere. */
  scatterPower: 3.0,

  // ── terminator scattering (item 2, the disc's half) ───────────────────────

  /**
   * How strongly the day/night boundary reddens, 0-1.
   *
   * The Lambertian term above is *correct* and it is not enough: a real
   * terminator is not merely the place where a surface stops being lit, it is
   * the place where every photon reaching your eye has taken the longest
   * possible slant path through the atmosphere, which is the same geometry
   * that makes a sunset red. Without this the boundary is a clean grey ramp —
   * provably right, and the one part of the image an eye that has seen a
   * photograph of Jupiter knows is wrong.
   *
   * Kept at roughly half strength because the warm band is *additional* to the
   * band pattern it crosses, not a replacement for it: at 1 the sunset colour
   * wins outright wherever it lands and takes the belts with it, which trades
   * the third rebuild's whole achievement for the fourth's.
   */
  terminatorGlow: 0.55,
  /** Width of the reddening band, in units of `dot(N, L)` — a Gaussian, so
   * this is its standard deviation rather than an edge. 0.30 puts the visible
   * falloff at roughly 35° either side of the geometric terminator, which is
   * about where a real atmosphere's slant path stops being extreme. */
  terminatorWidth: 0.3,
  /** The sunset tint itself, multiplied by the star's own colour before use so
   * a blue star cannot produce an orange sunset. Fixed rather than derived
   * from `uHue`: the reddening is a property of *air*, not of the pigment
   * underneath it, and deriving it from the body's own hue would make a
   * blue-banded planet redden blue, which is exactly backwards. */
  sunsetR: 1.0,
  sunsetG: 0.52,
  sunsetB: 0.28,

  // ── aurorae (item 4) ──────────────────────────────────────────────────────

  /**
   * Where the auroral oval sits, as `absLat` — the same 0-1 fraction of a
   * right angle `poleThreshold` uses. Inside the polar cap rather than at its
   * edge, because the cap is the one region of the disc this shader
   * deliberately makes calm and dim (see `poleThreshold`), and an emissive
   * ring needs somewhere quiet to be seen against. A real auroral oval sits
   * at the foot of the field lines rather than at the pole itself, which is
   * why this is 0.84 and not 1.0: a glowing dot exactly on the axis reads as
   * a specular highlight, and a *ring* reads as an aurora.
   */
  auroraLat: 0.84,
  /** Gaussian half-width of that ring, in the same units. Narrow — an oval,
   * not a polar wash — but widened from a first draft of 0.075 once measured
   * rather than reasoned about. This game's camera sits essentially in the
   * body's equatorial plane (the giant is at `height: 0` and the cockpit
   * cameras ride a few units above `y = 0` a thousand units away), so a polar
   * ring is *always* seen edge-on: a band 7° wide in latitude at 77° north
   * projects to under twenty pixels of a seven-hundred-pixel disc, of which
   * only the unlit part shows. The width and the strength below are both sized
   * for that permanently foreshortened view rather than for the overhead one
   * every photograph of a real aurora is taken from. */
  auroraWidth: 0.1,
  /** Peak additive brightness. Additive rather than a blend because an aurora
   * is emission, not albedo: it has to be visible on the *unlit* hemisphere,
   * which is the entire reason to have one — it gives the night side
   * something to be rather than merely something that is dark. Raised from a
   * first draft of 0.55 for the reason `auroraWidth` records: measured against
   * the frame rather than reasoned about, the ring is a thin arc on the limb
   * and needed the brightness a wide polar cap would not have. */
  auroraStrength: 1.0,
  /** Spatial frequency of the curtain structure around the ring. The
   * brightness variation is a function of longitude, so it rides the body's
   * rotation and never modulates the whole ring at once — the difference
   * between a curtain and a throb, and §4.1's rule is that only the first is
   * allowed. */
  auroraDetail: 5.5,
  /** How fast that structure drifts, in noise units per second. Slow: this is
   * the aurora's own weather, and it must stay well under the threshold where
   * a viewer reads change as flicker. */
  auroraDriftRate: 0.045,
  /** How far the aurora's colour is pulled from the sector light's own toward
   * a fixed auroral tint, 0-1. The brief is "tinted by the sector light's own
   * colour", and at 0 that is literal — but a warm star lighting a warm body
   * would then paint a warm aurora onto tan cloud and produce nothing visible
   * at all. Half-way keeps the star's contribution obvious (a blue star's
   * aurora is unmistakably colder) while guaranteeing the ring separates from
   * whatever it is drawn over. */
  auroraShift: 0.5,
  /** That fixed tint. Pale green-white, the real thing's own oxygen line, and
   * deliberately low-saturation: `docs/environment.md` §4.1 exempts bodies
   * from the hue rule, but the exemption is conditional on a body never being
   * mistakable for a contact, and a saturated green ring is the one colour on
   * this palette that could be argued at (Lance's acid green). Pale and mixed
   * half-way to the star's own colour is comfortably clear of it, and the
   * scanner — §4.1's named arbiter — never draws a body at all. */
  auroraR: 0.55,
  auroraG: 0.95,
  auroraB: 0.8,

  // ── the limb halo (§3.2, "bloom is the atmosphere") ───────────────────────

  /** `limb`'s radius as a multiple of `body`'s. */
  limbScale: 1.03,
  /** Fresnel exponent — higher pulls the glow tighter to the true silhouette. */
  limbPower: 2.6,
  /** Brightness multiplier at full fresnel, before bloom's own threshold.
   * Still above 1 on purpose — this is the one place on the body meant to
   * cross it, the mechanism behind "phosphorescent" in the brief — but
   * pulled down from 1.7. At 1.7 the fresnel rim was crossing bloom's
   * threshold by enough that the pass spread it into a solid white ring that
   * ate the true silhouette instead of rimming it; the edge read as a halo
   * swallowing the planet rather than atmosphere sitting on top of one. 1.1
   * still blooms — the rim is still lit past the threshold — it just no
   * longer dominates it.
   *
   * **Raised to 1.35 with the shell's own rewrite.** The 1.1 above was tuned
   * against a *uniform* fresnel that glowed everywhere at once; the shell now
   * spends most of its brightness where the star actually puts it, so the same
   * number produced a dimmer halo everywhere rather than the same halo
   * redistributed. The white-ring failure that set the old ceiling is
   * additionally no longer reachable the same way: the ring cannot be solid
   * any more, because the night quarter of it is now dark by construction. */
  limbIntensity: 1.35,
  /** Gain on the shell's forward-scattering lobe — the multiplier on
   * `henyeyGreenstein` in `LIMB_FRAGMENT`. This is the constant that decides
   * how spectacular a backlit body is: at 0 the shell is a plain lit fresnel,
   * and at this value a crescent's rim runs several times brighter than the
   * same shell seen fully lit, which is the effect the whole term exists for
   * and the one that reliably crosses bloom's threshold. */
  limbForward: 0.55,
  /** The lobe's asymmetry, `g` — how tightly the forward scattering is
   * concentrated. 0.76 is the usual figure for a hazy atmosphere and gives a
   * roughly 300:1 forward-to-backward ratio. Below about 0.5 the lobe is broad
   * enough that a fully lit body starts glowing as brightly as a backlit one,
   * which erases the asymmetry this replaced a uniform fresnel to get. */
  limbAsymmetry: 0.76,
  /** Width of the shell's own sunset band, in `dot(N, L)`. Wider than the
   * disc's (`terminatorWidth`) on purpose: the shell is a *shell*, so the
   * geometry at any given screen pixel of it spans a range of true surface
   * normals, and a band as tight as the disc's would alias into a hard ring
   * where the terminator crosses the silhouette. */
  limbSunsetWidth: 0.4,
  /** The shell's daylight tint — the cool blue-white of a lit haze layer seen
   * from outside, and the colour the old uniform fresnel used for everything.
   * It is now only what the *lit* part of the shell is, with the sunset tint
   * (`sunsetR`/`G`/`B`) taking over across the terminator. */
  limbDayR: 0.62,
  limbDayG: 0.78,
  limbDayB: 1.0,
} as const;

/** One turn, for the phase wraps in `update`. */
const TAU = Math.PI * 2;

/** Circular hue distance in degrees, 0-180. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The four structural relationships from the task brief, checked against the
 * literal `GIANT` numbers rather than left to a comment alone — a mud roll
 * has already happened twice on this feature (once from an unconstrained hue
 * roll, once from flattening every stop to one saturation), and a comment is
 * exactly the kind of thing a future tuning pass reads once and then stops
 * reading. This throws at *module load* — `vite build` never evaluates a
 * module body, so this is a dev-server and playtest gate, not a build gate;
 * an earlier draft of this comment claimed it "fails the build", which is
 * not what a `tsc --noEmit` typecheck or a `vite build` bundle-and-emit
 * pass actually does. Gated to `location.hostname` the same way `main.ts`
 * gates `DEBUG_PROBE`, so a violation that slips past dev and playtest
 * cannot black-screen the shipped page from frame zero. Checks item 5 too
 * now: `render/light.ts`'s `STAR` hue bands, the one input to this shader
 * that is not a `GIANT` constant but still multiplies every stop below
 * (line ~811's `uLightColor`) — the mud roll this function exists to catch
 * happened a third time, in that file, before this check was added.
 * Nothing here depends on the per-sector seed roll — every quantity checked
 * is a fixed constant or a fixed bound on a roll — so it runs once,
 * unconditionally, module-load, not per `show()`.
 */
function assertPaletteContract(): void {
  const zoneStops = [
    ["bright", GIANT.brightSaturation, GIANT.brightLightness],
    ["zone", GIANT.zoneSaturation, GIANT.zoneLightness],
  ] as const;
  const beltStops = [
    ["mid", GIANT.midSaturation, GIANT.midLightness],
    ["belt", GIANT.beltSaturation, GIANT.beltLightness],
    ["darkBelt", GIANT.darkBeltSaturation, GIANT.darkBeltLightness],
    ["deep", GIANT.deepSaturation, GIANT.deepLightness],
  ] as const;
  const allStops = [...zoneStops, ...beltStops] as const;

  // 1. Lightness spans at least 0.30 to 0.90.
  const lightnesses = allStops.map(([, , l]) => l);
  const lMin = Math.min(...lightnesses);
  const lMax = Math.max(...lightnesses);
  if (lMin > 0.3 || lMax < 0.9) {
    throw new Error(
      `GasGiant palette: lightness spans ${lMin.toFixed(2)}-${lMax.toFixed(2)}, ` +
        `needs at least 0.30-0.90 or the body stops popping`,
    );
  }

  // 2. Saturation contrasts — zones near-neutral, belts properly saturated.
  for (const [name, s] of zoneStops) {
    if (s > 0.2) {
      throw new Error(`GasGiant palette: zone stop "${name}" at s=${s} is not near-neutral (>0.20)`);
    }
  }
  for (const [name, s] of beltStops) {
    if (s < 0.25) {
      throw new Error(`GasGiant palette: belt stop "${name}" at s=${s} has flattened toward the zones (<0.25)`);
    }
  }

  // 3. Exactly one high-saturation accent — the storm — and nothing else may
  // approach it. "Approach" is drawn at 0.5: comfortably above every belt
  // stop's own ceiling (~0.42) and comfortably below the storm's own 0.75,
  // so tightening a belt for its own reasons cannot silently erode the
  // storm's exclusivity without tripping this.
  for (const [name, s] of allStops) {
    if (s >= 0.5) {
      throw new Error(`GasGiant palette: "${name}" at s=${s} rivals the storm — the focal point would be lost`);
    }
  }
  if (GIANT.stormSaturation < 0.65) {
    throw new Error(`GasGiant palette: storm saturation ${GIANT.stormSaturation} is no longer a clear accent`);
  }
  // The white oval joins this relationship rather than getting an exemption
  // from it. It is the *brightest* thing on the disc by design, which is a
  // different axis from saturation and does not compete for the eye the same
  // way — but a future tuning pass reaching for "make the oval read better"
  // will reach for saturation first, and that is the change that would give
  // the body two accents and therefore none.
  if (GIANT.ovalSaturation >= 0.5) {
    throw new Error(
      `GasGiant palette: the white oval at s=${GIANT.ovalSaturation} rivals the storm — ` +
        `it is meant to win on lightness, not on colour`,
    );
  }
  if (GIANT.ovalLightness <= GIANT.brightLightness) {
    throw new Error(
      `GasGiant palette: the white oval at l=${GIANT.ovalLightness} is no brighter than the ` +
        `brightest zone stop (${GIANT.brightLightness}) — it would read as a gap in the bands, not a storm`,
    );
  }

  // 4. Poles are cool against warm bands — a wide hue separation from the
  // body's own warm anchor, not merely "a different number".
  const anchor = (GIANT.baseHueMin + GIANT.baseHueMax) / 2;
  if (hueDistance(GIANT.poleHue, anchor) < 120) {
    throw new Error(`GasGiant palette: pole hue ${GIANT.poleHue} is too close to the warm anchor ${anchor}`);
  }

  // 5. The light term. `render/light.ts`'s STAR.warmHueMax/coolHueMin/
  // coolHueMax bound the per-sector roll, not a fixed colour, so this
  // checks the bound stays clear of every hue this game reserves —
  // rather than sampling the roll, which could pass a thousand times and
  // still be one bad seed from the collision this whole check exists for.
  // Margin is 25° each side of the band, the same shape of tolerance
  // item 3's 0.5 threshold gives the storm's own exclusivity.
  const HUE_MARGIN = 25;
  const RESERVED_HUES = [
    ["cyan — ours (palette.trace)", 178],
    ["Lance's acid green (palette.lance)", 89],
    ["magenta — unresolved contact (palette.magenta)", 333],
  ] as const;
  const bands = [
    ["warm", 0, STAR.warmHueMax],
    ["cool", STAR.coolHueMin, STAR.coolHueMax],
  ] as const;
  for (const [reservedName, reservedHue] of RESERVED_HUES) {
    for (const [bandName, bandMin, bandMax] of bands) {
      const distance =
        reservedHue >= bandMin && reservedHue <= bandMax
          ? 0
          : Math.min(hueDistance(reservedHue, bandMin), hueDistance(reservedHue, bandMax));
      if (distance < HUE_MARGIN) {
        throw new Error(
          `GasGiant palette: STAR's ${bandName} hue band [${bandMin}-${bandMax}] comes within ` +
            `${distance.toFixed(0)}° of ${reservedName} — needs ${HUE_MARGIN}°+ or a coloured star ` +
            `recolours the body into a reserved hue`,
        );
      }
    }
  }
}
// `main.ts`'s own `DEBUG_PROBE` gate, duplicated rather than imported —
// `src/main.ts` pulls in the DOM, the renderer and the whole game, and this
// module has stayed free of all three on purpose (see this file's own
// header). A production `location.hostname` fails this check and the throw
// above never fires there, so a violation degrades to whatever the shader
// actually renders instead of a black screen at frame zero.
const ON_LOCALHOST =
  typeof location !== "undefined" && (location.hostname === "127.0.0.1" || location.hostname === "localhost");
if (ON_LOCALHOST) assertPaletteContract();

// `limb`'s material is `render/shaders/celestial.ts`'s `LIMB_VERTEX`/
// `LIMB_FRAGMENT` now, imported at the top of this file rather than written
// here. What used to live at this spot was a six-line fresnel — `pow(1 -
// dot(normal, viewDir), power)` and nothing else — and the reason it moved
// out is not that a second body wanted a copy of it (though `Planet.ts` now
// does): it is that the term was *wrong about the physics* in a way no amount
// of local tuning could reach, and the argument for what replaced it is long
// enough to be worth writing once. See that file's own header for it. The
// short version is that a fresnel measures path length through a shell and
// says nothing at all about where the star is, so the old shell glowed
// identically on the day side, the night side and the terminator.

/**
 * `body`'s vertex stage, unchanged in shape from the swatch build though the
 * fragment stage it feeds is not: `vObjectNormal` still passes through
 * *before* any transform, so the flow field's longitude/latitude are still a
 * function of the mesh alone. What changed is what rides that ride —
 * `body.rotation.y` never moves any more (see `update`'s own comment); the
 * shader instead advances a `uRotation` uniform added to `lon` at the very
 * start of the fragment stage, item 7's "advance the sample coordinate"
 * rather than the mesh. `vViewNormal` is the same normal *after* the
 * standard `normalMatrix` transform (view space, per three.js convention),
 * used only for lighting. `vLightDirView` carries the sector light's fixed
 * world direction into that same view space via the built-in `viewMatrix`,
 * so the dot product in the fragment stays in one consistent space without
 * this class having to recompute anything per frame as the camera moves —
 * `viewMatrix` is already updated every frame by three.js for any
 * `ShaderMaterial`, the same free ride `modelViewMatrix`/`normalMatrix` give
 * the limb shader above.
 */
const BODY_VERTEX = `
uniform vec3 uLightDirWorld;
varying vec3 vObjectNormal;
varying vec3 vViewNormal;
varying vec3 vViewDir;
varying vec3 vLightDirView;
void main() {
  vObjectNormal = normal;
  vViewNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewDir = normalize(-mvPosition.xyz);
  vLightDirView = normalize((viewMatrix * vec4(uLightDirWorld, 0.0)).xyz);
  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * `body`'s fragment shader. Not a builder function — the swatch build's
 * `buildBodyFragment` existed to stringify
 * `GIANT.zoneSwatches`/`beltSwatches` into compile-time array literals so a
 * strict GLSL ES loop bound would accept them; nothing here loops over a
 * per-sector-sized list any more; every `GIANT` number reaches the shader as
 * an ordinary uniform, set once per `show()` the same way the light and pole
 * constants always were.
 *
 * The one interpolation left is `flowLadder(4)`, and it is the same species
 * of thing `buildBodyFragment` was — an octave count is a GLSL ES constant
 * loop bound and so can never be a uniform — but it is *one* number, fixed
 * for every sector, rather than a per-sector list, which is why this is
 * still a module constant and not a function of the seed.
 */
const BODY_FRAGMENT = `
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
uniform float uJetDrift;
uniform float uEdgeEpsilon;
uniform float uEdgeGain;
uniform float uEdgeLow;
uniform float uEdgeHigh;
uniform float uEdgeMix;
uniform float uBrightHue;
uniform float uBrightSaturation;
uniform float uBrightLightness;
uniform float uZoneHue;
uniform float uZoneSaturation;
uniform float uZoneLightness;
uniform float uMidHue;
uniform float uMidSaturation;
uniform float uMidLightness;
uniform float uBeltHue;
uniform float uBeltSaturation;
uniform float uBeltLightness;
uniform float uDarkBeltHue;
uniform float uDarkBeltSaturation;
uniform float uDarkBeltLightness;
uniform float uDeepHue;
uniform float uDeepSaturation;
uniform float uDeepLightness;
uniform float uStreamerHue;
uniform float uStreamerSaturation;
uniform float uStreamerLightness;
uniform float uStormLon;
uniform float uStormLat;
uniform float uStormHalfLon;
uniform float uStormHalfLat;
uniform float uVortexStrength;
uniform float uVortexPhase;
uniform float uStormHue;
uniform float uStormSaturation;
uniform float uStormLightness;
uniform float uOvalLon;
uniform float uOvalLat;
uniform float uOvalHalfLon;
uniform float uOvalHalfLat;
uniform float uOvalVortex;
uniform float uOvalPhase;
uniform float uOvalHue;
uniform float uOvalSaturation;
uniform float uOvalLightness;
uniform float uPoleThreshold;
uniform float uPoleBlendWidth;
uniform float uPoleHue;
uniform float uPoleSaturation;
uniform float uPoleLightness;
uniform vec3 uLightColor;
uniform float uAmbientFloor;
uniform float uLimbDarkFloor;
uniform float uLimbDarkPower;
uniform float uScatterStrength;
uniform float uScatterPower;
uniform float uTerminatorGlow;
uniform float uTerminatorWidth;
uniform vec3 uSunsetColor;
uniform float uLimbAsymmetry;
uniform float uAuroraLat;
uniform float uAuroraWidth;
uniform float uAuroraStrength;
uniform float uAuroraDetail;
uniform float uAuroraDrift;
uniform vec3 uAuroraColor;
uniform float uAuroraShift;

varying vec3 vObjectNormal;
varying vec3 vViewNormal;
varying vec3 vViewDir;
varying vec3 vLightDirView;

// hueFrac, hsl2rgb, smoothstepc, wrapAngle and henyeyGreenstein — from
// render/shaders/celestial.ts, where they live now that a second lit body
// (render/Planet.ts) wants the same vocabulary and the HSL conversion in
// particular has to agree between them: assertPaletteContract below checks
// this body's palette as *numbers*, and a second conversion that turned the
// same numbers into slightly different colours would make one contract mean
// two things.
${CELESTIAL_UTIL}

// The noise ladder — hash31, noise3, fbm3, flow — from
// render/shaders/noise.ts, where it lives now that Nebula.ts and this file
// had each grown a copy of it. Every rung's own reasoning moved with it;
// the two decisions that are *this body's* rather than the ladder's are
// recorded here, because they are arguments about a gas giant and not
// about noise:
//
// Four octaves, item 1's own recipe, held to four rather than the usual
// five or six because flow evaluates this three times per fragment (once
// per warp level) and a fifth octave buys detail this body's screen size
// never keeps past the bloom pass.
//
// The field is periodic across the lon = ±π seam because flowPoint below
// embeds longitude on a unit circle (cos(lon), sin(lon)) before it ever
// reaches hash31 — nothing in the ladder itself supplies that. The swatch
// build's own boundary harmonics had to stay integer-frequency for the same
// closure; embedding on a circle buys the same seamlessness without
// constraining every frequency in this shader to an integer.
${flowLadder(4)}

/** Maps a longitude/latitude pair to the 3D point flow actually samples.
 * uLatStretch is item 2 of the brief and does more than anything else in
 * this file: multiplying only the latitude axis fits far more noise cycles
 * across the latitude range than the longitude range for the same physical
 * distance, which stretches every feature into something wide and flat —
 * texture that happens to be banded, rather than a band that has texture
 * painted on it. The trade this embedding makes for closing the seam (see
 * hash31's own comment) is that cos(lon)/sin(lon) do not shrink toward
 * the pole the way a true spherical embedding would — a cylinder, not a
 * sphere — so the last few degrees of latitude sample the field at an
 * effectively wrong scale. main hides this behind the polar blend rather
 * than correcting it, because a correction here would reintroduce the exact
 * per-fragment trig cost item 2 exists to spend on stretch instead. */
vec3 flowPoint(float lon, float lat) {
  return vec3(cos(lon), lat * uLatStretch, sin(lon)) * uFlowScale;
}

void main() {
  vec3 n = normalize(vObjectNormal);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  // +1e-6 on the second argument: GLSL's two-arg atan is atan2, undefined
  // by spec at (0, 0), which is exactly the interpolated normal a pole
  // rounds to. The offset breaks the tie toward a fixed, arbitrary lon
  // there instead of a NaN that would otherwise propagate through flow(p)
  // into the poleT blend already built to hide exactly this seam.
  float lon0 = atan(n.x, n.z + 1e-6);
  float latNorm = clamp(lat / 1.5707963, -0.9999, 0.9999);
  float absLat = abs(latNorm);

  float jet = sin(lat * uJetFreq + uJetPhase);

  // Differential rotation. 'uRotation' is still the one advancing number, but
  // it no longer advances every longitude by the same amount: 'spinRate'
  // scales it by latitude, fastest at the equator ('cos(lat)^2' → 1) and
  // slowest at the poles (→ uDiffPole), with each jet's own alternating sign
  // added on top. Two adjacent bands therefore accumulate *different*
  // longitude offsets as the run goes on, so the boundary between them is
  // continuously drawn out and folded rather than translated rigidly. See
  // GIANT.diffPole for why this one 'mix' is the difference between weather
  // and a photograph on a turntable.
  float cl = cos(lat);
  float lonFlow = lon0 + uRotation * (mix(uDiffPole, 1.0, cl * cl) + uJetDrift * jet);

  // Each storm rides its *own* band, which means it needs its own frame: the
  // same spin rate evaluated at the storm's fixed latitude rather than at
  // this fragment's. Without this a storm placed at a fixed longitude in a
  // differentially-rotating frame would be sheared apart by the very
  // mechanism above — its top edge outrunning its bottom edge — within
  // seconds. Evaluating the rate at the storm's centre keeps it rigid, and
  // because the two expressions agree exactly at 'lat = uStormLat', the
  // vortex's own blend into the surrounding flow stays continuous: the frames
  // differ only where the blend weight has already fallen away.
  float clS = cos(uStormLat);
  float lonStorm = lon0 + uRotation * (mix(uDiffPole, 1.0, clS * clS) + uJetDrift * sin(uStormLat * uJetFreq + uJetPhase));
  float clO = cos(uOvalLat);
  float lonOval = lon0 + uRotation * (mix(uDiffPole, 1.0, clO * clO) + uJetDrift * sin(uOvalLat * uJetFreq + uJetPhase));

  // Shear — item 3 of the third rebuild: alternating jet direction per
  // latitude band, offset straight into the longitude the flow field samples
  // at. This is the *static* disagreement between neighbours; the rate term
  // above is the growing one, and the two are complementary — without the
  // static offset a fresh body would start with every band identical, and
  // without the rate term it would keep whatever tear it started with
  // forever.
  float shearedLon = lonFlow + jet * uShearAmp;

  // The storm — item 5: bend the *sampling coordinate* rotationally around
  // its own centre before the flow field ever sees it, rather than draw an
  // oval and stop. The surrounding bands' own texture spirals into the
  // distortion the way real weather wraps around a vortex, instead of a
  // patch of different-coloured noise sitting on top like a sticker.
  //
  // 'uVortexPhase' is what makes it turn. It is added to the rotation angle
  // rather than multiplied into it, so the spiral rotates *rigidly* — a phase
  // folded into 'uVortexStrength' instead would wind the eye tighter every
  // second until the storm was a drill hole. Rigid rotation is also the
  // honest picture: a vortex's shape is quasi-stable and it is the whole
  // structure that turns.
  float dLon = wrapAngle(lonStorm - uStormLon);
  float dLat = lat - uStormLat;
  vec2 rel = vec2(dLon / uStormHalfLon, dLat / uStormHalfLat);
  float stormR = length(rel);
  float vortexT = smoothstepc(1.3, 0.0, stormR);
  float ang = vortexT * uVortexStrength + uVortexPhase;
  float ca = cos(ang);
  float sa = sin(ang);
  vec2 relRot = vec2(rel.x * ca - rel.y * sa, rel.x * sa + rel.y * ca);
  float lonEff = mix(shearedLon, uStormLon + relRot.x * uStormHalfLon, vortexT);
  float latEff = mix(lat, uStormLat + relRot.y * uStormHalfLat, vortexT);

  // The white oval — the same mechanism at a different size, spin and colour,
  // in the other hemisphere. Layered *after* the red storm rather than beside
  // it so the two can never fight over the same fragment: the oval's own
  // latitude range is kept clear of the storm's, so in practice one of the
  // two weights is always zero, and layering makes that a guarantee rather
  // than an assumption about two rolls.
  float oDLon = wrapAngle(lonOval - uOvalLon);
  vec2 oRel = vec2(oDLon / uOvalHalfLon, (lat - uOvalLat) / uOvalHalfLat);
  float ovalT = smoothstepc(1.25, 0.0, length(oRel));
  float oAng = ovalT * uOvalVortex + uOvalPhase;
  float oCa = cos(oAng);
  float oSa = sin(oAng);
  vec2 oRelRot = vec2(oRel.x * oCa - oRel.y * oSa, oRel.x * oSa + oRel.y * oCa);
  lonEff = mix(lonEff, uOvalLon + oRelRot.x * uOvalHalfLon, ovalT);
  latEff = mix(latEff, uOvalLat + oRelRot.y * uOvalHalfLat, ovalT);

  vec3 p = flowPoint(lonEff, latEff);
  float f = flow(p, uWarpStrength);

  // A second sample, offset along the latitude axis only, turned into a
  // gradient magnitude. The belt/zone boundary is not a *value* on this
  // field, it is a place where the field changes fast — exactly what the
  // Galileo close-up shows: streaked grey-blue turbulence living only at
  // the transition, nowhere else. Measured on fbm3(p) — the single
  // unwarped octave stack, the same one main's own colour ramp is not
  // reading here — rather than on flow(p): domain warping is chaotic by
  // construction (that is what makes it curl at all), so a finite
  // difference across the *warped* field is highly sensitive almost
  // everywhere and first-draft tuning painted the streamer over nearly the
  // whole disc, not just its tears. The unwarped stack still carries the
  // shear and vortex already folded into p, so it still marks the belts'
  // own transitions; it just does not also register the warp's own
  // internal turbulence as a false boundary.
  float fEdge = fbm3(p);
  float fEdgeShift = fbm3(p + vec3(0.0, uEdgeEpsilon, 0.0));
  // A smoothstep threshold, not a plain clamp, on top of that: below
  // uEdgeLow contributes nothing at all; only a gradient that clears
  // uEdgeHigh reaches full strength, so a merely ordinary slope inside a
  // band still cannot paint the streamer color.
  float edge = smoothstepc(uEdgeLow, uEdgeHigh, abs(fEdge - fEdgeShift) * uEdgeGain);

  // Six stops now, not four — see GIANT's own comment on why a fixed,
  // hand-specified palette replaced a sampled one, and why bright/darkBelt
  // were added rather than only retuning the original four. Five equal
  // 0.2-wide segments instead of the old three uneven ones (0.4/0.3/0.3):
  // uneven segments would let one pair of stops dominate the disc's area at
  // the expense of the others, which is a second route to the same "reads
  // as one mid-tone" failure the flattened saturation caused.
  float t = clamp(f * uFlowContrast * 0.5 + 0.5, 0.0, 1.0);
  vec3 stopBright = hsl2rgb(hueFrac(uHue + uBrightHue), uBrightSaturation, uBrightLightness);
  vec3 stopZone = hsl2rgb(hueFrac(uHue + uZoneHue), uZoneSaturation, uZoneLightness);
  vec3 stopMid = hsl2rgb(hueFrac(uHue + uMidHue), uMidSaturation, uMidLightness);
  vec3 stopBelt = hsl2rgb(hueFrac(uHue + uBeltHue), uBeltSaturation, uBeltLightness);
  vec3 stopDarkBelt = hsl2rgb(hueFrac(uHue + uDarkBeltHue), uDarkBeltSaturation, uDarkBeltLightness);
  vec3 stopDeep = hsl2rgb(hueFrac(uHue + uDeepHue), uDeepSaturation, uDeepLightness);
  vec3 albedo;
  if (t < 0.2) albedo = mix(stopBright, stopZone, smoothstepc(0.0, 0.2, t));
  else if (t < 0.4) albedo = mix(stopZone, stopMid, smoothstepc(0.2, 0.4, t));
  else if (t < 0.6) albedo = mix(stopMid, stopBelt, smoothstepc(0.4, 0.6, t));
  else if (t < 0.8) albedo = mix(stopBelt, stopDarkBelt, smoothstepc(0.6, 0.8, t));
  else albedo = mix(stopDarkBelt, stopDeep, smoothstepc(0.8, 1.0, t));

  vec3 streamer = hsl2rgb(hueFrac(uStreamerHue), uStreamerSaturation, uStreamerLightness);
  albedo = mix(albedo, streamer, edge * uEdgeMix);

  vec3 stormColor = hsl2rgb(hueFrac(uHue + uStormHue), uStormSaturation, uStormLightness);
  albedo = mix(albedo, stormColor, vortexT * 0.85);

  vec3 ovalColor = hsl2rgb(hueFrac(uHue + uOvalHue), uOvalSaturation, uOvalLightness);
  albedo = mix(albedo, ovalColor, ovalT * 0.8);

  // Poles blend to a fixed grey-blue and drop the flow signal's own hue and
  // saturation entirely — "essentially bandless and dim" — for the reason
  // flowPoint's own comment gives: the embedding that closes the
  // longitude seam degrades approaching the pole rather than fading out,
  // and this blend is what keeps that degradation from ever being seen.
  float poleT = smoothstepc(uPoleThreshold, uPoleThreshold + uPoleBlendWidth, absLat);
  if (poleT > 0.0) {
    vec3 poleColor = hsl2rgb(hueFrac(uPoleHue), uPoleSaturation, uPoleLightness + f * 0.05);
    albedo = mix(albedo, poleColor, poleT);
  }

  // Lighting: a hand-rolled Lambertian with a lifted floor — uAmbientFloor,
  // GIANT.ambientFloor's own constant, not render/light.ts's shadeAt-only
  // STAR.floor (see that constant's comment for why the two floors are not
  // the same trade) — instead of MeshStandardMaterial's PBR response, which
  // is what was muting the flow field's own colours in the swatch build's
  // first pass.
  vec3 wn = normalize(vViewNormal);
  vec3 ld = normalize(vLightDirView);
  // Kept signed as well as clamped: the clamped form is the Lambertian term,
  // but every scattering term below is a function of *how far from the
  // terminator* a fragment is, which needs to know which side of it we are on.
  float ndlRaw = dot(wn, ld);
  float ndotl = max(ndlRaw, 0.0);
  float lit = uAmbientFloor + (1.0 - uAmbientFloor) * ndotl;

  // Limb darkening: a *view*-angle falloff, independent of the light — the
  // Cassini reference's own edge dimming, which reads as roundness even
  // where the terminator is nowhere near.
  vec3 vd = normalize(vViewDir);
  float facing = max(dot(wn, vd), 0.0);
  float limbDark = mix(uLimbDarkFloor, 1.0, pow(facing, uLimbDarkPower));

  vec3 color = albedo * uLightColor * lit * limbDark;

  // Terminator scattering, the disc's own half of item 2. The Lambertian
  // ramp above is right and it is grey: it says the boundary is where light
  // stops, and says nothing about the fact that every photon arriving from
  // near that boundary has crossed the atmosphere at the shallowest possible
  // angle. That long slant path is what reddens a sunset, and it is the first
  // thing an eye looks for in a photograph of a lit planet.
  //
  // Three factors, and dropping any one of them breaks it in a different way:
  // a Gaussian on 'ndlRaw' pins the band to the terminator itself rather than
  // washing it across the day side; the forward-scattering lobe makes a
  // backlit body's terminator far brighter than a front-lit one's, which is
  // the asymmetry the shell above exists for and is just as true down here;
  // and the '1 - facing' weighting biases it toward the silhouette, where the
  // path through the atmosphere really is longest, instead of laying a stripe
  // across the middle of the disc when the terminator happens to run through
  // it.
  float mu = clamp(-dot(vd, ld), -1.0, 1.0);
  float forward = henyeyGreenstein(mu, uLimbAsymmetry);
  float band = exp(-(ndlRaw * ndlRaw) / (uTerminatorWidth * uTerminatorWidth));
  float bandWeight = band * uTerminatorGlow * (0.35 + 0.65 * (1.0 - facing));
  color = mix(color, uSunsetColor * uLightColor * (0.45 + forward * 0.45), bandWeight);

  // A thin scattering falloff toward the true silhouette, on top of (not
  // instead of) the terminator above — item 6's second half. Tinted rather
  // than merely dimmed, the way a real atmosphere's Rayleigh scattering
  // brightens and cools the limb instead of only darkening it.
  //
  // Gated on the lit side now. It was unconditional, which put a cool
  // blue-white rim right around the *night* limb too — a halo the star has no
  // way of producing, and the exact reading the shell's own rewrite exists to
  // stop: an atmosphere that glows where nothing is lighting it looks like a
  // lamp rather than a planet.
  float scatter = pow(1.0 - facing, uScatterPower) * uScatterStrength * smoothstepc(-0.1, 0.4, ndlRaw);
  color = mix(color, vec3(0.68, 0.78, 0.88) * uLightColor, scatter);

  // Aurorae — item 4, and the only emissive thing on this body. Additive, so
  // it is visible precisely where nothing else is: 'night' is a reversed
  // smoothstep on the same signed Lambertian, so the ring fades out across the
  // terminator and is at full strength only on the unlit hemisphere, which is
  // what a real aurora does and also what gives the night side something to
  // be.
  //
  // Branched rather than multiplied out. The curtain needs its own 'fbm3'
  // evaluation — a sixth on top of the five this shader already runs — and
  // the polar band is a few per cent of the disc's fragments, so the branch
  // is coherent across essentially every warp that takes it. This is the one
  // place in the file where an 'if' is cheaper than the arithmetic it guards.
  float auroraBand = exp(-pow((absLat - uAuroraLat) / uAuroraWidth, 2.0));
  if (auroraBand > 0.004) {
    // The ring turns with the body at the polar rate — the aurora is anchored
    // to the field, not to the clouds, but it is anchored to *something* that
    // rotates, and a ring pinned to the camera instead would be the single
    // most obvious tell that this is a shader.
    float lonAur = lon0 + uRotation * uDiffPole;
    // Structure as a function of longitude, embedded on a circle so it closes
    // at the seam the way flowPoint's own coordinates do. uAuroraDrift is the
    // only time input: it walks the third axis, so the curtain's shape
    // changes without the ring's overall brightness ever moving as one — the
    // difference between weather and a throb, and §4.1 permits only the first.
    float curtain = 0.35 + 0.65 * (fbm3(vec3(cos(lonAur), sin(lonAur), uAuroraDrift) * uAuroraDetail) * 0.5 + 0.5);
    float night = smoothstepc(0.30, -0.25, ndlRaw);
    // Brighter at the limb: an auroral curtain seen edge-on is a long column
    // of emission and seen face-on is a thin sheet, which is why every
    // photograph of one from orbit shows the ring brightest where it crosses
    // the horizon.
    float edgeOn = 0.5 + 0.5 * (1.0 - facing);
    vec3 auroraTint = mix(uLightColor, uAuroraColor, uAuroraShift);
    color += auroraTint * (auroraBand * curtain * night * edgeOn * uAuroraStrength);
  }

  gl_FragColor = vec4(color, 1.0);
}
`;

/**
 * One hero gas giant. There is exactly one in the scene, added once in
 * `main.ts` — `docs/environment.md` §6 stage 1 is deliberately one body and
 * nothing else, unchanged by this rebuild.
 */
export class GasGiant {
  readonly object = Object.assign(new Group(), { name: "gas-giant" });

  /** The lit surface. Public so a harness can read its geometry and material
   * directly rather than through an indirection this class would otherwise
   * have to invent just to be testable. */
  body: Mesh | null = null;
  /** The additive limb shell. Same visibility, same reason. */
  limb: Mesh | null = null;

  private key = "";
  /** Where the body sits before the leash. */
  private readonly anchor = new Vector3();

  /**
   * Rebuild for a sector, if it is not already the one standing. `light` is
   * the sector's own `SectorLight` — `main.ts` computes it once per sector
   * change (the same cache key this method uses) and hands it straight
   * through, so there is still exactly one place that rolls a sector's star.
   */
  show(seed: number, sector: number, light: SectorLight): void {
    const key = `${seed}:${sector}`;
    if (key === this.key) return;
    this.key = key;
    this.clear();

    // A hash mix distinct from `planPlanet`'s, `planFixture`'s and
    // `planLight`'s own — reusing any of theirs would correlate the giant's
    // look with another sector feature.
    const rng = makeRng((seed * 3628273133 + sector * 2308142839 + 97354729) >>> 0);

    const hue = GIANT.baseHueMin + rng.next() * (GIANT.baseHueMax - GIANT.baseHueMin);
    // Item 7: the starting spin used to be `body.rotation.y`, seeded so the
    // same sector does not always present the same face; now it seeds
    // `uRotation` instead, since the mesh itself never rotates any more —
    // see `update`'s own comment for why advancing the sample coordinate
    // replaced advancing the mesh.
    const rotation0 = rng.next() * Math.PI * 2;
    const jetFreq = GIANT.jetFreqMin + rng.next() * (GIANT.jetFreqMax - GIANT.jetFreqMin);
    const jetPhase = rng.next() * Math.PI * 2;
    const shearAmp = GIANT.shearAmpMin + rng.next() * (GIANT.shearAmpMax - GIANT.shearAmpMin);
    // The storm's own centre — full longitude range, latitude kept inside
    // `stormLatRange` so it never has to fight the polar blend for the same
    // pixels (see `GIANT.stormLatRange`'s own comment).
    const stormLon = (rng.next() * 2 - 1) * Math.PI;
    const stormLat = (rng.next() * 2 - 1) * GIANT.stormLatRange;
    // The white oval, deliberately in the *opposite* hemisphere from the red
    // storm and outside its own latitude range, so the two features never
    // land on top of each other however the rolls fall. Two storms sharing a
    // patch of disc would not merely look wrong, they would cancel: each one
    // bends the sampling coordinate, and a coordinate bent twice around two
    // centres is noise.
    const ovalLon = (rng.next() * 2 - 1) * Math.PI;
    const ovalSide = stormLat >= 0 ? -1 : 1;
    const ovalLat = ovalSide * (GIANT.ovalLatMin + rng.next() * (GIANT.ovalLatMax - GIANT.ovalLatMin));

    const geometry = new SphereGeometry(GIANT.radius, GIANT.widthSegments, GIANT.heightSegments);

    // `sun.target` in `main.ts` is always the origin, so a real
    // `DirectionalLight`'s illumination direction is `position` alone,
    // normalised — this reuses that exact direction rather than recomputing
    // one relative to the body's own (leashed, moving) position, which would
    // disagree with the scene's own light by an amount too small to matter
    // and too easy to get subtly wrong.
    const lightDir = light.position.clone().normalize();

    this.body = new Mesh(
      geometry,
      new ShaderMaterial({
        uniforms: {
          uHue: { value: hue },
          uRotation: { value: rotation0 },
          uFlowScale: { value: GIANT.flowScale },
          uLatStretch: { value: GIANT.latStretch },
          uWarpStrength: { value: GIANT.warpStrength },
          uFlowContrast: { value: GIANT.flowContrast },
          uJetFreq: { value: jetFreq },
          uJetPhase: { value: jetPhase },
          uShearAmp: { value: shearAmp },
          uDiffPole: { value: GIANT.diffPole },
          uJetDrift: { value: GIANT.jetDrift },
          uEdgeEpsilon: { value: GIANT.edgeEpsilon },
          uEdgeGain: { value: GIANT.edgeGain },
          uEdgeLow: { value: GIANT.edgeLow },
          uEdgeHigh: { value: GIANT.edgeHigh },
          uEdgeMix: { value: GIANT.edgeMix },
          uBrightHue: { value: GIANT.brightHueOffset },
          uBrightSaturation: { value: GIANT.brightSaturation },
          uBrightLightness: { value: GIANT.brightLightness },
          uZoneHue: { value: GIANT.zoneHueOffset },
          uZoneSaturation: { value: GIANT.zoneSaturation },
          uZoneLightness: { value: GIANT.zoneLightness },
          uMidHue: { value: GIANT.midHueOffset },
          uMidSaturation: { value: GIANT.midSaturation },
          uMidLightness: { value: GIANT.midLightness },
          uBeltHue: { value: GIANT.beltHueOffset },
          uBeltSaturation: { value: GIANT.beltSaturation },
          uBeltLightness: { value: GIANT.beltLightness },
          uDarkBeltHue: { value: GIANT.darkBeltHueOffset },
          uDarkBeltSaturation: { value: GIANT.darkBeltSaturation },
          uDarkBeltLightness: { value: GIANT.darkBeltLightness },
          uDeepHue: { value: GIANT.deepHueOffset },
          uDeepSaturation: { value: GIANT.deepSaturation },
          uDeepLightness: { value: GIANT.deepLightness },
          uStreamerHue: { value: GIANT.streamerHue },
          uStreamerSaturation: { value: GIANT.streamerSaturation },
          uStreamerLightness: { value: GIANT.streamerLightness },
          uStormLon: { value: stormLon },
          uStormLat: { value: stormLat },
          uStormHalfLon: { value: GIANT.stormHalfLon },
          uStormHalfLat: { value: GIANT.stormHalfLat },
          uVortexStrength: { value: GIANT.vortexStrength },
          // Seeded, not zero — two sectors' storms should not all be caught
          // mid-turn at the same angle, the same reason `rotation0` exists.
          uVortexPhase: { value: rng.next() * Math.PI * 2 },
          uStormHue: { value: GIANT.stormHueOffset },
          uStormSaturation: { value: GIANT.stormSaturation },
          uStormLightness: { value: GIANT.stormLightness },
          uOvalLon: { value: ovalLon },
          uOvalLat: { value: ovalLat },
          uOvalHalfLon: { value: GIANT.ovalHalfLon },
          uOvalHalfLat: { value: GIANT.ovalHalfLat },
          uOvalVortex: { value: GIANT.ovalVortex },
          uOvalPhase: { value: rng.next() * Math.PI * 2 },
          uOvalHue: { value: GIANT.ovalHueOffset },
          uOvalSaturation: { value: GIANT.ovalSaturation },
          uOvalLightness: { value: GIANT.ovalLightness },
          uPoleThreshold: { value: GIANT.poleThreshold },
          uPoleBlendWidth: { value: GIANT.poleBlendWidth },
          uPoleHue: { value: GIANT.poleHue },
          uPoleSaturation: { value: GIANT.poleSaturation },
          uPoleLightness: { value: GIANT.poleLightness },
          uLightDirWorld: { value: lightDir },
          uLightColor: { value: light.colour.clone() },
          uAmbientFloor: { value: GIANT.ambientFloor },
          uLimbDarkFloor: { value: GIANT.limbDarkFloor },
          uLimbDarkPower: { value: GIANT.limbDarkPower },
          uScatterStrength: { value: GIANT.scatterStrength },
          uScatterPower: { value: GIANT.scatterPower },
          uTerminatorGlow: { value: GIANT.terminatorGlow },
          uTerminatorWidth: { value: GIANT.terminatorWidth },
          uSunsetColor: { value: new Vector3(GIANT.sunsetR, GIANT.sunsetG, GIANT.sunsetB) },
          uLimbAsymmetry: { value: GIANT.limbAsymmetry },
          uAuroraLat: { value: GIANT.auroraLat },
          uAuroraWidth: { value: GIANT.auroraWidth },
          uAuroraStrength: { value: GIANT.auroraStrength },
          uAuroraDetail: { value: GIANT.auroraDetail },
          // Seeded so two sectors' curtains are not the same curtain; advanced
          // by `update` from there.
          uAuroraDrift: { value: rng.next() * 40 },
          uAuroraColor: { value: new Vector3(GIANT.auroraR, GIANT.auroraG, GIANT.auroraB) },
          uAuroraShift: { value: GIANT.auroraShift },
        },
        vertexShader: BODY_VERTEX,
        fragmentShader: BODY_FRAGMENT,
        // The body lives 640-1160 units out — well past `Stage`'s 260-unit
        // fog far plane. Without this the whole mesh fades toward the
        // scene's black fog colour and a solid, lit sphere disappears the
        // same way an additive stroke used to. A hand-written shader also
        // gets no automatic fog unless it opts in, so this is the one
        // property doing both jobs at once. See `VectorObject`'s own header;
        // this is the same trap, hit a third time on a third material family.
        fog: false,
      }),
    );
    // Below the ships and below `Planet`'s own render order — this body is
    // further out and larger, so it should lose any coincident overlap to
    // everything nearer.
    this.body.renderOrder = -1.98;

    this.limb = new Mesh(
      new SphereGeometry(
        GIANT.radius * GIANT.limbScale,
        Math.max(24, Math.floor(GIANT.widthSegments / 2)),
        Math.max(16, Math.floor(GIANT.heightSegments / 2)),
      ),
      new ShaderMaterial({
        uniforms: {
          // The shell's *daylight* tint is now a cool blue-white rather than
          // the body's own hue: `haloColor` above described a halo that glowed
          // the same colour everywhere, and a lit haze layer seen from outside
          // is not the colour of the cloud deck underneath it. The body's hue
          // still reaches the shell — through `uLightColor`, and through the
          // fact that the shell only ever appears against the body's own
          // silhouette.
          uGlowColor: { value: new Vector3(GIANT.limbDayR, GIANT.limbDayG, GIANT.limbDayB) },
          uSunsetColor: { value: new Vector3(GIANT.sunsetR, GIANT.sunsetG, GIANT.sunsetB) },
          uLightColor: { value: light.colour.clone() },
          uLightDirWorld: { value: lightDir },
          uPower: { value: GIANT.limbPower },
          uIntensity: { value: GIANT.limbIntensity },
          uForward: { value: GIANT.limbForward },
          uAsymmetry: { value: GIANT.limbAsymmetry },
          uSunsetWidth: { value: GIANT.limbSunsetWidth },
        },
        vertexShader: LIMB_VERTEX,
        fragmentShader: LIMB_FRAGMENT,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        // Tested and load-bearing, not a default left alone: with this off,
        // `limb` draws its whole disc rather than only the sliver past
        // `body`'s own silhouette that depth-testing against it produces.
        depthTest: true,
        side: FrontSide,
        // A hand-written shader gets no automatic fog unless it opts in —
        // this one never does, which is the same exemption `fog: false`
        // above spends a property to state explicitly.
        fog: false,
      }),
    );
    // Child of `body` so it inherits the same rigid rotation for free —
    // the shader's own fresnel term depends only on the normal and the view
    // direction, both recomputed every frame regardless of orientation, so
    // there is nothing to keep in sync by parenting it here instead of
    // beside it.
    this.body.add(this.limb);
    this.object.add(this.body);

    // Fixed bearing 0 (+Z, dead ahead of spawn heading) — unchanged from the
    // stroke build: this body is stage 1 of `docs/environment.md` §6,
    // "the owner looks at it before anything is planned around it," and a
    // prototype that might roll behind the player at the moment someone
    // presses a key to check it would be testing nothing.
    this.anchor.set(0, GIANT.height, GIANT.range);
    this.object.position.copy(this.anchor);
  }

  /** Hold station if the player has come too close — unchanged leash logic
   * from the stroke build and from `Planet.ts` before it. */
  follow(player: Vector3): void {
    if (!this.body) return;
    const dx = this.anchor.x - player.x;
    const dz = this.anchor.z - player.z;
    const flat = Math.hypot(dx, dz);
    if (flat >= GIANT.minRange || flat < 1e-3) {
      this.object.position.copy(this.anchor);
    } else {
      const push = GIANT.minRange / flat;
      this.object.position.set(player.x + dx * push, GIANT.height, player.z + dz * push);
    }
  }

  /** Axial rotation, §3.6 — item 7's own choice of mechanism. The mesh
   * itself never turns any more; `uRotation` advances instead and is added
   * to `lon` at the top of the fragment shader, which is "cheaper and
   * better than rotating the mesh": cheaper because nothing downstream of
   * the vertex stage (the limb's own fresnel term, `body`'s normal matrix)
   * has to recompute anything a static mesh wasn't already giving it for
   * free, and better because it is the literal thing being asked for — the
   * *clouds* rotate, not the geometry underneath them, which is the more
   * accurate picture for a gas giant whose visible "surface" is weather,
   * not a solid crust moving with it. */
  update(dt: number): void {
    if (!this.body) return;
    const material = this.body.material as ShaderMaterial;
    material.uniforms.uRotation.value += GIANT.rotationRate * dt;
    // The three clocks the fourth pass added, all `dt`-driven for the house
    // rule's own reason and all wrapped rather than left to grow. `uRotation`
    // is *not* wrapped and does not want to be: it is deliberately unbounded
    // because the differential rate multiplies it, so wrapping it would snap
    // every latitude's accumulated offset back into agreement at once and
    // erase the shear the whole mechanism exists to build. These three are
    // pure phases, used only inside a `cos`/`sin` or a noise lookup, so
    // wrapping is free and keeps float precision from degrading over a long
    // session — a phase at 1e5 radians resolves to about a hundredth of a
    // turn in a float32 uniform, which reads as the storm juddering.
    material.uniforms.uVortexPhase.value = (material.uniforms.uVortexPhase.value + GIANT.vortexSpinRate * dt) % TAU;
    material.uniforms.uOvalPhase.value = (material.uniforms.uOvalPhase.value + GIANT.ovalSpinRate * dt) % TAU;
    // The aurora's drift walks a noise axis rather than an angle, so it has no
    // natural period; 1024 is an arbitrary large multiple of the noise
    // lattice's own unit spacing, which makes the wrap invisible.
    material.uniforms.uAuroraDrift.value = (material.uniforms.uAuroraDrift.value + GIANT.auroraDriftRate * dt) % 1024;
  }

  /** Empty the group and forget the sector, so the next `show` rebuilds. */
  hide(): void {
    if (this.key === "") return;
    this.key = "";
    this.clear();
  }

  /** Torn down on a sector change, the same moment `Planet.clear` and
   * `Comet.clear` are. */
  clear(): void {
    if (this.limb) {
      this.limb.geometry.dispose();
      (this.limb.material as ShaderMaterial).dispose();
    }
    if (this.body) {
      this.body.geometry.dispose();
      (this.body.material as ShaderMaterial).dispose();
    }
    this.body = null;
    this.limb = null;
    for (const child of [...this.object.children]) this.object.remove(child);
  }
}
