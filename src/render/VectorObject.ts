import {
  BufferGeometry,
  Color,
  EdgesGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  NormalBlending,
  AdditiveBlending,
  Object3D,
} from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { PALETTE } from "./palette.js";
import { RIG } from "./light.js";
import { shadowed } from "./shadows.js";

export type ShapeMode = "wireframe" | "occluded";

/** Every LineMaterial in the scene needs its pixel resolution kept current. */
const liveMaterials = new Set<LineMaterial>();

export function resizeLineMaterials(width: number, height: number): void {
  for (const m of liveMaterials) m.resolution.set(width, height);
}

/**
 * The scene ambient's own diffuse contribution, as three.js computes it.
 *
 * `main.ts` adds one `AmbientLight` under the sector's `DirectionalLight`, and
 * three.js's physically-based lighting path (the only path left in 0.185 —
 * `useLegacyLights` is gone) resolves a Lambert surface to
 * `albedo * (ambient + dotNL * directional) / PI`. So the *darkest* a lit fill
 * can get — the night side, star fully behind the hull — is
 * `albedo * ambient / PI`, and that is the number the constructor divides by to
 * turn a caller's requested occluder darkness back into an albedo.
 *
 * Read off `RIG` rather than written out here. This shipped as a hand-copied
 * `0.12 / Math.PI` with a staleness warning attached, which was an accurate
 * description of a bug waiting to happen: move the ambient and every hull's
 * night side moves with it, silently, with nothing failing. Both readers now
 * take the same number from `render/light.ts`, so there is nothing to keep in
 * step.
 */
const AMBIENT_DIFFUSE = RIG.ambient / Math.PI;

export interface VectorObjectOptions {
  color?: Color;
  /** Stroke width in pixels. Hero objects want more; distant clutter less. */
  linewidth?: number;
  /** Crease angle in degrees above which an edge is drawn. */
  creaseAngle?: number;
  /**
   * Occluder darkness. Pure void reads as a hole; a hint of hull reads solid.
   *
   * This is still the **final colour of the unlit side**, not the material's
   * albedo — the constructor divides it up into one. That is deliberate: the
   * fill went from an unlit `MeshBasicMaterial` to a lit `MeshLambertMaterial`
   * (see the class comment), which would otherwise have silently redefined
   * what every caller's number means. Passing a near-void colour here and
   * getting a near-void night side is the contract that was already written
   * down, and it survives the change intact.
   */
  fill?: Color;
  /**
   * Whether `Stage`'s scene fog (`45..260`, `Stage.ts`) applies. Defaults
   * `true` — right for every hull and every existing caller, which all live
   * well inside that range. A body meant to be seen past 260 units needs
   * `false`, or the fog shader mixes its strokes toward the scene's black
   * fog colour and an additively-blended stroke fogged to black contributes
   * nothing — it does not dim, it disappears. `Planet.ts`'s ring already
   * hand-builds a `fog: false` material for exactly this reason; this is
   * that same escape hatch, generalised so a body's own shell can take it
   * too instead of every caller re-deriving the fix.
   */
  fog?: boolean;
  /**
   * Whether this object's occluder fill takes part in the sector star's
   * shadows (`render/shadows.ts`). Defaults `true`, which is right for every
   * hull, mine, station and wreck in the game — they are opaque solids
   * standing in a lit sector, and one of them passing between the star and a
   * rock field is the whole point of the feature.
   *
   * Only ever set `false` for a solid that is *not* really there: a ghost, a
   * preview, a proxy. Note this governs *casting* only — receiving stays on
   * unconditionally, and deliberately so, because `receiveShadow` is part of
   * three's program cache key and a fill that disagreed with its neighbours
   * about it would compile a second shader program at whatever moment it
   * first appeared. See `shadowed`'s own comment.
   */
  castShadow?: boolean;
}

/**
 * A solid built once, drawn two ways.
 *
 * Pure wireframe is the authentic 1982 look and an unreadable thicket the
 * moment two ships overlap — you cannot tell which is in front. The occluded
 * mode keeps the identical glowing strokes but fills the faces with near-void
 * opaque polygons, so hulls properly hide what is behind them. Same silhouette,
 * unambiguous depth.
 *
 * Both modes share one geometry and one edge set, so switching is free and the
 * comparison is honest.
 *
 * **The occluder is lit; the strokes are not, and never will be.** The sector
 * has had a real star since `docs/environment.md` §3.1 ("one light source per
 * sector, and every body obeys it") and every hull ignored it — the fill was
 * a `MeshBasicMaterial`, the edges are a flat-colour `LineMaterial`, and both
 * are unlit by definition, so you could fly past a lit gas giant in a ship
 * that was uniformly bright on every face. The fill now samples the scene's
 * standing `sun`/`sunFill` pair through three.js's own lighting pipeline, the
 * way `render/Asteroids.ts` already does, and hulls acquire a terminator that
 * moves as they turn.
 *
 * The strokes are untouched by construction. They are the game's identity,
 * they are additive so they *are* the light rather than receiving it, and the
 * locked "colour is information" rule prices every hue — a stroke that dimmed
 * on the dark side would read as a contact changing allegiance. Form comes
 * from the fill; identity stays with the edges.
 */
export class VectorObject {
  readonly group = new Group();
  readonly edges: LineSegments2;
  readonly hull: Mesh;

  /**
   * The flat stroke list this object is drawn from, kept so an explosion can
   * fling the actual segments that drew the ship rather than a particle system
   * standing in for them.
   */
  readonly edgePositions: readonly number[];

  private readonly lineMaterial: LineMaterial;
  private readonly fillMaterial: MeshLambertMaterial;
  private readonly baseWidth: number;

