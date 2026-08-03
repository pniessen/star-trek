import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  LineBasicMaterial,
  LineSegments,
  OrthographicCamera,
  Scene,
} from "three";
import { PALETTE } from "../render/palette.js";
import { appendText, measure } from "./strokeFont.js";

const MAX_SEGMENTS = 6000;

/** Instruments are composed against this height and scaled to the window. */
const DESIGN_HEIGHT = 800;

/**
 * Everything the player reads is something the ship is drawing. The HUD lives
 * in an orthographic overlay measured in pixels, built from the same stroke
 * vocabulary as the hulls and fed through the same bloom.
 *
 * One preallocated buffer, rewritten each frame — text changes every frame
 * (speed, heading, energy), so rebuilding geometry would churn the heap.
 */
export class Hud {
  readonly scene = new Scene();
  readonly camera: OrthographicCamera;

  /**
   * Instrument supply, 0→1, applied to every stroke this buffer takes.
   *
   * The panel is one piece of hardware and it browns out as one piece. Asking
   * each readout to remember to dim itself would have every new instrument
   * silently opt out of the ship losing power, which is exactly the sort of
   * thing that only shows up in the one moment it matters.
   */
  power = 1;

  private readonly geometry = new BufferGeometry();
  private readonly positions = new Float32Array(MAX_SEGMENTS * 6);
  private readonly colors = new Float32Array(MAX_SEGMENTS * 6);
  private count = 0;
  private overflowed = false;

  private width = 1;
  private height = 1;

  constructor() {
    this.camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

    this.geometry.setAttribute("position", new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("color", new BufferAttribute(this.colors, 3));

    const material = new LineBasicMaterial({
      vertexColors: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });

    const lines = new LineSegments(this.geometry, material);
    lines.frustumCulled = false;
    this.scene.add(lines);
  }

  /**
   * The HUD is drawn in a fixed design space 800 units tall, and the projection
   * scales that to whatever the window actually is. Laying instruments out in
   * raw pixels means they collide the moment the window is small — panels
   * overlap the scanner and the readouts become unreadable — whereas a virtual
   * space keeps the composition identical at every size and only changes how
   * big it appears.
   *
   * Width follows the aspect ratio rather than being fixed, so a wide window
   * gets more room between the left and right instrument clusters instead of
   * stretched glyphs.
   */
  setSize(width: number, height: number): void {
    this.height = DESIGN_HEIGHT;
    this.width = DESIGN_HEIGHT * (width / Math.max(height, 1));

    this.camera.left = 0;
    this.camera.right = this.width;
    this.camera.top = this.height;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
  }

  begin(): void {
    this.count = 0;
    this.overflowed = false;
  }

  /** Flat pairs of (x0,y0,x1,y1) in pixels, origin bottom-left. */
  segments(flat: readonly number[], color: Color): void {
    const supply = Math.max(0, this.power);
    for (let i = 0; i + 3 < flat.length; i += 4) {
      if (this.count >= MAX_SEGMENTS) {
        this.overflowed = true;
        return;
      }
      const p = this.count * 6;
      this.positions[p] = flat[i];
      this.positions[p + 1] = flat[i + 1];
      this.positions[p + 2] = 0;
      this.positions[p + 3] = flat[i + 2];
      this.positions[p + 4] = flat[i + 3];
      this.positions[p + 5] = 0;
      for (const offset of [p, p + 3]) {
        this.colors[offset] = color.r * supply;
        this.colors[offset + 1] = color.g * supply;
        this.colors[offset + 2] = color.b * supply;
      }
      this.count++;
    }
  }

  text(value: string, x: number, y: number, scale = 2, color: Color = PALETTE.trace): number {
    const flat: number[] = [];
    appendText(flat, value, x, y, scale);
    this.segments(flat, color);
    return measure(value, scale);
  }

  /** Right-aligned to `x`. */
  textRight(value: string, x: number, y: number, scale = 2, color: Color = PALETTE.trace): void {
    this.text(value, x - measure(value, scale), y, scale, color);
  }

  rect(x: number, y: number, w: number, h: number, color: Color): void {
    this.segments(
      [x, y, x + w, y, x + w, y, x + w, y + h, x + w, y + h, x, y + h, x, y + h, x, y],
      color,
    );
  }

  /** A labelled level bar — the readout shape used for every ship system. */
  gauge(
    x: number,
    y: number,
    w: number,
    h: number,
    fraction: number,
    color: Color,
    ticks = 4,
  ): void {
    this.rect(x, y, w, h, PALETTE.traceDim);
    const filled = Math.max(0, Math.min(1, fraction)) * (w - 4);
    const flat: number[] = [];
    for (let i = 0; i < h - 3; i += 2) {
      flat.push(x + 2, y + 2 + i, x + 2 + filled, y + 2 + i);
    }
    for (let i = 1; i < ticks; i++) {
      const tx = x + (w * i) / ticks;
      flat.push(tx, y, tx, y + h * 0.28);
    }
    this.segments(flat, color);
  }

  /** Corner brackets — frames a panel without boxing it in. */
  brackets(x: number, y: number, w: number, h: number, size: number, color: Color): void {
    this.segments(
      [
        x, y + size, x, y, x, y, x + size, y,
        x + w - size, y, x + w, y, x + w, y, x + w, y + size,
        x + w, y + h - size, x + w, y + h, x + w, y + h, x + w - size, y + h,
        x + size, y + h, x, y + h, x, y + h, x, y + h - size,
      ],
      color,
    );
  }

  /** Call once per frame after all drawing. */
  end(): void {
    this.geometry.setDrawRange(0, this.count * 2);
    this.geometry.getAttribute("position").needsUpdate = true;
    this.geometry.getAttribute("color").needsUpdate = true;
    if (this.overflowed) {
      console.warn(`HUD segment budget exceeded (${MAX_SEGMENTS}); output truncated.`);
    }
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }
}
