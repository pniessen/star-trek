import { MathUtils, Vector3 } from "three";
import { VectorObject } from "../render/VectorObject.js";
import { PALETTE } from "../render/palette.js";
import { BOLT, type Ordnance } from "./weapons.js";
import type { Ship } from "./Ship.js";

/**
 * Three hostiles, each teaching one thing. A small roster that is legible
 * beats a large one that is not — you should be able to name what is on the
 * scanner by its outline and know immediately what it will do to you.
 */
export type HostileKind = "swarmer" | "sniper" | "brawler";

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
};

export class Hostile {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  heading = 0;
  hull: number;
  cooldown: number;
  /** Non-zero briefly after being hit, so the strokes flash. */
  flash = 0;
  dead = false;

  constructor(
    readonly kind: HostileKind,
    readonly spec: HostileSpec,
    readonly shape: VectorObject,
  ) {
    this.hull = spec.hull;
    // Stagger the opening volley so a wave does not fire in unison.
    this.cooldown = Math.random() * spec.fireInterval;
  }

  update(dt: number, player: Ship, ordnance: Ordnance): void {
    const toPlayer = player.position.clone().sub(this.position);
    const distance = toPlayer.length();
    if (distance < 1e-3) return;
    toPlayer.divideScalar(distance);

    // Hold the preferred range: close if outside it, back off if inside.
    const error = distance - this.spec.preferredRange;
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

    // Fire only when actually pointing at the player, so a hostile that has
    // been out-turned genuinely cannot shoot.
    const aimError = Math.abs(angleDelta(this.heading, Math.atan2(toPlayer.x, toPlayer.z)));
    if (this.cooldown <= 0 && distance < this.spec.fireRange && aimError < 0.4) {
      this.cooldown = this.spec.fireInterval;
      // Lead the target — a bolt aimed where you are is a bolt you outrun.
      const flightTime = distance / BOLT.speed;
      const lead = player.position
        .clone()
        .addScaledVector(player.velocity, flightTime)
        .sub(this.position);
      ordnance.fire(this.position, lead, "bolt", false);
    }

    this.shape.group.position.copy(this.position);
    this.shape.group.rotation.y = this.heading;
    this.shape.setIntensity(1 + this.flash * 1.6);
  }

  damage(amount: number): boolean {
    this.hull -= amount;
    this.flash = 1;
    if (this.hull <= 0) this.dead = true;
    return this.dead;
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
  };

  constructor(private readonly makeShape: (kind: HostileKind) => VectorObject) {}

  spawn(kind: HostileKind, position: Vector3, heading: number): Hostile {
    const spec = HOSTILE_SPECS[kind];
    const shape = this.pool[kind].pop() ?? this.makeShape(kind);
    shape.group.visible = true;
    shape.group.scale.setScalar(spec.scale);
    shape.setColor(PALETTE.amber);

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
