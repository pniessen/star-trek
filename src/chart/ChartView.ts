import { Color } from "three";
import { PALETTE } from "../render/palette.js";
import type { Hud } from "../hud/Hud.js";
import { GLYPH_ADVANCE } from "../hud/strokeFont.js";
import { colOf, rowOf, GRID } from "./sectors.js";
import { canDock, countControl, isLost, isWon, type Campaign, type Control } from "./campaign.js";
import { DECISIONS, HEADINGS, loadoutSummary, refusal, sectorName } from "./command.js";
import { isFitted, patrolCapacity, patrolCount, structureSpec, type RefitId, type RunReport } from "./economy.js";

/** Laid out in the HUD's fixed 800-unit design space, like everything else. */
export const CHART = {
  size: 460,
  /** The command view's copy, shrunk to leave the decisions room beside it. */
  commandSize: 380,
} as const;

/**
 * Control is read as colour, per the design: cyan ours, magenta contested,
 * amber theirs. Threat is ticks on the sector edge, not a number to read.
 *
 * `PALETTE.trace` is the player's own cyan (see palette.ts) and `PALETTE.magenta`
 * is already the "unresolved" hue used by the scanner's ghost contacts, so both
 * are reused here rather than adding new named colours to the roster.
 * `PALETTE.amber` ("alerts, and the raider class") is the same reuse for
 * "theirs" — not a lookalike literal, the actual catalogued colour.
 */
const CONTROL_COLOR: Record<Control, Color> = {
  ours: PALETTE.trace,
  contested: PALETTE.magenta,
  theirs: PALETTE.amber,
};

/**
 * What the command view needs from outside itself. All of it is either the
 * cursor the player is moving or the last thing that happened — the campaign
 * carries everything else.
 */
export interface CommandFrame {
  readonly cursor: number;
  /** Index into `DECISIONS`. */
  readonly selection: number;
  /** The last decision's answer, refusal included. */
  readonly message: string;
  /** What the enemy did while the player was reading the tally. */
  readonly report: RunReport | null;
  /** Real seconds, for the blinking prompt. Time-based, not frame-based. */
  readonly time: number;
}

/**
 * The tactical overlay: the same map, faded over a run that is still moving.
 */
export function drawChart(
  hud: Hud,
  campaign: Campaign,
  opacity: number,
  cursor: number,
): void {
  // `chartOpacity` is an exponential ease in main.ts: it approaches zero after
  // the player releases Tab but never mathematically reaches it, so `<= 0`
  // would only ever be true before the first press. Without a real cutoff
  // this function would keep rebuilding ~64 sectors of segments every frame
  // for the rest of the session at a brightness indistinguishable from off —
  // exactly what `Hud`'s preallocated-buffer design exists to avoid.
  if (opacity < 1e-3) return;

  // `Hud` draws in a 0..width, 0..800 space with the origin at the bottom
  // left, not centred on zero — so the chart centres itself here, on the
  // panel's own footprint, rather than assuming a coordinate space it is not
  // drawn into.
  const { width, height } = hud.size;
  drawGrid(hud, campaign, {
    originX: width / 2 - CHART.size / 2,
    originY: height / 2 - CHART.size / 2,
    cell: CHART.size / GRID,
    opacity,
    cursor,
    holdings: false,
  });
}

interface GridPlacement {
  readonly originX: number;
  readonly originY: number;
  readonly cell: number;
  readonly opacity: number;
  readonly cursor: number;
  /** Structures, patrols and the chosen front. Only the command view shows them. */
  readonly holdings: boolean;
}

/**
 * One grid, drawn twice. The design doc's reason for a single renderer is that
 * two would drift — the in-run map would get a legibility fix the command view
 * never received — so the difference between the two modes is this options
 * object and nothing else.
 */
