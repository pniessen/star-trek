import { MathUtils, Vector3 } from "three";
import { DOCK_GEOMETRY } from "./docking.js";
import type { Fleet, Hostile } from "./hostiles.js";
import type { Session } from "./session.js";
import type { Ship } from "./Ship.js";

/**
 * The cabinet around the run: a title screen, a demonstration, and the game.
 *
 * An arcade attract loop is the cheapest showcase a game of this kind has —
 * the renderer already makes the spectacle, so the only work is getting out of
 * its way and letting it run with nobody at the controls. Which is exactly what
 * this does: attract mode is not a canned animation or a separate scene, it is
 * the real session with a demo pilot holding the stick. Anything that looks
 * good in the demo is something the game genuinely does.
 *
 * This is a shell *around* the session, not a state inside it. `Session.state`
 * stays the three combat states it has always been — a title screen is not a
 * phase of combat and pretending it was would put a fourth case into every
 * rule that reads the run.
 */
export type PresentationMode = "title" | "attract" | "run";

/** What the demo pilot is asking for this frame, in the player's own verbs. */
export interface PilotInput {
  readonly turn: number;
  readonly thrust: number;
  readonly firePhaser: boolean;
  readonly fireTorpedo: boolean;
}

const TIMING = {
  /** Title hold before the demonstration takes over. */
  title: 13,
  /** How long the demonstration is given to make its case. */
  attract: 34,
  /** The demo's own wreck is left on screen this long before cutting away. */
  demoDeath: 4.5,
  /** An abandoned tally goes back to attracting, the way a cabinet does. */
  abandon: 14,
} as const;

const PILOT = {
  /** Range the pilot tries to fight at. Inside the phaser's full-damage band. */
  engageRange: 24,
  /** Salvage worth flying home for. Below this the demo keeps fighting. */
  bankAt: 500,
  /** Staging point down the corridor, before it straightens up for the gate. */
  stagingOffset: 34,
  /** Steering gain on bearing error. High enough to look decisive. */
  steer: 2.4,
  /** Torpedoes are shown off, not spammed. */
  torpedoInterval: 1.8,
} as const;

export class Presentation {
  mode: PresentationMode = "title";
  /** Real seconds in the current mode. */
  time = 0;
  /**
   * Best of this sitting. Persistence is deliberately not built yet, so this is
   * honestly only that, and it says so on the title screen.
   */
  best = 0;

  /** The gate and the staging point the demo pilot flies to. */
  private readonly gate: Vector3;
  private readonly staging: Vector3;
  private readonly target = new Vector3();
  private torpedoTimer = 0;

  constructor(
    private readonly session: Session,
    private readonly player: Ship,
    private readonly fleet: Fleet,
    station: Vector3,
  ) {
    // The demo flies the same corridor a human does — it gets no private door
    // into the station, because a demonstration of a shortcut is a lie.
    this.gate = station.clone().add(new Vector3(0, 0, -DOCK_GEOMETRY.gateOffset));
    this.staging = this.gate.clone().add(new Vector3(0, 0, -PILOT.stagingOffset));
  }

  /** @param realDt wall-clock seconds; the shell's clock is never dilated. */
  update(realDt: number): void {
    this.time += realDt;

    switch (this.mode) {
      case "title":
        if (this.time >= TIMING.title) this.enter("attract");
        break;

      case "attract":
        // The demonstration ends when it dies or when it has said enough.
        if (this.session.death.phase !== "none") {
          if (this.session.death.time >= TIMING.demoDeath) this.enter("title");
        } else if (this.time >= TIMING.attract) {
          this.enter("title");
        }
        break;

      case "run":
        if (this.session.score > this.best) this.best = this.session.score;
        // Walk away from the tally and the cabinet goes back to attracting.
        // R still restarts directly, so nobody is ever waiting on this.
        if (
          this.session.death.phase === "tally" &&
          this.session.death.time >= TIMING.abandon
        ) {
          this.enter("title");
        }
        break;
    }
  }

