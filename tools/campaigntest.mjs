/**
 * Asserts the campaign rules outside a browser. The chart is pure logic —
 * no renderer, no DOM — so unlike the combat harness this needs neither.
 *
 *   npm run campaigntest
 */
const problems = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) problems.push(`assertion failed: ${label} (${detail})`);
};

const { makeRng } = await import("../.campaign-build/chart/rng.js");
const { GRID, SECTOR_COUNT, indexOf, colOf, rowOf, inBounds, neighbours } =
  await import("../.campaign-build/chart/sectors.js");

// ── rng ─────────────────────────────────────────────────────────────────────
const a = makeRng(12345);
const firstFive = [a.next(), a.next(), a.next(), a.next(), a.next()];
check("rng is in range", firstFive.every((n) => n >= 0 && n < 1), firstFive[0].toFixed(4));

const b = makeRng(12345);
check(
  "same seed replays identically",
  [b.next(), b.next(), b.next(), b.next(), b.next()].every((n, i) => n === firstFive[i]),
  "5 draws",
);

// The cursor is the whole reason this exists: a campaign reloaded mid-way
// must not re-roll the enemy's turn.
const resumed = makeRng(12345, 3);
check("cursor resumes the sequence", resumed.next() === firstFive[3], `cursor=3`);
check("cursor advances with draws", a.cursor === 5, `cursor=${a.cursor}`);

// ── grid ────────────────────────────────────────────────────────────────────
check("grid is 8x8", GRID === 8 && SECTOR_COUNT === 64, `${GRID}x${GRID}`);
check("index round-trips", indexOf(colOf(37), rowOf(37)) === 37, "sector 37");
check("bounds reject off-grid", !inBounds(-1, 0) && !inBounds(0, 8) && inBounds(7, 7), "corners");

const middle = neighbours(indexOf(3, 3));
check("a middle sector has four neighbours", middle.length === 4, `n=${middle.length}`);
const corner = neighbours(indexOf(0, 0));
check("a corner sector has two", corner.length === 2, `n=${corner.length}`);
check(
  "neighbours are orthogonal only",
  !neighbours(indexOf(3, 3)).includes(indexOf(4, 4)),
  "no diagonals",
);

const {
  CAMPAIGN_VERSION, ENEMY_START_DEPTH, newCampaign, creditSalvage,
  spendSalvage, countControl, hasStructure, canDock, isWon, isLost,
} = await import("../.campaign-build/chart/campaign.js");

// ── a fresh campaign ────────────────────────────────────────────────────────
const c = newCampaign(99);
check("a campaign has 64 sectors", c.sectors.length === SECTOR_COUNT, `n=${c.sectors.length}`);
check("it is stamped with a version", c.version === CAMPAIGN_VERSION, `v${c.version}`);
check("it starts with no salvage", c.salvage === 0, `salvage=${c.salvage}`);
check("it starts at run zero", c.runsElapsed === 0 && c.sectorsLost === 0, "counters clear");

const theirs = countControl(c, "theirs");
check(
  "the enemy opens holding ENEMY_START_DEPTH rows",
  theirs === ENEMY_START_DEPTH * GRID,
  `theirs=${theirs}, expected=${ENEMY_START_DEPTH * GRID}`,
);

// You must always have somewhere to launch from, or the first run is
// unplayable — the one thing the design forbids outright.
const starbases = c.sectors.filter((s) => hasStructure(s, "starbase")).length;
check("you open with exactly one starbase", starbases === 1, `n=${starbases}`);
check("the front is a sector you hold", c.sectors[c.front].control === "ours", `front=${c.front}`);
check("you start where you launch from", c.current === c.front, `current=${c.current}`);
check("nothing is inbound yet", c.incoming.length === 0, "clear");
check("a starbase is a dock", canDock(c.sectors.find((s) => hasStructure(s, "starbase"))), "starbase");
// Sector 0 is never the front (the front is always the board's centre-bottom
// home sector) and starts with no structures, so this is unconditionally a
// bare sector — no `|| c.front === 0` needed, and that clause was dead: it
// would have made this pass unconditionally had `front` ever actually been 0.
check("empty space is not", !canDock(c.sectors[0]), "bare sector");

// ── salvage ─────────────────────────────────────────────────────────────────
creditSalvage(c, 500);
check("salvage credits", c.salvage === 500, `salvage=${c.salvage}`);
check("affordable spending succeeds", spendSalvage(c, 200) === true, `salvage=${c.salvage}`);
check("...and debits", c.salvage === 300, `salvage=${c.salvage}`);
check("unaffordable spending is refused", spendSalvage(c, 9999) === false, "refused");
check("...and changes nothing", c.salvage === 300, `salvage=${c.salvage}`);
// Drive it well past zero: a clamp that is never crossed is not tested.
creditSalvage(c, -500);
check("salvage never goes negative", c.salvage === 0, `salvage=${c.salvage}`);

// ── win and loss ────────────────────────────────────────────────────────────
check("a fresh campaign is neither won nor lost", !isWon(c) && !isLost(c), "in progress");

const cleared = newCampaign(1);
for (const s of cleared.sectors) if (s.control === "theirs") s.control = "ours";
check("no enemy sectors is a win", isWon(cleared), "front pushed off");

const doomed = newCampaign(2);
for (const s of doomed.sectors) s.structures = s.structures.filter((x) => x.kind !== "starbase");
check("no starbase is a loss", isLost(doomed), "last starbase fell");

// ── persistence ────────────────────────────────────────────────────────────
const { SAVE_KEY, save, load } = await import("../.campaign-build/chart/persistence.js");

/** Stands in for localStorage, which does not exist in node. */
const fakeStorage = (seed = {}) => {
  const data = { ...seed };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    raw: data,
  };
};

const store = fakeStorage();
const original = newCampaign(4242);
original.salvage = 750;
original.runsElapsed = 6;
original.rngCursor = 31;
save(original, store);
const restored = load(store, 1);

