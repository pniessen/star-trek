import { Vector3 } from "three";
import { ALTITUDE, flight } from "./altitude.js";
import { sound } from "../audio/sound.js";
import { PALETTE } from "../render/palette.js";
import type { TraceBuffer } from "../render/TraceBuffer.js";
import type { VectorObject } from "../render/VectorObject.js";
import { bearingOffset } from "./weapons.js";
import type { Ship } from "./Ship.js";

/**
 * The Loom — the encounter that is a clock rather than a fight.
 *
 * Everything else in this sector is answered through the reticle. The five
 * hostile classes are five ways of asking "can you point at the right thing in
 * time"; the minefield is the same question asked about a course rather than a
 * bearing; even the Shroud, which cannot be shot for most of its life, is still
 * a thing you eventually shoot. The Loom is the first thing here that **does not
 * care where you are pointed at all**.
 *
 * Two spinners orbit a common centre at diametrically opposite points and lay a
 * vertical filament at every bearing they pass. They never fire, never chase and
 * never target. What they build is a picket fence closing around the space you
 * were standing in when it opened, and the whole encounter is the question of
 * what you do with the time before it shuts.
 *
 * **Why the wall rises.** This is the load-bearing decision and it is what ties
 * the encounter to the slab. If the strands were full height from the first one,
 * the lid would be closed from the start and the newest system in the game would
 * be irrelevant to the newest encounter in it. If they were short forever, the
 * whole thing would be one keypress — hold `Q`, fly out, done. So they grow: the
 * lid is open for roughly the first two thirds of the weave and shut for the
 * last third. **Altitude buys time, not immunity.** That is the middle path, and
 * it is the only version of this encounter that makes the player read the wall's
 * height as a number that matters.
 *
 * **Four ways out, and only one of them pays.**
 *
 *  1. Kill either spinner. The weave stops for good, the wall falls back into
 *     the floor, and the kill pays salvage and the multiplier exactly as any
 *     other kill does — see `Session.destroySpinner`. The spinners are
 *     diametrically opposite by construction, so the near one is at best a ring
 *     radius away and the far one is at worst two: committing to this means
 *     crossing the enclosed space and abandoning whatever cover you had, while
 *     the wave that arrived with the Loom is still shooting. That trade *is* the
 *     encounter.
 *  2. Leave, through a gap or over the top while it is still low. Costs nothing
 *     and pays nothing. Deliberately easy early and deliberately harder later —
 *     a choice offered, not a trap sprung.
 *  3. Hyperwarp out. The same as leaving, and priced at nothing extra: the jump
 *     already costs half the multiplier, and charging a second price for the
 *     same escape is how an escape valve stops being one.
 *  4. Let it close around you. Then the ring begins to contract and the only
 *     remaining answer is to kill a spinner — which is always available, which
 *     is what keeps this a hard state rather than a death sentence. Note also
 *     that a ring which has contracted past you has *let you out*, at the price
 *     of whatever the wall took off your shields on the way through. That is not
 *     an oversight; it is the guarantee that this can always end.
 *
 * **Colour.** No new hue, and the one it takes is the one that already means
 * this. `PALETTE.harrow` is documented as "the mine-layer, **and its mines**" —
 * violet is already the colour of a machine that sows rather than shoots and of
 * the hazard it leaves lying about the sector. A strand is that noun exactly: an
 * inert thing left in space that hurts you if you fly into it and can be flown
 * around if you read the board. Spending a sixth hostile hue here would say
 * "another class to shoot" when what needs saying is "a hazard has been laid",
 * and the wheel has no gap left that is clear of five hostile hues, the player's
 * cyan and the unresolved magenta. Silhouette is what tells a spinner from a
 * Harrow — see `buildSpinner` — and the glyph is what tells them apart on the
 * tube. Cyan was never a candidate: cyan is *ours*.
 *
 * **The strands are strokes, not objects.** Every filament goes through
 * `TraceBuffer` with the beams and the debris and the corridor guides. A hundred
 * and twenty-six of them as `VectorObject`s would be a hundred and twenty-six
 * materials for something that is, in the end, a line.
 *
 * Nobody has flown any of this. It ships behind `encounters.loom` for the same
 * reason `flight.threeD` exists, and it takes **no new keyboard binding** — the
 * control surface is full and that is documented. The way to see one on demand
 * is `window.__loom.seed()` on localhost.
 */

