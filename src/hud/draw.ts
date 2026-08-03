import { Color, MathUtils, Vector3 } from "three";
import { PALETTE } from "../render/palette.js";
import type { Hud } from "./Hud.js";
import { FACINGS, type Ship } from "../game/Ship.js";
import type { Session } from "../game/session.js";
import { HOSTILE_COLORS, type Fleet } from "../game/hostiles.js";
import { TORPEDO } from "../game/weapons.js";

export interface HudView {
  readonly player: Ship;
  readonly session: Session;
  readonly fleet: Fleet;
  readonly starbase: Vector3;
  readonly fps: number;
  readonly time: number;
  readonly cameraMode: string;
  readonly shapeMode: string;
  readonly bloom: boolean;
  readonly phosphor: boolean;
  readonly crt: boolean;
  readonly showDiagnostics: boolean;
}

const SCANNER_RANGE = 150;
const dim = PALETTE.trace.clone().multiplyScalar(0.5);
const scratch = new Color();

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
  const { player, session } = view;
  hud.begin();

  hud.brackets(18, 18, width - 36, height - 36, 22, PALETTE.traceDim);

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
    hud.text(
      session.message,
      width / 2 - (session.message.length * 4.2 * scale) / 2,
      height / 2 + 96,
      scale,
      scratch,
    );
  }

  if (session.state === "dead") {
    const hint = "PRESS R TO RUN AGAIN";
    hud.text(hint, width / 2 - (hint.length * 4.2 * 1.8) / 2, height / 2 + 60, 1.8, dim);
  }

  if (view.showDiagnostics) drawDiagnostics(hud, view, width, height);

  hud.end();
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
 */
function drawScanner(hud: Hud, view: HudView, cx: number, cy: number): void {
  const { player, fleet, starbase, session } = view;
  const radius = 104;
  const scale = radius / SCANNER_RANGE;

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

  // A sweep, because a scanner that does not sweep does not read as live.
  const sweep = (view.time * 0.7) % (Math.PI * 2);
  hud.segments(
    [cx, cy, cx + Math.cos(Math.PI / 2 - sweep) * radius, cy + Math.sin(Math.PI / 2 - sweep) * radius],
    scratch.copy(PALETTE.traceDim).multiplyScalar(0.8),
  );

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

  // Contacts. Glyph encodes class, so the scanner tells you what is coming,
  // not merely that something is.
  for (const hostile of fleet.hostiles) {
    const mark = project(hostile.position);
    scratch.copy(HOSTILE_COLORS[hostile.kind]).multiplyScalar(mark.clamped ? 0.45 : 1);
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
    } else {
      marks.push(mark.x - 4, mark.y - 4, mark.x + 4, mark.y - 4);
      marks.push(mark.x + 4, mark.y - 4, mark.x + 4, mark.y + 4);
      marks.push(mark.x + 4, mark.y + 4, mark.x - 4, mark.y + 4);
      marks.push(mark.x - 4, mark.y + 4, mark.x - 4, mark.y - 4);
    }
    hud.segments(marks, scratch);
  }

  // Own ship, fixed at the centre pointing up.
  hud.segments(
    [cx, cy + 8, cx - 5, cy - 6, cx - 5, cy - 6, cx, cy - 2.5, cx, cy - 2.5, cx + 5, cy - 6, cx + 5, cy - 6, cx, cy + 8],
    PALETTE.trace,
  );

  hud.text("SCANNER", cx - radius, cy + radius + 16, 1.5, PALETTE.traceDim);
  hud.textRight(`${pad(SCANNER_RANGE, 3)} KM`, cx + radius, cy + radius + 16, 1.5, PALETTE.traceDim);
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
