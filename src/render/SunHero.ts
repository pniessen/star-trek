import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import { makeRng } from "../chart/rng.js";
import type { SectorLight } from "./light.js";

/**
 * The hero sun — scenery task 3, cast by `planHero` at `"sun"`'s own weight
 * in `render/scenery.ts`'s `ROSTER`. `docs/environment.md` §5 states the
 * character in five words: "no surface — it *is* light." Every other hero
 * body (`GasGiant`, `Moon`, `Planet`'s ring) is something the sector's star
 * lights; this body *is* that star, drawn at the exact bearing `light.ts`
 * already put it at, so the one thing every lit body in the sector agrees
 * on — where the light comes from — is also where this disc sits. There is
 * nothing to shade here: no terminator, no `ShaderMaterial`, no
 * `uLightDirWorld` uniform. A plain `MeshBasicMaterial` core pushed past
 * the post chain's bloom threshold, plus additive discs and streamers for
 * the halo, is the entire recipe (§3.2: "bloom is the atmosphere," spent
 * here as literally as the phrase allows).
 *
 * Two things that carry over from `GasGiant`/`Moon` and one that does not:
 *
 * - The **key-cache idiom** (`show` is a no-op unless the sector changed),
 *   `clear()`/`hide()` with disposal, and `fog: false` on every material —
 *   this body sits at `SUN_HERO.range` from the *player*, always well past
 *   `Stage`'s fog far plane, so the same trap `GasGiant.ts`'s own header
 *   warns about applies here too.
 * - The `renderOrder` convention `Planet.ts`'s ring, `GasGiant.body`
 *   (-1.98) and `Moon.body` (-1.97) share: behind the camera-pinned sky's
 *   nearer bodies, ahead of nothing. This body claims -1.96 for its core
 *   and -1.955/-1.95 for the halo/streamers layered in front of it — never
 *   coincides with the others in the same frame, since `main.ts`'s hero
 *   block is one exclusive `if`/`else` chain.
 * - **What does not carry over: the anchor/leash.** `GasGiant`/`Moon` hold
 *   station at a fixed *world* point and only yield if the player closes
 *   inside `minRange`. A sun has no such point — it is "effectively at
 *   infinity" (the brief's own words), so `follow` re-anchors the whole
 *   group on the player's own position every frame instead, at a fixed
 *   offset along the light's bearing. That offset never shrinks no matter
 *   how the player flies, which is what "never parallaxes closer" means in
 *   practice: there is no leash to hit because there is no fixed point to
 *   approach.
 */
