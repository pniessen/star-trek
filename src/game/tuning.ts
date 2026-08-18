import { BUS_LEVELS, type Bus } from "../audio/Synth.js";
import { sound } from "../audio/sound.js";
import { SCANNER } from "../hud/scanner.js";
import { ALTITUDE } from "./altitude.js";
import { HIT_STOP } from "./hitStop.js";
import { LOOM } from "./loom.js";
import { BRACE, Ship } from "./Ship.js";
import { NEAR_MISS, PACING } from "./session.js";
import { PHASER } from "./weapons.js";

/**
 * The tuning console's registry — the numbers, not the panel that draws them.
 *
 * **Why this exists.** Every constant on this list was chosen by reasoning
 * about it. `docs/todo.md` §2 is six hundred lines saying so, and `status.md`'s
 * roadmap is blunter: tuning "is the one item on the list that cannot be done
 * by reasoning about it." What has stopped it happening is not disagreement
 * about that, it is the loop. Play, form an opinion, quit, find the constant,
 * edit it, rebuild, fly back to the situation that prompted the opinion, and by
 * then the opinion is a memory of an opinion. A number you can move *while the
 * thing it governs is happening* is a different activity: you hold the key down
 * until the ship turns the way you meant, and then you read off what it says.
 *
 * So the console is not a debug menu that happens to write to constants. It is
 * the instrument that converts an evening at the keyboard into the one kind of
 * knowledge this project cannot produce any other way, and the patch it dumps
 * is the whole output — see `patch()` below.
 *
 * **Nothing here persists**, deliberately and in line with the gotcha in
 * `CLAUDE.md`: `kobayashi.campaign` is the only thing this game writes to
 * storage, and adding a second key is a decision to make once for every display
 * setting at the same time, not quietly here for this one. A reload puts every
 * number back to what the source says. That is the right default for a tool
 * whose product is a *patch*: the findings survive by being pasted into the
 * files they came from, which is also the only form in which they can be
 * reviewed, argued with, or reverted.
 *
 * **How a knob reaches its number.** Every block below is a plain mutable
 * object that the game already reads at use time — `ALTITUDE.ceiling` is looked
 * up on the frame the climb key is held, not captured at module load — so a
 * write takes effect on the next frame with no plumbing. Two shapes needed a
 * change to become reachable and both are documented where they live: the
 * flight model's statics on `Ship` gave up `private readonly` rather than being
 * written through a cast that would have made the file lie about itself, and
 * `PACING.waveBreak` became a field because a module-level primitive is the one
 * shape nothing outside can nudge. The mix goes through `Synth.setBusLevel`
 * rather than a field write, because a bus level lives in a `GainNode` as well
 * as in a table.
 *
 * **What a knob cannot do.** It changes the number, not the past. A value read
 * once at construction — a Loom's radius, fixed when the weave opens — governs
 * the instance already on the board until the next one. That is a property of
 * where the game reads its constants and not something the console should paper
 * over: a knob that reached back into live objects would be tuning a different
 * game from the one that ships.
 */

/** One adjustable number: where it lives, what it may be, and how to move it. */
export interface Knob {
  /** Shown on the panel. Short — the column is narrow and the eye is busy. */
  readonly label: string;
  /** The source file it must be pasted back into. */
  readonly file: string;
  /** The property, as written in that file. `patch()` emits `${field}: ${value},`. */
  readonly field: string;
  readonly min: number;
  readonly max: number;
  /** One tap. Holding repeats it; see `Tuner.update`. */
  readonly step: number;
  /** Digits kept when a nudge lands, which is also how the panel prints it. */
  readonly decimals: number;
  /** One line on why this number is the interesting one. Drawn under the list. */
  readonly question: string;
  read(): number;
  write(value: number): void;
}

/** A page of the console. One block is one sitting's worth of one question. */
export interface Block {
  readonly title: string;
  readonly knobs: readonly Knob[];
}

interface KnobSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  question: string;
}

/**
 * A knob onto a field of a plain object.
 *
 * The generic is what makes the call sites safe: `K` is inferred from `field`,
 * and `record` then has to actually have that key holding a number — so a typo
 * is a compile error rather than a knob that silently reads `undefined` and
 * writes a property nobody has. It is also why `Ship` can be passed directly:
 * its static side satisfies the same constraint a plain object does.
 */
