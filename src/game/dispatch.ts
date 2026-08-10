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
 * Three rules keep it from becoming noise:
 *
 *  - **Only at a wave break.** The message row is shared with `HULL BREACH` and
 *    the Warden, and a paragraph from HQ arriving mid-pass would step on the one
 *    line that actually matters. `Session.spawnWave` is the seam.
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
  /** Chance per wave break, once past `earliest`. */
  chance: 0.4,
  /** Wave breaks that must pass between two dispatches, whatever the rolls say. */
  cooldown: 3,
  /**
   * Seconds the line holds. Longer than `Session.say`'s own 2.2, because these
   * are sentences rather than two words — `HULL BREACH` is read at a glance and
   * this has a place name in it.
   */
  hold: 4.4,
} as const;

/** What HQ is prepared to talk about, in the order it prefers. */
type Topic = "hold" | "intercept" | "losing" | "winning";

export class Dispatches {
  /** Wave breaks since the last dispatch, so `cooldown` can be enforced. */
  private since: number = DISPATCH.cooldown;
  /** What the last one was about, so the same news is not repeated. */
  private last: string | null = null;

  /**
   * Consider sending one. Returns the line, or null for silence — which is the
   * common case and deliberately so.
   *
   * `escalation` is `wave + threat - 1`, the same figure the roster and the Loom
   * read, so HQ starts talking at the same point the sector starts getting hard
   * rather than on a clock of its own.
   */
  consider(campaign: Campaign, escalation: number, roll: number): string | null {
    this.since += 1;
    if (escalation < DISPATCH.earliest) return null;
    if (this.since < DISPATCH.cooldown) return null;
    if (roll > DISPATCH.chance) return null;

    const line = this.compose(campaign);
    if (!line || line.key === this.last) return null;

    this.since = 0;
    this.last = line.key;
    return line.text;
  }

  /** Reset between runs, so a new run is not silenced by the last one's news. */
  reset(): void {
    this.since = DISPATCH.cooldown;
    this.last = null;
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
