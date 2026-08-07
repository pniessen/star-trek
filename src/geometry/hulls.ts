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
 * Warden — the ally, and the only hull in the game that is neither you nor
 * something trying to kill you.
 *
 * It is deliberately built out of *your* vocabulary rather than the hostiles':
 * a faceted disc up front, a spine, two level nacelles on short pylons. Same
 * yard, smaller ship. Every hostile silhouette is asymmetric about its length
 * or reaches forward at you — a stooping raptor, a mouth held open, a bulb
 * thrust out on a neck, a blade. This one is squat, level and symmetrical, with
 * nothing sticking out in front of the disc and a broad stern: the outline of
 * something that holds a position rather than something that comes at you.
 *
 * A friendly ship has to be readable as friendly in the half second before you
 * decide whether to shoot, so it is legible by outline alone and does not lean
 * on colour to say it.
 */
export function buildWarden(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Forward disc — the cruiser's saucer at two thirds the size, and the one
  // shape in the game that only ever appears on our own hulls.
  parts.push(placed(new CylinderGeometry(0.92, 0.78, 0.26, 10, 1), at(0, 0, 1.0)));
  parts.push(placed(new CylinderGeometry(0.34, 0.6, 0.22, 10, 1), at(0, 0.22, 1.0)));

  // Spine, running the length of it. No neck, no head: nothing reaches forward.
  parts.push(placed(new BoxGeometry(0.44, 0.4, 2.5), at(0, -0.06, -0.5)));
  parts.push(placed(new CylinderGeometry(0.26, 0.34, 0.5, 8, 1), alongZ(0, -0.06, -1.95)));

  for (const side of [-1, 1]) {
    // Nacelles held level and low, on short straight pylons. Level is the whole
    // point — every hostile's wings are canted, swept or drooped.
    parts.push(placed(new CylinderGeometry(0.17, 0.17, 1.9, 8, 1), alongZ(side * 1.0, -0.2, -0.35)));
    parts.push(placed(new CylinderGeometry(0.11, 0.17, 0.26, 8, 1), alongZ(side * 1.0, -0.2, 0.72)));
    parts.push(placed(new BoxGeometry(0.66, 0.11, 0.42), at(side * 0.66, -0.2, -0.5)));
  }

  // A low bridge block, and the sensor loop that says this thing is here to
  // watch a sector rather than to hunt across one.
  parts.push(placed(new BoxGeometry(0.5, 0.26, 0.7), at(0, 0.28, -0.3)));
  parts.push(
    placed(new TorusGeometry(0.34, 0.05, 3, 8), at(0, 0.62, -0.3).multiply(new Matrix4().makeRotationX(Math.PI / 2))),
  );

  return mergeGeometries(parts, false)!;
}

/**
 * The hostile roster is built from the genre's silhouette grammar rather than
 * from any particular studio's ships: a stooping raptor, a horseshoe with its
 * mouth open, a bulb on a neck between swept wings, a flat-decked working
 * tender, and a blade. Those outlines have meant "predator", "elegant capital
 * ship", "battlecruiser", "auxiliary" and "assassin" in screen science fiction
 * since the sixties, and they are recognisable at the size of a scanner blip,
 * which is the only size that matters here.
 *
 * All of them are our own geometry. The archetype is shared vocabulary; the
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
 * Harrow — the working tender. A flat open deck with ordnance rails slung
 * underneath and the canisters visibly sitting on them, square engine blocks
 * bolted outboard, and a sensor mast that is the only thing standing up. It is
 * meant to read as machinery rather than as a warship, because it is not one:
 * it never shoots at you, it only sows.
 */
export function buildHarrow(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Deck slab — all working surface, no grace.
  parts.push(placed(new BoxGeometry(2.4, 0.34, 3.6), at(0, 0.25, -0.2)));
  parts.push(
    placed(
      new BoxGeometry(1.8, 0.28, 1.3),
      at(0, 0.18, 1.9).multiply(new Matrix4().makeRotationX(0.22)),
    ),
  );

  for (const side of [-1, 1]) {
    // Rail under the deck, and the mines still riding on it.
    parts.push(placed(new BoxGeometry(0.2, 0.5, 3.2), at(side * 0.85, -0.2, -0.3)));
    for (let i = 0; i < 3; i++) {
      parts.push(
        placed(new CylinderGeometry(0.26, 0.26, 0.5, 6), at(side * 0.85, -0.62, 1.0 - i)),
      );
    }
    // Engine block, square and ugly, with the throat behind it.
    parts.push(placed(new BoxGeometry(0.62, 0.62, 1.5), at(side * 1.55, 0.1, -1.5)));
    parts.push(placed(new CylinderGeometry(0.3, 0.38, 0.4, 6), alongZ(side * 1.55, 0.1, -2.4)));
  }

  parts.push(placed(new CylinderGeometry(0.08, 0.08, 1.1, 5), at(0, 0.95, 0.4)));
  parts.push(placed(new BoxGeometry(1.1, 0.1, 0.14), at(0, 1.46, 0.4)));

  return mergeGeometries(parts, false)!;
}

