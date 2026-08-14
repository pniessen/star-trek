/**
 * Runs many campaigns against a model player and reports how they resolve.
 * This does not say whether the chart is fun. It says whether the pressure
 * formula and the ground a run takes produce a war whose outcome is ever in
 * doubt.
 *
 * The model player has the tools the command view gives a real one. It banks
 * salvage, takes ground by flying somewhere and clearing it, fields and
 * reinforces patrols, builds outposts, starbases and yards, and picks its
 * front. It spends through the same functions the game does, so a rule change
 * in `economy.ts` shows up here without this file being touched.
 *
 * Three things it deliberately does not model, each of which makes the numbers
 * below a *lower* bound rather than a flattering one:
 *
 *  - **Refits.** Their effect is on combat, which this instrument does not
 *    simulate, so buying them here would be a certain cost against an invented
 *    benefit. Run with `--refits` to charge for them anyway and see how much
 *    slack the economy has.
 *  - **Interception.** A committed attack reaching a sector the player is
 *    standing in can be broken during a run. Never exercised here.
 *  - **Skill.** `--take` is a flat figure per run; a real player's banked
 *    salvage varies enormously with how greedy they were.
 *
 * The third of those is worth more attention than it used to get. `--reach` is
 * a constant here and is nothing of the kind in play: a run that dies on wave
 * two takes no ground and a run that goes deep takes several sectors, so a real
 * player's reach is a distribution with a mean, not a number. `--vary` draws
 * each run's reach from a Poisson with that mean, which is the natural shape
 * for "how many waves did you clear before something got you". Ask for it
 * before believing any threshold this file reports, because a constant-rate
 * model makes every threshold sharper than the game's would be.
 *
 * ## What this reports, and why it grew
 *
 * A length distribution was enough while the only question was "how long".
 * The question now is "is the outcome ever in doubt", and a median cannot
 * answer that. So alongside the outcome split there are three readings that
 * can:
 *
 *  - **The trajectory.** Mean enemy-held sectors at fixed runs. A war decided
 *    on the first run and a war that swings look identical in a median and
 *    nothing alike here.
 *  - **Where a loss turns.** For campaigns that end badly, how far the player
 *    got before the tide went the other way, and on which run. A player who
 *    reaches nine enemy sectors out of twenty-four and then loses anyway is
 *    being told a different thing about the model than one who never advances.
 *  - **`--sweep`**, which runs the whole reach ladder in one command and says
 *    outright whether there is a **contested band** — a range of reach values
 *    where the same rules produce both wins and losses. A rule change that
 *    only moves the threshold has failed, and the sweep is the one reading
 *    that shows the difference.
 *
 *   npm run campaignlength -- [trials] [--take=N] [--reach=N] [--refits] [--vary]
 *                             [--tune=K=V,…] [--sweep] [--trace=SEED]
 *
 * `--tune=reserve.regenPerSector=0.5` moves the shipped invasion's own
 * constants — `RESERVE` in `chart/reserve.ts` — directly, because a balance
 * pass is only worth a verdict once it has been tried at more than the first
 * numbers somebody wrote down.
 */
const { newCampaign, creditSalvage, hasStructure, isWon, isLost, ENEMY_START_DEPTH } =
  await import("../.campaign-build/chart/campaign.js");
const {
  advanceCampaign, build, deployPatrol, gainGround,
  toggleRefit, PATROL, REFITS,
} = await import("../.campaign-build/chart/economy.js");
const { pressureBudget, RESERVE } = await import("../.campaign-build/chart/enemyTurn.js");
const { makeRng } = await import("../.campaign-build/chart/rng.js");
const { GRID, SECTOR_COUNT, neighbours } = await import("../.campaign-build/chart/sectors.js");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? fallback : Number(found.split("=")[1]);
};
const text = (name, fallback) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.split("=").slice(1).join("=");
};
const TRIALS = Number(args.find((a) => !a.startsWith("--")) ?? 2000);
/**
 * Salvage a run banks in a yield-0 sector, before the sector's own multiplier.
 * Anchored on the game's own numbers rather than guessed: waves one to three
 * are worth 200 + 300 + 575 in hostile value, and a player who banks twice at
 * a middling multiplier brings home a little over a thousand of it.
 */
const TAKE = flag("take", 1200);
/** The live value, so `--economy` can sweep it without threading it through every call. */
let take = TAKE;
/**
 * Steps of ground a run moves. One step is one wave cleared in the sector you
 * are standing in — theirs to contested, or contested to yours — so three is a
 * run that takes its drop sector outright and hyperwarps once to start on the
 * next. This is the single most decisive number in the whole model; see the
 * sweep recorded in docs/campaign-balance.md before changing it.
 */
