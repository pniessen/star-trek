import { Color, MathUtils, Vector3, type PerspectiveCamera } from "three";
import { TORPEDO } from "../game/weapons.js";
import { PALETTE } from "../render/palette.js";
import type { Hud } from "./Hud.js";
import { FACINGS, type Ship } from "../game/Ship.js";
import { ALTITUDE, flight } from "../game/altitude.js";
import type { Session } from "../game/session.js";
import { HOSTILE_COLORS, HOSTILE_NAMES, type Fleet, type Hostile } from "../game/hostiles.js";
import type { Presentation } from "../game/presentation.js";
import { SCANNER, ScannerModel } from "./scanner.js";
import { drawBriefing } from "./briefing.js";
import { GLYPH_ADVANCE } from "./strokeFont.js";
import { CONTROL_COLOR, drawChart, drawCommand, sectorFacts, sectorFlags } from "../chart/ChartView.js";
import { HYPERWARP } from "../game/hyperwarp.js";
import { jumpCharge, jumpEnergy, jumpSteps } from "../chart/jump.js";
import { regionName, sectorCode } from "../chart/naming.js";
import { canDock, type Campaign } from "../chart/campaign.js";
import { DEFAULT_ERA, eraSpec, traitsOf } from "../chart/eras.js";

export interface HudView {
  readonly player: Ship;
  readonly session: Session;
  readonly fleet: Fleet;
  readonly presentation: Presentation;
  readonly starbase: Vector3;
  readonly fps: number;
  readonly time: number;
  /** Seconds since the last frame. The scanner accumulates, so it needs this. */
  readonly dt: number;
  readonly cameraMode: string;
  /** Needed to put a mark in the forward view rather than on the scanner. */
  readonly camera: PerspectiveCamera;
  readonly shapeMode: string;
  readonly bloom: boolean;
  readonly phosphor: boolean;
  readonly crt: boolean;
  readonly muted: boolean;
  readonly showDiagnostics: boolean;
  readonly campaign: Campaign;
  /** 0→1, eased in `main.ts` while `Tab` is held. */
  readonly chartOpacity: number;
  /** The sector the chart cursor is pointing at, independent of `campaign.current`. */
  readonly chartCursor: number;
  /** Index into `DECISIONS` — which of the four the command view has highlighted. */
  readonly commandSelection: number;
  /** The command view's answer to the last decision taken, refusal included. */
  readonly commandMessage: string;
}

const dim = PALETTE.trace.clone().multiplyScalar(0.5);
const scratch = new Color();
const point = new Vector3();

/** What the scanner has been told, as opposed to what is true. See `scanner.ts`. */
const contacts = new ScannerModel();

/** Centred on `cx`. Used by every full-screen panel. */
function centred(hud: Hud, text: string, cx: number, y: number, scale: number, color: Color): void {
  hud.text(text, cx - (text.length * GLYPH_ADVANCE * scale) / 2, y, scale, color);
}

/** A dashed rule — the panel divider, in the same vocabulary as the corridor. */
function rule(hud: Hud, cx: number, y: number, halfWidth: number, color: Color): void {
  const flat: number[] = [];
  for (let x = -halfWidth; x < halfWidth; x += 22) {
    flat.push(cx + x, y, cx + Math.min(x + 13, halfWidth), y);
  }
  hud.segments(flat, color);
}

/** Slow enough to read as a cursor rather than a fault. Time-based, not frame-based. */
function blink(time: number): boolean {
  return Math.sin(time * 3.4) > -0.35;
}

function arc(
  out: number[],
  cx: number,
  cy: number,
  radius: number,
  from: number,
  to: number,
  steps: number,
): void {
  for (let i = 0; i < steps; i++) {
    const a0 = MathUtils.lerp(from, to, i / steps);
    const a1 = MathUtils.lerp(from, to, (i + 1) / steps);
    out.push(
      cx + Math.cos(a0) * radius,
      cy + Math.sin(a0) * radius,
      cx + Math.cos(a1) * radius,
      cy + Math.sin(a1) * radius,
    );
  }
}

function pad(value: number, width: number): string {
  return Math.max(0, Math.round(value)).toString().padStart(width, "0");
}

export function drawHud(hud: Hud, view: HudView): void {
  const { width, height } = hud.size;
  const { player, session, presentation } = view;
  const death = session.death;

  hud.begin();
  // The instrument supply. Everything below is scaled by it, so when the ship
  // loses power the panel browns out whole rather than each readout blinking
  // out on its own schedule.
  hud.power = death.power;

  if (presentation.mode === "title") {
    drawTitle(hud, view, width, height);
    hud.end();
    return;
  }

  // Between runs the panel is the chart and nothing else — no scanner, no
  // shields, no reticle, because there is nothing to fly. The same early
  // return the title takes, for the same reason.
  if (presentation.mode === "command") {
    drawCommand(hud, view.campaign, {
      cursor: view.chartCursor,
      selection: view.commandSelection,
      message: view.commandMessage,
      report: presentation.report,
      time: view.time,
    });
    hud.end();
    return;
  }

  // The opening log takes the whole frame, the same way the title and the
  // command view do, and for the same reason: there is nothing live to report
  // under it. It runs inside mode "run" rather than as a mode of its own — see
  // `game/briefing.ts` — so it is checked here rather than in the switch above.
  if (presentation.briefing.active) {
    drawBriefing(hud, presentation.briefing, width, height);
    hud.end();
    return;
  }

  hud.brackets(18, 18, width - 36, height - 36, 22, PALETTE.traceDim);

  // Once the run is over the panel has nothing live to report, so it stops
  // pretending: the instruments give the screen up to the epitaph.
  if (death.phase === "tally") {
    drawEpitaph(hud, view, width, height);
    if (view.showDiagnostics) drawDiagnostics(hud, view, width, height);
    hud.end();
    return;
  }

  drawScanner(hud, view, width / 2, height - 148);
  drawShields(hud, player, width / 2, 96, view);
  // Only when there is a slab to be in. With the switch off the panel is the
  // panel this game has always had, down to the last stroke.
  if (flight.threeD) drawAltitude(hud, player, width / 2 + 58, 96);
  drawCondition(hud, view, width);
  drawStatus(hud, view);
  drawTally(hud, view, width);

  if (view.cameraMode === "cockpit" && session.state !== "dead") {
    drawReticle(hud, width / 2, height / 2, player.impact);
  }

  // In every view, not just the cockpit: the torpedo is aimed by the hull's
  // nose whichever camera is watching it, so the mark belongs on screen
  // wherever the shot is legal.
  if (session.state !== "dead" && presentation.mode === "run") {
    drawLeadPip(hud, view, width, height);
  }

  if (session.state !== "dead") {
    drawEscortTag(hud, view, width, height);
  }

  if (session.hyperwarp.charging) {
    drawHyperwarp(hud, view, width / 2, 420);
  }

  // Where you have just arrived, before the wave that greets you announces
  // itself. Sits below the message line rather than on it, so both can be up.
  if (session.arrivalCard > 0) {
    drawArrivalCard(hud, view, width / 2, height / 2 - 30);
  }

  if (session.docking.phase !== "none") {
    // The band between the ship and the scanner is the only reliably clear
    // strip: the shield cluster owns the bottom, the ship sits in the lower
    // third in chase view, and the scanner owns the top.
    drawDockingPanel(hud, view, width / 2, 420);
  }

  if (session.messageTimer > 0) {
    const alpha = Math.min(1, session.messageTimer / 0.6);
    scratch
      .copy(session.state === "dead" ? PALETTE.amber : PALETTE.trace)
      .multiplyScalar(0.35 + alpha * 0.9);
    const scale = session.state === "dead" ? 5.5 : 3.6;
    centred(hud, session.message, width / 2, height / 2 + 96, scale, scratch);
  }

  if (presentation.mode === "attract") drawAttractBanner(hud, view, width);

  if (view.showDiagnostics) drawDiagnostics(hud, view, width, height);

  // Drawn last so it sits on top of every other instrument. Never reached from
  // the title or tally early-returns above, which is what keeps it off the
  // title screen without a special case here.
  drawChart(hud, view.campaign, {
    opacity: view.chartOpacity,
    cursor: view.chartCursor,
    time: view.time,
    // What a jump has to be paid out of, and the rate it is paid at. Passed
    // rather than imported by the chart: `src/chart/` may not depend on
    // `src/game/`, and this is the only combat constant it needs.
    reserve: player.energy,
    drainPerSecond: HYPERWARP.drainPerSecond,
  });

  hud.end();
}

