import { Color, Vector3 } from "three";
import { PALETTE } from "../render/palette.js";
import { NO_REFITS, type Loadout } from "../chart/economy.js";
import { flight } from "./altitude.js";
import { CURVES, type DecayCurve } from "../render/eventLights.js";
import type { LightSink } from "./lightSink.js";
import type { TraceBuffer } from "../render/TraceBuffer.js";

/**
 * Two weapons with opposite characters, so that "which do I use" is a question
 * rather than a preference:
 *
 *  - Phasers are instant, drain the shared energy pool, and weaken with
 *    distance. Straight from the 1971 game, and it is what forces you to close.
 *  - Torpedoes carry limited ammunition and travel, so they must be led. Huge
 *    damage, and running out is a real state to be in.
 *
 * Hostile fire is a third, slower projectile — readable enough to dodge, which
 * is what makes shield facing a decision rather than a dice roll.
 */

export const PHASER = {
  /** Energy drawn per shot from the single reserve. */
  /**
   * Energy per shot, and at a held 6.25 shots a second this is the largest
   * drain in the game by a factor of four — 0.0875 a second against thrust's
   * 0.035 and the slab's 0.055.
   *
   * It was 0.022, which emptied a full reserve in eight seconds of held fire and
   * in under five while burning and off the plane. That is not a tradeoff
   * against the torpedo, it is a weapon you cannot use. The first person to fly
   * it said power went "very very quickly" and the arithmetic agrees: the
   * complaint reads as an altitude or capacity problem and is neither, it is
   * this number.
   *
   * 0.014 buys about thirteen seconds of continuous fire, which leaves the
   * phaser expensive — it should still be the reason you learn to lead a
   * torpedo — without making it unusable.
   */
  cost: 0.010,
  cooldown: 0.16,
  damage: 0.34,
  /** Full damage inside this range, tailing to zero at `falloffEnd`. */
  falloffStart: 26,
  falloffEnd: 78,
  /** Half-angle of the assist cone, radians. Aim is the nose, not a cursor. */
  aimCone: 0.13,
};

export const TORPEDO = {
  cooldown: 0.62,
  /**
   * A warhead, not a slow phaser.
   *
   * At 1.35 over a 0.62s cooldown the tube did 2.18 damage a second and the
   * phaser did 2.13 — identical, except the phaser is instant, never misses
   * inside its assist cone, and never runs out. Inside 78 units the torpedo
   * was strictly the worse weapon, which is exactly how it felt to fly.
   *
   * 2.6 one-shots every hostile in the game including a Bastion, which is what
   * makes it worth carrying twelve of. The cost of that is unchanged: you have
   * twelve, you must lead them, and past 78 units they are the only thing you
   * have that still bites.
   */
  damage: 2.6,
  /**
   * Photon, not solid shot. Damage falls to zero at this radius, so a near
   * miss on a hard-turning target still counts for something — the honest
   * answer to "must be led" being a hard skill, and one that does not reach
   * for homing, which is a locked decision.
   *
   * Deliberately half the Harrow's 13-unit mine blast: enough to reward a
   * close pass, far short of making aim optional.
   */
  blast: 6.5,
  /**
   * At 74 this needed 36 degrees of lead on a Raider — which crosses at about
   * 180 degrees a second at its preferred range — and the shot was a guess
   * rather than a skill. 130 brings that to roughly 20 degrees while keeping
   * the weapon slow enough that leading is still the whole point of it. Range
   * is held where it was by shortening `life` to match.
   */
  speed: 130,
  life: 1.5,
  capacity: 12,
} as const;

export const BOLT = {
  damage: 0.3,
  speed: 46,
  life: 3.4,
} as const;

/** Where the beam dies, under this loadout. The capacitor bank pulls it in. */
export function phaserRangeOf(loadout: Loadout): number {
  return PHASER.falloffEnd * loadout.phaserRange;
}

/** Energy per shot, as a fraction of the reserve — which the refits also resize. */
export function phaserCostOf(loadout: Loadout): number {
  return (PHASER.cost * loadout.phaserCost) / loadout.energyReserve;
}

export function phaserDamageAt(distance: number, loadout: Loadout = NO_REFITS): number {
  const end = phaserRangeOf(loadout);
  if (distance >= end) return 0;
  // Focusing coils hold full damage all the way out to whatever range is left,
  // which is why the capacitor bank shortens `end` rather than merely steepening
  // the ramp: otherwise fitting the coils would erase the capacitor's price and
  // the pair would be a pure upgrade.
  if (loadout.phaserFlat) return PHASER.damage;
  const start = Math.min(PHASER.falloffStart, end);
  if (distance <= start) return PHASER.damage;
  return PHASER.damage * (1 - (distance - start) / (end - start));
}

