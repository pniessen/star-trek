import { Color, MathUtils, Vector3 } from "three";
import { ALTITUDE, flight } from "./altitude.js";
import { COMET } from "./comet.js";
import { sound } from "../audio/sound.js";
import { VectorObject } from "../render/VectorObject.js";
import { PALETTE } from "../render/palette.js";
import { BOLT, type Ordnance } from "./weapons.js";
import type { Minefield } from "./mines.js";
import type { Ship } from "./Ship.js";

/**
 * Five hostiles, each teaching one thing. A small roster that is legible
 * beats a large one that is not — you should be able to name what is on the
 * scanner by its outline and know immediately what it will do to you.
 *
 * The last two do not duel at all, which is the point of them. The Harrow makes
 * the space dangerous and leaves; the Shroud is never on the scanner as a
 * contact you can shoot, only as a return you have to interpret. Between them
 * they stop the game being answerable entirely through the reticle.
 */
export type HostileKind = "swarmer" | "sniper" | "brawler" | "miner" | "stalker";

/** Class names as the fiction knows them; the keys stay role-descriptive. */
export const HOSTILE_NAMES: Record<HostileKind, string> = {
  swarmer: "RAIDER",
  sniper: "LANCE",
  brawler: "BASTION",
  miner: "HARROW",
  stalker: "SHROUD",
};

/** Hue per class — see the palette for why each is what it is. */
export const HOSTILE_COLORS: Record<HostileKind, Color> = {
  swarmer: PALETTE.raider,
  sniper: PALETTE.lance,
  brawler: PALETTE.bastion,
  miner: PALETTE.harrow,
  // The cloaker takes the colour already reserved for what cannot be resolved,
  // because that is what it is even in the two seconds you can see it.
  stalker: PALETTE.magenta,
};

/** The Harrow's habit: what it drops, where, and how often. */
export interface LayingSpec {
  readonly interval: number;
  /** Seconds of the player's velocity to lead the drop by. */
  readonly lead: number;
  /** Minimum distance ahead of a player who is barely moving. */
  readonly standoff: number;
  readonly scatter: number;
  /** It has to be at least this near before it bothers laying. */
  readonly range: number;
}

/** The Shroud's cycle. Every number here is a window the player is watching for. */
export interface CloakSpec {
  readonly strikeRange: number;
  /** Seconds to materialise. The tell, and the head start a ready player gets. */
  readonly wind: number;
  /** Seconds spent visible and killable once it has committed. */
  readonly exposure: number;
  /** Seconds to fade back out. */
  readonly veil: number;
  /** Minimum seconds between strikes. */
  readonly cycle: number;
}

export interface HostileSpec {
  readonly hull: number;
  readonly maxSpeed: number;
  readonly accel: number;
  readonly turnRate: number;
  /** Range it tries to hold. The whole personality is in this number. */
  readonly preferredRange: number;
  readonly fireRange: number;
  readonly fireInterval: number;
  readonly damageScale: number;
  readonly radius: number;
  readonly scale: number;
  readonly value: number;
  /** How hard it strafes rather than closing head-on. */
  readonly orbit: number;
  /**
   * How much of the slab this class uses, 0-1 of `ALTITUDE.ceiling`.
   *
   * A slab the player alone could reach would make altitude a pure escape and
   * almost certainly strictly dominant, so everything gets it — but not equally,
   * because how a class uses height is part of what the class *is*. It is
   * deliberately a preferred altitude that drifts slowly rather than a 3D
   * pursuit brain: the horizontal steering below is untouched, every hostile
   * still holds its range and strafes exactly as it did, and the vertical is a
   * slow wander it does not think about. A hostile that chased you upward would
   * make altitude worthless *and* make the tube unreadable.
   */
  readonly slab: number;
  /** Present only on the mine-layer. */
  readonly lays?: LayingSpec;
  /** Present only on the cloaker. */
  readonly cloak?: CloakSpec;
}

