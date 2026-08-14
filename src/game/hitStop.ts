/**
 * A few frames of time dilation when something lands.
 *
 * The oldest trick in arcade feel: hold the world back for a moment and the
 * blow reads as having mass. It is also the most dangerous thing to add to this
 * loop, because the loop already clamps `dt` and a clamped `dt` on a slow
 * machine has once cost an hour to what looked like a 100x regression. So this
 * is deliberately *not* a change to the clamp, and it is built so that it can
 * never be mistaken for one:
 *
 *  - it is an explicit named multiplier applied to game seconds only, and the
 *    frame clamp above it is untouched;
 *  - it never freezes. Game time runs at a fraction, not at zero, so a hit and
 *    a stall never look alike;
 *  - overlapping strikes *refresh* the window, they never extend it, and it is
 *    capped besides — a wave dying at once cannot pile up into slow motion;
 *  - it drains on real seconds, so dilation can never slow its own recovery.
 *    That last one is the whole safety argument: the window is bounded in wall
 *    clock time no matter what happens inside it.
 */
export const HIT_STOP = {
  /** Game seconds per real second while a hit is landing. */
  scale: 0.16,
  /** A torpedo landing on something that survived it. */
  impact: 0.055,
  /** A kill. */
  kill: 0.09,
  /** A kill on a Brawler or Miner — kill × 1.5. A bigger hull earns a longer
   * beat. Still clamped by `max`, which `strike` applies regardless. */
  heavyKill: 0.135,
  /** Something reaching your own hull. */
  breach: 0.075,
  /** Your ship coming apart — the only one long enough to read as a beat. */
  death: 0.2,
  /** Hard ceiling on the window, whatever asks for it. */
  max: 0.2,
} as const;

export class HitStop {
  /** Real seconds left in the window. */
  private remaining = 0;

  /** Multiply real seconds by this to get game seconds. */
  get scale(): number {
    return this.remaining > 0 ? HIT_STOP.scale : 1;
  }

  get active(): boolean {
    return this.remaining > 0;
  }

  /** Refresh the window. Never accumulates, never exceeds `HIT_STOP.max`. */
  strike(duration: number): void {
    this.remaining = Math.min(HIT_STOP.max, Math.max(this.remaining, duration));
  }

  /** @param realDt wall-clock seconds — never the dilated ones. */
  advance(realDt: number): void {
    this.remaining = Math.max(0, this.remaining - realDt);
  }

  clear(): void {
    this.remaining = 0;
  }
}