check("a save round-trips salvage", restored.salvage === 750, `salvage=${restored.salvage}`);
check("...and the run counter", restored.runsElapsed === 6, `runs=${restored.runsElapsed}`);
check("...and the seed", restored.seed === 4242, `seed=${restored.seed}`);
// The subtle one. Without the cursor a reload re-rolls the enemy's turn.
check("...and the RNG cursor", restored.rngCursor === 31, `cursor=${restored.rngCursor}`);
check(
  "...and the board exactly",
  JSON.stringify(restored.sectors) === JSON.stringify(original.sectors),
  "64 sectors",
);

// A player whose save fails to parse gets a new campaign, not a black screen.
const corrupt = load(fakeStorage({ [SAVE_KEY]: "{not json" }), 7);
check("corrupt saves start fresh", corrupt.seed === 7 && corrupt.salvage === 0, "recovered");

const absent = load(fakeStorage(), 8);
check("absent saves start fresh", absent.seed === 8, "recovered");

const stale = fakeStorage({
  [SAVE_KEY]: JSON.stringify({ ...original, version: CAMPAIGN_VERSION + 99 }),
});
const migrated = load(stale, 9);
check("a future version resets rather than crashing", migrated.seed === 9, "reset");

// A save with a truncated sectors array passes a check that only looks for
// `Array.isArray` — `campaign.sectors[campaign.current].threat` then throws
// inside `frame()`, before `requestAnimationFrame` re-arms, and the game
// freezes on the last frame instead of falling back to a fresh campaign.
const truncated = fakeStorage({
  [SAVE_KEY]: JSON.stringify({ ...original, sectors: original.sectors.slice(0, 3) }),
});
const rescued = load(truncated, 10);
check(
  "a truncated sectors array starts fresh, not a black screen",
  rescued.seed === 10 && rescued.sectors.length === SECTOR_COUNT,
  `sectors=${rescued.sectors.length}`,
);

const { PRESSURE, pressureBudget, runEnemyTurn, intercept } =
  await import("../.campaign-build/chart/enemyTurn.js");

// ── the budget ──────────────────────────────────────────────────────────────
const fresh = newCampaign(11);
check("opening pressure is the base", pressureBudget(fresh) === PRESSURE.base, `p=${pressureBudget(fresh)}`);

// The budget now reads the live board, not the `sectorsLost` counter (see
// enemyTurn.ts's `sectorsHeldBeyondStart`) — so "losses" here means actually
// flipping sector control, not setting a field.
const later = newCampaign(11);
later.runsElapsed = 10;
const takenA = later.sectors.findIndex((s) => s.control === "ours");
later.sectors[takenA].control = "theirs";
const takenB = later.sectors.findIndex((s, i) => s.control === "ours" && i !== takenA);
later.sectors[takenB].control = "theirs";
check(
  "pressure climbs with runs and ground actually lost",
  pressureBudget(later) === PRESSURE.base + Math.floor(10 / PRESSURE.runsPerStep) + 2,
  `p=${pressureBudget(later)}`,
);

// The fix for the ratchet: retaking one of the two sectors just flipped must
// lower the budget again immediately, live — not stay charged for a loss
// that no longer exists. Against the old `campaign.sectorsLost`-based budget
// (which only ever incremented) this assertion fails, because retaking
// ground never touched that counter.
const budgetBeforeRetake = pressureBudget(later);
later.sectors[takenA].control = "ours";
check(
  "retaking ground lowers the pressure budget",
  pressureBudget(later) === budgetBeforeRetake - 1,
  `before=${budgetBeforeRetake} after=${pressureBudget(later)}`,
);

// ── spending ────────────────────────────────────────────────────────────────
const turn = newCampaign(12);
const rng = makeRng(turn.seed, turn.rngCursor);
const actions = runEnemyTurn(turn, rng);
const spent = actions.reduce((sum, a) => sum + a.cost, 0);
check("the enemy spends something", actions.length > 0, `${actions.length} actions`);
check("...and never overspends", spent <= pressureBudget(newCampaign(12)), `spent=${spent}`);

// The enemy may only act next to ground it already holds. Without this the
// front is meaningless and sectors fall at random.
const startedTheirs = newCampaign(12).sectors.map((s) => s.control === "theirs");
check(
  "the enemy only acts adjacent to itself",
  actions.every(
    (a) => startedTheirs[a.sector] || neighbours(a.sector).some((n) => startedTheirs[n]),
  ),
  "adjacency",
);

// ── the promise that matters ────────────────────────────────────────────────
// "Ignore a sector for four runs and it falls, and it stays fallen." The
// promise is about *some* neglected ground falling, not about any one
// specific sector — pinning it to a single sector (e.g. the first one found)
// makes the assertion a shuffle-position lottery for that sector rather than
// a test of the stated behaviour, since every push-ours candidate costs the
// same and only shuffle order decides which get funded first.
const neglected = newCampaign(13);
const startedOurs = neglected.sectors.map((s) => s.control === "ours");
for (let run = 1; run <= 4; run++) {
  neglected.runsElapsed = run;
  const r = makeRng(neglected.seed, neglected.rngCursor);
  runEnemyTurn(neglected, r);
  neglected.rngCursor = r.cursor;
}
check(
  "a neglected front sector falls within four runs",
  neglected.sectors.some((s, i) => startedOurs[i] && s.control !== "ours"),
  `lost=${neglected.sectorsLost}`,
);

// Losses are counted, because the budget depends on them.
check("losing ground is recorded", neglected.sectorsLost > 0, `lost=${neglected.sectorsLost}`);

// ── committed, not instant ──────────────────────────────────────────────────
// Pressure buys a move that lands a run later. The gap is what the player
// can fly out and stop.
const commits = newCampaign(15);
const beforeControl = commits.sectors.map((s) => s.control);
runEnemyTurn(commits, makeRng(15, 0));
check("a push is committed, not applied", commits.incoming.length > 0, `${commits.incoming.length} inbound`);
check(
  "...and nothing has flipped yet",
  commits.sectors.every((s, i) => s.control === beforeControl[i]),
  "board unchanged",
);

const landed = commits.incoming[0].sector;
commits.runsElapsed = 1;
runEnemyTurn(commits, makeRng(15, commits.rngCursor));
check(
  "an unopposed move lands next turn",
  commits.sectors[landed].control !== beforeControl[landed],
  `sector ${landed}`,
);

