/**
 * The celestial bench — the GLSL every *lit body* wants and no noise function
 * can supply, sitting beside `render/shaders/noise.ts` in the same idiom and
 * for the same reason its header gives: a template literal interpolated into
 * another template literal is this project's include mechanism, and three
 * bodies each growing their own copy of `hsl2rgb` is exactly the accidental
 * divergence that file was extracted to stop.
 *
 * **Why a second file rather than more rungs in `noise.ts`.** That file is a
 * bench of *fields* — pure functions of a coordinate, knowing nothing about
 * light, geometry or colour. Everything here knows about all three: where the
 * star is, what a ring plane is, how a sphere occludes it. Mixing the two
 * would put "what shape is this noise" and "what is casting a shadow on what"
 * behind one import, and the first question is answered per body while the
 * second is answered per *scene*. Kept apart, `noise.ts` stays usable by a
 * body that draws no light at all (`Nebula`) and this stays usable by a body
 * that samples no noise at all.
 *
 * **Order matters**, the same way it does one file over: GLSL ES has no
 * forward declarations in practice, so `CELESTIAL_UTIL` must precede
 * `RING_PROFILE`, which must precede `CELESTIAL_SHADOWS`. `ringProfile`
 * additionally needs `noise3` (and therefore `hash31`) from `noise.ts` ahead
 * of it — it is the one rung here that reaches across to that bench, and it
 * takes the dependency rather than growing a fourth private hash.
 *
 * ---
 *
 * ## The two shadows
 *
 * `docs/environment.md` §3.1 makes the sector's one light the largest change
 * per unit of work in the whole environment redesign, and then spends it on
 * terminators alone — a body's own dark half. That is only the *first* thing
 * a real light buys. The second is that bodies shadow **each other**, and on a
 * ringed planet the two halves of that (ring on planet, planet on ring) are
 * the single image that says "an enormous object in real sunlight" faster than
 * any amount of surface detail: it is the Cassini signature and there is no
 * other way to fake it, because the shadow's *shape* is a function of the
 * light's angle, the ring's tilt and the body's radius all at once, and an eye
 * that has seen one photograph of Saturn knows when those three disagree.
 *
 * **Both are analytic, and neither needs a shadow map.** A shadow map is what
 * you reach for when the occluder is arbitrary geometry; here the occluder is
 * a flat annulus in one case and a sphere in the other, and both have a
 * closed-form ray test that is a handful of dot products. A depth pass would
 * cost a whole extra render of the body per frame, would quantise the ring's
 * fine structure to whatever resolution it was given, and would need its own
 * light camera kept in step with `render/light.ts` — three ongoing costs to
 * reproduce, worse, something two functions do exactly.
 *
 * The two functions are deliberately *not* symmetric in their softening.
 * `ringShadow` takes its softness from the ring's own optical depth — a ring's
 * shadow edge is soft because the ring is *thin and patchy*, not because the
 * star has an angular size — while `sphereShadow` takes an explicit penumbra
 * width, because a planet's shadow on its rings genuinely does soften with
 * distance from the body and nothing about the ring's density says so.
 */

import { HASH31, NOISE3 } from "./noise.js";

/**
 * The small shared vocabulary every body's fragment shader was writing for
 * itself: HSL to RGB, a clamped smoothstep, an angle wrap.
 *
 * `hsl2rgb` in particular is worth centralising rather than re-deriving,
 * because the palette arguments in `GasGiant.ts` are specified in HSL by
 * *contract* (`assertPaletteContract` checks saturations and lightnesses as
 * numbers, not as colours), and a second body writing a subtly different
 * conversion would make the same numbers mean different colours on two bodies
 * the same star is lighting.
 *
 * `smoothstepc` is not `smoothstep`: GLSL's own is undefined when `e0 > e1`,
 * and half the uses here deliberately run the edges backwards to get a
 * falling ramp (`smoothstepc(1.0, 0.88, u)`). The explicit clamp makes that
 * legal and is why every body already had a private copy of it.
 */
