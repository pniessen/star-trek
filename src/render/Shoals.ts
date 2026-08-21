import { Color, Group, SRGBColorSpace, Vector3 } from "three";
import { makeRng } from "../chart/rng.js";
import { planLight } from "./light.js";
import { MediaVolume, type MediaLightSource, mediaMaterial, mediaQuality } from "./shaders/media.js";
import type { TraceBuffer } from "./TraceBuffer.js";

/**
 * Gas shoals — scenery task 6. A filament curtain seeded into roughly one
 * sector in five, standing at combat range rather than out on the backdrop:
 * the point of this body, unlike every hero cast by `planHero`
 * (`render/scenery.ts`), is that a run flies *through* it, not around it.
 *
 * **Visual occlusion only.** This body has no opinion on the scanner, on
 * lock, or on cloaking, and never will — that whole vocabulary belongs to
 * one place, `game/comet.ts`'s `interferenceAt`, and a second feature
 * reaching for it would blur the one rule the comet exists to make legible:
 * *inside the tail, no instrument works*, and outside every tail, every
 * instrument does. A hostile standing in a shoal still locks, still fires,
 * and still paints on the scanner exactly as it would in open space — the
 * curtain only ever hides it from the *eye*. See `docs/comet.md` for the
 * feature that does own interference; this file imports nothing from it and
 * calls nothing in it.
 *
 * **The technique is the comet plume's, copied on purpose.** `game/comet.ts`
 * already solved "how do you draw gas so it reads as gas and not as a
 * particle field" — connected strands rather than loose dashes, so the eye
 * follows a line instead of counting specks; a per-filament fade at both
 * ends (`FILAMENT_FADE`, below), because a hard-stopped strand is a visible
 * line-end and a field of them is scatter, which is the exact "collection of
 * vector lines" complaint that technique was built to answer; and a
 * per-filament phase advanced by `drift × dt` rather than by wall-clock time,
 * so the flow is time-based like everything else this game animates (see
 * `CLAUDE.md`'s conventions) and never pulses. Reusing a proven answer to the
 * same visual problem is the point — a shoal that looked like gas by a
 * different route than the comet would be two renderers solving one
 * question.
 *
 * **The colour is desaturated on purpose, and specifically not on
 * luminance.** `COMET_COLOR`'s own history (`game/comet.ts`, and
 * `docs/todo.md`'s entry on it) records the mistake worth not repeating
 * here: the first comet colour obeyed `encounters.md`'s decoration rule on
 * *both* axes — lower saturation and lower luminance than every information
 * hue — which is correct for the backdrop, which nothing ever flies through,
 * and was wrong for a body at fighting range, where it read as nearly
 * invisible once fog took its share. `SHOAL_COLOR` takes the same correction
 * before ever making the mistake: saturation stays low (`0.16`, under the
 * `0.2` ceiling every information hue's own committed saturation sits well
 * above), because saturation — not brightness — is what keeps a colour out
 * of the five-hostile-plus-cyan-plus-magenta vocabulary `palette.ts` owns.
 * Luminance is free to sit wherever it needs to for the strokes to actually
 * read, and `skyTrace`'s own `fog: false` (see `main.ts`) means this body
 * never loses a third of its brightness to the far-plane taper the way a
 * combat-range comet tail would if it shared `trace` instead.
 *
 * Not built as a `VectorObject` or a scene child at all: like the comet's
 * own tail, this is strokes pushed straight into a shared `TraceBuffer` in
 * world space every frame, never accumulated. There is nothing here for `G`
 * to switch between wireframe and occluded — a stroke has no faces to
 * occlude — which is why this class carries no `setMode`.
 */
