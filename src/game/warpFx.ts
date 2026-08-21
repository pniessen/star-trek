import { Vector3 } from "three";
import type { TraceBuffer } from "../render/TraceBuffer.js";
import { CURVES } from "../render/eventLights.js";
import { PALETTE } from "../render/palette.js";
import type { Hyperwarp } from "./hyperwarp.js";
import type { LightSink } from "./lightSink.js";
import type { Ship } from "./Ship.js";

/**
 * The jump, as something that happens to the ship rather than to the sky.
 *
 * Everything hyperwarp had was in the backdrop: `Backdrop.warp` tore the
 * starfield and `main.ts` stretched the starfield's streaks, and both are good
 * and both are *behind* you. The most expensive decision in the game — half the
 * multiplier, the same price as letting something reach the hull — was
 * announced by a change in the wallpaper. Committing to it and arriving out of
 * it are the two moments this file exists to make into events, and both are
 * drawn in world space, around the hull, where the player is looking.
 *
 * **Two halves, deliberately opposite in shape.** The wind-up *converges*: a
 * cage of rings rushing in from ahead, tightening and speeding up as the charge
 * builds, with the ship's own field drawn out into stalks along the heading. It
 * is a collapse, and it should read as pressure. The arrival *expands*: one
 * shockwave standing across the heading, a second running flat across the
 * plane, and a spray of shards, all spent inside 0.85 s. Same colour, same
 * vocabulary, mirrored motion — which is what makes the pair legible as one
 * event with two ends rather than as two unrelated flourishes.
 *
 * **Cyan throughout.** The drive is ours; cyan is what "ours" means
 * (`render/palette.ts`), and a jump is the one thing in the game that is
 * unambiguously the player's own doing. Nothing here pulses or flashes on a
 * repeating beat — that grammar is reserved for hostiles — and the arrival's
 * one bright frame is an event with a decay, not a blink.
 *
 * **No clock of its own.** Every phase term below is read off `Hyperwarp`,
 * which `Session` advances with the dilated `dt` the rest of the run uses. A
 * second timer here would be one more thing to reset on restart and would run
 * at full speed through the hit-stop of whatever is waiting on the far side.
 */
const ENTRY = {
  /** Rings in the converging cage, and segments in each. */
  rings: 5,
  /**
   * Twenty rather than sixteen. The cage's nearest ring subtends most of the
   * frame in chase view and nearly all of it in the cockpit, and at sixteen the
   * silhouette read as a faceted cone rather than as a circle — which is a
   * different shape, not a coarser one. Twenty is where it stops being a
   * polygon and costs twenty segments of a five-thousand budget.
   */
  ringSegments: 20,
  /** How much of `Hyperwarp.wind` a ring's own sweep consumes. */
  windScale: 0.35,
  /** Where a ring is born, along the heading, and where it dies behind you. */
  bornAt: 30,
  diesAt: -10,
  /**
   * Ring radius at birth, at zero progress and at full. It shrinks with the
   * charge, which is the tell that costs nothing and says the most: the cage
   * closing is the ship being squeezed into the jump.
   */
  wideStart: 18,
  wideEnd: 9,
  /** Radius at the moment a ring passes the hull. Never zero — a ring that
   *  converges to a point reads as an aiming reticle, not a passage. */
  narrow: 2.5,
  /** Longitudinal stalks: the field drawn out along the heading. */
  spokes: 10,
  spokeRadius: 7,
  spokeSquash: 4,
  spokeBack: 2,
  spokeReach: 16,
} as const;

const EXIT = {
  /** The shockwave standing across the heading. */
  waveSegments: 28,
  waveRadius: 78,
  waveLevel: 3.2,
  /** A second wave running flat across the plane, dimmer and shorter. */
  planeSegments: 24,
  planeRadius: 52,
  planeLevel: 2.2,
  /** Shards, spent in the first fraction of the flourish. */
  shards: 20,
  shardRadius: 34,
  shardLevel: 3.0,
  /** How much faster than the flourish the shards are done. */
  shardRate: 2.2,
  /** The collapse the ship arrives inside, for the first slice only. */
  coreFraction: 0.3,
  coreSize: 3.5,
  coreLevel: 4.0,
} as const;

/**
 * What each end of the jump asks the world for, when a `LightSink` is supplied.
 *
 * The arrival is the brightest single call in the game and should be — see
 * `EVENT_LIGHT.reference` for the unit, where 4 is a warhead. Nine is "four
 * times a warhead, twelve units away", which is roughly what arriving inside
 * your own drive's discharge ought to do to the hulls that are already standing
 * in the sector waiting for you. `swell` rather than `spike` because the extra
 * ~65 ms of growth is exactly the difference between an explosion and something
 * *opening*.
 *
 * The commit is a tenth of that and deliberately so: it is a wind-up, the ship
 * is not yet anywhere, and a bright light at the start would spend the pool on
 * the half of the event that has not happened yet.
 */