// Interception: reach it and clear it and the attack never arrives.
const stopped = newCampaign(16);
runEnemyTurn(stopped, makeRng(16, 0));
const doomedSector = stopped.incoming[0].sector;
const controlBefore = stopped.sectors[doomedSector].control;
check("interception reports a hit", intercept(stopped, doomedSector) === true, `sector ${doomedSector}`);
check("intercepting an empty sector reports nothing", intercept(stopped, doomedSector) === false, "already clear");
stopped.runsElapsed = 1;
runEnemyTurn(stopped, makeRng(16, stopped.rngCursor));
check(
  "an intercepted move never lands",
  stopped.sectors[doomedSector].control === controlBefore,
  `sector ${doomedSector} held`,
);

// Determinism: same seed, same war. Compares incoming as well as sectors —
// a push only touches campaign.incoming (it lands later, via resolveIncoming
// on a subsequent turn), so a turn whose entire budget goes to pushes would
// leave campaign.sectors unchanged and byte-identical between runs even if
// the shuffle driving which sectors got pushed were not actually seeded.
const runA = newCampaign(14);
const runB = newCampaign(14);
runEnemyTurn(runA, makeRng(14, 0));
runEnemyTurn(runB, makeRng(14, 0));
check(
  "the same seed produces the same turn",
  JSON.stringify({ sectors: runA.sectors, incoming: runA.incoming }) ===
    JSON.stringify({ sectors: runB.sectors, incoming: runB.incoming }),
  "deterministic",
);

// ════════════════════════════════════════════════════════════════════════════
// The economy: what salvage buys, and the tick between one run and the next.
// ════════════════════════════════════════════════════════════════════════════

const {
  STRUCTURES, REFITS, PATROL, NO_REFITS,
  build, toggleRefit, deployPatrol, patrolCapacity, patrolCount,
  loadoutOf, gainGround, advanceCampaign, campaignFor, restartCampaign,
  hasAnyStructure, structureSpec,
} = await import("../.campaign-build/chart/economy.js");

const { DECISIONS, decide, refusal } = await import("../.campaign-build/chart/command.js");

// ── the finite invasion, shipped ────────────────────────────────────────────
// pressureBudget, runEnemyTurn and gainGround are already imported above;
// RESERVE and reserveOf are the only names this section needs that aren't.
const { RESERVE, reserveOf } = await import("../.campaign-build/chart/enemyTurn.js");

{
  const c = newCampaign(7);
  check("a fresh campaign reads a full reserve", reserveOf(c) === RESERVE.initial,
    `reserve=${reserveOf(c)}`);

  // Ground taken drains the reserve, unconditionally.
  const before = reserveOf(c);
  // front row of enemy ground: any sector with control "theirs"
  const target = c.sectors.findIndex((s) => s.control === "theirs");
  gainGround(c, target);
  check("gainGround drains the reserve", reserveOf(c) === before - RESERVE.costPerStep,
    `reserve=${reserveOf(c)} expected=${before - RESERVE.costPerStep}`);

  // The budget is clamped by the committed share of the reserve.
  c.reserve = 4;
  check("budget is clamped by the reserve",
    pressureBudget(c) <= Math.floor(4 * RESERVE.commit),
    `budget=${pressureBudget(c)}`);
}

{
  // Exhaustion, measured on arrival, wins the war.
  const c = newCampaign(11);
  c.reserve = 0;
  const rng = makeRng(11, 0);
  for (let i = 0; i < RESERVE.brokenFor; i++) {
    c.reserve = 0;                 // the player kept draining it between turns
    runEnemyTurn(c, rng);
  }
  check("an empty reserve for brokenFor turns wins the war", isWon(c),
    `exhausted=${c.exhausted}`);
}

{
  // Save compatibility: a campaign written before adoption has no reserve and
  // no exhausted field. It must read a full reserve and take a turn unharmed.
  const c = newCampaign(19);
  delete c.reserve;
  delete c.exhausted;
  check("an old-shape save reads a full reserve", reserveOf(c) === RESERVE.initial,
    `reserve=${reserveOf(c)}`);
  runEnemyTurn(c, makeRng(19, 0));
  check("an old-shape save survives a turn", typeof c.reserve === "number" && !isWon(c),
    `reserve=${c.reserve}`);
}

{
  // The floor is gone: pushing them below their opening depth lowers ambition
  // below base. With the reserve full this is visible as a smaller clamp input;
  // assert on the formula's own output with a huge reserve so ambition binds.
  const c = newCampaign(13);
  c.reserve = 10_000;
  for (const s of c.sectors) s.control = "ours";
  c.sectors[0].control = "theirs";           // one sector left of 24
  check("deep pushes lower ambition below base",
    pressureBudget(c) < 6,
    `budget=${pressureBudget(c)}`);
}

/** The home starbase's sector, found the way the game finds it. */
const homeOf = (campaign) => campaign.sectors.findIndex((s) => hasStructure(s, "starbase"));
/** A sector you hold that the enemy is standing next to. Where the interesting decisions are. */
const frontLineOf = (campaign) =>
  campaign.sectors.findIndex(
    (s, i) => s.control === "ours" && neighbours(i).some((n) => campaign.sectors[n].control === "theirs"),
  );
const advance = (campaign) => advanceCampaign(campaign, makeRng(campaign.seed, campaign.rngCursor));

// ── the four decisions are the documented four ──────────────────────────────
check("the price list is strategy-layer.md's",
  STRUCTURES.map((s) => s.cost).join() === "250,600,1600,2400" &&
  STRUCTURES.map((s) => s.runs).join() === "1,2,4,5",
  STRUCTURES.map((s) => `${s.cost}/${s.runs}`).join(" "));
check("all seven refits exist and are priced",
  REFITS.length === 7 && REFITS.every((r) => r.cost > 0 && r.gain && r.price),
  `${REFITS.length} refits`);
// Four decisions, one screen, no submenus: the list is flat and it is four
// kinds. A nested option would show up here as a fifth kind or a missing one.
check("there are exactly four kinds of decision",
  new Set(DECISIONS.map((d) => d.kind)).size === 4 &&
    DECISIONS.map((d) => d.kind).join(",") ===
      "build,build,build,build,refit,refit,refit,refit,refit,refit,refit,deploy,front",
  DECISIONS.map((d) => d.kind).join(","));

