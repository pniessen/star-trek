/**
 * The frame-budget governor: one ordinal quality level, moved by what the
 * machine can actually afford.
 *
 * ## Why this exists
 *
 * Every expensive thing this renderer has gained — the raymarched media
 * (`shaders/media.ts`, measured at +5.99 ms for the comet interior alone), the
 * baked nebula, nine thousand instanced rocks, the pyramid bloom, tonemapping,
 * shadow maps — carries a hand-picked step count or resolution that is correct
 * on exactly one machine: the M2 Max this was built on, where the whole frame
 * costs 4.19 ms of a 16.67 ms budget. That constant is wrong in both
 * directions. On a weaker machine it stutters; on this one it leaves three
 * quarters of the budget unspent. The stated goal is to safely max out whatever
 * machine the game runs on, and a constant cannot do that.
 *
 * `mediaQuality()` in `shaders/media.ts` is the existing answer and is a
 * different instrument, not a competitor: it probes the GL renderer *string*
 * once at boot and returns 0 or 1 — "is this software rasterisation" — which is
 * a capability question with a static answer. This module asks the cost
 * question, which only has a *measured* answer and only has it while the game
 * is running. The two compose: `mediaQuality()` decides whether a volume is
 * built at all, the governor decides how many steps it marches once it is.
 *
 * ## The one thing that is easy to get wrong
 *
 * **This measures work done, never the wall-clock interval between frames.**
 *
 * `FRAME_CAP` in `main.ts` holds the loop at 60 by *skipping* rAF callbacks
 * until three quarters of the target interval has passed. So the interval
 * between two accepted frames is ~16.67 ms whether the GPU spent 4 ms or 16 ms
 * producing them — the measurement saturates at the bottom and a governor built
 * on it concludes that every machine is permanently at exactly 100% of budget,
 * never ramps up, and — worse — reads the cap's own idle wait as load. The
 * interval is used here for exactly one thing, and it is not a cost: an
 * interval far past the target proves a frame was *missed*, which is evidence
 * of being over budget without being a measurement of by how much. See
 * `MISS` below.
 *
 * What is measured instead, in order of preference:
 *
 *  1. **GPU time**, through `EXT_disjoint_timer_query_webgl2`, wrapping the
 *     render call only. This is the real number: nanoseconds the GPU spent on
 *     this frame's commands, with no idle in it. It is available on Chrome and
 *     Edge on most desktop GPUs and absent on Safari and on some drivers, so it
 *     can never be the only path.
 *  2. **CPU frame time**, the span of the whole frame body. On the fallback
 *     path this is the honest lower bound — and it is not a bad one, because a
 *     saturated GPU backs pressure up the command buffer and the CPU thread
 *     starts blocking inside GL calls, so a GPU-bound frame shows up here too,
 *     just later and smeared.
 *
 * The two are combined with `max`, not `+`: CPU and GPU work overlap, and the
 * frame is as long as whichever of them finishes last.
 *
 * ## What it does not do
 *
 * It does not import `three`, does not touch any file another agent is
 * editing, and knows nothing about volumetrics, bloom or pixel ratios. It
 * exposes a registration API and moves whatever it is handed. That is
 * deliberate: a governor that reached into `Stage` or `CometMedium` directly
 * would have to be edited every time a new expensive thing lands, and the whole
 * point is that new expensive things keep landing.
 *
 * It also installs no globals. `__scenery` and `__tuning` install themselves
 * because their consumer is a harness that cannot reach into a module; this one
 * is wired by hand in `main.ts` and the handle belongs there beside them.
 */

/**
 * How many rungs the ladder has.
 *
 * Five, not three and not sixteen. Three cannot express "nearly max" — the step
 * from top to middle would be visible enough that a machine hovering at the
 * boundary flips between two obviously different-looking games. Sixteen would
 * make each step so small that the measurement noise floor is wider than a
 * step, and the governor would spend its life shuffling between adjacent rungs
 * that look identical. Five gives four steps of roughly 15–25% frame cost each,
 * which is about the size of a step you can actually measure past the noise.
 *
 * This is a constant rather than a config field because dial tables are written
 * as literals at the call site, and a table length that can change at runtime
 * is a table that can be wrong at runtime.
 */
export const LEVELS = 5;

/** Purely for diagnostics and the tuning console; nothing branches on these. */
export const LEVEL_NAMES = ["minimal", "low", "medium", "high", "full"] as const;

export type LevelName = (typeof LEVEL_NAMES)[number];

/** Where a sample came from, for the diagnostics line. */
export type CostSource = "gpu" | "cpu" | "none";

/**
 * Every number the governor's behaviour depends on, in one block so it can be
 * argued with — and, later, handed to the tuning console the way every other
 * first-draft constant in this project eventually is.
 */