/**
 * Every number the Loom is, and every one of them a first-draft guess of exactly
 * the same species as `ALTITUDE.ceiling` or `Ship.TURN_ACCEL`. Reasoned about,
 * never flown. They belong on the tuning list in `docs/todo.md` §1 beside the
 * rest of the slab's constants, and `rise` in particular is the one whose value
 * decides whether this encounter is interesting or trivial.
 */
export const LOOM = {
  /**
   * Chance at a wave break that a Loom opens. Rare on purpose: this is a change
   * of subject, not a difficulty step, and a change of subject every other wave
   * is just the subject. At 0.1 from wave four onward a run meets one somewhere
   * around wave fourteen, which is deep enough that the player has a habit worth
   * interrupting. Checked once, at the break — never mid-wave, because a wall
   * that materialises around a fight already in progress is a thing that happens
   * *to* you rather than a thing you are offered.
   */
  chance: 0.1,
  /**
   * Escalation index — `wave + threat - 1`, the same number the roster reads —
   * below which it never opens. Four is where the Harrow arrives, and for the
   * same reason: the player needs a flying habit before a hazard aimed at one
   * means anything.
   */
  earliest: 4,

  /**
   * The ring, in world units.
   *
   * Sized against two things that already exist. A wave spawns at 95-140 units,
   * so anything smaller than this would put the fight the Loom arrives with
   * *outside* the wall and the player would leave by simply engaging it. And the
   * scanner reaches 150, so at 138 the ring lands just inside the tube's rim and
   * is drawn as a closing circle rather than pinned to the edge as a smear.
   *
   * It is also what makes ending 1 cost something: 138 is well past the phaser's
   * 78-unit reach, so a spinner cannot be sniped from the middle. You have to go.
   */
  radius: 138,
  /**
   * Radians per second. Each spinner has half the circle to cover, so the ring
   * seals after `π / rate` — eighteen seconds, which is about three wave-one
   * engagements and short enough to read as a clock rather than as weather.
   *
   * At this rate a spinner's tangential speed is 24 units a second, between a
   * Lance and a Bastion. Not fast against a cruiser doing 62 — the clock was
   * chosen first and the speed fell out of it — so what makes a spinner hard to
   * reach is the distance and the fact that its twin is always on the far side,
   * never its legs.
   */
  angularRate: 0.175,
  /**
   * Bearing between adjacent strands. At the full radius this is a seven-unit
   * gap, against a hull 5.2 units across: threadable, and threading it is the
   * skill. 126 strands to close the circle.
   */
  strandStep: 0.05,

  /**
   * Wall height when the first strand goes down. Well under the ceiling, so the
   * lid is unambiguously open at the moment the encounter announces itself.
   */
  startHeight: 3.5,
  /**
   * Units per second the whole wall grows. **The number this encounter turns
   * on.** At 0.9 the top passes `ALTITUDE.ceiling` after about twelve seconds of
   * an eighteen-second weave, so the lid shuts before the ring does and "over
   * the top" is the *first* escape to close — which is the ordering that makes
   * altitude buy time rather than immunity.
   *
   * The whole wall shares one height rather than each strand growing from its
   * own birth. One clock is legible; a fence that is tall where it is old and
   * short where it is new reads as damage rather than as a timer, and would put
   * the escape route in the least intuitive place on the board.
   */
  rise: 0.9,
  /**
   * How far the finished wall stands above the flight ceiling. Four units of
   * genuine overhang, so a sealed lid is sealed by a margin a player can see and
   * not by a rounding error they will spend a run arguing with.
   */
  overhang: 4,

  /** Horizontal reach of a filament. Thin — this is a wire, not a barrier. */
  strandRadius: 1.6,
  /**
   * What brushing one costs. Between a bolt (0.3) and a mine (0.62): a wall you
   * flew into, not a warhead that went off. It routes through `Ship.takeHit`
   * like everything else, so the facing that touched it absorbs it and turning a
   * fresh quarter toward the wall is the same skill it has always been.
   */
  strandDamage: 0.45,
  /**
   * Seconds before the same filament can bite again. Without it a wire touched
   * at the frame rate is a wire that kills instantly; with it, flying *along*
   * the fence still costs one hit per strand crossed, which is the price it
   * should be.
   */
  touchCooldown: 0.9,

  /**
   * Units per second the sealed ring closes in. Twenty-five seconds from the
   * full radius to the floor of it, which is long enough that the player is
   * being squeezed rather than crushed and short enough that doing nothing is
   * not a plan.
   */
  contractRate: 5,
  /** The ring never draws tighter than this. Below it there is no sector left. */
  minRadius: 14,

  /**
   * How far past the ring counts as out. Prevents the encounter ending and
   * un-ending while a player skims the wall.
   */
  escapeMargin: 10,

  /** Seconds the wall takes to fall back into the floor once the weave fails. */
  collapse: 1.8,

  /** A spinner. Fragile by design: two point-blank phaser shots, or one torpedo. */
  hull: 0.5,
  /** Body radius, for hit resolution and for the phaser's aim assist. */
  bodyRadius: 2.4,
  scale: 1.3,
  /**
   * Salvage for one. The largest single figure in the game — a Shroud is 400 —
   * because it is the only kill that costs you the whole width of the sector and
   * your position in the fight you were already in.
   */
  value: 500,
};

