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

await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
await page.evaluate(() => {
  window.__stage.bloom.enabled = false;
  window.__stage.phosphor.enabled = false;
  window.__stage.crt.enabled = false;
});
await page.waitForTimeout(3400);

// ── wave one arrives ────────────────────────────────────────────────────────
let state = await probe();
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
await page.waitForTimeout(2600);
await page.screenshot({ path: `${OUT}/combat.png` });
await page.keyboard.up(" ");
await page.waitForTimeout(300);

state = await probe();
check("phaser draws energy", state.energy < 1, `energy=${state.energy}`);
check("kills bank salvage", state.pending > 0, `pending=${state.pending}`);
check("multiplier climbs", state.multiplier > 1, `x${state.multiplier}`);

// ── torpedoes ───────────────────────────────────────────────────────────────
const before = (await probe()).torpedoes;
await page.keyboard.press("x");
await page.waitForTimeout(250);
state = await probe();
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
await page.waitForTimeout(120);
state = await probe();
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
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/docking.png` });
await page.waitForTimeout(2200);

state = await probe();
check("docking banks the multiplier", state.score > 0, `score=${state.score}`);
check("docking resupplies", state.torpedoes === 12 && state.energy > 0.9, JSON.stringify({ t: state.torpedoes, e: state.energy }));
check("multiplier resets after banking", state.multiplier === 1, `x${state.multiplier}`);
await page.screenshot({ path: `${OUT}/docked.png` });

// ── death and restart ───────────────────────────────────────────────────────
await page.evaluate(() => { window.__player.hull = 0; });
await page.waitForTimeout(400);
state = await probe();
check("hull loss ends the run", state.state === "dead", `state=${state.state}`);
await page.screenshot({ path: `${OUT}/dead.png` });

await page.keyboard.press("r");
await page.waitForTimeout(2600);
state = await probe();
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
