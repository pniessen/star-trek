import { MathUtils, Vector3 } from "three";
import { PALETTE } from "../render/palette.js";
import type { TraceBuffer } from "../render/TraceBuffer.js";
import type { VectorObject } from "../render/VectorObject.js";
import type { DebrisField } from "./debris.js";
import type { Ship } from "./Ship.js";

/**
 * Dying, as an event rather than a stopped clock.
 *
 * The first version set a flag and printed SHIP LOST over a still-flying ship,
 * which is the same mistake docking made before it was a sequence: six state
 * changes resolving silently in one frame feel like nothing. A run ends once;
 * it is the most important moment the game has and it was the cheapest one.
 *
 * So dying has a beginning, a middle and an end, and every part of it is
 * something the game already knows how to do. The hull comes apart into the
 * strokes that drew it — the same debris field every hostile you killed went
 * through, which is the point: you are paid out in the currency you spent.
 * Hit-stop holds the moment. The camera lets go of the ship it was following
 * and withdraws, so the last thing you are shown is the wreck getting smaller.
 * The instruments brown out rather than blinking off, because a panel that
 * vanishes reads as a bug and a panel that sags reads as a ship. Only then,
 * on whatever power is left, the run is added up.
 */
export type DeathPhase = "none" | "breakup" | "drift" | "tally";

/** Cumulative seconds from the moment the hull goes. */
const TIMING = {
  /** The hull comes apart and the instrument supply fails with it. */
  breakup: 0.55,
  /** Wreck drift: the camera withdraws and the shards burn down. Nothing is read. */
  drift: 3,
  /** How long the blast ring takes to run out. */
  shock: 0.95,
  /** Emergency power spooling the panel back up for the final readout. */
  restore: 0.5,
} as const;

export class DeathSequence {
  phase: DeathPhase = "none";
  /** Seconds since the hull went, on game time — so hit-stop holds this too. */
  time = 0;
  /** 0→1 instrument supply. The whole HUD is scaled by it. */
  power = 1;
  /** 0→1 how far the camera has withdrawn from the wreck. */
  withdraw = 0;
  /** Decays after the blast; drives the camera shake. */
  shock = 0;

  /** Where it happened. The camera orbits this, not the ship. */
  readonly wreck = new Vector3();
  /** Bearing the camera opens on — off the quarter, not over the shoulder. */
  viewAngle = 0;

  /** The hull object is not drawn once it has become debris. */
  get hidesHull(): boolean {
    return this.phase !== "none";
  }

  /**
   * @param shape  the player's own VectorObject, for its edge list and its
   *   world matrix at the instant it stopped being a ship
   */
  begin(player: Ship, shape: VectorObject, debris: DebrisField): void {
    this.phase = "breakup";
    this.time = 0;
    this.power = 1;
    this.withdraw = 0;
    this.shock = 1;
    this.wreck.copy(player.position);
    this.viewAngle = player.heading + Math.PI * 0.75;

    shape.group.updateMatrixWorld(true);
    // Harder than a hostile's burst, and carrying the ship's own momentum: this
    // is the one explosion the player is inside, and it should own the screen.
    debris.burst(
      shape.edgePositions,
      shape.group.matrixWorld,
      PALETTE.trace,
      player.velocity.clone().multiplyScalar(0.4),
      1.8,
    );

    // The hit shake belongs to the sequence now. Left on the ship it would sit
    // at whatever value the killing blow set and never decay, because a dead
    // ship is never stepped again.
    player.impact = 0;
    player.velocity.multiplyScalar(0.2);
  }

  update(dt: number): void {
    if (this.phase === "none") return;
    this.time += dt;
    this.shock = Math.max(0, this.shock - dt * 1.8);

    if (this.time < TIMING.breakup) {
      this.phase = "breakup";
      // A supply failing rather than a switch thrown: it sags, catches once,
      // and goes. Driven off elapsed time, not off the frame, so the flicker
      // is the same speed on every machine.
      const t = this.time / TIMING.breakup;
      const flicker = Math.sin(this.time * 61) > 0.1 ? 1 : 0.2;
      this.power = (1 - t) * (t > 0.45 ? flicker : 1);
      return;
    }

    if (this.time < TIMING.drift) {
      this.phase = "drift";
      const since = this.time - TIMING.breakup;
      // Dark, but not dead — one blip as the reserve tries the bus and fails.
      this.power = since > 1.15 && since < 1.24 ? 0.3 : 0;
      this.withdraw = easeInOut(
        MathUtils.clamp(since / (TIMING.drift - TIMING.breakup), 0, 1),
      );
      return;
    }

    this.phase = "tally";
    this.withdraw = 1;
    this.power = Math.min(0.95, ((this.time - TIMING.drift) / TIMING.restore) * 0.95);
  }

  reset(): void {
    this.phase = "none";
    this.time = 0;
    this.power = 1;
    this.withdraw = 0;
    this.shock = 0;
  }

  /**
   * The blast: one broken ring running out across the plane, at whatever height
   * the ship was lost at. Drawn in the player's own cyan, because colour is
   * information and the thing that just came apart was yours.
   */
  draw(trace: TraceBuffer): void {
    if (this.phase === "none" || this.time > TIMING.shock) return;

    const t = this.time / TIMING.shock;
    const radius = 3 + t * 52;
    const intensity = (1 - t) * (1 - t) * 2.4;
    const segments = 30;

    for (let i = 0; i < segments; i++) {
      if (i % 4 === 3) continue; // broken, so it reads as a shock and not a hoop
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      trace.push(
        this.wreck.x + Math.cos(a0) * radius,
        this.wreck.y,
        this.wreck.z + Math.sin(a0) * radius,
        this.wreck.x + Math.cos(a1) * radius,
        this.wreck.y,
        this.wreck.z + Math.sin(a1) * radius,
        PALETTE.trace,
        intensity,
      );
    }
  }
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
