/**
 * Drives a run headlessly and asserts the combat rules actually fire.
 * Screenshots each interesting state on the way through.
 *
 *   node tools/playtest.mjs [outputDir]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

import { existsSync } from "node:fs";

/**
 * This container ships a Chromium that Playwright's own version lookup does not
 * match, so it has to be pointed at explicitly. Anywhere else — a laptop with
 * `npx playwright install chromium` — Playwright resolves its own, and forcing a
 * path that does not exist would just fail.
 */
function launchOptions() {
  const pinned = process.env.PLAYWRIGHT_CHROMIUM ?? "/opt/pw-browsers/chromium";
  return {
    ...(existsSync(pinned) ? { executablePath: pinned } : {}),
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-gl=angle"],
  };
}

const OUT = process.argv[2] ?? "shots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch(launchOptions());
// SwiftShader runs ~15 full-screen post passes at maybe 30 Mpix/s, so a
// 1280x800 frame costs it half a second and the game's dt clamp puts logic
// into slow motion. Assertions therefore run small and unadorned; the beauty
// shots at the end turn everything back on.
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });

const problems = [];
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("404")) problems.push(`[console] ${m.text()}`);
});

const probe = () => page.evaluate(() => window.__probe);
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) problems.push(`assertion failed: ${label} (${detail})`);
};

/**
 * Poll until the game reaches a state rather than sleeping a fixed span. How
 * much simulated time a wall-clock second buys depends on the host's GL — a
 * fast laptop and a SwiftShader container differ by 2x or more — so fixed
 * sleeps make every downstream assertion a coin flip. On timeout this returns
 * the last state seen and lets the caller's check() report the real failure.
 */
const waitFor = async (predicate, timeout = 25000) => {
  const deadline = Date.now() + timeout;
  let state = await probe();
  while (!predicate(state) && Date.now() < deadline) {
    await page.waitForTimeout(100);
    state = await probe();
  }
  return state;
};

// 5173 is only the default, and overridable because several checkouts of this
// repo can be running dev servers at once — a worktree cannot have the default
// port, since the checkout it was branched from is usually still holding it. A
// harness pointed at somebody else's server silently reports on somebody else's
// build, which is a confusing way to lose an hour.
await page.goto(process.env.PLAYTEST_URL ?? "http://127.0.0.1:5173/", { waitUntil: "networkidle" });
await page.evaluate(() => {
  window.__stage.bloom.enabled = false;
  window.__stage.phosphor.enabled = false;
  window.__stage.crt.enabled = false;
});

// ── the comet's tail-volume test ────────────────────────────────────────────
// `interferenceAt` is a pure function with no game state behind it, so it is
// asserted here, before a run even exists, rather than waiting for the
// renderer and session wiring the later comet tasks add.
const vol = await page.evaluate(() => {
  const { interferenceAt } = window.__comet;
  const plan = {
    nucleus: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: 1 },
    length: 400, nearRadius: 20, farRadius: 90, nucleusRadius: 8,
  };
  return {
    onAxis: interferenceAt(plan, 0, 200),
    sunward: interferenceAt(plan, 0, -200),
    beyond: interferenceAt(plan, 0, 600),
    outside: interferenceAt(plan, 400, 200),
    edge: interferenceAt(plan, 54, 200),
    none: interferenceAt(null, 0, 200),
  };
});
check("the tail jams on its axis", vol.onAxis > 0.5, `v=${vol.onAxis}`);
check("...and not sunward of the nucleus", vol.sunward === 0, `v=${vol.sunward}`);
check("...and not past its end", vol.beyond === 0, `v=${vol.beyond}`);
check("...and not off to the side", vol.outside === 0, `v=${vol.outside}`);
check("...and fades toward the edge", vol.edge > 0 && vol.edge < vol.onAxis, `edge=${vol.edge} axis=${vol.onAxis}`);
check("no comet, no interference", vol.none === 0, `v=${vol.none}`);

// ── the fixture is seeded ───────────────────────────────────────────────────
// Also pure, and checked here for the same reason: `planFixture(seed, sector,
// null)` is deterministic in `seed` and `sector` alone. `COMET.fixtureChance`
// is 0.25, so a single hardcoded sector would read as flaky roughly three
// times in four — this scans forward from a fixed seed for the first sector
// that actually rolls a fixture instead, which stays honest even if the
// chance itself is retuned later.
const fixtureSeeded = await page.evaluate(() => {
  const { plan } = window.__comet;
  const seed = 4242;
  let sector = -1;
  let a = null;
  for (let s = 0; s < 64 && a === null; s++) {
    const candidate = plan(seed, s);
    if (candidate) {
      sector = s;
      a = candidate;
    }
  }
  if (a === null) return { found: false };
  const b = plan(seed, sector);
  const repeats =
    a.nucleus.x === b.nucleus.x &&
    a.nucleus.z === b.nucleus.z &&
    a.direction.x === b.direction.x &&
    a.direction.z === b.direction.z;
  // A neighbouring sector under the same seed: not guaranteed a fixture of its
  // own, so any detectable difference — null, or a different nucleus — proves
  // the point equally well. Nothing requires two different squares to agree
  // with each other, only that each one agrees with itself.
  const otherSector = (sector + 1) % 64;
  const c = plan(seed, otherSector);
  const differs = c === null || c.nucleus.x !== a.nucleus.x || c.nucleus.z !== a.nucleus.z;
  return { found: true, sector, otherSector, repeats, differs };
});
check(
  "planFixture repeats for the same seed and sector",
  fixtureSeeded.found && fixtureSeeded.repeats,
  JSON.stringify(fixtureSeeded),
);
check(
  "...and differs for a different sector",
  fixtureSeeded.found && fixtureSeeded.differs,
  JSON.stringify(fixtureSeeded),
);

// ── the deck log ────────────────────────────────────────────────────────────
// `L` is a display key, so it must reach the switch without launching anything
// — the same contract `Y` has. Checked before the first run, which is also the
// only moment the title screen is up.
await page.keyboard.press("l");
let state = await waitFor((s) => s.deckLog === false, 3000);
check(
  "L toggles the log without launching a run",
  state.deckLog === false && state.mode === "title",
  `deckLog=${state.deckLog} mode=${state.mode}`,
);
await page.keyboard.press("l");
state = await waitFor((s) => s.deckLog === true, 3000);
check("...and back on again", state.deckLog === true, `deckLog=${state.deckLog}`);

// A fresh load lands on the title screen with nothing spawning behind it, and
// left alone it drops into the attract demo, which then fights the harness for
// the keyboard. Launch a real run through the same door a player uses.
//
// The pacing assertion is the reason this block exists in the shape it does.
// The log shipped starting its whole crawl *below* the readable band: it was
// `briefing === true` from the first frame while the screen showed nothing but
// a prompt telling the player to press a key, and the first words did not
// arrive for four seconds. An assertion on `briefing` alone passed that
// happily. So this one waits for words — `briefingLines` is what a player
// could actually read this instant — and it waits against a clock.
const LEGIBLE_BUDGET = 1200;
const launchedAt = Date.now();
await page.keyboard.press("Enter");
let legibleAfter = Infinity;
while (Date.now() - launchedAt < 8000) {
  state = await probe();
  if (state.briefingLines?.length) {
    legibleAfter = Date.now() - launchedAt;
    break;
  }
  await page.waitForTimeout(50);
}
check(
  "the log is legible within a moment of launching",
  legibleAfter <= LEGIBLE_BUDGET,
  `first readable line after ${legibleAfter}ms, budget ${LEGIBLE_BUDGET}ms`,
);
check(
  "...and the first thing readable is the top of the log",
  (state.briefingLines?.[0] ?? "").startsWith("DECK LOG"),
  `lines=${JSON.stringify(state.briefingLines)}`,
);

