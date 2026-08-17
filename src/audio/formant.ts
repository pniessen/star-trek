/**
 * Pure phrase grammar for the formant voice — the radio's speech generator.
 *
 * No WebAudio here, on purpose: `Synth.speak` is what turns what this module
 * composes into sound, so this module can be tested (and imagined about) in
 * bare node, the way `src/chart/`'s campaign logic is. Every time in a
 * `Phrase` is relative to 0 — `Synth.speak` is what places it on the audio
 * clock, via `spec.delay`.
 *
 * The vowel table below is Peterson & Barney's 1952 average adult formant
 * measurements for five vowel anchors — "Control Methods Used in a Study of
 * the Vowels," *Journal of the Acoustical Society of America* 24(2),
 * 175–184. Five points is enough for a phrase to sound like it is moving
 * through vowel space without a phoneme model behind it; nobody is meant to
 * make out words, only cadence and intent.
 */

export interface Syllable {
  /** Seconds from the start of the phrase (0-based; `speak` adds its own delay). */
  readonly at: number;
  readonly length: number;
  /** Carrier pitch for this syllable, Hz. */
  readonly pitch: number;
  readonly f1: number;
  readonly f2: number;
  readonly f3: number;
  /** Peak level within the phrase, 0…1 — syllables are not all equally loud. */
  readonly level: number;
}

export interface Phrase {
  readonly syllables: readonly Syllable[];
  /** Seconds from the first syllable's start to the last syllable's end. */
  readonly duration: number;
}

export interface Cadence {
  readonly syllablesMin: number;
  readonly syllablesMax: number;
  readonly lengthMin: number;
  readonly lengthMax: number;
  readonly gapMin: number;
  readonly gapMax: number;
  readonly pitchBase: number;
  readonly pitchRange: number;
  /** "broken" inserts one doubled gap and resets the pitch walk — a phrase falling apart. */
  readonly contour: "level" | "rising" | "falling" | "broken";
}

/** Peterson & Barney (1952) average F1/F2/F3, Hz — five vowel anchors: A, E, I, O, U. */
const VOWELS: readonly (readonly [number, number, number])[] = [
  [730, 1090, 2440], // A
  [530, 1840, 2480], // E
  [390, 1990, 2550], // I
  [570, 840, 2410], // O
  [440, 1020, 2240], // U
];

function span(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/**
 * Draws a phrase from a `Cadence`: syllable count, per-syllable length and
 * gap, a vowel per syllable, and a pitch walk shaped by `contour`. Pure and
 * deterministic in `rng` — the same generator state always composes the
 * same phrase, which is what makes it testable without an audio device.
 */
export function composePhrase(cadence: Cadence, rng: () => number): Phrase {
  const spread = Math.max(0, cadence.syllablesMax - cadence.syllablesMin);
  const count = cadence.syllablesMin + Math.min(spread, Math.floor(rng() * (spread + 1)));

  const half = cadence.pitchRange / 2;
  // The one gap that gets doubled, and the syllable index the pitch walk
  // resets at, for "broken" only.
  const breakAt = cadence.contour === "broken" && count > 1 ? 1 + Math.floor(rng() * (count - 1)) : -1;

  const syllables: Syllable[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const length = span(rng, cadence.lengthMin, cadence.lengthMax);
    if (i > 0) {
      let gap = span(rng, cadence.gapMin, cadence.gapMax);
      if (i === breakAt) gap *= 2;
      at += gap;
    }

    const t = count <= 1 ? 0 : i / (count - 1);
    let pitch: number;
    switch (cadence.contour) {
      case "rising":
        pitch = cadence.pitchBase - half + t * cadence.pitchRange;
        break;
      case "falling":
        pitch = cadence.pitchBase + half - t * cadence.pitchRange;
        break;
      case "broken": {
        // Two segments, each its own 0…1 walk: up (or down) to the break,
        // then reset and walk again to the end.
        const before = i < breakAt;
        const segLast = before ? breakAt - 1 : count - 1 - breakAt;
        const segI = before ? i : i - breakAt;
        const segT = segLast <= 0 ? 0 : segI / segLast;
        pitch = cadence.pitchBase - half + segT * cadence.pitchRange;
        break;
      }
      case "level":
      default:
        pitch = cadence.pitchBase + (rng() - 0.5) * cadence.pitchRange * 0.2;
    }

    const vowel = VOWELS[Math.floor(rng() * VOWELS.length) % VOWELS.length];
    const level = 0.75 + rng() * 0.25;
    syllables.push({ at, length, pitch, f1: vowel[0], f2: vowel[1], f3: vowel[2], level });
    at += length;
  }

  const last = syllables[syllables.length - 1];
  const duration = last ? last.at + last.length : 0;
  return { syllables, duration };
}
