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

/**
 * How long the log has the screen to itself before the escape hatches are
 * offered. Long enough that the head and the sector under it have been read —
 * a hint that arrives with the first line is a hint that arrives before there
 * is anything to skip.
 */
const HINT_DELAY = 2.4;

export function drawBriefing(hud: Hud, briefing: Briefing, width: number, height: number): void {
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

  // The two ways out, offered once there is something to leave.
  //
  // This line used to read "ANY KEY   LAUNCH", in blinking amber, and it was
  // the only thing on screen for the first second and a half of the log — a
  // blinking order to press a key, in front of a briefing a key destroys.
  // Three things changed and each one is the same correction: it waits until
  // the log has said something, it states a permission rather than an
  // instruction, and it is dim and still. Amber on this panel means *act on
  // this*, and a hint you are free to ignore is the opposite of that; blinking
  // is how the title screen says the cabinet is waiting for you, which is
  // exactly the wrong thing to say while the ship is talking.
  if (briefing.elapsed >= HINT_DELAY) {
    centred(hud, "ANY KEY SKIPS   L STOPS IT PLAYING", cx, 40, 1.9, PALETTE.traceDim);
  }

  void height;
}
