import { Synth, type Bed } from "./Synth.js";
import { Radio, type Party, type RadioEvent, type Doctrine } from "./radio.js";

/**
 * Every sound the game makes, in one bank.
 *
 * Two conventions hold this together, and they are the audio versions of rules
 * the picture already follows.
 *
 * **Colour is information.** The palette gives each class a hue and never
 * spends one on decoration; the same discipline applies here to band and to
 * direction. Yours are high and centred, because you are always at the middle
 * of the tube; theirs are low and placed in the stereo field by where they
 * actually are, so a bolt fired from your port quarter arrives on your left.
 * Timbre follows from that rather than leading it — the panel and the Warden
 * speak in triangles and sines because they are talking to you, and the guns
 * on both sides are harsh because a gun is. The Shroud's decloak used to be
 * the one thing here voiced as two detuned oscillators beating against each
 * other; it has moved to the `fm` voice's own bell shape instead — an index
 * that settles from inharmonic to plain across the whole wind-up, because
 * *resolving* is an arc and a fixed timbre could only ever gesture at one.
 * Detuned beating moved rather than retired: `ping` (§ the scanner, heard,
 * below) spends the same device on the same idea, roughness standing in for
 * how wide a return's own drawn uncertainty is — so "unresolved" is still
 * something you can hear, just no longer the Shroud's alone to say.
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
  /** 0…1 reserve; the reactor bed's cutoff, pitch and relay tick all read this. */
  readonly energy: number;
  /** `Ship.starved`'s own threshold, reused rather than re-guessed here. */
  readonly starved: boolean;
}

/** Threat worth a full-volume alarm — roughly a wave-six field. */
const FULL_THREAT = 1100;
/** Distance at which a sound is half as loud. */
const HALF_RANGE = 34;
/** Hard panning is disorienting when the source is a few metres off the nose. */
const PAN_WIDTH = 0.8;

/**
 * Mirrors `SCANNER.errorFar` and `CloakSpec.wind` (`hud/scanner.ts`,
 * `game/hostiles.ts`) rather than importing either: both pull in `Ship.ts`,
 * which pulls in `three` and the rest of the game, and the audiotest
 * tsc-emits `sound.ts` standalone (see its own header) — the same reasoning
 * `game/session.ts` already gives for declaring structural types locally
 * rather than importing across that boundary. If either source constant
 * moves, this drifts silently; that trade is the price of the standalone
 * build and is `docs/todo.md`'s to watch, not this file's to solve.
 */
const PING = {
  /** `SCANNER.errorFar` — the ghost's own uncertainty ceiling, world units. */
  errorFar: 26,
  /** Minimum gap between two pings, seconds — several contacts can paint in
   *  one frame and a chorus of pips is not information, it is noise. */
  rate: 0.09,
  duckDb: 3,
  duckSeconds: 0.12,
} as const;

/**
 * `CloakSpec.wind` — the Shroud always winds up for 0.45s before its first
 * bolt. See `PING`'s own docblock for why this is a mirrored constant
 * rather than an import.
 */
const CLOAK_WIND = 0.45;

/**
 * Mirrors `game/hostiles.ts`'s own `HostileKind` — a structural copy rather
 * than an `import type`, for the same reason `PING` above is a mirrored
 * constant and `game/session.ts` declares its own `Rock` locally: the
 * audiotest tsc-emits `sound.ts` standalone (see this file's own header),
 * and `hostiles.ts` pulls in `three` and the rest of the game. A type-only
 * import erases at build time in the browser bundle, but the audiotest's
 * emit list would still need `hostiles.ts` resolvable to typecheck it, which
 * is the whole thing this mirror avoids. If the source union ever grows a
 * class, this drifts silently — the same trade `PING`'s docblock already
 * accepts, and `docs/todo.md`'s to watch.
 */
type HostileKind = "swarmer" | "sniper" | "brawler" | "miner" | "stalker";

/**
 * Mirrors `game/Ship.ts`'s own `ShieldFacing` — a structural copy rather than
 * an `import type`, for the same reason `HostileKind` above is: the
 * audiotest tsc-emits `sound.ts` standalone, and `Ship.ts` pulls in `three`
 * and the rest of the game.
 */
type ShieldFacing = "fore" | "starboard" | "aft" | "port";

/**
 * The commander's guard, heard rather than only seen: every class's own fire
 * pitched six percent low. Matches the radio signature a later task gives
 * the guard's own voice, so the two land as the same idea in two mediums.
 */
const GUARD_PITCH = 0.94;

/**
 * The scanner's ping's own pitch. 1650 Hz sits in the gap between the
 * bank's two other high voices rather than inside either: the phaser's own
 * downsweep (`phaser`, below — 1900–2260 Hz falling to a 700 Hz floor)
 * only passes through 1650 Hz for a few milliseconds per shot and never
 * rests there, and the radio's telephone band (`speak`, `Synth.ts` —
 * 300–3400 Hz) leaves it well clear of the 3400 Hz top edge, where a
 * transmitted voice's own sibilance and the band's own rolloff already
 * crowd. A pip at 1650 Hz reads against both without living inside either.
 */
const PING_FREQ = 1650;

/**
 * The reactor bed. `docs/audio-prior-art.md` §6.1: two oscillators a few
 * tenths of a Hz apart near 58 Hz, lowpass 300-500 Hz with a slow LFO,
 * present from run start — the machine under everything else, mapped to the
 * one pool that pays for it.
 */
const REACTOR_BASE = 58;
/** ~0.4 Hz beat at `REACTOR_BASE` — the second oscillator's ratio. */
const REACTOR_RATIO = 1.0069;
/** The breathing LFO's own rate. Slow enough to read as respiration, not tremolo. */
const REACTOR_LFO_RATE = 0.08;
/**
 * Depth is the only per-frame roughness knob `Bed.set` exposes — `q` is fixed
 * at construction — so hull damage is expressed here instead: a shallow
 * breath at full hull, a rough one near death. Both stay well under the
 * 0.5 ceiling `Bed.set` itself clamps to.
 */
const REACTOR_LFO_DEPTH = 0.08;
const REACTOR_HURT_DEPTH = 0.22;
/** How often the relay clicks while the reserve is starved. */
const REACTOR_TICK_INTERVAL = 1.4;

/** A major arpeggio, extended: the tally climbs this as the multiplier grows. */
const ARPEGGIO = [0, 4, 7, 12, 16, 19, 24];
/** The four service stages, as a plain rising figure. */
const SERVICE_NOTES = [523.25, 659.25, 783.99, 987.77];

/**
 * The multiplier family's own scale — semitones over a root. `deposit`
 * (`kill`'s own note), `multiplierTick`, `salvageTransfer` and `tally` all
 * read pitches off this one array rather than each choosing frequencies
 * independently, so a kill landing, the HUD ticking, salvage crossing at the
 * dock and the tally's own arpeggio are audibly the same idea told in four
 * registers — the whole point of Task 10 — rather than four sounds that
 * happen to share a subject. `ARPEGGIO` above is this shape again, extended
 * with the octave-up repeats (16, 19, 24 = 4, 7, 12 plus an octave) that let
 * the tally alone keep climbing past four notes.
 */
const MOTIF = [0, 4, 7, 12] as const;

/** `MOTIF[degree]` semitones above `root`, in Hz. `degree` is an index into
 *  `MOTIF` (0..3), not a semitone count — callers cap their own index with
 *  `Math.min(3, …)` before calling this, the same way `ARPEGGIO`'s own
 *  index never runs past its length. */
function motifHz(root: number, degree: number): number {
  return root * Math.pow(2, MOTIF[degree] / 12);
}

/**
 * The multiplier family's own root and levels. `deposit` is the loudest —
 * it fires on every paid kill, so it has to read as a mark on the ledger
 * without being a distraction — `multiplierTick` is `Sound`'s own docblock
 * calls "the same family, quieter" at half that, and `salvageTransfer`
 * (docking's own single crossing, not a per-frame event) sits close to the
 * deposit's own level since it happens once a dock rather than once a kill.
 */
const MOTIF_ROOT = 220;
const DEPOSIT_LEVEL = 0.09;

/**
 * The A-N radio range (Phase C), 1930s aviation's own course guidance: two
 * overlapping legs broadcast a Morse "A" (di-dah) or "N" (dah-di) off the
 * beam and interlock into one steady tone exactly on it. 700 Hz is close to
 * the historical range's own tone; the rest are this bank's own timing.
 */
const APPROACH = {
  freq: 700,
  /** Never more than one voice scheduled inside this window — `approach`'s own rate gate. */
  rate: 0.35,
  level: 0.05,
  dot: 0.09,
  dash: 0.24,
  gap: 0.04,
  /** Longer than `rate`: retriggering the on-course note every `rate`
   *  seconds still overlaps the tail of the last one, so it reads as one
   *  held tone rather than a series of blips. */
  onCourseHold: 0.4,
} as const;

/**
 * The one level the alert ever uses, in any condition, at any urgency.
 *
 * This is the CHI 2024 contract made literal: escalation is spectral, so there
 * is a single number here and nothing is allowed to scale it. It is the figure
 * the old yellow beat used, because a bare fundamental is what the new beat is
 * at its plainest — red's louder figure only ever existed to buy urgency, and
 * urgency now comes from `AlertPulse.components`.
 */
const ALERT_LEVEL = 0.075;
/**
 * A minor second above the fundamental. Below 500 Hz one critical band is about
 * 100 Hz wide, so at the alert's register a semitone is comfortably inside it —
 * this is genuine roughness rather than the cultural kind.
 */
const ALERT_SECOND = 1.06;
/**
 * The top tier, written as sidebands rather than as a modulator. Amplitude
 * modulation of a carrier at `rate` *is* a pair of partials at ±rate, so this
 * needs no new voice type and stays inside the two-voice vocabulary. 40 Hz is
 * where Arnal's 2019 follow-up puts peak aversion; the depth is a guess between
 * "15% is tense" and "100% is a klaxon nobody tolerates for ten seconds".
 */
const ALERT_AM_RATE = 40;
const ALERT_AM_DEPTH = 0.35;
/**
 * Patterson: flight-deck warnings that went from off to full in under 10 ms
 * triggered a startle reflex, and startled responses "often prove incorrect".
 * A warning that makes the player flinch makes them fly worse, which is not
 * the same thing as making them nervous.
 */
