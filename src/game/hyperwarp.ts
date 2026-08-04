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

  begin(duration: number = HYPERWARP.charge): void {
    if (this.phase !== "idle") return;
    this.phase = "charging";
    this.duration = Math.max(0.1, duration);
    this.collapsed = false;
  }

  /** Releasing early spends the energy for nothing. That is the price. */
  cancel(): void {
    this.phase = "idle";
    this.progress = 0;
  }

  get charging(): boolean {
    return this.phase === "charging";
  }

  /** Returns true on the frame the jump fires. */
  update(dt: number, player: Ship): boolean {
    if (this.phase !== "charging") return false;

    player.energy = Math.max(0, player.energy - HYPERWARP.drainPerSecond * dt);
    if (player.energy <= 0) {
      this.cancel();
      this.collapsed = true;
      return false;
    }

    this.progress += dt / this.duration;
    if (this.progress < 1) return false;

    this.cancel();
    return true;
  }
}
