# Scenery Variety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break the gas giant's monopoly — a six-way seeded hero per sector, two new bodies, collidable asteroid fields, mid-field furniture, and gas shoals, per the approved spec.

**Architecture:** A pure allocator (`src/render/scenery.ts`, three-free) decides each sector's hero; `main.ts` shows exactly one of the five body renderers (or none) and exposes one `__scenery` switch the harness uses. Collision is a `Session` method fed the rock list; hostiles get bounded repulsion. Shoals revive the scenery `TraceBuffer`.

**Tech Stack:** TypeScript + three.js (Vite). Tests: `npm run playtest` (Playwright), `npm run audiotest`, `npm run typecheck`. Chart tests untouched.

**Spec:** [2026-08-14-scenery-variety-design.md](../specs/2026-08-14-scenery-variety-design.md).

## Global Constraints

- `src/chart/` stays untouched; `src/render/scenery.ts` must import nothing from `three` (it is imported by `src/game/briefing.ts`, which the campaign build never sees, but three-freedom keeps it importable anywhere and testable in-page).
- Colour is information: bodies may be saturated (the §4.1 ruling) but **rocks stay desaturated** (small-and-distant rule), nothing scenery ever pulses, and no new HUD hue.
- Bodies never appear as scanner contacts.
- Every decay/drift/tumble is `dt`-based. Hit-stop stays the only time scaler (`HitStop` only).
- Audio: cues through `sound.ts`'s two-voice idiom, never throw, nothing before a gesture.
- No new keybindings, rows, screens, or currencies.
- The playtest harness runs under SwiftShader: ALL new scenery must be hidden by the single `__scenery` switch (Task 4), and the harness must use it at BOTH of its existing giant-hide sites (`tools/playtest.mjs:87` and `~1726`).
- Deck-log copy: uppercase clipped register, own universe, facts read off the board only.
- `npm run typecheck` before every commit; stage files by name, never `git add -A`.
- Dev-server discipline for playtest: port 5173 belongs to the user's checkout session — never use or kill it. Run your own (`npx vite --port 5199 --strictPort`, background) and pass `PLAYTEST_URL=http://127.0.0.1:5199/`. If `__stage` is undefined after adding new files, restart your own server and clear `node_modules/.vite`.
- iCloud gotcha: a duplicate-symbol typecheck failure means a `* 2.ts` conflict copy — delete it.

---

### Task 1: The hero draw — `planHero`, and the giant/ringed wired to it

**Files:**
- Create: `src/render/scenery.ts`
- Modify: `src/render/GasGiant.ts` (add `hide()`)
- Modify: `src/render/Planet.ts` (retire the independent roll; hero scale; add `hide()`)
- Modify: `src/main.ts:1008-1021` (the per-sector show block) and `src/main.ts:1073-1074` (planet show block)
- Test: `tools/playtest.mjs`

**Interfaces:**
- Produces: `export type HeroKind = "giant" | "ringed" | "moon" | "sun" | "rocks" | "bare"`; `export function planHero(seed: number, sector: number): HeroKind` (pure, deterministic, no three imports); `GasGiant.hide(): void`; `Planet.hide(): void`; `planPlanet(seed, sector)` now always returns a plan (null roll removed) and its `scale` becomes the hero band.
- Consumes: `makeRng` from `../chart/rng.js` (the pattern `GasGiant.show` already uses).

- [ ] **Step 1: Write the failing playtest assertions**

In `tools/playtest.mjs`, next to the giant-seeding block (~line 200), using the harness's existing in-page dynamic-import pattern (`await page.evaluate(() => import("/src/render/scenery.ts"))`):

```js
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
```

(64 sectors at the smallest weight 0.10 misses a kind with probability ~0.001 per kind at a fixed seed; the check runs one fixed seed, so it is deterministic in practice — if the chosen hash lands unluckily, bump the sweep to 128 rather than reseeding the world.)

- [ ] **Step 2: Run to verify it fails** — `PLAYTEST_URL=http://127.0.0.1:5199/ npm run playtest`: the import of `/src/render/scenery.ts` fails (module not found).

- [ ] **Step 3: Implement `src/render/scenery.ts`**

