import { Color, Group, Object3D, PointLight, Vector3 } from "three";

/**
 * The world lit by what happens in it.
 *
 * Every flash this game has ever produced — a warhead detonating, a hull
 * coming apart, a phaser discharging, a Shroud dropping its veil — has been
 * *bloom*: a bright additive stroke, thresholded and blurred in screen space
 * by `Stage`'s `UnrealBloomPass`. Bloom is a property of the image, not of the
 * place. It never reached anything. A torpedo could go off two units from an
 * asteroid and the asteroid would not notice, because nothing in the scene
 * emitted light — the only light there has ever been is the sector's star
 * (`render/light.ts`, `main.ts`'s `sun`/`sunFill`), which is fixed, distant
 * and unchanging by construction.
 *
 * That gap only became visible once the world became lit. `render/Asteroids.ts`
 * shades its rocks with a `MeshLambertMaterial`, and `render/VectorObject.ts`
 * now does the same for every hull's occluder fill — both sample scene lights
 * through three.js's own pipeline, automatically, and both therefore respond to
 * anything this file puts in the scene. This is the pool that puts something
 * there.
 *
 * ## The one design decision, and it is the whole file
 *
 * **The lights are allocated once, at construction, and never added or removed
 * again.** Idle lights are animated to zero intensity, not hidden, not
 * detached, not disposed.
 *
 * This is not an optimisation, it is a correctness requirement about *when the
 * cost lands*. three.js builds a program cache key that includes the count of
 * each light type in the scene (`WebGLPrograms.getProgramCacheKey` reads
 * `lights.state` — `numPointLights` among them), so changing how many lights
 * are visible recompiles every lit material's shader program. A recompile is
 * tens of milliseconds against a 16.6 ms frame. Allocating a `PointLight` when
 * a warhead detonates would therefore stall the frame *on the frame the warhead
 * detonates* — which is to say the game would hitch on exactly the events this
 * file exists to make feel good, and it would do it worse the busier the fight
 * got. A pool that costs a steady, boring amount every frame is strictly better
 * than one that is free until the moment it is not.
 *
 * **`visible` is not an escape hatch.** three.js's `WebGLLights.setup` skips
 * `light.visible === false` when it counts, so hiding a pooled light is exactly
 * as expensive as removing it: same recompile, same hitch, arrived at by a
 * route that *looks* free. Nothing in this file ever writes `visible`, and
 * `update` drives `intensity` to a hard 0 instead — the shader still evaluates
 * the light, and multiplying by zero is what makes an idle slot honest.
 *
 * ## What idle actually costs
 *
 * CPU: nothing. `update` returns on its first line while the pool is empty.
 *
 * GPU: a permanent, unavoidable N point lights' worth of arithmetic on every
 * fragment of every lit material in the scene, whether any of them are on or
 * not. `PointLight.distance` does **not** rescue this — the cutoff radius
 * zeroes a light's *contribution* past its reach, it does not cull the light
 * out of the shader, and there is no per-fragment branch that skips it. That
 * is the price of never recompiling and it is why `count` is small and why
 * this docblock says so rather than letting a later reader discover that eight
 * lights are not free after all. Fill rate is this game's whole budget
 * (`docs/environment.md` §1) and lit geometry is what this spends it on.
 *
 * ## What it does not light
 *
 * Only materials three.js feeds scene lights to. That is `MeshLambertMaterial`
 * and friends — hull occluder fills, asteroid clusters — and nothing else.
 * Every stroke in the game is an additive `LineMaterial`, unlit by definition
 * and deliberately so (`VectorObject`'s own header: the strokes *are* the light
 * rather than receiving it, and "colour is information" prices every hue). The
 * hero bodies are further exempt by a different route: `GasGiant`, `Moon` and
 * `SunHero` are hand-written `ShaderMaterial`s, which three.js never feeds
 * scene lights automatically, and they read `render/light.ts`'s `SectorLight`
 * straight into their own uniforms instead. A gas giant will therefore not
 * flicker when a torpedo goes off in front of it — correctly, since it is
 * thousands of units away.
 *
 * So the visible effect is: **hulls and rocks catch the light of what happens
 * between them.** That is the whole intended read, and it is enough — those are
 * the only opaque surfaces in the near field.
 */

