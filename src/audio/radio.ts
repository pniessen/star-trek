/**
 * The radio: three parties, one channel.
 *
 * Ours, the Warden's, and theirs all speak through the same instrument — a
 * formant phrase (`Synth.speak`, Task 3) bracketed by two squelches — and
 * that is the whole idea. The player never gets a translation and the game
 * never puts a word on screen; a phrase's cadence, register and urgency are
 * everything it says. Chatter is a tell, not a narrator: `theirs` speaking
 * often and clipped is a raider doctrine pressing the attack, `theirs`
 * speaking rarely and slow is a hammer that does not need to hurry, and none
 * of it is an order and none of it is information the board does not already
 * carry some other way — the same rule `dispatch.ts`'s HQ line already
 * lives by, spent here on timbre instead of text.
 *
 * No WebAudio here beyond the one `Synth` this class holds a reference to —
 * `composePhrase` (`formant.ts`) is the pure half, this is the scheduling
 * half: which party gets to speak right now, and what happens to an event
 * that arrives while a voice is still live.
 */

import { Synth, SQUELCH_LEN } from "./Synth.js";
import { composePhrase, type Cadence } from "./formant.js";

export type Party = "ours" | "warden" | "theirs";
export type RadioEvent = "wave" | "charge" | "commit" | "withdraw" | "flank" | "dispatch" | "hail" | "comms" | "lost";

/**
 * The commander's three shapes, mirrored from `chart/commander.ts` rather
 * than imported — a structural copy, the same trade `sound.ts` already makes
 * for `HostileKind` and `ShieldFacing` (see their own docblocks): the
 * audiotest tsc-emits the audio module set standalone, and `chart/`'s own
 * rule is the mirror image of the same boundary — its modules must not
 * import `three` or the DOM, so pulling `commander.ts` in here would be
 * asking the audiotest to resolve a file that itself resolves nothing this
 * bundle needs. Exported so `sound.ts` can name the type on its own `say`
 * signature without a second mirror of its own — both files already sit on
 * the audio side of the boundary this exists for.
 */
export type Doctrine = "raider" | "hammer" | "anvil";

/**
 * High-priority events (`commit`, `withdraw`, `dispatch`, `lost`) queue one
 * deep behind a live phrase rather than being lost; everything else (`wave`,
 * `charge`, `comms`, `hail`, `flank`) is texture and is simply dropped when
 * the party is already speaking. See `Radio.say`.
 */
const HIGH_PRIORITY: ReadonlySet<RadioEvent> = new Set(["commit", "withdraw", "dispatch", "lost"]);

/** `sound.ts`'s own `GUARD_PITCH` — mirrored for the same reason `Doctrine` above is documented as a mirror rather than a shared import: two small, freestanding audio modules, not one importing the other for a single number. */
const GUARD_PITCH_SCALE = 0.94;

/** Depth of the weapon-bus duck every phrase opens, dB. First-draft, `docs/todo.md`'s tuning list. */
const DUCK_DB = 3;

const RADIO_LEVEL = 0.5;
/** Drive and telephone band by side — theirs is hotter and narrower, ours/the Warden's is cleaner and wider. First-draft numbers. */
const THEIRS_DRIVE = 3.5;
const THEIRS_BAND: readonly [number, number] = [400, 2800];
const OURS_DRIVE = 1.6;
const OURS_BAND: readonly [number, number] = [300, 3400];

/**
 * One cadence per voice on the channel: `ours`, the Warden's, and one per
 * enemy doctrine (`theirs` never has a cadence of its own — which doctrine
 * is commanding the sector picks it, so the war's own commander sets what
 * the enemy's chatter *sounds like*, not only what it *does*). First-draft
 * numbers throughout — `docs/todo.md`'s tuning list, same as every other
 * envelope in this bank.
 *
 * `ours`: level and measured — the player's own hardware, unhurried.
 * `warden`: the same register, shifted up and shorter — recognisably kin to
 * `ours` (same contour, same drive/band family in `Radio.say`) but not it.
 * `raider`: clipped and fast — several short syllables read as pressing.
 * `hammer`: slow and monotone — a doctrine that does not need to hurry.
 * `anvil`: sparse, even, and long — two long syllables, one steady gap.
 */
