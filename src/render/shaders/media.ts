import {
  BackSide,
  BoxGeometry,
  Color,
  CustomBlending,
  type IUniform,
  Mesh,
  Object3D,
  OneFactor,
  OneMinusSrcAlphaFactor,
  type PointLight,
  ShaderMaterial,
  Vector3,
} from "three";
import { VOLUME_NOISE, VOLUME_NOISE_DECL, sharedVolumeNoise } from "../volumeNoise.js";

/**
 * The volumetric bench — a raymarched participating medium, in one place, for
 * every gaseous thing in this game.
 *
 * ## Why this file exists at all
 *
 * Every gas in this game has been a *stroke*. The comet's tail is eighty-four
 * `TraceBuffer` filaments (`game/comet.ts`); the gas shoals are a hundred and
 * twenty of the same (`render/Shoals.ts`); both files' own headers argue, at
 * length and correctly, that connected strands read as gas where loose dashes
 * read as a particle field. That argument was right about *its* question and
 * silent about the one that actually separates astrophotography from a painted
 * backdrop: **depth ordering inside the medium**. Dark dust in front of bright
 * gas. A stroke cannot express that, structurally — an additive line adds, and
 * a thousand additive lines add a thousand times, so a `TraceBuffer` plume is
 * exactly as bright whether the dense knot is in front of the glow or behind
 * it. There is no *inside* to a bundle of strokes.
 *
 * `docs/environment.md` §8.1 already records this lesson once, for the hero
 * gas giant: three rounds of stroke-built planet never produced a planet, and a
 * filled mesh did, immediately, the moment the medium changed. This is that
 * same finding applied to gas rather than to a surface. What a march buys and a
 * stroke cannot:
 *
 * - **Front-to-back accumulation with real transmittance.** Every step's light
 *   is attenuated by everything already accumulated in front of it, so a dense
 *   near knot genuinely *hides* the glow behind it. This is the whole feature.
 * - **Scattering rather than tinting.** A Henyey-Greenstein phase function
 *   (`hg` below) makes the medium brighten when you look *toward* a light
 *   through it and stay dim when you look away — which is what a coma, a
 *   sunlit dust lane or a warhead going off inside a shoal actually does, and
 *   is the difference between gas that is *lit* and gas that is merely
 *   coloured.
 * - **An inside.** The camera may stand in the medium, which is not a nicety
 *   here: the comet's one gameplay rule is that you fly *into* the tail.
 *
 * ## What is swappable and what is not
 *
 * The march, the compositing, the phase function, the light loop, the fog and
 * the dither are fixed — they are the part that is the same for every medium
 * and the part it would be a mistake to let two bodies solve differently. Two
 * things are the caller's:
 *
 * - `bounds`: GLSL declaring `bool mediaBounds(vec3 ro, vec3 rd, out float t0,
 *   out float t1)`, in **world space**. Analytic. Returning `false` discards
 *   the fragment before a single density sample is taken, which is the
 *   difference between marching a comet tail and marching the sector. Two
 *   hulls are supplied to write it with — `boxSpan` (an oriented box) and
 *   `coneSpan` (a capped cone of revolution) — because those are the two
 *   shapes worth the algebra and neither reads a uniform, so the caller keeps
 *   ownership of what it feeds them.
 * - `density`: GLSL declaring `Media mediaSample(vec3 p)`, also in world space.
 *
 * **World space, not object space, and that is a decision.** The obvious build
 * puts the medium in the proxy mesh's local frame and inverts `modelMatrix` in
 * the shader. Every body this serves already *has* its shape written down as
 * world-space numbers — `CometPlan.nucleus`/`direction`/`length` are world
 * units, `ShoalPlan.bearing`/`range` are a world bearing and a world distance —
 * so an object-space core would mean each caller maintaining a second copy of
 * its own geometry in a different frame, kept in agreement by hand, for no gain
 * at all. Working in world space also means `cameraPosition` (three's own
 * built-in uniform) is the ray origin with nothing to transform, which is what
 * makes the camera-inside-the-medium case fall out rather than being special.
 * The proxy mesh is then *only* a bounding hull: it has to cover the volume's
 * silhouette and nothing else about its transform is read.
 *
 * ## The compositing setup, and the one thing it gets wrong on purpose
 *
 * `side: BackSide`, `depthTest: false`, `depthWrite: false`, premultiplied
 * "over" blending, `renderOrder: -5`.
 *
 * **`BackSide` is what makes inside and outside one case.** Draw front faces
 * and the medium vanishes the moment the camera crosses into it (the front
 * faces are behind the near plane); draw both and every fragment composites
 * twice. Back faces exist from anywhere the volume is on screen at all, and
 * exactly once per pixel, so there is one fragment to march from and no
 * inside/outside branch on the CPU. The proxy is convex, so its back face is
 * always past the medium and never in front of it.
 *
 * **`depthTest: false` is the compromise, and it is deliberate.** Correct
 * occlusion of a medium by opaque geometry standing inside it needs the depth
 * buffer as a texture, and `render/Stage.ts` owns the scene target privately —
 * this file cannot reach it, and the alternative routes are all worse than the
 * artefact. `BackSide` + depth test would test the *far wall* of the volume, so
 * a hostile flying in the tail would delete the entire column of gas behind it,
 * which is a far louder bug than the one below. So the medium composites over
 * whatever opaque geometry was already there.
 *
 * What that costs is bounded by `renderOrder: -5`, and this is the part worth
 * understanding: three draws all opaque geometry, then all transparent
 * geometry sorted by `renderOrder`. At -5 the medium lands *first* among the
 * transparents — before `TraceBuffer` (2) and before every hull's own stroke
 * material (0). So the sequence is: hull *fills* (opaque, near-void by house
 * style) → gas over them → hull *strokes* and beams added on top. A ship
 * behind the gas therefore keeps its glowing edges and loses its dark fill,
 * which is not merely tolerable but close to what was wanted: `VectorObject`'s
 * own header is explicit that the strokes *are* the light rather than
 * receiving it, and light is the thing gas does not stop. Combat legibility —
 * the reason "occluded geometry, not pure wireframe" is a locked decision — is
 * about hulls overlapping *each other*, and that is untouched here.
 *
 * ## What it costs, and the one machine it refuses to run on
 *
 * Raymarching is fill, and fill is this game's entire budget
 * (`docs/environment.md` §1). Three things keep it inside one:
 * analytic bounds (a ray that misses the cone discards before the loop),
 * an early-out on transmittance (`MEDIA.cutoff` — a dense medium stops
 * marching itself), and a shape test cheap enough to `continue` past before
 * the noise is ever evaluated.
 *
 * **The noise used to be the whole cost, and is not any more.** It was sixteen
 * hash evaluations a sample — `noise.ts`'s analytic ladder, eight `hash31`
 * calls per octave, two octaves — and `mediaNoise` now reads the same field out
 * of `render/volumeNoise.ts`'s 64³ block instead, one trilinear fetch an
 * octave. Measured on an M2 Max at 3024x1964 with the medium filling the frame,
 * that took the cone's per-step price from **0.391 ms to 0.216 ms** and the
 * box's from **0.371 ms to 0.137 ms**, and both media spent the difference on
 * samples rather than banking it: see `COMET_MEDIA.steps` and
 * `SHOAL_MEDIA.steps` for the tables and for where each stopped.
 *
 * What is left as the top of the bill is the **injected light loop**, which is
 * the only per-light-per-step expression here: four event lights inside a
 * frame-filling medium roughly triples the shader. That is why the point
 * lights take single-order `hg` where the key light takes `hgMulti` — see the
 * loop — and it is the next thing to look at if this ever needs to be cheaper
 * again.
 *
 * **It does not run on software GL, by construction.** `CLAUDE.md`'s own
 * gotchas record that headless Chromium on SwiftShader takes ~0.5 s a frame
 * for the post chain alone, which is why `tools/playtest.mjs` runs at 640x400
 * with post disabled. A full-screen march there is seconds a frame, and the
 * harness's real-time waits would start failing for reasons having nothing to
 * do with what they assert. `mediaQuality()` probes the GL renderer string once
 * and returns 0 on a software rasteriser; a caller that gets 0 builds no volume
 * at all and keeps its old stroke plume, so the harness sees exactly the game
 * it saw before. This is not a graceful-degradation nicety — it is the reason
 * 167 assertions still pass.
 */

