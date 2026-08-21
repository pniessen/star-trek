import { Vector3 } from "three";
import type { TraceBuffer } from "../render/TraceBuffer.js";
import { CURVES } from "../render/eventLights.js";
import { PALETTE } from "../render/palette.js";
import { BRACE, type Ship, type ShieldFacing } from "./Ship.js";
import type { LightSink } from "./lightSink.js";

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
 * `(sin(angle), cos(angle))`, so the cap axis below reuses that same
 * convention for `centre = player.heading + FACING_OFFSET[facing]`.
 */
const FACING_OFFSET: Record<ShieldFacing, number> = {
  fore: 0,
  starboard: Math.PI / 2,
  aft: Math.PI,
  port: -Math.PI / 2,
};

/**
 * The bubble, and why it is a bubble.
 *
 * What this file used to draw was a flat 40° arc on the plane at the struck
 * quarter's bearing — a mark on a dial, moved off the HUD and into the world.
 * It said *which* facing took the hit and nothing whatever about the shield
 * being a thing with a shape, and the moment the slab landed and hostiles
 * started shooting from above and below, a stroke lying flat at `y = 0` was
 * actively saying the wrong thing: a bolt that came down at you produced a
 * flash on the floor.
 *
 * So the shell is a **spheroid** — oblate, because a hull thirteen units long
 * inside a twenty-eight unit slab is not a sphere and a sphere around it would
 * read as a balloon rather than as armour — and an impact lights a **geodesic
 * cap** on it: rings of constant angular distance from the impact axis,
 * expanding away from the struck quarter and washing round toward the far side.
 * Energy spreading across a surface, which is the whole read being bought here.
 *
 * **What did not change is the resolution.** `Ship.facingFrom` is `atan2(x, z)`
 * and ignores `y`, so the four facings are a ring and a shot from 40° above
 * hits exactly the quarter a level one does — a locked decision, restated in
 * `CLAUDE.md` when the slab unlocked the plane. The cap's axis is therefore
 * horizontal (`n.y === 0`) and the *only* thing height contributes here is that
 * the cap wraps over and under the hull as it spreads. A curved shell drawn
 * around a ring-shaped rule is honest: the bubble is a cylinder in behaviour
 * and a spheroid in appearance, and it never claims to be hit somewhere the
 * game did not resolve a hit.
 */
const SHELL = {
  /** Equatorial semi-axis, in world units. Was the old flat arc's radius. */
  radius: 4.6,
  /**
   * Polar semi-axis. 0.62 of the equator — enough oblateness to read as a
   * flattened field around a flat-flying ship rather than as a beach ball, and
   * not so much that the cap's own rings collapse into stripes when the impact
   * axis is side-on.
   */
  height: 2.85,
  /**
   * How far round the shell a ripple travels before it is spent, in radians of
   * arc from the impact point. Just short of π: the front dies as it converges
   * on the antipode rather than pinching to a bright point there, which would
   * read as a second, smaller hit on the opposite facing.
   */
  reach: 0.86 * Math.PI,
  /** Rings in the expanding front, and the arc between them. */
  rings: 3,
  ringGap: 0.30,
  /** Azimuthal segments per ring. */
  arcSegments: 18,
} as const;

/**
 * Fixed structure drawn under the events, so the shell is a surface rather than
 * a ring that appears from nowhere when something hits it.
 *
 * Two great circles at the facing *boundaries* — ±45° and ±135° off the nose —
 * rather than at the facing centres, which is the one choice here worth
 * arguing about: the boundaries are what the player is actually steering, since
 * the whole four-facing skill is turning a fresh quarter toward the shooter and
 * the thing you need to see is where one quarter stops being the one that
 * eats the next bolt. Drawn dim, in `traceDim`, on the same grounds the grid
 * and the station structure are: it is scaffolding, not a signal.
 */
const SKELETON = {
  equatorSegments: 22,
  meridianSegments: 14,
  /** Peak intensity, scaled down by how little is happening. */
  level: 0.42,
} as const;

/**
 * The braced bow's own cap: three fixed rings around the nose axis, held while
 * the overcharge holds.
 *
 * A *state*, not an event, so it does not expand — it sits at a fixed angular
 * radius and drifts in azimuth, which is the cheapest way to say "live field"
 * without animating brightness. Brightness is reserved: pulse and flash are
 * hostile grammar (`CLAUDE.md`, colour rules) and a friendly shield throbbing
 * would be borrowing a word that means something else.
 */
const BOW = {
  angles: [0.30, 0.56, 0.82],
  arcSegments: 16,
  /** Radians a second the ring pattern rolls about the nose axis. */
  roll: 0.55,
} as const;

/** How bright a struck cap gets at the instant of impact. */
const FLASH_LEVEL = 2.8;