/**
 * Arriving somewhere, announced as arriving somewhere.
 *
 * A jump used to say "HYPERWARP" and drop you into an identical-looking patch
 * of the same plane, which is most of why every square on the chart read as
 * "not here". The sector has a name, a region, a threat that sets the waves
 * about to spawn, a yield that scales what they pay, and either somewhere to
 * bank or nowhere — and all five of those were already true and none of them
 * were ever said out loud.
 *
 * It does not pause the game, for the same reason the chart does not: the
 * price of reading an instrument is the time it takes while something is
 * shooting at you. So it is short, it fades rather than cutting, and it is
 * composed in the clear band the docking panel uses — neither of which can be
 * up at the same time, since a jump is refused while docking.
 */
function drawArrivalCard(hud: Hud, view: HudView, cx: number, cy: number): void {
  const { campaign, session } = view;
  const here = campaign.current;
  const sector = campaign.sectors[here];
  // The last three-quarters of a second is a fade rather than a cut. A card
  // that vanishes between two frames reads as a glitch.
  const level = Math.min(1, session.arrivalCard / 0.75);

  const line = (text: string, y: number, scale: number, color: Color): void => {
    scratch.copy(color).multiplyScalar(level);
    centred(hud, text, cx, y, scale, scratch);
  };

  line(`SECTOR ${sectorCode(here)}`, cy + 66, 4.2, CONTROL_COLOR[sector.control]);
  scratch.copy(PALETTE.traceDim).multiplyScalar(level);
  rule(hud, cx, cy + 46, 150, scratch);

  line(regionName(campaign.seed, here), cy + 20, 2.4, PALETTE.trace);
  line(sectorFacts(campaign, here), cy - 8, 1.8, canDock(sector) ? PALETTE.trace : PALETTE.amber);

  const flags = sectorFlags(campaign, here);
  if (flags) line(flags, cy - 32, 1.8, PALETTE.amber);
}

/**
 * The title screen, as one of the ship's own instruments.
 *
 * A menu would be the wrong object entirely — this game has no DOM text in it
 * anywhere, and the moment the first screen a player sees is HTML the whole
 * conceit that everything readable is something the ship is drawing collapses
 * before the first frame of it. So the title is a panel: brackets, a rule, dim
 * labels against bright values, and the same stroke font as every other
 * readout. The spectacle behind it is the game's, not the screen's.
 */
function drawTitle(hud: Hud, view: HudView, width: number, height: number): void {
  const cx = width / 2;
  const { presentation } = view;

  hud.brackets(18, 18, width - 36, height - 36, 22, PALETTE.traceDim);

  /**
   * Composed around the hull, not above it.
   *
   * Test play: the ship and its figures "get lost on the page". Two causes, and
   * the layout could only fix one — the camera sat 21 units out, which makes a
   * thumbnail of anything, and that is fixed in `placeTitleCamera`. The other was
   * here: the game's own name held the largest type on the screen whose job is
   * choosing what you fly. So the title shrinks and moves up, and **the hull's
   * name is now the biggest thing on the page**. The game is called Kobayashi on
   * every other frame; this screen has one subject and it is the ship.
   *
   * Everything that is not the hull is pushed to the margins — identity above,
   * bindings below — leaving the whole middle band to the object the camera is
   * orbiting.
   */
  centred(hud, "KOBAYASHI", cx, 762, 5.2, PALETTE.traceDim);
  centred(hud, "NO-WIN SCENARIO   VECTOR COMBAT TRIALS", cx, 740, 1.6, PALETTE.traceDim);
  rule(hud, cx, 722, 250, PALETTE.traceDim);

  const era = view.campaign.era ?? DEFAULT_ERA;
  const hull = eraSpec(era);
  centred(hud, hull.label, cx, 682, 4.0, PALETTE.trace);
  centred(hud, `COMMISSIONED ${hull.era}     N  TO CHANGE SHIP`, cx, 654, 1.5, PALETTE.traceDim);

  /**
   * The spec sheet: eight figures, always the same eight, always as a percentage
   * of the Constitution.
   *
   * Two columns of four rather than a list, for room — but the ordering is the
   * point. Every hull puts the same figure in the same cell, so cycling ships
   * changes numbers in place and a hull becomes legible as a *pattern* of
   * departures rather than a paragraph. Figures at 100 are drawn dim rather than
   * omitted: a blank would move every row below it and destroy the comparison,
   * and "at reference" is itself worth knowing.
   *
   * Colour carries the polarity, which is why it cannot be inferred from the
   * sign. Three of these are costs when they rise — damage taken, beam draw,
   * target profile — so 82% is good news in one row and bad news in another.
   * `traitsOf` decides; this only paints what it is told.
   */
  const traits = traitsOf(era);
  const halfSpec = Math.ceil(traits.length / 2);
  traits.forEach((trait, index) => {
    const x = cx + (index < halfSpec ? -34 : 176);
    const y = 626 - (index % halfSpec) * 20;
    hud.textRight(trait.label, x, y, 1.5, PALETTE.traceDim);
    hud.text(
      `${trait.percent}%`,
      x + 8,
      y,
      1.5,
      trait.percent === 100 ? PALETTE.traceDim : trait.favourable ? dim : PALETTE.amber,
    );
  });

  /**
   * Every binding, on the screen, in two columns.
   *
   * The old legend listed seven of eighteen and left the rest to be discovered or
   * not. An arcade cabinet can do that because it has a bezel with the controls
   * printed on it. This has no bezel, so the panel is the bezel.
   *
   * Split by kind rather than by keyboard order, and the split is the useful one:
   * the left column is everything that changes what happens in the sector, the
   * right is everything that only changes what you can see. Someone looking for
   * "how do I fire" and someone looking for "how do I turn the glass off" are
   * asking different questions and neither should have to read the other's list.
   */
  const flightKeys: [string, string][] = [
    ["FLY", "ARROWS / WASD"],
    ["CLIMB / DIVE", "Q / E"],
    ["PHASERS", "SPACE"],
    ["TORPEDOES", "X"],
    ["SHIELD", "Z"],
    ["WARHEAD", "C"],
    ["CHART", "HOLD TAB"],
    ["JUMP", "HOLD SHIFT"],
  ];
  const displayKeys: [string, string][] = [
    ["SHIP", "N"],
    ["RESTART", "R"],
    ["DECK LOG", "L"],
    ["SLAB", "Y"],
    ["WIREFRAME", "G"],
    ["GLOW", "B  F  V"],
    ["CAMERA", "1  2  3"],
    ["MUTE / INFO", "M / H"],
  ];
  const keyColumn = (rows: [string, string][], anchor: number): void => {
    rows.forEach(([label, value], index) => {
      const y = 214 - index * 20;
      // A wide gutter, not a space. At eight units the label and its key ran
      // together into one string and the two columns stopped being columns.
      hud.textRight(label, anchor, y, 1.45, PALETTE.traceDim);
      hud.text(value, anchor + 18, y, 1.45, dim);
    });
  };
  keyColumn(flightKeys, cx - 150);
  keyColumn(displayKeys, cx + 132);

  if (blink(view.time)) {
    centred(hud, "PRESS ANY KEY TO LAUNCH", cx, 38, 2.4, PALETTE.amber);
  }

  if (presentation.best > 0) {
    centred(hud, `BEST THIS SITTING   ${pad(presentation.best, 6)}`, cx, 12, 1.4, PALETTE.traceDim);
  }
}

