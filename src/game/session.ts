import { Vector3 } from "three";
import { DebrisField } from "./debris.js";
import { DeathSequence } from "./death.js";
import { HIT_STOP, HitStop } from "./hitStop.js";
import { Fleet, HOSTILE_COLORS, HOSTILE_SPECS, type Hostile, type HostileKind } from "./hostiles.js";
import { Ordnance, PHASER, TORPEDO, phaserDamageAt } from "./weapons.js";
import { MINE, Minefield } from "./mines.js";
import { Docking } from "./docking.js";
import { HYPERWARP, Hyperwarp } from "./hyperwarp.js";
import { intercept } from "../chart/enemyTurn.js";
import type { Campaign } from "../chart/campaign.js";
import type { VectorObject } from "../render/VectorObject.js";
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
  /** Persists across waves: the field is the run's own history of where you flew. */
  readonly mines = new Minefield();
  readonly docking: Docking;
  readonly death = new DeathSequence();
  readonly hitStop = new HitStop();
  // Public because the HUD and a headless harness both need to read `.phase`
  // and `.progress`. Do not call `.begin()` on it directly — it has no idea
  // what sector it's headed for. `Session.beginHyperwarp` is the one place
  // that sets `hyperwarpDestination` before starting the charge; going
  // through the raw object skips that and arrives somewhere stale.
  readonly hyperwarp = new Hyperwarp();
  /** Sector a charge is headed for. -1 when idle — `hyperwarp.phase` is the source of truth for "charging". */
  private hyperwarpDestination = -1;
  /**
   * Set by `arrive()`, consumed by the next `updateWaves()` call. Arrival
   * empties the fleet as a side effect of the jump, not because the player
   * cleared anything in the sector they land in — without this, the
   * "fighting" state inherited from whatever was fought *before* the jump
   * would credit that unrelated fight as an interception of the destination's
   * committed attack, which is a free win the player never earned.
   */
  private arrivedByJump = false;

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
  /**
   * Frozen at the moment of dying, because `kill` zeroes the things the
   * epitaph most wants to report — chiefly what the run was worth one dock
   * short of home, which is the whole sting of the greed loop.
   */
  lastRun = { wave: 0, kills: 0, lost: 0, score: 0 };

  breakTimer = WAVE_BREAK;
  message = "STAND BY";
  messageTimer = 2;

  private readonly scratch = new Vector3();
  private readonly nose = new Vector3();

  /**
   * @param playerShape  the player's hull, held only so that dying can fling
   *   the actual strokes that drew it — the same treatment every hostile gets.
   */
  constructor(
    private readonly fleet: Fleet,
    starbase: Vector3,
    private readonly playerShape: VectorObject,
    private readonly campaign: Campaign,
  ) {
    this.docking = new Docking(starbase);
  }

  get docked(): boolean {
    return this.docking.held;
  }

  /**
   * Real seconds times this are game seconds. 1 unless a hit is landing; see
   * `hitStop.ts` for why this is bounded rather than merely small. Callers
   * outside the session — the flight model — must scale by the same number, so
   * it is published rather than kept private.
   */
  get timeScale(): number {
    return this.hitStop.scale;
  }

  /** @param realDt wall-clock seconds. Dilation is applied here, not by the caller. */
  update(realDt: number, player: Ship, input: CombatInput): void {
    const dt = realDt * this.timeScale;
    this.hitStop.advance(realDt);

    this.messageTimer = Math.max(0, this.messageTimer - dt);
    // Ease the odometer toward the real score, framerate-independently.
    this.displayScore += (this.score - this.displayScore) * (1 - Math.pow(0.006, dt));
    if (Math.abs(this.score - this.displayScore) < 0.6) this.displayScore = this.score;

    if (this.state === "dead") {
      // The fleet keeps flying and keeps shooting at the wreck. A frozen fleet
      // reads as a stopped program; a circling one reads as being finished off.
      // Nothing they fire can land — hit resolution is below this line.
      for (const hostile of this.fleet.hostiles) hostile.update(dt, player, this.ordnance, this.mines);
      this.ordnance.update(dt);
      // Keeps running so blasts already in flight finish expanding rather than
      // freezing half-drawn on the death screen.
      this.mines.update(dt, player, () => {});
      this.debris.update(dt);

      const before = this.death.phase;
      this.death.update(dt);
      // Once the panel comes back up for the readout the screen belongs to it.
      // The pack circling the wreck is the right thing to watch during the
      // drift and pure noise across four lines of numbers.
      if (before !== "tally" && this.death.phase === "tally") {
        this.fleet.clear();
        this.ordnance.clear();
      }
      return;
    }

    this.handlePlayerFire(dt, player, input);

    for (const hostile of this.fleet.hostiles) {
      hostile.update(dt, player, this.ordnance, this.mines);
      // The one warning the forward view gives you. Everything before this
      // moment happened on the scanner.
      if (hostile.revealed) this.say("DECLOAKING");
    }

    this.ordnance.update(dt);
    this.resolveProjectiles(player);
    this.mines.update(dt, player, () => this.breach());
    this.debris.update(dt);
    this.docking.update(
      dt,
      player,
      input.thrust,
      () => this.say("HARD DOCK"),
      () => this.bank(),
    );
    this.updateWaves(dt, player);

    // Fires on the frame the charge completes. Update runs the drain and the
    // countdown; arrival is a separate step because it touches the fleet,
    // the field and the campaign, none of which `Hyperwarp` itself knows about.
    if (this.hyperwarp.update(dt, player)) this.arrive(player);

    if (player.hull <= 0) this.kill(player);
  }

  // ── hyperwarp ────────────────────────────────────────────────────────────

  /**
   * Refused whenever the helm is not the player's to give up: dead, docked in
   * any phase, already charging, or a "jump" to the sector you are already
   * in — that would cost half the multiplier for nothing, which reads as a
   * bug rather than the price it is everywhere else.
   */
  beginHyperwarp(destination: number): void {
    if (this.state === "dead" || this.docking.phase !== "none") return;
    if (this.hyperwarp.charging) return;
    if (destination === this.campaign.current) return;
    this.hyperwarpDestination = destination;
    this.hyperwarp.begin();
  }

  /** Releasing early spends the energy already drained for nothing — that is the price of the gamble. */
  cancelHyperwarp(): void {
    this.hyperwarp.cancel();
    this.hyperwarpDestination = -1;
  }

  private arrive(player: Ship): void {
    // A jump costs the same as taking a hit, so the game already teaches the
    // price. Fleeing saves the ship and costs what you came for.
    this.multiplier = Math.max(1, this.multiplier * 0.5);
    this.fleet.clear();
    this.mines.clear();
    player.energy = HYPERWARP.arrivalEnergy;
    this.wave = Math.max(0, this.wave - 1); // the destination spawns its own wave

    // Arriving somewhere is the point. Without this the jump is a reset
    // button and threat and yield never come from anywhere.
    this.campaign.current = this.hyperwarpDestination;
    // This clear is the jump's doing, not a wave the player just beat here —
    // see the field comment. updateWaves() reads and clears this on its very
    // next call, whichever branch it takes.
    this.arrivedByJump = true;
    this.say("HYPERWARP");
  }

  // ── shooting ─────────────────────────────────────────────────────────────

  private handlePlayerFire(_dt: number, player: Ship, input: CombatInput): void {
    // Firing through the charge would make fleeing free, and the whole price
    // above collapses. Locking it here catches both weapons in one place.
    if (this.hyperwarp.charging) return;

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
        if (hostile.hidden) continue; // a cloaked hull is not there to lock onto
        const toTarget = hostile.position.clone().sub(player.position);
        const distance = toTarget.length();
        if (distance > PHASER.falloffEnd) continue;
        const angle = forward.angleTo(toTarget.normalize());
        if (angle > PHASER.aimCone + hostile.spec.radius / Math.max(distance, 1)) continue;
        if (!best || distance < best.distance) best = { hostile, distance };
      }

      // Whatever is nearer takes the beam, mine or ship. Clearing a lane costs
      // you the shots you would rather have spent on the thing shooting back.
      const mine = this.mines.aim(player.position, forward, PHASER.aimCone, PHASER.falloffEnd);
      if (mine && (!best || mine.distance < best.distance)) {
        this.ordnance.discharge(this.nose, mine.mine.position, true);
        const damage = phaserDamageAt(mine.distance);
        if (damage > 0 && this.mines.strike(mine.mine, damage)) this.pending += MINE.value * this.salvageScale;
      } else if (best) {
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
          if (hostile.hidden) continue; // torpedoes pass straight through a veil
          if (projectile.position.distanceTo(hostile.position) > hostile.spec.radius) continue;
          projectile.dead = true;
          // Only torpedoes reach here — phasers resolve instantly — which is
          // what keeps hit-stop an event. A phaser burst lands every 0.16s and
          // dilating on each of those would be a permanent limp.
          if (hostile.damage(projectile.damage)) this.destroy(hostile, player);
          else this.hitStop.strike(HIT_STOP.impact);
          break;
        }
        if (projectile.dead) continue;

        // Only the player's own fire clears mines. Letting hostile bolts set
        // the field off would make the danger something that happens to you
        // rather than something you flew into.
        const mine = this.mines.intercept(projectile.position, 2.4);
        if (mine) {
          projectile.dead = true;
          if (this.mines.strike(mine, projectile.damage)) this.pending += MINE.value * this.salvageScale;
        }
      } else if (projectile.position.distanceTo(player.position) <= PLAYER_RADIUS) {
        projectile.dead = true;
        if (player.takeHit(projectile.damage, projectile.position)) this.breach();
      }
    }
  }

  /**
   * Something reached the hull. The multiplier is what a hit actually costs:
   * losing shields is recoverable, losing the run's earnings is the punishment.
   */
  private breach(): void {
    this.multiplier = Math.max(1, this.multiplier * 0.5);
    this.hitStop.strike(HIT_STOP.breach);
    this.say("HULL BREACH");
  }

  private destroy(hostile: Hostile, player: Ship): void {
    const impulse = hostile.velocity.clone().multiplyScalar(0.35);
    hostile.shape.group.updateMatrixWorld(true);
    this.debris.burst(
      hostile.shape.edgePositions,
      hostile.shape.group.matrixWorld,
      HOSTILE_COLORS[hostile.kind],
      impulse,
      hostile.kind === "brawler" ? 1.4 : hostile.kind === "miner" ? 1.25 : 1,
    );

    this.hitStop.strike(HIT_STOP.kill);
    this.kills++;
    this.pending += hostile.spec.value * this.salvageScale;
    this.multiplier = Math.min(9.9, this.multiplier + 0.2);
    this.fleet.retire(hostile);
    void player;
  }

  private kill(player: Ship): void {
    this.state = "dead";
    // Everything the epitaph reports, taken before the run is wiped.
    this.lastRun = { wave: this.wave, kills: this.kills, lost: this.bankable, score: this.score };
    this.pending = 0; // die undocked and the run's earnings go with you
    this.multiplier = 1;
    this.docking.reset();
    // The dead branch of update() never steps hyperwarp, so a charge caught
    // mid-spin-up would otherwise sit at "charging" forever.
    this.hyperwarp.cancel();
    this.hyperwarpDestination = -1;
    this.arrivedByJump = false;
    this.hitStop.strike(HIT_STOP.death);
    this.death.begin(player, this.playerShape, this.debris);
    this.say("SHIP LOST");
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
    // Consumed here, once, regardless of which branch below runs — this is
    // the only call that can see the transition arrival caused, and it must
    // not leak forward to credit some later, unrelated clear.
    const arrivedByJump = this.arrivedByJump;
    this.arrivedByJump = false;

    if (this.fleet.hostiles.length > 0) {
      this.state = "fighting";
      return;
    }

    if (this.state === "fighting") {
      this.state = "clear";
      this.breakTimer = WAVE_BREAK;
      // Clearing a wave in a sector with a committed attack against it is the
      // interception — the whole reason to read the chart mid-run rather than
      // only between runs. But the "fighting" flag reaching this point can
      // also be arrival's own fleet.clear() carrying over the *previous*
      // sector's fight — see `arrivedByJump`. Only a wave the player actually
      // destroyed in the sector they are now in may intercept.
      if (arrivedByJump) return;
      if (intercept(this.campaign, this.campaign.current)) this.say("ATTACK BROKEN");
      else this.say("SECTOR CLEAR");
      return;
    }

    this.breakTimer -= dt;
    if (this.breakTimer <= 0) this.spawnWave(player);
  }

  private spawnWave(player: Ship): void {
    this.wave++;
    this.state = "fighting";

    // Escalation is by class, not only by count. The first waves teach the
    // reticle; the Harrow arrives once you have a flying habit worth punishing,
    // and the Shroud only after you have had reason to look at the scanner.
    // Both are capped — three of either is a different game, not a harder one.
    const roster: HostileKind[] = [];
    // Threat 1 — the sector a fresh campaign drops you in — leaves this
    // exactly where it always sat; each point above that pulls every class
    // forward by roughly a wave, so a jump into the front escalates visibly.
    const threat = this.campaign.sectors[this.campaign.current].threat;
    const n = this.wave + (threat - 1);
    for (let i = 0; i < 2 + Math.floor(n * 0.7); i++) roster.push("swarmer");
    for (let i = 0; i < Math.max(0, Math.floor((n - 1) / 2)); i++) roster.push("sniper");
    for (let i = 0; i < Math.max(0, Math.floor((n - 3) / 3)); i++) roster.push("brawler");
    if (n >= 4) for (let i = 0; i < Math.min(3, 1 + Math.floor((n - 4) / 4)); i++) roster.push("miner");
    if (n >= 6) for (let i = 0; i < Math.min(3, 1 + Math.floor((n - 6) / 5)); i++) roster.push("stalker");

    // Ring the player rather than clustering: an attack that only ever comes
    // from ahead never teaches you to watch your flanks.
    const offset = Math.random() * Math.PI * 2;
    roster.forEach((kind, index) => {
      const angle = offset + (index / roster.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      // A Shroud starts further out than it needs to, so its first returns land
      // on the tube while there is still time to do something about them.
      const range = (95 + Math.random() * 45) * (kind === "stalker" ? 1.4 : 1);
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
    this.mines.clear();
    this.docking.reset();
    this.death.reset();
    this.hitStop.clear();
    this.hyperwarp.cancel();
    this.hyperwarpDestination = -1;
    this.arrivedByJump = false;
    player.reset();
    this.state = "clear";
    this.wave = 0;
    this.score = 0;
    this.displayScore = 0;
    this.multiplier = 1;
    this.pending = 0;
    this.kills = 0;
    this.lastBank = { salvage: 0, multiplier: 1, total: 0 };
    this.lastRun = { wave: 0, kills: 0, lost: 0, score: 0 };
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

  /**
   * Salvage multiplier for the sector you are in right now. Floors at 1 so the
   * sector a fresh campaign drops you in — yield 0 — still pays what it always
   * did; sectors worth pushing into pay up to 4x, which is what makes jumping
   * toward the front a decision with an upside rather than only a cost.
   */
  private get salvageScale(): number {
    return 1 + this.campaign.sectors[this.campaign.current].yield;
  }

  private say(text: string): void {
    this.message = text;
    this.messageTimer = 2.2;
  }
}
