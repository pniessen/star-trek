import { MathUtils, Vector3 } from "three";
import { PALETTE } from "../render/palette.js";
import type { TraceBuffer } from "../render/TraceBuffer.js";
import { FACINGS, type Ship } from "./Ship.js";
import { TORPEDO } from "./weapons.js";

/**
 * Docking, as an event rather than a proximity check.
 *
 * The first version simply asked whether you were within sixteen units of the
 * station and slow — so you hovered outside the structure, nothing happened to
 * you, and six state changes resolved silently in one frame. It worked and it
 * felt like nothing.
 *
 * This version has a beginning, a middle and an end. You fly a marked corridor
 * and through a gate; the station takes hold of you and pulls you in, which is
 * the moment control leaves your hands; you are serviced one system at a time
 * while the tally counts up; and you leave deliberately under thrust. Being
 * moored costs you time you cannot spend fighting, and the waves keep coming
 * while you sit there.
 */

export type DockPhase = "none" | "aligning" | "capture" | "moored" | "released";

const GEOMETRY = {
  /** Where the approach gate sits, along -Z from the station. */
  gateOffset: 15,
  /** Where the ship is held once captured. */
  mooringOffset: 7.5,
  /** How near the gate you must be for the tractor to find you. */
  captureRadius: 7,
  maxCaptureSpeed: 16,
  /** How far off the corridor heading you may be, radians. */
  alignTolerance: 0.55,
  /** Range at which guidance appears at all. */
  guidanceRange: 62,
} as const;

const TIMING = {
  capture: 1.35,
  /** Service stages, cumulative seconds. */
  shields: 0.55,
  hull: 1.05,
  energy: 1.65,
  torpedoes: 2.05,
  tally: 2.75,
} as const;

export interface DockGuidance {
  /** Metres off the corridor centreline, signed: negative is to port. */
  readonly lateral: number;
  /** Distance to the gate along the corridor. */
  readonly range: number;
  readonly speed: number;
  readonly speedOk: boolean;
  readonly headingOk: boolean;
  readonly inGate: boolean;
  readonly visible: boolean;
}

export class Docking {
  phase: DockPhase = "none";
  /** 0→1 while the tractor draws you in. */
  captureProgress = 0;
  /** 0→1 across the service sequence. */
  service = 0;
  /** Line currently being reported on the docking panel. */
  status = "";

  private time = 0;
  private readonly gate = new Vector3();
  private readonly mooring = new Vector3();
  private readonly captureFrom = new Vector3();
  private captureHeading = 0;
  private mooringHeading = 0;
  /** System levels at the moment of mooring, so service can fill visibly. */
  private atMooring = { shields: [1, 1, 1, 1], hull: 1, energy: 1, torpedoes: 0 };
  /** Blocks instant re-docking until you have actually left. */
  private rearm = false;
  /**
   * Departure is requested with thrust, which points at the station — so
   * without a window where forward thrust is ignored you shove yourself
   * straight back into the clamps you just left.
   */
  private releaseTimer = 0;

  private guidance: DockGuidance = {
    lateral: 0,
    range: 0,
    speed: 0,
    speedOk: false,
    headingOk: false,
    inGate: false,
    visible: false,
  };

  constructor(private readonly station: Vector3) {
    // The corridor runs along -Z, the side you arrive from. Fixed in world
    // space rather than bolted to the station's idle rotation, so it reads as
    // a navigational aid rather than a moving part.
    this.gate.copy(station).add(new Vector3(0, 0, -GEOMETRY.gateOffset));
    this.mooring.copy(station).add(new Vector3(0, 0, -GEOMETRY.mooringOffset));
  }

  get controlsLocked(): boolean {
    return this.phase === "capture";
  }

  /** True briefly after release, while the push off the clamps carries you. */
  get clearing(): boolean {
    return this.releaseTimer > 0;
  }

  /** Moored ships can turn and shoot but cannot move. */
  get held(): boolean {
    return this.phase === "capture" || this.phase === "moored" || this.phase === "released";
  }

  get info(): DockGuidance {
    return this.guidance;
  }

  reset(): void {
    this.phase = "none";
    this.captureProgress = 0;
    this.service = 0;
    this.status = "";
    this.rearm = false;
    this.releaseTimer = 0;
  }

