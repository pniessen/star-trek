import { MathUtils, Vector3 } from "three";
import { PALETTE } from "../render/palette.js";
import type { VectorObject } from "../render/VectorObject.js";
import { COMET } from "./comet.js";
import type { Hostile } from "./hostiles.js";
import type { Ship } from "./Ship.js";

/**
 * The Warden — someone else on your side.
 *
 * Until this existed the sector contained exactly two kinds of object: you, and
 * things trying to kill you. That is a complete game and a thin world, and it
 * is the reason a run in a sector you have spent 200 salvage defending felt
 * identical to a run in one you had never touched.
 *
 * A Warden turns up for one of two reasons, and the difference is the whole
 * design:
 *
 *  - **On station.** `campaign.sectors[i].patrol` is a thing the command view
 *    already lets you buy, and until now the only evidence you had ever bought
 *    one was a number on a chart between runs. A patrol in the sector you drop
 *    into now flies in it. This is the "patrols visible during a run" line in
 *    the chart design doc — designed, priced, never built.
 *  - **Passing through.** Everywhere else, once in a long while, one crosses
 *    the sector, says something, and leaves. It costs the player nothing and
 *    is worth having for exactly the reason the player asked for it: a sector
 *    somebody else is also flying in is a sector, and a sector nobody else has
 *    ever been seen in is a shooting gallery.
 *
 * **Colour.** No new hue. Cyan already means *ours* — the palette calls
 * `trace` "friendly hull, player" and the starbase, the only other friendly
 * object in the game, is drawn in its dim variant. Spending a sixth hue on the
 * ally would say "another class" when the thing that actually needs saying is
 * "not a target", and the wheel has no gap left that is 60 degrees clear of
 * five hostile hues *and* reads as friendly. So the Warden is cyan, and it is
 * told apart from the player by the two things that are free: its silhouette
 * (see `buildWarden`) and the fact that the camera is welded to the other one.
 *
 * **Credit.** A Warden's kills pay the player nothing — see
 * `Session.destroyByAlly`.
 */

/** The class, as the fiction knows it. One word, like every hostile class. */
export const ALLY_CLASS = "WARDEN";

/**
 * Hull names. Nouns of watchkeeping and navigation — a lodestar, a tidemark and
 * a cairn are all things left out for somebody else to steer by, which is what
 * this ship is. Deliberately nobody's marks and nobody's naming convention:
 * no prefix, no rank, no registry.
 */
const CALLSIGNS = [
  "LODESTAR",
  "HALYARD",
  "TIDEMARK",
  "SALTIRE",
  "LANTERN",
  "MERIDIAN",
  "KEEPSAKE",
  "CAIRN",
] as const;

/** What a Warden says. Terse, uppercase, in the panel's own register. */
const LINES = {
  station: ["ON STATION", "HOLDING THIS SECTOR", "WE HAVE THE PICKET"],
  passing: ["PASSING THROUGH", "ON YOUR WING", "SAW YOUR TRACE", "GOOD HUNTING"],
  chatter: ["STILL WITH YOU", "NOTHING ON OUR TUBE", "MIND YOUR SIX", "CLEAR ON THIS SIDE"],
  scored: ["SPLASH", "THAT ONE IS OURS", "SCRATCH ONE"],
  hurt: ["TAKING FIRE", "WE ARE HIT"],
  leaving: ["BREAKING OFF", "GOOD LUCK OUT HERE", "SEE YOU AT THE RING"],
  lost: ["GOING DOWN"],
} as const;

/**
 * Every number a Warden is.
 *
 * The two that matter are `damage` and `fireInterval`, and they are set where
 * they are on purpose. At 0.3 every 2.4 seconds a Warden needs two shots for a
 * Raider, three for a Lance and eight for a Bastion — so it thins the cheap end
 * of a wave and is a nuisance to everything else. It must never be able to
 * clear a wave for you: the moment hiding behind the escort is a strategy, the
 * greed loop is being played by someone else.
 */
export const WARDEN = {
  hull: 3.2,
  maxSpeed: 34,
  accel: 26,
  turnRate: 1.9,
  radius: 3.0,
  scale: 1.15,

  /** One player phaser shot's worth, at a fifteenth of the rate. */
  damage: 0.3,
  fireInterval: 2.4,
  fireRange: 56,
  /** It will leave station for a hostile this far out, and no further. */
  engageRange: 78,
  /** Range it fights at, the same way a hostile holds one. */
  standoff: 22,

  /** Where it sits when there is nothing to shoot: off your quarter, loosely. */
  escortRange: 34,
  /** How far out it arrives from and, once leaving, how far out it stops existing. */
  arriveRange: 165,
  goneRange: 260,

  /** Seconds a passer stays before it breaks off. */
  visit: 32,
  /** Seconds between unprompted lines. Rare: chatter that fills the line is noise. */
  chatterInterval: 13,
  /** Below this fraction of hull it says so, once. */
  hurtAt: 0.45,
} as const;