export const GOVERNOR = {
  /**
   * The frame budget in milliseconds. `main.ts` should pass `1000 /
   * FRAME_CAP.fps`; the default is the 60 that `FRAME_CAP.fps` is set to.
   *
   * Note this is the budget the *cap* implies, not the display's refresh
   * interval. If the cap is ever disabled (`fps: 0`) this should stay 16.67
   * rather than following a 240 Hz display down to 4.17 — the game is designed
   * around 60 and a governor chasing 240 would strip quality on a machine that
   * is playing perfectly.
   */
  budgetMs: 1000 / 60,

  /**
   * The fraction of the budget above which quality comes down, and below which
   * it may go up. The gap between them is the hysteresis band.
   *
   * **0.70 down.** Not 1.0, and the reason is spikes rather than caution. A
   * frame that averages 16.6 ms against a 16.67 ms budget does not render at
   * 60 — it renders at 60 until the first garbage collection, texture upload or
   * shader link, and then drops one. Targeting 70% leaves 5 ms of absorption
   * for exactly those, which is the size of the largest routine hitch this
   * engine actually produces (a `TraceBuffer` refill and a bloom-chain resize
   * are both comfortably under it; a light-count relink at 170 ms is not, but
   * nothing survives that and `eventLights.ts` already exists to prevent it).
   * It also leaves room for the browser's own compositing and for the audio
   * thread, neither of which appears in any number measured here.
   *
   * **0.50 up.** A 20-point band, wider than one rung is worth. This is the
   * whole anti-oscillation argument: if a rung changes frame cost by 20% and
   * the band is narrower than that, then promoting from a comfortable level
   * lands above the demotion threshold, the governor demotes, and it has built
   * a metronome. The band must be wider than the largest single step, and 20
   * points of a 16.67 ms budget is 3.3 ms, which is more than any one dial
   * below is worth. Where a step really is bigger than the band, the dwell and
   * the backoff below are the second line of defence.
   */
  downFraction: 0.7,
  upFraction: 0.5,

  /**
   * Over this fraction of budget, drop more than one rung at once.
   *
   * Above 1.0 the machine is not merely over budget, it is missing frames
   * outright, and walking down one rung per second means seconds of visible
   * stutter to reach a level it was always going to reach.
   *
   * Two tiers, because one was measured to be too slow. Every rung is worth
   * roughly 25% of frame cost, so a machine at `collapseFraction` — two and a
   * half times budget — has to shed more than the whole ladder is worth and is
   * going to the floor whatever happens; making it walk there costs a second of
   * stutter to arrive at a conclusion that was available immediately. The slow
   * climb is what finds the rung it can actually hold, and it is safe to let it
   * do that from the bottom rather than on the way down. Measured: two-tier
   * gets a 40 ms machine to the floor in 800 ms against 1560 ms for a fixed
   * two-rung drop.
   */
  panicFraction: 1.1,
  panicDrop: 2,
  collapseFraction: 2,

  /**
   * The sample window, in frames, and the percentile read off it.
   *
   * **A percentile, not a mean.** A mean is dragged by exactly the samples that
   * should be ignored: one 200 ms shader link in a second of 4 ms frames moves
   * the mean to 7 ms and would demote a machine that is entirely fine.
   *
   * **p90, not p50 and not the max.** The max is the spike, by definition. The
   * median is the wrong target for the opposite reason: a governor that holds
   * the *typical* frame at budget leaves the worst tenth of frames over it, and
   * the worst tenth of frames is precisely what the player perceives as
   * juddering. p90 is "what does a bad-but-ordinary frame cost", which is the
   * number the experience is actually made of.
   *
   * **90 frames**, a second and a half. Long enough that a single spike sits at
   * p98.9 and cannot move p90; short enough that a genuine change in load —
   * flying into a comet interior — is reflected within a few hundred
   * milliseconds, because ten consecutive expensive frames already occupy the
   * top ten ranks and drag p90 into them.
   */
  windowFrames: 90,
  percentile: 0.9,

  /**
   * How many samples must be in the window before a decision is allowed, split
   * by direction. This is half of "down fast, up slow", expressed in evidence
   * rather than in time: coming down needs 20 frames of agreement, going up
   * needs the whole window.
   *
   * 20 is chosen against the percentile: at 20 samples p90 is the third-largest
   * value, so two spikes in a third of a second still cannot force a demotion,
   * but a sustained twenty frames of overload can — in a third of a second.
   */
  minSamplesDown: 20,
  minSamplesUp: 90,

  /**
   * Frames discarded after a level change.
   *
   * Two reasons, and the second is the important one. The obvious reason is
   * that the frames immediately after a change measure the change itself: a
   * pixel-ratio move reallocates render targets, and a media `steps` move
   * **relinks a shader**, because `march()` in `shaders/media.ts` bakes the
   * step count into the source. That is a genuine multi-hundred-millisecond
   * frame that says nothing about the level it lands on. The subtle reason is
   * that without a settle window the governor reads its own pre-change samples
   * as evidence about the post-change level, demotes again on them, and
   * cascades to the bottom in half a second — the classic way this feature is
   * got wrong.
   *
   * Twelve frames, and the number is a compromise found by measurement rather
   * than reasoning. Both hitches this is protecting against land on the *first*
   * draw after the change and are one frame long, so three would technically do
   * — but the GPU timer path runs two to four frames behind, so the window has
   * to outlast the deepest in-flight query as well. Twelve covers that with
   * room. It was 20 first, and 20 was measured to cost an overloaded machine
   * nearly a second of extra stutter, because on a machine at 40 ms a frame
   * every settle frame is 40 ms of the thing the settle exists to fix.
   *
   * In-flight GPU queries are additionally tagged with the level they were
   * issued at and discarded on mismatch, so the lag of the timer-query path
   * cannot leak across a change even if this number is wrong.
   */
  settleFrames: 12,

  /**
   * Frames discarded at startup, before anything is believed.
   *
   * The first second of this game is shader compilation, geometry upload and
   * the first bake of the nebula. Every one of those lands in a frame that has
   * nothing to do with steady-state cost, and a governor that believes them
   * starts every session by collapsing to minimum and then spending twenty
   * seconds crawling back. Ninety frames is a second and a half at the cap.
   */
  warmupFrames: 90,

  /**
   * How long the window must stay under `upFraction` before a promotion, and
   * how much longer that gets each time the same climb has already failed.
   *
   * **The other half of "down fast, up slow".** Promotion is speculative — it
   * asserts the machine can afford something it has not been asked to do yet —
   * and a wrong promotion costs a visible stutter plus a demotion. Demotion is
   * the opposite: it responds to something that already happened and its cost
   * is quality nobody was going to notice for four seconds. Asymmetry follows
   * from that, not from taste.
   *
   * The backoff is what stops the boundary case oscillating. A machine that
   * genuinely sits between two rungs will promote, overshoot, demote, and try
   * again — and each attempt costs a hitch. Multiplying the required quiet
   * period by 1.8 each time that happens means the third attempt needs ten
   * seconds and the fifth needs half a minute, so a borderline machine settles
   * on the lower rung within a few tries and stays there. Capped, because a
   * machine whose load genuinely dropped — the player docked, the comet is
   * behind them — deserves to be re-measured eventually.
   */
  upDwellMs: 3000,
  upBackoff: 1.8,
  upDwellCapMs: 30000,

  /**
   * The missed-frame penalty, as a fraction of budget.
   *
   * When the interval between two accepted frames exceeds `missTrigger` times
   * the budget, a callback that the cap would have accepted did not arrive: the
   * machine could not hold 60. That is *evidence of being over budget* and
   * nothing more — a 33 ms interval on a 60 Hz display is consistent with
   * anything from 17 to 33 ms of real work, because vsync quantises it. So the
   * governor records a fixed penalty just past the demotion threshold rather
   * than pretending to know the magnitude. If the work really was enormous, the
   * CPU span carries that magnitude on its own and the panic path fires off
   * that instead.
   *
   * 1.5 as the trigger, not 1.05: at the cap's own `tolerance` of 0.75 the loop
   * legitimately produces intervals a little over the target on refresh rates
   * that are not multiples of 60 (72 fps on a 144 Hz panel, per `FRAME_CAP`'s
   * own note), and those are not missed frames. 1.5 is past any of that and
   * short of the 2.0 an actually-dropped frame produces.
   *
   * **Only recorded for a miss the measurement cannot already explain**, which
   * was a bug before it was a rule. Recording it unconditionally meant a single
   * expensive frame put *two* samples in the window — its own honest cost and
   * this penalty — so spikes counted double against the percentile and a
   * machine hitching once every twelve frames demoted on what is really an 8%
   * outlier rate. The penalty exists for the one case where nothing else sees
   * the cost: a GPU-bound frame on a driver with no timer query, where the CPU
   * span is short and the only evidence is that the callback did not arrive. If
   * the previous frame's own cost already crossed the demotion threshold, the
   * miss is explained and the penalty is noise.
   */
  missTrigger: 1.5,
  missPenaltyFraction: 0.75,

  /**
   * Intervals longer than this are thrown away rather than counted as misses. A
   * backgrounded tab, a dragged window, a laptop lid: rAF stops, and the frame
   * it resumes on is not a performance measurement.
   *
   * **A whole second, not a quarter of one, and this was a bug before it was a
   * constant.** At 250 ms the discard was catching *shader links* — a 300 ms
   * relink is a real, common, in-engine event — and a discard used to clear the
   * whole sample window. So a machine with one hitch a second could never
   * accumulate the full window a promotion requires, and sat one rung below
   * what it could afford forever, silently. Two fixes, both worth keeping: the
   * threshold moved past anything the engine itself can produce, and a discard
   * now skips a handful of frames instead of clearing the window. Previously
   * recorded samples are not invalidated by a stall — they were honest
   * measurements of the same quality level, and only a level change makes a
   * sample worthless.
   */
  discardAboveMs: 1000,

  /**
   * Where a fresh session starts, as an offset from the top rung.
   *
   * One below maximum, and this is a real trade rather than a default. Starting
   * at maximum serves the stated goal most directly — a strong machine is never
   * anything less than maxed — but it means a weak machine renders its first
   * second and a half at settings it cannot afford, and that is the title
   * screen and the deck log, the first thing anybody sees. Starting one rung
   * down costs a strong machine three seconds of a difference it will not
   * notice (the promotion needs one full window plus `upDwellMs`) and halves
   * the distance a weak one has to fall. The warmup already protects against
   * demoting on compile hitches, so this is not about safety; it is about which
   * of the two wrong first impressions is cheaper, and "very slightly less
   * bloom for three seconds" is cheaper than "four seconds of stutter".
   */
  startFromTop: 1,
} as const;

