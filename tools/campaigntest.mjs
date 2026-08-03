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
check("empty space is not", !canDock(c.sectors[c.front === 0 ? 1 : 0]) || c.front === 0, "bare sector");

// ── salvage ─────────────────────────────────────────────────────────────────
creditSalvage(c, 500);
check("salvage credits", c.salvage === 500, `salvage=${c.salvage}`);
check("affordable spending succeeds", spendSalvage(c, 200) === true, `salvage=${c.salvage}`);
check("...and debits", c.salvage === 300, `salvage=${c.salvage}`);
check("unaffordable spending is refused", spendSalvage(c, 9999) === false, "refused");
check("...and changes nothing", c.salvage === 300, `salvage=${c.salvage}`);
creditSalvage(c, -50);
check("salvage never goes negative", c.salvage >= 0, `salvage=${c.salvage}`);

// ── win and loss ────────────────────────────────────────────────────────────
check("a fresh campaign is neither won nor lost", !isWon(c) && !isLost(c), "in progress");

const cleared = newCampaign(1);
for (const s of cleared.sectors) if (s.control === "theirs") s.control = "ours";
check("no enemy sectors is a win", isWon(cleared), "front pushed off");

const doomed = newCampaign(2);
for (const s of doomed.sectors) s.structures = s.structures.filter((x) => x.kind !== "starbase");
check("no starbase is a loss", isLost(doomed), "last starbase fell");

console.log(problems.length ? `\nPROBLEMS:\n${problems.join("\n")}` : "\nno problems");
process.exit(problems.length ? 1 : 0);