function drawGrid(hud: Hud, campaign: Campaign, place: GridPlacement): void {
  const { originX, originY, cell, opacity, cursor, holdings } = place;

  for (let i = 0; i < campaign.sectors.length; i++) {
    const sector = campaign.sectors[i];
    const x = originX + colOf(i) * cell;
    // Row 0 draws at the *top*. `newCampaign` gives the enemy the first
    // `ENEMY_START_DEPTH` rows and puts your home starbase on the last one, so
    // drawing row 0 at the bottom put the invasion below you and home above —
    // and inverted the cursor keys with it, since `w` steps toward row 0. The
    // flip belongs here rather than in the input: the grid is row-major from
    // the far edge, and that is what "far" has to look like.
    const y = originY + (GRID - 1 - rowOf(i)) * cell;
    const color = CONTROL_COLOR[sector.control];

    hud.rect(x + 2, y + 2, cell - 4, cell - 4, fade(color, opacity * 0.5));

    // Threat as ticks along the bottom edge. A digit would be one more thing
    // to read; ticks are countable at a glance under fire.
    const ticks: number[] = [];
    for (let t = 0; t < sector.threat; t++) {
      const tx = x + 5 + t * 4;
      ticks.push(tx, y + 4, tx, y + 9);
    }
    hud.segments(ticks, fade(color, opacity * 0.8));

    // Yield as ticks along the top edge, mirroring threat's along the
    // bottom — a different edge keeps the two countable at a glance without
    // spending a colour on it, and `traceDim` is reused rather than adding
    // one, per the "colour is information" rule.
    const yieldTicks: number[] = [];
    for (let v = 0; v < sector.yield; v++) {
      const ty = x + 5 + v * 4;
      yieldTicks.push(ty, y + cell - 9, ty, y + cell - 4);
    }
    if (yieldTicks.length) hud.segments(yieldTicks, fade(PALETTE.traceDim, opacity * 0.8));

    // Somewhere to bank is the single most decision-relevant fact on the map.
    if (canDock(sector)) {
      ring(hud, x + cell / 2, y + cell / 2, cell * 0.18, fade(color, opacity));
    }

    // An attack already committed against this sector. This is the whole
    // reason to look at the chart mid-run rather than only between runs.
    if (campaign.incoming.some((move) => move.sector === i)) {
      ring(hud, x + cell / 2, y + cell / 2, cell * 0.34, fade(CONTROL_COLOR.theirs, opacity));
    }

    if (holdings) drawHoldings(hud, campaign, i, x, y, cell, opacity);

    // Where you are, versus where you are pointing. These were both thin
    // outlines in the same cyan, which made them the same mark to anyone not
    // already holding the code in their head. They are now different in
    // *shape* and in *colour*: you are a filled block, the cursor is an amber
    // frame with corners — the same amber that marks the selected decision, so
    // "amber is what I am pointing at" holds across the whole screen.
    if (i === campaign.current) {
      fillCell(hud, x + 3, y + 3, cell - 6, cell - 6, fade(PALETTE.trace, opacity * 0.55));
      hud.rect(x + 2, y + 2, cell - 4, cell - 4, fade(PALETTE.trace, opacity));
    }
    if (i === cursor) {
      hud.rect(x, y, cell, cell, fade(PALETTE.amber, opacity));
      // Corners outside the box, so the cursor still reads on a cell that is
      // already filled because you are standing in it.
      const a = 5;
      hud.segments(
        [
          x - 2, y - 2, x - 2 + a, y - 2, x - 2, y - 2, x - 2, y - 2 + a,
          x + cell + 2, y - 2, x + cell + 2 - a, y - 2, x + cell + 2, y - 2, x + cell + 2, y - 2 + a,
          x - 2, y + cell + 2, x - 2 + a, y + cell + 2, x - 2, y + cell + 2, x - 2, y + cell + 2 - a,
          x + cell + 2, y + cell + 2, x + cell + 2 - a, y + cell + 2,
          x + cell + 2, y + cell + 2, x + cell + 2, y + cell + 2 - a,
        ],
        fade(PALETTE.amber, opacity),
      );
    }
  }
}

/**
 * A hatched block. The HUD draws segments, so "solid" is close-spaced lines —
 * the same trick `Hud.gauge` uses to fill a bar, reused rather than reinvented.
 */
function fillCell(hud: Hud, x: number, y: number, w: number, h: number, color: Color): void {
  const flat: number[] = [];
  for (let i = 2; i < h; i += 3) flat.push(x, y + i, x + w, y + i);
  hud.segments(flat, color);
}

/**
 * What you own in a sector, on the two edges threat and yield left free: the
 * right edge counts structures, the left counts patrol strength. Under
 * construction is drawn dim rather than absent, because "the yard I am waiting
 * on is in the sector about to fall" is exactly the decision this screen is
 * for.
 */