  constructor(geometry: BufferGeometry, opts: VectorObjectOptions = {}) {
    const color = opts.color ?? PALETTE.trace;
    const fill = opts.fill ?? new Color(0x060a0f);
    const fog = opts.fog ?? true;

    /**
     * The albedo the requested `fill` implies. `Color` holds linear working
     * space here (three.js colour management is on by default and `fill` came
     * in through `setHex`, which converts), so this is one honest division in
     * the space the shader multiplies in — no gamma guesswork.
     *
     * Clamped because the sum only inverts while it can: an albedo is bounded
     * at 1, so a `fill` brighter than `AMBIENT_DIFFUSE` cannot have its night
     * side preserved and gets the brightest hull the rig can build instead.
     * The default is nowhere near it — but a future caller asking for a
     * lighter occluder should degrade rather than wrap.
     *
     * **What this actually tunes to**, for the default `0x060a0f` and the
     * rig `main.ts` currently stands up (directional 1.4, ambient 0.12):
     * albedo `#3e5063`, a dim slate; night side `#060a0f` to the byte, so
     * nothing anywhere is darker than it was before this change; full lit
     * `#2a3746`. That is 12.7× in linear but only ~3.2× on the display side
     * of the output encode, which is the ratio that makes this read as a
     * terminator rather than as a lamp — the point is form, not brightness,
     * and the hull stays near-void at both ends of it. It also never blooms:
     * `Stage.ts`'s `UnrealBloomPass` thresholds at 0.5 and the brightest a
     * fill can reach is 0.0605 linear, so a lit face cannot start competing
     * with the strokes it is supposed to sit behind.
     */
    const albedo = fill.clone().multiplyScalar(1 / AMBIENT_DIFFUSE);
    albedo.setRGB(Math.min(albedo.r, 1), Math.min(albedo.g, 1), Math.min(albedo.b, 1));

    // Occluder: writes depth, barely visible, sits fractionally behind its own
    // edges so coincident strokes never z-fight into a dashed mess.
    //
    // `MeshLambertMaterial` rather than `MeshStandardMaterial`: the only thing
    // wanted here is a terminator, and Standard's extra term is a specular
    // highlight — a bright moving spot on a hull, which "colour is
    // information" has no slot for and which would read as a flash, the one
    // signal reserved for hostiles (`docs/environment.md` §4.1). Lambert is
    // also what `render/Asteroids.ts` already uses for the same job at the
    // same near-void end of the range, so both bodies answer the sector's
    // star with the same maths, and it is the cheaper of the two on a fill
    // that covers a lot of pixels in a game whose whole cost is fill rate
    // (`docs/environment.md` §1: "fill rate, not geometry, is what this game
    // costs").
    //
    // `flatShading` because the strokes already committed to where the facets
    // are. `EdgesGeometry` draws a line at every crease past 18°, so smooth
    // vertex normals would shade a nacelle as a rounded cylinder inside an
    // outline that says it has eight flat sides — the fill and the edges
    // disagreeing about the same hull. Flat facets put one value on each
    // panel the strokes bound, which is the read this change is for. It also
    // quietly rescues geometry whose normals were never recomputed after its
    // vertices moved: `game/comet.ts`'s nucleus jitters an icosahedron's
    // positions in place and leaves the normal attribute stale, and a
    // derivative-computed normal cannot be stale.
    this.fillMaterial = new MeshLambertMaterial({
      color: albedo,
      flatShading: true,
      blending: NormalBlending,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      fog,
    });
    this.hull = new Mesh(geometry, this.fillMaterial);
    this.hull.renderOrder = 0;

    // The fill is the only half of this object that can take part in a
    // shadow, in either direction. Casting: the strokes are lines, and a
    // line has no area to block a star with — the solid the strokes are
    // drawn *from* is what occludes, which is exactly the same relationship
    // the occluded shape mode already relies on. Receiving: the strokes are
    // additively blended, so they *are* the light rather than receiving it
    // (this class's own header), and darkening one under a shadow would read
    // as a contact changing allegiance under the locked "colour is
    // information" rule. `setMode("wireframe")` therefore also switches this
    // object's shadow off, by the same `hull.visible` flag — correct, since
    // in that mode nothing occludes anything anyway.
    shadowed(this.hull, opts.castShadow ?? true);

    // Strokes: additive, so overlapping traces bloom toward white where they
    // cross — the single most characteristic vector-monitor artefact.
    const edgeGeometry = new EdgesGeometry(geometry, opts.creaseAngle ?? 18);
    const positions = Array.from(edgeGeometry.getAttribute("position").array as Float32Array);
    edgeGeometry.dispose();
    this.edgePositions = positions;

    this.baseWidth = opts.linewidth ?? 1.6;
    this.lineMaterial = new LineMaterial({
      color: color.getHex(),
      linewidth: this.baseWidth,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      dashed: false,
      fog,
    });
    liveMaterials.add(this.lineMaterial);

    this.edges = new LineSegments2(
      new LineSegmentsGeometry().setPositions(positions),
      this.lineMaterial,
    );
    this.edges.renderOrder = 1;
    this.edges.computeLineDistances();

    this.group.add(this.hull, this.edges);
  }

  setMode(mode: ShapeMode): void {
    this.hull.visible = mode === "occluded";
  }

  setColor(color: Color): void {
    this.lineMaterial.color.copy(color);
  }

  /** Flash the strokes — used for hits, alerts, and the docking handshake. */
  setIntensity(scale: number): void {
    this.lineMaterial.linewidth = this.baseWidth * scale;
  }

  addTo(parent: Object3D): this {
    parent.add(this.group);
    return this;
  }

  dispose(): void {
    liveMaterials.delete(this.lineMaterial);
    this.lineMaterial.dispose();
    this.fillMaterial.dispose();
    this.edges.geometry.dispose();
  }
}
