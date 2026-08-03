/**
 * Runs many campaigns against a crude model player and reports how long they
 * take to resolve. This does not say whether the chart is fun. It says
 * whether ENEMY_START_DEPTH and the pressure formula produce the 15-25 run
 * campaign they are supposed to, which is otherwise a discovery that costs an
 * evening.
 *
 * Important caveat, established by measurement rather than argument: this
 * model player cannot win. `pressureBudget` (src/chart/enemyTurn.ts) grows
 * without bound — `PRESSURE.base + floor(runsElapsed / 2) + sectorsLost` has
 * no cap — while the model player retakes sectors at a fixed rate per turn.
 * Any fixed-rate defender that falls behind early is eventually overwhelmed
 * by a budget that keeps climbing for the rest of the campaign; raising the
 * defender's rate only delays the loss; it was measured up to a 4x rate
 * (retakes=4) without producing a single win across 5000 trials, and past
 * that the campaign deadlocks rather than resolves (see the fix-round-1
 * section of task-5-report.md for the full sweep). The model player also has
 * none of the defensive tools a real player will have: patrols and
 * structures, which cost the enemy +2 and +3 respectively to overcome
 * (DEFENCE_COST in enemyTurn.ts), belong to a later plan and are not
 * simulated here. So a 0% win rate here is not evidence the chart is
 * unwinnable for a real player — it means this instrument, as it stands, can
 * only measure time-to-defeat, not campaign length in the sense the design
 * doc means. It will not be able to validate campaign length for real until
 * the model player has an economy (salvage-funded consolidation, patrols,
 * structures) or the pressure formula is capped — both are design decisions,
 * not something this tool should silently paper over.
 *
 *   npm run campaignlength [runs]
 */
const { newCampaign, countControl, isWon, isLost } =
  await import("../.campaign-build/chart/campaign.js");
const { runEnemyTurn } = await import("../.campaign-build/chart/enemyTurn.js");
const { makeRng } = await import("../.campaign-build/chart/rng.js");
const { neighbours } = await import("../.campaign-build/chart/sectors.js");

const TRIALS = Number(process.argv[2] ?? 2000);
const CEILING = 200;

/**
 * The model player retakes one contested or lost sector per run — roughly
 * what a competent run's salvage buys. Deliberately crude: it is a yardstick
 * for the enemy's rate, not a simulation of play.
 */
function modelPlayerTurn(campaign) {
  const retakeable = campaign.sectors
    .map((sector, index) => ({ sector, index }))
    .filter(({ sector }) => sector.control !== "ours")
    .filter(({ index }) =>
      neighbours(index).some((n) => campaign.sectors[n].control === "ours"),
    );
  if (!retakeable.length) return;
  const target = retakeable[0];
  target.sector.control = target.sector.control === "theirs" ? "contested" : "ours";
}

const lengths = [];
let won = 0;
let lost = 0;
let stalled = 0;

for (let trial = 0; trial < TRIALS; trial++) {
  const campaign = newCampaign(trial + 1);
  let run = 0;
  for (; run < CEILING; run++) {
    campaign.runsElapsed = run;
    modelPlayerTurn(campaign);
    const rng = makeRng(campaign.seed, campaign.rngCursor);
    runEnemyTurn(campaign, rng);
    campaign.rngCursor = rng.cursor;
    if (isWon(campaign)) { won++; break; }
    if (isLost(campaign)) { lost++; break; }
  }
  if (run >= CEILING) stalled++;
  lengths.push(run);
}

lengths.sort((a, b) => a - b);
const at = (q) => lengths[Math.floor(lengths.length * q)];
const winRate = won / TRIALS;

// Outcome split first: it frames what the length percentiles below actually
// mean. A campaign length is only meaningful once both sides can plausibly
// win it; a 100%-loss distribution is a time-to-defeat, not a length.
console.log(`trials      ${TRIALS}`);
console.log(`won         ${won}  (${(winRate * 100).toFixed(1)}%)`);
console.log(`lost        ${lost}  (${((lost / TRIALS) * 100).toFixed(1)}%)`);
console.log(`unresolved  ${stalled}  (${((stalled / TRIALS) * 100).toFixed(1)}%)`);
console.log(`runs        p10=${at(0.1)}  median=${at(0.5)}  p90=${at(0.9)}`);
console.log();
if (winRate === 0) {
  console.log(
    "every campaign resolved in the enemy's favour (0% won) — the figure\n" +
    "above is median time-to-defeat against this specific, win-incapable\n" +
    "model player, not a validated campaign length. See the header comment\n" +
    "for why this model player cannot win.",
  );
} else {
  console.log(`target: median within 15-25, unresolved at 0% (won ${(winRate * 100).toFixed(1)}% of trials)`);
}
