import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  type InstancedMesh,
  MathUtils,
  Matrix4,
  MeshLambertMaterial,
  Vector3,
} from "three";
// Reused rather than reached for fresh via `three/addons`: `hulls.ts` already
// imports this exact function through this exact specifier and merges every
// hull in the game with it (`src/geometry/hulls.ts:2`), so it is a proven,
// already-paid-for import path in this build. `three/addons/...` resolves to
// the same underlying module in this three.js version, but introducing a
// second specifier for one function that already has a working one would be
// risk taken on for no benefit — and the brief's own fallback (hand-roll the
// merge) exists to avoid *unproven* import risk, which this is not.
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { makeRng, type Rng } from "../chart/rng.js";
import { disposeRockMeshes, RockScatter, SILHOUETTE_COUNT } from "./InstancedRocks.js";
import type { SectorLight } from "./light.js";
import { shadowed } from "./shadows.js";
import { VectorObject } from "./VectorObject.js";

/**
 * Scenery task 4 — the `"rocks"` `HeroKind` (`render/scenery.ts`'s own
 * `ROSTER`) plus the mid-field furniture every sector gets regardless of
 * which hero it cast, and the one `__scenery` switch the SwiftShader
 * playtest harness needs to keep every later scenery task inside its frame
 * budget (`tools/playtest.mjs`'s own giant-hiding comment, generalised).
 *
 * Unlike `GasGiant`/`Moon`/`SunHero`, this body is not a hand-written
 * `ShaderMaterial` fed a `SectorLight` uniform directly — it is real
 * geometry (`IcosahedronGeometry`, jittered) under a plain
 * `MeshLambertMaterial`, lit for free by the scene's standing `sun`
 * `DirectionalLight` (`main.ts`'s own `sun`/`sunFill`), the first thing in
 * the game to actually consume that pair through three.js's own lighting
 * pipeline rather than leaving it declared-but-unread the way `main.ts`'s
 * header comment on `sun` describes. `light` is still taken as a parameter
 * to keep this class's `show` signature the shape every other hero body's
 * is, but nothing here reads it directly.
 *
 * ## The density pass — merged geometry out, `InstancedMesh` in
 *
 * This field originally answered `docs/environment.md` §4.3 ("a dozen bodies
 * is nothing; forty individual asteroids is not") by merging every rock in a
 * group into a single `BufferGeometry`: one draw call per group, at the price
 * of a rock count small enough for the merge to stay cheap — 36 near, 80 far.
 * That price is no longer worth paying, because the premise underneath it was
 * measured and found false. On the machine this was built on, the whole scene
 * plus post chain runs ~4.0 ms/frame against a 16.6 ms budget; twelve extra
 * hostile hulls measured **0.00 ms**; hiding the entire sky and every scenery
 * body saved **0.05 ms out of 4.0**. The frame is bandwidth and fill, not
 * vertices. A field held to dozens of rocks was buying back a cost nothing was
 * charging.
 *
 * So the field is now `InstancedMesh`-based (`render/InstancedRocks.ts`) and
 * carries **thousands**: a near field of collidable boulders sitting inside a
 * far denser cloud of non-collidable gravel, and a far band of specks. §4.3's
 * complaint is still honoured, and better — one draw call *per silhouette*
 * for any number of rocks, and the base geometry is uploaded once for the life
 * of the page rather than rebuilt on every sector change.
 *
 * ## Collision: two tiers, and why the cheap query is the small one
 *
 * `this.rocks` — the collidable list `game/session.ts`, `game/hostiles.ts` and
 * `audio/sound.ts` all read — still contains **only the near field's
 * boulders**, and its shape (`{x, y, z, r}[]`, world space, rebuilt every
 * `update()` from the field's own tumble) is byte-for-byte the contract those
 * three modules already consume. Nothing about `ROCKS`'s pricing changes.
 *
 * The obvious way to make thousands of rocks collidable is a spatial bin, and
 * it was rejected for a specific reason rather than a general one: **a bin is
 * a query, and the callers do not query.** `Session.collideRocks` iterates
 * `this.rocks` directly, `Hostile.update` iterates the same array once per
 * hostile per frame, and `Sound.echoFrom` maps/filters/sorts the whole array
 * per explosion. Every one of those lives in `src/game/` or `src/audio/`, and
 * turning them into bin lookups means editing all three. Handing them a bigger
 * flat array instead would multiply three per-frame loops by whatever the
 * gravel count is, which is the one way this pass could actually cost a frame.
 *
 * The second reason is that the split is honest rather than merely convenient.
 * `gravelRadiusMax` (1.8) sits deliberately well below `heroRadiusMin` (3), so
 * the two tiers never overlap in size and the gap is wide enough to read at a
 * glance: everything you can hit is visibly bigger than everything you cannot,
 * and the things you fly through are grit against a hull of radius 2.6. The
 * gravel is also drawn dimmer than the boulders (see its own `tint`), so the
 * brightest rock on screen is always one that can actually hurt you. The
 * boulder count did rise — 36 to 72 — because the *hazard* should get denser
 * too, not just the scenery; three per-frame loops over 72 spheres is still
 * tens of microseconds, and `ECHO.maxRocks` already caps what the echo does
 * with them.
 *
 * The one thing the split does concede is that gravel **occludes** hulls it
 * cannot stop — you can lose a hostile behind a rock you would fly straight
 * through. That is not a new liberty being taken: it is exactly the ruling
 * already on the books for gas shoals (`CLAUDE.md`, "visual occlusion only, by
 * decision"), and it is bounded the same way — the scanner never draws a rock,
 * so the instrument that arbitrates what is really there stays clean.
 *
 * **The hero field excludes the docking corridor.** `heroCentreMin`/`Max`
 * (90–150) already overlaps the range the starbase itself stands at (118,
 * `main.ts`'s own `STARBASE_POSITION`) — so in a fraction of `"rocks"`
 * sectors, an un-excluded roll would seed a rock inside the station or
 * across the one lane docking is mandatory through. Docking cannot be
 * skipped, so a rock embedded in it would read as broken rather than as
 * hazard. `buildHeroField` rejects and rerolls (bounded, below) any boulder
 * whose sphere comes within `dockExclusionMargin` of the segment from the
 * station to its gate, and simply *drops* any gravel grain that lands there —
 * a reroll is worth spending on one of 72 hazards and not on one of six
 * thousand specks. The exclusion is narrow (a single ~15-unit segment plus a
 * 14-unit margin, against a field spread over a 120-unit ellipsoid) so the
 * field still reads as crowding the sector — it just parts around the one lane
 * a run is required to fly.
 */
