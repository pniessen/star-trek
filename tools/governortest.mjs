/**
 * Contracts for `src/render/governor.ts`, in bare node.
 *
 *   node tools/governortest.mjs
 *
 * No browser, no `three`, no build step: the governor deliberately imports
 * nothing, so Node 26 runs the TypeScript directly by stripping the types. That
 * is the same reasoning `tools/campaigntest.mjs` applies to `src/chart/` — the
 * logic worth asserting about is the logic that does not need a GPU to run, and
 * a module that can only be tested inside a frame loop is a module that never
 * gets tested.
 *
 * The clock is faked wholesale. `performance.now` is the only time source the
 * governor reads, so replacing it makes a five-minute session run in a
 * millisecond and — more importantly — makes the timings *exact*, which is what
 * lets an assertion about hysteresis be a real assertion rather than a hope.
 *
 * The first test is the one that matters: a machine idling at 4 ms of work
 * still reports a 16.67 ms interval, because `FRAME_CAP` sleeps the difference.
 * A governor that measures the interval concludes that machine is at 100% of
 * budget forever. This asserts it climbs to maximum instead.
 */

import { Governor, GOVERNOR, LEVELS, ramp } from "../src/render/governor.ts";

const BUDGET = GOVERNOR.budgetMs;

let clock = 0;
globalThis.performance = { now: () => clock };

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * One accepted frame, shaped exactly like `main.ts`'s loop: work, then the
 * cap's idle wait for whatever is left of the interval. When the work exceeds
 * the budget the wait is zero and the interval stretches, which is the only way
 * cost ever reaches the wall clock.
 */
function tick(gov, workMs) {
  gov.beginFrame(clock);
  gov.beginRender();
  clock += workMs;
  gov.endFrame();
  clock += Math.max(0, BUDGET - workMs);
}

function run(gov, frames, workFor) {
  for (let i = 0; i < frames; i++) tick(gov, workFor(gov.level, i));
}

function fresh() {
  clock = 0;
  return new Governor();
}

// ---------------------------------------------------------------------------
console.log("frame cap");

{
  // The headline failure mode. 4 ms of work, a rock-steady 16.67 ms interval.
  const gov = fresh();
  run(gov, 3000, () => 4);
  check(
    "an idle machine behind the 60 fps cap climbs to maximum",
    gov.level === LEVELS - 1,
    `settled at ${gov.level}, cost ${gov.stats().costMs?.toFixed(2)}ms`,
  );
  check("and does so without demoting on the way", gov.stats().demotions === 0);
}

{
  // The same machine, but the governor is told the interval is the cost. There
  // is no API for that any more; this asserts the interval is not silently
  // reaching the window some other way — a 4 ms machine must never read as
  // more than a third of budget.
  const gov = fresh();
  run(gov, 400, () => 4);
  const load = gov.stats().load;
  check("measured load reflects work, not interval", load !== null && load < 0.35, `load ${load}`);
}

{
  // The machine this was all built on: an M2 Max at 3024x1964, whole frame
  // 4.19 ms of a 16.67 ms budget. It must end up at the top and stay there —
  // that is the entire point of the exercise.
  const gov = fresh();
  run(gov, 5000, () => 4.19);
  const s = gov.stats();
  check("the reference M2 Max maxes out", gov.level === LEVELS - 1 && s.demotions === 0);
  check("with load reported honestly", Math.abs(s.load - 4.19 / BUDGET) < 0.02, `load ${s.load}`);
}

// ---------------------------------------------------------------------------
console.log("\noverload");

{
  const gov = fresh();
  run(gov, 400, () => 25);
  check("a machine at 25 ms a frame falls to the floor", gov.level === 0, `at ${gov.level}`);
}

{
  // How fast. The panic path exists so a badly overloaded machine does not
  // spend seconds walking down one rung at a time.
  const gov = fresh();
  run(gov, GOVERNOR.warmupFrames + 1, () => 4);
  const before = clock;
  let settled = -1;
  for (let i = 0; i < 600 && settled < 0; i++) {
    tick(gov, 40);
    if (gov.level === 0) settled = clock - before;
  }
  check("and gets there in under a second", settled >= 0 && settled < 1000, `${settled}ms`);
}

// ---------------------------------------------------------------------------
console.log("\nspikes");

{
  // A shader link, a garbage collection, a texture upload. One frame in sixty,
  // three hundred milliseconds long. A mean would be dragged to 9 ms by this
  // and demote; a p90 cannot see it at all.
  const gov = fresh();
  run(gov, 2000, (_level, i) => (i % 60 === 0 ? 300 : 4));
  check("a 300 ms hitch once a second never demotes", gov.stats().demotions === 0);
  check("and quality still reaches maximum", gov.level === LEVELS - 1, `at ${gov.level}`);
}

