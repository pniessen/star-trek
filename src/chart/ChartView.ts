import { Color } from "three";
import { PALETTE } from "../render/palette.js";
import type { Hud } from "../hud/Hud.js";
import { colOf, rowOf, GRID } from "./sectors.js";
import { canDock, type Campaign, type Control } from "./campaign.js";

/** Laid out in the HUD's fixed 800-unit design space, like everything else. */
export const CHART = {
  size: 460,
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
  const cell = CHART.size / GRID;
  const originX = width / 2 - CHART.size / 2;
  const originY = height / 2 - CHART.size / 2;

  for (let i = 0; i < campaign.sectors.length; i++) {
    const sector = campaign.sectors[i];
    const x = originX + colOf(i) * cell;
    const y = originY + rowOf(i) * cell;
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

    // Where you are, versus where you are pointing. Two different marks:
    // confusing them is how a player jumps somewhere they did not mean to.
    if (i === campaign.current) {
      ring(hud, x + cell / 2, y + cell / 2, cell * 0.42, fade(PALETTE.trace, opacity));
    }
    if (i === cursor) {
      hud.rect(x, y, cell, cell, fade(PALETTE.trace, opacity));
    }
  }
}

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
