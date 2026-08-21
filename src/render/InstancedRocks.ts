import {
  BufferGeometry,
  Color,
  Euler,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Material,
  Matrix4,
  Quaternion,
  Vector3,
} from "three";
import { makeRng, type Rng } from "../chart/rng.js";

/**
 * The instancing bench under `render/Asteroids.ts` — the machinery that lets
 * a field carry thousands of rocks instead of dozens.
 *
 * **Why this file exists.** `Asteroids.ts` shipped merging every rock in a
 * group into one `BufferGeometry`, on `docs/environment.md` §4.3's own
 * argument — "a dozen bodies is nothing; forty individual asteroids is not."
 * That argument was about *draw calls*, and merging is the right answer to it
 * only while the rock count is small enough that the merged buffer stays
 * small. It is the wrong answer at a thousand rocks: the merged geometry is
 * rebuilt vertex by vertex on every sector change, it costs one unique
 * position/normal per rock corner in VRAM, and the whole field is one
 * bounding sphere so nothing in it can ever be culled.
 * `InstancedMesh` answers the same §4.3 complaint with a better trade — one
 * draw call *per silhouette* for any number of rocks, one shared geometry
 * uploaded once for the life of the page, and a per-instance matrix that is
 * 64 bytes rather than a whole rock's worth of vertices.
 *
 * **What the budget said.** Measured on the machine this was built on (M2
 * Max, 3024×1964): the whole scene plus post chain is ~4.0 ms/frame against a
 * 16.6 ms budget, twelve extra hostile hulls measured 0.00 ms, and hiding the
 * entire sky and every scenery body saved 0.05 ms of that 4.0. The frame is
 * bandwidth and fill, not vertices. So the conservative rock count was
 * conservatism spent on nothing — it bought back a cost the frame was not
 * paying.
 *
 * **Five silhouettes, not one, and not a thousand.** Per-instance rotation
 * and *non-uniform* scale already hide repetition well at these screen sizes,
 * but a single base shape still reads as one shape repeated the moment two
 * rocks are close enough to compare — which, in a dense field, is constantly.
 * Five bases (below) times three independent scale axes times a free rotation
 * is far past the point where the eye can find the pattern.
 * The alternative closed off here is genuinely tempting and was rejected on
 * purpose: one base geometry plus a per-instance seed attribute, jittered in
 * the *vertex shader*, would give every one of thousands of rocks a unique
 * silhouette in exactly **one** draw call (and `flatShading` would even
 * recover correct faceted normals for free, since three derives those with
 * `dFdx`/`dFdy` on the view position rather than from the normal attribute).
 * It was not taken because it puts the silhouette somewhere nothing on the
 * CPU can read: the collidable boulders' radii would then describe a shape
 * only the GPU knows, and this project has one hard rule about the rock
 * field — the collidable list and the thing on screen may never disagree
 * (`Asteroids.syncRocks`'s own comment). Five CPU-side silhouettes cost four
 * extra draw calls, and four draw calls are, on the measurement above,
 * indistinguishable from zero.
 */

/** How many base rock shapes exist. Callers index `silhouette(i)` with
 * `0 <= i < SILHOUETTE_COUNT`, or pass a narrower subset when a field is far
 * enough away that fewer shapes still hide the repetition — every shape a
 * field actually uses costs it one draw call, so a band of specks at 900
 * units has no business paying for five. */
export const SILHOUETTE_COUNT = 5;

/**
 * One jittered rock at unit radius, centred on its own origin — the shared
 * base geometry an `InstancedMesh` repeats. Per-instance scale sets the real
 * size, which is the whole reason these are built at radius 1.
 *
 * `IcosahedronGeometry` builds **non-indexed** — three copies of each corner,
 * one per adjoining face, rather than one shared position — so jittering by
 * buffer index alone would move the same physical corner by a different
 * amount on each of its copies and crack the rock open along every edge.
 * Keying the jitter on the corner's own (quantised) rest position collapses
 * those copies back into one draw before the jitter is rolled, so every face
 * sharing a corner moves it together and the rock stays watertight. This is
 * lifted verbatim from the merged-geometry version's `jitterRock`, because
 * the bug it avoids is a property of `IcosahedronGeometry`, not of how the
 * result is drawn.
 */