export interface Projectile {
  readonly position: Vector3;
  /**
   * Where it was at the end of the previous step.
   *
   * Hit tests use the segment from here to `position`, not `position` alone. A
   * torpedo travels up to 3.7 units in one clamped frame and the smallest
   * hostile is 4.4 across, so a point test lets anything but a near-central
   * hit straddle the target and pass through it — and leading a strafing
   * target is precisely how you produce a grazing pass.
   */
  readonly previous: Vector3;
  readonly velocity: Vector3;
  life: number;
  readonly maxLife: number;
  readonly damage: number;
  readonly friendly: boolean;
  readonly kind: "torpedo" | "bolt";
  dead: boolean;
  /**
   * Has this shot already been logged as a near miss? Session sets this the
   * first time `sweepDistance` lands it in the near-miss band, so a bolt that
   * lingers near the hull for several frames streaks once, not every frame.
   */
  noted: boolean;
}

/** A phaser discharge, kept only long enough to be drawn. */
interface Beam {
  readonly from: Vector3;
  readonly to: Vector3;
  life: number;
  readonly hit: boolean;
  /**
   * Fixed at discharge, so the impact flare's spokes stand still for the beam's
   * whole life instead of re-rolling their directions every frame.
   *
   * The *brightness* flicker below is deliberately still per-frame random —
   * that is the arcing — but a spray of spokes that changes direction sixty
   * times a second is not a flare, it is static. One number is the whole
   * difference between the two, and keeping it on the beam rather than in a
   * module counter means two beams alive at once do not share a pattern.
   */
  readonly seed: number;
}

const BEAM_LIFE = 0.11;

/**
 * The phaser, as a shape rather than a line.
 *
 * What was here was one `trace.push` from the nose to the target with a random
 * per-frame intensity — which is a *correct* description of an instant hitscan
 * weapon and reads as a coloured ruler. The four parts below are each answering
 * a different half of "why does this not look like a weapon discharging":
 *
 * **A core with a sheath.** A single additive line has one width, the
 * rasteriser's, at every range — so a beam fired at something eight units away
 * looks exactly as thick as one fired at seventy-eight. Four parallel lines
 * offset around the axis give the near shot a visible bore and blur into a
 * single hotter line at range, which is the falloff the eye already expects and
 * costs four segments to get. Deliberately *not* a fat line: `TraceBuffer`'s own
 * header rules those out (an instanced quad each, for strokes that live 0.11 s),
 * and this buys the same read inside the budget that already exists.
 *
 * **A taper.** The sheath stops short of the target and the core dims along its
 * length, so the beam narrows into the thing it hit. A constant-width beam
 * reads as a bridge between two objects; a narrowing one reads as something
 * arriving.
 *
 * **A muzzle flash.** The discharge has to happen *somewhere*, and the emitter
 * is the one place the player is always looking — it is the nose of their own
 * ship. Three crossed strokes for the first 45% of the beam's life.
 *
 * **An impact flare, only when it landed.** `discharge` already knows whether
 * the shot connected and the old code spent that knowledge on a brightness
 * multiplier, which is the least legible thing it could have been spent on. A
 * spray of spokes at the far end says "this one hit" at a glance, which matters
 * at 6.25 shots a second where no individual sound can.
 */
const BEAM = {
  /** Sub-segments along the core, for the length-wise dim. */
  coreSegments: 8,
  /** How much dimmer the core is at the target end than at the muzzle. */
  coreTaper: 0.45,
  /** Sheath offset from the axis, world units. */
  sheathOffset: 0.3,
  /** Fraction of the run the sheath covers before it converges on the core. */
  sheathReach: 0.88,
  sheathLevel: 0.34,
  /** Fraction of `BEAM_LIFE` the muzzle flash is alight for. */
  muzzleLife: 0.45,
  muzzleSize: 1.1,
  muzzleLevel: 3.2,
  flareSpokes: 8,
  flareInner: 0.5,
  flareOuter: 2.4,
  flareLevel: 3.0,
} as const;

/**
 * A detonation, kept only long enough to be drawn. Warheads and bolt impacts
 * are the same record at two sizes — the alternative was two near-identical
 * structs and two near-identical loops, and the only thing that actually
 * differs between a photon going off and a bolt stopping on a hull is how far
 * the shell gets and how long it takes.
 */
interface Burst {
  readonly at: Vector3;
  readonly color: Color;
  readonly radius: number;
  readonly seconds: number;
  readonly spikes: number;
  readonly level: number;
  /** Segments per great circle. 0 means no shell at all — see `BOLT_BURST`. */
  readonly ringSegments: number;
  readonly seed: number;
  life: number;
}

