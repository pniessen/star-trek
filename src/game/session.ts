import { Vector3 } from "three";
import { DebrisField } from "./debris.js";
import { Fleet, HOSTILE_SPECS, type Hostile, type HostileKind } from "./hostiles.js";
import { Ordnance, PHASER, TORPEDO, phaserDamageAt } from "./weapons.js";
import type { Ship } from "./Ship.js";
import { PALETTE } from "../render/palette.js";

export type SessionState = "fighting" | "clear" | "docking" | "docked" | "dead";

export interface CombatInput {
  readonly firePhaser: boolean;
  readonly fireTorpedo: boolean;
}

/** Docking is a skill test, not a menu: come in slow, lined up, and vulnerable. */
const DOCK = {
  radius: 16,
  maxSpeed: 9,
  /** How far off the approach bearing you may be, radians. */
  tolerance: 0.9,
  duration: 1.9,
} as const;

const WAVE_BREAK = 2.6;
const PLAYER_RADIUS = 2.6;

/**
 * The rules of a run.
 *
 * The centre of gravity here is the multiplier. It climbs with every kill and
 * is halved whenever something reaches the hull, and it is only realised as
 * score when you dock — which also repairs you and resets it to one. So every
 * wave asks the same question: bank a good multiplier now, or push on and risk
 * losing it. That question is the game; the shooting is how you ask it.
 */
export class Session {
  readonly ordnance = new Ordnance();
  readonly debris = new DebrisField();

  state: SessionState = "clear";
  wave = 0;
  score = 0;
  multiplier = 1;
  /** Earned but unbanked. Lost entirely if you die before docking. */
  pending = 0;
  kills = 0;

  dockProgress = 0;
  breakTimer = WAVE_BREAK;
  message = "STAND BY";
  messageTimer = 2;

  private readonly scratch = new Vector3();
  private readonly nose = new Vector3();

  constructor(
    private readonly fleet: Fleet,
    private readonly starbase: Vector3,
  ) {}

  get docked(): boolean {
    return this.state === "docked" || this.state === "docking";
  }

  update(dt: number, player: Ship, input: CombatInput): void {
    this.messageTimer = Math.max(0, this.messageTimer - dt);

    if (this.state === "dead") {
      this.ordnance.update(dt);
      this.debris.update(dt);
      return;
    }

    this.handlePlayerFire(dt, player, input);

    for (const hostile of this.fleet.hostiles) {
      hostile.update(dt, player, this.ordnance);
    }

    this.ordnance.update(dt);
    this.resolveProjectiles(player);
    this.debris.update(dt);
    this.updateDocking(dt, player);
    this.updateWaves(dt, player);

    if (player.hull <= 0) this.kill(player);
  }

  // ── shooting ─────────────────────────────────────────────────────────────

  private handlePlayerFire(_dt: number, player: Ship, input: CombatInput): void {
    const forward = player.forward(this.scratch).clone();
    this.nose.copy(player.position).addScaledVector(forward, 3.2);

    if (input.firePhaser && player.phaserCooldown <= 0 && player.energy > PHASER.cost) {
      player.phaserCooldown = PHASER.cooldown;
      player.energy -= PHASER.cost;

      // Aim is the nose. The cone is an assist, not a lock — it forgives a
      // couple of degrees so that pointing at something counts as pointing
      // at it, and nothing more.
      let best: { hostile: Hostile; distance: number } | null = null;
      for (const hostile of this.fleet.hostiles) {
        const toTarget = hostile.position.clone().sub(player.position);
        const distance = toTarget.length();
        if (distance > PHASER.falloffEnd) continue;
        const angle = forward.angleTo(toTarget.normalize());
        if (angle > PHASER.aimCone + hostile.spec.radius / Math.max(distance, 1)) continue;
        if (!best || distance < best.distance) best = { hostile, distance };
      }

      if (best) {
        const damage = phaserDamageAt(best.distance);
        this.ordnance.discharge(this.nose, best.hostile.position, true);
        if (damage > 0 && best.hostile.damage(damage)) {
          this.destroy(best.hostile, player);
        }
      } else {
        this.ordnance.discharge(
          this.nose,
          player.position.clone().addScaledVector(forward, PHASER.falloffEnd),
          false,
        );
      }
    }

    if (input.fireTorpedo && player.torpedoCooldown <= 0 && player.torpedoes > 0) {
      player.torpedoCooldown = TORPEDO.cooldown;
      player.torpedoes--;
      this.ordnance.fire(this.nose, forward, "torpedo", true, player.velocity);
    }
  }

  private resolveProjectiles(player: Ship): void {
    for (const projectile of this.ordnance.projectiles) {
      if (projectile.dead) continue;

      if (projectile.friendly) {
        for (const hostile of this.fleet.hostiles) {
          if (projectile.position.distanceTo(hostile.position) > hostile.spec.radius) continue;
          projectile.dead = true;
          if (hostile.damage(projectile.damage)) this.destroy(hostile, player);
          break;
        }
      } else if (projectile.position.distanceTo(player.position) <= PLAYER_RADIUS) {
        projectile.dead = true;
        const reachedHull = player.takeHit(projectile.damage, projectile.position);
        if (reachedHull) {
          // The multiplier is what a hit actually costs. Losing shields is
          // recoverable; losing the run's earnings is the punishment.
          this.multiplier = Math.max(1, this.multiplier * 0.5);
          this.say("HULL BREACH");
        }
      }
    }
  }