/**
 * What the impact asks the world for, when a `LightSink` is supplied.
 *
 * `snap` and 0.18 s rather than a flash: a bolt stopping on a shield is an
 * *event* and not an explosion, and the same 0.11 s the phaser's own beam lives
 * for is the length the eye already reads as "a discharge happened". Intensity
 * 3 is a shade under a warhead's — see `EVENT_LIGHT.reference` for what the
 * number means — because the thing being lit is a metre from the camera in
 * cockpit view and the hulls around it are the point, not the canopy.
 */
const FLASH_LIGHT = { intensity: 3.0, seconds: 0.18 } as const;

/**
 * A rising edge on `Ship.struckFlash`, kept here rather than on the ship.
 *
 * `takeHit` sets the field to 1 and `update` decays it at 3 a second, so a new
 * hit is the only thing that can ever make it *larger* than it was last frame.
 * That gives an event hook with no change to `Ship` — which matters, because
 * `Ship.ts` is the flight model and the one file where a field added for a
 * visual would go on being carried by everything that constructs one.
 *
 * Module state rather than a class because there is exactly one player ship and
 * a stale value costs at most one missed or one duplicated light on a restart —
 * the value self-corrects on the next frame either way.
 */
let lastFlash = 0;
/** Seconds of drawn time, for the bow cap's roll. See `drawShieldFx`'s `dt`. */
let clock = 0;

const capPoint = new Vector3();
const capPrev = new Vector3();
const flashAt = new Vector3();

/**
 * One point of a geodesic ring: angular distance `theta` from the axis at
 * bearing `bearing`, azimuth `phi` about it, written onto `out` in world space.
 *
 * The basis is built inline from the bearing rather than kept in a scratch
 * `Matrix3`, because it is two sines and two cosines and the axis is horizontal
 * by construction (see `SHELL`'s header): `n = (sin b, 0, cos b)`, the "up" of
 * the ring is world up, and the third leg is `n × up = (-cos b, 0, sin b)`.
 * Nothing here allocates, which is why it can run from inside three nested
 * loops on a frame where the ship is braced *and* struck.
 */
function shellPoint(
  out: Vector3,
  origin: Vector3,
  bearing: number,
  theta: number,
  phi: number,
): Vector3 {
  const sb = Math.sin(bearing);
  const cb = Math.cos(bearing);
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  // n * cos(theta) + (up * cos(phi) + (n x up) * sin(phi)) * sin(theta), then
  // squashed onto the spheroid — the y term is the only one that scales
  // differently, which is the entire difference between this and a sphere.
  return out.set(
    origin.x + (sb * ct - cb * sp * st) * SHELL.radius,
    origin.y + cp * st * SHELL.height,
    origin.z + (cb * ct + sb * sp * st) * SHELL.radius,
  );
}

/** A closed ring of constant `theta` about the axis at `bearing`. */
function capRing(
  trace: TraceBuffer,
  origin: Vector3,
  bearing: number,
  theta: number,
  phase: number,
  intensity: number,
  segments: number,
): void {
  if (intensity <= 0.01) return;
  shellPoint(capPrev, origin, bearing, theta, phase);
  for (let i = 1; i <= segments; i++) {
    const phi = phase + (i / segments) * Math.PI * 2;
    shellPoint(capPoint, origin, bearing, theta, phi);
    trace.push(
      capPrev.x,
      capPrev.y,
      capPrev.z,
      capPoint.x,
      capPoint.y,
      capPoint.z,
      PALETTE.trace,
      intensity,
    );
    capPrev.copy(capPoint);
  }
}

/**
 * The shell's own scaffolding: the equator plus two great circles through the
 * poles at the facing boundaries. `theta = PI/2` is the equator of the cap
 * basis, so both meridians fall straight out of `shellPoint` with no second
 * parametrisation — a great circle through the poles at bearing `b` is exactly
 * the `theta = PI/2` ring of the axis at bearing `b + PI/2`.
 */
function skeleton(trace: TraceBuffer, player: Ship, level: number): void {
  if (level <= 0.01) return;
  const half = Math.PI / 2;
  // The equator: theta = PI/2 about a vertical axis is not expressible in this
  // basis (the axis is horizontal by construction), so it is walked directly.
  capPrev.set(
    player.position.x + Math.sin(player.heading) * SHELL.radius,
    player.position.y,
    player.position.z + Math.cos(player.heading) * SHELL.radius,
  );
  for (let i = 1; i <= SKELETON.equatorSegments; i++) {
    const a = player.heading + (i / SKELETON.equatorSegments) * Math.PI * 2;
    capPoint.set(
      player.position.x + Math.sin(a) * SHELL.radius,
      player.position.y,
      player.position.z + Math.cos(a) * SHELL.radius,
    );
    trace.push(
      capPrev.x,
      capPrev.y,
      capPrev.z,
      capPoint.x,
      capPoint.y,
      capPoint.z,
      PALETTE.traceDim,
      level,
    );
    capPrev.copy(capPoint);
  }
  for (const boundary of [Math.PI / 4, (Math.PI * 3) / 4]) {
    const bearing = player.heading + boundary + half;
    shellPoint(capPrev, player.position, bearing, half, 0);
    for (let i = 1; i <= SKELETON.meridianSegments; i++) {
      const phi = (i / SKELETON.meridianSegments) * Math.PI * 2;
      shellPoint(capPoint, player.position, bearing, half, phi);
      trace.push(
        capPrev.x,
        capPrev.y,
        capPrev.z,
        capPoint.x,
        capPoint.y,
        capPoint.z,
        PALETTE.traceDim,
        level,
      );
      capPrev.copy(capPoint);
    }
  }
}