/**
 * The switches, so the game can be played without either encounter.
 *
 * Same shape and same reasoning as `flight.threeD`: nobody has flown these, so
 * they ship as toggles rather than as facts, and off, the game is exactly what
 * it was — `Session.seedLoom` refuses and nothing else in `loom.ts` is ever
 * reached; `game/comet.ts`'s schedulers are pure functions with no switch of
 * their own, so whatever calls them (Tasks 2-4) is expected to check
 * `encounters.comet` first, the same way `Loom.open` checks `encounters.loom`.
 *
 * One object rather than one flag per file: a single place to see and flip
 * every encounter this game can turn off is the point, and a second export
 * beside this one would be a second place to remember to check.
 *
 * Deliberately **not** on a key, either of them. The control surface is full
 * and that is a documented constraint, and a display toggle for something that
 * appears once in fourteen waves would be a binding spent on a thing nobody
 * could see the effect of. Localhost gets `window.__loom.seed()` instead,
 * which is what a harness or a person actually tuning this needs: not a
 * switch, a summons.
 */
export const encounters = {
  loom: true,
  comet: true,
};

export type LoomPhase = "none" | "weaving" | "sealed" | "fading";

/** One filament. Position is the ring's, not its own — see `Loom.radius`. */
interface Strand {
  readonly bearing: number;
  /** Seconds since it was laid. A new filament runs hot and cools. */
  age: number;
  /** Counting down; while positive this strand cannot bite again. */
  cool: number;
  /** Non-zero briefly after it has been touched, so the stroke flashes. */
  flash: number;
}

/**
 * One end of the weave.
 *
 * It has no steering law, no target and no gun, which is why it is fifty lines
 * rather than three hundred: its bearing is the encounter's own clock plus half
 * a turn for the second one, and its height is the top of the wall it is
 * drawing. That last part is not decoration — a spinner riding the lip of its
 * own fence is how the wall's height is read from the cockpit without a number.
 * Once the wall is over the ceiling the spinner is somewhere the player cannot
 * fly, which says "you are not getting over this" in the only vocabulary the
 * forward view has. It stays perfectly shootable, because aim in this game is a
 * bearing and the guns have always trained in elevation on their own.
 */
export class Spinner {
  readonly position = new Vector3();
  hull = LOOM.hull;
  /** Non-zero briefly after being hit, so the strokes flash. */
  flash = 0;
  dead = false;
  /** Added to the ring radius. Zero while it is working; grows as it leaves. */
  outward = 0;

  constructor(
    /** Half a turn apart, fixed at construction: 0 or π. */
    readonly offset: number,
    readonly shape: VectorObject,
  ) {}

