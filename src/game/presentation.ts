import { MathUtils, Vector3 } from "three";
import { Briefing } from "./briefing.js";
import { DOCK_GEOMETRY } from "./docking.js";
import { isLost, isWon, newCampaign, type Campaign } from "../chart/campaign.js";
import { advanceCampaign, campaignFor, restartCampaign, type RunReport } from "../chart/economy.js";
import { makeRng } from "../chart/rng.js";
import type { Fleet, Hostile } from "./hostiles.js";
import type { Session } from "./session.js";
import type { Ship } from "./Ship.js";

/**
 * The cabinet around the run: a title screen, a demonstration, and the game.
 *
 * An arcade attract loop is the cheapest showcase a game of this kind has —
 * the renderer already makes the spectacle, so the only work is getting out of
 * its way and letting it run with nobody at the controls. Which is exactly what
 * this does: attract mode is not a canned animation or a separate scene, it is
 * the real session with a demo pilot holding the stick. Anything that looks
 * good in the demo is something the game genuinely does.
 *
 * This is a shell *around* the session, not a state inside it. `Session.state`
 * stays the three combat states it has always been — a title screen is not a
 * phase of combat and pretending it was would put a fourth case into every
 * rule that reads the run.
 */
export type PresentationMode = "title" | "attract" | "run" | "command";

/** What the demo pilot is asking for this frame, in the player's own verbs. */
export interface PilotInput {
  readonly turn: number;
  readonly thrust: number;
  readonly firePhaser: boolean;
  readonly fireTorpedo: boolean;
}

const TIMING = {
  /** Title hold before the demonstration takes over. */
  title: 13,
  /** How long the demonstration is given to make its case. */
  attract: 34,
  /** The demo's own wreck is left on screen this long before cutting away. */
  demoDeath: 4.5,
  /** How long the epitaph is left to land before the chart comes up. */
  tally: 3.2,
  /** An abandoned command view goes back to attracting, the way a cabinet does. */
  commandIdle: 60,
} as const;

/**
 * The demonstration's own board, so a fixed seed rather than a clock: an
 * attract loop that showed a different chart every cycle would be showing the
 * cabinet's mood rather than the game.
 */
const DEMO_SEED = 20260802;

const PILOT = {
  /** Range the pilot tries to fight at. Inside the phaser's full-damage band. */
  engageRange: 24,
  /** Salvage worth flying home for. Below this the demo keeps fighting. */
  bankAt: 500,
  /** Staging point down the corridor, before it straightens up for the gate. */
  stagingOffset: 34,
  /** Steering gain on bearing error. High enough to look decisive. */
  steer: 2.4,
  /** Torpedoes are shown off, not spammed. */
  torpedoInterval: 1.8,
} as const;

export class Presentation {
  mode: PresentationMode = "title";
  /** Real seconds in the current mode. */
  time = 0;
  /**
   * Best of this sitting. Persistence is deliberately not built yet, so this is
   * honestly only that, and it says so on the title screen.
   */
  best = 0;

  /**
   * What the enemy did between the last run and this one, for the command view
   * to report. Doubles as the "this run has been resolved" flag: it is null
   * for the whole of a run and non-null from the moment `advanceCampaign` has
   * been called for it, which is what stops a tally sitting on screen from
   * advancing the war once a frame.
   */
  report: RunReport | null = null;

  /**
   * The opening log, and the run it is holding at the gate.
   *
   * Live only between `startRun` and whatever ends it, and only on a new war —
   * see `briefing.ts` for why it is a hold inside a run rather than a fifth
   * `PresentationMode`. While it is up nothing is stepped: not the session, not
   * the demo pilot, not the chart. `main.ts` reads `active` for all of that.
   */
  readonly briefing = new Briefing();

  /**
   * The seed of the campaign the log has already been read for.
   *
   * `runsElapsed === 0` alone is not enough: `R` restarts a run that has not
   * ended yet, and the campaign's clock has not moved, so the log would replay
   * every time a player bounced off the first wave. Keyed on the seed rather
   * than a bare flag because `restartCampaign` opens a new war in the same
   * object — a new seed is exactly the event that earns a second reading.
   */
  private briefedSeed: number | null = null;

  /**
   * The demonstration's throwaway campaign. The demo pilot flies the real
   * session and the real session banks salvage, so without a second campaign to
   * bank into an unattended cabinet spends the player's savings. See
   * `campaignFor`.
   */
  private readonly demo: Campaign = newCampaign(DEMO_SEED);

  /** The gate and the staging point the demo pilot flies to. */
  private readonly gate: Vector3;
  private readonly staging: Vector3;
  private readonly target = new Vector3();
  private torpedoTimer = 0;
  /** Real seconds the epitaph has been up, so the chart follows it on a clock. */
  private tallyTime = 0;

