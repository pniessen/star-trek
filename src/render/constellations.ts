/**
 * Earth's constellations, hidden in the sky of an invented quadrant.
 *
 * The joke has to be quiet or it stops being one. So: **no joining lines.** A
 * connect-the-dots Orion is a planetarium exhibit and would announce itself from
 * the title screen; what is drawn here is only that a handful of the field's
 * stars are brighter than their neighbours, arranged the way they actually are.
 * Somebody who knows the sky will find the Plough and be delighted. Somebody who
 * does not will see a rich starfield, which is what they were getting anyway.
 *
 * Two things make that work, and both are the reason this is a table rather than
 * a random scatter:
 *
 *  - **The geometry is real.** Offsets below are angular separations in degrees,
 *    taken from the actual asterisms. It is the *proportions* that make a shape
 *    recognisable — the Plough's bowl-to-handle ratio, the evenness of Orion's
 *    belt — so approximating them is the one thing that would waste the whole
 *    idea.
 *  - **The magnitudes are real too**, and inverted into brightness. Half of why
 *    the Plough reads is that Megrez is visibly the faint one; flatten the
 *    magnitudes and it becomes seven anonymous dots in roughly the right places.
 *
 * They are placed and rotated per sector off the campaign seed, which is a
 * deliberate lie about astronomy in exchange for the thing this file is for: the
 * same asterism turns up at a different bearing and a different roll in a
 * different square, so finding one is a small event rather than a fixed feature
 * of the furniture. Nothing here is on the scanner, nothing is reachable, and
 * nothing carries a hue — the colour rule in `Backdrop.ts` applies unchanged.
 */

export interface Star {
  /** Degrees east in the asterism's own tangent plane. */
  readonly dx: number;
  /** Degrees north in the same plane. */
  readonly dy: number;
  /** Apparent magnitude, as catalogued. Lower is brighter. */
  readonly mag: number;
}

export interface Asterism {
  readonly name: string;
  readonly stars: readonly Star[];
}

/**
 * Five, chosen for the same reason the ship eras were: they survive being small.
 *
 * An asterism has to be identifiable from its shape alone at a handful of pixels
 * per star, which rules out most of the sky. These five are the ones people
 * actually recognise — a bowl with a bent handle, three stars in a row inside a
 * rectangle, a W, a compact cross, a large one.
 */
export const ASTERISMS: readonly Asterism[] = [
  {
    // Ursa Major's plough: four in the bowl, three in the handle, and Megrez
    // conspicuously the faintest of them.
    name: "PLOUGH",
    stars: [
      { dx: 0, dy: 0, mag: 1.8 },      // Dubhe
      { dx: -1.5, dy: -5.0, mag: 2.4 }, // Merak
      { dx: 4.0, dy: -7.5, mag: 2.4 },  // Phecda
      { dx: 5.5, dy: -3.5, mag: 3.3 },  // Megrez
      { dx: 11.0, dy: -2.5, mag: 1.8 }, // Alioth
      { dx: 17.5, dy: -4.5, mag: 2.2 }, // Mizar
      { dx: 23.5, dy: -8.0, mag: 1.9 }, // Alkaid
    ],
  },
  {
    // Orion. The belt is the tell, and it is the evenness of the three that does
    // it — which is why their spacing is the one thing not rounded here.
    name: "ORION",
    stars: [
      { dx: 0, dy: 0, mag: 0.5 },        // Betelgeuse
      { dx: -7.5, dy: 1.5, mag: 1.6 },   // Bellatrix
      { dx: -1.5, dy: -8.5, mag: 1.7 },  // Alnitak
      { dx: -3.0, dy: -9.0, mag: 1.7 },  // Alnilam
      { dx: -4.5, dy: -9.5, mag: 2.2 },  // Mintaka
      { dx: -1.0, dy: -17.0, mag: 2.1 }, // Saiph
      { dx: -8.5, dy: -16.0, mag: 0.2 }, // Rigel
    ],
  },
  {
    name: "CASSIOPEIA",
    stars: [
      { dx: 0, dy: 0, mag: 3.4 },        // Segin
      { dx: -4.5, dy: -3.0, mag: 2.7 },  // Ruchbah
      { dx: -9.0, dy: -1.0, mag: 2.5 },  // Gamma
      { dx: -13.5, dy: -3.5, mag: 2.2 }, // Schedar
      { dx: -17.0, dy: -1.0, mag: 2.3 }, // Caph
    ],
  },
  {
    // The Southern Cross: small, and the only one here a northern player will
    // not know, which is half of why it is included.
    name: "CRUX",
    stars: [
      { dx: 0, dy: 0, mag: 0.8 },       // Acrux
      { dx: 3.5, dy: 3.0, mag: 1.3 },   // Mimosa
      { dx: 1.0, dy: 6.0, mag: 1.6 },   // Gacrux
      { dx: -2.5, dy: 3.5, mag: 2.8 },  // Delta
    ],
  },
  {
    name: "CYGNUS",
    stars: [
      { dx: 0, dy: 0, mag: 1.3 },        // Deneb
      { dx: -4.0, dy: -6.0, mag: 2.2 },  // Sadr
      { dx: 3.0, dy: -9.5, mag: 2.5 },   // Gienah
      { dx: -11.0, dy: -5.0, mag: 2.9 }, // Delta
      { dx: -6.0, dy: -15.0, mag: 3.1 }, // Albireo
    ],
  },
];

/**
 * Magnitude to a stroke brightness, and the curve matters more than the ends.
 *
 * Real magnitudes are logarithmic and span a factor of forty over this range,
 * which drawn literally would leave everything but Rigel and Betelgeuse invisible.
 * This compresses the scale until the *ordering* survives and the faintest is
 * still clearly a star — which is all the shape needs, since what identifies an
 * asterism is which of its members is the dim one, not by how much.
 */
export function brightnessOf(mag: number): number {
  const t = Math.max(0, Math.min(1, (mag - 0.2) / 3.4));
  return 0.78 - 0.38 * t;
}