export const SHOAL = {
  /** Chance a given sector's seed produces a shoal — independent of
   * `planHero`'s own roll (a different hash mix, below), so a shoal can
   * stand in a `"bare"` sector or share one with any hero body at all. One
   * in five: common enough that a war meets several, rare enough that flying
   * through gas is a thing that happens to a sector rather than a texture
   * every sector has. */
  chance: 0.2,
  /** Distance band from world origin the curtain's centre is placed at —
   * combat range (`PHASER.falloffEnd` is 78), not the hundred-plus a hero
   * body stands at, because the whole point is flying through one, not
   * looking at one from across the sector. */
  rangeMin: 60,
  rangeMax: 140,
  /** Width of the curtain across its own face, before jitter. */
  spanBase: 90,
  spanJitter: 22,
  /** How thick the curtain is, front to back, as a fraction of its own
   * width — a curtain, not a cloud, so this stays well under 1. */
  depthFraction: 0.28,
  /** Vertical extent of the curtain — a fixed constant, not seeded per
   * shoal, unlike its width. 26 sits inside the altitude slab's own ~14-unit
   * ceiling each way (`ALTITUDE.ceiling`, `game/altitude.ts`) with margin,
   * so climbing or diving through the gas is a real option within the slab
   * a run already has, not a reason to add a second one. */
  height: 26,
  /** World units per second the gas streams past a fixed point in the
   * curtain, seeded per shoal so not every one drifts at the same rate.
   * Slow: CLAUDE.md is explicit that nothing about this body may pulse, and
   * a strand crossing its own span in a couple of seconds, smoothed by a
   * hundred-odd overlapping neighbours, reads as flow rather than as a beat. */
  driftMin: 2,
  driftMax: 4.5,
  /** Filaments in the curtain, and segments in each — ~1080 of
   * `skyTrace`'s 20000-segment budget (`main.ts`), a twentieth of it for the
   * one shoal a sector ever has standing. */
  filaments: 120,
  filamentSegments: 9,
  /** How much of the curtain's height one filament spans, as a fraction,
   * before its own per-filament jitter — the comet's `filamentSpan` under a
   * different name for a different axis. */
  filamentSpan: 0.32,
  /** Exponent biasing filaments toward the curtain's centre on both the
   * lateral and the depth axis — the comet's `coreBias` again, for the same
   * reason: above 1, it crowds the middle and thins the envelope, which is
   * what gives the curtain a soft edge instead of the hard rectangle a
   * uniform scatter would draw. */
  coreBias: 1.7,
  /** How far a filament is allowed to stray sideways across its own length,
   * as a fraction of the curtain's half-width — small, so a strand still
   * reads as a wandering vertical line and not as a horizontal scrawl. */
  wander: 0.16,
  /** Cycles of that wander per filament's own length — a band, not one
   * number, and randomised per filament along with its own phase (`draw`'s
   * `wobbleFreq`/`wobblePhase`). A single shared frequency was tried first
   * and rejected: every strand bulged out and back to the same base point at
   * exactly its own midpoint, and a hundred and twenty identical bows fanned
   * around a shared, core-biased centre drew a mandala, not a curtain of
   * gas — an orderliness worse than the dead-straight rods it replaced.
   * Randomising the frequency and the phase per filament breaks that
   * symmetry, but the band still has a ceiling: `filamentSegments` is only
   * 9, so above roughly one and a half cycles across a strand's own length
   * there are not enough points left to trace a curve, and the wave folds
   * into a jagged zigzag instead — traded for the mandala, not an
   * improvement on it. */
  wobbleFreqMin: 0.45,
  wobbleFreqMax: 1.2,
} as const;

export interface ShoalPlan {
  /** World bearing, radians, from the origin to the curtain's centre. */
  bearing: number;
  /** Distance from the origin, in world units — `SHOAL.rangeMin`..`rangeMax`. */
  range: number;
  /** Width of the curtain across its own face, in world units. */
  span: number;
  /** World units per second the gas streams past a fixed point. */
  drift: number;
}

/**
 * One sector's shoal, or none. Deterministic in `seed` and `sector` alone,
 * matching every other seeded feature this game plans — `planFixture`,
 * `planHero`, `planPlanet`.
 *
 * A hash mix of its own, distinct from every other one this game rolls a
 * sector feature with — scenery's own (1103515245/12820163/53231), light's
 * (1274126177/741103597/1013904223), Planet's (2654435761/40503/977),
 * GasGiant's (3628273133/2308142839/97354729), comet's
 * (2246822519/3266489917/668265263), Moon's
 * (2971215073/1640531527/3559788179), SunHero's
 * (2166136261/16777619/3405691582) and Asteroids' own two
 * (2901084542/893404357/3927117762, 1159248158/3959036696/2873091622).
 * Reusing any of them would correlate a shoal's placement with another
 * sector feature's own roll — the same furniture problem every one of those
 * files' own comments warns against.
 */
export function planShoal(seed: number, sector: number): ShoalPlan | null {
  const rng = makeRng((seed * 2654435769 + sector * 3432918353 + 461845907) >>> 0);
  if (rng.next() > SHOAL.chance) return null;

  const bearing = rng.next() * Math.PI * 2;
  const range = SHOAL.rangeMin + rng.next() * (SHOAL.rangeMax - SHOAL.rangeMin);
  const span = SHOAL.spanBase + (rng.next() * 2 - 1) * SHOAL.spanJitter;
  const drift = SHOAL.driftMin + rng.next() * (SHOAL.driftMax - SHOAL.driftMin);
  return { bearing, range, span, drift };
}