// ── construction takes runs, not salvage ────────────────────────────────────
const site = newCampaign(101);
creditSalvage(site, 5000);
const buildAt = frontLineOf(site);
check("a listening post can be laid down", build(site, buildAt, "listening-post"), `sector ${buildAt}`);
check("...and debits immediately", site.salvage === 5000 - 250, `salvage=${site.salvage}`);
check("...and is not standing yet", !hasStructure(site.sectors[buildAt], "listening-post"), "under construction");
build(site, buildAt, "outpost");
check("a second, longer build sits alongside it", site.sectors[buildAt].structures.length === 2, "two");

advance(site);
// Both halves, not one: the one-run structure must be up and the two-run one
// must still be down. Checking only the first would pass an implementation
// that completed everything the moment a run ended.
check(
  "one run completes the one-run structure and not the two-run one",
  hasStructure(site.sectors[buildAt], "listening-post") &&
    !hasStructure(site.sectors[buildAt], "outpost"),
  `remaining=${site.sectors[buildAt].structures.map((s) => s.runsRemaining).join()}`,
);
advance(site);
check(
  "the second run completes the outpost",
  hasStructure(site.sectors[buildAt], "outpost"),
  `remaining=${site.sectors[buildAt].structures.map((s) => s.runsRemaining).join()}`,
);
check("...which makes the sector a dock", canDock(site.sectors[buildAt]), "somewhere to bank");
check("construction cannot be bought out",
  refusal(site, DECISIONS.find((d) => d.id === "outpost"), buildAt) !== null,
  "no second outpost, at any price");

// ── a structure broken mid-build refunds nothing ────────────────────────────
// Driven through a real enemy assault rather than by popping the array, so the
// assertion exercises the path that actually destroys things.
const gamble = newCampaign(102);
creditSalvage(gamble, 5000);
const exposedSite = frontLineOf(gamble);
build(gamble, exposedSite, "starbase");
const paid = gamble.salvage;
const buildingWhenLost = gamble.sectors[exposedSite].structures[0].runsRemaining;
// The gamble the design describes: the sector falls while the yard is still
// scaffolding. `runEnemyTurn` prices a held sector with structures as an
// assault, so give it the ground and enough turns to afford one — the
// reserve now caps what the enemy can spend in any single turn, so the
// assault has to wait its turn behind cheaper expansion rather than landing
// on the first one.
gamble.sectors[exposedSite].control = "theirs";
gamble.runsElapsed = 30;
for (let i = 0; i < 20 && gamble.sectors[exposedSite].structures.length > 0; i++) {
  const r = makeRng(gamble.seed, gamble.rngCursor);
  runEnemyTurn(gamble, r);
  gamble.rngCursor = r.cursor;
}
check(
  "a structure still under construction can be destroyed",
  gamble.sectors[exposedSite].structures.length === 0 && buildingWhenLost > 0,
  `runsRemaining was ${buildingWhenLost}`,
);
check("...and refunds nothing", gamble.salvage === paid, `salvage=${gamble.salvage}, paid=${paid}`);

// ── refits ──────────────────────────────────────────────────────────────────
const fitted = newCampaign(103);
creditSalvage(fitted, 5000);
const fitHome = homeOf(fitted);
const bare = frontLineOf(fitted);
const racks = DECISIONS.find((d) => d.id === "torpedo-racks");

check(
  "a refit is refused away from a starbase",
  refusal(fitted, racks, bare) !== null && refusal(fitted, racks, fitHome) === null,
  `bare=${refusal(fitted, racks, bare)}`,
);
decide(fitted, racks, fitHome);
check("fitting costs salvage", fitted.salvage === 5000 - 350, `salvage=${fitted.salvage}`);
check("...and shows up in the loadout", loadoutOf(fitted.refits).torpedoCapacity === 6, "+6 rounds");

// Every refit is a tradeoff, never an upgrade: each one must make at least one
// number worse. Asserted over the whole table rather than one example, because
// a seventh refit added later is exactly when this stops being true quietly.
const worse = REFITS.filter((spec) => {
  const fit = loadoutOf([spec.id]);
  return (
    fit.shieldCapacity < 1 || fit.shieldRegen < 1 || fit.turnRate < 1 ||
    fit.phaserRange < 1 || fit.phaserCost > 1 || fit.regenStopsWhenHulled ||
    // The dilithium matrix's price. A bigger store that fills slower is the
    // honest tradeoff for capacity, and this clause is what the comment above
    // predicted would be needed the day a seventh refit landed.
    fit.reserveRegen < 1
  );
});
check("every refit costs the ship something", worse.length === REFITS.length, `${worse.length} of ${REFITS.length}`);
// The one interaction that could have made a pure upgrade out of a pair: the
// coils flatten the phaser's damage curve, so the capacitor's price has to be
// range rather than slope or the coils would erase it.
const bothPhaser = loadoutOf(["capacitor-bank", "focusing-coils"]);
check(
  "the focusing coils do not erase the capacitor bank's price",
  bothPhaser.phaserFlat && bothPhaser.phaserRange < 1,
  `range=${bothPhaser.phaserRange}`,
);
check("a bare hull is exactly the stock ship",
  JSON.stringify(loadoutOf([])) === JSON.stringify(NO_REFITS), "neutral");

// Stripping is free and refunds nothing, so churn has a price.
const afterFitting = fitted.salvage;
decide(fitted, racks, fitHome);
check("stripping a refit is free", fitted.refits.length === 0 && fitted.salvage === afterFitting, `salvage=${fitted.salvage}`);
decide(fitted, racks, fitHome);
check("...and refitting charges again", fitted.salvage === afterFitting - 350, `salvage=${fitted.salvage}`);

// The locked decision: refits persist through death. Every run ends in one, so
// anything that cleared them between runs would clear them always. Nothing in
// the between-runs tick may touch the list.
fitted.refits.push("ablative-plating");
const fittedBefore = [...fitted.refits];
for (let i = 0; i < 6; i++) advance(fitted);
check(
  "refits survive every run in between",
  JSON.stringify(fitted.refits) === JSON.stringify(fittedBefore) &&
    loadoutOf(fitted.refits).ablative === true,
  `${fitted.refits.join()} after ${fitted.runsElapsed} runs`,
);

