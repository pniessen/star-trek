import { MathUtils, Vector3 } from "three";

export interface ShipInput {
  turn: number; // -1 left … +1 right
  thrust: number; // -1 reverse … +1 forward
}

export type ShieldFacing = "fore" | "starboard" | "aft" | "port";
export const FACINGS: readonly ShieldFacing[] = ["fore", "starboard", "aft", "port"];

/**
 * Flight on a plane, Asteroids-style: you rotate, you thrust along your facing,
 * and momentum carries you. Not because 1979 did it, but because the scanner
 * has to be trustworthy — on a flat sheet every contact is exactly where the
 * map says it is, and the skill becomes rotational.
 *
 * One energy pool feeds thrust, shields and weapons. Every burn is a shot you
 * cannot take later; that tension is the whole combat design.
 */
export class Ship {
  readonly position = new Vector3();
  readonly velocity = new Vector3();

  heading = 0; // radians, 0 = +Z
  angularVelocity = 0;

  energy = 1;
  readonly shields: Record<ShieldFacing, number> = {
    fore: 1,
    starboard: 1,
    aft: 1,
    port: 1,
  };

  /** Roll into turns — pure yaw on a plane reads as a sliding cursor. */
  bank = 0;

  private static readonly TURN_ACCEL = 5.4;
  private static readonly TURN_DAMP = 3.6;
  private static readonly MAX_TURN = 2.1;
  private static readonly THRUST = 26;
  private static readonly DRAG = 0.44;
  private static readonly MAX_SPEED = 62;

  /** Energy per second at full burn. */
  private static readonly THRUST_DRAIN = 0.035;
  private static readonly SHIELD_REGEN = 0.06;
  private static readonly RESERVE_REGEN = 0.012;

  update(input: ShipInput, dt: number): void {
    const starved = this.energy <= 0.02;
    const thrust = starved ? 0 : input.thrust;

    this.angularVelocity += input.turn * Ship.TURN_ACCEL * dt;
    this.angularVelocity -= this.angularVelocity * Ship.TURN_DAMP * dt;
    this.angularVelocity = MathUtils.clamp(this.angularVelocity, -Ship.MAX_TURN, Ship.MAX_TURN);
    this.heading -= this.angularVelocity * dt;

    const target = -this.angularVelocity * 0.42;
    this.bank += (target - this.bank) * Math.min(1, dt * 5);

    const forward = this.forward();
    this.velocity.addScaledVector(forward, thrust * Ship.THRUST * dt);
    this.velocity.addScaledVector(this.velocity, -Ship.DRAG * dt);
    if (this.velocity.lengthSq() > Ship.MAX_SPEED ** 2) {
      this.velocity.setLength(Ship.MAX_SPEED);
    }
    this.position.addScaledVector(this.velocity, dt);
    this.position.y = 0;

    // Drains first, then whatever is left trickles back into the reserve.
    this.energy -= Math.abs(thrust) * Ship.THRUST_DRAIN * dt;
    let regen = Ship.RESERVE_REGEN * dt;

    for (const facing of FACINGS) {
      if (this.shields[facing] >= 1) continue;
      const spend = Math.min(regen, Ship.SHIELD_REGEN * dt);
      this.shields[facing] = Math.min(1, this.shields[facing] + spend);
      regen -= spend;
      break; // one facing at a time — recovering everything at once is free healing
    }

    this.energy = MathUtils.clamp(this.energy + regen, 0, 1);
  }

  forward(out = new Vector3()): Vector3 {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  get speed(): number {
    return this.velocity.length();
  }

  /** Compass bearing in degrees, 0 = +Z, clockwise. */
  get bearing(): number {
    return (MathUtils.radToDeg(this.heading) % 360 + 360) % 360;
  }

  /** Which shield eats a hit arriving from `source`. */
  facingFrom(source: Vector3): ShieldFacing {
    const toSource = source.clone().sub(this.position);
    const relative = Math.atan2(toSource.x, toSource.z) - this.heading;
    const normalised = ((relative % (Math.PI * 2)) + Math.PI * 2.25) % (Math.PI * 2);
    return FACINGS[Math.floor(normalised / (Math.PI / 2)) % 4];
  }
}