function unitRock(
  detail: number,
  jitterLow: number,
  jitterHigh: number,
  squash: readonly [number, number, number],
  rng: Rng,
): BufferGeometry {
  const geometry = new IcosahedronGeometry(1, detail);
  const position = geometry.attributes.position;
  const jitterByCorner = new Map<string, number>();
  const v = new Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let jitter = jitterByCorner.get(key);
    if (jitter === undefined) {
      jitter = jitterLow + rng.next() * (jitterHigh - jitterLow);
      jitterByCorner.set(key, jitter);
    }
    v.multiplyScalar(jitter);
    position.setXYZ(i, v.x * squash[0], v.y * squash[1], v.z * squash[2]);
  }
  position.needsUpdate = true;
  // Non-indexed, so this yields flat, per-face normals — exactly the
  // faceted, low-poly read every other hull in this game is built to have.
  geometry.computeVertexNormals();
  // Every instance of this shape is a rotated, scaled copy of the same
  // vertices, so the base bounds are computed once here rather than by
  // three's own lazy path on first render.
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The five bases, built lazily on first use and then shared by every sector
 * and every field for the life of the page — deliberately **not** per-sector.
 *
 * They are rolled from a fixed seed rather than the campaign's, which is the
 * one place in this file that steps outside the "everything derives from the
 * campaign seed" habit, and it is on purpose: a silhouette is a *prop*, not a
 * fact about a sector. Re-rolling it per sector would mean re-uploading five
 * geometries on every sector change to produce five rocks nobody could tell
 * from the last five, and would forfeit the main structural win here — the
 * geometry is uploaded once and never touched again, so a sector change
 * writes instance matrices and nothing else. Sector-to-sector variety comes
 * from placement, scale and count, all of which *are* seeded (see
 * `Asteroids.buildHeroField`).
 *
 * The recipes are chosen to be distinguishable in *outline*, since that is
 * all that survives at a few pixels across: a many-faced cobble, a long
 * splinter, a flat slab, the plain lump the merged version always drew, and a
 * craggy knuckle. The two detail-0 shapes (20 faces) are listed first so a
 * distant band can take `[0..1]`-ish subsets and get the cheap ones.
 */
const SILHOUETTE_RECIPES: readonly {
  detail: number;
  low: number;
  high: number;
  squash: readonly [number, number, number];
}[] = [
  // 0 — the plain lump: exactly the shape the merged field always drew, kept
  // as a base so the field's character did not change when its density did.
  { detail: 0, low: 0.75, high: 1.25, squash: [1, 1, 1] },
  // 1 — a splinter, long on one axis: the shape that reads as "broken off".
  { detail: 0, low: 0.55, high: 1.35, squash: [0.68, 0.72, 1.65] },
  // 2 — a slab, flattened: catches the sector light across a broad face.
  { detail: 0, low: 0.7, high: 1.3, squash: [1.45, 0.5, 1.15] },
  // 3 — a cobble, 80 faces and mildly jittered: rounded, the odd one out in a
  // field of angular debris, which is what makes the field read as sorted.
  { detail: 1, low: 0.84, high: 1.16, squash: [1, 0.9, 1.05] },
  // 4 — a knuckle: 80 faces jittered hard, so the extra faces read as crags
  // rather than as smoothness.
  { detail: 1, low: 0.62, high: 1.42, squash: [1.15, 1.05, 0.85] },
];

let silhouettes: BufferGeometry[] | null = null;

/** The shared base geometry for shape `index`. Built on first call and never
 * disposed — see `SILHOUETTE_RECIPES`'s own note on why these outlive a
 * sector. */
export function silhouette(index: number): BufferGeometry {
  if (silhouettes === null) {
    // A fixed seed, not the campaign's: see the block comment above.
    const rng = makeRng(0x5ea1_0c3b);
    silhouettes = SILHOUETTE_RECIPES.map((r) => unitRock(r.detail, r.low, r.high, r.squash, rng));
  }
  return silhouettes[index % SILHOUETTE_COUNT];
}

/** Eleven numbers per instance, packed flat rather than kept as objects:
 * position (3), scale (3), euler rotation (3), value tint, warm/cool skew.
 * A field of five thousand rocks is five thousand objects the garbage
 * collector would otherwise have to walk on every sector change, for data
 * that is copied straight into a `Matrix4` and then never read again. */
