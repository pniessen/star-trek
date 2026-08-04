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

// A fresh load lands on the title screen with nothing spawning behind it, and
// left alone it drops into the attract demo, which then fights the harness for
// the keyboard. Launch a real run through the same door a player uses.
await page.keyboard.press("Enter");
await waitFor((s) => s.mode === "run", 10000);

// ── the opening log ─────────────────────────────────────────────────────────
// A fresh browser context has an empty localStorage, so the campaign the page
// boots with is a new war — the one time the log plays. It is a hold inside
// mode "run", not a mode of its own, so it is read off its own probe field.
let state = await waitFor((s) => s.briefing, 5000);
check("a new campaign opens with the log", state.briefing === true, `briefing=${state.briefing}`);
await page.screenshot({ path: `${OUT}/briefing.png` });

// And any key ends it on the frame it arrives. Everything below this line
// depends on that: the log holds the session, so a wave would never spawn.
await page.keyboard.press("Enter");
state = await waitFor((s) => !s.briefing, 3000);
check("any key skips the log", state.briefing === false, `briefing=${state.briefing}`);

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
const lockedBefore = await page.evaluate(() => {
  const p = window.__player;
  return { torpedoes: p.torpedoes, energy: p.energy };
});
await page.evaluate(() => {
  window.__session.update(0, window.__player, { firePhaser: true, fireTorpedo: true, thrust: false });
});
const lockedAfter = await page.evaluate(() => {
  const p = window.__player;
  return { torpedoes: p.torpedoes, energy: p.energy };
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
check(
  "the arrow keys still steer while the chart is up",
  headingAfterArrow !== headingBeforeArrow,
  `${headingBeforeArrow} → ${headingAfterArrow}`,
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
console.log(problems.length ? `\nPROBLEMS:\n${problems.join("\n")}` : "\nno problems");
await browser.close();
process.exit(problems.length ? 1 : 0);