/**
 * Build a per-level table by interpolating between the value at level 0 and the
 * value at the top level.
 *
 * A convenience, not the primary API: most dials read better as an explicit
 * literal table, because the table is where the art direction lives — a dial
 * that should hold its best value until things are genuinely bad writes
 * `[4, 8, 14, 14, 14]`, and no interpolation curve expresses that as clearly.
 * This exists for the dials where the ramp really is linear and writing five
 * numbers by hand is just an opportunity to mistype one.
 *
 * `curve` is an exponent applied to the normalised level before interpolation:
 * above 1 the expensive top end is compressed (most of the range is spent in
 * the top rungs, so the first demotion is cheap), below 1 the cheap end is.
 */
export function ramp(
  low: number,
  high: number,
  opts: { integer?: boolean; curve?: number } = {},
): number[] {
  const curve = opts.curve ?? 1;
  const out: number[] = [];
  for (let i = 0; i < LEVELS; i++) {
    const t = Math.pow(i / (LEVELS - 1), curve);
    const v = low + (high - low) * t;
    out.push(opts.integer ? Math.round(v) : v);
  }
  return out;
}

/** What `register` stores. `T` is erased inside the governor; only `apply` knows it. */
interface Dial {
  readonly name: string;
  readonly values: readonly unknown[];
  readonly apply: (value: never, level: number) => void;
  /** The value last actually pushed, so an unchanged rung costs nothing. */
  applied: unknown;
  /** Whether `applied` holds anything yet — `undefined` is a legal dial value. */
  primed: boolean;
}