/**
 * What a warhead does when it arrives.
 *
 * Torpedoes used to vanish. `Session` set `dead`, `Ordnance.update` spliced the
 * record, and everything the player saw of the detonation came from
 * `DebrisField.burst` on the *hostile* — which meant a warhead that missed
 * everything but still cleared a mine, or one that killed nothing because the
 * blast falloff ate it, went off in complete silence visually. The shell here
 * belongs to the *warhead*, so it happens wherever the warhead was, whatever it
 * was near.
 *
 * Two great circles and a spray of spikes, expanding on an ease-out. Not a
 * sphere of latitude rings: at 0.45 s and a 7.5 unit radius the eye is reading
 * an outline, and two rings plus radial spikes is the outline — the other
 * fourteen rings would be forty more segments spent on a shape nobody has time
 * to resolve.
 */
const WARHEAD_BURST = {
  radius: 7.5,
  seconds: 0.45,
  spikes: 10,
  level: 3.4,
  /** Segments in each of the two great circles. */
  ringSegments: 14,
} as const;

/**
 * The same thing at a twentieth of the size, for a bolt stopping on something.
 *
 * Worth having at all because a bolt that hits the *player* already produces a
 * shield ripple (`game/shieldFx.ts`) and a bolt that hits anything else — the
 * Warden, most often, catching stray fire it flew into — previously produced
 * nothing whatever. It is six strokes and 0.16 s; it is not an explosion, it is
 * the shot ending.
 */
const BOLT_BURST = {
  radius: 1.7,
  seconds: 0.16,
  spikes: 6,
  level: 2.2,
  ringSegments: 0,
} as const;

/**
 * The projectiles themselves: a head and a trail, rather than one stroke drawn
 * backwards along the velocity.
 *
 * The trail is straight, and that is not an approximation — nothing in
 * `Ordnance.update` accelerates a projectile, so the path behind one *is* a
 * straight line along its own velocity and a stored position history would be a
 * ring buffer per projectile that reproduced, exactly, a number already
 * available for free. It is split into sub-segments only so the intensity can
 * fall along it, which is the difference between a trail and a stick.
 */
const HEAD = {
  torpedo: { star: 0.5, level: 3.6, trail: 5.5, trailSegments: 6, trailLevel: 2.6 },
  bolt: { star: 0.3, level: 2.4, trail: 2.2, trailSegments: 3, trailLevel: 1.7 },
} as const;

/**
 * A light this module wants, waiting for someone to want it.
 *
 * Queued rather than emitted directly because the events that produce one — a
 * warhead detonating, a beam connecting — are discovered deep inside `update`
 * and `discharge`, neither of which has any business knowing about a scene
 * graph. `drainFlashes` is the one seam, and a build that never calls it draws
 * exactly the same frame minus the point lights.
 */
interface PendingFlash {
  readonly at: Vector3;
  readonly color: Color;
  readonly intensity: number;
  readonly seconds: number;
  readonly curve: DecayCurve;
}

/**
 * Hard ceiling on the queue, so an unwired build cannot leak.
 *
 * `drainFlashes` is optional by design (see `LightSink`), which means the
 * standalone build, the playtest harness and every frame before `main.ts`
 * finishes wiring the pool are all producing entries nobody consumes. Sixteen
 * is comfortably more than the pool's own eight slots can show at once, so
 * dropping past it costs a caller nothing it could have rendered — and the
 * *oldest* is what goes, because the newest flash is the one the player just
 * caused.
 */
const FLASH_QUEUE_LIMIT = 16;

/** What each event asks the world for. See `EVENT_LIGHT.reference` for the unit. */
const FLASH = {
  /** A photon going off. `EVENT_LIGHT`'s own docblock calls 4 a warhead; this is one. */
  warhead: { intensity: 5, seconds: 0.42, curve: CURVES.swell },
  /**
   * A beam connecting. Deliberately the dimmest thing in the file: at 6.25
   * shots a second this is the most frequent light source in the game, and the
   * pool evicts by *weakest*, so keeping it low is what stops a held trigger
   * from strobing every warhead out of the pool. A caller that finds even this
   * too busy should drop `drainFlashes` for beams before dropping it for
   * warheads.
   */
  phaser: { intensity: 1.6, seconds: 0.09, curve: CURVES.snap },
} as const;

/** A near miss, kept only long enough to be drawn. See `Ordnance.nearMiss`. */
interface Streak {
  readonly at: Vector3;
  readonly along: Vector3;
  readonly color: Color;
  life: number;
}

const STREAK_LIFE = 0.35;
/** Half-length of the drawn streak, so the full line spans 6 units. */
const STREAK_HALF = 3;

const sweepStep = new Vector3();
const sweepToTarget = new Vector3();

