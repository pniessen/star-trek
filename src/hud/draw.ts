import { Color, MathUtils, Vector3, type PerspectiveCamera } from "three";
import { TORPEDO } from "../game/weapons.js";
import { PALETTE } from "../render/palette.js";
import type { Hud } from "./Hud.js";
import { FACINGS, type Ship } from "../game/Ship.js";
import type { Session } from "../game/session.js";
import { HOSTILE_COLORS, type Fleet } from "../game/hostiles.js";
import type { Presentation } from "../game/presentation.js";
import { SCANNER, ScannerModel } from "./scanner.js";
import { GLYPH_ADVANCE } from "./strokeFont.js";
import { drawChart, drawCommand } from "../chart/ChartView.js";
import { colOf, rowOf } from "../chart/sectors.js";
import type { Campaign } from "../chart/campaign.js";

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
  drawShields(hud, player, width / 2, 96);
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
  drawChart(hud, view.campaign, view.chartOpacity, view.chartCursor);

  hud.end();
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

  // The ship itself owns the middle of the frame — the camera is orbiting it —
  // so the panel is composed around that band rather than over it.
  // The title block sits above the grid's horizon and the legend below the
  // ship, so the two dense bands of the scene — the plane and the hull — each
  // land in a gap rather than under type.
  centred(hud, "KOBAYASHI", cx, 640, 9, PALETTE.trace);
  rule(hud, cx, 616, 210, PALETTE.traceDim);
  centred(hud, "NO-WIN SCENARIO   VECTOR COMBAT TRIALS", cx, 584, 1.9, PALETTE.traceDim);

  // The controls as a readout, not as a legend: dim label, bright value, the
  // same two columns the diagnostics block uses.
  const rows: [string, string][] = [
    ["LAUNCH", "ANY KEY"],
    ["FLY", "ARROWS / WASD"],
    ["PHASERS", "SPACE"],
    ["TORPEDOES", "X"],
    ["BANK SALVAGE", "FLY THE CORRIDOR"],
  ];
  rows.forEach(([label, value], index) => {
    const y = 288 - index * 26;
    hud.textRight(label, cx - 20, y, 1.7, PALETTE.traceDim);
    hud.text(value, cx + 20, y, 1.7, dim);
  });

  if (blink(view.time)) {
    centred(hud, "PRESS ANY KEY TO LAUNCH", cx, 132, 2.6, PALETTE.amber);
  }

  if (presentation.best > 0) {
    centred(hud, `BEST THIS SITTING   ${pad(presentation.best, 6)}`, cx, 88, 1.7, PALETTE.traceDim);
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
 * This is not decoration — it is the reason the play space is a plane. A flat
 * world means every contact is exactly where the scanner says it is, so the
 * skill of the game is reading this and turning the right shield toward the
 * right threat, while the forward view handles the shooting. That split is the
 * 1982 arcade cabinet's answer and it has not been improved on.
 *
 * Heading-up rather than north-up: in first person you steer relative to your
 * own nose, and a rotating map is one less translation to do under pressure.
 *
 * The tube shows four things now, in descending order of certainty: resolved
 * hostiles, which are exactly where they are drawn and only dim between sweeps;
 * mines, which never move and so are never in doubt; unresolved returns, which
 * are drawn as the circle of error they actually carry; and the starbase.
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

  const project = (world: Vector3): { x: number; y: number; clamped: boolean } => {
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
    return { x: cx + px, y: cy + py, clamped };
  };

  // Starbase: the thing you are gambling against reaching.
  const base = project(starbase);
  const baseMark: number[] = [];
  arc(baseMark, base.x, base.y, base.clamped ? 4 : 6, 0, Math.PI * 2, 8);
  if (!base.clamped) {
    baseMark.push(base.x - 9, base.y, base.x + 9, base.y, base.x, base.y - 9, base.x, base.y + 9);
  }
  hud.segments(baseMark, session.docked ? PALETTE.trace : PALETTE.traceDim);

  // Mines: small violet diamonds, the same glyph as the Harrow that laid them
  // at a third the size. They never move, so there is nothing to be uncertain
  // about — and knowing where the field is is most of surviving it.
  for (const mine of session.mines.mines) {
    const mark = project(mine.position);
    if (mark.clamped) continue;
    scratch.copy(PALETTE.harrow).multiplyScalar(mine.armed ? 0.95 : 0.4);
    hud.segments(diamond(mark.x, mark.y, 2.2), scratch);
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
  const escort = session.escort;
  if (escort) {
    const mark = project(escort.position);
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

  // Own ship, fixed at the centre pointing up.
  hud.segments(
    [cx, cy + 8, cx - 5, cy - 6, cx - 5, cy - 6, cx, cy - 2.5, cx, cy - 2.5, cx + 5, cy - 6, cx + 5, cy - 6, cx, cy + 8],
    PALETTE.trace,
  );

  hud.text("SCANNER", cx - radius, cy + radius + 16, 1.5, PALETTE.traceDim);
  hud.textRight(`${pad(SCANNER.range, 3)} KM`, cx + radius, cy + radius + 16, 1.5, PALETTE.traceDim);

  // An annunciator rather than a count: reporting how many cloaked hulls exist
  // would be telling you something the scanner cannot know. This only says that
  // something out there is returning and will not resolve.
  if (contacts.alert && Math.sin(view.time * 8) > -0.3) {
    const label = "UNRESOLVED";
    hud.text(label, cx - (label.length * 4.2 * 1.6) / 2, cy - radius - 22, 1.6, PALETTE.magenta);
  }
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

function drawShields(hud: Hud, player: Ship, cx: number, cy: number): void {
  FACINGS.forEach((facing, index) => {
    const charge = player.shields[facing];
    const segments: number[] = [];
    const centre = Math.PI / 2 - index * (Math.PI / 2);
    arc(segments, cx, cy, 34, centre - Math.PI / 4 + 0.24, centre + Math.PI / 4 - 0.24, 6);
    scratch
      .copy(charge < 0.3 ? PALETTE.amber : PALETTE.trace)
      .multiplyScalar(0.2 + charge * 0.8);
    hud.segments(segments, scratch);
  });

  hud.segments(
    [cx, cy + 9, cx - 6, cy - 7, cx - 6, cy - 7, cx, cy - 3, cx, cy - 3, cx + 6, cy - 7, cx + 6, cy - 7, cx, cy + 9],
    PALETTE.traceDim,
  );
  hud.textRight("SHIELDS", cx - 48, cy - 4, 1.5, PALETTE.traceDim);
}

function drawStatus(hud: Hud, view: HudView): void {
  const { player } = view;

  hud.text("ENERGY", 34, 128, 1.5, PALETTE.traceDim);
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
  let best: { distance: number; time: number } | null = null;

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
    best = { distance, time };
    leadAim.copy(leadTarget).addScaledVector(leadRelative, time);
  }

  if (!best) return;

  // Placed at the target's own range along the firing line, so the mark sits
  // in the world beside the ship it belongs to rather than floating at a
  // distance of its own.
  leadAim.setLength(best.distance).add(player.position);
  leadAim.y = 0;
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
  scratch.copy(session.docked || player.torpedoCooldown > 0 ? PALETTE.traceDim : PALETTE.amber);
  hud.segments(flat, scratch);
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
  const { hyperwarp } = view.session;
  const width = 150;
  const progress = Math.min(1, hyperwarp.progress);

  const centred = (text: string, y: number, scale: number, color: Color) =>
    hud.text(text, cx - (text.length * GLYPH_ADVANCE * scale) / 2, y, scale, color);

  // Magenta, because the destination is a place the ship has not resolved yet
  // — the same reason the scanner paints an unresolved contact that colour.
  hud.gauge(cx - width, cy, width * 2, 14, progress, PALETTE.magenta, 4);
  hud.textRight("CHARGE", cx - width - 12, cy + 3, 1.4, PALETTE.traceDim);

  // Where you are going, in the chart's own coordinates, so the number on the
  // panel and the cell under the cursor are obviously the same thing.
  const col = colOf(view.chartCursor);
  const row = rowOf(view.chartCursor);
  centred(`SECTOR ${String.fromCharCode(65 + col)}${row + 1}`, cy + 30, 1.8, PALETTE.magenta);

  // The two things it costs, said plainly while there is still time to let go.
  centred("GUNS COLD   MULTIPLIER HALVED", cy - 26, 1.4, PALETTE.traceDim);
}

function drawDockingPanel(hud: Hud, view: HudView, cx: number, cy: number): void {
  const { docking } = view.session;
  const g = docking.info;
  const centred = (text: string, y: number, scale: number, color: Color) =>
    hud.text(text, cx - (text.length * 4.2 * scale) / 2, y, scale, color);

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
    ["1/2/3  VIEW", view.cameraMode.toUpperCase()],
  ];
  rows.forEach(([label, value], index) => {
    const y = height - 106 - index * 19;
    hud.text(label, 34, y, 1.5, PALETTE.traceDim);
    hud.text(value, 180, y, 1.5, dim);
  });

  hud.textRight(`${pad(view.fps, 3)} FPS`, width - 34, height - 48, 1.5, PALETTE.traceDim);
  hud.textRight("SPACE FIRE   X TORPEDO", width - 34, height - 68, 1.5, PALETTE.traceDim);
  hud.textRight("ARROWS / WASD  FLY", width - 34, height - 86, 1.5, PALETTE.traceDim);
}