/**
 * Says the obvious thing: nobody is flying this, and you could be.
 *
 * Bottom centre, in the strip between the shield cluster and the frame — the
 * one band the instruments leave clear at every window size. Anywhere nearer
 * the middle and it sits squarely on the ship it exists to show off.
 */
function drawAttractBanner(hud: Hud, view: HudView, width: number): void {
  if (!blink(view.time)) return;
  centred(hud, "DEMONSTRATION   PRESS ANY KEY TO PLAY", width / 2, 32, 2.2, PALETTE.amber);
}

/**
 * The run, added up.
 *
 * Deliberately itemised the same way the docking tally is, and for the same
 * reason: the multiplier is the currency, so the number that has to land
 * hardest is what the run was worth one dock short of home. "SALVAGE LOST" is
 * the whole greed loop stated as a single figure.
 */
function drawEpitaph(hud: Hud, view: HudView, width: number, height: number): void {
  const cx = width / 2;
  const run = view.session.lastRun;

  centred(hud, "SHIP LOST", cx, height / 2 + 96, 5.5, PALETTE.amber);
  rule(hud, cx, height / 2 + 74, 190, PALETTE.traceDim);

  const rows: [string, string, Color][] = [
    ["WAVE REACHED", pad(run.wave, 2), PALETTE.trace],
    ["HOSTILES DESTROYED", pad(run.kills, 3), PALETTE.trace],
    ["SALVAGE LOST", pad(run.lost, 5), PALETTE.amber],
    ["FINAL SCORE", pad(run.score, 6), PALETTE.trace],
  ];
  rows.forEach(([label, value, color], index) => {
    const y = height / 2 + 24 - index * 30;
    hud.textRight(label, cx - 20, y, 1.8, PALETTE.traceDim);
    hud.text(value, cx + 20, y, 2.4, color);
  });

  if (blink(view.time)) {
    centred(hud, "PRESS R TO RUN AGAIN", cx, height / 2 - 132, 2.2, dim);
  }
}

/**
 * The overhead scanner.
 *
 * This is half the interface, and it used to be the reason the play space was a
 * plane. It is not any more, and it did not have to be: **height is a stalk.**
 * Every mark that can leave the floor is lifted off it and a line is drawn back
 * down to where the contact really is, which is Elite's answer from 1984 and is
 * in this project's own `prior-art.md`. Read the base for position and the
 * length for height. The tube is exactly as trustworthy as it was — nothing is
 * misplaced, one thing is now also *measured* — and the skill is unchanged:
 * read this, turn the right shield toward the right threat, and let the forward
 * view do the shooting. That split is the 1982 cabinet's answer and it has not
 * been improved on.
 *
 * Heading-up rather than north-up: in first person you steer relative to your
 * own nose, and a rotating map is one less translation to do under pressure.
 *
 * The tube shows four things, in descending order of certainty: resolved
 * hostiles, which are exactly where they are drawn and only dim between sweeps;
 * mines, which never move, never leave the deck, and so are never in doubt;
 * unresolved returns, which are drawn as the circle of error they actually
 * carry and deliberately carry no height at all; and the starbase.
 */