/**
 * Desaturated luminous teal-grey — see the class header for why saturation,
 * not luminance, is the axis that keeps this out of the information
 * vocabulary `palette.ts` owns (cyan/gold/acid-green/red-orange/violet/
 * magenta, all committed hues at real saturation).
 */
export const SHOAL_COLOR = new Color().setHSL(184 / 360, 0.16, 0.56, SRGBColorSpace);

/** Fraction of a filament's own length that fades in at each end — the
 * comet's `FILAMENT_FADE_IN`/`FILAMENT_FADE_OUT` collapsed to one number,
 * because a curtain's strands have no head-near-the-coma/tail-at-the-tip
 * asymmetry to justify two: both ends of a wandering vertical strand are
 * the same kind of end. */
const FILAMENT_FADE = 0.28;

/**
 * One strand of the curtain. Everything but `head` is fixed at `show` time,
 * so a filament keeps its shape for the shoal's whole life and only its
 * position along the curtain's height moves.
 *
 * `lateral`/`depth` are fractions of the curtain's own half-width/half-depth
 * rather than world distances, the same convention the comet's `radial`
 * takes against the cone — so a filament always sits inside the volume
 * `planShoal` describes, however that volume is later resized.
 */
interface ShoalFilament {
  /** Position of the strand's lower end, in [-span, 1]. Advances with the flow. */
  head: number;
  /** How far up the curtain it reaches from `head`. */
  span: number;
  lateral: number;
  depth: number;
  /** How far the strand strays sideways across its own length, signed. */
  wander: number;
  /** Cycles of that wander across the strand's own length, and where in the
   * cycle it starts — both randomised per filament so the curtain is not a
   * hundred and twenty copies of one wave. See `draw`'s own comment for why
   * a single shared frequency was tried first and rejected. */
  wobbleFreq: number;
  wobblePhase: number;
  /** Per-strand brightness, so the curtain is not uniformly lit. */
  level: number;
}

/**
 * A seed for this shoal's own filament field, derived from the plan rather
 * than carried on it — the same reasoning `comet.ts`'s `seedFrom` gives:
 * `planShoal` is itself deterministic, so hashing its output is enough to
 * make the field repeat on a second visit without a redundant seed field on
 * `ShoalPlan`.
 */
function seedFrom(plan: ShoalPlan): number {
  const mix = (n: number): number => {
    let h = Math.imul(Math.floor(n * 1024) ^ 0x9e3779b9, 2654435761) >>> 0;
    h ^= h >>> 15;
    return h >>> 0;
  };
  return (mix(plan.bearing) ^ mix(plan.range) ^ mix(plan.span) ^ mix(plan.drift)) >>> 0;
}

/**
 * Every number the shoal's medium is — the raymarched half of this file, and
 * the second consumer of `render/shaders/media.ts` after the comet.
 *
 * **Why a curtain is worth marching, given that the comet already proved it.**
 * Because a shoal is the body a run flies *through* at speed, and the filament
 * version could only ever add: a hundred and twenty additive strands are the
 * same brightness whether the dense part of the curtain is between you and the
 * far side or behind you, so flying into one looked exactly like flying out of
 * one. A medium has a front and a back. It gets dark where the dust is thick
 * and bright where a warhead just went off, and the transition from "gas ahead"
 * to "gas around me" is a thing that happens rather than a thing you cross.
 *
 * **What it still refuses to do is unchanged.** Visual occlusion only. This
 * body has no opinion on the scanner, on lock, or on cloaking, and the volume
 * does not give it one — see the class header. The march is a picture; the
 * comet keeps sole ownership of interference.
 *
 * Cheaper than the comet's on every axis — 14 steps against 22, a shorter span,
 * a lower extinction — and the reason is measured rather than assumed. A shoal
 * stands at *combat* range with a 90-unit span, so it fills the frame far more
 * readily than a comet does; and its bounding hull is its exact shape, where
 * the comet's cone sits inside a looser box and skips a share of its samples in
 * vacuum for free.
 *
 * **The per-step comparison in this block used to say the opposite of what it
 * now says, and the correction is worth keeping.** It read "7.9 ms at 12
 * steps — nearly twice the comet's per-step price", from an extrapolation. Both
 * measured directly, at 3024x1964, camera inside a maximum-size body: the box
 * was **0.371 ms a step** against the cone's **0.391** — the same price, not
 * twice it — and after `mediaNoise` moved the noise into a texture the box is
 * the *cheaper* of the two at **0.137** against **0.216**. The vacuum samples
 * the cone skips for free were never the dominant term; the noise the box pays
 * for on every sample was, and it is the thing that got cheap.
 *
 * The 8-step figure that extrapolation forced did survive contact with a real
 * measurement, and that is the part worth saying out loud: a curtain filling
 * the frame at 8 steps was predicted at ~4.2 ms and measured at 4.0 in a live
 * run. The extrapolation was right about the number and wrong about the reason.
 *
 * On top of which `planShoal` rolls independently of `planFixture`, so a
 * curtain and a tail can be standing in one sector: two full-screen marches in
 * one frame is the case that has to fit, not either one alone.
 */
