/**
 * A room, computed rather than sampled.
 *
 * `Synth.setSpace` wants an impulse response to feed a `ConvolverNode`, and
 * the house rule is synthesised audio, no samples — a recorded IR would be
 * the one asset in a project that is otherwise entirely procedural geometry,
 * stroke fonts and oscillators. So the IR is built the same way everything
 * else here is: pure arithmetic, in this module, with no WebAudio types in
 * sight, which is what keeps it testable in bare node the way `formant.ts`'s
 * `composePhrase` already is.
 *
 * A `RoomDesign` is two layers. The **tail** is a burst of white noise run
 * through a one-pole lowpass (the room's own high-frequency absorption) and
 * shaped by an exponential decay — the diffuse wash of thousands of blurred
 * late reflections a real space produces, which is well modelled as filtered
 * noise and does not need to be anything more literal than that. The
 * **early reflections** sit on top of it: a handful of discrete impulses at
 * `at` seconds and `gain`, the first few distinct bounces off nearby
 * geometry before the diffuse tail takes over — a rock field's reflections
 * arrive close together and hot, a hangar's arrive later and softer, and the
 * difference between "small room" and "large room" is mostly these few
 * numbers.
 *
 * `noiseOnly` is the comet's own tail: mist, not a room, so it drops the
 * decay envelope (flat rather than dying away) and the early reflections
 * (nothing in an ionised cloud is a discrete bounce) and is just the
 * lowpassed noise on its own.
 */
export interface RoomDesign {
  /** Length of the rendered tail, in seconds — also the IR's own length. */
  readonly tailSeconds: number;
  /** One-pole lowpass cutoff applied to the tail's noise, in Hz. */
  readonly tailCutoffHz: number;
  /** Discrete impulses on top of the tail: seconds in, and peak gain. */
  readonly earlyReflections: readonly { at: number; gain: number }[];
  /** How loudly the convolver's output should sit against the dry signal — read by `Synth.setSpace`, not used here. */
  readonly wet: number;
  /** The comet's tail: flat filtered noise, no decay, no discrete reflections. */
  readonly noiseOnly?: boolean;
}

/**
 * Renders `design` into a mono impulse response at `sampleRate`, sampled from
 * `rng` (injected rather than reaching for `Math.random` directly — `Synth`
 * defaults to `Math.random` when nothing is supplied, but a seeded generator
 * makes the render reproducible, and a later task hangs one per sector off
 * the campaign seed the same way `composePhrase` already does).
 *
 * Normalised to unit **energy** — `Σh² = 1`, the impulse's own L2 norm — not
 * to a peak sample. A `ConvolverNode`'s own gain on a broadband signal tracks
 * the impulse response's *energy* (`√Σh²`), not its peak: two IRs sharing one
 * peak but differing in length or decay shape reach very different loudness
 * once actually convolved, because a longer, denser tail sums far more
 * energy into the output while never exceeding the same single sample a
 * peak-normalised render was tuned against. Measured on this bank's own
 * rooms under the old peak-normalise: the rocks room ran +23 dB over what its
 * own `wet: 0.3` implied, the giant's +29 dB, the comet's +34 dB — `wet` was
 * nowhere near the wet/dry ratio its name claimed. Normalising energy to 1
 * instead makes `wet` that ratio for real, independent of a design's own
 * `tailSeconds`/`tailCutoffHz`/`earlyReflections`: a room whose `wet` is 0.3
 * now actually sits 0.3× (≈ −10.5 dB) under the dry signal at the convolver,
 * whatever its tail looks like. `Synth.setSpace` still sets
 * `convolver.normalize = false` — the node's own auto-normalise is a
 * *different*, length-tied rescale than either of these, and would undo
 * whichever one this file does on purpose.
 */