export const CELESTIAL_UTIL = /* glsl */ `
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

// Henyey-Greenstein, the one-parameter phase function every atmosphere
// renderer uses because it is the cheapest thing that has a *lobe*. g is the
// asymmetry: 0 scatters evenly, positive throws light forward. mu is the
// cosine of the angle between where the light was going and where it goes
// next, so mu = 1 is "straight on through".
//
// The lobe is the whole point and a Lambert term cannot express it. A real
// atmosphere is brightest when the star is *behind* it — the crescent moon's
// bright rim, Cassini's backlit Saturn — because forward scattering off haze
// is a factor of hundreds stronger than sideways scattering. At g = 0.76 this
// spans roughly 2.2 down to 0.007 across the full sweep of mu, and that
// three-order-of-magnitude range is exactly the drama a uniform fresnel has
// none of.
float henyeyGreenstein(float mu, float g) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * mu;
  return (1.0 - g2) / (12.5663706 * pow(max(d, 1e-4), 1.5));
}
`;

/**
 * A ring system's optical depth as a function of how far across the annulus
 * you are — `u = 0` at the inner edge, `1` at the outer.
 *
 * **One function, two consumers, and that is the requirement rather than a
 * tidiness.** The ring's own fragment shader reads this to decide how opaque
 * a pixel of ring is; the *planet's* fragment shader reads the same function
 * to decide how much light a ring blocks on its way down. If those two ever
 * disagreed, the Cassini division would appear in the ring and not in its
 * shadow — which is precisely the tell that the shadow is painted rather than
 * cast, and the whole reason to compute it analytically in the first place.
 *
 * Structure, from the real thing: two hard divisions (Cassini between the B
 * and A rings at roughly two fifths across, Encke near the outer edge), fine
 * ringlet banding, a broader density envelope, and both edges falling off —
 * the inner one gently, the outer one sharply, because a real outer edge is
 * shepherded and a real inner edge is not.
 *
 * `seed` shifts every noise slice so two sectors' rings are not the same ring
 * at a different tilt. The gaps stay put regardless: a ring system without
 * divisions does not read as a ring system, so their *existence* is not
 * something a seed is allowed to roll away.
 *
 * Requires `hash31`, `noise3` (from `noise.ts`) and `CELESTIAL_UTIL` before it.
 */
export const RING_PROFILE = /* glsl */ `
float ringProfile(float u, float seed) {
  if (u < 0.0 || u > 1.0) return 0.0;
  // The two divisions. Multiplied in rather than subtracted so a gap is a
  // true hole in both the ring and its shadow — a subtractive dip would
  // leave a dim ring inside the Cassini division, and the division reads as
  // a division because it is empty.
  float cassini = smoothstepc(0.010, 0.040, abs(u - 0.42));
  float encke = smoothstepc(0.003, 0.014, abs(u - 0.81));
  // Ringlets. Two scales: fine banding you only resolve up close, over a
  // broader density envelope that survives at range. Both embedded on the
  // seed axis so a sector's ring is its own.
  float fine = 0.45 + 0.55 * noise3(vec3(u * 41.0, seed, 0.0));
  float broad = 0.35 + 0.65 * noise3(vec3(u * 7.0, seed + 11.3, 0.0));
  // Edges: the inner one fades in over a sixteenth of the span, the outer
  // one is cut sharply — a shepherded edge, and the visual difference
  // between the two is most of what makes a ring look shepherded.
  float edges = smoothstepc(0.0, 0.07, u) * smoothstepc(1.0, 0.93, u);
  return clamp(fine * broad * edges * cassini * encke, 0.0, 1.0);
}
`;

/**
 * The two shadows. Both take everything in one shared space — the body's own
 * object space, centred on the body — and both return "fraction of the star
 * blocked", 0 to 1, for a caller to multiply its light term by.
 *
 * Requires `CELESTIAL_UTIL` and `RING_PROFILE` before it.
 */
