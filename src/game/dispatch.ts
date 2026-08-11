import { countControl, type Campaign } from "../chart/campaign.js";
import { regionName, sectorCode } from "../chart/naming.js";

/**
 * Signals from HQ, mid-run.
 *
 * The war has always been happening while you fly — the enemy commits attacks
 * between runs, they land on named sectors, and reaching one and clearing it
 * stops it. None of that was ever *said* to you. It lived on the chart, behind
 * `Tab`, as a number called `inbound`. So a player who never raised the chart
 * flew a campaign that appeared to be a series of unrelated firefights.
 *
 * This is that state, spoken. Every line is a true statement about the board at
 * the moment it is sent, read off the same campaign the chart reads.
 *
 * **They are opportunities, not orders, and the wording carries that.**
 * `intercept` in `chart/enemyTurn.ts` is explicit that reaching a threatened
 * sector is "an opportunity, never an objective: ignoring every one of these
 * costs territory on the campaign and never costs you the run." A dispatch that
 * said GO TO SECTOR 44 would quietly convert that into a task list and make
 * every run a fetch quest with a fail state the design deliberately does not
 * have. So HQ tells you what it knows and what it would like; it never tells you
 * what to do, and nothing anywhere checks whether you complied.
 *
 * **It arrives mid-wave, and that is the point.** The first version spoke only at
 * wave breaks, on the reasoning that the message row is shared with `HULL BREACH`
 * and the Warden and a paragraph from HQ arriving mid-pass would step on the one
 * line that matters. That reasoning protected the row and threw away the feature:
 * a signal that only ever lands in the quiet gap between waves is scenery, read
 * at leisure, costing nothing to receive. News from the war is supposed to arrive
 * while you are busy — the interruption *is* the content, because deciding
 * whether to look away from a fight is the only decision a dispatch can offer.
 *
 * So the collision was solved instead of avoided: **HQ has its own row.** It sits
 * below the message line, smaller and dimmer, and the two are legible together —
 * `HULL BREACH` still owns the alarm band and never has to queue behind a
 * sentence about a sector three squares away. That also means this file owns its
 * own display clock rather than borrowing `Session.messageTimer`, which is what
 * made the old version have to wait for a gap in the first place.
 *
 * Three rules keep it from becoming noise:
 *
 *  - **Only while something is alive.** Gated on a live wave, so it lands inside
 *    a fight rather than in the break — the opposite of where it used to land.
 *  - **Never twice about the same thing.** A dispatch repeats only if the board
 *    has changed, so "STRIKE INBOUND" is news rather than a ticker.
 *  - **Read-only, always.** This never writes to the campaign — which is also
 *    what keeps it safe in attract mode, where `Session` is holding the throwaway
 *    campaign and a dispatch that mutated state would be an unattended cabinet
 *    editing a war nobody is playing.
 */
export const DISPATCH = {
  /**
   * Escalation index before HQ says anything. The first couple of waves are
   * where a player is finding the controls; a paragraph about the strategic
   * situation is the last thing wanted there.
   */
  earliest: 3,
  /** Chance per attempt. Below 1 so the cadence is not a metronome. */
  chance: 0.55,
  /**
   * Seconds of live combat before the first attempt of a run, and between
   * attempts after that.
   *
   * Combat seconds, not wall seconds: the clock only runs while a wave is up, so
   * a player who docks for half a minute does not come back to a backlog, and one
   * who fights continuously hears from HQ at a rate set by how much fighting they
   * have actually done. About one or two a run at these numbers.
   */
  first: 11,
  cooldown: 24,
  /**
   * Seconds the line holds. Long, because it is a sentence with a place name in
   * it and it now has to be read *while dodging* — the old 4.4 was measured
   * against a wave break, where a player has nothing else to do.
   */
  hold: 6.2,
} as const;

/** What HQ is prepared to talk about, in the order it prefers. */
type Topic = "hold" | "intercept" | "losing" | "winning";

export class Dispatches {
  /**
   * What HQ is saying right now, and for how much longer. Public because this is
   * its own HUD row — see the header on why it stopped borrowing the message
   * line.
   */
  line: string | null = null;
  timer = 0;