export type Duty = "station" | "passing";

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export class Escort {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  heading = 0;
  hull = WARDEN.hull;
  /** Non-zero briefly after being hit, so the strokes flash. Same as a hostile's. */
  flash = 0;
  dead = false;

  /**
   * A line waiting to be said. Written here, cleared by `Session.hear` — never
   * cleared by `update`, because the arrival hail is set at the moment of
   * spawning and a frame boundary would eat it.
   */
  says: string | null = null;
  /** True while `says` is the arrival hail, which sounds different from chatter. */
  hailing = false;

  /**
   * How jammed the tail is at this escort's own position, set per-frame by
   * `Session.stepComet` from `interferenceAt` — same field, same source, same
   * reason `Hostile.interference` exists: the tail's rule is "no instrument
   * works", and the escort's fire control is an instrument too. Zero with no
   * comet standing, which is what keeps `fire()`'s clamp below a no-op.
   */
  interference = 0;

  /** True once it has turned for the edge of the sector and is on its way out. */
  leaving = false;

  /** Range to the player, from the last step. `departed` reads it. */
  private range = 0;
  private stay: number;
  private cooldown: number = WARDEN.fireInterval;
  private chatter: number = WARDEN.chatterInterval;
  private saidHurt = false;
  /** Which side of the player it keeps station on. Fixed per ship, so it is not indecisive. */
  private readonly quarter = Math.random() < 0.5 ? -1 : 1;

  constructor(
    readonly callsign: string,
    readonly duty: Duty,
    readonly shape: VectorObject,
  ) {
    // A stationed patrol is here for the whole run — that is what "deployed in
    // this sector" means and it is what 200 salvage bought.
    this.stay = duty === "station" ? Infinity : WARDEN.visit;
  }

  /** `CALLSIGN: LINE`, which is how it reaches the comms line. */
  get label(): string {
    return `${ALLY_CLASS} ${this.callsign}`;
  }

  /** Far enough out that it has left the sector rather than merely gone quiet. */
  get departed(): boolean {
    return this.leaving && this.range > WARDEN.goneRange;
  }

  /**
   * @returns the hostile it fired on this frame, if any. Deliberately a return
   *   value rather than a call into `Ordnance`: who a kill pays is a rule, all
   *   the rules live in `Session`, and an ally that could reach the projectile
   *   list could quietly reach the multiplier too.
   */
  update(dt: number, player: Ship, hostiles: readonly Hostile[]): Hostile | null {
    this.flash = Math.max(0, this.flash - dt * 5);
    this.cooldown -= dt;

    const toPlayer = player.position.clone().sub(this.position);
    this.range = toPlayer.length();

    if (!this.leaving) {
      this.stay -= dt;
      if (this.stay <= 0) this.breakOff();
    }

    const target = this.leaving ? null : this.chooseTarget(hostiles);

    // One steering law, three goals. Engaging holds a fighting range off the
    // hostile; escorting holds station off the player's quarter; leaving flies
    // at a point well outside the sector and never arrives.
    let goal: Vector3;
    let hold: number;
    if (target) {
      goal = target.position;
      hold = WARDEN.standoff;
    } else if (this.leaving) {
      goal = this.position.clone().addScaledVector(toPlayer.clone().normalize(), -WARDEN.goneRange);
      hold = 0;
    } else {
      goal = player.position
        .clone()
        .add(new Vector3(Math.cos(player.heading) * this.quarter, 0, -Math.sin(player.heading) * this.quarter)
          .multiplyScalar(WARDEN.escortRange));
      hold = 0;
    }

    this.steer(dt, goal, hold);

    this.cadence(dt, player);

    this.shape.group.position.copy(this.position);
    this.shape.group.rotation.y = this.heading;
    this.shape.setIntensity(1 + this.flash * 1.6);

    // It chooses a target further out than it can shoot one, so it closes
    // before it opens up rather than sniping from wherever it happened to be.
    //
    // Fire-control suppression, not a ban: an escort inside the tail still
    // flies its normal station, it just cannot pull the trigger from outside
    // a jammed, near-visual range — the same clamp shape `hostiles.ts` uses
    // against the player, aimed the other way. Without this a Warden parked
    // on the comet's axis was the safe room `CLAUDE.md` rules out by name: it
    // sat at `WARDEN.fireRange` (56) while every hostile it was shooting at
    // was clamped to `COMET.visualRange` (22) and could not fire back.
    //
    // `Math.max(this.interference, target.interference)` is "either end
    // being jammed is enough" applied to *this* engagement: `this.interference`
    // is this escort's own position (with the player's own reading folded in,
    // same as a hostile's), and `target.interference` is already the jammed
    // hostile's own reading — Session sets both before this runs, so a target
    // deep in the tail suppresses the shot even from an escort standing well
    // outside it, and the reverse.
    const reach = target
      ? Math.min(
          WARDEN.fireRange,
          MathUtils.lerp(WARDEN.fireRange, COMET.visualRange, Math.max(this.interference, target.interference)),
        )
      : WARDEN.fireRange;
    if (target && this.cooldown <= 0 && target.position.distanceTo(this.position) < reach) {
      this.cooldown = WARDEN.fireInterval;
      return target;
    }
    return null;
  }

  /** Says its last line and turns for the edge. Also what dying next to you triggers. */
  breakOff(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.says = `${this.callsign}: ${pick(LINES.leaving)}`;
  }

  /** @returns true if this was the killing blow. */
  damage(amount: number): boolean {
    this.hull -= amount;
    this.flash = 1;
    if (this.hull <= 0) this.dead = true;
    return this.dead;
  }

  /** Scored a kill. Said here rather than by the caller so the voice stays in one place. */
  scored(): void {
    // Only sometimes, and never over a line already waiting: a ship that
    // announces every kill stops being a pilot and starts being a killfeed,
    // and this comms row is shared with the panel's own messages.
    if (this.says) return;
    if (Math.random() < 0.5) this.says = `${this.callsign}: ${pick(LINES.scored)}`;
  }

  /** The line it goes out on. Read by `Session` at the moment the hull fails. */
  get epitaph(): string {
    return `${this.callsign}: ${pick(LINES.lost)}`;
  }

  private chooseTarget(hostiles: readonly Hostile[]): Hostile | null {
    let best: Hostile | null = null;
    let bestDistance: number = WARDEN.engageRange;
    for (const hostile of hostiles) {
      if (hostile.hidden) continue; // it cannot see a Shroud either
      const distance = hostile.position.distanceTo(this.position);
      if (distance >= bestDistance) continue;
      best = hostile;
      bestDistance = distance;
    }
    return best;
  }

  /** The same close/back-off/strafe law the hostiles fly, so it reads as a pilot. */
  private steer(dt: number, goal: Vector3, hold: number): void {
    const toGoal = goal.clone().sub(this.position);
    const distance = toGoal.length();
    if (distance < 1e-3) return;
    toGoal.divideScalar(distance);

    const closing = MathUtils.clamp((distance - hold) / 20, -1, 1);
    const tangent = new Vector3(-toGoal.z, 0, toGoal.x).multiplyScalar(hold > 0 ? 0.55 : 0.12);
    const desired = toGoal.multiplyScalar(closing).add(tangent);
    if (desired.lengthSq() > 1e-6) desired.normalize();

    const targetHeading = Math.atan2(desired.x, desired.z);
    let delta = (targetHeading - this.heading) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    this.heading += MathUtils.clamp(delta, -WARDEN.turnRate * dt, WARDEN.turnRate * dt);

    const facing = new Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.velocity.addScaledVector(facing, WARDEN.accel * dt);
    this.velocity.addScaledVector(this.velocity, -1.4 * dt);
    if (this.velocity.lengthSq() > WARDEN.maxSpeed ** 2) this.velocity.setLength(WARDEN.maxSpeed);
    this.position.addScaledVector(this.velocity, dt);
    this.position.y = 0;
  }

  /** When it talks. Everything here is time-based; nothing counts frames. */
  private cadence(dt: number, player: Ship): void {
    if (this.says) return; // one line at a time; the panel has one comms row

    if (!this.saidHurt && this.hull < WARDEN.hull * WARDEN.hurtAt) {
      this.saidHurt = true;
      this.says = `${this.callsign}: ${pick(LINES.hurt)}`;
      return;
    }

    if (this.leaving) return;

    this.chatter -= dt;
    if (this.chatter > 0) return;
    this.chatter = WARDEN.chatterInterval * (0.8 + Math.random() * 1.4);
    // Only when it is near enough that you could see it. A voice from a ship
    // that is not on the tube is a voice from nowhere.
    if (this.position.distanceTo(player.position) > WARDEN.arriveRange) return;
    this.says = `${this.callsign}: ${pick(LINES.chatter)}`;
  }

  /** Arrival, spoken once, by whoever spawned it. */
  hail(): void {
    this.says = `${this.callsign}: ${pick(this.duty === "station" ? LINES.station : LINES.passing)}`;
    this.hailing = true;
  }
}