const REACH = flag("reach", 3);
const BUY_REFITS = args.includes("--refits");
/** Draw each run's reach from a Poisson about `--reach` rather than using it flat. */
const VARY = args.includes("--vary");
const SWEEP = args.some((a) => a === "--sweep" || a.startsWith("--sweep="));
const SWEEP_REACHES = (text("sweep", "") || "1,2,3,4,5,6,7,8,10")
  .split(",").map(Number).filter((n) => Number.isFinite(n));
const TRACE = args.some((a) => a.startsWith("--trace=")) ? flag("trace", 1) : null;
/** Sweeps salvage banked per run at a fixed reach — does the chart matter at all? */
const ECONOMY = args.includes("--economy");
const ECONOMY_TAKES = [0, 300, 600, 1200, 2400, 6000];
/**
 * Runs before a campaign is called unresolved. Two hundred is the honest
 * upper bound on the model; it is not the honest upper bound on a player's
 * patience, and the difference matters — a war scored as a deadlock at two
 * hundred may be a defeat by boredom at forty. Sweep both before believing
 * either.
 */
const CEILING = flag("ceiling", 200);

/** The board the enemy opens holding. Every "how far has the front moved" reads against this. */
const START_THEIRS = ENEMY_START_DEPTH * GRID;

const tuneSpec = text("tune", "");
if (tuneSpec) {
  for (const clause of tuneSpec.split(",")) {
    const [path, raw] = clause.split("=");
    const key = path.replace(/^reserve\./, "");
    if (!(key in RESERVE)) throw new Error(`unknown tunable "${path}"`);
    RESERVE[key] = Number(raw);
  }
  console.log(`tuned       ${tuneSpec}`);
}

// ── the model player ────────────────────────────────────────────────────────

/** Ground the player can reach: theirs or contested, next to something held. */
function reachable(campaign) {
  const out = [];
  for (let i = 0; i < campaign.sectors.length; i++) {
    const sector = campaign.sectors[i];
    if (sector.control === "ours") continue;
    if (!neighbours(i).some((n) => campaign.sectors[n].control === "ours")) continue;
    out.push(i);
  }
  // Richest first: threat and yield correlate, so this is the greedy read of
  // the same decision a player makes at the chart.
  return out.sort((a, b) => campaign.sectors[b].yield - campaign.sectors[a].yield);
}

/** Held ground the enemy is standing next to — where defence is worth paying for. */
function frontLine(campaign) {
  const out = [];
  for (let i = 0; i < campaign.sectors.length; i++) {
    if (campaign.sectors[i].control !== "ours") continue;
    if (!neighbours(i).some((n) => campaign.sectors[n].control === "theirs")) continue;
    out.push(i);
  }
  return out;
}

/**
 * One visit to the command view.
 *
 * Spending order is cheapest-useful-first, which is what a player short of
 * salvage actually does: hold the line with patrols, then buy somewhere to
 * bank near the front, then insurance against losing the last starbase, then
 * the yard that stops patrols being one-shot.
 */
function spend(campaign) {
  const line = frontLine(campaign);
  const held = campaign.sectors.filter((s) => s.control === "ours");

  // Enough passes to exhaust the list even with the whole front line bare;
  // the loop breaks as soon as nothing more can be bought.
  for (let step = 0; step < 32; step++) {
    // A patrol on undefended front-line ground, while salvage allows —
    // patrols are uncapped, so this is a salvage-and-frontage condition now,
    // not a capacity one.
    const bare = line.find((i) => !campaign.sectors[i].patrol);
    if (bare !== undefined && campaign.salvage >= PATROL.cost) {
      if (deployPatrol(campaign, bare)) continue;
    }
    // Top up one that the front has been grinding down.
    const worn = line.find(
      (i) => campaign.sectors[i].patrol && campaign.sectors[i].patrol.strength < PATROL.maxStrength,
    );
    if (worn !== undefined && deployPatrol(campaign, worn)) continue;

    // Somewhere near the front to bank, so a run does not have to fly home.
    const outposts = held.filter((s) => s.structures.some((x) => x.kind === "outpost")).length;
    if (outposts < 2 && line.length && build(campaign, line[0], "outpost")) continue;

    // A second starbase is insurance: losing the last one loses the war.
    const starbases = campaign.sectors.filter((s) => hasStructure(s, "starbase")).length;
    const rear = deepestHeld(campaign);
    if (starbases < 2 && rear !== undefined && build(campaign, rear, "starbase")) continue;

    if (rear !== undefined && build(campaign, rear, "yard")) continue;

    if (BUY_REFITS) {
      const next = REFITS.find((spec) => !campaign.refits.includes(spec.id));
      if (next && toggleRefit(campaign, next.id)) continue;
    }
    break;
  }
}