// Both pacing shots, timed off the launch rather than off each other, so they
// can be eyeballed side by side. Small and unadorned like everything else in
// this half of the file — this is about where the words are, not how they glow.
await page.waitForTimeout(Math.max(0, launchedAt + 500 - Date.now()));
await page.screenshot({ path: `${OUT}/log-0.5s.png` });
await page.waitForTimeout(Math.max(0, launchedAt + 2000 - Date.now()));
await page.screenshot({ path: `${OUT}/log-2s.png` });
await page.screenshot({ path: `${OUT}/briefing.png` });
// And once more after the skip hint has been offered, which is the other half
// of what went wrong: the prompt used to be the first thing on the screen and
// the only thing on it.
await page.waitForTimeout(Math.max(0, launchedAt + 3200 - Date.now()));
await page.screenshot({ path: `${OUT}/log-hint.png` });

// Everything it says is read off the board, which is the only reason a player
// should believe any of it. Two numbers are checkable without leaving the page:
// what the sector it drops into is worth, and how much ground the enemy still
// holds.
const truth = await page.evaluate(() => {
  const campaign = window.__campaign;
  const sector = campaign.sectors[campaign.current];
  return {
    lines: window.__presentation.briefing.lines.map((l) => l.text).filter(Boolean),
    threat: `THREAT ${sector.threat}   PAYS X${1 + sector.yield}`,
    theirs: campaign.sectors.filter((s) => s.control === "theirs").length,
  };
});
check(
  "the log reports the sector the run actually drops into",
  truth.lines.includes(truth.threat),
  `wanted "${truth.threat}", got ${JSON.stringify(truth.lines)}`,
);
check(
  "...and counts the ground they really hold",
  truth.lines.includes(`THEY HOLD ${truth.theirs} SECTORS`),
  `wanted "THEY HOLD ${truth.theirs} SECTORS", got ${JSON.stringify(truth.lines)}`,
);

// The first run of a war teaches; every run briefs. A fresh browser context
// has an empty localStorage, so this campaign is a new war and the rules are
// part of this one.
check(
  "the first log of a war states the rules",
  truth.lines.includes("CLEAR A SECTOR TO TAKE IT"),
  JSON.stringify(truth.lines),
);

// And any key ends it on the frame it arrives. Everything below this line
// depends on that: the log holds the session, so a wave would never spawn.
await page.keyboard.press("Enter");
state = await waitFor((s) => !s.briefing, 3000);
check("any key skips the log", state.briefing === false, `briefing=${state.briefing}`);

// ── and the same log in front of the next run ───────────────────────────────
// The gate this replaced ran the log only on the first run of a new war, which
// is why the owner of this repo never saw it. Every run gets one now — R is a
// new run — and the second one drops the four onboarding sentences and keeps
// the situation.
await page.keyboard.press("r");
state = await waitFor((s) => s.briefing, 5000);
check("a second run opens with a log too", state.briefing === true, `briefing=${state.briefing}`);

const second = await page.evaluate(() =>
  window.__presentation.briefing.lines.map((l) => l.text).filter(Boolean),
);
check(
  "the second log still briefs the sector",
  second.some((line) => line.startsWith("COMMAND PUTS US AT")),
  JSON.stringify(second),
);
check(
  "...and does not teach the rules again",
  !second.includes("CLEAR A SECTOR TO TAKE IT") && !second.includes("WE GO ANYWAY"),
  JSON.stringify(second),
);

// Abortable from the very first frame, not merely once it is under way: the
// key goes in immediately after the one that opened it.
await page.keyboard.press("Enter");
state = await waitFor((s) => !s.briefing, 3000);
check("the log can be skipped immediately", state.briefing === false, `briefing=${state.briefing}`);

// ── the switch actually suppresses it ───────────────────────────────────────
// Off, and the next run goes straight to flying. This is left off for the rest
// of the file deliberately: everything below restarts runs to set up combat,
// and a briefing in front of each one is a seven-second hold on every setup.
await page.keyboard.press("l");
state = await waitFor((s) => s.deckLog === false, 3000);
check("L switches the log off", state.deckLog === false, `deckLog=${state.deckLog}`);

await page.keyboard.press("r");
state = await waitFor((s) => s.mode === "run" && s.wave >= 1 && s.hostiles > 0, 20000);
check(
  "with the log off a run starts flying at once",
  state.briefing === false && state.hostiles > 0,
  `briefing=${state.briefing} hostiles=${state.hostiles}`,
);

// ── wave one arrives ────────────────────────────────────────────────────────
state = await waitFor((s) => s.wave >= 1 && s.hostiles > 0);
check("wave spawns", state.wave >= 1 && state.hostiles > 0, JSON.stringify(state));

// ── shoot something ─────────────────────────────────────────────────────────
// Park a hostile dead ahead at close range rather than sweeping and hoping:
// whether a blind sweep finds a target is luck, and a flaky check is worse
// than no check.
await page.evaluate(() => {
  const p = window.__player, f = window.__fleet;
  p.heading = 0;
  p.velocity.set(0, 0, 0);
  for (const h of f.hostiles) {
    h.position.set(p.position.x, 0, p.position.z + 18);
    h.velocity.set(0, 0, 0);
  }
});
await page.keyboard.down(" ");
state = await waitFor((s) => s.energy < 1 && s.pending > 0 && s.multiplier > 1);
await page.screenshot({ path: `${OUT}/combat.png` });
await page.keyboard.up(" ");
await page.waitForTimeout(300);

check("phaser draws energy", state.energy < 1, `energy=${state.energy}`);
check("kills bank salvage", state.pending > 0, `pending=${state.pending}`);
check("multiplier climbs", state.multiplier > 1, `x${state.multiplier}`);

// ── torpedoes ───────────────────────────────────────────────────────────────
const before = (await probe()).torpedoes;
await page.keyboard.press("x");
state = await waitFor((s) => s.torpedoes === before - 1, 5000);
check("torpedo consumes ammunition", state.torpedoes === before - 1, `${before} → ${state.torpedoes}`);

// ── debris ──────────────────────────────────────────────────────────────────
// Kill something outright and confirm the hull comes apart into strokes.
await page.evaluate(() => {
  const fleet = window.__fleet;
  if (fleet.hostiles.length) {
    const victim = fleet.hostiles[0];
    victim.position.set(window.__player.position.x + 18, 0, window.__player.position.z + 4);
  }
});
await page.evaluate(() => {
  const s = window.__session, f = window.__fleet;
  if (f.hostiles.length) s.destroy?.call?.(s, f.hostiles[0], window.__player);
});
state = await waitFor((s) => s.debris > 0, 5000);
check("explosion produces debris", state.debris > 0, `shards=${state.debris}`);
await page.screenshot({ path: `${OUT}/debris.png` });

