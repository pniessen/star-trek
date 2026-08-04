import { Vector3 } from "three";
import { sound } from "../audio/sound.js";
import { PALETTE } from "../render/palette.js";
import type { TraceBuffer } from "../render/TraceBuffer.js";
import type { Ship } from "./Ship.js";
import { bearingOffset, sweepHits, type Projectile } from "./weapons.js";

/**
 * The minefield: the one thing in the game that is dangerous without being
 * alive.
 *
 * Every other threat tracks you, which means every other threat can be
 * out-turned. A mine does nothing at all — it sits where it was dropped and
 * waits for you to fly the line you were always going to fly. That makes it the
 * only hazard that punishes a habit rather than a mistake, and it is why the
 * Harrow leads its drops onto the course you are already holding instead of
 * aiming at where you are.
 *
 * Mines persist across waves. Space accumulates a history of the run, and by
 * wave ten the sector you have been circling is the sector you can no longer
 * circle.
 *
 * **They stay on the floor, and that is what altitude is for.** A field is now
 * something you can fly over — and this needed no code, which is the pleasing
 * part: the trigger and the blast are both `distanceTo`, which has always been
 * three-dimensional, so six and a half units of height clears the trigger and
 * thirteen clears the damage entirely. Climbing costs energy for as long as you
 * hold it, so "fly over the field" trades the reserve for the shots you would
 * otherwise have spent clearing a lane. That is the trade the slab exists for,
 * and it is the one place in the game where it is unambiguous.
 */

export const MINE = {
  /** Dead for this long after being laid. A mine dropped on your nose is not a decision. */
  arm: 1.3,
  /**
   * Lifetime. Long enough that the field genuinely accumulates, short enough
   * that a long run never becomes a maze you cannot fly at all.
   */
  life: 46,
  /** Proximity trigger. */
  trigger: 6.5,
  /** Damage reaches zero at this radius. */
  blast: 13,
  damage: 0.62,
  /** A point-blank phaser shot is 0.34, so two clear one; a torpedo always does. */
  hull: 0.6,
  /** Salvage for clearing one. Deliberately small — mine-farming is not a strategy. */
  value: 15,
  /** Beat between taking a fatal hit and going off, so the cause is legible. */
  shotFuse: 0.06,
  /** Neighbours light this fuse, so a cluster reads as a run rather than a flash. */
  chainFuse: 0.14,
} as const;

const BLAST_LIFE = 0.55;
const MAX_MINES = 120;
/** Body radius, in world units. */
const R = 1.5;

export interface Mine {
  readonly position: Vector3;
  readonly seed: number;
  age: number;
  hull: number;
  armed: boolean;
  /** Counting down to detonation once lit; zero or less means inert. */
  fuse: number;
  /** Non-zero briefly after being shot, so the strokes flash. */
  flash: number;
}

interface Blast {
  readonly position: Vector3;
  age: number;
}

export class Minefield {
  readonly mines: Mine[] = [];
  private readonly blasts: Blast[] = [];

  get count(): number {
    return this.mines.length;
  }

  lay(position: Vector3): void {
    if (this.mines.length >= MAX_MINES) return;
    this.mines.push({
      position: position.clone().setY(0),
      seed: Math.random() * Math.PI * 2,
      age: 0,
      hull: MINE.hull,
      armed: false,
      fuse: 0,
      flash: 0,
    });
    sound.mineLay(position.x, position.z);
  }

  /** @param onHull called when a detonation gets past a shield facing. */
  update(dt: number, player: Ship, onHull: () => void): void {
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      this.blasts[i].age += dt;
      if (this.blasts[i].age >= BLAST_LIFE) this.blasts.splice(i, 1);
    }

    // Pulled out of the list before anything goes off, so a chain can never
    // re-trigger a mine that is already detonating.
    const going: Mine[] = [];

    for (let i = this.mines.length - 1; i >= 0; i--) {
      const mine = this.mines[i];
      mine.age += dt;
      mine.armed = mine.age >= MINE.arm;
      mine.flash = Math.max(0, mine.flash - dt * 4);

      if (mine.age >= MINE.life) {
        this.mines.splice(i, 1); // burns out quietly; only a trigger detonates
        continue;
      }

      if (mine.fuse > 0) {
        mine.fuse -= dt;
        if (mine.fuse <= 0) {
          this.mines.splice(i, 1);
          going.push(mine);
        }
        continue;
      }

      if (mine.armed && mine.position.distanceTo(player.position) < MINE.trigger) {
        this.mines.splice(i, 1);
        going.push(mine);
      }
    }

