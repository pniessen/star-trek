import { MathUtils, Vector3 } from "three";
import { NO_REFITS, type Loadout } from "../chart/economy.js";
import { ALTITUDE, flight } from "./altitude.js";
import { TORPEDO } from "./weapons.js";

export interface ShipInput {
  turn: number; // -1 left … +1 right
  thrust: number; // -1 reverse … +1 forward
  /**
   * The altitude keys, held. `dive` used not to exist: the plane was a floor and
   * "down" was what happened when you stopped asking.
   *
   * It exists now because the floor was the one thing you could be pinned
   * against — trapped between something above and the deck below, with no
   * downward answer — and because "under" is a tactical verb a taller ceiling
   * cannot supply. See `altitude.ts` for why this costs a second binding and
   * what had to be preserved to make it worth one.
   */
  climb?: boolean;
  dive?: boolean;
  /** Moored: the ship may turn but cannot translate. */
  held?: boolean;
}

export type ShieldFacing = "fore" | "starboard" | "aft" | "port";
export const FACINGS: readonly ShieldFacing[] = ["fore", "starboard", "aft", "port"];

/**
 * Flight on a floor, Asteroids-style: you rotate, you thrust along your facing,
 * and momentum carries you. The skill is still rotational — there is no pitch
 * input and there never will be, because both hands are already full.
 *
 * What there is, is one held key that lifts the ship off the floor into a
 * shallow slab and one that puts it back: the same one, let go. See
 * `altitude.ts` for why the plane was unlocked and what replaced it. Everything
 * else here is unchanged, including `facingFrom` — the four shields are a ring
 * and were always a ring.
 *
 * One energy pool feeds thrust, shields, weapons and now height. Every burn is a
 * shot you cannot take later; that tension is the whole combat design.
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

  /**
   * Nose attitude, radians, positive climbing. Cosmetic in exactly the way
   * `bank` is: the hull does not fly on its nose — there is no pitch input and
   * the guns train in elevation on their own — but a ship that gains fourteen
   * units of height while holding a perfectly level attitude reads as an
   * elevator rather than as a ship.
   */
  pitch = 0;
  /** Units per second of climb or fall this frame. Drives `pitch` and the tape. */
  verticalRate = 0;
  /** True while the climb key is held *and* the reserve can still pay for it. */
  climbing = false;
  /** The same, for the dive key. Never true at the same time as `climbing`. */
  diving = false;

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
    this.updateAltitude(input, dt);

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
    // Altitude is paid for out of the same pool as everything else, scaled by
    // the reserve the same way thrust is — a capacitor bank buys height as well
    // as shots. Charged for as long as the key is held, not only while the
    // number is going up: the ceiling is somewhere you hold, not somewhere you
    // arrive.
    // Charged for leaving the plane, not for going up. Diving is work against
    // nothing in the same way climbing is — the drain was never gravity, it was
    // the price of not being where everything else is — so it costs the same. If
    // it did not, down would be free evasion and nobody would ever climb.
    if (this.climbing || this.diving) {
      this.energy -= (ALTITUDE.drain * dt) / fit.energyReserve;
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

  /**
   * The slab, and the two keys that reach it.
   *
   * **The plane is a rest position, not a floor.** That is the change, and the
   * thing it had to preserve is the *free neutral*: hold nothing and the ship
   * returns to `y = 0` from either side, at no cost, with no input. That is what
   * made one key work in the first place — "down" was free because it was what
   * happened when you stopped asking — and a naive signed slab throws it away.
   * Put neutral in the middle of a range you can only leave *and* re-enter under
   * power, and holding level costs constant input, which plays worse than the
   * floor it replaced. Springing back from both sides keeps the property and
   * spends only a binding.
   *
   * Three rules do all the work now.
   *
   *  - **Either key held moves you away from the plane**; neither held returns
   *    you to it. Away costs energy, back is free.
   *  - **A starved reserve cannot hold you off the plane** — the same shape as
   *    the impulse rule above and legible for the same reason. Run the pool dry
   *    and you drift back to the deck, whichever side you were on.
   *  - **Both keys at once cancel.** Not an error state and not a third
   *    behaviour: it is the same thing as holding neither, which is what a
   *    player mashing both already expects.
   *
   * The scanner survives this, and its own cited precedent is why. `altitude.ts`
   * claimed one-way stalks as a benefit of the floor, but Elite — the authority
   * that argument rests on — put the plane in the middle of its scanner and drew
   * stalks both ways in 1984. Direction is one more bit to read and it reads
   * instantly.
   *
   * Moored is not a state that can leave the plane. `held` means the clamps have
   * you, and the docking sequence owns `y` for the whole of it.
   */
  private updateAltitude(input: ShipInput, dt: number): void {
    if (!flight.threeD) {
      this.position.y = 0;
      this.verticalRate = 0;
      this.climbing = false;
      this.diving = false;
      this.pitch = 0;
      return;
    }

    // Both at once is neither: cancelling is what a player mashing both expects,
    // and it costs no reserve, because nothing is being asked for.
    const wants = (Boolean(input.climb) ? 1 : 0) - (Boolean(input.dive) ? 1 : 0);
    const powered = wants !== 0 && !this.starved && !input.held;
    this.climbing = powered && wants > 0;
    this.diving = powered && wants < 0;

    const before = this.position.y;
    if (!input.held) {
      const target = powered ? ALTITUDE.ceiling * wants : 0;
      // Away from the plane is a climb rate whichever way it points; back toward
      // it is the fall rate. The asymmetry is the point — letting go should feel
      // like letting go, and it should feel that way going up as well as down.
      const step = (powered ? ALTITUDE.climbRate : ALTITUDE.fallRate) * dt;
      this.position.y =
        target > before ? Math.min(target, before + step) : Math.max(target, before - step);
    }
    this.verticalRate = (this.position.y - before) / Math.max(dt, 1e-6);

    // Same treatment `bank` gets: a transient lean toward what the ship is
    // actually doing, eased so a tap does not snap the hull.
    const target = MathUtils.clamp(this.verticalRate / ALTITUDE.climbRate, -1, 1) * 0.22;
    this.pitch += (target - this.pitch) * Math.min(1, dt * 6);
  }

  /** Signed height off the plane. Zero is where everything else still lives. */
  get altitude(): number {
    return this.position.y;
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
    this.pitch = 0;
    this.verticalRate = 0;
    this.climbing = false;
    this.energy = 1;
    this.hull = 1;
    this.torpedoes = this.torpedoCapacity;
    this.impact = 0;
    this.ablative = this.loadout.ablative;
    for (const facing of FACINGS) this.shields[facing] = 1;
  }

  /**
   * Which shield eats a hit arriving from `source`.
   *
   * **A ring, not a sphere, and deliberately so.** This has only ever read `x`
   * and `z`, and adding a slab above the floor does not change that: a bolt
   * arriving from above at bearing 40 degrees hits the same quarter a level bolt
   * from 40 degrees would. A cylinder is the correct model — it is what lets
   * four facings survive a third dimension without becoming six, and turning a
   * fresh quarter toward the shooter stays exactly the skill it was. Do not
   * "fix" this by adding a dorsal and a ventral facing.
   */
  facingFrom(source: Vector3): ShieldFacing {
    const toSource = source.clone().sub(this.position);
    const relative = Math.atan2(toSource.x, toSource.z) - this.heading;
    const normalised = ((relative % (Math.PI * 2)) + Math.PI * 2.25) % (Math.PI * 2);
    return FACINGS[Math.floor(normalised / (Math.PI / 2)) % 4];
  }
}