/**
 * Every number the pool is. First-draft guesses of the same species as `LOOM`,
 * `COMET` and `BRACE` — reasoned about, never flown — and candidates for
 * `docs/todo.md`'s tuning list. `reference` and `floor` are the two worth
 * flying first: they are what the caller-facing `intensity` argument *means*,
 * so moving either silently rescales every call site at once.
 */
export const EVENT_LIGHT = {
  /**
   * How many lights the pool stands up by default. See `EventLights`'s own
   * constructor for the argument; this is the number that argument defaults to.
   *
   * Eight, and the reasoning is a ceiling on *simultaneous* events rather than
   * on events per run. The things worth lighting are: a torpedo detonation
   * (`TORPEDO.cooldown` is 0.62 s and `TORPEDO.life` is 1.5 s, so at most two
   * or three of the player's are ever in flight), a kill (a wave is five to
   * eight hostiles and a torpedo can take two at once through
   * `TORPEDO.blast`), a hull breach, a mine going off, and a decloak. A
   * genuinely awful moment — a warhead landing into a clustered wave while a
   * bolt reaches the hull — is four or five overlapping half-second flashes.
   * Eight covers that with two slots of headroom and stops well short of the
   * point where the permanent per-fragment cost above starts showing up in a
   * frame budget that has ~12 ms spare.
   *
   * It is a power of two for no reason at all; nothing in three.js rounds
   * light counts. Do not read one into it.
   */
  count: 8,
  /**
   * The distance, in world units, at which a caller's `intensity` argument
   * means what it says.
   *
   * three.js has been physically correct since r155 — `useLegacyLights` is
   * gone in 0.185 — so a `PointLight`'s `intensity` is candela and the
   * irradiance it delivers is `intensity / distance²` under the default
   * `decay = 2`. Handing that unit to a game caller would be a trap: the
   * numbers are huge, they are meaningless without knowing the range, and
   * nothing at any call site would be comparable to anything else.
   *
   * So the API takes a number in **the same units as `main.ts`'s `sun`
   * intensity (1.4)**, understood as the irradiance at this distance, and
   * multiplies by `reference²` on the way in. `flash(..., 4, ...)` therefore
   * reads as "four times as bright as the sector's star, twelve units away" —
   * which is a sentence a call site can be argued with about. At six units
   * that same flash is sixteen times the star; at forty-eight it is a
   * quarter. Inverse square does the rest.
   *
   * Twelve because it is roughly one hostile hull's length (radii run 4.4 to
   * 8) and sits just inside the bottom of the engagement band (14–78 units,
   * `PHASER.falloffEnd`). It is the range at which "a warhead went off *next
   * to* that thing" is true.
   */
  reference: 12,
  /**
   * The irradiance a light is allowed to fall to before its cutoff radius is
   * placed, as a fraction of the star. 0.02 is about 1.4% of `sun`'s 1.4 —
   * comfortably below the point where a hull's night side would visibly lift.
   *
   * This is what sizes `PointLight.distance` per flash, so a small flash gets
   * a small sphere and a big one reaches further. It buys **no performance**
   * (see the docblock above — the cutoff does not cull), and it is not here
   * for performance. It is here because three.js's cutoff term is
   * `(1 - (d/cutoff)⁴)²`, which reaches exactly zero at the boundary, and a
   * light with a real boundary cannot leave a faint permanent wash across the
   * whole sector the way an uncapped inverse square does — the far edge of a
   * minefield should not brighten by a hair because something detonated
   * eighty units away.
   */
  floor: 0.02,
  /**
   * Hard ceiling on that computed cutoff radius, in world units. Past this the
   * light is reaching further than the scene's own fog far plane (`Stage`
   * fogs to black by 260) and the extra reach is arithmetic nobody sees.
   */
  maxRadius: 400,
} as const;