/** The diagnostics view, for a HUD line or a headless assertion. */
export interface GovernorStats {
  level: number;
  name: LevelName;
  /** The percentile the decisions are made on, in ms. `null` before enough samples. */
  costMs: number | null;
  /** The median, for a sense of the spread. `null` before enough samples. */
  medianMs: number | null;
  samples: number;
  source: CostSource;
  pinned: boolean;
  enabled: boolean;
  /** Fraction of budget the current cost represents. `null` before enough samples. */
  load: number | null;
  /** How many times the governor has demoted this session; a stability signal. */
  demotions: number;
}

/**
 * The GL timer-query clock.
 *
 * `EXT_disjoint_timer_query_webgl2` is the only way to ask a browser what the
 * GPU actually spent, and it comes with three sharp edges, all handled here:
 *
 *  - **One query may be active at a time.** So `begin`/`end` are strictly
 *    paired and a second `begin` before an `end` is dropped rather than
 *    throwing.
 *  - **Results arrive frames later.** The query is not readable in the frame
 *    that issued it — asking would stall the pipeline, which is the one thing a
 *    performance measurement must never do. Pending queries are polled on
 *    subsequent frames and each carries the quality level it was issued at, so
 *    a result that outlives a level change is discarded rather than attributed
 *    to the wrong rung.
 *  - **`GPU_DISJOINT_EXT` invalidates everything in flight.** The GPU was
 *    interrupted — a context switch, a power state change — and every
 *    outstanding timing is meaningless, not merely inflated. The whole pool is
 *    thrown away when it trips.
 *
 * Any exception at all retires the clock permanently and the governor falls
 * back to CPU spans. This follows `audio/Synth.ts`'s rule: an optional
 * instrument may not take the frame loop down with it.
 */
class GpuClock {
  private gl: WebGL2RenderingContext | null = null;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private active: WebGLQuery | null = null;
  private readonly pending: { query: WebGLQuery; level: number }[] = [];
  /** Reused rather than reallocated; the extension has no cheap create. */
  private readonly spare: WebGLQuery[] = [];
  private retired = false;

  get available(): boolean {
    return this.ext !== null && !this.retired;
  }

