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
  Vector4,
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

  // ── colour (§4.1, "a genuinely orange Jupiter" — never the Shroud's) ─────

  /** The body's hue anchor, degrees. Narrow rather than the full wheel for
   * the reason the swatch lists below inherit unchanged from the stroke
   * build: an unconstrained roll once put this body on `PALETTE.magenta`,
   * the Shroud's own hue, and closing the whole class of mistake beats
   * re-rolling and hoping. */
  baseHueMin: 24,
  baseHueMax: 46,
  /**
   * Two swatch families, not one weighted list — the Cassini reference this
   * task's brief was checked against says the drama is *only* in value, not
   * hue: pale cream zones against distinctly darker rust belts, both muted.
   * `show` alternates strictly between these two families by band parity
   * (see `BODY_FRAGMENT`'s own comment on why parity, not a hash, decides
   * which family a band belongs to) — a hash-picked family per band, the
   * vertex-colour build's approach, could roll two adjacent bands from the
   * *same* family and erase the one contrast the brief says is missing.
   * Every `saturation` here still sits under the hull roster's own floor
   * (`PALETTE.lance` ≈0.61), and the lightness gap between the two families
   * — roughly 0.35 at its narrowest — is the single number doing the most
   * work in this file.
   */
  zoneSwatches: [
    { hueOffset: 9, saturation: 0.1, lightness: 0.88 }, // pale cream — the broad equatorial zone
    { hueOffset: 4, saturation: 0.16, lightness: 0.78 }, // warm cream-gold — the paler flank zones
  ],
  beltSwatches: [
    { hueOffset: 0, saturation: 0.3, lightness: 0.42 }, // ochre-tan belt
    { hueOffset: -12, saturation: 0.36, lightness: 0.3 }, // rust belt
    { hueOffset: -18, saturation: 0.22, lightness: 0.18 }, // deep brown-red belt
  ],

  // ── banding (§3.3, "broad alternating zones and belts") ──────────────────

  /** How many alternating bands span the whole body pole to pole, seeded per
   * sector within this range — "roughly 8-12 across the disc" per the brief,
   * rolled rather than fixed so sector to sector variety survives the
   * rebuild the way it did in the stroke version's belt count. */
  bandCountMin: 8,
  bandCountMax: 12,
  /** Upper bound the shader's boundary table is sized for — `bandCountMax`
   * plus headroom, not `bandCountMax` itself, so the array literal in
   * `BODY_FRAGMENT` never has to change if the roll range above does. */
  maxBands: 14,
  /**
   * How much extra boundary weight a band gets for sitting near the equator
   * versus near a pole, before the roll below adds per-band jitter on top —
   * the mechanism behind "not even stripes: a broad pale equatorial zone,
   * narrower belts flanking it." 0 would give every band the same expected
   * width; this is a bonus of up to `equatorialWidthBoost` at the exact
   * equator, fading to none at the poles.
   *
   * This widens whichever band sits at the equator, zone or belt — it does
   * not by itself decide which. `show`'s own `eqIdx` is what decides that
   * one: a first version numbered bands south-pole-to-north and alternated
   * family by that raw index, so roughly half the seeds this rolled put the
   * *widened* band at the belt, not the zone — a broad, dark, high-contrast
   * band sitting right across the equator, the opposite of "a broad pale
   * equatorial zone." `eqIdx` re-anchors the alternation at whichever band
   * actually contains latitude zero, forcing *that* band to be a zone always
   * and letting belts and zones alternate outward from it in both
   * directions — the width bonus above and the family guarantee below now
   * agree about which band they are both talking about.
   */
  equatorialWidthBoost: 1.8,
  /** Absolute latitude (0-1, fraction of a right angle) past which the band
   * signal starts blending into the mottled polar cap. */
  poleThreshold: 0.74,
  /** How much further latitude the blend above takes to reach full strength. */
  poleBlendWidth: 0.16,
  /** The cap's own hue, fixed rather than relative to the body's base hue —
   * the reference's poles read grey-blue regardless of the warm hue family
   * the zones and belts are drawn from, so this is an absolute degree value,
   * the one hue constant in the file that is not an offset from `baseHue`. */
  poleHue: 205,
  /** The cap's own saturation and lightness once the blend above is complete
   * — muted, and darker than either swatch family (`poleLightness` sits below
   * every belt but the deepest one), so the poles read as "essentially
   * bandless and dim" rather than as one more stripe. */
  poleSaturation: 0.14,
  poleLightness: 0.38,

  /**
   * Two low, integer harmonics of longitude that displace a band boundary's
   * effective latitude — "a slight tilt" made organic rather than straight.
   * Integer on purpose: a non-integer harmonic would not close over the
   * longitude seam, leaving a visible mismatch at `lon = ±π` where the sphere
   * wraps.
   */
  boundaryWaveFreq1: 3,
  boundaryWaveFreq2: 7,
  /**
   * The two harmonics' amplitudes, as a *fraction of the narrowest band gap
   * actually rolled this sector* rather than a fixed number — `show` scales
   * these by the tightest boundary spacing its own boundary table produced,
   * which is what turns "keep the perturbation small enough that a band
   * never crosses into its neighbour" (the brief's own wording) into a
   * guarantee: a fixed amplitude could exceed a narrow belt rolled thin by
   * `equatorialWidthBoost`'s own trade-off, and cross it.
   */
  boundaryWaveFrac1: 0.35,
  boundaryWaveFrac2: 0.15,

  /** How much the turbulence field (three summed sine octaves, seeded per
   * sector) perturbs a band's own hue and lightness. Deliberately small
   * relative to the gap between the two swatch families above — turbulence
   * modulates the swatch a pixel already belongs to; it never touches the
   * band index itself, which is what keeps it inside its own band by
   * construction rather than by tuning. */
  turbulenceHueAmp: 5,
  turbulenceLightAmp: 0.07,

  // ── lighting (§3.1, done per fragment instead of by `MeshStandardMaterial`) ─

  /** The floor `body`'s own Lambertian term is lifted to, out of a 0-1
   * `N·L` that would otherwise reach true zero on the night side — the same
   * shape of trade `render/light.ts`'s `STAR.floor` makes, but a deliberately
   * higher number and its own constant rather than that one reused. `STAR`
   * was tuned for a single job — keep a lit body's dark hemisphere from
   * vanishing into the background — and nothing else in the scene consumes
   * it yet, so there was no real "single source of truth" being served by
   * sharing it, only the appearance of one. Once bands were rendering
   * correctly (verified per-pixel: the boundary table and the zone/belt
   * lookup were both right) they still read as a smooth gradient, not
   * stripes, because `STAR.floor`'s 12:1 lit-to-dark ratio swings far
   * wider across one hemisphere than the roughly 2:1 lightness ratio
   * between a zone and a belt — the lighting term dominated the banding
   * term by an order of magnitude. This floor is what narrows that gap:
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
 * `body`'s vertex stage. Three varyings do three different jobs, and keeping
 * them separate is the point: `vObjectNormal` is passed through *before* any
 * transform, so the fragment stage's band lookup is a function of the mesh
 * alone and rides `body.rotation.y` around for free, exactly the way the old
 * baked vertex colours did. `vViewNormal` is the same normal *after* the
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
 * Builds `body`'s fragment shader, with the two swatch families and the
 * boundary-table size baked in as `#define`s and array literals rather than
 * left as uniforms — they are fixed at compile time once per sector-change
 * (a full `ShaderMaterial` rebuild already happens in `show`, the same cost
 * a uniform update would have been), and a `#define`d array bound satisfies
 * even the strictest GLSL ES loop-bound rule, which a uniform-sized loop
 * would not. `GIANT.zoneSwatches`/`beltSwatches` stay the single source of
 * truth — this only stringifies them, so the tuning list never has to touch
 * two places that happen to agree.
 */