const WARP_LIGHT = {
  commit: { intensity: 2.5, seconds: 0.35 },
  arrive: { intensity: 9, seconds: 0.55 },
} as const;

/**
 * Rising-edge latches, on the same reasoning `shieldFx`'s own are module state:
 * there is one player ship, the values self-correct within a frame, and the
 * alternative is a field on `Hyperwarp` that exists only so a draw call can
 * remember whether it has already fired.
 */
let wasCharging = false;
let wasArriving = false;

const forward = new Vector3();
const right = new Vector3();
const point = new Vector3();
const prev = new Vector3();
const UP = new Vector3(0, 1, 0);

/**
 * One circle standing across the heading, `offset` units along it from the
 * ship. Written out longhand rather than through a `Matrix4` because the basis
 * is a heading and world up: `forward = (sin h, 0, cos h)` and
 * `right = (cos h, 0, -sin h)` are two sines and two cosines, and this runs
 * five times a frame for the whole of a charge.
 */
function crossRing(
  trace: TraceBuffer,
  origin: Vector3,
  offset: number,
  radius: number,
  intensity: number,
  segments: number,
  dim = false,
): void {
  if (intensity <= 0.01 || radius <= 0.01) return;
  const cx = origin.x + forward.x * offset;
  const cy = origin.y + forward.y * offset;
  const cz = origin.z + forward.z * offset;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const ca = Math.cos(a) * radius;
    const sa = Math.sin(a) * radius;
    point.set(cx + right.x * ca, cy + sa, cz + right.z * ca);
    if (i > 0) {
      trace.push(
        prev.x,
        prev.y,
        prev.z,
        point.x,
        point.y,
        point.z,
        dim ? PALETTE.traceDim : PALETTE.trace,
        intensity,
      );
    }
    prev.copy(point);
  }
}

/**
 * Draws both ends of a jump. Call once a frame from the same block that draws
 * the rest of combat's strokes; it returns immediately when nothing is
 * happening, which is almost every frame of almost every run.
 *
 * @param light optional. See `LightSink` — the strokes carry the event on their
 *        own, and every build that has no light pool still has a jump.
 */
export function drawWarpFx(
  trace: TraceBuffer,
  player: Ship,
  warp: Hyperwarp,
  light?: LightSink,
): void {
  const charging = warp.charging;
  const arriving = warp.arrival > 0;

  if (light && charging && !wasCharging) {
    light(player.position, PALETTE.trace, WARP_LIGHT.commit.intensity, WARP_LIGHT.commit.seconds, CURVES.snap);
  }
  if (light && arriving && !wasArriving) {
    light(player.position, PALETTE.trace, WARP_LIGHT.arrive.intensity, WARP_LIGHT.arrive.seconds, CURVES.swell);
  }
  wasCharging = charging;
  wasArriving = arriving;

  if (!charging && !arriving) return;

  player.forward(forward);
  right.set(Math.cos(player.heading), 0, -Math.sin(player.heading));

  if (charging) drawEntry(trace, player, warp);
  if (arriving) drawExit(trace, player, warp);
}

/** The wind-up: a cage closing, tightening and quickening with the charge. */
function drawEntry(trace: TraceBuffer, player: Ship, warp: Hyperwarp): void {
  const p = Math.min(1, warp.progress);
  const wide = ENTRY.wideStart + (ENTRY.wideEnd - ENTRY.wideStart) * p;

  for (let k = 0; k < ENTRY.rings; k++) {
    // Each ring is the same sweep at a fixed offset in phase, so five rings
    // cost one accumulator rather than five. `wind` is already advancing faster
    // as the charge builds (see `HYPERWARP.windSlow`/`windFast`), which is what
    // makes the cage quicken without a second term here.
    const u = (((warp.wind * ENTRY.windScale + k / ENTRY.rings) % 1) + 1) % 1;
    const offset = ENTRY.bornAt + (ENTRY.diesAt - ENTRY.bornAt) * u;
    const radius = wide + (ENTRY.narrow - wide) * u;
    // Born faint, brightest as it passes the hull, gone behind you: a ring that
    // simply appeared at full strength thirty units ahead would read as a
    // popping artefact rather than as something arriving.
    const shape = Math.pow(Math.sin(u * Math.PI), 0.6);
    crossRing(
      trace,
      player.position,
      offset,
      radius,
      (0.35 + 1.5 * p) * shape,
      ENTRY.ringSegments,
    );
  }

  // The stalks. Fixed to the hull rather than sweeping, and lengthening with
  // the charge — the rings are what moves, and having both move gives the eye
  // nothing to measure the motion against.
  const radius = ENTRY.spokeRadius - ENTRY.spokeSquash * p;
  const back = -ENTRY.spokeBack;
  const reach = 2 + ENTRY.spokeReach * p;
  const roll = warp.wind * 0.4;
  for (let k = 0; k < ENTRY.spokes; k++) {
    const a = roll + (k / ENTRY.spokes) * Math.PI * 2;
    const ca = Math.cos(a) * radius;
    const sa = Math.sin(a) * radius;
    const ox = right.x * ca;
    const oz = right.z * ca;
    trace.push(
      player.position.x + forward.x * back + ox,
      player.position.y + sa,
      player.position.z + forward.z * back + oz,
      player.position.x + forward.x * reach + ox,
      player.position.y + sa,
      player.position.z + forward.z * reach + oz,
      PALETTE.trace,
      0.2 + 1.4 * p,
    );
  }
}