/**
 * Every number the core is. First-draft guesses of exactly the same species as
 * `LOOM`, `COMET`, `BRACE` and `EVENT_LIGHT` — reasoned about, never flown —
 * and candidates for the tuning console. `steps` and `cutoff` are the two worth
 * flying first: together they are the entire quality/cost dial, and neither has
 * ever been judged against a frame it was actually costing.
 */
export const MEDIA = {
  /**
   * How many samples a march takes across its own analytic span, baked into
   * the emitted GLSL because ES 1.00 requires a loop bound the compiler can
   * fold. This is the default; each body passes its own.
   *
   * **Nothing uses this default** — both media pass their own, and both are
   * still below it, which is the finding worth recording. 32 was the
   * first-draft guess. Measured on an M2 Max at 3024x1964 with the medium
   * covering the frame, a step costs **0.216 ms** for the comet's cone and
   * **0.137 ms** for the shoal's box, so 32 steps is a 7 ms feature against a
   * frame with 12.5 ms spare — affordable alone and not affordable twice, and a
   * sector can hold a comet and a shoal at once. (Before `mediaNoise` swapped
   * the analytic ladder for a texture fetch those numbers were 0.391 and 0.371;
   * the cone is now the *dearer* of the two per step, having been the cheaper,
   * because a looser bounding hull saves noise and the noise is what got
   * cheap.)
   *
   * It is kept as the documented default because it is the number a march
   * *wants*; see `COMET_MEDIA.steps` and `SHOAL_MEDIA.steps` for what each
   * actually got and why each stopped short of it.
   */
  steps: 32,
  /**
   * Transmittance below which the march stops early. A medium dense enough to
   * hide what is behind it has, by definition, nothing left to gather from the
   * remaining steps, and the interior of a comet's coma reaches this within a
   * handful of samples. 0.008 is about a 1% floor — low enough that the
   * termination is never visible as a boundary.
   */
  cutoff: 0.008,
  /**
   * Henyey-Greenstein asymmetry, -1 (fully backward) to 1 (fully forward).
   * Real cometary dust is strongly forward-scattering; 0.55 keeps the
   * brightening pronounced when looking toward the star through the tail
   * without collapsing into a pinpoint that only reads from one angle.
   *
   * Note the normalisation: `hg` below returns 1 for an isotropic medium
   * rather than the physicist's 1/4pi, so a gain of 1 means "as bright as a
   * uniform scatterer" and every call site's numbers stay legible.
   */
  anisotropy: 0.55,
  /**
   * How many injected point lights a medium's shader is compiled for. Four,
   * against `EVENT_LIGHT.count`'s eight: the loop runs per step per fragment,
   * so each slot is a permanent multiplier on the most expensive thing in the
   * game, and the events worth lighting a cloud from inside — a warhead, a
   * kill — arrive one or two at a time. `injectLights` sorts the pool by
   * irradiance at the volume and takes the best four, so the ones that are
   * dropped are the ones that were not going to be seen.
   *
   * **Measured, now that there is something to compare it against.** At 14
   * steps with a maximum-size comet filling the frame, going from zero live
   * lights to four roughly *tripled* the shader — about 0.075 ms per step per
   * light, against a step's own price of 0.216. So four slots is not a
   * rounding error hiding behind a rare event; it is the largest single lever
   * left in this file, and it only stays affordable because `uLightCount` is
   * genuinely zero on most frames. If a later pass needs the budget back, two
   * slots is where to look before touching `steps`.
   */
  lights: 4,
  /**
   * Scene fog, restated. `Stage`'s `Fog(0x000000, 45, 260)` is applied by
   * three's own fog chunk to materials three built; a hand-written
   * `ShaderMaterial` gets none of it (the same gap `GasGiant` answers by
   * declaring `fog: false` and living outside the range entirely). A comet at
   * combat range cannot take that exemption — its stroke plume was fogged, and
   * a volume that was not would be the one thing in the sector that does not
   * lose brightness with distance. Applied per step rather than per fragment,
   * which is strictly more correct: the near end of a tail fades less than its
   * far end, because it is nearer.
   */
  fogNear: 45,
  fogFar: 260,
  /**
   * Step growth — see the march's own note. 1.06 across 20-ish steps makes the
   * last step about three times the first, which is roughly how much cheaper a
   * distant sample is in screen coverage; it is the number that let the step
   * count fall from 34 to 20 with the inside of a comet's tail looking better
   * rather than worse.
   */
  growth: 1.11,
  /**
   * Multiple scattering, approximated — how many *scattering orders* the phase
   * function is summed over. See `MEDIA_PHASE_MS`.
   *
   * 3, and it is free where it matters: the key light's phase term is hoisted
   * out of the march (see the loop's own note), so three `hg` evaluations a
   * *fragment* replace one. Only the injected point lights pay it per step, and
   * `uLightCount` is zero on the overwhelming majority of frames.
   */
  msOctaves: 3,
  /** How much less each scattering order contributes than the one before it.
   * Hillaire's `a`; 0.5 is his own default and means the third order is a
   * quarter of the first. */
  msFalloff: 0.5,
  /** How much less *directional* each order is than the one before it.
   * Hillaire's `c`. This is the term that does the actual work: light that has
   * bounced twice has forgotten most of where it came from, so order 3 is
   * scattered at `g * 0.36` and is very nearly isotropic. */
  msEccentricity: 0.6,
} as const;

// ── the GLSL bench ──────────────────────────────────────────────────────────

/**
 * What a density function hands back. A struct rather than four out-parameters
 * because the four are one description of a point and travel together.
 *
 * - `density` is extinction, in inverse world units before `uSigma` scales it.
 *   Zero means vacuum and is the fast path — the march skips a zero sample
 *   before touching a light.
 * - `tint` is the medium's own colour at this point. Both bodies vary it:
 *   dust and gas are not the same colour, and having them share one uniform
 *   would give up half of what the march is for.
 * - `scatter` is single-scattering albedo, 0-1. **This is the "dark dust"
 *   half of "dark dust in front of bright gas"** — a point may be dense and
 *   barely scatter, which is exactly what a dust lane is, and it is why the
 *   density function returns two numbers rather than one.
 * - `glow` is self-emission, unlit. For the parts of a medium that genuinely
 *   produce light rather than borrow it — a comet's own outgassing head.
 */