export const SHOAL_MEDIA = {
  /**
   * Samples per march. **Was eight — the lowest number in this whole layer,
   * forced there by cost — and is now fourteen for less than eight used to
   * cost.** `render/shaders/media.ts` now reads its noise out of a 64³ texture
   * rather than evaluating sixteen hashes a sample. Measured on an M2 Max at
   * 3024x1964 with a maximum-size curtain (112 x 26 x 31) and the camera
   * standing inside it, so every pixel is covered:
   *
   * | steps | analytic `fbm3` | `mediaNoise` texture |
   * |------:|----------------:|---------------------:|
   * |     8 |         2.66 ms |              0.94 ms |
   * |    16 |         5.63 ms |              2.04 ms |
   *
   * — **0.371 ms per step before, 0.137 ms after, a 2.7x cut**, and rather more
   * than the comet's 1.8x because a curtain's hull *is* its shape: the comet's
   * cone sits in a looser bound and skips a good share of its samples in vacuum
   * before the noise is ever reached, so it had less noise per step to save.
   * Fourteen steps now cost 1.8 ms where eight used to cost 2.7.
   *
   * The old note's pairing argument survives and is the reason this stops at
   * fourteen rather than going further: a sample every ten world units was
   * matched to `noiseScale` 0.12's ~8-unit base cell, and fourteen halves the
   * spacing to about five, which is now *finer* than the base cell rather than
   * coarser. Past that the march is oversampling its own field and the money
   * would be better spent on the field.
   */
  steps: 14,
  /** Rows of the `mediaNoise` ladder. Three, matching the comet and for the
   * same reason recorded there: the third row is the coarse one, and a curtain
   * 112 units across against a 6-cell tile at `noiseScale` 0.12 (a 50-unit
   * period) is exactly the case where the largest visible feature must not also
   * be the period of the repeat. */
  octaves: 3,
  /** How far a march may run before it stops caring, in world units. A
   * curtain's own longest diagonal is about 100; 150 covers the worst crossing
   * with room and stops a grazing ray from stretching sixteen samples across
   * three hundred units of mostly nothing. */
  maxSpan: 150,
  /** Extinction per unit density per world unit. Lower than the comet's: a
   * shoal must never be a wall, because unlike a comet it carries no rule that
   * would explain why you cannot see. It hides and reveals; it does not blind. */
  sigma: 0.022,
  /** World units per noise unit — a ~8-unit base cell, deliberately close to
   * the march's own sample spacing at `steps: 8`. Finer than that (0.16 was
   * tried) puts detail between the samples, where it becomes dither rather than
   * structure; coarser loses the curtain's character entirely. */
  noiseScale: 0.12,
  /** How far the noise is stretched vertically. A curtain hangs; its structure
   * runs up and down, which is the one thing the filament version got
   * unambiguously right (`ShoalFilament` is a vertical strand) and the one
   * thing worth carrying over unchanged. */
  streak: 3.4,
  /** How hard the noise swings the density either side of the shape term. */
  contrast: 0.95,
  /** Albedo in the dustiest places. Higher than the comet's 0.18: a shoal has
   * no nucleus to shadow, so its dark places are dark by being *thin on light*
   * rather than by standing in front of something bright, and taking them all
   * the way down would read as holes. */
  dustAlbedo: 0.3,
  dustFrom: 0.48,
  dustTo: 0.96,
  /** Henyey-Greenstein asymmetry. Slightly under the comet's 0.45 — a shoal is
   * met from every heading over a whole run rather than approached once, so the
   * brightest and dimmest views of it need to be closer together. */
  anisotropy: 0.38,
  /** How hard the sector's star lights the medium, in `main.ts`'s own `sun`
   * units. Unlike the comet, a shoal has a real `SectorLight` to read
   * (`planLight`), so this multiplies a colour the rest of the sector agrees
   * with. */
  keyGain: 3.0,
  /** How hard an event light — a warhead, a kill — lights it, against the
   * star's own gain. **This is the number the whole feature is for.** A torpedo
   * detonating inside a gas shoal, lighting the medium from within, is the shot
   * that cannot be faked with strokes, and it is priced above the star because
   * a flash is brief and inverse square has already taken most of it back by
   * the time it is a hull's length away. */
  lightGain: 1.2,
  /** The floor the unlit side sits at. */
  ambient: 0.18,
  /** Overall output gain, in linear light. */
  gain: 1,
} as const;

