import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  type Color,
  LineBasicMaterial,
  LineSegments,
} from "three";

const DEFAULT_MAX_SEGMENTS = 5000;

/**
 * A world-space scratch pad for strokes that exist for one frame.
 *
 * Phaser beams, torpedo streaks, explosion debris and scanner pings are all the
 * same thing to this renderer — a line with a colour — so they all go through
 * one preallocated buffer and one draw call rather than each growing its own
 * object pool and material.
 *
 * Thin lines by design: fat lines cost an instanced quad each and these are
 * transient, numerous, and already blown out by bloom.
 *
 * Capacity is a constructor argument, not a shared constant, because combat and
 * scenery must not share one ceiling. A single buffer would mean a busy
 * firefight silently deletes the sky — phaser beams and torpedo streaks
 * elbowing out the strokes that draw the sector around them — and the comet's
 * tail alone already spends 779 segments of a 5000 budget. Two buffers means
 * each has a ceiling that means something on its own, rather than one number
 * two unrelated draw calls are racing to exhaust. `main.ts` keeps combat's
 * default; a scenery instance at 20000 segments would cost 960 KB of vertex
 * data — 480 KB each for `positions` and `colors`, the two `Float32Array`s
 * this class allocates per instance — which is nothing. **No scenery
 * instance exists right now**: the giant, the only body that ever pushed
 * strokes into one, moved to a lit mesh (`docs/environment.md` §1.5) before
 * that buffer had a second consumer, so it was deleted rather than kept
 * empty. These two parameters are what a later stage's own scenery buffer
 * — gas shoals, dust — will pass; this class does not depend on one
 * existing.
 *
 * `fog` is a second, independent reason two buffers with different
 * producers cannot share one. `Stage`'s scene fog (`45..260`) mixes an
 * additively-blended stroke toward black as it approaches the far bound,
 * and at or past it the stroke contributes nothing at all — it does not
 * dim, it disappears. That is correct for combat's `trace`, whose contents
 * live at engagement range, and would be wrong for a body worth flying
 * toward (`GasGiant`'s hero body sits 640-1160 units out): fogged the same
 * way, it would be silently invisible the whole time it is worth looking
 * at. `main.ts` keeps combat's default `fog: true`; a scenery instance
 * would want `false`.
 */
export class TraceBuffer {
  readonly object: LineSegments;

  private readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly geometry = new BufferGeometry();
  private count = 0;

  constructor(capacity: number = DEFAULT_MAX_SEGMENTS, fog = true) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 6);
    this.colors = new Float32Array(capacity * 6);
    this.geometry.setAttribute("position", new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("color", new BufferAttribute(this.colors, 3));

    this.object = new LineSegments(
      this.geometry,
      new LineBasicMaterial({
        vertexColors: true,
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
        fog,
      }),
    );
    this.object.frustumCulled = false;
    this.object.renderOrder = 2;
  }

  begin(): void {
    this.count = 0;
  }

  /** `intensity` scales the colour, so a stroke can fade without a per-line material. */
  push(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    color: Color,
    intensity = 1,
  ): void {
    if (this.count >= this.capacity) return;
    const p = this.count * 6;
    this.positions[p] = ax;
    this.positions[p + 1] = ay;
    this.positions[p + 2] = az;
    this.positions[p + 3] = bx;
    this.positions[p + 4] = by;
    this.positions[p + 5] = bz;

    const r = color.r * intensity;
    const g = color.g * intensity;
    const b = color.b * intensity;
    for (const offset of [p, p + 3]) {
      this.colors[offset] = r;
      this.colors[offset + 1] = g;
      this.colors[offset + 2] = b;
    }
    this.count++;
  }

  end(): void {
    this.geometry.setDrawRange(0, this.count * 2);
    this.geometry.getAttribute("position").needsUpdate = true;
    this.geometry.getAttribute("color").needsUpdate = true;
  }
}