export const MEDIA_STRUCT = /* glsl */ `
struct Media {
  float density;
  vec3 tint;
  float scatter;
  float glow;
};
`;

/**
 * The Henyey-Greenstein phase function, normalised so isotropic returns 1.
 *
 * `cosT` is the cosine between the *view* direction and the direction toward
 * the light — note the sign convention: this file passes `dot(rd, toLight)`,
 * so +1 is looking straight into the light through the medium. The physical
 * form carries a 1/4pi that makes every useful value a small fraction; the
 * `4pi` here cancels it, so a gain of 1 at g=0 is a plain uniform scatterer
 * and a call site's numbers can be argued with.
 *
 * `d * sqrt(d)` rather than `pow(d, 1.5)` — the same value, and `pow` with a
 * non-constant base is a log/exp pair on most hardware where this is a
 * multiply and a square root. It runs per light per step per fragment; that is
 * the one place in this file where an instruction is worth counting.
 */
export const MEDIA_PHASE = /* glsl */ `
float hg(float cosT, float g) {
  float g2 = g * g;
  float d = max(1.0 + g2 - 2.0 * g * cosT, 1e-4);
  return (1.0 - g2) / (d * sqrt(d));
}
`;

/**
 * The phase function again, summed over scattering *orders* — a multiple
 * scattering approximation, and the cheapest half of one that is worth having.
 *
 * ## What single scattering gets wrong
 *
 * `hg` above answers "how much light arriving from that direction bounces once
 * and comes at me". A real cloud bounces light many times, and the two visible
 * consequences are both things this bench got wrong before: the forward lobe is
 * far too sharp, because light that has bounced three times has forgotten which
 * way it was going; and thick regions go black, because single scattering has
 * no mechanism for light that got in and wandered.
 *
 * The first is not an aesthetic quibble here — it is a *logged bug*.
 * `COMET_MEDIA.anisotropy`'s own comment records having to detune the medium
 * from a physically defensible 0.55 down to 0.45 because "the same tail read as
 * a searchlight from one heading and as nothing from the opposite one", a forty
 * to one ratio. That ratio is exactly what single scattering overstates.
 *
 * ## The approximation
 *
 * Hillaire's octave trick (*Physically Based Sky, Atmosphere and Cloud
 * Rendering*, 2016), phase half only: order *m* contributes `a^m` as much, at
 * eccentricity `g * c^m`. Summed and divided by the weights, so an isotropic
 * medium still returns exactly 1 and **every existing call site's gain keeps
 * the number it was tuned to** — this changes the *shape* of the lobe and
 * nothing about its total.
 *
 * The half deliberately not taken is the transmittance octaves (`b^m`), which
 * need one accumulator per order through the whole march. That is the half that
 * would put light back into thick interiors, and it costs a multiple of the
 * loop rather than a multiple of one hoisted expression — the wrong trade for
 * the only fill-bound feature in this game. `uAmbient` is the standing
 * stand-in for it and always was.
 *
 * The loop bound is baked for the same reason every other one here is.
 */
export function mediaPhaseMs(orders: number, falloff: number, eccentricity: number): string {
  return /* glsl */ `
float hgMulti(float cosT, float g) {
  float sum = 0.0;
  float wsum = 0.0;
  float a = 1.0;
  float c = 1.0;
  for (int i = 0; i < ${orders}; i++) {
    sum += a * hg(cosT, g * c);
    wsum += a;
    a *= ${falloff.toFixed(4)};
    c *= ${eccentricity.toFixed(4)};
  }
  return sum / wsum;
}
`;
}

/**
 * Ray against an oriented box, as an entry/exit pair — the slab test, in the
 * box's own frame, built from three unit axes and three half extents passed as
 * uniforms rather than from a matrix.
 *
 * Returns false when the ray misses, which discards the fragment before the
 * loop. Note it does *not* clamp `t0` to zero: the caller does that, because
 * "the camera is inside" is information the march wants (a negative `t0` is
 * how it knows) and information a bounds test should not silently destroy.
 */
export const MEDIA_BOX = /* glsl */ `
bool boxSpan(
  vec3 ro, vec3 rd, vec3 centre, vec3 u, vec3 v, vec3 w, vec3 ext,
  out float t0, out float t1
) {
  vec3 d = ro - centre;
  vec3 o = vec3(dot(d, u), dot(d, v), dot(d, w));
  vec3 r = vec3(dot(rd, u), dot(rd, v), dot(rd, w));
  float lo = -1e20;
  float hi = 1e20;
  for (int i = 0; i < 3; i++) {
    if (abs(r[i]) < 1e-7) {
      // Parallel to this slab: either inside it for the whole ray or never.
      if (abs(o[i]) > ext[i]) return false;
    } else {
      float a = (-ext[i] - o[i]) / r[i];
      float b = (ext[i] - o[i]) / r[i];
      lo = max(lo, min(a, b));
      hi = min(hi, max(a, b));
    }
  }
  t0 = lo;
  t1 = hi;
  return hi > lo;
}
`;

/**
 * Ray against a capped cone — a cone of revolution about `axis`, whose radius
 * runs `r0 + k * s` for `s` (the distance along the axis from `org`) between
 * `sMin` and `sMax`.
 *
 * This is the shape a comet is, and it is worth the algebra rather than
 * settling for the proxy box: a tail is up to 221 units long against a 105
 * unit radius, so the box that contains it is roughly three times its volume,
 * and step spacing is `(t1 - t0) / steps` — marching the box would spend a
 * third of every sample outside the medium *and* stretch the spacing of the
 * ones inside it. The brief's "do not march empty space" is about exactly this.
 *
 * The algebra: with `o` and `d` split into components along and perpendicular
 * to the axis, `|perp(o + t d)|^2 = (r0 + k * s(t))^2` is a quadratic in `t`,
 * because `s(t)` is itself linear in `t`. `A` going negative is not a
 * degenerate case but a real one — it means the ray is climbing the cone's wall
 * more slowly than the wall widens, so the ray is *trapped inside* and the
 * solid region is the outside of the root pair rather than the inside. That
 * branch picks whichever half overlaps the axial slab. It can pick wrong for a
 * ray that straddles both; the consequence is a march through a region whose
 * density function returns zero, which costs a few skipped samples and draws
 * nothing wrong.
 *
 * The apex (where the radius reaches zero, at `s = -r0 / k`) carries a spurious
 * mirror sheet on the far side. Nothing clips it here because the axial slab
 * already does, for every caller this file has: a comet's cone reaches the
 * apex far behind its own `sMin`.
 */
