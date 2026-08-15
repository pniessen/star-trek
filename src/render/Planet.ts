import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from "three";
import { makeRng } from "../chart/rng.js";
import { VectorObject } from "./VectorObject.js";

/**
 * The ringed planet, as an actual object in the world rather than a picture of
 * one on the sky.
 *
 * It has been through two vocabularies already and failed both. As a flat disc
 * on the camera-pinned backdrop it read as a diagram; rebuilt at limb scale it
 * lost its rings entirely. Test play named the real problem: it "just looks fake,
 * as it's plastered there and doesn't really change". Both attempts shared one
 * cause — `Backdrop` deliberately never translates, so no amount of drawing skill
 * could make a body shift against its neighbours, and *shifting* is what tells
 * an eye that something is a solid object at a distance rather than paint.
 *
 * So this one is not on the backdrop at all. It is a sphere and a ring in world
 * space, at a fixed point in the sector, and everything about how it looks falls
 * out of where the camera happens to be. Fly across the sector and its bearing
 * changes, its rings open and close, the far half of the ring passes behind it.
 * None of that is animated; it is just true.
 *
 * **The camera's far plane is the whole design constraint.** It is 2000 units
 * (`Stage`), so a planet has to live inside that, and a run covers many thousands
 * of units — which means a real object at a real distance would be something you
 * fly past and eventually into. Two answers, and the second is the one taken:
 *
 *  - Raise the far plane and add a logarithmic depth buffer. Correct, and not
 *    worth introducing blind into a renderer whose every line is a fat-line
 *    shader.
 *  - Leash it. The planet sits at a real point and behaves like a real object
 *    right up until you get closer than `minRange`, at which point it holds that
 *    distance. Approaching one for half a minute makes it visibly larger, which is
 *    the payoff; it just never lets you arrive. That is a lie, and a smaller one
 *    than a sky that never moves at all.
 *
 * Drawn in the house idiom through `VectorObject` — glowing edges over near-void
 * opaque faces — because that is the locked decision every hull already obeys and
 * because it is what makes the ring's far half occlude correctly with no
 * hand-managed draw order. The old backdrop ring needed a painter's trick for
 * exactly the reason this one does not: it had no depth.
 */
export const PLANET = {
  /**
   * Where it sits, in units. Well inside the 2000 far plane with room for the
   * ring's outer edge, and far enough that the leash rarely engages.
   */
  range: 1700,
  /**
   * How close the player may get before it starts holding station.
   *
   * 520, not 1150. The first figure left barely five hundred units of genuine
   * approach before the leash took over, so almost all of the payoff — a planet
   * that visibly grows because you flew at it — was clamped away. At 520 the body
   * closes to about twenty degrees across and its rings span more than the frame,
   * and every bit of that is real perspective rather than a tween.
   */
  minRange: 520,
  /** World radius of the body. About seven degrees across at `range`. */
  radius: 190,
  /** Ring extent, as multiples of the body's radius. */
  ringInner: 1.42,
  ringOuter: 2.25,
  /** Strands drawn across the ring, and the two gaps punched through them. */
  strands: 14,
  /** Latitude/longitude divisions on the body. Low: this is a stroke renderer. */
  segments: 26,
  rings: 16,
  /**
   * How high above the plane it sits, in units. Positive so it clears the grid
   * rather than sitting behind it, and modest so it is not overhead — the cameras
   * pitch down and cannot look up, which this file is the fourth thing to learn.
   */
  height: 210,
} as const;

/**
 * One planet, per sector, from the seed.
 *
 * Not every sector gets one — a ringed giant in every square is furniture. The
 * placement is a bearing rather than a coordinate, so the planet is always the
 * same distance out whichever way the sector is entered.
 */
interface PlanetPlan {
  bearing: number;
  /** Radians the ring plane is tilted from the ecliptic. Never near zero. */
  tilt: number;
  scale: number;
  colour: Color;
}

function planPlanet(seed: number, sector: number): PlanetPlan {
  // A different mix from the backdrop's, so a sector's sky and its planet are not
  // correlated — the same square should not always pair the same two things.
  const rng = makeRng((seed * 2654435761 + sector * 40503 + 977) >>> 0);
  // The allocator (`render/scenery.ts`'s `planHero`) decides whether this sector
  // gets a ringed planet at all now, not this roll — but the draw stays, discarded,
  // so every value below it is unchanged for every sector that used to pass the
  // old `> 0.38` cutoff. Deleting the roll without keeping its draw would shift
  // bearing/tilt/scale/hue for every one of them.
  rng.next();

  const hue = 24 + rng.next() * 26;
  return {
    bearing: rng.next() * Math.PI * 2,
    // Kept clear of edge-on: a ring seen exactly side-on is a line, and a player
    // who happens to arrive at that bearing would see a planet with no rings.
    tilt: (0.28 + rng.next() * 0.5) * (rng.next() < 0.5 ? -1 : 1),
    // Promoted from furniture to hero: the frame's owner, so it reads as the
    // thing the sector is about rather than something passed on the way to it.
    // First-draft constant, tuning list like all the rest.
    scale: 1.5 + rng.next() * 0.7,
    colour: new Color().setHSL(hue / 360, 0.34, 0.52, SRGBColorSpace),
  };
}

