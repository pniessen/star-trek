import {
  BufferGeometry,
  Color,
  EdgesGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  AdditiveBlending,
  Object3D,
} from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { PALETTE } from "./palette.js";

export type ShapeMode = "wireframe" | "occluded";

/** Every LineMaterial in the scene needs its pixel resolution kept current. */
const liveMaterials = new Set<LineMaterial>();

export function resizeLineMaterials(width: number, height: number): void {
  for (const m of liveMaterials) m.resolution.set(width, height);
}

export interface VectorObjectOptions {
  color?: Color;
  /** Stroke width in pixels. Hero objects want more; distant clutter less. */
  linewidth?: number;
  /** Crease angle in degrees above which an edge is drawn. */
  creaseAngle?: number;
  /** Occluder darkness. Pure void reads as a hole; a hint of hull reads solid. */
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
  private readonly fillMaterial: MeshBasicMaterial;
  private readonly baseWidth: number;

  constructor(geometry: BufferGeometry, opts: VectorObjectOptions = {}) {
    const color = opts.color ?? PALETTE.trace;
    const fill = opts.fill ?? new Color(0x060a0f);
    const fog = opts.fog ?? true;

    // Occluder: writes depth, barely visible, sits fractionally behind its own
    // edges so coincident strokes never z-fight into a dashed mess.
    this.fillMaterial = new MeshBasicMaterial({
      color: fill,
      blending: NormalBlending,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      fog,
    });
    this.hull = new Mesh(geometry, this.fillMaterial);
    this.hull.renderOrder = 0;

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