function drawScanner(hud: Hud, view: HudView, cx: number, cy: number): void {
  const { player, fleet, starbase, session } = view;
  const radius = 104;
  const scale = radius / SCANNER.range;

  // Wave zero only happens on a fresh run, so this is where stale returns from
  // the last one get wiped rather than lingering into the new sector.
  if (session.wave === 0) contacts.reset();
  contacts.update(view.dt, player, fleet);

  const rings: number[] = [];
  arc(rings, cx, cy, radius, 0, Math.PI * 2, 44);
  hud.segments(rings, PALETTE.traceDim);

  const inner: number[] = [];
  arc(inner, cx, cy, radius * 0.62, 0, Math.PI * 2, 32);
  arc(inner, cx, cy, radius * 0.28, 0, Math.PI * 2, 20);
  scratch.copy(PALETTE.traceDim).multiplyScalar(0.5);
  hud.segments(inner, scratch);

  // Bearing ticks every 45°, longer at the cardinals.
  const ticks: number[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + Math.PI / 2;
    const length = i % 2 === 0 ? 9 : 5;
    ticks.push(
      cx + Math.cos(angle) * radius,
      cy + Math.sin(angle) * radius,
      cx + Math.cos(angle) * (radius + length),
      cy + Math.sin(angle) * (radius + length),
    );
  }
  hud.segments(ticks, PALETTE.traceDim);

  // The sweep, with a short decaying trail behind it. The trail is not
  // decoration: it is how you judge when the arm is next due back over a
  // bearing, which is the timing the unresolved returns are read against.
  for (let i = 0; i < 6; i++) {
    const angle = contacts.arm + i * 0.11;
    scratch.copy(PALETTE.traceDim).multiplyScalar((1 - i / 6) * 0.9);
    hud.segments(
      [cx, cy, cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius],
      scratch,
    );
  }

  const cos = Math.cos(player.heading);
  const sin = Math.sin(player.heading);

  const project = (world: Vector3): { x: number; y: number; lift: number; clamped: boolean } => {
    const dx = world.x - player.position.x;
    const dz = world.z - player.position.z;
    const forward = dx * sin + dz * cos;
    const right = dx * cos - dz * sin;
    let px = right * scale;
    let py = forward * scale;
    const length = Math.hypot(px, py);
    const clamped = length > radius;
    if (clamped && length > 0) {
      // Off-scanner contacts pin to the rim. Knowing something exists and
      // roughly where beats it silently not being drawn.
      px = (px / length) * radius;
      py = (py / length) * radius;
    }
    // Height off the *plane*, not off the player, and now signed — the ship can
    // be under the plane as well as over it. This paragraph used to argue that
    // one-way stalks were worth more than symmetry, and cited Elite for the
    // stalk. Elite in fact put its plane in the middle of the tube and drew
    // stalks both ways, which is the version that shipped in 1984 and read fine:
    // direction is one more bit and the eye takes it for free. Still measured off
    // the plane rather than off the player, which is the part that actually
    // matters — a player-relative stalk moves every mark whenever *you* climb.
    // Own ship gets one too, at the centre, so "am I above that Raider" is a
    // comparison of two lengths sitting next to each other.
    //
    // Off-tube contacts get none: a rim mark is already an approximation and
    // hanging a measurement off it claims a precision the mark does not have.
    const lift = clamped ? 0 : world.y * SCANNER.altitudeScale;
    return { x: cx + px, y: cy + py, lift, clamped };
  };

  /**
   * Elite's stalk: the mark is drawn `lift` pixels off its true position and a
   * line joins the two. Below half a pixel nothing is drawn at all, so a fleet
   * on the deck — or the whole game with the slab switched off — leaves the tube
   * looking precisely the way it always did.
   */
  const stalk = (mark: { x: number; y: number; lift: number }, color: Color): void => {
    if (mark.lift < 0.5) return;
    scratch.copy(color).multiplyScalar(0.55);
    hud.segments(
      [
        mark.x, mark.y, mark.x, mark.y + mark.lift,
        // A foot on the deck. Two pixels of cross-tick is what stops the base
        // reading as the end of a line rather than as the contact's position.
        mark.x - 2, mark.y, mark.x + 2, mark.y,
      ],
      scratch,
    );
  };

  /**
   * Starbase: the thing you are gambling against reaching, and the one contact
   * that must never be hard to find.
   *
   * It used to lose its cross the moment it clamped to the rim, and it was drawn
   * in the dimmest colour on the tube unless you were already moored. So at
   * exactly the moment a player needs it — out past scanner range with a fat
   * multiplier and nowhere to bank it — it became a small dim ring among the
   * other small dim rings, indistinguishable from an unresolved return. That is
   * backwards: an unresolved contact is *supposed* to be ambiguous, and the bank
   * is supposed to be the one certainty on the board.
   *
   * Three changes, none of them a new system.
   *
   *  - **The cross survives the clamp.** It is the station's glyph and it is what
   *    separates it from a return that has not resolved. Smaller on the rim, but
   *    there.
   *  - **A course line.** A dim radial from the centre out to the mark, so the
   *    bearing is readable without measuring an angle by eye. It is drawn under
   *    everything else and dimmer than the sweep, so it reads as a rule on the
   *    instrument rather than as traffic.
   *  - **It brightens with distance.** Nearly invisible when the station is
   *    comfortably inside the tube and clearest when it is pinned to the rim,
   *    which is the inverse of how everything else on this display works and is
   *    the entire point: the guide appears when it is needed and gets out of the
   *    way when it is not.
   *
   * Deliberately not a refit. Knowing where your own bank is is legibility, not
   * a power, and charging salvage for it would be a tax on the greed loop the
   * whole game is built around.
   */
  const base = project(starbase);
  const baseRange = Math.hypot(starbase.x - player.position.x, starbase.z - player.position.z);
  // 0 while the station is well inside the tube, 1 once it is off the edge.
  const lost = MathUtils.clamp(baseRange / SCANNER.range, 0, 1) ** 1.6;

  if (lost > 0.02) {
    const dx = base.x - cx;
    const dy = base.y - cy;
    const length = Math.hypot(dx, dy) || 1;
    // Stops short of the mark so the line never appears to pass through it.
    const to = Math.max(0, length - 11) / length;
    scratch.copy(PALETTE.traceDim).multiplyScalar(0.22 + 0.5 * lost);
    hud.segments([cx + dx * 0.3, cy + dy * 0.3, cx + dx * to, cy + dy * to], scratch);
  }

  const baseMark: number[] = [];
  const baseSize = base.clamped ? 4.5 : 6;
  arc(baseMark, base.x, base.y, baseSize, 0, Math.PI * 2, 8);
  // The cross, at both scales. Shorter arms on the rim so the mark stays compact
  // where the tube is already crowded, but never absent.
  const arm = base.clamped ? 7 : 9;
  baseMark.push(
    base.x - arm, base.y, base.x + arm, base.y,
    base.x, base.y - arm, base.x, base.y + arm,
  );
  scratch.copy(PALETTE.trace).multiplyScalar(session.docked ? 1 : 0.42 + 0.5 * lost);
  hud.segments(baseMark, scratch);

  // Mines: small violet diamonds, the same glyph as the Harrow that laid them
  // at a third the size. They never move, so there is nothing to be uncertain
  // about — and knowing where the field is is most of surviving it.
  for (const mine of session.mines.mines) {
    const mark = project(mine.position);
    if (mark.clamped) continue;
    scratch.copy(PALETTE.harrow).multiplyScalar(mine.armed ? 0.95 : 0.4);
    hud.segments(diamond(mark.x, mark.y, 2.2), scratch);
  }

  // The Loom, drawn here — after the mines and under every live contact —
  // because the wall is *board*, not traffic. A hostile crossing it has to be on
  // top of it, the same way the Warden is drawn on top of the hostile it is
  // closing on.
  //
  // The wall is a dotted violet circle: one tick per filament, on the deck, with
  // no stalk at all. A hundred and twenty-six stalks would be a hedge rather
  // than an instrument, and a wall's height is not a per-contact fact anyway —
  // it is one number for the whole ring. That number goes in the annunciator
  // below the tube instead, and it goes there as the *decision* rather than as
  // the measurement: see `drawLoomState`.
  const loom = session.loom;
  if (loom.active) {
    const fence: number[] = [];
    for (const strand of loom.strands) {
      const mark = project(
        point.set(
          loom.centre.x + Math.sin(strand.bearing) * loom.radius,
          0,
          loom.centre.z + Math.cos(strand.bearing) * loom.radius,
        ),
      );
      if (mark.clamped) continue;
      // A radial tick rather than a dot: it lies across the wall's own
      // thickness, so the ring reads as a fence seen from above rather than as
      // a dashed orbit, which is what a ring of dots reads as.
      const dx = mark.x - cx;
      const dy = mark.y - cy;
      const length = Math.max(1e-3, Math.hypot(dx, dy));
      const nx = (dx / length) * 2.2;
      const ny = (dy / length) * 2.2;
      fence.push(mark.x - nx, mark.y - ny, mark.x + nx, mark.y + ny);
    }
    scratch.copy(PALETTE.harrow).multiplyScalar(0.85);
    hud.segments(fence, scratch);

    // The spinners: an upright bar with a crossbar at its waist, which is the
    // hull's own silhouette at glyph size and the only *vertical* mark on the
    // tube. That is what tells it from the Harrow's diamond sitting in the same
    // violet — the two glyphs share a hue and share nothing else.
    //
    // They get a stalk like every other contact, and theirs is always exactly
    // the height of the wall, because a spinner rides the lip of the fence it is
    // drawing. So the one thing on the tube whose altitude the player genuinely
    // has to know is the one thing whose altitude the tube keeps measuring, and
    // it is measured against their own stalk at the centre.
    for (const spinner of loom.spinners) {
      const mark = project(spinner.position);
      stalk(mark, PALETTE.harrow);
      mark.y += mark.lift;
      const marks: number[] = [];
      if (mark.clamped) {
        marks.push(mark.x, mark.y - 3, mark.x, mark.y + 3);
      } else {
        marks.push(mark.x, mark.y - 6, mark.x, mark.y + 6);
        marks.push(mark.x - 4, mark.y, mark.x + 4, mark.y);
      }
      hud.segments(marks, PALETTE.harrow);
    }
  }

  // Resolved contacts. Glyph encodes class, so the scanner tells you what is
  // coming, not merely that something is. Brightness encodes how long ago the
  // arm last confirmed it — position is never in doubt, confidence is.
  for (const hostile of fleet.hostiles) {
    if (hostile.hidden) continue; // paints as an unresolved return instead
    const mark = project(hostile.position);
    const level =
      (mark.clamped ? 0.45 : 1) *
      (SCANNER.faintest + (1 - SCANNER.faintest) * contacts.freshness(hostile));
    // Under the glyph first, so a class colour never draws over its own stalk.
    stalk(mark, HOSTILE_COLORS[hostile.kind]);
    // Every glyph below is composed about the mark's own origin, so lifting it
    // is one addition here rather than a change to five shapes.
    mark.y += mark.lift;
    scratch.copy(HOSTILE_COLORS[hostile.kind]).multiplyScalar(level);
    const marks: number[] = [];

    if (mark.clamped) {
      marks.push(mark.x - 2, mark.y - 2, mark.x + 2, mark.y + 2);
    } else if (hostile.kind === "swarmer") {
      marks.push(mark.x - 2.5, mark.y, mark.x + 2.5, mark.y);
      marks.push(mark.x, mark.y - 2.5, mark.x, mark.y + 2.5);
    } else if (hostile.kind === "sniper") {
      marks.push(mark.x - 5, mark.y - 3, mark.x, mark.y + 4);
      marks.push(mark.x, mark.y + 4, mark.x + 5, mark.y - 3);
      marks.push(mark.x - 5, mark.y - 3, mark.x + 5, mark.y - 3);
    } else if (hostile.kind === "miner") {
      marks.push(...diamond(mark.x, mark.y, 5));
    } else if (hostile.kind === "stalker") {
      // A cross: the mark you were chasing as a ring, now finally pinned.
      marks.push(mark.x - 4, mark.y - 4, mark.x + 4, mark.y + 4);
      marks.push(mark.x - 4, mark.y + 4, mark.x + 4, mark.y - 4);
    } else {
      marks.push(mark.x - 4, mark.y - 4, mark.x + 4, mark.y - 4);
      marks.push(mark.x + 4, mark.y - 4, mark.x + 4, mark.y + 4);
      marks.push(mark.x + 4, mark.y + 4, mark.x - 4, mark.y + 4);
      marks.push(mark.x - 4, mark.y + 4, mark.x - 4, mark.y - 4);
    }
    hud.segments(marks, scratch);
  }

  // Unresolved returns: a broken ring the size of the error, decaying with age.
  // A solid ring would claim a boundary the scanner has not got; the gaps say
  // "about here". Read the sequence, not the mark — two rings closing on you
  // from the same quarter is a Shroud, and you have until the third to turn.
  for (const ghost of contacts.ghosts) {
    const mark = project(point.set(ghost.x, 0, ghost.z));
    if (mark.clamped) continue;
    const fade = Math.pow(1 - ghost.age / SCANNER.ghostLife, 1.4);
    scratch.copy(PALETTE.magenta).multiplyScalar(0.2 + fade * 1.1);

    const ring: number[] = [];
    const r = Math.max(3.5, ghost.spread * scale);
    for (let i = 0; i < 4; i++) {
      const from = (i / 4) * Math.PI * 2 + 0.3;
      arc(ring, mark.x, mark.y, r, from, from + Math.PI / 2 - 0.6, 3);
    }
    ring.push(mark.x - 1.6, mark.y, mark.x + 1.6, mark.y);
    ring.push(mark.x, mark.y - 1.6, mark.x, mark.y + 1.6);
    hud.segments(ring, scratch);
  }

  // The Warden.
  //
  // Cyan, because cyan is ours, and the only glyph on the tube that shows a
  // *heading* — an open chevron pointing where the ship is actually going,
  // turned into scanner space with everything else. Two things follow, and both
  // are the point: it cannot be read as a hostile, because every hostile glyph
  // is a closed symmetric outline with no front to it, and it cannot be read as
  // an unresolved return, because those are broken magenta rings around a
  // cross. The one glyph it resembles is the player's own arrowhead at the
  // centre, which is exactly the family resemblance wanted — and that one never
  // moves off the middle of the tube.
  //
  // Drawn after the hostiles and before own ship, so a Warden closing on a
  // contact is on top of it rather than under it.
  //
  // It gets a stalk like everything else and will essentially never show one:
  // the Warden flies the deck. That is not an oversight — a picket holding
  // station is the one hull in the sector with no reason to be anywhere but on
  // the plane, and a cyan chevron reliably at zero is a useful datum to read
  // every other stalk against.
  const escort = session.escort;
  if (escort) {
    const mark = project(escort.position);
    stalk(mark, PALETTE.trace);
    mark.y += mark.lift;
    // Heading-up, so what is drawn is its bearing relative to your nose.
    const relative = escort.heading - player.heading;
    const fx = Math.sin(relative);
    const fy = Math.cos(relative);
    const r = mark.clamped ? 4.5 : 6.5;
    // Nose, and two arms swept back from it: a chevron rather than a closed
    // arrowhead, so it stays legible at the rim where it is drawn smaller.
    const marks: number[] = [];
    for (const side of [-1, 1]) {
      marks.push(
        mark.x + fx * r,
        mark.y + fy * r,
        mark.x - fx * r * 0.6 - fy * side * r * 0.7,
        mark.y - fy * r * 0.6 + fx * side * r * 0.7,
      );
    }
    scratch.copy(PALETTE.trace).multiplyScalar(mark.clamped ? 0.5 : 1);
    hud.segments(marks, scratch);
  }

  // Own ship, fixed at the centre pointing up — and lifted off the centre by
  // its own stalk, in exactly the vocabulary every contact uses.
  //
  // This is half the answer to "how does the player read their own altitude".
  // It is the half that works in a fight, because it is in the instrument the
  // eyes are already on and because it is *comparative*: your stalk against the
  // Raider's stalk is the question you actually have. The tape by the shield
  // cluster is the other half, and it is the one that gives you a number.
  const own = { x: cx, y: cy, lift: player.position.y * SCANNER.altitudeScale };
  stalk(own, PALETTE.trace);
  const oy = cy + own.lift;
  hud.segments(
    [cx, oy + 8, cx - 5, oy - 6, cx - 5, oy - 6, cx, oy - 2.5, cx, oy - 2.5, cx + 5, oy - 6, cx + 5, oy - 6, cx, oy + 8],
    PALETTE.trace,
  );

  hud.text("SCANNER", cx - radius, cy + radius + 16, 1.5, PALETTE.traceDim);
  hud.textRight(`${pad(SCANNER.range, 3)} KM`, cx + radius, cy + radius + 16, 1.5, PALETTE.traceDim);

  /**
   * The bank's range, above the tube beside its own range figure, and only once
   * it is worth saying. (Above: this HUD's y grows upward, so `+ radius` is away
   * from the centre and up the screen. Pairing the station's distance with the
   * scanner's own reach is the useful adjacency anyway — one is how far you can
   * see, the other how far you have to go.)
   *
   * Held back while the station is close because a figure that is always there
   * stops being read, and this one exists for the case where the mark has clamped
   * to the rim and the line alone cannot tell you whether that is eighty units
   * away or four hundred. Named rather than labelled "BASE": the sector's station
   * has a name, `chart/naming.ts` went to some trouble to give it one, and the
   * docking sequence already uses it.
   */
  if (!session.docked && baseRange > SCANNER.range * 0.55) {
    scratch.copy(PALETTE.trace).multiplyScalar(0.3 + 0.45 * lost);
    hud.textRight(
      `${session.docking.stationName}  ${pad(Math.round(baseRange), 3)} KM`,
      cx + radius,
      cy + radius + 32,
      1.4,
      scratch,
    );
  }

  // An annunciator rather than a count: reporting how many cloaked hulls exist
  // would be telling you something the scanner cannot know. This only says that
  // something out there is returning and will not resolve.
  if (contacts.alert && Math.sin(view.time * 8) > -0.3) {
    const label = "UNRESOLVED";
    hud.text(label, cx - (label.length * 4.2 * 1.6) / 2, cy - radius - 22, 1.6, PALETTE.magenta);
  }

  drawLoomState(hud, view, cx, cy - radius - 22);
}

