import { Color, Vector3 } from "three";
import { PALETTE } from "../render/palette.js";
import { NO_REFITS, type Loadout } from "../chart/economy.js";
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
  cost: 0.022,
  cooldown: 0.16,
  damage: 0.34,
  /** Full damage inside this range, tailing to zero at `falloffEnd`. */
  falloffStart: 26,
  falloffEnd: 78,
  /** Half-angle of the assist cone, radians. Aim is the nose, not a cursor. */
  aimCone: 0.13,
} as const;

export const TORPEDO = {
  cooldown: 0.62,
  damage: 1.35,
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
}

/** A phaser discharge, kept only long enough to be drawn. */
interface Beam {
  readonly from: Vector3;
  readonly to: Vector3;
  life: number;
  readonly hit: boolean;
}

const BEAM_LIFE = 0.11;

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
 */
export function sweepHits(projectile: Projectile, target: Vector3, radius: number): boolean {
  sweepStep.subVectors(projectile.position, projectile.previous);
  sweepToTarget.subVectors(target, projectile.previous);

  const lengthSq = sweepStep.lengthSq();
  // A projectile that has not moved yet — its first frame — is just a point.
  if (lengthSq < 1e-9) return sweepToTarget.lengthSq() <= radius * radius;

  // Clamped so the segment stays a segment: a target behind the muzzle or
  // beyond this frame's travel is not hit by it.
  const t = Math.max(0, Math.min(1, sweepToTarget.dot(sweepStep) / lengthSq));
  sweepStep.multiplyScalar(t);
  return sweepToTarget.distanceToSquared(sweepStep) <= radius * radius;
}

export class Ordnance {
  readonly projectiles: Projectile[] = [];
  private readonly beams: Beam[] = [];
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
    });
  }

  discharge(from: Vector3, to: Vector3, hit: boolean): void {
    this.beams.push({ from: from.clone(), to: to.clone(), life: 0, hit });
  }

  update(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life += dt;
      p.previous.copy(p.position);
      p.position.addScaledVector(p.velocity, dt);
      p.position.y = 0;
      if (p.dead || p.life >= p.maxLife) this.projectiles.splice(i, 1);
    }
    for (let i = this.beams.length - 1; i >= 0; i--) {
      this.beams[i].life += dt;
      if (this.beams[i].life >= BEAM_LIFE) this.beams.splice(i, 1);
    }
  }

  draw(trace: TraceBuffer): void {
    for (const p of this.projectiles) {
      // Draw along the direction of travel: a streak reads as speed, and its
      // length tells you how fast the thing coming at you is moving.
      const length = p.kind === "torpedo" ? 2.6 : 1.5;
      const back = p.velocity.clone().normalize().multiplyScalar(-length);
      const color = p.kind === "torpedo" ? this.torpedoColor : this.boltColor;
      const fade = 1 - Math.pow(p.life / p.maxLife, 6); // holds bright, dies fast
      trace.push(
        p.position.x,
        p.position.y,
        p.position.z,
        p.position.x + back.x,
        p.position.y + back.y,
        p.position.z + back.z,
        color,
        (p.kind === "torpedo" ? 2.4 : 1.7) * fade,
      );
    }

    for (const beam of this.beams) {
      // Flicker as it discharges rather than fading smoothly — a clean fade
      // reads as a laser pointer, a flicker reads as something arcing.
      const t = beam.life / BEAM_LIFE;
      const intensity = (1 - t) * (0.65 + Math.random() * 0.6) * (beam.hit ? 2.6 : 1.7);
      trace.push(
        beam.from.x,
        beam.from.y,
        beam.from.z,
        beam.to.x,
        beam.to.y,
        beam.to.z,
        PALETTE.trace,
        intensity,
      );
    }
  }

  clear(): void {
    this.projectiles.length = 0;
    this.beams.length = 0;
  }
}