function knob<K extends string>(
  file: string,
  record: Record<K, number>,
  field: K,
  spec: KnobSpec,
): Knob {
  return {
    label: spec.label,
    file,
    field,
    min: spec.min,
    max: spec.max,
    step: spec.step,
    decimals: spec.decimals ?? decimalsFor(spec.step),
    question: spec.question,
    read: () => record[field],
    write: (value) => {
      record[field] = value;
    },
  };
}

/** A knob that is not a field write. The mix is the only one so far. */
function busKnob(bus: Bus, spec: KnobSpec): Knob {
  return {
    label: spec.label,
    file: "src/audio/Synth.ts",
    field: bus,
    min: spec.min,
    max: spec.max,
    step: spec.step,
    decimals: spec.decimals ?? decimalsFor(spec.step),
    question: spec.question,
    read: () => BUS_LEVELS[bus],
    write: (value) => sound.synth.setBusLevel(bus, value),
  };
}

/** How many digits a step implies, so 0.005 prints three and 2 prints none. */
function decimalsFor(step: number): number {
  if (step >= 1) return 0;
  return Math.min(4, Math.ceil(-Math.log10(step)));
}

/**
 * The list, in the order `docs/todo.md` §2 argues for.
 *
 * Flight first because it is the oldest guess and the one every other number is
 * judged against; the slab second because it is the newest thing in the game
 * and `Y` makes the A/B free; the Loom last of the combat blocks because it is
 * the one encounter whose entire character rests on a single number (`rise`).
 * The mix is its own page because it is judged with the eyes shut.
 */
