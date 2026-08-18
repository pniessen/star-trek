import { Color } from "three";
import { PALETTE } from "../render/palette.js";
import { BLOCKS, baselineOf, moved, movedKnobs, type Tuner } from "../game/tuning.js";
import type { Hud } from "./Hud.js";

/**
 * The tuning console, drawn.
 *
 * Same rule as every other glyph in this game: no DOM text over the scene, so
 * this is strokes through the same bloom as the ships. That is not ceremony
 * even for a dev instrument — a panel drawn in HTML would be sharp, unbloomed
 * and correctly aligned in a way nothing else on screen is, and half of what is
 * being tuned here (`HIT_STOP`, the sweep rate, the Loom's rise) is judged by
 * how it reads *through* the post chain. An overlay that sits outside the chain
 * would be lying about the thing it is measuring.
 *
 * Composed in the right-hand column between the control legend and the score:
 * the widest reliably clear strip on the panel. It will sit over the lead pip
 * and the escort tag, and that is accepted rather than worked around — this is
 * a tool the player turns on, and it goes away with the same key.
 */

const WIDTH = 352;
const ROW = 26;
const TRACK = 110;

const highlight = PALETTE.trace;
const quiet = PALETTE.traceDim;
const changed = PALETTE.amber;
const track = new Color().copy(PALETTE.traceDim).multiplyScalar(0.7);

/**
 * Where a value sits in its own range, 0→1.
 *
 * Linear, deliberately, even for the drains — which span 0 to 0.12 and spend
 * most of their interesting territory in the bottom quarter. A log track would
 * read better for those four knobs and worse for the other forty, and a mixed
 * convention is a track you have to remember the rules of. The number itself is
 * printed beside the bar and is the thing being tuned; the bar is only there to
 * say "near the bottom of what this is allowed to be".
 */
function fraction(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

export function drawTuning(hud: Hud, tuner: Tuner): void {
  const { width, height } = hud.size;
  const block = BLOCKS[tuner.block];
  const x0 = width - 34 - WIDTH;
  const right = width - 34;
  // The title's baseline. Everything below is measured down from it, so a page
  // of four knobs and a page of ten are the same panel with a different amount
  // of middle rather than two layouts that have to be kept in step.
  const top = height - 122;
  const footer = top - 30 - block.knobs.length * ROW;
  const legend = footer - 48;

  hud.brackets(x0, legend - 12, WIDTH, top + 26 - (legend - 12), 12, quiet);

  // The page, and which page of how many. `/` is the only way through them, so
  // the count is the whole navigation aid the header needs to be.
  hud.text(block.title, x0 + 14, top, 2.2, highlight);
  hud.textRight(`${tuner.block + 1}/${BLOCKS.length}`, right - 14, top, 1.6, quiet);

  block.knobs.forEach((knob, index) => {
    const y = top - 30 - index * ROW;
    const selected = index === tuner.row;
    const off = moved(knob);
    const label = selected ? highlight : quiet;
    const value = off ? changed : selected ? highlight : quiet;

    if (selected) hud.text(">", x0 + 4, y, 1.6, highlight);
    hud.text(knob.label, x0 + 16, y, 1.6, label);

    // The track, with two marks on it: where the number is now, and — once the
    // two differ — where the file still says it should be. Seeing the original
    // position is what makes "I have gone too far" a thing you can see rather
    // than a thing you have to remember.
    const tx = x0 + 150;
    const bar: number[] = [tx, y + 4, tx + TRACK, y + 4];
    const at = tx + fraction(knob.read(), knob.min, knob.max) * TRACK;
    hud.segments(bar, track);
    hud.segments([at, y - 1, at, y + 9], value);
    if (off) {
      const was = tx + fraction(baselineOf(knob), knob.min, knob.max) * TRACK;
      hud.segments([was, y + 1, was, y + 7], quiet);
    }

    hud.textRight(knob.read().toFixed(knob.decimals), right - 14, y, 1.8, value);
  });

  // One line on why this particular number is worth an evening. The console's
  // list is long enough that "what am I even looking for here" is a real
  // question, and the answer belongs beside the knob rather than in a document
  // nobody has open while flying.
  hud.text(tuner.current.question, x0 + 14, footer - 4, 1.4, quiet);

  const count = movedKnobs().length;
  if (tuner.notice) {
    hud.text(tuner.notice, x0 + 14, footer - 26, 1.6, changed);
  } else if (count > 0) {
    hud.text(`${count} CHANGED   \\ COPY PATCH`, x0 + 14, footer - 26, 1.6, changed);
  } else {
    hud.text("NOTHING MOVED", x0 + 14, footer - 26, 1.6, quiet);
  }

  hud.text(", .  PICK    ; '  VALUE    /  PAGE    0  RESET    ` CLOSE", x0 + 14, legend, 1.4, quiet);
}