/**
 * Draws the shields where the ship actually is, in world space, rather than
 * only on the HUD dial.
 *
 * Three things, all on the one spheroid described by `SHELL`: a dim skeleton so
 * the field has a surface, a **geodesic ripple** expanding away from the
 * quarter that last took a hit (`Ship.struckFacing`/`struckFlash`, set in
 * `takeHit` and decayed in `update`), and a steady cap on the bow while the
 * brace's overcharge holds (`shields.fore > 1`, up to `BRACE.ceiling`). They
 * compose — the ripple simply draws over the cap when the bow is the facing
 * struck while braced, which is the common case and the one worth looking good.
 *
 * @param dt seconds since the last call, for the bow cap's roll alone. Defaults
 *        to 0 so the file is correct — merely static — for any caller that has
 *        not got one, which is the state `main.ts` is in until the roll is
 *        worth a second argument at the call site. Nothing accumulates that a
 *        missing `dt` could desynchronise: the ripple is driven entirely by
 *        `struckFlash`, which the ship already decays on its own clock, so this
 *        is the house "time-based, never frame-based" rule satisfied by not
 *        keeping a second clock at all for the part that matters.
 * @param light optional, and see `LightSink` for why every effect here has to
 *        stand up without it.
 */
export function drawShieldFx(
  trace: TraceBuffer,
  player: Ship,
  dt = 0,
  light?: LightSink,
): void {
  clock += dt;

  const surplus = player.shields.fore - 1;
  const braced = surplus > 0 ? surplus / (BRACE.ceiling - 1) : 0;
  const flash = player.struckFlash;

  // The rising edge. Checked before anything is drawn so the light lands on the
  // same frame as the first, brightest ring rather than one behind it.
  if (light && flash > lastFlash + 1e-6 && player.struckFacing) {
    const bearing = player.heading + FACING_OFFSET[player.struckFacing];
    flashAt.set(
      player.position.x + Math.sin(bearing) * SHELL.radius,
      player.position.y,
      player.position.z + Math.cos(bearing) * SHELL.radius,
    );
    light(flashAt, PALETTE.trace, FLASH_LIGHT.intensity, FLASH_LIGHT.seconds, CURVES.snap);
  }
  lastFlash = flash;

  if (flash <= 0 && braced <= 0) return;

  // The scaffolding is only ever as bright as the loudest thing on top of it —
  // a shell hanging around a ship that is neither braced nor being shot at
  // would be a permanent bubble, which is exactly the "balloon" read the
  // oblateness above exists to avoid.
  skeleton(trace, player, SKELETON.level * Math.max(flash, braced * 0.8));

  if (braced > 0) {
    const bearing = player.heading;
    const phase = clock * BOW.roll;
    for (let i = 0; i < BOW.angles.length; i++) {
      // Outer rings dimmer: the cap has to read as a dome centred on the nose,
      // and three rings of equal weight read as three separate rings.
      capRing(
        trace,
        player.position,
        bearing,
        BOW.angles[i],
        // Alternating roll direction, so the pattern shears instead of
        // rotating rigidly — a rigid rotation of concentric circles is
        // invisible, which would have made the roll cost segments for nothing.
        i % 2 === 0 ? phase : -phase,
        (0.45 + 1.0 * braced) * (1 - i * 0.22),
        BOW.arcSegments,
      );
    }
  }

  if (flash > 0 && player.struckFacing) {
    const bearing = player.heading + FACING_OFFSET[player.struckFacing];
    // `struckFlash` runs 1 → 0 over a third of a second, so `1 - flash` is the
    // ripple's own normalised age with no second timer and no `dt` — the ship
    // is already keeping this clock and keeping a copy of it here is how the
    // two would eventually disagree.
    const front = (1 - flash) * SHELL.reach;
    for (let i = 0; i < SHELL.rings; i++) {
      const theta = front - i * SHELL.ringGap;
      if (theta <= 0.04) continue;
      capRing(
        trace,
        player.position,
        bearing,
        theta,
        0,
        // Falls with the ring's age within the front *and* with the front's own
        // travel, so the wash dies as it wraps rather than arriving at the far
        // side as bright as it left.
        FLASH_LEVEL * flash * (1 - i * 0.3),
        SHELL.arcSegments,
      );
    }
  }
}

/**
 * Forget the last hit. For a restart or a sector change — `lastFlash` is a
 * rising-edge latch and a run that ends mid-flash would otherwise leave it
 * high, swallowing the first hit of the next run.
 */
export function resetShieldFx(): void {
  lastFlash = 0;
  clock = 0;
}
