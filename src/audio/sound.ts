import { Synth, type Bed } from "./Synth.js";

/**
 * Every sound the game makes, in one bank.
 *
 * Two conventions hold this together, and they are the audio versions of rules
 * the picture already follows.
 *
 * **Colour is information.** The palette gives each class a hue and never
 * spends one on decoration; the same discipline applies here to timbre and to
 * direction. Yours are clean — triangle and sine, bright, centred, because you
 * are always at the middle of the tube. Theirs are dirty — sawtooth and square,
 * lower, and placed in the stereo field by where they actually are, so a bolt
 * fired from your port quarter arrives on your left. The Shroud gets the one
 * timbre nothing else uses: two detuned oscillators beating against each other,
 * which is what "unresolved" sounds like, exactly as magenta is what it looks
 * like.
 *
 * **The sound is where the event is.** Distance attenuates and bearing pans,
 * from one listener updated once a frame. That is not atmosphere — it is the
 * scanner's job done by ear, and it is why the decloak is survivable: it tells
 * you which way to turn before the burst lands.
 *
 * Imported directly rather than threaded through constructors. There is one
 * pair of speakers the way there is one screen, and a callback per event would
 * be six constructor parameters that only ever carry the same value.
 */

export interface SoundScene {
  /** Total value of everything alive; the alert drone rides this. */
  readonly threat: number;
  readonly hull: number;
  /** 0…1 forward burn. */
  readonly thrust: number;
  readonly speed: number;
  /** False on the title screen and after the hull goes: the beds fall silent. */
  readonly alive: boolean;
  readonly docked: boolean;
}

/** Threat worth a full-volume alarm — roughly a wave-six field. */
const FULL_THREAT = 1100;
/** Distance at which a sound is half as loud. */
const HALF_RANGE = 34;
/** Hard panning is disorienting when the source is a few metres off the nose. */
const PAN_WIDTH = 0.8;