  /**
   * @param campaign  the player's own, written to by a run and by the chart
   * @param persist   called whenever the campaign changes between runs; injected
   *   rather than reaching for localStorage, so this class stays testable and
   *   the storage decision stays in one place
   */
  constructor(
    private readonly session: Session,
    private readonly player: Ship,
    private readonly fleet: Fleet,
    station: Vector3,
    private readonly campaign: Campaign,
    private readonly persist: (campaign: Campaign) => void,
  ) {
    // The demo flies the same corridor a human does — it gets no private door
    // into the station, because a demonstration of a shortcut is a lie.
    this.gate = station.clone().add(new Vector3(0, 0, -DOCK_GEOMETRY.gateOffset));
    this.staging = this.gate.clone().add(new Vector3(0, 0, -PILOT.stagingOffset));
    this.session.bindCampaign(campaignFor(this.mode, this.campaign, this.demo));
  }

  /** @param realDt wall-clock seconds; the shell's clock is never dilated. */
  update(realDt: number): void {
    this.time += realDt;

    // The log holds the run at the gate, so the shell's own clock is the only
    // thing that runs while it is up. Nothing can die, dock or spawn behind it
    // — `main.ts` does not step the session either — so there is no state below
    // that could have changed.
    if (this.briefing.active) {
      this.briefing.update(realDt);
      return;
    }

    switch (this.mode) {
      case "title":
        if (this.time >= TIMING.title) this.enter("attract");
        break;

      case "attract":
        // The demonstration ends when it dies or when it has said enough.
        if (this.session.death.phase !== "none") {
          if (this.session.death.time >= TIMING.demoDeath) this.enter("title");
        } else if (this.time >= TIMING.attract) {
          this.enter("title");
        }
        break;

      case "run":
        if (this.session.score > this.best) this.best = this.session.score;
        if (this.session.death.phase === "none") {
          this.tallyTime = 0;
          break;
        }
        // Resolved the moment the hull goes, not when the epitaph appears.
        // Deliberate: `R` restarts from the tally, and resolving there left a
        // window — a few frames wide, and a player mashing R finds it — where
        // the run ended and the enemy never took its turn. A free reroll of
        // the drop and of the whole war's clock. `report` is the once-only
        // guard; the wreck is still drifting while this runs, and nothing
        // here touches the session.
        if (!this.report) this.resolveRun();
        if (this.session.death.phase !== "tally") break;
        // Then let the epitaph land before the chart comes up over it.
        this.tallyTime += realDt;
        if (this.tallyTime >= TIMING.tally) this.enter("command");
        break;

      case "command":
        // An unattended command view goes back to attracting, the way a
        // cabinet does. The campaign is already saved, so nothing is lost.
        if (this.time >= TIMING.commandIdle) this.enter("title");
        break;
    }
  }

  /** Hand the controls to whoever pressed the key. */
  startRun(): void {
    // A war that has been won or lost is over; the next launch opens a new one.
    // Done in place rather than by rebinding — see `restartCampaign`.
    if (isWon(this.campaign) || isLost(this.campaign)) {
      restartCampaign(this.campaign, Date.now());
      this.persist(this.campaign);
    }
    this.enter("run");
    // After `enter`, never before: `Session.restart` is what puts
    // `campaign.current` back on the front, and the log names the sector the
    // run actually drops into. Read first and it would name wherever the last
    // run's hyperwarp left the cursor.
    if (this.campaign.runsElapsed === 0 && this.briefedSeed !== this.campaign.seed) {
      this.briefedSeed = this.campaign.seed;
      this.briefing.begin(this.campaign);
    }
  }

  /** Straight from the epitaph to the chart, for a player who does not want to wait. */
  enterCommand(): void {
    if (!this.report) this.resolveRun();
    this.enter("command");
  }

  /**
   * A run's aftermath, applied to the campaign exactly once. Salvage is not
   * credited here — that already happened at whatever docks the player
   * reached, which is what makes dying undocked cost the run's earnings.
   */
  private resolveRun(): void {
    const rng = makeRng(this.campaign.seed, this.campaign.rngCursor);
    this.report = advanceCampaign(this.campaign, rng);
    this.persist(this.campaign);
  }