```ts
import { makeRng } from "../chart/rng.js";

/**
 * The sector's hero body — the casting call environment.md's staging
 * deferred. One draw per (seed, sector), weighted so the giant is an event
 * rather than a constant, and "bare" is a place: deep space where the
 * nebula sky carries the frame.
 *
 * Three-free on purpose: the deck log (game side) and the playtest read
 * this too, and a pure function is the only kind all three can share.
 */
export type HeroKind = "giant" | "ringed" | "moon" | "sun" | "rocks" | "bare";

/** Cumulative weights, in declaration order. Tuning candidates like all else. */
const ROSTER: readonly [HeroKind, number][] = [
  ["giant", 0.3],
  ["ringed", 0.2],
  ["moon", 0.15],
  ["sun", 0.15],
  ["rocks", 0.1],
  ["bare", 0.1],
];

export function planHero(seed: number, sector: number): HeroKind {
  // A hash mix of its own — distinct from planPlanet's, planFixture's,
  // planLight's and the giant's, so the hero never correlates with the
  // sky, the comet or the star.
  const rng = makeRng((seed * 1103515245 + sector * 12820163 + 53231) >>> 0);
  let roll = rng.next();
  for (const [kind, weight] of ROSTER) {
    roll -= weight;
    if (roll <= 0) return kind;
  }
  return "bare"; // float dust; unreachable in practice
}
```

- [ ] **Step 4: Add `hide()` to both bodies**

`GasGiant` (beside `clear()` at `GasGiant.ts:1103`):

```ts
/** Empty the group and forget the sector, so the next `show` rebuilds. */
hide(): void {
  if (this.key === "") return;
  this.key = "";
  this.clear();
}
```

