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
 * two unrelated draw calls are racing to exhaust. `main.ts` keeps the combat
 * default and gives scenery 20000 — 480 KB of vertex data, which is nothing.
 */
export class TraceBuffer {
  readonly object: LineSegments;

  private readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly geometry = new BufferGeometry();
  private count = 0;

  constructor(capacity: number = DEFAULT_MAX_SEGMENTS) {
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
        fog: true,
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
