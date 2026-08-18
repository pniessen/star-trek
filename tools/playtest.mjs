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
// The hero giant's body is a hand-written domain-warped-noise ShaderMaterial
// (`render/GasGiant.ts`) — the single biggest per-fragment cost of anything
// on screen, and under SwiftShader that cost is what pushes a frame slow
// enough to put the dt clamp into slow motion late in this file (the forced
// win at the very end waits on 2.45 game-seconds of death-drift, and a
// giant-sized frame budget can make that outrun its own wall-clock timeout).
// This harness is not a screenshot of the sky, so the giant is hidden right
// alongside the post chain rather than tuned around. The checks below still
// read `body`/`limb`/their uniforms directly, which needs no rendering at
// all, so hiding the object leaves every one of them intact.
await page.evaluate(() => {
  window.__scenery.hide();
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

// ── the tuning console ──────────────────────────────────────────────────────
// Asserted here, before a run exists, for the reason the two pure-function
// blocks around it are: the console works on the title screen and nothing it
// touches needs a session. It is also the safest place for it — every key
// pressed below is either a display toggle or one the open console eats, so
// none of them launches a run and the sequencing after this point is
// untouched. The block puts everything back before it leaves.
const consoleKeys = await page.evaluate(() => window.__tuning.keys);
// The one property of this feature that can regress silently: a key added to
// the console that the ship already flies with. `Z` and `C` are the two most
// recent additions to the ship's own keyboard and the two most likely to be
// forgotten, so the ship's whole control surface is spelled out rather than
// sampled.
const flightKeys = [
  "arrowup", "arrowdown", "arrowleft", "arrowright",
  "w", "a", "s", "d", "q", "e", " ", "x", "c", "z", "shift", "tab", "r",
];
check(
  "the console's keyboard does not overlap the ship's",
  flightKeys.every((k) => !consoleKeys.includes(k)),
  `console=${consoleKeys.join("")}`,
);

await page.keyboard.press("`");
check("backquote opens the console", (await page.evaluate(() => window.__tuning.tuner.open)) === true);

// `'` is one step on the highlighted knob, and the first knob of the first
// block is `Ship.TURN_ACCEL` — the oldest first-draft guess in the game and
// the reason the console exists at all.
const knobWas = await page.evaluate(() => window.__tuning.blocks[0].knobs[0].read());
await page.keyboard.press("'");
const knobNow = await page.evaluate(() => window.__tuning.blocks[0].knobs[0].read());
const knobStep = await page.evaluate(() => window.__tuning.blocks[0].knobs[0].step);
check("a tap moves the knob exactly one step", Math.abs(knobNow - knobWas - knobStep) < 1e-9, `${knobWas} -> ${knobNow}`);
check("...and the ship is actually flying it", (await page.evaluate(() => window.__player.constructor.TURN_ACCEL)) === knobNow, `Ship.TURN_ACCEL=${knobNow}`);

const dump = await page.evaluate(() => window.__tuning.patch());
check("the patch names the file, the field and what it used to say",
  dump.includes("src/game/Ship.ts") && dump.includes("TURN_ACCEL") && dump.includes(`was ${knobWas}`),
  dump.replace(/\n/g, " | "));

// `,` and `.` walk the list, `/` turns the page. Checked together because a
// page turn has to reset the row or the cursor lands past the end of a
// shorter block.
await page.keyboard.press(".");
check("a step down the list moves the highlight", (await page.evaluate(() => window.__tuning.tuner.row)) === 1);
await page.keyboard.press(",");
check("...and a step back up returns it", (await page.evaluate(() => window.__tuning.tuner.row)) === 0);
await page.keyboard.press("/");
const paged = await page.evaluate(() => ({ block: window.__tuning.tuner.block, row: window.__tuning.tuner.row }));
check("a page turn changes block and resets the row", paged.block === 1 && paged.row === 0, JSON.stringify(paged));

// Back to the first block, then put the knob back — the rest of this file
// flies the ship and must fly the one the source describes.
await page.keyboard.press("/");
await page.keyboard.press("/");
await page.keyboard.press("/");
await page.keyboard.press("/");
await page.keyboard.press("/");
await page.keyboard.press("/");
await page.keyboard.press("0");
check("reset puts the knob back to what the file says",
  (await page.evaluate(() => window.__tuning.patch())).includes("nothing moved"),
  await page.evaluate(() => window.__tuning.blocks[0].knobs[0].read()),
);

await page.keyboard.press("`");
check("backquote closes it again", (await page.evaluate(() => window.__tuning.tuner.open)) === false);
check("...and the title screen is still the title screen", (await probe()).mode === "title", (await probe()).mode);

// ── the sector's star is pure and seeded ────────────────────────────────────
// `planLight`/`shadeAt` (`render/light.ts`) are pure functions with nothing
// wired into a run yet — Task 3 is the first consumer — so, like the comet's
// own tail-volume test above, this is asserted before a run exists at all.
const lit = await page.evaluate(async () => {
  const { planLight, shadeAt } = window.__light;
  const l = planLight(12345, 7);
  const at = { x: 0, y: 0, z: 0 };
  const toward = { x: l.position.x, y: l.position.y, z: l.position.z };
  const len = Math.hypot(toward.x, toward.y, toward.z);
  const facing = { x: toward.x / len, y: toward.y / len, z: toward.z / len };
  const away = { x: -facing.x, y: -facing.y, z: -facing.z };
  return {
    facing: shadeAt(l, at, facing),
    away: shadeAt(l, at, away),
    same: planLight(12345, 7).position.x === l.position.x,
    other: planLight(12345, 8).position.x !== l.position.x,
  };
});
check("a surface facing the star is bright", lit.facing > 0.8, `v=${lit.facing}`);
check("...and one facing away is dim but not black", lit.away > 0 && lit.away < 0.25, `v=${lit.away}`);
check("the sector's star is seeded", lit.same, "same seed and sector differ");
check("...and differs between sectors", lit.other, "two sectors share a star position");

// ── the hero gas giant is a real lit mesh, not strokes ──────────────────────
// Rewritten three times now for the same file: first for `docs/environment.md`
// §1.5 (a real mesh instead of strokes), then to move banding from baked
// vertex colours into `body`'s fragment shader, then to replace the band
// lookup itself with domain-warped flow noise — see `render/GasGiant.ts`'s
// own header for why each rebuild happened. The old `getAttribute("color")`
// check tested a buffer that no longer exists; this checks the geometry's
// own vertex count instead, since tessellation only has to keep the
// silhouette round, not carry the pattern. `uBandCount` went with the band
// lookup it belonged to — `uFlowScale` is its replacement as "some shader
// uniform only the flow-noise rebuild would set." Rotation moved off the
// mesh onto a `uRotation` uniform in the same rebuild (`update`'s own
// comment has the reasoning), so this now reads that uniform rather than
// `body.rotation.y`, which no longer changes. `window.__giant` is the live
// instance the frame loop drives, but the frame loop now only calls `show`
// when `planHero` casts the giant for the sector in play (`render/scenery.ts`),
// so this calls `show` directly first — the same thing the giant-seeding
// block below it already does — rather than trusting an unconditional
// per-frame call that no longer exists.
const giant = await page.evaluate(() => {
  const g = window.__giant;
  const { planLight } = window.__light;
  g.show(1, 0, planLight(1, 0));
  const positionAttr = g.body?.geometry?.getAttribute("position");
  const hasShaderUniforms = typeof g.body?.material?.uniforms?.uFlowScale?.value === "number";
  const before = g.body ? g.body.material.uniforms.uRotation.value : 0;
  g.update(1.0);
  const after = g.body ? g.body.material.uniforms.uRotation.value : 0;
  return {
    hasBody: !!g.body,
    vertexCount: positionAttr ? positionAttr.count : 0,
    hasShaderUniforms,
    rotated: g.body != null && after !== before,
    hasLimb: !!g.limb,
    // THREE.AdditiveBlending === 2 (NoBlending 0, NormalBlending 1,
    // AdditiveBlending 2) — a stable constant, not worth importing `three`
    // into a bare-node harness for.
    limbAdditive: g.limb?.material?.blending === 2,
    limbDepthTested: g.limb?.material?.depthTest === true,
  };
});
check("the giant is a real mesh, not a field of strokes", giant.hasBody, `hasBody=${giant.hasBody}`);
check("...tessellated enough for a round silhouette", giant.vertexCount > 500, `${giant.vertexCount} vertices`);
check("...coloured by the flow-noise shader, not a band lookup", giant.hasShaderUniforms, `uFlowScale set=${giant.hasShaderUniforms}`);
check("...and rotates by advancing the sample coordinate", giant.rotated, `rotated=${giant.rotated}`);
check(
  "...under an additive limb shell",
  giant.hasLimb && giant.limbAdditive,
  `hasLimb=${giant.hasLimb} additive=${giant.limbAdditive}`,
);
check(
  "...depth-tested against the body, not just laid over it",
  giant.limbDepthTested,
  `depthTest=${giant.limbDepthTested}`,
);

// ── the giant is seeded, not merely cached ──────────────────────────────────
// `show`'s key cache (`this.key`) is what every other check above reads
// through — the live instance, whatever sector the run happens to be in —
// so none of them would notice a hash mix that accidentally correlated with
// `planLight`'s own: two different-looking inputs producing the same-looking
// giant is exactly the furniture problem `show`'s own comment warns against,
// and nothing above forces two sectors apart to check it. This calls `show`
// directly instead, the way the fixture-seeding check below calls `plan`
// directly, and alternates the sector on each call so the key-cache's own
// early return is never what makes two calls agree.
const giantSeeded = await page.evaluate(() => {
  const g = window.__giant;
  const { planLight } = window.__light;
  const seed = 4242;
  const a = 3;
  const b = 9;
  g.show(seed, a, planLight(seed, a));
  const hue1 = g.body.material.uniforms.uHue.value;
  g.show(seed, b, planLight(seed, b));
  const hue2 = g.body.material.uniforms.uHue.value;
  g.show(seed, a, planLight(seed, a));
  const hue3 = g.body.material.uniforms.uHue.value;
  return { hue1, hue2, hue3 };
});
check(
  "the giant repeats for the same seed and sector",
  giantSeeded.hue1 === giantSeeded.hue3,
  `hue1=${giantSeeded.hue1} hue3=${giantSeeded.hue3}`,
);
check(
  "...and differs for a different sector",
  giantSeeded.hue1 !== giantSeeded.hue2,
  `hue1=${giantSeeded.hue1} hue2=${giantSeeded.hue2}`,
);

// ── the hero draw is seeded and covers the roster ───────────────────────────
// `planHero` is pure — no `window.__` global carries it, so this imports the
// module directly the way the giant/fixture checks above call their own
// functions directly. 64 sectors at the smallest weight 0.10 misses a kind
// with probability ~0.001 per kind at a fixed seed; this runs one fixed seed,
// so it is deterministic in practice — if the chosen hash lands unluckily,
// bump the sweep rather than reseeding the world.
const hero = await page.evaluate(async () => {
  const { planHero } = await import("/src/render/scenery.ts");
  const seed = 4242;
  const kinds = new Set();
  for (let s = 0; s < 64; s++) kinds.add(planHero(seed, s));
  return {
    deterministic: planHero(seed, 7) === planHero(seed, 7),
    differs: planHero(seed, 7) !== planHero(seed, 8) || planHero(seed, 7) !== planHero(seed, 9),
    kinds: [...kinds].sort(),
  };
});
check("the hero draw repeats for the same seed and sector", hero.deterministic, "");
check("...and is not one constant across sectors", hero.differs, "");
check(
  "every hero kind occurs somewhere on one board's worth of sectors",
  ["bare", "giant", "moon", "ringed", "rocks", "sun"].every((k) => hero.kinds.includes(k)),
  `kinds=${hero.kinds.join(",")}`,
);

// ── the scenery switch hides everything at once ─────────────────────────────
// `__scenery` is the one thing every hero body plus `shoalsVisible` answers
// to — the SwiftShader budget concern that made the giant's own hide-on-load
// necessary above now covers whichever body actually cast for this sector.
const sceneryOff = await page.evaluate(() => {
  window.__scenery.hide();
  return window.__giant.object.visible === false;
});
check("the scenery switch hides the giant with everything else", sceneryOff, "");

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

// ── gas shoals are seeded ────────────────────────────────────────────────────
// `planShoal` is pure — same shape as `planFixture`'s own check above. Chance
// is 0.2, independent of `planHero`'s own roll, so a 64-sector sweep at a fixed
// seed should land somewhere between "basically never" and "basically always".
const shoal = await page.evaluate(async () => {
  const { planShoal } = await import("/src/render/Shoals.ts");
  const seed = 4242;
  let have = 0;
  for (let s = 0; s < 64; s++) if (planShoal(seed, s)) have++;
  return { have, deterministic: !!planShoal(seed, 3) === !!planShoal(seed, 3) };
});
check("shoals are seeded in some sectors and not others", shoal.have > 3 && shoal.have < 30, `have=${shoal.have}`);
check("a shoal repeats for its seed and sector", shoal.deterministic, "");

// ── the boot sector's own shoal is already showing ──────────────────────────
// Finding 1: `shoals.show` used to run only from main.ts's sector-CHANGE
// block, gated on `currentLightKey !== sectorLightKey` — but `sectorLightKey`
// is pre-seeded to the boot sector's own key before the first frame ever
// runs, so that block never fires on a fresh load. A shoal standing in the
// boot sector would silently never show until the player left and returned.
// `campaign.current` has not been touched by any earlier check in this file,
// so it is still whatever the game actually booted into — this compares what
// `__shoals.plan` (the live render loop's own state) holds against what
// `planShoal` says that exact sector should produce. On the unfixed code this
// only fails when the boot sector happens to roll a shoal (chance 0.2); it is
// a vacuous pass the other 80% of the time, which is why the forced-sector
// check right after it is also needed to exercise the wiring on every run.
const bootShoal = await page.evaluate(async () => {
  const { planShoal } = await import("/src/render/Shoals.ts");
  const seed = window.__campaign.seed;
  const bootSector = window.__campaign.current;
  const expected = planShoal(seed, bootSector);
  const actual = window.__shoals.plan;
  const matches =
    (expected === null) === (actual === null) &&
    (expected === null ||
      (actual.bearing === expected.bearing &&
        actual.range === expected.range &&
        actual.span === expected.span &&
        actual.drift === expected.drift));
  return { bootSector, hasShoal: expected !== null, matches };
});
check(
  "the boot sector's shoal, if it has one, is already showing before any sector change",
  bootShoal.matches,
  JSON.stringify(bootShoal),
);

// ── forcing a shoal sector shows its curtain within a frame ─────────────────
// General cover for the same call, independent of what the boot sector
// happened to roll: force `campaign.current` to a sector this seed actually
// grows a shoal in, give the render loop one frame, and check `__shoals.plan`
// picked it up. This alone would pass on the unfixed code too whenever the
// forced sector differs from the boot sector (the sector-change block still
// fires on a genuine change) — it is the `bootShoal` check above, not this
// one, that isolates the actual bug; this one only proves the call keeps
// working for sector changes in general, which the fix must not break.
const shoalWiring = await page.evaluate(async () => {
  const { planShoal } = await import("/src/render/Shoals.ts");
  const seed = window.__campaign.seed;
  const sectorBefore = window.__campaign.current;
  let shoalSector = -1;
  for (let s = 0; s < 64; s++) {
    if (planShoal(seed, s)) {
      shoalSector = s;
      break;
    }
  }
  if (shoalSector < 0) return { skip: true, sectorBefore };
  window.__campaign.current = shoalSector;
  return { skip: false, shoalSector, sectorBefore };
});
if (!shoalWiring.skip) {
  // Polled rather than a fixed sleep — the same reasoning `waitFor`'s own
  // header gives: how much wall-clock a frame costs varies with the host's
  // GL, so a fixed wait is a coin flip and a poll is not.
  const deadline = Date.now() + 5000;
  let shoalShown = await page.evaluate(() => window.__shoals.plan !== null);
  while (!shoalShown && Date.now() < deadline) {
    await page.waitForTimeout(50);
    shoalShown = await page.evaluate(() => window.__shoals.plan !== null);
  }
  check("forcing a shoal sector shows its curtain within a frame", shoalShown, "");
  await page.evaluate((sectorBefore) => {
    window.__campaign.current = sectorBefore;
  }, shoalWiring.sectorBefore);
}

// ── forcing a sector changes the room within a frame ────────────────────────
// Unlike the shoal block just above (pure rendering, no gesture needed),
// `__sound.room` is legitimately `null` until the first real gesture:
// `enterSector` no longer applies (or caches) a room while
// `Sound`/`Synth` has no rig to build a convolver in — the fix for the
// review's "boot sector never reaches the convolver" finding, which is
// exactly what this comment used to assume away ("already non-null by the
// time this runs") back when that assumption was only true *because* of the
// bug. `h` is a harmless, side-effect-free gesture: it is in `DISPLAY_KEYS`
// (so it neither launches a run nor touches the deck log the way `l` would)
// and toggles `settings.diagnostics`, which nothing here asserts.
// Once the gesture has happened, the poll waits for the *name* to agree
// with the sector just forced rather than for mere non-nullness — a stale
// room from an earlier block would otherwise pass this check by accident
// before the real one ever landed.
await page.keyboard.press("h");
const roomSectors = await page.evaluate(async () => {
  const { planHero } = await import("/src/render/scenery.ts");
  const { planShoal } = await import("/src/render/Shoals.ts");
  const seed = window.__campaign.seed;
  const sectorBefore = window.__campaign.current;
  let bareSector = -1;
  let rockSector = -1;
  for (let s = 0; s < 64 && (bareSector < 0 || rockSector < 0); s++) {
    // A shoal is rolled independently of the hero (`main.ts`'s own comment
    // says so: "not `planHero`'s — so a shoal can stand in a `bare` sector"),
    // and `roomFor` then hands back `bare+shoal` with a non-zero `wet`. The
    // bare assertion below asserts `wet === 0`, so a bare sector that happens
    // to carry a curtain fails it — a real ~20% flake, since the campaign
    // seed differs run to run. Both sectors are therefore required to be
    // shoal-free, which is what makes the room's name exactly the hero's.
    if (planShoal(seed, s)) continue;
    const kind = planHero(seed, s);
    if (bareSector < 0 && kind === "bare") bareSector = s;
    if (rockSector < 0 && kind === "rocks") rockSector = s;
  }
  return { sectorBefore, bareSector, rockSector };
});
async function forceRoomSector(sector, expectedKind) {
  await page.evaluate((s) => {
    window.__campaign.current = s;
  }, sector);
  const deadline = Date.now() + 5000;
  let room = await page.evaluate(() => window.__sound.room);
  while ((!room || !room.name.startsWith(expectedKind)) && Date.now() < deadline) {
    await page.waitForTimeout(50);
    room = await page.evaluate(() => window.__sound.room);
  }
  return room;
}
if (roomSectors.bareSector >= 0) {
  const bareRoom = await forceRoomSector(roomSectors.bareSector, "bare");
  check(
    "forcing a bare sector leaves the room bone dry within a frame",
    bareRoom !== null && bareRoom.name.startsWith("bare") && bareRoom.wet === 0,
    JSON.stringify(bareRoom),
  );
}
if (roomSectors.rockSector >= 0) {
  const rockRoom = await forceRoomSector(roomSectors.rockSector, "rocks");
  check(
    "forcing a rocks sector gives the room something to answer back with",
    rockRoom !== null && rockRoom.name.startsWith("rocks") && rockRoom.wet > 0,
    JSON.stringify(rockRoom),
  );
}
await page.evaluate((sectorBefore) => {
  window.__campaign.current = sectorBefore;
}, roomSectors.sectorBefore);

// ── the compass ─────────────────────────────────────────────────────────────
// A bearing readout must never show 360, and the naive spelling does: taking
// the modulo before rounding displays `360` for every bearing from 359.5 up.
// Half a degree of every turn, on the one instrument whose job is to say
// unambiguously which way you are pointed. Pure formatting, so it is asserted
// here with the other run-independent checks.
const bearings = await page.evaluate(async () => {
  const { compass } = await import("/src/hud/draw.ts");
  return [0, 5, 95, 359.4, 359.5, 359.7, 360].map((d) => compass(d));
});
check("a bearing is always three digits", bearings.every((b) => b.length === 3), bearings.join(" "));
check("...and never reads 360", !bearings.includes("360"), bearings.join(" "));
check(
  "...and wraps to 000 rather than rounding over the top",
  bearings[4] === "000" && bearings[5] === "000" && bearings[6] === "000",
  `359.5=${bearings[4]} 359.7=${bearings[5]} 360=${bearings[6]}`,
);
check("...and pads below 100", bearings[0] === "000" && bearings[1] === "005", bearings.slice(0, 2).join(" "));

// ── swarmer flanking: sternSign ─────────────────────────────────────────────
// The pure geometric core of facing-aware flanking — which tangent direction
// carries a hostile toward the player's stern — asserted directly rather than
// through a scripted fight, since spawning a controlled brawler+swarmer
// encounter isn't reliably scriptable through the probe.
const stern = await page.evaluate(async () => {
  const { sternSign } = await import("/src/game/hostiles.ts");
  return {
    deadAhead: sternSign(0, 0),
    plus: sternSign(Math.PI * 0.4, 0),
    minus: sternSign(-Math.PI * 0.4, 0),
    starboard: sternSign(Math.PI / 2, 0),
  };
});
check(
  "sternSign never returns 0 for a dead-ahead source",
  stern.deadAhead === -1 || stern.deadAhead === 1,
  `sternSign(0, 0)=${stern.deadAhead}`,
);
check(
  "...and symmetric bearings pick opposite ways round",
  stern.plus === -stern.minus,
  `+0.4π=${stern.plus} -0.4π=${stern.minus}`,
);
// A hostile on the starboard beam (bearing +π/2, player heading 0) sits at
// position (+X) relative to the player, so `toPlayer` (hostile→player) points
// -X. The tangent `(-toPlayer.z, 0, toPlayer.x)` is then (0, 0, -1): a push
// toward -Z. Applied at +X, that walks the hostile's bearing from +π/2 toward
// +π (the stern, since heading is 0) rather than back toward 0 — so sign +1
// is the one that closes on the stern here, matching the shorter-way delta
// from +π/2 to the stern at heading+π=π, which is +π/2 (i.e. positive).
check(
  "...and a starboard-beam hostile gets the sign that closes toward the stern",
  stern.starboard === 1,
  `sternSign(π/2, 0)=${stern.starboard}`,
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
check(
  "...and names the enemy commander",
  truth.lines.some((line) => line.startsWith("THEIR COMMANDER IS")),
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

// ── the radio: three parties, one channel ───────────────────────────────────
// Task 11. `spawnWave` says `"theirs"`/`"wave"` as its last act, so the wave
// that just spawned above should already have keyed the enemy's own voice —
// polled rather than asserted on the instant, the same reasoning `waitFor`
// itself gives (a real GPU and a SwiftShader container do not buy the same
// simulated time per wall-clock second, and this is well within wave one's
// tiny, mostly-swarmer roster, where nothing else on `"theirs"` — a charge,
// a commit, a flank — has any real chance to fire first).
let radioTheirs = await page.evaluate(() => window.__sound.radio.lastPhrase?.party ?? null);
{
  const deadline = Date.now() + 1500;
  while (radioTheirs !== "theirs" && Date.now() < deadline) {
    await page.waitForTimeout(50);
    radioTheirs = await page.evaluate(() => window.__sound.radio.lastPhrase?.party ?? null);
  }
}
check("theirs speaks within a second of a wave spawning", radioTheirs === "theirs", `lastPhrase.party=${radioTheirs}`);

// `dispatch()`'s own preamble: `ours`, before the flat panel tone that
// carries the line. Called directly on the bank rather than driven through
// the whole HQ-arrival mechanism (forced by winding `session.dispatches`'
// own clock, exercised for real further down this file) — this block's only
// claim is the wiring inside `Sound.dispatch()` itself, and a direct call is
// the more targeted way to isolate that from `theirs`' own chatter, which a
// real wave in flight could otherwise interleave with `lastPhrase` first.
const radioOurs = await page.evaluate(() => {
  window.__sound.radio.lastPhrase = null;
  window.__sound.dispatch();
  return window.__sound.radio.lastPhrase;
});
check(
  "dispatch's own radio preamble reads as ours",
  radioOurs?.party === "ours" && radioOurs?.event === "dispatch",
  JSON.stringify(radioOurs),
);

// ── the scanner as a second ear ─────────────────────────────────────────────
// With hostiles up, the arm sweeps across at least one of them within a
// single revolution (~1.5s at `SCANNER.sweepRate`, `4.2` rad/s) and
// `drawHud`'s own `drawScanner` (which is the only place `ScannerModel.update`
// runs) records the crossing as a paint; `main.ts` drains that into
// `sound.ping` on the very next frame. Polled rather than a fixed sleep, the
// same reasoning `waitFor` itself gives — a SwiftShader host and a real GPU
// do not buy the same amount of simulated time per wall-clock second.
// `!= null` deliberately, not `!== null`: before this field exists at all,
// `window.__sound.lastPing` reads back `undefined`, and `undefined !== null`
// is true — a strict check would report a ping before the feature exists.
let pingSeen = await page.evaluate(() => window.__sound.lastPing != null);
{
  const deadline = Date.now() + 6000;
  while (!pingSeen && Date.now() < deadline) {
    await page.waitForTimeout(100);
    pingSeen = await page.evaluate(() => window.__sound.lastPing != null);
  }
}
check("the scanner's own sweep reaches the ear: lastPing records after a wave is up", pingSeen);

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

// ── shield fx: struck quarter flash ─────────────────────────────────────────
// `Ship.takeHit` now records which facing absorbed a hit and starts a decaying
// flash, so `shieldFx.ts` has something world-space to draw at the ship rather
// than only on the HUD dial. `position.clone()` is used for the source rather
// than a plain `{x,y,z}` literal because `takeHit` calls `.clone().sub(...)`
// on it — it needs a real `Vector3`, and the ship's own position is one.
// Offsetting it by `+Z` from a `heading` of 0 is dead ahead, which
// `facingFrom`'s convention (relative bearing 0 → "fore") should route to the
// bow.
await page.evaluate(() => {
  const p = window.__player;
  p.heading = 0;
  const source = p.position.clone();
  source.z += 50;
  p.takeHit(0.3, source);
});
const struck = await page.evaluate(() => ({
  facing: window.__player.struckFacing,
  flash: window.__player.struckFlash,
}));
check(
  "a hit sets the struck facing and starts the flash",
  struck.facing === "fore" && struck.flash > 0,
  JSON.stringify(struck),
);
await page.waitForTimeout(400);
const struckDecayed = await page.evaluate(() => window.__player.struckFlash);
check(
  "the struck flash decays over time",
  struckDecayed < struck.flash && struckDecayed >= 0,
  `flash=${struck.flash} -> ${struckDecayed}`,
);

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

// ── the comet: the Warden is jammed too ─────────────────────────────────────
// The final-branch review's top finding: `Escort` had no `interference` field
// at all, so a Warden parked in a fixture's tail kept firing from
// `WARDEN.fireRange` (56) while every hostile it fought was clamped to
// `COMET.visualRange` (22) and could not fire back — the safe room
// `CLAUDE.md` rules out by name ("hiding behind it can never be a strategy").
//
// The comet is centred on the escort's own spawn point with a wide coma
// (`nucleusRadius: 40`), so `interferenceAt` reads ~1 at the escort's
// position regardless of where the player stands — isolating this from the
// player-position term the lock test above already covers. The target sits a
// fixed 30 units off, inside `WARDEN.fireRange` but outside `visualRange`,
// and is re-pinned there every tick — relative to the escort's own live
// position, not a fixed point — because the escort's steering closes on a
// target it cannot see is unreachable, and a closing distance would make the
// jammed case pass for the wrong reason once it drifted under 22.
//
// The live game loop drives this, the same way the reserve-drain block below
// does: `window.__session.update` is never called directly here.
await page.evaluate(() => {
  window.__fleet.clear();
  window.__wing.clear();
  window.__session.breakTimer = Infinity; // no wave spawn to contaminate the fleet mid-test
});
const wardenTest = await page.evaluate(async () => {
  const player = window.__player;
  player.velocity.set(0, 0, 0);
  const escort = window.__wing.spawn("passing", player.position.clone(), 0);
  const target = window.__fleet.spawn("brawler", escort.position.clone(), 0);

  const tmpl = player.velocity;
  window.__session.comet.show({
    kind: "wanderer",
    nucleus: escort.position.clone(),
    direction: tmpl.clone().set(0, 0, 1),
    length: 60,
    nearRadius: 40,
    farRadius: 40,
    nucleusRadius: 40,
    drift: tmpl.clone().set(0, 0, 0),
  });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const hullBefore = target.hull;

  for (let i = 0; i < 30 && !target.dead; i++) {
    escort.velocity.set(0, 0, 0);
    target.position.set(escort.position.x + 30, 0, escort.position.z);
    target.velocity.set(0, 0, 0);
    escort.cooldown = 0;
    await wait(50);
  }

  const jammed = {
    hullBefore,
    hullAfter: target.hull,
    interference: { escort: escort.interference, target: target.interference },
  };

  window.__session.comet.show(null);
  window.__fleet.clear();
  window.__wing.clear();

  // Control: identical setup, no comet — proves the harness would otherwise
  // let the escort fire, so a null result above is the fix and not a test
  // that never had a chance to catch anything.
  const escort2 = window.__wing.spawn("passing", player.position.clone(), 0);
  const target2 = window.__fleet.spawn("brawler", escort2.position.clone(), 0);
  const openHullBefore = target2.hull;
  for (let i = 0; i < 30 && !target2.dead; i++) {
    escort2.velocity.set(0, 0, 0);
    target2.position.set(escort2.position.x + 30, 0, escort2.position.z);
    target2.velocity.set(0, 0, 0);
    escort2.cooldown = 0;
    await wait(50);
  }
  const open = { hullBefore: openHullBefore, hullAfter: target2.hull };

  window.__fleet.clear();
  window.__wing.clear();

  return { jammed, open };
});
await page.evaluate(() => {
  window.__session.breakTimer = 0; // hand the clock back to the wave scheduler
});
check(
  "an escort inside the tail cannot fire on a target beyond COMET.visualRange",
  wardenTest.jammed.hullAfter === wardenTest.jammed.hullBefore,
  JSON.stringify(wardenTest.jammed),
);
check(
  "...and the same setup with no comet standing is not itself the reason nothing fired",
  wardenTest.open.hullAfter < wardenTest.open.hullBefore,
  JSON.stringify(wardenTest.open),
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

// ── withdrawal ───────────────────────────────────────────────────────────────
// The roll itself is chance-based (`WITHDRAW.chance`), so the honest seam for
// a deterministic test is forcing the flag directly rather than farming hits
// until the dice cooperate — the same shortcut `__loom.seed()` and
// `__comet.seed()` already take for their own rare rolls. What is asserted
// is everything downstream of the flag: an escaped hostile is retired for
// free, and the wave clears behind it exactly as if it had been killed.
await page.evaluate(() => {
  window.__fleet.clear();
  window.__session.breakTimer = Infinity; // no fresh wave contaminating this fleet
});
const withdrawTest = await page.evaluate(async () => {
  const player = window.__player;
  const session = window.__session;
  const fleet = window.__fleet;
  const { WITHDRAW } = await import("/src/game/hostiles.ts");

  const before = { kills: session.kills, pending: session.pending, multiplier: session.multiplier };

  const hostile = fleet.spawn("swarmer", player.position.clone(), 0);
  // Past exitRange from the moment it exists — this is a test of the retire
  // path, not of how long it takes to fly there.
  hostile.position.set(player.position.x + WITHDRAW.exitRange + 40, player.position.y, player.position.z);
  hostile.withdrawing = true;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let present = true;
  for (let i = 0; i < 60 && present; i++) {
    await wait(50);
    present = fleet.hostiles.includes(hostile);
  }

  return {
    before,
    after: { kills: session.kills, pending: session.pending, multiplier: session.multiplier },
    gone: !present,
    state: session.state,
  };
});
await page.evaluate(() => {
  window.__session.breakTimer = 0; // hand the clock back to the wave scheduler
});
check(
  "a withdrawing hostile past exitRange is retired",
  withdrawTest.gone,
  JSON.stringify(withdrawTest),
);
check(
  "...and pays nothing: kills, pending and the multiplier are unchanged",
  withdrawTest.after.kills === withdrawTest.before.kills &&
    withdrawTest.after.pending === withdrawTest.before.pending &&
    withdrawTest.after.multiplier === withdrawTest.before.multiplier,
  JSON.stringify(withdrawTest),
);
check(
  "...and the wave still clears once nothing else is alive",
  withdrawTest.state !== "fighting",
  `state=${withdrawTest.state}`,
);

// ── the Lance's tell gates the shot, not merely precedes it ────────────────
// The un-gated version had a real hole: `cooldown` counts down below zero
// uncapped while aim is bad (the sniper's own strafing makes
// `aimError < 0.4` intermittent by design), so the instant aim recovered,
// both the charge check and the fire check could pass on the very same
// frame — the tell and the shot landing together, zero warning. The fix
// (`Hostile.chargedAt`, `LANCE_LEAD` in `game/hostiles.ts`) makes the fire
// condition wait on the charge having actually run for `LANCE_LEAD` seconds
// first, timed off `Hostile.clock` — a *dedicated* unconditional per-hostile
// clock, not `slabTime`: a first pass reused `slabTime` and shipped a real
// regression, because `updateAltitude` returns before its own
// `slabTime += dt` whenever the slab is off (`Y`, `flight.threeD`), which
// froze the gate's clock outright and made every Lance go permanently silent
// the moment a player had the slab switched off. `observeLanceGate` below
// drives the real game loop rather than trusting the maths in isolation —
// force a sniper into perfect, permanent aim, removing the AI's own
// aim-acquisition timing as a variable, the same shortcut the Warden and
// rock tests take — and watches for the moment its `cooldown` jumps back up
// to `fireInterval` (the shot firing), recording what `chargedAt` and
// `clock` showed on the frame immediately before it. Run once with the slab
// on and once with it off, so the regression this reviewer caught has its
// own permanent check.
async function observeLanceGate() {
  await page.evaluate(() => {
    window.__pin = setInterval(() => { window.__player.hull = 1; }, 80);
    window.__fleet.clear();
    window.__session.ordnance.clear(); // no stray bolt from a prior run still in flight
    window.__session.breakTimer = Infinity; // no wave spawn contaminating this fleet
  });
  const result = await page.evaluate(async () => {
    const { LANCE_LEAD } = await import("/src/game/hostiles.ts");
    const player = window.__player;
    player.velocity.set(0, 0, 0);
    const target = window.__fleet.spawn("sniper", player.position.clone(), 0);
    // Just above the charge threshold, so the charge trips within a couple of
    // frames via the normal `cooldown -= dt` crossing rather than starting
    // already charged — the spawn floor is covered separately by construction.
    target.cooldown = 0.5;

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let before = null;
    let fired = false;
    for (let i = 0; i < 400 && !fired; i++) {
      // Perfect, permanent aim at a fixed in-range standoff, recomputed every
      // frame off the player's own live position.
      target.position.set(player.position.x, 0, player.position.z - 40);
      target.velocity.set(0, 0, 0);
      target.heading = Math.atan2(
        player.position.x - target.position.x,
        player.position.z - target.position.z,
      );
      before = { cooldown: target.cooldown, chargedAt: target.chargedAt, clock: target.clock };
      await wait(16);
      // The shot firing is `this.cooldown = this.spec.fireInterval` inside the
      // class's own fire block — a jump back up near 2.6s from whatever low or
      // negative value it was counting through.
      fired = target.cooldown > before.cooldown + 1;
    }

    window.__fleet.clear();
    // The sniper itself is gone, but the bolt it just fired is a separate
    // object in `Ordnance.projectiles` and outlives the hostile that fired
    // it (`BOLT.life` is 1.5s) — left alone, it goes on flying after this
    // function returns and can land on the player mid-way through whatever
    // test runs next. Clear it here, the instant the observation is done,
    // rather than leaving it to arrive as an unexplained shield hit later.
    window.__session.ordnance.clear();
    return {
      fired,
      chargedBeforeFire: before?.chargedAt ?? null,
      lead: before?.chargedAt != null ? target.clock - before.chargedAt : null,
      lastLanceCharge: window.__sound.lastLanceCharge,
      lanceLead: LANCE_LEAD,
    };
  });
  await page.evaluate(() => {
    clearInterval(window.__pin);
    delete window.__pin;
    window.__session.breakTimer = 0;
  });
  return result;
}

const lanceGateOn = await observeLanceGate();
check("a Lance's shot is observed within the test window", lanceGateOn.fired, JSON.stringify(lanceGateOn));
check(
  "...and it was charged at least LANCE_LEAD seconds before it fired, on the game's own clock — the tell always has time to be heard",
  lanceGateOn.fired && lanceGateOn.chargedBeforeFire !== null && lanceGateOn.lead >= lanceGateOn.lanceLead - 0.05,
  JSON.stringify(lanceGateOn),
);
check(
  "...and the charge cue itself actually sounded during the test",
  lanceGateOn.lastLanceCharge !== null,
  JSON.stringify(lanceGateOn.lastLanceCharge),
);

// The regression itself: identical check, slab off. `Hostile.clock` has to
// keep advancing regardless of `flight.threeD`, or this whole block goes
// back to failing silently (a sniper that spawns but can never re-fire is
// invisible to every check above, which only look for one which already has).
await page.keyboard.press("y");
state = await waitFor((s) => s.flight3d === false, 3000);
check("the slab is off for the regression check", state.flight3d === false, `flight3d=${state.flight3d}`);

const lanceGateOff = await observeLanceGate();

await page.keyboard.press("y");
state = await waitFor((s) => s.flight3d === true, 3000);
check("the slab is back on after the regression check", state.flight3d === true, `flight3d=${state.flight3d}`);

check(
  "...with the slab off, a Lance's shot is still observed within the test window (the slabTime regression)",
  lanceGateOff.fired,
  JSON.stringify(lanceGateOff),
);
check(
  "...and it was still charged at least LANCE_LEAD seconds before it fired — `Hostile.clock` does not stall when `slabTime` does",
  lanceGateOff.fired && lanceGateOff.chargedBeforeFire !== null && lanceGateOff.lead >= lanceGateOff.lanceLead - 0.05,
  JSON.stringify(lanceGateOff),
);

// ── rock collision ────────────────────────────────────────────────────────────
// Task 4 built the hero rocks field; this is what happens when the player
// actually reaches one. Rather than wait out the odds of a "rocks" sector
// coming up naturally, force `campaign.current` to the first one `planHero`
// casts for this seed — the same shortcut the withdrawal test above takes for
// its own rare roll.
const rockHit = await page.evaluate(async () => {
  const { planHero } = await import("/src/render/scenery.ts");
  const seed = window.__campaign.seed;
  const sectorBefore = window.__campaign.current;
  let rockSector = -1;
  for (let s = 0; s < 64; s++) if (planHero(seed, s) === "rocks") { rockSector = s; break; }
  if (rockSector < 0) return { skip: true, sectorBefore };
  window.__campaign.current = rockSector;
  return { skip: false, sector: rockSector, sectorBefore };
});
// Everything below dereferences `window.__session.rocks[0]`, which only
// exists once a "rocks" sector was actually found above — guarded on
// `rockHit.skip` from here on so a seed that never rolls one in 64 sectors
// degrades to a skipped block instead of a TypeError.
if (!rockHit.skip) {
  // Let one frame pass so main.ts rebuilds the sector's scenery and hands the
  // session its rock list.
  await page.waitForTimeout(200);
  // Cleared once for the whole collision window below — every sub-check here
  // reads the player's shields after a wait, and a stray hostile round
  // landing in that window would be indistinguishable from the rock's own
  // hit. `Session.collideRocks` never touches hostiles, so clearing the
  // fleet costs nothing this block cares about.
  await page.evaluate(() => { window.__fleet.clear(); });

  const rockState = await page.evaluate(() => {
    const rock = window.__session.rocks[0];
    const p = window.__player;
    const saved = {
      position: p.position.clone(),
      velocity: p.velocity.clone(),
      shields: { ...p.shields },
      hull: p.hull,
      multiplier: window.__session.multiplier,
    };
    p.position.set(rock.x - rock.r - 2, rock.y, rock.z);
    p.velocity.set(30, 0, 0); // well past ROCKS.grace, straight at it
    return { saved, rocks: window.__session.rocks.length, rock };
  });
  await page.waitForTimeout(300);
  const rockAfter = await page.evaluate(() => ({
    shields: { ...window.__player.shields },
    hull: window.__player.hull,
    mult: window.__session.multiplier,
    speed: window.__player.velocity.length(),
  }));
  // Restore what this block touched before anything downstream reads it.
  await page.evaluate(
    ({ saved }) => {
      const p = window.__player;
      p.position.copy(saved.position);
      p.velocity.copy(saved.velocity);
      Object.assign(p.shields, saved.shields);
      p.hull = saved.hull;
      window.__session.multiplier = saved.multiplier;
    },
    { saved: rockState.saved },
  );
  check("a rock field hands the session its rocks", rockState.rocks > 0, `rocks=${rockState.rocks}`);
  check(
    "hitting a rock at speed costs a shield facing",
    Object.values(rockAfter.shields).some((s) => s < 1),
    JSON.stringify(rockAfter.shields),
  );
  check("the rock is a wall, not a trampoline", rockAfter.speed < 30 * 0.5, `speed=${rockAfter.speed}`);

  // Grace floor: a gentle bump below ROCKS.grace shoulders off for free —
  // no shield cost.
  const graceState = await page.evaluate(() => {
    const rock = window.__session.rocks[0];
    const p = window.__player;
    const saved = { position: p.position.clone(), velocity: p.velocity.clone(), shields: { ...p.shields } };
    p.position.set(rock.x - rock.r - 2, rock.y, rock.z);
    p.velocity.set(3, 0, 0); // well under ROCKS.grace
    return { saved };
  });
  await page.waitForTimeout(300);
  const graceAfter = await page.evaluate(() => ({ shields: { ...window.__player.shields } }));
  await page.evaluate(
    ({ saved }) => {
      const p = window.__player;
      p.position.copy(saved.position);
      p.velocity.copy(saved.velocity);
      Object.assign(p.shields, saved.shields);
    },
    { saved: graceState.saved },
  );
  check(
    "below the grace floor, a rock shoulders you off for free",
    Object.values(graceAfter.shields).every((s) => s === 1),
    JSON.stringify(graceAfter.shields),
  );

  // Breach path: `ROCKS.ceiling` caps a single strike's throughput well under
  // what a full shield facing absorbs (~0.45 against a facing worth 1), so
  // the two checks above never reach the hull and never exercise `breach()`.
  // Drain every facing to just above zero — whichever one `facingFrom`
  // actually resolves to no longer matters — then hit the rock again at
  // speed and confirm the multiplier halves through the same `breach()` a
  // bolt takes, per `Session.collideRocks`'s own comment on routing rock
  // damage through `Ship.takeHit` exactly like a projectile.
  const breachState = await page.evaluate(() => {
    const rock = window.__session.rocks[0];
    const p = window.__player;
    const saved = {
      position: p.position.clone(),
      velocity: p.velocity.clone(),
      shields: { ...p.shields },
      hull: p.hull,
      multiplier: window.__session.multiplier,
    };
    for (const facing of Object.keys(p.shields)) p.shields[facing] = 0.05;
    p.hull = 1;
    window.__session.multiplier = 4;
    p.position.set(rock.x - rock.r - 2, rock.y, rock.z);
    p.velocity.set(30, 0, 0);
    return { saved };
  });
  await page.waitForTimeout(300);
  const breachAfter = await page.evaluate(() => ({
    mult: window.__session.multiplier,
    hull: window.__player.hull,
  }));
  await page.evaluate(
    ({ saved }) => {
      const p = window.__player;
      p.position.copy(saved.position);
      p.velocity.copy(saved.velocity);
      Object.assign(p.shields, saved.shields);
      p.hull = saved.hull;
      window.__session.multiplier = saved.multiplier;
    },
    { saved: breachState.saved },
  );
  check(
    "a rock strike that reaches the hull halves the multiplier",
    breachAfter.mult === 2 && breachAfter.hull < 1,
    `mult=${breachAfter.mult} hull=${breachAfter.hull}`,
  );

  await page.evaluate((sectorBefore) => {
    window.__campaign.current = sectorBefore;
  }, rockHit.sectorBefore);
}

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

// ── the commander's guard ───────────────────────────────────────────────────
// Task 15: once the war reaches its failing act (`warAct`), a wave has a
// small chance of fielding one veteran of the commander's own doctrine — a
// stat-and-name variant of an existing class. Force the act and force the
// roll through the probe seam (`forceGuard`, `arrivedByJump`'s pattern —
// private in TypeScript, plainly settable on the live object from here),
// then hand the clock back to the wave scheduler and look for the veteran in
// the roster it actually spawns.
await page.evaluate(() => {
  window.__fleet.clear();
  window.__session.breakTimer = Infinity; // no wave spawn to contaminate the setup
});
await page.evaluate(() => {
  window.__campaign.exhausted = 1; // the failing act — see chart/commander.ts warAct
  // `spawnWave`'s guard gate reads `Session.actAtRunStart` — `warAct` latched
  // at the run's own `restart()` — rather than a live `warAct(campaign)` read
  // (see that field's docblock: reading live mid-run would call a healthy war
  // "failing" a couple of waves into any ordinary run). This block forces the
  // act via the probe seam without a real restart, so the latch has to be
  // forced along with it, or the guard gate still sees whatever the actual
  // run-start act was.
  window.__session.actAtRunStart = "failing";
  window.__session.forceGuard = true;
  window.__session.guardSpawnedThisRun = false;
});
await page.evaluate(() => {
  window.__session.breakTimer = 0; // hand the clock back to the wave scheduler
});
state = await waitFor((s) => s.hostiles > 0, 10000);
const guard = await page.evaluate(async () => {
  const { HOSTILE_SPECS } = await import("/src/game/hostiles.ts");
  const g = window.__fleet.hostiles.find((h) => h.guardName);
  if (!g) return null;
  return { guardName: g.guardName, kind: g.kind, value: g.spec.value, book: HOSTILE_SPECS[g.kind].value };
});
// Restore what this block touched — the victory epilogue below forces a win
// straight on the board and does not want a leftover "failing" act, or a
// leftover forced roll, poisoning it. Also clear the fleet and top the hull
// back off: unlike before the latch fix, the guard actually spawns now, and
// `hullPin` just went away above — leaving a live, deliberately over-tuned
// guard (2.5x value, plus its doctrine's own boost) free to land a real hit
// on the way to the beauty shots below has nothing to do with what this
// block is testing.
await page.evaluate(() => {
  window.__campaign.exhausted = 0;
  window.__session.forceGuard = false;
  window.__fleet.clear();
  window.__player.hull = 1;
});
check(
  "the commander's guard appears in the failing act, named and stronger than its class's book value",
  guard !== null && guard.value > guard.book,
  guard
    ? `${guard.guardName}'S GUARD (${guard.kind}) value=${guard.value} book=${guard.book}`
    : "no guard found in the forced wave",
);

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
// The reload above gets a fresh module instance of everything, `__giant`
// included, so the visibility set near the top of this file does not carry
// over — re-hide it for the same slow-motion reason before any more
// game-seconds have to be waited out. The viewport, unlike the module state,
// is a browser-level setting and survives the reload untouched, so it is
// still the 1280x800 the beauty shots above set it to; and a freshly
// constructed `Stage` brings its three passes back up `enabled` by their own
// default, undoing the `bloom`/`phosphor`/`crt` = false this file set at the
// very top. Nothing below this point takes another screenshot, so both are
// put back to the small, unadorned state — otherwise every assertion for
// the rest of the file, this reload check and the forced-win tally wait
// among them, runs at the documented ~15-full-screen-pass SwiftShader cost
// against 4x the pixels, and the dt clamp eats the difference.
await page.setViewportSize({ width: 640, height: 400 });
await page.evaluate(() => {
  window.__scenery.hide();
  window.__stage.bloom.enabled = false;
  window.__stage.phosphor.enabled = false;
  window.__stage.crt.enabled = false;
  window.__stage.setSize(640, 400);
});
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

// ── finding a comet without a console ───────────────────────────────────────
// A fixture's nucleus sits past `SCANNER.range` more often than not and its tail
// points along a seeded bearing, so a sector could contain one with nothing at
// all on the tube to say so — four separate test-play sessions ended in a console
// command. These pin the two answers that fixed it. Last in the file because the
// first walks the campaign's own `front` to reach chosen sectors.
const found = await page.evaluate(() => {
  const c = window.__campaign;
  const has = (i) => !!window.__comet.plan(c.seed, i);
  const all = [...Array(64).keys()];
  const read = (sector) => {
    c.front = sector;
    c.current = sector;
    window.__presentation.enter("title");
    window.__presentation.startRun();
    const at = window.__campaign.current;
    return {
      at,
      has: has(at),
      named: window.__presentation.briefing.lines.some((l) => l.text.includes("COMET")),
    };
  };
  return {
    with: read(all.find(has)),
    without: read(all.find((i) => !has(i))),
    // A debug hook that cannot say whether it worked is one you cannot trust:
    // this used to return void, so the console printed `undefined` and read as
    // a failed call.
    seeded: (() => {
      const plan = window.__comet.seed();
      return plan ? plan.kind : null;
    })(),
  };
});
check(
  "the deck log names a comet in a sector that has one",
  found.with.has && found.with.named,
  `sector ${found.with.at} has=${found.with.has} named=${found.with.named}`,
);
check(
  "...and stays quiet in a sector that does not",
  !found.without.has && !found.without.named,
  `sector ${found.without.at} has=${found.without.has} named=${found.without.named}`,
);
check(
  "seeding a comet hands back the plan rather than undefined",
  found.seeded === "wanderer",
  `returned ${found.seeded}`,
);

// ── the deck log names rocks and bare sectors ───────────────────────────────
// Same shortcut as the rock-collision block above: rather than wait out the
// odds of landing on a "rocks" sector, force it. `Session.restart` copies
// `campaign.front` onto `campaign.current` the instant `startRun` calls
// `enter("run")`, so both have to be set — the same reason the comet block
// above sets both.
const heroLog = await page.evaluate(async () => {
  const { planHero } = await import("/src/render/scenery.ts");
  const c = window.__campaign;
  const sectorBefore = c.current;
  const frontBefore = c.front;
  let rockSector = -1;
  for (let s = 0; s < 64; s++) if (planHero(c.seed, s) === "rocks") { rockSector = s; break; }
  return { sectorBefore, frontBefore, rockSector, skip: rockSector < 0 };
});
if (!heroLog.skip) {
  await page.evaluate((sector) => {
    const c = window.__campaign;
    c.front = sector;
    c.current = sector;
    window.__presentation.enter("title");
    window.__presentation.startRun();
  }, heroLog.rockSector);
  // Unlike the pacing assertion far above, which only needs the log's first
  // line, this one sits several stanzas down — so it waits against a clock
  // for the crawl to scroll it into the readable band rather than reading
  // `briefing.lines` (composed, not yet risen) directly.
  const rockLineAt = Date.now();
  let rockLines = [];
  while (Date.now() - rockLineAt < 8000) {
    const s = await probe();
    rockLines = s.briefingLines ?? [];
    if (rockLines.some((l) => l.includes("AN ASTEROID FIELD CROWDS THIS SECTOR"))) break;
    await page.waitForTimeout(50);
  }
  check(
    "the deck log names an asteroid field in a sector that has one",
    rockLines.some((l) => l.includes("AN ASTEROID FIELD CROWDS THIS SECTOR")),
    `sector ${heroLog.rockSector} lines=${JSON.stringify(rockLines)}`,
  );
  // Restore what this block touched before the victory block below reads
  // `campaign.current` to compute its own chart move.
  await page.evaluate(
    ({ sectorBefore, frontBefore }) => {
      const c = window.__campaign;
      c.current = sectorBefore;
      c.front = frontBefore;
      window.__presentation.briefing.skip();
    },
    { sectorBefore: heroLog.sectorBefore, frontBefore: heroLog.frontBefore },
  );
}

// ── the war can end: the victory epilogue ───────────────────────────────────
// Last, and deliberately starting fresh via `enter("title")` + `startRun()`
// the same way the comet-finding block above does, rather than depending on
// whatever run state every earlier assertion left the session in — the "late
// classes" block above this one needs mode "run" the whole way through, and
// this test's own handoff ends that run and lands on "command".
await page.evaluate(() => {
  window.__presentation.enter("title");
  window.__presentation.startRun();
});
state = await waitFor((s) => s.mode === "run", 5000);
check("the victory run actually starts", state.mode === "run", `mode=${state.mode}`);

// Every run opens on its own log; it has to be out of the way before
// anything below can act on the session underneath it.
await page.keyboard.press(" ");
state = await waitFor((s) => !s.briefing, 3000);
check(
  "the victory run's own opening log can be skipped",
  state.briefing === false,
  `briefing=${state.briefing}`,
);

// Force the win directly on the board — `isWon` reads zero enemy sectors,
// not anything this particular run did — and clear `incoming` too: a push
// still in flight would land on the very next enemy turn (the one
// `advanceCampaign` runs while resolving this death) and flip a sector
// straight back to "theirs" before `isWon` ever gets to read what this test
// just set.
await page.evaluate(() => {
  const c = window.__campaign;
  for (const sector of c.sectors) sector.control = "ours";
  c.incoming = [];
});
const theirsAfterForce = await page.evaluate(
  () => window.__campaign.sectors.filter((s) => s.control === "theirs").length,
);
check("the board is forced to a win", theirsAfterForce === 0, `theirs remaining=${theirsAfterForce}`);

await page.evaluate(() => { window.__player.hull = 0; });
// A longer budget than the identical wait near the top of this file: this is
// the same 2.45 game-second drift by the same dt-clamped clock, but by now
// the page has been running one long-lived tab through everything above —
// hundreds of debris shards, a reload, several restarts — and SwiftShader's
// per-frame cost has grown with it, so real time buys less game time here
// than it did at the top of the run.
state = await waitFor((s) => s.death === "tally", 45000);
check("the forced win still reaches the tally", state.death === "tally", `phase=${state.death}`);
check(
  "...with no epilogue yet — it opens at the command handoff, not at death",
  state.briefing === false,
  `briefing=${state.briefing}`,
);

// Same shape as the earlier death-and-restart block: press a direction once,
// and require both that it opened the next screen AND that the press still
// meant something. What is new here is that the next screen is a command
// view standing under a final deck log, and this press must NOT also double
// as the epilogue's first command — see the `!presentation.briefing.active`
// guard next to `NAVIGATION_KEYS.has(key)` in main.ts, which exists so a
// war-ending press is spent opening the epilogue rather than driving the
// view out from under a crawl nobody has read yet.
const winStep = await page.evaluate(() => {
  const { indexOf, colOf, rowOf } = window.__chart;
  const current = window.__campaign.current;
  const col = colOf(current);
  const row = rowOf(current);
  const key = col < 7 ? "d" : "a";
  const want = indexOf(col < 7 ? col + 1 : col - 1, row);
  window.__chartCursor.set(indexOf(col < 7 ? col : 0, row === 7 ? 0 : 7));
  return { key, want, current };
});

await page.keyboard.press(winStep.key);
state = await waitFor((s) => s.mode === "command" && s.briefing === true, 5000);
check(
  "the win handoff opens the command view under the final deck log",
  state.mode === "command" && state.briefing === true,
  `mode=${state.mode} briefing=${state.briefing}`,
);
check(
  "the epilogue actually says the invasion is broken",
  state.briefingLines.join(" ").includes("THE INVASION IS BROKEN"),
  `lines=${JSON.stringify(state.briefingLines)}`,
);
check(
  "and the same key that ended the tally did not also move the chart cursor",
  state.chartCursor === winStep.current,
  `cursor=${state.chartCursor}, wanted it to stay at ${winStep.current}`,
);

// Any key skips it, exactly like the opening log — then the command view
// takes input normally again.
await page.keyboard.press(winStep.key);
state = await waitFor((s) => s.briefing === false, 5000);
check(
  "the epilogue can be skipped like any other crawl",
  state.briefing === false,
  `briefing=${state.briefing}`,
);

await page.keyboard.press(winStep.key);
state = await waitFor((s) => s.chartCursor === winStep.want, 5000);
check(
  "...after which the command view steps the cursor normally",
  state.chartCursor === winStep.want,
  `cursor=${state.chartCursor}, wanted ${winStep.want}`,
);

console.log(problems.length ? `\nPROBLEMS:\n${problems.join("\n")}` : "\nno problems");
await browser.close();
process.exit(problems.length ? 1 : 0);
