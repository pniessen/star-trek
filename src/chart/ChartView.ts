import { Color } from "three";
import { PALETTE } from "../render/palette.js";
import type { Hud } from "../hud/Hud.js";
import { GLYPH_ADVANCE } from "../hud/strokeFont.js";
import { colOf, rowOf, GRID } from "./sectors.js";
import { canDock, countControl, isLost, isWon, type Campaign, type Control } from "./campaign.js";
import { commanderOf } from "./commander.js";
import { DECISIONS, HEADINGS, intent, loadoutSummary, refusal, sectorCode } from "./command.js";
import { RESERVE, reserveOf } from "./enemyTurn.js";
import { isFitted, patrolCount, structureSpec, type RefitId, type RunReport } from "./economy.js";
import { regionName, stationName } from "./naming.js";
import { jumpCharge, jumpEnergy, jumpReach, jumpSteps } from "./jump.js";

/** Laid out in the HUD's fixed 800-unit design space, like everything else. */
export const CHART = {
  /**
   * Smaller than it was. The overlay now carries a readout, a jump price, a
   * key and a control line beneath the grid, and all of that has to clear the
   * shield cluster at the bottom of the panel — an overlay that lands on the
   * instrument telling you which quarter is about to fail is worse than one
   * that is slightly harder to count squares on.
   */
  size: 340,
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
export const CONTROL_COLOR: Record<Control, Color> = {
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
 * What the in-run overlay needs from the run behind it. Only the reserve and
 * the drain rate come from the ship: `src/chart/` must not depend on
 * `src/game/`, so the one combat constant a jump is priced in is passed rather
 * than imported.
 */
export interface ChartFrame {
  /** 0-1, eased in `main.ts` while Tab is held. */
  readonly opacity: number;
  readonly cursor: number;
  /** Real seconds, for the cursor's pulse. Time-based, not frame-based. */
  readonly time: number;
  /** The energy reserve, 0-1. What a jump has to be paid out of. */
  readonly reserve: number;
  /** `HYPERWARP.drainPerSecond`. */
  readonly drainPerSecond: number;
}

/**
 * The tactical overlay: the same map, faded over a run that is still moving.
 *
 * Everything below the grid is here because the overlay does not pause the
 * game, which makes every second spent deciphering it a second of being shot
 * at. A player who could not tell what the ring in a square meant was reading
 * a map with no key, no readout and no statement of what a jump would cost —
 * so the map now carries all three, and the cursor is drawn with rules running
 * out to the edges of the grid because "the cursor gets lost" is not a
 * brightness problem.
 */
export function drawChart(hud: Hud, campaign: Campaign, frame: ChartFrame): void {
  const { opacity, cursor } = frame;
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
  const { width } = hud.size;
  const originX = width / 2 - CHART.size / 2;
  // Sat well above centre so the readout, the price of a jump, the key and the
  // control line all fit between the grid and the shield cluster, which owns
  // everything below y=130 at every window size.
  const originY = 300;
  drawGrid(hud, campaign, {
    originX,
    originY,
    cell: CHART.size / GRID,
    opacity,
    cursor,
    time: frame.time,
    // Structures and patrols are shown in flight now. They were the reason to
    // prefer one square over another and they were only ever drawn between
    // runs, which is most of why the sectors read as interchangeable.
    holdings: true,
  });

  let y = originY - 26;
  hud.text(
    sectorHeadline(campaign, cursor),
    originX,
    y,
    2.2,
    fade(CONTROL_COLOR[campaign.sectors[cursor].control], opacity),
  );
  y -= 21;
  hud.text(sectorFacts(campaign, cursor), originX, y, 1.5, fade(PALETTE.traceDim, opacity));

  const flags = sectorFlags(campaign, cursor);
  if (flags) {
    y -= 18;
    hud.text(flags, originX, y, 1.5, fade(PALETTE.amber, opacity));
  }

  y -= 18;
  drawJumpLine(hud, campaign, frame, originX, y);

  // The key is allowed to run wider than the grid — it wraps to two rows at
  // this width rather than three, and a third row is what pushes the control
  // line into the shield cluster on a short window.
  y -= 22;
  y = drawLegend(hud, originX, y, CHART.size + 150, opacity);

  // The controls, beside the thing they drive rather than in a corner.
  //
  // `WASD PICK SECTOR` is worded identically to the command view's caption on
  // purpose: it is the same map and the same key group doing the same job, and
  // saying it two different ways is how a player ends up believing they are two
  // different things. The arrows keep flying, which is what makes reading the
  // chart mid-fight possible at all.
  let keyX = originX;
  for (const [key, meaning] of [
    ["WASD", "PICK SECTOR"],
    ["SHIFT", "JUMP THERE"],
    ["ARROWS", "STILL FLY"],
  ] as const) {
    keyX += hud.text(key, keyX, y - 26, 1.6, fade(PALETTE.amber, opacity)) + 6;
    keyX += hud.text(meaning, keyX, y - 26, 1.6, fade(PALETTE.traceDim, opacity)) + 18;
  }
}

/**
 * The answer to "how hard is a long warp", which until now was "it isn't".
 *
 * Distance sets the charge — see `chart/jump.ts` — so this states the two
 * things that follow from it: how long the guns are cold, and whether the
 * reserve covers the jump at all. Out of reach is drawn as a refusal rather
 * than left to be discovered when the charge dies halfway.
 */
function drawJumpLine(
  hud: Hud,
  campaign: Campaign,
  frame: ChartFrame,
  x: number,
  y: number,
): void {
  const { cursor, opacity, reserve, drainPerSecond } = frame;
  const steps = jumpSteps(campaign.current, cursor);
  if (steps === 0) {
    hud.text("YOU ARE HERE", x, y, 1.6, fade(PALETTE.trace, opacity));
    return;
  }

  const seconds = jumpCharge(campaign.current, cursor);
  const cost = jumpEnergy(campaign.current, cursor, drainPerSecond);
  const short = cost > reserve;
  const line =
    `JUMP ${steps}   GUNS COLD ${seconds.toFixed(1)}S   COSTS ${Math.round(cost * 100)}% RESERVE`;
  const tail = short ? `   OUT OF REACH  ${jumpReach(reserve, drainPerSecond)} MAX` : "";
  hud.text(line + tail, x, y, 1.6, fade(short ? PALETTE.amber : PALETTE.traceDim, opacity));
}

// ── what is in a sector, in words ───────────────────────────────────────────
//
// Shared by the in-run overlay, the command view and the arrival card, for the
// same reason `drawGrid` is shared: three descriptions of one sector is three
// chances for them to disagree about what a ring means.

/** e.g. "C4  PELLAS REACH". The place, not the coordinate. */
export function sectorHeadline(campaign: Campaign, index: number): string {
  return `${sectorCode(index)}  ${regionName(campaign.seed, index)}`;
}

/** The three facts that change what happens when you go there. */
export function sectorFacts(campaign: Campaign, index: number): string {
  const sector = campaign.sectors[index];
  return [
    `THREAT ${sector.threat}`,
    `PAYS X${1 + sector.yield}`,
    // The ring in the square, said in words. This is the mark a player could
    // not read and the single most decision-relevant one on the map: it is
    // where a multiplier can be turned into salvage.
    canDock(sector) ? `BANK AT ${stationName(campaign.seed, index)}` : "NO DOCK HERE",
  ].join("   ");
}

/** Whatever is true of a sector and worth acting on. Empty when nothing is. */
export function sectorFlags(campaign: Campaign, index: number): string {
  const sector = campaign.sectors[index];
  const flags: string[] = [];
  if (campaign.incoming.some((move) => move.sector === index)) {
    flags.push("ATTACK INBOUND  CLEAR IT TO BREAK IT");
  }
  // The only thing in the game that moves a sector back toward you, and it
  // happens by flying there — so the sector that can be taken should say so.
  if (sector.control !== "ours") {
    flags.push(`${sector.control === "theirs" ? "THEIRS" : "CONTESTED"}  CLEAR IT TO TAKE IT`);
  }
  if (sector.patrol) flags.push(`PATROL ${sector.patrol.strength}`);
  const building = sector.structures.filter((structure) => structure.runsRemaining > 0).length;
  if (building) flags.push(`${building} BUILDING`);
  return flags.join("   ");
}

interface GridPlacement {
  readonly originX: number;
  readonly originY: number;
  readonly cell: number;
  readonly opacity: number;
  readonly cursor: number;
  /** Real seconds. The cursor pulses, so it needs a clock rather than a frame count. */
  readonly time: number;
  /** Structures, patrols and the chosen front. */
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
  const span = cell * GRID;

  // Rules running the full width and height of the grid through the cursor's
  // cell, drawn under everything else.
  //
  // This is the fix for "the cursor gets lost", and it is a fix in *kind*
  // rather than in degree: a brighter box is still a box you have to find by
  // scanning sixty-four of them, whereas two lines crossing the whole map are
  // found by peripheral vision alone. The same reason a spreadsheet highlights
  // the row and the column and not only the cell.
  const cursorX = originX + colOf(cursor) * cell;
  const cursorY = originY + (GRID - 1 - rowOf(cursor)) * cell;
  hud.segments(
    [
      originX, cursorY + cell / 2, originX + span, cursorY + cell / 2,
      cursorX + cell / 2, originY, cursorX + cell / 2, originY + span,
    ],
    fade(PALETTE.amber, opacity * 0.3),
  );

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
      // Pulsed, on real seconds. A mark that moves is found before a mark that
      // is merely bright, and the whole complaint about this cursor was that it
      // could not be found.
      const pulse = opacity * (0.78 + 0.22 * Math.sin(place.time * 4.2));
      hud.rect(x, y, cell, cell, fade(PALETTE.amber, pulse));
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

const ROW_HEIGHT = 24;
/** Space above a section label, so the label belongs to what follows it. */
const HEADING_LEAD = 8;
/** The selected row's own sub-lines: what Space does, and why it would not. */
const SUB_LINE = 17;
const COLUMN = { chart: 0, options: 430, width: 940 } as const;

/**
 * Baselines below both columns. Low enough that the map's key can wrap to a
 * third row without the enemy's report landing on top of it — which it did,
 * because the key grew and the footer did not move.
 */
const FOOTER = { report: 118, message: 92 } as const;

/**
 * The command view: the same map, zoomed to fill, with the four decisions
 * beside it.
 *
 * Everything is on this one screen because `strategy-layer.md` makes that a
 * rule rather than a preference — four decisions per visit, no submenus, and
 * if a chart visit takes longer than a run the layer has failed. The list
 * reads top to bottom as the sentence the design states: spend, equip,
 * position, go.
 *
 * The list stays flat, and that survived a second look. A player who could not
 * work out how to pick an action was, on the face of it, arguing for a
 * two-step selection — choose BUILD, then choose which structure — but that is
 * a submenu, which the design forbids by name. What had actually failed was
 * labelling: two cursors that never said they were two cursors, four section
 * headings drawn like a menu bar you could select, and the keys explained in a
 * footer forty units from anything they operate. So the fix is entirely in
 * where things are said and where they are said *from*:
 *
 * - Each cursor carries its own key caption directly above the thing it moves
 *   over: `ARROWS PICK SECTOR` above the map, `W/S PICK ACTION` above the list.
 * - The selected row states, on its own next line, exactly what `Space` will
 *   do and to which sector — resolved before the key is pressed, not after.
 * - The headings hang out in the left margin under a rule, small and dim, so
 *   nothing about them offers itself to a keypress.
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

  drawReserveBar(hud, campaign, right, height - 138);

  const optionsX = left + COLUMN.options;
  const costX = right;

  // ── the two cursors, each captioned where it lives ──
  // Side by side on one baseline, so the very first thing the screen says is
  // that there are two of these and which keys drive which.
  const captionY = height - 152;
  // WASD on the grid, on both screens — see `handleCommandKey` in `main.ts` for
  // why that rule has no exceptions. The list takes the other pair.
  roleCaption(hud, left + COLUMN.chart, captionY, "WASD", "PICK SECTOR", "sector");
  roleCaption(hud, optionsX, captionY, "UP/DOWN", "PICK ACTION", "list");

  // ── the map ──
  const chartY = captionY - 6 - CHART.commandSize;
  drawGrid(hud, campaign, {
    originX: left + COLUMN.chart,
    originY: chartY,
    cell,
    opacity: 1,
    cursor: frame.cursor,
    time: frame.time,
    holdings: true,
  });

  const legendY = drawSectorReadout(hud, campaign, frame.cursor, left, chartY - 26);
  drawLegend(hud, left + COLUMN.chart, legendY, CHART.commandSize, 1);

  // ── the four decisions ──
  let y = captionY - 28;
  let previous: string | null = null;

  DECISIONS.forEach((decision, index) => {
    if (decision.kind !== previous) {
      previous = decision.kind;
      y -= HEADING_LEAD;
      // Hung out into the left margin, small, dim, and underlined across the
      // whole column. Drawn as a row it read as a menu bar — the four words a
      // player named as the thing they could not work out how to select — and
      // it is not one: it is a label for the rows beneath it.
      hud.textRight(HEADINGS[decision.kind], optionsX - 12, y + 2, 1.4, PALETTE.traceDim);
      hud.segments([optionsX, y + 4, costX + 20, y + 4], scaled(PALETTE.traceDim, 0.45));
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
      const said = intent(campaign, decision, frame.cursor);
      y -= SUB_LINE;
      // `SPACE` is a key, so it is amber like every other key on this screen,
      // and the sentence after it names the sector under the *other* cursor.
      // That is the sentence the whole screen was missing.
      const keyEnd = hud.text("SPACE", optionsX + 8, y, 1.5, PALETTE.amber);
      hud.text(
        said.line,
        optionsX + 8 + keyEnd + 10,
        y,
        1.5,
        said.refused ? PALETTE.traceDim : PALETTE.trace,
      );
      y -= SUB_LINE;
      // Refused rows say why *before* the key is pressed. `refusal()` has
      // always returned a line rather than a boolean; it was only ever wired
      // to the after-the-fact message, so the screen taught by failure alone.
      hud.text(
        said.refused ?? decision.detail,
        optionsX + 8,
        y,
        1.5,
        said.refused ? PALETTE.amber : PALETTE.traceDim,
      );
    }
    y -= ROW_HEIGHT;
  });

  // ── the footer: what just happened, and the one key not tied to a cursor ──
  drawReport(hud, campaign, frame, cx, left, right, over);
}

/**
 * A key and what it moves, drawn immediately above the thing it moves over,
 * with a glyph of the key's own shape.
 *
 * A hint that is not beside the thing it explains is a hint nobody reads —
 * which is what happened to the footer row this replaces. "CHOOSE" also did
 * not say choose *what*: naming the two targets is what distinguishes the two
 * cursors from each other, and that was the thing that was unclear.
 */
function roleCaption(
  hud: Hud,
  x: number,
  y: number,
  key: string,
  meaning: string,
  glyph: "sector" | "list",
): void {
  const marks: number[] =
    glyph === "sector"
      ? // A four-way: this cursor moves over a plane.
        [x, y + 4, x + 12, y + 4, x + 6, y - 2, x + 6, y + 10,
         x, y + 4, x + 3, y + 7, x, y + 4, x + 3, y + 1,
         x + 12, y + 4, x + 9, y + 7, x + 12, y + 4, x + 9, y + 1]
      : // A double-ended vertical: this one moves up and down a list.
        [x + 6, y - 2, x + 6, y + 10,
         x + 6, y + 10, x + 3, y + 7, x + 6, y + 10, x + 9, y + 7,
         x + 6, y - 2, x + 3, y + 1, x + 6, y - 2, x + 9, y + 1];
  hud.segments(marks, PALETTE.amber);
  const keyEnd = hud.text(key, x + 20, y, 1.8, PALETTE.amber);
  hud.text(meaning, x + 20 + keyEnd + 10, y, 1.8, PALETTE.traceDim);
}

/**
 * What the marks on the map mean, drawn as the marks themselves.
 *
 * Every symbol here was already on the chart and none of them said what they
 * were. A key costs two rows and is the difference between a map you can read
 * at a glance and one you have to be told about — and being told about it is
 * exactly what happened.
 */
function drawLegend(hud: Hud, x: number, y: number, width: number, opacity: number): number {
  const swatch = 13;
  let cursorX = x;
  // Its own object rather than the shared scratch: this one is held across
  // every entry below, and `fade` is called in between by the swatches.
  const dim = PALETTE.traceDim.clone().multiplyScalar(opacity);

  const entry = (label: string, draw: (sx: number, sy: number) => void): void => {
    // Wrap to a second row rather than running off the map's right edge.
    if (cursorX + swatch + 10 + label.length * GLYPH_ADVANCE * 1.4 > x + width) {
      cursorX = x;
      y -= 18;
    }
    draw(cursorX, y);
    cursorX += swatch + 5;
    cursorX += hud.text(label, cursorX, y + 3, 1.4, dim) + 16;
  };

  entry("YOU", (sx, sy) => {
    fillCell(hud, sx, sy, swatch, swatch, fade(PALETTE.trace, opacity * 0.55));
    hud.rect(sx, sy, swatch, swatch, fade(PALETTE.trace, opacity));
  });
  entry("CURSOR", (sx, sy) => hud.rect(sx, sy, swatch, swatch, fade(PALETTE.amber, opacity)));
  entry("OURS", (sx, sy) =>
    hud.rect(sx, sy, swatch, swatch, fade(CONTROL_COLOR.ours, opacity)),
  );
  entry("CONTESTED", (sx, sy) =>
    hud.rect(sx, sy, swatch, swatch, fade(CONTROL_COLOR.contested, opacity)),
  );
  entry("THEIRS", (sx, sy) =>
    hud.rect(sx, sy, swatch, swatch, fade(CONTROL_COLOR.theirs, opacity)),
  );
  // Named for what it is *for*, not for what it is. "DOCK" was already on the
  // key and a player still could not say what the ring in a square meant; the
  // multiplier is the currency, so the ring is where the currency is realised.
  entry("BANK HERE", (sx, sy) =>
    ring(hud, sx + swatch / 2, sy + swatch / 2, swatch * 0.3, fade(PALETTE.trace, opacity)),
  );
  entry("ATTACK INBOUND", (sx, sy) =>
    ring(
      hud,
      sx + swatch / 2,
      sy + swatch / 2,
      swatch * 0.46,
      fade(CONTROL_COLOR.theirs, opacity),
    ),
  );
  entry("THREAT / YIELD", (sx, sy) => {
    hud.segments(
      [sx + 2, sy, sx + 2, sy + 5, sx + 6, sy, sx + 6, sy + 5],
      fade(PALETTE.trace, opacity),
    );
    hud.segments(
      [sx + 2, sy + swatch, sx + 2, sy + swatch - 5, sx + 6, sy + swatch, sx + 6, sy + swatch - 5],
      dim,
    );
  });
  entry("STRUCTURE / PATROL", (sx, sy) => {
    hud.segments([sx + 8, sy + 4, sx + 13, sy + 4], fade(PALETTE.trace, opacity));
    hud.segments([sx, sy + 9, sx + 5, sy + 9], fade(PALETTE.magenta, opacity));
  });
  // However many rows it wrapped to, so whatever follows never has to guess.
  return y;
}

/** A palette entry at a given brightness, without disturbing the shared scratch. */
function scaled(color: Color, amount: number): Color {
  return LEGEND_SCRATCH.copy(color).multiplyScalar(amount);
}
const LEGEND_SCRATCH = new Color();

/**
 * Everything under the map's cursor, in words. Returns the baseline it
 * finished on, so the legend below never has to guess how many lines a
 * particular sector happened to need.
 */
function drawSectorReadout(
  hud: Hud,
  campaign: Campaign,
  cursor: number,
  x: number,
  y: number,
): number {
  const sector = campaign.sectors[cursor];

  hud.text(sectorHeadline(campaign, cursor), x, y, 2.2, CONTROL_COLOR[sector.control]);
  y -= 21;
  hud.text(sectorFacts(campaign, cursor), x, y, 1.6, PALETTE.traceDim);

  const held: string[] = sector.structures.map((structure) =>
    structure.runsRemaining === 0
      ? structureSpec(structure.kind).label
      : `${structureSpec(structure.kind).label} ${structure.runsRemaining}`,
  );
  if (sector.patrol) held.push(`PATROL ${sector.patrol.strength}`);
  if (cursor === campaign.front) held.push("DROP POINT");
  y -= 19;
  hud.text(held.length ? held.join("   ") : "EMPTY SPACE", x, y, 1.6, PALETTE.traceDim);

  const flags = sectorFlags(campaign, cursor);
  if (flags) {
    y -= 19;
    hud.text(flags, x, y, 1.6, PALETTE.amber);
  }
  return y - 26;
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
    hud.text(parts.join("   "), left, FOOTER.report, 1.6, PALETTE.amber);
  }

  hud.textRight(
    `PATROLS ${patrolCount(campaign)} IN THE FIELD   ${loadoutSummary(campaign)}`,
    right,
    FOOTER.report,
    1.6,
    PALETTE.traceDim,
  );

  if (frame.message) centred(hud, frame.message, cx, FOOTER.message, 2, PALETTE.trace);

  // The only key left down here, and the only one that belongs down here:
  // ARROWS, W/S and SPACE are all captioned beside the cursor or the row they
  // drive, because a hint that is not beside the thing it explains is a hint
  // nobody reads. ENTER is not tied to either cursor — it leaves the screen —
  // so the bottom of the screen is exactly where it belongs.
  if (blink(frame.time)) {
    centred(hud, over ? "ENTER FOR A NEW WAR" : "ENTER TO LAUNCH", cx, 52, 2.6, PALETTE.amber);
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

/**
 * The war has a face and a stock: the commander's surname, and ten ticks for
 * how much of `RESERVE.max` the invasion has left to spend. Right-aligned to
 * the same edge as the HELD/THEIRS line above it, because both are read the
 * same way — glance right, read the state of the enemy.
 *
 * Ticks rather than the stroke font's block glyphs: the font has none (see
 * the brief), so the bar is drawn the way every other gauge on this screen
 * is, with `hud.segments`. Amber is reused for "theirs" exactly as
 * `CONTROL_COLOR.theirs` already does; it never pulses, because a wartime
 * dashboard the player checks between runs is a report, not an alarm.
 */
function drawReserveBar(hud: Hud, campaign: Campaign, right: number, y: number): void {
  const surname = commanderOf(campaign.seed).surname;
  const ticks = 10;
  const gap = 10;
  const tickHeight = 8; // matches GLYPH_HEIGHT (5) at the label's own scale (1.6)
  const barLeft = right - (ticks - 1) * gap;
  const fill = Math.max(0, Math.min(ticks, Math.round((reserveOf(campaign) / RESERVE.max) * ticks)));

  hud.textRight(surname, barLeft - 14, y, 1.6, PALETTE.traceDim);

  const filled: number[] = [];
  const empty: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const x = barLeft + i * gap;
    (i < fill ? filled : empty).push(x, y, x, y + tickHeight);
  }
  hud.segments(filled, PALETTE.amber);
  hud.segments(empty, PALETTE.traceDim);
}

/** Slow enough to read as a cursor rather than a fault. Time-based, not frame-based. */
function blink(time: number): boolean {
  return Math.sin(time * 3.4) > -0.35;
}

function pad(value: number, width: number): string {
  return Math.max(0, Math.round(value)).toString().padStart(width, "0");
}
