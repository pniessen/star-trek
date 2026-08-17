import { Vector3 } from "three";
import { DebrisField } from "./debris.js";
import { DeathSequence } from "./death.js";
import { HIT_STOP, HitStop } from "./hitStop.js";
import {
  Fleet,
  HOSTILE_COLORS,
  HOSTILE_SPECS,
  WITHDRAW,
  type Hostile,
  type HostileKind,
  type HostileSpec,
} from "./hostiles.js";
import {
  Ordnance,
  PHASER,
  TORPEDO,
  bearingOffset,
  blastDamageAt,
  phaserCostOf,
  phaserDamageAt,
  phaserRangeOf,
  sweepClosestPoint,
  sweepDistance,
  sweepHits,
} from "./weapons.js";
import { flight } from "./altitude.js";
import { LOOM, Loom, encounters, type Spinner } from "./loom.js";
import {
  COMET,
  Comet,
  interferenceAt,
  planFixture,
  planWanderer,
  type CometPlan,
} from "./comet.js";
import { sunAzimuthOf } from "../render/Backdrop.js";
import { Dispatches } from "./dispatch.js";
import { MINE, Minefield } from "./mines.js";
import { WARDEN, Wing, type Duty, type Escort } from "./allies.js";
import { Docking } from "./docking.js";
import { HYPERWARP, Hyperwarp } from "./hyperwarp.js";
import { intercept } from "../chart/enemyTurn.js";
import { commanderOf, guardClass, warAct, type WarAct } from "../chart/commander.js";
import { creditSalvage, type Campaign } from "../chart/campaign.js";
import { gainGround, loadoutOf } from "../chart/economy.js";
import { jumpCharge } from "../chart/jump.js";
import { stationName } from "../chart/naming.js";
import { sound } from "../audio/sound.js";
import { PALETTE } from "../render/palette.js";
import type { VectorObject } from "../render/VectorObject.js";
import { type Ship } from "./Ship.js";
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
  /**
   * Strip the after facings and stack them into the bow. Tapped, not held — see
   * `BRACE` in `Ship.ts`. It was a held trickle out of the reserve until the
   * reserve turned out to be the wrong thing to charge.
   */
  readonly brace: boolean;
}

const WAVE_BREAK = 2.6;
/**
 * The base sphere projectiles test the player against, before the hull's own
 * scaling. A Galaxy is a genuinely bigger target and a Defiant a smaller one —
 * see `chart/eras.ts`, where that is the price of the Galaxy's reserve and part
 * of what the Defiant buys with its paper shields.
 */
const PLAYER_RADIUS = 2.6;

/**
 * A collidable sphere, world space — the shape `Asteroids.rocks` produces.
 * Declared structurally rather than imported from `render/Asteroids.ts`,
 * which drags in `three`'s `BufferGeometryUtils` and the render layer along
 * with it; the four fields are the entire contract this module needs.
 */
type Rock = { x: number; y: number; z: number; r: number };

/**
 * Hitting the hero rocks field. Every number here is a first-draft guess of
 * exactly the same species as `ALTITUDE.ceiling` or `Ship.TURN_ACCEL` —
 * reasoned about, never flown, and on the tuning list in `docs/todo.md` §1.
 */
export const ROCKS = {
  /** Speed below which a rock only shoulders you off — no damage, no sound. */
  grace: 7,
  /** Damage per unit of speed above `grace`. */
  damagePerSpeed: 0.02,
  /** A single strike can never cost more than this much of a facing. */
  ceiling: 0.45,
  /** Bounce fraction on the reflected velocity — a wall, not a trampoline, but not a dead stop either. */
  restitution: 0.25,
} as const;

/**
 * A hostile shot that swept past the hull rather than into it. `outer` is
 * measured from the same point `sweepDistance` already reports; `inner` is
 * the player's own hit radius, computed per-hull in `resolveProjectiles`
 * rather than fixed here, so a bigger hull does not get a wider near-miss
 * band for free. `cooldown` keeps a dense wave from turning the cue into a
 * bed — one voice at a time is what makes it read as a specific event.
 */
const NEAR_MISS = {
  outer: 4.5,
  cooldown: 0.4,
} as const;

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
 * The commander's guard. Once the war reaches its failing act (`warAct`,
 * `chart/commander.ts`), every wave rolls a small chance of fielding one
 * veteran of the commander's own doctrine — a stat-and-name variant of an
 * existing class, never a new hull or new behaviour. One axis is boosted per
 * doctrine, echoing what that doctrine already means for the enemy turn
 * (Task 5): a raider commander's guard is faster, a hammer's tougher, and an
 * anvil's guard keeps its perch and fires faster — not harder. `damageScale`
 * is dead in the weapons pipeline (`Ordnance.fire` uses the flat module-level
 * `BOLT` damage; nothing reads `HostileSpec.damageScale`), so boosting it
 * would have been a no-op dressed up as a buff, and wiring it live is a
 * game-wide balance change — every hostile's differing `damageScale` would
 * suddenly start applying — well outside what this task is for. `cadence`
 * divides `fireInterval` instead: `Hostile.update` sets
 * `this.cooldown = this.spec.fireInterval` the instant it fires, and that
 * cooldown is the only gate on the next shot, so a smaller `fireInterval`
 * is a real, live rate-of-fire increase. Every guard is worth more salvage
 * regardless of doctrine — it is still the commander's own hull, wherever it
 * stands.
 */
