import { BoxGeometry, BufferGeometry, CylinderGeometry, Matrix4, TorusGeometry } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Hulls are built from a handful of low-segment primitives and merged into one
 * solid. Two reasons for the low counts: the crease edges then read as visible
 * facets, which is the vector look, and every ship in the game costs a few
 * dozen strokes rather than an asset budget.
 *
 * Convention: +Z is forward, +Y is up, and the play space is the XZ plane.
 */

function placed(geometry: BufferGeometry, matrix: Matrix4): BufferGeometry {
  return geometry.applyMatrix4(matrix);
}

function at(x: number, y: number, z: number): Matrix4 {
  return new Matrix4().makeTranslation(x, y, z);
}

/** Lay a cylinder (Y-axis by default) along Z, then move it into place. */
function alongZ(x: number, y: number, z: number): Matrix4 {
  return at(x, y, z).multiply(new Matrix4().makeRotationX(Math.PI / 2));
}

/** The player: saucer, neck, engineering hull, two nacelles on pylons. */
export function buildCruiser(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Saucer — 14 sides gives a clean faceted disc rather than a smooth blob.
  parts.push(placed(new CylinderGeometry(1.3, 1.08, 0.3, 14, 1), at(0, 0, 1.15)));
  parts.push(placed(new CylinderGeometry(0.42, 0.78, 0.26, 14, 1), at(0, 0.28, 1.15)));

  // Neck, swept back.
  parts.push(
    placed(
      new BoxGeometry(0.22, 0.9, 0.5),
      at(0, -0.28, 0.42).multiply(new Matrix4().makeRotationX(-0.42)),
    ),
  );

  // Engineering hull.
  parts.push(placed(new CylinderGeometry(0.4, 0.32, 1.9, 10, 1), alongZ(0, -0.62, -0.55)));
  parts.push(placed(new CylinderGeometry(0.18, 0.18, 0.22, 8, 1), alongZ(0, -0.62, -1.62)));

  for (const side of [-1, 1]) {
    // Nacelles.
    parts.push(placed(new CylinderGeometry(0.2, 0.2, 2.4, 8, 1), alongZ(side * 1.12, 0.46, -0.5)));
    parts.push(
      placed(new CylinderGeometry(0.13, 0.2, 0.3, 8, 1), alongZ(side * 1.12, 0.46, 0.82)),
    );
    // Pylon, angled out and up from the engineering hull.
    parts.push(
      placed(
        new BoxGeometry(0.12, 1.2, 0.44),
        at(side * 0.62, -0.12, -0.85).multiply(new Matrix4().makeRotationZ(side * -0.72)),
      ),
    );
  }

  return mergeGeometries(parts, false)!;
}

/**
 * The hostile: a forward-swept dart. Angular where the cruiser is round, so the
 * two read apart instantly at a distance — silhouette is doing the work that
 * colour alone cannot when a contact is a dozen pixels wide.
 */
export function buildInterceptor(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  parts.push(placed(new CylinderGeometry(0.0, 0.46, 2.2, 3, 1), alongZ(0, 0, 0.3)));
  parts.push(placed(new CylinderGeometry(0.34, 0.24, 0.9, 3, 1), alongZ(0, 0, -1.1)));

  for (const side of [-1, 1]) {
    parts.push(
      placed(
        new BoxGeometry(1.5, 0.09, 0.62),
        at(side * 0.82, 0, -0.55).multiply(new Matrix4().makeRotationY(side * 0.42)),
      ),
    );
    parts.push(placed(new CylinderGeometry(0.11, 0.11, 0.8, 6, 1), alongZ(side * 1.34, 0, -0.75)));
  }

  return mergeGeometries(parts, false)!;
}

/**
 * The heavy: a slab. Where the interceptor is a thin dart, this is wide and
 * blunt, so at scanner range the two are told apart by outline alone — colour
 * cannot do that job when a contact is a dozen pixels across.
 */
export function buildBrawler(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  parts.push(placed(new BoxGeometry(2.2, 0.8, 3.0), at(0, 0, 0)));
  parts.push(placed(new CylinderGeometry(0.0, 0.9, 1.4, 4), alongZ(0, 0, 2.0)));

  for (const side of [-1, 1]) {
    parts.push(placed(new BoxGeometry(0.7, 0.5, 2.2), at(side * 1.5, 0, -0.4)));
    parts.push(
      placed(new CylinderGeometry(0.22, 0.28, 1.6, 6), alongZ(side * 1.5, 0.45, 0.6)),
    );
  }
  parts.push(placed(new BoxGeometry(1.1, 0.9, 1.0), at(0, 0.55, -1.1)));

  return mergeGeometries(parts, false)!;
}

/**
 * Starbase: a drum inside a docking ring. The ring matters — docking is a skill
 * test, so the approach corridor has to be legible from a long way out.
 */
export function buildStarbase(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  parts.push(new CylinderGeometry(2.6, 2.6, 3.4, 12, 1));
  parts.push(placed(new CylinderGeometry(1.5, 2.6, 1.2, 12, 1), at(0, 2.3, 0)));
  parts.push(placed(new CylinderGeometry(1.5, 2.6, 1.2, 12, 1), at(0, -2.3, 0)));
  // Torus is born in the XY plane; stand it up around the drum's Y axis.
  parts.push(
    placed(new TorusGeometry(4.6, 0.34, 4, 16), new Matrix4().makeRotationX(Math.PI / 2)),
  );

  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    parts.push(
      placed(
        new BoxGeometry(2.1, 0.3, 0.3),
        at(Math.cos(angle) * 3.6, 0, Math.sin(angle) * 3.6).multiply(
          new Matrix4().makeRotationY(-angle),
        ),
      ),
    );
  }

  return mergeGeometries(parts, false)!;
}
