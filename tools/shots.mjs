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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));

await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

const fault = await page.evaluate(() => document.getElementById("fault")?.textContent || "");
if (fault) console.log("FAULT:", fault.slice(0, 800));

// Fly forward a moment so there is motion in the phosphor trail.
await page.keyboard.down("ArrowUp");
await page.keyboard.down("ArrowRight");
await page.waitForTimeout(900);
await page.keyboard.up("ArrowRight");
await page.waitForTimeout(600);
await page.keyboard.up("ArrowUp");

const shots = [
  ["chase-occluded", []],
  ["chase-wireframe", ["g"]],
  ["cockpit-wireframe", ["1"]],
  ["cockpit-occluded", ["g"]],
  ["orbit-occluded", ["3"]],
  ["orbit-raw-no-post", ["b", "f", "v"]],
];

for (const [name, keys] of shots) {
  for (const k of keys) await page.keyboard.press(k);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot:", name);
}

const stats = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  return { w: c?.width, h: c?.height };
});
console.log("canvas:", JSON.stringify(stats));
console.log(errors.length ? "CONSOLE:\n" + errors.slice(0, 15).join("\n") : "console clean");

await browser.close();