export const HOSTILE_SPECS: Record<HostileKind, HostileSpec> = {
  // Punishes tunnel vision: fast, comes from anywhere, dies to one good burst.
  swarmer: {
    hull: 0.55,
    maxSpeed: 44,
    accel: 42,
    turnRate: 2.9,
    preferredRange: 14,
    fireRange: 30,
    fireInterval: 1.5,
    damageScale: 0.7,
    radius: 2.2,
    scale: 1.2,
    value: 100,
    orbit: 0.85,
    // "Comes from anywhere" is the entire brief of the class, and anywhere now
    // includes above. It gets nearly the whole slab.
    slab: 0.9,
  },
  // Punishes standing still: sits far out and hits hard if you hold a heading.
  sniper: {
    hull: 0.8,
    maxSpeed: 26,
    accel: 20,
    turnRate: 1.5,
    preferredRange: 62,
    fireRange: 78,
    fireInterval: 2.6,
    damageScale: 1.6,
    radius: 2.6,
    scale: 1.5,
    value: 175,
    orbit: 0.25,
    // It takes a perch. At its 62-unit station the elevation angle to a Lance
    // fourteen units up is thirteen degrees, so height barely changes the duel —
    // what it changes is that the long-range threat is not reliably on the
    // horizon any more, which is worth having and costs the player nothing.
    slab: 0.65,
  },
  // Punishes a weak facing: closes, stays, and grinds one shield down.
  brawler: {
    hull: 2.4,
    maxSpeed: 30,
    accel: 22,
    turnRate: 1.2,
    preferredRange: 20,
    fireRange: 40,
    fireInterval: 0.9,
    damageScale: 1.1,
    radius: 3.4,
    scale: 1.4,
    value: 300,
    orbit: 0.45,
    // The anvil stays on the anvil. A Bastion is the thing you have to turn a
    // fresh quarter toward and keep turning toward, and a Bastion that floated
    // would stop being that — it would be another thing to look for. It gets
    // barely any of the slab, which is also what makes it the class you *can*
    // reliably out-climb.
    slab: 0.15,
  },
  // Punishes a habit rather than a mistake: it never shoots, it only makes the
  // course you were flying anyway the wrong one. `fireRange: 0` is what stops
  // it duelling — the fire check simply never passes.
  miner: {
    hull: 1.6,
    maxSpeed: 36,
    accel: 26,
    turnRate: 1.8,
    preferredRange: 58,
    fireRange: 0,
    fireInterval: 99,
    damageScale: 0,
    radius: 3.0,
    scale: 1.35,
    value: 250,
    orbit: 1.0, // runs across your front rather than at you
    // Its ordnance goes on the floor and stays there, so it stays near the
    // floor with it. A Harrow seeding a field from fourteen units up would look
    // like mines materialising out of nowhere, and the whole class is built on
    // the drop being something you can see coming.
    slab: 0.1,
    lays: { interval: 2.4, lead: 1.5, standoff: 26, scatter: 9, range: 105 },
  },
  // Punishes a player who only reads the reticle: it is not on the forward view
  // at all until it decides to be, and by then the shot is already coming.
  stalker: {
    hull: 0.9,
    maxSpeed: 32,
    accel: 30,
    turnRate: 2.2,
    preferredRange: 22,
    fireRange: 34,
    fireInterval: 0.45,
    damageScale: 1.3,
    radius: 2.4,
    scale: 1.25,
    value: 400,
    orbit: 0.35,
    // It commits from nowhere, and the full slab is more nowhere. It is also
    // the one class whose altitude the player genuinely cannot read in advance:
    // an unresolved return is a broken ring on the deck and carries no height,
    // because a scanner that could not resolve the contact could not have
    // resolved its altitude either. The stalk is honest by being absent.
    slab: 1,
    cloak: { strikeRange: 30, wind: 0.45, exposure: 1.7, veil: 0.9, cycle: 3.4 },
  },
};

/** Above this the hull is not there to be shot at. */
const HIDDEN_AT = 0.4;

/**
 * The one-shot roll a hostile makes as its hull crosses `threshold` on the
 * way down. A crippled hull that keeps fighting reads as suicidal rather than
 * as an opponent, so below a fifth of hull the fight can end without a kill:
 * the hostile turns tail, stops shooting, and is gone for good once it clears
 * `exitRange` — paying nothing, the same precedent the Warden's kills already
 * set. `chance` is per class because withdrawal is part of what a class *is*:
 * a Raider (`swarmer`) is disposable and mostly runs, a Bastion (`brawler`)
 * is the anvil and mostly does not, and a Shroud (`stalker`) gets `0` — it
 * already has an escape built into its own cycle, and a cloaked hull fleeing
 * in the open would be a second, redundant way to vanish.
 */