/** The dust. Darker and barely saturated, against `SHOAL_COLOR`'s gas — the
 * same two-component split the comet makes, and for the same reason: the whole
 * read is telling absorbing dust from scattering gas at a glance. */
export const SHOAL_DUST = new Color().setHSL(196 / 360, 0.1, 0.2, SRGBColorSpace);
/** The ambient floor's colour. */
const SHOAL_AMBIENT = new Color().setHSL(190 / 360, 0.34, 0.62, SRGBColorSpace);

/** The curtain's own frame and shape, as uniforms. */
const MEDIA_UNIFORMS = /* glsl */ `
uniform vec3 uCentre;
uniform vec3 uAcross;
uniform vec3 uDepth;
uniform vec3 uExtent;
uniform float uFlow;
uniform float uNoiseScale;
uniform float uStreak;
uniform float uContrast;
uniform float uDustAlbedo;
uniform float uDustFrom;
uniform float uDustTo;
uniform vec3 uGasColor;
uniform vec3 uDustColor;
`;

/**
 * The curtain's hull: the oriented box `planShoal` already describes, tested
 * with the core's own slab routine. The proxy mesh is that same box, so the
 * analytic test and the rasterised hull agree exactly and no fragment is ever
 * rasterised for a ray that misses.
 */
const MEDIA_BOUNDS = /* glsl */ `
bool mediaBounds(vec3 ro, vec3 rd, out float t0, out float t1) {
  return boxSpan(ro, rd, uCentre, uAcross, vec3(0.0, 1.0, 0.0), uDepth, uExtent, t0, t1);
}
`;

/**
 * Density: a soft-edged box times a vertically-streaked noise field.
 *
 * The shape is a product of three parabolic falloffs rather than a smoothstep
 * on the box distance, because a product goes to zero on *every* face at once
 * and reaches its maximum only in the middle — which is exactly the density
 * `SHOAL.coreBias` was approximating by biasing where filaments were allowed to
 * sit. The curtain now *is* dense in the middle and thin at the edges rather
 * than having more strands there, which is the same statement made once instead
 * of a hundred and twenty times.
 */
const MEDIA_DENSITY = /* glsl */ `
Media mediaSample(vec3 p) {
  Media m;
  m.density = 0.0;
  m.tint = uGasColor;
  m.scatter = 1.0;
  m.glow = 0.0;

  vec3 d = p - uCentre;
  vec3 l = vec3(dot(d, uAcross), d.y, dot(d, uDepth)) / uExtent;
  vec3 f = clamp(1.0 - l * l, 0.0, 1.0);
  float shape = f.x * f.y * f.z;
  // A real threshold, not an epsilon. Unlike the comet's cone — where the
  // bounding hull is looser than the shape and half the samples land in vacuum
  // for free — this hull *is* the shape, so every sample is inside the curtain
  // and pays for the noise. Cutting the outer shell, where the parabolic
  // product is already under two percent and contributes nothing an eye could
  // find, is the one place there was a fifth of the cost lying around.
  if (shape <= 0.02) return m;

  vec3 q = vec3(l.x * uExtent.x, (d.y - uFlow) / uStreak, l.z * uExtent.z) * uNoiseScale;
  // The density mottle and the dust mask off two decorrelated fields rather
  // than one — see mediaNoise, and CometMedium's own note for what the
  // single field cost. It matters more here than it does for a comet: a shoal
  // has no glowing head to be dark in front of, so its only source of contrast
  // is knots that are bright and knots that are dark standing beside each
  // other, and one field could only ever produce the second kind.
  vec2 n = mediaNoise(q);
  float g = clamp(0.5 + 0.5 * n.x, 0.0, 1.0);

  float dust = smoothstep(uDustFrom, uDustTo, clamp(0.5 + 0.5 * n.y, 0.0, 1.0));
  m.density = shape * mix(1.0 - uContrast, 1.0 + uContrast, g);
  m.tint = mix(uGasColor, uDustColor, dust);
  m.scatter = mix(1.0, uDustAlbedo, dust);
  return m;
}
`;