// ── hit-stop ────────────────────────────────────────────────────────────────
// Read the dilation synchronously rather than polling for it: the window is
// at most HIT_STOP.max real seconds, and racing a 200ms window over an
// evaluate round-trip is exactly the kind of flake this file avoids.
const dilated = await page.evaluate(() => {
  const s = window.__session;
  s.hitStop.strike(0.2);
  return s.timeScale;
});
check("hit-stop dilates time", dilated < 1 && dilated > 0, `timeScale=${dilated}`);

// The property that actually matters. Hit-stop that never releases is
// indistinguishable from the clamped-dt slow motion documented in status.md
// §4, so over-drive it well past its cap and prove it still lets go.
await page.evaluate(() => window.__session.hitStop.strike(10));
state = await waitFor((s) => s.timeScale === 1, 3000);
check("hit-stop always lets go", state.timeScale === 1, `timeScale=${state.timeScale} after a 10s strike`);

// ── altitude ────────────────────────────────────────────────────────────────
// The slab. Every assertion here is written so it would fail outright if the
// feature were absent: with the old planar game, `altitude` is pinned to zero
// by construction and `hostileAltitude` never leaves it either.
//
// Pinned for the block. Holding a key for two seconds next to a live wave is
// about the flight model, not about whether the harness can survive combat.
await page.evaluate(() => {
  window.__altPin = setInterval(() => { window.__player.hull = 1; }, 80);
});
state = await waitFor((s) => s.hostiles > 0, 20000);

// A known reserve and full facings, so the only thing that can move the number
// is the climb itself: thrust is not held, nothing is being fired, and passive
// regeneration (+0.012/s) would otherwise push it *up*. That is the property
// that makes this check honest — without the drain, energy strictly rises.
await page.evaluate(() => {
  const p = window.__player;
  p.energy = 0.9;
  for (const facing of ["fore", "starboard", "aft", "port"]) p.shields[facing] = 1;
});

await page.keyboard.down("q");
state = await waitFor((s) => s.altitude > 3, 8000);
check("holding the climb key gains altitude", state.altitude > 3, `alt=${state.altitude}`);
check("...and the reserve pays for it", state.energy < 0.9, `energy=${state.energy}`);

// The ceiling is a ceiling. Held long enough, it stops rather than keeps going.
state = await waitFor((s) => s.altitude >= s.ceiling - 0.01, 8000);
check(
  "the climb stops at the ceiling",
  state.altitude <= state.ceiling + 0.01 && state.altitude > state.ceiling - 0.5,
  `alt=${state.altitude} ceiling=${state.ceiling}`,
);
await page.screenshot({ path: `${OUT}/altitude.png` });

// Descent is not an input. Letting go is the whole of it — and this is checked
// with the key released *promptly*, before the drain can starve the reserve:
// a starved ship sinks on its own, and a check taken after that would pass
// whether or not releasing does anything.
await page.keyboard.up("q");
state = await waitFor((s) => s.altitude < 0.05, 8000);
check("releasing returns the ship to the floor", state.altitude < 0.05, `alt=${state.altitude}`);

// Hostiles use the slab too — one the player alone could reach would make
// altitude a pure escape and probably strictly dominant. They wander on their
// own slow clocks, so this is the one check here that waits rather than acts.
state = await waitFor((s) => s.hostileAltitude > 1, 25000);
check("hostiles leave the floor as well", state.hostileAltitude > 1, `highest=${state.hostileAltitude}`);

// ── and with the slab switched off, the old game ────────────────────────────
// Y is in DISPLAY_KEYS, so it must flip the setting rather than launching or
// interrupting anything — and with it off, holding the climb key must do
// nothing at all, to the player *and* to the fleet.
await page.keyboard.press("y");
state = await waitFor((s) => s.flight3d === false, 3000);
check("Y switches the slab off", state.flight3d === false, `flight3d=${state.flight3d}`);

await page.keyboard.down("q");
await page.waitForTimeout(1500);
state = await probe();
await page.keyboard.up("q");
check("with the slab off the ship cannot leave the plane", state.altitude === 0, `alt=${state.altitude}`);
// `hostileAltitude` is a max over an empty list when nothing is alive, so the
// hostile count is asserted alongside it — otherwise an empty sector would
// satisfy this without the pin ever being exercised.
check(
  "...and neither can anything else",
  state.hostiles > 0 && state.hostileAltitude === 0,
  `hostiles=${state.hostiles} highest=${state.hostileAltitude}`,
);

// Back on for everything below, and for the beauty shots.
await page.keyboard.press("y");
state = await waitFor((s) => s.flight3d === true, 3000);
check("Y switches it back on", state.flight3d === true, `flight3d=${state.flight3d}`);

// ── HQ, mid-wave ────────────────────────────────────────────────────────────
// The property that matters is *when*: a dispatch has to arrive with hostiles
// alive, not in the gap between waves, because landing in the gap is what made
// the first version scenery. So this asserts the gate directly rather than
// waiting out the real interval.
//
// Driven by winding the private clock down rather than by sleeping through
// `DISPATCH.first` — the escalation gate would need wave 3+ as well, and a
// harness that waits out both is testing the constants instead of the seam.
const hq = await page.evaluate(async () => {
  const s = window.__session;
  const d = s.dispatches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Silent between waves, however ready the clock is. `next` is wound to zero
  // and the roll forced to always pass, so the only thing that can hold HQ back
  // here is the gate itself.
  window.__fleet.clear();
  await wait(200);
  d.reset();
  d.next = 0;
  const between = { line: d.line, hostiles: window.__fleet.hostiles.length };

  // And speaks once a wave is up. The wave arrives on its own after the break.
  s.wave = 6;
  for (let i = 0; i < 120 && !d.line; i++) {
    d.next = 0;
    await wait(50);
  }
  return {
    between,
    line: d.line,
    timer: d.timer,
    hostiles: window.__fleet.hostiles.length,
  };
});
check(
  "HQ stays quiet between waves even with the clock run out",
  hq.between.line === null && hq.between.hostiles === 0,
  JSON.stringify(hq.between),
);
check(
  "...and cuts in during one",
  typeof hq.line === "string" && hq.line.startsWith("HQ:") && hq.hostiles > 0,
  `line=${hq.line} hostiles=${hq.hostiles}`,
);
// Its own row, its own clock: the message line is free to carry something else
// at the same time, which is the change that let this land mid-fight at all.
check(
  "...on its own clock rather than the message row's",
  hq.timer > 0,
  `timer=${hq.timer}`,
);
await page.screenshot({ path: `${OUT}/dispatch.png` });