export const ASTEROIDS = {
  /** Desaturated grey-brown — a locked mitigation (Global Constraints), not
   * taste. A warm small rock at range with any real saturation reads as a
   * Raider (`palette.ts`'s own amber/gold), so this stays dull on purpose.
   * Per-instance tint (`RockScatter.add`'s `tint`/`warm`) only scales and
   * very slightly skews this; it never introduces saturation of its own. */
  color: new Color(0x6b675f),
  /** The drifting hulk's colour — plain, equal-channel grey, deliberately
   * outside every hue this game reserves for a class or a faction
   * (`palette.ts`'s cyan/amber/gold/acid-green/red-orange/violet/magenta).
   * It was a ship, so strokes (`VectorObject`) are honest, but it is nobody's
   * ship any more, so it gets nobody's colour. */
  hulkColor: new Color(0x565656),
  /** Radians per second the whole assembly turns — never per-rock, which
   * would cost a matrix per rock every frame for a difference nobody would
   * see at this screen size. One transform per group instead, and at five
   * thousand rocks per field that reasoning is no longer a preference. */
  tumbleRate: 0.008,

  // ── hero near field: the collidable tier ────────────────────────────
  /** Boulders — the whole of `this.rocks`, and the only rocks anything in
   * the game can hit. Doubled from the merged field's 36 because the hazard
   * should thicken with the scenery; every one of these is walked by the
   * player's collision check, by *each* hostile's avoidance, and by the echo,
   * every frame, so this number is a real cost in a way the gravel is not. */
  heroBoulderCount: 72,
  heroRadiusMin: 3,
  heroRadiusMax: 9, // 3 + rng*6
  /** Per-axis visual scale a boulder's own nominal radius is multiplied by,
   * so no two boulders of the same nominal size share an outline. Bounded
   * near 1 on purpose: the collision sphere is the nominal radius, and the
   * merged field already had this exact discrepancy (its jitter pushed
   * corners to 1.25× the collision radius), so keeping the visual within
   * roughly that band preserves how a rock strike has always felt. */
  boulderAxisMin: 0.85,
  boulderAxisMax: 1.1,
  /** Distance from world origin the field's own centre is rolled at — close
   * enough to matter to a run (the starbase itself sits at range 118), not
   * fixed dead-ahead the way the giant/moon/sun are, because this body is a
   * hazard to fly through rather than a backdrop to be looked at. */
  heroCentreMin: 90,
  heroCentreMax: 150,
  /** Semi-axes of the flattened ellipsoid boulders scatter within, centred on
   * the field's own centre. `y` stays inside the altitude slab's own ~14-unit
   * ceiling (`CLAUDE.md`'s locked write-up) so flying over the field, not
   * just around it, is a real option. */
  heroSpreadXZ: 120,
  heroSpreadY: 10,
  /** How close a boulder's sphere may come to the docking corridor segment
   * (station to gate) before it is rejected and rerolled — see the class
   * docblock's own paragraph on the exclusion. */
  dockExclusionMargin: 14,
  /** Reroll attempts before a boulder that keeps landing in the corridor is
   * simply dropped rather than forced somewhere the rng never chose — a
   * 71-rock field reads the same as a 72-rock one. */
  dockExclusionRerolls: 8,

  // ── hero near field: the visual tier ────────────────────────────────
  /** Gravel — grit and rubble, never collidable. This is the number the whole
   * pass exists for: the field reads as *deep* only when there is something
   * between the boulders for the eye to measure parallax against. */
  gravelCount: 6000,
  gravelRadiusMin: 0.3,
  /** Deliberately well under `heroRadiusMin` (3): the two tiers never overlap
   * in size, and the gap between them is wide enough to read at a glance
   * rather than merely being true — everything you can hit is visibly bigger
   * than everything you cannot. The first pass set this at 2.2, close enough
   * to 2.8 that a near grain and a far boulder were indistinguishable on
   * screen, which is the exact confusion the split exists to avoid. See the
   * class docblock. */
  gravelRadiusMax: 1.8,
  /** Gravel spreads this much further than the boulders do, in both axes — a
   * dense core with a thinning halo around it, rather than a slab of uniform
   * rubble that ends at a visible edge. */
  gravelSpreadScale: 2.2,
  /** Radius within the halo is `u ** gravelClustering` for a uniform draw
   * `u`. Uniform-in-volume would be `1/3`, which piles everything against the
   * outer shell; anything above that concentrates toward the centre, and the
   * number density that results goes as `r ** (1/c - 3)`.
   * **This was flown, not reasoned about, and it moved.** The first pass set
   * it at 0.85, which is `r ** -1.8` — a density that runs away at the centre,
   * and from inside the field that is not a thicket, it is a wall: the core
   * closed to a solid grey mass with no line of sight through it. 0.55 is
   * `r ** -1.2`, still visibly denser in the middle than at the fringe, but a
   * field you can see across and fight inside of. Worth flying again — this
   * is the number that decides whether the field is a place or an obstacle. */
  gravelClustering: 0.55,
  /** Fraction of its rolled size a grain loses at the very edge of the halo.
   * Small rocks at the fringe and big ones in the core is not physics; it is
   * the depth cue that makes the halo read as *distance* rather than as the
   * field simply stopping. */
  gravelFringeShrink: 0.45,

  // ── far band — depth only, never collidable ─────────────────────────
  farCount: 3500,
  farDistanceMin: 250,
  farDistanceMax: 900,
  farRadiusMin: 0.4,
  farRadiusMax: 1.6,
  /** The far band is dimmed rather than drawn at full value — `CLAUDE.md`'s
   * own colour ruling, "small and distant should stay desaturated", applied
   * where it costs nothing: these are specks, and a speck at full value is
   * the exact thing that could be mistaken for a contact. */
  farTintMin: 0.45,
  farTintMax: 0.75,

  // ── furniture — every sector, independent of which hero it cast ────
  furnitureClusterMax: 2,
  furnitureRockMin: 90,
  furnitureRockMax: 180,
  furnitureDistanceMin: 300,
  furnitureDistanceMax: 600,
  /** Scatter radius around a cluster's own centre. Kept well under the gap
   * between `furnitureDistanceMin` (300) and the "never inside 260" floor,
   * so no furniture rock can land inside 260 even at the closest roll. */
  furnitureScatter: 30,
  furnitureRadiusMin: 1,
  furnitureRadiusMax: 4.5,
  hulkChance: 0.15,
} as const;