function drawHoldings(
  hud: Hud,
  campaign: Campaign,
  index: number,
  x: number,
  y: number,
  cell: number,
  opacity: number,
): void {
  const sector = campaign.sectors[index];

  sector.structures.forEach((structure, slot) => {
    const sy = y + 12 + slot * 6;
    const done = structure.runsRemaining === 0;
    hud.segments(
      [x + cell - 9, sy, x + cell - 4, sy],
      fade(PALETTE.trace, opacity * (done ? 1 : 0.4)),
    );
  });

  const patrol = sector.patrol;
  if (patrol) {
    const marks: number[] = [];
    for (let s = 0; s < patrol.strength; s++) {
      const py = y + 12 + s * 6;
      marks.push(x + 4, py, x + 9, py);
    }
    hud.segments(marks, fade(PALETTE.magenta, opacity));
  }

  // The commitment, marked as brackets rather than another ring — the cell
  // already carries up to three concentric ones and a fourth is soup.
  if (index === campaign.front) {
    hud.brackets(x + 3, y + 3, cell - 6, cell - 6, 7, fade(PALETTE.trace, opacity));
  }
}

// ── the command view ────────────────────────────────────────────────────────

const ROW_HEIGHT = 26;
const COLUMN = { chart: 0, options: 430, width: 940 } as const;

/**
 * The command view: the same map, zoomed to fill, with the four decisions
 * beside it.
 *
 * Everything is on this one screen because `strategy-layer.md` makes that a
 * rule rather than a preference — four decisions per visit, no submenus, and
 * if a chart visit takes longer than a run the layer has failed. The list
 * reads top to bottom as the sentence the design states: spend, equip,
 * position, go.
 */
export function drawCommand(hud: Hud, campaign: Campaign, frame: CommandFrame): void {
  const { width, height } = hud.size;
  const cx = width / 2;
  // Composed around the centre and clamped to the window, so a narrow cabinet
  // squeezes the gap between the map and the list instead of pushing either
  // off the edge.
  const inner = Math.min(COLUMN.width, width - 80);
  const left = cx - inner / 2;
  const right = cx + inner / 2;
  const cell = CHART.commandSize / GRID;

  hud.brackets(18, 18, width - 36, height - 36, 22, PALETTE.traceDim);

  // ── header ──
  // The run has no win state and the war does. This is the only screen that
  // can say so, so it says it in the title rather than in a message that
  // scrolls away.
  const won = isWon(campaign);
  const over = won || isLost(campaign);
  centred(
    hud,
    won ? "INVASION BROKEN" : isLost(campaign) ? "COMMAND LOST" : "COMMAND",
    cx,
    height - 62,
    4.2,
    won ? PALETTE.trace : over ? PALETTE.amber : PALETTE.trace,
  );
  rule(hud, cx, height - 84, 210, PALETTE.traceDim);

  hud.text("SALVAGE", left, height - 118, 1.6, PALETTE.traceDim);
  hud.text(pad(campaign.salvage, 5), left + 68, height - 122, 2.6, PALETTE.amber);

  centred(hud, `RUN ${pad(campaign.runsElapsed + 1, 2)}`, cx, height - 120, 2.2, PALETTE.trace);

  hud.textRight(
    `HELD ${pad(countControl(campaign, "ours"), 2)}   THEIRS ${pad(countControl(campaign, "theirs"), 2)}`,
    right,
    height - 120,
    1.8,
    PALETTE.traceDim,
  );

  // ── the map ──
  const chartY = height - 170 - CHART.commandSize;
  drawGrid(hud, campaign, {
    originX: left + COLUMN.chart,
    originY: chartY,
    cell,
    opacity: 1,
    cursor: frame.cursor,
    holdings: true,
  });

  drawSectorReadout(hud, campaign, frame.cursor, left, chartY - 30);
  drawLegend(hud, left + COLUMN.chart, chartY - 62, CHART.commandSize);

  // ── the four decisions ──
  const optionsX = left + COLUMN.options;
  const costX = right;
  let y = height - 176;
  let previous: string | null = null;

  DECISIONS.forEach((decision, index) => {
    if (decision.kind !== previous) {
      previous = decision.kind;
      y -= 6;
      hud.text(HEADINGS[decision.kind], optionsX, y, 1.8, PALETTE.traceDim);
      y -= ROW_HEIGHT;
    }

    const chosen = index === frame.selection;
    const no = refusal(campaign, decision, frame.cursor);
    const fitted = decision.kind === "refit" && isFitted(campaign, decision.id as RefitId);
    // Colour is the whole state readout here: cyan is available, magenta is
    // already fitted, dim is refused. No fourth colour, and no colour that
    // does not mean something.
    const color = fitted ? PALETTE.magenta : no ? PALETTE.traceDim : PALETTE.trace;

    if (chosen) {
      // A whole bracketed row, not a tick beside one. The old mark was nine
      // pixels of amber next to twelve near-identical lines of text, and it
      // was reported as "tough to navigate" by the first person to try it.
      const top = y + 15;
      const bottom = y - 7;
      hud.segments(
        [
          optionsX - 20, top, optionsX - 20, bottom,
          optionsX - 20, top, optionsX - 12, top,
          optionsX - 20, bottom, optionsX - 12, bottom,
          costX + 20, top, costX + 20, bottom,
          costX + 20, top, costX + 12, top,
          costX + 20, bottom, costX + 12, bottom,
        ],
        PALETTE.amber,
      );
      // A caret that points at the row it has selected.
      hud.segments(
        [optionsX - 34, y + 4, optionsX - 26, y + 4, optionsX - 30, y + 8, optionsX - 26, y + 4,
         optionsX - 30, y, optionsX - 26, y + 4],
        PALETTE.amber,
      );
    }
    hud.text(decision.label, optionsX, y, 2, chosen && !no && !fitted ? PALETTE.amber : color);
    if (decision.cost > 0) {
      hud.textRight(pad(decision.cost, 4), costX, y, 2, chosen && !no ? PALETTE.amber : color);
    }

    // Only the highlighted row explains itself. Twelve permanently-expanded
    // rows is a spreadsheet, which is the thing this layer is defined against.
    if (chosen) {
      y -= 18;
      hud.text(decision.detail, optionsX + 8, y, 1.5, PALETTE.traceDim);
    }
    y -= ROW_HEIGHT;
  });

  // ── the footer: what just happened, and what to press ──
  drawReport(hud, campaign, frame, cx, left, right, over);
}