/** The ring: concentric strands in the body's own tilted plane, with divisions. */
function buildRing(radius: number, tilt: number, colour: Color): LineSegments {
  const points: number[] = [];
  const colours: number[] = [];
  const tint = new Color();
  const steps = 96;
  const tilted = new Matrix4().makeRotationX(Math.PI / 2 - tilt);
  const at = new Vector3();

  for (let i = 0; i < PLANET.strands; i++) {
    const t = i / (PLANET.strands - 1);
    // Two divisions, skipped rather than dimmed. A ring system is known by its
    // gaps, which is the lesson the backdrop's version was rebuilt around.
    if ((t > 0.36 && t < 0.45) || (t > 0.74 && t < 0.79)) continue;
    const r = radius * (PLANET.ringInner + (PLANET.ringOuter - PLANET.ringInner) * t);
    const bright = (0.4 + 0.5 * Math.abs(Math.sin(i * 1.911 + tilt * 4))) * (1 - 0.3 * t);
    tint.copy(colour).multiplyScalar(bright);

    let px = 0;
    let py = 0;
    let pz = 0;
    for (let j = 0; j <= steps; j++) {
      const a = (j / steps) * Math.PI * 2;
      at.set(Math.cos(a) * r, Math.sin(a) * r, 0).applyMatrix4(tilted);
      if (j > 0) {
        points.push(px, py, pz, at.x, at.y, at.z);
        for (let k = 0; k < 2; k++) colours.push(tint.r, tint.g, tint.b);
      }
      px = at.x;
      py = at.y;
      pz = at.z;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(points), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colours), 3));
  return new LineSegments(
    geometry,
    new LineBasicMaterial({
      vertexColors: true,
      blending: AdditiveBlending,
      transparent: true,
      // Tested but not written: the body writes depth and occludes the far half of
      // the ring, which is the entire reason this is real geometry. The ring
      // occluding itself would only produce seams.
      depthTest: true,
      depthWrite: false,
      fog: false,
    }),
  );
}

export class Planet {
  readonly object = Object.assign(new Group(), { name: "planet" });

  private key = "";
  private plan: PlanetPlan | null = null;
  private body: VectorObject | null = null;
  /** Where it would be if nothing were leashing it. */
  private readonly anchor = new Vector3();

  /** Rebuild for a sector, if it is not already the one standing. */
  show(seed: number, sector: number): void {
    const key = `${seed}:${sector}`;
    if (key === this.key) return;
    this.key = key;
    this.clear();
    this.plan = planPlanet(seed, sector);
    if (!this.plan) return;

    const radius = PLANET.radius * this.plan.scale;
    this.body = new VectorObject(new SphereGeometry(radius, PLANET.segments, PLANET.rings), {
      color: this.plan.colour,
      linewidth: 1.3,
    });
    // Before the camera-pinned sky in draw order, so the sky's own bodies — which
    // are nearer, at 620 — depth-test against the depth this writes and correctly
    // draw over it. Ships and the grid are nearer still and do the same.
    this.body.group.traverse((child) => {
      child.renderOrder = -1.97;
    });
    this.object.add(this.body.group);
    this.object.add(buildRing(radius, this.plan.tilt, this.plan.colour));
    this.object.traverse((child) => {
      if (child !== this.object && child.renderOrder === 0) child.renderOrder = -1.96;
    });

    this.anchor.set(
      Math.sin(this.plan.bearing) * PLANET.range,
      PLANET.height,
      Math.cos(this.plan.bearing) * PLANET.range,
    );
    this.object.position.copy(this.anchor);
  }

  /**
   * Hold station if the player has come too close, and otherwise stand still.
   *
   * The leash is the one dishonest thing here and it is bounded: outside
   * `minRange` this does nothing at all, so every bit of parallax, every change of
   * ring aspect and every change of apparent size on the way in is real. It only
   * engages at the point where the alternative is flying through a planet.
   */
  follow(player: Vector3): void {
    if (!this.plan) return;
    const dx = this.anchor.x - player.x;
    const dz = this.anchor.z - player.z;
    const flat = Math.hypot(dx, dz);
    if (flat >= PLANET.minRange || flat < 1e-3) {
      this.object.position.copy(this.anchor);
      return;
    }
    const push = PLANET.minRange / flat;
    this.object.position.set(
      player.x + dx * push,
      PLANET.height,
      player.z + dz * push,
    );
  }

  setMode(mode: Parameters<VectorObject["setMode"]>[0]): void {
    this.body?.setMode(mode);
  }

  /** Empty the group and forget the sector, so the next `show` rebuilds. */
  hide(): void {
    if (this.key === "") return;
    this.key = "";
    this.clear();
  }

  private clear(): void {
    this.body?.dispose();
    this.body = null;
    for (const child of [...this.object.children]) {
      this.object.remove(child);
      const mesh = child as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } };
      mesh.geometry?.dispose();
      mesh.material?.dispose();
    }
  }
}