/**
 * Which silhouettes each tier draws from. Every distinct shape a field uses
 * costs it one draw call, so the tiers that are far away or numerous take the
 * narrower, cheaper sets: shapes 0–2 are the 20-face bases, 3–4 the 80-face
 * ones (`InstancedRocks.SILHOUETTE_RECIPES`). A band of specks at 900 units
 * cannot show off an 80-face crag, so it does not pay for one.
 */
const SHAPE_SETS = {
  /** Boulders are the ones you actually look at: all five. */
  boulder: [0, 1, 2, 3, 4],
  /** Gravel too — it is the tier filling the middle distance, and repetition
   * is most visible where there is most of it. */
  gravel: [0, 1, 2, 3, 4],
  /** Two cheap shapes: two draw calls for three and a half thousand specks. */
  far: [0, 1],
  /** Three cheap shapes per cluster, at 300–600 units out. */
  furniture: [0, 1, 2],
} as const satisfies Record<string, readonly number[]>;

/** A collidable sphere, world space. Task 5's shape to consume. */
export interface Rock {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** One boulder's local offset before the field's own tumble is applied. */
interface LocalRock {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** Shared across every sector and every rock group — the material carries no
 * per-sector state (no uniform to update, unlike `GasGiant`/`Moon`'s own
 * `ShaderMaterial`s), so unlike their per-instance materials this one is
 * built once and never disposed; only the instance buffers it lights are ever
 * per-sector. Keeping it alive for the life of the page is also what keeps
 * `__scenery.hide()`/`.show()` free: `visible` toggling never touches the
 * program cache, but a disposed material would force a recompile — and a
 * shader compile is a >100 ms stall in whatever frame it lands in. */
const ROCK_MATERIAL = new MeshLambertMaterial({ color: ASTEROIDS.color, fog: false });

/**
 * Which tiers cast into the sector star's shadow map, and which only stand in
 * it (`render/shadows.ts`).
 *
 * **Every tier receives.** Not because every tier will visibly be shadowed —
 * the far band is 250–900 units out and the shadow frustum is 160 across the
 * player — but because `ROCK_MATERIAL` is one material shared by every rock
 * in the game and `receiveShadow` is part of three's *program* cache key. A
 * far band that opted out would be a second compiled program for the same
 * material, linked at whatever moment a `"rocks"` sector first drew one. See
 * `shadowed`'s own comment; this is the case that made it worth writing down.
 *
 * **Casting is where the tiering is real.** The near field is the one the
 * player flies through, so its boulders and its gravel both cast: gravel is
 * the tier that makes the field read as *deep* (see `gravelCount`), and depth
 * without occlusion is the exact complaint shadows exist to answer. The far
 * band does not cast, and that is a measurement rather than a taste — it is
 * 3500 instances in two draw calls whose bounding sphere spans the entire
 * 900-unit shell, so it can never be frustum-culled out of the shadow pass
 * even though essentially none of it is ever inside a 160-unit box around the
 * player. It would be a per-frame depth-pass cost paid for nothing. The
 * furniture clusters do cast: they are compact, so their bounding spheres
 * cull cleanly, and unlike the far band the player can actually fly into one.
 */
const ROCK_CASTERS = {
  near: true,
  far: false,
  furniture: true,
} as const;

/**
 * The docking corridor's own two endpoints, world space — hard-coded rather
 * than imported from `game/docking.ts`, on purpose: every file in this game
 * has kept the dependency one-way, `game/` importing `render/` and never the
 * reverse (`game/session.ts`'s own `Rock` type is declared structurally for
 * the identical reason — importing `render/Asteroids.ts` there would drag
 * `three`'s `BufferGeometryUtils` and the render layer along for four
 * fields). Reaching into `docking.ts` from here would be the first import
 * against that grain, and it would also pull in `audio/sound.js` (`Docking`'s
 * own import) for two numbers. So: **staleness warning** — `station` mirrors
 * `main.ts`'s `STARBASE_POSITION` (0, 0, 118) and `gate` is that point minus
 * `game/docking.ts`'s own `DOCK_GEOMETRY.gateOffset` (15) along -Z. If either
 * constant ever moves, this drifts out of step with it silently.
 */
const DOCK_CORRIDOR = {
  station: new Vector3(0, 0, 118),
  gate: new Vector3(0, 0, 103),
} as const;

/**
 * Point-to-segment distance, 3D — the sphere-vs-capsule test a near-field
 * rock is rejected against so it cannot land in the docking corridor. `t` is
 * clamped to the segment itself so a point beyond either endpoint measures
 * against that endpoint, not the infinite line through it.
 *
 * Scratch vectors are module-level rather than allocated per call: at six
 * thousand gravel grains a sector this runs six thousand times per rebuild,
 * and three `Vector3`s per call is eighteen thousand objects handed to the
 * collector for a number that is thrown away immediately.
 */
const SEG_AB = new Vector3();
const SEG_AP = new Vector3();
const SEG_CLOSEST = new Vector3();
function distanceToSegment(point: Vector3, a: Vector3, b: Vector3): number {
  SEG_AB.subVectors(b, a);
  const lengthSq = SEG_AB.lengthSq();
  const t = lengthSq > 0 ? MathUtils.clamp(SEG_AP.subVectors(point, a).dot(SEG_AB) / lengthSq, 0, 1) : 0;
  SEG_CLOSEST.copy(a).addScaledVector(SEG_AB, t);
  return point.distanceTo(SEG_CLOSEST);
}

/**
 * A rock's local offset within a flattened ellipsoid centred on the group's
 * own origin — semi-axis `radiusXZ` across, `radiusY` tall. Sampled
 * uniformly within the ellipsoid's volume by rejection: draw a point in the
 * unit cube, keep it if it lands inside the unit sphere (~52% of draws per
 * try), then scale each axis independently. Bounded at 8 tries so this stays
 * a pure, deterministic function of `rng` — a run that never lands inside the
 * sphere in 8 draws just keeps whatever the 8th draw was, near a corner of
 * the ellipsoid rather than nowhere.
 */
function sampleEllipsoid(rng: Rng, radiusXZ: number, radiusY: number): { x: number; y: number; z: number } {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let tries = 0; tries < 8; tries++) {
    x = rng.next() * 2 - 1;
    y = rng.next() * 2 - 1;
    z = rng.next() * 2 - 1;
    if (x * x + y * y + z * z <= 1) break;
  }
  return { x: x * radiusXZ, y: y * radiusY, z: z * radiusXZ };
}

/**
 * The gravel's own sampler — a *direction* drawn uniformly, then a radius
 * drawn with a deliberate bias so density falls off outward
 * (`ASTEROIDS.gravelClustering`). `sampleEllipsoid` above cannot do this: it
 * is uniform-in-volume by construction, which is exactly the wrong
 * distribution here, because a uniform ellipsoid of six thousand rocks reads
 * as a wall with an edge rather than as a field you are inside of. `t` comes
 * back with the point so the caller can shrink the grain toward the fringe.
 */
function sampleFalloff(
  rng: Rng,
  radiusXZ: number,
  radiusY: number,
  clustering: number,
): { x: number; y: number; z: number; t: number } {
  const dir = sampleEllipsoid(rng, 1, 1);
  const length = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const t = Math.pow(rng.next(), clustering);
  return {
    x: (dir.x / length) * t * radiusXZ,
    y: (dir.y / length) * t * radiusY,
    z: (dir.z / length) * t * radiusXZ,
    t,
  };
}

/** Merge a batch of local-space geometries into one, disposing the originals.
 * Only the hulk uses this now — the rock fields went to `InstancedMesh` — but
 * the hulk is one wreck built from three primitives, which is precisely the
 * case merging is still right for. */
function mergeParts(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false)!;
  for (const part of parts) part.dispose();
  return merged;
}