/** The held sector furthest from anything the enemy holds. Where you build safely. */
function deepestHeld(campaign) {
  let best;
  let bestDistance = -1;
  for (let i = 0; i < campaign.sectors.length; i++) {
    if (campaign.sectors[i].control !== "ours") continue;
    const distance = Math.min(
      ...campaign.sectors
        .map((s, j) => (s.control === "theirs" ? Math.abs((j >> 3) - (i >> 3)) + Math.abs((j & 7) - (i & 7)) : Infinity)),
    );
    if (distance > bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * One run. Returns the steps of ground it actually converted, which is not
 * always `reach`: a candidate that makes ground cost more to take spends the
 * same reach on fewer sectors, and the difference between the two is the
 * whole point of measuring it.
 */
function modelPlayerRun(campaign, reach) {
  const targets = reachable(campaign);
  // Decision four: where to drop. Richest reachable ground, or stay home.
  if (targets.length) {
    campaign.front = targets[0];
    campaign.current = targets[0];
  }

  // What the run banks, scaled by the drop sector's yield the way `Session`
  // scales it — `1 + yield`, per the deviation recorded in status.md §3.
  creditSalvage(campaign, take * (1 + campaign.sectors[campaign.front].yield));

  // Ground taken by clearing waves where you are standing. Spread across the
  // richest reachable sectors, which is what hyperwarp makes possible.
  let moved = 0;
  for (const index of targets) {
    while (moved < reach && gainGround(campaign, index)) moved++;
    if (moved >= reach) break;
  }

  spend(campaign);
  return moved;
}

// ── one campaign ────────────────────────────────────────────────────────────

const count = (campaign, control) =>
  campaign.sectors.filter((s) => s.control === control).length;

/**
 * Knuth's method, on a generator of our own so that varying the player's runs
 * cannot shift the enemy's draws — two campaigns run at the same seed with and
 * without `--vary` must differ only in the player, or the comparison is
 * measuring the shuffle instead.
 */
function poisson(rng, meanValue) {
  const limit = Math.exp(-meanValue);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > limit);
  return k - 1;
}

/**
 * Plays one campaign to a conclusion and records the shape of it, not only the
 * end of it. `theirs` per run is what every trajectory reading below is derived
 * from — it is the front, as one number.
 */
function runCampaign(seed, reach) {
  const campaign = newCampaign(seed);
  const theirsPerRun = [];
  const budgetPerRun = [];
  let outcome = "unresolved";
  // Offset so the player's draws never coincide with the enemy's, whose own
  // generator is reseeded from `campaign.seed` every turn.
  const skill = makeRng(seed ^ 0x5f3759df);

  for (let run = 0; run < CEILING; run++) {
    modelPlayerRun(campaign, VARY ? poisson(skill, reach) : reach);
    budgetPerRun.push(pressureBudget(campaign));
    advanceCampaign(campaign, makeRng(campaign.seed, campaign.rngCursor));
    theirsPerRun.push(count(campaign, "theirs"));
    if (isWon(campaign)) { outcome = "won"; break; }
    if (isLost(campaign)) { outcome = "lost"; break; }
  }

  // Deepest advance: the fewest sectors the enemy ever held, and when. For a
  // loss this is the high-water mark of the whole war.
  let deepest = START_THEIRS;
  let deepestAt = 0;
  theirsPerRun.forEach((theirs, i) => {
    if (theirs < deepest) { deepest = theirs; deepestAt = i + 1; }
  });

  return {
    outcome,
    runs: campaign.runsElapsed,
    theirsPerRun,
    budgetPerRun,
    deepest,
    deepestAt,
    structures: campaign.sectors.reduce((n, s) => n + s.structures.length, 0),
    ours: count(campaign, "ours"),
  };
}

// ── reporting ───────────────────────────────────────────────────────────────

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n, of) => `${((n / of) * 100).toFixed(1)}%`;

function summarise(results) {
  const lengths = results.map((r) => r.runs).sort((a, b) => a - b);
  const at = (q) => lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * q))];
  const of = (outcome) => results.filter((r) => r.outcome === outcome);
  return {
    trials: results.length,
    won: of("won").length,
    lost: of("lost").length,
    unresolved: of("unresolved").length,
    p10: at(0.1), median: at(0.5), p90: at(0.9),
    results,
  };
}