/**
 * What the marks on the map mean, drawn as the marks themselves.
 *
 * Every symbol here was already on the chart and none of them said what they
 * were. A key costs two rows and is the difference between a map you can read
 * at a glance and one you have to be told about — and being told about it is
 * exactly what happened.
 */
function drawLegend(hud: Hud, x: number, y: number, width: number): void {
  const swatch = 13;
  let cursorX = x;

  const entry = (label: string, draw: (sx: number, sy: number) => void): void => {
    // Wrap to a second row rather than running off the map's right edge.
    if (cursorX + swatch + 10 + label.length * GLYPH_ADVANCE * 1.4 > x + width) {
      cursorX = x;
      y -= 18;
    }
    draw(cursorX, y);
    cursorX += swatch + 5;
    cursorX += hud.text(label, cursorX, y + 3, 1.4, PALETTE.traceDim) + 16;
  };

  entry("YOU", (sx, sy) => {
    fillCell(hud, sx, sy, swatch, swatch, scaled(PALETTE.trace, 0.55));
    hud.rect(sx, sy, swatch, swatch, PALETTE.trace);
  });
  entry("CURSOR", (sx, sy) => hud.rect(sx, sy, swatch, swatch, PALETTE.amber));
  entry("OURS", (sx, sy) => hud.rect(sx, sy, swatch, swatch, CONTROL_COLOR.ours));
  entry("CONTESTED", (sx, sy) => hud.rect(sx, sy, swatch, swatch, CONTROL_COLOR.contested));
  entry("THEIRS", (sx, sy) => hud.rect(sx, sy, swatch, swatch, CONTROL_COLOR.theirs));
  entry("DOCK", (sx, sy) =>
    ring(hud, sx + swatch / 2, sy + swatch / 2, swatch * 0.3, PALETTE.trace),
  );
  entry("ATTACK INBOUND", (sx, sy) =>
    ring(hud, sx + swatch / 2, sy + swatch / 2, swatch * 0.46, CONTROL_COLOR.theirs),
  );
  entry("THREAT / YIELD", (sx, sy) => {
    hud.segments([sx + 2, sy, sx + 2, sy + 5, sx + 6, sy, sx + 6, sy + 5], PALETTE.trace);
    hud.segments(
      [sx + 2, sy + swatch, sx + 2, sy + swatch - 5, sx + 6, sy + swatch, sx + 6, sy + swatch - 5],
      PALETTE.traceDim,
    );
  });
}

/** A palette entry at a given brightness, without disturbing the shared scratch. */
function scaled(color: Color, amount: number): Color {
  return LEGEND_SCRATCH.copy(color).multiplyScalar(amount);
}
const LEGEND_SCRATCH = new Color();