/**
 * One word for the whole encounter, under the tube.
 *
 * The player has exactly two questions while a Loom is up and neither of them is
 * a number. *Can I still get out over the top?* — which is the wall's height
 * against the ceiling, and is a yes or a no. *Has it shut?* — which is whether
 * the ring is closed and coming in. So this is three states and no digits: OPEN,
 * SEALED, CLOSING. A readout that said "LOOM 11.6/14" would be asking a player
 * under fire to do arithmetic in order to learn something the game already knows
 * the answer to.
 *
 * It shares the annunciator band with UNRESOLVED and can appear with it, which
 * is fine: they are one line apart and they are never the same colour.
 */
function drawLoomState(hud: Hud, view: HudView, cx: number, y: number): void {
  const loom = view.session.loom;
  if (loom.phase === "none" || loom.phase === "fading") return;

  // CLOSING is the state that has to be noticed, so it is the only one that
  // blinks — the same treatment the cursor and the unresolved return get, and
  // for the same reason. OPEN is a standing condition and a standing condition
  // that flashes is a condition nobody reads twice.
  const closing = loom.phase === "sealed";
  if (closing && Math.sin(view.time * 6) < -0.35) return;

  const label = closing ? "WEAVE CLOSING" : loom.sealed ? "WEAVE SEALED" : "WEAVE OPEN";
  scratch.copy(PALETTE.harrow).multiplyScalar(loom.sealed || closing ? 1 : 0.6);
  hud.text(label, cx - (label.length * 4.2 * 1.6) / 2, y - 20, 1.6, scratch);
}