export const BLOCKS: readonly Block[] = [
  {
    title: "FLIGHT MODEL",
    knobs: [
      knob("src/game/Ship.ts", Ship, "TURN_ACCEL", {
        label: "TURN ACCEL",
        min: 1,
        max: 16,
        step: 0.2,
        question: "How hard the ship bites when you ask it to turn.",
      }),
      knob("src/game/Ship.ts", Ship, "TURN_DAMP", {
        label: "TURN DAMP",
        min: 0.5,
        max: 12,
        step: 0.2,
        question: "Whether it stops turning when you let go, or coasts round.",
      }),
      knob("src/game/Ship.ts", Ship, "MAX_TURN", {
        label: "MAX TURN",
        min: 0.5,
        max: 6,
        step: 0.1,
        question: "The ceiling on rotation — is the hull agile or heavy?",
      }),
      knob("src/game/Ship.ts", Ship, "THRUST", {
        label: "THRUST",
        min: 6,
        max: 80,
        step: 1,
        question: "How quickly the burn arrives once you ask for it.",
      }),
      knob("src/game/Ship.ts", Ship, "DRAG", {
        label: "DRAG",
        min: 0,
        max: 2,
        step: 0.02,
        question: "Momentum: Asteroids at 0, a ship in treacle at 2.",
      }),
      knob("src/game/Ship.ts", Ship, "MAX_SPEED", {
        label: "MAX SPEED",
        min: 20,
        max: 160,
        step: 2,
        question: "Against engagement ranges of 14 to 78 — can you disengage?",
      }),
      knob("src/game/Ship.ts", Ship, "THRUST_DRAIN", {
        label: "THRUST DRAIN",
        min: 0,
        max: 0.12,
        step: 0.002,
        question: "The one pool, priced for going fast.",
      }),
      knob("src/game/Ship.ts", Ship, "RESERVE_REGEN", {
        label: "RESERVE REGEN",
        min: 0,
        max: 0.06,
        step: 0.002,
        question: "The trickle. Above a drain, that drain stops existing.",
      }),
      knob("src/game/Ship.ts", Ship, "SHIELD_REGEN", {
        label: "SHIELD REGEN",
        min: 0,
        max: 0.3,
        step: 0.005,
        question: "How fast a spent facing is worth turning toward fire again.",
      }),
    ],
  },
  {
    title: "THE SLAB",
    knobs: [
      knob("src/game/altitude.ts", ALTITUDE, "ceiling", {
        label: "CEILING",
        min: 4,
        max: 40,
        step: 0.5,
        question: "Evasive option at 14, a 3D search problem by 40.",
      }),
      knob("src/game/altitude.ts", ALTITUDE, "climbRate", {
        label: "CLIMB RATE",
        min: 2,
        max: 30,
        step: 0.5,
        question: "Whether leaving the plane is a decision or a reflex.",
      }),
      knob("src/game/altitude.ts", ALTITUDE, "fallRate", {
        label: "FALL RATE",
        min: 2,
        max: 30,
        step: 0.5,
        question: "Letting go should feel like letting go.",
      }),
      knob("src/game/altitude.ts", ALTITUDE, "drain", {
        label: "DRAIN",
        min: 0,
        max: 0.15,
        step: 0.002,
        question: "The price of not being where everything else is.",
      }),
      knob("src/hud/scanner.ts", SCANNER, "altitudeScale", {
        label: "STALK SCALE",
        min: 0.2,
        max: 5,
        step: 0.1,
        question: "Elite's stalk: px of tube per unit of height. Readable?",
      }),
    ],
  },
  {
    title: "THE BRACE",
    knobs: [
      knob("src/game/Ship.ts", BRACE, "yield", {
        label: "YIELD",
        min: 0.2,
        max: 1,
        step: 0.02,
        question: "The conversion loss — what stops re-stacking being free.",
      }),
      knob("src/game/Ship.ts", BRACE, "ceiling", {
        label: "CEILING",
        min: 1,
        max: 4,
        step: 0.1,
        question: "The reward. At 1 a fresh brace is pure loss.",
      }),
      knob("src/game/Ship.ts", BRACE, "decay", {
        label: "DECAY",
        min: 0.02,
        max: 1,
        step: 0.02,
        question: "Panic button or build? Nine seconds says panic button.",
      }),
      knob("src/game/Ship.ts", BRACE, "minimum", {
        label: "MINIMUM",
        min: 0,
        max: 1,
        step: 0.05,
        question: "Where it refuses instead of spending three facings for a sliver.",
      }),
    ],
  },
  {
    title: "WEAPONS",
    knobs: [
      knob("src/game/weapons.ts", PHASER, "cost", {
        label: "PHASER COST",
        min: 0,
        max: 0.05,
        step: 0.001,
        question: "Expensive enough to learn to lead a torpedo — not unusable.",
      }),
      knob("src/game/weapons.ts", PHASER, "cooldown", {
        label: "PHASER RATE",
        min: 0.05,
        max: 0.6,
        step: 0.01,
        question: "Seconds per shot. The only sound with a real chance of fatiguing.",
      }),
      knob("src/game/weapons.ts", PHASER, "damage", {
        label: "PHASER DMG",
        min: 0.05,
        max: 1.2,
        step: 0.02,
        question: "Against a torpedo's 2.6 — is the tube still worth carrying?",
      }),
      knob("src/game/weapons.ts", PHASER, "falloffStart", {
        label: "FALLOFF FROM",
        min: 4,
        max: 80,
        step: 1,
        question: "Where distance starts costing you damage.",
      }),
      knob("src/game/weapons.ts", PHASER, "falloffEnd", {
        label: "FALLOFF TO",
        min: 20,
        max: 200,
        step: 2,
        question: "The reach. Past this the tube is all you have.",
      }),
      knob("src/game/weapons.ts", PHASER, "aimCone", {
        label: "AIM CONE",
        min: 0,
        max: 0.5,
        step: 0.01,
        question: "Half-angle of the assist. Aim is the nose, not a cursor.",
      }),
    ],
  },
  {
    title: "FEEL",
    knobs: [
      knob("src/game/hitStop.ts", HIT_STOP, "scale", {
        label: "STOP SCALE",
        min: 0.02,
        max: 1,
        step: 0.02,
        question: "Game seconds per real second inside the window.",
      }),
      knob("src/game/hitStop.ts", HIT_STOP, "impact", {
        label: "ON IMPACT",
        min: 0,
        max: 0.2,
        step: 0.005,
        question: "A torpedo landing on something that survived it.",
      }),
      knob("src/game/hitStop.ts", HIT_STOP, "kill", {
        label: "ON KILL",
        min: 0,
        max: 0.2,
        step: 0.005,
        question: "The punctuation mark the whole roster is read against.",
      }),
      knob("src/game/hitStop.ts", HIT_STOP, "heavyKill", {
        label: "HEAVY KILL",
        min: 0,
        max: 0.2,
        step: 0.005,
        question: "Does a Bastion actually read as heavier, or only measure so?",
      }),
      knob("src/game/hitStop.ts", HIT_STOP, "breach", {
        label: "ON BREACH",
        min: 0,
        max: 0.2,
        step: 0.005,
        question: "Something reaching your own hull.",
      }),
      knob("src/game/hitStop.ts", HIT_STOP, "death", {
        label: "ON DEATH",
        min: 0,
        max: 0.4,
        step: 0.01,
        question: "The only one long enough to read as a beat.",
      }),
      knob("src/game/session.ts", NEAR_MISS, "outer", {
        label: "NEAR MISS",
        min: 1,
        max: 14,
        step: 0.5,
        question: '"That one was close" — or a band so wide it always says so.',
      }),
      knob("src/game/session.ts", NEAR_MISS, "cooldown", {
        label: "NEAR CD",
        min: 0.05,
        max: 3,
        step: 0.05,
        question: "A specific event, or a rattle nobody notices any more.",
      }),
      knob("src/game/session.ts", PACING, "waveBreak", {
        label: "WAVE BREAK",
        min: 0.5,
        max: 8,
        step: 0.1,
        question: "Long enough to breathe, short enough not to be homework.",
      }),
      knob("src/hud/scanner.ts", SCANNER, "sweepRate", {
        label: "SWEEP RATE",
        min: 1,
        max: 12,
        step: 0.2,
        question: "A sweep, or a strobe.",
      }),
    ],
  },
  {
    title: "THE LOOM",
    knobs: [
      knob("src/game/loom.ts", LOOM, "rise", {
        label: "RISE",
        min: 0.1,
        max: 4,
        step: 0.05,
        question: "THE number. Does altitude buy time, or immunity, or nothing?",
      }),
      knob("src/game/loom.ts", LOOM, "angularRate", {
        label: "ANGULAR RATE",
        min: 0.05,
        max: 0.8,
        step: 0.005,
        question: "The clock. A countdown at 0.175, weather much slower.",
      }),
      knob("src/game/loom.ts", LOOM, "radius", {
        label: "RADIUS",
        min: 40,
        max: 240,
        step: 2,
        question: "Inside the tube's 150 rim, outside the phaser's 78 reach.",
      }),
      knob("src/game/loom.ts", LOOM, "strandStep", {
        label: "STRAND STEP",
        min: 0.01,
        max: 0.3,
        step: 0.005,
        question: "The gap you thread. Threading it is the skill.",
      }),
      knob("src/game/loom.ts", LOOM, "contractRate", {
        label: "CONTRACT",
        min: 0.5,
        max: 20,
        step: 0.5,
        question: "Squeezed, or crushed.",
      }),
      knob("src/game/loom.ts", LOOM, "minRadius", {
        label: "MIN RADIUS",
        min: 4,
        max: 60,
        step: 1,
        question: "Below this there is no sector left.",
      }),
      knob("src/game/loom.ts", LOOM, "chance", {
        label: "CHANCE",
        min: 0,
        max: 1,
        step: 0.05,
        question: "A change of subject every other wave is just the subject.",
      }),
    ],
  },
  {
    title: "THE MIX",
    knobs: [
      busKnob("weapon", {
        label: "WEAPON",
        min: 0,
        max: 1.5,
        step: 0.02,
        question: "The phaser at 6.25 a second is what fatigues first.",
      }),
      busKnob("impact", {
        label: "IMPACT",
        min: 0,
        max: 1.5,
        step: 0.02,
        question: "The loudest thing in the game, and it should be.",
      }),
      busKnob("hostile", {
        label: "HOSTILE",
        min: 0,
        max: 1.5,
        step: 0.02,
        question: "Five classes, five bands — audible under fire?",
      }),
      busKnob("mechanism", {
        label: "MECHANISM",
        min: 0,
        max: 1.5,
        step: 0.02,
        question: "Docking, tractor, the things the ship does to itself.",
      }),
      busKnob("panel", {
        label: "PANEL",
        min: 0,
        max: 1.5,
        step: 0.02,
        question: "Instruments. Present, not chattering.",
      }),
      busKnob("bed", {
        label: "BED",
        min: 0,
        max: 1.5,
        step: 0.02,
        question: "The reactor. You should stop hearing it and miss it when it dips.",
      }),
      busKnob("alert", {
        label: "ALERT",
        min: 0,
        max: 1.5,
        step: 0.02,
        question: "Urgency is spent in partials, never here. Is the level right at all?",
      }),
      busKnob("radio", {
        label: "RADIO",
        min: 0,
        max: 1.5,
        step: 0.02,
        question: "Three parties on one channel — over the fight, or under it?",
      }),
      busKnob("echo", {
        label: "ECHO",
        min: 0,
        max: 1.5,
        step: 0.02,
        question: "Rocks answering an impact. A place, or a gimmick.",
      }),
    ],
  },
];