function drawSectorReadout(
  hud: Hud,
  campaign: Campaign,
  cursor: number,
  x: number,
  y: number,
): void {
  const sector = campaign.sectors[cursor];
  const color = CONTROL_COLOR[sector.control];

  hud.text(`SECTOR ${sectorName(cursor)}`, x, y, 2.2, color);
  hud.text(
    `THREAT ${sector.threat}   YIELD ${sector.yield}   SALVAGE X${1 + sector.yield}`,
    x + 120,
    y,
    1.7,
    PALETTE.traceDim,
  );

  const held: string[] = sector.structures.map((structure) =>
    structure.runsRemaining === 0
      ? structureSpec(structure.kind).label
      : `${structureSpec(structure.kind).label} ${structure.runsRemaining}`,
  );
  if (sector.patrol) held.push(`PATROL ${sector.patrol.strength}`);
  if (cursor === campaign.front) held.push("DROP POINT");
  hud.text(held.length ? held.join("   ") : "EMPTY SPACE", x, y - 22, 1.6, PALETTE.traceDim);
}

function drawReport(
  hud: Hud,
  campaign: Campaign,
  frame: CommandFrame,
  cx: number,
  left: number,
  right: number,
  over: boolean,
): void {
  const report = frame.report;
  if (report) {
    const moves = report.actions.filter((a) => a.kind !== "consolidate").length;
    const dug = report.actions.length - moves;
    const parts = [`ENEMY MOVED ON ${moves}`, `DUG IN ${dug}`];
    if (report.completed.length) parts.push(`${report.completed.length} BUILT`);
    if (report.patrolsLost) parts.push(`${report.patrolsLost} PATROL LOST`);
    if (report.patrolsRebuilt) parts.push(`${report.patrolsRebuilt} PATROL REBUILT`);
    hud.text(parts.join("   "), left, 152, 1.6, PALETTE.amber);
  }

  hud.textRight(
    `PATROLS ${patrolCount(campaign)} OF ${patrolCapacity(campaign)}   ${loadoutSummary(campaign)}`,
    right,
    152,
    1.6,
    PALETTE.traceDim,
  );

  if (frame.message) centred(hud, frame.message, cx, 116, 2, PALETTE.trace);

  // The controls were here all along, dim and small, and the first player to
  // reach this screen still could not tell how to choose anything. Keys are
  // bright and their meanings stay quiet, so the row reads as a keyboard
  // rather than as a sentence.
  const keys: [string, string][] = [
    ["W/S", "CHOOSE"],
    ["SPACE", "BUY"],
    ["ARROWS", "SECTOR"],
  ];
  let keyX = cx - 210;
  for (const [key, meaning] of keys) {
    keyX += hud.text(key, keyX, 74, 2, PALETTE.amber) + 8;
    keyX += hud.text(meaning, keyX, 74, 2, PALETTE.traceDim) + 26;
  }
  if (blink(frame.time)) {
    centred(hud, over ? "ENTER FOR A NEW WAR" : "ENTER TO LAUNCH", cx, 44, 2.6, PALETTE.amber);
  }
}

// ── shared primitives ───────────────────────────────────────────────────────

/**
 * The HUD has no opacity channel — every stroke's brightness is its colour,
 * which is also how the death sequence browns the whole panel out. Fading is
 * therefore scaling, not blending.
 */
function fade(color: Color, opacity: number): Color {
  return SCRATCH.copy(color).multiplyScalar(opacity);
}
const SCRATCH = new Color();

/** The HUD draws segments; a circle is a closed polygon of them. */
function ring(hud: Hud, cx: number, cy: number, radius: number, color: Color): void {
  const SIDES = 12;
  const flat: number[] = [];
  for (let i = 0; i < SIDES; i++) {
    const a = (i / SIDES) * Math.PI * 2;
    const b = ((i + 1) / SIDES) * Math.PI * 2;
    flat.push(
      cx + Math.cos(a) * radius, cy + Math.sin(a) * radius,
      cx + Math.cos(b) * radius, cy + Math.sin(b) * radius,
    );
  }
  hud.segments(flat, color);
}

/** Glyph advance is 4.2 units per character at scale 1 — see `strokeFont.ts`. */
function centred(hud: Hud, text: string, cx: number, y: number, scale: number, color: Color): void {
  hud.text(text, cx - (text.length * 4.2 * scale) / 2, y, scale, color);
}

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

function pad(value: number, width: number): string {
  return Math.max(0, Math.round(value)).toString().padStart(width, "0");
}
