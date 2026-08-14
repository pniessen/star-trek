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
 * Strip and stack — the brace.
 *
 * Four facings that deplete separately is a locked decision, and turning a fresh
 * quarter toward the shooter is meant to be the defensive skill. That skill is
 * free and continuous, and it was the *only* thing a player could do about the
 * shields, so there was no moment where you decided something about them. This
 * is that moment, and there is exactly one of them: **collapse the other three
 * facings into the bow.**
 *
 * Three properties, and each one is load-bearing.
 *
 * **It costs no energy at all.** The single pool already arbitrates thrust,
 * height, phasers and regen; a fifth claimant would just make the brace a thing
 * you cannot afford at precisely the moment you need it. The price here is not a
 * spend, it is a *position* — three empty facings — and a price paid in
 * vulnerability cannot be out-competed by a price paid in energy.
 *
 * **It stacks into the bow, never into "the threatened facing".** The old
 * behaviour hunted for the thinnest quarter, on the reasoning that a player
 * under fire should not also have to work out which one the game thinks is being
 * shot at. That reasoning was right about the problem and wrong about the answer:
 * a game that picks for you cannot be committed to. Choosing the bow costs
 * nothing to explain, needs no HUD target marker, and — this is the real gain —
 * fuses bracing with aiming. Phasers fire forward. Brace and shoot are one
 * posture, so the tactic the brace teaches is *face the thing*, which is the
 * skill the four facings existed to create rather than a substitute for it.
 *
 * **The stack overcharges, and it leaks.** Capping the bow at 1 would make
 * bracing a fresh ship pure loss, so `ceiling` lets one quarter hold more than a
 * facing is worth — that surplus is the whole reward. It then bleeds away at
 * `decay`, which is what keeps this a panic button rather than a build: you brace
 * *for the pass*, and about nine seconds later the ship is simply a ship with
 * three empty facings. Without the leak, tapping the key on cooldown-free repeat
 * would ratchet the bow to the ceiling and hold it there for the whole run, and a
 * commitment you can hold indefinitely is not a commitment.
 *
 * `yield` below 1 is the conversion loss, and it is what stops re-stacking as you
 * turn from being free. It matters less than it looks: a brace leaves the donors
 * at zero, so an immediate second tap moves nothing, and passive shield regen at
 * 0.06 a second on one facing at a time refills them far slower than the surplus
 * drains. The loss is the backstop, not the brake.
 */
