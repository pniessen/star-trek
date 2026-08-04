import { MathUtils, Vector3 } from "three";
import { NO_REFITS, type Loadout } from "../chart/economy.js";
import { TORPEDO } from "./weapons.js";

export interface ShipInput {
  turn: number; // -1 left … +1 right
  thrust: number; // -1 reverse … +1 forward
  /** Moored: the ship may turn but cannot translate. */
  held?: boolean;
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
  hull = 1;
  // Annotated because `TORPEDO.capacity` is a literal under `as const`, and an
  // inferred field type of `12` refuses every other magazine size.
  torpedoes: number = TORPEDO.capacity;
  phaserCooldown = 0;
  torpedoCooldown = 0;
  /** Non-zero briefly after a hit; drives the HUD flash and the shake. */
  impact = 0;
  /** True while the reserve is dry and the drive is running on impulse alone. */
  starved = false;

  /**
   * What the refits fitted between runs add up to. Set by `Session.restart`
   * from the campaign, so a ship never carries a loadout the chart did not
   * agree to — and defaults to neutral, so a session with no campaign behind
   * it flies exactly the hull this game shipped with.
   */
  loadout: Loadout = NO_REFITS;
  /**
   * Ablative plating, unspent. One per run, so it is reset by `reset()` and
   * nothing else touches it.
   */
  private ablative = false;

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
  /** Reserve at or below which the drive falls back to impulse. */
  private static readonly IMPULSE_FLOOR = 0.02;
  /** Fraction of full thrust available with nothing in the reserve. */
  private static readonly IMPULSE = 0.32;

  /** Rounds carried, which torpedo racks raise. */
  get torpedoCapacity(): number {
    return TORPEDO.capacity + this.loadout.torpedoCapacity;
  }

  update(input: ShipInput, dt: number): void {
    const fit = this.loadout;
    // Impulse: the drive never actually stops.
    //
    // A dry reserve used to mean thrust of exactly zero, and with drag pulling
    // you down that is not a slow ship, it is a stranded one — you float,
    // waiting on a 0.012-a-second trickle, while the wave closes. Running the
    // pool dry should cost you the fight, not the controls.
    //
    // So the reserve buys *speed*, not the right to move at all. Starved, the
    // ship still makes way at a third of full burn, which drag settles at
    // roughly 19 units a second against the usual 59 — enough to limp toward a
    // station, nowhere near enough to run from a Raider doing 44.
    this.starved = this.energy <= Ship.IMPULSE_FLOOR;
    const thrust = this.starved ? input.thrust * Ship.IMPULSE : input.thrust;

    this.angularVelocity += input.turn * Ship.TURN_ACCEL * fit.turnRate * dt;
    this.angularVelocity -= this.angularVelocity * Ship.TURN_DAMP * dt;
    const maxTurn = Ship.MAX_TURN * fit.turnRate;
    this.angularVelocity = MathUtils.clamp(this.angularVelocity, -maxTurn, maxTurn);
    this.heading -= this.angularVelocity * dt;

    // Enough lean to sell the turn, not enough to tip the horizon over. At the
    // old gain a sustained turn held ~50° of roll and the world went sideways.
    const target = -this.angularVelocity * 0.15;
    this.bank += (target - this.bank) * Math.min(1, dt * 5);

    const forward = this.forward();
    this.velocity.addScaledVector(forward, thrust * Ship.THRUST * fit.acceleration * dt);
    this.velocity.addScaledVector(this.velocity, -Ship.DRAG * dt);
    if (this.velocity.lengthSq() > Ship.MAX_SPEED ** 2) {
      this.velocity.setLength(Ship.MAX_SPEED);
    }
    if (input.held) {
      this.velocity.multiplyScalar(1 - Math.min(1, dt * 8));
    } else {
      this.position.addScaledVector(this.velocity, dt);
    }
    this.position.y = 0;

    this.phaserCooldown = Math.max(0, this.phaserCooldown - dt);
    this.torpedoCooldown = Math.max(0, this.torpedoCooldown - dt);
    this.impact = Math.max(0, this.impact - dt * 3);

    // Drains first, then whatever is left trickles back into the reserve. A
    // bigger reserve is modelled as everything drawn from it costing
    // proportionally less, which keeps `energy` a 0-1 fraction and the gauge
    // honest at every loadout.
    // Impulse is free, which is the whole point of it: charging for thrust you
    // only get because you are broke would just hold the reserve at zero and
    // strand you again by a longer route.
    if (!this.starved) {
      this.energy -= (Math.abs(thrust) * Ship.THRUST_DRAIN * dt) / fit.energyReserve;
    }
    let regen = Ship.RESERVE_REGEN * dt;

    // Ablative plating's price: once something has actually reached the hull,
    // the facings stop coming back until a starbase repairs it.
    const shieldsLocked = fit.regenStopsWhenHulled && this.hull < 1;
    if (!shieldsLocked) {
      for (const facing of FACINGS) {
        if (this.shields[facing] >= 1) continue;
        const spend = Math.min(regen, Ship.SHIELD_REGEN * fit.shieldRegen * dt);
        this.shields[facing] = Math.min(1, this.shields[facing] + spend);
        regen -= spend;
        break; // one facing at a time — recovering everything at once is free healing
      }
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

  /**
   * Route a hit. The facing pointed at the shooter absorbs what it can and the
   * remainder reaches the hull — so turning a fresh quarter toward whatever is
   * shooting is the defensive skill, and neglecting to is what kills you.
   *
   * @returns true if any of it reached the hull.
   */
  takeHit(amount: number, source: Vector3): boolean {
    const facing = this.facingFrom(source);
    // Shields stay stored as 0-1 whatever the loadout, so the gauge always
    // reads "how much of this facing is left" rather than an absolute number
    // that means something different every run. Capacity scales what a full
    // facing is worth, not what full looks like.
    const capacity = this.loadout.shieldCapacity;
    const absorbed = Math.min(this.shields[facing] * capacity, amount);
    this.shields[facing] -= absorbed / capacity;
    this.impact = 1;

    const throughput = amount - absorbed;
    if (throughput <= 0) return false;

    // Ablative plating spends itself on the first hit that would have reached
    // the hull. "Absorbed entirely" is taken literally: no hull damage and no
    // breach, so the multiplier survives too. It is paid for by the facings
    // never regenerating again once the hull is finally opened.
    if (this.ablative) {
      this.ablative = false;
      return false;
    }

    this.hull = Math.max(0, this.hull - throughput);
    return true;
  }

  reset(): void {
    this.position.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.heading = 0;
    this.angularVelocity = 0;
    this.bank = 0;
    this.energy = 1;
    this.hull = 1;
    this.torpedoes = this.torpedoCapacity;
    this.impact = 0;
    this.ablative = this.loadout.ablative;
    for (const facing of FACINGS) this.shields[facing] = 1;
  }

  /** Which shield eats a hit arriving from `source`. */
  facingFrom(source: Vector3): ShieldFacing {
    const toSource = source.clone().sub(this.position);
    const relative = Math.atan2(toSource.x, toSource.z) - this.heading;
    const normalised = ((relative % (Math.PI * 2)) + Math.PI * 2.25) % (Math.PI * 2);
    return FACINGS[Math.floor(normalised / (Math.PI / 2)) % 4];
  }
}
