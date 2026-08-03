import { Vector3 } from "three";
import { DebrisField } from "./debris.js";
import { Fleet, HOSTILE_COLORS, HOSTILE_SPECS, type Hostile, type HostileKind } from "./hostiles.js";
import { Ordnance, PHASER, TORPEDO, phaserDamageAt } from "./weapons.js";
import { Docking } from "./docking.js";
import type { Ship } from "./Ship.js";

/**
 * Combat phase only. Docking is tracked separately on `docking`, because the
 * two are independent: a wave can arrive while you are clamped to the station,
 * and it should.
 */
export type SessionState = "fighting" | "clear" | "dead";

export interface CombatInput {
  readonly firePhaser: boolean;
  readonly fireTorpedo: boolean;
  /** Thrust doubles as the request to leave the mooring. */
  readonly thrust: boolean;
}

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
  readonly docking: Docking;

  state: SessionState = "clear";
  wave = 0;
  score = 0;
  multiplier = 1;
  /** Earned but unbanked. Lost entirely if you die before docking. */
  pending = 0;
  kills = 0;

  /**
   * The score as displayed, chasing the real one. A number that jumps is a
   * number nobody watches; an odometer rolling up is the payoff for the whole
   * greed loop, so it is worth the four lines.
   */
  displayScore = 0;
  /** Frozen at the moment of banking, so the tally can be shown itemised. */
  lastBank = { salvage: 0, multiplier: 1, total: 0 };

  breakTimer = WAVE_BREAK;
  message = "STAND BY";
  messageTimer = 2;

  private readonly scratch = new Vector3();
  private readonly nose = new Vector3();

  constructor(
    private readonly fleet: Fleet,
    starbase: Vector3,
  ) {
    this.docking = new Docking(starbase);
  }

  get docked(): boolean {
    return this.docking.held;
  }

  update(dt: number, player: Ship, input: CombatInput): void {
    this.messageTimer = Math.max(0, this.messageTimer - dt);
    // Ease the odometer toward the real score, framerate-independently.
    this.displayScore += (this.score - this.displayScore) * (1 - Math.pow(0.006, dt));
    if (Math.abs(this.score - this.displayScore) < 0.6) this.displayScore = this.score;

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
    this.docking.update(
      dt,
      player,
      input.thrust,
      () => this.say("HARD DOCK"),
      () => this.bank(),
    );
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
      HOSTILE_COLORS[hostile.kind],
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

  // ── banking ──────────────────────────────────────────────────────────────

  /**
   * Called by the docking sequence at the salvage-transfer stage. Repair and
   * rearm are handled there, staged over time; this is only the money.
   */
  private bank(): void {
    const total = Math.round(this.pending * this.multiplier);
    this.lastBank = { salvage: this.pending, multiplier: this.multiplier, total };
    this.score += total;
    this.pending = 0;
    this.multiplier = 1;
    this.say(total > 0 ? `BANKED ${total}` : "RESUPPLIED");
  }

  // ── waves ────────────────────────────────────────────────────────────────

  /**
   * Runs whatever the docking state is. Pausing the clock while moored made
   * the station a place to hide, which is the opposite of what the greed loop
   * needs — sitting there has to cost you the time it takes.
   */
  private updateWaves(dt: number, player: Ship): void {
    if (this.fleet.hostiles.length > 0) {
      this.state = "fighting";
      return;
    }

    if (this.state === "fighting") {
      this.state = "clear";
      this.breakTimer = WAVE_BREAK;
      this.say("SECTOR CLEAR");
      return;
    }

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
    this.docking.reset();
    player.reset();
    this.state = "clear";
    this.wave = 0;
    this.score = 0;
    this.displayScore = 0;
    this.multiplier = 1;
    this.pending = 0;
    this.kills = 0;
    this.lastBank = { salvage: 0, multiplier: 1, total: 0 };
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