/** The Harrow's glyph, and its mines at a third the size. */
function diamond(cx: number, cy: number, r: number): number[] {
  return [
    cx, cy + r, cx + r, cy,
    cx + r, cy, cx, cy - r,
    cx, cy - r, cx - r, cy,
    cx - r, cy, cx, cy + r,
  ];
}

function drawShields(hud: Hud, player: Ship, cx: number, cy: number, view?: HudView): void {
  const fed = view?.session.reinforcing ?? null;

  FACINGS.forEach((facing, index) => {
    const charge = player.shields[facing];
    const segments: number[] = [];
    const centre = Math.PI / 2 - index * (Math.PI / 2);
    arc(segments, cx, cy, 34, centre - Math.PI / 4 + 0.24, centre + Math.PI / 4 - 0.24, 6);
    scratch
      .copy(charge < 0.3 ? PALETTE.amber : PALETTE.trace)
      .multiplyScalar(0.2 + charge * 0.8);
    hud.segments(segments, scratch);

    // The quarter currently drinking the reserve gets a second arc outside the
    // first. Four fifths of your energy can go into one of these, and which
    // one should never be a guess.
    if (facing === fed) {
      const outer: number[] = [];
      arc(outer, cx, cy, 41, centre - Math.PI / 4 + 0.18, centre + Math.PI / 4 - 0.18, 7);
      hud.segments(outer, PALETTE.amber);
    }
  });

  hud.segments(
    [cx, cy + 9, cx - 6, cy - 7, cx - 6, cy - 7, cx, cy - 3, cx, cy - 3, cx + 6, cy - 7, cx + 6, cy - 7, cx, cy + 9],
    PALETTE.traceDim,
  );
  hud.textRight("SHIELDS", cx - 48, cy - 4, 1.5, PALETTE.traceDim);
}

/**
 * The altitude tape — a ladder with the whole slab on it and a bar where you
 * are.
 *
 * Vertical, and that is the entire argument for its shape: this is the one
 * quantity in the game whose direction on screen can be the direction it means,
 * and a horizontal gauge for height would be a small act of vandalism next to
 * three of them that are honestly horizontal.
 *
 * It sits beside the shield cluster, mirroring the `SHIELDS` label across the
 * ship glyph, because that is the one place at the bottom of the frame that is
 * clear at every window size and because altitude belongs next to the shields —
 * both are things the reserve is being spent on and both are read in the same
 * glance. The scanner's own stalk is the version that works without looking; a
 * number is what this adds.
 *
 * No new colour. The rail is dim trace, the bar is trace, and it goes amber on
 * exactly one condition — a reserve too thin to hold you up — which is the
 * same rule and the same hue the energy gauge already uses, and which means the
 * ship is about to sink whether or not the key is still held.
 */
function drawAltitude(hud: Hud, player: Ship, x: number, cy: number): void {
  const half = 34;
  // Signed, and mapped so the rail's midpoint is the plane rather than half the
  // climb. -1 is the underside of the slab, +1 the lid, 0 the deck everything
  // else lives on.
  const signed = Math.max(-1, Math.min(1, player.position.y / ALTITUDE.ceiling));
  const fraction = (signed + 1) / 2;
  const falling = player.starved;
  const rail: number[] = [x, cy - half, x, cy + half];
  // Underside, plane and lid. The middle tick stopped being decoration when the
  // slab went signed: it is the plane now, the one height the starbase, the
  // mines and the corridor all sit at, so it is the tick a player actually aims
  // for rather than a guide against guessing.
  for (const [t, len] of [[0, 7], [0.5, 4], [1, 7]] as const) {
    const y = cy - half + t * half * 2;
    rail.push(x, y, x + len, y);
  }
  hud.segments(rail, PALETTE.traceDim);

  const y = cy - half + fraction * half * 2;
  scratch.copy(falling ? PALETTE.amber : PALETTE.trace);
  // A bar with a tail back down to the deck: the same stalk the scanner draws,
  // in the same grammar, so the two instruments are obviously one idea.
  hud.segments([x - 9, y, x + 9, y, x - 4, cy - half, x - 4, y], scratch);

  hud.text("ALT", x - 12, cy - half - 16, 1.5, PALETTE.traceDim);
  // The number only once there is one worth reading. On the deck the tape is
  // already saying zero by sitting on its own floor tick.
  if (player.position.y > 0.05) {
    hud.text(pad(player.position.y, 2), x + 13, y - 4, 1.6, scratch);
  }
}

function drawStatus(hud: Hud, view: HudView): void {
  const { player } = view;

  // A dry reserve is not a dead ship any more, so the gauge says which drive
  // you are on rather than leaving the player to work out why they are slow.
  if (player.starved) {
    hud.text("ENERGY", 34, 128, 1.5, PALETTE.traceDim);
    hud.text("IMPULSE", 96, 128, 1.5, PALETTE.amber);
  } else {
    hud.text("ENERGY", 34, 128, 1.5, PALETTE.traceDim);
  }
  hud.gauge(34, 100, 200, 16, player.energy, player.energy < 0.25 ? PALETTE.amber : PALETTE.trace, 5);
  hud.text(`${pad(player.energy * 100, 3)}%`, 244, 104, 1.8, PALETTE.trace);

  hud.text("HULL", 34, 76, 1.5, PALETTE.traceDim);
  hud.gauge(34, 48, 200, 16, player.hull, player.hull < 0.4 ? PALETTE.amber : PALETTE.trace, 4);
  hud.text(`${pad(player.hull * 100, 3)}%`, 244, 52, 1.8, player.hull < 0.4 ? PALETTE.amber : PALETTE.trace);

  // Torpedoes as discrete pips: a count you can read without reading.
  hud.text("TORPEDOES", 34, 26, 1.5, PALETTE.traceDim);
  const pips: number[] = [];
  // Drawn against the loadout's capacity, not the stock twelve — torpedo racks
  // that added rounds the tube could not show would be an upgrade you had to
  // take on faith.
  for (let i = 0; i < player.torpedoCapacity; i++) {
    const x = 118 + i * 9;
    if (i < player.torpedoes) pips.push(x, 20, x, 32);
    else pips.push(x, 24, x, 28);
  }
  hud.segments(pips, player.torpedoes > 0 ? PALETTE.trace : PALETTE.amber);
}

function drawTally(hud: Hud, view: HudView, width: number): void {
  const { session } = view;
  const right = width - 34;

  hud.textRight("SCORE", right, 128, 1.5, PALETTE.traceDim);
  hud.textRight(pad(session.displayScore, 6), right, 100, 3.2, PALETTE.trace);

  // The greed loop, made legible: what is on the table, and what it is worth
  // if you can get it home.
  hud.textRight("ON THE TABLE", right, 74, 1.5, PALETTE.traceDim);
  scratch.copy(session.pending > 0 ? PALETTE.amber : PALETTE.traceDim);
  hud.textRight(pad(session.bankable, 5), right, 50, 2.4, scratch);

  const multiplier = `${session.multiplier.toFixed(1)}X`;
  scratch.copy(session.multiplier > 1.05 ? PALETTE.magenta : PALETTE.traceDim);
  hud.textRight(multiplier, right, 24, 2.2, scratch);
  hud.textRight("MULTIPLIER", right - 60, 26, 1.5, PALETTE.traceDim);

  hud.textRight(`WAVE ${pad(session.wave, 2)}`, right, 156, 1.8, PALETTE.trace);
}

function drawReticle(hud: Hud, cx: number, cy: number, impact: number): void {
  const gap = 26 + impact * 10;
  const arm = 14;
  scratch.copy(impact > 0.05 ? PALETTE.amber : PALETTE.amber).multiplyScalar(0.7 + impact * 0.8);
  hud.segments(
    [
      cx - gap, cy, cx - gap - arm, cy,
      cx + gap, cy, cx + gap + arm, cy,
      cx, cy - gap, cx, cy - gap - arm,
      cx, cy + gap, cx, cy + gap + arm,
    ],
    scratch,
  );
}

