import { Color, Vector3 } from "three";
import type { TraceBuffer } from "../render/TraceBuffer.js";
import { PALETTE } from "../render/palette.js";

/**
 * The starbase's approach lights.
 *
 * A drum with a ring around it reads as a structure but not as a *destination* —
 * it is the only friendly thing in the sector and it sits there as inert as the
 * grid. Lights fix that for almost nothing, and they do it on the one channel
 * this game has going spare: the starbase is the single object on screen that
 * never moves and never shoots, so a rhythm on it cannot be confused with
 * anything tactical.
 *
 * Four decisions, and each one is a rule this project already had.
 *
 *  - **Strokes, not objects.** Transient marks go through `TraceBuffer`, which is
 *    the locked answer for beams, debris and corridor guides. A light here is a
 *    very short segment at a computed brightness, so the whole feature adds no
 *    geometry, no material and no draw call.
 *  - **No new colour.** Cyan means *ours*, and the starbase is the most ours
 *    thing in the game. Red and green would be the obvious navigation lights and
 *    both are spoken for — red-orange is the Bastion. So the beacons say what
 *    they are with *rhythm* rather than with hue, which is the channel nothing
 *    else in the sector is using.
 *  - **They sequence rather than blink together.** Four lights flashing in unison
 *    is a hazard marker; four running in order is an approach path, and pointing
 *    the run *toward* the corridor mouth makes them say "this way in" — which is
 *    information, not decoration, and is the reason this earns its place.
 *  - **Time-based.** Driven by the same clock the hull's rotation is, so a slow
 *    machine sees a slower station rather than a faster one.
 */
export const BEACON = {
  /**
   * Where the lights sit: the outer ring's radius, matching `buildStarbase`'s
   * torus at 4.6 so a light is *on* the structure rather than floating near it.
   */
  radius: 4.6,
  /** How many run around the ring. Four, to sit on the four spokes. */
  count: 4,
  /**
   * Half-length of a light, in world units. Raised from 0.42 after test play —
   * "barely noticeable" — because at a hundred and eighteen units the old figure
   * was under a pixel of stroke, which is a light you have to already know about
   * in order to see.
   */
  size: 1.15,
  /** Seconds for the sequence to travel once around the ring. */
  period: 2.2,
  /**
   * How sharply a light peaks as the sequence passes it. Higher is a shorter,
   * harder flash; at 1 it is a sine and the ring merely breathes.
   *
   * Softened from 7. A sharp exponent spends most of the cycle near the floor, so
   * the lights were dark far more often than lit — the sequence was technically
   * running and visually absent. Lower keeps each one *up* for longer, which is
   * what makes a chase read as a chase rather than as an occasional twinkle.
   */
  sharpness: 3,
  /**
   * The level a light rests at between flashes. Raised from 0.12: the ring should
   * read as lit even at the bottom of the cycle.
   */
  floor: 0.34,
  /** The two caps on the drum's axis, which pulse together and slower. */
  capHeight: 2.9,
  capPeriod: 3.7,
} as const;

const _tint = new Color();

/**
 * Draw the station's lights for this frame.
 *
 * `spin` is the hull's own Y rotation, passed in rather than read, so the lights
 * are welded to the structure: the ring turns and they turn with it. Getting this
 * wrong is the one way the feature would look broken — lights that stay put while
 * the ring rotates past them read as a rendering fault, not as lights.
 */
export function drawBeacons(
  trace: TraceBuffer,
  centre: Vector3,
  time: number,
  spin: number,
  /**
   * Raised while the player could actually dock here. The lights work harder when
   * there is something to guide you to, which is the whole justification for them
   * being information rather than ornament — see the header.
   */
  emphasis = 0,
): void {
  const colour = PALETTE.trace;

  for (let i = 0; i < BEACON.count; i++) {
    // The same angles the spokes are built at, plus the hull's rotation.
    const angle = (i / BEACON.count) * Math.PI * 2 + Math.PI / 4 + spin;
    // Phase runs against `i` so the flash travels one way around the ring rather
    // than arriving everywhere at once.
    const phase = time / BEACON.period - i / BEACON.count;
    const wave = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
    const lit = BEACON.floor + (1 - BEACON.floor) * wave ** BEACON.sharpness;

    const x = centre.x + Math.cos(angle) * BEACON.radius;
    const z = centre.z + Math.sin(angle) * BEACON.radius;
    // 1.35 at rest rather than 0.7. These are lights on the one friendly
    // structure in the sector; letting them bloom is correct, and the bloom is
    // most of what makes them visible at range.
    const intensity = lit * (1.35 + 0.6 * emphasis);
    // A vertical tick rather than a dot: a single segment has to have length to
    // exist at all, and upright is the one orientation that reads the same from
    // every bearing — which matters when the thing it marks is approached from
    // any direction.
    trace.push(
      x,
      centre.y - BEACON.size,
      z,
      x,
      centre.y + BEACON.size,
      z,
      _tint.copy(colour),
      intensity,
    );
  }

  // The caps: slower, together, and dimmer. They mark the axis rather than the
  // approach, so they deliberately do not join the sequence — two rhythms is how
  // the ring reads as "come in this way" and the drum as "and this is the thing".
  const capWave = 0.5 + 0.5 * Math.sin((time / BEACON.capPeriod) * Math.PI * 2);
  const capLit = (0.22 + 0.9 * capWave ** 3) * (1.1 + 0.5 * emphasis);
  for (const side of [-1, 1]) {
    const y = centre.y + side * BEACON.capHeight;
    trace.push(
      centre.x - BEACON.size * 0.7,
      y,
      centre.z,
      centre.x + BEACON.size * 0.7,
      y,
      centre.z,
      _tint.copy(colour),
      capLit,
    );
  }
}