export const MEDIA_CONE = /* glsl */ `
bool coneSpan(
  vec3 ro, vec3 rd, vec3 org, vec3 axis, float r0, float k, float sMin, float sMax,
  out float t0, out float t1
) {
  vec3 co = ro - org;
  float so = dot(co, axis);
  float a1 = dot(rd, axis);
  vec3 cp = co - axis * so;
  vec3 dp = rd - axis * a1;
  float rs = r0 + k * so;

  float lo = -1e20;
  float hi = 1e20;
  if (abs(a1) < 1e-7) {
    if (so < sMin || so > sMax) return false;
  } else {
    float a = (sMin - so) / a1;
    float b = (sMax - so) / a1;
    lo = min(a, b);
    hi = max(a, b);
  }

  float A = dot(dp, dp) - k * k * a1 * a1;
  float B = 2.0 * (dot(cp, dp) - rs * k * a1);
  float C = dot(cp, cp) - rs * rs;

  if (abs(A) < 1e-9) {
    // Degenerate to linear — a ray exactly parallel to the cone's wall.
    if (abs(B) < 1e-12) {
      if (C > 0.0) return false;
    } else {
      float tr = -C / B;
      if (B > 0.0) hi = min(hi, tr);
      else lo = max(lo, tr);
    }
  } else {
    float disc = B * B - 4.0 * A * C;
    if (A > 0.0) {
      if (disc < 0.0) return false;
      float sq = sqrt(disc);
      float ra = (-B - sq) / (2.0 * A);
      float rb = (-B + sq) / (2.0 * A);
      lo = max(lo, min(ra, rb));
      hi = min(hi, max(ra, rb));
    } else {
      if (disc < 0.0) {
        if (C > 0.0) return false;
      } else {
        float sq = sqrt(disc);
        float ra = (-B - sq) / (2.0 * A);
        float rb = (-B + sq) / (2.0 * A);
        float rlo = min(ra, rb);
        float rhi = max(ra, rb);
        float mid = 0.5 * (max(lo, -1e6) + min(hi, 1e6));
        if (mid <= rlo) hi = min(hi, rlo);
        else lo = max(lo, rhi);
      }
    }
  }

  t0 = lo;
  t1 = hi;
  return hi > lo;
}
`;

/**
 * Where a sample lands inside its own step, 0-1, from screen position alone.
 *
 * Interleaved gradient noise (Jimenez), and the point is what it *is not*:
 * there is no time term. A time-varying jitter is the textbook answer to
 * banding and it is wrong twice here — `PhosphorPass` smears the previous
 * frame into this one, so per-frame noise becomes a crawling grain rather than
 * averaging away, and `CLAUDE.md` is explicit that nothing about a gas body may
 * pulse. A static screen-space dither breaks the bands into a fixed stipple
 * that the bloom pyramid then softens, which is the same trade at none of the
 * cost.
 *
 * **A warning for whoever next looks at a screenshot of a tail and reaches for
 * `steps`.** Downscaled captures of this game show evenly-spaced curved arcs
 * across a medium's outer envelope that look exactly like march shells — they
 * get finer as `steps` rises, which is precisely the confirmation you would
 * expect. They are not march shells. They are `CrtPass`'s scanlines under its
 * own barrel curvature, aliasing against the capture's downsample: turning the
 * CRT pass off removes them completely at any step count, and turning the
 * march's own step count from 14 to 28 does not. Cost an hour once, and it
 * would have cost more had it been "fixed" by spending steps on it.
 */
export const MEDIA_DITHER = /* glsl */ `
float mediaDither(vec2 frag) {
  return fract(52.9829189 * fract(dot(frag, vec2(0.06711056, 0.00583715))));
}
`;

// ── the noise, which is the whole bill ──────────────────────────────────────

/**
 * The ladder, as a table rather than a loop, because every row differs in more
 * than its frequency.
 *
 * Each row is **one trilinear fetch of `volumeNoise.ts`'s 64³ RGBA8 field** and
 * yields **two** decorrelated numbers, because the field carries four
 * independent channels and a fetch returns all of them. That second number is
 * not a bonus — see `mediaNoise` for what the media do with it.
 *
 * `freq` is in *base cells*: 1.0 is the frequency the field was built at, and
 * `MEDIA_NOISE_SCALE` below is what maps a caller's world-space noise
 * coordinate onto it so that one unit of a caller's `q` is one base cell,
 * exactly as it was under `noise.ts`'s analytic `fbm3`. Callers keep their
 * `noiseScale` numbers unchanged; that was a requirement, not a coincidence.
 *
 * Three things about the ordering and the values are decisions:
 *
 * **The rows are in order of importance, not of frequency**, because `octaves`
 * takes a prefix. Row 2 is therefore the *coarse* one rather than the third
 * harmonic, and that is the row that earns its place: the field tiles with a
 * period of `VOLUME_NOISE.cells` = 6 base cells, which for the comet's
 * `noiseScale` of 0.11 is 54 world units across a tail up to 273 wide. Row 0
 * alone would repeat five times across that. Row 2 sits at 0.428, a period of
 * 14 base cells — 127 world units — and carries a third of the amplitude, so
 * the largest thing the eye can find is not the thing that repeats.
 *
 * **The frequencies are irrational-ish multiples, never doublings.** Octaves at
 * 1, 2 and 4 are all harmonics of the tile, so their sum repeats on the tile
 * exactly. 2.070 and 4.130 do not, so the composite never closes — the same
 * reason `VOLUME_NOISE`'s own header gives for its non-integer octave scales.
 *
 * **The ladder stops at four rows and this is a hard limit of the field, not a
 * budget.** 6 cells across 64 voxels is ~10.7 voxels a cell; row 3 at 4.13
 * already samples a 2.6-voxel cell, which `VOLUME_NOISE.cells`' own comment
 * names as the point where trilinear interpolation stops looking like noise and
 * starts looking like a grid. A fifth harmonic would be a lattice, not detail —
 * and it would be detail finer than the march's own sample spacing anyway
 * (row 3's features are ~2 world units against a step of ~10), so it would
 * arrive as dither. **The winnings from this file belong in `steps`, not in
 * octaves**, and this is the reason.
 *
 * The offsets stop the rows sharing an origin, which is otherwise a visible
 * knot wherever the caller's coordinate frame happens to put zero.
 */
const NOISE_LADDER: { freq: number; amp: number; a: string; b: string; off: [number, number, number] }[] = [
  { freq: 1.0, amp: 0.5, a: "x", b: "w", off: [0.13, 0.71, 0.29] },
  { freq: 2.07, amp: 0.25, a: "y", b: "z", off: [0.61, 0.19, 0.83] },
  { freq: 0.428, amp: 0.34, a: "z", b: "x", off: [0.37, 0.53, 0.11] },
  { freq: 4.13, amp: 0.125, a: "w", b: "y", off: [0.79, 0.31, 0.47] },
];

/**
 * World-to-field scale. The block holds `VOLUME_NOISE.cells` lattice cells
 * across its full 0-1 texture domain, so dividing by that count is what makes
 * one unit of a caller's noise coordinate one cell — which is what
 * `noise.ts`'s integer-lattice `noise3` meant by one unit, and therefore what
 * every `noiseScale` in `CometMedium` and `Shoals` was tuned against.
 */
const MEDIA_NOISE_SCALE = 1 / VOLUME_NOISE.cells;