/**
 * Did a projectile's travel this frame pass within `radius` of `target`?
 *
 * The closest approach of the segment `previous → position` to a point, rather
 * than the distance from the sampled endpoint. Everything that moves fast
 * enough to skip a target in one clamped frame has to ask the question this
 * way — see `Projectile.previous` for the arithmetic that makes it necessary.
 *
 * Targets move too, so this is not exact: it sweeps the projectile against a
 * stationary snapshot of the target. That is a large improvement on a point
 * test and enough for a game where the fastest closing pair covers ~5 units a
 * frame, and a genuinely continuous test would need both paths swept against
 * each other for no perceptible gain.
 *
 * It needed nothing at all when the play space gained a third dimension: it is
 * a point-to-segment distance written in `Vector3` arithmetic — `subVectors`,
 * `dot`, `lengthSq` — and has been correct in three dimensions since the day it
 * replaced point sampling. Checked rather than assumed.
 */
export function sweepDistance(projectile: Projectile, target: Vector3): number {
  sweepStep.subVectors(projectile.position, projectile.previous);
  sweepToTarget.subVectors(target, projectile.previous);

  const lengthSq = sweepStep.lengthSq();
  // A projectile that has not moved yet — its first frame — is just a point.
  if (lengthSq < 1e-9) return sweepToTarget.length();

  // Clamped so the segment stays a segment: a target behind the muzzle or
  // beyond this frame's travel is not hit by it.
  const t = Math.max(0, Math.min(1, sweepToTarget.dot(sweepStep) / lengthSq));
  sweepStep.multiplyScalar(t);
  return sweepToTarget.distanceTo(sweepStep);
}

export function sweepHits(projectile: Projectile, target: Vector3, radius: number): boolean {
  return sweepDistance(projectile, target) <= radius;
}

/**
 * Where, on a projectile's travel this frame, it actually swept closest to
 * `target` — the point `sweepDistance` measures the distance *to*, not the
 * sampled endpoint `projectile.position`. Same clamped-t segment math, kept
 * beside `sweepDistance` rather than folded into it: everything else here
 * only ever needed the distance, and only the near-miss streak needs the
 * point. Returns a fresh `Vector3` rather than a shared scratch one, because
 * the streak holds onto it past the frame that produced it.
 *
 * The gap between this and `position` is real, not academic: a torpedo can
 * cover ~3.7 units in one clamped frame (see `Projectile.previous`), so a
 * streak drawn at `position` instead would sit visibly off wherever the shot
 * actually crossed.
 */
export function sweepClosestPoint(projectile: Projectile, target: Vector3): Vector3 {
  sweepStep.subVectors(projectile.position, projectile.previous);
  sweepToTarget.subVectors(target, projectile.previous);

  const lengthSq = sweepStep.lengthSq();
  // Same first-frame case as `sweepDistance`: nothing to sweep yet, so the
  // closest point is just where it is.
  if (lengthSq < 1e-9) return projectile.position.clone();

  const t = Math.max(0, Math.min(1, sweepToTarget.dot(sweepStep) / lengthSq));
  return projectile.previous.clone().addScaledVector(sweepStep, t);
}

/**
 * How far off the nose a target is, measured as a **bearing** — the angle on
 * the floor, with height thrown away.
 *
 * This is what every aim check in the game asks for, and the reason is the same
 * everywhere: nothing here has a pitch axis. The hull yaws and only yaws, so
 * "am I pointed at it" can only sensibly mean "am I pointed at it in plan".
 * Elevation is the guns' problem, and inside a fourteen-unit slab it is a
 * problem a turret can solve — that is most of why the slab is shallow.
 *
 * The hostiles have always worked this way (`aimError` in `hostiles.ts` is
 * `atan2(x, z)`); this only gives the player's weapons the same rule, and with
 * the slab switched off it is arithmetically identical to the 3D angle it
 * replaced, because every `y` involved is zero.
 */
export function bearingOffset(forward: Vector3, dx: number, dz: number): number {
  let delta = (Math.atan2(dx, dz) - Math.atan2(forward.x, forward.z)) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta);
}

/**
 * Warhead damage at a given closest approach.
 *
 * Full inside the hull, tapering to nothing at the edge of the blast. The
 * taper is squared rather than linear so a clean hit still feels categorically
 * better than a graze — the blast is there to stop near misses being worth
 * literally zero, not to make aiming optional.
 */
export function blastDamageAt(distance: number, radius: number): number {
  if (distance <= radius) return TORPEDO.damage;
  const falloff = 1 - (distance - radius) / TORPEDO.blast;
  return falloff <= 0 ? 0 : TORPEDO.damage * falloff * falloff;
}

const WORLD_UP = new Vector3(0, 1, 0);
/**
 * Scratch, module-level and shared by every draw path below.
 *
 * `draw` runs once a frame over every projectile, beam and burst alive, and a
 * busy frame is a dozen bolts, three torpedoes, a beam and two detonations —
 * so allocating a basis per item would be forty-odd `Vector3`s a frame thrown
 * at the collector for geometry that is thrown away in the same breath. None of
 * these outlive the statement that writes them; nothing here is re-entrant.
 */