  /** @returns true if this was the killing blow. */
  damage(amount: number): boolean {
    this.hull -= amount;
    this.flash = 1;
    if (this.hull <= 0) this.dead = true;
    return this.dead;
  }
}

export class Loom {
  phase: LoomPhase = "none";

  /** Where the ring is centred: wherever the player was standing when it opened. */
  readonly centre = new Vector3();
  /**
   * Annotated, because `LOOM.radius` is a literal under `as const` and an
   * inferred field type of `138` refuses every value a contraction produces —
   * the same reason `Ship.torpedoes` carries an annotation.
   */
  radius: number = LOOM.radius;
  readonly spinners: Spinner[] = [];
  readonly strands: Strand[] = [];

  /** Seconds since it opened. Drives the wall's height and nothing else. */
  age = 0;

  /**
   * A line waiting to be said, in the same idiom `Escort.says` uses and for the
   * same reason: the panel has one comms row and all the rules live in
   * `Session`. Written here, cleared by `Session.stepLoom`.
   */
  says: string | null = null;

  /** Bearing the first pair went down at. The whole ring is measured off it. */
  private start = 0;
  /** Total radians each spinner has covered. Always advances while it exists. */
  private orbit = 0;
  /** Index of the next strand pair to lay. */
  private nextStrand = 0;
  /** 1 while the wall stands, easing to 0 through `LOOM.collapse`. */
  private fade = 1;

  private readonly pool: VectorObject[] = [];

  constructor(private readonly makeShape: () => VectorObject) {}

  get active(): boolean {
    return this.phase !== "none";
  }

  /**
   * Height of the wall right now, in world units.
   *
   * Note that this rises whether or not the slab is switched on. With
   * `flight.threeD` off there is no "over the top" for it to be gating, so the
   * rise buys the player nothing — but the wall is *structure*, like the
   * starbase's ring, and structure has height in this game whether or not the
   * ship can use it. One code path, and the version of the encounter you get
   * without a third dimension is honestly the version with one escape missing.
   */
  get height(): number {
    return (
      Math.min(LOOM.startHeight + LOOM.rise * this.age, ALTITUDE.ceiling + LOOM.overhang) * this.fade
    );
  }

  /** True once the top is above anything the player can climb to. */
  get sealed(): boolean {
    return flight.threeD && this.height >= ALTITUDE.ceiling;
  }

  /**
   * Opens one around `player`.
   *
   * Refused when the switch is off, when one is already up, and — deliberately —
   * never called from anywhere but a wave break. See `Session.spawnWave`.
   */
  open(player: Ship): void {
    if (!encounters.loom || this.active) return;

    this.phase = "weaving";
    this.centre.copy(player.position).setY(0);
    this.radius = LOOM.radius;
    this.age = 0;
    this.orbit = 0;
    this.nextStrand = 0;
    this.fade = 1;
    this.strands.length = 0;
    // The opening bearing is random, so two Looms in one run do not build the
    // same fence with the same gap in the same place.
    this.start = Math.random() * Math.PI * 2;

    for (const offset of [0, Math.PI]) {
      const shape = this.pool.pop() ?? this.makeShape();
      shape.group.visible = true;
      shape.group.scale.setScalar(LOOM.scale);
      shape.setColor(PALETTE.harrow);
      this.spinners.push(new Spinner(offset, shape));
    }

    this.says = "WEAVE DETECTED";
    sound.loomOpen(this.centre.x, this.centre.z);
  }