/**
 * The contrast the whole ladder is normalised to, whatever its length.
 *
 * `noise.ts`'s `fbm3(2)` — what both media used until now — is two octaves at
 * amplitudes 0.5 and 0.25 over a field with the same construction and therefore
 * the same per-octave deviation, so its own deviation is proportional to
 * `hypot(0.5, 0.25)`. Dividing each ladder by its own root-sum-square and
 * multiplying by this reproduces that deviation exactly at *any* octave count.
 *
 * That is the property worth having and it is not free by default: without it,
 * `octaves` would be a contrast knob as well as a detail knob, every one of
 * `contrast`, `dustFrom` and `dustTo` in two files would silently mean
 * something different at 4 than at 2, and nobody would find out except by
 * looking at a comet and disliking it. Octave count now buys detail and only
 * detail.
 */
const NOISE_REFERENCE = Math.hypot(0.5, 0.25);

/**
 * Emit `vec2 mediaNoise(vec3 p)` — the rung every density function calls, and
 * the reason this whole file got roughly twice as cheap.
 *
 * ## Why a texture rather than `noise.ts`
 *
 * The analytic ladder evaluates `hash31` eight times per octave — three
 * `fract`s, a dot product and a multiply each — so the two octaves both media
 * ran on were about sixteen hash evaluations a sample, and a sample happens
 * `steps` times per fragment across a body that can fill the frame.
 * `render/volumeNoise.ts` already builds the answer: a 64³ RGBA8 tileable value
 * noise block whose *construction is identical* — a periodic lattice,
 * smoothstep-interpolated on each axis — so a trilinear fetch is the same
 * function evaluated in hardware, out of a megabyte that lives in cache.
 *
 * Two fetches for sixteen hashes. That trade is the whole task.
 *
 * The one thing that had to survive it is the *statistics*: both media's
 * `contrast`, `dustFrom` and `dustTo` were flown against the analytic field's
 * own spread, so a swap that changed the spread would have invalidated six
 * tuned numbers in two files without touching a line of either. `NOISE_REFERENCE`
 * is what holds them.
 *
 * ## Why it returns two numbers
 *
 * Because the fetch already paid for them, and because the single field was a
 * real limitation. Both media derived their dust mask and their density mottle
 * from *the same* `g`, so the dustiest place was always the densest place:
 * every thick knot in a comet's tail was, by construction, a dark one, and the
 * medium could not produce the other half of what it is for — a *bright* dense
 * knot with a dark lane in front of it. Two decorrelated fields, at no extra
 * fetch, is what lets density and dustiness disagree.
 *
 * The alternative left on the table is a partial correlation — dust biased
 * toward the dense places rather than independent of them — which is arguably
 * what real dust does. It is one `mix` away in each caller and deliberately not
 * taken here: the bench should hand back two honest fields and let a medium
 * decide how much it wants them to agree.
 *
 * ## What is not here
 *
 * `volumeNoise.ts`'s own `fbm2` is the obvious rung to have taken and was not,
 * for one reason worth writing down so it is not "fixed" later: it is
 * normalised by a hand-picked ×3.4 chosen for the nebula bake's density curves
 * (its own comment says so at length), which puts its deviation near four times
 * the analytic `fbm3(2)` this file's callers were tuned against. Taking it
 * verbatim would have quadrupled every medium's contrast; taking it and
 * dividing the 3.4 back out would be worse, because the number would then be
 * load-bearing in two places that are allowed to disagree. The *texture* is the
 * shared primitive. The ladder over it is this bench's own, and it is nine
 * lines.
 */
export function mediaNoise(octaves: number): string {
  if (!Number.isInteger(octaves) || octaves < 1) {
    throw new Error(`mediaNoise: octave count must be a positive integer, got ${octaves}`);
  }
  const rows = NOISE_LADDER.slice(0, Math.min(octaves, NOISE_LADDER.length));
  const rss = Math.hypot(...rows.map((r) => r.amp));
  const norm = NOISE_REFERENCE / rss;
  const body = rows
    .map((r, i) => {
      const [ox, oy, oz] = r.off;
      const coord = `q * ${r.freq.toFixed(3)} + vec3(${ox}, ${oy}, ${oz})`;
      return `  vec4 t${i} = texture(uNoise, ${coord});\n` +
        `  n += vec2(t${i}.${r.a} - 0.5, t${i}.${r.b} - 0.5) * ${(2 * r.amp).toFixed(4)};`;
    })
    .join("\n");
  return /* glsl */ `
vec2 mediaNoise(vec3 p) {
  vec3 q = p * ${MEDIA_NOISE_SCALE.toFixed(6)};
  vec2 n = vec2(0.0);
${body}
  return n * ${norm.toFixed(5)};
}
`;
}

/** The vertex half. It exists only to hand the fragment shader a world-space
 * point on the proxy hull; everything else is `cameraPosition`, which three
 * supplies to every material for free. */
const VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * The march itself — the part no caller may vary.
 *
 * Front-to-back, which is the choice the whole file turns on. Back-to-front
 * would be the classical "over" order and would forbid the two things that make
 * this affordable and correct at once: you cannot stop early on accumulated
 * opacity if you are compositing from the far end (you do not know yet what is
 * in front), and you cannot attenuate a step by what stands between it and the
 * camera without having already visited that. Running near-to-far, `T` is
 * literally "how much of this reaches the eye" at every step, so both fall out
 * of the same variable.
 *
 * `steps` and `lights` are baked into the source rather than passed as
 * uniforms because ES 1.00 requires loop bounds the compiler can fold. That is
 * the same forcing function `noise.ts`'s `fbm3(n)` records for its octave
 * count, and it has the same consequence: the number belongs beside the
 * argument for it at each call site, not in a menu of prebuilt variants.
 */
