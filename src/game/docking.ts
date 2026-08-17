import { MathUtils, Vector3 } from "three";
import { sound } from "../audio/sound.js";
import { PALETTE } from "../render/palette.js";
import type { TraceBuffer } from "../render/TraceBuffer.js";
import { FACINGS, type Ship } from "./Ship.js";

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

export const DOCK_GEOMETRY = {
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
  /**
   * How far off the centreline, as a fraction of `captureRadius`, the
   * A-N radio range's own interlock still calls "on the beam" — see
   * `sound.approach`. Narrower than the gate itself: `inGate` only asks
   * whether you are close enough for the tractor to try, which is a range
   * to the gate, not a claim about being centred on the corridor.
   */
  courseBand: 0.22,
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
  /**
   * On the plane, or near enough to it that the gate can take you.
   *
   * The station, the corridor and the gate all stay at `y = 0` — having to come
   * down to dock is a feature, and it is the price of having spent the run
   * upstairs. `inGate` would have enforced this on its own, since it is a 3D
   * range against a 7-unit radius, but silently: a ship holding the corridor
   * centreline fourteen units up reads as perfectly lined up on every needle the
   * panel has and simply never captures. That is indistinguishable from a bug,
   * so the panel says the word instead.
   */
  readonly altitudeOk: boolean;
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
  /**
   * What this station is called. Written by `Session` from the sector the ship
   * is in — see `chart/naming.ts` — because a place with a name is somewhere
   * you docked and "STARBASE" is a category of object.
   *
   * Held here rather than looked up when drawn: docking knows nothing about
   * campaigns and should keep knowing nothing about them.
   */
  stationName = "STARBASE";

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
  /** Last frame's gate state, so entering it is an edge rather than a level. */
  private inGate = false;

  private guidance: DockGuidance = {
    lateral: 0,
    range: 0,
    speed: 0,
    speedOk: false,
    headingOk: false,
    altitudeOk: true,
    inGate: false,
    visible: false,
  };

  constructor(private readonly station: Vector3) {
    // The corridor runs along -Z, the side you arrive from. Fixed in world
    // space rather than bolted to the station's idle rotation, so it reads as
    // a navigational aid rather than a moving part.
    this.gate.copy(station).add(new Vector3(0, 0, -DOCK_GEOMETRY.gateOffset));
    this.mooring.copy(station).add(new Vector3(0, 0, -DOCK_GEOMETRY.mooringOffset));
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
    this.inGate = false;
    // Guidance is only recomputed while the session is being stepped, so a
    // stale reading survives into a screen that has no run behind it and draws
    // a corridor across the title.
    this.guidance = {
      lateral: 0,
      range: 0,
      speed: 0,
      speedOk: false,
      headingOk: false,
      altitudeOk: true,
      inGate: false,
      visible: false,
    };
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
      speedOk: player.speed < DOCK_GEOMETRY.maxCaptureSpeed,
      headingOk: heading < DOCK_GEOMETRY.alignTolerance,
      // The gate's own radius, reused rather than invented: if you are further
      // off the plane than the gate is wide, the gate cannot have you, and that
      // is exactly the condition `inGate` is about to test in three dimensions.
      altitudeOk: player.position.y < DOCK_GEOMETRY.captureRadius,
      inGate: range < DOCK_GEOMETRY.captureRadius,
      visible: player.position.distanceTo(this.station) < DOCK_GEOMETRY.guidanceRange,
    };
  }

  private updateApproach(player: Ship): void {
    const g = this.guidance;
    const wasInGate = this.inGate;
    this.inGate = g.inGate;
    // Crossing the ring is a thing that happens to you rather than a thing you
    // read off the panel, so it gets a tick.
    if (g.visible && g.inGate && !wasInGate) sound.gate();

    if (!g.visible) {
      this.phase = "none";
      this.rearm = false;
      this.status = "";
      return;
    }

    // Having left the zone once, you may dock again.
    if (g.range > DOCK_GEOMETRY.captureRadius * 2.2) this.rearm = false;

    this.phase = "aligning";
    // Altitude first in the ladder. Every other correction is one you can make
    // while you keep closing; this one is the only one that makes the rest of
    // the readout meaningless while it is true.
    this.status = !g.altitudeOk
      ? "DESCEND TO PLANE"
      : !g.headingOk
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
      // One rising note across the whole capture: the sound of the helm being
      // taken off you, which is what this phase is.
      sound.tractor(TIMING.capture);
      void player;
    }

    // The A-N radio range: only while still aligning, never on the very
    // frame capture engages — `tractor`, just above, already speaks for
    // that moment, and playing both would be two instruments answering the
    // same instant.
    if (this.phase === "aligning") {
      const lateral = MathUtils.clamp(g.lateral / DOCK_GEOMETRY.captureRadius, -1, 1);
      // "On the beam" mirrors `draw()`'s own `locked` read — centred and
      // pointed down the corridor — narrowed to `courseBand` rather than
      // `inGate`'s own wider radius, since `inGate` is a distance-to-gate
      // check and this is a claim about being centred on the corridor.
      const onCourse = g.headingOk && Math.abs(lateral) < DOCK_GEOMETRY.courseBand;
      sound.approach(lateral, onCourse);
    }
  }

  private updateCapture(dt: number, player: Ship, onMoored: () => void): void {
    this.captureProgress = Math.min(1, this.captureProgress + dt / TIMING.capture);
    const t = easeInOut(this.captureProgress);

    // The lerp already lands you on the plane, because the mooring is on it —
    // so the last few units of descent are the tractor's, drawn on the same
    // ease as everything else it does to you. Pinning `y` here instead would
    // snap a ship that entered the gate slightly high, on the one frame the
    // station takes the helm.
    player.position.lerpVectors(this.captureFrom, this.mooring, t);
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
    sound.hardDock();
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
      // Rearms to whatever the loadout carries, not to the stock twelve —
      // torpedo racks that only filled at the start of a run would be an
      // upgrade you lose the moment you use it.
      MathUtils.lerp(this.atMooring.torpedoes, player.torpedoCapacity, ramp(TIMING.energy, TIMING.torpedoes)),
    );

    // Announce each stage as it starts, so the sequence reads as steps — and
    // blip it a note higher each time, so it reads as steps with your eyes
    // somewhere else, which during a wave they will be.
    const announce = (at: number, step: number, text: string) => {
      if (previous >= at || this.service < at) return;
      this.status = text;
      sound.service(step);
    };
    announce(0, 0, "SHIELDS RECHARGING");
    announce(TIMING.shields, 1, "HULL REPAIR");
    announce(TIMING.hull, 2, "REACTOR TRANSFER");
    announce(TIMING.energy, 3, "REARMING");

    if (previous < TIMING.torpedoes && this.service >= TIMING.torpedoes) {
      this.status = "SALVAGE TRANSFER";
      // The one step in this sequence that pays rather than repairs — see
      // `Sound.salvageTransfer`'s own docblock for why it speaks in `MOTIF`
      // instead of `SERVICE_NOTES`, on `panel` instead of `mechanism`.
      sound.salvageTransfer(0, 1);
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
    sound.depart();
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
    const R = DOCK_GEOMETRY.captureRadius;
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