  /**
   * @param onHull called when a filament's damage gets past a shield facing —
   *   the same callback shape the minefield uses, and for the same reason: who
   *   pays for a hull breach is a rule, and the rules live in `Session`.
   */
  update(dt: number, player: Ship, onHull: () => void): void {
    if (!this.active) return;

    this.age += dt;
    this.orbit += LOOM.angularRate * dt;

    if (this.phase === "fading") {
      // The wall falls back into the floor and the survivor runs for the edge of
      // the sector. Both are on the same clock, so the encounter ends once
      // rather than in two stages.
      this.fade = Math.max(0, this.fade - dt / LOOM.collapse);
      for (const spinner of this.spinners) spinner.outward += 90 * dt;
      this.place(dt);
      if (this.fade <= 0) this.clear();
      return;
    }

    if (this.phase === "weaving") this.weave();
    else this.radius = Math.max(LOOM.minRadius, this.radius - LOOM.contractRate * dt);

    this.place(dt);
    this.bite(dt, player, onHull);

    // Checked after the wall has moved and bitten, so a player squeezed out by a
    // contracting ring pays for the crossing before they are called clear.
    const dx = player.position.x - this.centre.x;
    const dz = player.position.z - this.centre.z;
    if (Math.hypot(dx, dz) > this.radius + LOOM.escapeMargin) {
      this.says = "WEAVE ASTERN";
      this.collapse();
    }
  }

  /**
   * Lays whatever the clock has earned since the last frame.
   *
   * A `while` rather than an `if` because a clamped 50ms frame covers more than
   * one strand's worth of bearing, and a fence with holes in it wherever the
   * machine stuttered is the same class of bug as a trail that lengthens on a
   * slow one.
   */
  private weave(): void {
    const swept = Math.min(this.orbit, Math.PI);
    while (this.nextStrand * LOOM.strandStep <= swept) {
      const bearing = this.start + this.nextStrand * LOOM.strandStep;
      // Both ends of the weave, half a turn apart, on the same tick — which is
      // what makes the two arcs meet exactly rather than approximately.
      for (const offset of [0, Math.PI]) {
        this.strands.push({ bearing: bearing + offset, age: 0, cool: 0, flash: 0 });
      }
      sound.loomStrand(
        this.centre.x + Math.sin(bearing) * this.radius,
        this.centre.z + Math.cos(bearing) * this.radius,
      );
      this.nextStrand++;
    }

    if (this.orbit < Math.PI) return;
    this.phase = "sealed";
    this.says = "WEAVE SEALED";
    sound.loomSeal();
  }

  /** Puts both spinners on the ring, at the lip of the fence they are drawing. */
  private place(dt: number): void {
    // Pinned to the floor with the slab off, exactly as every hostile and every
    // projectile is: with the switch off nothing in this game leaves the plane,
    // and that is a structural guarantee rather than an arithmetic one.
    const top = flight.threeD ? this.height : 0;
    for (const spinner of this.spinners) {
      const bearing = this.start + this.orbit + spinner.offset;
      const r = this.radius + spinner.outward;
      spinner.position.set(
        this.centre.x + Math.sin(bearing) * r,
        top,
        this.centre.z + Math.cos(bearing) * r,
      );
      spinner.flash = Math.max(0, spinner.flash - dt * 5);
      spinner.shape.group.position.copy(spinner.position);
      // Turned edge-on to the ring, so the emitter faces the filament it is
      // pulling out of itself rather than facing the way it happens to be going.
      spinner.shape.group.rotation.y = bearing;
      spinner.shape.setIntensity((1 + spinner.flash * 1.6) * Math.max(0.15, this.fade));
    }
  }

  /**
   * Contact. Horizontal distance to the filament and height against the wall,
   * which is the honest test for a vertical wire: a ship above the top of the
   * fence is over it, and a ship below is in it.
   *
   * Nothing else in the sector is checked. The hostiles pass through their own
   * side's machinery untouched, which is both the obvious fiction and the reason
   * this cannot be farmed — a wall that killed hostiles would turn the encounter
   * into a free herding weapon and the payoff into an accident.
   */
  private bite(dt: number, player: Ship, onHull: () => void): void {
    const top = this.height;
    for (const strand of this.strands) {
      strand.age += dt;
      strand.cool = Math.max(0, strand.cool - dt);
      strand.flash = Math.max(0, strand.flash - dt * 4);
      if (strand.cool > 0) continue;

      const x = this.centre.x + Math.sin(strand.bearing) * this.radius;
      const z = this.centre.z + Math.cos(strand.bearing) * this.radius;
      if (Math.hypot(player.position.x - x, player.position.z - z) > LOOM.strandRadius) continue;
      if (player.position.y >= top) continue;

      strand.cool = LOOM.touchCooldown;
      strand.flash = 1;
      sound.loomTouch(x, z);
      // Same routing every other hit in the game gets: the facing pointed at the
      // filament absorbs what it can and the rest is a breach. There is
      // deliberately no second damage path here.
      if (player.takeHit(LOOM.strandDamage, new Vector3(x, player.position.y, z))) onHull();
    }
  }

