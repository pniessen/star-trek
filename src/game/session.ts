import { Vector3 } from "three";
import { DebrisField } from "./debris.js";
import { DeathSequence } from "./death.js";
import { HIT_STOP, HitStop } from "./hitStop.js";
import { Fleet, HOSTILE_COLORS, HOSTILE_SPECS, type Hostile, type HostileKind } from "./hostiles.js";
import {
  Ordnance,
  PHASER,
  TORPEDO,
  bearingOffset,
  blastDamageAt,
  phaserCostOf,
  phaserDamageAt,
  phaserRangeOf,
  sweepDistance,
  sweepHits,
} from "./weapons.js";
import { flight } from "./altitude.js";
import { MINE, Minefield } from "./mines.js";
import { WARDEN, Wing, type Duty, type Escort } from "./allies.js";
import { Docking } from "./docking.js";
import { HYPERWARP, Hyperwarp } from "./hyperwarp.js";
import { intercept } from "../chart/enemyTurn.js";
import { creditSalvage, type Campaign } from "../chart/campaign.js";
import { gainGround, loadoutOf } from "../chart/economy.js";
import { jumpCharge } from "../chart/jump.js";
import { stationName } from "../chart/naming.js";
import { sound } from "../audio/sound.js";
import { PALETTE } from "../render/palette.js";
import type { VectorObject } from "../render/VectorObject.js";
import { FACINGS, type Ship, type ShieldFacing } from "./Ship.js";
import { AlertPulse, conditionOf, type Condition } from "./alert.js";

/** Uniform in `[low, high]`. Used only for how long until the next Warden. */
function between([low, high]: readonly [number, number]): number {
  return low + Math.random() * (high - low);
}

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
  /** Feed a torpedo to the reactor. See `SCRAM` and `handlePlayerFire`. */
  readonly scram: boolean;
  /** Pour the reserve into the thinnest facing. See `REINFORCE`. */
  readonly reinforce: boolean;
}

const WAVE_BREAK = 2.6;
const PLAYER_RADIUS = 2.6;

/**
 * Seconds the arrival card holds. Short on purpose: it has to say "you are now
 * here" and then stop being in the way, because the fight it arrived into is
 * already running. Slightly under `WAVE_BREAK`, so the card is gone by the
 * time the destination's first wave announces itself.
 */
const ARRIVAL_CARD = 2.4;

/**
 * Cracking a warhead for its charge.
 *
 * The one energy pool is a locked decision, and running it dry is supposed to
 * be a real failure — so this is not a refill, it is a trade at a bad rate
 * made under pressure. A torpedo is worth roughly nine phaser shots here and
 * would have been worth a Bastion in the tube, and the whole magazine is worth
 * about two and a half reserves. It shares the tube's cooldown, so a dry ship
 * cannot dump twelve at once and pretend nothing happened.
 */
const SCRAM = {
  energy: 0.22,
  /** Above this there is no emergency, and this stops it being a free top-up. */
  ceiling: 0.5,
} as const;

/**
 * Pouring the reserve into a facing.
 *
 * Four shields that deplete separately is a locked decision, and turning a
 * fresh quarter toward the shooter is meant to be the defensive skill — but
 * until now that was the *only* thing a player could do about them, and
 * passive regeneration runs at 0.012 a second, which is eighty-three seconds
 * for one dead facing. So the shields were a thing that happened to you.
 *
 * `prior-art.md` credits Starfleet Command and Bridge Commander with two
 * combat verbs: per-facing shields and *energy allocation*. We built the first
 * and never built the second. This is the second, in its smallest honest form.
 *
 * The rate is deliberately brutal on the reserve: a facing from nothing to
 * full costs about four fifths of everything you have, which is forty phaser
 * shots you will not be firing. Turning is still cheaper than paying.
 */
const REINFORCE = {
  drain: 0.45,
  restore: 0.55,
  /** Below this there is nothing left to give and the pumps just stop. */
  floor: 0.02,
} as const;

/**
 * How far off the nose, in bearing, the torpedo tube will look for something to
 * take an elevation from. See `tubeAim`.
 *
 * Wide — forty degrees — and that is the point. A player leading a Raider
 * crossing at its preferred range is pointed twenty degrees *off* the target, so
 * a window as tight as the phaser's assist cone would find nothing at exactly
 * the moment the shot is being aimed properly. Another first-draft guess.
 */