/**
 * Mean enemy-held sectors at fixed runs, over campaigns still going at that
 * run. A resolved campaign drops out rather than being held flat, because a
 * won campaign padded with zeroes would report an advance that nobody made.
 */
function trajectory(results, marks) {
  return marks.map((run) => {
    const alive = results.filter((r) => r.theirsPerRun.length >= run);
    return { run, alive: alive.length, theirs: mean(alive.map((r) => r.theirsPerRun[run - 1])) };
  });
}

function report(stats, label) {
  const { trials, won, lost, unresolved } = stats;
  console.log(`trials      ${trials}`);
  console.log(`model       ${label}`);
  console.log(`won         ${won}  (${pct(won, trials)})`);
  console.log(`lost        ${lost}  (${pct(lost, trials)})`);
  console.log(`unresolved  ${unresolved}  (${pct(unresolved, trials)})`);
  console.log(`runs        p10=${stats.p10}  median=${stats.median}  p90=${stats.p90}`);
  console.log(
    `economy     ${mean(stats.results.map((r) => r.structures)).toFixed(1)} structures standing, ` +
    `${mean(stats.results.map((r) => r.ours)).toFixed(1)} of ${SECTOR_COUNT} sectors held at the end`,
  );

  // The trajectory. `theirs` opens at START_THEIRS; anything below that is
  // ground the player has taken, anything above is ground they have lost.
  const marks = [1, 3, 5, 10, 15, 20, 30, 50].filter((m) => m <= CEILING);
  console.log();
  console.log(`front       enemy-held sectors, mean over campaigns still running (opens at ${START_THEIRS})`);
  const rows = trajectory(stats.results, marks).filter((r) => r.alive > 0);
  console.log(`            run    ${rows.map((r) => String(r.run).padStart(6)).join("")}`);
  console.log(`            theirs ${rows.map((r) => r.theirs.toFixed(1).padStart(6)).join("")}`);
  console.log(`            still  ${rows.map((r) => String(r.alive).padStart(6)).join("")}`);

  // Where a loss turns. The high-water mark of a campaign that ends badly is
  // the difference between "never got going" and "was winning and lost it".
  const bad = stats.results.filter((r) => r.outcome !== "won");
  if (bad.length) {
    const led = bad.filter((r) => r.deepest < START_THEIRS - 4).length;
    console.log();
    console.log(
      `turning     campaigns not won reached ${mean(bad.map((r) => r.deepest)).toFixed(1)} enemy sectors ` +
      `at run ${mean(bad.map((r) => r.deepestAt)).toFixed(1)} before the tide turned`,
    );
    console.log(`            ${led} of ${bad.length} (${pct(led, bad.length)}) had taken five sectors or more first`);
  }
  console.log();
}

// ── modes ───────────────────────────────────────────────────────────────────

const label = (reach) =>
  `take=${TAKE}/run  reach=${reach}${VARY ? " mean (poisson)" : ""} steps/run  ` +
  `refits=${BUY_REFITS ? "bought" : "not modelled"}`;