// ── patrols ─────────────────────────────────────────────────────────────────
const held = newCampaign(104);
creditSalvage(held, 5000);
const post = frontLineOf(held);
check("a patrol can be fielded", deployPatrol(held, post), `sector ${post}`);
check("...at full strength", held.sectors[post].patrol.strength === PATROL.maxStrength, `s=${held.sectors[post].patrol.strength}`);
check("...and costs salvage", held.salvage === 5000 - PATROL.cost, `salvage=${held.salvage}`);
check("a second patrol is refused without a yard",
  patrolCapacity(held) === 1 && !deployPatrol(held, homeOf(held)),
  `capacity=${patrolCapacity(held)}`);
check("a patrol cannot be pushed into enemy space",
  !deployPatrol(held, held.sectors.findIndex((s) => s.control === "theirs")),
  "holds ground, does not take it");

// "An unsupported patrol on the front dies in ~3 runs." Both ends checked: it
// must still be there after two and gone after three. Asserting only the death
// would pass an implementation that killed it on the first run.
advance(held);
advance(held);
// Read the number, not the object: `wearPatrols` decrements in place, so a
// held reference would report the strength it ends at rather than the strength
// it had here — and the assertion would then be measuring the wrong run.
const survivedTwo = held.sectors[post].patrol ? held.sectors[post].patrol.strength : null;
advance(held);
check(
  "an unsupported patrol on the front lasts two runs and dies on the third",
  survivedTwo === 1 && held.sectors[post].patrol === undefined,
  `after two: ${survivedTwo}, after three: ${held.sectors[post].patrol}`,
);
check("...and is gone for good without a yard", patrolCount(held) === 0, `patrols=${patrolCount(held)}`);

// A patrol behind the line takes no attrition at all: exposure, not time.
const rear = newCampaign(105);
creditSalvage(rear, 5000);
deployPatrol(rear, homeOf(rear));
for (let i = 0; i < 5; i++) advance(rear);
check(
  "a patrol behind the line takes no attrition",
  rear.sectors[homeOf(rear)].patrol !== undefined &&
    rear.sectors[homeOf(rear)].patrol.strength === PATROL.maxStrength,
  `strength=${rear.sectors[homeOf(rear)].patrol && rear.sectors[homeOf(rear)].patrol.strength}`,
);

// A yard rebuilds losses and fields a second patrol — both halves of what the
// design says 2,400 salvage buys.
const yarded = newCampaign(106);
creditSalvage(yarded, 5000);
yarded.sectors[homeOf(yarded)].structures.push({ kind: "yard", runsRemaining: 0 });
check("a yard raises the patrol ceiling", patrolCapacity(yarded) === 2, `capacity=${patrolCapacity(yarded)}`);
const yardPost = frontLineOf(yarded);
deployPatrol(yarded, yardPost);
check("...so a second patrol can be fielded", deployPatrol(yarded, homeOf(yarded)), "two in the field");
for (let i = 0; i < 6; i++) advance(yarded);
check(
  "a yard rebuilds a patrol the front grinds down",
  yarded.sectors[yardPost].patrol !== undefined && yarded.sectors[yardPost].patrol.strength === 1,
  `strength=${yarded.sectors[yardPost].patrol && yarded.sectors[yardPost].patrol.strength}`,
);

// ── taking ground ───────────────────────────────────────────────────────────
// The only thing that moves a sector back toward the player, and the same
// two-step ladder the enemy climbs.
const taking = newCampaign(107);
const enemySector = taking.sectors.findIndex((s) => s.control === "theirs");
check("clearing enemy ground contests it", gainGround(taking, enemySector) && taking.sectors[enemySector].control === "contested", "theirs → contested");
check("...and clearing it again takes it", gainGround(taking, enemySector) && taking.sectors[enemySector].control === "ours", "contested → ours");
check("...and ground already yours gains nothing", !gainGround(taking, enemySector), "no third step");
// The war is winnable. Without gainGround nothing in the game can produce this
// state, which is what the function exists for.
for (let i = 0; i < taking.sectors.length; i++) {
  while (gainGround(taking, i)) { /* push the front off the chart */ }
}
check("pushing every sector off the chart is a win", isWon(taking), "invasion broken");

// ── nothing can be made unwinnable by a chart decision ──────────────────────
const stranded = newCampaign(108);
for (const sector of stranded.sectors) sector.control = "theirs";
const front = DECISIONS.find((d) => d.kind === "front");
check(
  "the front is never refused, even holding nothing",
  stranded.sectors.every((_, i) => refusal(stranded, front, i) === null),
  "every sector is a legal drop",
);
decide(stranded, front, 63);
check("...and choosing it moves the drop", stranded.front === 63, `front=${stranded.front}`);

// ── salvage never goes negative through any spending path ───────────────────
// Hammered rather than sampled: every decision, at every sector, on a campaign
// that starts poor and is topped up with odd amounts, asserting the floor
// holds after each one. A path that overdrew by a single credit shows here.
const broke = newCampaign(109);
creditSalvage(broke, 700);
let floorHeld = true;
let refusalsSeen = 0;
for (let step = 0; step < 400; step++) {
  const decision = DECISIONS[step % DECISIONS.length];
  const sector = (step * 7) % broke.sectors.length;
  if (refusal(broke, decision, sector) !== null) refusalsSeen++;
  decide(broke, decision, sector);
  if (broke.salvage < 0) floorHeld = false;
  if (step % 37 === 0) creditSalvage(broke, 130);
}
check("salvage never goes negative through the new spending paths", floorHeld, `salvage=${broke.salvage}`);
// ...and the run above actually exercised refusal, rather than being 400 free
// decisions that could never have overdrawn anything.
check("...and that run was actually starved", refusalsSeen > 100, `${refusalsSeen} refusals in 400 attempts`);