export class Shoals {
  /**
   * The one scene node this body owns, added by `main.ts` beside the giant and
   * the moon. Everything the curtain draws hangs here, so hiding it is the
   * same gesture that hides every other body — which is what `__scenery`'s
   * switch needs, and what the old `onBeforeRender` latch was standing in for.
   */
  readonly object = Object.assign(new Group(), { name: "shoals" });

  plan: ShoalPlan | null = null;

  /**
   * The curtain as a raymarched medium, or `null` where a march is not
   * affordable — see `mediaQuality`. `null` is not a failure mode, it is the
   * filament renderer below, unchanged: `tools/playtest.mjs` runs on headless
   * software GL and sees exactly the shoal it always saw.
   */
  medium: MediaVolume | null = null;

  private key = "";
  private readonly filaments: ShoalFilament[] = [];
  /** Scrolled upward by `plan.drift * dt`, in world units. Time-based, per the
   * house rule, and the only thing about the medium that moves. */
  private flow = 0;
  private readonly centre = new Vector3();
  private readonly toStar = new Vector3();
  /** Set every frame `draw` runs. See `mount` for the latch it drives. */

  /** Rebuild for a sector, if it is not already the one standing — the same
   * key-cache idiom `Planet.show`/`Asteroids.show` use. `main.ts` only calls
   * this from the sector-change block, so the guard here is a second line
   * of defence rather than the only one. */
  show(seed: number, sector: number): void {
    const key = `${seed}:${sector}`;
    if (key === this.key) return;
    this.key = key;
    this.filaments.length = 0;
    this.medium?.dispose();
    this.medium = null;
    this.plan = planShoal(seed, sector);
    if (!this.plan) return;

    // The volume, if this machine can afford one. Built here rather than in
    // `draw` because it is the one place that knows the sector — and the
    // sector is what `planLight` needs, which is the whole reason a shoal can
    // be lit by the star the rest of the sector agrees on where the comet has
    // to infer its own from the direction its tail points.
    this.medium = this.buildMedium(seed, sector, this.plan);
    if (this.medium) return;

    const rng = makeRng(seedFrom(this.plan));
    for (let i = 0; i < SHOAL.filaments; i++) {
      const span = SHOAL.filamentSpan * (0.55 + rng.next() * 0.9);
      const signedBias = (): number => {
        const v = rng.next() ** SHOAL.coreBias;
        return rng.next() < 0.5 ? -v : v;
      };
      this.filaments.push({
        // Seeded across the whole cycle including the negative part, so the
        // curtain is already mid-flow on its first frame — the same reason
        // the comet's own `head` draw does this.
        head: rng.next() * (1 + span) - span,
        span,
        lateral: signedBias(),
        depth: signedBias(),
        wander: (rng.next() * 2 - 1) * SHOAL.wander,
        wobbleFreq: SHOAL.wobbleFreqMin + rng.next() * (SHOAL.wobbleFreqMax - SHOAL.wobbleFreqMin),
        wobblePhase: rng.next() * Math.PI * 2,
        level: 0.55 + rng.next() * 0.45,
      });
    }
  }