const GUARD = {
  chance: 0.3,
  hull: 1.6,
  speed: 1.25,
  cadence: 1.35,
  value: 2.5,
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
  /**
   * This sector's hero rocks field, world space — empty outside a "rocks"
   * sector. Set by `main.ts` every frame, straight off `Asteroids.rocks`,
   * because the field tumbles: a value cached once per sector would drift
   * from what is actually on screen within a few frames. Cleared on
   * `restart` so a dead run's field cannot ghost-collide with the next one.
   */
  rocks: readonly Rock[] = [];
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
   * True once a wave has fielded the commander's guard, for the rest of this
   * run — one veteran per war-band excursion, not one per wave that happens
   * to roll while the act is failing. Reset in `restart`.
   */
  private guardSpawnedThisRun = false;
  /**
   * Localhost-probe seam, `arrivedByJump`'s pattern: TypeScript keeps it
   * private, but a headless test can still poke it directly on the live
   * object to force the guard roll rather than waiting out `GUARD.chance`.
   * `spawnWave` clears it the instant it is consumed, so it never survives
   * past the wave it was set for.
   */
  private forceGuard = false;
  /**
   * `warAct` latched for the length of a run. See that function's own
   * docblock for why: it reads `campaign.reserve` live, and this run's own
   * `gainGround` calls are about to start draining it, so calling `warAct`
   * fresh mid-run would call a war "failing" a couple of waves into any
   * ordinary run — not because the war is failing, but because the run is
   * doing its job. `restart` sets this once, before anything in the run has
   * spent anything; `spawnWave`'s guard gate and the dispatch fallback in
   * `update` both read this instead of calling `warAct` again. The initial
   * value here is never observed — `restart` always runs before either
   * reader does.
   */
  private actAtRunStart: WarAct = "contested";

  /**
   * 1 at the instant of arrival, decaying to 0. Read by `main.ts` to kick the
   * starfield past what the charge alone stretched it to, so the streaks peak
   * on the far side of the jump.
   */
  arrivalFlash = 0;

  /** Naval condition, recomputed each frame. Drives the panel and the alarm. */
  condition: Condition = "green";
  private readonly alert = new AlertPulse();
  // No `reinforcing` field any more. The brace publishes itself: a facing
  // holding more than one facing's worth *is* the indicator, and the shield
  // cluster reads it straight off the ship. See `BRACE` in `Ship.ts`.

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
  /**
   * HQ's channel. It has its own row and its own clock — it used to borrow this
   * message line, and that is exactly what confined it to wave breaks. See
   * `game/dispatch.ts`.
   */
  readonly dispatches = new Dispatches();
  messageTimer = 2;

  /** Seconds until the next Warden. See `ESCORT`. */
  private escortTimer = Infinity;
  /** Seconds until another near-miss cue may play. See `NEAR_MISS.cooldown`. */
  private nearMissTimer = 0;
  /** What the next one will be here for, decided by the sector, not by the clock. */
  private escortDuty: Duty = "passing";

  private readonly scratch = new Vector3();
  private readonly nose = new Vector3();
  /** The launcher's bearing-plus-elevation, rebuilt per shot. See `tubeAim`. */
  private readonly tube = new Vector3();
  /** `takeHit`'s `source` argument for a rock strike — a world position, rebuilt per rock in `collideRocks`. */
  private readonly rockScratch = new Vector3();

  /**
   * @param playerShape  the player's hull, held only so that dying can fling
   *   the actual strokes that drew it — the same treatment every hostile gets.
   */
  /**
   * Point the death sequence at a different hull.
   *
   * The player's ship is rebuilt rather than re-skinned when the era changes —
   * `VectorObject` bakes its edge list at construction — so the reference this
   * class holds would otherwise go on describing the ship the player used to
   * fly, and the death sequence would break up the wrong silhouette. Only
   * callable between runs, which is the only time the era can change.
   */
  setPlayerHull(shape: VectorObject): void {
    this.playerShape = shape;
  }

  constructor(
    private readonly fleet: Fleet,
    private readonly wing: Wing,
    /**
     * The Loom. Public because the HUD draws its ring on the tube and a headless
     * harness reads its phase, and passed in rather than built here for the same
     * reason `Fleet` and `Wing` are: it owns `VectorObject`s, and this file does
     * not know how to make one.
     */
    readonly loom: Loom,
    /**
     * The comet. Public for the same reason `loom` is — the HUD and a headless
     * harness both need to read `.plan`, and it owns a `VectorObject` this file
     * does not know how to build. Unlike `Loom`, it takes no shape factory:
     * `Comet` builds and disposes its own rock inside `show()`, because it has
     * exactly one of them at a time rather than a pool to reuse.
     */
    readonly comet: Comet,
    starbase: Vector3,
    private playerShape: VectorObject,
    private campaign: Campaign,
  ) {
    this.docking = new Docking(starbase);
    this.nameStation();
  }

  /** Seconds since the standing comet started as a wanderer. See `stepComet`. */
  private wandererAge = 0;

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

    /**
     * HQ, on its own channel and its own clock, mid-wave.
     *
     * Above the `dead` early-return so the line keeps counting down over a wreck
     * rather than freezing on screen for the whole death sequence — and gated on
     * a live wave with the player alive, so it arrives *into* a fight, which is
     * the entire reason it moved off the wave break. Read-only against the
     * campaign, which is what makes it safe while the demo flies the throwaway
     * one.
     */
    const engaged = this.state === "fighting" && this.fleet.hostiles.length > 0;
    if (this.dispatches.update(dt, this.campaign, this.escalation, engaged, Math.random(), this.actAtRunStart)) {
      sound.dispatch();
    }

    // Ease the odometer toward the real score, framerate-independently.
    this.displayScore += (this.score - this.displayScore) * (1 - Math.pow(0.006, dt));
    if (Math.abs(this.score - this.displayScore) < 0.6) this.displayScore = this.score;

    if (this.state === "dead") {
      // The fleet keeps flying and keeps shooting at the wreck. A frozen fleet
      // reads as a stopped program; a circling one reads as being finished off.
      // Nothing they fire can land — hit resolution is below this line.
      for (const hostile of this.fleet.hostiles) {
        hostile.update(dt, player, this.ordnance, this.mines, this.fleet.brawlerEngaged, this.rocks);
      }
      // The Warden keeps flying too — `kill()` has already told it to break
      // off, so the last thing a run shows you is your escort turning away.
      this.stepEscort(dt, player);
      this.ordnance.update(dt);
      // Keeps running so blasts already in flight finish expanding rather than
      // freezing half-drawn on the death screen.
      this.mines.update(dt, player, () => {});
      // And so does the weave, for the reason the fleet does: a machine that
      // stops the instant the hull goes reads as a stopped program. Nothing it
      // does can matter now — the breach callback is a no-op, and `kill()` has
      // already taken everything a breach would have cost.
      this.loom.update(dt, player, () => {});
      // And the comet: the tail keeps streaming and the nucleus keeps
      // drifting for the same reason. No interference or drain below this
      // line — there is no one left for either to matter to.
      if (this.comet.plan) this.comet.plan.nucleus.addScaledVector(this.comet.plan.drift, dt);
      this.comet.update(dt);
      this.debris.update(dt);

      const before = this.death.phase;
      const blippedBefore = this.death.blipped;
      this.death.update(dt);
      if (before !== "tally" && this.death.phase === "tally") sound.panelRestore();
      // The drift's scripted blip — emergency power trying the bus once and
      // failing — fires the relay click exactly once, on the transition into
      // it, the same before/after convention just used for `panelRestore`.
      if (!blippedBefore && this.death.blipped) sound.relayTick();
      // Every frame of the breakup and the drift — never the tally, whose
      // readout has its own cue (`panelRestore`, above) and where the beds
      // are meant to go back to their ordinary silence: `sound.panelRestore`
      // clears the hold this puts on `Sound.update`'s own `alive` gate, and
      // calling this again the same frame (or any frame after) would
      // immediately re-arm it.
      if (this.death.phase !== "tally") sound.deathPower(this.death.power);
      // Once the panel comes back up for the readout the screen belongs to it.
      // The pack circling the wreck is the right thing to watch during the
      // drift and pure noise across four lines of numbers.
      if (before !== "tally" && this.death.phase === "tally") {
        this.fleet.clear();
        this.wing.clear();
        this.loom.clear();
        this.ordnance.clear();
        // Same reasoning as the pack above: 500 strokes still streaming and a
        // nucleus still drifting over the readout is noise across four lines
        // of numbers, not atmosphere.
        this.comet.show(null);
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

    this.handleBrace(player, input);
    this.handlePlayerFire(dt, player, input);

    // Ahead of the hostile loop: `hostile.interference` has to be this frame's
    // reading before `hostile.update` reads it for cloak suppression and the
    // fire-control reach clamp, the same way `condition` above is computed
    // before anything moves this frame.
    this.stepComet(dt, player);

    // Ahead of the hostile loop for the same reason `interference` is: every
    // swarmer that reads the gate this frame should read this frame's answer.
    this.fleet.updateEngagement(player);

    for (const hostile of this.fleet.hostiles) {
      hostile.update(dt, player, this.ordnance, this.mines, this.fleet.brawlerEngaged, this.rocks);
      // The one warning the forward view gives you. Everything before this
      // moment happened on the scanner — and the sound is the half of the
      // warning that works when you are pointed the wrong way.
      if (hostile.revealed) {
        this.say("DECLOAKING");
        sound.decloak(hostile.position.x, hostile.position.z);
      }
    }
    this.stepWithdrawals(player);

    this.stepEscort(dt, player);
    this.stepLoom(dt, player);
    this.ordnance.update(dt);
    this.resolveProjectiles(dt, player);
    this.collideRocks(player);
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
    // Ending 3: hyperwarp out of a Loom. It stays where you left it, in the
    // sector you left it in, and it costs nothing beyond what the jump already
    // costs. Charging a second price for the same escape is exactly how an
    // escape valve stops being one, and the game has already taught this price
    // — half the multiplier, the same as letting something reach the hull.
    this.loom.clear();
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
    // `campaign.current` just moved to wherever this jump was headed, so the
    // comet standing here is replanned for the same reason the station's name
    // is — see `showComet`.
    this.showComet();
    sound.hyperwarpArrive();
  }

  /**
   * How hard this sector is right now: the wave count, pulled forward by the
   * threat of the square you are standing in. Threat 1 — a fresh campaign's
   * starting sector — leaves it exactly at the wave number.
   *
   * One expression with two readers, which is why it is a getter rather than a
   * local: the roster builds itself from it, and HQ starts talking at the same
   * index so a dispatch arrives when the sector starts being hard rather than on
   * a clock of its own. Two copies of this would drift.
   */
  private get escalation(): number {
    return this.wave + (this.campaign.sectors[this.campaign.current].threat - 1);
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
   * Strip and stack, on a tap. The arithmetic is `Ship.brace`; this is the seam.
   *
   * Both refusals get said out loud. A key that silently does nothing is read as
   * a key that is broken — the deck log teaches this one and a player who tries
   * it at the wrong moment needs to be told it was the moment and not the key.
   */
  private handleBrace(player: Ship, input: CombatInput): void {
    if (!input.brace || this.state === "dead") return;

    switch (player.brace()) {
      case "braced":
        this.say("SHIELDS BRACED");
        sound.brace();
        break;
      case "already-braced":
        this.say("BOW ALREADY BRACED");
        break;
      case "nothing-to-stack":
        this.say("NOTHING TO STACK");
        break;
    }
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

      // Whatever is nearer takes the beam: mine, ship, or spinner. Clearing a
      // lane costs you the shots you would rather have spent on the thing
      // shooting back — and a spinner joins that queue on exactly the same
      // terms, so lining one up through a wave is genuinely a choice about
      // where the next shot goes.
      const mine = this.mines.aim(player.position, forward, PHASER.aimCone, shotRange);
      const spun = this.loom.aim(player.position, forward, PHASER.aimCone, shotRange);
      let landed = false;
      // Fraction of full damage delivered, so the falloff rule is audible
      // rather than merely invisible. A shot into empty space keeps the full
      // figure: there was nothing out there for the range to eat.
      let reach = 1;
      if (
        mine &&
        (!best || mine.distance < best.distance) &&
        (!spun || mine.distance < spun.distance)
      ) {
        this.ordnance.discharge(this.nose, mine.mine.position, true);
        const damage = phaserDamageAt(mine.distance, fit);
        landed = damage > 0;
        reach = damage / PHASER.damage;
        if (landed && this.mines.strike(mine.mine, damage)) this.pending += MINE.value * this.salvageScale;
      } else if (spun && (!best || spun.distance < best.distance)) {
        // The falloff is charged on the true range like everything else, which
        // is most of why crossing the ring is the price of the kill: a spinner
        // shot at from the middle of a 138-unit ring is well past the beam's
        // 78-unit reach and takes nothing at all.
        const damage = phaserDamageAt(spun.distance, fit);
        this.ordnance.discharge(this.nose, spun.spinner.position, true);
        landed = damage > 0;
        reach = damage / PHASER.damage;
        if (landed && spun.spinner.damage(damage)) this.destroySpinner(spun.spinner);
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

  private resolveProjectiles(dt: number, player: Ship): void {
    this.nearMissTimer -= dt;
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

        // The Loom, on the same terms as a hull. Checked after the hostiles
        // because a spinner is the thing you meant to shoot *at range* and a
        // Raider crossing the line at the last moment has the better claim on
        // the warhead — and because a projectile only ever hits one thing.
        //
        // Note what is deliberately not here: the strands do not stop anything.
        // Ordnance passes through the fence in both directions, which is what
        // makes shooting the far spinner through the wall a legal shot and
        // stops the encounter quietly becoming cover.
        for (const spinner of this.loom.spinners) {
          const torpedo = projectile.kind === "torpedo";
          const reach = LOOM.bodyRadius + (torpedo ? TORPEDO.blast : 0);
          const approach = sweepDistance(projectile, spinner.position);
          if (approach > reach) continue;
          const damage = torpedo ? blastDamageAt(approach, LOOM.bodyRadius) : projectile.damage;
          if (damage <= 0) continue;
          projectile.dead = true;
          if (spinner.damage(damage)) {
            this.destroySpinner(spinner);
          } else {
            this.hitStop.strike(HIT_STOP.impact);
            sound.impact(spinner.position.x, spinner.position.z);
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
      } else {
        const hitRadius = PLAYER_RADIUS * player.loadout.hullRadius;
        const distanceToPlayer = sweepDistance(projectile, player.position);
        if (distanceToPlayer <= hitRadius) {
          projectile.dead = true;
          // A facing eating a bolt and a bolt reaching the hull are different
          // events and have to sound like it — that distinction is the whole
          // reason four shields exist.
          if (player.takeHit(projectile.damage, projectile.position)) {
            this.breach();
          } else {
            const facing = player.struckFacing!;
            sound.shieldHit(projectile.position.x, projectile.position.z, facing, player.shields[facing]);
          }
        } else {
          // A shot that passed close but not close enough to hit — the dodge
          // made audible and visible instead of just expiring quietly. Once
          // per projectile (`noted`), and the cue itself is rate-limited
          // separately (`nearMissTimer`) so a dense wave streaks silently
          // rather than turning into a bed of whooshes.
          if (!projectile.noted && distanceToPlayer < NEAR_MISS.outer) {
            projectile.noted = true;
            // Where it actually crossed, not the sampled endpoint — see
            // `sweepClosestPoint`. A fast torpedo can be a frame's travel
            // past the point that swept closest to the hull.
            const crossing = sweepClosestPoint(projectile, player.position);
            if (this.nearMissTimer <= 0) {
              this.nearMissTimer = NEAR_MISS.cooldown;
              sound.nearMiss(crossing.x, crossing.z);
            }
            this.ordnance.nearMiss(crossing, projectile.velocity.clone().normalize());
          }

          // Stray fire, and only stray fire. Nothing in the game aims at the
          // Warden — hostiles lead the player and always have — so what kills
          // an escort is the volume of ordnance in the air around a fight it
          // chose to fly into. Checked after the player because the bolt was
          // never meant for it, and a projectile only ever hits one thing.
          //
          // The player cannot hurt it at all: friendly projectiles resolve
          // against hostiles above, and the phaser's target search never sees
          // it. Friendly fire would turn a gift into a trap, and every arcade
          // minute spent learning not to shoot the cyan ship is a minute lost.
          if (this.wing.escort && sweepHits(projectile, this.wing.escort.position, WARDEN.radius)) {
            projectile.dead = true;
            this.wing.escort.damage(projectile.damage);
          }
        }
      }
    }
  }

  /**
   * The hero rocks field, player only — hostiles get a bounded steering
   * repulsion instead, in `Hostile.update`, never damage. Rock damage on a
   * hostile would make herding one into the field a free kill, which is an
   * economy this feature does not exist to open.
   *
   * Push-out first, so the hull is never left inside a rock even for a
   * frame; then a heavily damped reflection, so the rock reads as a wall
   * rather than a wing that bounces you off cleanly. Below `ROCKS.grace` it
   * is a free shoulder-off — no damage, no sound, no hit-stop — because a
   * graze at station-keeping speed is not what this feature is about.
   * Above it, the strike routes through `Ship.takeHit` exactly like a
   * projectile does, so a rock breach halves the multiplier through the
   * same `breach()` a bolt does rather than a copy of it.
   */
  private collideRocks(player: Ship): void {
    for (const rock of this.rocks) {
      const dx = player.position.x - rock.x;
      const dy = player.position.y - rock.y;
      const dz = player.position.z - rock.z;
      const dist = Math.hypot(dx, dy, dz);
      const hitRadius = PLAYER_RADIUS * player.loadout.hullRadius;
      const overlap = rock.r + hitRadius - dist;
      if (overlap <= 0 || dist < 1e-3) continue;

      // Push out along the contact normal first — never inside the rock.
      const nx = dx / dist, ny = dy / dist, nz = dz / dist;
      player.position.x += nx * overlap;
      player.position.y += ny * overlap;
      player.position.z += nz * overlap;

      // Reflect the inward velocity component, heavily damped: a wall.
      const vn = player.velocity.x * nx + player.velocity.y * ny + player.velocity.z * nz;
      if (vn >= 0) continue;
      player.velocity.x -= (1 + ROCKS.restitution) * vn * nx;
      player.velocity.y -= (1 + ROCKS.restitution) * vn * ny;
      player.velocity.z -= (1 + ROCKS.restitution) * vn * nz;

      // Below the grace floor the rock shoulders you off for free.
      const speedIn = -vn;
      if (speedIn <= ROCKS.grace) continue;
      const amount = Math.min(ROCKS.ceiling, (speedIn - ROCKS.grace) * ROCKS.damagePerSpeed);
      sound.thud(rock.x, rock.z);
      this.hitStop.strike(HIT_STOP.impact);
      // Route through the same lanes as any hit: a facing absorbs what it
      // can, and whatever reaches the hull halves the multiplier via the
      // real breach path.
      if (player.takeHit(amount, this.rockScratch.set(rock.x, rock.y, rock.z))) this.breach();
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
    sound.multiplierHalved();
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
    this.debris.ring(hostile.position, HOSTILE_COLORS[hostile.kind], size);

    // A bigger hull earns a longer beat, still bounded by `HIT_STOP.max`.
    this.hitStop.strike(size > 1 ? HIT_STOP.heavyKill : HIT_STOP.kill);
    // One scalar for the burst and the blast, so what you see come apart and
    // what you hear come apart are the same size.
    sound.kill(hostile.position.x, hostile.position.z, size);
    this.kills++;
    this.pending += hostile.spec.value * this.salvageScale;
    this.multiplier = Math.min(9.9, this.multiplier + 0.2);
    this.fleet.retire(hostile);
    void player;
  }

  /**
   * A hostile that broke off and cleared the field, let go for free.
   *
   * The ledger is the Warden's own precedent (`destroyByAlly`, just below):
   * no salvage, no multiplier, no kill count, no tally entry. `damage()` in
   * `hostiles.ts` already decided whether this hostile runs at all — this is
   * only the moment its escape actually completes, `WITHDRAW.exitRange` past
   * the player, and it has to cost exactly as little as being spared did.
   * Paying for a withdrawal would make crippling something and finishing it
   * off the same event with two different prices, and the game already spent
   * the Warden establishing which of those prices is real.
   *
   * The exit itself borrows Task 10's near-miss streak rather than inventing
   * a second one — a bright line at the point something *leaves* is the same
   * grammar run in reverse, not new machinery.
   *
   * Iterates a copy: `Fleet.retire` mutates `fleet.hostiles`, which a live
   * `for...of` over the original array cannot survive.
   */
  private stepWithdrawals(player: Ship): void {
    for (const hostile of [...this.fleet.hostiles]) {
      if (!hostile.withdrawing) continue;
      if (hostile.position.distanceTo(player.position) < WITHDRAW.exitRange) continue;
      // The hostile's own hue, not the amber a genuine near miss draws — this
      // streak marks a class leaving the fight, not a shot that swept close.
      this.ordnance.nearMiss(
        hostile.position,
        hostile.velocity.clone().normalize(),
        HOSTILE_COLORS[hostile.kind],
      );
      sound.withdraw(hostile.position.x, hostile.position.z);
      this.fleet.retire(hostile);
    }
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
    // The ring is world-facing, same as the burst — only the ledger below is
    // where this diverges from `destroy`. No hit-stop: that stays a feel
    // reward for the player's own kill, per this method's own docblock.
    this.debris.ring(hostile.position, HOSTILE_COLORS[hostile.kind], size);
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

  // ── the Loom ─────────────────────────────────────────────────────────────

  /**
   * One step of the weave, and the panel line it wants said.
   *
   * Everything the encounter *is* lives in `loom.ts`; everything it *costs*
   * lives here, which is the same split the Warden takes. The Loom cannot reach
   * the multiplier, the salvage or the projectile list — it hands back a breach
   * through a callback and a line through `says`, exactly as `Escort` does.
   */
  private stepLoom(dt: number, player: Ship): void {
    this.loom.update(dt, player, () => this.breach());
    if (!this.loom.says) return;
    this.say(this.loom.says);
    this.loom.says = null;
  }

  /**
   * Opens one around the player. Public so a localhost harness can summon one
   * rather than fly fourteen waves waiting for the dice — see `window.__loom`.
   * Every guard that matters is inside `Loom.open`.
   */
  seedLoom(player: Ship): void {
    this.loom.open(player);
  }

  /**
   * A spinner killed.
   *
   * The ledger is `destroy`'s, line for line and deliberately so: a kill is a
   * kill, the multiplier is the currency, and an encounter that paid on its own
   * schedule would be a second economy. What differs is only that this one also
   * ends the encounter — the weave fails on either spinner, because a loom with
   * one end is not a loom, and because "kill *either*" is what keeps the near
   * one always worth crossing for.
   *
   * The demo is safe here by construction rather than by a check: this pays into
   * `pending`, `pending` only ever reaches a campaign through `bank()`, and
   * `bank()` credits `this.campaign` — which is the throwaway during a
   * demonstration. See `bindCampaign` and `campaignFor`. There is no path from a
   * spinner to the player's salvage that does not go through a dock.
   */
  private destroySpinner(spinner: Spinner): void {
    spinner.shape.group.updateMatrixWorld(true);
    this.debris.burst(
      spinner.shape.edgePositions,
      spinner.shape.group.matrixWorld,
      PALETTE.harrow,
      new Vector3(),
      1.3,
    );

    this.hitStop.strike(HIT_STOP.kill);
    sound.kill(spinner.position.x, spinner.position.z, 1.3);
    this.kills++;
    this.pending += LOOM.value * this.salvageScale;
    this.multiplier = Math.min(9.9, this.multiplier + 0.2);
    this.loom.collapse();
    this.say("WEAVE COLLAPSING");
  }

  // ── the comet ────────────────────────────────────────────────────────────

  /**
   * One step of the comet: drifts the nucleus, streams the tail, feeds the one
   * number the tail-volume test produces into `Hostile.interference`,
   * `Escort.interference` and `Ship.interference` — the seams `hostiles.ts`,
   * `allies.ts` and `Ship.updateEnergy` consume for cloak suppression, the
   * fire-control reach clamp, and now the reserve's own recharge — and drains
   * the reserve on top of that while the player stands in the tail.
   * `docs/comet.md` §2 and §5 are the rule; everything the comet *is* lives in
   * `comet.ts`, the same split `stepLoom` takes with `loom.ts`.
   *
   * `max` of the player's own reading and each hostile's (or the escort's)
   * own is what "nothing locks across the boundary" means: either end
   * standing in the tail is enough to blind a lock between them, so a
   * hostile — or an escort — safely outside still cannot resolve a target
   * standing inside, and the reverse.
   */
  private stepComet(dt: number, player: Ship): void {
    const plan = this.comet.plan;
    // The nucleus's own drift, integrated here rather than in `Comet.update` —
    // `comet.ts`'s own header says as much: a plan is a snapshot of numbers,
    // and moving `nucleus` by `drift` every frame is a session rule, not a
    // rendering one. `Comet.update` only ever reads the position it is given.
    if (plan) plan.nucleus.addScaledVector(plan.drift, dt);
    this.comet.update(dt);

    // A wanderer's own clock. Kept here rather than in `CometPlan` — nothing
    // else on that type is a running total — so `Session` is what notices a
    // wanderer has crossed and clears it back to nothing, the same way it is
    // what notices a wave is empty and calls it clear. A fixture never expires
    // this way; only `kind === "wanderer"` is timed.
    if (plan?.kind === "wanderer") {
      this.wandererAge += dt;
      if (this.wandererAge >= COMET.wandererDuration) {
        this.comet.show(null);
        this.wandererAge = 0;
        // The tail is gone this frame, so the player's own reading goes with
        // it rather than holding whatever it last read. `hostile.interference`
        // is not corrected here the same way — a known, deferred minor, since
        // a hostile that was inside stays briefly stale for one frame rather
        // than reading a position that no longer has anything to test against.
        player.interference = 0;
        return;
      }
    } else {
      this.wandererAge = 0;
    }

    const here = interferenceAt(this.comet.plan, player.position.x, player.position.z);
    // Read by `Ship.updateEnergy` next frame — `player.update()` runs ahead of
    // `Session.update()` in `main.ts`'s own frame loop, so this is one frame
    // behind the position it describes, same as `Hostile.interference` is
    // behind the hostile that carries it. Imperceptible at 60fps and not worth
    // reordering two files over.
    player.interference = here;
    for (const hostile of this.fleet.hostiles) {
      hostile.interference = Math.max(
        here,
        interferenceAt(this.comet.plan, hostile.position.x, hostile.position.z),
      );
    }
    // The escort gets the same treatment, or it is the safe room `CLAUDE.md`
    // rules out by name: park it on the axis and every hostile it fights is
    // clamped to `COMET.visualRange` while it keeps shooting from
    // `WARDEN.fireRange`. Same shape, same "either end" reasoning as above —
    // `Escort.update` folds in the specific target's own reading too, since
    // Session has no target to look up ahead of `stepEscort` choosing one.
    if (this.wing.escort) {
      this.wing.escort.interference = Math.max(
        here,
        interferenceAt(this.comet.plan, this.wing.escort.position.x, this.wing.escort.position.z),
      );
    }
    // The drain is no longer the tail's only cost — see `Ship.updateEnergy`
    // for the regen suppression that now runs alongside it, and `COMET.drain`'s
    // own comment for why splitting the job between the two was necessary
    // rather than a second style choice. Scaled by the reserve exactly as
    // thrust (`Ship.ts` `THRUST_DRAIN`) and altitude (`ALTITUDE.drain`) are: a
    // bigger capacitor bank makes every other draw on the pool cost
    // proportionally less, and this is a draw on the same pool.
    if (here > 0) {
      player.energy = Math.max(
        0,
        player.energy - (COMET.drain * here * dt) / player.loadout.energyReserve,
      );
    }

    // A wanderer's arrival line, deferred exactly as `stepLoom` defers
    // `Loom.says` — see `placeWanderer`'s own comment for why saying it at
    // the moment of creation would lose to `WAVE n`.
    if (this.comet.says) {
      this.say(this.comet.says);
      this.comet.says = null;
    }
  }

  /**
   * The sector's comet, replanned at the same two moments `nameStation` is —
   * `campaign.current` only ever moves at a restart and a hyperwarp arrival,
   * so those are the only two places a new fixture is ever needed. Gated on
   * `encounters.comet` here rather than inside `comet.ts`'s schedulers, which
   * are pure functions with no switch of their own — the same split
   * `Loom.open` takes with `encounters.loom`.
   *
   * `sunAzimuthOf` is planned fresh from `seed`/`sector` rather than read off
   * whichever sky the live `Backdrop` currently has built — see its own
   * comment in `render/Backdrop.ts` for why a live read is wrong on exactly
   * the two frames this method is ever called on.
   */
  private showComet(): void {
    const plan = encounters.comet
      ? planFixture(
          this.campaign.seed,
          this.campaign.current,
          sunAzimuthOf(this.campaign.seed, this.campaign.current),
        )
      : null;
    this.comet.show(plan);
    this.wandererAge = 0;
  }

  /**
   * A wanderer around the player, on demand — the same convenience `seedLoom`
   * gives a harness or a person tuning `COMET.wandererChance`, who would
   * otherwise wait for a rare roll past `COMET.earliest`. See
   * `window.__comet.seed()`. Refused when the switch is off, the same guard
   * `Loom.open` makes for itself.
   */
  /**
   * @returns the plan it placed, or null if the switch is off — so the console
   *   shows the comet instead of `undefined`. A debug affordance that cannot
   *   tell you whether it worked is one you cannot trust, and this one cost a
   *   real round trip: `seed()` returning void printed `undefined` next to a
   *   `net::ERR_CONNECTION_REFUSED`, which reads as a failed call and is not.
   *   `__loom.seed()` has the same shape and the same problem.
   */
  seedComet(player: Ship): CometPlan | null {
    if (!encounters.comet) return null;
    this.placeWanderer(player);
    return this.comet.plan;
  }

  /**
   * The one place `planWanderer` is actually called — the roll in
   * `spawnWave` and the on-demand `seedComet` both land here so the two
   * cannot drift out of sync with each other.
   *
   * A wanderer used to arrive with nothing said: `COMET.wandererEntry` (260)
   * is outside both `SCANNER.range` (150) and the scene fog's far plane,
   * closing at ~4.7 units/s, so a 6% roll nobody was told about was invisible
   * to every instrument for its first ~23 seconds — a feature that does not
   * exist, by `docs/comet.md` §6's own rule. `this.comet.says` is read and
   * cleared by `stepComet` next frame, the same deferred hand-off
   * `Loom.open` uses for `WEAVE DETECTED` and for the same reason: called
   * from inside `spawnWave`, saying it here would be overwritten by `WAVE n`
   * moments later in the same call.
   */
  private placeWanderer(player: Ship): void {
    this.comet.show(
      planWanderer(
        player.position,
        sunAzimuthOf(this.campaign.seed, this.campaign.current),
        Math.random,
      ),
    );
    this.comet.says = "COMET SIGHTED";
    this.wandererAge = 0;
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
    const n = this.escalation;
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

    // The commander's guard. `actAtRunStart` — `warAct` latched at `restart`,
    // see its own docblock — is the attract firewall: the demo runs on a
    // throwaway campaign (`campaignFor`, `chart/economy.ts`) that is never in
    // the failing act at the moment a run begins, so a guard only ever turns
    // up in a real war under real pressure — never in the demo, and never in
    // a run that started in the early or contested bands, even if this run's
    // own fighting would have pushed a live read to "failing" by now.
    const act = this.actAtRunStart;
    if (
      act === "failing" &&
      (this.forceGuard || Math.random() < GUARD.chance) &&
      !this.guardSpawnedThisRun
    ) {
      this.guardSpawnedThisRun = true;
      this.forceGuard = false;
      const commander = commanderOf(this.campaign.seed);
      const kind = guardClass(commander.doctrine) as HostileKind;
      const base = HOSTILE_SPECS[kind];
      const spec: HostileSpec = {
        ...base,
        value: Math.round(base.value * GUARD.value),
        ...(commander.doctrine === "raider" ? { maxSpeed: base.maxSpeed * GUARD.speed } : {}),
        ...(commander.doctrine === "hammer" ? { hull: base.hull * GUARD.hull } : {}),
        // `fireInterval` genuinely governs cadence — see the GUARD doc
        // comment above for the fire-site line this leans on — so dividing
        // it is a live buff, unlike `damageScale`.
        ...(commander.doctrine === "anvil" ? { fireInterval: base.fireInterval / GUARD.cadence } : {}),
      };
      // Ring it in the same way the roster is ringed — the guard is a
      // veteran of an existing class, not a set-piece that needs its own
      // staging.
      const angle = offset + Math.random() * Math.PI * 2;
      const range = 95 + Math.random() * 45;
      const position = new Vector3(
        player.position.x + Math.sin(angle) * range,
        0,
        player.position.z + Math.cos(angle) * range,
      );
      this.fleet.spawn(kind, position, angle + Math.PI, { spec, guardName: commander.surname });
    }

    // The Loom, at the break and never mid-wave.
    //
    // This is the last thing `spawnWave` does, and the placement is the whole
    // guarantee: `spawnWave` is only ever reached from the wave-break branch of
    // `updateWaves`, so a wall can only ever begin closing at the one moment the
    // board is being rebuilt anyway. A ring that materialised around a fight
    // already in progress would be something that happened *to* the player;
    // arriving with the wave, it is something they are offered.
    //
    // Gated on `n` rather than on the raw wave count so a jump into the front
    // pulls it forward exactly as it pulls every class forward — the escalation
    // index is one number and this reads the same one.
    if (n >= LOOM.earliest && !this.loom.active && Math.random() < LOOM.chance) {
      this.loom.open(player);
      // Deliberately no message here. `Loom.open` writes its own line and
      // `stepLoom` says it on the next frame, over the top of `WAVE n` — which
      // is the correct order to read them in: the wave is the situation, the
      // weave is the thing that just changed about it.
    }

    // The comet's wanderer, at the break beside the Loom's roll and on the
    // same reasoning — a comet that flickered into being around a fight
    // already in progress would be something that happened *to* the player.
    // `!this.comet.plan` is both halves of the design's own gate: it refuses
    // over a sector that already has a fixture standing in it, and it refuses
    // while a previous wanderer is still mid-crossing, because both read as
    // "a comet is already here" through the one field that says so.
    if (
      encounters.comet &&
      !this.comet.plan &&
      n >= COMET.earliest &&
      Math.random() < COMET.wandererChance
    ) {
      this.placeWanderer(player);
    }

    sound.wave(this.wave);
    this.say(`WAVE ${this.wave}`);

    // HQ used to speak here, right after `WAVE n`. It does not any more — see
    // the header of `dispatch.ts`: a signal that only ever lands in the gap
    // between waves is scenery. It now runs on its own clock during the fight.
  }

  // ── misc ─────────────────────────────────────────────────────────────────

  restart(player: Ship): void {
    // HQ starts a run with nothing said, so the first dispatch of a run is never
    // suppressed by the last run's cooldown or silenced as a repeat of its news.
    this.dispatches.reset();
    // A restart is also a mode change — the shell calls this on its way to the
    // title — so anything still ringing from the last run stops here rather
    // than being heard over a screen that has no run behind it.
    sound.silence();
    this.alert.reset();
    this.condition = "green";
    this.fleet.clear();
    this.loom.clear();
    this.ordnance.clear();
    this.debris.clear();
    this.mines.clear();
    // Stale rocks from the last sector would ghost-collide with a fresh run
    // that has not yet had a frame to hand the session the new sector's field
    // — `main.ts` reassigns this every frame once flying resumes.
    this.rocks = [];
    this.docking.reset();
    this.death.reset();
    this.hitStop.clear();
    this.hyperwarp.cancel();
    this.hyperwarpDestination = -1;
    this.arrivedByJump = false;
    this.guardSpawnedThisRun = false;
    // Latched here and nowhere else, before any of this run's own ground
    // taken can drain the reserve — see `actAtRunStart`'s own docblock.
    this.actAtRunStart = warAct(this.campaign);
    this.arrivalCard = 0;
    // A jump moves `campaign.current`, and without this a "fresh" run drops
    // you wherever the last one's hyperwarp last left you — including a
    // front-row sector with a much higher threat and yield than a fresh run
    // is supposed to pay. `campaign.front` is "the sector the next run drops
    // into"; a run beginning is exactly when that promise has to be kept.
    this.campaign.current = this.campaign.front;
    this.nameStation();
    // `campaign.current` just moved to the front, so the comet standing here
    // is replanned for the same reason the station's name is — see
    // `showComet`.
    this.showComet();
    // Refits persist through death, so they are read here rather than banked
    // anywhere: the loadout is whatever the chart last agreed to, applied
    // before `reset()` so torpedo racks are already fitted when the tubes fill.
    player.loadout = loadoutOf(this.campaign.refits, this.campaign.era);
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