// ── the between-runs tick ───────────────────────────────────────────────────
const ticking = newCampaign(110);
const cursorBefore = ticking.rngCursor;
const report = advance(ticking);
check("a run advances the war's clock", ticking.runsElapsed === 1, `runs=${ticking.runsElapsed}`);
check("...and the enemy takes its turn", report.actions.length > 0, `${report.actions.length} actions`);
// The subtle one, again: without the cursor a reload silently re-rolls the
// enemy's turn. `advanceCampaign` writes it so no caller can forget.
check("...and the RNG cursor is carried forward", ticking.rngCursor > cursorBefore, `${cursorBefore} → ${ticking.rngCursor}`);

// A campaign saved between runs and reloaded resumes the same war, rather than
// re-rolling it. This is the whole reason the cursor is persisted at all.
const saveStore = fakeStorage();
const played = newCampaign(111);
advance(played);
advance(played);
save(played, saveStore);
const reloaded = load(saveStore, 999);
const continuedA = advance(played);
const continuedB = advance(reloaded);
check(
  "a reloaded campaign resumes the same war rather than re-rolling it",
  JSON.stringify(continuedA) === JSON.stringify(continuedB) &&
    JSON.stringify(played.sectors) === JSON.stringify(reloaded.sectors),
  `${continuedA.actions.length} actions each`,
);

// ── the attract demo's firewall ─────────────────────────────────────────────
// The failure mode the design doc names outright: an attract demo quietly
// spending the player's salvage. Nothing crashes when this is wrong; the save
// just drifts while nobody is playing.
const mine = newCampaign(200);
const demo = newCampaign(201);

creditSalvage(campaignFor("attract", mine, demo), 5000);
creditSalvage(campaignFor("title", mine, demo), 5000);
// Both halves. Asserting only that the player's campaign is untouched would
// pass an implementation that credited nothing anywhere.
check(
  "banking during attract and title reaches the demo campaign only",
  mine.salvage === 0 && demo.salvage === 10000,
  `player=${mine.salvage}, demo=${demo.salvage}`,
);
creditSalvage(campaignFor("run", mine, demo), 400);
creditSalvage(campaignFor("command", mine, demo), 100);
check(
  "...while a run and the command view credit the player's",
  mine.salvage === 500 && demo.salvage === 10000,
  `player=${mine.salvage}, demo=${demo.salvage}`,
);

// And a whole demonstration — banking, building, a front moved, the enemy's
// turn — must leave the player's campaign byte-identical.
const untouched = JSON.stringify(mine);
const demoFront = frontLineOf(demo);
build(demo, demoFront, "starbase");
decide(demo, DECISIONS.find((d) => d.kind === "front"), demoFront);
deployPatrol(demo, demoFront);
for (let i = 0; i < 4; i++) advance(demo);
check(
  "a whole demonstration leaves the player's campaign byte-identical",
  JSON.stringify(mine) === untouched,
  `${demo.runsElapsed} demo runs, ${demo.sectors[demoFront].structures.length} demo structures`,
);

// ── a won or lost war reopens in place ──────────────────────────────────────
// Every holder — the session, the HUD, the probe — keeps one reference, so the
// object has to survive the restart even though nothing inside it does.
const reopened = newCampaign(300);
creditSalvage(reopened, 4000);
reopened.runsElapsed = 22;
reopened.refits.push("impulse-tuning");
const identity = reopened;
restartCampaign(reopened, 301);
check(
  "restarting a campaign reopens it in the same object",
  identity === reopened && reopened.salvage === 0 && reopened.runsElapsed === 0 &&
    reopened.refits.length === 0 && reopened.seed === 301,
  `seed=${reopened.seed}, salvage=${reopened.salvage}`,
);
check(
  "...with a starbase to launch from",
  reopened.sectors.filter((s) => hasStructure(s, "starbase")).length === 1 && !isLost(reopened),
  "somewhere to launch from",
);

// ── building is refused where it should be ──────────────────────────────────
const zoning = newCampaign(302);
creditSalvage(zoning, 5000);
const theirGround = zoning.sectors.findIndex((s) => s.control === "theirs");
check("you cannot build in enemy space", !build(zoning, theirGround, "outpost"), "refused");
check("...and it costs nothing to be refused", zoning.salvage === 5000, `salvage=${zoning.salvage}`);
const twice = frontLineOf(zoning);
build(zoning, twice, "outpost");
check("...nor build the same thing twice in one sector",
  !build(zoning, twice, "outpost") && zoning.salvage === 5000 - 600,
  `salvage=${zoning.salvage}`);
check("...and a half-built one still blocks a duplicate",
  hasAnyStructure(zoning.sectors[twice], "outpost") && !hasStructure(zoning.sectors[twice], "outpost"),
  `remaining=${zoning.sectors[twice].structures[0].runsRemaining}`);
check("every structure kind is priced",
  STRUCTURES.every((s) => structureSpec(s.kind) === s), "table is complete");

// ════════════════════════════════════════════════════════════════════════════
// Names. Derived from the seed, never stored — so the only thing worth
// asserting is that the derivation is stable, shared where it should be shared
// and distinct where it should be distinct.
// ════════════════════════════════════════════════════════════════════════════

const { REGION_BLOCK, sectorCode, regionOf, regionName, regionStem, stationName } =
  await import("../.campaign-build/chart/naming.js");

check("a sector code is a column letter and a row number",
  sectorCode(indexOf(0, 0)) === "A1" && sectorCode(indexOf(3, 3)) === "D4" &&
    sectorCode(indexOf(7, 7)) === "H8",
  `${sectorCode(indexOf(3, 3))}`);

// The same seed must produce the same map of names on every load, or a
// campaign's places rename themselves between sessions.
check("names are stable for a seed",
  regionName(7777, 19) === regionName(7777, 19) &&
    stationName(7777, 19) === stationName(7777, 19),
  `${regionName(7777, 19)} / ${stationName(7777, 19)}`);

// Different wars, different places. Asserted across the whole board rather
// than at one index, so a hash that happened to collide once cannot pass it.
const differing = Array.from({ length: SECTOR_COUNT }, (_, i) => i)
  .filter((i) => regionName(11, i) !== regionName(12, i)).length;
check("a different seed is a different map of names", differing > SECTOR_COUNT / 2,
  `${differing} of ${SECTOR_COUNT} sectors renamed`);