/** The arrival: everything the wind-up did, run outward and spent in 0.85 s. */
function drawExit(trace: TraceBuffer, player: Ship, warp: Hyperwarp): void {
  const t = warp.arrivalProgress;
  const decay = Math.pow(1 - t, 1.8);
  // Ease-out on both waves, for the reason `Ordnance`'s own bursts use one: a
  // linear expansion reads as a growing circle and a decelerating one reads as
  // a pressure wave running out of room.
  const ease = 1 - (1 - t) * (1 - t);

  crossRing(
    trace,
    player.position,
    0,
    6 + EXIT.waveRadius * ease,
    EXIT.waveLevel * decay,
    EXIT.waveSegments,
  );

  // The flat wave, on the plane everything else in this game rests on. Drawn in
  // `traceDim` so the two waves separate: same event, one of them scaffolding.
  const flat = 3 + EXIT.planeRadius * ease;
  const level = EXIT.planeLevel * decay;
  if (level > 0.01) {
    prev.set(player.position.x, player.position.y, player.position.z + flat);
    for (let i = 1; i <= EXIT.planeSegments; i++) {
      const a = (i / EXIT.planeSegments) * Math.PI * 2;
      point.set(
        player.position.x + Math.sin(a) * flat,
        player.position.y,
        player.position.z + Math.cos(a) * flat,
      );
      trace.push(prev.x, prev.y, prev.z, point.x, point.y, point.z, PALETTE.traceDim, level);
      prev.copy(point);
    }
  }

  // Shards, done at more than twice the rate of the waves — the debris of
  // arriving is the fastest thing in the event and the waves are what is left
  // once it has gone.
  const shardT = Math.min(1, t * EXIT.shardRate);
  if (shardT < 1) {
    const shardEase = 1 - (1 - shardT) * (1 - shardT);
    const radius = EXIT.shardRadius * shardEase;
    const shardLevel = EXIT.shardLevel * (1 - shardT) * (1 - shardT);
    for (let k = 0; k < EXIT.shards; k++) {
      // The same golden-angle spiral `Ordnance.drawBursts` uses, and for the
      // same reason: uniform without clumping, and derived from the index alone
      // so nothing has to be stored per shard.
      const y = 1 - (2 * (k + 0.5)) / EXIT.shards;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const a = k * 2.399963;
      const dx = Math.cos(a) * ring;
      const dz = Math.sin(a) * ring;
      trace.push(
        player.position.x + dx * radius * 0.5,
        player.position.y + y * radius * 0.5,
        player.position.z + dz * radius * 0.5,
        player.position.x + dx * radius * 1.1,
        player.position.y + y * radius * 1.1,
        player.position.z + dz * radius * 1.1,
        PALETTE.trace,
        shardLevel,
      );
    }
  }

  // The core: the thing the ship arrives out of, gone before the waves are a
  // third of the way out.
  if (t < EXIT.coreFraction) {
    const c = 1 - t / EXIT.coreFraction;
    const size = EXIT.coreSize * c;
    for (const axis of [forward, right, UP]) {
      trace.push(
        player.position.x - axis.x * size,
        player.position.y - axis.y * size,
        player.position.z - axis.z * size,
        player.position.x + axis.x * size,
        player.position.y + axis.y * size,
        player.position.z + axis.z * size,
        PALETTE.trace,
        EXIT.coreLevel * c,
      );
    }
  }
}

/**
 * Forget both edges. For a restart — the latches are what stop a light being
 * emitted twice, and a run that ended mid-charge would otherwise leave
 * `wasCharging` high and swallow the next run's first commit.
 */
export function resetWarpFx(): void {
  wasCharging = false;
  wasArriving = false;
}