  /**
   * Streams the curtain and draws it, in one call — unlike the comet, which
   * splits `update`/`draw` because `Session` steps it on a different clock
   * than the render loop reads it on, a shoal has no gameplay state for a
   * session to own, so `main.ts` calls this once a frame with `dt` and
   * nothing else needs to know it exists.
   *
   * Regenerated in full every call and nothing here persists between them
   * beyond each filament's own slowly-advancing `head` — the same contract
   * every other transient in this game keeps with its `TraceBuffer`.
   */
  draw(trace: TraceBuffer, dt: number, lights: MediaLightSource | null = null): void {
    if (!this.plan) return;
    const plan = this.plan;

    // The medium draws itself — it is a scene child, not a stroke — so all
    // there is to do here is stream it, aim its light, and hand it whatever
    // the world is currently lit by.
    //
    // `lights` is optional and defaults to nothing, because `main.ts` calls
    // this as `shoals.draw(skyTrace, dt)` and this file may not change that.
    // Passing `eventLights` as the third argument is the one line that turns a
    // warhead detonating inside the curtain into a flash that lights it.
    if (this.medium) {
      this.streamMedium(plan, dt, lights);
      return;
    }

    const dirX = Math.sin(plan.bearing);
    const dirZ = Math.cos(plan.bearing);
    // Tangential, matching the comet's own `rightX`/`rightZ` construction
    // against its `direction` — the curtain's width runs across this axis,
    // its (much thinner) depth along `dirX`/`dirZ`.
    const rightX = -dirZ;
    const rightZ = dirX;
    const cx = dirX * plan.range;
    const cz = dirZ * plan.range;

    const halfSpan = plan.span / 2;
    const halfDepth = (plan.span * SHOAL.depthFraction) / 2;
    const halfHeight = SHOAL.height / 2;
    const steps = SHOAL.filamentSegments;

    const step = (plan.drift * dt) / SHOAL.height;

    for (const filament of this.filaments) {
      filament.head += step;
      // Re-enters from below rather than from 0, so a strand fades in as it
      // rises instead of appearing whole — the comet's own wrap rule.
      if (filament.head > 1) filament.head -= 1 + filament.span;

      let px = 0;
      let py = 0;
      let pz = 0;
      let previous = -1;

      for (let k = 0; k <= steps; k++) {
        const u = k / steps;
        const along = filament.head + filament.span * u;
        // Outside the curtain's height: break the chain rather than
        // clamping it, or a strand half-emerged would be drawn flattened
        // against the floor or the ceiling.
        if (along < 0 || along > 1) {
          previous = -1;
          continue;
        }

        // A sideways wave across the strand's own length is what makes it
        // read as a wandering strand rather than a straight rod — `y` is
        // already linear in `along`, so a lateral term linear in `u` (tried
        // first) is a second linear term, and two linear terms are a
        // straight line no matter how it is parameterised: dead-straight
        // diagonal rods, precisely the "collection of vector lines" the
        // comet's own filament technique (this file borrows) exists to
        // avoid. A single shared `sin(u * PI)` bow was tried next and was
        // worse: every strand bulges out and back to the same point at
        // exactly its own midpoint, so a hundred and twenty of them fanned
        // around the curtain's core-biased centre drew a mandala of
        // matching arcs — too orderly to read as gas. `wobbleFreq` and
        // `wobblePhase` are randomised per filament (see `SHOAL.wander`'s
        // own comment) so the wave's period and start point differ strand
        // to strand, which is what actually breaks the symmetry.
        const lateral =
          filament.lateral + filament.wander * Math.sin(u * Math.PI * filament.wobbleFreq + filament.wobblePhase);
        const x = cx + rightX * lateral * halfSpan + dirX * filament.depth * halfDepth;
        const y = -halfHeight + along * SHOAL.height;
        const z = cz + rightZ * lateral * halfSpan + dirZ * filament.depth * halfDepth;

        if (previous >= 0) {
          // Tapers to nothing at both of the strand's own ends — see
          // `FILAMENT_FADE` for why this is the single most load-bearing
          // number for whether this reads as gas rather than scatter.
          const mid = (u + previous) / 2;
          const ends = Math.min(1, mid / FILAMENT_FADE, (1 - mid) / FILAMENT_FADE);
          // Softer toward the curtain's own edge, on top of the density
          // `coreBias` already gave the field — a filament sitting near the
          // boundary is dimmer as well as rarer.
          const edge = 1 - 0.45 * Math.max(Math.abs(filament.lateral), Math.abs(filament.depth));
          const level = filament.level * ends * Math.max(0, edge);
          if (level > 0.02) trace.push(px, py, pz, x, y, z, SHOAL_COLOR, level);
        }

        px = x;
        py = y;
        pz = z;
        previous = u;
      }
    }
  }

  /** Torn down on a sector change or a run restart — the same moment
   * `Planet.hide`/`Asteroids.hide` are. */
  hide(): void {
    if (this.key === "") return;
    this.key = "";
    this.plan = null;
    this.filaments.length = 0;
    this.medium?.dispose();
    this.medium = null;
  }