/**
 * What the source said, captured before a keypress can have happened.
 *
 * The whole product of a tuning session is the *difference* between this and
 * what the player settled on, so it is read once at module load and never
 * written again. Keyed by the knob object, which is stable for the process.
 */
const BASELINE = new Map<Knob, number>();
for (const block of BLOCKS) for (const k of block.knobs) BASELINE.set(k, k.read());

/** What the file still says, for a knob that has been moved. */
export function baselineOf(k: Knob): number {
  return BASELINE.get(k) ?? k.read();
}

/** True once a knob has been moved off what its file says. */
export function moved(k: Knob): boolean {
  return Math.abs(k.read() - baselineOf(k)) > 1e-9;
}

/** Every knob currently disagreeing with its source, in registry order. */
export function movedKnobs(): Knob[] {
  const out: Knob[] = [];
  for (const block of BLOCKS) for (const k of block.knobs) if (moved(k)) out.push(k);
  return out;
}

function show(k: Knob, value: number): string {
  return value.toFixed(k.decimals);
}

/**
 * The session's findings, as something that can be pasted into the files.
 *
 * This is the console's actual output. Grouped by file and printed as
 * `field: value,` — the exact shape each block already has — so applying an
 * evening's work is a series of paste-overs rather than a transcription
 * exercise, and every line carries what it used to say so a change can be
 * argued with instead of merely adopted.
 *
 * The mix is the one section that cannot be pasted quite as-is: the buses live
 * in a `Record<Bus, number>` whose keys are the bus names, which is what these
 * lines already are, so it works out the same. Nothing else is special-cased.
 */