  /**
   * @param wantsDepart  the player is asking to leave (thrust)
   * @param onMoored     called once, when the clamps engage
   * @param onServiced   called once, when the tally should be banked
   */
  update(
    dt: number,
    player: Ship,
    wantsDepart: boolean,
    onMoored: () => void,
    onServiced: () => void,
  ): void {
    this.time += dt;
    this.releaseTimer = Math.max(0, this.releaseTimer - dt);
    this.measure(player);

    switch (this.phase) {
      case "none":
      case "aligning":
        this.updateApproach(player);
        break;
      case "capture":
        this.updateCapture(dt, player, onMoored);
        break;
      case "moored":
        this.updateService(dt, player, onServiced);
        break;
      case "released":
        if (wantsDepart) this.depart(player);
        break;
    }
  }

  private measure(player: Ship): void {
    const toGate = this.gate.clone().sub(player.position);
    const range = toGate.length();
    // Corridor runs along +Z toward the station, so lateral error is just X.
    const lateral = player.position.x - this.gate.x;
    const heading = Math.abs(wrapAngle(player.heading - 0));

    this.guidance = {
      lateral,
      range,
      speed: player.speed,
      speedOk: player.speed < GEOMETRY.maxCaptureSpeed,
      headingOk: heading < GEOMETRY.alignTolerance,
      inGate: range < GEOMETRY.captureRadius,
      visible: player.position.distanceTo(this.station) < GEOMETRY.guidanceRange,
    };
  }

  private updateApproach(player: Ship): void {
    const g = this.guidance;

    if (!g.visible) {
      this.phase = "none";
      this.rearm = false;
      this.status = "";
      return;
    }

    // Having left the zone once, you may dock again.
    if (g.range > GEOMETRY.captureRadius * 2.2) this.rearm = false;

    this.phase = "aligning";
    this.status = !g.headingOk
      ? "CORRECT HEADING"
      : !g.speedOk
        ? "REDUCE SPEED"
        : g.inGate
          ? "STAND BY FOR CAPTURE"
          : "ON APPROACH";

    if (!this.rearm && g.inGate && g.speedOk && g.headingOk) {
      this.phase = "capture";
      this.captureProgress = 0;
      this.captureFrom.copy(player.position);
      this.captureHeading = player.heading;
      this.mooringHeading = 0; // facing the station, up the corridor
      this.status = "TRACTOR LOCK";
      void player;
    }
  }

  private updateCapture(dt: number, player: Ship, onMoored: () => void): void {
    this.captureProgress = Math.min(1, this.captureProgress + dt / TIMING.capture);
    const t = easeInOut(this.captureProgress);

    player.position.lerpVectors(this.captureFrom, this.mooring, t);
    player.position.y = 0;
    player.velocity.multiplyScalar(1 - Math.min(1, dt * 6));
    player.heading = this.captureHeading + wrapAngle(this.mooringHeading - this.captureHeading) * t;
    player.angularVelocity *= 1 - Math.min(1, dt * 6);

    if (this.captureProgress < 1) return;

    this.phase = "moored";
    this.service = 0;
    this.rearm = true;
    this.atMooring = {
      shields: FACINGS.map((f) => player.shields[f]),
      hull: player.hull,
      energy: player.energy,
      torpedoes: player.torpedoes,
    };
    this.status = "HARD DOCK";
    onMoored();
  }

  /**
   * Systems come back one at a time rather than all at once. The point is not
   * realism — it is that six simultaneous invisible state changes feel like
   * nothing, and the same six staged over two seconds feel like being repaired.
   */
  private updateService(dt: number, player: Ship, onServiced: () => void): void {
    const previous = this.service;
    this.service += dt;

    const ramp = (from: number, to: number) =>
      MathUtils.clamp((this.service - from) / Math.max(to - from, 1e-3), 0, 1);

    const shieldFill = ramp(0, TIMING.shields);
    FACINGS.forEach((facing, index) => {
      player.shields[facing] = MathUtils.lerp(this.atMooring.shields[index], 1, shieldFill);
    });

    player.hull = MathUtils.lerp(this.atMooring.hull, 1, ramp(TIMING.shields, TIMING.hull));
    player.energy = MathUtils.lerp(this.atMooring.energy, 1, ramp(TIMING.hull, TIMING.energy));
    player.torpedoes = Math.round(
      MathUtils.lerp(this.atMooring.torpedoes, TORPEDO.capacity, ramp(TIMING.energy, TIMING.torpedoes)),
    );

    // Announce each stage as it starts, so the sequence reads as steps.
    const announce = (at: number, text: string) => {
      if (previous < at && this.service >= at) this.status = text;
    };
    announce(0, "SHIELDS RECHARGING");
    announce(TIMING.shields, "HULL REPAIR");
    announce(TIMING.hull, "REACTOR TRANSFER");
    announce(TIMING.energy, "REARMING");

    if (previous < TIMING.torpedoes && this.service >= TIMING.torpedoes) {
      this.status = "SALVAGE TRANSFER";
      onServiced();
    }

    if (this.service >= TIMING.tally) {
      this.phase = "released";
      this.status = "MOORING RELEASED — THRUST TO DEPART";
    }
  }

