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

/**
 * A tapered flat panel, built as a four-sided frustum laid along X and pressed
 * flat in Y. Its tip points toward `side`.
 *
 * Every wing in this file until now was a `BoxGeometry` turned about Y, which
 * is a *parallelogram*: tip chord equals root chord, so the trailing edge can
 * only ever run parallel to the leading edge. That is fine for a stubby pylon
 * and wrong for a delta, where the whole planform is the taper — the leading
 * edge rakes aft while the trailing edge creeps forward, and the two closing on
 * each other is what makes a wing read as swept rather than as a plank at an
 * angle. A frustum gives that for the same one primitive.
 *
 * Four sides also means the section is a diamond, so the panel carries a
 * spanwise crease along its own mid-chord top and bottom. A flat box gives the
 * edge detector nothing but an outline; this gives it a ridge, which is what a
 * vector renderer wants from a large flat surface.
 */
function taperedPanel(
  rootChord: number,
  tipChord: number,
  span: number,
  thickness: number,
  side: number,
): BufferGeometry {
  const geometry = new CylinderGeometry(tipChord / 2, rootChord / 2, span, 4, 1);
  return geometry.applyMatrix4(
    new Matrix4()
      .makeScale(1, thickness / rootChord, 1)
      .multiply(new Matrix4().makeRotationZ((side * -Math.PI) / 2)),
  );
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
 * NX Pathfinder — the oldest hull, and the one that barely has a neck.
 *
 * Its proportions are the read: a *small* saucer sitting almost directly on a
 * stub of a secondary hull, with the nacelles carried high and wide on short
 * struts rather than slung below and behind. Against the Constitution's long
 * thin neck and deep engineering hull, the difference survives at two units on
 * screen, which is the only test that matters here.
 */
function buildPathfinder(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Saucer: smaller and flatter than the Constitution's, and set further back —
  // there is no neck to hold it out in front.
  parts.push(placed(new CylinderGeometry(1.02, 0.9, 0.22, 12, 1), at(0, 0.04, 0.72)));
  parts.push(placed(new CylinderGeometry(0.3, 0.62, 0.2, 12, 1), at(0, 0.24, 0.72)));

  // Secondary hull: a stub directly under the saucer, not a hull on a stalk.
  parts.push(placed(new CylinderGeometry(0.34, 0.28, 1.25, 8, 1), alongZ(0, -0.3, -0.2)));
  parts.push(placed(new BoxGeometry(0.3, 0.4, 0.5), at(0, -0.16, 0.42)));

  for (const side of [-1, 1]) {
    // Nacelles high and wide — the feature that separates this from everything
    // later, where they migrate down and back.
    parts.push(placed(new CylinderGeometry(0.17, 0.17, 1.7, 8, 1), alongZ(side * 1.24, 0.5, -0.05)));
    parts.push(placed(new CylinderGeometry(0.11, 0.17, 0.24, 8, 1), alongZ(side * 1.24, 0.5, 0.97)));
    // Short strut, near level: they are held out, not swept.
    parts.push(
      placed(
        new BoxGeometry(0.62, 0.11, 0.34),
        at(side * 0.78, 0.36, 0.1).multiply(new Matrix4().makeRotationZ(side * -0.16)),
      ),
    );
  }

  return mergeGeometries(parts, false)!;
}

/**
 * Galaxy Explorer — the big one, and the saucer is the whole silhouette.
 *
 * Everything is subordinate to the primary hull: it is wide, it is *oval* rather
 * than round, and the secondary hull and nacelles tuck in close behind it
 * instead of trailing. That is also why this era pays for its reserve and
 * shields with `hullRadius` in `chart/eras.ts` — the ship is visibly the biggest
 * thing the player flies, and the physics agrees with the picture.
 */
function buildExplorer(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Oval, not round: scaled 1.18 across and 0.9 fore-aft, which is what stops it
  // reading as a Constitution saucer that someone enlarged.
  const oval = new Matrix4().makeScale(1.18, 1, 0.9);
  parts.push(placed(new CylinderGeometry(1.72, 1.5, 0.3, 16, 1), at(0, 0, 0.78).multiply(oval)));
  parts.push(placed(new CylinderGeometry(0.62, 1.02, 0.3, 16, 1), at(0, 0.3, 0.86).multiply(oval)));

  // Neck: short, thick and swept, connecting two large masses rather than
  // holding a small one out front.
  parts.push(
    placed(
      new BoxGeometry(0.42, 0.78, 0.6),
      at(0, -0.34, -0.1).multiply(new Matrix4().makeRotationX(-0.3)),
    ),
  );

  // Secondary hull, broad and short.
  parts.push(placed(new CylinderGeometry(0.5, 0.42, 1.5, 12, 1), alongZ(0, -0.66, -0.95)));

  for (const side of [-1, 1]) {
    // Nacelles tucked in close and set low, swept back with the pylon.
    parts.push(placed(new CylinderGeometry(0.21, 0.19, 1.9, 8, 1), alongZ(side * 1.0, -0.2, -1.1)));
    parts.push(placed(new CylinderGeometry(0.13, 0.21, 0.26, 8, 1), alongZ(side * 1.0, -0.2, -0.08)));
    parts.push(
      placed(
        new BoxGeometry(0.11, 0.9, 0.5),
        at(side * 0.7, -0.44, -1.0).multiply(new Matrix4().makeRotationZ(side * -0.5)),
      ),
    );
  }

  return mergeGeometries(parts, false)!;
}

/**
 * Defiant Escort — no saucer at all, which makes it the most distinct outline
 * available.
 *
 * Every other hull the player can fly is a disc plus a body plus two separated
 * nacelles. This one is a single flattened wedge with the drives buried in its
 * flanks, so it reads instantly and from any angle — and it is small, which the
 * hit sphere honours.
 */
function buildEscort(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // One body: a wedge, wide at the stern and pointed at the bow. Six sides so
  // the crease lines run along it rather than around it.
  parts.push(placed(new CylinderGeometry(0.94, 0.34, 2.4, 6, 1), alongZ(0, 0, 0.1)));
  // A flattening pass on the whole thing is what makes it a wedge rather than a
  // cone: 1.25 across, 0.5 tall.
  parts.push(
    placed(
      new BoxGeometry(1.5, 0.34, 1.5),
      at(0, -0.02, -0.15).multiply(new Matrix4().makeRotationY(0.78)),
    ),
  );
  // Bridge: a low hump, the only thing above the deck line.
  parts.push(placed(new CylinderGeometry(0.34, 0.44, 0.2, 8, 1), at(0, 0.24, 0.15)));
  // Torpedo mouth at the bow.
  parts.push(placed(new BoxGeometry(0.44, 0.16, 0.3), at(0, 0.0, 1.28)));

  for (const side of [-1, 1]) {
    // Drives *in* the flanks — no pylons anywhere, which is the silhouette.
    parts.push(placed(new CylinderGeometry(0.24, 0.2, 1.7, 7, 1), alongZ(side * 0.74, -0.04, -0.2)));
    parts.push(placed(new CylinderGeometry(0.14, 0.24, 0.22, 7, 1), alongZ(side * 0.74, -0.04, 0.74)));
    // A stubby wing to widen the stern.
    parts.push(
      placed(
        new BoxGeometry(0.7, 0.14, 0.8),
        at(side * 0.92, -0.06, -0.5).multiply(new Matrix4().makeRotationZ(side * -0.1)),
      ),
    );
  }

  return mergeGeometries(parts, false)!;
}

/**
 * The player's hull for an era. Keyed by the same ids as `chart/eras.ts`, which
 * owns what each one does — this file only decides what they look like.
 */
export function buildPlayerHull(era: string): BufferGeometry {
  switch (era) {
    case "nx":
      return buildPathfinder();
    case "galaxy":
      return buildExplorer();
    case "defiant":
      return buildEscort();
    default:
      return buildCruiser();
  }
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
 * Bastion — the battlecruiser: a command pod thrust a long way out in front on
 * a thin boom, a notched delta wing box aft, and the drives level on the
 * wingtips.
 *
 * This is the D7/K't'inga lineage, and it is now built to that lineage's real
 * proportions rather than to the genre gesture. The earlier hull had the right
 * three masses in the right order and every ratio wrong: the boom was 2.1 long
 * and 0.38 thick, which put the pod *on* the body instead of out ahead of it;
 * the wings were straight-swept parallelograms; and the drives hung off the
 * body on stubs rather than sitting on the wingtips. The published figures for
 * the type are 228 m long by 152 m across by 47 m tall — beam 0.67 of length,
 * height 0.21 of it — and this hull is 6.31 by 4.53 by 1.20, or 0.72 and 0.19.
 * It is therefore *narrower and longer* than what it replaces, which is the
 * opposite of the direction a "make it more impressive" instinct pulls.
 *
 * What that closed off: the roster's founding rule was one outline per class,
 * so that a contact could be named from its silhouette alone. That rule has
 * been rescinded deliberately — fidelity to the type now outranks silhouette
 * separation where the two disagree, and here they do. The Raider still reads
 * as a different animal (its head is on a *short* neck between forward-swept
 * drooping wings) but the margin is thinner than it was, and the honest reason
 * that is acceptable is that it was traded away on purpose rather than missed.
 *
 * On cost, and the tiers below: this is 487 strokes against the Bastion's old
 * 144 and the player's own 256, and the argument against it is not the GPU —
 * a few thousand instanced quads is nothing — it is the bloom. Every crease in
 * here glows, and past about 40 units the pod rim, the spine ribs and the
 * nacelle caps stop being detail and start being one bright smear. Four blocks
 * below are marked T1 to T3 and are meant to be deleted in that order if the
 * ship reads as a lamp at range: T1 the spine ribs (-48), T2 the pod belt, the
 * wingtip fins and the nacelle aft caps (-93 more), T3 the chin, the ventral
 * hump and the wing root fillets, with the pod at 7 sides and the nacelles at
 * 6 (-78 more, landing at 268). The proportions survive all three cuts, which
 * is the point of putting the fidelity in the ratios rather than in the parts.
 */
export function buildBastion(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Command pod, at z = 2.86 with nothing but boom behind it for 2.3 units.
  // The gap is the entire read: from ahead this ship is a wide arrowhead with a
  // dot floating in front of it, and nothing else in the game does that.
  //
  // The pod is a lens, not a bulb — three stacked frusta at nine sides, a
  // shallow dome over a rim over a shallower underside. The rim is what stops
  // it reading as two cones glued together; it is also the cheapest thing to
  // lose, which is why it is T2.
  parts.push(placed(new CylinderGeometry(0.3, 0.52, 0.2, 9), at(0, 0.24, 2.86)));
  parts.push(placed(new CylinderGeometry(0.52, 0.56, 0.14, 9), at(0, 0.07, 2.86))); // T2: belt
  parts.push(placed(new CylinderGeometry(0.56, 0.34, 0.26, 9), at(0, -0.13, 2.86)));
  parts.push(placed(new CylinderGeometry(0.1, 0.17, 0.12, 6), at(0, 0.4, 2.86)));
  // The forward gun. A round pod is a blister; a round pod with a barrel out of
  // its face is a bow, and tells you which end of this thing you are looking at.
  parts.push(placed(new CylinderGeometry(0.1, 0.13, 0.55, 6), alongZ(0, -0.02, 3.28)));
  parts.push(placed(new BoxGeometry(0.26, 0.2, 0.36), at(0, -0.3, 3.0))); // T3: chin

  // Boom. Thin enough that it nearly disappears at range, which is the effect
  // wanted — the pod should look unsupported.
  parts.push(placed(new BoxGeometry(0.24, 0.26, 2.3), at(0, -0.02, 1.42)));
  parts.push(placed(new BoxGeometry(0.12, 0.24, 2.1), at(0, 0.22, 1.4)));
  // T1: the refit spine, segmented. Four ribs, and the first thing to go — it
  // is 48 strokes of detail that has resolved into a single line by 15 units.
  for (let i = 0; i < 4; i++) {
    parts.push(placed(new BoxGeometry(0.2, 0.1, 0.14), at(0, 0.34, 2.15 - i * 0.5)));
  }

  // Where the boom enters the wing box it widens into a wedge rather than
  // meeting it square. A four-sided cone is exactly that fairing for one part.
  parts.push(placed(new CylinderGeometry(0.0, 0.44, 0.95, 4), alongZ(0, -0.02, 0.72)));
  parts.push(placed(new BoxGeometry(0.52, 0.38, 0.8), at(0, -0.02, 0.3)));

  // Body, and the tail that runs a full unit aft of where the wings end. That
  // overhang is the notch: the trailing edge of this ship is a W, not a line.
  parts.push(placed(new BoxGeometry(0.88, 0.5, 2.1), at(0, -0.02, -0.85)));
  parts.push(placed(new BoxGeometry(0.62, 0.36, 0.62), at(0, -0.02, -2.14)));
  parts.push(placed(new BoxGeometry(0.52, 0.2, 0.7), at(0, 0.3, -1.6)));
  parts.push(placed(new CylinderGeometry(0.22, 0.3, 0.34, 6), alongZ(0, -0.02, -2.58)));
  parts.push(placed(new CylinderGeometry(0.36, 0.18, 0.46, 6), at(0, -0.48, -1.0))); // T3: hump

  for (const side of [-1, 1]) {
    // The delta. Root chord 2.3 tapering to 0.86 over a 1.55 half-span at 0.30
    // of sweep, which puts the leading edge 1.13 aft over the span while the
    // trailing edge creeps 0.21 *forward* — a genuine planform rather than a
    // swept plank. Tips land at x = 2.21, for a beam of 4.42.
    parts.push(
      placed(
        taperedPanel(2.3, 0.86, 1.55, 0.34, side),
        at(side * 1.34, -0.02, -0.55).multiply(new Matrix4().makeRotationY(side * 0.3)),
      ),
    );
    // T3: root fillet, blending the wing into the body.
    parts.push(
      placed(
        new BoxGeometry(0.9, 0.26, 0.5),
        at(side * 0.62, -0.02, 0.1).multiply(new Matrix4().makeRotationY(side * 0.55)),
      ),
    );

    // Drives on the wingtips, level, and thrown a long way forward — the
    // intakes sit 1.1 units ahead of the wingtip's own leading edge. Level is
    // load-bearing: the Raider's and the Shroud's wingtip pods are canted with
    // their wings, and this one deliberately is not.
    parts.push(placed(new CylinderGeometry(0.19, 0.19, 1.6, 7), alongZ(side * 2.08, 0.04, -0.3)));
    parts.push(placed(new CylinderGeometry(0.13, 0.19, 0.26, 7), alongZ(side * 2.08, 0.04, 0.63)));
    // T2: aft cap and the wingtip fin above the drive.
    parts.push(placed(new CylinderGeometry(0.19, 0.11, 0.2, 7), alongZ(side * 2.08, 0.04, -1.2)));
    parts.push(placed(new BoxGeometry(0.14, 0.38, 0.52), at(side * 2.08, 0.3, -0.55)));
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