/**
 * Owns the live escort and recycles its render object, exactly as `Fleet` does
 * for hostiles — building a `VectorObject` allocates GPU buffers and a Warden
 * that visits four times in a run should not pay for them four times.
 *
 * At most one at a time, and that is a design decision rather than a limit:
 * two allies is a formation and a formation fights waves for you.
 */
export class Wing {
  escort: Escort | null = null;
  private shape: VectorObject | null = null;
  private nextCallsign = Math.floor(Math.random() * CALLSIGNS.length);

  constructor(private readonly makeShape: () => VectorObject) {}

  spawn(duty: Duty, position: Vector3, heading: number): Escort {
    if (!this.shape) {
      this.shape = this.makeShape();
      this.shape.group.scale.setScalar(WARDEN.scale);
      this.shape.setColor(PALETTE.trace);
    }
    this.shape.group.visible = true;
    // Walked rather than drawn, so the same name never turns up twice running.
    const callsign = CALLSIGNS[this.nextCallsign % CALLSIGNS.length];
    this.nextCallsign++;

    const escort = new Escort(callsign, duty, this.shape);
    escort.position.copy(position);
    escort.heading = heading;
    escort.hail();
    this.escort = escort;
    return escort;
  }

  retire(): void {
    if (this.shape) this.shape.group.visible = false;
    this.escort = null;
  }

  clear(): void {
    this.retire();
  }
}