function march(steps: number, lights: number): string {
  return /* glsl */ `
varying vec3 vWorld;

uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform float uKeyGain;
uniform float uAmbient;
uniform vec3 uAmbientColor;
uniform float uSigma;
uniform float uAnisotropy;
uniform float uCutoff;
uniform float uFogNear;
uniform float uFogFar;
uniform float uMaxSpan;
uniform float uGrowth;
uniform float uGain;

uniform int uLightCount;
uniform vec3 uLightPos[${lights}];
uniform vec3 uLightColor[${lights}];
uniform float uLightRadius[${lights}];
uniform float uLightGain;

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - cameraPosition);

  float t0;
  float t1;
  if (!mediaBounds(ro, rd, t0, t1)) discard;
  // Behind the eye is not in front of it. Clamping here rather than in the
  // bounds test is what makes "the camera is inside the medium" the ordinary
  // case instead of a branch: t0 simply arrives negative and becomes zero.
  t0 = max(t0, 0.0);
  // A span cap, so a tail seen end-on does not stretch the same budget of
  // samples across three hundred units and lose every feature it has. The far
  // end is fogged to nothing well before this anyway.
  t1 = min(t1, t0 + uMaxSpan);
  if (t1 <= t0) discard;

  // Geometric steps, not uniform ones. A uniform march spends the same world
  // distance on the sample four units from the eye — which covers a handful of
  // pixels — as on the one a hundred and eighty units away, which covers a
  // fraction of one; and the near samples are the ones a player is looking
  // *at*. Growing the step by uGrowth each time puts the resolution where the
  // perspective divide already put the detail, and it is what let the step
  // count come down far enough to fit the budget without the inside of the
  // tail turning to shells. The closed form is the geometric series: the first
  // step is the span divided by the sum of the ratios.
  float ratio = pow(uGrowth, float(${steps}));
  float step0 = (t1 - t0) * (uGrowth - 1.0) / max(ratio - 1.0, 1e-4);
  float jitter = mediaDither(gl_FragCoord.xy);

  vec3 acc = vec3(0.0);
  float trans = 1.0;
  float fogSpan = max(uFogFar - uFogNear, 1.0);
  float dt = step0;
  float t = t0;

  // Hoisted, and it is not a micro-optimisation: the star is *directional*, so
  // the angle between the view ray and the light is the same at every sample
  // along that ray, and evaluating the phase function per step was computing
  // one square root and one divide, twenty times, for a number that could not
  // change. Measured at 3024x1964 with the medium filling the frame it is worth
  // most of a millisecond, which is a quarter of this feature's whole budget.
  // The ambient term is uniform-only and would be hoisted by any compiler; it
  // is written out here beside the one that would not be.
  //
  // hgMulti rather than hg, and this is the one place multiple scattering
  // is genuinely free: three orders of a hoisted expression cost the same as
  // one everywhere it matters, which is per fragment rather than per sample.
  vec3 keyLit = uKeyColor * (uKeyGain * hgMulti(dot(rd, uKeyDir), uAnisotropy));
  vec3 ambientLit = uAmbientColor * uAmbient;

  for (int i = 0; i < ${steps}; i++) {
    if (t > t1) break;
    // Past the fog's far bound nothing contributes anything at all, so there is
    // no reason to keep sampling — a long tail looked at end-on stops at the
    // point the picture stops.
    if (t > uFogFar) break;
    // The dither is applied **per segment, scaled by that segment's own
    // length**, not as one offset on the whole sequence. Offsetting the
    // sequence was the first build and it is subtly wrong once the steps grow:
    // the offset is at most the *first* step, so by the far end — where the
    // steps are three times longer — the jitter covers a third of a segment and
    // the banding it exists to break comes straight back as concentric shells
    // centred on the eye. Flown, seen, fixed.
    vec3 p = ro + rd * (t + dt * jitter);

    Media m = mediaSample(p);
    // Vacuum costs a shape test and nothing else — no phase function, no light
    // loop, no noise beyond whatever mediaSample already decided to skip. The
    // advance has to happen on this path too, which is why it is written out
    // rather than left to a bare continue.
    if (m.density <= 0.0005) {
      t += dt;
      dt *= uGrowth;
      continue;
    }

    // Beer-Lambert across this step, not a linear alpha: a step twice as long
    // through the same medium is not twice as opaque, and at fourteen samples
    // across a two-hundred-unit tail — with the steps growing as they go — the
    // difference between the two is the whole look of the core.
    float alpha = 1.0 - exp(-m.density * uSigma * dt);

    // Self-emission, then the floor, then the star. 'glow' is not multiplied
    // by 'scatter': a medium that produces its own light does not have to
    // borrow any, which is what separates a comet's outgassing head from the
    // dust it is blowing off.
    vec3 lit = m.tint * (m.glow + ambientLit + keyLit * m.scatter);

    for (int k = 0; k < ${lights}; k++) {
      if (k >= uLightCount) break;
      vec3 dv = uLightPos[k] - p;
      // Floored so a light standing exactly on a sample does not divide by
      // nothing and blow the buffer to white.
      float d2 = max(dot(dv, dv), 1.0);
      vec3 toLight = dv * inversesqrt(d2);
      // three's own cutoff term, restated: (1 - (d/r)^4)^2, which reaches
      // exactly zero at the boundary. Matching it is what keeps a warhead's
      // reach through the gas the same reach it has on the hulls beside it.
      // Written on the *squared* distance so there is no square root and no
      // pow() here: (d/r)^4 is ((d/r)^2)^2, and both halves are already in
      // hand.
      float reach = max(uLightRadius[k], 1.0);
      float q = d2 / (reach * reach);
      float f = clamp(1.0 - q * q, 0.0, 1.0);
      f *= f;
      vec3 irradiance = uLightColor[k] * (f / d2);
      // Single-order hg here, where the key light above gets hgMulti, and the
      // asymmetry is measured rather than sloppy. This is the only expression
      // in the file that runs per light *per step*: at 14 steps with four
      // lights and the medium filling the frame, the light loop is the single
      // most expensive thing in the shader, and giving it three scattering
      // orders instead of one measured a further 40% on top of that. The key
      // light's own three orders cost nothing at all, because they are hoisted.
      //
      // It is also the physically defensible half of the split rather than
      // merely the cheap one. Scattering order is a statement about how far
      // light has travelled inside the medium before it reaches the eye: the
      // star's light has crossed the whole tail and bounced accordingly, and a
      // warhead going off twenty units away has not. A flash reads as a flash
      // through its 1/d^2 falloff and its own brief life, not through the width
      // of its scattering lobe.
      lit += m.tint * irradiance * (uLightGain * m.scatter * hg(dot(rd, toLight), uAnisotropy));
    }

    // Fog per step, not per fragment — see MEDIA.fogNear. It attenuates the
    // opacity as well as the light, because gas that has faded to nothing
    // cannot still be hiding what is behind it.
    float fog = 1.0 - clamp((t - uFogNear) / fogSpan, 0.0, 1.0);
    float a = alpha * fog;
    acc += trans * a * lit * uGain;
    trans *= 1.0 - a;
    if (trans < uCutoff) break;

    t += dt;
    dt *= uGrowth;
  }

  gl_FragColor = vec4(acc, 1.0 - trans);
}
`;
}

// ── the material ────────────────────────────────────────────────────────────

export interface MediaOptions {
  /** GLSL declaring `Media mediaSample(vec3 p)` in world space. */
  density: string;
  /** GLSL declaring `bool mediaBounds(vec3 ro, vec3 rd, out float t0, out float t1)`. */
  bounds: string;
  /** Anything the two above need in front of them — uniforms, noise, helpers. */
  prelude?: string;
  /** Samples per march. See `MEDIA.steps`. */
  steps?: number;
  /** Injected point lights compiled in. See `MEDIA.lights`. */
  lights?: number;
  /** The caller's own uniforms, merged over the core's. */
  uniforms?: Record<string, IUniform>;
  /** Rows of the `mediaNoise` ladder. Omit to leave the noise out entirely —
   * a medium with an analytic density has no use for it, and omitting it also
   * spares that material the `sampler3D` binding and the 1 MB field. */
  octaves?: number;
}