// ── the brace: strip and stack ──────────────────────────────────────────────
// Z taps rather than holds, costs no energy, and overcharges the bow past full.
// All three of those are the decision (see `BRACE` in `Ship.ts`), and the one
// that a keyboard cannot tell you about is the third: a gauge that clamps at 1
// would show a working brace and a broken one identically.
//
// Set up with a known board — a half-empty bow and full quarters behind it — so
// every figure below is arithmetic rather than a snapshot of a firefight. The
// fleet is cleared for the same reason and it is not optional: the leak check
// below watches one facing for a second and a half, and a single hostile bolt
// landing on the bow in that window would move it further than the leak does and
// fail a working brace. `WAVE_BREAK` gives ~2.6s before a replacement spawns,
// which is more than this block needs.
await page.evaluate(() => {
  const p = window.__player;
  window.__fleet.clear();
  p.energy = 0.6;
  p.shields.fore = 0.5;
  p.shields.starboard = 1;
  p.shields.aft = 1;
  p.shields.port = 1;
});
await page.keyboard.press("z");
await page.waitForTimeout(120);
let brace = await page.evaluate(() => {
  const p = window.__player;
  return { ...p.shields, energy: p.energy };
});
// 0.5 + 3.0 * 0.7 = 2.6, clamped to the 2.5 ceiling. Asserted as a band because
// the leak has had a frame or two to start pulling it back down.
check(
  "Z stacks the after facings into the bow, past full",
  brace.fore > 2.3 && brace.fore <= 2.5,
  `fore=${brace.fore}`,
);
// Near zero rather than zero, and the difference is passive shield regen: it
// tops up the thinnest facing below full, so by the time the harness can read
// the board a frame later the donors have a sliver back. Asserting `=== 0` here
// failed on 0.0013 of starboard, which is the game working.
check(
  "...and strips the three that paid for it",
  brace.starboard < 0.05 && brace.aft < 0.05 && brace.port < 0.05,
  JSON.stringify(brace),
);
// The load-bearing one. A brace charged to the single pool would be a fifth
// claimant on it, and unaffordable exactly when it is wanted.
check("...and costs no energy", brace.energy >= 0.6, `energy=${brace.energy}`);
await page.screenshot({ path: `${OUT}/braced.png` });

// The surplus leaks, which is what keeps this a panic button and not a stance.
// At 0.16/s from ~2.5 a second and a half is a visible fall and nowhere near the
// floor of 1, so this distinguishes a decaying stack from both a frozen one and
// one that collapses outright.
//
// Measured from a reading taken *after* the screenshot, not from the one above.
// A screenshot costs about two seconds of wall clock and the game keeps running
// through it, so folding it into the window made a correct 0.16/s look like
// 0.385/s — the constant was right and the stopwatch was wrong.
// Cleared again for the same reason as above, and this second clear is what the
// screenshot makes necessary: two seconds is past `WAVE_BREAK`, so a replacement
// wave has already spawned and could put a bolt into the bow mid-window.
const braceStart = await page.evaluate(() => {
  window.__fleet.clear();
  return window.__player.shields.fore;
});
await page.waitForTimeout(1500);
const leaked = await page.evaluate(() => window.__player.shields.fore);
check(
  "the braced bow leaks its surplus back toward full",
  leaked < braceStart - 0.1 && leaked > 1,
  `fore=${braceStart} -> ${leaked} over ~1.5s`,
);

// Refuses rather than half-works: the donors are already empty, so there is
// nothing to move and the bow must not be touched.
await page.keyboard.press("z");
await page.waitForTimeout(120);
const again = await page.evaluate(() => window.__player.shields.fore);
check(
  "a second brace with nothing left to strip does not spend the bow",
  again <= leaked + 0.01,
  `fore=${leaked} -> ${again}`,
);

// Hand the docking section a light, fresh wave rather than whatever this block
// has been keeping alive under a hull pin — the same courtesy the hyperwarp
// section already extends to itself, and for the same reason: what follows is
// about the corridor, not about surviving wave nine.
await page.evaluate(() => {
  clearInterval(window.__altPin);
  delete window.__altPin;
  window.__session.wave = 1;
  window.__fleet.clear();
});

