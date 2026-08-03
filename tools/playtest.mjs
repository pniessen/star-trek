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
await page.screenshot({ path: `${OUT}/dead.png` });

await page.keyboard.press("r");
state = await waitFor((s) => s.score === 0 && s.hull === 1 && s.wave >= 1);
check("restart begins a fresh run", state.score === 0 && state.hull === 1 && state.wave >= 1, JSON.stringify(state));

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
