/**
 * The sound machine: one voice vocabulary, reused for everything.
 *
 * The renderer draws every transient — beams, debris, corridor guides — out of
 * one stroke buffer, and every glyph out of one stroke font, because a look
 * comes from a small vocabulary used consistently rather than from a bespoke
 * object per effect. This is the same argument in the other medium. There are
 * three voices here: a pitched oscillator that can glide, filtered noise
 * whose filter can sweep, and a pair of oscillators — carrier and modulator —
 * where the second rings the first's pitch and its own depth decays, a struck
 * bell rather than a held tone. A phaser, a hard dock, a mine going off and
 * the Shroud materialising are all combinations of these three with different
 * envelopes, which is why they sound like they came off the same bench.
 *
 * Two rules the rest of the game depends on:
 *
 *  - **Nothing here may throw.** The headless harness runs in a Chromium with no
 *    audio device, and an exception raised inside the frame loop kills
 *    `requestAnimationFrame` and freezes the game on its last frame. Every entry
 *    point is guarded, and the first failure retires the whole machine
 *    permanently rather than raising the same error sixty times a second.
 *  - **Nothing starts before a gesture.** A browser will not let an
 *    `AudioContext` run until the user has touched the page, so the context is
 *    built on the keypress that launches a run, not at module load. Until then,
 *    and whenever the context is not running, cues are dropped on the floor —
 *    scheduling into a suspended context would pile up voices that never sound
 *    and never end.
 */

import type { Phrase } from "./formant.js";
import { renderImpulse, sameDesign, type RoomDesign } from "./acoustics.js";

export type { RoomDesign } from "./acoustics.js";

/**
 * Nine buses, so the mix is a handful of constants in one place rather than a
 * level on every cue. Weapons are their own bus because phasers fire every
 * 0.16s and are the one thing here that can genuinely become fatiguing.
 *
 * `hostile`, `mechanism` and `alert` split out of the original `weapon`/
 * `impact`/`panel` grab-bag so the static caps below (`BUS_CAPS`) mean
 * something: a wave of hostiles firing has its own budget that a mine field
 * or a hard dock cannot steal from, and vice versa. `radio` and `echo` are
 * built ahead of the consumers that use them (the three-party radio and
 * positional rock echo, both later tasks) so the whole bus/cap vocabulary
 * lands in one place rather than growing bus-by-bus.
 */
export type Bus =
  | "weapon"
  | "impact"
  | "hostile"
  | "mechanism"
  | "panel"
  | "bed"
  | "alert"
  | "radio"
  | "echo";

export interface VoiceSpec {
  /**
   * Pitched by default; `noise` swaps the oscillator for filtered noise;
   * `fm` adds a second oscillator that modulates the first's pitch — a
   * struck bell rather than a held tone, since the modulation index decays
   * on its own envelope (`indexDecay`) independent of the voice's own.
   */
  readonly kind?: "tone" | "noise" | "fm";
  readonly bus?: Bus;
  /** Tone/fm: starting pitch (fm: the carrier's). Noise: starting filter frequency. */
  readonly freq: number;
  /** Glide/sweep target, arrived at as the envelope ends. Fm: the carrier's. */
  readonly to?: number;
  readonly wave?: OscillatorType;
  readonly filter?: BiquadFilterType;
  readonly q?: number;
  /** Fm only: modulator/carrier frequency ratio. Default 1.4. */
  readonly ratio?: number;
  /** Fm only: peak modulation depth, in Hz-of-carrier units (modulator gain = index × freq). Default 3. */
  readonly index?: number;
  /** Fm only: seconds for the index to fall to ~zero. Default the voice's own `decay`. */
  readonly indexDecay?: number;
  /** Peak gain within the bus. */
  readonly level: number;
  readonly attack?: number;
  readonly hold?: number;
  readonly decay: number;
  /**
   * Seconds from now. Sequences — arpeggios, the crack at the end of a decloak —
   * are built out of this rather than out of timers, so they keep the audio
   * clock's time even when the frame loop is stuttering under software GL.
   */
  readonly delay?: number;
  /** -1 hard port, +1 hard starboard. */
  readonly pan?: number;
  /**
   * The layers of one sound share a budget slot. `BUS_CAPS` bounds *cues*, not
   * oscillators — a torpedo report is one budget unit even though it is four
   * `play` calls, an alert beat is one unit whether it is one partial or four.
   * Get a token from `Synth.group()` once per cue and pass it on every layer;
   * layers without a token (the common case, a single-voice cue) count
   * individually, exactly as before. Task 3's formant `speak()` — a whole
   * phrase, squelch included, as one voice — uses the same mechanism.
   */
  readonly group?: number;
}

/**
 * `Synth.speak`'s cue: a whole `Phrase` (see `formant.ts`), not a note. Built
 * for the radio — `speak` is what the three parties (Task 11: ours, the
 * Warden's, theirs) all talk through.
 */
export interface PhraseSpec {
  readonly phrase: Phrase;
  readonly bus: Bus;
  /** Peak level within the phrase — a syllable's own `level` scales this, same as `VoiceSpec.level`. */
  readonly level: number;
  /** Drive into the soft-clip stage; higher reads as a hotter, more distorted radio. */
  readonly drive: number;
  /** Telephone band [highpass, lowpass], Hz. 300–3400 is the classic telephone band. */
  readonly band: readonly [number, number];
  readonly pan?: number;
  readonly delay?: number;
}

export interface BedSpec {
  readonly kind: "tone" | "noise";
  readonly bus?: Bus;
  readonly wave?: OscillatorType;
  readonly filter?: BiquadFilterType;
  readonly q?: number;
  /** Second oscillator at this ratio; the two beat against each other. */
  readonly ratio?: number;
}

/**
 * Ceiling on simultaneous voices, per bus rather than global — the
 * four-channel-chip principle from `docs/audio-prior-art.md` §6. A wave-eight
 * fight with a chain of mines going off and three hostiles firing will ask
 * for more than any one of these, and the honest answer is to refuse the
 * surplus rather than to let a hundred oscillators accumulate — the eleventh
 * explosion in a second is not information anyone is listening for. Splitting
 * the old single `MAX_VOICES = 18` into per-bus budgets means a busy hostile
 * bus can no longer starve a hard dock of its own two voices: each channel
 * degrades on its own terms. First-draft numbers, `docs/todo.md`'s tuning
 * list.
 */
