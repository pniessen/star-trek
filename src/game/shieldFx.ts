import type { TraceBuffer } from "../render/TraceBuffer.js";
import { PALETTE } from "../render/palette.js";
import { BRACE, type Ship, type ShieldFacing } from "./Ship.js";

/**
 * Bearing offset of each quarter's centre from the ship's heading, mirroring
 * `Ship.facingFrom` exactly rather than reinventing the convention.
 *
 * `facingFrom` computes `relative = atan2(toSource.x, toSource.z) - heading`
 * and then buckets `relative` into quarters centred on 0 ("fore"), +90°
 * ("starboard"), 180° ("aft") and -90° ("port") — e.g. a source dead ahead
 * (along the ship's own `forward()`) gives `relative = 0` and resolves to
 * "fore"; a source at `relative = +PI/2` resolves to "starboard". A world
 * bearing of `heading + relative` is drawn with `forward()`'s own convention,
 * `(sin(angle), cos(angle))`, so `arc` below reuses that same convention for
 * `centre = player.heading + FACING_OFFSET[facing]`.
 */
const FACING_OFFSET: Record<ShieldFacing, number> = {
  fore: 0,
  starboard: Math.PI / 2,
  aft: Math.PI,
  port: -Math.PI / 2,
};

const RADIUS = 4.6;
const SEGMENTS = 10; // per 90° arc
const HALF = Math.PI / 4; // arc half-width

function arc(trace: TraceBuffer, player: Ship, facing: ShieldFacing, intensity: number): void {
  const centre = player.heading + FACING_OFFSET[facing];
  for (let i = 0; i < SEGMENTS; i++) {
    const a = centre - HALF + (i / SEGMENTS) * HALF * 2;
    const b = centre - HALF + ((i + 1) / SEGMENTS) * HALF * 2;
    trace.push(
      player.position.x + Math.sin(a) * RADIUS,
      player.position.y,
      player.position.z + Math.cos(a) * RADIUS,
      player.position.x + Math.sin(b) * RADIUS,
      player.position.y,
      player.position.z + Math.cos(b) * RADIUS,
      PALETTE.trace,
      intensity,
    );
  }
}

/**
 * Draws the shields where the ship actually is, in world space, rather than
 * only on the HUD dial: a decaying arc-flash on the quarter that last took a
 * hit (`Ship.struckFacing`/`struckFlash`, set in `takeHit` and decayed in
 * `update`), and a steady aura on the bow while the brace's overcharge holds
 * (`shields.fore > 1`, up to `BRACE.ceiling`). Both compose when the bow is
 * the facing struck while braced — the flash simply draws on top of the aura.
 */
export function drawShieldFx(trace: TraceBuffer, player: Ship): void {
  const surplus = player.shields.fore - 1;
  if (surplus > 0) {
    arc(trace, player, "fore", 0.5 + 1.1 * (surplus / (BRACE.ceiling - 1)));
  }
  if (player.struckFacing && player.struckFlash > 0) {
    arc(trace, player, player.struckFacing, 2.4 * player.struckFlash);
  }
}