/**
 * How a light's output moves across its life.
 *
 * `t` runs 0 → 1 across the flash's own `seconds`; the return is a 0–1
 * multiplier on its peak. **A curve must return 0 at t = 1**, or the light
 * snaps off at the end of its life instead of arriving there — which reads as
 * a bug even when the flash was only 80 ms long. `CURVES` below all do; a
 * caller writing its own is responsible for it, and the cheapest way to get it
 * right is to build on `fallingExp` rather than reach for a bare `Math.exp`.
 *
 * It is a parameter rather than a constant because the shapes genuinely differ
 * in kind and not merely in duration: a detonation is a step followed by a
 * collapse, a fireball grows before it dies, and a tractor beam or an engine
 * glow is flat with an ending. One hardcoded curve would have made every event
 * in the game the same event at different lengths.
 */
export type DecayCurve = (t: number) => number;

/**
 * An exponential fall, renormalised so it starts at exactly 1 and lands on
 * exactly 0.
 *
 * A bare `exp(-kt)` never reaches zero, so a light built on one has to be cut
 * off while still emitting — the snap this file's `DecayCurve` contract exists
 * to forbid. Subtracting the tail and rescaling costs two constants computed
 * once at module load and removes the failure mode entirely.
 *
 * @param k how hard it falls. 4 is a slow bloom-out, 11 is nearly a single
 *          frame.
 */
export function fallingExp(k: number): DecayCurve {
  const tail = Math.exp(-k);
  const span = 1 - tail;
  return (t) => (Math.exp(-k * t) - tail) / span;
}

const SWELL_RISE = 0.12;
const swellBody = fallingExp(4);

/**
 * The shapes worth having names. Callers may pass any `DecayCurve`; these are
 * the ones the game's own events actually want, kept together so two call
 * sites that mean the same thing cannot drift into two slightly different
 * hand-rolled curves.
 */
export const CURVES: Record<"spike" | "snap" | "swell" | "steady" | "linear", DecayCurve> = {
  /**
   * A detonation. Full brightness on the first frame, most of it gone in a
   * third of the life, a dim tail after. The default, and what a torpedo, a
   * mine and a kill all want.
   */
  spike: fallingExp(5.5),
  /**
   * A discharge. Almost all of it inside the first fifth — this is for things
   * that are *events* rather than *explosions*: a phaser firing, a shield
   * facing taking a bolt. Paired with a short `seconds` it is a stab of light,
   * not a flash.
   */
  snap: fallingExp(11),
  /**
   * A fireball. Rises over the first eighth of its life, then falls. Slower to
   * arrive than `spike` and worth the difference only on the largest events —
   * a heavy kill, the player's own death — where the extra ~60 ms of growth is
   * long enough to read as expansion rather than as latency.
   */
  swell: (t) => (t < SWELL_RISE ? t / SWELL_RISE : swellBody((t - SWELL_RISE) / (1 - SWELL_RISE))),
  /**
   * Flat, then an ending. Held at full until the last sixth, then cosine-eased
   * to zero. For anything that is a *state* rather than an event — a tractor
   * beam, a braced bow's overcharge, an engine glow — driven by `sustain`
   * every frame so the ending only ever plays when the caller stops asking.
   */
  steady: (t) => (t < 0.84 ? 1 : 0.5 + 0.5 * Math.cos(((t - 0.84) / 0.16) * Math.PI)),
  /** The dull one, kept because sometimes a ramp is what is meant. */
  linear: (t) => 1 - t,
};