// ── docking ─────────────────────────────────────────────────────────────────
await page.evaluate(() => {
  const p = window.__player;
  // Sat just short of the ring, stationary, pointed at it.
  p.position.set(0, 0, 118 - 12);
  p.velocity.set(0, 0, 0);
  p.heading = 0;
  p.energy = 0.4;
  p.torpedoes = 3;
  p.shields.fore = 0.2;
});
// Cosmetic only — catches the approach mid-corridor. The assertions below do
// the real waiting; dock phase is not published on the probe.
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/docking.png` });
state = await waitFor((s) => s.score > 0 && s.torpedoes === 12 && s.energy > 0.9 && s.multiplier === 1);

check("docking banks the multiplier", state.score > 0, `score=${state.score}`);
check("docking resupplies", state.torpedoes === 12 && state.energy > 0.9, JSON.stringify({ t: state.torpedoes, e: state.energy }));
check("multiplier resets after banking", state.multiplier === 1, `x${state.multiplier}`);
await page.screenshot({ path: `${OUT}/docked.png` });

// ── death and restart ───────────────────────────────────────────────────────
// Leave the mooring first. Resupply lerps hull back toward 1 every frame, so
// zeroing it while docked is undone before the death check ever sees it.
// Departure is deliberate: it only happens under thrust.
await page.keyboard.down("ArrowUp");
await waitFor((s) => s.dock === "none", 15000);
await page.keyboard.up("ArrowUp");
await page.evaluate(() => { window.__player.hull = 0; });
state = await waitFor((s) => s.state === "dead", 8000);
check("hull loss ends the run", state.state === "dead", `state=${state.state}`);

// The player's own hull has to come apart the way every hostile's does —
// reusing the debris field is the whole point of the sequence.
check("death breaks the player up", state.debris > 0, `shards=${state.debris}`);
await page.screenshot({ path: `${OUT}/dead.png` });

// Phases, not timings. The sequence is measured in game seconds, which
// stretch badly under headless GL, so asserting it *arrives* is honest and
// asserting how long it took is not.
state = await waitFor((s) => s.death === "tally", 20000);
check("death reaches the tally", state.death === "tally", `phase=${state.death}`);

// ── the press that opens the chart is still a press ─────────────────────────
// The tally hands off to the command view on any key but R, and that handoff
// used to *consume* the key: a player who died and reached for D got the
// command view and a cursor that had not moved, and had to press it again.
// Worse, it looked like a cursor reset rather than a dropped key, because the
// mode change takes the cursor to campaign.current on its way in.
//
// So: press a direction once, and require both halves — the view opened AND
// the cursor sits one sector along from where this run's aftermath left it.
// The direction is computed rather than hardcoded because campaign.current can
// sit on either edge of the grid, and a step off the grid is clamped, which
// would make this assertion pass by doing nothing.
const firstStep = await page.evaluate(() => {
  const { indexOf, colOf, rowOf } = window.__chart;
  const current = window.__campaign.current;
  const col = colOf(current);
  const row = rowOf(current);
  // Away from whichever edge we are nearer, so the step is always in bounds.
  const key = col < 7 ? "d" : "a";
  const want = indexOf(col < 7 ? col + 1 : col - 1, row);
  // Aim the cursor somewhere else entirely first. The mode change is entitled
  // to pull it back to campaign.current — that is what stops a stale front
  // carrying into the next run — so the expected answer is one step from
  // current, not one step from here. Starting on top of current would let a
  // fix that only half works look right.
  window.__chartCursor.set(indexOf(col < 7 ? col : 0, row === 7 ? 0 : 7));
  return { key, want, current };
});

await page.keyboard.press(firstStep.key);
state = await waitFor((s) => s.mode === "command" && s.chartCursor === firstStep.want, 5000);
check(
  "the first key at the tally opens the command view",
  state.mode === "command",
  `mode=${state.mode}`,
);
check(
  "and that same key still steps the cursor",
  state.chartCursor === firstStep.want,
  `${firstStep.key} from sector ${firstStep.current}: cursor=${state.chartCursor}, wanted ${firstStep.want}`,
);

await page.keyboard.press("r");
state = await waitFor((s) => s.score === 0 && s.hull === 1 && s.wave >= 1);
check("restart begins a fresh run", state.score === 0 && state.hull === 1 && state.wave >= 1, JSON.stringify(state));

// ── the late classes ────────────────────────────────────────────────────────
// The Harrow enters at wave 4 and the Shroud at wave 6, so a run that never
// escalates never sees either. Skip ahead by setting the counter and emptying
// the field: updateWaves() spawns the next one as soon as it is clear.
// Waves 4 and 6 are lethal enough to end the run mid-assertion, so the hull is
// pinned for the duration — this is about whether the classes work, not about
// whether the harness can survive them.
await page.evaluate(() => {
  window.__pin = setInterval(() => { window.__player.hull = 1; }, 80);
});

await page.evaluate(() => { window.__session.wave = 3; window.__fleet.clear(); });
state = await waitFor((s) => s.wave >= 4 && s.mines > 0, 30000);
check("the harrow lays a minefield", state.mines > 0, `wave=${state.wave} mines=${state.mines}`);
await page.screenshot({ path: `${OUT}/minefield.png` });

await page.evaluate(() => { window.__session.wave = 5; window.__fleet.clear(); });
state = await waitFor((s) => s.wave >= 6 && s.cloaked > 0, 30000);
check("the shroud arrives cloaked", state.cloaked > 0, `wave=${state.wave} cloaked=${state.cloaked}`);
await page.screenshot({ path: `${OUT}/cloaked.png` });

// ── the comet: a Shroud caught in the tail loses its cloak ─────────────────
// Reuses the Shroud already established above (`state.cloaked > 0`) rather
// than spawning a fresh one. The comet is parked directly on top of it and
// re-parked there every tick — the hostile is still flying its own station,
// and "on the axis" has to hold for the whole measurement, not just the
// instant it was set up. `interferenceAt` treats the nucleus itself as
// full-strength (`t === 0` lands inside the coma test) regardless of the
// tail's own length or radius, so this is the shortest honest way to say "in
// the tail" without out-flying a moving target.
//
// `updateCloak` strips unconditionally once `interference > COMET.stripAt` —
// it does not care about distance, aim or the strike cycle's own phase — so
// nothing here needs to wait for a strike window; the only clock is `wind`
// (0.45s for the Shroud), and the poll loop lives inside one `evaluate` call
// for the same reason the HQ dispatch check above does: real seconds, not
// simulated ones, are what `dt`-scaled decay runs against.
const shroudTest = await page.evaluate(async () => {
  const target = window.__fleet.hostiles.find((h) => h.hidden);
  if (!target) return { found: false };

  const tmpl = window.__player.velocity;
  window.__session.comet.show({
    kind: "wanderer",
    nucleus: target.position.clone(),
    direction: tmpl.clone().set(0, 0, 1),
    length: 60,
    nearRadius: 15,
    farRadius: 15,
    nucleusRadius: 6,
    drift: tmpl.clone().set(0, 0, 0),
  });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let cloak = target.cloak;
  let hidden = target.hidden;
  for (let i = 0; i < 60 && cloak >= 0.05; i++) {
    const plan = window.__session.comet.plan;
    if (plan) plan.nucleus.copy(target.position);
    await wait(50);
    cloak = target.cloak;
    hidden = target.hidden;
  }
  window.__session.comet.show(null);
  return { found: true, cloak, hidden };
});
check("a Shroud is on the board to jam", shroudTest.found, JSON.stringify(shroudTest));
check(
  "a Shroud caught in the tail loses its cloak",
  shroudTest.found && shroudTest.cloak < 0.05,
  JSON.stringify(shroudTest),
);
check(
  "...and becomes hittable again",
  shroudTest.found && shroudTest.hidden === false,
  JSON.stringify(shroudTest),
);

// ── the comet: locks fail across the boundary ──────────────────────────────
// This time the player alone stands in the tail — the nucleus is parked on
// the ship, not on a hostile — and a non-cloaking hostile is placed well
// outside the tail's own cone (30 units off, against a 15-unit radius) but
// still inside its class's ordinary `fireRange`. `Session.stepComet` takes
// the max of the player's own reading and each hostile's own
// (`hostile.interference = Math.max(here, ...)`), so a hostile standing in
// open space still inherits a jammed lock the instant the player is inside —
// "either end standing in the tail is enough to blind a lock between them" is
// the rule under test, not merely "close to the tail suppresses fire".
//
// A hostile with `fireRange <= COMET.visualRange` (the Harrow, by design)
// would pass this check for the wrong reason, so the search is for a class
// whose range is well above both 30 (the test distance) and `visualRange`
// (22) — the swarmer's fireRange of exactly 30 is excluded too, since equal
// is not less-than and would make the "would have fired" half of this an
// assumption rather than a fact.
let lockTargetFound = false;
for (let attempt = 0; attempt < 8 && !lockTargetFound; attempt++) {
  lockTargetFound = await page.evaluate(() => {
    const h = window.__fleet.hostiles.find((x) => !x.spec.cloak && x.spec.fireRange > 32);
    if (h) window.__lockTarget = h;
    return !!h;
  });
  if (!lockTargetFound) {
    await page.evaluate(() => {
      window.__session.wave++;
      window.__fleet.clear();
    });
    await page.waitForTimeout(400);
  }
}
check("a hostile with real range is on the board", lockTargetFound, `found=${lockTargetFound}`);

// The same block also answers the third assertion — contacts degrade on the
// tube — by running the real `ScannerModel` class against the live player and
// fleet, imported straight from its own module rather than reimplemented.
// `contacts` in `hud/draw.ts` is a private instance the renderer owns, so a
// fresh one here is the honest way to exercise production code without
// touching a file under review elsewhere. Its sweep is simulated with fixed
// steps rather than real waits — `ScannerModel.update` has no wall-clock
// dependency, and 150 steps of 1/60s is 2.5s of arm rotation (a full sweep is
// ~1.5s at `SCANNER.sweepRate`), comfortably enough for the arm to cross the
// target's bearing at least once.
const lockTest = lockTargetFound
  ? await page.evaluate(async () => {
      const target = window.__lockTarget;
      const player = window.__player;
      player.velocity.set(0, 0, 0);

      // Every other hostile pushed well off the scanner and out of anyone's
      // fireRange, so only the hostile under test can possibly fire or ghost.
      for (const h of window.__fleet.hostiles) {
        if (h === target) continue;
        h.position.set(600, 0, 600);
        h.velocity.set(0, 0, 0);
      }

      const tmpl = player.velocity;
      window.__session.comet.show({
        kind: "wanderer",
        nucleus: player.position.clone(),
        direction: tmpl.clone().set(0, 0, 1),
        length: 60,
        nearRadius: 15,
        farRadius: 15,
        nucleusRadius: 6,
        drift: tmpl.clone().set(0, 0, 0),
      });

      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const boltsBefore = window.__session.ordnance.projectiles.filter((p) => p.kind === "bolt").length;

      // Parked, aimed and cooldown-zeroed every tick: if the interference
      // clamp were not real, this alone is enough to fire well inside the
      // class's own `fireInterval` within a 1.5s window.
      for (let i = 0; i < 30; i++) {
        target.position.set(player.position.x + 30, 0, player.position.z);
        target.velocity.set(0, 0, 0);
        target.heading = Math.atan2(
          player.position.x - target.position.x,
          player.position.z - target.position.z,
        );
        target.cooldown = 0;
        player.velocity.set(0, 0, 0);
        await wait(50);
      }

      const boltsAfter = window.__session.ordnance.projectiles.filter((p) => p.kind === "bolt").length;

      const { ScannerModel } = await import("/src/hud/scanner.ts");
      const scanner = new ScannerModel();
      for (let i = 0; i < 150 && scanner.ghosts.length === 0; i++) {
        scanner.update(1 / 60, player, window.__fleet);
      }

      window.__session.comet.show(null);
      window.__lockTarget = null;

      return {
        fireRange: target.spec.fireRange,
        interference: { player: player.interference, target: target.interference },
        boltsBefore,
        boltsAfter,
        ghosts: scanner.ghosts.length,
      };
    })
  : null;
check(
  "a hostile outside the tail cannot lock a player standing inside it",
  !!lockTest && lockTest.boltsAfter === lockTest.boltsBefore,
  JSON.stringify(lockTest),
);
check(
  "...and a non-cloaking contact still ghosts on the tube from the jamming alone",
  !!lockTest && lockTest.ghosts > 0,
  JSON.stringify(lockTest),
);

// ── the comet: the reserve pays for standing in the tail ───────────────────
// `window.__comet.seed()` drops a real wanderer — the same one a run gets —
// which drifts at ~4.7 units/s (`COMET.wandererEntry * 2 / COMET.wandererDuration`,
// there is no named constant for it). A tail moving that fast carries a fixed
// observation point out of itself within a couple of seconds, so the player
// is re-parked on the drifting nucleus every tick for the whole span — without
// that, this measurement reads as "no drain", which is a mistake already made
// once on this feature. Thrust released and full shields, the same setup the
// altitude block above uses, so the only thing left to move the reserve is
// the tail itself.
await page.evaluate(() => {
  window.__fleet.clear();
  const p = window.__player;
  p.velocity.set(0, 0, 0);
  p.energy = 0.9;
  for (const facing of ["fore", "starboard", "aft", "port"]) p.shields[facing] = 1;
  window.__session.seedComet(p);
  p.position.copy(window.__session.comet.plan.nucleus);
});
await page.evaluate(() => {
  window.__cometPin = setInterval(() => {
    const plan = window.__session.comet.plan;
    const p = window.__player;
    if (plan) p.position.copy(plan.nucleus);
    p.velocity.set(0, 0, 0);
  }, 80);
});
let cometBefore = (await probe()).energy;
await page.waitForTimeout(1500);
let cometAfter = (await probe()).energy;
check(
  "the reserve falls while parked in the tail",
  cometAfter < cometBefore - 0.01,
  `energy ${cometBefore} -> ${cometAfter} over ~1.5s`,
);
await page.evaluate(() => {
  clearInterval(window.__cometPin);
  delete window.__cometPin;
});

// And stops the instant the ship is not in it any more: same board, moved
// off the tail entirely and given a fresh reserve to fall from. Passive
// regen (see the altitude block's own comment on it) is what makes this
// honest — without a real drain to fight, energy strictly rises.
await page.evaluate(() => {
  const p = window.__player;
  p.position.set(p.position.x + 500, 0, p.position.z + 500);
  p.velocity.set(0, 0, 0);
  p.energy = 0.9;
  for (const facing of ["fore", "starboard", "aft", "port"]) p.shields[facing] = 1;
});
cometBefore = (await probe()).energy;
await page.waitForTimeout(1500);
cometAfter = (await probe()).energy;
check(
  "...and stops outside it",
  cometAfter > cometBefore,
  `energy ${cometBefore} -> ${cometAfter}`,
);

// ── the comet: the switch actually governs it ───────────────────────────────
// A full restart is the honest way to prove `encounters.comet` gates the
// pipeline rather than merely "no plan happens to be standing" — `showComet`
// is the one place that reads the switch, and it only ever runs at a restart
// or a hyperwarp arrival. `window.__loom.weave` is the same `encounters`
// singleton `Loom` is gated behind, re-exported under that name.
await page.evaluate(() => {
  window.__loom.weave.comet = false;
});
await page.evaluate(() => {
  window.__session.restart(window.__player);
});
// Read straight off the live objects rather than through `waitFor`/`__probe`:
// that snapshot is only rebuilt once per animation frame, and `restart()` runs
// via `evaluate`, outside that frame's timing — a poll can land on it before
// the next frame has rebuilt `__probe`, which reads as a wave still up from
// *before* the restart. `window.__fleet` and `window.__session` are always
// current, so polling them directly is what actually waits for the fresh wave
// this switch is being tested against.
let noComet = { plan: undefined, hostiles: [], player: undefined };
for (let i = 0; i < 100 && noComet.hostiles.length === 0; i++) {
  noComet = await page.evaluate(() => ({
    plan: window.__session.comet.plan,
    hostiles: window.__fleet.hostiles.map((h) => h.interference),
    player: window.__player.interference,
  }));
  if (noComet.hostiles.length === 0) await page.waitForTimeout(150);
}
check("the switch off leaves no comet standing", noComet.plan === null, JSON.stringify(noComet.plan));
check(
  "...and interference stays zero on every hostile",
  noComet.hostiles.length > 0 && noComet.hostiles.every((v) => v === 0),
  JSON.stringify(noComet.hostiles),
);
check("...and on the player too", noComet.player === 0, `interference=${noComet.player}`);
await page.evaluate(() => {
  window.__loom.weave.comet = true;
});

await page.evaluate(() => { clearInterval(window.__pin); delete window.__pin; });

// ── hyperwarp ───────────────────────────────────────────────────────────────
// Pinned for the whole charge-and-arrive sequence below purely so the ship
// survives the two-second charge next to a live wave: this does NOT guard the
// multiplier-halving assertion below. `Ship.takeHit` returns true — and
// `Session.resolveProjectiles` therefore calls `breach()`, which applies the
// identical Math.max(1, m * 0.5) halving that arrive() does — whenever
// throughput exceeds the *shield*, regardless of hull, so a stray hit during
// the charge can halve the multiplier on its own even with hull pinned to 1.
// The assertion below is written to be immune to that: it waits on
// `sector !== sectorBefore`, something only a completed jump can produce,
// rather than on the multiplier threshold itself.
await page.evaluate(() => {
  window.__pin = setInterval(() => { window.__player.hull = 1; }, 80);
  window.__session.wave = 1;
  window.__fleet.clear();
  window.__player.energy = 1;
});
state = await waitFor((s) => s.hostiles > 0, 20000);

// Build a multiplier worth losing, so halving it is observable.
await page.evaluate(() => { window.__session.multiplier = 4; });

// A jump to the sector you are already in is refused, so point somewhere
// else first — the same thing a player does with Tab and WASD. Driven
// through beginHyperwarp() indirectly, via the real Shift input below: the
// raw hyperwarp.begin() has no destination of its own, and going through it
// would arrive somewhere stale (see the comment on Session.hyperwarp).
await page.evaluate(() => {
  const { neighbours } = window.__chart;
  window.__chartCursor.set(neighbours(window.__campaign.current)[0]);
});

await page.keyboard.down("Shift");
state = await waitFor((s) => s.hyperwarp === "charging", 5000);
check("hyperwarp charges", state.hyperwarp === "charging", `phase=${state.hyperwarp}`);

// The charge is the commitment. Firing through it would make fleeing free,
// and the whole price the multiplier halving teaches collapses — this is the
// assertion that matters most in this file.
//
// Read with a synchronous dt=0 call into the real update() rather than
// holding a key and polling after a timeout. PHASER.cost and a torpedo round
// are one-shot deductions, but the charge's own drain is continuous, so a
// wall-clock window would confound "the phaser fired" with "the charge
// drained energy anyway" — exactly the kind of race this file's waitFor
// exists to avoid elsewhere. dt=0 walks the exact same handlePlayerFire()
// path a real frame would while freezing every dt-scaled effect, the charge
// drain included, so only a discrete fire would move either number.
//
// All three steps in one evaluate, deliberately: split across three round
// trips the game loop keeps running between them, and the charge's own drain
// — 0.25/second — moves energy by about 0.01 in the ~40ms each trip costs.
// That is the same order as a phaser shot, so the split version failed roughly
// one run in three on a hit the assertion never fired.
const { lockedBefore, lockedAfter } = await page.evaluate(() => {
  const p = window.__player;
  const before = { torpedoes: p.torpedoes, energy: p.energy };
  window.__session.update(0, p, { firePhaser: true, fireTorpedo: true, thrust: false });
  return { lockedBefore: before, lockedAfter: { torpedoes: p.torpedoes, energy: p.energy } };
});
check(
  "weapons are locked while charging",
  lockedAfter.torpedoes === lockedBefore.torpedoes && lockedAfter.energy === lockedBefore.energy,
  `torpedoes ${lockedBefore.torpedoes}→${lockedAfter.torpedoes}, energy ${lockedBefore.energy.toFixed(3)}→${lockedAfter.energy.toFixed(3)}`,
);

const sectorBefore = (await probe()).sector;
// Wait on the thing only the jump itself can produce, not on the multiplier
// threshold — see the comment above the pin. A hostile hit landing during the
// two-second charge could otherwise satisfy `multiplier <= 2` on its own,
// which would (a) let a deleted halving in arrive() still pass this check and
// (b) leave the next two assertions reading pre-jump state, a live flake
// source independent of (a).
state = await waitFor((s) => s.sector !== sectorBefore, 15000);
await page.keyboard.up("Shift");
check("arriving halves the multiplier", state.multiplier <= 2, `x${state.multiplier}`);
// HYPERWARP.arrivalEnergy is 0.25, but the charge's own drain
// (drainPerSecond * charge = 0.25 * 2 = 0.5) starting from the energy=1 set
// above would *also* land near 0.5 with the explicit arrival-energy
// assignment deleted entirely — a threshold of 0.6 would pass on drain alone
// and never actually exercise the override. 0.35 sits strictly below that
// natural leftover and strictly above the 0.25 constant, so only the real
// assignment in arrive() can satisfy it.
check("...and you arrive cold", state.energy < 0.35, `energy=${state.energy}`);
// Without this the jump is a reset button rather than travel.
check("...and somewhere else", state.sector !== sectorBefore, `${sectorBefore} → ${state.sector}`);
await page.evaluate(() => { clearInterval(window.__pin); delete window.__pin; });

// ── the chart overlay ────────────────────────────────────────────────────────
// This block used to re-read the exact predicate `waitFor` had just
// satisfied, which cannot fail, and never established the overlay was
// actually up — an implementation where Tab is unbound or drawChart
// early-returns unconditionally would still pass it. Establish each thing
// separately instead.

// Pinned for the whole block: waiting for a wave to advance can run for
// several seconds next to whatever spawned, and this block is about the
// overlay and the cursor, not about whether the harness can survive combat.
await page.evaluate(() => {
  window.__chartPin = setInterval(() => { window.__player.hull = 1; }, 80);
});

// Holding Tab has to raise chartOpacity itself, not just something that
// happens to correlate with it.
const waveBefore = (await probe()).wave;
await page.keyboard.down("Tab");
state = await waitFor((s) => s.chartOpacity > 0.5, 3000);
check("holding Tab raises the chart's opacity", state.chartOpacity > 0.5, `opacity=${state.chartOpacity}`);

// The wave clock has to advance *while the overlay is still up*, not merely
// resume once Tab is released — waiting for `wave > waveBefore` and then
// reading a post-release probe would pass even if the clock only restarted
// on release. Capture the wave before raising the chart and require a
// strictly greater value while chartOpacity is still above the threshold.
state = await waitFor((s) => s.wave > waveBefore && s.chartOpacity > 0.5, 30000);
check(
  "the chart does not stop the wave clock",
  state.wave > waveBefore && state.chartOpacity > 0.5,
  `wave ${waveBefore} → ${state.wave}, opacity=${state.chartOpacity}`,
);

// WASD steps the cursor one sector per press and never walks it off the grid.
// Park it in a corner first so both a normal move and an off-grid clamp are
// exercised from known, computed positions rather than magic indices.
const corners = await page.evaluate(() => {
  const { indexOf } = window.__chart;
  return { nw: indexOf(0, 0), east: indexOf(1, 0), south: indexOf(0, 1) };
});
await page.evaluate((nw) => window.__chartCursor.set(nw), corners.nw);

await page.keyboard.press("d");
state = await waitFor((s) => s.chartCursor === corners.east, 3000);
check("D steps the cursor one sector east", state.chartCursor === corners.east, `cursor=${state.chartCursor}`);

await page.keyboard.press("a");
state = await waitFor((s) => s.chartCursor === corners.nw, 3000);
check("A steps the cursor back west", state.chartCursor === corners.nw, `cursor=${state.chartCursor}`);

// From the northwest corner, stepping further west or north must not move
// the cursor off the grid.
await page.keyboard.press("a");
await page.waitForTimeout(200);
state = await probe();
check("the cursor does not walk off the west edge", state.chartCursor === corners.nw, `cursor=${state.chartCursor}`);
await page.keyboard.press("w");
await page.waitForTimeout(200);
state = await probe();
check("the cursor does not walk off the north edge", state.chartCursor === corners.nw, `cursor=${state.chartCursor}`);

await page.keyboard.press("s");
state = await waitFor((s) => s.chartCursor === corners.south, 3000);
check("S steps the cursor one sector south", state.chartCursor === corners.south, `cursor=${state.chartCursor}`);

// While the overlay is up, WASD is reading the map, not flying the ship —
// but the arrow keys are never reassigned and must still work.
const headingBeforeWasd = await page.evaluate(() => window.__player.heading);
await page.keyboard.down("d");
await page.waitForTimeout(300);
const headingAfterWasd = await page.evaluate(() => window.__player.heading);
await page.keyboard.up("d");
check(
  "WASD does not steer while the chart is up",
  headingAfterWasd === headingBeforeWasd,
  `${headingBeforeWasd} → ${headingAfterWasd}`,
);

const headingBeforeArrow = await page.evaluate(() => window.__player.heading);
await page.keyboard.down("ArrowRight");
await page.waitForTimeout(300);
const headingAfterArrow = await page.evaluate(() => window.__player.heading);
await page.keyboard.up("ArrowRight");
// This used to assert the opposite. The arrows were deliberately exempt from the
// chart so an arrows-flyer could keep manoeuvring while reading it — but that
// handed the exemption to whichever hand the player happened to have learned, and
// took it away from the other. Both schemes now drive the cursor and neither
// flies, which costs the helm for as long as the chart is up. "The chart does not
// pause the game" is untouched: waves still arrive and the hull still takes it.
check(
  "the arrow keys stop steering while the chart is up",
  headingAfterArrow === headingBeforeArrow,
  `${headingBeforeArrow} → ${headingAfterArrow}`,
);

// And the other half of the same change, which nothing covered before.
const cursorBeforeArrow = await page.evaluate(() => window.__probe.chartCursor);
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(300);
const cursorAfterArrow = await page.evaluate(() => window.__probe.chartCursor);
check(
  "...and step the cursor instead",
  cursorAfterArrow === cursorBeforeArrow + 1,
  `cursor ${cursorBeforeArrow} → ${cursorAfterArrow}`,
);

await page.keyboard.up("Tab");
await page.evaluate(() => { clearInterval(window.__chartPin); delete window.__chartPin; });

// ── a jump intercepts a committed attack on the destination ─────────────────
// Flagged by Task 7's implementer as untested: reaching a sector the enemy
// has already committed to attacking should cancel that attack — see the
// comment on Session.updateWaves(). Prove it the way a player actually
// would: jump to a threatened sector, then clear the wave that greets you
// there — *while a real fight is already under way back where the jump
// started*. That precondition is not incidental: arrive() empties the fleet
// on its own, and the "fighting → clear" transition that fires interception
// used to fire for whatever campaign.current happened to be at that moment —
// including the sector just arrived in, credited for a fight that happened
// somewhere else entirely, for free. A jump begun from a clean, idle state
// can never exercise that path at all, so the wave from the previous section
// is deliberately left up rather than cleared first.
await page.evaluate(() => {
  window.__hullPin = setInterval(() => { window.__player.hull = 1; }, 80);
});
state = await waitFor((s) => s.hostiles > 0, 10000);

const interceptSetup = await page.evaluate(() => {
  const { neighbours } = window.__chart;
  const from = window.__campaign.current;
  const to = neighbours(from)[0];
  window.__campaign.incoming.push({ sector: to, runsUntil: 5 });
  window.__player.energy = 1;
  window.__chartCursor.set(to);
  return { from, to, inboundBefore: window.__campaign.incoming.length };
});

await page.keyboard.down("Shift");
state = await waitFor((s) => s.sector === interceptSetup.to, 8000);
await page.keyboard.up("Shift");
check(
  "jump lands on the threatened sector",
  state.sector === interceptSetup.to,
  `${interceptSetup.from} → ${state.sector}, wanted ${interceptSetup.to}`,
);
// The regression test for the free-interception bug: read the instant the
// jump lands, before any wave is fought at the destination. The fight left
// running back at `from` is what would let a broken implementation credit
// this as interception; a correct one must still show the attack pending.
check(
  "arrival alone does not intercept",
  state.inbound === interceptSetup.inboundBefore,
  `inbound=${state.inbound}`,
);

// Now actually fight — spawn the sector's own wave and clear it for real.
await page.evaluate(() => { window.__session.breakTimer = 0; });
state = await waitFor((s) => s.hostiles > 0, 10000);
await page.evaluate(() => { window.__fleet.clear(); });
state = await waitFor((s) => s.inbound < interceptSetup.inboundBefore, 10000);
check(
  "clearing a wave there intercepts the committed attack",
  state.inbound < interceptSetup.inboundBefore,
  `inbound ${interceptSetup.inboundBefore} → ${state.inbound}`,
);

await page.evaluate(() => { clearInterval(window.__hullPin); delete window.__hullPin; });

// ── beauty shots: full size, every effect on ────────────────────────────────
await page.setViewportSize({ width: 1280, height: 800 });
await page.evaluate(() => {
  window.__stage.bloom.enabled = true;
  window.__stage.phosphor.enabled = true;
  window.__stage.crt.enabled = true;
  window.__stage.setSize(1280, 800);
});
await page.waitForTimeout(2500);

await page.keyboard.down(" ");
await page.keyboard.down("ArrowRight");
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/hero-chase.png` });
await page.keyboard.up("ArrowRight");
await page.keyboard.up(" ");

