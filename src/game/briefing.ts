import { canDock, countControl, type Campaign } from "../chart/campaign.js";
import { jumpSteps } from "../chart/jump.js";
import { regionName, sectorCode, stationName } from "../chart/naming.js";
import { sound } from "../audio/sound.js";

/**
 * The opening log — the mission, stated once, at the top of a war.
 *
 * **Why it exists.** A run used to begin with "STAND BY" and a wave, and the
 * campaign underneath it — a board, a front, a war with a win condition —
 * announced itself nowhere except a chart the player had to know to raise. The
 * arrival card says where you are; nothing said what any of it was *for*.
 *
 * **Why it is not the genre's version of this.** The obvious form is a
 * captain's log with a stardate, and that is the one thing we cannot ship: our
 * own universe is a locked decision, and "captain's log" plus "stardate" is the
 * most recognisable pair of words the genre owns. So the shape is kept and the
 * vocabulary is ours — a deck log, which is a real ship's record and nobody's
 * mark; a run counter, because a war that is counting something it actually
 * tracks beats a number that means nothing; and COMMAND, which needs no service
 * name to be an order. The register is the Warden's: clipped, uppercase, first
 * person plural, no proper nouns that are not places on this chart. See
 * `allies.ts`.
 *
 * **Why it is not in front of every run.** This is a cabinet. A crawl the
 * player cannot skip, in front of the fifth run of the evening, is how a loop
 * starts feeling like homework — so it plays when a campaign is new, which is
 * the only time a mission needs stating, and any key ends it on the frame it
 * arrives. Later runs already get the arrival card.
 *
 * **Everything it says is read off the board.** Sector, region, threat, yield,
 * how much ground the enemy holds, how far away the nearest of it is, whether
 * there is anywhere here to bank. A log that claimed a Bastion when the board
 * held three Raiders would teach the player to stop reading it, and an
 * instrument nobody reads is worse than one that was never drawn. Where the
 * fiction wanted a fact the campaign does not keep, the sentence was cut.
 */

/** Layout and pace, in the HUD's fixed 800-unit design space. */
export const CRAWL = {
  /**
   * Design units per second. Time-based by construction: a log that read at a
   * different speed on a slow machine would be the same bug as a trail that
   * lengthens on one.
   */
  speed: 118,
  /** Baseline to baseline, for a line of copy. */
  pitch: 44,
  /** A blank slot between stanzas. Half a line, so a stanza still reads as a block. */
  spacer: 22,
  /** The readable band. Below `bottom` a line has not risen into it yet. */
  bottom: 96,
  top: 700,
  /**
   * How far a line spends coming up out of black and going back into it. The
   * HUD has no opacity and no clip, so this *is* the clip: a colour scaled to
   * zero against an additive buffer is nothing at all.
   */
  fade: 96,
  /** How far below the band the first line starts, so the log rises into frame. */
  lead: 70,
} as const;

/**
 * Four weights and no more. `note` is the dim annotation under a statement,
 * `flag` is the one colour that means "act on this" everywhere else on the
 * panel. No new hue: cyan is ours and the log is ours.
 */
export type CrawlTone = "head" | "body" | "note" | "flag";

export const CRAWL_SCALE: Record<CrawlTone, number> = {
  head: 3.4,
  body: 2.6,
  note: 1.9,
  flag: 2.2,
};

export interface CrawlLine {
  /** Empty for a spacer, which occupies height and draws nothing. */
  readonly text: string;
  readonly tone: CrawlTone;
  /** Design units below the first line. Fixed at composition; the band moves, not this. */
  readonly offset: number;
}