const STRIDE = 11;

/**
 * An accumulating scatter of rocks that becomes one `InstancedMesh` per
 * silhouette actually used.
 *
 * Two-phase on purpose — `add` during the seeded roll, `build` once at the
 * end — because the per-shape instance counts are not known until the roll is
 * finished, and `InstancedMesh` wants its count up front. The alternative
 * (roll twice, once to count and once to place) would mean either running the
 * rng twice, which is a determinism bug waiting to happen, or storing the
 * roll anyway, which is what this does.
 */
export class RockScatter {
  private readonly rows = new Map<number, number[]>();

  /**
   * One rock. `rx`/`ry`/`rz` are an euler rotation; `sx`/`sy`/`sz` are the
   * real world-space semi-axes, since the base geometry is unit radius.
   * `tint` scales the material's own colour and `warm` skews it very slightly
   * toward red or blue — both are per-instance colour, which costs no extra
   * draw call, and both stay small because `ASTEROIDS.color`'s own docblock
   * locks rocks desaturated: a warm small rock at range with any real
   * saturation reads as a Raider.
   */
  add(
    shape: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    rx: number,
    ry: number,
    rz: number,
    tint: number,
    warm: number,
  ): void {
    const key = shape % SILHOUETTE_COUNT;
    let row = this.rows.get(key);
    if (row === undefined) {
      row = [];
      this.rows.set(key, row);
    }
    row.push(x, y, z, sx, sy, sz, rx, ry, rz, tint, warm);
  }

  /** How many rocks have been added — the count this field will actually
   * draw, for the diagnostics `Asteroids` reports. */
  get count(): number {
    let total = 0;
    for (const row of this.rows.values()) total += row.length / STRIDE;
    return total;
  }

  /**
   * Turn the accumulated rocks into meshes and hang them off `group`.
   *
   * `material` is shared and never disposed by this class — a per-sector
   * material would be a per-sector *shader program*, and a program compile is
   * a >100 ms stall in the frame it lands in. The same reasoning is why
   * `__scenery.hide()` toggles `visible` rather than swapping anything the
   * renderer would have to recompile against, and why every mesh this class
   * builds carries an `instanceColor` even when its tints are all 1.0:
   * `USE_INSTANCING_COLOR` is a program variant, so a field with per-instance
   * colour and a field without would be two programs, compiled at whichever
   * unlucky moment the second kind first appeared.
   */
  build(group: Group, material: Material): InstancedMesh[] {
    const meshes: InstancedMesh[] = [];
    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const euler = new Euler();
    const position = new Vector3();
    const scale = new Vector3();
    const color = new Color();
    for (const [shape, row] of this.rows) {
      const count = row.length / STRIDE;
      if (count === 0) continue;
      const mesh = new InstancedMesh(silhouette(shape), material, count);
      mesh.name = "rock-instances";
      for (let i = 0; i < count; i++) {
        const o = i * STRIDE;
        position.set(row[o], row[o + 1], row[o + 2]);
        scale.set(row[o + 3], row[o + 4], row[o + 5]);
        euler.set(row[o + 6], row[o + 7], row[o + 8]);
        quaternion.setFromEuler(euler);
        mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
        const tint = row[o + 9];
        const warm = row[o + 10];
        color.setRGB(tint * (1 + warm), tint, tint * (1 - warm));
        mesh.setColorAt(i, color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // Instances are placed all over the field, so the mesh's own bounds are
      // the union of theirs — computed once here, because three otherwise
      // leaves `boundingSphere` null and falls back to never culling.
      mesh.computeBoundingSphere();
      group.add(mesh);
      meshes.push(mesh);
    }
    return meshes;
  }
}

/**
 * Release one field's instance buffers. Deliberately does **not** touch
 * `mesh.geometry` — that is a shared silhouette, and disposing it here would
 * quietly delete the base shape out from under every other field still using
 * it, then force a re-upload the next time any of them drew. `InstancedMesh.
 * dispose` frees exactly what is per-field: the matrix and colour attributes.
 */
export function disposeRockMeshes(group: Group, meshes: InstancedMesh[]): void {
  for (const mesh of meshes) {
    group.remove(mesh);
    mesh.dispose();
  }
  meshes.length = 0;
}
