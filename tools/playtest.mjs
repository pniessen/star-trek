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

await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
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

// ── wave one arrives ────────────────────────────────────────────────────────
let state = await waitFor((s) => s.wave >= 1 && s.hostiles > 0);
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
await page.evaluate(() => {
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
state = await waitFor((s) => s.multiplier <= 2, 15000);
await page.keyboard.up("Shift");
check("arriving halves the multiplier", state.multiplier <= 2, `x${state.multiplier}`);
check("...and you arrive cold", state.energy < 0.6, `energy=${state.energy}`);
// Without this the jump is a reset button rather than travel.
check("...and somewhere else", state.sector !== sectorBefore, `${sectorBefore} → ${state.sector}`);

// ── the overlay does not pause the game ─────────────────────────────────────
const waveBefore = (await probe()).wave;
await page.keyboard.down("Tab");
await waitFor((s) => s.wave > waveBefore, 30000);
await page.keyboard.up("Tab");
check("the chart does not stop the wave clock", (await probe()).wave > waveBefore, `wave>${waveBefore}`);

// ── a jump intercepts a committed attack on the destination ─────────────────
// Flagged by Task 7's implementer as untested: reaching a sector the enemy
// has already committed to attacking should cancel that attack — see the
// comment on Session.updateWaves(). Prove it the way a player actually would:
// jump to a threatened sector, then clear the wave that greets you there.
//
// Arriving is deliberately checked *before* the clear. Arrival empties the
// fleet on its own (`arrive()` calls `fleet.clear()`), and the "fighting →
// clear" transition that fires interception doesn't care which sector taught
// it "fighting" — so a charge begun while a fight was already under way could
// look like an interception by accident, on a sector nothing was ever fought
// in. Forcing a clean "clear" state before the jump, and asserting inbound is
// still untouched the instant the jump lands, is what rules that out and
// makes the drop below actually attributable to clearing the destination's
// own wave.
await page.evaluate(() => {
  window.__hullPin = setInterval(() => { window.__player.hull = 1; }, 80);
  window.__fleet.clear();
  window.__session.state = "clear";
  // Pinned so the break timer can't sneak a wave in before the setup below
  // finishes pointing the jump.
  window.__session.breakTimer = 999;
});

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
