import { canDock, countControl, type Campaign } from "../chart/campaign.js";
import { commanderOf, warAct, type Doctrine } from "../chart/commander.js";
import { planFixture } from "./comet.js";
import { jumpSteps } from "../chart/jump.js";
import { regionName, sectorCode, stationName } from "../chart/naming.js";
import { sound } from "../audio/sound.js";

/**
 * The opening log — where we are, what it is worth, and what we are here for.
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
 * **Why it is in front of every run, in two lengths.** It shipped playing only
 * once per war, and the owner of this repo never saw it — which is the whole
 * argument: a briefing nobody encounters is not a briefing. So it opens every
 * run now, because every run drops into a sector with its own threat, its own
 * yield and its own mooring, and *that* is what a briefing is for. What does
 * not repeat is the teaching: the rules of the war — clearing takes ground,
 * zero enemy sectors wins, an unbanked multiplier dies with the ship, the
 * waves never stop — are onboarding, and reading them before run forty is
 * noise. `teach` is true exactly once per seed and adds those four sentences
 * back. Two escape hatches, because this is a cabinet: any key ends it on the
 * frame it arrives, and `L` stops it playing at all.
 *
 * **Why it opens with content already on screen.** The first cut started the
 * whole crawl below the readable band, so the opening seconds were an empty
 * screen with one amber line at the bottom saying a key would launch — an
 * instruction to destroy the content before the content arrived. It is
 * measured now rather than reasoned about: the head stands at `entry`, inside
 * the band, on the frame the log opens, and `hold` gives the eye a beat to
 * land on it before anything moves.
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
  /**
   * Where the first line stands when the log opens — inside the band, at full
   * brightness, on the first frame. This replaced a `lead` that started the
   * head *below* the band: the crawl then spent 1.2 seconds showing an empty
   * screen and another second fading the head in, measured, on a machine
   * faster than the one that reported the bug. High enough that the opening
   * stanza is already legible, low enough that everything under it still
   * arrives as a crawl rather than as a page.
   */
  entry: 300,
  /**
   * Real seconds the log stands still before it starts moving. A beat for the
   * eye to land on the head, and the difference between opening on a document
   * and opening mid-scroll.
   */
  hold: 0.5,
} as const;

/**
 * Four weights and no more. `note` is the dim annotation under a statement,
 * `flag` is the one colour that means "act on this" everywhere else on the
 * panel. No new hue: cyan is ours and the log is ours.
 */
export type CrawlTone = "head" | "body" | "note" | "flag";

/**
 * Brightness at which a line counts as read rather than as arriving. Not a
 * drawing threshold — the crawl draws everything down to nothing — but the bar
 * `readable()` holds a line to, and therefore the bar the pacing assertion in
 * `tools/playtest.mjs` holds the whole log to.
 */
export const LEGIBLE = 0.6;

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
 *
 * @param teach the first run of this war, so the rules are worth stating. Every
 *   run gets the situational half — sector, region, threat, yield, what they
 *   still hold, how far out it is, whether there is anywhere here to bank.
 */
