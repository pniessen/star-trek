import type { Fleet, Hostile } from "../game/hostiles.js";
import type { Ship } from "../game/Ship.js";

/**
 * What the scanner knows, as opposed to what is true.
 *
 * The scanner started as a readout: every contact drawn at its exact position
 * every frame, which is perfect information and therefore no skill at all. It
 * has to become an instrument, because the Shroud is unshootable until it
 * chooses otherwise and the only thing that can warn you is this tube.
 *
 * Two tiers, and the split is deliberate:
 *
 *  - **Resolved contacts** — anything with a hull you could shoot — are still
 *    drawn at their true position. The locked decision is that a planar world
 *    makes the scanner trustworthy, and a scanner that misplaces a Bastion
 *    breaks that for no gain. What degrades instead is *brightness*: a contact
 *    dims between sweeps and flares as the arm repaints it. You lose confidence
 *    over time, never accuracy.
 *
 *  - **Unresolved returns** — a cloaked hull — exist only when the arm crosses
 *    them, are placed with a real positional error, and decay away. The error
 *    is drawn as the circle it actually is, and the offset is always smaller
 *    than the circle, so the true contact is genuinely somewhere inside the
 *    mark. The scanner admits what it does not know rather than lying about it.
 *
 * The consequence is the thing worth having: three returns in a row, each ring
 * tighter than the last, is a Shroud closing on you, and reading that before it
 * materialises is the whole skill of the class.
 *
 * No false returns. Ambiguity here comes from staleness and error, which teach
 * you something; a phantom would only teach you to distrust the one instrument
 * the game has promised is honest.
 */

export const SCANNER = {
  range: 150,
  /**
   * Radians per second. One revolution every ~1.5s: fast enough that a cloaked
   * contact repaints two or three times while it closes, slow enough that the
   * arm reads as a sweep rather than a strobe.
   */
  sweepRate: 4.2,
  /** How long a return stays on the tube after the arm last painted it. */
  ghostLife: 3.2,
  /** Positional uncertainty at the rim, and at point-blank. */
  errorFar: 26,
  errorNear: 5,
  /** How faint a resolved contact gets just before the arm comes back round. */
  faintest: 0.5,
  /** A return this fresh lights the annunciator. */
  alertAge: 1.8,
} as const;

export interface Ghost {
  readonly x: number;
  readonly z: number;
  /** Metres of uncertainty. The true contact is somewhere inside this. */
  readonly spread: number;
  age: number;
}

const MAX_GHOSTS = 24;

export class ScannerModel {
  readonly ghosts: Ghost[] = [];

  /** Screen-space angle of the sweep arm, radians. Decreases: the arm runs clockwise. */
  arm = Math.PI / 2;

  /** Seconds since the arm last crossed each resolved contact. */
  private readonly painted = new Map<Hostile, number>();
  private live = new Set<Hostile>();

  update(dt: number, player: Ship, fleet: Fleet): void {
    const previous = this.arm;
    this.arm = wrap(this.arm - SCANNER.sweepRate * dt);

    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      this.ghosts[i].age += dt;
      if (this.ghosts[i].age >= SCANNER.ghostLife) this.ghosts.splice(i, 1);
    }

    const cos = Math.cos(player.heading);
    const sin = Math.sin(player.heading);

    this.live = new Set(fleet.hostiles);
    for (const hostile of this.painted.keys()) {
      if (!this.live.has(hostile)) this.painted.delete(hostile);
    }

    for (const hostile of fleet.hostiles) {
      this.painted.set(hostile, (this.painted.get(hostile) ?? 0) + dt);

      const dx = hostile.position.x - player.position.x;
      const dz = hostile.position.z - player.position.z;
      const range = Math.hypot(dx, dz);
      if (range > SCANNER.range) continue;

      // Same transform the scanner draws with: forward is up, right is right.
      const bearing = Math.atan2(dx * sin + dz * cos, dx * cos - dz * sin);
      if (!crossed(previous, this.arm, bearing)) continue;

      this.painted.set(hostile, 0);
      if (hostile.cloak > 0.05) this.paintGhost(hostile, range);
    }
  }

  /** 1 just after the arm painted it, falling to 0 by the time the arm is due back. */
  freshness(hostile: Hostile): number {
    const period = (Math.PI * 2) / SCANNER.sweepRate;
    return 1 - Math.min(1, (this.painted.get(hostile) ?? period) / period);
  }

  /** True while any return is new enough to be worth acting on. */
  get alert(): boolean {
    return this.ghosts.some((ghost) => ghost.age < SCANNER.alertAge);
  }

  reset(): void {
    this.ghosts.length = 0;
    this.painted.clear();
  }

  private paintGhost(hostile: Hostile, range: number): void {
    if (this.ghosts.length >= MAX_GHOSTS) this.ghosts.shift();

    // Error falls with range — a Shroud on top of you paints a tight ring, which
    // is the last warning before it materialises — and with cloak strength, so
    // the wind-up itself is visible on the tube as the ring snapping shut.
    const t = range / SCANNER.range;
    const spread =
      (SCANNER.errorNear + (SCANNER.errorFar - SCANNER.errorNear) * t) * hostile.cloak;

    // Offset inside the disc rather than anywhere on it, so the drawn circle
    // always contains the truth.
    const angle = Math.random() * Math.PI * 2;
    const offset = Math.sqrt(Math.random()) * spread;
    this.ghosts.push({
      x: hostile.position.x + Math.cos(angle) * offset,
      z: hostile.position.z + Math.sin(angle) * offset,
      spread: Math.max(spread, 2),
      age: 0,
    });
  }
}

function wrap(angle: number): number {
  let a = (angle + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/**
 * Did the arm sweep past `bearing` this frame? Tested as a sign change rather
 * than as "is the bearing within a beam width", because the frame budget is
 * clamped at 50ms and at that step a fixed-width beam skips contacts entirely —
 * a return that vanishes on a slow machine is the same bug as a trail that
 * lengthens on one.
 */
function crossed(from: number, to: number, bearing: number): boolean {
  return wrap(from - bearing) >= 0 && wrap(to - bearing) < 0;
}
