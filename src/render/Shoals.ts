import { Color, SRGBColorSpace } from "three";
import { makeRng } from "../chart/rng.js";
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

export class Shoals {
  plan: ShoalPlan | null = null;

  private key = "";
  private readonly filaments: ShoalFilament[] = [];

  /** Rebuild for a sector, if it is not already the one standing — the same
   * key-cache idiom `Planet.show`/`Asteroids.show` use. `main.ts` only calls
   * this from the sector-change block, so the guard here is a second line
   * of defence rather than the only one. */
  show(seed: number, sector: number): void {
    const key = `${seed}:${sector}`;
    if (key === this.key) return;
    this.key = key;
    this.filaments.length = 0;
    this.plan = planShoal(seed, sector);
    if (!this.plan) return;

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
  draw(trace: TraceBuffer, dt: number): void {
    if (!this.plan) return;
    const plan = this.plan;

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
  }
}
