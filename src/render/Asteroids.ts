import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  MathUtils,
  Matrix4,
  Mesh,
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
import type { SectorLight } from "./light.js";
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
 * `docs/environment.md` §4.3: "a dozen bodies is nothing; forty individual
 * asteroids is not." Every rock in a group is merged into one
 * `BufferGeometry`, so a field of dozens of rocks costs one draw call, not
 * dozens.
 *
 * **The hero field excludes the docking corridor.** `heroCentreMin`/`Max`
 * (90–150) already overlaps the range the starbase itself stands at (118,
 * `main.ts`'s own `STARBASE_POSITION`) — so in a fraction of `"rocks"`
 * sectors, an un-excluded roll would seed a rock inside the station or
 * across the one lane docking is mandatory through. Docking cannot be
 * skipped, so a rock embedded in it would read as broken rather than as
 * hazard. `buildHeroField` rejects and rerolls (bounded, below) any near-field
 * rock whose sphere comes within `dockExclusionMargin` of the segment from
 * the station to its gate — checked pre-merge, against each rock's own
 * build-time position, because fixing this post-merge would mean reshuffling
 * every already-seeded field to move one rock aside. The exclusion is narrow
 * (a single ~15-unit segment plus a 14-unit margin, against a field spread
 * over a 120-unit ellipsoid) so the field still reads as crowding the sector
 * — it just parts around the one lane a run is required to fly.
 */
export const ASTEROIDS = {
  /** Desaturated grey-brown — a locked mitigation (Global Constraints), not
   * taste. A warm small rock at range with any real saturation reads as a
   * Raider (`palette.ts`'s own amber/gold), so this stays dull on purpose. */
  color: new Color(0x6b675f),
  /** The drifting hulk's colour — plain, equal-channel grey, deliberately
   * outside every hue this game reserves for a class or a faction
   * (`palette.ts`'s cyan/amber/gold/acid-green/red-orange/violet/magenta).
   * It was a ship, so strokes (`VectorObject`) are honest, but it is nobody's
   * ship any more, so it gets nobody's colour. */
  hulkColor: new Color(0x565656),
  /** Radians per second the whole assembly turns — never per-rock, which
   * would cost a matrix per rock every frame for a difference nobody would
   * see at this screen size. One transform per group instead. */
  tumbleRate: 0.008,

  // ── hero near field ──────────────────────────────────────────────────
  heroCount: 36,
  heroRadiusMin: 3,
  heroRadiusMax: 9, // 3 + rng*6
  /** Distance from world origin the field's own centre is rolled at — close
   * enough to matter to a run (the starbase itself sits at range 118), not
   * fixed dead-ahead the way the giant/moon/sun are, because this body is a
   * hazard to fly through rather than a backdrop to be looked at. */
  heroCentreMin: 90,
  heroCentreMax: 150,
  /** Semi-axes of the flattened ellipsoid rocks scatter within, centred on
   * the field's own centre. `y` stays inside the altitude slab's own ~14-unit
   * ceiling (`CLAUDE.md`'s locked write-up) so flying over the field, not
   * just around it, is a real option. */
  heroSpreadXZ: 120,
  heroSpreadY: 10,
  /** How close a near-field rock's sphere may come to the docking corridor
   * segment (station to gate) before it is rejected and rerolled — see the
   * class docblock's own paragraph on the exclusion. */
  dockExclusionMargin: 14,
  /** Reroll attempts before a rock that keeps landing in the corridor is
   * simply dropped rather than forced somewhere the rng never chose — a
   * 35-rock field reads the same as a 36-rock one. */
  dockExclusionRerolls: 8,

  // ── far band — depth only, never collidable ─────────────────────────
  farCount: 80,
  farDistanceMin: 400,
  farDistanceMax: 700,
  farRadiusMin: 0.4,
  farRadiusMax: 1.2,

  // ── furniture — every sector, independent of which hero it cast ────
  furnitureClusterMax: 2,
  furnitureRockMin: 8,
  furnitureRockMax: 12,
  furnitureDistanceMin: 300,
  furnitureDistanceMax: 600,
  /** Scatter radius around a cluster's own centre. Kept well under the gap
   * between `furnitureDistanceMin` (300) and the "never inside 260" floor,
   * so no furniture rock can land inside 260 even at the closest roll. */
  furnitureScatter: 30,
  furnitureRadiusMin: 1.5,
  furnitureRadiusMax: 4.5,
  hulkChance: 0.15,
} as const;

/** A collidable sphere, world space. Task 5's shape to consume. */
export interface Rock {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** One rock's local offset before the field's own tumble is applied. */
interface LocalRock {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** Shared across every sector and every rock group — the material carries no
 * per-sector state (no uniform to update, unlike `GasGiant`/`Moon`'s own
 * `ShaderMaterial`s), so unlike their per-instance materials this one is
 * built once and never disposed; only the geometries it lights are ever
 * per-sector. */
const ROCK_MATERIAL = new MeshLambertMaterial({ color: ASTEROIDS.color, fog: false });

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
 */
function distanceToSegment(point: Vector3, a: Vector3, b: Vector3): number {
  const ab = new Vector3().subVectors(b, a);
  const lengthSq = ab.lengthSq();
  const t = lengthSq > 0 ? MathUtils.clamp(new Vector3().subVectors(point, a).dot(ab) / lengthSq, 0, 1) : 0;
  const closest = a.clone().addScaledVector(ab, t);
  return point.distanceTo(closest);
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
 * One jittered rock, centred on its own local origin (not yet placed). Each
 * of the icosahedron's vertices is pushed out or in by `0.75 + rng.next() *
 * 0.5`, per the brief's own recipe.
 *
 * `IcosahedronGeometry` builds **non-indexed** — three copies of each of the
 * solid's 12 corners, one per adjoining face, rather than 12 shared
 * positions — so jittering by buffer index alone would move the same
 * physical corner by a different amount on each of its three copies and
 * crack the rock open along every edge. Keying the jitter on the corner's
 * own (quantised) rest position collapses those three copies back into one
 * draw before the jitter is rolled, so every face sharing a corner moves it
 * together and the rock stays watertight.
 */
function jitterRock(radius: number, rng: Rng): BufferGeometry {
  const geometry = new IcosahedronGeometry(radius, 0);
  const position = geometry.attributes.position;
  const jitterByCorner = new Map<string, number>();
  const v = new Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let jitter = jitterByCorner.get(key);
    if (jitter === undefined) {
      jitter = 0.75 + rng.next() * 0.5;
      jitterByCorner.set(key, jitter);
    }
    v.multiplyScalar(jitter);
    position.setXYZ(i, v.x, v.y, v.z);
  }
  position.needsUpdate = true;
  // Non-indexed, so this yields flat, per-face normals — exactly the
  // faceted, low-poly read every other hull in this game is built to have.
  geometry.computeVertexNormals();
  return geometry;
}

/** Merge a batch of local-space rock geometries into one, disposing the
 * per-rock originals — the §4.3 discipline every rock group in this file
 * follows: one draw call per group, however many rocks are in it. */
function mergeRocks(parts: BufferGeometry[]): BufferGeometry {
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

  return mergeRocks(parts);
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
   * to consume. Empty outside a `"rocks"` sector, and outside the near
   * field's own `Rock`s: furniture and the far band never appear here.
   * A private backing field plus a readonly getter, rather than a plain
   * public field, so the interface really is `readonly rocks: readonly
   * Rock[]` — reassigned wholesale every `update()` tick internally (see
   * `syncRocks`), never mutable from outside. */
  private _rocks: Rock[] = [];
  get rocks(): readonly Rock[] {
    return this._rocks;
  }

  private key = "";

  // The near field tumbles as one rigid swarm about its own centre — the
  // group's own `.position`/`.rotation.y` carries the render for free every
  // frame, and `syncRocks` below re-derives `this.rocks` from the same
  // angle by the same trig, so the collidable list Task 5 reads never drifts
  // from what is actually on screen.
  private nearGroup: Group | null = null;
  private nearLocal: LocalRock[] = [];
  private readonly nearCentre = new Vector3();
  private nearAngle = 0;

  private farGroup: Group | null = null;
  private readonly furnitureGroups: Group[] = [];
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
    const rng = makeRng((seed * 2901084542 + sector * 893404357 + 3927117762) >>> 0);

    const bearing = rng.next() * Math.PI * 2;
    const distance =
      ASTEROIDS.heroCentreMin + rng.next() * (ASTEROIDS.heroCentreMax - ASTEROIDS.heroCentreMin);
    this.nearCentre.set(Math.sin(bearing) * distance, 0, Math.cos(bearing) * distance);

    this.nearLocal = [];
    const parts: BufferGeometry[] = [];
    // Scratch vector for the corridor-exclusion check below, reused across
    // every rock and every reroll attempt rather than allocated per try.
    const worldPos = new Vector3();
    for (let i = 0; i < ASTEROIDS.heroCount; i++) {
      const r = ASTEROIDS.heroRadiusMin + rng.next() * (ASTEROIDS.heroRadiusMax - ASTEROIDS.heroRadiusMin);
      // Reject-and-reroll: this field's centre (90-150 from origin) already
      // overlaps the starbase's own range (118), so an un-excluded roll can
      // seed a rock inside the station or across its docking corridor —
      // which is mandatory to fly, so a rock embedded in it reads as broken.
      // Checked pre-merge, at this rock's own build-time position (the
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
      parts.push(jitterRock(r, rng).translate(x, y, z));
    }
    const nearMesh = new Mesh(mergeRocks(parts), ROCK_MATERIAL);
    this.nearGroup = Object.assign(new Group(), { name: "asteroids-near" });
    this.nearGroup.position.copy(this.nearCentre);
    this.nearGroup.add(nearMesh);
    this.object.add(this.nearGroup);
    this.nearAngle = 0;
    this.syncRocks();

    // The far band — depth dressing only, never collidable, so it never
    // touches `nearLocal`/`this.rocks`. Scattered around world origin at its
    // own bearing per rock rather than tied to the near field's own bearing,
    // the way the starfield surrounds the player regardless of where any one
    // hero body happens to be standing.
    const farParts: BufferGeometry[] = [];
    for (let i = 0; i < ASTEROIDS.farCount; i++) {
      const farBearing = rng.next() * Math.PI * 2;
      const farDistance =
        ASTEROIDS.farDistanceMin + rng.next() * (ASTEROIDS.farDistanceMax - ASTEROIDS.farDistanceMin);
      const r = ASTEROIDS.farRadiusMin + rng.next() * (ASTEROIDS.farRadiusMax - ASTEROIDS.farRadiusMin);
      const x = Math.sin(farBearing) * farDistance;
      const z = Math.cos(farBearing) * farDistance;
      const y = (rng.next() * 2 - 1) * 40;
      farParts.push(jitterRock(r, rng).translate(x, y, z));
    }
    const farMesh = new Mesh(mergeRocks(farParts), ROCK_MATERIAL);
    this.farGroup = Object.assign(new Group(), { name: "asteroids-far" });
    this.farGroup.add(farMesh);
    this.object.add(this.farGroup);
  }

  /** Every sector's mid-field clutter — 0-2 clusters plus an occasional
   * hulk — independent of whatever `planHero` cast, on its own rng salt so
   * it never correlates with the hero roll. Contributes nothing to
   * `this.rocks`: none of this is meant to be flown through safely enough
   * to skip collision, it is just not this task's collision surface. */
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
      const parts: BufferGeometry[] = [];
      for (let i = 0; i < count; i++) {
        const r =
          ASTEROIDS.furnitureRadiusMin + rng.next() * (ASTEROIDS.furnitureRadiusMax - ASTEROIDS.furnitureRadiusMin);
        const { x, y, z } = sampleEllipsoid(rng, ASTEROIDS.furnitureScatter, ASTEROIDS.furnitureScatter * 0.3);
        parts.push(jitterRock(r, rng).translate(x, y, z));
      }
      const mesh = new Mesh(mergeRocks(parts), ROCK_MATERIAL);
      const group = Object.assign(new Group(), { name: "asteroids-furniture" });
      group.position.copy(centre);
      group.add(mesh);
      this.object.add(group);
      this.furnitureGroups.push(group);
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

  /** Re-derive `this.rocks` from `nearLocal`/`nearCentre`/`nearAngle` — the
   * same Y-axis rotation `Object3D.rotation.y` applies to the mesh, done by
   * hand for the collidable list so the two never disagree. Cheap: 36 rocks,
   * two trig calls and a couple of multiplies each. */
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
   * comment for why this is never per-rock. */
  update(dt: number): void {
    const delta = ASTEROIDS.tumbleRate * dt;
    if (this.nearGroup) {
      this.nearAngle += delta;
      this.nearGroup.rotation.y = this.nearAngle;
      this.syncRocks();
    }
    if (this.farGroup) this.farGroup.rotation.y += delta;
    for (const group of this.furnitureGroups) group.rotation.y += delta;
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
      for (const child of this.nearGroup.children) if (child instanceof Mesh) child.geometry.dispose();
      this.object.remove(this.nearGroup);
    }
    this.nearGroup = null;
    this.nearLocal = [];
    this.nearAngle = 0;
    this._rocks = [];

    if (this.farGroup) {
      for (const child of this.farGroup.children) if (child instanceof Mesh) child.geometry.dispose();
      this.object.remove(this.farGroup);
    }
    this.farGroup = null;

    for (const group of this.furnitureGroups) {
      for (const child of group.children) if (child instanceof Mesh) child.geometry.dispose();
      this.object.remove(group);
    }
    this.furnitureGroups.length = 0;

    if (this.hulk) {
      this.object.remove(this.hulk.group);
      this.hulk.dispose();
    }
    this.hulk = null;
  }
}