export const SUN_HERO = {
  // ── placement and scale ───────────────────────────────────────────────

  /** Distance from the player, in units — inside the 2000-unit far plane
   * (`docs/environment.md` §4.2), well outside every engagement range this
   * game has (14-78, per `CLAUDE.md`'s altitude write-up), so the disc
   * never has to compete with combat for screen space and never reads as
   * a target. Re-applied along `light.position`'s own bearing every frame
   * in `follow`, not just once in `show` — see this file's header. */
  range: 850,

  /** World radius of the core sphere. Small on purpose: at `range` units
   * out this already subtends a few degrees, and the *halo* — not the
   * core's own tessellation — is what is supposed to dominate the frame
   * (§3.2), the opposite emphasis from the giant's genuinely-scaled body
   * (§3.5). A bigger core would fight the bloom for the eye instead of
   * feeding it. */
  coreRadius: 26,
  /** Lat/lon divisions on the core. Modest — the sphere is a light source,
   * never examined for surface detail the way a moon's crater field is,
   * so all it owes the silhouette is roundness. */
  coreWidthSegments: 24,
  coreHeightSegments: 16,

  // ── halo ───────────────────────────────────────────────────────────────
  // Two concentric additive discs rather than a shader-driven fresnel shell
  // (`GasGiant.limb`'s own approach): a sun has no surface normal to base a
  // fresnel term on, and bloom (§3.2) is already the entire mechanism —
  // two flat, faint, additively-blended circles behind the bright core give
  // the post chain everything it needs to bloom a glow, at a fraction of
  // `GasGiant.limb`'s shader cost.

  /** Halo disc radii, as multiples of `coreRadius`. */
  haloInnerScale: 2.2,
  haloOuterScale: 4,
  /** Halo disc opacities, inner then outer — the outer ring fainter, since
   * additive blending sums the two and an equally-bright pair would read
   * as a single hard-edged step rather than a soft falloff. */
  haloInnerOpacity: 0.22,
  haloOuterOpacity: 0.1,
  /** Circle segment count. Far below `Backdrop`'s own 128-gon limb — that
   * one fills the frame edge to edge and would facet visibly at a lower
   * count; this disc never gets that close. */
  haloSegments: 48,

  // ── corona streamers ──────────────────────────────────────────────────
  // Faint radial spokes, not a ring's worth of dense filaments (§3.3 does
  // not apply the same way here — the streamers are a texture cue for the
  // corona's own raggedness, not the primary source of the body's read the
  // way the giant's belts or the moon's craters are).

  /** How many spokes, jittered per sector between these two — never the
   * same corona twice. */
  streamerCountMin: 10,
  streamerCountMax: 14,
  /** Each spoke's own angle is jittered off its evenly-spaced base by up to
   * this many radians either way, so the spokes read as ragged rather than
   * a rigid pinwheel. */
  streamerAngleJitter: 0.22,
  /** Spoke length, as a multiple of `coreRadius` beyond the inner halo
   * disc's own edge — rolled per spoke so the corona's silhouette is
   * uneven, not a uniform starburst. */
  streamerLengthMin: 2,
  streamerLengthMax: 5,
  /** Faint — streamers are a texture on top of the halo's own glow, never
   * competing with it. */
  streamerOpacity: 0.14,
  /** Radians per second the streamers turn, `dt`-based — the brief's own
   * number. Nothing else here animates: the core and halo discs are
   * static shapes, and "nothing pulses" (the brief's own words) rules out
   * an opacity or scale animation as the motion cue instead. */
  rotationRate: 0.02,
} as const;

/**
 * One hero sun. `main.ts` holds a single instance beside `giant`/`moon` and
 * only calls `show`/`follow`/`update` while `sectorHero === "sun"`, `hide()`
 * otherwise — see that file's hero block.
 */
export class SunHero {
  readonly object = Object.assign(new Group(), { name: "sun" });

  /** The bright core — public for the same reason `GasGiant.body` is: a
   * harness can read the geometry/material directly without this class
   * inventing an indirection just to be testable. */
  core: Mesh | null = null;
  /** The two additive halo discs. */
  haloInner: Mesh | null = null;
  haloOuter: Mesh | null = null;
  /** The corona streamers. */
  streamers: LineSegments | null = null;

  private key = "";
  /** The light's own bearing, unit length — what `follow` re-projects the
   * whole group along every frame. Stored here rather than re-read from a
   * `SectorLight` `follow` is never handed, the same reason `Moon`'s own
   * `anchor` is a field rather than a parameter. */
  private readonly direction = new Vector3();