/**
 * Shroud — the blade. A single dart with fins folded hard back and down and
 * nothing broad enough to catch an eye, plus a pair of emitter spines along the
 * fin roots where the veil is generated.
 *
 * It spends most of its life invisible, so this hull only ever gets seen for
 * about two seconds at a time. That argues for fewer strokes and a harder
 * outline, not more detail — you have to know what it is the instant it
 * materialises.
 */
export function buildShroud(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  parts.push(placed(new CylinderGeometry(0.0, 0.34, 2.6, 4), alongZ(0, 0, 1.9)));
  parts.push(placed(new BoxGeometry(0.44, 0.3, 2.6), at(0, 0, -0.4)));
  parts.push(placed(new CylinderGeometry(0.3, 0.16, 0.9, 4), alongZ(0, 0, -2.1)));

  for (const side of [-1, 1]) {
    parts.push(
      placed(
        new BoxGeometry(2.6, 0.07, 0.7),
        at(side * 1.25, -0.16, -0.9)
          .multiply(new Matrix4().makeRotationY(side * 0.62))
          .multiply(new Matrix4().makeRotationZ(side * -0.5)),
      ),
    );
    parts.push(placed(new CylinderGeometry(0.09, 0.09, 2.2, 4), alongZ(side * 0.4, 0.14, 0.1)));
  }

  return mergeGeometries(parts, false)!;
}

/**
 * Spinner — one end of the Loom, and the only hull in the game whose long axis
 * is vertical.
 *
 * Every other silhouette here is read in plan: a raptor, a horseshoe, a bulb on
 * a neck, a working deck, a blade — things with a front and a length, because
 * they are all going somewhere and most of them are going at you. This one is
 * built the other way up. A tall emitter spindle standing on end, a heavy
 * counterweighted collar around its waist, two stub booms with the guide eyes
 * the filament runs through, and nothing whatever pointing forward.
 *
 * That is the whole brief: a machine, seen end-on, that is obviously drawing
 * something downward. It shares the Harrow's violet, so the outline is what has
 * to keep the two apart — and it does, comfortably: the Harrow is a flat deck
 * lying in the plane and this is a spindle standing out of it. Nothing else in
 * the roster is legible as an upright.
 */
export function buildSpinner(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // The spindle. Standing, tapering, and the tallest thing on any hull here.
  parts.push(new CylinderGeometry(0.22, 0.34, 3.2, 6, 1));
  // The emitter head, and the aperture the filament leaves from, underneath.
  parts.push(placed(new CylinderGeometry(0.52, 0.22, 0.5, 6, 1), at(0, 1.7, 0)));
  parts.push(placed(new CylinderGeometry(0.36, 0.5, 0.4, 6, 1), at(0, -1.75, 0)));

  // The collar: a wide flat ring at the waist, which is what makes the thing
  // read as spun rather than as flown.
  parts.push(
    placed(new TorusGeometry(0.95, 0.11, 3, 10), new Matrix4().makeRotationX(Math.PI / 2)),
  );

  for (const side of [-1, 1]) {
    // Stub booms out to the guide eyes. Level, short, and set on the ring's own
    // axis rather than fore and aft, so there is no front to mistake for one.
    parts.push(placed(new BoxGeometry(1.5, 0.16, 0.22), at(side * 0.85, 0.1, 0)));
    parts.push(
      placed(
        new TorusGeometry(0.26, 0.06, 3, 8),
        at(side * 1.55, 0.1, 0).multiply(new Matrix4().makeRotationY(Math.PI / 2)),
      ),
    );
    // Counterweights, hung under the collar.
    parts.push(placed(new BoxGeometry(0.3, 0.44, 0.3), at(side * 0.85, -0.5, 0)));
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