/**
 * Bench overrides, and the only mutable state in this file.
 *
 * `steps` cannot be a tuning-console knob: it is baked into the emitted GLSL
 * (ES 3.00 wants a loop bound the compiler can fold), so moving it means
 * recompiling a program, which is a hitch and not something to do on a key
 * repeat while flying. But it is also *the* cost dial, and a report that claims
 * a per-step price has to have measured one. So the override exists, it is
 * read at material build time, and the way to use it is to set it and then make
 * the caller rebuild — `__comet.model.show(plan)` and `__shoals.show(seed,
 * sector)` both do.
 *
 * Ungated, on every host, for the reason `mediaQuality`'s own note already
 * gives: a probe gated behind localhost is a probe the harness cannot reach.
 *
 * **This is a bench hook, not the runtime dial.** `render/governor.ts` is being
 * built to move `steps` by frame budget, and it must own that through the
 * dial it registers rather than through this — a global that a measurement
 * script and an adaptive controller both write is a global neither can reason
 * about. If the governor ever needs a hook here, it should get its own.
 * `COMET_MEDIA.steps` and `SHOAL_MEDIA.steps` are the top rung of whatever
 * ladder it builds, not the middle of one.
 */
const OVERRIDE: { steps: number | null; octaves: number | null } = { steps: null, octaves: null };

/**
 * The core's own uniforms, at their defaults. Exported so a caller can read
 * what it is allowed to set without reading the march.
 */
export function mediaUniforms(lights: number): Record<string, IUniform> {
  const pos: Vector3[] = [];
  const col: Color[] = [];
  const rad: number[] = [];
  for (let i = 0; i < lights; i++) {
    pos.push(new Vector3());
    col.push(new Color(0, 0, 0));
    rad.push(1);
  }
  return {
    /** Unit vector from the medium *toward* its star. */
    uKeyDir: { value: new Vector3(0, 0, 1) },
    uKeyColor: { value: new Color(1, 1, 1) },
    uKeyGain: { value: 1 },
    /** A floor so the unlit side of a medium is dim rather than black. Gas
     * with no ambient at all reads as a hole rather than as a cloud. */
    uAmbient: { value: 0.18 },
    uAmbientColor: { value: new Color(0.42, 0.55, 0.72) },
    /** Extinction scale: how opaque a unit of `density` per world unit is. */
    uSigma: { value: 0.06 },
    uAnisotropy: { value: MEDIA.anisotropy },
    uCutoff: { value: MEDIA.cutoff },
    uFogNear: { value: MEDIA.fogNear },
    uFogFar: { value: MEDIA.fogFar },
    uMaxSpan: { value: 400 },
    /**
     * How much longer each step is than the one before it. See the march.
     * 1 would be a uniform march and is a legal value; above about 1.12 the
     * last step of a long span is wider than the features it is meant to
     * resolve, and the far end of a medium starts to shed detail visibly
     * rather than gracefully.
     */
    uGrowth: { value: MEDIA.growth },
    /** Overall output gain, in linear light. The chain downstream is HDR, so
     * values above 1 are a bloom decision rather than a clip. */
    uGain: { value: 1 },
    uLightCount: { value: 0 },
    uLightPos: { value: pos },
    uLightColor: { value: col },
    uLightRadius: { value: rad },
    uLightGain: { value: 1 },
  };
}

/**
 * Build the material. The emitted source is, in order: the struct, the phase
 * function, the dither, the noise ladder (if asked for), the caller's prelude,
 * its bounds, its density, then the march — which is dependency order, and it
 * is a correctness requirement rather than a style, for the same reason
 * `noise.ts`'s own header gives: GLSL ES has no forward declarations in
 * practice.
 */
export function mediaMaterial(opts: MediaOptions): ShaderMaterial {
  const steps = OVERRIDE.steps ?? opts.steps ?? MEDIA.steps;
  const lights = opts.lights ?? MEDIA.lights;
  const octaves = opts.octaves ? (OVERRIDE.octaves ?? opts.octaves) : 0;
  // The field, and the `sampler3D` that reads it, only for a medium that asked
  // for noise. A purely analytic density pays neither the binding nor the
  // megabyte, and — because `sharedVolumeNoise` is lazy — a session that never
  // builds a noisy medium never spends the ~40 ms building the block either.
  const ladder = octaves ? VOLUME_NOISE_DECL + mediaNoise(octaves) : "";

  const fragment =
    MEDIA_STRUCT +
    MEDIA_PHASE +
    mediaPhaseMs(MEDIA.msOctaves, MEDIA.msFalloff, MEDIA.msEccentricity) +
    MEDIA_DITHER +
    // Both hulls, always, even though no medium uses both. They read no
    // uniforms and take no position on what a medium *is* — they are the two
    // shapes an analytic entry/exit test is worth writing for — and every GLSL
    // compiler drops the unused one. The alternative, making each caller
    // remember to interpolate its own, is exactly the ordering trap
    // `noise.ts`'s header warns about, and it failed on the first shader
    // written against this file.
    MEDIA_BOX +
    MEDIA_CONE +
    ladder +
    (opts.prelude ?? "") +
    opts.bounds +
    opts.density +
    march(steps, lights);

  const material = new ShaderMaterial({
    // **No `glslVersion: GLSL3`, and the omission is load-bearing.** The
    // obvious reading of `sampler3D` says this shader has to ask for GLSL3,
    // because the type does not exist in GLSL ES 1.00. It does not: three r185
    // rewrites every non-raw `ShaderMaterial` to `#version 300 es` regardless,
    // so the type is already there. What `GLSL3` actually changes is that three
    // then stops emitting `pc_fragColor` and its `gl_FragColor` alias, on the
    // grounds that a shader asking for it will declare its own output — so
    // asking would buy nothing and cost this file the one idiom every other
    // shader in the project is written in. `render/NebulaBake.ts` records the
    // same finding, at the cost of one compile error, and it is repeated here
    // rather than cross-referenced because the next person to add a sampler
    // will be reading this file.
    vertexShader: VERTEX,
    fragmentShader: fragment,
    uniforms: {
      ...mediaUniforms(lights),
      // Bound after the core's own and before the caller's, so a medium may
      // still override anything either of them set.
      ...(octaves ? { uNoise: { value: sharedVolumeNoise() } } : {}),
      ...(opts.uniforms ?? {}),
    },
    transparent: true,
    depthWrite: false,
    // See this file's header. The march produces premultiplied colour and a
    // coverage alpha, which is "over" and nothing else.
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
    depthTest: false,
    side: BackSide,
    // three's own fog chunk is not in this shader and `MEDIA.fogNear` is why.
    fog: false,
    // The output is linear HDR by contract; `Stage`'s `ToneMapPass` is the one
    // place this game becomes a picture, and a second operator here would
    // double-apply. See `Stage`'s note on `NoToneMapping`.
    toneMapped: false,
  });
  return material;
}

/**
 * A unit cube, shared. Every proxy hull in this file is a box under a scale, so
 * there is one geometry for all of them — the mesh's transform is read for
 * nothing except covering the volume's silhouette (see the header), which is
 * exactly what a scaled unit cube is for.
 */
let unitBox: BoxGeometry | null = null;
function proxyGeometry(): BoxGeometry {
  if (!unitBox) unitBox = new BoxGeometry(1, 1, 1);
  return unitBox;
}

/**
 * What `injectLights` will read. Structural on purpose: `EventLights` satisfies
 * it without this file importing it, which keeps a renderer from depending on a
 * game system and keeps `eventLights.ts` free to change its own internals.
 * `group.children` is the pool's `PointLight`s, and reading `position`,
 * `color`, `intensity` and `distance` off them is the whole contract.
 */
