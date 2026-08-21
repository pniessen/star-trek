import { BUS_LEVELS, type Bus } from "../audio/Synth.js";
import { sound } from "../audio/sound.js";
import { SCANNER } from "../hud/scanner.js";
import { ALTITUDE } from "./altitude.js";
import { HIT_STOP } from "./hitStop.js";
import { LOOM } from "./loom.js";
import { BRACE, Ship } from "./Ship.js";
import { NEAR_MISS, PACING } from "./session.js";
import { GIANT } from "../render/GasGiant.js";
import { NEBULA } from "../render/Nebula.js";
import { PLANET } from "../render/Planet.js";
import { SKY } from "../render/Backdrop.js";
import { COMET_MEDIA } from "../render/CometMedium.js";
import { SKY_BODY } from "../render/SkyBodies.js";
import { MEDIA } from "../render/shaders/media.js";
import { SHADOWS } from "../render/shadows.js";
import { SHOAL_MEDIA } from "../render/Shoals.js";
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
const BLOCK_LIST: Block[] = [
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
    title: "THE SKY",
    knobs: [
      knob("src/render/Nebula.ts", NEBULA, "brightness", {
        label: "BRIGHTNESS",
        min: 0,
        max: 2,
        step: 0.02,
        question: "Glows, or blooms and washes the HUD out. 0.5 linear is the line.",
      }),
      knob("src/render/Nebula.ts", NEBULA, "bandWidth", {
        label: "BAND WIDTH",
        min: 0.05,
        max: 1.2,
        step: 0.02,
        question: "A galactic plane, or an evenly foggy sky.",
      }),
      knob("src/render/Nebula.ts", NEBULA, "laneDepth", {
        label: "LANE DEPTH",
        min: 0,
        max: 1,
        step: 0.02,
        question: "THE number. The dark half is what makes it read as dust.",
      }),
      knob("src/render/Nebula.ts", NEBULA, "laneWidth", {
        label: "LANE WIDTH",
        min: 0.05,
        max: 1,
        step: 0.02,
        question: "A cut through the glow, or a second band of its own.",
      }),
    ],
  },
  {
    title: "SKY BODIES",
    knobs: [
      knob("src/render/SkyBodies.ts", SKY_BODY, "distanceDim", {
        label: "DISTANCE DIM",
        min: 0.4, max: 1, step: 0.02,
        question: "Further away, or the same body twice? Also what keeps the sky under bloom.",
      }),
      knob("src/render/SkyBodies.ts", SKY_BODY, "fullAt", {
        label: "FULL AT",
        min: 3, max: 12, step: 0.25,
        question: "How big must a body be before it may wear full hero saturation?",
      }),
      knob("src/render/SkyBodies.ts", SKY_BODY, "mutedAt", {
        label: "MUTED BELOW",
        min: 0.5, max: 3, step: 0.1,
        question: "Below what size is a body indistinguishable from an unresolved return?",
      }),
      knob("src/render/SkyBodies.ts", SKY_BODY, "minSaturation", {
        label: "MIN SAT",
        min: 0.1, max: 1, step: 0.02,
        question: "How grey a small moon has to be. The axis the colour rule actually cares about.",
      }),
      knob("src/render/SkyBodies.ts", SKY_BODY, "minBrightness", {
        label: "MIN BRIGHT",
        min: 0.3, max: 1, step: 0.02,
        question: "The counterweight — present but invisible through phosphor and CRT is the failure mode.",
      }),
      knob("src/render/SkyBodies.ts", SKY_BODY, "warpTimeScale", {
        label: "WARP WIND-UP",
        min: 0, max: 20, step: 0.5,
        question: "Should a body's own weather wind up with the drive?",
      }),
      knob("src/render/Backdrop.ts", SKY, "minElevation", {
        label: "BAND FLOOR",
        min: 2, max: 8, step: 0.5,
        question: "Newly load-bearing: bodies now sit where the scanner overlay does, and they are bright.",
      }),
      knob("src/render/Backdrop.ts", SKY, "maxElevation", {
        label: "BAND CEILING",
        min: 14, max: 24, step: 0.5,
        question: "The other edge of that band. The HUD still reads over them — this decides it.",
      }),
      knob("src/render/Backdrop.ts", SKY, "separation", {
        label: "SEPARATION",
        min: 25, max: 60, step: 1,
        question: "Unchanged in meaning, but sky bodies are physically large objects now.",
      }),
    ],
  },
  {
    title: "THE NEBULA",
    knobs: [
      knob("src/render/Nebula.ts", NEBULA, "detail", {
        label: "DETAIL",
        // Widened from 0.4-12 when the bake landed. This used to set the
        // frequency of the *whole* nebula; it now sets only the live
        // high-frequency layer laid over the baked cube, which wants a far
        // finer field — the default moved 2.4 to 9 in the same change, and a
        // range whose default sits three quarters of the way along it is a
        // range that has stopped being about the thing it names.
        min: 2,
        max: 40,
        step: 0.5,
        question: "Sharp at screen resolution, or the bake's own resolution showing.",
      }),
      knob("src/render/Nebula.ts", NEBULA, "detailAmount", {
        label: "DETAIL MIX",
        min: 0,
        max: 1.5,
        step: 0.02,
        question: "How much live layer over the soft bake. Zero is the cube alone.",
      }),
      knob("src/render/Nebula.ts", NEBULA, "depth", {
        label: "EXTINCTION",
        min: 0,
        max: 3,
        step: 0.05,
        question: "THE number. Dust in front of gas, or a sum. At 0 it is the old painted look.",
      }),
      knob("src/render/Nebula.ts", NEBULA, "emission", {
        label: "EMISSION",
        min: 0,
        max: 3,
        step: 0.05,
        question: "How loud the ionised gas is.",
      }),
      knob("src/render/Nebula.ts", NEBULA, "scatter", {
        label: "SCATTER",
        min: 0,
        max: 3,
        step: 0.05,
        question: "How much blue haze the dust throws back.",
      }),
      knob("src/render/Nebula.ts", NEBULA, "teal", {
        label: "O III",
        min: 0,
        max: 1,
        step: 0.02,
        question: "Teal against H-alpha. Subtle at the default — most wants a human eye.",
      }),
      knob("src/render/Nebula.ts", NEBULA, "filament", {
        label: "FILAMENT",
        min: 0,
        max: 2.5,
        step: 0.05,
        question: "Gas that has been sheared, or weather.",
      }),
      knob("src/render/Nebula.ts", NEBULA, "starPower", {
        label: "STAR",
        min: 0,
        max: 4,
        step: 0.05,
        question: "Does the embedded star light its own cavity walls, or just sit there.",
      }),
      knob("src/render/Nebula.ts", NEBULA, "cavity", {
        label: "CAVITY",
        min: 0,
        max: 1.2,
        step: 0.02,
        question: "A blown hole, or a star in fog.",
      }),
      knob("src/render/Nebula.ts", NEBULA, "warp", {
        label: "WARP",
        min: 0,
        max: 4,
        step: 0.05,
        question: "Curls and festoons at height; a smudge at zero.",
      }),
      knob("src/render/Nebula.ts", NEBULA, "ambient", {
        label: "AMBIENT",
        min: 0,
        max: 0.5,
        step: 0.01,
        question: "Deep sky away from the plane. Zero makes the band's edge a seam.",
      }),
    ],
  },
  {
    title: "THE GIANT",
    knobs: [
      knob("src/render/GasGiant.ts", GIANT, "diffPole", {
        label: "SHEAR",
        min: 0.4, max: 1, step: 0.01,
        question: "Belts sliding past each other, or the texture coming apart.",
      }),
      knob("src/render/GasGiant.ts", GIANT, "jetDrift", {
        label: "JET DRIFT",
        min: 0, max: 0.28, step: 0.01,
        question: "Do adjacent belts disagree in direction, or only in speed?",
      }),
      knob("src/render/GasGiant.ts", GIANT, "vortexSpinRate", {
        label: "STORM SPIN",
        min: 0, max: 0.2, step: 0.005,
        question: "Motion, or a pulse. The ceiling is the no-blink rule, not taste.",
      }),
      knob("src/render/GasGiant.ts", GIANT, "ovalSpinRate", {
        label: "OVAL SPIN",
        min: 0, max: 0.3, step: 0.005,
        question: "A second storm reading as weather, or as a blemish.",
      }),
      knob("src/render/GasGiant.ts", GIANT, "terminatorGlow", {
        label: "SUNSET",
        min: 0, max: 1, step: 0.02,
        question: "Does the sunset band beat the belts it crosses?",
      }),
      knob("src/render/GasGiant.ts", GIANT, "terminatorWidth", {
        label: "SUNSET WIDTH",
        min: 0.12, max: 0.5, step: 0.01,
        question: "A line, or half the lit face.",
      }),
      knob("src/render/GasGiant.ts", GIANT, "limbIntensity", {
        label: "LIMB",
        min: 0.6, max: 2, step: 0.02,
        question: "How spectacular a backlit body gets before bloom eats the silhouette.",
      }),
      knob("src/render/GasGiant.ts", GIANT, "limbForward", {
        label: "LIMB SCATTER",
        min: 0, max: 1.5, step: 0.02,
        question: "Forward scattering — the reason a crescent glows.",
      }),
      knob("src/render/GasGiant.ts", GIANT, "limbAsymmetry", {
        label: "LIMB PHASE",
        min: 0.4, max: 0.9, step: 0.01,
        question: "How tightly the scatter hugs the star's own direction.",
      }),
      knob("src/render/GasGiant.ts", GIANT, "auroraStrength", {
        label: "AURORA",
        min: 0, max: 2.5, step: 0.05,
        question: "Worth its brightness on a body always seen edge-on from the pole?",
      }),
      knob("src/render/GasGiant.ts", GIANT, "auroraWidth", {
        label: "AURORA WIDTH",
        min: 0.04, max: 0.2, step: 0.005,
        question: "A polar band projects to almost nothing from the equatorial plane.",
      }),
      knob("src/render/GasGiant.ts", GIANT, "auroraLat", {
        label: "AURORA LAT",
        min: 0.7, max: 0.95, step: 0.01,
        question: "How far down from the pole the curtain reaches.",
      }),
      knob("src/render/GasGiant.ts", GIANT, "auroraShift", {
        label: "AURORA HUE",
        min: 0, max: 1, step: 0.02,
        question: "The one place a body leans toward a hue the HUD reserves. Wants a ruling.",
      }),
    ],
  },
  {
    title: "THE RINGS",
    knobs: [
      knob("src/render/Planet.ts", PLANET, "ringDepth", {
        label: "RING DEPTH",
        min: 0.5, max: 3, step: 0.05,
        question: "Opaque B ring and a black shadow, or a system you see the planet through.",
      }),
      knob("src/render/Planet.ts", PLANET, "ambientFloor", {
        label: "ECLIPSE FLOOR",
        min: 0.1, max: 0.4, step: 0.01,
        question: "How black an eclipse may be before the night side is a hole.",
      }),
      knob("src/render/Planet.ts", PLANET, "ringshine", {
        label: "RINGSHINE",
        min: 0, max: 0.6, step: 0.02,
        question: "Weakest measured effect in the pass. Worth keeping, or cut?",
      }),
      knob("src/render/Planet.ts", PLANET, "shadowSoft", {
        label: "SHADOW EDGE",
        min: 0.01, max: 0.2, step: 0.005,
        question: "A hard cast edge, or a penumbra.",
      }),
      knob("src/render/Planet.ts", PLANET, "ringForward", {
        label: "RING SCATTER",
        min: 0, max: 1.5, step: 0.02,
        question: "Backlit rings lighting up — the Cassini shot's other half.",
      }),
      knob("src/render/Planet.ts", PLANET, "ringBackscatter", {
        label: "RING FRONT",
        min: 0.4, max: 1.5, step: 0.02,
        question: "How bright the rings are seen from the star's own side.",
      }),
      knob("src/render/Planet.ts", PLANET, "rotationRate", {
        label: "SPIN",
        min: 0, max: 0.08, step: 0.002,
        question: "Alive, or spinning visibly enough to notice it is a loop.",
      }),
      knob("src/render/Planet.ts", PLANET, "diffPole", {
        label: "SHEAR",
        min: 0.5, max: 1, step: 0.01,
        question: "The giant's own question, on a smaller body.",
      }),
    ],
  },
  {
    title: "THE GAS",
    knobs: [
      knob("src/render/shaders/media.ts", MEDIA, "msFalloff", {
        label: "MULTI-SCATTER",
        min: 0.2, max: 0.8, step: 0.02,
        question: "Low is single-scatter's sharp searchlight lobe; high is flat and evenly lit.",
      }),
      knob("src/render/shaders/media.ts", MEDIA, "msEccentricity", {
        label: "MS SPREAD",
        min: 0.3, max: 0.9, step: 0.02,
        question: "How fast bounced light forgets its direction. Decides whether anisotropy can go physical.",
      }),
      knob("src/render/shaders/media.ts", MEDIA, "anisotropy", {
        label: "PHASE",
        min: 0, max: 0.8, step: 0.02,
        question: "The forward lobe, before it reads as a searchlight from one heading and nothing from the other.",
      }),
      knob("src/render/shaders/media.ts", MEDIA, "lights", {
        label: "LIGHTS",
        min: 0, max: 6, step: 1,
        question: "Four lights roughly triple the shader. This is the lever before `steps`, not after.",
      }),
      knob("src/render/shaders/media.ts", MEDIA, "growth", {
        label: "STEP GROWTH",
        min: 1, max: 1.2, step: 0.005,
        question: "Does the far end dissolve gracefully, or shed detail?",
      }),
      knob("src/render/shaders/media.ts", MEDIA, "cutoff", {
        label: "CUTOFF",
        min: 0.001, max: 0.05, step: 0.001,
        question: "How early may a dense medium stop marching itself.",
      }),
      knob("src/render/CometMedium.ts", COMET_MEDIA, "sigma", {
        label: "TAIL DENSITY",
        min: 0.005, max: 0.08, step: 0.001,
        question: "Haze you fly through, or a wall. The one here that touches play.",
      }),
      knob("src/render/CometMedium.ts", COMET_MEDIA, "keyGain", {
        label: "TAIL KEY",
        min: 0, max: 6, step: 0.1,
        question: "How much does turning toward the star change the tail?",
      }),
      knob("src/render/CometMedium.ts", COMET_MEDIA, "dustFrom", {
        label: "TAIL DUST LO",
        min: 0.3, max: 0.7, step: 0.01,
        question: "Dust is a decorrelated field now — dark lane no longer coincides with density.",
      }),
      knob("src/render/CometMedium.ts", COMET_MEDIA, "dustTo", {
        label: "TAIL DUST HI",
        min: 0.7, max: 1, step: 0.01,
        question: "The other end of that range. Worth re-judging by eye since the fields split.",
      }),
      knob("src/render/CometMedium.ts", COMET_MEDIA, "noiseScale", {
        label: "TAIL SCALE",
        min: 0.06, max: 0.2, step: 0.005,
        question: "The coarse row now puts a 127-unit feature in frame; the old best scale may not hold.",
      }),
      knob("src/render/Shoals.ts", SHOAL_MEDIA, "sigma", {
        label: "SHOAL DENSITY",
        min: 0.005, max: 0.06, step: 0.001,
        question: "A curtain that hides a hull, or one you barely notice.",
      }),
      knob("src/render/Shoals.ts", SHOAL_MEDIA, "dustFrom", {
        label: "SHOAL DUST LO",
        min: 0.3, max: 0.7, step: 0.01,
        question: "A shoal has no glowing head — bright knot beside dark knot is its only contrast.",
      }),
      knob("src/render/Shoals.ts", SHOAL_MEDIA, "dustTo", {
        label: "SHOAL DUST HI",
        min: 0.7, max: 1, step: 0.01,
        question: "The other end. Matters more here than on the comet.",
      }),
    ],
  },
  {
    title: "SHADOWS",
    knobs: [
      knob("src/render/shadows.ts", SHADOWS, "extent", {
        label: "EXTENT",
        min: 60, max: 400, step: 5,
        question: "Where does the cutoff show while you are still shooting at what is inside it?",
      }),
      knob("src/render/shadows.ts", SHADOWS, "mapSize", {
        label: "MAP SIZE",
        min: 1024, max: 4096, step: 1024,
        question: "Can you see 2048 against 4096 at combat range? 2048 gives back 0.25 ms.",
      }),
      knob("src/render/shadows.ts", SHADOWS, "normalBias", {
        label: "NORMAL BIAS",
        min: 0, max: 0.5, step: 0.01,
        question: "Measured acne is zero at 0 and shadows shrink as this rises. Is any of it earned?",
      }),
      knob("src/render/shadows.ts", SHADOWS, "bias", {
        label: "BIAS",
        min: -0.002, max: 0, step: 0.0001,
        question: "Backstop for star-grazing facets. Does anything stripe at 0?",
      }),
      knob("src/render/shadows.ts", SHADOWS, "radius", {
        label: "SOFTNESS",
        min: 0, max: 4, step: 0.1,
        question: "A softer edge, or a small rock's shadow dissolving into nothing.",
      }),
      knob("src/render/shadows.ts", SHADOWS, "depthPad", {
        label: "DEPTH PAD",
        min: 100, max: 800, step: 25,
        question: "Effectively fixed. Only interesting if a caster gets clipped out of the depth window.",
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
function captureBaseline(block: Block): void {
  for (const k of block.knobs) BASELINE.set(k, k.read());
}
for (const block of BLOCK_LIST) captureBaseline(block);

/**
 * The pages, including any registered after module load. See `registerPasses`.
 */
export const BLOCKS: readonly Block[] = BLOCK_LIST;

/**
 * Add the post chain's own numbers, once the passes exist.
 *
 * Everything else on this console is a module-level constant, reachable by
 * importing it. The post chain is not: `bloom`, `phosphor` and `toneMap` are
 * *instances* built by `Stage` against a live renderer, so there is nothing to
 * import until `main.ts` has made one. A registration call is the honest shape
 * for that — the alternative was a lazy getter per knob, which would have made
 * every other knob on the list look like it might also be lazy.
 *
 * Baselines are captured here rather than at module load for the same reason:
 * these knobs did not exist then. `patch()` therefore reports them against the
 * values their own files declare, exactly like every other knob.
 *
 * These are the numbers the pass that introduced them says to fly first —
 * `octaveGain` above all, which decides whether the bloom is a redistribution
 * of the frame's light or a fog laid over it.
 */
export function registerPasses(passes: {
  bloom: { octaveGain: number; strength: number };
  phosphor: { decay: number; historyCeiling: number };
  toneMap: { exposure: number; desaturation: number };
  taa: { feedback: number; clampGamma: number; jitterScale: number; jumpDistance: number };
  godRays: {
    strength: number;
    threshold: number;
    decay: number;
    occluderNear: number;
    occluderFar: number;
    eventStrength: number;
    eventFalloff: number;
  };
}): void {
  const block: Block = {
    title: "THE GLASS",
    knobs: [
      knob("src/render/BloomPass.ts", passes.bloom, "octaveGain", {
        label: "BLOOM GAIN",
        min: 0,
        max: 2,
        step: 0.02,
        question: "Redistributes the frame's light, or fogs it. 0.9 matched the old total.",
      }),
      knob("src/render/BloomPass.ts", passes.bloom, "strength", {
        label: "BLOOM",
        min: 0,
        max: 3,
        step: 0.02,
        question: "How much glow a stroke throws before it stops being a stroke.",
      }),
      knob("src/render/PhosphorPass.ts", passes.phosphor, "decay", {
        label: "PHOSPHOR",
        min: 0,
        max: 0.98,
        step: 0.01,
        question: "A vector monitor's trail, or a smear that never clears.",
      }),
      knob("src/render/PhosphorPass.ts", passes.phosphor, "historyCeiling", {
        label: "TRAIL CEILING",
        min: 1,
        max: 12,
        step: 0.25,
        question: "How long a detonation burns in the trail. Reasoned, never flown.",
      }),
      knob("src/render/ToneMapPass.ts", passes.toneMap, "exposure", {
        label: "EXPOSURE",
        min: 0.2,
        max: 4,
        step: 0.02,
        question: "Deliberately constant, not adaptive — brightness is information here.",
      }),
      knob("src/render/ToneMapPass.ts", passes.toneMap, "desaturation", {
        label: "WHITE POINT",
        min: 0,
        max: 1,
        step: 0.02,
        question: "How hard a hot core goes white. Costs class-hue legibility as it climbs.",
      }),
    ],
  };
  const temporal: Block = {
    title: "TAA & RAYS",
    knobs: [
      knob("src/render/TaaPass.ts", passes.taa, "feedback", {
        label: "TAA HISTORY",
        min: 0.6, max: 0.95, step: 0.01,
        question: "Where does more history stop being a cleaner edge and start being drag?",
      }),
      knob("src/render/TaaPass.ts", passes.taa, "clampGamma", {
        label: "TAA CLAMP",
        min: 0.6, max: 2, step: 0.05,
        question: "Tighten until crawl returns — that is where the ghost threshold really is.",
      }),
      knob("src/render/TaaPass.ts", passes.taa, "jitterScale", {
        label: "TAA JITTER",
        min: 0, max: 1.5, step: 0.05,
        question: "Is one pixel too soft for a tube, or is softness what a tube is? Zero is a bypass.",
      }),
      knob("src/render/TaaPass.ts", passes.taa, "jumpDistance", {
        label: "TAA CUT",
        min: 10, max: 120, step: 5,
        question: "Does a hyperwarp arrival smear — and does lowering it make ordinary flight pop?",
      }),
      knob("src/render/GodRayPass.ts", passes.godRays, "strength", {
        label: "GOD RAYS",
        min: 0, max: 1, step: 0.02,
        question: "With a sun on screen, when does the void stop being black?",
      }),
      knob("src/render/GodRayPass.ts", passes.godRays, "threshold", {
        label: "RAY SOURCE",
        min: 0.1, max: 1, step: 0.02,
        question: "Measured: the frame has two populations with a gap. Does a giant's limb fall below it?",
      }),
      knob("src/render/GodRayPass.ts", passes.godRays, "decay", {
        label: "RAY REACH",
        min: 0.9, max: 1, step: 0.005,
        question: "Long even shafts, or a tight flare at the source.",
      }),
      knob("src/render/GodRayPass.ts", passes.godRays, "occluderNear", {
        label: "OCCLUDE FROM",
        min: 20, max: 600, step: 10,
        question: "How close must a hull be to cut a shaft?",
      }),
      knob("src/render/GodRayPass.ts", passes.godRays, "occluderFar", {
        label: "OCCLUDE TO",
        min: 20, max: 600, step: 10,
        question: "Can a hero body at its 335-unit minimum ever be mistaken for an occluder?",
      }),
      knob("src/render/GodRayPass.ts", passes.godRays, "eventStrength", {
        label: "BLAST RAYS",
        min: 0, max: 0.2, step: 0.005,
        question: "Does a warhead throw enough through gas to earn the term, or just fog the blast?",
      }),
      knob("src/render/GodRayPass.ts", passes.godRays, "eventFalloff", {
        label: "BLAST REACH",
        min: 0.15, max: 0.8, step: 0.01,
        question: "How far from a detonation should its own shafts reach?",
      }),
    ],
  };
  BLOCK_LIST.push(temporal);
  captureBaseline(temporal);

  BLOCK_LIST.push(block);
  captureBaseline(block);
}

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