export const BRACE = {
  /** Fraction of the stripped charge that arrives. The rest is the conversion loss. */
  yield: 0.7,
  /**
   * The most one facing may hold, in facings. From fresh — 3.0 stripped, 2.1
   * delivered, on top of a full bow — this clamps, which is deliberate: the
   * strongest brace in the game is the one you throw before anything has hit you,
   * and it should not scale with how untouched you are beyond this.
   */
  ceiling: 2.5,
  /** Facings per second the surplus above 1 bleeds off. ~9s from the ceiling. */
  decay: 0.16,
  /**
   * The smallest stack worth three facings. Below this the key declines instead
   * of quietly spending everything for a sliver — see `Ship.brace`.
   */
  minimum: 0.25,
} as const;

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
  /**
   * Which quarter last absorbed a hit, and how bright its world-space arc
   * still is — `shieldFx.ts` draws the flash, `takeHit` sets both and
   * `update` decays `struckFlash` toward 0 at the same rate `impact` decays.
   * `null` until the first hit of a run; `reset` puts it back there.
   */
  struckFacing: ShieldFacing | null = null;
  /** 1 right after a hit, decayed at `× 3/s`; the HUD dial has no analogue. */
  struckFlash = 0;
  /** True while the reserve is dry and the drive is running on impulse alone. */
  starved = false;
  /**
   * How jammed the ship's own position is, 0-1 — set by `Session.stepComet`
   * every frame, in the same shape and for the same reason
   * `Hostile.interference` exists (see `hostiles.ts`, Task 3). This ship does
   * not carry a cloak for it to suppress, so the one thing it drives here is
   * the reserve's own regeneration — see `updateEnergy`'s comment for why a
   * *drain* alone was not enough.
   */
  interference = 0;

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
  /**
   * Halved-ish, twice, and this is the second pass.
   *
   * Test play: docking was happening for *fuel* rather than to bank, which is
   * backwards — the corridor exists to realise a multiplier, and a station you
   * visit because the tank is empty turns the greed loop's one deliberate
   * decision into an errand. Every drain came down together and the trickle came
   * up, so the reserve lasts roughly twice as long as it did.
   */
  private static readonly THRUST_DRAIN = 0.024;
  private static readonly SHIELD_REGEN = 0.06;
  /**
   * The trickle, and it is the floor every other cost is measured against — which
   * is the mistake worth recording here rather than in a commit nobody re-reads.
   *
   * Doubling the ship's endurance by *raising this* looked equivalent to halving
   * the drains and is not. At 0.022 it had climbed above the thrust drain and to
   * within a whisker of the slab's, so cruising paid for itself and holding
   * altitude was free — the one-pool economy, which is a locked decision, quietly
   * stopped existing. `playtest` caught it on the one assertion that only asks
   * whether the reserve falls while the climb key is held.
   *
   * Endurance belongs in the drains. This moves a little, because a slightly
   * faster refill is part of not having to dock, but it stays well under every
   * cost it is competing with.
   */
  private static readonly RESERVE_REGEN = 0.016;
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
    this.struckFlash = Math.max(0, this.struckFlash - dt * 3);

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
    let regen = Ship.RESERVE_REGEN * fit.reserveRegen * dt;

    // A braced bow leaks its surplus. See `BRACE`: this is the single line that
    // keeps the brace a moment rather than a stance, and it is charged for on
    // real seconds like everything else that decays.
    for (const facing of FACINGS) {
      if (this.shields[facing] > 1) {
        this.shields[facing] = Math.max(1, this.shields[facing] - BRACE.decay * dt);
      }
    }

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

    // Suppressed by `interference`, not the shield spend above — a comet is
    // the reason this line exists. `docs/comet.md` §2 is one rule, "inside
    // the tail, no instrument works", and every effect is supposed to be a
    // consequence of it rather than an item tuned apart from it. Whatever
    // tops the tank back up is an instrument, so jamming it is the same
    // sentence cloak suppression and fire-control suppression already come
    // from — draining the tank while leaving the recharge running was the
    // weaker reading, and it was also exploitable: draining and regen scale
    // by two *independent* multipliers (`fit.energyReserve`,
    // `fit.reserveRegen`), so no constant on the drain alone can hold across
    // every loadout — stack a deep reserve with a slow-regen refit and the
    // drain can be outrun no matter how it is tuned, right when the player
    // is best equipped to do it. Suppressing the source instead closes that
    // at the root: a refit that raises `reserveRegen` still raises it, it
    // just has nothing to multiply while `interference` is at its ceiling.
    // At `interference` 0 (open space, or `Comet` fully unwired below) this
    // is exactly the term this replaced, byte for byte.
    this.energy = MathUtils.clamp(this.energy + regen * (1 - this.interference), 0, 1);
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
    this.struckFacing = facing;
    this.struckFlash = 1;

    // The era's skin. A hull multiplier below one is the NX's whole character:
    // its facings are barely worth the name, so what gets past them has to hurt
    // less or the ship is simply worse rather than different. Applied after the
    // shields rather than before, so it is armour and not a second shield.
    const throughput = (amount - absorbed) * this.loadout.hullArmour;
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

  /**
   * Strip the three after facings and stack what survives the conversion into
   * the bow. See `BRACE` for why it is the bow, why it costs nothing, and why
   * the surplus leaks.
   *
   * **It refuses rather than half-works**, and that is not politeness. Stripping
   * everything is the honest reading of the verb and it is what makes the *timing*
   * of the tap a real decision — brace too early and you threw three facings away
   * for a stack you did not need. But a bow already near the ceiling would strip
   * all three for a sliver, and that is a trap rather than a decision: nothing
   * about the situation tells the player the key is about to do almost nothing. So
   * it declines below `minimum`, the same way cracking a warhead declines above
   * `SCRAM.ceiling`, and the caller says which refusal it was.
   */
  brace(): "braced" | "nothing-to-stack" | "already-braced" {
    if (BRACE.ceiling - this.shields.fore < BRACE.minimum) return "already-braced";

    const donors = FACINGS.filter((facing) => facing !== "fore");
    const stripped = donors.reduce((sum, facing) => sum + this.shields[facing], 0);
    const gain = Math.min(stripped * BRACE.yield, BRACE.ceiling - this.shields.fore);
    if (gain < BRACE.minimum) return "nothing-to-stack";

    for (const facing of donors) this.shields[facing] = 0;
    this.shields.fore += gain;
    return "braced";
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
    this.struckFacing = null;
    this.struckFlash = 0;
    this.interference = 0;
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