const BUS_CAPS: Record<Bus, number> = {
  weapon: 3,
  impact: 4,
  hostile: 4,
  mechanism: 2,
  panel: 2,
  bed: 2,
  alert: 1,
  radio: 3, // one per party — ours, warden, theirs
  echo: 3,
};

/**
 * Peak gain per bus. The entire mix balance is these nine numbers.
 *
 * Exported and mutable, because they are the block `docs/todo.md` §2 calls
 * first-draft guesses "in exactly the way the flight model is" and the mix
 * is the one thing here that cannot be judged except by hearing it. The
 * tuning console reaches them through `Synth.setBusLevel`, never by writing
 * this record directly — the levels are baked into a `GainNode` when the rig
 * is built, so a write here alone would change the number and not the sound.
 */
export const BUS_LEVELS: Record<Bus, number> = {
  weapon: 0.5,
  impact: 0.85,
  hostile: 0.7,
  mechanism: 0.7,
  panel: 0.7,
  bed: 0.6,
  alert: 0.7,
  radio: 0.75,
  echo: 0.55,
};

/**
 * The loudest sum the limiter handles exactly, in units of full scale.
 *
 * A `WaveShaperNode`'s curve is indexed by input over [-1, 1] and anything
 * outside that is clamped to the end of the table — which would be a hard clip,
 * the exact fault we are here to avoid. So the signal is scaled down by this
 * factor going in and the curve is built over the widened range, which makes
 * the transfer exactly `tanh(x)` for any pile-up up to ±4 and asymptotic
 * beyond it. Four is not a taste decision: eighteen voices at the levels in
 * `sound.ts` cannot reach it.
 */
const LIMIT_CEILING = 4;

/**
 * `tanh`, sampled. Identity to within 1% below -15 dBFS, so nothing quiet is
 * touched, and it can never return ±1, so the destination can never clip.
 */
function limiterCurve(): Float32Array<ArrayBuffer> {
  const points = 8193;
  const curve = new Float32Array(new ArrayBuffer(points * 4));
  for (let i = 0; i < points; i++) {
    curve[i] = Math.tanh(((i / (points - 1)) * 2 - 1) * LIMIT_CEILING);
  }
  return curve;
}

/** Cached lazily — `speak` may build many phrases and the curve never changes. */
let driveCurve: Float32Array<ArrayBuffer> | null = null;

/**
 * `speak`'s own soft-clip stage, distinct from `limiterCurve` above: the
 * limiter exists to protect the destination from pile-up and stays
 * transparent below -15 dBFS, but the radio's drive stage is meant to be
 * heard — a hotter, brighter clip that reads as a transmitted voice rather
 * than a clean one. `spec.drive` scales the signal into this fixed curve via
 * a trim gain ahead of it, the same shape as `LIMIT_CEILING`'s trim.
 */
function speechDriveCurve(): Float32Array<ArrayBuffer> {
  if (!driveCurve) {
    const points = 2049;
    const curve = new Float32Array(new ArrayBuffer(points * 4));
    for (let i = 0; i < points; i++) {
      curve[i] = Math.tanh(((i / (points - 1)) * 2 - 1) * 3);
    }
    driveCurve = curve;
  }
  return driveCurve;
}

/**
 * Each squelch burst's own length — see `Synth.speak`. Exported so
 * `radio.ts` can compute a phrase's real on-air span (two squelches plus the
 * composed phrase's own duration) without a second, drifting copy of this
 * number — the mirrored-constant trick the rest of the audio layer uses for
 * the standalone-build boundary does not apply here, since `radio.ts` is
 * already audio-side and imports this module directly.
 */
export const SQUELCH_LEN = 0.04;

interface Rig {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly buses: Record<Bus, GainNode>;
  readonly noise: AudioBuffer;
  /**
   * The space send, built lazily on the first `setSpace(design)` call rather
   * than in `build()` — most sectors never call it, and a convolver with an
   * empty buffer is a node the engine would otherwise carry all game for
   * nothing. `sends` are per-bus gains, one each, tapped off every bus gain
   * (post-level, so `wet` scales the same signal the dry path hears) and
   * summed into `convolver`; `convolver`'s own output goes to `master`,
   * post-buses and pre-limiter, never back into a bus — feeding a bus would
   * be feedback.
   */
  convolver: ConvolverNode | null;
  sends: Record<Bus, GainNode> | null;
}

/**
 * The two buses that are never in the room: `bed` is the reactor drone,
 * which is inside the ship, and `radio` is a transmitted carrier, which is a
 * signal arriving from elsewhere rather than a sound happening in the space
 * around the ship. Every other bus — weapons, impacts, hostiles, mechanisms,
 * the panel, the alert, the echo — is something the hull itself is doing or
 * hearing, so it belongs in the room and gets `design.wet`. Pinned rather
 * than merely defaulted low, so no future `RoomDesign` can accidentally put
 * the engine bed in a cave.
 */
const DRY_SENDS: ReadonlySet<Bus> = new Set(["bed", "radio"]);

interface Voice {
  /** Context time this voice is done at; used for reaping and for stealing. */
  readonly end: number;
  readonly gain: GainNode;
  readonly source: AudioScheduledSourceNode;
  /** Which bus's budget this voice counts against. */
  readonly bus: Bus;
  /** Shares one budget slot with every other voice carrying the same token. */
  readonly group?: number;
}