// A region is shared by a block, which is the entire reason regions exist:
// "the PELLAS REACH" has to mean a corner of the war rather than one square.
const block = [indexOf(0, 0), indexOf(1, 0), indexOf(2, 0), indexOf(0, 2), indexOf(2, 2)];
check("a region is shared across its block",
  block.every((i) => regionOf(i) === 0) &&
    block.every((i) => regionName(4242, i) === regionName(4242, block[0])),
  `${regionName(4242, block[0])}`);
check("the next block over is a different region",
  regionOf(indexOf(REGION_BLOCK, 0)) !== regionOf(indexOf(0, 0)),
  `region ${regionOf(indexOf(REGION_BLOCK, 0))}`);

// Regions and their stations share a stem, so a name says where it is.
check("a station borrows its region's stem",
  stationName(4242, block[0]).startsWith(regionStem(4242, block[0])) &&
    regionName(4242, block[0]).startsWith(regionStem(4242, block[0])),
  `${stationName(4242, block[0])} in the ${regionName(4242, block[0])}`);

// Two docks in one region have to be tellable apart, or naming has bought
// nothing over "STARBASE".
const designations = new Set(block.map((i) => stationName(4242, i)));
check("stations in one region are still distinct", designations.size === block.length,
  [...designations].join(" "));

// Every designation is two digits: a leading zero reads as a number, and this
// is meant to read as a name.
const codes = Array.from({ length: SECTOR_COUNT }, (_, i) => stationName(999, i).split(" ")[1]);
check("every station designation is two digits",
  codes.every((c) => /^[1-9][0-9]$/.test(c)), `${codes[0]} ... ${codes[63]}`);

// ════════════════════════════════════════════════════════════════════════════
// What a jump costs. A combat-balance change: distance now sets the charge.
// ════════════════════════════════════════════════════════════════════════════

const { JUMP, jumpSteps, jumpCharge, jumpEnergy, jumpReach } =
  await import("../.campaign-build/chart/jump.js");

check("a jump to where you are is no distance at all",
  jumpSteps(27, 27) === 0 && jumpCharge(27, 27) === 0, "0 steps");
check("adjacent sectors are one step",
  neighbours(27).every((n) => jumpSteps(27, n) === 1), "all four");
check("distance is orthogonal, not diagonal",
  jumpSteps(indexOf(0, 0), indexOf(1, 1)) === 2, `${jumpSteps(indexOf(0, 0), indexOf(1, 1))}`);
check("distance is symmetric",
  jumpSteps(indexOf(1, 6), indexOf(5, 2)) === jumpSteps(indexOf(5, 2), indexOf(1, 6)), "both ways");
check("opposite corners are the width and height of the board",
  jumpSteps(indexOf(0, 0), indexOf(GRID - 1, GRID - 1)) === (GRID - 1) * 2,
  `${jumpSteps(indexOf(0, 0), indexOf(GRID - 1, GRID - 1))} steps`);

// The escape valve stays reachable: one step is cheaper than the flat two
// seconds it replaces, or fleeing next door got worse rather than better.
check("a one-step hop charges the base and no more",
  jumpCharge(27, neighbours(27)[0]) === JUMP.baseCharge, `${JUMP.baseCharge}s`);

// The whole point of the change. A curve that is not monotonic in distance
// answers "is a long warp harder" with "sometimes", which is worse than the
// flat rate it replaced.
const home = indexOf(0, 0);
const charges = Array.from({ length: (GRID - 1) * 2 }, (_, i) =>
  jumpCharge(home, indexOf(Math.min(i + 1, GRID - 1), Math.max(0, i + 1 - (GRID - 1)))));
check("charge climbs with every extra sector crossed",
  charges.every((c, i) => i === 0 || c > charges[i - 1]),
  charges.map((c) => c.toFixed(2)).join(" "));

check("energy is the charge at the drain rate",
  Math.abs(jumpEnergy(home, indexOf(3, 0), 0.25) - jumpCharge(home, indexOf(3, 0)) * 0.25) < 1e-9,
  `${jumpEnergy(home, indexOf(3, 0), 0.25).toFixed(3)}`);

// Reach and charge have to be the same function read two ways, or the chart
// promises a jump the ship cannot finish.
const reach = jumpReach(1, 0.25);
check("a full reserve reaches what it can afford and no further",
  jumpEnergy(home, indexOf(reach, 0), 0.25) <= 1 &&
    jumpEnergy(home, indexOf(0, reach + 1), 0.25) > 1,
  `${reach} sectors on a full reserve`);
check("an empty reserve reaches nowhere", jumpReach(0, 0.25) === 0, "0 sectors");
check("crossing the whole board is out of reach on any reserve",
  jumpEnergy(indexOf(0, 0), indexOf(GRID - 1, GRID - 1), 0.25) > 1,
  `${jumpEnergy(indexOf(0, 0), indexOf(GRID - 1, GRID - 1), 0.25).toFixed(2)} of 1.00`);

// ════════════════════════════════════════════════════════════════════════════
// What Space would do, resolved before it is pressed. The command view taught
// exclusively by failure until this existed.
// ════════════════════════════════════════════════════════════════════════════

const { intent } = await import("../.campaign-build/chart/command.js");
const speaking = newCampaign(500);
const spokenHome = homeOf(speaking);
const outpost = DECISIONS.find((d) => d.id === "outpost");

// Every decision must state itself at every sector. A row that says nothing is
// a row that can only be understood by pressing it, which is the bug.
const silent = [];
for (const decision of DECISIONS) {
  for (const sector of [spokenHome, 0, 63]) {
    const said = intent(speaking, decision, sector);
    if (!said.line || said.line.length < 6) silent.push(`${decision.id}@${sector}`);
  }
}
check("every decision says what it would do, at every sector", silent.length === 0,
  silent.join(" ") || "12 decisions, 3 sectors");

// Naming the target is the entire mental model of the screen: Space applies
// the decision cursor to the sector cursor.
check("...and names the sector it would do it to",
  intent(speaking, outpost, spokenHome).line.includes(sectorCode(spokenHome)),
  intent(speaking, outpost, spokenHome).line);

