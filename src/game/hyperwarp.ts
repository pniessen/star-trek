import type { Ship } from "./Ship.js";

export const HYPERWARP = {
  /** Seconds of held commitment before the jump fires. */
  charge: 2,
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
  /** 0-1 through the charge. Drawn as a ring on the HUD. */
  progress = 0;

  begin(): void {
    if (this.phase === "idle") this.phase = "charging";
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
      return false;
    }

    this.progress += dt / HYPERWARP.charge;
    if (this.progress < 1) return false;

    this.cancel();
    return true;
  }
}