if (TRACE !== null) {
  // One campaign, run by run. The aggregate says which way a war went; this
  // says how, and it is the only reading that shows the pressure budget
  // overtaking the player's fixed rate at the run it happens.
  const campaign = newCampaign(TRACE);
  console.log(`seed ${TRACE}  ${label(REACH)}`);
  console.log("run  theirs  contested  ours  budget  pushes  consolidates  moved");
  for (let run = 0; run < CEILING; run++) {
    const moved = modelPlayerRun(campaign, REACH);
    const budget = pressureBudget(campaign);
    const actions = advanceCampaign(campaign, makeRng(campaign.seed, campaign.rngCursor)).actions;
    const p = (x, w) => String(x).padStart(w);
    console.log(
      `${p(campaign.runsElapsed, 3)}  ${p(count(campaign, "theirs"), 6)}  ` +
      `${p(count(campaign, "contested"), 9)}  ${p(count(campaign, "ours"), 4)}  ${p(budget, 6)}  ` +
      `${p(actions.filter((a) => a.kind.startsWith("push")).length, 6)}  ` +
      `${p(actions.filter((a) => a.kind === "consolidate").length, 12)}  ${p(moved, 5)}`,
    );
    if (isWon(campaign)) { console.log("WON"); break; }
    if (isLost(campaign)) { console.log("LOST"); break; }
  }
} else if (ECONOMY) {
  // Does the chart participate in the war at all? Salvage buys patrols,
  // outposts, starbases and yards; if a run banking nothing and a run banking
  // five times the going rate resolve the same way, then the whole command
  // view is decoration and no rule change acting on the enemy will fix that.
  console.log(`trials      ${TRIALS} per row, reach=${REACH}${VARY ? " mean (poisson)" : " flat"}`);
  console.log();
  console.log(" take    won     lost   unres   median   structures");
  for (const value of ECONOMY_TAKES) {
    take = value;
    const results = [];
    for (let trial = 0; trial < TRIALS; trial++) results.push(runCampaign(trial + 1, REACH));
    const s = summarise(results);
    const p = (x, w) => String(x).padStart(w);
    console.log(
      `${p(value, 5)}  ${p(pct(s.won, s.trials), 6)}  ${p(pct(s.lost, s.trials), 6)}  ` +
      `${p(pct(s.unresolved, s.trials), 6)}  ${p(s.median, 6)}   ${p(mean(results.map((r) => r.structures)).toFixed(1), 10)}`,
    );
  }
  take = TAKE;
  console.log();
  console.log("A flat column is the finding, not a null result: it means the four decisions");
  console.log("the command view offers cannot change the outcome of the war they are about.");
} else if (SWEEP) {
  // The whole reach ladder in one command, because the finding that matters is
  // not any single row but whether two adjacent rows disagree.
  console.log(`trials      ${TRIALS} per row`);
  console.log(
    `model       take=${TAKE}/run  reach=${VARY ? "poisson about the mean" : "flat"}  ` +
    `refits=${BUY_REFITS ? "bought" : "not modelled"}`,
  );
  console.log();
  console.log("reach    won     lost   unres   median   deepest   turns at");
  const band = [];
  for (const reach of SWEEP_REACHES) {
    const results = [];
    for (let trial = 0; trial < TRIALS; trial++) results.push(runCampaign(trial + 1, reach));
    const s = summarise(results);
    const bad = results.filter((r) => r.outcome !== "won");
    const p = (x, w) => String(x).padStart(w);
    console.log(
      `${p(reach, 5)}  ${p(pct(s.won, s.trials), 6)}  ${p(pct(s.lost, s.trials), 6)}  ` +
      `${p(pct(s.unresolved, s.trials), 6)}  ${p(s.median, 6)}   ${p(mean(bad.map((r) => r.deepest)).toFixed(1), 7)}   ` +
      `${p(mean(bad.map((r) => r.deepestAt)).toFixed(1), 8)}`,
    );
    // Contested: both outcomes genuinely occur, and the war still ends. A row
    // that is 50% won and 50% deadlocked is not a contest, it is a coin flip
    // between winning and nothing happening.
    if (s.won / s.trials >= 0.1 && s.won / s.trials <= 0.9 && s.unresolved / s.trials <= 0.25) {
      band.push(reach);
    }
  }
  console.log();
  console.log("`deepest` and `turns at` describe the campaigns that were not won: how few");
  console.log("sectors the enemy was reduced to, and on which run, before the tide turned.");
  console.log();
  if (band.length === 0) {
    console.log("NO CONTESTED BAND. Every row resolves the same way for nearly every seed, so");
    console.log("the war is decided by the ratio of two rates and not by anything that happens");
    console.log("in it. A rule change that only moves the threshold lands here too.");
  } else {
    console.log(`CONTESTED BAND at reach ${band.join(", ")} — ${band.length} of ${SWEEP_REACHES.length} rows`);
    console.log("produce both wins and losses with the war still resolving. This is the reading");
    console.log("a candidate has to move; a threshold that merely shifted will show none.");
  }
} else {
  const results = [];
  for (let trial = 0; trial < TRIALS; trial++) results.push(runCampaign(trial + 1, REACH));
  const stats = summarise(results);
  report(stats, label(REACH));

  const winRate = stats.won / stats.trials;
  if (winRate === 0) {
    console.log(
      "every campaign resolved in the enemy's favour (0% won) — with an economy\n" +
      "on the board this is no longer a statement about the model player's\n" +
      "incapacity, and should be read as evidence about the pressure formula.",
    );
  } else if (stats.unresolved / stats.trials > 0.05) {
    console.log(
      `${pct(stats.unresolved, stats.trials)} of campaigns never resolved inside ${CEILING} runs.\n` +
      "A deadlock is its own failure: neither side can finish, so the war has no\n" +
      "length rather than a long one.",
    );
  } else {
    console.log(`target: median within 15-25, unresolved at 0% (won ${pct(stats.won, stats.trials)} of trials)`);
  }
}