/**
 * The approach instrument: a lateral needle, a speed bar, and a status line.
 *
 * Flying the corridor blind was the problem — you could satisfy the conditions
 * without ever knowing what they were. This shows the two things being asked of
 * you and turns green when each is satisfied, so lining up is a thing you do
 * rather than a thing that happens.
 */
/**
 * The charge, while it is charging.
 *
 * This instrument did not exist until a player reported the jump was broken.
 * It was not: holding the key drained energy and locked the guns for two full
 * seconds and said nothing, so the only reasonable reading was that nothing
 * had happened. A commitment the player cannot see is indistinguishable from
 * a dead key.
 *
 * It sits in the same clear band the docking panel uses, and cannot collide
 * with it — `beginHyperwarp` refuses while docking.
 */
/**
 * Green, yellow, red — reusing the palette rather than inventing a third
 * alert colour. `bastion` is the heavy's red-orange, and a red condition
 * sharing a hue with the class that punishes a neglected shield facing is a
 * coincidence worth keeping rather than an accident worth fixing.
 */
const CONDITION_COLOR = {
  green: PALETTE.traceDim,
  yellow: PALETTE.amber,
  red: PALETTE.bastion,
} as const;

/**
 * The condition, top-left, where nothing else lives.
 *
 * At red it breathes rather than sits still — a static word is furniture, and
 * this one has to be legible from the corner of an eye that is busy.
 */
function drawCondition(hud: Hud, view: HudView, width: number): void {
  const condition = view.session.condition;
  const color = CONDITION_COLOR[condition];
  const pulse =
    condition === "red" ? 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(view.time * 7.4)) : 1;

  scratch.copy(color).multiplyScalar(pulse);
  hud.text(`CONDITION ${condition.toUpperCase()}`, 34, 148, 1.9, scratch);
  // A bar under it, which is the part that carries at the edge of vision.
  hud.segments([34, 140, 34 + (condition === "green" ? 60 : 150), 140], scratch);
  void width;
}

const leadTarget = new Vector3();
const leadRelative = new Vector3();
const leadAim = new Vector3();

/**
 * Where to point so a torpedo and the nearest hostile arrive together.
 *
 * Torpedoes are deliberately slow and must be led — that is the whole of what
 * distinguishes them from phasers. But leading them was a guess rather than a
 * skill: a Raider crosses at roughly 180 degrees a second at its preferred
 * range, and no instrument said anything about it. The ship knows the
 * intercept exactly, so it draws it, the same way it draws every other thing
 * it knows. The skill stays — you still have to turn, and the mark moves while
 * you do — but it is now a thing you can aim at rather than a thing you guess.
 *
 * The torpedo inherits the ship's velocity, so the whole solve happens in the
 * ship's frame: the target's velocity is relative, and the answer is a bearing
 * rather than a world position.
 */
function drawLeadPip(hud: Hud, view: HudView, width: number, height: number): void {
  const { player, fleet, session, camera } = view;
  if (player.torpedoes <= 0) return;

  const range = TORPEDO.speed * TORPEDO.life;
  let best: { distance: number; time: number; hostile: Hostile } | null = null;

  for (const hostile of fleet.hostiles) {
    if (hostile.hidden) continue; // nothing to solve for what will not resolve
    leadTarget.subVectors(hostile.position, player.position);
    const distance = leadTarget.length();
    if (distance > range) continue;
    leadRelative.subVectors(hostile.velocity, player.velocity);

    // |r + v t| = s t, as a quadratic in t.
    const a = leadRelative.lengthSq() - TORPEDO.speed * TORPEDO.speed;
    const b = 2 * leadTarget.dot(leadRelative);
    const c = leadTarget.lengthSq();

    let time: number;
    if (Math.abs(a) < 1e-6) {
      // Target closing at exactly torpedo speed — degenerate, solve linearly.
      if (Math.abs(b) < 1e-6) continue;
      time = -c / b;
    } else {
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue; // outruns the torpedo: no intercept exists
      const root = Math.sqrt(disc);
      const t1 = (-b - root) / (2 * a);
      const t2 = (-b + root) / (2 * a);
      // The soonest meeting that has not already happened.
      const candidates = [t1, t2].filter((t) => t > 0).sort((x, y) => x - y);
      if (!candidates.length) continue;
      time = candidates[0];
    }

    if (time > TORPEDO.life) continue; // it would burn out on the way
    if (best && distance >= best.distance) continue;
    best = { distance, time, hostile };
    leadAim.copy(leadTarget).addScaledVector(leadRelative, time);
  }

  if (!best) return;

  // Placed at the target's own range along the firing line, so the mark sits
  // in the world beside the ship it belongs to rather than floating at a
  // distance of its own.
  //
  // **The solve above needed nothing when the world gained height.** `|r + vt|
  // = st` is a quadratic in `t` and it is written in `Vector3` arithmetic —
  // `lengthSq`, `dot`, `subVectors` — so it has been solving the three
  // dimensional intercept all along and simply never saw a non-zero `y`. The
  // one line that was planar was the one directly below this, which flattened
  // the finished answer onto the deck before projecting it; a pip that sat
  // under the ship it belonged to would have been the visible half of a
  // solution that was already right.
  leadAim.setLength(best.distance).add(player.position);
  leadAim.project(camera);
  if (leadAim.z > 1) return; // behind the camera

  const x = (leadAim.x * 0.5 + 0.5) * width;
  const y = (leadAim.y * 0.5 + 0.5) * height;
  if (x < 20 || x > width - 20 || y < 20 || y > height - 20) return;

  // Four corners rather than a box: it reads as a solution being offered
  // rather than as a lock the ship has taken for you.
  const r = 11;
  const arm = 5;
  const flat: number[] = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    flat.push(x + sx * r, y + sy * r, x + sx * (r - arm), y + sy * r);
    flat.push(x + sx * r, y + sy * r, x + sx * r, y + sy * (r - arm));
  }
  // Amber, the alert colour, only while a torpedo is actually ready to use it.
  const ready = !session.docked && player.torpedoCooldown <= 0;
  scratch.copy(ready ? PALETTE.amber : PALETTE.traceDim);
  hud.segments(flat, scratch);

  // What it is and how far, beside the mark. The class colours already say
  // this to anyone who has learned them; the words are for everyone who has
  // not, and the range is the number that decides whether to fire at all.
  if (!best.hostile) return;
  const label = HOSTILE_NAMES[best.hostile.kind];
  hud.text(label, x + r + 7, y + 3, 1.5, HOSTILE_COLORS[best.hostile.kind]);
  hud.text(`${pad(best.distance, 3)}`, x + r + 7, y - 11, 1.4, PALETTE.traceDim);
}

const tagPoint = new Vector3();

/**
 * The Warden, named in the forward view.
 *
 * The lead pip already proved the case: a mark the ship draws around something
 * in the world is worth more than the same information on an instrument at the
 * edge of the screen, because it is read without looking away. This is that
 * argument spent on identification rather than on a firing solution — a hull
 * you might otherwise shoot at, with its class, its name and its range hung off
 * a leader line.
 *
 * Two lines and no more. It is a label, not a panel, and the moment it is
 * bigger than the ship it points at it is competing with the thing it exists to
 * explain. Dim, for the same reason: it must never be brighter than the hull.
 */
