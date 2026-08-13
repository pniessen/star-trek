import {
  AdditiveBlending,
  Color,
  FrontSide,
  Group,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from "three";
import { makeRng } from "../chart/rng.js";
import type { SectorLight } from "./light.js";

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
  /** Radians per second the body turns. First-draft, unflown, same species as
   * every other constant here — on the tuning list once there is something on
   * screen to judge it against. */
  rotationRate: 0.035,

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
  // The owner lifted every hue/saturation constraint for this body — §4.1's
  // "genuinely orange Jupiter" carve-out already exempted celestial bodies
  // from the strokes' palette rule, and this task removed the narrower
  // constraint the swatch build had additionally imposed on itself (a tight
  // hue band, to close off a magenta roll that once collided with the
  // Shroud's own colour). What is below is now a *choice*, sampled from
  // `01_full-disc_belts-zones_PIA04866_cassini.jpg` and
  // `03_belt-zone-boundary_closeup_PIA00574_galileo.jpg` rather than derived
  // from a rule: warm cream zones, rust-to-brown belts, a cooler grey-blue
  // at both the poles and the belt/zone boundary itself — because that is
  // what a gas giant actually looks like, not because anything requires it.

  /** The body's hue anchor, degrees, still rolled per sector — kept in the
   * same warm range the swatch build used, now because the reference is
   * warm, not because a wider roll is forbidden. */
  baseHueMin: 24,
  baseHueMax: 46,
  /** Four colour stops the flow value `t` (see `flow` in `BODY_FRAGMENT`) is
   * ramped across, each an offset from `uHue` plus its own saturation and
   * lightness — pale cream zone, warm tan transition, rust belt, deep
   * brown-red belt. This is the same "drama is in value, not hue" reading
   * the Cassini reference gave the swatch build, expressed as a continuous
   * ramp over a *continuous* field instead of a discrete lookup over a
   * discrete one — the mechanism that made bands read as stripes no matter
   * how the stops were tuned. */
  zoneHueOffset: 8,
  zoneSaturation: 0.16,
  /** Held below the swatch build's own 0.88-0.9 — `Stage.ts`'s bloom fires
   * above a luminance of 0.5 (`UnrealBloomPass`'s own threshold, tuned for
   * traces and never touched by this file), and a lightness this close to 1
   * pushes most of the sunlit hemisphere over that line at once, which
   * blooms the whole disc into a flat wash and erases the very texture item
   * 1-4 exist to add. The swatch build never hit this because its bands were
   * uniform patches large enough to still read as banded even blurred; a
   * continuous noise field has no such patches to fall back on. */
  zoneLightness: 0.8,
  midHueOffset: 3,
  midSaturation: 0.3,
  midLightness: 0.56,
  beltHueOffset: -4,
  beltSaturation: 0.44,
  beltLightness: 0.44,
  deepHueOffset: -10,
  deepSaturation: 0.36,
  deepLightness: 0.22,
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
  /** Displacement strength in the domain warp (`flow`'s three nested `fbm3`
   * calls) — the brief's own "displace the noise sample position by another
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
  /** The storm's own hue offset from `uHue`, saturation and lightness — a
   * distinct warm rust-orange, the one place on the disc allowed to read as
   * a single named feature rather than a texture. */
  stormHueOffset: -22,
  stormSaturation: 0.56,
  stormLightness: 0.4,

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
   * — muted, and darker than every zone stop, so the poles read as
   * "essentially bandless and dim" rather than as one more stripe. */
  poleSaturation: 0.14,
  poleLightness: 0.38,

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

  // ── the limb halo (§3.2, "bloom is the atmosphere") ───────────────────────

  /** `limb`'s radius as a multiple of `body`'s. */
  limbScale: 1.03,
  /** Fresnel exponent — higher pulls the glow tighter to the true silhouette. */
  limbPower: 2.6,
  /** Brightness multiplier at full fresnel, before bloom's own threshold.
   * Above 1 on purpose — this is the one place on the body meant to cross
   * it, the mechanism behind "phosphorescent" in the brief. */
  limbIntensity: 1.7,
} as const;

/**
 * `limb`'s own material. A minimal fresnel shader rather than a stock
 * material — nothing in three.js's built-in roster multiplies by
 * `1 - dot(normal, viewDir)`, and that term is the entire effect. Computed in
 * view space so it needs no world-space camera position passed in, and reads
 * as "dim at centre, bright at the true edge" without depending on anything
 * this class tracks between frames.
 */
