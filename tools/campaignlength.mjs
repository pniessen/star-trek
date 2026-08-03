/**
 * Runs many campaigns against a model player and reports how long they take to
 * resolve. This does not say whether the chart is fun. It says whether
 * ENEMY_START_DEPTH and the pressure formula produce the 15-25 run campaign
 * they are supposed to, and — since the command view exists — whether an
 * economy on the player's side of the ledger can win one at all.
 *
 * The model player now has the tools the command view gives a real one. It
 * banks salvage, takes ground by flying somewhere and clearing it, fields and
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
 *   npm run campaignlength -- [trials] [--take=N] [--reach=N] [--refits]
 */
const { newCampaign, creditSalvage, hasStructure, isWon, isLost } =
  await import("../.campaign-build/chart/campaign.js");
const {
  advanceCampaign, build, deployPatrol, gainGround,
  patrolCapacity, patrolCount, toggleRefit, PATROL, REFITS,
} = await import("../.campaign-build/chart/economy.js");
const { makeRng } = await import("../.campaign-build/chart/rng.js");
const { neighbours } = await import("../.campaign-build/chart/sectors.js");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? fallback : Number(found.split("=")[1]);
};
const TRIALS = Number(args.find((a) => !a.startsWith("--")) ?? 2000);
/**
 * Salvage a run banks in a yield-0 sector, before the sector's own multiplier.
 * Anchored on the game's own numbers rather than guessed: waves one to three
 * are worth 200 + 300 + 575 in hostile value, and a player who banks twice at
 * a middling multiplier brings home a little over a thousand of it.
 */
const TAKE = flag("take", 1200);
/**
 * Steps of ground a run moves. One step is one wave cleared in the sector you
 * are standing in — theirs to contested, or contested to yours — so three is a
 * run that takes its drop sector outright and hyperwarps once to start on the
 * next. This is the single most decisive number in the whole model; see the
 * sweep recorded in status.md §3 before changing it.
 */
const REACH = flag("reach", 3);
const BUY_REFITS = args.includes("--refits");
const CEILING = 200;

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
 * One visit to the command view, then one run.
 *
 * Spending order is cheapest-useful-first, which is what a player short of
 * salvage actually does: hold the line with patrols, then buy somewhere to
 * bank near the front, then insurance against losing the last starbase, then
 * the yard that stops patrols being one-shot.
 */
function spend(campaign) {
  const line = frontLine(campaign);
  const held = campaign.sectors.filter((s) => s.control === "ours");

  for (let step = 0; step < 12; step++) {
    // A patrol on undefended front-line ground, if there is room for one.
    const bare = line.find((i) => !campaign.sectors[i].patrol);
    if (bare !== undefined && patrolCount(campaign) < patrolCapacity(campaign)) {
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

function modelPlayerRun(campaign) {
  const targets = reachable(campaign);
  // Decision four: where to drop. Richest reachable ground, or stay home.
  if (targets.length) {
    campaign.front = targets[0];
    campaign.current = targets[0];
  }

  // What the run banks, scaled by the drop sector's yield the way `Session`
  // scales it — `1 + yield`, per the deviation recorded in status.md §3.
  creditSalvage(campaign, TAKE * (1 + campaign.sectors[campaign.front].yield));

  // Ground taken by clearing waves where you are standing. Spread across the
  // richest reachable sectors, which is what hyperwarp makes possible.
  let moved = 0;
  for (const index of targets) {
    while (moved < REACH && gainGround(campaign, index)) moved++;
    if (moved >= REACH) break;
  }

  spend(campaign);
}

const lengths = [];
let won = 0;
let lost = 0;
let stalled = 0;
const structuresBuilt = [];
const groundHeld = [];

for (let trial = 0; trial < TRIALS; trial++) {
  const campaign = newCampaign(trial + 1);
  let run = 0;
  for (; run < CEILING; run++) {
    modelPlayerRun(campaign);
    advanceCampaign(campaign, makeRng(campaign.seed, campaign.rngCursor));
    if (isWon(campaign)) { won++; break; }
    if (isLost(campaign)) { lost++; break; }
  }
  if (run >= CEILING) stalled++;
  lengths.push(run);
  structuresBuilt.push(campaign.sectors.reduce((n, s) => n + s.structures.length, 0));
  groundHeld.push(campaign.sectors.filter((s) => s.control === "ours").length);
}

lengths.sort((a, b) => a - b);
const at = (q) => lengths[Math.floor(lengths.length * q)];
const winRate = won / TRIALS;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Outcome split first: it frames what the length percentiles below actually
// mean. A campaign length is only meaningful once both sides can plausibly
// win it; a 100%-loss distribution is a time-to-defeat, not a length.
console.log(`trials      ${TRIALS}`);
// One step is half a sector: theirs to contested, or contested to yours.
console.log(`model       take=${TAKE}/run  reach=${REACH} steps/run  refits=${BUY_REFITS ? "bought" : "not modelled"}`);
console.log(`won         ${won}  (${(winRate * 100).toFixed(1)}%)`);
console.log(`lost        ${lost}  (${((lost / TRIALS) * 100).toFixed(1)}%)`);
console.log(`unresolved  ${stalled}  (${((stalled / TRIALS) * 100).toFixed(1)}%)`);
console.log(`runs        p10=${at(0.1)}  median=${at(0.5)}  p90=${at(0.9)}`);
// What the economy actually bought, so a run where salvage made no difference
// is visible as such rather than being hidden inside the outcome split.
console.log(`economy     ${mean(structuresBuilt).toFixed(1)} structures standing, ${mean(groundHeld).toFixed(1)} of 64 sectors held at the end`);
console.log();

if (winRate === 0) {
  console.log(
    "every campaign resolved in the enemy's favour (0% won) — with an economy\n" +
    "on the board this is no longer a statement about the model player's\n" +
    "incapacity, and should be read as evidence about the pressure formula.",
  );
} else if (stalled / TRIALS > 0.05) {
  console.log(
    `${((stalled / TRIALS) * 100).toFixed(1)}% of campaigns never resolved inside ${CEILING} runs.\n` +
    "A deadlock is its own failure: neither side can finish, so the war has no\n" +
    "length rather than a long one.",
  );
} else {
  console.log(`target: median within 15-25, unresolved at 0% (won ${(winRate * 100).toFixed(1)}% of trials)`);
}
