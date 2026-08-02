import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  LineBasicMaterial,
  LineSegments,
  Object3D,
  Vector3,
} from "three";
import { PALETTE } from "../render/palette.js";

/**
 * The play space is a plane, so the world gets a plane's furniture: a grid that
 * gives distance and speed a reference, and a starfield that does not.
 *
 * The grid is the visual argument for the design decision. If the scanner is to
 * be trusted absolutely — every contact exactly where the map says it is —
 * combat has to happen on a flat sheet, and the player needs to see the sheet.
 */

export interface Grid {
  readonly object: Object3D;
  follow(x: number, z: number): void;
}

export function createGrid(cell = 12, extent = 26): Grid {
  const lines: number[] = [];
  const span = cell * extent;

  for (let i = -extent; i <= extent; i++) {
    const offset = i * cell;
    lines.push(offset, 0, -span, offset, 0, span);
    lines.push(-span, 0, offset, span, 0, offset);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(lines), 3));

  const object = new LineSegments(
    geometry,
    new LineBasicMaterial({
      // Kept under the bloom threshold: the grid is a reference, not a subject,
      // and edge-on lines at eye height blow out fast.
      color: PALETTE.traceDim.clone().multiplyScalar(0.32),
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: true,
    }),
  );
  object.frustumCulled = false;
  object.renderOrder = -1;

  return {
    object,
    // Snap to the nearest cell so a finite grid reads as an infinite one.
    follow(x: number, z: number): void {
      object.position.set(Math.round(x / cell) * cell, 0, Math.round(z / cell) * cell);
    },
  };
}

/**
 * Stars as short streaks rather than points: they take the bloom properly, and
 * a streak has an orientation, which sells rotation at a glance when the ship
 * yaws hard.
 */
export function createStarfield(count = 900, radius = 900): Object3D {
  const positions = new Float32Array(count * 6);
  const colors = new Float32Array(count * 6);
  const tint = new Color();

  for (let i = 0; i < count; i++) {
    // Spherical shell, biased toward the horizon so the plane stays legible.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(1 - 2 * Math.random());
    const flattened = Math.pow(Math.sin(phi), 0.35);
    const direction = new Vector3(
      Math.cos(theta) * flattened,
      Math.cos(phi) * 0.55,
      Math.sin(theta) * flattened,
    ).normalize();

    const distance = radius * (0.7 + Math.random() * 0.3);
    const start = direction.clone().multiplyScalar(distance);
    const end = direction.clone().multiplyScalar(distance + 8 + Math.random() * 14);

    positions.set([start.x, start.y, start.z, end.x, end.y, end.z], i * 6);

    const brightness = 0.5 + Math.pow(Math.random(), 2.2) * 0.9;
    tint.copy(PALETTE.star).multiplyScalar(brightness);
    for (const offset of [i * 6, i * 6 + 3]) {
      colors[offset] = tint.r;
      colors[offset + 1] = tint.g;
      colors[offset + 2] = tint.b;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("color", new BufferAttribute(colors, 3));

  const stars = new LineSegments(
    geometry,
    new LineBasicMaterial({
      vertexColors: true,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false, // stars are at infinity; fog would erase them
    }),
  );
  stars.frustumCulled = false;
  stars.renderOrder = -2;
  return stars;
}