  attach(gl: WebGL2RenderingContext | null | undefined): void {
    this.retired = false;
    this.gl = gl ?? null;
    this.ext = null;
    if (!gl || typeof gl.getExtension !== "function") return;
    try {
      const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as
        | { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
        | null;
      // Chrome hands back a stub with the constants but no working queries on
      // some drivers; the first `beginQuery` throw retires it, which is why
      // there is no deeper capability test here than "the object exists".
      if (ext && typeof gl.createQuery === "function") this.ext = ext;
    } catch {
      this.ext = null;
    }
  }

  begin(): void {
    const gl = this.gl;
    const ext = this.ext;
    if (!gl || !ext || this.retired || this.active) return;
    try {
      const query = this.spare.pop() ?? gl.createQuery();
      if (!query) return;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      this.active = query;
    } catch {
      this.retired = true;
      this.active = null;
    }
  }

  end(level: number): void {
    const gl = this.gl;
    const ext = this.ext;
    const query = this.active;
    if (!gl || !ext || !query) return;
    this.active = null;
    try {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      this.pending.push({ query, level });
    } catch {
      this.retired = true;
    }
  }

  /**
   * Drain whatever has become readable. Returns milliseconds, oldest first;
   * results from a superseded quality level are dropped on the floor here
   * rather than being handed up and filtered by the caller, because the level
   * they belong to is knowledge only this class has.
   */
  drain(currentLevel: number, out: number[]): void {
    const gl = this.gl;
    const ext = this.ext;
    if (!gl || !ext || this.retired) return;
    try {
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        // Everything in flight spanned an interruption. Recycle, believe none.
        for (const p of this.pending) this.spare.push(p.query);
        this.pending.length = 0;
        return;
      }
      // Front of the queue only, and only while it is ready: the extension
      // returns results in issue order, so a not-ready head means nothing
      // behind it is ready either.
      while (this.pending.length > 0) {
        const head = this.pending[0];
        if (!gl.getQueryParameter(head.query, gl.QUERY_RESULT_AVAILABLE)) break;
        this.pending.shift();
        const ns = gl.getQueryParameter(head.query, gl.QUERY_RESULT) as number;
        this.spare.push(head.query);
        if (head.level !== currentLevel) continue;
        // Zero is what a driver returns when it declines to time; it is not a
        // free frame and must not be believed.
        if (typeof ns === "number" && ns > 0) out.push(ns / 1e6);
      }
    } catch {
      this.retired = true;
    }
  }

  /** Drop everything in flight — used when a level changes or time jumps. */
  flush(): void {
    for (const p of this.pending) this.spare.push(p.query);
    this.pending.length = 0;
  }
}

export class Governor {
  private readonly dials: Dial[] = [];
  private readonly gpu = new GpuClock();

  /** The cost window, as a plain ring; sorted into a scratch array on demand. */
  private readonly ring: number[] = [];
  private ringHead = 0;
  private readonly scratch: number[] = [];
  /** Reused across frames so the timer-query drain allocates nothing. */
  private readonly drained: number[] = [];

  private levelValue = LEVELS - 1 - GOVERNOR.startFromTop;
  private pinnedFlag = false;
  private enabledFlag = true;

  private frameStart = 0;
  private lastAccepted = 0;
  private inFrame = false;
  private renderOpen = false;

  private framesSeen = 0;
  private settleUntil = 0;
  private goodSince: number | null = null;
  /** Per-level count of failed promotions *out of* that level, for the backoff. */
  private readonly failedClimbs = new Array<number>(LEVELS).fill(0);
  private demotionCount = 0;
  private lastSource: CostSource = "none";
  /**
   * The largest cost recorded on the previous frame, which is how the next
   * frame's missed-callback check knows whether the miss is already explained.
   * Starts at infinity so the very first interval — measured against a `last`
   * that predates the loop — cannot manufacture a penalty.
   */
  private lastMeasured = Infinity;

  // ---------------------------------------------------------------- lifecycle

  /**
   * Hand the governor the GL context so it can time the GPU. Optional: without
   * it everything still works off CPU spans, which is the Safari path and the
   * path on any driver that withholds the extension.
   *
   * Pass `stage.renderer.getContext()`. The parameter is typed structurally so
   * this file never imports `three`.
   */
  attach(gl: WebGL2RenderingContext | null | undefined): void {
    this.gpu.attach(gl);
  }

  /** True when real GPU timings are being used rather than CPU spans. */
  get timing(): CostSource {
    return this.lastSource;
  }

  get level(): number {
    return this.levelValue;
  }

  get name(): LevelName {
    return LEVEL_NAMES[this.levelValue];
  }