/** Sectors to the nearest thing they still hold. `Infinity` if they hold none. */
function nearestEnemy(campaign: Campaign, from: number): number {
  let best = Infinity;
  for (let i = 0; i < campaign.sectors.length; i++) {
    if (campaign.sectors[i].control !== "theirs") continue;
    best = Math.min(best, jumpSteps(from, i));
  }
  return best;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "S"}`;
}

/**
 * The log itself. Every value in it is read off the campaign; the only fixed
 * words are the rules of the war, which are true by construction — clearing a
 * sector is the one thing that takes ground, zero enemy sectors is the win, an
 * unbanked multiplier dies with the ship, and a run has no end but yours.
 */
function compose(campaign: Campaign): [string, CrawlTone][] {
  const here = campaign.current;
  const sector = campaign.sectors[here];
  const theirs = countControl(campaign, "theirs");
  const out: [string, CrawlTone][] = [];
  const gap = (): void => void out.push(["", "note"]);

  // Not a stardate. `runsElapsed` is the only clock the war actually keeps, and
  // the log is being written at the top of the run about to be flown.
  out.push([`DECK LOG   RUN ${String(campaign.runsElapsed + 1).padStart(3, "0")}`, "head"]);
  gap();

  out.push([`COMMAND PUTS US AT ${sectorCode(here)}`, "body"]);
  out.push([`IN THE ${regionName(campaign.seed, here)}`, "body"]);
  out.push([`THREAT ${sector.threat}   PAYS X${1 + sector.yield}`, "note"]);
  gap();

  // A won board has no enemy to describe and no ground to take, so the whole
  // stanza goes rather than saying nothing carefully.
  if (theirs > 0) {
    out.push([`THEY HOLD ${plural(theirs, "SECTOR")}`, "body"]);
    const reach = nearestEnemy(campaign, here);
    out.push([
      reach === 0 ? "WE ARE STANDING IN ONE" : `THEIR EDGE ${plural(reach, "SECTOR")} OUT`,
      "note",
    ]);
    gap();
    out.push(["CLEAR A SECTOR TO TAKE IT", "body"]);
    out.push(["THE WAR ENDS WHEN THEY HOLD NOTHING", "note"]);
    gap();
  }

  out.push([
    canDock(sector) ? `MOORING AT ${stationName(campaign.seed, here)}` : "NO MOORING IN THIS SECTOR",
    "body",
  ]);
  out.push(["WHAT WE DO NOT BANK WE LOSE", "flag"]);
  gap();

  out.push(["THE WAVES DO NOT STOP", "body"]);
  out.push(["WE GO ANYWAY", "body"]);

  return out;
}

function layout(copy: readonly [string, CrawlTone][]): CrawlLine[] {
  const lines: CrawlLine[] = [];
  let offset = 0;
  for (const [text, tone] of copy) {
    lines.push({ text, tone, offset });
    offset += text ? CRAWL.pitch : CRAWL.spacer;
  }
  return lines;
}

/**
 * The scroll, as state.
 *
 * Deliberately not a `PresentationMode`: `ShellMode` in `chart/economy.ts` is
 * structurally the same union and `campaignFor` is the one place that decides
 * which campaign a mode may write to, so widening that union to carry a screen
 * that writes to nothing would put a fifth case into the one function whose
 * whole job is being obviously right. This is a hold *inside* a run instead —
 * the run has begun, the board is empty, and nothing is stepped until the log
 * is done or dismissed.
 */
export class Briefing {
  /** Up, and holding the run at the gate. */
  active = false;

  /** Composed once at `begin`; the band scrolls past them, they do not move. */
  lines: readonly CrawlLine[] = [];

  /** Design units travelled. The whole clock, and it is fed real seconds. */
  private travel = 0;
  /** Units of travel after which the last line has left the band for good. */
  private span = 0;
  /** How many lines have already blipped. The log prints rather than appears. */
  private spoken = 0;

  begin(campaign: Campaign): void {
    this.lines = layout(compose(campaign));
    this.travel = 0;
    this.spoken = 0;
    const last = this.lines[this.lines.length - 1];
    this.span = CRAWL.top + CRAWL.fade - CRAWL.bottom + CRAWL.lead + (last?.offset ?? 0);
    this.active = this.lines.length > 0;
  }

  /** Any key, at any point, and the run starts on the next frame. */
  skip(): void {
    this.active = false;
    this.travel = 0;
    this.lines = [];
  }

  /** @param realDt wall-clock seconds. Nothing here is ever frame-counted. */
  update(realDt: number): void {
    if (!this.active) return;
    this.travel += realDt * CRAWL.speed;

    // One panel blip per line as it clears the bottom of the band, so the log
    // reads as being printed rather than as having been there all along. The
    // resupply cue, reused: it is the panel's own acknowledgement noise and
    // this is the panel acknowledging something.
    while (this.spoken < this.lines.length && this.yOf(this.lines[this.spoken]) > CRAWL.bottom) {
      if (this.lines[this.spoken].text) sound.service(this.spoken % 4);
      this.spoken++;
    }

    if (this.travel >= this.span) this.skip();
  }

  /** Where a line is right now, in the HUD's design space. */
  yOf(line: CrawlLine): number {
    return CRAWL.bottom - CRAWL.lead + this.travel - line.offset;
  }

  /**
   * How brightly a line at `y` burns, 0-1. The band has no edges of its own —
   * a line simply stops being drawn once it has faded to nothing.
   */
  levelAt(y: number): number {
    const rising = (y - CRAWL.bottom) / CRAWL.fade;
    const leaving = (CRAWL.top - y) / CRAWL.fade;
    return Math.max(0, Math.min(1, rising, leaving));
  }
}
