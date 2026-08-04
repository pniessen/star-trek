import { Color } from "three";
import { PALETTE } from "../render/palette.js";
import { CRAWL_SCALE, type Briefing, type CrawlTone } from "../game/briefing.js";
import { GLYPH_ADVANCE } from "./strokeFont.js";
import type { Hud } from "./Hud.js";

/**
 * The opening log, drawn.
 *
 * Kept out of `draw.ts` for the same reason the scanner is: that file is the
 * panel's layout, and a full-screen document that owns the whole frame is not
 * part of a layout. What it does share with everything else is the vocabulary —
 * stroke glyphs, the same bloom, brackets around the frame, and no colour that
 * is not already carrying information.
 *
 * There is no opacity in `Hud` and no clip, so the band the log reads inside is
 * made by scaling each line's colour toward black at both ends of it. Against an
 * additive buffer that is a clip, and it is the same trick the arrival card's
 * fade and the chart overlay's opacity both already use.
 */

const TONE_COLOR: Record<CrawlTone, Color> = {
  head: PALETTE.trace,
  body: PALETTE.trace,
  note: PALETTE.traceDim,
  // The one colour on the panel that means "act on this". Used once, on the
  // sentence the whole greed loop hangs off.
  flag: PALETTE.amber,
};

const scratch = new Color();

function centred(hud: Hud, text: string, cx: number, y: number, scale: number, color: Color): void {
  hud.text(text, cx - (text.length * GLYPH_ADVANCE * scale) / 2, y, scale, color);
}

/** @param time real seconds, for the blinking prompt — the same clock as the title's. */
export function drawBriefing(
  hud: Hud,
  briefing: Briefing,
  time: number,
  width: number,
  height: number,
): void {
  const cx = width / 2;

  hud.brackets(18, 18, width - 36, height - 36, 22, PALETTE.traceDim);

  for (const line of briefing.lines) {
    if (!line.text) continue;
    const y = briefing.yOf(line);
    const level = briefing.levelAt(y);
    if (level <= 0.01) continue;
    const scale = CRAWL_SCALE[line.tone];
    scratch.copy(TONE_COLOR[line.tone]).multiplyScalar(level);
    centred(hud, line.text, cx, y, scale, scratch);
  }

  // Says outright that the log is skippable, in the same blink and the same
  // amber the title screen uses to say the cabinet is waiting for you. A crawl
  // whose escape hatch is undocumented is a crawl the player sits through once
  // and resents twice.
  if (Math.sin(time * 3.4) > -0.35) {
    centred(hud, "ANY KEY   LAUNCH", cx, 40, 2.2, PALETTE.amber);
  }

  void height;
}