  /** Combat seconds until the next attempt. */
  private next: number = DISPATCH.first;
  /** What the last one was about, so the same news is not repeated. */
  private last: string | null = null;

  /**
   * Run the clock and, sometimes, speak.
   *
   * `escalation` is `wave + threat - 1`, the same figure the roster and the Loom
   * read, so HQ starts talking at the same point the sector starts getting hard
   * rather than on a clock of its own.
   *
   * `engaged` is the mid-wave gate and the whole change: false between waves,
   * while docked, and once the run is over. The countdown does not run then
   * either, so the interval measures fighting rather than elapsed time.
   *
   * @returns true on the frame a new dispatch arrives, so the caller can chirp.
   */
  update(dt: number, campaign: Campaign, escalation: number, engaged: boolean, roll: number): boolean {
    this.timer = Math.max(0, this.timer - dt);
    if (this.timer === 0) this.line = null;

    if (!engaged || escalation < DISPATCH.earliest) return false;

    this.next -= dt;
    if (this.next > 0) return false;

    // Rearmed whatever the roll said, so a failed roll costs a full interval
    // rather than retrying every frame until it passes — which would make
    // `chance` a no-op dressed up as randomness.
    this.next = DISPATCH.cooldown;
    if (roll > DISPATCH.chance) return false;

    const composed = this.compose(campaign);
    if (!composed || composed.key === this.last) return false;

    this.last = composed.key;
    this.line = composed.text;
    this.timer = DISPATCH.hold;
    return true;
  }

  /** Reset between runs, so a new run is not silenced by the last one's news. */
  reset(): void {
    this.next = DISPATCH.first;
    this.last = null;
    this.line = null;
    this.timer = 0;
  }

  /**
   * Pick the most urgent true thing.
   *
   * Ordered rather than random: a strike already committed against the sector you
   * are standing in outranks one three squares away, which outranks the general
   * shape of the war. Random selection would sometimes tell you the enemy holds
   * twenty sectors while a bomb was falling on your head.
   */
  private compose(campaign: Campaign): { key: Topic | string; text: string } | null {
    const here = campaign.current;
    const inbound = campaign.incoming;

    // Something is already committed against where you are. The most useful
    // sentence HQ has, and the only one that is about right now.
    if (inbound.some((move) => move.sector === here)) {
      return {
        key: `hold:${here}`,
        text: `HQ: STRIKE COMMITTED ON ${this.name(campaign, here)}. YOU ARE STANDING IN IT.`,
      };
    }

    // Something is committed elsewhere. Named, with its bearing on the chart, and
    // phrased as an offer — see the header on why it is never an instruction.
    const elsewhere = inbound.find((move) => move.sector !== here);
    if (elsewhere) {
      return {
        key: `intercept:${elsewhere.sector}`,
        text: `HQ: ${this.name(campaign, elsewhere.sector)} IS NEXT. CLEAR IT AND THE STRIKE NEVER LANDS.`,
      };
    }

    // Nothing in the air. Fall back on the shape of the war, which at least tells
    // a player who never raises the chart that there is one.
    const theirs = countControl(campaign, "theirs");
    const ours = countControl(campaign, "ours");
    if (theirs > ours) {
      return {
        key: `losing:${theirs}`,
        text: `HQ: THEY HOLD ${theirs} SECTORS TO OUR ${ours}. TAKE GROUND WHERE YOU CAN.`,
      };
    }
    return {
      key: `winning:${theirs}`,
      text: `HQ: THEY ARE DOWN TO ${theirs} SECTORS. KEEP PUSHING.`,
    };
  }

  /**
   * A sector's name and its grid code together — "MORRAN 85 (D6)".
   *
   * Both halves earn their place. The name is what makes a square memorable, per
   * `chart/naming.ts`; the code is what lets a player actually find it on the
   * chart, which a name alone does not. A dispatch naming a place you cannot
   * locate is flavour pretending to be information.
   */
  private name(campaign: Campaign, index: number): string {
    return `${regionName(campaign.seed, index)} ${sectorCode(index)}`;
  }
}