// The reason has to be available before the key is pressed, not after.
check("an unaffordable decision is refused up front, with a reason",
  speaking.salvage === 0 && intent(speaking, outpost, spokenHome).refused !== null &&
    intent(speaking, outpost, spokenHome).refused.includes("600"),
  intent(speaking, outpost, spokenHome).refused);

creditSalvage(speaking, 5000);
check("...and stops being refused once it can be paid for",
  intent(speaking, outpost, spokenHome).refused === null,
  `salvage=${speaking.salvage}`);

// The intent and the act must agree, or the screen promises one thing and does
// another. Checked by taking the decision the intent said was available.
const before = speaking.salvage;
decide(speaking, outpost, spokenHome);
check("what it said it would do is what taking it does",
  hasAnyStructure(speaking.sectors[spokenHome], "outpost") && speaking.salvage === before - 600,
  `salvage=${speaking.salvage}`);

// Stripping a fitted refit refunds nothing, so quoting its price beside STRIP
// would read as a refund.
const stripping = DECISIONS.find((d) => d.id === "impulse-tuning");
toggleRefit(speaking, "impulse-tuning");
const strip = intent(speaking, stripping, spokenHome);
check("stripping a fitted refit is quoted free and refused by nothing",
  strip.cost === 0 && strip.refused === null && strip.line.startsWith("STRIP"), strip.line);

// The front is never refused anywhere. It is the guarantee that no chart
// decision can leave a player with nowhere to fly.
const dropping = DECISIONS.find((d) => d.kind === "front");
check("the drop point is offered at every sector, held or not",
  speaking.sectors.every((_, i) => intent(speaking, dropping, i).refused === null),
  "64 sectors");

// ── the eras are tradeoffs, not tiers ───────────────────────────────────────
const { ERAS, eraSpec, DEFAULT_ERA, traitsOf } = await import("../.campaign-build/chart/eras.js");

check("four eras exist and are described",
  ERAS.length === 4 && ERAS.every((e) => e.label && e.era && e.gain && e.price),
  ERAS.map((e) => e.label).join(", "));

// The baseline has to be genuinely unmodified, not a table of 1.0s that could
// drift: it is the ship every other number in the game was tuned against.
check("the baseline hull is unmodified",
  DEFAULT_ERA === "constitution" && Object.keys(eraSpec("constitution").mods).length === 0,
  `${DEFAULT_ERA} mods=${JSON.stringify(eraSpec("constitution").mods)}`);

// The same rule the refits are held to, for the same reason, and asserted the
// same mechanical way: a hull is picked once and flown for a whole war, so an
// era that was strictly better would not be a choice, it would be the answer.
// A fifth era added later is exactly when this stops being true quietly.
const worseHull = ERAS.filter((spec) => {
  if (spec.id === DEFAULT_ERA) return true;
  const fit = loadoutOf([], spec.id);
  return (
    fit.shieldCapacity < 1 || fit.energyReserve < 1 || fit.reserveRegen < 1 ||
    fit.turnRate < 1 || fit.acceleration < 1 || fit.phaserCost > 1 ||
    fit.hullRadius > 1 || fit.hullArmour > 1
  );
});
check("every era costs the ship something", worseHull.length === ERAS.length,
  `${worseHull.length} of ${ERAS.length}`);

// And each one has to actually *give* something, or it is a handicap.
const betterHull = ERAS.filter((spec) => {
  if (spec.id === DEFAULT_ERA) return true;
  const fit = loadoutOf([], spec.id);
  return (
    fit.shieldCapacity > 1 || fit.energyReserve > 1 || fit.turnRate > 1 ||
    fit.acceleration > 1 || fit.phaserCost < 1 || fit.hullRadius < 1 || fit.hullArmour < 1
  );
});
check("every era gives the ship something", betterHull.length === ERAS.length,
  `${betterHull.length} of ${ERAS.length}`);

check("the era reaches the loadout",
  loadoutOf([], "galaxy").energyReserve === 1.4 && loadoutOf([], "defiant").hullRadius === 0.82,
  `galaxy reserve=${loadoutOf([], "galaxy").energyReserve} defiant radius=${loadoutOf([], "defiant").hullRadius}`);

// Hull first, refits on top, and they compose rather than one winning.
check("era and refits multiply together",
  Math.abs(loadoutOf(["capacitor-bank"], "galaxy").energyReserve - 1.4 * 1.25) < 1e-9,
  `${loadoutOf(["capacitor-bank"], "galaxy").energyReserve}`);

// An unknown or absent era must not throw and must not silently modify the ship.
// The spec sheet the title draws. Derived from `mods` rather than written out,
// so the panel cannot contradict the flight model — and asserted here because the
// one thing that *could* silently invert is the polarity: three of these figures
// are costs when they rise, so the arithmetic sign and the colour disagree, and a
// panel that painted a 135% target profile as good news would be worse than no
// panel at all.
check("every era reports the same eight figures",
  ERAS.every((e) => traitsOf(e.id).length === 8),
  ERAS.map((e) => traitsOf(e.id).length).join(","));

check("the baseline reads as reference throughout",
  traitsOf("constitution").every((t) => t.percent === 100 && !t.favourable),
  traitsOf("constitution").map((t) => t.percent).join(","));

const trait = (era, label) => traitsOf(era).find((t) => t.label === label);
check("a bigger target reads as a cost",
  trait("galaxy", "TARGET PROFILE").percent === 135 && !trait("galaxy", "TARGET PROFILE").favourable,
  `${trait("galaxy", "TARGET PROFILE").percent}% favourable=${trait("galaxy", "TARGET PROFILE").favourable}`);

check("a cheaper beam and a tougher skin read as gains",
  trait("defiant", "BEAM DRAW").favourable && trait("nx", "DAMAGE TAKEN").favourable,
  `beam ${trait("defiant", "BEAM DRAW").percent}%  damage ${trait("nx", "DAMAGE TAKEN").percent}%`);

check("an unrecorded era flies the baseline",
  loadoutOf([]).energyReserve === 1 && eraSpec(undefined).id === "constitution",
  "undefined -> constitution");

console.log(problems.length ? `\nPROBLEMS:\n${problems.join("\n")}` : "\nno problems");
process.exit(problems.length ? 1 : 0);