  private enter(mode: PresentationMode): void {
    this.mode = mode;
    this.time = 0;
    // A log belongs to the run it opens. Any mode change is that run ending,
    // including the one `startRun` is in the middle of making — which is why
    // it begins the log *after* calling this rather than before.
    this.briefing.skip();
    this.torpedoTimer = 0;
    this.tallyTime = 0;
    // The command view is the one mode that exists to read the report, so it
    // is the one mode that does not clear it.
    if (mode !== "command") this.report = null;
    // A demonstration always opens on the same fresh board, so nothing the
    // demo pilot did last cycle is still on the chart this cycle.
    if (mode === "attract") restartCampaign(this.demo, DEMO_SEED);
    // Before the restart, not after: `Session.restart` reads the campaign for
    // the drop sector and the refit loadout, so binding second would fly the
    // demo on the player's loadout or the player on the demo's.
    this.session.bindCampaign(campaignFor(mode, this.campaign, this.demo));
    // Every mode change begins from a clean board — including the title, which
    // must not have the previous run's wreck drifting through it.
    this.session.restart(this.player);
  }

  /**
   * The demo pilot.
   *
   * Not an AI opponent and not a good player: it exists to show the game
   * moving. It closes, it turns, it shoots, and once the pot is worth something
   * it flies the corridor home — because the greed loop is the thing actually
   * worth demonstrating, and it is invisible if the demo only ever fights.
   *
   * **It stays on the floor.** `PilotInput` has no `climb` and `main.ts` never
   * asks for one on its behalf. A demo pilot that climbed would need a reason
   * to — over a field, off a Bastion — and a wrong reason reads as a ship
   * wandering vertically for no cause, which is worse than a ship that never
   * does. The hostiles are using the slab around it either way, so the
   * demonstration still shows a sector with height in it; what it does not show
   * is the key. That is a gap, and it is the honest kind.
   */
  fly(realDt: number): PilotInput {
    this.torpedoTimer = Math.max(0, this.torpedoTimer - realDt);

    const player = this.player;
    const homing = this.session.bankable >= PILOT.bankAt || player.hull < 0.45;
    const quarry = homing ? null : this.nearest();

    let desired: number;
    let range: number;
    let hold: number;

    if (homing) {
      // Two legs: out to a staging point on the corridor axis, then in at the
      // gate. Steering at the gate rather than holding a fixed corridor heading
      // is what makes the lateral error close itself — the approach instrument
      // tolerates half a radian, and a bearing that homes stays inside it.
      const staged = player.position.distanceTo(this.staging) < 14;
      this.target.copy(staged ? this.gate : this.staging);
      range = player.position.distanceTo(this.target);
      desired = bearingTo(player.position, this.target);
      hold = staged ? 0 : 6;
    } else if (quarry) {
      this.target.copy(quarry.position);
      range = player.position.distanceTo(this.target);
      desired = bearingTo(player.position, this.target);
      hold = PILOT.engageRange;
    } else {
      // Nothing to fight and nothing worth banking: turn on the spot, so the
      // demonstration is never a ship sitting perfectly still.
      return { turn: 0.35, thrust: 0, firePhaser: false, fireTorpedo: false };
    }

    // Screen-right is a *decreasing* heading — see Ship.update — so the sign of
    // the correction inverts on the way to the stick.
    const error = angleDelta(player.heading, desired);
    const turn = MathUtils.clamp(-error * PILOT.steer, -1, 1);

    // Never burn toward the gate above the capture ceiling; the demo has to be
    // able to actually dock at the end of it.
    const ceiling = homing && range < 40 ? DOCK_GEOMETRY.maxCaptureSpeed * 0.8 : Infinity;
    // Only burn when it is roughly pointed at where it wants to be. Thrusting
    // through a hard turn is what a bad autopilot does: momentum accumulates
    // across the turn and the ship ends up sliding away from the fight it is
    // supposed to be demonstrating.
    const aligned = Math.abs(error) < 0.7;
    const thrust =
      range > hold + 4 && aligned && player.speed < ceiling
        ? 1
        : !homing && range < hold - 8
          ? -1 // backed onto, so back off rather than orbit at zero range
          : 0;

    const aimed = Math.abs(error) < 0.14;
    const fireTorpedo =
      !homing && aimed && range > 18 && range < 60 && player.torpedoes > 4 && this.torpedoTimer <= 0;
    if (fireTorpedo) this.torpedoTimer = PILOT.torpedoInterval;

    return {
      turn,
      thrust,
      firePhaser: !homing && aimed && range < 62,
      fireTorpedo,
    };
  }

  private nearest(): Hostile | null {
    let best: Hostile | null = null;
    let bestDistance = Infinity;
    for (const hostile of this.fleet.hostiles) {
      const distance = hostile.position.distanceTo(this.player.position);
      if (distance >= bestDistance) continue;
      best = hostile;
      bestDistance = distance;
    }
    return best;
  }
}

function bearingTo(from: Vector3, to: Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}