/**
 * Mirrors `render/scenery.ts`'s own `HeroKind` — a structural copy, not an
 * `import type`, for the reason every other mirrored type in `sound.ts`
 * gives (see that file's own `HostileKind`/`ShieldFacing`): `scenery.ts`
 * pulls in `three` transitively (through the rest of `render/`), and this
 * module is tsc-emitted standalone by the audiotest. If the source union
 * ever grows a kind, this drifts until someone notices — `docs/todo.md`'s
 * to watch, the same trade `sound.ts`'s own mirrors accept.
 */
export type HeroKind = "giant" | "ringed" | "moon" | "sun" | "rocks" | "bare";

/**
 * One room per hero, before a shoal or the comet gets to modify it — the
 * spec's own table (`docs/superpowers/specs/2026-08-16-sound-design-design.md`
 * §1.2), turned into numbers. `rocks` is the only one with discrete early
 * reflections: a torpedo detonation *comes back off the field*, which needs
 * distinct bounces the way a slap-echo does; every other room is a mass
 * without nearby hard surfaces to bounce off cleanly, so its tail is the
 * whole story.
 */
const ROOMS: Record<HeroKind, RoomDesign> = {
  rocks: {
    tailSeconds: 0.5,
    tailCutoffHz: 4000,
    earlyReflections: [
      { at: 0.04, gain: 0.5 },
      { at: 0.095, gain: 0.35 },
      { at: 0.14, gain: 0.25 },
      { at: 0.18, gain: 0.15 },
    ],
    wet: 0.3,
  },
  giant: { tailSeconds: 2, tailCutoffHz: 600, earlyReflections: [], wet: 0.25 },
  ringed: { tailSeconds: 0.35, tailCutoffHz: 3000, earlyReflections: [], wet: 0.18 },
  moon: { tailSeconds: 0.35, tailCutoffHz: 3000, earlyReflections: [], wet: 0.18 },
  sun: { tailSeconds: 0.12, tailCutoffHz: 6000, earlyReflections: [], wet: 0.08 },
  // Bone dry — silence is a reading, not an omission. The cutoff is never
  // heard (`wet: 0` means the send never opens) but still has to be a real
  // number for `renderImpulse` to run against.
  bare: { tailSeconds: 0.05, tailCutoffHz: 5000, earlyReflections: [], wet: 0 },
};

/** The shoal's own modifiers — muffled: lengthened, darkened, wetter. */
const SHOAL_TAIL_MULTIPLIER = 1.6;
/** A ceiling on the cutoff, not a flat override — a shoal never brightens a
 *  room that was already darker than this (the giant's 600 Hz stays 600 Hz),
 *  it only ever muffles a brighter one down toward it. */
const SHOAL_CUTOFF_CEILING_HZ = 1200;
const SHOAL_WET_BONUS = 0.1;

/**
 * The comet's own tail, not a room at all: `noiseOnly` drops the decay
 * envelope and the early reflections (`renderImpulse`'s own doc explains
 * why), so what is left is a flat wash of band-limited hiss the send opens
 * almost all the way into — instruments do not work in there, and neither
 * does the ear.
 */
const COMET_ROOM: RoomDesign = {
  tailSeconds: 1,
  tailCutoffHz: 1000,
  earlyReflections: [],
  wet: 0.6,
  noiseOnly: true,
};

/**
 * The room a sector's mix should sit in, derived from exactly the facts the
 * renderer already drew — `planHero`'s own cast, whether `Shoals.plan` is
 * non-null, and whether the player's own comet interference has crossed
 * `stripAt`. Pure, and deliberately so: `sound.enterSector`/`insideComet`
 * own the WebAudio side (a seeded render, a convolver, a threat duck), this
 * only picks the numbers, which is what keeps it testable in bare node the
 * way `renderImpulse` already is.
 *
 * `insideComet` overrides everything else outright rather than blending with
 * it — the tail's own suppression is total (`game/comet.ts`'s "no instrument
 * works" is real as a place), so a rocks field's slap-echo has no business
 * surviving inside it. `shoal` only ever modifies whatever `hero` already
 * produced; there is no `shoal`-only room, because a shoal is a curtain in
 * front of whatever body was already cast, not a body of its own.
 */