await page.keyboard.press("1");
await page.waitForTimeout(2500);
await page.keyboard.down(" ");
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/hero-cockpit.png` });
await page.keyboard.up(" ");

// ── a saved era has to survive a reload ─────────────────────────────────────
// The regression this exists for: honouring a saved era at boot was placed
// before `settings` was initialised, so a campaign with a non-default hull threw
// a ReferenceError out of module evaluation and the screen went black with no
// renderer fault to show for it. Typecheck cannot see it — TypeScript does not
// trace use-before-declaration through a call — and nothing else here caught it,
// because every other assertion in this file starts from empty storage and takes
// the other branch. So: pick a different ship, reload, and require the game to
// come back up.
// Written straight into storage rather than pressed in: `N` is refused during a
// run, and by this point in the file a run is exactly what is on screen. What
// matters is the *saved* state at the next boot, which is what this sets.
const chosen = await page.evaluate(() => {
  const raw = localStorage.getItem("kobayashi.campaign");
  if (!raw) return null;
  const saved = JSON.parse(raw);
  saved.era = "defiant";
  localStorage.setItem("kobayashi.campaign", JSON.stringify(saved));
  return "DEFIANT ESCORT";
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2200);
const rebooted = await page.evaluate(() => ({
  alive: !!window.__probe,
  era: window.__probe?.era ?? null,
  fault: (() => { const f = document.getElementById("fault");
    return f ? getComputedStyle(f).display !== "none" : null; })(),
}));
check(
  "a saved hull still boots",
  rebooted.alive && !rebooted.fault && rebooted.era === chosen,
  `saved ${chosen} -> ${rebooted.era}${rebooted.fault ? " FAULT" : ""}`,
);

console.log(problems.length ? `\nPROBLEMS:\n${problems.join("\n")}` : "\nno problems");
await browser.close();
process.exit(problems.length ? 1 : 0);