function compose(campaign: Campaign, teach: boolean): [string, CrawlTone][] {
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

  /**
   * Whether a comet stands here — and this line is the whole reason the log
   * knows about comets at all.
   *
   * A fixture's nucleus sits 150-230 units out against a scanner that reaches
   * 150, and its tail often points away, so a sector can contain one with
   * nothing on the tube to say so. Test play found exactly that, four times
   * over, and every answer was a console command. `docs/comet.md` §6 is blunt
   * about what that means: "a region you cannot navigate to is a region that
   * does not exist."
   *
   * Read off `planFixture` rather than off the live `Comet`, because the log is
   * composed before the run places anything — and passing `null` for the sun is
   * correct here, since that argument only sets the tail's *bearing* and this
   * line only asks whether there is one.
   *
   * The fact is stated on every run; the rule only on the first of a war, which
   * is the split the whole log is built on.
   */
  if (planFixture(campaign.seed, here, null)) {
    out.push(["A COMET RUNS THROUGH THIS SECTOR", "body"]);
    if (teach) out.push(["NOTHING RESOLVES INSIDE ITS TAIL", "note"]);
  }
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
    const act = warAct(campaign);
    out.push([
      act === "surge"
        ? "THEIR SUPPLY RUNS DEEP"
        : act === "failing"
          ? "THEY ARE SPENDING THEIR LAST"
          : "THEIR RESERVE STRAINS",
      "note",
    ]);
    gap();
    if (teach) {
      const commander = commanderOf(campaign.seed);
      out.push([`THEIR COMMANDER IS ${commander.given} ${commander.surname}`, "body"]);
      // Two forms per doctrine, not one: the drawn pronoun must agree with its
      // verb, and THEY takes the plural. SHE and HE share the singular.
      const DOCTRINE_LINE: Record<Doctrine, { singular: string; plural: string }> = {
        raider: { singular: "SPENDS SHIPS LIKE SHOT", plural: "SPEND SHIPS LIKE SHOT" },
        hammer: { singular: "MASSES BEFORE MOVING", plural: "MASS BEFORE MOVING" },
        anvil: {
          singular: "PAYS FOR GROUND ONCE AND KEEPS IT",
          plural: "PAY FOR GROUND ONCE AND KEEP IT",
        },
      };
      const form = DOCTRINE_LINE[commander.doctrine];
      out.push([
        `${commander.pronoun} ${commander.pronoun === "THEY" ? form.plural : form.singular}`,
        "note",
      ]);
      gap();
      out.push(["CLEAR A SECTOR TO TAKE IT", "body"]);
      out.push(["THE WAR ENDS WHEN THEY HOLD NOTHING", "note"]);
      gap();
    }
  }

  // Amber appears exactly once, on whichever sentence in this log is about
  // banking — the rule, the first time, and afterwards the fact that there is
  // nowhere here to obey it. A sector with a mooring and a player who has
  // already been taught gets no amber at all, which is correct: nothing on
  // this screen is asking to be acted on.
  const moored = canDock(sector);
  out.push([
    moored ? `MOORING AT ${stationName(campaign.seed, here)}` : "NO MOORING IN THIS SECTOR",
    teach || moored ? "body" : "flag",
  ]);

  if (teach) {
    out.push(["WHAT WE DO NOT BANK WE LOSE", "flag"]);
    gap();
    out.push(["THE WAVES DO NOT STOP", "body"]);
    out.push(["WE GO ANYWAY", "body"]);
  }

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
  /**
   * Whether the log plays at all. `L` flips it — see `main.ts` — and it is the
   * answer to a player who has read enough of these.
   *
   * **In memory, not on disk.** There is no pattern in this repo for persisting
   * a display setting: the shape mode, the three post passes, the diagnostics,
   * the mute and the slab are all plain fields that reset on reload. Inventing
   * a second storage key next to `kobayashi.campaign` for the sixth such
   * setting would be inventing a convention rather than following one.
   */
  enabled = true;

  /** Up, and holding the run at the gate. */
  active = false;

  /** Composed once at `begin`; the band scrolls past them, they do not move. */
  lines: readonly CrawlLine[] = [];

  /** Real seconds this log has been up, `hold` included. Paces the skip hint. */
  elapsed = 0;

  /** Design units travelled. The whole clock, and it is fed real seconds. */
  private travel = 0;
  /** Units of travel after which the last line has left the band for good. */
  private span = 0;
  /** How many lines have already blipped. The log prints rather than appears. */
  private spoken = 0;
  /** Real seconds still owed to the opening hold. */
  private holding = 0;

  /**
   * @param teach the first run of this war; adds the rules to the brief.
   *
   * A no-op while `enabled` is false, so the switch is honoured in one place
   * rather than at every call site — and `active` stays false, which is what
   * every caller actually reads.
   */
  begin(campaign: Campaign, teach: boolean): void {
    if (!this.enabled) return;
    this.start(layout(compose(campaign, teach)));
  }

  /**
   * The other end of the same crawl: not a run's opening but a war's closing.
   * Fired once, from `Presentation.toCommand`, exactly when the run that just
   * ended also ended the war — `isWon`/`isLost` decide that, not this class.
   * Same mechanism as `begin` top to bottom: composed once, scrolled by
   * `update`, skippable by any key, silenced by the same `enabled` switch —
   * a player who has turned the deck log off does not want it back for the
   * one crawl they cannot fly past.
   */
  beginEpilogue(campaign: Campaign, won: boolean): void {
    if (!this.enabled) return;
    const commander = commanderOf(campaign.seed);
    const theirs = countControl(campaign, "theirs");
    const copy: [string, CrawlTone][] = won
      ? [
          ["DECK LOG   FINAL", "head"],
          ["", "note"],
          ["THE INVASION IS BROKEN", "body"],
          [`${commander.surname} WITHDRAWS`, "body"],
          [
            `${campaign.runsElapsed} RUNS. THEY STILL HELD ${plural(theirs, "SECTOR")}. IT DID NOT MATTER.`,
            "note",
          ],
          ["", "note"],
          ["THE WAVES STOPPED", "body"],
          ["WE GO HOME", "flag"],
        ]
      : [
          ["DECK LOG   FINAL", "head"],
          ["", "note"],
          ["THE LAST STARBASE IS GONE", "body"],
          [`${commander.surname} TAKES THE CHART`, "body"],
          [`${campaign.runsElapsed} RUNS. IT WAS NOT ENOUGH.`, "note"],
          ["COMMAND LOST", "flag"],
        ];
    this.start(layout(copy));
  }

  /**
   * The reset tail shared by `begin` and `beginEpilogue`: composed lines in,
   * a scroll ready to run out. Extracted rather than duplicated because the
   * two crawls differ only in what they say, never in how they move.
   */
  private start(lines: readonly CrawlLine[]): void {
    this.lines = lines;
    this.travel = 0;
    this.spoken = 0;
    this.elapsed = 0;
    this.holding = CRAWL.hold;
    const last = this.lines[this.lines.length - 1];
    this.span = CRAWL.top + CRAWL.fade - CRAWL.entry + (last?.offset ?? 0);
    this.active = this.lines.length > 0;

    // The opening stanza is already in the band, so its blips are already
    // owed. Firing them would be four service cues inside one frame; counting
    // them as printed and marking the moment with a single blip is the same
    // gesture at the volume it deserves. Everything below still prints as it
    // rises.
    while (this.spoken < this.lines.length && this.yOf(this.lines[this.spoken]) > CRAWL.bottom) {
      this.spoken++;
    }
    if (this.active) sound.service(0);
  }

  /** Any key, at any point, and the run starts on the next frame. */
  skip(): void {
    this.active = false;
    this.travel = 0;
    this.elapsed = 0;
    this.lines = [];
  }

  /** @param realDt wall-clock seconds. Nothing here is ever frame-counted. */
  update(realDt: number): void {
    if (!this.active) return;
    this.elapsed += realDt;

    // The opening hold. Spent before any travel is, so the log is a document
    // that starts moving rather than one caught mid-scroll — and the remainder
    // of a frame that ends the hold still moves the crawl, which is what keeps
    // this time-based rather than a frame that vanishes.
    if (this.holding > 0) {
      const spent = Math.min(this.holding, realDt);
      this.holding -= spent;
      realDt -= spent;
    }
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
    return CRAWL.entry + this.travel - line.offset;
  }

  /**
   * The lines a player could actually read this instant.
   *
   * Exists for the harness, and deliberately so: `active` was the only thing a
   * test could see, and `active === true` is exactly what an empty screen with
   * the whole log still below the band reports. A pacing assertion has to be
   * able to ask for words.
   */
  readable(): string[] {
    return this.lines
      .filter((line) => line.text && this.levelAt(this.yOf(line)) >= LEGIBLE)
      .map((line) => line.text);
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