export interface FlashOptions {
  /** Defaults to `CURVES.spike`. See `DecayCurve` for the one contract. */
  curve?: DecayCurve;
  /**
   * Override the cutoff radius, in world units, instead of deriving it from
   * `intensity` and `EVENT_LIGHT.floor`. Rarely wanted — the derived radius is
   * right whenever the light is meant to obey inverse square — but a caller
   * that wants a deliberately local glow (a cockpit-adjacent tell that must
   * not wash a hostile forty units away) has no other way to say so.
   */
  radius?: number;
}

/**
 * A claim on one slot, valid only while that slot is still running the flash
 * that produced it.
 *
 * `serial` is the guard, and it is what makes eviction safe rather than merely
 * fast: a slot's serial increments every time it is claimed or cleared, so a
 * handle held across an eviction fails the equality check in `sustain` and
 * gets a fresh slot instead of silently steering someone else's explosion.
 * Without it, a caller holding a stale handle would drive whatever light
 * happened to inherit its index — a bug that would look like an explosion
 * following a ship around.
 *
 * Plain data on purpose: no methods, no back-reference to the pool, nothing to
 * dispose. A caller may keep one forever or drop it on the floor.
 */
export interface LightHandle {
  readonly slot: number;
  readonly serial: number;
}

interface Slot {
  readonly light: PointLight;
  /** Seconds elapsed into this flash. */
  elapsed: number;
  /** Total life. 0 means idle — the one flag, so there is nothing to keep in sync. */
  seconds: number;
  /** Peak candela, already converted from the caller's star-relative number. */
  peak: number;
  curve: DecayCurve;
  serial: number;
}

/** A dead handle nothing will ever match. Returned by a pool of size zero. */
const NO_HANDLE: LightHandle = { slot: -1, serial: -1 };

export class EventLights {
  /**
   * Everything the pool owns, in one node. Added to the scene as a unit so a
   * caller cannot half-install it, and so the pool has somewhere to hang if a
   * later scene ever wants the lights under a transform.
   *
   * **It must be added to a node with an identity world transform**, because
   * every position handed to `flash` is a world position and gets written
   * straight onto a light parented here. `main.ts` adds it to `stage.scene`,
   * which satisfies this; nothing checks it, because the check would be a
   * matrix decomposition every frame to catch a mistake that is visible
   * instantly the first time anything explodes.
   */
  readonly group = new Group();

  private readonly slots: Slot[] = [];
  /** How many slots are running. Kept so `update` can leave on its first line. */
  private running = 0;

  /**
   * @param count how many lights to stand up. Fixed for the life of the pool —
   *        there is no `setCount`, deliberately, because changing it is exactly
   *        the shader recompile this whole file exists to avoid and hiding that
   *        behind a setter would make it look cheap. A build that wants a
   *        different size constructs a different pool, between runs, and
   *        swallows one recompile at a moment nothing is exploding.
   *
   * Constructing this is the recompile. **Build it at boot, before the first
   * frame that draws lit geometry** — build it lazily on the first explosion
   * and the hitch simply moves to the first explosion, which is the defect
   * with extra steps.
   */
  constructor(count: number = EVENT_LIGHT.count) {
    for (let i = 0; i < Math.max(0, count | 0); i++) {
      // Colour is white and intensity is 0 until something claims this. Note
      // that three.js multiplies `color * intensity`, so an idle slot
      // contributes literal zero regardless of what colour it last carried —
      // there is nothing to reset on release.
      const light = new PointLight(0xffffff, 0, 1, 2);
      // Shadows would be ruinous and are not on by default; said out loud
      // because a point light shadow is a cube render — six passes of the whole
      // scene, per light, per frame — and this file allocating eight of them is
      // exactly the shape of mistake a later reader might "fix" into existence.
      light.castShadow = false;
      // `decay = 2` is the constructor argument above and is the physically
      // correct inverse square. Restated rather than left implicit because
      // `EVENT_LIGHT.reference`'s whole conversion assumes it: change this and
      // every call site's intensity means something else.
      light.decay = 2;
      this.group.add(light);
      this.slots.push({
        light,
        elapsed: 0,
        seconds: 0,
        peak: 0,
        curve: CURVES.spike,
        serial: 0,
      });
    }
  }