  private destroy(hostile: Hostile, player: Ship): void {
    const impulse = hostile.velocity.clone().multiplyScalar(0.35);
    hostile.shape.group.updateMatrixWorld(true);
    this.debris.burst(
      hostile.shape.edgePositions,
      hostile.shape.group.matrixWorld,
      PALETTE.amber,
      impulse,
      hostile.kind === "brawler" ? 1.4 : 1,
    );

    this.kills++;
    this.pending += hostile.spec.value;
    this.multiplier = Math.min(9.9, this.multiplier + 0.2);
    this.fleet.retire(hostile);
    void player;
  }

  private kill(player: Ship): void {
    this.state = "dead";
    this.pending = 0; // die undocked and the run's earnings go with you
    this.multiplier = 1;
    this.say("SHIP LOST");
    void player;
  }

  // ── docking ──────────────────────────────────────────────────────────────

  private updateDocking(dt: number, player: Ship): void {
    const toBase = this.scratch.copy(this.starbase).sub(player.position);
    const distance = toBase.length();

    if (distance > DOCK.radius) {
      if (this.dockProgress > 0) this.dockProgress = Math.max(0, this.dockProgress - dt * 2);
      if (this.state === "docking" || this.state === "docked") this.state = "fighting";
      return;
    }

    const aligned =
      player.speed < DOCK.maxSpeed &&
      player.forward(this.nose).angleTo(toBase.normalize()) < DOCK.tolerance;

    if (!aligned) {
      this.dockProgress = Math.max(0, this.dockProgress - dt);
      return;
    }

    this.state = "docking";
    this.dockProgress += dt / DOCK.duration;
    if (this.dockProgress < 1) return;

    this.bank(player);
  }

  private bank(player: Ship): void {
    const banked = Math.round(this.pending * this.multiplier);
    this.score += banked;
    this.pending = 0;
    this.multiplier = 1;
    this.dockProgress = 0;
    this.state = "docked";

    player.energy = 1;
    player.hull = 1;
    player.torpedoes = TORPEDO.capacity;
    for (const facing of ["fore", "starboard", "aft", "port"] as const) {
      player.shields[facing] = 1;
    }

    this.say(banked > 0 ? `BANKED ${banked}` : "RESUPPLIED");
  }

  // ── waves ────────────────────────────────────────────────────────────────

  private updateWaves(dt: number, player: Ship): void {
    if (this.fleet.hostiles.length > 0) {
      if (this.state === "fighting" || this.state === "clear") this.state = "fighting";
      return;
    }

    if (this.state === "fighting") {
      this.state = "clear";
      this.breakTimer = WAVE_BREAK;
      this.say("SECTOR CLEAR");
      return;
    }

    if (this.state !== "clear") return;
    this.breakTimer -= dt;
    if (this.breakTimer <= 0) this.spawnWave(player);
  }

  private spawnWave(player: Ship): void {
    this.wave++;
    this.state = "fighting";

    const roster: HostileKind[] = [];
    const n = this.wave;
    for (let i = 0; i < 2 + Math.floor(n * 0.7); i++) roster.push("swarmer");
    for (let i = 0; i < Math.max(0, Math.floor((n - 1) / 2)); i++) roster.push("sniper");
    for (let i = 0; i < Math.max(0, Math.floor((n - 3) / 3)); i++) roster.push("brawler");

    // Ring the player rather than clustering: an attack that only ever comes
    // from ahead never teaches you to watch your flanks.
    const offset = Math.random() * Math.PI * 2;
    roster.forEach((kind, index) => {
      const angle = offset + (index / roster.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const range = 95 + Math.random() * 45;
      const position = new Vector3(
        player.position.x + Math.sin(angle) * range,
        0,
        player.position.z + Math.cos(angle) * range,
      );
      this.fleet.spawn(kind, position, angle + Math.PI);
    });

    this.say(`WAVE ${this.wave}`);
  }

  // ── misc ─────────────────────────────────────────────────────────────────

  restart(player: Ship): void {
    this.fleet.clear();
    this.ordnance.clear();
    this.debris.clear();
    player.reset();
    this.state = "clear";
    this.wave = 0;
    this.score = 0;
    this.multiplier = 1;
    this.pending = 0;
    this.kills = 0;
    this.dockProgress = 0;
    this.breakTimer = 1.4;
    this.say("STAND BY");
  }

  /** Salvage on the table right now, if you docked this instant. */
  get bankable(): number {
    return Math.round(this.pending * this.multiplier);
  }

  get threat(): number {
    return this.fleet.hostiles.reduce(
      (total, hostile) => total + HOSTILE_SPECS[hostile.kind].value,
      0,
    );
  }

  private say(text: string): void {
    this.message = text;
    this.messageTimer = 2.2;
  }
}