function buildBodyFragment(): string {
  const swatchLiteral = (s: { hueOffset: number; saturation: number; lightness: number }): string =>
    `vec3(${s.hueOffset.toFixed(2)}, ${s.saturation.toFixed(4)}, ${s.lightness.toFixed(4)})`;
  const zoneList = GIANT.zoneSwatches.map(swatchLiteral).join(",\n    ");
  const beltList = GIANT.beltSwatches.map(swatchLiteral).join(",\n    ");

  return `
#define MAX_BANDS ${GIANT.maxBands}
#define ZONE_COUNT ${GIANT.zoneSwatches.length}
#define BELT_COUNT ${GIANT.beltSwatches.length}

uniform float uHue;
uniform int uBandCount;
uniform float uBoundaries[MAX_BANDS + 1];
uniform int uEquatorIdx;
uniform float uSwatchSalt;
uniform float uWaveSeed1;
uniform float uWaveSeed2;
uniform float uWaveFreq1;
uniform float uWaveFreq2;
uniform float uWaveAmp1;
uniform float uWaveAmp2;
uniform vec4 uOctaves[3];
uniform float uTurbHueAmp;
uniform float uTurbLightAmp;
uniform float uPoleThreshold;
uniform float uPoleBlendWidth;
uniform float uPoleHue;
uniform float uPoleSaturation;
uniform float uPoleLightness;
uniform vec3 uLightColor;
uniform float uAmbientFloor;
uniform float uLimbDarkFloor;
uniform float uLimbDarkPower;

varying vec3 vObjectNormal;
varying vec3 vViewNormal;
varying vec3 vViewDir;
varying vec3 vLightDirView;

const vec3 ZONE_SWATCH[ZONE_COUNT] = vec3[ZONE_COUNT](
    ${zoneList}
);
const vec3 BELT_SWATCH[BELT_COUNT] = vec3[BELT_COUNT](
    ${beltList}
);

/** A cheap, deterministic float from an integer band index and a per-sector
 * salt — a hash, not a draw off a sequential RNG, because a band's colour
 * has to be a pure function of *which band it is*, re-evaluated at every
 * pixel that band owns, not a value consumed once from a cursor. Same
 * formula the old vertex-colour build used, moved here unchanged. */
float hash1(float i, float salt) {
  float s = sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return fract(s);
}

float smoothstepc(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

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

void main() {
  vec3 n = normalize(vObjectNormal);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(n.x, n.z);
  float latNorm = clamp(lat / 1.5707963, -0.9999, 0.9999);
  float absLat = abs(latNorm);
  float cosLat = cos(lat);

  // Vanishes at the pole via cosLat — the same seam-avoidance the old
  // vertex-colour build needed, needed again here because the pole is one
  // point every value of lon maps to, and an un-faded term would disagree
  // with itself there.
  float wobble = cosLat * (
    uWaveAmp1 * sin(uWaveFreq1 * lon + uWaveSeed1) +
    uWaveAmp2 * sin(uWaveFreq2 * lon + uWaveSeed2)
  );
  float effLat = latNorm - wobble;

  // Counts how many boundaries effLat has passed — a compile-time-bounded
  // loop (MAX_BANDS is a #define, not a uniform), satisfying even the
  // strict GLSL ES loop rule, with the actual band count enforced by the
  // dynamic break rather than the loop's own static bound.
  int idx = 0;
  for (int i = 1; i <= MAX_BANDS; i++) {
    if (i > uBandCount) break;
    if (effLat >= uBoundaries[i]) idx = i; else break;
  }
  idx = min(idx, uBandCount - 1);

  // Strict parity, not a hash, decides zone-family versus belt-family —
  // see GIANT.zoneSwatches's own comment on why a hash-picked family per
  // band was rejected: neighbouring bands differ in index by exactly one,
  // so parity guarantees they never share a family, which is the one
  // contrast this whole rebuild exists to put back. Parity is measured from
  // uEquatorIdx, not from band 0 — GIANT.equatorialWidthBoost's own comment
  // is the record of why: numbering straight from the south pole let the
  // *belt* land on the widened equatorial band as often as the zone did,
  // which produced a wide, dark, high-contrast band sitting across the
  // equator on roughly half of all seeds — everything this shader does
  // right, aimed at the one band the brief needed to be pale. abs() first
  // because only the parity of the offset matters, and GLSL int division
  // truncates toward zero rather than flooring negative operands, which
  // would otherwise misclassify every band south of the equator.
  int rel = idx - uEquatorIdx;
  int arel = rel >= 0 ? rel : -rel;
  bool isZone = (arel - (arel / 2) * 2) == 0;
  float swatchR = hash1(float(idx), uSwatchSalt);
  vec3 swatch;
  if (isZone) {
    int si = clamp(int(floor(swatchR * float(ZONE_COUNT))), 0, ZONE_COUNT - 1);
    swatch = ZONE_SWATCH[si];
  } else {
    int si = clamp(int(floor(swatchR * float(BELT_COUNT))), 0, BELT_COUNT - 1);
    swatch = BELT_SWATCH[si];
  }

  // Each octave's longitude term is faded toward zero as cosLat shrinks,
  // the same pole-seam guard wobble uses above.
  float lonFade = min(1.0, cosLat * 6.0);
  float turb = 0.0;
  for (int i = 0; i < 3; i++) {
    turb += uOctaves[i].w * sin(uOctaves[i].x * lon * lonFade + uOctaves[i].y * lat + uOctaves[i].z);
  }

  float h = uHue + swatch.x + turb * uTurbHueAmp;
  float s = swatch.y;
  float l = swatch.z + turb * uTurbLightAmp;

  // Poles blend to a fixed grey-blue and drop the band signal entirely —
  // "the poles are darker, grey-blue, and bandless" — reusing turb as
  // mottling rather than banding once inside the blend, which is why it
  // fades out approaching the exact pole (lonFade above) instead of
  // producing a sharp, organised pattern there.
  float poleT = smoothstepc(uPoleThreshold, uPoleThreshold + uPoleBlendWidth, absLat);
  if (poleT > 0.0) {
    h = mix(h, uPoleHue, poleT);
    s = mix(s, uPoleSaturation, poleT);
    l = mix(l, uPoleLightness + turb * uTurbLightAmp * 1.5, poleT);
  }

  vec3 albedo = hsl2rgb(hueFrac(h), clamp(s, 0.0, 1.0), clamp(l, 0.0, 1.0));

  // Lighting: a hand-rolled Lambertian with a lifted floor — uAmbientFloor,
  // GIANT.ambientFloor's own constant, not render/light.ts's shadeAt-only
  // STAR.floor (see that constant's comment for why the two floors are not
  // the same trade) — instead of MeshStandardMaterial's PBR response, which
  // is what was muting the swatch colours in the first place.
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
  gl_FragColor = vec4(color, 1.0);
}
`;
}