  private depart(player: Ship): void {
    this.phase = "none";
    this.status = "";
    this.captureProgress = 0;
    this.releaseTimer = 0.8;
    // A push off the clamps, so leaving has a shove to it.
    player.velocity.set(Math.sin(player.heading), 0, Math.cos(player.heading)).multiplyScalar(-14);
  }

  /**
   * The corridor, drawn in world space: rails, animated chevrons running toward
   * the station, a gate ring that lights when you are inside it, and the
   * tractor beam once it has you.
   */
  draw(trace: TraceBuffer, player: Ship): void {
    if (!this.guidance.visible && this.phase === "none") return;

    const g = this.gate;
    const s = this.station;
    const locked = this.guidance.headingOk && this.guidance.speedOk;
    const railColor = locked ? PALETTE.trace : PALETTE.traceDim;
    const intensity = locked ? 1.5 : 0.7;

    // Rails, funnelling from wide at the gate to narrow at the station.
    for (const side of [-1, 1]) {
      const steps = 9;
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps;
        const t1 = (i + 1) / steps;
        // Dashes rather than solid lines: a broken rail reads as a marked lane.
        if (i % 2 === 1) continue;
        const w0 = MathUtils.lerp(7.5, 3.2, t0);
        const w1 = MathUtils.lerp(7.5, 3.2, t1);
        trace.push(
          g.x + side * w0,
          0,
          MathUtils.lerp(g.z, s.z - 5, t0),
          g.x + side * w1,
          0,
          MathUtils.lerp(g.z, s.z - 5, t1),
          railColor,
          intensity,
        );
      }
    }

    // Chevrons travelling up the corridor, so the lane has a direction.
    for (let i = 0; i < 3; i++) {
      const t = ((this.time * 0.45 + i / 3) % 1);
      const z = MathUtils.lerp(g.z - 6, s.z - 6, t);
      const w = MathUtils.lerp(7.0, 3.4, t);
      const fade = Math.sin(t * Math.PI) * intensity;
      trace.push(g.x - w, 0, z, g.x, 0, z + 2.6, railColor, fade);
      trace.push(g.x + w, 0, z, g.x, 0, z + 2.6, railColor, fade);
    }

    // The gate itself.
    const gateColor = this.guidance.inGate ? PALETTE.trace : PALETTE.traceDim;
    const gateGlow = this.guidance.inGate ? 2.2 : 0.8;
    const R = GEOMETRY.captureRadius;
    const segments = 20;
    for (let i = 0; i < segments; i++) {
      if (i % 5 === 4) continue; // broken ring, four arcs
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      trace.push(
        g.x + Math.cos(a0) * R,
        Math.sin(a0) * R,
        g.z,
        g.x + Math.cos(a1) * R,
        Math.sin(a1) * R,
        g.z,
        gateColor,
        gateGlow,
      );
    }

    // Tractor beam: converging strokes from the station's ring to the ship.
    if (this.phase === "capture" || this.phase === "moored") {
      const pulse = 0.6 + Math.sin(this.time * 14) * 0.4;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + this.time * 1.6;
        trace.push(
          s.x + Math.cos(a) * 4.6,
          Math.sin(a) * 4.6,
          s.z,
          player.position.x,
          0.4,
          player.position.z,
          PALETTE.magenta,
          pulse * (this.phase === "capture" ? 1.6 : 0.7),
        );
      }
    }
  }
}

function wrapAngle(a: number): number {
  let x = (a + Math.PI) % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x - Math.PI;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