  /** How many slots are currently emitting. For diagnostics and the harness. */
  get active(): number {
    return this.running;
  }

  /** How many slots exist. Fixed at construction; see the constructor. */
  get size(): number {
    return this.slots.length;
  }

  /**
   * Light the world from `position`, in `color`, at `intensity`, for `seconds`.
   *
   * `intensity` is in **units of the sector star's own intensity at
   * `EVENT_LIGHT.reference` units** — see that constant. 1 is "as bright as the
   * star, twelve units away"; 4 is a warhead; past about 12 a near hull's fill
   * crosses `Stage`'s 0.5 bloom threshold and starts blooming, which is
   * correct for standing inside a fireball and wrong for anything else.
   *
   * **Never fails and never drops.** If every slot is busy, one is taken — see
   * `claim` for which and why. A dropped explosion is worse than a stolen one
   * because the dropped one is guaranteed to be the newest, and the newest is
   * the one the player just caused and is therefore looking at.
   *
   * Allocation-free: nothing here builds a `Vector3`, a `Color` or an options
   * object, because this runs from the middle of the projectile-resolution
   * loop where a wave dying at once can call it half a dozen times in a frame.
   *
   * @returns a handle, for `sustain` or `release`. Ignoring it is normal — a
   *          one-shot flash has nothing to steer.
   */
  flash(
    position: Vector3,
    color: Color,
    intensity: number,
    seconds: number,
    opts: FlashOptions = {},
  ): LightHandle {
    if (this.slots.length === 0 || intensity <= 0 || seconds <= 0) return NO_HANDLE;

    const index = this.claim();
    const slot = this.slots[index];
    // A claimed *idle* slot grows the running count; a claimed *busy* one was
    // already counted and is being overwritten in place, which is why this is
    // the only line in `flash` that has to know which kind of claim it got.
    if (slot.seconds <= 0) this.running++;

    // The serial moves because this is a new claim on the slot, which is
    // exactly the event any outstanding handle needs to be told about — see
    // `LightHandle`. `sustain`'s in-place path deliberately does not.
    slot.serial++;
    this.arm(slot, position, color, intensity, seconds, opts.curve ?? CURVES.spike, opts.radius);

    return { slot: index, serial: slot.serial };
  }

  /**
   * Re-arm the flash `handle` refers to, or start a fresh one if that flash is
   * over or was evicted.
   *
   * This is how a *state* holds a light: call it every frame with a short
   * `seconds` (0.15 or so) and `CURVES.steady`, and the light persists exactly
   * as long as the caller keeps asking and then eases out on its own when the
   * caller stops. There is no `hold`/`release` pair to leak, which is the point
   * — a pool whose slots can be checked out indefinitely is a pool that
   * eventually has none left for an explosion.
   *
   * **A sustained light is evictable like any other**, because this routes
   * through `flash` and therefore through `claim`. That ordering is deliberate:
   * a steady glow losing its slot to a detonation costs one frame of dimmer
   * glow before it re-claims, and a detonation losing its slot to a steady glow
   * costs the player the flash of the thing they just killed. The first is
   * cheaper, so the first is what happens.
   */
  sustain(
    handle: LightHandle,
    position: Vector3,
    color: Color,
    intensity: number,
    seconds: number,
    opts: FlashOptions = {},
  ): LightHandle {
    const slot = this.slots[handle.slot];
    if (slot && slot.serial === handle.serial && slot.seconds > 0) {
      // Same slot, same claim: rewind it in place rather than going through
      // `claim`, so a sustained light never displaces anything merely by being
      // refreshed. The serial is untouched, so the caller's handle stays good.
      this.arm(slot, position, color, intensity, seconds, opts.curve ?? CURVES.steady, opts.radius);
      return handle;
    }
    return this.flash(position, color, intensity, seconds, {
      curve: opts.curve ?? CURVES.steady,
      radius: opts.radius,
    });
  }