const drawDir = new Vector3();
const drawPerpA = new Vector3();
const drawPerpB = new Vector3();
const drawPoint = new Vector3();
const drawPrev = new Vector3();

/**
 * Two unit vectors perpendicular to `dir` (which must already be normalized)
 * and to each other, written onto `a` and `b`.
 *
 * The `y` guard is not a formality: the player's tube elevates
 * (`Session.tubeAim`) and a torpedo fired at something nearly overhead inside
 * the slab has a direction within a few degrees of world up, at which point
 * `up × dir` is a near-zero vector and normalising it produces NaN — which in a
 * `Float32Array` of line positions is a stroke that silently disappears, or
 * worse, a whole draw call rejected. Falling back to `+X` costs one comparison.
 */
function perpendiculars(dir: Vector3, a: Vector3, b: Vector3): void {
  if (Math.abs(dir.y) > 0.94) a.set(1, 0, 0).cross(dir).normalize();
  else a.copy(WORLD_UP).cross(dir).normalize();
  b.copy(dir).cross(a).normalize();
}

/**
 * Three crossed strokes centred on a point: the cheapest thing that reads as a
 * bright object rather than as a line end.
 *
 * Used for a projectile's head, for the phaser's muzzle flash, and for nothing
 * else — three segments is the floor at which a point in space has a *shape*,
 * and every one of the callers wants exactly that and no more.
 */
function star(
  trace: TraceBuffer,
  at: Vector3,
  along: Vector3,
  a: Vector3,
  b: Vector3,
  size: number,
  color: Color,
  intensity: number,
): void {
  if (intensity <= 0.01) return;
  for (const axis of [along, a, b]) {
    trace.push(
      at.x - axis.x * size,
      at.y - axis.y * size,
      at.z - axis.z * size,
      at.x + axis.x * size,
      at.y + axis.y * size,
      at.z + axis.z * size,
      color,
      intensity,
    );
  }
}

export class Ordnance {
  readonly projectiles: Projectile[] = [];
  private readonly beams: Beam[] = [];
  private readonly streaks: Streak[] = [];
  private readonly bursts: Burst[] = [];
  private readonly flashes: PendingFlash[] = [];
  private readonly boltColor = PALETTE.amber.clone();
  private readonly torpedoColor = new Color(0xff8fd0);

  fire(
    position: Vector3,
    direction: Vector3,
    kind: "torpedo" | "bolt",
    friendly: boolean,
    inheritedVelocity?: Vector3,
  ): void {
    const spec = kind === "torpedo" ? TORPEDO : BOLT;
    const velocity = direction.clone().normalize().multiplyScalar(spec.speed);
    if (inheritedVelocity) velocity.add(inheritedVelocity);

    this.projectiles.push({
      position: position.clone(),
      previous: position.clone(),
      velocity,
      life: 0,
      maxLife: spec.life,
      damage: spec.damage,
      friendly,
      kind,
      dead: false,
      noted: false,
    });
  }

  discharge(from: Vector3, to: Vector3, hit: boolean): void {
    this.beams.push({
      from: from.clone(),
      to: to.clone(),
      life: 0,
      hit,
      seed: Math.random() * Math.PI * 2,
    });
    // Only a shot that connected lights anything. A beam into empty space has
    // nothing at the far end to be lit *by* it, and queueing one would spend
    // the pool's weakest-victim eviction on a light with no cause at the place
    // it is shining — cyan, because it is our beam, and the hull it is washing
    // is a hostile's.
    if (hit) this.queue(to, PALETTE.trace, FLASH.phaser);
  }

  /**
   * A hostile shot that swept close enough to the player to count, but not
   * close enough to hit. Draws once per projectile — Session sets
   * `Projectile.noted` so a shot that lingers in the band does not restart
   * the streak every frame.
   *
   * `along` is expected normalized — it is scaled by `STREAK_HALF` on both
   * sides in `draw`, so an unnormalized caller would draw a streak the wrong
   * length rather than a wrong direction.
   *
   * `color` defaults to the bolt colour — a genuine near miss is a shot that
   * swept close, and every shot in this game is amber. `stepWithdrawals`
   * passes the hostile's own hue instead: the streak there marks an exit, not
   * a shot, and the spec calls for it to read as that hostile leaving rather
   * than as one more near-miss amber line.
   */
  nearMiss(at: Vector3, along: Vector3, color: Color = this.boltColor): void {
    this.streaks.push({ at: at.clone(), along: along.clone(), color: color.clone(), life: 0 });
  }

  /**
   * Hand every queued light to `light` and empty the queue.
   *
   * The one seam between this file and `render/eventLights.ts`. Call it once a
   * frame, after `update` — see `PendingFlash` for why the events are queued
   * rather than emitted where they are discovered, and `FLASH_QUEUE_LIMIT` for
   * what happens to a build that never calls this at all.
   */
  drainFlashes(light: LightSink): void {
    for (const flash of this.flashes) {
      light(flash.at, flash.color, flash.intensity, flash.seconds, flash.curve);
    }
    this.flashes.length = 0;
  }

