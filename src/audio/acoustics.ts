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
 * Peak-normalised to at most 0.9 so `wet` alone controls how loud the space
 * reads and no combination of cutoff and reflection gains can push the
 * convolver's own output past the headroom the rest of the mix assumes.
 */
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

  let peak = 0;
  for (let n = 0; n < length; n++) peak = Math.max(peak, Math.abs(ir[n]));
  if (peak > 0) {
    const scale = 0.9 / peak;
    for (let n = 0; n < length; n++) ir[n] *= scale;
  }

  return ir;
}