{
  // The edge of what p90 promises, from the safe side. One frame in twelve is
  // 8.3% of the window; the percentile tolerates outliers up to 10% and the
  // eleventh percent is where it stops, by construction rather than by luck.
  const gov = fresh();
  run(gov, 1200, (_level, i) => (i % 12 === 0 ? 120 : 3));
  check("one frame in twelve at 120 ms does not demote", gov.stats().demotions === 0);
}

{
  // ...and from the other side, which is not a bug: one frame in six at 120 ms
  // is a machine rendering at forty, and a governor that shrugged at that would
  // be tuned to protect the numbers rather than the player.
  const gov = fresh();
  run(gov, 1200, (_level, i) => (i % 6 === 0 ? 120 : 3));
  check("one frame in six does demote", gov.stats().demotions > 0);
}

// ---------------------------------------------------------------------------
console.log("\nhysteresis");

{
  // The oscillation trap: a machine that sits exactly between two rungs. Each
  // rung is worth 25% of frame cost, so the top rung is over the down
  // threshold and the one below is under the up threshold — without a band and
  // a backoff this is a metronome.
  const cost = [4.2, 5.6, 7.5, 10, 13.3];
  const gov = fresh();
  run(gov, 20000, (level) => cost[level]);
  const s = gov.stats();
  check("a borderline machine settles", s.demotions <= 4, `${s.demotions} demotions`);
  check("on the rung it can actually afford", gov.level === 3, `at ${gov.level}`);
}

{
  // Recovery. Load appears (a comet interior), the governor drops, load goes
  // away, and it must climb back — slowly, but it must.
  const gov = fresh();
  run(gov, 3000, () => 4);
  const top = gov.level;
  run(gov, 600, () => 20);
  const bottom = gov.level;
  run(gov, 6000, () => 4);
  check("load drops quality", bottom < top, `${top} -> ${bottom}`);
  check("and its removal restores it", gov.level > bottom, `back to ${gov.level}`);
}

{
  // Up is slower than down, measured rather than asserted from the constants.
  const gov = fresh();
  run(gov, GOVERNOR.warmupFrames + 200, () => 4);
  const startLevel = gov.level;
  let downAt = 0;
  const t0 = clock;
  while (gov.level === startLevel && clock - t0 < 20000) tick(gov, 20);
  downAt = clock - t0;
  const t1 = clock;
  let upAt = 0;
  const low = gov.level;
  while (gov.level === low && clock - t1 < 60000) tick(gov, 3);
  upAt = clock - t1;
  check("a promotion takes longer than a demotion", upAt > downAt * 3, `down ${downAt.toFixed(0)}ms, up ${upAt.toFixed(0)}ms`);
}

// ---------------------------------------------------------------------------
console.log("\ndials");

{
  const gov = fresh();
  const seen = [];
  gov.register("steps", [4, 6, 8, 11, 14], (v) => seen.push(v));
  check("a dial is applied at registration", seen.length === 1);
  check("at the starting level", seen[0] === [4, 6, 8, 11, 14][LEVELS - 1 - GOVERNOR.startFromTop]);
  gov.setLevel(0);
  check("and again on a level change", seen[seen.length - 1] === 4);
}

{
  // Adjacent rungs sharing a value is how a table says "this one does not
  // degrade yet"; re-applying it would relink a shader for nothing.
  const gov = fresh();
  let applies = 0;
  gov.register("held", [1, 2, 2, 2, 2], () => applies++);
  const at = applies;
  gov.setLevel(3);
  gov.setLevel(2);
  gov.setLevel(4);
  check("an unchanged value is not re-applied", applies === at, `${applies - at} redundant applies`);
  gov.setLevel(0);
  check("a changed one is", applies === at + 1);
}

{
  const gov = fresh();
  gov.register("throws", ramp(1, 5, { integer: true }), () => {
    throw new Error("deliberate");
  });
  let survived = true;
  try {
    gov.setLevel(0);
  } catch {
    survived = false;
  }
  check("a dial that throws does not take the governor down", survived);
}

{
  check("ramp spans the ladder", ramp(2, 10).length === LEVELS);
  check("ramp ends on its endpoints", ramp(2, 10)[0] === 2 && ramp(2, 10)[LEVELS - 1] === 10);
  const curved = ramp(0, 100, { curve: 2 });
  check("a curve above 1 keeps the range in the top rungs", curved[1] < 25, `${curved[1]}`);

  const gov = fresh();
  const seen = [];
  gov.register("short", ["a", "b", "c"], (v) => seen.push(v));
  gov.setLevel(0);
  gov.setLevel(LEVELS - 1);
  check("a short table is resampled rather than rejected", seen.includes("a") && seen.includes("c"));
}