export function roomFor(hero: HeroKind, shoal: boolean, insideComet: boolean): RoomDesign {
  if (insideComet) return COMET_ROOM;
  const base = ROOMS[hero];
  if (!shoal) return base;
  return {
    ...base,
    tailSeconds: base.tailSeconds * SHOAL_TAIL_MULTIPLIER,
    tailCutoffHz: Math.min(base.tailCutoffHz, SHOAL_CUTOFF_CEILING_HZ),
    wet: base.wet + SHOAL_WET_BONUS,
  };
}

/**
 * Structural equality on two rooms (or the dry `null`), reflections
 * included — `Synth.setSpace`'s own guard against a redundant rebuild.
 *
 * `insideComet`'s hysteresis (`sound.ts`) stops the *latch* from chattering
 * at the tail's edge, but a caller can still legitimately ask for the same
 * room twice — `enterSector`'s own key cache already short-circuits most of
 * those, but `Synth` re-rendering an `AudioBuffer` and swapping the
 * convolver mid-decay (an audible click, on top of the wasted allocation)
 * should not depend on every future caller remembering to key-cache first.
 * This is the second, cheaper line: compare what was actually asked for
 * rather than trust how it got asked.
 */
export function sameDesign(a: RoomDesign | null, b: RoomDesign | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.tailSeconds !== b.tailSeconds) return false;
  if (a.tailCutoffHz !== b.tailCutoffHz) return false;
  if (a.wet !== b.wet) return false;
  if (!!a.noiseOnly !== !!b.noiseOnly) return false;
  if (a.earlyReflections.length !== b.earlyReflections.length) return false;
  for (let i = 0; i < a.earlyReflections.length; i++) {
    if (a.earlyReflections[i].at !== b.earlyReflections[i].at) return false;
    if (a.earlyReflections[i].gain !== b.earlyReflections[i].gain) return false;
  }
  return true;
}

export function renderImpulse(design: RoomDesign, sampleRate: number, rng: () => number): Float32Array {
  const length = Math.max(1, Math.round(design.tailSeconds * sampleRate));
  const ir = new Float32Array(length);

  // A single real pole: `y[n] = y[n-1] + a * (x[n] - y[n-1])`, the standard
  // exponential-smoothing form of an RC lowpass, with `a` set from the
  // requested cutoff at this sample rate. Cheap, and it is all a noise tail
  // with no tonal content to preserve needs.
  const rc = 1 / (2 * Math.PI * Math.max(design.tailCutoffHz, 1));
  const dt = 1 / sampleRate;
  const a = dt / (rc + dt);

  // The decay reaches -60 dB (a factor of 1000) by the end of the tail — an
  // ear's usual sense of "the reverb is over." `noiseOnly` skips it: the
  // comet's tail is a steady mist, not something dying away.
  const decayRate = Math.log(1000) / Math.max(design.tailSeconds, 0.001);

  let filtered = 0;
  for (let n = 0; n < length; n++) {
    const white = rng() * 2 - 1;
    filtered += a * (white - filtered);
    const envelope = design.noiseOnly ? 1 : Math.exp(-decayRate * (n / sampleRate));
    ir[n] = filtered * envelope;
  }

  if (!design.noiseOnly) {
    for (const reflection of design.earlyReflections) {
      const at = Math.round(reflection.at * sampleRate);
      if (at >= 0 && at < length) ir[at] += reflection.gain;
    }
  }

  let energy = 0;
  for (let n = 0; n < length; n++) energy += ir[n] * ir[n];
  const rms = Math.sqrt(energy);
  if (rms > 0) {
    const scale = 1 / rms;
    for (let n = 0; n < length; n++) ir[n] *= scale;
  }

  return ir;
}