export function patch(): string {
  const changed = movedKnobs();
  if (changed.length === 0) return "// kobayashi tuning — nothing moved";

  const byFile = new Map<string, Knob[]>();
  for (const k of changed) {
    const list = byFile.get(k.file);
    if (list) list.push(k);
    else byFile.set(k.file, [k]);
  }

  const lines = [`// kobayashi tuning — ${changed.length} changed`];
  for (const [file, knobs] of byFile) {
    lines.push("", `// ${file}`);
    const width = Math.max(...knobs.map((k) => k.field.length));
    for (const k of knobs) {
      const field = `${k.field}:`.padEnd(width + 1);
      const value = show(k, k.read());
      lines.push(`  ${field} ${value},`.padEnd(34) + `// was ${show(k, baselineOf(k))}`);
    }
  }
  return lines.join("\n");
}

/**
 * Put a knob back to what its file says.
 *
 * There is deliberately no "reset everything": nothing here persists, so a
 * reload already is one, and it is the only undo that cannot itself be wrong.
 * A second key spent on a thing `Cmd-R` does is a key not spent on a knob.
 */
export function reset(k: Knob): void {
  k.write(baselineOf(k));
}

/** Held-key repeat, in seconds. A tap is one step; see `Tuner.update`. */
const REPEAT = {
  /** Silence after the tap, so a deliberate single step stays single. */
  delay: 0.32,
  /** Steps per second once the repeat starts. */
  rate: 16,
  /** Held this long, it doubles — for crossing a wide range without 200 taps. */
  fastAfter: 1.4,
};