/**
 * A drifting hulk — wreckage, not a ship any class in `hulls.ts` flies, so
 * this hand-rolls the same box/cylinder-primitives-merged-into-one-solid
 * technique that file uses (`hulls.ts:1-24`'s own header) rather than
 * importing one of its whole-ship builders and hiding half of it. The break
 * itself is the detail that reads as wreck rather than ship: a sheared-off
 * panel sits adrift a short way from the main hull instead of still joined
 * to it.
 */
function buildHulk(rng: Rng): BufferGeometry {
  const parts: BufferGeometry[] = [];

  const hull = new BoxGeometry(3 + rng.next(), 1.2, 7 + rng.next() * 2);
  hull.applyMatrix4(new Matrix4().makeRotationZ((rng.next() * 2 - 1) * 0.4));
  parts.push(hull);

  const shard = new BoxGeometry(1.8 + rng.next(), 1, 2.5 + rng.next());
  shard.applyMatrix4(
    new Matrix4()
      .makeRotationX(0.6 + rng.next() * 0.5)
      .multiply(new Matrix4().makeRotationZ(rng.next() * Math.PI)),
  );
  shard.applyMatrix4(
    new Matrix4().makeTranslation(2 + rng.next() * 2, rng.next() * 1.5, -5 - rng.next() * 3),
  );
  parts.push(shard);

  // A snapped nacelle stub, laid along Z the way `hulls.ts`'s own `alongZ`
  // helper turns a cylinder (Y-axis by default) to point down the ship.
  const stub = new CylinderGeometry(0.4, 0.5, 2 + rng.next(), 6, 1);
  stub.applyMatrix4(new Matrix4().makeRotationX(Math.PI / 2));
  stub.applyMatrix4(
    new Matrix4().makeTranslation(-1.8 - rng.next(), -0.3, 2 + rng.next() * 2),
  );
  parts.push(stub);

  return mergeParts(parts);
}