const LIMB_VERTEX = `
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewDir = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const LIMB_FRAGMENT = `
uniform vec3 glowColor;
uniform float power;
uniform float intensity;
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
  float facing = max(dot(normalize(vNormal), normalize(vViewDir)), 0.0);
  float fresnel = pow(1.0 - facing, power);
  gl_FragColor = vec4(glowColor * intensity * fresnel, fresnel);
}
`;

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
 * `body`'s fragment shader. A plain template string now, not a builder
 * function — the swatch build's `buildBodyFragment` existed to stringify
 * `GIANT.zoneSwatches`/`beltSwatches` into compile-time array literals so a
 * strict GLSL ES loop bound would accept them; nothing here loops over a
 * per-sector-sized list any more; every `GIANT` number reaches the shader as
 * an ordinary uniform, set once per `show()` the same way the light and pole
 * constants always were.
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
uniform float uEdgeEpsilon;
uniform float uEdgeGain;
uniform float uEdgeLow;
uniform float uEdgeHigh;
uniform float uEdgeMix;
uniform float uZoneHue;
uniform float uZoneSaturation;
uniform float uZoneLightness;
uniform float uMidHue;
uniform float uMidSaturation;
uniform float uMidLightness;
uniform float uBeltHue;
uniform float uBeltSaturation;
uniform float uBeltLightness;
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
uniform float uStormHue;
uniform float uStormSaturation;
uniform float uStormLightness;
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

varying vec3 vObjectNormal;
varying vec3 vViewNormal;
varying vec3 vViewDir;
varying vec3 vLightDirView;

float hueFrac(float hDeg) {
  return mod(mod(hDeg, 360.0) + 360.0, 360.0) / 360.0;
}

vec3 hsl2rgb(float h, float s, float l) {
  float c = (1.0 - abs(2.0 * l - 1.0)) * s;
  float x = c * (1.0 - abs(mod(h * 6.0, 2.0) - 1.0));
  float m = l - c * 0.5;
  vec3 rgb;
  if (h < 1.0 / 6.0) rgb = vec3(c, x, 0.0);
  else if (h < 2.0 / 6.0) rgb = vec3(x, c, 0.0);
  else if (h < 3.0 / 6.0) rgb = vec3(0.0, c, x);
  else if (h < 4.0 / 6.0) rgb = vec3(0.0, x, c);
  else if (h < 5.0 / 6.0) rgb = vec3(x, 0.0, c);
  else rgb = vec3(c, 0.0, x);
  return rgb + m;
}

float smoothstepc(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float wrapAngle(float a) {
  return mod(a + 3.14159265, 6.28318531) - 3.14159265;
}

/** Hash on an integer lattice point, three-dimensional rather than two —
 * flowPoint below embeds longitude on a unit circle (cos(lon),
 * sin(lon)) before it ever reaches here, so the flow field is periodic
 * across the lon = ±π seam by construction. The swatch build's own
 * boundary harmonics had to stay integer-frequency for the same closure;
 * embedding on a circle buys the same seamlessness without constraining
 * every frequency in this shader to an integer. */
float hash31(vec3 p) {
  p = fract(p * vec3(127.1, 311.7, 74.7));
  p += dot(p, p.yzx + 34.45);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);
  return mix(nxy0, nxy1, u.z);
}

/** Four octaves, each half the amplitude and twice the frequency of the
 * last — item 1's own recipe, held to four rather than the usual five or
 * six because flow below evaluates this three times per fragment (once
 * per warp level) and a fifth octave buys detail this body's screen size
 * never keeps past the bloom pass. */
float fbm3(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 4; i++) {
    sum += amp * (noise3(p * freq) * 2.0 - 1.0);
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum;
}

/** Domain warping — item 4, fbm(p + fbm(p + fbm(p))) literally: each
 * nested call displaces the next along all three axes by the same scalar,
 * which is what turns a smooth gradient into curls and festoons instead of
 * a blob. Three nested fbm3 calls rather than the more usual
 * vector-valued warp (a vec2/vec3 built from two or three extra fbm3
 * evaluations per level) — this is the same picture at roughly a third of
 * the cost, and at a sphere's worth of fragments the cost is what capped
 * the octave count above, not visual quality. */
float flow(vec3 p) {
  float a = fbm3(p);
  float b = fbm3(p + uWarpStrength * a + vec3(3.1, 1.7, 5.9));
  float c = fbm3(p + uWarpStrength * b + vec3(7.2, 4.1, 2.3));
  return c;
}

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
  float lon = atan(n.x, n.z) + uRotation;
  float latNorm = clamp(lat / 1.5707963, -0.9999, 0.9999);
  float absLat = abs(latNorm);

  // Shear — item 3: alternating jet direction per latitude band, offset
  // straight into the longitude the flow field samples at. Two adjacent
  // bands now read the field from different, sliding offsets and disagree
  // exactly where they meet, which is what tears a boundary instead of
  // merely bending it.
  float jet = sin(lat * uJetFreq + uJetPhase);
  float shearedLon = lon + jet * uShearAmp;

  // The storm — item 5: bend the *sampling coordinate* rotationally around
  // its own centre before the flow field ever sees it, rather than draw an
  // oval and stop. The surrounding bands' own texture spirals into the
  // distortion the way real weather wraps around a vortex, instead of a
  // patch of different-coloured noise sitting on top like a sticker.
  float dLon = wrapAngle(lon - uStormLon);
  float dLat = lat - uStormLat;
  vec2 rel = vec2(dLon / uStormHalfLon, dLat / uStormHalfLat);
  float stormR = length(rel);
  float vortexT = smoothstepc(1.3, 0.0, stormR);
  float ang = vortexT * uVortexStrength;
  float ca = cos(ang);
  float sa = sin(ang);
  vec2 relRot = vec2(rel.x * ca - rel.y * sa, rel.x * sa + rel.y * ca);
  float lonEff = mix(shearedLon, uStormLon + relRot.x * uStormHalfLon, vortexT);
  float latEff = mix(lat, uStormLat + relRot.y * uStormHalfLat, vortexT);

  vec3 p = flowPoint(lonEff, latEff);
  float f = flow(p);

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

  float t = clamp(f * uFlowContrast * 0.5 + 0.5, 0.0, 1.0);
  vec3 stopZone = hsl2rgb(hueFrac(uHue + uZoneHue), uZoneSaturation, uZoneLightness);
  vec3 stopMid = hsl2rgb(hueFrac(uHue + uMidHue), uMidSaturation, uMidLightness);
  vec3 stopBelt = hsl2rgb(hueFrac(uHue + uBeltHue), uBeltSaturation, uBeltLightness);
  vec3 stopDeep = hsl2rgb(hueFrac(uHue + uDeepHue), uDeepSaturation, uDeepLightness);
  vec3 albedo;
  if (t < 0.4) albedo = mix(stopZone, stopMid, smoothstepc(0.0, 0.4, t));
  else if (t < 0.7) albedo = mix(stopMid, stopBelt, smoothstepc(0.4, 0.7, t));
  else albedo = mix(stopBelt, stopDeep, smoothstepc(0.7, 1.0, t));

  vec3 streamer = hsl2rgb(hueFrac(uStreamerHue), uStreamerSaturation, uStreamerLightness);
  albedo = mix(albedo, streamer, edge * uEdgeMix);

  vec3 stormColor = hsl2rgb(hueFrac(uHue + uStormHue), uStormSaturation, uStormLightness);
  albedo = mix(albedo, stormColor, vortexT * 0.85);

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
  float ndotl = max(dot(wn, ld), 0.0);
  float lit = uAmbientFloor + (1.0 - uAmbientFloor) * ndotl;

  // Limb darkening: a *view*-angle falloff, independent of the light — the
  // Cassini reference's own edge dimming, which reads as roundness even
  // where the terminator is nowhere near.
  vec3 vd = normalize(vViewDir);
  float facing = max(dot(wn, vd), 0.0);
  float limbDark = mix(uLimbDarkFloor, 1.0, pow(facing, uLimbDarkPower));

  vec3 color = albedo * uLightColor * lit * limbDark;

  // A thin scattering falloff toward the true silhouette, on top of (not
  // instead of) the terminator above — item 6's second half. Tinted rather
  // than merely dimmed, the way a real atmosphere's Rayleigh scattering
  // brightens and cools the limb instead of only darkening it.
  float scatter = pow(1.0 - facing, uScatterPower) * uScatterStrength;
  color = mix(color, vec3(0.68, 0.78, 0.88) * uLightColor, scatter);

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
          uEdgeEpsilon: { value: GIANT.edgeEpsilon },
          uEdgeGain: { value: GIANT.edgeGain },
          uEdgeLow: { value: GIANT.edgeLow },
          uEdgeHigh: { value: GIANT.edgeHigh },
          uEdgeMix: { value: GIANT.edgeMix },
          uZoneHue: { value: GIANT.zoneHueOffset },
          uZoneSaturation: { value: GIANT.zoneSaturation },
          uZoneLightness: { value: GIANT.zoneLightness },
          uMidHue: { value: GIANT.midHueOffset },
          uMidSaturation: { value: GIANT.midSaturation },
          uMidLightness: { value: GIANT.midLightness },
          uBeltHue: { value: GIANT.beltHueOffset },
          uBeltSaturation: { value: GIANT.beltSaturation },
          uBeltLightness: { value: GIANT.beltLightness },
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
          uStormHue: { value: GIANT.stormHueOffset },
          uStormSaturation: { value: GIANT.stormSaturation },
          uStormLightness: { value: GIANT.stormLightness },
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

    const haloColor = new Color().setHSL(
      hue / 360,
      Math.min(0.5, GIANT.beltSaturation + 0.1),
      0.74,
      SRGBColorSpace,
    );
    this.limb = new Mesh(
      new SphereGeometry(
        GIANT.radius * GIANT.limbScale,
        Math.max(24, Math.floor(GIANT.widthSegments / 2)),
        Math.max(16, Math.floor(GIANT.heightSegments / 2)),
      ),
      new ShaderMaterial({
        uniforms: {
          glowColor: { value: haloColor },
          power: { value: GIANT.limbPower },
          intensity: { value: GIANT.limbIntensity },
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