const TUBE_WINDOW = 0.7;

/**
 * When a Warden turns up. See `allies.ts` for what one is and why it is here.
 *
 * A patrol you paid for shows up promptly, because that is what you bought. A
 * passer is rare on purpose — the player asked for "once in a while another
 * ship comes by", and a wingman on a sixty-second loop is a companion, which
 * is a different game. First contact lands late enough in a run that the
 * opening waves are still you alone.
 */
const ESCORT = {
  /** Seconds before a stationed patrol joins you. Clear of the WAVE 1 message. */
  stationDelay: 4.5,
  /** Seconds until a passer might cross the sector, and until the next one after that. */
  firstVisit: [55, 95],
  repeatVisit: [115, 195],
} as const;

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

  /**
   * 1 at the instant of arrival, decaying to 0. Read by `main.ts` to kick the
   * starfield past what the charge alone stretched it to, so the streaks peak
   * on the far side of the jump.
   */
  arrivalFlash = 0;

  /** Naval condition, recomputed each frame. Drives the panel and the alarm. */
  condition: Condition = "green";
  private readonly alert = new AlertPulse();
  /**
   * The facing currently being fed, or null. Published so the shield cluster
   * can show where the reserve is going — a player pouring four fifths of
   * their energy into a quarter should be able to see which quarter.
   */
  reinforcing: ShieldFacing | null = null;

  /**
   * Seconds left on the arrival card — where you are, what is here, and whether
   * you can bank. Counts down on real seconds and never stops the game, for the
   * same reason the chart does not: a screen the game switches to is not an
   * instrument the ship draws.
   */
  arrivalCard = 0;

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

  /** Seconds until the next Warden. See `ESCORT`. */
  private escortTimer = Infinity;
  /** What the next one will be here for, decided by the sector, not by the clock. */
  private escortDuty: Duty = "passing";

  private readonly scratch = new Vector3();
  private readonly nose = new Vector3();
  /** The launcher's bearing-plus-elevation, rebuilt per shot. See `tubeAim`. */
  private readonly tube = new Vector3();

  /**
   * @param playerShape  the player's hull, held only so that dying can fling
   *   the actual strokes that drew it — the same treatment every hostile gets.
   */
  constructor(
    private readonly fleet: Fleet,
    private readonly wing: Wing,
    starbase: Vector3,
    private readonly playerShape: VectorObject,
    private campaign: Campaign,
  ) {
    this.docking = new Docking(starbase);
    this.nameStation();
  }

  /** The Warden currently in the sector, if any. Read by the HUD and the scanner. */
  get escort(): Escort | null {
    return this.wing.escort;
  }

  /**
   * Swaps which campaign this session is playing against, and therefore which
   * one docking banks into. Not readonly, and this is the whole reason:
   * attract mode flies the real session with a demo pilot, and a session
   * permanently welded to the player's campaign would have that pilot spending
   * the player's salvage and moving the player's front while nobody is at the
   * cabinet. `Presentation` binds the throwaway before every demonstration —
   * see `campaignFor` in `chart/economy.ts`.
   */
  bindCampaign(campaign: Campaign): void {
    this.campaign = campaign;
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
    // Real seconds: the arrival streaks should coast out at the same rate on
    // any machine, and hit-stop must not stretch a visual flourish.
    this.arrivalFlash = Math.max(0, this.arrivalFlash - realDt * 1.6);
    // Real seconds, and short: the card announces the place and then gets out
    // of the way of the fight that is already happening in it.
    this.arrivalCard = Math.max(0, this.arrivalCard - realDt);

    this.messageTimer = Math.max(0, this.messageTimer - dt);
    // Ease the odometer toward the real score, framerate-independently.
    this.displayScore += (this.score - this.displayScore) * (1 - Math.pow(0.006, dt));
    if (Math.abs(this.score - this.displayScore) < 0.6) this.displayScore = this.score;

    if (this.state === "dead") {
      // The fleet keeps flying and keeps shooting at the wreck. A frozen fleet
      // reads as a stopped program; a circling one reads as being finished off.
      // Nothing they fire can land — hit resolution is below this line.
      for (const hostile of this.fleet.hostiles) hostile.update(dt, player, this.ordnance, this.mines);
      // The Warden keeps flying too — `kill()` has already told it to break
      // off, so the last thing a run shows you is your escort turning away.
      this.stepEscort(dt, player);
      this.ordnance.update(dt);
      // Keeps running so blasts already in flight finish expanding rather than
      // freezing half-drawn on the death screen.
      this.mines.update(dt, player, () => {});
      this.debris.update(dt);

      const before = this.death.phase;
      this.death.update(dt);
      if (before !== "tally" && this.death.phase === "tally") sound.panelRestore();
      // Once the panel comes back up for the readout the screen belongs to it.
      // The pack circling the wreck is the right thing to watch during the
      // drift and pure noise across four lines of numbers.
      if (before !== "tally" && this.death.phase === "tally") {
        this.fleet.clear();
        this.wing.clear();
        this.ordnance.clear();
      }
      return;
    }

    // Condition first: the alarm and the panel should describe the frame the
    // player is about to see, not the one they just survived.
    const wasCondition = this.condition;
    this.condition = conditionOf(player, this.fleet);
    if (this.condition !== wasCondition && this.condition !== "green") {
      sound.conditionChange(this.condition === "red");
      this.say(this.condition === "red" ? "RED ALERT" : "YELLOW ALERT");
    }
    // Real seconds: an alarm that slows down because the game dilated for a
    // hit-stop is an alarm that lies about how fast things are happening.
    if (this.alert.update(realDt, this.condition, Math.min(1, this.threat / 1100))) {
      sound.alertBeat(this.alert.frequency, this.alert.components);
    }

    this.handleReinforce(dt, player, input);
    this.handlePlayerFire(dt, player, input);

    for (const hostile of this.fleet.hostiles) {
      hostile.update(dt, player, this.ordnance, this.mines);
      // The one warning the forward view gives you. Everything before this
      // moment happened on the scanner — and the sound is the half of the
      // warning that works when you are pointed the wrong way.
      if (hostile.revealed) {
        this.say("DECLOAKING");
        sound.decloak(hostile.position.x, hostile.position.z);
      }
    }

    this.stepEscort(dt, player);
    this.ordnance.update(dt);
    this.resolveProjectiles(player);
    this.mines.update(dt, player, () => this.breach());
    this.debris.update(dt);
    this.docking.update(
      dt,
      player,
      input.thrust,
      // The station has a name, so the clamps engaging says it. "HARD DOCK"
      // described the manoeuvre; this describes arriving somewhere.
      () => this.say(`WELCOME TO ${this.docking.stationName}`),
      () => this.bank(),
    );
    this.updateWaves(dt, player);

    // `beginHyperwarp` only refuses at the moment a charge starts. Docking
    // runs above this line, so a ship that drifts into the station's
    // guidance sphere mid-charge can flip `docking.phase` off "none" within
    // this very frame, and nothing had re-checked it since — a charge begun
    // at range 72 was confirmed to survive into the corridor. The docking
    // state machine takes the helm the moment it leaves "none"; cancel here
    // so that guard actually holds for the whole charge, not just its start.
    if (this.hyperwarp.charging && this.docking.phase !== "none") this.cancelHyperwarp();

    // Fires on the frame the charge completes. Update runs the drain and the
    // countdown; arrival is a separate step because it touches the fleet,
    // the field and the campaign, none of which `Hyperwarp` itself knows about.
    if (this.hyperwarp.update(dt, player)) this.arrive(player);
    else if (this.hyperwarp.collapsed) {
      // The reserve ran out mid-charge. Now that distance sets the duration
      // this is a state a player will reach honestly — the chart says which
      // jumps are out of reach, but a fight can drain the reserve under one
      // that was affordable when it started, and a charge that simply stops
      // reads as a bug unless the ship says otherwise.
      this.hyperwarp.collapsed = false;
      this.hyperwarpDestination = -1;
      sound.hyperwarpAbort();
      this.say("CHARGE COLLAPSED");
    }

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
    // Distance sets the charge. Not refused when the reserve cannot cover it:
    // the chart says so before the key is held, and a charge that dies partway
    // is the same gamble as releasing early — see `chart/jump.ts`.
    const seconds = jumpCharge(this.campaign.current, destination);
    this.hyperwarp.begin(seconds);
    sound.hyperwarpCharge(seconds);
  }

  /** Releasing early spends the energy already drained for nothing — that is the price of the gamble. */
  cancelHyperwarp(): void {
    // `main.ts` asks to cancel every frame the key is not held, so this must
    // only speak when there was actually a charge to break off.
    if (this.hyperwarp.charging) sound.hyperwarpAbort();
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
    // Deliberately no wave decrement here. `arrive()` clears the fleet, so
    // `updateWaves()` → `spawnWave()` already increments on the very next
    // call — a decrement here made the net change zero or negative, and
    // since the only other price is halving a multiplier that is 1 at the
    // start of every run and immediately after every dock, a jump could cost
    // nothing while still rewinding the wave counter. Verified: six
    // alternating jumps between two adjacent sectors walked a run from wave
    // 11 to wave 7. Do not restore this — "the destination spawns its own
    // wave" was the plan's reasoning and it was wrong.

    // Arriving somewhere is the point. Without this the jump is a reset
    // button and threat and yield never come from anywhere.
    this.campaign.current = this.hyperwarpDestination;
    // This clear is the jump's doing, not a wave the player just beat here —
    // see the field comment. updateWaves() reads and clears this on its very
    // next call, whichever branch it takes.
    this.arrivedByJump = true;
    // Whoever was flying with you is in the sector you left. What greets you
    // here is whatever this sector has — which, if you garrisoned it, is the
    // patrol you paid for.
    this.scheduleEscort();
    this.arrivalFlash = 1;
    // The card says where you are, so the message line does not need to — and
    // leaving it clear means the wave that greets you gets to announce itself
    // over the top of the card rather than being shouted down by it.
    this.arrivalCard = ARRIVAL_CARD;
    this.nameStation();
    sound.hyperwarpArrive();
  }

  /**
   * The dock in the sector you are standing in has a name, and it is derived
   * rather than stored — see `chart/naming.ts`. Refreshed on arrival and at the
   * start of a run, which are the only two moments `campaign.current` moves.
   */
  private nameStation(): void {
    this.docking.stationName = stationName(this.campaign.seed, this.campaign.current);
  }

  // ── shooting ─────────────────────────────────────────────────────────────

  /**
   * Feed the thinnest facing from the reserve, while the key is held.
   *
   * Thinnest rather than the one facing the threat, deliberately: under fire a
   * player should not also have to work out which quarter the game thinks is
   * being shot at. The thin one is the one being shot at.
   */
  private handleReinforce(dt: number, player: Ship, input: CombatInput): void {
    this.reinforcing = null;
    if (!input.reinforce || this.state === "dead") return;
    if (player.energy <= REINFORCE.floor) return;

    let weakest: ShieldFacing | null = null;
    for (const facing of FACINGS) {
      if (player.shields[facing] >= 1) continue;
      if (!weakest || player.shields[facing] < player.shields[weakest]) weakest = facing;
    }
    if (!weakest) return;

    // Take the energy first and convert what was actually available, so a
    // reserve running out mid-pour tapers rather than giving a free last tick.
    const wanted = REINFORCE.drain * dt;
    const spent = Math.min(wanted, player.energy - REINFORCE.floor);
    if (spent <= 0) return;
    player.energy -= spent;
    player.shields[weakest] = Math.min(
      1,
      player.shields[weakest] + (spent / REINFORCE.drain) * REINFORCE.restore,
    );
    this.reinforcing = weakest;
  }

  private handlePlayerFire(_dt: number, player: Ship, input: CombatInput): void {
    // Firing through the charge would make fleeing free, and the whole price
    // above collapses. Locking it here catches both weapons in one place.
    if (this.hyperwarp.charging) return;

    const forward = player.forward(this.scratch).clone();
    this.nose.copy(player.position).addScaledVector(forward, 3.2);

    // Both are loadout-dependent: the capacitor bank enlarges the reserve and
    // shortens the beam, the focusing coils flatten it and cost more per shot.
    const fit = player.loadout;
    const shotCost = phaserCostOf(fit);
    const shotRange = phaserRangeOf(fit);

    if (input.firePhaser && player.phaserCooldown <= 0 && player.energy > shotCost) {
      player.phaserCooldown = PHASER.cooldown;
      player.energy -= shotCost;

      // Aim is the nose. The cone is an assist, not a lock — it forgives a
      // couple of degrees so that pointing at something counts as pointing
      // at it, and nothing more.
      // The cone is measured in *bearing*, not as a solid angle. The beam
      // itself is drawn to the hull's true position and the falloff is charged
      // on the true range, so height still costs a distant target damage — what
      // it does not cost is the ability to point at it at all, which no amount
      // of turning could have bought back on a ship that cannot pitch. See
      // `bearingOffset`.
      let best: { hostile: Hostile; distance: number } | null = null;
      for (const hostile of this.fleet.hostiles) {
        if (hostile.hidden) continue; // a cloaked hull is not there to lock onto
        const toTarget = hostile.position.clone().sub(player.position);
        const distance = toTarget.length();
        if (distance > shotRange) continue;
        const angle = bearingOffset(forward, toTarget.x, toTarget.z);
        if (angle > PHASER.aimCone + hostile.spec.radius / Math.max(distance, 1)) continue;
        if (!best || distance < best.distance) best = { hostile, distance };
      }

      // Whatever is nearer takes the beam, mine or ship. Clearing a lane costs
      // you the shots you would rather have spent on the thing shooting back.
      const mine = this.mines.aim(player.position, forward, PHASER.aimCone, shotRange);
      let landed = false;
      // Fraction of full damage delivered, so the falloff rule is audible
      // rather than merely invisible. A shot into empty space keeps the full
      // figure: there was nothing out there for the range to eat.
      let reach = 1;
      if (mine && (!best || mine.distance < best.distance)) {
        this.ordnance.discharge(this.nose, mine.mine.position, true);
        const damage = phaserDamageAt(mine.distance, fit);
        landed = damage > 0;
        reach = damage / PHASER.damage;
        if (landed && this.mines.strike(mine.mine, damage)) this.pending += MINE.value * this.salvageScale;
      } else if (best) {
        const damage = phaserDamageAt(best.distance, fit);
        this.ordnance.discharge(this.nose, best.hostile.position, true);
        landed = damage > 0;
        reach = damage / PHASER.damage;
        if (landed && best.hostile.damage(damage)) {
          this.destroy(best.hostile, player);
        }
      } else {
        this.ordnance.discharge(
          this.nose,
          player.position.clone().addScaledVector(forward, shotRange),
          false,
        );
      }
      // Connecting is a spark on the end of the same shot rather than a second
      // sound: at 6.25 shots a second, two distinct sounds is one too many.
      sound.phaser(landed, reach);
    }

    if (input.fireTorpedo && player.torpedoCooldown <= 0 && player.torpedoes > 0) {
      player.torpedoCooldown = TORPEDO.cooldown;
      player.torpedoes--;
      this.ordnance.fire(this.nose, this.tubeAim(player, forward), "torpedo", true, player.velocity);
      sound.torpedo(player.torpedoes === 0);
    } else if (input.scram && player.torpedoCooldown <= 0 && player.torpedoes > 0) {
      // Refused above the ceiling, so this cannot become a routine top-up
      // between waves — it is the thing you do when the reserve is gone and
      // something is still shooting.
      if (player.energy < SCRAM.ceiling) {
        player.torpedoCooldown = TORPEDO.cooldown;
        player.torpedoes--;
        player.energy = Math.min(1, player.energy + SCRAM.energy);
        sound.scram();
        this.say("WARHEAD SCRAMMED");
      } else {
        this.say("RESERVE TOO HIGH");
      }
    }
  }

  /**
   * The tube elevates. The hull does not.
   *
   * The player has yaw and a throttle and one key that changes their height.
   * They have no way to point the nose up or down, and they are never getting
   * one — that is the constraint the whole altitude design was built around. So
   * a torpedo fired dead level could never reach anything that was not at
   * exactly the player's own height, and the answer to "there is a Raider
   * twelve units above me" would be "there is nothing you can do about it".
   *
   * So the launcher trains in elevation onto the nearest hull within a generous
   * bearing window, and takes **only** its elevation: the player's own bearing
   * is passed through untouched. Leading the shot is still entirely theirs, and
   * leading is the whole of what distinguishes a torpedo from a phaser. What the
   * ship does for them is the one axis they cannot fly.
   *
   * Note what this deliberately is not: it is not aiming at the target, and it
   * is not the lead solution the pip draws. Point at where a crossing Raider
   * *is* and the torpedo still sails behind it, exactly as it always did.
   */
  private tubeAim(player: Ship, forward: Vector3): Vector3 {
    this.tube.copy(forward);
    if (!flight.threeD) return this.tube;

    let best: Hostile | null = null;
    let bestFlat = TORPEDO.speed * TORPEDO.life;
    for (const hostile of this.fleet.hostiles) {
      if (hostile.hidden) continue; // nothing to elevate onto that will not resolve
      const dx = hostile.position.x - player.position.x;
      const dz = hostile.position.z - player.position.z;
      const flat = Math.hypot(dx, dz);
      if (flat < 1e-3 || flat >= bestFlat) continue;
      if (bearingOffset(forward, dx, dz) > TUBE_WINDOW) continue;
      best = hostile;
      bestFlat = flat;
    }
    if (!best) return this.tube;

    const elevation = Math.atan2(best.position.y - player.position.y, bestFlat);
    const level = Math.cos(elevation);
    this.tube.set(forward.x * level, Math.sin(elevation), forward.z * level);
    return this.tube;
  }

  private resolveProjectiles(player: Ship): void {
    for (const projectile of this.ordnance.projectiles) {
      if (projectile.dead) continue;

      if (projectile.friendly) {
        for (const hostile of this.fleet.hostiles) {
          if (hostile.hidden) continue; // torpedoes pass straight through a veil
          // A torpedo detonates on proximity; a bolt has to actually connect.
          const torpedo = projectile.kind === "torpedo";
          const reach = hostile.spec.radius + (torpedo ? TORPEDO.blast : 0);
          const approach = sweepDistance(projectile, hostile.position);
          if (approach > reach) continue;
          const damage = torpedo
            ? blastDamageAt(approach, hostile.spec.radius)
            : projectile.damage;
          if (damage <= 0) continue;
          projectile.dead = true;
          // Only torpedoes reach here — phasers resolve instantly — which is
          // what keeps hit-stop an event. A phaser burst lands every 0.16s and
          // dilating on each of those would be a permanent limp.
          if (hostile.damage(damage)) {
            this.destroy(hostile, player);
          } else {
            this.hitStop.strike(HIT_STOP.impact);
            sound.impact(hostile.position.x, hostile.position.z);
          }
          break;
        }
        if (projectile.dead) continue;

        // Only the player's own fire clears mines. Letting hostile bolts set
        // the field off would make the danger something that happens to you
        // rather than something you flew into.
        const mine = this.mines.interceptSwept(projectile, 2.4);
        if (mine) {
          projectile.dead = true;
          if (this.mines.strike(mine, projectile.damage)) this.pending += MINE.value * this.salvageScale;
        }
      } else if (sweepHits(projectile, player.position, PLAYER_RADIUS)) {
        projectile.dead = true;
        // A facing eating a bolt and a bolt reaching the hull are different
        // events and have to sound like it — that distinction is the whole
        // reason four shields exist.
        if (player.takeHit(projectile.damage, projectile.position)) this.breach();
        else sound.shieldHit(projectile.position.x, projectile.position.z);
      } else if (
        this.wing.escort &&
        sweepHits(projectile, this.wing.escort.position, WARDEN.radius)
      ) {
        // Stray fire, and only stray fire. Nothing in the game aims at the
        // Warden — hostiles lead the player and always have — so what kills an
        // escort is the volume of ordnance in the air around a fight it chose
        // to fly into. Checked after the player because the bolt was never
        // meant for it, and a projectile only ever hits one thing.
        //
        // The player cannot hurt it at all: friendly projectiles resolve
        // against hostiles above, and the phaser's target search never sees it.
        // Friendly fire would turn a gift into a trap, and every arcade minute
        // spent learning not to shoot the cyan ship is a minute lost.
        projectile.dead = true;
        this.wing.escort.damage(projectile.damage);
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
    sound.breach();
    this.say("HULL BREACH");
  }

  private destroy(hostile: Hostile, player: Ship): void {
    const impulse = hostile.velocity.clone().multiplyScalar(0.35);
    const size = hostile.kind === "brawler" ? 1.4 : hostile.kind === "miner" ? 1.25 : 1;
    hostile.shape.group.updateMatrixWorld(true);
    this.debris.burst(
      hostile.shape.edgePositions,
      hostile.shape.group.matrixWorld,
      HOSTILE_COLORS[hostile.kind],
      impulse,
      size,
    );

    this.hitStop.strike(HIT_STOP.kill);
    // One scalar for the burst and the blast, so what you see come apart and
    // what you hear come apart are the same size.
    sound.kill(hostile.position.x, hostile.position.z, size);
    this.kills++;
    this.pending += hostile.spec.value * this.salvageScale;
    this.multiplier = Math.min(9.9, this.multiplier + 0.2);
    this.fleet.retire(hostile);
    void player;
  }

  // ── the Warden ───────────────────────────────────────────────────────────

  /**
   * A hostile killed by the escort.
   *
   * **It pays the player nothing.** No salvage, no multiplier, no entry in the
   * run's kill count, no hit-stop. That is the whole of the decision and it is
   * not a balance number — the multiplier is the currency and the greed loop is
   * locked, so salvage the player did not earn is a hole cut in the one rule
   * everything else hangs off. An escort that banked for you would make the
   * best play "stay behind the Warden and let it work", which is a strategy the
   * game cannot answer, and the epitaph's HOSTILES DESTROYED would stop being
   * a report on the player.
   *
   * What it *does* pay is the only thing worth paying: the hostile is gone, and
   * the shot you would have spent on it is still in the reserve. Help, priced
   * as breathing room rather than as income.
   *
   * The world does not care who fired, so everything world-facing is identical
   * to `destroy` — the same debris out of the same edge list, the same
   * explosion, placed where it happened. Only the ledger differs.
   */
  private destroyByAlly(hostile: Hostile, escort: Escort): void {
    const impulse = hostile.velocity.clone().multiplyScalar(0.35);
    const size = hostile.kind === "brawler" ? 1.4 : hostile.kind === "miner" ? 1.25 : 1;
    hostile.shape.group.updateMatrixWorld(true);
    this.debris.burst(
      hostile.shape.edgePositions,
      hostile.shape.group.matrixWorld,
      HOSTILE_COLORS[hostile.kind],
      impulse,
      size,
    );
    sound.kill(hostile.position.x, hostile.position.z, size);
    this.fleet.retire(hostile);
    escort.scored();
  }

  /**
   * One step of whatever ally is in the sector, and the clock that brings the
   * next one. Called from both branches of `update` — a dead player's escort
   * keeps flying, because a frozen one reads as a stopped program exactly the
   * way a frozen fleet does.
   */
  private stepEscort(dt: number, player: Ship): void {
    const escort = this.wing.escort;

    if (!escort) {
      // Nothing arrives over a wreck. The run is over; this sector is theirs.
      if (this.state === "dead") return;
      this.escortTimer -= dt;
      if (this.escortTimer <= 0) this.callEscort(player);
      return;
    }

    const shot = escort.update(dt, player, this.fleet.hostiles);
    if (shot) {
      // A beam, drawn from its nose in the same cyan the player's is, because
      // cyan is what "ours" looks like. It leaves the muzzle somewhere that is
      // obviously not your nose, which is what stops it reading as your shot.
      this.scratch.set(Math.sin(escort.heading), 0, Math.cos(escort.heading));
      this.nose.copy(escort.position).addScaledVector(this.scratch, 3.4);
      this.ordnance.discharge(this.nose, shot.position, true);
      sound.allyFire(escort.position.x, escort.position.z);
      if (shot.damage(WARDEN.damage)) this.destroyByAlly(shot, escort);
    }

    if (escort.dead) {
      escort.shape.group.updateMatrixWorld(true);
      this.debris.burst(
        escort.shape.edgePositions,
        escort.shape.group.matrixWorld,
        PALETTE.trace,
        escort.velocity.clone().multiplyScalar(0.35),
        1.2,
      );
      this.say(escort.epitaph);
      sound.allyLost(escort.position.x, escort.position.z);
      this.wing.retire();
      // Nothing comes back this run. Losing the escort has to be a loss, and a
      // replacement on a timer is what would stop it being one.
      //
      // Note what is deliberately *not* here: `campaign.sectors[i].patrol` is
      // untouched. Patrol attrition is already modelled between runs, in
      // `wearPatrols`, and charging the same loss twice would price a patrol
      // once on the chart and again in the cockpit.
      this.escortTimer = Infinity;
      return;
    }

    this.hear(escort);

    if (escort.departed) {
      this.wing.retire();
      this.escortDuty = "passing";
      this.escortTimer = between(ESCORT.repeatVisit);
    }
  }

  /** Puts whatever the escort has to say on the comms row, once. */
  private hear(escort: Escort): void {
    if (!escort.says) return;
    this.say(escort.says);
    if (escort.hailing) sound.allyHail(escort.position.x, escort.position.z);
    else sound.allyComms(escort.position.x, escort.position.z);
    escort.says = null;
    escort.hailing = false;
  }

  /** Brings one in from the edge of the scanner, on a bearing you did not pick. */
  private callEscort(player: Ship): void {
    const angle = Math.random() * Math.PI * 2;
    const position = new Vector3(
      player.position.x + Math.sin(angle) * WARDEN.arriveRange,
      0,
      player.position.z + Math.cos(angle) * WARDEN.arriveRange,
    );
    const escort = this.wing.spawn(this.escortDuty, position, angle + Math.PI);
    this.escortTimer = Infinity; // only one at a time; the next clock starts when it leaves
    this.hear(escort);
  }

  /**
   * Decides what the sector the player is standing in owes them, and when.
   *
   * Called wherever `campaign.current` changes — a run beginning and a jump
   * arriving — because the patrol belongs to the sector, not to the run. Flying
   * into a sector you garrisoned and being met by the ship you paid for is the
   * whole reason the chart's `patrol` row exists.
   */
  private scheduleEscort(): void {
    this.wing.clear();
    const patrolled = Boolean(this.campaign.sectors[this.campaign.current]?.patrol);
    this.escortDuty = patrolled ? "station" : "passing";
    this.escortTimer = patrolled ? ESCORT.stationDelay : between(ESCORT.firstVisit);
  }

  private kill(player: Ship): void {
    this.state = "dead";
    // Told before the state is read anywhere else, so its farewell lands over
    // the breakup rather than after it.
    this.wing.escort?.breakOff();
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
    sound.death();
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
    sound.tally(this.multiplier, total);
    this.score += total;
    // The join between the two games, and the only one there is: the arcade
    // layer earns and the strategy layer spends. Banking at a dock is the sole
    // way salvage ever reaches a campaign, which is what makes "dock now or
    // push one more wave" already the strategic question. Die undocked and the
    // campaign gets nothing, exactly as `pending` being wiped in `kill()` says.
    //
    // `this.campaign` is whichever campaign is bound — the throwaway during a
    // demonstration. See `bindCampaign`.
    creditSalvage(this.campaign, total);
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
      //
      // The cue stays on this side of that guard for the same reason the
      // message does: arriving somewhere empty is not a sector you cleared.
      if (arrivedByJump) return;
      sound.sectorClear();

      // Clearing a wave where you are standing does two things to the war, in
      // this order because they are different events that can both fire: it
      // breaks any attack committed against the sector, and it moves the
      // sector one step back toward you. The second is the only way ground is
      // ever retaken — see `gainGround` — and it is deliberately the same
      // ladder the enemy climbs, so a sector costs both sides the same to move.
      const broken = intercept(this.campaign, this.campaign.current);
      const taken = gainGround(this.campaign, this.campaign.current);
      this.say(taken ? "SECTOR TAKEN" : broken ? "ATTACK BROKEN" : "SECTOR CLEAR");
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

    sound.wave(this.wave);
    this.say(`WAVE ${this.wave}`);
  }

  // ── misc ─────────────────────────────────────────────────────────────────

  restart(player: Ship): void {
    // A restart is also a mode change — the shell calls this on its way to the
    // title — so anything still ringing from the last run stops here rather
    // than being heard over a screen that has no run behind it.
    sound.silence();
    this.alert.reset();
    this.condition = "green";
    this.reinforcing = null;
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
    this.arrivalCard = 0;
    // A jump moves `campaign.current`, and without this a "fresh" run drops
    // you wherever the last one's hyperwarp last left you — including a
    // front-row sector with a much higher threat and yield than a fresh run
    // is supposed to pay. `campaign.front` is "the sector the next run drops
    // into"; a run beginning is exactly when that promise has to be kept.
    this.campaign.current = this.campaign.front;
    this.nameStation();
    // Refits persist through death, so they are read here rather than banked
    // anywhere: the loadout is whatever the chart last agreed to, applied
    // before `reset()` so torpedo racks are already fitted when the tubes fill.
    player.loadout = loadoutOf(this.campaign.refits);
    player.reset();
    // After `campaign.current` has been set back to the front, because which
    // sector you are dropping into is what decides whether anyone meets you.
    this.scheduleEscort();
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
