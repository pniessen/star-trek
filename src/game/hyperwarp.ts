import type { Ship } from "./Ship.js";

export const HYPERWARP = {
  /**
   * Seconds of held commitment for a jump to the sector next door. Longer
   * trips charge for longer — `chart/jump.ts` owns the curve, because the
   * distance it is a function of is grid geometry rather than flight model.
   * Kept here as the fallback duration and as the shape of the constant.
   */
  charge: 1.4,
  /** Energy per second while charging. Spent whether or not you arrive. */
  drainPerSecond: 0.25,
  /** You arrive cold. Fleeing saves the ship, not the situation. */
  arrivalEnergy: 0.25,
  /**
   * Seconds the arrival flourish runs for after the jump lands.
   *
   * Not a game rule — nothing waits on it, nothing is gated by it, and the
   * player has the helm back on the first frame of it. It is here rather than
   * in `warpFx.ts` because the *clock* belongs with the state machine that
   * knows when the jump fired, and because `Session` already feeds this class
   * the dilated `dt` every other timer in a run runs on. A flourish measured in
   * `warpFx`'s own wall clock would keep running at full speed through the
   * hit-stop of whatever greeted you on the far side.
   *
   * 0.85 is a little longer than `Session.arrivalFlash`'s own ~0.6 s decay, so
   * the strokes outlive the starfield stretch rather than cutting out under it.
   */
  arrival: 0.85,
  /**
   * Radians a second the charge's converging rings sweep at, at zero progress
   * and at full. The spread is the whole tell: the cage tightening *faster* as
   * the charge builds is what makes a fixed 1.4-second wind-up feel like it is
   * going somewhere, and it costs one lerp.
   */
  windSlow: 0.5,
  windFast: 3.2,
} as const;

export type HyperwarpPhase = "idle" | "charging";

/**
 * The jump is a commitment rather than a button. You can still turn while it
 * spins up and you cannot fire, which is what makes fleeing a fight you are
 * losing a gamble instead of an exit.
 */
export class Hyperwarp {
  phase: HyperwarpPhase = "idle";
  /** 0-1 through the charge. Drawn as a gauge on the HUD. */
  progress = 0;
  /** Seconds this particular charge takes. Set by `begin` from the distance. */
  duration: number = HYPERWARP.charge;
  /**
   * True on the frame a charge died for want of energy, cleared by whoever
   * reads it.
   *
   * A charge that ends by running the reserve dry is indistinguishable from a
   * dead key unless something says so, and now that distance sets the duration
   * it is a state a player will actually reach — a jump across the board costs
   * more reserve than the ship can hold. `Session` reads this and says it.
   */
  collapsed = false;

  /**
   * Seconds left on the arrival flourish, counting down. 0 at rest.
   *
   * **Deliberately not a third `HyperwarpPhase`.** An "arriving" phase would
   * have been the tidier-looking model and it does not survive contact with
   * how this class is actually driven: `main.ts` calls `session.cancelHyperwarp()`
   * on *every frame Shift is not held*, which reaches `cancel()` here, so any
   * state parked in `phase` after the jump fires would be wiped on the very
   * next frame by a player who has — correctly — already let go of the key.
   * `phase` also leaves this class as a string, through `__probe.hyperwarp`, so
   * widening the union is a change to the harness's vocabulary as well.
   *
   * A timer beside the phase rather than inside it is immune to both: nothing
   * cancels it, nothing reads it as a phase, and it runs itself out.
   */
  arrival = 0;

  /**
   * Radians accumulated by the charge's converging rings. Advances only while
   * charging, and only in `update`, so it is game time like everything else —
   * a cage that spun on the wall clock would keep spinning through hit-stop.
   */
  wind = 0;

  begin(duration: number = HYPERWARP.charge): void {
    if (this.phase !== "idle") return;
    this.phase = "charging";
    this.duration = Math.max(0.1, duration);
    this.collapsed = false;
    // From nothing every time. A cage that resumed where the last aborted
    // charge left it would start mid-sweep, which reads as the ship continuing
    // something rather than committing to it.
    this.wind = 0;
    // The old flourish belongs to the jump before this one; a second commitment
    // inside 0.85 s is rare but a burst and a wind-up on screen together is a
    // frame that says two contradictory things.
    this.arrival = 0;
  }

  /** Releasing early spends the energy for nothing. That is the price. */
  cancel(): void {
    this.phase = "idle";
    this.progress = 0;
    // `wind` and `arrival` are untouched here on purpose — see `arrival`'s own
    // docblock. This method is called every frame the key is not held.
  }

  get charging(): boolean {
    return this.phase === "charging";
  }

  /** 0 at the instant the jump lands, 1 when the flourish is spent. */
  get arrivalProgress(): number {
    return this.arrival > 0 ? 1 - this.arrival / HYPERWARP.arrival : 1;
  }

  /**
   * What `Backdrop.warp` should be fed: the sky's tear, across both halves of
   * the jump rather than only the wind-up.
   *
   * The charge drives it to 1 and the arrival releases it from exactly there,
   * squared so it snaps shut rather than sagging. The continuity is the point —
   * the tear opening over 1.4 seconds and then vanishing on a single frame is
   * what the old `charging ? progress : 0` did, and it made the most dramatic
   * moment in the game the one where an effect switched off.
   */
  get skyTear(): number {
    if (this.phase === "charging") return this.progress;
    if (this.arrival <= 0) return 0;
    const t = this.arrivalProgress;
    return (1 - t) * (1 - t);
  }

  /** Returns true on the frame the jump fires. */
  update(dt: number, player: Ship): boolean {
    // Ahead of the early return below, because the flourish outlives the charge
    // that caused it by definition — this is the one timer here that has to
    // keep running while `phase` is back at "idle".
    if (this.arrival > 0) this.arrival = Math.max(0, this.arrival - dt);

    if (this.phase !== "charging") return false;

    player.energy = Math.max(0, player.energy - HYPERWARP.drainPerSecond * dt);
    if (player.energy <= 0) {
      this.cancel();
      this.collapsed = true;
      return false;
    }

    this.progress += dt / this.duration;
    this.wind += dt * (HYPERWARP.windSlow + (HYPERWARP.windFast - HYPERWARP.windSlow) * this.progress);
    if (this.progress < 1) return false;

    this.cancel();
    this.arrival = HYPERWARP.arrival;
    return true;
  }
}