// ---------------------------------------------------------------------------
console.log("\noverrides");

{
  const gov = fresh();
  gov.pin(1);
  run(gov, 2000, () => 2);
  check("a pinned level does not move", gov.level === 1 && gov.pinned);
  check("but is still measured", gov.stats().costMs !== null);
  gov.unpin();
  run(gov, 4000, () => 2);
  check("unpinning resumes", gov.level > 1, `at ${gov.level}`);
}

{
  const gov = fresh();
  run(gov, 300, () => 4);
  gov.enabled = false;
  const frozen = gov.level;
  run(gov, 4000, () => 40);
  check("disabled freezes the level", gov.level === frozen, `at ${gov.level}`);
  check("and reports as disabled", gov.stats().enabled === false);
}

// ---------------------------------------------------------------------------
console.log("\ntime jumps");

{
  // A backgrounded tab. rAF stops; the frame it resumes on is a two-second
  // interval that is not a performance measurement.
  const gov = fresh();
  run(gov, 3000, () => 4);
  const before = gov.level;
  clock += 5000;
  run(gov, 400, () => 4);
  check("a five-second stall does not demote", gov.level === before, `${before} -> ${gov.level}`);
}

// ---------------------------------------------------------------------------
console.log("\ngpu timer queries");

{
  /**
   * A minimal `EXT_disjoint_timer_query_webgl2` stand-in: results come back
   * three frames late, which is the property the level-tagging exists for.
   * The GPU here is *cheap* while the CPU span is expensive — a shape that
   * cannot occur in the real engine but proves which number the governor
   * believes.
   */
  function fakeGl(gpuMs) {
    let next = 1;
    const queued = [];
    let frame = 0;
    return {
      QUERY_RESULT_AVAILABLE: 0x9194,
      QUERY_RESULT: 0x8866,
      getExtension: (name) =>
        name === "EXT_disjoint_timer_query_webgl2"
          ? { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb }
          : null,
      createQuery: () => ({ id: next++ }),
      beginQuery: (_t, q) => {
        q.issued = frame;
      },
      endQuery: () => {
        frame++;
      },
      getParameter: () => false,
      getQueryParameter: (q, p) => {
        if (p === 0x9194) return frame - q.issued >= 3;
        return gpuMs() * 1e6;
      },
      _queued: queued,
    };
  }

  const gov = fresh();
  gov.attach(fakeGl(() => 3));
  run(gov, 3000, () => 3);
  check("the GPU path is used when the extension is present", gov.timing === "gpu");
  check("and a cheap GPU reaches maximum", gov.level === LEVELS - 1, `at ${gov.level}`);
}

{
  // A GPU that is the bottleneck while the CPU span is short — the case the
  // CPU-only fallback would miss entirely.
  const gov = fresh();
  gov.attach(fakeGl_expensive());
  run(gov, 1500, () => 2);
  check("an expensive GPU demotes even on a cheap CPU frame", gov.level === 0, `at ${gov.level}`);

  function fakeGl_expensive() {
    let next = 1;
    let frame = 0;
    return {
      QUERY_RESULT_AVAILABLE: 0x9194,
      QUERY_RESULT: 0x8866,
      getExtension: (name) =>
        name === "EXT_disjoint_timer_query_webgl2"
          ? { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb }
          : null,
      createQuery: () => ({ id: next++ }),
      beginQuery: (_t, q) => {
        q.issued = frame;
      },
      endQuery: () => {
        frame++;
      },
      getParameter: () => false,
      getQueryParameter: (q, p) => (p === 0x9194 ? frame - q.issued >= 3 : 30 * 1e6),
    };
  }
}

{
  // A driver that hands back the extension and then throws. The governor must
  // fall through to CPU spans rather than taking the frame loop with it.
  const gov = fresh();
  gov.attach({
    getExtension: () => ({ TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 }),
    createQuery: () => ({}),
    beginQuery: () => {
      throw new Error("driver says no");
    },
    endQuery: () => {},
    getParameter: () => false,
    getQueryParameter: () => 0,
  });
  let survived = true;
  try {
    run(gov, 400, () => 4);
  } catch {
    survived = false;
  }
  check("a hostile driver retires the GPU clock quietly", survived && gov.timing === "cpu");
}

{
  const gov = fresh();
  gov.attach(null);
  run(gov, 400, () => 4);
  check("no context at all is fine", gov.timing === "cpu");
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "all governor contracts hold" : `${failures} failing`}`);
process.exit(failures === 0 ? 0 : 1);