export const CELESTIAL_SHADOWS = /* glsl */ `
// Ring shadow cast onto a point on the body.
//
//   p        surface point, body centre at the origin
//   l        unit direction *toward* the star
//   n        unit normal of the ring plane (the plane passes through the origin)
//   inner    ring inner radius, same units as p
//   outer    ring outer radius
//   depth    the ring's peak optical depth — the same number the ring's own
//            shader multiplies ringProfile by, so the two never disagree
//
// One plane intersection and one radius test. The ray from the surface toward
// the star meets the ring plane at t = -dot(p,n)/dot(l,n); if that t is
// positive the plane is between this point and the star, and if the meeting
// point lands inside the annulus the ring is standing in the light.
//
// Two guards, and both are cases you actually see rather than defensive
// padding. A star lying almost *in* the ring plane makes dot(l,n) vanish and
// t explode — that is the equinox geometry, where the true shadow collapses
// to a line, so returning nothing is also the right answer. And t <= 0 means
// the ring plane is behind the point relative to the star, which is the whole
// hemisphere on the far side of the ring from the sun — unshadowed by
// construction.
//
// The return is Beer's law along the *light's* own path, not the raw profile
// value, and that distinction is worth its one exp. How much of the star a
// ring blocks depends on how obliquely the light crosses it: the same ring
// casts a pale shadow with the star high above its plane and a near-black one
// with the star low. This game's star sits at a fixed 18° elevation
// (render/light.ts's STAR.elevationDeg) against ring tilts of 16-45°, so the
// slant is always shallow and this term is doing real work in every sector
// rather than covering an edge case — the first draft returned the profile
// directly and produced a shadow you had to be told was there.
float ringShadow(vec3 p, vec3 l, vec3 n, float inner, float outer, float seed, float depth) {
  float denom = dot(l, n);
  if (abs(denom) < 1e-4) return 0.0;
  float t = -dot(p, n) / denom;
  if (t <= 0.0) return 0.0;
  vec3 q = p + l * t;
  float r = length(q);
  if (r < inner || r > outer) return 0.0;
  float tau = ringProfile((r - inner) / (outer - inner), seed) * depth;
  // The same 0.12 floor the ring's own shader puts under its view-angle slant,
  // for the same reason: a star lying in the ring plane would otherwise divide
  // by zero, and the shadow would flash to fully opaque at the one geometry
  // where it ought to be vanishing.
  return 1.0 - exp(-tau / max(abs(denom), 0.12));
}

// Body shadow cast onto a point on the ring.
//
//   q        ring point, body centre at the origin
//   l        unit direction toward the star
//   radius   the body's radius
//   soft     penumbra width as a fraction of that radius
//
// b = dot(q,l) is negative exactly when the star is on the far side of the
// body from this ring point, which is the only way the body can be in the
// way; sqrt(dot(q,q) - b*b) is then the perpendicular distance from the body's
// centre to that ray. Inside the radius is umbra, outside is light, and the
// smoothstep across 'soft' is the penumbra — an explicit width rather than one
// derived from the star's angular size, because at STAR.distance = 20000 the
// true penumbra is a few pixels wide and reads as a hard-edged bite out of the
// ring, which looks like a rendering bug rather than a shadow.
float sphereShadow(vec3 q, vec3 l, float radius, float soft) {
  float b = dot(q, l);
  if (b >= 0.0) return 0.0;
  float d = sqrt(max(dot(q, q) - b * b, 0.0));
  return smoothstepc(radius * (1.0 + soft), radius * (1.0 - soft), d);
}
`;

/**
 * Everything above, in dependency order, including the two `noise.ts` rungs
 * `ringProfile` needs — the same service `flowLadder` performs one file over
 * and for the same reason its comment gives: an ordering requirement that
 * lives only in a header is one a later shader gets wrong once.
 *
 * A body that already interpolates `flowLadder(n)` must **not** also
 * interpolate this, or `hash31`/`noise3` are declared twice and the shader
 * fails to compile. `celestialLadderAfterFlow` is that case; both callers in
 * this project take it, since both sample a flow field as well.
 */
export function celestialLadder(): string {
  return HASH31 + NOISE3 + CELESTIAL_UTIL + RING_PROFILE + CELESTIAL_SHADOWS;
}

/** The same ladder for a shader that has already emitted `flowLadder(n)`. */
export function celestialLadderAfterFlow(): string {
  return CELESTIAL_UTIL + RING_PROFILE + CELESTIAL_SHADOWS;
}

/**
 * The atmosphere shell's vertex stage, shared by every body that wears one.
 *
 * `vLightDirView` is the sector light's fixed world direction carried into
 * view space through the built-in `viewMatrix`, so the fragment stage can
 * compare it against a view-space normal and a view-space eye vector without
 * this shader's owner recomputing anything as the camera moves — three.js
 * updates `viewMatrix` every frame for any `ShaderMaterial`, which is the same
 * free ride `modelViewMatrix`/`normalMatrix` already give the normal.
 */