  /**
   * The weave fails: no more strands, the wall falls, whoever is left runs.
   *
   * Called for a kill, for an escape and for a hyperwarp alike — the *reason* is
   * a rule and belongs to `Session`; what happens to the machinery is the same
   * either way.
   */
  collapse(): void {
    if (this.phase === "fading" || this.phase === "none") return;
    this.phase = "fading";
    sound.loomCollapse(this.centre.x, this.centre.z);
  }

  /** Nearest spinner inside the aim cone. Mirrors `Minefield.aim` exactly. */
  aim(
    origin: Vector3,
    forward: Vector3,
    cone: number,
    maxRange: number,
  ): { spinner: Spinner; distance: number } | null {
    if (this.phase === "none" || this.phase === "fading") return null;
    let best: { spinner: Spinner; distance: number } | null = null;
    for (const spinner of this.spinners) {
      const toTarget = spinner.position.clone().sub(origin);
      const distance = toTarget.length();
      if (distance > maxRange || distance < 1e-3) continue;
      if (bearingOffset(forward, toTarget.x, toTarget.z) > cone + LOOM.bodyRadius / distance) {
        continue;
      }
      if (!best || distance < best.distance) best = { spinner, distance };
    }
    return best;
  }

  /** Everything gone, render objects back in the pool. */
  clear(): void {
    for (const spinner of this.spinners) {
      spinner.shape.group.visible = false;
      spinner.shape.setIntensity(1);
      this.pool.push(spinner.shape);
    }
    this.spinners.length = 0;
    this.strands.length = 0;
    this.phase = "none";
    this.says = null;
    this.fade = 1;
    this.age = 0;
    this.orbit = 0;
    this.nextStrand = 0;
    this.radius = LOOM.radius;
  }

  /**
   * The fence, as strokes.
   *
   * Each filament is one vertical segment standing on the floor, plus a rail
   * running forward to where the next one will be. The rail is what turns a
   * hundred and twenty-six spikes into a wall — without it the eye reads a field
   * of loose marks and never reads a boundary. At the leading edge it overhangs
   * into the gap by one step, which is exactly right: the weave is reaching.
   *
   * A new strand runs hot and cools to a steady picket over a couple of seconds,
   * so the two ends of the weave are visibly where the work is happening.
   */
  draw(trace: TraceBuffer): void {
    if (!this.active) return;

    const top = this.height;
    // Fainter than a mine and much more of it: a hundred and twenty-six bright
    // strokes across the horizon would be the only thing on screen.
    for (const strand of this.strands) {
      const x = this.centre.x + Math.sin(strand.bearing) * this.radius;
      const z = this.centre.z + Math.cos(strand.bearing) * this.radius;
      const hot = Math.exp(-strand.age * 1.2);
      const level = (0.32 + hot * 1.4 + strand.flash * 2.4) * this.fade;

      trace.push(x, 0, z, x, top, z, PALETTE.harrow, level);

      const next = strand.bearing + LOOM.strandStep;
      trace.push(
        x,
        top,
        z,
        this.centre.x + Math.sin(next) * this.radius,
        top,
        this.centre.z + Math.cos(next) * this.radius,
        PALETTE.harrow,
        level * 0.5,
      );
    }

    // The filament each spinner is currently drawing, from the machine down to
    // the floor. Brighter than the wall and only two of them, so what the eye
    // finds first is where the work is — which is also where the kill is.
    for (const spinner of this.spinners) {
      if (this.phase === "fading") continue;
      trace.push(
        spinner.position.x,
        spinner.position.y,
        spinner.position.z,
        spinner.position.x,
        0,
        spinner.position.z,
        PALETTE.harrow,
        2.2,
      );
    }
  }
}
