import { FACINGS, type Ship } from "./Ship.js";
import type { Fleet } from "./hostiles.js";

/**
 * The ship's condition, in the naval sense — a single word for how bad this is.
 *
 * Three states because three is what a player can read without looking: nothing
 * out there, something out there, something shooting. It is deliberately not a
 * continuous threat number, even though one exists: a number is a thing you
 * interpret and a condition is a thing you already know.
 */
export type Condition = "green" | "yellow" | "red";

/**
 * The two points on the drive curve where the beat gains spectral content.
 *
 * `audio-prior-art.md` §6.3 asks for exactly two thresholds and gives numbers
 * for neither, so these are first-draft guesses of the same species as
 * `FULL_THREAT` and the flight model's constants: chosen so that all of yellow
 * and all of a wearied red sit plain, an ordinary red roughens, and only a red
 * with most of a wave still alive reaches the top tier. They want an ear.
 */
const ROUGHEN = 0.5;
const SIDEBANDS = 0.8;

export const CONDITION = {
  /** A facing this thin is a hole, and a hole is a red condition on its own. */
  thinShield: 0.2,
  /** Hull damage never falls back to yellow — once you are hit, this is real. */
  hurtHull: 0.999,
} as const;

/**
 * Green is the interesting one. It is not "safe", it is *silent* — the alert
 * stops entirely, and the research this was built from is unanimous that the
 * silence is what makes the noise mean anything. Asteroids kills its thump
 * outright when the wave is clear, by explicit branch.
 */
export function conditionOf(player: Ship, fleet: Fleet): Condition {
  if (!fleet.hostiles.length) return "green";

  if (player.hull < CONDITION.hurtHull) return "red";
  for (const facing of FACINGS) {
    if (player.shields[facing] < CONDITION.thinShield) return "red";
  }

  // Something is close enough to shoot. Not "is shooting" — by the time a bolt
  // is in the air the warning has already failed at its job.
  for (const hostile of fleet.hostiles) {
    if (hostile.hidden) continue;
    if (hostile.spec.fireRange <= 0) continue; // the Harrow never shoots
    if (player.position.distanceTo(hostile.position) <= hostile.spec.fireRange) return "red";
  }

  return "yellow";
}

/**
 * The alert pulse, shaped the way every precedent shapes it.
 *
 * `docs/audio-prior-art.md` §2 reads the Asteroids ROM and finds three things
 * the folklore gets wrong, all of which apply here: the note length never
 * changes and only the gap shrinks, so the alarm is mostly silence even at its
 * worst; the two-pitch alternation is a single bit flip, which is the cheapest
 * way to stop a repeat reading as a stuck tone; and it resets per wave, so
 * escalation is felt again rather than ratcheting past noticing.
 *
 * To that it adds the one thing Asteroids lacks, because an Asteroids wave does
 * not last ten minutes: Patterson's decay. Hold a condition unchanged and the
 * alarm backs off, returning to full urgency only when something changes.
 *
 * Patterson's own de-escalation is "drop pitch, level and speed", and the CHI
 * 2024 result (n=1,699) is that dropping *level* is the one axis that costs us:
 * raw amplification measurably hurt perceived competence, and differentiation
 * is what earns its place. The two reconcile on a third axis. Urgency here is
 * bought and sold entirely in **spectral content** — `components` below — and
 * the level of the beat never moves in either direction. A weary alarm is not
 * a quieter alarm, it is a plainer one.
 */
export class AlertPulse {
  /** Toggles every beat, so consecutive pulses differ in pitch. */
  private high = false;
  private timer = 0;
  private held = 0;
  private previous: Condition = "green";

  /** Seconds of tone remaining, 0 when between beats. */
  sounding = 0;
  /** The pitch of the beat currently sounding. */
  frequency = 0;
  /**
   * How many spectral components the beat carries: 1 plain, 2 with the minor
   * second, 4 with the modulation sidebands as well. This is the urgency axis
   * in its entirety — the cue's level is a constant.
   */
  components = 1;

  reset(): void {
    this.timer = 0;
    this.held = 0;
    this.sounding = 0;
    this.components = 1;
  }

  /**
   * @param urgency 0-1 within the condition — how much of the sector is alive.
   * @returns true on the frame a beat begins, so the caller can make a sound.
   */
  update(dt: number, condition: Condition, urgency: number): boolean {
    if (condition === "green") {
      this.reset();
      this.previous = condition;
      return false;
    }

    // Any change in condition is news, and news resets the fatigue clock.
    if (condition !== this.previous) {
      this.held = 0;
      this.previous = condition;
    }
    this.held += dt;

    this.sounding = Math.max(0, this.sounding - dt);

    // Patterson: an unchanged alarm is an alarm nobody hears after a while, so
    // it steps down rather than nagging at full strength for ten minutes.
    const weary = this.held > 8 ? 0.45 : 1;
    const drive = (condition === "red" ? 0.55 + urgency * 0.45 : urgency * 0.4) * weary;

    // Fixed tone, shrinking gap — the Asteroids shape. At full drive the duty
    // cycle is about a third, which is where that machine topped out too.
    const gap = 0.95 - drive * 0.72;

    this.timer -= dt;
    if (this.timer > 0) return false;

    this.timer = gap;
    this.high = !this.high;
    this.sounding = 0.07;
    // Rate *and* pitch, which is the one axis Asteroids did not use and Alien:
    // Isolation's motion tracker did — "faster and faster and higher in pitch",
    // first-party. Two teams thirty-five years apart, one of them with both.
    const base = (condition === "red" ? 96 : 64) + drive * 34;
    this.frequency = this.high ? base * 1.19 : base;
    // And the third axis. Note that `weary` halves `drive`, so Patterson's
    // step-down falls out of the same two thresholds: an alarm nobody has
    // answered for eight seconds loses its partials before it loses anything
    // else, and gets them back the moment the situation changes.
    this.components = drive >= SIDEBANDS ? 4 : drive >= ROUGHEN ? 2 : 1;
    return true;
  }
}