export const WITHDRAW = {
  threshold: 0.2,
  exitRange: 130,
  chance: { swarmer: 0.75, sniper: 0.5, brawler: 0.15, miner: 0.5, stalker: 0 },
} as const satisfies { threshold: number; exitRange: number; chance: Record<HostileKind, number> };

export class Hostile {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  heading = 0;
  hull: number;
  cooldown: number;
  /** Non-zero briefly after being hit, so the strokes flash. */
  flash = 0;
  dead = false;

  /** 1 = fully hidden, 0 = fully exposed. Only the Shroud ever leaves 0. */
  cloak = 0;
  /** True for the single frame the Shroud commits to a strike. */
  revealed = false;

  /**
   * True once the withdrawal roll has hit, for the rest of this hostile's
   * life. Public — the HUD reads it for the lead-pip label and `Session`
   * reads it to retire an escaped hull without paying for it. See `WITHDRAW`.
   */
  withdrawing = false;

  /**
   * How badly this contact's instruments are being jammed, 0-1. Set each frame
   * by `Session` from the comet; not owned here, because the comet is a thing
   * in the sector and a hostile has no idea it is in one.
   *
   * Deliberately *not* folded into `cloak`. That field gates `hidden()` and
   * `shape.group.visible`, so raising it for jamming would make a hostile
   * invisible and unhittable inside the tail — the opposite of the intent,
   * which is that the tail is where you can finally *see* things.
   */
  interference = 0;

  private phase: "hidden" | "striking" | "veiling" = "hidden";
  private phaseTimer = 0;
  private layTimer = 0;
  /** Decaying flare on materialising, so the moment has a flash to it. */
  private reveal = 0;

  /**
   * The vertical wander. One sine per ship, with its own phase and its own
   * period, so a wave arrives at assorted heights instead of rising and falling
   * as a formation — which is what a shared clock would produce and would read
   * as a breathing animation rather than as pilots.
   */
  private slabPhase = Math.random() * Math.PI * 2;
  private slabRate = (Math.PI * 2) / (7 + Math.random() * 6); // one cycle every 7-13s
  private slabTime = 0;

  constructor(
    readonly kind: HostileKind,
    readonly spec: HostileSpec,
    readonly shape: VectorObject,
  ) {
    this.hull = spec.hull;
    // Stagger the opening volley so a wave does not fire in unison.
    this.cooldown = Math.random() * spec.fireInterval;
    this.layTimer = Math.random() * (spec.lays?.interval ?? 1);
    if (spec.cloak) {
      this.cloak = 1;
      // Two Shrouds arriving together must not strike together, or the whole
      // point of the class — one knife, from one direction — is lost.
      this.phaseTimer = spec.cloak.cycle * (0.4 + Math.random() * 0.9);
    }
  }

  /** A cloaked hull cannot be hit, locked onto, or drawn. */
  get hidden(): boolean {
    return this.cloak > HIDDEN_AT;
  }