    for (const mine of going) this.detonate(mine, player, onHull);
  }

  /** Nearest mine within `radius` of a point — projectile resolution. */
  /**
   * The nearest mine a projectile's travel this frame passed through.
   *
   * Mines do not move, but torpedoes cover up to 3.7 units in a clamped frame
   * against a 4.8-unit-wide mine, so a point test skips them for the same
   * reason it skipped hostiles — see `Projectile.previous`.
   */
  interceptSwept(projectile: Projectile, radius: number): Mine | null {
    let best: Mine | null = null;
    let bestDistance = Infinity;
    for (const mine of this.mines) {
      if (!sweepHits(projectile, mine.position, radius)) continue;
      // Nearest to where the shot came from, so a line of mines detonates from
      // the near end rather than the middle.
      const distance = mine.position.distanceTo(projectile.previous);
      if (distance > bestDistance) continue;
      best = mine;
      bestDistance = distance;
    }
    return best;
  }

  intercept(point: Vector3, radius: number): Mine | null {
    let best: Mine | null = null;
    let bestDistance = radius;
    for (const mine of this.mines) {
      const distance = mine.position.distanceTo(point);
      if (distance > bestDistance) continue;
      best = mine;
      bestDistance = distance;
    }
    return best;
  }

  /**
   * Closest mine inside the aim cone. Mirrors the hostile scan in `session`, so
   * a mine sitting between you and a Raider eats the beam meant for the Raider —
   * which is exactly the tax the field is supposed to levy.
   *
   * Mirrors it in the *bearing* sense too, and has to: the field lies on the
   * floor and the ship may be fourteen units above it, and a cone measured as a
   * solid angle would quietly stop the phaser being able to clear a lane the
   * moment the player climbed. The beam still runs to the mine's real position
   * and the falloff is still charged on the real range, so shooting a field from
   * height costs damage — it just does not cost the ability to aim.
   */
  aim(
    origin: Vector3,
    forward: Vector3,
    cone: number,
    maxRange: number,
  ): { mine: Mine; distance: number } | null {
    let best: { mine: Mine; distance: number } | null = null;
    for (const mine of this.mines) {
      const toTarget = mine.position.clone().sub(origin);
      const distance = toTarget.length();
      if (distance > maxRange || distance < 1e-3) continue;
      if (bearingOffset(forward, toTarget.x, toTarget.z) > cone + R / distance) continue;
      if (!best || distance < best.distance) best = { mine, distance };
    }
    return best;
  }

  /** @returns true if the hit was fatal and the mine is now on a fuse. */
  strike(mine: Mine, amount: number): boolean {
    if (mine.fuse > 0) return false;
    mine.hull -= amount;
    mine.flash = 1;
    if (mine.hull > 0) return false;
    mine.fuse = MINE.shotFuse;
    return true;
  }

  clear(): void {
    this.mines.length = 0;
    this.blasts.length = 0;
  }

  private detonate(mine: Mine, player: Ship, onHull: () => void): void {
    this.blasts.push({ position: mine.position.clone(), age: 0 });
    // A chain arrives as a run of blasts spaced by the fuse, which is exactly
    // what the fuse was for: the voice pool turns a cluster into a sequence
    // rather than one clipped bang.
    sound.mineBlast(mine.position.x, mine.position.z);

    const distance = mine.position.distanceTo(player.position);
    if (distance < MINE.blast) {
      // Holds close to full damage well out and then drops away, so clipping
      // the edge of a blast is a scare and sitting on one is not.
      const falloff = 1 - Math.pow(distance / MINE.blast, 1.6);
      if (player.takeHit(MINE.damage * falloff, mine.position)) onHull();
    }

    for (const other of this.mines) {
      if (other.fuse > 0) continue;
      if (other.position.distanceTo(mine.position) < MINE.blast * 0.8) other.fuse = MINE.chainFuse;
    }
  }

  /**
   * A ring lying on the deck plus a spike through it: the ring says where on
   * the plane it is, the spike is what you actually see from the cockpit, where
   * everything flat collapses onto the horizon.
   *
   * The wink rate is the whole warning. It idles slowly and accelerates as you
   * close, so a mine you are about to hit is strobing before you hit it.
   */
  draw(trace: TraceBuffer, player: Ship): void {
    for (const mine of this.mines) {
      const { x, z } = mine.position;
      const spin = mine.seed + mine.age * 0.7;
      const ageing = Math.min(1, (MINE.life - mine.age) / 8);

      let level = 0.45 * ageing;
      if (mine.armed) {
        const near = 1 - Math.min(1, mine.position.distanceTo(player.position) / (MINE.trigger * 4));
        const rate = 3 + near * 16;
        level = (0.45 + 0.55 * Math.sin(mine.age * rate)) * (0.7 + near * 1.9) * ageing;
      }
      level = Math.max(level, 0.12) + mine.flash * 2.2;

      for (let i = 0; i < 4; i++) {
        const a0 = spin + (i / 4) * Math.PI * 2;
        const a1 = spin + ((i + 1) / 4) * Math.PI * 2;
        trace.push(
          x + Math.cos(a0) * R,
          0,
          z + Math.sin(a0) * R,
          x + Math.cos(a1) * R,
          0,
          z + Math.sin(a1) * R,
          PALETTE.harrow,
          level,
        );
      }

      trace.push(x, -R * 0.9, z, x, R * 0.9, z, PALETTE.harrow, level);
      if (!mine.armed) continue;
      // The armed cross only appears once it can hurt you.
      const arm = R * 0.55;
      trace.push(x - arm, arm, z, x + arm, -arm, z, PALETTE.harrow, level);
      trace.push(x - arm, -arm, z, x + arm, arm, z, PALETTE.harrow, level);
    }

    for (const blast of this.blasts) {
      const t = blast.age / BLAST_LIFE;
      const radius = MINE.blast * (0.2 + t * 0.9);
      const level = (1 - t) * (1 - t) * 3.4;
      const { x, z } = blast.position;

      const steps = 14;
      for (let i = 0; i < steps; i++) {
        const a0 = (i / steps) * Math.PI * 2;
        const a1 = ((i + 1) / steps) * Math.PI * 2;
        trace.push(
          x + Math.cos(a0) * radius,
          0,
          z + Math.sin(a0) * radius,
          x + Math.cos(a1) * radius,
          0,
          z + Math.sin(a1) * radius,
          PALETTE.harrow,
          level,
        );
      }
      // Spokes standing off the plane, so the blast has volume from the cockpit.
      for (let i = 0; i < 5; i++) {
        const a = blast.age * 3 + (i / 5) * Math.PI * 2;
        trace.push(
          x,
          0,
          z,
          x + Math.cos(a) * radius * 0.8,
          radius * 0.45,
          z + Math.sin(a) * radius * 0.8,
          PALETTE.harrow,
          level * 0.7,
        );
      }
    }
  }
}