/** Pick one of a tier's silhouettes. A plain uniform draw over the set: the
 * shapes are already distinguishable by outline, so weighting them would be a
 * knob with nothing behind it. */
function pickShape(rng: Rng, set: readonly number[]): number {
  return set[Math.min(set.length - 1, Math.floor(rng.next() * set.length))] % SILHOUETTE_COUNT;
}

/**
 * The `"rocks"` hero field, plus every sector's mid-field furniture.
 * `main.ts` holds one instance and calls `show`/`update` unconditionally,
 * every sector — see that file's hero block. Unlike the giant/moon/sun, there
 * is no `else asteroids.hide()`: the `hero` flag alone decides whether a
 * given call also builds the big collidable near field, and `show`'s own
 * key-cache already rebuilds whenever the sector changes underneath it.
 */
export class Asteroids {
  readonly object = Object.assign(new Group(), { name: "asteroids" });

  /** The hero near field's collidable spheres, world space — Task 5's shape
   * to consume. **Boulders only**: the gravel tier, the far band and the
   * furniture never appear here, and the class docblock's collision section
   * is the argument for why. Empty outside a `"rocks"` sector.
   * A private backing field plus a readonly getter, rather than a plain
   * public field, so the interface really is `readonly rocks: readonly
   * Rock[]` — reassigned wholesale every `update()` tick internally (see
   * `syncRocks`), never mutable from outside. */
  private _rocks: Rock[] = [];
  get rocks(): readonly Rock[] {
    return this._rocks;
  }

  /** Every rock actually on screen, collidable or not — diagnostics only,
   * nothing in the game reads it. It exists because the whole point of this
   * pass is a number that is invisible from `rocks.length`: a sector showing
   * nearly ten thousand rocks and one showing seventy-two report the same
   * collidable count. */
  private _instanceCount = 0;
  get instanceCount(): number {
    return this._instanceCount;
  }

  private key = "";

  // The near field tumbles as one rigid swarm about its own centre — the
  // group's own `.position`/`.rotation.y` carries the render for free every
  // frame, and `syncRocks` below re-derives `this.rocks` from the same
  // angle by the same trig, so the collidable list Task 5 reads never drifts
  // from what is actually on screen.
  private nearGroup: Group | null = null;
  private nearMeshes: InstancedMesh[] = [];
  private nearLocal: LocalRock[] = [];
  private readonly nearCentre = new Vector3();
  private nearAngle = 0;

  private farGroup: Group | null = null;
  private farMeshes: InstancedMesh[] = [];
  private readonly furnitureGroups: { group: Group; meshes: InstancedMesh[] }[] = [];
  private hulk: VectorObject | null = null;

  /**
   * Rebuild for a sector, if it is not already the one standing — the same
   * key-cache idiom `GasGiant`/`Moon`/`SunHero` share. `hero` is
   * `sectorHero === "rocks"`; furniture builds regardless of it.
   */
  show(seed: number, sector: number, hero: boolean, _light: SectorLight): void {
    const key = `${seed}:${sector}`;
    if (key === this.key) return;
    this.key = key;
    this.clear();

    this.buildFurniture(seed, sector);
    if (hero) this.buildHeroField(seed, sector);
    this.countInstances();
  }