/** A major arpeggio, extended: the tally climbs this as the multiplier grows. */
const ARPEGGIO = [0, 4, 7, 12, 16, 19, 24];
/** The four service stages, as a plain rising figure. */
const SERVICE_NOTES = [523.25, 659.25, 783.99, 987.77];

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export class Sound {
  private readonly synth = new Synth();
  private alert: Bed | null = null;
  private engine: Bed | null = null;

  /** The listener: where the ship is and which way it is pointing. */
  private lx = 0;
  private lz = 0;
  private lh = 0;

  /**
   * Alternates the phaser's pitch shot to shot. Held fire is 6.25 shots a
   * second and identical repeats at that rate stop reading as separate events
   * and start reading as a buzz; two pitches turn the same burst into a figure.
   */
  private phaserFlip = 0;

  get muted(): boolean {
    return this.synth.muted;
  }

  set muted(value: boolean) {
    if (value) this.synth.silence();
    this.synth.muted = value;
  }

  /** The gesture the autoplay policy waits for. Called from the keyboard handler. */
  start(): void {
    this.synth.start();
    if (!this.alert) {
      this.alert = this.synth.bed({ kind: "tone", wave: "sawtooth", filter: "lowpass", q: 4, ratio: 1.5 });
    }
    if (!this.engine) {
      this.engine = this.synth.bed({ kind: "noise", filter: "lowpass", q: 0.8 });
    }
  }

  setPaused(paused: boolean): void {
    this.synth.setPaused(paused);
  }

  listen(x: number, z: number, heading: number): void {
    this.lx = x;
    this.lz = z;
    this.lh = heading;
  }

  /**
   * The two continuous readouts. Both are levels rather than events, so this is
   * called every frame with the state and nothing is scheduled.
   */
  update(scene: SoundScene): void {
    const pressure = clamp(scene.threat / FULL_THREAT, 0, 1);
    const hurt = 1 - clamp(scene.hull, 0, 1);

    // The alert used to be a sustained bed riding threat. It is now a pulse —
    // see `alertBeat`, and `AlertPulse` for why — so this bed is held at
    // silence rather than removed: the machinery is one voice, and a future
    // sustained layer (a reactor, a hull under load) would want it back.
    this.alert?.set(0, 42 + pressure * 9, 170 + hurt * 220, 0, 0);

    // Engine. Under thrust it opens up; moored it is off, because a ship in the
    // clamps is a ship with its drive shut down.
    const moving = clamp(scene.speed / 62, 0, 1);
    this.engine?.set(
      scene.alive && !scene.docked ? 0.028 + scene.thrust * 0.075 + moving * 0.022 : 0,
      0,
      150 + scene.thrust * 430 + moving * 240,
      0,
      0,
    );
  }

  /** A restart, a mode change, a death: whatever was ringing stops ringing. */
  silence(): void {
    this.synth.silence();
  }

  // ── weapons ──────────────────────────────────────────────────────────────

  /**
   * The hardest mixing problem in the game: 0.16s between shots, held down for
   * whole waves at a time. Kept short, kept quiet, kept on its own bus, and
   * alternated in pitch. The hit is the same shot with a spark on the end —
   * hitting has to be audible without being a second sound to get tired of.
   */
  phaser(hit: boolean): void {
    this.phaserFlip ^= 1;
    const base = this.phaserFlip ? 1240 : 1120;
    this.synth.play({
      bus: "weapon",
      wave: "triangle",
      freq: base,
      to: base * 0.42,
      level: 0.15,
      attack: 0.002,
      decay: 0.07,
    });
    this.synth.play({
      kind: "noise",
      bus: "weapon",
      filter: "bandpass",
      q: 6,
      freq: 2700,
      to: 1500,
      level: 0.05,
      attack: 0.001,
      decay: 0.05,
    });
    if (hit) {
      this.synth.play({
        kind: "noise",
        bus: "weapon",
        filter: "highpass",
        freq: 1900,
        level: 0.07,
        attack: 0.001,
        decay: 0.09,
        delay: 0.02,
      });
    }
  }

  /** Heavy and downward, where the phaser is light and short. */
  torpedo(): void {
    this.synth.play({
      bus: "weapon",
      wave: "sine",
      freq: 190,
      to: 62,
      level: 0.24,
      attack: 0.005,
      decay: 0.34,
    });
    this.synth.play({
      kind: "noise",
      bus: "weapon",
      filter: "lowpass",
      q: 1.2,
      freq: 1300,
      to: 220,
      level: 0.17,
      attack: 0.004,
      decay: 0.3,
    });
  }

  /** Somebody else's trigger. Placed, so an ambush from astern says so. */
  hostileFire(x: number, z: number): void {
    const { level, pan } = this.place(x, z);
    // Out of earshot is worth checking here rather than in the synth: a wave of
    // eight all firing at the rim would otherwise spend the whole voice pool on
    // sounds nobody can hear.
    if (level < 0.06) return;
    this.synth.play({
      bus: "weapon",
      wave: "sawtooth",
      freq: 520,
      to: 300,
      level: 0.1 * level,
      attack: 0.003,
      decay: 0.13,
      pan,
    });
  }

  // ── things landing ───────────────────────────────────────────────────────

  /** A torpedo on a hull that survives it. */
  impact(x: number, z: number): void {
    const { level, pan } = this.place(x, z);
    this.synth.play({
      kind: "noise",
      filter: "bandpass",
      q: 1.4,
      freq: 900,
      to: 260,
      level: 0.2 * level,
      attack: 0.002,
      decay: 0.18,
      pan,
    });
    this.synth.play({
      wave: "triangle",
      freq: 150,
      to: 70,
      level: 0.16 * level,
      attack: 0.003,
      decay: 0.24,
      pan,
    });
  }

  /** @param size relative to a Raider; a Bastion is worth more air than a Raider. */
  kill(x: number, z: number, size: number): void {
    const { level, pan } = this.place(x, z);
    this.synth.play({
      kind: "noise",
      filter: "lowpass",
      q: 0.8,
      freq: 2200,
      to: 70,
      level: 0.32 * level,
      attack: 0.003,
      decay: 0.42 * size,
      pan,
    });
    this.synth.play({
      wave: "sine",
      freq: 260 / size,
      to: 46,
      level: 0.22 * level,
      attack: 0.005,
      decay: 0.5 * size,
      pan,
    });
    // The crack at the front, so the blast has an edge and not just a body.
    this.synth.play({
      kind: "noise",
      filter: "highpass",
      freq: 3000,
      level: 0.13 * level,
      attack: 0.001,
      decay: 0.07,
      pan,
    });
  }

  /** Absorbed by a facing: metallic and ringing, and deliberately not alarming. */
  shieldHit(x: number, z: number): void {
    const { level, pan } = this.place(x, z, 0.35);
    this.synth.play({
      wave: "sawtooth",
      freq: 640,
      to: 430,
      level: 0.1 * level,
      attack: 0.002,
      decay: 0.13,
      pan,
    });
    this.synth.play({
      kind: "noise",
      filter: "bandpass",
      q: 9,
      freq: 1500,
      level: 0.09 * level,
      attack: 0.002,
      decay: 0.18,
      pan,
    });
  }

  /**
   * Something reached the hull, which in this game means the multiplier just
   * halved. So it is two sounds: the blow, and then a falling interval that is
   * the money leaving.
   */
  breach(): void {
    this.synth.play({
      kind: "noise",
      filter: "lowpass",
      q: 0.7,
      freq: 700,
      to: 90,
      level: 0.32,
      attack: 0.002,
      decay: 0.45,
    });
    this.synth.play({ wave: "sine", freq: 120, to: 48, level: 0.28, attack: 0.004, decay: 0.5 });
    this.synth.play({ bus: "panel", wave: "square", freq: 466, level: 0.07, decay: 0.16 });
    this.synth.play({ bus: "panel", wave: "square", freq: 349, level: 0.07, decay: 0.2, delay: 0.17 });
  }

  mineBlast(x: number, z: number): void {
    const { level, pan } = this.place(x, z);
    this.synth.play({
      kind: "noise",
      filter: "lowpass",
      q: 0.9,
      freq: 1300,
      to: 60,
      level: 0.28 * level,
      attack: 0.002,
      decay: 0.5,
      pan,
    });
    this.synth.play({
      wave: "sine",
      freq: 150,
      to: 40,
      level: 0.2 * level,
      attack: 0.004,
      decay: 0.45,
      pan,
    });
  }

  /** The Harrow seeding your course. A click, so the field arriving is not silent. */
  mineLay(x: number, z: number): void {
    const { level, pan } = this.place(x, z);
    if (level < 0.08) return;
    this.synth.play({
      wave: "triangle",
      freq: 880,
      to: 700,
      level: 0.05 * level,
      attack: 0.001,
      decay: 0.045,
      pan,
    });
  }

  // ── the Shroud ───────────────────────────────────────────────────────────

  /**
   * The most important sound in the game.
   *
   * The cloaker is only fair because it materialises over 0.45s before it fires,
   * and until now that tell was a flare somewhere off screen — useless if you
   * were not already looking at it. This is the same tell in a medium that does
   * not need you to be facing the right way. It rises, because everything else
   * that matters here falls; it is two detuned oscillators, because that is the
   * timbre reserved for what will not resolve; it is panned, so it says which
   * way to turn; and it carries a floor under its distance attenuation, because
   * a warning you cannot hear is not a warning. The crack at 0.42s is the hull
   * finishing — which is three hundredths of a second before the first bolt.
   */
  decloak(x: number, z: number): void {
    const { level, pan } = this.place(x, z, 0.62);
    for (const detune of [1, 1.043]) {
      this.synth.play({
        wave: "sawtooth",
        freq: 300 * detune,
        to: 1500 * detune,
        level: 0.15 * level,
        attack: 0.06,
        decay: 0.38,
        pan,
      });
    }
    this.synth.play({
      kind: "noise",
      filter: "bandpass",
      q: 3,
      freq: 700,
      to: 4200,
      level: 0.14 * level,
      attack: 0.09,
      decay: 0.35,
      pan,
    });
    this.synth.play({
      kind: "noise",
      filter: "highpass",
      freq: 2400,
      level: 0.17 * level,
      attack: 0.002,
      decay: 0.2,
      delay: 0.42,
      pan,
    });
    this.synth.play({
      wave: "triangle",
      freq: 1500,
      to: 420,
      level: 0.13 * level,
      attack: 0.002,
      decay: 0.3,
      delay: 0.42,
      pan,
    });
  }

  // ── the run ──────────────────────────────────────────────────────────────

  /** A wave arriving. Falls, and falls lower the deeper the run goes. */
  wave(index: number): void {
    const base = Math.max(180, 330 - index * 11);
    for (const detune of [1, 1.012]) {
      this.synth.play({
        bus: "panel",
        wave: "sawtooth",
        freq: base * detune,
        to: base * 0.38,
        level: 0.1,
        attack: 0.06,
        hold: 0.1,
        decay: 0.7,
      });
    }
    this.synth.play({
      kind: "noise",
      bus: "panel",
      filter: "bandpass",
      q: 1.6,
      freq: 200,
      to: 900,
      level: 0.08,
      attack: 0.35,
      decay: 0.35,
    });
  }

  /** Two notes up: the only unambiguously good news the combat loop delivers. */
  /**
   * The two-second commitment, made audible.
   *
   * Deliberately not a rising sine — that is the most worn sound in the medium,
   * and `docs/audio-prior-art.md` §6 argues the frame-shift charge in Elite
   * Dangerous works because it builds in **spectral width and depth rather than
   * level**. So the fundamental barely moves; what opens up is the detuning
   * between three partials and the bandwidth of the noise above them. It gets
   * *wider*, not louder, which is what "something enormous is spinning up"
   * sounds like.
   *
   * @param duration seconds the charge will run if it is not released.
   */
  hyperwarpCharge(duration: number): void {
    const attack = 0.12;
    const decay = 0.22;
    const hold = Math.max(0.1, duration - attack - decay);

    // Three partials that start nearly in unison and spread apart. Beating
    // between them is the whole effect — at the start they are one note, by
    // the end they are a chord that has not decided what it is.
    for (const [from, to, level] of [
      [58, 55, 0.1],
      [58.6, 82.5, 0.075],
      [57.4, 110, 0.055],
    ]) {
      this.synth.play({
        bus: "panel",
        wave: "sawtooth",
        freq: from,
        to,
        level,
        attack,
        hold,
        decay,
      });
    }

    // The band opening upward. Q stays tight so this reads as a resonance
    // climbing rather than as a hiss being faded in.
    this.synth.play({
      kind: "noise",
      bus: "panel",
      filter: "bandpass",
      q: 6,
      freq: 220,
      to: 3200,
      level: 0.05,
      attack: 0.2,
      hold,
      decay,
    });
  }

  /** Cut short. The spin-down is the refund of nothing, said in one syllable. */
  hyperwarpAbort(): void {
    this.synth.play({ bus: "panel", wave: "sawtooth", freq: 82, to: 41, level: 0.08, decay: 0.22 });
    this.synth.play({
      kind: "noise",
      bus: "panel",
      filter: "bandpass",
      q: 5,
      freq: 1800,
      to: 240,
      level: 0.04,
      decay: 0.26,
    });
  }

  /**
   * Arrival. The one moment in this cue that is allowed to be loud, because
   * everything before it was width — a transient here is what makes the two
   * seconds resolve rather than merely stop.
   */
  hyperwarpArrive(): void {
    this.synth.play({
      kind: "noise",
      bus: "impact",
      filter: "highpass",
      freq: 900,
      to: 120,
      level: 0.2,
      attack: 0.004,
      decay: 0.5,
    });
    this.synth.play({ bus: "impact", wave: "sine", freq: 220, to: 41, level: 0.18, decay: 0.55 });
    // The far side, a beat later: thin, high, and alone, because you arrived
    // cold and the sector has not said anything back yet.
    this.synth.play({
      bus: "panel",
      wave: "triangle",
      freq: 1318.5,
      level: 0.07,
      decay: 0.3,
      delay: 0.18,
    });
  }

  /**
   * A warhead cracked for its charge. Deliberately unglamorous — a casing
   * being opened and something venting into the reserve, not a power-up. It
   * should sound like a thing you had to do.
   */
  scram(): void {
    this.synth.play({
      kind: "noise",
      bus: "panel",
      filter: "bandpass",
      q: 3,
      freq: 2400,
      to: 300,
      level: 0.11,
      attack: 0.005,
      decay: 0.34,
    });
    // Rising, because the reserve is going up, but thin and short so it never
    // reads as a reward.
    this.synth.play({
      bus: "panel",
      wave: "triangle",
      freq: 196,
      to: 392,
      level: 0.075,
      attack: 0.01,
      decay: 0.26,
      delay: 0.05,
    });
  }

  /**
   * One beat of the alert. Short, low, and mostly not happening.
   *
   * The bed this replaces was a continuous drone, which `audio-prior-art.md`
   * argues is the wrong shape for exactly the reason the ear adapts to a
   * steady tone within seconds. Asteroids held its note at a fixed four ticks
   * and only ever shortened the silence between beats; at its very worst the
   * duty cycle was about a third. This is that, with the pitch axis Alien:
   * Isolation's tracker added.
   */
  alertBeat(frequency: number, red: boolean): void {
    this.synth.play({
      bus: "panel",
      wave: red ? "sawtooth" : "triangle",
      freq: frequency,
      level: red ? 0.115 : 0.075,
      attack: 0.006,
      hold: 0.045,
      decay: 0.07,
    });
    if (!red) return;
    // A second partial a minor second up, only at red. Genuine critical-band
    // roughness rather than a volume increase — the CHI 2024 result is that
    // amplification alone hurts, so urgency is bought with dissonance.
    this.synth.play({
      bus: "panel",
      wave: "sawtooth",
      freq: frequency * 1.06,
      level: 0.055,
      attack: 0.006,
      hold: 0.045,
      decay: 0.07,
    });
  }

  /**
   * The whoop, when the condition changes. Once per change, never on a loop —
   * a klaxon that repeats forever is the thing players mute.
   *
   * Our own cadence deliberately: alert conditions are naval usage that long
   * predates any television programme, but the specific sound anyone would
   * recognise belongs to that programme, and "our own universe" is locked.
   */
  conditionChange(red: boolean): void {
    const base = red ? 320 : 240;
    // Two sweeps up, the second higher and later — a whoop is a shape, not a
    // pitch, and two of them read as an alarm rather than as an event.
    for (const [mul, delay, level] of [
      [1, 0, red ? 0.13 : 0.085],
      [1.34, 0.19, red ? 0.11 : 0.07],
    ]) {
      this.synth.play({
        bus: "panel",
        wave: red ? "sawtooth" : "triangle",
        freq: base * mul,
        to: base * mul * 1.9,
        level,
        attack: 0.09,
        hold: 0.04,
        decay: 0.16,
        delay,
      });
    }
    if (!red) return;
    this.synth.play({
      kind: "noise",
      bus: "panel",
      filter: "bandpass",
      q: 4,
      freq: 700,
      to: 2100,
      level: 0.045,
      attack: 0.1,
      decay: 0.24,
    });
  }

  sectorClear(): void {
    this.synth.play({ bus: "panel", wave: "triangle", freq: 659.25, level: 0.11, decay: 0.18 });
    this.synth.play({
      bus: "panel",
      wave: "triangle",
      freq: 987.77,
      level: 0.11,
      decay: 0.3,
      delay: 0.12,
    });
  }

  // ── docking ──────────────────────────────────────────────────────────────

  /** Entering the capture ring. A tick, so the gate is something you hear pass. */
  gate(): void {
    this.synth.play({ bus: "panel", wave: "sine", freq: 1244, level: 0.07, decay: 0.06 });
  }

  /**
   * The tractor taking the helm, as one rising tone across the whole capture.
   * It is the only long note in the game and it is doing the thing the sequence
   * needs: telling you that control has left your hands and something else is
   * winding you in.
   *
   * @param duration seconds the capture will take, so the note lands with it.
   */
  tractor(duration: number): void {
    const attack = 0.25;
    const decay = 0.3;
    const hold = Math.max(0.1, duration - attack - decay);
    for (const [ratio, level] of [
      [1, 0.13],
      [1.5, 0.07],
    ]) {
      this.synth.play({
        bus: "panel",
        wave: "sine",
        freq: 120 * ratio,
        to: 480 * ratio,
        level,
        attack,
        hold,
        decay,
      });
    }
    this.synth.play({
      kind: "noise",
      bus: "panel",
      filter: "bandpass",
      q: 2.5,
      freq: 400,
      to: 1700,
      level: 0.06,
      attack: 0.3,
      hold,
      decay,
    });
  }

  /** The clamps. Body, thud and a ring off the structure. */
  hardDock(): void {
    this.synth.play({
      kind: "noise",
      filter: "lowpass",
      q: 0.8,
      freq: 600,
      to: 70,
      level: 0.34,
      attack: 0.001,
      decay: 0.22,
    });
    this.synth.play({ wave: "sine", freq: 96, to: 52, level: 0.3, attack: 0.002, decay: 0.3 });
    this.synth.play({
      kind: "noise",
      filter: "bandpass",
      q: 12,
      freq: 780,
      level: 0.1,
      attack: 0.002,
      decay: 0.35,
      delay: 0.02,
    });
  }

  /** One blip per system restored, climbing. @param step 0…3 */
  service(step: number): void {
    const note = SERVICE_NOTES[clamp(step, 0, SERVICE_NOTES.length - 1)];
    this.synth.play({ bus: "panel", wave: "triangle", freq: note, level: 0.12, decay: 0.16 });
    this.synth.play({
      kind: "noise",
      bus: "panel",
      filter: "highpass",
      freq: 3200,
      level: 0.04,
      attack: 0.001,
      decay: 0.03,
    });
  }

  /**
   * The tally, pitched by the multiplier — the whole greed loop as one sound.
   *
   * A big bank has to be audibly bigger, so three things move together: the root
   * climbs up to an octave, the arpeggio runs further up, and a sub note comes
   * in underneath. Banking at 1.0x is four notes and a shrug. Banking at 9x is
   * seven notes an octave higher over a bass note, and that is the sound the
   * game wants a player pushing one wave too far to be chasing.
   */
  tally(multiplier: number, total: number): void {
    if (total <= 0) {
      this.synth.play({ bus: "panel", wave: "triangle", freq: 523.25, level: 0.1, decay: 0.2 });
      return;
    }

    const semitones = Math.round(clamp((multiplier - 1) * 1.4, 0, 12));
    const root = 261.63 * Math.pow(2, semitones / 12);
    const notes = Math.min(ARPEGGIO.length, 4 + Math.floor(multiplier / 2.2));

    for (let i = 0; i < notes; i++) {
      this.synth.play({
        bus: "panel",
        wave: "triangle",
        freq: root * Math.pow(2, ARPEGGIO[i] / 12),
        level: 0.13,
        attack: 0.004,
        decay: i === notes - 1 ? 0.55 : 0.3,
        delay: i * 0.085,
      });
    }
    this.synth.play({
      bus: "panel",
      wave: "sine",
      freq: root / 2,
      level: 0.11,
      attack: 0.01,
      hold: notes * 0.06,
      decay: 0.6,
    });
  }

  /** The clamps letting go, and the shove off them. */
  depart(): void {
    this.synth.play({
      kind: "noise",
      filter: "highpass",
      freq: 200,
      to: 1500,
      level: 0.16,
      attack: 0.05,
      decay: 0.45,
    });
    this.synth.play({ wave: "sine", freq: 70, to: 132, level: 0.13, attack: 0.02, decay: 0.4 });
  }

  // ── the end of a run ─────────────────────────────────────────────────────

  /** Everything falls at once, and takes longer to do it than anything else. */
  death(): void {
    this.synth.play({
      kind: "noise",
      filter: "lowpass",
      q: 0.7,
      freq: 2400,
      to: 40,
      level: 0.42,
      attack: 0.004,
      decay: 1.4,
    });
    this.synth.play({ wave: "sine", freq: 300, to: 30, level: 0.3, attack: 0.01, decay: 1.5 });
    this.synth.play({ wave: "sawtooth", freq: 220, to: 28, level: 0.15, attack: 0.02, decay: 1.2 });
  }

  /** Emergency power finding the bus, under the epitaph. */
  panelRestore(): void {
    this.synth.play({
      bus: "panel",
      wave: "sine",
      freq: 60,
      to: 190,
      level: 0.11,
      attack: 0.3,
      decay: 0.5,
    });
    this.synth.play({
      bus: "panel",
      wave: "triangle",
      freq: 1046.5,
      level: 0.07,
      decay: 0.07,
      delay: 0.55,
    });
  }

  // ── placement ────────────────────────────────────────────────────────────

  /**
   * Where a sound is, relative to the ear. The same projection the scanner uses
   * to put a contact on the tube, spent on the other instrument.
   *
   * @param floor minimum level regardless of range, for things you must hear
   */
  private place(x: number, z: number, floor = 0): { level: number; pan: number } {
    const dx = x - this.lx;
    const dz = z - this.lz;
    const distance = Math.hypot(dx, dz);
    const level = Math.max(floor, 1 / (1 + Math.pow(distance / HALF_RANGE, 1.7)));
    if (distance < 1e-3) return { level, pan: 0 };
    const right = (dx * Math.cos(this.lh) - dz * Math.sin(this.lh)) / distance;
    return { level, pan: clamp(right, -1, 1) * PAN_WIDTH };
  }
}

export const sound = new Sound();