type ContextCtor = typeof AudioContext;

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export class Synth {
  private rig: Rig | null = null;
  /** One failure retires the machine. Silence is a valid outcome; noise in the console is not. */
  private failed = false;
  private silenced = false;
  private readonly voices: Voice[] = [];
  private readonly beds: Bed[] = [];
  /** Backs `group()`. */
  private groupSeq = 0;
  /** The last `RoomDesign` handed to `setSpace`, or `null` for a dry ship. */
  private spaceDesign: RoomDesign | null = null;
  /** The threat duck's own multiplier on every send, 0..1. See `spaceLevel`. */
  private spaceLevelValue = 1;
  /**
   * What `applySendLevels` last asked each send for. Tracked here rather
   * than read back off the `GainNode`, since `setTargetAtTime` schedules an
   * asymptotic ramp rather than writing `.value` — this is the target that
   * ramp is heading for, which is what `sendLevels()` (and `setSpace`
   * itself, on the next call) needs to reason about.
   */
  private readonly sendTargets: Record<Bus, number> = Object.fromEntries(
    (Object.keys(BUS_LEVELS) as Bus[]).map((name) => [name, 0]),
  ) as Record<Bus, number>;

  /** True once there is a running context to schedule into. */
  get live(): boolean {
    return this.rig !== null && this.rig.ctx.state === "running";
  }

  get muted(): boolean {
    return this.silenced;
  }

  set muted(value: boolean) {
    this.silenced = value;
    const rig = this.rig;
    if (!rig) return;
    try {
      // Ramped rather than switched: a gain that steps to zero clicks, and a
      // click is the one sound in the game nobody authored.
      rig.master.gain.setTargetAtTime(value ? 0 : 1, rig.ctx.currentTime, 0.02);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Move one bus's peak level, on the rig as well as in the table.
   *
   * The mix is nine numbers and none of them has ever been heard, so they are
   * on the tuning console's list — and a bus level is the one kind of knob that
   * needs a method rather than a plain field write. `BUS_LEVELS[bus]` is read
   * when the graph is built and when `duck` computes what to recover to; the
   * live gain is a node. Both have to move together or the next duck would
   * snap the bus back to the level the player just tuned away from.
   *
   * Ramped for the same reason `muted` is: a gain that steps clicks.
   */
  setBusLevel(bus: Bus, level: number): void {
    BUS_LEVELS[bus] = level;
    const rig = this.rig;
    if (!rig || this.failed) return;
    try {
      rig.buses[bus].gain.setTargetAtTime(level, rig.ctx.currentTime, 0.02);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Called from the keypress that launches a run — the gesture the autoplay
   * policy is waiting for. Safe to call on every key thereafter; it is a resume
   * once the rig exists.
   */
  start(): void {
    if (this.failed) return;
    try {
      if (!this.rig) this.rig = this.build();
      if (this.rig && this.rig.ctx.state !== "running") void this.rig.ctx.resume().catch(() => {});
    } catch (error) {
      this.fail(error);
    }
  }

  /** Suspends while the tab is hidden — a drone nobody can see is a drone nobody wants. */
  setPaused(paused: boolean): void {
    const rig = this.rig;
    if (!rig || this.failed) return;
    try {
      if (paused) void rig.ctx.suspend().catch(() => {});
      else void rig.ctx.resume().catch(() => {});
    } catch (error) {
      this.fail(error);
    }
  }

  play(spec: VoiceSpec): void {
    const rig = this.rig;
    // Muted skips the work as well as the sound. The master gain is still
    // ramped rather than switched, so whatever was already ringing when the key
    // was pressed fades instead of stopping dead.
    if (!rig || this.failed || this.silenced || rig.ctx.state !== "running") return;

    try {
      const ctx = rig.ctx;
      const now = ctx.currentTime;
      const at = now + (spec.delay ?? 0);
      const attack = spec.attack ?? 0.004;
      const hold = spec.hold ?? 0;
      const end = at + attack + hold + Math.max(spec.decay, 0.01);

      this.reap(now);
      const busName = spec.bus ?? "impact";
      // Cap and drop, never steal. The pool used to cut the voice nearest the
      // end of its life to make room; `audio-prior-art.md` §5 and §6.2 are both
      // explicit that this is backwards — a shot that never sounds in a dense
      // moment is imperceptible, and a voice cut while it is still saying
      // something is not. Dropping also degrades *predictably*, which is the
      // half of §6's static-allocation argument that needs no new numbers.
      // Per-bus rather than global, so a busy hostile bus cannot starve the
      // mechanism bus of the two voices a hard dock needs. Per-*cue* within
      // that, via `spec.group` — a compound cue's own layers were always
      // meant to cost one slot, not one each; see `count` and `VoiceSpec.group`.
      // A later layer of a group that has already paid for its slot is not
      // asking for a new one, so it skips the check entirely — otherwise a
      // cue's second layer would find its own first layer occupying the
      // bus's last slot and refuse itself, which is exactly backwards.
      const alreadyAdmitted =
        spec.group !== undefined && this.voices.some((v) => v.bus === busName && v.group === spec.group);
      if (!alreadyAdmitted && this.count(busName) >= BUS_CAPS[busName]) return;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(Math.max(spec.level, 0.0002), at + attack);
      if (hold > 0) gain.gain.setValueAtTime(Math.max(spec.level, 0.0002), at + attack + hold);
      // Exponential, because a linear fade to nothing reads as a note being cut
      // off and an exponential one reads as a note ending.
      gain.gain.exponentialRampToValueAtTime(0.0001, end);

      // Everything downstream of the source, so it can all be let go at once.
      const chain: AudioNode[] = [gain];

      let source: AudioScheduledSourceNode;
      if (spec.kind === "noise") {
        const player = ctx.createBufferSource();
        player.buffer = rig.noise;
        player.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = spec.filter ?? "bandpass";
        filter.Q.value = spec.q ?? 1;
        filter.frequency.setValueAtTime(clamp(spec.freq, 20, 18000), at);
        if (spec.to !== undefined) {
          filter.frequency.exponentialRampToValueAtTime(clamp(spec.to, 20, 18000), end);
        }
        player.connect(filter).connect(gain);
        chain.push(filter);
        // A different grain each time, and a different rate to read it at, so a
        // burst repeated at the phaser's cadence does not turn into one buzzing
        // pitch. Free variation at zero allocation, which is the one axis the
        // CHI 2024 result says actually buys enjoyment.
        player.playbackRate.value = 0.85 + Math.random() * 0.35;
        player.start(at, Math.random() * (rig.noise.duration - 0.5));
        source = player;
      } else if (spec.kind === "fm") {
        const carrier = ctx.createOscillator();
        carrier.type = spec.wave ?? "sine";
        carrier.frequency.setValueAtTime(clamp(spec.freq, 20, 18000), at);
        if (spec.to !== undefined) carrier.frequency.exponentialRampToValueAtTime(clamp(spec.to, 20, 18000), end);
        const modulator = ctx.createOscillator();
        modulator.type = "sine";
        const ratio = spec.ratio ?? 1.4;
        modulator.frequency.setValueAtTime(clamp(spec.freq * ratio, 1, 18000), at);
        const depth = ctx.createGain();
        const index = spec.index ?? 3;
        // Floored for the same reason the voice envelope's own gain is
        // floored at 0.0001 rather than 0: an exponential ramp cannot start
        // from a literal 0, and an `index: 0` caller would otherwise throw
        // inside `play`'s try/catch and retire the whole audio layer.
        depth.gain.setValueAtTime(Math.max(index * spec.freq, 0.0001), at);
        // The index is the timbre's own envelope: bright and inharmonic on the
        // attack, settling toward a plain tone — a struck bell, not a held one.
        depth.gain.exponentialRampToValueAtTime(0.01, at + Math.max(spec.indexDecay ?? spec.decay, 0.01));
        modulator.connect(depth).connect(carrier.frequency);
        carrier.connect(gain);
        modulator.start(at);
        carrier.start(at);
        modulator.stop(end + 0.02);
        chain.push(depth, modulator);
        source = carrier;
      } else {
        const osc = ctx.createOscillator();
        osc.type = spec.wave ?? "sine";
        osc.frequency.setValueAtTime(clamp(spec.freq, 20, 18000), at);
        if (spec.to !== undefined) {
          osc.frequency.exponentialRampToValueAtTime(clamp(spec.to, 20, 18000), end);
        }
        osc.connect(gain);
        osc.start(at);
        source = osc;
      }

      const busGain = rig.buses[busName];
      if (spec.pan !== undefined && typeof ctx.createStereoPanner === "function") {
        const panner = ctx.createStereoPanner();
        panner.pan.value = clamp(spec.pan, -1, 1);
        gain.connect(panner).connect(busGain);
        chain.push(panner);
      } else {
        gain.connect(busGain);
      }

      source.stop(end + 0.02);
      const voice: Voice = { end, gain, source, bus: busName, group: spec.group };
      source.onended = () => {
        // The whole chain, not just the gain. A filter or a panner left hanging
        // off a dead source is a node the engine has to keep considering, and
        // this fires from the audio thread where a throw has nowhere to go.
        try {
          source.disconnect();
          for (const node of chain) node.disconnect();
        } catch {
          // Already gone. Nothing to do, and nothing worth saying about it.
        }
        const index = this.voices.indexOf(voice);
        if (index >= 0) this.voices.splice(index, 1);
      };
      this.voices.push(voice);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * The formant voice: a phrase, not a note — the radio's voice, and the
   * only one of the three (Task 11: ours, the Warden's, theirs) that
   * `Synth` builds a whole node graph for rather than a single envelope.
   * One sawtooth carrier drives a soft-clip stage (`speechDriveCurve`,
   * `spec.drive`-scaled), into three parallel bandpass formants (Q ~8,
   * stepped per syllable via `setTargetAtTime`) summed into a gate that
   * opens and closes on the audio clock for each `Syllable`, through a
   * highpass/lowpass pair at `spec.band` (the telephone band), bracketed by
   * two 40 ms squelch bursts built into this same graph. The whole thing —
   * carrier, formants, both squelches — is **one voice** on `spec.bus`, so
   * it goes through the same cap check `play` does and needs no `group`.
   * Mirrors `play`'s never-throw contract exactly: guarded the same way,
   * failed the same way.
   *
   * Returns whether a voice was actually scheduled — `false` on every guard
   * above (no rig, failed, silenced, context not running), on the bus cap
   * refusing the cue, and on an internal failure that retires the layer;
   * `true` once the voice is pushed. `play` stays `void` — nothing reads
   * whether an ordinary one-shot cue was admitted — but `Radio.say` has its
   * own bookkeeping (`busyUntil`, `queueBoundary`, `lastPhrase`, the weapon-
   * bus duck) riding on this one specifically, and running that bookkeeping
   * for a phrase that never actually reached the bus is exactly the bug this
   * return value exists to let the caller avoid.
   */
  speak(spec: PhraseSpec): boolean {
    const rig = this.rig;
    if (!rig || this.failed || this.silenced || rig.ctx.state !== "running") return false;

    try {
      const ctx = rig.ctx;
      const now = ctx.currentTime;
      const at = now + (spec.delay ?? 0);
      const phrase = spec.phrase;

      this.reap(now);
      const busName = spec.bus;
      if (this.count(busName) >= BUS_CAPS[busName]) return false;

      const chain: AudioNode[] = [];

      // The carrier. Sawtooth for a harmonic-rich source the formants have
      // something to shape; pitch starts at the first syllable's (or a
      // neutral default if the phrase is squelch-only) and steps per
      // syllable below.
      const carrier = ctx.createOscillator();
      carrier.type = "sawtooth";
      const firstPitch = phrase.syllables[0]?.pitch ?? 150;
      carrier.frequency.setValueAtTime(clamp(firstPitch, 20, 18000), at);

      // Drive: a trim scales the input by `spec.drive`, then a fixed
      // soft-clip curve — same shape as the master limiter's trim/curve
      // pair, different curve, different purpose.
      const driveTrim = ctx.createGain();
      driveTrim.gain.value = Math.max(spec.drive, 0.0001);
      const shaper = ctx.createWaveShaper();
      shaper.curve = speechDriveCurve();
      shaper.oversample = "none";
      carrier.connect(driveTrim).connect(shaper);
      chain.push(driveTrim, shaper);

      // Three parallel formant bandpasses, summed straight into the gate
      // below — the sum and the syllable gate are the same node.
      const firstFormants = phrase.syllables[0] ?? { f1: 500, f2: 1500, f3: 2500 };
      const formants = [firstFormants.f1, firstFormants.f2, firstFormants.f3].map((freq) => {
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.Q.value = 8;
        filter.frequency.setValueAtTime(clamp(freq, 20, 18000), at);
        shaper.connect(filter);
        chain.push(filter);
        return filter;
      });

      const gate = ctx.createGain();
      gate.gain.setValueAtTime(0.0001, at);
      for (const filter of formants) filter.connect(gate);
      chain.push(gate);

      // One scheduled envelope sequence per syllable, all on the same gate —
      // this is the "not timers" half of the contract. Formant centres and
      // the carrier's own pitch step alongside it via `setTargetAtTime`, a
      // glide rather than a snap, which is what keeps the voice sounding
      // like one continuous phrase instead of a string of blips.
      for (const syllable of phrase.syllables) {
        const sylAt = at + SQUELCH_LEN + syllable.at;
        formants[0].frequency.setTargetAtTime(clamp(syllable.f1, 20, 18000), sylAt, 0.02);
        formants[1].frequency.setTargetAtTime(clamp(syllable.f2, 20, 18000), sylAt, 0.02);
        formants[2].frequency.setTargetAtTime(clamp(syllable.f3, 20, 18000), sylAt, 0.02);
        carrier.frequency.setTargetAtTime(clamp(syllable.pitch, 20, 18000), sylAt, 0.03);

        const attack = Math.min(0.015, syllable.length * 0.25);
        const release = Math.min(0.02, syllable.length * 0.25);
        const hold = Math.max(0, syllable.length - attack - release);
        const peak = Math.max(spec.level * syllable.level, 0.0002);
        gate.gain.setValueAtTime(0.0001, sylAt);
        gate.gain.linearRampToValueAtTime(peak, sylAt + attack);
        if (hold > 0) gate.gain.setValueAtTime(peak, sylAt + attack + hold);
        gate.gain.exponentialRampToValueAtTime(0.0001, sylAt + syllable.length);
      }

      // The telephone band.
      const highpass = ctx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.setValueAtTime(clamp(spec.band[0], 20, 18000), at);
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.setValueAtTime(clamp(spec.band[1], 20, 18000), at);
      gate.connect(highpass).connect(lowpass);
      chain.push(highpass, lowpass);

      // The phrase's own output gain — everything downstream of the voice,
      // squelches included, is one sound leaving through one pan/bus
      // connection, which is what makes `voice.gain` here silence the
      // whole phrase in one ramp if `silence()` cuts it early.
      const output = ctx.createGain();
      lowpass.connect(output);
      chain.push(output);

      const phraseStart = at + SQUELCH_LEN;
      const trailStart = phraseStart + phrase.duration;
      const squelchLevel = spec.level * 0.6;
      const leadSource = this.squelch(ctx, rig.noise, at, squelchLevel, output, chain);
      const trailSource = this.squelch(ctx, rig.noise, trailStart, squelchLevel, output, chain);
      const overallEnd = trailStart + SQUELCH_LEN;

      const busGain = rig.buses[busName];
      if (spec.pan !== undefined && typeof ctx.createStereoPanner === "function") {
        const panner = ctx.createStereoPanner();
        panner.pan.value = clamp(spec.pan, -1, 1);
        output.connect(panner).connect(busGain);
        chain.push(panner);
      } else {
        output.connect(busGain);
      }

      carrier.start(at);
      carrier.stop(overallEnd + 0.02);
      const voice: Voice = { end: overallEnd, gain: output, source: carrier, bus: busName, group: undefined };
      carrier.onended = () => {
        try {
          carrier.disconnect();
          leadSource.disconnect();
          trailSource.disconnect();
          for (const node of chain) node.disconnect();
        } catch {
          // Already gone. Nothing to do, and nothing worth saying about it.
        }
        const index = this.voices.indexOf(voice);
        if (index >= 0) this.voices.splice(index, 1);
      };
      this.voices.push(voice);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  /**
   * One 40 ms squelch burst — a resonant highpass ~2.2 kHz over noise —
   * connected straight into `target` (the phrase's own output gain), so it
   * lives inside `speak`'s node graph rather than as a separate `play` call.
   * That is what keeps a whole phrase, squelches included, one `Voice`.
   */
  private squelch(
    ctx: AudioContext,
    noise: AudioBuffer,
    atTime: number,
    level: number,
    target: AudioNode,
    chain: AudioNode[],
  ): AudioScheduledSourceNode {
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.Q.value = 6;
    filter.frequency.setValueAtTime(2200, atTime);
    const gain = ctx.createGain();
    const attack = 0.006;
    const peak = Math.max(level, 0.0002);
    gain.gain.setValueAtTime(0.0001, atTime);
    gain.gain.linearRampToValueAtTime(peak, atTime + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, atTime + SQUELCH_LEN);
    source.connect(filter).connect(gain).connect(target);
    source.playbackRate.value = 0.9 + Math.random() * 0.2;
    source.start(atTime, Math.random() * (noise.duration - 0.5));
    source.stop(atTime + SQUELCH_LEN + 0.02);
    chain.push(filter, gain);
    return source;
  }

  /** A sustained voice under player control — the alert drone and the engine. */
  bed(spec: BedSpec): Bed {
    const bed = new Bed(this, spec);
    this.beds.push(bed);
    return bed;
  }

  /** Everything stops: a restart, a mode change, a death. */
  silence(): void {
    const rig = this.rig;
    for (const bed of this.beds) {
      bed.set(0, 0, 0, 0, 0);
      // A new run's beds must not inherit a previous run's death dimming —
      // see `Bed.resetPower`'s own docblock.
      bed.resetPower();
    }
    if (!rig || this.failed) return;
    try {
      const now = rig.ctx.currentTime;
      for (const voice of [...this.voices]) this.cut(voice, now);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * A smoothed dip on one bus that recovers on its own — the "duck the world,
   * do not raise the alarm" move from `docs/audio-prior-art.md`: the radio
   * ducks the weapon bus a few dB while a phrase plays; threat ducks the space.
   * Depth in dB (positive = quieter), recovery in seconds. Never below silence,
   * never above the bus's own level, and it composes: a second duck during a
   * recovery restarts the dip from wherever the gain is.
   */
  duck(bus: Bus, depthDb: number, seconds: number): void {
    const rig = this.rig;
    if (!rig || this.failed) return;
    try {
      const gain = rig.buses[bus].gain;
      const now = rig.ctx.currentTime;
      const level = BUS_LEVELS[bus];
      const dipped = level * Math.pow(10, -Math.abs(depthDb) / 20);
      gain.cancelScheduledValues(now);
      gain.setTargetAtTime(dipped, now, 0.012);
      gain.setTargetAtTime(level, now + 0.05, Math.max(seconds, 0.05) / 3);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * The per-sector room. `null` is a dry ship — every send closes and the
   * convolver, if one was ever built, is simply left with nothing feeding it.
   * A `RoomDesign` renders a fresh impulse (`renderImpulse`, `acoustics.ts`)
   * into the convolver's buffer and opens every send but the two pinned dry
   * (`DRY_SENDS`) to `design.wet`, scaled by the current `spaceLevel`.
   *
   * The convolver and its sends are built once, lazily, on the first call
   * with a non-null `design` — most sectors have a room, but nothing here
   * should cost a node graph before the first one does.
   *
   * `rng` defaults to `Math.random`; Task 12 always passes a seeded one (one
   * impulse per sector, deterministic from the campaign seed), so a caller
   * that wants a reproducible room supplies its own generator rather than
   * relying on this default.
   *
   * Skips the rebuild outright when `design` is `sameDesign` as what is
   * already on the convolver (`acoustics.ts`'s own helper — see its
   * docblock): re-rendering an identical IR and swapping the buffer mid-decay
   * is wasted work and an audible click for zero actual change, and a caller
   * asking twice is a real case, not a hypothetical one — `insideComet`'s own
   * hysteresis exists precisely because the reading it latches on can sit
   * right at a threshold.
   */
  setSpace(design: RoomDesign | null, rng: () => number = Math.random): void {
    const rig = this.rig;
    if (!rig || this.failed) return;
    if (sameDesign(design, this.spaceDesign)) return;
    try {
      this.spaceDesign = design;
      if (design) {
        const ctx = rig.ctx;
        if (!rig.convolver) {
          const convolver = ctx.createConvolver();
          // Our IR is already peak-normalised in `renderImpulse` — the
          // node's own auto-normalise would re-scale it by a factor tied to
          // its length and undo that.
          convolver.normalize = false;
          convolver.connect(rig.master);
          const sends = {} as Record<Bus, GainNode>;
          for (const name of Object.keys(BUS_LEVELS) as Bus[]) {
            const send = ctx.createGain();
            send.gain.value = 0;
            rig.buses[name].connect(send);
            send.connect(convolver);
            sends[name] = send;
          }
          rig.convolver = convolver;
          rig.sends = sends;
        }
        const ir = renderImpulse(design, ctx.sampleRate, rng);
        const buffer = ctx.createBuffer(1, ir.length, ctx.sampleRate);
        buffer.getChannelData(0).set(ir);
        rig.convolver.buffer = buffer;
      }
      this.applySendLevels();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * The threat duck for the space: scales every open send by `x` (0..1),
   * smoothed rather than switched, same reasoning as `duck` and `muted` — a
   * send that steps is a click, and this one is meant to breathe with threat
   * rather than announce itself. Composes with `setSpace`: whichever was
   * called more recently, the other's own value is still the one in effect.
   */
  spaceLevel(x: number): void {
    const rig = this.rig;
    if (!rig || this.failed) return;
    try {
      this.spaceLevelValue = clamp(x, 0, 1);
      this.applySendLevels();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * @internal test hook — `setTargetAtTime` schedules a ramp rather than
   * writing a value the mock (or, at any given instant, real WebAudio) can
   * read back, so this returns `applySendLevels`'s own bookkeeping of what
   * each send was last asked for, keyed by `Bus`, rather than asking a test
   * to reconstruct bed/radio's identity from node-graph structure alone.
   */
  sendLevels(): Record<Bus, number> {
    return { ...this.sendTargets };
  }

  /**
   * @internal the budget gate's own hook (`docs/todo.md` §2's positional-echo
   * entry) — the live voice count, unreaped, across every bus. `count(bus)`
   * already answers "how many slots on one bus," which every cue's own
   * cap check needs; this answers the coarser question a human at a real
   * machine asks while a wave-eight fight is loud — "how many oscillators
   * are actually running right now" — without reaping first, so a reading
   * taken mid-frame is not silently rounded down by voices that are about
   * to end anyway.
   */
  liveVoices(): number {
    return this.voices.length;
  }

  private applySendLevels(): void {
    const rig = this.rig;
    const sends = rig?.sends;
    const now = rig?.ctx.currentTime ?? 0;
    const wet = this.spaceDesign ? this.spaceDesign.wet : 0;
    for (const name of Object.keys(BUS_LEVELS) as Bus[]) {
      const target = DRY_SENDS.has(name) ? 0 : wet * this.spaceLevelValue;
      this.sendTargets[name] = target;
      if (sends) sends[name].gain.setTargetAtTime(target, now, 0.05);
    }
  }

  /** @internal — used by `Bed`, which needs the rig it was built against. */
  get context(): Rig | null {
    return this.failed ? null : this.rig;
  }

  /** @internal */
  fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.rig = null;
    this.voices.length = 0;
    // Reported once, at a level that does not fail the harness's console check.
    console.warn("audio disabled:", error);
  }

  private build(): Rig | null {
    const Ctor: ContextCtor | undefined =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (window as unknown as { webkitAudioContext?: ContextCtor }).webkitAudioContext;
    if (!Ctor) return null;

    const ctx = new Ctor({ latencyHint: "interactive" });

    const master = ctx.createGain();
    master.gain.value = this.silenced ? 0 : 1;

    // DC offset accumulates from anything not symmetric about zero — a short
    // random buffer with a non-zero mean, a pulse that is not half duty — and
    // it costs headroom without ever being audible as itself. One highpass and
    // it is never a problem again.
    const dc = ctx.createBiquadFilter();
    dc.type = "highpass";
    dc.frequency.value = 22;

    // One limiter across the whole mix, and it is deliberately *not* a
    // compressor. A chain of mines, a kill and three hostiles firing in the
    // same tenth of a second is a legitimate game state and the destination
    // hard-clips, which sounds like a fault rather than like distortion — but
    // `DynamicsCompressorNode` buys its detection with a fixed 6 ms of
    // lookahead, and 6 ms is a pre-delay on *every* transient in a game whose
    // only time-scaling mechanism exists to sell the frame an impact landed on.
    // Hit-stop, the shield flash and the torpedo's crack are all trying to
    // arrive at once and the compressor moves one of the three.
    //
    // `docs/audio-prior-art.md` §5 names the cost and the alternative: a `tanh`
    // shaper is zero-latency, cannot clip, and leaves quiet material alone. The
    // trade is real and taken with eyes open — the shaper does not squash the
    // way a -20 dB / 8:1 compressor did, so a dense moment is now genuinely
    // louder and more dynamic than a single shot. That is the honest behaviour
    // and the player owns the volume knob; the smear was not theirs to fix.
    //
    // Oversampling stays off. Chrome implements it with a linear-phase
    // resampler that reintroduces latency, which is the one thing we came here
    // to remove, and `tanh` is gentle enough that what it folds back is far
    // below anything the phosphor pass is doing to the picture.
    const trim = ctx.createGain();
    trim.gain.value = 1 / LIMIT_CEILING;
    const limiter = ctx.createWaveShaper();
    limiter.curve = limiterCurve();
    limiter.oversample = "none";

    master.connect(dc).connect(trim).connect(limiter).connect(ctx.destination);

    const buses = {} as Record<Bus, GainNode>;
    for (const name of Object.keys(BUS_LEVELS) as Bus[]) {
      const gain = ctx.createGain();
      gain.gain.value = BUS_LEVELS[name];
      gain.connect(master);
      buses[name] = gain;
    }

    // Two seconds of white noise, generated once and looped by every noise
    // voice. The one buffer in the project, and it is computed, not loaded.
    const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;

    return { ctx, master, buses, noise, convolver: null, sends: null };
  }

  private reap(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i].end <= now) this.voices.splice(i, 1);
    }
  }

  /**
   * Live *slots* on one bus, after `reap` — what `play` checks a brand-new
   * cue against. A slot is one ungrouped voice, or one distinct `group`
   * token: the four layers of a torpedo report count once between them, not
   * four times. (A layer whose own group is *already* one of those slots
   * skips this check entirely — see `play` — since it is not asking for a
   * new one.)
   */
  private count(bus: Bus): number {
    const groups = new Set<number>();
    let n = 0;
    for (const voice of this.voices) {
      if (voice.bus !== bus) continue;
      if (voice.group !== undefined) groups.add(voice.group);
      else n++;
    }
    return n + groups.size;
  }

  /**
   * A fresh token for `VoiceSpec.group` — call once per compound cue and hand
   * the same value to every layer. Monotonic and never reused, so two cues
   * that both call `group()` can never collide even if their voices happen to
   * overlap in time.
   */
  group(): number {
    return ++this.groupSeq;
  }

  private cut(voice: Voice, now: number): void {
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(0.0001, now, 0.008);
    try {
      voice.source.stop(now + 0.04);
    } catch {
      // Already stopped. Nothing to do, and nothing worth saying about it.
    }
    const index = this.voices.indexOf(voice);
    if (index >= 0) this.voices.splice(index, 1);
  }
}

interface BedNodes {
  readonly gain: GainNode;
  readonly filter: BiquadFilterNode;
  readonly tremolo: GainNode;
  readonly depth: GainNode;
  readonly lfo: OscillatorNode;
  readonly pitches: AudioParam[];
}

/**
 * A voice that never stops, driven by game state rather than by an event.
 *
 * Both users are continuous readouts rather than sounds: the alert drone is
 * threat, and the engine bed is thrust. Every parameter is smoothed toward its
 * target over a time constant, so what the game hands it is a level rather than
 * a transition — the same contract the HUD gauges work under.
 */
export class Bed {
  private nodes: BedNodes | null = null;

  /**
   * The filter cutoff and per-oscillator pitch targets `set` last asked for —
   * not what is currently sounding, which `setTargetAtTime` is still gliding
   * toward. `dip` recovers to these rather than to a hardcoded value, so a bed
   * dipped mid-glide still lands where the game actually wants it.
   */
  private lastCutoff = 0;
  private lastPitches: number[] = [];
  /** The level `set` last asked for, before `powerScale` — what `power()` re-scales when it fires on its own, between two `set` calls. */
  private lastLevel = 0;

  /**
   * The death sequence's own multiplier on this bed, 0..1 — see `power()`.
   * Applied on top of every target `set` writes (`lastLevel × powerScale` for
   * gain, `lastCutoff × (0.3 + 0.7 × powerScale)` for cutoff) rather than
   * replacing them, so the two compose regardless of which is called later in
   * a frame: `set()` reads the current `powerScale`, and `power()` reads the
   * last targets `set()` recorded. Reset to 1 by `resetPower()` — never
   * decayed on its own — so a bed silenced mid-death and rebuilt for a fresh
   * run starts at full strength rather than wherever the last run's hull left it.
   */
  private powerScale = 1;

  /**
   * Audio-clock time (`ctx.currentTime`) until which `dip` owns the filter
   * cutoff and pitch params. `set` is called every frame — `sound.update`
   * runs in the same synchronous frame as the `hitStop.strike` that just
   * called `dip`, at essentially the same `ctx.currentTime` — so without this
   * window `set`'s own `setTargetAtTime` back to the live scene's cutoff
   * would re-arm over the dip's before it ever has time to be heard.
   */
  private dipUntil = 0;

  constructor(
    private readonly synth: Synth,
    private readonly spec: BedSpec,
  ) {}

  /**
   * @param level   0 is off. Ramped, never switched.
   * @param freq    fundamental, ignored by noise beds
   * @param cutoff  filter frequency — the "how urgent" axis
   * @param rate    tremolo speed in Hz; a pulse is what makes a drone an alarm
   * @param depth   0 steady … 0.5 fully gated
   *
   * While a `dip` is active (`ctx.currentTime < dipUntil`), the filter cutoff
   * and pitch params are *held* rather than written — `dip` owns them for its
   * window, since this is called every frame and would otherwise re-arm the
   * un-dipped values over the dip before it ever sounds. `lastCutoff`/
   * `lastPitches` still update underneath, so the moment the window ends the
   * next `set()` (or `dip`'s own scheduled recovery) converges on wherever
   * the live scene actually is, not a stale value from before the dip.
   */
  set(level: number, freq: number, cutoff: number, rate: number, depth: number): void {
    const rig = this.synth.context;
    if (!rig) return;

    try {
      if (!this.nodes && level > 0.0005) this.nodes = this.build(rig.ctx, rig.buses[this.spec.bus ?? "bed"], rig.noise);
      const nodes = this.nodes;
      if (!nodes) return;

      const now = rig.ctx.currentTime;
      const glide = 0.12;
      const dipping = now < this.dipUntil;
      const levelTarget = Math.max(0, level);
      this.lastLevel = levelTarget;
      nodes.gain.gain.setTargetAtTime(levelTarget * this.powerScale, now, glide);
      const cutoffTarget = clamp(cutoff, 30, 16000);
      this.lastCutoff = cutoffTarget;
      if (!dipping) nodes.filter.frequency.setTargetAtTime(cutoffTarget * this.powerFactor(), now, glide);
      nodes.lfo.frequency.setTargetAtTime(clamp(rate, 0.05, 24), now, glide);
      nodes.depth.gain.setTargetAtTime(clamp(depth, 0, 0.5), now, glide);
      nodes.tremolo.gain.setTargetAtTime(1 - clamp(depth, 0, 0.5), now, glide);
      for (let i = 0; i < nodes.pitches.length; i++) {
        const ratio = i === 0 ? 1 : (this.spec.ratio ?? 1.5);
        const pitchTarget = clamp(freq * ratio, 20, 16000);
        if (!dipping) nodes.pitches[i].setTargetAtTime(pitchTarget, now, glide);
        this.lastPitches[i] = pitchTarget;
      }
    } catch (error) {
      this.synth.fail(error);
    }
  }

  /**
   * A brief lowpass-and-pitch dip that recovers on its own — hit-stop's own
   * cue for a sustained voice, since a bed cannot itself be time-dilated the
   * way a game-time envelope can. Driven by the audio clock, wall-clock like
   * hit-stop, so the dip and the frame it marks stay in the same instant
   * regardless of `Session.timeScale`.
   *
   * A no-op on a bed that never reached a live level: `nodes` is null and
   * there is nothing to dip. Never throws, on the same contract as `set`.
   *
   * @param seconds how long the dip takes to recover — hit-stop's own window.
   */
  dip(seconds: number): void {
    const rig = this.synth.context;
    if (!rig) return;
    const nodes = this.nodes;
    if (!nodes) return;

    try {
      const now = rig.ctx.currentTime;
      const attack = 0.008;
      // Owns the two dipped params against `set`'s own every-frame writes
      // until the window closes — see `set`'s docblock.
      this.dipUntil = now + seconds;
      nodes.filter.frequency.setTargetAtTime(this.lastCutoff * 0.55, now, attack);
      for (let i = 0; i < nodes.pitches.length; i++) {
        nodes.pitches[i].setTargetAtTime((this.lastPitches[i] ?? 0) * 0.94, now, attack);
      }

      const recoverAt = now + seconds * 0.25;
      const recoverTau = seconds / 3;
      nodes.filter.frequency.setTargetAtTime(this.lastCutoff, recoverAt, recoverTau);
      for (let i = 0; i < nodes.pitches.length; i++) {
        nodes.pitches[i].setTargetAtTime(this.lastPitches[i] ?? 0, recoverAt, recoverTau);
      }
    } catch (error) {
      this.synth.fail(error);
    }
  }

  /**
   * The death sequence's own reach into a bed, called every frame with
   * `DeathSequence.power` (0..1) so the reactor dies on the panel's own
   * flicker rather than being cut separately. Gain scales directly
   * (`lastLevel × x`); cutoff is floored at 0.3 rather than scaled to zero
   * (`lastCutoff × (0.3 + 0.7x)`) because a filter fully closed reads as a
   * fault, not as power failing — the bed should thin toward a dull hum, not
   * vanish. Written against the *last* targets `set` recorded, the same
   * convention `dip`'s own recovery uses, and stored in `powerScale` so
   * `set()` itself keeps applying it on every subsequent frame — see that
   * field's own docblock for why the two compose regardless of call order.
   * Respects an active `dip` window on the cutoff for the same reason `set`
   * does: `dip` owns that param until its own recovery is due.
   */
  power(x: number): void {
    this.powerScale = clamp(x, 0, 1);
    const rig = this.synth.context;
    if (!rig) return;
    const nodes = this.nodes;
    if (!nodes) return;

    try {
      const now = rig.ctx.currentTime;
      const glide = 0.12;
      nodes.gain.gain.setTargetAtTime(this.lastLevel * this.powerScale, now, glide);
      if (now >= this.dipUntil) {
        nodes.filter.frequency.setTargetAtTime(this.lastCutoff * this.powerFactor(), now, glide);
      }
    } catch (error) {
      this.synth.fail(error);
    }
  }

  /** A new run's beds must not inherit a previous run's death dimming — the
   *  one place `powerScale` is allowed to jump back to 1 rather than glide. */
  resetPower(): void {
    this.powerScale = 1;
  }

  private powerFactor(): number {
    return 0.3 + 0.7 * this.powerScale;
  }

  private build(ctx: AudioContext, bus: GainNode, noise: AudioBuffer): BedNodes {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const tremolo = ctx.createGain();
    tremolo.gain.value = 1;
    const filter = ctx.createBiquadFilter();
    filter.type = this.spec.filter ?? "lowpass";
    filter.Q.value = this.spec.q ?? 1;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 1;
    const depth = ctx.createGain();
    depth.gain.value = 0;
    lfo.connect(depth).connect(tremolo.gain);
    lfo.start();

    filter.connect(tremolo).connect(gain).connect(bus);

    const pitches: AudioParam[] = [];
    if (this.spec.kind === "noise") {
      const player = ctx.createBufferSource();
      player.buffer = noise;
      player.loop = true;
      player.connect(filter);
      player.start();
    } else {
      // Two, so the drone beats slowly against itself. One oscillator holding a
      // pitch is a test tone; two nearly in tune is a machine running.
      for (let i = 0; i < 2; i++) {
        const osc = ctx.createOscillator();
        osc.type = this.spec.wave ?? "sawtooth";
        osc.frequency.value = 60;
        osc.connect(filter);
        osc.start();
        pitches.push(osc.frequency);
      }
    }

    return { gain, filter, tremolo, depth, lfo, pitches };
  }
}
