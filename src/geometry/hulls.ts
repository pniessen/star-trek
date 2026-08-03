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
 * The hostile roster is built from the genre's silhouette grammar rather than
 * from any particular studio's ships: a stooping raptor, a horseshoe with its
 * mouth open, and a bulb on a neck between swept wings. Those three outlines
 * have meant "predator", "elegant capital ship" and "battlecruiser" in screen
 * science fiction since the sixties, and they are recognisable at the size of a
 * scanner blip, which is the only size that matters here.
 *
 * All three are our own geometry. The archetype is shared vocabulary; the
 * specific hulls are not.
 */

/**
 * Raider — the stooping raptor. Forward-swept wings drooping into a dive, a
 * narrow body, a head thrust out in front on a short neck. Reads as fast and
 * predatory before you can make out any detail.
 */
export function buildRaider(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  parts.push(placed(new BoxGeometry(0.52, 0.36, 2.3), at(0, 0, -0.2)));
  parts.push(placed(new BoxGeometry(0.28, 0.22, 1.0), at(0, -0.02, 1.3)));
  // The head: a small faceted wedge out in front.
  parts.push(placed(new CylinderGeometry(0.0, 0.34, 0.9, 4), alongZ(0, -0.02, 2.1)));

  for (const side of [-1, 1]) {
    // Swept forward and drooped — the dive.
    const wing = at(side * 1.25, -0.32, 0.05)
      .multiply(new Matrix4().makeRotationY(side * -0.44))
      .multiply(new Matrix4().makeRotationZ(side * 0.38));
    parts.push(placed(new BoxGeometry(2.4, 0.1, 1.05), wing));
    // Wingtip pods, canted with the wing.
    parts.push(
      placed(
        new CylinderGeometry(0.15, 0.1, 1.3, 5),
        at(side * 2.25, -0.72, 0.5).multiply(new Matrix4().makeRotationX(Math.PI / 2)),
      ),
    );
  }
  parts.push(placed(new BoxGeometry(0.3, 0.5, 0.7), at(0, 0.3, -1.1)));

  return mergeGeometries(parts, false)!;
}

/**
 * Lance — the horseshoe. Two long hulls joined only at the stern, leaving the
 * bow open around a central spine. Big, slow to turn, and unmistakable in
 * outline even at extreme range, which suits something that shoots from there.
 */
export function buildLance(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  for (const side of [-1, 1]) {
    parts.push(placed(new CylinderGeometry(0.26, 0.34, 4.4, 6), alongZ(side * 1.2, 0, 0.3)));
    // A slight inward cant at the bow, so the mouth tapers.
    parts.push(
      placed(
        new BoxGeometry(0.34, 0.3, 1.2),
        at(side * 1.05, 0, 2.2).multiply(new Matrix4().makeRotationY(side * 0.16)),
      ),
    );
  }

  // Stern yoke joining the two hulls, and the spine down the middle.
  parts.push(placed(new BoxGeometry(2.9, 0.42, 0.9), at(0, 0, -1.95)));
  parts.push(placed(new BoxGeometry(0.34, 0.34, 2.6), at(0, 0, -0.8)));
  parts.push(placed(new CylinderGeometry(0.0, 0.3, 1.1, 5), alongZ(0, 0, 0.9)));
  parts.push(placed(new CylinderGeometry(0.5, 0.5, 0.4, 8), at(0, 0.36, -1.95)));

  return mergeGeometries(parts, false)!;
}

/**
 * Bastion — the battlecruiser. A faceted command bulb thrust forward on a long
 * neck, a heavy body behind it, wings swept back to engine pods. Wide, blunt,
 * and obviously the thing you should not let get close.
 */
export function buildBastion(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Command bulb: low-poly on purpose, so its facets catch the light as edges.
  parts.push(placed(new CylinderGeometry(0.5, 0.86, 0.7, 7), at(0, 0.05, 2.5)));
  parts.push(placed(new CylinderGeometry(0.86, 0.4, 0.6, 7), at(0, -0.5, 2.5)));
  parts.push(placed(new BoxGeometry(0.38, 0.34, 2.1), at(0, 0.05, 1.15)));

  parts.push(placed(new BoxGeometry(1.6, 0.72, 2.4), at(0, 0, -1.0)));
  parts.push(placed(new CylinderGeometry(0.34, 0.5, 0.7, 6), alongZ(0, 0, -2.4)));

  for (const side of [-1, 1]) {
    parts.push(
      placed(
        new BoxGeometry(1.9, 0.16, 1.0),
        at(side * 1.5, -0.06, -1.35).multiply(new Matrix4().makeRotationY(side * 0.5)),
      ),
    );
    parts.push(placed(new CylinderGeometry(0.24, 0.24, 2.0, 6), alongZ(side * 2.25, -0.12, -1.15)));
  }

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