  update(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      // The dead are handled first and, deliberately, *before* the step.
      //
      // `Session.resolveProjectiles` sets `dead` at the point the shot actually
      // resolved against something and then leaves the record for this method
      // to reap on the following frame. Stepping it one more time before
      // reaping — which is what the old order did, harmlessly, because nothing
      // read the position afterwards — would now put the detonation up to 2.2
      // units past the hull it went off against at torpedo speed. Nothing else
      // observes a dead projectile: `resolveProjectiles` skips them on its
      // first line and `draw` runs before this. So the reorder is invisible
      // except in the one place it is the whole point.
      if (p.dead) {
        this.detonate(p);
        this.projectiles.splice(i, 1);
        continue;
      }
      p.life += dt;
      p.previous.copy(p.position);
      p.position.addScaledVector(p.velocity, dt);
      // With the slab off this is the pin that keeps the old game exactly the
      // old game. With it on, ordnance travels where it was aimed — bolts are
      // already led in three dimensions and the player's tube elevates, so
      // flattening them here is the one line that would have made a climbing
      // ship unhittable and an elevated hostile unshootable.
      if (!flight.threeD) p.position.y = 0;
      // A projectile that simply ran out of life does *not* detonate. A photon
      // that reached the end of its run without finding anything is a dud, and
      // giving it a shell would mean every missed torpedo lighting the sector
      // up 1.5 seconds later at a spot the player has stopped looking at — the
      // game would appear to be rewarding misses.
      if (p.life >= p.maxLife) this.projectiles.splice(i, 1);
    }
    for (let i = this.beams.length - 1; i >= 0; i--) {
      this.beams[i].life += dt;
      if (this.beams[i].life >= BEAM_LIFE) this.beams.splice(i, 1);
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      this.bursts[i].life += dt;
      if (this.bursts[i].life >= this.bursts[i].seconds) this.bursts.splice(i, 1);
    }
    for (let i = this.streaks.length - 1; i >= 0; i--) {
      this.streaks[i].life += dt;
      if (this.streaks[i].life >= STREAK_LIFE) this.streaks.splice(i, 1);
    }
  }

  /** A projectile that resolved against something. See `Burst`. */
  private detonate(p: Projectile): void {
    const torpedo = p.kind === "torpedo";
    const spec = torpedo ? WARHEAD_BURST : BOLT_BURST;
    const color = torpedo ? this.torpedoColor : this.boltColor;
    this.bursts.push({
      at: p.position.clone(),
      color,
      radius: spec.radius,
      seconds: spec.seconds,
      spikes: spec.spikes,
      level: spec.level,
      ringSegments: spec.ringSegments,
      // Fixed here rather than rolled in `draw`, for the reason `Beam.seed` is:
      // spokes that re-aim every frame are noise, not a shape.
      seed: Math.random() * Math.PI * 2,
      life: 0,
    });
    // Bolts get no light. There are ten times as many of them, they are a fifth
    // the size, and the one that matters most — a bolt reaching the player —
    // already lights the world through `shieldFx`'s own flare. A pool of eight
    // spent on incoming small-arms fire is a pool that has nothing left for the
    // warhead the player just landed.
    if (torpedo) this.queue(p.position, color, FLASH.warhead);
  }

  /**
   * Queue one light. `color` is expected to be a long-lived `Color` this class
   * owns (`torpedoColor`, `boltColor`, `PALETTE.trace`) rather than a borrowed
   * one, so nothing is cloned; `at` is cloned, because every caller hands this
   * a projectile's own live position.
   */
  private queue(
    at: Vector3,
    color: Color,
    spec: { intensity: number; seconds: number; curve: DecayCurve },
  ): void {
    if (this.flashes.length >= FLASH_QUEUE_LIMIT) this.flashes.shift();
    this.flashes.push({
      at: at.clone(),
      color,
      intensity: spec.intensity,
      seconds: spec.seconds,
      curve: spec.curve,
    });
  }

  draw(trace: TraceBuffer): void {
    this.drawProjectiles(trace);
    this.drawBeams(trace);
    this.drawBursts(trace);

    for (const streak of this.streaks) {
      const t = streak.life / STREAK_LIFE;
      trace.push(
        streak.at.x - streak.along.x * STREAK_HALF,
        streak.at.y - streak.along.y * STREAK_HALF,
        streak.at.z - streak.along.z * STREAK_HALF,
        streak.at.x + streak.along.x * STREAK_HALF,
        streak.at.y + streak.along.y * STREAK_HALF,
        streak.at.z + streak.along.z * STREAK_HALF,
        streak.color,
        2.2 * (1 - t),
      );
    }
  }

  /**
   * A warhead in flight, and a bolt in flight, on the same two-part plan: a
   * head with a shape and a trail that falls away behind it.
   *
   * The head is what makes a torpedo read as *ordnance* rather than as a moving
   * dash — a warhead is an object with a glow, and the previous single stroke
   * along the velocity gave it no centre for the eye to track while leading a
   * turning target, which is the entire skill the weapon exists to test.
   */
  private drawProjectiles(trace: TraceBuffer): void {
    for (const p of this.projectiles) {
      const torpedo = p.kind === "torpedo";
      const spec = torpedo ? HEAD.torpedo : HEAD.bolt;
      const color = torpedo ? this.torpedoColor : this.boltColor;
      const fade = 1 - Math.pow(p.life / p.maxLife, 6); // holds bright, dies fast

      drawDir.copy(p.velocity);
      const speed = drawDir.length();
      // A projectile with no velocity cannot happen — `fire` normalises a
      // direction and scales it by a positive speed — but the basis below
      // divides by this and a guard is one comparison.
      if (speed < 1e-6) continue;
      drawDir.multiplyScalar(1 / speed);
      perpendiculars(drawDir, drawPerpA, drawPerpB);

      const segments = spec.trailSegments;
      for (let i = 0; i < segments; i++) {
        const near = (i / segments) * spec.trail;
        const far = ((i + 1) / segments) * spec.trail;
        trace.push(
          p.position.x - drawDir.x * near,
          p.position.y - drawDir.y * near,
          p.position.z - drawDir.z * near,
          p.position.x - drawDir.x * far,
          p.position.y - drawDir.y * far,
          p.position.z - drawDir.z * far,
          color,
          // Falls faster than linearly, so the trail is a wake behind a bright
          // thing rather than a bar with a gradient painted on it.
          spec.trailLevel * fade * Math.pow(1 - (i + 0.5) / segments, 1.5),
        );
      }

      star(trace, p.position, drawDir, drawPerpA, drawPerpB, spec.star, color, spec.level * fade);
    }
  }

  /** The phaser. Everything `BEAM`'s own docblock argues for. */
  private drawBeams(trace: TraceBuffer): void {
    for (const beam of this.beams) {
      const t = beam.life / BEAM_LIFE;
      // Flicker as it discharges rather than fading smoothly — a clean fade
      // reads as a laser pointer, a flicker reads as something arcing. One roll
      // for the whole beam, not one per segment: a beam whose segments flicker
      // independently is a dotted line, which is the opposite of an arc.
      const base = (1 - t) * (0.65 + Math.random() * 0.6) * (beam.hit ? 2.6 : 1.7);

      drawDir.subVectors(beam.to, beam.from);
      const length = drawDir.length();
      if (length < 1e-4) continue;
      drawDir.multiplyScalar(1 / length);
      perpendiculars(drawDir, drawPerpA, drawPerpB);

      for (let i = 0; i < BEAM.coreSegments; i++) {
        const near = (i / BEAM.coreSegments) * length;
        const far = ((i + 1) / BEAM.coreSegments) * length;
        trace.push(
          beam.from.x + drawDir.x * near,
          beam.from.y + drawDir.y * near,
          beam.from.z + drawDir.z * near,
          beam.from.x + drawDir.x * far,
          beam.from.y + drawDir.y * far,
          beam.from.z + drawDir.z * far,
          PALETTE.trace,
          base * (1 - BEAM.coreTaper * ((i + 0.5) / BEAM.coreSegments)),
        );
      }

      // Four lines around the axis, converging as they go: the bore at the
      // muzzle, a point at the target. `0.15` rather than `0` so the far end
      // stays a narrow tube instead of pinching to a spike, which reads as an
      // arrow.
      const reach = length * BEAM.sheathReach;
      for (let k = 0; k < 4; k++) {
        const angle = (k * Math.PI) / 2;
        const ca = Math.cos(angle);
        const sa = Math.sin(angle);
        const ox = (drawPerpA.x * ca + drawPerpB.x * sa) * BEAM.sheathOffset;
        const oy = (drawPerpA.y * ca + drawPerpB.y * sa) * BEAM.sheathOffset;
        const oz = (drawPerpA.z * ca + drawPerpB.z * sa) * BEAM.sheathOffset;
        trace.push(
          beam.from.x + ox,
          beam.from.y + oy,
          beam.from.z + oz,
          beam.from.x + drawDir.x * reach + ox * 0.15,
          beam.from.y + drawDir.y * reach + oy * 0.15,
          beam.from.z + drawDir.z * reach + oz * 0.15,
          PALETTE.trace,
          base * BEAM.sheathLevel,
        );
      }

      const muzzle = Math.max(0, 1 - t / BEAM.muzzleLife);
      if (muzzle > 0) {
        star(
          trace,
          beam.from,
          drawDir,
          drawPerpA,
          drawPerpB,
          BEAM.muzzleSize * muzzle,
          PALETTE.trace,
          BEAM.muzzleLevel * muzzle,
        );
      }

      if (beam.hit) {
        // Spokes in the plane facing back down the beam, growing outward. The
        // grow term starts at 0.35 rather than 0 so the flare is already a
        // shape on the first frame — at 0.11 s of life there is no time for it
        // to arrive from nothing.
        const decay = Math.pow(1 - t, 1.5);
        const grow = 0.35 + t;
        for (let k = 0; k < BEAM.flareSpokes; k++) {
          const angle = beam.seed + (k / BEAM.flareSpokes) * Math.PI * 2;
          const ca = Math.cos(angle);
          const sa = Math.sin(angle);
          const dx = drawPerpA.x * ca + drawPerpB.x * sa;
          const dy = drawPerpA.y * ca + drawPerpB.y * sa;
          const dz = drawPerpA.z * ca + drawPerpB.z * sa;
          const inner = BEAM.flareInner * grow;
          const outer = BEAM.flareOuter * grow;
          trace.push(
            beam.to.x + dx * inner,
            beam.to.y + dy * inner,
            beam.to.z + dz * inner,
            beam.to.x + dx * outer,
            beam.to.y + dy * outer,
            beam.to.z + dz * outer,
            PALETTE.trace,
            BEAM.flareLevel * decay,
          );
        }
      }
    }
  }

  /** Detonations. See `WARHEAD_BURST`. */
  private drawBursts(trace: TraceBuffer): void {
    for (const burst of this.bursts) {
      const t = burst.life / burst.seconds;
      // Ease-out: a shell that expands linearly reads as a growing circle, one
      // that decelerates reads as a pressure wave running out of room.
      const radius = burst.radius * (1 - (1 - t) * (1 - t));
      const level = burst.level * Math.pow(1 - t, 1.6);
      if (level <= 0.01) continue;

      if (burst.ringSegments > 0) {
        // Two great circles: one on the plane the whole game is flown on, one
        // standing vertically at the burst's own seeded bearing so successive
        // detonations do not all present the same silhouette.
        this.ring(trace, burst, radius, level, 0);
        this.ring(trace, burst, radius, level, burst.seed);
      }

      for (let k = 0; k < burst.spikes; k++) {
        // A golden-angle spiral over the sphere. Uniform enough that ten spokes
        // never clump, deterministic from `seed` and the index alone, and it
        // needs no stored direction per spike.
        const y = 1 - (2 * (k + 0.5)) / burst.spikes;
        const ring = Math.sqrt(Math.max(0, 1 - y * y));
        const angle = burst.seed + k * 2.399963;
        const dx = Math.cos(angle) * ring;
        const dz = Math.sin(angle) * ring;
        trace.push(
          burst.at.x + dx * radius * 0.55,
          burst.at.y + y * radius * 0.55,
          burst.at.z + dz * radius * 0.55,
          burst.at.x + dx * radius * 1.2,
          burst.at.y + y * radius * 1.2,
          burst.at.z + dz * radius * 1.2,
          burst.color,
          level,
        );
      }
    }
  }

  /**
   * One great circle of a burst's shell. `bearing` 0 gives the horizontal ring
   * (the plane the game is flown on); any other value gives a vertical ring
   * standing at that bearing.
   */
  private ring(
    trace: TraceBuffer,
    burst: Burst,
    radius: number,
    level: number,
    bearing: number,
  ): void {
    const horizontal = bearing === 0;
    const sb = Math.sin(bearing);
    const cb = Math.cos(bearing);
    for (let i = 0; i <= burst.ringSegments; i++) {
      const a = (i / burst.ringSegments) * Math.PI * 2;
      if (horizontal) {
        drawPoint.set(
          burst.at.x + Math.sin(a) * radius,
          burst.at.y,
          burst.at.z + Math.cos(a) * radius,
        );
      } else {
        const flat = Math.cos(a) * radius;
        drawPoint.set(burst.at.x + sb * flat, burst.at.y + Math.sin(a) * radius, burst.at.z + cb * flat);
      }
      if (i > 0) {
        trace.push(
          drawPrev.x,
          drawPrev.y,
          drawPrev.z,
          drawPoint.x,
          drawPoint.y,
          drawPoint.z,
          burst.color,
          level,
        );
      }
      drawPrev.copy(drawPoint);
    }
  }

  clear(): void {
    this.projectiles.length = 0;
    this.beams.length = 0;
    this.streaks.length = 0;
    this.bursts.length = 0;
    // The queue goes too. A restart or a jump means the flash's cause is in a
    // sector the player is no longer in — `EventLights.clear` makes the same
    // argument about lights already burning.
    this.flashes.length = 0;
  }
}