  update(dt: number, player: Ship, ordnance: Ordnance, mines: Minefield, flank = false): void {
    this.revealed = false;

    const toPlayer = player.position.clone().sub(this.position);
    const distance = toPlayer.length();
    if (distance < 1e-3) return;
    toPlayer.divideScalar(distance);

    // A withdrawing hostile has one job left: put distance between itself and
    // the player. No station to hold and no arc to fly — the range-holding and
    // strafing below are exactly what a fight looks like, and this is the one
    // moment a hostile is no longer in one.
    let desired: Vector3;
    if (this.withdrawing) {
      desired = toPlayer.clone().negate();
    } else {
      // Hold the preferred range: close if outside it, back off if inside. A
      // Shroud breaking off after a strike wants distance, not its usual station.
      const preferred =
        this.phase === "veiling" ? this.spec.preferredRange * 3.4 : this.spec.preferredRange;
      const error = distance - preferred;
      const closing = MathUtils.clamp(error / 20, -1, 1);

      // Strafe perpendicular so they arc around rather than driving straight in,
      // which is what makes them feel like pilots instead of homing missiles.
      //
      // While a Bastion is holding the player at range, swarmers bias that same
      // strafe toward the player's stern instead of drawing it from a positional
      // hash — attacking the facing decision rather than the shield itself: a
      // player who turns to guard the stern leaves the bow, where the Bastion
      // already is. Bias only — `orbit` still bounds the magnitude, range-holding
      // and turn rate are untouched above and below this line, and it is inert
      // the moment no brawler is engaged (wave one, every other class, and a
      // Shroud's veiling retreat all keep the hash sign).
      const sign =
        flank && this.kind === "swarmer"
          ? sternSign(
              Math.atan2(this.position.x - player.position.x, this.position.z - player.position.z),
              player.heading,
            )
          : Math.sign(Math.sin(this.position.x * 0.7 + this.position.z * 0.3)) || 1;
      const tangent = new Vector3(-toPlayer.z, 0, toPlayer.x).multiplyScalar(this.spec.orbit * sign);

      desired = toPlayer.clone().multiplyScalar(closing).add(tangent);
    }
    if (desired.lengthSq() > 1e-6) desired.normalize();

    // Turn toward the desired direction at a bounded rate.
    const targetHeading = Math.atan2(desired.x, desired.z);
    this.heading = turnToward(this.heading, targetHeading, this.spec.turnRate * dt);

    const facing = new Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.velocity.addScaledVector(facing, this.spec.accel * dt);
    this.velocity.addScaledVector(this.velocity, -1.4 * dt);
    if (this.velocity.lengthSq() > this.spec.maxSpeed ** 2) {
      this.velocity.setLength(this.spec.maxSpeed);
    }
    // Horizontal steering is untouched by any of this: `facing` has no `y`, so
    // `velocity` never gains one and the range-holding and strafing above are
    // exactly the same numbers they were. Altitude is set, not accumulated.
    this.position.addScaledVector(this.velocity, dt);
    this.updateAltitude(dt);

    this.cooldown -= dt;
    this.flash = Math.max(0, this.flash - dt * 5);
    // Outlives the wind-up on purpose: the flare has to still be burning at the
    // instant the hull finishes resolving, or materialising reads as a fade-in
    // rather than as something arriving.
    this.reveal = Math.max(0, this.reveal - dt * 1.6);

    const aimError = Math.abs(angleDelta(this.heading, Math.atan2(toPlayer.x, toPlayer.z)));
    // Belt-and-braces on the cloak: `WITHDRAW.chance.stalker` is 0, so a
    // Shroud never actually reaches this guard withdrawing, but the check is
    // one field read and costs nothing to keep honest against that table
    // ever changing.
    if (this.spec.cloak && !this.withdrawing) this.updateCloak(dt, this.spec.cloak, distance, aimError);
    // A fleeing Harrow does not seed the ground it is running across — laying
    // one more field on the way out would arm its own escape route, which is
    // not what "withdrawing" is supposed to mean.
    if (this.spec.lays && !this.withdrawing) this.updateLaying(dt, this.spec.lays, distance, player, mines);

    // Fire only when actually pointing at the player, so a hostile that has
    // been out-turned genuinely cannot shoot — and a cloaked one never can,
    // because pulling the trigger is what gives it away.
    //
    // `aimError` is a *bearing* — `atan2(x, z)` — and always was, so a hostile
    // has trained its guns in elevation since before there was any elevation to
    // train them in. That is not an accident this feature exploited, it is the
    // precedent it copied: the player's tubes now do the same thing, in
    // `Session.tubeAim`, for exactly the same reason. Nobody in this game has a
    // pitch axis, and nothing needs one.
    // Fire-control suppression, not navigation: the approach above is
    // untouched, and a hostile in the tail still flies its normal station. It
    // simply cannot pull the trigger from outside a jammed, near-visual range
    // — the interpolation collapses toward `COMET.visualRange` as
    // `interference` climbs, and is the old `fireRange` exactly when it is 0.
    //
    // Clamped to never exceed `fireRange` itself, because a lerp toward a
    // floor only suppresses when the floor is below where you started. It is
    // for every class but the Harrow, whose `fireRange: 0` is the one already
    // below `COMET.visualRange` — without the clamp, jamming would be the one
    // thing that could make it shoot, which is exactly the duel `fireRange: 0`
    // exists to rule out.
    const reach = Math.min(
      this.spec.fireRange,
      MathUtils.lerp(this.spec.fireRange, COMET.visualRange, this.interference),
    );
    // A withdrawing hostile has stopped fighting, not merely stopped
    // pursuing — the whole point is that it costs the player nothing more to
    // let it go, and a parting shot on the way out would undercut that.
    if (!this.withdrawing && this.cooldown <= 0 && !this.hidden && distance < reach && aimError < 0.4) {
      this.cooldown = this.spec.fireInterval;
      // Lead the target — a bolt aimed where you are is a bolt you outrun. The
      // solve is a plain vector subtraction and has been three-dimensional all
      // along, so a climbing player is led upward without a line changing here.
      const flightTime = distance / BOLT.speed;
      const lead = player.position
        .clone()
        .addScaledVector(player.velocity, flightTime)
        .sub(this.position);
      ordnance.fire(this.position, lead, "bolt", false);
      // Placed where the shooter is, so a trigger pulled behind you is heard
      // behind you. The forward view cannot tell you this and the scanner only
      // tells you it exists.
      sound.hostileFire(this.position.x, this.position.z);
    }

    this.shape.group.position.copy(this.position);
    this.shape.group.rotation.y = this.heading;
    // One number drives both the fade in and the fade out: at full cloak the
    // strokes have no width left and the group is dropped from the scene, so
    // the hull stops occluding as well as stops glowing.
    this.shape.group.visible = this.cloak < 0.98;
    this.shape.setIntensity((1 + this.flash * 1.6 + this.reveal * 2.4) * (1 - this.cloak));
  }