  /**
   * Snuff a flash early. A no-op on a stale handle, which is the common case
   * and not an error — the flash it named has simply already finished.
   *
   * Rarely needed. A caller that stops calling `sustain` gets the curve's own
   * ending for free, which looks better than a cut. This exists for the case
   * where the *reason* for the light has become false rather than merely
   * finished — a tractor beam released, a decloak interrupted — and holding the
   * ease-out would be saying something untrue about the world.
   */
  release(handle: LightHandle): void {
    const slot = this.slots[handle.slot];
    if (!slot || slot.serial !== handle.serial || slot.seconds <= 0) return;
    this.retire(slot);
  }

  /**
   * Advance every running flash by `dt` game seconds.
   *
   * Time-based, per the house rule: a light's life is spent in seconds, never
   * in frames, so a flash on a slow machine is the same flash. Feed this the
   * same dilated `dt` the rest of the game gets — an explosion should hang in
   * the air through hit-stop exactly as its own debris does, and handing this
   * the real clock instead would make the light finish while the world it lit
   * was still in slow motion.
   *
   * Free while idle: the first line leaves before touching a `PointLight`.
   */
  update(dt: number): void {
    if (this.running === 0) return;

    for (const slot of this.slots) {
      if (slot.seconds <= 0) continue;
      slot.elapsed += dt;
      if (slot.elapsed >= slot.seconds) {
        this.retire(slot);
        continue;
      }
      // `curve` is contracted to hit 0 at t = 1; `max` is a floor against a
      // caller-supplied curve that misbehaves, not against the built-in ones.
      // A negative intensity is a *dark* light in three.js — it subtracts —
      // which is a far stranger artefact than a curve that merely ends early.
      slot.light.intensity = Math.max(0, slot.peak * slot.curve(slot.elapsed / slot.seconds));
    }
  }

  /**
   * Every light off, every handle invalidated. For a run restart or a sector
   * change — a flash left over from the sector you jumped out of is a light
   * with no cause in it.
   *
   * Does not touch the pool's size, so it costs no recompile.
   */
  clear(): void {
    for (const slot of this.slots) if (slot.seconds > 0) this.retire(slot);
  }

  addTo(parent: Object3D): this {
    parent.add(this.group);
    return this;
  }

  /**
   * A cheap read of what the pool is doing, for `window.__lights` and the
   * bench. Allocates — it is a probe, not a frame path — which is why nothing
   * in `update` or `flash` uses it.
   */
  inspect(): { intensity: number; remaining: number; radius: number }[] {
    return this.slots.map((slot) => ({
      intensity: slot.light.intensity,
      remaining: slot.seconds > 0 ? slot.seconds - slot.elapsed : 0,
      radius: slot.light.distance,
    }));
  }

  /**
   * Lights are pooled, not disposed — three.js `Light`s hold no GPU resource,
   * so there is nothing here to free beyond detaching the group. Present so
   * the class matches `VectorObject`'s shape and a caller does not have to
   * know that it is a formality.
   */
  dispose(): void {
    this.clear();
    this.group.removeFromParent();
    this.group.clear();
  }