export const LIMB_VERTEX = /* glsl */ `
uniform vec3 uLightDirWorld;
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vLightDirView;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewDir = normalize(-mvPosition.xyz);
  vLightDirView = normalize((viewMatrix * vec4(uLightDirWorld, 0.0)).xyz);
  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * The atmosphere shell's fragment stage — and the one place in this project
 * where a *uniform* fresnel was the wrong physics rather than merely a cheap
 * approximation of it.
 *
 * What it replaced: `pow(1 - dot(N, V), power)` and nothing else. That is a
 * real term — it is the geometric path length through a thin shell, longest at
 * grazing angle — but on its own it says an atmosphere glows equally on the
 * day side, the night side and the terminator, which is not a simplification
 * of what a planet does, it is the opposite of it. A haze layer is lit by the
 * star like everything else, and it scatters that light *forward*: dim where
 * the star is behind the camera, blinding where the star is behind the planet.
 * The uniform version made a body read as a lamp with an even halo. The
 * asymmetry is what makes it read as a lit atmosphere.
 *
 * Three terms, and each one is doing a job the other two cannot:
 *
 *  - **`rim`** — the old fresnel, kept unchanged. Path length. This is what
 *    confines the whole effect to the silhouette; without it every term below
 *    would wash across the disc.
 *  - **`lit`** — how much of this bit of shell the star reaches, deliberately
 *    soft-edged and wrapped slightly past the geometric terminator
 *    (`-0.25`, not `0.0`). A real atmosphere is lit around the curve of the
 *    body it sits on, which is why the sky is still bright after sunset, and a
 *    hard `max(dot(N,L), 0.0)` would put a straight razor edge across a halo.
 *  - **`forward`** — Henyey-Greenstein on the angle between where the starlight
 *    was travelling and where the camera is. This is item 2 of the task and
 *    the reason the file it lives in exists.
 *
 * Plus `sunset`, a narrow Gaussian pinned to `dot(N,L) = 0` — the day/night
 * boundary itself — which is what carries the warm tint. Reddening at the
 * terminator is not decoration: it is the same long slant path through the
 * haze that makes a sunset red, and it is where the eye looks first on every
 * photograph this shader is trying to be.
 *
 * The tints are the caller's, not this file's. A gas giant's haze and an icy
 * ringed body's haze are not the same colour, and both are multiplied by
 * `uLightColor` regardless so a red star cannot produce a blue rim.
 */
export const LIMB_FRAGMENT = /* glsl */ `
uniform vec3 uGlowColor;
uniform vec3 uSunsetColor;
uniform vec3 uLightColor;
uniform float uPower;
uniform float uIntensity;
uniform float uForward;
uniform float uAsymmetry;
uniform float uSunsetWidth;
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vLightDirView;

float smoothstepLimb(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float hgLimb(float mu, float g) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * mu;
  return (1.0 - g2) / (12.5663706 * pow(max(d, 1e-4), 1.5));
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vViewDir);
  vec3 l = normalize(vLightDirView);

  float facing = max(dot(n, v), 0.0);
  float rim = pow(1.0 - facing, uPower);

  float ndl = dot(n, l);
  float lit = smoothstepLimb(-0.25, 0.35, ndl);

  // v points from the surface toward the camera, so light that reaches the
  // camera travels along +v; light from the star travels along -l. The two
  // agree — true forward scattering — when dot(v, l) = -1, which is the star
  // directly behind the body. Hence the negation, and hence mu = 1 being the
  // backlit crescent rather than the fully lit face.
  float mu = clamp(-dot(v, l), -1.0, 1.0);
  float forward = hgLimb(mu, uAsymmetry) * uForward;

  float sunset = exp(-(ndl * ndl) / (uSunsetWidth * uSunsetWidth));

  vec3 tint = mix(uSunsetColor, uGlowColor, smoothstepLimb(0.0, 0.55, ndl));
  float amount = rim * (lit * (0.30 + forward) + sunset * (0.35 + forward * 0.8));
  vec3 c = tint * uLightColor * uIntensity * amount;
  gl_FragColor = vec4(c, clamp(amount, 0.0, 1.0));
}
`;
