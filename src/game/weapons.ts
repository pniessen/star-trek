import { Color, Vector3 } from "three";
import { PALETTE } from "../render/palette.js";
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
  speed: 74,
  life: 2.6,
  capacity: 12,
} as const;

export const BOLT = {
  damage: 0.3,
  speed: 46,
  life: 3.4,
} as const;

export function phaserDamageAt(distance: number): number {
  if (distance <= PHASER.falloffStart) return PHASER.damage;
  if (distance >= PHASER.falloffEnd) return 0;
  const t = (distance - PHASER.falloffStart) / (PHASER.falloffEnd - PHASER.falloffStart);
  return PHASER.damage * (1 - t);
}

export interface Projectile {
  readonly position: Vector3;
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