`Planet` gets the identical method (same fields exist: `key`, `clear()` — verify `clear()` exists on Planet; if its teardown lives inline in `show`, extract it as `clear()` first, exactly as `GasGiant` structures it). Also in `Planet.ts`:
- `planPlanet` loses its `if (rng.next() > 0.38) return null;` line **but keeps the draw** (`rng.next()` still called once, discarded, so every downstream value — bearing, tilt, scale, hue — is unchanged for every sector that used to have a planet; note this in a comment: the allocator decides now, and existing sectors should not be re-rolled by the deletion).
- The hero band: `scale: 1.5 + rng.next() * 0.7` replacing `0.8 + rng.next() * 0.5`, with a comment (promoted from furniture to hero — the frame's owner; first-draft constant, tuning list).
- Its return type stays `PlanetPlan | null` narrowed to `PlanetPlan` (drop the `| null` and the `if (!this.plan) return;` guards may stay — harmless).

- [ ] **Step 5: Wire the draw in `main.ts`**

At the sector-change block (`main.ts:1008-1015`, where `sectorLightKey` refreshes), compute the hero once per sector alongside the light:

```ts
const hero = planHero(campaign.seed, campaign.current);
```

(cache it in the same `currentLightKey` refresh; a module-level `let sectorHero: HeroKind` set there). Then replace the unconditional calls:

```ts
if (sectorHero === "giant") {
  giant.show(campaign.seed, campaign.current, sectorLight);
  giant.follow(player.position);
  giant.update(dt);
} else giant.hide();
```

and at `main.ts:1073`:

```ts
if (sectorHero === "ringed") {
  planet.show(campaign.seed, campaign.current);
  planet.follow(player.position);
} else planet.hide();
```

- [ ] **Step 6: Run tests** — `npm run typecheck`, then the full playtest (own server): the three new checks pass, the giant-seeding checks still pass (they drive `__giant.show` directly and remain valid).

- [ ] **Step 7: Commit**

```bash
git add src/render/scenery.ts src/render/GasGiant.ts src/render/Planet.ts src/main.ts tools/playtest.mjs
git commit -m "Make the hero a draw: six kinds, one per sector, giant included"
```

### Task 2: The moon

**Files:**
- Create: `src/render/Moon.ts`
- Modify: `src/main.ts` (wire under `sectorHero === "moon"`)
- Test: eye + typecheck (a shader's look is not headless-assertable; the hero-draw checks from Task 1 already gate the plumbing)

**Interfaces:**
- Produces: `class Moon { readonly object: Group; show(seed, sector, light: SectorLight): void; follow(player: Vector3): void; update(dt: number): void; hide(): void }` — the `GasGiant` class shape exactly, so `main.ts` treats all heroes alike.
- Consumes: `SectorLight` from `./light.js`; `makeRng` from `../chart/rng.js`.

- [ ] **Step 1: Implement `src/render/Moon.ts`**

Model the class skeleton on `GasGiant` (read `GasGiant.ts:885-1110` first: the `key` cache, `clear()`, the anchor/leash `follow`, fog-exempt materials, `renderOrder` conventions — copy those decisions, cite them in comments). Differences, per the spec:

- Radius band `0.55 + rng.next() * 0.15` of `GIANT.radius`; same leash/anchor scheme at the giant's distances.
- Material: a `ShaderMaterial` with the same lighting uniforms the giant uses (`vLightDirView` from `light.position.clone().normalize()`), but a **crater recipe, not flow**: cellular noise. Fragment core (complete, adapt uniform plumbing to match the giant's own conventions):

```glsl
// Hash and cellular (Worley) noise — craters are pits, not weather.
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float worley(vec2 p) {
  vec2 cell = floor(p); vec2 f = fract(p);
  float d = 1.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = hash2(cell + g);
    d = min(d, length(g + o - f));
  }
  return d;
}
// In main(): lat/lon from the sphere normal, like the giant's own mapping.
float crater = smoothstep(0.18, 0.05, worley(uv * uCraterScale));        // pit
float rim    = smoothstep(0.22, 0.18, worley(uv * uCraterScale)) - crater; // bright lip
float macro  = worley(uv * uCraterScale * 0.23);                          // maria
vec3 albedo = mix(vec3(0.38, 0.36, 0.33), vec3(0.55, 0.52, 0.47), macro);
albedo *= 1.0 - 0.55 * crater;   // pits darken
albedo += 0.18 * rim;            // rims catch light
float lit = max(dot(normal, lightDir), 0.0);   // hard terminator: no wrap term
gl_FragColor = vec4(albedo * uLightColor * lit, 1.0);
```

Constants (`MOON = { craterScale: 9.0, radiusMin: 0.55, radiusMax: 0.7 }`) in the file's own const block with the standing first-draft docblock style. **No atmosphere halo, no limb shell** — airless is the character; the limb stays crisp where the giant's blooms (spec §2). Desaturated palette as written above (grey-tan; this body deliberately does NOT use the §4.1 saturation exemption).

- [ ] **Step 2: Wire in `main.ts`** — `const moon = new Moon(); stage.scene.add(moon.object);` beside the giant's construction, and in the hero block:

```ts
if (sectorHero === "moon") {
  moon.show(campaign.seed, campaign.current, sectorLight);
  moon.follow(player.position);
  moon.update(dt);
} else moon.hide();
```

- [ ] **Step 3: Verify by eye** — own dev server; use a small Playwright script (workspace scratch, not committed) that sweeps `window.__scenery`-less for now: evaluate `planHero` over sectors to find a `moon` sector for the current campaign seed, then force `__session.campaign.current` to it, screenshot at two ranges. Craters read, terminator hard, nothing blooms. Describe what you saw in the report; attach the screenshots.

- [ ] **Step 4: `npm run typecheck`; full playtest once (regression only). Commit**

```bash
git add src/render/Moon.ts src/main.ts
git commit -m "Build the moon: cellular craters, a hard terminator, no air"
```

### Task 3: The sun hero

**Files:**
- Create: `src/render/SunHero.ts`
- Modify: `src/main.ts` (wire under `sectorHero === "sun"`)
- Test: eye + typecheck

**Interfaces:**
- Produces: `class SunHero { readonly object: Group; show(seed, sector, light: SectorLight): void; follow(player: Vector3): void; update(dt: number): void; hide(): void }` — same shape as `Moon`/`GasGiant`.
- Consumes: `SectorLight`.

- [ ] **Step 1: Implement**

Not a surface — it *is* light (spec §2). Construction on `show`:

- Position: along `light.position.clone().normalize().multiplyScalar(SUN_HERO.range)` with `range = 850` (inside the 2000 far plane, outside combat) — the disc sits exactly where every lit body says the light comes from. `follow()` re-anchors on the player like the giant's follow so the sun never parallaxes closer (it is effectively at infinity; a comment says so).
- Geometry: a core `Mesh(new SphereGeometry(SUN_HERO.coreRadius /* 26 */, 24, 16), new MeshBasicMaterial({ color: light.colour, fog: false }))` pushed well past bloom threshold by scaling the colour ×2 (`color.clone().multiplyScalar(2)` — bloom is the halo, per §3.2 of environment.md: brightness distribution, not geometry); plus two concentric additive disc meshes (`CircleGeometry`, `MeshBasicMaterial({ transparent, opacity: 0.22/0.1, blending: AdditiveBlending, depthWrite: false, fog: false })`, radii ×2.2 and ×4) that `update` keeps facing the camera is unnecessary — instead `follow` makes them `lookAt(player)`; and 10–14 corona streamer lines (a `LineSegments` of radial spokes, jittered by the sector rng, additive, faint).
- `update(dt)`: a slow streamer rotation (`0.02 rad/s`, `dt`-based). Nothing pulses.
- The disc must not tint the HUD's meaning: it is amber-adjacent by physics (the black-body palette in `light.ts` already constrains it) — no code needed, note it.

- [ ] **Step 2: Wire in `main.ts`** exactly as the moon (construct, scene-add, hero block with `show/follow/update`, else `hide()`).

- [ ] **Step 3: Verify by eye** — find a `sun` sector as in Task 2; screenshot with bloom ON (it is load-bearing here); the disc dominates, the halo blooms, lit bodies and the disc agree on bearing (check against a hostile's lit side if one is up, else the starbase). Then `npm run typecheck`; full playtest once.

- [ ] **Step 4: Commit**

```bash
git add src/render/SunHero.ts src/main.ts
git commit -m "Build the sun hero: a disc where the light already was"
```

### Task 4: Asteroids and the `__scenery` switch

**Files:**
- Create: `src/render/Asteroids.ts`
- Modify: `src/main.ts` (wire `rocks` hero + furniture every sector; create and expose `__scenery`)
- Modify: `tools/playtest.mjs:87` and `~1726` (use the switch)
- Test: `tools/playtest.mjs`

**Interfaces:**
- Produces:
  - `interface Rock { x: number; y: number; z: number; r: number }`
  - `class Asteroids { readonly object: Group; show(seed, sector, hero: boolean, light: SectorLight): void; update(dt): void; hide(): void; readonly rocks: readonly Rock[] }` — `rocks` is the **hero field's collidable list in world space** (empty when not the hero; furniture contributes nothing to it).
  - `window.__scenery = { hide(): void, show(): void }` on localhost AND unconditionally (the harness needs it and it is inert; follow how `__giant` is exposed at `main.ts:1346` — if that block is `DEBUG_PROBE`-gated, expose `__scenery` outside the gate with a comment: the harness is the one consumer that must exist on any host).
- Consumes: `SectorLight`, `makeRng`.

- [ ] **Step 1: Write the failing playtest changes**

Replace both giant-hide sites with the switch (this is the RED: `__scenery` undefined):

```js
// tools/playtest.mjs:87 — was: window.__giant.object.visible = false;
window.__scenery.hide();
```

(and the same inside the post-reload restore block at ~1726, keeping that block's other lines). Add one assertion near the hero checks:

```js
const sceneryOff = await page.evaluate(() => {
  window.__scenery.hide();
  return window.__giant.object.visible === false;
});
check("the scenery switch hides the giant with everything else", sceneryOff, "");
```

- [ ] **Step 2: Run to verify it fails** — `__scenery` is undefined; the harness dies early. Good.

- [ ] **Step 3: Implement `src/render/Asteroids.ts`**

- **Rocks**: jittered icosahedra — for each rock, `new IcosahedronGeometry(r, 0)` with each vertex displaced radially by `(0.75 + rng.next() * 0.5)`, merged into ONE `BufferGeometry` per group (environment.md §4.3; use `BufferGeometryUtils.mergeGeometries` from `three/addons` — check whether `three/addons` is already imported anywhere (`grep -rn "three/addons" src/`); if not, hand-roll the merge: concatenate position/normal arrays with an offset applied, ~20 lines, and say so in a comment).
- **Material**: `MeshLambertMaterial({ color: desaturated grey-brown (~#6b675f), fog: false })` — lit by the scene's existing `DirectionalLight` (`sun` in main.ts), which already tracks the sector light. Desaturation is a requirement, not a taste (Global Constraints).
- **Hero field** (`show(..., hero: true, ...)`): centre at bearing `rng * 2π`, distance 90–150 from origin; ~36 rocks, radius `3 + rng.next() * 6`, positions in a flattened ellipsoid (±120 across, y within ±10 — the slab matters: flying OVER the field is the skill); plus a far band of ~80 tiny rocks at 400–700 for depth (not collidable). Fill `this.rocks` with the near field's world-space spheres.
- **Furniture** (`hero: false` or always): 0–2 clusters of ~10 rocks at 300–600 out (its own rng salt), never inside 260; occasionally (rng < 0.15) a drifting hulk — a `VectorObject` in the occluded-hull idiom (it was a ship, so strokes are honest — build a simple broken silhouette from 2–3 merged box/cylinder primitives the way `hulls.ts` does, dim grey, no class hue).
- **`update(dt)`**: slow parent-group tumble (`0.008 rad/s`) — cheap, whole-field; per-rock tumble is not worth the matrix cost. `dt`-based.
- **`hide()`**: key-reset + clear, same idiom as Task 1's.

- [ ] **Step 4: Wire in `main.ts`**

- Construct + scene-add. In the hero block: `asteroids.show(campaign.seed, campaign.current, sectorHero === "rocks", sectorLight); asteroids.update(dt);` — called for every sector (furniture is unconditional; the `hero` flag decides the near field). `hide()` only on... nothing — `show`'s key cache already rebuilds per sector; drop the else-branch for this one and let `hero:false` sectors carry furniture only.
- `__scenery`:

```ts
const sceneryHandles = [giant, planet, moon, sunHero, asteroids] as const;
(window as never as { __scenery: unknown }).__scenery = {
  hide(): void { for (const h of sceneryHandles) h.object.visible = false; shoalsVisible = false; },
  show(): void { for (const h of sceneryHandles) h.object.visible = true; shoalsVisible = true; },
};
```

(`shoalsVisible` is a module `let` defaulting true; Task 6 reads it — declare it now so this task compiles, with a comment naming Task 6's shoals as the consumer. Match the file's existing window-exposure style at `main.ts:1330-1350` rather than this sketch's casts.)

- [ ] **Step 5: Run** — `npm run typecheck`; full playtest (own server): the switch assertion passes and the whole suite still ends "no problems" (the harness now hides all scenery — which also future-proofs Tasks 2/3/6 against the SwiftShader budget).

- [ ] **Step 6: Verify by eye** — find a `rocks` sector; screenshots near/far; rocks read as rocks, not Raiders (desaturated, no pulse); the far band gives depth; furniture appears in a non-rocks sector.

- [ ] **Step 7: Commit**

```bash
git add src/render/Asteroids.ts src/main.ts tools/playtest.mjs
git commit -m "Seed the rocks: a collidable hero field, mid-field furniture, one scenery switch"
```

### Task 5: Collision, avoidance, and the thud

**Files:**
- Modify: `src/game/session.ts` (a `collideRocks` step + `rocks` field)
- Modify: `src/game/hostiles.ts` (repulsion in `Hostile.update`)
- Modify: `src/main.ts` (hand the session the rock list each sector)
- Modify: `src/audio/sound.ts`, `src/audio/selftest.mjs` (`thud`)
- Test: `tools/playtest.mjs`, `npm run audiotest`

**Interfaces:**
- Consumes: `Rock` and `Asteroids.rocks` from Task 4; `Ship.takeHit(amount, source): boolean` (true = breached); `Session.breach(...)`'s existing path — read `session.ts:839-847` first: reuse whatever `takeHit`-then-breach sequence the projectile pass uses so a rock breach halves the multiplier through the same code, not a copy.
- Produces: `Session.rocks: readonly Rock[]` (set by `main.ts` after `asteroids.show`, cleared on `restart`); `ROCKS = { grace: 7, damagePerSpeed: 0.02, ceiling: 0.45, restitution: 0.25 }` exported from `session.ts`; `sound.thud(x, z)`.

- [ ] **Step 1: Write the failing tests**

Audiotest: add the `thud` contract row per `selftest.mjs`'s pattern (RED: cue undefined).

Playtest (place after the withdrawal block; restore what you touch):

```js
const rockHit = await page.evaluate(async () => {
  const { planHero } = await import("/src/render/scenery.ts");
  const seed = window.__campaign.seed;
  let rockSector = -1;
  for (let s = 0; s < 64; s++) if (planHero(seed, s) === "rocks") { rockSector = s; break; }
  if (rockSector < 0) return { skip: true };
  window.__campaign.current = rockSector;
  return { skip: false, sector: rockSector };
});
// Let one frame pass so main.ts rebuilds the sector's scenery and hands the
// session its rock list, then fly the player into the first rock at speed.
await page.waitForTimeout(200);
const collided = await page.evaluate(() => {
  const rock = window.__session.rocks[0];
  const p = window.__player;
  const before = { fore: p.shields.fore, hull: p.hull, mult: window.__session.multiplier };
  p.position.set(rock.x - rock.r - 2, rock.y, rock.z);
  p.velocity.set(30, 0, 0); // well past ROCKS.grace, straight at it
  return { before, rocks: window.__session.rocks.length };
});
await page.waitForTimeout(300);
const after = await page.evaluate(() => ({
  shields: window.__player.shields, hull: window.__player.hull,
  mult: window.__session.multiplier,
  speed: window.__player.velocity.length(),
}));
if (!rockHit.skip) {
  check("a rock field hands the session its rocks", collided.rocks > 0, `rocks=${collided.rocks}`);
  check(
    "hitting a rock at speed costs a shield facing",
    Object.values(after.shields).some((s) => s < 1),
    JSON.stringify(after.shields),
  );
  check("the rock is a wall, not a trampoline", after.speed < 30 * 0.5, `speed=${after.speed}`);
}
```

(A grace-floor check: repeat with `velocity.set(3, 0, 0)` and assert shields untouched. Keep both; restore `campaign.current`, player position/velocity/shields after.)

- [ ] **Step 2: Run to verify RED** — audiotest fails on `thud`; playtest fails on `__session.rocks` undefined.

- [ ] **Step 3: Implement**

`sound.ts` — beside `impact` (~line 338), same idiom:

```ts
/** Hull on rock. A knock, not a weapon: low, dry, placed at the contact. */
thud(x: number, z: number): void {
  const { level, pan } = this.place(x, z);
  if (level < 0.06) return;
  this.synth.play({ kind: "noise", filter: "lowpass", freq: 420, to: 160,
    level: 0.18 * level, attack: 0.002, decay: 0.16, pan });
  this.synth.play({ wave: "triangle", freq: 90, to: 55,
    level: 0.14 * level, attack: 0.003, decay: 0.2, pan });
}
```

`session.ts` — `rocks: readonly Rock[] = []` (a `Rock` type import from `../render/scenery.js`? No — `Rock` lives in `Asteroids.ts` which imports three; **declare the structural type locally**: `type Rock = { x: number; y: number; z: number; r: number }` with a comment naming `Asteroids.rocks` as the producer; structural typing keeps the game module three-import-free on this path). Cleared in `restart`. New private `collideRocks(player: Ship, dt: number)` called from `update` beside the mine-collision step:

```ts
private collideRocks(player: Ship): void {
  for (const rock of this.rocks) {
    const dx = player.position.x - rock.x;
    const dy = player.position.y - rock.y;
    const dz = player.position.z - rock.z;
    const dist = Math.hypot(dx, dy, dz);
    const overlap = rock.r + PLAYER_RADIUS - dist;
    if (overlap <= 0 || dist < 1e-3) continue;

    // Push out along the contact normal first — never inside the rock.
    const nx = dx / dist, ny = dy / dist, nz = dz / dist;
    player.position.x += nx * overlap;
    player.position.y += ny * overlap;
    player.position.z += nz * overlap;

    // Reflect the inward velocity component, heavily damped: a wall.
    const vn = player.velocity.x * nx + player.velocity.y * ny + player.velocity.z * nz;
    if (vn >= 0) continue;
    player.velocity.x -= (1 + ROCKS.restitution) * vn * nx;
    player.velocity.y -= (1 + ROCKS.restitution) * vn * ny;
    player.velocity.z -= (1 + ROCKS.restitution) * vn * nz;

    // Below the grace floor the rock shoulders you off for free.
    const speedIn = -vn;
    if (speedIn <= ROCKS.grace) continue;
    const amount = Math.min(ROCKS.ceiling, (speedIn - ROCKS.grace) * ROCKS.damagePerSpeed);
    sound.thud(rock.x, rock.z);
    this.hitStop.strike(HIT_STOP.impact);
    // Route through the same lanes as any hit: facing absorbs, a breach
    // halves the multiplier via the existing breach path.
    if (player.takeHit(amount, rockScratch.set(rock.x, rock.y, rock.z))) this.breach(player);
  }
}
```

(`rockScratch` a module-level `Vector3` — session already imports three types? **Check**: `session.ts` imports from three already (`Vector3` used throughout) — yes, it does. Use the file's existing scratch-vector convention. `this.breach(player)` — use the ACTUAL breach method name/signature found in Step 1's read of `session.ts:839`; do not invent one.) `ROCKS` exported with a docblock: all four numbers first-draft, tuning list.

`hostiles.ts` — in `Hostile.update`, after the tangent/desired computation, a bounded repulsion (rocks passed the same way `brawlerEngaged` is — a field set by `Session` before the update loop, `fleet.rocks = this.rocks`):

```ts
// Pilots read as pilots: a bounded shove away from any rock the hull is
// about to graze. Steering only — hostiles never take rock damage, so
// herding them into the field pays nothing (an economy ruling this
// feature does not make).
for (const rock of rocks) {
  const dx = this.position.x - rock.x, dy = this.position.y - rock.y, dz = this.position.z - rock.z;
  const d = Math.hypot(dx, dy, dz);
  const reach = rock.r + AVOID_MARGIN; // 8
  if (d >= reach || d < 1e-3) continue;
  const push = (1 - d / reach) * AVOID_GAIN; // 2.2
  desired.x += (dx / d) * push;
  desired.z += (dz / d) * push;
  this.position.y += (dy / d) * push * dt * 3; // vertical dodge is direct, like the slab wander
}
```

(Adapt to the real local variable names at `hostiles.ts:295-305`; renormalize `desired` after, as the existing code already does.)

`main.ts` — after `asteroids.show(...)`: `session.rocks = asteroids.rocks;`.

- [ ] **Step 4: Run everything** — `npm run audiotest` (all rows), `npm run typecheck`, full playtest (own server): the collision checks pass, withdrawal/guard/epilogue regressions stay green.

- [ ] **Step 5: Commit**

```bash
git add src/game/session.ts src/game/hostiles.ts src/audio/sound.ts src/audio/selftest.mjs src/main.ts tools/playtest.mjs
git commit -m "The rocks do not care: collision through the shield lanes, pilots steer around"
```

### Task 6: Gas shoals

**Files:**
- Create: `src/render/Shoals.ts`
- Modify: `src/main.ts` (revive the scenery `TraceBuffer`; draw loop; `__scenery` covers it)
- Test: `tools/playtest.mjs`

**Interfaces:**
- Produces: `class Shoals { plan: ShoalPlan | null; show(seed, sector): void; draw(trace: TraceBuffer, dt: number): void; hide(): void }` and `export function planShoal(seed: number, sector: number): ShoalPlan | null` (pure; `ShoalPlan = { bearing: number; range: number; span: number; drift: number }`; chance 0.2). `planShoal` may live in `Shoals.ts` (three-importing) since only main and the harness read it — the harness via in-page import, which handles three fine.
- Consumes: `TraceBuffer` (`(20000, false)` — the deleted `skyTrace`'s exact parameters, kept for this); the comet plume's technique (`comet.ts`'s filament loop around `COMET.filaments`/`filamentSegments` — read it first and copy its decisions: connected strands, per-filament end fades, density over outlines).

- [ ] **Step 1: Write the failing playtest assertion**

```js
const shoal = await page.evaluate(async () => {
  const { planShoal } = await import("/src/render/Shoals.ts");
  const seed = 4242;
  let have = 0;
  for (let s = 0; s < 64; s++) if (planShoal(seed, s)) have++;
  return { have, deterministic: !!planShoal(seed, 3) === !!planShoal(seed, 3) };
});
check("shoals are seeded in some sectors and not others", shoal.have > 3 && shoal.have < 30, `have=${shoal.have}`);
check("a shoal repeats for its seed and sector", shoal.deterministic, "");
```

- [ ] **Step 2: RED** — module not found.

- [ ] **Step 3: Implement**

`Shoals.ts`: `planShoal` with its own hash salt, `rng.next() > 0.2 → null`; otherwise a curtain: bearing, range 60–140 (combat range — the point is flying through it), span ~90 wide × ~26 tall. `draw(trace, dt)`: ~120 filaments × 9 segments each (~1080 segments of the 20000 budget), each filament a wandering vertical-ish strand across the curtain volume, regenerated per frame from a per-filament phase advanced by `drift × dt` (the comet's exact approach — cite `comet.ts`'s plume block), intensity peaked mid-strand with end fades (`FILAMENT_FADE` — the comet's lesson: hard ends read as scatter), colour a desaturated luminous teal-grey distinct from every information hue (saturation ≤ 0.2 — the decoration rule's saturation half, which survived the luminance correction; cite `COMET_COLOR`'s docblock in todo.md).

`main.ts`: `const skyTrace = new TraceBuffer(20000, false);` + scene-add (restore what commit `2a96921` deleted — its own comment said the parameters were kept "for a later stage's own scratch pad"; quote that in the new comment). Frame loop, beside the combat trace block:

```ts
skyTrace.begin();
if (shoalsVisible) shoals.draw(skyTrace, dt);
skyTrace.end();
```

`shoals.show(campaign.seed, campaign.current)` in the sector-change block. **Visual occlusion only** — no scanner, lock, or interference coupling of any kind; put the spec's own sentence in the class docblock: the comet owns instrument interference.

- [ ] **Step 4: Verify** — typecheck; full playtest (the `__scenery` switch from Task 4 already gates `shoalsVisible`, so the harness cost is zero); by eye in a shoal sector: strands read as gas, hostiles visibly disappear into and re-emerge from the curtain, and the scanner keeps painting them throughout (that is the honesty check — take the screenshot with the tube visible).

- [ ] **Step 5: Commit**

```bash
git add src/render/Shoals.ts src/main.ts tools/playtest.mjs
git commit -m "Raise the shoals: gas you fly through, on scenery's own buffer"
```

### Task 7: The deck log speaks for the rocks and the deep

**Files:**
- Modify: `src/game/briefing.ts` (`compose`)
- Test: `tools/playtest.mjs`

**Interfaces:**
- Consumes: `planHero` from `../render/scenery.js` (three-free by Task 1's constraint, so this import is legal for a game module and for the campaign build's exclusion rules — `briefing.ts` is not in the campaign build; still, scenery.ts's three-freedom makes this uncontroversial).

- [ ] **Step 1: Failing playtest expectation** — extend the existing deck-log content checks: force `campaign.current` to a known `rocks` sector (find one via in-page `planHero` as in Task 5), start a fresh run, assert the readable lines eventually include `AN ASTEROID FIELD CROWDS THIS SECTOR`.

- [ ] **Step 2: RED**, then implement in `compose`, beside the comet's line (`briefing.ts:182-186` — same pattern: fact every run, rule only on teach):

```ts
const heroKind = planHero(campaign.seed, here);
if (heroKind === "rocks") {
  out.push(["AN ASTEROID FIELD CROWDS THIS SECTOR", "body"]);
  if (teach) out.push(["THE ROCKS DO NOT CARE", "note"]);
}
if (heroKind === "bare") out.push(["NOTHING HERE BUT THE DEEP", "note"]);
```

- [ ] **Step 3: GREEN** — typecheck + full playtest.

- [ ] **Step 4: Commit**

```bash
git add src/game/briefing.ts tools/playtest.mjs
git commit -m "Let the log name the rocks and the deep"
```

### Task 8: The record

**Files:**
- Modify: `docs/environment.md` (staging: stages 3/4/7 delivered, stage 8 explicitly remaining), `CLAUDE.md` (State), `docs/todo.md` (§2 constants; measured budgets)

- [ ] **Step 1:** `environment.md` §6 staging — mark stages 3, 4 and 7 delivered (date, one line each naming the spec); stage 8 (retiring the Backdrop's painted bodies) marked NOT taken, with the pointer to this spec's §9.
- [ ] **Step 2:** `CLAUDE.md` State — the hero draw (six kinds, weights), the two new bodies, collidable rocks through the facing lanes, hostile avoidance, shoals (visual-only, comet keeps jamming), the `__scenery` switch, in the file's dense style.
- [ ] **Step 3:** `todo.md` §2 — the new first-draft constants with their one-line deciding questions: `ROSTER` weights (does the giant feel like an event yet?), `ROCKS` grace/damage/ceiling/restitution (is a field a place you fight or a place you die?), `AVOID_MARGIN/GAIN`, `MOON.craterScale`, `SUN_HERO` radii, shoal density/drift (does the curtain read as gas at fighting range?). Record the measured budgets: shoal segments per frame (count them live), scene draw calls in a rocks sector, in the comet's "779 of 5000" style — measured, not arithmetic, this time (the dev tools are one `renderer.info` read away; say the number).
- [ ] **Step 4:** `npm run typecheck` (docs-only), commit:

```bash
git add docs/environment.md CLAUDE.md docs/todo.md
git commit -m "Record the scenery variety pass in the standing docs"
```

---

## Sequencing

Task 1 first (everything reads the draw). Tasks 2, 3, 4 are independent after 1 — run serially (shared `main.ts` hero block edits would conflict in parallel). Task 5 needs 4. Task 6 is independent after 4 (the `shoalsVisible` flag). Task 7 needs 1 (and its test setup borrows Task 5's rocks-sector finder — self-contained copy, not a dependency). Task 8 last. The environment plan's stage 8 is explicitly NOT here.