  private buildHeroField(seed: number, sector: number): void {
    // A hash mix distinct from every other one this game rolls a sector
    // feature with — scenery's own (1103515245/12820163/53231), light's
    // (1274126177/741103597/1013904223), Planet's (2654435761/40503/977),
    // GasGiant's (3628273133/2308142839/97354729), comet's
    // (2246822519/3266489917/668265263), Moon's (2971215073/1640531527/
    // 3559788179) and SunHero's (2166136261/16777619/3405691582). Reusing any
    // of them would correlate this field's placement/size with another
    // sector feature's own roll.
    //
    // Determinism contract, unchanged by the density pass: everything below
    // is a pure function of (seed, sector) through this one generator, drawn
    // in a fixed order, so the same campaign seed and sector always produce
    // the same field down to the last grain. What *did* change is the field
    // that a given seed produces, because the draw order changed with the
    // build — the old merged path spent a variable number of draws per rock
    // inside `jitterRock`, and the instanced path does not. Nothing depends
    // on any particular seed's old field; the guarantee was reproducibility,
    // not a specific arrangement.
    const rng = makeRng((seed * 2901084542 + sector * 893404357 + 3927117762) >>> 0);

    const bearing = rng.next() * Math.PI * 2;
    const distance =
      ASTEROIDS.heroCentreMin + rng.next() * (ASTEROIDS.heroCentreMax - ASTEROIDS.heroCentreMin);
    this.nearCentre.set(Math.sin(bearing) * distance, 0, Math.cos(bearing) * distance);

    this.nearLocal = [];
    const scatter = new RockScatter();
    // Scratch vector for the corridor-exclusion check below, reused across
    // every rock and every reroll attempt rather than allocated per try.
    const worldPos = new Vector3();

    // ── the collidable tier ───────────────────────────────────────────
    for (let i = 0; i < ASTEROIDS.heroBoulderCount; i++) {
      const r = ASTEROIDS.heroRadiusMin + rng.next() * (ASTEROIDS.heroRadiusMax - ASTEROIDS.heroRadiusMin);
      // Reject-and-reroll: this field's centre (90-150 from origin) already
      // overlaps the starbase's own range (118), so an un-excluded roll can
      // seed a rock inside the station or across its docking corridor —
      // which is mandatory to fly, so a rock embedded in it reads as broken.
      // Checked pre-build, at this rock's own build-time position (the
      // field's rotation is 0 here, so world position is just the centre
      // plus the local sample — the same relationship `syncRocks` re-derives
      // every frame at whatever angle the tumble has since reached). Bounded
      // at `dockExclusionRerolls` tries; a rock that keeps landing there is
      // dropped rather than forced somewhere the rng never chose.
      let sample = sampleEllipsoid(rng, ASTEROIDS.heroSpreadXZ, ASTEROIDS.heroSpreadY);
      let placed = false;
      for (let attempt = 0; attempt < ASTEROIDS.dockExclusionRerolls; attempt++) {
        worldPos.set(
          this.nearCentre.x + sample.x,
          this.nearCentre.y + sample.y,
          this.nearCentre.z + sample.z,
        );
        const clearance = distanceToSegment(worldPos, DOCK_CORRIDOR.station, DOCK_CORRIDOR.gate) - r;
        if (clearance >= ASTEROIDS.dockExclusionMargin) {
          placed = true;
          break;
        }
        sample = sampleEllipsoid(rng, ASTEROIDS.heroSpreadXZ, ASTEROIDS.heroSpreadY);
      }
      if (!placed) continue;
      const { x, y, z } = sample;
      this.nearLocal.push({ x, y, z, r });
      const axis = (): number =>
        r * (ASTEROIDS.boulderAxisMin + rng.next() * (ASTEROIDS.boulderAxisMax - ASTEROIDS.boulderAxisMin));
      scatter.add(
        pickShape(rng, SHAPE_SETS.boulder),
        x,
        y,
        z,
        axis(),
        axis(),
        axis(),
        rng.next() * Math.PI * 2,
        rng.next() * Math.PI * 2,
        rng.next() * Math.PI * 2,
        0.85 + rng.next() * 0.3,
        (rng.next() * 2 - 1) * 0.05,
      );
    }

    // ── the visual tier ───────────────────────────────────────────────
    // Same group, same tumble, same one draw call per silhouette — gravel is
    // not a second field, it is the rest of this one. A grain that lands in
    // the docking corridor is dropped outright rather than rerolled: a reroll
    // loop is worth spending on one of seventy-two hazards, not on one of
    // six thousand specks nobody will miss.
    const gravelXZ = ASTEROIDS.heroSpreadXZ * ASTEROIDS.gravelSpreadScale;
    const gravelY = ASTEROIDS.heroSpreadY * ASTEROIDS.gravelSpreadScale;
    for (let i = 0; i < ASTEROIDS.gravelCount; i++) {
      const { x, y, z, t } = sampleFalloff(rng, gravelXZ, gravelY, ASTEROIDS.gravelClustering);
      const size =
        (ASTEROIDS.gravelRadiusMin + rng.next() * (ASTEROIDS.gravelRadiusMax - ASTEROIDS.gravelRadiusMin)) *
        (1 - ASTEROIDS.gravelFringeShrink * t);
      worldPos.set(this.nearCentre.x + x, this.nearCentre.y + y, this.nearCentre.z + z);
      if (distanceToSegment(worldPos, DOCK_CORRIDOR.station, DOCK_CORRIDOR.gate) - size < ASTEROIDS.dockExclusionMargin) {
        continue;
      }
      scatter.add(
        pickShape(rng, SHAPE_SETS.gravel),
        x,
        y,
        z,
        size * (0.7 + rng.next() * 0.6),
        size * (0.7 + rng.next() * 0.6),
        size * (0.7 + rng.next() * 0.6),
        rng.next() * Math.PI * 2,
        rng.next() * Math.PI * 2,
        rng.next() * Math.PI * 2,
        // Dimmer than a boulder's own 0.85–1.15 band, and dimmer again toward
        // the fringe. Two jobs in one number: distance should cost value, or
        // the halo reads as a second solid field rather than as the first one
        // receding — and the *hittable* tier should be the one that catches
        // the light, so the brightest rock on screen is always one that can
        // actually hurt you. Value, never saturation: `ASTEROIDS.color`'s own
        // lock is untouched by this.
        (0.6 + rng.next() * 0.35) * (1 - 0.3 * t),
        (rng.next() * 2 - 1) * 0.05,
      );
    }

    this.nearGroup = Object.assign(new Group(), { name: "asteroids-near" });
    this.nearGroup.position.copy(this.nearCentre);
    this.nearMeshes = scatter.build(this.nearGroup, ROCK_MATERIAL);
    for (const mesh of this.nearMeshes) shadowed(mesh, ROCK_CASTERS.near);
    this.object.add(this.nearGroup);
    this.nearAngle = 0;
    this.syncRocks();

    // The far band — depth dressing only, never collidable, so it never
    // touches `nearLocal`/`this.rocks`. Scattered around world origin at its
    // own bearing per rock rather than tied to the near field's own bearing,
    // the way the starfield surrounds the player regardless of where any one
    // hero body happens to be standing. It is the tier the density pass grew
    // most (80 rocks to 3500) and the one that costs least: two silhouettes,
    // two draw calls, and every one of them a speck.
    const farScatter = new RockScatter();
    for (let i = 0; i < ASTEROIDS.farCount; i++) {
      const farBearing = rng.next() * Math.PI * 2;
      const farDistance =
        ASTEROIDS.farDistanceMin + rng.next() * (ASTEROIDS.farDistanceMax - ASTEROIDS.farDistanceMin);
      const r = ASTEROIDS.farRadiusMin + rng.next() * (ASTEROIDS.farRadiusMax - ASTEROIDS.farRadiusMin);
      // Size falls with range as well as being rolled: a band drawn at one
      // size across 250-900 units reads as a flat curtain, because the eye
      // gets no size cue to go with the parallax one.
      const fade = 1 - 0.55 * ((farDistance - ASTEROIDS.farDistanceMin) / (ASTEROIDS.farDistanceMax - ASTEROIDS.farDistanceMin));
      const size = r * fade;
      farScatter.add(
        pickShape(rng, SHAPE_SETS.far),
        Math.sin(farBearing) * farDistance,
        (rng.next() * 2 - 1) * 60,
        Math.cos(farBearing) * farDistance,
        size * (0.75 + rng.next() * 0.5),
        size * (0.75 + rng.next() * 0.5),
        size * (0.75 + rng.next() * 0.5),
        rng.next() * Math.PI * 2,
        rng.next() * Math.PI * 2,
        rng.next() * Math.PI * 2,
        (ASTEROIDS.farTintMin + rng.next() * (ASTEROIDS.farTintMax - ASTEROIDS.farTintMin)) * fade,
        (rng.next() * 2 - 1) * 0.04,
      );
    }
    this.farGroup = Object.assign(new Group(), { name: "asteroids-far" });
    this.farMeshes = farScatter.build(this.farGroup, ROCK_MATERIAL);
    for (const mesh of this.farMeshes) shadowed(mesh, ROCK_CASTERS.far);
    this.object.add(this.farGroup);
  }