/** How long the copy confirmation stays on the panel. */
const NOTICE = 2.2;

/**
 * The console's own state, and none of the game's.
 *
 * Kept out of `main.ts` because it is a small state machine with a repeat clock
 * in it, and kept out of `hud/tuning.ts` because that file draws what it is
 * given. `main.ts` owns the keyboard and the frame, so it forwards both.
 *
 * The console does not pause the game, for the reason the chart does not:
 * a number is judged against the thing it governs while that thing is
 * happening, and a tuning tool you can only use in a frozen frame would tune
 * the freeze.
 */
export class Tuner {
  open = false;
  /** Index into `BLOCKS`. */
  block = 0;
  /** Index into the current block's knobs. */
  row = 0;
  /** Transient line under the list — what a keypress just did. */
  notice = "";
  private noticeTimer = 0;
  private holdTime = 0;
  private repeatTimer = 0;

  get knobs(): readonly Knob[] {
    return BLOCKS[this.block].knobs;
  }

  get current(): Knob {
    return this.knobs[Math.min(this.row, this.knobs.length - 1)];
  }

  /** The keys the console owns while it is up. `main.ts` checks membership. */
  static readonly KEYS = new Set([",", ".", ";", "'", "/", "\\", "0"]);

  /**
   * One key, once.
   *
   * The value keys are here *as well as* in `update` on purpose: a tap has to
   * move exactly one step even if it began and ended inside a single frame,
   * which is the same reason `main.ts` latches `pressed` for the trigger. The
   * hold repeat in `update` waits out `REPEAT.delay` so the two never overlap.
   */
  key(k: string): void {
    switch (k) {
      case ".":
        this.row = (this.row + 1) % this.knobs.length;
        break;
      case ",":
        this.row = (this.row + this.knobs.length - 1) % this.knobs.length;
        break;
      case "/":
        this.block = (this.block + 1) % BLOCKS.length;
        this.row = 0;
        break;
      case "'":
        this.nudge(1);
        break;
      case ";":
        this.nudge(-1);
        break;
      case "0":
        reset(this.current);
        this.say(`${this.current.label} RESET`);
        break;
      case "\\":
        // The copy itself is `main.ts`'s — `navigator.clipboard` is the DOM and
        // this module is the registry. It reports back through `say`.
        break;
    }
  }

  /** Real seconds, never game seconds: hit-stop must not slow the console. */
  update(dt: number, held: ReadonlySet<string>): void {
    if (this.noticeTimer > 0) {
      this.noticeTimer -= dt;
      if (this.noticeTimer <= 0) this.notice = "";
    }
    if (!this.open) {
      this.holdTime = 0;
      return;
    }

    const direction = (held.has("'") ? 1 : 0) - (held.has(";") ? 1 : 0);
    if (direction === 0) {
      this.holdTime = 0;
      this.repeatTimer = 0;
      return;
    }

    this.holdTime += dt;
    if (this.holdTime < REPEAT.delay) return;
    const rate = REPEAT.rate * (this.holdTime > REPEAT.fastAfter ? 2 : 1);
    this.repeatTimer -= dt;
    // Bounded: a frame that took a whole second cannot fire a hundred steps.
    let guard = 64;
    while (this.repeatTimer <= 0 && guard-- > 0) {
      this.nudge(direction);
      this.repeatTimer += 1 / rate;
    }
  }

  /** Announce something for a couple of seconds. */
  say(text: string): void {
    this.notice = text;
    this.noticeTimer = NOTICE;
  }

  /**
   * Move the highlighted knob one step.
   *
   * Snapped to the step grid rather than accumulated, so a hundred nudges of
   * 0.02 land on 2.00 and not on 1.9999999999999998 — which would print as
   * 2.00, read as unchanged, and be emitted by `patch()` as a change anyway.
   */
  private nudge(direction: number): void {
    const k = this.current;
    const next = Math.min(k.max, Math.max(k.min, k.read() + direction * k.step));
    k.write(Number(next.toFixed(k.decimals)));
  }
}