  /**
   * A preferred altitude that varies slowly, and nothing cleverer.
   *
   * A plain `sin` keeps the target inside `[-slab * ceiling, +slab * ceiling]` by
   * construction, so no class ever leaves the shallow slab the player is flying
   * in. It used to be `0.5 + 0.5 * sin`, which pinned the range to the positive
   * side because the plane was a floor. The plane is a rest position now, and
   * **the hostiles get the negative half for the same reason they got the slab at
   * all**: if only the player could go under, "under" would be a pure escape
   * rather than a trade, which is exactly the failure the per-class fractions
   * exist to prevent. The approach is exponential and `dt`-driven so the wander
   * is the same speed on any machine.
   */
  private updateAltitude(dt: number): void {
    if (!flight.threeD) {
      this.position.y = 0;
      return;
    }
    this.slabTime += dt;
    const target =
      this.spec.slab * ALTITUDE.ceiling * Math.sin(this.slabPhase + this.slabTime * this.slabRate);
    this.position.y += (target - this.position.y) * (1 - Math.exp(-1.6 * dt));
  }

  damage(amount: number): boolean {
    if (this.hidden) return false; // not there to be hit
    const before = this.hull;
    this.hull -= amount;
    this.flash = 1;
    if (this.hull <= 0) this.dead = true;
    // The roll happens once, at the crossing — not every frame the hull sits
    // below the line, and not on a hit that was already below it. A hostile
    // this hit kills outright never gets here in any way that matters: `dead`
    // routes it through `Session.destroy` instead, and `withdrawing` is never
    // read again.
    const cutoff = WITHDRAW.threshold * this.spec.hull;
    if (!this.dead && !this.withdrawing && before > cutoff && this.hull <= cutoff) {
      if (Math.random() < WITHDRAW.chance[this.kind]) this.withdrawing = true;
    }
    return this.dead;
  }

  /**
   * The strike cycle. It stalks hidden, materialises over `wind`, empties a
   * burst during `exposure`, then fades and swings away.
   *
   * The whole class lives or dies on `wind` being long enough to be acted on.
   * A cloaker that appears and fires in the same frame is not a hostile, it is
   * a dice roll — the scanner has to be able to tell you it is coming, and then
   * the decloak has to give you a moment to put the nose on it.
   */
  private updateCloak(dt: number, spec: CloakSpec, distance: number, aimError: number): void {
    // The tail strips the veil outright: cloak is driven toward 0 at the same
    // rate a strike's wind-up uses, and the phase clock is frozen rather than
    // allowed to re-veil, so a Shroud caught here stays a hull you can shoot
    // for as long as it stays jammed. A Shroud in the tail is a Shroud you can
    // shoot.
    if (this.interference > COMET.stripAt) {
      this.cloak = Math.max(0, this.cloak - dt / spec.wind);
      return;
    }

    this.phaseTimer -= dt;

    switch (this.phase) {
      case "hidden":
        this.cloak = Math.min(1, this.cloak + dt / spec.veil);
        if (this.phaseTimer <= 0 && distance < spec.strikeRange && aimError < 0.5) {
          this.phase = "striking";
          this.phaseTimer = spec.wind + spec.exposure;
          this.cooldown = spec.wind; // first bolt as it finishes materialising
          this.reveal = 1;
          this.revealed = true;
        }
        break;

      case "striking":
        this.cloak = Math.max(0, this.cloak - dt / spec.wind);
        if (this.phaseTimer <= 0) {
          this.phase = "veiling";
          this.phaseTimer = spec.veil * 1.6;
        }
        break;

      case "veiling":
        this.cloak = Math.min(1, this.cloak + dt / spec.veil);
        if (this.phaseTimer <= 0) {
          this.phase = "hidden";
          this.phaseTimer = spec.cycle;
        }
        break;
    }
  }

