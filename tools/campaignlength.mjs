/**
 * Runs many campaigns against a crude model player and reports how long they
 * take to resolve. This does not say whether the chart is fun. It says
 * whether ENEMY_START_DEPTH and the pressure formula produce the 15-25 run
 * campaign they are supposed to, which is otherwise a discovery that costs an
 * evening.
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
console.log(`trials      ${TRIALS}`);
console.log(`won         ${won}  (${((won / TRIALS) * 100).toFixed(1)}%)`);
console.log(`lost        ${lost}  (${((lost / TRIALS) * 100).toFixed(1)}%)`);
console.log(`unresolved  ${stalled}  (${((stalled / TRIALS) * 100).toFixed(1)}%)`);
console.log(`runs        p10=${at(0.1)}  median=${at(0.5)}  p90=${at(0.9)}`);
console.log(`\ntarget: median within 15-25, unresolved at 0%`);