const ALERT_RISE = 0.02;

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export class Sound {
  /**
   * @internal Public rather than private so the audiotest's duck assertion,
   * and later tasks that need the bench itself rather than a cue
   * (`sound.synth.setSpace(...)`, the radio's `Radio` construction), can
   * reach it. Not for game code — every real call site goes through a named
   * cue on `Sound`.
   */
  readonly synth = new Synth();
  /** The one channel three parties share. See `radio.ts`'s own header. */
  readonly radio = new Radio(this.synth);
  private alert: Bed | null = null;
  private engine: Bed | null = null;
  private reactor: Bed | null = null;

  /**
   * Audio-clock time (`ctx.currentTime`) the relay tick last fired — never
   * the next-due time, and never reset just because `starved` went false for
   * a frame. `Ship.updateEnergy` skips the drain outright while starved
   * (`if (!this.starved) this.energy -= ...`) but always applies regen, so a
   * ship parked at the impulse floor genuinely oscillates in and out of
   * `starved` a few times a second — regen ticks it just above the floor,
   * the next frame's un-drained thrust (or simple regen settling) can tick
   * it back under. A reset-on-exit accumulator would fire on every one of
   * those re-entries and the tick's own 1.4 s cadence would collapse to a
   * buzz exactly during the sustained-starved moment it exists to mark.
   * A minimum-gap timer instead: while starved, tick only once
   * `REACTOR_TICK_INTERVAL` has actually elapsed since the last one, flicker
   * or not. Reset only on `silence()` — a new run, or the title screen —
   * never merely on `starved` clearing.
   */
  private reactorTickAt = -Infinity;

  /**
   * True from the first `deathPower` call of a death until `panelRestore`
   * (the tally taking the panel back) or `silence()` clears it.
   *
   * `update()` is called every frame regardless of `Session.state` — see
   * `main.ts` — and its own `scene.alive` gate is what zeroes the engine and
   * reactor beds' *level* the instant a run ends, which happens well inside
   * `Bed`'s own 0.12s glide. Without this flag, that gate wins the same
   * frame `deathPower`'s own `Bed.power` scaling is trying to make audible:
   * `set()` (called from `update()`, after `deathPower()` in the frame
   * order `game/session.ts` keeps) always runs last and would overwrite
   * `power()`'s target with a flat 0 regardless of `DeathSequence.power`,
   * silencing the beds before the flicker ever reaches them. While this is
   * true, `update()` treats a dead-but-dying scene as if it were still
   * alive for the purposes of the engine/reactor *level* calculation, so the
   * beds keep their normal computed target and `powerScale` (already
   * multiplied in by `Bed.set`) is the only thing doing the dimming.
   * `game/session.ts` stops calling `deathPower` once the death sequence
   * reaches `"tally"` — the emergency-power readout has its own cue
   * (`panelRestore`) — so the ordinary `alive` gate resumes there exactly as
   * it always has, and beds fall silent for the tally the same way they did
   * before this flag existed.
   */
  private deathPowerActive = false;

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

  /** Audio-clock time (`ctx.currentTime`) the last ping actually sounded — `ping`'s own rate gate. */
  private lastPingAt = -Infinity;

  /** Audio-clock time the last mine tick actually sounded — `mineTick`'s own rate gate. */
  private lastMineTickAt = -Infinity;

  /** Audio-clock time the last approach note actually sounded — `approach`'s own rate gate. */
  private lastApproachAt = -Infinity;

  /**
   * The probe's own hook: when a ping last sounded and how rough it was.
   * `null` until the first one, same convention as every other "nothing has
   * happened yet" field in this file.
   */
  lastPing: { at: number; spread: number } | null = null;

  /**
   * The probe's own hook onto `lanceCharge`, mirroring `lastPing`: the
   * audio-clock time the Lance's charge tell last actually sounded (past
   * the out-of-earshot floor, so this only fires when the cue really did).
   * `null` until the first one. What a playtest checks the fire-gate fix
   * against — `game/hostiles.ts`'s own `chargedAt` is the source of truth
   * for *why* the gate holds, this is only proof the cue itself sounded.
   */
  lastLanceCharge: { at: number } | null = null;

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
    if (!this.reactor) {
      this.reactor = this.synth.bed({
        kind: "tone",
        wave: "sawtooth",
        filter: "lowpass",
        q: 1.2,
        ratio: REACTOR_RATIO,
      });
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
   * The one call every party's chatter routes through — see `radio.ts`'s own
   * header for what the channel is for. `x`/`z` place the voice the way
   * every other placed cue does, through `place`'s own pan; omit them for a
   * voice with nowhere in particular to be placed — HQ, speaking from
   * outside the sector, the way `dispatch`'s own panel cue already does
   * centred.
   *
   * Guarded two ways, deliberately not the same way `play`/`speak`
   * themselves are guarded (their own no-op-on-no-rig is inside `Synth`,
   * after their own bookkeeping already ran; `Radio.say`'s bookkeeping runs
   * *before* it ever calls into `Synth`, so it has to be kept from running
   * at all when there is nothing to schedule against):
   *
   * `!this.synth.live` returns before `Radio.say` is even called — during
   * attract mode, or before the first gesture, `now` would otherwise fall
   * back to 0 (no real audio clock to read), and `Radio`'s `busyUntil` would
   * book a party busy against that fictitious "0" rather than skip the
   * update — a timestamp that then outlives the moment (the `Synth`/`Radio`
   * pair is never rebuilt between runs) and can make a fresh run's first
   * real `say` for that party read as still-busy against a channel nothing
   * has actually spoken on yet.
   *
   * The try/catch is the second guard, for a different failure: unlike
   * every other cue here, this one calls into `radio.ts` — pure logic
   * (`composePhrase`, the priority bookkeeping) that runs *before* anything
   * reaches `Synth`'s own never-throw methods, so it sits outside the
   * contract `Synth.ts`'s header promises. `dispatch`/`allyHail`/`allyComms`/
   * `allyLost` now all call this first, ahead of the sound they already made
   * — a throw here must not also take the rest of the cue, or the frame
   * loop, down with it. Retires the layer exactly the way `play` and
   * `speak` themselves would on their own internal failure.
   */
  say(party: Party, event: RadioEvent, opts: { x?: number; z?: number; doctrine?: Doctrine; guard?: boolean } = {}): void {
    if (!this.synth.live) return;
    try {
      const positioned = opts.x !== undefined && opts.z !== undefined ? this.place(opts.x, opts.z) : null;
      const now = this.synth.context?.ctx.currentTime ?? 0;
      this.radio.say(party, event, {
        doctrine: opts.doctrine,
        guard: opts.guard,
        pan: positioned?.pan,
        level: positioned?.level,
        now,
        rng: Math.random,
      });
    } catch (error) {
      this.synth.fail(error);
    }
  }

  /**
   * The two continuous readouts. Both are levels rather than events, so this is
   * called every frame with the state and nothing is scheduled.
   */
  update(scene: SoundScene): void {
    const pressure = clamp(scene.threat / FULL_THREAT, 0, 1);
    const hurt = 1 - clamp(scene.hull, 0, 1);
    // The death sequence's own hold on the engine/reactor gate — see
    // `deathPowerActive`'s own docblock for why `scene.alive` alone cannot
    // be trusted to decide these two beds' level while a death is dimming
    // them on purpose.
    const dying = this.deathPowerActive;

    // The alert used to be a sustained bed riding threat. It is now a pulse —
    // see `alertBeat`, and `AlertPulse` for why — so this bed is held at
    // silence rather than removed: the machinery is one voice, and the
    // reactor bed below is exactly the sustained layer this one was left in
    // place for.
    this.alert?.set(0, 42 + pressure * 9, 170 + hurt * 220, 0, 0);

    // Engine. Under thrust it opens up; moored it is off, because a ship in the
    // clamps is a ship with its drive shut down.
    const moving = clamp(scene.speed / 62, 0, 1);
    this.engine?.set(
      (scene.alive || dying) && !scene.docked ? 0.028 + scene.thrust * 0.075 + moving * 0.022 : 0,
      0,
      150 + scene.thrust * 430 + moving * 240,
      0,
      0,
    );

    // The reactor. Present under everything else from the moment a run goes
    // live, never removed the way the alert bed's drone was — this is the one
    // sustained voice `docs/audio-prior-art.md` §6.1 actually asks to be a
    // bed. Docked, the drive is shut down the same way the engine's is, but a
    // moored hull still has station power feeding it, so it idles rather than
    // going fully silent.
    const reactorLevel = scene.alive || dying ? (scene.docked ? 0.02 : 0.05) : 0;
    // Droop only below a quarter reserve, continuous at the boundary
    // (0.5 + 2×0.25 = 1); starved overrides it outright rather than merely
    // extending the same curve to zero, because a starved reserve is a
    // distinct condition, not just a lower number.
    const droop = scene.energy < 0.25 ? 0.5 + 2 * scene.energy : 1;
    const pitchMul = scene.starved ? 0.5 : droop;
    const cutoff = 220 + scene.energy * 260;
    const depth = REACTOR_LFO_DEPTH + hurt * REACTOR_HURT_DEPTH;
    this.reactor?.set(reactorLevel, REACTOR_BASE * pitchMul, cutoff, REACTOR_LFO_RATE, depth);

    // The relay tick. A sparse click rather than an alarm — starved is
    // already said by the pitch drop, this only marks time while it lasts.
    // Scheduled off the audio clock so hit-stop and frame stutter cannot
    // speed it up or stall it, the same reasoning `Bed.dip` uses. A
    // minimum-gap timer against the *last* tick, not a due-time accumulator
    // that resets on every un-starve — see `reactorTickAt`'s own docblock
    // for why a flickering `starved` would otherwise buzz this well past its
    // documented ~1.4 s cadence.
    if (scene.alive && scene.starved) {
      const now = this.synth.context?.ctx.currentTime;
      if (now !== undefined && now - this.reactorTickAt >= REACTOR_TICK_INTERVAL) {
        this.reactorTickAt = now;
        this.relayClick();
      }
    }
  }

  /**
   * A relay clicking against a dead or starved bus — a short, dry bandpassed
   * click on the panel bus, not `bed`: the bed bus's cap of 2 is already
   * spent on the engine and the reactor themselves, and this is a click *on
   * the panel*, the same instrument `dispatch` and `service` speak through,
   * not a third sustained voice. Two callers share the exact same recipe
   * rather than two similar ones: the reserve's own starved tick above, and
   * `relayTick` below — the drift's scripted blip, where emergency power
   * tries the bus once and fails the same way.
   */
  private relayClick(): void {
    this.synth.play({
      kind: "noise",
      bus: "panel",
      filter: "highpass",
      freq: 3200,
      q: 4,
      level: 0.08,
      attack: 0.001,
      decay: 0.03,
    });
  }

  /**
   * The drift's own scripted blip: `DeathSequence` briefly touches its power
   * back up to 0.3 once, about 1.15s into the drift, as if emergency power
   * tried the bus and failed. The session calls this exactly once, on the
   * transition into that window (`DeathSequence.blipped` going false→true) —
   * this method itself does no gating, since a one-shot instant is the
   * caller's own thing to detect, the same division `panelRestore`'s own
   * phase-transition call already keeps.
   */
  relayTick(): void {
    this.relayClick();
  }

  /**
   * Hit-stop's own reach into the sustained voices. A one-shot cue already
   * reads as an impact because it starts and stops; a bed just sits there
   * unless something marks the instant, so every bed this class owns gets a
   * brief dip — the beds' half of the same beat the game's own time
   * dilation is selling. Every bed I own, so a later one (the reactor bed)
   * only has to join this list.
   */
  hitStop(seconds: number): void {
    for (const bed of [this.alert, this.engine, this.reactor]) bed?.dip(seconds);
  }

  /**
   * The death sequence's own reach into the beds, called every frame with
   * `DeathSequence.power` (0..1) so the reactor dies exactly on the panel's
   * own flicker rather than as a separate cut. Every bed I own, the same
   * list `hitStop` already walks. Sets `deathPowerActive` — see that
   * field's own docblock for why `update()`'s ordinary `alive` gate has to
   * stand down while this is in force, and for why the caller
   * (`game/session.ts`) stops calling this once the death sequence reaches
   * `"tally"` rather than this method clearing the flag on its own.
   */
  deathPower(power: number): void {
    this.deathPowerActive = true;
    for (const bed of [this.alert, this.engine, this.reactor]) bed?.power(power);
  }

  /** A restart, a mode change, a death: whatever was ringing stops ringing. */
  silence(): void {
    this.synth.silence();
    // A new run (or the title screen) starts the relay tick's own clock
    // fresh rather than inheriting a `reactorTickAt` from whatever the last
    // run's reserve was doing when it ended. `lastPingAt` is the same
    // argument applied to `ping`'s own rate gate.
    this.reactorTickAt = -Infinity;
    this.lastPingAt = -Infinity;
    this.lastMineTickAt = -Infinity;
    this.lastApproachAt = -Infinity;
    this.deathPowerActive = false;
    this.radio.reset();
  }

  // ── weapons ──────────────────────────────────────────────────────────────

  /**
   * A zap, built to sfxr's Laser/Shoot recipe, which is the closest thing this
   * medium has to a written spec for the sound.
   *
   * Four things make it a zap rather than a beep, and only one of them is the
   * pitch. Zero attack. An **exponential** downsweep of a octave and a half.
   * A floor it reaches and **stops dead at**, because the hard stop is the
   * whole difference between a zap and a fade. And no noise layer at all —
   * the folk recipe is "falling tone plus noise burst" and the actual preset
   * has none, because grit in a laser is the waveform's own harmonics and
   * anything else just fills the band the alert pulse needs.
   *
   * The 0.16 s cooldown is still the constraint that binds, and this answers it
   * better than the sound it replaces: 60 ms total against a 160 ms repeat, so
   * two shots can never overlap or accumulate, and one voice per shot instead
   * of two. Alternating pitches is `EOR #$14` from the Asteroids ROM, lifted
   * straight; the small jitter on top is there because held fire at 6.25 Hz is
   * the one place a perfectly identical repeat stops reading as an event.
   *
   * @param hit   something took damage; the return down the beam says so.
   * @param reach fraction of full damage delivered, so the falloff rule the
   *              player cannot see is a thing they can hear. A shot at the far
   *              edge barely glides and cuts off early; point blank runs the
   *              full sweep down to the band limit.
   */
  phaser(hit: boolean, reach = 1): void {
    this.phaserFlip ^= 1;
    // A minor third apart. Wide enough to read as a machine cycling, narrow
    // enough that it never reads as two different weapons.
    const base = (this.phaserFlip ? 1900 : 2260) * (0.98 + Math.random() * 0.04);
    const landed = clamp(reach, 0, 1);
    // Two layers, one slot: the zap and its return blip are one shot, not two
    // competing events — the cap counts cues, no exceptions (owner's ruling).
    const g = this.synth.group();
    this.synth.play({
      bus: "weapon",
      group: g,
      wave: "square",
      freq: base,
      // The floor, and the floor is a hard rule rather than a consequence: the
      // reason phasers are allowed to be this frequent is that they never touch
      // the bass, where the alert pulse and the torpedo live.
      to: Math.max(700, base * (0.9 - 0.56 * landed)),
      level: 0.15,
      attack: 0.001,
      // Runs flat and then stops. The 12 ms is not a decay anyone hears as one;
      // it is the shortest ramp that ends a tone without a click.
      hold: 0.018 + 0.027 * landed,
      decay: 0.012,
    });
    if (hit) {
      // Something came back down the beam. A separate transient rather than a
      // louder shot: the CHI 2024 finding is that differentiating outcomes is
      // what earns its place and amplifying them is what costs.
      this.synth.play({
        kind: "noise",
        bus: "weapon",
        group: g,
        filter: "highpass",
        freq: 1900,
        level: 0.07,
        attack: 0.001,
        decay: 0.06,
        delay: 0.018,
      });
    }
  }

  /**
   * A rifle shell, where the phaser is a zap — opposed on every axis the
   * weapons themselves are opposed on. The phaser is instant, thin, pitched and
   * high; this is slow, broadband, percussive and low, and almost all of it
   * happens in the first ten milliseconds.
   *
   * Four layers fired on the same instant, which is §5's explosion stack with
   * the proportions of a report rather than a detonation: the punch, which is
   * sfxr's 1.8× on the first fifteen milliseconds and is the difference between
   * a crack and a whoosh; the crack itself, a highpass sweeping down through
   * the presence band; the body, a sine falling into the sub; and a short tail
   * that is the report leaving. Nothing here is a sample — a rifle crack out of
   * swept noise is the interesting half of the problem.
   *
   * This is the cue that most wanted the compressor gone. A crack is a peak,
   * not a loudness, and six milliseconds of lookahead is six milliseconds of
   * the only part of it that carries information.
   *
   * @param last the rack going empty, which is worth knowing without looking.
   */
  torpedo(last = false): void {
    // Four layers, one budget slot: the punch/crack/body/report fire on the
    // same instant as one report, not four competing events, so a busy
    // weapon bus never mutes the shot down to three layers of its own.
    const g = this.synth.group();
    // The punch. Ten milliseconds, and the loudest thing in the cue.
    this.synth.play({
      kind: "noise",
      bus: "weapon",
      group: g,
      filter: "highpass",
      freq: 3000,
      level: 0.3,
      attack: 0.0005,
      decay: 0.012,
    });
    // The crack, falling out of the presence band into the body.
    this.synth.play({
      kind: "noise",
      bus: "weapon",
      group: g,
      filter: "highpass",
      freq: 1700,
      to: 480,
      level: 0.26,
      attack: 0.001,
      decay: 0.055,
    });
    // The body. Under 120 Hz within a tenth of a second, which is the band
    // reserved for the alert, the torpedoes, the mines and the death.
    this.synth.play({
      bus: "weapon",
      group: g,
      wave: "sine",
      freq: 160,
      to: 46,
      level: 0.24,
      attack: 0.002,
      decay: 0.2,
    });
    // The report leaving. Short, because there is no room out here for it to
    // leave into and a long tail would read as an explosion instead.
    this.synth.play({
      kind: "noise",
      bus: "weapon",
      group: g,
      filter: "lowpass",
      q: 0.8,
      freq: 620,
      to: 150,
      level: 0.1,
      attack: 0.02,
      decay: 0.26,
    });
    if (!last) return;
    // Twelve of these exist and the twelfth should say so. A dry mechanical
    // tick behind the report — the rack finding nothing to load. Its own
    // event, on its own bus, so it is not part of the shot's group.
    this.synth.play({
      kind: "noise",
      bus: "panel",
      filter: "bandpass",
      q: 18,
      freq: 2600,
      level: 0.06,
      attack: 0.001,
      decay: 0.03,
      delay: 0.13,
    });
  }

  /**
   * Somebody else's trigger. Placed, so an ambush from astern says so.
   *
   * Each class gets a register of its own, so a firefight can be told apart
   * by ear before the reticle finds anything — the same "colour is
   * information" argument the palette makes, spent on band and rhythm
   * instead of hue. **Swarmer**: bright and thin, the top of the hostile
   * band, because "comes from anywhere" is the whole brief of the class and
   * a swarm has to cut through the mix on the first note. **Sniper**: a
   * narrow, low-index fm bite — a Lance's shot is a single precise thing,
   * not a burst. **Brawler**: the one class allowed two voices for one
   * budget slot (`group`), because it fires slowest (0.9s) and can afford
   * the extra layer — a lowpassed growl plus a tone that dips to 95 Hz,
   * briefly inside the sub-120 Hz band the alert, torpedo, mines and death
   * otherwise reserve; a transient graze, not a sustained claimant of it.
   * **Stalker** (and **miner**, which never actually fires —
   * `fireRange: 0` keeps the fire check itself from ever passing) fall
   * through to the original recipe unchanged, because `decloak`'s own
   * resolving tone matches this note for note — see that cue's docblock.
   *
   * @param kind  which class pulled the trigger.
   * @param guard the commander's own veteran of the class — see `GUARD_PITCH`.
   */
  hostileFire(x: number, z: number, kind: HostileKind = "stalker", guard = false): void {
    const { level, pan } = this.place(x, z);
    // Out of earshot is worth checking here rather than in the synth: a wave of
    // eight all firing at the rim would otherwise spend the whole voice pool on
    // sounds nobody can hear.
    if (level < 0.06) return;
    const mul = guard ? GUARD_PITCH : 1;
    // One slot regardless of how many layers the class spends it on.
    const g = this.synth.group();
    switch (kind) {
      case "swarmer":
        this.synth.play({
          bus: "hostile",
          group: g,
          wave: "square",
          freq: 1400 * mul,
          to: 900 * mul,
          level: 0.08 * level,
          attack: 0.002,
          decay: 0.07,
          pan,
        });
        break;
      case "sniper":
        this.synth.play({
          kind: "fm",
          bus: "hostile",
          group: g,
          ratio: 2.4,
          index: 1.2,
          freq: 700 * mul,
          to: 520 * mul,
          level: 0.1 * level,
          attack: 0.003,
          decay: 0.15,
          pan,
        });
        break;
      case "brawler":
        this.synth.play({
          kind: "noise",
          bus: "hostile",
          group: g,
          filter: "lowpass",
          freq: 380 * mul,
          to: 160 * mul,
          level: 0.12 * level,
          attack: 0.004,
          decay: 0.16,
          pan,
        });
        this.synth.play({
          bus: "hostile",
          group: g,
          wave: "sawtooth",
          // The floor: a transient dip into the reserved sub-120 Hz band, not
          // a sustained voice living in it — see the docblock above.
          freq: 140 * mul,
          to: 95 * mul,
          level: 0.09 * level,
          attack: 0.005,
          decay: 0.17,
          pan,
        });
        break;
      default:
        // stalker, and miner (dead code — it never reaches this call).
        this.synth.play({
          bus: "hostile",
          group: g,
          wave: "sawtooth",
          freq: 520 * mul,
          to: 300 * mul,
          level: 0.1 * level,
          attack: 0.003,
          decay: 0.13,
          pan,
        });
    }
  }

  /**
   * The Lance's own tell. `Hostile.update` calls this once per shot — a
   * rising resonant tone in the same register `hostileFire`'s own sniper
   * recipe lives in, run forward and slower, so the ear hears the shot
   * coming the way `decloak` already lets it hear the Shroud coming. The
   * shot itself is now gated on this having sounded at least `LANCE_LEAD`
   * (`game/hostiles.ts`) seconds ago — see `Hostile.chargedAt`'s own
   * docblock — so "0.35 s before" is only the *trigger* point, not a
   * guarantee this file can make on its own; the actual lead is the
   * caller's contract to keep.
   */
  lanceCharge(x: number, z: number): void {
    const { level, pan } = this.place(x, z);
    if (level < 0.06) return;
    const at = this.synth.context?.ctx.currentTime;
    if (at !== undefined) this.lastLanceCharge = { at };
    this.synth.play({
      bus: "hostile",
      wave: "sawtooth",
      freq: 420,
      to: 1100,
      level: 0.09 * level,
      attack: 0.02,
      decay: 0.32,
      pan,
    });
  }

  /**
   * A hostile clearing the fight rather than joining it. `hostileFire`'s own
   * shape, run backwards — rising instead of falling — because a departure
   * has to read as the opposite of a threat, not as a quieter version of one.
   */
  withdraw(x: number, z: number): void {
    const { level, pan } = this.place(x, z);
    if (level < 0.06) return;
    this.synth.play({
      bus: "hostile",
      wave: "sawtooth",
      freq: 300,
      to: 640,
      level: 0.09 * level,
      attack: 0.003,
      decay: 0.3,
      pan,
    });
  }

  /** A shot that went past, not into. Quieter than a hit, panned where it crossed. */
  nearMiss(x: number, z: number): void {
    const { level, pan } = this.place(x, z);
    if (level < 0.06) return;
    this.synth.play({
      kind: "noise",
      filter: "bandpass",
      q: 2.2,
      freq: 1900,
      to: 420,
      level: 0.12 * level,
      attack: 0.002,
      decay: 0.22,
      pan,
    });
  }

  // ── things landing ───────────────────────────────────────────────────────

  /** A torpedo on a hull that survives it. */
  impact(x: number, z: number): void {
    const { level, pan } = this.place(x, z);
    const g = this.synth.group();
    this.synth.play({
      kind: "noise",
      group: g,
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
      group: g,
      wave: "triangle",
      freq: 150,
      to: 70,
      level: 0.16 * level,
      attack: 0.003,
      decay: 0.24,
      pan,
    });
  }

  /** Hull on rock. A knock, not a weapon: low, dry, placed at the contact. */
  thud(x: number, z: number): void {
    const { level, pan } = this.place(x, z);
    if (level < 0.06) return;
    const g = this.synth.group();
    this.synth.play({
      kind: "noise",
      group: g,
      filter: "lowpass",
      freq: 420,
      to: 160,
      level: 0.18 * level,
      attack: 0.002,
      decay: 0.16,
      pan,
    });
    this.synth.play({
      group: g,
      wave: "triangle",
      freq: 90,
      to: 55,
      level: 0.14 * level,
      attack: 0.003,
      decay: 0.2,
      pan,
    });
  }

  /**
   * @param size       relative to a Raider; a Bastion is worth more air than a Raider.
   * @param multiplier the run's multiplier *after* this kill's own increment —
   *   `deposit`'s own note, so a paid kill audibly points at the dock. `null`
   *   (the default) for a kill that pays the player nothing — `destroyByAlly`,
   *   the Warden's own kills — since a deposit note over an event that credits
   *   no salvage would say something false. See `deposit`'s own docblock.
   */
  kill(x: number, z: number, size: number, multiplier: number | null = null): void {
    const { level, pan } = this.place(x, z);
    // Three layers, one slot — the cap counts cues, no exceptions (owner's
    // ruling). A kill's own body/crack layers stay together the same way a
    // kill burst or a mine chain now stays correctly bounded by how many
    // *kills* the impact bus can carry, not how many oscillators.
    const g = this.synth.group();
    this.synth.play({
      kind: "noise",
      group: g,
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
      group: g,
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
      group: g,
      filter: "highpass",
      freq: 3000,
      level: 0.13 * level,
      attack: 0.001,
      decay: 0.07,
      pan,
    });
    if (multiplier !== null) this.deposit(multiplier);
  }

  /**
   * The deposit: one short tone on the shared `MOTIF`, landing every time a
   * kill actually pays. Its own voice on the `panel` bus, deliberately
   * outside `kill`'s own group — that group is the blast, on `impact`; this
   * is the ledger, on a different bus entirely, and it gets its own slot
   * (panel's cap is 2) rather than riding along inside the blast's one.
   *
   * The degree climbs with the multiplier itself, capped at `MOTIF`'s own
   * top degree — a kill at 1x and one at 3x land on recognisably different
   * notes, the same "a bigger bank is audibly bigger" idea `tally` already
   * carries, told here at the scale of a single kill instead of a whole
   * run. `MOTIF` only has four degrees against a multiplier that runs to
   * 9.9, so every kill from 4x on plays the family's own top note — a
   * ceiling, not a bug: `deposit` only has to say "this kill just moved the
   * needle," not stand in for the HUD's own exact reading, and the run's
   * own top-heavy tail is already the range `tally`'s note count keeps
   * climbing through.
   */
  private deposit(multiplier: number): void {
    const degree = Math.min(3, Math.floor(multiplier));
    this.synth.play({
      bus: "panel",
      wave: "triangle",
      freq: motifHz(MOTIF_ROOT, degree),
      level: DEPOSIT_LEVEL,
      attack: 0.003,
      decay: 0.14,
    });
  }

  /**
   * The same note family as `deposit`, at half its level — the HUD's own
   * multiplier changing for a reason *other* than a paid kill.
   *
   * Deliberately unwired from every kill site: `destroy` and
   * `destroySpinner` both already ring through `kill`'s own `deposit`
   * (called with the post-kill multiplier), so calling this there too would
   * be two panel voices for one event, and the brief's own ruling is that
   * one is enough. The residual case this method exists for — a multiplier
   * change that is neither a kill nor already voiced elsewhere — currently
   * has no caller: hyperwarp arrival's own halving already has
   * `hyperwarpArrive`, and a breach already has `multiplierHalved`. Kept as
   * a defined, tested register rather than deleted, the same way
   * `relayTick` stood ready before `DeathSequence`'s own blip needed it —
   * see this file's own §16 selftest for proof it works on its own terms.
   */
  multiplierTick(multiplier: number): void {
    const degree = Math.min(3, Math.floor(multiplier));
    this.synth.play({
      bus: "panel",
      wave: "triangle",
      freq: motifHz(MOTIF_ROOT, degree),
      level: DEPOSIT_LEVEL * 0.5,
      attack: 0.003,
      decay: 0.14,
    });
  }

  /**
   * Absorbed by a facing: metallic and ringing, and deliberately not
   * alarming.
   *
   * Pan says which facing took it, not where the bolt came from: fore and
   * aft are both centred (the ring has no left/right along the player's own
   * axis), starboard and port pan hard to their own side. `place`'s own pan
   * is deliberately not used — only its level, for the falloff — because a
   * bolt from dead astern that struck the aft facing would otherwise pan
   * centre by fact of range, agreeing with the facing by coincidence rather
   * than by construction. The facing is the information the player needs
   * (which quarter to turn), not the bolt's incidental world position.
   * Pitch drops astern the same way: fore rings brightest (640 Hz), the two
   * sides sit a third down (560), aft is the lowest (480) — the register a
   * hit already reads as "behind you" through even before the pan lands.
   *
   * `remaining` — the facing's own strength *after* this hit, 0..1 — scales
   * the `fm` ring's own index: a facing still near full rings clean (index
   * up to 4, the original recipe's own decay), a nearly spent one is mostly
   * transient (index down to 0.8, and a shorter decay) — thinner, more
   * click, so the ear can tell "that quarter is nearly gone" before the HUD
   * dial says so.
   */
  shieldHit(x: number, z: number, facing: ShieldFacing, remaining: number): void {
    const { level } = this.place(x, z, 0.35);
    const pan = (facing === "starboard" ? 1 : facing === "port" ? -1 : 0) * 0.6;
    const freq = facing === "fore" ? 640 : facing === "aft" ? 480 : 560;
    const r = clamp(remaining, 0, 1);
    const index = 0.8 + r * 3.2;
    const decay = 0.06 + r * 0.07;
    const g = this.synth.group();
    this.synth.play({
      kind: "fm",
      group: g,
      ratio: 2.01,
      index,
      freq,
      to: freq * 0.672,
      level: 0.1 * level,
      attack: 0.002,
      decay,
      pan,
    });
    this.synth.play({
      kind: "noise",
      group: g,
      filter: "bandpass",
      q: 9,
      freq: 1500,
      level: 0.09 * level,
      attack: 0.002,
      decay: 0.1 + r * 0.08,
      pan,
    });
  }

  /**
   * A channel opening from HQ.
   *
   * Two quick clicks and a flat tone — a carrier being keyed, not a melody. It
   * has to cut through a firefight while saying "read something", which is a
   * different job from every other cue here: it must not sound like a threat, a
   * reward, or the Warden.
   *
   * Deliberately *not* `allyHail`'s rising fifth. That is the one piece of good
   * news the game has and it belongs to the Warden turning up; HQ is a voice on
   * the radio and sometimes what it says is that you are losing. Flat and dry
   * keeps the sentence itself carrying the meaning.
   */
  dispatch(): void {
    // The preamble: `ours` on the one shared channel, before the flat tone
    // below carries the line itself — a transmission opening, not a beep.
    this.say("ours", "dispatch");
    // Three layers, one slot — the panel bus's cap of 2 would otherwise mute
    // the flat tone that carries the cue's own meaning.
    const g = this.synth.group();
    for (const delay of [0, 0.07]) {
      this.synth.play({
        kind: "noise",
        bus: "panel",
        group: g,
        filter: "bandpass",
        q: 16,
        freq: 2050,
        level: 0.045,
        attack: 0.001,
        decay: 0.03,
        delay,
      });
    }
    this.synth.play({
      bus: "panel",
      group: g,
      wave: "sine",
      freq: 660,
      level: 0.05,
      attack: 0.01,
      decay: 0.18,
      delay: 0.15,
    });
  }

  /**
   * Strip and stack. Three facings collapsing into one, so it is two motions in
   * opposite directions: a sweep down as they are emptied and a note up as the
   * bow takes the charge.
   *
   * On the panel bus rather than in the world, because this is the ship doing
   * something to itself and not an event out there — the same reasoning that puts
   * `scram` there. And short, hard, un-triumphant: this is not a power-up, it is
   * a decision with three empty quarters behind it.
   */
  brace(): void {
    const g = this.synth.group();
    // Down: the facings being stripped. Bandpass rather than lowpass so it reads
    // as charge being moved through something rather than as a filter closing.
    this.synth.play({
      kind: "noise",
      bus: "mechanism",
      group: g,
      filter: "bandpass",
      q: 4,
      freq: 2600,
      to: 520,
      level: 0.1,
      attack: 0.004,
      decay: 0.2,
    });
    // Up, and landing on a fifth — the only interval in the bank that resolves,
    // because the one thing this sound has to say is that it worked.
    this.synth.play({
      bus: "mechanism",
      group: g,
      wave: "square",
      freq: 220,
      to: 330,
      level: 0.07,
      attack: 0.008,
      decay: 0.22,
      delay: 0.06,
    });
  }

  /**
   * Something reached the hull — the roughest sound in the bank. Two plain
   * tones a 70 Hz beat apart (90 and 160 Hz), on the impact bus, at high
   * level: not a swept noise burst but two things fighting each other in the
   * same breath, which is what a hull actually taking a hit sounds like
   * against every other cue here's single falling sweep. `multiplierHalved`
   * is the second half of the old single cue, split out because it is a
   * different event wearing the same instant: the blow is the hull, the
   * falling figure is the money leaving, and Task 10's shared `MOTIF` needs
   * the second half addressable on its own.
   */
  breach(): void {
    const g = this.synth.group();
    this.synth.play({ group: g, wave: "sine", freq: 90, level: 0.4, attack: 0.003, decay: 0.4 });
    this.synth.play({ group: g, wave: "sine", freq: 160, level: 0.32, attack: 0.003, decay: 0.4 });
  }

  /**
   * The money leaving. A falling two-note figure on the panel bus — the
   * multiplier family's own "loss" register — re-rooted onto `MOTIF`:
   * `motifHz(220, 2) × 2` (659.26 Hz) into `motifHz(220, 3)` (440 Hz), a
   * descending fourth. Before this task these were the hardcoded 660→440
   * Hz that shipped with Task 9; chosen deliberately to land within a
   * quarter percent of the old pair (659.26 vs 660) rather than picking
   * fresh pitches, so the re-rooting is inaudible on its own and only shows
   * up where it is supposed to — the §16 "four registers agree" test —
   * instead of also being a retune nobody asked for.
   */
  multiplierHalved(): void {
    const g = this.synth.group();
    this.synth.play({ bus: "panel", group: g, wave: "square", freq: motifHz(MOTIF_ROOT, 2) * 2, level: 0.07, decay: 0.16 });
    this.synth.play({
      bus: "panel",
      group: g,
      wave: "square",
      freq: motifHz(MOTIF_ROOT, 3),
      level: 0.07,
      decay: 0.2,
      delay: 0.15,
    });
  }

  mineBlast(x: number, z: number): void {
    const { level, pan } = this.place(x, z);
    const g = this.synth.group();
    this.synth.play({
      kind: "noise",
      bus: "hostile",
      group: g,
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
      bus: "hostile",
      group: g,
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
      bus: "hostile",
      wave: "triangle",
      freq: 880,
      to: 700,
      level: 0.05 * level,
      attack: 0.001,
      decay: 0.045,
      pan,
    });
  }

  /**
   * A mine going live. `mineLay`'s own click happens once, on the drop;
   * this happens once per mine, on the `armed` transition (`Minefield.update`
   * calls it only then, never every frame) — a field accumulates over a
   * whole run, so the two have to be told apart the way the eye already
   * tells them apart on the deck: `mineLay`'s triangle falling versus a
   * short, dry bandpassed click here.
   */
  mineArm(x: number, z: number): void {
    const { level, pan } = this.place(x, z);
    if (level < 0.06) return;
    this.synth.play({
      kind: "noise",
      bus: "hostile",
      filter: "bandpass",
      q: 8,
      freq: 3000,
      level: 0.05 * level,
      attack: 0.001,
      decay: 0.012,
      pan,
    });
  }

  /**
   * The field's own pulse. `Minefield.update` calls this every frame for
   * whichever armed mine is nearest, inside `MINE.trigger × 4` — the caller
   * does no gating of its own, because the interval that turns a
   * once-a-frame call into an actual pulse only makes sense read off the
   * audio clock, the same reasoning `ping`'s own rate gate and the reactor's
   * relay tick already give. `near` (0 at the outer edge, 1 at the mine
   * itself) sets that interval: `0.9 − 0.75 × near` seconds, so a mine at
   * the edge of the check radius ticks lazily and one you are about to hit
   * ticks nearly seven times as fast — the wink rate `Minefield.draw`
   * already uses, given a second channel.
   *
   * @param near 0..1, how close the nearest armed mine is within the check radius.
   */
  mineTick(x: number, z: number, near: number): void {
    const now = this.synth.context?.ctx.currentTime;
    if (now === undefined) return;
    const interval = 0.9 - 0.75 * clamp(near, 0, 1);
    if (now - this.lastMineTickAt < interval) return;
    this.lastMineTickAt = now;

    const { level, pan } = this.place(x, z);
    if (level < 0.06) return;
    this.synth.play({
      bus: "hostile",
      wave: "sine",
      freq: 2400,
      level: 0.04 * level,
      attack: 0.001,
      decay: 0.008,
      pan,
    });
  }

  // ── the Loom ─────────────────────────────────────────────────────────────

  /**
   * The Loom opening.
   *
   * It has to be identifiable as *machinery* inside half a second, because
   * nothing on the forward view says what has just happened — the two spinners
   * are 138 units out and the first strand is a thread. So the vocabulary is the
   * one nothing else uses: a low fifth held between two sawtooths, which is a
   * motor rather than a voice, under a resonant band opening upward. It is the
   * hyperwarp charge's *shape* — width rather than level, per
   * `audio-prior-art.md` §6 — turned into something being started rather than
   * something being spun up, which is the closest relative it has in this bank
   * and the right family for a thing that is going to run on a clock.
   *
   * Centred and unplaced in effect, because it opens around you rather than
   * somewhere: the ring is drawn on where you are standing.
   */
  loomOpen(x: number, z: number): void {
    const at = this.place(x, z, 0.7);
    const g = this.synth.group();
    for (const [freq, level] of [
      [62, 0.11],
      [93, 0.07],
    ] as const) {
      this.synth.play({
        group: g,
        wave: "sawtooth",
        freq,
        to: freq * 1.06,
        level: level * at.level,
        attack: 0.18,
        hold: 0.5,
        decay: 0.7,
        pan: at.pan,
      });
    }
    this.synth.play({
      kind: "noise",
      group: g,
      filter: "bandpass",
      q: 7,
      freq: 260,
      to: 2400,
      level: 0.06 * at.level,
      attack: 0.3,
      hold: 0.3,
      decay: 0.6,
      pan: at.pan,
    });
  }

  /**
   * One filament going down. A wire being plucked and immediately damped: the
   * tightest band in the bank, at twelve milliseconds.
   *
   * It fires roughly one and a half times a second for eighteen seconds, which
   * is exactly the rate at which a cue stops being an event and starts being a
   * texture — so it is very quiet, very short, and gated by distance the way
   * `mineLay` is. The point of it is not the individual tick. It is that the
   * pulse gets no faster and no slower for the whole weave, which is what a
   * clock sounds like.
   */
  loomStrand(x: number, z: number): void {
    const { level, pan } = this.place(x, z);
    if (level < 0.08) return;
    this.synth.play({
      kind: "noise",
      filter: "bandpass",
      q: 22,
      freq: 1450,
      to: 1180,
      level: 0.055 * level,
      attack: 0.001,
      decay: 0.012,
      pan,
    });
  }

  /**
   * The ring closing. The one moment in the encounter that is bad news, and it
   * is told the way the game tells bad news everywhere else: something falls.
   *
   * Unplaced and centred, because a boundary that has closed has closed in every
   * direction and there is nothing to turn toward. Deliberately not a klaxon —
   * the alert already owns that shape, and this is not a condition change, it is
   * a door.
   */
  loomSeal(): void {
    const g = this.synth.group();
    this.synth.play({
      kind: "noise",
      bus: "impact",
      group: g,
      filter: "lowpass",
      q: 0.8,
      freq: 900,
      to: 70,
      level: 0.24,
      attack: 0.003,
      decay: 0.55,
    });
    for (const [freq, delay] of [
      [110, 0],
      [73.4, 0.16],
    ] as const) {
      this.synth.play({
        bus: "panel",
        group: g,
        wave: "sawtooth",
        freq,
        to: freq * 0.94,
        level: 0.09,
        attack: 0.01,
        hold: 0.06,
        decay: delay > 0 ? 0.6 : 0.22,
        delay,
      });
    }
  }

  /** Brushing a filament. A wire against a hull: harsh, brief, and placed. */
  loomTouch(x: number, z: number): void {
    const { level, pan } = this.place(x, z, 0.25);
    const g = this.synth.group();
    this.synth.play({
      kind: "noise",
      group: g,
      filter: "bandpass",
      q: 11,
      freq: 2100,
      to: 620,
      level: 0.16 * level,
      attack: 0.001,
      decay: 0.13,
      pan,
    });
    this.synth.play({
      group: g,
      wave: "sawtooth",
      freq: 240,
      to: 130,
      level: 0.11 * level,
      attack: 0.002,
      decay: 0.16,
      pan,
    });
  }

  /**
   * The weave failing — the motor losing the room, and the whole fence going
   * down with it. `loomOpen` played backwards in every axis that matters: the
   * fifth collapses to a unison instead of holding, the band shuts instead of
   * opening, and it is the length of the wall's own fall rather than of a
   * gesture.
   */
  loomCollapse(x: number, z: number): void {
    const at = this.place(x, z, 0.55);
    const g = this.synth.group();
    for (const [freq, level] of [
      [93, 0.09],
      [62, 0.1],
    ] as const) {
      this.synth.play({
        group: g,
        wave: "sawtooth",
        freq,
        to: 34,
        level: level * at.level,
        attack: 0.01,
        hold: 0.2,
        decay: 1.1,
        pan: at.pan,
      });
    }
    this.synth.play({
      kind: "noise",
      group: g,
      filter: "bandpass",
      q: 5,
      freq: 2200,
      to: 180,
      level: 0.09 * at.level,
      attack: 0.02,
      decay: 1.2,
      pan: at.pan,
    });
  }

  // ── the scanner, heard ───────────────────────────────────────────────────

  /**
   * The tube's own arm, given a voice. `ScannerModel.update`
   * (`hud/scanner.ts`) records every paint it makes this frame — resolved or
   * not — and `main.ts` drains that list into this method right after
   * `drawHud`, so a contact crossing the sweep is now an event in both
   * senses at once. Reading the tube is a skill under pressure; hearing it
   * confirm what you just saw (or warn you before you looked) is the same
   * instrument doing its job through a second channel.
   *
   * Two `tone` voices rather than one, detuned by `spread` — the beating
   * vocabulary this file used to reserve for the Shroud alone (see the file
   * header) — because a paint's own roughness *is* the ghost's own drawn
   * uncertainty: a resolved contact (`spread === 0`) is a clean unison, a
   * return painted at the rim is a rough ~3% beat you cannot mistake for one
   * note. `spread` is read raw off the paint rather than reprojected, since
   * `ScannerModel` already computed the exact number the ring on the tube is
   * drawn with — recomputing it here would just be a second, riskier copy
   * of `paintGhost`'s own arithmetic.
   *
   * Rate-limited to `PING.rate` — several contacts can cross the arm in the
   * same frame, and a chorus of pips is not information — and it ducks the
   * weapon bus (Task 1's `duck`), because a busy phaser exchange is exactly
   * when a fresh, unresolved return is most worth not burying.
   *
   * @param bearing the scanner's own convention (`atan2(forward, right)` —
   *   see `ScannerModel.update`), read straight off the paint rather than
   *   projected through `place`: a paint already carries where it is
   *   relative to the ship, not a world position to re-derive that from.
   * @param range   world units from the ship. Falloff matches `place`'s own.
   * @param spread  the ghost's own drawn radius, world units; 0 resolved.
   */
  ping(bearing: number, range: number, spread: number): void {
    const now = this.synth.context?.ctx.currentTime;
    if (now === undefined || now - this.lastPingAt < PING.rate) return;
    this.lastPingAt = now;
    this.lastPing = { at: now, spread };

    const level = this.levelForRange(range);
    // Scanner bearing: right is 0, ahead is π/2 (`ScannerModel.update`'s own
    // `atan2(forward, right)`), which is exactly `place`'s own `right`
    // component read as `cos(bearing)` instead of re-derived from a
    // position — the same axes, the paint already in them.
    const pan = clamp(Math.cos(bearing), -1, 1) * PAN_WIDTH;
    // Rough when wide, unison at or under `spread: 2` (the ghost's own
    // floor) — see the docblock above.
    const detune = clamp(spread / PING.errorFar, 0, 1) * 0.03;

    const g = this.synth.group();
    for (const mul of [1 - detune, 1 + detune]) {
      this.synth.play({
        bus: "panel",
        group: g,
        wave: "sine",
        freq: PING_FREQ * mul,
        level: 0.07 * level,
        attack: 0.001,
        decay: 0.05,
        pan,
      });
    }
    this.synth.duck("weapon", PING.duckDb, PING.duckSeconds);
  }

  // ── the Shroud ───────────────────────────────────────────────────────────

  /**
   * The most important sound in the game.
   *
   * The cloaker is only fair because it materialises over `CLOAK_WIND` (0.45s)
   * before it fires, and until now that tell was a flare somewhere off screen —
   * useless if you were not already looking at it. This is the same tell in a
   * medium that does not need you to be facing the right way.
   *
   * Re-voiced from a pair of detuned oscillators (the timbre this file used to
   * reserve for the Shroud alone — see the file header, and `ping` above,
   * which inherited the device) to the `fm` voice's own bell shape: bright and
   * inharmonic (`ratio: 1.618`, deliberately not a small-integer ratio like
   * `shieldHit`'s 2.01) at the moment it opens, its index settling toward
   * plain across the *whole* wind-up rather than a struck note's usual quick
   * decay (`indexDecay: CLOAK_WIND`) — so the sound's own arc **is** the tell:
   * "unresolved, clarifying" rather than a fixed texture that has to be read
   * as a state. The carrier climbs too (`to`), a swell rather than a held
   * pitch. What resolves it is a plain `tone` in the Shroud's own bolt
   * register — `hostileFire`'s 520→300 sawtooth, note for note — landing
   * `CLOAK_WIND - 0.03` in: three hundredths of a second before the real
   * bolt, so the ear hears the shape of what is coming before it arrives.
   * Both layers keep the floor under distance attenuation and the panning
   * `decloak` always had, because a warning you cannot hear or place is not
   * a warning.
   */
  decloak(x: number, z: number): void {
    const { level, pan } = this.place(x, z, 0.62);
    // Two layers, one slot — the swell and its own resolve are one event,
    // not two competing ones.
    const g = this.synth.group();
    this.synth.play({
      kind: "fm",
      bus: "hostile",
      group: g,
      ratio: 1.618,
      index: 6,
      indexDecay: CLOAK_WIND,
      wave: "sawtooth",
      freq: 240,
      to: 620,
      level: 0.22 * level,
      attack: 0.05,
      decay: CLOAK_WIND,
      pan,
    });
    this.synth.play({
      bus: "hostile",
      group: g,
      wave: "sawtooth",
      freq: 520,
      to: 300,
      level: 0.18 * level,
      attack: 0.002,
      decay: 0.13,
      delay: CLOAK_WIND - 0.03,
      pan,
    });
  }

  // ── the run ──────────────────────────────────────────────────────────────

  /** A wave arriving. Falls, and falls lower the deeper the run goes. */
  wave(index: number): void {
    const base = Math.max(180, 330 - index * 11);
    // Three layers, one slot — the panel bus's cap of 2 would otherwise
    // silently drop the noise swell every time.
    const g = this.synth.group();
    for (const detune of [1, 1.012]) {
      this.synth.play({
        bus: "panel",
        group: g,
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
      group: g,
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
    // Four layers, one slot — the mechanism bus's cap of 2 would otherwise
    // mute two of the three spreading partials that are the whole effect.
    const g = this.synth.group();

    // Three partials that start nearly in unison and spread apart. Beating
    // between them is the whole effect — at the start they are one note, by
    // the end they are a chord that has not decided what it is.
    for (const [from, to, level] of [
      [58, 55, 0.1],
      [58.6, 82.5, 0.075],
      [57.4, 110, 0.055],
    ]) {
      this.synth.play({
        bus: "mechanism",
        group: g,
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
      bus: "mechanism",
      group: g,
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
    const g = this.synth.group();
    this.synth.play({ bus: "mechanism", group: g, wave: "sawtooth", freq: 82, to: 41, level: 0.08, decay: 0.22 });
    this.synth.play({
      kind: "noise",
      bus: "mechanism",
      group: g,
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
    // Three layers, one slot — the mechanism bus's cap of 2 would otherwise
    // mute the far-side note this cue closes on.
    const g = this.synth.group();
    this.synth.play({
      kind: "noise",
      bus: "mechanism",
      group: g,
      filter: "highpass",
      freq: 900,
      to: 120,
      level: 0.2,
      attack: 0.004,
      decay: 0.5,
    });
    this.synth.play({ bus: "mechanism", group: g, wave: "sine", freq: 220, to: 41, level: 0.18, decay: 0.55 });
    // The far side, a beat later: thin, high, and alone, because you arrived
    // cold and the sector has not said anything back yet.
    this.synth.play({
      bus: "mechanism",
      group: g,
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
    const g = this.synth.group();
    this.synth.play({
      kind: "noise",
      bus: "mechanism",
      group: g,
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
      bus: "mechanism",
      group: g,
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
   *
   * And with the level nailed down. Everything urgency does here it does by
   * adding partials: the minor second at the first threshold, the modulation
   * sidebands at the second. Nothing scales `ALERT_LEVEL`, in either
   * direction — de-escalation takes components away rather than turning down.
   *
   * @param components 1, 2 or 4; see `AlertPulse.components`.
   */
  alertBeat(frequency: number, components: number): void {
    // One shape for every partial, so they fuse into a single beat with a
    // timbre rather than reading as a chord of separate notes.
    const shape = { attack: ALERT_RISE, hold: 0.045, decay: 0.07 };
    // Up to four layers, one slot — the alert bus's cap of 1 exists so at
    // most one beat sounds at a time, not so a single beat's own partials
    // compete with each other. Without the group, the whole point of adding
    // partials for urgency (CHI 2024: escalation is spectral, never level)
    // would be capped away before it ever reached the ear.
    const g = this.synth.group();

    this.synth.play({
      bus: "alert",
      group: g,
      // The waveform follows the tier for the same reason the partials do: a
      // plain beat should be plain all the way down.
      wave: components > 1 ? "sawtooth" : "triangle",
      freq: frequency,
      level: ALERT_LEVEL,
      ...shape,
    });
    if (components < 2) return;

    this.synth.play({
      bus: "alert",
      group: g,
      wave: "sawtooth",
      freq: frequency * ALERT_SECOND,
      level: ALERT_LEVEL * 0.73,
      ...shape,
    });
    if (components < 4) return;

    // The sidebands. Sines, because the roughness wanted here is between these
    // and the fundamental, not inside them. Phase drifts between voices where
    // a real modulator would hold it, which moves where in the beat the
    // beating starts but not how fast it beats.
    for (const offset of [-ALERT_AM_RATE, ALERT_AM_RATE]) {
      this.synth.play({
        bus: "alert",
        group: g,
        wave: "sine",
        freq: Math.max(30, frequency + offset),
        level: ALERT_LEVEL * ALERT_AM_DEPTH * 0.5,
        ...shape,
      });
    }
  }

  /**
   * The whoop, when the condition changes. Once per change, never on a loop —
   * a klaxon that repeats forever is the thing players mute.
   *
   * Our own cadence deliberately: alert conditions are naval usage that long
   * predates any television programme, but the specific sound anyone would
   * recognise belongs to that programme, and "our own universe" is locked.
   *
   * Red and yellow are told apart by **rhythm**, which is Patterson's confusion
   * finding: warnings that share a pulse-repetition rate get mistaken for one
   * another even when their spectra are grossly different. So red is three
   * pulses closing up and yellow is two spaced out, and they sit at the same
   * level — red used to be simply louder, which is the move CHI 2024 measured
   * as actively costing perceived competence.
   */
  conditionChange(red: boolean): void {
    const base = red ? 320 : 240;
    // Two or three pulses plus, for red, a noise riser — one slot, for the
    // same reason `alertBeat` needs one: the alert bus's cap of 1 is meant to
    // keep two different *whoops* from overlapping, not to gate a single
    // whoop's own burst down to its first pulse.
    const g = this.synth.group();
    // Rising within the burst, never falling: Patterson's startle-avoidance
    // rule is that the first pulse is the quietest one.
    const burst = red
      ? [
          [1, 0, 0.07],
          [1.19, 0.14, 0.078],
          [1.34, 0.25, 0.085],
        ]
      : [
          [1, 0, 0.07],
          [1.34, 0.19, 0.085],
        ];
    for (const [mul, delay, level] of burst) {
      this.synth.play({
        bus: "alert",
        group: g,
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
      bus: "alert",
      group: g,
      filter: "bandpass",
      q: 4,
      freq: 700,
      to: 2100,
      level: 0.045,
      attack: 0.1,
      decay: 0.24,
    });
  }

  // ── the Warden ───────────────────────────────────────────────────────────

  /**
   * A transmission opening.
   *
   * Every cue in this bank so far is a thing happening in the world. This one
   * is a thing happening *in the panel* — somebody keying a microphone — and it
   * needs to be identifiable as that before the first note, or an ally hailing
   * you from off screen is indistinguishable from an instrument chirping. So it
   * opens on a squelch: a very short, very tight band of noise, the one gesture
   * nothing else in the game makes.
   *
   * Placed like everything else, because where the voice is coming from is
   * where the ship is. Floored, because a friend arriving is worth hearing at
   * any range — the same argument as the decloak, for the opposite reason.
   */
  private squelch(place: { level: number; pan: number }, delay = 0, group?: number): void {
    this.synth.play({
      kind: "noise",
      bus: "panel",
      group,
      filter: "bandpass",
      q: 14,
      freq: 1800,
      to: 2100,
      level: 0.05 * place.level,
      attack: 0.002,
      decay: 0.035,
      delay,
      pan: place.pan,
    });
  }

  /**
   * A Warden checking in. Clean and centred in timbre — triangle and sine, the
   * timbres reserved for our own hardware — and rising, because it is the only
   * good news the game has.
   */
  allyHail(x: number, z: number): void {
    this.say("warden", "hail", { x, z });
    const at = this.place(x, z, 0.5);
    // Squelch plus two rising notes, one slot — the panel bus's cap of 2
    // would otherwise mute the second, resolving note.
    const g = this.synth.group();
    this.squelch(at, 0, g);
    for (const [note, delay] of [
      [523.25, 0.05],
      [783.99, 0.15],
    ] as const) {
      this.synth.play({
        bus: "panel",
        group: g,
        wave: "triangle",
        freq: note,
        level: 0.1 * at.level,
        attack: 0.006,
        decay: delay > 0.1 ? 0.36 : 0.18,
        delay,
        pan: at.pan,
      });
    }
  }

  /** Anything else it says. One note, so a talkative escort is not a tune. */
  allyComms(x: number, z: number): void {
    this.say("warden", "comms", { x, z });
    const at = this.place(x, z, 0.4);
    const g = this.synth.group();
    this.squelch(at, 0, g);
    this.synth.play({
      bus: "panel",
      group: g,
      wave: "triangle",
      freq: 659.25,
      level: 0.075 * at.level,
      attack: 0.005,
      decay: 0.16,
      delay: 0.05,
      pan: at.pan,
    });
  }

  /**
   * The Warden's own gun. Deliberately not the player's phaser: at a quarter
   * of the pitch spread and half the level it reads as a shot from somewhere
   * else, so nobody spends a wave wondering why their own weapon is firing on
   * its own.
   */
  allyFire(x: number, z: number): void {
    const at = this.place(x, z);
    const g = this.synth.group();
    this.synth.play({
      bus: "weapon",
      group: g,
      wave: "triangle",
      freq: 760,
      to: 520,
      level: 0.09 * at.level,
      attack: 0.002,
      decay: 0.11,
      pan: at.pan,
    });
    this.synth.play({
      kind: "noise",
      bus: "weapon",
      group: g,
      filter: "highpass",
      freq: 2600,
      level: 0.03 * at.level,
      attack: 0.001,
      decay: 0.05,
      pan: at.pan,
    });
  }

  /**
   * Losing one. The death cue's shape at a third the size, and a falling pair
   * where the hail had a rising one — the same two notes, the other way up.
   */
  allyLost(x: number, z: number): void {
    this.say("warden", "lost", { x, z });
    const at = this.place(x, z, 0.4);
    const g = this.synth.group();
    this.synth.play({
      kind: "noise",
      bus: "impact",
      group: g,
      filter: "lowpass",
      q: 0.7,
      freq: 1800,
      to: 60,
      level: 0.24 * at.level,
      attack: 0.004,
      decay: 0.7,
      pan: at.pan,
    });
    for (const [note, delay] of [
      [783.99, 0],
      [392, 0.13],
    ] as const) {
      this.synth.play({
        bus: "panel",
        group: g,
        wave: "triangle",
        freq: note,
        to: note * 0.94,
        level: 0.09 * at.level,
        attack: 0.008,
        decay: delay > 0 ? 0.7 : 0.2,
        delay,
        pan: at.pan,
      });
    }
  }

  sectorClear(): void {
    const g = this.synth.group();
    this.synth.play({ bus: "panel", group: g, wave: "triangle", freq: 659.25, level: 0.11, decay: 0.18 });
    this.synth.play({
      bus: "panel",
      group: g,
      wave: "triangle",
      freq: 987.77,
      level: 0.11,
      decay: 0.3,
      delay: 0.12,
    });
  }

  // ── docking ──────────────────────────────────────────────────────────────

  /**
   * The A-N radio range, on the `radio` bus (Task 1) because that is what
   * this instrument actually was: 1930s aviation flew a corridor onto a
   * runway by ear, off two overlapping transmitters that broadcast Morse "A"
   * (di-dah) to one side of the beam and "N" (dah-di) to the other, and
   * interlocked into one steady tone exactly on it. `Docking.updateApproach`
   * calls this every frame while `phase === "aligning"` and guidance is
   * visible; the rate gate below is what turns a sixty-times-a-second call
   * into an actual cadence rather than a wall of voices.
   *
   * The two-argument interface folds the historical range's two pieces of
   * information — which side, and how far — into one signed number, since
   * Morse timing itself does not vary continuously with distance the way a
   * needle does: you are either on the beam or you are not, and if not,
   * which letter you hear is the only thing worth saying. `onCourse` wins
   * outright over `offCourse` when both are supplied, so a caller does not
   * have to zero `offCourse` itself once it has decided the ship is centred.
   *
   * @param offCourse -1..1, signed lateral error. `>= 0` reads "A" (di-dah,
   *   short then long); `< 0` reads "N" (dah-di, long then short) — an
   *   arbitrary but fixed assignment of the range's own two legs, since the
   *   corridor has no compass heading of its own to hang "which side is A"
   *   on. Ignored when `onCourse` is true.
   * @param onCourse  inside the capture cone — `Docking`'s own guidance is
   *   aligned closely enough that a capture is imminent. Interlocks into one
   *   sustained tone rather than alternating.
   */
  approach(offCourse: number, onCourse: boolean): void {
    const now = this.synth.context?.ctx.currentTime;
    if (now === undefined || now - this.lastApproachAt < APPROACH.rate) return;
    this.lastApproachAt = now;

    if (onCourse) {
      this.synth.play({
        bus: "radio",
        wave: "sine",
        freq: APPROACH.freq,
        level: APPROACH.level,
        attack: 0.02,
        hold: APPROACH.onCourseHold,
        decay: 0.06,
      });
      return;
    }

    // Two layers, one slot — the letter is one gesture, not two competing ones.
    const g = this.synth.group();
    const starboard = offCourse >= 0;
    const first = starboard ? APPROACH.dot : APPROACH.dash;
    const second = starboard ? APPROACH.dash : APPROACH.dot;
    this.synth.play({
      bus: "radio",
      group: g,
      wave: "sine",
      freq: APPROACH.freq,
      level: APPROACH.level,
      attack: 0.006,
      hold: first,
      decay: 0.03,
    });
    this.synth.play({
      bus: "radio",
      group: g,
      wave: "sine",
      freq: APPROACH.freq,
      level: APPROACH.level,
      attack: 0.006,
      hold: second,
      decay: 0.03,
      delay: first + 0.03 + APPROACH.gap,
    });
  }

  /** Entering the capture ring. A tick, so the gate is something you hear pass. */
  gate(): void {
    this.synth.play({ bus: "mechanism", wave: "sine", freq: 1244, level: 0.07, decay: 0.06 });
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
    // Three layers, one slot — the mechanism bus's cap of 2 would otherwise
    // mute one of the two sines that make the winding tone.
    const g = this.synth.group();
    for (const [ratio, level] of [
      [1, 0.13],
      [1.5, 0.07],
    ]) {
      this.synth.play({
        bus: "mechanism",
        group: g,
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
      bus: "mechanism",
      group: g,
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
    // Three layers, one slot — the mechanism bus's cap of 2 would otherwise
    // mute the ring off the structure that finishes the cue.
    const g = this.synth.group();
    this.synth.play({
      kind: "noise",
      bus: "mechanism",
      group: g,
      filter: "lowpass",
      q: 0.8,
      freq: 600,
      to: 70,
      level: 0.34,
      attack: 0.001,
      decay: 0.22,
    });
    this.synth.play({
      kind: "fm",
      bus: "mechanism",
      group: g,
      ratio: 1.41,
      index: 8,
      // Short against the layer's own 0.3s decay: the clunk's brightness
      // sheds fast, settling into a plain low thud rather than ringing —
      // the modal-strike character, not shieldHit's sustained metal.
      indexDecay: 0.05,
      freq: 96,
      to: 52,
      level: 0.3,
      attack: 0.002,
      decay: 0.3,
    });
    this.synth.play({
      kind: "noise",
      bus: "mechanism",
      group: g,
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
    const g = this.synth.group();
    this.synth.play({ bus: "mechanism", group: g, wave: "triangle", freq: note, level: 0.12, decay: 0.16 });
    this.synth.play({
      kind: "noise",
      bus: "mechanism",
      group: g,
      filter: "highpass",
      freq: 3200,
      level: 0.04,
      attack: 0.001,
      decay: 0.03,
    });
  }

  /**
   * The money crossing — `docking.ts`'s own "SALVAGE TRANSFER" stage, the
   * one step in the service sequence that pays rather than repairs. The
   * other four (`service`, above) restore shields, hull, energy and
   * torpedoes on `SERVICE_NOTES`, a plain rising figure that owes nothing to
   * the multiplier family; this is the moment the run's own tally actually
   * moves, so it speaks in `MOTIF` instead — the same register `deposit`
   * and `tally` do, on the `panel` bus rather than `mechanism`, since a
   * repair is the station doing something to the ship and this is the ship's
   * own earnings, the same distinction `brace`/`scram` already draw between
   * `mechanism` and `panel`.
   *
   * @param step the transfer's own step, 0-indexed, ascending on `MOTIF` the
   *   same way `deposit`'s degree climbs with the multiplier — kept general
   *   for however many steps a transfer takes, though the docking sequence
   *   currently has exactly one (`salvageTransfer(0, 1)`).
   * @param of   how many steps the whole transfer has; the last one
   *   (`step >= of - 1`) resolves a little louder and a little longer, the
   *   same shape `tally`'s own final note gets.
   */
  salvageTransfer(step: number, of: number): void {
    const degree = Math.min(3, step);
    const final = step >= of - 1;
    this.synth.play({
      bus: "panel",
      wave: "triangle",
      freq: motifHz(MOTIF_ROOT, degree),
      level: DEPOSIT_LEVEL * (final ? 1 : 0.75),
      attack: 0.003,
      decay: final ? 0.22 : 0.14,
    });
  }

  /**
   * The tally, pitched by the multiplier — the whole greed loop as one sound.
   *
   * A big bank has to be audibly bigger, so two things move together: the
   * arpeggio runs further up `ARPEGGIO` (the tally's own extension of
   * `MOTIF` — see that constant's own docblock), and a sub note comes in
   * underneath. Banking at 1.0x is four notes and a shrug. Banking at 9x is
   * seven notes over a bass note, and that is the sound the game wants a
   * player pushing one wave too far to be chasing.
   *
   * **Re-rooted to a fixed 220 Hz** (Task 10; before, the root itself
   * climbed a semitone at a time with the multiplier, up to an octave). That
   * climb is what this task's own "four registers agree" test would have
   * caught: an arbitrary semitone shift puts most of the run's own tallies
   * on pitches `deposit`, `multiplierTick` and `salvageTransfer` never
   * land on, so the same multiplier changing the same currency would have
   * sounded like four unrelated instruments rather than one. The
   * size-reads-as-size argument the old climb was serving still holds, but
   * it now lives entirely in note count: past four notes, `ARPEGGIO` itself
   * reaches into the octave-up degrees (16, 19, 24 — `MOTIF`'s own 4, 7, 12
   * plus twelve semitones), so a bigger bank still climbs an octave, just
   * as extra top notes rather than a moving root. The sub note underneath
   * (`root / 2`, 110 Hz) is fixed now rather than climbing with the
   * multiplier the way it used to — it marks "this is the tally" the same
   * way at every bank size, and note count is left to carry "how big" on
   * its own.
   */
  tally(multiplier: number, total: number): void {
    if (total <= 0) {
      // The "nothing to bank" shrug — a single plain note, still on the
      // family rather than the old off-motif 523.25 Hz (a bare C5).
      this.synth.play({ bus: "panel", wave: "triangle", freq: motifHz(MOTIF_ROOT, 3), level: 0.1, decay: 0.2 });
      return;
    }

    const root = MOTIF_ROOT;
    const notes = Math.min(ARPEGGIO.length, 4 + Math.floor(multiplier / 2.2));

    // Up to eight layers (the run plus a sub note), one slot — this is the
    // one cue where the panel bus's cap of 2 would otherwise be devastating:
    // the whole "big bank is audibly bigger" design is the note count.
    const g = this.synth.group();
    for (let i = 0; i < notes; i++) {
      this.synth.play({
        bus: "panel",
        group: g,
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
      group: g,
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
    const g = this.synth.group();
    this.synth.play({
      kind: "noise",
      bus: "mechanism",
      group: g,
      filter: "highpass",
      freq: 200,
      to: 1500,
      level: 0.16,
      attack: 0.05,
      decay: 0.45,
    });
    this.synth.play({
      bus: "mechanism",
      group: g,
      wave: "sine",
      freq: 70,
      to: 132,
      level: 0.13,
      attack: 0.02,
      decay: 0.4,
    });
  }

  // ── the end of a run ─────────────────────────────────────────────────────

  /**
   * Everything falls at once — four layers, all in the same instant, and
   * then **nothing**, by design, until `panelRestore` finds the bus again
   * (and `relayTick`'s own one-shot blip in between): `docs/audio-prior-art.md`
   * argues that two and a half seconds of near-silence after the loudest
   * event in the game is the most powerful thing available here, and a tail
   * scheduled into that drift would spend the one silence the bank has never
   * had to sell. The sub is the weight of the hull letting go; the body is
   * the structure itself tearing, a long lowpass sweep closing down to
   * almost nothing; the crack is the front edge of that same instant, high
   * and brief; the shock ring is the blast's own decay, falling through the
   * register `breach`'s own low tone occupies. All four start together —
   * one group — because a death is one event, not a sequence of them.
   */
  death(): void {
    const g = this.synth.group();
    this.synth.play({ group: g, wave: "sine", freq: 55, level: 0.34, attack: 0.01, decay: 2 });
    this.synth.play({
      kind: "noise",
      group: g,
      filter: "lowpass",
      q: 0.7,
      freq: 3000,
      to: 150,
      level: 0.4,
      attack: 0.004,
      decay: 1.8,
    });
    this.synth.play({
      kind: "noise",
      group: g,
      filter: "highpass",
      freq: 6000,
      to: 900,
      level: 0.22,
      attack: 0.001,
      decay: 0.3,
    });
    this.synth.play({ group: g, wave: "sawtooth", freq: 180, to: 40, level: 0.2, attack: 0.005, decay: 0.95 });
  }

  /**
   * Emergency power finding the bus, under the epitaph. Also the moment the
   * engine/reactor beds' level goes back to the ordinary `alive` gate —
   * see `deathPowerActive`'s own docblock — since the readout from here on
   * has its own cue rather than the dying beds' own dimming.
   */
  panelRestore(): void {
    this.deathPowerActive = false;
    const g = this.synth.group();
    this.synth.play({
      bus: "panel",
      group: g,
      wave: "sine",
      freq: 60,
      to: 190,
      level: 0.11,
      attack: 0.3,
      decay: 0.5,
    });
    this.synth.play({
      bus: "panel",
      group: g,
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
    const level = Math.max(floor, this.levelForRange(distance));
    if (distance < 1e-3) return { level, pan: 0 };
    const right = (dx * Math.cos(this.lh) - dz * Math.sin(this.lh)) / distance;
    return { level, pan: clamp(right, -1, 1) * PAN_WIDTH };
  }

  /** The falloff curve every placed sound shares — `ping` reads off it directly, since a paint already carries a range rather than a world position to project. */
  private levelForRange(range: number): number {
    return 1 / (1 + Math.pow(range / HALF_RANGE, 1.7));
  }
}

export const sound = new Sound();