  /**
   * Drops are led onto the player's course rather than aimed at the player, and
   * a player who is barely moving gets them seeded ahead of his nose instead —
   * so hovering is not a way to make the Harrow harmless, and no drop ever
   * materialises in your lap.
   */
  private updateLaying(
    dt: number,
    spec: LayingSpec,
    distance: number,
    player: Ship,
    mines: Minefield,
  ): void {
    this.layTimer -= dt;
    if (this.layTimer > 0 || distance > spec.range) return;
    this.layTimer = spec.interval;

    const lead = player.velocity.clone().multiplyScalar(spec.lead);
    if (lead.length() < spec.standoff) player.forward(lead).multiplyScalar(spec.standoff);

    mines.lay(
      player.position
        .clone()
        .add(lead)
        .add(
          new Vector3(
            (Math.random() - 0.5) * spec.scatter * 2,
            0,
            (Math.random() - 0.5) * spec.scatter * 2,
          ),
        ),
    );
  }
}

function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/**
 * Which tangent direction — the same sign the strafe above multiplies
 * `orbit` by — carries a hostile at this bearing around toward the player's
 * stern rather than away from it. The stern sits at `playerHeading + π`;
 * `angleDelta` already picks the shorter way round, so its sign is the
 * answer. The `>= 0` comparison always resolves to +1 or -1 — a dead-ahead
 * or dead-astern source still has to pick a side, and it always does.
 */
export function sternSign(bearingFromPlayer: number, playerHeading: number): number {
  const toStern = angleDelta(bearingFromPlayer, playerHeading + Math.PI);
  return toStern >= 0 ? 1 : -1;
}

function turnToward(from: number, to: number, maxStep: number): number {
  return from + MathUtils.clamp(angleDelta(from, to), -maxStep, maxStep);
}

/**
 * Owns the live hostiles and recycles their render objects. Building a
 * VectorObject allocates GPU buffers, so wave two should not pay for them
 * again.
 */
export class Fleet {
  readonly hostiles: Hostile[] = [];
  private readonly pool: Record<HostileKind, VectorObject[]> = {
    swarmer: [],
    sniper: [],
    brawler: [],
    miner: [],
    stalker: [],
  };

  /**
   * True while any live brawler holds the player inside its own fire range —
   * the gate for the swarmer's stern-flanking bias. Computed once per step,
   * fleet-wide, so every swarmer that update()s this frame reads the same
   * answer rather than five slightly different ones from five call sites.
   */
  brawlerEngaged = false;

  constructor(private readonly makeShape: (kind: HostileKind) => VectorObject) {}

  /** Recomputes `brawlerEngaged` against this frame's player position. */
  updateEngagement(player: Ship): void {
    this.brawlerEngaged = this.hostiles.some(
      (h) => h.kind === "brawler" && h.position.distanceTo(player.position) < h.spec.fireRange,
    );
  }

  spawn(kind: HostileKind, position: Vector3, heading: number): Hostile {
    const spec = HOSTILE_SPECS[kind];
    const shape = this.pool[kind].pop() ?? this.makeShape(kind);
    shape.group.visible = true;
    shape.group.scale.setScalar(spec.scale);
    shape.setColor(HOSTILE_COLORS[kind]);

    const hostile = new Hostile(kind, spec, shape);
    hostile.position.copy(position);
    hostile.heading = heading;
    this.hostiles.push(hostile);
    return hostile;
  }

  retire(hostile: Hostile): void {
    const index = this.hostiles.indexOf(hostile);
    if (index >= 0) this.hostiles.splice(index, 1);
    hostile.shape.group.visible = false;
    this.pool[hostile.kind].push(hostile.shape);
  }

  clear(): void {
    for (const hostile of [...this.hostiles]) this.retire(hostile);
  }
}
