import { Color, MathUtils, Vector3 } from "three";
import { PALETTE } from "../render/palette.js";
import type { Hud } from "./Hud.js";
import { FACINGS, type Ship } from "../game/Ship.js";
import type { Session } from "../game/session.js";
import { HOSTILE_COLORS, type Fleet } from "../game/hostiles.js";
import type { Presentation } from "../game/presentation.js";
import { TORPEDO } from "../game/weapons.js";
import { SCANNER, ScannerModel } from "./scanner.js";
import { GLYPH_ADVANCE } from "./strokeFont.js";

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
  readonly shapeMode: string;
  readonly bloom: boolean;
  readonly phosphor: boolean;
  readonly crt: boolean;
  readonly muted: boolean;
  readonly showDiagnostics: boolean;
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
  for (let i = 0; i < TORPEDO.capacity; i++) {
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