function drawEscortTag(hud: Hud, view: HudView, width: number, height: number): void {
  const escort = view.session.escort;
  if (!escort) return;

  // Only while it is on the tube. Naming something at 160 km is naming a dot,
  // and the label would be bigger than the hull it points at.
  const range = escort.position.distanceTo(view.player.position);
  if (range > SCANNER.range) return;

  // Lifted off the plane so the leader starts above the hull rather than
  // through it. Everything else in this game is planar; a label is allowed a
  // couple of units of headroom.
  tagPoint.copy(escort.position);
  tagPoint.y = 1.2;
  tagPoint.project(view.camera);
  if (tagPoint.z > 1) return; // behind the camera

  const x = (tagPoint.x * 0.5 + 0.5) * width;
  const y = (tagPoint.y * 0.5 + 0.5) * height;
  // Kept clear of the frame: a label half off the edge is worse than no label.
  if (x < 70 || x > width - 70 || y < 60 || y > height - 90) return;
  // And out of the scanner's box. A ship near the horizon projects high up the
  // screen, which is exactly where the tube is, and two instruments drawn
  // through each other are neither of them legible. The scanner is the one that
  // must never be obscured, so this is the label that gives way.
  if (Math.abs(x - width / 2) < 150 && Math.abs(y - (height - 148)) < 150) return;

  hud.segments([x, y + 8, x, y + 20, x, y + 20, x + 8, y + 20], PALETTE.traceDim);

  scratch.copy(PALETTE.trace).multiplyScalar(0.7);
  hud.text(escort.label, x + 11, y + 34, 1.7, scratch);
  hud.text(`ALLY   ${pad(range, 3)} KM`, x + 11, y + 22, 1.3, PALETTE.traceDim);
}

function drawHyperwarp(hud: Hud, view: HudView, cx: number, cy: number): void {
  const { campaign, player, session } = view;
  const { hyperwarp } = session;
  const width = 150;
  const progress = Math.min(1, hyperwarp.progress);

  const centred = (text: string, y: number, scale: number, color: Color) =>
    hud.text(text, cx - (text.length * GLYPH_ADVANCE * scale) / 2, y, scale, color);

  // Magenta, because the destination is a place the ship has not resolved yet
  // — the same reason the scanner paints an unresolved contact that colour.
  hud.gauge(cx - width, cy, width * 2, 14, progress, PALETTE.magenta, 4);
  hud.textRight("CHARGE", cx - width - 12, cy + 3, 1.4, PALETTE.traceDim);

  // Where you are going, named as well as numbered, so the panel and the cell
  // under the cursor are obviously the same place.
  const to = view.chartCursor;
  centred(
    `${sectorCode(to)}  ${regionName(campaign.seed, to)}`,
    cy + 30,
    1.8,
    PALETTE.magenta,
  );

  // What it costs, said plainly while there is still time to let go — and now
  // that distance sets the charge, how long is part of what it costs. The
  // reserve is called out because a charge that outlasts it dies unarrived.
  const seconds = jumpCharge(campaign.current, to);
  const cost = jumpEnergy(campaign.current, to, HYPERWARP.drainPerSecond);
  const short = cost > player.energy;
  centred(
    `${jumpSteps(campaign.current, to)} SECTORS   ${seconds.toFixed(1)}S COLD   MULTIPLIER HALVED`,
    cy - 26,
    1.4,
    PALETTE.traceDim,
  );
  if (short) centred("RESERVE WILL NOT LAST", cy - 44, 1.6, PALETTE.amber);
}

function drawDockingPanel(hud: Hud, view: HudView, cx: number, cy: number): void {
  const { docking } = view.session;
  const g = docking.info;
  const centred = (text: string, y: number, scale: number, color: Color) =>
    hud.text(text, cx - (text.length * 4.2 * scale) / 2, y, scale, color);

  // The station's own name, under every phase of the sequence. You are docking
  // somewhere, not at "the starbase" — see `chart/naming.ts`.
  //
  // Below the panel rather than above it: the message line owns `height/2 + 96`
  // and the clamps engaging puts "WELCOME TO ..." there at scale 3.6, so a
  // header up there is a header nobody can read for the two seconds it matters
  // most.
  centred(docking.stationName, cy - 76, 2.2, PALETTE.traceDim);

  if (docking.phase === "aligning") {
    const width = 150;

    // Lateral needle: how far off the corridor centreline, clamped to the bar.
    hud.segments([cx - width, cy, cx + width, cy], PALETTE.traceDim);
    for (const side of [-1, 1]) {
      hud.segments([cx + side * 26, cy - 5, cx + side * 26, cy + 5], PALETTE.traceDim);
    }
    const offset = MathUtils.clamp(g.lateral * 5.5, -width, width);
    scratch.copy(Math.abs(g.lateral) < 5 ? PALETTE.trace : PALETTE.amber);
    hud.segments([cx + offset, cy - 13, cx + offset, cy + 13], scratch);
    hud.textRight("LATERAL", cx - width - 12, cy - 4, 1.4, PALETTE.traceDim);

    // Speed, with the capture ceiling marked.
    const barY = cy - 32;
    hud.gauge(cx - width, barY, width * 2, 12, Math.min(1, g.speed / 40), g.speedOk ? PALETTE.trace : PALETTE.amber, 4);
    const ceiling = cx - width + (16 / 40) * width * 2;
    hud.segments([ceiling, barY - 4, ceiling, barY + 16], PALETTE.magenta);
    hud.textRight("SPEED", cx - width - 12, barY + 2, 1.4, PALETTE.traceDim);

    scratch.copy(g.headingOk && g.speedOk ? PALETTE.trace : PALETTE.amber);
    centred(docking.status, cy + 26, 1.8, scratch);
    centred(`RANGE ${pad(g.range, 3)}`, cy - 56, 1.4, PALETTE.traceDim);
    return;
  }

  if (docking.phase === "capture") {
    const segments: number[] = [];
    arc(segments, cx, cy, 34, Math.PI / 2, Math.PI / 2 - docking.captureProgress * Math.PI * 2, 26);
    hud.segments(segments, PALETTE.magenta);
    centred("TRACTOR LOCK", cy + 52, 2.2, PALETTE.magenta);
    return;
  }

  // Moored and released: the service readout and the itemised tally.
  centred(docking.status, cy + 52, 2.0, PALETTE.trace);

  const bank = view.session.lastBank;
  if (docking.phase === "released" && bank.total > 0) {
    centred(
      `${pad(bank.salvage, 5)}  X${bank.multiplier.toFixed(1)}  =  ${pad(bank.total, 6)}`,
      cy + 22,
      2.0,
      PALETTE.amber,
    );
  }
}

function drawDiagnostics(hud: Hud, view: HudView, width: number, height: number): void {
  hud.text("KOBAYASHI", 34, height - 48, 3.4, PALETTE.trace);
  hud.text("PROTOTYPE", 34, height - 68, 1.5, PALETTE.traceDim);

  const rows: [string, string][] = [
    ["G  GEOMETRY", view.shapeMode.toUpperCase()],
    ["B  BLOOM", view.bloom ? "ON" : "OFF"],
    ["F  PHOSPHOR", view.phosphor ? "ON" : "OFF"],
    ["V  CRT GLASS", view.crt ? "ON" : "OFF"],
    ["M  AUDIO", view.muted ? "MUTED" : "ON"],
    // The one switch here that changes the game rather than the picture, and it
    // sits with the display toggles because that is where its key lives — see
    // `DISPLAY_KEYS`. It says which of two games is currently running.
    ["Y  ALTITUDE", flight.threeD ? "ON" : "FLAT"],
    ["1/2/3  VIEW", view.cameraMode.toUpperCase()],
  ];
  rows.forEach(([label, value], index) => {
    const y = height - 106 - index * 19;
    hud.text(label, 34, y, 1.5, PALETTE.traceDim);
    hud.text(value, 180, y, 1.5, dim);
  });

  hud.textRight(`${pad(view.fps, 3)} FPS`, width - 34, height - 48, 1.5, PALETTE.traceDim);
  hud.textRight("SPACE FIRE   X TORPEDO", width - 34, height - 68, 1.5, PALETTE.traceDim);
  hud.textRight(
    flight.threeD ? "ARROWS / WASD  FLY   Q / E  CLIMB / DIVE" : "ARROWS / WASD  FLY",
    width - 34,
    height - 86,
    1.5,
    PALETTE.traceDim,
  );
}