export interface MediaLightSource {
  readonly group: Object3D;
}

/**
 * A medium: the proxy hull, its material, and the two things every caller has
 * to do every frame that are not its own geometry — point the key light and
 * take in whatever the world is currently lit by.
 */
export class MediaVolume {
  readonly mesh: Mesh;

  private readonly lights: number;
  /** Scratch, so the per-frame light sort allocates nothing. */
  private readonly ranked: { light: PointLight; score: number }[] = [];

  constructor(material: ShaderMaterial, lights: number = MEDIA.lights) {
    this.lights = lights;
    this.mesh = new Mesh(proxyGeometry(), material);
    // Before every other transparent — see the header's note on renderOrder.
    this.mesh.renderOrder = -5;
    // A medium's proxy is often larger than the camera can see the edges of,
    // and three's own bounding sphere test is right about that; the reason to
    // switch culling off is the opposite case, a long tail whose sphere the
    // frustum clips out while the camera stands inside the cone.
    this.mesh.frustumCulled = false;
  }

  get material(): ShaderMaterial {
    return this.mesh.material as ShaderMaterial;
  }

  /** The one uniform accessor worth having, so a caller does not repeat the
   * cast at every line of its own per-frame sync. */
  uniform(name: string): IUniform {
    return this.material.uniforms[name];
  }

  /**
   * Point the medium at its star. `toStar` need not be normalised.
   *
   * `gain` is in the same units as `main.ts`'s own `sun` intensity, so a
   * medium lit at 1.4 is lit as hard as the sector's star lights a hull —
   * which is the only way a call site can be argued with about whether a
   * comet is too bright.
   */
  setKeyLight(toStar: Vector3, colour: Color, gain: number): void {
    (this.uniform("uKeyDir").value as Vector3).copy(toStar).normalize();
    (this.uniform("uKeyColor").value as Color).copy(colour);
    this.uniform("uKeyGain").value = gain;
  }

  /**
   * Take in the world's own event lights — a warhead going off inside the gas,
   * a kill, a hull breach.
   *
   * **This is the shot the whole file is for.** `render/eventLights.ts` already
   * puts real `PointLight`s in the scene for every detonation, and until now
   * they reached only opaque surfaces: hull fills and asteroid clusters. A
   * medium is the one thing in this game that can actually show a flash
   * *travelling* — the phase function makes the gas between the blast and the
   * eye brighten, the 1/d^2 falloff makes it brighten unevenly, and the
   * front-to-back transmittance makes the near dust stay dark in front of it.
   *
   * Selection rather than the whole pool: `MEDIA.lights` slots, filled by
   * irradiance at `centre`, so what gets dropped is what was not going to be
   * seen. Everything about a slot is read straight off the `PointLight` —
   * position, colour, intensity and reach — so a medium and a hull are lit by
   * the same numbers and cannot disagree about how bright a warhead was.
   *
   * Allocation-free after the first call: the scratch array is reused and the
   * uniform vectors are written in place, because this runs once per volume per
   * frame in the middle of the render loop.
   *
   * @param source the pool, or null to go dark.
   * @param centre roughly where the medium is, for the ranking only.
   */
  injectLights(source: MediaLightSource | null, centre: Vector3): void {
    const count = this.uniform("uLightCount");
    if (!source) {
      count.value = 0;
      return;
    }

    this.ranked.length = 0;
    for (const child of source.group.children) {
      const light = child as PointLight;
      if (!light.isPointLight || light.intensity <= 0) continue;
      const d2 = Math.max(light.position.distanceToSquared(centre), 1);
      this.ranked.push({ light, score: light.intensity / d2 });
    }
    if (this.ranked.length === 0) {
      count.value = 0;
      return;
    }
    this.ranked.sort((a, b) => b.score - a.score);

    const pos = this.uniform("uLightPos").value as Vector3[];
    const col = this.uniform("uLightColor").value as Color[];
    const rad = this.uniform("uLightRadius").value as number[];
    const n = Math.min(this.lights, this.ranked.length);
    for (let i = 0; i < n; i++) {
      const light = this.ranked[i].light;
      pos[i].copy(light.position);
      // Colour times candela: the shader divides by d^2 itself, so what it
      // wants is the light's own emitted quantity, not a pre-attenuated one.
      col[i].copy(light.color).multiplyScalar(light.intensity);
      rad[i] = light.distance > 0 ? light.distance : EFFECTIVELY_UNBOUNDED;
    }
    count.value = n;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.material.dispose();
    // The geometry is the shared unit cube and is never disposed here — see
    // `proxyGeometry`. Disposing it would take out every other volume's hull.
  }
}

/** A `PointLight` with `distance = 0` has no cutoff in three at all. The shader
 * needs a finite number for its `(1 - (d/r)^4)^2` term, so "no cutoff" becomes
 * "further than the fog reaches", which is the same thing to anything that can
 * be seen. */
const EFFECTIVELY_UNBOUNDED = 4000;

// ── the one machine this does not run on ────────────────────────────────────

let probed: number | null = null;

/**
 * 1 where a march is affordable, 0 where it is not. Probed once, cached
 * forever.
 *
 * The probe is the GL renderer string, and the case it is looking for is
 * SwiftShader — the software rasteriser headless Chromium falls back to, which
 * `CLAUDE.md`'s own gotchas already record as taking ~0.5 s a frame for the
 * post chain alone. A full-screen march there is seconds, and `tools/
 * playtest.mjs` waits on real time in a dozen places. A caller that gets 0
 * builds no volume and keeps whatever it drew before.
 *
 * **A throwaway context, not `Stage`'s.** `Stage.renderer` is reachable from
 * `main.ts` and from nowhere this file's callers stand, and threading a
 * renderer through `Comet.show` to answer a question asked once at boot would
 * put a rendering dependency into the middle of a gameplay object's
 * constructor. One context, created, read and immediately released, at the
 * first volume built in a session.
 *
 * Overridable through `window.__media.setQuality(0 | 1)` — ungated, on every
 * host, the same reasoning `__tuning` and `__scenery` already take: this is
 * what a bench needs to measure the cost of the thing it just added, and a
 * probe gated behind localhost is a probe the harness cannot reach.
 */
export function mediaQuality(): number {
  if (probed !== null) return probed;
  probed = probe();
  return probed;
}

function probe(): number {
  if (typeof document === "undefined") return 0;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return 0;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
    if (/swiftshader|llvmpipe|software|basic render|paravirtual/i.test(name)) return 0;
    return 1;
  } catch {
    // A probe that throws is a machine this should not be guessing about.
    return 0;
  }
}

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__media = {
    MEDIA,
    quality: () => mediaQuality(),
    setQuality: (q: number) => {
      probed = q;
    },
    /** See `OVERRIDE`. Takes effect on the next material built, not on the ones
     * already standing — pass `null` to hand the decision back to the call
     * sites. */
    override: OVERRIDE,
    setSteps: (n: number | null) => {
      OVERRIDE.steps = n;
    },
    setOctaves: (n: number | null) => {
      OVERRIDE.octaves = n;
    },
  };
}