export const CADENCES: Record<"ours" | "warden" | Doctrine, Cadence> = {
  ours: {
    syllablesMin: 3,
    syllablesMax: 5,
    lengthMin: 0.08,
    lengthMax: 0.14,
    gapMin: 0.03,
    gapMax: 0.07,
    pitchBase: 150,
    pitchRange: 24,
    contour: "level",
  },
  warden: {
    syllablesMin: 2,
    syllablesMax: 3,
    lengthMin: 0.07,
    lengthMax: 0.12,
    gapMin: 0.03,
    gapMax: 0.06,
    pitchBase: 190,
    pitchRange: 24,
    contour: "level",
  },
  // `syllablesMin: 2, syllablesMax: 4` — the brief's own binding numbers.
  // (An earlier draft widened this to 3-5 to make a §17 assertion pass on
  // any rng draw rather than seeding the test properly; that traded a real
  // cadence number for test convenience and was wrong — §17's own raider
  // check now seeds its rng deliberately instead.)
  raider: {
    syllablesMin: 2,
    syllablesMax: 4,
    lengthMin: 0.04,
    lengthMax: 0.07,
    gapMin: 0.02,
    gapMax: 0.04,
    pitchBase: 210,
    pitchRange: 30,
    contour: "level",
  },
  hammer: {
    syllablesMin: 2,
    syllablesMax: 3,
    lengthMin: 0.14,
    lengthMax: 0.2,
    gapMin: 0.05,
    gapMax: 0.09,
    pitchBase: 105,
    pitchRange: 18,
    contour: "level",
  },
  anvil: {
    syllablesMin: 2,
    syllablesMax: 2,
    lengthMin: 0.16,
    lengthMax: 0.22,
    gapMin: 0.1,
    gapMax: 0.1,
    pitchBase: 130,
    pitchRange: 18,
    contour: "level",
  },
};

/**
 * Per-event overrides on top of the party's own cadence. Undecorated events
 * (`wave`, `hail`, `comms`) speak the party's cadence exactly as it stands.
 *
 * `charge`: a short rising figure — the Lance's own tell, heard as well as
 * seen. `withdraw`: `"broken"` — `formant.ts`'s own words for that contour
 * are "a phrase falling apart," which is nearer to what a retreat sounds
 * like than a plain falling pitch would be on its own (the brief's prose
 * said "falling + broken"; `Cadence.contour` is a single enum, so this picks
 * the one candidate whose own documented character already means both).
 * `commit`: zero syllables — two squelches and nothing between them, the
 * Shroud's decloak the way the ear hears a channel keyed and then say
 * nothing at all. `flank`: **one** phrase, not the two the brief first
 * proposed, with the syllable count doubled and `"broken"` again — see this
 * module's own header note on why (one voice per party on the radio bus,
 * cap 3, no groups — a second live phrase for the same party cannot exist
 * without a bus slot neither `Synth` nor this class has a way to guarantee
 * it does not steal from `ours` or the Warden's). A doubled, broken phrase
 * reads as several voices talking over each other inside the one voice the
 * bus can actually give this party.
 */
function overrideFor(event: RadioEvent, cadence: Cadence): Cadence {
  switch (event) {
    case "charge":
      return {
        ...cadence,
        contour: "rising",
        syllablesMin: 1,
        syllablesMax: 2,
        lengthMin: Math.min(cadence.lengthMin, 0.08),
        lengthMax: Math.min(cadence.lengthMax, 0.12),
      };
    case "withdraw":
      return { ...cadence, contour: "broken" };
    case "commit":
      return { ...cadence, syllablesMin: 0, syllablesMax: 0 };
    case "flank":
      return {
        ...cadence,
        syllablesMin: cadence.syllablesMin * 2,
        syllablesMax: cadence.syllablesMax * 2,
        contour: "broken",
      };
    default:
      return cadence;
  }
}

export interface SayOpts {
  /** Required when `party === "theirs"` — which cadence the enemy speaks in. Falls back to `"raider"` if omitted, never throws. */
  readonly doctrine?: Doctrine;
  /**
   * The commander's own guard: `pitchBase` scaled by `GUARD_PITCH_SCALE`,
   * matching Task 8's bolt offset — the same veteran reads the same six
   * percent low over the air as it does on the gun. Inaudible, by
   * construction, on a `commit` — `overrideFor` strips `commit` to zero
   * syllables, and a pitch offset with no syllable to carry it changes
   * nothing about two squelch bursts. Passing `guard: true` there is still
   * correct (nothing downstream has to know the event is the one case
   * where it does not matter) — this is a note, not a special case to add.
   */
  readonly guard?: boolean;
  readonly pan?: number;
  /**
   * `Sound.place`'s own 0..1 range falloff — the same figure every other
   * placed cue in the bank scales its own level by. Omitted (not merely
   * `1`) for a voice with nowhere to be placed — `ours`, speaking from
   * inside the ship rather than from a point in the sector — which speaks
   * at `RADIO_LEVEL`'s own full level unconditionally: distance is a fact
   * about where a transmitter is, not about the ship's own hardware.
   */
  readonly level?: number;
  /** Audio-clock time (`ctx.currentTime`) — the caller's, not this class's own guess, so `Radio` stays testable without a real `AudioContext`. */
  readonly now: number;
  /** Phrases are texture, not state — determinism is not a requirement here the way it is for `composePhrase`'s own unit tests, which pass a seeded rng directly. `sound.ts` passes `Math.random`. */
  readonly rng: () => number;
}

export class Radio {
  lastPhrase: { party: Party; event: RadioEvent; at: number } | null = null;

