import { Color, MathUtils, Vector3 } from "three";
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
    cloak: { strikeRange: 30, wind: 0.45, exposure: 1.7, veil: 0.9, cycle: 3.4 },
  },
};

/** Above this the hull is not there to be shot at. */
const HIDDEN_AT = 0.4;

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

  private phase: "hidden" | "striking" | "veiling" = "hidden";
  private phaseTimer = 0;
  private layTimer = 0;
  /** Decaying flare on materialising, so the moment has a flash to it. */
  private reveal = 0;

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

  update(dt: number, player: Ship, ordnance: Ordnance, mines: Minefield): void {
    this.revealed = false;

    const toPlayer = player.position.clone().sub(this.position);
    const distance = toPlayer.length();
    if (distance < 1e-3) return;
    toPlayer.divideScalar(distance);

    // Hold the preferred range: close if outside it, back off if inside. A
    // Shroud breaking off after a strike wants distance, not its usual station.
    const preferred =
      this.phase === "veiling" ? this.spec.preferredRange * 3.4 : this.spec.preferredRange;
    const error = distance - preferred;
    const closing = MathUtils.clamp(error / 20, -1, 1);

    // Strafe perpendicular so they arc around rather than driving straight in,
    // which is what makes them feel like pilots instead of homing missiles.
    const tangent = new Vector3(-toPlayer.z, 0, toPlayer.x).multiplyScalar(
      this.spec.orbit * Math.sign(Math.sin(this.position.x * 0.7 + this.position.z * 0.3) || 1),
    );

    const desired = toPlayer.clone().multiplyScalar(closing).add(tangent);
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
    this.position.addScaledVector(this.velocity, dt);
    this.position.y = 0;

    this.cooldown -= dt;
    this.flash = Math.max(0, this.flash - dt * 5);
    // Outlives the wind-up on purpose: the flare has to still be burning at the
    // instant the hull finishes resolving, or materialising reads as a fade-in
    // rather than as something arriving.
    this.reveal = Math.max(0, this.reveal - dt * 1.6);

    const aimError = Math.abs(angleDelta(this.heading, Math.atan2(toPlayer.x, toPlayer.z)));
    if (this.spec.cloak) this.updateCloak(dt, this.spec.cloak, distance, aimError);
    if (this.spec.lays) this.updateLaying(dt, this.spec.lays, distance, player, mines);

    // Fire only when actually pointing at the player, so a hostile that has
    // been out-turned genuinely cannot shoot — and a cloaked one never can,
    // because pulling the trigger is what gives it away.
    if (this.cooldown <= 0 && !this.hidden && distance < this.spec.fireRange && aimError < 0.4) {
      this.cooldown = this.spec.fireInterval;
      // Lead the target — a bolt aimed where you are is a bolt you outrun.
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

  damage(amount: number): boolean {
    if (this.hidden) return false; // not there to be hit
    this.hull -= amount;
    this.flash = 1;
    if (this.hull <= 0) this.dead = true;
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

  constructor(private readonly makeShape: (kind: HostileKind) => VectorObject) {}

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