  /**
   * Which slot the next flash gets.
   *
   * An idle slot if there is one. Otherwise **the weakest victim: the slot
   * emitting least right now.**
   *
   * That single number does two jobs at once, which is why it beats the
   * least-recently-used policy it replaced. Every curve in `CURVES` is
   * monotonically non-increasing after its peak, so a light's current output
   * already encodes *how long ago it fired* — an old flash is a dim flash by
   * construction, and picking the dimmest is picking the oldest almost every
   * time. But it also encodes *how big it ever was*, which LRU cannot see: a
   * bright half-second kill flash fired 0.2 s ago is still the most important
   * thing on screen, while a small shield-hit tell fired 0.05 s ago is not, and
   * LRU would take the wrong one. Weakest-victim is LRU plus the one term LRU
   * is missing, computed from state the pool already keeps.
   *
   * Note what it costs the incoming flash: nothing. The new event is *always*
   * placed, even if it is dimmer than every light it displaces. That is
   * deliberate and it is the only rule here that is not obviously optimal —
   * a strictly-brightest-wins policy would keep a better-looking frame. It
   * would also mean an event could produce no light at all, and the events
   * most likely to arrive into a full pool are the ones arriving into a
   * crowded fight, which is precisely when the player is watching hardest. A
   * flash that is occasionally the wrong choice is recoverable; a flash that
   * silently did not happen is a bug report about the game feeling
   * inconsistent that nobody can reproduce.
   *
   * **Not camera-aware, deliberately.** Scoring a light by how much of its
   * reach is actually on screen would be strictly more accurate and would drag
   * a camera reference into a file that otherwise knows nothing about how the
   * scene is viewed — and the score would then change every frame for reasons
   * having nothing to do with the light itself, which makes the policy hard to
   * reason about and impossible to unit test. The events worth lighting are
   * caused by the player and happen in front of them.
   */
  /**
   * Point a slot at a new flash. Everything `flash` and `sustain` agree on,
   * kept in one place — the two differ only in *which slot* they act on and
   * whether the serial moves, and duplicating six lines of unit conversion
   * across them is how the star-relative intensity contract would eventually
   * come to mean two different things depending on which door you came in.
   *
   * Allocation-free: `copy` writes into the light's own `Color` and `Vector3`,
   * so the caller's `position` and `color` are only ever read. That matters at
   * the call sites — `Session.destroy` can hand this `hostile.position` and
   * `HOSTILE_COLORS[kind]` directly, with no defensive `.clone()`, and this
   * runs from inside the projectile loop where a wave dying at once calls it
   * several times in one frame.
   */
  private arm(
    slot: Slot,
    position: Vector3,
    color: Color,
    intensity: number,
    seconds: number,
    curve: DecayCurve,
    radius: number | undefined,
  ): void {
    slot.elapsed = 0;
    slot.seconds = seconds;
    slot.curve = curve;
    // Star-relative → candela. The one conversion in the file; see
    // `EVENT_LIGHT.reference` for why the caller is not asked to do it.
    slot.peak = intensity * EVENT_LIGHT.reference * EVENT_LIGHT.reference;

    slot.light.color.copy(color);
    slot.light.position.copy(position);
    // Where the irradiance has fallen to `floor`, capped. Derived rather than
    // constant so a dim tell does not reach as far as a warhead does.
    slot.light.distance =
      radius ??
      Math.min(
        EVENT_LIGHT.maxRadius,
        EVENT_LIGHT.reference * Math.sqrt(intensity / EVENT_LIGHT.floor),
      );
    // Lit on the frame it is asked for, not on the next `update`. A flash that
    // waited a frame would land after the hit-stop it is supposed to punctuate.
    slot.light.intensity = slot.peak * curve(0);
  }

  private claim(): number {
    let weakest = 0;
    let weakestOutput = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.seconds <= 0) return i;
      if (slot.light.intensity < weakestOutput) {
        weakestOutput = slot.light.intensity;
        weakest = i;
      }
    }
    return weakest;
  }

  /** Put a slot back. Bumps the serial, so every handle onto it goes stale. */
  private retire(slot: Slot): void {
    slot.seconds = 0;
    slot.elapsed = 0;
    slot.peak = 0;
    slot.serial++;
    slot.light.intensity = 0;
    // `visible` is *not* touched — see this file's header. Zero intensity is
    // the whole mechanism.
    this.running--;
  }
}