const BODY_FRAGMENT = buildBodyFragment();

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
    const bandCount =
      GIANT.bandCountMin + Math.floor(rng.next() * (GIANT.bandCountMax - GIANT.bandCountMin + 1));
    const swatchSalt = rng.next() * 9973;
    const waveSeed1 = rng.next() * Math.PI * 2;
    const waveSeed2 = rng.next() * Math.PI * 2;
    const octaves = [0.5, 0.3, 0.2].map((amp) => ({
      lonFreq: 2 + Math.floor(rng.next() * 5),
      latFreq: 0.6 + rng.next() * 1.6,
      phase: rng.next() * Math.PI * 2,
      amp,
    }));

    // Variable-width boundaries — the Cassini reference this task's brief was
    // checked against is not an evenly-spaced flag: one broad pale zone
    // straddles the equator and the belts flanking it are narrower. A fixed
    // `phase = lat * bandCount` (the vertex-colour build's own approach)
    // could only ever produce a barcode; this bakes the width unevenness
    // into the boundary table itself, via `GIANT.equatorialWidthBoost`.
    const weights: number[] = [];
    for (let i = 0; i < bandCount; i++) {
      const centerFrac = (i + 0.5) / bandCount;
      const distFromEquator = Math.abs(centerFrac - 0.5) * 2;
      const equatorialBoost = 1 + GIANT.equatorialWidthBoost * (1 - distFromEquator) ** 2;
      weights.push((0.55 + rng.next() * 0.7) * equatorialBoost);
    }
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const boundaries = new Float32Array(GIANT.maxBands + 1).fill(2); // sentinel: past the north pole
    boundaries[0] = -1;
    let acc = -1;
    let minGap = Infinity;
    for (let i = 0; i < bandCount; i++) {
      const width = (weights[i] / totalWeight) * 2;
      acc += width;
      boundaries[i + 1] = i === bandCount - 1 ? 1 : acc;
      minGap = Math.min(minGap, width);
    }

    // The band that actually contains the equator — see
    // `GIANT.equatorialWidthBoost`'s own comment for why the shader measures
    // zone/belt parity from this index rather than from band 0. `boundaries`
    // is monotonic, so the last boundary at or below 0 marks it; `bandCount`
    // itself is the fallback for the (essentially unreachable, latNorm ∈
    // [-1,1) by construction) case where none is.
    let eqIdx = bandCount - 1;
    for (let i = 0; i < bandCount; i++) {
      if (boundaries[i] <= 0) eqIdx = i;
      else break;
    }

    // Wobble amplitude scales to the narrowest gap this sector actually
    // rolled — see `GIANT.boundaryWaveFrac1`'s own comment for why a fixed
    // amplitude was rejected.
    const wobbleAmp1 = GIANT.boundaryWaveFrac1 * minGap;
    const wobbleAmp2 = GIANT.boundaryWaveFrac2 * minGap;

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
          uBandCount: { value: bandCount },
          uBoundaries: { value: boundaries },
          uEquatorIdx: { value: eqIdx },
          uSwatchSalt: { value: swatchSalt },
          uWaveSeed1: { value: waveSeed1 },
          uWaveSeed2: { value: waveSeed2 },
          uWaveFreq1: { value: GIANT.boundaryWaveFreq1 },
          uWaveFreq2: { value: GIANT.boundaryWaveFreq2 },
          uWaveAmp1: { value: wobbleAmp1 },
          uWaveAmp2: { value: wobbleAmp2 },
          uOctaves: { value: octaves.map((o) => new Vector4(o.lonFreq, o.latFreq, o.phase, o.amp)) },
          uTurbHueAmp: { value: GIANT.turbulenceHueAmp },
          uTurbLightAmp: { value: GIANT.turbulenceLightAmp },
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
      Math.min(0.5, GIANT.beltSwatches[0].saturation + 0.1),
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
    // A seeded starting spin so the same sector does not always present the
    // same face.
    this.body.rotation.y = rng.next() * Math.PI * 2;
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

  /** Axial rotation, §3.6 — the whole mechanism the brief specifies:
   * `mesh.rotation.y += rate * dt`. Nothing else moves, because the banding
   * is a per-fragment lookup off the mesh's own (rotating) normal rather
   * than anything rebuilt frame to frame. */
  update(dt: number): void {
    if (!this.body) return;
    this.body.rotation.y += GIANT.rotationRate * dt;
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