  /** Hand the controls to whoever pressed the key. */
  startRun(): void {
    this.enter("run");
  }

  private enter(mode: PresentationMode): void {
    this.mode = mode;
    this.time = 0;
    this.torpedoTimer = 0;
    // Every mode change begins from a clean board — including the title, which
    // must not have the previous run's wreck drifting through it.
    this.session.restart(this.player);
  }

  /**
   * The demo pilot.
   *
   * Not an AI opponent and not a good player: it exists to show the game
   * moving. It closes, it turns, it shoots, and once the pot is worth something
   * it flies the corridor home — because the greed loop is the thing actually
   * worth demonstrating, and it is invisible if the demo only ever fights.
   */
  fly(realDt: number): PilotInput {
    this.torpedoTimer = Math.max(0, this.torpedoTimer - realDt);

    const player = this.player;
    const homing = this.session.bankable >= PILOT.bankAt || player.hull < 0.45;
    const quarry = homing ? null : this.nearest();

    let desired: number;
    let range: number;
    let hold: number;

    if (homing) {
      // Two legs: out to a staging point on the corridor axis, then in at the
      // gate. Steering at the gate rather than holding a fixed corridor heading
      // is what makes the lateral error close itself — the approach instrument
      // tolerates half a radian, and a bearing that homes stays inside it.
      const staged = player.position.distanceTo(this.staging) < 14;
      this.target.copy(staged ? this.gate : this.staging);
      range = player.position.distanceTo(this.target);
      desired = bearingTo(player.position, this.target);
      hold = staged ? 0 : 6;
    } else if (quarry) {
      this.target.copy(quarry.position);
      range = player.position.distanceTo(this.target);
      desired = bearingTo(player.position, this.target);
      hold = PILOT.engageRange;
    } else {
      // Nothing to fight and nothing worth banking: turn on the spot, so the
      // demonstration is never a ship sitting perfectly still.
      return { turn: 0.35, thrust: 0, firePhaser: false, fireTorpedo: false };
    }

    // Screen-right is a *decreasing* heading — see Ship.update — so the sign of
    // the correction inverts on the way to the stick.
    const error = angleDelta(player.heading, desired);
    const turn = MathUtils.clamp(-error * PILOT.steer, -1, 1);

    // Never burn toward the gate above the capture ceiling; the demo has to be
    // able to actually dock at the end of it.
    const ceiling = homing && range < 40 ? DOCK_GEOMETRY.maxCaptureSpeed * 0.8 : Infinity;
    // Only burn when it is roughly pointed at where it wants to be. Thrusting
    // through a hard turn is what a bad autopilot does: momentum accumulates
    // across the turn and the ship ends up sliding away from the fight it is
    // supposed to be demonstrating.
    const aligned = Math.abs(error) < 0.7;
    const thrust =
      range > hold + 4 && aligned && player.speed < ceiling
        ? 1
        : !homing && range < hold - 8
          ? -1 // backed onto, so back off rather than orbit at zero range
          : 0;

    const aimed = Math.abs(error) < 0.14;
    const fireTorpedo =
      !homing && aimed && range > 18 && range < 60 && player.torpedoes > 4 && this.torpedoTimer <= 0;
    if (fireTorpedo) this.torpedoTimer = PILOT.torpedoInterval;

    return {
      turn,
      thrust,
      firePhaser: !homing && aimed && range < 62,
      fireTorpedo,
    };
  }

  private nearest(): Hostile | null {
    let best: Hostile | null = null;
    let bestDistance = Infinity;
    for (const hostile of this.fleet.hostiles) {
      const distance = hostile.position.distanceTo(this.player.position);
      if (distance >= bestDistance) continue;
      best = hostile;
      bestDistance = distance;
    }
    return best;
  }
}

function bearingTo(from: Vector3, to: Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}