  /**
   * Rebuild for a sector, if it is not already the one standing. `light` is
   * the sector's own `SectorLight` — the same object `main.ts` hands the
   * giant and the moon, so this is still the one place a sector's star gets
   * rolled.
   */
  show(seed: number, sector: number, light: SectorLight): void {
    const key = `${seed}:${sector}`;
    if (key === this.key) return;
    this.key = key;
    this.clear();

    // A hash mix distinct from every other one this game rolls a sector
    // feature with — scenery's own (1103515245/12820163/53231), light's
    // (1274126177/741103597/1013904223), Planet's (2654435761/40503/977),
    // GasGiant's (3628273133/2308142839/97354729), comet's
    // (2246822519/3266489917/668265263) and Moon's (2971215073/1640531527/
    // 3559788179). Reusing any of them would correlate this body's corona
    // with another sector feature's own roll — the same furniture problem
    // those files' own comments warn against. Only the corona streamers
    // read from this rng; everything else about the sun is `light` itself.
    const rng = makeRng((seed * 2166136261 + sector * 16777619 + 3405691582) >>> 0);

    // `sun.target` in `main.ts` is always the origin, so a real
    // `DirectionalLight`'s illumination direction is `light.position`
    // alone, normalised — the same read `GasGiant.show`/`Moon.show` reuse.
    // This body draws *at* that bearing rather than shading by it.
    this.direction.copy(light.position).normalize();

    // The core — pushed well past the post chain's bloom threshold
    // (`Stage.ts`'s `UnrealBloomPass`, 0.5) by doubling the light's own
    // colour rather than by any geometry (§3.2: brightness distribution,
    // not shape). Opaque and depth-writing by default, same as every other
    // hero body's `body` mesh, so it still eats the starfield behind it
    // (§3.4) despite carrying no shading of its own.
    const core = new Mesh(
      new SphereGeometry(SUN_HERO.coreRadius, SUN_HERO.coreWidthSegments, SUN_HERO.coreHeightSegments),
      new MeshBasicMaterial({ color: light.colour.clone().multiplyScalar(2), fog: false }),
    );
    core.renderOrder = -1.96;
    this.core = core;
    this.object.add(core);

    // The halo — two concentric additive discs, faint and transparent,
    // `depthWrite: false` so neither self-occludes the other nor blocks
    // whatever the corona streamers draw past them. `lookAt` in `follow`
    // keeps both facing the player every frame; nothing here orients them,
    // since the very first `show` leaves them at their default +Z-facing
    // pose until `follow` runs a moment later.
    const haloColor = light.colour;
    const haloInner = new Mesh(
      new CircleGeometry(SUN_HERO.coreRadius * SUN_HERO.haloInnerScale, SUN_HERO.haloSegments),
      new MeshBasicMaterial({
        color: haloColor.clone(),
        transparent: true,
        opacity: SUN_HERO.haloInnerOpacity,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    haloInner.renderOrder = -1.955;
    this.haloInner = haloInner;
    this.object.add(haloInner);

    const haloOuter = new Mesh(
      new CircleGeometry(SUN_HERO.coreRadius * SUN_HERO.haloOuterScale, SUN_HERO.haloSegments),
      new MeshBasicMaterial({
        color: haloColor.clone(),
        transparent: true,
        opacity: SUN_HERO.haloOuterOpacity,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    haloOuter.renderOrder = -1.955;
    this.haloOuter = haloOuter;
    this.object.add(haloOuter);

    // The corona — radial spokes as line segment pairs in the local XY
    // plane, the same plane the halo discs' own `CircleGeometry` is built
    // in, so all three read as coplanar once `follow`'s `lookAt` turns them
    // to face the player together. Evenly spaced base angles, jittered per
    // spoke so the corona reads as ragged rather than a rigid pinwheel; the
    // rng only ever touches this one shape (see `show`'s own comment on the
    // hash mix).
    const streamerCount =
      SUN_HERO.streamerCountMin + Math.floor(rng.next() * (SUN_HERO.streamerCountMax - SUN_HERO.streamerCountMin + 1));
    const innerR = SUN_HERO.coreRadius * SUN_HERO.haloInnerScale;
    const positions = new Float32Array(streamerCount * 6);
    for (let i = 0; i < streamerCount; i++) {
      const baseAngle = (i / streamerCount) * Math.PI * 2;
      const angle = baseAngle + (rng.next() * 2 - 1) * SUN_HERO.streamerAngleJitter;
      const outerR =
        innerR + SUN_HERO.coreRadius * (SUN_HERO.streamerLengthMin + rng.next() * (SUN_HERO.streamerLengthMax - SUN_HERO.streamerLengthMin));
      const o = i * 6;
      positions[o] = Math.cos(angle) * innerR;
      positions[o + 1] = Math.sin(angle) * innerR;
      positions[o + 2] = 0;
      positions[o + 3] = Math.cos(angle) * outerR;
      positions[o + 4] = Math.sin(angle) * outerR;
      positions[o + 5] = 0;
    }
    const streamerGeometry = new BufferGeometry();
    streamerGeometry.setAttribute("position", new BufferAttribute(positions, 3));
    const streamers = new LineSegments(
      streamerGeometry,
      new LineBasicMaterial({
        color: haloColor.clone(),
        transparent: true,
        opacity: SUN_HERO.streamerOpacity,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    streamers.renderOrder = -1.95;
    this.streamers = streamers;
    this.object.add(streamers);

    // Provisional placement so the very first frame (before `follow` has
    // run once) is not sitting at the world origin. `follow` overwrites
    // this every frame after using the player's own position — there is no
    // fixed world anchor here the way `GasGiant`/`Moon` keep one, per this
    // file's header.
    this.object.position.copy(this.direction).multiplyScalar(SUN_HERO.range);
  }

  /**
   * Re-anchor on the player, at a fixed offset along the light's own
   * bearing — never a fixed world point, so there is nothing to leash
   * against and the disc never parallaxes closer no matter how the player
   * flies. This is what "effectively at infinity" means in practice: the
   * sun holds the same *direction and distance* from the player forever.
   *
   * The core needs no further orientation — a sphere looks the same lit
   * from any angle it is *not* being shaded from, and this body carries no
   * shading. The halo discs and the corona are flat, so unlike the core
   * they must be told which way to face; `lookAt(player)` rather than the
   * camera, because `follow` is never handed the camera (`GasGiant.show`'s
   * own header gives the same reasoning: `show`/`follow` read
   * `player.position` alone so they do not have to wait for `placeCamera`
   * to run first) and because at `SUN_HERO.range` units out the gap between
   * the player and whichever camera mode is active is a rounding error.
   */
  follow(player: Vector3): void {
    if (!this.core) return;
    this.object.position.set(
      player.x + this.direction.x * SUN_HERO.range,
      player.y + this.direction.y * SUN_HERO.range,
      player.z + this.direction.z * SUN_HERO.range,
    );
    this.haloInner?.lookAt(player);
    this.haloOuter?.lookAt(player);
    this.streamers?.lookAt(player);
  }

  /** Spins the corona in its own facing plane — `dt`-based, per
   * `SUN_HERO.rotationRate`. Nothing else animates: the core and halo discs
   * are static shapes and nothing here pulses. */
  update(dt: number): void {
    if (!this.streamers) return;
    this.streamers.rotation.z += SUN_HERO.rotationRate * dt;
  }

  /** Empty the group and forget the sector, so the next `show` rebuilds. */
  hide(): void {
    if (this.key === "") return;
    this.key = "";
    this.clear();
  }

  /** Torn down on a sector change, the same moment `GasGiant.clear` and
   * `Moon.clear` are. */
  clear(): void {
    if (this.core) {
      this.core.geometry.dispose();
      (this.core.material as MeshBasicMaterial).dispose();
    }
    if (this.haloInner) {
      this.haloInner.geometry.dispose();
      (this.haloInner.material as MeshBasicMaterial).dispose();
    }
    if (this.haloOuter) {
      this.haloOuter.geometry.dispose();
      (this.haloOuter.material as MeshBasicMaterial).dispose();
    }
    if (this.streamers) {
      this.streamers.geometry.dispose();
      (this.streamers.material as LineBasicMaterial).dispose();
    }
    this.core = null;
    this.haloInner = null;
    this.haloOuter = null;
    this.streamers = null;
    for (const child of [...this.object.children]) this.object.remove(child);
  }
}