  /**
   * Per-party bookkeeping, no shared state across parties — `ours` speaking
   * never holds up `theirs` and never gets held up by it, because these are
   * three separate keys, not one channel-wide clock.
   *
   * `busyUntil`: the audio-clock time this party's line is occupied through —
   * the live phrase, and, once something has queued behind it, that queued
   * phrase's own end too. `queueBoundary`: the audio-clock time the live
   * phrase itself ends, i.e. where a queued phrase starts (or would start).
   * The two coincide whenever nothing is queued (the common case), which is
   * also the value `say` resets both to once it schedules a fresh,
   * not-busy phrase.
   *
   * The gap between them is what "only one deep" means in code: a second
   * high-priority event arriving while the first is still queued schedules
   * at the *same* `queueBoundary`, not a later one, which is the "replaces"
   * half of the plan's own note. It cannot, however, un-schedule the
   * `Synth.speak` call the first queued event already made — there is no
   * cancel API on a bus voice (the plan's own words on this: "no such API").
   * Two high-priority events landing in the same live phrase's window is
   * rare — `commit`, `withdraw`, `dispatch` and `lost` are none of them
   * frequent — and when it happens the honest cost is a moment of two
   * queued voices overlapping rather than silently losing the second one;
   * `lastPhrase` and every party's own bookkeeping track the more recent
   * event either way, so a probe reading `lastPhrase` sees the correct,
   * current claim on the channel even on the rare frame the audio itself
   * briefly says two things at once.
   */
  private readonly busyUntil: Record<Party, number> = { ours: -Infinity, warden: -Infinity, theirs: -Infinity };
  private readonly queueBoundary: Record<Party, number> = { ours: -Infinity, warden: -Infinity, theirs: -Infinity };

  constructor(private readonly synth: Synth) {}

  /**
   * A restart, a mode change, a death: whatever was ringing stops ringing —
   * `Sound.silence`'s own line, and this is what keeps it true for the
   * radio too. Without this, a party's `busyUntil` from one run (or, worse,
   * from attract mode's throwaway campaign) is still a *future* timestamp on
   * `Sound`'s own audio clock, since the `Synth`/`Radio` pair is never
   * rebuilt between runs — a fresh run's first `say` for that party would
   * read as still-busy against a channel nothing has spoken on in this run
   * at all, and silently drop or misqueue accordingly.
   */
  reset(): void {
    for (const party of ["ours", "warden", "theirs"] as const) {
      this.busyUntil[party] = -Infinity;
      this.queueBoundary[party] = -Infinity;
    }
    this.lastPhrase = null;
  }

  say(party: Party, event: RadioEvent, opts: SayOpts): void {
    const { now, rng, doctrine, guard, pan, level } = opts;

    // A previously-queued phrase promotes to "live" the instant its own
    // start time passes — from here on, anything arriving queues behind
    // *its* end, not the original live phrase's.
    if (now >= this.queueBoundary[party]) this.queueBoundary[party] = this.busyUntil[party];

    const busy = now < this.busyUntil[party];
    if (busy && !HIGH_PRIORITY.has(event)) return;

    const delay = busy ? Math.max(0, this.queueBoundary[party] - now) : 0;

    const key: "ours" | "warden" | Doctrine = party === "theirs" ? (doctrine ?? "raider") : party;
    const base = CADENCES[key];
    const cadence = guard ? { ...base, pitchBase: base.pitchBase * GUARD_PITCH_SCALE } : base;
    const phrase = composePhrase(overrideFor(event, cadence), rng);
    const span = phrase.duration + 2 * SQUELCH_LEN;

    this.synth.speak({
      phrase,
      bus: "radio",
      // Distance is the tell: a near Lance's charge chatter louder than a
      // far one carries the same information the sound itself already
      // does. `level` is `undefined` for a voice with nowhere to be placed
      // (`ours`), which is exactly when `?? 1` leaves `RADIO_LEVEL` alone.
      level: RADIO_LEVEL * (level ?? 1),
      drive: party === "theirs" ? THEIRS_DRIVE : OURS_DRIVE,
      band: party === "theirs" ? THEIRS_BAND : OURS_BAND,
      pan,
      delay,
    });
    // Ducks through however long this phrase is on air, delay included —
    // `Synth.duck` has no delay parameter of its own, so a queued phrase's
    // dip starts now and simply covers the wait too.
    this.synth.duck("weapon", DUCK_DB, delay + span);

    if (busy) {
      // `Math.max`, not a plain overwrite: a *replaced* queued phrase's own
      // audio voice is still going to sound (see this class's own docblock
      // on why there is no way to stop it), so `busyUntil` has to cover
      // whichever of the two queued spans is longer, not just this one. A
      // plain overwrite let a shorter replacement shrink `busyUntil` back
      // below the still-playing, displaced voice's own end — which read as
      // "free" to a low-priority event arriving in that gap, and let it
      // speak straight over a phrase that had not actually finished.
      this.busyUntil[party] = Math.max(this.busyUntil[party], this.queueBoundary[party] + span);
    } else {
      this.busyUntil[party] = now + span;
      this.queueBoundary[party] = this.busyUntil[party];
    }

    this.lastPhrase = { party, event, at: now + delay };
  }
}