  /**
   * Stand a volume up for this sector's curtain, or return `null` where a
   * march cannot be afforded.
   *
   * The proxy hull *is* the oriented box the bounds test uses, rather than a
   * looser cover: a curtain is already a box, so there is no shape here for a
   * hull to be generous about, and every rasterised fragment is one the march
   * has something to say about.
   */
  private buildMedium(seed: number, sector: number, plan: ShoalPlan): MediaVolume | null {
    if (mediaQuality() <= 0) return null;

    const dirX = Math.sin(plan.bearing);
    const dirZ = Math.cos(plan.bearing);
    const across = new Vector3(-dirZ, 0, dirX);
    const depth = new Vector3(dirX, 0, dirZ);
    const extent = new Vector3(plan.span / 2, SHOAL.height / 2, (plan.span * SHOAL.depthFraction) / 2);
    this.centre.set(dirX * plan.range, 0, dirZ * plan.range);

    const material = mediaMaterial({
      steps: SHOAL_MEDIA.steps,
      octaves: SHOAL_MEDIA.octaves,
      prelude: MEDIA_UNIFORMS,
      bounds: MEDIA_BOUNDS,
      density: MEDIA_DENSITY,
      uniforms: {
        uCentre: { value: this.centre.clone() },
        uAcross: { value: across },
        uDepth: { value: depth },
        uExtent: { value: extent },
        uFlow: { value: 0 },
        uNoiseScale: { value: SHOAL_MEDIA.noiseScale },
        uStreak: { value: SHOAL_MEDIA.streak },
        uContrast: { value: SHOAL_MEDIA.contrast },
        uDustAlbedo: { value: SHOAL_MEDIA.dustAlbedo },
        uDustFrom: { value: SHOAL_MEDIA.dustFrom },
        uDustTo: { value: SHOAL_MEDIA.dustTo },
        uGasColor: { value: SHOAL_COLOR.clone() },
        uDustColor: { value: SHOAL_DUST.clone() },
        uSigma: { value: SHOAL_MEDIA.sigma },
        uGain: { value: SHOAL_MEDIA.gain },
        uAmbient: { value: SHOAL_MEDIA.ambient },
        uAmbientColor: { value: SHOAL_AMBIENT.clone() },
        uAnisotropy: { value: SHOAL_MEDIA.anisotropy },
        uMaxSpan: { value: SHOAL_MEDIA.maxSpan },
        uLightGain: { value: SHOAL_MEDIA.lightGain },
      },
    });

    const volume = new MediaVolume(material);
    volume.mesh.position.copy(this.centre);
    volume.mesh.quaternion.setFromUnitVectors(FORWARD, depth);
    volume.mesh.scale.set(extent.x * 2, extent.y * 2, extent.z * 2);

    // The sector's own star, read the same way every other body reads it.
    const light = planLight(seed, sector);
    this.toStar.copy(light.position).sub(this.centre);
    volume.setKeyLight(this.toStar, light.colour, SHOAL_MEDIA.keyGain);

    // The latch. `main.ts` gates this body behind `shoalsVisible`
    // (`__scenery`'s own switch) by *not calling `draw`* — which works
    // perfectly for a stroke renderer that has to be re-pushed every frame and
    // not at all for a scene child that draws itself. `draw` therefore raises
    // `asked` and makes the mesh visible, and this hook lowers both again on
    // the way past, so the volume renders exactly on the frames its owner asked
    // for it and disappears within one frame of the owner stopping. One frame
    // of lag, self-healing in both directions, and nothing outside this file
    // has to learn a new call.
    // Mounted once, here. The old build had no scene node of its own and hung
    // the hull off `trace.object.parent`, with an `onBeforeRender` latch to
    // make `__scenery`'s switch — which gates a *call*, not a scene child —
    // reach a body that draws itself. Both were honest workarounds for this
    // file not being allowed to add a line to `main.ts`. It is now, so the
    // indirection is gone: `object` is a real node, `main.ts` adds it beside
    // every other body, and the switch toggles it the same way it toggles them.
    this.object.add(volume.mesh);
    return volume;
  }

  /**
   * Per-frame: stream the field, take in the world's event lights, and make
   * sure the hull is mounted and visible.
   *
   * **Mounted from the trace's own parent**, which deserves an explanation
   * rather than an apology. Every other body in this game is scene-added by
   * `main.ts` at boot (`stage.scene.add(giant.object)` and its neighbours);
   * this one never was, because until now it had nothing to add — it was
   * strokes, and `main.ts`'s own comment says so in as many words. Adding the
   * line is a one-word change to a file this task may not touch, so the mount
   * comes off the one scene node this class is already handed: `trace.object`
   * is `skyTrace`'s `LineSegments`, added to `stage.scene` at identity, so its
   * parent is the scene. **What should replace this is
   * `stage.scene.add(shoals.object)` beside the other bodies, and a plain
   * `readonly object = new Group()` here** — see this task's report. Until
   * then, this is correct and costs nothing; it is only indirect.
   */
  private streamMedium(plan: ShoalPlan, dt: number, lights: MediaLightSource | null): void {
    const medium = this.medium;
    if (!medium) return;

    this.flow += plan.drift * dt;
    medium.uniform("uFlow").value = this.flow;
    medium.injectLights(lights, this.centre);

  }

}

const FORWARD = new Vector3(0, 0, 1);
