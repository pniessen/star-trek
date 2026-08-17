/**
 * The sound machine: one voice vocabulary, reused for everything.
 *
 * The renderer draws every transient — beams, debris, corridor guides — out of
 * one stroke buffer, and every glyph out of one stroke font, because a look
 * comes from a small vocabulary used consistently rather than from a bespoke
 * object per effect. This is the same argument in the other medium. There are
 * exactly two voices here: a pitched oscillator that can glide, and filtered
 * noise whose filter can sweep. A phaser, a hard dock, a mine going off and the
 * Shroud materialising are all combinations of those two with different
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
  /** Pitched by default; `noise` swaps the oscillator for filtered noise. */
  readonly kind?: "tone" | "noise";
  readonly bus?: Bus;
  /** Tone: starting pitch. Noise: starting filter frequency. */
  readonly freq: number;
  /** Glide/sweep target, arrived at as the envelope ends. */
  readonly to?: number;
  readonly wave?: OscillatorType;
  readonly filter?: BiquadFilterType;
  readonly q?: number;
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

/** Peak gain per bus. The entire mix balance is these nine numbers. */
const BUS_LEVELS: Record<Bus, number> = {
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

interface Rig {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly buses: Record<Bus, GainNode>;
  readonly noise: AudioBuffer;
}

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

  /** A sustained voice under player control — the alert drone and the engine. */
  bed(spec: BedSpec): Bed {
    const bed = new Bed(this, spec);
    this.beds.push(bed);
    return bed;
  }

  /** Everything stops: a restart, a mode change, a death. */
  silence(): void {
    const rig = this.rig;
    for (const bed of this.beds) bed.set(0, 0, 0, 0, 0);
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

    return { ctx, master, buses, noise };
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
      nodes.gain.gain.setTargetAtTime(Math.max(0, level), now, glide);
      nodes.filter.frequency.setTargetAtTime(clamp(cutoff, 30, 16000), now, glide);
      nodes.lfo.frequency.setTargetAtTime(clamp(rate, 0.05, 24), now, glide);
      nodes.depth.gain.setTargetAtTime(clamp(depth, 0, 0.5), now, glide);
      nodes.tremolo.gain.setTargetAtTime(1 - clamp(depth, 0, 0.5), now, glide);
      for (let i = 0; i < nodes.pitches.length; i++) {
        const ratio = i === 0 ? 1 : (this.spec.ratio ?? 1.5);
        nodes.pitches[i].setTargetAtTime(clamp(freq * ratio, 20, 16000), now, glide);
      }
    } catch (error) {
      this.synth.fail(error);
    }
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