  get pinned(): boolean {
    return this.pinnedFlag;
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  /**
   * Stop making decisions without changing the current level, and start again.
   *
   * Distinct from `pin`: disabling freezes the ladder wherever it happens to
   * be, which is what a benchmark of "whatever the governor settled on" wants;
   * pinning asserts a specific rung, which is what a comparison between rungs
   * wants. Measurement continues either way, so `stats()` stays meaningful and
   * a tuning session can watch the cost of the level it pinned.
   */
  set enabled(on: boolean) {
    this.enabledFlag = on;
    if (on) this.restartWindow();
  }

  // ------------------------------------------------------------------ dials

  /**
   * Register something for the governor to move.
   *
   * `values` is indexed by level, worst first: `values[0]` is what the machine
   * gets when it is struggling, `values[LEVELS - 1]` is the current hand-picked
   * constant. The table is the interesting part of a dial — it is where "this
   * survives the first demotion and the second, then falls off a cliff" gets
   * written down, and it is why the primary API is a table rather than a range
   * with a curve.
   *
   * A table of the wrong length is resampled by nearest neighbour rather than
   * rejected. Registration happens once at boot from `main.ts`, and a throw
   * there takes the whole game down over a typo in a quality setting; a
   * resample plus a warning is the proportionate response, and it makes a
   * three-entry table a legitimate shorthand.
   *
   * The current level's value is applied immediately, so a dial is never out of
   * step with the level the governor reports.
   */
  register<T>(name: string, values: readonly T[], apply: (value: T, level: number) => void): void {
    const table = resample(values);
    const dial: Dial = {
      name,
      values: table,
      apply: apply as (value: never, level: number) => void,
      applied: undefined,
      primed: false,
    };
    this.dials.push(dial);
    this.push(dial, this.levelValue);
  }

  /** Registered dial names, for a diagnostics readout. */
  get dialNames(): string[] {
    return this.dials.map((d) => d.name);
  }

  /**
   * Drop every registration. Only useful to a test harness rebuilding the
   * world; a running game registers once and never unregisters, because a dial
   * that comes and goes would leave the level and the scene disagreeing.
   */
  clear(): void {
    this.dials.length = 0;
  }

  // ---------------------------------------------------------------- measuring

  /**
   * Top of the frame body, immediately after `FRAME_CAP`'s early return.
   *
   * `now` is the same `now` the cap tested — the rAF timestamp. It is used to
   * detect missed frames and time jumps, and for **nothing else**; see the
   * header for why the interval it implies is not a cost.
   */
  beginFrame(now: number): void {
    const previous = this.lastAccepted;
    this.lastAccepted = now;
    this.frameStart = now;
    this.inFrame = true;
    this.framesSeen++;

    if (previous === 0) return;
    const interval = now - previous;

    // A tab that was backgrounded, a window being dragged, a machine that went
    // to sleep. Not a measurement of anything — but also no reason to disbelieve
    // the samples already in the window, which is why this skips a few frames
    // rather than clearing it. See `discardAboveMs` for the bug that taught us
    // the difference.
    if (interval > GOVERNOR.discardAboveMs || isHidden()) {
      this.settleUntil = this.framesSeen + GOVERNOR.settleFrames;
      this.gpu.flush();
      return;
    }

    // A frame the cap would have accepted did not arrive. Evidence, not a
    // measurement — and only recorded when the previous frame's own cost does
    // not already account for it. See `GOVERNOR.missTrigger`.
    if (
      interval > GOVERNOR.budgetMs * GOVERNOR.missTrigger &&
      this.lastMeasured < GOVERNOR.budgetMs * GOVERNOR.downFraction &&
      this.believable()
    ) {
      this.record(GOVERNOR.budgetMs * GOVERNOR.missPenaltyFraction);
    }
  }

  /**
   * Immediately before `stage.render(dt)`. Opens the GPU timer.
   *
   * The GPU query wraps the render call **only**, never the whole frame body,
   * and this is not a detail. `TIME_ELAPSED` measures the GPU's own clock
   * between two markers in the command stream; if the marker is inserted before
   * several milliseconds of game logic that issues no GL commands at all, that
   * idle gap lands inside the measurement and the governor is back to timing
   * wall-clock — the exact failure the header warns about, reintroduced through
   * the back door. Open it where the drawing starts.
   */
  beginRender(): void {
    if (!this.inFrame || this.renderOpen) return;
    this.renderOpen = true;
    this.gpu.begin();
  }

  /**
   * Last statement of the frame body, after `stage.render(dt)`.
   *
   * Closes the GPU timer, closes the CPU span, and — since the CPU span is now
   * known — makes the frame's decision. Deciding here rather than at the top of
   * the next frame means a demotion takes effect on the very next frame rather
   * than the one after, which matters for the panic path and matters for
   * nothing else.
   */
  endFrame(): void {
    if (!this.inFrame) return;
    this.inFrame = false;

    if (this.renderOpen) {
      this.renderOpen = false;
      this.gpu.end(this.levelValue);
    }

    // The CPU span of the whole body: logic, HUD assembly, command submission.
    // Real budget consumption even when the GPU is the bottleneck, and the only
    // signal at all where the timer-query extension is missing.
    const cpuMs = now() - this.frameStart;

    // Whatever the GPU has finished telling us about, which is two to four
    // frames behind. Irrelevant against a 90-frame window, and the per-query
    // level tag means the lag cannot smear across a level change.
    this.drained.length = 0;
    this.gpu.drain(this.levelValue, this.drained);

    // Set even while the samples are being discarded: the next frame's
    // missed-callback test asks "was the last frame expensive", and that
    // question has an answer during warmup and settling too.
    // A loop rather than `Math.max(cpuMs, ...drained)`: the spread allocates an
    // arguments array every frame, and this runs sixty times a second forever.
    this.lastMeasured = cpuMs;
    for (const ms of this.drained) {
      if (ms > this.lastMeasured) this.lastMeasured = ms;
    }

    if (!this.believable()) return;

    if (this.drained.length > 0) {
      // Both numbers describe the same frames; CPU and GPU overlap, so the
      // frame is as long as the slower of them, not as long as their sum. The
      // GPU readings are a few frames behind this CPU span, which is close
      // enough to compare against at a 90-frame window and is why the
      // comparison is against their peak rather than pairing them up.
      let peak = 0;
      for (const ms of this.drained) peak = Math.max(peak, ms);
      for (const ms of this.drained) this.record(ms);
      if (cpuMs > peak) this.record(cpuMs);
      this.lastSource = "gpu";
    } else {
      this.record(cpuMs);
      // Only claim the GPU path once it has actually produced a reading. The
      // extension being present is not the same as the driver honouring it —
      // several return zeros forever — and a diagnostics line saying `GPU` over
      // a number that came from a CPU span is worse than no line at all.
      if (this.lastSource !== "gpu") this.lastSource = "cpu";
    }

    if (this.enabledFlag && !this.pinnedFlag) this.decide();
  }

  // ---------------------------------------------------------------- overrides

  /**
   * Hold a specific level and stop moving. For a tuning session comparing two
   * rungs, and for `tools/playtest.mjs`, which runs on software GL where every
   * frame is hundreds of milliseconds and an honest governor would correctly
   * but uselessly collapse to minimum before the harness could assert anything
   * about what is on screen.
   */
  pin(level: number): void {
    this.pinnedFlag = true;
    this.applyLevel(clamp(Math.round(level), 0, LEVELS - 1));
  }

  /** Resume automatic movement from wherever `pin` left it. */
  unpin(): void {
    this.pinnedFlag = false;
    this.restartWindow();
  }

  /**
   * Move one rung without pinning — what a key binding or the tuning console
   * would call. The governor is free to move it straight back, which is the
   * honest behaviour: if the machine cannot hold the rung you asked for, you
   * have learned that.
   */
  setLevel(level: number): void {
    this.applyLevel(clamp(Math.round(level), 0, LEVELS - 1));
  }

  // -------------------------------------------------------------- diagnostics

  stats(): GovernorStats {
    const count = this.ring.length;
    const enough = count >= Math.min(GOVERNOR.minSamplesDown, GOVERNOR.windowFrames);
    const cost = enough ? this.quantile(GOVERNOR.percentile) : null;
    return {
      level: this.levelValue,
      name: LEVEL_NAMES[this.levelValue],
      costMs: cost,
      medianMs: enough ? this.quantile(0.5) : null,
      samples: count,
      source: this.lastSource,
      pinned: this.pinnedFlag,
      enabled: this.enabledFlag,
      load: cost === null ? null : cost / GOVERNOR.budgetMs,
      demotions: this.demotionCount,
    };
  }

  /** One line for the diagnostics column: `GOV full 4/4 gpu 4.2ms 25%`. */
  report(): string {
    const s = this.stats();
    const cost = s.costMs === null ? "--" : s.costMs.toFixed(1);
    const load = s.load === null ? "--" : Math.round(s.load * 100);
    const mode = s.pinned ? "PIN" : s.enabled ? s.source.toUpperCase() : "OFF";
    return `GOV ${s.name} ${s.level}/${LEVELS - 1} ${mode} ${cost}ms ${load}%`;
  }

  // ------------------------------------------------------------------ private

  /** Warmed up, settled after the last change, and not mid-jump. */
  private believable(): boolean {
    return this.framesSeen > GOVERNOR.warmupFrames && this.framesSeen >= this.settleUntil;
  }

  private record(ms: number): void {
    if (!(ms >= 0) || !isFinite(ms)) return;
    if (this.ring.length < GOVERNOR.windowFrames) {
      this.ring.push(ms);
    } else {
      this.ring[this.ringHead] = ms;
      this.ringHead = (this.ringHead + 1) % GOVERNOR.windowFrames;
    }
  }

  /** Empty the evidence and restart every clock that depends on it. */
  private restartWindow(): void {
    this.ring.length = 0;
    this.ringHead = 0;
    this.goodSince = null;
    this.gpu.flush();
    this.settleUntil = this.framesSeen + GOVERNOR.settleFrames;
  }

  private quantile(q: number): number {
    const n = this.ring.length;
    if (n === 0) return 0;
    this.scratch.length = 0;
    for (let i = 0; i < n; i++) this.scratch.push(this.ring[i]);
    this.scratch.sort(ascending);
    // Nearest-rank rather than interpolated. The samples are already a coarse,
    // noisy estimate of a physical quantity; interpolating between two of them
    // implies a precision the measurement does not have, and costs a branch in
    // the frame loop to imply it.
    return this.scratch[clamp(Math.floor(q * (n - 1)), 0, n - 1)];
  }

  private decide(): void {
    const count = this.ring.length;
    if (count < GOVERNOR.minSamplesDown) return;

    const cost = this.quantile(GOVERNOR.percentile);
    const load = cost / GOVERNOR.budgetMs;

    // Down, and fast. Checked first and unconditionally: a machine that is over
    // budget is losing frames right now, and nothing about the promotion side
    // of this function should be able to delay that by a frame.
    if (load > GOVERNOR.downFraction) {
      if (this.levelValue === 0) return;
      const drop =
        load > GOVERNOR.collapseFraction
          ? LEVELS
          : load > GOVERNOR.panicFraction
            ? GOVERNOR.panicDrop
            : 1;
      // The promotion that got us here was wrong. Charged against the level we
      // are leaving, so the backoff lengthens the specific climb that failed
      // rather than every climb — a machine that cannot hold level 4 should
      // still be allowed to try level 3 promptly.
      this.failedClimbs[this.levelValue] = Math.min(this.failedClimbs[this.levelValue] + 1, 12);
      this.demotionCount++;
      this.applyLevel(Math.max(0, this.levelValue - drop));
      return;
    }

    // Up, and slowly. Three gates, all of which must hold: a full window of
    // evidence, a percentile under the low edge of the hysteresis band, and a
    // continuous quiet period whose length grows every time this same climb has
    // already been tried and failed.
    if (load > GOVERNOR.upFraction || count < GOVERNOR.minSamplesUp) {
      this.goodSince = null;
      return;
    }
    if (this.levelValue >= LEVELS - 1) return;

    const t = now();
    if (this.goodSince === null) {
      this.goodSince = t;
      return;
    }
    const target = this.levelValue + 1;
    const dwell = Math.min(
      GOVERNOR.upDwellMs * Math.pow(GOVERNOR.upBackoff, this.failedClimbs[target]),
      GOVERNOR.upDwellCapMs,
    );
    if (t - this.goodSince < dwell) return;

    this.applyLevel(target);
  }

  private applyLevel(level: number): void {
    if (level === this.levelValue) return;
    this.levelValue = level;
    for (const dial of this.dials) this.push(dial, level);
    // Everything measured under the old level, and everything measured while
    // the new one is still paying for a reallocation or a shader link, is now
    // worthless. Throwing the window away is what stops a single demotion
    // cascading to the bottom on its own stale evidence.
    this.restartWindow();
  }

  /** Push one dial's value for a level, skipping a value it already holds. */
  private push(dial: Dial, level: number): void {
    const value = dial.values[clamp(level, 0, dial.values.length - 1)];
    // Adjacent rungs deliberately share values — that is how a table says "this
    // one does not degrade yet". Re-applying an unchanged value would relink a
    // shader or reallocate a render target for no reason, which is the most
    // expensive possible way to do nothing.
    if (dial.primed && Object.is(dial.applied, value)) return;
    dial.applied = value;
    dial.primed = true;
    try {
      dial.apply(value as never, level);
    } catch (err) {
      // A dial that throws is a bug in the dial, not a reason to stop
      // governing — and certainly not a reason to take the frame loop down.
      // Same rule the audio layer runs under.
      console.warn(`[governor] dial "${dial.name}" threw while applying`, err);
    }
  }
}

// ------------------------------------------------------------------- helpers

function ascending(a: number, b: number): number {
  return a - b;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

/** Nearest-neighbour resample of a dial table onto the `LEVELS` ladder. */
function resample<T>(values: readonly T[]): readonly T[] {
  if (values.length === LEVELS) return values;
  if (values.length === 0) {
    console.warn("[governor] a dial was registered with an empty table; it will never move");
    return values;
  }
  console.warn(
    `[governor] a dial table of ${values.length} was resampled onto ${LEVELS} levels`,
  );
  const out: T[] = [];
  for (let i = 0; i < LEVELS; i++) {
    const t = (i / (LEVELS - 1)) * (values.length - 1);
    out.push(values[clamp(Math.round(t), 0, values.length - 1)]);
  }
  return out;
}

/**
 * The one the game uses. A singleton for the same reason `sound` is one: there
 * is one frame loop and one GPU, so a second governor would be two authorities
 * over one budget, each measuring the other's decisions as noise.
 */
export const governor = new Governor();