  /** Every sector's mid-field clutter — 0-2 clusters plus an occasional
   * hulk — independent of whatever `planHero` cast, on its own rng salt so
   * it never correlates with the hero roll. Contributes nothing to
   * `this.rocks`: none of this is meant to be flown through safely enough
   * to skip collision, it is just not this task's collision surface.
   * The per-cluster rock count grew with everything else here (8-12 to
   * 90-180) — a cluster of ten at 300-600 units was a handful of dots, which
   * is what "furniture" should never mean. */
  private buildFurniture(seed: number, sector: number): void {
    const rng = makeRng((seed * 1159248158 + sector * 3959036696 + 2873091622) >>> 0);

    const clusterCount = Math.floor(rng.next() * (ASTEROIDS.furnitureClusterMax + 1));
    for (let c = 0; c < clusterCount; c++) {
      const bearing = rng.next() * Math.PI * 2;
      const distance =
        ASTEROIDS.furnitureDistanceMin +
        rng.next() * (ASTEROIDS.furnitureDistanceMax - ASTEROIDS.furnitureDistanceMin);
      const centre = new Vector3(Math.sin(bearing) * distance, 0, Math.cos(bearing) * distance);

      const count = Math.round(
        ASTEROIDS.furnitureRockMin + rng.next() * (ASTEROIDS.furnitureRockMax - ASTEROIDS.furnitureRockMin),
      );
      const scatter = new RockScatter();
      for (let i = 0; i < count; i++) {
        const r =
          ASTEROIDS.furnitureRadiusMin + rng.next() * (ASTEROIDS.furnitureRadiusMax - ASTEROIDS.furnitureRadiusMin);
        const { x, y, z, t } = sampleFalloff(
          rng,
          ASTEROIDS.furnitureScatter,
          ASTEROIDS.furnitureScatter * 0.3,
          ASTEROIDS.gravelClustering,
        );
        const size = r * (1 - 0.35 * t);
        scatter.add(
          pickShape(rng, SHAPE_SETS.furniture),
          x,
          y,
          z,
          size * (0.75 + rng.next() * 0.5),
          size * (0.75 + rng.next() * 0.5),
          size * (0.75 + rng.next() * 0.5),
          rng.next() * Math.PI * 2,
          rng.next() * Math.PI * 2,
          rng.next() * Math.PI * 2,
          0.6 + rng.next() * 0.35,
          (rng.next() * 2 - 1) * 0.05,
        );
      }
      const group = Object.assign(new Group(), { name: "asteroids-furniture" });
      group.position.copy(centre);
      const meshes = scatter.build(group, ROCK_MATERIAL);
      for (const mesh of meshes) shadowed(mesh, ROCK_CASTERS.furniture);
      this.object.add(group);
      this.furnitureGroups.push({ group, meshes });
    }

    if (rng.next() < ASTEROIDS.hulkChance) {
      const bearing = rng.next() * Math.PI * 2;
      const distance =
        ASTEROIDS.furnitureDistanceMin +
        rng.next() * (ASTEROIDS.furnitureDistanceMax - ASTEROIDS.furnitureDistanceMin);
      this.hulk = new VectorObject(buildHulk(rng), {
        color: ASTEROIDS.hulkColor,
        linewidth: 1.3,
        fog: false,
      }).addTo(this.object);
      this.hulk.group.position.set(
        Math.sin(bearing) * distance,
        (rng.next() * 2 - 1) * 20,
        Math.cos(bearing) * distance,
      );
      this.hulk.group.rotation.y = rng.next() * Math.PI * 2;
    }
  }

  /** Total instances standing, for `instanceCount`'s own diagnostics. Counted
   * once per rebuild rather than tracked incrementally — a rebuild is rare and
   * this is a sum over at most a dozen meshes. */
  private countInstances(): void {
    let total = 0;
    for (const mesh of this.nearMeshes) total += mesh.count;
    for (const mesh of this.farMeshes) total += mesh.count;
    for (const { meshes } of this.furnitureGroups) for (const mesh of meshes) total += mesh.count;
    this._instanceCount = total;
  }

  /** Re-derive `this.rocks` from `nearLocal`/`nearCentre`/`nearAngle` — the
   * same Y-axis rotation `Object3D.rotation.y` applies to the meshes, done by
   * hand for the collidable list so the two never disagree. Cheap, and
   * deliberately still only over the boulders: 72 rocks, two trig calls and a
   * couple of multiplies each, once a frame. Running this over the gravel too
   * is the cost the two-tier split exists to refuse — see the class docblock. */
  private syncRocks(): void {
    const s = Math.sin(this.nearAngle);
    const c = Math.cos(this.nearAngle);
    this._rocks = this.nearLocal.map(({ x, y, z, r }) => ({
      x: this.nearCentre.x + x * c + z * s,
      y: this.nearCentre.y + y,
      z: this.nearCentre.z - x * s + z * c,
      r,
    }));
  }

  /** Applied to the hulk alone — the rock fields are plain lit meshes, not
   * `VectorObject`s, so `G` has nothing to toggle on them, the same reason
   * `applyShapeMode`'s own comment gives for the giant. */
  setMode(mode: Parameters<VectorObject["setMode"]>[0]): void {
    this.hulk?.setMode(mode);
  }

  /** One transform per group, per frame — see `ASTEROIDS.tumbleRate`'s own
   * comment for why this is never per-rock. Instancing does not change this:
   * a per-instance tumble would mean rewriting and re-uploading ten thousand
   * matrices a frame, which is the one way an instanced field could actually
   * become expensive. */
  update(dt: number): void {
    const delta = ASTEROIDS.tumbleRate * dt;
    if (this.nearGroup) {
      this.nearAngle += delta;
      this.nearGroup.rotation.y = this.nearAngle;
      this.syncRocks();
    }
    if (this.farGroup) this.farGroup.rotation.y += delta;
    for (const { group } of this.furnitureGroups) group.rotation.y += delta;
    if (this.hulk) this.hulk.group.rotation.y += delta;
  }

  /** Empty the group and forget the sector, so the next `show` rebuilds —
   * the same idiom `Moon.hide`/`GasGiant`'s own use. */
  hide(): void {
    if (this.key === "") return;
    this.key = "";
    this.clear();
  }

  private clear(): void {
    if (this.nearGroup) {
      disposeRockMeshes(this.nearGroup, this.nearMeshes);
      this.object.remove(this.nearGroup);
    }
    this.nearGroup = null;
    this.nearLocal = [];
    this.nearAngle = 0;
    this._rocks = [];

    if (this.farGroup) {
      disposeRockMeshes(this.farGroup, this.farMeshes);
      this.object.remove(this.farGroup);
    }
    this.farGroup = null;

    for (const { group, meshes } of this.furnitureGroups) {
      disposeRockMeshes(group, meshes);
      this.object.remove(group);
    }
    this.furnitureGroups.length = 0;

    if (this.hulk) {
      this.object.remove(this.hulk.group);
      this.hulk.dispose();
    }
    this.hulk = null;
    this._instanceCount = 0;
  }
}
